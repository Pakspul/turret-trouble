/* ══ Frontier renderer ═══════════════════════════════════════════════════
   Draws the Frontier map through a camera you can drag and zoom. Terrain
   is painted once per map into an offscreen canvas and blitted each frame;
   everything that moves is drawn on top in world coordinates (cells) and
   projected here. Turrets and enemies are Holdout's own drawings, so the
   two modes read as one game. Reads state; never writes it.             */

import { TOWERS, MAP_W, MAP_H, HQ_HALF, WATER } from './config.js';
import { S } from './game.js';
import { F, canBuild, rangeOf, buildCost } from './frontier.js';
import { drawTurret, drawEnemy } from './render.js';
import { at, colOf, rowOf } from './terrain.js';

let cv, ctx, stage;
let W = 0, H = 0;

/** Camera: the world point at the centre of the view, and pixels per cell. */
export const cam = { x: MAP_W / 2, y: MAP_H / 2, z: 32 };

const sx = x => (x - cam.x) * cam.z + W / 2;
const sy = y => (y - cam.y) * cam.z + H / 2;

export function init(canvas, host) {
  cv = canvas;
  stage = host;
  ctx = cv.getContext('2d');
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
  clamp();
}

/* ── camera ───────────────────────────────────────────────────────────── */
/** Zoomed all the way out, the whole map fits the stage. */
const zMin = () => Math.min(W / MAP_W, H / MAP_H);
const Z_MAX = 72;

function clamp() {
  cam.z = Math.max(zMin(), Math.min(Z_MAX, cam.z));
  const hw = W / 2 / cam.z, hh = H / 2 / cam.z;
  cam.x = hw * 2 >= MAP_W ? MAP_W / 2 : Math.max(hw, Math.min(MAP_W - hw, cam.x));
  cam.y = hh * 2 >= MAP_H ? MAP_H / 2 : Math.max(hh, Math.min(MAP_H - hh, cam.y));
}

/** Frame your HQ at a comfortable zoom - called when a sortie opens. */
export function home() {
  cam.z = Math.max(22, Math.min(36, W / 26));
  cam.x = F.hq.x + W / cam.z * 0.3;
  cam.y = F.hq.y;
  clamp();
}

export function focus(x, y) {
  cam.x = x; cam.y = y;
  clamp();
}

/** Drag the map by a screen-space delta. */
export function pan(dx, dy) {
  cam.x -= dx / cam.z;
  cam.y -= dy / cam.z;
  clamp();
}

/** Zoom by `factor`, keeping the world point under (px, py) still. */
export function zoomAt(px, py, factor) {
  const wx = (px - W / 2) / cam.z + cam.x, wy = (py - H / 2) / cam.z + cam.y;
  cam.z *= factor;
  clamp();
  cam.x = wx - (px - W / 2) / cam.z;
  cam.y = wy - (py - H / 2) / cam.z;
  clamp();
}

