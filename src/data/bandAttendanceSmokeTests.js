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
