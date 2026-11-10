# Black Hole Screensaver Project Rules

This document provides instructions and guidelines for AI agents working on the Black Hole Screensaver project.

## Technology Stack & Architecture

1. **Framework**: Electron (v35+), Vanilla HTML5/CSS3, and pure JavaScript. Do not introduce front-end frameworks (like React, Vue, or TailwindCSS) unless explicitly requested.
2. **Graphics**: WebGL 2.0 (OpenGL ES 3.0). The screensaver uses a fullscreen quad generated via `gl_VertexID` in [fullscreen-quad.vert](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/fullscreen-quad.vert) and rendered by [blackhole.frag](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/blackhole.frag).
3. **Timer System**: Handled in [timer.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/timer.js) via a wall-clock delta-corrected `setInterval` loop to prevent CPU scheduling drift.

## Codebase Conventions & Rules

### 1. IPC and Settings Contract
Settings are persisted in `settings.json` within the Electron app's userData path. The fields are defined as:
```json
{
  "workMinutes": 25,
  "breakMinutes": 5,
  "loop": true,
  "easyExit": false,
  "preset": "inferno",
  "autoStart": false,
  "language": "zh-CN"
}
```
* **Sanitising**: [main.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/main.js) normalises every value on load and save (`toFiniteInt` / `sanitizeSettings`): numbers must be finite and are clamped (1–120 work, 1–30 break), booleans are coerced, `preset` / `language` are allow-listed. Never trust `settings.json` or a renderer payload.
* **autoStart**: `buildSettings()` in [settings.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/settings.js) must include it. `writeSettings()` preserves the stored value when a save omits it, and `app.setLoginItemSettings()` is only called when `app.isPackaged` is true (development must not register electron.exe as a login item).
* **Timer States**: `TimerManager` stores uppercase `'IDLE'`, `'WORKING'`, `'BREAK'`; renderers lowercase `data.state` before formatting. Keep settings fields in [settings.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/settings.js), [main.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/main.js), and [timer.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/timer.js) aligned.

### 2. Shader Uniforms & Presets
* The fragment shader [blackhole.frag](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/blackhole.frag) expects the following uniforms:
  - `uniform vec2 iResolution;` (Viewport width/height in pixels)
  - `uniform float iTime;` (Elapsed time in seconds, reset by `renderer.reset()` on every show)
  - `uniform vec4 iDate;` (Year, Month, Day, Seconds-since-midnight — currently unused/optimised out; the renderer skips the upload when the location is null)
  - `uniform int u_preset;` (Integer index representing the preset)
  - `uniform sampler2D u_desktop;` (Desktop capture, texture unit 0; a complete 1×1 placeholder is bound whenever no live frame is available)
  - `uniform int u_hasDesktop;` (1 only while a live captured frame has been uploaded; 0 must return transparent before any texture fetch)
* **Preset Index Mapping**:
  - `0`: Inferno
  - `1`: Gargantua
  - `2`: M87* Donut
  - `3`: Quasar
  - `4`: Blazar
  - `5`: Pure Lens
* Do not simplify or bypass the relativistic physics integrations (geodesic trace, Doppler beam factor, or Keplerian velocities) when modifying the shader, as they are central to the fidelity of the black hole simulation.

### 3. Screensaver Exit: Focus, Easy Exit and IME
* The overlay is shown with `show()` + `focus()` (not `showInactive`) and a hidden `<input>` is focused, so keyboard and IME events reach the renderer while a break is shown.
* `easyExit: true` dismisses on any non-modifier `keydown`. With `easyExit: false`, the renderer tracks `compositionstart` / `compositionend` and the hidden input's `input` / `keydown` events, and closes only when the typed text equals `确认停止休息`.
* Dismissal calls `electronAPI.dismissScreensaver()` → `hideScreensaver({ mode: 'dismiss' })`. Do not rely only on keydown `key` values; IME selection arrives through `compositionend`.
* The logic lives in [screensaver.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/screensaver.js); the DOM lives in [screensaver.html](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/screensaver.html). Keep both in sync if the prompt/input markup changes.

## Style Guide (UI)
* The UI strictly follows a **Minimalist Monochrome** design language.
* Backgrounds are pure black (`#000000`) and cards are solid dark gray (`#111111`) with `10px` rounded corners and `1px solid #1a1a1a` borders.
* Accents and active states are stark white (`#ffffff`). Remove any glows, auras, or shadows.
* The settings header shows `assets/icon-ui.png` at 24×24 — the app's only colour accent — and the rest of the UI stays monochrome. Do not replace it with an emoji or an inline SVG.
* Typography uses **DM Sans** (clean geometric sans-serif) for all UI text and **JetBrains Mono** for timer digits and numeric inputs.
* The settings window is `420×640` and must display all content in a single page without scrollbars (`overflow: hidden`).
* The layout is a compact vertical stack: one settings card (Timer Settings + Visual Style sections, including the Auto Start / Easy Exit toggles) above the Status Panel footer.

