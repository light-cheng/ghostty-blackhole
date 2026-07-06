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
    langToggle:      $('#langToggle'),
  };

  // ---------- State ----------
  let currentState = 'idle';  // 'idle' | 'working' | 'break'
  let currentLang = 'zh-CN';
  let saveTimeout = null;
  const DEBOUNCE_MS = 400;

  // ---------- Helpers ----------
  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // ---------- Build Settings Object ----------
  function buildSettings() {
    return {
      workMinutes:    parseInt(els.workDuration.value, 10) || 25,
      breakMinutes:   parseInt(els.breakDuration.value, 10) || 5,
      loop:           els.loopMode.checked,
      easyExit:       els.easyExit.checked,
      preset:         els.blackHoleStyle.value,
      language:       currentLang,
    };
  }

  // ---------- Save (debounced) ----------
  function scheduleSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      const settings = buildSettings();
      if (window.electronAPI && window.electronAPI.saveSettings) {
        window.electronAPI.saveSettings(settings);
      }
    }, DEBOUNCE_MS);
  }

  // ---------- Populate UI from Settings ----------
  function populateUI(settings) {
    if (!settings) return;

    if (settings.language != null) {
      currentLang = settings.language;
    }
    applyLanguage();

    if (settings.workMinutes != null) {
      const v = clamp(settings.workMinutes, 1, 120);
      els.workSlider.value = v;
      els.workDuration.value = v;
      updateSliderFill(els.workSlider);
    }

    if (settings.breakMinutes != null) {
      const v = clamp(settings.breakMinutes, 1, 30);
      els.breakSlider.value = v;
      els.breakDuration.value = v;
      updateSliderFill(els.breakSlider);
    }

    if (settings.loop != null) {
      els.loopMode.checked = settings.loop;
    }

    if (settings.easyExit != null) {
      els.easyExit.checked = settings.easyExit;
    }

    if (settings.preset != null) {
      els.blackHoleStyle.value = settings.preset;
    }
  }

  // ---------- i18n Application ----------
  function applyLanguage() {
    const dict = window.locales[currentLang];
    if (!dict) return;

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
    const min = parseInt(slider.min, 10);
    const max = parseInt(slider.max, 10);

    slider.addEventListener('input', () => {
      input.value = slider.value;
      updateSliderFill(slider);
      scheduleSave();
    });

    input.addEventListener('input', () => {
      let v = parseInt(input.value, 10);
      if (isNaN(v)) return;
      v = clamp(v, min, max);
      slider.value = v;
      updateSliderFill(slider);
      scheduleSave();
    });

    input.addEventListener('blur', () => {
      let v = parseInt(input.value, 10);
      if (isNaN(v)) v = parseInt(slider.value, 10);
      v = clamp(v, min, max);
      input.value = v;
      slider.value = v;
      updateSliderFill(slider);
    });

    // Initial fill
    updateSliderFill(slider);
  }

  // ---------- Update UI State ----------
  function updateTimerDisplay(data) {
    const rawState = (data.state || 'idle').toLowerCase();
    const remaining = data.remainingSeconds != null ? data.remainingSeconds : (data.remaining || 0);
    const cycles = data.cycles || 0;
    const state = rawState === 'working' ? 'working' : rawState === 'break' ? 'break' : 'idle';
    currentState = state;

    // Timer digits
    els.timerDigits.textContent = formatTime(remaining);

    // Timer display class
    els.timerDisplay.className = 'timer-display';
    els.timerDisplay.classList.add(`timer-${state}`);

    // State indicator
    els.stateIndicator.className = 'state-indicator';
    els.stateIndicator.classList.add(`state-${state}`);

    // State text
    const dict = window.locales[currentLang] || window.locales['zh-CN'];
    const stateLabels = {
      idle:    dict.stateIdle,
      working: dict.stateWorking,
      break:   dict.stateBreak,
    };
    let label = stateLabels[state] || stateLabels.idle;
    if (state === 'working' || state === 'break') {
      label += ' ' + formatTime(remaining);
    }
    els.stateText.textContent = label;

    // Cycle count
    els.cycleCount.textContent = dict.cycleCount.replace('{n}', cycles);

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

  // ---------- Event Bindings ----------
  function bindEvents() {
    // Slider ↔ Input sync
    syncSliderAndInput(els.workSlider, els.workDuration);
    syncSliderAndInput(els.breakSlider, els.breakDuration);

    // Toggle changes
    els.loopMode.addEventListener('change', scheduleSave);
    els.easyExit.addEventListener('change', scheduleSave);

    // Select change
    els.blackHoleStyle.addEventListener('change', scheduleSave);

    // Language toggle
    els.langToggle.addEventListener('click', () => {
      currentLang = currentLang === 'zh-CN' ? 'en-US' : 'zh-CN';
      applyLanguage();
      // Re-trigger timer update so dynamic texts refresh
      updateTimerDisplay({ state: currentState, remaining: 0, cycles: parseInt(els.cycleCount.textContent.match(/\d+/) || 0) });
      scheduleSave();
    });

    // Timer control buttons
    els.btnStart.addEventListener('click', () => {
      if (window.electronAPI && window.electronAPI.startTimer) {
        window.electronAPI.startTimer();
      }
    });

    els.btnPause.addEventListener('click', () => {
      if (window.electronAPI && window.electronAPI.pauseTimer) {
        window.electronAPI.pauseTimer();
      }
    });

    els.btnStop.addEventListener('click', () => {
      if (window.electronAPI && window.electronAPI.stopTimer) {
        window.electronAPI.stopTimer();
      }
    });

    // Manual break link
    els.manualBreak.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.electronAPI && window.electronAPI.triggerScreensaver) {
        window.electronAPI.triggerScreensaver();
      }
    });
  }

  // ---------- Listen for Timer Ticks ----------
  function listenForTicks() {
    if (window.electronAPI && window.electronAPI.onTimerTick) {
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
      if (window.electronAPI && window.electronAPI.getSettings) {
        const settings = await window.electronAPI.getSettings();
        populateUI(settings);
      }
    } catch (err) {
      console.warn('Failed to load settings:', err);
    }

    // Set initial UI state AFTER populateUI/applyLanguage so dynamic
    // texts (e.g. cycle count with {n}) are rendered with correct locale
    updateTimerDisplay({ remaining: 0, state: 'idle', cycles: 0 });
  }

  // ---------- Boot ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
