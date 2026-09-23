@echo off
rem Double-click to stop export notifications on this computer.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ExportReceiver.ps1" -Uninstall
pause
