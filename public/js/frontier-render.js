/* ══ Frontier renderer ═══════════════════════════════════════════════════
   Draws the Frontier map through a camera you can drag and zoom, or let
   follow your Commander. Terrain is painted once per map into an offscreen
   canvas and blitted each frame; everything that moves is drawn on top in
   world coordinates (cells) and projected here. Turrets are Holdout's own
   drawings, so the two modes read as one game. Your side is blue, the
   enemy's red. Reads state; never writes it.                            */

import { TOWERS, MAP_W, MAP_H, WATER, UNITS, COMMANDER } from './config.js';
import { S } from './game.js';
import { F, canBuild, rangeOf, buildCost, ringOf, whyNot, commanderOf } from './frontier.js';
import * as meta from './meta.js';
import { drawTurret } from './render.js';
import { at, colOf, rowOf } from './terrain.js';

let cv, ctx, stage;
let W = 0, H = 0;

/** Camera: the world point at the centre of the view, and pixels per cell. */
export const cam = { x: MAP_W / 2, y: MAP_H / 2, z: 32 };

const sx = x => (x - cam.x) * cam.z + W / 2;
const sy = y => (y - cam.y) * cam.z + H / 2;

const BLUE = '#4cc9f0', RED = '#ff5f6d';
const sideCol = side => (side ? RED : BLUE);

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

/** Frame your Commander at a comfortable zoom - called when a sortie opens. */
export function home() {
  const c = commanderOf(0);
  cam.z = Math.max(24, Math.min(40, W / 22));
  if (c) { cam.x = c.x + W / cam.z * 0.15; cam.y = c.y; }
  clamp();
}

export function focus(x, y) {
  cam.x = x; cam.y = y;
  clamp();
}

/** Ease the camera after your Commander while follow is on. It only moves
    once the Commander walks out of the middle of the view, so building
    beside it does not swim the whole map about. */
export function follow(dt) {
  const c = commanderOf(0);
  if (!F.follow || !c || c.dead || !W) return;
  const hw = W / 2 / cam.z, hh = H / 2 / cam.z;
  const box = 0.35;
  const dx = c.x - cam.x, dy = c.y - cam.y;
  const ox = Math.abs(dx) - hw * box, oy = Math.abs(dy) - hh * box;
  const k = Math.min(1, dt * 5);
  if (ox > 0) cam.x += Math.sign(dx) * ox * k;
  if (oy > 0) cam.y += Math.sign(dy) * oy * k;
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

/** Pointer -> world point, in cells. */
export function worldAt(ev) {
  const p = local(ev);
  return { x: (p.x - W / 2) / cam.z + cam.x, y: (p.y - H / 2) / cam.z + cam.y };
}

/** Pointer -> map cell index, or -1 off the map. */
export function cellAt(ev) {
  const w = worldAt(ev);
  const x = Math.floor(w.x), y = Math.floor(w.y);
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return -1;
  return at(x, y);
}

/* ── minimap ──────────────────────────────────────────────────────────────
   Top right: the bottom left belongs to the thumb stick.                 */
function miniBox() {
  const w = Math.round(Math.min(170, Math.max(104, W * 0.2)));
  const h = Math.round(w * MAP_H / MAP_W);
  return { x: W - w - 8, y: 8, w, h };
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
  drawReach();
  drawSelection();
  drawWrecks();

  for (const s of F.structs) if (s.type === 'fab') drawFactory(s);
  for (const s of F.structs) if (s.type === 'helper') drawHelper(s);
  for (const s of F.structs) if (s.type === 'tower') drawTower(s);
  drawBeams();
  drawPreview();

  for (const u of F.units) if (!u.def.fly && visible(u.x, u.y)) drawUnit(u);
  for (const c of F.cmd) if (c && !c.dead) drawCommander(c);
  for (const u of F.units) if (u.def.fly && visible(u.x, u.y)) drawUnit(u);

  drawArcs();
  drawWarps();
  drawShots();
  drawBlasts();
  drawMotes();
  drawNotes();
  ctx.restore();

  drawMinimap();
  drawBanners();
}

const visible = (x, y) => {
  const m = 2.5;
  return sx(x) > -m * cam.z && sx(x) < W + m * cam.z && sy(y) > -m * cam.z && sy(y) < H + m * cam.z;
};

function bar(x, y, w, frac, flash, col) {
  const h = Math.max(2.5, cam.z * 0.07);
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(x - w / 2, y, w, h);
  ctx.fillStyle = flash ? '#ffffff' : col || (frac > 0.5 ? '#7ddf8f' : frac > 0.22 ? '#f2c14b' : '#ff5f6d');
  ctx.fillRect(x - w / 2, y, w * Math.max(0, Math.min(1, frac)), h);
}

/** While a building is picked, tint every cell it could go on. */
function drawBuildZone() {
  if (!S.picked) return;
  const z = cam.z;
  const x0 = Math.max(0, Math.floor(cam.x - W / 2 / z)), x1 = Math.min(MAP_W - 1, Math.ceil(cam.x + W / 2 / z));
  const y0 = Math.max(0, Math.floor(cam.y - H / 2 / z)), y1 = Math.min(MAP_H - 1, Math.ceil(cam.y + H / 2 / z));
  ctx.fillStyle = S.picked === 'helper' ? 'rgba(159,208,176,.22)' : 'rgba(76,201,240,.08)';
  if (S.picked === 'helper') {
    // Only the rings around your Factories take Helpers.
    for (const f of F.structs) {
      if (f.side || f.type !== 'fab') continue;
      for (const i of ringOf(f)) if (canBuild(i)) ctx.fillRect(sx(colOf(i)) + 2, sy(rowOf(i)) + 2, z - 4, z - 4);
    }
    return;
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = at(x, y);
      if (F.map.height[i] >= 0 && !F.grid[i]) ctx.fillRect(sx(x) + 1, sy(y) + 1, z - 2, z - 2);
    }
  }
}

