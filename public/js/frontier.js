/* ══ Frontier simulation ═════════════════════════════════════════════════
   The second mode: a small real-time war on a seeded terrain map. It
   shares the run-wide state object `S` with Holdout - gold, score, speed,
   pause, floating notes - so the side console, the Foundry and the menus
   work unchanged. Everything that is Frontier's own lives on `F`.

   Two sides play by the same rules (side 0 is you, side 1 the enemy):
     - a Commander walks the map, builds whatever is ordered within its
       reach, repairs, and fights; you steer yours with the thumb stick
     - Factories (3x3) turn gold into units, one build sequence on repeat
       (say trooper, trooper, breaker); Helpers built beside a Factory
       speed it up, and an upgrade makes it turn out a stronger tier
     - towers are Holdout's towers, built by the Commander, shooting units
     - income is a steady trickle that grows with the clock, plus salvage
       for everything you destroy
     - a side is beaten when its Commander and every one of its buildings
       are gone: annihilation is the only way to win

   Units march along flow fields towards the other side's buildings. The
   fields are rebuilt only when a building appears or falls (never because
   something moved), and a unit keeps the target it picked until that
   target dies or slips out of reach, so columns hold their line instead of
   twitching between routes every second.

   Holdout's tower maths (statsOf, levels, costs) is reused as is, so a
   Frontier Gun is exactly a Holdout Gun. Positions are in cells.       */

import {
  TOWERS, CHAIN_REACH, CHAIN_FALLOFF, levelUpCost, levelStats, BUILD_ESCALATION,
  MAP_W, MAP_H, HIGH_GROUND_RANGE, BUILD_REACH, SITE_CAP,
  START_GOLD, INCOME_BASE, INCOME_PER_MIN, SALVAGE, COMMANDER, FAB, HELPER,
  FAB_ESCALATION, HELPER_BOOST, FAB_SPACING, TOWER_BT, TOWER_HP, TOWER_HP_LEVEL,
  fabUpCost, fabUpTime, SEQ_MAX, UNIT_CAP, UNITS, unitPower, unitCost, unitTime,
  aiIncome, aiKit, aiStartTier, sectorBounty, killPoints, GROUPS
} from './config.js';
import { generate, sectorSeed, flowField, rng, at, colOf, rowOf } from './terrain.js';
import { S, statsOf, maxTier } from './game.js';
import * as meta from './meta.js';
import * as recorder from './recorder.js';
import { sfx } from './audio.js';

/** Extra route cost per enemy tower covering a cell, for raiders. */
const DANGER_COST = 1.4;
/** Own towers can be walked past, at a small detour cost. */
const OWN_TOWER_COST = 3;
/** How far past its weapon range a unit notices, and turns to fight. */
const AGGRO = 1.6;
/** Seconds between flow-field rebuilds, however often buildings change. */
const FLOW_MIN_GAP = 0.5;
/** An enemy Commander must move this far before the chase route follows. */
const CHASE_SLACK = 4;
/** Units closer than this to a friend are nudged apart. */
const PERSONAL_SPACE = 0.42;

export const F = {
  sector: 1,
  map: null,
  /** Seconds since the sortie opened (game time). */
  time: 0,
  /** cell -> the building or construction site on it, or null */
  grid: [],
  /** Every building and construction site, both sides. */
  structs: [],
  /** Every unit in the field, both sides. */
  units: [],
  /** The two Commanders: [yours, theirs]. */
  cmd: [null, null],
  /** Every projectile in flight, both sides. */
  shots: [],
  /** Wrecks left where things fell, for a moment. */
  wrecks: [],
  /** Route fields per side: [side] = { bold, cautious }. */
  flow: [{}, {}],
  /** Bumped on every rebuild, so walkers know to re-aim. */
  flowRev: 0,
  /** The enemy: its purse and its build plan. */
  ai: null,
  /** Unit and building power multipliers per side. */
  kit: [1, 1],
  /** Your stick (thumb or WASD): a vector of length <= 1. */
  stick: { x: 0, y: 0 },
  keys: { x: 0, y: 0 },
  /** Camera follows your Commander while this is on. */
  follow: true,
  /** 'won' | 'lost' once the sortie is over. */
  result: null,
  /** Cores the win paid, for the summary screen. */
  bounty: 0
};

const touch = () => S.onChange();
const bump = (bag, key, by = 1) => { bag[key] = (bag[key] || 0) + by; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
let nextId = 1;
let flowDirty = true, flowWait = 0;
let carry = [0, 0];
let scoreCarry = 0;
let persistClock = 0;
const chase = [-1, -1];

/* ── lifecycle ────────────────────────────────────────────────────────── */
export function newSortie(sector = 1) {
  S.mode = 'frontier';
  recorder.stopPlayback();

  F.sector = sector;
  F.map = generate(sectorSeed(sector));
  F.time = 0;
  F.grid = new Array(MAP_W * MAP_H).fill(null);
  F.structs = [];
  F.units = [];
  F.shots = [];
  F.wrecks = [];
  F.flow = [{}, {}];
  F.result = null;
  F.bounty = 0;
  F.follow = true;
  F.stick = { x: 0, y: 0 };
  F.keys = { x: 0, y: 0 };
  F.kit = [1, aiKit(sector)];
  F.rand = rng(F.map.seed ^ 0x2545f491);

  const m = F.map;
  F.cmd = [commander(0, m.hq), commander(1, m.enemy)];
  const home = F.cmd[0], away = F.cmd[1];
  const d = Math.hypot(home.x - away.x, home.y - away.y) || 1;
  F.ai = {
    gold: START_GOLD + 240,
    step: 0, think: 1.5, seqs: 0,
    start: { x: away.x, y: away.y },
    dir: { x: (home.x - away.x) / d, y: (home.y - away.y) / d },
    route: null
  };

  S.gold = meta.mods.startGold + START_GOLD;
  S.score = 0;
  S.maxLives = home.max;
  S.lives = home.hp;
  S.wave = 0;
  S.kills = 0;
  S.wavesCleared = 0;
  S.minted = 0;
  S.skipped = 0;
  S.heldPoints = 0;
  // Frontier has no waves: the war simply runs.
  S.phase = 'run';
  S.queue = [];
  S.nextWave = [];
  S.breakLeft = 0;
  S.speed = 1;
  S.paused = false;
  S.suspended = false;
  S.foes = []; S.shots = []; S.blasts = []; S.arcs = []; S.warps = []; S.motes = []; S.notes = [];
  S.picked = null; S.selected = null; S.hover = -1;
  S.shake = 0; S.waveFlash = 0; S.warn = 0;
  S.tally = {
    dmg: {}, towerKills: {}, kills: {}, leaks: {}, warps: 0, headKills: 0,
    // Frontier: the war report.
    built: {}, lost: {}, killed: {}, unitKills: 0, razed: 0, structsLost: 0, spentUnits: 0
  };
  carry = [0, 0];
  armyCount = [0, 0];
  scoreCarry = 0;
  persistClock = 0;
  chase[0] = chase[1] = -1;
  flowDirty = true;
  flowWait = 0;
  refreshFlow();
  touch();
}

function commander(side, cell) {
  const hp = Math.round(COMMANDER.hp * (side ? F.kit[1] : meta.mods.cmdHp));
  return {
    kind: 'cmd', side, x: cell.x + 0.5, y: cell.y + 0.5, cc: at(cell.x, cell.y),
    hp, max: hp, hit: 0, calm: 0, ang: side ? Math.PI : 0, aim: side ? Math.PI : 0,
    cd: 0, kick: 0, tgt: null, scan: 0, beam: null, walk: 0, dead: false
  };
}

function gameOver(won) {
  if (F.result) return;
  F.result = won ? 'won' : 'lost';
  S.phase = 'dead';
  S.paused = false;
  S.wavesCleared = Math.floor(F.time / 60);
  if (won) {
    F.bounty = Math.round(sectorBounty(F.sector) * meta.mods.points);
    award(F.bounty);
    const c = F.cmd[0];
    note(c.x, c.y - 1.2, `+${F.bounty} sector bounty`, '#7ddf8f', 2.4);
    // Whatever the enemy still had in the field breaks and scatters.
    for (const u of F.units) if (u.side === 1 && !u.dead) { u.dead = true; puff(u.x, u.y, 5, u.def.ecol); }
    sfx.boss();
  }
  meta.noteFrontierEnd(F.sector, won, S.wavesCleared);
  meta.persistNow();
  touch();
}

/** Walking away from a sortie still counts it. */
export function leave() {
  if (S.mode !== 'frontier' || F.result) return;
  meta.noteFrontierEnd(F.sector, false, Math.floor(F.time / 60));
}

/** No waves in Frontier: the wave button follows your Commander instead. */
export function startWave() {
  F.follow = true;
  touch();
}

/* ── money ────────────────────────────────────────────────────────────── */
export const funds = side => (side ? F.ai.gold : S.gold);
function earn(side, n) {
  if (side) F.ai.gold += n;
  else S.gold += n;
}
function spend(side, n) {
  if (funds(side) < n) return false;
  earn(side, -n);
  return true;
}

/** Gold per second for a side right now. */
export function income(side) {
  const base = INCOME_BASE + INCOME_PER_MIN * F.time / 60;
  return side ? base * aiIncome(F.sector) : base;
}

function payIncome(dt) {
  for (const side of [0, 1]) {
    carry[side] += income(side) * dt;
    const whole = Math.floor(carry[side]);
    if (whole > 0) { carry[side] -= whole; earn(side, whole); }
  }
}

function award(points) {
  if (points <= 0) return;
  scoreCarry += points;
  const whole = Math.floor(scoreCarry);
  if (whole <= 0) return;
  scoreCarry -= whole;
  S.score += whole;
  meta.addPoints(whole);
}

/* ── footprints and placement ─────────────────────────────────────────── */
const inside = (x, y) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;

/** Cells a building of `key` would cover with its anchor on cell i. */
function footprint(key, i) {
  if (key !== 'fab') return [i];
  const out = [];
  const x0 = colOf(i), y0 = rowOf(i);
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      if (!inside(x0 + x, y0 + y)) return null;
      out.push(at(x0 + x, y0 + y));
    }
  }
  return out;
}

