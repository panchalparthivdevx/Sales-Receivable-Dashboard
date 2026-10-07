@echo off
title Cloudflare Tunnel — Sales Dashboard
echo.
echo  Starting Cloudflare Tunnel for Sales Dashboard...
echo  Keep this window open while your team is using the link.
echo.

set CF="C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist %CF% set CF=cloudflared

%CF% tunnel --no-autoupdate --protocol http2 --url http://localhost:3002

echo.
echo  Tunnel stopped.
pause
