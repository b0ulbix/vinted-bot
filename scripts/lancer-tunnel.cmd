@echo off
rem Relie le bot à vinted.ton-domaine.fr via Cloudflare Tunnel
cd /d "%~dp0.."
if not exist data mkdir data
:boucle
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --config "%~dp0..\cloudflared\config.yml" run >> data\tunnel.log 2>&1
timeout /t 10 /nobreak >nul
goto boucle
