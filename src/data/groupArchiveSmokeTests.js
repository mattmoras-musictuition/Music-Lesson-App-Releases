// ============================================================
// GROUP ARCHIVE SMOKE TESTS (fix/group-archive-member)
// Archiving a child who is in a group: the child comes off the group, the
// group carries on (or is deleted between terms / when nobody is left), and
// the card no longer depends on the archived child's enrolment.
//
// Fed the whole picture the archive save works on: master lessons, a week map
// with past, current and future weeks at two schools, solo cards, a band
// holding a group member and a group card in its ledger, full group records
// and enrolments. Then the result is run through Generate and Import for a
// future week, as the owner would. Fixture dates sit in 2099 so the
// week-activity guards never move.
// ============================================================

import { archiveStudentCascade, purgeWeeklyAfterArchive, isDateInTerm, syncCardToGroup } from "../utils/archiveCascade";
import { generateWeeklyTimetable } from "./weeklyTimetableGenerator";
import { buildMttImportForWeekSchool } from "../utils/mttImport";
import { instrumentsFromEnrolments } from "../utils/enrolmentsDB";
import { lweekDates } from "./bandLedgerSmokeTests";

// Term 1 2099 runs to Fri 3 Apr; the break is 4–19 Apr; Term 2 starts Mon 20 Apr.
const TERM_BREAKS = [{ id: "tb1", type: "term_break", date: "2099-04-04", endDate: "2099-04-19" }];
const IN_TERM = "2099-03-11";      // Wednesday, Term 1
const BETWEEN = "2099-04-08";      // Wednesday, holidays
const PAST = "2099-03-02", CUR = "2099-03-09", FUT = "2099-03-16", FUT2 = "2099-03-23";
const B_CUR = "2099-04-06", B_FUT = "2099-04-20";

const GSTUDENTS = [
  { id: "amy", name: "Amy Ash", schoolId: "S", className: "3A", status: "active" },
  { id: "ann", name: "Ann Arden", schoolId: "S", className: "4A", status: "active" },
  { id: "ben", name: "Ben Bray", schoolId: "S", className: "4A", status: "active" },
  { id: "cat", name: "Cat Cole", schoolId: "S", className: "4B", status: "active" },
  { id: "ivy", name: "Ivy O'Donnell", schoolId: "S", className: "5C", status: "active" },
  { id: "libby", name: "Libby Gilby", schoolId: "S", className: "5C", status: "active" },
  { id: "dan", name: "Dan Dix", schoolId: "S", className: "6A", status: "active" },
  { id: "eve", name: "Eve Eld", schoolId: "S", className: "6A", status: "active" },
  { id: "zoe", name: "Zoe Zhu", schoolId: "S", className: "2A", status: "active" },
  { id: "bob", name: "Bob Bell", schoolId: "T", className: "4B", status: "active" },
];
const GTEACHERS = [{ id: "t1", name: "Teacher One" }];
const SCHOOLS = { S: { id: "S", name: "School S" }, T: { id: "T", name: "School T" } };

const genrol = (id, studentId, instrument, extra = {}) => ({ id, studentId, instrument, startDate: "2020-01-01", ...extra });
const GENROL = [
  genrol("e_amy_gtr", "amy", "Guitar"),
  genrol("e_ann_pno", "ann", "Piano"),                       // Ann also has a private lesson
  genrol("e_ann_g3", "ann", "Recorder", { isGroup: true, groupId: "G3" }),
  genrol("e_ben_g3", "ben", "Recorder", { isGroup: true, groupId: "G3" }),
  genrol("e_cat_g3", "cat", "Recorder", { isGroup: true, groupId: "G3" }),
  genrol("e_ivy_g2", "ivy", "Ukulele", { isGroup: true, groupId: "G2" }),
  genrol("e_libby_g2", "libby", "Ukulele", { isGroup: true, groupId: "G2" }),
  genrol("e_dan_g4", "dan", "Violin", { isGroup: true, groupId: "G4" }),
  genrol("e_eve_g4", "eve", "Violin", { isGroup: true, groupId: "G4" }),
  genrol("e_zoe_g1", "zoe", "Flute", { isGroup: true, groupId: "G1" }),
  genrol("e_bob_drm", "bob", "Drums"),
];

const group = (id, name, instrument, studentIds) => ({ id, name, schoolId: "S", instrument, minSize: 2, maxSize: 4,
  teacherId: "t1", studentIds, status: "scheduled", notes: "" });
