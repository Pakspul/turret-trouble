/* ══ Turret Trouble · static configuration ═══════════════════════════════
   Pure data and grid helpers. Nothing in here imports anything else.     */

/* ── grid ─────────────────────────────────────────────────────────────── */
export const COLS = 20, ROWS = 10;
export const SPAWN_R = 4, GOAL_R = 5;

export const idx = (c, r) => r * COLS + c;
export const cx = i => i % COLS;
export const cy = i => (i / COLS) | 0;

export const SPAWN = idx(0, SPAWN_R);
export const GOAL = idx(COLS - 1, GOAL_R);

/** Column 0 is the entry lane and the last column is the exit lane. */
export const buildable = i => cx(i) > 0 && cx(i) < COLS - 1;

/* ── run baselines (before Foundry modifiers) ─────────────────────────── */
export const BASE_START_GOLD = 240;
export const BASE_LIVES = 3;
export const CRIT_MULT = 3;
export const BREAK_SECONDS = 9;

/* ── the economy curve ────────────────────────────────────────────────────
   The two currencies pull in opposite directions on purpose.

   Gold stays close to linear. Enemy health compounds every wave, but a
   tower tops out at level 4, so the only lasting way to keep up is to own
   more towers - and each extra tower of a kind costs more than the last.
   The grid fills slowly, and a run ends when the board can no longer
   out-damage the health curve.

   Points are the opposite: nearly all of them are paid for *holding* a
   wave, on a curve that bends upward. Early waves are cheap to clear and
   pay accordingly, so no amount of farming wave 5 funds the Foundry.     */

/** Every tower of the same kind already on the grid raises the next one. */
export const BUILD_ESCALATION = 1.055;
/** Kill gold grows linearly with the wave, never exponentially. */
export const KILL_GOLD_GROWTH = 0.03;
/** Gold for holding a wave, and for calling the next one early. */
export const clearGold = w => Math.round(18 + w * 4);
export const earlyCallGold = w => Math.round(6 + w * 1.5);

/** Only unspent gold up to this ceiling earns interest, so hoarding caps
    out instead of compounding into a second economy. */
export const interestCap = w => 300 + 40 * w;

/** Points for holding a wave - the bulk of Foundry income, back-loaded. */
export const wavePoints = w => 0.7 * Math.pow(w, 1.6);
/** Kills pay a thin trickle on top, flat across the whole run. */
export const KILL_POINTS = 0.20;

/* ── game speed ───────────────────────────────────────────────────────── */
export const SPEEDS = [1, 2, 3];
/** The first Overdrive rank adds this; every further rank adds 1× more. */
export const OVERDRIVE_SPEED = 4;
/** The fastest Overdrive can go once every rank is bought. */
export const OVERDRIVE_TOP = 10;
/** Added only in developer mode - see dev.js. */
export const DEV_SPEED = 10;

/** Top speed for a given number of Overdrive ranks (0 = no Overdrive). */
export const overdriveTop = l => (l > 0 ? Math.min(OVERDRIVE_TOP, OVERDRIVE_SPEED + l - 1) : SPEEDS[SPEEDS.length - 1]);

/** The speed button's ladder: 1-3×, a few stops on the way, then the top. */
export function speedSteps(top) {
  const steps = [...SPEEDS];
  for (const stop of [4, 6, 8]) if (stop < top) steps.push(stop);
  if (top > steps[steps.length - 1]) steps.push(top);
  return steps;
}

/* ── towers ───────────────────────────────────────────────────────────────
   kind drives which tick routine runs:
     shot  - fires a homing projectile (optionally splash)
     beam  - continuous damage that ramps while locked on one target
     aura  - pulses a ring, applying a slow to everything inside
     chain - fires an instant arc that jumps between nearby foes
     portal - on a long cooldown, sends the leading foe back to the spawn
     factory - never fires; mints Cores while a wave is running
   `unlock` names a Foundry node that must be owned before it can be built.
   Level 4 of every tower is gated behind the `proto` node. Past level 4
   there is no ceiling: see levelStats() and levelUpCost() below.
   `cost` is the price of the *first* one; see buildCost() in game.js.    */
