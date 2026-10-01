// ============================================================
// bandsDB.js — Supabase load/sync for bands
// ============================================================

import { supabase } from "../supabaseClient";
import { rowToBand, planWholeListSync } from "./bandsSync";

export async function loadBandsFromSupabase() {
  const { data, error } = await supabase
    .from("bands")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToBand);
}

export async function syncBandsToSupabase(bands, userId) {
  const plan = planWholeListSync(bands, userId);
  if (!plan) return;
  const { error: upsertError } = await supabase
    .from("bands")
    .upsert(plan.upsertRows, { onConflict: "id" });
  if (upsertError) throw new Error(upsertError.message);

  if (!plan.deleteSweep) return;
  const { error: deleteError } = await supabase
    .from("bands")
    .delete()
    .eq("user_id", plan.deleteSweep.ownedBy)
    .not("id", "in", `(${plan.deleteSweep.keepIds.join(",")})`);
  if (deleteError) throw new Error(deleteError.message);
}
