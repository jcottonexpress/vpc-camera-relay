const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog } = require("electron");
const path  = require("path");
const fs    = require("fs");
const http  = require("http");
const { spawn, execSync } = require("child_process");

// ─── Paths ────────────────────────────────────────────────────────────────────
const RELAY_DIR  = app.isPackaged
  ? path.join(process.resourcesPath, "relay")
  : path.join(__dirname, "..", "camera-relay");

const RELAY_JS    = path.join(RELAY_DIR, "relay.js");
const CONFIG_PATH = path.join(RELAY_DIR, "relay-config.json");
const ICON_PATH   = path.join(__dirname, "assets", "icon.png");
const APP_ICON    = fs.existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : nativeImage.createEmpty();

const WEB_APP_URL = "https://vp-chef-studio.replit.app";

// ─── State ────────────────────────────────────────────────────────────────────
let tray          = null;
let wizardWin     = null;
let relayProc     = null;
let pollTimer     = null;
let logBuffer     = [];
let relayJsOverride = null;
let relayStatus = {
  running: false,
  serverConnected: false,
  cameras: [],
  recording: false,
};

// ─── Tray icon ────────────────────────────────────────────────────────────────
function makeTrayIcon() {
  if (!APP_ICON.isEmpty()) {
    return APP_ICON.resize({ width: 16, height: 16, quality: "good" });
  }
  return nativeImage.createEmpty();
}

// ─── Config helpers ───────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch { return null; }
}

function saveConfig(cfg) {
  fs.mkdirSync(RELAY_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

// ─── Locate bundled ffmpeg ────────────────────────────────────────────────────
function getBundledFfmpeg() {
  const ext = process.platform === "win32" ? ".exe" : "";
  const candidates = [];

  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, "bin", `ffmpeg${ext}`));
    candidates.push(
      path.join(__dirname, "bin", `ffmpeg${ext}`)
        .replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep)
    );
    try {
      const raw = require("ffmpeg-static");
      if (raw) candidates.push(raw.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep));
    } catch {}
  } else {
    try {
      const raw = require("ffmpeg-static");
      if (raw) candidates.push(raw);
    } catch {}
  }

  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// ─── Relay process management ─────────────────────────────────────────────────
function startRelay() {
  if (relayProc) return;

  const nodeBin = process.platform === "win32" ? "node.exe" : "node";

  const relayScript = (relayJsOverride && fs.existsSync(relayJsOverride))
    ? relayJsOverride
    : RELAY_JS;

  const ffmpegPath = getBundledFfmpeg();
  const relayEnv = { ...process.env };
  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    relayEnv.FFMPEG_PATH = ffmpegPath;
  }

  relayProc = spawn(nodeBin, [relayScript], {
    cwd: RELAY_DIR,
    env: relayEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  relayProc.stdout.on("data", (d) => {
    const line = d.toString();
    pushLog(line);
    parseRelayLine(line);
  });

  relayProc.stderr.on("data", (d) => {
    pushLog("[err] " + d.toString());
  });

  relayProc.on("exit", (code) => {
    pushLog(`[relay] Process exited (code ${code})`);
    relayProc = null;
    relayStatus.running = false;
    relayStatus.serverConnected = false;
    updateTray();
  });

  relayStatus.running = true;
  updateTray();
  startPolling();
}

function stopRelay(force = false) {
  stopPolling();
  if (!relayProc) return;
  try { relayProc.kill("SIGTERM"); } catch {}
  if (force) {
    try { relayProc.kill("SIGKILL"); } catch {}
    relayProc = null;
    return;
  }
  setTimeout(() => {
    if (relayProc) {
      try { relayProc.kill("SIGKILL"); } catch {}
      relayProc = null;
    }
  }, 2000);
}

function restartRelay() {
  stopRelay();
  setTimeout(startRelay, 1500);
}

// ─── Parse relay stdout for state ────────────────────────────────────────────
function parseRelayLine(line) {
  if (
    line.includes("Connected to VP Chef Studio") ||
    line.includes("Server ready. Streaming") ||
    line.includes("Connected to server") ||
    line.includes("✓ Connected")
  ) {
    relayStatus.serverConnected = true;
    updateTray();
  }
  if (
    line.includes("Connection lost") ||
    line.includes("✗ Connection") ||
    line.includes("Reconnecting") ||
    line.includes("WebSocket closed") ||
    line.includes("ws] Disconnected")
  ) {
    relayStatus.serverConnected = false;
    updateTray();
  }
  if (line.includes("record-start") || line.includes("▶ record")) {
    relayStatus.recording = true;
    updateTray();
  }
  if (line.includes("record-stop") || line.includes("Upload complete")) {
    relayStatus.recording = false;
    updateTray();
  }
}

// ─── Poll local relay HTTP endpoint ──────────────────────────────────────────
function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollStatus, 2500);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function pollStatus() {
  const req = http.get("http://localhost:8082/status", { timeout: 2000 }, (res) => {
    let body = "";
    res.on("data", (d) => body += d);
    res.on("end", () => {
      try {
        const data = JSON.parse(body);
        relayStatus.cameras = (data.cameras || []).map(c => ({
          slot:      c.slot,
          label:     c.label || `CAM ${c.slot}`,
          ip:        c.ip,
          frames:    c.frames || 0,
          connected: (c.frames || 0) > 0,
        }));
        relayStatus.serverConnected = data.serverConnected ?? relayStatus.serverConnected;
        relayStatus.recording       = data.recording       ?? relayStatus.recording;
        updateTray();
      } catch {}
    });
  });
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
}

