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
const { buildWave } = await import('../public/js/waves.js');

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
assert(S.tally.dmg.gun > 0 && S.tally.dmg.rocket > 0 && S.tally.dmg.laser > 0,
  `every tower kind should be credited with damage, got ${JSON.stringify(S.tally.dmg)}`);
const byTower = Object.values(S.tally.towerKills).reduce((a, b) => a + b, 0);
assert(byTower === S.kills, `every kill should go to a tower, ${byTower} vs ${S.kills}`);
assert(Object.values(S.tally.leaks).reduce((a, b) => a + b, 0) >= S.maxLives, 'the leaks that broke the line are counted');
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
mem.set('turret-trouble:profile:v1', JSON.stringify({ cores: 5, levels: { barrels: 999, seed: 12, bogus: 4 }, stats: {} }));
meta.init();
assert(meta.levelOf('barrels') === cfg.NODES.barrels.max, 'oversized saved level should clamp to max');
assert(meta.levelOf('seed') === 12, 'an endless node keeps whatever rank it reached');
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
  if (!meta.towerUnlocked(k)) continue;
  assert(game.place(cellIdx, k), `should place ${k}`);
  const dps = game.dpsOf(field.field.grid[cellIdx]);
  assert(Number.isFinite(dps) && dps > 0, `${k} dps should be a positive number, got ${dps}`);
}

/* ── 9. endless tower levels ─────────────────────────────────── */
meta.buy('proto');
S.gold = 1e9;
const endless = field.field.grid[at(2, 2)];
let lastDps = game.dpsOf(endless), lastCost = 0;
for (let n = 0; n < 12; n++) {
  const cost = game.upgradeCost(endless);
  assert(cost != null && cost > lastCost, `level ${endless.l + 2} should cost more than the last, got ${cost}`);
  lastCost = cost;
  game.upgrade(endless);
  const dps = game.dpsOf(endless);
  assert(dps > lastDps, `level ${endless.l + 1} should hit harder`);
  lastDps = dps;
}
assert(endless.l === 12, `a tower should level past 4, got level ${endless.l + 1}`);
assert(game.upgradeCost(endless) != null, 'there is no level cap past Prototype Cores');

/* ── 10. Cryo Coils ──────────────────────────────────────────── */
const cryo = field.field.grid[at(8, 2)];
const coldBefore = game.statsOf(cryo);
meta.buy('cryocoils');
const coldAfter = game.statsOf(cryo);
assert(coldAfter.dmg > coldBefore.dmg, 'Cryo Coils should add Cryo damage');
assert(coldAfter.slow > coldBefore.slow, 'Cryo Coils should strengthen the slow');
assert(coldAfter.slowDur > coldBefore.slowDur, 'Cryo Coils should lengthen the chill');

/* ── 11. Rapid Deployment shortens the break to nothing ──────── */
for (let n = 0; n < cfg.BREAK_SECONDS; n++) meta.profile.cores = 1e9, meta.buy('drills');
assert(meta.mods.breakTime === 0, `full Rapid Deployment should leave no break, got ${meta.mods.breakTime}`);
game.newRun();
S.lives = S.maxLives = 1e6;   // nothing is built; the walkers just leak
game.startWave();
for (let n = 0; n < 20000 && S.wave === 1 && S.phase !== 'dead'; n++) game.update(0.05);
assert(S.wave === 2 && S.phase === 'run', `wave 2 should follow without a break, got wave ${S.wave} ${S.phase}`);

/* ── 12. Overdrive climbs to 10× ─────────────────────────────── */
meta.profile.cores = 1e9;
while (meta.buy('overdrive'));
assert(meta.levelOf('overdrive') === cfg.NODES.overdrive.max, 'Overdrive should buy up to its max');
assert(game.speedLadder()[game.speedLadder().length - 1] === cfg.OVERDRIVE_TOP, 'full Overdrive tops out at 10×');
assert(cfg.nodeCost(cfg.NODES.overdrive, 6) > 20000, 'the last Overdrive rank should be costly');

