// ============================================================
// catchupsDB.js — Supabase read helpers for catchups
//
// Spec 3 cluster 2 — catch-up lessons as first-class rows.
// Each row schedules a make-up against a (school, week, day,
// time) slot, optionally linked to the original missed lesson
// via the resolves_* columns. All four resolves_* null means
// the catchup is unlinked, which the invoicing path treats as
// a "Holiday Lesson" line.
//
// Surgical-CRUD pattern — mirrors laneOverridesDB.js. Catchups
// mutate one row at a time via UI actions (create / edit /
// delete / mark made_up / link / unlink), so this module
// follows teacherCoverageDB / laneOverridesDB rather than the
// bulk-sync shape of tallyEntriesDB.
//
// Cluster 2 (this): loader + shape converter.
// Cluster 3:        insertCatchup (one-shot migration of
//                   existing JSONB catchups under
//                   __catchup__ pseudo-school weekly_adjustments
//                   rows + tally-entry catchup fields).
// Cluster 5+:       remaining write helpers (UI clusters),
//                   mirroring the cluster 4a → 9 precedent on
//                   teacherCoverageDB.
//
// Schema: applied via Supabase dashboard during cluster 1
// (10 May 2026). Project convention places schema on the
// dashboard, not in repo migrations (Phase 0 finding).
// ============================================================

import { supabase } from "../supabaseClient";

// ── Shape converter ──────────────────────────────────────────

// user_id is omitted from the returned shape — RLS implementation
// detail, not consumed by callers.
function fromRow(row) {
  return {
    id:                   row.id,
    schoolId:             row.school_id              || "",
    weekKey:              row.week_key               || "",
    day:                  row.day                    || "",
    time:                 row.time                   || "",
    durationMinutes:      row.duration_minutes       ?? null,
    instrument:           row.instrument             || "",
    enrolmentId:          row.enrolment_id           || "",
    resolvesEnrolmentId:  row.resolves_enrolment_id  || null,
    resolvesWeekKey:      row.resolves_week_key      || null,
    resolvesOriginalDay:  row.resolves_original_day  || null,
    resolvesOriginalTime: row.resolves_original_time || null,
    madeUp:               row.made_up                || false,
    notes:                row.notes                  || null,
    createdAt:            row.created_at             || "",
    updatedAt:            row.updated_at             || "",
  };
}

// ── Load ─────────────────────────────────────────────────────

// RLS scopes to auth.uid() = user_id (per the cluster 1 schema
// policy); no client-side .eq("user_id", ...) filter needed.
//
// Order: week_key → day → time gives a stable chronological
// walk for callers that render lists. The "time" column is a
// reserved word in SQL DDL but supabase-js passes column names
// verbatim to PostgREST, which handles quoting transparently.
export async function loadCatchupsFromSupabase() {
  const { data, error } = await supabase
    .from("catchups")
    .select("*")
    .order("week_key")
    .order("day")
    .order("time");
  if (error) throw error;
  return (data || []).map(fromRow);
}

/**
 * Catch-up lesson — a make-up scheduled against a specific
 * (school, week, day, time) slot. Optionally links to the
 * original missed lesson via the resolves_* columns; an unlinked
 * catchup (all four resolves_* null) bills as a "Holiday Lesson"
 * line in invoicing.
 *
 * @typedef {Object} Catchup
 * @property {string} id           Row id. Text, generated
 *                                 client-side via the uid()
 *                                 helper (8-char base36),
 *                                 matching the project pattern.
 * @property {string} schoolId     schools.id (text — 8-char
 *                                 base36 from uid()).
 * @property {string} weekKey      Week the catchup is scheduled
 *                                 IN (e.g. "2026-W19"), not the
 *                                 week being resolved.
 * @property {string} day          Day name, Monday–Friday.
 * @property {string} time         Slot time as HH:MM (24-hour).
 *                                 Reserved-word column; safe
 *                                 through PostgREST.
 * @property {number|null} durationMinutes  Slot duration. null
 *                                 means inherit from the
 *                                 enrolment's standard duration.
 * @property {string} instrument
 * @property {string} enrolmentId  enrolments.id of the student
 *                                 receiving the catchup.
 * @property {string|null} resolvesEnrolmentId   Original missed
 *                                 lesson's enrolment id. null
 *                                 ⇒ unlinked / Holiday Lesson.
 * @property {string|null} resolvesWeekKey       Week of the
 *                                 missed lesson. null ⇒
 *                                 unlinked.
 * @property {string|null} resolvesOriginalDay   Day of the
 *                                 missed lesson. null ⇒
 *                                 unlinked.
 * @property {string|null} resolvesOriginalTime  Time of the
 *                                 missed lesson. null ⇒
 *                                 unlinked.
 *                                 Contract: all four resolves_*
 *                                 are null together (unlinked)
 *                                 or all four populated (linked).
 *                                 Mixed states are not produced
 *                                 by any write path.
 * @property {boolean} madeUp      Whether the catchup has
 *                                 actually been delivered.
 *                                 Default false; flipped true
 *                                 when the slot is marked
 *                                 complete in the UI.
 * @property {string|null} notes   Optional free-text note.
 * @property {string} createdAt    ISO timestamp; server default
 *                                 now().
 * @property {string} updatedAt    ISO timestamp; app-managed on
 *                                 every upsert via the
 *                                 set_catchups_updated_at
 *                                 BEFORE-UPDATE trigger.
 */
