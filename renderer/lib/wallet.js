import { createLogger } from "./logger.js";
import { $, setText, appendLog, makeHint } from "./dom.js";
import { state, getSessionPassword } from "./state.js";
import { atomicToZanoString, getMaxSendableAtomic } from "./currency.js";
import {
  ZANO_ASSET_ID,
  HISTORY_PAGE_SIZE,
  CONFIRMATION_THRESHOLD,
  EXPLORER_TX_URL,
  DEFAULT_DAEMON_ADDRESS,
  DEFAULT_RPC_BIND_IP,
  DEFAULT_RPC_BIND_PORT,
} from "./constants.js";
import { playReceiveSound } from "./audio.js";

const log = createLogger("wallet");

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Suggest a non-colliding wallet path inside the default wallets dir. */
export async function suggestWalletPath(filename) {
  const paths = await window.zano.getPaths().catch(() => null);
  if (!paths?.walletsDir) return null;
  return window.zano.suggestNewWalletPath(paths.walletsDir + "/" + filename).catch(() => null);
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
  const cfg      = await window.zano.configGet();
  const password = passwordOverride ?? getSessionPassword() ?? $("inputPassword")?.value ?? "";

  let walletFile = $("inputWalletFile")?.value?.trim() || "";
  if (!walletFile) {
    const paths            = await window.zano.getPaths().catch(() => null);
    const defaultWalletPath = paths?.walletPath ? String(paths.walletPath).trim() : "";
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

  const resolved = await resolveExePath();
  appendLog(logEl, `simplewallet: ${resolved.resolved || "(not found)"}`);
  if (!resolved.resolved && Array.isArray(resolved.candidates)) {
    appendLog(logEl, `Tried:\n- ${resolved.candidates.join("\n- ")}`);
  }

  return window.zano.simplewalletStart({
    walletFile,
    password,
    daemonAddress:      cfg.daemonAddress,
    rpcBindIp:          cfg.walletRpcBindIp,
    rpcBindPort:        cfg.walletRpcBindPort,
    simplewalletExePath: (cfg.simplewalletExePath || "").trim() || undefined,
  });
}

export async function stopWalletRpc() {
  log.info("stopping RPC");
  await window.zano.simplewalletStop();
}

// ---------------------------------------------------------------------------
// Balance display
// ---------------------------------------------------------------------------

export function renderZanoHeaderBalanceFromGetbalance(res) {
  const balances = res?.result?.balances || [];
  const zano  = balances.find((b) => b?.asset_info?.asset_id === ZANO_ASSET_ID) || balances[0] || null;
  const balEl = $("zanoBalance");
  const subEl = $("zanoBalanceSub");
  if (!balEl || !subEl) return;

  if (!zano) {
    state.lastZanoUnlockedAtomic = null;
    state.lastZanoTotalAtomic    = null;
    setText(balEl, "—");
    setText(subEl, "Unlocked: —");
    return;
  }

  const dp = typeof zano?.asset_info?.decimal_point === "number" ? zano.asset_info.decimal_point : 12;
  try { state.lastZanoUnlockedAtomic = BigInt(zano.unlocked ?? 0); } catch { state.lastZanoUnlockedAtomic = null; }
  try { state.lastZanoTotalAtomic    = BigInt(zano.total    ?? 0); } catch { state.lastZanoTotalAtomic    = null; }

  setText(balEl, `${atomicToZanoString(zano.total    ?? 0, dp)} ZANO`);
  setText(subEl, `Unlocked: ${atomicToZanoString(zano.unlocked ?? 0, dp)} ZANO`);
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
    const ticker      = ai.ticker || (assetId === ZANO_ASSET_ID ? "ZANO" : "ASSET");
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
  const curHeight = result?.pi?.curent_height ?? null;
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
    const isPending    = confirmations < CONFIRMATION_THRESHOLD;
    const subs         = Array.isArray(t.subtransfers) ? t.subtransfers : [];
    const native       = subs.find((s) => s.asset_id === ZANO_ASSET_ID) || subs[0] || {};
    const amountAtomic = native.amount ?? 0;
    const isIncome     = native.is_income ?? false;
    const ts           = t.timestamp ? new Date(Number(t.timestamp) * 1000).toLocaleString() : "";
    const statusLabel  = isIncome ? "Received" : "Sent";
    const txHash       = t.tx_hash || "";
    const confCount    = confirmations ?? 0;
    const confDisplay  = Math.min(confCount, CONFIRMATION_THRESHOLD);
    const confLabel    = confCount >= CONFIRMATION_THRESHOLD
      ? `Confirmations ${CONFIRMATION_THRESHOLD}+ (confirmed)`
      : `Confirmations ${confDisplay}/${CONFIRMATION_THRESHOLD}`;
    const paymentId  = t.payment_id || "";
    const explorerUrl = txHash ? `${EXPLORER_TX_URL}${txHash}` : "";

    const el = tmpl.cloneNode(true).firstElementChild;
    const dirEl = el.querySelector(".txDir");
    dirEl.textContent = isIncome ? "↓" : "↑";
    dirEl.classList.add(isIncome ? "in" : "out");
    el.querySelector(".txAmount").textContent = `${atomicToZanoString(amountAtomic)} ZANO`;
    el.querySelector(".txMeta").textContent   = statusLabel;
    const circleEl = el.querySelector(".confCircle");
    circleEl.classList.add(isPending ? "pending" : "done");
    circleEl.title = confLabel;
    el.querySelector(".confLabel").textContent = `${confDisplay}/${CONFIRMATION_THRESHOLD}`;
    // Build hint line: "timestamp · payment_id <link>" without innerHTML
    const hintEl = el.querySelector(".txHint");
    hintEl.append(`${ts} · payment_id `);
    if (paymentId && explorerUrl) {
      const a = document.createElement("a");
      a.href = explorerUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = paymentId;
      hintEl.appendChild(a);
    } else {
      hintEl.append(paymentId || "-");
    }
    el.querySelector(".hash").textContent = txHash;
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
}

export function updateSendDialogBalances() {
  const totalEl    = $("sendBalanceTotal");
  const unlockedEl = $("sendBalanceUnlocked");
  const maxEl      = $("sendBalanceMax");
  if (!totalEl || !unlockedEl || !maxEl) return;
  if (state.lastZanoTotalAtomic == null && state.lastZanoUnlockedAtomic == null) {
    setText(totalEl, "—"); setText(unlockedEl, "—"); setText(maxEl, "—");
    return;
  }
  const total    = state.lastZanoTotalAtomic    ?? state.lastZanoUnlockedAtomic ?? 0n;
  const unlocked = state.lastZanoUnlockedAtomic ?? 0n;
  const max      = getMaxSendableAtomic();
  setText(totalEl,    `${atomicToZanoString(total)} ZANO`);
  setText(unlockedEl, `${atomicToZanoString(unlocked)} ZANO`);
  setText(maxEl, max != null ? `${atomicToZanoString(max)} ZANO` : "—");
}

// ---------------------------------------------------------------------------
// Refresh helpers
// ---------------------------------------------------------------------------

export async function refreshBalance() {
  const res      = await walletRpc("getbalance", {});
  const balances = res?.result?.balances || [];
  renderZanoHeaderBalanceFromGetbalance(res);
  if ($("balances")) renderBalances(balances);
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

  let hasNewIncome = false;
  for (const t of transfers) {
    const subs      = Array.isArray(t.subtransfers) ? t.subtransfers : [];
    const hasIncome = subs.some((s) => s.asset_id === ZANO_ASSET_ID && s.is_income);
    if (!hasIncome) continue;
    const hash = t.tx_hash
      || `pending:${t.payment_id ?? ""}:${t.timestamp ?? ""}:${subs.map((s) => `${s.amount ?? ""}_${s.is_income}`).join(",")}`;
    if (!state.knownIncomeTxs.has(hash)) {
      state.knownIncomeTxs.add(hash);
      if (state.historyInitialized) hasNewIncome = true;
    }
  }
  if (!state.historyInitialized) state.historyInitialized = true;
  if (hasNewIncome) playReceiveSound();
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
  if (!img) return;
  const a = String(address || "").trim();
  if (!a) { img.removeAttribute("src"); return; }
  const res = await window.zano.walletQr(a);
  if (res?.ok && res.dataUrl) img.src = res.dataUrl;
}

// ---------------------------------------------------------------------------
// Settings dialog helpers
// ---------------------------------------------------------------------------

export async function loadSettingsIntoDialog() {
  const cfg      = await window.zano.configGet();
  const daemon   = $("cfgDaemon");
  const bindIp   = $("cfgBindIp");
  const bindPort = $("cfgBindPort");
  // Placeholders show the effective default so users know what a blank field means.
  daemon.placeholder   = DEFAULT_DAEMON_ADDRESS;
  bindIp.placeholder   = DEFAULT_RPC_BIND_IP;
  bindPort.placeholder = String(DEFAULT_RPC_BIND_PORT);
  daemon.value   = cfg.daemonAddress     || "";
  bindIp.value   = cfg.walletRpcBindIp   || "";
  bindPort.value = cfg.walletRpcBindPort || "";
  $("cfgExe").value = (cfg.simplewalletExePath || "").trim();
}

export async function saveSettingsFromDialog() {
  const partial = {
    daemonAddress:       $("cfgDaemon").value.trim()   || DEFAULT_DAEMON_ADDRESS,
    walletRpcBindIp:     $("cfgBindIp").value.trim()   || DEFAULT_RPC_BIND_IP,
    walletRpcBindPort:   Number($("cfgBindPort").value) || DEFAULT_RPC_BIND_PORT,
    simplewalletExePath: $("cfgExe").value.trim(),
  };
  await window.zano.configSet(partial);
  log.info("settings saved");
}
