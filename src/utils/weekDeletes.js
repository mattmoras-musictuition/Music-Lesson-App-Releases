// ============================================================
// weekDeletes.js — "Clear full week" really deletes (v2.49.3).
// Pure, no state.
//
// The weekly sync is upsert-only, so dropping a week from memory never
// removed its weekly_adjustments row and the week came back on the next
// load. A full-week clear now records the key as cleared; each sync asks
// planWeekDeletes which cleared keys still need a server delete.
//
//   • cleared + absent from the map + not yet deleted → delete it
//   • cleared + present again (Undo, or a fresh row arrived) → restored:
//     the normal upsert saves it, and a later absence (Redo) deletes again
//
// Only keys the owner explicitly cleared are ever deleted. The 52-week
// prune in App.js drops keys from memory too, and those must never reach
// the server as deletes (that would wipe Tally history).
//
// Poll guard: a poll whose fetch started before a delete completed can
// return the deleted row. pollShouldSkipKey drops such rows, and rows for
// a cleared key whose delete has not landed yet.
// ============================================================

export function planWeekDeletes({ clearedKeys, serverDeleted, weeklyTimetables }) {
  const toDelete = [];
  const restored = [];
  const map = weeklyTimetables || {};
  for (const k of clearedKeys || []) {
    if (Object.prototype.hasOwnProperty.call(map, k)) restored.push(k);
    else if (!(serverDeleted && serverDeleted.has(k))) toDelete.push(k);
  }
  return { toDelete, restored };
}

// pendingDeletes: keys cleared locally whose server delete has not landed.
// tombstones: { key: pollSeq at the moment the delete completed }.
export function pollShouldSkipKey(key, pollSeq, pendingDeletes, tombstones) {
  if (pendingDeletes && pendingDeletes.has(key)) return true;
  const t = tombstones ? tombstones[key] : undefined;
  return t !== undefined && pollSeq <= t;
}

// Startup: keys whose delete never landed (offline, app closed) stay out of
// the loaded map so they do not flash back before the retry deletes them.
export function withoutPendingDeletes(weeklyTimetables, pendingKeys) {
  if (!pendingKeys || pendingKeys.length === 0) return weeklyTimetables;
  const out = { ...(weeklyTimetables || {}) };
  for (const k of pendingKeys) delete out[k];
  return out;
}

export function splitStorageKey(key) {
  const i = key.indexOf("|");
  return { weekKey: key.substring(0, i), schoolId: key.substring(i + 1) };
}

// Keys cleared, not yet deleted on the server, and not back in the map.
export function pendingWeekDeleteKeys(clearedKeys, serverDeleted, weeklyTimetables) {
  const map = weeklyTimetables || {};
  return [...(clearedKeys || [])].filter(k =>
    !(serverDeleted && serverDeleted.has(k)) && !Object.prototype.hasOwnProperty.call(map, k));
}

// Durable pending list (localStorage) so an offline clear survives a restart.
export const WTT_PENDING_DELETES_KEY = "mt-wtt-pending-deletes";
export function readPendingWeekDeletes() {
  try { const v = JSON.parse(localStorage.getItem(WTT_PENDING_DELETES_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
export function writePendingWeekDeletes(keys) {
  try { localStorage.setItem(WTT_PENDING_DELETES_KEY, JSON.stringify([...new Set(keys || [])])); } catch (e) { /* best effort */ }
}
