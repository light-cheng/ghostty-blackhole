const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  screen,
  desktopCapturer,
  globalShortcut,
} = require('electron');

const path = require('path');
const fs = require('fs');

// ── Resolve a writable userData directory *before* anything uses it ──
// If the roaming profile directory is not writable (broken ACLs, an
// AppContainer/redirected profile, security software), requestSingleInstanceLock
// fails with "Lock file can not be created! Error code: 5" and the app exits
// silently before a window or tray icon appears. Fall back to a writable temp
// directory and migrate the existing settings when possible.
function resolveWritableUserData() {
  const preferred = app.getPath('userData');
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    preferred,
    path.join(app.getPath('temp'), 'blackhole-screensaver'),
    path.join(process.env.LOCALAPPDATA || app.getPath('temp'), 'blackhole-screensaver'),
    // Portable builds run from a user-writable folder; this also works when
    // the profile directory is locked down by an AppContainer/sandbox.
    path.join(exeDir, 'userdata'),
    path.join(process.cwd(), 'userdata'),
  ];
  const seen = new Set();

  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // accessSync can pass while a security product/ACL still blocks the
      // actual file creation used by the Electron process-singleton lock.
      const probe = path.join(dir, `write-test-${process.pid}-${Date.now()}.tmp`);
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);

      if (dir !== preferred) {
        // Keep the user's existing work/break/preset settings if readable.
        try {
          const oldSettings = path.join(preferred, 'settings.json');
          const newSettings = path.join(dir, 'settings.json');
          if (fs.existsSync(oldSettings) && !fs.existsSync(newSettings)) {
            fs.copyFileSync(oldSettings, newSettings);
          }
        } catch { /* best-effort migration */ }
        try { app.setPath('userData', dir); } catch { /* keep Electron default */ }
      }
      return dir;
    } catch { /* try the next candidate */ }
  }
  return preferred;
}

const USER_DATA_DIR = resolveWritableUserData();

// ── Crash diagnostics — write uncaught errors to a log file ──
const CRASH_LOG = path.join(USER_DATA_DIR, 'crash.log');
function logCrash(label, err) {
  const msg = `[${new Date().toISOString()}] ${label}: ${err?.stack || err}\n`;
  try { fs.appendFileSync(CRASH_LOG, msg); } catch { /* best-effort */ }
}
process.on('uncaughtException', (err) => { logCrash('uncaughtException', err); });
process.on('unhandledRejection', (err) => { logCrash('unhandledRejection', err); });

// ── Startup diagnostics — a tiny stage log helps when the packaged app
//    dies before a window/tray appears and there is no DevTools console. ──
const STARTUP_LOG = path.join(USER_DATA_DIR, 'startup.log');
function logStartup(stage, detail = '') {
  try {
    fs.appendFileSync(
      STARTUP_LOG,
      `[${new Date().toISOString()}] ${stage}${detail ? ': ' + detail : ''}\n`
    );
  } catch { /* best-effort */ }
}
logStartup('main-loaded');
logStartup('userData', USER_DATA_DIR);
app.setAppUserModelId('com.blackhole.screensaver');

const { TimerManager, State } = require('./timer');

/* ═══════════════════════════════════════════════
   Single-instance lock
   ═══════════════════════════════════════════════ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance owns the lock; Electron forwards it to 'second-instance',
  // which brings the settings window back. A lock failure caused by an
  // unwritable userData directory is recorded in startup.log by the resolver.
  logStartup('single-instance-lock-failed');
  app.quit();
}

/* ═══════════════════════════════════════════════
   Paths & defaults
   ═══════════════════════════════════════════════ */
const SETTINGS_PATH = path.join(USER_DATA_DIR, 'settings.json');
const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray.png');

const DEFAULT_SETTINGS = {
  workMinutes: 25,
  breakMinutes: 5,
  loop: true,
  easyExit: false,
  preset: 'inferno',
  autoStart: false,
  language: 'zh-CN',
};

const PRESET_KEYS = ['inferno', 'gargantua', 'm87', 'quasar', 'blazar', 'purelens'];
const LANGUAGES = ['zh-CN', 'en-US'];
const EXIT_SHORTCUTS = ['CommandOrControl+Q', 'CommandOrControl+Alt+Q'];

