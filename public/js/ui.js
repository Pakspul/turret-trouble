/* ══ interface ═══════════════════════════════════════════════════════════
   Every DOM read and write. Subscribes to S.onChange and re-renders the
   side console, the overlays, and the Foundry.                          */

import {
  TOWERS, TOWER_ORDER, FOUNDRY, NODES, FOES, UNITS, UNIT_ORDER,
  FRONTIER_UNLOCK_WAVE, HIGH_GROUND_RANGE, sectorDepth, sectorBounty, bunkerCount
} from './config.js';
import { field } from './field.js';
import * as holdout from './game.js';
import { S, statsOf, dpsOf, speedLadder } from './game.js';
import * as frontier from './frontier.js';
import { F } from './frontier.js';
import { sectorSeed, seedTag } from './terrain.js';
import { summarise } from './waves.js';
import * as meta from './meta.js';
import * as recorder from './recorder.js';
import * as audio from './audio.js';
import * as store from './storage.js';
import { BUILD } from './version.js';

export const el = id => document.getElementById(id);

/**
 * The tower rules of whichever mode owns the run. Both modes price, build,
 * swap and sell turrets the same way; they differ in where the turrets
 * live, so the panel asks through here rather than reaching into either.
 */
const HOLDOUT_RULES = {
  buildCost: holdout.buildCost, upgradeCost: holdout.upgradeCost, upgrade: holdout.upgrade,
  sell: holdout.sell, refundOf: holdout.refundOf, convertCost: holdout.convertCost, convert: holdout.convert,
  alive: t => !!t && field.grid[t.i] === t,
  towers: () => field.grid.filter(Boolean)
};
const FRONTIER_RULES = {
  buildCost: frontier.buildCost, upgradeCost: frontier.upgradeCost, upgrade: frontier.upgrade,
  sell: frontier.sell, refundOf: frontier.refundOf, convertCost: frontier.convertCost, convert: frontier.convert,
  alive: frontier.alive,
  towers: frontier.allTowers
};
const rules = () => (S.mode === 'frontier' ? FRONTIER_RULES : HOLDOUT_RULES);

/* Set by main.js so button handlers can drive the run without ui.js
   reaching back into the boot module. */
export const actions = {
  play: () => {},
  startWave: () => {},
  clearGrid: () => {},
  togglePause: () => {},
  cycleSpeed: () => {},
  toggleDev: () => {},
  abandon: () => {},
  /** Open the title screen over the run without ending it. */
  menu: () => {},
  /** Close the title screen and carry on with the suspended run. */
  resume: () => {},
  /** Replay a saved blueprint: now if the board is still empty, else next run. */
  replay: () => {},
  /** Open a Frontier sortie on sector `s`. */
  frontier: () => {},
  /** Put the Frontier camera back over the HQ. */
  home: () => {}
};

