# VP Chef Relay — Desktop Companion

A desktop app (built with Electron) that runs on your Windows or Mac PC and connects your IP cameras to the VP Chef Studio mobile app.

## What it does

- Runs in your system tray — always on, invisible until you need it
- Reads live video from your IP cameras over local WiFi (RTSP)
- Streams footage to the VP Chef Studio cloud so you can control recordings from your phone
- Records MP4 files locally when a session is recorded
- Automatically uploads footage to the cloud after recording

## First-time setup

1. Download and install the VP Chef Relay app
2. On first launch, the setup wizard opens automatically
3. Enter the IP address of each camera (find these in your router's device list)
4. Enter your RTSP credentials (usually `admin` / your camera password)
5. Click **Start Relay** — it will appear in your system tray

## Using with the mobile app

After the relay is running:

1. Open VP Chef Studio on your phone
2. Go to **Settings → Camera Setup**
3. Find **PC Local IP** and tap **Set**
4. Enter your PC's IP address (shown in the relay window)
5. Tap **Test Relay Connection** to verify
6. Tap **↓ Import Camera IPs** to automatically pull camera config from the relay

## System tray icon colors

| Color | Meaning |
|-------|---------|
| Green | Connected and streaming |
| Yellow | Recording in progress |
| Red | Connection lost / retrying |
| Gray | Relay stopped |

## Configuration file

Camera settings are stored in `relay-config.json` next to `relay.js`:

```json
{
  "rtspUser": "admin",
  "rtspPass": "your-password",
  "onvifPass": "your-password",
  "cameras": [
    { "slot": 1, "ip": "192.168.1.177", "label": "Performance Cam" },
    { "slot": 2, "ip": "192.168.1.178", "label": "Food Prep Cam"   },
    { "slot": 3, "ip": "192.168.1.179", "label": "Stovetop Cam"    }
  ]
}
```

This file is **never overwritten** when you update the relay. Edit it directly if you prefer not to use the settings wizard.

## Building the installer

```bash
cd tools/relay-desktop
npm install
npm run dist:win    # Windows .exe installer
npm run dist:mac    # Mac .dmg
```

Requires Node.js 18+ and the `electron` + `electron-builder` dev dependencies.

## Requirements

- Node.js 18+ installed on the PC
- FFmpeg installed and on PATH (or placed in a `ffmpeg/bin/` folder next to relay.js)
- IP cameras on the same WiFi network as the PC
- Windows 10/11 or macOS 12+
