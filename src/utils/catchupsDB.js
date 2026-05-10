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
import { uid } from "./helpers";

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

// ── Allow-list mapper (camelCase → snake_case) ───────────────

// Opposite of fromRow. Maps a partial Catchup object to a row
// payload for insert/update. Skips fields whose value is `undefined`
// (caller did not intend to set); passes `null` through (caller
// intends to clear a nullable field). user_id is omitted —
// insertCatchup attaches it separately from supabase.auth.getUser();
// update/delete rely on RLS ownership. created_at / updated_at are
// server-managed.
function toRow(catchup) {
  const out = {};
  if (catchup.id                   !== undefined) out.id                     = catchup.id;
  if (catchup.schoolId             !== undefined) out.school_id              = catchup.schoolId;
  if (catchup.weekKey              !== undefined) out.week_key               = catchup.weekKey;
  if (catchup.day                  !== undefined) out.day                    = catchup.day;
  if (catchup.time                 !== undefined) out.time                   = catchup.time;
  if (catchup.durationMinutes      !== undefined) out.duration_minutes       = catchup.durationMinutes;
  if (catchup.instrument           !== undefined) out.instrument             = catchup.instrument;
  if (catchup.enrolmentId          !== undefined) out.enrolment_id           = catchup.enrolmentId;
  if (catchup.resolvesEnrolmentId  !== undefined) out.resolves_enrolment_id  = catchup.resolvesEnrolmentId;
  if (catchup.resolvesWeekKey      !== undefined) out.resolves_week_key      = catchup.resolvesWeekKey;
  if (catchup.resolvesOriginalDay  !== undefined) out.resolves_original_day  = catchup.resolvesOriginalDay;
  if (catchup.resolvesOriginalTime !== undefined) out.resolves_original_time = catchup.resolvesOriginalTime;
  if (catchup.madeUp               !== undefined) out.made_up                = catchup.madeUp;
  if (catchup.notes                !== undefined) out.notes                  = catchup.notes;
  return out;
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

// ── Write helpers (cluster 5a — UI plumbing) ─────────────────

/**
 * Insert a single catchup row. Resolves the authenticated user via
 * supabase.auth.getUser() and attaches user_id. Mints a fresh id via
 * the canonical uid() helper if the caller did not supply one.
 *
 * Throws with enriched supabase error detail (.message + .code +
 * .details + .hint) per the cluster 3 banked pattern.
 *
 * @param {Catchup} catchup  Partial Catchup; missing fields default
 *                           per the schema (e.g. madeUp → false,
 *                           created_at/updated_at server-managed).
 * @returns {Promise<Catchup>}  The inserted row in fromRow shape.
 */
export async function insertCatchup(catchup) {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user?.id) throw new Error("insertCatchup: not authenticated");
  const id = catchup.id || uid();
  const row = { ...toRow(catchup), id, user_id: user.id };
  const { data, error } = await supabase
    .from("catchups")
    .insert(row)
    .select()
    .single();
  if (error) {
    throw new Error(`insertCatchup failed: ${error.message} (code=${error.code}, details=${error.details}, hint=${error.hint})`);
  }
  return fromRow(data);
}

/**
 * Update a single catchup row by id. Caller passes only the fields
 * to change; toRow's allow-list filters undefined values out so an
 * UPDATE never sends spurious columns. RLS scopes the UPDATE by
 * auth.uid() = user_id (cluster 1's policy), so no client-side
 * user_id filter is needed.
 *
 * Throws "updateCatchup: no fields to update" if the toRow payload
 * is empty (defensive — catches caller mistakes). Throws with
 * enriched supabase error detail per the cluster 3 banked pattern.
 *
 * @param {string} id
 * @param {Partial<Catchup>} fields
 * @returns {Promise<Catchup>}  The updated row in fromRow shape.
 */
export async function updateCatchup(id, fields) {
  const row = toRow(fields);
  if (Object.keys(row).length === 0) {
    throw new Error("updateCatchup: no fields to update");
  }
  const { data, error } = await supabase
    .from("catchups")
    .update(row)
    .eq("id", id)
    .select()
    .single();
  if (error) {
    throw new Error(`updateCatchup failed: ${error.message} (code=${error.code}, details=${error.details}, hint=${error.hint})`);
  }
  return fromRow(data);
}

/**
 * Delete a single catchup row by id. RLS scopes the DELETE by
 * auth.uid() = user_id (cluster 1's policy), so no client-side
 * user_id filter is needed.
 *
 * Throws with enriched supabase error detail per the cluster 3
 * banked pattern.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteCatchup(id) {
  const { error } = await supabase
    .from("catchups")
    .delete()
    .eq("id", id);
  if (error) {
    throw new Error(`deleteCatchup failed: ${error.message} (code=${error.code}, details=${error.details}, hint=${error.hint})`);
  }
}
