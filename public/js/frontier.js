/* ══ Frontier simulation ═════════════════════════════════════════════════
   The second mode. It shares the run-wide state object `S` with Holdout -
   gold, score, the wave clock, speed, pause, projectiles, floating notes -
   so the side console, the Foundry and the menus work unchanged. What is
   Frontier's own lives on `F`: the map, the towers, both bases, and your
   units.

   Differences from Holdout, in one place:
     - the field is a seeded terrain map (terrain.js), scrolled and zoomed
     - enemies plan their own route: cautious ones go around your kill
       zones when there is another way, bold ones take the short road,
       and anything that finds a tower in its path stops and knocks it down
     - most enemies are armed, and they shoot your towers and units
     - towers have health, are patched up after every wave, and are lost
       for good when destroyed
     - you win a sector by razing the enemy HQ with counter-waves of units
     - positions here are in cells (world units); the renderer projects

   Holdout's tower maths (statsOf, dpsOf, level costs) is reused as is, so
   a Frontier Gun is exactly a Holdout Gun.                               */

import {
  TOWERS, FOES, CHAIN_REACH, CHAIN_FALLOFF, levelUpCost,
  BUILD_ESCALATION, KILL_GOLD_GROWTH, interestCap, clearGold, earlyCallGold,
  wavePoints, KILL_POINTS, PORTAL_SPARES_BOSSES,
  MAP_W, MAP_H, threatOf, sectorDepth, HIGH_GROUND_RANGE, ENEMY_KEEP_OUT,
  HQ_HALF, TOWER_PATH_COST, DANGER_COST, TOWER_HP, TOWER_HP_LEVEL, ARMS_GROWTH,
  FOE_ARMS, RAM_DMG, UNITS, UNIT_GROWTH, unitCost, UNIT_CAP, ARMORY_MUL, armoryCost,
  baseScale, ENEMY_HQ_HP, BUNKER, bunkerCount, sectorBounty
} from './config.js';
import { generate, sectorSeed, flowField, rng, at, colOf, rowOf } from './terrain.js';
import { buildWave } from './waves.js';
import { S, statsOf, maxTier, titanShred } from './game.js';
import * as meta from './meta.js';
import * as recorder from './recorder.js';
import { sfx } from './audio.js';

export const F = {
  sector: 1,
  map: null,
  /** cell -> tower, or null */
  grid: [],
  towers: [],
  /** Your troops in the field. */
  units: [],
  /** Units bought and waiting at the HQ for the next deployment. */
  squad: { trooper: 0, striker: 0, breaker: 0 },
  armory: 0,
  hq: null,
  enemy: null,
  bunkers: [],
  /** Hostile shots (enemy fire and bunker fire) - drawn red. */
  bolts: [],
  /** Wrecks left where towers and units fell, for a moment. */
  wrecks: [],
  /** Route fields: enemies to your HQ, and your units to theirs. */
  flow: { cautious: null, bold: null, attack: null },
  /** How many armed towers cover each cell - cautious walkers avoid it. */
  danger: null,
  /** 'won' | 'lost' once the sortie is over. */
  result: null,
  /** Cores the win paid, for the summary screen. */
  bounty: 0,
  /** Cells you may build on right now; rebuilt when the board changes. */
  reach: null
};

const touch = () => S.onChange();
const bump = (bag, key, by = 1) => { bag[key] = (bag[key] || 0) + by; };

/* ── lifecycle ────────────────────────────────────────────────────────── */
export function newSortie(sector = 1) {
  S.mode = 'frontier';
  recorder.stopPlayback();

  F.sector = sector;
  F.map = generate(sectorSeed(sector));
  F.grid = new Array(MAP_W * MAP_H).fill(null);
  F.towers = [];
  F.units = [];
  F.squad = { trooper: 0, striker: 0, breaker: 0 };
  F.armory = 0;
  F.bolts = [];
  F.wrecks = [];
  F.result = null;
  F.bounty = 0;

  const m = F.map;
  F.hq = base(m.hq);
  F.enemy = base(m.enemy);
  F.hq.max = F.hq.hp = meta.mods.integrity;
  F.enemy.max = F.enemy.hp = Math.round(ENEMY_HQ_HP * baseScale(sector));

  // Economy: open with what Holdout would have paid for the waves this
  // sector is deep, so the first wave is not a wall.
  S.gold = meta.mods.startGold + openingGold(sectorDepth(sector));
  S.score = 0;
  S.maxLives = F.hq.max;
  S.lives = F.hq.hp;
  S.wave = 0;
  S.kills = 0;
  S.wavesCleared = 0;
  S.minted = 0;
  S.skipped = 0;
  S.heldPoints = 0;
  S.phase = 'build';
  S.queue = [];
  S.nextWave = rollWave(1);
  S.breakLeft = 0;
  S.speed = 1;
  S.paused = false;
  S.suspended = false;
  S.foes = []; S.shots = []; S.blasts = []; S.arcs = []; S.warps = []; S.motes = []; S.notes = [];
  S.picked = null; S.selected = null; S.hover = -1;
  S.shake = 0; S.waveFlash = 0; S.warn = 0;
  S.tally = {
    dmg: {}, towerKills: {}, kills: {}, leaks: {}, warps: 0, headKills: 0,
    // Frontier extras for the report.
    unitKills: 0, unitsLost: 0, unitsSent: 0, towersLost: 0, baseDmg: 0
  };
  scoreCarry = 0;

  placeBunkers();
  refreshRoutes();
  touch();
}

function base(cell) {
  return { x: cell.x + 0.5, y: cell.y + 0.5, cx: cell.x, cy: cell.y, hp: 0, max: 0, hit: 0 };
}

