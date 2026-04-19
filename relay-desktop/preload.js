const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relay", {
  getStatus:     ()        => ipcRenderer.invoke("get-status"),
  getLog:        ()        => ipcRenderer.invoke("get-log"),
  getConfig:     ()        => ipcRenderer.invoke("get-config"),
  saveConfig:    (cfg)     => ipcRenderer.invoke("save-config", cfg),
  start:         ()        => ipcRenderer.invoke("relay-start"),
  stop:          ()        => ipcRenderer.invoke("relay-stop"),
  restart:       ()        => ipcRenderer.invoke("relay-restart"),
  openWizard:    ()        => ipcRenderer.invoke("open-wizard"),
  wizardDone:    (cfg)     => ipcRenderer.invoke("wizard-done", cfg),
  testCamera:    (ip)      => ipcRenderer.invoke("test-camera", ip),
  openRelayDir:  ()        => ipcRenderer.invoke("open-relay-dir"),
  discoverCameras: ()       => ipcRenderer.invoke("discover-cameras"),
  openHelp:        ()       => ipcRenderer.invoke("open-help"),
  getPcIps:        ()       => ipcRenderer.invoke("get-pc-ips"),
  getLoginItem:  ()        => ipcRenderer.invoke("get-login-item"),
  setLoginItem:  (enabled) => ipcRenderer.invoke("set-login-item", enabled),
  onStatus:      (fn)      => ipcRenderer.on("status",      (_, d) => fn(d)),
  onLog:         (fn)      => ipcRenderer.on("log",         (_, d) => fn(d)),
  onLogHistory:  (fn)      => ipcRenderer.on("log-history", (_, d) => fn(d)),
});