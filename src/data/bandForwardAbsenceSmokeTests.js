// ============================================================
// BAND FORWARD ABSENCE SMOKE TESTS
// Band Session Attribution phase 3, refinements 1 and 2:
//   R1 — a "Lesson brought forward" member (or whole group) can be marked
//        absent from the band. Catch-up owed gives the later week back;
//        no catch-up keeps it used up and the Tally shows the red X there.
//   R2 — a stale given-up week is flagged (Dashboard chip + window note).
//
// The characterization block pins how the code treats a forward member's
// absence BEFORE any of this exists. The protected modules
// (bandSessionView.js, bandAbsence.js, bandMemberStates.js) never change;
// the admin side wraps them.
// ============================================================

import { eligibleForAbsence, absentMembers, absentEnrolmentIds } from "./bandAbsence";
import { sessionMemberRows, bandCardStatus, parentEmailStudentIds } from "./bandSessionView";
import { planAttributionSave } from "./bandMemberStates";
import { buildForwardIndex, isForwardConsumedCard, forwardConsumes } from "./bandForwardIndex";
import { consumeForwardWeeks, generateMasterLessons, planForwardSave } from "./bandForward";
import { isLessonPresentThisWeek } from "../utils/weeklyPresence";
import { buildMttImportForWeekSchool } from "../utils/mttImport";
import { lweekDates } from "./bandLedgerSmokeTests";
import { getEnrolmentTermDeductionMath } from "../utils/tallyDerive";
import { EB, EX, EENROL, EMASTER, eentry, eband, ecard, eresolver, egenerate, origins } from "./bandForwardEnforceSmokeTests";
import { FB, FX, fstudent, fenrol, fentry, fband, ftally } from "./bandForwardSmokeTests";

// The three absence shapes a forward entry can carry (refinement 1).
export const OWED = { reason: "informed_absence", reasonDetail: "sick", notes: "", makeupEligible: true };
export const NOT_OWED = { reason: "uninformed_absence", reasonDetail: "", notes: "", makeupEligible: false };

// Amy (solo forward) and the ukulele group (group forward), both giving up EX.
export const amyFwd = (extra = {}) => eentry("e_amy_gtr", "forward", { consumedWeekKey: EX, ...extra });
export const groupFwd = (extra = {}, first = {}) => [
  eentry("e_libby_uke", "forward", { consumedWeekKey: EX, ...extra, ...first }),
  eentry("e_ivy_uke", "forward", { consumedWeekKey: EX, ...extra }),
];

