/* ══ simulation ══════════════════════════════════════════════════════════
   All mutable run state lives on `S`. The renderer and the UI read it; only
   this module writes it. Nothing here touches the DOM - `S.onChange` is the
   single hook the UI subscribes to.                                      */

import {
  COLS, ROWS, SPAWN, GOAL, SPAWN_R, GOAL_R, cx, cy,
  TOWERS, FOES, CHAIN_REACH, CHAIN_FALLOFF, BREAK_SECONDS,
  BUILD_ESCALATION, KILL_GOLD_GROWTH, interestCap,
  clearGold, earlyCallGold, wavePoints, KILL_POINTS, DEV_SPEED
} from './config.js';
import { field, solve, commit, legal, reset as resetField } from './field.js';
import { buildWave } from './waves.js';
import * as meta from './meta.js';
import * as recorder from './recorder.js';
import { sfx } from './audio.js';

export const S = {
  // run economy
  gold: 0,
  score: 0,
  lives: 0,
  maxLives: 0,
  wave: 0,
  kills: 0,
  wavesCleared: 0,

  // pacing
  phase: 'menu',        // menu | build | run | break | dead
  queue: [],
  nextWave: [],
  breakLeft: 0,
  speed: 1,
  paused: false,
  /** Developer mode: adds the 10× step to the speed ladder. */
  dev: false,

  // entities
  foes: [],
  shots: [],
  blasts: [],
  arcs: [],
  motes: [],
  notes: [],

  // interaction
  picked: null,
  selected: null,
  hover: -1,

  // transient visuals
  shake: 0,
  waveFlash: 0,
  warn: 0,
  warnText: '',

  /** Set by the UI; called whenever anything panel-visible changes. */
  onChange: () => {}
};

const touch = () => S.onChange();

/* ── lifecycle ────────────────────────────────────────────────────────── */
export function newRun() {
  resetField();
  S.gold = meta.mods.startGold;
  S.score = 0;
  S.maxLives = meta.mods.lives;
  S.lives = S.maxLives;
  S.wave = 0;
  S.kills = 0;
  S.wavesCleared = 0;
  S.phase = 'build';
  S.queue = [];
  S.nextWave = buildWave(1);
  S.breakLeft = 0;
  S.speed = 1;
  S.paused = false;
  scoreCarry = 0;
  S.foes = []; S.shots = []; S.blasts = []; S.arcs = []; S.motes = []; S.notes = [];
  S.picked = null; S.selected = null; S.hover = -1;
  S.shake = 0; S.waveFlash = 0; S.warn = 0;
  // Starts a fresh tape, and hands the opening to the autopilot if a
  // blueprint has been armed.
  recorder.beginRun();
  touch();
}

function gameOver() {
  S.phase = 'dead';
  S.paused = false;
  meta.noteRunEnd(S.wavesCleared, S.score);
  meta.persistNow();
  endRecording();
  touch();
}

/** Bank the build order of the run that just finished. */
export function endRecording() {
  return recorder.endRun({ waves: S.wavesCleared, score: S.score, kills: S.kills });
}

/* ── waves ────────────────────────────────────────────────────────────── */
export function startWave() {
  if (S.phase === 'run' || S.phase === 'dead' || S.phase === 'menu') return;
  // Calling a wave early during the break pays a small bonus.
  if (S.phase === 'break') S.gold += Math.round(earlyCallGold(S.wave) * meta.mods.waveGold);

  S.wave++;
  S.queue = S.nextWave;
  S.nextWave = buildWave(S.wave + 1);
  S.phase = 'run';
  S.waveFlash = 1.6;
  sfx.wave();
  touch();
}

