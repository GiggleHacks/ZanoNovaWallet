const ATOMIC_UNITS = 1_000_000_000_000n;
const ZANO_ASSET_ID = "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a";
const FEE_ATOMIC = 10_000_000_000n; // 0.01 ZANO
let sessionPassword = null; // in-memory only
let lastZanoUnlockedAtomic = null; // tracks latest unlocked ZANO in atomic units
let lastZanoTotalAtomic = null; // tracks latest total ZANO in atomic units
const HISTORY_PAGE_SIZE = 5;
let historyPage = 0;
let currentWalletFile = "";

function makeWalletId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `w_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function requireSessionPassword() {
  if (sessionPassword) return sessionPassword;
  return null;
}

let startupSoundPlayed = false;
let soundEnabled = true; // default on (if unset in config)
let uiBusy = false;
let uiBusyReason = "";
let tooltipsEnabled = true;
let startupAudio = null;
let sendAudio = null;
let receiveAudio = null;
let sendSoundUrl = null;
let receiveSoundUrl = null;
let startupSoundUrl = null;
let soundsPrewarmed = false;

function setUiBusy(busy, reason = "") {
  uiBusy = Boolean(busy);
  uiBusyReason = reason ? String(reason) : "";
  document.body.classList.toggle("busy", uiBusy);

  const ids = [
    "btnWelcomeCreate",
    "btnWelcomeOpen",
    "btnWelcomeRestore",
    "btnSelectWalletLocation",
    "btnCreateWalletWizard",
    "btnCancelAddWallet",
    "btnSelectRestoreLocation",
    "btnRestoreWalletWizard",
    "btnCancelRestoreWallet",
    "btnLoadWallet",
    "btnOpenSend",
    "btnSend",
    "btnSendMax",
    "btnHistoryPrev",
    "btnHistoryNext",
    "btnRefreshHistory",
    "btnSaveSettings",
    "btnLock",
  ];
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    el.disabled = uiBusy;
  }

  const hint = $("swStatusText");
  if (hint && uiBusyReason) {
    // keep status label readable; don't overwrite actual simplewallet state if busy toggles off quickly
    hint.title = uiBusyReason;
  }
}

function isSoundEnabled() {
  return soundEnabled;
}

function sound(file) { return "../resources/" + file; }

function toSoundUrl(dataOrUrl) {
  if (dataOrUrl == null) return null;
  if (typeof dataOrUrl === "string") return dataOrUrl;
  const blob = new Blob([dataOrUrl], { type: "audio/mpeg" });
  return URL.createObjectURL(blob);
}

/** Suggest a non-existing wallet path in the default wallets dir. */
async function suggestWalletPath(filename) {
  const paths = await window.zano.getPaths().catch(() => null);
  if (!paths?.walletsDir) return null;
  return window.zano.suggestNewWalletPath(paths.walletsDir + "/" + filename).catch(() => null);
}

async function playStartupSoundOnce() {
  if (!isSoundEnabled()) return;
  if (startupSoundPlayed) return;
  startupSoundPlayed = true;
  try {
    if (!startupSoundUrl) {
      const data = await window.zano.getStartupSoundUrl?.().catch(() => null);
      startupSoundUrl = toSoundUrl(data) || sound("zano_nova__startup.mp3");
    }
    if (!startupAudio) {
      startupAudio = new Audio(startupSoundUrl);
      startupAudio.preload = "auto";
    }
    startupAudio.pause();
    startupAudio.currentTime = 0;
    startupAudio.volume = 0.9;
    startupAudio.play().catch(() => {});
  } catch {
    // ignore audio errors
  }
}

async function playSendSound() {
  if (!isSoundEnabled()) return;
  try {
    if (!sendSoundUrl) {
      const data = await window.zano.getSendSoundUrl?.().catch(() => null);
      sendSoundUrl = toSoundUrl(data) || sound("zano_nova_send2.mp3");
    }
    if (!sendAudio) {
      sendAudio = new Audio(sendSoundUrl);
      sendAudio.preload = "auto";
    }
    sendAudio.pause();
    sendAudio.currentTime = 0;
    sendAudio.volume = 0.9;
    await sendAudio.play().catch(() => {});
  } catch {
    // ignore audio errors
  }
}

const knownIncomeTxs = new Set();
let historyInitialized = false;

function clearWalletHistoryState() {
  knownIncomeTxs.clear();
  historyInitialized = false;
  historyPage = 0;
  const root = $("history");
  if (root) root.innerHTML = `<div class="hint">No transactions (or not synced yet).</div>`;
  updateHistoryPager(0, false);
}

function showUnlockOverlay(message) {
  const hintEl = $("unlockHint");
  const metaEl = $("unlockWalletMeta");
  const walletPath =
    currentWalletFile || $("inputWalletFile")?.value?.trim() || "";
  if (metaEl) {
    if (walletPath) {
      const parts = walletPath.split(/[/\\]/);
      const fileName = parts[parts.length - 1] || walletPath;
      metaEl.innerHTML = `Wallet: <strong>${fileName}</strong><br />Path: <span class=\"mono\">${walletPath}</span>`;
    } else {
      metaEl.textContent = "";
    }
  }
  if (hintEl) {
    const text = message || "Enter your wallet password to unlock this wallet.";
    setText(hintEl, text);
  }
  $("unlockOverlay")?.classList.remove("hidden");
  $("unlockPassword")?.focus?.();
}