/** The 3x3 footprint of a base, as cell indices. */
function footprint(b) {
  const out = [];
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) out.push(at(b.cx + x, b.cy + y));
  return out;
}

/** Distance from a point to the edge of a base's footprint. */
function toBase(b, x, y) {
  const dx = Math.max(0, Math.abs(x - b.x) - HQ_HALF);
  const dy = Math.max(0, Math.abs(y - b.y) - HQ_HALF);
  return Math.hypot(dx, dy);
}

/** A sortie opens with this many waves' worth of income at its depth. */
const OPENING_WAVES = 6;

/** A war chest, not a fortune: what the waves just before this sector's
    depth would pay, so the opening build is real but the rest is earned. */
function openingGold(depth) {
  let gold = 0;
  for (let w = Math.max(1, depth - OPENING_WAVES + 1); w <= depth; w++) {
    for (const order of buildWave(w)) {
      gold += Math.round(FOES[order.type].gold * (1 + KILL_GOLD_GROWTH * w) * meta.mods.killGold);
    }
    gold += Math.round(clearGold(w) * meta.mods.waveGold);
  }
  return gold;
}

/**
 * Bunkers stand on the approach, 4-6 cells out from the enemy HQ along the
 * roads your units will use, spread so they overlap without stacking.
 */
function placeBunkers() {
  F.bunkers = [];
  const m = F.map;
  const want = bunkerCount(F.sector);
  const approach = flowField(m, footprint(F.enemy), i => (baseCell(i) ? Infinity : 0));
  const spots = [];
  for (let i = 0; i < MAP_W * MAP_H; i++) {
    if (m.height[i] < 0 || baseCell(i)) continue;
    const d = approach.dist[i];
    if (d < 3.5 || d > 6.5) continue;
    spots.push(i);
  }
  // Prefer cells on or beside the road your units will take, then spread
  // the rest around so a second lane is not left open.
  const road = [];
  for (let u = at(F.hq.cx + 2, F.hq.cy), guard = 0; u !== -1 && guard < 4000; guard++) {
    road.push(u);
    u = approach.next[u];
  }
  const offRoad = i => Math.min(...road.map(r => Math.hypot(colOf(r) - colOf(i), rowOf(r) - rowOf(i))));
  // Seeded, so a sector's bunkers stand in the same places every time.
  const rand = rng(F.map.seed ^ 0x5bd1e995);
  const score = new Map(spots.map(i => [i, offRoad(i) + rand() * 1.5]));
  spots.sort((a, b) => score.get(a) - score.get(b));
  const scale = baseScale(F.sector);
  for (const i of spots) {
    if (F.bunkers.length >= want) break;
    if (F.bunkers.some(b => Math.hypot(b.cx - colOf(i), b.cy - rowOf(i)) < 3.2)) continue;
    F.bunkers.push({
      i, cx: colOf(i), cy: rowOf(i), x: colOf(i) + 0.5, y: rowOf(i) + 0.5,
      hp: Math.round(BUNKER.hp * scale), max: Math.round(BUNKER.hp * scale),
      dmg: BUNKER.dmg * scale, cd: Math.random(), ang: Math.PI, hit: 0, dead: false
    });
  }
}

let baseMask = null;
function baseCell(i) {
  if (!baseMask || baseMask.map !== F.map) {
    baseMask = new Uint8Array(MAP_W * MAP_H);
    baseMask.map = F.map;
    for (const c of footprint(F.hq)) baseMask[c] = 1;
    for (const c of footprint(F.enemy)) baseMask[c] = 2;
  }
  return baseMask[i];
}

function gameOver(won) {
  F.result = won ? 'won' : 'lost';
  S.phase = 'dead';
  S.paused = false;
  if (won) {
    F.bounty = Math.round(sectorBounty(F.sector) * meta.mods.points);
    award(F.bounty);
    note(F.enemy.x, F.enemy.y - 1, `+${F.bounty} sector bounty`, '#7ddf8f', 2.2);
    sfx.boss();
  }
  meta.noteFrontierEnd(F.sector, won, S.wavesCleared);
  meta.persistNow();
  touch();
}

/** Walking away from a sortie still counts it. */
export function leave() {
  if (S.mode !== 'frontier' || F.result) return;
  meta.noteFrontierEnd(F.sector, false, S.wavesCleared);
}

/* ── waves ────────────────────────────────────────────────────────────── */
const threat = () => threatOf(F.sector, Math.max(1, S.wave));

function rollWave(w) {
  const t = threatOf(F.sector, w);
  // Holdout's roster at the same depth, spawned from the enemy base.
  return buildWave(t).map(o => ({ ...o, arms: Math.pow(ARMS_GROWTH, t - 1) }));
}

export function startWave() {
  if (S.phase === 'run' || S.phase === 'dead' || S.phase === 'menu') return;
  if (S.phase === 'break') S.gold += Math.round(earlyCallGold(threat()) * meta.mods.waveGold);

  S.wave++;
  S.queue = S.nextWave;
  S.nextWave = rollWave(S.wave + 1);
  S.phase = 'run';
  S.waveFlash = 1.6;
  // Structures are refitted to the new threat, keeping their damage share.
  for (const t of F.towers) refit(t);
  deploy();
  sfx.wave();
  touch();
}

