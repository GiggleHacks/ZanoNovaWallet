/**
 * Tagged, colorized console logger for DevTools.
 *
 * Usage:
 *   const log = createLogger("wallet");
 *   log.info("RPC started on", url);   // [wallet] RPC started on …
 *   log.warn("retry", attempt);
 *   log.error("fatal", err);
 *   log.debug("polling tick");          // only visible at 'debug' level
 */

const TAG_COLORS = {
  audio:  ["#6a0dad", "#fff"],
  wallet: ["#1565c0", "#fff"],
  rpc:    ["#00695c", "#fff"],
  ui:     ["#4a148c", "#fff"],
  state:  ["#e65100", "#fff"],
  init:   ["#1b5e20", "#fff"],
  send:   ["#880e4f", "#fff"],
  seed:   ["#37474f", "#fff"],
};

const LEVELS = ["debug", "info", "warn", "error"];
let _currentLevel = "info";

export function setLogLevel(level) {
  if (LEVELS.includes(level)) _currentLevel = level;
}

function shouldLog(level) {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(_currentLevel);
}

function emit(level, tag, args) {
  if (!shouldLog(level)) return;
  const [bg, fg] = TAG_COLORS[tag] ?? ["#455a64", "#fff"];
  const tagStyle = `background:${bg};color:${fg};padding:1px 6px;border-radius:3px;font-weight:bold`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`%c${tag}`, tagStyle, ...args);
}

export function createLogger(tag) {
  return {
    debug: (...args) => emit("debug", tag, args),
    info:  (...args) => emit("info",  tag, args),
    warn:  (...args) => emit("warn",  tag, args),
    error: (...args) => emit("error", tag, args),
  };
}
