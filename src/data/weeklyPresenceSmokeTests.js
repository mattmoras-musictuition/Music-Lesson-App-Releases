// ============================================================
// WEEKLY PRESENCE SMOKE TESTS
// Band Session Attribution cluster 6b, commit 8. isLessonPresentThisWeek is
// the one rule behind BOTH the "not scheduled this week" banner and the
// "Add unscheduled" menu, so testing it covers both surfaces.
// ============================================================

import { isLessonPresentThisWeek } from "../utils/weeklyPresence";
import { planAttributionSave } from "./bandMemberStates";

const WK = "2099-03-09";

// The band clause as it stood before cluster 6b — every member covered.
const oldBandClause = (ml, lessons) =>
  lessons.some(wl => wl.isBandSession && (wl.members || []).some(mb => mb.studentId === ml.studentId));

function entry(studentId, instrument, consumption, extra = {}) {
  return { enrolmentId: `e_${studentId}_${instrument}`, studentId, instrument, consumption,
    catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null, ...extra };
}

export function runWeeklyPresenceTests(assert) {
  const amyGtr = { id: "m_amy", studentId: "amy", instrument: "Guitar", day: "Monday", start: "09:00" };
  const amyPno = { id: "m_amy_p", studentId: "amy", instrument: "Piano", day: "Tuesday", start: "10:00" };
  const grp = { id: "m_g", isGroup: true, groupId: "g1" };

  // ── Unchanged rules ──
  assert("presence: own card present", isLessonPresentThisWeek(amyGtr, [{ id: "c", studentId: "amy", instrument: "Guitar" }], []), true);
  assert("presence: other instrument's card doesn't count", isLessonPresentThisWeek(amyGtr, [{ id: "c", studentId: "amy", instrument: "Piano" }], []), false);
  assert("presence: missed entry counts", isLessonPresentThisWeek(amyGtr, [], [{ studentId: "amy", instrument: "Guitar" }]), true);
  assert("presence: group card covers group lesson", isLessonPresentThisWeek(grp, [{ id: "gc", isGroup: true, groupId: "g1" }], []), true);
  assert("presence: group card doesn't cover an individual", isLessonPresentThisWeek(amyGtr, [{ id: "gc", isGroup: true, groupId: "g1", studentIds: ["amy"] }], []), false);
  assert("presence: nothing → absent", isLessonPresentThisWeek(amyGtr, [], []), false);

  // ── Legacy band: unchanged, every member covered on every instrument ──
  const legacy = { id: "L", isBandSession: true, members: [{ studentId: "amy", instrument: "Guitar" }], removedLessons: [] };
  assert("presence: legacy band covers its member", isLessonPresentThisWeek(amyGtr, [legacy], []), true);
  assert("presence: legacy band covers the member's other instrument too (as before)", isLessonPresentThisWeek(amyPno, [legacy], []), true);
  assert("presence: legacy band matches the old clause",
    [amyGtr, amyPno].map(ml => isLessonPresentThisWeek(ml, [legacy], []) === oldBandClause(ml, [legacy])), [true, true]);

  // ── New band: only Regular covers ──
  const bandWith = (consumption, extra) => ({ id: "B", isBandSession: true, members: [{ studentId: "amy", instrument: "Guitar" }],
    memberStates: [entry("amy", "Guitar", consumption, extra)], removedLessons: [] });
  const cases = [["regular", true], ["catchup", false], ["free", false], ["not_in_session", false], [null, false], ["forward", false], ["billed", false]];
  assert("presence: new band covers only a Regular member",
    cases.map(([c]) => isLessonPresentThisWeek(amyGtr, [bandWith(c)], [])), cases.map(([, v]) => v));
  assert("presence: Regular on guitar doesn't cover the piano lesson", isLessonPresentThisWeek(amyPno, [bandWith("regular")], []), false);
  assert("presence: absent Regular is still covered", isLessonPresentThisWeek(amyGtr, [bandWith("regular")], [{ studentId: "amy", instrument: "Guitar", bandLessonId: "B" }]), true);
  assert("presence: a catch-up member WITH their own card is present",
    isLessonPresentThisWeek(amyGtr, [bandWith("catchup"), { id: "c", studentId: "amy", instrument: "Guitar" }], []), true);
  assert("presence: empty memberStates covers nobody",
    isLessonPresentThisWeek(amyGtr, [{ id: "E", isBandSession: true, members: [{ studentId: "amy" }], memberStates: [] }], []), false);

  // ── 6a J1 regression: attribution moves away from Regular, the old slot is
  //    taken, the card can't go back — the student must now be reported. ──
  const card = { id: "c_amy", enrolmentId: "e_amy_Guitar", studentId: "amy", instrument: "Guitar", day: "Monday", start: "09:00" };
  const stored = [entry("amy", "Guitar", "regular", { consumedWeekKey: WK })];
  const working = [entry("amy", "Guitar", "free")];
  const plan = planAttributionSave({ stored, working, missByEnrolment: {}, catchupsForBand: [], weekKey: WK });
  assert("J1: moving Regular → Free takes the card out of the ledger", plan.regularOff.map(e => e.enrolmentId), ["e_amy_Guitar"]);
  // What the save handler then does (WeeklyAdjustments handleBandAttrSave):
  // the card leaves the ledger and goes back to the grid only if its slot is
  // free. Here another lesson now sits in that slot, so it is dropped.
  const occupant = { id: "c_bob", studentId: "bob", instrument: "Drums", day: "Monday", start: "09:00" };
  const slotTaken = [occupant].some(l => l.day === card.day && l.start === card.start);
  const lessonsAfter = [occupant, { id: "B", isBandSession: true, members: [{ studentId: "amy", instrument: "Guitar" }], memberStates: plan.memberStates, removedLessons: [] }]
    .concat(slotTaken ? [] : [card]);
  assert("J1: the slot is taken, so the card is dropped", lessonsAfter.some(l => l.id === "c_amy"), false);
  assert("J1: before 6b the band masked the missing lesson", oldBandClause(amyGtr, lessonsAfter), true);
  assert("J1: now the student is reported as not scheduled", isLessonPresentThisWeek(amyGtr, lessonsAfter, []), false);
}
