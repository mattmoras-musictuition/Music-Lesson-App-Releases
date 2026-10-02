// ============================================================
// BAND LEDGER SMOKE TESTS
// v2.42.1 — "a card is never removed from a week's lessons because of a band
// unless it is put into that band's removedLessons ledger".
//
// The characterization block pins TODAY's three ways a card leaves (or
// double-books) the grid without the ledger knowing, reproduced from the
// owner's test band (members on another day than the band, cards in another
// teacher's lane):
//   1. generate skips a Regular member's master card and ledgers nothing;
//   2. a single-day import re-adds a card the ledger already holds;
//   3. the restore rule silently drops a card whose slot another lane holds.
//
// Weeks sit in 2099 so the past-week guards never move under a test.
// ============================================================

import { isExcludedByBands, restoreLedgerCards } from "./bandMemberStates";
import { makeEnrolmentResolver } from "../utils/enrolmentActivity";
import { buildMttImportForWeekSchool } from "../utils/mttImport";

export const LW = "2099-03-09";   // a future Monday
const DAYS5 = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
export const lweekDates = (monday = LW) => DAYS5.map((day, i) => {
  const d = new Date(monday + "T00:00:00");
  d.setDate(d.getDate() + i);
  return { day, date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` };
});

// Enrolments: Anela (Matt's, Wednesday) and Annie / Grace (another teacher's lane, Monday).
export const LENROL = [
  { id: "e_anela", studentId: "anela", instrument: "Piano", startDate: "2020-01-01" },
  { id: "e_annie", studentId: "annie", instrument: "Voice", startDate: "2020-01-01" },
  { id: "e_grace", studentId: "grace", instrument: "Piano", startDate: "2020-01-01" },
];
export const lresolver = () => makeEnrolmentResolver(LENROL);

export function lcard(id, enrolmentId, day, start, extra = {}) {
  const e = LENROL.find(x => x.id === enrolmentId);
  return { id, enrolmentId, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day, start, end: start, teacherId: "t_other", bucket_id: "lane_other", ...extra };
}
export function lentry(enrolmentId, consumption = "regular") {
  const e = LENROL.find(x => x.id === enrolmentId);
  return { enrolmentId, studentId: e.studentId, instrument: e.instrument, consumption, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null };
}
export function lband(id, day, memberStates, removedLessons = [], extra = {}) {
  return { id, isBandSession: true, bandId: "BAND_" + id, bandName: "Rolling", schoolId: "S", day, start: "13:00", end: "13:30",
    members: memberStates.map(e => ({ studentId: e.studentId, instrument: e.instrument })), memberStates, removedLessons, ...extra };
}

export function runBandLedgerCharacterizationTests(assert) {
  const r = lresolver();
  // 1. Generate: the band is on Wednesday, Annie is Regular, her Monday card
  //    never reached the ledger. Every generate path filters the master with
  //    isExcludedByBands — Annie's master card is skipped, and nothing puts it
  //    in the ledger (the band is carried over as it was).
  const band = lband("B1", "Wednesday", [lentry("e_anela"), lentry("e_annie")], [lcard("W_ANELA", "e_anela", "Wednesday", "09:00")]);
  const annieMaster = lcard("M_ANNIE", "e_annie", "Monday", "11:30");
  assert("ledger char: generate skips a Regular member's other-day master card",
    isExcludedByBands(annieMaster, [band], r), true);
  assert("ledger char: …and the band's ledger still has no card for her (lost)",
    band.removedLessons.map(c => c.enrolmentId), ["e_anela"]);

  // 2. Single-day import: Annie's Monday card IS in the Wednesday band's
  //    ledger; a Monday import re-adds it from the master — both at once.
  const ledgered = lband("B2", "Wednesday", [lentry("e_annie")], [lcard("W_ANNIE", "e_annie", "Monday", "11:30")]);
  const mtt = { lessons: [lcard("M_ANNIE", "e_annie", "Monday", "11:30")] };
  const imp = buildMttImportForWeekSchool({ mtt, schoolId: "S", weekDates: lweekDates(), existingEntry: { lessons: [ledgered], missed: [] },
    targetDay: "Monday", enrolments: LENROL, dropBands: true, catchups: [] });
  const outBand = imp.entry.lessons.find(l => l.id === "B2");
  assert("ledger char: Monday import re-adds a card the ledger already holds (double-book)",
    [imp.entry.lessons.filter(l => !l.isBandSession).map(l => l.enrolmentId), outBand.removedLessons.map(c => c.id)],
    [["e_annie"], ["W_ANNIE"]]);

  // 3. Restore: Grace's ledger card goes back only if no lesson in ANY lane
  //    sits at that day+start — otherwise it is dropped silently.
  const grace = lcard("W_GRACE", "e_grace", "Monday", "12:30");
  const mattsMonday = { id: "W_MATT", enrolmentId: "e_x", studentId: "x", instrument: "Guitar", schoolId: "S", day: "Monday", start: "12:30", teacherId: "t_matt", bucket_id: "lane_matt" };
  const restored = restoreLedgerCards([mattsMonday], [grace]);
  assert("ledger char: restore drops a card when another lane holds its slot, and says nothing",
    restored.map(l => l.id), ["W_MATT"]);
  assert("ledger char: restore puts the card back when the slot is free",
    restoreLedgerCards([], [grace]).map(l => l.id), ["W_GRACE"]);
}
