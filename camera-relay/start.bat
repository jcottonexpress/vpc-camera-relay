@echo off
title VP Chef Studio — Camera Relay
setlocal enabledelayedexpansion

echo.
echo  VP Chef Studio - Camera Relay
echo  ================================
echo.

:: ── Check Node.js ────────────────────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js is not installed.
    echo  Download from https://nodejs.org  ^(choose the LTS version^)
    echo  Then double-click start.bat again.
    echo.
    pause
    exit /b 1
)

:: ── Find ffmpeg.exe ───────────────────────────────────────────────────────────
set FFMPEG_EXE=

:: 1. Check system PATH
for %%F in (ffmpeg.exe) do set FFMPEG_EXE=%%~$PATH:F

:: 2. Check alongside this script (downloaded previously)
if "!FFMPEG_EXE!"=="" (
    if exist "%~dp0ffmpeg\bin\ffmpeg.exe" set "FFMPEG_EXE=%~dp0ffmpeg\bin\ffmpeg.exe"
)

:: 3. Common fallback locations
if "!FFMPEG_EXE!"=="" (
    for %%P in (
        "C:\ffmpeg\bin\ffmpeg.exe"
        "C:\ffmpeg\ffmpeg.exe"
        "C:\Program Files\ffmpeg\bin\ffmpeg.exe"
    ) do (
        if "!FFMPEG_EXE!"=="" if exist %%P set FFMPEG_EXE=%%~P
    )
)

:: 4. Auto-download via a temp PowerShell script ───────────────────────────────
if "!FFMPEG_EXE!"=="" (
    echo  ffmpeg not found. Downloading the pre-built Windows binary automatically...
    echo  ^(This only happens once - about 80 MB^)
    echo.

    set "PS1=%~dp0_download_ffmpeg.ps1"
    set "FFMPEG_ZIP=%~dp0ffmpeg-download.zip"
    set "FFMPEG_OUT=%~dp0ffmpeg"
    set "FFMPEG_TMP=%~dp0ffmpeg-tmp"

    (
        echo [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        echo $url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
        echo $zip = '!FFMPEG_ZIP!'
        echo $out = '!FFMPEG_OUT!'
        echo $tmp = '!FFMPEG_TMP!'
        echo Write-Host '  Downloading...' -NoNewline
        echo Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        echo Write-Host ' done.'
        echo Write-Host '  Extracting...' -NoNewline
        echo Expand-Archive -Path $zip -DestinationPath $tmp -Force
        echo Write-Host ' done.'
        echo $inner = Get-ChildItem $tmp -Directory ^| Select-Object -First 1
        echo if ^($inner^) { Move-Item $inner.FullName $out -Force }
        echo Remove-Item $zip -Force -ErrorAction SilentlyContinue
        echo Remove-Item $tmp -Force -Recurse -ErrorAction SilentlyContinue
    ) > "!PS1!"

    powershell -NoProfile -ExecutionPolicy Bypass -File "!PS1!"
    del "!PS1!" 2>nul

    if exist "%~dp0ffmpeg\bin\ffmpeg.exe" (
        set "FFMPEG_EXE=%~dp0ffmpeg\bin\ffmpeg.exe"
        echo.
        echo  ffmpeg downloaded successfully.
    ) else (
        echo.
        echo  Automatic download failed.
        echo.
        echo  Please download ffmpeg manually:
        echo    1. Go to https://www.gyan.dev/ffmpeg/builds/
        echo    2. Download ffmpeg-release-essentials.zip
        echo    3. Extract it so you have a folder named  ffmpeg\bin\ffmpeg.exe
        echo       next to start.bat
        echo.
        pause
        exit /b 1
    )
)

echo  ffmpeg: !FFMPEG_EXE!
echo.

:: ── Auto-update relay.js from server ─────────────────────────────────────────
echo  Checking for relay updates...
set "UPDATE_URL=https://vp-chef-studio.replit.app/api/cameras/relay-script"
set "RELAY_FILE=%~dp0relay.js"
set "RELAY_TMP=%~dp0relay_tmp.js"

:: Try curl first (built in to Windows 10 1803+)
curl -s -f -L --max-time 10 -o "!RELAY_TMP!" "!UPDATE_URL!" 2>nul
if !errorlevel! equ 0 (
    if exist "!RELAY_TMP!" (
        move /Y "!RELAY_TMP!" "!RELAY_FILE!" >nul
        echo  relay.js updated.
    )
) else (
    :: Fallback: PowerShell
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "try { Invoke-WebRequest -Uri '!UPDATE_URL!' -OutFile '!RELAY_TMP!' -UseBasicParsing -TimeoutSec 10; Move-Item '!RELAY_TMP!' '!RELAY_FILE!' -Force; Write-Host ' relay.js updated.' } catch { Write-Host ' relay.js update failed — using local copy.' }"
)
if exist "!RELAY_TMP!" del "!RELAY_TMP!" 2>nul

:: ── Create relay-config.json if it does not exist ────────────────────────────
:: Uses a .ps1 file to avoid CMD quoting / delayed-expansion issues with ! @ # etc.
echo   Creating relay-config.json for your camera password...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-config.ps1"
echo.

:: ── Open Windows Firewall for the local LAN snapshot server (port 8082) ──────
:: The mobile app connects to http://<PC-IP>:8082 on your local WiFi — no internet.
:: Windows Firewall blocks all inbound ports by default. This adds a rule once.
:: If you see "Rule already exists" or "The object already exists", that is fine.
echo  Opening firewall port 8082 for mobile camera feeds (local WiFi only)...
netsh advfirewall firewall add rule name="VP Chef Studio Camera LAN (8082)" ^
    dir=in action=allow protocol=TCP localport=8082 ^
    profile=private,domain remoteip=localsubnet 2>nul
if !errorlevel! equ 0 (
    echo  Firewall rule added — phones on your WiFi can now reach the camera server.
) else (
    echo  Firewall rule already exists or could not be added. If cameras still show
    echo  offline on the phone, run this command manually in an admin terminal:
    echo    netsh advfirewall firewall add rule name="VP Chef Studio Camera LAN" dir=in action=allow protocol=TCP localport=8082
)
echo.

:: ── Run the relay ─────────────────────────────────────────────────────────────
set "FFMPEG_PATH=!FFMPEG_EXE!"
node "%~dp0relay.js"

echo.
echo  Relay stopped.
pause
