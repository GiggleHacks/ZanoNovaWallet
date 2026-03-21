const { ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const QRCode = require("qrcode");

const {
  getUserDataPaths,
  getConfig,
  setConfig,
  simplewalletBinaryName,
} = require("./config");

const sw = require("./simplewallet");

let mainWindow = null;

function init(win) {
  mainWindow = win;
}

// ---------------------------------------------------------------------------
// Paths & filesystem
// ---------------------------------------------------------------------------

ipcMain.handle("app:getPaths", () => {
  const { userData, walletsDir, walletPath } = getUserDataPaths();
  return { userData, walletsDir, walletPath };
});

ipcMain.handle("wallet:fileExists", (_evt, filePath) => {
  try {
    if (!filePath || typeof filePath !== "string") return false;
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
});

ipcMain.handle("wallet:suggestNewWalletPath", (_evt, walletPath) => {
  if (!walletPath || typeof walletPath !== "string") return walletPath;
  const dir = path.dirname(walletPath);
  const base = path.basename(walletPath, path.extname(walletPath));
  const ext = path.extname(walletPath) || ".zan";
  let candidate = path.join(dir, base + ext);
  if (!fs.existsSync(candidate)) return candidate;
  candidate = path.join(dir, base + "_new" + ext);
  if (!fs.existsSync(candidate)) return candidate;
  for (let n = 2; n <= 999; n++) {
    candidate = path.join(dir, base + "_" + n + ext);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, base + "_new" + ext);
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

ipcMain.handle("config:get", () => getConfig());
ipcMain.handle("config:set", (_evt, partial) => setConfig(partial || {}));

// ---------------------------------------------------------------------------
// Simplewallet lifecycle
// ---------------------------------------------------------------------------

ipcMain.handle("simplewallet:resolveExe", async (_evt, overridePath) => {
  const cfg = getConfig();
  const rpcBindPort = cfg.walletRpcBindPort;
  // Kill any existing process on the port before copying binary files
  // This prevents EBUSY errors when simplewallet.exe is locked by a stale process
  sw.killProcessOnPort(rpcBindPort);
  // Wait a moment for the file handles to be released
  await new Promise(r => setTimeout(r, 300));
  const resolved = sw.resolveSimplewalletExePath(overridePath);
  return { resolved, candidates: sw.simplewalletExeCandidates(overridePath) };
});

ipcMain.handle("simplewallet:start", async (_evt, input) => {
  const cfg = getConfig();
  const { walletPath } = getUserDataPaths();

  const rpcBindIp = input?.rpcBindIp || cfg.walletRpcBindIp;
  const rpcBindPort = input?.rpcBindPort || cfg.walletRpcBindPort;
  const daemonAddress = input?.daemonAddress || cfg.daemonAddress;
  const walletFile = input?.walletFile || cfg.lastWalletPath || walletPath;
  const password = input?.password;
  const overrideExe = input?.simplewalletExePath;

  // Reuse an already-running instance if one answers on the port.
  try {
    const url = `http://${rpcBindIp}:${rpcBindPort}/json_rpc`;
    await sw.jsonRpcCall({ url, method: "getaddress", params: {}, timeoutMs: 1500 });

    // If a different wallet file is being opened, don't reuse — kill and respawn.
    const lastWallet = sw.getLastStartedWalletFile();
    if (lastWallet && walletFile && lastWallet !== walletFile) {
      sw.stopSimplewallet();
      await new Promise(r => setTimeout(r, 500));
      sw.killProcessOnPort(rpcBindPort);
      await new Promise(r => setTimeout(r, 300));
      // Fall through to spawn a fresh process below.
    } else {
      sw.setSimplewalletState({ status: "running", rpcUrl: url, reusedExisting: true });
      return { ok: true, state: sw.getSimplewalletState(), rpcUrl: url, reusedExisting: true };
    }
  } catch {
    // Not available — kill any orphaned process on the port before spawning.
    sw.killProcessOnPort(rpcBindPort);
    await new Promise(r => setTimeout(r, 300));
  }

  const simplewalletExePath = sw.resolveSimplewalletExePath(overrideExe);
  if (!simplewalletExePath) {
    const bin = simplewalletBinaryName();
    throw new Error(`${bin} not found. Bundle it with the app or choose a source binary in Settings → Wallet so the app can copy it into its data directory.`);
  }
  await sw.startSimplewallet({ walletFile, password, simplewalletExePath, daemonAddress, rpcBindIp, rpcBindPort });
  const ready = await sw.waitForWalletRpcReady({ rpcBindIp, rpcBindPort }).catch((e) => {
    const st = sw.getSimplewalletState();
    if (st.status !== "stopped") sw.setSimplewalletState({ status: "stopped" });
    throw e;
  });

  if (ready?.stopped) {
    return { ok: false, stopped: true, state: sw.getSimplewalletState() };
  }

  sw.setSimplewalletState({ status: "running", rpcUrl: ready.url });
  return { ok: true, state: sw.getSimplewalletState(), rpcUrl: ready.url };
});

ipcMain.handle("simplewallet:stop", async () => {
  sw.stopSimplewallet();
  return { ok: true };
});

ipcMain.handle("simplewallet:state", async () => sw.getSimplewalletState());

// ---------------------------------------------------------------------------
// Wallet operations (one-shot simplewallet invocations)
// ---------------------------------------------------------------------------

function requireResolvedExe(overrideExe) {
  const exePath = sw.resolveSimplewalletExePath(overrideExe);
  if (!exePath) {
    const bin = simplewalletBinaryName();
    throw new Error(`${bin} not found. Bundle it with the app or choose a source binary in Settings → Wallet so the app can copy it into its data directory.`);
  }
  return exePath;
}

function collectOutput(proc) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    proc.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    proc.on("error", reject);
    proc.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

ipcMain.handle("wallet:generate", async (_evt, input) => {
  const { walletsDir } = getUserDataPaths();

  const walletFile = input?.walletFile;
  const password = input?.password;
  if (!walletFile) throw new Error("Missing walletFile");
  if (!password) throw new Error("Missing password");

  const simplewalletExePath = requireResolvedExe(input?.simplewalletExePath);
  fs.mkdirSync(walletsDir, { recursive: true });

  const { opts } = sw.spawnSimplewalletEnv(simplewalletExePath);
  const args = [`--generate-new-wallet=${walletFile}`];
  const proc = spawn(simplewalletExePath, args, opts);

  // simplewallet prompts for password twice on stdin.
  proc.stdin.write(`${password}\n`);
  proc.stdin.write(`${password}\n`);
  proc.stdin.end();

  const out = await collectOutput(proc);
  if (out.code === 0) return { ok: true, output: out.stdout + (out.stderr ? "\n" + out.stderr : "") };

  const combined = (out.stdout + "\n" + out.stderr).toLowerCase();
  if (combined.includes("your wallet has been generated") || combined.includes("generated new wallet")) {
    return { ok: true, output: out.stdout + (out.stderr ? "\n" + out.stderr : "") };
  }

  const dllHint =
    process.platform === "win32" && out.code === 3221225781
      ? " The selected simplewallet source is missing required .dll files. Point Settings → Wallet at a folder or executable from a full Zano build so the app can copy the runtime files into its data directory."
      : "";
  throw new Error(`Wallet generation failed (exit ${out.code}).${dllHint} ${out.stderr || out.stdout}`);
});

ipcMain.handle("wallet:restore", async (_evt, input) => {
  const { walletsDir } = getUserDataPaths();
  const cfg = getConfig();

  const walletFile = input?.walletFile;
  const password = input?.password;
  const seedPhrase = input?.seedPhrase;
  const seedPassphrase = input?.seedPassphrase ?? "";
  const daemonAddress = input?.daemonAddress || cfg.daemonAddress;

  if (!walletFile) throw new Error("Missing walletFile");
  if (!password) throw new Error("Missing password");
  if (!seedPhrase) throw new Error("Missing seedPhrase");

  const simplewalletExePath = requireResolvedExe(input?.simplewalletExePath);
  fs.mkdirSync(walletsDir, { recursive: true });

  const { opts } = sw.spawnSimplewalletEnv(simplewalletExePath);
  const args = [
    `--restore-wallet=${walletFile}`,
    `--password=${password}`,
    `--daemon-address=${daemonAddress}`,
  ];
  const proc = spawn(simplewalletExePath, args, opts);

  // With --password on CLI, simplewallet prompts only for:
  // 1. seed phrase
  // 2. seed protection passphrase (blank if none)
  proc.stdin.write(`${seedPhrase.trim()}\n`);
  proc.stdin.write(`${seedPassphrase}\n`);
  proc.stdin.end();

  const out = await collectOutput(proc);
  const combined = (out.stdout + "\n" + out.stderr).toLowerCase();

  if (out.code !== 0) {
    // Check for successful restore despite non-zero exit (some versions do this)
    if (combined.includes("restored") || combined.includes("wallet has been restored")) {
      return { ok: true, output: out.stdout + (out.stderr ? "\n" + out.stderr : "") };
    }
    // Include raw output so user can see what simplewallet actually said
    throw new Error(`Wallet restore failed (exit ${out.code}).\n${out.stderr || out.stdout}`);
  }
  return { ok: true, output: out.stdout };
});

ipcMain.handle("wallet:showSeed", async (_evt, input) => {
  const cfg = getConfig();

  const walletFile = input?.walletFile;
  const password = input?.password;
  const seedProtectionPassword = input?.seedProtectionPassword ?? "";
  const overrideExe = (input?.simplewalletExePath || "").trim();
  const daemonAddress = input?.daemonAddress || cfg.daemonAddress;

  if (!walletFile) throw new Error("Missing walletFile");
  if (!password) throw new Error("Missing password");

  const simplewalletExePath = requireResolvedExe(overrideExe);

  const { opts } = sw.spawnSimplewalletEnv(simplewalletExePath);
  const args = [
    `--wallet-file=${walletFile}`,
    `--password=${password}`,
    `--daemon-address=${daemonAddress}`,
    `--no-refresh`,
    `--command=show_seed`,
  ];
  const proc = spawn(simplewalletExePath, args, opts);

  // show_seed asks:
  // - confirm operation password (wallet password)
  // - seed protection password (+ confirm) (blank is allowed)
  proc.stdin.write(`${password}\n`);
  proc.stdin.write(`${seedProtectionPassword}\n`);
  proc.stdin.write(`${seedProtectionPassword}\n`);
  proc.stdin.end();

  const out = await collectOutput(proc);
  if (out.code !== 0) throw new Error(`show_seed failed (exit ${out.code}). ${out.stderr || out.stdout}`);
  return { ok: true, output: out.stdout };
});

// ---------------------------------------------------------------------------
// Daemon health check (no wallet needed — used for pre-connect preflight)
// ---------------------------------------------------------------------------

ipcMain.handle("daemon:getinfo", async (_evt, input) => {
  const cfg = getConfig();
  const addr = (input?.daemonAddress || cfg.daemonAddress || "").trim();
  if (!addr) return { ok: false, error: "No daemon address" };
  const url = `http://${addr}/getinfo`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.status === "OK", height: data.height, status: data.status };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(to);
  }
});

// ---------------------------------------------------------------------------
// JSON-RPC proxy
// ---------------------------------------------------------------------------

ipcMain.handle("wallet:rpc", async (_evt, input) => {
  const cfg = getConfig();
  const rpcUrl = input?.url || `http://${cfg.walletRpcBindIp}:${cfg.walletRpcBindPort}/json_rpc`;
  try {
    const data = await sw.jsonRpcCall({
      url: rpcUrl,
      method: input?.method,
      params: input?.params,
      id: input?.id ?? 0,
      timeoutMs: input?.timeoutMs ?? 15_000,
    });
    return { ok: true, data };
  } catch (e) {
    const msg = e?.message || String(e);
    const st = sw.getSimplewalletState();
    const extra =
      `\n\nsimplewallet status: ${st?.status || "unknown"}` +
      (st?.lastExitCode != null ? `\nlast exit code: ${st.lastExitCode}` : "") +
      (st?.stderrTail ? `\n\nstderr (tail):\n${st.stderrTail}` : "");
    return { ok: false, error: msg + extra };
  }
});

// ---------------------------------------------------------------------------
// QR code
// ---------------------------------------------------------------------------

ipcMain.handle("wallet:qr", async (_evt, input) => {
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

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

ipcMain.handle("dialog:openFile", async (_evt, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options || { properties: ["openFile"] });
  return result;
});

ipcMain.handle("dialog:saveWallet", async () => {
  const { walletsDir } = getUserDataPaths();
  fs.mkdirSync(walletsDir, { recursive: true });
  const defaultPath = path.join(walletsDir, "wallet_new.zan");
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath,
    title: "Save new wallet as",
    filters: [{ name: "Zano wallet", extensions: ["zan"] }],
  });
  return result.canceled ? null : result.filePath;
});

// ---------------------------------------------------------------------------
// Swap (Exolix)
// ---------------------------------------------------------------------------

const EXOLIX_PROXY = "http://64.111.93.25:10501";

const SWAP_TICKER_MAP = {
  ZANO: { coin: "ZANO", network: "ZANO" },
  fUSD: { coin: "FUSD", network: "ZANO" },
  FUSD: { coin: "FUSD", network: "ZANO" },
};

const PROXY_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

ipcMain.handle("swap:rate", async (_evt, input) => {
  const { from, to, amount, rateType } = input || {};
  const f = SWAP_TICKER_MAP[from];
  const t = SWAP_TICKER_MAP[to];
  if (!f || !t) throw new Error(`Unsupported pair: ${from} -> ${to}`);

  const params = new URLSearchParams({
    coinFrom: f.coin, networkFrom: f.network,
    coinTo: t.coin, networkTo: t.network,
    amount: String(amount || "1"),
    rateType: rateType || "float",
  });
  const resp = await fetch(`${EXOLIX_PROXY}/rate?${params}`, { headers: PROXY_HEADERS });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Exolix rate error (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return {
    toAmount: data.toAmount,
    rate: data.rate,
    minAmount: data.minAmount,
    maxAmount: data.maxAmount,
    fromAmount: data.fromAmount,
    message: data.message || null,
  };
});

ipcMain.handle("swap:exchange", async (_evt, input) => {
  const { from, to, amount, withdrawalAddress, rateType, refundAddress } = input || {};
  const f = SWAP_TICKER_MAP[from];
  const t = SWAP_TICKER_MAP[to];
  if (!f || !t) throw new Error(`Unsupported pair: ${from} -> ${to}`);
  if (!withdrawalAddress) throw new Error("withdrawalAddress is required");

  const resp = await fetch(`${EXOLIX_PROXY}/transactions`, {
    method: "POST",
    headers: PROXY_HEADERS,
    body: JSON.stringify({
      coinFrom: f.coin, networkFrom: f.network,
      coinTo: t.coin, networkTo: t.network,
      amount,
      withdrawalAddress,
      withdrawalExtraId: "",
      rateType: rateType || "float",
      refundAddress: refundAddress || withdrawalAddress,
      refundExtraId: "",
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Exolix exchange error (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return {
    id: data.id,
    amount: data.amount,
    amountTo: data.amountTo,
    depositAddress: data.depositAddress,
    depositExtraId: data.depositExtraId || null,
    withdrawalAddress: data.withdrawalAddress,
    rate: data.rate,
    rateType: data.rateType,
    status: data.status,
  };
});

ipcMain.handle("swap:status", async (_evt, exchangeId) => {
  if (!exchangeId) throw new Error("Missing exchange ID");
  const resp = await fetch(`${EXOLIX_PROXY}/transactions/${exchangeId}`, { headers: PROXY_HEADERS });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Exolix status error (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return {
    id: data.id,
    amount: data.amount,
    amountTo: data.amountTo,
    status: data.status,
    confirmations: data.confirmations ?? 0,
    confirmationsRequired: data.confirmationsRequired ?? 10,
    hashIn: data.hashIn || null,
    hashOut: data.hashOut || null,
    coinFrom: data.coinFrom || null,
    coinTo: data.coinTo || null,
    rate: data.rate || null,
    rateType: data.rateType || null,
    depositAddress: data.depositAddress,
    withdrawalAddress: data.withdrawalAddress,
  };
});

module.exports = { init };
