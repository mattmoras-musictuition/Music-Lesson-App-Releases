// ============================================================
// BANDS SYNC SMOKE TESTS
// v2.41.2. Characterizes every band write path through the pure helpers in
// utils/bandsSync.js: the row mappers, BandsManager's Save/Delete list
// changes, and the Supabase write plan. v2.41.2 replaced the whole-list
// upsert + sweep with per-row writes: only the saved band is upserted.
// ============================================================

import { rowToBand, bandToRow, applyBandSave, applyBandDelete, planBandUpsert } from "../utils/bandsSync";

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

  // ── Per-row write plan (v2.41.2; replaced the whole-list upsert + sweep) ──
  assert("bandsSync: per-row plan is null when signed out", planBandUpsert(band("b"), null), null);
  assert("bandsSync: per-row plan is null without an id", planBandUpsert({ name: "x" }, ADMIN), null);
  assert("bandsSync: per-row plan writes ONLY the saved band, stamped admin",
    planBandUpsert(band("b", { name: "B2" }), ADMIN), bandToRow(band("b", { name: "B2" }), ADMIN));
  assert("bandsSync: per-row plan re-owns a teacher-created band",
    planBandUpsert(rowToBand(row), ADMIN).user_id, ADMIN);
}
