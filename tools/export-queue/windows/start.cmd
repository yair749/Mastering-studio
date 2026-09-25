@echo off
title InDesign Export Queue
rem Runs the export queue and restarts it if it ever stops unexpectedly.
rem Close this window to stop the queue.
cd /d "%~dp0.."
:run
node --disable-warning=ExperimentalWarning src\server.js
set code=%ERRORLEVEL%
if "%code%"=="2" (
  echo.
  echo The settings in config.json need fixing ^(see the message above^). Fix them, then start again.
  pause
  exit /b 2
)
if "%code%"=="3" (
  echo.
  echo The export queue is already running on this PC ^(or its port is taken^). This window can be closed.
  pause
  exit /b 3
)
echo %date% %time% The export queue stopped ^(code %code%^). Restarting in 10 seconds...
timeout /t 10 /nobreak >nul
goto run
