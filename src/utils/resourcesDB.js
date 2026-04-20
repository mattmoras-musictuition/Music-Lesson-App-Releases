// ============================================================
// resourcesDB.js — Supabase load/sync for resources
// ============================================================

import { supabase } from "../supabaseClient";

function rowToResource(row) {
  return {
    id:          row.id,
    label:       row.label       || "",
    url:         row.url         || "",
    category:    row.category    || "",
    description: row.description || "",
  };
}

function resourceToRow(resource, userId) {
  return {
    id:          resource.id,
    user_id:     userId,
    label:       resource.label       || "",
    url:         resource.url         || "",
    category:    resource.category    || "",
    description: resource.description || "",
  };
}

export async function loadResourcesFromSupabase() {
  const { data, error } = await supabase
    .from("resources")
    .select("*")
    .order("label", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToResource);
}

export async function syncResourcesToSupabase(resources, userId) {
  if (!userId) return;
  const rows = resources.map(r => resourceToRow(r, userId));
  const { error: upsertError } = await supabase
    .from("resources")
    .upsert(rows, { onConflict: "id" });
  if (upsertError) throw new Error(upsertError.message);

  const currentIds = resources.map(r => r.id);
  if (currentIds.length === 0) return;
  const { error: deleteError } = await supabase
    .from("resources")
    .delete()
    .eq("user_id", userId)
    .not("id", "in", `(${currentIds.join(",")})`);
  if (deleteError) throw new Error(deleteError.message);
}
