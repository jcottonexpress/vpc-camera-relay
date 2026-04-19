#!/bin/bash
# VP Chef Studio — Camera Relay (macOS / Linux)
# Just run:  bash start.sh  (or  chmod +x start.sh && ./start.sh)

set -euo pipefail

echo ""
echo " VP Chef Studio - Camera Relay"
echo " ================================"
echo ""

# ── Check Node.js ──────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo " ERROR: Node.js is not installed."
  echo " Download from https://nodejs.org  (choose the LTS version)"
  echo ""
  exit 1
fi

# ── Find ffmpeg ────────────────────────────────────────────────────────────────
FFMPEG_EXE=""

# 1. Check system PATH
if command -v ffmpeg &>/dev/null; then
  FFMPEG_EXE="$(command -v ffmpeg)"
fi

# 2. Homebrew locations (Apple Silicon + Intel Mac)
if [ -z "$FFMPEG_EXE" ]; then
  for P in "/opt/homebrew/bin/ffmpeg" "/usr/local/bin/ffmpeg" "/usr/bin/ffmpeg"; do
    if [ -x "$P" ]; then
      FFMPEG_EXE="$P"
      break
    fi
  done
fi

# 3. Auto-install via Homebrew if still not found
if [ -z "$FFMPEG_EXE" ]; then
  echo " ffmpeg not found. Attempting to install via Homebrew..."
  echo " (This only happens once)"
  echo ""
  if command -v brew &>/dev/null; then
    brew install ffmpeg
    if command -v ffmpeg &>/dev/null; then
      FFMPEG_EXE="$(command -v ffmpeg)"
      echo ""
      echo " ffmpeg installed successfully."
    fi
  else
    echo " Homebrew not found. Please install ffmpeg manually:"
    echo "   Option A (recommended): Install Homebrew first:"
    echo "     /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    echo "     brew install ffmpeg"
    echo ""
    echo "   Option B: Download from https://evermeet.cx/ffmpeg/ and place"
    echo "     ffmpeg in /usr/local/bin/"
    echo ""
    exit 1
  fi
fi

echo " ffmpeg: $FFMPEG_EXE"
echo ""

# ── Auto-update relay.js from server ──────────────────────────────────────────
UPDATE_URL="https://ef6d87cd-cd0d-464c-b87b-9802ff1cac56-00-2o8khr9nlo95n.worf.replit.dev/api/cameras/relay-script"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELAY_TMP="$SCRIPT_DIR/relay.js.tmp"

echo " Checking for relay updates..."
if curl -fsSL --max-time 8 "$UPDATE_URL" -o "$RELAY_TMP" 2>/dev/null; then
  mv "$RELAY_TMP" "$SCRIPT_DIR/relay.js"
  echo " relay.js updated."
else
  echo " (Could not reach update server — using local copy)"
  rm -f "$RELAY_TMP"
fi
echo ""

# ── Run the relay ──────────────────────────────────────────────────────────────
export FFMPEG_PATH="$FFMPEG_EXE"
node "$SCRIPT_DIR/relay.js"

echo ""
echo " Relay stopped."