/** The twelve Helper cells along a Factory's sides (corners left out). */
export function ringOf(f) {
  const out = [];
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== 2 || (Math.abs(x) === 2 && Math.abs(y) === 2)) continue;
      if (inside(f.cx + x, f.cy + y)) out.push(at(f.cx + x, f.cy + y));
    }
  }
  return out;
}

/** The Factory whose ring holds cell i, for side `side`, or null. */
function ringOwner(side, i) {
  const x = colOf(i), y = rowOf(i);
  for (const f of F.structs) {
    if (f.side !== side || f.type !== 'fab' || f.dead) continue;
    const dx = Math.abs(x - f.cx), dy = Math.abs(y - f.cy);
    if (Math.max(dx, dy) === 2 && !(dx === 2 && dy === 2)) return f;
  }
  return null;
}

const countOf = (side, key) => F.structs.reduce((n, s) => n + (s.side === side && s.k === key && !s.dead ? 1 : 0), 0);

/** What a building costs `side` right now. */
export function priceOf(side, key) {
  if (key === 'fab') return Math.round(FAB.cost * Math.pow(FAB_ESCALATION, countOf(side, 'fab')) / 5) * 5;
  if (key === 'helper') return HELPER.cost;
  const raw = TOWERS[key].cost * Math.pow(BUILD_ESCALATION, countOf(side, key)) * (side ? 1 : meta.mods.buildCost);
  return Math.max(5, Math.round(raw / 5) * 5);
}
export const buildCost = key => priceOf(0, key);

/** Why `side` cannot order `key` on cell i, or '' when it can. */
export function whyNotFor(side, key, i) {
  if (i < 0 || !F.map || !key) return 'Off the map';
  const c = F.cmd[side];
  if (!c || c.dead) return 'Your Commander has fallen';
  const cells = footprint(key, i);
  if (!cells) return 'Too close to the edge';
  const h = F.map.height;
  if (cells.some(j => h[j] < 0)) return 'Cannot build on water';
  if (key === 'fab' && cells.some(j => h[j] !== h[i])) return 'A Factory needs flat ground';
  if (cells.some(j => F.grid[j])) return 'Already built on';
  if (key === 'fab') {
    const x = colOf(i), y = rowOf(i);
    const crowd = F.structs.some(s => s.type === 'fab' && !s.dead && Math.max(Math.abs(s.cx - x), Math.abs(s.cy - y)) < FAB_SPACING);
    if (crowd) return 'Too close to another Factory';
  }
  if (key === 'helper' && !ringOwner(side, i)) return 'Helpers go beside one of your Factories';
  if (key !== 'fab' && key !== 'helper' && !TOWERS[key]) return 'Unknown building';
  if (sitesOf(side).length >= SITE_CAP) return 'Too many orders waiting';
  return '';
}

export const whyNot = (i, key = S.picked) => whyNotFor(0, key, i);
export const canBuild = (i, key = S.picked) => !whyNot(i, key);

export const sitesOf = side => F.structs.filter(s => s.side === side && !s.done && !s.dead);

function maxHp(s) {
  const kit = s.side ? F.kit[1] : 1;
  if (s.type === 'fab') return Math.round(FAB.hp * kit * (1 + 0.3 * (s.tier - 1)));
  if (s.type === 'helper') return Math.round(HELPER.hp * kit);
  return Math.round(TOWER_HP[s.k] * Math.pow(TOWER_HP_LEVEL, s.l) * (s.side ? kit : meta.mods.towerHp));
}

/** Re-derive max health, keeping the same share of it. */
function refit(s) {
  const frac = s.max ? s.hp / s.max : 1;
  s.max = maxHp(s);
  s.hp = Math.max(1, s.max * frac);
}

/** Place a construction order. Gold is paid now; the Commander builds it. */
function order(side, key, i) {
  const why = whyNotFor(side, key, i);
  if (why) { if (!side) deny(why); return null; }
  const cost = priceOf(side, key);
  if (!spend(side, cost)) { if (!side) deny('Not enough gold'); return null; }

  const cells = footprint(key, i);
  const type = key === 'fab' ? 'fab' : key === 'helper' ? 'helper' : 'tower';
  const s = {
    kind: 'struct', id: nextId++, side, type, k: key, i, cells,
    cx: colOf(i), cy: rowOf(i), x: colOf(i) + 0.5, y: rowOf(i) + 0.5,
    half: type === 'fab' ? 1.5 : 0.5,
    elev: Math.max(0, F.map.height[i]),
    hp: 0, max: 0, hit: 0, done: false, prog: 0, spent: cost, dead: false,
    bt: type === 'fab' ? FAB.bt : type === 'helper' ? HELPER.bt : Math.max(1.2, TOWERS[key].cost * TOWER_BT),
    // towers
    l: 0, cd: 0, ang: side ? Math.PI : 0, kick: 0, focus: 0, lock: null, beam: null, ring: 0, spin: 0, store: 0,
    // factories
    tier: type === 'fab' && side ? aiStartTier(F.sector) : 1,
    seq: [], at: 0, job: null, up: null, paused: false, stall: false, group: 1, held: [],
    // helpers
    fab: type === 'helper' ? ringOwner(side, i) : null
  };
  s.max = maxHp(s);
  s.hp = s.max * 0.1;
  for (const c of cells) F.grid[c] = s;
  F.structs.push(s);
  flowDirty = true;
  if (!side) sfx.place();
  touch();
  return s;
}

