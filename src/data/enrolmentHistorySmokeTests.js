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
import { stampFirstPlacementStart, hasWeeklyHistoryBefore } from "../utils/enrolmentPlacement";
import { checkOrphan } from "../utils/orphanCheck";
import { purgeWeeklyAfterArchive } from "../utils/archiveCascade";
import { validateEndDateEdit, isEndDateEditable, applyEndDateEdit, newlyEndedEnrolments } from "../utils/enrolmentEndDate";
import { melbourneToday } from "../utils/helpers";

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
  // a. Ended Drums + new Piano. Before v2.44.0 both got a term 3 row and
  //    Piano's was all inactive (it existed only through its master card).
  //    The term overlap gate drops it: no school week of term 3 is active.
  const a = deriveT3({ enrolments: [drums, piano] });
  assert("history a: ended Drums + new Piano → only the Drums row in term 3",
    a.tallyRows.map(r => r.lessonKey).sort(), ["bon|Drums"]);
  // Variant: Piano starting in holiday week 2 — active in H2 only, which is
  // a holiday week and so never earns a row.
  const pianoH2 = { ...piano, startDate: "2026-09-28" };
  const aH = deriveT3({ enrolments: [drums, pianoH2] });
  assert("history a (holiday start): only the Drums row",
    aH.tallyRows.map(r => r.lessonKey).sort(), ["bon|Drums"]);

  // b. Drums row: cells, counts and tiles. The term tiles already equal the
  //    Drums row's because Piano's all-inactive cells subtract themselves.
  assert("history char b: Drums snapshot", drumsSnapshot(a), DRUMS_SNAPSHOT);
  const drumsRow = a.tallyRows.find(r => r.lessonKey === "bon|Drums");
  // v2.49.10 — the day still comes from the latest weekly entry; the row
  // carries no teacher label even though the weekly entries do.
  assert("history b: Drums row takes its day from its latest weekly entry and carries no teacher",
    ["teacherId" in drumsRow, "teacherName" in drumsRow, drumsRow.day], [false, false, "Wednesday"]);

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
  // Ivy joins after the term: her later start puts her row first. Before
  // v2.44.0 it claimed the group row and every school week dashed despite the
  // lessons. The gate now passes it over unclaimed, so Libby's enrolment —
  // active all term — claims the row and the lessons show.
  const gILate = { ...gI, startDate: "2026-10-05" };
  const gLate = deriveT3({ enrolments: [gL, gILate], students: [libby, ivy], wtt: groupWtt, cards: [groupCard] });
  assert("history e: late joiner no longer claims the group row; the active member's enrolment does",
    gLate.tallyRows.map(r => [r.lessonKey, r.enrolmentId, cellStates(r).slice(0, 10).every(s => s === "completed")]),
    [["group|g_uke", "e_libby_uke", true]]);
  // Every member joined after the term: no member is active in a school
  // week, so the group has no row.
  const gLLate = { ...gL, startDate: "2026-10-05" };
  assert("history e: group whose members all start after the term has no row",
    deriveT3({ enrolments: [gLLate, gILate], students: [libby, ivy], wtt: {}, cards: [groupCard] }).tallyRows.length, 0);

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
  //    assistant's archive_student) before v2.44.0, with no extracted helper,
  //    so it could not be called from here. It filtered the student's lessons
  //    out of EVERY weekly entry, past and future, and left misses alone.
  //    Replaced by utils/archiveCascade — see runArchiveCascadeTests.

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

