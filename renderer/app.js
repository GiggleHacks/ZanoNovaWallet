import { createLogger } from "./lib/logger.js";
import { $, setText, appendLog } from "./lib/dom.js";
import { state, getSessionPassword, setSessionPassword } from "./lib/state.js";
import { atomicToZanoString, getMaxSendableAtomic, parseAmountToAtomic, atomicToDisplayString } from "./lib/currency.js";
import { AUTO_REFRESH_MS, FUSD_ASSET_ID, ZANO_ASSET_ID, FEE_ATOMIC, MIXIN, KNOWN_ASSETS } from "./lib/constants.js";
import { fetchPricesOnce } from "./lib/prices.js";
import { prewarmSoundsIfNeeded, playStartupSoundOnce, SOUNDS, previewSound } from "./lib/audio.js";
import { switchView, setStatus, setConnectionStatus, setUiBusy, setupTooltips, hideTooltipIfVisible } from "./lib/views.js";
import {
  walletRpc, startWalletRpc, stopWalletRpc,
  refreshBalance, refreshHistory,
  clearWalletHistoryState, showUnlockOverlay,
  loadSettingsIntoDialog, saveSettingsFromDialog,
  resolveExePath, locateSimplewallet, refreshLocateButtonVis,
  showBaseAddress, renderReceiveQr,
  updateSendDialogBalances, suggestWalletPath, getDefaultWalletPath,
  ensureAssetWhitelisted, renderHeaderBalance, renderHeaderBalanceFromCache, populateAssetSelector,
  prewarmStartupCache,
} from "./lib/wallet.js";
import { send } from "./lib/send.js";
import { showSeedBackupForWallet, viewSeedPhraseFlow, handleConfirmViewSeed } from "./lib/seed.js";
import { checkHealth as swapHealthCheck, getRate as swapGetRate, createExchange, pollExchange, TERMINAL_STATUSES } from "./lib/swap.js";
import { initNeuralCanvas, startNeural, stopNeural } from "./lib/neural-canvas.js";

const log = createLogger("init");

/** Returns false and logs an error if the password pair is invalid. */
function validatePasswords(pwd, pwd2, logEl) {
  if (!pwd)        { appendLog(logEl, "Enter a wallet password."); return false; }
  if (pwd !== pwd2) { appendLog(logEl, "Passwords do not match."); return false; }
  return true;
}

async function getCurrentNodeLabel() {
  try {
    const cfg = await window.zano.configGet();
    const addr = (cfg?.daemonAddress || "").trim();
    if (!addr) return "node";
    if (addr === "37.27.100.59:10500") return "Zano Official Node";
    if (addr === "64.111.93.25:10500") return "ZanoNova Node";
    return addr;
  } catch {
    return "node";
  }
}

// ---------------------------------------------------------------------------
// Daemon preflight — runs before unlock to overlap network latency with
// the user entering their password. Updates status UI progressively.
// ---------------------------------------------------------------------------

let _preflightAbort = false;

function parseSimplewalletMilestone(stdoutTail, stderrTail) {
  const out = String(stdoutTail || "");
  const err = String(stderrTail || "");
  const s = (out + "\n" + err).toLowerCase();
  if (!s.trim()) return null;

  // Order matters: pick the most informative/latest-stage milestone.
  if (s.includes("wallet is getting fully resynced")) return { subtext: "Wallet resyncing…", detail: "wallet_resync" };
  if (s.includes("detaching blockchain"))            return { subtext: "Wallet resyncing…", detail: "wallet_resync" };
  if (s.includes("loading wallet"))                  return { subtext: "Loading wallet…", detail: "wallet_loading" };
  if (s.includes("initializing wallet"))             return { subtext: "Initializing wallet…", detail: "wallet_loading" };
  if (s.includes("starting in rpc server mode"))     return { subtext: "Starting wallet RPC…", detail: "wallet_starting" };
  if (s.includes("daemon address"))                  return { subtext: "Connecting to daemon…", detail: "daemon_ok" };
  return { subtext: "Starting wallet…", detail: "wallet_starting" };
}