// ── Commit 1: characterization — pinned against unchanged code ──
export function runForwardAbsenceCharacterizationTests(assert) {
  const band = eband("B1", [amyFwd(), ...groupFwd(), eentry("e_bob_drm", "free")]);

  // The absence gate: forward is never offered, never absent.
  assert("fwd-abs char: forward solo and group entries are never offered Mark absent (only the free member is)",
    eligibleForAbsence(band, []).map(e => e.enrolmentId), ["e_bob_drm"]);
  const marked = eband("B1", [amyFwd({ attended: false, absence: NOT_OWED }), ...groupFwd({ attended: false, absence: OWED })]);
  assert("fwd-abs char: a forward entry marked attended:false is not 'absent' to bandAbsence",
    [absentMembers(marked, []).length, [...absentEnrolmentIds(marked, [])]], [0, []]);

  // Existing gap kept as is (out of scope): a Free group is offered per member.
  const freeGroup = eband("B2", [eentry("e_libby_uke", "free"), eentry("e_ivy_uke", "free")]);
  assert("fwd-abs char: a Free group is offered Mark absent one member at a time (unchanged gap)",
    eligibleForAbsence(freeGroup, []).map(e => e.enrolmentId), ["e_libby_uke", "e_ivy_uke"]);

  // Protected session view: a forward attended:false still reads attending.
  const viewBand = { ...marked, members: [{ studentId: "amy", instrument: "Guitar" }, { studentId: "libby", instrument: "Ukulele" }, { studentId: "ivy", instrument: "Ukulele" }] };
  assert("fwd-abs char: the protected session view lists a forward attended:false member as attending",
    sessionMemberRows(viewBand, []).map(r => r.studentId + ":" + r.status), ["amy:attending", "libby:attending", "ivy:attending"]);
  assert("fwd-abs char: the protected card status counts no forward absentee",
    bandCardStatus(viewBand, []).absentN, 0);
  assert("fwd-abs char: the protected parent-email list keeps forward absentees",
    parentEmailStudentIds(viewBand, []), ["amy", "libby", "ivy"]);

  // The attribution window only locks what it is told is absent.
  const plan = planAttributionSave({
    stored: [amyFwd({ attended: false, absence: NOT_OWED })], working: [eentry("e_amy_gtr", "free")],
    missByEnrolment: {}, catchupsForBand: [], weekKey: EB, absentEnrolmentIds: [],
  });
  assert("fwd-abs char: without the lock a forward absentee's role can be changed by Save",
    plan.memberStates[0].consumption, "free");

  // Consumption today: ANY attended:false stops the week being used up.
  const wk = (entries) => buildForwardIndex({ [EB + "|S"]: { lessons: [eband("B1", entries)], missed: [] } });
  const card = ecard("M_amy", "W_amy");
  // Commit 2 deliberately changes the last value: absent with NO catch-up
  // keeps the week used up. Was false.
  assert("fwd-abs char: attended:false gives the week back — except absent with no catch-up (was: any attended:false)",
    [isForwardConsumedCard(card, EX, wk([amyFwd()])), isForwardConsumedCard(card, EX, wk([amyFwd({ attended: false })])),
      isForwardConsumedCard(card, EX, wk([amyFwd({ attended: false, absence: OWED })])), isForwardConsumedCard(card, EX, wk([amyFwd({ attended: false, absence: NOT_OWED })]))],
    [true, false, false, true]);
  // Save's consume step. Commit 2 deliberately changes this: a subject whose
  // absence gave the week back is skipped. Was: the card removed (0 left).
  const rows = { [EX + "|S"]: { lessons: [card], missed: [], generatedAt: "x" } };
  const left = (entries) => ((consumeForwardWeeks(rows, entries).rows[EX + "|S"] || rows[EX + "|S"]).lessons).length;
  assert("fwd-abs char: the Save consume step leaves the card of a catch-up-owed absentee (was: removed it)",
    [left([amyFwd()]), left([amyFwd({ attended: false, absence: OWED })]), left([amyFwd({ attended: false, absence: NOT_OWED })])], [0, 1, 0]);

  // Tally today: the no-catch-up absence ticks nothing in the given-up week.
  const amy = fstudent("amy");
  const eAG = fenrol("e_amy_gtr", "amy", "Guitar");
  const d = ftally({ students: [amy], enrolments: [eAG], wtt: {
    [FB + "|S"]: { lessons: [fband("B1", [fentry(eAG, "forward", { consumedWeekKey: FX, attended: false, absence: NOT_OWED })])], missed: [] } } });
  // Commit 2 makes the week stay used up, so the cell is the forward tick
  // until commit 5 draws the red X there. Was "blank".
  assert("fwd-abs char: Tally — a no-catch-up forward absence keeps the given-up week (interim tick; was blank)",
    d.view["amy|Guitar"][FX], "completed:band");

  // Invoice math reads neither the band nor the absence.
  assert("fwd-abs char: invoice math identical across none / absent-owed / absent-not-owed",
    forwardAbsenceInvoiceMath(), Array(4).fill(JSON.stringify({ mkpEligPending: 1, catchups: 0, deductions: 1, extras: 0 })));
}

