/* ══ Frontier terrain ════════════════════════════════════════════════════
   Seeded maps in the spirit of the early real-time strategy maps: low
   ground, hills and plateaus, with cliffs between them that only ramps
   cross. The same seed always gives the same map, so a sector can be
   learned; a new sector is a new seed.

   Generation is: layered value noise -> quantise into water and three
   heights by quantile (so every map has a similar mix) -> smooth away
   specks -> flatten a pad for each HQ -> cut ramps between neighbouring
   plateaus -> check the two bases connect, and that there is more than
   one sensible way between them. A map that fails is rerolled from a
   derived seed; after a dozen tries a corridor is carved so there is
   always a playable map.

   Also home to the route planner every walker uses: a Dijkstra flow field
   over 8-way moves, with a per-cell extra cost the caller supplies.     */

import { MAP_W, MAP_H, WATER } from './config.js';

/* ── seeded randomness ────────────────────────────────────────────────── */
/** mulberry32: small, fast, and good enough for terrain. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable seed for sector `s`, so sector 3 is the same map for everyone. */
export function sectorSeed(s) {
  let h = 0x9e3779b9 ^ (s * 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Short readable tag for a seed, shown on the sector card. */
export function seedTag(seed) {
  return (seed >>> 0).toString(36).toUpperCase().padStart(7, '0').slice(-6);
}

/* ── grid helpers ─────────────────────────────────────────────────────── */
export const at = (x, y) => y * MAP_W + x;
export const colOf = i => i % MAP_W;
export const rowOf = i => (i / MAP_W) | 0;
const inside = (x, y) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;

/** Orthogonal and diagonal offsets, with their step lengths. */
const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]
];

/* ── noise ────────────────────────────────────────────────────────────── */
function valueNoise(rand, scale) {
  const gw = Math.ceil(MAP_W / scale) + 2, gh = Math.ceil(MAP_H / scale) + 2;
  const lattice = new Float32Array(gw * gh).map(() => rand());
  const smooth = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = x / scale, fy = y / scale;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = smooth(fx - x0), ty = smooth(fy - y0);
    const v = (a, b) => lattice[b * gw + a];
    const top = v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx;
    const bot = v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bot * ty;
  };
}

/* ── generation ───────────────────────────────────────────────────────── */
/** Share of the map below each threshold: water, low ground, hills. */
const QUANTILES = [0.10, 0.48, 0.80];
const MAX_ATTEMPTS = 12;
/** Radius of the flat pad each Commander starts on: room for a Factory,
    its Helpers and a first ring of towers. */
const PAD = 6.5;

/**
 * Build the map for `seed`. Returns
 *   { seed, height: Int8Array, ramp: Uint8Array, hq, enemy, links, quality }
 * where `hq` and `enemy` are the cells the two Commanders start on.
 */
export function generate(seed) {
  let best = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const map = attemptMap((seed + Math.imul(attempt, 0x632be5ab)) >>> 0);
    map.seed = seed;
    if (!best || map.quality > best.quality) best = map;
    if (map.quality >= 1) break;
  }
  if (best.quality <= 0) carveCorridor(best);
  best.links = buildLinks(best);
  return best;
}

function attemptMap(seed) {
  const rand = rng(seed);
  const n1 = valueNoise(rand, 13), n2 = valueNoise(rand, 6.5), n3 = valueNoise(rand, 3.2);
  const raw = new Float32Array(MAP_W * MAP_H);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      raw[at(x, y)] = 0.58 * n1(x, y) + 0.29 * n2(x, y) + 0.13 * n3(x, y);
    }
  }

  // Quantile thresholds, so every map has a similar share of each height.
  const sorted = Float32Array.from(raw).sort();
  const cuts = QUANTILES.map(q => sorted[Math.floor(q * sorted.length)]);
  const height = new Int8Array(MAP_W * MAP_H);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    height[i] = v < cuts[0] ? WATER : v < cuts[1] ? 0 : v < cuts[2] ? 1 : 2;
  }
  despeckle(height);
  despeckle(height);

  // Bases sit near the short edges, somewhere in the middle band.
  const band = () => 9 + Math.floor(rand() * (MAP_H - 18));
  const hq = { x: 7, y: band() };
  const enemy = { x: MAP_W - 8, y: band() };
  flatten(height, hq);
  flatten(height, enemy);

  const ramp = new Uint8Array(MAP_W * MAP_H);
  cutRamps(height, ramp, rand);

  const map = { seed, height, ramp, hq, enemy, quality: 0 };
  map.quality = judge(map);
  return map;
}

/** Cells with fewer than two same-class neighbours take the local majority. */
function despeckle(height) {
  const copy = Int8Array.from(height);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = at(x, y);
      const counts = new Map();
      let same = 0;
      for (const [dx, dy] of DIRS.slice(0, 4)) {
        if (!inside(x + dx, y + dy)) continue;
        const h = copy[at(x + dx, y + dy)];
        if (h === copy[i]) same++;
        counts.set(h, (counts.get(h) || 0) + 1);
      }
      if (same >= 2) continue;
      let pick = copy[i], most = 0;
      for (const [h, n] of counts) if (n > most) { most = n; pick = h; }
      height[i] = pick;
    }
  }
}

