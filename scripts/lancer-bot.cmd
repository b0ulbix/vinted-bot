@echo off
rem Lance le bot et le relance automatiquement s'il s'arrête
cd /d "%~dp0.."
if not exist data mkdir data
:boucle
node --disable-warning=ExperimentalWarning --env-file-if-exists=.env src\server.js >> data\bot.log 2>&1
timeout /t 10 /nobreak >nul
goto boucle