/** Your build order: the stick walks the Commander over to it. */
export function place(i, key) {
  const s = order(0, key, i);
  if (s) S.selected = null;
  return !!s;
}

function finish(s) {
  s.done = true;
  s.prog = 1;
  s.hp = Math.min(s.max, s.hp);
  if (s.type === 'fab') {
    s.seq = s.side ? aiSequence() : ['trooper'];
    s.at = 0;
  }
  flowDirty = true;
  if (!s.side) {
    sfx.upgrade();
    note(s.x, s.y - s.half - 0.2, `${nameOf(s)} ready`, '#7ddf8f');
  }
  touch();
}

export function nameOf(s) {
  if (s.kind === 'cmd') return 'Commander';
  if (s.type === 'fab') return FAB.name;
  if (s.type === 'helper') return HELPER.name;
  return TOWERS[s.k].name;
}

/** Take a building off the map. */
function remove(s) {
  if (s.dead) return;
  s.dead = true;
  for (const c of s.cells) if (F.grid[c] === s) F.grid[c] = null;
  F.structs.splice(F.structs.indexOf(s), 1);
  if (s.type === 'fab') {
    for (const h of F.structs) if (h.fab === s) h.fab = null;
    muster(s, true);
  }
  if (S.selected === s) S.selected = null;
  flowDirty = true;
}

/** Recycle one of yours: everything paid comes back, site or building. */
export function recycle(s) {
  if (!s || s.dead || s.side !== 0) return;
  const back = refundOf(s);
  S.gold += back;
  note(s.x, s.y, '+' + back, '#ffd76b');
  remove(s);
  sfx.sell();
  touch();
}
export const sell = recycle;
export const refundOf = s => (s ? Math.round(s.spent) : 0);

/* ── towers: the Holdout interface the side panel uses ────────────────── */
/** A finished tower of yours - the only thing the tower panel handles. */
export const alive = t => !!t && t.kind === 'struct' && !t.dead && t.type === 'tower' && t.done && t.side === 0;
export const allTowers = () => F.structs.filter(s => s.type === 'tower' && s.side === 0);

export function upgradeCost(t) {
  if (!alive(t) || t.l >= maxTier()) return null;
  return levelUpCost(TOWERS[t.k], t.l + 1);
}

export function upgrade(t) {
  const cost = upgradeCost(t);
  if (cost == null) return;
  if (S.gold < cost) { deny('Not enough gold'); return; }
  S.gold -= cost;
  t.spent += cost;
  t.l++;
  refit(t);
  sfx.upgrade();
  touch();
}

export const convertCost = (t, key) => buildCost(key) - refundOf(t);

/** Swap a tower for another kind on the spot; damage carries over. */
export function convert(t, key) {
  if (!alive(t) || t.k === key) return false;
  if (!meta.towerUnlocked(key)) { deny('Locked - unlock it in the Foundry'); return false; }
  const cost = buildCost(key);
  const net = cost - refundOf(t);
  if (net > S.gold) { deny('Not enough gold'); return false; }
  S.gold -= net;
  Object.assign(t, { k: key, l: 0, spent: cost, cd: 0, focus: 0, lock: null, beam: null, ring: 0 });
  refit(t);
  if (net < 0) note(t.x, t.y, '+' + (-net), '#ffd76b');
  flowDirty = true;
  sfx.place();
  touch();
  return true;
}

/** Tower stats: yours carry the Foundry; theirs carry the sector's kit. */
function towerStats(t) {
  if (!t.side) return statsOf(t);
  const lv = levelStats(TOWERS[t.k], t.l);
  const kit = F.kit[1];
  return {
    range: lv.range || 0, dmg: (lv.dmg || 0) * kit, dps: (lv.dps || 0) * kit, rate: lv.rate || 0,
    pierce: lv.pierce || 0, splash: lv.splash || 0, ramp: lv.ramp || 0, chains: lv.chains || 0,
    slow: lv.slow || 0, slowDur: lv.slowDur || 0, yield: 0
  };
}

/** Range with the high-ground bonus folded in. */
export function rangeOf(t) {
  return towerStats(t).range * (1 + HIGH_GROUND_RANGE * (t.elev || 0));
}

/* ── factories ────────────────────────────────────────────────────────── */
/** Finished Helpers feeding a Factory. */
export const helpersOf = f => F.structs.filter(h => h.fab === f && h.done && !h.dead).length;
/** Build speed multiplier a Factory runs at. */
export const fabSpeed = f => 1 + HELPER_BOOST * helpersOf(f);
export const fabUpgradeCost = f => fabUpCost(f.tier);
export const unitPrice = (key, tier = 1) => unitCost(key, tier);
export const unitSeconds = (key, tier = 1) => unitTime(key, tier);

const mine = f => !!f && f.kind === 'struct' && f.type === 'fab' && f.side === 0 && !f.dead;

export function seqAdd(f, key) {
  if (!mine(f) || !UNITS[key]) return;
  if (f.seq.length >= SEQ_MAX) { deny(`At most ${SEQ_MAX} steps`); return; }
  f.seq.push(key);
  touch();
}

export function seqRemove(f, n) {
  if (!mine(f) || n < 0 || n >= f.seq.length) return;
  f.seq.splice(n, 1);
  // The unit being built is no longer this step: finishing it must not
  // skip the step that slid into its place.
  if (f.at === n && f.job) f.job.detached = true;
  if (f.at > n) f.at--;
  if (f.at >= f.seq.length) f.at = 0;
  touch();
}

export function seqClear(f) {
  if (!mine(f)) return;
  f.seq = [];
  f.at = 0;
  if (f.job) f.job.detached = true;
  touch();
}

/** How many units a Factory holds at its door before they march together. */
export function setGroup(f, n) {
  if (!mine(f) || !GROUPS.includes(n)) return;
  f.group = n;
  muster(f);
  touch();
}

/** Send a Factory's waiting group on its way once it is big enough. */
function muster(f, force = false) {
  f.held = f.held.filter(u => !u.dead);
  if (!force && f.held.length < f.group) return;
  for (const u of f.held) u.hold = null;
  f.held = [];
}

export function togglePause(f) {
  if (!mine(f)) return;
  f.paused = !f.paused;
  touch();
}

function startUpgrade(f) {
  if (!f.done || f.up) return false;
  const cost = fabUpCost(f.tier);
  if (!spend(f.side, cost)) return false;
  f.spent += cost;
  f.up = { t: 0, need: fabUpTime(f.tier) };
  return true;
}

export function upgradeFab(f) {
  if (!mine(f) || !f.done || f.up) return;
  if (!startUpgrade(f)) { deny('Not enough gold'); return; }
  sfx.upgrade();
  touch();
}

function tickFab(f, dt) {
  const speed = fabSpeed(f);
  f.spin = (f.spin + dt * (f.job || f.up ? 2.4 : 0.25)) % 6.284;
  if (f.up) {
    f.up.t += dt * speed;
    if (f.up.t < f.up.need) return;
    f.up = null;
    f.tier++;
    refit(f);
    if (!f.side) { note(f.x, f.y - 2, `Factory tier ${f.tier}`, '#7ddf8f', 1.6); sfx.upgrade(); }
    touch();
    return;
  }
  if (!f.job) {
    if (f.paused || !f.seq.length) { f.stall = false; return; }
    if (armySize(f.side) >= UNIT_CAP) { f.stall = true; return; }
    f.at %= f.seq.length;
    const key = f.seq[f.at];
    const cost = unitCost(key, f.tier);
    // The enemy keeps back what its Commander needs for the next building.
    const keep = f.side ? aiReserve() : 0;
    if (funds(f.side) - keep < cost || !spend(f.side, cost)) { f.stall = true; return; }
    f.stall = false;
    f.job = { k: key, t: 0, need: unitTime(key, f.tier), cost };
    if (!f.side) S.tally.spentUnits += cost;
  }
  f.job.t += dt * speed;
  if (f.job.t < f.job.need) return;
  spawnUnit(f, f.job.k);
  if (!f.job.detached) f.at = (f.at + 1) % Math.max(1, f.seq.length);
  f.job = null;
}

