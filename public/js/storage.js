/* ══ persistence ═════════════════════════════════════════════════════════
   localStorage, wrapped so that a private window or a browser with site
   data blocked degrades to an in-memory profile instead of throwing.     */

const KEY = 'turret-trouble:profile:v1';

let memoryFallback = null;
let usable = true;

function raw() {
  try {
    return window.localStorage;
  } catch (e) {
    usable = false;
    return null;
  }
}

/** True when the profile survives a reload. */
export function isPersistent() {
  return usable;
}

export function load() {
  const store = raw();
  if (!store) return memoryFallback;
  try {
    const text = store.getItem(KEY);
    return text ? JSON.parse(text) : null;
  } catch (e) {
    usable = false;
    return memoryFallback;
  }
}

export function save(profile) {
  memoryFallback = profile;
  const store = raw();
  if (!store) return false;
  try {
    store.setItem(KEY, JSON.stringify(profile));
    return true;
  } catch (e) {
    usable = false;
    return false;
  }
}

export function wipe() {
  memoryFallback = null;
  const store = raw();
  if (!store) return;
  try {
    store.removeItem(KEY);
  } catch (e) {
    usable = false;
  }
}
