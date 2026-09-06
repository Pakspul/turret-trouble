/* Headless test for the blueprint recorder: capture, replay, and the rules
   that keep a replay from doing something the board cannot take. */
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
const rec = await import('../public/js/recorder.js');

const { S } = game;
const grid = () => fieldMod.field.grid;
const at = (c, r) => cfg.idx(c, r);

function assert(cond, msg) {
  if (!cond) { console.error('ASSERT FAILED:', msg); process.exitCode = 1; }
}

/** Run the simulation for `seconds` of build phase, driving the autopilot. */
function run(seconds) {
  const dt = 1 / 60;
  for (let n = 0; n < Math.round(seconds / dt); n++) game.update(dt);
}

meta.init();
rec.init();
game.bindProjection(u => u * 10, u => u * 10);

/* ── 1. a run records itself ─────────────────────────────────────────── */
game.newRun();
S.gold = 100000;
assert(rec.rec.tape.length === 0, 'a new run starts with an empty tape');

game.place(at(3, 3), 'gun');
game.place(at(5, 6), 'gun');
game.upgrade(grid()[at(3, 3)]);
game.place(at(7, 4), 'laser');
game.convert(grid()[at(5, 6)], 'rocket');
game.sell(grid()[at(7, 4)]);

const ops = rec.rec.tape.map(s => s.op).join(',');
assert(ops === 'place,place,up,place,swap,sell', `tape should hold every action in order, got ${ops}`);
assert(rec.rec.tape[2].l === 1, 'an upgrade step records the level it reached');
assert(rec.rec.tape.every(s => s.w === 0), 'steps built before wave 1 are tagged wave 0');

/* the wave tag follows the run */
game.startWave();
game.place(at(9, 4), 'gun');
assert(rec.rec.tape[rec.rec.tape.length - 1].w === 1, 'a step built during wave 1 is tagged wave 1');

/* ── 2. the run banks itself as a blueprint ──────────────────────────── */
const saved = game.endRecording();
assert(saved && saved.steps.length === 7, `ending a run should save the tape, got ${saved && saved.steps.length}`);
assert(rec.library.list[0] === saved, 'the newest blueprint sits at the top of the library');
assert(rec.rec.last === saved, 'the summary screen can find the run just saved');

/* ── 3. replaying it rebuilds the same board ─────────────────────────── */
rec.arm(saved.id);
game.newRun();
assert(rec.rec.play, 'arming a blueprint should start playback on the next run');
assert(rec.rec.armed === null, 'the arm is consumed by the run that uses it');

S.gold = 100000;
run(4);

assert(grid()[at(3, 3)] && grid()[at(3, 3)].k === 'gun', 'replay should rebuild the first gun');
assert(grid()[at(3, 3)].l === 1, 'replay should re-apply the upgrade');
assert(grid()[at(5, 6)] && grid()[at(5, 6)].k === 'rocket', 'replay should follow the swap through');
assert(!grid()[at(7, 4)], 'replay should sell what the run sold');

const play = rec.rec.play;
assert(play.status === 'wait' || play.at === 6,
  `the wave-1 step should wait for wave 1, sitting at ${play.at} (${play.status})`);

/* what the autopilot builds is recorded too, so a replay extends cleanly */
assert(rec.rec.tape.length === 6, `the replay should re-record its own build, got ${rec.rec.tape.length}`);

game.startWave();
run(1);
assert(grid()[at(9, 4)], 'the wave-1 step should land once wave 1 is running');
assert(rec.rec.play === null || rec.rec.play.status === 'done', 'playback should report itself finished');
assert(play.done === 7 && play.skipped === 0, `every step should land: ${play.done} done, ${play.skipped} skipped`);

/* ── 4. a step never runs before the wave it was recorded on ─────────── */
const late = rec.importJSON(JSON.stringify({
  name: 'Late build',
  steps: [{ op: 'place', i: at(4, 2), k: 'gun', w: 0 }, { op: 'place', i: at(4, 7), k: 'gun', w: 3 }]
}));
assert(late, 'a well-formed blueprint should import');

rec.arm(late.id);
game.newRun();
S.gold = 100000;
run(2);
assert(grid()[at(4, 2)], 'the wave-0 step should build immediately');
assert(!grid()[at(4, 7)], 'the wave-3 step must not build during the build phase');
assert(rec.rec.play.status === 'wait', 'playback should report that it is waiting');

// Skip the fighting: call each wave, then hand the phase straight back.
for (let w = 0; w < 3; w++) {
  game.startWave();
  S.queue = []; S.foes = []; S.phase = 'build';
  run(0.4);
}
assert(S.wave === 3, `the run should be on wave 3, got ${S.wave}`);
assert(grid()[at(4, 7)], 'the wave-3 step should build once wave 3 has been called');

/* ── 5. saving up for a step it cannot yet afford ────────────────────── */
const pricey = rec.importJSON(JSON.stringify({
  name: 'Pricey',
  steps: [{ op: 'place', i: at(6, 2), k: 'rocket', w: 0 }, { op: 'place', i: at(6, 5), k: 'gun', w: 0 }]
}));
rec.arm(pricey.id);
game.newRun();
S.gold = 20;
run(2);
assert(!grid()[at(6, 2)] && !grid()[at(6, 5)], 'a step short of gold blocks the ones behind it');
assert(rec.rec.play.status === 'wait' && rec.rec.play.need > 0,
  `playback should name the price it is saving for, got ${rec.rec.play.need}`);
