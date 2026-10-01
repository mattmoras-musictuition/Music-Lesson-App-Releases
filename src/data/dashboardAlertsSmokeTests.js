// ============================================================
// DASHBOARD ALERTS SMOKE TESTS
// v2.41.1. The fixture reproduces the owner's 1 Oct 2026 screen: eight chips
// visible — ungrouped, incomplete profiles, uninvoiced, response overdue,
// catch-ups owed, lesson changes, pending, invoices received. Dates sit in
// 2099 and today/Monday are passed in, so the real clock never matters.
// ============================================================

import { deriveAlertData, panelAlertCounts, sidebarAlertCountFrom, dismissAllPlan } from "./dashboardAlerts";

const TODAY = "2099-03-12";                       // a Thursday
const MONDAY = new Date(2099, 2, 9);              // local Monday of TODAY's week
const OLD = new Date(2099, 2, 1).getTime();       // > 2 days ago → "overdue"

const parent = (email) => [{ name: "P", email }];
const complete = (id, extra = {}) => ({ id, name: id, status: "active", schoolId: "S", className: "3A", parents: parent(`${id}@x.com`), ...extra });

export function ownerCase(overrides = {}) {
  const students = [
    complete("g1"), complete("g2"),                                        // ungrouped (group enrolment, no group)
    complete("inc1", { className: "" }), complete("inc2", { className: "" }), // incomplete profiles
    complete("pend", { status: "pending" }),                               // pending
    complete("par", { parents: parent("mum@x.com") }),                     // lesson-change sender's child
  ];
  const enrolments = [
    { id: "e_g1", studentId: "g1", instrument: "Choir", isGroup: true },
    { id: "e_g2", studentId: "g2", instrument: "Choir", isGroup: true },
    { id: "e_p", studentId: "pend", instrument: "Guitar" },
  ];
  const inboxEmails = [
    { id: "r1", threadId: "r1", from: "someone@y.com", subject: "Question", internalDate: OLD },        // needs reply, overdue
    { id: "lc1", threadId: "lc1", from: "Mum <mum@x.com>", subject: "Need to reschedule", internalDate: OLD },
  ];
  return {
    students, groups: [], enrolments, timetable: null, archivedStudentIds: new Set(),
    studentHasUnplacedEnrolment: () => false,
    todayStr: TODAY, monday: MONDAY, inboxEmails, emailNoReplyOverrides: new Set(),
    emailSummaries: { "r1-r1": { needsReply: true } }, sentLoaded: true, sentEmails: [],
    interruptions: [], weeklyTimetables: {}, sortedReminders: [],
    offerableTodayEntries: [{ studentId: "c1", studentName: "C", instrument: "Guitar" }],
    seenTeacherNoteIds: new Set(), staffUploadedDocs: [], seenStaffDocIds: new Set(),
    submittedInvoices: [{ id: "inv1" }, { id: "inv2" }], seenInvoiceIds: new Set(),
    teacherEmailAlerts: {}, seenTeacherEmailAlertIds: new Set(),
    unassignedCount: 0, unschedCount: 0, unattributedBands: [],
    uninvoicedRows: [{ studentId: "u1" }],
    dismissed: {}, lessonChangeDismissed: {},
    ...overrides,
  };
}

// Today's two counts and Dismiss-all, exactly as Dashboard wires them.
function todayCounts(c) {
  const isAlertDismissed = (k) => !!c.dismissed[k];
  const isLessonChangeDismissed = (id) => !!c.lessonChangeDismissed[id];
  const d = deriveAlertData(c);
  const panel = panelAlertCounts(d, {
    isAlertDismissed, unassignedCount: c.unassignedCount, unschedCount: c.unschedCount, unattributedBands: c.unattributedBands,
    pendingDismissed: isAlertDismissed("alert-pending"), trialDismissed: isAlertDismissed("alert-trial"), isLessonChangeDismissed,
  }).totalAlertsWithTeacherNotes;
  const sidebar = sidebarAlertCountFrom({ ...c, alertDismissals: { dismissed: c.dismissed }, isLessonChangeDismissed });
  const plan = dismissAllPlan(d, { unassignedCount: c.unassignedCount, unschedCount: c.unschedCount, uninvoicedRows: c.uninvoicedRows, isLessonChangeDismissed });
  return { d, panel, sidebar, plan };
}

export function runDashboardAlertCharacterizationTests(assert) {
  const { d, panel, sidebar, plan } = todayCounts(ownerCase());
  assert("alerts (pre-1.1): owner case derives all eight chips' data",
    [d.unassignedGroupCount, d.incompleteStudents.length, d.responseRequiredRed.length, d.catchupTotal, d.lessonChangeEmails.length, d.pendingOnly, d.newInvoices.length],
    [2, 2, 1, 1, 1, 1, 2]);
  assert("alerts (pre-1.1): owner case — sidebar 6, Alerts button 7", [sidebar, panel], [6, 7]);
  const noUninv = todayCounts(ownerCase({ uninvoicedRows: [] }));
  assert("alerts (pre-1.1): uninvoiced is counted by neither badge", [noUninv.sidebar, noUninv.panel], [sidebar, panel]);
  const noInv = todayCounts(ownerCase({ submittedInvoices: [] }));
  assert("alerts (pre-1.1): invoices received counts on the button only", [noInv.sidebar, noInv.panel], [6, 6]);

  // Incomplete-profile divergence: the panel also counts pending students and
  // placeholder class names; the sidebar counts active students missing a field.
  const div = ownerCase({ students: [complete("pp", { status: "pending", className: "" }), complete("ct", { className: "Class times" })] , enrolments: [], inboxEmails: [], offerableTodayEntries: [], submittedInvoices: [] });
  const dv = todayCounts(div);
  assert("alerts (pre-1.1): incomplete definitions differ (chip 2 students, sidebar none)",
    [dv.d.incompleteStudents.map(s => s.id), dv.sidebar, dv.panel], [["pp", "ct"], 1, 2]);

  // Per-email dismissal hides the response chip but both counts ignore it.
  const pe = todayCounts(ownerCase({ dismissed: { "alert-response-email-r1": true } }));
  assert("alerts (pre-1.1): per-email response dismissal still counted", [pe.sidebar, pe.panel], [6, 7]);

  // Dismiss-all key list.
  const withBand = todayCounts(ownerCase({ unattributedBands: [{ bandLessonId: "b1" }] }));
  assert("alerts (pre-1.1): band chip counts on both badges", [withBand.sidebar, withBand.panel], [7, 8]);
  assert("alerts (pre-1.1): Dismiss-all has no band key",
    Object.keys(withBand.plan.keys).some(k => k.startsWith("alert-unattributed-bands")), false);
  assert("alerts (pre-1.1): Dismiss-all keys for the owner case",
    Object.keys(plan.keys).sort(),
    ["alert-catchup", "alert-incomplete", "alert-lesson-change", "alert-pending", "alert-response-red", "alert-unassigned-groups", "alert-uninvoiced"]);
  assert("alerts (pre-1.1): Dismiss-all seen-set and lesson-change ids",
    [plan.lessonChangeIds, plan.invoiceIds], [["lc1"], ["inv1", "inv2"]]);
}
