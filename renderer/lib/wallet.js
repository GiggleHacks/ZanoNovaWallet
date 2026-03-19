import { createLogger } from "./logger.js";
import { $, setText, appendLog, makeHint } from "./dom.js";
import { state, getSessionPassword } from "./state.js";
import { atomicToZanoString, atomicToDisplayString, getMaxSendableAtomic } from "./currency.js";
import {
  ZANO_ASSET_ID,
  FUSD_ASSET_ID,
  KNOWN_ASSETS,
  FUSD_LOGO_URL,
  ZANO_LOGO_URL,
  HISTORY_PAGE_SIZE,
  CONFIRMATION_THRESHOLD,
  EXPLORER_TX_URL,
  DEFAULT_DAEMON_ADDRESS,
  DEFAULT_RPC_BIND_IP,
  DEFAULT_RPC_BIND_PORT,
  KNOWN_NODES,
} from "./constants.js";
import { playReceiveSound } from "./audio.js";

const log = createLogger("wallet");

// ---------------------------------------------------------------------------
// Startup cache — pre-resolved before password entry to shave ~200ms off unlock
// ---------------------------------------------------------------------------

let _startupCache = null;

/** Call during app init (while unlock screen is showing) to pre-resolve config
 *  and exe path so startWalletRpc() can skip those async calls. */
