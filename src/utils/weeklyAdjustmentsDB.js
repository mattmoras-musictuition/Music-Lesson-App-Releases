// ============================================================
// weeklyAdjustmentsDB.js
// Supabase load/sync for the weeklyTimetables collection.
//
// weeklyTimetables shape (in-app):
//   { "2025-W10|schoolId": { lessons, missed, notes, generatedAt, breaks } }
//
// Supabase table: weekly_adjustments
//   id uuid PK, user_id uuid FK, week_key text, school_id text,
//   lessons jsonb, missed jsonb, notes text, generated_at text,
//   breaks jsonb, updated_at timestamptz
//   UNIQUE(week_key, school_id)
//
// syncWeeklyAdjustmentsToSupabase now returns the upserted rows
// (with week_key, school_id, updated_at) so callers can record
// which updated_at values belong to their own writes — used by
// the polling loop to avoid re-processing self-written rows.
// ============================================================

import { supabase } from "../supabaseClient";

const TABLE = "weekly_adjustments";

// Convert a Supabase row to the app's entry shape
function rowToEntry(row) {
  return {
    lessons:     row.lessons      || [],
    missed:      row.missed       || [],
    notes:       row.notes        || "",
    generatedAt: row.generated_at || "",
    breaks:      row.breaks       || [],
  };
}

// ── Load ─────────────────────────────────────────────────────
// Returns the full weeklyTimetables map: { "weekKey|schoolId": entry }
// Returns {} (empty object) if the table is empty — caller falls back to localStorage.
export async function loadWeeklyAdjustmentsFromSupabase() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("week_key, school_id, lessons, missed, notes, generated_at, breaks");

  if (error) throw error;
  if (!data || data.length === 0) return {};

  const result = {};
  for (const row of data) {
    const key = `${row.week_key}|${row.school_id}`;
    result[key] = rowToEntry(row);
  }
  return result;
}

// ── Upsert with deadlock retry ────────────────────────────────────────────
// PostgreSQL deadlocks (code 40P01) are transient — retrying after a short
// back-off almost always succeeds. Cap at 3 attempts: 100ms → 200ms → 400ms.
async function upsertBatchWithRetry(batch, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { data, error } = await supabase
      .from(TABLE)
      .upsert(batch, { onConflict: "week_key,school_id" })
      .select("week_key, school_id, updated_at");
    if (!error) return data || [];
    const isDeadlock = error.code === "40P01" || (error.message || "").toLowerCase().includes("deadlock");
    if (isDeadlock && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
      continue;
    }
    throw error;
  }
  return [];
}

// ── Sync ─────────────────────────────────────────────────────
// Upserts all entries, then deletes any Supabase rows that no longer
// exist locally (i.e. weeks that have been pruned by setWeeklyTimetables).
export async function syncWeeklyAdjustmentsToSupabase(weeklyTimetables, userId) {
  const entries = Object.entries(weeklyTimetables);
  if (entries.length === 0) return;

  // Upsert all current local entries in batches of 200.
  // Conflict key is now (week_key, school_id) — no user_id — so admin and
  // teacher share a single row per week/school rather than creating duplicates.
  // The delete step has been removed: we no longer own all rows in the table
  // (teachers may have written rows the admin doesn't hold locally).
  const rows = entries.map(([key, value]) => {
    const pipeIdx = key.indexOf("|");
    const weekKey  = key.substring(0, pipeIdx);
    const schoolId = key.substring(pipeIdx + 1);
    return {
      user_id:      userId,
      week_key:     weekKey,
      school_id:    schoolId,
      lessons:      value.lessons      || [],
      missed:       value.missed       || [],
      notes:        value.notes        || "",
      generated_at: value.generatedAt  || "",
      breaks:       value.breaks       || [],
    };
  });

  const BATCH = 200;
  const allUpserted = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const upserted = await upsertBatchWithRetry(batch);
    if (upserted) allUpserted.push(...upserted);
  }
  // Return the upserted rows so callers can record their own updated_at values.
  // This is used by the polling loop to skip rows that this app just wrote.
  return allUpserted;
}
