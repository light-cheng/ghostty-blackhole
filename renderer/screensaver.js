import { BlackHoleRenderer } from './blackhole-renderer.js';

const TARGET_TEXT = '确认停止休息';
const PRESET_MAP = {
    inferno: 0,
    gargantua: 1,
    m87: 2,
    quasar: 3,
    blazar: 4,
    purelens: 5,
};

const TEXT = {
    'zh-CN': {
        anyKey: '按任意键退出',
        type: '输入「确认停止休息」退出',
        also: '也可退出',
        shortcutUnavailable: '快捷退出未注册，请使用上面的方式退出',
        captureError: '无法捕获桌面（屏幕捕获权限或显示器状态异常）。请使用退出提示离开屏保。',
    },
    'en-US': {
        anyKey: 'Press any key to exit',
        type: 'Type 确认停止休息 to exit',
        also: 'also exits',
        shortcutUnavailable: 'Exit shortcut unavailable; use the method above to exit',
        captureError: 'Unable to capture the desktop (screen capture denied or display unavailable). Use the exit hint to leave the screensaver.',
    },
};

const canvas = document.getElementById('blackhole-canvas');
const promptEl = document.getElementById('exit-prompt');
const inputArea = document.getElementById('exit-input-area');
const hiddenInput = document.getElementById('hidden-input');
const countdownEl = document.getElementById('break-countdown');
const captureErrorEl = document.getElementById('capture-error');

const api = window.electronAPI || null;

let renderer = null;
let ready = null;
let active = false;
let dismissed = false;
let showSeq = 0;
let lang = 'zh-CN';
let easyExit = false;
let breakMinutes = 5;
let activeShortcut = '';
let targetCells = [];
let typed = '';
let composing = false;

let captureSeq = 0;
let currentStream = null;
let currentVideo = null;
let watchdogTimer = null;
let lastFrameAt = 0;
let captureRetried = false;
let retryTimer = null;

// ----------------------------------------------------------------
//  IPC — registered before the renderer await so the first show
//  payload cannot be missed while shaders are loading.
// ----------------------------------------------------------------
if (api) {
    api.onScreensaverShow((data) => handleShow(data));
    api.onScreensaverHide(() => handleHide());
    api.onTimerTick((data) => updateCountdown(data));
    api.onScreensaverCaptureInvalid(() => {
        if (!active) return;
        ready.then(() => {
            if (!active) return;
            captureRetried = false;
            releaseCapture();
            startCapture();
        }).catch(handleFatal);
    });
}

ready = initRenderer();
ready.catch(handleFatal);

async function initRenderer() {
    renderer = new BlackHoleRenderer(canvas);
    await renderer.init();
    return renderer;
}

function handleShow(data) {
    const seq = ++showSeq;
    applyShowUI(data);

    ready.then(() => {
        if (!active || seq !== showSeq) return;
        renderer.reset();
        renderer.start();
        startCapture();
    }).catch(handleFatal);
}

function handleHide() {
    showSeq++;
    applyHide();
}

function applyShowUI(data) {
    const d = data && typeof data === 'object' ? data : {};
    lang = d.language === 'en-US' ? 'en-US' : 'zh-CN';
    easyExit = !!d.easyExit;
    breakMinutes = Number.isFinite(d.breakMinutes) ? d.breakMinutes : 5;
    activeShortcut = typeof d.shortcut === 'string' ? d.shortcut : '';

    active = true;
    dismissed = false;
    typed = '';
    composing = false;
    captureRetried = false;
    applyPreset(d.preset);

    hideCaptureError();
    setupExitUI();
    setCountdown(breakMinutes * 60);
    releaseCapture();

    setTimeout(() => {
        if (!active) return;
        try {
            hiddenInput.focus();
        } catch (err) {
            // Focus is best-effort; the global shortcut is the fallback.
        }
    }, 0);
}

function applyHide() {
    active = false;
    releaseCapture();
    if (renderer) renderer.stop();
    typed = '';
    composing = false;
    dismissed = false;
}

function handleFatal(err) {
    console.error('[screensaver]', err);
    if (active) showCaptureError();
}

