// ============================================================
// dayEditsSmokeTests.js — v2.49.3 per-day admin edit stamps.
// ============================================================

import { changedDays, stampChangedDays, stampDays, normaliseDayEditedAt, isMissingDayEditedColumn } from "../utils/dayEdits";

export function runDayEditTests(assert) {
  const K = "2026-10-05|s1";
  const T0 = "2026-10-01T00:00:00.000Z";
  const NOW = "2026-10-07T02:00:00.000Z";
  const anela = { id: "A", day: "Thursday", start: "09:30", studentId: "sA" };
  const libby = { id: "B", day: "Wednesday", start: "10:00", studentId: "sB" };
  const jonas = { id: "J", day: "Wednesday", start: "09:00", studentId: "sJ" };
  const base = { [K]: { lessons: [jonas, libby, anela], missed: [], notes: "", dayEditedAt: { Monday: T0 } } };

  // Normalise: missing / junk → {}.
  assert("dayEdits: missing field reads as {}", normaliseDayEditedAt(undefined), {});
  assert("dayEdits: junk reads as {}", normaliseDayEditedAt([1, 2]), {});
  assert("dayEdits: keeps valid days only", normaliseDayEditedAt({ Wednesday: NOW, Funday: NOW, Thursday: 5 }), { Wednesday: NOW });

  // Move out of Wednesday into Thursday stamps BOTH days.
  const moved = { [K]: { ...base[K], lessons: [jonas, { ...libby, day: "Thursday" }, anela] } };
  assert("dayEdits: move stamps both days", changedDays(base[K], moved[K]), ["Wednesday", "Thursday"]);
  let out = stampChangedDays(base, moved, NOW);
  assert("dayEdits: move → Wed + Thu stamped, Mon kept", out[K].dayEditedAt, { Monday: T0, Wednesday: NOW, Thursday: NOW });

  // Same-day time change stamps that day only.
  const retimed = { [K]: { ...base[K], lessons: [jonas, { ...libby, start: "10:30" }, anela] } };
  assert("dayEdits: same-day move stamps one day", stampChangedDays(base, retimed, NOW)[K].dayEditedAt, { Monday: T0, Wednesday: NOW });

  // Delete a card; add a card; clear a day.
  const deleted = { [K]: { ...base[K], lessons: [jonas, anela] } };
  assert("dayEdits: delete stamps its day", Object.keys(stampChangedDays(base, deleted, NOW)[K].dayEditedAt), ["Monday", "Wednesday"]);
  const added = { [K]: { ...base[K], lessons: [...base[K].lessons, { id: "N", day: "Friday", start: "09:00" }] } };
  assert("dayEdits: add stamps its day", stampChangedDays(base, added, NOW)[K].dayEditedAt.Friday, NOW);
  const clearedDay = { [K]: { ...base[K], lessons: [anela] } };
  assert("dayEdits: clear day stamps it", stampChangedDays(base, clearedDay, NOW)[K].dayEditedAt.Wednesday, NOW);

  // Missed entries count (drop to tray).
  const toTray = { [K]: { ...base[K], lessons: [jonas, anela], missed: [{ ...libby, reason: "" }] } };
  assert("dayEdits: drop to missed stamps the day once", changedDays(base[K], toTray[K]), ["Wednesday"]);

  // A brand-new week (generate) stamps every day it fills.
  const fresh = stampChangedDays({}, { [K]: { lessons: [jonas, anela], missed: [] } }, NOW);
  assert("dayEdits: generated week stamps filled days", fresh[K].dayEditedAt, { Wednesday: NOW, Thursday: NOW });

  // Rebuilt entry without the field (generate paths) keeps old stamps.
  const rebuilt = { [K]: { lessons: [jonas, libby, anela], missed: [], notes: "" } };
  assert("dayEdits: rebuilt entry keeps stamps", stampChangedDays(base, rebuilt, NOW)[K].dayEditedAt, { Monday: T0 });

  // Notes-only change: no day stamped.
  const notes = { [K]: { ...base[K], notes: "x" } };
  assert("dayEdits: notes-only change stamps nothing", stampChangedDays(base, notes, NOW)[K].dayEditedAt, { Monday: T0 });

  // Untouched entries keep identity; no-op returns the same map.
  const two = { ...base, "2026-10-12|s1": { lessons: [], missed: [] } };
  const two2 = { ...two, [K]: moved[K] };
  assert("dayEdits: other weeks keep identity", stampChangedDays(two, two2, NOW)["2026-10-12|s1"] === two["2026-10-12|s1"], true);
  assert("dayEdits: no-op returns same map", stampChangedDays(base, base, NOW) === base, true);

  // Undo: stamps never move backwards (prev's later stamp survives).
  const afterEdit = stampChangedDays(base, moved, NOW);
  const undone = stampChangedDays(afterEdit, base, "2026-10-07T03:00:00.000Z");
  assert("dayEdits: undo re-stamps changed days, keeps later ones",
    undone[K].dayEditedAt, { Monday: T0, Wednesday: "2026-10-07T03:00:00.000Z", Thursday: "2026-10-07T03:00:00.000Z" });

  // Removed key (Clear full week) stays removed.
  const gone = stampChangedDays(base, {}, NOW);
  assert("dayEdits: cleared week not recreated", Object.keys(gone), []);

  // Confirm day (no card changes).
  assert("dayEdits: confirm stamps the day", stampDays(base, K, ["Wednesday"], NOW)[K].dayEditedAt, { Monday: T0, Wednesday: NOW });
  assert("dayEdits: confirm on missing week is a no-op", stampDays(base, "nope", ["Wednesday"], NOW) === base, true);

  // Missing-column detection.
  assert("dayEdits: PGRST204 missing column", isMissingDayEditedColumn({ code: "PGRST204", message: "Could not find the 'day_edited_at' column of 'weekly_adjustments' in the schema cache" }), true);
  assert("dayEdits: 42703 missing column", isMissingDayEditedColumn({ code: "42703", message: "column weekly_adjustments.day_edited_at does not exist" }), true);
  assert("dayEdits: other errors are not the missing column", isMissingDayEditedColumn({ code: "42703", message: "column foo does not exist" }), false);
  assert("dayEdits: null error", isMissingDayEditedColumn(null), false);
}