let armyCount = [0, 0];
export const armySize = side => armyCount[side];

function spawnUnit(f, key) {
  const def = UNITS[key];
  const side = f.side;
  const power = unitPower(f.tier) * (side ? F.kit[1] : 1);
  const hp = Math.round(def.hp * power * (side ? 1 : meta.mods.unitHp));
  const plan = def.role === 'raider' ? 'cautious' : 'bold';
  let x = f.x, y = f.y, cc = f.i;
  if (!def.fly) {
    // Step out on the ring cell nearest the enemy, clear of anything solid.
    const flow = F.flow[side][plan];
    let best = -1, bd = Infinity;
    for (const c of ringAll(f)) {
      if (F.map.height[c] < 0 || solid(c)) continue;
      const d = flow && flow.dist ? flow.dist[c] : 0;
      if (d < bd) { bd = d; best = c; }
    }
    if (best < 0) return;
    x = colOf(best) + 0.5; y = rowOf(best) + 0.5; cc = best;
  }
  const u = {
    kind: 'unit', side, k: key, def, tier: f.tier, plan,
    hp, max: hp, dmg: def.dmg * power * (side ? 1 : meta.mods.unitDmg),
    x: x + (F.rand() - 0.5) * 0.3, y: y + (F.rand() - 0.5) * 0.3, cc,
    to: null, rev: -1, tgt: null, goal: null, scan: F.rand() * 0.3,
    cd: F.rand() * def.rate, ang: side ? Math.PI : 0, kick: 0, hit: 0, slow: 0, slowLeft: 0,
    off: { x: (F.rand() - 0.5) * 0.5, y: (F.rand() - 0.5) * 0.5 },
    home: { x, y, cc }, hold: f.group > 1 ? f : null, born: F.time, dead: false
  };
  F.units.push(u);
  if (u.hold) { f.held.push(u); muster(f); }
  armyCount[side]++;
  if (!side) bump(S.tally.built, key);
}

/** All sixteen cells around a Factory, corners included - its doors. */
function ringAll(f) {
  const out = [];
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== 2 || !inside(f.cx + x, f.cy + y)) continue;
      out.push(at(f.cx + x, f.cy + y));
    }
  }
  return out;
}

/* ── routes ───────────────────────────────────────────────────────────────
   Per side, two flow fields lead to the other side's buildings:
     bold     - the short road, through the enemy's fields of fire
     cautious - around enemy towers' coverage when another road exists
   With no buildings left to aim at, they lead to the enemy Commander, and
   only follow it once it has moved CHASE_SLACK cells. Factories are solid
   to everyone; Helpers and towers are not.                             */
const solid = i => { const s = F.grid[i]; return !!s && s.type === 'fab'; };

function dangerOf(side) {
  const danger = new Float32Array(MAP_W * MAP_H);
  for (const t of F.structs) {
    if (t.side !== side || t.type !== 'tower' || !t.done) continue;
    const kind = TOWERS[t.k].kind;
    if (kind === 'factory' || kind === 'portal') continue;
    const r = rangeOf(t), r2 = Math.ceil(r);
    for (let y = -r2; y <= r2; y++) {
      for (let x = -r2; x <= r2; x++) {
        const cx = t.cx + x, cy = t.cy + y;
        if (inside(cx, cy) && Math.hypot(x, y) <= r) danger[at(cx, cy)] += 1;
      }
    }
  }
  return danger;
}

function refreshFlow() {
  const m = F.map;
  for (const side of [0, 1]) {
    const foe = 1 - side;
    const goal = new Set();
    for (const s of F.structs) if (s.side === foe && !s.dead) for (const c of s.cells) goal.add(c);
    if (!goal.size) {
      const c = F.cmd[foe];
      if (c && !c.dead) { chase[side] = c.cc; goal.add(c.cc); }
    } else chase[side] = -1;
    const sources = [...goal];
    const extra = i => {
      const s = F.grid[i];
      if (!s) return 0;
      if (s.side === side) return s.type === 'fab' ? Infinity : s.type === 'tower' ? OWN_TOWER_COST : 0;
      return 0;
    };
    const danger = dangerOf(foe);
    F.flow[side] = {
      bold: flowField(m, sources, extra),
      cautious: flowField(m, sources, i => extra(i) + Math.min(6, danger[i]) * DANGER_COST)
    };
  }
  F.flowRev++;
  flowDirty = false;
  flowWait = FLOW_MIN_GAP;
}

/** Only a Commander that has really moved drags the chase route along. */
function checkChase() {
  for (const side of [0, 1]) {
    if (chase[side] < 0) continue;
    const c = F.cmd[1 - side];
    if (!c || c.dead) continue;
    const dx = colOf(c.cc) - colOf(chase[side]), dy = rowOf(c.cc) - rowOf(chase[side]);
    if (Math.hypot(dx, dy) > CHASE_SLACK) flowDirty = true;
  }
}

/* ── movement ─────────────────────────────────────────────────────────── */
const cellOf = (x, y) => (inside(Math.floor(x), Math.floor(y)) ? at(Math.floor(x), Math.floor(y)) : -1);

/** Is b one legal step from a (or the same cell)? */
function linked(a, b) {
  if (a === b) return true;
  const { off, to } = F.map.links;
  for (let k = off[a]; k < off[a + 1]; k++) if (to[k] === b) return true;
  return false;
}

function canEnter(o, i) {
  if (i < 0) return false;
  if (o.def && o.def.fly) return true;
  if (i === o.cc) return true;
  return linked(o.cc, i) && !solid(i);
}

/** Try to move `o` to (nx, ny), sliding along a wall if it has to. */
function moveTo(o, nx, ny) {
  const i = cellOf(nx, ny);
  if (canEnter(o, i)) { o.x = nx; o.y = ny; o.cc = i; return true; }
  const ix = cellOf(nx, o.y);
  if (canEnter(o, ix)) { o.x = nx; o.cc = ix; return true; }
  const iy = cellOf(o.x, ny);
  if (canEnter(o, iy)) { o.y = ny; o.cc = iy; return true; }
  return false;
}

/** Walk `o` up to `step` towards (tx, ty). True once it is there. */
function stepTowards(o, tx, ty, step) {
  const dx = tx - o.x, dy = ty - o.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-4) return true;
  o.ang = Math.atan2(dy, dx);
  const k = Math.min(1, step / d);
  const moved = moveTo(o, o.x + dx * k, o.y + dy * k);
  return moved && k >= 1;
}

/** Follow the side's flow field, one waypoint (a cell centre) at a time. */
function advance(u, step) {
  const flow = F.flow[u.side][u.plan];
  if (!flow || !flow.next) return;
  for (let guard = 0; step > 1e-6 && guard < 4; guard++) {
    if (!u.to || u.rev !== F.flowRev) {
      u.rev = F.flowRev;
      const n = flow.next[u.cc];
      if (n < 0) { u.to = null; return; }
      u.to = { x: colOf(n) + 0.5 + u.off.x, y: rowOf(n) + 0.5 + u.off.y, i: n };
    }
    const d = Math.hypot(u.to.x - u.x, u.to.y - u.y);
    const x0 = u.x, y0 = u.y;
    if (stepTowards(u, u.to.x, u.to.y, step)) { u.to = null; step -= d; continue; }
    if (u.x === x0 && u.y === y0) {
      // Wedged on a corner: back to the middle of its cell, then re-aim.
      u.to = null;
      stepTowards(u, colOf(u.cc) + 0.5, rowOf(u.cc) + 0.5, step * 0.5);
    }
    return;
  }
}

