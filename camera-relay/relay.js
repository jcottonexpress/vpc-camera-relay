/**
 * VP Chef Studio — Local Camera Relay
 *
 * Just run this and it handles everything else automatically:
 *   node relay.js
 *
 * Or on Windows, double-click start.bat.
 */

// ─── CONFIGURATION (only section you ever need to edit) ─────────────────────

const SERVER_DOMAIN = "vp-chef-studio.replit.app";

// ── Camera login credentials ──────────────────────────────────────────────────
// These are DEFAULT values. The relay actually reads credentials from
// relay-config.json (created automatically on first run). Edit that file to
// set your password — it will never be overwritten by auto-updates.
let RTSP_USER = "admin";
let RTSP_PASS = "";        // ← only used if relay-config.json is missing

const CAMERAS = [
  { slot: 1, ip: "192.168.1.177", label: "Performance Cam" },
  { slot: 2, ip: "192.168.1.178", label: "Food Prep Cam"   },
  { slot: 3, ip: "192.168.1.179", label: "Stovetop Cam"    },
];

// ─── OPTIONAL TUNING ─────────────────────────────────────────────────────────
const OUTPUT_FPS         = 5;   // FPS for RTSP/ffmpeg streams (preview only — recording is local)
const HTTP_SNAPSHOT_FPS  = 2;   // FPS for HTTP snapshot polling fallback
const JPEG_QUALITY = 12;        // 2 = best quality, 31 = smallest; 12 ≈ 60-80 KB — fine for preview
const RECONNECT_MS = 5000;

// Max FPS actually forwarded over the WebSocket to the cloud server.
// 3 cameras × 1 fps × ~80 KB = ~240 KB/s — well within any home upload budget.
// Higher values saturate the upload link, stall pong responses, and cause 1006 disconnects.
const WS_PREVIEW_FPS = 1;

// RTSP ports to try in order.
// LV-PWF1-BT confirmed RTSP port: 5543.  Port 8000 is HTTP management only.
const RTSP_PORTS_TO_TRY = [5543, 554, 8554, 10554, 8080, 8090, 7070, 49152, 8000];

// RTSP URL paths to try for each camera model.
// The relay iterates these until ffmpeg produces frames.
const RTSP_PATHS_TO_TRY = [
  // ── LV-PWF1-BT confirmed working path (discovered via ONVIF, use directly) ─
  "/685b2cab121c0e1032e925da3cfb8b4f/live/channel0",
  // ── Happytimesoft / LV-PWF1-BT confirmed paths (try these first) ─────────
  "/user_0.264",                               // Happytimesoft main stream
  "/user_1.264",                               // Happytimesoft sub-stream
  "/user_0",                                   // alternate no-extension form
  "/user_1",
  "/live/ch00_0",                              // Happytimesoft live variant
  "/live/ch01_0",
  "/live/main",
  "/live/sub",
  "/live/0/MAIN",
  "/live/0/SUB",
  "/live/1",
  "/live/0",
  "/ch00_0",
  "/ch01_0",
  // ── AltoBeam / ONVIF standard ─────────────────────────────────────────────
  "/onvif1",
  "/onvif2",
  "/onvif/streaming/channels/1",
  "/onvif/streaming/channels/101",
  "/Streaming/Channels/101",
  "/Streaming/Channels/102",
  // ── Other LaView / generic paths ──────────────────────────────────────────
  "/h264/ch01/main/av_stream",
  "/h264/ch01/sub/av_stream",
  "/livestream/1",
  "/livestream/0",
  "/live",
  "/stream",
  "/tcp/av0_0",
  "/av0_0",
  "/cam/realmonitor?channel=1&subtype=0",
  "/video1",
  "/0",
  "/1",
];
// ─────────────────────────────────────────────────────────────────────────────

"use strict";
const fs            = require("fs");
const path          = require("path");
const os            = require("os");
const net           = require("net");
const http          = require("http");
const dgram         = require("dgram");
const crypto        = require("crypto");
const { execSync, spawn } = require("child_process");

// ─── HLS output directory ─────────────────────────────────────────────────────
// ffmpeg writes HLS .m3u8 + .ts segments here; the local HTTP server serves them.
// Using the system temp dir keeps relay.js self-contained and auto-cleaned on reboot.
const HLS_BASE = path.join(os.tmpdir(), "vpchef-hls");
try { fs.mkdirSync(HLS_BASE, { recursive: true }); } catch {}

// ─── Load relay-config.json (persists credentials across auto-updates) ───────
// relay-config.json lives next to relay.js and is NEVER overwritten by updates.
// Fields: rtspUser, rtspPass (RTSP stream auth), onvifPass (ONVIF SOAP auth).
// onvifPass defaults to rtspPass if not set separately.
let ONVIF_PASS = "";
{
  const cfgPath = path.join(__dirname, "relay-config.json");
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""); // strip UTF-8 BOM
      const cfg = JSON.parse(raw);
      if (cfg.rtspUser  !== undefined) RTSP_USER  = cfg.rtspUser;
      if (cfg.rtspPass  !== undefined) RTSP_PASS  = cfg.rtspPass;
      if (cfg.onvifPass !== undefined) ONVIF_PASS = cfg.onvifPass;
      else                             ONVIF_PASS = RTSP_PASS;
      // Allow relay-config.json to override the default camera list (for multi-user setup)
      if (Array.isArray(cfg.cameras) && cfg.cameras.length > 0) {
        CAMERAS.splice(0, CAMERAS.length, ...cfg.cameras.map(c => ({
          slot:  Number(c.slot),
          ip:    String(c.ip),
          label: String(c.label || `Camera ${c.slot}`),
        })));
        console.log(`[config] Loaded ${CAMERAS.length} cameras from relay-config.json`);
      }
    } catch (e) {
      console.warn("[config] Could not parse relay-config.json — using defaults:", e.message);
    }
  } else {
    // Create the config file on first run so the user can edit it once
    try {
      fs.writeFileSync(cfgPath, JSON.stringify({
        rtspUser:  RTSP_USER,
        rtspPass:  RTSP_PASS,
        onvifPass: RTSP_PASS,
        cameras:   CAMERAS.map(c => ({ slot: c.slot, ip: c.ip, label: c.label })),
      }, null, 2) + "\n");
      console.log("[config] Created relay-config.json — edit cameras / rtspPass to configure your setup.");
    } catch (_) {}
  }
}

// ─── Step 1: Auto-install ws if missing ──────────────────────────────────────
let WebSocket;
try {
  WebSocket = require("ws");
} catch {
  console.log("[setup] Installing required packages (this only happens once)…");
  try {
    execSync("npm install", { cwd: __dirname, stdio: "inherit" });
    WebSocket = require("ws");
    console.log("[setup] Packages installed successfully.\n");
  } catch (err) {
    console.error("\n  ERROR: Could not install packages automatically.");
    console.error("  Please open a Command Prompt in this folder and run: npm install\n");
    process.exit(1);
  }
}

// ─── Step 2: Locate ffmpeg ───────────────────────────────────────────────────
const FFMPEG_SEARCH_PATHS = [
  // Windows paths
  path.join(__dirname, "ffmpeg", "bin", "ffmpeg.exe"),
  "C:\\ffmpeg\\bin\\ffmpeg.exe",
  "C:\\ffmpeg\\ffmpeg.exe",
  "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
  "C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe",
  path.join(process.env.LOCALAPPDATA || "", "ffmpeg", "bin", "ffmpeg.exe"),
  path.join(process.env.USERPROFILE  || "", "ffmpeg", "bin", "ffmpeg.exe"),
  // macOS — Homebrew (Apple Silicon and Intel)
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  // Linux
  "/usr/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
];

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  try { execSync("ffmpeg -version", { stdio: "ignore" }); return "ffmpeg"; } catch {}
  for (const p of FFMPEG_SEARCH_PATHS) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

const FFMPEG_PATH = findFfmpeg();

if (!FFMPEG_PATH) {
  console.error("\n  ERROR: Could not find ffmpeg.exe automatically.");
  console.error("  Use start.bat — it will search for ffmpeg and ask you to confirm the path.");
  process.exit(1);
}

console.log(`[setup] Using ffmpeg: ${FFMPEG_PATH}`);

// ─── WebSocket relay ──────────────────────────────────────────────────────────
const WS_URL          = `wss://${SERVER_DOMAIN}/api/ws/camera-relay`;
const HEARTBEAT_URL   = `https://${SERVER_DOMAIN}/api/cameras/relay-heartbeat`;
const HEARTBEAT_IPS   = CAMERAS.map(c => c.ip);
let heartbeatTimer    = null;

/**
 * POST /api/cameras/relay-heartbeat — writes a fresh DB record so any
 * autoscale server instance can confirm the relay is online via the shared DB.
 * This is the primary online-detection mechanism (WS-based writes only reach
 * one instance in a multi-instance deployment).
 */
function sendHttpHeartbeat() {
  try {
    const body = JSON.stringify({ ips: HEARTBEAT_IPS });
    const isHttps = HEARTBEAT_URL.startsWith("https");
    const transport = isHttps ? require("https") : require("http");
    const url = new URL(HEARTBEAT_URL);
    const req = transport.request({
      method:   "POST",
      hostname: url.hostname,
      path:     url.pathname,
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      res.resume(); // drain and discard body
    });
    req.on("error", () => {}); // silent — heartbeat is best-effort
    req.write(body);
    req.end();
  } catch { /* ignore */ }
}

function startHeartbeatTimer() {
  stopHeartbeatTimer();
  sendHttpHeartbeat(); // immediate ping
  heartbeatTimer = setInterval(sendHttpHeartbeat, 15_000);
}

function stopHeartbeatTimer() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

let ws      = null;
let wsReady = false;

