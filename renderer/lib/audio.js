import { createLogger } from "./logger.js";
import { AUDIO_VOLUME } from "./constants.js";
import { state } from "./state.js";

const log = createLogger("audio");

const SOUNDS = {
  startup: { audioKey: "startupAudio", src: "./assets/zano_nova__startup.mp3" },
  send:    { audioKey: "sendAudio",    src: "./assets/zano_nova_send2.mp3" },
  receive: { audioKey: "receiveAudio", src: "./assets/zano__nova_recieved.mp3" },
};

async function playSound(type) {
  if (!state.soundEnabled) return;
  const cfg = SOUNDS[type];
  if (!cfg) return;
  try {
    if (!state[cfg.audioKey]) {
      state[cfg.audioKey] = new Audio(cfg.src);
      state[cfg.audioKey].preload = "auto";
    }
    const audio = state[cfg.audioKey];
    audio.pause();
    audio.currentTime = 0;
    audio.volume = AUDIO_VOLUME;
    log.debug("playing", type);
    await audio.play().catch(() => {});
  } catch {
    // ignore audio errors
  }
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

/**
 * Load + silently play send/receive audio at volume 0 so the browser
 * has them buffered before the first real playback.
 */
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
