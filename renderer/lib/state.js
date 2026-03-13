import { createLogger } from "./logger.js";

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

  // Balance (BigInt | null)
  lastZanoUnlockedAtomic: null,
  lastZanoTotalAtomic: null,

  // History
  historyPage: 0,
  historyInitialized: false,
  knownIncomeTxs: new Set(),

  // Audio
  startupSoundPlayed: false,
  soundEnabled: true,
  soundsPrewarmed: false,
  startupAudio: null,
  sendAudio: null,
  receiveAudio: null,

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
