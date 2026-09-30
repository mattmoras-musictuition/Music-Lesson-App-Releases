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

import { buildMttImportForWeekSchool, importClearedMissedCount, importMissedLine } from "../utils/mttImport";
import { carryBandMisses, planCleanImport } from "./bandAbsence";
import { mergeCatchupsIntoLessons, buildBankingIndex } from "./catchupsDerive";
import { removeCatchupsInBackground } from "../utils/catchupsDB";

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

// ── Characterization (commit 1, updated in commit 3) ────────────────────
// Every call below uses the options the app's import paths now pass
// (dropBands + catchups). Assertions whose result changed with the clean
// import are marked "(clean)".
const CU = { id: "CU", weekKey: FW, schoolId: "S", day: "Tuesday", time: "11:00", instrument: "Drums", enrolmentId: "e_bob_drm", resolvesEnrolmentId: "e_bob_drm", resolvesWeekKey: "2099-03-02", resolvesOriginalDay: "Tuesday", resolvesOriginalTime: "10:00", bandLessonId: "B_NEW" };
const clean = { dropBands: true, catchups: [CU] };

export function runMttImportCharacterizationTests(assert) {
  const week = existingWeek();

  // Whole-week import: every band card goes, with its linked row; Amy's
  // master card comes back once, with no band beside it.
  const wk = buildMttImportForWeekSchool({ mtt: MTT, schoolId: "S", weekDates: weekDates(FW), existingEntry: week, ...clean });
  assert("char import week (clean): no band cards kept; the band's linked row queued for deletion",
    [bandIds(wk.entry.lessons), wk.preservedBandCount, wk.removedBandCount, ids(wk.rowsToDelete)],
    [[], 0, 2, ["CU"]]);
  assert("char import week (clean): Amy's master card re-imported once, no band beside it",
    wk.entry.lessons.filter(l => !l.isBandSession).map(l => l.enrolmentId).sort(), ["e_amy_gtr", "e_bob_drm"]);
  assert("char import week: missed[] wiped; notes and breaks not carried",
    [wk.entry.missed, "notes" in wk.entry, "breaks" in wk.entry], [[], false, false]);

  // Day import: only that day's band goes. Its ledger card for Amy sits on
  // Thursday, which a Tuesday import does not rebuild, so it is restored.
  const dy = buildMttImportForWeekSchool({ mtt: MTT, schoolId: "S", weekDates: weekDates(FW), existingEntry: week, targetDay: "Tuesday", ...clean });
  assert("char import day (clean): that day's band removed, other days' band kept, out-of-scope ledger card restored",
    [bandIds(dy.entry.lessons), dy.importedCount, dy.preservedBandCount, ids(dy.entry.lessons).filter(i => i.startsWith("W_")), ids(dy.rowsToDelete)],
    [["B_OLD"], 1, 0, ["W_AMY"], ["CU"]]);
  assert("char import day: only that day's missed entries wiped",
    ids(dy.entry.missed), ["MISS_THU"]);

  // A band-stamped miss is carried forward while its band survives (a
  // Thursday import leaves Tuesday's band), and dropped once it is removed.
  const stamped = { id: "W_AMY", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", schoolId: "S", day: "Thursday", start: "09:00", reason: "informed_absence", makeupEligible: true, madeUp: false, bandLessonId: "B_NEW" };
  const thu = buildMttImportForWeekSchool({ mtt: MTT, schoolId: "S", weekDates: weekDates(FW), existingEntry: week, targetDay: "Thursday", ...clean });
  assert("char import (clean): band-stamped miss carried while its band survives, dropped once removed",
    [ids(carryBandMisses(thu.entry.missed, [...week.missed, stamped], thu.entry.lessons)),
      ids(carryBandMisses(wk.entry.missed, [...week.missed, stamped], wk.entry.lessons))],
    [["MISS_TUE", "W_AMY"], []]);

  // "Import all schools" rebuilds each school from master cards only; the
  // removed band's linked row is now deleted instead of being orphaned, so it
  // no longer draws as a loose card and no longer banks.
  const importAllLessons = MTT.lessons.filter(l => l.schoolId === "S");
  const allRows = planCleanImport(week, [CU], { weekKey: FW, schoolId: "S" }).rowsToDelete;
  const remaining = [CU].filter(c => !allRows.some(r => r.id === c.id));
  assert("char import all (clean): band dropped and its linked row queued for deletion, so nothing draws loose",
    [bandIds(importAllLessons), ids(allRows), mergeCatchupsIntoLessons(importAllLessons, remaining, FW).filter(l => l.__isCatchup).map(l => l.id)],
    [[], ["CU"], []]);
  assert("char import all (clean): the settled miss is owed again (no banking row left)",
    !!buildBankingIndex(remaining).get("e_bob_drm|2099-03-02"), false);
  assert("char import all: with the band present the row is hidden behind it",
    mergeCatchupsIntoLessons(week.lessons, [CU], FW).filter(l => l.__isCatchup).length, 0);
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

// ── Clean import wiring (commit 3) ──────────────────────────────────────
export function runCleanImportWiringTests(assert) {
  const week = existingWeek();

  // Without dropBands the builder behaves exactly as before v2.40.1.
  const legacy = buildMttImportForWeekSchool({ mtt: MTT, schoolId: "S", weekDates: weekDates(FW), existingEntry: week });
  assert("clean wiring: dropBands off keeps the pre-v2.40.1 behaviour (bands kept, no rows)",
    [bandIds(legacy.entry.lessons), legacy.preservedBandCount, "rowsToDelete" in legacy], [["B_NEW", "B_OLD"], 2, false]);

  // Day restore follows the occupied-slot rule: a card already in Amy's
  // Thursday 09:00 slot keeps it, and her ledger card is not put back.
  const busy = existingWeek();
  busy.lessons.push({ id: "W_OTHER", enrolmentId: "e_z", studentId: "z", instrument: "Flute", schoolId: "S", day: "Thursday", start: "09:00" });
  const dy = buildMttImportForWeekSchool({ mtt: MTT, schoolId: "S", weekDates: weekDates(FW), existingEntry: busy, targetDay: "Tuesday", dropBands: true, catchups: [] });
  assert("clean wiring: day restore skips an occupied slot",
    ids(dy.entry.lessons).filter(i => i.startsWith("W_")), ["W_OTHER"]);

  // Bulk removal takes the rows out of local state synchronously (no flash);
  // the deletes themselves are background work.
  let state = [{ id: "CU" }, { id: "KEEP" }, { id: "CU2" }];
  const setCatchups = (fn) => { state = fn(state); };
  removeCatchupsInBackground([{ id: "CU" }, { id: "CU2" }], { setCatchups, deleteFn: () => Promise.resolve() });
  const afterSync = state.map(c => c.id);
  let touched = false;
  removeCatchupsInBackground([], { setCatchups: () => { touched = true; } });
  assert("clean wiring: bulk removal leaves state at once; an empty list touches nothing",
    [afterSync, touched], [["KEEP"], false]);
}

// ── Confirmation count line (commit 4) ──────────────────────────────────
export function runImportMissedLineTests(assert) {
  const week = existingWeek();
  // A band absence for the Tuesday band whose card sits on Thursday, and one
  // for a band that no longer exists.
  week.missed.push(
    { id: "ABS_NEW", day: "Thursday", bandLessonId: "B_NEW" },
    { id: "ABS_GONE", day: "Monday", bandLessonId: "B_GONE" },
  );
  assert("missed line: week counts every entry; day counts what that import clears",
    [importClearedMissedCount(week), importClearedMissedCount(week, { day: "Tuesday" }),
      importClearedMissedCount(week, { day: "Thursday" }), importClearedMissedCount(week, { day: "Monday" })],
    // Tue: MISS_TUE + ABS_NEW (its band is removed) + ABS_GONE; Thu: MISS_THU + ABS_GONE
    // (Tuesday's band survives, so ABS_NEW is carried); Mon: ABS_GONE only.
    [4, 3, 2, 1]);
  assert("missed line: wording for week / day / all schools, singular and plural",
    [importMissedLine(1, "week"), importMissedLine(3, "week"), importMissedLine(1, "day", "Tuesday"),
      importMissedLine(2, "all")],
    ["1 missed lesson recorded this week will be cleared.", "3 missed lessons recorded this week will be cleared.",
      "1 missed lesson recorded on Tuesday will be cleared.", "2 missed lessons recorded this week across all schools will be cleared."]);
  assert("missed line: omitted when nothing is cleared",
    [importMissedLine(0, "week"), importMissedLine(0, "all"), importClearedMissedCount(null), importClearedMissedCount({ lessons: [], missed: [] }, { day: "Monday" })],
    [null, null, 0, 0]);
}
