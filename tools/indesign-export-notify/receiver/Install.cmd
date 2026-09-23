@echo off
rem Double-click once on each computer that should get export notifications. Nothing to do after that.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ExportReceiver.ps1" %*
pause
