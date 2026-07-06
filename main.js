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

// Electron 35+ sandbox breaks transparent windows + desktopCapturer in packaged builds
app.commandLine.appendSwitch('no-sandbox');
const path = require('path');
const fs = require('fs');

// ── Crash diagnostics — write uncaught errors to a log file ──
const CRASH_LOG = path.join(app.getPath('userData'), 'crash.log');
function logCrash(label, err) {
  const msg = `[${new Date().toISOString()}] ${label}: ${err?.stack || err}\n`;
  try { fs.appendFileSync(CRASH_LOG, msg); } catch { /* best-effort */ }
}
process.on('uncaughtException', (err) => { logCrash('uncaughtException', err); });
process.on('unhandledRejection', (err) => { logCrash('unhandledRejection', err); });

const { TimerManager } = require('./timer');

/* ═══════════════════════════════════════════════
   Single-instance lock
   ═══════════════════════════════════════════════ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/* ═══════════════════════════════════════════════
   Paths & defaults
   ═══════════════════════════════════════════════ */
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const PRELOAD_PATH = path.join(__dirname, 'preload.js');

const DEFAULT_SETTINGS = {
  workMinutes: 25,
  breakMinutes: 5,
  loop: true,
  easyExit: false,
  preset: 'inferno',
  autoStart: false,
  language: 'zh-CN',
};

/* ═══════════════════════════════════════════════
   Global references
   ═══════════════════════════════════════════════ */
let settingsWindow = null;
let screensaverWindow = null;
let tray = null;
const timer = new TimerManager();

/* ═══════════════════════════════════════════════
   Settings persistence
   ═══════════════════════════════════════════════ */
function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {
    // corrupted file → fall back to defaults
  }
  return { ...DEFAULT_SETTINGS };
}

function writeSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

/* ═══════════════════════════════════════════════
   Tray icon — programmatic 16×16 dark circle
   ═══════════════════════════════════════════════ */
function createTrayIcon() {
  // 16×16 RGBA raw buffer — draw a filled circle
  const size = 16;
  const buf = Buffer.alloc(size * size * 4, 0); // fully transparent

  const cx = 7.5,
    cy = 7.5,
    r = 6.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= r) {
        const idx = (y * size + x) * 4;
        // Dark purple-ish glow (#6a0dad centre, fading to black edge)
        const t = dist / r; // 0 at centre, 1 at edge
        buf[idx] = Math.round(106 * (1 - t)); // R
        buf[idx + 1] = Math.round(13 * (1 - t)); // G
        buf[idx + 2] = Math.round(173 * (1 - t)); // B
        buf[idx + 3] = 255; // A
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

  // Close → hide to tray, don't quit
  settingsWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      settingsWindow.hide();
    }
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

  screensaverWindow.on('closed', () => {
    screensaverWindow = null;
  });
}

/* ═══════════════════════════════════════════════
   Screensaver show / hide
   ═══════════════════════════════════════════════ */
function showScreensaver() {
  const settings = readSettings();

  // Ensure the window exists
  if (!screensaverWindow || screensaverWindow.isDestroyed()) {
    createScreensaverWindow();
  }

  // Send settings to the screensaver renderer before showing
  screensaverWindow.webContents.once('did-finish-load', () => {
    screensaverWindow.webContents.send('screensaver-show', {
      easyExit: settings.easyExit,
      preset: settings.preset,
      breakMinutes: settings.breakMinutes,
    });
  });

  // If already loaded, send immediately
  if (!screensaverWindow.webContents.isLoading()) {
    screensaverWindow.webContents.send('screensaver-show', {
      easyExit: settings.easyExit,
      preset: settings.preset,
      breakMinutes: settings.breakMinutes,
    });
  }

  // Restore setFullScreen(true) to perfectly map screen pixels and avoid ghosting
  screensaverWindow.setFullScreen(true);
  screensaverWindow.showInactive(); // Use showInactive so it doesn't steal focus from user's current app!
  screensaverWindow.setAlwaysOnTop(true, 'screen-saver');

  // Start break timer
  timer.startBreak();
  
  // Register emergency exit shortcut
  globalShortcut.register('CommandOrControl+Q', () => {
    timer.stop();
    hideScreensaver();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('timer-update', timer.getSnapshot());
    }
  });
}

function hideScreensaver() {
  if (screensaverWindow && !screensaverWindow.isDestroyed()) {
    screensaverWindow.hide();
    screensaverWindow.webContents.send('screensaver-hide');
  }
  
  // Unregister emergency exit shortcut when screensaver is hidden
  globalShortcut.unregister('CommandOrControl+Q');

  // End break — timer decides whether to loop
  timer.endBreak();

  // Notify settings window
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('screensaver-hide');
  }
}

/* ═══════════════════════════════════════════════
   System tray
   ═══════════════════════════════════════════════ */
function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Black Hole Screensaver');

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

  tray.on('double-click', () => {
    createSettingsWindow();
  });
}

/* ═══════════════════════════════════════════════
   IPC handlers
   ═══════════════════════════════════════════════ */
function registerIPC() {
  /* ── Settings ── */
  ipcMain.handle('get-settings', () => readSettings());

  ipcMain.handle('save-settings', (_e, settings) => {
    const saved = writeSettings(settings);

    // Sync timer config
    timer.workMinutes = saved.workMinutes;
    timer.breakMinutes = saved.breakMinutes;
    timer.loop = saved.loop;

    // Auto-start at login
    app.setLoginItemSettings({ openAtLogin: !!saved.autoStart });

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
    hideScreensaver();
    return true;
  });

  ipcMain.handle('get-desktop-source-id', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    // Prefer the primary display if we can match it, otherwise just first screen
    // Electron's primary screen is usually 'screen:0:0' or similar
    const primaryDisplay = screen.getPrimaryDisplay();
    let selected = sources[0];
    for (const source of sources) {
      if (source.display_id === primaryDisplay.id.toString()) {
        selected = source;
        break;
      }
    }
    return selected ? selected.id : null;
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
   App lifecycle
   ═══════════════════════════════════════════════ */
app.on('second-instance', () => {
  // Another instance tried to launch — focus our settings window
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
  }
});

app.whenReady().then(() => {
  registerIPC();
  wireTimerEvents();
  createTray();
  createSettingsWindow();
  createScreensaverWindow(); // pre-create hidden

  // Apply saved auto-start setting
  const settings = readSettings();
  timer.workMinutes = settings.workMinutes;
  timer.breakMinutes = settings.breakMinutes;
  timer.loop = settings.loop;
  app.setLoginItemSettings({ openAtLogin: !!settings.autoStart });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (e) => {
  // Do nothing — keep running in tray
  e?.preventDefault?.();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('activate', () => {
  // macOS dock click (unlikely on Windows, but good practice)
  if (!settingsWindow) createSettingsWindow();
});
