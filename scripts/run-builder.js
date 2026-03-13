#!/usr/bin/env node

const { spawnSync } = require("child_process");
const { existsSync, readFileSync } = require("fs");
const { join } = require("path");

function loadDotEnvIntoProcess(dotenvPath) {
  if (!existsSync(dotenvPath)) return;
  const text = readFileSync(dotenvPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let [, key, value] = match;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function run(command, args) {
  console.log("Executing:", command, args.join(" "));

  let spawnCommand = command;
  let spawnArgs = args;

  if (process.platform === "win32" && command.endsWith(".cmd")) {
    spawnCommand = "cmd.exe";
    spawnArgs = ["/c", command, ...args];
  }

  const result = spawnSync(spawnCommand, spawnArgs, { stdio: "inherit" });
  if (result.error) {
    console.error("Error executing command:", result.error);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

function ensureAppIcon() {
  const scriptPath = join(process.cwd(), "scripts", "build-icon.js");
  if (!existsSync(scriptPath)) {
    throw new Error(`Icon build script not found: ${scriptPath}`);
  }
  run(process.execPath, [scriptPath]);
}

function parseCliArgs(argv) {
  const requestedPlatforms = new Set();
  const passthroughArgs = [];
  let mode = "dist";
  let afterDoubleDash = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (afterDoubleDash) {
      passthroughArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }

    if (arg === "--win" || arg === "--mac" || arg === "--linux") {
      requestedPlatforms.add(arg.slice(2));
      continue;
    }

    if (arg === "--mode") {
      mode = argv[index + 1] || mode;
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length) || mode;
      continue;
    }

    passthroughArgs.push(arg);
  }

  return {
    mode: mode === "pack" ? "pack" : "dist",
    requestedPlatforms: Array.from(requestedPlatforms),
    passthroughArgs,
  };
}

function resolveElectronBuilderBinary() {
  return join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
  );
}

function shouldAutoAddMacArch(passthroughArgs) {
  return !passthroughArgs.some((arg) => /^--(x64|arm64|ia32|universal)$/.test(arg));
}

function getPlatforms(requestedPlatforms) {
  if (requestedPlatforms.length > 0) return requestedPlatforms;

  const platforms = [];

  if (process.platform === "darwin" || truthy(process.env.BUILD_MAC)) {
    platforms.push("mac");
  }
  if (process.platform === "win32" || truthy(process.env.BUILD_WIN)) {
    platforms.push("win");
  }
  if (process.platform === "linux" || truthy(process.env.BUILD_LINUX)) {
    platforms.push("linux");
  }

  return platforms;
}

function getPlatformSpec(platform) {
  const specs = {
    mac: {
      flag: "--mac",
      config: "build/config/electron-builder.mac.json",
      targetEnv: "MAC_TARGET",
      defaultPackTarget: "dir",
      prepareScript: "scripts/prepare-zano-macos.js",
    },
    win: {
      flag: "--win",
      config: "build/config/electron-builder.win.json",
      targetEnv: "WIN_TARGET",
      defaultPackTarget: "dir",
      prepareScript: "scripts/prepare-simplewallet.js",
    },
    linux: {
      flag: "--linux",
      config: "build/config/electron-builder.linux.json",
      targetEnv: "LINUX_TARGET",
      defaultPackTarget: "dir",
      prepareScript: null,
    },
  };

  return specs[platform] || null;
}

function buildArgsForPlatform(platform, mode, passthroughArgs) {
  const spec = getPlatformSpec(platform);
  if (!spec) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const args = ["--config", spec.config, spec.flag];
  const targets = splitCsv(process.env[spec.targetEnv]);

  if (mode === "pack") {
    args.push(...(targets.length > 0 ? targets : [spec.defaultPackTarget]));
  } else if (targets.length > 0) {
    args.push(...targets);
  }

  if (platform === "mac" && shouldAutoAddMacArch(passthroughArgs)) {
    if (process.arch === "arm64") {
      args.push("--arm64");
      if (truthy(process.env.BUILD_MAC_INTEL)) args.push("--x64");
    } else if (process.arch === "x64") {
      args.push("--x64");
    }
  }

  args.push(...passthroughArgs);
  return args;
}

(function main() {
  try {
    console.log("Starting run-builder.js...");
    console.log("Current working directory:", process.cwd());
    console.log("Platform:", process.platform, "Arch:", process.arch);

    loadDotEnvIntoProcess(join(process.cwd(), ".env"));

    const { mode, requestedPlatforms, passthroughArgs } = parseCliArgs(process.argv.slice(2));
    const platforms = getPlatforms(requestedPlatforms);
    const electronBuilderBinary = resolveElectronBuilderBinary();

    if (!existsSync(electronBuilderBinary)) {
      throw new Error(`electron-builder binary not found at ${electronBuilderBinary}`);
    }

    if (platforms.length === 0) {
      throw new Error("No target platforms selected.");
    }

    console.log("Build mode:", mode);
    console.log("Selected platforms:", platforms.join(", "));

    ensureAppIcon();

    for (const platform of platforms) {
      const spec = getPlatformSpec(platform);
      if (!spec) {
        throw new Error(`No build spec found for platform ${platform}`);
      }

      if (!existsSync(join(process.cwd(), spec.config))) {
        throw new Error(`Build config not found: ${spec.config}`);
      }

      if (spec.prepareScript) {
        run(process.execPath, [join(process.cwd(), spec.prepareScript)]);
      }

      const args = buildArgsForPlatform(platform, mode, passthroughArgs);
      run(electronBuilderBinary, args);
    }
  } catch (error) {
    console.error("Fatal error in run-builder.js:", error);
    process.exit(1);
  }
})();