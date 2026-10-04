// ============================================================
// BAND FORWARD SMOKE TESTS
// Band Session Attribution phase 3, slice 1 — the "forward" arm ("Lesson
// brought forward"): the band attendance uses up a LATER open week of the
// same term. Owner-approved spec change: forward lives ONLY on the
// memberStates entry (consumption "forward" + consumedWeekKey); no catchups
// row is ever written for it, because every catchups row counts toward Extra
// Lessons in getEnrolmentTermDeductionMath.
//
// The characterization block pins how the code treats forward BEFORE the
// slice. isDayPast6pm reads the real clock, so "past" weeks sit in 2020 and
// import fixtures in 2099.
// ============================================================

import {
  planAttributionSave, isGenerateExcluded, applyGroupAttribution, GROUP_CONSUMPTIONS,
} from "./bandMemberStates";
import { deriveTallyRows, getEnrolmentTermDeductionMath } from "../utils/tallyDerive";
import { isLessonPresentThisWeek } from "../utils/weeklyPresence";
import { buildMttImportForWeekSchool } from "../utils/mttImport";
import { makeEnrolmentResolver } from "../utils/enrolmentActivity";
import { lweekDates } from "./bandLedgerSmokeTests";
import { buildForwardIndex, forwardFor } from "./bandForwardIndex";
import { openForwardWeeks, isLessonDayClosed } from "./bandForward";
import { GW, GROUP_UKE } from "./bandGroupSmokeTests";

// Past term weeks (2020): the band sits in FB, the given-up week is FX.
export const FB = "2020-03-09";
export const FX = "2020-03-23";
export const FWEEKS = [
  { weekKey: "2020-03-02", label: "W1", weekNum: 1 },
  { weekKey: FB, label: "W2", weekNum: 2 },
  { weekKey: "2020-03-16", label: "W3", weekNum: 3 },
  { weekKey: FX, label: "W4", weekNum: 4 },
];

export const fstudent = (id, schoolId = "S") => ({ id, name: id, schoolId, status: "active" });
export const fenrol = (id, studentId, instrument, extra = {}) => ({ id, studentId, instrument, startDate: "2020-01-01", ...extra });
export const fmtt = (e, extra = {}) => ({ id: "M_" + e.id, enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day: "Thursday", start: "09:00", end: "09:30", ...extra });
export const fcard = (id, e, extra = {}) => ({ id, enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day: "Thursday", start: "09:00", end: "09:30", ...extra });
export const fentry = (e, consumption, extra = {}) => ({
  enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, consumption,
  catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null, ...extra,
});
export const fband = (id, memberStates, extra = {}) => ({
  id, isBandSession: true, bandId: "BAND", bandName: "Riptide", schoolId: "S", day: "Tuesday", start: "11:00", end: "11:30",
  members: [], removedLessons: [], memberStates, ...extra,
});

// Compact Tally view: per lessonKey, per week, state + source ("band", card id).
export function ftally({ students, enrolments, wtt, cards, weeks = FWEEKS }) {
  const { tallyRows, entryMap } = deriveTallyRows({
    enrolments, students, termWeeks: weeks, weeklyTimetables: wtt,
    timetable: { lessons: cards || enrolments.map(e => fmtt(e)) }, schoolFilter: "all",
  });
  const view = {};
  for (const r of tallyRows) {
    view[r.lessonKey] = {};
    for (const w of weeks) {
      const c = r.cells[w.weekKey];
      const src = !c.wttEntry ? "" : (c.wttEntry.isBandSession ? "band" : c.wttEntry.id);
      view[r.lessonKey][w.weekKey] = c.state + (src ? ":" + src : "");
    }
  }
  return { view, entryMap, tallyRows };
}

