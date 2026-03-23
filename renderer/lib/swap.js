import { createLogger } from "./logger.js";

const log = createLogger("swap");

const POLL_INTERVAL_MS = 12_000;

function normalizeSwapStatus(status) {
  const raw = String(status || "").trim().toLowerCase();
  if (!raw) return "wait";

  const STATUS_MAP = {
    wait: "wait",
    waiting: "wait",
    confirmation: "confirmation",
    confirming: "confirmation",
    exchanging: "exchanging",
    exchange: "exchanging",
    sending: "sending",
    completed: "success",
    complete: "success",
    success: "success",
    refund: "refund",
    refunding: "refund",
    refunded: "refunded",
    overdue: "overdue",
    expired: "overdue",
    failed: "error",
    error: "error",
    cancelled: "error",
    canceled: "error",
  };

  return STATUS_MAP[raw] || raw;
}

export async function checkHealth() {
  try {
    const data = await window.zano.swapRate({ from: "ZANO", to: "fUSD", amount: 1 });
    log.info("health probe (rate):", data);
    return data?.toAmount != null;
  } catch (err) {
    log.warn("health probe failed:", err.message);
    return false;
  }
}

export async function getRate(fromTicker, toTicker, amount) {
  const data = await window.zano.swapRate({ from: fromTicker, to: toTicker, amount });
  log.info("rate response:", data);
  return data;
}

export async function createExchange(fromTicker, toTicker, amount, withdrawalAddress) {
  const data = await window.zano.swapExchange({ from: fromTicker, to: toTicker, amount, withdrawalAddress });
  log.info("exchange created:", data);
  return data;
}

export async function getExchangeStatus(exchangeId) {
  const data = await window.zano.swapStatus(exchangeId);
  data.status = normalizeSwapStatus(data?.status);
  log.info("exchange status:", data);
  return data;
}

export const TERMINAL_STATUSES = new Set(["success", "overdue", "error", "refund", "refunded"]);

export function pollExchange(exchangeId, onUpdate) {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const data = await getExchangeStatus(exchangeId);
      onUpdate(data);
      if (TERMINAL_STATUSES.has(data.status)) {
        stopped = true;
        return;
      }
    } catch (err) {
      log.warn("poll error:", err.message);
      onUpdate({ status: "error", _pollError: err.message });
      stopped = true;
      return;
    }
    if (!stopped) setTimeout(tick, POLL_INTERVAL_MS);
  }

  setTimeout(tick, 500);
  return () => { stopped = true; };
}
