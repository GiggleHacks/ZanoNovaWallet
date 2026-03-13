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

  function parseAndFilter(items) {
    return items
      .filter(Boolean)
      .filter((proc) => Number.isFinite(proc.pid) && proc.pid > 0)
      .filter((proc) => proc.pid !== process.pid)
      .filter((proc) => isLikelyProjectProcess(proc.command, projectRoot, packageName, productName));
  }

  if (process.platform === "win32") {
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      "Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
    ].join("; ");

    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", psScript], {
      encoding: "utf8",
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "failed to list running processes");
    }

    const raw = String(result.stdout || "").trim();
    if (!raw) return [];

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("failed to parse running process list");
    }

    const items = Array.isArray(parsed) ? parsed : [parsed];
    return parseAndFilter(
      items.map((item) => ({
        pid: Number(item?.ProcessId),
        command: String(item?.CommandLine || ""),
      }))
    );
  }

  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "failed to list running processes");
  }

  return parseAndFilter(
    String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        return { pid: Number(match[1]), command: match[2] };
      })
  );
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
  let processes = [];
  try {
    processes = listProjectProcesses();
  } catch (error) {
    console.warn(`Process scan skipped: ${error.message || error}. Continuing startup.`);
    return;
  }

  if (processes.length === 0) {
    console.log("No existing Zano Nova Electron processes found. Continuing startup.");
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

  try {
    await killExistingProjectProcesses();
  } catch (error) {
    console.warn(`Pre-launch cleanup failed: ${error.message || error}. Continuing startup.`);
  }

  console.log("Starting electronmon...");

  let childCommand = electronmonBinary;
  let childArgs = [".", ...process.argv.slice(2)];
  if (process.platform === "win32" && electronmonBinary.endsWith(".cmd")) {
    childCommand = "cmd.exe";
    childArgs = ["/c", electronmonBinary, ...childArgs];
  }

  const child = spawn(childCommand, childArgs, {
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