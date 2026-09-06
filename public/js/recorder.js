/* ══ blueprints ══════════════════════════════════════════════════════════
   A blueprint is the build order of a run: every placement, swap, upgrade
   and sale, in the order it happened, each tagged with the wave it was made
   on. Runs record themselves; replaying one hands the opening back to an
   autopilot, so the part of the game you have already solved does not have
   to be clicked out again.

   Replay is deliberately *not* a deterministic re-simulation - waves are
   random, so the same clicks never produce the same run twice. It is a
   build order: each step waits for the wave it was recorded on, then for
   the gold to pay for it, and is skipped when the board makes it
   impossible. Anything the player does by hand mid-replay is recorded too,
   so an extended run saves as an extended blueprint.

   Nothing here imports game.js; the simulation hands itself over with
   bindGame() so the dependency direction stays one-way.                  */

import { TOWERS, TOWER_ORDER, cx, cy } from './config.js';
import { field, legal } from './field.js';
import * as meta from './meta.js';
import * as store from './storage.js';

const KEY = 'turret-trouble:blueprints:v1';

/** Library caps. Blueprints are small, but localStorage is not elastic. */
export const MAX_BLUEPRINTS = 12;
/** Auto-saved runs beyond this many are pruned, newest kept, pinned spared. */
export const MAX_AUTO = 5;
/** A single tape stops growing here; long runs still replay their opening. */
export const MAX_STEPS = 2000;
/** Runs shorter than this are not worth keeping. */
const MIN_STEPS = 3;

/** How often the autopilot looks at the queue, in simulated seconds. */
const TICK = 0.1;
/** How long a structurally blocked step waits before it is given up on. */
const BLOCK_TIMEOUT = 12;

/* ── state ────────────────────────────────────────────────────────────── */

/** The run being recorded, plus the playback in flight. */
export const rec = {
  /** Steps recorded so far this run. */
  tape: [],
  /** Blueprint id queued to replay when the next run starts. */
  armed: null,
  /** Live playback, or null. */
  play: null,
  /** The blueprint the last finished run was saved as, for the summary. */
  last: null
};

/** Saved blueprints, newest first. */
export const library = { list: [] };

/** Bumped whenever the library or a playback changes, for UI caches. */
export const revision = { n: 0 };

const touch = () => { revision.n++; };

/* The simulation, handed over at boot by game.js. */
let g = null;
export function bindGame(api) { g = api; }

/* ── recording ────────────────────────────────────────────────────────── */

/**
 * Called by the simulation after an action lands. Steps carry the wave they
 * were made on, which is what paces the replay.
 */
export function note(step) {
  if (!g || rec.tape.length >= MAX_STEPS) return;
  rec.tape.push({ ...step, w: g.S.wave });
}

/** Fresh tape, and the armed blueprint takes over if there is one. */
export function beginRun() {
  rec.tape = [];
  rec.play = null;
  rec.last = null;
  if (rec.armed) {
    const id = rec.armed;
    rec.armed = null;
    startPlayback(id);
  }
  touch();
}

/**
 * Called when a run ends, whether it broke or was abandoned. The tape is
 * kept automatically, so a good run is never lost to not having thought to
 * save it.
 */
export function endRun(stats) {
  rec.play = null;
  if (rec.tape.length < MIN_STEPS) { rec.last = null; touch(); return null; }
  const bp = saveTape({ auto: true, ...stats });
  rec.last = bp;
  touch();
  return bp;
}

/* ── the library ──────────────────────────────────────────────────────── */

export function find(id) {
  return library.list.find(bp => bp.id === id) || null;
}

