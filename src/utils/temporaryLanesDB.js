// ============================================================
// temporaryLanesDB.js — Supabase load/write helpers for
// temporary_lanes
//
// Admin app temporary-lanes workstream, session 2 of 3.
//
// A temporary lane is a one-week-only lane on a (school, day)
// that has no permanent teacher_coverage row. For week W and
// (school S, day D), a row matching (school_id=S, day=D,
// week_key=W) makes that teacher's lane display in the day
// header identically to a permanent lane — for week W only.
//
// Add/remove only — there is no updateTemporaryLane (a temp
// lane is deleted and re-added rather than edited), so the
// insert helper follows teacherCoverageDB.insertTeacherCoverage's
// build-from-inputs shape rather than catchupsDB's dev-Proxy
// synthesis branch.
//
// Schema applied via the Supabase dashboard during session 1
// (18 May 2026): public.temporary_lanes, 8 columns, RLS, 4
// indexes, 1 updated_at trigger. Project convention places
// schema on the dashboard, not in repo migrations (Phase 0
// finding).
// ============================================================

import { supabase } from "../supabaseClient";
import { uid } from "./helpers";

// ── Shape converter ──────────────────────────────────────────

// userId is exposed (unlike laneOverridesDB/catchupsDB, which
// drop user_id as an RLS detail) because the day-header lane
// enumeration synthesises temp lanes into the same camelCase
// shape teacher_coverage lanes use, which includes userId.
function fromRow(row) {
  return {
    id:         row.id,
    userId:     row.user_id    || "",
    schoolId:   row.school_id  || "",
    day:        row.day        || "",
    weekKey:    row.week_key   || "",
    teacherId:  row.teacher_id || "",
    createdAt:  row.created_at || "",
    updatedAt:  row.updated_at || "",
  };
}

// ── Allow-list mapper (camelCase → snake_case) ───────────────

// Opposite of fromRow for the write path. Skips fields whose
// value is `undefined` (caller did not intend to set); passes
// `null` through. Excludes id (set explicitly at insert) and
// user_id (RLS-attached from the caller-supplied userId arg).
function toRow(lane) {
  const out = {};
  if (lane.schoolId  !== undefined) out.school_id  = lane.schoolId;
  if (lane.day       !== undefined) out.day        = lane.day;
  if (lane.weekKey   !== undefined) out.week_key   = lane.weekKey;
  if (lane.teacherId !== undefined) out.teacher_id = lane.teacherId;
  return out;
}

// ── Load ─────────────────────────────────────────────────────

// RLS scopes to auth.uid() = user_id (per the session 1 schema
// policy); no client-side .eq("user_id", ...) filter needed.
// created_at-asc gives a stable insertion-order walk, matching
// teacherCoverageDB's lane ordering convention.
export async function loadTemporaryLanesFromSupabase() {
  const { data, error } = await supabase
    .from("temporary_lanes")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(fromRow);
}

// ── Write helpers ────────────────────────────────────────────

/**
 * Single-row insert. Mints a fresh client-side uid() for the row
 * id when absent (RLS-scoped to auth.uid() = user_id). Throws if
 * userId is falsy. Returns a camelCase row shape matching
 * fromRow's contract so callers can splice the new lane into
 * local temporaryLanes state without re-fetching.
 *
 * Build-from-inputs (no .select() round-trip): mirrors
 * teacherCoverageDB.insertTeacherCoverage. Safe under the dev
 * Proxy short-circuit — the supabase.from() call is suppressed
 * in dev, but the returned object is built from the inputs, so
 * local-state updates work in both dev and prod.
 */
export async function insertTemporaryLane({ userId, id, ...fields }) {
  if (!userId) throw new Error("No user ID — cannot insert temporary lane");
  const finalId = id || uid();
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("temporary_lanes")
    .insert({ id: finalId, user_id: userId, ...toRow(fields) });
  if (error) throw error;
  return {
    id: finalId,
    userId,
    schoolId: fields.schoolId || "",
    day: fields.day || "",
    weekKey: fields.weekKey || "",
    teacherId: fields.teacherId || "",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Single-row delete by id. Throws on supabase error. Returns
 * void; caller updates local state independently. RLS scopes
 * DELETE by auth.uid() = user_id.
 */
export async function deleteTemporaryLane({ id }) {
  const { error } = await supabase
    .from("temporary_lanes")
    .delete()
    .eq("id", id);
  if (error) throw error;
}