async function startDaemonPreflight() {
  _preflightAbort = false;
  const nodeLabel = await getCurrentNodeLabel();
  setConnectionStatus({ phase: "connecting", nodeLabel, subtext: "Checking daemon…", detail: "daemon_checking" });

  while (!_preflightAbort) {
    try {
      const res = await window.zano.daemonGetinfo();
      if (_preflightAbort) break;
      if (res?.ok) {
        setConnectionStatus({
          phase: "connecting",
          nodeLabel,
          subtext: `Daemon reachable · height ${res.height}`,
          detail: "daemon_ok",
        });
      } else {
        // If the daemon isn't reachable at all, show Offline (accurate),
        // and keep retrying quietly in the background.
        setConnectionStatus({ phase: "offline", nodeLabel, subtext: "Daemon not reachable", detail: "daemon_bad" });
      }
    } catch {
      if (_preflightAbort) break;
      setConnectionStatus({ phase: "offline", nodeLabel, subtext: "Daemon not reachable", detail: "daemon_bad" });
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

function stopDaemonPreflight() {
  _preflightAbort = true;
}



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
  stopNeural();
  switchView("wallet");

  // Immediately show last-known balances from previous session so the user
  // isn't staring at an empty header while the backend starts.
  renderHeaderBalanceFromCache();

  // Don't freeze the entire UI while the backend syncs — show a live connection status instead.
  startWalletRpc(pwd)
    .then(async (result) => {
      if (result?.stopped) return; // intentional stop — no error
      queuePostUnlockWarmup();
    })
    .catch((e) => {
      setSessionPassword(null);
      const msg = e?.message || String(e);
      const isLikelyWrongPassword = /exit\s*1/i.test(msg) && /exited before RPC became ready/i.test(msg);
      setText(hintEl, isLikelyWrongPassword ? "Password is not correct." : msg);
      $("unlockOverlay")?.classList.remove("hidden");
      startNeural();
    })
}

let _warmupToken = 0;

function requestIdle(cb, timeoutMs = 800) {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => cb(), { timeout: timeoutMs });
    return;
  }
  setTimeout(cb, 0);
}

