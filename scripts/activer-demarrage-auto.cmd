@echo off
rem Remet le lancement automatique du bot au démarrage de Windows, et le lance tout de suite
copy /Y "%~dp0demarrage-auto-desactive.vbs" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\vinted-bot.vbs" >nul
wscript "%~dp0demarrer.vbs"
echo Demarrage automatique reactive, bot lance.
timeout /t 3 >nul