function endWave() {
  S.wavesCleared = S.wave;

  const clear = Math.round(clearGold(S.wave) * meta.mods.waveGold);
  S.gold += clear;

  // Only gold up to the ceiling earns, so sitting on a fortune is not a
  // strategy in itself.
  const interest = Math.floor(Math.min(S.gold, interestCap(S.wave)) * meta.mods.interest);
  if (interest > 0) {
    S.gold += interest;
    note(px(COLS / 2), py(ROWS - 1.2), '+' + interest + ' interest', '#ffd76b');
  }

  // Holding the wave is where nearly all Foundry income comes from.
  award(wavePoints(S.wave) * meta.mods.points);

  if (meta.mods.repair && S.wavesCleared % 8 === 0 && S.lives < S.maxLives) {
    S.lives++;
    note(px(COLS - 1.5), py(GOAL_R + .5), '+1 repair', '#7ddf8f');
  }

  meta.persist();
  S.phase = 'break';
  S.breakLeft = BREAK_SECONDS;
  touch();
}

/* Awards are fractional so a Swarm kill can be worth less than a whole
   point; the remainder is carried until it adds up to one. */
let scoreCarry = 0;

/** Points go straight into the Cores bank, so a refresh never loses them. */
function award(points) {
  if (points <= 0) return;
  scoreCarry += points;
  const whole = Math.floor(scoreCarry);
  if (whole <= 0) return;
  scoreCarry -= whole;
  S.score += whole;
  meta.addPoints(whole);
}

/* ── spawning and movement ────────────────────────────────────────────── */
function spawn(order) {
  const def = FOES[order.type];
  const hp = Math.round(def.hp * order.hpMul);
  const row = def.fly ? 0.8 + Math.random() * (ROWS - 1.6) : SPAWN_R + 0.5;
  S.foes.push({
    def, hp, max: hp,
    spd: def.spd * order.spdMul,
    x: -0.7, y: row,
    cc: SPAWN, to: null,
    off: { x: (Math.random() - 0.5) * 0.22, y: (Math.random() - 0.5) * 0.22 },
    slow: 0, slowLeft: 0,
    hit: 0, ph: Math.random() * 6.28,
    dead: false
  });
}

function aim(e) {
  if (e.cc === GOAL) { e.to = { x: COLS + 0.8, y: GOAL_R + 0.5, i: -2 }; return; }
  const next = field.flow[e.cc];
  if (next === -1 || next === undefined) { e.to = null; return; }
  e.to = { x: cx(next) + 0.5 + e.off.x, y: cy(next) + 0.5 + e.off.y, i: next };
}

function walk(e, dt) {
  const speed = e.spd * (1 - e.slow);

  if (e.def.fly) {
    const tx = COLS + 0.8, ty = GOAL_R + 0.5;
    const dx = tx - e.x, dy = ty - e.y;
    const d = Math.hypot(dx, dy) || 1;
    e.x += dx / d * speed * dt;
    e.y += dy / d * speed * dt;
    if (e.x > COLS + 0.5) breach(e);
    return;
  }

  let left = speed * dt, guard = 0;
  while (left > 0 && guard++ < 8) {
    if (!e.to) aim(e);
    if (!e.to) return;
    const dx = e.to.x - e.x, dy = e.to.y - e.y;
    const d = Math.hypot(dx, dy);
    if (d <= left) {
      e.x = e.to.x; e.y = e.to.y; left -= d;
      if (e.to.i === -2) { breach(e); return; }
      e.cc = e.to.i; e.to = null;
    } else {
      e.x += dx / d * left; e.y += dy / d * left; left = 0;
    }
  }
}

function breach(e) {
  e.dead = true;
  S.lives--;
  S.shake = 1;
  sfx.breach();
  note(px(COLS - 0.6), py(GOAL_R + 0.5), '−1', '#ff5f6d');
  if (S.lives <= 0) gameOver();
  touch();
}