/* ── 13. wave-gated nodes: Flak Warheads and Head Start ──────── */
meta.profile.stats.bestWave = 39;
assert(!meta.buy('flak'), 'Flak Warheads needs wave 40');
meta.profile.stats.bestWave = 40;
assert(meta.buy('flak'), 'Flak Warheads unlocks at wave 40');
assert(meta.mods.rocketAir, 'Flak Warheads lets rockets hit air');

meta.profile.stats.bestWave = 29;
assert(!meta.buy('headstart'), 'Head Start needs wave 30');
meta.profile.stats.bestWave = 30;
assert(meta.buy('headstart'), 'Head Start unlocks at wave 30');
assert(!meta.buy('headstart'), 'the second Head Start rank needs wave 40');

const coresBefore = meta.profile.cores;
game.newRun();
assert(S.wave === 0, 'owning Head Start does not use it unless the run asks for it');
game.newRun({ headStart: true });
assert(S.wave === 10 && S.wavesCleared === 10, `Head Start should open after wave 10, got ${S.wave}`);
assert(S.gold > 2000, `the skipped waves should pay gold, got ${S.gold}`);
assert(meta.profile.cores === coresBefore, 'Head Start points wait for the first real wave');
assert(S.heldPoints > 100, `the skipped waves should be worth points, got ${S.heldPoints}`);
const held = S.heldPoints;
S.lives = S.maxLives = 1e6;
game.startWave();
for (let n = 0; n < 40000 && S.phase === 'run'; n++) game.update(0.05);
assert(S.wavesCleared === 11, `wave 11 should be held, got ${S.wavesCleared}`);
assert(meta.profile.cores - coresBefore >= Math.floor(held), 'holding wave 11 pays the Head Start points');
assert(S.heldPoints === 0, 'the Head Start points are paid only once');

assert(S.tally.headKills > 0, 'the report counts the kills Head Start paid out');
const inPlay = Object.values(S.tally.kills).reduce((a, b) => a + b, 0);
assert(inPlay === S.kills - S.tally.headKills, `kills by enemy should add up, ${inPlay} vs ${S.kills - S.tally.headKills}`);

game.newRun({ headStart: false });
assert(S.wave === 0, 'choosing wave 1 opens at wave 1');
assert(S.tally.headKills === 0 && !Object.keys(S.tally.kills).length, 'a new run starts a fresh report');

/* ── 14. endless Foundry research ────────────────────────────── */
meta.profile.cores = 1e12;
const endlessIds = ['seed', 'bounty', 'dividend', 'interest', 'requisition', 'munitions', 'warheads',
  'lens', 'guidance', 'loaders', 'ap', 'crit', 'cryocoils', 'capacitors', 'overload', 'siphon',
  'phase', 'refinery', 'headstart', 'titanbreak'];
for (const id of endlessIds) assert(cfg.NODES[id].max === Infinity, `${id} should be endless`);
for (const id of ['barrels', 'core', 'overdrive', 'drills']) {
  assert(Number.isFinite(cfg.NODES[id].max), `${id} keeps its cap`);
}
const seedAt = meta.levelOf('seed');
for (let n = 0; n < 25; n++) assert(meta.buy('seed'), `Seed Capital rank ${seedAt + n + 1} should be buyable`);
assert(meta.mods.startGold === cfg.BASE_START_GOLD + 20 * (seedAt + 25), 'endless Seed Capital keeps adding gold');
while (meta.levelOf('requisition') < 40) meta.buy('requisition');
assert(meta.mods.buildCost > 0.25 && meta.mods.buildCost < 0.35, `Requisition compounds, got ${meta.mods.buildCost}`);
while (meta.levelOf('crit') < 36) meta.buy('crit');
assert(meta.mods.crit === 1, 'Overcharge chance stops at 100%');
assert(meta.mods.critMult > cfg.CRIT_MULT, 'Overcharge past 100% adds crit damage');

/* ── 15. Portal: sends the leader home, spares Titans ────────── */
meta.buy('portal'); meta.buy('factory');
assert(meta.towerUnlocked('portal') && meta.towerUnlocked('factory'), 'Portal and Core Factory unlock in the Foundry');
game.newRun();
S.gold = 100000;
S.lives = S.maxLives = 1e6;
assert(game.place(at(10, 3), 'portal'), 'Portal should place');
game.startWave();
let ported = false;
for (let n = 0; n < 60 * 120 && S.phase === 'run'; n++) {
  const before = S.foes.map(e => [e, e.x]);
  game.update(1 / 60);
  for (const [e, x] of before) if (!e.dead && x > 5 && e.x < 0) ported = true;
}
assert(ported, 'the Portal should send a foe back to the spawn');

