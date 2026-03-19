const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const net = require("net");
const { getUserDataPaths, simplewalletBinaryName, getResourcesDir } = require("./config");

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function ensureExecutable(filePath) {
  if (process.platform === "win32") return;
  try {
    const stat = fs.statSync(filePath);
    fs.chmodSync(filePath, stat.mode | 0o755);
  } catch {}
}

function copyFileIfNeeded(src, dest) {
  if (path.resolve(src) === path.resolve(dest)) return;
  let shouldCopy = true;
  try {
    const srcStat = fs.statSync(src);
    const destStat = fs.statSync(dest);
    shouldCopy = srcStat.size !== destStat.size || srcStat.mtimeMs > destStat.mtimeMs;
  } catch {
    shouldCopy = true;
  }
  if (!shouldCopy) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirectoryRecursive(srcDir, destDir) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(src, dest);
      continue;
    }
    if (!entry.isFile()) continue;
    copyFileIfNeeded(src, dest);
  }
}

function isSimplewalletRuntimeSupportFile(filename) {
  const lower = String(filename || "").toLowerCase();
  const binaryLower = simplewalletBinaryName().toLowerCase();
  return (
    lower === binaryLower ||
    lower.endsWith(".dll") ||
    lower.endsWith(".dylib") ||
    lower.endsWith(".so") ||
    lower.includes(".so.")
  );
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function getMacContentsRootForBinary(binaryPath) {
  const macOsDir = path.dirname(binaryPath);
  if (path.basename(macOsDir) !== "MacOS") return null;
  const contentsDir = path.dirname(macOsDir);
  if (path.basename(contentsDir) !== "Contents") return null;
  return contentsDir;
}

function simplewalletSourceRoots(overridePath) {
  const roots = [];

  if (overridePath && fs.existsSync(overridePath)) {
    if (process.platform === "darwin") {
      const contentsRoot = getMacContentsRootForBinary(path.resolve(overridePath));
      if (contentsRoot) roots.push(contentsRoot);
    } else {
      roots.push(path.dirname(overridePath));
    }
  }

  if (!app.isPackaged) {
    const projectRoot = app.getAppPath();
    if (process.platform === "darwin") {
      roots.push(path.join(projectRoot, "build", "vendor", "zano-macos", "Contents"));
    } else if (process.platform === "win32") {
      roots.push(path.join(projectRoot, "build", "vendor", "simplewallet-win"));
    } else {
      roots.push(path.join(projectRoot, "build", "vendor", "simplewallet-linux"));
    }
  }

  const { resourcesDir, simplewalletRuntimeDir } = getUserDataPaths();
  if (resourcesDir) {
    if (process.platform === "darwin") {
      roots.push(path.join(resourcesDir, "zano-macos", "Contents"));
    } else {
      roots.push(resourcesDir);
    }
  }

  return roots.filter((root, index, all) => {
    if (!root) return false;
    const resolved = path.resolve(root);
    if (resolved === path.resolve(simplewalletRuntimeDir)) return false;
    return all.findIndex((item) => path.resolve(item) === resolved) === index;
  });
}

function syncSimplewalletRuntimeFromDir(sourceDir) {
  const { simplewalletRuntimeDir, simplewalletRuntimePath } = getUserDataPaths();

  if (process.platform === "darwin") {
    const sourceBinaryPath = path.join(sourceDir, "MacOS", simplewalletBinaryName());
    const sourceBoostDir = path.join(sourceDir, "Frameworks", "boost_libs");
    if (!fs.existsSync(sourceBinaryPath) || !fs.existsSync(sourceBoostDir)) return null;

    copyFileIfNeeded(sourceBinaryPath, simplewalletRuntimePath);
    ensureExecutable(simplewalletRuntimePath);

    const sourceZanodPath = path.join(sourceDir, "MacOS", "zanod");
    if (fs.existsSync(sourceZanodPath)) {
      const runtimeZanodPath = path.join(simplewalletRuntimeDir, "Contents", "MacOS", "zanod");
      copyFileIfNeeded(sourceZanodPath, runtimeZanodPath);
      ensureExecutable(runtimeZanodPath);
    }

    copyDirectoryRecursive(
      sourceBoostDir,
      path.join(simplewalletRuntimeDir, "Contents", "Frameworks", "boost_libs")
    );

    if (!fs.existsSync(simplewalletRuntimePath)) return null;
    ensureExecutable(simplewalletRuntimePath);
    return simplewalletRuntimePath;
  }

  // Windows / Linux: flat copy
  const sourceBinaryPath = path.join(sourceDir, simplewalletBinaryName());
  if (!fs.existsSync(sourceBinaryPath)) return null;

  fs.mkdirSync(simplewalletRuntimeDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isSimplewalletRuntimeSupportFile(entry.name)) continue;
    const src = path.join(sourceDir, entry.name);
    const dest = path.join(simplewalletRuntimeDir, entry.name);
    copyFileIfNeeded(src, dest);
    if (entry.name === simplewalletBinaryName()) ensureExecutable(dest);
  }

  if (!fs.existsSync(simplewalletRuntimePath)) return null;
  ensureExecutable(simplewalletRuntimePath);
  return simplewalletRuntimePath;
}

