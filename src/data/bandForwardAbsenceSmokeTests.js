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
import { buildForwardIndex, isForwardConsumedCard } from "./bandForwardIndex";
import { consumeForwardWeeks } from "./bandForward";
import { getEnrolmentTermDeductionMath } from "../utils/tallyDerive";
import { EB, EX, eentry, eband, ecard } from "./bandForwardEnforceSmokeTests";
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
  assert("fwd-abs char: attended:false — with or without an absence — does not use the week up",
    [isForwardConsumedCard(card, EX, wk([amyFwd()])), isForwardConsumedCard(card, EX, wk([amyFwd({ attended: false })])),
      isForwardConsumedCard(card, EX, wk([amyFwd({ attended: false, absence: OWED })])), isForwardConsumedCard(card, EX, wk([amyFwd({ attended: false, absence: NOT_OWED })]))],
    [true, false, false, false]);
  // Save's consume step ignores attended entirely (it removes the card for every forward entry).
  const rows = { [EX + "|S"]: { lessons: [card], missed: [], generatedAt: "x" } };
  assert("fwd-abs char: the Save consume step removes the card even for an attended:false entry",
    consumeForwardWeeks(rows, [amyFwd({ attended: false, absence: OWED })]).rows[EX + "|S"].lessons.length, 0);

  // Tally today: the no-catch-up absence ticks nothing in the given-up week.
  const amy = fstudent("amy");
  const eAG = fenrol("e_amy_gtr", "amy", "Guitar");
  const d = ftally({ students: [amy], enrolments: [eAG], wtt: {
    [FB + "|S"]: { lessons: [fband("B1", [fentry(eAG, "forward", { consumedWeekKey: FX, attended: false, absence: NOT_OWED })])], missed: [] } } });
  assert("fwd-abs char: Tally — a no-catch-up forward absence shows nothing in the given-up week",
    d.view["amy|Guitar"][FX], "blank");

  // Invoice math reads neither the band nor the absence.
  assert("fwd-abs char: invoice math identical across none / absent-owed / absent-not-owed",
    forwardAbsenceInvoiceMath(), Array(4).fill(JSON.stringify({ mkpEligPending: 1, catchups: 0, deductions: 1, extras: 0 })));
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