/* ═══════════════════════════════════════════════
   Global references
   ═══════════════════════════════════════════════ */
let settingsWindow = null;
let screensaverWindow = null;
let tray = null;
// Windows 11 files new notification-area icons in the "^" overflow by default,
// so the first time the settings window is hidden to the tray we show a balloon
// telling the user where the app went.
let trayHintShown = false;
let activeShortcut = null;
let pendingShowPayload = null;
// Whether the settings window was visible (not minimized and not already hidden
// to the tray) before a break started, so it can be restored afterwards without
// stealing focus.
let settingsWasRestorable = false;
const timer = new TimerManager();

/* ═══════════════════════════════════════════════
   Settings persistence
   ═══════════════════════════════════════════════ */
/** Clamp to a finite integer in [min, max], falling back when invalid. */
function toFiniteInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Normalise persisted/IPC settings; never trust settings.json. */
function sanitizeSettings(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    workMinutes: toFiniteInt(raw.workMinutes, DEFAULT_SETTINGS.workMinutes, 1, 120),
    breakMinutes: toFiniteInt(raw.breakMinutes, DEFAULT_SETTINGS.breakMinutes, 1, 30),
    loop: typeof raw.loop === 'boolean' ? raw.loop : DEFAULT_SETTINGS.loop,
    easyExit: typeof raw.easyExit === 'boolean' ? raw.easyExit : DEFAULT_SETTINGS.easyExit,
    preset: PRESET_KEYS.includes(raw.preset) ? raw.preset : DEFAULT_SETTINGS.preset,
    autoStart: typeof raw.autoStart === 'boolean' ? raw.autoStart : DEFAULT_SETTINGS.autoStart,
    language: LANGUAGES.includes(raw.language) ? raw.language : DEFAULT_SETTINGS.language,
  };
}

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      return sanitizeSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
    }
  } catch {
    // corrupted file → fall back to defaults
  }
  return sanitizeSettings(DEFAULT_SETTINGS);
}

