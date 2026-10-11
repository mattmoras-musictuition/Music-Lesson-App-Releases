// ============================================================
// STUDENT REMOVAL SMOKE TESTS (fix/delete-group-history)
// Delete student and End enrolment card clean-ups (utils/studentRemovalCascade).
//
// Fed the whole picture the real callers work on: master lessons and
// unscheduled entries, a week map with past, current and future weeks at two
// schools, solo cards, group cards (the child listed first, listed later, and
// the card linked to the child's enrolment), a band holding a group member, a
// catch-up card, missed entries, group records and enrolments. Fixture dates
// sit in 2099 so the week-activity guards never move.
// ============================================================

import { deleteStudentMaster, deleteStudentWeekly, endEnrolmentMaster, endEnrolmentWeekly } from "../utils/studentRemovalCascade";

// Term 1 2099 runs to Fri 3 Apr; the break is 4–19 Apr; Term 2 starts Mon 20 Apr.
export const RM_TERM_BREAKS = [{ id: "tb1", type: "term_break", date: "2099-04-04", endDate: "2099-04-19" }];
export const RM_TODAY = "2099-03-11";   // Wednesday of the current week, Term 1
const PAST = "2099-03-02", CUR = "2099-03-09", FUT = "2099-03-16", FUT2 = "2099-03-23";
export const RM_WEEKS = { PAST, CUR, FUT, FUT2 };

export const RM_STUDENTS = [
  { id: "amy", name: "Amy Ash", schoolId: "S", className: "3A", status: "archived" },
  { id: "ann", name: "Ann Arden", schoolId: "S", className: "4A", status: "archived" },
  { id: "ben", name: "Ben Bray", schoolId: "S", className: "4A", status: "active" },
  { id: "cat", name: "Cat Cole", schoolId: "S", className: "4B", status: "active" },
  { id: "ivy", name: "Ivy O'Donnell", schoolId: "S", className: "5C", status: "active" },
  { id: "libby", name: "Libby Gilby", schoolId: "S", className: "5C", status: "archived" },
  { id: "zoe", name: "Zoe Zhu", schoolId: "S", className: "2A", status: "archived" },
  { id: "olga", name: "Olga Old", schoolId: "S", className: "6A", status: "archived" },
  { id: "pat", name: "Pat Pike", schoolId: "S", className: "6A", status: "active" },
  { id: "bob", name: "Bob Bell", schoolId: "T", className: "4B", status: "active" },
];
const rnameOf = (sid) => RM_STUDENTS.find(s => s.id === sid).name;

const enrol = (id, studentId, instrument, extra = {}) => ({ id, studentId, instrument, startDate: "2020-01-01", ...extra });
export const RM_ENROL = [
  enrol("e_amy_gtr", "amy", "Guitar"),
  enrol("e_ann_pno", "ann", "Piano"),
  enrol("e_ann_g3", "ann", "Recorder", { isGroup: true, groupId: "G3" }),
  enrol("e_ben_g3", "ben", "Recorder", { isGroup: true, groupId: "G3" }),
  enrol("e_cat_g3", "cat", "Recorder", { isGroup: true, groupId: "G3" }),
  enrol("e_ivy_g2", "ivy", "Ukulele", { isGroup: true, groupId: "G2" }),
  enrol("e_libby_g2", "libby", "Ukulele", { isGroup: true, groupId: "G2" }),
  enrol("e_zoe_g1", "zoe", "Flute", { isGroup: true, groupId: "G1" }),
  enrol("e_olga_g5", "olga", "Cello", { isGroup: true, groupId: "G5" }),
  enrol("e_pat_g5", "pat", "Cello", { isGroup: true, groupId: "G5" }),
  enrol("e_bob_drm", "bob", "Drums"),
];

const group = (id, name, instrument, studentIds) => ({ id, name, schoolId: "S", instrument, minSize: 2, maxSize: 4,
  teacherId: "t1", studentIds, status: "scheduled", notes: "" });
// G5 still lists Olga, as a child archived on the old (pre-v2.49.17) path left it.
export const RM_GROUPS = [
  group("G3", "", "Recorder", ["ann", "ben", "cat"]),
  group("G2", "Ivy, Libby", "Ukulele", ["ivy", "libby"]),
  group("G1", "", "Flute", ["zoe"]),
  group("G5", "Strings", "Cello", ["olga", "pat"]),
];
const RG = (id) => RM_GROUPS.find(g => g.id === id);

