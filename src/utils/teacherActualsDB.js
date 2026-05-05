// ============================================================
// teacherActualsDB.js
// Supabase loader for the teacher_actuals table — admin-side.
//
// Table shape:
//   id uuid PK, teacher_id uuid FK, week_key text, school_id text,
//   lessons jsonb, missed jsonb, notes text, updated_at timestamptz
//   UNIQUE(week_key, school_id, teacher_id)
//
// READ-ONLY from admin. Teacher app writes its own actuals; the
// drain_teacher_actuals pg_cron job runs at 6pm Melbourne, merging
// past-day teacher_actuals rows into weekly_adjustments and pruning
// drained rows. Admin reads the live table to render teacher imports
// as ghost cards over the weekly planning view.
//
// Storage-key convention is tri-key (weekKey|schoolId|teacherId)
// because admin sees multiple teachers' actuals at the same
// (weekKey, schoolId) — the bi-key used by weekly_adjustments would
// collide.
// ============================================================

import { supabase } from "../supabaseClient";

const TABLE = "teacher_actuals";

// ── Storage-key helper ───────────────────────────────────────
// Tri-key keeps multiple teachers' rows for the same week+school
// independent in admin's local map.
export function teacherActualsStorageKey(weekKey, schoolId, teacherId) {
  return `${weekKey}|${schoolId}|${teacherId}`;
}

// ── DB row → in-app entry ────────────────────────────────────
export function teacherActualsRowToEntry(row) {
  return {
    lessons:   row.lessons    || [],
    missed:    row.missed     || [],
    notes:     row.notes      || "",
    updatedAt: row.updated_at,
  };
}

// ── Load all rows ────────────────────────────────────────────
// No filter — admin sees every teacher's actuals across every
// school. Returns a map keyed by tri-key. Returns {} on error or
// empty (mirrors weeklyAdjustmentsDB.js's fail-soft behaviour;
// caller treats absence as "no ghost layer to render").
export async function loadTeacherActualsFromSupabase() {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("teacher_id, week_key, school_id, lessons, missed, notes, updated_at");

    if (error) {
      console.error("[teacherActualsDB] load error:", error);
      return {};
    }
    if (!data || data.length === 0) return {};

    const result = {};
    for (const row of data) {
      if (!row.week_key || !row.school_id || !row.teacher_id) continue;
      const key = teacherActualsStorageKey(row.week_key, row.school_id, row.teacher_id);
      result[key] = teacherActualsRowToEntry(row);
    }
    return result;
  } catch (err) {
    console.error("[teacherActualsDB] load exception:", err);
    return {};
  }
}
