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
ui.actions.play = () => {
  audio.unlock();
  ui.hideStart();
  ui.el('over').classList.add('hidden');
  ui.el('btnPause').textContent = 'Pause';
  newRun();
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

ui.actions.abandon = () => {
  if (S.phase !== 'menu' && S.phase !== 'dead') {
    meta.noteRunEnd(S.wavesCleared, S.score);
    // Walking away from a run still banks its build order.
    endRecording();
  }
  S.phase = 'menu';
  S.paused = false;
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

  if (S.phase === 'menu' || S.phase === 'dead') { ui.actions.play(); return; }
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

  render.draw();
  requestAnimationFrame(frame);
}

/* ── go ───────────────────────────────────────────────────────────────── */
ui.bind();
S.dev = storedDev();
newRun();
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
