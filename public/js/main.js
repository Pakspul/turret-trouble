/* ══ boot ════════════════════════════════════════════════════════════════
   Wires the modules together: input, the frame loop, and the handful of
   actions the UI needs to drive.                                        */

import { field } from './field.js';
import { S, newRun, startWave, place, clearGrid, update, cycleSpeed, endRecording } from './game.js';
import * as frontier from './frontier.js';
import { F } from './frontier.js';
import * as render from './render.js';
import * as frender from './frontier-render.js';
import * as ui from './ui.js';
import * as meta from './meta.js';
import * as recorder from './recorder.js';
import * as audio from './audio.js';

const canvas = document.getElementById('cv');
const stage = document.getElementById('stage');

meta.init();
recorder.init();
render.init(canvas, stage);
frender.init(canvas, stage);

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
  if (S.mode === 'frontier') { frontier.leave(); return; }
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

/** Fly a Frontier sector. */
ui.actions.frontier = sector => {
  audio.unlock();
  leaveRun();
  ui.hideStart();
  ui.closeSectors();
  ui.el('over').classList.add('hidden');
  ui.el('btnPause').textContent = 'Pause';
  frontier.newSortie(sector);
  frender.layout();
  frender.home();
  dirty = false;
  ui.sync();
};

ui.actions.home = () => {
  if (S.mode !== 'frontier' || !F.map) return;
  F.follow = true;
  frender.home();
};

ui.actions.startWave = () => (S.mode === 'frontier' ? frontier.startWave() : startWave());
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

  // Blueprints are Holdout build orders: from a Frontier sortie they wait
  // for the next Holdout run.
  if (S.mode === 'frontier' && live()) { ui.syncArmed(); ui.sync(); return; }

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
  if (S.mode === 'frontier') { mapDown(ev); return; }
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
  if (S.mode === 'frontier') { mapMove(ev); return; }
  if (S.picked && (dragging || ev.pointerType === 'mouse')) S.hover = render.cellAt(ev);
});

