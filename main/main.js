const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const net = require("net");
const QRCode = require("qrcode");

const DEFAULTS = Object.freeze({
  walletRpcBindIp: "127.0.0.1",
  walletRpcBindPort: 12233,
  daemonAddress: "37.27.100.59:10500",
});

function getUserDataPaths() {
  const userData = app.getPath("userData");
  return {
    userData,
    configPath: path.join(userData, "config.json"),
    walletsDir: path.join(userData, "wallets"),
    walletPath: path.join(userData, "wallets", "wallet.zan"),
    resourcesDir: path.join(process.resourcesPath, "resources"),
  };
}

function tryMigrateFromOldAppName() {
  const { walletPath: newWalletPath, configPath: newConfigPath } = getUserDataPaths();
  if (fs.existsSync(newWalletPath) && fs.existsSync(newConfigPath)) return;

  // Previous app name was "zano-simple-wallet" (npm init name) so Electron userData folder was "zano-simple-wallet".
  // New name is "zano-nova" so userData folder is different. Migrate wallet + config if present.
  const appData = process.env.APPDATA; // Roaming
  if (!appData) return;

  const oldUserData = path.join(appData, "zano-simple-wallet");
  const oldWalletPath = path.join(oldUserData, "wallets", "wallet.zan");
  const oldConfigPath = path.join(oldUserData, "config.json");

  try {
    if (!fs.existsSync(newWalletPath) && fs.existsSync(oldWalletPath)) {
      fs.mkdirSync(path.dirname(newWalletPath), { recursive: true });
      fs.copyFileSync(oldWalletPath, newWalletPath);
    }
    if (!fs.existsSync(newConfigPath) && fs.existsSync(oldConfigPath)) {
      fs.mkdirSync(path.dirname(newConfigPath), { recursive: true });
      fs.copyFileSync(oldConfigPath, newConfigPath);
    }
  } catch {
    // ignore migration failures; user can create/restore again
  }
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function getConfig() {
  const { configPath } = getUserDataPaths();
  const existing = readJsonIfExists(configPath) || {};
  return {
    ...DEFAULTS,
    ...existing,
  };
}

function setConfig(partial) {
  const { configPath } = getUserDataPaths();
  const current = getConfig();
  const next = { ...current, ...partial };
  writeJson(configPath, next);
  return next;
}

let mainWindow = null;
let simplewalletProc = null;
let simplewalletState = { status: "stopped" };

// #region agent log helpers
function dbg(hypothesisId, location, message, data) {
  fetch("http://127.0.0.1:7377/ingest/2e5b39fe-7a23-4b57-b6c0-2440cb15aa66", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "06be5c" },
    body: JSON.stringify({
      sessionId: "06be5c",
      runId: "pre-fix",
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}
// #endregion

function simplewalletExeCandidates() {
  // For development: place binary at resources/simplewallet.exe
  // For packaged app: shipped under resources/resources/simplewallet.exe (see build.files + resources/)
  const candidates = [];
  const devCandidate = path.join(app.getAppPath(), "resources", "simplewallet.exe");
  candidates.push(devCandidate);
  const packagedCandidate = path.join(process.resourcesPath, "resources", "simplewallet.exe");
  candidates.push(packagedCandidate);
  return candidates;
}

function resolveSimplewalletExePath(overridePath) {
  if (overridePath && fs.existsSync(overridePath)) return overridePath;
  for (const p of simplewalletExeCandidates()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
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
    throw new Error("simplewallet.exe not found. Place it at resources/simplewallet.exe or set a custom path in Settings.");
  }
  if (!walletFile) throw new Error("Missing wallet file path");
  if (!fs.existsSync(walletFile)) {
    throw new Error(`Wallet file not found at:\n${walletFile}\n\nCreate or restore a wallet first.`);
  }
  if (!password) throw new Error("Missing wallet password");

  fs.mkdirSync(path.dirname(walletFile), { recursive: true });

  const args = [
    `--wallet-file=${walletFile}`,
    `--password=${password}`, // do not log
    `--rpc-bind-ip=${rpcBindIp}`,
    `--rpc-bind-port=${rpcBindPort}`,
    `--daemon-address=${daemonAddress}`,
  ];

  // #region agent log
  dbg("H1", "main.js:startSimplewallet", "Spawning simplewallet", {
    walletFile,
    simplewalletExePath,
    daemonAddress,
    rpcBindIp,
    rpcBindPort,
    argsRedacted: args.map((a) => (a.startsWith("--password=") ? "--password=REDACTED" : a)),
  });
  // #endregion

  setSimplewalletState({ status: "starting", lastError: null, lastExitCode: null });

  simplewalletProc = spawn(simplewalletExePath, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  simplewalletProc.stdout.on("data", (buf) => {
    stdout += buf.toString("utf8");
    // #region agent log
    dbg("H2", "main.js:simplewalletProc.stdout", "simplewallet stdout chunk", {
      len: String(buf?.length ?? 0),
      tail: stdout.slice(-500),
    });
    // #endregion
    setSimplewalletState({ status: "running", stdoutTail: stdout.slice(-8000) });
  });
  simplewalletProc.stderr.on("data", (buf) => {
    stderr += buf.toString("utf8");
    // #region agent log
    dbg("H2", "main.js:simplewalletProc.stderr", "simplewallet stderr chunk", {
      len: String(buf?.length ?? 0),
      tail: stderr.slice(-500),
    });
    // #endregion
    setSimplewalletState({ status: "running", stderrTail: stderr.slice(-8000) });
  });
  simplewalletProc.on("exit", (code) => {
    // #region agent log
    dbg("H2", "main.js:simplewalletProc.exit", "simplewallet exited", { code });
    // #endregion
    setSimplewalletState({ status: "stopped", lastExitCode: code ?? null });
    simplewalletProc = null;
  });
  simplewalletProc.on("error", (err) => {
    // #region agent log
    dbg("H2", "main.js:simplewalletProc.error", "simplewallet process error", { message: err?.message || String(err) });
    // #endregion
    setSimplewalletState({ status: "stopped", lastError: err?.message || String(err) });
    simplewalletProc = null;
  });
}

function stopSimplewallet() {
  if (!simplewalletProc || simplewalletProc.exitCode != null) return;
  setSimplewalletState({ status: "stopping" });
  try {
    simplewalletProc.kill();
  } catch {
    // ignore
  }
}

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
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
    if (data?.error) {
      throw new Error(data.error?.message || JSON.stringify(data.error));
    }
    return data;
  } finally {
    clearTimeout(to);
  }
}

async function waitForWalletRpcReady({ rpcBindIp, rpcBindPort, timeoutMs = 12_000 }) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${rpcBindIp}:${rpcBindPort}/json_rpc`;

  while (Date.now() < deadline) {
    // If the process exited, stop waiting immediately.
    if (!simplewalletProc || simplewalletProc.exitCode != null) {
      throw new Error(
        `simplewallet exited before RPC became ready (exit ${simplewalletState?.lastExitCode ?? "unknown"}).`
      );
    }

    // Fast check: can we connect to the TCP port?
    const portOpen = await new Promise((resolve) => {
      const s = net.connect({ host: rpcBindIp, port: rpcBindPort });
      s.once("connect", () => {
        s.end();
        resolve(true);
      });
      s.once("error", () => resolve(false));
      s.setTimeout(400, () => resolve(false));
    });

    if (portOpen) {
      // Deeper check: does JSON-RPC respond?
      try {
        await jsonRpcCall({ url, method: "getaddress", params: {}, timeoutMs: 2_000 });
        return { ok: true, url };
      } catch {
        // keep trying until timeout
      }
    }
  }

  const stderrTail = simplewalletState?.stderrTail || "";
  const stdoutTail = simplewalletState?.stdoutTail || "";
  throw new Error(
    `Wallet RPC did not become ready at ${rpcBindIp}:${rpcBindPort}.` +
      (stderrTail ? `\n\nsimplewallet stderr (tail):\n${stderrTail}` : "") +
      (!stderrTail && stdoutTail ? `\n\nsimplewallet stdout (tail):\n${stdoutTail}` : "")
  );
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    backgroundColor: "#07172a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(() => {
  tryMigrateFromOldAppName();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopSimplewallet();
});

ipcMain.handle("app:getPaths", () => {
  const { userData, walletsDir, walletPath } = getUserDataPaths();
  return { userData, walletsDir, walletPath };
});

ipcMain.handle("config:get", () => getConfig());
ipcMain.handle("config:set", (evt, partial) => setConfig(partial || {}));

ipcMain.handle("simplewallet:resolveExe", (evt, overridePath) => {
  const resolved = resolveSimplewalletExePath(overridePath);
  return { resolved, candidates: simplewalletExeCandidates() };
});

ipcMain.handle("simplewallet:start", async (evt, input) => {
  const cfg = getConfig();
  const { walletPath } = getUserDataPaths();

  const rpcBindIp = input?.rpcBindIp || cfg.walletRpcBindIp;
  const rpcBindPort = input?.rpcBindPort || cfg.walletRpcBindPort;
  const daemonAddress = input?.daemonAddress || cfg.daemonAddress;
  const walletFile = input?.walletFile || walletPath;
  const password = input?.password;
  const overrideExe = input?.simplewalletExePath;

  // If something is already listening on the port (e.g. existing simplewallet instance),
  // reuse it instead of trying to spawn another process.
  try {
    const url = `http://${rpcBindIp}:${rpcBindPort}/json_rpc`;
    await jsonRpcCall({ url, method: "getaddress", params: {}, timeoutMs: 1500 });
    setSimplewalletState({ status: "running", rpcUrl: url, reusedExisting: true });
    return { ok: true, state: simplewalletState, rpcUrl: url, reusedExisting: true };
  } catch {
    // Not ready/available — proceed to spawn.
  }

  const simplewalletExePath = resolveSimplewalletExePath(overrideExe);
  // #region agent log
  dbg("H1", "main.js:ipcMain simplewallet:start", "Start requested from renderer", {
    walletFile,
    rpcBindIp,
    rpcBindPort,
    daemonAddress,
    overrideExe: overrideExe ? "set" : "unset",
    resolvedExe: simplewalletExePath ? simplewalletExePath : null,
  });
  // #endregion
  startSimplewallet({ walletFile, password, simplewalletExePath, daemonAddress, rpcBindIp, rpcBindPort });
  const ready = await waitForWalletRpcReady({ rpcBindIp, rpcBindPort }).catch((e) => {
    // ensure state shows stopped if it died quickly
    if (!simplewalletProc || simplewalletProc.exitCode != null) setSimplewalletState({ status: "stopped" });
    throw e;
  });

  setSimplewalletState({ status: "running", rpcUrl: ready.url });
  return { ok: true, state: simplewalletState, rpcUrl: ready.url };
});

