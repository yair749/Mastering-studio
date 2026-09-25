@echo off
rem Double-click to set up or upgrade the export queue on this PC. Safe to run again at any time.
rem Windows asks once for permission (click Yes) when the firewall or sleep settings need changing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ExportQueue.ps1" %*
echo.
pause