/** Stage-relative pointer position. */
export function local(ev) {
  const rect = cv.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

/** Pointer -> map cell index, or -1 off the map. */
export function cellAt(ev) {
  const p = local(ev);
  const x = Math.floor((p.x - W / 2) / cam.z + cam.x);
  const y = Math.floor((p.y - H / 2) / cam.z + cam.y);
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return -1;
  return at(x, y);
}

/* ── minimap ──────────────────────────────────────────────────────────── */
function miniBox() {
  const w = Math.round(Math.min(180, Math.max(110, W * 0.22)));
  const h = Math.round(w * MAP_H / MAP_W);
  return { x: 8, y: H - h - 8, w, h };
}

/** A pointer on the minimap -> the world point it shows, or null. */
export function miniHit(ev) {
  if (!F.map) return null;
  const p = local(ev);
  const b = miniBox();
  if (p.x < b.x || p.y < b.y || p.x > b.x + b.w || p.y > b.y + b.h) return null;
  return { x: (p.x - b.x) / b.w * MAP_W, y: (p.y - b.y) / b.h * MAP_H };
}

/* ── terrain, painted once per map ────────────────────────────────────── */
const TILE = 24;
const LAND = ['#121b1e', '#19272a', '#223538'];
const LAND_MINI = ['#1b2a2e', '#25383c', '#31494d'];
let paintedFor = null, terrainImg = null, miniImg = null;

function hash(i) {
  let h = Math.imul(i ^ 0x27d4eb2d, 0x165667b1);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function paintTerrain() {
  const m = F.map;
  paintedFor = m;
  terrainImg = document.createElement('canvas');
  terrainImg.width = MAP_W * TILE;
  terrainImg.height = MAP_H * TILE;
  const g = terrainImg.getContext('2d');
  const h = m.height;
  const hAt = (x, y) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H ? null : h[at(x, y)]);

  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = at(x, y), v = h[i];
      const X = x * TILE, Y = y * TILE;
      if (v === WATER) {
        g.fillStyle = '#0b1f2c';
        g.fillRect(X, Y, TILE, TILE);
        g.strokeStyle = 'rgba(111,216,255,.07)';
        g.lineWidth = 1;
        const o = hash(i) * TILE;
        g.beginPath();
        g.moveTo(X + 3, Y + o * 0.6 + 4); g.lineTo(X + TILE * 0.55, Y + o * 0.6 + 4);
        g.stroke();
        continue;
      }
      g.fillStyle = LAND[v];
      g.fillRect(X, Y, TILE, TILE);
      // Scrub: a few specks so open ground is not a flat slab.
      const r = hash(i);
      if (r < 0.45) {
        g.fillStyle = v === 2 ? '#26393b' : '#1f2f30';
        g.fillRect(X + r * 40 % TILE, Y + (r * 97) % TILE, 2, 2);
        g.fillRect(X + (r * 71) % TILE, Y + (r * 13) % TILE, 1.5, 1.5);
      }
      if (m.ramp[i]) {
        g.strokeStyle = 'rgba(160,190,170,.13)';
        g.lineWidth = 2;
        g.beginPath();
        for (let k = -TILE; k < TILE; k += 6) {
          g.moveTo(X + Math.max(0, k), Y + Math.max(0, -k));
          g.lineTo(X + Math.min(TILE, k + TILE), Y + Math.min(TILE, TILE - k));
        }
        g.stroke();
      }
    }
  }

  // Cliffs and shores: a lit lip on the high side, a shadow on the low.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = at(x, y), v = h[i];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = hAt(x + dx, y + dy);
        if (n === null || n >= v) continue;
        const j = at(x + dx, y + dy);
        const soft = n !== WATER && (m.ramp[i] || m.ramp[j]) && v - n === 1;
        if (soft) continue;
        const X = x * TILE, Y = y * TILE;
        // Lip along this cell's edge.
        g.fillStyle = n === WATER ? 'rgba(111,216,255,.16)' : (dy < 0 || dx < 0) ? '#3b5559' : '#2b4044';
        if (dx === 1) g.fillRect(X + TILE - 2, Y, 2, TILE);
        if (dx === -1) g.fillRect(X, Y, 2, TILE);
        if (dy === 1) g.fillRect(X, Y + TILE - 2, TILE, 2);
        if (dy === -1) g.fillRect(X, Y, TILE, 2);
        // Shadow falling onto the lower neighbour (light from the top left).
        if (n !== WATER && (dx === 1 || dy === 1)) {
          g.fillStyle = `rgba(0,0,0,${0.22 + 0.12 * (v - n)})`;
          const NX = (x + dx) * TILE, NY = (y + dy) * TILE;
          if (dx === 1) g.fillRect(NX, NY, TILE * 0.28, TILE);
          if (dy === 1) g.fillRect(NX, NY, TILE, TILE * 0.28);
        }
      }
    }
  }

  // A faint survey grid, so build cells are countable.
  g.strokeStyle = 'rgba(255,255,255,.028)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x <= MAP_W; x++) { g.moveTo(x * TILE + 0.5, 0); g.lineTo(x * TILE + 0.5, MAP_H * TILE); }
  for (let y = 0; y <= MAP_H; y++) { g.moveTo(0, y * TILE + 0.5); g.lineTo(MAP_W * TILE, y * TILE + 0.5); }
  g.stroke();

  miniImg = document.createElement('canvas');
  miniImg.width = MAP_W * 3;
  miniImg.height = MAP_H * 3;
  const mg = miniImg.getContext('2d');
  for (let i = 0; i < h.length; i++) {
    mg.fillStyle = h[i] === WATER ? '#0e2a3a' : LAND_MINI[h[i]];
    mg.fillRect(colOf(i) * 3, rowOf(i) * 3, 3, 3);
  }
}

