// ============================================================
// dashboardAlerts.js — what the Dashboard alerts banner shows, and how its
// two badges count it. Pure: no React, no I/O, no clock reads (today and the
// current Monday are passed in), so smoke tests can pin it.
//
// v2.41.1 commit 1: moved VERBATIM out of Dashboard.js — the panel's chip
// derivations, its Alerts-button count, the sidebar badge count and the
// "Dismiss all" key list — with no behaviour change. (The two counts and
// Dismiss-all were three separately maintained lists that had drifted apart;
// the next commit replaces them with one chip list.)
// ============================================================

import { instrumentsFromEnrolments } from "../utils/enrolmentsDB";
import { getMissedEntries, getInformedAbsencesForWeek } from "../utils/tallyDerive";
import { computeTermWeekNum } from "../utils/tallyHelpers";
import { toLocalDateStr, studentMatchesParentEmail } from "../utils/helpers";

/**
 * Every data set the alerts banner renders chips from.
 *
 * @param {Object} i  Dashboard inputs: students, groups, enrolments, timetable,
 *   archivedStudentIds, studentHasUnplacedEnrolment, todayStr, monday (Date),
 *   inboxEmails, emailNoReplyOverrides (Set), emailSummaries, sentLoaded,
 *   sentEmails, interruptions, weeklyTimetables, offerableTodayEntries,
 *   sortedReminders, seenTeacherNoteIds, staffUploadedDocs, seenStaffDocIds,
 *   submittedInvoices, seenInvoiceIds, teacherEmailAlerts,
 *   seenTeacherEmailAlertIds.
 */
