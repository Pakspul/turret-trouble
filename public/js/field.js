/* ══ the field ═══════════════════════════════════════════════════════════
   Tower occupancy plus the breadth-first flow field that walks every
   ground enemy toward the exit. Flyers ignore all of this.               */

import { COLS, ROWS, SPAWN, GOAL, cx, cy, buildable } from './config.js';

export const field = {
  /** cell index -> tower object, or null */
  grid: new Array(COLS * ROWS).fill(null),
  /** steps to the exit from each cell, -1 where unreachable */
  dist: null,
  /** next cell on the way to the exit, -1 where unreachable */
  flow: null,
  /** the spawn-to-exit route, for the dashed overlay */
  path: []
};

/**
 * BFS outward from the exit. `block` lets a caller test a hypothetical
 * tower placement without mutating the grid.
 */
export function solve(block = -1) {
  const size = COLS * ROWS;
  const dist = new Int32Array(size).fill(-1);
  const flow = new Int32Array(size).fill(-1);
  const queue = [GOAL];
  dist[GOAL] = 0;

  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    const c = cx(u), r = cy(u);
    const neighbours = [];
    if (c > 0) neighbours.push(u - 1);
    if (c < COLS - 1) neighbours.push(u + 1);
    if (r > 0) neighbours.push(u - COLS);
    if (r < ROWS - 1) neighbours.push(u + COLS);

    for (const v of neighbours) {
      if (dist[v] !== -1) continue;
      if (field.grid[v] || v === block) continue;
      dist[v] = dist[u] + 1;
      flow[v] = u;
      queue.push(v);
    }
  }
  return { dist, flow };
}

export function commit(solution) {
  field.dist = solution.dist;
  field.flow = solution.flow;

  const route = [];
  let p = SPAWN, guard = 0;
  while (p !== -1 && guard++ < COLS * ROWS) {
    route.push(p);
    if (p === GOAL) break;
    p = field.flow[p];
  }
  field.path = route;
}

/**
 * A placement is legal only when the spawn and every ground walker still
 * reach the exit, and no walker is standing on (or entering) the cell.
 * Returns the resulting solution so the caller can commit it directly.
 */
export function legal(i, foes) {
  if (!buildable(i) || field.grid[i]) return false;

  for (const e of foes) {
    if (e.def.fly) continue;
    if (e.cc === i || (e.to && e.to.i === i)) return false;
  }

  const solution = solve(i);
  if (solution.dist[SPAWN] === -1) return false;
  for (const e of foes) {
    if (e.def.fly) continue;
    const at = e.to ? e.to.i : e.cc;
    if (solution.dist[at] === -1) return false;
  }
  return solution;
}

export function clearGrid() {
  field.grid.fill(null);
  commit(solve());
}

export function reset() {
  field.grid = new Array(COLS * ROWS).fill(null);
  commit(solve());
}
