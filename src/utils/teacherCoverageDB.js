// ============================================================
// teacherCoverageDB.js — Supabase load/sync helpers for teacher_coverage
//
// Spec 2 Phase 1 cluster 4a — adds loadTeacherCoverageFromSupabase().
// Pure scaffolding wiring: App.js boot populates teacherCoverage state
// but no read/write site consumes it yet (4b/4c follow).
//
// syncTeacherCoverageToSupabase is deferred to cluster 9 (Add/Remove
// Staff UI), where lane mutations originate.
//
// Schema: scripts/diag/sql/spec-2-cluster-1-schema.sql, applied via
// Supabase dashboard during session 141 (7 May 2026). Project
// convention places schema on the dashboard, not in repo migrations
// (Phase 0 finding).
//
// Lane-ownership model (Spec 2 Phase 1):
//   - teacher_coverage row = lane = (school, day, teacher) tuple
//     as a first-class entity.
//   - Lessons reference lanes by bucket_id (added in cluster 4b/4c).
//   - Empty lanes are valid (Add-Staff-before-students workflow).
//   - Substitution arrives as a sibling lane_overrides table in
//     cluster 6.
//
// File-placement note:
//   The 16 existing *DB.js files in src/utils/ are the project
//   convention for Supabase read/write helpers. src/data/ is for
//   pipeline code (generators, parsers, export).
// ============================================================

import { supabase } from "../supabaseClient";

// ── Shape converter ──────────────────────────────────────────

function fromRow(row) {
  return {
    id:         row.id,
    userId:     row.user_id    || "",
    schoolId:   row.school_id  || "",
    day:        row.day        || "",
    teacherId:  row.teacher_id || "",
    status:     row.status     || "active",
    notes:      row.notes      || null,
    createdAt:  row.created_at || "",
    updatedAt:  row.updated_at || "",
  };
}

// ── Load ─────────────────────────────────────────────────────

// Loads only active lanes. Archived lanes remain queryable by ID for
// historical lessons that still carry their bucket_id, but the boot
// loader's working set is the active lane fleet.
//
// RLS scopes to auth.uid() = user_id (per the cluster 1 schema policy);
// no client-side .eq("user_id", ...) filter needed.
export async function loadTeacherCoverageFromSupabase() {
  const { data, error } = await supabase
    .from("teacher_coverage")
    .select("*")
    .eq("status", "active")
    .order("school_id")
    .order("day")
    .order("teacher_id");
  if (error) throw error;
  return (data || []).map(fromRow);
}

/**
 * Lane assignment — one teacher covers one (school, day) on a recurring
 * basis. Empty lanes (no lessons referencing the lane yet) are valid and
 * represent declared coverage before students are enrolled.
 *
 * @typedef {Object} TeacherCoverage
 * @property {string} id         Lane row id. Text, generated client-side
 *                               via the uid() helper (8-char base36),
 *                               matching the project pattern for
 *                               teachers/schools/students/etc.
 * @property {string} userId     auth.users.id (uuid).
 * @property {string} schoolId   schools.id (text — 8-char base36 from
 *                               uid(), e.g. "ykam9z1j").
 * @property {string} day        Day name, restricted to Monday–Friday.
 * @property {string} teacherId  teachers.id (text — same shape as
 *                               schoolId).
 * @property {'active'|'archived'} status  Lane lifecycle. New lanes
 *                               default 'active'. Archive when a term
 *                               locks (Refinement C past-term cache)
 *                               or a teacher's coverage on this
 *                               (school, day) ends. Archived rows
 *                               remain queryable so historical lessons
 *                               can still resolve their bucket_id.
 * @property {string|null} notes Optional lane-level note (e.g.
 *                               "covers Tuesdays except week 5").
 * @property {string} createdAt  ISO timestamp; server default now().
 * @property {string} updatedAt  ISO timestamp; app-managed on every
 *                               upsert, mirroring teachersDB.js /
 *                               schoolsDB.js pattern.
 */

// syncTeacherCoverageToSupabase lands in cluster 9 (Add/Remove Staff UI).
