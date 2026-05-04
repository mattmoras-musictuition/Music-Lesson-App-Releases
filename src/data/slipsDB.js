// ============================================================
// slipsDB.js — Day-slip mutation helpers (admin side)
// ============================================================
//
// Two narrow mutation helpers used by the admin TeachersManager
// edit/delete affordance on rows in the "Current — not yet
// submitted" section. Existing scattered inline supabase.from(
// "day_slips") call sites are NOT migrated here; this helper is
// scoped to the new admin mutations only. Banked as future
// cleanup.
//
// All writes route through the wrapped supabaseClient — dev
// short-circuits via Proxy per session 121 / 124 notes.
// ============================================================

import { supabase } from "../supabaseClient";

const WRITABLE_FIELDS = [
  "description",
  "slip_date",
  "amount",
  "start_time",
  "end_time",
  "break_minutes",
  "notes",
  "hours_worked",
  "updated_at",
];

function timeToMin(t) {
  if (!t || typeof t !== "string") return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

function computeHoursWorked(start, end, breakMins) {
  const s = timeToMin(start);
  const e = timeToMin(end);
  if (s == null || e == null) return null;
  const br = Number.isFinite(breakMins) ? breakMins : 0;
  return ((e - s) - br) / 60;
}

export async function updateSlip(slipId, fields) {
  const payload = {};
  for (const k of WRITABLE_FIELDS) {
    if (k in fields) payload[k] = fields[k];
  }
  // Recompute hours_worked when the form sends both times — keeps the
  // column consistent with start/end/break. If times are present but
  // unparseable (e.g. user cleared them), set hours to 0.
  if ("start_time" in payload && "end_time" in payload) {
    const h = computeHoursWorked(payload.start_time, payload.end_time, payload.break_minutes ?? 0);
    payload.hours_worked = h ?? 0;
  }
  payload.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("day_slips")
    .update(payload)
    .eq("id", slipId)
    .select()
    .single();
  return { data, error, payload };
}

export async function deleteSlip(slipId) {
  const { data, error } = await supabase
    .from("day_slips")
    .delete()
    .eq("id", slipId);
  return { data, error };
}
