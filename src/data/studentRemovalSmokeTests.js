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

import { deleteStudentCascade, endEnrolmentMaster, endEnrolmentWeekly } from "../utils/studentRemovalCascade";
import { archiveStudentCascade } from "../utils/archiveCascade";
import { generateWeeklyTimetable } from "./weeklyTimetableGenerator";
import { buildMttImportForWeekSchool } from "../utils/mttImport";
import { lweekDates } from "./bandLedgerSmokeTests";
import { syncEnrolmentsFromInstruments, groupLessonsUnchangedNote } from "../utils/enrolmentSync";
import { makeEnrolmentResolver, isCardInactiveForWeek } from "../utils/enrolmentActivity";

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

// ── Characterization: End enrolment moved out of App.js unchanged; the old
// Delete pinned from its verbatim copy (replaced by deleteStudentCascade) ──
export function runStudentRemovalCharacterizationTests(assert) {
  for (const [eid, end] of [["e_amy_gtr", RM_TODAY], ["e_ann_g3", RM_TODAY], ["e_libby_g2", RM_TODAY], ["e_ben_g3", CUR],
    ["e_amy_gtr", undefined], ["e_bob_drm", FUT], ["missing", RM_TODAY]]) {
    assert(`removal char: end ${eid} (${end || "no date"}) — master output identical to the inline code`,
      endEnrolmentMaster(rmMaster(), eid), inlineEndMaster(rmMaster(), eid));
    assert(`removal char: end ${eid} (${end || "no date"}) — weekly output identical to the inline code`,
      endEnrolmentWeekly(rmWeekMap(), eid, end), inlineEndWeekly(rmWeekMap(), eid, end));
  }

  // What the old Delete did (the inline code at 1c1a0f1), pinned.
  const dm = inlineDeleteMaster(rmMaster(), "ann");
  const dw = inlineDeleteWeekly(rmWeekMap(), "ann");
  assert("removal char: OLD delete — first-listed member takes the group's master card with them",
    ids(dm.lessons).includes("M_G3"), false);
  assert("removal char: OLD delete — first-listed member takes the group's PAST week card with them",
    ids(dw[PAST + "|S"].lessons).includes("M_G3_" + PAST), false);
  assert("removal char: OLD delete — missed entries are left behind in every week",
    ids(dw[PAST + "|S"].missed), ["X_G3_" + PAST, "X_ann_" + PAST, "X_amy_" + PAST]);
  assert("removal char: OLD delete — the catch-up card goes from the past week",
    ids(dw[PAST + "|S"].lessons).includes("C_ann_" + PAST), false);
  const src = rmWeekMap();
  const srcOut = inlineDeleteWeekly(src, "ann");
  assert("removal char: OLD delete — the band is the same object",
    srcOut[PAST + "|S"].lessons.find(l => l.isBandSession) === src[PAST + "|S"].lessons.find(l => l.isBandSession), true);
  const bw = inlineDeleteWeekly(rmWeekMap(), "ben");
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

// ── Delete permanently (deleteStudentCascade) ─────────────────────────────
const SCHOOL_S = { id: "S", name: "School S" };
const TEACHERS = [{ id: "t1", name: "Teacher One" }];
const ARCHIVED_ON = "2099-03-04";   // Wednesday of the PAST week

// The inputs App passes: plan lists before the delete, today's date.
const ctxFor = (sid, groups) => ({ studentId: sid, archiveDate: RM_TODAY, termBreaks: RM_TERM_BREAKS,
  groups, students: RM_STUDENTS, enrolments: RM_ENROL });

// The state a child archived on the v2.49.17 path leaves (archived midweek in
// the PAST week), or the untouched fixture for a child archived on the old path.
function stateFor(sid, archivedNewPath) {
  const master = rmMaster(), wtt = rmWeekMap();
  if (!archivedNewPath) return { groups: RM_GROUPS, lessons: master.lessons, unscheduled: master.unscheduled, wtt };
  const r = archiveStudentCascade({ studentId: sid, archiveDate: ARCHIVED_ON, termBreaks: RM_TERM_BREAKS,
    groups: RM_GROUPS, students: RM_STUDENTS, enrolments: RM_ENROL,
    lessons: master.lessons, unscheduled: master.unscheduled, weeklyTimetables: wtt });
  return { groups: r.groups, lessons: r.lessons, unscheduled: r.unscheduled, wtt: r.weeklyTimetables };
}

// Delete as App runs it: one call per collection, each on that setter's value.
function runDelete(sid, archivedNewPath) {
  const st = stateFor(sid, archivedNewPath);
  const ctx = ctxFor(sid, st.groups);
  const g = deleteStudentCascade({ ...ctx, groupsToUpdate: st.groups });
  const m = deleteStudentCascade({ ...ctx, lessons: st.lessons, unscheduled: st.unscheduled });
  const w = deleteStudentCascade({ ...ctx, weeklyTimetables: st.wtt });
  return { before: st, groups: g.groups, lessons: m.lessons, unscheduled: m.unscheduled, wtt: w.weeklyTimetables };
}

const studentsWithout = (sid) => RM_STUDENTS.filter(s => s.id !== sid);
const enrolWithout = (sid) => RM_ENROL.filter(e => e.studentId !== sid);
const groupCard = (lessons, gid) => (lessons || []).find(l => l.groupId === gid && !l.isBandSession);
const bandOf = (entry) => (entry.lessons || []).find(l => l.isBandSession);
const generateFor = (lessons, sid, wk) => generateWeeklyTimetable(lessons, SCHOOL_S, studentsWithout(sid), TEACHERS,
  [], [], lweekDates(wk), [], [], [], enrolWithout(sid));
const importFor = (lessons, sid, wk) => buildMttImportForWeekSchool({ mtt: { lessons }, schoolId: "S",
  weekDates: lweekDates(wk), existingEntry: null, enrolments: enrolWithout(sid), dropBands: true, catchups: [] });
const mentionsAnywhere = (list, sid) => (list || []).some(l => l.studentId === sid);

export function runDeleteStudentTests(assert) {
  const ALL = [PAST, CUR, FUT, FUT2];

  // Solo child (Amy), archived on the new path.
  {
    const r = runDelete("amy", true);
    assert("delete solo: master card and unscheduled entry gone",
      [ids(r.lessons).includes("M_amy"), ids(r.unscheduled)], [false, ["U_ben"]]);
    assert("delete solo: no lesson for the child in any week, past included",
      ALL.map(k => mentionsAnywhere(r.wtt[k + "|S"].lessons, "amy")), [false, false, false, false]);
    assert("delete solo: no missed entry for the child in any week, past included",
      ALL.map(k => mentionsAnywhere(r.wtt[k + "|S"].missed, "amy")), [false, false, false, false]);
    assert("delete solo: every group card is the same object in every week",
      ALL.every(k => ["G3", "G2", "G1", "G5"].every(gid => groupCard(r.wtt[k + "|S"].lessons, gid) === groupCard(r.before.wtt[k + "|S"].lessons, gid))), true);
    assert("delete solo: the other school's rows are the same objects",
      ALL.every(k => r.wtt[k + "|T"] === r.before.wtt[k + "|T"]), true);
    assert("delete solo: the empty slot in the map stays empty", r.wtt["2099-03-30|T"], null);
    assert("delete solo: group records are the same objects", r.groups.every((g, i) => g === r.before.groups[i]), true);
  }

  // First-listed member (Ann), archived on the new path.
  {
    const r = runDelete("ann", true);
    const pastBefore = groupCard(r.before.wtt[PAST + "|S"].lessons, "G3");
    const pastAfter = groupCard(r.wtt[PAST + "|S"].lessons, "G3");
    assert("delete first-listed: the group's PAST week card is kept", !!pastAfter, true);
    assert("delete first-listed: PAST card changed only in studentId, re-pointed to the next member",
      pastAfter, { ...pastBefore, studentId: "ben" });
    assert("delete first-listed: PAST card still names the child as history",
      [pastAfter.studentIds, pastAfter.studentNames], [["ann", "ben", "cat"], ["Ann Arden", "Ben Bray", "Cat Cole"]]);
    const missBefore = r.before.wtt[PAST + "|S"].missed.find(m => m.groupId === "G3");
    assert("delete first-listed: PAST group missed entry kept, only studentId re-pointed",
      r.wtt[PAST + "|S"].missed.find(m => m.groupId === "G3"), { ...missBefore, studentId: "ben" });
    assert("delete first-listed: the child's private lesson, catch-up and missed entries are gone from PAST",
      [ids(r.wtt[PAST + "|S"].lessons).includes("M_ann_" + PAST), ids(r.wtt[PAST + "|S"].lessons).includes("C_ann_" + PAST),
        ids(r.wtt[PAST + "|S"].missed).includes("X_ann_" + PAST)], [false, false, false]);
    assert("delete first-listed: every week still has the group card",
      ALL.map(k => !!groupCard(r.wtt[k + "|S"].lessons, "G3")), [true, true, true, true]);
    assert("delete first-listed: no card in any week has the child as its studentId",
      ALL.some(k => mentionsAnywhere(r.wtt[k + "|S"].lessons, "ann") || mentionsAnywhere(r.wtt[k + "|S"].missed, "ann")), false);
    const m = groupCard(r.lessons, "G3");
    assert("delete first-listed: master group card lists the others, on their enrolment",
      [m.studentId, m.studentIds, m.enrolmentId], ["ben", ["ben", "cat"], "e_ben_g3"]);
    assert("delete first-listed: group record lists the others", r.groups.find(g => g.id === "G3").studentIds, ["ben", "cat"]);
    const gc = groupCard(generateFor(r.lessons, "ann", FUT2).lessons, "G3");
    assert("delete first-listed: Generate for a future week puts the group card in with the others",
      gc ? [gc.studentIds, gc.studentId] : null, [["ben", "cat"], "ben"]);
    const ic = groupCard(importFor(r.lessons, "ann", FUT2).entry.lessons, "G3");
    assert("delete first-listed: Import for a future week puts the group card in with the others",
      ic ? [ic.studentIds, ic.studentId] : null, [["ben", "cat"], "ben"]);
  }

  // Non-first member (Ben), archived on the new path.
  {
    const r = runDelete("ben", true);
    assert("delete non-first: the PAST group card is the same object, still listing the child",
      [groupCard(r.wtt[PAST + "|S"].lessons, "G3") === groupCard(r.before.wtt[PAST + "|S"].lessons, "G3"),
        groupCard(r.wtt[PAST + "|S"].lessons, "G3").studentIds], [true, ["ann", "ben", "cat"]]);
    assert("delete non-first: master group card and record list the others",
      [groupCard(r.lessons, "G3").studentIds, r.groups.find(g => g.id === "G3").studentIds], [["ann", "cat"], ["ann", "cat"]]);
    assert("delete non-first: unscheduled entry gone", ids(r.unscheduled), ["U_amy"]);
  }

  // The member whose enrolment the group card is linked to (Libby, second in
  // G2, whose group sits in a band), archived on the new path.
  {
    const r = runDelete("libby", true);
    assert("delete enrolment-linked: PAST group card is the same object (its studentId is Ivy)",
      groupCard(r.wtt[PAST + "|S"].lessons, "G2") === groupCard(r.before.wtt[PAST + "|S"].lessons, "G2"), true);
    const m = groupCard(r.lessons, "G2");
    assert("delete enrolment-linked: master card is a group of one on Ivy's enrolment",
      [m.isGroup, m.studentIds, m.enrolmentId], [true, ["ivy"], "e_ivy_g2"]);
    const gc = groupCard(generateFor(r.lessons, "libby", FUT2).lessons, "G2");
    assert("delete enrolment-linked: Generate for a future week puts the group card in with Ivy",
      gc ? gc.studentIds : null, ["ivy"]);
    const ic = groupCard(importFor(r.lessons, "libby", FUT2).entry.lessons, "G2");
    assert("delete enrolment-linked: Import for a future week puts the group card in with Ivy",
      ic ? ic.studentIds : null, ["ivy"]);
  }

  // A child archived on the OLD path (Olga), still listed in G5 and on every card.
  {
    const r = runDelete("olga", false);
    assert("delete old-path: group record no longer lists the child", r.groups.find(g => g.id === "G5").studentIds, ["pat"]);
    assert("delete old-path: master and future cards list the remaining member",
      [groupCard(r.lessons, "G5").studentIds, ...[FUT, FUT2].map(k => groupCard(r.wtt[k + "|S"].lessons, "G5").studentIds)],
      [["pat"], ["pat"], ["pat"]]);
    for (const k of [PAST, CUR]) {
      const before = groupCard(r.before.wtt[k + "|S"].lessons, "G5");
      assert(`delete old-path: ${k === PAST ? "past" : "current"} week card changed only in studentId`,
        groupCard(r.wtt[k + "|S"].lessons, "G5"), { ...before, studentId: "pat" });
    }
    const gc = groupCard(generateFor(r.lessons, "olga", FUT2).lessons, "G5");
    assert("delete old-path: Generate for a future week puts the group card in with the remaining member",
      gc ? gc.studentIds : null, ["pat"]);
    const ic = groupCard(importFor(r.lessons, "olga", FUT2).entry.lessons, "G5");
    assert("delete old-path: Import for a future week puts the group card in with the remaining member",
      ic ? ic.studentIds : null, ["pat"]);
    // First-listed child on the old path: past and current cards re-pointed only.
    const a = runDelete("ann", false);
    assert("delete old-path first-listed: past and current group cards re-pointed, still naming the child",
      [PAST, CUR].map(k => { const c = groupCard(a.wtt[k + "|S"].lessons, "G3"); return [c.studentId, c.studentIds]; }),
      [["ben", ["ann", "ben", "cat"]], ["ben", ["ann", "ben", "cat"]]]);
    // A group record still listing the child that the plan does not know about.
    const stale = deleteStudentCascade({ ...ctxFor("olga", RM_GROUPS.map(g => g.id === "G5" ? { ...g, studentIds: ["pat"] } : g)),
      groupsToUpdate: RM_GROUPS });
    assert("delete old-path: the child's id comes off a group record the archive plan missed",
      stale.groups.find(g => g.id === "G5").studentIds, ["pat"]);
  }

  // Group of one (Zoe in G1): no other member to re-point to.
  {
    const r = runDelete("zoe", false);
    assert("delete group of one: group record deleted", r.groups.some(g => g.id === "G1"), false);
    assert("delete group of one: the card goes from the master and every week, past included",
      [!!groupCard(r.lessons, "G1"), ...ALL.map(k => !!groupCard(r.wtt[k + "|S"].lessons, "G1"))], [false, false, false, false, false]);
  }

  // Bands and other children untouched by every delete.
  for (const [sid, newPath] of [["amy", true], ["ann", true], ["ben", true], ["libby", true], ["olga", false], ["zoe", false]]) {
    const r = runDelete(sid, newPath);
    assert(`delete ${sid}: the band session (and its ledger) is the same object in every week`,
      ALL.every(k => bandOf(r.wtt[k + "|S"]) === bandOf(r.before.wtt[k + "|S"])), true);
    assert(`delete ${sid}: other children's solo missed entries are the same objects`,
      ALL.every(k => r.wtt[k + "|S"].missed.filter(m => !m.isGroup && m.studentId !== sid)
        .every(m => r.before.wtt[k + "|S"].missed.includes(m))), true);
    assert(`delete ${sid}: no solo card or solo missed entry for the child remains anywhere`,
      ALL.some(k => [...r.wtt[k + "|S"].lessons, ...r.wtt[k + "|S"].missed].some(l => !l.isGroup && !l.isBandSession && l.studentId === sid))
        || r.lessons.some(l => !l.isGroup && l.studentId === sid), false);
  }
}

// ── Assistant edit_student never ends a group enrolment ────────────────────
// Ben holds a private Piano enrolment and his G3 group Recorder enrolment,
// which the G3 card is linked to here. The assistant sends a new instrument
// list, as the tool does: { name } objects (App maps the input to that shape).
export function runAssistantGroupEnrolmentTests(assert) {
  const enrolments = [...RM_ENROL, enrol("e_ben_pno", "ben", "Piano")];
  const call = (names) => {
    const newInstruments = names.map(name => ({ name }));
    let n = 0;
    const out = syncEnrolmentsFromInstruments({ studentId: "ben", newInstruments, enrolments, todayDate: RM_TODAY, generateId: () => "new" + (++n) });
    return { out, note: groupLessonsUnchangedNote({ studentId: "ben", newInstruments, enrolments }) };
  };

  // The list drops both Piano and Recorder and adds Guitar.
  const { out, note } = call(["Guitar"]);
  assert("assistant: an instrument list change ends only the individual enrolment",
    out.find(e => e.id === "e_ben_pno").endDate, RM_TODAY);
  assert("assistant: the group enrolment is the same object, not ended",
    [out.find(e => e.id === "e_ben_g3") === enrolments.find(e => e.id === "e_ben_g3"), out.find(e => e.id === "e_ben_g3").endDate],
    [true, undefined]);
  assert("assistant: every other enrolment is the same object",
    enrolments.filter(e => e.id !== "e_ben_pno").every(e => out.includes(e)), true);
  assert("assistant: the new instrument is added as an individual enrolment",
    out.filter(e => e.id === "new1").map(e => [e.instrument, e.isGroup, e.startDate]), [["Guitar", false, RM_TODAY]]);
  assert("assistant: the tool result carries the plain-English note",
    note, " Group lessons were not changed (still enrolled in group Recorder) — to change a child's group lessons, use Students › Groups, or Archive if they are leaving.");

  // Cards: the enrolment change touches no card, and Generate and Import for a
  // future week still treat the group card (linked to Ben's group enrolment)
  // as active, with every member.
  const card = { ...RM_MASTER.find(l => l.id === "M_G3"), enrolmentId: "e_ben_g3" };
  const lessons = [...RM_MASTER.map(l => (l.id === "M_G3" ? card : l)), scard("M_ben_pno", "ben", "Piano", "e_ben_pno", "S", "Friday", "10:00")];
  assert("assistant: the group card is still active in a future week",
    isCardInactiveForWeek(card, makeEnrolmentResolver(out), FUT2), false);
  const gen = generateWeeklyTimetable(lessons, SCHOOL_S, RM_STUDENTS, TEACHERS, [], [], lweekDates(FUT2), [], [], [], out);
  const gc = groupCard(gen.lessons, "G3");
  assert("assistant: Generate for a future week keeps the group card with every member",
    gc ? gc.studentIds : null, ["ann", "ben", "cat"]);
  const imp = buildMttImportForWeekSchool({ mtt: { lessons }, schoolId: "S", weekDates: lweekDates(FUT2), existingEntry: null,
    enrolments: out, dropBands: true, catchups: [] });
  const ic = groupCard(imp.entry.lessons, "G3");
  assert("assistant: Import for a future week keeps the group card with every member",
    ic ? ic.studentIds : null, ["ann", "ben", "cat"]);
  assert("assistant: Ben's ended private Piano card is not copied into the future week, as before",
    (gen.lessons || []).some(l => l.studentId === "ben" && l.instrument === "Piano"), false);
  const genBefore = generateWeeklyTimetable(lessons, SCHOOL_S, RM_STUDENTS, TEACHERS, [], [], lweekDates(FUT2), [], [], [], enrolments);
  assert("assistant: (control) with Piano still active, Generate does copy it",
    (genBefore.lessons || []).some(l => l.studentId === "ben" && l.instrument === "Piano"), true);

  // No note when the list keeps the group instrument, or when there is no group enrolment.
  assert("assistant: no note when the list keeps the group instrument", call(["Recorder", "Guitar"]).note, "");
  assert("assistant: keeping the group instrument ends only Piano",
    call(["Recorder"]).out.filter(e => e.endDate).map(e => e.id), ["e_ben_pno"]);
  assert("assistant: no note for a child with no group enrolment",
    groupLessonsUnchangedNote({ studentId: "bob", newInstruments: [{ name: "Guitar" }], enrolments }), "");
  assert("assistant: an individual enrolment alone behaves as before (ended today)",
    syncEnrolmentsFromInstruments({ studentId: "bob", newInstruments: [], enrolments, todayDate: RM_TODAY })
      .find(e => e.id === "e_bob_drm").endDate, RM_TODAY);
}