function newId() {
  return 'bp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Store the current tape as a blueprint. `auto` marks it as one the game
 * kept by itself, which is what pruning goes after first.
 */
export function saveTape({ auto = false, waves = 0, score = 0, kills = 0 } = {}) {
  if (!rec.tape.length) return null;
  // A blueprint is named for the deepest wave it reaches, which is the wave
  // the last turret in it was built on - not necessarily one that was held.
  const reached = Math.max(waves, lastWave(rec.tape), 1);
  const bp = {
    id: newId(),
    // The card carries the date of its own accord, so the name need not.
    name: `Wave ${reached} build`,
    created: Date.now(),
    waves: reached, score, kills,
    auto,
    pinned: false,
    steps: rec.tape.map(s => ({ ...s }))
  };
  library.list.unshift(bp);
  prune();
  persist();
  touch();
  return bp;
}

/** Keep the library small: autos go first, pinned blueprints never go. */
function prune() {
  let autos = 0;
  library.list = library.list.filter(bp => {
    if (bp.pinned || !bp.auto) return true;
    return ++autos <= MAX_AUTO;
  });
  if (library.list.length > MAX_BLUEPRINTS) {
    const pinned = library.list.filter(bp => bp.pinned);
    const rest = library.list.filter(bp => !bp.pinned);
    library.list = [...pinned, ...rest].slice(0, MAX_BLUEPRINTS);
    library.list.sort((a, b) => b.created - a.created);
  }
}

export function remove(id) {
  const before = library.list.length;
  library.list = library.list.filter(bp => bp.id !== id);
  if (library.list.length === before) return;
  if (rec.armed === id) rec.armed = null;
  if (rec.last && rec.last.id === id) rec.last = null;
  // A playback already running keeps its copy of the steps; only the link
  // back to the library is gone.
  if (rec.play && rec.play.id === id) rec.play.id = null;
  persist();
  touch();
}

export function rename(id, name) {
  const bp = find(id);
  if (!bp) return false;
  bp.name = String(name).slice(0, 48).trim() || bp.name;
  persist();
  touch();
  return true;
}

/** Pinning takes a blueprint out of the auto-prune and keeps it for good. */
export function pin(id, on) {
  const bp = find(id);
  if (!bp) return false;
  bp.pinned = on === undefined ? !bp.pinned : !!on;
  // A pinned blueprint is a deliberate keep, so it stops counting as auto.
  if (bp.pinned) bp.auto = false;
  persist();
  touch();
  return bp.pinned;
}

export function clearAll() {
  library.list = [];
  rec.armed = null;
  rec.last = null;
  store.remove(KEY);
  touch();
}

/* ── share ────────────────────────────────────────────────────────────── */

/** A blueprint as portable JSON, for pasting into another browser. */
export function exportOne(id) {
  const bp = find(id);
  if (!bp) return '';
  return JSON.stringify({ v: 1, name: bp.name, waves: bp.waves, steps: bp.steps });
}

/** The other half of exportOne. Returns the new blueprint, or null. */
export function importJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return null; }
  const steps = sanitiseSteps(data && data.steps);
  if (!steps.length) return null;

  const bp = {
    id: newId(),
    name: (typeof data.name === 'string' && data.name.slice(0, 48).trim()) || 'Imported build',
    created: Date.now(),
    waves: Math.max(0, Number(data.waves) || lastWave(steps)),
    score: 0, kills: 0,
    auto: false,
    pinned: true,
    steps
  };
  library.list.unshift(bp);
  prune();
  persist();
  touch();
  return bp;
}

const OPS = new Set(['place', 'swap', 'up', 'sell', 'clear']);

/** Never trust a saved or pasted tape: drop anything that is not a step. */
function sanitiseSteps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw.slice(0, MAX_STEPS)) {
    if (!s || !OPS.has(s.op)) continue;
    const step = { op: s.op, w: Math.max(0, Math.floor(Number(s.w)) || 0) };
    if (s.op !== 'clear') {
      const i = Number(s.i);
      if (!Number.isInteger(i) || i < 0 || i >= field.grid.length) continue;
      step.i = i;
    }
    if (s.k !== undefined && s.k !== null) {
      if (!TOWERS[s.k]) continue;
      step.k = s.k;
    }
    if (s.l !== undefined) step.l = Math.max(0, Math.min(3, Math.floor(Number(s.l)) || 0));
    out.push(step);
  }
  return out;
}

/* ── save / load ──────────────────────────────────────────────────────── */
let pending = 0;

export function persist() {
  clearTimeout(pending);
  pending = setTimeout(persistNow, 400);
}

/** Flush immediately - used on pagehide, where a timer would not fire. */
export function persistNow() {
  clearTimeout(pending);
  store.write(KEY, { v: 1, list: library.list });
}

