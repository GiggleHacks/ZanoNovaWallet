import { createLogger } from "./logger.js";
import { $, appendLog } from "./dom.js";
import { state } from "./state.js";
import { parseAmountToAtomic, atomicToDisplayString } from "./currency.js";
import { FEE_ATOMIC, ZANO_ASSET_ID, KNOWN_ASSETS, MIXIN, EXPLORER_TX_URL } from "./constants.js";
import { walletRpc } from "./wallet.js";
import { playSendSound } from "./audio.js";

const log = createLogger("send");

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
  const valid    = Boolean(standard) || toRaw.startsWith("Zx");
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

  const amountAtomic = parseAmountToAtomic(amtStr, dp);
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
    const result      = res?.result || {};
    const tx          = result.tx_details || {};
    const txId        = tx.id || result.tx_hash || tx.tx_hash || "";
    const explorerUrl = txId ? `${EXPLORER_TX_URL}${txId}` : "";
    logEl.innerHTML = [
      `<div><strong>Transaction ID</strong>: ${explorerUrl ? `<a href="${explorerUrl}" target="_blank" rel="noopener noreferrer">${txId}</a>` : txId || "-"}</div>`,
      `<div><strong>Asset</strong>: ${ticker}</div>`,
      `<div><strong>Amount</strong>: ${atomicToDisplayString(amountAtomic, dp)} ${ticker}</div>`,
      `<div><strong>Height</strong>: ${tx.height ?? 0}</div>`,
      `<div><strong>Confirmation</strong>: ${tx.confirmations ?? 0}</div>`,
      (tx.size || tx.tx_size || tx.blob_size) ? `<div><strong>Transaction size</strong>: ${tx.size || tx.tx_size || tx.blob_size} bytes</div>` : "",
      `<div><strong>Payment ID</strong>: ${tx.payment_id || result.payment_id || "-"}</div>`,
      (tx.comment || result.comment) ? `<div><strong>Comment</strong>: ${tx.comment || result.comment}</div>` : "",
    ].filter(Boolean).join("");
  }

  log.info("send ok, txId:", res?.result?.tx_details?.id || res?.result?.tx_hash || "unknown");
  await playSendSound().catch(() => {});
}
