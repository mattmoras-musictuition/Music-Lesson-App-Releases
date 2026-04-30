// ============================================================
// tallyDerive.js
// Derives tally row data from WTT + enrolment date ranges.
// Pure functions, no side effects, no state.
// Replaces tallyEntries persistence as of Commit 5.
//
// IMPORTANT — TRANSITIONAL SHIM (added in Commit 5a):
// This module returns BOTH the canonical { tallyRows } shape AND an
// entryMap shim with today's tally-entry-shaped objects synthesized
// from WTT data. The shim lets existing TallyView render code
// (CellIcon, tooltips, stats, makeups filter, holiday-rendering
// branches) continue working unmodified through 5a–5c. Future
// cleanup post-Commit-5 should migrate render consumers to read
// tallyRows[].cells[].wttEntry directly and drop the entryMap shim.
//
// Implicit __catchup__ skip: schoolId for storage-key construction
// comes from the MTT card or student record; never resolves to
// "__catchup__" (a synthetic key for the catch-up subsystem
// deferred to Spec 3).
//
// Commit 6c.1 added 8 read-side helpers consumed by App.js,
// WeeklyAdjustments.js, and Dashboard.js (migrated in 6c.2–6c.4).
// All helpers are pure functions of weeklyTimetables (the WTT map
// keyed by "<weekKey>|<schoolId>"). None mutate.
// ============================================================

import { getTermWeekLabel } from "./helpers";

// Internal predicate — single source of "open catch-up" semantics.
// Mirrors the audit's banked follow-up #1 (single-source predicate)
// for the helpers added in 6c.1. Consumers that today inline the
// same check can converge on this through their helper of choice.
function isOpenCatchup(m) {
  return !!m && !!m.makeupEligible && !m.madeUp;
}

// Derive a single cell's state for a given enrolment + week + WTT entry.
// Returns one of: "inactive", "blank", "completed", "missed-makeup-owed",
// "missed-caught-up", "missed-no-catchup".
export function deriveTallyCell({ enrolment, week, wttEntry, today }) {
  if (!enrolment) return "blank";
  if (enrolment.startDate && week.weekKey < enrolment.startDate) return "inactive";
  if (enrolment.endDate && week.weekKey > enrolment.endDate) return "inactive";

  const weekStart = new Date(week.weekKey + "T00:00:00");
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 5); // through end-of-Friday
  const weekHasPassed = today >= weekEnd;

  if (!wttEntry) return "blank";

  if (wttEntry.kind === "lesson") {
    return weekHasPassed ? "completed" : "blank";
  }

  // wttEntry.kind === "missed"
  if (wttEntry.makeupEligible && wttEntry.madeUp) return "missed-caught-up";
  if (wttEntry.makeupEligible && !wttEntry.madeUp) return "missed-makeup-owed";
  return "missed-no-catchup";
}

// Synthesize a tally-entry-shaped object from a WTT entry + cell state,
// to feed today's TallyView render code unmodified (the entryMap shim).
// Returns null when the cell should render as blank (no shim entry needed).
function buildShimEntry({ wttEntry, state, weekKey, weekLabel, weekNum, weekIsHoliday, lessonKey }) {
  // Inactive stub for cells outside enrolment range.
  // Renders as the grey "—" dash via CellIcon's status === "removed" branch.
  if (state === "inactive") {
    return {
      lessonKey,
      weekKey, weekLabel, weekNum,
      status: "removed",
      reason: "inactive",
      reasonDetail: "",
      notes: "",
      makeupEligible: false,
      madeUp: false,
      isHolidayCatchup: false,
      bandSession: false,
      autoRecorded: false,
    };
  }

  if (!wttEntry) return null;

  const isLesson = wttEntry.kind === "lesson";
  const isMissed = wttEntry.kind === "missed";

  // Lesson cells render as "completed" only when state confirms (week has passed).
  // For pre-passed weeks the lesson exists but renders blank → no shim entry.
  if (isLesson && state !== "completed") return null;

  return {
    // Identity
    id: wttEntry.id,
    lessonKey,
    lessonId: wttEntry.id,

    // Subject
    studentId: wttEntry.studentId || "",
    studentName: wttEntry.studentName || "",
    studentNames: wttEntry.studentNames || [],
    instrument: wttEntry.instrument || "",
    schoolId: wttEntry.schoolId || "",
    teacherId: wttEntry.teacherId || "",
    teacherName: wttEntry.teacherName || "",
    isGroup: !!wttEntry.isGroup,
    groupId: wttEntry.groupId,
    groupName: wttEntry.groupName,

    // Temporal
    weekKey, weekLabel, weekNum,
    day: wttEntry.day || "",

    // Status
    status: isLesson ? "completed" : "missed",
    reason: isMissed ? (wttEntry.reason || null) : null,
    reasonDetail: isMissed ? (wttEntry.reasonDetail || "") : "",
    notes: wttEntry.notes || "",
    makeupEligible: isMissed ? !!wttEntry.makeupEligible : false,
    madeUp: isMissed ? !!wttEntry.madeUp : false,

    // Holiday compat (preserves legacy isHolidayCatchup filter at TallyView:851)
    isHolidayCatchup: isLesson && !!wttEntry.isMakeup && weekIsHoliday,
    bandSession: !!wttEntry.isBandSession,

    // Legacy / not stored in WTT
    madeUpWeekKey: undefined, // not reconstructible from WTT post-5.7 — tooltip suffix drops the week label
    cardNote: wttEntry.cardNote || "",
    recordedAt: wttEntry.recordedAt,
    autoRecorded: false,
  };
}

