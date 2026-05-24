// ============================================================
// studentNotesDB.js — Supabase data-access for the Student Notes
// feature (cluster 1 foundation).
//
// Thin accessors over the Student Notes tables on the Supabase
// dashboard: student_notes, student_attachments, teacher_pinned_subjects
// (RLS enabled, added to the supabase_realtime publication). Project convention
// places schema on the dashboard, not in repo migrations (Phase 0
// finding); this module is the read/write surface both the admin
// app and the teacher app consume from cluster 2 onward.
//
// Spec: /Users/mattmoras/teacher app docs/STUDENT_NOTES/STUDENT_NOTES_SPEC.md
//
// Column-name note: the canonical week-key column is `week_key`; the
// JS param is `weekKey` to match the spec's util contract. `term_id`
// is text + nullable (there is no terms table in this project — terms
// are derived client-side in termWeeks.js).
//
// Identity is NOT resolved here. Pin helpers take teacherId from the
// caller, mirroring the existing *DB.js pattern (userId/teacherId is
// always passed in — see teachersDB.syncTeachersToSupabase,
// teacherCoverageDB.insertTeacherCoverage).
//
// v1 (cluster 1) deliberately stops here:
//   - No realtime subscription helpers — cluster 4 (note editing /
//     multi-author live sync).
//   - No admin-as-author handling — cluster 7 (admin app mirror).
//   - No attachment storage (upload/remove) helpers — cluster 5.
//
// Cluster 4 adds the write + realtime surface (upsertNote, deleteNote,
// subscribeToSubjectNotes) to the teacher app only. This TEMPORARILY
// diverges from the admin app's mirror copy; the byte-identical
// invariant is re-established at cluster 6 (admin app mirror).
//
// Cluster 5 adds the attachment surface (file uploads to the shared
// `resources` storage bucket, link attachments enriched by the
// fetch-page-meta edge function, signed-URL access, and a realtime
// subscription) over the SUBJECT-scoped `student_attachments` table
// (subject_type, subject_id, author_id). The cluster-5 migration
// dropped the old note-scoped attachments table, so notes no longer
// embed attachments — they are loaded independently via
// getAttachmentsForSubject. Teacher-only; the admin mirror catches up
// at cluster 6.
// ============================================================

import { supabase } from "../supabaseClient";
import { insertResource, updateResource, deleteResourceSharedFileSafe } from "./resourcesDB";

// ── Shape converters (snake_case row → camelCase) ────────────

/**
 * Classify an attachment from its (camelCase) payload columns, so the UI
 * never has to derive type from raw columns. Four explicit flags
 * (rev-5 model, cluster 8.2 / 8.3a):
 *   - isUploadedFile  — owns a stored file (storage_path set).
 *   - isUploadedLink  — owns a link (url set, kind='link').
 *   - isReference     — a reference-type attachment: owns NO payload
 *                       (storage_path null AND url null). Recognised
 *                       independent of resource_id, so a former reference
 *                       whose library item was deleted — the FK
 *                       (ON DELETE SET NULL) cleared resource_id, leaving a
 *                       payload-less row — is still a reference (it renders
 *                       as an UNRESOLVED reference; see AttachmentsPanel).
 *   - inLibrary       — still linked to a resources row (resource_id set).
 *                       True for published uploads and for live (resolved)
 *                       references; false once the library item is deleted.
 * A published upload is an uploaded file that ALSO has resource_id, so
 * isUploadedFile && inLibrary && !isReference.
 *
 * Resolved-vs-unresolved for a reference is a render-time decision (it needs
 * the loaded library), made in AttachmentsPanel — not here.
 *
 * @param {{storagePath?:string|null, url?:string|null, kind?:string, resourceId?:string|null}} att
 */
export function classifyAttachment(att) {
  const isUploadedFile = !!att.storagePath;
  const isUploadedLink = !!att.url && att.kind === "link";
  const isReference    = !att.storagePath && !att.url;
  const inLibrary      = !!att.resourceId;
  return { isUploadedFile, isUploadedLink, isReference, inLibrary };
}