/* ── damage ───────────────────────────────────────────────────────────── */
function hurt(e, dmg, pierce, colour, crit) {
  if (e.dead) return;
  const soak = Math.max(0, e.def.armor - (pierce || 0));
  e.hp -= dmg * (1 - soak);
  e.hit = crit ? 0.2 : 0.12;
  if (crit) note(px(e.x), py(e.y - 0.35), 'CRIT', '#ffe08a');
  if (e.hp > 0) return;

  e.dead = true;
  S.kills++;
  meta.noteKill();

  const gold = Math.round(e.def.gold * (1 + KILL_GOLD_GROWTH * S.wave) * meta.mods.killGold);
  S.gold += gold;
  note(px(e.x), py(e.y), '+' + gold, '#ffd76b');

  award(e.def.score * KILL_POINTS * meta.mods.points);

  const puff = e.def.boss ? 18 : 6;
  for (let k = 0; k < puff; k++) {
    S.motes.push({
      x: e.x, y: e.y,
      vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3,
      t: 0.45, c: colour || e.def.col
    });
  }

  if (e.def.boss) { sfx.boss(); S.shake = 0.7; }
  else if (Math.random() < 0.25) sfx.kill();
  touch();
}

function chill(e, amount, duration) {
  const resist = e.def.slowRes || 0;
  const effective = amount * (1 - resist);
  if (effective <= 0.001) return;
  // Refresh rather than stack: the strongest active slow wins.
  if (effective >= e.slow) { e.slow = effective; e.slowLeft = duration; }
  else e.slowLeft = Math.max(e.slowLeft, duration * 0.5);
}

/* ── tower stats with Foundry modifiers folded in ─────────────────────── */
export function statsOf(tower) {
  const def = TOWERS[tower.k];
  const lv = def.lv[tower.l];
  const m = meta.mods;
  const dmgMul = m.dmg[tower.k] || 1;

  return {
    range:   lv.range * m.range,
    dmg:     (lv.dmg || 0) * dmgMul,
    dps:     (lv.dps || 0) * dmgMul,
    rate:    (lv.rate || 0) * m.rate,
    pierce:  (lv.pierce || 0) + m.pierce,
    splash:  (lv.splash || 0) * (tower.k === 'rocket' ? m.splash : 1),
    ramp:    lv.ramp || 0,
    chains:  (lv.chains || 0) + (tower.k === 'tesla' ? m.chainBonus : 0),
    slow:    Math.min(0.85, (lv.slow || 0) * (1 + m.slowBonus)),
    slowDur: lv.slowDur || 0
  };
}

/** Highest level index this tower may reach right now. */
export function maxTier() {
  return meta.mods.maxTier;
}

/** Sustained damage per second, for the selection readout. */
export function dpsOf(tower) {
  const st = statsOf(tower);
  const def = TOWERS[tower.k];
  switch (def.kind) {
    case 'beam':  return Math.round(st.dps * meta.critAverage());
    case 'chain': return Math.round(st.dmg / st.rate * meta.critAverage());
    case 'aura':  return Math.round(st.dmg / st.rate);
    default:      return Math.round(st.dmg / st.rate * (1 + meta.mods.crit * (meta.mods.critMult - 1)));
  }
}

/* ── targeting ────────────────────────────────────────────────────────── */
/** Lower is closer to the exit, so the leader is always shot first. */
function progress(e) {
  if (e.def.fly) return Math.hypot(COLS - e.x, GOAL_R - e.y);
  const d = field.dist[e.cc];
  return d === -1 || d === undefined ? 999 : d;
}

function acquire(tower, def, range, hitsAir) {
  const tx = cx(tower.i) + 0.5, ty = cy(tower.i) + 0.5;
  let best = null, bestScore = Infinity;
  for (const e of S.foes) {
    if (e.dead || e.x < -0.2) continue;
    if (e.def.fly && !hitsAir) continue;
    if (Math.hypot(e.x - tx, e.y - ty) > range) continue;
    const s = progress(e);
    if (s < bestScore) { bestScore = s; best = e; }
  }
  return best;
}