## Desktop Overlay & Rendering Gotchas (Handoff Notes)

### 1. Transparent Window on Windows
* **WebGL Alpha**: To achieve a transparent click-through overlay, the WebGL context in [blackhole-renderer.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/blackhole-renderer.js) **MUST** be initialized with `alpha: true`. If set to `false`, the WebGL canvas will forcibly render a solid black background, breaking Electron's `transparent: true` and causing a "full black mask" bug.
* **Pixel-Perfect Alignment**: The Electron window **MUST** use `fullscreen: true`. If `fullscreen` is disabled, the OS may constrain the window height (e.g., stopping above the taskbar). Because the desktop capturer captures the *entire* screen, rendering it on a constrained window will squash the aspect ratio vertically, resulting in severe "ghosting" or "double vision" of desktop elements like the taskbar.

### 2. Screen Capture & Cursor Double-Vision
* `desktopCapturer` inherently records the screen, including the software mouse cursor.
* Because the OS hardware cursor always floats above our transparent overlay, failing to hide the captured cursor results in a "double cursor" visual bug.
* We mitigate this by passing `cursor: 'never'` into the `navigator.mediaDevices.getUserMedia` constraints in [screensaver.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/screensaver.js).

### 3. Mask Edge Blending (Smooth Alpha)
* Due to minute color profile differences between the real monitor output and the captured video stream, rendering the captured video with 100% opacity at the edge of the lensing effect creates a visible rectangular "mask" boundary.
* We solved this in [blackhole.frag](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/blackhole.frag) by using the `lensStrength` parameter to drive `smoothstep` alpha blending. The captured video smoothly fades into 0% opacity as the distortion weakens, perfectly integrating the black hole into the real desktop.
* **Premultiplied Alpha Gotcha**: Because the WebGL context is initialized with `alpha: true`, the browser compositor defaults to pre-multiplied alpha blending. In the shader, the final output must be `vec4(color * alpha, alpha)` instead of `vec4(color, alpha)`. Failure to pre-multiply will cause the compositor to render a bright, semi-transparent white haze along the blend edges.

### 4. Timer Semantics & Emergency Exit
* `start()`, `pause()`, `resume()`, `startBreak()`, `stop()` and the idle branch of `endBreak()` each emit an immediate `tick`, so the UI never waits for the next second.
* `stop()` emits `tick(0, IDLE)` but **must not reset `_cycles`**. A completed WORK countdown is the only normal increment (`_onCountdownEnd` → WORKING); `endBreak({ countCycle: true })` is an unused escape hatch and must not be passed by the normal hide/dismiss paths.
* `endBreak({ resumeWork: false })` returns a break to IDLE without starting work, and is a no-op when the timer is not in BREAK. `hideScreensaver()` calls it only when the timer is actually in BREAK, with `resumeWork: mode === 'abort' ? false : timer.loop`. Normal dismissal resumes work in loop mode; the abort shortcut goes to IDLE.
* The overlay is focusable (see §3), so the global shortcut is a fallback, not the only exit. `main.js` registers `CommandOrControl+Q`, then `CommandOrControl+Alt+Q` if the first is unavailable, only while the overlay is visible, and unregisters on hide. **Never** register `ESC` globally, as it would break the foreground application.

### 5. Screensaver Render Loop Resume
* On hide, [screensaver.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/screensaver.js) stops the renderer (`renderer.stop()`), stops every MediaStream track, clears the video texture and resets `u_hasDesktop`. Never leave a capture running while the overlay is hidden.
* On show, the render loop is restarted with `renderer.reset()` + `renderer.start()` and the desktop capture is acquired fresh (see §8). Omitting the restart freezes on a static frame; reusing a previous stream leaves a stale background.

### 6. Shader Alpha & Capture Fallback
* The fragment shader has two rendering paths: an **outer region** (`b >= bmax`, lensing-only) and an **inner region** (`b < bmax`, geodesic ray-marching with accretion disk). Both **MUST** use the same alpha function: `alpha = smoothstep(0.0, 0.2, window * shield)`, with premultiplied output `vec4(color * alpha, alpha)`.
* The old inner-region alpha of raw `window * shield` was ~0.69 at `bmax` for Inferno while the outer branch had already saturated at 1.0, leaving a visible ring at the handoff. Do not reintroduce it.
* `window` (`exp(-pow(plen / (7.0 * rh), 2.0))`) fades the lens/alpha with distance; `shield = vis` because there is no reserved work area for the screensaver.
* `u_hasDesktop == 0` **MUST** return `vec4(0.0)` before any texture fetch. A missing capture, an incomplete texture or a stale frame must never paint an opaque black lens over the desktop.
* A 1.5s `smoothstep` intro fades the whole hole in on each show; do not apply it to `I`, `rh` or the 60s growth curve.
* `stars()` is guarded by `L.star > 0.0`; presets without a starfield must not pay for it.