function simplewalletExeCandidates(overridePath) {
  const { simplewalletRuntimePath } = getUserDataPaths();
  const candidates = [simplewalletRuntimePath];

  for (const root of simplewalletSourceRoots(overridePath)) {
    if (process.platform === "darwin") {
      candidates.push(path.join(root, "MacOS", simplewalletBinaryName()));
    } else {
      candidates.push(path.join(root, simplewalletBinaryName()));
    }
  }

  return candidates.filter((c, i, all) => all.indexOf(c) === i);
}

function resolveSimplewalletExePath(overridePath) {
  for (const sourceRoot of simplewalletSourceRoots(overridePath)) {
    const managedPath = syncSimplewalletRuntimeFromDir(sourceRoot);
    if (managedPath) return managedPath;
  }

  const { simplewalletRuntimePath } = getUserDataPaths();
  if (fs.existsSync(simplewalletRuntimePath)) {
    ensureExecutable(simplewalletRuntimePath);
    return simplewalletRuntimePath;
  }

  return null;
}

// ---------------------------------------------------------------------------
// JSON-RPC helper
// ---------------------------------------------------------------------------

async function jsonRpcCall({ url, method, params, id = 0, timeoutMs = 15_000 }) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const body = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    if (data?.error) throw new Error(data.error?.message || JSON.stringify(data.error));
    return data;
  } finally {
    clearTimeout(to);
  }
}

// ---------------------------------------------------------------------------
// Process lifecycle  (mainWindow ref is injected via init())
// ---------------------------------------------------------------------------

let mainWindow = null;
let simplewalletProc = null;
let simplewalletState = { status: "stopped" };

function init(win) {
  mainWindow = win;
}

function getSimplewalletState() {
  return simplewalletState;
}

function setSimplewalletState(next) {
  simplewalletState = { ...simplewalletState, ...next };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("simplewallet:state", simplewalletState);
  }
}

