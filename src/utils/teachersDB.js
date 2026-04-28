// ============================================================
// teachersDB.js — Supabase read/write helpers for Teachers
// All Supabase logic for the teachers collection lives here.
// App.js calls these functions; nothing else needs to change.
// ============================================================

import { supabase } from "../supabaseClient";

// ── Shape converters ─────────────────────────────────────────

// `sortOrder` is the teacher's position in the admin-side array at sync time.
// Assigned by syncTeachersToSupabase from the array index (teachers[0] → 0, etc.)
// so dragging cards in TeachersManager persists the new order across reloads.
// Loaded back via `.order("sort_order")` — see loadTeachersFromSupabase.
function toRow(teacher, userId, sortOrder) {
  return {
    id:              teacher.id,
    user_id:         userId,
    name:            teacher.name           || "",
    email:           teacher.email          || "",
    phone:           teacher.phone          || "",
    color:           teacher.color          || "",
    notes:           teacher.notes          || "",
    instruments:     teacher.instruments    || [],
    availability:    teacher.availability   || [],
    teacher_breaks:  teacher.teacherBreaks  || [],
    hourly_rate:     teacher.hourlyRate     || null,
    has_account:     teacher.hasAccount     || false,
    sort_order:      sortOrder,
    updated_at:      new Date().toISOString(),
  };
}

function fromRow(row) {
  const availability = row.availability || [];
  return {
    id:             row.id,
    name:           row.name            || "",
    email:          row.email           || "",
    phone:          row.phone           || "",
    color:          row.color           || "",
    notes:          row.notes           || "",
    instruments:    row.instruments     || [],
    availability,
    teacherBreaks:  row.teacher_breaks  || [],
    hourlyRate:     row.hourly_rate     ?? "",
    hasAccount:     row.has_account     || false,
    sortOrder:      row.sort_order      ?? null,
    lastSeen:       row.last_seen       || null,
    // Derive schools from availability (same as TeachersManager saveTeacher does)
    schools: [...new Set(availability.map(a => a.schoolId).filter(Boolean))],
  };
}

// ── Load ─────────────────────────────────────────────────────

// Order by sort_order first (teacher's drag-reordered position), falling back
// to name for any rows with a null sort_order (older data pre-migration).
export async function loadTeachersFromSupabase() {
  const { data, error } = await supabase
    .from("teachers")
    .select("*")
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("name");
  if (error) throw error;
  return (data || []).map(fromRow);
}

// ── Save (sync) ───────────────────────────────────────────────

export async function syncTeachersToSupabase(teachers, userId) {
  if (!userId) throw new Error("No user ID — cannot sync teachers");

  if (teachers.length > 0) {
    // Pass array index as sort_order so Supabase persists the drag-reordered
    // sequence. Next load reads it back via `.order("sort_order")`.
    const rows = teachers.map((t, i) => toRow(t, userId, i));
    const { error: upsertError } = await supabase
      .from("teachers")
      .upsert(rows, { onConflict: "id" });
    if (upsertError) throw upsertError;
  }

  // Delete any remote teachers that no longer exist locally
  const { data: remoteRows, error: fetchError } = await supabase
    .from("teachers")
    .select("id")
    .eq("user_id", userId);
  if (fetchError) throw fetchError;

  const localIds = new Set(teachers.map(t => t.id));
  const toDelete = (remoteRows || [])
    .map(r => r.id)
    .filter(id => !localIds.has(id));

  if (toDelete.length > 0) {
    const { error: deleteError } = await supabase
      .from("teachers")
      .delete()
      .in("id", toDelete);
    if (deleteError) throw deleteError;
  }
}
