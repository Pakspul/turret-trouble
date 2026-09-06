/* Headless smoke test: drives the simulation with no DOM. */
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
const field = await import('../public/js/field.js');

const { S } = game;

function assert(cond, msg) {
  if (!cond) { console.error('ASSERT FAILED:', msg); process.exitCode = 1; }
}

meta.init();
game.bindProjection(u => u * 10, u => u * 10);

/* ── 1. baseline run ─────────────────────────────────────────── */
game.newRun();
assert(S.gold === 240, `start gold should be 240, got ${S.gold}`);
assert(S.lives === 3, `start lives should be 3, got ${S.lives}`);
assert(S.phase === 'build', 'phase should be build');
assert(field.field.path.length > 1, 'a route should exist on a fresh grid');

/* ── 2. building ─────────────────────────────────────────────── */
const at = (c, r) => cfg.idx(c, r);
assert(game.buildCost('gun') === 55, `first gun should cost 55, got ${game.buildCost('gun')}`);
assert(game.place(at(3, 4), 'gun'), 'should be able to place a gun');
assert(S.gold === 240 - 55, `gold should drop by 55, got ${S.gold}`);
assert(!game.place(at(3, 4), 'gun'), 'should not stack towers on one cell');
assert(!game.place(at(0, 4), 'gun'), 'spawn lane is not buildable');
assert(!game.place(at(5, 5), 'frost'), 'locked tower must not be placeable');

/* ── 2b. build cost escalates per kind, refunds are total ────── */
assert(game.buildCost('gun') > 55, 'a second gun should cost more than the first');
assert(game.buildCost('rocket') === cfg.TOWERS.rocket.cost,
  'escalation is per kind, so a rocket is still at base price');

S.gold = 5000;
const escalate = [];
for (let n = 0; n < 8; n++) {
  escalate.push(game.buildCost('gun'));
  assert(game.place(at(5 + n, 1), 'gun'), `should place gun ${n + 2}`);
}
// prices round to the nearest 5, so neighbours can tie - the trend cannot
assert(escalate.every((c, n) => n === 0 || c >= escalate[n - 1]),
  `gun prices must never drop: ${escalate}`);
assert(escalate[escalate.length - 1] > escalate[0] * 1.3,
  `the ninth gun should be markedly dearer than the second: ${escalate}`);

const ninth = field.field.grid[at(12, 1)];
const beforeSell = S.gold;
game.sell(ninth);
assert(S.gold - beforeSell === ninth.spent,
  `selling should return every gold spent, got ${S.gold - beforeSell} of ${ninth.spent}`);

/* upgrades are refunded too */
const keep = field.field.grid[at(5, 1)];
game.upgrade(keep);
assert(keep.l === 1, 'tower should have upgraded');
const beforeSell2 = S.gold, spent2 = keep.spent;
game.sell(keep);
assert(S.gold - beforeSell2 === spent2, 'refund should include upgrade spend');

/* ── 2c. swapping a tower for another kind ───────────────────── */
game.clearGrid();
S.gold = 5000;
game.place(at(4, 3), 'gun');
const swapCell = field.field.grid[at(4, 3)];
const swapNet = game.convertCost(swapCell, 'rocket');
assert(swapNet === cfg.TOWERS.rocket.cost - swapCell.spent,
  `swap should cost the rocket less a full gun refund, got ${swapNet}`);
const beforeSwap = S.gold;
assert(game.convert(swapCell, 'rocket'), 'should swap gun to rocket');
assert(S.gold === beforeSwap - swapNet, 'swap should charge exactly the net');
const swapped = field.field.grid[at(4, 3)];
assert(swapped.k === 'rocket' && swapped.l === 0, 'swapped tower is a fresh level-1 rocket');
assert(!game.convert(swapped, 'frost'), 'must not swap into a locked kind');

/* swapping back down is a refund, not a charge */
const backNet = game.convertCost(swapped, 'gun');
assert(backNet < 0, `swapping to a cheaper kind should pay out, got ${backNet}`);
const beforeBack = S.gold;
assert(game.convert(swapped, 'gun'), 'should swap rocket back to gun');
assert(S.gold === beforeBack - backNet, 'the refund should land in the purse');
game.clearGrid();

/* seal test: wall off column 3 entirely and confirm the last cell is refused */
game.clearGrid();
S.gold = 100000;
let placed = 0;
for (let r = 0; r < cfg.ROWS; r++) if (game.place(at(3, r), 'gun')) placed++;
assert(placed === cfg.ROWS - 1, `a full wall must be refused; placed ${placed} of ${cfg.ROWS}`);

/* ── 3. a full run at speed ──────────────────────────────────── */
game.newRun();
S.gold = 100000;
const spots = [[2,3],[2,5],[4,4],[4,6],[6,3],[6,5],[8,4],[10,4],[12,5],[14,4]];
for (const [c, r] of spots) game.place(at(c, r), 'gun');
game.place(at(5, 2), 'rocket');
game.place(at(9, 7), 'laser');
S.gold = 100000;

let frames = 0;
const startCores = meta.profile.cores;
while (S.phase !== 'dead' && frames < 60 * 60 * 10) {
  if (S.phase === 'build' || S.phase === 'break') game.startWave();
  game.update(1 / 60);
  frames++;
}
assert(S.wavesCleared > 0, `should clear at least one wave, cleared ${S.wavesCleared}`);
assert(S.score > 0, 'should score points');
assert(meta.profile.cores > startCores, 'points should bank into cores');
assert(meta.profile.stats.kills > 0, 'kills should be recorded');
console.log(`run: wave ${S.wave}, cleared ${S.wavesCleared}, score ${S.score}, kills ${S.kills}, cores ${meta.profile.cores}`);