// Build all tally rows for the current term + a synthesized entryMap shim.
// Inclusion rules:
// - Skip private students (handled by Spec 7) and pending/trial students.
// - Active students appear if they have an MTT card OR at least one WTT
//   entry in any term week (handles dropped-mid-term enrolments where the
//   MTT card is removed forward but earlier weeks still have data).
// - Archived students appear if their enrolment date range overlaps the term.
// Returns { tallyRows, entryMap }.
export function deriveTallyRows({ enrolments, students, termWeeks, weeklyTimetables, timetable, schoolFilter }) {
  const today = new Date();
  const tallyRows = [];
  const entryMap = {};
  const seen = new Set();

  if (!termWeeks || termWeeks.length === 0) return { tallyRows, entryMap };

  const termStart = termWeeks[0].weekKey;
  const termEnd = termWeeks[termWeeks.length - 1].weekKey;

  for (const e of (enrolments || [])) {
    const lessonKey = e.isGroup ? `group|${e.groupId}` : `${e.studentId}|${e.instrument}`;
    if (seen.has(lessonKey)) continue;

    const student = students.find(s => s.id === e.studentId);
    if (!student) continue;

    // Skip private students — handled by Spec 7 (currently stubbed in TallyView).
    if (student.schoolId === "__private__") continue;

    // Skip pending and trial students — not real enrolments yet.
    if (student.status === "pending" || student.status === "trial") continue;

    if (schoolFilter && schoolFilter !== "all" && student.schoolId !== schoolFilter) continue;

    // Archived students: keep the enrolment-overlap filter as a fast exit
    // before walking cells. Active students defer the MTT-or-WTT-data decision
    // until after the cell loop (need to know if any WTT entry matched).
    if (student.status === "archived") {
      const enrolStart = e.startDate || "0000-00-00";
      const enrolEnd = e.endDate || "9999-99-99";
      if (enrolEnd < termStart) continue;
      if (enrolStart > termEnd) continue;
    }

    // Find MTT card for scheduling info (day, schoolId, teacherName, groupName, studentNames)
    const mttCard = (timetable?.lessons || []).find(l => l.enrolmentId === e.id);
    const schoolId = mttCard?.schoolId || student.schoolId;

    // Walk weeks: derive cell state and synthesize shim entry per cell.
    // Track whether any WTT entry matches this enrolment in any term week,
    // and stage shim entries locally so we don't pollute entryMap if we later
    // skip pushing this row.
    const cells = {};
    let hasWttData = false;
    const pendingShimEntries = [];
    for (const week of termWeeks) {
      const sk = `${week.weekKey}|${schoolId}`;
      const weekData = weeklyTimetables?.[sk] || { lessons: [], missed: [] };

      // Match by enrolmentId first (post-Commit-2/3/4a stamped); fall back to
      // lessonKey for legacy entries that pre-date enrolmentId stamping.
      const matchByEnrolment = (item) => item.enrolmentId === e.id;
      const matchByLessonKey = (item) => {
        const k = item.isGroup ? `group|${item.groupId}` : `${item.studentId}|${item.instrument}`;
        return k === lessonKey;
      };

      const lessonMatch = (weekData.lessons || []).find(matchByEnrolment)
        || (weekData.lessons || []).find(matchByLessonKey);
      const missedMatch = !lessonMatch
        ? ((weekData.missed || []).find(matchByEnrolment)
            || (weekData.missed || []).find(matchByLessonKey))
        : null;

      if (lessonMatch || missedMatch) hasWttData = true;

      let wttWithKind = null;
      if (lessonMatch) wttWithKind = { ...lessonMatch, kind: "lesson" };
      else if (missedMatch) wttWithKind = { ...missedMatch, kind: "missed" };

      const state = deriveTallyCell({ enrolment: e, week, wttEntry: wttWithKind, today });
      cells[week.weekKey] = { state, wttEntry: wttWithKind };

      const shimEntry = buildShimEntry({
        wttEntry: wttWithKind,
        state,
        weekKey: week.weekKey,
        weekLabel: week.label,
        weekNum: week.weekNum,
        weekIsHoliday: !!week.isHoliday,
        lessonKey,
      });
      if (shimEntry) {
        pendingShimEntries.push([`${lessonKey}|${week.weekKey}`, shimEntry]);
      }
    }

    // Unified inclusion check: need MTT card OR at least one WTT entry.
    // Active students may appear via either route. Archived students fall
    // through naturally because they don't carry MTT cards — so this also
    // tightens archived to require WTT activity, mirroring pre-5a's
    // "archived with tally data" behavior with WTT as the source.
    if (!mttCard && !hasWttData) continue;

    seen.add(lessonKey);
    for (const [k, v] of pendingShimEntries) entryMap[k] = v;

    // Row shape: spread MTT card if present (carries teacherName, groupName,
    // studentNames, id), else synthesize a minimal base from enrolment + student.
    const baseLesson = mttCard ? { ...mttCard } : {
      id: lessonKey,
      studentId: e.studentId,
      studentName: student.name,
      studentNames: [],
      groupId: e.groupId,
      isGroup: e.isGroup || false,
      instrument: e.instrument,
      schoolId,
      teacherId: e.teacherId,
      teacherName: "",
      day: "",
    };

    tallyRows.push({
      ...baseLesson,
      enrolmentId: e.id,
      lessonKey,
      cells,
      _archived: student.status === "archived",
    });
  }

  tallyRows.sort((a, b) => {
    const nameA = (a.isGroup ? (a.groupName || "") : (a.studentName || "")).toLowerCase();
    const nameB = (b.isGroup ? (b.groupName || "") : (b.studentName || "")).toLowerCase();
    return nameA.localeCompare(nameB);
  });

  return { tallyRows, entryMap };
}

