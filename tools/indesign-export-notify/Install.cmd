@echo off
rem Double-click to install the InDesign export notifier for this Windows user.
rem Add  -HideFileNames  after the .ps1 path to leave file names out of notifications.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ExportNotify.ps1" %*
pause
