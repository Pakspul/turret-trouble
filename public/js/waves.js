/* ══ wave composition ════════════════════════════════════════════════════
   A wave is a flat list of {type, at, hpMul, spdMul} spawn orders sorted by
   spawn time. Waves are generated one ahead so Recon Uplink can show the
   exact roster the player is about to face.                              */

import { SPAWN_TABLE } from './config.js';

export function buildWave(w) {
  const list = [];
  const hpMul = Math.pow(1.135, w - 1);
  const spdMul = 1 + Math.min(0.5, w * 0.008);

  const pool = SPAWN_TABLE.filter(entry => w >= entry.from);
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
  const count = Math.min(48, 7 + Math.floor(w * 1.15));

  let at = 0;
  for (let k = 0; k < count; k++) {
    let roll = Math.random() * total;
    let type = pool[0].type;
    for (const entry of pool) {
      roll -= entry.weight;
      if (roll <= 0) { type = entry.type; break; }
    }
    list.push({ type, at, hpMul, spdMul });
    // Swarms trickle in tightly; everything else spaces out, and the gap
    // shrinks slowly as waves climb.
    at += type === 'swarm' ? 0.22 : 0.62 - Math.min(0.28, w * 0.006);
  }

  if (w % 10 === 0) {
    const bosses = 1 + Math.floor(w / 40);
    for (let b = 0; b < bosses; b++) {
      list.push({ type: 'titan', at: at + 1 + b * 2.2, hpMul: hpMul * 0.85, spdMul });
    }
  }

  return list.sort((a, b) => a.at - b.at);
}

/** Type -> count, for the Recon Uplink preview. */
export function summarise(list) {
  const counts = new Map();
  for (const order of list) counts.set(order.type, (counts.get(order.type) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