// Group cards as handleAddGroupToMaster builds them (studentId = first member).
// G3 carries the FIRST member's enrolment, G2 the SECOND member's.
export const rmGcard = (id, g, day, start, enrolmentId) => ({
  id, isGroup: true, groupId: g.id, groupName: g.name, studentId: g.studentIds[0], studentName: g.name,
  studentIds: [...g.studentIds], studentNames: g.studentIds.map(rnameOf), bucket_id: "lane1",
  schoolId: "S", schoolName: "School S", day, slotId: "s" + start, slotName: start, start, end: start.replace(":00", ":30"),
  instrument: g.instrument, duringSpecialist: false, enrolmentId,
});
const scard = (id, sid, instrument, enrolmentId, schoolId, day, start) => ({
  id, studentId: sid, studentName: rnameOf(sid), instrument, enrolmentId, bucket_id: "lane1",
  schoolId, schoolName: schoolId === "S" ? "School S" : "School T", day, start, end: start.replace(":00", ":30"),
});
export const RM_MASTER = [
  scard("M_amy", "amy", "Guitar", "e_amy_gtr", "S", "Monday", "09:00"),
  scard("M_ann", "ann", "Piano", "e_ann_pno", "S", "Monday", "09:30"),
  rmGcard("M_G3", RG("G3"), "Tuesday", "09:00", "e_ann_g3"),
  rmGcard("M_G2", RG("G2"), "Tuesday", "10:00", "e_libby_g2"),
  rmGcard("M_G1", RG("G1"), "Wednesday", "10:00", "e_zoe_g1"),
  rmGcard("M_G5", RG("G5"), "Wednesday", "11:00", "e_olga_g5"),
  scard("M_bob", "bob", "Drums", "e_bob_drm", "T", "Monday", "11:00"),
];
export const RM_UNSCHEDULED = [
  { id: "U_amy", student: { id: "amy", name: "Amy Ash" }, instrument: "Guitar", enrolmentId: "e_amy_gtr" },
  { id: "U_ben", student: { id: "ben", name: "Ben Bray" }, instrument: "Recorder", enrolmentId: "e_ben_g3" },
];

// A band in school S holding Ivy through her group, with a G2 card in its ledger.
const band = (wk) => ({
  id: "BAND_" + wk, isBandSession: true, bandId: "RIPTIDE", bandName: "Riptide", schoolId: "S", day: "Thursday",
  start: "13:30", end: "14:00", members: [{ studentId: "ivy", viaGroupId: "G2", groupName: "Ivy, Libby", instrument: "Ukulele" }],
  removedLessons: [{ ...rmGcard("L_" + wk, RG("G2"), "Thursday", "11:00", "e_libby_g2") }],
  memberStates: [{ enrolmentId: "e_ivy_g2", studentId: "ivy", instrument: "Ukulele", consumption: "regular", groupId: "G2", isGroup: true }],
});
// A catch-up card saved in the week (Ann's piano), as older weeks hold them.
const catchupCard = (wk) => ({ ...scard("C_ann_" + wk, "ann", "Piano", "e_ann_pno", "S", "Friday", "09:00"), isMakeup: true, adjusted: true });
const weekEntry = (wk) => ({
  lessons: [...RM_MASTER.filter(l => l.schoolId === "S").map(l => ({ ...l, id: l.id + "_" + wk, adjusted: false })), band(wk), catchupCard(wk)],
  missed: [
    { ...RM_MASTER.find(l => l.id === "M_G3"), id: "X_G3_" + wk, reason: "Excursion" },
    { ...RM_MASTER.find(l => l.id === "M_ann"), id: "X_ann_" + wk, reason: "Sick" },
    { ...RM_MASTER.find(l => l.id === "M_amy"), id: "X_amy_" + wk, reason: "Sick" },
  ],
  notes: "n",
});
export const rmWeekMap = () => {
  const m = {};
  for (const k of [PAST, CUR, FUT, FUT2]) {
    m[k + "|S"] = weekEntry(k);
    m[k + "|T"] = { lessons: [{ ...RM_MASTER.find(l => l.id === "M_bob"), id: "W_bob_" + k }], missed: [], notes: "" };
  }
  m["2099-03-30|T"] = null; // an empty slot in the map
  return m;
};
export const rmMaster = () => ({ lessons: RM_MASTER, unscheduled: RM_UNSCHEDULED, savedAt: "x" });

// ── The App.js inline code as it stood at 1c1a0f1, verbatim ──────────────
const inlineDeleteMaster = (prev, id) => ({ ...prev, lessons: (prev.lessons || []).filter(l => l.studentId !== id), unscheduled: (prev.unscheduled || []).filter(u => u.student?.id !== id) });
const inlineDeleteWeekly = (prev, id) => {
  const next = { ...prev };
  for (const key of Object.keys(next)) {
    const entry = next[key];
    if (!entry) continue;
    next[key] = { ...entry, lessons: (entry.lessons || []).filter(l => l.studentId !== id) };
  }
  return next;
};
const inlineEndMaster = (prev, enrolmentId) => ({
  ...prev,
  lessons: (prev.lessons || []).filter(l => l.enrolmentId !== enrolmentId),
  unscheduled: (prev.unscheduled || []).filter(u => u.enrolmentId !== enrolmentId),
});
const inlineEndWeekly = (prev, enrolmentId, endDate) => {
  const next = { ...prev };
  for (const key of Object.keys(next)) {
    const entry = next[key];
    if (!entry) continue;
    const weekKey = key.split("|")[0];
    if (endDate && !(weekKey > endDate)) continue;
    next[key] = {
      ...entry,
      lessons: (entry.lessons || []).filter(l => l.enrolmentId !== enrolmentId),
      missed:  (entry.missed  || []).filter(m => m.enrolmentId !== enrolmentId),
    };
  }
  return next;
};

