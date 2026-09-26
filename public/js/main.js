/* ══ boot ════════════════════════════════════════════════════════════════
   Wires the modules together: input, the frame loop, and the handful of
   actions the UI needs to drive.                                        */

import { field } from './field.js';
import { S, newRun, startWave, place, clearGrid, update, cycleSpeed, endRecording } from './game.js';
import * as render from './render.js';
import * as ui from './ui.js';
import * as meta from './meta.js';
import * as recorder from './recorder.js';
import * as audio from './audio.js';

const canvas = document.getElementById('cv');
const stage = document.getElementById('stage');

meta.init();
recorder.init();
render.init(canvas, stage);

// The simulation fires onChange on every kill, so coalesce to one DOM pass
// per frame rather than one per event.
let dirty = true;
S.onChange = () => { dirty = true; };

/* ── actions the console triggers ─────────────────────────────────────── */
/** A run that is under way and could be picked up again from the menu. */
const live = () => S.phase !== 'menu' && S.phase !== 'dead';

/** Bank what a run earned when the player walks away from it. */
function leaveRun() {
  if (!live()) return;
  meta.noteRunEnd(S.wavesCleared, S.score);
  // Walking away from a run still banks its build order.
  endRecording();
}

/** Start a new run; `headStart` says whether it opens past wave 1. */
ui.actions.play = ({ headStart = false } = {}) => {
  audio.unlock();
  leaveRun();
  ui.hideStart();
  ui.el('over').classList.add('hidden');
  ui.el('btnPause').textContent = 'Pause';
  newRun({ headStart });
  // newRun only flags the panel dirty; paint it now rather than a frame later.
  dirty = false;
  ui.sync();
};

ui.actions.startWave = () => startWave();
ui.actions.clearGrid = () => clearGrid();

ui.actions.togglePause = () => {
  if (S.phase === 'menu' || S.phase === 'dead') return;
  S.paused = !S.paused;
};

ui.actions.cycleSpeed = () => cycleSpeed();
ui.actions.toggleDev = () => setDev(!S.dev);

/** The Menu button: freeze the run behind the title screen, so Resume can
    carry on exactly where it stopped. */
ui.actions.menu = () => {
  if (!live()) { ui.actions.abandon(); return; }
  S.suspended = true;
  S.picked = null;
  ui.showStart();
  ui.sync();
};

ui.actions.resume = () => {
  if (!live()) return;
  audio.unlock();
  S.suspended = false;
  ui.hideStart();
  ui.sync();
};

ui.actions.abandon = () => {
  leaveRun();
  S.phase = 'menu';
  S.paused = false;
  S.suspended = false;
  ui.showStart();
  ui.sync();
};

/**
 * Replay a blueprint. A run that has not started yet can pick it up on the
 * spot; anything further along waits for the next run rather than dropping
 * an autopilot into the middle of a board it did not build.
 */
ui.actions.replay = id => {
  recorder.arm(id);
  ui.closeTapes();

  if (S.phase === 'menu' || S.phase === 'dead') {
    // A build recorded after a Head Start opens its first step past wave 0,
    // so it gets the same opening back; one built from wave 1 starts there.
    const bp = recorder.find(id);
    const headStart = !!(bp && bp.steps.length && bp.steps[0].w > 0);
    ui.actions.play({ headStart });
    return;
  }
  if (S.wave === 0 && !field.grid.some(Boolean)) {
    const armed = recorder.rec.armed;
    recorder.disarm();
    recorder.startPlayback(armed);
  }
  ui.syncArmed();
  ui.sync();
};

/* ── developer mode ───────────────────────────────────────────────────────
   Adds the 10× step to the speed ladder. Switch it on with ?dev in the URL
   or with Shift+D, which is remembered across reloads.                   */
const DEV_KEY = 'turret-trouble:dev';

function storedDev() {
  try {
    if (new URLSearchParams(location.search).has('dev')) return true;
    return localStorage.getItem(DEV_KEY) === '1';
  } catch (e) { return false; }
}

