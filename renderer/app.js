import { createLogger } from "./lib/logger.js";
import { $, setText, appendLog } from "./lib/dom.js";
import { state, getSessionPassword, setSessionPassword } from "./lib/state.js";
import { atomicToZanoString, getMaxSendableAtomic, parseAmountToAtomic, atomicToDisplayString } from "./lib/currency.js";
import { ATOMIC_UNITS, AUTO_REFRESH_MS, FUSD_ASSET_ID, ZANO_ASSET_ID } from "./lib/constants.js";
import { fetchPricesOnce } from "./lib/prices.js";
import { prewarmSoundsIfNeeded, playStartupSoundOnce, SOUNDS, previewSound } from "./lib/audio.js";
import { switchView, setStatus, setUiBusy, setupTooltips, hideTooltipIfVisible } from "./lib/views.js";
import {
  startWalletRpc, stopWalletRpc,
  refreshBalance, refreshHistory,
  clearWalletHistoryState, showUnlockOverlay,
  loadSettingsIntoDialog, saveSettingsFromDialog,
  resolveExePath, locateSimplewallet, refreshLocateButtonVis,
  showBaseAddress, renderReceiveQr,
  updateSendDialogBalances, suggestWalletPath, getDefaultWalletPath,
  ensureAssetWhitelisted, renderHeaderBalance, renderHeaderBalanceFromCache, populateAssetSelector,
} from "./lib/wallet.js";
import { send } from "./lib/send.js";
import { showSeedBackupForWallet, viewSeedPhraseFlow, handleConfirmViewSeed } from "./lib/seed.js";

const log = createLogger("init");



// ---------------------------------------------------------------------------
// Unlock flow
// ---------------------------------------------------------------------------

async function unlockAndAutoStart() {
  const pwdEl  = $("unlockPassword");
  const hintEl = $("unlockHint");
  if (!pwdEl || !hintEl) return;
  const pwd = pwdEl.value || "";
  setText(hintEl, "");
  if (!pwd) { setText(hintEl, "Password required."); return; }

  setSessionPassword(pwd);
  pwdEl.value = "";
  $("unlockOverlay")?.classList.add("hidden");
  switchView("wallet");

  // Immediately show last-known balances from previous session so the user
  // isn't staring at an empty header while the backend starts.
  renderHeaderBalanceFromCache();

  setUiBusy(true, "Starting backend…");
  startWalletRpc(pwd)
    .then(async (result) => {
      if (result?.stopped) return; // intentional stop — no error
      await ensureAssetWhitelisted(FUSD_ASSET_ID).catch(() => {});
      await showBaseAddress().catch(() => {});
      await refreshBalance().catch(() => {});
      await loadPricesAndRender();
      await refreshHistory().catch(() => {});
    })
    .catch((e) => {
      setSessionPassword(null);
      const msg = e?.message || String(e);
      const isLikelyWrongPassword = /exit\s*1/i.test(msg) && /exited before RPC became ready/i.test(msg);
      setText(hintEl, isLikelyWrongPassword ? "Password is not correct." : msg);
      $("unlockOverlay")?.classList.remove("hidden");
    })
    .finally(() => setUiBusy(false));
}

// ---------------------------------------------------------------------------
// Price fetch helper
// ---------------------------------------------------------------------------

async function loadPricesAndRender() {
  try {
    const prices = await fetchPricesOnce();
    state.usdPrices = prices;
  } catch { /* graceful fallback — renderHeaderBalance handles null */ }
  renderHeaderBalance();
}

// ---------------------------------------------------------------------------
// Sounds settings wiring
// ---------------------------------------------------------------------------

