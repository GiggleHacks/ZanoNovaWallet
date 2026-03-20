#!/usr/bin/env node
// Zano Nova Exolix Proxy — zero dependencies
// Holds the Exolix API key server-side and forwards requests.

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const PORT = parseInt(process.env.PORT || "10501", 10);
const EXOLIX_BASE = "https://exolix.com/api/v2";
const API_KEY = process.env.EXOLIX_API_KEY || "";
const MAX_BODY = 4096;
const ALLOWED_COINS = new Set(["ZANO", "FUSD"]);

// ---------------------------------------------------------------------------
// Rate limiter (sliding window, per IP)
// ---------------------------------------------------------------------------
const _hits = new Map(); // ip -> [{ ts }]
const LIMITS = { GET: 30, POST: 5 }; // per minute
const WINDOW = 60_000;

function rateOk(ip, method) {
  const key = `${ip}:${method}`;
  const now = Date.now();
  let list = _hits.get(key) || [];
  list = list.filter((t) => now - t < WINDOW);
  const max = LIMITS[method] || 30;
  if (list.length >= max) { _hits.set(key, list); return false; }
  list.push(now);
  _hits.set(key, list);
  return true;
}

// Purge old entries every 5 min
setInterval(() => {
  const cutoff = Date.now() - WINDOW;
  for (const [key, list] of _hits) {
    const filtered = list.filter((t) => t > cutoff);
    if (filtered.length === 0) _hits.delete(key);
    else _hits.set(key, filtered);
  }
}, 300_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function log(ip, method, path, status) {
  const ts = new Date().toISOString();
  console.log(`${ts}  ${ip}  ${method} ${path}  -> ${status}`);
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on("data", (chunk) => {
      len += chunk.length;
      if (len > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function proxyToExolix(upstreamUrl, method, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(upstreamUrl);
    const opts = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: API_KEY } : {}),
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    };
    const upstream = https.request(opts, (upRes) => {
      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => resolve({ status: upRes.statusCode, headers: upRes.headers, body: Buffer.concat(chunks) }));
      upRes.on("error", reject);
    });
    upstream.on("error", reject);
    if (body) upstream.write(body);
    upstream.end();
  });
}

// ---------------------------------------------------------------------------
// Validate coin pairs in POST body
// ---------------------------------------------------------------------------
function validateCoins(bodyBuf) {
  try {
    const obj = JSON.parse(bodyBuf.toString());
    if (obj.coinFrom && !ALLOWED_COINS.has(obj.coinFrom)) return false;
    if (obj.coinTo && !ALLOWED_COINS.has(obj.coinTo)) return false;
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const path = parsed.pathname;

  // Rate limit
  if (!rateOk(ip, req.method)) {
    log(ip, req.method, path, 429);
    return json(res, 429, { error: "rate limit exceeded" });
  }

  try {
    // GET /rate?...
    if (req.method === "GET" && path === "/rate") {
      const upstream = `${EXOLIX_BASE}/rate${parsed.search}`;
      const r = await proxyToExolix(upstream, "GET", null);
      log(ip, req.method, path, r.status);
      res.writeHead(r.status, { "Content-Type": "application/json" });
      return res.end(r.body);
    }

    // POST /transactions
    if (req.method === "POST" && path === "/transactions") {
      const body = await readBody(req);
      if (!validateCoins(body)) {
        log(ip, req.method, path, 400);
        return json(res, 400, { error: "unsupported coin pair" });
      }
      const upstream = `${EXOLIX_BASE}/transactions`;
      const r = await proxyToExolix(upstream, "POST", body);
      log(ip, req.method, path, r.status);
      res.writeHead(r.status, { "Content-Type": "application/json" });
      return res.end(r.body);
    }

    // GET /transactions/:id
    const txMatch = path.match(/^\/transactions\/([a-zA-Z0-9]+)$/);
    if (req.method === "GET" && txMatch) {
      const upstream = `${EXOLIX_BASE}/transactions/${txMatch[1]}`;
      const r = await proxyToExolix(upstream, "GET", null);
      log(ip, req.method, path, r.status);
      res.writeHead(r.status, { "Content-Type": "application/json" });
      return res.end(r.body);
    }

    // Anything else → 404
    log(ip, req.method, path, 404);
    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(`ERROR ${ip} ${req.method} ${path}:`, err.message);
    log(ip, req.method, path, 502);
    json(res, 502, { error: "upstream error" });
  }
});

server.listen(PORT, () => {
  console.log(`Zano Nova Exolix proxy listening on :${PORT}`);
  if (!API_KEY) console.warn("WARNING: EXOLIX_API_KEY is not set!");
});