function pushLog(line) {
  logBuffer.push(line.trimEnd());
  if (logBuffer.length > 300) logBuffer.shift();
}

// ─── System tray ─────────────────────────────────────────────────────────────
function buildTrayMenu() {
  const onlineCams = relayStatus.cameras.filter(c => c.connected).length;
  const statusLine = !relayStatus.running
    ? "VP Chef Relay — Stopped"
    : relayStatus.recording
    ? "VP Chef Relay — Recording"
    : relayStatus.serverConnected
    ? `VP Chef Relay — Connected`
    : "VP Chef Relay — Connecting…";

  const camLine = relayStatus.running && onlineCams > 0
    ? `${onlineCams}/3 cameras online`
    : null;

  return Menu.buildFromTemplate([
    { label: statusLine, enabled: false },
    ...(camLine ? [{ label: camLine, enabled: false }] : []),
    { type: "separator" },
    {
      label: relayStatus.running ? "Stop Relay" : "Start Relay",
      click: () => relayStatus.running ? stopRelay() : startRelay(),
    },
    { label: "Restart Relay", click: restartRelay },
    { type: "separator" },
    {
      label: "Open VP Chef Studio →",
      click: () => shell.openExternal(WEB_APP_URL),
    },
    {
      label: "Reconfigure Cameras…",
      click: () => showWizardWindow(),
    },
    { type: "separator" },
    { label: "Quit", click: () => { stopRelay(true); setTimeout(() => app.exit(0), 300); } },
  ]);
}

function updateTray() {
  if (!tray) return;
  const tip = !relayStatus.running            ? "VP Chef Relay — Stopped"
    : relayStatus.recording                   ? "VP Chef Relay — Recording"
    : relayStatus.serverConnected             ? "VP Chef Relay — Connected ✓"
    : "VP Chef Relay — Connecting…";
  tray.setToolTip(tip);
  tray.setContextMenu(buildTrayMenu());
}

