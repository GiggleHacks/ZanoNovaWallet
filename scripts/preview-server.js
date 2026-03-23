/**
 * Lightweight HTTP server that serves the renderer/ directory for Claude preview.
 * Injects a mock window.zano shim so the page loads without Electron IPC.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3199;
const RENDERER_DIR = path.join(__dirname, "..", "renderer");

const MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".mp3":  "audio/mpeg",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
};

/** Mock shim injected before </head> so app.js doesn't crash */
const MOCK_SHIM = `
<script>
// Mock window.zano for browser preview (no Electron IPC)
window.zano = {
  getPaths:       async () => ({ userData: "C:/mock", walletsDir: "C:/mock/wallets", walletPath: "C:/mock/wallets/default.wallet" }),
  configGet:      async () => ({ dataDir: "C:/mock", exePath: "simplewallet.exe", soundEnabled: true, volume: 70 }),
  configSet:      async () => {},

  daemonGetinfo:  async () => ({ ok: true, height: 100000, status: "OK" }),

  simplewalletResolveExe: async () => ({ resolved: "simplewallet.exe", candidates: ["simplewallet.exe"] }),
  simplewalletStart: async () => ({ ok: true, rpcUrl: "http://127.0.0.1:12111/json_rpc" }),
  simplewalletStop:  async () => {},
  simplewalletState: async () => ({ status: "running", rpcUrl: "http://127.0.0.1:12111/json_rpc" }),
  onSimplewalletState: () => {},

  suggestNewWalletPath: async (p) => p || "C:/mock/wallets/new.wallet",
  walletFileExists: async () => false,
  walletGenerate:   async () => ({ ok: true, output: "Wallet generated." }),
  walletRestore:    async () => ({ ok: true, output: "Wallet restored." }),
  walletShowSeed:   async () => ({ output: "seed phrase:\nabandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual" }),
  walletRpc:        async (opts) => {
    const method = typeof opts === "string" ? opts : opts?.method;
    if (method === "getaddress") return { ok: true, data: { result: { address: "ZxBvJDuGuEMinyNTMjFVHYkMPaAcjNY6dsXN6kp84KPbQQGUntJiTVFz3VqcQE8HaZNqLUqxNHQYQjdNgUen8D411SkZAVTkT" } } };
    if (method === "split_integrated_address") {
      const integrated = String(opts?.params?.integrated_address || "");
      const address = integrated.startsWith("Zx") ? integrated : "";
      return { ok: true, data: { result: { standard_address: address } } };
    }
    if (method === "getbalance") return { ok: true, data: { result: { balance: 9640000000000, unlocked_balance: 9640000000000, balances: [
      { asset_info: { asset_id: "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a", decimal_point: 12, ticker: "ZANO", full_name: "Zano" }, balance: 9640000000000, unlocked: 9640000000000 },
      { asset_info: { asset_id: "f525db4c1fda532fcc2b3cdd8a74be23b0deeac0ea5a9a25fb5d64b2dd62674b", decimal_point: 12, ticker: "fUSD", full_name: "fUSD stablecoin" }, balance: 72580000000000, unlocked: 72580000000000 },
    ] } } };
    if (method === "get_recent_txs_and_info3") return { ok: true, data: { result: { transfers: [], last_item_index: 0, total_transfers: 0, pi: { curent_height: 100000 } } } };
    if (method === "transfer") return { ok: true, data: { result: { tx_details: { id: "mockhash1234567890" } } } };
    return { ok: true, data: { result: {} } };
  },
  walletQr:       async () => ({ ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }),

  openFileDialog:  async () => null,
  saveWalletDialog: async () => null,

  swapRate:       async ({ from, to, amount }) => ({ toAmount: Number((amount * 7.28).toFixed(2)), rate: "7.28", minAmount: 0.5, maxAmount: 500 }),
  swapExchange:   async () => ({ id: "mock-ex-123", depositAddress: "ZxMOCKDEPOSIT", amount: 1, amountTo: "7.28", status: "wait" }),
  swapStatus:     async () => ({ id: "mock-ex-123", status: "wait", amount: 1, amountTo: "7.28" }),
};
</script>
`;

const server = http.createServer((req, res) => {
  let url = req.url.split("?")[0];
  if (url === "/") url = "/index.html";

  const filePath = path.join(RENDERER_DIR, url);

  // Security: don't escape renderer dir
  if (!filePath.startsWith(RENDERER_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";

    // Inject mock shim into HTML so the app doesn't crash without Electron
    if (ext === ".html") {
      let html = data.toString("utf8");
      html = html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';");
      html = html.replace("</head>", MOCK_SHIM + "\n</head>");
      res.writeHead(200, { "Content-Type": mime, "Content-Length": Buffer.byteLength(html) });
      res.end(html);
      return;
    }

    res.writeHead(200, { "Content-Type": mime, "Content-Length": data.length });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Preview server running at http://localhost:${PORT}`);
});
