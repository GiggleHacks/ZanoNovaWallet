import { createLogger } from "./lib/logger.js";
import { $, setText, appendLog } from "./lib/dom.js";
import { state, getSessionPassword, setSessionPassword } from "./lib/state.js";
import { atomicToZanoString, getMaxSendableAtomic } from "./lib/currency.js";
import { ATOMIC_UNITS, AUTO_REFRESH_MS } from "./lib/constants.js";
import { prewarmSoundsIfNeeded, playStartupSoundOnce } from "./lib/audio.js";
import { switchView, setStatus, setUiBusy, setupTooltips, hideTooltipIfVisible } from "./lib/views.js";
import {
  startWalletRpc, stopWalletRpc,
  refreshBalance, refreshHistory,
  clearWalletHistoryState, showUnlockOverlay,
  loadSettingsIntoDialog, saveSettingsFromDialog,
  resolveExePath, locateSimplewallet, refreshLocateButtonVis,
  showBaseAddress, renderReceiveQr,
  updateSendDialogBalances, suggestWalletPath,
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

  setUiBusy(true, "Starting backend…");
  startWalletRpc(pwd)
    .then(async () => {
      await showBaseAddress().catch(() => {});
      await refreshBalance().catch(() => {});
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
// UI wiring
// ---------------------------------------------------------------------------

function wireUi() {
  // --- Navigation ---
  $("navWallet")?.addEventListener("click", () => switchView("wallet"));
  $("navSettings")?.addEventListener("click", () => switchView("settings"));
  $("navSecurity")?.addEventListener("click", () => {
    if (!getSessionPassword()) return;
    switchView("security");
  });

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
  $("btnOpenSend")?.addEventListener("click", async () => {
    $("sendDialog")?.showModal();
    try { await refreshBalance(); } catch {}
    updateSendDialogBalances();
  });
  $("btnOpenReceive")?.addEventListener("click", async () => {
    $("receiveDialog")?.showModal();
    try {
      const addr = await showBaseAddress();
      if (addr && $("recvAddress")) $("recvAddress").value = addr;
      await renderReceiveQr(addr);
    } catch {}
  });
  $("btnRefreshHistory")?.addEventListener("click", async () => {
    try { await refreshHistory(0); } catch {}
  });

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
  $("btnSend")?.addEventListener("click", async () => {
    try { await send(); }
    catch (err) { appendLog($("sendLog"), err?.message || String(err)); }
  });

  const sendAmountEl = $("sendAmount");
  if (sendAmountEl) {
    const STEP = 0.1;
    const getMaxZano = () => {
      const maxAtomic = getMaxSendableAtomic();
      if (maxAtomic == null) return Infinity;
      return Number(maxAtomic) / Number(ATOMIC_UNITS);
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
    const maxAtomic = getMaxSendableAtomic();
    const el = $("sendAmount");
    if (!el) return;
    el.value = maxAtomic != null ? atomicToZanoString(maxAtomic) : "";
  });

  // --- History pager ---
  $("btnHistoryPrev")?.addEventListener("click", async () => {
    if (state.historyPage <= 0) return;
    await refreshHistory(state.historyPage - 1);
  });
  $("btnHistoryNext")?.addEventListener("click", async () => {
    await refreshHistory(state.historyPage + 1);
  });

  // --- Advanced toggles ---
  const soundToggle = $("soundToggle");
  if (soundToggle) {
    soundToggle.checked = state.soundEnabled;
    soundToggle.addEventListener("change", async () => {
      state.soundEnabled = Boolean(soundToggle.checked);
      try { await window.zano.configSet({ soundEnabled: state.soundEnabled }); } catch {}
    });
  }
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
  const paths            = await window.zano.getPaths().catch(() => null);
  const defaultWalletPath = paths?.walletPath ? String(paths.walletPath).trim() : "";

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
  state.tooltipsEnabled = cfg.tooltipsEnabled !== false;

  prewarmSoundsIfNeeded().catch(() => {});

  const sw = await window.zano.simplewalletState();
  setStatus(sw?.status || "stopped");

  window.zano.onSimplewalletState((st) => {
    setStatus(st?.status || "stopped");
    if (st?.status === "running" && st?.rpcUrl && getSessionPassword()) {
      playStartupSoundOnce();
    }
    if (st?.lastError)                         appendLog($("logArea"), `simplewallet error: ${st.lastError}`);
    if (typeof st?.lastExitCode === "number")  appendLog($("logArea"), `simplewallet exit code: ${st.lastExitCode}`);
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