const GGROUPS = [
  group("G3", "", "Recorder", ["ann", "ben", "cat"]),
  group("G2", "Ivy, Libby", "Ukulele", ["ivy", "libby"]),
  group("G4", "Ukulele Club", "Violin", ["dan", "eve"]),
  group("G1", "", "Flute", ["zoe"]),
];

const nameOf = (sid) => GSTUDENTS.find(s => s.id === sid).name;
// Group cards exactly as handleAddGroupToMaster builds them (studentId = first
// member). enrolmentId is the one each test needs: G3 carries the FIRST
// member's, G2 carries the SECOND member's.
const gcard = (id, g, day, start, enrolmentId) => ({
  id, isGroup: true, groupId: g.id, groupName: g.name, studentId: g.studentIds[0], studentName: g.name,
  studentIds: [...g.studentIds], studentNames: g.studentIds.map(nameOf), bucket_id: "lane1",
  schoolId: "S", schoolName: "School S", day, slotId: "s" + start, slotName: start, start, end: start.replace(":00", ":30"),
  instrument: g.instrument, duringSpecialist: false, enrolmentId,
});
const scard = (id, sid, instrument, enrolmentId, schoolId, day, start) => ({
  id, studentId: sid, studentName: nameOf(sid), instrument, enrolmentId, bucket_id: "lane1",
  schoolId, schoolName: SCHOOLS[schoolId].name, day, start, end: start.replace(":00", ":30"),
});
const G = (id) => GGROUPS.find(g => g.id === id);
const GMASTER = [
  scard("M_amy", "amy", "Guitar", "e_amy_gtr", "S", "Monday", "09:00"),
  scard("M_ann", "ann", "Piano", "e_ann_pno", "S", "Monday", "09:30"),
  gcard("M_G3", G("G3"), "Tuesday", "09:00", "e_ann_g3"),
  gcard("M_G2", G("G2"), "Tuesday", "10:00", "e_libby_g2"),
  gcard("M_G4", G("G4"), "Wednesday", "09:00", "e_dan_g4"),
  gcard("M_G1", G("G1"), "Wednesday", "10:00", "e_zoe_g1"),
  scard("M_bob", "bob", "Drums", "e_bob_drm", "T", "Monday", "11:00"),
];

// A band in school S holding Ivy through her group, with the G2 card in its ledger.
const band = (wk) => ({
  id: "BAND_" + wk, isBandSession: true, bandId: "RIPTIDE", bandName: "Riptide", schoolId: "S", day: "Thursday",
  start: "13:30", end: "14:00", members: [{ studentId: "ivy", viaGroupId: "G2", groupName: "Ivy, Libby", instrument: "Ukulele" }],
  removedLessons: [{ ...gcard("L_" + wk, G("G2"), "Thursday", "11:00", "e_libby_g2") }],
  memberStates: [{ enrolmentId: "e_ivy_g2", studentId: "ivy", instrument: "Ukulele", consumption: "regular", groupId: "G2", isGroup: true }],
});
const weekEntry = (wk) => ({
  lessons: [...GMASTER.filter(l => l.schoolId === "S").map(l => ({ ...l, id: l.id + "_" + wk, adjusted: false })), band(wk)],
  missed: [
    { ...GMASTER.find(l => l.id === "M_G3"), id: "X_G3_" + wk, reason: "Excursion" },
    { ...GMASTER.find(l => l.id === "M_ann"), id: "X_ann_" + wk, reason: "Sick" },
  ],
  notes: "n",
});
const weekMap = (keys) => {
  const m = {};
  for (const k of keys) {
    m[k + "|S"] = weekEntry(k);
    m[k + "|T"] = { lessons: [{ ...GMASTER.find(l => l.id === "M_bob"), id: "W_bob_" + k }], missed: [], notes: "" };
  }
  return m;
};

