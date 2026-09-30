// ============================================================
// MTT IMPORT SMOKE TESTS
// Clean MTT re-import (v2.40.1). Called from runSmokeTests with its `assert`.
//
// The characterization block pins how the MTT → WTT import builder and the
// "Import all schools" rebuild behave BEFORE the clean-import change. "Import
// all" is inline React code in WeeklyAdjustments, so its consequence is
// pinned through the pure pieces it produces (lessons = master cards only)
// and the existing render merge / banking helpers — no extraction needed.
//
// Weeks: 2020 (past) and 2099 (future), as in the other band suites.
// ============================================================

import { buildMttImportForWeekSchool } from "../utils/mttImport";
import { carryBandMisses, planCleanImport } from "./bandAbsence";
import { mergeCatchupsIntoLessons, buildBankingIndex } from "./catchupsDerive";

const FW = "2099-03-09";   // a future Monday

const DAYS5 = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const weekDates = (monday) => DAYS5.map((day, i) => {
  const d = new Date(monday + "T00:00:00");
  d.setDate(d.getDate() + i);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { day, date: iso };
});

function master(id, enrolmentId, studentId, instrument, day, start) {
  return { id, enrolmentId, studentId, instrument, schoolId: "S", day, start, end: start };
}

// Master timetable: Amy guitar Thursday 09:00, Bob drums Tuesday 10:00.
const MTT = {
  lessons: [
    master("M_AMY", "e_amy_gtr", "amy", "Guitar", "Thursday", "09:00"),
    master("M_BOB", "e_bob_drm", "bob", "Drums", "Tuesday", "10:00"),
  ],
};

