// ============================================================
// concertsDB.js — Supabase data-access for `concerts` and
// `concert_items` (Concerts workstream, cluster 2).
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
// RLS on both tables is FOR ALL TO authenticated USING (true)
// WITH CHECK (true) — flat permissions, intentional (§4.4).
// ============================================================

import { supabase } from "../supabaseClient";

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