export function init() {
  const saved = store.read(KEY);
  library.list = [];
  if (saved && Array.isArray(saved.list)) {
    for (const bp of saved.list.slice(0, MAX_BLUEPRINTS)) {
      const steps = sanitiseSteps(bp && bp.steps);
      if (!steps.length) continue;
      library.list.push({
        id: typeof bp.id === 'string' ? bp.id : newId(),
        name: typeof bp.name === 'string' ? bp.name.slice(0, 48) : 'Build',
        created: Number(bp.created) || Date.now(),
        waves: Math.max(0, Number(bp.waves) || 0),
        score: Math.max(0, Number(bp.score) || 0),
        kills: Math.max(0, Number(bp.kills) || 0),
        auto: !!bp.auto,
        pinned: !!bp.pinned,
        steps
      });
    }
    library.list.sort((a, b) => b.created - a.created);
  }
  touch();
}

/* ── playback ─────────────────────────────────────────────────────────────
   The autopilot walks the tape in order. A step never runs before the wave
   it was recorded on, and never out of turn - an upgrade queued behind a
   turret nobody can afford yet waits for that turret, exactly as the hand
   that recorded it did.                                                  */

export function arm(id) {
  rec.armed = find(id) ? id : null;
  touch();
  return rec.armed;
}

export function disarm() {
  rec.armed = null;
  touch();
}

/** Take over the current run with a blueprint. */
export function startPlayback(id) {
  const bp = find(id);
  if (!bp || !g) return false;
  rec.play = {
    id: bp.id,
    name: bp.name,
    steps: bp.steps,
    total: bp.steps.length,
    at: 0,          // index of the step being attempted
    done: 0,        // steps that landed
    skipped: 0,     // steps the board made impossible
    held: 0,        // seconds the head step has been blocked
    clock: 0,       // time since the last look at the queue
    status: 'run',  // run | wait | hold | paused | done
    need: 0,        // gold the head step is waiting for
    linger: 0,
    paused: false
  };
  touch();
  return true;
}

export function stopPlayback() {
  if (!rec.play) return;
  rec.play = null;
  touch();
}

export function togglePlayback() {
  const p = rec.play;
  if (!p || p.status === 'done') return;
  p.paused = !p.paused;
  p.held = 0;
  // Set the status here rather than waiting for the next tick, so the panel
  // relabels on the same click that paused it.
  p.status = p.paused ? 'paused' : 'run';
  touch();
}

/** Give up on the step at the head and move to the next one. */
export function skipStep() {
  const p = rec.play;
  if (!p || p.status === 'done' || p.at >= p.steps.length) return;
  p.at++;
  p.skipped++;
  p.held = 0;
  p.need = 0;
  if (p.at >= p.steps.length) finish(p);
  touch();
}

function finish(p) {
  p.status = 'done';
  p.need = 0;
  // Leave the summary on screen for a moment rather than vanishing mid-run.
  p.linger = 5;
}

/** Called every simulated frame by game.update(). */
export function tick(dt) {
  const p = rec.play;
  if (!p || !g) return;

  if (p.status === 'done') {
    p.linger -= dt;
    if (p.linger <= 0) { rec.play = null; touch(); }
    return;
  }
  if (p.paused) {
    if (p.status !== 'paused') { p.status = 'paused'; touch(); }
    return;
  }

  p.clock += dt;
  if (p.clock < TICK) return;
  const slice = p.clock;
  p.clock = 0;

  const was = { at: p.at, status: p.status, need: p.need };
  let guard = 0;

  while (p.at < p.steps.length && guard++ < 40) {
    const step = p.steps[p.at];
    if (step.w > g.S.wave) { p.status = 'wait'; p.need = 0; break; }

    const outcome = attempt(step);
    if (outcome === 'ok')   { p.at++; p.done++;    p.held = 0; p.status = 'run'; continue; }
    if (outcome === 'skip') { p.at++; p.skipped++; p.held = 0; p.status = 'run'; continue; }

    if (outcome === 'gold') {
      // Saving up is not a failure, so it never times out - the panel says
      // what is being saved for, and "skip" is one click away.
      p.status = 'wait';
      p.held = 0;
    } else {
      // Something on the board is in the way: a walker crossing the cell, or
      // a turret a later step has not sold yet. Give it a while, then move on
      // rather than stalling the rest of the build forever.
      p.status = 'hold';
      p.held += slice;
      if (p.held >= BLOCK_TIMEOUT) { p.at++; p.skipped++; p.held = 0; continue; }
    }
    break;
  }

  if (p.at >= p.steps.length) finish(p);
  if (was.at !== p.at || was.status !== p.status || was.need !== p.need) touch();
}

