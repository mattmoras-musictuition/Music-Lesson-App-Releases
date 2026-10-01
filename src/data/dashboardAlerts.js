// ============================================================
// dashboardAlerts.js — what the Dashboard alerts banner shows, and how its
// two badges count it. Pure: no React, no I/O, no clock reads (today and the
// current Monday are passed in), so smoke tests can pin it.
//
// v2.41.1: the panel's chip derivations moved verbatim out of Dashboard.js,
// and ONE ordered chip list (buildAlertChips) now drives the banner, the
// sidebar badge, the Alerts-button badge and "Dismiss all". Before this the
// two badges and Dismiss-all were three hand-kept lists that had drifted
// apart (sidebar 6 / button 7 / 8 chips on the owner's screen). Both badges
// are now simply the number of visible chips. The "lesson changes" and
// "invoices received" chips were removed in v2.41.1 (owner decision); those
// emails stay in the Emails panel and teacher invoices on the Teachers page.
// ============================================================

import { instrumentsFromEnrolments } from "../utils/enrolmentsDB";
import { getMissedEntries, getInformedAbsencesForWeek } from "../utils/tallyDerive";
import { computeTermWeekNum } from "../utils/tallyHelpers";
import { toLocalDateStr } from "../utils/helpers";
import { unattributedAlertDismissKey } from "./bandSessionView";

/**
 * Every data set the alerts banner renders chips from.
 *
 * @param {Object} i  Dashboard inputs: students, groups, enrolments, timetable,
 *   archivedStudentIds, studentHasUnplacedEnrolment, todayStr, monday (Date),
 *   inboxEmails, emailNoReplyOverrides (Set), emailSummaries, sentLoaded,
 *   sentEmails, interruptions, weeklyTimetables, offerableTodayEntries,
 *   sortedReminders, seenTeacherNoteIds, staffUploadedDocs, seenStaffDocIds,
 *   teacherEmailAlerts, seenTeacherEmailAlertIds.
 */