// ----------------------------------------------------------------
//  Exit UI
// ----------------------------------------------------------------
function setupExitUI() {
    const t = TEXT[lang];
    const label = formatShortcut(activeShortcut);
    const parts = [easyExit ? t.anyKey : t.type];
    if (label) {
        parts.push(`${label} ${t.also}`);
    } else {
        parts.push(t.shortcutUnavailable);
    }
    promptEl.textContent = parts.join(' · ');

    inputArea.classList.toggle('visible', !easyExit);

    if (targetCells.length !== TARGET_TEXT.length) {
        inputArea.innerHTML = '';
        targetCells = [];
        for (const ch of TARGET_TEXT) {
            const cell = document.createElement('span');
            cell.className = 'char-cell';
            cell.textContent = ch;
            inputArea.appendChild(cell);
            targetCells.push(cell);
        }
    }
    renderCells();
}

function formatShortcut(accelerator) {
    if (!accelerator) return '';
    return accelerator
        .replace('CommandOrControl', 'Ctrl')
        .replace('Command', 'Cmd')
        .replace('Control', 'Ctrl');
}

function renderCells() {
    targetCells.forEach((cell, i) => {
        cell.classList.toggle('correct', i < typed.length);
        cell.classList.toggle('current', i === typed.length);
    });
}

function handleText(text) {
    if (!text) return;
    for (const ch of text) {
        if (typed.length >= TARGET_TEXT.length) break;
        if (ch === TARGET_TEXT[typed.length]) {
            typed += ch;
        } else {
            flagWrong(typed.length);
            typed = '';
            renderCells();
            return;
        }
    }
    renderCells();
    if (typed === TARGET_TEXT) dismiss();
}

function flagWrong(index) {
    const cell = targetCells[index];
    if (!cell) return;
    cell.classList.add('wrong');
    setTimeout(() => cell.classList.remove('wrong'), 500);
}

function dismiss() {
    if (dismissed) return;
    dismissed = true;
    if (!api || typeof api.dismissScreensaver !== 'function') return;
    const result = api.dismissScreensaver();
    if (result && typeof result.catch === 'function') {
        result.catch(() => {
            dismissed = false;
        });
    }
}

// ----------------------------------------------------------------
//  Countdown
// ----------------------------------------------------------------
function updateCountdown(data) {
    if (!active || !data) return;
    const state = String(data.state || '').toLowerCase();
    if (state !== 'break') return;
    if (Number.isFinite(data.remainingSeconds)) {
        setCountdown(data.remainingSeconds);
    }
}

function setCountdown(seconds) {
    countdownEl.textContent = formatTime(seconds);
}

function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
}

// ----------------------------------------------------------------
//  Desktop capture — one stream per screensaver show
// ----------------------------------------------------------------
async function startCapture() {
    if (!active) return;
    const seq = ++captureSeq;

    if (!api || typeof api.getDesktopSourceId !== 'function') {
        recoverFromLoss();
        return;
    }

    try {
        const sourceId = await api.getDesktopSourceId();
        if (seq !== captureSeq || !active) return;
        if (!sourceId) throw new Error('No desktop capture source.');

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId,
                },
                cursor: 'never',
            },
        });
        if (seq !== captureSeq || !active) {
            stopStream(stream);
            return;
        }

        const video = document.createElement('video');
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        video.style.cssText =
            'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
        video.srcObject = stream;

        currentStream = stream;
        currentVideo = video;
        document.body.appendChild(video);

        await video.play();
        if (seq !== captureSeq || !active) {
            releaseCapture();
            return;
        }

        await waitForFirstFrame(video, 3000);
        if (seq !== captureSeq || !active) {
            releaseCapture();
            return;
        }
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
            throw new Error('Desktop capture produced no frame.');
        }

        if (renderer) {
            renderer.setVideoBackground(video);
            // setVideoBackground only flips hasDesktop after a real frame is
            // uploaded; do not force u_hasDesktop=1 over the black placeholder.
        }
        hideCaptureError();
        attachStreamLoss(stream, video, seq);
        startWatchdog(video, seq);
    } catch (err) {
        if (seq !== captureSeq || !active) return;
        console.error('[screensaver] desktop capture failed:', err);
        recoverFromLoss();
    }
}

function stopStream(stream) {
    try {
        for (const track of stream.getTracks()) track.stop();
    } catch (err) {
        // best-effort
    }
}

