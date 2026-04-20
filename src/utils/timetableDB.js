// ============================================================
// timetableDB.js
// Supabase load/sync for the master timetable.
//
// In-app shape: { lessons: [...], unscheduled: [...] } | null
//
// Supabase table: timetable_data
//   user_id uuid PK, lessons jsonb, unscheduled jsonb, updated_at
//
// Stores the whole timetable as JSONB — simple and reliable.
// ============================================================

import { supabase } from "../supabaseClient";

const TABLE = "timetable_data";

// ── Load ─────────────────────────────────────────────────────
// Returns { lessons, unscheduled } or null if Supabase has no data.
// null triggers the localStorage fallback in App.js.
export async function loadTimetableFromSupabase() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("lessons, unscheduled")
    .limit(1);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const row = data[0];
  const lessons = row.lessons || [];
  if (lessons.length === 0) return null; // treat empty as "not yet synced"

  return {
    lessons,
    unscheduled: row.unscheduled || [],
  };
}

// ── Sync ─────────────────────────────────────────────────────
// Upserts the full timetable for this user.
export async function syncTimetableToSupabase(timetable, userId) {
  if (!timetable) return;

  const { error } = await supabase
    .from(TABLE)
    .upsert(
      {
        user_id:     userId,
        lessons:     timetable.lessons     || [],
        unscheduled: timetable.unscheduled || [],
      },
      { onConflict: "user_id" }
    );

  if (error) throw error;
}
