import { createLogger } from "./logger.js";
import { $, setText } from "./dom.js";
import { state } from "./state.js";
import { TOOLTIP_DELAY_MS } from "./constants.js";

const log = createLogger("ui");

// Module-level tooltip element (singleton)
let _tooltipEl = null;

// View IDs follow the pattern: key + "View"  e.g. "wallet" -> "walletView"
const VIEW_KEYS = ["wallet", "swap", "settings", "security", "welcome", "addWallet", "restoreWallet", "seedBackup"];
const NAV_KEYS  = ["wallet", "swap", "settings", "security"];

export function switchView(which) {
  log.info("view →", which);
  for (const key of VIEW_KEYS) {
    const el = $(key + "View");
    if (!el) continue;
    const wasHidden = el.classList.contains("hidden");
    el.classList.toggle("hidden", key !== which);
    // Re-trigger entrance animation when showing a view
    if (key === which && wasHidden) {
      el.style.animation = "none";
      el.offsetHeight; // force reflow
      el.style.animation = "";
    }
  }
  for (const key of NAV_KEYS) {
    $("nav" + key.charAt(0).toUpperCase() + key.slice(1))?.classList.toggle("active", key === which);
  }
  if (which === "settings") _updateCurrentWalletPathDisplay();
}

async function _updateCurrentWalletPathDisplay() {
  const el = $("currentWalletPathDisplay");
  if (!el) return;
  const path = (state.currentWalletFile || "").trim();
  if (path) {
    el.textContent = path;
    return;
  }
  try {
    const cfg = await window.zano.configGet();
    el.textContent = (cfg?.lastWalletPath || "").trim() || "—";
  } catch {
    el.textContent = "—";
  }
}

export function setStatus(status) {
  const dot  = $("swStatusDot");
  const text = $("swStatusText");
  if (!dot || !text) return;
  dot.classList.remove("ok", "warn", "bad");
  if (status === "running")                             dot.classList.add("ok");
  else if (status === "starting" || status === "stopping") dot.classList.add("warn");
  else if (status === "error"    || status === "stopped")  dot.classList.add("bad");
  setText(text, status);

  // Disable start when backend is already running/starting; disable stop when stopped
  const btnStart = $("btnStartWallet");
  const btnStop  = $("btnStopWallet");
  const busy = status === "running" || status === "starting";
  if (btnStart) btnStart.disabled = busy;
  if (btnStop)  btnStop.disabled  = !busy && status !== "stopping";
}

export function setConnectionStatus({ phase, nodeLabel, subtext, detail = "" }) {
  const label = nodeLabel ? String(nodeLabel) : "node";
  const resolvedSub = phase === "offline" ? (subtext || "—") : (subtext || label);

  function applyTo(prefix) {
    const dot  = $(prefix + "Dot");
    const text = $(prefix + "Text");
    const sub  = $(prefix + "Sub");
    const wrap = $(prefix);
    if (!dot || !text) return;

    dot.classList.remove("ok", "warn", "bad");
    if (wrap) wrap.classList.remove("status-connecting", "status-connected", "status-offline");
    if (wrap) {
      if (detail) wrap.dataset.connDetail = String(detail);
      else delete wrap.dataset.connDetail;
    }

    if (phase === "connected") {
      dot.classList.add("ok");
      if (wrap) wrap.classList.add("status-connected");
      setText(text, "Connected");
      if (sub) setText(sub, resolvedSub);
    } else if (phase === "connecting") {
      dot.classList.add("warn");
      if (wrap) wrap.classList.add("status-connecting");
      setText(text, "Connecting");
      if (sub) setText(sub, resolvedSub);
    } else {
      dot.classList.add("bad");
      if (wrap) wrap.classList.add("status-offline");
      setText(text, "Offline");
      if (sub) setText(sub, resolvedSub);
    }
  }

  // Topbar status
  applyTo("swStatus");
  // Unlock overlay status (if present)
  applyTo("unlockStatus");

  const btnStart = $("btnStartWallet");
  const btnStop  = $("btnStopWallet");
  const busy = phase === "connected" || phase === "connecting";
  if (btnStart) btnStart.disabled = busy;
  if (btnStop)  btnStop.disabled  = !busy;

  setWalletUiGates(phase === "connected");
}

let _walletRpcReady = false;

/**
 * Gate wallet action buttons based on wallet RPC readiness.
 * Send and Refresh require the wallet RPC to be live; Receive is always usable.
 */
export function setWalletUiGates(walletRpcReady) {
  _walletRpcReady = walletRpcReady;
  const send    = $("btnOpenSend");
  const refresh = $("btnRefreshHistory");
  if (send)    send.disabled    = !walletRpcReady;
  if (refresh) refresh.disabled = !walletRpcReady;
}

export function isWalletRpcReady() {
  return _walletRpcReady;
}

/**
 * Disable/enable all elements marked with [data-busy-disable] instead of
 * maintaining a hardcoded ID list.
 */
export function setUiBusy(busy, reason = "") {
  state.uiBusy      = Boolean(busy);
  state.uiBusyReason = reason ? String(reason) : "";
  document.body.classList.toggle("busy", state.uiBusy);
  for (const el of document.querySelectorAll("[data-busy-disable]")) {
    el.disabled = state.uiBusy;
  }
  if (!state.uiBusy) setWalletUiGates(_walletRpcReady);
  const hint = $("swStatusText");
  if (hint && state.uiBusyReason) hint.title = state.uiBusyReason;
}

export function hideTooltipIfVisible() {
  _tooltipEl?.classList.remove("visible");
}

export function setupTooltips() {
  if (_tooltipEl) return;
  _tooltipEl = document.createElement("div");
  _tooltipEl.id = "appTooltip";
  _tooltipEl.className = "tooltipBubble";
  document.body.appendChild(_tooltipEl);

  let timer = null;
  let currentTarget = null;
  let lastX = 0;
  let lastY = 0;

  function show(target) {
    if (!state.tooltipsEnabled) return;
    const text = target?.getAttribute("data-tooltip");
    if (!text) return;
    const rect = target.getBoundingClientRect();
    _tooltipEl.textContent = text;
    const padding = 12;
    const vpWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    let left = (lastX || rect.right) + padding;
    if (left > vpWidth - 260 - padding) left = vpWidth - 260 - padding;
    const top = lastY || rect.top + rect.height / 2;
    _tooltipEl.style.left = `${Math.round(left)}px`;
    _tooltipEl.style.top  = `${Math.round(top)}px`;
    _tooltipEl.classList.add("visible");
  }

  function hide() {
    _tooltipEl.classList.remove("visible");
  }

  document.addEventListener("pointerenter", (e) => {
    if (!e.target?.closest) return;
    const tip = e.target.closest("[data-tooltip]");
    if (!tip) return;
    lastX = e.clientX;
    lastY = e.clientY;
    clearTimeout(timer);
    currentTarget = tip;
    timer = setTimeout(() => { if (currentTarget === tip) show(tip); }, TOOLTIP_DELAY_MS);
  }, true);

  document.addEventListener("pointerleave", (e) => {
    if (!e.target?.closest) return;
    const tip = e.target.closest("[data-tooltip]");
    if (!tip) return;
    clearTimeout(timer);
    if (currentTarget === tip) currentTarget = null;
    hide();
  }, true);

  document.addEventListener("scroll", () => {
    clearTimeout(timer);
    currentTarget = null;
    hide();
  }, true);
}
