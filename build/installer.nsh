; Custom NSIS include for Black Hole Screensaver.
;
; electron-builder's default Start Menu / desktop shortcuts point straight at the
; (unsigned) application exe. Windows 11 then runs the shell-level reputation
; check on every click and shows the "Windows 已保护你的电脑" Microsoft Defender
; SmartScreen prompt first. The shortcuts created here target the signed
; cmd.exe instead: cmd starts the app with CreateProcess, which skips that
; shell-level check. The app never needs administrator rights.
;
; The exe must be started with `start`, never as a direct child of cmd:
; cmd.exe *waits* for 64-bit GUI programs, so a direct `cmd /c "app.exe"` keeps
; cmd.exe (and its console window, here minimized) alive for the whole session.
; Closing that stray console then tears the app down with it (the app is bound
; to cmd's console session, and closing a console sends CTRL_CLOSE_EVENT to it),
; which is the "有一个 cmd 在后台，把它叉掉程序也退出" symptom. `start "" "app.exe"`
; hands the exe to Windows as a detached process and cmd exits immediately, so
; no console window survives and nothing can close the app but the app itself.
;
; electron-builder's default app-running check inspects running processes via
; PowerShell and, on some Windows builds, wrongly reports the app as running
; even when it is not; the installer then loops on "无法关闭" without extracting
; a single file. A best-effort taskkill of the product exe keeps the install
; path simple and reliable: a running app is closed and nothing blocks.
!macro customCheckAppRunning
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 500
!macroend

!macro customInstall
  ${if} "$newStartMenuLink" != ""
    Delete "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$SYSDIR\cmd.exe" "/d /c start $\"$\" $\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\"" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWMINIMIZED "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endif}
  ${if} "$newDesktopLink" != ""
    Delete "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$SYSDIR\cmd.exe" "/d /c start $\"$\" $\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\"" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWMINIMIZED "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endif}
!macroend