ipcMain.handle("simplewallet:stop", async () => {
  stopSimplewallet();
  return { ok: true };
});

ipcMain.handle("simplewallet:state", async () => simplewalletState);

ipcMain.handle("wallet:generate", async (evt, input) => {
  const { walletsDir } = getUserDataPaths();
  const cfg = getConfig();

  const walletFile = input?.walletFile;
  const password = input?.password;
  const overrideExe = input?.simplewalletExePath;

  if (!walletFile) throw new Error("Missing walletFile");
  if (!password) throw new Error("Missing password");

  const simplewalletExePath = resolveSimplewalletExePath(overrideExe);
  if (!simplewalletExePath) {
    throw new Error("simplewallet.exe not found. Place it at resources/simplewallet.exe or set a custom path in Settings.");
  }

  fs.mkdirSync(walletsDir, { recursive: true });

  const args = [`--generate-new-wallet=${walletFile}`];
  const proc = spawn(simplewalletExePath, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

  // simplewallet prompts for password twice on stdin.
  proc.stdin.write(`${password}\n`);
  proc.stdin.write(`${password}\n`);
  proc.stdin.end();

  const out = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    proc.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`Wallet generation failed (exit ${code}). ${stderr || stdout}`));
    });
  });

  return { ok: true, output: out.stdout };
});

