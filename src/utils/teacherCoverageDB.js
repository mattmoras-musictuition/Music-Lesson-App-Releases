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

// ── Lookup helper ────────────────────────────────────────────

/**
 * Resolve the active lane id for a (school, day, teacher) tuple.
 * Returns null if no active lane covers that combination — consumers
 * MUST handle null (Phase 1 contract: missing-lane lessons skip with a
 * "no covering lane" reason and surface in the unscheduled array).
 *
 * @param {TeacherCoverage[]} teacherCoverage  All loaded lanes.
 * @param {string} schoolId
 * @param {string} day
 * @param {string} teacherId
 * @returns {string|null}
 */
export function findLaneId(teacherCoverage, schoolId, day, teacherId) {
  const lane = (teacherCoverage || []).find(
    l => l.schoolId === schoolId &&
         l.day === day &&
         l.teacherId === teacherId &&
         l.status === "active"
  );
  return lane ? lane.id : null;
}

/**
 * Read-side teacher resolution.
 * Cluster 6b1: override-first when week context provided (WTT callers) —
 *   a per-week (weekKey, bucketId) row in laneOverrides wins.
 * Cluster 5a: lane-first lookup as the fallback — bucket_id → teacher_coverage.
 * Returns null if the card has no bucket_id, no matching override or lane row
 * is found, or teacherCoverage isn't an array. Does NOT fall back to
 * lesson.teacherId — callers (e.g. getLiveTeacherId) own the Path-B fallback
 * chain.
 *
 * laneOverrides + weekKey default to null so MTT callers (no week context)
 * keep the cluster 5a behaviour unchanged.
 */
export function getCardTeacherId(lesson, teacherCoverage, laneOverrides = null, weekKey = null) {
  if (!lesson?.bucket_id) return null;
  if (Array.isArray(laneOverrides) && weekKey) {
    const override = laneOverrides.find(o => o.weekKey === weekKey && o.bucketId === lesson?.bucket_id);
    if (override?.overrideTeacherId) return override.overrideTeacherId;
  }
  if (!Array.isArray(teacherCoverage)) return null;
  const lane = teacherCoverage.find(l => l.id === lesson.bucket_id);
  return lane?.teacherId || null;
}

/**
 * Spec 2 cluster 7 — day-level lane resolution.
 * Returns the day's primary active lane row alongside the effective teacher
 * for that lane. The lane row carries the default teacher (lane.teacherId);
 * the effective teacher is override-aware when laneOverrides + weekKey are
 * provided — a (weekKey, bucketId) row's overrideTeacherId wins. When no
 * override applies, the effective teacher matches the lane teacher.
 *
 * Cluster 7 day headers consume `teacher` (override-aware on WTT, lane-only
 * on MTT). Cluster 11 card borders will read both — `lane.teacherId` for the
 * default border colour and `teacher.id` for the override-aware colour, with
 * divergence between the two surfacing the substitution at the card level.
 *
 * Multi-lane case (cluster 8a): picks the lane referenced by
 * viewedLanes[schoolId][day] when supplied AND that lane id is still in
 * the active set (defensive against deleted/archived lanes — covers
 * cluster 9's Remove Staff transition without special handling). Falls
 * back to the first-added active lane otherwise. When viewedLanes is
 * null (MTT, single-lane data, pre-cluster-8 callers), behaviour matches
 * cluster 7 — first-added active lane wins.
 *
 * @returns {{ lane, teacher } | null}  null when no active lane exists for
 *          (schoolId, day). `teacher` may be null if the resolved teacherId
 *          isn't in `teachers` (defensive).
 */
export function getDayLaneTeacher(teacherCoverage, teachers, schoolId, day, laneOverrides = null, weekKey = null, viewedLanes = null) {
  const dayLanes = (teacherCoverage || []).filter(
    l => l.schoolId === schoolId && l.day === day && l.status === "active"
  );
  if (dayLanes.length === 0) return null;
  const storedLaneId = viewedLanes?.[schoolId]?.[day];
  const lane = (storedLaneId && dayLanes.some(l => l.id === storedLaneId))
    ? dayLanes.find(l => l.id === storedLaneId)
    : dayLanes[0];
  let effectiveTeacherId = lane.teacherId;
  if (Array.isArray(laneOverrides) && weekKey) {
    const override = laneOverrides.find(o => o.weekKey === weekKey && o.bucketId === lane.id);
    if (override?.overrideTeacherId) effectiveTeacherId = override.overrideTeacherId;
  }
  const teacher = (teachers || []).find(t => t.id === effectiveTeacherId) || null;
  return { lane, teacher };
}

// syncTeacherCoverageToSupabase lands in cluster 9 (Add/Remove Staff UI).
