// ============================================================
// studentRemovalCascade.js — card clean-up for Delete student and End
// enrolment. Pure functions, no side effects, no state.
//
// The End-enrolment clean-up was moved out of App.js (onEndEnrolment)
// unchanged so it can be tested; each function takes the setter's latest
// value and returns the next one, exactly as the inline code did.
// ============================================================

import { archiveStudentCascade } from "./archiveCascade";

// ── Delete student ─────────────────────────────────────────────────────────
// Delete permanently used to strip every card whose top-level studentId was
// the child, from the master and from EVERY week. A group card's studentId is
// its first-listed member, so deleting that child wiped the group's lesson
// from every past week and the other children lost their history.
//
// Owner rules (11 Oct):
//   - the archive cascade runs first (archiveStudentCascade, as Archive runs
//     it), so group records, master and future weeks are tidied for a child
//     archived on the old path; the child's id then comes off any group
//     record that still lists it;
//   - a group card is never removed for the child. Where the child is the
//     card's studentId, it is re-pointed to the next member on the card who
//     still exists, in every week and on the master; nothing else on the card
//     changes, so past weeks keep the child's name as history;
//   - a group card with no other existing member goes, as a solo card would;
//   - the child's solo cards and solo missed entries go from every week;
//   - band sessions and their ledgers are returned as the same objects.

// One card (or missed entry) after the delete: the same object when it is not
// affected, null when it goes, otherwise the card with a new studentId.
function deleteCard(l, studentId, exists, groups) {
  if (!l || l.isBandSession) return l;
  if (!l.isGroup) return l.studentId === studentId ? null : l;
  if (l.studentId !== studentId) return l;
  const record = (groups || []).find(g => g && g.id === l.groupId);
  const members = Array.isArray(l.studentIds) ? l.studentIds : ((record && record.studentIds) || []);
  const next = members.find(sid => sid !== studentId && exists(sid));
  return next ? { ...l, studentId: next } : null;
}

// The list with every card run through deleteCard; the same array when
// nothing changed.
function deleteList(list, studentId, exists, groups) {
  let changed = false;
  const out = [];
  for (const x of list || []) {
    const y = deleteCard(x, studentId, exists, groups);
    if (y !== x) changed = true;
    if (y) out.push(y);
  }
  return changed ? out : list;
}

/**
 * Delete cascade for one student. Takes the same inputs as
 * archiveStudentCascade (archiveDate = today) and, like it, returns only the
 * collections it was given, so a caller can run it inside each state setter.
 * `students` and `groups` are the lists before the delete.
 */
export function deleteStudentCascade(p) {
  const { studentId, students, groups } = p;
  const a = archiveStudentCascade(p);
  const exists = (sid) => sid !== studentId && (students || []).some(s => s && s.id === sid);

  const groupsOut = a.groups === undefined ? undefined : a.groups.map(g => (
    (g.studentIds || []).includes(studentId) ? { ...g, studentIds: g.studentIds.filter(id => id !== studentId) } : g
  ));
  const lessons = a.lessons === undefined ? undefined : deleteList(a.lessons, studentId, exists, groups);
  const unscheduled = a.unscheduled === undefined ? undefined
    : a.unscheduled.filter(u => u.student?.id !== studentId);

  let weeklyTimetables;
  if (a.weeklyTimetables !== undefined) {
    weeklyTimetables = { ...a.weeklyTimetables };
    for (const key of Object.keys(weeklyTimetables)) {
      const entry = weeklyTimetables[key];
      if (!entry) continue;
      const l2 = deleteList(entry.lessons || [], studentId, exists, groups);
      const m2 = deleteList(entry.missed || [], studentId, exists, groups);
      if (l2 === (entry.lessons || []) && m2 === (entry.missed || [])) continue;
      weeklyTimetables[key] = { ...entry, lessons: l2, missed: m2 };
    }
  }

  return { groups: groupsOut, lessons, unscheduled, weeklyTimetables, deletedGroupIds: a.deletedGroupIds };
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