assert(rec.playbackLine().includes('Saving'), `the readout should say what it is waiting on: "${rec.playbackLine()}"`);

/* skipping the head lets the rest of the build through */
rec.skipStep();
S.gold = 1000;
run(1);
assert(grid()[at(6, 5)], 'skipping a stalled step should release the ones behind it');
assert(!grid()[at(6, 2)], 'the skipped step should not build later');

/* ── 6. a locked tower is skipped, not waited on ─────────────────────── */
assert(!meta.towerUnlocked('tesla'), 'Tesla should still be locked on a fresh profile');
const locked = rec.importJSON(JSON.stringify({
  name: 'Locked',
  steps: [{ op: 'place', i: at(8, 3), k: 'tesla', w: 0 }, { op: 'place', i: at(8, 6), k: 'gun', w: 0 }]
}));
rec.arm(locked.id);
game.newRun();
S.gold = 100000;
run(1);
assert(grid()[at(8, 6)], 'a locked step should be skipped so the build carries on');
assert(rec.rec.play === null || rec.rec.play.skipped === 1, 'the skip should be counted');

/* ── 7. a placement that would seal the exit is given up on ──────────── */
const wall = [];
for (let r = 0; r < cfg.ROWS; r++) wall.push({ op: 'place', i: at(4, r), k: 'gun', w: 0 });
const sealer = rec.importJSON(JSON.stringify({ name: 'Wall', steps: wall }));
rec.arm(sealer.id);
game.newRun();
S.gold = 100000;
run(20);
let built = 0;
for (let r = 0; r < cfg.ROWS; r++) if (grid()[at(4, r)]) built++;
assert(built === cfg.ROWS - 1, `a replay must not seal the exit either; built ${built}`);
assert(fieldMod.field.dist[cfg.SPAWN] !== -1, 'the route from the spawn must survive a replay');

/* ── 8. stopping and pausing ─────────────────────────────────────────── */
rec.arm(sealer.id);
game.newRun();
S.gold = 100000;
rec.togglePlayback();
run(1);
assert(rec.rec.play.status === 'paused', 'a paused playback stays paused');
assert(rec.rec.play.done === 0, 'a paused playback builds nothing');
rec.stopPlayback();
run(1);
assert(rec.rec.play === null, 'stopping ends the playback');

/* ── 9. the library keeps itself in order ────────────────────────────── */
const before = rec.library.list.length;
rec.pin(saved.id, true);
assert(rec.find(saved.id).pinned, 'pinning should stick');

for (let n = 0; n < rec.MAX_AUTO + 3; n++) {
  game.newRun();
  S.gold = 100000;
  game.place(at(2, 2), 'gun');
  game.place(at(2, 4), 'gun');
  game.place(at(2, 6), 'gun');
  game.endRecording();
}
const autos = rec.library.list.filter(bp => bp.auto).length;
assert(autos <= rec.MAX_AUTO, `auto-saved runs should be pruned to ${rec.MAX_AUTO}, found ${autos}`);
assert(rec.find(saved.id), 'a pinned blueprint survives pruning');
assert(rec.library.list.length <= rec.MAX_BLUEPRINTS, 'the library stays within its cap');
assert(before > 0, 'the library had blueprints to prune');

/* a run too short to be worth keeping is not kept */
const count = rec.library.list.length;
game.newRun();
S.gold = 100000;
game.place(at(2, 2), 'gun');
assert(game.endRecording() === null, 'a one-step run is not worth saving');
assert(rec.library.list.length === count, 'and it does not reach the library');

/* ── 10. rubbish in, nothing out ─────────────────────────────────────── */
assert(rec.importJSON('not json') === null, 'garbage should not import');
assert(rec.importJSON('{"steps":[]}') === null, 'an empty blueprint should not import');
assert(rec.importJSON(JSON.stringify({ steps: [{ op: 'launch', i: 4, w: 0 }] })) === null,
  'an unknown op should be dropped');

const mixed = rec.importJSON(JSON.stringify({
  steps: [
    { op: 'place', i: at(3, 3), k: 'gun', w: 1 },
    { op: 'place', i: 99999, k: 'gun', w: 1 },
    { op: 'place', i: at(4, 4), k: 'catapult', w: 1 },
    { op: 'place', i: at(5, 5), k: 'gun', w: -7 }
  ]
}));
assert(mixed.steps.length === 2, `only the sane steps should survive, got ${mixed.steps.length}`);
assert(mixed.steps[1].w === 0, 'a negative wave should clamp to 0');

/* ── 11. the library survives a reload ───────────────────────────────── */
rec.persistNow();
const names = rec.library.list.map(bp => bp.name).join('|');
const ids = rec.library.list.map(bp => bp.id).join('|');
rec.init();
assert(rec.library.list.map(bp => bp.name).join('|') === names, 'blueprints should survive a reload');
assert(rec.library.list.map(bp => bp.id).join('|') === ids, 'and keep their identities');

/* a corrupted store must not take the game down with it */
mem.set('turret-trouble:blueprints:v1', '{"list":[{"name":"broken"},null,7]}');
rec.init();
assert(rec.library.list.length === 0, 'a corrupt library should load as empty, not throw');

console.log(process.exitCode ? 'RECORDER TEST FAILED' : 'RECORDER TEST PASSED');
