// ============================================================
// resourcesDB.js — Supabase data-access for the shared
// `resources` library (Resource Library workstream).
//
// The `resources` table is a SHARED pool: both the admin app and
// the teacher app read and write it. Persistence is therefore
// per-row (insert / update / delete one row at a time) — there is
// deliberately NO whole-list sync, so one app can never delete
// rows the other created.
//
// File-backed resources store their public location in
// file_url / file_name (the `resources` storage bucket is public);
// link resources store the URL in `url`. The two are exclusive.
// ============================================================

import { supabase } from "../supabaseClient";

// Snake_case DB row → in-memory resource object. Field names mirror
// the columns (no camelCase rename) so the same object round-trips
// through resourceToRow on write.
function rowToResource(row) {
  return {
    id:                  row.id,
    label:               row.label       || "",
    url:                 row.url         || "",
    category:            row.category    || "",
    description:         row.description || "",
    created_at:          row.created_at  || null,
    file_url:            row.file_url    || "",
    file_name:           row.file_name   || "",
    added_by_teacher_id: row.added_by_teacher_id || null,
    added_by_name:       row.added_by_name       || "",
    instrument:          row.instrument          || null,
    skill_level:         row.skill_level         || null,
    school_id:           row.school_id           || null,
    source:              row.source              || null,
    source_subject_type: row.source_subject_type || null,
    source_subject_id:   row.source_subject_id   || null,
  };
}

// In-memory resource → DB row. Only the known columns are written
// (stray UI fields like _isNew / gmailRef are dropped). created_at
// is left to the DB default on insert and untouched on update.
function resourceToRow(r) {
  return {
    id:                  r.id,
    label:               r.label       || null,
    url:                 r.url         || null,
    category:            r.category    || null,
    description:         r.description || null,
    file_url:            r.file_url    || null,
    file_name:           r.file_name   || null,
    added_by_teacher_id: r.added_by_teacher_id || null,
    added_by_name:       r.added_by_name       || null,
    instrument:          r.instrument          || null,
    skill_level:         r.skill_level         || null,
    school_id:           r.school_id           || null,
    source:              r.source              || null,
    source_subject_type: r.source_subject_type || null,
    source_subject_id:   r.source_subject_id   || null,
  };
}

// Load the whole shared library (all rows), mapped through the full
// mapper. Ordered by label for stable display.
export async function loadResourcesFromSupabase() {
  const { data, error } = await supabase
    .from("resources")
    .select("*")
    .order("label", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToResource);
}

// Insert one resource row; returns the mapped, DB-canonical row.
export async function insertResource(resource) {
  const { data, error } = await supabase
    .from("resources")
    .insert(resourceToRow(resource))
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return rowToResource(data);
}

// Update one resource row by id; returns the mapped, DB-canonical row.
export async function updateResource(resource) {
  const { data, error } = await supabase
    .from("resources")
    .update(resourceToRow(resource))
    .eq("id", resource.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return rowToResource(data);
}

// Delete one resource row by id. Storage-object cleanup is the
// caller's responsibility (it has the file_url).
export async function deleteResource(id) {
  const { error } = await supabase
    .from("resources")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
}
