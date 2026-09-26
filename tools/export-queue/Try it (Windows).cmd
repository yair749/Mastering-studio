@echo off
title Export Queue demo
rem Double-click to try the export queue on this computer without InDesign (simulation).
rem It uses its own settings and port 8090, so it never disturbs a real queue on this PC.
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 goto haveNode
where winget >nul 2>nul
if errorlevel 1 goto noWinget
echo Node.js is needed for the demo. Installing it now: the free, official OpenJS Foundation package.
winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
echo.
echo Close this window, then double-click "Try it (Windows).cmd" again.
pause
exit /b 1
:noWinget
echo Node.js is needed for the demo. Install the LTS version from https://nodejs.org then double-click this file again.
start "" https://nodejs.org/en/download
pause
exit /b 1
:haveNode
if exist "node_modules\express\package.json" goto run
echo Installing the web server library, one time only. This needs the internet...
call npm ci --omit=dev --no-audit --no-fund --no-update-notifier
if errorlevel 1 goto npmFailed
:run
node scripts\try-demo.js
pause
exit /b
:npmFailed
echo.
echo The web server library could not be installed. Is this computer online?
pause
exit /b 1
