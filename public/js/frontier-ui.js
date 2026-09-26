/* ══ Frontier interface ══════════════════════════════════════════════════
   The Frontier parts of the side console: the base buttons (Factory,
   Helper), the panels for whatever you tap on the map - a Factory and its
   build sequence, a Helper, a construction site, your Commander, or any
   enemy building - the war report, and the thumb stick that walks your
   Commander. ui.js owns the console and calls in here in Frontier mode.

   Like the rest of the console, a panel's markup is only rebuilt when
   what it shows changes, and progress bars are updated in place, so a
   finger mid-press never has its button swapped out from under it.     */

import { TOWERS, TOWER_ORDER, UNITS, UNIT_ORDER, FAB, HELPER, HELPER_BOOST, SEQ_MAX, UNIT_CAP, GROUPS } from './config.js';
import { S } from './game.js';
import * as frontier from './frontier.js';
import { F } from './frontier.js';
import * as meta from './meta.js';

const el = id => document.getElementById(id);

/** 1234 -> "1,234", 1234567 -> "1.23M". */
export function big(n) {
  n = Math.round(n);
  if (n < 1e5) return n.toLocaleString();
  for (const [size, tag] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
    if (n >= size) return (n / size).toPrecision(3) + tag;
  }
  return String(n);
}

