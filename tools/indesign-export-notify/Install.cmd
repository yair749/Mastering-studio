@echo off
rem Double-click to install (or update) the InDesign export notifier for this Windows user.
rem Options, from a command prompt in this folder:  Install.cmd -HideFileNames   or   Install.cmd -ShowFileNames
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ExportNotify.ps1" %*
pause
