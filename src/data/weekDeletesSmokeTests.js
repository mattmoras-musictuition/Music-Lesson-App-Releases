// ============================================================
// weekDeletesSmokeTests.js — v2.49.3 "Clear full week" really deletes.
// ============================================================

import { planWeekDeletes, pollShouldSkipKey, withoutPendingDeletes, splitStorageKey, pendingWeekDeleteKeys } from "../utils/weekDeletes";

export function runWeekDeleteTests(assert) {
  const A = "2026-10-12|s1";
  const B = "2026-12-14|s1";
  const OLD = "2025-10-06|s1";
  const entry = { lessons: [{ id: "L1" }], missed: [] };

  // A cleared week absent from the map is owed a delete.
  let p = planWeekDeletes({ clearedKeys: new Set([A]), serverDeleted: new Set(), weeklyTimetables: { [B]: entry } });
  assert("weekDeletes: cleared + absent → delete", p, { toDelete: [A], restored: [] });

  // Already deleted on the server → nothing more to do.
  p = planWeekDeletes({ clearedKeys: new Set([A]), serverDeleted: new Set([A]), weeklyTimetables: {} });
  assert("weekDeletes: cleared + already deleted → no delete", p, { toDelete: [], restored: [] });

  // Undo brought it back → restored (the normal upsert saves it).
  p = planWeekDeletes({ clearedKeys: new Set([A]), serverDeleted: new Set([A]), weeklyTimetables: { [A]: entry } });
  assert("weekDeletes: cleared + present again (Undo) → restored", p, { toDelete: [], restored: [A] });

  // A key dropped from memory without a clear (52-week prune) is never deleted.
  p = planWeekDeletes({ clearedKeys: new Set([A]), serverDeleted: new Set(), weeklyTimetables: {} });
  assert("weekDeletes: pruned/absent but never cleared → untouched", p.toDelete, [A]);
  assert("weekDeletes: pruned key not in the delete list", p.toDelete.includes(OLD), false);
  p = planWeekDeletes({ clearedKeys: new Set(), serverDeleted: new Set(), weeklyTimetables: {} });
  assert("weekDeletes: nothing cleared → nothing deleted", p, { toDelete: [], restored: [] });

  // Clear → delete → Undo → Redo: the Redo deletes again.
  const cleared = new Set([A]);
  const deleted = new Set();
  let step = planWeekDeletes({ clearedKeys: cleared, serverDeleted: deleted, weeklyTimetables: {} });
  step.toDelete.forEach(k => deleted.add(k));
  step = planWeekDeletes({ clearedKeys: cleared, serverDeleted: deleted, weeklyTimetables: { [A]: entry } });
  step.restored.forEach(k => deleted.delete(k));
  assert("weekDeletes: Undo after delete → restored, not deleted", step, { toDelete: [], restored: [A] });
  step = planWeekDeletes({ clearedKeys: cleared, serverDeleted: deleted, weeklyTimetables: {} });
  assert("weekDeletes: Redo after Undo → deleted again", step.toDelete, [A]);

  // Missing inputs never throw.
  assert("weekDeletes: missing inputs safe", planWeekDeletes({}), { toDelete: [], restored: [] });

  // Poll guard.
  assert("weekDeletes: poll skips a key whose delete is owed", pollShouldSkipKey(A, 5, new Set([A]), {}), true);
  assert("weekDeletes: poll skips a copy fetched before the delete landed", pollShouldSkipKey(A, 7, new Set(), { [A]: 7 }), true);
  assert("weekDeletes: poll started after the delete takes a new row", pollShouldSkipKey(A, 8, new Set(), { [A]: 7 }), false);
  assert("weekDeletes: poll ignores keys never cleared", pollShouldSkipKey(B, 1, new Set([A]), { [A]: 9 }), false);
  assert("weekDeletes: poll guard tolerates missing sets", pollShouldSkipKey(A, 1, null, null), false);

  // Load filter.
  const loaded = { [A]: entry, [B]: entry };
  assert("weekDeletes: load drops owed deletes", Object.keys(withoutPendingDeletes(loaded, [A])), [B]);
  assert("weekDeletes: load filter leaves the input unchanged", Object.keys(loaded).length, 2);
  assert("weekDeletes: no pending → same map", withoutPendingDeletes(loaded, []) === loaded, true);

  // Pending list (persisted, and used by the poll guard).
  assert("weekDeletes: pending = cleared, not deleted, not present",
    pendingWeekDeleteKeys(new Set([A, B, OLD]), new Set([B]), { [OLD]: entry }), [A]);
  assert("weekDeletes: pending tolerates missing inputs", pendingWeekDeleteKeys(null, null, null), []);

  assert("weekDeletes: split storage key", splitStorageKey(A), { weekKey: "2026-10-12", schoolId: "s1" });
}