// A week holding a NEW band on Tuesday (Amy regular, her card in the ledger;
// Bob catch-up via row CU) plus an older legacy band on Thursday.
function existingWeek() {
  const amyCard = { id: "W_AMY", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", schoolId: "S", day: "Thursday", start: "09:00" };
  const bobCard = { id: "W_BOB", enrolmentId: "e_bob_drm", studentId: "bob", instrument: "Drums", schoolId: "S", day: "Tuesday", start: "10:00" };
  const newBand = {
    id: "B_NEW", isBandSession: true, bandId: "BAND", bandName: "Band", schoolId: "S", day: "Tuesday", start: "11:00", end: "11:00",
    members: [{ studentId: "amy" }, { studentId: "bob" }],
    memberStates: [
      { enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", consumption: "regular", catchupId: null, consumedWeekKey: FW, fee: null, attended: null, writerTeacherId: null },
      { enrolmentId: "e_bob_drm", studentId: "bob", instrument: "Drums", consumption: "catchup", catchupId: "CU", consumedWeekKey: "2099-03-02", fee: null, attended: null, writerTeacherId: null },
    ],
    removedLessons: [amyCard],
  };
  const legacyBand = { id: "B_OLD", isBandSession: true, bandId: "BAND2", bandName: "Old", schoolId: "S", day: "Thursday", start: "13:00", end: "13:00", members: [{ studentId: "amy" }], removedLessons: [] };
  return {
    lessons: [bobCard, newBand, legacyBand],
    missed: [
      { id: "MISS_TUE", enrolmentId: "e_bob_drm", studentId: "bob", instrument: "Drums", schoolId: "S", day: "Tuesday", start: "10:00", reason: "informed_absence", makeupEligible: true, madeUp: false },
      { id: "MISS_THU", enrolmentId: "e_x", studentId: "x", instrument: "Piano", schoolId: "S", day: "Thursday", start: "09:30", reason: "informed_absence", makeupEligible: true, madeUp: false },
    ],
    notes: "some notes",
    breaks: [{ id: "BRK", day: "Monday", start: "10:30", end: "11:00" }],
    generatedAt: "2099-03-01T00:00:00.000Z",
  };
}

const ids = (list) => (list || []).map(l => l.id);
const bandIds = (list) => (list || []).filter(l => l.isBandSession).map(l => l.id);

// ── Characterization (commit 1) — import behaviour before the clean import ──
export function runMttImportCharacterizationTests(assert) {
  const week = existingWeek();

  // Whole-week import keeps every band card and re-imports every master card —
  // including Amy's, which the new band's ledger already holds (the doubling).
  const wk = buildMttImportForWeekSchool({ mtt: MTT, schoolId: "S", weekDates: weekDates(FW), existingEntry: week });
  assert("char import week: every band card kept, with its memberStates and ledger",
    [bandIds(wk.entry.lessons), wk.entry.lessons.find(l => l.id === "B_NEW").removedLessons.map(c => c.id), wk.preservedBandCount],
    [["B_NEW", "B_OLD"], ["W_AMY"], 2]);
  assert("char import week: Amy's master card re-imported beside the band that replaced her (doubled)",
    wk.entry.lessons.filter(l => !l.isBandSession).map(l => l.enrolmentId).sort(), ["e_amy_gtr", "e_bob_drm"]);
  assert("char import week: missed[] wiped; notes and breaks not carried",
    [wk.entry.missed, "notes" in wk.entry, "breaks" in wk.entry], [[], false, false]);

  // Day import keeps that day's bands and the other days as they were.
  const dy = buildMttImportForWeekSchool({ mtt: MTT, schoolId: "S", weekDates: weekDates(FW), existingEntry: week, targetDay: "Tuesday" });
  assert("char import day: that day's band kept, other days untouched, one master card imported",
    [bandIds(dy.entry.lessons), dy.importedCount, dy.preservedBandCount, ids(dy.entry.lessons).filter(i => i.startsWith("W_"))],
    [["B_OLD", "B_NEW"], 1, 1, []]);
  assert("char import day: only that day's missed entries wiped",
    ids(dy.entry.missed), ["MISS_THU"]);

  // A band-stamped miss is carried forward while its band survives the import.
  const stamped = { id: "W_AMY", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", schoolId: "S", day: "Thursday", start: "09:00", reason: "informed_absence", makeupEligible: true, madeUp: false, bandLessonId: "B_NEW" };
  assert("char import week: a band-stamped miss is carried forward while its band survives",
    ids(carryBandMisses(wk.entry.missed, [...week.missed, stamped], wk.entry.lessons)), ["W_AMY"]);

  // "Import all schools" rebuilds each school from master cards only, so the
  // band is gone — but its linked catch-up row is not deleted. With no band
  // to hide behind, the row draws as a loose catch-up card and still banks.
  const cu = { id: "CU", weekKey: FW, schoolId: "S", day: "Tuesday", time: "11:00", instrument: "Drums", enrolmentId: "e_bob_drm", resolvesEnrolmentId: "e_bob_drm", resolvesWeekKey: "2099-03-02", resolvesOriginalDay: "Tuesday", resolvesOriginalTime: "10:00", bandLessonId: "B_NEW" };
  const importAllLessons = MTT.lessons.filter(l => l.schoolId === "S");
  assert("char import all: band dropped, linked row left behind and drawn as a loose card",
    [bandIds(importAllLessons), mergeCatchupsIntoLessons(importAllLessons, [cu], FW).filter(l => l.__isCatchup).map(l => l.id)],
    [[], ["CU"]]);
  assert("char import all: the orphaned row still settles its miss (banking)",
    !!buildBankingIndex([cu]).get("e_bob_drm|2099-03-02"), true);
  assert("char import all: with the band present the row is hidden behind it",
    mergeCatchupsIntoLessons(week.lessons, [cu], FW).filter(l => l.__isCatchup).length, 0);
}

// ── planCleanImport (commit 2) ──────────────────────────────────────────
export function runCleanImportPlanTests(assert) {
  const week = existingWeek();
  const opts = { weekKey: FW, schoolId: "S" };
  const cu = { id: "CU", weekKey: FW, schoolId: "S", enrolmentId: "e_bob_drm", bandLessonId: "B_NEW" };
  // Stamp lost from memberStates but row still points at the band.
  const cuStampOnly = { id: "CU2", weekKey: FW, schoolId: "S", enrolmentId: "e_amy_gtr", bandLessonId: "B_NEW" };
  // In memberStates only (no bandLessonId on the row).
  const week2 = existingWeek();
  week2.lessons[1].memberStates[0] = { ...week2.lessons[1].memberStates[0], consumption: "catchup", catchupId: "CU3" };
  const cuIdOnly = { id: "CU3", weekKey: FW, schoolId: "S", enrolmentId: "e_amy_gtr", bandLessonId: null };
  const plain = { id: "PLAIN", weekKey: FW, schoolId: "S", enrolmentId: "e_bob_drm", bandLessonId: null };
  const otherWeek = { id: "OW", weekKey: "2099-03-16", schoolId: "S", bandLessonId: "B_NEW" };
  const otherSchool = { id: "OS", weekKey: FW, schoolId: "T", bandLessonId: "B_NEW" };

  const p = planCleanImport(week2, [cu, cu, cuStampOnly, cuIdOnly, plain, otherWeek, otherSchool], opts);
  assert("clean plan: rows = memberStates ids ∪ bandLessonId matches, de-duplicated, this week + school only",
    p.rowsToDelete.map(r => r.id).sort(), ["CU", "CU2", "CU3"]);
  assert("clean plan: catch-ups not linked to a band are never included",
    p.rowsToDelete.some(r => r.id === "PLAIN"), false);

  const w = planCleanImport(week, [cu], opts);
  assert("clean plan week: every band card removed (new and legacy), other cards kept, nothing to restore",
    [w.removedBandIds, w.removedBandCount, w.legacyBandCount, ids(w.lessons), w.restoreCards],
    [["B_NEW", "B_OLD"], 2, 1, ["W_BOB"], []]);

  // Day scope: only Tuesday's band goes; Thursday's legacy band stays. The
  // removed band's ledger card for Amy sits on Thursday, which a Tuesday import
  // does not rebuild, so it is handed back for restore.
  const d = planCleanImport(week, [cu], { ...opts, day: "Tuesday" });
  assert("clean plan day: only that day's band removed; other days' bands kept",
    [d.removedBandIds, bandIds(d.lessons)], [["B_NEW"], ["B_OLD"]]);
  assert("clean plan day: the removed band's out-of-scope ledger card is returned for restore",
    ids(d.restoreCards), ["W_AMY"]);
  const thu = planCleanImport(week, [], { ...opts, day: "Thursday" });
  assert("clean plan day: legacy band removed on its own day; nothing hangs off it",
    [thu.removedBandIds, thu.rowsToDelete, thu.restoreCards, thu.legacyBandCount], [["B_OLD"], [], [], 1]);

  // A regular absence (card moved out of the ledger into a stamped miss) on
  // another day comes back too, as manual removal would restore it.
  const absWeek = existingWeek();
  const card = absWeek.lessons[1].removedLessons[0];
  absWeek.lessons[1] = { ...absWeek.lessons[1], removedLessons: [] };
  absWeek.missed = [...absWeek.missed, { ...card, reason: "informed_absence", makeupEligible: true, madeUp: false, bandLessonId: "B_NEW", ledgerCard: card }];
  assert("clean plan day: a regular absence's card on another day is returned for restore",
    planCleanImport(absWeek, [], { ...opts, day: "Tuesday" }).restoreCards, [card]);

  // Free / not-in-session / absent members add nothing beyond their band's rows.
  const mixed = existingWeek();
  mixed.lessons[1].memberStates = [
    { enrolmentId: "e_a", studentId: "a", consumption: "free", catchupId: null, attended: false },
    { enrolmentId: "e_b", studentId: "b", consumption: "not_in_session", catchupId: null, attended: null },
    { enrolmentId: "e_c", studentId: "c", consumption: "catchup", catchupId: null, attended: false,
      absentCatchupSnapshot: { id: "GONE" } },
  ];
  assert("clean plan: free / not-in-session / absent-with-deleted-row members add no rows",
    planCleanImport(mixed, [{ id: "GONE", weekKey: FW, schoolId: "S", bandLessonId: null }], opts).rowsToDelete, []);

  const empty = planCleanImport({ lessons: [{ id: "X", day: "Monday" }], missed: [] }, [cu], opts);
  assert("clean plan: zero-band week → nothing removed, nothing deleted",
    [empty.removedBandCount, empty.rowsToDelete, ids(empty.lessons)], [0, [], ["X"]]);
  assert("clean plan: missing entry is safe",
    planCleanImport(null, [cu], opts).removedBandCount, 0);

  // Import all: per-school plans, totals summed by the caller.
  const s2 = { lessons: [{ id: "B_T", isBandSession: true, day: "Monday", memberStates: [], removedLessons: [] }], missed: [] };
  const plans = [planCleanImport(week, [cu, otherSchool], opts), planCleanImport(s2, [cu, otherSchool], { weekKey: FW, schoolId: "T" })];
  assert("clean plan multi-school: totals across schools",
    [plans.reduce((n, pl) => n + pl.removedBandCount, 0), plans.flatMap(pl => pl.rowsToDelete).map(r => r.id)],
    [3, ["CU"]]);
}