const pendingFrames = [];
const MAX_PENDING   = 3; // keep small — no point queuing stale frames

function buildFrame(ip, jpeg) {
  const ipBuf  = Buffer.from(ip, "utf8");
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(ipBuf.length, 0);
  return Buffer.concat([lenBuf, ipBuf, jpeg]);
}

// Per-camera throttle: track when each IP last sent a frame over WS.
// This ensures total upload = cameras × WS_PREVIEW_FPS × frame_size,
// keeping the link clear so ping/pong round-trips never stall.
const wsLastSent = Object.create(null); // { [ip]: timestamp }
const WS_MIN_INTERVAL_MS = Math.round(1000 / WS_PREVIEW_FPS);

// ─── Local frame cache ────────────────────────────────────────────────────────
// Latest JPEG per camera IP — served directly to phones over local WiFi on
// the LAN snapshot server (port 8082). Updated on every frame BEFORE the WS
// throttle so the local server always has the freshest image.
const localFrames    = new Map(); // ip → Buffer
const localFrameTime = new Map(); // ip → timestamp
const frameCounts    = new Map(); // ip → total frames received (for Electron status)

// ─── Session recording state ──────────────────────────────────────────────────
// When the mobile app starts a recording, the relay collects frames directly
// from all 3 cameras (guaranteed — no cloud hop or autoscale issue).
// After recording stops, the relay uploads all frames to the production server
// for full AI analysis, then returns the session ID to the mobile app.
const RECORD_FRAME_INTERVAL_MS = 3000; // 1 frame per camera every 3s (≈same as phone was doing)
const RECORD_MAX_FRAMES_PER_CAM = 25;  // cap: 25 × 3s = 75s of coverage max

const recordingState = {
  active:      false,
  sessionId:   null,    // mobile-generated session ID
  title:       "Recording Session",
  startMs:     0,
  lastCaptureMs: {},    // ip → timestamp of last captured frame
  frames:      {},      // ip → [ { timestampSec, jpegBase64 } ]
  // ── MP4 video recording ──
  videoProcs:  {},      // slot → { proc: ChildProcess, outPath: string }
  recordingDir: null,   // directory for session MP4 files
};

function recordFrame(ip, jpeg) {
  if (!recordingState.active) return;
  const now = Date.now();
  const last = recordingState.lastCaptureMs[ip] || 0;
  if (now - last < RECORD_FRAME_INTERVAL_MS) return;
  if (!recordingState.frames[ip]) recordingState.frames[ip] = [];
  if (recordingState.frames[ip].length >= RECORD_MAX_FRAMES_PER_CAM) return;
  recordingState.lastCaptureMs[ip] = now;
  const timestampSec = Math.round((now - recordingState.startMs) / 1000);
  recordingState.frames[ip].push({
    timestampSec,
    dataUrl: "data:image/jpeg;base64," + jpeg.toString("base64"),
  });
}

// Upload frames collected by the relay to the production server.
// Returns the parsed JSON response body or throws.
async function uploadRelaySession(title, durationSec, authToken) {
  const https = require("https");
  const videos = CAMERAS.map(cam => {
    const frames = recordingState.frames[cam.ip] || [];
    const ROLE_MAP = {
      1: { role: "chef-view",  roleLabel: "Performance Cam" },
      2: { role: "food-prep",  roleLabel: "Food Prep Cam"   },
      3: { role: "cooking",    roleLabel: "Stovetop Cam"    },
    };
    const roleInfo = ROLE_MAP[cam.slot] || { role: "auto", roleLabel: cam.label };
    return {
      slot:            cam.slot,
      filename:        `relay_cam${cam.slot}_${cam.label.replace(/\s+/g, "_")}.jpg`,
      durationSeconds: Math.round(durationSec),
      sizeBytes:       0,
      role:            roleInfo.role,
      roleLabel:       roleInfo.roleLabel,
      frames,
      source:          "relay-pc",
    };
  }).filter(v => v.frames.length > 0);

  if (videos.length === 0) throw new Error("No frames captured from any camera");

  const totalFrames = videos.reduce((n, v) => n + v.frames.length, 0);
  console.log(`[record] Uploading ${videos.length} cameras, ${totalFrames} total frames to server…`);

  const body = JSON.stringify({
    title,
    videos,
    deviceId: "relay-pc",
    source:   "relay",
  });

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: SERVER_DOMAIN,
      port:     443,
      path:     "/api/sessions/from-upload",
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...(authToken ? { "Authorization": `Bearer ${authToken}` } : {}),
      },
    };
    const req = https.request(reqOpts, res => {
      let data = "";
      res.on("data", d => { data += d.toString(); });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Server returned ${res.statusCode}: ${data.slice(0, 200)}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error("Invalid JSON from server: " + data.slice(0, 200))); }
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => { req.destroy(); reject(new Error("Upload timed out")); });
    req.write(body);
    req.end();
  });
}

// ─── MP4 Video recording helpers ─────────────────────────────────────────────
// Each camera gets its own dedicated FFmpeg process recording directly to disk.
// This runs in PARALLEL with the always-on HLS/preview FFmpeg process.
// Files land in ~/Documents/VP Chef Studio/<sessionTitle>-<sessionId>/cam<slot>.mp4

const RECORDINGS_BASE = path.join(os.homedir(), "Documents", "VP Chef Studio");

function startVideoRecording(sessionId, title) {
  try { fs.mkdirSync(RECORDINGS_BASE, { recursive: true }); } catch {}
  const safeTitle = (title || "Session")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60);
  const folderName = safeTitle ? `${safeTitle}-${sessionId}` : sessionId;
  const recDir = path.join(RECORDINGS_BASE, folderName);
  try { fs.mkdirSync(recDir, { recursive: true }); } catch {}
  recordingState.recordingDir = recDir;
  recordingState.videoProcs   = {};

  for (const cam of CAMERAS) {
    if (!cam.activeRtspUrl) {
      console.log(`[record-video] CAM${cam.slot} has no confirmed RTSP URL yet — skipping video recording`);
      continue;
    }
    const outPath = path.join(recDir, `cam${cam.slot}.mp4`);
    const args = [
      "-hide_banner", "-loglevel", "warning",
      "-rtsp_transport", cam.activeTransport || "tcp",
      "-timeout",        "10000000",
      "-i",              cam.activeRtspUrl,
      "-c:v",            "copy",
      "-an",                         // no audio track (camera doesn't send audio reliably)
      "-movflags",       "frag_keyframe+empty_moov+default_base_moof",
      "-f",              "mp4",
      outPath,
    ];
    const proc = spawn(FFMPEG_PATH, args);
    proc.stderr.on("data", d => {
      const line = d.toString().trim();
      if (line) console.log(`[record-video CAM${cam.slot}] ${line}`);
    });
    proc.on("close", (code) => {
      console.log(`[record-video CAM${cam.slot}] Ended (code ${code}) → ${outPath}`);
    });
    recordingState.videoProcs[cam.slot] = { proc, outPath };
    console.log(`[record-video] ▶ Recording CAM${cam.slot} → ${outPath}`);
  }
}

// Gracefully stop all recording FFmpeg processes and wait for them to finish.
// Returns a Promise that resolves when all processes have exited.
function stopVideoRecording() {
  const procs = recordingState.videoProcs || {};
  const waits = Object.entries(procs).map(([slot, entry]) => {
    const { proc, outPath } = entry;
    return new Promise((resolve) => {
      if (proc.exitCode !== null) { resolve({ slot, outPath }); return; }
      const timer = setTimeout(() => {
        console.warn(`[record-video CAM${slot}] Force-killing ffmpeg after 8s`);
        try { proc.kill("SIGTERM"); } catch {}
        resolve({ slot, outPath });
      }, 8000);
      proc.once("close", () => {
        clearTimeout(timer);
        resolve({ slot, outPath });
      });
      // FFmpeg graceful stop: write 'q' to stdin
      try { proc.stdin.write("q\n"); } catch { try { proc.kill("SIGTERM"); } catch {} }
    });
  });
  return Promise.all(waits);
}

