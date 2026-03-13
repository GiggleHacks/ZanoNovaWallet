/** Cached getElementById lookups. */
const _elCache = {};

export function $(id) {
  if (id in _elCache) return _elCache[id];
  return (_elCache[id] = document.getElementById(id));
}

export function setText(el, text) {
  if (!el) return;
  el.textContent = text == null ? "" : String(text);
}

/**
 * Colorize rules — order matters, first match wins per line.
 * Each entry: [regex, css color].
 */
const LOG_COLORS = [
  [/\berror\b|fatal|EACCES|ENOENT|EPERM/i,    "var(--danger, #ff5c5c)"],
  [/\bwarn(?:ing)?\b/i,                         "var(--warning, #f0b429)"],
  [/\bstarting\b|started|generating|restoring/i, "var(--success, #34d399)"],
  [/simplewallet:|RPC|127\.0\.0\.1/,             "var(--aqua, #00e5ff)"],
  [/exit code|stopped|stop requested/i,          "var(--text-secondary, #8899aa)"],
];

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function colorizeLine(raw) {
  const safe = escapeHtml(raw);
  for (const [re, color] of LOG_COLORS) {
    if (re.test(raw)) return `<span style="color:${color}">${safe}</span>`;
  }
  return safe;
}

export function appendLog(el, line) {
  if (!el) return;
  const s = typeof line === "string" ? line : JSON.stringify(line, null, 2);
  const colored = s.split("\n").map(colorizeLine).join("\n");
  el.innerHTML = (el.innerHTML ? el.innerHTML + "\n" : "") + colored;
  el.scrollTop = el.scrollHeight;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Create a <div class="hint"> with the given text. */
export function makeHint(text) {
  const el = document.createElement("div");
  el.className = "hint";
  el.textContent = text;
  return el;
}
