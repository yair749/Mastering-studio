@echo off
rem Double-click to stop the export queue starting automatically (jobs and settings are kept).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ExportQueue.ps1" -Uninstall
pause
