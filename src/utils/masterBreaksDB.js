// ============================================================
// masterBreaksDB.js
// Supabase load/sync for the masterBreaks collection.
// Migration added: session 21
// ============================================================

import { supabase } from "../supabaseClient";

// ---- LOAD ----
// Reads all master_break rows for the current user from Supabase.
// Returns an array of camelCase break objects, or null on error.
export async function loadMasterBreaksFromSupabase() {
  const { data, error } = await supabase
    .from("master_breaks")
    .select("*")
    .order("school_id")
    .order("day")
    .order("time");

  if (error) {
    console.error("loadMasterBreaksFromSupabase error:", error);
    return null;
  }

  return data.map((row) => ({
    id:       row.id,
    schoolId: row.school_id,
    day:      row.day,
    time:     row.time,
  }));
}

// ---- SYNC ----
// Upserts all current master break entries for this user, then deletes
// any rows in Supabase that are no longer in the local array.
export async function syncMasterBreaksToSupabase(masterBreaks, userId) {
  if (!userId) return;

  // Upsert all current entries
  if (masterBreaks.length > 0) {
    const rows = masterBreaks.map((b) => ({
      id:        b.id,
      user_id:   userId,
      school_id: b.schoolId || "",
      day:       b.day      || "",
      time:      b.time     || "",
    }));

    const { error: upsertError } = await supabase
      .from("master_breaks")
      .upsert(rows, { onConflict: "id" });

    if (upsertError) {
      console.error("syncMasterBreaksToSupabase upsert error:", upsertError);
      return;
    }
  }

  // Delete rows that no longer exist locally
  const currentIds = masterBreaks.map((b) => b.id);
  const { data: remoteRows, error: fetchError } = await supabase
    .from("master_breaks")
    .select("id")
    .eq("user_id", userId);

  if (fetchError) {
    console.error("syncMasterBreaksToSupabase fetch error:", fetchError);
    return;
  }

  const toDelete = remoteRows
    .map((r) => r.id)
    .filter((id) => !currentIds.includes(id));

  if (toDelete.length > 0) {
    const { error: deleteError } = await supabase
      .from("master_breaks")
      .delete()
      .in("id", toDelete);

    if (deleteError) {
      console.error("syncMasterBreaksToSupabase delete error:", deleteError);
    }
  }
}
