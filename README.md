# Turret Trouble

A grid tower-defence game that runs entirely in the browser — no build step, no
dependencies, no framework. Enemies walk from the left gate to the right gate;
you build turrets to stop them.

The twist is the **Foundry**: holding a wave scores points on top of the gold
it pays, and those points survive the run. Between runs you spend them on
permanent upgrades — more starting gold, harder-hitting towers, and two extra
tower types.

## Playing

- **Click a tower**, then click a cell to place it. You can never fully wall the
  exit off; illegal placements are marked with a red cross.
- **Click a placed tower** to see its stats, upgrade it, sell it, or **swap it
  for another type**. Swapping charges the new turret's price less a full
  refund on the old one, so trading a Gun for a Tesla costs the difference and
  trading back pays you the difference.
- **Selling always refunds 100%** of what a tower cost, upgrades included.
  Repositioning is free; only the escalating price of *new* turrets costs you.
- **Send wave** early for a bonus, or let the break timer run out.
- **Foundry** spends banked points. It pauses the run while it is open.

Keyboard: `1`–`5` pick a tower, `space` sends a wave, `P` pauses, `F` opens the
Foundry, `Esc` clears the selection or closes the Foundry, `Shift+D` toggles
developer mode.

### Two currencies

| | earned by | spent on | persists |
|---|---|---|---|
| **Gold** | kills, clearing waves, interest | towers and their in-run upgrades | no — resets each run |
| **Points / Cores ◈** | mostly clearing waves | Foundry upgrades | yes — banked immediately |

Points are banked the moment they are earned, so closing the tab mid-run never
costs you progress.

The two curves are shaped deliberately, and they pull against each other — the
constants live at the top of `config.js`:

- **Gold stays close to linear.** Kill gold grows by a flat 3% of its base per
  wave, wave-clear pay is `18 + 4 × wave`, and Compound Interest only earns on
  the first `300 + 40 × wave` gold you are sitting on. Nothing compounds.
- **Every turret of a kind makes the next of that kind dearer** (×1.055 each).
  Your fifth Gun is cheap; your fortieth is not. Enemy health, meanwhile,
  compounds at ×1.135 a wave and a turret tops out at level 4 — so the board
  fills slowly, mixed builds beat spamming one type, and a run ends when the
  grid can no longer out-damage the health curve.
- **Points are back-loaded.** Kills pay a thin flat trickle; the real income is
  `0.7 × wave^1.6` for *holding* a wave. Farming shallow waves gets you
  nowhere, so the Foundry is funded by depth, not by time spent.

`npm run balance` plays the whole thing headlessly and prints the resulting
curve, so a change to any of those numbers can be compared against the last
one:

```bash
npm run balance -- 60 none    # 60 waves, fresh profile
npm run balance -- 80 mid     # half the Foundry bought
npm run balance -- 90 full    # everything bought
```

### Developer mode

`Shift+D`, or `?dev` on the URL, adds a **10× step** to the speed button and
shows a badge in the panel. The setting is remembered in `localStorage`; press
`Shift+D` again to drop it, which also drops the run back to 1×.

### The Foundry

Twenty-four upgrade nodes across four branches:

- **Logistics** — Seed Capital (start with more than 240 gold), Bounty Optics,
  Wave Dividend, Compound Interest, Requisition (cheaper turrets).
- **Ordnance** — per-tower damage, Guidance Chips (faster rockets, bigger
  blast), Rapid Loaders, AP Rounds, Long Barrels, Overcharge (crits).
- **Tech Branch** — unlocks the **Cryo** tower (pulsing slow field) and the
  **Tesla** tower (chain lightning), plus Deep Freeze, Capacitors, Overload
  Coils, and Prototype Cores (tower level 4).
- **Command** — Reinforced Core, Field Repair, Recon Uplink, Overdrive (4×
  speed), and Data Siphon.

Progress lives in `localStorage` under `turret-trouble:profile:v1`. "Reset
progress" in the Foundry footer wipes it.

## Running locally

```bash
npm start            # http://localhost:8080
npm run dev:local    # http://localhost:3000, for when 8080 is taken
```

`server.js` is a zero-dependency static file server. There is nothing to
install — `npm install` has no work to do.

Port 8080 is a popular default (Tomcat, Jenkins, Nexus and friends all want
it). On Windows a clash surfaces as `EACCES`, not the `EADDRINUSE` you would
expect — Windows reports a collision with an exclusively-bound socket as a
permission error. `dev:local` sidesteps it. To pick the port yourself:

```bash
PORT=5000 npm start               # bash
$env:PORT=5000; npm start         # PowerShell
```

Avoid guessing a neighbouring port: if the process holding it bound with
`SO_REUSEADDR`, `server.js` starts cleanly and logs its usual banner while the
*other* server quietly answers the requests. `npm start` failing loudly is the
better outcome.

```bash
npm run check   # parse every module
npm test        # headless simulation: economy, pathing, unlocks, persistence
npm run balance # headless balance probe, prints the per-wave curve
```

## Layout

```
server.js                 static file server (the only Node code)
web.config                IIS/iisnode config, Windows App Service only
public/
  index.html              markup shell
  css/styles.css
  js/
    config.js             grid constants, tower/enemy/Foundry catalogues
    storage.js            localStorage wrapper with an in-memory fallback
    meta.js               Foundry state and the derived modifier bundle
    field.js              grid occupancy and the BFS flow field
    waves.js              wave composition
    audio.js              synthesised sound cues
    game.js               the simulation; owns all run state
    render.js             canvas drawing and the grid-to-pixel projection
    ui.js                 every DOM read and write
    main.js               input, the frame loop, and wiring
    package.json          marks the folder as ESM for Node tooling
test/
  smoke.mjs               headless run of the simulation, no DOM required
  balance.mjs             plays a full run and prints the economy curve
archive/
  grid-siege-v1.html      the original single-file version, kept for reference
```

The dependency direction is one-way: `config` → `field`/`meta` → `game` →
`render`/`ui` → `main`. `game.js` never touches the DOM; it exposes a single
`S.onChange` hook that `main.js` points at the UI.

## Deploying

See [DEPLOY.md](DEPLOY.md) for Azure Web App setup.