function attachmentFromRow(row) {
  const att = {
    id:            row.id,
    subjectType:   row.subject_type,
    subjectId:     row.subject_id,
    authorId:      row.author_id,
    kind:          row.kind,
    storagePath:   row.storage_path    || null,
    fileName:      row.file_name       || null,
    fileSizeBytes: row.file_size_bytes ?? null,
    mimeType:      row.mime_type       || null,
    url:           row.url             || null,
    pageTitle:     row.page_title      || null,
    ogImageUrl:    row.og_image_url    || null,
    displayLabel:  row.display_label   || null,
    resourceId:    row.resource_id     || null,
    createdAt:     row.created_at      || "",
  };
  return { ...att, ...classifyAttachment(att) };
}

function noteFromRow(row) {
  return {
    id:          row.id,
    subjectType: row.subject_type,
    subjectId:   row.subject_id,
    weekKey:     row.week_key,
    termId:      row.term_id     || null,
    authorId:    row.author_id,
    body:        row.body        || {},
    createdAt:   row.created_at  || "",
    updatedAt:   row.updated_at  || "",
  };
}

function pinFromRow(row) {
  return {
    teacherId:   row.teacher_id,
    subjectType: row.subject_type,
    subjectId:   row.subject_id,
    pinnedAt:    row.pinned_at || "",
  };
}

// ── Notes reads ──────────────────────────────────────────────

/**
 * All notes for a subject, newest week first. Attachments are loaded
 * separately (subject-scoped) — see getAttachmentsForSubject.
 *
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId  students.id (solo) or groups.id (group)
 * @returns {Promise<Array>} camelCase note objects (see noteFromRow)
 */
export async function getNotesForSubject(subjectType, subjectId) {
  const { data, error } = await supabase
    .from("student_notes")
    .select("*")
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .order("week_key", { ascending: false });
  if (error) throw error;
  return (data || []).map(noteFromRow);
}

/**
 * Notes for one subject+week — one row per author (the
 * (subject_type, subject_id, week_key, author_id) unique key).
 * Ordered by created_at ascending so multi-author week cards stack
 * oldest-first (spec §4.1.2).
 *
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId
 * @param {string} weekKey  matched against the week_key column
 * @returns {Promise<Array>} camelCase note objects
 */
export async function getNotesForWeek(subjectType, subjectId, weekKey) {
  const { data, error } = await supabase
    .from("student_notes")
    .select("*")
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .eq("week_key", weekKey)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(noteFromRow);
}

// ── Notes writes (cluster 4) ─────────────────────────────────

/**
 * Insert-or-update the current author's note for a subject+week.
 * Upserts on the (subject_type, subject_id, week_key, author_id)
 * unique key, so an author has at most one note per subject+week;
 * a second save overwrites the body in place (last-write-wins).
 *
 * @param {Object} args
 * @param {'student'|'group'} args.subjectType
 * @param {string} args.subjectId
 * @param {string} args.weekKey
 * @param {string|null} args.termId   stored verbatim (text, nullable)
 * @param {string} args.authorId
 * @param {Object} args.body          ProseMirror/TipTap JSON document
 * @returns {Promise<Object>} the full upserted note (see noteFromRow)
 */
export async function upsertNote({ subjectType, subjectId, weekKey, termId, authorId, body }) {
  const { data, error } = await supabase
    .from("student_notes")
    .upsert(
      {
        subject_type: subjectType,
        subject_id:   subjectId,
        week_key:     weekKey,
        term_id:      termId || null,
        author_id:    authorId,
        body:         body || {},
      },
      { onConflict: "subject_type,subject_id,week_key,author_id" }
    )
    .select("*")
    .single();
  if (error) throw error;
  return noteFromRow(data);
}

/**
 * Delete a note by id. RLS restricts this to the author's own rows.
 *
 * @param {string} id
 * @returns {Promise<boolean>} true on success
 */
export async function deleteNote(id) {
  const { error } = await supabase
    .from("student_notes")
    .delete()
    .eq("id", id);
  if (error) throw error;
  return true;
}

