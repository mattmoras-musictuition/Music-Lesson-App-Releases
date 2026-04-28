// ============================================================
// enrolmentsDB.js — Supabase load/sync for enrolments
// Pattern: same as studentsDB.js.
//
// loadEnrolmentsFromSupabase()             — read all rows for this user
// syncEnrolmentsToSupabase(enrolments, userId) — upsert all, delete removed
// ============================================================

import { supabase } from "../supabaseClient";

// ── Match a card's identity to an enrolment ──────────────────
// Returns the matching enrolment.id or null. Matching rule per
// SPEC 1 §5.2 Step C: studentId + instrument, plus groupId if
// the card is a group card.
export function enrolmentIdFor(studentId, instrument, enrolments, groupId) {
  const match = (enrolments || []).find(e =>
    e.studentId === studentId &&
    e.instrument === instrument &&
    (!groupId || e.groupId === groupId)
  );
  return match ? match.id : null;
}

// Stamp enrolmentId on every lesson in an array. Idempotent —
// re-stamping a stamped lesson resolves to the same id (or null
// if the underlying enrolment has been removed).
export function stampEnrolmentIds(lessons, enrolments) {
  return (lessons || []).map(l => ({
    ...l,
    enrolmentId: enrolmentIdFor(l.studentId, l.instrument, enrolments, l.groupId),
  }));
}

// ── DB row → camelCase JS object ─────────────────────────────
function rowToEnrolment(row) {
  return {
    id:         row.id,
    studentId:  row.student_id,
    instrument: row.instrument,
    teacherId:  row.teacher_id  || "",
    isGroup:    row.is_group    || false,
    groupId:    row.group_id    || undefined,
    startDate:  row.start_date,
    endDate:    row.end_date    || undefined,
  };
}

// ── camelCase JS object → DB row ─────────────────────────────
function enrolmentToRow(enrolment, userId) {
  return {
    id:         enrolment.id,
    user_id:    userId,
    student_id: enrolment.studentId  || "",
    instrument: enrolment.instrument || "",
    teacher_id: enrolment.teacherId  || null,
    is_group:   enrolment.isGroup    || false,
    group_id:   enrolment.groupId    || null,
    start_date: enrolment.startDate,
    end_date:   enrolment.endDate    || null,
  };
}

// ── Load all enrolments for the current user ────────────────
export async function loadEnrolmentsFromSupabase() {
  const { data, error } = await supabase
    .from("enrolments")
    .select("*")
    .order("student_id", { ascending: true })
    .order("instrument", { ascending: true });

  if (error) throw new Error(error.message);
  return (data || []).map(rowToEnrolment);
}

// ── Sync local enrolments array to Supabase ─────────────────
// Upserts all current enrolments, then deletes any rows in Supabase
// that are no longer in the local array (i.e. the enrolment was deleted).
export async function syncEnrolmentsToSupabase(enrolments, userId) {
  if (!userId) return;

  // 1. Upsert all current enrolments
  const rows = enrolments.map(e => enrolmentToRow(e, userId));
  const { error: upsertError } = await supabase
    .from("enrolments")
    .upsert(rows, { onConflict: "id" });

  if (upsertError) throw new Error(upsertError.message);

  // 2. Delete any Supabase rows whose id is not in the current local array
  const currentIds = enrolments.map(e => e.id);
  const { error: deleteError } = await supabase
    .from("enrolments")
    .delete()
    .eq("user_id", userId)
    .not("id", "in", `(${currentIds.join(",")})`);

  if (deleteError) throw new Error(deleteError.message);
}
