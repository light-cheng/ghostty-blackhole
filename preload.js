const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /* ── Settings ── */
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  /* ── Timer control ── */
  startTimer: () => ipcRenderer.invoke('start-timer'),
  pauseTimer: () => ipcRenderer.invoke('pause-timer'),
  stopTimer: () => ipcRenderer.invoke('stop-timer'),
  getTimerState: () => ipcRenderer.invoke('get-timer-state'),

  /* ── Screensaver control ── */
  triggerScreensaver: () => ipcRenderer.invoke('trigger-screensaver'),
  dismissScreensaver: () => ipcRenderer.invoke('dismiss-screensaver'),
  getDesktopSourceId: () => ipcRenderer.invoke('get-desktop-source-id'),

  /* ── App ── */
  quitApp: () => ipcRenderer.invoke('quit-app'),

  /* ── Events from main process → renderer ── */
  onTimerTick: (callback) => {
    ipcRenderer.on('timer-tick', (_e, data) => callback(data));
  },
  onTimerTriggered: (callback) => {
    ipcRenderer.on('timer-triggered', (_e) => callback());
  },
  onScreensaverShow: (callback) => {
    ipcRenderer.on('screensaver-show', (_e, data) => callback(data));
  },
  onScreensaverHide: (callback) => {
    ipcRenderer.on('screensaver-hide', (_e) => callback());
  },
  onScreensaverCaptureInvalid: (callback) => {
    ipcRenderer.on('screensaver-capture-invalid', (_e) => callback());
  },
  onSettingsChanged: (callback) => {
    ipcRenderer.on('settings-changed', (_e, data) => callback(data));
  },
});
