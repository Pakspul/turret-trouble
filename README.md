# Turret Trouble

A tower-defence game that runs entirely in the browser — no build step, no
dependencies, no framework. It has two modes:

- **Holdout** — the grid. Enemies walk from the left gate to the right gate;
  you build turrets to stop them, wave after wave.
- **Frontier** — opens once you have held wave 100 in Holdout. Seeded maps
  with hills, cliffs and ramps; enemies that choose their own road and shoot
  back; and an enemy base on the far side that you raze with counter-waves
  of your own units. See [Frontier](#frontier) below.

The twist is the **Foundry**: holding a wave scores points on top of the gold
it pays, and those points survive the run. Between runs you spend them on
permanent upgrades — more starting gold, harder-hitting towers, and four extra
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
- **Menu** parks the run behind the title screen with a **run report**: kills
  (and how many Head Start paid out), points scored, Cores minted, leaks,
  damage and killing blows per tower type, and kills and leaks per enemy type.
  The summary screen at game over shows the same report.
- While a run is playing, the game holds a **screen wake lock** so a phone does
  not dim and sleep mid-wave. The menu, the summary and a paused run release
  it. (Browsers only grant it over HTTPS or on localhost.)

Keyboard (Frontier adds `G` deploy, `H` home and arrow/WASD scrolling): `1`–`7` pick a tower, `space` sends a wave, `P` pauses, `F` opens the
Foundry, `B` opens Blueprints, `Esc` clears the selection or closes whichever
sheet is open, `Shift+D` toggles developer mode.

### Two currencies

| | earned by | spent on | persists |
|---|---|---|---|
| **Gold** | kills, clearing waves, interest | towers and their in-run upgrades | no — resets each run |
| **Points / Cores ◈** | mostly clearing waves, plus Core Factories | Foundry upgrades | yes — banked immediately |

Points are banked the moment they are earned, so closing the tab mid-run never
costs you progress.

The two curves are shaped deliberately, and they pull against each other — the
constants live at the top of `config.js`:

- **Gold stays close to linear.** Kill gold grows by a flat 3% of its base per
  wave, wave-clear pay is `18 + 4 × wave`, and Compound Interest only earns on
  the first `300 + 40 × wave` gold you are sitting on. Nothing compounds.
- **Every turret of a kind makes the next of that kind dearer** (×1.055 each).
  Your fifth Gun is cheap; your fortieth is not. Enemy health, meanwhile,
  compounds at ×1.135 a wave. Past Prototype Cores a turret levels forever,
  but each level past 4 adds ×1.25 damage for ×1.45 the price of the last —
  so the board fills slowly, mixed builds beat spamming one type, and a run
  ends when the grid can no longer out-damage the health curve.
- **Titans trail the curve.** Every tenth wave ends with Titans (one, plus one
  more per 40 waves). Past wave 30 their health lags the wave they arrive on,
  reaching a full boss (ten waves) behind by wave 80, and they walk in 4 s
  apart. Without that, three late Titans outweighed the rest of the wave and
  every boss wave cost more breaches than Field Repair could return.
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

Thirty-seven upgrade nodes across five branches. Most of the scaling nodes
are **endless**: instead of filling up and reading "Fully upgraded" they show
their rank (`lvl 12`) and keep going, each rank costing a fixed multiple of the
last. Only Long Barrels, Reinforced Core, Overdrive and Rapid Deployment keep a
final rank, along with the one-time unlocks. Requisition compounds (−3% of
what is left), and Overcharge adds crit damage once crit chance reaches 100%.
The per-tower damage ranks and Rapid Loaders **compound** too (×1.07 a rank
rather than +7%), so a rank bought late is worth as much as the first one —
the rising price is the only brake, and the wall it builds is a slope.

- **Logistics** — Seed Capital (start with more than 240 gold), Bounty Optics,
  Wave Dividend, Compound Interest, Requisition (cheaper turrets).
- **Ordnance** — per-tower damage, Guidance Chips (faster rockets, bigger
  blast), Rapid Loaders, AP Rounds, Titan Breaker, Long Barrels, Overcharge
  (crits). **Titan Breaker** (needs wave 40) makes every second a tower spends
  firing on a Titan also strip a slice of its *maximum* health, through its
  armour — about 0.04% a tower-second at rank 1, closing in on 0.5% but never
  reaching it. Because it scales with the Titan it never falls behind the
  health curve.
- **Tech Branch** — unlocks the **Cryo** tower (pulsing slow field) and the
  **Tesla** tower (chain lightning), plus Deep Freeze, Cryo Coils (slow,
  steady Cryo growth), Capacitors, Overload Coils, Prototype Cores (level 4
  and beyond, with no cap), and Flak Warheads (Rockets hit air; needs wave 40).
  **Portal Lab** unlocks the **Portal** tower: on a long cooldown it opens a
  portal under the leading enemy in range and drops it back at the spawn
  (Titans are too heavy to send); Phase Tuning shortens that cooldown.
  **Core Factory** unlocks a passive building that deals no damage but mints
  Cores while a wave is running (0.25/s at level 1, rising with each level);
  Core Refinery adds +15% output per rank. Factories idle during the build
  phase and the break, so standing still earns nothing.
- **Command** — Reinforced Core, Field Repair, Recon Uplink, Overdrive (4×,
  then +1× per rank up to 10×, steeply priced), Rapid Deployment (−1 s break
  per rank, down to none), Head Start (each rank skips ten more opening waves
  and pays them out; needs wave 30, then 40, 50…). Once it is owned, the
  start and summary screens offer two buttons — **wave 1** or **Head start**
  — so every run is an explicit choice. Replaying a blueprint picks the same
  opening the build was recorded on, and Data Siphon.

- **Field Command** — Frontier only, and only once wave 100 is held: Drill
  Sergeants (unit damage), Composite Plating (unit health), Hardened
  Emplacements (tower health) and Forward Depots (build reach).

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

## Frontier

Holdout teaches you the towers. Frontier is where they go to war. It opens
when your best Holdout wave reaches 100 (developer mode opens it straight
away, for testing). Same towers, same prices, same Foundry, and every point
scored lands in the same Cores bank - so a sortie is also a way to fund the
next Holdout run.

**The map.** A sector is a 52 × 32 map generated from a seed: water, low
ground, hills and plateaus. Cliffs separate heights and only ramps (the
hatched cells) cross them, so the terrain decides the roads. The same sector
is the same map every time; the next sector is a new seed. Drag to scroll,
pinch or wheel to zoom, tap the minimap to jump, `H` or *Centre on HQ* to come
home. Arrow keys and WASD scroll too.

**Building.** Towers go on any land within build reach (5 cells) of your HQ
or of a tower you already own, so a line can creep outwards. Towers on high
ground get +12% range per height. Nothing can be built near the enemy base.

**Smarter enemies.** Waves leave the enemy HQ and plan their own route every
time the board changes:

- *cautious* walkers go around your towers' fields of fire when another road
  exists - build a kill zone and watch them take the long way;
- *bold* ones (Runners, Bulwarks, Titans, and a share of everyone else) take
  the short road through it;
- nothing is ever sealed in: a tower standing on the only road is simply in
  the way, and whoever reaches it stops and knocks it down.

Most enemies are armed and shoot back - Grunts and Spectres on the move,
Tanks and Titans stop to shell a tower in reach. Towers have health, are
patched back to full after every wave they survive, and are lost for good
(no refund) when destroyed. A walker that reaches your HQ knocks integrity off
it; Reinforced Core adds integrity and Field Repair patches it.

**Counter-waves.** The Barracks in the side panel buys units into a squad that
waits at your HQ. The squad marches on the enemy base when you send the next
wave (or at once, with *Deploy now*, `G`); *Disband* refunds a squad that has
not left yet. Three kinds:

| unit | role |
|---|---|
| **Trooper** | escort — fights anything hostile in reach |
| **Striker** | raider — fast, ignores enemy troops, runs for the buildings |
| **Breaker** | siege tank — slow, heavy splash, ×2.5 against structures |

A unit is issued at the current threat, so late recruits are stronger and
dearer; the in-run **Armory** multiplies the kit of every unit fielded after
it. At most 16 units can be out or queued at once.

**The enemy base** is static for now: an HQ and a ring of bunkers on the
approach roads, sized by sector. It never rebuilds, and your units grow with
every wave while it does not - sector 1 ripens around wave 10, each sector
after holds two waves longer. Raze the HQ to win the sector, bank its bounty,
and open the next one. Sector *s* plays at Holdout depth 10 × *s*: its wave 1
has the health, gold and points of Holdout wave 10*s* + 1, and opens with a
war chest of the six waves before it.

The knobs live in the Frontier block of `config.js`, and a scripted sortie
prints its curve with:

```bash
npm run probe:frontier
```

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
npm test        # headless: economy, pathing, unlocks, persistence, replay, Frontier
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
    terrain.js            Frontier: seeded map generation and the route planner
    frontier.js           Frontier: the simulation (towers, units, bases)
    frontier-render.js    Frontier: camera, terrain painting, minimap
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
  frontier.mjs            terrain, routing, fire-back, units and victory; --probe
docs/
  ROADMAP.md              agreed-in-spirit design notes not built yet
archive/
  grid-siege-v1.html      the original single-file version, kept for reference
```

The dependency direction is one-way: `config` → `field`/`terrain`/`meta`/
`recorder` → `game` → `frontier` → `render`/`frontier-render`/`ui` → `main`.
Both simulations share the run state `S` (gold, score, the wave clock, speed,
projectiles), which is how the side panel, the Foundry and the menus serve
both modes; `S.mode` says which one is driving. Frontier keeps its own board,
units and bases on `F`, and reuses Holdout's tower maths and turret drawings
so a Gun is the same Gun in both. `recorder.js` never imports the simulation:
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
