// Protocol constants
export const ATOMIC_UNITS = 1_000_000_000_000n;
export const ZANO_ASSET_ID = "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a";
export const FUSD_ASSET_ID = "86143388bd056a8f0bab669f78f14873fac8e2dd8d57898cdb725a2d5e2e4f8f";
export const FEE_ATOMIC = 10_000_000_000n; // 0.01 ZANO
export const MIXIN = 15;
export const EXPLORER_TX_URL = "https://explorer.zano.org/transaction/";

/** Packaged logos to avoid renderer network fetches for core wallet UI. */
export const FUSD_LOGO_URL = "./assets/fusd.png";
export const ZANO_LOGO_URL = "./assets/zano-logo.png";

export const KNOWN_ASSETS = {
  [ZANO_ASSET_ID]: { ticker: "ZANO", decimalPoint: 12, fullName: "Zano" },
  [FUSD_ASSET_ID]: { ticker: "fUSD", decimalPoint: 12, fullName: "Freedom Dollar" },
};

// Network / RPC defaults — single source of truth for the renderer.
// These mirror main/config.js DEFAULTS; change both if the values ever change.
export const DEFAULT_DAEMON_ADDRESS = "37.27.100.59:10500";

export const KNOWN_NODES = [
  { label: "Zano Official Node (default)", address: "37.27.100.59:10500" },
  { label: "ZanoNova Node", address: "72.62.241.93:11211" },
];
export const DEFAULT_RPC_BIND_IP    = "127.0.0.1";
export const DEFAULT_RPC_BIND_PORT  = 12233;

// UI constants
export const HISTORY_PAGE_SIZE = 20;
export const CONFIRMATION_THRESHOLD = 10;
export const TOOLTIP_DELAY_MS = 3000;
export const AUTO_REFRESH_MS = 15_000;
