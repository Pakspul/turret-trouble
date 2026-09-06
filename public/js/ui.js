/* ══ interface ═══════════════════════════════════════════════════════════
   Every DOM read and write. Subscribes to S.onChange and re-renders the
   side console, the overlays, and the Foundry.                          */

import { TOWERS, TOWER_ORDER, FOUNDRY, NODES, FOES } from './config.js';
import { field } from './field.js';
import {
  S, statsOf, dpsOf, upgradeCost, upgrade, sell,
  buildCost, refundOf, convertCost, convert, speedLadder
} from './game.js';
import { summarise } from './waves.js';
import * as meta from './meta.js';
import * as audio from './audio.js';
import * as store from './storage.js';

export const el = id => document.getElementById(id);

/* Set by main.js so button handlers can drive the run without ui.js
   reaching back into the boot module. */
export const actions = {
  play: () => {},
  startWave: () => {},
  clearGrid: () => {},
  togglePause: () => {},
  cycleSpeed: () => {},
  toggleDev: () => {},
  abandon: () => {}
};

const GLYPHS = {
  gun: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="12" r="4"/><path d="M14 12h7"/></svg>',
  rocket: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8h11l5 4-5 4H3"/><path d="M8 12h4"/></svg>',
  laser: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l8 6-8 6z"/><path d="M13 12h8"/></svg>',
  frost: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M4 7l16 10M20 7L4 17"/></svg>',
  tesla: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L5 13h6l-2 9 8-11h-6z"/></svg>'
};

const LOCK = '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';

/* ── side console ─────────────────────────────────────────────────────── */
export function buildShop() {
  const shop = el('shop');
  shop.textContent = '';
  for (const key of TOWER_ORDER) {
    const def = TOWERS[key];
    const btn = document.createElement('button');
    btn.className = 'tw';
    btn.dataset.k = key;
    btn.style.setProperty('--c', def.color);
    btn.addEventListener('click', () => {
      if (!meta.towerUnlocked(key)) { openFoundry(); return; }
      S.picked = S.picked === key ? null : key;
      S.selected = null;
      sync();
    });
    shop.appendChild(btn);
  }
}

/* sync() runs every frame, so each of the three rebuilds below writes markup
   only when its inputs actually changed. Class toggles are cheap enough to
   redo unconditionally. */
function syncShop() {
  for (const btn of el('shop').children) {
    const key = btn.dataset.k;
    const def = TOWERS[key];
    const unlocked = meta.towerUnlocked(key);
    // Every turret of a kind already standing makes the next one dearer.
    const cost = unlocked ? buildCost(key) : 0;

    btn.classList.toggle('on', S.picked === key);
    btn.classList.toggle('poor', unlocked && S.gold < cost);
    btn.classList.toggle('locked', !unlocked);

    const sig = (unlocked ? cost : 'shut') + '|' + meta.revision.n;
    if (btn.dataset.sig === sig) continue;
    btn.dataset.sig = sig;
    btn.title = unlocked
      ? `${def.name} · ${def.blurb}${cost > def.cost ? ` · base ${def.cost}` : ''}`
      : `${def.name} · locked in the Foundry`;
    btn.innerHTML =
      `<span class="ic" style="color:${unlocked ? def.color : 'var(--dim)'}">${unlocked ? GLYPHS[key] : LOCK}</span>` +
      `<span class="nm">${def.name}</span>` +
      `<span class="pr">${unlocked ? cost : 'locked'}</span>`;
  }
}

let selSig = '';

