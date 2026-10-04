// ============================================================
// BAND FORWARD ENFORCEMENT SMOKE TESTS
// Band Session Attribution phase 3, slice 2: the week a "Lesson brought
// forward" entry uses up (consumedWeekKey) loses the subject's regular card —
// at generation/import time, at save time, and gets it back when the entry
// stops using that week. Also the group presence-banner gap (D8).
//
// The characterization block pins behaviour BEFORE the slice. Fixture weeks
// sit in 2099 so the week-activity guards never move.
// ============================================================

import { isGenerateExcluded, planAttributionSave, applyAttributionLedger, hasMemberStates } from "./bandMemberStates";
import { generateWeeklyTimetable } from "./weeklyTimetableGenerator";
import { buildMttImportForWeekSchool } from "../utils/mttImport";
import { isLessonPresentThisWeek } from "../utils/weeklyPresence";
import { makeEnrolmentResolver, isCardInactiveForWeek } from "../utils/enrolmentActivity";
import { planRemoveBandSession, planCleanImport } from "./bandAbsence";
import { lweekDates } from "./bandLedgerSmokeTests";
import { buildForwardIndex, isForwardConsumedCard, withoutForwardConsumed } from "./bandForwardIndex";
import { generateMasterLessons, planForwardSave, consumeForwardWeeks, forwardSubjects } from "./bandForward";
import { getEnrolmentTermDeductionMath } from "../utils/tallyDerive";

// The band sits in EB; it brings forward the lesson of EX (two weeks later).
export const EB = "2099-03-09";
export const EX = "2099-03-23";
export const EY = "2099-03-30";

export const EENROL = [
  { id: "e_amy_gtr", studentId: "amy", instrument: "Guitar", startDate: "2020-01-01" },
  { id: "e_bob_drm", studentId: "bob", instrument: "Drums", startDate: "2020-01-01" },
  { id: "e_libby_uke", studentId: "libby", instrument: "Ukulele", startDate: "2020-01-01", isGroup: true, groupId: "g_uke" },
  { id: "e_ivy_uke", studentId: "ivy", instrument: "Ukulele", startDate: "2020-01-01", isGroup: true, groupId: "g_uke" },
];
export const ESTUDENTS = [
  { id: "amy", name: "Amy Ash", schoolId: "S", className: "3A", status: "active" },
  { id: "bob", name: "Bob Bell", schoolId: "T", className: "4B", status: "active" },
  { id: "libby", name: "Libby Gilby", schoolId: "S", className: "5C", status: "active" },
  { id: "ivy", name: "Ivy O'Donnell", schoolId: "S", className: "5C", status: "active" },
];
export const eresolver = () => makeEnrolmentResolver(EENROL);

// Master cards: Amy (S, Thursday), Bob (school T, Wednesday), the ukulele group (S, Thursday).
export const EMASTER = [
  { id: "M_amy", enrolmentId: "e_amy_gtr", studentId: "amy", studentName: "Amy Ash", instrument: "Guitar", schoolId: "S", day: "Thursday", start: "09:00", end: "09:30", teacherId: "t1" },
  { id: "M_bob", enrolmentId: "e_bob_drm", studentId: "bob", studentName: "Bob Bell", instrument: "Drums", schoolId: "T", day: "Wednesday", start: "10:00", end: "10:30", teacherId: "t1" },
  { id: "M_uke", isGroup: true, groupId: "g_uke", groupName: "Ukulele Group", enrolmentId: "e_ivy_uke", studentId: "ivy", studentIds: ["ivy", "libby"], studentName: "Ukulele Group",
    instrument: "Ukulele", schoolId: "S", day: "Thursday", start: "10:00", end: "10:30", teacherId: "t1" },
];
export const ESCHOOLS = [{ id: "S", name: "School S" }, { id: "T", name: "School T" }];
export const ETEACHERS = [{ id: "t1", name: "Teacher One" }];