function endWave() {
  S.wavesCleared = S.wave;
  const t = threat();

  S.gold += Math.round(clearGold(t) * meta.mods.waveGold);
  const interest = Math.floor(Math.min(S.gold, interestCap(t)) * meta.mods.interest);
  if (interest > 0) {
    S.gold += interest;
    note(F.hq.x, F.hq.y + 2.2, '+' + interest + ' interest', '#ffd76b');
  }
  award(wavePoints(t) * meta.mods.points);

  // Field crews patch every standing tower back to full.
  for (const tw of F.towers) tw.hp = tw.max;

  if (meta.mods.repair && S.wavesCleared % 8 === 0 && F.hq.hp < F.hq.max) {
    F.hq.hp = Math.min(F.hq.max, F.hq.hp + Math.round(F.hq.max * 0.15));
    S.lives = F.hq.hp;
    note(F.hq.x, F.hq.y - 2, 'HQ repaired', '#7ddf8f');
  }

  meta.persist();
  S.phase = 'break';
  S.breakLeft = meta.mods.breakTime;
  touch();
}

let scoreCarry = 0;
function award(points) {
  if (points <= 0) return;
  scoreCarry += points;
  const whole = Math.floor(scoreCarry);
  if (whole <= 0) return;
  scoreCarry -= whole;
  S.score += whole;
  meta.addPoints(whole);
}

/* ── routes ───────────────────────────────────────────────────────────────
   Three flow fields, rebuilt whenever a tower appears or falls:
     cautious - to your HQ, around towers and around their fields of fire
     bold     - to your HQ, around towers but straight through kill zones
     attack   - your units to the enemy HQ; they walk over your own towers
   A tower on the only road is still passable at TOWER_PATH_COST: a walker
   that reaches it stops and knocks it down. Walling in is not a win.   */
export function refreshRoutes() {
  const m = F.map;
  const danger = new Float32Array(MAP_W * MAP_H);
  for (const t of F.towers) {
    const def = TOWERS[t.k];
    if (def.kind === 'factory' || def.kind === 'portal') continue;
    const r = rangeOf(t);
    const r2 = Math.ceil(r);
    for (let y = -r2; y <= r2; y++) {
      for (let x = -r2; x <= r2; x++) {
        const cx = t.cx + x, cy = t.cy + y;
        if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) continue;
        if (Math.hypot(x, y) <= r) danger[at(cx, cy)] += 1;
      }
    }
  }
  F.danger = danger;

  const hqCells = footprint(F.hq);
  const blocked = i => baseCell(i) === 2 ? Infinity : 0;
  F.flow.cautious = flowField(m, hqCells, i =>
    blocked(i) + (F.grid[i] ? TOWER_PATH_COST : 0) + Math.min(6, danger[i]) * DANGER_COST);
  F.flow.bold = flowField(m, hqCells, i =>
    blocked(i) + (F.grid[i] ? TOWER_PATH_COST : 0));
  F.flow.attack = flowField(m, footprint(F.enemy), i => (baseCell(i) === 1 ? Infinity : 0));

  // Every walker re-plans from where it stands.
  for (const e of S.foes) e.to = null;
  for (const u of F.units) u.to = null;
  refreshReach();
}

/** Cells within build reach of the HQ or of any tower. */
function refreshReach() {
  const reach = new Uint8Array(MAP_W * MAP_H);
  const r = meta.mods.buildReach;
  const anchors = [{ x: F.hq.cx, y: F.hq.cy, r: r + HQ_HALF }, ...F.towers.map(t => ({ x: t.cx, y: t.cy, r }))];
  for (const a of anchors) {
    const span = Math.ceil(a.r);
    for (let y = -span; y <= span; y++) {
      for (let x = -span; x <= span; x++) {
        const cx = a.x + x, cy = a.y + y;
        if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) continue;
        if (Math.hypot(x, y) <= a.r) reach[at(cx, cy)] = 1;
      }
    }
  }
  F.reach = reach;
}

/* ── towers: build, sell, swap, upgrade ───────────────────────────────── */
function countOf(key) {
  let n = 0;
  for (const t of F.towers) if (t.k === key) n++;
  return n;
}

export function buildCost(key) {
  const raw = TOWERS[key].cost * Math.pow(BUILD_ESCALATION, countOf(key)) * meta.mods.buildCost;
  return Math.max(5, Math.round(raw / 5) * 5);
}

export const refundOf = t => (t ? t.spent : 0);

/** Why a cell cannot take a tower, or '' when it can. */
export function whyNot(i) {
  if (i < 0 || !F.map) return 'Off the map';
  const m = F.map;
  if (m.height[i] < 0) return 'Cannot build on water';
  if (baseCell(i)) return 'That is a base';
  if (F.grid[i]) return 'Already built on';
  const x = colOf(i) + 0.5, y = rowOf(i) + 0.5;
  if (toBase(F.enemy, x, y) < ENEMY_KEEP_OUT) return 'Too close to the enemy base';
  if (F.bunkers.some(b => !b.dead && b.i === i)) return 'A bunker stands there';
  if (!F.reach[i]) return 'Out of build reach';
  return '';
}

export const canBuild = i => !whyNot(i);

/** Maximum health of a tower at its level and the current threat. */
function maxHp(t) {
  return Math.round(TOWER_HP[t.k] * Math.pow(TOWER_HP_LEVEL, t.l) * Math.pow(ARMS_GROWTH, threat() - 1) * meta.mods.towerHp);
}

/** Re-derive max health, keeping the same share of it. */
function refit(t) {
  const frac = t.max ? t.hp / t.max : 1;
  t.max = maxHp(t);
  t.hp = Math.max(1, Math.round(t.max * frac));
}

function makeTower(i, key, cost) {
  const t = {
    i, k: key, l: 0, cd: 0, ang: -0.4, kick: 0,
    spent: cost, focus: 0, lock: null, beam: null, ring: 0,
    cx: colOf(i), cy: rowOf(i), x: colOf(i) + 0.5, y: rowOf(i) + 0.5,
    elev: Math.max(0, F.map.height[i]), hp: 0, max: 0, hit: 0
  };
  t.max = t.hp = maxHp(t);
  return t;
}

