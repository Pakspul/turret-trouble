/* ══ the Foundry ═════════════════════════════════════════════════════════
   Everything that outlives a single run: banked Cores, purchased upgrade
   levels, and the derived modifier bundle the game reads every frame.    */

import {
  NODES, nodeCost, nodeMinWave, TOWERS,
  BASE_START_GOLD, BASE_LIVES, BREAK_SECONDS, FRONTIER_UNLOCK_WAVE,
  HQ_INTEGRITY, HQ_INTEGRITY_PER_CORE, BUILD_REACH,
  overdriveTop, speedSteps, requisitionMul, critChance, critMult
} from './config.js';
import * as store from './storage.js';

const BLANK = () => ({
  cores: 0,
  levels: {},
  stats: { bestWave: 0, runs: 0, kills: 0, lifetimePoints: 0, bestScore: 0 },
  /** Frontier: highest sector razed, and how many sorties were flown. */
  frontier: { cleared: 0, runs: 0, bestWaves: 0 }
});

export const profile = BLANK();

/** Derived multipliers, rebuilt whenever `levels` changes. */
export const mods = {};

/** Bumped on every recompute, so UI caches know when to redraw. */
export const revision = { n: 0 };

const lv = id => profile.levels[id] || 0;

/** True once a one-time unlock has been bought. */
export function has(id) {
  return lv(id) > 0;
}
export function levelOf(id) {
  return lv(id);
}

/** A node is only purchasable once its prerequisite is owned. */
export function available(node) {
  return !node.req || has(node.req);
}

/** Best wave the next rank of a node asks for (0 when it asks for none). */
export function waveNeeded(node) {
  return nodeMinWave(node, lv(node.id));
}

/** True once the player has held enough waves for the node's next rank. */
export function reached(node) {
  return profile.stats.bestWave >= waveNeeded(node);
}

export function costOf(id) {
  return nodeCost(NODES[id], lv(id));
}

export function canAfford(id) {
  const node = NODES[id];
  return available(node) && reached(node) && lv(id) < node.max && profile.cores >= costOf(id);
}

export function buy(id) {
  if (!canAfford(id)) return false;
  profile.cores -= costOf(id);
  profile.levels[id] = lv(id) + 1;
  recompute();
  persist();
  return true;
}

/** Points banked mid-run so a refresh never costs the player progress. */
export function addPoints(points) {
  profile.cores += points;
  profile.stats.lifetimePoints += points;
}

export function noteRunEnd(wave, score) {
  const s = profile.stats;
  s.runs++;
  s.bestWave = Math.max(s.bestWave, wave);
  s.bestScore = Math.max(s.bestScore, score);
  persist();
}

export function noteKill() {
  profile.stats.kills++;
}

/** Frontier opens once Holdout has been held to wave 100 (or in dev mode). */
export function frontierUnlocked(dev = false) {
  return dev || profile.stats.bestWave >= FRONTIER_UNLOCK_WAVE;
}

/** Bank a finished Frontier sortie. Holdout's best wave is left alone. */
export function noteFrontierEnd(sector, won, waves) {
  const f = profile.frontier;
  f.runs++;
  f.bestWaves = Math.max(f.bestWaves, waves);
  if (won) f.cleared = Math.max(f.cleared, sector);
  persist();
}

/** True once Head Start is owned, so a new run can open past wave 1. */
export function headStartOwned() {
  return mods.skipWaves > 0;
}

