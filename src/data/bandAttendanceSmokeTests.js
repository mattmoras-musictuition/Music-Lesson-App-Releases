// ============================================================
// BAND ATTENDANCE SMOKE TESTS
// v2.42.0 (phase 2: teacher-recorded band attendance + drain v3).
//
// The characterization block pins TODAY's absence actions and band-card
// render for the shapes drain v3 writes (teacher-recorded absences), before
// any v2.42.0 code: what each admin action leaves on the entry, that the
// teacher shapes already render and undo like admin ones, and why a regular
// entry keeps attended null (rule-7 finding).
//
// "Past" weeks sit in 2020 so the 6pm threshold can never move under a test.
// ============================================================

import { deriveTallyRows } from "../utils/tallyDerive";
import {
  isMemberAbsent, absentMembers, planMarkAbsent, applyCatchupAbsence, planUndoAbsence, memberAbsenceInfo,
} from "./bandAbsence";
import { sessionMemberRows, bandCardStatus } from "./bandSessionView";
import { stampAdminOverride, isPendingSuggestion, pendingSuggestions, planConfirmSuggestion, planDismissSuggestion } from "./bandAttendance";

const PW = "2020-03-09";                 // the band's week (past)
const T1 = "2026-09-21T01:00:00.000Z";   // a teacher stamp's writtenAt

const amy = { id: "e_amy", studentId: "amy", instrument: "Guitar" };
const bob = { id: "e_bob", studentId: "bob", instrument: "Drums" };
const cat = { id: "e_cat", studentId: "cat", instrument: "Piano" };
const dan = { id: "e_dan", studentId: "dan", instrument: "Bass" };

function ms(e, consumption, extra = {}) {
  return { enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, consumption, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null, ...extra };
}
function card(id, e, extra = {}) {
  return { id, enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day: "Thursday", start: "09:00", teacherId: "tq", ...extra };
}
function band(extra = {}) {
  return { id: "B1", isBandSession: true, bandId: "BAND", bandName: "Band", schoolId: "S", day: "Tuesday", start: "11:00", end: "11:30",
    members: [{ studentId: "amy", instrument: "Guitar" }, { studentId: "bob", instrument: "Drums" }, { studentId: "cat", instrument: "Piano" }, { studentId: "dan", instrument: "Bass" }],
    removedLessons: [], ...extra };
}
// A regular band miss exactly as drain v3 rule 2 writes it from `c`.
function drainMiss(c, extra = {}) {
  const { teacherId, ...rest } = c;
  return { ...rest, reason: "informed_absence", reasonDetail: "Camp", notes: "", makeupEligible: true, madeUp: false, cardNote: "",
    bandLessonId: "B1", ledgerTeacherId: teacherId, ledgerCard: c, ...extra };
}
const entryOf = (b, e) => b.memberStates.find(x => x.enrolmentId === e.id);