export function place(i, key) {
  if (!meta.towerUnlocked(key)) { deny('Locked - unlock it in the Foundry'); return false; }
  const why = whyNot(i);
  if (why) { deny(why); return false; }
  const cost = buildCost(key);
  if (S.gold < cost) { deny('Not enough gold'); return false; }

  S.gold -= cost;
  const t = makeTower(i, key, cost);
  F.grid[i] = t;
  F.towers.push(t);
  refreshRoutes();
  sfx.place();
  S.selected = null;
  touch();
  return true;
}

export const convertCost = (t, key) => buildCost(key) - refundOf(t);

export function convert(t, key) {
  if (!alive(t) || t.k === key) return false;
  if (!meta.towerUnlocked(key)) { deny('Locked - unlock it in the Foundry'); return false; }
  const cost = buildCost(key);
  const net = cost - refundOf(t);
  if (net > S.gold) { deny('Not enough gold'); return false; }
  S.gold -= net;
  const fresh = makeTower(t.i, key, cost);
  // Damage carries over: swapping is not a free repair.
  fresh.hp = Math.max(1, Math.round(fresh.max * t.hp / t.max));
  F.grid[t.i] = fresh;
  F.towers[F.towers.indexOf(t)] = fresh;
  S.selected = fresh;
  if (net < 0) note(t.x, t.y, '+' + (-net), '#ffd76b');
  refreshRoutes();
  sfx.place();
  touch();
  return true;
}

export function sell(t) {
  if (!alive(t)) return;
  const back = refundOf(t);
  S.gold += back;
  note(t.x, t.y, '+' + back, '#ffd76b');
  remove(t);
  S.selected = null;
  sfx.sell();
  touch();
}

function remove(t) {
  if (!alive(t)) return;
  F.grid[t.i] = null;
  F.towers.splice(F.towers.indexOf(t), 1);
  refreshRoutes();
}

export function upgradeCost(t) {
  if (t.l >= maxTier()) return null;
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

export const alive = t => !!t && F.grid[t.i] === t;
export const allTowers = () => F.towers;

/** Range with the high-ground bonus folded in. */
export function rangeOf(t) {
  return statsOf(t).range * (1 + HIGH_GROUND_RANGE * (t.elev || 0));
}

/* ── your units ───────────────────────────────────────────────────────── */
export const squadSize = () => F.squad.trooper + F.squad.striker + F.squad.breaker;
export const unitPrice = key => unitCost(key, threat());
export const armoryPrice = () => armoryCost(F.armory, threat());

export function recruit(key) {
  if (S.phase === 'dead' || S.phase === 'menu') return false;
  if (F.units.length + squadSize() >= UNIT_CAP) { deny(`At most ${UNIT_CAP} units`); return false; }
  const cost = unitPrice(key);
  if (S.gold < cost) { deny('Not enough gold'); return false; }
  S.gold -= cost;
  F.squad[key]++;
  // Remember what was paid, so a squad disbanded before it leaves refunds.
  F.squadSpent = (F.squadSpent || 0) + cost;
  sfx.place();
  touch();
  return true;
}

/** Send the refund back for everything still waiting at the HQ. */
export function disband() {
  if (!squadSize()) return;
  S.gold += F.squadSpent || 0;
  F.squad = { trooper: 0, striker: 0, breaker: 0 };
  F.squadSpent = 0;
  sfx.sell();
  touch();
}

export function upgradeArmory() {
  const cost = armoryPrice();
  if (S.gold < cost) { deny('Not enough gold'); return false; }
  S.gold -= cost;
  F.armory++;
  sfx.upgrade();
  touch();
  return true;
}

/** Stats a unit is issued with right now. */
export function unitStats(key) {
  const def = UNITS[key];
  const kit = Math.pow(UNIT_GROWTH, threat() - 1) * Math.pow(ARMORY_MUL, F.armory);
  return {
    hp: Math.round(def.hp * kit * meta.mods.unitHp),
    dmg: def.dmg * kit * meta.mods.unitDmg
  };
}

/** Everything waiting at the HQ marches out now. */
export function deploy() {
  if (!squadSize() || S.phase === 'dead') return;
  const exits = hqExits();
  let n = 0;
  for (const key of ['breaker', 'trooper', 'striker']) {
    for (let k = 0; k < F.squad[key]; k++) {
      const def = UNITS[key];
      const st = unitStats(key);
      const spot = exits[n++ % exits.length];
      F.units.push({
        k: key, def, hp: st.hp, max: st.hp, dmg: st.dmg,
        x: colOf(spot) + 0.5 + (Math.random() - 0.5) * 0.4,
        y: rowOf(spot) + 0.5 + (Math.random() - 0.5) * 0.4,
        cc: spot, to: null, cd: Math.random() * def.rate, ang: 0, kick: 0, hit: 0,
        // Stagger the column so it does not leave as one blob.
        wait: n * 0.18,
        off: { x: (Math.random() - 0.5) * 0.35, y: (Math.random() - 0.5) * 0.35 },
        dead: false
      });
    }
  }
  S.tally.unitsSent += squadSize();
  F.squad = { trooper: 0, striker: 0, breaker: 0 };
  F.squadSpent = 0;
  note(F.hq.x, F.hq.y - 2, 'Squad deployed', '#a8ecbb');
  touch();
}

/** Walkable cells around the HQ that lead towards the enemy. */
function hqExits() {
  const out = [];
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      if (Math.abs(x) < 2 && Math.abs(y) < 2) continue;
      const i = at(F.hq.cx + x, F.hq.cy + y);
      if (F.flow.attack.dist[i] < Infinity) out.push(i);
    }
  }
  out.sort((a, b) => F.flow.attack.dist[a] - F.flow.attack.dist[b]);
  return out.length ? out.slice(0, 6) : [at(F.hq.cx + 2, F.hq.cy)];
}