export const eentry = (enrolmentId, consumption, extra = {}) => {
  const e = EENROL.find(x => x.id === enrolmentId);
  return { enrolmentId, studentId: e.studentId, instrument: e.instrument, consumption, catchupId: null,
    consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null,
    ...(e.isGroup ? { groupId: e.groupId, isGroup: true } : {}), ...extra };
};
export const eband = (id, memberStates, extra = {}) => ({
  id, isBandSession: true, bandId: "RIPTIDE", bandName: "Riptide", schoolId: "S", day: "Tuesday", start: "13:30", end: "14:00",
  members: [], removedLessons: [], memberStates, ...extra,
});
// A weekly card built from a master card (the import builder's shape).
export const ecard = (masterId, id, extra = {}) => {
  const m = EMASTER.find(x => x.id === masterId);
  return { ...m, id, adjusted: false, ...extra };
};
// Amy, Bob (cross-school) and the group all bring week EX's lesson forward.
export const FORWARD_BAND = eband("B1", [
  eentry("e_amy_gtr", "forward", { consumedWeekKey: EX }),
  eentry("e_bob_drm", "forward", { consumedWeekKey: EX }),
  eentry("e_libby_uke", "forward", { consumedWeekKey: EX }),
  eentry("e_ivy_uke", "forward", { consumedWeekKey: EX }),
]);

// The generator as the three generate paths call it (one school).
export function egenerate(masterLessons, schoolId, weekKey) {
  const school = ESCHOOLS.find(s => s.id === schoolId);
  return generateWeeklyTimetable(masterLessons, school, ESTUDENTS, ETEACHERS, [], [], lweekDates(weekKey), [], [], [], EENROL);
}
export const origins = (lessons) => lessons.map(l => l.enrolmentId).sort();

// ── Commit 1: characterization — pinned against unchanged code ──
export function runForwardEnforceCharacterizationTests(assert) {
  const r = eresolver();
  // The consumed week holds no band, so each generate path's master filter is
  // isGenerateExcluded against an empty band list.
  const masterFilter = (bands) => EMASTER.filter(l => !isGenerateExcluded(l, bands, r));

  const genS = egenerate(masterFilter([]), "S", EX);
  assert("forward enforce char: generate week (school S) puts Amy's and the group's cards in the consumed week",
    origins(genS.lessons), ["e_amy_gtr", "e_ivy_uke"]);
  const genAll = ["S", "T"].flatMap(s => egenerate(masterFilter([]), s, EX).lessons);
  assert("forward enforce char: generate all schools also puts Bob's card (school T, band in S's row) in the consumed week",
    origins(genAll), ["e_amy_gtr", "e_bob_drm", "e_ivy_uke"]);
  const genDay = genS.lessons.filter(l => l.day === "Thursday");
  assert("forward enforce char: generate day (Thursday) puts the consumed-week cards in",
    origins(genDay), ["e_amy_gtr", "e_ivy_uke"]);

  // Import (one school) — the same builder the Dashboard import calls.
  const imp = buildMttImportForWeekSchool({ mtt: { lessons: EMASTER }, schoolId: "S", weekDates: lweekDates(EX), existingEntry: null,
    enrolments: EENROL, dropBands: true, catchups: [] });
  assert("forward enforce char: import / Dashboard import (one builder) put the consumed-week cards in",
    imp.entry.lessons.map(l => l.enrolmentId).sort(), ["e_amy_gtr", "e_ivy_uke"]);
  // Import all — its own loop: the inactive guard, then a straight copy.
  const importAll = (schoolId) => EMASTER.filter(l => l.schoolId === schoolId).filter(l => !isCardInactiveForWeek(l, r, EX));
  assert("forward enforce char: import all schools copies every consumed-week card",
    [...importAll("S"), ...importAll("T")].map(l => l.id).sort(), ["M_amy", "M_bob", "M_uke"]);

  // Presence reads the week alone: a consumed subject with no card is flagged.
  assert("forward enforce char: presence flags a forward-consumed subject whose card is absent",
    EMASTER.map(ml => isLessonPresentThisWeek(ml, [], [])), [false, false, false]);

  // Banner gap: Regular group without its ledgered card is flagged; an individual is not.
  const regBand = eband("BR", [
    eentry("e_amy_gtr", "regular", { consumedWeekKey: EB }),
    eentry("e_libby_uke", "regular", { consumedWeekKey: EB }),
    eentry("e_ivy_uke", "regular", { consumedWeekKey: EB }),
  ]);
  // Slice 2 deliberately changes this (commit 2, D8): the group is covered too. Was [false, true].
  assert("forward enforce char: Regular group with NO ledgered card is now covered like a Regular individual — was flagged before slice 2",
    [isLessonPresentThisWeek(EMASTER[2], [regBand], []), isLessonPresentThisWeek(EMASTER[0], [regBand], [])], [true, true]);

  // Band removal and clean import touch only the band's own week.
  const bandWeek = { lessons: [FORWARD_BAND, ecard("M_amy", "W_amy_B", { day: "Thursday" })], missed: [] };
  const removed = planRemoveBandSession(bandWeek, "B1");
  assert("forward enforce char: removing the band session returns only the band week's lessons (no other week is read)",
    [removed.lessons.map(l => l.id), removed.dropped], [["W_amy_B"], []]);
  const clean = planCleanImport(bandWeek, [], { weekKey: EB, schoolId: "S" });
  assert("forward enforce char: clean import plans only the band week (no other week is read)",
    [clean.lessons.map(l => l.id), clean.removedBandIds, clean.restoreCards], [["W_amy_B"], ["B1"], []]);

  // A forward save never touches removedLessons.
  const ledgered = ecard("M_bob", "W_bob_B");
  const before = eband("B2", [eentry("e_amy_gtr", null), eentry("e_bob_drm", "regular", { consumedWeekKey: EB })], { removedLessons: [ledgered] });
  const plan = planAttributionSave({ stored: before.memberStates,
    working: [eentry("e_amy_gtr", "forward", { consumedWeekKey: EX }), before.memberStates[1]],
    missByEnrolment: {}, catchupsForBand: [], weekKey: EB, forwardWeekOpen: () => true });
  const out = applyAttributionLedger({ lessons: [before], bandLessonId: "B2", regularOn: plan.regularOn, regularOff: plan.regularOff,
    memberStates: plan.memberStates, resolver: r });
  const b2 = out.lessons.find(l => l.id === "B2");
  assert("forward enforce char: a forward save leaves removedLessons exactly as it was",
    [hasMemberStates(b2), JSON.stringify(b2.removedLessons)], [true, JSON.stringify([ledgered])]);
}