function syncSelection() {
  const box = el('sel');
  const t = S.selected;
  if (!t || field.grid[t.i] !== t) { box.classList.add('hidden'); selSig = ''; return; }

  const cost = upgradeCost(t);
  // Swap prices move with the board, so they go in the signature too.
  const swapCosts = TOWER_ORDER.map(k => (k === t.k ? '-' : convertCost(t, k)));
  const sig = `${meta.revision.n}|${t.i}|${t.k}|${t.l}|${cost}|${S.gold}|${t.spent}|${swapCosts}`;
  if (sig === selSig) return;
  selSig = sig;

  const def = TOWERS[t.k];
  const st = statsOf(t);
  const capped = cost == null;
  const atProtoWall = capped && t.l < def.lv.length - 1;
  const refund = refundOf(t);

  const extra = def.kind === 'aura'
    ? `<div class="st"><span>slow</span><b>${Math.round(st.slow * 100)}%</b></div>`
    : def.kind === 'chain'
      ? `<div class="st"><span>targets</span><b>${st.chains}</b></div>`
      : '';

  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="hd" style="color:${def.color}">${def.name} · lvl ${t.l + 1}</div>
     <div class="st"><span>damage/s</span><b>${dpsOf(t)}</b></div>
     <div class="st"><span>range</span><b>${st.range.toFixed(1)}</b></div>
     ${extra}
     <div class="st note">${def.blurb}</div>
     <div class="pair">
       <button class="btn" id="bUp" ${capped || S.gold < cost ? 'disabled' : ''}>
         ${capped ? (atProtoWall ? 'Needs Prototype Cores' : 'Maxed') : 'Upgrade ' + cost}
       </button>
       <button class="btn warn" id="bSell">Sell ${refund}</button>
     </div>
     <div class="swap">
       <span class="lbl">Swap type · full refund on this one</span>
       <div class="opts">${swapRow(t)}</div>
     </div>`;

  el('bUp').onclick = () => upgrade(t);
  el('bSell').onclick = () => sell(t);
  for (const btn of box.querySelectorAll('.sw')) {
    btn.onclick = () => convert(t, btn.dataset.k);
  }
}

/**
 * One button per other tower kind, priced as the net move on your purse:
 * the new turret's price less the full refund on the one standing there.
 */
function swapRow(t) {
  return TOWER_ORDER.filter(key => key !== t.k).map(key => {
    const other = TOWERS[key];
    const unlocked = meta.towerUnlocked(key);
    const net = convertCost(t, key);
    const blocked = !unlocked || net > S.gold;

    const price = !unlocked ? 'locked' : net > 0 ? '−' + net : net < 0 ? '+' + -net : 'free';
    const title = unlocked
      ? `Swap to ${other.name} · ${other.blurb}`
      : `${other.name} · locked in the Foundry`;

    return `<button class="sw${net < 0 && unlocked ? ' gain' : ''}" data-k="${key}"
        style="--c:${unlocked ? other.color : 'var(--dim)'}"
        ${blocked ? 'disabled' : ''} title="${title}">${unlocked ? GLYPHS[key] : LOCK}<span>${price}</span></button>`;
  }).join('');
}

let reconSig = '';

function syncRecon() {
  const box = el('recon');
  if (!meta.mods.recon || S.phase === 'run' || S.phase === 'menu' || S.phase === 'dead') {
    box.classList.add('hidden');
    reconSig = '';
    return;
  }
  box.classList.remove('hidden');

  const sig = meta.revision.n + ':' + S.wave;
  if (sig === reconSig) return;
  reconSig = sig;

  const rows = summarise(S.nextWave)
    .map(([type, n]) => {
      const def = FOES[type];
      return `<span class="chip" style="--c:${def.col}">${def.name}<b>${n}</b></span>`;
    })
    .join('');
  box.innerHTML = `<div class="hd">Wave ${S.wave + 1} inbound</div><div class="chips">${rows}</div>`;
}

export function syncSpeed() {
  const btn = el('btnSpeed');
  btn.textContent = S.speed + '×';
  btn.classList.toggle('dev', S.dev);
  btn.title = 'Game speed · ' + speedLadder().join('× / ') + '×';
  el('devTag').classList.toggle('hidden', !S.dev);
}

function syncWaveButton() {
  const btn = el('btnWave');
  if (S.phase === 'run') {
    btn.textContent = 'Wave ' + S.wave + ' incoming';
    btn.disabled = true;
    btn.classList.remove('go');
  } else if (S.phase === 'break') {
    btn.textContent = `Send wave ${S.wave + 1} (${Math.ceil(S.breakLeft)}s)`;
    btn.disabled = false;
    btn.classList.add('go');
  } else {
    btn.textContent = 'Send wave ' + (S.wave + 1);
    btn.disabled = S.phase !== 'build';
    btn.classList.add('go');
  }
}

export function sync() {
  el('waveNo').textContent = Math.max(1, S.wave);
  el('gold').textContent = S.gold;
  el('score').textContent = S.score.toLocaleString();
  el('cores').textContent = meta.profile.cores.toLocaleString();

  const hearts = [];
  for (let n = 0; n < S.maxLives; n++) hearts.push(n < S.lives ? '♥' : '<i>♥</i>');
  el('lives').innerHTML = hearts.join('');

  syncShop();
  syncSelection();
  syncRecon();
  syncWaveButton();
  syncSpeed();
  if (!el('foundry').classList.contains('hidden')) syncFoundry();
}

/* ── overlays ─────────────────────────────────────────────────────────── */
export function showStart() {
  el('startBest').textContent = meta.profile.stats.bestWave;
  el('startCores').textContent = meta.profile.cores.toLocaleString();
  el('startRuns').textContent = meta.profile.stats.runs;
  el('start').classList.remove('hidden');
  el('over').classList.add('hidden');
}

export function hideStart() {
  el('start').classList.add('hidden');
}

export function showGameOver() {
  el('overWave').textContent = S.wavesCleared;
  el('overScore').textContent = S.score.toLocaleString();
  el('overKills').textContent = S.kills;
  el('overBest').textContent = meta.profile.stats.bestWave;
  el('overCores').textContent = meta.profile.cores.toLocaleString();
  el('overLead').textContent = S.wavesCleared <= 3
    ? 'The line broke early. Bank the points and come back stronger.'
    : 'The line broke. Your points are already banked.';
  el('over').classList.remove('hidden');
}

/* ── the Foundry ──────────────────────────────────────────────────────── */
let foundryFilter = 'all';
let resumeAfterFoundry = false;

export function openFoundry() {
  resumeAfterFoundry = S.phase === 'run' || S.phase === 'break';
  if (resumeAfterFoundry) S.paused = true;
  el('foundry').classList.remove('hidden');
  syncFoundry();
}

export function closeFoundry() {
  el('foundry').classList.add('hidden');
  if (resumeAfterFoundry) S.paused = false;
  resumeAfterFoundry = false;
  el('btnPause').textContent = S.paused ? 'Resume' : 'Pause';
  sync();
}

export function buildFoundry() {
  const tabs = el('fTabs');
  tabs.textContent = '';
  const groups = [{ id: 'all', name: 'All' }, ...FOUNDRY];
  for (const group of groups) {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.g = group.id;
    btn.textContent = group.name;
    btn.addEventListener('click', () => { foundryFilter = group.id; syncFoundry(); });
    tabs.appendChild(btn);
  }

  el('fGrid').addEventListener('click', ev => {
    const card = ev.target.closest('.node');
    if (!card) return;
    const id = card.dataset.id;
    if (meta.buy(id)) {
      audio.sfx.buy();
      syncFoundry();
      sync();
    } else {
      audio.sfx.deny();
      card.classList.remove('shake');
      // Restart the CSS animation by forcing a reflow.
      void card.offsetWidth;
      card.classList.add('shake');
    }
  });
}

function syncFoundry() {
  el('fCores').textContent = meta.profile.cores.toLocaleString();
  el('fBest').textContent = meta.profile.stats.bestWave;
  el('fKills').textContent = meta.profile.stats.kills.toLocaleString();
  el('fLifetime').textContent = meta.profile.stats.lifetimePoints.toLocaleString();

  for (const tab of el('fTabs').children) {
    tab.classList.toggle('on', tab.dataset.g === foundryFilter);
  }

  const grid = el('fGrid');
  grid.textContent = '';

  for (const group of FOUNDRY) {
    if (foundryFilter !== 'all' && foundryFilter !== group.id) continue;

    const header = document.createElement('div');
    header.className = 'gh';
    header.innerHTML = `<h3>${group.name}</h3><span>${group.hint}</span>`;
    grid.appendChild(header);

    const wrap = document.createElement('div');
    wrap.className = 'nodes';
    for (const node of group.nodes) wrap.appendChild(nodeCard(node));
    grid.appendChild(wrap);
  }
}

function nodeCard(node) {
  const level = meta.levelOf(node.id);
  const maxed = level >= node.max;
  const open = meta.available(node);
  const cost = maxed ? null : meta.costOf(node.id);
  const affordable = !maxed && open && meta.profile.cores >= cost;

  const card = document.createElement('div');
  card.className = 'node';
  card.dataset.id = node.id;
  card.classList.toggle('maxed', maxed);
  card.classList.toggle('locked', !open);
  card.classList.toggle('ready', affordable);

  const pips = node.max > 1
    ? `<span class="pips">${Array.from({ length: node.max }, (_, n) =>
        `<i class="${n < level ? 'on' : ''}"></i>`).join('')}</span>`
    : `<span class="pips one">${level ? 'owned' : ''}</span>`;

  const current = level > 0 && node.value
    ? `<div class="cur">now: ${node.value(level)}</div>`
    : '';

  const cta = !open
    ? `Needs ${NODES[node.req].name}`
    : maxed
      ? (node.max > 1 ? 'Fully upgraded' : 'Unlocked')
      : `${cost} ◈`;

  card.innerHTML =
    `<div class="nh"><span class="nn">${node.name}</span>${pips}</div>
     <div class="ns">${node.step}</div>
     <div class="nb">${node.blurb}</div>
     ${current}
     <div class="buy ${affordable ? 'ready' : ''}">${cta}</div>`;

  return card;
}

/* ── wiring ───────────────────────────────────────────────────────────── */
export function bind() {
  buildShop();
  buildFoundry();

  el('btnWave').onclick = () => actions.startWave();
  el('btnClear').onclick = () => actions.clearGrid();
  el('btnPause').onclick = () => {
    actions.togglePause();
    el('btnPause').textContent = S.paused ? 'Resume' : 'Pause';
  };
  el('btnSpeed').onclick = () => { actions.cycleSpeed(); syncSpeed(); };

  el('btnFoundry').onclick = openFoundry;
  el('fClose').onclick = closeFoundry;
  el('btnStartFoundry').onclick = openFoundry;
  el('btnOverFoundry').onclick = openFoundry;

  el('btnPlay').onclick = () => actions.play();
  el('btnAgain').onclick = () => actions.play();
  el('btnMenu').onclick = () => actions.abandon();

  el('btnMute').onclick = () => {
    const muted = audio.toggleMute();
    el('btnMute').textContent = muted ? 'Sound off' : 'Sound on';
  };

  el('btnFs').onclick = () => {
    try {
      const root = document.documentElement;
      const p = document.fullscreenElement
        ? document.exitFullscreen()
        : (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* fullscreen unavailable */ }
  };

  el('fWipe').onclick = () => {
    if (!confirm('Erase all Cores, upgrades and records? This cannot be undone.')) return;
    meta.resetProfile();
    syncFoundry();
    sync();
  };

  if (!store.isPersistent()) el('warnStore').classList.remove('hidden');

  addEventListener('keydown', ev => {
    if (ev.repeat) return;
    if (ev.key === 'Escape') {
      if (!el('foundry').classList.contains('hidden')) closeFoundry();
      else { S.picked = null; S.selected = null; sync(); }
      return;
    }
    if (!el('start').classList.contains('hidden') || !el('over').classList.contains('hidden')) return;
    if (!el('foundry').classList.contains('hidden')) return;

    const digit = Number(ev.key);
    if (digit >= 1 && digit <= TOWER_ORDER.length) {
      const key = TOWER_ORDER[digit - 1];
      if (meta.towerUnlocked(key)) { S.picked = S.picked === key ? null : key; S.selected = null; sync(); }
      return;
    }
    if (ev.shiftKey && (ev.key === 'D' || ev.key === 'd')) { actions.toggleDev(); return; }
    if (ev.key === ' ') { ev.preventDefault(); actions.startWave(); }
    else if (ev.key === 'p' || ev.key === 'P') { actions.togglePause(); el('btnPause').textContent = S.paused ? 'Resume' : 'Pause'; }
    else if (ev.key === 'f' || ev.key === 'F') { openFoundry(); }
  });
}
