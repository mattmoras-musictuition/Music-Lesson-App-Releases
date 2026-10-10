// ============================================================
// tallyFiltersSmokeTests.js — v2.49.10 shared Tally cell rules
// (utils/tallyFilters): summary box counts, box filter rows, Summary
// column, Not Yet Marked past weeks only.
// ============================================================

import { TALLY_PILLS, classifyTallyCell, cellMatchesPill, rowMatchesPill, computeTallyStats, rowSummaryCounts } from "../utils/tallyFilters";
import { buildBankingIndex, isCaughtUpCell, isScheduledCatchupCell } from "./catchupsDerive";
import { deriveTallyRows } from "../utils/tallyDerive";
import { isPastWeek } from "../utils/helpers";

const A = "2026-09-28";  // past
const B = "2026-10-05";  // past
const C = "2026-10-12";  // current
const D = "2026-10-19";  // future
const H = "2026-12-21";  // holiday
const WEEKS = [
  { weekKey: A, weekNum: 1, label: "W1" },
  { weekKey: B, weekNum: 2, label: "W2" },
  { weekKey: C, weekNum: 3, label: "W3" },
  { weekKey: D, weekNum: 4, label: "W4" },
  { weekKey: H, weekNum: 1, label: "H1", isHoliday: true },
];
const isPast = (wk) => wk < C;
const NOW = new Date("2026-10-14T12:00:00");

const cell = (lessonKey, enrolmentId, weekKey, status, extra = {}) =>
  ({ lessonKey, enrolmentId, weekKey, status, makeupEligible: false, madeUp: false, ...extra });

// R1 solo: completed, caught up (blue tick), scheduled (blue dot), future blank, holiday absent.
// R2 solo: absent, past blank, current blank, inactive.
// R3 group: unscheduled (orange dot), marked made up (navy arrow), completed, future blank.
const R1 = { lessonKey: "s1|Piano", enrolmentId: "e1", schoolId: "X" };
const R2 = { lessonKey: "s2|Drums", enrolmentId: "e2", schoolId: "Y" };
const R3 = { lessonKey: "group|g1", enrolmentId: "e3", schoolId: "X", isGroup: true, groupId: "g1" };
const ROWS = [R1, R2, R3];
const ENTRY_MAP = {};
const put = (e) => { ENTRY_MAP[`${e.lessonKey}|${e.weekKey}`] = e; };
put(cell(R1.lessonKey, "e1", A, "completed"));
put(cell(R1.lessonKey, "e1", B, "missed", { makeupEligible: true }));
put(cell(R1.lessonKey, "e1", C, "missed", { makeupEligible: true }));
put(cell(R1.lessonKey, "e1", H, "missed"));
put(cell(R2.lessonKey, "e2", A, "missed"));
put(cell(R2.lessonKey, "e2", D, "removed"));
put(cell(R3.lessonKey, "e3", A, "missed", { makeupEligible: true }));
put(cell(R3.lessonKey, "e3", B, "missed", { makeupEligible: true, madeUp: true }));
put(cell(R3.lessonKey, "e3", C, "completed"));

const CATCHUPS = [
  // R1 week B — booked for Mon 5 Oct, already happened at NOW → caught up.
  { id: "c1", resolvesEnrolmentId: "e1", resolvesWeekKey: B, weekKey: B, day: "Monday", createdAt: "2026-10-01" },
  // R1 week C — booked for Mon 19 Oct, not yet happened at NOW → scheduled.
  { id: "c2", resolvesEnrolmentId: "e1", resolvesWeekKey: C, weekKey: D, day: "Monday", createdAt: "2026-10-01" },
];
const BI = buildBankingIndex(CATCHUPS);
const OPTS = { bankingIndex: BI, now: NOW, isPast };

