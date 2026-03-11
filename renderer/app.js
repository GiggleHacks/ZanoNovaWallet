const ATOMIC_UNITS = 1_000_000_000_000n;
const ZANO_ASSET_ID = "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a";
const FEE_ATOMIC = 10_000_000_000n; // 0.01 ZANO
let sessionPassword = null; // in-memory only
let lastZanoUnlockedAtomic = null; // tracks latest unlocked ZANO in atomic units

function requireSessionPassword() {
  if (sessionPassword) return sessionPassword;
  const p = prompt("Enter your wallet password to continue.");
  if (!p) return null;
  sessionPassword = p;
  return p;
}

let startupSoundPlayed = false;
let soundEnabled = true; // default on (if unset in config)

function isSoundEnabled() {
  return soundEnabled;
}

function playStartupSoundOnce() {
  if (!isSoundEnabled()) return;
  if (startupSoundPlayed) return;
  startupSoundPlayed = true;
  try {
    const audio = new Audio("../resources/zano_nova__startup.mp3");
    audio.volume = 0.9;
    audio.play().catch(() => {});
  } catch {
    // ignore audio errors
  }
}

function playSendSound() {
  if (!isSoundEnabled()) return;
  try {
    const audio = new Audio("../resources/zano_nova_send2.mp3");
    audio.volume = 0.9;
    audio.play().catch(() => {});
  } catch {
    // ignore audio errors
  }
}

const knownIncomeTxs = new Set();
let historyInitialized = false;

function playReceiveSound() {
  if (!isSoundEnabled()) return;
  try {
    const audio = new Audio("../resources/zano_nova__received.mp3");
    audio.volume = 0.9;
    audio.play().catch(() => {});
  } catch {
    // ignore audio errors
  }
}

function $(id) {
  return document.getElementById(id);
}

function setText(el, text) {
  el.textContent = text == null ? "" : String(text);
}

function appendLog(el, line) {
  const s = typeof line === "string" ? line : JSON.stringify(line, null, 2);
  el.textContent = (el.textContent ? el.textContent + "\n" : "") + s;
  el.scrollTop = el.scrollHeight;
}

function setStatus(status) {
  const dot = $("swStatusDot");
  const text = $("swStatusText");
  dot.classList.remove("ok", "warn", "bad");
  if (status === "running") dot.classList.add("ok");
  else if (status === "starting" || status === "stopping") dot.classList.add("warn");
  else if (status === "error") dot.classList.add("bad");
  setText(text, status);
}

function atomicToZanoString(nAtomic, decimals = 12) {
  try {
    const n = BigInt(nAtomic);
    const sign = n < 0n ? "-" : "";
    const a = n < 0n ? -n : n;
    const whole = a / ATOMIC_UNITS;
    const frac = a % ATOMIC_UNITS;
    const fracStrRaw = frac.toString().padStart(12, "0").slice(0, decimals);
    // Trim trailing zeros for a simple UI (e.g. 0.001000000000 -> 0.001, 1.000000000000 -> 1)
    const fracStr = fracStrRaw.replace(/0+$/, "");
    if (!fracStr) return `${sign}${whole.toString()}`;
    return `${sign}${whole.toString()}.${fracStr}`;
  } catch {
    return String(nAtomic);
  }
}

function zanoToAtomic(zanoStr) {
  const s = String(zanoStr).trim();
  if (!s) return 0n;
  const [wholeStr, fracStrRaw = ""] = s.split(".");
  const whole = BigInt(wholeStr || "0");
  const fracStr = (fracStrRaw + "0".repeat(12)).slice(0, 12);
  const frac = BigInt(fracStr || "0");
  return whole * ATOMIC_UNITS + frac;
}

async function loadDefaults() {
  const paths = await window.zano.getPaths();
  setText($("hintPaths"), `Wallet file default: ${paths.walletPath}`);
  if (!$("inputWalletFile").value) $("inputWalletFile").value = paths.walletPath;
}

async function loadSettingsIntoDialog() {
  const cfg = await window.zano.configGet();
  $("cfgDaemon").value = cfg.daemonAddress || "";
  $("cfgBindIp").value = cfg.walletRpcBindIp || "127.0.0.1";
  $("cfgBindPort").value = cfg.walletRpcBindPort || 12233;

  const savedExe = (cfg.simplewalletExePath || "").trim();
  $("cfgExe").value = savedExe;
}

