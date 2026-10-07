// ============================================================
// dayEdits.js — per-day admin edit stamps (v2.49.3). Pure, no state.
//
// Each weekly entry carries dayEditedAt: { "<Day>": ISO timestamp }, saved in
// weekly_adjustments.day_edited_at. It records when the admin last changed a
// day's lessons or missed entries, so a later drain (v4, draft) can let the
// admin's day win over an older teacher copy.
//
// Stamping is central: App.js's setWeeklyTimetables runs stampChangedDays on
// every admin change, comparing each day's cards before and after. A move
// changes two days, so both are stamped. Days that did not change keep their
// old stamp, and a stamp is never dropped because a call site rebuilt the
// entry without it (stamps carry forward from the previous entry).
//
// NOT stamped: the poll adopting a server copy, the initial load, and
// display-only paths (they never call the setter).
// ============================================================

export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// A row lacking the field (or holding junk) reads as {}.
export function normaliseDayEditedAt(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out = {};
  for (const [day, ts] of Object.entries(v)) {
    if (DAY_NAMES.includes(day) && typeof ts === "string" && ts) out[day] = ts;
  }
  return out;
}

function dayFingerprint(entry, day) {
  const lessons = ((entry && entry.lessons) || []).filter(l => l && l.day === day);
  const missed = ((entry && entry.missed) || []).filter(m => m && m.day === day);
  if (lessons.length === 0 && missed.length === 0) return "";
  return JSON.stringify([lessons, missed]);
}

// Days whose lessons or missed entries differ between two versions of an entry.
export function changedDays(prevEntry, nextEntry) {
  if (!nextEntry) return [];
  if (prevEntry && prevEntry.lessons === nextEntry.lessons && prevEntry.missed === nextEntry.missed) return [];
  return DAY_NAMES.filter(day => dayFingerprint(prevEntry, day) !== dayFingerprint(nextEntry, day));
}

// Later of two ISO stamps (either may be missing).
function laterIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

// Returns `next` with dayEditedAt stamped on every changed day of every
// changed entry. Unchanged entries keep their object identity. Stamps from
// the previous entry carry forward so a rebuilt entry never loses them.
export function stampChangedDays(prev, next, nowIso) {
  if (!next || next === prev) return next;
  let out = next;
  for (const key of Object.keys(next)) {
    const nextEntry = next[key];
    const prevEntry = prev ? prev[key] : undefined;
    if (!nextEntry || nextEntry === prevEntry) continue;
    const carried = { ...normaliseDayEditedAt(prevEntry && prevEntry.dayEditedAt) };
    for (const [day, ts] of Object.entries(normaliseDayEditedAt(nextEntry.dayEditedAt))) carried[day] = laterIso(carried[day], ts);
    for (const day of changedDays(prevEntry, nextEntry)) carried[day] = nowIso;
    const before = normaliseDayEditedAt(nextEntry.dayEditedAt);
    if (JSON.stringify(before) === JSON.stringify(carried) && nextEntry.dayEditedAt) continue;
    if (out === next) out = { ...next };
    out[key] = { ...nextEntry, dayEditedAt: carried };
  }
  return out;
}

// Explicit stamp for actions that change no cards (Confirm day).
export function stampDays(weeklyTimetables, key, days, nowIso) {
  const entry = weeklyTimetables && weeklyTimetables[key];
  if (!entry || !days || days.length === 0) return weeklyTimetables;
  const stamps = { ...normaliseDayEditedAt(entry.dayEditedAt) };
  for (const d of days) if (DAY_NAMES.includes(d)) stamps[d] = nowIso;
  return { ...weeklyTimetables, [key]: { ...entry, dayEditedAt: stamps } };
}

// Supabase reports a missing column as PostgREST PGRST204 (schema cache) or
// Postgres 42703 (undefined_column).
export function isMissingDayEditedColumn(error) {
  if (!error) return false;
  const msg = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`;
  return (error.code === "PGRST204" || error.code === "42703") && msg.includes("day_edited_at");
}