/**
 * Try one step. Returns 'ok', 'skip' (impossible, or already true), 'gold'
 * (affordable later) or 'blocked' (the board is in the way for now).
 */
function attempt(step) {
  const p = rec.play;
  const S = g.S;
  p.need = 0;

  switch (step.op) {
    case 'place': {
      if (!meta.towerUnlocked(step.k)) return 'skip';
      const standing = field.grid[step.i];
      if (standing) return standing.k === step.k ? 'skip' : 'blocked';
      const cost = g.buildCost(step.k);
      if (S.gold < cost) { p.need = cost; return 'gold'; }
      // Illegal placements here are transient: a walker on the cell, or a
      // route that a pending sale will open back up.
      if (!legal(step.i, S.foes)) return 'blocked';
      return g.place(step.i, step.k) ? 'ok' : 'blocked';
    }

    case 'swap': {
      const t = field.grid[step.i];
      if (!t) return 'blocked';
      if (t.k === step.k) return 'skip';
      if (!meta.towerUnlocked(step.k)) return 'skip';
      const net = g.convertCost(t, step.k);
      if (net > S.gold) { p.need = net; return 'gold'; }
      return g.convert(t, step.k) ? 'ok' : 'blocked';
    }

    case 'up': {
      const t = field.grid[step.i];
      if (!t) return 'blocked';
      if (step.k && t.k !== step.k) return 'blocked';
      // Already at or past the level this step was recorded at.
      if (step.l !== undefined && t.l >= step.l) return 'skip';
      const cost = g.upgradeCost(t);
      // null means capped - usually Prototype Cores is not owned this run.
      if (cost == null) return 'skip';
      if (S.gold < cost) { p.need = cost; return 'gold'; }
      g.upgrade(t);
      return 'ok';
    }

    case 'sell': {
      const t = field.grid[step.i];
      if (!t) return 'skip';
      if (step.k && t.k !== step.k) return 'skip';
      g.sell(t);
      return 'ok';
    }

    case 'clear':
      g.clearGrid();
      return 'ok';

    default:
      return 'skip';
  }
}

/* ── readouts ─────────────────────────────────────────────────────────── */

/** Cells are named by their 1-based column and row, as the player sees them. */
const where = i => `${cx(i) + 1},${cy(i) + 1}`;

/** One step as a line of English, for the panel and the blueprint list. */
export function describe(step) {
  const name = step.k ? TOWERS[step.k].name : 'tower';
  switch (step.op) {
    case 'place': return `Build ${name} at ${where(step.i)}`;
    case 'swap':  return `Swap ${where(step.i)} to ${name}`;
    case 'up':    return `Upgrade ${name} at ${where(step.i)}`;
    case 'sell':  return `Sell ${name} at ${where(step.i)}`;
    case 'clear': return 'Clear the grid';
    default:      return 'Step';
  }
}

/** What the autopilot is doing right now, in one line. */
export function playbackLine() {
  const p = rec.play;
  if (!p) return '';
  if (p.status === 'done') {
    return p.skipped
      ? `Blueprint done · ${p.done} built, ${p.skipped} skipped`
      : `Blueprint done · ${p.done} steps replayed`;
  }
  const step = p.steps[p.at];
  if (!step) return 'Blueprint done';
  if (p.status === 'paused') return `Paused · ${describe(step)}`;
  if (p.status === 'wait' && p.need) return `Saving ${p.need}g · ${describe(step).toLowerCase()}`;
  if (p.status === 'wait') return `Holds until wave ${step.w} · ${describe(step)}`;
  if (p.status === 'hold') return `Blocked · ${describe(step)}`;
  return describe(step);
}

/** Tower kind -> how many of it a tape builds, for the library cards. */
export function summarise(steps) {
  const counts = new Map();
  for (const s of steps) {
    if (s.op !== 'place' && s.op !== 'swap') continue;
    counts.set(s.k, (counts.get(s.k) || 0) + 1);
  }
  return TOWER_ORDER.filter(k => counts.has(k)).map(k => [k, counts.get(k)]);
}

/** The last wave a tape touches - the depth the build order actually covers. */
export function lastWave(steps) {
  return steps.length ? steps[steps.length - 1].w : 0;
}
