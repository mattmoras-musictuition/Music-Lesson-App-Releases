// ============================================================
// tallyEntriesDB.js
// Supabase load/sync for the tallyEntries collection.
// Migration added: session 21
//
// Note: tally entries grow over time (one per lesson per week).
// The sync uses the same upsert+delete pattern as other collections.
// studentNames is stored as JSONB.
// ============================================================

import { supabase } from "../supabaseClient";

// ---- LOAD ----
// Reads all tally entry rows for the current user from Supabase.
// Returns an array of camelCase tally entry objects, or null on error.
export async function loadTallyEntriesFromSupabase(userId) {
  let query = supabase
    .from("tally_entries")
    .select("*")
    .order("week_key")
    .order("day")
    .order("student_name");

  if (userId) query = query.eq("user_id", userId);

  const { data, error } = await query;

  if (error) {
    console.error("loadTallyEntriesFromSupabase error:", error);
    return null;
  }

  return data.map((row) => ({
    id:             row.id,
    lessonKey:      row.lesson_key,
    lessonId:       row.lesson_id,
    isGroup:        row.is_group,
    groupName:      row.group_name,
    studentId:      row.student_id,
    studentName:    row.student_name,
    studentNames:   row.student_names || [],
    instrument:     row.instrument,
    schoolId:       row.school_id,
    teacherId:      row.teacher_id,
    teacherName:    row.teacher_name,
    weekKey:        row.week_key,
    weekLabel:      row.week_label,
    weekNum:        row.week_num,
    termKey:        row.term_key,
    day:            row.day,
    status:         row.status,
    reason:         row.reason,
    notes:          row.notes,
    makeupEligible: row.makeup_eligible,
    madeUp:         row.made_up,
    autoRecorded:   row.auto_recorded,
    recordedAt:     row.recorded_at,
  }));
}

// ---- SYNC ----
// Upserts all current tally entries for this user, then deletes
// any rows in Supabase that are no longer in the local array.
export async function syncTallyEntriesToSupabase(tallyEntries, userId) {
  if (!userId) return;

  // Upsert all current entries (in batches of 500 to avoid request size limits)
  if (tallyEntries.length > 0) {
    const rows = tallyEntries.map((e) => ({
      id:              e.id,
      user_id:         userId,
      lesson_key:      e.lessonKey      || "",
      lesson_id:       e.lessonId       || "",
      is_group:        e.isGroup        || false,
      group_name:      e.groupName      || "",
      student_id:      e.studentId      || "",
      student_name:    e.studentName    || "",
      student_names:   e.studentNames   || [],
      instrument:      e.instrument     || "",
      school_id:       e.schoolId       || "",
      teacher_id:      e.teacherId      || "",
      teacher_name:    e.teacherName    || "",
      week_key:        e.weekKey        || "",
      week_label:      e.weekLabel      || "",
      week_num:        e.weekNum        ?? null,
      term_key:        e.termKey        || "",
      day:             e.day            || "",
      status:          e.status         || "",
      reason:          e.reason         ?? null,
      notes:           e.notes          || "",
      makeup_eligible: e.makeupEligible || false,
      made_up:         e.madeUp         || false,
      auto_recorded:   e.autoRecorded   || false,
      recorded_at:     e.recordedAt     || "",
    }));

    // Batch upserts in chunks of 500
    const BATCH_SIZE = 500;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error: upsertError } = await supabase
        .from("tally_entries")
        .upsert(batch, { onConflict: "id" });

      if (upsertError) {
        console.error("syncTallyEntriesToSupabase upsert error:", upsertError);
        return;
      }
    }
  }

  // Delete rows that no longer exist locally
  const currentIds = new Set(tallyEntries.map((e) => e.id));
  const { data: remoteRows, error: fetchError } = await supabase
    .from("tally_entries")
    .select("id")
    .eq("user_id", userId);

  if (fetchError) {
    console.error("syncTallyEntriesToSupabase fetch error:", fetchError);
    return;
  }

  const toDelete = remoteRows
    .map((r) => r.id)
    .filter((id) => !currentIds.has(id));

  if (toDelete.length > 0) {
    // Batch deletes too, just in case
    const BATCH_SIZE = 500;
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const batch = toDelete.slice(i, i + BATCH_SIZE);
      const { error: deleteError } = await supabase
        .from("tally_entries")
        .delete()
        .in("id", batch);

      if (deleteError) {
        console.error("syncTallyEntriesToSupabase delete error:", deleteError);
      }
    }
  }
}