// ── Commit 2: presence (D7) and the group banner gap (D8) ──
export function runForwardEnforcePresenceTests(assert) {
  const wtt = { [EB + "|S"]: { lessons: [FORWARD_BAND], missed: [] } };
  const idx = buildForwardIndex(wtt);
  const opts = (weekKey) => ({ forwardIndex: idx, weekKey });

  assert("forward presence: the consumed week counts as scheduled for Amy, Bob (band in another school's row) and the group",
    EMASTER.map(ml => isLessonPresentThisWeek(ml, [], [], opts(EX))), [true, true, true]);
  assert("forward presence: any other week is unaffected (still flagged with no card)",
    EMASTER.map(ml => isLessonPresentThisWeek(ml, [], [], opts(EY))), [false, false, false]);
  assert("forward presence: without the index the rule is the week-only one (unchanged)",
    isLessonPresentThisWeek(EMASTER[0], [], []), false);
  const otherBob = { ...EMASTER[1], id: "M_bob2", enrolmentId: "e_bob_other", studentId: "bob", instrument: "Piano" };
  assert("forward presence: another instrument of the same student is not covered",
    isLessonPresentThisWeek(otherBob, [], [], opts(EX)), false);
  const absentIdx = buildForwardIndex({ [EB + "|S"]: { lessons: [eband("B1", [eentry("e_amy_gtr", "forward", { consumedWeekKey: EX, attended: false })])], missed: [] } });
  assert("forward presence: an entry marked attended:false does not consume (Tally's rule)",
    isLessonPresentThisWeek(EMASTER[0], [], [], { forwardIndex: absentIdx, weekKey: EX }), false);

  // isForwardConsumedCard / withoutForwardConsumed — the shared card test.
  const weekly = [ecard("M_amy", "W_amy"), ecard("M_uke", "W_uke"), ecard("M_bob", "W_bob"), FORWARD_BAND];
  assert("forward card test: consumed cards (solo, group, cross-school) match; the band never does",
    weekly.map(c => isForwardConsumedCard(c, EX, idx)), [true, true, true, false]);
  assert("forward card test: an unstamped card matches by student + instrument",
    isForwardConsumedCard({ ...ecard("M_amy", "W_x"), enrolmentId: undefined }, EX, idx), true);
  assert("forward card test: withoutForwardConsumed keeps the array when nothing goes",
    [withoutForwardConsumed(weekly, EY, idx) === weekly, withoutForwardConsumed(weekly, EX, idx).map(c => c.id)], [true, ["B1"]]);

  // D8 — the Regular group is covered with or without a ledgered card; Free is not.
  const regGroup = (removedLessons) => eband("BR", [eentry("e_libby_uke", "regular", { consumedWeekKey: EB }), eentry("e_ivy_uke", "regular", { consumedWeekKey: EB })], { removedLessons });
  assert("group banner gap: Regular group covered with and without its card in the ledger",
    [isLessonPresentThisWeek(EMASTER[2], [regGroup([ecard("M_uke", "W_uke")])], []), isLessonPresentThisWeek(EMASTER[2], [regGroup([])], [])], [true, true]);
  const freeGroup = eband("BF", [eentry("e_libby_uke", "free"), eentry("e_ivy_uke", "free")]);
  assert("group banner gap: Free / another group's Regular / legacy band still do not cover",
    [isLessonPresentThisWeek(EMASTER[2], [freeGroup], []),
      isLessonPresentThisWeek({ ...EMASTER[2], groupId: "g_other" }, [regGroup([])], []),
      isLessonPresentThisWeek(EMASTER[2], [{ id: "L", isBandSession: true, members: [{ studentId: "ivy" }] }], [])], [false, false, false]);
}