export function runBandAttendanceCharacterizationTests(assert) {
  // ── Admin actions today: nothing stamps adminOverrideAt; writerTeacherId untouched ──
  const freeBand = band({ memberStates: [ms(dan, "free", { writerTeacherId: "tw", teacherWrittenAt: T1 })] });
  const freeMark = planMarkAbsent({ band: freeBand, entry: entryOf(freeBand, dan), missed: [], enrolments: [] });
  assert("attendance char: free Mark absent sets attended false only (writer kept, no adminOverrideAt)",
    entryOf(freeMark.band, dan), ms(dan, "free", { writerTeacherId: "tw", teacherWrittenAt: T1, attended: false }));

  const c1 = card("C1", amy);
  const regBand = band({ removedLessons: [c1], memberStates: [ms(amy, "regular")] });
  const regMark = planMarkAbsent({ band: regBand, entry: entryOf(regBand, amy), missed: [], enrolments: [{ ...amy, startDate: "2020-01-01" }] });
  assert("attendance char: regular Mark absent leaves memberStates untouched (attended stays null)",
    regMark.band.memberStates, regBand.memberStates);
  assert("attendance char: regular Mark absent miss carries no teacherId / writerTeacherId",
    ["teacherId", "writerTeacherId"].some(k => k in regMark.misses[0]), false);

  const cuBand = band({ memberStates: [ms(bob, "catchup", { catchupId: "CU1", writerTeacherId: "tw" })] });
  const cuMark = applyCatchupAbsence({ band: cuBand, entry: entryOf(cuBand, bob), absence: { reason: "informed_absence", makeupEligible: false }, row: { id: "CU1" } });
  assert("attendance char: catch-up Mark absent (forfeit) — absence has 4 fields, writer kept, row kept",
    [entryOf(cuMark.band, bob), cuMark.deleteRow],
    [ms(bob, "catchup", { catchupId: "CU1", writerTeacherId: "tw", attended: false,
      absence: { reason: "informed_absence", reasonDetail: "", notes: "", makeupEligible: false } }), null]);
  const cuOwed = applyCatchupAbsence({ band: cuBand, entry: entryOf(cuBand, bob), absence: { reason: "informed_absence", makeupEligible: true }, row: { id: "CU1", weekKey: PW } });
  assert("attendance char: catch-up owed-on — row deleted, snapshot kept, catchupId null",
    [cuOwed.deleteRow && cuOwed.deleteRow.id, entryOf(cuOwed.band, bob).absentCatchupSnapshot, entryOf(cuOwed.band, bob).catchupId],
    ["CU1", { id: "CU1", weekKey: PW }, null]);

  // ── Teacher-recorded shapes (drain v3 output) already render like admin ones ──
  const tBand = band({
    removedLessons: [],
    memberStates: [
      ms(amy, "regular", { writerTeacherId: "tw", teacherWrittenAt: T1 }),
      ms(bob, "catchup", { catchupId: "CU1", attended: false, writerTeacherId: "tw", teacherWrittenAt: T1,
        absence: { reason: "uninformed_absence", reasonDetail: "Sick", notes: "", makeupEligible: false, suggestOwed: true } }),
      ms(cat, "free", { attended: false, writerTeacherId: "tw", teacherWrittenAt: T1 }),
      ms(dan, "regular"),
    ],
  });
  const tMissed = [drainMiss(c1)];
  assert("attendance char: teacher absences count as absent on the band card",
    bandCardStatus(tBand, tMissed), { needsAttribution: false, absentN: 3 });
  assert("attendance char: teacher absences render with their reasons",
    sessionMemberRows(tBand, tMissed).map(r => `${r.studentId}:${r.status}:${r.absenceReason || ""}:${r.absenceReasonDetail}`),
    ["amy:absent:informed_absence:Camp", "bob:absent:uninformed_absence:Sick", "cat:absent::", "dan:attending::"]);
  assert("attendance char: catch-up teacher absence info for the window",
    memberAbsenceInfo(tBand, entryOf(tBand, bob), tMissed), { reason: "uninformed_absence", reasonDetail: "Sick" });
  assert("attendance char: Undo absence menu lists teacher absences",
    absentMembers(tBand, tMissed).map(e => e.enrolmentId), ["e_amy", "e_bob", "e_cat"]);

  // ── Undo of teacher-recorded absences today ──
  const uReg = planUndoAbsence({ band: tBand, entry: entryOf(tBand, amy), missed: tMissed, catchups: [] });
  assert("attendance char: Undo teacher regular — miss out, ledgerCard back, entry untouched",
    [uReg.kind, uReg.missed, uReg.band.removedLessons, entryOf(uReg.band, amy)],
    ["regular", [], [c1], ms(amy, "regular", { writerTeacherId: "tw", teacherWrittenAt: T1 })]);
  const uCu = planUndoAbsence({ band: tBand, entry: entryOf(tBand, bob), missed: tMissed, catchups: [{ id: "CU1" }] });
  assert("attendance char: Undo teacher catch-up — absence cleared, writer and teacherWrittenAt kept, no stamp",
    [uCu.kind, uCu.insertRow, entryOf(uCu.band, bob)],
    ["catchup", undefined, ms(bob, "catchup", { catchupId: "CU1", writerTeacherId: "tw", teacherWrittenAt: T1 })]);
  const uFree = planUndoAbsence({ band: tBand, entry: entryOf(tBand, cat), missed: tMissed, catchups: [] });
  assert("attendance char: Undo teacher free — attended null, writer kept",
    entryOf(uFree.band, cat), ms(cat, "free", { writerTeacherId: "tw", teacherWrittenAt: T1 }));

  // ── Rule-7 finding: a regular entry must keep attended null ──
  // isMemberAbsent / the card read only the miss, but the Tally drops a
  // regular tick on attended === false — so attended:false with no miss
  // would leave the cell neither ticked nor owed.
  const r7 = band({ day: "Monday", memberStates: [ms(amy, "regular", { attended: false })] });
  assert("attendance char: regular attended:false with no miss is NOT absent on the card",
    [isMemberAbsent(r7, entryOf(r7, amy), []), sessionMemberRows(r7, [])[0].status], [false, "attending"]);
  const tally = (bandCard) => {
    const { tallyRows } = deriveTallyRows({
      enrolments: [{ ...amy, startDate: "2020-01-01" }], students: [{ id: "amy", name: "amy", schoolId: "S", status: "active" }],
      termWeeks: [{ weekKey: PW, label: "W1", weekNum: 1 }], weeklyTimetables: { [`${PW}|S`]: { lessons: [bandCard], missed: [] } },
      timetable: { lessons: [{ id: "M", enrolmentId: amy.id, studentId: "amy", instrument: "Guitar", schoolId: "S", day: "Monday", start: "09:00" }] },
      schoolFilter: "all",
    });
    return tallyRows[0].cells[PW].state;
  };
  assert("attendance char: Tally ticks a regular band member with attended null",
    tally(band({ day: "Monday", memberStates: [ms(amy, "regular")] })), "completed");
  assert("attendance char: Tally drops the tick when a regular entry says attended:false (no miss)",
    tally(r7) === "completed", false);
}