/** The Commander's build reach, and a line to the next order waiting. */
function drawReach() {
  const c = commanderOf(0);
  if (!c || c.dead) return;
  const pending = F.structs.filter(s => s.side === 0 && !s.done);
  if (!S.picked && !pending.length && S.selected !== c) return;
  const r = meta.mods.buildReach;
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx(c.x), sy(c.y), r * cam.z, 0, 6.284);
  ctx.fillStyle = 'rgba(76,201,240,.05)';
  ctx.fill();
  ctx.setLineDash([cam.z * 0.2, cam.z * 0.2]);
  ctx.strokeStyle = 'rgba(76,201,240,.45)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // A dotted trail to every order in the queue, in order.
  if (pending.length) {
    ctx.setLineDash([cam.z * 0.1, cam.z * 0.18]);
    ctx.lineDashOffset = -(performance.now() / 30) % 1000;
    ctx.strokeStyle = 'rgba(125,223,143,.55)';
    ctx.lineWidth = Math.max(1.5, cam.z * 0.05);
    ctx.beginPath();
    ctx.moveTo(sx(c.x), sy(c.y));
    for (const s of pending) ctx.lineTo(sx(s.x), sy(s.y));
    ctx.stroke();
  }
  ctx.restore();
}

/** Where each side's columns are heading: blue for yours, red for theirs,
    traced from each finished Factory's door. */