// ── Commit 1: characterization — pinned against unchanged code ──
export function runBandForwardCharacterizationTests(assert) {
  const amy = fstudent("amy");
  const eAG = fenrol("e_amy_gtr", "amy", "Guitar");

  // planAttributionSave handed forward: the week is dropped …
  let plan = planAttributionSave({
    stored: [fentry(eAG, null)], working: [fentry(eAG, "forward", { consumedWeekKey: FX })],
    missByEnrolment: {}, catchupsForBand: [], weekKey: FB,
  });
  assert("forward char: planAttributionSave drops a forward entry's week (no row written or deleted)",
    [plan.memberStates[0].consumption, plan.memberStates[0].consumedWeekKey, plan.inserts.length, plan.deletes.length, plan.changed],
    ["forward", null, 0, 0, true]);
  // … and a change of week alone is reported as no change.
  plan = planAttributionSave({
    stored: [fentry(eAG, "forward", { consumedWeekKey: "2020-03-16" })], working: [fentry(eAG, "forward", { consumedWeekKey: FX })],
    missByEnrolment: {}, catchupsForBand: [], weekKey: FB,
  });
  assert("forward char: a forward week-only change is reported as no change",
    plan.changed, false);

  // getEnrolmentTermDeductionMath counts EVERY catchups row in range — a
  // row standing for a forward (no miss behind it) would be charged.
  const prevTerm = { start: "2020-02-03", end: "2020-04-03" };
  const row = { id: "CU", weekKey: FB, day: "Tuesday", time: "11:00", instrument: "Guitar", schoolId: "S", enrolmentId: "e_amy_gtr",
    resolvesEnrolmentId: "e_amy_gtr", resolvesWeekKey: FX, resolvesOriginalDay: "Thursday", resolvesOriginalTime: "09:00", bandLessonId: "B1" };
  const math = (wtt, catchups) => getEnrolmentTermDeductionMath({ weeklyTimetables: wtt, catchups, enrolmentId: "e_amy_gtr", instrument: "Guitar",
    prevTerm, interruptions: [], nextTermStart: "2020-04-20" });
  assert("forward char: a catchups row with no miss behind it becomes one Extra Lesson",
    math({}, [row]), { mkpEligPending: 0, catchups: 1, deductions: 0, extras: 1 });
  const withForward = { [FB + "|S"]: { lessons: [fband("B1", [fentry(eAG, "forward", { consumedWeekKey: FX })])], missed: [] } };
  const withoutForward = { [FB + "|S"]: { lessons: [fband("B1", [fentry(eAG, "free")])], missed: [] } };
  assert("forward char: deduction math ignores memberStates content",
    [math(withForward, []), math(withoutForward, [])],
    [{ mkpEligPending: 0, catchups: 0, deductions: 0, extras: 0 }, { mkpEligPending: 0, catchups: 0, deductions: 0, extras: 0 }]);

  // Forward never ticks today — not in the band week, not in the given-up week.
  const fwdBand = fband("B1", [fentry(eAG, "forward", { consumedWeekKey: FX })]);
  let d = ftally({ students: [amy], enrolments: [eAG], wtt: {
    [FB + "|S"]: { lessons: [fwdBand], missed: [] },
    [FX + "|S"]: { lessons: [], missed: [] },
  } });
  assert("forward char: forward ticks nothing in the band week or the given-up week",
    [d.view["amy|Guitar"][FB], d.view["amy|Guitar"][FX]], ["blank", "blank"]);
  d = ftally({ students: [amy], enrolments: [eAG], wtt: {
    [FB + "|S"]: { lessons: [fwdBand, fcard("OWN_B", eAG)], missed: [] },
    [FX + "|S"]: { lessons: [fcard("OWN_X", eAG)], missed: [] },
  } });
  assert("forward char: own cards tick both weeks as ordinary lessons",
    [d.view["amy|Guitar"][FB], d.view["amy|Guitar"][FX]], ["completed:OWN_B", "completed:OWN_X"]);

  // A band in a DIFFERENT school's row from the student is never read.
  d = ftally({ students: [amy], enrolments: [eAG], wtt: {
    [FB + "|T"]: { lessons: [fband("B2", [fentry(eAG, "regular", { consumedWeekKey: FB })], { schoolId: "T" })], missed: [] },
  } });
  assert("forward char: a Regular band in another school's row ticks nothing on the student's row",
    d.view["amy|Guitar"][FB], "blank");

  // Generate keeps a forward member's card in the band week and any later week.
  const r = makeEnrolmentResolver([eAG]);
  const master = fmtt(eAG);
  assert("forward char: isGenerateExcluded keeps a forward member's card (band week, later week)",
    [isGenerateExcluded(master, [fwdBand], r), isGenerateExcluded(master, [], r)], [false, false]);

  // Import keeps it too: the band week (clean import) and a later week.
  const XW = "2099-03-23";
  const bandWeekImport = buildMttImportForWeekSchool({ mtt: { lessons: [master] }, schoolId: "S", weekDates: lweekDates(GW),
    existingEntry: { lessons: [fband("B1", [fentry(eAG, "forward", { consumedWeekKey: XW })])], missed: [] }, dropBands: true, enrolments: [] });
  const laterImport = buildMttImportForWeekSchool({ mtt: { lessons: [master] }, schoolId: "S", weekDates: lweekDates(XW),
    existingEntry: null, dropBands: true, enrolments: [] });
  assert("forward char: import puts the forward member's card in the band week and in the later week",
    [bandWeekImport.entry.lessons.map(l => l.originId || l.enrolmentId), laterImport.entry.lessons.map(l => l.enrolmentId)],
    [["e_amy_gtr"], ["e_amy_gtr"]]);

  // Presence in a later week reads that week only.
  assert("forward char: presence in a later week — present with the card, missing without it",
    [isLessonPresentThisWeek(master, [fcard("OWN_X", eAG)], []), isLessonPresentThisWeek(master, [], [])], [true, false]);

  // Group helpers reject forward.
  const ivy = fentry({ id: "e_ivy_uke", studentId: "ivy", instrument: "Ukulele" }, "regular", { consumedWeekKey: GW, groupId: GROUP_UKE.id, isGroup: true });
  const both = [ivy, { ...ivy, enrolmentId: "e_libby_uke", studentId: "libby" }];
  assert("forward char: groups refuse forward (GROUP_CONSUMPTIONS, applyGroupAttribution returns its input)",
    [GROUP_CONSUMPTIONS.includes("forward"), applyGroupAttribution(both, "g_uke", "forward", GW) === both], [false, true]);
}