export const TOWERS = {
  gun: {
    name: 'Gun', color: '#4cc9f0', kind: 'shot', air: true, cost: 55,
    blurb: 'rapid single shot',
    lv: [
      { range: 2.7, dmg: 9,  rate: 0.33, pierce: 0.00 },
      { range: 3.0, dmg: 16, rate: 0.28, pierce: 0.10, up: 50 },
      { range: 3.4, dmg: 27, rate: 0.23, pierce: 0.15, up: 120 },
      { range: 3.7, dmg: 44, rate: 0.19, pierce: 0.22, up: 280 }
    ]
  },
  rocket: {
    name: 'Rocket', color: '#f4a259', kind: 'shot', air: false, cost: 145,
    blurb: 'splash · ground only',
    lv: [
      { range: 3.6, dmg: 54,  rate: 1.70, splash: 1.00, pierce: 0.25 },
      { range: 4.0, dmg: 92,  rate: 1.60, splash: 1.15, pierce: 0.30, up: 135 },
      { range: 4.4, dmg: 155, rate: 1.50, splash: 1.35, pierce: 0.35, up: 310 },
      { range: 4.7, dmg: 250, rate: 1.40, splash: 1.55, pierce: 0.42, up: 700 }
    ]
  },
  laser: {
    name: 'Laser', color: '#e05c9e', kind: 'beam', air: true, cost: 110,
    blurb: 'beam · burns armour',
    lv: [
      { range: 2.5, dps: 23,  pierce: 0.55, ramp: 1.4 },
      { range: 2.9, dps: 40,  pierce: 0.60, ramp: 1.5, up: 100 },
      { range: 3.3, dps: 66,  pierce: 0.65, ramp: 1.6, up: 240 },
      { range: 3.6, dps: 104, pierce: 0.72, ramp: 1.8, up: 540 }
    ]
  },
  frost: {
    name: 'Cryo', color: '#6fd8ff', kind: 'aura', air: false, cost: 90,
    blurb: 'pulses · slows ground', unlock: 'frost',
    lv: [
      { range: 2.4, dmg: 5,  rate: 0.90, slow: 0.35, slowDur: 1.2, pierce: 0.30 },
      { range: 2.7, dmg: 9,  rate: 0.85, slow: 0.45, slowDur: 1.4, pierce: 0.35, up: 85 },
      { range: 3.0, dmg: 15, rate: 0.80, slow: 0.55, slowDur: 1.6, pierce: 0.40, up: 190 },
      { range: 3.3, dmg: 24, rate: 0.75, slow: 0.65, slowDur: 1.8, pierce: 0.45, up: 430 }
    ]
  },
  tesla: {
    name: 'Tesla', color: '#c9a7ff', kind: 'chain', air: true, cost: 175,
    blurb: 'arcs between targets', unlock: 'tesla',
    lv: [
      { range: 2.6, dmg: 26,  rate: 0.85, chains: 2, pierce: 0.40 },
      { range: 2.9, dmg: 44,  rate: 0.78, chains: 3, pierce: 0.45, up: 160 },
      { range: 3.2, dmg: 72,  rate: 0.70, chains: 4, pierce: 0.50, up: 360 },
      { range: 3.5, dmg: 118, rate: 0.62, chains: 5, pierce: 0.58, up: 800 }
    ]
  },
  portal: {
    name: 'Portal', color: '#7cf0b5', kind: 'portal', air: true, cost: 260,
    blurb: 'sends the leader back to spawn', unlock: 'portal',
    lv: [
      { range: 3.0, rate: 9.0 },
      { range: 3.3, rate: 7.5, up: 220 },
      { range: 3.6, rate: 6.2, up: 480 },
      { range: 3.9, rate: 5.0, up: 1000 }
    ]
  },
  factory: {
    name: 'Core Factory', color: '#ffd76b', kind: 'factory', air: false, cost: 200,
    blurb: 'mints Cores during waves', unlock: 'factory',
    lv: [
      { range: 0, yield: 0.25 },
      { range: 0, yield: 0.40, up: 160 },
      { range: 0, yield: 0.60, up: 360 },
      { range: 0, yield: 0.90, up: 800 }
    ]
  }
};