function waitForFirstFrame(video, timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, timeoutMs);

        if (typeof video.requestVideoFrameCallback === 'function') {
            video.requestVideoFrameCallback(finish);
        } else if (video.readyState >= 2) {
            finish();
        } else {
            video.addEventListener('loadeddata', finish, { once: true });
        }
    });
}

function attachStreamLoss(stream, video, seq) {
    const onLoss = () => handleStreamLoss(seq);
    for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', onLoss);
        track.addEventListener('mute', onLoss);
    }
    video.addEventListener('error', onLoss);
}

function startWatchdog(video, seq) {
    stopWatchdog();
    if (typeof video.requestVideoFrameCallback !== 'function') return;

    lastFrameAt = performance.now();
    const onFrame = () => {
        if (seq !== captureSeq || !active) return;
        lastFrameAt = performance.now();
        video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);

    watchdogTimer = setInterval(() => {
        if (seq !== captureSeq || !active) return;
        if (performance.now() - lastFrameAt > 2000) {
            handleNoFrames(seq);
        }
    }, 1000);
}

function stopWatchdog() {
    if (watchdogTimer !== null) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
}

function handleNoFrames(seq) {
    if (seq !== captureSeq || !active) return;

    // Never keep showing a stale frame: retry once, then fail visibly.
    releaseCapture();
    if (!captureRetried) {
        captureRetried = true;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            if (active) startCapture();
        }, 500);
        return;
    }
    showCaptureError();
}

function handleStreamLoss(seq) {
    if (seq !== captureSeq || !active) return;
    console.warn('[screensaver] desktop stream lost; re-acquiring.');
    recoverFromLoss();
}

function recoverFromLoss() {
    if (!active) {
        releaseCapture();
        return;
    }
    if (retryTimer !== null) return; // a retry is already scheduled

    releaseCapture();
    if (!captureRetried) {
        captureRetried = true;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            if (active) startCapture();
        }, 500);
        return;
    }
    showCaptureError();
}

function releaseCapture() {
    captureSeq++;
    stopWatchdog();
    if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    if (currentStream) {
        stopStream(currentStream);
        currentStream = null;
    }
    if (currentVideo) {
        try {
            currentVideo.pause();
        } catch (err) {
            // best-effort
        }
        currentVideo.srcObject = null;
        currentVideo.remove();
        currentVideo = null;
    }
    if (renderer) {
        renderer.clearVideoBackground();
        renderer.setHasDesktop(false);
    }
}

function showCaptureError() {
    const t = TEXT[lang];
    const label = formatShortcut(activeShortcut);
    captureErrorEl.textContent = label
        ? `${t.captureError} ${label} ${t.also}`
        : t.captureError;
    captureErrorEl.hidden = false;
    if (renderer) {
        renderer.clearVideoBackground();
        renderer.setHasDesktop(false);
    }
}

function hideCaptureError() {
    captureErrorEl.hidden = true;
}

// ----------------------------------------------------------------
//  Input: easy exit (any key) and IME confirmation
// ----------------------------------------------------------------
function isModifierKey(key) {
    return key === 'Shift' || key === 'Control' || key === 'Alt' ||
        key === 'Meta' || key === 'CapsLock' || key === 'NumLock' ||
        key === 'ScrollLock' || key === 'AltGraph' || key === 'OS' || key === 'Fn';
}

window.addEventListener('keydown', (e) => {
    if (!active || dismissed || !easyExit) return;
    if (isModifierKey(e.key)) return;
    e.preventDefault();
    dismiss();
}, true);

hiddenInput.addEventListener('compositionstart', () => {
    composing = true;
});

hiddenInput.addEventListener('compositionend', (e) => {
    composing = false;
    hiddenInput.value = '';
    if (e.data) handleText(e.data);
});

hiddenInput.addEventListener('input', (e) => {
    if (composing || e.isComposing) return;
    const value = hiddenInput.value;
    hiddenInput.value = '';
    if (value) handleText(value);
});

hiddenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace') {
        e.preventDefault();
        typed = typed.slice(0, -1);
        renderCells();
    }
});

window.addEventListener('focus', () => {
    if (!active) return;
    try {
        hiddenInput.focus();
    } catch (err) {
        // Focus is best-effort.
    }
});

// Apply the saved preset returned by the first screenshot before it is used.
function applyPreset(preset) {
    const idx = PRESET_MAP[String(preset || '').toLowerCase()];
    if (idx !== undefined && renderer) renderer.setPreset(idx);
}
