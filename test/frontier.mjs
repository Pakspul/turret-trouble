/* Headless Frontier test: terrain, the Commander, Factories and Helpers,
   build sequences, route stability, the enemy AI, and annihilation.
   Drives the simulation with no DOM, like smoke.mjs.

   usage: node test/frontier.mjs [--probe]   (--probe plays scripted sorties) */
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
const { at, colOf, rowOf } = terrain;
const PROBE = process.argv.includes('--probe');
const DT = 1 / 60;

function assert(cond, msg) {
  if (!cond) { console.error('ASSERT FAILED:', msg); process.exitCode = 1; }
}
const run = secs => { for (let f = 0; f < secs * 60 && S.phase !== 'dead'; f++) fr.update(DT); };
const mine = type => F.structs.filter(s => s.side === 0 && s.type === type);

/** Park the enemy so a test can watch one thing happen in peace. */
function quietEnemy() {
  F.ai.think = Infinity;
  F.ai.gold = 0;
}

/** First cell near (x, y), within r, where `key` may go. */
function spotNear(x, y, key, r0 = 0, r1 = 8) {
  for (let r = r0; r <= r1; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cx = Math.floor(x) + dx, cy = Math.floor(y) + dy;
        if (cx < 0 || cy < 0 || cx >= cfg.MAP_W || cy >= cfg.MAP_H) continue;
        if (fr.canBuild(at(cx, cy), key)) return at(cx, cy);
      }
    }
  }
  return -1;
}

/** Steer your Commander with the stick until it stands within `d` of p,
    the way a thumb would: along the road, around Factories. */
function walkTo(p, d = 1, secs = 60) {
  const c = F.cmd[0];
  const goal = at(Math.floor(p.x), Math.floor(p.y));
  const solid = i => !!F.grid[i] && F.grid[i].type === 'fab';
  const road = terrain.flowField(F.map, [goal], i => (solid(i) ? Infinity : 0));
  for (let f = 0; f < secs * 60 && S.phase !== 'dead'; f++) {
    if (Math.hypot(p.x - c.x, p.y - c.y) <= d) break;
    const n = road.next[c.cc];
    const tx = n >= 0 ? colOf(n) + 0.5 : p.x, ty = n >= 0 ? rowOf(n) + 0.5 : p.y;
    const dx = tx - c.x, dy = ty - c.y, len = Math.hypot(dx, dy) || 1;
    F.stick.x = dx / len; F.stick.y = dy / len;
    fr.update(DT);
  }
  F.stick.x = F.stick.y = 0;
}

meta.init();

/* ── 1. terrain is seeded and playable ───────────────────────── */
const a = terrain.generate(terrain.sectorSeed(4));
const b = terrain.generate(terrain.sectorSeed(4));
assert(a.height.every((h, i) => h === b.height[i]) && a.ramp.every((r, i) => r === b.ramp[i]),
  'the same seed must give the same map');
const c5 = terrain.generate(terrain.sectorSeed(5));
assert(!a.height.every((h, i) => h === c5.height[i]), 'different sectors should differ');
for (let s = 1; s <= 25; s++) {
  const m = terrain.generate(terrain.sectorSeed(s));
  const flow = terrain.flowField(m, [at(m.hq.x, m.hq.y)], () => 0);
  assert(flow.dist[at(m.enemy.x, m.enemy.y)] < Infinity, `sector ${s}: the starts must connect`);
  assert(m.height[at(m.hq.x, m.hq.y)] >= 0 && m.height[at(m.enemy.x, m.enemy.y)] >= 0, `sector ${s}: both starts on land`);
}

/* ── 2. a sortie opens ───────────────────────────────────────── */
fr.newSortie(1);
assert(S.mode === 'frontier', 'mode should switch to frontier');
assert(S.phase === 'run', 'Frontier has no waves: the war runs from the start');
assert(F.cmd[0] && F.cmd[1] && F.cmd[0].side === 0 && F.cmd[1].side === 1, 'two Commanders, one per side');
assert(F.cmd[0].hp === F.cmd[0].max && F.cmd[0].max > 0, 'your Commander starts whole');
assert(F.structs.length === 0 && F.units.length === 0, 'nothing is built at the start');
assert(S.gold > meta.mods.startGold, 'a sortie opens with a war chest');
const g0 = S.gold;
run(10);
assert(S.gold > g0, 'income trickles in');

