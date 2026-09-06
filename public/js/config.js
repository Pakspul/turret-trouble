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
/** Added by the Overdrive node. */
export const OVERDRIVE_SPEED = 4;
/** Added only in developer mode - see dev.js. */
export const DEV_SPEED = 10;

/* ── towers ───────────────────────────────────────────────────────────────
   kind drives which tick routine runs:
     shot  - fires a homing projectile (optionally splash)
     beam  - continuous damage that ramps while locked on one target
     aura  - pulses a ring, applying a slow to everything inside
     chain - fires an instant arc that jumps between nearby foes
   `unlock` names a Foundry node that must be owned before it can be built.
   Level 4 of every tower is gated behind the `proto` node.
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
  }
};

export const TOWER_ORDER = ['gun', 'rocket', 'laser', 'frost', 'tesla'];

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

/* ── the Foundry: permanent upgrades bought with Cores ────────────────────
   Every node is `max` levels deep and costs base * growth^level, rounded to
   the nearest 5. `value` renders the running total at a given level so the
   card can show what the next purchase actually buys.                     */
export const FOUNDRY = [
  {
    id: 'logistics', name: 'Logistics', hint: 'More gold, sooner.',
    nodes: [
      { id: 'seed',     name: 'Seed Capital',      max: 10, base: 120, growth: 1.45,
        step: '+20 starting gold',
        blurb: 'Pre-loads the vault before wave 1 so the opening build is stronger.',
        value: l => `${BASE_START_GOLD + 20 * l} gold at wave 1` },
      { id: 'bounty',   name: 'Bounty Optics',     max: 8, base: 180, growth: 1.50,
        step: '+5% gold per kill',
        blurb: 'Every kill pays out more during the run.',
        value: l => `+${5 * l}% kill gold` },
      { id: 'dividend', name: 'Wave Dividend',     max: 6, base: 200, growth: 1.55,
        step: '+10% wave-clear payout',
        blurb: 'Fatter bonus each time you hold a wave.',
        value: l => `+${10 * l}% clear bonus` },
      { id: 'interest', name: 'Compound Interest', max: 5, base: 400, growth: 1.60,
        step: '+2% of unspent gold per wave',
        blurb: 'Banking gold between waves earns you more of it. Only the first 300 + 40 per wave counts, so it pays for patience, not for a fortune.',
        value: l => `+${2 * l}% interest` },
      { id: 'requisition', name: 'Requisition',      max: 6, base: 220, growth: 1.50,
        step: '-3% tower build cost',
        blurb: 'Trims the price of every turret, including the escalation on your tenth Gun.',
        value: l => `-${3 * l}% build cost` }
    ]
  },
  {
    id: 'ordnance', name: 'Ordnance', hint: 'Hit harder, hit faster.',
    nodes: [
      { id: 'munitions',  name: 'Kinetic Munitions', max: 8, base: 140, growth: 1.45,
        step: '+6% Gun damage',
        blurb: 'Denser slugs out of every Gun barrel.',
        value: l => `+${6 * l}% Gun damage` },
      { id: 'warheads',   name: 'Warheads',          max: 8, base: 190, growth: 1.48,
        step: '+7% Rocket damage',
        blurb: 'Heavier payload on every Rocket.',
        value: l => `+${7 * l}% Rocket damage` },
      { id: 'lens',       name: 'Focusing Lens',     max: 8, base: 175, growth: 1.48,
        step: '+7% Laser damage',
        blurb: 'Tighter beam, more energy on target.',
        value: l => `+${7 * l}% Laser damage` },
      { id: 'guidance',   name: 'Guidance Chips',    max: 5, base: 220, growth: 1.50,
        step: '+14% Rocket speed, +4% blast radius',
        blurb: 'Rockets that actually catch what they were aimed at.',
        value: l => `+${14 * l}% speed · +${4 * l}% blast` },
      { id: 'loaders',    name: 'Rapid Loaders',     max: 6, base: 260, growth: 1.55,
        step: '+4% fire rate (all towers)',
        blurb: 'Shorter reload cycle across the whole grid.',
        value: l => `+${4 * l}% fire rate` },
      { id: 'ap',         name: 'AP Rounds',         max: 6, base: 210, growth: 1.50,
        step: '+3 armour pierce',
        blurb: 'Cuts through Tank and Bulwark plating.',
        value: l => `+${3 * l} pierce` },
      { id: 'barrels',    name: 'Long Barrels',      max: 6, base: 230, growth: 1.55,
        step: '+4% range (all towers)',
        blurb: 'Every tower covers more of the grid.',
        value: l => `+${4 * l}% range` },
      { id: 'crit',       name: 'Overcharge',        max: 6, base: 300, growth: 1.55,
        step: `+3% chance of a ×${CRIT_MULT} hit`,
        blurb: 'Occasional devastating shots. Beams get the average instead.',
        value: l => `${3 * l}% crit chance` }
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
      { id: 'capacitors', name: 'Capacitors',      max: 6, base: 240,  growth: 1.50, req: 'tesla',
        step: '+7% Tesla damage',
        blurb: 'More charge stored between arcs.',
        value: l => `+${7 * l}% Tesla damage` },
      { id: 'overload',   name: 'Overload Coils',  max: 2, base: 800,  growth: 1.60, req: 'tesla',
        step: '+1 arc jump',
        blurb: 'Each Tesla shot chains to more targets.',
        value: l => `+${l} extra jump${l === 1 ? '' : 's'}` },
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
      { id: 'overdrive', name: 'Overdrive',       max: 1, base: 250, growth: 1,
        step: `Unlocks ${OVERDRIVE_SPEED}× speed`,
        blurb: 'Push through the early waves faster.' },
      { id: 'siphon',    name: 'Data Siphon',     max: 6, base: 250, growth: 1.60,
        step: '+10% points earned',
        blurb: 'Every run funds the Foundry faster.',
        value: l => `+${10 * l}% points` }
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

/** Cost of the next rank of a node, given its current level. */
export function nodeCost(node, level) {
  if (level >= node.max) return Infinity;
  return Math.round(node.base * Math.pow(node.growth, level) / 5) * 5;
}