// ── Commit 2: Data Health orphan rule (utils/orphanCheck) ───────────────
export function runOrphanCheckTests(assert) {
  const ctx = { students: [bonnie], enrolments: [drums, piano] };
  const reason = (lesson, where, c = ctx) => { const r = checkOrphan(lesson, where, c); return r ? r.reason : null; };
  const lessonIn = (weekKey, extra = {}) => ({ ...drumLesson(weekKey), ...extra });

  assert("orphan: weekly lesson inside the ended span is not an orphan",
    reason(lessonIn("2026-08-10"), "2026-08-10|S"), null);
  assert("orphan: the week containing the end date is still active",
    reason(lessonIn("2026-09-28"), "2026-09-28|S"), null);
  assert("orphan: weekly lesson after the end week is an orphan",
    reason(lessonIn("2026-10-05"), "2026-10-05|S"), "enrolment not active that week");
  assert("orphan: master card for an ended enrolment is an orphan (running-enrolment rule)",
    reason({ ...drumLesson("x"), id: "M_drm" }, "master"), "instrument not in student record");
  assert("orphan: master card for a running enrolment is fine",
    reason(pianoCard, "master"), null);
  assert("orphan: missing startDate counts as started",
    reason(lessonIn("2020-02-03"), "2020-02-03|S", { students: [bonnie], enrolments: [{ ...drums, startDate: undefined }] }), null);
  assert("orphan: missing student is an orphan",
    reason({ ...lessonIn("2026-08-10"), studentId: "ghost" }, "2026-08-10|S"), "student not found");
  assert("orphan: instrument match is case-insensitive (no enrolmentId on the lesson)",
    reason(lessonIn("2026-08-10", { enrolmentId: undefined, instrument: " drums " }), "2026-08-10|S"), null);
  assert("orphan: unknown instrument is an orphan",
    reason(lessonIn("2026-08-10", { enrolmentId: undefined, instrument: "Violin" }), "2026-08-10|S"), "instrument not in student record");
  // Two Drums enrolments: the old one ended, a new one running from term 4.
  const drums2 = { id: "e_bon_drm2", studentId: "bon", instrument: "Drums", startDate: "2026-10-05" };
  const two = { students: [bonnie], enrolments: [drums, drums2] };
  assert("orphan: two same-instrument enrolments — a term 3 lesson stamped to the NEW one still matches the old by instrument",
    reason(lessonIn("2026-08-10", { enrolmentId: "e_bon_drm2" }), "2026-08-10|S", two), null);
  assert("orphan: two same-instrument enrolments — a term 4 lesson stamped to the OLD one matches the new by instrument",
    reason(lessonIn("2026-10-12"), "2026-10-12|S", two), null);
  assert("orphan: two same-instrument enrolments — a master card is fine while one is running",
    reason({ ...drumLesson("x"), id: "M_drm" }, "master", two), null);
  assert("orphan: groups and band sessions are skipped",
    [reason({ isGroup: true, groupId: "g", studentId: "ghost" }, "2026-08-10|S"),
     reason({ isBandSession: true, members: [] }, "2026-08-10|S"),
     reason({ isBandSession: true, members: [] }, "master")], [null, null, null]);
}

// ── Commit 3: Tally term overlap gate + teacher fallback ────────────────
export function runTallyOverlapGateTests(assert) {
  // Mid-term swap: Drums ends Wed of W5, Piano starts W6 with a card. Both
  // have live school weeks in term 3, so both rows stay.
  const drumsMid = { ...drums, endDate: "2026-08-12" };
  const pianoMid = { ...piano, startDate: "2026-08-17" };
  const wtt = {};
  SCHOOL_WEEKS.forEach((wk, i) => {
    wtt[`${wk}|S`] = i < 5
      ? { lessons: [drumLesson(wk)], missed: [] }
      : { lessons: [{ ...pianoCard, id: "P_" + wk }], missed: [] };
  });
  const mid = deriveT3({ enrolments: [drumsMid, pianoMid], wtt });
  const byKey = Object.fromEntries(mid.tallyRows.map(r => [r.lessonKey, r]));
  assert("gate: mid-term swap shows both rows",
    Object.keys(byKey).sort(), ["bon|Drums", "bon|Piano"]);
  assert("gate: mid-term swap — Drums active W1–W5, Piano W6–W10",
    [cellStates(byKey["bon|Drums"]).slice(0, 10), cellStates(byKey["bon|Piano"]).slice(0, 10)],
    [[...Array(5).fill("completed"), ...Array(5).fill("inactive")],
     [...Array(5).fill("inactive"), ...Array(5).fill("completed")]]);
  // The Piano row is built from a master card that stores teacherId/teacherName;
  // neither row carries them.
  assert("gate: mid-term swap — neither row carries a teacher label",
    ["teacherName" in byKey["bon|Drums"], "teacherId" in byKey["bon|Piano"], "teacherName" in byKey["bon|Piano"]], [false, false, false]);

  // Previous-term export: TallyView re-derives the old term with every
  // school, school weeks then holiday weeks flagged isHoliday — the same
  // shape as T3 here. It must give the same rows and tiles as on screen.
  const onScreen = deriveT3({ enrolments: [drums, piano] });
  const exported = deriveTallyRows({ enrolments: [drums, piano], students: [bonnie], termWeeks: T3,
    weeklyTimetables: bonnieWtt(), timetable: { lessons: [pianoCard] }, schoolFilter: "all" });
  assert("gate: previous-term export has the same rows as the on-screen term",
    [exported.tallyRows.map(r => r.lessonKey), onScreen.tallyRows.map(r => r.lessonKey)], [["bon|Drums"], ["bon|Drums"]]);
  assert("gate: previous-term export tiles match the Drums snapshot",
    drumsSnapshot(exported), DRUMS_SNAPSHOT);

  // Term 4 view of the same student: Drums has nothing live there and Piano
  // has its card, so only Piano shows — the swap reads cleanly both ways.
  const T4 = ["2026-10-05", "2026-10-12"].map((weekKey, i) => ({ weekKey, weekNum: i + 1, label: `W${i + 1}` }));
  assert("gate: term 4 shows only the new Piano row",
    deriveT3({ enrolments: [drums, piano], wtt: {}, termWeeks: T4 }).tallyRows.map(r => r.lessonKey), ["bon|Piano"]);

  // Duplicate enrolments: a preferred row that is inactive all term no longer
  // claims the lessonKey with a dead row — the older, live duplicate does.
  const drumsNew = { id: "e_bon_drm_new", studentId: "bon", instrument: "Drums", startDate: "2026-10-05" };
  const drumsNewCard = { ...pianoCard, id: "M_drm_new", enrolmentId: "e_bon_drm_new", instrument: "Drums" };
  const dup = deriveT3({ enrolments: [drums, drumsNew], cards: [drumsNewCard] });
  assert("gate: a duplicate starting after the term yields to the live one",
    dup.tallyRows.map(r => [r.lessonKey, r.enrolmentId]), [["bon|Drums", "e_bon_drm"]]);

  // Cells copy no teacher label from the weekly entries they are built from.
  const cellEntries = Object.values(deriveT3({ enrolments: [drums], cards: [] }).entryMap);
  assert("gate: tally cells carry no teacher label",
    [cellEntries.length > 0, cellEntries.some(c => "teacherId" in c || "teacherName" in c)], [true, false]);
}