function drawRoutes() {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([cam.z * 0.22, cam.z * 0.3]);
  ctx.lineDashOffset = -(performance.now() / 26) % 1000;
  ctx.lineWidth = Math.max(2, cam.z * 0.09);
  for (const f of F.structs) {
    if (f.type !== 'fab' || !f.done) continue;
    const flow = F.flow[f.side] && F.flow[f.side].bold;
    if (!flow || !flow.next) continue;
    let u = -1, bd = Infinity;
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== 2) continue;
      const cx = f.cx + x, cy = f.cy + y;
      if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) continue;
      const i = at(cx, cy);
      if (flow.dist[i] < bd) { bd = flow.dist[i]; u = i; }
    }
    if (u < 0) continue;
    ctx.strokeStyle = f.side ? 'rgba(255,95,109,.22)' : 'rgba(76,201,240,.24)';
    ctx.beginPath();
    ctx.moveTo(sx(colOf(u) + 0.5), sy(rowOf(u) + 0.5));
    for (let guard = 0; u !== -1 && guard < 3000; guard++) {
      ctx.lineTo(sx(colOf(u) + 0.5), sy(rowOf(u) + 0.5));
      u = flow.next[u];
    }
    ctx.stroke();
  }
  ctx.restore();
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
    ctx.arc(sx(w.x), sy(w.y), z * (w.big ? 1.1 : 0.3), 0, 6.284);
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawSelection() {
  const t = S.selected;
  if (!t || t.dead) return;
  ctx.save();
  if (t.kind === 'struct' && t.type === 'tower') {
    ctx.beginPath();
    ctx.arc(sx(t.x), sy(t.y), rangeOf(t) * cam.z, 0, 6.284);
    ctx.fillStyle = 'rgba(255,255,255,.045)';
    ctx.fill();
    ctx.strokeStyle = t.side ? RED : TOWERS[t.k].color;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  } else {
    const r = (t.kind === 'struct' ? t.half + 0.25 : 0.7) * cam.z;
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([cam.z * 0.18, cam.z * 0.12]);
    if (t.kind === 'struct') ctx.strokeRect(sx(t.x) - r, sy(t.y) - r, r * 2, r * 2);
    else { ctx.beginPath(); ctx.arc(sx(t.x), sy(t.y), r, 0, 6.284); ctx.stroke(); }
  }
  ctx.restore();
}

/** Scaffolding for anything still going up: a hatched outline that fills. */
function drawSite(s) {
  const z = cam.z, r = s.half * z;
  const x = sx(s.x), y = sy(s.y);
  ctx.save();
  ctx.strokeStyle = sideCol(s.side);
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([z * 0.12, z * 0.1]);
  ctx.strokeRect(x - r + 2, y - r + 2, r * 2 - 4, r * 2 - 4);
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = sideCol(s.side);
  const hFill = (r * 2 - 4) * s.prog;
  ctx.fillRect(x - r + 2, y + r - 2 - hFill, r * 2 - 4, hFill);
  ctx.restore();
  bar(x, y + r + 1, r * 1.8, s.prog, false, '#7ddf8f');
}

