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

import { isExcludedByBands, restoreLedgerCards, isGenerateExcluded, withoutLedgeredDuplicates, displaceRegularIntoBands, sweepRegularIntoLedger } from "./bandMemberStates";
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
  // Updated in v2.42.1 C2 (deliberately): before the fix this read
  // [["e_annie"], ["W_ANNIE"]] — the double-book. The import now leaves the
  // ledgered lesson out.
  assert("ledger char: Monday import no longer re-adds a card the ledger already holds (was a double-book)",
    [imp.entry.lessons.filter(l => !l.isBandSession).map(l => l.enrolmentId), outBand.removedLessons.map(c => c.id)],
    [[], ["W_ANNIE"]]);

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

// ── New-band generate / import displacement (C2) ──
const gids = (lessons) => lessons.filter(l => !l.isBandSession).map(l => l.id);
const ledger = (lessons, bandId) => lessons.find(l => l.id === bandId).removedLessons.map(c => c.id);
// What a generate path does: filter the master, "generate" (one week card per
// master card), put the preserved bands in front, displace.
function generate(master, bands, r) {
  const generated = master.filter(m => !isGenerateExcluded(m, bands, r)).map(m => ({ ...m, id: "G_" + m.id }));
  return displaceRegularIntoBands([...bands, ...generated], r);
}

export function runBandLedgerDisplacementTests(assert) {
  const r = lresolver();
  const other = { id: "M_OTHER", enrolmentId: "e_x", studentId: "x", instrument: "Guitar", schoolId: "S", day: "Monday", start: "09:00" };
  const anelaW = lcard("W_ANELA", "e_anela", "Wednesday", "09:00");
  const master = [lcard("M_ANELA", "e_anela", "Wednesday", "09:00"), lcard("M_ANNIE", "e_annie", "Monday", "11:30"), lcard("M_GRACE", "e_grace", "Monday", "12:30"), other];

  // Filter decisions
  const band = lband("B1", "Wednesday", [lentry("e_anela"), lentry("e_annie"), lentry("e_grace")], [anelaW]);
  assert("displace: generate filter skips a Regular member already in the ledger (duplicate)", isGenerateExcluded(master[0], [band], r), true);
  assert("displace: generate filter keeps a Regular member NOT in the ledger", isGenerateExcluded(master[1], [band], r), false);
  assert("displace: generate filter keeps non-members", isGenerateExcluded(other, [band], r), false);
  const legacy = { id: "BL", isBandSession: true, bandId: "BL", day: "Friday", members: [{ studentId: "annie" }], removedLessons: [] };
  assert("displace: legacy band keeps today's whole-student exclusion",
    [isGenerateExcluded(master[1], [legacy], r), isExcludedByBands(master[1], [legacy], r)], [true, true]);
  const cuBand = lband("B9", "Wednesday", [lentry("e_annie", "catchup")]);
  assert("displace: a catch-up member's card is not excluded", isGenerateExcluded(master[1], [cuBand], r), false);

  // The owner's case end to end: Monday members on a Wednesday band
  const out = generate(master, [band], r);
  assert("displace: multi-day — Annie's and Grace's Monday cards go INTO the ledger, not lost",
    ledger(out, "B1"), ["W_ANELA", "G_M_ANNIE", "G_M_GRACE"]);
  assert("displace: …and leave the grid; Anela is not duplicated; others stay",
    gids(out), ["G_M_OTHER"]);
  assert("displace: regenerating again is stable (no duplicates, nothing lost)",
    [ledger(generate(master, [out[0]], r), "B1"), gids(generate(master, [out[0]], r))],
    [["W_ANELA", "G_M_ANNIE", "G_M_GRACE"], ["G_M_OTHER"]]);

  // Two bands in one week, each takes its own member
  const b1 = lband("B1", "Wednesday", [lentry("e_annie")]);
  const b2 = lband("B2", "Friday", [lentry("e_grace")]);
  const two = generate(master, [b1, b2], r);
  assert("displace: two bands in one week — each ledgers its own member",
    [ledger(two, "B1"), ledger(two, "B2"), gids(two)], [["G_M_ANNIE"], ["G_M_GRACE"], ["G_M_ANELA", "G_M_OTHER"]]);

  // Non-Regular members and legacy bands: untouched
  const cuOut = generate(master, [cuBand], r);
  assert("displace: catch-up member's card stays on the grid", [ledger(cuOut, "B9"), gids(cuOut).includes("G_M_ANNIE")], [[], true]);
  const lessonsL = [legacy, { ...master[2], id: "W_G" }];
  assert("displace: legacy band only → same array back", displaceRegularIntoBands(lessonsL, r) === lessonsL, true);
  const settled = [band, { ...other, id: "W_O" }];
  const settledFull = [{ ...band, removedLessons: [anelaW, lcard("W_AN", "e_annie", "Monday", "11:30"), lcard("W_GR", "e_grace", "Monday", "12:30")] }, { ...other, id: "W_O" }];
  assert("displace: nothing to move → same array back",
    [displaceRegularIntoBands(settledFull, r) === settledFull, displaceRegularIntoBands(settled, r) === settled], [true, true]);
  assert("displace: a Regular member with no card anywhere is a no-op", ledger(displaceRegularIntoBands(settled, r), "B1"), ["W_ANELA"]);
  assert("displace: duplicate filter drops only the ledgered lesson",
    withoutLedgeredDuplicates(master, [band], r).map(m => m.id), ["M_ANNIE", "M_GRACE", "M_OTHER"]);

  // Single-day import, member NOT yet in the ledger → moved in on import
  const notYet = lband("B3", "Wednesday", [lentry("e_annie")]);
  const imp = buildMttImportForWeekSchool({ mtt: { lessons: [master[1], other] }, schoolId: "S", weekDates: lweekDates(), existingEntry: { lessons: [notYet], missed: [] },
    targetDay: "Monday", enrolments: LENROL, dropBands: true, catchups: [] });
  assert("displace: Monday import ledgers a Regular member's card instead of leaving it beside the band",
    [imp.entry.lessons.find(l => l.id === "B3").removedLessons.map(c => c.enrolmentId), imp.entry.lessons.filter(l => !l.isBandSession).map(l => l.enrolmentId), imp.importedCount],
    [["e_annie"], ["e_x"], 2]);
}