/* ── 16. Core Factory mints Cores only while a wave runs ─────── */
game.newRun();
S.gold = 100000;
S.lives = S.maxLives = 1e6;
assert(game.place(at(10, 3), 'factory'), 'Core Factory should place');
const plant = field.field.grid[at(10, 3)];
const idleCores = meta.profile.cores;
for (let n = 0; n < 600; n++) game.update(1 / 60);
assert(meta.profile.cores === idleCores, 'no minting in the build phase');
game.startWave();
const coresRun = meta.profile.cores, scoreRun = S.score;
for (let n = 0; n < 60 * 20 && S.phase === 'run'; n++) game.update(1 / 60);
assert(S.minted > 0, 'a factory should mint during a wave');
assert(meta.profile.cores - coresRun >= S.minted, 'minted Cores go into the bank');
const yield0 = game.statsOf(plant).yield;
meta.buy('refinery');
assert(game.statsOf(plant).yield > yield0, 'Core Refinery raises output');
game.upgrade(plant);
assert(game.statsOf(plant).yield > yield0 * 1.15, 'factory levels raise output');
assert(game.dpsOf(plant) === 0, 'a factory deals no damage');

/* ── 17. damage ranks compound ───────────────────────────────── */
meta.profile.cores = 1e12;
meta.profile.levels.warheads = 0; meta.profile.levels.loaders = 0; meta.recompute();
for (let n = 0; n < 20; n++) meta.buy('warheads');
assert(Math.abs(meta.mods.dmg.rocket - Math.pow(1.07, 20)) < 1e-9, `Warheads compound, got ${meta.mods.dmg.rocket}`);
const r19 = Math.pow(1.07, 19);
assert(meta.mods.dmg.rocket / r19 > 1.069, 'rank 20 is worth as much as rank 1');
for (let n = 0; n < 10; n++) meta.buy('loaders');
assert(Math.abs(meta.mods.rate - 1 / Math.pow(1.04, 10)) < 1e-9, `Rapid Loaders compound, got ${meta.mods.rate}`);

/* ── 18. Titans trail the health curve and arrive spaced out ─── */
const bossWave = buildWave(90);
const titans = bossWave.filter(o => o.type === 'titan');
const grunts = bossWave.filter(o => o.type !== 'titan');
assert(titans.length === 3, `wave 90 sends three Titans, got ${titans.length}`);
assert(Math.abs(titans[0].hpMul / grunts[0].hpMul - 0.85 / Math.pow(1.135, 10)) < 1e-9,
  'a wave-90 Titan reads its health a full boss behind');
assert(Math.abs(buildWave(30).find(o => o.type === 'titan').hpMul / Math.pow(1.135, 29) - 0.85) < 1e-9,
  'early Titans are unchanged');
assert(titans[1].at - titans[0].at >= cfg.TITAN_GAP - 1e-9, 'Titans walk in spaced out');

/* ── 19. Titan Breaker strips max health, bosses only ────────── */
meta.profile.stats.bestWave = 39;
assert(!meta.buy('titanbreak'), 'Titan Breaker needs wave 40');
meta.profile.stats.bestWave = 40;
assert(meta.buy('titanbreak'), 'Titan Breaker unlocks at wave 40');
assert(meta.mods.titanBreak > 0, 'Titan Breaker sets a shred rate');
const boss = { def: cfg.FOES.titan, max: 1e9 };
assert(Math.abs(game.titanShred(boss, 2) - 1e9 * meta.mods.titanBreak * 2) < 1e-3, 'shred follows time on target');
assert(game.titanShred({ def: cfg.FOES.tank, max: 1e9 }, 2) === 0, 'only bosses are shredded');
for (let n = 0; n < 200; n++) meta.buy('titanbreak');
assert(meta.mods.titanBreak < cfg.TITAN_BREAK_CAP, 'Titan Breaker never reaches its cap');

console.log(process.exitCode ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED');
