// ============================================================
// ENROLMENT HISTORY SMOKE TESTS
// Ended-enrolment history ("instrument swap"). Called from runSmokeTests with
// its `assert`.
//
// The fixture is the real case that prompted the work: a student whose Drums
// enrolment ended on Saturday 3 Oct 2026 (holiday week 2, after term 3) with
// term 3 weekly history and no master card left, and whose new Piano
// enrolment starts Monday 5 Oct 2026 (term 4) with a master card.
//
// Term 3 2026 runs 13 Jul – 18 Sep (W1–W10), holidays 21 Sep and 28 Sep
// (H1–H2). Every school week is already past, so isDayPast6pm can never move
// a cell under these tests.
// ============================================================

import { deriveTallyRows } from "../utils/tallyDerive";
import { instrumentsFromEnrolments } from "../utils/enrolmentsDB";
import { stampFirstPlacementStart } from "../utils/enrolmentPlacement";

const SCHOOL_WEEKS = ["2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10",
  "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"];
const HOLIDAY_WEEKS = ["2026-09-21", "2026-09-28"];
const T3 = [
  ...SCHOOL_WEEKS.map((weekKey, i) => ({ weekKey, weekNum: i + 1, label: `W${i + 1}` })),
  ...HOLIDAY_WEEKS.map((weekKey, i) => ({ weekKey, weekNum: i + 1, label: `H${i + 1}`, isHoliday: true })),
];

const bonnie = { id: "bon", name: "Bonnie Teehan", schoolId: "S", status: "active" };
const drums = { id: "e_bon_drm", studentId: "bon", instrument: "Drums", startDate: "2026-01-27", endDate: "2026-10-03" };
const piano = { id: "e_bon_pno", studentId: "bon", instrument: "Piano", startDate: "2026-10-05" };
const pianoCard = { id: "M_pno", enrolmentId: "e_bon_pno", studentId: "bon", studentName: "Bonnie Teehan", instrument: "Piano", schoolId: "S", day: "Thursday", start: "09:00", teacherId: "t_jess", teacherName: "Jess" };

function drumLesson(weekKey) {
  return { id: "L_" + weekKey, enrolmentId: "e_bon_drm", studentId: "bon", studentName: "Bonnie Teehan", instrument: "Drums", schoolId: "S", day: "Wednesday", start: "10:00", teacherId: "t_sam", teacherName: "Sam" };
}
function drumMiss(weekKey, makeupEligible, madeUp = false) {
  return { id: "X_" + weekKey, enrolmentId: "e_bon_drm", studentId: "bon", studentName: "Bonnie Teehan", instrument: "Drums", schoolId: "S", day: "Wednesday", start: "10:00", teacherId: "t_sam", teacherName: "Sam", reason: "sick", makeupEligible, madeUp };
}

// Term 3 weekly data for the Drums enrolment: eight taught weeks, one owed
// miss (W4), one no-catch-up miss (W7).
function bonnieWtt() {
  const wtt = {};
  SCHOOL_WEEKS.forEach((wk, i) => {
    if (i === 3) wtt[`${wk}|S`] = { lessons: [], missed: [drumMiss(wk, true)] };
    else if (i === 6) wtt[`${wk}|S`] = { lessons: [], missed: [drumMiss(wk, false)] };
    else wtt[`${wk}|S`] = { lessons: [drumLesson(wk)], missed: [] };
  });
  return wtt;
}

// TallyView's on-screen / export tile maths (computeStats), copied so the
// tiles can be pinned without rendering.
function tiles(rows, entries, termWeeks) {
  const termWeekKeys = new Set(termWeeks.filter(w => !w.isHoliday).map(w => w.weekKey));
  const termWeekCount = termWeekKeys.size;
  const keySet = new Set(rows.map(r => r.lessonKey));
  const visible = Object.values(entries).filter(e => keySet.has(e.lessonKey) && termWeekKeys.has(e.weekKey));
  const removed = visible.filter(e => e.status === "removed").length;
  const totalCells = rows.length * termWeekCount - removed;
  const completed = visible.filter(e => e.status === "completed").length;
  const missed = visible.filter(e => e.status === "missed").length;
  const makeupOwed = visible.filter(e => e.status === "missed" && e.makeupEligible && !e.madeUp).length;
  const madeUp = visible.filter(e => e.madeUp).length;
  return { totalCells, completed, missed, makeupOwed, madeUp, unmarked: totalCells - completed - missed };
}

function deriveT3({ enrolments, students = [bonnie], wtt = bonnieWtt(), cards = [pianoCard], termWeeks = T3 }) {
  return deriveTallyRows({ enrolments, students, termWeeks, weeklyTimetables: wtt, timetable: { lessons: cards }, schoolFilter: "all" });
}

function cellStates(row, termWeeks = T3) {
  return termWeeks.map(w => row.cells[w.weekKey].state);
}

