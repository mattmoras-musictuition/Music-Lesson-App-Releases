// ============================================================
// BANDS SYNC SMOKE TESTS
// v2.41.2. Characterizes every band write path through the pure helpers in
// utils/bandsSync.js: the row mappers, BandsManager's Save/Delete list
// changes, and the Supabase write plan. v2.41.2 replaced the whole-list
// upsert + sweep with per-row writes: only the saved band is upserted.
// ============================================================

import { rowToBand, bandToRow, applyBandSave, applyBandDelete, planBandUpsert, reconcileBands, isStaleBandsRefresh } from "../utils/bandsSync";

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

  // ── Refresh reconcile (v2.41.2 freshness) ──
  const local = [band("a"), band("b", { name: "admin-old" }), band("c")];
  const ids = (l) => l.map(b => b.id + ":" + b.name).join(",");
  assert("bandsSync: refresh — server wins for untouched rows (teacher edit appears)",
    ids(reconcileBands(local, [band("a"), band("b", { name: "teacher-edit" }), band("c")])), "a:a,b:teacher-edit,c:c");
  assert("bandsSync: refresh — teacher-created band appears",
    ids(reconcileBands(local, [band("a"), band("b", { name: "admin-old" }), band("c"), band("t", { name: "teacher-new" })])), "a:a,b:admin-old,c:c,t:teacher-new");
  assert("bandsSync: refresh — band deleted elsewhere is dropped",
    ids(reconcileBands(local, [band("a"), band("c")])), "a:a,c:c");
  assert("bandsSync: refresh — in-flight save wins over the server copy",
    ids(reconcileBands(local, [band("a"), band("b", { name: "server" }), band("c")],
      { pendingSaves: new Map([["b", band("b", { name: "admin-saving" })]]) })), "a:a,b:admin-saving,c:c");
  assert("bandsSync: refresh — in-flight NEW band kept though not on server yet",
    ids(reconcileBands([...local, band("n", { name: "new" })], [band("a"), band("b", { name: "admin-old" }), band("c")],
      { pendingSaves: new Map([["n", band("n", { name: "new" })]]) })), "a:a,b:admin-old,c:c,n:new");
  assert("bandsSync: refresh — in-flight delete is NOT resurrected",
    ids(reconcileBands([band("a"), band("c")], [band("a"), band("b", { name: "admin-old" }), band("c")],
      { pendingDeletes: new Set(["b"]) })), "a:a,c:c");
  assert("bandsSync: refresh — delete wins over a save pending for the same id",
    ids(reconcileBands([band("a")], [band("a"), band("b")],
      { pendingSaves: new Map([["b", band("b")]]), pendingDeletes: new Set(["b"]) })), "a:a");
  assert("bandsSync: refresh — empty server list keeps memory", reconcileBands(local, []) === local, true);
  assert("bandsSync: refresh — failed/absent server list keeps memory", reconcileBands(local, null) === local, true);
  const same = reconcileBands(local, [band("a"), band("b", { name: "admin-old" }), band("c")]);
  assert("bandsSync: refresh — nothing new returns the same list (no re-render)", same === local, true);
  const one = reconcileBands(local, [band("a"), band("b", { name: "x" }), band("c")]);
  assert("bandsSync: refresh — unchanged rows keep their objects", one[0] === local[0] && one[2] === local[2] && one[1] !== local[1], true);
  assert("bandsSync: refresh — inputs not mutated", ids(local), "a:a,b:admin-old,c:c");

  // ── Stale refresh guard ──
  assert("bandsSync: refresh applies when nothing happened since it started",
    isStaleBandsRefresh({ refreshSeq: 3, latestRefreshSeq: 3, writeSeqAtStart: 5, writeSeqNow: 5 }), false);
  assert("bandsSync: refresh ignored when a newer refresh started",
    isStaleBandsRefresh({ refreshSeq: 3, latestRefreshSeq: 4, writeSeqAtStart: 5, writeSeqNow: 5 }), true);
  assert("bandsSync: refresh ignored when a write started after it",
    isStaleBandsRefresh({ refreshSeq: 3, latestRefreshSeq: 3, writeSeqAtStart: 5, writeSeqNow: 6 }), true);
}
