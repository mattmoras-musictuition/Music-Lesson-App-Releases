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
import { uid, isPastWeek } from "./helpers";

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
// Cluster 9a (Q9 fix): created_at-asc tiebroken by id gives a stable
// "first-added on left" ordering — surfaced via cluster 8 chips and
// the dayLanes[0] default in getDayLaneTeacher / displayLessons /
// filteredLessons. Cluster 4a originally sorted by teacher_id as a
// placeholder before insertion order mattered.
export async function loadTeacherCoverageFromSupabase() {
  const { data, error } = await supabase
    .from("teacher_coverage")
    .select("*")
    .eq("status", "active")
    .order("school_id")
    .order("day")
    .order("created_at", { ascending: true })
    .order("id");
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
 *
 * Phase 1 (bucket_id direct) — canonical fast path:
 *   Cluster 6b1: override-first when week context provided (WTT callers) —
 *     a per-week (weekKey, bucketId) row in laneOverrides wins.
 *   Cluster 5a: lane-first lookup — bucket_id → teacher_coverage.
 *
 * Phase 2 (day-lane fallback) — Session 3 / C8:
 *   For cards without bucket_id (legacy MTT data pre-dating bucket_id
 *   stamping) OR cards whose bucket_id no longer resolves (lane archived),
 *   fall back to the first active lane at (lesson.schoolId, lesson.day).
 *   Same pattern as the enrichedCatchups mapper (commit c68a11b,
 *   SPEC_3_LANE_TEACHER_DISPLAY_ADDENDUM). Override-aware against the
 *   resolved lane's id when (laneOverrides, weekKey) are supplied.
 *
 * Returns null only when neither phase resolves a teacher. Does NOT fall
 * back to lesson.teacherId — both phases are lane-derived.
 *
 * laneOverrides + weekKey default to null so MTT callers (no week context)
 * keep the cluster 5a behaviour unchanged for resolved cards.
 *
 * Frozen-teacher preference (2.12.0 batch) — for PAST weeks ONLY:
 *   Finished weeks must stop recomputing their teacher from today's lanes (a
 *   staff day-change otherwise reaches backwards and "unassigns" past lessons).
 *   Precedence for a past week: (1) a per-week override on THIS lesson's lane
 *   still wins — a recorded cover must keep showing the substitute; (2) else the
 *   lesson's stamped frozenTeacherId (the locked historical teacher) is used;
 *   (3) else fall through to the live lane logic below. Current/future weeks and
 *   weekKey-less (MTT) callers skip this block and resolve live as before, so
 *   they keep following the current setup until they age into the past.
 */
export function getCardTeacherId(lesson, teacherCoverage, laneOverrides = null, weekKey = null) {
  if (!Array.isArray(teacherCoverage)) return null;

  // Frozen-teacher preference — past weeks only (see doc comment above).
  if (weekKey && isPastWeek(weekKey)) {
    if (lesson?.bucket_id && Array.isArray(laneOverrides)) {
      const override = laneOverrides.find(o => o.weekKey === weekKey && o.bucketId === lesson.bucket_id);
      if (override?.overrideTeacherId) return override.overrideTeacherId; // (1) cover wins
    }
    if (lesson?.frozenTeacherId) return lesson.frozenTeacherId;            // (2) locked teacher
    // (3) no override, no stamp (e.g. unstamped band session) → fall through to live.
  }

  // Phase 1 — bucket_id direct resolution.
  if (lesson?.bucket_id) {
    if (Array.isArray(laneOverrides) && weekKey) {
      const override = laneOverrides.find(o => o.weekKey === weekKey && o.bucketId === lesson.bucket_id);
      if (override?.overrideTeacherId) return override.overrideTeacherId;
    }
    const lane = teacherCoverage.find(l => l.id === lesson.bucket_id);
    if (lane?.teacherId) return lane.teacherId;
  }

  // Phase 2 — day-lane fallback for legacy/orphan cards.
  if (lesson?.schoolId && lesson?.day) {
    const dayLane = teacherCoverage.find(
      l => l.schoolId === lesson.schoolId &&
           l.day === lesson.day &&
           l.status === "active"
    );
    if (dayLane) {
      if (Array.isArray(laneOverrides) && weekKey) {
        const override = laneOverrides.find(o => o.weekKey === weekKey && o.bucketId === dayLane.id);
        if (override?.overrideTeacherId) return override.overrideTeacherId;
      }
      return dayLane.teacherId || null;
    }
  }

  return null;
}

/**
 * Temporary-lanes session 2 — shared day-lane enumerator.
 *
 * Returns every lane on (schoolId, day) for the given week: the
 * active permanent teacher_coverage lanes plus, when a weekKey
 * is supplied, any temporary lanes whose row matches (schoolId,
 * day, weekKey). Temporary lanes are synthesised into the same
 * camelCase shape teacher_coverage lanes use — status:"active"
 * is required because getDayLaneTeacher and the day-header chip
 * strip both filter on it — plus an informational
 * isTemporary:true flag (no styling differentiation; per the UX
 * choice temp lanes look identical to permanent lanes).
 *
 * When weekKey is null or temporaryLanes is empty, the permanent
 * set is returned unchanged, so every pre-session-2 caller
 * behaves exactly as before.
 *
 * Consolidates a (schoolId, day, active) predicate that was
 * duplicated across getDayLaneTeacher and three inline
 * WeeklyAdjustments call sites, mirroring the Spec 2 cluster 13b
 * lessonBelongsToViewedLane consolidation precedent.
 *
 * @returns {Array} permanent + temporary lane objects.
 */