export async function prewarmStartupCache() {
  try {
    const cfg      = await window.zano.configGet();
    const resolved = await resolveExePath();
    _startupCache  = { cfg, resolved };
    log.debug("startup cache ready");
  } catch {
    _startupCache = null;
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Suggest a non-colliding wallet path inside the default wallets dir. */
export async function suggestWalletPath(filename) {
  const paths = await window.zano.getPaths().catch(() => null);
  if (!paths?.walletsDir) return null;
  return window.zano.suggestNewWalletPath(paths.walletsDir + "/" + filename).catch(() => null);
}

/** Resolve default wallet path from app paths with normalized trimming. */
export async function getDefaultWalletPath() {
  const paths = await window.zano.getPaths().catch(() => null);
  return paths?.walletPath ? String(paths.walletPath).trim() : "";
}

// ---------------------------------------------------------------------------
// Overlay / history state
// ---------------------------------------------------------------------------

export function showUnlockOverlay(message) {
  const hintEl = $("unlockHint");
  const metaEl = $("unlockWalletMeta");
  const walletPath = state.currentWalletFile || $("inputWalletFile")?.value?.trim() || "";
  if (metaEl) {
    if (walletPath) {
      const parts = walletPath.split(/[/\\]/);
      const fileName = parts[parts.length - 1] || walletPath;
      const strong = document.createElement("strong");
      strong.textContent = fileName;
      const pathSpan = document.createElement("span");
      pathSpan.className = "mono";
      pathSpan.textContent = walletPath;
      metaEl.replaceChildren(
        "Wallet: ", strong,
        document.createElement("br"),
        "Path: ", pathSpan,
      );
    } else {
      metaEl.replaceChildren();
    }
  }
  if (hintEl) setText(hintEl, message || "Enter your wallet password to unlock this wallet.");
  $("unlockOverlay")?.classList.remove("hidden");
  $("unlockPassword")?.focus?.();

  // Play cyberpunk unlock sound (fire-and-forget)
  try {
    const audio = new Audio("./assets/cyberpunk.mp3");
    audio.volume = 0.7;
    audio.play().catch(() => {});
  } catch { /* audio is optional */ }

  // Kick off neural canvas if available (fire-and-forget)
  import("./neural-canvas.js")
    .then(({ initNeuralCanvas, startNeural }) => {
      const canvas = $("neuralCanvas");
      if (canvas) {
        initNeuralCanvas(canvas);
        startNeural();
      }
    })
    .catch(() => { /* neural canvas is optional eye-candy */ });
}

export function clearWalletHistoryState() {
  state.knownIncomeTxs.clear();
  state.historyInitialized = false;
  state.historyPage = 0;
  const root = $("history");
  if (root) root.replaceChildren(makeHint("No transactions (or not synced yet)."));
  updateHistoryPager(0, false);
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export async function walletRpc(method, params) {
  const st = await window.zano.simplewalletState().catch(() => null);
  if (st?.status !== "running") {
    throw new Error("Wallet backend is not running yet.");
  }
  log.info("→", method);
  const res = await window.zano.walletRpc({ method, params });
  if (!res?.ok) {
    log.warn("RPC error:", method, res?.error);
    throw new Error(res?.error || "Wallet RPC error");
  }
  log.debug("←", method, "ok");
  return res.data;
}

// ---------------------------------------------------------------------------
// Asset whitelist
// ---------------------------------------------------------------------------

export async function ensureAssetWhitelisted(assetId) {
  const wl = await walletRpc("assets_whitelist_get", {});
  const lists = [
    ...(wl?.result?.global_whitelist ?? []),
    ...(wl?.result?.local_whitelist ?? []),
    ...(wl?.result?.own_assets ?? []),
  ];
  if (lists.some(d => d.asset_id === assetId)) return;
  await walletRpc("assets_whitelist_add", { asset_id: assetId });
}

// ---------------------------------------------------------------------------
// Simplewallet binary
// ---------------------------------------------------------------------------

export async function resolveExePath() {
  const cfg = await window.zano.configGet();
  const override = (cfg.simplewalletExePath || "").trim() || null;
  return window.zano.simplewalletResolveExe(override);
}

/**
 * Show the "Locate simplewallet" button only when the binary cannot be found
 * automatically — i.e. it wasn't bundled or hasn't been pointed to by the user.
 */
export async function refreshLocateButtonVis() {
  const result = await resolveExePath().catch(() => null);
  const btn = $("btnLocateSimplewallet");
  if (btn) btn.hidden = Boolean(result?.resolved);
}

export async function locateSimplewallet() {
  const res = await window.zano.openFileDialog({ properties: ["openFile"] });
  const p = res?.filePaths?.[0];
  if (!p) return null;
  await window.zano.configSet({ simplewalletExePath: p });
  return p;
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

export async function startWalletRpc(passwordOverride) {
  clearWalletHistoryState();
  // Consume startup cache (pre-resolved during unlock screen display), falling
  // back to fresh async calls if the cache missed or prewarm didn't finish yet.
  const cache    = _startupCache;
  _startupCache  = null;
  const cfg      = cache?.cfg      ?? await window.zano.configGet();
  const password = passwordOverride ?? getSessionPassword() ?? $("inputPassword")?.value ?? "";

  let walletFile = $("inputWalletFile")?.value?.trim() || "";
  if (!walletFile) {
    const defaultWalletPath = await getDefaultWalletPath();
    walletFile = (cfg.lastWalletPath || "").trim() || defaultWalletPath;
  }

  const logEl = $("logArea");
  if (logEl) logEl.textContent = "";

  if (!password) {
    appendLog(logEl, "Enter your wallet password first.");
    return;
  }
  if (!walletFile) {
    appendLog(logEl, "Enter a wallet file path first.");
    return;
  }

  appendLog(logEl, `Starting simplewallet RPC on ${cfg.walletRpcBindIp}:${cfg.walletRpcBindPort}…`);
  log.info("starting RPC for", walletFile);

  const resolved = cache?.resolved ?? await resolveExePath();
  appendLog(logEl, `simplewallet: ${resolved.resolved || "(not found)"}`);
  if (!resolved.resolved && Array.isArray(resolved.candidates)) {
    appendLog(logEl, `Tried:\n- ${resolved.candidates.join("\n- ")}`);
  }

  const result = await window.zano.simplewalletStart({
    walletFile,
    password,
    daemonAddress:      cfg.daemonAddress,
    rpcBindIp:          cfg.walletRpcBindIp,
    rpcBindPort:        cfg.walletRpcBindPort,
    simplewalletExePath: (cfg.simplewalletExePath || "").trim() || undefined,
  });

  if (result?.stopped) {
    appendLog(logEl, "Stop requested.");
    return result;
  }
  return result;
}

export async function stopWalletRpc() {
  log.info("stopping RPC");
  await window.zano.simplewalletStop();
}

// ---------------------------------------------------------------------------
// Balance display
// ---------------------------------------------------------------------------

function populateBalanceMaps(balances) {
  state.balancesById.clear();
  state.assetsById.clear();
  for (const b of balances) {
    const ai = b.asset_info || {};
    let assetId = ai.asset_id || "";
    if (!assetId) continue;

    // Ticker-based fallback: if the RPC returns fUSD under a different
    // asset_id than the hardcoded constant, map it to the canonical id so
    // the rest of the UI finds it under FUSD_ASSET_ID.
    const ticker = ai.ticker || KNOWN_ASSETS[assetId]?.ticker || "ASSET";
    if (ticker === "fUSD" && assetId !== FUSD_ASSET_ID) {
      log.info("fUSD asset_id remapped:", assetId, "->", FUSD_ASSET_ID);
      assetId = FUSD_ASSET_ID;
    }

    const dp = typeof ai.decimal_point === "number" ? ai.decimal_point : 12;
    const fullName = ai.full_name || ticker;
    state.assetsById.set(assetId, { ticker, fullName, decimalPoint: dp });
    try {
      state.balancesById.set(assetId, {
        totalAtomic:      BigInt(b.total ?? 0),
        unlockedAtomic:   BigInt(b.unlocked ?? 0),
        awaitingInAtomic: BigInt(b.awaiting_in ?? 0),
        awaitingOutAtomic:BigInt(b.awaiting_out ?? 0),
        assetInfo:        ai,
      });
    } catch { /* skip malformed entries */ }
  }
  for (const [id, ka] of Object.entries(KNOWN_ASSETS)) {
    if (!state.assetsById.has(id)) {
      state.assetsById.set(id, { ticker: ka.ticker, fullName: ka.fullName ?? ka.ticker, decimalPoint: ka.decimalPoint });
    }
  }
  const zanoBal = state.balancesById.get(ZANO_ASSET_ID);
  state.lastZanoUnlockedAtomic = zanoBal?.unlockedAtomic ?? null;
  state.lastZanoTotalAtomic    = zanoBal?.totalAtomic ?? null;
}

/** Returns logo URL for known assets, or null for unknowns (placeholder). */
function getAssetLogoUrl(assetId) {
  if (assetId === FUSD_ASSET_ID) return FUSD_LOGO_URL;
  if (assetId === ZANO_ASSET_ID) return ZANO_LOGO_URL;
  return null;
}

/** Build one option row: icon + label + radio. */
function createOptionRow(option, selected, onSelect) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "assetOption" + (selected ? " selected" : "");
  row.setAttribute("data-value", option.value);

  const iconEl = option.logoUrl
    ? Object.assign(document.createElement("img"), { src: option.logoUrl, alt: "", className: "assetOptionIcon" })
    : Object.assign(document.createElement("span"), { textContent: "Z", className: "assetOptionIcon zanoPlaceholder" });
  const labelEl = document.createElement("span");
  labelEl.className = "assetOptionLabel";
  labelEl.textContent = option.label;
  const radioEl = document.createElement("span");
  radioEl.className = "assetOptionRadio";

  row.append(iconEl, labelEl, radioEl);
  row.addEventListener("click", () => onSelect(option.value));
  return row;
}

/** Build trigger content: icon + label for current selection. */
function renderTriggerContent(trigger, option) {
  trigger.replaceChildren();
  if (option.logoUrl) {
    const img = document.createElement("img");
    img.src = option.logoUrl;
    img.alt = "";
    img.className = "assetTriggerIcon";
    trigger.appendChild(img);
  } else {
    const span = document.createElement("span");
    span.className = "assetTriggerIcon zanoPlaceholder";
    span.textContent = "Z";
    trigger.appendChild(span);
  }
  const label = document.createElement("span");
  label.className = "assetTriggerLabel";
  label.textContent = option.label;
  trigger.appendChild(label);
}

/** Build custom asset dropdown (balance/send: asset list; history: All/ZANO/fUSD). */
function buildAssetDropdown(wrapperEl) {
  if (!wrapperEl || wrapperEl.tagName === "SELECT") return;
  const id = wrapperEl.id;
  const isHistory = id === "historyAssetFilter";
  const isSend = id === "sendAssetSelect";

  const options = [];
  if (isHistory) {
    options.push({ value: "all", label: "All", logoUrl: null });
    options.push({
      value: ZANO_ASSET_ID,
      label: "Zano",
      logoUrl: null,
    });
    options.push({
      value: FUSD_ASSET_ID,
      label: "Freedom Dollar (fUSD)",
      logoUrl: FUSD_LOGO_URL,
    });
  } else {
    const ids = new Set([...state.balancesById.keys(), ...Object.keys(KNOWN_ASSETS)]);
    for (const assetId of ids) {
      const info = state.assetsById.get(assetId) || KNOWN_ASSETS[assetId] || {};
      const fullName = info.fullName || info.ticker || assetId.slice(0, 8);
      const ticker = info.ticker || "ASSET";
      const dp = info.decimalPoint ?? 12;
      const entry = state.balancesById.get(assetId);
      const amount = entry ? atomicToDisplayString(entry.unlockedAtomic, dp) : "0";
      options.push({
        value: assetId,
        label: `${fullName} (${amount} ${ticker})`,
        logoUrl: getAssetLogoUrl(assetId),
      });
    }
  }

  const currentValue = isHistory ? (state.historyAssetFilter || "all") : state.selectedAssetId;
  const currentOption = options.find((o) => o.value === currentValue) || options[0];

  wrapperEl.className = "assetDropdownWrapper";
  wrapperEl.replaceChildren();

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "assetDropdownTrigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  renderTriggerContent(trigger, currentOption);

  const panel = document.createElement("div");
  panel.className = "assetDropdownPanel";
  panel.setAttribute("role", "listbox");
  panel.hidden = true;
  function setSelectedInPanel(value) {
    panel.querySelectorAll(".assetOption").forEach((row) => {
      row.classList.toggle("selected", row.getAttribute("data-value") === value);
    });
  }
  for (const opt of options) {
    panel.appendChild(createOptionRow(opt, opt.value === currentValue, (value) => {
      if (isHistory) {
        state.historyAssetFilter = value;
        setSelectedInPanel(value);
        trigger.setAttribute("aria-expanded", "false");
        panel.hidden = true;
        const chosen = options.find((o) => o.value === value);
        if (chosen) renderTriggerContent(trigger, chosen);
        wrapperEl.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        state.selectedAssetId = value;
        setSelectedInPanel(value);
        trigger.setAttribute("aria-expanded", "false");
        panel.hidden = true;
        const chosen = options.find((o) => o.value === value);
        if (chosen) renderTriggerContent(trigger, chosen);
        wrapperEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }));
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !panel.hidden;
    panel.hidden = open;
    trigger.setAttribute("aria-expanded", String(!open));
  });

  function close(e) {
    if (e && wrapperEl.contains(e.target)) return;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", close);
  }
  document.addEventListener("click", close);
  wrapperEl._dropdownClose = () => document.removeEventListener("click", close);

  wrapperEl.appendChild(trigger);
  wrapperEl.appendChild(panel);
}

export function populateAssetSelector(selectOrWrapperEl) {
  if (!selectOrWrapperEl) return;
  if (selectOrWrapperEl.tagName === "SELECT") {
    const prev = selectOrWrapperEl.value;
    selectOrWrapperEl.replaceChildren();
    const ids = new Set([...state.balancesById.keys(), ...Object.keys(KNOWN_ASSETS)]);
    for (const id of ids) {
      const info = state.assetsById.get(id) || KNOWN_ASSETS[id] || {};
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = info.ticker || id.slice(0, 8);
      selectOrWrapperEl.appendChild(opt);
    }
    if ([...ids].includes(prev)) selectOrWrapperEl.value = prev;
    else selectOrWrapperEl.value = state.selectedAssetId;
    return;
  }
  if (selectOrWrapperEl._dropdownClose) {
    selectOrWrapperEl._dropdownClose();
    selectOrWrapperEl._dropdownClose = null;
  }
  buildAssetDropdown(selectOrWrapperEl);
}

const HEADER_SNAPSHOT_LS_KEY = "zano_wallet_header_snapshot";

export function renderHeaderBalance() {
  const totalEl   = $("totalUsdBalance");
  const zanoAmtEl = $("breakdownZanoAmt");
  const zanoPctEl = $("breakdownZanoChange");
  const fusdRow   = $("breakdownFusd");
  const fusdAmtEl = $("breakdownFusdAmt");
  if (!totalEl) return;

  // Prefer the decimal_point reported by the RPC (state.assetsById) over the
  // hardcoded KNOWN_ASSETS value — the RPC value is the on-chain ground truth.
  const zanoDp = state.assetsById.get(ZANO_ASSET_ID)?.decimalPoint
              ?? KNOWN_ASSETS[ZANO_ASSET_ID]?.decimalPoint ?? 12;
  const fusdDp = state.assetsById.get(FUSD_ASSET_ID)?.decimalPoint
              ?? KNOWN_ASSETS[FUSD_ASSET_ID]?.decimalPoint ?? 12;

  const zanoEntry = state.balancesById.get(ZANO_ASSET_ID);
  const fusdEntry = state.balancesById.get(FUSD_ASSET_ID);

  const zanoDisplayStr = zanoEntry
    ? atomicToDisplayString(zanoEntry.totalAtomic, zanoDp)
    : "0";
  const fusdDisplayStr = fusdEntry
    ? atomicToDisplayString(fusdEntry.totalAtomic, fusdDp)
    : "0";

  const zanoNum = parseFloat(zanoDisplayStr) || 0;
  const fusdNum = parseFloat(fusdDisplayStr) || 0;

  const prices = state.usdPrices;
  const zanoPriceUsd = prices?.ZANO?.usd ?? null;
  const changePct24  = prices?.ZANO?.changePct24 ?? null;

  // total_usd = (ZANO_balance * ZANO_price) + FUSD_balance (1:1 USD)
  // Show total even when price API fails if we still have an fUSD balance.
  const zanoUsd = zanoPriceUsd != null ? zanoNum * zanoPriceUsd : null;
  let totalUsdDisplay = "—";
  if (zanoUsd != null) {
    totalUsdDisplay = formatUsd(zanoUsd + fusdNum);
    setText(totalEl, totalUsdDisplay);
  } else if (fusdNum > 0) {
    totalUsdDisplay = formatUsd(fusdNum);
    setText(totalEl, totalUsdDisplay);
  } else {
    setText(totalEl, "—");
  }

  if (zanoAmtEl) {
    setText(zanoAmtEl, zanoEntry ? `${zanoDisplayStr} ZANO` : "— ZANO");
  }

  if (zanoPctEl) {
    if (changePct24 != null) {
      const sign = changePct24 >= 0 ? "+" : "";
      zanoPctEl.textContent = `${sign}${changePct24.toFixed(2)}%`;
      zanoPctEl.className = "changePct " + (changePct24 >= 0 ? "pctUp" : "pctDown");
    } else {
      zanoPctEl.textContent = "";
      zanoPctEl.className = "changePct";
    }
  }

  if (fusdRow && fusdAmtEl) {
    if (fusdNum > 0) {
      setText(fusdAmtEl, `${fusdDisplayStr} fUSD`);
      fusdRow.style.display = "";
    } else {
      fusdRow.style.display = "none";
    }
  }

  // Persist a lightweight snapshot so we can show something immediately on
  // next launch before the backend finishes loading.
  try {
    const snapshot = {
      totalUsd: totalUsdDisplay,
      zano: zanoEntry ? `${zanoDisplayStr} ZANO` : null,
      fusd: fusdNum > 0 ? `${fusdDisplayStr} fUSD` : null,
      hasFusd: fusdNum > 0,
      ts: Date.now(),
    };
    localStorage.setItem(HEADER_SNAPSHOT_LS_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore storage errors
  }
}

export function renderHeaderBalanceFromCache() {
  const totalEl   = $("totalUsdBalance");
  const zanoAmtEl = $("breakdownZanoAmt");
  const fusdRow   = $("breakdownFusd");
  const fusdAmtEl = $("breakdownFusdAmt");
  if (!totalEl) return;
  try {
    const raw = localStorage.getItem(HEADER_SNAPSHOT_LS_KEY);
    if (!raw) return;
    const snap = JSON.parse(raw);
    if (!snap || typeof snap !== "object") return;
    if (snap.totalUsd) setText(totalEl, snap.totalUsd);
    if (zanoAmtEl && snap.zano) setText(zanoAmtEl, snap.zano);
    if (fusdRow && fusdAmtEl) {
      if (snap.hasFusd && snap.fusd) {
        setText(fusdAmtEl, snap.fusd);
        fusdRow.style.display = "";
      } else {
        fusdRow.style.display = "none";
      }
    }
  } catch {
    // ignore cache issues
  }
}

function formatUsd(n) {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderBalances(balances) {
  const root = $("balances");
  if (!root) return;
  if (!balances?.length) {
    root.replaceChildren(makeHint("No balances (or wallet not started yet)."));
    return;
  }
  const tmpl = document.getElementById("tmplAssetCard")?.content;
  root.replaceChildren();
  for (const b of balances) {
    const ai          = b.asset_info || {};
    const assetId     = ai.asset_id || "";
    const ticker      = ai.ticker || KNOWN_ASSETS[assetId]?.ticker || (assetId === ZANO_ASSET_ID ? "ZANO" : "ASSET");
    const dp          = typeof ai.decimal_point === "number" ? ai.decimal_point : 12;
    const total       = b.total       ?? 0;
    const unlocked    = b.unlocked    ?? 0;
    const awaitingIn  = b.awaiting_in  ?? 0;
    const awaitingOut = b.awaiting_out ?? 0;
    const el = tmpl.cloneNode(true).firstElementChild;
    el.querySelector(".assetName").textContent = ticker;
    el.querySelector(".assetMeta").textContent = assetId;
    const vals = el.querySelectorAll(".assetNums .v");
    vals[0].textContent = atomicToZanoString(unlocked,    dp);
    vals[1].textContent = atomicToZanoString(total,       dp);
    vals[2].textContent = atomicToZanoString(awaitingIn,  dp);
    vals[3].textContent = atomicToZanoString(awaitingOut, dp);
    root.appendChild(el);
  }
}

export function renderHistory(result) {
  const root = $("history");
  if (!root) return;
  const transfers = result?.transfers || [];
  const curHeight = result?.pi?.curent_height ?? result?.pi?.current_height ?? null;

  if (!transfers.length) {
    root.replaceChildren(makeHint("No transactions (or not synced yet)."));
    return;
  }
  const tmpl = document.getElementById("tmplTxCard")?.content;
  root.replaceChildren();
  for (const t of transfers) {
    let confirmations = typeof t.confirmations === "number" ? t.confirmations : null;
    if (confirmations == null) {
      const heightRaw = t.height;
      const hasHeight = typeof heightRaw === "number" && heightRaw > 0;
      if (hasHeight && curHeight != null) {
        confirmations = Math.max(0, Number(curHeight) - Number(heightRaw));
      } else {
        confirmations = 0;
      }
    }
    const isPending = confirmations < CONFIRMATION_THRESHOLD;
    const subs      = Array.isArray(t.subtransfers) ? t.subtransfers : [];

    const displaySubs = subs;
    const primarySub = displaySubs[0] || {};
    const isIncome   = primarySub.is_income ?? false;

    const amountParts = displaySubs.map(s => {
      const aid = s.asset_id || "";
      const subInfo = state.assetsById.get(aid) || KNOWN_ASSETS[aid] || {};
      const subTicker = subInfo.ticker || aid.slice(0, 8);
      const subDp = subInfo.decimalPoint ?? 12;
      return `${atomicToDisplayString(s.amount ?? 0, subDp)} ${subTicker}`;
    });

    const ts = t.timestamp
      ? new Date(Number(t.timestamp) * 1000).toLocaleString(undefined, {
          year: "2-digit",
          month: "2-digit",
          day: "2-digit",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })
      : "";
    const statusLabel = isIncome ? "Received" : "Sent";
    const txHash      = t.tx_hash || "";
    const confCount   = confirmations ?? 0;
    const confDisplay = Math.min(confCount, CONFIRMATION_THRESHOLD);
    const confLabel   = confCount >= CONFIRMATION_THRESHOLD
      ? `Confirmations ${CONFIRMATION_THRESHOLD}+ (confirmed)`
      : `Confirmations ${confDisplay}/${CONFIRMATION_THRESHOLD}`;
    const paymentId   = t.payment_id || "";
    const explorerUrl = txHash ? `${EXPLORER_TX_URL}${txHash}` : "";

    const el = tmpl.cloneNode(true).firstElementChild;
    const dirEl = el.querySelector(".txDir");
    dirEl.textContent = isIncome ? "↓" : "↑";
    dirEl.classList.add(isIncome ? "in" : "out");
    el.querySelector(".txAmount").textContent = amountParts.join(" + ");
    const timeEl = el.querySelector(".txTime");
    if (timeEl) timeEl.textContent = ts;
    el.querySelector(".txMeta").textContent   = statusLabel;
    const circleEl = el.querySelector(".confCircle");
    circleEl.classList.add(isPending ? "pending" : "done");
    circleEl.title = confLabel;
    el.querySelector(".confLabel").textContent = `${confDisplay}/${CONFIRMATION_THRESHOLD}`;
    const hintEl = el.querySelector(".txHint");
    if (hintEl) hintEl.replaceChildren();
    // Timestamp is displayed on the top line now; keep hint line only for
    // optional Payment ID link.
    if (hintEl && paymentId && explorerUrl) {
      const a = document.createElement("a");
      a.href = explorerUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = paymentId;
      hintEl.appendChild(a);
    }
    const hashEl = el.querySelector(".hash");
    const displayHash = txHash ? txHash.slice(0, 13) + (txHash.length > 13 ? "…" : "") : "";
    if (txHash && explorerUrl) {
      const a = document.createElement("a");
      a.href = explorerUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = displayHash;
      hashEl.appendChild(a);
    } else {
      hashEl.textContent = displayHash;
    }

    const showCopyToast = (btn, text) => {
      const toast = document.createElement("span");
      toast.className = "copyToast";
      toast.textContent = text;
      btn.appendChild(toast);
      toast.addEventListener("animationend", () => toast.remove());
    };
    el.querySelector(".btnCopyHash")?.addEventListener("click", (e) => {
      navigator.clipboard.writeText(txHash).catch(() => {});
      showCopyToast(e.currentTarget, "Copied!");
    });
    el.querySelector(".btnCopyExplorerUrl")?.addEventListener("click", (e) => {
      navigator.clipboard.writeText(explorerUrl).catch(() => {});
      showCopyToast(e.currentTarget, "URL copied!");
    });

    root.appendChild(el);
  }
}

export function updateHistoryPager(page, hasNext) {
  const label = $("historyPageLabel");
  const prev  = $("btnHistoryPrev");
  const next  = $("btnHistoryNext");
  if (!label || !prev || !next) return;
  label.textContent = `Page ${page + 1}`;
  prev.disabled = page <= 0;
  next.disabled = !hasNext;
  prev.tabIndex = prev.disabled ? -1 : 0;
  next.tabIndex = next.disabled ? -1 : 0;
  prev.setAttribute("aria-disabled", String(prev.disabled));
  next.setAttribute("aria-disabled", String(next.disabled));
}

export function updateSendDialogBalances() {
  const totalEl    = $("sendBalanceTotal");
  const unlockedEl = $("sendBalanceUnlocked");
  const maxEl      = $("sendBalanceMax");
  const feeEl      = $("sendFeeReserve");
  if (!totalEl || !unlockedEl || !maxEl) return;

  const id = state.selectedAssetId;
  const entry = state.balancesById.get(id);
  const info = state.assetsById.get(id) || KNOWN_ASSETS[id] || {};
  const ticker = info.ticker || "ASSET";
  const dp = info.decimalPoint ?? 12;

  if (!entry) {
    setText(totalEl, "—"); setText(unlockedEl, "—"); setText(maxEl, "—");
    if (feeEl) setText(feeEl, "");
    return;
  }

  const max = getMaxSendableAtomic(id);
  setText(totalEl,    `${atomicToDisplayString(entry.totalAtomic, dp)} ${ticker}`);
  setText(unlockedEl, `${atomicToDisplayString(entry.unlockedAtomic, dp)} ${ticker}`);
  setText(maxEl, max != null ? `${atomicToDisplayString(max, dp)} ${ticker}` : "—");

  if (feeEl) {
    if (id !== ZANO_ASSET_ID) {
      const zanoBal = state.balancesById.get(ZANO_ASSET_ID);
      const zanoUnlocked = zanoBal?.unlockedAtomic ?? 0n;
      setText(feeEl, `ZANO fee reserve: ${atomicToDisplayString(zanoUnlocked, 12)} ZANO`);
    } else {
      setText(feeEl, "");
    }
  }
}

// ---------------------------------------------------------------------------
// Refresh helpers
// ---------------------------------------------------------------------------

export async function refreshBalance() {
  const res      = await walletRpc("getbalance", {});
  const balances = res?.result?.balances || [];
  populateBalanceMaps(balances);
  renderHeaderBalance();
  if ($("balances")) renderBalances(balances);

  // If fUSD isn't in the balance response, re-attempt whitelisting so it
  // appears on the next refresh. This handles the case where the initial
  // whitelist call during startup failed because the RPC wasn't ready yet.
  if (!state.balancesById.has(FUSD_ASSET_ID)) {
    ensureAssetWhitelisted(FUSD_ASSET_ID).catch(() => {});
  }
}

export async function refreshHistory(page = state.historyPage) {
  state.historyPage = page;
  const res = await walletRpc("get_recent_txs_and_info2", {
    count:              HISTORY_PAGE_SIZE,
    offset:             page * HISTORY_PAGE_SIZE,
    order:              "FROM_END_TO_BEGIN",
    exclude_mining_txs: true,
    exclude_unconfirmed: false,
    update_provision_info: true,
  });
  const result    = res?.result;
  const transfers = result?.transfers || [];
  const hasNext   = transfers.length === HISTORY_PAGE_SIZE;

  // "New income" detection:
  // - Must trigger even for unconfirmed txs.
  // - Should trigger when a *new* incoming transfer is first observed by the UI,
  //   including the first time it appears after unlock.
  const LS_LAST_INCOME_TS_KEY = "zano_wallet_last_income_ts";
  let lastIncomeTs = 0;
  try {
    const v = Number(localStorage.getItem(LS_LAST_INCOME_TS_KEY));
    lastIncomeTs = Number.isFinite(v) ? v : 0;
  } catch { /* ignore */ }
  // If we have no baseline yet, treat "recent" incoming txs as new (avoids
  // missing the user's first test payment on a fresh install).
  if (!lastIncomeTs) lastIncomeTs = Math.floor(Date.now() / 1000) - 120;

  let hasNewIncome = false;
  let maxIncomeTs = 0;
  for (const t of transfers) {
    const subs      = Array.isArray(t.subtransfers) ? t.subtransfers : [];
    const hasIncome = subs.some((s) => s.is_income);
    if (!hasIncome) continue;
    const hash = t.tx_hash
      || `pending:${t.payment_id ?? ""}:${t.timestamp ?? ""}:${subs.map((s) => `${s.amount ?? ""}_${s.is_income}`).join(",")}`;
    if (!state.knownIncomeTxs.has(hash)) {
      state.knownIncomeTxs.add(hash);
      const ts = Number(t.timestamp) || 0;
      // Some unconfirmed/mempool transfers may not have a reliable timestamp.
      // Treat "timestamp missing/0" as new so the UI still reacts immediately.
      if ((ts && ts > lastIncomeTs) || ts === 0) hasNewIncome = true;
    }
    const ts = Number(t.timestamp) || 0;
    if (ts && ts > maxIncomeTs) maxIncomeTs = ts;
  }
  if (!state.historyInitialized) state.historyInitialized = true;
  if (hasNewIncome) {
    playReceiveSound();
    try {
      const target = document.getElementById("app") || document.getElementById("walletView");
      if (target) {
        target.classList.remove("recvGlow");
        // Force reflow so repeated receives retrigger animation.
        void target.offsetWidth;
        target.classList.add("recvGlow");
      }
    } catch { /* ignore */ }
  }
  if (maxIncomeTs) {
    try { localStorage.setItem(LS_LAST_INCOME_TS_KEY, String(maxIncomeTs)); } catch {}
  }
  renderHistory(result);
  updateHistoryPager(page, hasNext);
}

// ---------------------------------------------------------------------------
// Address / QR
// ---------------------------------------------------------------------------

export async function showBaseAddress() {
  const res  = await walletRpc("getaddress", {});
  const addr = res?.result?.address;
  if (addr && $("myAddress")) $("myAddress").value = addr;
  return addr || null;
}

export async function makeIntegrated() {
  const res        = await walletRpc("make_integrated_address", {});
  const integrated = res?.result?.integrated_address || res?.result?.address || res?.result || "";
  if (integrated && $("recvAddress")) {
    $("recvAddress").value = integrated;
    await renderReceiveQr(integrated);
  }
}

export async function renderReceiveQr(address) {
  const img = $("recvQr");
  const wrap = img?.closest(".qrWrap");
  if (!img) return;
  const a = String(address || "").trim();
  if (!a) { img.removeAttribute("src"); return; }

  // Show shimmer placeholder while loading
  img.classList.add("loading");
  if (wrap) wrap.classList.add("loading");

  const res = await window.zano.walletQr(a);
  if (res?.ok && res.dataUrl) {
    img.src = res.dataUrl;
    img.onload = () => {
      img.classList.remove("loading");
      if (wrap) wrap.classList.remove("loading");
    };
  } else {
    img.classList.remove("loading");
    if (wrap) wrap.classList.remove("loading");
  }
}

// ---------------------------------------------------------------------------
// Settings dialog helpers
// ---------------------------------------------------------------------------

function getNodeDropdownValue(wrapperEl) {
  if (!wrapperEl) return null;
  return wrapperEl.getAttribute("data-value") || null;
}

function buildNodeDropdown(wrapperEl, currentAddr) {
  if (!wrapperEl) return;
  if (wrapperEl._dropdownClose) {
    wrapperEl._dropdownClose();
    wrapperEl._dropdownClose = null;
  }

  const options = [
    ...KNOWN_NODES.map((n) => ({
      value: n.address,
      label: `${n.label} (${n.address})`,
      logoUrl: null,
    })),
    { value: "custom", label: "Custom…", logoUrl: null },
  ];

  const knownMatch = KNOWN_NODES.find((n) => n.address === currentAddr);
  const currentValue = knownMatch ? currentAddr : "custom";
  const currentOption = options.find((o) => o.value === currentValue) || options[0];

  wrapperEl.className = "assetDropdownWrapper";
  wrapperEl.replaceChildren();
  wrapperEl.setAttribute("data-value", currentValue);

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "assetDropdownTrigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  renderTriggerContent(trigger, currentOption);

  const panel = document.createElement("div");
  panel.className = "assetDropdownPanel";
  panel.setAttribute("role", "listbox");
  panel.hidden = true;

  function setSelected(value) {
    wrapperEl.setAttribute("data-value", value);
    panel.querySelectorAll(".assetOption").forEach((row) => {
      row.classList.toggle("selected", row.getAttribute("data-value") === value);
    });
    const chosen = options.find((o) => o.value === value);
    if (chosen) renderTriggerContent(trigger, chosen);
  }

  for (const opt of options) {
    panel.appendChild(createOptionRow(opt, opt.value === currentValue, (value) => {
      setSelected(value);
      trigger.setAttribute("aria-expanded", "false");
      panel.hidden = true;
      wrapperEl.dispatchEvent(new Event("change", { bubbles: true }));
    }));
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !panel.hidden;
    panel.hidden = open;
    trigger.setAttribute("aria-expanded", String(!open));
  });

  function close(e) {
    if (e && wrapperEl.contains(e.target)) return;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", close);
  }
  document.addEventListener("click", close);
  wrapperEl._dropdownClose = () => document.removeEventListener("click", close);

  wrapperEl.appendChild(trigger);
  wrapperEl.appendChild(panel);
}

function syncDaemonFieldWithNodeSelect() {
  const selWrap = $("cfgNodeSelect");
  const daemon = $("cfgDaemon");
  if (!selWrap || !daemon) return;

  const v = getNodeDropdownValue(selWrap);
  if (v === "custom") {
    daemon.disabled = false;
    return;
  }
  if (typeof v === "string" && v.trim()) {
    daemon.value = v;
    daemon.disabled = true;
  }
}

export async function loadSettingsIntoDialog() {
  const cfg      = await window.zano.configGet();
  const daemon   = $("cfgDaemon");
  const bindIp   = $("cfgBindIp");
  const bindPort = $("cfgBindPort");
  const sel      = $("cfgNodeSelect");

  if (sel) {
    const currentAddr = cfg.daemonAddress || DEFAULT_DAEMON_ADDRESS;
    buildNodeDropdown(sel, currentAddr);
    sel.onchange = syncDaemonFieldWithNodeSelect;
  }

  if (daemon) {
    daemon.placeholder = DEFAULT_DAEMON_ADDRESS;
    daemon.value = cfg.daemonAddress || "";
    syncDaemonFieldWithNodeSelect();
  }
  if (bindIp) {
    bindIp.placeholder = DEFAULT_RPC_BIND_IP;
    bindIp.value = cfg.walletRpcBindIp || "";
  }
  if (bindPort) {
    bindPort.placeholder = String(DEFAULT_RPC_BIND_PORT);
    bindPort.value = cfg.walletRpcBindPort || "";
  }
  const exe = $("cfgExe");
  if (exe) {
    exe.value = (cfg.simplewalletExePath || "").trim();
  }
  const exolixKey = $("cfgExolixKey");
  if (exolixKey) {
    exolixKey.value = (cfg.exolixApiKey || "").trim();
  }
}

export async function saveSettingsFromDialog() {
  const sel = $("cfgNodeSelect");
  const selected = getNodeDropdownValue(sel);
  const daemonAddress = (selected && selected !== "custom")
    ? selected
    : ($("cfgDaemon").value.trim() || DEFAULT_DAEMON_ADDRESS);

  const partial = {
    daemonAddress,
    walletRpcBindIp:     $("cfgBindIp").value.trim()   || DEFAULT_RPC_BIND_IP,
    walletRpcBindPort:   Number($("cfgBindPort").value) || DEFAULT_RPC_BIND_PORT,
    simplewalletExePath: $("cfgExe").value.trim(),
    exolixApiKey:        ($("cfgExolixKey")?.value || "").trim(),
  };
  await window.zano.configSet(partial);
  log.info("settings saved");
}
