// ============================================================
// BAND REGULAR ABSENCE SMOKE TESTS
// Two "Mark absent ▸" gaps on a band session (owner live checks, 5 Oct 2026):
//   Gap 1 — a Regular member whose band holds no card for them (their card
//           never reached the ledger, e.g. after a "could not be put back")
//           is not offered;
//   Gap 2 — a Regular GROUP is never offered (no whole-group absence).
// Plus the regenerate duplicate: regenerating a week after a Regular band
// absence leaves a second copy of the lesson in the band's ledger.
//
// The characterization block pins today's behaviour before any change. The
// protected modules (bandSessionView.js, bandAbsence.js, bandMemberStates.js)
// never change; the admin side wraps them.
// ============================================================

import { eligibleForAbsence, absentMembers, planMarkAbsent, planUndoAbsence, planRemoveBandSession, carryBandMisses } from "./bandAbsence";
import { sessionMemberRows } from "./bandSessionView";
import { planAttributionSave, applyAttributionLedger, applyStudentAttribution, displaceRegularIntoBands } from "./bandMemberStates";
import { generateMasterLessons } from "./bandForward";
import { adminAbsenceMenu } from "./bandForwardAbsence";
import { EB, EENROL, EMASTER, eentry, eband, ecard, eresolver, egenerate } from "./bandForwardEnforceSmokeTests";
import { GW, gresolver, soloCard } from "./bandGroupSmokeTests";

// A whole-group band miss as a Regular group absence would write it.
export const groupBandMiss = (bandId, card, extra = {}) => {
  const { teacherId, ...rest } = card;
  return { ...rest, enrolmentId: "e_ivy_uke", reason: "informed_absence", reasonDetail: "", notes: "", makeupEligible: true, madeUp: false,
    cardNote: "", bandLessonId: bandId, ...(teacherId ? { ledgerTeacherId: teacherId } : {}), ledgerCard: card, ...extra };
};

// Regenerate one school's week the way the generate paths do: master filter,
// generator, then the band sweep and the band-miss carry.
export function regenerate(entry, schoolId, weekKey, filter = (cards) => cards) {
  const bands = (entry.lessons || []).filter(l => l.isBandSession);
  const master = filter(generateMasterLessons(EMASTER.filter(l => l.schoolId === schoolId), bands, eresolver(), weekKey, null));
  const result = egenerate(master, schoolId, weekKey);
  const lessons = displaceRegularIntoBands([...bands, ...result.lessons], eresolver());
  return { lessons, missed: carryBandMisses(result.missed, entry.missed, lessons) };
}

// ── Commit 1: characterization — pinned against unchanged code ──
export function runRegularAbsenceCharacterizationTests(assert) {
  // Gap 1 — Liri switches "counts against" from Guitar to Piano while her
  // Piano card is not in the week (lost earlier: "could not be put back").
  const r = gresolver();
  const gtr = soloCard("W_GTR", "e_liri_gtr", "Thursday", "09:00");
  const stored = [
    { enrolmentId: "e_liri_pno", studentId: "liri", instrument: "Piano", consumption: null, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
    { enrolmentId: "e_liri_gtr", studentId: "liri", instrument: "Guitar", consumption: "regular", catchupId: null, consumedWeekKey: GW, fee: null, attended: null, writerTeacherId: null },
  ];
  const band = { id: "B1", isBandSession: true, bandName: "Riptide", schoolId: "S", day: "Thursday", start: "13:30", members: [], memberStates: stored, removedLessons: [gtr] };
  const working = applyStudentAttribution(stored, "liri", "e_liri_pno", "regular", GW);
  const plan = planAttributionSave({ stored, working, missByEnrolment: {}, catchupsForBand: [], weekKey: GW });
  const out = applyAttributionLedger({ lessons: [band], bandLessonId: "B1", regularOn: plan.regularOn, regularOff: plan.regularOff, memberStates: plan.memberStates, resolver: r });
  const saved = out.lessons.find(l => l.id === "B1");
  assert("reg-abs char: counts-against Guitar → Piano with no Piano card — Guitar returns, the band holds nothing, no notice",
    [out.lessons.filter(l => !l.isBandSession).map(l => l.id), saved.removedLessons, out.dropped, saved.memberStates.map(e => [e.instrument, e.consumption])],
    [["W_GTR"], [], [], [["Piano", "regular"], ["Guitar", null]]]);
  assert("reg-abs char: …and she is no longer offered Mark absent (protected gate and admin menu)",
    [eligibleForAbsence(saved, []).length, adminAbsenceMenu(saved, []).eligible.length], [0, 0]);

  // Gap 2 — a Regular group with its card held is never offered.
  const uke = ecard("M_uke", "W_uke");
  const gBand = eband("B1", [eentry("e_libby_uke", "regular", { consumedWeekKey: EB }), eentry("e_ivy_uke", "regular", { consumedWeekKey: EB })], { removedLessons: [uke] });
  assert("reg-abs char: a Regular group with its card held is not offered (protected gate and admin menu)",
    [eligibleForAbsence(gBand, []).length, adminAbsenceMenu(gBand, []).eligible.length], [0, 0]);

  // The protected view sees ONE child of a whole-group band miss.
  const gMissed = [groupBandMiss("B1", uke)];
  const gView = { ...gBand, removedLessons: [], members: [{ studentId: "libby", instrument: "Ukulele" }, { studentId: "ivy", instrument: "Ukulele" }] };
  assert("reg-abs char: protected session view marks only the child named on the group miss absent",
    sessionMemberRows(gView, gMissed).map(row => row.studentId + ":" + row.status), ["libby:attending", "ivy:absent"]);
  assert("reg-abs char: protected absentMembers offers Undo under that one child",
    absentMembers(gView, gMissed).map(e => e.enrolmentId), ["e_ivy_uke"]);

  // Regenerate duplicate — Amy (Regular, card held) is marked absent, then the
  // week is regenerated. Commit 6 deliberately changes the next two pins.
  const amyCard = ecard("M_amy", "W_amy", { weekDate: "2099-03-12" });
  const aBand = eband("B1", [eentry("e_amy_gtr", "regular", { consumedWeekKey: EB })], { removedLessons: [amyCard] });
  const p = planMarkAbsent({ band: aBand, entry: aBand.memberStates[0], missed: [], enrolments: EENROL });
  const before = { lessons: [p.band], missed: p.misses };
  const regen = regenerate(before, "S", EB);
  const regenBand = regen.lessons.find(l => l.id === "B1");
  const undone = planUndoAbsence({ band: regenBand, entry: regenBand.memberStates[0], missed: regen.missed, catchups: [] });
  assert("reg-abs char: regenerate after a Regular absence → the card is swept back into the ledger AND kept on the miss (Undo → two ledger copies)",
    [regenBand.removedLessons.length, regen.missed.filter(m => m.bandLessonId === "B1").length, undone.band.removedLessons.length], [1, 1, 2]);
  const removed = planRemoveBandSession({ lessons: regen.lessons, missed: regen.missed }, "B1");
  assert("reg-abs char: …and removing the band then puts one card back and drops the copy (\"Couldn't put back\")",
    [removed.lessons.filter(l => l.enrolmentId === "e_amy_gtr").length, removed.dropped.length], [1, 1]);
}