/* ── per-tower behaviour ──────────────────────────────────────────────── */
function tickTower(t, dt) {
  const def = TOWERS[t.k];
  const st = statsOf(t);
  const tx = cx(t.i) + 0.5, ty = cy(t.i) + 0.5;
  const hitsAir = def.kind === 'aura' ? meta.mods.frostAir : def.air;

  if (def.kind === 'aura') {
    t.cd -= dt;
    t.ring = Math.max(0, (t.ring || 0) - dt * 3.2);
    if (t.cd > 0) return;

    let touched = 0;
    for (const e of S.foes) {
      if (e.dead || e.x < -0.2) continue;
      if (e.def.fly && !hitsAir) continue;
      if (Math.hypot(e.x - tx, e.y - ty) > st.range) continue;
      chill(e, st.slow, st.slowDur);
      hurt(e, st.dmg, st.pierce, def.color, false);
      touched++;
    }
    if (touched) { t.cd = st.rate; t.ring = 1; sfx.freeze(); }
    else t.cd = 0.2;
    return;
  }

  const target = acquire(t, def, st.range, hitsAir);
  if (target) t.ang = Math.atan2(target.y - ty, target.x - tx);

  if (def.kind === 'beam') {
    if (!target) { t.beam = null; t.lock = null; t.focus = 0; return; }
    t.beam = target;
    t.focus = t.lock === target ? Math.min(2.2, t.focus + dt) : 0;
    t.lock = target;
    const ramp = 1 + (t.focus / 2.2) * st.ramp;
    hurt(target, st.dps * ramp * meta.critAverage() * dt, st.pierce, def.color, false);
    return;
  }

  t.cd -= dt;
  if (!target || t.cd > 0) return;
  t.cd = st.rate;
  t.kick = 1;

  if (def.kind === 'chain') {
    fireChain(t, st, target, tx, ty);
    return;
  }

  S.shots.push({
    k: t.k, x: tx, y: ty, tgt: target,
    spd: t.k === 'gun' ? 15 : 7.5 * meta.mods.rocketSpeed,
    dmg: st.dmg, pierce: st.pierce, splash: st.splash,
    crit: meta.rollCrit(), col: def.color, life: 2.2
  });
  if (t.k === 'rocket') sfx.rocket();
}

function fireChain(t, st, first, tx, ty) {
  const crit = meta.rollCrit();
  const mult = crit ? meta.mods.critMult : 1;
  const points = [{ x: tx, y: ty }];
  const seen = new Set();

  let current = first;
  let damage = st.dmg * mult;

  for (let jump = 0; jump < st.chains && current; jump++) {
    seen.add(current);
    points.push({ x: current.x, y: current.y });
    hurt(current, damage, st.pierce, TOWERS.tesla.color, crit && jump === 0);
    damage *= CHAIN_FALLOFF;

    let next = null, bestD = CHAIN_REACH;
    for (const e of S.foes) {
      if (e.dead || seen.has(e) || e.x < -0.2) continue;
      const d = Math.hypot(e.x - current.x, e.y - current.y);
      if (d < bestD) { bestD = d; next = e; }
    }
    current = next;
  }

  if (points.length > 1) S.arcs.push({ points, t: 0.14 });
  sfx.arc();
}

function tickShot(s, dt) {
  const target = s.tgt;
  const alive = target && !target.dead;
  // A shot whose target died flies on to where it was last headed.
  const gx = alive ? target.x : (s.gx ?? (s.gx = s.x + Math.cos(s.a || 0) * 3));
  const gy = alive ? target.y : (s.gy ?? (s.gy = s.y));

  const dx = gx - s.x, dy = gy - s.y;
  const d = Math.hypot(dx, dy) || 1;
  s.a = Math.atan2(dy, dx);
  s.life -= dt;

  const step = s.spd * dt;
  if (d > step && s.life > 0) {
    s.x += dx / d * step;
    s.y += dy / d * step;
    return true;
  }

  const mult = s.crit ? meta.mods.critMult : 1;
  if (s.splash) {
    S.blasts.push({ x: s.x, y: s.y, r: s.splash, t: 0.3, col: s.col });
    for (const e of S.foes) {
      if (e.dead || e.def.fly) continue;
      const dd = Math.hypot(e.x - s.x, e.y - s.y);
      if (dd <= s.splash) {
        hurt(e, s.dmg * mult * (1 - 0.45 * (dd / s.splash)), s.pierce, s.col, s.crit);
      }
    }
    sfx.blast();
  } else if (alive) {
    hurt(target, s.dmg * mult, s.pierce, s.col, s.crit);
  }
  return false;
}