export function deriveAlertData(i) {
  const {
    students, groups, enrolments, timetable, archivedStudentIds, studentHasUnplacedEnrolment,
    todayStr, monday, inboxEmails, emailNoReplyOverrides, emailSummaries, sentLoaded, sentEmails,
    interruptions, weeklyTimetables, offerableTodayEntries, sortedReminders,
    seenTeacherNoteIds, staffUploadedDocs, seenStaffDocIds,
    teacherEmailAlerts, seenTeacherEmailAlertIds,
  } = i;
  // Alerts data
  const unassignedStudents = students.filter(s => s.status === "active" && studentHasUnplacedEnrolment(s));
  // Unassigned group students — active/pending/trial students with a group instrument not yet placed in any group
  const assignedGroupStudentIds = new Set((groups || []).flatMap(g => (g.studentIds || [])));
  const unassignedGroupStudents = students.filter(s => ["active", "pending", "trial"].includes(s.status) && instrumentsFromEnrolments(s.id, enrolments).some(i => i.isGroup) && !assignedGroupStudentIds.has(s.id));
  const unassignedGroupCount = unassignedGroupStudents.length;
  const unschedEntries = timetable ? timetable.unscheduled.filter(u => u.reason !== "Unassigned" && !archivedStudentIds.has(u.student?.id)) : [];
  // Incomplete student profiles — missing school, class, or parent contact
  const incompleteStudents = students.filter(s => {
    if (s.status !== "active" && s.status !== "pending") return false;
    const isPrivate = s.schoolId === "__private__";
    const hasParent = (s.parents || []).some(p => (p.email || "").trim() || (p.phone || "").trim());
    if (isPrivate) return !hasParent; // private students only need a parent contact
    const hasSchool = !!s.schoolId;
    const rawClass = (s.className || "").trim().toLowerCase();
    const hasClass = !!rawClass && !/^class\s*(times?|info|information|schedule|details?)?$/i.test(rawClass);
    return !hasSchool || !hasClass || !hasParent;
  });
  // Response required — tiered by age: red (2+ days), yellow (1 day), blue (today)
  const emailAgeMs = (e) => e.internalDate || (e.date ? new Date(e.date).getTime() : 0);
  const startOfToday = new Date(todayStr + "T00:00:00").getTime();
  const startOfYesterday = startOfToday - 86400000;
  const allResponseRequired = inboxEmails.filter(e => {
    if (emailNoReplyOverrides.has(e.id)) return false;
    const cacheKey = `${e.threadId || e.id}-${e.id}`;
    const cached = emailSummaries[cacheKey];
    if (!(typeof cached === "object" ? !!cached?.needsReply : false)) return false;
    // Exclude emails already replied to
    const msgs = e.threadMessages || [];
    if (msgs.some(m => m.isSent)) return false;
    // Replied-status unknown until the first sent fetch lands — suppress
    if (!sentLoaded) return false;
    const tid = e.threadId || e.id;
    const normSubject = (e.subject || "").replace(/^(re|fwd?):\s*/gi, "").trim().toLowerCase();
    if (sentEmails.some(s => {
      if (s.threadId && s.threadId === e.threadId) return true;
      if (normSubject) { const sNorm = (s.subject || "").replace(/^(re|fwd?):\s*/gi, "").trim().toLowerCase(); if (sNorm === normSubject) return true; }
      return (s.threadId || s.id) === tid;
    })) return false;
    return true;
  });
  const responseRequiredRed = allResponseRequired.filter(e => emailAgeMs(e) < startOfYesterday);
  const responseRequiredYellow = allResponseRequired.filter(e => emailAgeMs(e) >= startOfYesterday && emailAgeMs(e) < startOfToday);
  const responseRequiredBlue = allResponseRequired.filter(e => emailAgeMs(e) >= startOfToday);
  const pendingOnly = students.filter(s => s.status === "pending").reduce((sum, s) => sum + Math.max(1, instrumentsFromEnrolments(s.id, enrolments).filter(i => !i.isGroup).length), 0);
  const trialOnly = students.filter(s => s.status === "trial").reduce((sum, s) => sum + Math.max(1, instrumentsFromEnrolments(s.id, enrolments).filter(i => !i.isGroup).length), 0);
  // Interruptions: today through next 14 days
  const alertIntrEnd = toLocalDateStr((() => { const d = new Date(monday); d.setDate(d.getDate() + 14); return d; })());
  const upcomingInterruptions = interruptions.filter(i => i.type !== "term_break" && i.date >= todayStr && i.date <= alertIntrEnd);
  // Missed lessons: split this week (red) vs prior weeks (coral)
  const currentWeekKey = toLocalDateStr(monday);
  const nextWeekKey = toLocalDateStr((() => { const d = new Date(monday); d.setDate(d.getDate() + 7); return d; })());
  const missedThisWeek = (() => {
    const byStudent = {};
    for (const e of getMissedEntries({ weeklyTimetables, weekKey: currentWeekKey })) {
      const k = `${e.studentId}|${e.instrument}`;
      if (!byStudent[k]) byStudent[k] = { studentId: e.studentId, studentName: e.studentName, instrument: e.instrument, schoolId: e.schoolId || "", count: 0 };
      byStudent[k].count++;
    }
    return Object.values(byStudent);
  })();
  const missedPriorSorted = (() => {
    // v2.39.0 — the shared offerable list (utils/catchupScope.js) for
    // today's week, all schools; same set as the sidebar badge.
    const byKey = {};
    for (const e of offerableTodayEntries) {
      const k = `${e.studentId}|${e.instrument}`;
      if (!byKey[k]) {
        const st = students.find(s => s.id === e.studentId);
        byKey[k] = { studentId: e.studentId, studentName: e.studentName, instrument: e.instrument, schoolId: st?.schoolId || e.schoolId || "", count: 0 };
      }
      byKey[k].count++;
    }
    return Object.values(byKey).sort((a, b) => b.count - a.count);
  })();
  // Catch-ups: total lessons owed, tooltip grouped by student name
  const catchupTotal = missedPriorSorted.reduce((sum, m) => sum + m.count, 0);
  const catchupByStudent = {};
  for (const m of missedPriorSorted) {
    catchupByStudent[m.studentName] = (catchupByStudent[m.studentName] || 0) + m.count;
  }
  const catchupTooltipLines = Object.entries(catchupByStudent)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} — ${count} owed`);
  // Upcoming absences: informed_absence entries for NEXT week (alert fires the week before)
  const upcomingAbsences = (() => {
    // weekLabel is absent on WTT.missed; the || nextWeekKey fallback always resolves
    // to nextWeekKey post-migration (audit-acknowledged degradation).
    const byStudent = {};
    for (const e of getInformedAbsencesForWeek({ weeklyTimetables, weekKey: nextWeekKey })) {
      const k = `${e.studentId || e.studentName}|${e.instrument}`;
      if (!byStudent[k]) byStudent[k] = { studentId: e.studentId, studentName: e.studentName, instrument: e.instrument, weekLabel: e.weekLabel || nextWeekKey, count: 0 };
      byStudent[k].count++;
    }
    return Object.values(byStudent);
  })();
  // Reminder alerts — reminders whose event week fires an alert the week before
  const termBreaksForAlerts = interruptions.filter(i => i.type === "term_break").sort((a,b) => a.date.localeCompare(b.date));
  const currentTermWeekNum = computeTermWeekNum(currentWeekKey, termBreaksForAlerts);
  const upcomingReminderAlerts = currentTermWeekNum
    ? sortedReminders.filter(r => r.week && parseInt(r.week) - 1 === currentTermWeekNum)
    : [];
  // Teacher notes alert
  const newTeacherNotes = students.flatMap(s =>
    (s.teacher_notes || []).map(n => ({ ...n, studentId: s.id, studentName: s.name }))
  ).filter(n => !seenTeacherNoteIds.has(n.id));
  const hasNewTeacherNotes = newTeacherNotes.length > 0;
  // Staff document uploads
  const newStaffDocs = staffUploadedDocs.filter(d => !seenStaffDocIds.has(d.id));
  const hasNewStaffDocs = newStaffDocs.length > 0;
  // Classroom/specialist teacher email alerts
  const newTeacherEmailAlerts = Object.values(teacherEmailAlerts)
    .filter(a => a.type !== "other" && a.summary && !seenTeacherEmailAlertIds.has(a.emailId));
  const hasTeacherEmailAlerts = newTeacherEmailAlerts.length > 0;

  return {
    unassignedStudents, unassignedGroupStudents, unassignedGroupCount, unschedEntries, incompleteStudents,
    responseRequiredRed, responseRequiredYellow, responseRequiredBlue, pendingOnly, trialOnly,
    upcomingInterruptions, currentWeekKey, nextWeekKey, missedThisWeek, missedPriorSorted, catchupTotal,
    catchupTooltipLines, upcomingAbsences, upcomingReminderAlerts,
    newTeacherNotes, hasNewTeacherNotes, newStaffDocs, hasNewStaffDocs,
    newTeacherEmailAlerts, hasTeacherEmailAlerts,
  };
}

/**
 * The interruption chips' grouping, from the interruptions not yet dismissed:
 * public holidays (one chip, or one grouped chip), curriculum days (one
 * grouped chip across schools) and the rest per school (one chip, or one
 * grouped chip per school).
 *
 * @param {Array} visible  upcomingInterruptions minus per-id dismissals.
 */
export function groupInterruptions(visible) {
  // Curriculum-day discriminator covers both new entries
  // (type "curriculum_day", per INTERRUPTION_SUBTYPES) and
  // legacy free-text-title entries.
  const isCurriculumDay = (i) => i.type !== "public_holiday" && (
    i.type === "curriculum_day" ||
    i.title?.trim().toLowerCase() === "curriculum day"
  );
  const curriculumDays = visible.filter(isCurriculumDay);
  const remaining = visible.filter(i => !isCurriculumDay(i));
  const publicHols = remaining.filter(i => i.type === "public_holiday");
  const schoolEvents = remaining.filter(i => i.type !== "public_holiday");
  // Group school events by schoolId
  const bySchool = {};
  schoolEvents.forEach(i => {
    const key = i.schoolId || "unknown";
    if (!bySchool[key]) bySchool[key] = [];
    bySchool[key].push(i);
  });
  return { publicHols, curriculumDays, bySchool };
}

const intrKeys = (intrs) => intrs.map(i => `alert-interruption-${i.id}`);

/**
 * THE alerts banner chip list, in render order. Every surface derives from
 * it: the banner shows a chip when its entry is visible, both badges are the
 * number of visible entries, and "Dismiss all" dismisses every visible entry
 * through that chip's own mechanism.
 *
 * Each entry: { key, visible, dismissKeys, seen } —
 *   dismissKeys  alertDismissals keys the chip's X / Dismiss-all write;
 *   seen         { set, ids } for "new X" chips, which are hidden by marking
 *                ids seen instead (set ∈ teacherNotes | staffDocs |
 *                teacherEmailAlerts).
 * Interruptions contribute one entry per chip actually rendered.
 *
 * @param {Object} d    deriveAlertData output.
 * @param {Object} ctx  { isAlertDismissed, unassignedCount, unschedCount,
 *   uninvoicedRows, unattributedBands }
 * @returns {Array}
 */
export function buildAlertChips(d, ctx) {
  const { isAlertDismissed, unassignedCount, unschedCount, uninvoicedRows, unattributedBands } = ctx;
  const on = (key) => !isAlertDismissed(key);
  const simple = (key, alertKey, condition) => ({ key, visible: !!condition && on(alertKey), dismissKeys: [alertKey], seen: null });
  const responseVisible = (list) => list.filter(em => !isAlertDismissed(`alert-response-email-${em.id}`)).length > 0;
  const seenChip = (key, set, ids) => ({ key, visible: ids.length > 0, dismissKeys: [], seen: { set, ids } });

  const chips = [
    simple("unassigned", "alert-unassigned", unassignedCount > 0),
    simple("ungrouped", "alert-unassigned-groups", d.unassignedGroupCount > 0),
    simple("unscheduled", "alert-unscheduled", unschedCount > 0),
    simple("incomplete", "alert-incomplete", d.incompleteStudents.length > 0),
    simple("uninvoiced", "alert-uninvoiced", (uninvoicedRows || []).length > 0),
    simple("response-red", "alert-response-red", responseVisible(d.responseRequiredRed)),
    simple("missed-week", "alert-missed-week", d.missedThisWeek.length > 0),
    simple("upcoming-absences", "alert-upcoming-absences", d.upcomingAbsences.length > 0),
    simple("reminder-upcoming", "alert-reminder-upcoming", d.upcomingReminderAlerts.length > 0),
    simple("response-yellow", "alert-response-yellow", responseVisible(d.responseRequiredYellow)),
    simple("catchup", "alert-catchup", d.catchupTotal > 0),
  ];
  const bandIds = (unattributedBands || []).map(b => b.bandLessonId);
  chips.push({ key: "band-attributions", visible: bandIds.length > 0, dismissKeys: bandIds.length ? [unattributedAlertDismissKey(bandIds)] : [], seen: null });

  const g = groupInterruptions(d.upcomingInterruptions.filter(i => !isAlertDismissed(`alert-interruption-${i.id}`)));
  if (g.publicHols.length > 0) chips.push({ key: "intr-public-holidays", visible: true, dismissKeys: intrKeys(g.publicHols), seen: null });
  if (g.curriculumDays.length > 0) chips.push({ key: "intr-curriculum-days", visible: true, dismissKeys: intrKeys(g.curriculumDays), seen: null });
  for (const [schoolId, intrs] of Object.entries(g.bySchool)) {
    chips.push({ key: `intr-school-${schoolId}`, visible: true, dismissKeys: intrKeys(intrs), seen: null });
  }

  chips.push(
    simple("response-blue", "alert-response-blue", responseVisible(d.responseRequiredBlue)),
    simple("pending", "alert-pending", d.pendingOnly > 0),
    simple("trial", "alert-trial", d.trialOnly > 0),
    seenChip("teacher-notes", "teacherNotes", d.newTeacherNotes.map(n => n.id)),
    seenChip("staff-docs", "staffDocs", d.newStaffDocs.map(doc => doc.id)),
    seenChip("teacher-email-alerts", "teacherEmailAlerts", d.newTeacherEmailAlerts.map(a => a.emailId)),
  );
  return chips;
}

/**
 * The number both badges show: visible chips.
 */
export function visibleChipCount(chips) {
  return (chips || []).filter(c => c.visible).length;
}

/**
 * What "Dismiss all" writes: every visible chip, each through its own
 * mechanism — alertDismissals keys, plus seen-set ids per set.
 *
 * @returns {{keys: Object, seen: Object<string, string[]>}}
 */
export function dismissAllPlan(chips) {
  const keys = {};
  const seen = {};
  for (const c of (chips || [])) {
    if (!c.visible) continue;
    for (const k of c.dismissKeys) keys[k] = true;
    if (c.seen && c.seen.ids.length) seen[c.seen.set] = [...(seen[c.seen.set] || []), ...c.seen.ids];
  }
  return { keys, seen };
}
