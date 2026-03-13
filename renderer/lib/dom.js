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

export function appendLog(el, line) {
  if (!el) return;
  const s = typeof line === "string" ? line : JSON.stringify(line, null, 2);
  el.textContent = (el.textContent ? el.textContent + "\n" : "") + s;
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