// ── Attribution Save repair sweep (C3) ──
export function runBandLedgerSaveSweepTests(assert) {
  const r = lresolver();
  const anelaW = lcard("W_ANELA", "e_anela", "Wednesday", "09:00");
  const annieM = lcard("W_ANNIE", "e_annie", "Monday", "11:30");
  const graceM = lcard("W_GRACE", "e_grace", "Monday", "12:30", { bucket_id: "lane_matt", teacherId: "t_matt" });
  const other = { id: "W_O", enrolmentId: "e_x", studentId: "x", instrument: "Guitar", schoolId: "S", day: "Monday", start: "09:00" };
  // The owner's band after the import repair: all Regular (none NEWLY
  // Regular at this Save), Anela ledgered, Annie and Grace back on Monday.
  const band = lband("B1", "Wednesday", [lentry("e_anela"), lentry("e_annie"), lentry("e_grace")], [anelaW]);
  const lessons = [other, band, annieM, graceM];
  const out = sweepRegularIntoLedger(lessons, "B1", r);
  assert("save sweep: already-Regular members' cards (other day, any lane) go into the ledger",
    [out.find(l => l.id === "B1").removedLessons.map(c => c.id), out.filter(l => !l.isBandSession).map(l => l.id)],
    [["W_ANELA", "W_ANNIE", "W_GRACE"], ["W_O"]]);
  assert("save sweep: running it again changes nothing (same array)", sweepRegularIntoLedger(out, "B1", r) === out, true);
  const noCards = [other, band];
  assert("save sweep: Regular member with no card anywhere → no-op, no error", sweepRegularIntoLedger(noCards, "B1", r) === noCards, true);
  const cu = lband("B2", "Wednesday", [lentry("e_annie", "catchup")]);
  const cuLessons = [cu, annieM];
  assert("save sweep: non-Regular members are left on the grid", sweepRegularIntoLedger(cuLessons, "B2", r) === cuLessons, true);
  const legacy = { id: "BL", isBandSession: true, members: [{ studentId: "annie" }], removedLessons: [] };
  const legacyLessons = [legacy, annieM];
  assert("save sweep: legacy band / unknown band → untouched",
    [sweepRegularIntoLedger(legacyLessons, "BL", r) === legacyLessons, sweepRegularIntoLedger(lessons, "nope", r) === lessons], [true, true]);
  assert("save sweep: inputs not mutated", [band.removedLessons.length, lessons.length], [1, 4]);
}