// The Drums row snapshot that must not move when the Tally row gate lands:
// cells, the row's own entry counts, and the term tiles.
export function drumsSnapshot(result) {
  const row = result.tallyRows.find(r => r.lessonKey === "bon|Drums");
  if (!row) return null;
  const own = Object.values(result.entryMap).filter(e => e.lessonKey === "bon|Drums");
  const count = (s) => own.filter(e => e.status === s).length;
  return {
    cells: cellStates(row),
    counts: { completed: count("completed"), missed: count("missed"), removed: count("removed") },
    rowTiles: tiles([row], result.entryMap, T3),
    termTiles: tiles(result.tallyRows, result.entryMap, T3),
  };
}

const DRUMS_CELLS = ["completed", "completed", "completed", "missed-makeup-owed", "completed",
  "completed", "missed-no-catchup", "completed", "completed", "completed", "blank", "blank"];
const DRUMS_SNAPSHOT = {
  cells: DRUMS_CELLS,
  counts: { completed: 8, missed: 2, removed: 0 },
  rowTiles: { totalCells: 10, completed: 8, missed: 2, makeupOwed: 1, madeUp: 0, unmarked: 0 },
  termTiles: { totalCells: 10, completed: 8, missed: 2, makeupOwed: 1, madeUp: 0, unmarked: 0 },
};

