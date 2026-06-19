// ============================================================
// interruptionsDB.js — Supabase load/sync for interruptions
// (term breaks, public holidays, school events, etc.)
// ============================================================

import { supabase } from "../supabaseClient";

export function rowToInterruption(row) {
  return {
    id:              row.id,
    type:            row.type             || "other",
    title:           row.title            || "",
    date:            row.date             || "",
    endDate:         row.end_date         || "",
    startTime:       row.start_time       || "",
    endTime:         row.end_time         || "",
    schoolId:        row.school_id        || "all",
    affectsClasses:  row.affects_classes  || "all",
    notes:           row.notes            || "",
    source:          row.source           || "",
  };
}

function interruptionToRow(interruption, userId) {
  return {
    id:               interruption.id,
    user_id:          userId,
    type:             interruption.type            || "other",
    title:            interruption.title           || "",
    date:             interruption.date            || null,
    end_date:         interruption.endDate         || null,
    start_time:       interruption.startTime       || "",
    end_time:         interruption.endTime         || "",
    school_id:        interruption.schoolId        || "all",
    affects_classes:  interruption.affectsClasses  || "all",
    notes:            interruption.notes           || "",
    source:           interruption.source          || "",
  };
}

export async function loadInterruptionsFromSupabase() {
  const { data, error } = await supabase
    .from("interruptions")
    .select("*")
    .order("date", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToInterruption);
}

export async function syncInterruptionsToSupabase(interruptions, userId) {
  if (!userId) return;
  const rows = interruptions.map(i => interruptionToRow(i, userId));
  const { error: upsertError } = await supabase
    .from("interruptions")
    .upsert(rows, { onConflict: "id" });
  if (upsertError) throw new Error(upsertError.message);

  const currentIds = interruptions.map(i => i.id);
  if (currentIds.length === 0) return;
  const { error: deleteError } = await supabase
    .from("interruptions")
    .delete()
    .eq("user_id", userId)
    .not("id", "in", `(${currentIds.join(",")})`);
  if (deleteError) throw new Error(deleteError.message);
}

// ── Teacher-shared events (read-only on admin) ──────────────
// Teacher app writes shared "My Events" to calendar_events with
// is_private=false. Admin reads them to render alongside its own
// calendar; never writes them back.
export async function loadTeacherSharedEvents() {
  const { data, error } = await supabase
    .from("calendar_events")
    .select("*")
    .eq("is_private", false);
  if (error) {
    console.warn("[calendar] loadTeacherSharedEvents failed:", error.message);
    return [];
  }
  return data || [];
}

export function normaliseTeacherSharedEvent(row) {
  return {
    id:            row.id,
    type:          "teacher_event",
    title:         row.title       || "",
    startDate:     row.event_date,
    endDate:       row.end_date    || row.event_date,
    startTime:     row.start_time  || "",
    endTime:       row.end_time    || "",
    details:       row.notes       || "",
    teacher_id:    row.teacher_id,
    teacher_name:  row.teacher_name,
    teacher_color: row.teacher_color,
    is_private:    row.is_private,
    _store:        "cal",
    _readOnly:     true,
  };
}
