// ============================================================
// specialistsDB.js
// Supabase load/sync for the specialists collection.
// Migration added: session 21
// ============================================================

import { supabase } from "../supabaseClient";

// ---- LOAD ----
// Reads all specialist rows for the current user from Supabase.
// Returns an array of camelCase specialist objects, or null on error.
export async function loadSpecialistsFromSupabase() {
  const { data, error } = await supabase
    .from("specialists")
    .select("*")
    .order("school_id")
    .order("day")
    .order("start_time");

  if (error) {
    console.error("loadSpecialistsFromSupabase error:", error);
    return null;
  }

  return data.map((row) => ({
    id:        row.id,
    schoolId:  row.school_id,
    className: row.class_name,
    day:       row.day,
    start:     row.start_time,
    end:       row.end_time,
    subject:   row.subject,
    notes:     row.notes,
  }));
}

// ---- SYNC ----
// Upserts all current specialist entries for this user, then deletes
// any rows in Supabase that are no longer in the local array.
export async function syncSpecialistsToSupabase(specialists, userId) {
  if (!userId) return;

  // Upsert all current entries
  if (specialists.length > 0) {
    const rows = specialists.map((s) => ({
      id:         s.id,
      user_id:    userId,
      school_id:  s.schoolId  || "",
      class_name: s.className || "",
      day:        s.day       || "",
      start_time: s.start     || "",
      end_time:   s.end       || "",
      subject:    s.subject   || "",
      notes:      s.notes     || "",
    }));

    const { error: upsertError } = await supabase
      .from("specialists")
      .upsert(rows, { onConflict: "id" });

    if (upsertError) {
      console.error("syncSpecialistsToSupabase upsert error:", upsertError);
      return;
    }
  }

  // Delete rows that no longer exist locally
  const currentIds = specialists.map((s) => s.id);
  const { data: remoteRows, error: fetchError } = await supabase
    .from("specialists")
    .select("id")
    .eq("user_id", userId);

  if (fetchError) {
    console.error("syncSpecialistsToSupabase fetch error:", fetchError);
    return;
  }

  const toDelete = remoteRows
    .map((r) => r.id)
    .filter((id) => !currentIds.includes(id));

  if (toDelete.length > 0) {
    const { error: deleteError } = await supabase
      .from("specialists")
      .delete()
      .in("id", toDelete);

    if (deleteError) {
      console.error("syncSpecialistsToSupabase delete error:", deleteError);
    }
  }
}