// ── Commit 3: generation-time filter on every path (D2) ──
export function runForwardEnforceGenerateTests(assert) {
  const r = eresolver();
  const wtt = { [EB + "|S"]: { lessons: [FORWARD_BAND], missed: [] } };
  const idx = buildForwardIndex(wtt);
  const gen = (schoolId, weekKey, bands = [], index = idx) => egenerate(generateMasterLessons(EMASTER, bands, r, weekKey, index), schoolId, weekKey);

  // Generate week / all schools / day.
  assert("forward D2: generate week (S) leaves Amy and the group out of the consumed week",
    origins(gen("S", EX).lessons), []);
  assert("forward D2: generate all schools also leaves Bob out (school T; his band sits in S's row)",
    ["S", "T"].flatMap(sid => origins(gen(sid, EX).lessons)), []);
  assert("forward D2: generate day (Thursday) leaves them out of that day",
    origins(gen("S", EX).lessons.filter(l => l.day === "Thursday")), []);
  assert("forward D2: generating the BAND's own week keeps every card (band-week behaviour unchanged)",
    ["S", "T"].flatMap(sid => origins(gen(sid, EB, sid === "S" ? [FORWARD_BAND] : []).lessons)).sort(), ["e_amy_gtr", "e_bob_drm", "e_ivy_uke"]);
  assert("forward D2: a week nobody brought forward generates as before",
    origins(gen("S", EY).lessons), ["e_amy_gtr", "e_ivy_uke"]);
  assert("forward D2: with no index the generate filter is the old band filter",
    origins(gen("S", EX, [], null).lessons), ["e_amy_gtr", "e_ivy_uke"]);

  // Import (one school) and the Dashboard import — one builder; day-only import too.
  const imp = (weekKey, extra = {}) => buildMttImportForWeekSchool({ mtt: { lessons: EMASTER }, schoolId: "S", weekDates: lweekDates(weekKey),
    existingEntry: null, enrolments: EENROL, dropBands: true, catchups: [], forwardIndex: idx, ...extra });
  let res = imp(EX);
  assert("forward D2: import / Dashboard import leave the consumed cards out and count them apart from not-started ones",
    [res.entry.lessons.map(l => l.enrolmentId), res.skippedForwardCount, res.skippedInactiveCount, res.importedCount], [[], 2, 0, 0]);
  res = imp(EX, { targetDay: "Thursday", existingEntry: { lessons: [], missed: [] } });
  assert("forward D2: a day-only import leaves them out of that day",
    res.entry.lessons.map(l => l.enrolmentId), []);
  res = imp(EB, { existingEntry: { lessons: [FORWARD_BAND], missed: [] } });
  assert("forward D2: importing the band's own week keeps the cards (the clean import drops the band)",
    res.entry.lessons.map(l => l.enrolmentId).sort(), ["e_amy_gtr", "e_ivy_uke"]);
  res = imp(EX, { forwardIndex: undefined });
  assert("forward D2: the builder without an index imports as before",
    res.entry.lessons.map(l => l.enrolmentId).sort(), ["e_amy_gtr", "e_ivy_uke"]);

  // Import all schools — its own loop.
  const importAll = (sid, weekKey) => withoutForwardConsumed(EMASTER.filter(l => l.schoolId === sid).filter(l => !isCardInactiveForWeek(l, r, weekKey)), weekKey, idx);
  assert("forward D2: import all schools leaves every consumed card out (both schools)",
    [...importAll("S", EX), ...importAll("T", EX)].map(l => l.id), []);

  // One subject, two forward entries in different weeks (two bands).
  const W16 = "2099-03-16";
  const two = buildForwardIndex({
    [EB + "|S"]: { lessons: [eband("B1", [eentry("e_amy_gtr", "forward", { consumedWeekKey: EX })])], missed: [] },
    [W16 + "|S"]: { lessons: [eband("B2", [eentry("e_amy_gtr", "forward", { consumedWeekKey: EY })])], missed: [] },
  });
  assert("forward D2: two forward entries in different weeks — both weeks lose Amy's card, the weeks between keep it",
    [EX, EY, W16].map(wk => origins(gen("S", wk, [], two).lessons).includes("e_amy_gtr")), [false, false, true]);
}