async function playReceiveSound() {
  if (!isSoundEnabled()) return;
  try {
    if (!receiveSoundUrl) {
      const data = await window.zano.getReceivedSoundUrl?.().catch(() => null);
      receiveSoundUrl = toSoundUrl(data) || sound("zano__nova_recieved.mp3");
    }
    if (!receiveAudio) {
      receiveAudio = new Audio(receiveSoundUrl);
      receiveAudio.preload = "auto";
    }
    receiveAudio.pause();
    receiveAudio.currentTime = 0;
    receiveAudio.volume = 0.9;
    await receiveAudio.play().catch(() => {});
  } catch {
    // ignore audio errors
  }
}

async function prewarmSoundsIfNeeded() {
  if (soundsPrewarmed || !isSoundEnabled()) return;
  soundsPrewarmed = true;
  try {
    const [sendData, recvData] = await Promise.all([
      window.zano.getSendSoundUrl?.().catch(() => null),
      window.zano.getReceivedSoundUrl?.().catch(() => null),
    ]);
    sendSoundUrl = toSoundUrl(sendData) || "../resources/zano_nova_send2.mp3";
    receiveSoundUrl = toSoundUrl(recvData) || "../resources/zano__nova_recieved.mp3";

    sendAudio = new Audio(sendSoundUrl);
    sendAudio.preload = "auto";
    sendAudio.volume = 0;
    await sendAudio.play().catch(() => {});
    sendAudio.pause();
    sendAudio.currentTime = 0;

    receiveAudio = new Audio(receiveSoundUrl);
    receiveAudio.preload = "auto";
    receiveAudio.volume = 0;
    await receiveAudio.play().catch(() => {});
    receiveAudio.pause();
    receiveAudio.currentTime = 0;
  } catch {
    // ignore prewarm errors
  }
}

const _elCache = {};
function $(id) {
  if (id in _elCache) return _elCache[id];
  return (_elCache[id] = document.getElementById(id));
}

function setText(el, text) {
  el.textContent = text == null ? "" : String(text);
}

function appendLog(el, line) {
  const s = typeof line === "string" ? line : JSON.stringify(line, null, 2);
  el.textContent = (el.textContent ? el.textContent + "\n" : "") + s;
  el.scrollTop = el.scrollHeight;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

let tooltipEl = null;

function setupTooltips() {
  if (tooltipEl) return;
  tooltipEl = document.createElement("div");
  tooltipEl.id = "appTooltip";
  tooltipEl.className = "tooltipBubble";
  document.body.appendChild(tooltipEl);

  let tooltipTimer = null;
  let currentTipTarget = null;
   let lastPointerX = 0;
   let lastPointerY = 0;

  function showTooltip(target) {
    if (!tooltipsEnabled) return;
    const text = target?.getAttribute("data-tooltip");
    if (!text) return;
    const rect = target.getBoundingClientRect();
    tooltipEl.textContent = text;
    const padding = 12;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    // Try to place to the right of the cursor; fall back to the element if needed.
    let left = (lastPointerX || rect.right) + padding;
    const maxLeft = viewportWidth - 260 - padding;
    if (left > maxLeft) left = maxLeft;
    let top = lastPointerY || rect.top + rect.height / 2;
    tooltipEl.style.left = `${Math.round(left)}px`;
    tooltipEl.style.top = `${Math.round(top)}px`;
    tooltipEl.classList.add("visible");
  }

  function hideTooltip() {
    tooltipEl.classList.remove("visible");
  }

  document.addEventListener(
    "pointerenter",
    (e) => {
      const tipTarget = e.target.closest("[data-tooltip]");
      if (!tipTarget) return;
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      if (tooltipTimer) {
        clearTimeout(tooltipTimer);
        tooltipTimer = null;
      }
      currentTipTarget = tipTarget;
      tooltipTimer = setTimeout(() => {
        if (currentTipTarget === tipTarget) {
          showTooltip(tipTarget);
        }
      }, 3000);
    },
    true
  );

  document.addEventListener(
    "pointerleave",
    (e) => {
      const tipTarget = e.target.closest("[data-tooltip]");
      if (!tipTarget) return;
      if (tooltipTimer) {
        clearTimeout(tooltipTimer);
        tooltipTimer = null;
      }
      if (currentTipTarget === tipTarget) {
        currentTipTarget = null;
      }
      hideTooltip();
    },
    true
  );

  document.addEventListener(
    "scroll",
    () => {
      if (tooltipTimer) {
        clearTimeout(tooltipTimer);
        tooltipTimer = null;
      }
      currentTipTarget = null;
      hideTooltip();
    },
    true
  );
}

function setStatus(status) {
  const dot = $("swStatusDot");
  const text = $("swStatusText");
  dot.classList.remove("ok", "warn", "bad");
  if (status === "running") dot.classList.add("ok");
  else if (status === "starting" || status === "stopping") dot.classList.add("warn");
  else if (status === "error" || status === "stopped") dot.classList.add("bad");
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
  // Don't auto-fill a default wallet file; the user will create/open/restore explicitly.
}

async function updateCurrentWalletPathDisplay() {
  const el = $("currentWalletPathDisplay");
  if (!el) return;
  const path = (currentWalletFile || "").trim();
  if (path) {
    el.textContent = path;
  } else {
    try {
      const cfg = await window.zano.configGet();
      const last = (cfg?.lastWalletPath || "").trim();
      el.textContent = last || "—";
    } catch {
      el.textContent = "—";
    }
  }
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
  });
  const p = res?.filePaths?.[0];
  if (!p) return null;
  await window.zano.configSet({ simplewalletExePath: p });
  return p;
}

