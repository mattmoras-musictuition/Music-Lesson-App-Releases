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
  const row = {
    id:                  r.id,
    label:               r.label       || null,
    url:                 r.url         || null,
    // resources.category is `text NOT NULL DEFAULT ''` (see studentNotesDB
    // publish path) — '' means "no type". Preserve a string verbatim (incl.
    // '') rather than coercing '' → null, which would violate the NOT NULL
    // constraint when the Student-Notes publish path writes a no-type row.
    // Non-string/undefined falls back to '' so the column is never null.
    category:            typeof r.category === "string" ? r.category : (r.category ?? ""),
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
  // The shared `resources` INSERT RLS is WITH CHECK (auth.uid() = user_id),
  // so the Student-Notes publish path (studentNotesDB.publishUploadToLibrary /
  // addUploadToLibrary) passes an explicit user_id that must reach the row.
  // Admin Resource Library writes never set user_id, so only forward it when
  // the caller supplies one — keeping admin write behaviour unchanged.
  if (r.user_id !== undefined && r.user_id !== null) row.user_id = r.user_id;
  return row;
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

// Update one resource row; returns the mapped, DB-canonical row.
//
// Accepts two call shapes:
//   • updateResource(resource)   — full resource object (admin Resource
//     Library): mapped through resourceToRow, updated by resource.id.
//   • updateResource(id, patch)  — partial column patch by id (the shape the
//     mirrored studentNotesDB.editLibraryItem uses). The patch is applied
//     verbatim; only the named columns change.
// Both return the mapped, DB-canonical row.
export async function updateResource(idOrResource, patch) {
  const isPatchForm = typeof idOrResource === "string";
  const id      = isPatchForm ? idOrResource : idOrResource.id;
  const updates = isPatchForm ? patch : resourceToRow(idOrResource);
  const { data, error } = await supabase
    .from("resources")
    .update(updates)
    .eq("id", id)
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

// ── Folder overrides (shared sidebar aliases + hidden folders) ──
//
// The Finder-style sidebars (Resources and Documents) auto-generate one folder
// per metadata value from the live data. Admins/teachers can give a folder a
// display alias (label only — the underlying value and the taxonomy lists are
// untouched), hide it (reversible), or save the current view as a named custom
// folder. All three are stored in ONE shared app_settings row per surface so
// every client sees the same overrides. Shape:
//   { aliases: { "instrument:Ukulele": "Uke", ... },
//     hidden:  ["type:Equipment", ...],
//     custom:  [{ id, name, filters }] }
// Folder keys are `${dim}:${value}`. Resources use the key
// "resource_folder_overrides"; Documents use "document_folder_overrides" — the
// two never interfere. No schema change — this reuses app_settings.
const FOLDER_OVERRIDES_KEY = "resource_folder_overrides";

// Coerce a stored value (jsonb object, JSON string, or null) into the canonical
// { aliases, hidden, custom } shape. Never throws.
function _coerceOverrides(value) {
  let v = value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { aliases: {}, hidden: [], custom: [] };
  const aliases = {};
  if (v.aliases && typeof v.aliases === "object" && !Array.isArray(v.aliases)) {
    for (const [k, val] of Object.entries(v.aliases)) {
      if (typeof k === "string" && typeof val === "string" && val.trim()) aliases[k] = val;
    }
  }
  const hidden = Array.isArray(v.hidden) ? v.hidden.filter(x => typeof x === "string") : [];
  const custom = Array.isArray(v.custom)
    ? v.custom.filter(c => c && typeof c === "object" && typeof c.id === "string" && typeof c.name === "string")
              .map(c => ({ id: c.id, name: c.name, filters: (c.filters && typeof c.filters === "object") ? c.filters : {} }))
    : [];
  return { aliases, hidden, custom };
}

// Fetch the shared folder overrides for a surface (defaults to Resources).
// Missing row → empty overrides. Never throws.
export async function fetchFolderOverrides(settingsKey = FOLDER_OVERRIDES_KEY) {
  try {
    const { data, error } = await supabase
      .from("app_settings").select("value").eq("key", settingsKey);
    if (error) throw error;
    return _coerceOverrides((data || [])[0]?.value);
  } catch (err) {
    console.warn("[resources] folder overrides load failed:", err?.message);
    return { aliases: {}, hidden: [], custom: [] };
  }
}

// Persist the shared folder overrides for a surface (upsert one app_settings
// row). Returns the cleaned overrides actually written. Call as
// saveFolderOverrides(key, overrides); a single-arg call defaults to the
// Resources key for backward compatibility.
export async function saveFolderOverrides(settingsKeyOrOverrides, maybeOverrides) {
  const settingsKey = typeof settingsKeyOrOverrides === "string" ? settingsKeyOrOverrides : FOLDER_OVERRIDES_KEY;
  const overrides   = typeof settingsKeyOrOverrides === "string" ? maybeOverrides : settingsKeyOrOverrides;
  const clean = _coerceOverrides(overrides);
  const { error } = await supabase
    .from("app_settings").upsert({ key: settingsKey, value: clean }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return clean;
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

// ── Student Notes feature additions (cluster 6.1) ─────────────
//
// Ported from the teacher-app resourcesDB.js to support the Student Notes
// attachment / library-picker surface (studentNotesDB.js + later admin
// components). resourcesDB.js is per-app (NOT a byte-identical mirror), so
// these live alongside the admin-specific exports above. They operate on RAW
// `resources` rows (no rowToResource mapping) because the Student-Notes code
// path consumes the snake_case rows directly, mirroring the teacher app.

// Load the whole shared library as raw rows, ordered by label. (Distinct from
// loadResourcesFromSupabase, which maps rows for the admin Resource Library.)
export async function loadResources() {
  const { data, error } = await supabase
    .from("resources")
    .select("*")
    .order("label", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Find library resources whose name matches `name`, case-insensitively.
// Compares against both the resource's stored file_name and its label, so
// an incoming file matches whether the library item was named after the
// file or given a custom label. Operates on an already-loaded resources
// array — no fetch. Returns the matching rows (empty array = no match).
export function findResourcesByName(resources, name) {
  const q = (name || "").trim().toLowerCase();
  if (!q) return [];
  return (resources || []).filter(r => {
    const fn = (r.file_name || "").trim().toLowerCase();
    const lb = (r.label || "").trim().toLowerCase();
    return fn === q || lb === q;
  });
}

// Shared-file-safe delete of a resources row (8.3a logic, extracted in 8.4 so
// the Resources tab and the Student-Notes "remove from library" path share it).
// Before removing the storage object, check for a teacher-app published upload
// that still shares this file — a student_attachments row with resource_id =
// this resource AND a non-null storage_path. If one exists, KEEP the file (only
// the resources row is deleted; the FK then clears resource_id on referrers). If
// the referrer check itself errors, err safe and keep the file. Then delete the
// resources row.
export async function deleteResourceSharedFileSafe(resource) {
  if (!resource?.id) return;
  if (resource.file_url) {
    let sharedByUpload = false;
    try {
      const { data, error } = await supabase
        .from("student_attachments")
        .select("id")
        .eq("resource_id", resource.id)
        .not("storage_path", "is", null)
        .limit(1);
      if (error) throw error;
      sharedByUpload = (data || []).length > 0;
    } catch (e) {
      console.error("[resources delete] shared-file check failed — keeping file:", e);
      sharedByUpload = true;
    }
    if (!sharedByUpload) {
      const match = resource.file_url.match(/\/object\/public\/resources\/(.+)$/);
      if (match) {
        await supabase.storage.from("resources").remove([decodeURIComponent(match[1])]);
      }
    }
  }
  const { error } = await supabase.from("resources").delete().eq("id", resource.id);
  if (error) throw error;
}

// Realtime subscription on the shared `resources` library table. Fires onChange
// with the postgres_changes payload for every insert/update/delete on the table
// (no filter — the library is a shared pool). Mirrors the established pattern in
// studentNotesDB (subscribeToSubjectNotes / subscribeToSubjectAttachments): one
// channel, "*" event, public schema; returns an unsubscribe fn. The channel
// name carries a per-subscriber uuid so the two views (Resources tab + Student
// Notes) and any remount never collide on one channel.
//
// NOTE: this only receives events if the `resources` table is in the database's
// realtime publication (verified/enabled separately). Until then it is inert —
// the subscription is harmless and starts delivering once the publication is on.
export function subscribeToResources(onChange) {
  const channel = supabase
    .channel(`resources:${crypto.randomUUID()}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "resources" },
      payload => onChange(payload)
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}
