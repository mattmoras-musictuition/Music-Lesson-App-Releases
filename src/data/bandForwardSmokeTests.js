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
  applyStudentAttribution, applyAttributionLedger,
} from "./bandMemberStates";
import { deriveTallyRows, getEnrolmentTermDeductionMath } from "../utils/tallyDerive";
import { isLessonPresentThisWeek } from "../utils/weeklyPresence";
import { buildMttImportForWeekSchool } from "../utils/mttImport";
import { makeEnrolmentResolver } from "../utils/enrolmentActivity";
import { lweekDates } from "./bandLedgerSmokeTests";
import { buildForwardIndex, forwardFor } from "./bandForwardIndex";
import { openForwardWeeks, isLessonDayClosed, forwardTermWeeks, forwardLessonContext, forwardWeekLabel } from "./bandForward";
import { GW, GROUP_UKE, GENROL, INDIVIDUAL_MEMBERS, D15_SNAPSHOT, quietBuild, gentry as ugentry, groupCard, soloCard } from "./bandGroupSmokeTests";

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
  // Slice 1 deliberately changes this (commit 3): the week is now KEPT. Was null.
  assert("forward char: planAttributionSave keeps a forward entry's week (no row written or deleted) — was dropped before slice 1",
    [plan.memberStates[0].consumption, plan.memberStates[0].consumedWeekKey, plan.inserts.length, plan.deletes.length, plan.changed],
    ["forward", FX, 0, 0, true]);
  // … and a change of week alone is reported as no change.
  plan = planAttributionSave({
    stored: [fentry(eAG, "forward", { consumedWeekKey: "2020-03-16" })], working: [fentry(eAG, "forward", { consumedWeekKey: FX })],
    missByEnrolment: {}, catchupsForBand: [], weekKey: FB,
  });
  // Slice 1 deliberately changes this (commit 3): a week-only change is a change. Was false.
  assert("forward char: a forward week-only change is a change — was no change before slice 1",
    [plan.changed, plan.memberStates[0].consumedWeekKey], [true, FX]);

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
  // Slice 1 deliberately changes this (commit 4): the given-up week now ticks
  // from the band. Was ["blank", "blank"]. The band week still ticks nothing.
  assert("forward char: forward ticks the given-up week, not the band week — was neither before slice 1",
    [d.view["amy|Guitar"][FB], d.view["amy|Guitar"][FX]], ["blank", "completed:band"]);
  d = ftally({ students: [amy], enrolments: [eAG], wtt: {
    [FB + "|S"]: { lessons: [fwdBand, fcard("OWN_B", eAG)], missed: [] },
    [FX + "|S"]: { lessons: [fcard("OWN_X", eAG)], missed: [] },
  } });
  // Slice 1 deliberately changes this (commit 4): in the given-up week the
  // forward tick shows even with the own card still there (the hover says so).
  // Was ["completed:OWN_B", "completed:OWN_X"].
  assert("forward char: own card ticks the band week; the given-up week shows the forward tick — was the own card before slice 1",
    [d.view["amy|Guitar"][FB], d.view["amy|Guitar"][FX]], ["completed:OWN_B", "completed:band"]);

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
  // Slice 1 deliberately changes this (commit 3): groups accept forward, with
  // a week. Without a week the input is still returned. Was refused outright.
  assert("forward char: groups accept forward only with a week — was refused before slice 1",
    [GROUP_CONSUMPTIONS.includes("forward"), applyGroupAttribution(both, "g_uke", "forward", GW) === both,
      applyGroupAttribution(both, "g_uke", "forward", GW, null, FX).map(e => [e.consumption, e.consumedWeekKey])],
    [true, true, [["forward", FX], ["forward", FX]]]);
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