/** Keep units from stacking into a single dot: a gentle push apart. */
function spread(dt) {
  const bucket = new Map();
  for (const u of F.units) {
    if (u.dead) continue;
    const key = (Math.floor(u.x) << 8 | Math.floor(u.y)) * 2 + (u.def.fly ? 1 : 0);
    (bucket.get(key) || bucket.set(key, []).get(key)).push(u);
  }
  for (const u of F.units) {
    if (u.dead) continue;
    const fx = Math.floor(u.x), fy = Math.floor(u.y), air = u.def.fly ? 1 : 0;
    let px = 0, py = 0;
    for (let y = -1; y <= 1; y++) {
      for (let x = -1; x <= 1; x++) {
        const list = bucket.get(((fx + x) << 8 | (fy + y)) * 2 + air);
        if (!list) continue;
        for (const v of list) {
          if (v === u) continue;
          const dx = u.x - v.x, dy = u.y - v.y;
          const d = Math.hypot(dx, dy);
          if (d >= PERSONAL_SPACE || d < 1e-5) continue;
          const push = (PERSONAL_SPACE - d) / PERSONAL_SPACE;
          px += dx / d * push; py += dy / d * push;
        }
      }
    }
    if (px || py) moveTo(u, u.x + px * dt * 1.2, u.y + py * dt * 1.2);
  }
}

/* ── targets ──────────────────────────────────────────────────────────── */
const valid = o => !!o && !o.dead && o.hp > 0;

/** Distance from a point to the edge of `o`. */
function gap(p, o) {
  if (o.kind === 'struct') {
    const dx = Math.max(0, Math.abs(p.x - o.x) - o.half);
    const dy = Math.max(0, Math.abs(p.y - o.y) - o.half);
    return Math.hypot(dx, dy);
  }
  return Math.hypot(p.x - o.x, p.y - o.y);
}

const flies = o => o.kind === 'unit' && !!o.def.fly;

/** Nearest hostile mobile (unit or Commander) within `range` of p. */
function nearestMobile(p, side, range, aa) {
  let best = null, bd = range;
  for (const u of F.units) {
    if (u.side === side || u.dead || (flies(u) && !aa)) continue;
    const d = Math.hypot(u.x - p.x, u.y - p.y);
    if (d <= bd) { bd = d; best = u; }
  }
  const c = F.cmd[1 - side];
  if (valid(c) && Math.hypot(c.x - p.x, c.y - p.y) <= bd) best = c;
  return best;
}

function nearestStruct(p, side, range) {
  let best = null, bd = range;
  for (const s of F.structs) {
    if (s.side === side || s.dead) continue;
    const d = gap(p, s);
    if (d <= bd) { bd = d; best = s; }
  }
  return best;
}

/** What a unit turns to fight, by role. The pick is kept until it dies or
    slips out of reach, so a column does not twitch between targets. */
function pickTarget(u, range) {
  const aa = u.def.aa;
  switch (u.def.role) {
    case 'raider': return nearestStruct(u, u.side, range);
    case 'siege': return nearestStruct(u, u.side, range) || nearestMobile(u, u.side, range, aa);
    default: return nearestMobile(u, u.side, range, aa) || nearestStruct(u, u.side, range);
  }
}

/** A flyer's destination: the nearest hostile building, else the Commander. */
function flyerGoal(u) {
  let best = null, bd = Infinity;
  for (const s of F.structs) {
    if (s.side === u.side || s.dead) continue;
    const d = dist(u, s);
    if (d < bd) { bd = d; best = s; }
  }
  return best || (valid(F.cmd[1 - u.side]) ? F.cmd[1 - u.side] : null);
}

/* ── damage ───────────────────────────────────────────────────────────── */
/** Hurt anything. `by` is the side that fired; `src` a tower kind, 'unit'
    or 'cmd', for the report. */
function harm(o, dmg, by, src, pierce = 0) {
  if (!valid(o)) return;
  const armour = o.kind === 'unit' ? o.def.armor : o.kind === 'cmd' ? 0.2 : 0;
  const dealt = dmg * (1 - Math.max(0, armour - pierce));
  if (by === 0 && src && TOWERS[src]) bump(S.tally.dmg, src, Math.min(dealt, o.hp));
  o.hp -= dealt;
  o.hit = 0.12;
  if (o.kind === 'cmd') o.calm = 0;
  if (o.hp > 0) return;

  if (o.kind === 'unit') killUnit(o, by, src);
  else if (o.kind === 'cmd') killCommander(o);
  else razeStruct(o, by);
}

function killUnit(u, by, src) {
  u.dead = true;
  armyCount[u.side]--;
  puff(u.x, u.y, u.k === 'breaker' ? 10 : 6, u.side ? u.def.ecol : u.def.col);
  const salvage = by === u.side ? 0 : Math.round(unitCost(u.k, u.tier) * SALVAGE * (by === 0 ? meta.mods.killGold : 1));
  earn(by, salvage);
  if (u.side === 0) { bump(S.tally.lost, u.k); return; }
  S.kills++;
  bump(S.tally.killed, u.k);
  if (src === 'unit') S.tally.unitKills++;
  else if (src && TOWERS[src]) bump(S.tally.towerKills, src);
  meta.noteKill();
  award(killPoints(F.sector) * u.tier * meta.mods.points);
  if (salvage && F.rand() < 0.3) note(u.x, u.y - 0.3, '+' + salvage, '#ffd76b', 0.7);
  if (Math.random() < 0.25) sfx.kill();
}

function killCommander(c) {
  c.dead = true;
  c.hp = 0;
  const kit = c.side ? F.kit[1] : 1;
  S.shake = 1.2;
  sfx.boss();
  puff(c.x, c.y, 50, c.side ? '#ff5f6d' : '#4cc9f0');
  S.blasts.push({ x: c.x, y: c.y, r: COMMANDER.blast, t: 0.3, col: '#ffe08a' });
  F.wrecks.push({ x: c.x, y: c.y, t: 8, col: c.side ? '#ff5f6d' : '#4cc9f0', big: true });
  note(c.x, c.y - 1.2, c.side ? 'Enemy Commander destroyed' : 'Your Commander has fallen', c.side ? '#7ddf8f' : '#ff5f6d', 2.6);
  if (S.selected === c) S.selected = null;
  // The core goes up and takes everything close with it.
  const hits = [...F.units, ...F.structs, ...F.cmd].filter(o => o !== c && valid(o) && gap(c, o) <= COMMANDER.blast);
  for (const o of hits) harm(o, COMMANDER.blastDmg * kit, c.side, 'cmd');
  if (c.side === 1) award(killPoints(F.sector) * 25 * meta.mods.points);
  flowDirty = true;
  touch();
}

function razeStruct(s, by) {
  const col = s.side ? '#ff5f6d' : s.type === 'tower' ? TOWERS[s.k].color : '#8fb3c9';
  puff(s.x, s.y, s.type === 'fab' ? 30 : 12, col);
  F.wrecks.push({ x: s.x, y: s.y, t: s.type === 'fab' ? 6 : 3, col, big: s.type === 'fab' });
  if (by !== s.side) earn(by, Math.round(s.spent * SALVAGE));
  if (s.side === 0) {
    S.tally.structsLost++;
    note(s.x, s.y - 0.4, `${nameOf(s)} lost`, '#ff5f6d');
    S.shake = Math.max(S.shake, 0.4);
    sfx.breach();
  } else {
    S.tally.razed++;
    award(killPoints(F.sector) * (s.type === 'fab' ? 8 : 3) * meta.mods.points);
    note(s.x, s.y - 0.4, `${nameOf(s)} razed`, '#7ddf8f');
    sfx.blast();
  }
  remove(s);
  touch();
}

