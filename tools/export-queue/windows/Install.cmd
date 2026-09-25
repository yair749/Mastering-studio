@echo off
rem Double-click to set up the export queue on this PC (right-click > Run as administrator to also open the firewall).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ExportQueue.ps1" %*
pause