// ── Commit 3: save path (D2, D5, D6, D7) ──
export function runBandForwardSaveTests(assert) {
  const eAG = fenrol("e_amy_gtr", "amy", "Guitar");
  const eBD = fenrol("e_bob_drm", "bob", "Drums");
  const save = (stored, working, extra = {}) => planAttributionSave({ stored, working, missByEnrolment: {}, catchupsForBand: [], weekKey: W2, ...extra });

  // D2 — week kept, no catchups row either way.
  let p = save([fentry(eAG, null)], [fentry(eAG, "forward", { consumedWeekKey: W6 })], { forwardWeekOpen: () => true });
  assert("forward save: unattributed → forward keeps the week; no row inserted or deleted; nothing ledgered",
    [p.memberStates[0].consumedWeekKey, p.memberStates[0].catchupId, p.inserts.length, p.deletes.length, p.regularOn.length, p.regularOff.length, p.changed, p.rejected],
    [W6, null, 0, 0, 0, 0, true, []]);

  // D5 — a week-only change is saved.
  p = save([fentry(eAG, "forward", { consumedWeekKey: W6 })], [fentry(eAG, "forward", { consumedWeekKey: W5 })], { forwardWeekOpen: () => true });
  assert("forward save: a change of week alone is a change and is saved",
    [p.changed, p.memberStates[0].consumedWeekKey, p.inserts.length, p.deletes.length], [true, W5, 0, 0]);

  // D5 — an invalid week is rejected: that student kept as stored, others saved.
  const okWeek = (e) => e.consumedWeekKey !== W6;
  p = save([fentry(eAG, null), fentry(eBD, null)], [fentry(eAG, "forward", { consumedWeekKey: W6 }), fentry(eBD, "free")], { forwardWeekOpen: okWeek });
  assert("forward save: a week no longer open is rejected — the row stays as stored, the other row still saves",
    [p.rejected, p.memberStates.map(e => [e.consumption, e.consumedWeekKey]), p.changed],
    [[{ studentId: "amy", enrolmentId: "e_amy_gtr", groupId: null, consumedWeekKey: W6 }], [[null, null], ["free", null]], true]);
  p = save([fentry(eAG, "forward", { consumedWeekKey: W5 })], [fentry(eAG, "forward", { consumedWeekKey: W6 })], { forwardWeekOpen: okWeek });
  assert("forward save: moving to a closed week is rejected and the stored week kept",
    [p.rejected.length, p.memberStates[0].consumedWeekKey, p.changed], [1, W5, false]);
  p = save([fentry(eAG, null)], [fentry(eAG, "forward", { consumedWeekKey: null })]);
  assert("forward save: forward with no week is always rejected",
    [p.rejected.length, p.memberStates[0].consumption], [1, null]);
  p = save([fentry(eAG, "forward", { consumedWeekKey: W6 }), fentry(eBD, null)],
    [fentry(eAG, "forward", { consumedWeekKey: W6 }), fentry(eBD, "free")], { forwardWeekOpen: () => false });
  assert("forward save: an UNCHANGED stored forward is never re-checked (a stale week cannot block another row's save)",
    [p.rejected, p.memberStates[0].consumedWeekKey, p.memberStates[1].consumption], [[], W6, "free"]);
  p = save([fentry(eAG, "regular", { consumedWeekKey: W2 })], [fentry(eAG, "forward", { consumedWeekKey: W6 })],
    { forwardWeekOpen: () => false, absentEnrolmentIds: ["e_amy_gtr"] });
  assert("forward save: an absence lock still wins (no rejection reported, stored kept)",
    [p.rejected, p.memberStates[0].consumption], [[], "regular"]);
  // The second instrument of a rejected student is kept as stored too.
  const eAP = fenrol("e_amy_pno", "amy", "Piano");
  p = save([fentry(eAG, null), fentry(eAP, "free")],
    applyStudentAttribution([fentry(eAG, null), fentry(eAP, "free")], "amy", "e_amy_gtr", "forward", W6), { forwardWeekOpen: () => false });
  assert("forward save: rejection keeps every entry of that student as stored",
    p.memberStates.map(e => [e.enrolmentId, e.consumption]), [["e_amy_gtr", null], ["e_amy_pno", "free"]]);

  // Leaving forward follows the destination role's rule.
  p = save([fentry(eAG, "forward", { consumedWeekKey: W6 })], [fentry(eAG, "free", { consumedWeekKey: W6 })]);
  assert("forward save: forward → Free clears the week",
    [p.memberStates[0].consumedWeekKey, p.changed, p.deletes.length], [null, true, 0]);
  p = save([fentry(eAG, "forward", { consumedWeekKey: W6 })], [fentry(eAG, "regular", { consumedWeekKey: W6 })]);
  assert("forward save: forward → Regular takes the band's week and ledgers the card",
    [p.memberStates[0].consumedWeekKey, p.regularOn.length], [W2, 1]);
  const cuRow = { id: "CU1", resolvesEnrolmentId: "e_amy_gtr", resolvesWeekKey: "2099-02-02", resolvesOriginalDay: "Thursday", resolvesOriginalTime: "09:00" };
  p = save([fentry(eAG, "catchup", { catchupId: "CU1", consumedWeekKey: "2099-02-02" })], [fentry(eAG, "forward", { consumedWeekKey: W6 })],
    { catchupsForBand: [cuRow], forwardWeekOpen: () => true });
  assert("forward save: catch-up → forward deletes only the catch-up's own row (catch-up's leave rule), inserts nothing",
    [p.deletes.map(d => d.id), p.inserts.length, p.memberStates[0].catchupId, p.memberStates[0].consumedWeekKey], [["CU1"], 0, null, W6]);

  // D6 — Regular → forward restores the band-week card through the existing path.
  const card = fcard("W_AG", eAG, { day: "Tuesday", start: "09:00" });
  const regBand = fband("B1", [fentry(eAG, "regular", { consumedWeekKey: W2 })], { removedLessons: [card] });
  p = save(regBand.memberStates, [fentry(eAG, "forward", { consumedWeekKey: W6 })], { forwardWeekOpen: () => true });
  const out = applyAttributionLedger({ lessons: [regBand], bandLessonId: "B1", regularOn: p.regularOn, regularOff: p.regularOff,
    memberStates: p.memberStates, resolver: makeEnrolmentResolver([eAG]) });
  assert("forward save: Regular → forward puts the band-week card back on the grid and empties the ledger",
    [out.lessons.filter(l => !l.isBandSession).map(l => l.id), out.lessons.find(l => l.id === "B1").removedLessons.length, out.dropped],
    [["W_AG"], 0, []]);

  // D7 — a group: one week for every entry, saved together.
  const BOTH_REG = [ugentry("e_libby_uke", "libby", "regular"), ugentry("e_ivy_uke", "ivy", "regular")];
  const gWorking = applyGroupAttribution(BOTH_REG, "g_uke", "forward", GW, [], W6);
  p = planAttributionSave({ stored: BOTH_REG, working: gWorking, missByEnrolment: {}, catchupsForBand: [], weekKey: GW, forwardWeekOpen: () => true });
  assert("forward save (group): every entry of the group takes the same week; both leave Regular",
    [p.memberStates.map(e => [e.consumption, e.consumedWeekKey]), p.regularOff.length, p.inserts.length, p.deletes.length],
    [[["forward", W6], ["forward", W6]], 2, 0, 0]);
  const gb = { id: "B1", isBandSession: true, memberStates: BOTH_REG, removedLessons: [groupCard()], day: "Tuesday", start: "13:30" };
  const gOut = applyAttributionLedger({ lessons: [gb], bandLessonId: "B1", regularOn: p.regularOn, regularOff: p.regularOff,
    memberStates: p.memberStates, resolver: makeEnrolmentResolver(GENROL) });
  assert("forward save (group): Regular → forward puts the shared group card back once",
    [gOut.lessons.filter(l => !l.isBandSession).map(l => l.id), gOut.lessons.find(l => l.id === "B1").removedLessons.length], [["W_UKE"], 0]);
  p = planAttributionSave({ stored: BOTH_REG, working: gWorking, missByEnrolment: {}, catchupsForBand: [], weekKey: GW, forwardWeekOpen: () => false });
  assert("forward save (group): a closed week rejects the whole group (both members kept as stored)",
    [p.rejected.map(r => r.groupId), p.memberStates.map(e => e.consumption)], [["g_uke", "g_uke"], ["regular", "regular"]]);
  assert("forward save (group): switching the group to Free clears the week on every entry",
    applyGroupAttribution(gWorking, "g_uke", "free", GW).map(e => e.consumedWeekKey), [null, null]);

  // Bands with no forward are untouched.
  assert("forward save: D15 — an individuals-only band still builds byte-identically",
    JSON.stringify(quietBuild(INDIVIDUAL_MEMBERS, GENROL, GW, { groups: [GROUP_UKE] })), D15_SNAPSHOT);
  const lp = soloCard("W_LP", "e_liri_pno", "Tuesday", "09:00");
  const indiv = quietBuild(INDIVIDUAL_MEMBERS, GENROL, GW, { groups: [GROUP_UKE] });
  const reg = applyStudentAttribution(indiv, "liri", "e_liri_pno", "regular", GW);
  p = planAttributionSave({ stored: indiv, working: reg, missByEnrolment: {}, catchupsForBand: [], weekKey: GW });
  assert("forward save: a no-forward plan is unchanged apart from an empty rejected list",
    [p.regularOn.map(e => e.enrolmentId), p.changed, p.rejected, p.memberStates.filter(e => e.consumption).map(e => [e.enrolmentId, e.consumedWeekKey]), lp.id],
    [["e_liri_pno"], true, [], [["e_liri_pno", GW]], "W_LP"]);

  // Window helpers.
  const breaks = [
    { type: "term_break", date: "2099-04-04", endDate: "2099-04-19" },
    { type: "term_break", date: "2099-06-27", endDate: "2099-07-12" },
  ];
  const tw = forwardTermWeeks(breaks, "2099-05-04");
  assert("forward helpers: forwardTermWeeks gives the band's term — school weeks then its holiday weeks",
    [tw[0].weekKey, tw.filter(w => !w.isHoliday).length, tw.some(w => w.isHoliday), tw.find(w => w.weekKey === "2099-05-04").weekNum], ["2099-04-20", 10, true, 3]);
  const holidayBand = "2099-04-06";
  assert("forward helpers: a band in the holiday break has no week to bring forward (D4)",
    openForwardWeeks({ subject: { enrolment: eAG }, bandWeekKey: holidayBand, termWeeks: forwardTermWeeks(breaks, holidayBand), weeklyTimetables: {} }), []);
  assert("forward helpers: forwardTermWeeks with no term breaks → []", forwardTermWeeks([], "2099-05-04"), []);
  const masters = [fmtt(eAG, { schoolId: "T", day: "Wednesday" }), { id: "MG", isGroup: true, groupId: "g_uke", schoolId: "S", day: "Thursday" }];
  assert("forward helpers: lesson context from the master card (solo, group, fallback)",
    [forwardLessonContext({ enrolment: eAG }, masters, []),
      forwardLessonContext({ groupId: "g_uke", enrolments: [{ studentId: "ivy" }] }, masters, []),
      forwardLessonContext({ enrolment: eBD }, masters, [fstudent("bob", "S")])],
    [{ schoolId: "T", lessonDay: "Wednesday" }, { schoolId: "S", lessonDay: "Thursday" }, { schoolId: "S", lessonDay: "" }]);
  assert("forward helpers: week label", forwardWeekLabel(10), "Week 10");
}

