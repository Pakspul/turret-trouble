/* ══ renderer ════════════════════════════════════════════════════════════
   Owns the canvas, the grid-to-pixel projection, and every draw call.
   Reads simulation state; never writes it.                              */

import { COLS, ROWS, SPAWN_R, GOAL_R, cx, cy, TOWERS } from './config.js';
import { field, legal } from './field.js';
import { S, statsOf, maxTier, buildCost, bindProjection } from './game.js';
import * as meta from './meta.js';

let cv, ctx, stage;
let W = 0, H = 0, cell = 32, ox = 0, oy = 0;

export const px = u => ox + u * cell;
export const py = u => oy + u * cell;

export function init(canvas, host) {
  cv = canvas;
  stage = host;
  ctx = cv.getContext('2d');
  bindProjection(px, py);
  layout();
  addEventListener('resize', layout);
  addEventListener('orientationchange', () => setTimeout(layout, 200));
}

export function layout() {
  const rect = stage.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2.5);
  W = rect.width; H = rect.height;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cell = Math.min(W / COLS, H / ROWS);
  ox = (W - cell * COLS) / 2;
  oy = (H - cell * ROWS) / 2;
}

/** Pointer coordinates -> cell index, or -1 outside the grid. */
export function cellAt(ev) {
  const rect = cv.getBoundingClientRect();
  const c = Math.floor((ev.clientX - rect.left - ox) / cell);
  const r = Math.floor((ev.clientY - rect.top - oy) / cell);
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return -1;
  return r * COLS + c;
}

/* ── main pass ────────────────────────────────────────────────────────── */
export function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  if (S.shake > 0) {
    ctx.translate((Math.random() - 0.5) * S.shake * 7, (Math.random() - 0.5) * S.shake * 7);
  }

  drawField();
  drawRoute();
  drawPlacementPreview();
  drawSelection();

  for (const t of field.grid) if (t) drawAura(t);
  for (const t of field.grid) if (t) drawTower(t, false);
  drawBeams();

  for (const e of S.foes) drawFoe(e);

  drawArcs();
  drawShots();
  drawBlasts();
  drawMotes();
  drawNotes();
  drawBanners();

  ctx.restore();
}

function drawField() {
  ctx.fillStyle = '#0e141a';
  ctx.fillRect(px(0), py(0), cell * COLS, cell * ROWS);

  ctx.fillStyle = 'rgba(76,201,240,.05)';
  ctx.fillRect(px(0), py(0), cell, cell * ROWS);
  ctx.fillStyle = 'rgba(255,95,109,.06)';
  ctx.fillRect(px(COLS - 1), py(0), cell, cell * ROWS);

  ctx.strokeStyle = '#18222b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= COLS; c++) {
    ctx.moveTo(Math.round(px(c)) + 0.5, py(0));
    ctx.lineTo(Math.round(px(c)) + 0.5, py(ROWS));
  }
  for (let r = 0; r <= ROWS; r++) {
    ctx.moveTo(px(0), Math.round(py(r)) + 0.5);
    ctx.lineTo(px(COLS), Math.round(py(r)) + 0.5);
  }
  ctx.stroke();

  gate(px(0.5), py(SPAWN_R + 0.5), '#4cc9f0');
  gate(px(COLS - 0.5), py(GOAL_R + 0.5), '#ff5f6d');
}

function gate(x, y, colour) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.5, cell * 0.07);
  ctx.lineCap = 'round';
  const s = cell * 0.26;
  ctx.beginPath();
  ctx.moveTo(-s, -s); ctx.lineTo(s, 0); ctx.lineTo(-s, s);
  ctx.stroke();
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.arc(0, 0, cell * 0.42, 0, 6.284);
  ctx.stroke();
  ctx.restore();
}

