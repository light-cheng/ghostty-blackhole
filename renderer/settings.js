// ============================================================
// Black Hole 屏保 — Settings Controller
// ============================================================

(function () {
  'use strict';

  // ---------- DOM References ----------
  const $ = (sel) => document.querySelector(sel);

  const els = {
    workSlider:      $('#workSlider'),
    workDuration:    $('#workDuration'),
    breakSlider:     $('#breakSlider'),
    breakDuration:   $('#breakDuration'),
    loopMode:        $('#loopMode'),
    easyExit:        $('#easyExit'),
    autoStart:       $('#autoStart'),
    blackHoleStyle:  $('#blackHoleStyle'),

    stateIndicator:  $('#stateIndicator'),
    stateText:       $('#stateText'),
    cycleCount:      $('#cycleCount'),
    timerDisplay:    $('#timerDisplay'),
    timerDigits:     $('#timerDigits'),

    btnStart:        $('#btnStart'),
    btnPause:        $('#btnPause'),
    btnStop:         $('#btnStop'),
    actionButtons:   $('#actionButtons'),
    manualBreak:     $('#manualBreak'),
    quitApp:         $('#quitApp'),
    langToggle:      $('#langToggle'),
  };

  // ---------- State ----------
  let currentLang = 'zh-CN';
  let saveTimeout = null;
  const DEBOUNCE_MS = 400;

  // Last timer snapshot — re-rendered when the language changes so the
  // countdown is not reset to 00:00 by the i18n refresh.
  let lastSnapshot = {
    state: 'idle',
    remainingSeconds: 0,
    cycles: 0,
    paused: false,
  };

  // ---------- Helpers ----------
  function formatTime(totalSeconds) {
    const n = Number(totalSeconds);
    const s = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getDict() {
    return window.locales[currentLang] || window.locales['zh-CN'] || {};
  }

  function normalizeMinutes(value, min, max, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  }

  /**
   * Read clamped minutes from a number input. Empty/NaN falls back to the
   * slider's current valid value, so buildSettings() never emits NaN.
   */
  function readMinutes(input, slider) {
    const min = parseInt(slider.min, 10) || 1;
    const max = parseInt(slider.max, 10) || min;
    const fallback = normalizeMinutes(slider.value, min, max, min);
    return normalizeMinutes(input.value, min, max, fallback);
  }

  function setMinutes(input, slider, value) {
    const min = parseInt(slider.min, 10) || 1;
    const max = parseInt(slider.max, 10) || min;
    const v = normalizeMinutes(value, min, max, min);
    input.value = String(v);
    slider.value = String(v);
    updateSliderFill(slider);
  }

  // ---------- Build Settings Object ----------
  function buildSettings() {
    return {
      // Clamp here as well as in the input handlers: a queued save can run
      // while the text field still shows an out-of-range/empty value.
      workMinutes:    readMinutes(els.workDuration, els.workSlider),
      breakMinutes:   readMinutes(els.breakDuration, els.breakSlider),
      loop:           els.loopMode.checked,
      easyExit:       els.easyExit.checked,
      autoStart:      els.autoStart.checked,
      preset:         els.blackHoleStyle.value,
      language:       currentLang,
    };
  }

  // ---------- Save (debounced) ----------
  function saveSettingsNow() {
    const settings = buildSettings();
    const api = window.electronAPI;
    if (!api || typeof api.saveSettings !== 'function') return Promise.resolve(null);
    try {
      return Promise.resolve(api.saveSettings(settings)).catch((err) => {
        console.warn('Failed to save settings:', err);
        return null;
      });
    } catch (err) {
      console.warn('Failed to save settings:', err);
      return Promise.resolve(null);
    }
  }

  function scheduleSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      saveSettingsNow();
    }, DEBOUNCE_MS);
  }

  /** Flush a pending debounced save before a timer command. */
  function flushSave() {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    return saveSettingsNow();
  }

  // ---------- Populate UI from Settings ----------
  function populateUI(settings) {
    if (!settings) return;

    if (settings.language === 'zh-CN' || settings.language === 'en-US') {
      currentLang = settings.language;
    }
    applyLanguage();

    setMinutes(els.workDuration, els.workSlider,
      normalizeMinutes(settings.workMinutes, 1, 120, 25));

    setMinutes(els.breakDuration, els.breakSlider,
      normalizeMinutes(settings.breakMinutes, 1, 30, 5));

    if (settings.loop != null) {
      els.loopMode.checked = !!settings.loop;
    }

    if (settings.easyExit != null) {
      els.easyExit.checked = !!settings.easyExit;
    }

    if (settings.autoStart != null) {
      els.autoStart.checked = !!settings.autoStart;
    }

    if (settings.preset != null) {
      els.blackHoleStyle.value = settings.preset;
    }
  }

  // ---------- i18n Application ----------
  function applyLanguage() {
    const dict = getDict();

    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const attr = el.getAttribute('data-i18n-attr');

      if (dict[key]) {
        if (attr) {
          el.setAttribute(attr, dict[key]);
        } else {
          el.textContent = dict[key];
        }
      }
    });
  }

  // ---------- Slider Fill (visual progress) ----------
  function updateSliderFill(slider) {
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const val = parseFloat(slider.value);
    const pct = ((val - min) / (max - min)) * 100;
    slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, rgba(255,255,255,0.08) ${pct}%, rgba(255,255,255,0.08) 100%)`;
  }

  // ---------- Sync Slider ↔ Number Input ----------
  function syncSliderAndInput(slider, input) {
    const min = parseInt(slider.min, 10) || 1;
    const max = parseInt(slider.max, 10) || min;

    slider.addEventListener('input', () => {
      input.value = slider.value;
      updateSliderFill(slider);
      scheduleSave();
    });

    input.addEventListener('input', () => {
      const n = parseInt(input.value, 10);
      if (!Number.isFinite(n)) {
        // Don't persist empty/NaN while the user is editing.
        return;
      }
      const v = clamp(n, min, max);
      slider.value = String(v);
      updateSliderFill(slider);
      // buildSettings() clamps the value even though the text field keeps
      // showing the raw number until blur/change.
      scheduleSave();
    });

    const commit = () => {
      const v = readMinutes(input, slider);
      const changed = input.value !== String(v);
      input.value = String(v);
      slider.value = String(v);
      updateSliderFill(slider);
      if (changed) scheduleSave();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('change', commit);

    updateSliderFill(slider);
  }

  // ---------- Update UI State ----------
  function updateTimerDisplay(data) {
    data = data || {};

    const rawState = String(data.state || 'idle').toLowerCase();
    const state = rawState === 'working' ? 'working' : rawState === 'break' ? 'break' : 'idle';
    const remaining = data.remainingSeconds != null ? data.remainingSeconds : (data.remaining || 0);
    const cycles = Number.isFinite(Number(data.cycles)) ? Number(data.cycles) : 0;
    const paused = !!data.paused && (state === 'working' || state === 'break');

    // Cache for i18n re-render.
    lastSnapshot = {
      state,
      remainingSeconds: remaining,
      cycles,
      paused,
    };

    const dict = getDict();

    // Timer digits
    els.timerDigits.textContent = formatTime(remaining);

    // Timer display class
    els.timerDisplay.className = 'timer-display';
    els.timerDisplay.classList.add(`timer-${state}`);
    if (paused) els.timerDisplay.classList.add('timer-paused');

    // State indicator
    els.stateIndicator.className = 'state-indicator';
    els.stateIndicator.classList.add(`state-${state}`);
    if (paused) els.stateIndicator.classList.add('state-paused');

    // State text
    let label;
    if (paused) {
      label = (dict.statePaused || 'Paused') + ' ' + formatTime(remaining);
    } else {
      const stateLabels = {
        idle:    dict.stateIdle,
        working: dict.stateWorking,
        break:   dict.stateBreak,
      };
      label = stateLabels[state] || stateLabels.idle || state;
      if (state === 'working' || state === 'break') {
        label += ' ' + formatTime(remaining);
      }
    }
    els.stateText.textContent = label;

    // Cycle count
    const cycleTemplate = dict.cycleCount || 'Completed {n} cycles';
    els.cycleCount.textContent = cycleTemplate.replace('{n}', cycles);

    // Pause button: shown as "Resume" while paused.
    const pauseLabel = paused ? (dict.btnResume || 'Resume') : (dict.btnPause || 'Pause');
    const pauseText = els.btnPause.querySelector('.btn-text');
    const pauseIcon = els.btnPause.querySelector('.btn-icon');
    if (pauseText) pauseText.textContent = pauseLabel;
    if (pauseIcon) pauseIcon.textContent = paused ? '▶' : '⏸';
    els.btnPause.title = pauseLabel;

    // Buttons
    updateButtons(state);
  }

  function updateButtons(state) {
    // Hide all first
    els.btnStart.style.display = 'none';
    els.btnPause.style.display = 'none';
    els.btnStop.style.display = 'none';

    switch (state) {
      case 'idle':
        els.btnStart.style.display = 'inline-flex';
        break;
      case 'working':
        els.btnPause.style.display = 'inline-flex';
        els.btnStop.style.display = 'inline-flex';
        break;
      case 'break':
        els.btnStop.style.display = 'inline-flex';
        break;
    }
  }

  // ---------- Timer Commands ----------
  async function runTimerCommand(method) {
    const api = window.electronAPI;
    if (!api || typeof api[method] !== 'function') return;

    // Persist a just-typed duration before start-timer reads it from disk.
    // Pause/stop don't depend on the settings, so keep those actions snappy.
    if (method === 'startTimer') {
      await flushSave();
    }

    try {
      const snapshot = await api[method]();
      if (snapshot) updateTimerDisplay(snapshot);
    } catch (err) {
      console.warn(`Failed to run ${method}:`, err);
    }
  }

  // ---------- Event Bindings ----------
  function bindEvents() {
    // Slider ↔ Input sync
    syncSliderAndInput(els.workSlider, els.workDuration);
    syncSliderAndInput(els.breakSlider, els.breakDuration);

    // Toggle changes
    els.loopMode.addEventListener('change', scheduleSave);
    els.easyExit.addEventListener('change', scheduleSave);
    els.autoStart.addEventListener('change', scheduleSave);

    // Select change
    els.blackHoleStyle.addEventListener('change', scheduleSave);

    // Language toggle — re-render the cached snapshot instead of resetting it.
    els.langToggle.addEventListener('click', () => {
      currentLang = currentLang === 'zh-CN' ? 'en-US' : 'zh-CN';
      applyLanguage();
      updateTimerDisplay(lastSnapshot);
      scheduleSave();
    });

    // Timer control buttons — render the returned snapshot immediately.
    els.btnStart.addEventListener('click', () => runTimerCommand('startTimer'));
    els.btnPause.addEventListener('click', () => runTimerCommand('pauseTimer'));
    els.btnStop.addEventListener('click', () => runTimerCommand('stopTimer'));

    // Manual break link
    els.manualBreak.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.electronAPI && window.electronAPI.triggerScreensaver) {
        window.electronAPI.triggerScreensaver();
      }
    });

    // Explicit quit path even when the tray icon is hidden by Windows.
    els.quitApp.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.electronAPI && typeof window.electronAPI.quitApp === 'function') {
        window.electronAPI.quitApp();
      }
    });
  }

  // ---------- Listen for Timer Ticks ----------
  function listenForTicks() {
    if (window.electronAPI && typeof window.electronAPI.onTimerTick === 'function') {
      window.electronAPI.onTimerTick((data) => {
        updateTimerDisplay(data);
      });
    }
  }

  // ---------- Initialize ----------
  async function init() {
    // Bind interactive events
    bindEvents();

    // Listen for timer updates
    listenForTicks();

    // Load saved settings
    try {
      if (window.electronAPI && typeof window.electronAPI.getSettings === 'function') {
        const settings = await window.electronAPI.getSettings();
        populateUI(settings);
      }
    } catch (err) {
      console.warn('Failed to load settings:', err);
    }

    // Seed the panel from the live timer state (correct if the window was
    // reloaded while a session was already running).
    let snapshot = null;
    try {
      if (window.electronAPI && typeof window.electronAPI.getTimerState === 'function') {
        snapshot = await window.electronAPI.getTimerState();
      }
    } catch (err) {
      console.warn('Failed to read timer state:', err);
    }

    updateTimerDisplay(snapshot || {
      state: 'idle',
      remainingSeconds: 0,
      cycles: 0,
      paused: false,
    });
  }

  // ---------- Boot ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