// The pre-v2.49.10 inline maths from TallyView, kept here as the parity reference.
function oldStats(rows, entryMap, termWeeks, bankingIndex, now) {
  const termWeekKeys = new Set(termWeeks.filter(w => !w.isHoliday).map(w => w.weekKey));
  const lessonKeySet = new Set(rows.map(r => r.lessonKey));
  const visibleEntries = Object.values(entryMap).filter(e => lessonKeySet.has(e.lessonKey) && termWeekKeys.has(e.weekKey));
  const removed = visibleEntries.filter(e => e.status === "removed").length;
  const termWeekCount = termWeeks.filter(w => !w.isHoliday).length;
  const totalCells = rows.length * termWeekCount - removed;
  const completed = visibleEntries.filter(e => e.status === "completed").length;
  const missed = visibleEntries.filter(e => e.status === "missed").length;
  const unscheduledMakeups = visibleEntries.filter(e => e.status === "missed" && e.makeupEligible && !e.madeUp && !isCaughtUpCell(e, bankingIndex, now) && !isScheduledCatchupCell(e, bankingIndex, now)).length;
  const makeupScheduled = visibleEntries.filter(e => e.status === "missed" && e.makeupEligible && !e.madeUp && isScheduledCatchupCell(e, bankingIndex, now)).length;
  const madeUp = visibleEntries.filter(e => e.madeUp || isCaughtUpCell(e, bankingIndex, now)).length;
  return { completed, missed, unscheduledMakeups, makeupScheduled, madeUp,
    absent: missed - unscheduledMakeups - makeupScheduled - madeUp, unmarked: totalCells - completed - missed };
}

// Runs fn with `new Date()` / Date.now() fixed at iso (restored afterwards).
function withClock(iso, fn) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
    static now() { return fixed; }
  }
  // The app runs these tests in the browser (window); the node harness has a
  // stub window without Date, so fall back to node's global there.
  const root = (typeof window !== "undefined" && typeof window.Date === "function") ? window : global;
  root.Date = FixedDate;
  try { return fn(); } finally { root.Date = RealDate; }
}

const at = (lessonKey, wk) => ENTRY_MAP[`${lessonKey}|${wk}`] || null;
const week = (wk) => WEEKS.find(w => w.weekKey === wk);
const matching = (pill) => ROWS.filter(r => rowMatchesPill(r, ENTRY_MAP, WEEKS, pill, OPTS)).map(r => r.lessonKey);