function drawRoute() {
  if (!field.path || field.path.length < 2) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(125,223,143,.30)';
  ctx.lineWidth = Math.max(2, cell * 0.1);
  ctx.setLineDash([cell * 0.22, cell * 0.3]);
  ctx.lineDashOffset = -(performance.now() / 26) % 1000;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(px(-0.4), py(SPAWN_R + 0.5));
  for (const p of field.path) ctx.lineTo(px(cx(p) + 0.5), py(cy(p) + 0.5));
  ctx.lineTo(px(COLS + 0.4), py(GOAL_R + 0.5));
  ctx.stroke();
  ctx.restore();
}

function drawPlacementPreview() {
  if (!S.picked || S.hover < 0) return;
  const def = TOWERS[S.picked];
  const range = def.lv[0].range * meta.mods.range;
  const ok = !!legal(S.hover, S.foes) && S.gold >= buildCost(S.picked);
  const hx = px(cx(S.hover) + 0.5), hy = py(cy(S.hover) + 0.5);

  ctx.beginPath();
  ctx.arc(hx, hy, range * cell, 0, 6.284);
  ctx.fillStyle = ok ? 'rgba(255,255,255,.05)' : 'rgba(255,95,109,.07)';
  ctx.fill();
  ctx.strokeStyle = ok ? 'rgba(255,255,255,.28)' : 'rgba(255,95,109,.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.globalAlpha = 0.6;
  drawTower({ i: S.hover, k: S.picked, l: 0, ang: -0.5, kick: 0 }, true);
  ctx.globalAlpha = 1;

  if (!ok) {
    ctx.strokeStyle = '#ff5f6d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hx - cell * 0.28, hy - cell * 0.28);
    ctx.lineTo(hx + cell * 0.28, hy + cell * 0.28);
    ctx.moveTo(hx + cell * 0.28, hy - cell * 0.28);
    ctx.lineTo(hx - cell * 0.28, hy + cell * 0.28);
    ctx.stroke();
  }
}

function drawSelection() {
  const t = S.selected;
  if (!t || field.grid[t.i] !== t) return;
  const st = statsOf(t);
  ctx.beginPath();
  ctx.arc(px(cx(t.i) + 0.5), py(cy(t.i) + 0.5), st.range * cell, 0, 6.284);
  ctx.fillStyle = 'rgba(255,255,255,.045)';
  ctx.fill();
  ctx.strokeStyle = TOWERS[t.k].color;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawAura(t) {
  if (TOWERS[t.k].kind !== 'aura' || !t.ring) return;
  const st = statsOf(t);
  const k = 1 - t.ring;
  ctx.beginPath();
  ctx.arc(px(cx(t.i) + 0.5), py(cy(t.i) + 0.5), st.range * cell * (0.25 + k * 0.8), 0, 6.284);
  ctx.strokeStyle = TOWERS.frost.color;
  ctx.globalAlpha = t.ring * 0.7;
  ctx.lineWidth = cell * 0.1 * t.ring + 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawTower(t, ghost) {
  const def = TOWERS[t.k];
  const x = px(cx(t.i) + 0.5), y = py(cy(t.i) + 0.5), s = cell * 0.40;

  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#18222c';
  ctx.strokeStyle = def.color;
  ctx.lineWidth = 1.4;
  roundRect(-s, -s, s * 2, s * 2, cell * 0.12);
  ctx.fill();
  ctx.stroke();

  ctx.rotate(t.ang || 0);
  const recoil = (t.kick || 0) * cell * 0.1;
  ctx.fillStyle = def.color;

  if (t.k === 'gun') {
    ctx.fillRect(-recoil, -cell * 0.07, cell * 0.38, cell * 0.14);
    ctx.beginPath(); ctx.arc(0, 0, cell * 0.17, 0, 6.284); ctx.fill();
  } else if (t.k === 'rocket') {
    ctx.fillRect(-recoil, -cell * 0.19, cell * 0.34, cell * 0.1);
    ctx.fillRect(-recoil, cell * 0.09, cell * 0.34, cell * 0.1);
    ctx.fillStyle = '#2a3644';
    ctx.fillRect(-cell * 0.16, -cell * 0.13, cell * 0.2, cell * 0.26);
  } else if (t.k === 'laser') {
    ctx.beginPath();
    ctx.moveTo(cell * 0.34, 0);
    ctx.lineTo(-cell * 0.12, -cell * 0.18);
    ctx.lineTo(-cell * 0.12, cell * 0.18);
    ctx.closePath(); ctx.fill();
  } else if (t.k === 'frost') {
    // Six-spoke emitter, drawn unrotated so it reads as an omni tower.
    ctx.rotate(-(t.ang || 0));
    ctx.lineWidth = Math.max(1.5, cell * 0.06);
    ctx.strokeStyle = def.color;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * 6.284;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * cell * 0.26, Math.sin(a) * cell * 0.26);
    }
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, cell * 0.1, 0, 6.284); ctx.fill();
  } else {
    // Tesla: a pair of prongs with a spark bridging them.
    ctx.rotate(-(t.ang || 0));
    ctx.lineWidth = Math.max(1.5, cell * 0.07);
    ctx.strokeStyle = def.color;
    ctx.beginPath();
    ctx.moveTo(-cell * 0.16, cell * 0.2); ctx.lineTo(-cell * 0.16, -cell * 0.14);
    ctx.moveTo(cell * 0.16, cell * 0.2); ctx.lineTo(cell * 0.16, -cell * 0.14);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0, -cell * 0.05, cell * 0.09, 0, 6.284); ctx.fill();
  }
  ctx.restore();

  if (!ghost && t.l > 0) {
    ctx.fillStyle = def.color;
    for (let k = 0; k <= t.l; k++) {
      ctx.fillRect(x - s + 3 + k * (cell * 0.13), y + s - cell * 0.13, cell * 0.08, cell * 0.07);
    }
  }
}

