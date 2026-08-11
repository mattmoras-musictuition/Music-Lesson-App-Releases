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
    // resources.label is `text NOT NULL DEFAULT ''`. Normally set (the Name),
    // but guard it to '' so a blank/absent name can never send null.
    label:               r.label       ?? "",
    // resources.url is `text NOT NULL` (see [resources insert] failure: a file
    // resource sends no link, so url would be null and violate the constraint).
    // Coerce to '' when absent — '' means "no link". A real URL passes through.
    url:                 r.url         ?? "",
    // resources.category is `text NOT NULL DEFAULT ''` (see studentNotesDB
    // publish path) — '' means "no type". Preserve a string verbatim (incl.
    // '') rather than coercing '' → null, which would violate the NOT NULL
    // constraint when the Student-Notes publish path writes a no-type row.
    // Non-string/undefined falls back to '' so the column is never null.
    category:            typeof r.category === "string" ? r.category : (r.category ?? ""),
    // resources.description is `text NOT NULL DEFAULT ''` — a blank description
    // was sent as null and violated the constraint (23502). Coerce to '' when
    // absent; '' means "no description". Real text passes through.
    description:         r.description ?? "",
    // file_url / file_name are the file-resource payload columns (null on a link
    // resource). Coerce to '' when absent — symmetric with url above so neither
    // payload shape can send null into a NOT NULL column. '' means "no file".
    file_url:            r.file_url    ?? "",
    file_name:           r.file_name   ?? "",
    added_by_teacher_id: r.added_by_teacher_id || null,
    added_by_name:       r.added_by_name       || null,
    instrument:          r.instrument          || null,
    skill_level:         r.skill_level         || null,
    school_id:           r.school_id           || null,
    // resources.source is `text NOT NULL DEFAULT 'direct'` and is a taxonomy
    // field — '' is not a valid value, so default to 'direct' (an admin direct
    // upload) when absent. A supplied source (e.g. 'student_note') passes through.
    source:              r.source              || "direct",
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
  // `resources.user_id` is NOT NULL with no default and the INSERT RLS is
  // WITH CHECK (auth.uid() = user_id) with no admin INSERT policy — so every
  // inserted row MUST stamp user_id = the current auth user or the insert is
  // rejected (NOT NULL violation / RLS) and surfaces as a generic save error.
  // The Student-Notes publish path supplies user_id explicitly; the admin
  // Resource Library callers (Add-resource modal, Dashboard) do not, so stamp
  // it here from the live session — mirroring teachersDB.toRow. An explicitly
  // supplied user_id is preserved.
  let toInsert = resource;
  if (toInsert.user_id === undefined || toInsert.user_id === null) {
    const { data: { user } = {} } = await supabase.auth.getUser();
    if (user?.id) toInsert = { ...toInsert, user_id: user.id };
  }
  const { data, error } = await supabase
    .from("resources")
    .insert(resourceToRow(toInsert))
    .select("*")
    .single();
  if (error) {
    // Surface the underlying Supabase/PostgREST error (the wrapper below
    // flattens it to message-only) so the real cause — RLS code 42501, a
    // NOT NULL violation, etc. — is visible in the console for diagnosis.
    console.error("[resources insert] failed:", {
      message: error.message, code: error.code,
      details: error.details, hint: error.hint, status: error.status,
    });
    throw new Error(error.message);
  }
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

// ── Instrument abbreviations (Concerts §4.8) ────────────────────
//
// Short forms printed beside each performer's name on the concert
// program ("Alice Walker (Gtr)"). Managed centrally in Settings so
// they stay consistent across every program and every year.
//
// Stored in its OWN app_settings row — key 'instrument_abbreviations',
// value a jsonb OBJECT keyed by instrument name — exactly as
// instrument_colors already is. Deliberately NOT folded into the
// `instruments` array: both copies of _taxArray (above, and the one in
// SettingsManager.js) hard-filter `typeof v === "string"`, so turning
// that array into objects would silently empty it — the taxonomy would
// appear deleted with no error raised anywhere. The instruments array
// keeps its plain-string shape and is untouched by this feature.
//
// Keying by NAME means a rename in Settings must carry the
// abbreviation across in the same save, or it is orphaned. That is
// handled in ResourceTaxonomyPanel.saveEdit.
const INSTRUMENT_ABBREV_KEY = "instrument_abbreviations";

// Coerce a stored value (jsonb object, JSON string, or null) into a plain
// name→abbreviation object. Non-string or blank keys/values are dropped, so
// a malformed row degrades to {} rather than poisoning the resolver.
// Never throws.
function _abbrevMap(value) {
  let v = value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = null; } }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof k === "string" && k.trim() && typeof val === "string" && val.trim()) out[k] = val;
  }
  return out;
}

// Fetch the instrument abbreviation map. A missing row (a fresh environment
// where nobody has saved one yet) yields {} — never throws, so a failure
// here costs the stored abbreviations, not the screen that asked for them.
export async function fetchInstrumentAbbreviations() {
  try {
    const { data, error } = await supabase
      .from("app_settings").select("value").eq("key", INSTRUMENT_ABBREV_KEY);
    if (error) throw error;
    return _abbrevMap((data || [])[0]?.value);
  } catch (err) {
    console.warn("[resources] instrument abbreviations load failed:", err?.message);
    return {};
  }
}

// Persist the whole abbreviation map (one app_settings row). Upserts on
// `key` so the row is CREATED on first write — the seeded row must not be
// assumed present. Returns the cleaned map actually written; throws on
// failure so the caller can tell the user the save didn't land.
export async function saveInstrumentAbbreviations(map) {
  const clean = _abbrevMap(map);
  const { error } = await supabase
    .from("app_settings").upsert({ key: INSTRUMENT_ABBREV_KEY, value: clean }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return clean;
}

// Resolve one instrument name to the short form the program prints.
// Consumed by the Settings editor, the concert piece editor, and (next)
// the program export — one resolver so all three agree.
//
//   blank name        → "" (the caller omits the parenthetical entirely;
//                       "()" must never be printed — spec §4.8)
//   set in the map    → that value
//   otherwise         → first three characters, title-cased ("Mandolin" → "Man")
//
// Never returns null or undefined. The lookup uses the trimmed name because
// the taxonomy stores trimmed entries, so a stray-whitespace value (e.g. one
// copied in from a band) still resolves to its stored abbreviation.
export function abbreviateInstrument(name, map) {
  const raw = typeof name === "string" ? name.trim() : "";
  if (!raw) return "";
  const stored = (map && typeof map === "object" && !Array.isArray(map)) ? map[raw] : undefined;
  if (typeof stored === "string" && stored.trim()) return stored.trim();
  const head = raw.slice(0, 3);
  return head.charAt(0).toUpperCase() + head.slice(1).toLowerCase();
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