/* ── main pass ────────────────────────────────────────────────────────── */
export function draw() {
  ctx.clearRect(0, 0, W, H);
  if (!F.map) return;
  if (paintedFor !== F.map) paintTerrain();
  clamp();

  ctx.save();
  if (S.shake > 0) ctx.translate((Math.random() - 0.5) * S.shake * 7, (Math.random() - 0.5) * S.shake * 7);

  ctx.fillStyle = '#0a0f13';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(terrainImg, sx(0), sy(0), MAP_W * cam.z, MAP_H * cam.z);

  drawBuildZone();
  drawRoutes();
  drawSelection();
  drawBase(F.hq, '#4cc9f0', 'HQ');
  drawBase(F.enemy, '#ff5f6d', '');
  for (const b of F.bunkers) if (!b.dead) drawBunker(b);
  drawWrecks();

  const z = cam.z;
  for (const t of F.towers) {
    if (!visible(t.x, t.y)) continue;
    drawAura(t);
    drawTurret(ctx, sx(t.x), sy(t.y), z, t, false);
    if (t.hp < t.max) bar(sx(t.x), sy(t.y) + z * 0.5, z * 0.8, t.hp / t.max, t.hit > 0);
  }
  drawBeams();
  drawPreview();

  for (const u of F.units) if (visible(u.x, u.y)) drawUnit(u);
  for (const e of S.foes) {
    if (!visible(e.x, e.y)) continue;
    drawEnemy(ctx, sx(e.x), sy(e.y), z, e);
  }

  drawArcs();
  drawWarps();
  drawShots();
  drawBolts();
  drawBlasts();
  drawMotes();
  drawNotes();
  ctx.restore();

  drawMinimap();
  drawBanners();
}

const visible = (x, y) => {
  const m = 2;
  return sx(x) > -m * cam.z && sx(x) < W + m * cam.z && sy(y) > -m * cam.z && sy(y) < H + m * cam.z;
};

function bar(x, y, w, frac, flash) {
  const h = Math.max(2.5, cam.z * 0.07);
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(x - w / 2, y, w, h);
  ctx.fillStyle = flash ? '#ffffff' : frac > 0.5 ? '#7ddf8f' : frac > 0.22 ? '#f2c14b' : '#ff5f6d';
  ctx.fillRect(x - w / 2, y, w * Math.max(0, frac), h);
}

/** While a tower is picked, tint every cell it could go on. */
function drawBuildZone() {
  if (!S.picked) return;
  const z = cam.z;
  const x0 = Math.max(0, Math.floor(cam.x - W / 2 / z)), x1 = Math.min(MAP_W - 1, Math.ceil(cam.x + W / 2 / z));
  const y0 = Math.max(0, Math.floor(cam.y - H / 2 / z)), y1 = Math.min(MAP_H - 1, Math.ceil(cam.y + H / 2 / z));
  ctx.fillStyle = 'rgba(76,201,240,.09)';
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (canBuild(at(x, y))) ctx.fillRect(sx(x) + 1, sy(y) + 1, z - 2, z - 2);
    }
  }
}

/** The roads the enemy plans to take: bright for the cautious plan, faint
    for the bold one where it differs. */