// The archive save as both callers make it: one call per collection, with
// the same plan inputs (group records, students, enrolments before archive).
function runArchive(studentId, archiveDate, weekKeys) {
  const wtt = weekMap(weekKeys);
  const base = { studentId, archiveDate, termBreaks: TERM_BREAKS, groups: GGROUPS, students: GSTUDENTS, enrolments: GENROL };
  const r = archiveStudentCascade({ ...base, lessons: GMASTER, unscheduled: [], weeklyTimetables: wtt });
  return { wtt, r };
}
// Enrolments after the save: every active row of the child ends that day.
const enrolAfter = (sid, date) => GENROL.map(e => (e.studentId === sid && !e.endDate ? { ...e, endDate: date } : e));
const studentsAfter = (sid) => GSTUDENTS.map(s => (s.id === sid ? { ...s, status: "archived" } : s));
const cardOf = (lessons, groupId) => (lessons || []).find(l => l.groupId === groupId && !l.isBandSession);
const firstNames = (names) => names.map(n => n.split(" ")[0]);
const mentions = (card, sid) => {
  const first = nameOf(sid).split(" ")[0].toLowerCase();
  return (card.studentIds || []).includes(sid)
    || (card.studentNames || []).some(n => n.toLowerCase().includes(first))
    || String(card.groupName || "").toLowerCase().includes(first)
    || String(card.studentName || "").toLowerCase().includes(first);
};
const generate = (masterLessons, schoolId, wk, sid, date) => generateWeeklyTimetable(masterLessons, SCHOOLS[schoolId],
  studentsAfter(sid), GTEACHERS, [], [], lweekDates(wk), [], [], [], enrolAfter(sid, date));
const importWeek = (masterLessons, wk, sid, date) => buildMttImportForWeekSchool({ mtt: { lessons: masterLessons }, schoolId: "S",
  weekDates: lweekDates(wk), existingEntry: null, enrolments: enrolAfter(sid, date), dropBands: true, catchups: [] });

// ── Characterization: the old archive path, pinned before the fix ─────────
export function runGroupArchiveCharacterizationTests(assert) {
  assert("group archive char: the fixture date is in term", isDateInTerm(IN_TERM, TERM_BREAKS), true);
  assert("group archive char: the holiday date is between terms", isDateInTerm(BETWEEN, TERM_BREAKS), false);
  assert("group archive char: Friday 3 Apr is the last day of term", isDateInTerm("2099-04-03", TERM_BREAKS), true);
  assert("group archive char: Monday 20 Apr is the first day of term 2", isDateInTerm("2099-04-20", TERM_BREAKS), true);
  assert("group archive char: no term breaks recorded counts as in term", isDateInTerm(IN_TERM, []), true);

  // Old master filter (App.js onArchiveStudent / archive_student): by studentId.
  const oldMaster = (sid) => GMASTER.filter(l => l.studentId !== sid);
  assert("group archive char: OLD path — archiving the first member deleted the whole group card",
    !!cardOf(oldMaster("ivy"), "G2"), false);
  assert("group archive char: OLD path — archiving the second member left them on the card",
    cardOf(oldMaster("libby"), "G2").studentIds, ["ivy", "libby"]);
  const oldWeek = purgeWeeklyAfterArchive(weekMap([FUT]), "ivy", IN_TERM);
  assert("group archive char: OLD path — future week lost the whole group card",
    !!cardOf(oldWeek[FUT + "|S"].lessons, "G2"), false);
  // The enrolment-id route: the card carried Libby's enrolment, so after her
  // archive Generate treats the whole group card as inactive.
  const gen = generate(oldMaster("libby"), "S", FUT, "libby", IN_TERM);
  assert("group archive char: OLD path — Generate dropped the group whose card carried the archived child's enrolment",
    !!cardOf(gen.lessons, "G2"), false);
}

