/* Headless Frontier test: terrain, routing, fire-back, units, victory.
   Drives the simulation with no DOM, like smoke.mjs.

   usage: node test/frontier.mjs [--probe]   (--probe prints a sortie log) */
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
const terrain = await import('../public/js/terrain.js');
const fr = await import('../public/js/frontier.js');

const { S } = game;
const { F } = fr;
const PROBE = process.argv.includes('--probe');

function assert(cond, msg) {
  if (!cond) { console.error('ASSERT FAILED:', msg); process.exitCode = 1; }
}

meta.init();

/* ── 1. terrain is seeded and playable ───────────────────────── */
const a = terrain.generate(terrain.sectorSeed(4));
const b = terrain.generate(terrain.sectorSeed(4));
assert(a.height.every((h, i) => h === b.height[i]) && a.ramp.every((r, i) => r === b.ramp[i]),
  'the same seed must give the same map');
const c = terrain.generate(terrain.sectorSeed(5));
assert(!a.height.every((h, i) => h === c.height[i]), 'different sectors should differ');

for (let s = 1; s <= 25; s++) {
  const m = terrain.generate(terrain.sectorSeed(s));
  const flow = terrain.flowField(m, [terrain.at(m.hq.x, m.hq.y)], () => 0);
  assert(flow.dist[terrain.at(m.enemy.x, m.enemy.y)] < Infinity, `sector ${s}: the bases must connect`);
  assert(m.height[terrain.at(m.hq.x, m.hq.y)] >= 0, `sector ${s}: HQ must stand on land`);
}

/* ── 2. a sortie opens ───────────────────────────────────────── */
fr.newSortie(1);
assert(S.mode === 'frontier', 'mode should switch to frontier');
assert(S.phase === 'build', 'a sortie opens in the build phase');
assert(F.hq.hp === meta.mods.integrity, 'HQ starts at full integrity');
assert(F.bunkers.length === cfg.bunkerCount(1), `sector 1 should have ${cfg.bunkerCount(1)} bunkers, got ${F.bunkers.length}`);
assert(S.gold > meta.mods.startGold, 'a sortie opens with the gold of the waves it skips');
const spawnCell = terrain.at(F.enemy.cx - 2, F.enemy.cy);
assert(F.flow.cautious.dist.some(d => d > 20 && d < Infinity), 'enemies should have a route home');

/* ── 3. build rules ──────────────────────────────────────────── */
const m = F.map;
const near = [];
for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
  const i = terrain.at(F.hq.cx + x, F.hq.cy + y);
  if (fr.canBuild(i)) near.push(i);
}
assert(near.length > 10, `there should be room to build by the HQ, found ${near.length}`);
const far = terrain.at(F.enemy.cx - 3, F.enemy.cy);
assert(!fr.canBuild(far), 'no building next to the enemy base');
const water = m.height.findIndex(h => h < 0);
if (water >= 0) assert(fr.whyNot(water) !== '', 'no building on water');

S.gold = 1e6;
const purse = S.gold;
assert(fr.place(near[0], 'gun'), 'should place a gun by the HQ');
assert(!fr.place(near[0], 'gun'), 'no stacking');
const g1 = F.grid[near[0]];
assert(g1.hp > 0 && g1.hp === g1.max, 'a tower starts at full health');
assert(fr.buildCost('gun') > cfg.TOWERS.gun.cost, 'escalation applies in Frontier too');
const hp0 = g1.max;
fr.upgrade(g1);
assert(g1.l === 1 && g1.max > hp0, 'upgrades work and harden the tower');
fr.sell(g1);
assert(S.gold === purse, `sell refunds everything (${S.gold} vs ${purse})`);

/* high ground reaches further */
const hi = F.towers.length === 0 && near.find(i => m.height[i] > 0);
if (hi) {
  fr.place(hi, 'gun');
  const t = F.grid[hi];
  assert(fr.rangeOf(t) > game.statsOf(t).range, 'towers on high ground get extra range');
  fr.sell(t);
}

/* ── 4. walkers avoid kill zones when they can ───────────────── */
fr.newSortie(1);
S.gold = 1e6;
const route = () => {
  const out = [];
  let u = spawnCell, guard = 0;
  while (u !== -1 && guard++ < 4000) { out.push(u); u = F.flow.cautious.next[u]; }
  return out;
};
const r0 = route();
// Park a line of Guns across the middle of the cautious road.
const mid = r0[Math.floor(r0.length * 0.8)];
F.reach.fill(1);
let built = 0;
for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
  const i = terrain.at(terrain.colOf(mid) + x, terrain.rowOf(mid) + y);
  if (fr.whyNot(i) === '' && fr.place(i, 'gun')) { built++; F.reach.fill(1); }
}
assert(built > 0, 'should be able to build on the road');
const bold = F.flow.bold.dist[spawnCell], cautious = F.flow.cautious.dist[spawnCell];
assert(cautious >= bold, 'the cautious plan prices in the kill zone');

/* ── 5. enemies shoot back and towers can fall ───────────────── */
fr.newSortie(2);
S.gold = 1e6;
F.hq.hp = F.hq.max = S.lives = S.maxLives = 1e9;
F.reach.fill(1);
const post = near.find(i => fr.canBuild(i));
fr.place(post, 'gun');
const gunPost = F.grid[post];
// A column of tanks, dropped right beside it.
fr.startWave();
S.queue = Array.from({ length: 6 }, (_, k) => ({ type: 'tank', at: k * 0.1, hpMul: 50, spdMul: 1, arms: 5 }));
for (let f = 0; f < 60; f++) fr.update(1 / 60);
for (const e of S.foes) { e.x = gunPost.x + 1.5; e.y = gunPost.y; }
for (let f = 0; f < 60 * 30 && fr.alive(gunPost); f++) fr.update(1 / 60);
assert(S.tally.towersLost > 0, 'tanks in range should shoot a tower down');
assert(!F.grid[post], 'a destroyed tower leaves the grid');
assert(!F.towers.includes(gunPost), 'and the tower list');