// Upload a single MP4 file to the cloud server after the session ID is known.
function uploadSingleVideoFile(sessionId, slot, filePath) {
  const https = require("https");
  const stat  = fs.statSync(filePath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
  console.log(`[record-video] Uploading CAM${slot} MP4 (${sizeMB} MB) to server…`);

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: SERVER_DOMAIN,
      port:     443,
      path:     `/api/sessions/${sessionId}/video?slot=${slot}`,
      method:   "POST",
      headers:  {
        "Content-Type":   "video/mp4",
        "Content-Length": stat.size,
      },
    };
    const req = https.request(reqOpts, (res) => {
      let data = "";
      res.on("data", d => { data += d.toString(); });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[record-video] ✓ CAM${slot} uploaded (${res.statusCode})`);
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Server returned ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(300_000, () => { req.destroy(); reject(new Error(`Video upload timeout for CAM${slot}`)); });
    // Stream the file directly into the request
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(req);
    fileStream.on("error", reject);
  });
}

async function uploadAllVideoFiles(sessionId) {
  const procs = recordingState.videoProcs || {};
  const results = [];
  for (const [slot, entry] of Object.entries(procs)) {
    const { outPath } = entry;
    try {
      const stat = fs.statSync(outPath);
      if (stat.size < 10_000) {
        console.warn(`[record-video] CAM${slot} file too small (${stat.size} bytes) — skipping upload`);
        continue;
      }
      const result = await uploadSingleVideoFile(sessionId, slot, outPath);
      results.push({ slot, ...result });
    } catch (err) {
      console.error(`[record-video] Failed to upload CAM${slot}: ${err.message}`);
    }
  }
  return results;
}

function sendFrame(ip, jpeg) {
  // Collect frame for active recording (all 3 cameras, no cloud hop)
  recordFrame(ip, jpeg);

  // Cache for local LAN server (before WS throttle — always store latest frame)
  localFrames.set(ip, jpeg);
  localFrameTime.set(ip, Date.now());
  frameCounts.set(ip, (frameCounts.get(ip) || 0) + 1);

  const now = Date.now();
  // Drop this frame if we sent one too recently for this camera
  if (wsLastSent[ip] && now - wsLastSent[ip] < WS_MIN_INTERVAL_MS) return;
  wsLastSent[ip] = now;

  const frame = buildFrame(ip, jpeg);
  if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(frame);
  } else {
    // Keep only the most-recent pending frame per IP so reconnect gets fresh image
    const existingIdx = pendingFrames.findIndex(f => f.ip === ip);
    if (existingIdx !== -1) pendingFrames.splice(existingIdx, 1);
    if (pendingFrames.length < MAX_PENDING) pendingFrames.push({ ip, frame });
  }
}

function connectWs() {
  console.log(`[ws] Connecting to server…`);
  ws = new WebSocket(WS_URL, {
    headers: { "Origin": `https://${SERVER_DOMAIN}` },
  });

  ws.on("open", () => {
    console.log("[ws] Connected to VP Chef Studio cloud server.");
    ws.send(JSON.stringify({ type: "register", ips: CAMERAS.map(c => c.ip) }));
    startHeartbeatTimer(); // begin HTTP heartbeat pings so all autoscale instances see us
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "ack") {
        console.log(`[ws] Server ready. Streaming cameras: ${msg.ips.join(", ")}\n`);
        wsReady = true;
        while (pendingFrames.length > 0) ws.send(pendingFrames.shift().frame);
        return;
      }

      // ── Cloud-controlled recording commands ──────────────────────────────
      // The phone sends these to the cloud server which forwards them here.
      // This bypasses the LAN HTTP requirement (Windows firewall issue).

      if (msg.type === "record-start") {
        if (recordingState.active) {
          console.log("[ws] record-start received but already recording — ignoring (no resend)");
          return;
        }
        const sessionId = msg.sessionId || String(Date.now());
        recordingState.active        = true;
        recordingState.sessionId     = sessionId;
        recordingState.title         = msg.title || "Recording Session";
        recordingState.startMs       = Date.now();
        recordingState.lastCaptureMs = {};
        recordingState.frames        = {};
        recordingState.authToken     = msg.authToken || null;
        recordingState.uploadStatus  = null;
        recordingState.uploadResult  = null;
        recordingState.uploadError   = null;
        const camStatus = CAMERAS.map(c => ({
          slot:      c.slot,
          label:     c.label,
          hasFrames: localFrames.has(c.ip),
        }));
        console.log(`[ws] ▶ record-start: "${recordingState.title}" (session ${sessionId}) — cameras: ${JSON.stringify(camStatus)}`);
        // Start a dedicated FFmpeg process per camera to record full-rate MP4
        startVideoRecording(sessionId, recordingState.title);
        ws.send(JSON.stringify({ type: "relay-recording-started", cameras: camStatus }));
        return;
      }

      if (msg.type === "record-stop") {
        if (!recordingState.active) {
          // Relay may have restarted mid-session — acknowledge gracefully so
          // the phone can keep polling without seeing a fatal error.
          console.log("[ws] record-stop received but not recording (relay may have restarted)");
          ws.send(JSON.stringify({ type: "relay-recording-stopped", totalFrames: 0, cameras: [] }));
          // Don't send upload-error — the cloud's DB fallback will recover any
          // session that was already uploaded before the restart.
          return;
        }

        recordingState.active = false;
        const durationSec  = Math.round((Date.now() - recordingState.startMs) / 1000);
        const title        = recordingState.title;
        const frames       = recordingState.frames;
        const totalFrames  = Object.values(frames).reduce((n, arr) => n + arr.length, 0);
        const authToken    = msg.authToken || recordingState.authToken || null;

        console.log(`[ws] ■ record-stop. Duration: ${durationSec}s, frames: ${totalFrames}`);

        // Signal recording FFmpeg processes to stop gracefully (runs in background while we upload frames)
        const videoStopPromise = stopVideoRecording();

        // Notify server that upload is starting
        ws.send(JSON.stringify({
          type:        "relay-recording-stopped",
          totalFrames,
          cameras:     CAMERAS.map(c => ({ slot: c.slot, frames: (frames[c.ip] || []).length })),
        }));

        if (totalFrames === 0) {
          ws.send(JSON.stringify({
            type:  "relay-upload-error",
            error: "No frames captured — cameras may not have been streaming yet",
          }));
          return;
        }

        recordingState.uploadStatus = "uploading";
        uploadRelaySession(title, durationSec, authToken).then(async result => {
          recordingState.uploadStatus = "done";
          recordingState.uploadResult = result;
          const sessionId = result.id;
          const segs      = (result.aiAnalysis?.videoSegments || []).length;
          const aiCuts    = result.aiAnalysis?.videoSegments || [];
          console.log(`[ws] ✓ Upload done. Session ID: ${sessionId} — ${segs} AI segments`);
          ws.send(JSON.stringify({
            type:       "relay-upload-done",
            sessionId,
            totalFrames,
            aiSegments: segs,
            aiCuts,
            cameras:    CAMERAS.map(c => ({
              slot:   c.slot,
              label:  c.label,
              frames: (frames[c.ip] || []).length,
            })),
          }));
          // ── Upload MP4 video files after JPEG frames are processed ──────────
          // Wait for recording FFmpeg processes to finalize their files
          try {
            console.log(`[record-video] Waiting for recording processes to finalize…`);
            await videoStopPromise;
            console.log(`[record-video] All recording processes stopped. Uploading MP4 files…`);
            const videoResults = await uploadAllVideoFiles(sessionId);
            if (videoResults.length > 0) {
              console.log(`[record-video] ✓ Uploaded ${videoResults.length} MP4 files for session ${sessionId}`);
              // Notify the phone that video files are now available in the editor
              if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({
                  type:      "relay-video-ready",
                  sessionId,
                  slots:     videoResults.map(r => r.slot),
                }));
              }
            }
          } catch (videoErr) {
            console.error(`[record-video] Video upload error: ${videoErr.message}`);
          }
        }).catch(err => {
          recordingState.uploadStatus = "error";
          recordingState.uploadError  = err.message;
          console.error(`[ws] ✗ Upload failed: ${err.message}`);
          ws.send(JSON.stringify({ type: "relay-upload-error", error: err.message }));
          // Still try to stop recording processes even if JPEG upload failed
          videoStopPromise.catch(() => {});
        });
        return;
      }

    } catch {}
  });

  ws.on("close", (code) => {
    wsReady = false;
    stopHeartbeatTimer();
    console.log(`[ws] Disconnected (code ${code}). Reconnecting in ${RECONNECT_MS / 1000}s…`);
    setTimeout(connectWs, RECONNECT_MS);
  });

  ws.on("error", (err) => {
    console.error(`[ws] Connection error: ${err.message}`);
  });
}

// ─── Port / path discovery ────────────────────────────────────────────────────
function probeTcp(ip, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("error",   () => { sock.destroy(); resolve(false); });
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    try { sock.connect(port, ip); } catch { resolve(false); }
  });
}

/**
 * Tries RTSP_PORTS_TO_TRY in sequence via TCP probe and returns the first
 * open port, or null if none respond.
 */
async function discoverRtspPort(camera) {
  for (const port of RTSP_PORTS_TO_TRY) {
    const ok = await probeTcp(camera.ip, port);
    if (ok) {
      console.log(`[${camera.label}] Port ${port} is open — using it.`);
      return port;
    }
  }
  return null;
}

/**
 * ONVIF GetStreamUri — sends a SOAP request to the camera's ONVIF service
 * and returns the RTSP stream URI. Used when port 8000 is the only open port
 * (AltoBeam/LaView cameras expose ONVIF HTTP management on port 8000).
 */