export const clock = secs => {
  const s = Math.floor(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const GLYPHS = {
  fab: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21V10l5 3V10l5 3V6h4l1-3h2v18z"/><path d="M7 17h2M12 17h2"/></svg>',
  helper: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M12 8v8M8 12h8"/></svg>',
  trooper: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="12" r="4"/><path d="M13 12h8"/></svg>',
  striker: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12L5 5l4 7-4 7z"/></svg>',
  breaker: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="12" height="10" rx="2"/><path d="M15 12h7"/></svg>',
  gunship: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12L9 4 6 10v4l3 6z"/><path d="M3 12h3"/></svg>'
};

/* ── the base buttons ─────────────────────────────────────────────────── */
const BASE = [
  { key: 'fab', name: FAB.name, color: FAB.color, blurb: '3x3 · turns gold into units' },
  { key: 'helper', name: HELPER.name, color: HELPER.color, blurb: `beside a Factory · +${Math.round(HELPER_BOOST * 100)}% its build speed` }
];

export function buildBase() {
  const shop = el('baseShop');
  shop.textContent = '';
  for (const b of BASE) {
    const btn = document.createElement('button');
    btn.className = 'tw';
    btn.dataset.k = b.key;
    btn.style.setProperty('--c', b.color);
    btn.title = `${b.name} · ${b.blurb}`;
    btn.innerHTML = `<span class="ic" style="color:${b.color}">${GLYPHS[b.key]}</span>` +
      `<span class="nm">${b.name}</span><span class="pr"></span>`;
    btn.addEventListener('click', () => {
      S.picked = S.picked === b.key ? null : b.key;
      S.selected = null;
      S.onChange();
    });
    shop.appendChild(btn);
  }
}

let armySig = '';
export function syncArmy() {
  if (S.mode !== 'frontier' || !F.map) { armySig = ''; return; }
  for (const btn of el('baseShop').children) {
    const cost = frontier.buildCost(btn.dataset.k);
    btn.classList.toggle('on', S.picked === btn.dataset.k);
    btn.classList.toggle('poor', S.gold < cost);
    btn.querySelector('.pr').textContent = cost;
  }

  const mineFabs = F.structs.filter(s => !s.side && s.type === 'fab' && s.done).length;
  const theirs = F.structs.filter(s => s.side === 1);
  const enemyFabs = theirs.filter(s => s.type === 'fab').length;
  const enemyTowers = theirs.filter(s => s.type === 'tower').length;
  const boss = F.cmd[1];
  const bossPct = boss && !boss.dead ? Math.max(1, Math.round(100 * boss.hp / boss.max)) : 0;
  const sig = [frontier.armySize(0), frontier.armySize(1), Math.round(frontier.income(0) * 10), mineFabs,
    theirs.length, enemyFabs, enemyTowers, bossPct, frontier.sitesOf(0).length].join('|');
  if (sig === armySig) return;
  armySig = sig;

  el('armyCount').textContent = `${frontier.armySize(0)}/${UNIT_CAP} units`;
  const waiting = frontier.sitesOf(0).length;
  el('armyLine').textContent = `+${frontier.income(0).toFixed(1)} gold/s · ${mineFabs} ${mineFabs === 1 ? 'factory' : 'factories'}` +
    (waiting ? ` · ${waiting} to build` : '');
  el('armyEnemy').innerHTML =
    `<span>Enemy Cmdr</span><span class="hqbar foe"><i style="width:${bossPct}%"></i></span><b>${bossPct ? bossPct + '%' : 'down'}</b>` +
    `<span class="bk">${enemyFabs} fact. · ${enemyTowers} towers · ${frontier.armySize(1)} units</span>`;
}

/* ── panels for what you tap ──────────────────────────────────────────── */
let selSig = '';

/**
 * Draw the selection panel for anything that is not one of your finished
 * towers (ui.js handles those, as in Holdout). True when it drew one.
 */
export function syncSelection(box) {
  const o = S.selected;
  if (!o || o.dead) { selSig = ''; return false; }
  if (frontier.alive(o)) { selSig = ''; return false; }

  let html;
  if (o.kind === 'cmd') html = commanderPanel(o);
  else if (o.side) html = enemyPanel(o);
  else if (!o.done) html = sitePanel(o);
  else if (o.type === 'fab') html = factoryPanel(o);
  else if (o.type === 'helper') html = helperPanel(o);
  else return false;

  box.classList.remove('hidden');
  if (html.sig !== selSig) {
    selSig = html.sig;
    box.innerHTML = html.body;
  }
  // Moving parts, updated in place.
  for (const bar of box.querySelectorAll('[data-live]')) {
    const v = live(o, bar.dataset.live);
    if (bar.tagName === 'I') bar.style.width = (v * 100).toFixed(1) + '%';
    else bar.textContent = v;
  }
  return true;
}

function live(o, what) {
  switch (what) {
    case 'hp': return Math.max(0, o.hp / o.max);
    case 'hpText': return `${big(o.hp)} / ${big(o.max)}`;
    case 'prog': return o.prog;
    case 'job': { const j = o.up || o.job; return j ? j.t / j.need : 0; }
    default: return '';
  }
}

const hpRow = o => `<div class="st"><span>health</span><b data-live="hpText"></b></div>
  <div class="bar hp"><i data-live="hp"></i></div>`;

function commanderPanel(c) {
  const sites = frontier.sitesOf(0);
  const sig = `cmd|${sites.length}|${meta.revision.n}`;
  return {
    sig,
    body: `<div class="hd" style="color:#4cc9f0">Commander</div>
      ${hpRow(c)}
      <div class="st"><span>build reach</span><b>${meta.mods.buildReach} cells</b></div>
      <div class="st"><span>build speed</span><b>×${meta.mods.buildPower.toFixed(2)}</b></div>
      <div class="st"><span>orders waiting</span><b>${sites.length}</b></div>
      <div class="st note">Steer with the stick (or WASD). Orders within the dashed circle get built, oldest first; with nothing to build it repairs.</div>
      <button class="btn warn tiny" data-act="cancelAll" ${sites.length ? '' : 'disabled'}>Cancel all orders</button>`
  };
}

function sitePanel(s) {
  const c = F.cmd[0];
  const near = c && !c.dead && Math.hypot(c.x - s.x, c.y - s.y) - s.half <= meta.mods.buildReach;
  const sig = `site|${s.id}|${near}`;
  return {
    sig,
    body: `<div class="hd">${frontier.nameOf(s)} · under construction</div>
      <div class="bar"><i data-live="prog"></i></div>
      <div class="st note">${near ? 'Your Commander is building it.' : 'Walk your Commander within reach to build it.'}</div>
      <button class="btn warn tiny" data-act="recycle">Cancel · refund ${frontier.refundOf(s)}</button>`
  };
}

function helperPanel(h) {
  const f = h.fab && !h.fab.dead ? h.fab : null;
  const sig = `helper|${h.id}|${!!f}`;
  return {
    sig,
    body: `<div class="hd" style="color:${HELPER.color}">Helper</div>
      ${hpRow(h)}
      <div class="st note">${f ? `Feeds the Factory beside it: +${Math.round(HELPER_BOOST * 100)}% build speed.` : 'Its Factory is gone; it feeds nothing.'}</div>
      <button class="btn warn tiny" data-act="recycle">Recycle +${frontier.refundOf(h)}</button>`
  };
}

function unitButton(f, key) {
  const def = UNITS[key];
  const cost = frontier.unitPrice(key, f.tier);
  const secs = frontier.unitSeconds(key, f.tier) / frontier.fabSpeed(f);
  return `<button class="tw unit" data-act="add" data-k="${key}" style="--c:${def.col}" title="${def.name} · ${def.blurb}">
    <span class="ic" style="color:${def.col}">${GLYPHS[key]}</span><span class="nm">${def.name}</span>
    <span class="pr">${big(cost)} · ${secs.toFixed(1)}s</span></button>`;
}

function factoryPanel(f) {
  const helpers = frontier.helpersOf(f);
  const upCost = frontier.fabUpgradeCost(f);
  const afford = S.gold >= upCost;
  const held = f.held.filter(u => !u.dead).length;
  const sig = `fab|${f.id}|${f.tier}|${f.seq.join(',')}|${f.at}|${f.paused}|${!!f.up}|${f.job ? f.job.k : ''}|${f.stall}|${helpers}|${afford}|${f.group}|${held}`;
  const doing = f.up ? `Upgrading to tier ${f.tier + 1}`
    : f.job ? `Building ${UNITS[f.job.k].name}`
    : f.paused ? 'Paused'
    : !f.seq.length ? 'Idle - add units below'
    : f.stall ? (frontier.armySize(0) >= UNIT_CAP ? 'Army at its limit' : 'Waiting for gold')
    : 'Starting';
  const chips = f.seq.map((k, n) =>
    `<button class="chip seq${n === f.at && !f.paused ? ' now' : ''}" data-act="drop" data-n="${n}" style="--c:${UNITS[k].col}" title="Remove ${UNITS[k].name}">${GLYPHS[k]}</button>`).join('');
  return {
    sig,
    body: `<div class="hd" style="color:${FAB.color}">Factory · tier ${f.tier}</div>
      <div class="st"><span>${doing}</span><b>×${frontier.fabSpeed(f).toFixed(2)}</b></div>
      <div class="bar"><i data-live="job"></i></div>
      <div class="st"><span>helpers</span><b>${helpers} / 12</b></div>
      <div class="lbl">Build sequence · repeats · tap to remove · up to ${SEQ_MAX}</div>
      <div class="seqrow">${chips || '<span class="empty">empty</span>'}</div>
      <div class="units">${UNIT_ORDER.map(k => unitButton(f, k)).join('')}</div>
      <div class="lbl">March ${f.group > 1 ? `in groups of ${f.group} · ${held} waiting at the door` : 'one by one, as each is built'}</div>
      <div class="groups">${GROUPS.map(n => `<button class="btn tiny${n === f.group ? ' on' : ''}" data-act="group" data-n="${n}">${n === 1 ? 'Stream' : n}</button>`).join('')}</div>
      <div class="pair">
        <button class="btn tiny" data-act="pause">${f.paused ? 'Resume' : 'Pause'}</button>
        <button class="btn tiny" data-act="clear" ${f.seq.length ? '' : 'disabled'}>Clear</button>
      </div>
      <button class="btn tiny" data-act="upgrade" ${f.up || !afford ? 'disabled' : ''}>${f.up ? 'Upgrading…' : `Upgrade to tier ${f.tier + 1} · ${big(upCost)}`}</button>
      <div class="st note">Tier ${f.tier + 1} units are ×1.7 as strong, ×1.5 the price and take a little longer.</div>
      <button class="btn warn tiny" data-act="recycle">Recycle +${big(frontier.refundOf(f))}</button>`
  };
}

function enemyPanel(o) {
  const name = frontier.nameOf(o);
  const extra = o.type === 'fab'
    ? `<div class="st"><span>tier</span><b>${o.tier}</b></div>
       <div class="lbl">Building, on repeat</div>
       <div class="seqrow">${o.seq.map(k => `<span class="chip seq" style="--c:${UNITS[k].ecol}">${GLYPHS[k]}</span>`).join('') || '<span class="empty">nothing</span>'}</div>`
    : o.type === 'tower' ? `<div class="st"><span>level</span><b>${o.l + 1}</b></div>
       <div class="st"><span>range</span><b>${frontier.rangeOf(o).toFixed(1)}</b></div>` : '';
  const sig = `enemy|${o.id || 'cmd'}|${o.tier}|${(o.seq || []).join(',')}|${o.l}|${o.done}`;
  return {
    sig,
    body: `<div class="hd" style="color:#ff5f6d">Enemy ${name}${o.kind === 'struct' && !o.done ? ' · going up' : ''}</div>
      ${hpRow(o)}${extra}`
  };
}

/** One delegated click handler for every panel above. */
export function bindSelection(box) {
  box.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || S.mode !== 'frontier') return;
    const o = S.selected;
    if (!o) return;
    switch (btn.dataset.act) {
      case 'add': frontier.seqAdd(o, btn.dataset.k); break;
      case 'drop': frontier.seqRemove(o, Number(btn.dataset.n)); break;
      case 'pause': frontier.togglePause(o); break;
      case 'group': frontier.setGroup(o, Number(btn.dataset.n)); break;
      case 'clear': frontier.seqClear(o); break;
      case 'upgrade': frontier.upgradeFab(o); break;
      case 'recycle': frontier.recycle(o); break;
      case 'cancelAll': for (const s of frontier.sitesOf(0)) frontier.recycle(s); break;
      default: return;
    }
    selSig = '';
    S.onChange();
  });
}

