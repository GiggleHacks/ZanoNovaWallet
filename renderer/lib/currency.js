import { FEE_ATOMIC, ZANO_ASSET_ID } from "./constants.js";
import { state } from "./state.js";

export function atomicToDisplayString(nAtomic, decimalPoint = 12) {
  try {
    const n = BigInt(nAtomic);
    const sign = n < 0n ? "-" : "";
    const a = n < 0n ? -n : n;
    const divisor = 10n ** BigInt(decimalPoint);
    const whole = a / divisor;
    const frac = a % divisor;
    const fracStrRaw = frac.toString().padStart(decimalPoint, "0").slice(0, decimalPoint);
    const fracStr = fracStrRaw.replace(/0+$/, "");
    if (!fracStr) return `${sign}${whole.toString()}`;
    return `${sign}${whole.toString()}.${fracStr}`;
  } catch {
    return String(nAtomic);
  }
}

export const atomicToZanoString = atomicToDisplayString;

export function parseAmountToAtomic(amountStr, decimalPoint = 12) {
  const s = String(amountStr).trim();
  if (!s) return 0n;
  try {
    const [wholeStr, fracStrRaw = ""] = s.split(".");
    const whole = BigInt(wholeStr || "0");
    const fracStr = (fracStrRaw + "0".repeat(decimalPoint)).slice(0, decimalPoint);
    const frac = BigInt(fracStr || "0");
    return whole * (10n ** BigInt(decimalPoint)) + frac;
  } catch {
    return 0n;
  }
}

export const zanoToAtomic = parseAmountToAtomic;

export function getMaxSendableAtomic(assetId) {
  const id = assetId ?? state.selectedAssetId;
  const entry = state.balancesById.get(id);
  const unlocked = entry?.unlockedAtomic ?? null;
  if (unlocked == null) {
    if (id === ZANO_ASSET_ID && state.lastZanoUnlockedAtomic != null) {
      const m = state.lastZanoUnlockedAtomic - FEE_ATOMIC;
      return m > 0n ? m : 0n;
    }
    return null;
  }
  if (id === ZANO_ASSET_ID) {
    const m = unlocked - FEE_ATOMIC;
    return m > 0n ? m : 0n;
  }
  return unlocked > 0n ? unlocked : 0n;
}
