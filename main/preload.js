const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zano", {
  getPaths: () => ipcRenderer.invoke("app:getPaths"),

  configGet: () => ipcRenderer.invoke("config:get"),
  configSet: (partial) => ipcRenderer.invoke("config:set", partial),

  simplewalletResolveExe: (overridePath) => ipcRenderer.invoke("simplewallet:resolveExe", overridePath),
  simplewalletStart: (opts) => ipcRenderer.invoke("simplewallet:start", opts),
  simplewalletStop: () => ipcRenderer.invoke("simplewallet:stop"),
  simplewalletState: () => ipcRenderer.invoke("simplewallet:state"),
  onSimplewalletState: (cb) => {
    ipcRenderer.removeAllListeners("simplewallet:state");
    ipcRenderer.on("simplewallet:state", (_evt, state) => cb(state));
  },

  walletGenerate: (opts) => ipcRenderer.invoke("wallet:generate", opts),
  walletRestore: (opts) => ipcRenderer.invoke("wallet:restore", opts),
  walletShowSeed: (opts) => ipcRenderer.invoke("wallet:showSeed", opts),
  walletRpc: (opts) => ipcRenderer.invoke("wallet:rpc", opts),
  walletQr: (text) => ipcRenderer.invoke("wallet:qr", { text }),

  openFileDialog: (opts) => ipcRenderer.invoke("dialog:openFile", opts),
});

