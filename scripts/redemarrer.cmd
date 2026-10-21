@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0arreter.ps1"
@wscript "%~dp0demarrer.vbs"
@echo Bot redemarre.
@timeout /t 3 >nul
