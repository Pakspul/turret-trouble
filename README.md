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
- **Blueprints** replays a build you have already worked out, so a run that
  ended badly does not have to be re-clicked from scratch.

Keyboard: `1`–`5` pick a tower, `space` sends a wave, `P` pauses, `F` opens the
Foundry, `B` opens Blueprints, `Esc` clears the selection or closes whichever
sheet is open, `Shift+D` toggles developer mode.

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

### Blueprints

The opening of a run is the same every time, so the game records it for you.
Every placement, swap, upgrade and sale goes onto a tape tagged with the wave
it happened on, and when the run ends — broken or abandoned — the tape is saved
as a **blueprint**. **Replay this build** on the summary screen, or `B` for the
library, hands that build order back to an autopilot on your next run.

A replay is a build order, not a recording of a match. Waves are random, so the
same clicks never produce the same run twice; what a blueprint reproduces is
*what you built, where, and how deep into the run*:

- A step never runs before the wave it was recorded on. Building at wave 12
  still happens at wave 12.
- Steps run in order and wait for the gold, exactly as your hands did. The
  panel says what it is saving for, and **Skip** jumps a step you no longer
  want to pay for.
- A step the board cannot take — a locked tower, a cell already occupied, a
  placement that would seal the exit — is skipped after a few seconds rather
  than stalling the rest of the build.
- Anything you do by hand mid-replay is recorded too, so a replay you extend
  saves as the longer blueprint. **Pause** and **Stop** hand the board back at
  any point.

The library keeps twelve blueprints. The five most recent runs are kept
automatically and pruned as new ones arrive; **Pin** takes one out of that
rotation for good. **Copy** puts a blueprint on the clipboard as JSON and
**Import** takes one back, so a build can move between browsers.

Blueprints live in `localStorage` under `turret-trouble:blueprints:v1`, separate
from the Foundry profile — resetting progress leaves your builds alone, and
"Delete all" in the blueprint footer wipes those without touching your Cores.

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
npm test        # headless: economy, pathing, unlocks, persistence, replay
npm run balance # headless balance probe, prints the per-wave curve
```

## Layout

```
server.js                 static file server (the only Node code)
web.config                IIS/iisnode config, Windows App Service only
public/
  index.html              markup shell
  staticwebapp.config.json  Azure Static Web Apps routing, MIME and cache rules
  css/styles.css
  js/
    config.js             grid constants, tower/enemy/Foundry catalogues
    storage.js            localStorage wrapper with an in-memory fallback
    meta.js               Foundry state and the derived modifier bundle
    recorder.js           build-order tapes, the blueprint library, replay
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
  recorder.mjs            headless test of recording, replay and its limits
  balance.mjs             plays a full run and prints the economy curve
archive/
  grid-siege-v1.html      the original single-file version, kept for reference
```

The dependency direction is one-way: `config` → `field`/`meta`/`recorder` →
`game` → `render`/`ui` → `main`. `recorder.js` never imports the simulation:
`game.js` hands itself over with `bindGame()`, the same trick `bindProjection()`
uses for the renderer. `game.js` never touches the DOM; it exposes a single
`S.onChange` hook that `main.js` points at the UI.

## Deploying

Every push to `main` deploys to **Azure Static Web Apps** — the game is
entirely client-side, so `public/` is the whole deployment and `server.js`
never runs in production. Setup needs one secret and takes about five minutes.

An **Azure App Service** path is also wired up, for the case where you want
`server.js` actually running (health probe, room for server-side code). It is
manual-trigger only so the two do not race.

See [DEPLOY.md](DEPLOY.md) for both.
