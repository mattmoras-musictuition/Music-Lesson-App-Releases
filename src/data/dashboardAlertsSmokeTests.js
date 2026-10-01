// ============================================================
// DASHBOARD ALERTS SMOKE TESTS
// v2.41.1. The fixture reproduces the owner's 1 Oct 2026 screen, which showed
// eight chips — ungrouped, incomplete profiles, uninvoiced, response overdue,
// catch-ups owed, lesson changes, pending, invoices received. The last-but-one
// and last are removed in v2.41.1, so it now shows six. Dates sit in
// 2099 and today/Monday are passed in, so the real clock never matters.
// ============================================================

import { deriveAlertData, buildAlertChips, visibleChipCount, dismissAllPlan } from "./dashboardAlerts";
import { undismissedBandIds } from "./bandSessionView";
import { computeTermWeekNum } from "../utils/tallyHelpers";

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
    dismissed: {},
    ...overrides,
  };
}

// The chip list, the badge count (both badges) and Dismiss-all, exactly as
// Dashboard wires them.
function model(c) {
  const isAlertDismissed = (k) => !!c.dismissed[k];
  const d = deriveAlertData(c);
  const chips = buildAlertChips(d, {
    isAlertDismissed, unassignedCount: c.unassignedCount, unschedCount: c.unschedCount,
    uninvoicedRows: c.uninvoicedRows, unattributedBands: c.unattributedBands,
  });
  return { d, chips, count: visibleChipCount(chips), visible: chips.filter(x => x.visible).map(x => x.key), plan: dismissAllPlan(chips) };
}

// Apply a Dismiss-all plan the way Dashboard does: alertDismissals keys, then
// each seen set / the lesson-change store.
function applyPlan(c, plan) {
  const mark = (set, ids) => new Set([...set, ...(ids || [])]);
  const dismissed = { ...c.dismissed, ...plan.keys };
  // Dashboard recomputes the band list from alertDismissals (unattributedBandsForAlert).
  const keepBands = new Set(undismissedBandIds((c.unattributedBands || []).map(b => b.bandLessonId), dismissed));
  return {
    ...c,
    dismissed,
    unattributedBands: (c.unattributedBands || []).filter(b => keepBands.has(b.bandLessonId)),
    seenTeacherNoteIds: mark(c.seenTeacherNoteIds, plan.seen.teacherNotes),
    seenStaffDocIds: mark(c.seenStaffDocIds, plan.seen.staffDocs),
    seenTeacherEmailAlertIds: mark(c.seenTeacherEmailAlertIds, plan.seen.teacherEmailAlerts),
  };
}

