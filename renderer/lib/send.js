import { createLogger } from "./logger.js";
import { $, appendLog } from "./dom.js";
import { state } from "./state.js";
import { zanoToAtomic, atomicToZanoString } from "./currency.js";
import { FEE_ATOMIC, ZANO_ASSET_ID, MIXIN, EXPLORER_TX_URL } from "./constants.js";
import { walletRpc } from "./wallet.js";
import { playSendSound } from "./audio.js";

const log = createLogger("send");

export async function send() {
  $("sendLog").textContent = "";
  const toRaw  = $("sendAddress").value.trim();
  const amtStr = $("sendAmount").value;

  if (!toRaw)  { appendLog($("sendLog"), "Missing destination address."); return; }
  if (!amtStr) { appendLog($("sendLog"), "Missing amount."); return; }

  const selfAddrRes = await walletRpc("getaddress", {}).catch(() => null);
  const selfAddr    = selfAddrRes?.result?.address || "";

  // Validate address — accept integrated or standard Zx… addresses.
  const split    = await walletRpc("split_integrated_address", { integrated_address: toRaw }).catch(() => null);
  const standard = split?.result?.standard_address || "";
  const valid    = Boolean(standard) || toRaw.startsWith("Zx");
  if (!valid) {
    appendLog($("sendLog"), "Address validation failed.");
    appendLog($("sendLog"), split || {});
    return;
  }

  const destStandard = standard || toRaw;
  if (selfAddr && destStandard === selfAddr) {
    appendLog($("sendLog"), "Refusing to send to your own wallet address.");
    return;
  }

  const amountAtomic = zanoToAtomic(amtStr);
  if (amountAtomic <= 0n) { appendLog($("sendLog"), "Amount must be > 0."); return; }

  // Pre-flight balance check so we surface a clear message before hitting RPC.
  const needed = amountAtomic + FEE_ATOMIC;
  if (state.lastZanoUnlockedAtomic != null) {
    try {
      if (BigInt(state.lastZanoUnlockedAtomic) < needed) {
        appendLog($("sendLog"), `Not enough unlocked balance. You need at least ${atomicToZanoString(needed)} ZANO (amount + fee), but only ${atomicToZanoString(state.lastZanoUnlockedAtomic)} ZANO is unlocked.`);
        appendLog($("sendLog"), "Newly received funds stay locked until they reach about 10 confirmations. This can take a few minutes depending on the network.");
        return;
      }
    } catch {
      // If casting fails, let RPC decide.
    }
  }

  log.info("sending", atomicToZanoString(amountAtomic), "ZANO to", toRaw);

  const res = await walletRpc("transfer", {
    destinations: [{ address: toRaw, amount: amountAtomic.toString(), asset_id: ZANO_ASSET_ID }],
    fee:          FEE_ATOMIC.toString(),
    mixin:        MIXIN,
    hide_receiver: true,
    push_payer:   false,
  });

  const logEl = $("sendLog");
  if (logEl) {
    const result     = res?.result || {};
    const tx         = result.tx_details || {};
    const txId       = tx.id || result.tx_hash || tx.tx_hash || "";
    const explorerUrl= txId ? `${EXPLORER_TX_URL}${txId}` : "";
    logEl.innerHTML = [
      `<div><strong>Transaction ID</strong>: ${explorerUrl ? `<a href="${explorerUrl}" target="_blank" rel="noopener noreferrer">${txId}</a>` : txId || "-"}</div>`,
      `<div><strong>Asset ID</strong>: ${tx.asset_id || ZANO_ASSET_ID || "-"}</div>`,
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
