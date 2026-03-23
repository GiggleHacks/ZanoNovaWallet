import { createLogger } from "./logger.js";
import { $, appendLog } from "./dom.js";
import { state } from "./state.js";
import { parseAmountToAtomic, atomicToDisplayString } from "./currency.js";
import { FEE_ATOMIC, ZANO_ASSET_ID, KNOWN_ASSETS, MIXIN } from "./constants.js";
import { walletRpc, refreshBalance } from "./wallet.js";
import { playSendSound } from "./audio.js";

const log = createLogger("send");
const STANDARD_ZANO_ADDRESS_RE = /^Zx[1-9A-HJ-NP-Za-km-z]{90,120}$/;

export async function send() {
  const logEl = $("sendLog");
  if (logEl) logEl.textContent = "";
  const toRaw  = $("sendAddress").value.trim();
  const amtStr = $("sendAmount").value;

  if (!toRaw)  { appendLog(logEl, "Missing destination address."); return; }
  if (!amtStr) { appendLog(logEl, "Missing amount."); return; }

  const assetId = state.selectedAssetId;
  const info = state.assetsById.get(assetId) || KNOWN_ASSETS[assetId] || {};
  const ticker = info.ticker || "ASSET";
  const dp = info.decimalPoint ?? 12;

  const selfAddrRes = await walletRpc("getaddress", {}).catch(() => null);
  const selfAddr    = selfAddrRes?.result?.address || "";

  const split    = await walletRpc("split_integrated_address", { integrated_address: toRaw }).catch(() => null);
  const standard = split?.result?.standard_address || "";
  const validStandard = STANDARD_ZANO_ADDRESS_RE.test(toRaw);
  const valid    = Boolean(standard) || validStandard;
  if (!valid) {
    appendLog(logEl, "Address validation failed.");
    appendLog(logEl, split || {});
    return;
  }

  const destStandard = standard || toRaw;
  if (selfAddr && destStandard === selfAddr) {
    appendLog(logEl, "Refusing to send to your own wallet address.");
    return;
  }

  // Convert USD to ZANO if user entered amount in USD mode
  let finalAmtStr = amtStr;
  if (state.sendAmountMode === "USD" && assetId === ZANO_ASSET_ID) {
    const price = state.usdPrices?.ZANO?.usd;
    if (typeof price !== "number" || price <= 0) {
      appendLog(logEl, "Cannot send in USD mode: price data unavailable.");
      return;
    }
    const zanoAmount = parseFloat(amtStr) / price;
    if (!Number.isFinite(zanoAmount) || zanoAmount <= 0) {
      appendLog(logEl, "Invalid USD amount.");
      return;
    }
    finalAmtStr = zanoAmount.toFixed(12);
  }

  const amountAtomic = parseAmountToAtomic(finalAmtStr, dp);
  if (amountAtomic <= 0n) { appendLog(logEl, "Amount must be > 0."); return; }

  const assetBal = state.balancesById.get(assetId);
  const assetUnlocked = assetBal?.unlockedAtomic ?? null;
  if (assetUnlocked != null && assetUnlocked < amountAtomic) {
    appendLog(logEl, `Not enough unlocked ${ticker}. You need ${atomicToDisplayString(amountAtomic, dp)} ${ticker}, but only ${atomicToDisplayString(assetUnlocked, dp)} ${ticker} is unlocked.`);
    return;
  }

  const zanoBal = state.balancesById.get(ZANO_ASSET_ID);
  const zanoUnlocked = zanoBal?.unlockedAtomic ?? state.lastZanoUnlockedAtomic;
  if (zanoUnlocked != null) {
    try {
      const zanoNeeded = assetId === ZANO_ASSET_ID ? amountAtomic + FEE_ATOMIC : FEE_ATOMIC;
      if (BigInt(zanoUnlocked) < zanoNeeded) {
        appendLog(logEl, `Not enough unlocked ZANO for fee. Need at least ${atomicToDisplayString(zanoNeeded, 12)} ZANO, but only ${atomicToDisplayString(zanoUnlocked, 12)} ZANO is unlocked.`);
        appendLog(logEl, "Newly received funds stay locked until they reach about 10 confirmations. This can take a few minutes depending on the network.");
        return;
      }
    } catch { /* let RPC decide */ }
  }

  log.info("sending", atomicToDisplayString(amountAtomic, dp), ticker, "to", toRaw);

  const res = await walletRpc("transfer", {
    destinations: [{ address: toRaw, amount: amountAtomic.toString(), asset_id: assetId }],
    fee:          FEE_ATOMIC.toString(),
    mixin:        MIXIN,
    hide_receiver: true,
    push_payer:   false,
  });

  if (logEl) {
    logEl.textContent = "";
    const lines = [
      ["Asset", `${ticker}`],
      ["Amount", `${atomicToDisplayString(amountAtomic, dp)} ${ticker}`],
    ];
    for (const [label, value] of lines) {
      const div = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = label;
      div.append(strong, `: ${value}`);
      logEl.appendChild(div);
    }
    const toDiv = document.createElement("div");
    const toStrong = document.createElement("strong");
    toStrong.textContent = "To";
    const toSpan = document.createElement("span");
    toSpan.className = "mono";
    toSpan.style.cssText = "word-break:break-all;font-size:.85em";
    toSpan.textContent = toRaw;
    toDiv.append(toStrong, ": ", toSpan);
    logEl.appendChild(toDiv);
  }

  // Clear address for next use
  const addrEl = $("sendAddress");
  if (addrEl) addrEl.value = "";

  log.info("send ok, txId:", res?.result?.tx_details?.id || res?.result?.tx_hash || "unknown");
  await playSendSound().catch(() => {});

  // Refresh balance immediately so the UI reflects the deducted amount
  refreshBalance().catch(() => {});
}