export function runTallyFilterTests(assert) {
  // ── Cell level: each state ──
  assert("tallyFilters: cell states R1",
    [A, B, C, D, H].map(wk => classifyTallyCell(at(R1.lessonKey, wk), OPTS)),
    ["completed", "madeUp", "scheduled", "blank", "absent"]);
  assert("tallyFilters: cell states R2",
    [A, B, C, D].map(wk => classifyTallyCell(at(R2.lessonKey, wk), OPTS)),
    ["absent", "blank", "blank", "inactive"]);
  assert("tallyFilters: cell states R3 (group)",
    [A, B, C, D].map(wk => classifyTallyCell(at(R3.lessonKey, wk), OPTS)),
    ["unscheduled", "madeUp", "completed", "blank"]);
  assert("tallyFilters: cell matches Absent", cellMatchesPill(at(R2.lessonKey, A), week(A), TALLY_PILLS.ABSENT, OPTS), true);
  assert("tallyFilters: cell matches Unscheduled", cellMatchesPill(at(R3.lessonKey, A), week(A), TALLY_PILLS.UNSCHEDULED, OPTS), true);
  assert("tallyFilters: cell matches Scheduled", cellMatchesPill(at(R1.lessonKey, C), week(C), TALLY_PILLS.SCHEDULED, OPTS), true);
  assert("tallyFilters: Made Up matches the caught-up blue tick", cellMatchesPill(at(R1.lessonKey, B), week(B), TALLY_PILLS.MADE_UP, OPTS), true);
  assert("tallyFilters: Made Up matches the marked navy arrow", cellMatchesPill(at(R3.lessonKey, B), week(B), TALLY_PILLS.MADE_UP, OPTS), true);
  assert("tallyFilters: a scheduled cell is not Unscheduled or Made Up",
    [TALLY_PILLS.UNSCHEDULED, TALLY_PILLS.MADE_UP].map(p => cellMatchesPill(at(R1.lessonKey, C), week(C), p, OPTS)), [false, false]);

  // ── Not Yet Marked: past weeks only ──
  assert("tallyFilters: Not Yet Marked — past blank counts", cellMatchesPill(null, week(B), TALLY_PILLS.NOT_MARKED, OPTS), true);
  assert("tallyFilters: Not Yet Marked — current week blank does not", cellMatchesPill(null, week(C), TALLY_PILLS.NOT_MARKED, OPTS), false);
  assert("tallyFilters: Not Yet Marked — future week blank does not", cellMatchesPill(null, week(D), TALLY_PILLS.NOT_MARKED, OPTS), false);
  assert("tallyFilters: Not Yet Marked — inactive past cell does not",
    cellMatchesPill(cell("x", "ex", A, "removed"), week(A), TALLY_PILLS.NOT_MARKED, OPTS), false);
  assert("tallyFilters: Not Yet Marked — recorded past cell does not",
    cellMatchesPill(at(R1.lessonKey, A), week(A), TALLY_PILLS.NOT_MARKED, OPTS), false);

  // 6pm Friday rollover — the real isPastWeek (no injected predicate).
  // Fri 9 Oct 2026, Melbourne (AEDT, UTC+11): 17:59 = 06:59Z, 18:00 = 07:00Z.
  const noIsPast = { bankingIndex: BI, now: NOW };
  assert("tallyFilters: Fri 17:59 — this week is not yet past",
    withClock("2026-10-09T06:59:00Z", () => [isPastWeek(B), cellMatchesPill(null, week(B), TALLY_PILLS.NOT_MARKED, noIsPast)]), [false, false]);
  assert("tallyFilters: Fri 18:00 — this week becomes past",
    withClock("2026-10-09T07:00:00Z", () => [isPastWeek(B), cellMatchesPill(null, week(B), TALLY_PILLS.NOT_MARKED, noIsPast)]), [true, true]);
  assert("tallyFilters: midweek — last week past, this and next week not",
    withClock("2026-10-07T01:00:00Z", () => [A, B, C].map(isPastWeek)), [true, false, false]);

  // ── Holiday weeks ignored ──
  assert("tallyFilters: holiday cell never matches a box", cellMatchesPill(at(R1.lessonKey, H), week(H), TALLY_PILLS.ABSENT, OPTS), false);
  assert("tallyFilters: holiday blank never Not Yet Marked", cellMatchesPill(null, week(H), TALLY_PILLS.NOT_MARKED, { ...OPTS, isPast: () => true }), false);

  // ── Row level (a group row included) ──
  assert("tallyFilters: rows — Absent", matching(TALLY_PILLS.ABSENT), [R2.lessonKey]);
  assert("tallyFilters: rows — Unscheduled (group row)", matching(TALLY_PILLS.UNSCHEDULED), [R3.lessonKey]);
  assert("tallyFilters: rows — Scheduled", matching(TALLY_PILLS.SCHEDULED), [R1.lessonKey]);
  assert("tallyFilters: rows — Made Up (both kinds)", matching(TALLY_PILLS.MADE_UP), [R1.lessonKey, R3.lessonKey]);
  assert("tallyFilters: rows — Not Yet Marked", matching(TALLY_PILLS.NOT_MARKED), [R2.lessonKey]);

  // ── The four missed boxes partition every missed cell exactly once ──
  const missedPills = [TALLY_PILLS.ABSENT, TALLY_PILLS.UNSCHEDULED, TALLY_PILLS.SCHEDULED, TALLY_PILLS.MADE_UP];
  const missedCells = Object.values(ENTRY_MAP).filter(e => e.status === "missed" && !week(e.weekKey).isHoliday);
  assert("tallyFilters: every missed cell matches exactly one missed box",
    missedCells.map(e => missedPills.filter(p => cellMatchesPill(e, week(e.weekKey), p, OPTS)).length), missedCells.map(() => 1));

  // ── Stats ──
  const stats = computeTallyStats(ROWS, ENTRY_MAP, WEEKS, OPTS);
  assert("tallyFilters: stats", stats,
    { completed: 2, missed: 5, absent: 1, unscheduledMakeups: 1, makeupScheduled: 1, madeUp: 2, unmarked: 1 });
  const old = oldStats(ROWS, ENTRY_MAP, WEEKS, BI, NOW);
  assert("tallyFilters: parity — Completed and the missed boxes match the old maths",
    [stats.completed, stats.missed, stats.absent, stats.unscheduledMakeups, stats.makeupScheduled, stats.madeUp],
    [old.completed, old.missed, old.absent, old.unscheduledMakeups, old.makeupScheduled, old.madeUp]);
  assert("tallyFilters: Not Yet Marked drops current and future blanks (old 4 → new 1)", [old.unmarked, stats.unmarked], [4, 1]);

  // ── School filter combines with the box rules (real deriveTallyRows) ──
  const wk = A;
  const students = [
    { id: "sx", name: "Xavier", schoolId: "X", status: "active" },
    { id: "sy", name: "Yasmin", schoolId: "Y", status: "active" },
  ];
  const enrolments = [
    { id: "ex", studentId: "sx", instrument: "Piano", startDate: "2026-01-01" },
    { id: "ey", studentId: "sy", instrument: "Piano", startDate: "2026-01-01" },
  ];
  const timetable = { lessons: [
    { id: "mx", enrolmentId: "ex", studentId: "sx", instrument: "Piano", schoolId: "X", day: "Monday" },
    { id: "my", enrolmentId: "ey", studentId: "sy", instrument: "Piano", schoolId: "Y", day: "Monday" },
  ] };
  const miss = (id, sid, eid, school) => ({ id, enrolmentId: eid, studentId: sid, instrument: "Piano", schoolId: school, day: "Monday", makeupEligible: true, madeUp: false });
  const weeklyTimetables = {
    [`${wk}|X`]: { lessons: [], missed: [miss("x1", "sx", "ex", "X")] },
    [`${wk}|Y`]: { lessons: [], missed: [miss("y1", "sy", "ey", "Y")] },
  };
  const termWeeks = [{ weekKey: wk, weekNum: 1, label: "W1" }];
  const derive = (schoolFilter) => deriveTallyRows({ enrolments, students, termWeeks, weeklyTimetables, timetable, schoolFilter });
  const counts = ["all", "X", "Y"].map(f => { const d = derive(f); return computeTallyStats(d.tallyRows, d.entryMap, termWeeks, OPTS).unscheduledMakeups; });
  assert("tallyFilters: Unscheduled count follows the school buttons", counts, [2, 1, 1]);
  const dx = derive("X");
  assert("tallyFilters: school X + Unscheduled shows only school X's row",
    dx.tallyRows.filter(r => rowMatchesPill(r, dx.entryMap, termWeeks, TALLY_PILLS.UNSCHEDULED, OPTS)).map(r => r.lessonKey), ["sx|Piano"]);

  // ── Summary column ──
  const rowEntries = (r) => WEEKS.map(w => ENTRY_MAP[`${r.lessonKey}|${w.weekKey}`] || null);
  assert("tallyFilters: Summary R1 — caught up counts as made up, scheduled counts in neither",
    rowSummaryCounts(rowEntries(R1).slice(0, 4), OPTS), { completed: 1, absent: 0, owed: 0, madeUp: 1 });
  assert("tallyFilters: Summary R3 — owed and marked made up",
    rowSummaryCounts(rowEntries(R3), OPTS), { completed: 1, absent: 0, owed: 1, madeUp: 1 });
  assert("tallyFilters: Summary R2 — absent only",
    rowSummaryCounts(rowEntries(R2), OPTS), { completed: 0, absent: 1, owed: 0, madeUp: 0 });
}
