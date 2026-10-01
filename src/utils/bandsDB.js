// ============================================================
// bandsDB.js — Supabase load and per-row writes for bands
// ============================================================
//
// v2.41.2: PER-ROW writes. The old whole-list upsert + delete-not-in-list
// sweep overwrote teacher edits made since the admin loaded and could
// delete bands the admin had never seen. Now only the band the admin saved
// is upserted, and only a band the admin deleted is deleted, by id.

import { supabase } from "../supabaseClient";
import { rowToBand, planBandUpsert } from "./bandsSync";

export async function loadBandsFromSupabase() {
  const { data, error } = await supabase
    .from("bands")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToBand);
}

export async function upsertBandToSupabase(band, userId) {
  const row = planBandUpsert(band, userId);
  if (!row) return;
  const { error } = await supabase
    .from("bands")
    .upsert(row, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

export async function deleteBandFromSupabase(id) {
  if (!id) return;
  const { error } = await supabase
    .from("bands")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
}