async function saveSettingsFromDialog() {
  const partial = {
    daemonAddress: $("cfgDaemon").value.trim(),
    walletRpcBindIp: $("cfgBindIp").value.trim() || "127.0.0.1",
    walletRpcBindPort: Number($("cfgBindPort").value || 12233),
    simplewalletExePath: $("cfgExe").value.trim(),
  };
  await window.zano.configSet(partial);
}

async function resolveExePath() {
  const cfg = await window.zano.configGet();
  const override = (cfg.simplewalletExePath || "").trim() || null;
  return await window.zano.simplewalletResolveExe(override);
}

async function locateSimplewallet() {
  const res = await window.zano.openFileDialog({
    properties: ["openFile"],
    filters: [{ name: "Executable", extensions: ["exe"] }],
  });
  const p = res?.filePaths?.[0];
  if (!p) return null;
  await window.zano.configSet({ simplewalletExePath: p });
  return p;
}

async function startWalletRpc(passwordOverride) {
  const cfg = await window.zano.configGet();
  const password = passwordOverride ?? sessionPassword ?? $("inputPassword")?.value ?? "";
  const walletFile = $("inputWalletFile").value.trim();
  const overrideExe = (cfg.simplewalletExePath || "").trim() || undefined;

  if ($("logArea")) $("logArea").textContent = "";
  if (!password) {
    if ($("logArea")) appendLog($("logArea"), "Enter your wallet password first.");
    return;
  }
  if (!walletFile) {
    if ($("logArea")) appendLog($("logArea"), "Enter a wallet file path first.");
    return;
  }
  if ($("logArea")) appendLog($("logArea"), `Starting simplewallet RPC on ${cfg.walletRpcBindIp}:${cfg.walletRpcBindPort}…`);

  const resolved = await resolveExePath();
  if ($("logArea")) appendLog($("logArea"), `simplewallet.exe: ${resolved.resolved || "(not found)"}`);
  if (!resolved.resolved && Array.isArray(resolved.candidates)) {
    if ($("logArea")) appendLog($("logArea"), `Tried:\n- ${resolved.candidates.join("\n- ")}`);
  }

  // #region agent log
  fetch("http://127.0.0.1:7377/ingest/2e5b39fe-7a23-4b57-b6c0-2440cb15aa66", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "06be5c" },
    body: JSON.stringify({
      sessionId: "06be5c",
      runId: "pre-fix",
      hypothesisId: "H4",
      location: "app.js:startWalletRpc",
      message: "Start clicked",
      data: {
        walletFile,
        rpcBindIp: cfg.walletRpcBindIp,
        rpcBindPort: cfg.walletRpcBindPort,
        daemonAddress: cfg.daemonAddress,
        exeResolved: Boolean(resolved?.resolved),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  return await window.zano.simplewalletStart({
    walletFile,
    password,
    daemonAddress: cfg.daemonAddress,
    rpcBindIp: cfg.walletRpcBindIp,
    rpcBindPort: cfg.walletRpcBindPort,
    simplewalletExePath: overrideExe,
  });
}

async function stopWalletRpc() {
  await window.zano.simplewalletStop();
}

async function walletRpc(method, params) {
  const st = await window.zano.simplewalletState().catch(() => null);
  if (st?.status !== "running") {
    throw new Error("Wallet backend is not running yet.");
  }
  const res = await window.zano.walletRpc({ method, params });
  if (!res?.ok) throw new Error(res?.error || "Wallet RPC error");
  return res.data;
}

function renderZanoHeaderBalanceFromGetbalance(res) {
  const balances = res?.result?.balances || [];
  const zano = balances.find((b) => b?.asset_info?.asset_id === ZANO_ASSET_ID) || balances[0] || null;
  const balEl = $("zanoBalance");
  const subEl = $("zanoBalanceSub");
  if (!balEl || !subEl) return;
  if (!zano) {
    lastZanoUnlockedAtomic = null;
    setText(balEl, "—");
    setText(subEl, "Unlocked: —");
    return;
  }
  const dp = typeof zano?.asset_info?.decimal_point === "number" ? zano.asset_info.decimal_point : 12;
  try {
    lastZanoUnlockedAtomic = BigInt(zano.unlocked ?? 0);
  } catch {
    lastZanoUnlockedAtomic = null;
  }
  setText(balEl, `${atomicToZanoString(zano.total ?? 0, dp)} ZANO`);
  setText(subEl, `Unlocked: ${atomicToZanoString(zano.unlocked ?? 0, dp)} ZANO`);
}

function renderBalances(balances) {
  const root = $("balances");
  root.innerHTML = "";
  if (!balances?.length) {
    root.innerHTML = `<div class="hint">No balances (or wallet not started yet).</div>`;
    return;
  }

  for (const b of balances) {
    const ai = b.asset_info || {};
    const assetId = ai.asset_id || "";
    const ticker = ai.ticker || (assetId === ZANO_ASSET_ID ? "ZANO" : "ASSET");
    const dp = typeof ai.decimal_point === "number" ? ai.decimal_point : 12;

    const total = b.total ?? 0;
    const unlocked = b.unlocked ?? 0;
    const awaitingIn = b.awaiting_in ?? 0;
    const awaitingOut = b.awaiting_out ?? 0;

    const el = document.createElement("div");
    el.className = "asset";
    el.innerHTML = `
      <div class="assetHeader">
        <div>
          <div class="assetName">${ticker}</div>
          <div class="assetMeta">${assetId}</div>
        </div>
      </div>
      <div class="assetNums">
        <div class="kv"><div class="k">Unlocked</div><div class="v">${atomicToZanoString(unlocked, dp)}</div></div>
        <div class="kv"><div class="k">Total</div><div class="v">${atomicToZanoString(total, dp)}</div></div>
        <div class="kv"><div class="k">Awaiting in</div><div class="v">${atomicToZanoString(awaitingIn, dp)}</div></div>
        <div class="kv"><div class="k">Awaiting out</div><div class="v">${atomicToZanoString(awaitingOut, dp)}</div></div>
      </div>
    `;
    root.appendChild(el);
  }
}

function renderHistory(result) {
  const root = $("history");
  root.innerHTML = "";

  const transfers = result?.transfers || [];
  const curHeight = result?.pi?.curent_height ?? null;
  if (!transfers.length) {
    root.innerHTML = `<div class="hint">No transactions (or not synced yet).</div>`;
    return;
  }

  for (const t of transfers) {
    const height = t.height ?? 0;
    const confirmations = curHeight != null ? Math.max(0, Number(curHeight) - Number(height)) : null;
    const isPending = confirmations == null ? true : confirmations < 10;

    // Pick native ZANO subtransfer if present; otherwise first.
    const subs = Array.isArray(t.subtransfers) ? t.subtransfers : [];
    const native = subs.find((s) => s.asset_id === ZANO_ASSET_ID) || subs[0] || {};
    const amountAtomic = native.amount ?? 0;
    const isIncome = native.is_income ?? false;

    const ts = t.timestamp ? new Date(Number(t.timestamp) * 1000).toLocaleString() : "";
    const statusLabel = isIncome ? "Received" : "Sent";
    const confCount = confirmations == null ? 0 : confirmations;
    const confLabel = `Confirmations ${confCount}/10`;

    const el = document.createElement("div");
    el.className = "tx";
    el.innerHTML = `
      <div class="txTop">
        <div class="txMain">
          <div class="txDir ${isIncome ? "in" : "out"}">${isIncome ? "↓" : "↑"}</div>
          <div>
            <div class="txAmount">${atomicToZanoString(amountAtomic)} ZANO</div>
            <div class="txMeta">${statusLabel}</div>
          </div>
        </div>
        <div class="txConfWrap">
          <div class="confCircle ${isPending ? "pending" : "done"}" title="${confLabel}"></div>
          <div class="confLabel">${confCount}/10</div>
        </div>
      </div>
      <div class="hint">${ts} · height ${height} · payment_id ${t.payment_id || "-"}</div>
      <div class="hash">${t.tx_hash || ""}</div>
    `;
    root.appendChild(el);
  }
}

async function refreshBalance() {
  const res = await walletRpc("getbalance", {});
  const balances = res?.result?.balances || [];
  renderZanoHeaderBalanceFromGetbalance(res);
  if ($("balances")) renderBalances(balances);
}

async function refreshHistory() {
  const res = await walletRpc("get_recent_txs_and_info2", {
    count: 50,
    offset: 0,
    order: "FROM_BEGIN_TO_END",
    exclude_mining_txs: true,
    // Include unconfirmed so pending incoming transfers show in history
    // and can trigger the receive sound once.
    exclude_unconfirmed: false,
    update_provision_info: true,
  });
  const result = res?.result;
  const transfers = result?.transfers || [];

  let hasNewIncome = false;
  for (const t of transfers) {
    const subs = Array.isArray(t.subtransfers) ? t.subtransfers : [];
    const hasIncome = subs.some((s) => s.asset_id === ZANO_ASSET_ID && s.is_income);
    if (!hasIncome) continue;
    const hash = t.tx_hash;
    if (!hash) continue;
    if (!knownIncomeTxs.has(hash)) {
      if (historyInitialized) hasNewIncome = true;
      knownIncomeTxs.add(hash);
    }
  }

  // #region agent log
  fetch("http://127.0.0.1:7377/ingest/2e5b39fe-7a23-4b57-b6c0-2440cb15aa66", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "06be5c",
    },
    body: JSON.stringify({
      sessionId: "06be5c",
      runId: historyInitialized ? "post-init" : "init",
      hypothesisId: "RX1",
      location: "renderer/app.js:refreshHistory",
      message: "history scan",
      data: {
        transferCount: transfers.length,
        newIncomeDetected: hasNewIncome,
        knownIncomeCount: knownIncomeTxs.size,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  if (!historyInitialized) {
    historyInitialized = true;
  } else if (hasNewIncome) {
    // #region agent log
    fetch("http://127.0.0.1:7377/ingest/2e5b39fe-7a23-4b57-b6c0-2440cb15aa66", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "06be5c",
      },
      body: JSON.stringify({
        sessionId: "06be5c",
        runId: "post-init",
        hypothesisId: "RX2",
        location: "renderer/app.js:refreshHistory",
        message: "play receive sound",
        data: {},
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    playReceiveSound();
  }

  renderHistory(result);
}

async function makeIntegrated() {
  $("recvLog").textContent = "";
  const res = await walletRpc("make_integrated_address", {});
  appendLog($("recvLog"), res?.result || res);
}

async function showBaseAddress() {
  const res = await walletRpc("getaddress", {});
  const addr = res?.result?.address;
  if (addr) {
    if ($("recvLog")) {
      $("recvLog").textContent = "";
      appendLog($("recvLog"), { address: addr });
    }
    if ($("myAddress")) $("myAddress").value = addr;
  }
  return addr || null;
}

async function renderReceiveQr(address) {
  const img = $("recvQr");
  if (!img) return;
  const a = String(address || "").trim();
  if (!a) {
    img.removeAttribute("src");
    return;
  }
  const res = await window.zano.walletQr(a);
  if (res?.ok && res.dataUrl) {
    img.src = res.dataUrl;
  }
}

async function send() {
  $("sendLog").textContent = "";
  const to = $("sendAddress").value.trim();
  const amtStr = $("sendAmount").value;
  if (!to) {
    appendLog($("sendLog"), "Missing destination address.");
    return;
  }
  if (!amtStr) {
    appendLog($("sendLog"), "Missing amount.");
    return;
  }

  const selfAddrRes = await walletRpc("getaddress", {}).catch(() => null);
  const selfAddr = selfAddrRes?.result?.address || "";

  // Validate + extract standard address if integrated
  const split = await walletRpc("split_integrated_address", { integrated_address: to }).catch(() => null);
  const standard = split?.result?.standard_address || "";
  const valid = Boolean(standard) || to.startsWith("Zx");
  if (!valid) {
    appendLog($("sendLog"), "Address validation failed.");
    appendLog($("sendLog"), split || {});
    return;
  }

  const destStandard = standard || to;
  if (selfAddr && destStandard === selfAddr) {
    appendLog($("sendLog"), "Refusing to send to your own wallet address.");
    return;
  }

  const amountAtomic = zanoToAtomic(amtStr);
  if (amountAtomic <= 0n) {
    appendLog($("sendLog"), "Amount must be > 0.");
    return;
  }

  // Check unlocked balance vs amount + fee so the user
  // gets a clear, friendly explanation before we hit RPC.
  const needed = amountAtomic + FEE_ATOMIC;
  if (lastZanoUnlockedAtomic != null) {
    try {
      const unlocked = BigInt(lastZanoUnlockedAtomic);
      if (unlocked < needed) {
        appendLog(
          $("sendLog"),
          `Not enough unlocked balance. You need at least ${atomicToZanoString(
            needed
          )} ZANO (amount + fee), but only ${atomicToZanoString(unlocked)} ZANO is unlocked.`
        );
        appendLog(
          $("sendLog"),
          "Newly received funds stay locked until they reach about 10 confirmations. This can take a few minutes depending on the network."
        );
        return;
      }
    } catch {
      // If parsing fails, fall through and let RPC decide.
    }
  }

  const destinations = [
    {
      address: to,
      amount: amountAtomic.toString(),
      asset_id: ZANO_ASSET_ID,
    },
  ];

  const res = await walletRpc("transfer", {
    destinations,
    fee: FEE_ATOMIC.toString(),
    mixin: 15,
    hide_receiver: true,
    push_payer: false,
  });

  const logEl = $("sendLog");
  if (logEl) {
    const result = res?.result || {};
    const tx = result.tx_details || {};
    const txId = tx.id || result.tx_hash || tx.tx_hash || "";
    const assetId = tx.asset_id || ZANO_ASSET_ID;
    const height = tx.height ?? 0;
    const confirmations = tx.confirmations ?? 0;
    const size = tx.size || tx.tx_size || tx.blob_size || "";
    const paymentId = tx.payment_id || result.payment_id || "-";
    const comment = tx.comment || result.comment || "";
    const explorerUrl = txId ? `https://explorer.zano.org/transaction/${txId}` : "";

    logEl.innerHTML = [
      `<div><strong>Transaction ID</strong>: ${
        explorerUrl
          ? `<a href="${explorerUrl}" target="_blank" rel="noopener noreferrer">${txId}</a>`
          : txId || "-"
      }</div>`,
      `<div><strong>Asset ID</strong>: ${assetId || "-"}</div>`,
      `<div><strong>Height</strong>: ${height}</div>`,
      `<div><strong>Confirmation</strong>: ${confirmations}</div>`,
      size ? `<div><strong>Transaction size</strong>: ${size} bytes</div>` : "",
      `<div><strong>Payment ID</strong>: ${paymentId || "-"}</div>`,
      comment ? `<div><strong>Comment</strong>: ${comment}</div>` : "",
    ]
      .filter(Boolean)
      .join("");
  }

  try {
    playSendSound();
  } catch {
    // ignore audio errors
  }
}

function wireUi() {
  // sidebar navigation
  $("navWallet")?.addEventListener("click", () => switchView("wallet"));
  $("navSettings")?.addEventListener("click", () => switchView("settings"));
  $("navSecurity")?.addEventListener("click", () => {
    // require password to enter Security section
    const p = requireSessionPassword();
    if (!p) return;
    switchView("security");
  });

  $("btnOpenSend")?.addEventListener("click", () => $("sendDialog")?.showModal());
  $("btnOpenReceive")?.addEventListener("click", async () => {
    $("receiveDialog")?.showModal();
    try {
      const addr = await showBaseAddress();
      if (addr && $("recvAddress")) $("recvAddress").value = addr;
      await renderReceiveQr(addr);
    } catch {
      // ignore
    }
  });
  $("btnRefreshHistory")?.addEventListener("click", async () => {
    try {
      await refreshHistory();
    } catch (e) {
      // keep it quiet; history can lag while syncing
    }
  });

  $("btnOpenSettings").addEventListener("click", async () => {
    await loadSettingsIntoDialog();
    $("settingsDialog").showModal();
  });
  $("btnSaveSettings").addEventListener("click", async (e) => {
    e.preventDefault();
    await saveSettingsFromDialog();
    $("settingsDialog").close();
    appendLog($("logArea"), "Saved settings.");
  });
  $("btnCopyDaemon")?.addEventListener("click", async () => {
    const v = $("cfgDaemon")?.value?.trim() || "";
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
    } catch {
      // ignore
    }
  });
  $("btnBrowseExe").addEventListener("click", async () => {
    const res = await window.zano.openFileDialog({
      properties: ["openFile"],
      filters: [{ name: "simplewallet.exe", extensions: ["exe"] }],
    });
    const p = res?.filePaths?.[0];
    if (p) $("cfgExe").value = p;
  });

  $("btnLocateSimplewallet").addEventListener("click", async () => {
    $("logArea").textContent = "";
    const p = await locateSimplewallet();
    if (!p) return;
    appendLog($("logArea"), `Saved simplewallet.exe path:\n${p}`);
    const resolved = await resolveExePath();
    appendLog($("logArea"), `Resolved simplewallet.exe:\n${resolved.resolved || "(not found)"}`);
  });

  $("btnCreateWallet").addEventListener("click", async () => {
    $("logArea").textContent = "";
    const cfg = await window.zano.configGet();
    const password = requireSessionPassword();
    const walletFile = $("inputWalletFile").value.trim();
    if (!password) return appendLog($("logArea"), "Password is required.");
    if (!walletFile) return appendLog($("logArea"), "Enter a wallet file path first.");

    const resolved = await resolveExePath();
    appendLog($("logArea"), `simplewallet.exe: ${resolved.resolved || "(not found)"}`);
    if (!resolved.resolved) {
      appendLog($("logArea"), "Put simplewallet.exe at resources/simplewallet.exe, or set the path in Settings.");
      return;
    }
    try {
      appendLog($("logArea"), "Generating new wallet (this may take a moment)…");
      const out = await window.zano.walletGenerate({ walletFile, password, simplewalletExePath: cfg.simplewalletExePath });
      appendLog($("logArea"), out.output || out);
      appendLog($("logArea"), "Wallet file created. Next: start wallet RPC.");
    } catch (err) {
      appendLog($("logArea"), err?.message || String(err));
    }
  });

  $("btnRestoreWallet").addEventListener("click", async () => {
    $("logArea").textContent = "";
    const cfg = await window.zano.configGet();
    const password = requireSessionPassword();
    const walletFile = $("inputWalletFile").value.trim();
    const seedPhrase = $("inputSeedPhrase").value;
    const seedPassphrase = $("inputSeedPassphrase").value || "";
    if (!password) return appendLog($("logArea"), "Password is required.");
    if (!walletFile) return appendLog($("logArea"), "Enter a wallet file path first.");
    if (!seedPhrase) return appendLog($("logArea"), "Enter your seed phrase (24/25/26 words).");

    const resolved = await resolveExePath();
    appendLog($("logArea"), `simplewallet.exe: ${resolved.resolved || "(not found)"}`);
    if (!resolved.resolved) {
      appendLog($("logArea"), "Put simplewallet.exe at resources/simplewallet.exe, or set the path in Settings.");
      return;
    }
    try {
      appendLog($("logArea"), "Restoring wallet from seed (this may take a moment)…");
      const out = await window.zano.walletRestore({
        walletFile,
        password,
        seedPhrase,
        seedPassphrase,
        simplewalletExePath: cfg.simplewalletExePath,
        daemonAddress: cfg.daemonAddress,
      });
      appendLog($("logArea"), out.output || out);
      appendLog($("logArea"), "Wallet restored. Next: start wallet RPC (first sync may take a while).");
    } catch (err) {
      appendLog($("logArea"), err?.message || String(err));
    }
  });

  $("btnShowSeed").addEventListener("click", async () => {
    $("logArea").textContent = "";
    const cfg = await window.zano.configGet();
    const password = requireSessionPassword();
    const walletFile = $("inputWalletFile").value.trim();
    if (!password) return appendLog($("logArea"), "Password is required.");
    if (!walletFile) return appendLog($("logArea"), "Enter wallet file path first.");

    const seedProtectionPassword = prompt(
      "Optional: enter a password to protect the displayed seed (leave blank for unprotected seed)."
    );
    if (seedProtectionPassword === null) return;

    const resolved = await resolveExePath();
    appendLog($("logArea"), `simplewallet.exe: ${resolved.resolved || "(not found)"}`);
    if (!resolved.resolved) {
      appendLog($("logArea"), "Put simplewallet.exe at resources/simplewallet.exe, or set the path in Settings.");
      return;
    }
    try {
      appendLog($("logArea"), "Requesting seed phrase…");
      const out = await window.zano.walletShowSeed({
        walletFile,
        password,
        seedProtectionPassword,
        simplewalletExePath: cfg.simplewalletExePath,
        daemonAddress: cfg.daemonAddress,
      });
      appendLog($("logArea"), out.output || out);
      appendLog($("logArea"), "If you see the seed phrase above, store it securely.");
    } catch (err) {
      appendLog($("logArea"), err?.message || String(err));
    }
  });

  $("btnStartWallet").addEventListener("click", async () => {
    try {
      if (!sessionPassword) {
        appendLog($("logArea"), "Unlock first to start automatically (or enter password and use Unlock screen).");
        return;
      }
      await startWalletRpc(sessionPassword);
      appendLog($("logArea"), "Started.");
    } catch (err) {
      appendLog($("logArea"), err?.message || String(err));
      setStatus("error");
    }
  });

  $("btnStopWallet").addEventListener("click", async () => {
    await stopWalletRpc();
    appendLog($("logArea"), "Stop requested.");
  });

  $("btnCopyAddress")?.addEventListener("click", async () => {
    const addr = $("myAddress")?.value?.trim() || "";
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setText($("copyHint"), "Copied.");
      setTimeout(() => setText($("copyHint"), ""), 1200);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = addr;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
        setText($("copyHint"), "Copied.");
        setTimeout(() => setText($("copyHint"), ""), 1200);
      } finally {
        document.body.removeChild(ta);
      }
    }
  });
  $("btnCopyRecvAddress")?.addEventListener("click", async () => {
    const addr = $("recvAddress")?.value?.trim() || "";
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
    } catch {
      // ignore
    }
  });
  $("btnMakeIntegrated").addEventListener("click", async () => {
    try {
      await makeIntegrated();
    } catch (err) {
      appendLog($("recvLog"), err?.message || String(err));
    }
  });
  $("recvLog").addEventListener("dblclick", async () => {
    // convenient refresh: show standard address on double-click
    try {
      await showBaseAddress();
    } catch {
      // ignore
    }
  });
  $("btnSend").addEventListener("click", async () => {
    try {
      await send();
    } catch (err) {
      appendLog($("sendLog"), err?.message || String(err));
    }
  });

  // Sounds toggle in Advanced section
  const soundToggle = $("soundToggle");
  if (soundToggle) {
    soundToggle.checked = soundEnabled;
    soundToggle.addEventListener("change", async () => {
      soundEnabled = Boolean(soundToggle.checked);
      try {
        await window.zano.configSet({ soundEnabled });
      } catch {
        // ignore config errors
      }
    });
  }

  // Security flow
  $("btnViewSeed")?.addEventListener("click", viewSeedPhraseFlow);
  $("seedAck")?.addEventListener("change", () => {
    const checked = Boolean($("seedAck")?.checked);
    const btn = $("btnConfirmViewSeed");
    if (btn) btn.disabled = !checked;
  });
  $("btnConfirmViewSeed")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const cfg = await window.zano.configGet();
    const password = requireSessionPassword();
    const walletFile = $("inputWalletFile")?.value?.trim() || (await window.zano.getPaths()).walletPath;
    if (!password) return;

    // Close warning dialog before showing seed view
    $("seedWarningDialog")?.close();

    const seedView = $("seedViewDialog");
    const wordsEl = $("seedWords");
    if (!seedView || !wordsEl) return;
    wordsEl.innerHTML = "";

    try {
      const out = await window.zano.walletShowSeed({
        walletFile,
        password,
        seedProtectionPassword: "",
        simplewalletExePath: cfg.simplewalletExePath,
        daemonAddress: cfg.daemonAddress,
      });
      const words = extractSeedWords(out?.output || "");
      if (!words.length) {
        $("seedStatus").textContent = "Could not parse seed phrase output.";
      } else {
        $("seedStatus").textContent = words.length === 26 ? "Seed phrase (26 words)" : `Seed phrase (${words.length} words)`;
      }
      words.forEach((w, i) => {
        const chip = document.createElement("div");
        chip.className = "seedChip";
        chip.innerHTML = `<span class="seedIdx">${i + 1}</span> ${w}`;
        wordsEl.appendChild(chip);
      });
      seedView.showModal();

      $("btnCopySeed")?.addEventListener(
        "click",
        async () => {
          if (!words.length) return;
          try {
            await navigator.clipboard.writeText(words.join(" "));
          } catch {
            // ignore
          }
        },
        { once: true }
      );
    } catch (err) {
      $("seedStatus").textContent = err?.message || String(err);
      seedView.showModal();
    }
  });
}

function switchView(which) {
  const wallet = $("walletView");
  const settings = $("settingsView");
  const security = $("securityView");
  const navWallet = $("navWallet");
  const navSettings = $("navSettings");
  const navSecurity = $("navSecurity");
  if (!wallet || !settings || !security || !navWallet || !navSettings || !navSecurity) return;
  const isWallet = which === "wallet";
  const isSettings = which === "settings";
  const isSecurity = which === "security";
  wallet.classList.toggle("hidden", !isWallet);
  settings.classList.toggle("hidden", !isSettings);
  security.classList.toggle("hidden", !isSecurity);
  navWallet.classList.toggle("active", isWallet);
  navSettings.classList.toggle("active", isSettings);
  navSecurity.classList.toggle("active", isSecurity);
}

function extractSeedWords(stdoutText) {
  const text = String(stdoutText || "");
  const lines = text.split(/\r?\n/);
  let best = [];
  for (const line of lines) {
    const words = line
      .trim()
      .split(/\s+/)
      .filter((w) => /^[a-z]+$/.test(w));
    if (words.length >= 24 && words.length <= 26 && words.length > best.length) {
      best = words;
    }
  }
  if (best.length) return best;

  // fallback: scan entire output
  const all = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => /^[a-z]+$/.test(w));
  // take last 26-ish words if present
  for (let n = 26; n >= 24; n--) {
    if (all.length >= n) return all.slice(-n);
  }
  return [];
}

async function viewSeedPhraseFlow() {
  // require password before allowing security action
  const password = requireSessionPassword();
  if (!password) return;

  const warning = $("seedWarningDialog");
  const seedAck = $("seedAck");
  const btnConfirm = $("btnConfirmViewSeed");
  if (!warning || !seedAck || !btnConfirm) return;

  seedAck.checked = false;
  btnConfirm.disabled = true;
  warning.showModal();
}

async function unlockAndAutoStart() {
  const pwdEl = $("unlockPassword");
  const hintEl = $("unlockHint");
  if (!pwdEl || !hintEl) return;
  const pwd = pwdEl.value || "";
  setText(hintEl, "");
  if (!pwd) {
    setText(hintEl, "Password required.");
    return;
  }

  sessionPassword = pwd;
  pwdEl.value = "";
  $("unlockOverlay")?.classList.add("hidden");
  switchView("wallet");

  // Start backend in the background so the overlay closes instantly.
  startWalletRpc(sessionPassword)
    .then(async () => {
      await showBaseAddress().catch(() => {});
      await refreshBalance().catch(() => {});
      await refreshHistory().catch(() => {});
    })
    .catch((e) => {
      // If backend start fails, clear the in-memory password and show the error.
      sessionPassword = null;
      setText(hintEl, e?.message || String(e));
      $("unlockOverlay")?.classList.remove("hidden");
    });
}

async function init() {
  await loadDefaults();

  // Load sound preference from config (default on)
  try {
    const cfg = await window.zano.configGet();
    soundEnabled = cfg.soundEnabled !== false;
  } catch {
    soundEnabled = true;
  }

  const sw = await window.zano.simplewalletState();
  setStatus(sw?.status || "stopped");

  window.zano.onSimplewalletState((state) => {
    setStatus(state?.status || "stopped");
    // Only play startup sound once the RPC is actually ready (rpcUrl present)
    // and after the user has provided a session password this run.
    if (state?.status === "running" && state?.rpcUrl && sessionPassword) {
      playStartupSoundOnce();
    }
    if (state?.lastError) appendLog($("logArea"), `simplewallet error: ${state.lastError}`);
    if (typeof state?.lastExitCode === "number") appendLog($("logArea"), `simplewallet exit code: ${state.lastExitCode}`);
  });

  wireUi();

  $("btnUnlock")?.addEventListener("click", unlockAndAutoStart);
  $("btnUnlockClose")?.addEventListener("click", () => {
    $("unlockOverlay")?.classList.add("hidden");
  });
  $("unlockPassword")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlockAndAutoStart();
  });

  // auto-refresh while running
  setInterval(async () => {
    const st = await window.zano.simplewalletState().catch(() => null);
    if (st?.status !== "running") return;
    try {
      await refreshBalance();
    } catch {}
    try {
      await refreshHistory();
    } catch {}
  }, 10_000);
}

init().catch((e) => {
  console.error(e);
});