// ── Commit 1: characterization (current behaviour) ──────────────────────
export function runEnrolmentHistoryCharacterizationTests(assert) {
  // a. Ended Drums + new Piano: today both get a term 3 row. Piano's row
  //    exists only because it has a master card; every cell is inactive.
  const a = deriveT3({ enrolments: [drums, piano] });
  assert("history char a: ended Drums + new Piano → 2 term 3 rows today",
    a.tallyRows.map(r => r.lessonKey).sort(), ["bon|Drums", "bon|Piano"]);
  assert("history char a: today's Piano row is all inactive",
    cellStates(a.tallyRows.find(r => r.lessonKey === "bon|Piano")).every(s => s === "inactive"), true);
  // Variant: Piano starting in holiday week 2 — active in H2 only.
  const pianoH2 = { ...piano, startDate: "2026-09-28" };
  const aH = deriveT3({ enrolments: [drums, pianoH2] });
  assert("history char a (holiday start): still 2 rows today",
    aH.tallyRows.map(r => r.lessonKey).sort(), ["bon|Drums", "bon|Piano"]);
  assert("history char a (holiday start): Piano cells inactive except H2",
    cellStates(aH.tallyRows.find(r => r.lessonKey === "bon|Piano")),
    [...SCHOOL_WEEKS.map(() => "inactive"), "inactive", "blank"]);

  // b. Drums row: cells, counts and tiles. The term tiles already equal the
  //    Drums row's because Piano's all-inactive cells subtract themselves.
  assert("history char b: Drums snapshot", drumsSnapshot(a), DRUMS_SNAPSHOT);
  const drumsRow = a.tallyRows.find(r => r.lessonKey === "bon|Drums");
  assert("history char b: Drums row has no teacher today (no master card), day from weekly data",
    [drumsRow.teacherName, drumsRow.day], ["", "Wednesday"]);

  // c. Archived students: the enrolment-overlap fast exit.
  const arch = { ...bonnie, status: "archived" };
  const endedBefore = { ...drums, endDate: "2026-07-03" };
  assert("history char c: archived, enrolment ended before term → no row",
    deriveT3({ enrolments: [endedBefore], students: [arch], cards: [] }).tallyRows.length, 0);
  assert("history char c: archived, enrolment overlaps term with data → row",
    deriveT3({ enrolments: [drums], students: [arch], cards: [] }).tallyRows.map(r => [r.lessonKey, r._archived]),
    [["bon|Drums", true]]);
  assert("history char c: archived, overlapping but no weekly data → no row",
    deriveT3({ enrolments: [drums], students: [arch], cards: [], wtt: {} }).tallyRows.length, 0);

  // d. Cluster 4 note 6: a new-band tick with no Regular attribution is not
  //    activity, so a student with nothing else has no row.
  const cleo = { id: "cleo", name: "Cleo", schoolId: "S", status: "active" };
  const eCleo = { id: "e_cleo_gtr", studentId: "cleo", instrument: "Guitar", startDate: "2026-01-27" };
  const bandWtt = { [`${SCHOOL_WEEKS[2]}|S`]: { lessons: [{
    id: "B1", isBandSession: true, bandId: "BAND", schoolId: "S", day: "Tuesday", start: "11:00", members: [], removedLessons: [],
    memberStates: [{ studentId: "cleo", enrolmentId: "e_cleo_gtr", instrument: "Guitar", consumption: "free" }],
  }], missed: [] } };
  assert("history char d: new-band tick without Regular → no row",
    deriveT3({ enrolments: [eCleo], students: [cleo], wtt: bandWtt, cards: [] }).tallyRows.length, 0);

  // e. Group rows. One row per group, claimed by the first enrolment in
  //    preference order (live first, then LATER start first).
  const libby = { id: "libby", name: "Libby", schoolId: "S", status: "active" };
  const ivy = { id: "ivy", name: "Ivy", schoolId: "S", status: "active" };
  const gL = { id: "e_libby_uke", studentId: "libby", instrument: "Ukulele", isGroup: true, groupId: "g_uke", startDate: "2026-01-27" };
  const gI = { id: "e_ivy_uke", studentId: "ivy", instrument: "Ukulele", isGroup: true, groupId: "g_uke", startDate: "2026-01-27" };
  const groupCard = { id: "M_grp", isGroup: true, groupId: "g_uke", groupName: "Ukulele Group", enrolmentId: "e_libby_uke", studentId: "libby", instrument: "Ukulele", schoolId: "S", day: "Friday", start: "13:00", teacherName: "Jess" };
  const groupWtt = {};
  SCHOOL_WEEKS.forEach(wk => { groupWtt[`${wk}|S`] = { lessons: [{ id: "G_" + wk, isGroup: true, groupId: "g_uke", groupName: "Ukulele Group", enrolmentId: "e_libby_uke", schoolId: "S", day: "Friday", start: "13:00" }], missed: [] }; });
  const gActive = deriveT3({ enrolments: [gL, gI], students: [libby, ivy], wtt: groupWtt, cards: [groupCard] });
  // Equal start dates fall back to id order, so Ivy's row claims it.
  assert("history char e: group with term activity → one row, all completed",
    gActive.tallyRows.map(r => [r.lessonKey, r.enrolmentId, cellStates(r).slice(0, 10).every(s => s === "completed")]),
    [["group|g_uke", "e_ivy_uke", true]]);
  // Ivy joins after the term: her later start puts her row first, so today it
  // claims the group row and every school week dashes despite the lessons.
  const gILate = { ...gI, startDate: "2026-10-05" };
  const gLate = deriveT3({ enrolments: [gL, gILate], students: [libby, ivy], wtt: groupWtt, cards: [groupCard] });
  assert("history char e: late joiner claims the group row today, school weeks all inactive",
    gLate.tallyRows.map(r => [r.lessonKey, r.enrolmentId, cellStates(r).slice(0, 10).every(s => s === "inactive")]),
    [["group|g_uke", "e_ivy_uke", true]]);

  // f. Orphan predicate building block. checkOrphan lives inside an App.js
  //    effect today, so only its input is reachable here: the active-only
  //    instrument list. An ended enrolment contributes nothing, so every
  //    weekly lesson on it is flagged "instrument not in student record".
  //    The case-insensitive compare, the group/band skips and "student not
  //    found" can only be pinned after extraction (commit 2).
  assert("history char f: ended-only enrolment gives no instruments (lesson flagged today)",
    instrumentsFromEnrolments("bon", [drums]), []);
  assert("history char f: ended + active same instrument gives the active one",
    instrumentsFromEnrolments("bon", [drums, { ...drums, id: "e_bon_drm2", startDate: "2026-10-05", endDate: undefined }]).map(i => i.name), ["Drums"]);

  // g. Archive weekly purge: inline in App.js (onArchiveStudent and the
  //    assistant's archive_student) with no extracted helper, so it cannot be
  //    called from here. Today it filters the student's lessons out of EVERY
  //    weekly entry, past and future, and leaves misses alone. Pinned after
  //    extraction in commit 5.

  // h. stampFirstPlacementStart.
  const fresh = { id: "e_new", studentId: "bon", instrument: "Piano", startDate: "2026-06-01" };
  assert("history char h: first placement stamps the Monday",
    stampFirstPlacementStart({ enrolments: [fresh], enrolmentId: "e_new", weekMonday: "2026-10-05", timetableLessons: [] })[0].startDate, "2026-10-05");
  assert("history char h: already placed declines",
    stampFirstPlacementStart({ enrolments: [fresh], enrolmentId: "e_new", weekMonday: "2026-10-05", timetableLessons: [{ enrolmentId: "e_new" }] })[0].startDate, "2026-06-01");
  assert("history char h: ended enrolment declines",
    stampFirstPlacementStart({ enrolments: [{ ...fresh, endDate: "2026-09-01" }], enrolmentId: "e_new", weekMonday: "2026-10-05", timetableLessons: [] })[0].startDate, "2026-06-01");
  assert("history char h: moving earlier stamps",
    stampFirstPlacementStart({ enrolments: [{ ...fresh, startDate: "2026-10-12" }], enrolmentId: "e_new", weekMonday: "2026-10-05", timetableLessons: [] })[0].startDate, "2026-10-05");
  // Re-placement after the master was cleared: the enrolment has taught term 3
  // weeks but no card, so today it is restamped LATER than its own history.
  const taught = { id: "e_bon_drm_live", studentId: "bon", instrument: "Drums", startDate: "2026-07-13" };
  assert("history char h: re-placement after clearing restamps later than history today",
    stampFirstPlacementStart({ enrolments: [taught], enrolmentId: "e_bon_drm_live", weekMonday: "2026-10-05", timetableLessons: [] })[0].startDate, "2026-10-05");
}