### 7. Electron Startup, Integrity Labels & Packaging
* **The recurring "double-click does nothing / no tray icon / only runs as administrator" bug was a Windows integrity-label problem, not an Electron sandbox or CPU bug.** The project folder `ghostty-blackhole` carried an inheritable `Mandatory Label\Low Mandatory Level` (plus an AppContainer SID ACE) because it was created by a sandboxed agent session. Every exe created inside it — including everything electron-builder writes into `dist/` — inherits that label, so Windows starts those exes at **Low integrity** (`S-1-16-4096`). Low-integrity processes cannot write `%APPDATA%\blackhole-screensaver`: Electron's single-instance lock fails (`Lock file can not be created! Error code: 5`), Chromium's sandbox initialization aborts before `main.js` (procdump: `0x80000003` breakpoint then `0xC000001D IMMEDIATE_CRASH`, no `startup.log`, no stderr), the NSIS installer cannot write `%LOCALAPPDATA%\Programs` ("无法关闭" loop, or `/S` exits 0 installing nothing, with `$PLUGINSDIR` under `%TEMP%\Low`), and an elevated launch "works" only because it raises the integrity level. Fast diagnosis: `icacls <exe>` for `Low Mandatory Level`, and a token check for integrity SID `S-1-16-4096` (Low) vs `S-1-16-8192` (Medium).
* **Never build inside a folder that has a Low mandatory label.** `npm run pack` and `npm run dist` end with `node scripts/fix-label.js dist`, which runs `icacls dist /setintegritylevel Medium /T` and fails the build if any Low label survives. Keep that step in the pipeline; if the startup bug reappears on another machine/workspace, run `icacls "<folder>" /setintegritylevel Medium /T` (owner rights are enough, no administrator needed).
* The shipped package is a single product exe: `Black Hole Screensaver.exe` is the normal electron-builder output (no launcher wrapper, no `afterPack` hook, and no `--no-sandbox` switch in `main.js`). With correct integrity labels the stock Chromium sandbox works; do not reintroduce `app.commandLine.appendSwitch('no-sandbox')` or a launcher unless a real root cause requires it.
* **Do not add a `RUNASADMIN` compatibility layer** (`HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers`) — it forces every launch through UAC and was the original "only runs as administrator" symptom.
* The exe/installer is unsigned. Windows 11 SmartScreen evaluates shell launches of unrecognized executables ("Windows 已保护你的电脑", not UAC). That is why:
  * `build/installer.nsh` recreates the Start Menu / desktop shortcuts through `$SYSDIR\cmd.exe` (signed, `SW_SHOWMINIMIZED`) instead of pointing at the unsigned exe; `启动 Black Hole 屏保.cmd` does the same. The stored arguments are `/d /c start "" "<installdir>\Black Hole Screensaver.exe"`.
  * **The launched exe must go through `start`, never be cmd's direct child.** cmd.exe waits for 64-bit GUI programs, so `cmd /c "app.exe"` keeps cmd.exe and its (minimized) console window alive for the whole app session; closing that window sends `CTRL_CLOSE_EVENT` to the bound processes and kills the app — the reported "安装版打开会有一个 cmd 在后台，把它叉掉后程序也退出了" bug (the `win-unpacked` exe launched from Explorer is unaffected because there is no console). `start "" "app.exe"` detaches the app, cmd exits immediately, and no console survives. Keep this pattern in both the NSIS shortcuts and `启动 Black Hole 屏保.cmd`.
  * A direct first launch of the exe or installer still shows the prompt; 更多信息 → 仍要运行 is required once, and it must not be "fixed" with administrator rights.
