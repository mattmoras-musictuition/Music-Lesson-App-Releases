// ============================================================
// bandsDB.js — Supabase load/sync for bands
// ============================================================

import { supabase } from "../supabaseClient";

function rowToBand(row) {
  return {
    id:                row.id,
    name:              row.name               || "",
    schoolId:          row.school_id          || "",
    teacherId:         row.teacher_id         || "",
    teacherInstrument: row.teacher_instrument || "",
    // Cosmetic personnel list [{teacherId, instrument}] — display-only,
    // replaces the legacy teacher_id+teacher_instrument pair for admin logic.
    // The legacy columns are still mapped because the teacher app writes them.
    personnel:         row.personnel          || [],
    members:           row.members            || [],
    links:             row.links              || [],
    notes:             row.notes              || "",
  };
}

function bandToRow(band, userId) {
  return {
    id:                 band.id,
    user_id:            userId,
    name:               band.name               || "",
    school_id:          band.schoolId           || "",
    teacher_id:         band.teacherId          || "",
    teacher_instrument: band.teacherInstrument  || "",
    personnel:          band.personnel          || [],
    members:            band.members            || [],
    links:              band.links              || [],
    notes:              band.notes              || "",
  };
}

export async function loadBandsFromSupabase() {
  const { data, error } = await supabase
    .from("bands")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToBand);
}

export async function syncBandsToSupabase(bands, userId) {
  if (!userId) return;
  const rows = bands.map(b => bandToRow(b, userId));
  const { error: upsertError } = await supabase
    .from("bands")
    .upsert(rows, { onConflict: "id" });
  if (upsertError) throw new Error(upsertError.message);

  const currentIds = bands.map(b => b.id);
  if (currentIds.length === 0) return;
  const { error: deleteError } = await supabase
    .from("bands")
    .delete()
    .eq("user_id", userId)
    .not("id", "in", `(${currentIds.join(",")})`);
  if (deleteError) throw new Error(deleteError.message);
}
