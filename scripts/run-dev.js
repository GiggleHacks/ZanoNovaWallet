#!/usr/bin/env node

const { spawn, spawnSync } = require("child_process");
const { existsSync, readFileSync } = require("fs");
const { join } = require("path");

function loadPackageMetadata() {
  try {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    return {
      packageName: String(packageJson.name || "").trim(),
      productName: String(packageJson.productName || "Zano Nova").trim(),
    };
  } catch {
    return { packageName: "", productName: "Zano Nova" };
  }
}

function isLikelyProjectProcess(command, projectRoot, packageName, productName) {
  const text = String(command || "");
  const lower = text.toLowerCase();
  const matchesProject =
    lower.includes(projectRoot.toLowerCase()) ||
    (packageName && lower.includes(packageName.toLowerCase())) ||
    (productName && lower.includes(productName.toLowerCase()));

  if (!matchesProject) return false;

  return (
    lower.includes("electronmon") ||
    lower.includes("/node_modules/electron/") ||
    lower.includes("electron.app/contents/macos/electron") ||
    lower.includes("\\electron.exe") ||
    lower.includes("/electron")
  );
}

function listProjectProcesses() {
  const projectRoot = process.cwd();
  const { packageName, productName } = loadPackageMetadata();
  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "failed to list running processes");
  }

  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) return null;
      return { pid: Number(match[1]), command: match[2] };
    })
    .filter(Boolean)
    .filter((proc) => proc.pid !== process.pid)
    .filter((proc) => isLikelyProjectProcess(proc.command, projectRoot, packageName, productName));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killExistingProjectProcesses() {
  const processes = listProjectProcesses();
  if (processes.length === 0) {
    console.log("No existing Zano Nova Electron processes found.");
    return;
  }

  console.log(`Killing ${processes.length} existing Zano Nova Electron process(es)...`);
  for (const proc of processes) {
    console.log(`- SIGTERM ${proc.pid}: ${proc.command}`);
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch {
      // ignore races
    }
  }

  await wait(1200);

  const remaining = processes.filter((proc) => isAlive(proc.pid));
  for (const proc of remaining) {
    console.log(`- SIGKILL ${proc.pid}: ${proc.command}`);
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      // ignore races
    }
  }
}

function resolveElectronmonBinary() {
  return join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electronmon.cmd" : "electronmon"
  );
}

async function main() {
  const electronmonBinary = resolveElectronmonBinary();
  if (!existsSync(electronmonBinary)) {
    throw new Error(`electronmon binary not found at ${electronmonBinary}`);
  }

  await killExistingProjectProcesses();

  const child = spawn(electronmonBinary, [".", ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });

  child.on("error", (error) => {
    console.error("Failed to start electronmon:", error);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});