// ── Commit 4: save-time removal (D3, D4, D6) ──
export function runForwardEnforceSaveTests(assert) {
  const r = eresolver();
  const other = ecard("M_amy", "W_zed", { enrolmentId: "e_zed", studentId: "zed", instrument: "Bass", start: "11:00" });
  const generated = () => ({
    [EX + "|S"]: { lessons: [ecard("M_amy", "W_amy"), ecard("M_uke", "W_uke"), other], missed: [], generatedAt: "2099-03-01" },
    [EX + "|T"]: { lessons: [ecard("M_bob", "W_bob")], missed: [], generatedAt: "2099-03-01" },
  });
  const ids = (d) => (d.lessons || []).map(l => l.id);

  // D3 — an existing card leaves the used-up week and is snapshotted.
  let fw = planForwardSave({ stored: [eentry("e_amy_gtr", null)], saved: [eentry("e_amy_gtr", "forward", { consumedWeekKey: EX })], weeklyTimetables: generated() });
  assert("forward save D3: Amy's week-X card leaves that row and is snapshotted on her entry",
    [Object.keys(fw.rows), ids(fw.rows[EX + "|S"]), fw.memberStates[0].forwardCard.id, fw.removed.map(x => x.rowKey)],
    [[EX + "|S"], ["W_uke", "W_zed"], "W_amy", [EX + "|S"]]);
  assert("forward save D3: nothing is written to missed[] and no other row is touched",
    [fw.rows[EX + "|S"].missed, EX + "|T" in fw.rows], [[], false]);

  // Ungenerated week, or a generated week without the card → nothing stored.
  fw = planForwardSave({ stored: [], saved: [eentry("e_amy_gtr", "forward", { consumedWeekKey: EY })], weeklyTimetables: generated() });
  assert("forward save D3: an ungenerated week changes nothing and stores no snapshot",
    [Object.keys(fw.rows), "forwardCard" in fw.memberStates[0]], [[], false]);
  fw = planForwardSave({ stored: [], saved: [eentry("e_amy_gtr", "forward", { consumedWeekKey: EX })],
    weeklyTimetables: { [EX + "|S"]: { lessons: [other], missed: [] } } });
  assert("forward save D3: a generated week without the card stores no snapshot",
    [Object.keys(fw.rows), "forwardCard" in fw.memberStates[0]], [[], false]);

  // Cross-school: Bob's card is in school T's row although the band is in S's.
  fw = planForwardSave({ stored: [], saved: [eentry("e_bob_drm", "forward", { consumedWeekKey: EX })], weeklyTimetables: generated() });
  assert("forward save D3: the used-up row is the card's own school (T), not the band's",
    [Object.keys(fw.rows), ids(fw.rows[EX + "|T"]), fw.memberStates[0].forwardCard.schoolId], [[EX + "|T"], [], "T"]);

  // Group: one card out, one snapshot on the first group entry only.
  fw = planForwardSave({ stored: [], saved: [eentry("e_libby_uke", "forward", { consumedWeekKey: EX }), eentry("e_ivy_uke", "forward", { consumedWeekKey: EX })],
    weeklyTimetables: generated() });
  assert("forward save D3 (group): the group card leaves once; snapshot on the first group entry only",
    [ids(fw.rows[EX + "|S"]), fw.memberStates.map(e => (e.forwardCard ? e.forwardCard.id : null)), forwardSubjects(fw.memberStates)[0].forwardCard.id],
    [["W_amy", "W_zed"], ["W_uke", null], "W_uke"]);

  // D4 — removedLessons is never touched; the card is in no ledger.
  const ledgered = ecard("M_bob", "W_bob_B");
  const band = eband("B2", [eentry("e_amy_gtr", null), eentry("e_bob_drm", "regular", { consumedWeekKey: EB })], { removedLessons: [ledgered] });
  const plan = planAttributionSave({ stored: band.memberStates, working: [eentry("e_amy_gtr", "forward", { consumedWeekKey: EX }), band.memberStates[1]],
    missByEnrolment: {}, catchupsForBand: [], weekKey: EB, forwardWeekOpen: () => true });
  fw = planForwardSave({ stored: band.memberStates, saved: plan.memberStates, weeklyTimetables: generated() });
  const out = applyAttributionLedger({ lessons: [band], bandLessonId: "B2", regularOn: plan.regularOn, regularOff: plan.regularOff, memberStates: fw.memberStates, resolver: r });
  const b2 = out.lessons.find(l => l.id === "B2");
  assert("forward save D4: removedLessons unchanged by a forward save; the week-X card is in no ledger",
    [JSON.stringify(b2.removedLessons), b2.removedLessons.some(c => c.id === "W_amy"), b2.memberStates[0].forwardCard.id], [JSON.stringify([ledgered]), false, "W_amy"]);

  // Both weeks come out of one plan (the handler spreads them into one update).
  const prev = { [EB + "|S"]: { lessons: [band], missed: [] }, ...generated() };
  const next = { ...prev, ...fw.rows, [EB + "|S"]: { ...prev[EB + "|S"], lessons: out.lessons } };
  assert("forward save: band week and used-up week change in the same update",
    [next[EB + "|S"] !== prev[EB + "|S"], next[EX + "|S"] !== prev[EX + "|S"], next[EX + "|T"] === prev[EX + "|T"]], [true, true, true]);

  // D6 — repair on Save for an unchanged forward.
  const saved = [eentry("e_amy_gtr", "forward", { consumedWeekKey: EX })];
  fw = planForwardSave({ stored: saved, saved, weeklyTimetables: generated() });
  assert("forward save D6: an unchanged forward whose card is back in its week has it removed and snapshotted",
    [ids(fw.rows[EX + "|S"]), fw.memberStates[0].forwardCard.id, fw.released], [["W_uke", "W_zed"], "W_amy", []]);
  const held = [eentry("e_amy_gtr", "forward", { consumedWeekKey: EX, forwardCard: ecard("M_amy", "W_amy") })];
  fw = planForwardSave({ stored: held, saved: held, weeklyTimetables: { [EX + "|S"]: { lessons: [other], missed: [] } } });
  assert("forward save D6: an unchanged forward with its card already gone keeps its snapshot and writes nothing",
    [Object.keys(fw.rows), fw.memberStates[0] === held[0]], [[], true]);

  // Week change: the new week starts without the old snapshot; the old one is released.
  fw = planForwardSave({ stored: held, saved: [{ ...held[0], consumedWeekKey: EY }], weeklyTimetables: generated() });
  assert("forward save: a week change drops the old snapshot from the entry and reports the old week as released",
    ["forwardCard" in fw.memberStates[0], fw.released.map(x => [x.weekKey, x.snapshot && x.snapshot.id])], [false, [[EX, "W_amy"]]]);
  // Leaving forward strips the snapshot too.
  fw = planForwardSave({ stored: held, saved: [{ ...held[0], consumption: "free", consumedWeekKey: null }], weeklyTimetables: generated() });
  assert("forward save: leaving forward strips the snapshot and reports the week as released",
    ["forwardCard" in fw.memberStates[0], fw.released.length, Object.keys(fw.rows)], [false, 1, []]);

  // consumeForwardWeeks returns the same memberStates array when nothing moves.
  const plain = [eentry("e_amy_gtr", "free")];
  assert("forward save: no forward entries → memberStates untouched, no rows",
    [consumeForwardWeeks(generated(), plain).memberStates === plain, Object.keys(consumeForwardWeeks(generated(), plain).rows)], [true, []]);

  // Invoice math identical with the card removed (it reads misses and catchups only).
  const math = (wtt) => JSON.stringify(getEnrolmentTermDeductionMath({ weeklyTimetables: wtt, catchups: [], enrolmentId: "e_amy_gtr", instrument: "Guitar",
    prevTerm: { start: "2099-02-02", end: "2099-04-03" }, interruptions: [], nextTermStart: "2099-04-20" }));
  fw = planForwardSave({ stored: [], saved: [eentry("e_amy_gtr", "forward", { consumedWeekKey: EX })], weeklyTimetables: generated() });
  assert("forward save: invoice math identical before and after the week-X card is removed",
    math({ ...generated(), ...fw.rows }), math(generated()));
}
