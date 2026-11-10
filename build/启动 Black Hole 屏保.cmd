@echo off
rem ---------------------------------------------------------------------------
rem Black Hole Screensaver - start script (portable builds).
rem
rem Why this file exists: the exe is not code-signed, and Windows 11 shows the
rem "Windows protected your PC / Microsoft Defender SmartScreen" prompt when it
rem is started from Explorer (double-click / shortcut). Starting it from cmd.exe
rem uses CreateProcess instead, which skips that shell-level reputation check.
rem
rem Why `start`: cmd.exe waits for 64-bit GUI programs. Calling the exe directly
rem would keep this script's cmd.exe (and its console window) alive for the whole
rem session, and closing that window would take the app down with it (closing a
rem console sends CTRL_CLOSE_EVENT to the processes bound to it). `start ""` hands
rem the exe to Windows as a detached process, so the console closes immediately
rem and nothing but the app itself can stop the app.
rem
rem The app itself never needs administrator rights, so do NOT use
rem "Run as administrator".
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
if not exist "%~dp0Black Hole Screensaver.exe" (
  echo [ERROR] "Black Hole Screensaver.exe" was not found next to this script.
  pause
  exit /b 1
)
start "" "%~dp0Black Hole Screensaver.exe" %*
endlocal
