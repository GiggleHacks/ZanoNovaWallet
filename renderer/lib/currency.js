import { ATOMIC_UNITS, FEE_ATOMIC } from "./constants.js";
import { state } from "./state.js";

export function atomicToZanoString(nAtomic, decimals = 12) {
  try {
    const n = BigInt(nAtomic);
    const sign = n < 0n ? "-" : "";
    const a = n < 0n ? -n : n;
    const whole = a / ATOMIC_UNITS;
    const frac = a % ATOMIC_UNITS;
    const fracStrRaw = frac.toString().padStart(12, "0").slice(0, decimals);
    const fracStr = fracStrRaw.replace(/0+$/, "");
    if (!fracStr) return `${sign}${whole.toString()}`;
    return `${sign}${whole.toString()}.${fracStr}`;
  } catch {
    return String(nAtomic);
  }
}

export function zanoToAtomic(zanoStr) {
  const s = String(zanoStr).trim();
  if (!s) return 0n;
  const [wholeStr, fracStrRaw = ""] = s.split(".");
  const whole = BigInt(wholeStr || "0");
  const fracStr = (fracStrRaw + "0".repeat(12)).slice(0, 12);
  const frac = BigInt(fracStr || "0");
  return whole * ATOMIC_UNITS + frac;
}

export function getMaxSendableAtomic() {
  if (state.lastZanoUnlockedAtomic == null) return null;
  const m = state.lastZanoUnlockedAtomic - FEE_ATOMIC;
  return m > 0n ? m : 0n;
}