// ── adminOverrideAt stamping (C3) ──
const NOW = "2026-10-02T03:00:00.000Z";

export function runBandAttendanceStampTests(assert) {
  const b = band({ memberStates: [
    ms(amy, "regular", { writerTeacherId: "tw", teacherWrittenAt: T1 }),
    ms(bob, "catchup", { catchupId: "CU1", attended: false, writerTeacherId: "tw", teacherWrittenAt: T1,
      absence: { reason: "informed_absence", reasonDetail: "", notes: "", makeupEligible: false, suggestOwed: true } }),
  ] });
  const st = stampAdminOverride(b, bob.id, NOW);
  assert("attendance stamp: sets adminOverrideAt and clears writerTeacherId on that entry only",
    [entryOf(st, bob).adminOverrideAt, entryOf(st, bob).writerTeacherId, entryOf(st, amy)], [NOW, null, entryOf(b, amy)]);
  assert("attendance stamp: keeps every other field (teacherWrittenAt, absence, catchupId)",
    entryOf(st, bob), { ...entryOf(b, bob), adminOverrideAt: NOW, writerTeacherId: null });
  assert("attendance stamp: does not mutate the input band", entryOf(b, bob).writerTeacherId, "tw");
  assert("attendance stamp: unknown enrolment → same band object", stampAdminOverride(b, "nope", NOW) === b, true);
  const legacy = band();
  assert("attendance stamp: legacy band → same band object", stampAdminOverride(legacy, amy.id, NOW) === legacy, true);
  const restamp = stampAdminOverride(stampAdminOverride(b, bob.id, T1), bob.id, NOW);
  assert("attendance stamp: a later action moves adminOverrideAt forward", entryOf(restamp, bob).adminOverrideAt, NOW);

  // What each admin action now leaves (handler = planner output, then stamp).
  const c1 = card("C1", amy);
  const regBand = band({ removedLessons: [c1], memberStates: [ms(amy, "regular", { writerTeacherId: "tw", teacherWrittenAt: T1 })] });
  const regMark = planMarkAbsent({ band: regBand, entry: entryOf(regBand, amy), missed: [], enrolments: [{ ...amy, startDate: "2020-01-01" }] });
  assert("attendance stamp: admin regular Mark absent → admin-owned (writer null), attended still null",
    entryOf(stampAdminOverride(regMark.band, amy.id, NOW), amy),
    ms(amy, "regular", { writerTeacherId: null, teacherWrittenAt: T1, adminOverrideAt: NOW }));
  const tMissed = [drainMiss(c1)];
  const tBand = band({ memberStates: [ms(amy, "regular", { writerTeacherId: "tw", teacherWrittenAt: T1 })] });
  const uReg = planUndoAbsence({ band: tBand, entry: entryOf(tBand, amy), missed: tMissed, catchups: [] });
  assert("attendance stamp: admin Undo of a teacher regular absence → card back, admin-owned",
    [uReg.missed, stampAdminOverride(uReg.band, amy.id, NOW).removedLessons, entryOf(stampAdminOverride(uReg.band, amy.id, NOW), amy).adminOverrideAt],
    [[], [c1], NOW]);
  const uCu = planUndoAbsence({ band: b, entry: entryOf(b, bob), missed: [], catchups: [{ id: "CU1" }] });
  assert("attendance stamp: admin Undo of a teacher catch-up absence → cleared, admin-owned, row untouched",
    [entryOf(stampAdminOverride(uCu.band, bob.id, NOW), bob), uCu.insertRow],
    [ms(bob, "catchup", { catchupId: "CU1", writerTeacherId: null, teacherWrittenAt: T1, adminOverrideAt: NOW }), undefined]);
  const cuMark = applyCatchupAbsence({ band: b, entry: entryOf(b, bob), absence: { reason: "other", makeupEligible: false }, row: null });
  assert("attendance stamp: admin catch-up Mark absent → admin-owned",
    [entryOf(stampAdminOverride(cuMark.band, bob.id, NOW), bob).writerTeacherId, entryOf(stampAdminOverride(cuMark.band, bob.id, NOW), bob).adminOverrideAt],
    [null, NOW]);
}

