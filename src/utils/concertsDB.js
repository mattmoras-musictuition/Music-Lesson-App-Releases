// ============================================================
// concertsDB.js — Supabase data-access for `concerts`,
// `concert_items` and `concert_item_attachments`
// (Concerts workstream, clusters 2 and 3).
//
// PER-ROW reads and writes throughout. Deliberately NOT the
// whole-list upsert + delete-not-in-list sweep that bandsDB /
// documentsDB use: spec §8 requires that two people editing
// different pieces at the same time cannot overwrite each
// other, and §4.4 gives every authenticated user full edit
// rights on every item. A whole-list sync would let the last
// writer silently delete the other's work. resourcesDB.js is
// the precedent followed here, not bandsDB.js.
//
// Mappers allow-list columns in BOTH directions. A column
// missing from either mapper vanishes silently (the
// teacherCoverageDB cautionary case) — so if the schema gains
// a column, both fromRow and toRow must learn about it.
//
// RLS on all three tables is FOR ALL TO authenticated USING
// (true) WITH CHECK (true) — flat permissions, intentional
// (§4.4). concert_item_attachments.created_by is display-only
// and must NEVER gate an action; the author-only model on
// student_attachments is deliberately NOT ported.
// ============================================================

import { supabase } from "../supabaseClient";
import { BUCKET_RESOURCES, uploadToBucket, deleteFromBucket, signedUrlFor } from "./storageHelpers";

// ── Normalisation ────────────────────────────────────────────

// One performer, with all three keys guaranteed present so no
// downstream code has to test for undefined. Spec §5.2: exactly
// one of studentId / name is populated — that invariant is
// enforced by the editor, not here; this only guarantees shape.
function normalisePerformer(p) {
  const src = (p && typeof p === "object") ? p : {};
  return {
    studentId:  src.studentId  || "",
    name:       src.name       || "",
    instrument: src.instrument || "",
  };
}

// One accompanying teacher. Same element shape as bands.personnel
// ({ teacherId, instrument }), which is what makes the band copy
// in §4.1 a straight assignment with no translation layer.
function normalisePersonnel(p) {
  const src = (p && typeof p === "object") ? p : {};
  return {
    teacherId:  src.teacherId  || "",
    instrument: src.instrument || "",
  };
}

// A jsonb column that should hold an array. Null, a JSON string,
// or a non-array all collapse to []. Never throws.
function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  return [];
}

// ── Mappers: concerts ────────────────────────────────────────

function concertFromRow(row) {
  return {
    id:        row.id,
    schoolId:  row.school_id  || "",
    title:     row.title      || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
  };
}

// created_at / updated_at are deliberately absent: created_at is
// left to the DB default and updated_at is stamped explicitly by
// the write that changes something.
function concertToRow(concert) {
  return {
    id:        concert.id,
    school_id: concert.schoolId || "",
    // concerts.title is nullable — '' and null both mean "no
    // heading yet". Store '' so reads never have to branch.
    title:     concert.title    || "",
  };
}

// ── Mappers: concert_items ───────────────────────────────────

function itemFromRow(row) {
  return {
    id:         row.id,
    concertId:  row.concert_id || "",
    position:   typeof row.position === "number" ? row.position : 0,
    title:      row.title      || "",
    // band_id is a nullable FK (ON DELETE SET NULL). A deleted band
    // leaves the piece intact with bandId null — §4.1.
    bandId:     row.band_id    || null,
    performers: jsonArray(row.performers).map(normalisePerformer),
    personnel:  jsonArray(row.personnel).map(normalisePersonnel),
    notes:      row.notes      || "",
    createdAt:  row.created_at || "",
    updatedAt:  row.updated_at || "",
  };
}

function itemToRow(item) {
  return {
    id:         item.id,
    concert_id: item.concertId,
    position:   typeof item.position === "number" ? item.position : 0,
    // concert_items.title is text NOT NULL DEFAULT '' — never send null.
    title:      item.title || "",
    // band_id is an FK: '' would violate it, so absent must be null.
    band_id:    item.bandId || null,
    // performers / personnel are jsonb NOT NULL DEFAULT '[]'.
    performers: (item.performers || []).map(normalisePerformer),
    personnel:  (item.personnel  || []).map(normalisePersonnel),
    // notes is nullable; '' means "no note" and reads fine either way.
    notes:      item.notes || "",
  };
}