canvas.addEventListener('pointerup', ev => {
  if (S.mode === 'frontier') { mapUp(ev); return; }
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

canvas.addEventListener('pointercancel', ev => {
  dragging = false;
  S.hover = -1;
  pointers.delete(ev.pointerId);
  if (!pointers.size) gesture = null;
});
canvas.addEventListener('pointerleave', () => { if (!dragging && !gesture) S.hover = -1; });

/* ── Frontier: a map you can drag, pinch and wheel ────────────────────────
   One finger (or the left button) drags the map; a tap selects whatever
   is under it. With a building picked, the finger places it instead - a
   second finger, or the right mouse button, still moves the map. Tapping
   the minimap jumps there. Dragging the map or jumping stops the camera
   following your Commander; the stick, H or the big button start it
   again. The thumb stick is its own element with its own pointer, so it
   never lands here.                                                     */
const pointers = new Map();
let gesture = null;
/** Pixels a press may wander before it counts as a drag, not a tap. */
const TAP_SLOP = 7;

function pinchSpan() {
  const [a, b] = [...pointers.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function mapDown(ev) {
  if (S.phase === 'menu' || !F.map) return;
  const p = frender.local(ev);
  pointers.set(ev.pointerId, p);
  try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }

  if (pointers.size >= 2) {
    gesture = { mode: 'pinch', ...pinchSpan() };
    S.hover = -1;
    return;
  }
  const mini = frender.miniHit(ev);
  if (mini) { F.follow = false; frender.focus(mini.x, mini.y); gesture = { mode: 'mini' }; return; }

  const panButton = ev.pointerType === 'mouse' && ev.button !== 0;
  const mode = S.picked && !panButton && S.phase !== 'dead' ? 'place' : 'pan';
  gesture = { mode, x0: p.x, y0: p.y, last: p, moved: false };
  if (mode === 'place') S.hover = frender.cellAt(ev);
}

function mapMove(ev) {
  if (!F.map) return;
  const p = frender.local(ev);
  if (!pointers.has(ev.pointerId)) {
    // A hovering mouse previews the placement.
    if (S.picked && ev.pointerType === 'mouse' && !gesture) S.hover = frender.cellAt(ev);
    return;
  }
  pointers.set(ev.pointerId, p);
  if (!gesture) return;

  if (gesture.mode === 'pinch' && pointers.size >= 2) {
    const now = pinchSpan();
    frender.zoomAt(now.x, now.y, now.d / gesture.d);
    frender.pan(now.x - gesture.x, now.y - gesture.y);
    Object.assign(gesture, now);
  } else if (gesture.mode === 'mini') {
    const mini = frender.miniHit(ev);
    if (mini) frender.focus(mini.x, mini.y);
  } else if (gesture.mode === 'pan') {
    if (!gesture.moved && Math.hypot(p.x - gesture.x0, p.y - gesture.y0) > TAP_SLOP) { gesture.moved = true; F.follow = false; }
    if (gesture.moved) frender.pan(p.x - gesture.last.x, p.y - gesture.last.y);
    gesture.last = p;
  } else if (gesture.mode === 'place') {
    S.hover = frender.cellAt(ev);
  }
}

function mapUp(ev) {
  pointers.delete(ev.pointerId);
  const g = gesture;
  if (!g) return;
  if (g.mode === 'pinch') {
    // Lifting one finger of a pinch must not drop a tower or select one.
    if (!pointers.size) gesture = null;
    else gesture = { mode: 'idle' };
    return;
  }
  gesture = null;
  if (g.mode === 'pan' && !g.moved && S.phase !== 'dead') {
    const w = frender.worldAt(ev);
    S.selected = frontier.pickAt(w.x, w.y);
    ui.sync();
  } else if (g.mode === 'place') {
    const i = frender.cellAt(ev);
    if (i >= 0) {
      if (F.grid[i]) { S.selected = F.grid[i]; ui.sync(); }
      else frontier.place(i, S.picked);
    }
    if (ev.pointerType !== 'mouse') S.hover = -1;
  }
}

canvas.addEventListener('wheel', ev => {
  if (S.mode !== 'frontier' || !F.map) return;
  ev.preventDefault();
  const p = frender.local(ev);
  frender.zoomAt(p.x, p.y, Math.exp(-ev.deltaY * 0.0015));
}, { passive: false });

canvas.addEventListener('contextmenu', ev => { if (S.mode === 'frontier') ev.preventDefault(); });

/* In Frontier WASD walks your Commander (the keyboard's thumb stick) and
   the arrow keys scroll the map. */
const held = new Set();
const PAN_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const WALK_KEYS = { a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1] };
addEventListener('keydown', ev => {
  if (S.mode !== 'frontier' || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  if (!PAN_KEYS[key] && !WALK_KEYS[key]) return;
  if (PAN_KEYS[key]) ev.preventDefault();
  held.add(key);
});
addEventListener('keyup', ev => held.delete(ev.key.length === 1 ? ev.key.toLowerCase() : ev.key));
addEventListener('blur', () => held.clear());

function keyInput(dt) {
  if (S.mode !== 'frontier') return;
  let px = 0, py = 0, wx = 0, wy = 0;
  if (!S.suspended) {
    for (const k of held) {
      if (PAN_KEYS[k]) { px += PAN_KEYS[k][0]; py += PAN_KEYS[k][1]; }
      if (WALK_KEYS[k]) { wx += WALK_KEYS[k][0]; wy += WALK_KEYS[k][1]; }
    }
  }
  const m = Math.hypot(wx, wy) || 1;
  F.keys.x = wx / m;
  F.keys.y = wy / m;
  if (wx || wy) F.follow = true;
  if (px || py) {
    F.follow = false;
    const speed = 900 * dt;
    frender.pan(-px * speed, -py * speed);
  }
}

/* ── frame loop ───────────────────────────────────────────────────────── */
let last = performance.now();
let wasDead = false;

function frame(now) {
  // Clamp so a backgrounded tab does not fast-forward the whole wave.
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const steps = S.paused ? 0 : S.speed;
  const step = S.mode === 'frontier' ? frontier.update : update;
  keyInput(dt);
  for (let k = 0; k < steps; k++) step(dt);
  if (S.mode === 'frontier') frender.follow(dt);

  if (S.phase === 'dead' && !wasDead) { wasDead = true; ui.showGameOver(); }
  if (S.phase !== 'dead') wasDead = false;

  if (dirty) { dirty = false; ui.sync(); }
  syncWakeLock();

  if (S.mode === 'frontier') frender.draw();
  else render.draw();
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