async function onvifGetStreamUri(ip, port, user, pass, cameraLabel = ip) {
  // Build WS-Security PasswordDigest header
  const nonce   = crypto.randomBytes(16);
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const digest  = crypto.createHash("sha1")
    .update(Buffer.concat([nonce, Buffer.from(created, "utf8"), Buffer.from(pass, "utf8")]))
    .digest("base64");
  const secHdr = [
    `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"`,
    ` xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">`,
    `<wsse:UsernameToken>`,
    `<wsse:Username>${user}</wsse:Username>`,
    `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>`,
    `<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</wsse:Nonce>`,
    `<wsu:Created>${created}</wsu:Created>`,
    `</wsse:UsernameToken></wsse:Security>`,
  ].join("");

  // soapPost — SOAP 1.2 (application/soap+xml).
  // LV-PWF1-BT firmware requires SOAP 1.2; SOAP 1.1 (text/xml) returns HTTP 404.
  function soapPost(svcPath, bodyXml, label = "", soapAction = "") {
    return new Promise((resolve, reject) => {
      // SOAP 1.2 envelope
      const env  = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Header>${secHdr}</s:Header><s:Body>${bodyXml}</s:Body></s:Envelope>`;
      const opts = { hostname: ip, port, path: svcPath, method: "POST",
        headers: { "Content-Type": "application/soap+xml; charset=utf-8",
                   "Content-Length": Buffer.byteLength(env) }, timeout: 5000 };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end",  () => {
          if (label) {
            const snippet = res.statusCode !== 200 ? `  ← ${data.slice(0, 120).replace(/\s+/g," ")}` : "";
            console.log(`[${label}] ONVIF ${svcPath} → HTTP ${res.statusCode}  (${data.length} bytes)${snippet}`);
          }
          resolve({ status: res.statusCode, body: data });
        });
      });
      req.on("error",   (e) => {
        if (label) console.log(`[${label}] ONVIF ${svcPath} → error: ${e.message}`);
        reject(e);
      });
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.write(env);
      req.end();
    });
  }

  // ONVIF service paths to try (varies by firmware)
  // LV-PWF1-BT: media calls must go to /onvif/media_service, not /onvif/device_service
  const ONVIF_PATHS = [
    "/onvif/media_service",
    "/onvif/device_service",
    "/onvif/Media",
    "/onvif/services",
    "/onvif",
  ];

  // Step 1: Get media profile token (log each response to help diagnose)
  let profileToken = "Profile_1"; // AltoBeam/LaView default profile name
  for (const svc of ONVIF_PATHS) {
    try {
      const { status, body } = await soapPost(svc,
        `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`, cameraLabel,
        "http://www.onvif.org/ver10/media/wsdl/GetProfiles");
      if (status === 200) {
        const m = body.match(/token="([^"]+)"/);
        if (m) { profileToken = m[1]; break; }
        // 200 but no token — log a snippet to see what came back
        console.log(`[${cameraLabel}] ONVIF GetProfiles 200 but no token — snippet: ${body.slice(0, 120)}`);
        break; // still found a responsive path, stop trying
      } else if (status === 401) {
        console.log(`[${cameraLabel}] ONVIF auth rejected (401) at ${svc} — check onvifPass in relay-config.json`);
        return null; // wrong password, no point trying more paths
      }
    } catch { /* try next path */ }
  }

  // Step 2: GetStreamUri
  const streamBody = [
    `<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl">`,
    `<StreamSetup>`,
    `<Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>`,
    `<Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport>`,
    `</StreamSetup>`,
    `<ProfileToken>${profileToken}</ProfileToken>`,
    `</GetStreamUri>`,
  ].join("");

  for (const svc of ONVIF_PATHS) {
    try {
      const { status, body } = await soapPost(svc, streamBody, cameraLabel,
        "http://www.onvif.org/ver10/media/wsdl/GetStreamUri");
      if (status !== 200) continue;
      // Match <Uri>rtsp://...</Uri> in any ONVIF namespace variant
      const m = body.match(/<(?:[a-z]+:)?Uri[^>]*>(rtsp:\/\/[^<]+)<\/(?:[a-z]+:)?Uri>/i);
      if (!m) {
        console.log(`[${cameraLabel}] ONVIF GetStreamUri 200 but no URI — snippet: ${body.slice(0, 200)}`);
        continue;
      }
      let uri = m[1].trim();
      // Normalise: replace whatever IP the camera returned with its known local IP
      uri = uri.replace(/^(rtsp:\/\/)([^/:@]+)/, `$1${ip}`);
      // Inject credentials if not present
      if (!uri.includes("@")) {
        uri = uri.replace("rtsp://", `rtsp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
      }
      return uri;
    } catch { /* try next path */ }
  }
  return null; // ONVIF not available or didn't respond
}

// ─── HTTP snapshot discovery ──────────────────────────────────────────────────
// AltoBeam/LaView cameras often expose JPEG snapshots via HTTP even when RTSP
// is unavailable. We probe common paths and use the first one that returns a JPEG.
const HTTP_SNAPSHOT_PATHS = [
  "/cgi-bin/snapshot.cgi",
  "/snapshot.cgi",
  "/cgi-bin/jpg/image.cgi",
  "/cgi-bin/CGIProxy.fcgi?cmd=snapPicture&channel=0",
  "/ISAPI/Streaming/channels/101/picture",
  "/Streaming/channels/1/picture",
  "/snapshot",
  "/image.jpg",
  "/cgi-bin/cmd?DEVICE_TYPE&SNAPSHOT",
  "/video.cgi",
  "/cgi-bin/stream.cgi",
];

// Per-IP Digest auth credential cache — avoids Basic→401→Digest roundtrip on every frame.
// Cached: { realm, nonce, qop, opaque, HA1 }
const digestAuthCache = new Map();

// Build a Digest Authorization header from cached + current request params.
function buildDigestHeader(user, pass, urlPath, cached) {
  const md5    = (s) => crypto.createHash("md5").update(s).digest("hex");
  const HA1    = cached.HA1 || md5(`${user}:${cached.realm}:${pass}`);
  const HA2    = md5(`GET:${urlPath}`);
  const nc     = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const qop    = cached.qop || "";
  const resp   = qop
    ? md5(`${HA1}:${cached.nonce}:${nc}:${cnonce}:${qop.split(",")[0].trim()}:${HA2}`)
    : md5(`${HA1}:${cached.nonce}:${HA2}`);
  let hdr = `Digest username="${user}", realm="${cached.realm}", nonce="${cached.nonce}", uri="${urlPath}", response="${resp}"`;
  if (qop)          hdr += `, qop=${qop.split(",")[0].trim()}, nc=${nc}, cnonce="${cnonce}"`;
  if (cached.opaque) hdr += `, opaque="${cached.opaque}"`;
  return hdr;
}

// ─── Raw HTTP/1.0 socket fetcher ─────────────────────────────────────────────
// Many embedded IP cameras (like Happytimesoft) implement a minimal HTTP/1.0
// server. With HTTP/1.1 (Node's http.request default), the camera doesn't know
// how to signal end-of-body (no chunked encoding, no Content-Length), so it
// sends 0 bytes. With HTTP/1.0, the server closes the connection after the
// response — the client reads until EOF, which gives us the full JPEG body.
//
// This function handles the full Basic→401→Digest auth dance via raw socket.
// digestAuthCache is shared with httpGet so credentials are reused.
function rawHttp10Get(ip, port, urlPath, user, pass, timeoutMs = 5000) {
  const SOI10 = Buffer.from([0xff, 0xd8]);
  const EOI10 = Buffer.from([0xff, 0xd9]);

  function sendRequest(authHeader) {
    return new Promise((resolve, reject) => {
      const lines = [
        `GET ${urlPath} HTTP/1.0`,
        `Host: ${ip}:${port}`,
        `User-Agent: VPChefRelay/1.0`,
      ];
      if (authHeader) lines.push(`Authorization: ${authHeader}`);
      lines.push("", ""); // blank line = end of headers
      const reqBuf = Buffer.from(lines.join("\r\n"));

      const sock   = net.createConnection({ host: ip, port });
      let   rxBuf  = Buffer.alloc(0);
      let   settled = false;
      let   timer;

      const settle = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        resolve(val);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        reject(err);
      };

      // Parse whatever we have collected so far (called on each chunk AND on close).
      const tryParse = (isFinal) => {
        // Find end-of-headers marker — support CRLF (\r\n\r\n) and LF-only (\n\n)
        let sep    = rxBuf.indexOf(Buffer.from("\r\n\r\n"));
        let sepLen = 4;
        if (sep === -1) {
          sep    = rxBuf.indexOf(Buffer.from("\n\n"));
          sepLen = 2;
        }
        if (sep === -1) {
          if (isFinal && rxBuf.length > 0) {
            // Got bytes but no header terminator — log raw hex for diagnostics
            process.stdout.write(`[DIAG] No header terminator found. Raw ${rxBuf.length}B: ${rxBuf.toString("hex")}\n`);
          }
          return; // headers not yet complete
        }

        const headersRaw = rxBuf.subarray(0, sep).toString("utf8");
        const body       = rxBuf.subarray(sep + sepLen);

        const statusLine  = headersRaw.split("\r\n")[0] || "";
        const statusCode  = parseInt(statusLine.split(" ")[1] || "0", 10);
        const ctMatch     = headersRaw.match(/content-type:\s*([^\r\n]+)/i);
        const contentType = ctMatch ? ctMatch[1].trim() : "";
        const wwwAuth     = (headersRaw.match(/www-authenticate:\s*([^\r\n]+)/i) || [])[1] || "";

        const isImageCT = contentType.toLowerCase().includes("jpeg") ||
                          contentType.toLowerCase().includes("image");

        if (isImageCT) {
          // Look for a complete JPEG frame anywhere in the body so far.
          const s = body.indexOf(SOI10);
          if (s !== -1) {
            const e = body.indexOf(EOI10, s + 2);
            if (e !== -1) {
              // Found a complete JPEG — done!
              settle({ statusCode, contentType, wwwAuth, body: body.subarray(s, e + 2) });
              return;
            }
          }
        }

        // For non-image or incomplete JPEG: wait until connection closes (isFinal).
        if (isFinal) {
          if (isImageCT && body.length === 0) {
            // Diagnostic: log full raw response so we can see exactly what the camera sent
            process.stdout.write(
              `[DIAG] ${urlPath} → 200 image/jpeg + 0 bytes body. Full raw (${rxBuf.length}B):\n` +
              `  Headers: ${headersRaw.replace(/\r\n/g, "\\r\\n | ")}\n` +
              `  Body hex: ${body.toString("hex") || "(empty)"}\n`
            );
          }
          settle({ statusCode, contentType, wwwAuth, body });
        }
      };

      sock.on("connect", () => {
        timer = setTimeout(() => {
          // On timeout, try to parse whatever arrived (may have partial JPEG).
          tryParse(true);
          if (!settled) fail(new Error("timeout"));
        }, timeoutMs);
        sock.write(reqBuf);
      });

      sock.on("data", (chunk) => {
        rxBuf = Buffer.concat([rxBuf, chunk]);
        tryParse(false);
      });

      sock.on("end",   () => { tryParse(true); if (!settled) fail(new Error("empty response")); });
      sock.on("close", () => { tryParse(true); if (!settled) fail(new Error("connection closed")); });
      sock.on("error", fail);
    });
  }

  // Auth dance: try cached Digest first, fall back to Basic→401→Digest.
  const cached = digestAuthCache.get(ip);
  if (cached) {
    const hdr = buildDigestHeader(user, pass, urlPath, cached);
    return sendRequest(hdr).then((r) => {
      if (r.statusCode !== 401) return r;
      // Stale nonce — clear and retry from scratch.
      digestAuthCache.delete(ip);
      return rawHttp10Get(ip, port, urlPath, user, pass, timeoutMs);
    });
  }

  const basicHdr = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  return sendRequest(basicHdr).then((r) => {
    if (r.statusCode !== 401) return r;
    if (!r.wwwAuth.toLowerCase().includes("digest")) return r;
    // Build Digest response from 401 challenge.
    const realm  = (r.wwwAuth.match(/realm="([^"]+)"/i)  || [])[1] || "";
    const nonce  = (r.wwwAuth.match(/nonce="([^"]+)"/i)  || [])[1] || "";
    const qop    = (r.wwwAuth.match(/qop="([^"]+)"/i)    || [])[1] || "";
    const opaque = (r.wwwAuth.match(/opaque="([^"]+)"/i) || [])[1] || "";
    const md5    = (s) => crypto.createHash("md5").update(s).digest("hex");
    const HA1    = md5(`${user}:${realm}:${pass}`);
    const entry  = { realm, nonce, qop, opaque, HA1 };
    digestAuthCache.set(ip, entry);
    const digestHdr = buildDigestHeader(user, pass, urlPath, entry);
    return sendRequest(digestHdr);
  });
}

// httpGet — supports HTTP Basic and Digest auth automatically.
// Caches Digest credentials per IP to avoid the Basic→401→Digest roundtrip on every frame.
function httpGet(ip, port, urlPath, user, pass, timeoutMs = 4000) {
  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);

  function doRequest(extraHeaders) {
    return new Promise((resolve, reject) => {
      // Do NOT send Connection: close — cameras may stream JPEG data over the
      // open connection and close it immediately if they see Connection: close.
      const headers = Object.assign({}, extraHeaders);
      const opts = { hostname: ip, port, path: urlPath, method: "GET",
                     headers, timeout: timeoutMs };

      let settled = false;
      const settle = (val) => { if (!settled) { settled = true; resolve(val); } };
      const fail   = (err) => { if (!settled) { settled = true; reject(err);  } };

      const req = http.request(opts, (res) => {
        const contentType = res.headers["content-type"] || "";
        const isImageCT   = contentType.includes("jpeg") || contentType.includes("image");
        const chunks = [];

        res.on("data", (c) => {
          chunks.push(c);
          // For JPEG streaming responses: extract first complete frame and stop.
          // Camera keeps connection open indefinitely — we must close it ourselves.
          if (!isImageCT) return;
          const body = Buffer.concat(chunks);
          const s = body.indexOf(SOI);
          if (s === -1) return;
          const e = body.indexOf(EOI, s + 2);
          if (e === -1) return;
          // Got a complete JPEG — resolve immediately and close the connection.
          req.destroy();
          settle({ status: res.statusCode, headers: res.headers, contentType,
                   body: body.subarray(s, e + 2) });
        });

        res.on("end", () => {
          // Non-streaming response (401 challenge, HTML, etc.) — resolve with all data.
          settle({ status: res.statusCode, headers: res.headers, contentType,
                   body: Buffer.concat(chunks) });
        });
      });

      req.on("error", (err) => fail(err));
      req.on("timeout", () => { req.destroy(); fail(new Error("timeout")); });
      req.end();
    });
  }

  function extractAndCacheDigest(fullAuth) {
    const realm  = (fullAuth.match(/realm="([^"]+)"/i)  || [])[1] || "";
    const nonce  = (fullAuth.match(/nonce="([^"]+)"/i)  || [])[1] || "";
    const qop    = (fullAuth.match(/qop="([^"]+)"/i)    || [])[1] || "";
    const opaque = (fullAuth.match(/opaque="([^"]+)"/i) || [])[1] || "";
    const md5    = (s) => crypto.createHash("md5").update(s).digest("hex");
    const HA1    = md5(`${user}:${realm}:${pass}`);
    const cached = { realm, nonce, qop, opaque, HA1 };
    digestAuthCache.set(ip, cached);
    return cached;
  }

  // If we have cached Digest credentials, try them first (skip the Basic→401 roundtrip)
  const cached = digestAuthCache.get(ip);
  if (cached) {
    const digestHdr = buildDigestHeader(user, pass, urlPath, cached);
    return doRequest({ Authorization: digestHdr }).then((r) => {
      if (r.status !== 401) return r;
      // Stale nonce — refresh cache via Basic→401→Digest dance
      digestAuthCache.delete(ip);
      return httpGet(ip, port, urlPath, user, pass, timeoutMs);
    });
  }

  const basicAuth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

  return doRequest({ Authorization: basicAuth }).then((r) => {
    if (r.status !== 401) return r;
    // Got 401 — check if camera wants Digest
    const wwwAuth = (r.headers["www-authenticate"] || "").toLowerCase();
    if (!wwwAuth.includes("digest")) return r; // Basic was rejected, nothing more to try

    const newCached = extractAndCacheDigest(r.headers["www-authenticate"] || "");
    const digestHdr = buildDigestHeader(user, pass, urlPath, newCached);
    return doRequest({ Authorization: digestHdr });
  });
}

// ─── WS-Discovery ─────────────────────────────────────────────────────────────
// Sends an ONVIF WS-Discovery Probe to the camera's IP on UDP port 3702.
// The camera responds with its actual ONVIF service URL (XAddrs).
function wsDiscoverOnvif(cameraIp, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const msgId = crypto.randomUUID ? crypto.randomUUID()
                : crypto.randomBytes(16).toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
    const probe = [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"`,
      ` xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"`,
      ` xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"`,
      ` xmlns:dn="http://www.onvif.org/ver10/network/wsdl">`,
      `<s:Header>`,
      `<a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>`,
      `<a:MessageID>urn:uuid:${msgId}</a:MessageID>`,
      `<a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>`,
      `</s:Header><s:Body>`,
      `<d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>`,
      `</s:Body></s:Envelope>`,
    ].join("");
    const buf  = Buffer.from(probe);
    const sock = dgram.createSocket("udp4");
    const found = [];
    sock.on("message", (msg) => {
      const text = msg.toString("utf8");
      const m    = text.match(/<(?:[^>]+:)?XAddrs[^>]*>(.*?)<\/(?:[^>]+:)?XAddrs>/s);
      if (m) found.push(...m[1].trim().split(/\s+/).filter(Boolean));
    });
    sock.on("error", () => resolve(found));
    sock.bind(0, () => {
      // Send unicast to camera (more reliable than multicast across subnets)
      sock.send(buf, 3702, cameraIp, (e) => {
        if (e) { sock.close(); resolve([]); return; }
        // Also try multicast in case unicast doesn't reach
        sock.send(buf, 3702, "239.255.255.250");
        setTimeout(() => { try { sock.close(); } catch {} resolve(found); }, timeoutMs);
      });
    });
  });
}

async function discoverHttpSnapshot(ip, port, user, pass, label) {
  // Probe the root page via raw HTTP/1.0 socket to warm the auth cache.
  try {
    const r = await rawHttp10Get(ip, port, "/", user, pass, 3000);
    const snippet = r.body.toString("utf8", 0, 200).replace(/\s+/g, " ").trim();
    console.log(`[${label}] Camera root (HTTP/1.0) → HTTP ${r.statusCode}: ${snippet}`);
    if (r.statusCode === 401) {
      console.log(`[${label}]   WWW-Authenticate: ${r.wwwAuth || "(none)"}`);
    }
  } catch (e) {
    console.log(`[${label}] Camera root error: ${e.message}`);
  }

  // Helper: try a single path and return JPEG url if found, null otherwise.
  const tryPath = async (snapPath, u, p) => {
    try {
      const r = await rawHttp10Get(ip, port, snapPath, u, p, 8000);
      const isJpeg = r.body.length > 3 && (
        r.contentType.toLowerCase().includes("jpeg") ||
        r.contentType.toLowerCase().includes("image") ||
        (r.body[0] === 0xff && r.body[1] === 0xd8)
      );
      if (r.statusCode === 200 && isJpeg) {
        const authDesc = u ? "Digest auth" : "no-auth";
        console.log(`[${label}] ✓ HTTP snapshot found: http://${ip}:${port}${snapPath}  (${r.contentType}, ${r.body.length} bytes, ${authDesc})`);
        return `http://${ip}:${port}${snapPath}`;
      }
      if (r.statusCode === 200) {
        const peek = r.body.toString("utf8", 0, 80).replace(/\s+/g, " ");
        console.log(`[${label}]   ${snapPath} → 200 non-image (${r.contentType || "no-ct"}): ${peek}`);
      } else if (r.statusCode === 401) {
        console.log(`[${label}]   ${snapPath} → 401 (auth failed even with Digest)`);
      }
    } catch { /* timeout or connection error — try next */ }
    return null;
  };

  // Phase 1: Try each path with HTTP Digest auth (standard approach).
  for (const snapPath of HTTP_SNAPSHOT_PATHS) {
    const found = await tryPath(snapPath, user, pass);
    if (found) return found;
  }

  // Phase 2: Some cameras use URL-parameter auth instead of HTTP auth.
  // Try /image.jpg with credentials in URL query string (no HTTP auth header).
  const urlAuthPaths = [
    `/image.jpg?user=${user}&pass=${pass}`,
    `/image.jpg?usr=${user}&pwd=${pass}`,
    `/image.jpg?username=${user}&password=${pass}`,
    `/image.jpg?u=${user}&p=${pass}`,
    `/snapshot.jpg?user=${user}&pass=${pass}`,
    `/cgi-bin/snapshot.cgi?user=${user}&pass=${pass}`,
  ];
  console.log(`[${label}] Trying URL-parameter auth paths…`);
  for (const snapPath of urlAuthPaths) {
    const found = await tryPath(snapPath, "", ""); // no HTTP auth header
    if (found) return found;
  }

  // Phase 3: Try /image.jpg with NO auth at all (LAN-trusted cameras).
  console.log(`[${label}] Trying auth-free /image.jpg…`);
  const noAuth = await tryPath("/image.jpg", "", "");
  if (noAuth) return noAuth;

  return null; // no HTTP snapshot found
}

// ─── HTTP snapshot poller ─────────────────────────────────────────────────────
// Used when RTSP is unavailable. Polls a JPEG snapshot URL and emits frames.
function startHttpPoller(camera) {
  const { ip, label, snapshotUrl } = camera;
  let frameCount = 0;
  let stopped    = false;

  function poll() {
    if (stopped) return;
    const parsed   = new URL(snapshotUrl);
    const camPort  = parseInt(parsed.port) || 8000;
    const camPath  = parsed.pathname + parsed.search;
    rawHttp10Get(ip, camPort, camPath, RTSP_USER, RTSP_PASS, 5000)
      .then((r) => {
        if (stopped) return;
        const isJpeg = r.body.length > 3 && (
          r.contentType.toLowerCase().includes("jpeg") ||
          r.contentType.toLowerCase().includes("image") ||
          (r.body[0] === 0xff && r.body[1] === 0xd8)
        );
        if (r.statusCode === 200 && isJpeg) {
          if (frameCount === 0)
            console.log(`[${label}] ✓ HTTP snapshot stream active (polling ${Math.round(1000 / HTTP_SNAPSHOT_FPS)}ms)`);
          frameCount++;
          sendFrame(ip, r.body);
        } else if (r.statusCode === 200 && r.body.length === 0) {
          // Camera returned empty body — don't send blank frame, just retry.
          if (frameCount === 0) console.log(`[${label}] Camera returned empty response — retrying…`);
        }
        setTimeout(poll, Math.round(1000 / HTTP_SNAPSHOT_FPS));
      })
      .catch((e) => {
        if (stopped) return;
        console.log(`[${label}] HTTP poll error: ${e.message}. Retry in ${RECONNECT_MS / 1000}s…`);
        frameCount = 0;
        camera.snapshotUrl = null; // re-probe next time
        setTimeout(() => {
          discoverHttpSnapshot(ip, camera.rtspPort, RTSP_USER, RTSP_PASS, label)
            .then((url) => {
              if (url) { camera.snapshotUrl = url; startHttpPoller(camera); }
              else setTimeout(poll, RECONNECT_MS);
            });
        }, RECONNECT_MS);
      });
  }
  poll();
  return () => { stopped = true; };
}

async function runNetworkCheck() {
  console.log("[check] Scanning cameras for open RTSP ports…");
  let anyReachable = false;

  for (const camera of CAMERAS) {
    const port = await discoverRtspPort(camera);
    if (port !== null) {
      camera.rtspPort  = port;
      camera.onvifUrl  = null;
      anyReachable     = true;

      // Port 8000 = HTTP management only, not a direct RTSP port.
      // Discovery order:
      //   1. WS-Discovery (UDP) → camera announces its actual ONVIF service URL
      //   2. ONVIF GetStreamUri SOAP → retrieve RTSP URL from the discovered endpoint
      //   3. HTTP JPEG snapshot probe (Digest auth) → HTTP polling fallback
      if (port === 8000) {
        camera.snapshotUrl = null;

        // Step 1: WS-Discovery — ask the camera to broadcast its ONVIF endpoint
        let onvifSvcUrl = null;
        console.log(`[${camera.label}] WS-Discovery probe → ${camera.ip}:3702…`);
        try {
          const xaddrs = await wsDiscoverOnvif(camera.ip);
          if (xaddrs.length > 0) {
            console.log(`[${camera.label}] WS-Discovery found: ${xaddrs.join(" | ")}`);
            onvifSvcUrl = xaddrs[0]; // use first URL
          } else {
            console.log(`[${camera.label}] WS-Discovery: no response (camera may not support UDP)`);
          }
        } catch (e) {
          console.log(`[${camera.label}] WS-Discovery error: ${e.message}`);
        }

        // Step 2: ONVIF GetStreamUri — either at WS-Discovery URL or standard paths
        const onvifIp   = onvifSvcUrl ? (new URL(onvifSvcUrl).hostname || camera.ip) : camera.ip;
        const onvifPort = onvifSvcUrl ? (parseInt(new URL(onvifSvcUrl).port) || 8000) : port;
        console.log(`[${camera.label}] ONVIF probe → ${onvifIp}:${onvifPort}…`);
        try {
          const uri = await onvifGetStreamUri(onvifIp, onvifPort, RTSP_USER, ONVIF_PASS, camera.label);
          if (uri) {
            console.log(`[${camera.label}] ONVIF stream URI: ${uri}`);
            camera.onvifUrl = uri;
          } else {
            // Step 3: HTTP JPEG snapshot (Digest auth now supported)
            console.log(`[${camera.label}] ONVIF returned no URI — probing for HTTP snapshot (Digest auth)…`);
            const snapUrl = await discoverHttpSnapshot(camera.ip, port, RTSP_USER, RTSP_PASS, camera.label);
            if (snapUrl) {
              camera.snapshotUrl = snapUrl;
            } else {
              console.log(`[${camera.label}] No HTTP snapshot found — will cycle RTSP paths.`);
            }
          }
        } catch (err) {
          console.log(`[${camera.label}] ONVIF error: ${err.message}`);
        }
      }

      console.log(`[check] ✓  ${camera.label} (${camera.ip}) — port ${port} open`);
    } else {
      // Check port 80 separately to see if camera web UI is accessible
      const hasWebUi = await probeTcp(camera.ip, 80, 1500);
      const webHint  = hasWebUi
        ? `  → Web UI reachable: open http://${camera.ip} in your browser on the same WiFi to check settings.`
        : `  → Port 80 also closed. Camera may require RTSP to be enabled in the LaView Pro app.`;
      console.log(`[check] ✗  ${camera.label} (${camera.ip}) — no RTSP port found`);
      console.log(webHint);
      camera.rtspPort = null;
      camera.onvifUrl = null;
    }
  }

  if (!anyReachable) {
    console.log("");
    console.log("  ────────────────────────────────────────────────────────");
    console.log("  RTSP is not responding on any camera.");
    console.log("  The WebSocket to VP Chef Studio is connected (good).");
    console.log("  The issue is between this PC and the cameras.");
    console.log("");
    console.log("  Most likely fix — enable RTSP on each camera:");
    console.log("    1. Open the LaView Pro app on your phone.");
    console.log("    2. Tap the camera → Settings (gear icon).");
    console.log("    3. Look for 'RTSP', 'Local Access', or 'Third Party'.");
    console.log("    4. Enable it. Note the username/password shown.");
    console.log("    5. Put the password in relay.js line 22:  RTSP_PASS = \"yourpassword\"");
    console.log("");
    console.log("  Quick test with VLC (on this PC):");
    console.log(`    Open Network Stream → rtsp://admin:@${CAMERAS[0].ip}:554/h264/ch01/main/av_stream`);
    console.log("");
    console.log("  The relay will keep probing every 5s.");
    console.log("  ────────────────────────────────────────────────────────");
    console.log("");
  } else {
    console.log("[check] Ready. Starting streams for reachable cameras.\n");
  }
}

// ─── Per-camera ffmpeg capture ────────────────────────────────────────────────
// Cycles through RTSP_PATHS_TO_TRY automatically until frames flow.
// Falls back from TCP to UDP transport after 2 consecutive failures.
// If camera.snapshotUrl is set (HTTP polling mode), uses that instead of ffmpeg.
function startCamera(camera, pathIndex = 0, transport = "tcp", consecutiveFails = 0) {
  const { ip, label } = camera;

  // HTTP snapshot polling mode — no ffmpeg needed.
  if (camera.snapshotUrl) {
    console.log(`[${label}] Starting HTTP snapshot polling → ${camera.snapshotUrl}`);
    startHttpPoller(camera);
    return;
  }

  // Wait and retry if this camera's port isn't known yet.
  if (camera.rtspPort === null) {
    setTimeout(async () => {
      const port = await discoverRtspPort(camera);
      camera.rtspPort = port;
      if (port) {
        console.log(`[${label}] Port ${port} opened — starting stream.`);
        startCamera(camera, 0, "tcp", 0);
      } else {
        startCamera(camera, pathIndex, transport, consecutiveFails);
      }
    }, RECONNECT_MS);
    return;
  }

  const port = camera.rtspPort;

  // After 2 consecutive failures on TCP, switch to UDP transport.
  const useTransport = (transport === "tcp" && consecutiveFails >= 2) ? "udp" : transport;
  if (useTransport === "udp" && transport === "tcp") {
    console.log(`[${label}] Switching to UDP transport.`);
  }

  // Use ONVIF-discovered URL when available; fall back to guessed paths.
  // After 3 consecutive failures on an ONVIF URL, clear it and switch to guessing.
  let rtspUrl;
  if (camera.onvifUrl && consecutiveFails < 3) {
    rtspUrl = camera.onvifUrl;
    console.log(`[${label}] Trying ${useTransport.toUpperCase()} → ${rtspUrl}  [ONVIF]`);
  } else {
    if (camera.onvifUrl && consecutiveFails >= 3) {
      console.log(`[${label}] ONVIF URL failed 3× — falling back to path guessing.`);
      camera.onvifUrl = null;
    }
    const urlPath = RTSP_PATHS_TO_TRY[pathIndex % RTSP_PATHS_TO_TRY.length];
    const auth    = RTSP_PASS ? `${RTSP_USER}:${RTSP_PASS}@` : (RTSP_USER ? `${RTSP_USER}:@` : "");
    rtspUrl       = `rtsp://${auth}${ip}:${port}${urlPath}`;
    console.log(`[${label}] Trying ${useTransport.toUpperCase()} → ${rtspUrl}`);
  }

  // ── HLS output directory for this camera ────────────────────────────────────
  const hlsDir = path.join(HLS_BASE, `cam${camera.slot}`);
  try { fs.mkdirSync(hlsDir, { recursive: true }); } catch {}
  // Remove stale HLS files from previous run so the phone doesn't play old segments
  try {
    for (const f of fs.readdirSync(hlsDir)) {
      if (f.endsWith(".m3u8") || f.endsWith(".ts")) {
        fs.unlinkSync(path.join(hlsDir, f));
      }
    }
  } catch {}
  const hlsIndex    = path.join(hlsDir, "index.m3u8");
  const hlsSegFmt   = path.join(hlsDir, "seg%05d.ts");
  camera.hlsDir   = hlsDir;
  camera.hlsReady = false;

  const proc = spawn(FFMPEG_PATH, [
    "-hide_banner",
    "-loglevel",       "warning",
    "-rtsp_transport", useTransport,
    "-timeout",        "5000000",
    "-i",              rtspUrl,
    // ── Output 1: JPEG frames → stdout (existing recording + WS preview) ────
    "-map",            "0:v",
    "-f",              "image2pipe",
    "-vcodec",         "mjpeg",
    "-q:v",            String(JPEG_QUALITY),
    "-r",              String(OUTPUT_FPS),
    "pipe:1",
    // ── Output 2: HLS stream → local temp dir (smooth live preview) ─────────
    // -c:v copy = zero-transcode cost; camera already outputs H.264.
    // -hls_time 1 + -hls_list_size 3 → ~2-3s live latency.
    // -hls_flags delete_segments removes old .ts files automatically.
    "-map",            "0:v",
    "-c:v",            "copy",
    "-bsf:v",          "h264_mp4toannexb",
    "-f",              "hls",
    "-hls_time",       "1",
    "-hls_list_size",  "3",
    "-hls_flags",      "delete_segments+append_list",
    "-hls_segment_filename", hlsSegFmt,
    hlsIndex,
  ]);

  let buffer    = Buffer.alloc(0);
  let gotFrames = false;
  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);

  // Watch for HLS index.m3u8 to appear — signals HLS is live
  let hlsWatcher = null;
  try {
    hlsWatcher = fs.watch(hlsDir, (eventType, filename) => {
      if (!camera.hlsReady && filename === "index.m3u8" && fs.existsSync(hlsIndex)) {
        camera.hlsReady = true;
        console.log(`[${label}] HLS ready → ${hlsIndex}`);
      }
    });
  } catch {}

  proc.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let from = 0;
    while (true) {
      const s = buffer.indexOf(SOI, from);
      if (s === -1) break;
      const e = buffer.indexOf(EOI, s + 2);
      if (e === -1) break;
      if (!gotFrames) {
        console.log(`[${label}] ✓ Live stream: ${rtspUrl} (${useTransport.toUpperCase()})`);
        gotFrames = true;
        // Store confirmed RTSP URL so recording processes can reuse it
        camera.activeRtspUrl   = rtspUrl;
        camera.activeTransport = useTransport;
        // Also do an immediate HLS-ready check (watcher may have fired already)
        if (!camera.hlsReady && fs.existsSync(hlsIndex)) {
          camera.hlsReady = true;
          console.log(`[${label}] HLS ready (immediate check) → ${hlsIndex}`);
        }
      }
      sendFrame(ip, buffer.subarray(s, e + 2));
      from = e + 2;
    }
    buffer = from > 0 ? buffer.subarray(from) : buffer;
    if (buffer.length > 4 * 1024 * 1024) buffer = Buffer.alloc(0);
  });

  proc.stderr.on("data", (d) => {
    const line = d.toString().trim();
    if (line) console.warn(`[${label}] ${line}`);
  });

  proc.on("close", (code) => {
    if (hlsWatcher) { try { hlsWatcher.close(); } catch {} hlsWatcher = null; }
    camera.hlsReady = false;
    const failed = code !== 0;
    const nextFails = failed ? consecutiveFails + 1 : 0;
    // Advance to next URL path after 2 failures so we cycle through all options.
    const nextPathIndex = (failed && nextFails % 2 === 0) ? pathIndex + 1 : pathIndex;
    console.log(`[${label}] Stream ended (code ${code}). Retrying in ${RECONNECT_MS / 1000}s…`);
    buffer = Buffer.alloc(0);
    setTimeout(() => startCamera(camera, nextPathIndex, useTransport, nextFails), RECONNECT_MS);
  });

  proc.on("error", (err) => {
    console.error(`[${label}] Could not start ffmpeg: ${err.message}`);
    setTimeout(() => startCamera(camera, pathIndex, useTransport, consecutiveFails + 1), RECONNECT_MS);
  });
}