function drawFactory(f) {
  if (!visible(f.x, f.y)) return;
  if (!f.done) { drawSite(f); return; }
  const z = cam.z, s = 1.5 * z;
  const x = sx(f.x), y = sy(f.y);
  const col = sideCol(f.side);
  ctx.save();
  ctx.translate(x, y);
  // Body: a heavy plate with a lit edge.
  ctx.fillStyle = f.hit > 0 ? '#2d3b47' : f.side ? '#231a1e' : '#17222c';
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(2, z * 0.07);
  roundRect(-s + 3, -s + 3, s * 2 - 6, s * 2 - 6, z * 0.22);
  ctx.fill();
  ctx.stroke();
  // Roof panels.
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  for (let k = -1; k <= 1; k += 2) {
    ctx.beginPath();
    ctx.moveTo(-s + z * 0.35, k * z * 0.5); ctx.lineTo(s - z * 0.35, k * z * 0.5);
    ctx.stroke();
  }
  // The assembly bay: a conveyor that runs while something is being made.
  const busy = !!(f.job || f.up);
  ctx.fillStyle = '#0c1116';
  ctx.fillRect(-z * 0.9, -z * 0.28, z * 1.8, z * 0.56);
  ctx.strokeStyle = busy ? col : 'rgba(255,255,255,.15)';
  ctx.lineWidth = Math.max(1, z * 0.04);
  const shift = (performance.now() / (busy ? 90 : 900)) % 1;
  for (let k = -3; k <= 3; k++) {
    const bx = (k + shift) * z * 0.26;
    if (Math.abs(bx) > z * 0.88) continue;
    ctx.beginPath(); ctx.moveTo(bx, -z * 0.24); ctx.lineTo(bx, z * 0.24); ctx.stroke();
  }
  // The unit taking shape on the belt.
  if (f.job) {
    const k = f.job.t / f.job.need;
    ctx.globalAlpha = 0.35 + 0.65 * k;
    ctx.fillStyle = f.side ? UNITS[f.job.k].ecol : UNITS[f.job.k].col;
    ctx.beginPath(); ctx.arc(0, 0, z * 0.12 + z * 0.1 * k, 0, 6.284); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Two stacks with fans that spin with the work.
  for (const [ox, oy] of [[-0.95, -0.95], [0.95, -0.95]]) {
    ctx.save();
    ctx.translate(ox * z, oy * z);
    ctx.fillStyle = '#0f161d';
    ctx.beginPath(); ctx.arc(0, 0, z * 0.28, 0, 6.284); ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.rotate(f.spin * (ox > 0 ? 1 : -1));
    ctx.strokeStyle = busy ? col : 'rgba(255,255,255,.3)';
    ctx.lineWidth = Math.max(1.2, z * 0.05);
    ctx.beginPath();
    for (let b = 0; b < 3; b++) {
      const a = b / 3 * 6.284;
      ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * z * 0.22, Math.sin(a) * z * 0.22);
    }
    ctx.stroke();
    ctx.restore();
  }
  // Tier pips along the bottom edge.
  ctx.fillStyle = col;
  const pips = Math.min(f.tier, 8);
  for (let k = 0; k < pips; k++) {
    ctx.fillRect(-s + z * 0.35 + k * z * 0.22, s - z * 0.42, z * 0.14, z * 0.14);
  }
  if (f.tier > 8) {
    ctx.font = `700 ${Math.max(8, z * 0.22)}px system-ui,sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText('T' + f.tier, -s + z * 0.35 + 8 * z * 0.22, s - z * 0.26);
  }
  if (f.stall && !f.side) {
    ctx.fillStyle = '#ffd76b';
    ctx.font = `700 ${Math.max(9, z * 0.26)}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('needs gold', 0, s - z * 0.62);
  }
  ctx.restore();
  // Production (or upgrade) progress under the Factory.
  const job = f.up || f.job;
  if (job) bar(x, y + s + 1, s * 1.8, job.t / job.need, false, f.up ? '#c9a7ff' : col);
  if (f.hp < f.max) bar(x, y - s - z * 0.2, s * 1.8, f.hp / f.max, f.hit > 0);
}

function drawHelper(h) {
  if (!visible(h.x, h.y)) return;
  if (!h.done) { drawSite(h); return; }
  const z = cam.z, x = sx(h.x), y = sy(h.y), r = z * 0.36;
  const col = sideCol(h.side);
  const busy = h.fab && !h.fab.dead && (h.fab.job || h.fab.up);
  // A conduit back to the Factory it feeds.
  if (h.fab && !h.fab.dead) {
    ctx.strokeStyle = busy ? col : 'rgba(255,255,255,.12)';
    ctx.globalAlpha = busy ? 0.55 : 1;
    ctx.lineWidth = Math.max(1, z * 0.06);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.sign(h.fab.x - h.x) * z * 0.55, y + Math.sign(h.fab.y - h.y) * z * 0.55);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = h.hit > 0 ? '#2d3b47' : '#141d25';
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.2;
  roundRect(-r, -r, r * 2, r * 2, z * 0.1);
  ctx.fill();
  ctx.stroke();
  ctx.rotate((performance.now() / (busy ? 250 : 2500)) % 6.284);
  ctx.strokeStyle = busy ? '#9fd0b0' : 'rgba(159,208,176,.4)';
  ctx.lineWidth = Math.max(1.2, z * 0.05);
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const a = k / 4 * 6.284;
    ctx.moveTo(Math.cos(a) * z * 0.08, Math.sin(a) * z * 0.08);
    ctx.lineTo(Math.cos(a) * z * 0.22, Math.sin(a) * z * 0.22);
  }
  ctx.stroke();
  ctx.restore();
  if (h.hp < h.max) bar(x, y + r + 1, z * 0.7, h.hp / h.max, h.hit > 0);
}