function drawRoutes() {
  const start = at(F.enemy.cx - 2, F.enemy.cy);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([cam.z * 0.22, cam.z * 0.3]);
  ctx.lineDashOffset = -(performance.now() / 26) % 1000;
  for (const [plan, alpha] of [['bold', 0.14], ['cautious', 0.3]]) {
    const flow = F.flow[plan];
    if (!flow) continue;
    let u = exitCell(flow, start), guard = 0;
    if (u < 0) continue;
    ctx.strokeStyle = `rgba(125,223,143,${alpha})`;
    ctx.lineWidth = Math.max(2, cam.z * 0.1);
    ctx.beginPath();
    ctx.moveTo(sx(colOf(u) + 0.5), sy(rowOf(u) + 0.5));
    while (u !== -1 && guard++ < 3000) {
      ctx.lineTo(sx(colOf(u) + 0.5), sy(rowOf(u) + 0.5));
      u = flow.next[u];
    }
    ctx.lineTo(sx(F.hq.x), sy(F.hq.y));
    ctx.stroke();
  }
  ctx.restore();
}

/** The nearest walkable cell beside the enemy HQ, where waves step out. */
function exitCell(flow, fallback) {
  let best = -1, bd = Infinity;
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      if (Math.abs(x) < 2 && Math.abs(y) < 2) continue;
      const i = at(F.enemy.cx + x, F.enemy.cy + y);
      if (flow.dist[i] < bd) { bd = flow.dist[i]; best = i; }
    }
  }
  return best >= 0 ? best : fallback;
}

function drawBase(b, colour, label) {
  const z = cam.z, s = HQ_HALF * z;
  const x = sx(b.x), y = sy(b.y);
  if (!visible(b.x, b.y)) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = b.hit > 0 ? '#2a3a46' : '#141e27';
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(2, z * 0.08);
  roundRect(-s + 2, -s + 2, s * 2 - 4, s * 2 - 4, z * 0.3);
  ctx.fill();
  ctx.stroke();
  // Inner keep and a slow radar sweep.
  ctx.globalAlpha = 0.5;
  roundRect(-s * 0.5, -s * 0.5, s, s, z * 0.15);
  ctx.stroke();
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.arc(0, 0, s * 0.8, 0, 6.284);
  ctx.stroke();
  const sweep = performance.now() / 900;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(sweep) * s * 0.8, Math.sin(sweep) * s * 0.8);
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (label) {
    ctx.fillStyle = colour;
    ctx.font = `700 ${Math.max(9, Math.round(z * 0.36))}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
  }
  ctx.restore();
  bar(x, y - s - z * 0.25, s * 2, b.hp / b.max, b.hit > 0);
}

function drawBunker(b) {
  if (!visible(b.x, b.y)) return;
  const z = cam.z, x = sx(b.x), y = sy(b.y), r = z * 0.42;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = b.hit > 0 ? '#3a2429' : '#221619';
  ctx.strokeStyle = '#ff5f6d';
  ctx.lineWidth = Math.max(1.5, z * 0.06);
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = k / 6 * 6.284 + Math.PI / 6;
    k ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.rotate(b.ang);
  ctx.fillStyle = '#ff5f6d';
  ctx.fillRect(0, -z * 0.06, z * 0.36, z * 0.12);
  ctx.beginPath(); ctx.arc(0, 0, z * 0.14, 0, 6.284); ctx.fill();
  ctx.restore();
  if (b.hp < b.max) bar(x, y + z * 0.5, z * 0.8, b.hp / b.max, b.hit > 0);
}

function drawWrecks() {
  for (const w of F.wrecks) {
    if (!visible(w.x, w.y)) continue;
    ctx.globalAlpha = Math.min(1, w.t) * 0.6;
    ctx.fillStyle = '#0c1014';
    ctx.strokeStyle = w.col;
    ctx.lineWidth = 1;
    const z = cam.z;
    ctx.beginPath();
    ctx.arc(sx(w.x), sy(w.y), z * 0.3, 0, 6.284);
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawSelection() {
  const t = S.selected;
  if (!t || F.grid[t.i] !== t) return;
  ctx.beginPath();
  ctx.arc(sx(t.x), sy(t.y), rangeOf(t) * cam.z, 0, 6.284);
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
  const k = 1 - t.ring;
  ctx.beginPath();
  ctx.arc(sx(t.x), sy(t.y), rangeOf(t) * cam.z * (0.25 + k * 0.8), 0, 6.284);
  ctx.strokeStyle = TOWERS.frost.color;
  ctx.globalAlpha = t.ring * 0.7;
  ctx.lineWidth = cam.z * 0.1 * t.ring + 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawPreview() {
  if (!S.picked || S.hover < 0) return;
  const i = S.hover;
  const x = colOf(i) + 0.5, y = rowOf(i) + 0.5;
  const ghost = { i, k: S.picked, l: 0, ang: -0.5, kick: 0, elev: Math.max(0, F.map.height[i]) };
  const ok = canBuild(i) && S.gold >= buildCost(S.picked);
  const range = rangeOf(ghost);
  ctx.beginPath();
  ctx.arc(sx(x), sy(y), range * cam.z, 0, 6.284);
  ctx.fillStyle = ok ? 'rgba(255,255,255,.05)' : 'rgba(255,95,109,.07)';
  ctx.fill();
  ctx.strokeStyle = ok ? 'rgba(255,255,255,.28)' : 'rgba(255,95,109,.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = 0.6;
  drawTurret(ctx, sx(x), sy(y), cam.z, ghost, true);
  ctx.globalAlpha = 1;
  if (!ok) {
    const c = cam.z * 0.28, hx = sx(x), hy = sy(y);
    ctx.strokeStyle = '#ff5f6d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hx - c, hy - c); ctx.lineTo(hx + c, hy + c);
    ctx.moveTo(hx + c, hy - c); ctx.lineTo(hx - c, hy + c);
    ctx.stroke();
  } else if (ghost.elev > 0) {
    ctx.fillStyle = '#7ddf8f';
    ctx.font = `600 ${Math.max(10, cam.z * 0.3)}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('high ground', sx(x), sy(y) - cam.z * 0.62);
  }
}