export const TOWER_ORDER = ['gun', 'rocket', 'laser', 'frost', 'tesla', 'portal', 'factory'];

/** Titans shrug off a Portal; everything else can be sent home. */
export const PORTAL_SPARES_BOSSES = true;
/** Endless Portal levels shorten the cooldown by this factor, to a floor. */
export const PORTAL_ENDLESS_RATE = 0.93;
export const PORTAL_MIN_RATE = 1.5;

/* ── endless levels ───────────────────────────────────────────────────────
   Level 5 and beyond extend the last authored tier forever. Each extra
   level multiplies damage, while its price grows a little faster than the
   damage does, so every rank is still a real decision in a long run.     */
/** Damage multiplier per level past the last authored tier. */
export const ENDLESS_DMG = 1.25;
/** Upgrade price multiplier per level past the last authored tier. */
export const ENDLESS_COST = 1.45;
/** Range added per extra level, up to ENDLESS_RANGE_CAP in total. */
export const ENDLESS_RANGE = 0.08;
export const ENDLESS_RANGE_CAP = 0.8;

/** Stats of a tower kind at level index `l` (0-based, unbounded). */
export function levelStats(def, l) {
  const last = def.lv.length - 1;
  if (l <= last) return def.lv[l];
  const extra = l - last;
  const top = def.lv[last];
  const grow = Math.pow(ENDLESS_DMG, extra);
  return {
    ...top,
    range:  top.range ? top.range + Math.min(ENDLESS_RANGE_CAP, ENDLESS_RANGE * extra) : 0,
    dmg:    top.dmg != null ? top.dmg * grow : undefined,
    dps:    top.dps != null ? top.dps * grow : undefined,
    yield:  top.yield != null ? top.yield * grow : undefined,
    rate:   def.kind === 'portal'
      ? Math.max(PORTAL_MIN_RATE, top.rate * Math.pow(PORTAL_ENDLESS_RATE, extra))
      : top.rate,
    pierce: Math.min(0.9, (top.pierce || 0) + 0.01 * extra),
    up:     levelUpCost(def, l)
  };
}

/** Gold to reach level index `l` from the one below it. */
export function levelUpCost(def, l) {
  const last = def.lv.length - 1;
  if (l <= last) return def.lv[l].up;
  return Math.round(def.lv[last].up * Math.pow(ENDLESS_COST, l - last) / 5) * 5;
}

/** Arc jump distance, in grid cells. */
export const CHAIN_REACH = 1.7;
/** Each jump keeps this fraction of the previous hit's damage. */
export const CHAIN_FALLOFF = 0.75;

/* ── enemies ──────────────────────────────────────────────────────────────
   `score` is the point value that funds the Foundry; `gold` is in-run only.
   `slowRes` (0-1) reduces the effect of Cryo pulses.                      */
export const FOES = {
  grunt:   { name: 'Grunt',   hp: 34,   spd: 1.15, armor: 0.00, gold: 6,   score: 3,   rad: 0.30, col: '#8fe08a' },
  runner:  { name: 'Runner',  hp: 21,   spd: 2.25, armor: 0.00, gold: 5,   score: 3,   rad: 0.24, col: '#f2e06b' },
  tank:    { name: 'Tank',    hp: 135,  spd: 0.72, armor: 0.45, gold: 15,  score: 10,  rad: 0.40, col: '#7fa8e8' },
  flyer:   { name: 'Flyer',   hp: 48,   spd: 1.55, armor: 0.10, gold: 10,  score: 7,   rad: 0.27, col: '#c58bf0', fly: true },
  bulwark: { name: 'Bulwark', hp: 100,  spd: 0.95, armor: 0.68, gold: 13,  score: 9,   rad: 0.34, col: '#8fe4dc', slowRes: 0.25 },
  swarm:   { name: 'Swarm',   hp: 13,   spd: 1.75, armor: 0.00, gold: 2,   score: 1,   rad: 0.17, col: '#ff9a7a' },
  spectre: { name: 'Spectre', hp: 90,   spd: 1.90, armor: 0.20, gold: 14,  score: 12,  rad: 0.28, col: '#ffb3f0', fly: true, slowRes: 1 },
  titan:   { name: 'Titan',   hp: 1500, spd: 0.55, armor: 0.50, gold: 150, score: 120, rad: 0.52, col: '#ff5f6d', boss: true, slowRes: 0.5 }
};

