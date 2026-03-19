const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");
const os = require("os");

// In dev, use a local userData path to avoid "Access is denied" cache errors when
// the project lives on OneDrive or another synced/restricted folder.
if (!app.isPackaged) {
  const devUserData = path.join(
    process.env.LOCALAPPDATA || process.env.TEMP || os.tmpdir(),
    "ZanoNovaDev"
  );
  app.setPath("userData", devUserData);
}

const { tryMigrateFromOldAppName } = require("./config");
const sw = require("./simplewallet");
const ipc = require("./ipc");

function createSplash() {
  const win = new BrowserWindow({
    width: 280,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "splash.html"));
  return win;
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 1000,
    show: false,
    backgroundColor: "#07172a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Open external links in the system browser, not an Electron popup
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  return win;
}

app.whenReady().then(() => {
  tryMigrateFromOldAppName();

  // Hide the default File/Edit/View/etc. menu bar in production
  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }

  const splash = app.isPackaged ? createSplash() : null;

  const mainWindow = createMainWindow();
  sw.init(mainWindow);
  ipc.init(mainWindow);

  mainWindow.once("ready-to-show", () => {
    if (splash && !splash.isDestroyed()) splash.close();
    mainWindow.show();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createMainWindow();
      sw.init(win);
      ipc.init(win);
      win.once("ready-to-show", () => win.show());
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// simplewallet is intentionally left running between sessions so the next
// launch can reuse it instantly via the port-detection logic in ipc.js.
// The user can stop it explicitly with the "Stop backend" button.