// ── Commit 4: Tally (D9) ──
export function runBandForwardTallyTests(assert) {
  const amy = fstudent("amy");
  const eAG = fenrol("e_amy_gtr", "amy", "Guitar");
  const fwd = (extra = {}, consumed = FX) => fband("B1", [fentry(eAG, "forward", { consumedWeekKey: consumed, ...extra })]);
  const run = (wtt, weeks) => ftally({ students: [amy], enrolments: [eAG], wtt, weeks });

  // Timing: the BAND's day and week decide, not the given-up week's.
  const FUT_B = "2099-03-09", FUT_X = "2099-03-23";
  const mixed = [{ weekKey: FB, label: "W1", weekNum: 1 }, { weekKey: FUT_X, label: "W2", weekNum: 2 }];
  let d = run({ [FB + "|S"]: { lessons: [fwd({}, FUT_X)], missed: [] } }, mixed);
  assert("forward tally: band day past 6pm → the (future) given-up week already ticks",
    d.view["amy|Guitar"][FUT_X], "completed:band");
  const future = [{ weekKey: FUT_B, label: "W1", weekNum: 1 }, { weekKey: FUT_X, label: "W2", weekNum: 2 }];
  d = run({ [FUT_B + "|S"]: { lessons: [fwd({}, FUT_X)], missed: [] } }, future);
  assert("forward tally: band day not yet past 6pm → nothing in the given-up week yet",
    d.view["amy|Guitar"][FUT_X], "blank:band");

  // Hover, both forms, through the band-cell tooltip (shim notes, bandSession).
  d = run({ [FB + "|S"]: { lessons: [fwd()], missed: [] } });
  let shim = d.entryMap["amy|Guitar|" + FX];
  assert("forward tally: hover reads \"Extra lesson in week N\" (N = the band's term week); a normal completed tick",
    [shim.status, shim.bandSession, shim.notes], ["completed", true, "Extra lesson in week 2"]);
  d = run({ [FB + "|S"]: { lessons: [fwd()], missed: [] }, [FX + "|S"]: { lessons: [fcard("OWN_X", eAG)], missed: [] } });
  shim = d.entryMap["amy|Guitar|" + FX];
  assert("forward tally: own card still on the timetable → the hover says so",
    [d.view["amy|Guitar"][FX], shim.notes], ["completed:band", "Extra lesson in week 2 · regular lesson still on the timetable"]);

  // Precedence: a miss beats the forward tick.
  const miss = { id: "MS", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", schoolId: "S", day: "Thursday", reason: "sick", makeupEligible: true, madeUp: false };
  d = run({ [FB + "|S"]: { lessons: [fwd()], missed: [] }, [FX + "|S"]: { lessons: [], missed: [miss] } });
  assert("forward tally: a miss in the given-up week beats the forward tick",
    d.view["amy|Guitar"][FX], "missed-makeup-owed:MS");
  d = run({ [FB + "|S"]: { lessons: [fwd({ attended: false })], missed: [] } });
  assert("forward tally: an entry marked attended:false ticks nothing",
    d.view["amy|Guitar"][FX], "blank");

  // A band in another school's row still ticks the student's row.
  d = run({ [FB + "|T"]: { lessons: [fband("B2", [fentry(eAG, "forward", { consumedWeekKey: FX })], { schoolId: "T" })], missed: [] } });
  assert("forward tally: a band in another school's row ticks the given-up week",
    d.view["amy|Guitar"][FX], "completed:band");

  // Inactive weeks stay inactive; other weeks are untouched.
  d = ftally({ students: [amy], enrolments: [{ ...eAG, endDate: "2020-03-15" }], wtt: { [FB + "|S"]: { lessons: [fwd()], missed: [] } } });
  assert("forward tally: an ended enrolment's given-up week stays inactive",
    d.view["amy|Guitar"][FX], "inactive");
  d = run({ [FB + "|S"]: { lessons: [fwd(), fcard("OWN_B", eAG)], missed: [] }, "2020-03-16|S": { lessons: [fcard("OWN_3", eAG)], missed: [] } });
  assert("forward tally: band week and other weeks keep their own cards",
    [d.view["amy|Guitar"][FB], d.view["amy|Guitar"]["2020-03-16"]], ["completed:OWN_B", "completed:OWN_3"]);

  // A forward for the PIANO enrolment never ticks the guitar row.
  const eAP = fenrol("e_amy_pno", "amy", "Piano");
  d = ftally({ students: [amy], enrolments: [eAG, eAP], wtt: { [FB + "|S"]: { lessons: [fband("B1", [fentry(eAG, null), fentry(eAP, "forward", { consumedWeekKey: FX })])], missed: [] } } });
  assert("forward tally: multi-instrument — only the forward instrument's row ticks",
    [d.view["amy|Piano"][FX], d.view["amy|Guitar"][FX]], ["completed:band", "blank"]);

  // Group rows tick by groupId.
  const libby = fstudent("libby"), ivy = fstudent("ivy");
  const eL = fenrol("e_libby_uke", "libby", "Ukulele", { isGroup: true, groupId: "g_uke" });
  const eI = fenrol("e_ivy_uke", "ivy", "Ukulele", { isGroup: true, groupId: "g_uke" });
  const gEntries = [fentry(eL, "forward", { consumedWeekKey: FX, groupId: "g_uke", isGroup: true }), fentry(eI, "forward", { consumedWeekKey: FX, groupId: "g_uke", isGroup: true })];
  const gCards = [{ id: "MG", isGroup: true, groupId: "g_uke", enrolmentId: "e_ivy_uke", studentId: "ivy", instrument: "Ukulele", schoolId: "S", day: "Thursday", start: "10:00" }];
  d = ftally({ students: [libby, ivy], enrolments: [eL, eI], cards: gCards, wtt: { [FB + "|S"]: { lessons: [fband("B1", gEntries)], missed: [] } } });
  assert("forward tally (group): the group row ticks the given-up week",
    d.view["group|g_uke"][FX], "completed:band");
  d = ftally({ students: [libby, ivy], enrolments: [eL, eI], cards: gCards, wtt: {
    [FB + "|S"]: { lessons: [fband("B1", gEntries)], missed: [] },
    [FX + "|S"]: { lessons: [], missed: [{ id: "GM", isGroup: true, groupId: "g_uke", studentId: "ivy", instrument: "Ukulele", day: "Thursday", reason: "sick", makeupEligible: true }] } } });
  assert("forward tally (group): a whole-group miss beats the group's forward tick",
    d.view["group|g_uke"][FX], "missed-makeup-owed:GM");

  // Previous-term export calls deriveTallyRows with that term's weeks — the
  // forward follows it; a band outside the given weeks is not scanned.
  const prevWeeks = [{ weekKey: FB, label: "W7", weekNum: 7 }, { weekKey: FX, label: "W9", weekNum: 9 }];
  d = run({ [FB + "|S"]: { lessons: [fwd()], missed: [] } }, prevWeeks);
  assert("forward tally: previous-term weeks — tick plus that term's week number in the hover",
    [d.view["amy|Guitar"][FX], d.entryMap["amy|Guitar|" + FX].notes], ["completed:band", "Extra lesson in week 7"]);
  d = run({ "2020-03-02|S": { lessons: [fwd()], missed: [] } }, prevWeeks);
  assert("forward tally: a band outside the term's weeks is not read",
    d.view["amy|Guitar"][FX], "blank");

  // Tiles count the cell — the shim is an ordinary completed entry.
  d = run({ [FB + "|S"]: { lessons: [fwd()], missed: [] } });
  assert("forward tally: tiles see one completed cell for the forward tick",
    Object.values(d.entryMap).filter(x => x.status === "completed").length, 1);

  // Invoice math is identical with and without forward entries.
  const prevTerm = { start: "2020-02-03", end: "2020-04-03" };
  const math = (wtt) => getEnrolmentTermDeductionMath({ weeklyTimetables: wtt, catchups: [], enrolmentId: "e_amy_gtr", instrument: "Guitar",
    prevTerm, interruptions: [], nextTermStart: "2020-04-20" });
  const base = { "2020-03-16|S": { lessons: [], missed: [miss] } };
  const withFwd = { ...base, [FB + "|S"]: { lessons: [fwd()], missed: [] } };
  const withFree = { ...base, [FB + "|S"]: { lessons: [fband("B1", [fentry(eAG, "free")])], missed: [] } };
  assert("forward tally: invoice math identical with and without a forward entry",
    [math(withFwd), math(withFree), math(base)].map(m => JSON.stringify(m)),
    Array(3).fill(JSON.stringify({ mkpEligPending: 1, catchups: 0, deductions: 1, extras: 0 })));
}
