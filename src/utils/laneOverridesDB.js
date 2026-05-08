// ============================================================
// laneOverridesDB.js — Supabase read helpers for lane_overrides
//
// Spec 2 cluster 6 — per-week substitution overrides on a
// (week_key, bucket_id) tuple. A row says "for this WTT week,
// the lane normally covered by teacher_coverage[bucket_id]
// is instead covered by override_teacher_id". Resolution
// order is override-first, then lane, then stamped fallback.
//
// Cluster 6a: loader.
// Cluster 6c: surgical write helpers for the substitution UI
// (upsertLaneOverride / deleteLaneOverride).
// ============================================================

import { supabase } from "../supabaseClient";
import { uid } from "./helpers";

// ── Shape converter ──────────────────────────────────────────

// user_id is omitted from the returned shape — RLS implementation
// detail, not consumed by callers.
function fromRow(row) {
  return {
    id:                 row.id,
    weekKey:            row.week_key            || "",
    bucketId:           row.bucket_id           || "",
    overrideTeacherId:  row.override_teacher_id || "",
    createdAt:          row.created_at          || "",
    updatedAt:          row.updated_at          || "",
  };
}

// ── Load ─────────────────────────────────────────────────────

// Resolution lookup is by (weekKey, bucketId), so order doesn't matter.
// RLS scopes to auth.uid() = user_id (per the cluster 6 schema policy);
// no client-side .eq("user_id", ...) filter needed.
export async function loadLaneOverridesFromSupabase() {
  const { data, error } = await supabase
    .from("lane_overrides")
    .select("*");
  if (error) throw error;
  return (data || []).map(fromRow);
}

// ── Write helpers (cluster 6c — substitution UI) ─────────────

// Single-row upsert. If existingId is supplied, UPDATEs that row's
// override_teacher_id + updated_at; otherwise INSERTs a new row with
// a fresh uid(). Throws if userId is falsy. Returns a camelCase row
// shape matching fromRow's contract so callers can splice it into
// local state without re-fetching.
//
// Safe under the dev Proxy short-circuit: the supabase.from() call is
// suppressed in dev, but the returned object is built from the inputs,
// so local-state updates work in both dev and prod.
export async function upsertLaneOverride({ existingId, weekKey, bucketId, overrideTeacherId, userId }) {
  if (!userId) throw new Error("No user ID — cannot upsert lane override");
  const nowIso = new Date().toISOString();
  if (existingId) {
    const { error } = await supabase
      .from("lane_overrides")
      .update({ override_teacher_id: overrideTeacherId, updated_at: nowIso })
      .eq("id", existingId);
    if (error) throw error;
    return { id: existingId, weekKey, bucketId, overrideTeacherId, createdAt: nowIso, updatedAt: nowIso };
  }
  const id = uid();
  const { error } = await supabase
    .from("lane_overrides")
    .insert({ id, user_id: userId, week_key: weekKey, bucket_id: bucketId, override_teacher_id: overrideTeacherId });
  if (error) throw error;
  return { id, weekKey, bucketId, overrideTeacherId, createdAt: nowIso, updatedAt: nowIso };
}

// Single-row delete by id. Throws on supabase error.
export async function deleteLaneOverride({ id }) {
  const { error } = await supabase
    .from("lane_overrides")
    .delete()
    .eq("id", id);
  if (error) throw error;
}
