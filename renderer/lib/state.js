import { createLogger } from "./logger.js";
import { ZANO_ASSET_ID } from "./constants.js";

const log = createLogger("state");

// Session password is kept private — only accessible via the getter/setter.
const _private = { sessionPassword: null };

/**
 * All mutable renderer state in one place.
 * Direct property mutation is intentional for simplicity — no reactive framework needed.
 */
export const state = {
  // Wallet identity
  currentWalletFile: "",

  // Multi-asset state
  selectedAssetId: ZANO_ASSET_ID,
  balancesById: new Map(),
  assetsById: new Map(),

  // Balance (BigInt | null) — convenience aliases for ZANO, kept in sync
  lastZanoUnlockedAtomic: null,
  lastZanoTotalAtomic: null,

  // History
  historyPage: 0,
  historyInitialized: false,
  historyAssetFilter: "all",
  hideMiningTxs: true,
  knownIncomeTxs: new Set(),

  // Audio
  startupSoundPlayed: false,
  soundEnabled: true,
  soundVolume: 0.9,
  soundToggles: { startup: true, send: true, receive: true, seed: true },
  soundsPrewarmed: false,
  startupAudio: null,
  sendAudio: null,
  receiveAudio: null,
  seedAudio: null,

  // Prices (populated once per session by fetchPricesOnce)
  usdPrices: null,

  // Send flow
  sendAmountMode: "ASSET", // "ASSET" | "USD" (ZANO only)

  // Sync progress (daemon height for percentage calculation, wallet height from RPC)
  daemonHeight: null,
  walletHeight: null,

  // UI
  uiBusy: false,
  uiBusyReason: "",
  tooltipsEnabled: true,
};

export function getSessionPassword() {
  return _private.sessionPassword;
}

export function setSessionPassword(pwd) {
  log.debug(pwd ? "session password set" : "session password cleared");
  _private.sessionPassword = pwd ?? null;
}
