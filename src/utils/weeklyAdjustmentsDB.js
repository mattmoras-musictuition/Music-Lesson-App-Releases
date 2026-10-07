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
//   breaks jsonb, updated_at timestamptz,
//   day_edited_at jsonb NOT NULL DEFAULT '{}'  (v2.49.3 — utils/dayEdits.js)
//   UNIQUE(week_key, school_id)
//
// syncWeeklyAdjustmentsToSupabase now returns the upserted rows
// (with week_key, school_id, updated_at) so callers can record
// which updated_at values belong to their own writes — used by
// the polling loop to avoid re-processing self-written rows.
// ============================================================

import { supabase } from "../supabaseClient";
import { normaliseDayEditedAt, isMissingDayEditedColumn } from "./dayEdits";

const TABLE = "weekly_adjustments";

// Convert a Supabase row to the app's entry shape
function rowToEntry(row) {
  return {
    lessons:     row.lessons      || [],
    missed:      row.missed       || [],
    notes:       row.notes        || "",
    generatedAt: row.generated_at || "",
    breaks:      row.breaks       || [],
    dayEditedAt: normaliseDayEditedAt(row.day_edited_at),
  };
}

export const WEEKLY_SELECT = "week_key, school_id, lessons, missed, notes, generated_at, breaks, day_edited_at";
const WEEKLY_SELECT_LEGACY = "week_key, school_id, lessons, missed, notes, generated_at, breaks";

// Reported by the sync when the database lacks day_edited_at. The lessons are
// still saved (retried without the column); only the day stamps are lost.
export const MISSING_DAY_EDITED_MESSAGE =
  "Weekly timetable saved, but the database is missing the day_edited_at column, so day edit times were not stored. Apply supabase/sql/add_day_edited_at.sql.";

// ── Load ─────────────────────────────────────────────────────
// Returns the full weeklyTimetables map: { "weekKey|schoolId": entry }
// Returns {} (empty object) if the table is empty — caller falls back to localStorage.
export async function loadWeeklyAdjustmentsFromSupabase() {
  let { data, error } = await supabase.from(TABLE).select(WEEKLY_SELECT);
  if (error && isMissingDayEditedColumn(error)) {
    console.error("[weeklyAdjustmentsDB] " + MISSING_DAY_EDITED_MESSAGE);
    ({ data, error } = await supabase.from(TABLE).select(WEEKLY_SELECT_LEGACY));
  }
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
// Returns { rows, missingColumn }. If the database lacks day_edited_at the
// batch is saved again without it — lessons are never dropped — and
// missingColumn tells the caller to report it.
async function upsertBatchWithRetry(batch, maxRetries = 3) {
  try {
    return { rows: await upsertBatchOnce(batch, maxRetries), missingColumn: false };
  } catch (error) {
    if (!isMissingDayEditedColumn(error)) throw error;
    const rows = await upsertBatchOnce(batch.map(({ day_edited_at, ...row }) => row), maxRetries);
    return { rows, missingColumn: true };
  }
}

async function upsertBatchOnce(batch, maxRetries) {
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
  // Conflict key is (week_key, school_id) — single admin-side row per
  // week+school. Teacher app no longer writes this table directly;
  // teacher actuals live in teacher_actuals and are merged in by the
  // drain_teacher_actuals pg_cron at 6pm Melbourne.
  // The delete step has been removed: drained rows from the cron
  // appear here without admin holding them locally first.
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
      day_edited_at: normaliseDayEditedAt(value.dayEditedAt),
    };
  });

  const BATCH = 200;
  const allUpserted = [];
  let missingColumn = false;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const res = await upsertBatchWithRetry(batch);
    if (res.rows) allUpserted.push(...res.rows);
    if (res.missingColumn) missingColumn = true;
  }
  // Return the upserted rows so callers can record their own updated_at values.
  // This is used by the polling loop to skip rows that this app just wrote.
  // v2.49.3 — missingDayEditedColumn flags a save that had to drop the stamps.
  if (missingColumn) allUpserted.missingDayEditedColumn = true;
  return allUpserted;
}

// ── Delete one week (v2.49.3) ────────────────────────────────
// "Clear full week" only. Deletes the (week_key, school_id) row. If the
// delete removes nothing while the row still exists (the database refused
// it), saves the week as empty instead so its lessons can never come back.
// Returns "deleted" | "emptied" | "absent". Throws on a network/server error
// so the caller keeps the key pending and retries on the next sync.
export async function deleteWeeklyAdjustmentRow(weekKey, schoolId, userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .delete()
    .eq("week_key", weekKey)
    .eq("school_id", schoolId)
    .select("week_key");
  if (error) throw error;
  if (data && data.length > 0) return "deleted";
  const { data: still, error: selErr } = await supabase
    .from(TABLE)
    .select("week_key")
    .eq("week_key", weekKey)
    .eq("school_id", schoolId);
  if (selErr) throw selErr;
  if (!still || still.length === 0) return "absent";
  await upsertBatchWithRetry([{
    user_id: userId, week_key: weekKey, school_id: schoolId,
    lessons: [], missed: [], notes: "", generated_at: "", breaks: [], day_edited_at: {},
  }]);
  return "emptied";
}