function chill(o, amount, duration) {
  if (o.kind !== 'unit') return;
  if (amount >= o.slow) { o.slow = amount; o.slowLeft = duration; }
  else o.slowLeft = Math.max(o.slowLeft, duration * 0.5);
}

function puff(x, y, n, c) {
  for (let k = 0; k < n; k++) {
    S.motes.push({ x, y, vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3, t: 0.45, c });
  }
}

/* ── the Commander ────────────────────────────────────────────────────── */
const reachOf = side => (side ? BUILD_REACH + 0.5 : meta.mods.buildReach);
const powerOf = side => (side ? 1 + 0.1 * (F.sector - 1) : meta.mods.buildPower);

/** Your Commander, for the side panel and the camera. */
export const commanderOf = side => F.cmd[side];

function tickCommander(c, dt) {
  c.hit = Math.max(0, c.hit - dt);
  c.kick = Math.max(0, c.kick - dt * 6);
  c.calm += dt;
  if (c.calm > 4 && c.hp < c.max) c.hp = Math.min(c.max, c.hp + COMMANDER.regen * (c.side ? F.kit[1] : meta.mods.cmdHp) * dt);

  // Moving: your stick, or the enemy's plan.
  const speed = COMMANDER.spd * dt;
  c.walk = 0;
  if (c.side === 0) {
    const v = F.stick.x || F.stick.y ? F.stick : F.keys;
    const m = Math.min(1, Math.hypot(v.x, v.y));
    if (m > 0.08) {
      const a = Math.atan2(v.y, v.x);
      moveTo(c, c.x + Math.cos(a) * speed * m, c.y + Math.sin(a) * speed * m);
      c.ang = a;
      c.walk = m;
    }
  } else {
    walkAI(c, speed);
  }

  // Building: the oldest order in reach first; otherwise patch things up.
  const reach = reachOf(c.side);
  c.beam = null;
  const site = F.structs.find(s => s.side === c.side && !s.done && !s.dead && gap(c, s) <= reach);
  const power = powerOf(c.side);
  if (site) {
    const step = dt * power / site.bt;
    site.prog = Math.min(1, site.prog + step);
    site.hp = Math.min(site.max, site.hp + site.max * 0.9 * step);
    c.beam = site;
    if (site.prog >= 1) finish(site);
  } else {
    let worst = null, frac = 1;
    for (const s of F.structs) {
      if (s.side !== c.side || !s.done || s.dead || s.hp >= s.max) continue;
      if (gap(c, s) > reach) continue;
      if (s.hp / s.max < frac) { frac = s.hp / s.max; worst = s; }
    }
    if (worst) {
      worst.hp = Math.min(worst.max, worst.hp + worst.max * COMMANDER.repair * power * dt);
      c.beam = worst;
    }
  }

  // Fighting: whatever hostile is in reach, units first.
  c.cd -= dt;
  if (!valid(c.tgt) || gap(c, c.tgt) > COMMANDER.range) c.tgt = null;
  c.scan -= dt;
  if (!c.tgt && c.scan <= 0) {
    c.scan = 0.25;
    c.tgt = nearestMobile(c, c.side, COMMANDER.range, true) || nearestStruct(c, c.side, COMMANDER.range);
  }
  if (!c.tgt) return;
  c.aim = Math.atan2(c.tgt.y - c.y, c.tgt.x - c.x);
  if (c.cd > 0) return;
  c.cd = COMMANDER.rate;
  c.kick = 1;
  const dmg = COMMANDER.dmg * (c.side ? F.kit[1] : meta.mods.unitDmg);
  F.shots.push({ side: c.side, x: c.x, y: c.y, tgt: c.tgt, dmg, spd: 13, splash: COMMANDER.splash, air: true, col: c.side ? '#ff7b86' : '#8fe3ff', life: 1.2, src: 'cmd', big: true });
}

/* ── the enemy's brain ────────────────────────────────────────────────────
   Every beat it checks its Factories for upgrades, then gives its
   Commander the next thing on the plan: a Factory, Helpers to feed it,
   and towers on the side facing you. It waits for the gold rather than
   skipping ahead, so the plan unfolds in the same order every time.     */
const OPENING = ['fab', 'helper', 'gun', 'helper', 'fab', 'helper', 'gun', 'helper', 'rocket', 'helper', 'helper', 'laser', 'gun', 'helper', 'helper', 'rocket'];
const LOOP = ['helper', 'gun', 'helper', 'rocket', 'fab', 'helper', 'laser', 'helper', 'tesla', 'helper', 'frost', 'gun'];
const AI_SEQS = [
  ['trooper', 'trooper', 'striker', 'breaker'],
  ['trooper', 'breaker', 'gunship', 'trooper'],
  ['striker', 'striker', 'trooper', 'breaker', 'gunship']
];
function aiSequence() {
  return [...AI_SEQS[F.ai.seqs++ % AI_SEQS.length]];
}

/** The enemy Factory due a tier, if any: one at a time, on a schedule. */
function aiUpgradeDue() {
  const minutes = F.time / 60;
  let due = null;
  for (const f of F.structs) {
    if (f.side !== 1 || f.type !== 'fab' || !f.done) continue;
    if (f.up) return null;
    if (minutes > 3.5 * f.tier && (!due || f.tier < due.tier)) due = f;
  }
  return due;
}

/** Gold the enemy's Factories leave alone: savings for a tier when one is
    due, else a share of the Commander's next building. */
function aiReserve() {
  const due = aiUpgradeDue();
  if (due) return fabUpCost(due.tier);
  const c = F.cmd[1];
  if (!valid(c) || sitesOf(1).length) return 0;
  return Math.min(300, 0.5 * priceOf(1, planKey(F.ai.step)));
}

function planKey(n) {
  // Without a Factory it has no army: that comes before anything else.
  if (!countOf(1, 'fab')) return 'fab';
  let key = n < OPENING.length ? OPENING[n] : LOOP[(n - OPENING.length) % LOOP.length];
  if (key === 'fab' && countOf(1, 'fab') >= 4) key = 'helper';
  if (key === 'helper' && freeRingCell(1) < 0) key = 'gun';
  return key;
}

function freeRingCell(side) {
  const fabs = F.structs.filter(s => s.side === side && s.type === 'fab' && !s.dead);
  fabs.sort((a, b) => F.structs.filter(h => h.fab === a).length - F.structs.filter(h => h.fab === b).length);
  const d = F.ai.dir;
  for (const f of fabs) {
    // Helpers go on the far side first, away from the fighting.
    const ring = ringOf(f).sort((a, b) =>
      ((colOf(a) - f.cx) * d.x + (rowOf(a) - f.cy) * d.y) - ((colOf(b) - f.cx) * d.x + (rowOf(b) - f.cy) * d.y));
    for (const c of ring) if (!whyNotFor(side, 'helper', c)) return c;
  }
  return -1;
}

/** Somewhere sensible for the enemy's next building, or -1. */
function findSpot(key) {
  if (key === 'helper') return freeRingCell(1);
  const a = F.ai.start, d = F.ai.dir;
  const want = key === 'fab' ? { x: a.x + d.x * 1.5, y: a.y + d.y * 1.5 } : { x: a.x + d.x * 5.5, y: a.y + d.y * 5.5 };
  const [r0, r1] = key === 'fab' ? [2, 11] : [3, 9];
  let best = -1, bs = Infinity;
  for (let y = -r1; y <= r1; y++) {
    for (let x = -r1; x <= r1; x++) {
      const r = Math.hypot(x, y);
      if (r < r0 || r > r1) continue;
      const cx = Math.floor(a.x) + x, cy = Math.floor(a.y) + y;
      if (!inside(cx, cy)) continue;
      const i = at(cx, cy);
      if (whyNotFor(1, key, i)) continue;
      if (key !== 'fab' && ringOwner(1, i)) continue;
      let score = Math.hypot(cx + 0.5 - want.x, cy + 0.5 - want.y) + F.rand() * 1.5;
      if (key !== 'fab') {
        for (const t of F.structs) {
          if (t.side === 1 && t.type === 'tower' && Math.hypot(t.cx - cx, t.cy - cy) < 2.2) score += 4;
        }
      }
      if (score < bs) { bs = score; best = i; }
    }
  }
  return best;
}

