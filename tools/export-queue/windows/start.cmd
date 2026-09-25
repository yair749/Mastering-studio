@echo off
rem Starts the export queue in the background (no window). Kept so shortcuts from version 1 keep working;
rem Install.cmd creates new ones. To stop or restart it, use Start menu > InDesign Export Queue.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Control-ExportQueue.ps1" -Action Start -Quiet
