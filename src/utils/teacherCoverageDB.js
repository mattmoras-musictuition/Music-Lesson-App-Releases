// ============================================================
// teacherCoverageDB.js — Supabase load/sync helpers for teacher_coverage
//
// Spec 2 Phase 1 cluster 1 — scaffolding only. Read/write helpers
// arrive in cluster 5; this file currently establishes the JSDoc
// type definition.
//
// Schema: scripts/diag/sql/spec-2-cluster-1-schema.sql, applied via
// Supabase dashboard during session 141 (7 May 2026). Project
// convention places schema on the dashboard, not in repo migrations
// (Phase 0 finding).
//
// Lane-ownership model (Spec 2 Phase 1):
//   - teacher_coverage row = lane = (school, day, teacher) tuple
//     as a first-class entity.
//   - Lessons reference lanes by bucket_id (added in cluster 4).
//   - Empty lanes are valid (Add-Staff-before-students workflow).
//   - Substitution arrives as a sibling lane_overrides table in
//     cluster 6.
//
// File-placement note:
//   The 16 existing *DB.js files in src/utils/ are the project
//   convention for Supabase read/write helpers. src/data/ is for
//   pipeline code (generators, parsers, export).
// ============================================================

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
 * @property {string} userId     [auth.users.id](http://auth.users.id) (uuid).
 * @property {string} schoolId   [schools.id](http://schools.id) (text — 8-char base36 from
 *                               uid(), e.g. "ykam9z1j").
 * @property {string} day        Day name, restricted to Monday–Friday.
 * @property {string} teacherId  [teachers.id](http://teachers.id) (text — same shape as
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

// Read/write helpers (loadTeacherCoverageFromSupabase /
// syncTeacherCoverageToSupabase) land in cluster 5.
