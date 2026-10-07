@echo off
title Sales & Receivable Dashboard
cd /d "C:\Users\Parthiv Panchal\Desktop\Claude\Sales & Receivable Dashboard"

echo Stopping any existing server on port 3001...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3001 " 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)

echo Starting server...
echo.
echo Dashboard will be available at: http://localhost:3001
echo.
echo Keep this window open while using the dashboard.
echo Close this window to stop the server.
echo.
node server/index.js
