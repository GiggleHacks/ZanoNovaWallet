const { app } = require("electron");
const path = require("path");
const fs = require("fs");

const DEFAULTS = Object.freeze({
  walletRpcBindIp: "127.0.0.1",
  walletRpcBindPort: 12233,
  daemonAddress: "64.111.93.25:10500",
  lastWalletPath: "",
  soundEnabled: true,
  soundVolume: 0.9,
  soundToggles: { startup: true, send: true, receive: true, seed: true },
  tooltipsEnabled: true,
  simplewalletExePath: "",
});

const APP_SUPPORT_DIR_NAME = "Zano Nova";

function getResourcesDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "resources")
    : path.join(app.getAppPath(), "resources");
}

function getDefaultWalletsDir() {
  return path.join(app.getPath("appData"), APP_SUPPORT_DIR_NAME, "wallets");
}

function simplewalletBinaryName() {
  return process.platform === "win32" ? "simplewallet.exe" : "simplewallet";
}

function getUserDataPaths() {
  const userData = app.getPath("userData");
  const walletsDir = getDefaultWalletsDir();
  const simplewalletRuntimeDir = path.join(userData, "simplewallet-runtime");
  return {
    userData,
    configPath: path.join(userData, "config.json"),
    walletsDir,
    walletPath: path.join(walletsDir, "wallet.zan"),
    resourcesDir: getResourcesDir(),
    simplewalletRuntimeDir,
    simplewalletRuntimePath:
      process.platform === "darwin"
        ? path.join(simplewalletRuntimeDir, "Contents", "MacOS", simplewalletBinaryName())
        : path.join(simplewalletRuntimeDir, simplewalletBinaryName()),
  };
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function getConfig() {
  const { configPath } = getUserDataPaths();
  return { ...DEFAULTS, ...(readJsonIfExists(configPath) || {}) };
}

function setConfig(partial) {
  const { configPath } = getUserDataPaths();
  const next = { ...getConfig(), ...partial };
  writeJson(configPath, next);
  return next;
}

function tryMigrateFromOldAppName() {
  const { walletPath: newWalletPath, walletsDir: newWalletsDir, configPath: newConfigPath } = getUserDataPaths();
  const currentUserData = app.getPath("userData");

  const appData = process.env.APPDATA;
  const oldUserData = appData ? path.join(appData, "zano-simple-wallet") : null;
  const legacyWalletDirs = [
    path.join(currentUserData, "wallets"),
    oldUserData ? path.join(oldUserData, "wallets") : null,
  ].filter(Boolean);
  const legacyConfigPaths = [
    oldUserData ? path.join(oldUserData, "config.json") : null,
  ].filter(Boolean);

  try {
    if (!fs.existsSync(newWalletPath)) {
      for (const legacyWalletDir of legacyWalletDirs) {
        if (!legacyWalletDir || path.resolve(legacyWalletDir) === path.resolve(newWalletsDir)) continue;
        if (!fs.existsSync(legacyWalletDir)) continue;
        const entries = fs.readdirSync(legacyWalletDir, { withFileTypes: true });
        if (!entries.length) continue;
        fs.mkdirSync(newWalletsDir, { recursive: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const src = path.join(legacyWalletDir, entry.name);
          const dest = path.join(newWalletsDir, entry.name);
          if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
        }
        break;
      }
    }

    if (!fs.existsSync(newConfigPath)) {
      for (const legacyConfigPath of legacyConfigPaths) {
        if (!legacyConfigPath || !fs.existsSync(legacyConfigPath)) continue;
        fs.mkdirSync(path.dirname(newConfigPath), { recursive: true });
        fs.copyFileSync(legacyConfigPath, newConfigPath);
        break;
      }
    }
  } catch {
    // ignore migration failures
  }
}

module.exports = {
  DEFAULTS,
  getResourcesDir,
  getDefaultWalletsDir,
  getUserDataPaths,
  getConfig,
  setConfig,
  simplewalletBinaryName,
  tryMigrateFromOldAppName,
};