/* ── build, sell, convert, upgrade ────────────────────────────────────────
   Refunds are always 100% of what a tower actually cost, upgrades included,
   so moving or re-rolling a turret is only ever a placement decision. The
   price of a *new* turret is what carries the cost: each one of a kind
   already standing makes the next of that kind dearer.                   */

/** How many towers of this kind are on the grid right now. */
function countOf(key) {
  let n = 0;
  for (const t of field.grid) if (t && t.k === key) n++;
  return n;
}

/** Price of the next tower of `key`, with escalation and Requisition. */
export function buildCost(key) {
  const raw = TOWERS[key].cost * Math.pow(BUILD_ESCALATION, countOf(key)) * meta.mods.buildCost;
  return Math.max(5, Math.round(raw / 5) * 5);
}

/** Everything a tower gives back when sold - always the full amount. */
export function refundOf(t) {
  return t ? t.spent : 0;
}

function makeTower(i, key, cost) {
  return {
    i, k: key, l: 0, cd: 0, ang: -0.4, kick: 0,
    spent: cost, focus: 0, lock: null, beam: null, ring: 0
  };
}

export function place(i, key) {
  if (!meta.towerUnlocked(key)) { deny('Locked - unlock it in the Foundry'); return false; }
  const cost = buildCost(key);
  if (S.gold < cost) { deny('Not enough gold'); return false; }

  const solution = legal(i, S.foes);
  if (!solution) { deny('That would seal the exit'); return false; }

  S.gold -= cost;
  field.grid[i] = makeTower(i, key, cost);
  commit(solution);
  // Anything walking into the new cell needs a fresh target.
  for (const e of S.foes) if (!e.def.fly && e.to && field.grid[e.to.i]) e.to = null;

  sfx.place();
  S.selected = null;
  recorder.note({ op: 'place', i, k: key });
  touch();
  return true;
}

/**
 * Net gold to turn `t` into a `key` tower: the new build price minus the
 * full refund on what is there now. Negative means the swap pays you.
 */
export function convertCost(t, key) {
  return buildCost(key) - refundOf(t);
}

/**
 * Replace a tower with a different kind in place. The cell stays occupied,
 * so the flow field never changes and no route can be sealed by a swap.
 * The replacement starts at level 1 - you are buying a new turret, not
 * carrying the old one's upgrades across.
 */
export function convert(t, key) {
  if (!t || field.grid[t.i] !== t) return false;
  if (t.k === key) return false;
  if (!meta.towerUnlocked(key)) { deny('Locked - unlock it in the Foundry'); return false; }

  const cost = buildCost(key);
  const net = cost - refundOf(t);
  if (net > S.gold) { deny('Not enough gold'); return false; }

  S.gold -= net;
  const fresh = makeTower(t.i, key, cost);
  field.grid[t.i] = fresh;
  S.selected = fresh;

  if (net < 0) note(px(cx(t.i) + 0.5), py(cy(t.i) + 0.5), '+' + (-net), '#ffd76b');
  sfx.place();
  recorder.note({ op: 'swap', i: t.i, k: key });
  touch();
  return true;
}

export function sell(t) {
  if (!t || field.grid[t.i] !== t) return;
  const back = refundOf(t);
  S.gold += back;
  note(px(cx(t.i) + 0.5), py(cy(t.i) + 0.5), '+' + back, '#ffd76b');
  field.grid[t.i] = null;
  commit(solve());
  for (const e of S.foes) e.to = null;
  S.selected = null;
  sfx.sell();
  recorder.note({ op: 'sell', i: t.i, k: t.k });
  touch();
}

export function upgradeCost(t) {
  const def = TOWERS[t.k];
  if (t.l >= Math.min(def.lv.length - 1, maxTier())) return null;
  return def.lv[t.l + 1].up;
}

export function upgrade(t) {
  const cost = upgradeCost(t);
  if (cost == null) return;
  if (S.gold < cost) { deny('Not enough gold'); return; }
  S.gold -= cost;
  t.spent += cost;
  t.l++;
  sfx.upgrade();
  recorder.note({ op: 'up', i: t.i, k: t.k, l: t.l });
  touch();
}