// The subset of item fields a partial update may touch, each with its
// column name and coercion. Anything outside this list is dropped
// rather than written — so a stray UI field (_isNew, a resolved
// student object, the editor's per-row `mode`) can never reach the DB.
// One table rather than two parallel ones so the column map and the
// coercion map cannot drift apart.
const ITEM_PATCH_FIELDS = {
  position:   { column: "position",   coerce: (v) => (typeof v === "number" ? v : 0) },
  title:      { column: "title",      coerce: (v) => v || "" },
  bandId:     { column: "band_id",    coerce: (v) => v || null },
  performers: { column: "performers", coerce: (v) => (v || []).map(normalisePerformer) },
  personnel:  { column: "personnel",  coerce: (v) => (v || []).map(normalisePersonnel) },
  notes:      { column: "notes",      coerce: (v) => v || "" },
};

// ── Concerts ─────────────────────────────────────────────────

/**
 * The school's concert row, created on first access.
 *
 * concerts.school_id is UNIQUE, so two clients opening the same
 * school for the first time will race: one insert wins, the other
 * gets 23505 (unique_violation). That is the expected outcome, not
 * an error — re-select and return the winner's row.
 *
 * @param {string} schoolId
 * @returns {Promise<Object>} mapped concert (see concertFromRow)
 */
export async function getOrCreateConcertForSchool(schoolId) {
  if (!schoolId) throw new Error("No school selected");

  const existing = await selectConcertBySchool(schoolId);
  if (existing) return existing;

  const { data, error } = await supabase
    .from("concerts")
    .insert(concertToRow({ id: crypto.randomUUID(), schoolId, title: "" }))
    .select("*")
    .single();

  if (error) {
    // 23505 = unique_violation on school_id: someone else created it
    // between our select and our insert. Theirs is as good as ours.
    if (error.code === "23505") {
      const raced = await selectConcertBySchool(schoolId);
      if (raced) return raced;
    }
    throw new Error(error.message);
  }
  return concertFromRow(data);
}