const ids = (list) => (list || []).map(x => x.id);

// ── Characterization: the clean-ups moved out of App.js, unchanged ───────
export function runStudentRemovalCharacterizationTests(assert) {
  for (const sid of ["amy", "ann", "ben", "libby", "zoe", "olga", "bob", "nobody"]) {
    assert(`removal char: delete ${sid} — master output identical to the inline code`,
      deleteStudentMaster(rmMaster(), sid), inlineDeleteMaster(rmMaster(), sid));
    assert(`removal char: delete ${sid} — weekly output identical to the inline code`,
      deleteStudentWeekly(rmWeekMap(), sid), inlineDeleteWeekly(rmWeekMap(), sid));
  }
  for (const [eid, end] of [["e_amy_gtr", RM_TODAY], ["e_ann_g3", RM_TODAY], ["e_libby_g2", RM_TODAY], ["e_ben_g3", CUR],
    ["e_amy_gtr", undefined], ["e_bob_drm", FUT], ["missing", RM_TODAY]]) {
    assert(`removal char: end ${eid} (${end || "no date"}) — master output identical to the inline code`,
      endEnrolmentMaster(rmMaster(), eid), inlineEndMaster(rmMaster(), eid));
    assert(`removal char: end ${eid} (${end || "no date"}) — weekly output identical to the inline code`,
      endEnrolmentWeekly(rmWeekMap(), eid, end), inlineEndWeekly(rmWeekMap(), eid, end));
  }

  // What today's Delete does, pinned.
  const dm = deleteStudentMaster(rmMaster(), "ann");
  const dw = deleteStudentWeekly(rmWeekMap(), "ann");
  assert("removal char: OLD delete — first-listed member takes the group's master card with them",
    ids(dm.lessons).includes("M_G3"), false);
  assert("removal char: OLD delete — first-listed member takes the group's PAST week card with them",
    ids(dw[PAST + "|S"].lessons).includes("M_G3_" + PAST), false);
  assert("removal char: OLD delete — missed entries are left behind in every week",
    ids(dw[PAST + "|S"].missed), ["X_G3_" + PAST, "X_ann_" + PAST, "X_amy_" + PAST]);
  assert("removal char: OLD delete — the catch-up card goes from the past week",
    ids(dw[PAST + "|S"].lessons).includes("C_ann_" + PAST), false);
  const src = rmWeekMap();
  const srcOut = deleteStudentWeekly(src, "ann");
  assert("removal char: OLD delete — the band is the same object",
    srcOut[PAST + "|S"].lessons.find(l => l.isBandSession) === src[PAST + "|S"].lessons.find(l => l.isBandSession), true);
  const bw = deleteStudentWeekly(rmWeekMap(), "ben");
  assert("removal char: OLD delete — a non-first member leaves the group card in place, still listing them",
    bw[PAST + "|S"].lessons.find(l => l.groupId === "G3").studentIds, ["ann", "ben", "cat"]);

  // What today's End enrolment does, pinned.
  const ew = endEnrolmentWeekly(rmWeekMap(), "e_amy_gtr", RM_TODAY);
  assert("removal char: end — past and current weeks keep the card",
    [PAST, CUR].map(k => ids(ew[k + "|S"].lessons).includes("M_amy_" + k)), [true, true]);
  assert("removal char: end — future weeks lose the card and its missed entry",
    [FUT, FUT2].map(k => [ids(ew[k + "|S"].lessons).includes("M_amy_" + k), ids(ew[k + "|S"].missed).includes("X_amy_" + k)]),
    [[false, false], [false, false]]);
  assert("removal char: end — master card and unscheduled entry go",
    [ids(endEnrolmentMaster(rmMaster(), "e_amy_gtr").lessons).includes("M_amy"), ids(endEnrolmentMaster(rmMaster(), "e_amy_gtr").unscheduled)],
    [false, ["U_ben"]]);
  const eg = endEnrolmentWeekly(rmWeekMap(), "e_ann_g3", RM_TODAY);
  assert("removal char: end — the group card linked to that enrolment goes from future weeks, for every member",
    ids(eg[FUT + "|S"].lessons).some(id => id.startsWith("M_G3")), false);
}