/* ── the war report ───────────────────────────────────────────────────── */
export function report() {
  const T = S.tally;
  if (!T || !T.built) return '';
  const sum = bag => Object.values(bag).reduce((a, b) => a + b, 0);
  const summary = [
    `<div><b>${clock(F.time)}</b><span>time in the field</span></div>`,
    `<div><b>${big(S.kills)}</b><span>enemy units destroyed</span></div>`,
    `<div><b>${big(T.razed)}</b><span>enemy buildings razed</span></div>`,
    `<div><b>${big(S.score)}</b><span>points scored</span></div>`,
    `<div><b>${big(sum(T.built))}</b><span>units built · ${big(sum(T.lost))} lost</span></div>`,
    `<div><b>${big(T.structsLost)}</b><span>buildings lost</span></div>`,
    `<div><b>${big(S.minted)} ◈</b><span>cores minted</span></div>`,
    `<div><b>${big(T.spentUnits)}</b><span>gold spent on units</span></div>`
  ].join('');

  const kinds = UNIT_ORDER.filter(k => T.built[k] || T.lost[k] || T.killed[k]);
  const unitRows = kinds.map(k => `<tr style="--c:${UNITS[k].col}">
      <td class="nm"><i></i>${UNITS[k].name}</td>
      <td>${big(T.built[k] || 0)}</td>
      <td class="${T.lost[k] ? 'bad' : ''}">${big(T.lost[k] || 0)}</td>
      <td>${big(T.killed[k] || 0)}</td>
    </tr>`).join('');

  const total = sum(T.dmg) || 1;
  const towers = TOWER_ORDER.filter(k => T.dmg[k] || T.towerKills[k]);
  towers.sort((a, b) => (T.dmg[b] || 0) - (T.dmg[a] || 0));
  const towerRows = towers.map(k => {
    const pct = 100 * (T.dmg[k] || 0) / total;
    return `<tr style="--c:${TOWERS[k].color}">
      <td class="nm"><i></i>${TOWERS[k].name}</td>
      <td class="bar"><span style="width:${pct.toFixed(1)}%"></span><em>${big(T.dmg[k] || 0)}</em></td>
      <td>${big(T.towerKills[k] || 0)}</td>
    </tr>`;
  }).join('');

  const none = text => `<p class="empty">${text}</p>`;
  return `<div class="stats">${summary}</div>
    <div class="tables">
      <section>
        <h3>Units</h3>
        ${kinds.length ? `<table>
          <thead><tr><th>unit</th><th>built</th><th>lost</th><th>theirs killed</th></tr></thead>
          <tbody>${unitRows}</tbody></table>` : none('No units on either side yet.')}
      </section>
      <section>
        <h3>Towers</h3>
        ${towers.length ? `<table>
          <thead><tr><th>tower</th><th>damage</th><th>kills</th></tr></thead>
          <tbody>${towerRows}</tbody></table>` : none('No tower has fired yet.')}
      </section>
    </div>`;
}