/* ── 3. build rules ──────────────────────────────────────────── */
fr.newSortie(1);
quietEnemy();
S.gold = 1e6;
const me = F.cmd[0];
const fabCell = spotNear(me.x + 3, me.y, 'fab');
assert(fabCell >= 0, 'there is room for a Factory beside the start');
assert(fr.place(fabCell, 'fab'), 'a Factory can be ordered');
const fab = F.grid[fabCell];
assert(fab.type === 'fab' && fab.cells.length === 9 && !fab.done, 'a Factory is a 3x3 construction site');
assert(fab.cells.every(i => F.grid[i] === fab), 'it fills all nine cells');
assert(!fr.place(fabCell, 'fab'), 'no stacking');
const close = at(fab.cx + 3, fab.cy);
assert(fr.whyNot(close, 'fab') !== '', 'Factories keep their distance');
const ring = fr.ringOf(fab);
assert(ring.length === 12, `a Factory has twelve Helper slots, got ${ring.length}`);
const outside = at(fab.cx + 2, fab.cy + 2);
assert(fr.whyNot(outside, 'helper') !== '', 'the ring corners take no Helper');
const far = spotNear(me.x + 12, me.y, 'gun');
assert(fr.whyNot(far, 'helper') !== '', 'Helpers only go beside a Factory');
const water = F.map.height.findIndex(h => h < 0);
if (water >= 0) assert(fr.whyNot(water, 'gun') !== '', 'no building on water');

// Cancelling a site gives everything back.
const purse = S.gold;
const gunCell = spotNear(me.x, me.y - 3, 'gun');
fr.place(gunCell, 'gun');
fr.recycle(F.grid[gunCell]);
assert(S.gold === purse && !F.grid[gunCell], 'a cancelled order is refunded in full');

/* ── 4. the Commander builds only what it can reach ──────────── */
const remote = spotNear(me.x + 14, me.y, 'gun', 0, 6);
fr.place(remote, 'gun');
const outpost = F.grid[remote];
run(cfg.FAB.bt / meta.mods.buildPower + 1);
assert(fab.done, 'the Factory beside the Commander gets built');
assert(!outpost.done && outpost.prog === 0, 'an order out of reach waits for the Commander');
walkTo(outpost, meta.mods.buildReach - 0.5);
run(5);
assert(outpost.done, 'walking over finishes it');
assert(fr.alive(outpost), 'a finished tower is a live tower');
const hp0 = outpost.max;
fr.upgrade(outpost);
assert(outpost.l === 1 && outpost.max > hp0, 'tower upgrades work and harden the tower');
walkTo({ x: fab.x - 2.5, y: fab.y }, 0.8);

/* ── 5. Factories: sequences, Helpers, tiers ─────────────────── */
assert(fab.seq.length === 1 && fab.seq[0] === 'trooper', 'a new Factory makes Troopers until told otherwise');
fr.seqClear(fab);
fr.seqAdd(fab, 'striker');
fr.seqAdd(fab, 'breaker');
fr.seqAdd(fab, 'striker');
// Whatever was already on the belt finishes first; then the sequence runs.
const known = new Set(F.units);
let skip = fab.job ? 1 : 0;
const made = [];
for (let f = 0; f < 60 * 60 && made.length < 4; f++) {
  fr.update(DT);
  for (const u of F.units) {
    if (known.has(u)) continue;
    known.add(u);
    if (skip) skip--;
    else made.push(u.k);
  }
}
assert(made.join(',') === 'striker,breaker,striker,striker', `a sequence is built in order and repeats, got ${made}`);
for (let n = 0; n < cfg.SEQ_MAX + 2; n++) fr.seqAdd(fab, 'trooper');
assert(fab.seq.length === cfg.SEQ_MAX, 'a sequence has a length limit');

const slow = fr.fabSpeed(fab);
for (const i of ring.slice(0, 4)) fr.place(i, 'helper');
run(25);
assert(fr.helpersOf(fab) === 4, `four Helpers get built, got ${fr.helpersOf(fab)}`);
assert(Math.abs(fr.fabSpeed(fab) - (slow + 4 * cfg.HELPER_BOOST)) < 1e-9, 'each Helper adds its boost');

fr.seqClear(fab);
fr.seqAdd(fab, 'trooper');
run(6);
const t1 = F.units.filter(u => u.k === 'trooper' && u.tier === 1).pop();
fr.upgradeFab(fab);
assert(fab.up, 'an upgrade starts');
run(cfg.fabUpTime(1) / fr.fabSpeed(fab) + 0.5);
assert(fab.tier === 2 && !fab.up, 'the upgrade finishes into tier 2');
run(cfg.unitTime('trooper', 2) / fr.fabSpeed(fab) + 0.5);
const t2 = F.units.filter(u => u.k === 'trooper' && u.tier === 2).pop();
assert(t1 && t2 && t2.max > t1.max * 1.5, 'tier 2 units are much stronger');