function startSimplewallet({ walletFile, password, simplewalletExePath, daemonAddress, rpcBindIp, rpcBindPort }) {
  if (simplewalletProc && simplewalletProc.exitCode == null) {
    throw new Error("simplewallet is already running");
  }
  if (!simplewalletExePath || !fs.existsSync(simplewalletExePath)) {
    const bin = simplewalletBinaryName();
    const { simplewalletRuntimeDir } = getUserDataPaths();
    throw new Error(`${bin} not found. The app expects a managed copy under ${simplewalletRuntimeDir}. Bundle it with the app or select a source binary in Settings.`);
  }
  if (!walletFile) throw new Error("Missing wallet file path");
  if (!fs.existsSync(walletFile)) {
    throw new Error(`Wallet file not found at:\n${walletFile}\n\nCreate or restore a wallet first.`);
  }
  if (!password) throw new Error("Missing wallet password");

  fs.mkdirSync(path.dirname(walletFile), { recursive: true });

  const args = [
    `--wallet-file=${walletFile}`,
    `--password=${password}`,
    `--rpc-bind-ip=${rpcBindIp}`,
    `--rpc-bind-port=${rpcBindPort}`,
    `--daemon-address=${daemonAddress}`,
  ];

  intentionalStop = false;
  setSimplewalletState({ status: "starting", lastError: null, lastExitCode: null });

  const exeDir = path.dirname(simplewalletExePath);
  const spawnEnv = { ...process.env, PATH: exeDir + path.delimiter + (process.env.PATH || "") };
  simplewalletProc = spawn(simplewalletExePath, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: exeDir,
    env: spawnEnv,
    detached: true, // survive app close — reused on next launch via port detection
  });
  simplewalletProc.unref(); // don't block Electron from exiting

  let stdout = "";
  let stderr = "";

  simplewalletProc.stdout.on("data", (buf) => {
    stdout += buf.toString("utf8");
    // Don't flip to "running" based on output alone — RPC readiness is the signal.
    setSimplewalletState({ stdoutTail: stdout.slice(-8000) });
  });
  simplewalletProc.stderr.on("data", (buf) => {
    stderr += buf.toString("utf8");
    setSimplewalletState({ stderrTail: stderr.slice(-8000) });
  });
  simplewalletProc.on("exit", (code) => {
    setSimplewalletState({ status: "stopped", lastExitCode: code ?? null });
    simplewalletProc = null;
  });
  simplewalletProc.on("error", (err) => {
    setSimplewalletState({ status: "stopped", lastError: err?.message || String(err) });
    simplewalletProc = null;
  });
}

let intentionalStop = false;

function stopSimplewallet() {
  if (!simplewalletProc || simplewalletProc.exitCode != null) return;
  intentionalStop = true;
  setSimplewalletState({ status: "stopping" });
  try {
    simplewalletProc.kill();
  } catch {}
}

async function waitForWalletRpcReady({ rpcBindIp, rpcBindPort, timeoutMs = 120_000 }) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${rpcBindIp}:${rpcBindPort}/json_rpc`;

  while (Date.now() < deadline) {
    if (!simplewalletProc || simplewalletProc.exitCode != null) {
      if (intentionalStop) return { ok: false, stopped: true };
      throw new Error(
        `simplewallet exited before RPC became ready (exit ${simplewalletState?.lastExitCode ?? "unknown"}).`
      );
    }

    const portOpen = await new Promise((resolve) => {
      const s = net.connect({ host: rpcBindIp, port: rpcBindPort });
      s.once("connect", () => { s.end(); resolve(true); });
      s.once("error", () => resolve(false));
      s.setTimeout(150, () => resolve(false));
    });

    if (portOpen) {
      try {
        await jsonRpcCall({ url, method: "getaddress", params: {}, timeoutMs: 1_000 });
        return { ok: true, url };
      } catch {}
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  const stderrTail = simplewalletState?.stderrTail || "";
  const stdoutTail = simplewalletState?.stdoutTail || "";
  throw new Error(
    `Wallet RPC did not become ready at ${rpcBindIp}:${rpcBindPort}.` +
      (stderrTail ? `\n\nsimplewallet stderr (tail):\n${stderrTail}` : "") +
      (!stderrTail && stdoutTail ? `\n\nsimplewallet stdout (tail):\n${stdoutTail}` : "")
  );
}

// Helper: spawn simplewallet for a one-shot command (generate, restore, show_seed).
function spawnSimplewalletEnv(simplewalletExePath) {
  const exeDir = path.dirname(simplewalletExePath);
  const env = { ...process.env, PATH: exeDir + path.delimiter + (process.env.PATH || "") };
  const opts = { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], cwd: exeDir, env };
  return { exeDir, env, opts };
}

module.exports = {
  init,
  getSimplewalletState,
  setSimplewalletState,
  resolveSimplewalletExePath,
  simplewalletExeCandidates,
  startSimplewallet,
  stopSimplewallet,
  waitForWalletRpcReady,
  jsonRpcCall,
  spawnSimplewalletEnv,
};
