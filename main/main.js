const { app, BrowserWindow } = require("electron");
const path = require("path");

const { tryMigrateFromOldAppName } = require("./config");
const sw = require("./simplewallet");
const ipc = require("./ipc");

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
