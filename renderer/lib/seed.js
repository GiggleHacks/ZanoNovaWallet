import { createLogger } from "./logger.js";
import { $, setText } from "./dom.js";
import { getSessionPassword } from "./state.js";

const log = createLogger("seed");

export function extractSeedWords(stdoutText) {
  const text  = String(stdoutText || "");
  const lines = text.split(/\r?\n/);
  let best    = [];
  for (const line of lines) {
    const words = line.trim().split(/\s+/).filter((w) => /^[a-z]+$/.test(w));
    if (words.length >= 24 && words.length <= 26 && words.length > best.length) {
      best = words;
    }
  }
  if (best.length) return best;
  // Fallback: scan full output for a contiguous run of lowercase words.
  const all = text.toLowerCase().split(/\s+/).filter((w) => /^[a-z]+$/.test(w));
  for (let n = 26; n >= 24; n--) {
    if (all.length >= n) return all.slice(-n);
  }
  return [];
}

export function renderSeedWordsInto(el, words) {
  if (!el) return;
  el.innerHTML = "";
  words.forEach((w, i) => {
    const chip = document.createElement("div");
    chip.className = "seedWord";
    chip.textContent = `${i + 1}. ${w}`;
    el.appendChild(chip);
  });
}

export async function showSeedBackupForWallet({ walletFile, password, name }) {
  log.info("showing seed backup for", name || "wallet");
  const cfg    = await window.zano.configGet();
  const meta   = $("seedBackupMeta");
  const wordsEl= $("seedBackupWords");
  const ack    = $("seedBackupAck");
  const cont   = $("btnSeedBackupContinue");

  if (meta)  meta.textContent  = `${name || "Wallet"} · ${walletFile}`;
  if (ack)   ack.checked       = false;
  if (cont)  cont.disabled     = true;
  if (wordsEl) wordsEl.innerHTML = "";

  const out   = await window.zano.walletShowSeed({
    walletFile,
    password,
    seedProtectionPassword: "",
    simplewalletExePath:    cfg.simplewalletExePath,
    daemonAddress:          cfg.daemonAddress,
  });
  const words = extractSeedWords(out?.output || "");
  renderSeedWordsInto(wordsEl, words);
}

export function viewSeedPhraseFlow() {
  if (!getSessionPassword()) return;
  const warning  = $("seedWarningDialog");
  const seedAck  = $("seedAck");
  const btnConfirm = $("btnConfirmViewSeed");
  if (!warning || !seedAck || !btnConfirm) return;
  seedAck.checked    = false;
  btnConfirm.disabled = true;
  warning.showModal();
}

/**
 * Body of the "Confirm View Seed" button click.
 * Decrypts the seed via walletShowSeed and renders it in the seed view dialog.
 */
export async function handleConfirmViewSeed() {
  const cfg = await window.zano.configGet();
  const password   = getSessionPassword();
  const walletFile = $("inputWalletFile")?.value?.trim()
    || (await window.zano.getPaths().catch(() => null))?.walletPath;
  if (!password) return;

  $("seedWarningDialog")?.close();
  const seedView = $("seedViewDialog");
  const wordsEl  = $("seedWords");
  if (!seedView || !wordsEl) return;
  wordsEl.innerHTML = "";

  try {
    log.info("fetching seed phrase");
    const out   = await window.zano.walletShowSeed({
      walletFile,
      password,
      seedProtectionPassword: "",
      simplewalletExePath:    cfg.simplewalletExePath,
      daemonAddress:          cfg.daemonAddress,
    });
    const words = extractSeedWords(out?.output || "");
    if (!words.length) {
      setText($("seedStatus"), "Could not parse seed phrase output.");
    } else {
      setText($("seedStatus"), words.length === 26 ? "Seed phrase (26 words)" : `Seed phrase (${words.length} words)`);
    }
    words.forEach((w, i) => {
      const chip = document.createElement("div");
      chip.className = "seedChip";
      chip.innerHTML = `<span class="seedIdx">${i + 1}</span> ${w}`;
      wordsEl.appendChild(chip);
    });
    seedView.showModal();

    $("btnCopySeed")?.addEventListener("click", async () => {
      if (!words.length) return;
      try { await navigator.clipboard.writeText(words.join(" ")); } catch {}
    }, { once: true });
  } catch (err) {
    log.error("seed phrase error:", err);
    setText($("seedStatus"), err?.message || String(err));
    seedView.showModal();
  }
}