// ── Commit 4: restamp guard (stampFirstPlacementStart) ──────────────────
export function runRestampGuardTests(assert) {
  const taught = { id: "e_bon_drm_live", studentId: "bon", instrument: "Drums", startDate: "2026-07-13" };
  const wtt = { "2026-07-20|S": { lessons: [{ ...drumLesson("2026-07-20"), enrolmentId: "e_bon_drm_live" }], missed: [] } };
  const stamp = (enrolment, weekMonday, weeklyTimetables, timetableLessons = []) =>
    stampFirstPlacementStart({ enrolments: [enrolment], enrolmentId: enrolment.id, weekMonday, timetableLessons, weeklyTimetables })[0].startDate;

  assert("restamp: re-placement after clearing keeps a start date that has earlier weekly lessons",
    stamp(taught, "2026-10-05", wtt), "2026-07-13");
  assert("restamp: a miss in an earlier week also blocks moving later",
    stamp(taught, "2026-10-05", { "2026-08-03|S": { lessons: [], missed: [{ ...drumMiss("2026-08-03", true), enrolmentId: "e_bon_drm_live" }] } }), "2026-07-13");
  assert("restamp: a legacy entry with no enrolmentId matches by student + instrument",
    stamp(taught, "2026-10-05", { "2026-07-20|S": { lessons: [{ ...drumLesson("2026-07-20"), enrolmentId: undefined }], missed: [] } }), "2026-07-13");
  assert("restamp: an entry stamped with a different enrolment is not this one's history",
    stamp(taught, "2026-10-05", { "2026-07-20|S": { lessons: [{ ...drumLesson("2026-07-20"), enrolmentId: "e_other" }], missed: [] } }), "2026-10-05");
  assert("restamp: weekly entries only in the candidate week or later do not block",
    stamp(taught, "2026-10-05", { "2026-10-05|S": { lessons: [{ ...drumLesson("2026-10-05"), enrolmentId: "e_bon_drm_live" }], missed: [] } }), "2026-10-05");
  assert("restamp: moving earlier still stamps despite history",
    stamp({ ...taught, startDate: "2026-10-12" }, "2026-10-05", wtt), "2026-10-05");
  assert("restamp: a fresh enrolment with no weekly history stamps as before",
    stamp({ id: "e_new", studentId: "bon", instrument: "Piano", startDate: "2026-06-01" }, "2026-10-05", wtt), "2026-10-05");
  assert("restamp: no weeklyTimetables passed behaves as before",
    stamp(taught, "2026-10-05", undefined), "2026-10-05");
  assert("restamp: band sessions never count as history",
    hasWeeklyHistoryBefore(taught, "2026-10-05", { "2026-07-20|S": { lessons: [{ isBandSession: true, members: [{ studentId: "bon", instrument: "Drums" }] }], missed: [] } }), false);
  const grp = { id: "e_g", studentId: "libby", instrument: "Ukulele", isGroup: true, groupId: "g_uke", startDate: "2026-07-13" };
  assert("restamp: a group enrolment matches its group's legacy weekly card",
    stamp(grp, "2026-10-05", { "2026-07-20|S": { lessons: [{ id: "G1", isGroup: true, groupId: "g_uke" }], missed: [] } }), "2026-07-13");
}