// ── Three-member group: first, middle, last ───────────────────────────────
export function runGroupArchiveThreeMemberTests(assert) {
  for (const sid of ["ann", "ben", "cat"]) {
    const { wtt, r } = runArchive(sid, IN_TERM, [PAST, CUR, FUT, FUT2]);
    const remaining = ["ann", "ben", "cat"].filter(x => x !== sid);
    const g = r.groups.find(x => x.id === "G3");
    assert(`group archive 3: archive ${sid} — group keeps the others`, g.studentIds, remaining);
    assert(`group archive 3: archive ${sid} — blank group name stays blank`, g.name, "");
    const m = cardOf(r.lessons, "G3");
    assert(`group archive 3: archive ${sid} — master card lists only the others`, m.studentIds, remaining);
    assert(`group archive 3: archive ${sid} — master card names only the others`, m.studentNames, remaining.map(nameOf));
    assert(`group archive 3: archive ${sid} — master card is still a group with its groupId`, [m.isGroup, m.groupId], [true, "G3"]);
    assert(`group archive 3: archive ${sid} — master card studentId is the first remaining member`, m.studentId, remaining[0]);
    assert(`group archive 3: archive ${sid} — nothing on the master card names the child`, mentions(m, sid), false);
    assert(`group archive 3: archive ${sid} — enrolmentId re-pointed only when it was the child's`,
      m.enrolmentId, sid === "ann" ? "e_ben_g3" : "e_ann_g3");
    for (const wk of [FUT, FUT2]) {
      const e = wtt[wk + "|S"], out = r.weeklyTimetables[wk + "|S"];
      const wc = cardOf(out.lessons, "G3");
      assert(`group archive 3: archive ${sid} — week ${wk} card lists only the others`, wc.studentIds, remaining);
      assert(`group archive 3: archive ${sid} — week ${wk} card names only the others`, mentions(wc, sid), false);
      const miss = out.missed.find(x => x.groupId === "G3");
      assert(`group archive 3: archive ${sid} — week ${wk} group miss lists only the others`, miss.studentIds, remaining);
      assert(`group archive 3: archive ${sid} — week ${wk} band is the same object`,
        out.lessons.find(l => l.isBandSession) === e.lessons.find(l => l.isBandSession), true);
      assert(`group archive 3: archive ${sid} — week ${wk} other school's row is the same object`,
        r.weeklyTimetables[wk + "|T"] === wtt[wk + "|T"], true);
      assert(`group archive 3: archive ${sid} — week ${wk} keeps its notes`, out.notes, "n");
    }
    for (const wk of [PAST, CUR]) {
      assert(`group archive 3: archive ${sid} — week ${wk} (past/current) is the same object`,
        r.weeklyTimetables[wk + "|S"] === wtt[wk + "|S"], true);
    }
  }
  // Ann also has a private lesson: it goes the usual way.
  const { r } = runArchive("ann", IN_TERM, [FUT]);
  assert("group archive 3: the first member's private master card is removed", r.lessons.some(l => l.id === "M_ann"), false);
  assert("group archive 3: the first member's private future card and miss are removed",
    [r.weeklyTimetables[FUT + "|S"].lessons.some(l => l.studentId === "ann" && !l.isGroup),
     r.weeklyTimetables[FUT + "|S"].missed.some(m => m.studentId === "ann" && !m.isGroup)], [false, false]);
  assert("group archive 3: other groups and solo cards are the same objects",
    ["M_amy", "M_G2", "M_G4", "M_G1", "M_bob"].every(id => r.lessons.find(l => l.id === id) === GMASTER.find(l => l.id === id)), true);
  assert("group archive 3: other group records are the same objects",
    ["G2", "G4", "G1"].every(id => r.groups.find(g => g.id === id) === G(id)), true);
  assert("group archive 3: the input lists are not mutated", [GMASTER.length, G("G3").studentIds.length], [7, 3]);
}