// ─── Local LAN snapshot server (port 8082) ───────────────────────────────────
// Serves JPEG snapshots directly to phones over local WiFi — zero cloud hop.
// Phone connects to http://<PC-IP>:8082/cam/snapshot?ip=192.168.1.177
// No internet involved; all traffic stays on the local network.
//
// The mobile app settings screen shows exactly where to find the PC IP
// and what to enter in the "PC Local IP" field.
const LOCAL_SERVER_PORT = 8082;
const { networkInterfaces } = require("os");

// Helper: read POST body as parsed JSON
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end",  () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

const localServer = http.createServer(async (req, res) => {
  const parsed  = new URL(req.url || "/", `http://localhost`);
  const reqPath = parsed.pathname;

  // CORS headers — allow any origin so Expo Go (LAN) can fetch
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // GET /cam/probe — returns status of all cameras including HLS readiness
  if (req.method === "GET" && reqPath === "/cam/probe") {
    const cameras = CAMERAS.map(c => ({
      ip:       c.ip,
      label:    c.label,
      slot:     c.slot,
      online:   localFrames.has(c.ip),
      frameAge: localFrameTime.has(c.ip) ? Date.now() - localFrameTime.get(c.ip) : null,
      hlsReady: !!c.hlsReady,
    }));
    const body = JSON.stringify({
      online:    true,
      cameras,
      port:      LOCAL_SERVER_PORT,
      recording: recordingState.active,
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(body);
    return;
  }

  // GET /cam/snapshot?ip=192.168.1.177 — return latest JPEG for that camera
  if (req.method === "GET" && reqPath === "/cam/snapshot") {
    const ip    = parsed.searchParams.get("ip") || "";
    const frame = localFrames.get(ip);
    if (!frame) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No frame yet — camera may still be connecting" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type":   "image/jpeg",
      "Content-Length": frame.length,
      "Cache-Control":  "no-cache, no-store",
      "Pragma":         "no-cache",
    });
    res.end(frame);
    return;
  }

  // GET /cam/stream?ip=... — rudimentary MJPEG push for the given IP
  if (req.method === "GET" && reqPath === "/cam/stream") {
    const ip = parsed.searchParams.get("ip") || "";
    const boundary = "relayframe";
    res.writeHead(200, {
      "Content-Type":  `multipart/x-mixed-replace;boundary=${boundary}`,
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    });

    // Push latest frame immediately, then push again whenever localFrames updates
    const pushFrame = () => {
      const f = localFrames.get(ip);
      if (!f) return;
      const hdr = `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`;
      try { res.write(Buffer.concat([Buffer.from(hdr), f, Buffer.from("\r\n")])); } catch {}
    };

    pushFrame();
    const interval = setInterval(pushFrame, Math.round(1000 / OUTPUT_FPS));
    req.on("close", () => clearInterval(interval));
    return;
  }

  // ── Recording control endpoints ─────────────────────────────────────────────

  // POST /cam/record/start — start capturing frames from all cameras
  // Body: { title, sessionId?, authToken? }
  if (req.method === "POST" && reqPath === "/cam/record/start") {
    try {
      const body = await readJsonBody(req);
      if (recordingState.active) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, alreadyRecording: true, startMs: recordingState.startMs }));
        return;
      }
      recordingState.active      = true;
      recordingState.sessionId   = body.sessionId || String(Date.now());
      recordingState.title       = body.title || "Recording Session";
      recordingState.startMs     = Date.now();
      recordingState.lastCaptureMs = {};
      recordingState.frames      = {};
      recordingState.authToken   = body.authToken || null;
      console.log(`[record] ▶ Started recording session: "${recordingState.title}"`);
      const camStatus = CAMERAS.map(c => ({ slot: c.slot, label: c.label, hasFrames: localFrames.has(c.ip) }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, startMs: recordingState.startMs, cameras: camStatus }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /cam/record/stop — stop recording and upload frames to production server
  // Body: { authToken? } (optional override)
  if (req.method === "POST" && reqPath === "/cam/record/stop") {
    if (!recordingState.active) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Not recording" }));
      return;
    }

    // Snapshot recording state and stop it immediately
    recordingState.active = false;
    const durationSec = Math.round((Date.now() - recordingState.startMs) / 1000);
    const title       = recordingState.title;
    const frames      = recordingState.frames;
    const totalFrames = Object.values(frames).reduce((n, arr) => n + arr.length, 0);
    let authToken;
    try {
      const body = await readJsonBody(req);
      authToken = body.authToken || recordingState.authToken || null;
    } catch { authToken = recordingState.authToken || null; }

    console.log(`[record] ■ Stopped. Duration: ${durationSec}s, cameras: ${Object.keys(frames).length}, frames: ${totalFrames}`);

    // Validate we have frames before uploading
    if (totalFrames === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok:     false,
        reason: "No frames captured — cameras may not be connected yet",
        cameras: CAMERAS.map(c => ({ slot: c.slot, frames: (frames[c.ip] || []).length })),
      }));
      return;
    }

    // Start upload asynchronously — respond immediately so phone doesn't time out.
    // The mobile app polls /cam/record/status for the result.
    recordingState.uploadStatus  = "uploading";
    recordingState.uploadResult  = null;
    recordingState.uploadError   = null;

    console.log(`[record] Uploading ${totalFrames} frames (${Object.keys(frames).length} cameras) to ${SERVER_DOMAIN}…`);

    uploadRelaySession(title, durationSec, authToken).then(result => {
      recordingState.uploadStatus = "done";
      recordingState.uploadResult = result;
      const segs = (result.aiAnalysis?.videoSegments || []).length;
      console.log(`[record] ✓ Upload complete. Server session ID: ${result.id} — ${segs} AI segments`);
    }).catch(err => {
      recordingState.uploadStatus = "error";
      recordingState.uploadError  = err.message;
      console.error(`[record] ✗ Upload failed: ${err.message}`);
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok:          true,
      durationSec,
      totalFrames,
      cameras:     CAMERAS.map(c => ({ slot: c.slot, label: c.label, frames: (frames[c.ip] || []).length })),
      uploadStatus: "uploading",
    }));
    return;
  }

  // GET /cam/record/status — poll for upload result after stopping
  if (req.method === "GET" && reqPath === "/cam/record/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      recording:    recordingState.active,
      uploadStatus: recordingState.uploadStatus || "idle",
      sessionId:    recordingState.uploadResult?.id || null,
      aiSegments:   (recordingState.uploadResult?.aiAnalysis?.videoSegments || []).length,
      error:        recordingState.uploadError || null,
    }));
    return;
  }

  // ── GET /cam/hls/:slot/index.m3u8  or  /cam/hls/:slot/seg*.ts ───────────────
  // Serves HLS files written by ffmpeg to the temp HLS directory.
  // expo-video on the phone requests these over local WiFi — no cloud hop.
  if (req.method === "GET" && reqPath.startsWith("/cam/hls/")) {
    // Path format: /cam/hls/<slot>/index.m3u8 or /cam/hls/<slot>/seg00001.ts
    const parts    = reqPath.split("/").filter(Boolean); // ["cam","hls","1","index.m3u8"]
    const slot     = parseInt(parts[2] || "0", 10);
    const filename = parts[3] || "";
    const isSafe   = filename && /^[\w.-]+$/.test(filename) &&
                     (filename.endsWith(".m3u8") || filename.endsWith(".ts"));
    if (!slot || slot < 1 || slot > 3 || !isSafe) {
      res.writeHead(400); res.end("Bad request"); return;
    }
    const filePath = path.join(HLS_BASE, `cam${slot}`, filename);
    if (!fs.existsSync(filePath)) {
      // HLS not ready yet — phone will retry
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ error: "HLS not ready — stream may still be starting" }));
      return;
    }
    const isM3u8 = filename.endsWith(".m3u8");
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type":  isM3u8 ? "application/vnd.apple.mpegurl" : "video/mp2t",
        "Content-Length": data.length,
        // Playlist: no-cache so player always gets latest segment list
        // Segments: short cache — they don't change once written
        "Cache-Control": isM3u8 ? "no-cache, no-store" : "max-age=10",
      });
      res.end(data);
    } catch (e) {
      res.writeHead(500); res.end("File read error");
    }
    return;
  }

  // GET /status — Electron dashboard polls this every 2.5s for live camera state
  if (req.method === "GET" && reqPath === "/status") {
    const cameras = CAMERAS.map(c => ({
      slot:      c.slot,
      label:     c.label,
      ip:        c.ip,
      frames:    frameCounts.get(c.ip) || 0,
      online:    localFrames.has(c.ip),
      hlsReady:  !!c.hlsReady,
    }));
    const nets3 = networkInterfaces();
    const pcIps = [];
    for (const n3 of Object.keys(nets3)) {
      for (const iface of nets3[n3]) {
        if ((iface.family === "IPv4" || iface.family === 4) && !iface.internal) pcIps.push(iface.address);
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      cameras,
      serverConnected: wsReady,
      recording:       recordingState.active,
      pcIps,
    }));
    return;
  }

  // GET /relay/info — Returns PC network IPs + port for mobile pairing
  if (req.method === "GET" && reqPath === "/relay/info") {
    const nets4 = networkInterfaces();
    const pcIps4 = [];
    for (const n4 of Object.keys(nets4)) {
      for (const iface of nets4[n4]) {
        if ((iface.family === "IPv4" || iface.family === 4) && !iface.internal) pcIps4.push(iface.address);
      }
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ pcIps: pcIps4, port: LOCAL_SERVER_PORT, version: "1.1.0" }));
    return;
  }

  // GET /cam/discover — Scan local subnet for devices answering on camera ports
  // Returns within ~8 s for a /24 subnet. The mobile app calls this after entering the PC IP.
  if (req.method === "GET" && reqPath === "/cam/discover") {
    const nets5 = networkInterfaces();
    const subnets = [];
    for (const n5 of Object.keys(nets5)) {
      for (const iface of nets5[n5]) {
        if ((iface.family === "IPv4" || iface.family === 4) && !iface.internal) {
          const parts = iface.address.split(".");
          if (parts.length === 4) subnets.push(parts.slice(0, 3).join("."));
        }
      }
    }
    const uniqueSubnets = [...new Set(subnets)];
    const portsToScan   = [5543, 8000, 554, 8554];
    const TIMEOUT_MS    = 500;

    const scanHost = (ip, port) => new Promise(resolve => {
      const sock = new net.Socket();
      let done = false;
      sock.setTimeout(TIMEOUT_MS);
      sock.once("connect", () => { done = true; sock.destroy(); resolve(true); });
      sock.once("timeout", () => { if (!done) { done = true; sock.destroy(); resolve(false); } });
      sock.once("error",   () => { if (!done) { done = true; resolve(false); } });
      try { sock.connect(port, ip); } catch { resolve(false); }
    });

    const found = [];
    for (const subnet of uniqueSubnets) {
      const promises = [];
      for (let i = 1; i <= 254; i++) {
        const ip = `${subnet}.${i}`;
        promises.push(
          Promise.any(portsToScan.map(p =>
            scanHost(ip, p).then(ok => { if (!ok) throw new Error("no"); return ip; })
          )).then(ip2 => found.push(ip2)).catch(() => {})
        );
      }
      await Promise.all(promises);
    }

    const existingIps = CAMERAS.map(c => c.ip);
    const results = found.sort().map(ip => ({
      ip,
      configured:    existingIps.includes(ip),
      suggestedSlot: (() => { const idx = existingIps.indexOf(ip); return idx >= 0 ? CAMERAS[idx].slot : null; })(),
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ found: results, scannedSubnets: uniqueSubnets }));
    return;
  }

  // POST /config/credentials — Update RTSP/ONVIF credentials without editing relay-config.json manually
  if (req.method === "POST" && reqPath === "/config/credentials") {
    try {
      const body = await readJsonBody(req);
      const configPath = path.join(__dirname, "relay-config.json");
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
      const updated = {
        ...existing,
        ...(body.rtspUser  !== undefined ? { rtspUser:  body.rtspUser  } : {}),
        ...(body.rtspPass  !== undefined ? { rtspPass:  body.rtspPass  } : {}),
        ...(body.onvifPass !== undefined ? { onvifPass: body.onvifPass } : {}),
      };
      fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n");
      if (body.rtspUser !== undefined) RTSP_USER = body.rtspUser;
      if (body.rtspPass !== undefined) RTSP_PASS = body.rtspPass;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e.message) }));
    }
    return;
  }

    res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("VP Chef Studio local relay — endpoints:\n  GET  /cam/probe\n  GET  /cam/snapshot?ip=\n  GET  /cam/stream?ip=\n  GET  /cam/hls/:slot/index.m3u8\n  GET  /status\n  GET  /relay/info\n  GET  /cam/discover\n  POST /config/credentials\n  POST /cam/record/start\n  POST /cam/record/stop\n  GET  /cam/record/status\n");
});

