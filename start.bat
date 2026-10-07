@echo off
echo Starting Sales ^& Receivable Dashboard...
echo.

echo [1/2] Starting Backend Server (port 3001)...
start "Backend" powershell -NoExit -ExecutionPolicy RemoteSigned -Command "Set-Location 'c:\Users\Parthiv Panchal\Desktop\Claude\Sales & Receivable Dashboard'; node server/index.js"

timeout /t 3 >nul

echo [2/2] Starting React Frontend (port 3000)...
start "Frontend" powershell -NoExit -ExecutionPolicy RemoteSigned -Command "Set-Location 'c:\Users\Parthiv Panchal\Desktop\Claude\Sales & Receivable Dashboard\client'; node 'c:\Users\Parthiv Panchal\Desktop\Claude\Sales & Receivable Dashboard\client\node_modules\react-scripts\bin\react-scripts.js' start"

echo.
echo Dashboard will open at http://localhost:3000 in about 60 seconds.