export function getDayLanes(teacherCoverage, schoolId, day, temporaryLanes = [], weekKey = null) {
  const permanent = (teacherCoverage || []).filter(
    l => l.schoolId === schoolId && l.day === day && l.status === "active"
  );
  if (!weekKey || !Array.isArray(temporaryLanes) || temporaryLanes.length === 0) {
    return permanent;
  }
  const temp = temporaryLanes
    .filter(t => t.schoolId === schoolId && t.day === day && t.weekKey === weekKey)
    .map(t => ({
      id: t.id,
      userId: t.userId,
      schoolId: t.schoolId,
      day: t.day,
      teacherId: t.teacherId,
      status: "active",
      notes: null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      isTemporary: true,
    }));
  return [...permanent, ...temp];
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
 * Temporary-lanes session 2: a trailing `temporaryLanes` arg is
 * unioned into the enumeration via getDayLanes when weekKey is
 * supplied — temp lanes participate in the pick-one rule equally.
 *
 * @returns {{ lane, teacher } | null}  null when no active lane exists for
 *          (schoolId, day). `teacher` may be null if the resolved teacherId
 *          isn't in `teachers` (defensive).
 */
export function getDayLaneTeacher(teacherCoverage, teachers, schoolId, day, laneOverrides = null, weekKey = null, viewedLanes = null, temporaryLanes = []) {
  const dayLanes = getDayLanes(teacherCoverage, schoolId, day, temporaryLanes, weekKey);
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

/**
 * Spec 2 cluster 13b — viewed-lane membership predicate.
 * Returns true if the lesson belongs to the day's currently viewed lane (or if
 * the day is single-lane / zero-lane — both pass through to preserve the
 * pre-cluster-13 behaviour at every call site).
 *
 * Multi-lane resolution: viewedLanes[schoolId][day] selects the active lane;
 * falls back to the first-added active lane when the stored id is missing or
 * has been archived. Legacy cards without bucket_id bind to the first-added
 * lane (post-cluster-12 effectively unreachable).
 *
 * Caller passes schoolId explicitly — most sites use selectedSchool, but the
 * MTT cross-school day-header aggregation (TimetableView) passes l.schoolId
 * per-lesson because MTT spans schools when no school is selected.
 */
export function lessonBelongsToViewedLane(lesson, viewedLanes, teacherCoverage, schoolId) {
  const dayLanes = (teacherCoverage || []).filter(c => c.schoolId === schoolId && c.day === lesson.day && c.status === "active");
  if (dayLanes.length < 2) return true;
  const storedLaneId = viewedLanes?.[schoolId]?.[lesson.day];
  const targetLaneId = (storedLaneId && dayLanes.some(c => c.id === storedLaneId)) ? storedLaneId : dayLanes[0].id;
  if (lesson.bucket_id) return lesson.bucket_id === targetLaneId;
  return targetLaneId === dayLanes[0].id;
}

// ── Write helpers (cluster 9 — Add/Remove Staff UI) ─────────

/**
 * Single-row insert. Generates a fresh client-side uid() for the row id
 * and writes status='active' (RLS-scoped to auth.uid() = user_id). Throws
 * if userId is falsy. Returns a camelCase row shape matching fromRow's
 * contract so callers can splice the new lane into local teacherCoverage
 * state without re-fetching.
 *
 * Cluster 9a lands this; cluster 9b adds archiveTeacherCoverage alongside
 * the Remove Staff flow.
 *
 * Safe under the dev Proxy short-circuit: the supabase.from() call is
 * suppressed in dev, but the returned object is built from the inputs,
 * so local-state updates work in both dev and prod.
 */
export async function insertTeacherCoverage({ schoolId, day, teacherId, userId }) {
  if (!userId) throw new Error("No user ID — cannot insert teacher coverage");
  const id = uid();
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("teacher_coverage")
    .insert({ id, user_id: userId, school_id: schoolId, day, teacher_id: teacherId, status: "active" });
  if (error) throw error;
  return { id, userId, schoolId, day, teacherId, status: "active", notes: null, createdAt: nowIso, updatedAt: nowIso };
}

/**
 * Single-row archive — flips status to 'archived' + bumps updated_at.
 * Mirrors deleteLaneOverride's surgical shape (the closer sibling — both are
 * "remove from active set" operations). Returns void; caller updates local
 * state independently. RLS scopes UPDATE by auth.uid() = user_id; no
 * client-side guard needed beyond the existing user-presence check at the
 * caller.
 *
 * Safe under the dev Proxy short-circuit: the supabase.from() call is
 * suppressed in dev; the void return means caller's local-state filter
 * fires unconditionally — correct in both dev and prod.
 *
 * Cluster 9b — Remove Staff UI.
 */
export async function archiveTeacherCoverage({ id }) {
  const { error } = await supabase
    .from("teacher_coverage")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}