/* ── 6. units march, fight, and can raze the base ────────────── */
fr.newSortie(1);
S.gold = 1e7;
F.hq.hp = F.hq.max = S.lives = S.maxLives = 1e9;
for (let k = 0; k < 6; k++) fr.recruit('trooper');
for (let k = 0; k < 3; k++) fr.recruit('breaker');
for (let k = 0; k < 3; k++) fr.recruit('striker');
assert(fr.squadSize() === 12, 'squad should queue 12');
const refund = S.gold;
fr.disband();
assert(fr.squadSize() === 0 && S.gold > refund, 'disbanding refunds the squad');
for (let k = 0; k < 6; k++) fr.recruit('trooper');
for (let k = 0; k < 4; k++) fr.recruit('breaker');
for (let k = 0; k < 4; k++) fr.recruit('striker');
for (let k = 0; k < 4; k++) fr.upgradeArmory();
fr.startWave();
assert(F.units.length === 14 && fr.squadSize() === 0, 'sending a wave deploys the squad');
const hq0 = F.enemy.hp;
let frames = 0;
while (S.phase !== 'dead' && frames < 60 * 60 * 15) {
  if (S.phase === 'build' || S.phase === 'break') {
    for (let k = 0; k < 4; k++) fr.recruit('breaker');
    for (let k = 0; k < 4; k++) fr.recruit('trooper');
    fr.startWave();
  }
  fr.update(1 / 60);
  frames++;
}
assert(F.enemy.hp < hq0, 'units should damage the enemy HQ');
assert(S.tally.unitKills > 0, 'units should kill enemies on the way');
assert(F.result === 'won', `a strong enough army should raze sector 1 (result ${F.result}, HQ ${Math.round(F.enemy.hp)}/${F.enemy.max}, wave ${S.wave})`);
assert(meta.profile.frontier.cleared >= 1, 'a razed sector is recorded');
assert(F.bounty > 0, 'razing pays a bounty');
console.log(`sector 1 razed on wave ${S.wave} after ${(frames / 60).toFixed(0)} s · sent ${S.tally.unitsSent}, lost ${S.tally.unitsLost}, unit kills ${S.tally.unitKills}, bounty ${F.bounty}`);

/* ── 7. an undefended HQ falls ───────────────────────────────── */
fr.newSortie(3);
frames = 0;
while (S.phase !== 'dead' && frames < 60 * 60 * 20) {
  if (S.phase === 'build' || S.phase === 'break') fr.startWave();
  fr.update(1 / 60);
  frames++;
}
assert(F.result === 'lost', 'with no defence the HQ should fall');
assert(Object.values(S.tally.leaks).reduce((x, y) => x + y, 0) > 0, 'leaks are counted');

/* ── 8. Holdout is untouched by a sortie ─────────────────────── */
game.newRun();
assert(S.mode === 'holdout', 'a Holdout run switches the mode back');
assert(S.gold === meta.mods.startGold, 'Holdout opens with its own start gold');

/* ── probe: a scripted, reasonably played sortie ─────────────── */
if (PROBE) {
  // Somebody who has just held wave 100: roughly half the Foundry bought.
  meta.profile.stats.bestWave = 100;
  meta.profile.cores = 1e12;
  for (const group of cfg.FOUNDRY) {
    for (const node of group.nodes) {
      const want = Math.max(1, Math.round(Math.min(node.max, 10) * 0.5));
      for (let n = 0; n < want; n++) meta.buy(node.id);
    }
  }
  for (const sector of [1, 3, 6, 10]) {
    fr.newSortie(sector);
    const spots = [];
    for (let r = 1; r < 12 && spots.length < 400; r++) {
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== r) continue;
        const cx = F.hq.cx + x, cy = F.hq.cy + y;
        if (cx < 0 || cy < 0 || cx >= cfg.MAP_W || cy >= cfg.MAP_H) continue;
        spots.push(terrain.at(cx, cy));
      }
    }
    let f = 0;
    const kinds = ['gun', 'rocket', 'laser'];
    while (S.phase !== 'dead' && f < 60 * 60 * 40) {
      if (S.phase === 'build' || S.phase === 'break') {
        // Spend half on towers, half on units.
        let guard = 0;
        while (S.gold > 400 && guard++ < 40) {
          const k = kinds[guard % 3];
          const cell = spots.find(i => fr.canBuild(i));
          if (guard % 2 && cell !== undefined && S.gold > fr.buildCost(k)) fr.place(cell, k);
          else if (S.gold > fr.unitPrice('breaker')) { fr.recruit('breaker'); fr.recruit('trooper'); }
          else break;
        }
        console.log(`  s${sector} w${S.wave} gold ${S.gold} towers ${F.towers.length} units ${F.units.length}+${fr.squadSize()} hq ${Math.round(F.hq.hp)} enemyHQ ${Math.round(100 * F.enemy.hp / F.enemy.max)}% bunkers ${F.bunkers.filter(b => !b.dead).length} lost ${S.tally.towersLost}t/${S.tally.unitsLost}u`);
        fr.startWave();
      }
      fr.update(1 / 60);
      f++;
    }
    console.log(`sector ${sector}: ${F.result} on wave ${S.wave}`);
  }
}

console.log(process.exitCode ? 'FRONTIER TEST FAILED' : 'FRONTIER TEST PASSED');
