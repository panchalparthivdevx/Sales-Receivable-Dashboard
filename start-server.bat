@echo off
title Dev Accelerator Dashboard Server
echo ========================================
echo  Dev Accelerator - Dashboard Server
echo ========================================
echo.
echo Starting server on port 3002...
echo.
echo Dashboard URL: http://localhost:3002
echo (Also accessible via LAN IP on port 3002)
echo.
echo Press Ctrl+C to stop the server.
echo ========================================
echo.
node server/index.js
pause
