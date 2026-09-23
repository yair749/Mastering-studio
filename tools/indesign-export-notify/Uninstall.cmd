@echo off
rem Double-click to remove the InDesign export notifier.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ExportNotify.ps1" -Uninstall
pause