function setDev(on) {
  S.dev = on;
  try { localStorage.setItem(DEV_KEY, on ? '1' : '0'); } catch (e) { /* blocked */ }
  // Dropping out of dev mode must not leave the run stuck at 10×.
  if (!on && !meta.mods.speeds.includes(S.speed)) S.speed = 1;
  ui.sync();
}

/* ── keep the screen on ───────────────────────────────────────────────────
   A phone dims and locks after a minute without a touch, which pauses the
   page mid-wave. The Screen Wake Lock API holds the screen on while a run
   is actually playing; the menu, the summary and a paused run let it go.
   The browser drops the lock whenever the page is hidden, so it is asked
   for again each frame the conditions hold and no lock is live.          */
let wakeLock = null;
let wakeAsking = false;
/** After a refusal, wait before asking again rather than every frame. */
let wakeRetryAt = 0;

function wantAwake() {
  return live() && !S.suspended && !S.paused && document.visibilityState === 'visible';
}

function syncWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (wantAwake()) {
    if (wakeLock || wakeAsking || performance.now() < wakeRetryAt) return;
    wakeAsking = true;
    navigator.wakeLock.request('screen')
      .then(lock => {
        wakeLock = lock;
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
        // The run may have ended while the request was in flight.
        if (!wantAwake()) releaseWakeLock();
      })
      .catch(() => { wakeRetryAt = performance.now() + 10000; /* battery saver, or an insecure origin */ })
      .finally(() => { wakeAsking = false; });
  } else if (wakeLock) {
    releaseWakeLock();
  }
}

function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  if (lock) lock.release().catch(() => {});
}

/* ── pointer input ────────────────────────────────────────────────────── */
let dragging = false;

canvas.addEventListener('pointerdown', ev => {
  ev.preventDefault();
  audio.unlock();
  if (S.phase === 'menu' || S.phase === 'dead') return;

  const i = render.cellAt(ev);
  if (i < 0) { S.picked = null; S.selected = null; S.hover = -1; ui.sync(); return; }

  if (S.picked) {
    dragging = true;
    S.hover = i;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
    return;
  }
  S.selected = field.grid[i] || null;
  ui.sync();
});

canvas.addEventListener('pointermove', ev => {
  if (S.picked && (dragging || ev.pointerType === 'mouse')) S.hover = render.cellAt(ev);
});

canvas.addEventListener('pointerup', ev => {
  if (!dragging) return;
  dragging = false;
  const i = render.cellAt(ev);
  if (i >= 0) {
    if (field.grid[i]) { S.selected = field.grid[i]; ui.sync(); }
    else place(i, S.picked);
  }
  if (ev.pointerType !== 'mouse') S.hover = -1;
});

// iOS Safari ignores user-scalable=no; stop pinch-zoom from knocking the
// layout out of the viewport.
document.addEventListener('gesturestart', ev => ev.preventDefault(), { passive: false });

canvas.addEventListener('pointercancel', () => { dragging = false; S.hover = -1; });
canvas.addEventListener('pointerleave', () => { if (!dragging) S.hover = -1; });

/* ── frame loop ───────────────────────────────────────────────────────── */
let last = performance.now();
let wasDead = false;

function frame(now) {
  // Clamp so a backgrounded tab does not fast-forward the whole wave.
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const steps = S.paused ? 0 : S.speed;
  for (let k = 0; k < steps; k++) update(dt);

  if (S.phase === 'dead' && !wasDead) { wasDead = true; ui.showGameOver(); }
  if (S.phase !== 'dead') wasDead = false;

  if (dirty) { dirty = false; ui.sync(); }
  syncWakeLock();

  render.draw();
  requestAnimationFrame(frame);
}

/* ── go ───────────────────────────────────────────────────────────────── */
ui.bind();
S.dev = storedDev();
// The board behind the menu is only a backdrop, so it skips Head Start.
newRun({ headStart: false });
S.phase = 'menu';
ui.showStart();
ui.sync();
requestAnimationFrame(frame);

function flush() {
  meta.persistNow();
  recorder.persistNow();
}

addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});