// ── Commit 2: pure helpers — the cross-week index (D8) and the open-week walk (D3) ──
// A 2099 term: six school weeks plus a trailing holiday week.
export const TW = [
  { weekKey: "2099-02-02", weekNum: 1, label: "W1" },
  { weekKey: "2099-02-09", weekNum: 2, label: "W2" },
  { weekKey: "2099-02-16", weekNum: 3, label: "W3" },
  { weekKey: "2099-02-23", weekNum: 4, label: "W4" },
  { weekKey: "2099-03-02", weekNum: 5, label: "W5" },
  { weekKey: "2099-03-09", weekNum: 6, label: "W6" },
  { weekKey: "2099-03-16", weekNum: 1, label: "H1", isHoliday: true },
];
const [, W2, W3, W4, W5, W6, H1] = TW.map(w => w.weekKey);

export function runBandForwardHelperTests(assert) {
  const eAG = fenrol("e_amy_gtr", "amy", "Guitar");
  const keys = (list) => list.map(w => w.weekKey);
  const open = (extra = {}) => keys(openForwardWeeks({ subject: { enrolment: eAG }, bandWeekKey: W2, bandLessonId: "B1",
    termWeeks: TW, weeklyTimetables: {}, schoolId: "S", lessonDay: "Thursday", ...extra }));

  assert("forward walk: every later school week, latest first (holiday week never offered)",
    open(), [W6, W5, W4, W3]);
  assert("forward walk: band in a holiday week → nothing",
    open({ bandWeekKey: H1 }), []);
  assert("forward walk: last week of term → nothing later",
    open({ bandWeekKey: W6 }), []);
  assert("forward walk: enrolment ending before W5 → W5 and W6 not offered",
    keys(openForwardWeeks({ subject: { enrolment: { ...eAG, endDate: "2099-02-28" } }, bandWeekKey: W2, termWeeks: TW, weeklyTimetables: {} })), [W4, W3]);
  assert("forward walk: enrolment starting in W4 → W3 not offered",
    keys(openForwardWeeks({ subject: { enrolment: { ...eAG, startDate: "2099-02-25" } }, bandWeekKey: W2, termWeeks: TW, weeklyTimetables: {} })), [W6, W5, W4]);

  // (b) misses of both kinds, in any school's row.
  const wttMiss = {
    [W6 + "|S"]: { lessons: [], missed: [{ id: "MS", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", day: "Thursday", reason: "sick", makeupEligible: true }] },
    [W5 + "|T"]: { lessons: [], missed: [{ id: "BM", studentId: "amy", instrument: "Guitar", day: "Tuesday", bandLessonId: "BX", reason: "sick" }] },
  };
  assert("forward walk: an ordinary miss (W6) and a band-stamped miss in another school's row (W5) close those weeks",
    open({ weeklyTimetables: wttMiss }), [W4, W3]);

  // (c) other forward entries — walks back; this band's own entry never blocks.
  const fwdIn = (bandId, weekKey, consumed, schoolId = "S", e = eAG) => ({
    [weekKey + "|" + schoolId]: { lessons: [fband(bandId, [fentry(e, "forward", { consumedWeekKey: consumed })], { schoolId })], missed: [] },
  });
  assert("forward walk: another band already uses W6 → default walks back to W5",
    open({ weeklyTimetables: fwdIn("B9", W3, W6) }), [W5, W4, W3]);
  assert("forward walk: this band's own forward in W6 keeps W6 open (re-save keeps its week)",
    open({ weeklyTimetables: fwdIn("B1", W2, W6) }), [W6, W5, W4, W3]);
  assert("forward walk: two other bands already took W6 and W5 → this band defaults to W4",
    open({ weeklyTimetables: { ...fwdIn("BA", W2, W6), ...fwdIn("BB", W2, W5, "T") }, bandLessonId: "BC" })[0], W4);
  assert("forward walk: a forward in ANOTHER school's row still blocks the week",
    open({ weeklyTimetables: fwdIn("B9", W2, W6, "T") }), [W5, W4, W3]);
  assert("forward walk: a forward for a different student does not block",
    open({ weeklyTimetables: fwdIn("B9", W2, W6, "S", fenrol("e_bob", "bob", "Guitar")) }), [W6, W5, W4, W3]);

  // (d) a Regular band entry (new) or a legacy band listing the student.
  const regIn = { [W6 + "|S"]: { lessons: [fband("BR", [fentry(eAG, "regular", { consumedWeekKey: W6 })])], missed: [] } };
  assert("forward walk: a Regular band in the last week → walks back",
    open({ weeklyTimetables: regIn }), [W5, W4, W3]);
  const legacyIn = { [W5 + "|S"]: { lessons: [{ id: "BL", isBandSession: true, day: "Tuesday", members: [{ studentId: "amy", instrument: "Guitar" }], removedLessons: [] }], missed: [] } };
  assert("forward walk: a legacy band listing the student closes that week",
    open({ weeklyTimetables: legacyIn }), [W6, W4, W3]);
  const freeIn = { [W6 + "|S"]: { lessons: [fband("BF", [fentry(eAG, "free")])], missed: [] } };
  assert("forward walk: a Free band entry does not close the week",
    open({ weeklyTimetables: freeIn }), [W6, W5, W4, W3]);

  // (e) whole-day closure on the lesson day.
  const ph = { type: "public_holiday", schoolId: "all", date: "2099-03-12", affectsClasses: "all" };   // W6 Thursday
  assert("forward walk: a whole-day public holiday on the lesson day closes the week",
    open({ interruptions: [ph] }), [W5, W4, W3]);
  assert("forward walk: a part-day or some-classes interruption, another school, or no lesson day — still open",
    [open({ interruptions: [{ ...ph, startTime: "09:00", endTime: "10:00" }] }).length,
     open({ interruptions: [{ ...ph, affectsClasses: "5A" }] }).length,
     open({ interruptions: [{ ...ph, schoolId: "T" }] }).length,
     open({ interruptions: [ph], lessonDay: "" }).length], [4, 4, 4, 4]);
  assert("forward walk: isLessonDayClosed ignores term breaks",
    isLessonDayClosed([{ ...ph, type: "term_break" }], "S", W6, "Thursday"), false);

  // Groups — whole-group misses, forward / Regular by groupId, one active member.
  const libby = fenrol("e_libby_uke", "libby", "Ukulele", { isGroup: true, groupId: "g_uke" });
  const ivy = fenrol("e_ivy_uke", "ivy", "Ukulele", { isGroup: true, groupId: "g_uke" });
  const gopen = (extra = {}) => keys(openForwardWeeks({ subject: { groupId: "g_uke", enrolments: [libby, ivy] }, bandWeekKey: W2, bandLessonId: "B1",
    termWeeks: TW, weeklyTimetables: {}, schoolId: "S", lessonDay: "Thursday", ...extra }));
  const gentry = (e, c, extra = {}) => fentry(e, c, { groupId: "g_uke", isGroup: true, ...extra });
  const gWtt = {
    [W6 + "|S"]: { lessons: [], missed: [{ id: "GM", isGroup: true, groupId: "g_uke", day: "Thursday", reason: "sick" }] },
    [W3 + "|T"]: { lessons: [fband("BG", [gentry(libby, "forward", { consumedWeekKey: W5 }), gentry(ivy, "forward", { consumedWeekKey: W5 })], { schoolId: "T" })], missed: [] },
    [W4 + "|S"]: { lessons: [fband("BR", [gentry(libby, "regular", { consumedWeekKey: W4 }), gentry(ivy, "regular", { consumedWeekKey: W4 })])], missed: [] },
  };
  assert("forward walk (group): whole-group miss, another band's group forward, a Regular group band each close a week",
    gopen({ weeklyTimetables: gWtt }), [W3]);
  assert("forward walk (group): a member's SOLO miss does not close the group's week",
    gopen({ weeklyTimetables: { [W6 + "|S"]: { lessons: [], missed: [{ id: "SM", enrolmentId: "e_libby_pno", studentId: "libby", instrument: "Piano" }] } } })[0], W6);
  assert("forward walk (group): active while at least one member is",
    keys(openForwardWeeks({ subject: { groupId: "g_uke", enrolments: [{ ...libby, endDate: "2099-02-20" }, ivy] }, bandWeekKey: W2, termWeeks: TW, weeklyTimetables: {} })),
    [W6, W5, W4, W3]);
  assert("forward walk (group): no member active after W3 → only W3",
    keys(openForwardWeeks({ subject: { groupId: "g_uke", enrolments: [{ ...libby, endDate: "2099-02-20" }, { ...ivy, endDate: "2099-02-20" }] }, bandWeekKey: W2, termWeeks: TW, weeklyTimetables: {} })),
    [W3]);

  // The index — every school's row, scoped to the given weeks.
  const idxWtt = {
    ...fwdIn("B1", W2, W6, "T"),
    [W3 + "|S"]: { lessons: [fband("B2", [gentry(libby, "forward", { consumedWeekKey: W5 }), gentry(ivy, "forward", { consumedWeekKey: W5 }), fentry(fenrol("e_noa", "noa", "Drums"), "regular", { consumedWeekKey: W3 })])], missed: [] },
    [H1 + "|S"]: { lessons: [fband("B3", [fentry(fenrol("e_zed", "zed", "Bass"), "forward", { consumedWeekKey: "2099-04-06" })])], missed: [] },
    [W4 + "|S"]: { lessons: [{ id: "BL", isBandSession: true, members: [{ studentId: "amy" }] }], missed: [] },
  };
  const idx = buildForwardIndex(idxWtt);
  const f = forwardFor(idx, eAG, W6);
  assert("forward index: a solo forward in another school's row is found with its band's week, school, name and day",
    [f.bandLessonId, f.bandWeekKey, f.schoolId, f.bandName, f.day], ["B1", W2, "T", "Riptide", "Tuesday"]);
  assert("forward index: group entries index once by groupId; Regular and legacy bands are not indexed",
    [idx.byGroup.size, forwardFor(idx, libby, W5).bandLessonId, idx.byEnrolment.size, idx.entries.length], [1, "B2", 2, 4]);
  assert("forward index: studentId + instrument fallback for a duplicate enrolment row",
    forwardFor(idx, { id: "e_amy_gtr_2", studentId: "amy", instrument: "Guitar" }, W6).bandLessonId, "B1");
  assert("forward index: nothing for another week or another student",
    [forwardFor(idx, eAG, W5), forwardFor(idx, fenrol("e_noa", "noa", "Drums"), W3)], [null, null]);
  assert("forward index: scoped to given band weeks",
    buildForwardIndex(idxWtt, [W2, W3]).entries.length, 3);
}
