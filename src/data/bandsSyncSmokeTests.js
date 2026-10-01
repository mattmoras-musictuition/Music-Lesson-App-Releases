// ============================================================
// BANDS SYNC SMOKE TESTS
// v2.41.2. Characterizes every band write path through the pure helpers in
// utils/bandsSync.js: the row mappers, BandsManager's Save/Delete list
// changes, and the whole-list Supabase sync plan.
// ============================================================

import { rowToBand, bandToRow, applyBandSave, applyBandDelete, planWholeListSync } from "../utils/bandsSync";

const ADMIN = "daf539a2-ec67-45e5-8533-a3a5beb5b9e5";
const TEACHER = "teacher-user-uuid";

const band = (id, extra = {}) => ({
  id, name: id, schoolId: "S", teacherId: "", teacherInstrument: "",
  personnel: [], members: [], links: [], notes: "", ...extra,
});

export function runBandsSyncCharacterizationTests(assert) {
  // ── Mappers ──
  const row = { id: "b1", user_id: TEACHER, name: "Riptide", school_id: "S", teacher_id: "t1", teacher_instrument: "Guitar",
    personnel: [{ teacherId: "t1", instrument: "Guitar" }], members: [{ id: "m1", studentId: "s1", instrument: "Drums" }],
    links: [{ id: "l1", url: "u" }], notes: "n", created_at: "x" };
  assert("bandsSync: rowToBand maps the allow-listed columns only", rowToBand(row), {
    id: "b1", name: "Riptide", schoolId: "S", teacherId: "t1", teacherInstrument: "Guitar",
    personnel: [{ teacherId: "t1", instrument: "Guitar" }], members: [{ id: "m1", studentId: "s1", instrument: "Drums" }],
    links: [{ id: "l1", url: "u" }], notes: "n" });
  assert("bandsSync: rowToBand defaults nulls", rowToBand({ id: "b2" }), {
    id: "b2", name: "", schoolId: "", teacherId: "", teacherInstrument: "", personnel: [], members: [], links: [], notes: "" });
  assert("bandsSync: bandToRow stamps the given user_id (re-owns a teacher band)", bandToRow(rowToBand(row), ADMIN), {
    id: "b1", user_id: ADMIN, name: "Riptide", school_id: "S", teacher_id: "t1", teacher_instrument: "Guitar",
    personnel: [{ teacherId: "t1", instrument: "Guitar" }], members: [{ id: "m1", studentId: "s1", instrument: "Drums" }],
    links: [{ id: "l1", url: "u" }], notes: "n" });
  assert("bandsSync: bandToRow defaults missing fields", bandToRow({ id: "b3" }, ADMIN), {
    id: "b3", user_id: ADMIN, name: "", school_id: "", teacher_id: "", teacher_instrument: "", personnel: [], members: [], links: [], notes: "" });

  // ── BandsManager list changes ──
  const list = [band("a"), band("b"), band("c")];
  assert("bandsSync: Save new appends", applyBandSave(list, band("d"), true).map(b => b.id), ["a", "b", "c", "d"]);
  assert("bandsSync: Save edit replaces in place",
    applyBandSave(list, band("b", { name: "B2" }), false).map(b => b.id + ":" + b.name), ["a:a", "b:B2", "c:c"]);
  assert("bandsSync: Save edit leaves other entries the same objects",
    applyBandSave(list, band("b", { name: "B2" }), false)[0] === list[0], true);
  assert("bandsSync: Delete removes only that id", applyBandDelete(list, "b").map(b => b.id), ["a", "c"]);
  assert("bandsSync: Delete of unknown id is a no-op", applyBandDelete(list, "zz").map(b => b.id), ["a", "b", "c"]);
  assert("bandsSync: list helpers never mutate the input", list.map(b => b.id + ":" + b.name), ["a:a", "b:b", "c:c"]);

  // ── Whole-list sync plan (the behaviour v2.41.2 replaces) ──
  assert("bandsSync: whole-list plan is null when signed out", planWholeListSync(list, null), null);
  const plan = planWholeListSync(list, ADMIN);
  assert("bandsSync: whole-list plan upserts EVERY band in memory", plan.upsertRows.map(r => r.id), ["a", "b", "c"]);
  assert("bandsSync: whole-list plan stamps admin on every row", plan.upsertRows.every(r => r.user_id === ADMIN), true);
  assert("bandsSync: whole-list plan sweeps admin rows not in memory", plan.deleteSweep, { ownedBy: ADMIN, keepIds: ["a", "b", "c"] });
  assert("bandsSync: whole-list plan skips the sweep for an empty list", planWholeListSync([], ADMIN), { upsertRows: [], deleteSweep: null });
}