// ── Two-member group in term (D2) and between terms (D3) ─────────────────
export function runGroupArchiveTwoMemberTests(assert) {
  for (const sid of ["ivy", "libby"]) {
    const other = sid === "ivy" ? "libby" : "ivy";
    const { r } = runArchive(sid, IN_TERM, [CUR, FUT]);
    const g = r.groups.find(x => x.id === "G2");
    assert(`group archive 2 in term: archive ${sid} — a group of one survives`, [!!g, g && g.studentIds], [true, [other]]);
    assert(`group archive 2 in term: archive ${sid} — auto-built name rebuilt from the remaining member`,
      g.name, nameOf(other).split(" ")[0]);
    assert(`group archive 2 in term: archive ${sid} — no group was deleted`, r.deletedGroupIds, []);
    const m = cardOf(r.lessons, "G2");
    assert(`group archive 2 in term: archive ${sid} — master card is still a group`,
      [m.isGroup, m.groupId, m.studentIds, m.studentId], [true, "G2", [other], other]);
    assert(`group archive 2 in term: archive ${sid} — card labels rebuilt without the child`,
      [m.groupName, m.studentName, m.studentNames], [nameOf(other).split(" ")[0], nameOf(other).split(" ")[0], [nameOf(other)]]);
    assert(`group archive 2 in term: archive ${sid} — enrolmentId re-pointed only when it was the child's`,
      m.enrolmentId, sid === "libby" ? "e_ivy_g2" : "e_libby_g2");
    const wc = cardOf(r.weeklyTimetables[FUT + "|S"].lessons, "G2");
    assert(`group archive 2 in term: archive ${sid} — future week card is a group of one`, [wc.isGroup, wc.studentIds], [true, [other]]);
    // Generate and Import for a future week, from the new master, with the child archived.
    const gen = generate(r.lessons, "S", FUT2, sid, IN_TERM);
    const gc = cardOf(gen.lessons, "G2");
    assert(`group archive 2 in term: archive ${sid} — Generate puts the group card in, listing only ${other}`,
      gc ? [gc.isGroup, gc.studentIds, firstNames(gc.studentNames)] : null, [true, [other], [nameOf(other).split(" ")[0]]]);
    const imp = importWeek(r.lessons, FUT2, sid, IN_TERM);
    const ic = cardOf(imp.entry.lessons, "G2");
    assert(`group archive 2 in term: archive ${sid} — Import puts the group card in, listing only ${other}`,
      ic ? [ic.isGroup, ic.studentIds, mentions(ic, sid)] : null, [true, [other], false]);
  }

  for (const sid of ["ivy", "libby"]) {
    const other = sid === "ivy" ? "libby" : "ivy";
    const { wtt, r } = runArchive(sid, BETWEEN, [PAST, B_CUR, B_FUT]);
    assert(`group archive 2 between terms: archive ${sid} — group record deleted`, r.groups.some(g => g.id === "G2"), false);
    assert(`group archive 2 between terms: archive ${sid} — reported as deleted`, r.deletedGroupIds, ["G2"]);
    assert(`group archive 2 between terms: archive ${sid} — master card gone`, !!cardOf(r.lessons, "G2"), false);
    assert(`group archive 2 between terms: archive ${sid} — future week card gone`,
      !!cardOf(r.weeklyTimetables[B_FUT + "|S"].lessons, "G2"), false);
    assert(`group archive 2 between terms: archive ${sid} — current and past weeks untouched`,
      [r.weeklyTimetables[B_CUR + "|S"] === wtt[B_CUR + "|S"], r.weeklyTimetables[PAST + "|S"] === wtt[PAST + "|S"]], [true, true]);
    assert(`group archive 2 between terms: archive ${sid} — band still the same object`,
      r.weeklyTimetables[B_FUT + "|S"].lessons.find(l => l.isBandSession) === wtt[B_FUT + "|S"].lessons.find(l => l.isBandSession), true);
    // The remaining child keeps their group enrolment and shows as Ungrouped
    // (GroupsManager: active, live group enrolment, in no group).
    const enrol = enrolAfter(sid, BETWEEN);
    const live = enrol.find(e => e.studentId === other && e.groupId === "G2");
    assert(`group archive 2 between terms: archive ${sid} — ${other}'s group enrolment is intact`,
      [live.id, live.endDate], [`e_${other}_g2`, undefined]);
    const assigned = new Set(r.groups.flatMap(g => g.studentIds || []));
    const ungrouped = studentsAfter(sid).filter(s => s.status === "active"
      && instrumentsFromEnrolments(s.id, enrol).some(i => i.isGroup) && !assigned.has(s.id)).map(s => s.id);
    assert(`group archive 2 between terms: archive ${sid} — ${other} shows as Ungrouped`, ungrouped, [other]);
    const gen = generate(r.lessons, "S", B_FUT, sid, BETWEEN);
    assert(`group archive 2 between terms: archive ${sid} — Generate makes no group card`, !!cardOf(gen.lessons, "G2"), false);
    const imp = importWeek(r.lessons, B_FUT, sid, BETWEEN);
    assert(`group archive 2 between terms: archive ${sid} — Import makes no group card`, !!cardOf(imp.entry.lessons, "G2"), false);
  }
}

