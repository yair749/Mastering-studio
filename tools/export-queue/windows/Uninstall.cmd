@echo off
rem Double-click to remove the export queue's shortcuts and firewall rule and stop it.
rem The settings (config.json) and the job history (data folder) are kept.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ExportQueue.ps1" -Uninstall %*
echo.
pause