// ─── Camera-settings wizard window ────────────────────────────────────────────
function showWizardWindow() {
  if (wizardWin && !wizardWin.isDestroyed()) {
    wizardWin.show(); wizardWin.focus(); return;
  }
  wizardWin = new BrowserWindow({
    width: 580, height: 600,
    title: "VP Chef Relay — Camera Setup",
    backgroundColor: "#0a0a0a",
    resizable: false,
    icon: APP_ICON.isEmpty() ? undefined : APP_ICON,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
    show: false,
  });
  wizardWin.loadFile(path.join(__dirname, "src", "wizard.html"));
  wizardWin.once("ready-to-show", () => wizardWin.show());
  wizardWin.on("closed", () => { wizardWin = null; });
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle("get-status",     () => relayStatus);
ipcMain.handle("get-log",        () => logBuffer);
ipcMain.handle("get-config",     () => loadConfig() || {});
ipcMain.handle("save-config",    (_, cfg) => { saveConfig(cfg); return true; });
ipcMain.handle("relay-start",    () => { startRelay(); return true; });
ipcMain.handle("relay-stop",     () => { stopRelay();  return true; });
ipcMain.handle("relay-restart",  () => { restartRelay(); return true; });
ipcMain.handle("open-wizard",    () => { showWizardWindow(); return true; });
ipcMain.handle("wizard-done",    (_, cfg) => {
  saveConfig(cfg);
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  if (wizardWin && !wizardWin.isDestroyed()) wizardWin.close();
  // After setup, open the web app so the user can monitor from there
  shell.openExternal(WEB_APP_URL);
  setTimeout(startRelay, 500);
  return true;
});
ipcMain.handle("get-login-item", () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle("set-login-item", (_, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
  return true;
});
ipcMain.handle("test-camera",    (_, ip) => testCamera(ip));
ipcMain.handle("open-relay-dir", () => { shell.openPath(RELAY_DIR); return true; });

// ─── Camera test ──────────────────────────────────────────────────────────────
function testCamera(ip) {
  return new Promise((resolve) => {
    const req = http.get(`http://${ip}:8000/`, { timeout: 3000 }, (res) => {
      resolve({ ok: true, method: "http", status: res.statusCode });
    });
    req.on("error", () => {
      const net = require("net");
      const sock = new net.Socket();
      sock.setTimeout(3000);
      sock.connect(554, ip, () => {
        sock.destroy();
        resolve({ ok: true, method: "rtsp-port" });
      });
      sock.on("error",   () => { sock.destroy(); resolve({ ok: false }); });
      sock.on("timeout", () => { sock.destroy(); resolve({ ok: false }); });
    });
    req.on("timeout", () => req.destroy());
  });
}

// ─── Auto-update relay.js from server ────────────────────────────────────────
const RELAY_SCRIPT_URL = "https://vp-chef-studio.replit.app/api/cameras/relay-script";

function downloadRelayJs(destPath, callback) {
  const https = require("https");
  const tmpPath = destPath + ".tmp";
  const file = fs.createWriteStream(tmpPath);
  https.get(RELAY_SCRIPT_URL, { timeout: 8000 }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      file.destroy();
      try { fs.unlinkSync(tmpPath); } catch {}
      return callback(new Error(`HTTP ${res.statusCode}`));
    }
    res.pipe(file);
    file.on("finish", () => {
      file.close(() => {
        try {
          const size = fs.statSync(tmpPath).size;
          if (size < 10000) {
            fs.unlinkSync(tmpPath);
            return callback(new Error("Downloaded file too small"));
          }
          fs.renameSync(tmpPath, destPath);
          callback(null);
        } catch (e) {
          callback(e);
        }
      });
    });
  }).on("error", (e) => {
    file.destroy();
    try { fs.unlinkSync(tmpPath); } catch {}
    callback(e);
  }).on("timeout", function () {
    this.destroy();
    file.destroy();
    try { fs.unlinkSync(tmpPath); } catch {}
    callback(new Error("Download timed out"));
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Tray — always present, no main window
  tray = new Tray(makeTrayIcon());
  tray.setToolTip("VP Chef Relay — Starting…");
  tray.setContextMenu(buildTrayMenu());

  // Double-click: open web app if configured, else open setup wizard
  tray.on("double-click", () => {
    const cfg = loadConfig();
    if (!cfg || !cfg.cameras) {
      showWizardWindow();
    } else {
      shell.openExternal(WEB_APP_URL);
    }
  });

  if (!APP_ICON.isEmpty() && process.platform === "darwin") {
    app.dock?.setIcon(APP_ICON);
  }

  const cfg = loadConfig();
  if (!cfg || !cfg.cameras) {
    // First launch — show setup wizard
    showWizardWindow();
  } else {
    // Configured — start silently in the tray
    const updatedRelayJs = path.join(app.getPath("userData"), "relay.js");
    downloadRelayJs(updatedRelayJs, (err) => {
      if (!err) {
        relayJsOverride = updatedRelayJs;
        pushLog("[relay] ✓ relay.js updated from server");
      } else {
        pushLog(`[relay] ⚠ Relay script update failed (${err.message}) — using bundled version`);
      }
      setTimeout(startRelay, 200);
    });
  }
});

app.on("window-all-closed", (e) => e.preventDefault()); // Keep alive in tray
app.on("before-quit", () => stopRelay(true));
app.on("activate", () => {
  // macOS: re-open wizard if not configured
  const cfg = loadConfig();
  if (!cfg || !cfg.cameras) showWizardWindow();
});