localServer.listen(LOCAL_SERVER_PORT, "0.0.0.0", () => {
  console.log("[local] Camera LAN server ready on :" + LOCAL_SERVER_PORT);
});

localServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn("[local] Port " + LOCAL_SERVER_PORT + " is already in use — local snapshot server disabled.");
  } else {
    console.warn("[local] Local server error:", err.message);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
console.log("\nVP Chef Studio — Local Camera Relay");
console.log("────────────────────────────────────");
console.log(`  Server : ${WS_URL}`);
CAMERAS.forEach(c => console.log(`  Camera : ${c.label}  (${c.ip})`));

// Print local IPs synchronously so they always appear before long RTSP output
// Node.js ≤17: family === "IPv4" (string). Node.js ≥18: family === 4 (number).
// Check both so this works on any Node version.
{
  const nets2 = networkInterfaces();
  const ips2  = [];
  for (const n of Object.keys(nets2)) {
    for (const iface of nets2[n]) {
      if ((iface.family === "IPv4" || iface.family === 4) && !iface.internal) ips2.push(iface.address);
    }
  }
  if (ips2.length) {
    console.log("\n=== MOBILE APP SETUP ===");
    console.log("Enter one of these IPs in the mobile app (Settings -> PC Local IP):");
    ips2.forEach(ip => console.log("   " + ip));
    console.log("========================\n");
  }
}
console.log("");

connectWs();
runNetworkCheck().then(() => CAMERAS.forEach(c => startCamera(c)));

process.on("SIGINT",  () => { console.log("\nRelay stopped."); process.exit(0); });
process.on("SIGTERM", () => { console.log("\nRelay stopped."); process.exit(0); });