// ── Last member, typed names, band ledger ─────────────────────────────────
export function runGroupArchiveEdgeTests(assert) {
  const { wtt, r } = runArchive("zoe", IN_TERM, [CUR, FUT]);
  assert("group archive edge: last member archived — group deleted", [r.groups.some(g => g.id === "G1"), r.deletedGroupIds], [false, ["G1"]]);
  assert("group archive edge: last member archived — master and future cards gone",
    [!!cardOf(r.lessons, "G1"), !!cardOf(r.weeklyTimetables[FUT + "|S"].lessons, "G1")], [false, false]);
  assert("group archive edge: last member archived — current week untouched", r.weeklyTimetables[CUR + "|S"] === wtt[CUR + "|S"], true);

  // A name that is not the members' first names is treated as typed and kept.
  const t = runArchive("dan", IN_TERM, [FUT]).r;
  assert("group archive edge: typed group name kept", t.groups.find(g => g.id === "G4").name, "Ukulele Club");
  assert("group archive edge: typed group name reported", t.typedNamesKept, ["G4"]);
  const tc = cardOf(t.lessons, "G4");
  assert("group archive edge: typed-name card keeps its label but drops the child",
    [tc.groupName, tc.studentIds, tc.studentNames], ["Ukulele Club", ["eve"], ["Eve Eld"]]);

  // The band holding Ivy through G2, and the G2 card in its ledger, are untouched.
  const b = runArchive("libby", IN_TERM, [FUT]);
  const before = b.wtt[FUT + "|S"].lessons.find(l => l.isBandSession);
  const after = b.r.weeklyTimetables[FUT + "|S"].lessons.find(l => l.isBandSession);
  assert("group archive edge: band session, members and ledger are the same objects",
    [after === before, after.removedLessons === before.removedLessons, after.memberStates === before.memberStates], [true, true, true]);

  // Collections not passed come back undefined (each setter passes its own).
  const only = archiveStudentCascade({ studentId: "ivy", archiveDate: IN_TERM, termBreaks: TERM_BREAKS, groups: GGROUPS,
    students: GSTUDENTS, enrolments: GENROL });
  assert("group archive edge: collections left out come back undefined",
    [only.lessons, only.unscheduled, only.weeklyTimetables], [undefined, undefined, undefined]);
  assert("group archive edge: groupsToUpdate is rewritten from the plan",
    archiveStudentCascade({ studentId: "ivy", archiveDate: IN_TERM, termBreaks: TERM_BREAKS, groups: GGROUPS,
      students: GSTUDENTS, enrolments: GENROL, groupsToUpdate: [G("G2")] }).groups.map(g => g.studentIds), [["libby"]]);
  assert("group archive edge: unscheduled entries for the child are removed",
    archiveStudentCascade({ studentId: "amy", archiveDate: IN_TERM, termBreaks: TERM_BREAKS, groups: GGROUPS,
      students: GSTUDENTS, enrolments: GENROL, unscheduled: [{ student: { id: "amy" } }, { student: { id: "bob" } }] })
      .unscheduled.map(u => u.student.id), ["bob"]);
}

// ── The group sync effect (App) after an archive ─────────────────────────
// App re-syncs every master group card to its group record whenever groups
// change. Run its per-card rule over the cascade's output: every card must
// come back as the same object, so the effect never re-adds the child, never
// relabels, and never touches the re-pointed enrolmentId.
export function runGroupArchiveSyncTests(assert) {
  const cases = [["ann", IN_TERM], ["ben", IN_TERM], ["cat", IN_TERM], ["ivy", IN_TERM], ["libby", IN_TERM],
    ["dan", IN_TERM], ["zoe", IN_TERM], ["ivy", BETWEEN], ["libby", BETWEEN]];
  for (const [sid, date] of cases) {
    const { r } = runArchive(sid, date, [FUT]);
    const synced = r.lessons.map(l => syncCardToGroup(l, r.groups, studentsAfter(sid)));
    assert(`group archive sync: archive ${sid} (${date}) — sync effect leaves every master card as it is`,
      synced.every((l, i) => l === r.lessons[i]), true);
  }
  // A later edit to another group still leaves the shrunken group's card alone.
  const { r } = runArchive("libby", IN_TERM, [FUT]);
  const later = r.groups.map(g => (g.id === "G3" ? { ...g, notes: "edited" } : g));
  const m = cardOf(r.lessons, "G2");
  const after = syncCardToGroup(m, later, studentsAfter("libby"));
  assert("group archive sync: a later groups change keeps the child off and the enrolment re-point",
    [after === m, after.studentIds, after.enrolmentId], [true, ["ivy"], "e_ivy_g2"]);
  // The rule itself (unchanged): a card still listing the child is re-synced
  // from the record — which is why the record must lose the child too.
  const stale = { ...m, studentIds: ["ivy", "libby"], studentNames: ["Ivy O'Donnell", "Libby Gilby"] };
  assert("group archive sync: rule still re-syncs a stale card from the group record",
    syncCardToGroup(stale, r.groups, GSTUDENTS).studentIds, ["ivy"]);
}
