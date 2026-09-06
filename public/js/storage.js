/* ══ persistence ═════════════════════════════════════════════════════════
   localStorage, wrapped so that a private window or a browser with site
   data blocked degrades to an in-memory store instead of throwing.

   Two things are saved under their own keys: the Foundry profile, and the
   blueprint library (see recorder.js). `load`/`save`/`wipe` are the
   profile's; `read`/`write`/`remove` are the generic pair everything else
   uses.                                                                 */

const PROFILE_KEY = 'turret-trouble:profile:v1';

/** Whatever has been written this session, in case localStorage is shut. */
const memory = new Map();
let usable = true;

function raw() {
  try {
    return window.localStorage;
  } catch (e) {
    usable = false;
    return null;
  }
}

/** True when what we write survives a reload. */
export function isPersistent() {
  return usable;
}

export function read(key) {
  const store = raw();
  if (!store) return memory.has(key) ? memory.get(key) : null;
  try {
    const text = store.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch (e) {
    usable = false;
    return memory.has(key) ? memory.get(key) : null;
  }
}

export function write(key, value) {
  memory.set(key, value);
  const store = raw();
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    // A quota error is not a reason to call storage unusable outright, but
    // the caller does need to know the write did not land.
    return false;
  }
}

export function remove(key) {
  memory.delete(key);
  const store = raw();
  if (!store) return;
  try {
    store.removeItem(key);
  } catch (e) {
    usable = false;
  }
}

/* ── the Foundry profile ──────────────────────────────────────────────── */
export const load = () => read(PROFILE_KEY);
export const save = profile => write(PROFILE_KEY, profile);
export const wipe = () => remove(PROFILE_KEY);
