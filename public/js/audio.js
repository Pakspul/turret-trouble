/* ══ audio ═══════════════════════════════════════════════════════════════
   Tiny synthesised blips. No assets, no library, and every call is safe to
   make before the user has interacted with the page.                     */

let ctx = null;
let muted = false;

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = !!value;
  return muted;
}

export function toggleMute() {
  return setMuted(!muted);
}

/** Browsers only allow an AudioContext after a gesture, so nudge it then. */
export function unlock() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) { /* audio unavailable */ }
}

export function blip(freq, dur, type, vol) {
  if (muted) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  } catch (e) { /* audio unavailable */ }
}

/** Named cues, so callers do not sprinkle magic numbers everywhere. */
export const sfx = {
  place:   () => blip(430, 0.05, 'triangle', 0.035),
  sell:    () => blip(280, 0.06, 'triangle', 0.030),
  upgrade: () => blip(620, 0.07, 'triangle', 0.040),
  deny:    () => blip(120, 0.09, 'square', 0.040),
  wave:    () => blip(520, 0.07, 'square', 0.050),
  rocket:  () => blip(190, 0.07, 'square', 0.030),
  blast:   () => blip(110, 0.16, 'sawtooth', 0.045),
  arc:     () => blip(880, 0.05, 'square', 0.022),
  freeze:  () => blip(1180, 0.06, 'sine', 0.020),
  breach:  () => blip(90, 0.30, 'sawtooth', 0.070),
  boss:    () => blip(140, 0.35, 'sawtooth', 0.080),
  kill:    () => blip(300 + Math.random() * 120, 0.05, 'triangle', 0.025),
  buy:     () => blip(760, 0.10, 'triangle', 0.045)
};