function queuePostUnlockWarmup() {
  const token = ++_warmupToken;

  // All stages run as soon as the RPC is ready — no artificial stagger
  (async () => {
    if (token !== _warmupToken) return;
    await showBaseAddress().catch(() => {});
    if (token !== _warmupToken) return;
    await refreshBalance().catch(() => {});
    if (token !== _warmupToken) return;
    // Small yield so balance renders before heavier work starts
    await new Promise((r) => setTimeout(r, 50));
    if (token !== _warmupToken) return;
    await ensureAssetWhitelisted(FUSD_ASSET_ID).catch(() => {});
    await loadPricesAndRender();
    await refreshHistory().catch(() => {});
  })();
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
  $("navSwap")?.addEventListener("click", () => {
    if (!getSessionPassword()) return;
    switchView("swap");
    updateSwapBalanceHint();
    updateSwapDenomToggleUi();
    preloadSwapLimits();
    // Restore persisted swap if no active poll running
    if (!_stopPoll && !_swapMeta) {
      const saved = loadSwapFromStorage();
      if (saved?.id) {
        _swapMeta = saved;
        renderSwapStatus({ status: "wait", confirmations: 0, confirmationsRequired: 10 });
        _stopPoll = pollExchange(saved.id, renderSwapStatus);
      }
    }
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
    if (!validatePasswords(password, password2, logEl)) return;
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
    // Normalize seed: collapse whitespace, strip non-alpha chars, lowercase
    const seedPhraseRaw = $("restoreSeedPhrase").value || "";
    const seedPhrase    = seedPhraseRaw.replace(/[^\w\s]/g, " ").trim().replace(/\s+/g, " ").toLowerCase();
    const seedPassphrase= $("restoreSeedPassphrase").value || "";
    const password      = $("restoreWalletPassword").value;
    const password2     = $("restoreWalletPassword2").value;
    if (!name)             return appendLog(logEl, "Enter a wallet name.");
    if (!seedPhrase)       return appendLog(logEl, "Enter your seed phrase.");
    const wordCount = seedPhrase.split(" ").length;
    if (wordCount < 24 || wordCount > 26) return appendLog(logEl, `Seed phrase must be 24, 25, or 26 words. You entered ${wordCount} words.`);
    if (!validatePasswords(password, password2, logEl)) return;
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

      // Switch to wallet view first so the user sees progress
      switchView("wallet");

      // Now start the backend — errors show on the wallet view's log area
      try {
        await startWalletRpc(password);
        await ensureAssetWhitelisted(FUSD_ASSET_ID).catch(() => {});
        await refreshBalance().catch(() => {});
        await refreshHistory(0).catch(() => {});
      } catch (rpcErr) {
        const walletLog = $("logArea");
        if (walletLog) appendLog(walletLog, rpcErr?.message || String(rpcErr));
      }
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

  $("btnSend")?.addEventListener("click", () => {
    const address = $("sendAddress")?.value.trim();
    const amtStr = $("sendAmount")?.value;
    const logEl = $("sendLog");

    if (!address) { appendLog(logEl, "Missing destination address."); return; }
    if (!amtStr)  { appendLog(logEl, "Missing amount."); return; }

    const assetId = state.selectedAssetId;
    const info = state.assetsById?.get(assetId) || KNOWN_ASSETS[assetId] || {};
    const ticker = info.ticker || "ASSET";
    const dp = info.decimalPoint ?? 12;
    const raw = parseFloat(amtStr);
    if (Number.isNaN(raw) || raw <= 0) { appendLog(logEl, "Amount must be > 0."); return; }

    let zanoAmount = raw;
    let usdValue = null;
    const price = getZanoPriceUsd();

    if (state.sendAmountMode === "USD" && assetId === ZANO_ASSET_ID) {
      if (!price) { appendLog(logEl, "Cannot send in USD mode: price data unavailable."); return; }
      zanoAmount = raw / price;
      usdValue = raw;
    } else if (price && assetId === ZANO_ASSET_ID) {
      usdValue = raw * price;
    }

    const confirmAddr = $("confirmAddress");
    const confirmAmt  = $("confirmAmount");
    const confirmUsd  = $("confirmUsdValue");
    if (confirmAddr) confirmAddr.textContent = address;
    if (confirmAmt)  confirmAmt.textContent  = `${zanoAmount.toFixed(dp > 6 ? 6 : dp)} ${ticker}`;
    if (confirmUsd) {
      confirmUsd.textContent = usdValue != null
        ? `≈ $${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : "";
    }

    $("sendConfirmDialog")?.showModal();
  });

  $("btnConfirmCancel")?.addEventListener("click", () => {
    $("sendConfirmDialog")?.close();
  });

  $("btnConfirmSend")?.addEventListener("click", async () => {
    $("sendConfirmDialog")?.close();
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
      updateSendAmountEquivalent();
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

  // --- Swap section ---
  let _stopPoll = null;
  let _swapMeta = null;   // metadata for the active exchange (id, from, to, amounts, addresses, rate)
  const SWAP_LS_KEY = "zano_wallet_active_swap";
  function saveSwapToStorage(meta) {
    try { localStorage.setItem(SWAP_LS_KEY, JSON.stringify(meta)); } catch {}
  }
  function loadSwapFromStorage() {
    try { const r = localStorage.getItem(SWAP_LS_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
  }
  function clearSwapStorage() {
    try { localStorage.removeItem(SWAP_LS_KEY); } catch {}
  }
  let _rateTimer = null;
  let _swapDenomMode = "ASSET";   // "ASSET" | "USD"
  let _swapLastRate = null;        // cached { rate, minAmount, maxAmount, toAmount }

  function swapFromTicker() { return $("swapFromAsset")?.value || "ZANO"; }
  function swapToTicker()   { return $("swapToAsset")?.value   || "fUSD"; }

  function getSwapFromAssetId() {
    return swapFromTicker() === "ZANO" ? ZANO_ASSET_ID : FUSD_ASSET_ID;
  }

  function getSwapFromDp() {
    const assetId = getSwapFromAssetId();
    return state.assetsById.get(assetId)?.decimalPoint ?? 12;
  }

  function getSwapMaxAtomicForFrom() {
    const assetId = getSwapFromAssetId();
    return getMaxSendableAtomic(assetId);
  }

  function getZanoPriceUsd() {
    return state.usdPrices?.ZANO?.usd ?? null;
  }

  function setSwapExecuteEnabled(enabled) {
    const btn = $("btnSwapExecute");
    if (!btn) return;
    btn.disabled = !enabled;
  }

  function syncSwapSelectors() {
    const fromEl = $("swapFromAsset");
    const toEl   = $("swapToAsset");
    if (!fromEl || !toEl) return;
    toEl.value = fromEl.value === "ZANO" ? "fUSD" : "ZANO";
    // Update coin icons
    const coinFrom = $("swapCoinFrom");
    const coinTo   = $("swapCoinTo");
    const isZano = fromEl.value === "ZANO";
    [coinFrom, coinTo].forEach((el, i) => {
      if (!el) return;
      const showZano = i === 0 ? isZano : !isZano;
      const img = el.querySelector("img");
      if (img) {
        img.src = showZano ? "./assets/zano-icon-white.svg" : "./assets/fusd.png";
        img.alt = showZano ? "ZANO" : "fUSD";
      }
      el.classList.toggle("swapCoin--zano", showZano);
      el.classList.toggle("swapCoin--fusd", !showZano);
    });
  }

  function updateSwapBalanceHint() {
    const ticker = swapFromTicker();
    const assetId = ticker === "ZANO" ? ZANO_ASSET_ID : FUSD_ASSET_ID;
    const el = $("swapFromBalance");
    if (!el) return;
    const dp = state.assetsById.get(assetId)?.decimalPoint ?? 12;
    const unlocked = state.balancesById.get(assetId)?.unlockedAtomic ?? 0n;
    el.textContent = `Available: ${atomicToZanoString(unlocked, dp)} ${ticker}`;
  }

  function updateSwapDenomToggleUi() {
    const pill = $("swapDenomToggle");
    if (!pill) return;
    const price = getZanoPriceUsd();
    pill.disabled = !price;
    if (_swapDenomMode === "USD") {
      // Currently in USD mode — pill shows "USD" (click to go back to token)
      pill.textContent = "USD";
      pill.classList.add("active");
    } else {
      // Currently in ASSET mode — pill shows "$" (click to switch to USD)
      pill.textContent = "$";
      pill.classList.remove("active");
    }
  }

  // Probe rate API when swap view opens to pre-load min/max limits
  async function preloadSwapLimits() {
    const from = swapFromTicker();
    const to   = swapToTicker();
    try {
      const data = await swapGetRate(from, to, 1);
      if (!data) return;
      _swapLastRate = data;
      const limitsRow = $("swapLimitsRow");
      const minEl = $("swapMinLimit");
      const maxEl = $("swapMaxLimit");
      if (!limitsRow || !minEl || !maxEl) return;
      const min = data.minAmount;
      const max = data.maxAmount;
      if (min != null || max != null) {
        limitsRow.style.display = "flex";
        minEl.textContent = min != null ? `${min} ${from}` : "—";
        maxEl.textContent = max != null ? `${max} ${from}` : "—";
        minEl.classList.remove("error");
        maxEl.classList.remove("error");
      }
    } catch { /* silent — limits will load after user types */ }
  }

  // Convert input value to effective token amount (float) for API calls
  function getSwapTokenAmount() {
    const raw = parseFloat($("swapFromAmount")?.value);
    if (!raw || Number.isNaN(raw) || raw <= 0) return 0;
    if (_swapDenomMode === "USD") {
      const ticker = swapFromTicker();
      if (ticker === "fUSD") return raw; // 1:1
      const price = getZanoPriceUsd();
      return price ? raw / price : 0;
    }
    return raw;
  }

  // Dual display: show the "other" denomination below the input
  function updateSwapDualDisplay(tokenAmountAtomic) {
    const fromSubEl = $("swapFromSub");
    const dp = getSwapFromDp();
    const ticker = swapFromTicker();
    const tokenStr = atomicToZanoString(tokenAmountAtomic, dp);
    const tokenNum = Number(tokenStr) || 0;
    const price = getZanoPriceUsd();

    if (!fromSubEl) return;

    if (_swapDenomMode === "USD") {
      // Input is USD → show token equivalent (truncate to 6 decimals for readability)
      const shortToken = tokenNum > 0 ? parseFloat(tokenNum.toFixed(6)) : 0;
      fromSubEl.textContent = shortToken > 0 ? `≈ ${shortToken} ${ticker}` : "";
    } else {
      // Input is token → show USD equivalent
      if (ticker === "fUSD") {
        fromSubEl.textContent = tokenNum > 0 ? `≈ $${tokenNum.toFixed(2)} USD` : "";
      } else if (price && tokenNum > 0) {
        fromSubEl.textContent = `≈ $${(tokenNum * price).toFixed(2)} USD`;
      } else {
        fromSubEl.textContent = "";
      }
    }
  }

  function updateSwapToDisplay(toAmount) {
    const toSubEl = $("swapToSub");
    if (!toSubEl) return;
    const toTicker = swapToTicker();
    const amt = Number(toAmount) || 0;
    if (amt <= 0) { toSubEl.textContent = ""; return; }
    const price = getZanoPriceUsd();
    if (toTicker === "fUSD") {
      toSubEl.textContent = `≈ $${amt.toFixed(2)} USD`;
    } else if (price) {
      toSubEl.textContent = `≈ $${(amt * price).toFixed(2)} USD`;
    } else {
      toSubEl.textContent = "";
    }
  }

  function updateSwapRateInfo(data) {
    const el = $("swapRateInfo");
    if (!el) return;
    const rate = data?.rate;
    if (rate && Number(rate) > 0) {
      el.textContent = `1 ${swapFromTicker()} ≈ ${rate} ${swapToTicker()}`;
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  }

  function updateSwapLimits(data, currentTokenAmount) {
    const limitsRow = $("swapLimitsRow");
    const minEl = $("swapMinLimit");
    const maxEl = $("swapMaxLimit");
    if (!limitsRow || !minEl || !maxEl) return;

    const min = data?.minAmount;
    const max = data?.maxAmount;
    const ticker = swapFromTicker();

    // Always show the limits row
    minEl.textContent = min != null ? `${min} ${ticker}` : "—";
    maxEl.textContent = max != null ? `${max} ${ticker}` : "—";

    // Validate and highlight errors
    const belowMin = min != null && currentTokenAmount > 0 && currentTokenAmount < Number(min);
    const aboveMax = max != null && currentTokenAmount > Number(max);
    minEl.classList.toggle("error", belowMin);
    maxEl.classList.toggle("error", aboveMax);

    if (belowMin || aboveMax) {
      setSwapExecuteEnabled(false);
    }
  }

  function refreshSwapAmountDetails(amountAtomic) {
    const assetId = getSwapFromAssetId();
    const dp = getSwapFromDp();
    const ticker = swapFromTicker();
    const total = state.balancesById.get(assetId)?.totalAtomic ?? 0n;
    const unlocked = state.balancesById.get(assetId)?.unlockedAtomic ?? 0n;
    const maxAtomic = getSwapMaxAtomicForFrom() ?? 0n;

    $("swapTotalBalance") && setText($("swapTotalBalance"), `${atomicToZanoString(total, dp)} ${ticker}`);
    $("swapUnlockedBalance") && setText($("swapUnlockedBalance"), `${atomicToZanoString(unlocked, dp)} ${ticker}`);
    $("swapMaxAfterFee") && setText($("swapMaxAfterFee"), `${atomicToZanoString(maxAtomic, dp)} ${ticker}`);

    const feeZano = atomicToZanoString(FEE_ATOMIC, 12);
    if (ticker === "ZANO") {
      $("swapFeeReserveText") && setText($("swapFeeReserveText"), `Fee/burn reserve: ${feeZano} ZANO`);
      const afterFee = amountAtomic > FEE_ATOMIC ? (amountAtomic - FEE_ATOMIC) : 0n;
      $("swapAmountAfterFees") && setText($("swapAmountAfterFees"), `${atomicToZanoString(afterFee, dp)} ${ticker}`);
    } else {
      $("swapFeeReserveText") && setText($("swapFeeReserveText"), `Requires unlocked ZANO fee reserve: ${feeZano} ZANO`);
      $("swapAmountAfterFees") && setText($("swapAmountAfterFees"), `${atomicToZanoString(amountAtomic, dp)} ${ticker}`);
    }

    if ($("swapBalanceInfo")) $("swapBalanceInfo").style.display = "block";
  }

  function resetSwapUi() {
    _swapDenomMode = "ASSET";
    _swapLastRate = null;
    $("swapFromAmount").value = "";
    $("swapToAmount").value = "";
    $("swapRate").textContent = "";
    const fromSub = $("swapFromSub"); if (fromSub) fromSub.textContent = "";
    const toSub = $("swapToSub"); if (toSub) toSub.textContent = "";
    const rateInfo = $("swapRateInfo"); if (rateInfo) rateInfo.style.display = "none";
    // Clear error highlights on limits but keep the row visible — re-probe for new direction
    const minEl = $("swapMinLimit"); if (minEl) { minEl.classList.remove("error"); minEl.textContent = "…"; }
    const maxEl = $("swapMaxLimit"); if (maxEl) { maxEl.classList.remove("error"); maxEl.textContent = "…"; }
    const limitsRow = $("swapLimitsRow"); if (limitsRow) limitsRow.style.display = "flex";
    if ($("swapBalanceInfo")) $("swapBalanceInfo").style.display = "none";
    setSwapExecuteEnabled(false);
    updateSwapDenomToggleUi();
    preloadSwapLimits();
  }

  function onSwapAmountChange() {
    const swapAmtEl = $("swapFromAmount");
    if (!swapAmtEl) return;
    const dp = getSwapFromDp();
    const maxAtomic = getSwapMaxAtomicForFrom();

    // Resolve effective token amount based on denomination mode
    const tokenAmount = getSwapTokenAmount();
    if (!tokenAmount || tokenAmount <= 0) {
      $("swapToAmount").value = "";
      if ($("swapBalanceInfo")) $("swapBalanceInfo").style.display = "none";
      setSwapExecuteEnabled(false);
      $("swapRate").textContent = "";
      const fromSub = $("swapFromSub"); if (fromSub) fromSub.textContent = "";
      const toSub = $("swapToSub"); if (toSub) toSub.textContent = "";
      return;
    }

    let amountAtomic = parseAmountToAtomic(String(tokenAmount), dp);

    // Hard-cap to max if over
    if (maxAtomic != null && amountAtomic > maxAtomic) {
      amountAtomic = maxAtomic;
      const maxTokenStr = atomicToZanoString(maxAtomic, dp);
      if (_swapDenomMode === "USD") {
        const price = getZanoPriceUsd();
        const ticker = swapFromTicker();
        if (ticker === "fUSD") {
          swapAmtEl.value = maxTokenStr;
        } else if (price) {
          swapAmtEl.value = String((Number(maxTokenStr) * price).toFixed(2));
        }
      } else {
        swapAmtEl.value = maxTokenStr;
      }
    }

    setSwapExecuteEnabled(true);
    refreshSwapAmountDetails(amountAtomic);
    updateSwapDualDisplay(amountAtomic);

    // USD equivalent in the TO panel header
    const price = getZanoPriceUsd();
    const tokenNum = Number(atomicToZanoString(amountAtomic, dp)) || 0;
    const ticker = swapFromTicker();
    if (ticker === "fUSD") {
      $("swapRate").textContent = tokenNum > 0 ? `≈ $${tokenNum.toFixed(2)} USD` : "";
    } else if (price && tokenNum > 0) {
      $("swapRate").textContent = `≈ $${(tokenNum * price).toFixed(2)} USD`;
    } else {
      $("swapRate").textContent = "";
    }

    // Re-validate against last known limits
    if (_swapLastRate) {
      updateSwapLimits(_swapLastRate, tokenNum);
    }

    // Debounced rate fetch — always pass token amount to API
    const from = swapFromTicker();
    const to = swapToTicker();
    if (_rateTimer) clearTimeout(_rateTimer);
    _rateTimer = setTimeout(async () => {
      try {
        const data = await swapGetRate(from, to, tokenNum);
        _swapLastRate = data;
        const toAmt = data?.toAmount ?? data?.amountTo ?? data?.destination_amount;
        $("swapToAmount").value = toAmt != null ? String(toAmt) : "";
        updateSwapToDisplay(toAmt);
        updateSwapRateInfo(data);
        updateSwapLimits(data, tokenNum);
      } catch {
        $("swapToAmount").value = "";
        const toSub = $("swapToSub"); if (toSub) toSub.textContent = "";
      }
    }, 200);
  }

  // Input sanitizer for type="text" — allow digits and one decimal point
  $("swapFromAmount")?.addEventListener("input", (e) => {
    let v = e.target.value.replace(/[^0-9.]/g, "");
    const parts = v.split(".");
    if (parts.length > 2) v = parts[0] + "." + parts.slice(1).join("");
    if (v !== e.target.value) e.target.value = v;
    onSwapAmountChange();
  });

  // Denomination toggle
  $("swapDenomToggle")?.addEventListener("click", () => {
    const price = getZanoPriceUsd();
    if (!price) return;
    const swapAmtEl = $("swapFromAmount");
    const currentVal = parseFloat(swapAmtEl?.value) || 0;
    const ticker = swapFromTicker();

    if (_swapDenomMode === "ASSET") {
      // ASSET → USD: convert token amount to USD
      _swapDenomMode = "USD";
      if (currentVal > 0) {
        const usd = ticker === "fUSD" ? currentVal : currentVal * price;
        swapAmtEl.value = usd.toFixed(2);
      }
    } else {
      // USD → ASSET: convert USD amount to token
      _swapDenomMode = "ASSET";
      if (currentVal > 0) {
        const token = ticker === "fUSD" ? currentVal : currentVal / price;
        swapAmtEl.value = String(parseFloat(token.toFixed(6)));
      }
    }
    updateSwapDenomToggleUi();
    onSwapAmountChange();
  });

  // Asset change handler
  $("swapFromAsset")?.addEventListener("change", () => {
    syncSwapSelectors();
    updateSwapBalanceHint();
    resetSwapUi();
  });

  // Flip handler
  $("btnSwapFlip")?.addEventListener("click", () => {
    const fromEl = $("swapFromAsset");
    if (!fromEl) return;
    fromEl.value = fromEl.value === "ZANO" ? "fUSD" : "ZANO";
    syncSwapSelectors();
    updateSwapBalanceHint();
    resetSwapUi();
    // Trigger coin flip + panel flash animation
    [$("swapCoinFrom"), $("swapCoinTo")].forEach(el => {
      if (!el) return;
      el.classList.remove("coinFlip");
      void el.offsetWidth; // force reflow to restart animation
      el.classList.add("coinFlip");
      setTimeout(() => el.classList.remove("coinFlip"), 600);
    });
    document.querySelectorAll(".swapPanel").forEach(el => {
      el.classList.remove("panelFlash");
      void el.offsetWidth;
      el.classList.add("panelFlash");
      setTimeout(() => el.classList.remove("panelFlash"), 500);
    });
  });

  // Wheel scroll
  $("swapFromAmount")?.addEventListener("wheel", (e) => {
    e.preventDefault();
    const swapAmtEl = $("swapFromAmount");
    if (!swapAmtEl) return;
    const STEP = _swapDenomMode === "USD" ? 1 : 0.1;
    const precision = _swapDenomMode === "USD" ? 100 : 10;
    const current = parseFloat(swapAmtEl.value) || 0;
    const delta = e.deltaY > 0 ? -STEP : STEP;
    let next = Math.round(Math.max(0, current + delta) * precision) / precision;

    // Cap to max in token terms
    if (_swapDenomMode !== "USD") {
      const dp = getSwapFromDp();
      const maxAtomic = getSwapMaxAtomicForFrom();
      if (maxAtomic != null) {
        const maxNum = Number(atomicToZanoString(maxAtomic, dp));
        if (Number.isFinite(maxNum)) next = Math.min(next, maxNum);
      }
    }
    swapAmtEl.value = next > 0 ? String(next) : "";
    onSwapAmountChange();
  }, { passive: false });

  // Max button
  $("btnSwapMax")?.addEventListener("click", () => {
    const dp = getSwapFromDp();
    const maxAtomic = getSwapMaxAtomicForFrom();
    if (maxAtomic == null || maxAtomic <= 0n) {
      $("swapFromAmount").value = "";
      onSwapAmountChange();
      return;
    }
    const maxTokenStr = atomicToZanoString(maxAtomic, dp);
    if (_swapDenomMode === "USD") {
      const price = getZanoPriceUsd();
      const ticker = swapFromTicker();
      if (ticker === "fUSD") {
        $("swapFromAmount").value = maxTokenStr;
      } else if (price) {
        $("swapFromAmount").value = (Number(maxTokenStr) * price).toFixed(2);
      } else {
        $("swapFromAmount").value = maxTokenStr;
      }
    } else {
      $("swapFromAmount").value = maxTokenStr;
    }
    onSwapAmountChange();
  });

  function setText(id, val) {
    const el = $(id);
    if (el) el.textContent = val ?? "";
  }

  function renderSwapStatus(data) {
    const area = $("swapStatus");
    if (!area) return;
    area.classList.remove("hidden");

    const st = data.status || "wait";
    if (TERMINAL_STATUSES.has(st)) clearSwapStorage();
    area.classList.toggle("swapActive", !TERMINAL_STATUSES.has(st));
    const meta = _swapMeta || {};

    // Step badge + title
    const STEP_MAP = {
      wait:         { n: 1, of: 4, label: "Waiting for deposit" },
      confirmation: { n: 2, of: 4, label: "Confirming" },
      exchanging:   { n: 3, of: 4, label: "Exchanging" },
      sending:      { n: 4, of: 4, label: "Sending" },
      success:      { n: 4, of: 4, label: "Complete ✓" },
      overdue:      { n: 1, of: 4, label: "Overdue" },
      error:        { n: 1, of: 4, label: "Error" },
      refund:       { n: 1, of: 4, label: "Refunding" },
      refunded:     { n: 1, of: 4, label: "Refunded" },
    };
    const step = STEP_MAP[st] || { n: 1, of: 4, label: st };
    setText("swapStepBadge", `${step.n} OF ${step.of}`);
    setText("swapStepTitle", step.label);

    // Exolix link — opens in system browser via setWindowOpenHandler in main.js
    const link = $("swapExolixLink");
    if (link && meta.id) {
      link.href = `https://exolix.com/transaction/${meta.id}`;
      link.style.display = "";
    }

    // Rate + TX ID row
    const rateVal = data.rate ?? meta.rate;
    if (rateVal) setText("swapTxRate", `1 ${meta.from} ≈ ${rateVal} ${meta.to}`);
    setText("swapTxId", meta.id || "");

    // You send / You receive
    setText("swapTxAmountFrom", meta.amount ?? "");
    setText("swapTxCoinFrom", meta.from ?? "");
    setText("swapTxAmountTo", data.amountTo ?? meta.amountTo ?? "");
    setText("swapTxCoinTo", meta.to ?? "");

    // Addresses (truncated)
    const trunc = (a) => a ? `${a.slice(0, 8)}…${a.slice(-6)}` : "";
    setText("swapTxDepositAddr", trunc(meta.depositAddress));
    setText("swapTxWithdrawAddr", trunc(meta.withdrawalAddress));

    // Confirmation count + fill bar
    const conf    = data.confirmations ?? 0;
    const confReq = data.confirmationsRequired ?? 10;
    setText("swapConfirmCount", `${conf}/${confReq}`);
    const fill = $("swapStep1Fill");
    if (fill) fill.style.width = `${Math.min(100, (conf / confReq) * 100)}%`;

    // Highlight active step
    const ACTIVE_STEP = { wait: 1, confirmation: 1, exchanging: 2, sending: 3, success: 3 };
    const activeN = ACTIVE_STEP[st] ?? 1;
    [1, 2, 3].forEach(n => {
      const el = $(`swapStep${n}`);
      if (!el) return;
      el.classList.toggle("swapStepActive", n === activeN);
      el.classList.toggle("swapStepDone", n < activeN || st === "success");
    });
  }

  function resetSwapStatus() {
    $("swapStatus")?.classList.add("hidden");
    $("swapStatus")?.classList.remove("swapActive");
    const link = $("swapExolixLink");
    if (link) { link.href = "#"; link.style.display = ""; }
    _swapMeta = null;
    clearSwapStorage();
  }

  $("btnCopyTxId")?.addEventListener("click", () => {
    const id = $("swapTxId")?.textContent;
    if (id) navigator.clipboard.writeText(id).catch(() => {});
  });

  $("btnSwapExecute")?.addEventListener("click", async () => {
    if (_stopPoll) { _stopPoll(); _stopPoll = null; }
    resetSwapStatus();
    const logEl = $("swapLog");
    if (logEl) logEl.textContent = "";

    // Always resolve to token amount for the exchange
    const tokenAmt = getSwapTokenAmount();
    if (!tokenAmt || tokenAmt <= 0) { appendLog(logEl, "Enter an amount to swap."); return; }

    const from = swapFromTicker();
    const to   = swapToTicker();

    let withdrawalAddress = "";
    try {
      withdrawalAddress = await showBaseAddress() || "";
    } catch (addrErr) {
      log.warn("showBaseAddress failed:", addrErr?.message);
    }
    if (!withdrawalAddress) {
      appendLog(logEl, "Wallet not ready. Unlock and wait for the backend to finish syncing, then try again.");
      return;
    }

    setUiBusy(true, "Creating exchange…");
    try {
      const healthy = await swapHealthCheck();
      if (!healthy) { appendLog(logEl, "Swap service is unreachable. Ensure the swap backend is running."); return; }

      const ex = await createExchange(from, to, tokenAmt, withdrawalAddress);
      const exchangeId    = ex.id;
      const depositAddr   = ex.depositAddress || ex.deposit_address || "";
      const depositAmount = ex.amount ?? ex.depositAmount ?? tokenAmt;

      if (!depositAddr) {
        appendLog(logEl, "Exchange created but no deposit address returned. Aborting.");
        resetSwapStatus();
        return;
      }

      // Store exchange metadata so renderSwapStatus can populate the card
      _swapMeta = {
        id: exchangeId,
        from,
        to,
        amount: depositAmount,
        amountTo: ex.amountTo,
        rate: ex.rate,
        depositAddress: depositAddr,
        withdrawalAddress,
        txHash: "",
      };
      saveSwapToStorage(_swapMeta);
      renderSwapStatus({ status: "wait", confirmations: 0, confirmationsRequired: 10 });

      const fromAssetId = from === "ZANO" ? ZANO_ASSET_ID : FUSD_ASSET_ID;
      const fromInfo = KNOWN_ASSETS[fromAssetId] || { decimalPoint: 12 };
      const dp = fromInfo.decimalPoint ?? 12;
      const amountAtomic = parseAmountToAtomic(String(depositAmount), dp);

      if (amountAtomic <= 0n) {
        appendLog(logEl, "Invalid deposit amount from exchange. Aborting.");
        resetSwapStatus();
        return;
      }

      let transferRes;
      try {
        transferRes = await walletRpc("transfer", {
          destinations: [{ address: depositAddr, amount: amountAtomic.toString(), asset_id: fromAssetId }],
          fee:          FEE_ATOMIC.toString(),
          mixin:        MIXIN,
          hide_receiver: true,
          push_payer:   false,
        });
      } catch (txErr) {
        appendLog(logEl, `Transfer failed: ${txErr.message || "unknown error"}. Your funds are safe.`);
        resetSwapStatus();
        return;
      }

      const txHash = transferRes?.result?.tx_details?.id || transferRes?.result?.tx_hash || "";
      if (!txHash) {
        appendLog(logEl, "Transfer to exchange deposit failed. Your funds are safe.");
        if (transferRes?.error) appendLog(logEl, `RPC error: ${transferRes.error.message || JSON.stringify(transferRes.error)}`);
        resetSwapStatus();
        return;
      }

      if (_swapMeta) { _swapMeta.txHash = txHash; saveSwapToStorage(_swapMeta); }

      _stopPoll = pollExchange(exchangeId, renderSwapStatus);
    } catch (err) {
      appendLog(logEl, err.message || "Exchange failed.");
      resetSwapStatus();
    } finally {
      setUiBusy(false);
    }
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
  // Kick off price fetch immediately — result is cached so warmup hits it instantly
  fetchPricesOnce().catch(() => {});
  const cfg = await window.zano.configGet().catch(() => ({}));
  let lastWalletPath = String(cfg?.lastWalletPath || "").trim();
  const defaultWalletPath = await getDefaultWalletPath();

  $("unlockOverlay")?.classList.add("hidden");
  stopNeural();

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
      // Pre-resolve config + exe path while user is typing their password (~200ms saved)
      prewarmStartupCache().catch(() => {});
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
  if (sw?.status === "running") {
    const nodeLabel = await getCurrentNodeLabel();
    setConnectionStatus({ phase: "connected", nodeLabel });
  } else {
    startDaemonPreflight();
  }

  window.zano.onSimplewalletState((st) => {
    const raw = st?.status || "stopped";
    stopDaemonPreflight();
    if (raw !== "running") _warmupToken++;
    getCurrentNodeLabel().then((nodeLabel) => {
      if (raw === "running") {
        setConnectionStatus({ phase: "connected", nodeLabel, detail: "wallet_ready" });
        return;
      }

      if (raw === "starting" || raw === "stopping") {
        const ms = parseSimplewalletMilestone(st?.stdoutTail, st?.stderrTail);
        setConnectionStatus({
          phase: "connecting",
          nodeLabel,
          subtext: ms?.subtext || (raw === "stopping" ? "Stopping wallet…" : "Starting wallet…"),
          detail: ms?.detail || "wallet_starting",
        });
        return;
      }

      setConnectionStatus({ phase: "offline", nodeLabel, detail: "daemon_bad" });
    }).catch(() => setStatus(raw));
    if (st?.status === "running" && st?.rpcUrl && getSessionPassword()) {
      playStartupSoundOnce();
    }
    if (st?.status === "stopped" && st?.lastError)  appendLog($("logArea"), `simplewallet error: ${st.lastError}`);
    if (st?.status === "stopped" && typeof st?.lastExitCode === "number" && st.lastExitCode !== null && st.lastExitCode !== 0) {
      appendLog($("logArea"), `simplewallet exit code: ${st.lastExitCode}`);
    }
  });

  wireUi();
  setupTooltips();
  refreshLocateButtonVis().catch(() => {});

  $("btnUnlock")?.addEventListener("click", unlockAndAutoStart);
  $("btnUnlockClose")?.addEventListener("click", () => { $("unlockOverlay")?.classList.add("hidden"); stopNeural(); });
  $("btnUnlockChooseWallet")?.addEventListener("click", async () => {
    try {
      const res = await window.zano.openFileDialog({
        properties: ["openFile"],
        filters: [{ name: "Zano wallet", extensions: ["zan"] }],
      });
      const filePath = res?.filePaths?.[0];
      if (!filePath) return;
      state.currentWalletFile = filePath;
      $("inputWalletFile") && ($("inputWalletFile").value = filePath);
      await window.zano.simplewalletStop().catch(() => {});
      clearWalletHistoryState();
      await window.zano.configSet({ lastWalletPath: filePath }).catch(() => {});
      showUnlockOverlay("Enter your wallet password to unlock this wallet.");
    } catch {}
  });
  $("btnUnlockCreateNew")?.addEventListener("click", () => {
    $("unlockOverlay")?.classList.add("hidden");
    stopNeural();
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

