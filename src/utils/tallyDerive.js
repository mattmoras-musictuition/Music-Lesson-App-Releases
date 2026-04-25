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
// ============================================================

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