/* ── 4. foundry purchases and their effect ───────────────────── */
meta.profile.cores = 50000;
assert(meta.buy('seed'), 'should buy Seed Capital');
assert(meta.mods.startGold === 260, `start gold mod should be 260, got ${meta.mods.startGold}`);
assert(!meta.available(cfg.NODES.deepfreeze), 'Deep Freeze needs Cryo Emitter first');
assert(!meta.buy('deepfreeze'), 'gated node must not be purchasable');
assert(meta.buy('frost'), 'should unlock Cryo');
assert(meta.available(cfg.NODES.deepfreeze), 'Deep Freeze should open after Cryo');
assert(meta.buy('deepfreeze'), 'should buy Deep Freeze');
assert(meta.mods.frostAir === true, 'Deep Freeze should let Cryo hit air');
assert(meta.buy('tesla'), 'should unlock Tesla');
assert(meta.buy('core'), 'should buy Reinforced Core');
assert(meta.mods.lives === 4, `lives mod should be 4, got ${meta.mods.lives}`);

game.newRun();
assert(S.gold === 260, `start gold should reflect Seed Capital, got ${S.gold}`);
assert(S.lives === 4 && S.maxLives === 4, `lives should be 4, got ${S.lives}`);
assert(meta.towerUnlocked('frost') && meta.towerUnlocked('tesla'), 'towers should be unlocked');
S.gold = 100000;
assert(game.place(at(5, 5), 'frost'), 'Cryo should place once unlocked');
assert(game.place(at(7, 4), 'tesla'), 'Tesla should place once unlocked');

/* ── 5. tier gate ────────────────────────────────────────────── */
const gunCell = at(9, 4);
game.place(gunCell, 'gun');
const gun = field.field.grid[gunCell];
game.upgrade(gun); game.upgrade(gun);
assert(gun.l === 2, `gun should reach level 3 without Prototype Cores, got ${gun.l + 1}`);
assert(game.upgradeCost(gun) === null, 'level 4 should be gated');
meta.buy('proto');
assert(game.upgradeCost(gun) === 280, `level 4 should cost 280, got ${game.upgradeCost(gun)}`);
game.upgrade(gun);
assert(gun.l === 3, 'gun should reach level 4 with Prototype Cores');

/* ── 6. slow, chain and crit paths all execute ───────────────── */
meta.buy('crit'); meta.buy('crit');
game.newRun();
S.gold = 100000;
for (const [c, r] of [[3,4],[5,4],[7,4],[9,4]]) game.place(at(c, r), 'frost');
for (const [c, r] of [[3,6],[5,6],[7,6]]) game.place(at(c, r), 'tesla');
game.place(at(11, 4), 'laser');
game.place(at(13, 4), 'rocket');
game.startWave();
let sawSlow = false, sawArc = false;
for (let n = 0; n < 60 * 90 && S.phase !== 'dead'; n++) {
  game.update(1 / 60);
  if (S.foes.some(e => e.slow > 0)) sawSlow = true;
  if (S.arcs.length) sawArc = true;
  if (S.phase === 'break') break;
}
assert(sawSlow, 'Cryo should have slowed something');
assert(sawArc, 'Tesla should have produced an arc');

/* ── 7. persistence round-trip ───────────────────────────────── */
meta.persistNow();
const before = { cores: meta.profile.cores, levels: { ...meta.profile.levels } };
meta.init();
assert(meta.profile.cores === before.cores, 'cores should survive a reload');
assert(meta.profile.levels.seed === before.levels.seed, 'levels should survive a reload');

/* an out-of-range saved level must be clamped, not trusted */
mem.set('turret-trouble:profile:v1', JSON.stringify({ cores: 5, levels: { seed: 999, bogus: 4 }, stats: {} }));
meta.init();
assert(meta.levelOf('seed') === cfg.NODES.seed.max, 'oversized saved level should clamp to max');
assert(meta.levelOf('bogus') === 0, 'unknown node should be dropped');

/* ── 7b. the speed ladder ────────────────────────────────────── */
game.newRun();
S.dev = false;
assert(!game.speedLadder().includes(cfg.DEV_SPEED), 'dev speed is off by default');
assert(!game.speedLadder().includes(cfg.OVERDRIVE_SPEED), '4× needs the Overdrive node');
for (let n = 0; n < cfg.SPEEDS.length; n++) game.cycleSpeed();
assert(S.speed === 1, 'cycling the whole ladder should wrap back to 1×');

S.dev = true;
assert(game.speedLadder().includes(cfg.DEV_SPEED), 'dev mode should add 10×');
const ladder = game.speedLadder();
S.speed = ladder[ladder.length - 2];
game.cycleSpeed();
assert(S.speed === cfg.DEV_SPEED, `should reach ${cfg.DEV_SPEED}×, got ${S.speed}`);
S.dev = false;

meta.profile.cores = 50000;
meta.buy('overdrive');
assert(game.speedLadder().includes(cfg.OVERDRIVE_SPEED), 'Overdrive should add 4×');

/* ── 8. dps readouts for every tower kind ────────────────────── */
/* step 7 replaced the profile, so re-unlock before touching new towers */
meta.profile.cores = 50000;
meta.buy('frost'); meta.buy('tesla');
game.newRun();
S.gold = 100000;
for (const [n, k] of cfg.TOWER_ORDER.entries()) {
  const cellIdx = at(2 + n * 2, 2);
  assert(game.place(cellIdx, k), `should place ${k}`);
  const dps = game.dpsOf(field.field.grid[cellIdx]);
  assert(Number.isFinite(dps) && dps > 0, `${k} dps should be a positive number, got ${dps}`);
}

console.log(process.exitCode ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED');
