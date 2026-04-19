# VP Chef Studio — Camera Relay

> **Proprietary Software** — Copyright © 2026 VP Chef Studio / JCotton Express. All Rights Reserved.
> Unauthorized copying, distribution, or modification of this software is strictly prohibited.
> See [LICENSE](./LICENSE) for full terms.

Desktop background app that connects your LaView IP cameras to the VP Chef Studio mobile app over your local WiFi network.

## Download

Get the latest installer from the [Releases page](https://github.com/jcottonexpress/vpc-camera-relay/releases/latest).

| Platform | File |
|---|---|
| Windows | `VP.Chef.Relay.Setup.exe` |
| macOS | `VP.Chef.Relay.dmg` |

## What it does

- Runs silently in your system tray (no window)
- Reads live RTSP video from up to 3 IP cameras on your LAN
- Streams preview frames to the VP Chef Studio cloud server
- Records full-quality MP4 video locally during sessions
- Uploads recordings to VP Chef Studio after each session

## Setup

1. Install the app for your platform
2. On first launch, a 4-step wizard opens automatically
3. Enter each camera's IP address and RTSP credentials
4. The relay runs automatically from that point on

## Build from source

```bash
cd camera-relay && npm install
cd ../relay-desktop && npm install && npm run dist:win  # or dist:mac
```

Requires Node.js 20+ and ffmpeg-static (installed automatically via npm).

---

## License

This project is **proprietary and confidential**. Source code is made available for transparency and authorized evaluation only. No license is granted to copy, modify, distribute, sublicense, or use this software outside of an authorized VP Chef Studio account.

Copyright © 2026 VP Chef Studio / JCotton Express. All Rights Reserved.

