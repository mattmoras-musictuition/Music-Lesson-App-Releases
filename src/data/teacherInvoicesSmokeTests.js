// ============================================================
// TEACHER INVOICES SMOKE TESTS — the Documents > Invoices folder rows and
// the Dashboard "new invoices" chip. Rows are shaped exactly as
// teacherInvoicesDB.refreshSentInvoices returns them (no pdf_base64), plus a
// draft to prove status — not submitted_at — decides what is sent.
// ============================================================

import { shapeInvoiceRows, unseenInvoiceIds, invoicePeriodLabel, invoiceTotalLabel } from "./teacherInvoices";
import { deriveAlertData, buildAlertChips, visibleChipCount, dismissAllPlan } from "./dashboardAlerts";
import { ownerCase } from "./dashboardAlertsSmokeTests";

const TEACHERS = [{ id: "t_r", name: "Rauzah" }, { id: "t_b", name: "Ben" }];

// Live-shaped rows: 1 draft (submitted_at = its creation time, never null),
// an old-build sent row with no invoice_number, a new-build numbered row,
// an already-seen row, and a row from a teacher id the admin doesn't know.
export function invoiceRows() {
  const row = (id, extra) => ({
    id, teacher_id: "t_r", period_start: "2099-03-02", period_end: "2099-03-15", status: "sent",
    hourly_rate: 50, total_hours: 10, total_amount: 500, submitted_at: "2099-03-16T02:00:00Z",
    invoice_number: null, admin_seen_at: null, ...extra,
  });
  return [
    row("draft1", { status: "draft", submitted_at: "2099-03-20T02:00:00Z" }),
    row("old1", { submitted_at: "2099-03-16T02:00:00Z" }),
    row("new1", { teacher_id: "t_b", invoice_number: "INV-0007", total_amount: "1234.5", submitted_at: "2099-03-18T02:00:00Z" }),
    row("seen1", { submitted_at: "2099-03-17T02:00:00Z", admin_seen_at: "2099-03-17T05:00:00Z" }),
    row("ghost1", { teacher_id: "t_gone", period_start: "2098-12-22", period_end: "2099-01-04", submitted_at: "2099-01-05T02:00:00Z" }),
  ];
}

export function runTeacherInvoiceTests(assert) {
  const shaped = shapeInvoiceRows(invoiceRows(), TEACHERS);
  assert("invoices: drafts excluded, newest sent first", shaped.map(r => r.id), ["new1", "seen1", "old1", "ghost1"]);
  assert("invoices: null invoice_number shows blank", shaped.find(r => r.id === "old1").number, "");
  assert("invoices: stored invoice_number shown", shaped.find(r => r.id === "new1").number, "INV-0007");
  assert("invoices: unknown teacher falls back", shaped.find(r => r.id === "ghost1").teacherName, "Unknown teacher");
  assert("invoices: known teacher named", shaped.find(r => r.id === "new1").teacherName, "Ben");
  assert("invoices: new marker = admin_seen_at null", shaped.map(r => r.isNew), [true, false, true, true]);
  assert("invoices: row labels", (({ periodLabel, totalLabel, sentLabel }) => [periodLabel, totalLabel, sentLabel])(shaped.find(r => r.id === "new1")),
    ["2 Mar – 15 Mar 2099", "$1,234.50", "18 Mar 2099"]);
  assert("invoices: period across a year shows both years", invoicePeriodLabel("2098-12-22", "2099-01-04"), "22 Dec 2098 – 4 Jan 2099");
  assert("invoices: missing total is blank, not $0.00", [invoiceTotalLabel(null), invoiceTotalLabel(0)], ["", "$0.00"]);
  assert("invoices: empty / missing input", [shapeInvoiceRows(null, null), unseenInvoiceIds(undefined)], [[], []]);
  assert("invoices: unseen ids skip drafts and seen rows", unseenInvoiceIds(invoiceRows()), ["old1", "new1", "ghost1"]);
}

// The chip, through the same deriveAlertData → buildAlertChips path Dashboard
// uses, fed the full owner-case inputs plus teacherInvoices.
function chipModel(c) {
  const isAlertDismissed = (k) => !!c.dismissed[k];
  const d = deriveAlertData(c);
  const chips = buildAlertChips(d, {
    isAlertDismissed, unassignedCount: c.unassignedCount, unschedCount: c.unschedCount,
    uninvoicedRows: c.uninvoicedRows, unattributedBands: c.unattributedBands,
  });
  return { d, chips, count: visibleChipCount(chips), visible: chips.filter(x => x.visible).map(x => x.key), plan: dismissAllPlan(chips) };
}

export function runTeacherInvoiceChipTests(assert) {
  const allSeen = invoiceRows().map(r => (r.status === "sent" ? { ...r, admin_seen_at: "2099-03-19T00:00:00Z" } : r));
  const zero = chipModel(ownerCase({ teacherInvoices: allSeen }));
  assert("invoice chip: zero unseen (only a draft unseen) → no chip", [zero.visible.includes("teacher-invoices"), zero.count], [false, 6]);
  const none = chipModel(ownerCase({ teacherInvoices: undefined }));
  assert("invoice chip: not loaded yet → no chip", none.visible.includes("teacher-invoices"), false);

  const n = chipModel(ownerCase({ teacherInvoices: invoiceRows() }));
  assert("invoice chip: N unseen → chip last, after the owner case's six",
    n.visible, ["ungrouped", "incomplete", "uninvoiced", "response-red", "catchup", "pending", "teacher-invoices"]);
  assert("invoice chip: counted in both badges", n.count, 7);
  assert("invoice chip: N = 3 unseen sent invoices", n.d.newTeacherInvoices.map(r => r.id), ["old1", "new1", "ghost1"]);
  const chip = n.chips.find(c => c.key === "teacher-invoices");
  assert("invoice chip: X marks exactly the outstanding ids, no dismissal key",
    [chip.seen.ids, chip.dismissKeys], [["old1", "new1", "ghost1"], []]);
  assert("invoice chip: Dismiss-all marks exactly the outstanding ids",
    n.plan.seen.teacherInvoices, ["old1", "new1", "ghost1"]);
  assert("invoice chip: Dismiss-all writes no alertDismissals key for it",
    Object.keys(n.plan.keys).some(k => k.includes("invoice") && k !== "alert-uninvoiced"), false);

  // After the DB write (admin_seen_at set on those ids) the chip is gone.
  const marked = new Set(n.plan.seen.teacherInvoices);
  const after = chipModel(ownerCase({ teacherInvoices: invoiceRows().map(r => (marked.has(r.id) ? { ...r, admin_seen_at: "2099-03-19T00:00:00Z" } : r)) }));
  assert("invoice chip: gone once those rows are seen", after.visible.includes("teacher-invoices"), false);
  // Opening one invoice leaves the chip for the rest.
  const one = chipModel(ownerCase({ teacherInvoices: invoiceRows().map(r => (r.id === "new1" ? { ...r, admin_seen_at: "2099-03-19T00:00:00Z" } : r)) }));
  assert("invoice chip: opening one leaves the others", one.d.newTeacherInvoices.map(r => r.id), ["old1", "ghost1"]);
  // The legacy submittedInvoices input still adds nothing.
  assert("invoice chip: legacy submittedInvoices alone shows no chip",
    chipModel(ownerCase({ teacherInvoices: [] })).visible.includes("teacher-invoices"), false);
}