const GLYPHS = {
  gun: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="12" r="4"/><path d="M14 12h7"/></svg>',
  rocket: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8h11l5 4-5 4H3"/><path d="M8 12h4"/></svg>',
  laser: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l8 6-8 6z"/><path d="M13 12h8"/></svg>',
  frost: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M4 7l16 10M20 7L4 17"/></svg>',
  tesla: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L5 13h6l-2 9 8-11h-6z"/></svg>',
  portal: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="5" ry="9"/><path d="M2 12h6M16 12h6"/></svg>',
  factory: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/></svg>'
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
    const cost = unlocked ? rules().buildCost(key) : 0;

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
let selShown = null;

function syncSelection() {
  const box = el('sel');
  const t = S.selected;
  const R = rules();
  if (!R.alive(t)) { box.classList.add('hidden'); selSig = ''; selShown = null; return; }

  const cost = R.upgradeCost(t);
  // Swap prices move with the board, so they go in the signature too.
  const swapCosts = TOWER_ORDER.map(k => (k === t.k ? '-' : R.convertCost(t, k)));
  const hp = t.max ? Math.ceil(t.hp) : '';
  const sig = `${S.mode}|${meta.revision.n}|${t.i}|${t.k}|${t.l}|${cost}|${S.gold}|${t.spent}|${swapCosts}|${t.k === 'factory' ? S.minted : ''}|${hp}|${t.max}`;
  if (sig === selSig) return;
  selSig = sig;

  const def = TOWERS[t.k];
  const st = statsOf(t);
  // Frontier towers on high ground see further than the Holdout figure.
  const range = S.mode === 'frontier' ? frontier.rangeOf(t) : st.range;
  const capped = cost == null;
  const atProtoWall = capped;
  const refund = R.refundOf(t);

  const readout = def.kind === 'factory'
    ? `<div class="st"><span>cores/s</span><b>${st.yield.toFixed(2)}</b></div>
       <div class="st"><span>minted this run</span><b>${S.minted}</b></div>`
    : def.kind === 'portal'
      ? `<div class="st"><span>cooldown</span><b>${st.rate.toFixed(1)} s</b></div>
         <div class="st"><span>range</span><b>${range.toFixed(1)}</b></div>`
      : `<div class="st"><span>damage/s</span><b>${dpsOf(t)}</b></div>
         <div class="st"><span>range</span><b>${range.toFixed(1)}</b></div>`;

  // Frontier: towers can be shot, and high ground is worth range.
  const armour = t.max
    ? `<div class="st"><span>health</span><b class="${t.hp < t.max * 0.35 ? 'low' : ''}">${big(t.hp)} / ${big(t.max)}</b></div>` +
      (t.elev ? `<div class="st"><span>high ground</span><b>+${Math.round(HIGH_GROUND_RANGE * t.elev * 100)}% range</b></div>` : '')
    : '';

  const extra = armour + (def.kind === 'aura'
    ? `<div class="st"><span>slow</span><b>${Math.round(st.slow * 100)}%</b></div>`
    : def.kind === 'chain'
      ? `<div class="st"><span>targets</span><b>${st.chains}</b></div>`
      : '');

  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="hd" style="color:${def.color}">${def.name} · lvl ${t.l + 1}</div>
     ${readout}
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

  el('bUp').onclick = () => R.upgrade(t);
  el('bSell').onclick = () => R.sell(t);
  for (const btn of box.querySelectorAll('.sw')) {
    btn.onclick = () => R.convert(t, btn.dataset.k);
  }

  // On a short screen the readout can land below the fold of the scrolling
  // console, so bring it into view whenever a different turret is picked.
  if (selShown !== t) {
    selShown = t;
    try { box.scrollIntoView({ block: 'nearest' }); } catch (e) { box.scrollIntoView(false); }
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
    const net = rules().convertCost(t, key);
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

/* ── the replay readout ───────────────────────────────────────────────────
   The buttons here are built once and only ever relabelled: rebuilding the
   markup under a finger that is mid-press would swallow the click.       */
let replaySig = '';

function syncReplay() {
  const box = el('replay');
  const p = recorder.rec.play;
  if (!p) { box.classList.add('hidden'); replaySig = ''; return; }
  box.classList.remove('hidden');

  const sig = `${p.at}|${p.status}|${p.need}|${p.done}|${p.skipped}|${p.paused}`;
  if (sig === replaySig) return;
  replaySig = sig;

  const settled = p.done + p.skipped;
  el('rName').textContent = p.name;
  el('rBar').style.width = Math.round(100 * settled / Math.max(1, p.total)) + '%';
  el('rLine').textContent = recorder.playbackLine();
  el('rHold').textContent = p.paused ? 'Resume' : 'Pause';
  el('rHold').disabled = p.status === 'done';
  el('rSkip').disabled = p.status === 'done';

  for (const state of ['wait', 'hold', 'done']) {
    box.classList.toggle(state, p.status === state);
  }
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

  syncLives();
  syncMode();
  syncShop();
  syncSquad();
  syncSelection();
  syncRecon();
  syncReplay();
  syncWaveButton();
  syncSpeed();
  syncTapeButton();
  if (!el('foundry').classList.contains('hidden')) syncFoundry();
  if (!el('tapes').classList.contains('hidden')) syncTapes();
}

/** Holdout counts breaches in hearts; Frontier shows the HQ's integrity. */
let livesSig = '';
function syncLives() {
  const sig = `${S.mode}|${S.lives}|${S.maxLives}`;
  if (sig === livesSig) return;
  livesSig = sig;
  if (S.mode === 'frontier') {
    el('livesK').textContent = 'HQ integrity';
    const frac = Math.max(0, S.lives / Math.max(1, S.maxLives));
    el('lives').innerHTML = `<span class="hqbar"><i style="width:${(frac * 100).toFixed(1)}%"></i></span><b>${Math.max(0, S.lives)}</b>`;
    el('lives').classList.toggle('hurt', frac < 0.35);
    return;
  }
  el('livesK').textContent = 'breaches left';
  el('lives').classList.remove('hurt');
  const hearts = [];
  for (let n = 0; n < S.maxLives; n++) hearts.push(n < S.lives ? '♥' : '<i>♥</i>');
  el('lives').innerHTML = hearts.join('');
}

/** Controls that only make sense in one of the two modes. */
function syncMode() {
  const fr = S.mode === 'frontier';
  el('btnTapes').classList.toggle('hidden', fr);
  el('btnClear').classList.toggle('hidden', fr);
  el('btnHome').classList.toggle('hidden', !fr);
  el('squad').classList.toggle('hidden', !fr);
}

/* ── the Frontier barracks ────────────────────────────────────────────────
   Units are bought into a squad that waits at the HQ; the squad marches
   when the next wave is sent, or at once with Deploy. Buttons are built
   once and relabelled, so a press is never swallowed by a rebuild.      */
function buildSquad() {
  const shop = el('unitShop');
  shop.textContent = '';
  for (const key of UNIT_ORDER) {
    const def = UNITS[key];
    const btn = document.createElement('button');
    btn.className = 'tw unit';
    btn.dataset.k = key;
    btn.style.setProperty('--c', def.col);
    btn.title = `${def.name} · ${def.blurb}`;
    btn.innerHTML = `<span class="ic" style="color:${def.col}">${UNIT_GLYPHS[key]}</span>` +
      `<span class="nm">${def.name}</span><span class="q"></span><span class="pr"></span>`;
    btn.addEventListener('click', () => { frontier.recruit(key); sync(); });
    shop.appendChild(btn);
  }
  el('bArmory').onclick = () => { frontier.upgradeArmory(); sync(); };
  el('bDeploy').onclick = () => { frontier.deploy(); sync(); };
  el('bDisband').onclick = () => { frontier.disband(); sync(); };
}

const UNIT_GLYPHS = {
  trooper: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="12" r="4"/><path d="M13 12h8"/></svg>',
  striker: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12L5 5l4 7-4 7z"/></svg>',
  breaker: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="12" height="10" rx="2"/><path d="M15 12h7"/></svg>'
};

let squadSig = '';
function syncSquad() {
  if (S.mode !== 'frontier' || !F.map) { squadSig = ''; return; }
  const size = frontier.squadSize();
  const prices = UNIT_ORDER.map(k => frontier.unitPrice(k));
  const alive = F.units.length;
  const living = F.bunkers.filter(b => !b.dead).length;
  const sig = [S.gold, size, prices, alive, F.armory, Math.ceil(F.enemy.hp), living, S.phase, meta.revision.n].join('|');
  if (sig === squadSig) return;
  squadSig = sig;

  UNIT_ORDER.forEach((key, n) => {
    const btn = el('unitShop').children[n];
    btn.classList.toggle('poor', S.gold < prices[n]);
    btn.querySelector('.q').textContent = F.squad[key] ? '×' + F.squad[key] : '';
    btn.querySelector('.pr').textContent = prices[n];
  });
  el('sqCount').textContent = `${alive} out · ${size} ready`;

  const armory = frontier.armoryPrice();
  el('bArmory').textContent = `Armory lvl ${F.armory + 1} · ${armory}`;
  el('bArmory').title = 'Every unit you field from now on is issued with tougher kit';
  el('bArmory').disabled = S.gold < armory;
  el('bDeploy').disabled = !size || S.phase === 'dead';
  el('bDisband').disabled = !size;

  el('sqLine').textContent = size
    ? 'The squad marches when the next wave is sent.'
    : alive ? 'Your units are in the field.' : 'Buy units to raise a counter-wave.';
  const pct = Math.max(0, Math.round(100 * F.enemy.hp / F.enemy.max));
  el('sqEnemy').innerHTML =
    `<span>Enemy HQ</span><span class="hqbar foe"><i style="width:${pct}%"></i></span><b>${pct}%</b>` +
    `<span class="bk">${living}/${F.bunkers.length} bunkers</span>`;
}

/* ── overlays ─────────────────────────────────────────────────────────── */
export function showStart() {
  el('startBest').textContent = meta.profile.stats.bestWave;
  el('startCores').textContent = meta.profile.cores.toLocaleString();
  el('startRuns').textContent = meta.profile.stats.runs;
  // A run parked behind the menu can be picked straight back up.
  const parked = S.suspended;
  el('btnResume').classList.toggle('hidden', !parked);
  el('btnResume').textContent = S.mode === 'frontier'
    ? `Resume sector ${F.sector} · wave ${Math.max(1, S.wave)}`
    : `Resume wave ${Math.max(1, S.wave)}`;
  syncFrontierButton();
  el('btnPlay').classList.toggle('go', !parked);
  el('btnPlayHead').classList.toggle('go', !parked);
  // The breakdown of the run behind the menu, so a glance at Menu answers
  // "how is this run going?".
  el('startReport').classList.toggle('hidden', !parked);
  if (parked) el('startReport').innerHTML = runReport();
  el('start').classList.remove('hidden');
  el('over').classList.add('hidden');
  syncArmed();
}

/** Says which blueprint the next run will replay, on both overlays. */
export function syncArmed() {
  const bp = recorder.rec.armed ? recorder.find(recorder.rec.armed) : null;
  const text = bp ? `Next run replays “${bp.name}” · ${bp.steps.length} steps` : '';
  for (const id of ['startArmed', 'overArmed']) {
    el(id).textContent = text;
    el(id).classList.toggle('hidden', !bp);
  }
  syncHeadStart();
}

/**
 * Once Head Start is owned, every new run is an explicit choice between two
 * buttons - wave 1, or past the skipped waves - rather than a remembered
 * switch that is easy to flip by accident and then forget about.
 */
function syncHeadStart() {
  const owned = meta.headStartOwned();
  const opens = meta.mods.skipWaves + 1;
  const parked = S.suspended;
  const fresh = parked ? 'New run' : 'Start defending';

  el('btnPlay').textContent = owned ? `${fresh} · wave 1` : fresh;
  el('btnAgain').textContent = owned ? 'Again · wave 1' : 'Defend again';
  for (const id of ['btnPlayHead', 'btnAgainHead']) {
    el(id).classList.toggle('hidden', !owned);
    el(id).textContent = `Head start · wave ${opens}`;
    el(id).title = `Skip waves 1-${opens - 1}; they are paid out as if held`;
  }
}

/** Frontier is locked behind Holdout wave 100; the button says so. */
function syncFrontierButton() {
  const open = meta.frontierUnlocked(S.dev);
  const btn = el('btnFrontier');
  btn.classList.toggle('locked', !open);
  btn.textContent = open ? 'Frontier' : `Frontier · hold wave ${FRONTIER_UNLOCK_WAVE}`;
  btn.title = open
    ? 'Open maps, enemies that shoot back, and a base to raze'
    : `Unlocks once you have held wave ${FRONTIER_UNLOCK_WAVE} in Holdout (best so far: ${meta.profile.stats.bestWave})`;
}

export function hideStart() {
  el('start').classList.add('hidden');
}

export function showGameOver() {
  if (S.mode === 'frontier') { showSortieOver(); return; }
  el('btnOverNext').classList.add('hidden');
  el('btnAgain').classList.add('go');
  el('overWave').textContent = S.wavesCleared;
  el('overBestK').textContent = 'best';
  el('overBest').textContent = meta.profile.stats.bestWave;
  el('overCores').textContent = meta.profile.cores.toLocaleString();
  el('overLead').textContent = S.wavesCleared >= FRONTIER_UNLOCK_WAVE && !meta.profile.frontier.runs
    ? `Wave ${FRONTIER_UNLOCK_WAVE} held - Frontier is open. Find it on the title screen.`
    : S.wavesCleared <= 3
    ? 'The line broke early. Bank the points and come back stronger.'
    : 'The line broke. Your points are already banked.';

  // The run just recorded itself; offer it straight back as a build order.
  const bp = recorder.rec.last;
  const replay = el('btnOverReplay');
  replay.classList.toggle('hidden', !bp);
  if (bp) {
    replay.textContent = `Replay this build (${bp.steps.length})`;
    replay.title = `${bp.name} · saved to Blueprints`;
  }

  el('overReport').innerHTML = runReport();
  el('over').classList.remove('hidden');
  syncArmed();
}

/** The summary screen, Frontier edition: razed or overrun. */
function showSortieOver() {
  const won = F.result === 'won';
  el('overWave').textContent = S.wavesCleared;
  el('overBestK').textContent = 'sectors razed';
  el('overBest').textContent = meta.profile.frontier.cleared;
  el('overCores').textContent = meta.profile.cores.toLocaleString();
  el('overLead').textContent = won
    ? `Sector ${F.sector} razed. The bounty of ${F.bounty.toLocaleString()} Cores is already banked.`
    : `Sector ${F.sector}: the HQ fell. Your points are already banked.`;
  el('btnOverReplay').classList.add('hidden');
  el('btnAgainHead').classList.add('hidden');
  el('btnOverNext').classList.toggle('hidden', !won);
  el('btnOverNext').textContent = `Sector ${F.sector + 1}`;
  el('btnAgain').textContent = won ? `Replay sector ${F.sector}` : `Retry sector ${F.sector}`;
  el('btnAgain').classList.toggle('go', !won);
  el('overReport').innerHTML = runReport();
  el('over').classList.remove('hidden');
}

/* ── the run report ───────────────────────────────────────────────────────
   Shared by the menu (for a run that is parked) and the summary screen:
   damage by tower, kills and leaks by enemy, and what the run earned.    */

/** 1234 -> "1,234", 1234567 -> "1.23M": damage runs into the billions. */
function big(n) {
  n = Math.round(n);
  if (n < 1e5) return n.toLocaleString();
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (const [size, tag] of units) {
    if (n >= size) return (n / size).toPrecision(3) + tag;
  }
  return String(n);
}

function towerCounts() {
  const out = {};
  for (const t of rules().towers()) out[t.k] = (out[t.k] || 0) + 1;
  return out;
}

export function runReport() {
  const T = S.tally;
  if (!T) return '';
  const built = towerCounts();

  const fought = S.kills - T.headKills;
  const leaked = Object.values(T.leaks).reduce((a, b) => a + b, 0);
  const summary = [
    `<div><b>${big(S.kills)}</b><span>kills${T.headKills ? ` · ${big(T.headKills)} head start` : ''}</span></div>`,
    `<div><b>${big(S.score)}</b><span>points scored</span></div>`,
    `<div><b>${big(S.minted)} ◈</b><span>cores minted</span></div>`,
    `<div><b>${leaked}</b><span>leaked</span></div>`,
    // Frontier: how the counter-waves and the towers fared.
    ...(S.mode === 'frontier' ? [
      `<div><b>${big(T.unitsSent)}</b><span>units sent · ${big(T.unitsLost)} lost</span></div>`,
      `<div><b>${big(T.unitKills)}</b><span>unit kills</span></div>`,
      `<div><b>${big(T.towersLost)}</b><span>towers lost</span></div>`,
      `<div><b>${big(T.baseDmg)}</b><span>damage to the base</span></div>`
    ] : [])
  ].join('');

  // Towers: everything built now, plus anything that dealt damage before it
  // was sold, strongest first.
  const total = Object.values(T.dmg).reduce((a, b) => a + b, 0) || 1;
  const kinds = TOWER_ORDER.filter(k => built[k] || T.dmg[k] || T.towerKills[k]);
  kinds.sort((a, b) => (T.dmg[b] || 0) - (T.dmg[a] || 0));
  const towerRows = kinds.map(k => {
    const def = TOWERS[k];
    // Portals and Factories deal no damage; show what they do instead.
    const pct = 100 * (T.dmg[k] || 0) / total;
    const dealt = def.kind === 'portal' ? `${big(T.warps)} sent back`
      : def.kind === 'factory' ? `${big(S.minted)} ◈`
      : big(T.dmg[k] || 0);
    const share = def.kind === 'portal' || def.kind === 'factory' ? '' : Math.round(pct) + '%';
    return `<tr style="--c:${def.color}">
      <td class="nm"><i></i>${def.name}</td>
      <td>${built[k] || 0}</td>
      <td class="bar"><span style="width:${pct.toFixed(1)}%"></span><em>${dealt}</em></td>
      <td>${share}</td>
      <td>${big(T.towerKills[k] || 0)}</td>
    </tr>`;
  }).join('');

  const foes = Object.keys(FOES).filter(k => T.kills[k] || T.leaks[k]);
  const foeRows = foes.map(k => `<tr style="--c:${FOES[k].col}">
      <td class="nm"><i></i>${FOES[k].name}</td>
      <td>${big(T.kills[k] || 0)}</td>
      <td class="${T.leaks[k] ? 'bad' : ''}">${T.leaks[k] || 0}</td>
    </tr>`).join('');

  const none = text => `<p class="empty">${text}</p>`;
  return `<div class="stats">${summary}</div>
    <div class="tables">
      <section>
        <h3>Towers</h3>
        ${kinds.length ? `<table>
          <thead><tr><th>tower</th><th>built</th><th>damage</th><th>share</th><th>kills</th></tr></thead>
          <tbody>${towerRows}</tbody></table>` : none('No towers built yet.')}
      </section>
      <section>
        <h3>Enemies${fought !== S.kills ? ' · in play' : ''}</h3>
        ${foes.length ? `<table>
          <thead><tr><th>enemy</th><th>killed</th><th>leaked</th></tr></thead>
          <tbody>${foeRows}</tbody></table>` : none('Nothing has come through the gate yet.')}
      </section>
    </div>`;
}

/* ── the Frontier sector picker ───────────────────────────────────────────
   Every razed sector can be flown again, and the next one is always open.
   Sectors are seeded, so each card's map is the same every time.       */
export function openSectors() {
  if (!meta.frontierUnlocked(S.dev)) {
    audio.sfx.deny();
    return;
  }
  el('sectors').classList.remove('hidden');
  syncSectors();
}

export function closeSectors() {
  el('sectors').classList.add('hidden');
}

function syncSectors() {
  const cleared = meta.profile.frontier.cleared;
  el('sCleared').textContent = cleared;
  const list = el('sList');
  list.textContent = '';
  const last = cleared + 1;
  for (let s = last; s >= 1; s--) {
    const card = document.createElement('div');
    card.className = 'bp sector';
    card.classList.toggle('pinned', s <= cleared);
    card.classList.toggle('live', s === last);
    card.innerHTML =
      `<div class="bh">
         <span class="bn">Sector ${s}</span>
         <span class="bw">${s <= cleared ? 'razed' : 'open'}</span>
       </div>
       <div class="bm">map ${seedTag(sectorSeed(s))} · threat from wave ${sectorDepth(s) + 1} · ${bunkerCount(s)} bunkers · bounty ${sectorBounty(s).toLocaleString()} ◈</div>
       <div class="brow"><button class="btn tiny go" data-s="${s}">${s === last ? 'Fly this sector' : 'Fly again'}</button></div>`;
    list.appendChild(card);
  }
}

function buildSectors() {
  el('sList').addEventListener('click', ev => {
    const btn = ev.target.closest('button[data-s]');
    if (!btn) return;
    const s = Number(btn.dataset.s);
    if (S.suspended && !confirm(`End the current run and fly sector ${s}?`)) return;
    closeSectors();
    autoFullscreen();
    actions.frontier(s);
  });
  el('sClose').onclick = closeSectors;
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
  syncHeadStart();
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
  const endless = node.max === Infinity;
  const maxed = level >= node.max;
  const needWave = maxed ? 0 : meta.waveNeeded(node);
  const open = meta.available(node) && meta.reached(node);
  const cost = maxed ? null : meta.costOf(node.id);
  const affordable = !maxed && open && meta.profile.cores >= cost;

  const card = document.createElement('div');
  card.className = 'node';
  card.dataset.id = node.id;
  card.classList.toggle('maxed', maxed);
  card.classList.toggle('locked', !open);
  card.classList.toggle('ready', affordable);

  // Endless nodes have no last pip to fill, so they count ranks instead.
  const pips = endless
    ? `<span class="pips one">${level ? 'lvl ' + level : ''}</span>`
    : node.max > 1
    ? `<span class="pips">${Array.from({ length: node.max }, (_, n) =>
        `<i class="${n < level ? 'on' : ''}"></i>`).join('')}</span>`
    : `<span class="pips one">${level ? 'owned' : ''}</span>`;

  const current = level > 0 && node.value
    ? `<div class="cur">now: ${node.value(level)}</div>`
    : '';

  const cta = !meta.available(node)
    ? `Needs ${NODES[node.req].name}`
    : !open
      ? `Hold wave ${needWave} first`
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

/* ── the blueprint sheet ──────────────────────────────────────────────────
   The library of recorded build orders: replay one, pin the good ones, and
   pass them around as JSON.                                              */
let resumeAfterTapes = false;

export function openTapes() {
  resumeAfterTapes = S.phase === 'run' || S.phase === 'break';
  if (resumeAfterTapes) S.paused = true;
  el('tapes').classList.remove('hidden');
  syncTapes();
}

export function closeTapes() {
  el('tapes').classList.add('hidden');
  if (resumeAfterTapes) S.paused = false;
  resumeAfterTapes = false;
  el('btnPause').textContent = S.paused ? 'Resume' : 'Pause';
  sync();
}

function syncTapeButton() {
  const btn = el('btnTapes');
  const playing = !!recorder.rec.play;
  el('tapeTally').textContent = playing
    ? `${recorder.rec.play.done}/${recorder.rec.play.total}`
    : recorder.library.list.length;
  btn.classList.toggle('live', playing);
}

let tapeSig = '';

function syncTapes() {
  const list = el('tList');
  el('tSaved').textContent = recorder.library.list.length;

  const steps = recorder.rec.tape.length;
  el('tNow').textContent = steps
    ? `This run: ${steps} step${steps === 1 ? '' : 's'} recorded, up to wave ${Math.max(1, S.wave)}`
    : 'Nothing recorded yet this run.';
  el('tKeep').disabled = steps < 1;

  const playing = recorder.rec.play;
  const sig = [
    recorder.revision.n,
    recorder.library.list.length,
    recorder.rec.armed,
    playing ? playing.id : ''
  ].join('|');
  if (sig === tapeSig) return;
  tapeSig = sig;

  list.textContent = '';
  if (!recorder.library.list.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      'No blueprints yet. Every run records itself - play one out and it lands here when it ends.';
    list.appendChild(empty);
    return;
  }
  for (const bp of recorder.library.list) list.appendChild(tapeCard(bp));
}

function tapeCard(bp) {
  const card = document.createElement('div');
  card.className = 'bp';
  card.dataset.id = bp.id;
  card.classList.toggle('pinned', bp.pinned);
  const live = recorder.rec.play && recorder.rec.play.id === bp.id;
  card.classList.toggle('live', !!live);

  const armed = recorder.rec.armed === bp.id;
  const towers = recorder.summarise(bp.steps)
    .map(([k, n]) => `<span class="chip" style="--c:${TOWERS[k].color}">${TOWERS[k].name}<b>${n}</b></span>`)
    .join('');

  const when = new Date(bp.created).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });

  const flags = [
    bp.pinned ? 'pinned' : null,
    live ? 'replaying now' : armed ? 'armed for next run' : null
  ].filter(Boolean).join(' · ');

  card.innerHTML =
    `<div class="bh">
       <span class="bn">${escapeText(bp.name)}</span>
       <span class="bw">wave ${bp.waves || recorder.lastWave(bp.steps)}</span>
     </div>
     <div class="bm">${bp.steps.length} steps · ${when}${flags ? ' · ' + flags : ''}</div>
     <div class="chips">${towers}</div>
     <div class="brow">
       <button class="btn tiny go" data-a="play">${armed ? 'Armed' : 'Replay'}</button>
       <button class="btn tiny" data-a="pin">${bp.pinned ? 'Unpin' : 'Pin'}</button>
       <button class="btn tiny" data-a="rename">Rename</button>
       <button class="btn tiny" data-a="copy">Copy</button>
       <button class="btn tiny warn" data-a="del">Delete</button>
     </div>
     <details><summary>${bp.steps.length} steps</summary><ol>${stepList(bp.steps)}</ol></details>`;

  return card;
}

/** Long tapes are trimmed: the opening is the part worth reading. */
const STEP_PREVIEW = 80;

function stepList(steps) {
  let shown = null;
  const rows = steps.slice(0, STEP_PREVIEW).map(s => {
    // Anything built before wave 1 was sent still reads as wave 1, and the
    // wave only needs saying where it changes; the rest is one block.
    const wave = Math.max(1, s.w);
    const label = wave === shown ? '' : `wave ${wave}`;
    shown = wave;
    return `<li><em>${label}</em>${escapeText(recorder.describe(s))}</li>`;
  }).join('');
  const rest = steps.length - STEP_PREVIEW;
  return rows + (rest > 0 ? `<li><em></em>… ${rest} more</li>` : '');
}

/** Blueprint names are player-typed and can be pasted in, so never trust them. */
function escapeText(text) {
  return String(text).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildTapes() {
  el('tList').addEventListener('click', ev => {
    const btn = ev.target.closest('button[data-a]');
    if (!btn) return;
    const id = btn.closest('.bp').dataset.id;

    switch (btn.dataset.a) {
      case 'play':
        actions.replay(id);
        break;
      case 'pin':
        recorder.pin(id);
        break;
      case 'rename': {
        const bp = recorder.find(id);
        const name = prompt('Name this blueprint', bp ? bp.name : '');
        if (name) recorder.rename(id, name);
        break;
      }
      case 'copy':
        copyOut(recorder.exportOne(id));
        break;
      case 'del':
        recorder.remove(id);
        break;
    }
    tapeSig = '';
    syncTapes();
    sync();
  });
}

/** Clipboard where it is allowed, a selectable prompt where it is not. */
function copyOut(text) {
  if (!text) return;
  try {
    navigator.clipboard.writeText(text).catch(() => prompt('Copy this blueprint', text));
  } catch (e) {
    prompt('Copy this blueprint', text);
  }
}

/* ── full screen ──────────────────────────────────────────────────────────
   Browsers only allow full screen from inside a tap, so phones go full
   screen when a run starts. Android then hides the address and status bars
   and can hold landscape. iOS Safari has no API for it; there the page runs
   chrome-free only when launched from the home screen (see index.html). */
const docEl = document.documentElement;

const canFullscreen = () => !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen);
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

function enterFullscreen() {
  try {
    const request = docEl.requestFullscreen || docEl.webkitRequestFullscreen;
    Promise.resolve(request.call(docEl, { navigationUI: 'hide' }))
      .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
      .catch(() => { /* refused, or orientation lock unsupported */ });
  } catch (e) { /* fullscreen unavailable */ }
}

function leaveFullscreen() {
  try {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    Promise.resolve(exit.call(document)).catch(() => {});
  } catch (e) { /* not in full screen */ }
}

/** Touch devices only: a desktop window should stay a window. */
function autoFullscreen() {
  if (!canFullscreen() || fullscreenElement()) return;
  if (!matchMedia('(pointer: coarse)').matches) return;
  // An installed app launched full screen already has no browser bars.
  if (matchMedia('(display-mode: fullscreen)').matches) return;
  enterFullscreen();
}

/* ── wiring ───────────────────────────────────────────────────────────── */
export function bind() {
  buildShop();
  buildSquad();
  buildFoundry();
  buildTapes();
  buildSectors();

  el('btnFrontier').onclick = openSectors;
  el('btnHome').onclick = () => actions.home();
  el('btnOverNext').onclick = () => { autoFullscreen(); actions.frontier(F.sector + 1); };

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

  el('btnTapes').onclick = openTapes;
  el('btnStartTapes').onclick = openTapes;
  el('tClose').onclick = closeTapes;

  el('rHold').onclick = () => { recorder.togglePlayback(); sync(); };
  el('rSkip').onclick = () => { recorder.skipStep(); sync(); };
  el('rStop').onclick = () => { recorder.stopPlayback(); sync(); };

  el('btnOverReplay').onclick = () => {
    if (recorder.rec.last) actions.replay(recorder.rec.last.id);
  };

  el('tKeep').onclick = () => {
    const bp = recorder.saveTape({ waves: S.wavesCleared, score: S.score, kills: S.kills });
    if (bp) recorder.pin(bp.id, true);
    tapeSig = '';
    syncTapes();
    sync();
  };

  el('tImport').onclick = () => {
    const text = prompt('Paste a blueprint');
    if (!text) return;
    if (!recorder.importJSON(text)) alert('That does not look like a blueprint.');
    tapeSig = '';
    syncTapes();
    sync();
  };

  el('tWipe').onclick = () => {
    if (!confirm('Delete every saved blueprint? This cannot be undone.')) return;
    recorder.clearAll();
    tapeSig = '';
    syncTapes();
    sync();
  };

  el('btnResume').onclick = () => { autoFullscreen(); actions.resume(); };
  const fromMenu = headStart => () => {
    if (S.suspended && !confirm(`End the ${S.mode === 'frontier' ? `sector ${F.sector} sortie` : `wave ${Math.max(1, S.wave)} run`} and start a new one?`)) return;
    autoFullscreen();
    actions.play({ headStart });
  };
  el('btnPlay').onclick = fromMenu(false);
  el('btnPlayHead').onclick = fromMenu(true);
  el('btnAgain').onclick = () => {
    autoFullscreen();
    if (S.mode === 'frontier') actions.frontier(F.sector);
    else actions.play({ headStart: false });
  };
  el('btnAgainHead').onclick = () => { autoFullscreen(); actions.play({ headStart: true }); };
  el('btnMenu').onclick = () => actions.menu();

  el('btnMute').onclick = () => {
    const muted = audio.toggleMute();
    el('btnMute').textContent = muted ? 'Sound off' : 'Sound on';
  };

  // iPhones have no Fullscreen API; hide the button rather than leave it dead.
  if (!canFullscreen()) el('btnFs').classList.add('hidden');
  el('btnFs').onclick = () => (fullscreenElement() ? leaveFullscreen() : enterFullscreen());
  for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(type, () => {
      el('btnFs').textContent = fullscreenElement() ? 'Exit full screen' : 'Full screen';
    });
  }

  el('fWipe').onclick = () => {
    if (!confirm('Erase all Cores, upgrades and records? This cannot be undone.')) return;
    meta.resetProfile();
    syncFoundry();
    sync();
  };

  if (!store.isPersistent()) el('warnStore').classList.remove('hidden');
  el('buildTag').textContent = `v${BUILD.version} · ${BUILD.stamp}`;

  addEventListener('keydown', ev => {
    if (ev.repeat) return;
    if (ev.key === 'Escape') {
      if (!el('foundry').classList.contains('hidden')) closeFoundry();
      else if (!el('tapes').classList.contains('hidden')) closeTapes();
      else if (!el('sectors').classList.contains('hidden')) closeSectors();
      else { S.picked = null; S.selected = null; sync(); }
      return;
    }
    if (!el('start').classList.contains('hidden') || !el('over').classList.contains('hidden')) return;
    if (!el('foundry').classList.contains('hidden')) return;
    if (!el('tapes').classList.contains('hidden')) return;

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
    else if ((ev.key === 'b' || ev.key === 'B') && S.mode !== 'frontier') { openTapes(); }
    else if (S.mode === 'frontier' && (ev.key === 'g' || ev.key === 'G')) { frontier.deploy(); sync(); }
    else if (S.mode === 'frontier' && (ev.key === 'h' || ev.key === 'H')) { actions.home(); }
  });
}
