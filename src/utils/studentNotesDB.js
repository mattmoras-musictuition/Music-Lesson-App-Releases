// ============================================================
// studentNotesDB.js — Supabase data-access for the Student Notes
// feature (cluster 1 foundation).
//
// Thin accessors over the three Student Notes tables that landed on
// the Supabase dashboard during cluster 1: student_notes,
// student_note_attachments, teacher_pinned_subjects (RLS enabled,
// added to the supabase_realtime publication). Project convention
// places schema on the dashboard, not in repo migrations (Phase 0
// finding); this module is the read/write surface both the admin
// app and the teacher app consume from cluster 2 onward.
//
// Spec: /Users/mattmoras/teacher app docs/STUDENT_NOTES/STUDENT_NOTES_SPEC.md
//
// Column-name note: the canonical week-key column is `week_key`; the
// JS param is `weekKey` to match the spec's util contract. `term_id`
// is text + nullable (there is no terms table in this project — terms
// are derived client-side in termWeeks.js).
//
// Identity is NOT resolved here. Pin helpers take teacherId from the
// caller, mirroring the existing *DB.js pattern (userId/teacherId is
// always passed in — see teachersDB.syncTeachersToSupabase,
// teacherCoverageDB.insertTeacherCoverage).
//
// v1 (cluster 1) deliberately stops here:
//   - No realtime subscription helpers — cluster 4 (note editing /
//     multi-author live sync).
//   - No admin-as-author handling — cluster 7 (admin app mirror).
//   - No attachment storage (upload/remove) helpers — cluster 5;
//     reads embed attachment rows via the FK join only.
// ============================================================

import { supabase } from "../supabaseClient";

// ── Shape converters (snake_case row → camelCase) ────────────

function attachmentFromRow(row) {
  return {
    id:            row.id,
    noteId:        row.note_id,
    kind:          row.kind,
    storagePath:   row.storage_path    || null,
    fileName:      row.file_name       || null,
    fileSizeBytes: row.file_size_bytes ?? null,
    mimeType:      row.mime_type       || null,
    url:           row.url             || null,
    pageTitle:     row.page_title      || null,
    createdAt:     row.created_at      || "",
  };
}

function noteFromRow(row) {
  return {
    id:          row.id,
    subjectType: row.subject_type,
    subjectId:   row.subject_id,
    weekKey:     row.week_key,
    termId:      row.term_id     || null,
    authorId:    row.author_id,
    body:        row.body        || {},
    createdAt:   row.created_at  || "",
    updatedAt:   row.updated_at  || "",
    attachments: (row.student_note_attachments || []).map(attachmentFromRow),
  };
}

function pinFromRow(row) {
  return {
    teacherId:   row.teacher_id,
    subjectType: row.subject_type,
    subjectId:   row.subject_id,
    pinnedAt:    row.pinned_at || "",
  };
}

// ── Notes reads ──────────────────────────────────────────────

/**
 * All notes for a subject, newest week first, each with its
 * attachments embedded via the student_note_attachments FK join.
 *
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId  students.id (solo) or groups.id (group)
 * @returns {Promise<Array>} camelCase note objects (see noteFromRow)
 */
export async function getNotesForSubject(subjectType, subjectId) {
  const { data, error } = await supabase
    .from("student_notes")
    .select("*, student_note_attachments(*)")
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .order("week_key", { ascending: false });
  if (error) throw error;
  return (data || []).map(noteFromRow);
}

/**
 * Notes for one subject+week — one row per author (the
 * (subject_type, subject_id, week_key, author_id) unique key).
 * Ordered by created_at ascending so multi-author week cards stack
 * oldest-first (spec §4.1.2).
 *
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId
 * @param {string} weekKey  matched against the week_key column
 * @returns {Promise<Array>} camelCase note objects
 */
export async function getNotesForWeek(subjectType, subjectId, weekKey) {
  const { data, error } = await supabase
    .from("student_notes")
    .select("*, student_note_attachments(*)")
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .eq("week_key", weekKey)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(noteFromRow);
}

// ── Pinning ──────────────────────────────────────────────────

/**
 * Idempotent pin. Upserts on the composite PK so re-pinning an
 * already-pinned subject is a no-op (pinned_at is left to the DB
 * default on first insert and untouched on conflict).
 *
 * @param {string} teacherId
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId
 */
export async function pinSubject(teacherId, subjectType, subjectId) {
  const { error } = await supabase
    .from("teacher_pinned_subjects")
    .upsert(
      { teacher_id: teacherId, subject_type: subjectType, subject_id: subjectId },
      { onConflict: "teacher_id,subject_type,subject_id" }
    );
  if (error) throw error;
}

/**
 * Remove a pin by its full composite key.
 *
 * @param {string} teacherId
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId
 */
export async function unpinSubject(teacherId, subjectType, subjectId) {
  const { error } = await supabase
    .from("teacher_pinned_subjects")
    .delete()
    .match({ teacher_id: teacherId, subject_type: subjectType, subject_id: subjectId });
  if (error) throw error;
}

/**
 * Whether the subject is currently pinned by this teacher.
 *
 * @param {string} teacherId
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId
 * @returns {Promise<boolean>}
 */
export async function isPinned(teacherId, subjectType, subjectId) {
  const { data, error } = await supabase
    .from("teacher_pinned_subjects")
    .select("teacher_id")
    .match({ teacher_id: teacherId, subject_type: subjectType, subject_id: subjectId })
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/**
 * All pins for a teacher, most-recently-pinned first. Convenience
 * for cluster 2's left-panel "Pinned" section.
 *
 * @param {string} teacherId
 * @returns {Promise<Array>} camelCase pin rows (see pinFromRow)
 */
export async function getMyPinnedSubjects(teacherId) {
  const { data, error } = await supabase
    .from("teacher_pinned_subjects")
    .select("*")
    .eq("teacher_id", teacherId)
    .order("pinned_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(pinFromRow);
}

// ── Shared class-sort helper ─────────────────────────────────
//
// Lives here per the cluster 1 dispatch default: no existing
// class-name / year-level sort helper exists anywhere in src/utils
// (grep-confirmed), so there was no more-natural home. Both apps'
// list panels (cluster 2) consume this; if a broader class-handling
// util emerges later it can move with the callers updated.

/**
 * Sort key for class names, per spec §6. Prep/Foundation (names
 * starting P or F) rank first, then numeric grades by number then
 * suffix, then anything else. Use as an Array.prototype.sort key.
 *
 * @param {string} className
 * @returns {Array} comparator key (lexicographically comparable)
 */
export function classSortKey(className) {
  if (/^[PpFf]/.test(className)) {
    return [0, className.toLowerCase()];
  }
  const m = className.match(/^(\d+)(.*)$/);
  if (m) {
    return [1, parseInt(m[1], 10), m[2].toLowerCase()];
  }
  return [2, className.toLowerCase()];
}
