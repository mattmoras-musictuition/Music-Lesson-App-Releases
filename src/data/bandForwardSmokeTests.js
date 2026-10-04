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