// v2.41.1 commit 3 removed the lesson-changes and invoices-received chips:
// the owner case shows 6 chips, and their fixture data (a parent's
// "reschedule" email, two sent teacher invoices) now adds nothing.
// v2.41.1 commit 2 changed these assertions from the commit-1 pins, on purpose:
//   • owner case: sidebar 6 / button 7 → both 8 (= the 8 visible chips);
//   • uninvoiced: counted by neither → counted (it is a visible chip);
//   • invoices received: button only → both;
//   • incomplete profiles: two definitions → the chip's one, for both;
//   • per-email response dismissal: still counted → hides AND uncounts;
//   • Dismiss-all: no band key → every visible chip, band included.
export function runDashboardAlertTests(assert) {
  const owner = model(ownerCase());
  assert("alerts: owner case derives all eight chips' data",
    [owner.d.unassignedGroupCount, owner.d.incompleteStudents.length, owner.d.responseRequiredRed.length, owner.d.catchupTotal, owner.d.pendingOnly],
    [2, 2, 1, 1, 1]);
  assert("alerts: owner case — six visible chips in banner order (lesson changes and invoices received removed)", owner.visible,
    ["ungrouped", "incomplete", "uninvoiced", "response-red", "catchup", "pending"]);
  assert("alerts: owner case — both badges 6 (was sidebar 6, button 7, 8 chips)", owner.count, 6);
  assert("alerts: uninvoiced is counted (was neither)", model(ownerCase({ uninvoicedRows: [] })).count, 5);
  const keysOf = (m) => m.chips.map(c => c.key);
  assert("alerts: no lesson-changes or invoices-received chip, even with such emails and invoices",
    [keysOf(owner).includes("lesson-change"), keysOf(owner).includes("invoices"), owner.d.lessonChangeEmails, owner.d.newInvoices], [false, false, undefined, undefined]);
  assert("alerts: the lesson-change email and the invoices add nothing",
    model(ownerCase({ inboxEmails: ownerCase().inboxEmails.filter(e => e.id !== "lc1"), submittedInvoices: [] })).count, 6);

  const div = model(ownerCase({ students: [complete("pp", { status: "pending", className: "" }), complete("ct", { className: "Class times" })], enrolments: [], inboxEmails: [], offerableTodayEntries: [], submittedInvoices: [], uninvoicedRows: [] }));
  assert("alerts: incomplete uses the chip's definition for both badges",
    [div.d.incompleteStudents.map(x => x.id), div.visible, div.count], [["pp", "ct"], ["incomplete", "pending"], 2]);

  const pe = model(ownerCase({ dismissed: { "alert-response-email-r1": true } }));
  assert("alerts: per-email response dismissal hides and uncounts (was still counted)",
    [pe.visible.includes("response-red"), pe.count], [false, 5]);

  // Every chip type: visible → counted, dismissed → not.
  const bare = ownerCase({ students: [], enrolments: [], inboxEmails: [], offerableTodayEntries: [], submittedInvoices: [], uninvoicedRows: [] });
  assert("alerts: nothing to show → no chips", model(bare).count, 0);
  const one = (label, overrides, key, dismissKey) => {
    const m = model({ ...bare, ...overrides });
    assert(`alerts: ${label} visible → counted`, [m.visible, m.count], [[key], 1]);
    if (dismissKey) {
      const dm = model({ ...bare, ...overrides, dismissed: { [dismissKey]: true } });
      assert(`alerts: ${label} dismissed → hidden and uncounted`, dm.count, 0);
    }
  };
  one("unassigned", { unassignedCount: 1 }, "unassigned", "alert-unassigned");
  one("unscheduled", { unschedCount: 1 }, "unscheduled", "alert-unscheduled");
  one("uninvoiced", { uninvoicedRows: [{ studentId: "u" }] }, "uninvoiced", "alert-uninvoiced");
  one("catch-ups owed", { offerableTodayEntries: [{ studentId: "c", studentName: "C", instrument: "Gtr" }] }, "catchup", "alert-catchup");
  one("band attributions", { unattributedBands: [{ bandLessonId: "b1" }] }, "band-attributions", null);
  const remBreaks = [{ type: "term_break", date: "2099-01-01", endDate: "2099-02-01" }];
  const remWeek = computeTermWeekNum("2099-03-09", remBreaks);
  assert("alerts: reminder fixture sits in a term week", typeof remWeek === "number" && remWeek > 0, true);
  one("reminders next week", { sortedReminders: [{ id: "r", week: String(remWeek + 1), text: "x" }], interruptions: remBreaks }, "reminder-upcoming", "alert-reminder-upcoming");
  one("missed this week", { weeklyTimetables: { "2099-03-09|S": { lessons: [], missed: [{ studentId: "m", studentName: "M", instrument: "Gtr", day: "Monday", reason: "uninformed_absence" }] } } }, "missed-week", "alert-missed-week");
  one("trial", { students: [complete("t", { status: "trial" })] }, "trial", "alert-trial");
  one("teacher notes (seen-set, now on the sidebar too)", { students: [complete("tn", { teacher_notes: [{ id: "n1" }] })] }, "teacher-notes", null);
  one("staff uploads", { staffUploadedDocs: [{ id: "doc1" }] }, "staff-docs", null);
  one("teacher email alerts", { teacherEmailAlerts: { e1: { emailId: "e1", type: "absence", summary: "Away" } } }, "teacher-email-alerts", null);
  assert("alerts: a seen-set chip is hidden by its seen set",
    model({ ...bare, staffUploadedDocs: [{ id: "doc1" }], seenStaffDocIds: new Set(["doc1"]) }).count, 0);

  // Interruptions: one entry per chip actually rendered.
  const intr = (id, type, schoolId, title = "Event") => ({ id, type, schoolId, title, date: "2099-03-16" });
  const im = model({ ...bare, interruptions: [
    intr("ph1", "public_holiday"), intr("ph2", "public_holiday"),
    intr("cd1", "curriculum_day", "A"),
    intr("a1", "excursion", "A"), intr("b1", "excursion", "B"), intr("b2", "excursion", "B"),
  ] });
  assert("alerts: interruptions — PH group, curriculum days, school A, school B = 4 chips",
    [im.visible, im.count], [["intr-public-holidays", "intr-curriculum-days", "intr-school-A", "intr-school-B"], 4]);
  const im2 = model({ ...bare, interruptions: [intr("ph1", "public_holiday"), intr("b1", "excursion", "B")], dismissed: { "alert-interruption-b1": true } });
  assert("alerts: a dismissed interruption's chip goes", im2.visible, ["intr-public-holidays"]);

  // Dismiss all: every visible chip, band included, each through its own store.
  const busy = ownerCase({
    unattributedBands: [{ bandLessonId: "b1" }], staffUploadedDocs: [{ id: "doc1" }],
    students: [...ownerCase().students, complete("tn", { teacher_notes: [{ id: "n1" }] })],
    interruptions: [intr("ph1", "public_holiday")],
  });
  const bm = model(busy);
  assert("alerts: busy screen count", bm.count, 10);
  assert("alerts: Dismiss-all includes the band chip's key (was missing)",
    Object.keys(bm.plan.keys).some(k => k.startsWith("alert-unattributed-bands|")), true);
  assert("alerts: Dismiss-all seen ids per store",
    [bm.plan.seen.staffDocs, bm.plan.seen.teacherNotes, bm.plan.seen.lessonChanges, bm.plan.seen.invoices], [["doc1"], ["n1"], undefined, undefined]);
  assert("alerts: Dismiss-all writes no lesson-change or invoice keys",
    Object.keys(bm.plan.keys).filter(k => k === "alert-lesson-change"), []);
  assert("alerts: Dismiss-all doesn't write the per-student uninvoiced set (key only)",
    Object.keys(bm.plan.keys).includes("alert-uninvoiced") && !bm.plan.seen.uninvoiced, true);
  const after = model(applyPlan(busy, bm.plan));
  assert("alerts: after Dismiss-all, no chips and both badges 0", [after.visible, after.count], [[], 0]);
}
