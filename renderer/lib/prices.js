import { createLogger } from "./logger.js";

const log = createLogger("prices");

const API_URL =
  "https://min-api.cryptocompare.com/data/pricemultifull?fsyms=ZANO,PAXG,BTC,XMR&tsyms=USD";
const LS_KEY = "zano_wallet_last_prices";

let _cached = null;
let _fetched = false;

function parseResponse(json) {
  const raw = json?.RAW;
  if (!raw) return null;
  const out = {};
  for (const sym of Object.keys(raw)) {
    const usdData = raw[sym]?.USD;
    if (!usdData) continue;
    out[sym] = {
      usd: Number(usdData.PRICE) || 0,
      changePct24: usdData.CHANGEPCT24HOUR != null
        ? Number(usdData.CHANGEPCT24HOUR)
        : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

export async function fetchPricesOnce() {
  if (_fetched && _cached) return _cached;

  try {
    const resp = await fetch(API_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const parsed = parseResponse(json);
    if (parsed) {
      _cached = parsed;
      _fetched = true;
      try { localStorage.setItem(LS_KEY, JSON.stringify(parsed)); } catch {}
      log.info("Price data fetched", parsed);
      return parsed;
    }
    throw new Error("Empty parsed result");
  } catch (err) {
    log.warn("Price fetch failed, trying localStorage fallback:", err.message);
    try {
      const stored = localStorage.getItem(LS_KEY);
      if (stored) {
        _cached = JSON.parse(stored);
        _fetched = true;
        log.info("Using cached price data from localStorage");
        return _cached;
      }
    } catch {}
    return null;
  }
}