export function clearGrid() {
  let back = 0;
  for (let i = 0; i < field.grid.length; i++) {
    const t = field.grid[i];
    if (!t) continue;
    back += refundOf(t);
    field.grid[i] = null;
  }
  S.gold += back;
  commit(solve());
  for (const e of S.foes) e.to = null;
  S.selected = null;
  sfx.sell();
  recorder.note({ op: 'clear' });
  touch();
}

/* ── game speed ───────────────────────────────────────────────────────── */
/** The steps the speed button cycles through, in order. */
export function speedLadder() {
  const steps = [...meta.mods.speeds];
  if (S.dev) steps.push(DEV_SPEED);
  return steps;
}

/** Advance to the next step, wrapping back to 1×. */
export function cycleSpeed() {
  const steps = speedLadder();
  const at = steps.indexOf(S.speed);
  S.speed = steps[(at + 1) % steps.length];
  touch();
}

/* ── helpers shared with the renderer ─────────────────────────────────── */
export function deny(text) {
  S.warn = 1.1;
  S.warnText = text;
  sfx.deny();
}

function note(x, y, text, colour) {
  S.notes.push({ x, y, s: text, c: colour, t: 0.9 });
}

// Grid-to-pixel mapping lives in the renderer; these are patched in at boot
// so the simulation can place floating notes without importing it.
let px = u => u, py = u => u;
export function bindProjection(toX, toY) { px = toX; py = toY; }

/* ── frame ────────────────────────────────────────────────────────────── */
export function update(dt) {
  if (S.paused || S.phase === 'dead' || S.phase === 'menu') return;

  S.shake = Math.max(0, S.shake - dt * 2.5);
  S.waveFlash = Math.max(0, S.waveFlash - dt);
  S.warn = Math.max(0, S.warn - dt);

  // A replaying blueprint builds through the same entry points the player's
  // clicks go through, so everything the autopilot does is recorded too.
  recorder.tick(dt);

  if (S.phase === 'run') {
    for (let n = S.queue.length - 1; n >= 0; n--) {
      S.queue[n].at -= dt;
      if (S.queue[n].at <= 0) { spawn(S.queue[n]); S.queue.splice(n, 1); }
    }
    if (!S.queue.length && !S.foes.length) endWave();
  } else if (S.phase === 'break') {
    S.breakLeft -= dt;
    if (S.breakLeft <= 0) startWave();
    else touch();
  }

  for (const e of S.foes) {
    if (e.dead) continue;
    walk(e, dt);
    e.hit = Math.max(0, e.hit - dt);
    e.ph += dt * 9;
    if (e.slowLeft > 0) {
      e.slowLeft -= dt;
      if (e.slowLeft <= 0) e.slow = 0;
    }
  }

  for (const t of field.grid) {
    if (!t) continue;
    tickTower(t, dt);
    t.kick = Math.max(0, t.kick - dt * 7);
  }

  S.shots = S.shots.filter(s => tickShot(s, dt));

  for (const b of S.blasts) b.t -= dt;
  S.blasts = S.blasts.filter(b => b.t > 0);

  for (const a of S.arcs) a.t -= dt;
  S.arcs = S.arcs.filter(a => a.t > 0);

  for (const m of S.motes) {
    m.x += m.vx * dt; m.y += m.vy * dt;
    m.vx *= 0.93; m.vy *= 0.93; m.t -= dt;
  }
  S.motes = S.motes.filter(m => m.t > 0);

  for (const n of S.notes) { n.y -= 26 * dt; n.t -= dt; }
  S.notes = S.notes.filter(n => n.t > 0);

  S.foes = S.foes.filter(e => !e.dead);
}

/* ── the recorder's view of the simulation ───────────────────────────────
   Handed over once, at load. recorder.js never imports this module back, so
   the dependency arrow still only points one way.                        */
recorder.bindGame({
  S, place, convert, upgrade, sell, clearGrid,
  buildCost, convertCost, upgradeCost
});