function thinkAI(dt) {
  const ai = F.ai;
  ai.think -= dt;
  if (ai.think > 0) return;
  ai.think = 0.8;

  const minutes = F.time / 60;
  for (const f of F.structs) {
    if (f.side !== 1 || f.type !== 'fab' || !f.done) continue;
    // Early on it trickles; later it gathers bigger armies before it moves,
    // but never waits so long that the army is only for show.
    f.group = Math.min(8, 3 + Math.floor(minutes / 1.5));
    const first = f.held.find(u => !u.dead);
    muster(f, !!first && F.time - first.born > 40);
  }
  const due = aiUpgradeDue();
  if (due && ai.gold >= fabUpCost(due.tier)) startUpgrade(due);

  const c = F.cmd[1];
  if (!valid(c)) return;
  // Hurt and under fire: fall back to the base to heal.
  if (c.hp < c.max * 0.35 && nearestMobile(c, 1, 4, true)) { c.goal = { x: ai.start.x, y: ai.start.y, id: 'home' }; return; }
  const pending = sitesOf(1);
  if (pending.length) { c.goal = pending[0]; return; }
  c.goal = null;
  const key = planKey(ai.step);
  // Saving for a tier: only a lost Factory jumps the queue.
  if (due && key !== 'fab') return;
  if (ai.gold < priceOf(1, key)) return;
  const spot = findSpot(key);
  if (spot < 0) { ai.step++; return; }
  const s = order(1, key, spot);
  if (s) { ai.step++; c.goal = s; }
}

function walkAI(c, speed) {
  const g = c.goal;
  if (!g) return;
  if (g.kind === 'struct' && (g.dead || g.done)) { c.goal = null; return; }
  const reach = BUILD_REACH - 0.5;
  if (g.kind === 'struct' ? gap(c, g) <= reach : Math.hypot(g.x - c.x, g.y - c.y) < 1) return;
  const id = g.id;
  if (!F.ai.route || F.ai.route.id !== id || F.ai.route.rev !== F.flowRev) {
    const cells = g.kind === 'struct' ? g.cells : [cellOf(g.x, g.y)];
    F.ai.route = { id, rev: F.flowRev, flow: flowField(F.map, cells, i => (solid(i) && !cells.includes(i) ? Infinity : 0)) };
  }
  const n = F.ai.route.flow.next[c.cc];
  const tx = n >= 0 ? colOf(n) + 0.5 : g.x, ty = n >= 0 ? rowOf(n) + 0.5 : g.y;
  stepTowards(c, tx, ty, speed);
  c.walk = 1;
}

/* ── towers fire ──────────────────────────────────────────────────────── */
function acquire(t, range, hitsAir, spareCommander) {
  if (valid(t.lock) && dist(t, t.lock) <= range && (!flies(t.lock) || hitsAir)) return t.lock;
  let best = null, bd = range;
  for (const u of F.units) {
    if (u.side === t.side || u.dead || (flies(u) && !hitsAir)) continue;
    const d = dist(t, u);
    if (d <= bd) { bd = d; best = u; }
  }
  const c = F.cmd[1 - t.side];
  if (!best && !spareCommander && valid(c) && dist(t, c) <= range) best = c;
  return best;
}

function tickTower(t, dt) {
  const def = TOWERS[t.k];
  const st = towerStats(t);
  const range = rangeOf(t);
  const hitsAir = def.kind === 'aura' ? (t.side ? false : meta.mods.frostAir)
    : t.k === 'rocket' ? def.air || (!t.side && meta.mods.rocketAir)
    : def.air;
  t.hit = Math.max(0, t.hit - dt);
  t.kick = Math.max(0, t.kick - dt * 7);

  if (def.kind === 'factory') {
    t.spin = (t.spin + dt * 2) % 6.284;
    if (t.side) return;
    t.store += st.yield * dt;
    const whole = Math.floor(t.store);
    if (whole < 1) return;
    t.store -= whole;
    S.minted += whole;
    meta.addPoints(whole);
    note(t.x, t.y - 0.3, '+' + whole + ' ◈', '#ffd76b');
    touch();
    return;
  }

  if (def.kind === 'aura') {
    t.cd -= dt;
    t.ring = Math.max(0, t.ring - dt * 3.2);
    if (t.cd > 0) return;
    let touched = 0;
    for (const u of [...F.units, F.cmd[1 - t.side]]) {
      if (!valid(u) || u.side === t.side || (flies(u) && !hitsAir)) continue;
      if (dist(t, u) > range) continue;
      chill(u, st.slow, st.slowDur);
      harm(u, st.dmg, t.side, t.k, st.pierce);
      touched++;
    }
    if (touched) { t.cd = st.rate; t.ring = 1; if (!t.side) sfx.freeze(); }
    else t.cd = 0.2;
    return;
  }

  const target = acquire(t, range, hitsAir, def.kind === 'portal');
  t.lock = target;
  if (target) t.ang = Math.atan2(target.y - t.y, target.x - t.x);

  if (def.kind === 'beam') {
    if (!target) { t.beam = null; t.focus = 0; return; }
    t.focus = t.beam === target ? Math.min(2.2, t.focus + dt) : 0;
    t.beam = target;
    const ramp = 1 + (t.focus / 2.2) * st.ramp;
    harm(target, st.dps * ramp * (t.side ? 1 : meta.critAverage()) * dt, t.side, t.k, st.pierce);
    return;
  }

  t.cd -= dt;
  if (!target || t.cd > 0) return;
  t.cd = st.rate;
  t.kick = 1;

  if (def.kind === 'chain') { fireChain(t, st, target); return; }
  if (def.kind === 'portal') { sendHome(target, def.color, t); return; }

  const crit = !t.side && meta.rollCrit();
  F.shots.push({
    side: t.side, k: t.k, x: t.x, y: t.y, tgt: target,
    spd: t.k === 'gun' ? 15 : 7.5 * (t.side ? 1 : meta.mods.rocketSpeed),
    dmg: st.dmg * (crit ? meta.mods.critMult : 1), pierce: st.pierce, splash: st.splash, air: hitsAir,
    crit, col: t.side ? '#ff7b86' : def.color, life: 2.2, src: t.k
  });
  if (t.k === 'rocket' && !t.side) sfx.rocket();
}

function fireChain(t, st, first) {
  const crit = !t.side && meta.rollCrit();
  let damage = st.dmg * (crit ? meta.mods.critMult : 1);
  const points = [{ x: t.x, y: t.y }];
  const seen = new Set();
  let current = first;
  for (let jump = 0; jump < st.chains && current; jump++) {
    seen.add(current);
    points.push({ x: current.x, y: current.y });
    harm(current, damage, t.side, t.k, st.pierce);
    damage *= CHAIN_FALLOFF;
    let next = null, bestD = CHAIN_REACH;
    for (const u of F.units) {
      if (u.dead || u.side === t.side || seen.has(u)) continue;
      const d = dist(u, current);
      if (d < bestD) { bestD = d; next = u; }
    }
    current = next;
  }
  if (points.length > 1) S.arcs.push({ points, t: 0.14, col: t.side ? '#ff7b86' : undefined });
  if (!t.side) sfx.arc();
}

