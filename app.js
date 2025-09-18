const STORE_KEY = 'tabata-settings-v2';
const defaults = {
  prepare: 10,
  work: 20,
  rest: 10,
  cycles: 8,
  sets: 1,
  setRest: 60,
};

const ranges = {
  prepare: { min: 0, max: 600, step: 1 },
  work: { min: 5, max: 600, step: 1 },
  rest: { min: 0, max: 600, step: 1 },
  cycles: { min: 1, max: 20, step: 1 },
  sets: { min: 1, max: 10, step: 1 },
  setRest: { min: 0, max: 600, step: 1 },
};

let settings = loadSettings();

const state = {
  segments: buildSegments(settings),
  current: 0,
  remaining: 0,
  running: false,
  rafId: null,
  targetTs: null,
  soundEnabled: false,
  audioCtx: null,
  skipCue: false,
};

const elements = {
  settings: document.querySelectorAll('.setting'),
  totalTime: document.getElementById('totalTime'),
  totalRounds: document.getElementById('totalRounds'),
  phase: document.getElementById('phase'),
  time: document.getElementById('time'),
  next: document.getElementById('next'),
  progress: document.getElementById('progress'),
  setStatus: document.getElementById('setStatus'),
  cycleStatus: document.getElementById('cycleStatus'),
  startBtn: document.getElementById('startBtn'),
  resetBtn: document.getElementById('resetBtn'),
  soundBtn: document.getElementById('soundBtn'),
  installBtn: document.getElementById('installBtn'),
};

init();

function init() {
  applySettingsToUI();
  updateSummary();
  resetTimer();
  bindEvents();
  registerServiceWorker();
}

function loadSettings() {
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (!stored) return { ...defaults };
    const parsed = JSON.parse(stored);
    return { ...defaults, ...parsed };
  } catch (err) {
    console.warn('Failed to load settings', err);
    return { ...defaults };
  }
}

function saveSettings() {
  localStorage.setItem(STORE_KEY, JSON.stringify(settings));
}

function applySettingsToUI() {
  elements.settings.forEach((el) => {
    const key = el.dataset.setting;
    const valueEl = el.querySelector('[data-role="value"]');
    valueEl.textContent = settings[key];
  });
}

function buildSegments(cfg) {
  const segs = [];
  if (cfg.prepare > 0) {
    segs.push({ key: 'prepare', label: 'Prepare', duration: cfg.prepare, set: 0, cycle: 0 });
  }
  for (let set = 1; set <= cfg.sets; set += 1) {
    for (let cycle = 1; cycle <= cfg.cycles; cycle += 1) {
      segs.push({ key: 'work', label: 'Work', duration: cfg.work, set, cycle });
      if (cycle < cfg.cycles && cfg.rest > 0) {
        segs.push({ key: 'rest', label: 'Rest', duration: cfg.rest, set, cycle });
      }
    }
    if (set < cfg.sets && cfg.setRest > 0) {
      segs.push({ key: 'setRest', label: 'Tabata Rest', duration: cfg.setRest, set, cycle: cfg.cycles });
    }
  }
  return segs;
}

function bindEvents() {
  elements.settings.forEach((el) => {
    el.addEventListener('click', (evt) => {
      const btn = evt.target.closest('.adjust');
      if (!btn) return;
      evt.preventDefault();
      const key = el.dataset.setting;
      if (state.running) {
        flashPanel();
        return;
      }
      const delta = Number(btn.dataset.direction) * ranges[key].step;
      updateSetting(key, settings[key] + delta);
    });
  });

  elements.startBtn.addEventListener('click', () => {
    if (state.running) {
      pauseTimer();
    } else {
      startTimer();
    }
  });

  elements.resetBtn.addEventListener('click', () => {
    resetTimer();
  });

  elements.soundBtn.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    elements.soundBtn.setAttribute('aria-pressed', state.soundEnabled);
    elements.soundBtn.textContent = state.soundEnabled ? 'Sound Off' : 'Sound On';
    if (state.soundEnabled) {
      ensureAudioContext();
    } else if (state.audioCtx) {
      state.audioCtx.close();
      state.audioCtx = null;
    }
  });

  setupInstallPrompt();
}

