// Protocol constants
export const ATOMIC_UNITS = 1_000_000_000_000n;
export const ZANO_ASSET_ID = "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a";
export const FEE_ATOMIC = 10_000_000_000n; // 0.01 ZANO
export const MIXIN = 15;
export const EXPLORER_TX_URL = "https://explorer.zano.org/transaction/";

// Network / RPC defaults — single source of truth for the renderer.
// These mirror main/config.js DEFAULTS; change both if the values ever change.
export const DEFAULT_DAEMON_ADDRESS = "37.27.100.59:10500";
export const DEFAULT_RPC_BIND_IP    = "127.0.0.1";
export const DEFAULT_RPC_BIND_PORT  = 12233;

// UI constants
export const HISTORY_PAGE_SIZE = 5;
export const CONFIRMATION_THRESHOLD = 10;
export const AUDIO_VOLUME = 0.9;
export const TOOLTIP_DELAY_MS = 3000;
export const AUTO_REFRESH_MS = 15_000;