// ── Realtime (cluster 4) ─────────────────────────────────────

/**
 * Subscribe to all note changes for one subject. Opens a single
 * supabase channel on postgres_changes for the student_notes table,
 * server-side filtered to this subject_id, and invokes onChange for
 * every INSERT / UPDATE / DELETE. Callers diff against local state
 * (e.g. skip echoes of their own optimistic writes).
 *
 * @param {'student'|'group'} subjectType  (reserved; subject_id is
 *        globally unique so the filter alone is sufficient)
 * @param {string} subjectId
 * @param {(payload: Object) => void} onChange  receives the raw
 *        supabase realtime payload ({ eventType, new, old, ... })
 * @returns {() => void} unsubscribe — removes the channel
 */
export function subscribeToSubjectNotes(subjectType, subjectId, onChange) {
  const channel = supabase
    .channel(`student_notes:${subjectType}:${subjectId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "student_notes",
        filter: `subject_id=eq.${subjectId}`,
      },
      payload => onChange(payload)
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

// ── Attachments (cluster 5) ──────────────────────────────────
//
// Files live in the shared `resources` storage bucket (reused from
// Documents & Resources) under an `attachments/<subject_id>/` prefix;
// the object name embeds the row id so DB row and storage object stay
// trivially correlated. Links are enriched via the fetch-page-meta
// edge function, degrading to the URL hostname when it is unavailable.

const ATTACHMENTS_BUCKET = "resources";
const ATTACHMENTS_PREFIX = "attachments";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

function sanitizeFileName(name) {
  return (name || "file")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .slice(0, 80);
}

/**
 * All attachments for a subject, oldest first.
 *
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId
 * @returns {Promise<Array>} camelCase attachment objects
 */
export async function getAttachmentsForSubject(subjectType, subjectId) {
  const { data, error } = await supabase
    .from("student_attachments")
    .select("*")
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(attachmentFromRow);
}

/**
 * Upload a file attachment. Generates the row id client-side so it can
 * name the storage object, uploads, then inserts the row.
 *
 * @param {Object} args
 * @param {'student'|'group'} args.subjectType
 * @param {string} args.subjectId
 * @param {string} args.authorId
 * @param {File} args.file
 * @returns {Promise<Object>} the inserted attachment
 */
export async function uploadFileAttachment({ subjectType, subjectId, authorId, file, displayLabel }) {
  if (!file) throw new Error("No file provided");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("File too large — 10 MB max");

  const id = crypto.randomUUID();
  const storagePath = `${ATTACHMENTS_PREFIX}/${subjectId}/${id}-${sanitizeFileName(file.name)}`;

  const { error: uploadErr } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(storagePath, file, { upsert: false, contentType: file.type || undefined });
  if (uploadErr) throw uploadErr;

  const label = (displayLabel || "").trim();
  const { data, error } = await supabase
    .from("student_attachments")
    .insert({
      id,
      kind:            "file",
      storage_path:    storagePath,
      file_name:       file.name,
      file_size_bytes: file.size,
      mime_type:       file.type || null,
      display_label:   label || null,
      subject_type:    subjectType,
      subject_id:      subjectId,
      author_id:       authorId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return attachmentFromRow(data);
}

/**
 * Add a link attachment. Enriches title + og:image via the
 * fetch-page-meta edge function; falls back to the URL hostname (and a
 * null image) if the function is undeployed, errors, or times out.
 *
 * @param {Object} args
 * @param {'student'|'group'} args.subjectType
 * @param {string} args.subjectId
 * @param {string} args.authorId
 * @param {string} args.url
 * @returns {Promise<Object>} the inserted attachment
 */
export async function addLinkAttachment({ subjectType, subjectId, authorId, url, displayLabel }) {
  let hostname;
  try { hostname = new URL(url).hostname; }
  catch { throw new Error("Invalid URL"); }

  const id = crypto.randomUUID();
  let pageTitle = hostname;
  let ogImageUrl = null;
  try {
    const { data: meta, error: metaErr } = await supabase.functions.invoke("fetch-page-meta", { body: { url } });
    if (!metaErr && meta) {
      pageTitle = meta.title || hostname;
      ogImageUrl = meta.og_image_url || null;
    }
  } catch {
    // Edge function not deployed yet (or failed) — hostname fallback.
  }

  const label = (displayLabel || "").trim();
  const { data, error } = await supabase
    .from("student_attachments")
    .insert({
      id,
      kind:          "link",
      url,
      page_title:    pageTitle,
      og_image_url:  ogImageUrl,
      display_label: label || null,
      subject_type:  subjectType,
      subject_id:    subjectId,
      author_id:     authorId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return attachmentFromRow(data);
}

/**
 * Attach an existing library item by reference. Creates a
 * `student_attachments` row whose `resource_id` points at the chosen
 * resource, with `kind` matching the resource (file → 'file', else
 * 'link') and `display_label` = the item's label. No file is uploaded
 * or copied — all seven payload columns are left null, the row shape
 * the corrected attachment_kind_fields_match CHECK requires for a
 * reference.
 *
 * @param {Object} args
 * @param {'student'|'group'} args.subjectType
 * @param {string} args.subjectId
 * @param {string} args.authorId
 * @param {Object} args.resource  a raw `resources` row (must have id)
 * @returns {Promise<Object>} the inserted attachment (see attachmentFromRow)
 */
export async function addLibraryReference({ subjectType, subjectId, authorId, resource }) {
  if (!resource?.id) throw new Error("No resource provided");
  const { data, error } = await supabase
    .from("student_attachments")
    .insert({
      id:            crypto.randomUUID(),
      kind:          resource.file_url ? "file" : "link",
      resource_id:   resource.id,
      display_label: resource.label || null,
      subject_type:  subjectType,
      subject_id:    subjectId,
      author_id:     authorId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return attachmentFromRow(data);
}

/**
 * Opt-in publish (rev-5 "one shared file" model): upload the file ONCE to the
 * resources storage location, create a `resources` library row, then insert an
 * UPLOADED-FILE attachment that ALSO carries resource_id. The attachment owns
 * its file (storage_path + file_* set) and is simultaneously linked to the
 * library row — it is NOT a pure reference. The single stored object is shared
 * by the attachment and the resources row (no duplicate upload).
 *
 * The library write must NOT block the attachment: if it fails, fall back to a
 * plain uploaded-file attachment (resource_id null) over the already-uploaded
 * file and report `published: false`, so a failed library write never loses
 * the teacher's file. (Publishing no longer routes through addLibraryReference,
 * which remains for attach-from-library only.)
 *
 * The file is uploaded to the cluster-2 direct-upload location
 * (`<teacherId>/<ts>_<name>` in the shared `resources` bucket) so the resources
 * row's file_url resolves publicly, exactly like the Resources tab.
 *
 * @returns {Promise<{ attachment: Object, published: boolean, resource?: Object }>}
 */
export async function publishUploadToLibrary({ subjectType, subjectId, authorId, file, schoolId, instrument, category, teacherId, teacherName, displayLabel }) {
  if (!file) throw new Error("No file provided");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("File too large — 10 MB max");
  const label = (displayLabel || "").trim() || file.name;

  const path = `${teacherId}/${Date.now()}_${file.name}`;
  const { error: uploadErr } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (uploadErr) throw uploadErr;
  const { data: pub } = supabase.storage.from(ATTACHMENTS_BUCKET).getPublicUrl(path);
  const fileUrl = pub?.publicUrl || null;

  // The attachment owns its file either way; on a successful library write it
  // additionally carries resource_id. (id added per-insert so the fallback
  // never reuses a PK.)
  const baseAttachment = {
    kind:            "file",
    storage_path:    path,
    file_name:       file.name,
    file_size_bytes: file.size,
    mime_type:       file.type || null,
    display_label:   (displayLabel || "").trim() || null,
    subject_type:    subjectType,
    subject_id:      subjectId,
    author_id:       authorId,
  };

  try {
    // resources.user_id is NOT NULL with no default, and the INSERT RLS
    // policy is WITH CHECK (auth.uid() = user_id) — so the row's owner must
    // be the authenticated user. (category is NOT NULL with a default, so it
    // is omitted, not passed null; the teacher sets the type later.)
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id || null;
    const resource = await insertResource({
      id:                  crypto.randomUUID(),
      user_id:             userId,
      label:               label,
      file_url:            fileUrl,
      file_name:           file.name,
      source:              "student_note",
      source_subject_type: subjectType,
      source_subject_id:   subjectId,
      school_id:           schoolId || null,
      instrument:          instrument || null,
      skill_level:         null,
      added_by_teacher_id: teacherId || null,
      added_by_name:       teacherName || null,
      // category is text NOT NULL DEFAULT '' — write '' for "no type", the chosen
      // value otherwise. Never null (8.4-patch).
      category:            (category || "").trim(),
    });
    // Uploaded-file attachment that also links the library row (rev-5 shape:
    // file payload + resource_id; url/page_title/og_image_url all null).
    const { data, error } = await supabase
      .from("student_attachments")
      .insert({ id: crypto.randomUUID(), ...baseAttachment, resource_id: resource.id })
      .select("*")
      .single();
    if (error) throw error;
    return { attachment: attachmentFromRow(data), published: true, resource };
  } catch (e) {
    // Non-fatal: keep the teacher's attachment as a plain uploaded file over
    // the file we already uploaded, leaving resource_id null. Log the full
    // Supabase error (code / message / details / hint) so the actual cause
    // is diagnosable — a generic message alone leaves nothing to go on.
    console.error("[publish] resources library write failed — keeping uploaded-file attachment.", {
      code:    e?.code,
      message: e?.message,
      details: e?.details,
      hint:    e?.hint,
      error:   e,
    });
    const { data, error } = await supabase
      .from("student_attachments")
      .insert({ id: crypto.randomUUID(), ...baseAttachment })
      .select("*")
      .single();
    if (error) throw error;
    return { attachment: attachmentFromRow(data), published: false };
  }
}

/**
 * Add an existing uploaded-file attachment to the library (8.4) — WITHOUT
 * re-uploading. Derives the library row's file_url/file_name from the
 * attachment's existing storage_path (the file already lives in the shared
 * `resources` bucket), creates a `resources` row consistent with
 * publishUploadToLibrary (same derived fields), writes the chosen Type to its
 * category, then points the attachment's resource_id at it and syncs the name —
 * the attachment becomes a published upload sharing the one stored file.
 *
 * @param {Object} args
 * @param {Object} args.attachment  mapped attachment (must own a file: storagePath set)
 * @param {string} [args.name]      shared name (display_label + resources.label)
 * @param {string} [args.category]  Type → resources.category ('' = no type; never null)
 * @returns {Promise<{ attachment: Object, resource: Object }>}
 */
export async function addUploadToLibrary({ attachment, name, category, schoolId, instrument, teacherId, teacherName }) {
  if (!attachment?.id || !attachment.storagePath) throw new Error("Not an uploaded file");
  const label = (name || "").trim() || attachment.fileName || "File";
  const { data: pub } = supabase.storage.from(ATTACHMENTS_BUCKET).getPublicUrl(attachment.storagePath);
  const fileUrl = pub?.publicUrl || null;
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id || null;
  const resource = await insertResource({
    id:                  crypto.randomUUID(),
    user_id:             userId,
    label:               label,
    file_url:            fileUrl,
    file_name:           attachment.fileName,
    source:              "student_note",
    source_subject_type: attachment.subjectType,
    source_subject_id:   attachment.subjectId,
    school_id:           schoolId || null,
    instrument:          instrument || null,
    skill_level:         null,
    added_by_teacher_id: teacherId || null,
    added_by_name:       teacherName || null,
    // category is text NOT NULL DEFAULT '' — '' for "no type", never null (8.4-patch).
    category:            (category || "").trim(),
  });
  const { data, error } = await supabase
    .from("student_attachments")
    .update({ resource_id: resource.id, display_label: (name || "").trim() || null })
    .eq("id", attachment.id)
    .select("*")
    .single();
  if (error) throw error;
  return { attachment: attachmentFromRow(data), resource };
}

/**
 * Remove a published upload from the library (8.4): delete the linked library
 * row with the shared-file-safe deletion (8.3a, reused). Because this very
 * attachment shares the file (storage_path + resource_id), the referrer check
 * keeps the file; the FK (ON DELETE SET NULL) then clears this attachment's
 * resource_id, so it becomes a plain upload that keeps its file. Other teachers'
 * references to the now-deleted library item become unresolved — the
 * established behaviour. Any name edit is applied to display_label.
 *
 * @returns {Promise<{ attachment: Object }>}
 */
export async function removeUploadFromLibrary({ attachment, resource, name }) {
  await deleteResourceSharedFileSafe(resource || (attachment?.resourceId ? { id: attachment.resourceId } : null));
  // Re-fetch the attachment (resource_id cleared by the FK) and apply the name.
  const { data, error } = await supabase
    .from("student_attachments")
    .update({ display_label: (name || "").trim() || null })
    .eq("id", attachment.id)
    .select("*")
    .single();
  if (error) throw error;
  return { attachment: attachmentFromRow(data) };
}

/**
 * Edit the library item behind an in-library attachment (8.4) — a published
 * upload or an owned pure reference. Writes the shared name to the resources
 * row's label and the attachment's display_label (one shared name; keeps the
 * tombstone fallback fresh), and the Type to the resources row's category.
 * Type is always written so it can be CLEARED: a blank choice writes '' (the
 * column default), a chosen value writes itself. category is text NOT NULL
 * DEFAULT '' — never write null (8.4-patch).
 *
 * @returns {Promise<{ attachment: Object, resource: Object }>}
 */
export async function editLibraryItem({ attachmentId, resourceId, name, category }) {
  const trimmedName = (name || "").trim();
  const resourcePatch = { category: (category || "").trim() };
  if (trimmedName) resourcePatch.label = trimmedName;
  const resource = await updateResource(resourceId, resourcePatch);
  const { data, error } = await supabase
    .from("student_attachments")
    .update({ display_label: trimmedName || null })
    .eq("id", attachmentId)
    .select("*")
    .single();
  if (error) throw error;
  return { attachment: attachmentFromRow(data), resource };
}

/**
 * Delete an attachment. Takes the full (camelCase) row.
 *
 * Shared-file-safe (8.3a): remove the storage object ONLY for a plain upload —
 * a file the attachment owns and nothing else shares: kind='file',
 * storage_path set, AND resource_id null. When resource_id is set (a published
 * upload), the linked resources row shares the same stored file, so we SKIP the
 * storage removal and delete only the attachment row; the resources row keeps
 * the file and becomes an independent library item. Pure references and links
 * own no storage object, so nothing is removed for them. A storage-remove
 * failure is logged and ignored (leftover objects are tolerable, orphan rows
 * are not). RLS restricts deletes to the author.
 *
 * @param {Object} row  a mapped attachment (see attachmentFromRow)
 * @returns {Promise<boolean>}
 */
export async function deleteAttachment(row) {
  if (row.kind === "file" && row.storagePath && !row.resourceId) {
    const { error: rmErr } = await supabase.storage
      .from(ATTACHMENTS_BUCKET)
      .remove([row.storagePath]);
    if (rmErr) console.error("deleteAttachment: storage remove failed (continuing):", rmErr);
  }
  const { error } = await supabase
    .from("student_attachments")
    .delete()
    .eq("id", row.id);
  if (error) throw error;
  return true;
}

/**
 * Override (or clear) an attachment's displayed label. A non-empty
 * label is stored in display_label; empty/null clears it back to the
 * default (page title for links, file name for files). RLS restricts
 * updates to the author.
 *
 * @param {string} id
 * @param {string|null} newLabel
 * @returns {Promise<Object>} the updated attachment
 */
export async function renameAttachment(id, newLabel) {
  const trimmed = (newLabel || "").trim();
  const { data, error } = await supabase
    .from("student_attachments")
    .update({ display_label: trimmed || null })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return attachmentFromRow(data);
}

/**
 * Short-lived (60s) signed URL for a stored file. Renewed per click /
 * per preview rather than cached long-term.
 *
 * @param {string} storagePath
 * @returns {Promise<string>}
 */
export async function getAttachmentSignedUrl(storagePath) {
  const { data, error } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .createSignedUrl(storagePath, 60);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Subscribe to attachment changes for one subject. Mirrors
 * subscribeToSubjectNotes: a single postgres_changes channel filtered
 * by subject_id, invoking onChange for INSERT / UPDATE / DELETE.
 *
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId
 * @param {(payload: Object) => void} onChange
 * @returns {() => void} unsubscribe
 */
export function subscribeToSubjectAttachments(subjectType, subjectId, onChange) {
  const channel = supabase
    .channel(`student_attachments:${subjectType}:${subjectId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "student_attachments",
        filter: `subject_id=eq.${subjectId}`,
      },
      payload => onChange(payload)
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

// ── Pinning ──────────────────────────────────────────────────

/**
 * Idempotent pin. Upserts on the composite PK so re-pinning an
 * already-pinned subject is a no-op (pinned_at is left to the DB
 * default on first insert and untouched on conflict).
 *
 * @param {string} teacherId
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId
 */
export async function pinSubject(teacherId, subjectType, subjectId) {
  const { error } = await supabase
    .from("teacher_pinned_subjects")
    .upsert(
      { teacher_id: teacherId, subject_type: subjectType, subject_id: subjectId },
      { onConflict: "teacher_id,subject_type,subject_id" }
    );
  if (error) throw error;
}

/**
 * Remove a pin by its full composite key.
 *
 * @param {string} teacherId
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId
 */
export async function unpinSubject(teacherId, subjectType, subjectId) {
  const { error } = await supabase
    .from("teacher_pinned_subjects")
    .delete()
    .match({ teacher_id: teacherId, subject_type: subjectType, subject_id: subjectId });
  if (error) throw error;
}

/**
 * Whether the subject is currently pinned by this teacher.
 *
 * @param {string} teacherId
 * @param {'student'|'group'} subjectType
 * @param {string} subjectId
 * @returns {Promise<boolean>}
 */
export async function isPinned(teacherId, subjectType, subjectId) {
  const { data, error } = await supabase
    .from("teacher_pinned_subjects")
    .select("teacher_id")
    .match({ teacher_id: teacherId, subject_type: subjectType, subject_id: subjectId })
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/**
 * All pins for a teacher, most-recently-pinned first. Convenience
 * for cluster 2's left-panel "Pinned" section.
 *
 * @param {string} teacherId
 * @returns {Promise<Array>} camelCase pin rows (see pinFromRow)
 */
export async function getMyPinnedSubjects(teacherId) {
  const { data, error } = await supabase
    .from("teacher_pinned_subjects")
    .select("*")
    .eq("teacher_id", teacherId)
    .order("pinned_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(pinFromRow);
}

// ── Shared class-sort helper ─────────────────────────────────
//
// Lives here per the cluster 1 dispatch default: no existing
// class-name / year-level sort helper exists anywhere in src/utils
// (grep-confirmed), so there was no more-natural home. Both apps'
// list panels (cluster 2) consume this; if a broader class-handling
// util emerges later it can move with the callers updated.

/**
 * Sort key for class names, per spec §6. Prep/Foundation (names
 * starting P or F) rank first, then numeric grades by number then
 * suffix, then anything else. Use as an Array.prototype.sort key.
 *
 * @param {string} className
 * @returns {Array} comparator key (lexicographically comparable)
 */
export function classSortKey(className) {
  if (/^[PpFf]/.test(className)) {
    return [0, className.toLowerCase()];
  }
  const m = className.match(/^(\d+)(.*)$/);
  if (m) {
    return [1, parseInt(m[1], 10), m[2].toLowerCase()];
  }
  return [2, className.toLowerCase()];
}