// ── Commit 5: archive keeps past and current weeks (utils/archiveCascade) ─
export function runArchiveCascadeTests(assert) {
  const other = { ...drumLesson("x"), id: "OTHER", studentId: "zed", enrolmentId: "e_zed" };
  const bandEntry = { id: "BAND1", isBandSession: true, members: [{ studentId: "bon", instrument: "Drums" }],
    memberStates: [{ studentId: "bon", enrolmentId: "e_bon_drm", instrument: "Drums", consumption: "regular" }],
    removedLessons: [{ studentId: "bon", instrument: "Drums", enrolmentId: "e_bon_drm" }] };
  const week = (wk, withMiss) => ({
    lessons: [drumLesson(wk), other, bandEntry],
    missed: withMiss ? [drumMiss(wk, true)] : [],
    notes: "n",
  });
  const wtt = {
    "2026-09-28|S": week("2026-09-28", true),   // past week
    "2026-10-05|S": week("2026-10-05", true),   // current week (archived Wed 7 Oct)
    "2026-10-12|S": week("2026-10-12", true),   // future
    "2026-10-19|S2": week("2026-10-19", false), // future, other school
  };
  const out = purgeWeeklyAfterArchive(wtt, "bon", "2026-10-07");
  const ids = (k) => [out[k].lessons.map(l => l.id), out[k].missed.map(m => m.id)];
  assert("archive: past week untouched (same object)", out["2026-09-28|S"] === wtt["2026-09-28|S"], true);
  assert("archive: current week (contains the archive date) untouched", out["2026-10-05|S"] === wtt["2026-10-05|S"], true);
  assert("archive: future week loses the student's lessons and misses, keeps others and the band",
    ids("2026-10-12|S"), [["OTHER", "BAND1"], []]);
  assert("archive: future week at another school cleared too", ids("2026-10-19|S2"), [["OTHER", "BAND1"], []]);
  assert("archive: band memberStates and ledger left as they were",
    out["2026-10-12|S"].lessons.find(l => l.id === "BAND1") === bandEntry, true);
  assert("archive: other entry fields kept", out["2026-10-12|S"].notes, "n");
  assert("archive: the input map is not mutated", wtt["2026-10-12|S"].lessons.length, 3);
  // Archived on a Monday: that week is the current week and is kept.
  assert("archive: archived on the Monday keeps that week",
    purgeWeeklyAfterArchive(wtt, "bon", "2026-10-12")["2026-10-12|S"] === wtt["2026-10-12|S"], true);
}

// ── Commit 6: Melbourne stamps + editable end date (utils/enrolmentEndDate) ─
export function runEndDateEditTests(assert) {
  const today = "2026-10-04";
  assert("end date: empty is rejected", validateEndDateEdit("", "2026-01-27", today), "Enter an end date.");
  assert("end date: before the start date is rejected",
    validateEndDateEdit("2026-01-26", "2026-01-27", today), "End date can't be before the start date.");
  assert("end date: after today is rejected",
    validateEndDateEdit("2026-10-05", "2026-01-27", today), "End date can't be in the future.");
  assert("end date: start date, today and a date between are accepted",
    [validateEndDateEdit("2026-01-27", "2026-01-27", today), validateEndDateEdit(today, "2026-01-27", today),
     validateEndDateEdit("2026-09-18", "2026-01-27", today)], [null, null, null]);
  assert("end date: missing start date only checks empty and future",
    validateEndDateEdit("2001-01-01", undefined, today), null);

  // Editable only when the SAVED row is already ended.
  const saved = [drums, piano];
  assert("end date: editable for an enrolment ended before the form opened", isEndDateEditable(drums, saved), true);
  assert("end date: not editable for one ended in this form session (not yet saved)",
    isEndDateEditable({ ...piano, endDate: today }, saved), false);
  assert("end date: not editable for a running enrolment", isEndDateEditable(piano, saved), false);

  // The edit changes endDate and nothing else.
  const form = [{ ...drums }, { ...piano }];
  const edited = applyEndDateEdit(form, "e_bon_drm", "2026-09-18");
  assert("end date: edit changes only that enrolment's endDate",
    [edited[0], edited[1]], [{ ...drums, endDate: "2026-09-18" }, piano]);
  assert("end date: edit leaves the form list unmutated", form[0].endDate, "2026-10-03");

  // No cascade: saving an end-date edit newly ends nothing, so
  // onEndEnrolment (which clears lessons, misses and master cards) never runs.
  assert("end date: saving an end-date edit fires no End-enrolment cascade",
    newlyEndedEnrolments(edited, saved), []);
  // A real End in the same save still cascades, with its own date.
  const endedNow = applyEndDateEdit(edited, "e_bon_pno", today);
  assert("end date: a genuine End in the same save still cascades on its own",
    newlyEndedEnrolments(endedNow, saved), [{ id: "e_bon_pno", endDate: today }]);

  // D8: End/Add stamp the Melbourne date helper (a YYYY-MM-DD string).
  assert("end date: melbourneToday is a YYYY-MM-DD date", /^\d{4}-\d{2}-\d{2}$/.test(melbourneToday()), true);
}