function writeSettings(settings) {
  const current = readSettings();
  const patch = settings && typeof settings === 'object' ? settings : {};
  const merged = sanitizeSettings({ ...current, ...patch });
  // Preserve autoStart unless the caller explicitly sent a boolean.
  if (typeof patch.autoStart !== 'boolean') {
    merged.autoStart = current.autoStart;
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

/* ═══════════════════════════════════════════════
   Tray icon — assets/tray.png (the rounded-square Gargantua
   tile; regenerate with scripts/build-icon.py)
   ═══════════════════════════════════════════════ */
function createTrayIcon() {
  try {
    const png = fs.readFileSync(TRAY_ICON_PATH);
    const image = nativeImage.createFromBuffer(png);
    if (!image.isEmpty()) {
      const size = image.getSize();
      logStartup('tray-icon', `${size.width}x${size.height}`);
      return image;
    }
  } catch (err) {
    logCrash('createTrayIcon/read', err);
  }

  // Last-resort fallback if the asset is missing: the monochrome Gargantua
  // silhouette (black shadow core + white photon ring). Raw bitmap channel
  // order is platform-specific, so use order-independent colours.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4, 0);
  const cx = 7.5;
  const cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const idx = (y * size + x) * 4;
      if (dist <= 6.5 && dist > 3.2) {
        buf[idx] = 255;
        buf[idx + 1] = 255;
        buf[idx + 2] = 255;
        buf[idx + 3] = 255;
      } else if (dist <= 3.2) {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

/* ═══════════════════════════════════════════════
   Window factories
   ═══════════════════════════════════════════════ */
function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 420,
    height: 640,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0a0a0f',
    show: false,
    icon: createTrayIcon(),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });

  // Close → hide to the tray (the user-requested behaviour). Windows 11 puts a
  // new notification-area icon in the "^" overflow, so the first hide also
  // shows a balloon explaining where the app went. If no tray icon could be
  // created, fall back to minimizing so the taskbar button stays reachable.
  // "退出" (tray menu) and the "退出程序" link in the settings window quit.
  settingsWindow.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    if (tray && !tray.isDestroyed()) {
      settingsWindow.hide();
      showTrayHint();
      return;
    }
    settingsWindow.minimize();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function createScreensaverWindow() {
  if (screensaverWindow && !screensaverWindow.isDestroyed()) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height, x, y } = primaryDisplay.bounds;

  screensaverWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  screensaverWindow.setIgnoreMouseEvents(true, { forward: true });
  screensaverWindow.setContentProtection(true);

  screensaverWindow.setMenuBarVisibility(false);
  screensaverWindow.loadFile(
    path.join(__dirname, 'renderer', 'screensaver.html')
  );

  // Deliver a show payload that arrived while the page was still loading.
  screensaverWindow.webContents.on('did-finish-load', () => {
    if (!pendingShowPayload || !screensaverWindow || screensaverWindow.isDestroyed()) return;
    screensaverWindow.webContents.send('screensaver-show', pendingShowPayload);
    pendingShowPayload = null;
  });

  screensaverWindow.on('closed', () => {
    screensaverWindow = null;
  });
}

/* ═══════════════════════════════════════════════
   Screensaver show / hide
   ═══════════════════════════════════════════════ */
function registerExitShortcut() {
  if (activeShortcut) return activeShortcut;

  for (const accelerator of EXIT_SHORTCUTS) {
    try {
      const registered = globalShortcut.register(accelerator, () => {
        hideScreensaver({ mode: 'abort' });
      });
      if (registered) {
        activeShortcut = accelerator;
        return activeShortcut;
      }
    } catch (err) {
      logCrash('registerExitShortcut', err);
    }
  }
  return null;
}

function unregisterExitShortcut() {
  if (!activeShortcut) return;
  globalShortcut.unregister(activeShortcut);
  activeShortcut = null;
}

function sendShowPayload(settings) {
  if (!screensaverWindow || screensaverWindow.isDestroyed()) return;

  const payload = {
    easyExit: settings.easyExit,
    preset: settings.preset,
    breakMinutes: settings.breakMinutes,
    language: settings.language,
    shortcut: activeShortcut || '',
  };

  if (screensaverWindow.webContents.isLoading()) {
    pendingShowPayload = payload;
    return;
  }
  screensaverWindow.webContents.send('screensaver-show', payload);
}

function showScreensaver() {
  const settings = readSettings();

  // Ensure the window exists
  if (!screensaverWindow || screensaverWindow.isDestroyed()) {
    createScreensaverWindow();
  }

  // Keep our settings window out of the captured desktop. It hides to the
  // tray; the tray icon / desktop shortcut is the way back.
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWasRestorable =
      settingsWindow.isVisible() && !settingsWindow.isMinimized();
    settingsWindow.hide();
  }

  registerExitShortcut();

  // Focusable overlay: the keyboard / IME exit UI needs focus.
  screensaverWindow.setFullScreen(true);
  screensaverWindow.show();
  screensaverWindow.focus();
  screensaverWindow.setAlwaysOnTop(true, 'screen-saver');

  // Send after show so the renderer captures a visible desktop.
  sendShowPayload(settings);

  // Start break timer
  timer.startBreak();
}

/**
 * @param {{ mode?: 'dismiss' | 'abort' }} [options]
 */
function hideScreensaver({ mode = 'dismiss' } = {}) {
  const wasBreak = timer.state === State.BREAK;
  pendingShowPayload = null;

  if (screensaverWindow && !screensaverWindow.isDestroyed()) {
    screensaverWindow.webContents.send('screensaver-hide');
    screensaverWindow.hide();
  }

  unregisterExitShortcut();

  // Only a real break may transition the timer. Ctrl+Q aborts to IDLE.
  if (wasBreak) {
    timer.endBreak({ resumeWork: mode === 'abort' ? false : timer.loop });
  }

  // Notify settings window
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('screensaver-hide');
    if (settingsWasRestorable) {
      settingsWindow.showInactive();
    }
  }
  settingsWasRestorable = false;
}

/* ═══════════════════════════════════════════════
   System tray
   ═══════════════════════════════════════════════ */