async function startWalletRpc(passwordOverride) {
  clearWalletHistoryState();
  const cfg = await window.zano.configGet();
  const password = passwordOverride ?? sessionPassword ?? $("inputPassword")?.value ?? "";
  let walletFile = "";
  const walletInput = $("inputWalletFile");
  if (walletInput) walletFile = walletInput.value.trim();
  if (!walletFile) {
    const paths = await window.zano.getPaths().catch(() => null);
    const defaultWalletPath = paths?.walletPath ? String(paths.walletPath).trim() : "";
    const cfgWallet = (cfg.lastWalletPath || "").trim();
    walletFile = cfgWallet || defaultWalletPath || "";
  }
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
  if ($("logArea")) appendLog($("logArea"), `simplewallet: ${resolved.resolved || "(not found)"}`);
  if (!resolved.resolved && Array.isArray(resolved.candidates)) {
    if ($("logArea")) appendLog($("logArea"), `Tried:\n- ${resolved.candidates.join("\n- ")}`);
  }

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
    lastZanoTotalAtomic = null;
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
  try {
    lastZanoTotalAtomic = BigInt(zano.total ?? 0);
  } catch {
    lastZanoTotalAtomic = null;
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
    // Prefer explicit confirmations from RPC when present; fall back to height math.
    let confirmations = typeof t.confirmations === "number" ? t.confirmations : null;
    if (confirmations == null) {
      const heightRaw = t.height;
      const hasHeight = typeof heightRaw === "number" && heightRaw > 0;
      if (hasHeight && curHeight != null) {
        confirmations = Math.max(0, Number(curHeight) - Number(heightRaw));
      } else {
        // No usable height yet (likely mempool / 0-conf) – treat as 0 confirmations.
        confirmations = 0;
      }
    }
    const isPending = confirmations < 10;

    // Pick native ZANO subtransfer if present; otherwise first.
    const subs = Array.isArray(t.subtransfers) ? t.subtransfers : [];
    const native = subs.find((s) => s.asset_id === ZANO_ASSET_ID) || subs[0] || {};
    const amountAtomic = native.amount ?? 0;
    const isIncome = native.is_income ?? false;

    const ts = t.timestamp ? new Date(Number(t.timestamp) * 1000).toLocaleString() : "";
    const statusLabel = isIncome ? "Received" : "Sent";
    const txHash = t.tx_hash || "";
    const confCount = confirmations == null ? 0 : confirmations;
    const confDisplay = Math.min(confCount, 10);
    const confLabel =
      confCount >= 10 ? "Confirmations 10+ (confirmed)" : `Confirmations ${confDisplay}/10`;

    const el = document.createElement("div");
    el.className = "tx";
    const paymentId = t.payment_id || "";
    const explorerUrl = txHash
      ? `https://explorer.zano.org/transaction/${txHash}`
      : "";
    const paymentMarkup =
      paymentId && explorerUrl
        ? `payment_id <a href="${explorerUrl}" target="_blank" rel="noopener noreferrer">${paymentId}</a>`
        : `payment_id ${paymentId || "-"}`;
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
          <div class="confLabel">${confDisplay}/10</div>
        </div>
      </div>
      <div class="hint">${ts} · ${paymentMarkup}</div>
      <div class="hash">${txHash}</div>
    `;
    root.appendChild(el);
  }
}

function updateHistoryPager(page, hasNext) {
  const label = $("historyPageLabel");
  const prev = $("btnHistoryPrev");
  const next = $("btnHistoryNext");
  if (!label || !prev || !next) return;
  label.textContent = `Page ${page + 1}`;
  prev.disabled = page <= 0;
  next.disabled = !hasNext;
}

function getMaxSendableAtomic() {
  if (lastZanoUnlockedAtomic == null) return null;
  const m = lastZanoUnlockedAtomic - FEE_ATOMIC;
  return m > 0n ? m : 0n;
}

function updateSendDialogBalances() {
  const totalEl = $("sendBalanceTotal");
  const unlockedEl = $("sendBalanceUnlocked");
  const maxEl = $("sendBalanceMax");
  if (!totalEl || !unlockedEl || !maxEl) return;

  if (lastZanoTotalAtomic == null && lastZanoUnlockedAtomic == null) {
    setText(totalEl, "—");
    setText(unlockedEl, "—");
    setText(maxEl, "—");
    return;
  }

  const total = lastZanoTotalAtomic ?? lastZanoUnlockedAtomic ?? 0n;
  const unlocked = lastZanoUnlockedAtomic ?? 0n;
  const max = getMaxSendableAtomic();

  setText(totalEl, `${atomicToZanoString(total)} ZANO`);
  setText(unlockedEl, `${atomicToZanoString(unlocked)} ZANO`);
  setText(maxEl, max != null ? `${atomicToZanoString(max)} ZANO` : "—");
}

async function refreshBalance() {
  const res = await walletRpc("getbalance", {});
  const balances = res?.result?.balances || [];
  renderZanoHeaderBalanceFromGetbalance(res);
  if ($("balances")) renderBalances(balances);
}

async function refreshHistory(page = historyPage) {
  historyPage = page;
  const res = await walletRpc("get_recent_txs_and_info2", {
    count: HISTORY_PAGE_SIZE,
    offset: page * HISTORY_PAGE_SIZE,
    order: "FROM_END_TO_BEGIN",
    exclude_mining_txs: true,
    // Include unconfirmed so 0-confirmation receives show in history and we can play receive sound as soon as they appear.
    exclude_unconfirmed: false,
    update_provision_info: true,
  });
  const result = res?.result;
  const transfers = result?.transfers || [];
  const hasNextPage = transfers.length === HISTORY_PAGE_SIZE;

  let hasNewIncome = false;
  for (const t of transfers) {
    const subs = Array.isArray(t.subtransfers) ? t.subtransfers : [];
    const hasIncome = subs.some((s) => s.asset_id === ZANO_ASSET_ID && s.is_income);
    if (!hasIncome) continue;
    // Use tx_hash when present; for pending (0-conf) some backends may omit it, so fall back to a composite key.
    const hash = t.tx_hash || `pending:${t.payment_id ?? ""}:${t.timestamp ?? ""}:${subs.map((s) => `${s.amount ?? ""}_${s.is_income}`).join(",")}`;
    if (!knownIncomeTxs.has(hash)) {
      knownIncomeTxs.add(hash);
      // Only play sound for receives that appear *after* the first history load (once per new tx).
      if (historyInitialized) hasNewIncome = true;
    }
  }

  if (!historyInitialized) {
    historyInitialized = true;
  }
  if (hasNewIncome) {
    playReceiveSound();
  }

  renderHistory(result);
  updateHistoryPager(page, hasNextPage);
}

async function makeIntegrated() {
  const res = await walletRpc("make_integrated_address", {});
  const integrated =
    res?.result?.integrated_address || res?.result?.address || res?.result || "";
  if (integrated && $("recvAddress")) {
    $("recvAddress").value = integrated;
    await renderReceiveQr(integrated);
  }
}

async function showBaseAddress() {
  const res = await walletRpc("getaddress", {});
  const addr = res?.result?.address;
  if (addr) {
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
  const toRaw = $("sendAddress").value.trim();
  const amtStr = $("sendAmount").value;
  if (!toRaw) {
    appendLog($("sendLog"), "Missing destination address.");
    return;
  }
  if (!amtStr) {
    appendLog($("sendLog"), "Missing amount.");
    return;
  }

  const selfAddrRes = await walletRpc("getaddress", {}).catch(() => null);
  const selfAddr = selfAddrRes?.result?.address || "";

  const to = toRaw;

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
    await playSendSound();
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

  async function resetCreateForm() {
    $("addWalletLog").textContent = "";
    $("addWalletName").value = "";
    $("addWalletPassword").value = "";
    $("addWalletPassword2").value = "";
    selectedCreatePath = null;
    createPathManuallyChosen = false;
    const suggested = await suggestWalletPath("wallet.zan");
    selectedCreatePath = suggested;
    $("addWalletPathHint").textContent = suggested || "No file selected.";
  }

  async function resetRestoreForm() {
    $("restoreWalletLog").textContent = "";
    $("restoreWalletName").value = "";
    $("restoreSeedPhrase").value = "";
    $("restoreSeedPassphrase").value = "";
    $("restoreWalletPassword").value = "";
    $("restoreWalletPassword2").value = "";
    selectedRestorePath = null;
    restorePathManuallyChosen = false;
    const suggested = await suggestWalletPath("restored_wallet.zan");
    selectedRestorePath = suggested;
    $("restoreWalletPathHint").textContent = suggested || "No file selected.";
  }

  $("btnAddWallet")?.addEventListener("click", async () => {
    await resetCreateForm();
    switchView("addWallet");
  });

  $("btnWelcomeCreate")?.addEventListener("click", () => $("btnAddWallet")?.click());
  $("btnWelcomeOpen")?.addEventListener("click", () => $("btnLoadWallet")?.click());
  $("btnWelcomeRestore")?.addEventListener("click", async () => {
    await resetRestoreForm();
    switchView("restoreWallet");
  });

  $("btnOpenRestoreWizard")?.addEventListener("click", async () => {
    await resetRestoreForm();
    switchView("restoreWallet");
  });

  $("btnCancelAddWallet")?.addEventListener("click", () => {
    selectedCreatePath = null;
    switchView("welcome");
  });
  $("btnCancelRestoreWallet")?.addEventListener("click", () => {
    switchView("welcome");
  });

  $("seedBackupAck")?.addEventListener("change", () => {
    const ok = Boolean($("seedBackupAck")?.checked);
    const btn = $("btnSeedBackupContinue");
    if (btn) btn.disabled = !ok;
  });
  $("btnCopySeedBackup")?.addEventListener("click", async () => {
    const words = Array.from($("seedBackupWords")?.querySelectorAll(".seedWord") || [])
      .map((el) => String(el.textContent || "").replace(/^\d+\.\s*/, "").trim())
      .filter(Boolean);
    if (!words.length) return;
    try {
      await navigator.clipboard.writeText(words.join(" "));
    } catch {
      // ignore
    }
  });
  $("btnSeedBackupContinue")?.addEventListener("click", async () => {
    const cfg = await window.zano.configGet().catch(() => ({}));
    const walletFile = (currentWalletFile || "").trim() || (cfg?.lastWalletPath || "").trim() || "";
    if (!walletFile) {
      const statusEl = $("seedBackupStatus");
      if (statusEl) statusEl.textContent = "Wallet path not set. Please create the wallet again.";
      return;
    }
    const password = sessionPassword;
    if (!password) {
      const statusEl = $("seedBackupStatus");
      if (statusEl) statusEl.textContent = "Session password missing. Please create the wallet again.";
      return;
    }

    setUiBusy(true, "Starting backend…");
    try {
      await startWalletRpc(password);
      await refreshBalance().catch(() => {});
      await refreshHistory(0).catch(() => {});
      const statusEl = $("seedBackupStatus");
      if (statusEl) {
        statusEl.textContent = "You've successfully created your wallet. The backend is syncing with the network — you can use your wallet now.";
      }
      switchView("wallet");
    } catch (e) {
      const msg = e?.message || String(e);
      const statusEl = $("seedBackupStatus");
      if (statusEl) statusEl.textContent = "Backend failed to start: " + msg;
    } finally {
      setUiBusy(false);
    }
  });

  let selectedCreatePath = null;
  let createPathManuallyChosen = false;
  $("btnSelectWalletLocation")?.addEventListener("click", async () => {
    const p = await window.zano.saveWalletDialog().catch(() => null);
    if (!p) return;
    selectedCreatePath = p;
    createPathManuallyChosen = true;
    $("addWalletPathHint").textContent = p;
  });

  // Update default path when wallet name changes (unless user manually chose a location)
  $("addWalletName")?.addEventListener("input", async () => {
    if (createPathManuallyChosen) return;
    const name = $("addWalletName").value.trim();
    if (!name) return;
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const suggested = await suggestWalletPath(safeName + ".zan");
    if (suggested) {
      selectedCreatePath = suggested;
      $("addWalletPathHint").textContent = suggested;
    }
  });

  let selectedRestorePath = null;
  let restorePathManuallyChosen = false;
  $("btnSelectRestoreLocation")?.addEventListener("click", async () => {
    const p = await window.zano.saveWalletDialog().catch(() => null);
    if (!p) return;
    selectedRestorePath = p;
    restorePathManuallyChosen = true;
    $("restoreWalletPathHint").textContent = p;
  });

  // Update default path when restore wallet name changes (unless user manually chose a location)
  $("restoreWalletName")?.addEventListener("input", async () => {
    if (restorePathManuallyChosen) return;
    const name = $("restoreWalletName").value.trim();
    if (!name) return;
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const suggested = await suggestWalletPath(safeName + ".zan");
    if (suggested) {
      selectedRestorePath = suggested;
      $("restoreWalletPathHint").textContent = suggested;
    }
  });

  $("btnCreateWalletWizard")?.addEventListener("click", async () => {
    const logEl = $("addWalletLog");
    logEl.textContent = "";
    const name = $("addWalletName").value.trim();
    const password = $("addWalletPassword").value;
    const password2 = $("addWalletPassword2").value;
    if (!name) return appendLog(logEl, "Enter a wallet name.");
    if (!password) return appendLog(logEl, "Enter a wallet password.");
    if (password !== password2) return appendLog(logEl, "Passwords do not match.");
    if (!selectedCreatePath) {
      appendLog(logEl, "Select wallet location first.");
      return;
    }

    setUiBusy(true, "Creating wallet…");
    try {
      const cfg = await window.zano.configGet();
      const resolved = await resolveExePath();
      appendLog(logEl, `simplewallet: ${resolved.resolved || "(not found)"}`);
      if (!resolved.resolved) {
        setUiBusy(false);
        return appendLog(logEl, "simplewallet was not found. Bundle it with the app or choose a source binary in Settings → Wallet so the app can copy it into its data directory.");
      }

      let walletFile = await window.zano.suggestNewWalletPath(selectedCreatePath);
      if (walletFile !== selectedCreatePath) {
        appendLog(logEl, `File already exists, using: ${walletFile}`);
        selectedCreatePath = walletFile;
        $("addWalletPathHint").textContent = walletFile;
      }

      appendLog(logEl, "Generating new wallet…");
      const out = await window.zano.walletGenerate({ walletFile, password, simplewalletExePath: cfg.simplewalletExePath });
      appendLog(logEl, out.output || out);

      await window.zano.configSet({ lastWalletPath: walletFile });
      currentWalletFile = walletFile;
      const walletInput = $("inputWalletFile");
      if (walletInput) walletInput.value = walletFile;
      sessionPassword = password;

      await showSeedBackupForWallet({ walletFile, password, name });
      switchView("seedBackup");
    } catch (e) {
      appendLog(logEl, e?.message || String(e));
    } finally {
      setUiBusy(false);
    }
  });

  $("btnRestoreWalletWizard")?.addEventListener("click", async () => {
    const logEl = $("restoreWalletLog");
    logEl.textContent = "";
    const name = $("restoreWalletName").value.trim();
    const seedPhrase = $("restoreSeedPhrase").value.trim();
    const seedPassphrase = $("restoreSeedPassphrase").value || "";
    const password = $("restoreWalletPassword").value;
    const password2 = $("restoreWalletPassword2").value;
    if (!name) return appendLog(logEl, "Enter a wallet name.");
    if (!seedPhrase) return appendLog(logEl, "Enter your seed phrase.");
    if (!password) return appendLog(logEl, "Enter a wallet password.");
    if (password !== password2) return appendLog(logEl, "Passwords do not match.");
    if (!selectedRestorePath) return appendLog(logEl, "Select wallet location first.");

    setUiBusy(true, "Restoring wallet…");
    try {
      const cfg = await window.zano.configGet();
      const resolved = await resolveExePath();
      appendLog(logEl, `simplewallet: ${resolved.resolved || "(not found)"}`);
      if (!resolved.resolved) {
        setUiBusy(false);
        return appendLog(logEl, "simplewallet was not found. Bundle it with the app or choose a source binary in Settings → Wallet so the app can copy it into its data directory.");
      }

    let walletFile = await window.zano.suggestNewWalletPath(selectedRestorePath);
    if (walletFile !== selectedRestorePath) {
      appendLog(logEl, `File already exists, using: ${walletFile}`);
      selectedRestorePath = walletFile;
      $("restoreWalletPathHint").textContent = walletFile;
    }

      appendLog(logEl, "Restoring wallet…");
      const out = await window.zano.walletRestore({
        walletFile,
        password,
        seedPhrase,
        seedPassphrase,
        simplewalletExePath: cfg.simplewalletExePath,
        daemonAddress: cfg.daemonAddress,
      });
      appendLog(logEl, out.output || out);

      await window.zano.configSet({ lastWalletPath: walletFile });
      currentWalletFile = walletFile;
      const walletInput2 = $("inputWalletFile");
      if (walletInput2) walletInput2.value = walletFile;

      // Start backend for restored wallet.
      sessionPassword = password;
      await startWalletRpc(password).catch((e) => appendLog(logEl, e?.message || String(e)));
      await refreshBalance().catch(() => {});
      await refreshHistory(0).catch(() => {});
      switchView("wallet");
    } catch (e) {
      appendLog(logEl, e?.message || String(e));
    } finally {
      setUiBusy(false);
    }
  });

  $("btnOpenSend")?.addEventListener("click", async () => {
    $("sendDialog")?.showModal();
    try {
      await refreshBalance();
    } catch {}
    updateSendDialogBalances();
  });
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
      await refreshHistory(0);
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
    });
    const p = res?.filePaths?.[0];
    if (p) $("cfgExe").value = p;
  });

  $("btnLocateSimplewallet").addEventListener("click", async () => {
    $("logArea").textContent = "";
    const p = await locateSimplewallet();
    if (!p) return;
    appendLog($("logArea"), `Saved simplewallet path:\n${p}`);
    const resolved = await resolveExePath();
    appendLog($("logArea"), `Resolved simplewallet:\n${resolved.resolved || "(not found)"}`);
  });

  $("btnLoadWallet")?.addEventListener("click", async () => {
    const logEl = $("logArea");
    logEl.textContent = "";
    try {
      setUiBusy(true, "Opening wallet…");
      const res = await window.zano.openFileDialog({
        properties: ["openFile"],
        filters: [{ name: "Zano wallet", extensions: ["zan"] }],
      });
      const filePath = res?.filePaths?.[0];
      if (!filePath) {
        appendLog(logEl, "Cancelled.");
        return;
      }
      currentWalletFile = filePath;
      const walletInput = $("inputWalletFile");
      if (walletInput) walletInput.value = filePath;
      appendLog(logEl, `Selected wallet file:\n${filePath}`);

      // Stop any running backend and clear old wallet UI state.
      await window.zano.simplewalletStop().catch(() => {});
      clearWalletHistoryState();

      await window.zano.configSet({ lastWalletPath: filePath });
      showUnlockOverlay("Enter wallet password");
    } catch (e) {
      appendLog(logEl, e?.message || String(e));
    } finally {
      setUiBusy(false);
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
  $("btnSend").addEventListener("click", async () => {
    try {
      await send();
    } catch (err) {
      appendLog($("sendLog"), err?.message || String(err));
    }
  });

  const sendAmountEl = $("sendAmount");
  if (sendAmountEl) {
    const STEP = 0.1;
    function getMaxSendableZano() {
      const maxAtomic = getMaxSendableAtomic();
      if (maxAtomic == null) return Infinity;
      return Number(maxAtomic) / Number(ATOMIC_UNITS);
    }
    sendAmountEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const current = parseFloat(sendAmountEl.value) || 0;
      const delta = e.deltaY > 0 ? -STEP : STEP;
      let next = Math.max(0, current + delta);
      next = Math.round(next * 10) / 10;
      const maxZ = getMaxSendableZano();
      if (Number.isFinite(maxZ)) next = Math.min(next, maxZ);
      sendAmountEl.value = next;
    }, { passive: false });

    sendAmountEl.addEventListener("input", () => {
      const raw = parseFloat(sendAmountEl.value);
      if (Number.isNaN(raw) || raw < 0) {
        sendAmountEl.value = "";
        return;
      }
      const maxZ = getMaxSendableZano();
      let v = raw;
      if (Number.isFinite(maxZ)) v = Math.min(v, maxZ);
      v = Math.round(v * 10) / 10;
      if (v !== raw) sendAmountEl.value = String(v);
    });
  }

  $("btnSendMax")?.addEventListener("click", () => {
    const maxAtomic = getMaxSendableAtomic();
    const el = $("sendAmount");
    if (!el) return;
    if (maxAtomic == null) {
      el.value = "";
      return;
    }
    el.value = atomicToZanoString(maxAtomic);
  });

  const historyPrev = $("btnHistoryPrev");
  const historyNext = $("btnHistoryNext");
  if (historyPrev) {
    historyPrev.addEventListener("click", async () => {
      if (historyPage <= 0) return;
      await refreshHistory(historyPage - 1);
    });
  }
  if (historyNext) {
    historyNext.addEventListener("click", async () => {
      await refreshHistory(historyPage + 1);
    });
  }

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

  // Tooltip / help popup toggle in Advanced section
  const tooltipToggle = $("tooltipToggle");
  if (tooltipToggle) {
    tooltipToggle.checked = tooltipsEnabled;
    tooltipToggle.addEventListener("change", async () => {
      tooltipsEnabled = Boolean(tooltipToggle.checked);
      try {
        await window.zano.configSet({ tooltipsEnabled });
      } catch {
        // ignore config errors
      }
      // Hide any visible tooltip immediately when turning off
      if (!tooltipsEnabled && tooltipEl) {
        tooltipEl.classList.remove("visible");
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
  const welcome = $("welcomeView");
  const addWallet = $("addWalletView");
  const restoreWallet = $("restoreWalletView");
  const seedBackup = $("seedBackupView");
  const navWallet = $("navWallet");
  const navSettings = $("navSettings");
  const navSecurity = $("navSecurity");
  if (!wallet || !settings || !security || !navWallet || !navSettings || !navSecurity) return;
  const isWallet = which === "wallet";
  const isSettings = which === "settings";
  const isSecurity = which === "security";
  const isWelcome = which === "welcome";
  const isAddWallet = which === "addWallet";
  const isRestoreWallet = which === "restoreWallet";
  const isSeedBackup = which === "seedBackup";
  wallet.classList.toggle("hidden", !isWallet);
  settings.classList.toggle("hidden", !isSettings);
  security.classList.toggle("hidden", !isSecurity);
  welcome?.classList.toggle("hidden", !isWelcome);
  addWallet?.classList.toggle("hidden", !isAddWallet);
  restoreWallet?.classList.toggle("hidden", !isRestoreWallet);
  seedBackup?.classList.toggle("hidden", !isSeedBackup);
  navWallet.classList.toggle("active", isWallet);
  navSettings.classList.toggle("active", isSettings);
  navSecurity.classList.toggle("active", isSecurity);
  if (isSettings) updateCurrentWalletPathDisplay();
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

function renderSeedWordsInto(el, words) {
  if (!el) return;
  el.innerHTML = "";
  words.forEach((w, i) => {
    const chip = document.createElement("div");
    chip.className = "seedWord";
    chip.textContent = `${i + 1}. ${w}`;
    el.appendChild(chip);
  });
}

async function showSeedBackupForWallet({ walletFile, password, name }) {
  const cfg = await window.zano.configGet();
  const meta = $("seedBackupMeta");
  const wordsEl = $("seedBackupWords");
  const ack = $("seedBackupAck");
  const cont = $("btnSeedBackupContinue");
  if (meta) meta.textContent = `${name || "Wallet"} · ${walletFile}`;
  if (ack) ack.checked = false;
  if (cont) cont.disabled = true;
  if (wordsEl) wordsEl.innerHTML = "";

  const out = await window.zano.walletShowSeed({
    walletFile,
    password,
    seedProtectionPassword: "",
    simplewalletExePath: cfg.simplewalletExePath,
    daemonAddress: cfg.daemonAddress,
  });
  const words = extractSeedWords(out?.output || "");
  renderSeedWordsInto(wordsEl, words);
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
  setUiBusy(true, "Starting backend…");
  startWalletRpc(sessionPassword)
    .then(async () => {
      await showBaseAddress().catch(() => {});
      await refreshBalance().catch(() => {});
      await refreshHistory().catch(() => {});
    })
    .catch((e) => {
      // If backend start fails, clear the in-memory password and show the error.
      sessionPassword = null;
      const msg = e?.message || String(e);
      // simplewallet often exits with code 1 when password is wrong; show a clear message.
      const isLikelyWrongPassword =
        /exit\s*1/i.test(msg) && /exited before RPC became ready/i.test(msg);
      setText(hintEl, isLikelyWrongPassword ? "Password is not correct." : msg);
      $("unlockOverlay")?.classList.remove("hidden");
    })
    .finally(() => {
      setUiBusy(false);
    });
}

async function init() {
  await loadDefaults();
  const cfg = await window.zano.configGet().catch(() => ({}));
  let lastWalletPath = String(cfg?.lastWalletPath || "").trim();
  const paths = await window.zano.getPaths().catch(() => null);
  const defaultWalletPath = paths?.walletPath ? String(paths.walletPath).trim() : "";
  // On first run (no wallet configured), show the official-style welcome screen.
  // If a wallet exists, remember it and prompt for password.
  $("unlockOverlay")?.classList.add("hidden");
  if (!lastWalletPath && defaultWalletPath) {
    const defaultExists = await window.zano.walletFileExists(defaultWalletPath).catch(() => false);
    if (defaultExists) {
      lastWalletPath = defaultWalletPath;
      await window.zano.configSet({ lastWalletPath }).catch(() => {});
    }
  }

  if (!lastWalletPath) {
    switchView("welcome");
  } else {
    const exists = await window.zano.walletFileExists(lastWalletPath).catch(() => false);
    if (!exists) {
      await window.zano.configSet({ lastWalletPath: "" }).catch(() => {});
      switchView("welcome");
    } else {
      currentWalletFile = lastWalletPath;
      const walletInput = $("inputWalletFile");
      if (walletInput) walletInput.value = lastWalletPath;
      switchView("wallet");
      // Returning user: immediately prompt to unlock the last-used wallet.
      showUnlockOverlay("Enter your wallet password to unlock this wallet.");
    }
  }

  // Load sound preference from config (default on)
  try {
    soundEnabled = cfg.soundEnabled !== false;
  } catch {
    soundEnabled = true;
  }

  // Prewarm sounds after config is loaded so playback starts cleanly.
  prewarmSoundsIfNeeded().catch(() => {});

  // Load tooltip preference from config (default on)
  try {
    tooltipsEnabled = cfg.tooltipsEnabled !== false;
  } catch {
    tooltipsEnabled = true;
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
  setupTooltips();

  $("btnUnlock")?.addEventListener("click", unlockAndAutoStart);
  $("btnUnlockClose")?.addEventListener("click", () => {
    $("unlockOverlay")?.classList.add("hidden");
  });
  $("btnUnlockCreateNew")?.addEventListener("click", () => {
    $("unlockOverlay")?.classList.add("hidden");
    switchView("settings");
  });
  $("unlockPassword")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlockAndAutoStart();
  });

  // auto-refresh while running (lower frequency; skip during busy ops)
  setInterval(async () => {
    if (uiBusy) return;
    const st = await window.zano.simplewalletState().catch(() => null);
    if (st?.status !== "running") return;
    try {
      await refreshBalance();
    } catch {}
    try {
      await refreshHistory();
    } catch {}
  }, 15_000);
}

init().catch((e) => {
  console.error(e);
});

