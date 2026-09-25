@echo off
rem Double-click to check that everything the export queue needs is working.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Check-ExportQueue.ps1" %*
