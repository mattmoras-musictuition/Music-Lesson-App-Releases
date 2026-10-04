// ============================================================
// archiveCascade.js — weekly-timetable cleanup when a student is archived.
// Pure function, no side effects, no state.
//
// v2.44.0 — archiving used to strip the student's lessons from EVERY weekly
// entry, including weeks already taught and invoiced, which erased their
// Tally history. That contradicts the v2.34.0 rule the End-enrolment cascade
// already follows: never destroy taught or invoiced weeks.
//
// Now only weeks whose Monday is strictly AFTER the archive date are cleared,
// of both lessons and misses — the same week-key comparison onEndEnrolment
// uses. The week containing the archive date and every earlier week are left
// exactly as they were (same object references).
//
// Matching is unchanged from the old archive path: by top-level studentId.
// Band sessions carry no top-level studentId, so band entries, their
// memberStates and their ledger (removedLessons) are untouched, as before.
// ============================================================

export function purgeWeeklyAfterArchive(weeklyTimetables, studentId, archiveDate) {
  const prev = weeklyTimetables || {};
  const next = { ...prev };
  for (const key of Object.keys(next)) {
    const entry = next[key];
    if (!entry) continue;
    const weekKey = key.split("|")[0]; // monday of that week
    if (archiveDate && !(weekKey > archiveDate)) continue;
    next[key] = {
      ...entry,
      lessons: (entry.lessons || []).filter(l => l.studentId !== studentId),
      missed:  (entry.missed  || []).filter(m => m.studentId !== studentId),
    };
  }
  return next;
}