ipcMain.handle("wallet:restore", async (evt, input) => {
  const { walletsDir } = getUserDataPaths();
  const cfg = getConfig();

  const walletFile = input?.walletFile;
  const password = input?.password;
  const seedPhrase = input?.seedPhrase;
  const seedPassphrase = input?.seedPassphrase ?? "";
  const overrideExe = input?.simplewalletExePath;
  const daemonAddress = input?.daemonAddress || cfg.daemonAddress;

  if (!walletFile) throw new Error("Missing walletFile");
  if (!password) throw new Error("Missing password");
  if (!seedPhrase) throw new Error("Missing seedPhrase");

  const simplewalletExePath = resolveSimplewalletExePath(overrideExe);
  if (!simplewalletExePath) {
    throw new Error("simplewallet.exe not found. Place it at resources/simplewallet.exe or set a custom path in Settings.");
  }

  fs.mkdirSync(walletsDir, { recursive: true });

  const args = [`--restore-wallet=${walletFile}`, `--daemon-address=${daemonAddress}`];
  const proc = spawn(simplewalletExePath, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

  // Prompts vary by version; we feed the common sequence:
  // - new wallet password (+ confirm)
  // - seed phrase
  // - optional secured-seed passphrase (blank is fine)
  proc.stdin.write(`${password}\n`);
  proc.stdin.write(`${password}\n`);
  proc.stdin.write(`${seedPhrase.trim()}\n`);
  proc.stdin.write(`${seedPassphrase}\n`);
  proc.stdin.end();

  const out = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    proc.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`Wallet restore failed (exit ${code}). ${stderr || stdout}`));
    });
  });

  return { ok: true, output: out.stdout };
});