/* ── 6. groups wait at the door, then march together ─────────── */
fr.setGroup(fab, 3);
const waiting = () => F.units.filter(u => u.hold === fab).length;
let seen = 0;
for (let f = 0; f < 60 * 30 && seen < 2; f++) { fr.update(DT); seen = Math.max(seen, waiting()); }
assert(seen === 2, `units hold until the group is complete (saw ${seen} waiting)`);
for (let f = 0; f < 60 * 30 && waiting(); f++) fr.update(DT);
assert(waiting() === 0 && fab.held.length === 0, 'the third unit sends the group off');
fr.setGroup(fab, 1);

/* ── 7. routes hold still while things move ───────────────────── */
fr.newSortie(2);
quietEnemy();
S.gold = 1e6;
fr.place(spotNear(F.cmd[0].x + 3, F.cmd[0].y, 'fab'), 'fab');
run(20);
const rev = F.flowRev;
walkTo({ x: F.cmd[0].x, y: F.cmd[0].y + 3 }, 0.5);
walkTo({ x: F.cmd[0].x + 2, y: F.cmd[0].y - 3 }, 0.5);
run(2);
assert(F.flowRev === rev, 'moving Commanders do not re-plan the routes while buildings stand');
const road = F.flow[0].bold.next.slice();
F.cmd[1].x -= 1; F.cmd[1].y += 1;
run(1);
assert(F.flow[0].bold.next.every((n, i) => n === road[i]), 'the attack route ignores the enemy Commander while it has buildings');

/* ── 8. the enemy builds a base and fields an army ───────────── */
fr.newSortie(1);
let enemyUnits = 0;
for (let f = 0; f < 60 * 180; f++) { fr.update(DT); enemyUnits = Math.max(enemyUnits, fr.armySize(1)); }
const theirs = F.structs.filter(s => s.side === 1);
assert(theirs.some(s => s.type === 'fab' && s.done), 'the enemy builds a Factory');
assert(theirs.some(s => s.type === 'helper'), 'and Helpers for it');
assert(theirs.some(s => s.type === 'tower'), 'and towers');
assert(enemyUnits >= 4, `and fields units (${enemyUnits})`);

/* ── 9. marching units do not dither ──────────────────────────── */
// Units on the road should keep their heading; a reversal is a column
// that could not make up its mind.
fr.newSortie(1);
S.gold = 1e6;
fr.place(spotNear(F.cmd[0].x + 3, F.cmd[0].y, 'fab'), 'fab');
run(16);
const f9 = mine('fab')[0];
fr.seqClear(f9);
for (const k of ['trooper', 'breaker', 'striker', 'trooper']) fr.seqAdd(f9, k);
let reversals = 0, steps = 0;
const last = new Map();
for (let f = 0; f < 60 * 120 && S.phase !== 'dead'; f++) {
  fr.update(DT);
  if (f % 30) continue;
  for (const u of F.units) {
    if (u.side || u.tgt || u.hold) { last.delete(u); continue; }
    const p = last.get(u);
    last.set(u, { x: u.x, y: u.y, vx: p ? u.x - p.x : 0, vy: p ? u.y - p.y : 0 });
    if (!p || Math.hypot(p.vx, p.vy) < 0.1) continue;
    const vx = u.x - p.x, vy = u.y - p.y;
    if (Math.hypot(vx, vy) < 0.1) continue;
    steps++;
    const cos = (vx * p.vx + vy * p.vy) / (Math.hypot(vx, vy) * Math.hypot(p.vx, p.vy));
    if (cos < -0.5) reversals++;
  }
}
assert(steps > 50, `units should have marched (${steps} samples)`);
assert(reversals / Math.max(1, steps) < 0.03, `marching units should rarely turn back (${reversals}/${steps})`);
console.log(`route steadiness: ${reversals} reversals in ${steps} half-second samples of marching units`);

/* ── 10. an idle player is annihilated ───────────────────────── */
fr.newSortie(1);
for (let f = 0; f < 60 * 60 * 20 && S.phase !== 'dead'; f++) fr.update(DT);
assert(F.result === 'lost', `doing nothing should lose (result ${F.result}, ${Math.round(F.time)} s)`);