/* ── derived modifiers ─────────────────────────────────────────────────── */
export function recompute() {
  const dmg = {};
  for (const key of Object.keys(TOWERS)) dmg[key] = 1;
  dmg.gun    += 0.06 * lv('munitions');
  dmg.rocket += 0.07 * lv('warheads');
  dmg.laser  += 0.07 * lv('lens');
  dmg.tesla  += 0.07 * lv('capacitors');
  dmg.frost  += 0.08 * lv('cryocoils');

  Object.assign(mods, {
    startGold:   BASE_START_GOLD + 20 * lv('seed'),
    lives:       BASE_LIVES + lv('core'),
    buildCost:   requisitionMul(lv('requisition')),
    killGold:    1 + 0.05 * lv('bounty'),
    waveGold:    1 + 0.10 * lv('dividend'),
    interest:    0.02 * lv('interest'),
    points:      1 + 0.10 * lv('siphon'),

    dmg,
    // Lower `rate` means a shorter reload, so fire-rate ranks divide it.
    rate:        1 / (1 + 0.04 * lv('loaders')),
    range:       1 + 0.04 * lv('barrels'),
    pierce:      0.03 * lv('ap'),
    splash:      1 + 0.04 * lv('guidance'),
    rocketSpeed: 1 + 0.14 * lv('guidance'),
    crit:        critChance(lv('crit')),
    critMult:    critMult(lv('crit')),

    chainBonus:  lv('overload'),
    slowBonus:   (has('deepfreeze') ? 0.15 : 0) + 0.03 * lv('cryocoils'),
    chillTime:   1 + 0.03 * lv('cryocoils'),
    frostAir:    has('deepfreeze'),
    rocketAir:   has('flak'),
    portalRate:  Math.pow(0.96, lv('phase')),
    factoryYield: 1 + 0.15 * lv('refinery'),

    // Past Prototype Cores there is no ceiling on tower levels.
    maxTier:     has('proto') ? Infinity : 2,
    repair:      has('repair'),
    recon:       has('recon'),
    breakTime:   Math.max(0, BREAK_SECONDS - lv('drills')),
    skipWaves:   10 * lv('headstart'),
    speeds:      speedSteps(overdriveTop(lv('overdrive'))),

    // Frontier: Reinforced Core thickens the HQ instead of adding hearts.
    integrity:   HQ_INTEGRITY + HQ_INTEGRITY_PER_CORE * lv('core'),
    unitDmg:     1 + 0.08 * lv('drill'),
    unitHp:      1 + 0.08 * lv('plating'),
    towerHp:     1 + 0.10 * lv('hardened'),
    buildReach:  BUILD_REACH + lv('depots')
  });

  revision.n++;
}

/** Beams and auras cannot roll a crit, so they take the average uplift. */
export function critAverage() {
  return 1 + mods.crit * (mods.critMult - 1);
}

/** A single crit roll for discrete shots. */
export function rollCrit() {
  return Math.random() < mods.crit;
}

/** Towers whose unlock node has not been bought cannot be built. */
export function towerUnlocked(key) {
  const def = TOWERS[key];
  return !def.unlock || has(def.unlock);
}

/* ── save / load ───────────────────────────────────────────────────────── */
let pending = 0;

export function persist() {
  clearTimeout(pending);
  pending = setTimeout(() => store.save(profile), 250);
}

/** Flush immediately - used on pagehide, where a timer would not fire. */
export function persistNow() {
  clearTimeout(pending);
  store.save(profile);
}

export function init() {
  const saved = store.load();
  if (saved && typeof saved === 'object') {
    profile.cores = Math.max(0, Number(saved.cores) || 0);
    profile.levels = {};
    // Drop unknown ids and clamp levels, so an older save cannot inflate a
    // node past its current maximum. Endless nodes have none to clamp to.
    for (const [id, value] of Object.entries(saved.levels || {})) {
      if (!NODES[id]) continue;
      profile.levels[id] = Math.max(0, Math.min(NODES[id].max, Number(value) || 0));
    }
    Object.assign(profile.stats, BLANK().stats, saved.stats || {});
    profile.frontier = Object.assign(BLANK().frontier, saved.frontier || {});
    // Older saves carry a `headStartOff` switch; the choice is now made per
    // run on the start screen, so it is dropped here.
  }
  recompute();
}

export function resetProfile() {
  const blank = BLANK();
  profile.cores = blank.cores;
  profile.levels = blank.levels;
  profile.stats = blank.stats;
  profile.frontier = blank.frontier;
  recompute();
  store.wipe();
  store.save(profile);
}

export { store };