/** A Portal drops a unit back at the Factory it came out of. */
function sendHome(u, colour, t) {
  if (u.kind !== 'unit') return;
  if (!t.side) S.tally.warps++;
  S.warps.push({ x: u.x, y: u.y, fx: t.x, fy: t.y, t: 0.5, col: colour });
  u.x = u.home.x; u.y = u.home.y; u.cc = u.home.cc;
  u.to = null; u.tgt = null;
  S.warps.push({ x: u.x, y: u.y, t: 0.5, col: colour });
  if (!t.side) sfx.warp();
}

/** Every projectile: homes in, then hits (or splashes) on arrival. */
function tickShot(s, dt) {
  const target = s.tgt;
  const live = valid(target);
  const gx = live ? target.x : (s.gx ?? (s.gx = s.x + Math.cos(s.a || 0) * 2));
  const gy = live ? target.y : (s.gy ?? (s.gy = s.y + Math.sin(s.a || 0) * 2));
  const dx = gx - s.x, dy = gy - s.y;
  const d = Math.hypot(dx, dy) || 1;
  s.a = Math.atan2(dy, dx);
  s.life -= dt;
  const step = s.spd * dt;
  const edge = live && target.kind === 'struct' ? target.half * 0.8 : 0;
  if (d - edge > step && s.life > 0) { s.x += dx / d * step; s.y += dy / d * step; return true; }

  if (s.splash) {
    S.blasts.push({ x: s.x, y: s.y, r: s.splash, t: 0.3, col: s.col });
    for (const u of [...F.units, F.cmd[1 - s.side]]) {
      if (!valid(u) || u.side === s.side || (flies(u) && !s.air)) continue;
      const dd = dist(u, s);
      if (dd <= s.splash) harm(u, s.dmg * (1 - 0.45 * dd / s.splash), s.side, s.src, s.pierce);
    }
    if (live && target.kind === 'struct') harm(target, s.dmg * (s.vs || 1), s.side, s.src, s.pierce);
    if (!s.side || Math.random() < 0.3) sfx.blast();
  } else if (live) {
    harm(target, s.dmg * (target.kind === 'struct' ? s.vs || 1 : 1), s.side, s.src, s.pierce || 0);
    if (s.big) S.blasts.push({ x: s.x, y: s.y, r: 0.35, t: 0.2, col: s.col });
  }
  return false;
}

/* ── units ────────────────────────────────────────────────────────────── */
function tickUnit(u, dt) {
  u.hit = Math.max(0, u.hit - dt);
  u.kick = Math.max(0, u.kick - dt * 6);
  if (u.slowLeft > 0) { u.slowLeft -= dt; if (u.slowLeft <= 0) u.slow = 0; }
  const def = u.def;
  const speed = def.spd * (1 - u.slow) * dt;

  // Keep the target until it dies or slips out of reach; look again only
  // every few tenths of a second.
  if (u.tgt && (!valid(u.tgt) || gap(u, u.tgt) > def.range + AGGRO)) u.tgt = null;
  u.scan -= dt;
  if (!u.tgt && u.scan <= 0) {
    u.scan = 0.3 + F.rand() * 0.15;
    u.tgt = pickTarget(u, def.range + AGGRO);
  }
  u.cd -= dt;

  const t = u.tgt;
  if (t && gap(u, t) <= def.range) {
    u.ang = Math.atan2(t.y - u.y, t.x - u.x);
    if (u.cd > 0) return;
    u.cd = def.rate;
    u.kick = 1;
    fireUnit(u, t);
    return;
  }

  // Waiting at the Factory door for the rest of its group.
  if (u.hold) {
    if (t) stepTowards(u, t.x, t.y, speed);
    return;
  }
  if (def.fly) {
    if (!t && (!valid(u.goal) || F.rand() < dt)) u.goal = flyerGoal(u);
    const aim = t || u.goal;
    if (aim) stepTowards(u, aim.x, aim.y, speed);
    return;
  }
  if (t) {
    // Close in on something that is nearly in range; the road waits. A
    // cliff in the way sends it back to the road instead.
    const x0 = u.x, y0 = u.y;
    stepTowards(u, t.x, t.y, speed);
    u.to = null;
    if (u.x !== x0 || u.y !== y0) return;
  }
  advance(u, speed);
}

function fireUnit(u, t) {
  const def = u.def;
  const col = u.side ? def.ecol : def.col;
  if (def.splash) {
    F.shots.push({ side: u.side, x: u.x, y: u.y, tgt: t, dmg: u.dmg, spd: 7, splash: def.splash, air: false, col, life: 2, src: 'unit', vs: def.vsBase, pierce: 0.3, big: true });
    return;
  }
  harm(t, u.dmg * (t.kind === 'struct' ? def.vsBase : 1), u.side, 'unit', 0.2);
  S.arcs.push({ points: [{ x: u.x, y: u.y }, { x: t.x, y: t.y }], t: 0.06, col, tracer: true });
}

/* ── helpers ──────────────────────────────────────────────────────────── */
export function deny(text) {
  S.warn = 1.1;
  S.warnText = text;
  sfx.deny();
}

/** Floating text in world coordinates. */
function note(x, y, text, colour, life = 0.9) {
  S.notes.push({ x, y, s: text, c: colour, t: life });
}

/** What is under a tap at world point (x, y): your Commander, a building. */
export function pickAt(x, y) {
  for (const c of F.cmd) if (valid(c) && Math.hypot(c.x - x, c.y - y) < 0.7) return c;
  const i = cellOf(x, y);
  return i >= 0 ? F.grid[i] : null;
}

/** Is a side still in the war? */
const standing = side => valid(F.cmd[side]) || F.structs.some(s => s.side === side && !s.dead);

/* ── frame ────────────────────────────────────────────────────────────── */
export function update(dt) {
  if (S.paused || S.suspended || S.phase === 'dead' || S.phase === 'menu' || !F.map) return;

  F.time += dt;
  S.wave = Math.floor(F.time / 60);
  S.shake = Math.max(0, S.shake - dt * 2.5);
  S.waveFlash = Math.max(0, S.waveFlash - dt);
  S.warn = Math.max(0, S.warn - dt);
  payIncome(dt);
  persistClock += dt;
  if (persistClock > 20) { persistClock = 0; meta.persist(); }

  checkChase();
  flowWait -= dt;
  if (flowDirty && flowWait <= 0) refreshFlow();

  thinkAI(dt);
  for (const c of F.cmd) if (valid(c)) tickCommander(c, dt);

  for (const s of [...F.structs]) {
    if (s.dead || !s.done) continue;
    s.hit = Math.max(0, s.hit - dt);
    if (s.type === 'tower') tickTower(s, dt);
    else if (s.type === 'fab') tickFab(s, dt);
  }
  for (const u of F.units) if (!u.dead) tickUnit(u, dt);
  spread(dt);

  F.shots = F.shots.filter(s => tickShot(s, dt));

  for (const b of S.blasts) b.t -= dt;
  S.blasts = S.blasts.filter(b => b.t > 0);
  for (const a of S.arcs) a.t -= dt;
  S.arcs = S.arcs.filter(a => a.t > 0);
  for (const w of S.warps) w.t -= dt;
  S.warps = S.warps.filter(w => w.t > 0);
  for (const w of F.wrecks) w.t -= dt;
  F.wrecks = F.wrecks.filter(w => w.t > 0);
  for (const m of S.motes) {
    m.x += m.vx * dt; m.y += m.vy * dt;
    m.vx *= 0.93; m.vy *= 0.93; m.t -= dt;
  }
  S.motes = S.motes.filter(m => m.t > 0);
  for (const n of S.notes) { n.y -= 0.8 * dt; n.t -= dt; }
  S.notes = S.notes.filter(n => n.t > 0);

  if (F.units.some(u => u.dead)) F.units = F.units.filter(u => !u.dead);

  const me = F.cmd[0];
  S.lives = Math.max(0, Math.round(me.hp));
  S.maxLives = me.max;

  if (!standing(1)) gameOver(true);
  else if (!standing(0)) gameOver(false);
}