function drawBeams() {
  for (const t of field.grid) {
    if (!t || TOWERS[t.k].kind !== 'beam' || !t.beam || t.beam.dead) continue;
    const ax = px(cx(t.i) + 0.5), ay = py(cy(t.i) + 0.5);
    const w = cell * (0.06 + 0.05 * (t.focus / 2.2));
    ctx.strokeStyle = TOWERS[t.k].color;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(px(t.beam.x), py(t.beam.y));
    ctx.stroke();
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = w * 3;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawArcs() {
  for (const arc of S.arcs) {
    const alpha = Math.min(1, arc.t / 0.14);
    ctx.strokeStyle = TOWERS.tesla.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const pass of [{ w: cell * 0.22, a: 0.2 }, { w: cell * 0.06, a: 1 }]) {
      ctx.globalAlpha = alpha * pass.a;
      ctx.lineWidth = pass.w;
      ctx.beginPath();
      for (let n = 0; n < arc.points.length - 1; n++) {
        const a = arc.points[n], b = arc.points[n + 1];
        ctx.moveTo(px(a.x), py(a.y));
        // A single jagged midpoint is enough to read as lightning.
        const mx = (a.x + b.x) / 2 + (Math.random() - 0.5) * 0.35;
        const my = (a.y + b.y) / 2 + (Math.random() - 0.5) * 0.35;
        ctx.lineTo(px(mx), py(my));
        ctx.lineTo(px(b.x), py(b.y));
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function drawShots() {
  for (const s of S.shots) {
    ctx.save();
    ctx.translate(px(s.x), py(s.y));
    ctx.rotate(s.a || 0);
    ctx.fillStyle = s.crit ? '#ffe08a' : s.col;
    if (s.k === 'gun') {
      ctx.fillRect(-cell * 0.09, -cell * 0.035, cell * 0.18, cell * 0.07);
    } else {
      ctx.beginPath();
      ctx.moveTo(cell * 0.16, 0);
      ctx.lineTo(-cell * 0.1, -cell * 0.08);
      ctx.lineTo(-cell * 0.1, cell * 0.08);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(-cell * 0.18, 0, cell * 0.1 * (0.6 + Math.random() * 0.5), 0, 6.284);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}

function drawBlasts() {
  for (const b of S.blasts) {
    const k = 1 - b.t / 0.3;
    ctx.beginPath();
    ctx.arc(px(b.x), py(b.y), b.r * cell * (0.35 + k * 0.8), 0, 6.284);
    ctx.strokeStyle = b.col;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = cell * 0.14 * (1 - k) + 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawMotes() {
  for (const m of S.motes) {
    ctx.globalAlpha = Math.max(0, m.t / 0.45);
    ctx.fillStyle = m.c;
    ctx.fillRect(px(m.x) - cell * 0.04, py(m.y) - cell * 0.04, cell * 0.08, cell * 0.08);
  }
  ctx.globalAlpha = 1;
}

function drawNotes() {
  ctx.textAlign = 'center';
  ctx.font = '600 ' + Math.max(10, cell * 0.32) + 'px system-ui,sans-serif';
  for (const n of S.notes) {
    ctx.globalAlpha = Math.min(1, n.t * 1.6);
    ctx.fillStyle = n.c;
    ctx.fillText(n.s, n.x, n.y);
  }
  ctx.globalAlpha = 1;
}

function drawBanners() {
  ctx.textAlign = 'center';

  if (S.waveFlash > 0) {
    ctx.globalAlpha = Math.min(1, S.waveFlash);
    ctx.fillStyle = '#d7e3ec';
    ctx.font = '600 ' + Math.round(cell * 0.8) + 'px system-ui,sans-serif';
    ctx.fillText('Wave ' + S.wave, px(COLS / 2), py(1.4));
    ctx.globalAlpha = 1;
  }

  if (S.warn > 0) {
    ctx.globalAlpha = Math.min(1, S.warn * 2);
    ctx.fillStyle = '#ff5f6d';
    ctx.font = '600 ' + Math.max(11, cell * 0.34) + 'px system-ui,sans-serif';
    ctx.fillText(S.warnText, px(COLS / 2), py(ROWS - 0.35));
    ctx.globalAlpha = 1;
  }

  if (S.paused && S.phase !== 'dead' && S.phase !== 'menu') {
    ctx.fillStyle = 'rgba(12,17,22,.55)';
    ctx.fillRect(px(0), py(0), cell * COLS, cell * ROWS);
    ctx.fillStyle = '#d7e3ec';
    ctx.font = '600 ' + Math.round(cell * 0.6) + 'px system-ui,sans-serif';
    ctx.fillText('Paused', px(COLS / 2), py(ROWS / 2));
  }
}

function drawFoe(e) {
  const d = e.def;
  const x = px(e.x), y = py(e.y), r = cell * d.rad;

  if (d.fly) {
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath();
    ctx.ellipse(x + cell * 0.16, y + cell * 0.2, r * 0.8, r * 0.35, 0, 0, 6.284);
    ctx.fill();
  }

  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = e.hit > 0 ? '#ffffff' : d.col;

  if (d.fly) {
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(-r * 0.7, -r * 0.8);
    ctx.lineTo(-r * 0.3, 0);
    ctx.lineTo(-r * 0.7, r * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.5, r * 0.3 * Math.abs(Math.cos(e.ph)), 0, 0, 6.284);
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (d.armor > 0.4) {
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * 6.284;
      const vx = Math.cos(a) * r, vy = Math.sin(a) * r;
      k ? ctx.lineTo(vx, vy) : ctx.moveTo(vx, vy);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, 6.284);
    ctx.fill();
  }

  if (d.boss) {
    ctx.strokeStyle = '#ffd76b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r + 3, 0, 6.284);
    ctx.stroke();
  }

  // Frozen targets get a cyan halo so the slow is legible at a glance.
  if (e.slow > 0) {
    ctx.strokeStyle = TOWERS.frost.color;
    ctx.globalAlpha = 0.35 + 0.35 * e.slow;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r + 4, 0, 6.284);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  const frac = Math.max(0, e.hp / e.max);
  if (frac < 1) {
    const w = r * 2.1, h = Math.max(2, cell * 0.06), by = y - r - h - 2;
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    ctx.fillRect(x - w / 2, by, w, h);
    ctx.fillStyle = frac > 0.5 ? '#7ddf8f' : frac > 0.22 ? '#f2c14b' : '#ff5f6d';
    ctx.fillRect(x - w / 2, by, w * frac, h);
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