function drawTower(t) {
  if (!visible(t.x, t.y)) return;
  if (!t.done) {
    drawSite(t);
    ctx.globalAlpha = 0.25 + 0.5 * t.prog;
    drawTurret(ctx, sx(t.x), sy(t.y), cam.z, t, true);
    ctx.globalAlpha = 1;
    return;
  }
  const z = cam.z;
  drawAura(t);
  if (t.side) {
    // Enemy towers stand on a red plinth so they never read as yours.
    ctx.fillStyle = 'rgba(255,95,109,.35)';
    ctx.fillRect(sx(t.x) - z * 0.48, sy(t.y) - z * 0.48, z * 0.96, z * 0.96);
  }
  drawTurret(ctx, sx(t.x), sy(t.y), z, t, false);
  if (t.hp < t.max) bar(sx(t.x), sy(t.y) + z * 0.5, z * 0.8, t.hp / t.max, t.hit > 0);
}

function drawAura(t) {
  if (TOWERS[t.k].kind !== 'aura' || !t.ring) return;
  const k = 1 - t.ring;
  ctx.beginPath();
  ctx.arc(sx(t.x), sy(t.y), rangeOf(t) * cam.z * (0.25 + k * 0.8), 0, 6.284);
  ctx.strokeStyle = t.side ? RED : TOWERS.frost.color;
  ctx.globalAlpha = t.ring * 0.7;
  ctx.lineWidth = cam.z * 0.1 * t.ring + 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawPreview() {
  if (!S.picked || S.hover < 0) return;
  const i = S.hover;
  const key = S.picked;
  const x = colOf(i) + 0.5, y = rowOf(i) + 0.5;
  const why = whyNot(i);
  const ok = !why && S.gold >= buildCost(key);
  const z = cam.z;
  if (key === 'fab' || key === 'helper') {
    const r = (key === 'fab' ? 1.5 : 0.5) * z;
    ctx.fillStyle = ok ? 'rgba(76,201,240,.18)' : 'rgba(255,95,109,.18)';
    ctx.strokeStyle = ok ? 'rgba(76,201,240,.8)' : 'rgba(255,95,109,.8)';
    ctx.lineWidth = 1.5;
    ctx.fillRect(sx(x) - r, sy(y) - r, r * 2, r * 2);
    ctx.strokeRect(sx(x) - r, sy(y) - r, r * 2, r * 2);
    if (key === 'fab' && ok) {
      // Show where its twelve Helpers would go.
      ctx.fillStyle = 'rgba(159,208,176,.14)';
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2 || (Math.abs(dx) === 2 && Math.abs(dy) === 2)) continue;
        ctx.fillRect(sx(x + dx - 0.5) + 2, sy(y + dy - 0.5) + 2, z - 4, z - 4);
      }
    }
  } else {
    const ghost = { i, k: key, l: 0, side: 0, ang: -0.5, kick: 0, elev: Math.max(0, F.map.height[i]) };
    const range = rangeOf(ghost);
    ctx.beginPath();
    ctx.arc(sx(x), sy(y), range * z, 0, 6.284);
    ctx.fillStyle = ok ? 'rgba(255,255,255,.05)' : 'rgba(255,95,109,.07)';
    ctx.fill();
    ctx.strokeStyle = ok ? 'rgba(255,255,255,.28)' : 'rgba(255,95,109,.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 0.6;
    drawTurret(ctx, sx(x), sy(y), z, ghost, true);
    ctx.globalAlpha = 1;
    if (ok && ghost.elev > 0) {
      ctx.fillStyle = '#7ddf8f';
      ctx.font = `600 ${Math.max(10, z * 0.3)}px system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('high ground', sx(x), sy(y) - z * 0.62);
    }
  }
  if (!ok) {
    ctx.fillStyle = '#ff5f6d';
    ctx.font = `600 ${Math.max(10, z * 0.28)}px system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(why || 'Not enough gold', sx(x), sy(y) - z * (key === 'fab' ? 1.8 : 0.7));
  }
}