// ============================================================
// 6c.1 helpers — pure read-side derives over weeklyTimetables.
// Consumers migrate in 6c.2 (WA), 6c.3 (Dashboard), 6c.4 (App.js).
// ============================================================

/**
 * Test whether weeklyTimetables contains a missed entry for the given
 * student in the given week. Solo-only — group support deferred until
 * a future call site surfaces the need.
 *
 * Extended in 6c.1b: `day` and `reasons` are both optional.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables - Full WTT keyed by "<weekKey>|<schoolId>".
 * @param {string} params.studentId - Required.
 * @param {string} params.weekKey - Required.
 * @param {string} [params.day] - Optional. If omitted, matches any day in the week.
 * @param {string[]} [params.reasons] - Optional allowlist on m.reason. If omitted,
 *   matches any reason (preserves the audit-drafted "any missed entry" semantics).
 * @returns {boolean}
 */
export function hasMissedEntry({ weeklyTimetables, studentId, weekKey, day, reasons }) {
  if (!weeklyTimetables) return false;
  for (const sk of Object.keys(weeklyTimetables)) {
    if (!sk.startsWith(weekKey + "|")) continue;
    const data = weeklyTimetables[sk];
    for (const m of (data?.missed || [])) {
      if (m.studentId !== studentId) continue;
      if (day !== undefined && m.day !== day) continue;
      if (reasons !== undefined && !reasons.includes(m.reason)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Return the flat array of missed entries for a single week's WTT slot.
 * Caller passes the slot directly (i.e. weeklyTimetables[storageKey]),
 * not the full WTT map. Caller groups / decorates as needed.
 *
 * @param {{missed?: Object[]}} weeklyData - One WTT slot.
 * @returns {Object[]}
 */
export function getMissedForWeek(weeklyData) {
  return weeklyData?.missed || [];
}

/**
 * Return a flat array of WTT.missed entries matching the given filters,
 * each decorated with the `weekKey` it came from at the top level alongside
 * the original missed-entry fields. Callers can read e.weekKey, e.studentId,
 * e.reason, etc. directly, or spread (...e) without losing the source week.
 *
 * All filters are optional except weeklyTimetables. Filters apply
 * conjunctively (AND across all provided filters):
 *   - weekKey:   if provided, restrict to that week; if omitted, all weeks.
 *   - studentId: positive match on m.studentId.
 *   - schoolId:  positive match on m.schoolId (the missed entry's schoolId,
 *                NOT the current student's — same semantics as findOpenCatchups,
 *                behavioural shift is theoretical only per audit).
 *   - reasons:   string[] allowlist on m.reason.
 *   - day:       positive match on m.day.
 *
 * Subsumes some single-week use cases of getMissedForWeek; the latter
 * remains for callers who already hold a slot reference and want zero
 * indirection. Does not bake in the open-catchup predicate — pair with
 * findOpenCatchups when makeup-eligibility filtering is wanted.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} [params.weekKey]
 * @param {string} [params.studentId]
 * @param {string} [params.schoolId]
 * @param {string[]} [params.reasons]
 * @param {string} [params.day]
 * @returns {Object[]} Each entry is the original missed object with weekKey
 *   added at the top level.
 */
export function getMissedEntries({ weeklyTimetables, weekKey, studentId, schoolId, reasons, day } = {}) {
  const out = [];
  if (!weeklyTimetables) return out;
  for (const sk of Object.keys(weeklyTimetables)) {
    const skWeekKey = sk.split("|")[0];
    if (weekKey !== undefined && skWeekKey !== weekKey) continue;
    const data = weeklyTimetables[sk];
    for (const m of (data?.missed || [])) {
      if (studentId !== undefined && m.studentId !== studentId) continue;
      if (schoolId !== undefined && m.schoolId !== schoolId) continue;
      if (reasons !== undefined && !reasons.includes(m.reason)) continue;
      if (day !== undefined && m.day !== day) continue;
      out.push({ ...m, weekKey: skWeekKey });
    }
  }
  return out;
}

/**
 * Find all open catch-ups (makeupEligible && !madeUp) across WTT.
 * Optional studentId / schoolId filters narrow by the missed entry's
 * own field — schoolId filter is on the missed entry, not the
 * current student record (audit decision: moved-student behavioural
 * shift is theoretical only because Matt's workflow archives and
 * recreates rather than editing).
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} [params.studentId]
 * @param {string} [params.schoolId]
 * @returns {{weekKey: string, missed: Object}[]}
 */
export function findOpenCatchups({ weeklyTimetables, studentId, schoolId } = {}) {
  const out = [];
  if (!weeklyTimetables) return out;
  for (const sk of Object.keys(weeklyTimetables)) {
    const weekKey = sk.split("|")[0];
    const data = weeklyTimetables[sk];
    for (const m of (data?.missed || [])) {
      if (!isOpenCatchup(m)) continue;
      if (studentId !== undefined && m.studentId !== studentId) continue;
      if (schoolId !== undefined && m.schoolId !== schoolId) continue;
      out.push({ weekKey, missed: m });
    }
  }
  return out;
}

/**
 * Count missed entries for a specific weekKey + day across all schools.
 * Used by App.js's rerunAutoTallyForDate manual-count notification.
 * WTT.missed entries are all user-initiated (no autoRecorded field
 * exists on WTT.missed), so this is a straight count.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} params.weekKey
 * @param {string} params.day
 * @returns {number}
 */
export function countMissedForDate({ weeklyTimetables, weekKey, day }) {
  if (!weeklyTimetables) return 0;
  let count = 0;
  for (const sk of Object.keys(weeklyTimetables)) {
    if (!sk.startsWith(weekKey + "|")) continue;
    const data = weeklyTimetables[sk];
    for (const m of (data?.missed || [])) {
      if (m.day === day) count++;
    }
  }
  return count;
}

/**
 * Group missed entries by studentId+instrument and return rows where
 * the student has 2+ missed entries with weekKey >= sinceWeekKey.
 *
 * NOTE: signature uses sinceWeekKey rather than sinceDate because
 * WTT.missed entries do not carry a recordedAt timestamp (they did
 * on legacy tallyEntries). Caller computes the cutoff weekKey from
 * its date window. Granularity drops from timestamp to week, which
 * is acceptable for a 14-day rolling window.
 *
 * Row shape mirrors Dashboard:247's existing tallyEntries grouping
 * minus schoolName (caller resolves schoolName from schools).
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} params.sinceWeekKey - Inclusive lower bound on weekKey.
 * @returns {{studentId: string, studentName: string, instrument: string, schoolId: string, count: number}[]}
 */
export function getMissedSince({ weeklyTimetables, sinceWeekKey }) {
  if (!weeklyTimetables) return [];
  const byKey = {};
  for (const sk of Object.keys(weeklyTimetables)) {
    const weekKey = sk.split("|")[0];
    if (weekKey < sinceWeekKey) continue;
    const data = weeklyTimetables[sk];
    for (const m of (data?.missed || [])) {
      const k = `${m.studentId || ""}|${m.instrument || ""}`;
      if (!byKey[k]) {
        byKey[k] = {
          studentId: m.studentId || "",
          studentName: m.studentName || "",
          instrument: m.instrument || "",
          schoolId: m.schoolId || "",
          count: 0,
        };
      }
      byKey[k].count++;
    }
  }
  return Object.values(byKey).filter(r => r.count >= 2);
}

/**
 * Return raw WTT.missed entries at the given weekKey whose reason is
 * "informed_absence". Caller groups, formats labels, and constructs
 * any Set / count it needs. Predicate mirrors Dashboard:1385 / 2671
 * (informed_absence only — extended_absence is not part of these
 * consumer filters today).
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} params.weekKey
 * @returns {Object[]}
 */
export function getInformedAbsencesForWeek({ weeklyTimetables, weekKey }) {
  const out = [];
  if (!weeklyTimetables) return out;
  for (const sk of Object.keys(weeklyTimetables)) {
    if (!sk.startsWith(weekKey + "|")) continue;
    const data = weeklyTimetables[sk];
    for (const m of (data?.missed || [])) {
      if (m.reason === "informed_absence") out.push(m);
    }
  }
  return out;
}

/**
 * All weekKeys present in weeklyTimetables that have any activity
 * (lessons OR missed entries), sorted ascending. Used by App.js's
 * buildClaudeSystemPrompt to enumerate term weeks for AI context.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @returns {string[]}
 */
export function getWttWeekKeysWithActivity({ weeklyTimetables }) {
  if (!weeklyTimetables) return [];
  const weeks = new Set();
  for (const sk of Object.keys(weeklyTimetables)) {
    const data = weeklyTimetables[sk];
    if ((data?.lessons?.length || 0) > 0 || (data?.missed?.length || 0) > 0) {
      weeks.add(sk.split("|")[0]);
    }
  }
  return [...weeks].sort();
}

/**
 * Per-week tally summary for the AI prompt. Returns:
 *   completed: aggregate count of WTT.lessons across all schools for
 *              this weekKey (lesson-event count — for groups/bands
 *              this counts the slot once, not per-student; this is
 *              a semantic shift from legacy tallyEntries which
 *              counted per-student).
 *   missed:    decorated rows from WTT.missed across all schools.
 *   label:     getTermWeekLabel(weekKey, termBreaks), falling back
 *              to weekKey if termBreaks does not resolve.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} params.weekKey
 * @param {Array}  params.schools
 * @param {Array}  params.termBreaks
 * @returns {{completed: number, missed: Object[], label: string}}
 */
export function getWeekTallySummary({ weeklyTimetables, weekKey, schools, termBreaks }) {
  let completed = 0;
  const missed = [];
  if (weeklyTimetables) {
    for (const sk of Object.keys(weeklyTimetables)) {
      if (!sk.startsWith(weekKey + "|")) continue;
      const data = weeklyTimetables[sk];
      completed += (data?.lessons?.length || 0);
      for (const m of (data?.missed || [])) {
        const schoolName = (schools || []).find(s => s.id === m.schoolId)?.name || "";
        missed.push({
          studentName: m.studentName || "",
          instrument: m.instrument || "",
          schoolId: m.schoolId || "",
          schoolName,
          day: m.day || "",
          makeupEligible: !!m.makeupEligible,
          madeUp: !!m.madeUp,
          reason: m.reason || "",
        });
      }
    }
  }
  let label = weekKey;
  try {
    const computed = getTermWeekLabel(weekKey, termBreaks);
    if (computed) label = computed;
  } catch {
    label = weekKey;
  }
  return { completed, missed, label };
}

// ============================================================
// 7.1.1 helpers — count-based invoicing math.
// Replaces InvoicingManager's legacy pair-matching deduction
// logic (madeUp/madeUpWeekKey/invoiced flags) with pure counts
// scoped by enrolment+instrument or by group. Consumers migrate
// in 7.1.2; handleCloseTermTally + Clear Tally drop in 7.1.3.
// ============================================================

// Internal — find the term_break immediately preceding nextTermStart.
// Returns { start, end } or null.
function _findPrevBreak(interruptions, nextTermStart) {
  const breaks = (interruptions || [])
    .filter(i => i.type === "term_break")
    .map(i => ({ start: i.date, end: i.endDate || i.date }))
    .sort((a, b) => a.start.localeCompare(b.start));
  return [...breaks].reverse().find(b => b.end < nextTermStart) || null;
}

/**
 * Count WTT.lessons surviving for the given enrolment+instrument whose
 * weekKey falls in [rangeStart, rangeEnd] inclusive. Each entry counts
 * as 1 — group lessons count once per slot, matching WTT storage.
 * Includes lessons with isMakeup: true. Defensively skips lessons with
 * isCancelled === true.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} params.enrolmentId
 * @param {string} params.instrument
 * @param {string} params.rangeStart - Inclusive lower bound on weekKey.
 * @param {string} params.rangeEnd - Inclusive upper bound on weekKey.
 * @returns {number}
 */
export function getEnrolmentLessonsHeldInRange({ weeklyTimetables, enrolmentId, instrument, rangeStart, rangeEnd }) {
  if (!weeklyTimetables) return 0;
  let count = 0;
  for (const sk of Object.keys(weeklyTimetables)) {
    const weekKey = sk.split("|")[0];
    if (weekKey < rangeStart || weekKey > rangeEnd) continue;
    const data = weeklyTimetables[sk];
    for (const l of (data?.lessons || [])) {
      if (l.enrolmentId !== enrolmentId) continue;
      if (l.instrument !== instrument) continue;
      if (l.isCancelled === true) continue;
      count++;
    }
  }
  return count;
}

/**
 * Return WTT.missed entries for the given enrolment+instrument whose
 * weekKey is in [rangeStart, rangeEnd] inclusive. When
 * makeupEligibleOnly is true, restrict to entries with makeupEligible
 * === true. Returns the raw entries — callers take .length for count
 * or render details directly.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} params.enrolmentId
 * @param {string} params.instrument
 * @param {string} params.rangeStart
 * @param {string} params.rangeEnd
 * @param {boolean} [params.makeupEligibleOnly] - Default false.
 * @returns {Object[]}
 */
export function getEnrolmentMissedInRange({ weeklyTimetables, enrolmentId, instrument, rangeStart, rangeEnd, makeupEligibleOnly = false }) {
  const out = [];
  if (!weeklyTimetables) return out;
  for (const sk of Object.keys(weeklyTimetables)) {
    const weekKey = sk.split("|")[0];
    if (weekKey < rangeStart || weekKey > rangeEnd) continue;
    const data = weeklyTimetables[sk];
    for (const m of (data?.missed || [])) {
      if (m.enrolmentId !== enrolmentId) continue;
      if (m.instrument !== instrument) continue;
      if (makeupEligibleOnly && !m.makeupEligible) continue;
      out.push(m);
    }
  }
  return out;
}

/**
 * Count of isMakeup === true lessons for the given enrolment+instrument
 * whose weekKey falls inside the term_break immediately preceding
 * nextTermStart. Holiday weeks belong to the previous term's reckoning
 * by convention. Filters explicitly by isMakeup === true. Defensively
 * skips isCancelled.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} params.enrolmentId
 * @param {string} params.instrument
 * @param {Array} params.interruptions
 * @param {string} params.nextTermStart - First day of the term whose deductions are being computed.
 * @returns {number}
 */
export function getEnrolmentHolidayCatchupsForTerm({ weeklyTimetables, enrolmentId, instrument, interruptions, nextTermStart }) {
  const prevBreak = _findPrevBreak(interruptions, nextTermStart);
  if (!prevBreak) return 0;
  return countCatchupsInRange({
    weeklyTimetables, enrolmentId, instrument,
    rangeStart: prevBreak.start, rangeEnd: prevBreak.end,
  });
}

/**
 * Count-based replacement for InvoicingManager's legacy
 * mkpEligPending / holidayStamped / remainingCatchups / covered /
 * deductions / extras block (sites at lines 381-393 and 465-477).
 * For an enrolment+instrument in the prev term:
 *   mkpEligPending = count of makeupEligible missed entries
 *   catchups       = in-term catchups + holiday-week catchups
 *   covered        = min(catchups, mkpEligPending)
 *   deductions     = pending - covered
 *   extras         = catchups - covered
 *
 * Pairing happens implicitly through the counts — no per-entry
 * matching required.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} params.enrolmentId
 * @param {string} params.instrument
 * @param {{start: string, end: string}} params.prevTerm
 * @param {Array} params.interruptions
 * @param {string} params.nextTermStart
 * @returns {{mkpEligPending: number, catchups: number, deductions: number, extras: number}}
 */
export function getEnrolmentTermDeductionMath({ weeklyTimetables, enrolmentId, instrument, prevTerm, interruptions, nextTermStart }) {
  const mkpEligPending = getEnrolmentMissedInRange({
    weeklyTimetables, enrolmentId, instrument,
    rangeStart: prevTerm.start, rangeEnd: prevTerm.end,
    makeupEligibleOnly: true,
  }).length;
  const inTermCatchups = countCatchupsInRange({
    weeklyTimetables, enrolmentId, instrument,
    rangeStart: prevTerm.start, rangeEnd: prevTerm.end,
  });
  const holidayCatchups = getEnrolmentHolidayCatchupsForTerm({
    weeklyTimetables, enrolmentId, instrument, interruptions, nextTermStart,
  });
  const catchups = inTermCatchups + holidayCatchups;
  const covered = Math.min(catchups, mkpEligPending);
  const deductions = mkpEligPending - covered;
  const extras = catchups - covered;
  return { mkpEligPending, catchups, deductions, extras };
}

/**
 * Count isMakeup === true lessons for the given enrolment+instrument
 * whose weekKey is in [rangeStart, rangeEnd] inclusive. Defensively
 * skips isCancelled === true. Used by getEnrolmentTermDeductionMath
 * for in-term catchups and as the inner walker for
 * getEnrolmentHolidayCatchupsForTerm.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} params.enrolmentId
 * @param {string} params.instrument
 * @param {string} params.rangeStart
 * @param {string} params.rangeEnd
 * @returns {number}
 */
export function countCatchupsInRange({ weeklyTimetables, enrolmentId, instrument, rangeStart, rangeEnd }) {
  if (!weeklyTimetables) return 0;
  let count = 0;
  for (const sk of Object.keys(weeklyTimetables)) {
    const weekKey = sk.split("|")[0];
    if (weekKey < rangeStart || weekKey > rangeEnd) continue;
    const data = weeklyTimetables[sk];
    for (const l of (data?.lessons || [])) {
      if (l.enrolmentId !== enrolmentId) continue;
      if (l.instrument !== instrument) continue;
      if (l.isMakeup !== true) continue;
      if (l.isCancelled === true) continue;
      count++;
    }
  }
  return count;
}

/**
 * For a group: weekKeys where the group session has a missed entry,
 * with weekKey in [rangeStart, rangeEnd] inclusive. Scope by
 * isGroup === true && groupId === <id> — NOT by lessonKey (WTT
 * entries don't carry lessonKey; that was tallyEntries-only).
 *
 * Returns Set<weekKey> — Set semantics are needed for deduping if
 * multiple missed entries land on the same weekKey for the same
 * group session. This is the documented exception to the
 * counts-only public API for these helpers.
 *
 * When makeupEligibleOnly is true, include only weeks where the
 * missed entry has makeupEligible === true.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} params.groupId
 * @param {string} params.rangeStart
 * @param {string} params.rangeEnd
 * @param {boolean} [params.makeupEligibleOnly] - Default false.
 * @returns {Set<string>}
 */
export function getGroupMissedWeeksInRange({ weeklyTimetables, groupId, rangeStart, rangeEnd, makeupEligibleOnly = false }) {
  const out = new Set();
  if (!weeklyTimetables) return out;
  for (const sk of Object.keys(weeklyTimetables)) {
    const weekKey = sk.split("|")[0];
    if (weekKey < rangeStart || weekKey > rangeEnd) continue;
    const data = weeklyTimetables[sk];
    for (const m of (data?.missed || [])) {
      if (m.isGroup !== true) continue;
      if (m.groupId !== groupId) continue;
      if (makeupEligibleOnly && !m.makeupEligible) continue;
      out.add(weekKey);
    }
  }
  return out;
}

// Internal — count of isMakeup === true group lessons for the given
// groupId whose weekKey is in [rangeStart, rangeEnd] inclusive.
// Defensively skips isCancelled === true. Sole consumer is
// getGroupTermDeductionMath; group-side analog of countCatchupsInRange.
function _countGroupCatchupsInRange(weeklyTimetables, groupId, rangeStart, rangeEnd) {
  if (!weeklyTimetables) return 0;
  let count = 0;
  for (const sk of Object.keys(weeklyTimetables)) {
    const weekKey = sk.split("|")[0];
    if (weekKey < rangeStart || weekKey > rangeEnd) continue;
    const data = weeklyTimetables[sk];
    for (const l of (data?.lessons || [])) {
      if (l.isGroup !== true) continue;
      if (l.groupId !== groupId) continue;
      if (l.isMakeup !== true) continue;
      if (l.isCancelled === true) continue;
      count++;
    }
  }
  return count;
}

/**
 * Group-path analog of getEnrolmentTermDeductionMath. Same return
 * shape (numbers, not Sets — the Set in getGroupMissedWeeksInRange
 * collapses to .size at this layer). Collapses InvoicingManager's
 * Sites E + F at lines 498-518 into a single helper call per group
 * per parent. Result applies identically to every member of the
 * group on their respective invoices.
 *
 * Site F's per-student madeUpWeeks subtraction does NOT survive —
 * empirically verified zero impact across full tallyEntries history
 * (no group rows ever had madeUp = true). Workflow clarification:
 * groups operate as units; if individuals are absent the group
 * lesson still goes ahead and they're billed.
 *
 * @param {Object} params
 * @param {Object} params.weeklyTimetables
 * @param {string} params.groupId
 * @param {{start: string, end: string}} params.prevTerm
 * @param {Array} params.interruptions
 * @param {string} params.nextTermStart
 * @returns {{missedCount: number, catchupCount: number, deductions: number, extras: number}}
 */
export function getGroupTermDeductionMath({ weeklyTimetables, groupId, prevTerm, interruptions, nextTermStart }) {
  const missedCount = getGroupMissedWeeksInRange({
    weeklyTimetables, groupId,
    rangeStart: prevTerm.start, rangeEnd: prevTerm.end,
    makeupEligibleOnly: true,
  }).size;
  const inTermCatchups = _countGroupCatchupsInRange(
    weeklyTimetables, groupId, prevTerm.start, prevTerm.end,
  );
  const prevBreak = _findPrevBreak(interruptions, nextTermStart);
  const holidayCatchups = prevBreak
    ? _countGroupCatchupsInRange(weeklyTimetables, groupId, prevBreak.start, prevBreak.end)
    : 0;
  const catchupCount = inTermCatchups + holidayCatchups;
  const covered = Math.min(catchupCount, missedCount);
  const deductions = missedCount - covered;
  const extras = catchupCount - covered;
  return { missedCount, catchupCount, deductions, extras };
}