/* ── spawning and movement ────────────────────────────────────────────── */
function enemyExits() {
  if (F.exitCache && F.exitCache.map === F.map) return F.exitCache.cells;
  const cells = [];
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      if (Math.abs(x) < 2 && Math.abs(y) < 2) continue;
      const i = at(F.enemy.cx + x, F.enemy.cy + y);
      if (F.flow.bold.dist[i] < Infinity) cells.push(i);
    }
  }
  F.exitCache = { map: F.map, cells: cells.length ? cells : [at(F.enemy.cx - 2, F.enemy.cy)] };
  return F.exitCache.cells;
}

function spawn(order) {
  const def = FOES[order.type];
  const arms = FOE_ARMS[order.type];
  const hp = Math.round(def.hp * order.hpMul);
  const exits = enemyExits();
  const cell = exits[Math.floor(Math.random() * exits.length)];
  S.foes.push({
    type: order.type, def, arms, hp, max: hp,
    spd: def.spd * order.spdMul,
    x: colOf(cell) + 0.5, y: rowOf(cell) + 0.5,
    cc: cell, to: null,
    // Cautious walkers read the danger map; a few take the bold road
    // anyway, so the enemy never commits everything to one lane.
    plan: arms.bold || Math.random() < 0.2 ? 'bold' : 'cautious',
    power: order.arms, cd: Math.random(), ang: Math.PI,
    off: { x: (Math.random() - 0.5) * 0.3, y: (Math.random() - 0.5) * 0.3 },
    slow: 0, slowLeft: 0, hit: 0, ph: Math.random() * 6.28,
    blockedBy: null, busy: false, dead: false
  });
}

function aimFoe(e) {
  const flow = F.flow[e.plan];
  const next = flow.next[e.cc];
  if (next === -1) { e.to = null; return; }
  if (baseCell(next) === 1) { e.to = { x: F.hq.x, y: F.hq.y, i: -2 }; return; }
  e.to = { x: colOf(next) + 0.5 + e.off.x, y: rowOf(next) + 0.5 + e.off.y, i: next };
}

