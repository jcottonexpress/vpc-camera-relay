@echo off
title VP Chef Camera Relay - Firewall Fix

:: Must run as Administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  This script needs to run as Administrator.
    echo  Right-click fix-firewall.bat and choose "Run as administrator".
    echo.
    pause
    exit /b 1
)

echo.
echo  Adding Windows Firewall rules for VP Chef Camera Relay...
echo  (Applies to all network profiles: Public, Private, and Domain)
echo.

netsh advfirewall firewall delete rule name="VP Chef Camera Relay" >nul 2>&1
netsh advfirewall firewall delete rule name="VP Chef Camera Relay UDP" >nul 2>&1

netsh advfirewall firewall add rule ^
    name="VP Chef Camera Relay" ^
    dir=out ^
    action=allow ^
    protocol=tcp ^
    remoteport=10554,554,8554 ^
    profile=any ^
    description="Allows VP Chef Studio relay to reach RTSP cameras"

netsh advfirewall firewall add rule ^
    name="VP Chef Camera Relay UDP" ^
    dir=out ^
    action=allow ^
    protocol=udp ^
    remoteport=10554,554,8554 ^
    profile=any ^
    description="Allows VP Chef Studio relay to reach RTSP cameras (UDP)"

echo.
echo  Done. Rules added for TCP and UDP on ports 10554, 554, 8554
echo  across all network profiles (Public, Private, Domain).
echo.
echo  You can close this window and run start.bat now.
echo.
pause