/* ── 11. a strong army annihilates the enemy ─────────────────── */
fr.newSortie(1);
S.gold = 1e7;
F.cmd[0].hp = F.cmd[0].max = 1e9;
const c11 = F.cmd[0];
for (const dy of [-5, 5]) fr.place(spotNear(c11.x + 3, c11.y + dy, 'fab', 0, 6), 'fab');
run(30);
for (const f of mine('fab')) {
  for (const i of fr.ringOf(f)) fr.place(i, 'helper');
}
run(50);
for (const f of mine('fab')) {
  for (let k = 0; k < 3; k++) { f.up = null; f.tier++; }
  fr.seqClear(f);
  for (const k of ['breaker', 'trooper', 'breaker', 'gunship']) fr.seqAdd(f, k);
}
const razed0 = S.tally.razed;
for (let f = 0; f < 60 * 60 * 15 && S.phase !== 'dead'; f++) fr.update(DT);
assert(S.tally.razed > razed0, 'units raze enemy buildings');
assert(S.kills > 0, 'units kill enemy units');
assert(F.result === 'won', `a strong enough army should annihilate sector 1 (result ${F.result}, ${Math.round(F.time)} s)`);
assert(F.cmd[1].dead && !F.structs.some(s => s.side === 1), 'annihilation means the Commander and every building');
assert(meta.profile.frontier.cleared >= 1, 'a won sector is recorded');
assert(F.bounty > 0, 'winning pays a bounty');
console.log(`sector 1 annihilated in ${Math.round(F.time)} s · built ${Object.values(S.tally.built).reduce((x, y) => x + y, 0)} units, lost ${Object.values(S.tally.lost).reduce((x, y) => x + y, 0)}, razed ${S.tally.razed}, bounty ${F.bounty}`);

/* ── 12. Holdout is untouched by a sortie ────────────────────── */
game.newRun();
assert(S.mode === 'holdout', 'a Holdout run switches the mode back');
assert(S.gold === meta.mods.startGold, 'Holdout opens with its own start gold');

/* ── probe: a scripted, middling player across sectors ───────── */
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
  for (const sector of [1, 2, 3, 4, 6, 8]) {
    fr.newSortie(sector);
    const c = F.cmd[0];
    const home = { x: c.x, y: c.y };
    const dir = Math.sign(F.cmd[1].x - c.x);
    let f = 0;
    while (S.phase !== 'dead' && f < 60 * 60 * 25) {
      if (f % 60 === 0 && !c.dead) {
        const fabs = mine('fab'), nf = fabs.length;
        if (!fr.sitesOf(0).length) {
          if (nf === 0 || (F.time > 150 * nf && nf < 3 && S.gold > fr.buildCost('fab'))) {
            const cell = spotNear(home.x + dir * 3 * (nf + 1), home.y + (nf % 2 ? 4 : -2), 'fab', 0, 6);
            if (cell >= 0) fr.place(cell, 'fab');
          } else if (S.gold > 120) {
            const towers = mine('tower').length;
            if (mine('helper').length < nf * (F.time < 240 ? 4 : 8)) {
              for (const fb of fabs) {
                const slot = fr.ringOf(fb).find(i => fr.canBuild(i, 'helper'));
                if (slot !== undefined) { fr.place(slot, 'helper'); break; }
              }
            } else if (towers < 3 + F.time / 90) {
              const cell = spotNear(home.x + dir * 6, home.y, ['gun', 'rocket', 'laser'][towers % 3], 1, 5);
              if (cell >= 0) fr.place(cell, ['gun', 'rocket', 'laser'][towers % 3]);
            }
          }
        }
        for (const fb of fabs) {
          if (fb.done && fb.seq.length === 1) { fr.seqAdd(fb, 'trooper'); fr.seqAdd(fb, 'breaker'); fr.setGroup(fb, 6); }
          if (fb.done && !fb.up && S.gold > fr.fabUpgradeCost(fb) + 300) fr.upgradeFab(fb);
        }
      }
      const site = fr.sitesOf(0)[0];
      const goal = site || home;
      const dx = goal.x - c.x, dy = goal.y - c.y, d = Math.hypot(dx, dy);
      const stop = site ? meta.mods.buildReach - 0.5 + site.half : 1;
      F.stick.x = d > stop ? dx / d : 0; F.stick.y = d > stop ? dy / d : 0;
      fr.update(DT);
      f++;
      if (f % (60 * 60) === 0) {
        const e = F.structs.filter(s => s.side === 1);
        console.log(`  s${sector} ${Math.round(F.time / 60)}m gold ${S.gold}/${Math.round(F.ai.gold)} factories ${mine('fab').map(s => 'T' + s.tier).join(',')} vs ${e.filter(s => s.type === 'fab').map(s => 'T' + s.tier).join(',')} · towers ${mine('tower').length}/${e.filter(s => s.type === 'tower').length} · units ${fr.armySize(0)}/${fr.armySize(1)} · commanders ${Math.round(c.hp)}/${Math.round(F.cmd[1].hp)}`);
      }
    }
    console.log(`sector ${sector}: ${F.result || 'undecided'} after ${Math.round(F.time)} s`);
  }
}

console.log(process.exitCode ? 'FRONTIER TEST FAILED' : 'FRONTIER TEST PASSED');
