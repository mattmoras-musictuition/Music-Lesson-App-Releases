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
  assert("forward enforce char: Regular group with NO ledgered card → flagged; Regular individual with none → covered",
    [isLessonPresentThisWeek(EMASTER[2], [regBand], []), isLessonPresentThisWeek(EMASTER[0], [regBand], [])], [false, true]);

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
