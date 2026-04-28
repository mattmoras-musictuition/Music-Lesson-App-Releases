// ============================================================
// studentsDB.js — Supabase load/sync for students
// Pattern: same as schoolsDB.js and teachersDB.js
//
// loadStudentsFromSupabase()          — read all rows for this user
// syncStudentsToSupabase(students, userId) — upsert all, delete removed
// ============================================================

import { supabase } from "../supabaseClient";

// ── DB row → camelCase JS object ─────────────────────────────
function rowToStudent(row) {
  return {
    id:                   row.id,
    name:                 row.name,
    schoolId:             row.school_id,
    className:            row.class_name,
    instruments:          row.instruments          || [],
    status:               row.status,
    notes:                row.notes                || "",
    outsideClassOnly:     row.outside_class_only   || false,
    outsideClassPreferred: row.outside_class_preferred || false,
    availableBefore:      row.available_before     || false,
    availableAfter:       row.available_after      || false,
    avoidTimes:           row.avoid_times          || [],
    preferredTimes:       row.preferred_times      || [],
    parents:              row.parents              || [],
  };
}

// ── camelCase JS object → DB row ─────────────────────────────
function studentToRow(student, userId) {
  return {
    id:                     student.id,
    user_id:                userId,
    name:                   student.name                   || "",
    school_id:              student.schoolId               || "",
    class_name:             student.className              || "",
    instruments:            student.instruments            || [],
    status:                 student.status                 || "active",
    notes:                  student.notes                  || "",
    outside_class_only:     student.outsideClassOnly       || false,
    outside_class_preferred: student.outsideClassPreferred || false,
    available_before:       student.availableBefore        || false,
    available_after:        student.availableAfter         || false,
    avoid_times:            student.avoidTimes             || [],
    preferred_times:        student.preferredTimes         || [],
    parents:                student.parents                || [],
  };
}

// ── Load all students for the current user ───────────────────
export async function loadStudentsFromSupabase() {
  const { data, error } = await supabase
    .from("students")
    .select("*")
    .order("name", { ascending: true });

  if (error) throw new Error(error.message);
  return (data || []).map(rowToStudent);
}

// ── Sync local students array to Supabase ────────────────────
// Upserts all current students, then deletes any rows in Supabase
// that are no longer in the local array (i.e. the student was deleted).
export async function syncStudentsToSupabase(students, userId) {
  if (!userId) return;

  // 1. Upsert all current students
  const rows = students.map(s => studentToRow(s, userId));
  const { error: upsertError } = await supabase
    .from("students")
    .upsert(rows, { onConflict: "id" });

  if (upsertError) throw new Error(upsertError.message);

  // 2. Delete any Supabase rows whose id is not in the current local array
  const currentIds = students.map(s => s.id);
  const { error: deleteError } = await supabase
    .from("students")
    .delete()
    .eq("user_id", userId)
    .not("id", "in", `(${currentIds.join(",")})`);

  if (deleteError) throw new Error(deleteError.message);
}
