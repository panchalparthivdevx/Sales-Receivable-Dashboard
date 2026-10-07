@echo off
REM ============================================================
REM  DevX Vendor Registration — Cloudflare Tunnel Setup
REM  Exposes http://localhost:3002 to the public internet
REM  FREE, HTTPS, no port-forwarding required
REM ============================================================

echo.
echo  DevX Vendor Registration - Public Access Tunnel
echo  ================================================
echo.

REM Check if cloudflared is installed
where cloudflared >nul 2>&1
if %errorlevel% neq 0 (
    echo  [INFO] cloudflared not found. Downloading...
    echo.
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe'"
    if %errorlevel% neq 0 (
        echo  [ERROR] Download failed. Please download manually from:
        echo  https://github.com/cloudflare/cloudflared/releases/latest
        pause
        exit /b 1
    )
    echo  [OK] cloudflared downloaded.
    echo.
    set CLOUDFLARED=.\cloudflared.exe
) else (
    set CLOUDFLARED=cloudflared
)

REM Check if server is running
powershell -Command "try { Invoke-WebRequest -Uri 'http://localhost:3002/api/health' -UseBasicParsing -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo  [WARNING] Server does not appear to be running on port 3002.
    echo  Please start the server first: cd server ^& node index.js
    echo.
)

echo  Starting Cloudflare Tunnel on port 3002...
echo  The public URL will appear below (look for: https://xxxx.trycloudflare.com)
echo  -----------------------------------------------------------------------
echo  IMPORTANT: Copy the https URL and set it in your .env file:
echo    VENDOR_FORM_PUBLIC_URL=https://xxxx.trycloudflare.com
echo  Then restart the server to apply the change.
echo  -----------------------------------------------------------------------
echo.

%CLOUDFLARED% tunnel --url http://localhost:3002

pause