function wireSoundsSettings() {
  const card       = document.querySelector(".soundsCard");
  const masterEl   = $("soundMasterToggle");
  const sliderEl   = $("soundVolumeSlider");
  const volValEl   = $("soundVolumeValue");
  const listEl     = $("soundEventsList");
  if (!card || !masterEl || !sliderEl || !listEl) return;

  function updateDisabledState() {
    card.classList.toggle("disabled", !state.soundEnabled);
  }

  // Master toggle
  masterEl.checked = state.soundEnabled;
  updateDisabledState();
  masterEl.addEventListener("change", async () => {
    state.soundEnabled = Boolean(masterEl.checked);
    updateDisabledState();
    try { await window.zano.configSet({ soundEnabled: state.soundEnabled }); } catch {}
  });

  // Volume slider
  sliderEl.value = Math.round(state.soundVolume * 100);
  if (volValEl) volValEl.textContent = `${sliderEl.value}%`;
  sliderEl.addEventListener("input", () => {
    const pct = Number(sliderEl.value);
    state.soundVolume = pct / 100;
    if (volValEl) volValEl.textContent = `${pct}%`;
  });
  sliderEl.addEventListener("change", async () => {
    try { await window.zano.configSet({ soundVolume: state.soundVolume }); } catch {}
  });

  // Per-sound rows
  for (const [type, info] of Object.entries(SOUNDS)) {
    const row = document.createElement("div");
    row.className = "soundEventRow";

    const name = document.createElement("span");
    name.className = "soundEventName";
    name.textContent = info.label;

    const playBtn = document.createElement("button");
    playBtn.className = "soundEventPlay";
    playBtn.type = "button";
    playBtn.textContent = "\u25B6 Play";
    playBtn.addEventListener("click", () => previewSound(type));

    const toggle = document.createElement("label");
    toggle.className = "soundEventToggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.soundToggles[type] !== false;
    const track = document.createElement("span");
    track.className = "toggleTrack";
    toggle.appendChild(cb);
    toggle.appendChild(track);

    cb.addEventListener("change", async () => {
      state.soundToggles[type] = Boolean(cb.checked);
      try { await window.zano.configSet({ soundToggles: { ...state.soundToggles } }); } catch {}
    });

    row.appendChild(name);
    row.appendChild(playBtn);
    row.appendChild(toggle);
    listEl.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function wireUi() {
  // --- Navigation ---
  $("navWallet")?.addEventListener("click", () => {
    switchView("wallet");
    loadPricesAndRender();
  });
  $("navSettings")?.addEventListener("click", () => switchView("settings"));
  $("navSecurity")?.addEventListener("click", () => {
    if (!getSessionPassword()) return;
    switchView("security");
  });

  // (Asset header dropdown removed — balance card now shows all assets)

  // --- Create/restore path selection state (scoped to wireUi closure) ---
  let selectedCreatePath  = null;
  let createPathManuallyChosen  = false;
  let selectedRestorePath = null;
  let restorePathManuallyChosen = false;

  async function resetCreateForm() {
    $("addWalletLog").textContent     = "";
    $("addWalletName").value          = "";
    $("addWalletPassword").value      = "";
    $("addWalletPassword2").value     = "";
    selectedCreatePath = null;
    createPathManuallyChosen = false;
    const suggested = await suggestWalletPath("wallet.zan");
    selectedCreatePath = suggested;
    $("addWalletPathHint").textContent = suggested || "No file selected.";
  }

  async function resetRestoreForm() {
    $("restoreWalletLog").textContent    = "";
    $("restoreWalletName").value         = "";
    $("restoreSeedPhrase").value         = "";
    $("restoreSeedPassphrase").value     = "";
    $("restoreWalletPassword").value     = "";
    $("restoreWalletPassword2").value    = "";
    selectedRestorePath = null;
    restorePathManuallyChosen = false;
    const suggested = await suggestWalletPath("restored_wallet.zan");
    selectedRestorePath = suggested;
    $("restoreWalletPathHint").textContent = suggested || "No file selected.";
  }

  // --- Welcome view ---
  $("btnAddWallet")?.addEventListener("click", async () => {
    await resetCreateForm();
    switchView("addWallet");
  });
  $("btnWelcomeCreate")?.addEventListener("click", () => $("btnAddWallet")?.click());
  $("btnWelcomeOpen")?.addEventListener("click",   () => $("btnLoadWallet")?.click());
  $("btnWelcomeRestore")?.addEventListener("click", async () => {
    await resetRestoreForm();
    switchView("restoreWallet");
  });
  $("btnOpenRestoreWizard")?.addEventListener("click", async () => {
    await resetRestoreForm();
    switchView("restoreWallet");
  });
  $("btnCancelAddWallet")?.addEventListener("click", () => {
    selectedCreatePath = null;
    switchView("welcome");
  });
  $("btnCancelRestoreWallet")?.addEventListener("click", () => switchView("welcome"));

  // --- Seed backup view ---
  $("seedBackupAck")?.addEventListener("change", () => {
    const btn = $("btnSeedBackupContinue");
    if (btn) btn.disabled = !$("seedBackupAck")?.checked;
  });
  $("btnCopySeedBackup")?.addEventListener("click", async () => {
    const words = Array.from($("seedBackupWords")?.querySelectorAll(".seedWord") || [])
      .map((el) => String(el.textContent || "").replace(/^\d+\.\s*/, "").trim())
      .filter(Boolean);
    if (!words.length) return;
    try { await navigator.clipboard.writeText(words.join(" ")); } catch {}
  });
  $("btnSeedBackupContinue")?.addEventListener("click", async () => {
    const cfg        = await window.zano.configGet().catch(() => ({}));
    const walletFile = (state.currentWalletFile || "").trim() || (cfg?.lastWalletPath || "").trim() || "";
    const password   = getSessionPassword();
    if (!walletFile) {
      const el = $("seedBackupStatus");
      if (el) el.textContent = "Wallet path not set. Please create the wallet again.";
      return;
    }
    if (!password) {
      const el = $("seedBackupStatus");
      if (el) el.textContent = "Session password missing. Please create the wallet again.";
      return;
    }
    setUiBusy(true, "Starting backend…");
    try {
      await startWalletRpc(password);
      await ensureAssetWhitelisted(FUSD_ASSET_ID).catch(() => {});
      await refreshBalance().catch(() => {});
      await refreshHistory(0).catch(() => {});
      const el = $("seedBackupStatus");
      if (el) el.textContent = "You've successfully created your wallet. The backend is syncing with the network — you can use your wallet now.";
      switchView("wallet");
    } catch (e) {
      const el = $("seedBackupStatus");
      if (el) el.textContent = "Backend failed to start: " + (e?.message || String(e));
    } finally {
      setUiBusy(false);
    }
  });

  // --- Create wallet wizard ---
  $("btnSelectWalletLocation")?.addEventListener("click", async () => {
    const p = await window.zano.saveWalletDialog().catch(() => null);
    if (!p) return;
    selectedCreatePath = p;
    createPathManuallyChosen = true;
    $("addWalletPathHint").textContent = p;
  });
  $("addWalletName")?.addEventListener("input", async () => {
    if (createPathManuallyChosen) return;
    const name = $("addWalletName").value.trim();
    if (!name) return;
    const safeName  = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const suggested = await suggestWalletPath(safeName + ".zan");
    if (suggested) { selectedCreatePath = suggested; $("addWalletPathHint").textContent = suggested; }
  });
  $("btnCreateWalletWizard")?.addEventListener("click", async () => {
    const logEl   = $("addWalletLog");
    logEl.textContent = "";
    const name     = $("addWalletName").value.trim();
    const password = $("addWalletPassword").value;
    const password2= $("addWalletPassword2").value;
    if (!name)                           return appendLog(logEl, "Enter a wallet name.");
    if (!password)                       return appendLog(logEl, "Enter a wallet password.");
    if (password !== password2)          return appendLog(logEl, "Passwords do not match.");
    if (!selectedCreatePath)           { appendLog(logEl, "Select wallet location first."); return; }

    setUiBusy(true, "Creating wallet…");
    try {
      const cfg      = await window.zano.configGet();
      const resolved = await resolveExePath();
      appendLog(logEl, `simplewallet: ${resolved.resolved || "(not found)"}`);
      if (!resolved.resolved) {
        setUiBusy(false);
        return appendLog(logEl, "simplewallet was not found. Bundle it with the app or choose a source binary in Settings → Wallet so the app can copy it into its data directory.");
      }
      let walletFile = await window.zano.suggestNewWalletPath(selectedCreatePath);
      if (walletFile !== selectedCreatePath) {
        appendLog(logEl, `File already exists, using: ${walletFile}`);
        selectedCreatePath = walletFile;
        $("addWalletPathHint").textContent = walletFile;
      }
      appendLog(logEl, "Generating new wallet…");
      const out = await window.zano.walletGenerate({ walletFile, password, simplewalletExePath: cfg.simplewalletExePath });
      appendLog(logEl, out.output || out);

      await window.zano.configSet({ lastWalletPath: walletFile });
      state.currentWalletFile = walletFile;
      const walletInput = $("inputWalletFile");
      if (walletInput) walletInput.value = walletFile;
      setSessionPassword(password);

      await showSeedBackupForWallet({ walletFile, password, name });
      switchView("seedBackup");
    } catch (e) {
      appendLog(logEl, e?.message || String(e));
    } finally {
      setUiBusy(false);
    }
  });

  // --- Restore wallet wizard ---
  $("btnSelectRestoreLocation")?.addEventListener("click", async () => {
    const p = await window.zano.saveWalletDialog().catch(() => null);
    if (!p) return;
    selectedRestorePath = p;
    restorePathManuallyChosen = true;
    $("restoreWalletPathHint").textContent = p;
  });
  $("restoreWalletName")?.addEventListener("input", async () => {
    if (restorePathManuallyChosen) return;
    const name = $("restoreWalletName").value.trim();
    if (!name) return;
    const safeName  = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const suggested = await suggestWalletPath(safeName + ".zan");
    if (suggested) { selectedRestorePath = suggested; $("restoreWalletPathHint").textContent = suggested; }
  });
  $("btnRestoreWalletWizard")?.addEventListener("click", async () => {
    const logEl         = $("restoreWalletLog");
    logEl.textContent   = "";
    const name          = $("restoreWalletName").value.trim();
    const seedPhrase    = $("restoreSeedPhrase").value.trim();
    const seedPassphrase= $("restoreSeedPassphrase").value || "";
    const password      = $("restoreWalletPassword").value;
    const password2     = $("restoreWalletPassword2").value;
    if (!name)             return appendLog(logEl, "Enter a wallet name.");
    if (!seedPhrase)       return appendLog(logEl, "Enter your seed phrase.");
    if (!password)         return appendLog(logEl, "Enter a wallet password.");
    if (password !== password2) return appendLog(logEl, "Passwords do not match.");
    if (!selectedRestorePath)   return appendLog(logEl, "Select wallet location first.");

    setUiBusy(true, "Restoring wallet…");
    try {
      const cfg      = await window.zano.configGet();
      const resolved = await resolveExePath();
      appendLog(logEl, `simplewallet: ${resolved.resolved || "(not found)"}`);
      if (!resolved.resolved) {
        setUiBusy(false);
        return appendLog(logEl, "simplewallet was not found. Bundle it with the app or choose a source binary in Settings → Wallet so the app can copy it into its data directory.");
      }
      let walletFile = await window.zano.suggestNewWalletPath(selectedRestorePath);
      if (walletFile !== selectedRestorePath) {
        appendLog(logEl, `File already exists, using: ${walletFile}`);
        selectedRestorePath = walletFile;
        $("restoreWalletPathHint").textContent = walletFile;
      }
      appendLog(logEl, "Restoring wallet…");
      const out = await window.zano.walletRestore({ walletFile, password, seedPhrase, seedPassphrase, simplewalletExePath: cfg.simplewalletExePath, daemonAddress: cfg.daemonAddress });
      appendLog(logEl, out.output || out);

      await window.zano.configSet({ lastWalletPath: walletFile });
      state.currentWalletFile = walletFile;
      const walletInput2 = $("inputWalletFile");
      if (walletInput2) walletInput2.value = walletFile;
      setSessionPassword(password);
      await startWalletRpc(password).catch((e) => appendLog(logEl, e?.message || String(e)));
      await ensureAssetWhitelisted(FUSD_ASSET_ID).catch(() => {});
      await refreshBalance().catch(() => {});
      await refreshHistory(0).catch(() => {});
      switchView("wallet");
    } catch (e) {
      appendLog(logEl, e?.message || String(e));
    } finally {
      setUiBusy(false);
    }
  });

  // --- Wallet view actions ---
  // (Send dialog wiring lives further below)
  $("btnOpenReceive")?.addEventListener("click", async () => {
    $("receiveDialog")?.showModal();
    const info = state.assetsById?.get(state.selectedAssetId);
    const ticker = info?.ticker || "ZANO";
    const ctxEl = $("recvAssetContext");
    if (ctxEl) ctxEl.textContent = `Send ${ticker} to this address.`;
    try {
      const addr = await showBaseAddress();
      if (addr && $("recvAddress")) $("recvAddress").value = addr;
      await renderReceiveQr(addr);
    } catch {}
  });
  let lastHistoryRefreshMs = 0;
  $("btnRefreshHistory")?.addEventListener("click", async () => {
    const now = Date.now();
    if (now - lastHistoryRefreshMs < 60_000) {
      // Too soon; ignore extra clicks within 60s.
      return;
    }
    lastHistoryRefreshMs = now;

    const btn = $("btnRefreshHistory");
    const card = document.querySelector(".historyCard");
    const historyEl = $("history");

    // Immediately clear current transactions so user sees a fresh fetch.
    if (historyEl) historyEl.replaceChildren();

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Refreshing…";
    }
    if (card) card.classList.add("refreshing");

    try {
      await Promise.all([
        refreshBalance().catch(() => {}),
        refreshHistory(0).catch(() => {}),
      ]);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Refresh";
      }
      if (card) card.classList.remove("refreshing");
    }
  });
  // (History asset filter dropdown removed — all transfers shown)

  // --- Settings view ---
  $("btnOpenSettings")?.addEventListener("click", async () => {
    await loadSettingsIntoDialog();
    $("settingsDialog")?.showModal();
  });
  $("btnSaveSettings")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await saveSettingsFromDialog();
    $("settingsDialog")?.close();
    appendLog($("logArea"), "Saved settings.");
    await refreshLocateButtonVis();
  });
  $("btnCopyDaemon")?.addEventListener("click", async () => {
    const v = $("cfgDaemon")?.value?.trim() || "";
    if (!v) return;
    try { await navigator.clipboard.writeText(v); } catch {}
  });
  $("btnBrowseExe")?.addEventListener("click", async () => {
    const res = await window.zano.openFileDialog({ properties: ["openFile"] });
    const p   = res?.filePaths?.[0];
    if (p) $("cfgExe").value = p;
  });
  $("btnLocateSimplewallet")?.addEventListener("click", async () => {
    $("logArea").textContent = "";
    const p = await locateSimplewallet();
    if (!p) return;
    appendLog($("logArea"), `Saved simplewallet path:\n${p}`);
    const resolved = await resolveExePath();
    appendLog($("logArea"), `Resolved simplewallet:\n${resolved.resolved || "(not found)"}`);
    await refreshLocateButtonVis();
  });

  // --- Load wallet ---
  $("btnLoadWallet")?.addEventListener("click", async () => {
    const logEl = $("logArea");
    logEl.textContent = "";
    try {
      setUiBusy(true, "Opening wallet…");
      const res = await window.zano.openFileDialog({
        properties: ["openFile"],
        filters: [{ name: "Zano wallet", extensions: ["zan"] }],
      });
      const filePath = res?.filePaths?.[0];
      if (!filePath) { appendLog(logEl, "Cancelled."); return; }
      state.currentWalletFile = filePath;
      const walletInput = $("inputWalletFile");
      if (walletInput) walletInput.value = filePath;
      appendLog(logEl, `Selected wallet file:\n${filePath}`);
      await window.zano.simplewalletStop().catch(() => {});
      clearWalletHistoryState();
      await window.zano.configSet({ lastWalletPath: filePath });
      showUnlockOverlay("Enter wallet password");
    } catch (e) {
      appendLog(logEl, e?.message || String(e));
    } finally {
      setUiBusy(false);
    }
  });

  // --- Manual backend controls ---
  $("btnStartWallet")?.addEventListener("click", async () => {
    try {
      if (!getSessionPassword()) {
        appendLog($("logArea"), "Unlock first to start automatically (or enter password and use Unlock screen).");
        return;
      }
      await startWalletRpc(getSessionPassword());
      appendLog($("logArea"), "Started.");
    } catch (err) {
      appendLog($("logArea"), err?.message || String(err));
      setStatus("error");
    }
  });
  $("btnStopWallet")?.addEventListener("click", async () => {
    await stopWalletRpc();
    appendLog($("logArea"), "Stop requested.");
  });

  // --- Copy buttons ---
  $("btnCopyAddress")?.addEventListener("click", async () => {
    const addr = $("myAddress")?.value?.trim() || "";
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setText($("copyHint"), "Copied.");
      setTimeout(() => setText($("copyHint"), ""), 1200);
    } catch {
      // Fallback for environments where clipboard API is blocked.
      const ta = document.createElement("textarea");
      ta.value = addr; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try {
        document.execCommand("copy");
        setText($("copyHint"), "Copied.");
        setTimeout(() => setText($("copyHint"), ""), 1200);
      } finally { document.body.removeChild(ta); }
    }
  });
  $("btnCopyRecvAddress")?.addEventListener("click", async () => {
    const addr = $("recvAddress")?.value?.trim() || "";
    if (!addr) return;
    try { await navigator.clipboard.writeText(addr); } catch {}
  });

  // --- Send dialog ---
  const showSendEntry = () => {
    $("sendEntrySection")?.classList.remove("hidden");
    const logEl = $("sendLog");
    if (logEl) logEl.textContent = "";
  };

  function getZanoPriceUsd() {
    const p = state.usdPrices?.ZANO?.usd;
    return typeof p === "number" && p > 0 ? p : null;
  }
  function fmtUsd(n) {
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function updateSendAmountModeUi() {
    const assetId = state.selectedAssetId;
    const pill = $("btnSendAmountMode");
    const tickerEl = $("sendAmountTicker");
    const eqEl = $("sendAmountEq");
    if (!pill || !tickerEl || !eqEl) return;

    const info = state.assetsById?.get(assetId);
    const ticker = info?.ticker || "ASSET";

    if (assetId !== ZANO_ASSET_ID) {
      // Non-ZANO assets: no USD toggle.
      state.sendAmountMode = "ASSET";
      pill.disabled = true;
      pill.textContent = ticker;
      tickerEl.textContent = ticker;
      eqEl.textContent = "";
      return;
    }

    // ZANO supports USD/ZANO toggle.
    pill.disabled = false;
    if (state.sendAmountMode !== "USD") state.sendAmountMode = "ASSET";
    pill.textContent = state.sendAmountMode === "USD" ? "USD" : "ZANO";
    tickerEl.textContent = state.sendAmountMode === "USD" ? "USD" : "ZANO";
    updateSendAmountEquivalent();
  }

  function updateSendAmountEquivalent() {
    const assetId = state.selectedAssetId;
    const eqEl = $("sendAmountEq");
    const amtEl = $("sendAmount");
    if (!eqEl || !amtEl) return;
    const raw = Number(amtEl.value);
    if (!amtEl.value || Number.isNaN(raw) || raw <= 0) {
      eqEl.textContent = "";
      return;
    }

    const info = state.assetsById?.get(assetId) || {};
    const ticker = info.ticker || "ASSET";

    if (assetId !== ZANO_ASSET_ID) {
      // fUSD: 1:1 USD hint
      if (ticker === "fUSD") eqEl.textContent = `≈ ${fmtUsd(raw)}`;
      else eqEl.textContent = "";
      return;
    }

    const price = getZanoPriceUsd();
    if (!price) { eqEl.textContent = ""; return; }
    if (state.sendAmountMode === "USD") {
      const z = raw / price;
      eqEl.textContent = `≈ ${z.toFixed(6)} ZANO`;
    } else {
      const usd = raw * price;
      eqEl.textContent = `≈ ${fmtUsd(usd)}`;
    }
  }

  $("btnSendAmountMode")?.addEventListener("click", () => {
    if (state.selectedAssetId !== ZANO_ASSET_ID) return;
    state.sendAmountMode = state.sendAmountMode === "USD" ? "ASSET" : "USD";
    updateSendAmountModeUi();
  });

  $("sendAmount")?.addEventListener("input", () => updateSendAmountEquivalent());
  $("sendAssetSelect")?.addEventListener("change", () => {
    updateSendDialogBalances();
    const info = state.assetsById?.get(state.selectedAssetId);
    const tickerEl = $("sendAmountTicker");
    if (tickerEl) tickerEl.textContent = info?.ticker || "ASSET";
    updateSendAmountModeUi();
  });

  $("btnOpenSend")?.addEventListener("click", async () => {
    $("sendDialog")?.showModal();
    showSendEntry();
    try { await refreshBalance(); } catch {}
    populateAssetSelector($("sendAssetSelect"));
    updateSendDialogBalances();
    updateSendAmountModeUi();
  });

  $("btnSend")?.addEventListener("click", async () => {
    try { await send(); }
    catch (err) { appendLog($("sendLog"), err?.message || String(err)); }
  });

  const sendAmountEl = $("sendAmount");
  if (sendAmountEl) {
    const STEP = 0.1;
    const getMaxZano = () => {
      const maxAtomic = getMaxSendableAtomic(state.selectedAssetId);
      if (maxAtomic == null) return Infinity;
      const info = state.assetsById?.get(state.selectedAssetId);
      const dp = info?.decimalPoint ?? 12;
      const divisor = 10 ** dp;
      return Number(maxAtomic) / divisor;
    };
    sendAmountEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const current = parseFloat(sendAmountEl.value) || 0;
      const delta   = e.deltaY > 0 ? -STEP : STEP;
      let next      = Math.round(Math.max(0, current + delta) * 10) / 10;
      const maxZ    = getMaxZano();
      if (Number.isFinite(maxZ)) next = Math.min(next, maxZ);
      sendAmountEl.value = next;
    }, { passive: false });
    sendAmountEl.addEventListener("input", () => {
      const raw  = parseFloat(sendAmountEl.value);
      if (Number.isNaN(raw) || raw < 0) { sendAmountEl.value = ""; return; }
      const maxZ = getMaxZano();
      let v      = Number.isFinite(maxZ) ? Math.min(raw, maxZ) : raw;
      v = Math.round(v * 10) / 10;
      if (v !== raw) sendAmountEl.value = String(v);
    });
  }
  $("btnSendMax")?.addEventListener("click", () => {
    const maxAtomic = getMaxSendableAtomic(state.selectedAssetId);
    const el = $("sendAmount");
    if (!el) return;
    const info = state.assetsById?.get(state.selectedAssetId);
    const dp = info?.decimalPoint ?? 12;
    el.value = maxAtomic != null ? atomicToZanoString(maxAtomic, dp) : "";
  });

  // --- History pager ---
  $("btnHistoryPrev")?.addEventListener("click", async () => {
    if (state.historyPage <= 0) return;
    await refreshHistory(state.historyPage - 1);
  });
  $("btnHistoryNext")?.addEventListener("click", async () => {
    await refreshHistory(state.historyPage + 1);
  });

  // --- Sounds section ---
  wireSoundsSettings();

  // --- Advanced toggles ---
  const tooltipToggle = $("tooltipToggle");
  if (tooltipToggle) {
    tooltipToggle.checked = state.tooltipsEnabled;
    tooltipToggle.addEventListener("change", async () => {
      state.tooltipsEnabled = Boolean(tooltipToggle.checked);
      try { await window.zano.configSet({ tooltipsEnabled: state.tooltipsEnabled }); } catch {}
      if (!state.tooltipsEnabled) hideTooltipIfVisible();
    });
  }

  // --- Security ---
  $("btnViewSeed")?.addEventListener("click", viewSeedPhraseFlow);
  $("seedAck")?.addEventListener("change", () => {
    const btn = $("btnConfirmViewSeed");
    if (btn) btn.disabled = !$("seedAck")?.checked;
  });
  $("btnConfirmViewSeed")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await handleConfirmViewSeed();
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  log.info("initializing");
  const cfg = await window.zano.configGet().catch(() => ({}));
  let lastWalletPath = String(cfg?.lastWalletPath || "").trim();
  const defaultWalletPath = await getDefaultWalletPath();

  $("unlockOverlay")?.classList.add("hidden");

  if (!lastWalletPath && defaultWalletPath) {
    const defaultExists = await window.zano.walletFileExists(defaultWalletPath).catch(() => false);
    if (defaultExists) {
      lastWalletPath = defaultWalletPath;
      await window.zano.configSet({ lastWalletPath }).catch(() => {});
    }
  }

  if (!lastWalletPath) {
    switchView("welcome");
  } else {
    const exists = await window.zano.walletFileExists(lastWalletPath).catch(() => false);
    if (!exists) {
      await window.zano.configSet({ lastWalletPath: "" }).catch(() => {});
      switchView("welcome");
    } else {
      state.currentWalletFile = lastWalletPath;
      const walletInput = $("inputWalletFile");
      if (walletInput) walletInput.value = lastWalletPath;
      switchView("wallet");
      showUnlockOverlay("Enter your wallet password to unlock this wallet.");
    }
  }

  state.soundEnabled    = cfg.soundEnabled    !== false;
  state.soundVolume     = typeof cfg.soundVolume === "number" ? cfg.soundVolume : 0.9;
  state.soundToggles    = Object.assign(
    { startup: true, send: true, receive: true, seed: true },
    cfg.soundToggles || {},
  );
  state.tooltipsEnabled = cfg.tooltipsEnabled !== false;

  prewarmSoundsIfNeeded().catch(() => {});

  const sw = await window.zano.simplewalletState();
  setStatus(sw?.status || "stopped");

  window.zano.onSimplewalletState((st) => {
    setStatus(st?.status || "stopped");
    if (st?.status === "running" && st?.rpcUrl && getSessionPassword()) {
      playStartupSoundOnce();
    }
    // Only log errors/exit codes for unexpected exits (not intentional stops)
    if (st?.status === "stopped" && st?.lastError)  appendLog($("logArea"), `simplewallet error: ${st.lastError}`);
    if (st?.status === "stopped" && typeof st?.lastExitCode === "number" && st.lastExitCode !== null && st.lastExitCode !== 0) {
      appendLog($("logArea"), `simplewallet exit code: ${st.lastExitCode}`);
    }
  });

  wireUi();
  setupTooltips();
  refreshLocateButtonVis().catch(() => {});

  $("btnUnlock")?.addEventListener("click", unlockAndAutoStart);
  $("btnUnlockClose")?.addEventListener("click", () => $("unlockOverlay")?.classList.add("hidden"));
  $("btnUnlockCreateNew")?.addEventListener("click", () => {
    $("unlockOverlay")?.classList.add("hidden");
    switchView("settings");
  });
  $("unlockPassword")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlockAndAutoStart();
  });

  setInterval(async () => {
    if (state.uiBusy) return;
    const st = await window.zano.simplewalletState().catch(() => null);
    if (st?.status !== "running") return;
    try { await refreshBalance(); } catch {}
    try { await refreshHistory(); } catch {}
  }, AUTO_REFRESH_MS);

  log.info("initialized");
}

init().catch((e) => console.error("[init]", e));

