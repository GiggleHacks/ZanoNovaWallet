import { createLogger } from "./logger.js";
import { $, setText } from "./dom.js";
import { getSessionPassword, state } from "./state.js";
import { playSeedSound } from "./audio.js";

const log = createLogger("seed");
const SEED_WORD_RE = /^[a-z]+$/;

function tokenizeSeedLine(line) {
  return String(line || "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => SEED_WORD_RE.test(w));
}

export function extractSeedWords(stdoutText) {
  const lines = String(stdoutText || "").split(/\r?\n/);
  const candidates = new Map();

  for (let start = 0; start < lines.length; start++) {
    let words = [];
    for (let end = start; end < Math.min(lines.length, start + 4); end++) {
      const lineWords = tokenizeSeedLine(lines[end]);
      if (!lineWords.length) {
        if (words.length) break;
        continue;
      }
      words = words.concat(lineWords);
      if (words.length >= 24 && words.length <= 26) {
        candidates.set(words.join(" "), [...words]);
      }
      if (words.length > 26) break;
    }
  }

  if (candidates.size !== 1) return [];
  return [...candidates.values()][0];
}

export function renderSeedWordsInto(el, words) {
  if (!el) return;
  el.replaceChildren();
  words.forEach((w, i) => {
    const chip = document.createElement("div");
    chip.className = "seedChip";
    const idx = document.createElement("span");
    idx.className = "seedIdx";
    idx.textContent = `${i + 1}`;
    chip.appendChild(idx);
    chip.append(` ${w}`);
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
  if (wordsEl) wordsEl.replaceChildren();

  const out   = await window.zano.walletShowSeed({
    walletFile,
    password,
    seedProtectionPassword: "",
    simplewalletExePath:    cfg.simplewalletExePath,
    daemonAddress:          cfg.daemonAddress,
  });
  const words = extractSeedWords(out?.output || "");
  if (!words.length) {
    throw new Error("Could not parse seed phrase output safely.");
  }
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
  const walletFile = state.currentWalletFile
    || $("inputWalletFile")?.value?.trim()
    || (await window.zano.getPaths().catch(() => null))?.walletPath;
  if (!password) return;

  $("seedWarningDialog")?.close();
  const seedView = $("seedViewDialog");
  const wordsEl  = $("seedWords");
  if (!seedView || !wordsEl) return;
  wordsEl.replaceChildren();

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
    renderSeedWordsInto(wordsEl, words);
    seedView.showModal();
    playSeedSound().catch(() => {});

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
