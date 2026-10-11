// ============================================================
// teacherInvoices.js — pure helpers for teacher invoices delivered in-app.
// No React, no I/O: the rows come from utils/teacherInvoicesDB.js (which
// never selects pdf_base64 for lists), so smoke tests can pin these.
//
// A row is "sent" by status only. submitted_at is NOT NULL and drafts carry
// their creation time, so it can't tell a draft from a sent invoice.
// invoice_number is null on everything an older teacher build sent.
// ============================================================

const isSent = (r) => !!r && r.status === "sent";

// Unseen = sent and not yet opened (or dismissed) by the admin.
export function unseenInvoices(rows) {
  return (rows || []).filter(r => isSent(r) && !r.admin_seen_at);
}

export function unseenInvoiceIds(rows) {
  return unseenInvoices(rows).map(r => r.id);
}

// "3 – 16 Mar 2026"; a year change shows both years. Dates are YYYY-MM-DD,
// read at local noon so no timezone can shift the day.
export function invoicePeriodLabel(start, end) {
  if (!start || !end) return "";
  const a = new Date(start + "T12:00:00");
  const b = new Date(end + "T12:00:00");
  if (isNaN(a) || isNaN(b)) return "";
  const yr = { day: "numeric", month: "short", year: "numeric" };
  const left = a.getFullYear() === b.getFullYear()
    ? a.toLocaleDateString("en-AU", { day: "numeric", month: "short" })
    : a.toLocaleDateString("en-AU", yr);
  return `${left} – ${b.toLocaleDateString("en-AU", yr)}`;
}

export function invoiceTotalLabel(amount) {
  const n = Number(amount);
  if (amount == null || amount === "" || isNaN(n)) return "";
  return "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function invoiceSentLabel(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The Invoices folder's rows: sent only, newest sent first.
 * @param {Array} rows      teacher_invoices rows (any status; drafts dropped)
 * @param {Array} teachers  admin teachers list ({ id, name })
 */
export function shapeInvoiceRows(rows, teachers) {
  const names = new Map((teachers || []).map(t => [t.id, t.name]));
  return (rows || [])
    .filter(isSent)
    .slice()
    .sort((a, b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0))
    .map(r => ({
      id: r.id,
      teacherId: r.teacher_id || "",
      teacherName: names.get(r.teacher_id) || "Unknown teacher",
      periodLabel: invoicePeriodLabel(r.period_start, r.period_end),
      totalLabel: invoiceTotalLabel(r.total_amount),
      sentLabel: invoiceSentLabel(r.submitted_at),
      number: r.invoice_number || "",
      isNew: !r.admin_seen_at,
    }));
}