/** Wave number at which each type joins the spawn pool, with its weight. */
export const SPAWN_TABLE = [
  { type: 'grunt',   from: 1,  weight: 10 },
  { type: 'runner',  from: 2,  weight: 7 },
  { type: 'tank',    from: 4,  weight: 6 },
  { type: 'flyer',   from: 6,  weight: 6 },
  { type: 'bulwark', from: 9,  weight: 5 },
  { type: 'swarm',   from: 12, weight: 8 },
  { type: 'spectre', from: 15, weight: 5 }
];

/* ══ Frontier ════════════════════════════════════════════════════════════
   The second mode, opened by holding wave 100 in Holdout. A seeded map of
   low ground, hills and plateaus replaces the grid; enemies march out of a
   base on the far side, pick their own route, and shoot back. You answer
   with counter-waves of your own units. Same towers, same Foundry, same
   Cores - only the battlefield is new.                                   */

/** Holdout wave that opens Frontier. Developer mode skips the wait. */
export const FRONTIER_UNLOCK_WAVE = 100;

/** Map size in cells. Bigger than a screen on purpose: you scroll it. */
export const MAP_W = 52, MAP_H = 32;

/** Terrain classes. Heights 0-2 are land; a cliff separates two heights
    unless one side is a ramp. Water only lets flyers over. */
export const WATER = -1;

/** Every sector plays like Holdout this many waves deep, from its wave 1. */
export const sectorDepth = s => 10 * s;
/** Wave number the enemy stats, gold and points are read at. */
export const threatOf = (s, w) => sectorDepth(s) + w;

/** Towers on higher ground see further: this much range per height. */
export const HIGH_GROUND_RANGE = 0.12;
/** Cells from the HQ, or from any of your towers, where you may build. */
export const BUILD_REACH = 5;
/** No building this close to the enemy HQ. */
export const ENEMY_KEEP_OUT = 8;

/** Each HQ is a 3x3 block; this is its half-width in cells. */
export const HQ_HALF = 1.5;
/** Integrity of your HQ before Reinforced Core. */
export const HQ_INTEGRITY = 100;
/** Integrity each Reinforced Core rank adds in Frontier. */
export const HQ_INTEGRITY_PER_CORE = 25;

/** How much a tower standing on a cell costs a walker's route planner:
    going through means stopping to knock it down. */
export const TOWER_PATH_COST = 14;
/** Extra route cost per tower covering a cell, for cautious walkers. */
export const DANGER_COST = 1.4;

/* ── structure health ─────────────────────────────────────────────────────
   In Frontier your towers can be shot. Health grows with level and with
   the threat, the same way enemy weapons do, and every tower is patched
   back to full at the end of each wave it survives. A tower that falls is
   gone - there is no refund on rubble.                                   */
export const TOWER_HP = { gun: 220, rocket: 260, laser: 240, frost: 260, tesla: 280, portal: 320, factory: 300 };
export const TOWER_HP_LEVEL = 1.35;
/** Enemy weapons and structure health both climb this much per threat. */
export const ARMS_GROWTH = 1.10;

/* ── how each enemy fights back ───────────────────────────────────────────
   `arm` is the weapon (null = unarmed). `siege` walkers stop to fire at a
   tower in reach; everyone else shoots on the move. `bold` walkers ignore
   your kill zones when they plan a route; the rest go around if they can.
   `breach` is the integrity a foe knocks off your HQ when it gets there.  */
export const FOE_ARMS = {
  grunt:   { arm: { range: 2.0, dmg: 5,  rate: 0.9 },             breach: 4 },
  runner:  { arm: null,                                          breach: 4,  bold: true },
  tank:    { arm: { range: 3.0, dmg: 26, rate: 1.8, siege: true }, breach: 10 },
  flyer:   { arm: { range: 1.1, dmg: 16, rate: 1.4 },            breach: 6 },
  bulwark: { arm: null,                                          breach: 8,  bold: true },
  swarm:   { arm: { range: 0.7, dmg: 2,  rate: 0.5 },            breach: 1 },
  spectre: { arm: { range: 2.4, dmg: 9,  rate: 0.5 },            breach: 8 },
  titan:   { arm: { range: 3.6, dmg: 90, rate: 2.4, siege: true }, breach: 35, bold: true }
};
/** An unarmed walker blocked by a tower batters it for this, scaled. */
export const RAM_DMG = 6;