/* ── the thumb stick ──────────────────────────────────────────────────────
   A fixed pad in the bottom-left corner of the map. Pushing it walks your
   Commander that way at a speed set by how far it is pushed, and puts the
   camera back on follow. It owns its own pointer, so the other thumb can
   drag the map or place buildings at the same time.                     */
export function bindStick(pad) {
  const knob = pad.querySelector('i');
  let id = null;
  const set = (x, y) => {
    F.stick.x = x; F.stick.y = y;
    const r = pad.clientWidth / 2;
    knob.style.transform = `translate(${x * r * 0.6}px, ${y * r * 0.6}px)`;
  };
  const read = ev => {
    const rect = pad.getBoundingClientRect();
    const r = rect.width / 2;
    let x = (ev.clientX - rect.left - r) / (r * 0.8);
    let y = (ev.clientY - rect.top - r) / (r * 0.8);
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    set(x, y);
  };
  pad.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    id = ev.pointerId;
    try { pad.setPointerCapture(id); } catch (e) { /* not capturable */ }
    pad.classList.add('held');
    F.follow = true;
    read(ev);
  });
  pad.addEventListener('pointermove', ev => { if (ev.pointerId === id) read(ev); });
  const release = ev => {
    if (ev.pointerId !== id) return;
    id = null;
    pad.classList.remove('held');
    set(0, 0);
  };
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);
  pad.addEventListener('contextmenu', ev => ev.preventDefault());
}
