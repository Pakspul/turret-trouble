/* Headless balance probe: plays greedy auto-builds and reports the per-wave
   gold, score and board-fill curve. Not an assertion suite - it exists so a
   balance change can be compared against the previous numbers.

   usage: node test/balance.mjs [maxWaves] [foundryProfile]
          foundryProfile: none | mid | full   (default none)               */

const mem = new Map();
globalThis.window = {
  localStorage: {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k)
  }
};

const cfg = await import('../public/js/config.js');
const meta = await import('../public/js/meta.js');
const game = await import('../public/js/game.js');
const fieldMod = await import('../public/js/field.js');

const { S } = game;
const { field } = fieldMod;

const MAX_WAVES = Number(process.argv[2]) || 40;
const PROFILE = process.argv[3] || 'none';

meta.init();
game.bindProjection(u => u * 10, u => u * 10);

if (PROFILE !== 'none') {
  meta.profile.cores = 1e9;
  const share = PROFILE === 'full' ? 1 : 0.5;
  for (const group of cfg.FOUNDRY) {
    for (const node of group.nodes) {
      const want = Math.max(node.max === 1 ? 1 : 1, Math.round(node.max * share));
      for (let n = 0; n < want; n++) meta.buy(node.id);
    }
  }
  meta.profile.cores = 0;
}

/* ── a rational, joyless builder ──────────────────────────────────────────
   Every build phase it repeatedly buys whatever adds the most damage per
   gold - a new turret next to the route, or the next level on one it owns.
   It is not a good player (it never repositions and never reads the wave),
   but it spends sensibly, so the curve it produces says more about the
   economy than about the strategy.                                       */
function nearRoute() {
  const route = field.path;
  const spots = [];
  for (let i = 0; i < cfg.COLS * cfg.ROWS; i++) {
    if (!cfg.buildable(i) || field.grid[i]) continue;
    const c = cfg.cx(i), r = cfg.cy(i);
    let best = 99;
    for (const cell of route) {
      const d = Math.abs(cfg.cx(cell) - c) + Math.abs(cfg.cy(cell) - r);
      if (d < best) best = d;
    }
    spots.push({ i, d: best });
  }
  return spots.sort((a, b) => a.d - b.d).map(s => s.i);
}

/** Air-blind turrets are worth less than their damage suggests. */
const airWeight = k => (cfg.TOWERS[k].air || k === 'frost' ? 1 : 0.72);

function bestBuy() {
  let best = null;

  for (const k of cfg.TOWER_ORDER) {
    if (!meta.towerUnlocked(k)) continue;
    const cost = game.buildCost(k);
    if (cost > S.gold) continue;
    const worth = game.dpsOf({ k, l: 0 }) * airWeight(k) / cost;
    if (!best || worth > best.worth) best = { worth, kind: k };
  }

  for (const t of field.grid) {
    if (!t) continue;
    const cost = game.upgradeCost(t);
    if (cost == null || cost > S.gold) continue;
    const gain = game.dpsOf({ k: t.k, l: t.l + 1 }) - game.dpsOf(t);
    const worth = gain * airWeight(t.k) / cost;
    if (!best || worth > best.worth) best = { worth, tower: t };
  }

  return best;
}

function build() {
  let guard = 0;
  while (guard++ < 500) {
    const buy = bestBuy();
    if (!buy) break;
    if (buy.tower) { game.upgrade(buy.tower); continue; }

    let placed = false;
    for (const i of nearRoute().slice(0, 30)) {
      if (game.place(i, buy.kind)) { placed = true; break; }
    }
    if (!placed) break;
  }
}

/* ── play ─────────────────────────────────────────────────────────────── */
game.newRun();

const rows = [];
let lastScore = 0, lastCores = meta.profile.cores;

while (S.phase !== 'dead' && S.wave < MAX_WAVES) {
  build();
  const goldAtStart = S.gold;
  game.startWave();

  let frames = 0;
  while (S.phase === 'run' && frames < 60 * 300) { game.update(1 / 60); frames++; }
  if (S.phase === 'dead') break;

  const towers = field.grid.filter(Boolean).length;
  rows.push({
    wave: S.wave,
    towers,
    fill: (towers / ((cfg.COLS - 2) * cfg.ROWS) * 100).toFixed(0) + '%',
    goldIn: S.gold - goldAtStart,
    gold: S.gold,
    score: S.score,
    dScore: S.score - lastScore,
    cores: meta.profile.cores,
    lives: S.lives
  });
  lastScore = S.score;

  // burn the break so the loop does not stall in it
  S.phase = 'build';
}

lastCores;
const pad = (v, n) => String(v).padStart(n);
console.log(`profile=${PROFILE}  towers unlocked: ${cfg.TOWER_ORDER.filter(k => meta.towerUnlocked(k)).join(',')}`);
console.log('wave  towers  fill   goldIn    gold   dScore    score    cores  lives');
for (const r of rows) {
  if (r.wave % 1 === 0) {
    console.log(
      pad(r.wave, 4), pad(r.towers, 7), pad(r.fill, 6), pad(r.goldIn, 8),
      pad(r.gold, 7), pad(r.dScore, 8), pad(r.score, 8), pad(r.cores, 8), pad(r.lives, 6)
    );
  }
}
const last = rows[rows.length - 1];
console.log(`\nend: wave ${S.wave} (${S.phase}), score ${S.score}, cores ${meta.profile.cores}, towers ${last ? last.towers : 0}`);

const foundryTotal = cfg.FOUNDRY.reduce((sum, g) => sum + g.nodes.reduce((s, n) => {
  let c = 0;
  for (let l = 0; l < n.max; l++) c += cfg.nodeCost(n, l);
  return s + c;
}, 0), 0);
console.log(`foundry costs ${foundryTotal} cores in total - this run funded ${(meta.profile.cores / foundryTotal * 100).toFixed(1)}% of it`);