/** Level the ground around a start, and never let it be water. */
function flatten(height, base) {
  const counts = [0, 0, 0];
  for (let y = -3; y <= 3; y++) {
    for (let x = -3; x <= 3; x++) {
      const h = height[at(base.x + x, base.y + y)];
      if (h >= 0) counts[h]++;
    }
  }
  const level = counts[1] >= counts[0] && counts[1] >= counts[2] ? 1 : counts[0] >= counts[2] ? 0 : 2;
  for (let y = -7; y <= 7; y++) {
    for (let x = -7; x <= 7; x++) {
      if (!inside(base.x + x, base.y + y) || Math.hypot(x, y) > PAD) continue;
      height[at(base.x + x, base.y + y)] = level;
    }
  }
}

/** 4-connected regions of equal height, water excluded. */
function regions(height) {
  const id = new Int32Array(MAP_W * MAP_H).fill(-1);
  let n = 0;
  for (let s = 0; s < id.length; s++) {
    if (id[s] !== -1 || height[s] < 0) continue;
    const stack = [s];
    id[s] = n;
    while (stack.length) {
      const u = stack.pop();
      const x = colOf(u), y = rowOf(u);
      for (const [dx, dy] of DIRS.slice(0, 4)) {
        if (!inside(x + dx, y + dy)) continue;
        const v = at(x + dx, y + dy);
        if (id[v] === -1 && height[v] === height[u]) { id[v] = n; stack.push(v); }
      }
    }
    n++;
  }
  return id;
}

/**
 * Every pair of neighbouring plateaus one height apart gets one to three
 * ramps, spaced out along their shared edge. Each ramp is two cells wide
 * where the edge allows it, so a ramp reads as a road rather than a gap.
 */
function cutRamps(height, ramp, rand) {
  const id = regions(height);
  const edges = new Map();
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const a = at(x, y);
      if (height[a] < 0) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (!inside(x + dx, y + dy)) continue;
        const b = at(x + dx, y + dy);
        if (height[b] < 0 || Math.abs(height[a] - height[b]) !== 1) continue;
        const lo = height[a] < height[b] ? a : b;
        const key = Math.min(id[a], id[b]) + ':' + Math.max(id[a], id[b]);
        if (!edges.has(key)) edges.set(key, []);
        edges.get(key).push({ lo, hi: lo === a ? b : a, horiz: dx === 1 });
      }
    }
  }

  for (const list of edges.values()) {
    const want = list.length < 6 ? 1 : Math.min(3, 1 + Math.floor(list.length / 16));
    const chosen = [];
    for (let tries = 0; chosen.length < want && tries < want * 12; tries++) {
      const pick = list[Math.floor(rand() * list.length)];
      const px = colOf(pick.lo), py = rowOf(pick.lo);
      if (chosen.some(c => Math.hypot(colOf(c.lo) - px, rowOf(c.lo) - py) < 6)) continue;
      chosen.push(pick);
    }
    for (const c of chosen) {
      ramp[c.lo] = 1;
      ramp[c.hi] = 1;
      // Widen along the edge: the neighbour across the step's axis.
      const x = colOf(c.lo), y = rowOf(c.lo);
      const [wx, wy] = c.horiz ? [0, 1] : [1, 0];
      const side = at(x + wx, y + wy), sideHi = at(colOf(c.hi) + wx, rowOf(c.hi) + wy);
      if (inside(x + wx, y + wy) && height[side] === height[c.lo] && height[sideHi] === height[c.hi]) {
        ramp[side] = 1;
        ramp[sideHi] = 1;
      }
    }
  }
}

/* ── movement rules ───────────────────────────────────────────────────── */
/** Can a walker step between two orthogonal neighbours? */
export function canStep(map, a, b) {
  const ha = map.height[a], hb = map.height[b];
  if (ha < 0 || hb < 0) return false;
  if (ha === hb) return true;
  return Math.abs(ha - hb) === 1 && !!(map.ramp[a] || map.ramp[b]);
}

/**
 * Every legal 8-way step, as flat adjacency: for cell `i` its neighbours
 * are `to[off[i]..off[i+1])` with lengths in `len`. Diagonals need both
 * orthogonal corners to be steppable, so nothing cuts a cliff corner.
 */
function buildLinks(map) {
  const off = new Int32Array(MAP_W * MAP_H + 1);
  const to = [], len = [];
  for (let i = 0; i < MAP_W * MAP_H; i++) {
    off[i] = to.length;
    const x = colOf(i), y = rowOf(i);
    for (const [dx, dy, d] of DIRS) {
      if (!inside(x + dx, y + dy)) continue;
      const j = at(x + dx, y + dy);
      if (dx && dy) {
        const c1 = at(x + dx, y), c2 = at(x, y + dy);
        if (!(canStep(map, i, c1) && canStep(map, c1, j) && canStep(map, i, c2) && canStep(map, c2, j))) continue;
      } else if (!canStep(map, i, j)) continue;
      to.push(j);
      len.push(d);
    }
  }
  off[MAP_W * MAP_H] = to.length;
  return { off, to: Int32Array.from(to), len: Float32Array.from(len) };
}