function walkFoe(e, dt) {
  const speed = e.spd * (1 - e.slow);
  if (e.def.fly) {
    const dx = F.hq.x - e.x, dy = F.hq.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    e.ang = Math.atan2(dy, dx);
    if (d < HQ_HALF + 0.3) { breach(e); return; }
    e.x += dx / d * speed * dt;
    e.y += dy / d * speed * dt;
    return;
  }

  // Siege walkers hold still while they have a tower in their sights.
  if (e.busy) return;

  let left = speed * dt, guard = 0;
  while (left > 0 && guard++ < 6) {
    if (!e.to) aimFoe(e);
    if (!e.to) return;
    // A tower on the next cell: stop and knock it down.
    if (e.to.i >= 0 && F.grid[e.to.i]) { e.blockedBy = F.grid[e.to.i]; return; }
    e.blockedBy = null;
    const dx = e.to.x - e.x, dy = e.to.y - e.y;
    const d = Math.hypot(dx, dy);
    e.ang = Math.atan2(dy, dx);
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
  bump(S.tally.leaks, e.type);
  F.hq.hp -= e.arms.breach;
  F.hq.hit = 0.25;
  S.lives = Math.max(0, Math.round(F.hq.hp));
  S.shake = 0.6;
  sfx.breach();
  note(F.hq.x, F.hq.y - 1.6, '−' + e.arms.breach, '#ff5f6d');
  if (F.hq.hp <= 0) gameOver(false);
  touch();
}

function aimUnit(u) {
  const next = F.flow.attack.next[u.cc];
  if (next === -1) { u.to = null; return; }
  if (baseCell(next) === 2) { u.to = null; return; }
  u.to = { x: colOf(next) + 0.5 + u.off.x, y: rowOf(next) + 0.5 + u.off.y, i: next };
}

function walkUnit(u, dt) {
  let left = u.def.spd * dt, guard = 0;
  while (left > 0 && guard++ < 6) {
    if (!u.to) aimUnit(u);
    if (!u.to) return;
    const dx = u.to.x - u.x, dy = u.to.y - u.y;
    const d = Math.hypot(dx, dy);
    u.ang = Math.atan2(dy, dx);
    if (d <= left) {
      u.x = u.to.x; u.y = u.to.y; left -= d;
      u.cc = u.to.i; u.to = null;
    } else {
      u.x += dx / d * left; u.y += dy / d * left; left = 0;
    }
  }
}

/* ── damage ───────────────────────────────────────────────────────────── */
/** Hurt an enemy walker. `src` is a tower kind or 'unit'. */
function hurt(e, dmg, pierce, colour, crit, src, secs = 0) {
  if (e.dead) return;
  const soak = Math.max(0, e.def.armor - (pierce || 0));
  const dealt = dmg * (1 - soak) + titanShred(e, secs);
  if (src && src !== 'unit') bump(S.tally.dmg, src, Math.min(dealt, Math.max(0, e.hp)));
  e.hp -= dealt;
  e.hit = crit ? 0.2 : 0.12;
  if (crit) note(e.x, e.y - 0.35, 'CRIT', '#ffe08a');
  if (e.hp > 0) return;

  e.dead = true;
  S.kills++;
  bump(S.tally.kills, e.type);
  if (src === 'unit') S.tally.unitKills++;
  else if (src) bump(S.tally.towerKills, src);
  meta.noteKill();

  const gold = Math.round(e.def.gold * (1 + KILL_GOLD_GROWTH * threat()) * meta.mods.killGold);
  S.gold += gold;
  note(e.x, e.y, '+' + gold, '#ffd76b');
  award(e.def.score * KILL_POINTS * meta.mods.points);
  puff(e.x, e.y, e.def.boss ? 18 : 6, colour || e.def.col);
  if (e.def.boss) { sfx.boss(); S.shake = 0.7; }
  else if (Math.random() < 0.25) sfx.kill();
  touch();
}

/** Hurt one of yours: a tower, a unit, or the HQ is handled by breach. */
function harm(target, dmg) {
  if (target.dead || target.hp <= 0) return;
  target.hp -= dmg;
  target.hit = 0.12;
  if (target.hp > 0) return;

  if (target.def && target.def.role) {
    // a unit
    target.dead = true;
    S.tally.unitsLost++;
    puff(target.x, target.y, 6, target.def.col);
    if (Math.random() < 0.4) sfx.kill();
    return;
  }
  // a tower: gone for good
  S.tally.towersLost++;
  F.wrecks.push({ x: target.x, y: target.y, t: 3, col: TOWERS[target.k].color });
  puff(target.x, target.y, 12, TOWERS[target.k].color);
  note(target.x, target.y - 0.4, `${TOWERS[target.k].name} lost`, '#ff5f6d');
  S.shake = Math.max(S.shake, 0.4);
  sfx.breach();
  if (S.selected === target) S.selected = null;
  remove(target);
  touch();
}

/** Your units hitting a bunker or the enemy HQ. */
function hitStructure(b, dmg) {
  if (b.dead || b.hp <= 0) return;
  b.hp -= dmg;
  b.hit = 0.12;
  S.tally.baseDmg += Math.min(dmg, b.hp + dmg);
  if (b.hp > 0) return;
  if (b === F.enemy) { puff(b.x, b.y, 40, '#ff5f6d'); S.shake = 1; gameOver(true); return; }
  b.dead = true;
  puff(b.x, b.y, 16, '#ff5f6d');
  F.wrecks.push({ x: b.x, y: b.y, t: 4, col: '#ff5f6d' });
  note(b.x, b.y - 0.5, 'Bunker down', '#7ddf8f');
  const gold = Math.round(40 * (1 + KILL_GOLD_GROWTH * threat()) * meta.mods.killGold);
  S.gold += gold;
  sfx.blast();
  touch();
}

function chill(e, amount, duration) {
  const effective = amount * (1 - (e.def.slowRes || 0));
  if (effective <= 0.001) return;
  if (effective >= e.slow) { e.slow = effective; e.slowLeft = duration; }
  else e.slowLeft = Math.max(e.slowLeft, duration * 0.5);
}

function puff(x, y, n, c) {
  for (let k = 0; k < n; k++) {
    S.motes.push({ x, y, vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3, t: 0.45, c });
  }
}

/* ── towers fire ──────────────────────────────────────────────────────── */
/** Lower is nearer your HQ, so the leader is always shot first. */
function progress(e) {
  if (e.def.fly) return Math.hypot(F.hq.x - e.x, F.hq.y - e.y);
  const d = F.flow[e.plan].dist[e.cc];
  return d === Infinity || d === undefined ? 999 : d;
}

function acquire(t, def, range, hitsAir) {
  const spareBosses = def.kind === 'portal' && PORTAL_SPARES_BOSSES;
  let best = null, bestScore = Infinity;
  for (const e of S.foes) {
    if (e.dead) continue;
    if (e.def.fly && !hitsAir) continue;
    if (spareBosses && e.def.boss) continue;
    if (Math.hypot(e.x - t.x, e.y - t.y) > range) continue;
    const s = progress(e);
    if (s < bestScore) { bestScore = s; best = e; }
  }
  return best;
}

function tickTower(t, dt) {
  const def = TOWERS[t.k];
  const st = statsOf(t);
  const range = rangeOf(t);
  const hitsAir = def.kind === 'aura' ? meta.mods.frostAir
    : t.k === 'rocket' ? def.air || meta.mods.rocketAir
    : def.air;
  t.hit = Math.max(0, t.hit - dt);

  if (def.kind === 'factory') {
    t.spin = ((t.spin || 0) + dt * (S.phase === 'run' ? 2 : 0.3)) % 6.284;
    if (S.phase !== 'run') return;
    t.store = (t.store || 0) + st.yield * dt;
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
    t.ring = Math.max(0, (t.ring || 0) - dt * 3.2);
    if (t.cd > 0) return;
    let touched = 0;
    for (const e of S.foes) {
      if (e.dead || (e.def.fly && !hitsAir)) continue;
      if (Math.hypot(e.x - t.x, e.y - t.y) > range) continue;
      chill(e, st.slow, st.slowDur);
      hurt(e, st.dmg, st.pierce, def.color, false, t.k, st.rate);
      touched++;
    }
    if (touched) { t.cd = st.rate; t.ring = 1; sfx.freeze(); }
    else t.cd = 0.2;
    return;
  }

  const target = acquire(t, def, range, hitsAir);
  if (target) t.ang = Math.atan2(target.y - t.y, target.x - t.x);

  if (def.kind === 'beam') {
    if (!target) { t.beam = null; t.lock = null; t.focus = 0; return; }
    t.beam = target;
    t.focus = t.lock === target ? Math.min(2.2, t.focus + dt) : 0;
    t.lock = target;
    const ramp = 1 + (t.focus / 2.2) * st.ramp;
    hurt(target, st.dps * ramp * meta.critAverage() * dt, st.pierce, def.color, false, t.k, dt);
    return;
  }

  t.cd -= dt;
  if (!target || t.cd > 0) return;
  t.cd = st.rate;
  t.kick = 1;

  if (def.kind === 'chain') { fireChain(t, st, target); return; }
  if (def.kind === 'portal') { sendHome(target, def.color, t); return; }

  S.shots.push({
    k: t.k, x: t.x, y: t.y, tgt: target,
    spd: t.k === 'gun' ? 15 : 7.5 * meta.mods.rocketSpeed,
    dmg: st.dmg, pierce: st.pierce, splash: st.splash, air: hitsAir,
    crit: meta.rollCrit(), col: def.color, life: 2.2, src: t.k, secs: st.rate
  });
  if (t.k === 'rocket') sfx.rocket();
}

function fireChain(t, st, first) {
  const crit = meta.rollCrit();
  let damage = st.dmg * (crit ? meta.mods.critMult : 1);
  const points = [{ x: t.x, y: t.y }];
  const seen = new Set();
  let current = first;
  for (let jump = 0; jump < st.chains && current; jump++) {
    seen.add(current);
    points.push({ x: current.x, y: current.y });
    hurt(current, damage, st.pierce, TOWERS.tesla.color, crit && jump === 0, t.k, jump === 0 ? st.rate : 0);
    damage *= CHAIN_FALLOFF;
    let next = null, bestD = CHAIN_REACH;
    for (const e of S.foes) {
      if (e.dead || seen.has(e)) continue;
      const d = Math.hypot(e.x - current.x, e.y - current.y);
      if (d < bestD) { bestD = d; next = e; }
    }
    current = next;
  }
  if (points.length > 1) S.arcs.push({ points, t: 0.14 });
  sfx.arc();
}

/** A Portal drops the leader back at the enemy base. */
function sendHome(e, colour, t) {
  S.tally.warps++;
  S.warps.push({ x: e.x, y: e.y, fx: t.x, fy: t.y, t: 0.5, col: colour });
  const exits = enemyExits();
  const cell = exits[Math.floor(Math.random() * exits.length)];
  e.x = colOf(cell) + 0.5; e.y = rowOf(cell) + 0.5;
  if (!e.def.fly) { e.cc = cell; e.to = null; e.busy = false; e.blockedBy = null; }
  S.warps.push({ x: e.x, y: e.y, t: 0.5, col: colour });
  sfx.warp();
}

function tickShot(s, dt) {
  const target = s.tgt;
  const alive = target && !target.dead && !(target.hp <= 0);
  const gx = alive ? target.x : (s.gx ?? (s.gx = s.x + Math.cos(s.a || 0) * 3));
  const gy = alive ? target.y : (s.gy ?? (s.gy = s.y));
  const dx = gx - s.x, dy = gy - s.y;
  const d = Math.hypot(dx, dy) || 1;
  s.a = Math.atan2(dy, dx);
  s.life -= dt;
  const step = s.spd * dt;
  if (d > step && s.life > 0) { s.x += dx / d * step; s.y += dy / d * step; return true; }

  const mult = s.crit ? meta.mods.critMult : 1;
  if (s.splash) {
    S.blasts.push({ x: s.x, y: s.y, r: s.splash, t: 0.3, col: s.col });
    for (const e of S.foes) {
      if (e.dead || (e.def.fly && !s.air)) continue;
      const dd = Math.hypot(e.x - s.x, e.y - s.y);
      if (dd <= s.splash) hurt(e, s.dmg * mult * (1 - 0.45 * (dd / s.splash)), s.pierce, s.col, s.crit, s.src, e === target ? s.secs : 0);
    }
    sfx.blast();
  } else if (alive) {
    hurt(target, s.dmg * mult, s.pierce, s.col, s.crit, s.src, s.secs);
  }
  return false;
}

/* ── enemies fire back ────────────────────────────────────────────────── */
/**
 * What an armed enemy shoots: your units first (they are the ones shooting
 * at it), then towers. Siege weapons prefer towers. Unarmed walkers only
 * batter whatever tower blocks their road.
 */
function foeTarget(e, range) {
  let unit = null, ud = Infinity;
  for (const u of F.units) {
    if (u.dead) continue;
    const d = Math.hypot(u.x - e.x, u.y - e.y);
    if (d <= range && d < ud) { ud = d; unit = u; }
  }
  let tower = null, td = Infinity;
  for (const t of F.towers) {
    const d = Math.hypot(t.x - e.x, t.y - e.y);
    if (d <= range + 0.3 && d < td) { td = d; tower = t; }
  }
  if (e.arms.arm.siege) return tower || unit;
  return unit || tower;
}

function foeFire(e, dt) {
  e.cd -= dt;
  const arm = e.arms.arm;
  if (!arm) {
    // Unarmed: ram whatever is in the way.
    if (e.blockedBy && e.cd <= 0) {
      e.cd = 0.8;
      if (alive(e.blockedBy)) harm(e.blockedBy, RAM_DMG * e.power);
    }
    return;
  }

  const target = e.blockedBy && alive(e.blockedBy) ? e.blockedBy : foeTarget(e, arm.range);
  e.busy = !!(arm.siege && target && !target.def);
  if (!target) return;
  e.aim = Math.atan2(target.y - e.y, target.x - e.x);
  if (e.cd > 0) return;
  e.cd = arm.rate;
  F.bolts.push({ x: e.x, y: e.y, tgt: target, dmg: arm.dmg * e.power, spd: arm.siege ? 7 : 12, big: !!arm.siege, life: 1.5 });
}

function tickBunker(b, dt) {
  b.hit = Math.max(0, b.hit - dt);
  b.cd -= dt;
  let best = null, bd = BUNKER.range;
  for (const u of F.units) {
    if (u.dead) continue;
    const d = Math.hypot(u.x - b.x, u.y - b.y);
    if (d <= bd) { bd = d; best = u; }
  }
  if (!best) {
    for (const t of F.towers) {
      const d = Math.hypot(t.x - b.x, t.y - b.y);
      if (d <= bd) { bd = d; best = t; }
    }
  }
  if (!best) return;
  b.ang = Math.atan2(best.y - b.y, best.x - b.x);
  if (b.cd > 0) return;
  b.cd = BUNKER.rate;
  F.bolts.push({ x: b.x, y: b.y, tgt: best, dmg: b.dmg, spd: 9, big: true, life: 1.5 });
}

function tickBolt(s, dt) {
  const target = s.tgt;
  // A unit is live until it dies; a tower until it is sold or destroyed.
  const live = target && (target.def ? !target.dead : alive(target));
  if (!live) return false;
  const dx = target.x - s.x, dy = target.y - s.y;
  const d = Math.hypot(dx, dy) || 1;
  s.a = Math.atan2(dy, dx);
  s.life -= dt;
  const step = s.spd * dt;
  if (d > step && s.life > 0) { s.x += dx / d * step; s.y += dy / d * step; return true; }
  harm(target, s.dmg);
  if (s.big) S.blasts.push({ x: s.x, y: s.y, r: 0.45, t: 0.25, col: '#ff5f6d' });
  return false;
}

/* ── units fight ──────────────────────────────────────────────────────── */
function nearestFoe(u, range) {
  let best = null, bd = range;
  for (const e of S.foes) {
    if (e.dead) continue;
    const d = Math.hypot(e.x - u.x, e.y - u.y);
    if (d <= bd) { bd = d; best = e; }
  }
  return best;
}

function nearestStructure(u, range) {
  let best = null, bd = range;
  for (const b of F.bunkers) {
    if (b.dead) continue;
    const d = Math.hypot(b.x - u.x, b.y - u.y) - 0.3;
    if (d <= bd) { bd = d; best = b; }
  }
  if (!best && toBase(F.enemy, u.x, u.y) <= range) best = F.enemy;
  return best;
}

function tickUnit(u, dt) {
  u.hit = Math.max(0, u.hit - dt);
  u.kick = Math.max(0, u.kick - dt * 6);
  if (u.wait > 0) { u.wait -= dt; return; }

  const def = u.def;
  const building = nearestStructure(u, def.range);
  const foe = def.role === 'raider' ? null : nearestFoe(u, def.range);
  const target = def.role === 'escort' ? (foe || building) : (building || foe);

  if (!target) { walkUnit(u, dt); u.cd = Math.max(0, u.cd - dt); return; }
  // Raiders keep running for the buildings and only stop at one.
  u.ang = Math.atan2(target.y - u.y, target.x - u.x);
  u.cd -= dt;
  if (u.cd > 0) return;
  u.cd = def.rate;
  u.kick = 1;

  const isFoe = !!target.def && !target.def.role;
  if (isFoe) {
    if (def.splash) {
      S.blasts.push({ x: target.x, y: target.y, r: def.splash, t: 0.25, col: def.col });
      for (const e of S.foes) {
        if (!e.dead && Math.hypot(e.x - target.x, e.y - target.y) <= def.splash) hurt(e, u.dmg, 0.3, def.col, false, 'unit');
      }
    } else {
      hurt(target, u.dmg, 0.2, def.col, false, 'unit');
    }
  } else {
    hitStructure(target, u.dmg * def.vsBase);
    if (def.splash) S.blasts.push({ x: target.x, y: target.y, r: 0.6, t: 0.25, col: def.col });
  }
  S.arcs.push({ points: [{ x: u.x, y: u.y }, { x: target.x, y: target.y }], t: 0.06, col: def.col, tracer: true });
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

/* ── frame ────────────────────────────────────────────────────────────── */
export function update(dt) {
  if (S.paused || S.suspended || S.phase === 'dead' || S.phase === 'menu') return;

  S.shake = Math.max(0, S.shake - dt * 2.5);
  S.waveFlash = Math.max(0, S.waveFlash - dt);
  S.warn = Math.max(0, S.warn - dt);
  F.hq.hit = Math.max(0, F.hq.hit - dt);
  F.enemy.hit = Math.max(0, F.enemy.hit - dt);

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
    foeFire(e, dt);
    if (S.phase === 'dead') return;
    walkFoe(e, dt);
    if (S.phase === 'dead') return;
    e.hit = Math.max(0, e.hit - dt);
    e.ph += dt * 9;
    if (e.slowLeft > 0) { e.slowLeft -= dt; if (e.slowLeft <= 0) e.slow = 0; }
  }

  for (const t of [...F.towers]) {
    if (!alive(t)) continue;
    tickTower(t, dt);
    t.kick = Math.max(0, t.kick - dt * 7);
  }
  for (const b of F.bunkers) if (!b.dead) tickBunker(b, dt);
  for (const u of F.units) {
    if (u.dead) continue;
    tickUnit(u, dt);
    if (S.phase === 'dead') return;
  }

  S.shots = S.shots.filter(s => tickShot(s, dt));
  F.bolts = F.bolts.filter(s => tickBolt(s, dt));

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

  S.foes = S.foes.filter(e => !e.dead);
  if (F.units.some(u => u.dead)) { F.units = F.units.filter(u => !u.dead); touch(); }
}
