// ============================================================
// studentRemovalCascade.js — card clean-up for Delete student and End
// enrolment. Pure functions, no side effects, no state.
//
// Moved out of App.js (onDeleteStudent / onEndEnrolment) unchanged so the
// two clean-ups can be tested. Each function takes the setter's latest value
// and returns the next one, exactly as the inline code did.
// ============================================================

// ── Delete student (as shipped up to v2.49.18) ─────────────────────────────
// Master: every card whose top-level studentId is the child, and their
// unscheduled entries.
export function deleteStudentMaster(prev, studentId) {
  return {
    ...prev,
    lessons: (prev.lessons || []).filter(l => l.studentId !== studentId),
    unscheduled: (prev.unscheduled || []).filter(u => u.student?.id !== studentId),
  };
}

// Weekly: every week, past included, lessons only (missed entries are left).
export function deleteStudentWeekly(prev, studentId) {
  const next = { ...prev };
  for (const key of Object.keys(next)) {
    const entry = next[key];
    if (!entry) continue;
    next[key] = { ...entry, lessons: (entry.lessons || []).filter(l => l.studentId !== studentId) };
  }
  return next;
}

// ── End enrolment ──────────────────────────────────────────────────────────
// Clear MTT + WTT cards stamped with this enrolmentId. Per Spec §17,
// post-migration cards carry enrolmentId; the five WTT creation sites
// deferred to Commit 4 may still produce enrolmentId:undefined cards,
// which this filter won't clear — expected until Commit 4 stamps them.
//
// The MASTER timetable is forward-looking by nature — it is the
// template, not a record of what was taught — so ending an enrolment
// still clears its master card outright.
export function endEnrolmentMaster(prev, enrolmentId) {
  return {
    ...prev,
    lessons: (prev.lessons || []).filter(l => l.enrolmentId !== enrolmentId),
    unscheduled: (prev.unscheduled || []).filter(u => u.enrolmentId !== enrolmentId),
  };
}

// v2.34.0 — the WEEKLY purge is now bounded. It used to strip
// matching lessons and missed entries from EVERY week, including
// weeks already taught and already invoiced, destroying tally marks
// as a side effect of ending an enrolment. Only weeks that start
// strictly after the end date are cleared.
//
// The boundary week — the week CONTAINING the end date — is KEPT in
// full. This code operates at week granularity (entries carry a day
// NAME, not a date, so a part-week purge is not expressible here),
// and keeping it is both the safe direction and the one that agrees
// with the tally: deriveTallyCell dashes a week only when
// `week.weekKey > enrolment.endDate`, so the boundary week still
// renders as active there. Clearing it would leave an active-looking
// week blank for lessons that were genuinely taught.
//
// The storage key's leading segment IS the Monday, and both sides are
// YYYY-MM-DD, so a plain string compare is the date compare.
export function endEnrolmentWeekly(prev, enrolmentId, endDate) {
  const next = { ...prev };
  for (const key of Object.keys(next)) {
    const entry = next[key];
    if (!entry) continue;
    const weekKey = key.split("|")[0]; // monday of that week
    // No end date supplied → fall back to the old clear-everything
    // behaviour rather than silently skipping the cascade.
    if (endDate && !(weekKey > endDate)) continue;
    next[key] = {
      ...entry,
      lessons: (entry.lessons || []).filter(l => l.enrolmentId !== enrolmentId),
      missed:  (entry.missed  || []).filter(m => m.enrolmentId !== enrolmentId),
    };
  }
  return next;
}