// Tell the user where the app went the first time it is hidden to the tray.
// Windows 11 keeps new notification-area icons in the "^" overflow, so an icon
// alone can look like "the program disappeared".
function showTrayHint() {
  if (trayHintShown || !tray || tray.isDestroyed()) return;
  trayHintShown = true;
  try {
    tray.displayBalloon({
      icon: createTrayIcon(),
      iconType: 'info',
      title: 'Black Hole 屏保仍在后台运行',
      content: '托盘图标在任务栏右下角的 ^ 里；左键单击图标可重新打开设置。',
      noSound: true,
    });
    logStartup('tray-hint');
  } catch (err) {
    logCrash('tray/hint', err);
  }
}

function createTray() {
  try {
    tray = new Tray(createTrayIcon());
  } catch (err) {
    tray = null;
    logCrash('createTray', err);
    logStartup('tray-failed', err?.message || String(err));
    return;
  }

  tray.setToolTip('Black Hole 屏保 — 单击打开设置');
  try {
    const bounds = tray.getBounds();
    logStartup('tray-bounds', JSON.stringify(bounds));
    // Windows 11 occasionally needs the shell to settle before the first
    // notification-area registration becomes visible; re-apply the icon once.
    setTimeout(() => {
      if (!tray || tray.isDestroyed()) return;
      try {
        tray.setImage(createTrayIcon());
        tray.setToolTip('Black Hole 屏保 — 单击打开设置');
        const retryBounds = tray.getBounds();
        logStartup('tray-bounds-retry', JSON.stringify(retryBounds));
        if (!retryBounds || !retryBounds.width || !retryBounds.height) {
          // The icon is registered but the shell has it in the overflow; the
          // balloon on first hide (showTrayHint) guides the user to it.
          logStartup('tray-in-overflow');
        }
      } catch (err) {
        logCrash('tray/retry', err);
      }
    }, 1500);
  } catch (err) {
    logCrash('tray/getBounds', err);
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示设置',
      click: () => createSettingsWindow(),
    },
    {
      label: '立即休息',
      click: () => showScreensaver(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // A single left-click on Windows is the most discoverable way back to the
  // settings window; double-click still works as well.
  tray.on('click', () => {
    createSettingsWindow();
  });

  tray.on('double-click', () => {
    createSettingsWindow();
  });
}

/* ═══════════════════════════════════════════════
   IPC handlers
   ═══════════════════════════════════════════════ */
function registerIPC() {
  /* ── App ── */
  ipcMain.handle('quit-app', () => {
    app.isQuitting = true;
    app.quit();
    return true;
  });

  /* ── Settings ── */
  ipcMain.handle('get-settings', () => readSettings());

  ipcMain.handle('save-settings', (_e, settings) => {
    const saved = writeSettings(settings);

    // Sync timer config
    timer.workMinutes = saved.workMinutes;
    timer.breakMinutes = saved.breakMinutes;
    timer.loop = saved.loop;

    // Auto-start at login — packaged only: in dev this would register
    // electron.exe with no app path. The exe needs no command-line switches.
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: !!saved.autoStart,
        path: process.execPath,
      });
    }

    // Notify all windows
    for (const win of [settingsWindow, screensaverWindow]) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('settings-changed', saved);
      }
    }

    return saved;
  });

  /* ── Timer ── */
  ipcMain.handle('start-timer', () => {
    const settings = readSettings();
    timer.workMinutes = settings.workMinutes;
    timer.breakMinutes = settings.breakMinutes;
    timer.loop = settings.loop;
    timer.start();
    return timer.getSnapshot();
  });

  ipcMain.handle('pause-timer', () => {
    if (timer.paused) {
      timer.resume();
    } else {
      timer.pause();
    }
    return timer.getSnapshot();
  });

  ipcMain.handle('stop-timer', () => {
    timer.stop();
    return timer.getSnapshot();
  });

  ipcMain.handle('get-timer-state', () => timer.getSnapshot());

  /* ── Screensaver ── */
  ipcMain.handle('trigger-screensaver', () => {
    showScreensaver();
    return true;
  });

  ipcMain.handle('dismiss-screensaver', () => {
    hideScreensaver({ mode: 'dismiss' });
    return true;
  });

  ipcMain.handle('get-desktop-source-id', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      if (!sources || sources.length === 0) return null;

      // Prefer the primary display if we can match it, otherwise first screen.
      // Electron's primary screen is usually 'screen:0:0' or similar.
      const primaryDisplay = screen.getPrimaryDisplay();
      const selected =
        sources.find((source) => source.display_id === primaryDisplay.id.toString()) ||
        sources[0];
      return selected ? selected.id : null;
    } catch (err) {
      logCrash('get-desktop-source-id', err);
      return null;
    }
  });
}