* Packaging ships only the runtime allow-list in `build.files` (`main.js`, `preload.js`, `timer.js`, `renderer/**`, `assets/**`, `package.json`); `build.extraFiles` copies `build/启动 Black Hole 屏保.cmd` and `build/使用说明.txt` next to the exe, and `build/installer.nsh` patches the shortcuts.
* The tray icon is `assets/tray.png` (32×32, the same rounded-square Gargantua artwork as the app icon so the warm accretion disk stays visible at 16–32 px on dark and light taskbars; regenerate with `scripts/build-icon.py`, see §10), loaded with `fs.readFileSync` + `nativeImage.createFromBuffer` so it also works from the asar. Closing the settings window hides it to the tray and keeps the process running; the first hide calls `tray.displayBalloon()` because Windows 11 puts new icons in the `^` overflow. If `new Tray()` fails, the close handler minimizes the window to the taskbar instead of hiding it, so the app cannot become unreachable. The tray menu `退出` and the settings-window `退出程序` link are the explicit quit paths; tray tooltip/single-click reopen the settings.
* `startup.log` in the userData directory records main-process startup stages (`main-loaded`, `userData`, `whenReady`, tray stages, `settings-window-created`, `screensaver-window-created`, `ready`) and also `single-instance-lock-failed`, `tray-hint`, `tray-failed` and `tray-in-overflow`. Use it together with `crash.log` when the packaged app shows no window or tray icon. No log entries at all after a launch attempt means the process died before `main.js` (see the integrity-label note above).
* When testing from an Electron-based agent shell, `ELECTRON_RUN_AS_NODE=1` may be set in the environment. The packaged exe then runs as plain Node and exits silently (exit code 0/9, no `startup.log` entries). Clear the variable before launching. Shell wrappers that call `ShellExecute` in-process also inherit the agent shell's restricted token, which can make the app fall back to `userdata/` next to the exe; launch through Explorer or a scheduled task when a normal user context is required.
* `resolveWritableUserData()` runs before the single-instance lock and logs/settings paths are built. It probes the default roaming userData with a real file create, then falls back to `%TEMP%\blackhole-screensaver`, `%LOCALAPPDATA%\blackhole-screensaver`, `userdata` next to the executable, and `./userdata`. If the roaming directory is not writable, Electron's `requestSingleInstanceLock()` fails with `Lock file can not be created! Error code: 5` and the app would otherwise `app.quit()` before any window appears. After choosing a fallback it calls `app.setPath('userData', dir)` and copies the existing `settings.json` when readable; keep `startup.log`/`crash.log` in that directory.

### 8. Per-Break Desktop Capture (No Startup Capture)
* Do **not** start `desktopCapturer` / `getUserMedia` when the hidden screensaver page loads. Acquire only after `screensaver-show`, in [screensaver.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/screensaver.js), so every break captures the desktop as it is now and no screen recording runs while the user works.
* Acquire: `getDesktopSourceId()` → `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId }, cursor: 'never' } })` → append a tiny transparent `<video>` to the DOM → `play()` → wait for the first frame (rVFC, 3s timeout) → `renderer.setVideoBackground(video)`.
* [blackhole-renderer.js](file:///c:/Users/Service01/Documents/Coding/ghostty-blackhole/renderer/blackhole-renderer.js) keeps a complete 1×1 placeholder bound to texture unit 0 and only sets `hasDesktop` after a real frame is uploaded. The shader returns transparent when `u_hasDesktop == 0`.
* While visible, a `requestVideoFrameCallback` watchdog re-acquires if no new frame arrives for about 2s; `track.ended` / `mute` / `video.error` trigger the same path. Retry once; after that, keep the overlay transparent and show `#capture-error` with the exit hint. Never keep displaying the last frame.
* On hide, `releaseCapture()` stops every track, pauses/removes the video, deletes the texture and clears `hasDesktop`.
* `main.js` forwards `display-added` / `display-removed` / `display-metrics-changed` as `screensaver-capture-invalid`; treat it as a lost stream and re-acquire. The settings window is hidden before the overlay is shown so it is not captured.

### 9. Tests
* `npm test` runs `test/timer.test.js` with Node's built-in test runner and mocked timers. Run it before changing timer semantics; keep the tests dependency-free.

### 10. Icon Set & Bilingual Documentation
* Never hand-edit the PNG icons. The user-supplied artwork lives in `build/icon-source.png` (1254×1254 RGBA: tilted Gargantua on an opaque dark rounded-square tile, transparent corners and padding around it). `scripts/build-icon.py` (Python 3 + numpy/Pillow; use the bundled interpreter) deterministically crops the transparent padding, resizes with premultiplied alpha and regenerates the whole set in one run: `assets/icon.png` (256×256, `build.win.icon` → exe/shortcut/installer icon), `assets/tray.png` (32×32 tray/taskbar/settings-window icon), `assets/icon-ui.png` (128×128, settings header shown at 24 px) and `build/icon-1024.png` (build master, not packaged). Keep the tile's transparent corners; do not redraw, recolour or cut out the artwork.
* The tray icon is loaded with `fs.readFileSync` + `nativeImage.createFromBuffer`; the last-resort fallback in `main.js` is a monochrome black-shadow/white-ring glyph if the asset is ever missing.
* Documentation is bilingual: `README.md` is the English default entry and `README_zh.md` the complete Simplified Chinese translation. Both start with a centered icon/tagline block and a centered link to the other language, and keep the same H2 order, the same code fences and the same technical tokens; do not use emoji in headings or prose. Screenshots live in `docs/images/` and must be regenerated from the real UI (see `tmp/capture-ui.js`) when the UI changes.