function updateSetting(key, value) {
  const { min, max } = ranges[key];
  const next = clamp(value, min, max);
  settings[key] = next;
  const valueEl = document.querySelector(`.setting[data-setting="${key}"] [data-role="value"]`);
  if (valueEl) {
    valueEl.textContent = next;
  }
  saveSettings();
  state.segments = buildSegments(settings);
  resetTimer();
  updateSummary();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateSummary() {
  const totalSeconds = state.segments.reduce((acc, seg) => acc + seg.duration, 0);
  elements.totalTime.textContent = formatDuration(totalSeconds);
  elements.totalRounds.textContent = settings.cycles * settings.sets;
}

function resetTimer() {
  cancelTick();
  state.running = false;
  state.current = 0;
  state.remaining = state.segments[0]?.duration || 0;
  state.skipCue = false;
  elements.startBtn.textContent = 'Start';
  updateTimerDisplay();
}

function startTimer() {
  if (!state.segments.length) return;
  if (state.remaining <= 0) {
    state.current = 0;
    state.remaining = state.segments[0].duration;
  }
  state.running = true;
  if (state.skipCue && state.remaining > 0) {
    state.targetTs = performance.now() + state.remaining * 1000;
  }
  state.skipCue = false;
  elements.startBtn.textContent = 'Pause';
  tick(performance.now());
}

function pauseTimer() {
  state.running = false;
  cancelTick();
  state.skipCue = true;
  elements.startBtn.textContent = 'Resume';
}

function finishTimer() {
  cancelTick();
  state.running = false;
  elements.startBtn.textContent = 'Restart';
  updateTimerDisplay();
  playCue('complete');
}

function tick(now) {
  if (!state.running) return;
  const segment = state.segments[state.current];
  if (!segment) {
    finishTimer();
    return;
  }

  if (!state.targetTs) {
    state.targetTs = now + state.remaining * 1000;
    if (!state.skipCue) {
      playCue(segment.key);
    }
    state.skipCue = false;
  }

  const msRemaining = Math.max(0, state.targetTs - now);
  const secondsRemaining = Math.ceil(msRemaining / 1000);

  if (secondsRemaining !== state.remaining) {
    state.remaining = secondsRemaining;
    updateTimerDisplay();
  }

  if (msRemaining <= 0) {
    advanceSegment(now);
  } else {
    state.rafId = requestAnimationFrame(tick);
  }
}

function advanceSegment(now) {
  state.current += 1;
  state.targetTs = null;
  const nextSegment = state.segments[state.current];
  if (!nextSegment) {
    finishTimer();
    return;
  }
  state.remaining = nextSegment.duration;
  updateTimerDisplay();
  state.rafId = requestAnimationFrame(tick);
}

function cancelTick() {
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  state.targetTs = null;
}

function updateTimerDisplay() {
  const segment = state.segments[state.current];
  if (!segment) {
    elements.phase.textContent = 'Complete';
    elements.time.textContent = '00:00';
    elements.next.textContent = 'Done';
    elements.progress.style.width = '100%';
    elements.setStatus.textContent = `${settings.sets} / ${settings.sets}`;
    elements.cycleStatus.textContent = `${settings.cycles} / ${settings.cycles}`;
    return;
  }

  elements.phase.textContent = segment.label;
  elements.time.textContent = formatDuration(state.remaining);

  const nextSegment = state.segments[state.current + 1];
  elements.next.textContent = nextSegment ? `Next: ${nextSegment.label}` : 'Next: Complete';

  const completed = segment.duration - state.remaining;
  const width = segment.duration === 0 ? 100 : Math.min(100, (completed / segment.duration) * 100);
  elements.progress.style.width = `${width}%`;

  const setNum = Math.max(1, segment.set || 1);
  const cycleNum = segment.cycle || (segment.key === 'setRest' ? settings.cycles : 0);

  elements.setStatus.textContent = `${clamp(setNum, 1, settings.sets)} / ${settings.sets}`;
  elements.cycleStatus.textContent = `${clamp(Math.max(1, cycleNum), 1, settings.cycles)} / ${settings.cycles}`;
}

function formatDuration(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function playCue(type) {
  if (!state.soundEnabled) return;
  ensureAudioContext();
  if (!state.audioCtx) return;
  const duration = type === 'complete' ? 0.6 : 0.18;
  const freq = cueFrequency(type);
  const now = state.audioCtx.currentTime;
  const osc = state.audioCtx.createOscillator();
  const gain = state.audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, now);
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain).connect(state.audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration + 0.1);
}

function cueFrequency(type) {
  switch (type) {
    case 'work':
      return 880;
    case 'rest':
    case 'setRest':
      return 523.25;
    case 'prepare':
      return 659.25;
    case 'complete':
      return 392;
    default:
      return 600;
  }
}

function ensureAudioContext() {
  if (state.audioCtx) return;
  try {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (err) {
    console.warn('AudioContext unavailable', err);
    state.soundEnabled = false;
    elements.soundBtn.setAttribute('aria-pressed', 'false');
    elements.soundBtn.textContent = 'Sound On';
  }
}

function flashPanel() {
  const panel = document.querySelector('.timer');
  if (!panel) return;
  panel.classList.add('shake');
  setTimeout(() => panel.classList.remove('shake'), 500);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js');
  });
}

function setupInstallPrompt() {
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    elements.installBtn.hidden = false;
  });

  elements.installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      elements.installBtn.hidden = true;
    }
    deferredPrompt = null;
  });
}

// expose reset on visibility change to avoid drift
window.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (state.running && state.targetTs) {
    // adjust remaining on resume
    const now = performance.now();
    const msRemaining = Math.max(0, state.targetTs - now);
    state.remaining = Math.ceil(msRemaining / 1000);
    updateTimerDisplay();
  }
});
