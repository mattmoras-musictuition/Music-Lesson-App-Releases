// ============================================================
// teacherInvoicesDB.js — Supabase access for teacher invoices delivered
// in-app (Documents > Invoices folder + the Dashboard "new invoices" chip).
//
// Reads only what an is_admin() full-access policy would also allow. Lists
// NEVER select pdf_base64 (explicit column list); the PDF is fetched one
// invoice at a time when it is opened. The only write is admin_seen_at, and
// only on sent rows where it is still null.
//
// The Documents page (mounted per visit) and the Dashboard (kept alive) share
// one in-memory copy through subscribe(), so opening the Documents tab
// refreshes the Dashboard chip and opening an invoice clears it — no poll.
// ============================================================

import { supabase } from "../supabaseClient";

const LIST_COLUMNS = "id, teacher_id, period_start, period_end, status, hourly_rate, total_hours, total_amount, submitted_at, invoice_number, admin_seen_at";

let cache = null;            // last loaded sent rows, or null before first load
const listeners = new Set();
const emit = () => { for (const fn of listeners) { try { fn(cache); } catch (e) { console.error(e); } } };

export function subscribeSentInvoices(fn) {
  listeners.add(fn);
  if (cache) fn(cache);
  return () => listeners.delete(fn);
}

// Load sent invoices (no PDFs), newest first. Throws on failure; the shared
// copy is left as it was.
export async function refreshSentInvoices() {
  const { data, error } = await supabase
    .from("teacher_invoices")
    .select(LIST_COLUMNS)
    .eq("status", "sent")
    .order("submitted_at", { ascending: false });
  if (error) throw new Error(error.message);
  cache = data || [];
  emit();
  return cache;
}

// One invoice's PDF (bare base64), or throws.
export async function fetchInvoicePdf(id) {
  const { data, error } = await supabase
    .from("teacher_invoices")
    .select("pdf_base64")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  if (!data?.pdf_base64) throw new Error("This invoice has no PDF stored");
  return data.pdf_base64;
}

// Mark these invoices seen (only sent rows still unseen). Throws on failure,
// leaving the shared copy untouched so the chip stays.
export async function markInvoicesSeen(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("teacher_invoices")
    .update({ admin_seen_at: now })
    .in("id", list)
    .eq("status", "sent")
    .is("admin_seen_at", null);
  if (error) throw new Error(error.message);
  if (cache) {
    const set = new Set(list);
    cache = cache.map(r => (set.has(r.id) && !r.admin_seen_at ? { ...r, admin_seen_at: now } : r));
    emit();
  }
}

export const markInvoiceSeen = (id) => markInvoicesSeen([id]);

// Dashboard chip → Documents > Invoices. The Documents page mounts fresh on
// each visit and consumes this once on mount.
let openInvoicesRequested = false;
export function requestInvoicesFolder() { openInvoicesRequested = true; }
export function consumeInvoicesFolderRequest() {
  const v = openInvoicesRequested;
  openInvoicesRequested = false;
  return v;
}