function drawBeams() {
  for (const t of F.structs) {
    if (t.type !== 'tower' || !t.done || TOWERS[t.k].kind !== 'beam' || !t.beam || t.beam.dead) continue;
    const w = cam.z * (0.06 + 0.05 * (t.focus / 2.2));
    ctx.strokeStyle = t.side ? RED : TOWERS[t.k].color;
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

/** The Commander: a big walker in its side's colour, with a build beam. */
function drawCommander(c) {
  const z = cam.z, x = sx(c.x), y = sy(c.y);
  const col = sideCol(c.side);
  // The nanolathe: a shimmering beam to whatever it is building.
  if (c.beam && !c.beam.dead) {
    const t = performance.now() / 80;
    ctx.save();
    ctx.strokeStyle = c.beam.done ? '#7ddf8f' : col;
    ctx.globalAlpha = 0.5 + 0.3 * Math.sin(t);
    ctx.lineWidth = Math.max(1.5, z * 0.07);
    ctx.setLineDash([z * 0.08, z * 0.08]);
    ctx.lineDashOffset = -t * 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(sx(c.beam.x), sy(c.beam.y));
    ctx.stroke();
    ctx.restore();
    // Sparks where the beam lands, picked from the clock so drawing never
    // touches the simulation.
    const b = c.beam, tick = Math.floor(t / 1.5);
    ctx.fillStyle = col;
    for (let k = 0; k < 3; k++) {
      const h1 = hash(tick * 7 + k), h2 = hash(tick * 13 + k * 3 + 1);
      const px = sx(b.x + (h1 - 0.5) * b.half * 1.6), py = sy(b.y + (h2 - 0.5) * b.half * 1.6);
      ctx.fillRect(px - z * 0.04, py - z * 0.04, z * 0.08, z * 0.08);
    }
  }
  if (!visible(c.x, c.y)) return;
  const r = COMMANDER.rad * z;
  ctx.save();
  ctx.translate(x, y);
  // A glow ring so it is easy to find in a crowd.
  ctx.strokeStyle = col;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = Math.max(2, z * 0.08);
  ctx.beginPath(); ctx.arc(0, 0, r * 1.35, 0, 6.284); ctx.stroke();
  ctx.globalAlpha = 1;
  // Legs, swinging while it walks.
  ctx.rotate(c.ang);
  const swing = c.walk ? Math.sin(performance.now() / 90) * 0.35 : 0;
  ctx.fillStyle = '#0f161d';
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.2;
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.translate(0, s * r * 0.62);
    ctx.fillRect(-r * 0.7 + s * swing * r, -r * 0.2, r * 1.4, r * 0.4);
    ctx.strokeRect(-r * 0.7 + s * swing * r, -r * 0.2, r * 1.4, r * 0.4);
    ctx.restore();
  }
  ctx.rotate(-c.ang);
  // Torso, turned towards what it is shooting.
  ctx.rotate(c.tgt ? c.aim : c.ang);
  ctx.fillStyle = c.hit > 0 ? '#ffffff' : c.side ? '#3a1f26' : '#16303d';
  ctx.beginPath();
  ctx.moveTo(r * 0.9, 0);
  ctx.lineTo(r * 0.3, -r * 0.8);
  ctx.lineTo(-r * 0.7, -r * 0.65);
  ctx.lineTo(-r * 0.7, r * 0.65);
  ctx.lineTo(r * 0.3, r * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, z * 0.05);
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.fillRect(r * 0.2 - c.kick * r * 0.2, -r * 0.14, r * 0.95, r * 0.28);
  ctx.beginPath(); ctx.arc(-r * 0.1, 0, r * 0.26, 0, 6.284); ctx.fill();
  ctx.restore();
  bar(x, y - r * 1.75, z * 1.1, c.hp / c.max, c.hit > 0);
}

/** Units: shaped by role, coloured by side, with a thin team outline. */
function drawUnit(u) {
  const z = cam.z, x = sx(u.x), y = sy(u.y);
  const col = u.hit > 0 ? '#ffffff' : u.side ? u.def.ecol : u.def.col;
  const edge = sideCol(u.side);
  if (u.def.fly) {
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath();
    ctx.ellipse(x + z * 0.18, y + z * 0.26, z * 0.2, z * 0.09, 0, 0, 6.284);
    ctx.fill();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(u.ang);
  ctx.fillStyle = col;
  ctx.strokeStyle = edge;
  ctx.lineWidth = Math.max(1, z * 0.035);
  const grow = 1 + Math.min(0.5, 0.08 * (u.tier - 1));
  const recoil = u.kick * z * 0.05;
  if (u.k === 'breaker') {
    const s = z * 0.3 * grow;
    roundRect(-s, -s * 0.8, s * 2, s * 1.6, z * 0.06);
    ctx.fill(); ctx.stroke();
    ctx.fillRect(-recoil, -z * 0.05, z * 0.45 * grow, z * 0.1);
    ctx.fillStyle = '#0c1116';
    ctx.beginPath(); ctx.arc(0, 0, z * 0.11, 0, 6.284); ctx.fill();
  } else if (u.k === 'striker') {
    const s = z * 0.24 * grow;
    ctx.beginPath();
    ctx.moveTo(s * 1.3, 0); ctx.lineTo(-s, -s * 0.8); ctx.lineTo(-s * 0.5, 0); ctx.lineTo(-s, s * 0.8);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else if (u.k === 'gunship') {
    const s = z * 0.26 * grow;
    ctx.beginPath();
    ctx.moveTo(s * 1.2, 0); ctx.lineTo(-s * 0.4, -s); ctx.lineTo(-s * 0.9, -s * 0.2);
    ctx.lineTo(-s * 0.9, s * 0.2); ctx.lineTo(-s * 0.4, s);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.beginPath(); ctx.arc(-s * 0.1, 0, s * 0.9, performance.now() / 60, performance.now() / 60 + 1.2); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(0, 0, z * 0.17 * grow, 0, 6.284); ctx.fill(); ctx.stroke();
    ctx.fillRect(-recoil, -z * 0.035, z * 0.3, z * 0.07);
  }
  ctx.restore();
  if (u.hp < u.max) bar(x, y - z * 0.42, z * 0.5, u.hp / u.max, false, u.side ? '#ff8f8f' : '#7ddf8f');
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
  for (const s of F.shots) {
    if (!visible(s.x, s.y)) continue;
    ctx.save();
    ctx.translate(sx(s.x), sy(s.y));
    ctx.rotate(s.a || 0);
    ctx.fillStyle = s.crit ? '#ffe08a' : s.col;
    if (s.k === 'gun') {
      ctx.fillRect(-z * 0.09, -z * 0.035, z * 0.18, z * 0.07);
    } else if (s.k === 'rocket') {
      ctx.beginPath();
      ctx.moveTo(z * 0.16, 0); ctx.lineTo(-z * 0.1, -z * 0.08); ctx.lineTo(-z * 0.1, z * 0.08);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, z * (s.big ? 0.09 : 0.05), 0, 6.284);
      ctx.fill();
    }
    ctx.restore();
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

  for (const s of F.structs) dot(s.x, s.y, s.type === 'fab' ? 6 : 3, s.side ? '#ff5f6d' : s.done ? '#4cc9f0' : 'rgba(76,201,240,.5)');
  for (const u of F.units) dot(u.x, u.y, 2, u.side ? '#ff9aa3' : '#a8ecbb');
  for (const c of F.cmd) {
    if (!c || c.dead) continue;
    dot(c.x, c.y, 7, '#0a0f13');
    dot(c.x, c.y, 5, c.side ? '#ff5f6d' : '#ffffff');
  }

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
