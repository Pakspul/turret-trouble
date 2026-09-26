# Roadmap notes

Design notes that are agreed in spirit but not built yet. Keep the *why*
here so the next change starts from the same understanding.

## Frontier (and later modes) should carry the player past Holdout's walls

**Status:** open · raised after the wave-90 Titan wall (see "Why" below)

### The problem

Holdout is built on two curves that pull apart on purpose: enemy health
compounds at ×1.135 a wave, while gold stays close to linear and every
Foundry rank costs a fixed multiple of the last. That guarantees a wall. The
wave-90 balance pass (compounding damage ranks, Titan Breaker, Titans that
trail the health curve) turned the stonewall into a slope, but a slope still
ends: past some wave, grinding Holdout buys a fraction of a wave per rank.

### What we do *not* want

**No prestige/reset layer.** "Start over and do everything the same again to
get a couple of waves further" is exactly the loop we are avoiding. Progress
should come from playing something *different*, not from repeating Holdout.

### The idea

Holdout waves → hit a soft wall → go play **Frontier** (or another future
mode) for a while → what you earn there lets you come back and blast through
the next ~30–50 Holdout waves → the next soft wall → another stint elsewhere.
Each mode gives the player more game to play instead of a brick wall.

The key ingredient is a **separate currency per mode** that develops
differently in each place:

- Frontier pays its own reward (working name *Salvage*) for razing sectors,
  on its own curve.
- Salvage buys upgrades whose effect is **big in Holdout** — multiplicative
  Holdout-only boosts, e.g. global tower damage ×1.1x per rank, Titan damage,
  extra breaches — and **small or nil in Frontier**.
- That asymmetry is deliberate: it stops a feedback loop where Frontier makes
  you stronger in Frontier, which earns more Salvage, which makes you stronger
  again (the "weird compound effect"). Each mode feeds the *other* one.
- The reverse could hold too: Holdout Cores could mostly buy Frontier-relevant
  things, so neither mode can be farmed in isolation.

### Open questions

- **Unlock point.** Frontier currently opens at Holdout wave 100
  (`FRONTIER_UNLOCK_WAVE`), which sits *behind* the wall it is meant to help
  with. It should open where the first real wall is — somewhere around wave
  60–70 — or after the first wall the player actually hits (e.g. a run that
  dies on a boss wave).
- **Exchange rate.** How many Holdout waves should one Frontier sector be
  worth? A target like "one sector ≈ 3–5 Holdout waves of progress" gives a
  way to tune Salvage prices against `hpMul` (×3.55 per ten waves).
- **Scaling of the Salvage upgrades.** Multiplicative, so they keep pace with
  exponential health, but with prices that make each wall feel like a
  destination rather than an instant skip.
- **Future modes** should plug into the same pattern: their own currency,
  spent mostly on the modes they are *not*.

### Why (numbers from the wave-90 investigation)

- A wave-90 Titan had ~100M HP; three of them arrived together, so each boss
  wave cost 2–3 breaches while Field Repair returned one every 8 waves.
- Linear +7% damage ranks at ~500k Cores bought ~2.9% damage — about 0.2 of
  a wave — for 10–15 full runs of income.
