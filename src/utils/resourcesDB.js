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

// Shared-file safety (cluster 8.3b): true when a teacher-app "published
// upload" still shares this resource's stored file — a student_attachments
// row with resource_id = this resource AND a non-null storage_path. The
// caller uses this to decide whether deleting the resources row may also
// remove the storage object. Throws on query error so the caller can err
// safe (keep the file). The student_attachments SELECT policy is open to
// any authenticated user, so this read is permitted from the admin app.
export async function resourceFileSharedByUpload(resourceId) {
  const { data, error } = await supabase
    .from("student_attachments")
    .select("id")
    .eq("resource_id", resourceId)
    .not("storage_path", "is", null)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data || []).length > 0;
}

// ── Resource Library view helpers (taxonomy + subject names) ──

// Coerce an app_settings value (jsonb array, JSON-stringified array,
// or null) into a plain string array. Never throws.
function _taxArray(value) {
  if (Array.isArray(value)) return value.filter(v => typeof v === "string");
  if (typeof value === "string") {
    try { const p = JSON.parse(value); return Array.isArray(p) ? p.filter(v => typeof v === "string") : []; }
    catch { return []; }
  }
  return [];
}

// Fetch the three Resource Library taxonomy lists from app_settings
// (managed by the Settings screen). A missing row yields an empty
// array — never throws.
export async function fetchResourceTaxonomies() {
  try {
    const { data, error } = await supabase
      .from("app_settings").select("key,value")
      .in("key", ["resource_types", "skill_levels", "instruments"]);
    if (error) throw error;
    const byKey = {};
    for (const row of data || []) byKey[row.key] = _taxArray(row.value);
    return {
      resourceTypes: byKey.resource_types || [],
      skillLevels:   byKey.skill_levels   || [],
      instruments:   byKey.instruments    || [],
    };
  } catch (err) {
    console.warn("[resources] taxonomy load failed:", err?.message);
    return { resourceTypes: [], skillLevels: [], instruments: [] };
  }
}

// id→name maps for resolving a resource's originating subject when
// source='student_note'. Students and groups each have their own
// table in the admin app. Best-effort: failures yield empty maps.
export async function loadSubjectNameMaps() {
  const studentsById = new Map();
  const groupsById = new Map();
  try {
    const { data } = await supabase.from("students").select("id, name");
    for (const s of data || []) studentsById.set(s.id, s.name || "");
  } catch (err) { console.warn("[resources] students load failed:", err?.message); }
  try {
    const { data } = await supabase.from("groups").select("id, name");
    for (const g of data || []) groupsById.set(g.id, g.name || "");
  } catch (err) { console.warn("[resources] groups load failed:", err?.message); }
  return { studentsById, groupsById };
}

// Resolve a subject to a display name, or null if unresolvable.
export function resolveSubjectName(subjectType, subjectId, maps) {
  if (!subjectType || !subjectId || !maps) return null;
  const m = subjectType === "group" ? maps.groupsById : maps.studentsById;
  const name = m?.get(subjectId);
  return name || null;
}
