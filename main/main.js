const { app, BrowserWindow, protocol } = require("electron");
const path = require("path");
const fs = require("fs");

const { getResourcesDir, tryMigrateFromOldAppName } = require("./config");
const sw = require("./simplewallet");
const ipc = require("./ipc");

// Must run before app.ready.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createMainWindow() {
  const win = new BrowserWindow({
    width: 860,
    height: 720,
    backgroundColor: "#07172a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return win;
}

app.whenReady().then(() => {
  tryMigrateFromOldAppName();

  const resourcesDir = getResourcesDir();
  protocol.handle("app", (request) => {
    let filename;
    try {
      const u = new URL(request.url);
      const match = /^\/resources\/(.+)$/.exec(u.pathname);
      if (!match) return new Response("Not Found", { status: 404 });
      filename = match[1].replace(/\?.*$/, "");
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (filename.includes("..") || path.isAbsolute(filename)) return new Response("Forbidden", { status: 403 });
    const filePath = path.join(resourcesDir, filename);
    const resolved = path.resolve(filePath);
    const resolvedDir = path.resolve(resourcesDir);
    if (!resolved.startsWith(resolvedDir) || !fs.existsSync(filePath)) return new Response("Not Found", { status: 404 });
    try {
      return new Response(fs.readFileSync(filePath), { headers: { "Content-Type": "audio/mpeg" } });
    } catch {
      return new Response("Error reading file", { status: 500 });
    }
  });

  const mainWindow = createMainWindow();
  sw.init(mainWindow);
  ipc.init(mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createMainWindow();
      sw.init(win);
      ipc.init(win);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  sw.stopSimplewallet();
});