/** Plain BFS reach over orthogonal steps, optionally avoiding some cells. */
function reach(map, from, avoid) {
  const dist = new Int32Array(MAP_W * MAP_H).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h];
    const x = colOf(u), y = rowOf(u);
    for (const [dx, dy] of DIRS.slice(0, 4)) {
      if (!inside(x + dx, y + dy)) continue;
      const v = at(x + dx, y + dy);
      if (dist[v] !== -1 || (avoid && avoid[v]) || !canStep(map, u, v)) continue;
      dist[v] = dist[u] + 1;
      queue.push(v);
    }
  }
  return dist;
}

/**
 * 0 when the bases do not connect; 0.5 when they do by one road only; 1
 * when blocking the shortest road still leaves a second one not much
 * longer - two real lanes make the enemy's route choice matter.
 */
function judge(map) {
  const from = at(map.hq.x, map.hq.y), goal = at(map.enemy.x, map.enemy.y);
  const dist = reach(map, from);
  if (dist[goal] === -1) return 0;

  // Walk the shortest road back and block it away from the base pads.
  const avoid = new Uint8Array(MAP_W * MAP_H);
  let u = goal;
  while (u !== from) {
    const x = colOf(u), y = rowOf(u);
    const far = Math.hypot(x - map.hq.x, y - map.hq.y) > PAD + 2 && Math.hypot(x - map.enemy.x, y - map.enemy.y) > PAD + 2;
    if (far) avoid[u] = 1;
    let next = -1;
    for (const [dx, dy] of DIRS.slice(0, 4)) {
      if (!inside(x + dx, y + dy)) continue;
      const v = at(x + dx, y + dy);
      if (dist[v] === dist[u] - 1 && canStep(map, u, v)) { next = v; break; }
    }
    u = next;
  }
  const alt = reach(map, from, avoid);
  if (alt[goal] === -1) return 0.5;
  return alt[goal] <= dist[goal] * 1.7 ? 1 : 0.75;
}

/** Last resort: a ramped road straight between the bases. */
function carveCorridor(map) {
  let x = map.hq.x, y = map.hq.y;
  let prev = map.height[at(x, y)];
  while (x !== map.enemy.x || y !== map.enemy.y) {
    if (x !== map.enemy.x && (y === map.enemy.y || (x + y) % 2)) x += Math.sign(map.enemy.x - x);
    else y += Math.sign(map.enemy.y - y);
    const i = at(x, y);
    const h = Math.max(prev - 1, Math.min(prev + 1, Math.max(0, map.height[i])));
    map.height[i] = h;
    map.ramp[i] = 1;
    prev = h;
  }
  map.quality = 0.5;
}

/* ── route planning ───────────────────────────────────────────────────── */
/**
 * Dijkstra outward from `sources`. `extra(i)` is the added cost of
 * entering cell i (Infinity = impassable). Returns `dist` (cost to the
 * nearest source) and `next` (the cell to step to, -1 at a source or where
 * nothing is reachable).
 */
export function flowField(map, sources, extra) {
  const size = MAP_W * MAP_H;
  // Float64: the heap keeps doubles, and a float32 round-down would make
  // every popped entry look stale.
  const dist = new Float64Array(size).fill(Infinity);
  const next = new Int32Array(size).fill(-1);
  const heap = new MinHeap();
  for (const s of sources) { dist[s] = 0; heap.push(s, 0); }
  const { off, to, len } = map.links;

  while (heap.size) {
    const [u, du] = heap.pop();
    if (du > dist[u]) continue;
    // A walker at v steps into u, so u's cost is what the move pays.
    // Sources are free to enter; an impassable cell never passes a route on.
    const cu = du > 0 ? extra(u) : 0;
    if (cu === Infinity) continue;
    for (let k = off[u]; k < off[u + 1]; k++) {
      const v = to[k];
      const nd = du + len[k] + cu;
      if (nd < dist[v]) {
        dist[v] = nd;
        next[v] = u;
        heap.push(v, nd);
      }
    }
  }
  return { dist, next };
}

class MinHeap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    const k = this.k, p = this.p;
    let n = k.length;
    k.push(key); p.push(pri);
    while (n > 0) {
      const up = (n - 1) >> 1;
      if (p[up] <= pri) break;
      k[n] = k[up]; p[n] = p[up];
      n = up;
    }
    k[n] = key; p[n] = pri;
  }
  pop() {
    const k = this.k, p = this.p;
    const top = [k[0], p[0]];
    const lastK = k.pop(), lastP = p.pop();
    const size = k.length;
    if (size) {
      let n = 0;
      for (;;) {
        let c = 2 * n + 1;
        if (c >= size) break;
        if (c + 1 < size && p[c + 1] < p[c]) c++;
        if (p[c] >= lastP) break;
        k[n] = k[c]; p[n] = p[c];
        n = c;
      }
      k[n] = lastK; p[n] = lastP;
    }
    return top;
  }
}