// ── Catch-up suggestions: Confirm / Dismiss (C4) ──
export function runBandAttendanceSuggestionTests(assert) {
  const abs = { reason: "uninformed_absence", reasonDetail: "Sick", notes: "n", makeupEligible: false, suggestOwed: true };
  const sugg = ms(bob, "catchup", { catchupId: "CU1", consumedWeekKey: "2020-03-02", fee: 25, attended: false, absence: abs, writerTeacherId: "tw", teacherWrittenAt: T1 });
  const b = band({ memberStates: [ms(amy, "regular"), sugg, ms(cat, "catchup", { catchupId: "CU3", attended: false, absence: { ...abs, suggestOwed: false } })] });
  const row = { id: "CU1", weekKey: PW, resolvesEnrolmentId: bob.id, resolvesWeekKey: "2020-03-02", day: "Tuesday", time: "11:00" };

  assert("suggestion: pending = catch-up + attended false + suggestOwed true",
    [isPendingSuggestion(sugg), isPendingSuggestion({ ...sugg, attended: null }), isPendingSuggestion({ ...sugg, consumption: "free" }),
     isPendingSuggestion({ ...sugg, absence: { ...abs, suggestOwed: false } }), isPendingSuggestion(null)],
    [true, false, false, false, false]);
  assert("suggestion: pendingSuggestions lists only pending entries", pendingSuggestions(b).map(e => e.enrolmentId), ["e_bob"]);
  assert("suggestion: legacy band has none", pendingSuggestions(band()), []);

  const conf = planConfirmSuggestion({ band: b, entry: entryOf(b, bob), row, at: NOW });
  assert("suggestion: Confirm deletes the linked row (owed-on path)", conf.deleteRow, row);
  assert("suggestion: Confirm → snapshot kept, catchupId null, makeupEligible true, suggestOwed false, admin-owned",
    entryOf(conf.band, bob),
    { ...sugg, catchupId: null, absentCatchupSnapshot: row, writerTeacherId: null, adminOverrideAt: NOW,
      absence: { reason: "uninformed_absence", reasonDetail: "Sick", notes: "n", makeupEligible: true, suggestOwed: false } });
  assert("suggestion: Confirm leaves other members alone",
    [entryOf(conf.band, amy), entryOf(conf.band, cat)], [entryOf(b, amy), entryOf(b, cat)]);
  assert("suggestion: Confirm clears the pending marker", pendingSuggestions(conf.band), []);
  assert("suggestion: Confirmed absence still renders absent", isMemberAbsent(conf.band, entryOf(conf.band, bob), []), true);
  const undo = planUndoAbsence({ band: conf.band, entry: entryOf(conf.band, bob), missed: [], catchups: [] });
  assert("suggestion: Undo after Confirm re-inserts the row under its id (cluster-5 path)",
    [undo.insertRow && undo.insertRow.id, entryOf(undo.band, bob).catchupId], ["CU1", "CU1"]);
  const confNoRow = planConfirmSuggestion({ band: b, entry: entryOf(b, bob), row: null, at: NOW });
  assert("suggestion: Confirm with no linked row deletes nothing, still owed",
    [confNoRow.deleteRow, entryOf(confNoRow.band, bob).absence.makeupEligible, "absentCatchupSnapshot" in entryOf(confNoRow.band, bob)],
    [null, true, false]);

  const dis = planDismissSuggestion({ band: b, entry: entryOf(b, bob), at: NOW });
  assert("suggestion: Dismiss → suggestOwed false, still a forfeit absence, row kept, admin-owned",
    entryOf(dis.band, bob), { ...sugg, writerTeacherId: null, adminOverrideAt: NOW, absence: { ...abs, suggestOwed: false } });
  assert("suggestion: Dismiss returns no row to delete", "deleteRow" in dis, false);
  assert("suggestion: Confirm/Dismiss refuse a non-pending entry",
    [planConfirmSuggestion({ band: b, entry: entryOf(b, cat), row: null, at: NOW }), planDismissSuggestion({ band: b, entry: entryOf(b, cat), at: NOW })],
    [null, null]);
  assert("suggestion: Confirm/Dismiss do not mutate the input", entryOf(b, bob), sugg);
}