export function deriveAlertData(i) {
  const {
    students, groups, enrolments, timetable, archivedStudentIds, studentHasUnplacedEnrolment,
    todayStr, monday, inboxEmails, emailNoReplyOverrides, emailSummaries, sentLoaded, sentEmails,
    interruptions, weeklyTimetables, offerableTodayEntries, sortedReminders,
    seenTeacherNoteIds, staffUploadedDocs, seenStaffDocIds, submittedInvoices, seenInvoiceIds,
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
  // Lesson-change emails: inbox emails from known parents that mention schedule/time keywords
  const lessonChangeKeywords = ["reschedul", "change", "swap", "move", "different time", "different day", "can't make", "cannot make", "won't be", "will not be", "away", "absent", "cancel", "conflict", "clash"];
  const lessonChangeEmails = inboxEmails.filter(e => {
    const addr = (e.from?.match(/<(.+)>/)?.[1] || e.from || "").toLowerCase();
    const isParent = students.some(s => studentMatchesParentEmail(s, addr));
    if (!isParent) return false;
    const text = ((e.subject || "") + " " + (e.snippet || "") + " " + (e.body || "")).toLowerCase();
    return lessonChangeKeywords.some(kw => text.includes(kw));
  });
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
  // Invoice alerts — submitted invoices not yet seen
  const newInvoices = submittedInvoices.filter(inv => !seenInvoiceIds.has(inv.id));
  const hasNewInvoices = newInvoices.length > 0;
  // Classroom/specialist teacher email alerts
  const newTeacherEmailAlerts = Object.values(teacherEmailAlerts)
    .filter(a => a.type !== "other" && a.summary && !seenTeacherEmailAlertIds.has(a.emailId));
  const hasTeacherEmailAlerts = newTeacherEmailAlerts.length > 0;

  return {
    unassignedStudents, unassignedGroupStudents, unassignedGroupCount, unschedEntries, incompleteStudents,
    responseRequiredRed, responseRequiredYellow, responseRequiredBlue, pendingOnly, trialOnly,
    upcomingInterruptions, currentWeekKey, nextWeekKey, missedThisWeek, missedPriorSorted, catchupTotal,
    catchupTooltipLines, lessonChangeEmails, upcomingAbsences, upcomingReminderAlerts,
    newTeacherNotes, hasNewTeacherNotes, newStaffDocs, hasNewStaffDocs, newInvoices, hasNewInvoices,
    newTeacherEmailAlerts, hasTeacherEmailAlerts,
  };
}

/**
 * The Alerts button's count, as the panel computed it (one per chip type,
 * not the chips' numbers).
 *
 * @param {Object} d    deriveAlertData output.
 * @param {Object} ctx  { isAlertDismissed, unassignedCount, unschedCount,
 *   unattributedBands, pendingDismissed, trialDismissed, isLessonChangeDismissed }
 */
export function panelAlertCounts(d, ctx) {
  const { isAlertDismissed, unassignedCount, unschedCount, unattributedBands, pendingDismissed, trialDismissed, isLessonChangeDismissed } = ctx;
  const { incompleteStudents, missedThisWeek, responseRequiredRed, responseRequiredYellow, responseRequiredBlue,
    upcomingInterruptions, catchupTotal, pendingOnly, trialOnly, lessonChangeEmails, upcomingAbsences,
    unassignedGroupCount, upcomingReminderAlerts, hasNewTeacherNotes, hasNewStaffDocs, hasNewInvoices, hasTeacherEmailAlerts } = d;
  const warningCount = (unassignedCount > 0 && !isAlertDismissed("alert-unassigned") ? 1 : 0) + (unschedCount > 0 && !isAlertDismissed("alert-unscheduled") ? 1 : 0) + (incompleteStudents.length > 0 && !isAlertDismissed("alert-incomplete") ? 1 : 0) + (missedThisWeek.length > 0 && !isAlertDismissed("alert-missed-week") ? 1 : 0) + (responseRequiredRed.length > 0 && !isAlertDismissed("alert-response-red") ? 1 : 0);
  const totalAlerts = warningCount
    + (responseRequiredYellow.length > 0 && !isAlertDismissed("alert-response-yellow") ? 1 : 0)
    + (responseRequiredBlue.length > 0 && !isAlertDismissed("alert-response-blue") ? 1 : 0)
    + (upcomingInterruptions.filter(i => !isAlertDismissed(`alert-interruption-${i.id}`)).length > 0 ? 1 : 0)
    + (catchupTotal > 0 && !isAlertDismissed("alert-catchup") ? 1 : 0)
    + (unattributedBands.length > 0 ? 1 : 0)
    + (pendingOnly > 0 && !pendingDismissed ? 1 : 0)
    + (trialOnly > 0 && !trialDismissed ? 1 : 0)
    + (lessonChangeEmails.filter(em => !isLessonChangeDismissed(em.id)).length > 0 && !isAlertDismissed("alert-lesson-change") ? 1 : 0)
    + (upcomingAbsences.length > 0 && !isAlertDismissed("alert-upcoming-absences") ? 1 : 0)
    + (unassignedGroupCount > 0 && !isAlertDismissed("alert-unassigned-groups") ? 1 : 0)
    + (upcomingReminderAlerts.length > 0 && !isAlertDismissed("alert-reminder-upcoming") ? 1 : 0);
  const totalAlertsWithTeacherNotes = totalAlerts + (hasNewTeacherNotes ? 1 : 0) + (hasNewStaffDocs ? 1 : 0) + (hasNewInvoices ? 1 : 0) + (hasTeacherEmailAlerts ? 1 : 0);
  return { warningCount, totalAlerts, totalAlertsWithTeacherNotes };
}

/**
 * The sidebar Dashboard badge, as its own memo computed it.
 *
 * @param {Object} i  { alertDismissals, todayStr, monday (Date), students,
 *   enrolments, weeklyTimetables, offerableTodayEntries, inboxEmails,
 *   emailNoReplyOverrides, emailSummaries, sentLoaded, sentEmails,
 *   interruptions, isLessonChangeDismissed, unattributedBands, groups,
 *   unassignedCount, unschedCount }
 */
export function sidebarAlertCountFrom(i) {
  const { alertDismissals, todayStr: todayStr2, monday: mon, students, enrolments, weeklyTimetables,
    offerableTodayEntries, inboxEmails, emailNoReplyOverrides, emailSummaries, sentLoaded, sentEmails,
    interruptions, isLessonChangeDismissed, unattributedBands, groups, unassignedCount, unschedCount } = i;
  const dismissed = (key) => !!alertDismissals?.dismissed?.[key];
  const currentWeekKey = toLocalDateStr(mon);
  const nextWeekKey = toLocalDateStr((() => { const d = new Date(mon); d.setDate(d.getDate() + 7); return d; })());
  const alertIntrEnd = toLocalDateStr((() => { const d = new Date(mon); d.setDate(d.getDate() + 14); return d; })());
  const startOfToday = new Date(todayStr2 + "T00:00:00").getTime();
  const startOfYesterday = startOfToday - 86400000;
  const emailAgeMs2 = (e) => e.internalDate || (e.date ? new Date(e.date).getTime() : 0);

  const incompleteCount = students.filter(s =>
    s.status === "active" && (!s.schoolId || !s.className || !(s.parents || []).some(p => p.email || p.phone))
  ).length;

  const missedThisWeekCount = new Set(
    getMissedEntries({ weeklyTimetables, weekKey: currentWeekKey })
      .map(e => `${e.studentId}|${e.instrument}`)
  ).size;

  // Same shared offerable list as the alerts-panel chip (v2.39.0).
  const catchupTotal = offerableTodayEntries.length;

  const allRR = inboxEmails.filter(e => {
    if (emailNoReplyOverrides.has(e.id)) return false;
    const cached = emailSummaries[`${e.threadId || e.id}-${e.id}`];
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
  const rrRed = allRR.filter(e => emailAgeMs2(e) < startOfYesterday);
  const rrYellow = allRR.filter(e => emailAgeMs2(e) >= startOfYesterday && emailAgeMs2(e) < startOfToday);
  const rrBlue = allRR.filter(e => emailAgeMs2(e) >= startOfToday);

  const pendingOnly = students.filter(s => s.status === "pending").reduce((s, st) => s + Math.max(1, instrumentsFromEnrolments(st.id, enrolments).filter(i => !i.isGroup).length), 0);
  const trialOnly = students.filter(s => s.status === "trial").reduce((s, st) => s + Math.max(1, instrumentsFromEnrolments(st.id, enrolments).filter(i => !i.isGroup).length), 0);

  const upcomingInterruptions = interruptions.filter(i => i.type !== "term_break" && i.date >= todayStr2 && i.date <= alertIntrEnd);

  const lcKeywords = ["reschedul","change","swap","move","different time","different day","can't make","cannot make","won't be","will not be","away","absent","cancel","conflict","clash"];
  const lcEmails = inboxEmails.filter(e => {
    const addr = (e.from?.match(/<(.+)>/)?.[1] || e.from || "").toLowerCase();
    if (!students.some(s => studentMatchesParentEmail(s, addr))) return false;
    const text = ((e.subject || "") + " " + (e.snippet || "") + " " + (e.body || "")).toLowerCase();
    return lcKeywords.some(kw => text.includes(kw));
  });

  const upcomingAbsences = new Set(
    getInformedAbsencesForWeek({ weeklyTimetables, weekKey: nextWeekKey })
      .map(e => `${e.studentId || e.studentName}|${e.instrument}`)
  ).size;

  let count = 0;
  if (unassignedCount > 0 && !dismissed("alert-unassigned")) count++;
  if (unschedCount > 0 && !dismissed("alert-unscheduled")) count++;
  if (incompleteCount > 0 && !dismissed("alert-incomplete")) count++;
  if (missedThisWeekCount > 0 && !dismissed("alert-missed-week")) count++;
  if (rrRed.length > 0 && !dismissed("alert-response-red")) count++;
  if (rrYellow.length > 0 && !dismissed("alert-response-yellow")) count++;
  if (rrBlue.length > 0 && !dismissed("alert-response-blue")) count++;
  if (upcomingInterruptions.filter(i => !dismissed(`alert-interruption-${i.id}`)).length > 0) count++;
  if (catchupTotal > 0 && !dismissed("alert-catchup")) count++;
  if (pendingOnly > 0 && !dismissed("alert-pending")) count++;
  if (trialOnly > 0 && !dismissed("alert-trial")) count++;
  if (lcEmails.filter(em => !isLessonChangeDismissed(em.id)).length > 0 && !dismissed("alert-lesson-change")) count++;
  if (upcomingAbsences > 0 && !dismissed("alert-upcoming-absences")) count++;
  if (unattributedBands.length > 0) count++;   // dismissal already applied
  const assignedGroupIds = new Set((groups || []).flatMap(g => (g.studentIds || [])));
  const ungroupedCount = students.filter(s => ["active", "pending", "trial"].includes(s.status) && instrumentsFromEnrolments(s.id, enrolments).some(i => i.isGroup) && !assignedGroupIds.has(s.id)).length;
  if (ungroupedCount > 0 && !dismissed("alert-unassigned-groups")) count++;
  return count;
}

/**
 * What the panel's "Dismiss all" writes, as it decided it.
 *
 * @param {Object} d    deriveAlertData output.
 * @param {Object} ctx  { unassignedCount, unschedCount, uninvoicedRows, isLessonChangeDismissed }
 * @returns {{keys: Object, lessonChangeIds: string[], teacherNoteIds: string[],
 *   staffDocIds: string[], teacherEmailAlertIds: string[], invoiceIds: string[]}}
 */
export function dismissAllPlan(d, ctx) {
  const { unassignedCount, unschedCount, uninvoicedRows, isLessonChangeDismissed } = ctx;
  const keys = {};
  if (unassignedCount > 0) keys["alert-unassigned"] = true;
  if (unschedCount > 0) keys["alert-unscheduled"] = true;
  if (d.incompleteStudents.length > 0) keys["alert-incomplete"] = true;
  if (d.missedThisWeek.length > 0) keys["alert-missed-week"] = true;
  if (d.responseRequiredRed.length > 0) keys["alert-response-red"] = true;
  if (d.responseRequiredYellow.length > 0) keys["alert-response-yellow"] = true;
  if (d.responseRequiredBlue.length > 0) keys["alert-response-blue"] = true;
  d.upcomingInterruptions.forEach(intr => { keys[`alert-interruption-${intr.id}`] = true; });
  if (d.catchupTotal > 0) keys["alert-catchup"] = true;
  if (d.pendingOnly > 0) keys["alert-pending"] = true;
  if (d.trialOnly > 0) keys["alert-trial"] = true;
  if (d.lessonChangeEmails.length > 0) keys["alert-lesson-change"] = true;
  if (d.upcomingAbsences.length > 0) keys["alert-upcoming-absences"] = true;
  if (d.unassignedGroupCount > 0) keys["alert-unassigned-groups"] = true;
  if (d.upcomingReminderAlerts.length > 0) keys["alert-reminder-upcoming"] = true;
  // v2.18.0 — uninvoiced-students chip: alertDismissals hide ONLY.
  // Deliberately does NOT write the per-student permanent dismissal
  // set — a money warning must not be bulk-silenced.
  if ((uninvoicedRows || []).length > 0) keys["alert-uninvoiced"] = true;
  return {
    keys,
    lessonChangeIds: d.lessonChangeEmails.filter(em => !isLessonChangeDismissed(em.id)).map(em => em.id),
    teacherNoteIds: d.newTeacherNotes.map(n => n.id),
    staffDocIds: d.newStaffDocs.map(doc => doc.id),
    teacherEmailAlertIds: d.newTeacherEmailAlerts.map(a => a.emailId),
    invoiceIds: d.newInvoices.map(inv => inv.id),
  };
}