/* ── your units ───────────────────────────────────────────────────────────
   Bought into a squad between waves; the squad marches on the enemy base
   when the next wave is sent (or straight away, with Deploy). A unit is
   issued at the current threat, so late recruits hit harder and cost
   more. `role` decides what it stops for:
     escort - fights anything hostile in reach, structures last
     raider - ignores enemy troops and runs for the buildings
     siege  - prefers structures, fights troops only when nothing else is
   `vsBase` multiplies damage against bunkers and the HQ.                */
export const UNITS = {
  trooper: { name: 'Trooper', cost: 45,  hp: 150, spd: 1.25, range: 2.2, dmg: 15,  rate: 0.55, vsBase: 1,   role: 'escort', col: '#a8ecbb', blurb: 'rifles · fights anything' },
  striker: { name: 'Striker', cost: 80,  hp: 95,  spd: 2.5,  range: 1.9, dmg: 28,  rate: 0.5,  vsBase: 1.5, role: 'raider', col: '#ffe08a', blurb: 'fast · runs for buildings' },
  breaker: { name: 'Breaker', cost: 190, hp: 560, spd: 0.8,  range: 3.0, dmg: 110, rate: 1.8,  vsBase: 2.5, role: 'siege',  col: '#f4a259', blurb: 'siege tank · wrecks bases', splash: 0.9 }
};
export const UNIT_ORDER = ['trooper', 'striker', 'breaker'];
/** Unit power per threat - a little under enemy health, so waiting is no
    free lunch, but a unit bought late is still a unit worth having. */
export const UNIT_GROWTH = 1.12;
/** Unit price per threat, linear like gold. */
export const unitCost = (key, threat) => Math.round(UNITS[key].cost * (1 + 0.05 * threat) / 5) * 5;
/** Most units you can have alive and queued at once. Numbers alone must
    not raze a base on wave 1; the threat has to grow into your kit. */
export const UNIT_CAP = 16;
/** In-run Armory: each level multiplies unit health and damage. Priced by
    the threat as well, so a deep sector's war chest cannot buy it out. */
export const ARMORY_MUL = 1.22;
export const armoryCost = (l, threat) => Math.round(160 * Math.pow(1.5, l) * (1 + 0.05 * threat) / 5) * 5;

/* ── the enemy base ───────────────────────────────────────────────────────
   Static for now: an HQ and a ring of bunkers, sized by sector. It never
   rebuilds. Raze the HQ and the sector is yours.                        */
/** Your units grow with the threat and the base does not, so every base
    ripens eventually. Sector 1 is ripe around wave 10; each sector after
    holds out two waves longer, and those waves are deeper ones.       */
export const baseRipeWave = s => 8 + 2 * s;
export const baseScale = s => Math.pow(UNIT_GROWTH, sectorDepth(s) + baseRipeWave(s));
export const ENEMY_HQ_HP = 60000;
export const BUNKER = { hp: 5000, range: 3.4, dmg: 60, rate: 1.2 };
export const bunkerCount = s => Math.min(7, 2 + Math.ceil(s / 2));
/** Cores for razing a sector's base, on top of everything else. */
export const sectorBounty = s => Math.round(18 * wavePoints(sectorDepth(s) + 20));

/* ── the Foundry: permanent upgrades bought with Cores ────────────────────
   Every node is `max` levels deep and costs base * growth^level, rounded to
   the nearest 5. `value` renders the running total at a given level so the
   card can show what the next purchase actually buys.

   Most scaling nodes are ENDLESS: they never read "Fully upgraded", so a
   long career keeps finding something to spend Cores on. The growth factor
   is the only brake - every rank costs a fixed multiple of the last.      */
/** `max` for a node with no final rank. */
export const ENDLESS = Infinity;