// Select-only half of getOrCreateConcertForSchool. maybeSingle() so
// "no row yet" is a null result rather than a thrown error.
async function selectConcertBySchool(schoolId) {
  const { data, error } = await supabase
    .from("concerts")
    .select("*")
    .eq("school_id", schoolId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? concertFromRow(data) : null;
}

/**
 * Set the concert's program heading. Empty is allowed (§4.7 — the
 * title is expected to be re-typed each year, and blank in the
 * meantime is a legitimate state).
 *
 * @param {string} concertId
 * @param {string} title
 * @returns {Promise<Object>} the updated concert
 */
export async function updateConcertTitle(concertId, title) {
  const { data, error } = await supabase
    .from("concerts")
    .update({ title: title || "", updated_at: new Date().toISOString() })
    .eq("id", concertId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return concertFromRow(data);
}

// ── Concert items ────────────────────────────────────────────

/**
 * All pieces for a concert in running order.
 *
 * Ordered by position, then created_at as a tiebreak — positions can
 * legitimately collide for a moment (two clients inserting at once
 * both compute the same max+1), and without the tiebreak the render
 * order of the colliding pair would be arbitrary between reloads.
 *
 * @param {string} concertId
 * @returns {Promise<Array>} mapped items (see itemFromRow)
 */
export async function getConcertItems(concertId) {
  if (!concertId) return [];
  const { data, error } = await supabase
    .from("concert_items")
    .select("*")
    .eq("concert_id", concertId)
    .order("position",   { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(itemFromRow);
}

/**
 * Append a piece to the end of the running order.
 *
 * position defaults to (highest existing position + 1), read fresh
 * rather than derived from a possibly-stale in-memory list.
 *
 * @param {string} concertId
 * @param {Object} fields  camelCase item fields; position optional
 * @returns {Promise<Object>} the inserted item
 */
export async function createConcertItem(concertId, fields) {
  if (!concertId) throw new Error("No concert");
  const item = fields || {};

  let position = item.position;
  if (typeof position !== "number") position = await nextPosition(concertId);

  const { data, error } = await supabase
    .from("concert_items")
    .insert(itemToRow({ ...item, id: crypto.randomUUID(), concertId, position }))
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return itemFromRow(data);
}

// Highest position currently in use for this concert, + 1. An empty
// concert starts at 0.
async function nextPosition(concertId) {
  const { data, error } = await supabase
    .from("concert_items")
    .select("position")
    .eq("concert_id", concertId)
    .order("position", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const highest = (data || [])[0]?.position;
  return typeof highest === "number" ? highest + 1 : 0;
}

/**
 * Partial update of one piece. Only the keys present in `fields`
 * and named in ITEM_PATCH_COLUMNS are written; everything else on
 * the row is left alone, so a concurrent edit to a different field
 * of the same piece is not clobbered.
 *
 * updated_at is stamped explicitly — a column default only fires on
 * INSERT, so without this an updated row keeps its original stamp.
 *
 * @param {string} itemId
 * @param {Object} fields  camelCase partial patch
 * @returns {Promise<Object>} the updated item
 */
export async function updateConcertItem(itemId, fields) {
  const patch = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const field = ITEM_PATCH_FIELDS[key];
    if (!field) continue;           // not an updatable column — drop it
    patch[field.column] = field.coerce(value);
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("concert_items")
    .update(patch)
    .eq("id", itemId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return itemFromRow(data);
}

/**
 * Delete one piece. The remaining items keep their stored positions
 * — gaps are harmless because the displayed number is derived from
 * array index, never from position (§8).
 *
 * @param {string} itemId
 * @returns {Promise<boolean>}
 */
export async function deleteConcertItem(itemId) {
  const { error } = await supabase
    .from("concert_items")
    .delete()
    .eq("id", itemId);
  if (error) throw new Error(error.message);
  return true;
}

/**
 * Persist a reorder by writing ONLY the rows whose position changed
 * (§8). The caller diffs old against new order and passes just the
 * movers; a drag that shifts three items writes three rows, not the
 * whole list — so a piece someone else is editing is never touched.
 *
 * Deliberately individual UPDATEs rather than an upsert: an upsert
 * on a row another client just deleted would take the INSERT branch
 * and try to create a bogus row with no concert_id (NOT NULL). An
 * UPDATE against a missing id simply affects nothing.
 *
 * @param {Array<{id: string, position: number}>} changedRows
 * @returns {Promise<number>} how many rows were written
 */
export async function reorderConcertItems(changedRows) {
  const rows = (changedRows || []).filter(r => r && r.id && typeof r.position === "number");
  if (rows.length === 0) return 0;

  const stamp = new Date().toISOString();
  const results = await Promise.all(rows.map(row =>
    supabase
      .from("concert_items")
      .update({ position: row.position, updated_at: stamp })
      .eq("id", row.id)
  ));

  const failed = results.find(r => r.error);
  if (failed) throw new Error(failed.error.message);
  return rows.length;
}

/**
 * Delete every piece for a concert (§4.5 "Clear all items"). The
 * concert row and its title survive so next year's list starts
 * against the same record.
 *
 * @param {string} concertId
 * @returns {Promise<boolean>}
 */
export async function clearConcertItems(concertId) {
  if (!concertId) return false;
  const { error } = await supabase
    .from("concert_items")
    .delete()
    .eq("concert_id", concertId);
  if (error) throw new Error(error.message);
  return true;
}

// ════════════════════════════════════════════════════════════
// ATTACHMENTS — concert_item_attachments (cluster 3)
// ════════════════════════════════════════════════════════════
//
// Concerts have their own attachment table rather than reusing
// student_attachments, which carries three things incompatible
// with §4.4: CHECK (subject_type IN ('student','group')),
// author-only RLS on update/delete, and a NOT NULL author_id
// FK to teachers (an admin may have no teacher record).
//
// Files live in the shared `resources` bucket under a
// concert-attachments/ prefix so they are identifiable
// alongside teaching-material uploads.
//
// NOTE: `resources` is a PUBLIC bucket. Signing an object in it
// is defence-in-depth, not access control — the same property
// student-notes attachments already have. Do not treat a
// concert attachment as private.
//
// Three row shapes, enforced by the CHECK constraint
// concert_attachment_kind_fields_match:
//   • file      — storage_path + file_name set, link columns null
//   • link      — url set, file columns AND resource_id null
//   • reference — every payload column null, resource_id set
// Unused payload columns must be NULL, never '' — an empty
// string is not null and would violate the constraint.
//
// There is deliberately NO publish-to-library path here. See the
// comment on addLibraryReference.

const ATTACHMENTS_BUCKET = BUCKET_RESOURCES;
const ATTACHMENTS_PREFIX = "concert-attachments";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB, matching student notes

// Mirrors studentNotesDB.sanitizeFileName — the stored object name
// is ASCII-safe and length-capped; the original name is preserved
// verbatim in the file_name column for display.
function sanitizeFileName(name) {
  return (name || "file")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .slice(0, 80);
}

/**
 * Derive an attachment's kind from its row shape, so UI code never
 * re-derives it. Mirrors studentNotesDB.classifyAttachment.
 *
 * A reference stays a reference even after its library item is
 * deleted (the FK clears resource_id) — it owns no payload either
 * way. `inLibrary` says whether the link is still intact.
 */
export function classifyConcertAttachment(att) {
  const isFile      = !!att.storagePath;
  const isLink      = !att.storagePath && !!att.url;
  const isReference = !att.storagePath && !att.url;
  const inLibrary   = !!att.resourceId;
  return { isFile, isLink, isReference, inLibrary };
}

function attachmentFromRow(row) {
  const att = {
    id:            row.id,
    concertItemId: row.concert_item_id || "",
    kind:          row.kind            || "",
    storagePath:   row.storage_path    || null,
    fileName:      row.file_name       || null,
    fileSizeBytes: row.file_size_bytes ?? null,
    mimeType:      row.mime_type       || null,
    url:           row.url             || null,
    pageTitle:     row.page_title      || null,
    ogImageUrl:    row.og_image_url    || null,
    displayLabel:  row.display_label   || null,
    resourceId:    row.resource_id     || null,
    createdBy:     row.created_by      || null,
    createdAt:     row.created_at      || "",
  };
  return { ...att, ...classifyConcertAttachment(att) };
}

/**
 * In-memory attachment → DB row, allow-listed and shaped to the
 * CHECK constraint. Branches on kind rather than emitting one
 * generic object, because "unused" is null here and a stray ''
 * in a payload column would be rejected.
 *
 * id and created_at are omitted — both have DB defaults.
 */
function attachmentToRow(att) {
  const base = {
    concert_item_id: att.concertItemId,
    kind:            att.kind,
    display_label:   att.displayLabel || null,
    created_by:      att.createdBy    || null,
    resource_id:     att.resourceId   || null,
  };

  if (att.storagePath) {
    // File row: file columns set, link columns null. May also carry
    // resource_id in principle, though concerts never set both.
    return {
      ...base,
      storage_path:    att.storagePath,
      file_name:       att.fileName || null,
      file_size_bytes: att.fileSizeBytes ?? null,
      mime_type:       att.mimeType || null,
      url:             null,
      page_title:      null,
      og_image_url:    null,
    };
  }

  if (att.url) {
    // Link row: url set, file columns null, and resource_id MUST be
    // null — the constraint does not allow a link to also be a
    // library reference.
    return {
      ...base,
      resource_id:     null,
      storage_path:    null,
      file_name:       null,
      file_size_bytes: null,
      mime_type:       null,
      url:             att.url,
      page_title:      att.pageTitle  || null,
      og_image_url:    att.ogImageUrl || null,
    };
  }

  // Reference row: every payload column null; resource_id carries it.
  return {
    ...base,
    storage_path:    null,
    file_name:       null,
    file_size_bytes: null,
    mime_type:       null,
    url:             null,
    page_title:      null,
    og_image_url:    null,
  };
}

/**
 * All attachments for one piece, oldest first.
 *
 * @param {string} concertItemId
 * @returns {Promise<Array>} mapped attachments
 */
export async function getAttachmentsForItem(concertItemId) {
  if (!concertItemId) return [];
  const { data, error } = await supabase
    .from("concert_item_attachments")
    .select("*")
    .eq("concert_item_id", concertItemId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(attachmentFromRow);
}

/**
 * Attachments for many pieces in ONE query, so rendering N rows
 * costs one request rather than N.
 *
 * @param {Array<string>} concertItemIds
 * @returns {Promise<Map<string, Array>>} item id → its attachments
 *   (oldest first). Items with none are absent from the map; callers
 *   should treat a miss as an empty list.
 */
export async function getAttachmentsForItems(concertItemIds) {
  const ids = (concertItemIds || []).filter(Boolean);
  const byItem = new Map();
  if (ids.length === 0) return byItem;

  const { data, error } = await supabase
    .from("concert_item_attachments")
    .select("*")
    .in("concert_item_id", ids)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  for (const row of data || []) {
    const att = attachmentFromRow(row);
    const list = byItem.get(att.concertItemId);
    if (list) list.push(att);
    else byItem.set(att.concertItemId, [att]);
  }
  return byItem;
}

/**
 * Upload a file and attach it to a piece.
 *
 * The row id is generated client-side so it can name the storage
 * object, keeping blob and row trivially correlated. If the row
 * insert fails after a successful upload, the object is removed —
 * otherwise a failed attach would silently leave an orphan blob in
 * the bucket that nothing references and nobody can find.
 *
 * @param {string} concertItemId
 * @param {File} file
 * @param {{displayLabel?: string, createdBy?: string}} opts
 * @returns {Promise<Object>} the inserted attachment
 */
export async function uploadFileAttachment(concertItemId, file, opts = {}) {
  if (!concertItemId) throw new Error("No concert piece");
  if (!file) throw new Error("No file provided");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("File too large — 10 MB max");

  const id = crypto.randomUUID();
  const storagePath = `${ATTACHMENTS_PREFIX}/${concertItemId}/${id}-${sanitizeFileName(file.name)}`;

  // uploadToBucket swallows its error and returns null rather than
  // throwing (see storageHelpers) — so a null result IS the failure.
  const uploaded = await uploadToBucket(ATTACHMENTS_BUCKET, storagePath, file);
  if (!uploaded) throw new Error("Upload failed — try again");

  const row = attachmentToRow({
    concertItemId,
    kind: "file",
    storagePath,
    fileName: file.name,
    fileSizeBytes: file.size,
    mimeType: file.type || null,
    displayLabel: (opts.displayLabel || "").trim() || null,
    createdBy: opts.createdBy || null,
  });

  const { data, error } = await supabase
    .from("concert_item_attachments")
    .insert({ id, ...row })
    .select("*")
    .single();

  if (error) {
    // Roll the upload back so the bucket doesn't accumulate blobs no
    // row points at. Best-effort: deleteFromBucket is non-fatal, and
    // the insert error is the one worth surfacing either way.
    await deleteFromBucket(ATTACHMENTS_BUCKET, storagePath);
    throw new Error(error.message);
  }
  return attachmentFromRow(data);
}

/**
 * Attach a pasted link.
 *
 * pageTitle / ogImageUrl are accepted from the caller rather than
 * fetched here — the fetch-page-meta enrichment student notes uses
 * is not wired up for concerts, and a link attachment is perfectly
 * usable without it.
 *
 * @param {string} concertItemId
 * @param {string} url
 * @param {{displayLabel?: string, pageTitle?: string, ogImageUrl?: string, createdBy?: string}} opts
 * @returns {Promise<Object>} the inserted attachment
 */
export async function addLinkAttachment(concertItemId, url, opts = {}) {
  if (!concertItemId) throw new Error("No concert piece");
  const trimmed = (url || "").trim();
  if (!trimmed) throw new Error("No URL provided");
  try { new URL(trimmed); } catch { throw new Error("Invalid URL"); }

  const row = attachmentToRow({
    concertItemId,
    kind: "link",
    url: trimmed,
    pageTitle:    (opts.pageTitle  || "").trim() || null,
    ogImageUrl:   opts.ogImageUrl  || null,
    displayLabel: (opts.displayLabel || "").trim() || null,
    createdBy:    opts.createdBy   || null,
  });

  const { data, error } = await supabase
    .from("concert_item_attachments")
    .insert(row)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return attachmentFromRow(data);
}

/**
 * Attach something already in the Resource Library by reference.
 * A payload-empty row carrying only resource_id — no file is copied
 * and no bytes are uploaded.
 *
 * `kind` still has to satisfy the NOT NULL CHECK (kind IN
 * ('file','link')), so it describes what the referenced resource IS
 * (for the icon), not what this row owns.
 *
 * There is deliberately no inverse of this — concerts never publish
 * INTO the library. publishUploadToLibrary hardcodes
 * source: "student_note" and writes source_subject_type from its
 * caller, so a concert publish would create a library row
 * mislabelled as originating from Student Notes, whose subject then
 * resolves to nothing. Widening the library's source taxonomy for a
 * marginal feature isn't worth it; concerts simply don't publish.
 *
 * @param {string} concertItemId
 * @param {string} resourceId
 * @param {{displayLabel?: string, createdBy?: string, kind?: 'file'|'link'}} opts
 * @returns {Promise<Object>} the inserted attachment
 */
export async function addLibraryReference(concertItemId, resourceId, opts = {}) {
  if (!concertItemId) throw new Error("No concert piece");
  if (!resourceId) throw new Error("No resource provided");

  const row = attachmentToRow({
    concertItemId,
    kind: opts.kind === "link" ? "link" : "file",
    resourceId,
    displayLabel: (opts.displayLabel || "").trim() || null,
    createdBy:    opts.createdBy || null,
  });

  const { data, error } = await supabase
    .from("concert_item_attachments")
    .insert(row)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return attachmentFromRow(data);
}

/**
 * Override (or clear) an attachment's displayed label. Empty clears
 * back to the default (file name, page title, or the library item's
 * own label).
 *
 * @param {string} attachmentId
 * @param {string|null} displayLabel
 * @returns {Promise<Object>} the updated attachment
 */
export async function renameAttachment(attachmentId, displayLabel) {
  const trimmed = (displayLabel || "").trim();
  const { data, error } = await supabase
    .from("concert_item_attachments")
    .update({ display_label: trimmed || null })
    .eq("id", attachmentId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return attachmentFromRow(data);
}

/**
 * Delete an attachment, and its stored file when it owns one.
 *
 * The row is re-read rather than trusted from caller state, so the
 * storage decision is made against what the database actually holds.
 *
 * Shared-file safety: a concert file object is EXCLUSIVELY owned.
 * Its path is minted here (concert-attachments/<item>/<uuid>-…) and
 * concerts never publish to the library, so no `resources` row can
 * ever point at it — unlike student-notes published uploads, where
 * attachment and library row share one blob. A library REFERENCE
 * owns no storage at all (storage_path null), so the guard below
 * also stops it deleting the library's file. Deleting the referenced
 * resource itself is never in scope here.
 *
 * Available to anyone — §4.4. created_by is not consulted.
 *
 * @param {string} attachmentId
 * @returns {Promise<boolean>}
 */
export async function deleteAttachment(attachmentId) {
  if (!attachmentId) return false;

  const { data: existing, error: readErr } = await supabase
    .from("concert_item_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);

  const { error } = await supabase
    .from("concert_item_attachments")
    .delete()
    .eq("id", attachmentId);
  if (error) throw new Error(error.message);

  // Row first, blob second: a leftover blob is tolerable, a row
  // pointing at a deleted blob is not. Non-fatal by design.
  if (existing?.storage_path) {
    await deleteFromBucket(ATTACHMENTS_BUCKET, existing.storage_path);
  }
  return true;
}

/**
 * Short-lived signed URL for a stored file, renewed per click.
 *
 * signedUrlFor defaults its bucket to teacher-documents, so the
 * bucket MUST be passed explicitly here.
 *
 * @param {string} storagePath
 * @param {number} expiresIn  seconds; 60 matches student notes
 * @returns {Promise<string|null>} null when signing fails
 */
export async function getAttachmentSignedUrl(storagePath, expiresIn = 60) {
  if (!storagePath) return null;
  return signedUrlFor(storagePath, expiresIn, ATTACHMENTS_BUCKET);
}