// ── Commit 2: an absence with no catch-up keeps the week used up ──
export function runForwardAbsenceConsumeTests(assert) {
  assert("fwd-abs consume: forwardConsumes — present, unmarked, owed, not owed, bare attended:false, null",
    [forwardConsumes(amyFwd()), forwardConsumes(amyFwd({ attended: true })), forwardConsumes(amyFwd({ attended: false, absence: OWED })),
      forwardConsumes(amyFwd({ attended: false, absence: NOT_OWED })), forwardConsumes(amyFwd({ attended: false })), forwardConsumes(null)],
    [true, true, false, true, false, false]);

  const idxOf = (entries) => buildForwardIndex({ [EB + "|S"]: { lessons: [eband("B1", entries)], missed: [] } });
  const notOwed = idxOf([amyFwd({ attended: false, absence: NOT_OWED }), ...groupFwd({ attended: false, absence: NOT_OWED })]);
  const owed = idxOf([amyFwd({ attended: false, absence: OWED }), ...groupFwd({ attended: false, absence: OWED })]);
  assert("fwd-abs consume: the index carries the absence",
    [notOwed.entries[0].absence, idxOf([amyFwd()]).entries[0].absence], [NOT_OWED, null]);

  // Generation (the shared generate filter), presence and import all follow it.
  const r = eresolver();
  const gen = (idx) => origins(egenerate(generateMasterLessons(EMASTER, [], r, EX, idx), "S", EX).lessons);
  assert("fwd-abs consume: generate — no catch-up leaves the solo and group lessons out; catch-up owed generates them",
    [gen(notOwed), gen(owed)], [[], ["e_amy_gtr", "e_ivy_uke"]]);
  assert("fwd-abs consume: presence — no catch-up counts as scheduled; catch-up owed does not",
    [isLessonPresentThisWeek(EMASTER[0], [], [], { forwardIndex: notOwed, weekKey: EX }), isLessonPresentThisWeek(EMASTER[2], [], [], { forwardIndex: notOwed, weekKey: EX }),
      isLessonPresentThisWeek(EMASTER[0], [], [], { forwardIndex: owed, weekKey: EX })], [true, true, false]);
  const imp = (idx) => buildMttImportForWeekSchool({ mtt: { lessons: EMASTER }, schoolId: "S", weekDates: lweekDates(EX),
    existingEntry: null, enrolments: EENROL, dropBands: true, catchups: [], forwardIndex: idx }).entry.lessons.map(l => l.enrolmentId).sort();
  assert("fwd-abs consume: import — no catch-up leaves the lessons out; catch-up owed imports them",
    [imp(notOwed), imp(owed)], [[], ["e_amy_gtr", "e_ivy_uke"]]);

  // The window Save's consume step: a released subject keeps its card; the
  // other subjects of the same band are still cleared (repair unchanged).
  const wtt = { [EX + "|S"]: { lessons: [ecard("M_amy", "W_amy"), ecard("M_uke", "W_uke")], missed: [], generatedAt: "x" } };
  const ms = [amyFwd({ attended: false, absence: OWED }), ...groupFwd()];
  const fw = planForwardSave({ stored: ms, saved: ms, weeklyTimetables: wtt });
  assert("fwd-abs consume: Save repair clears the group's card but leaves the catch-up-owed absentee's card",
    [fw.rows[EX + "|S"].lessons.map(l => l.id), fw.released.length], [["W_amy"], 0]);
  const fw2 = planForwardSave({ stored: [amyFwd({ attended: false, absence: NOT_OWED })], saved: [amyFwd({ attended: false, absence: NOT_OWED })], weeklyTimetables: wtt });
  assert("fwd-abs consume: Save repair still clears a no-catch-up absentee's card",
    fw2.rows[EX + "|S"].lessons.map(l => l.id), ["W_uke"]);
}

// Invoice math for one ordinary miss plus: no band, a forward entry, the
// forward entry absent with catch-up owed, and absent with no catch-up.
export function forwardAbsenceInvoiceMath() {
  const eAG = fenrol("e_amy_gtr", "amy", "Guitar");
  const miss = { id: "MS", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", schoolId: "S", day: "Thursday", reason: "sick", makeupEligible: true, madeUp: false };
  const base = { "2020-03-16|S": { lessons: [], missed: [miss] } };
  const withBand = (extra) => ({ ...base, [FB + "|S"]: { lessons: [fband("B1", [fentry(eAG, "forward", { consumedWeekKey: FX, ...extra })])], missed: [] } });
  const math = (wtt) => JSON.stringify(getEnrolmentTermDeductionMath({ weeklyTimetables: wtt, catchups: [], enrolmentId: "e_amy_gtr", instrument: "Guitar",
    prevTerm: { start: "2020-02-03", end: "2020-04-03" }, interruptions: [], nextTermStart: "2020-04-20" }));
  return [math(base), math(withBand({})), math(withBand({ attended: false, absence: OWED })), math(withBand({ attended: false, absence: NOT_OWED }))];
}