/** Requisition compounds, so no number of ranks makes turrets free. */
export const requisitionMul = l => Math.pow(0.97, l);
/** Overcharge stops adding chance at 100%; ranks past that add crit damage. */
export const CRIT_STEP = 0.03;
export const CRIT_OVERFLOW_MULT = 0.1;
export const critChance = l => Math.min(1, CRIT_STEP * l);
export const critMult = l => CRIT_MULT + CRIT_OVERFLOW_MULT * Math.max(0, l - Math.ceil(1 / CRIT_STEP));

export const FOUNDRY = [
  {
    id: 'logistics', name: 'Logistics', hint: 'More gold, sooner.',
    nodes: [
      { id: 'seed',     name: 'Seed Capital',      max: ENDLESS, base: 120, growth: 1.45,
        step: '+20 starting gold',
        blurb: 'Pre-loads the vault before wave 1 so the opening build is stronger.',
        value: l => `${BASE_START_GOLD + 20 * l} gold at wave 1` },
      { id: 'bounty',   name: 'Bounty Optics',     max: ENDLESS, base: 180, growth: 1.50,
        step: '+5% gold per kill',
        blurb: 'Every kill pays out more during the run.',
        value: l => `+${5 * l}% kill gold` },
      { id: 'dividend', name: 'Wave Dividend',     max: ENDLESS, base: 200, growth: 1.55,
        step: '+10% wave-clear payout',
        blurb: 'Fatter bonus each time you hold a wave.',
        value: l => `+${10 * l}% clear bonus` },
      { id: 'interest', name: 'Compound Interest', max: ENDLESS, base: 400, growth: 1.60,
        step: '+2% of unspent gold per wave',
        blurb: 'Banking gold between waves earns you more of it. Only the first 300 + 40 per wave counts, so it pays for patience, not for a fortune.',
        value: l => `+${2 * l}% interest` },
      { id: 'requisition', name: 'Requisition',      max: ENDLESS, base: 220, growth: 1.50,
        step: '-3% tower build cost (compounding)',
        blurb: 'Trims the price of every turret, including the escalation on your tenth Gun. Each rank takes 3% off what is left.',
        value: l => `-${Math.round((1 - requisitionMul(l)) * 100)}% build cost` }
    ]
  },
  {
    id: 'ordnance', name: 'Ordnance', hint: 'Hit harder, hit faster.',
    nodes: [
      { id: 'munitions',  name: 'Kinetic Munitions', max: ENDLESS, base: 140, growth: 1.45,
        step: '+6% Gun damage',
        blurb: 'Denser slugs out of every Gun barrel.',
        value: l => `+${6 * l}% Gun damage` },
      { id: 'warheads',   name: 'Warheads',          max: ENDLESS, base: 190, growth: 1.48,
        step: '+7% Rocket damage',
        blurb: 'Heavier payload on every Rocket.',
        value: l => `+${7 * l}% Rocket damage` },
      { id: 'lens',       name: 'Focusing Lens',     max: ENDLESS, base: 175, growth: 1.48,
        step: '+7% Laser damage',
        blurb: 'Tighter beam, more energy on target.',
        value: l => `+${7 * l}% Laser damage` },
      { id: 'guidance',   name: 'Guidance Chips',    max: ENDLESS, base: 220, growth: 1.50,
        step: '+14% Rocket speed, +4% blast radius',
        blurb: 'Rockets that actually catch what they were aimed at.',
        value: l => `+${14 * l}% speed · +${4 * l}% blast` },
      { id: 'loaders',    name: 'Rapid Loaders',     max: ENDLESS, base: 260, growth: 1.55,
        step: '+4% fire rate (all towers)',
        blurb: 'Shorter reload cycle across the whole grid.',
        value: l => `+${4 * l}% fire rate` },
      { id: 'ap',         name: 'AP Rounds',         max: ENDLESS, base: 210, growth: 1.50,
        step: '+3 armour pierce',
        blurb: 'Cuts through Tank and Bulwark plating.',
        value: l => `+${3 * l} pierce` },
      { id: 'barrels',    name: 'Long Barrels',      max: 6, base: 230, growth: 1.55,
        step: '+4% range (all towers)',
        blurb: 'Every tower covers more of the grid.',
        value: l => `+${4 * l}% range` },
      { id: 'crit',       name: 'Overcharge',        max: ENDLESS, base: 300, growth: 1.55,
        step: `+3% chance of a ×${CRIT_MULT} hit`,
        blurb: `Occasional devastating shots. Beams get the average instead. Past 100% chance, each rank adds +${CRIT_OVERFLOW_MULT}× crit damage.`,
        value: l => `${Math.round(critChance(l) * 100)}% crit chance · ×${critMult(l).toFixed(1)} hit` }
    ]
  },
  {
    id: 'tech', name: 'Tech Branch', hint: 'One-time unlocks that change the build.',
    nodes: [
      { id: 'frost',      name: 'Cryo Emitter',    max: 1, base: 500,  growth: 1,
        step: 'Unlocks the Cryo tower',
        blurb: 'A pulsing slow field. Deals little damage but buys everything else time.' },
      { id: 'tesla',      name: 'Arc Node',        max: 1, base: 900,  growth: 1,
        step: 'Unlocks the Tesla tower',
        blurb: 'Instant lightning that jumps between clustered enemies.' },
      { id: 'deepfreeze', name: 'Deep Freeze',     max: 1, base: 700,  growth: 1, req: 'frost',
        step: 'Cryo hits air, +15% slow',
        blurb: 'Cryo pulses reach flyers and bite noticeably harder.' },
      { id: 'cryocoils',  name: 'Cryo Coils',      max: ENDLESS, base: 260, growth: 1.40, req: 'frost',
        step: '+8% Cryo damage, +3% slow, +3% chill time',
        blurb: 'Small steps, but they add up: late waves need a Cryo that still holds the line.',
        value: l => `+${8 * l}% damage · +${3 * l}% slow · +${3 * l}% chill` },
      { id: 'flak',       name: 'Flak Warheads',   max: 1, base: 4000, growth: 1, minWave: 40,
        step: 'Rockets also hit air',
        blurb: 'Proximity fuses let every Rocket and its splash reach flyers. Only unlocks once you have held wave 40.' },
      { id: 'capacitors', name: 'Capacitors',      max: ENDLESS, base: 240,  growth: 1.50, req: 'tesla',
        step: '+7% Tesla damage',
        blurb: 'More charge stored between arcs.',
        value: l => `+${7 * l}% Tesla damage` },
      { id: 'overload',   name: 'Overload Coils',  max: ENDLESS, base: 800,  growth: 1.60, req: 'tesla',
        step: '+1 arc jump',
        blurb: 'Each Tesla shot chains to more targets.',
        value: l => `+${l} extra jump${l === 1 ? '' : 's'}` },
      { id: 'portal',     name: 'Portal Lab',      max: 1, base: 1200, growth: 1,
        step: 'Unlocks the Portal tower',
        blurb: 'A slow gun that opens a portal under the leading enemy and drops it back at the spawn. Titans are too heavy to send.' },
      { id: 'phase',      name: 'Phase Tuning',    max: ENDLESS, base: 350, growth: 1.50, req: 'portal',
        step: '-4% Portal cooldown (compounding)',
        blurb: 'Recharges the portal faster, so it sends more of the wave home.',
        value: l => `-${Math.round((1 - Math.pow(0.96, l)) * 100)}% Portal cooldown` },
      { id: 'factory',    name: 'Core Factory',    max: 1, base: 1500, growth: 1,
        step: 'Unlocks the Core Factory',
        blurb: 'A passive building that mints Cores every second a wave is running. It deals no damage, so every factory is a turret you did not build.' },
      { id: 'refinery',   name: 'Core Refinery',   max: ENDLESS, base: 400, growth: 1.50, req: 'factory',
        step: '+15% Core Factory output',
        blurb: 'Every factory on the grid mints Cores faster.',
        value: l => `+${15 * l}% factory output` },
      { id: 'proto',      name: 'Prototype Cores', max: 1, base: 1600, growth: 1,
        step: 'Unlocks tower level 4',
        blurb: 'A fourth upgrade tier on every tower. Expensive in-run, but decisive.' }
    ]
  },
  {
    id: 'command', name: 'Command', hint: 'Survive longer, learn more.',
    nodes: [
      { id: 'core',      name: 'Reinforced Core', max: 3, base: 350, growth: 1.70,
        step: '+1 breach you can survive',
        blurb: 'A thicker margin for error at the exit gate.',
        value: l => `${BASE_LIVES + l} breaches` },
      { id: 'repair',    name: 'Field Repair',    max: 1, base: 750, growth: 1,
        step: 'Regain 1 breach every 8 waves',
        blurb: 'Clearing eight waves patches the line back up, to your maximum.' },
      { id: 'recon',     name: 'Recon Uplink',    max: 1, base: 200, growth: 1,
        step: 'Preview the next wave',
        blurb: 'See exactly what is queued up while you build.' },
      { id: 'overdrive', name: 'Overdrive',       max: OVERDRIVE_TOP - OVERDRIVE_SPEED + 1, base: 250, growth: 2.2,
        step: `+1× top speed, up to ${OVERDRIVE_TOP}×`,
        blurb: 'Push through the early waves faster. The first rank is cheap; the rest are not.',
        value: l => `${overdriveTop(l)}× top speed` },
      { id: 'drills',    name: 'Rapid Deployment', max: BREAK_SECONDS, base: 300, growth: 1.45,
        step: '-1 s between waves',
        blurb: 'Shortens the break before the next wave rolls in, all the way down to none at all.',
        value: l => (l >= BREAK_SECONDS ? 'no break between waves' : `${BREAK_SECONDS - l} s between waves`) },
      { id: 'headstart', name: 'Head Start',      max: ENDLESS, base: 6000, growth: 1.9,
        minWave: l => 30 + 10 * l,
        step: 'Skip 10 more opening waves',
        blurb: 'Every run begins after a boss. The skipped waves are paid out in full - gold, kills and points - as if you had held them.',
        value: l => `runs start at wave ${10 * l + 1}` },
      { id: 'siphon',    name: 'Data Siphon',     max: ENDLESS, base: 250, growth: 1.60,
        step: '+10% points earned',
        blurb: 'Every run funds the Foundry faster.',
        value: l => `+${10 * l}% points` }
    ]
  },
  {
    id: 'field', name: 'Field Command', hint: 'Frontier only: units, walls and reach.',
    nodes: [
      { id: 'drill',    name: 'Drill Sergeants',   max: ENDLESS, base: 900, growth: 1.50, minWave: FRONTIER_UNLOCK_WAVE,
        step: '+8% unit damage',
        blurb: 'Every Trooper, Striker and Breaker you field hits harder.',
        value: l => `+${8 * l}% unit damage` },
      { id: 'plating',  name: 'Composite Plating', max: ENDLESS, base: 900, growth: 1.50, minWave: FRONTIER_UNLOCK_WAVE,
        step: '+8% unit health',
        blurb: 'Your counter-waves live long enough to reach the bunkers.',
        value: l => `+${8 * l}% unit health` },
      { id: 'hardened', name: 'Hardened Emplacements', max: ENDLESS, base: 800, growth: 1.45, minWave: FRONTIER_UNLOCK_WAVE,
        step: '+10% tower health',
        blurb: 'In Frontier the enemy shoots back. Thicker plating keeps your turrets standing.',
        value: l => `+${10 * l}% tower health` },
      { id: 'depots',   name: 'Forward Depots',    max: 4, base: 1500, growth: 1.8, minWave: FRONTIER_UNLOCK_WAVE,
        step: '+1 build reach',
        blurb: 'Build further out from the HQ and from each of your towers.',
        value: l => `${BUILD_REACH + l} cells of build reach` }
    ]
  }
];

/** Flat id -> node lookup; each node also learns which group it sits in. */
export const NODES = {};
for (const group of FOUNDRY) {
  for (const node of group.nodes) {
    node.group = group.id;
    NODES[node.id] = node;
  }
}

/** Best wave needed before the next rank of a node can be bought. */
export function nodeMinWave(node, level) {
  if (!node.minWave) return 0;
  return typeof node.minWave === 'function' ? node.minWave(level) : node.minWave;
}

/** Cost of the next rank of a node, given its current level. */
export function nodeCost(node, level) {
  if (level >= node.max) return Infinity;
  return Math.round(node.base * Math.pow(node.growth, level) / 5) * 5;
}
