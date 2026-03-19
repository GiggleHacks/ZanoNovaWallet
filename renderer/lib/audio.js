import { createLogger } from "./logger.js";
import { state } from "./state.js";

const log = createLogger("audio");

export const SOUNDS = {
  startup: { audioKey: "startupAudio", src: "./assets/zano_nova__startup.mp3", label: "Startup" },
  send:    { audioKey: "sendAudio",    src: "./assets/zano_nova_send3.mp3",    label: "Send" },
  receive: { audioKey: "receiveAudio", src: "./assets/zano__nova_recieved.mp3", label: "Receive" },
  seed:    { audioKey: "seedAudio",    src: "./assets/seed.mp3",              label: "Seed phrase" },
};

function getVolume() {
  return Math.max(0, Math.min(1, state.soundVolume ?? 0.9));
}

function isSoundEnabled(type) {
  if (!state.soundEnabled) return false;
  return state.soundToggles?.[type] !== false;
}

function getOrCreateAudio(type) {
  const cfg = SOUNDS[type];
  if (!cfg) return null;
  if (!state[cfg.audioKey]) {
    state[cfg.audioKey] = new Audio(cfg.src);
    state[cfg.audioKey].preload = "auto";
  }
  return state[cfg.audioKey];
}

async function _playAudioEl(audio, label) {
  try {
    audio.pause();
    audio.currentTime = 0;
    audio.volume = getVolume();
    log.debug(label);
    await audio.play().catch(() => {});
  } catch {
    // ignore audio errors
  }
}

async function playSound(type) {
  if (!isSoundEnabled(type)) return;
  const audio = getOrCreateAudio(type);
  if (!audio) return;
  await _playAudioEl(audio, `playing ${type}`);
}

/**
 * Preview a sound at the current volume, ignoring enable/disable state.
 */
export async function previewSound(type) {
  const audio = getOrCreateAudio(type);
  if (!audio) return;
  await _playAudioEl(audio, `previewing ${type}`);
}

export async function playStartupSoundOnce() {
  if (state.startupSoundPlayed) return;
  state.startupSoundPlayed = true;
  await playSound("startup");
}

export async function playSendSound() {
  await playSound("send");
}

export async function playReceiveSound() {
  await playSound("receive");
}

export async function playSeedSound() {
  await playSound("seed");
}

export async function prewarmSoundsIfNeeded() {
  if (state.soundsPrewarmed || !state.soundEnabled) return;
  state.soundsPrewarmed = true;
  log.debug("prewarming sounds");
  try {
    for (const [type, cfg] of Object.entries(SOUNDS)) {
      if (type === "startup") continue;
      const audio = new Audio(cfg.src);
      audio.preload = "auto";
      audio.volume  = 0;
      await audio.play().catch(() => {});
      audio.pause();
      audio.currentTime = 0;
      state[cfg.audioKey] = audio;
    }
  } catch {
    // ignore prewarm errors
  }
}