ipcMain.handle("wallet:showSeed", async (evt, input) => {
  const cfg = getConfig();

  const walletFile = input?.walletFile;
  const password = input?.password;
  const seedProtectionPassword = input?.seedProtectionPassword ?? "";
  const overrideExe = input?.simplewalletExePath;
  const daemonAddress = input?.daemonAddress || cfg.daemonAddress;

  if (!walletFile) throw new Error("Missing walletFile");
  if (!password) throw new Error("Missing password");

  const simplewalletExePath = resolveSimplewalletExePath(overrideExe);
  if (!simplewalletExePath) {
    throw new Error("simplewallet.exe not found. Place it at resources/simplewallet.exe or set a custom path in Settings.");
  }

  const args = [
    `--wallet-file=${walletFile}`,
    `--password=${password}`,
    `--daemon-address=${daemonAddress}`,
    `--no-refresh`,
    `--command=show_seed`,
  ];
  const proc = spawn(simplewalletExePath, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

  // show_seed asks:
  // - confirm operation password (wallet password)
  // - seed protection password (+ confirm) (blank is allowed)
  proc.stdin.write(`${password}\n`);
  proc.stdin.write(`${seedProtectionPassword}\n`);
  proc.stdin.write(`${seedProtectionPassword}\n`);
  proc.stdin.end();

  const out = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    proc.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`show_seed failed (exit ${code}). ${stderr || stdout}`));
    });
  });

  return { ok: true, output: out.stdout };
});

ipcMain.handle("wallet:rpc", async (evt, input) => {
  const cfg = getConfig();
  const rpcUrl = input?.url || `http://${cfg.walletRpcBindIp}:${cfg.walletRpcBindPort}/json_rpc`;
  // #region agent log
  dbg("H3", "main.js:wallet:rpc", "RPC call", {
    method: input?.method,
    rpcUrl,
    simplewalletStatus: simplewalletState?.status,
    hasProc: Boolean(simplewalletProc && simplewalletProc.exitCode == null),
  });
  // #endregion
  try {
    const data = await jsonRpcCall({
      url: rpcUrl,
      method: input?.method,
      params: input?.params,
      id: input?.id ?? 0,
      timeoutMs: input?.timeoutMs ?? 15_000,
    });
    return { ok: true, data };
  } catch (e) {
    const msg = e?.message || String(e);
    const extra =
      `\n\nsimplewallet status: ${simplewalletState?.status || "unknown"}` +
      (simplewalletState?.lastExitCode != null ? `\nlast exit code: ${simplewalletState.lastExitCode}` : "") +
      (simplewalletState?.stderrTail ? `\n\nstderr (tail):\n${simplewalletState.stderrTail}` : "");
    return { ok: false, error: msg + extra };
  }
});

ipcMain.handle("wallet:qr", async (evt, input) => {
  const text = String(input?.text || "").trim();
  if (!text) return { ok: false, error: "Missing text" };
  try {
    const dataUrl = await QRCode.toDataURL(text, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 240,
      color: { dark: "#0C0C3A", light: "#ffffff" },
    });
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle("dialog:openFile", async (evt, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options || { properties: ["openFile"] });
  return result;
});