/* ═══════════════════════════════════════════════
   Timer events → renderer
   ═══════════════════════════════════════════════ */
function wireTimerEvents() {
  timer.on('tick', (remainingSeconds, state) => {
    const data = { remainingSeconds, state, paused: timer.paused, cycles: timer._cycles };
    // Broadcast to settings window
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('timer-tick', data);
    }
    // Broadcast to screensaver window (for break countdown display)
    if (screensaverWindow && !screensaverWindow.isDestroyed()) {
      screensaverWindow.webContents.send('timer-tick', data);
    }
  });

  timer.on('triggered', () => {
    // Work session ended → show screensaver
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('timer-triggered');
    }
    showScreensaver();
  });

  timer.on('breakEnd', () => {
    // Break ended naturally (timer expired)
    hideScreensaver();
  });

  timer.on('stateChange', (state) => {
    // Could be used for tray tooltip updates
    if (tray) {
      const labels = {
        IDLE: 'Black Hole — Idle',
        WORKING: 'Black Hole — Working',
        BREAK: 'Black Hole — Break',
      };
      tray.setToolTip(labels[state] || 'Black Hole Screensaver');
    }
  });
}

/* ═══════════════════════════════════════════════
   Display changes → capture invalid
   ═══════════════════════════════════════════════ */
function wireDisplayEvents() {
  const notifyCaptureInvalid = () => {
    if (!screensaverWindow || screensaverWindow.isDestroyed()) return;
    if (!screensaverWindow.isVisible()) return;
    screensaverWindow.webContents.send('screensaver-capture-invalid');
  };

  screen.on('display-added', notifyCaptureInvalid);
  screen.on('display-removed', notifyCaptureInvalid);
  screen.on('display-metrics-changed', notifyCaptureInvalid);
}

/* ═══════════════════════════════════════════════
   App lifecycle
   ═══════════════════════════════════════════════ */
app.on('second-instance', () => {
  // Another instance tried to launch — bring up the settings window even if
  // the tray icon is hidden in the Windows overflow area.
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow();
    return;
  }
  if (settingsWindow.isMinimized()) settingsWindow.restore();
  settingsWindow.show();
  settingsWindow.focus();
});

app.whenReady().then(() => {
  logStartup('whenReady');
  try {
    registerIPC();
    wireTimerEvents();
    wireDisplayEvents();
  } catch (err) {
    logCrash('whenReady/setup', err);
    logStartup('setup-failed', err?.message || String(err));
  }

  createTray();

  try {
    createSettingsWindow();
    logStartup('settings-window-created');
  } catch (err) {
    logCrash('createSettingsWindow', err);
    logStartup('settings-window-failed', err?.message || String(err));
  }

  try {
    createScreensaverWindow(); // pre-create hidden; capture starts on show
    logStartup('screensaver-window-created');
  } catch (err) {
    logCrash('createScreensaverWindow', err);
    logStartup('screensaver-window-failed', err?.message || String(err));
  }

  // Apply saved auto-start setting (packaged only)
  const settings = readSettings();
  timer.workMinutes = settings.workMinutes;
  timer.breakMinutes = settings.breakMinutes;
  timer.loop = settings.loop;
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: !!settings.autoStart,
      path: process.execPath,
    });
  }
  logStartup('ready');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray && !tray.isDestroyed()) {
    try { tray.destroy(); } catch { /* best-effort */ }
    tray = null;
  }
});

app.on('window-all-closed', () => {
  // Keep running in the tray when one exists; otherwise do not leave an
  // invisible background process behind.
  if (!tray) app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('activate', () => {
  // macOS dock click (unlikely on Windows, but good practice)
  if (!settingsWindow) createSettingsWindow();
});