function drawBeams() {
  for (const t of F.towers) {
    if (TOWERS[t.k].kind !== 'beam' || !t.beam || t.beam.dead) continue;
    const w = cam.z * (0.06 + 0.05 * (t.focus / 2.2));
    ctx.strokeStyle = TOWERS[t.k].color;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(sx(t.x), sy(t.y));
    ctx.lineTo(sx(t.beam.x), sy(t.beam.y));
    ctx.stroke();
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = w * 3;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/** Your units: a team-coloured body, shaped by role, with a gun barrel. */
function drawUnit(u) {
  const z = cam.z, x = sx(u.x), y = sy(u.y);
  const col = u.hit > 0 ? '#ffffff' : u.def.col;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(u.ang);
  ctx.fillStyle = col;
  ctx.strokeStyle = '#0c1116';
  ctx.lineWidth = 1;
  const recoil = u.kick * z * 0.05;
  if (u.k === 'breaker') {
    const s = z * 0.3;
    roundRect(-s, -s * 0.8, s * 2, s * 1.6, z * 0.06);
    ctx.fill(); ctx.stroke();
    ctx.fillRect(-recoil, -z * 0.05, z * 0.45, z * 0.1);
    ctx.fillStyle = '#0c1116';
    ctx.beginPath(); ctx.arc(0, 0, z * 0.11, 0, 6.284); ctx.fill();
  } else if (u.k === 'striker') {
    const s = z * 0.24;
    ctx.beginPath();
    ctx.moveTo(s * 1.3, 0); ctx.lineTo(-s, -s * 0.8); ctx.lineTo(-s * 0.5, 0); ctx.lineTo(-s, s * 0.8);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(0, 0, z * 0.17, 0, 6.284); ctx.fill(); ctx.stroke();
    ctx.fillRect(-recoil, -z * 0.035, z * 0.3, z * 0.07);
  }
  ctx.restore();
  if (u.hp < u.max) bar(x, y - z * 0.42, z * 0.5, u.hp / u.max, false);
}

function drawArcs() {
  for (const arc of S.arcs) {
    const alpha = Math.min(1, arc.t / (arc.tracer ? 0.06 : 0.14));
    ctx.strokeStyle = arc.col || TOWERS.tesla.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (arc.tracer) {
      ctx.globalAlpha = alpha * 0.8;
      ctx.lineWidth = Math.max(1, cam.z * 0.035);
      ctx.beginPath();
      ctx.moveTo(sx(arc.points[0].x), sy(arc.points[0].y));
      ctx.lineTo(sx(arc.points[1].x), sy(arc.points[1].y));
      ctx.stroke();
      continue;
    }
    for (const pass of [{ w: cam.z * 0.22, a: 0.2 }, { w: cam.z * 0.06, a: 1 }]) {
      ctx.globalAlpha = alpha * pass.a;
      ctx.lineWidth = pass.w;
      ctx.beginPath();
      for (let n = 0; n < arc.points.length - 1; n++) {
        const a = arc.points[n], b = arc.points[n + 1];
        ctx.moveTo(sx(a.x), sy(a.y));
        const mx = (a.x + b.x) / 2 + (Math.random() - 0.5) * 0.35;
        const my = (a.y + b.y) / 2 + (Math.random() - 0.5) * 0.35;
        ctx.lineTo(sx(mx), sy(my));
        ctx.lineTo(sx(b.x), sy(b.y));
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawWarps() {
  for (const w of S.warps) {
    const k = w.t / 0.5;
    ctx.strokeStyle = w.col;
    if (w.fx !== undefined) {
      ctx.globalAlpha = k * 0.6;
      ctx.lineWidth = cam.z * 0.05;
      ctx.beginPath();
      ctx.moveTo(sx(w.fx), sy(w.fy));
      ctx.lineTo(sx(w.x), sy(w.y));
      ctx.stroke();
    }
    ctx.globalAlpha = k;
    ctx.lineWidth = Math.max(1.5, cam.z * 0.08 * k);
    ctx.beginPath();
    ctx.ellipse(sx(w.x), sy(w.y), cam.z * 0.22 * (1.4 - k * 0.4), cam.z * 0.36 * (1.4 - k * 0.4), 0, 0, 6.284);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawShots() {
  const z = cam.z;
  for (const s of S.shots) {
    if (!visible(s.x, s.y)) continue;
    ctx.save();
    ctx.translate(sx(s.x), sy(s.y));
    ctx.rotate(s.a || 0);
    ctx.fillStyle = s.crit ? '#ffe08a' : s.col;
    if (s.k === 'gun') {
      ctx.fillRect(-z * 0.09, -z * 0.035, z * 0.18, z * 0.07);
    } else {
      ctx.beginPath();
      ctx.moveTo(z * 0.16, 0); ctx.lineTo(-z * 0.1, -z * 0.08); ctx.lineTo(-z * 0.1, z * 0.08);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Hostile fire is always red, so you can tell who is shooting whom. */
function drawBolts() {
  const z = cam.z;
  ctx.fillStyle = '#ff7b86';
  for (const b of F.bolts) {
    if (!visible(b.x, b.y)) continue;
    ctx.beginPath();
    ctx.arc(sx(b.x), sy(b.y), z * (b.big ? 0.09 : 0.05), 0, 6.284);
    ctx.fill();
  }
}

function drawBlasts() {
  for (const b of S.blasts) {
    const k = 1 - b.t / 0.3;
    ctx.beginPath();
    ctx.arc(sx(b.x), sy(b.y), b.r * cam.z * (0.35 + k * 0.8), 0, 6.284);
    ctx.strokeStyle = b.col;
    ctx.globalAlpha = Math.max(0, 1 - k);
    ctx.lineWidth = cam.z * 0.14 * Math.max(0, 1 - k) + 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawMotes() {
  const z = cam.z;
  for (const m of S.motes) {
    ctx.globalAlpha = Math.max(0, m.t / 0.45);
    ctx.fillStyle = m.c;
    ctx.fillRect(sx(m.x) - z * 0.04, sy(m.y) - z * 0.04, z * 0.08, z * 0.08);
  }
  ctx.globalAlpha = 1;
}

function drawNotes() {
  ctx.textAlign = 'center';
  ctx.font = '600 ' + Math.max(10, cam.z * 0.32) + 'px system-ui,sans-serif';
  for (const n of S.notes) {
    ctx.globalAlpha = Math.min(1, n.t * 1.6);
    ctx.fillStyle = n.c;
    ctx.fillText(n.s, sx(n.x), sy(n.y));
  }
  ctx.globalAlpha = 1;
}

function drawMinimap() {
  const b = miniBox();
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = '#0a0f13';
  ctx.fillRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(miniImg, b.x, b.y, b.w, b.h);
  ctx.imageSmoothingEnabled = true;
  const mx = x => b.x + x / MAP_W * b.w, my = y => b.y + y / MAP_H * b.h;
  const dot = (x, y, s, c) => { ctx.fillStyle = c; ctx.fillRect(mx(x) - s / 2, my(y) - s / 2, s, s); };

  dot(F.hq.x, F.hq.y, 7, '#4cc9f0');
  dot(F.enemy.x, F.enemy.y, 7, '#ff5f6d');
  for (const k of F.bunkers) if (!k.dead) dot(k.x, k.y, 3, '#ff5f6d');
  for (const t of F.towers) dot(t.x, t.y, 2.5, TOWERS[t.k].color);
  for (const u of F.units) dot(u.x, u.y, 2.5, '#a8ecbb');
  for (const e of S.foes) dot(e.x, e.y, 2.5, '#ff9aa3');

  // The part of the map on screen.
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(215,227,236,.8)';
  ctx.lineWidth = 1;
  const hw = W / 2 / cam.z, hh = H / 2 / cam.z;
  const x0 = Math.max(0, cam.x - hw), x1 = Math.min(MAP_W, cam.x + hw);
  const y0 = Math.max(0, cam.y - hh), y1 = Math.min(MAP_H, cam.y + hh);
  ctx.strokeRect(mx(x0) + 0.5, my(y0) + 0.5, mx(x1) - mx(x0) - 1, my(y1) - my(y0) - 1);
  ctx.strokeStyle = '#1e2a35';
  ctx.strokeRect(b.x - 2.5, b.y - 2.5, b.w + 5, b.h + 5);
  ctx.restore();
}

function drawBanners() {
  ctx.textAlign = 'center';
  const base = Math.max(22, Math.min(40, W / 26));
  if (S.waveFlash > 0) {
    ctx.globalAlpha = Math.min(1, S.waveFlash);
    ctx.fillStyle = '#d7e3ec';
    ctx.font = '600 ' + Math.round(base) + 'px system-ui,sans-serif';
    ctx.fillText('Wave ' + S.wave, W / 2, base * 1.6);
    ctx.globalAlpha = 1;
  }
  if (S.warn > 0) {
    ctx.globalAlpha = Math.min(1, S.warn * 2);
    ctx.fillStyle = '#ff5f6d';
    ctx.font = '600 ' + Math.round(base * 0.45) + 'px system-ui,sans-serif';
    ctx.fillText(S.warnText, W / 2, H - 16);
    ctx.globalAlpha = 1;
  }
  if (S.paused && S.phase !== 'dead' && S.phase !== 'menu') {
    ctx.fillStyle = 'rgba(12,17,22,.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#d7e3ec';
    ctx.font = '600 ' + Math.round(base * 0.8) + 'px system-ui,sans-serif';
    ctx.fillText('Paused', W / 2, H / 2);
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
