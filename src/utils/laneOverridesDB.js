// ============================================================
// laneOverridesDB.js — Supabase read helpers for lane_overrides
//
// Spec 2 cluster 6 — per-week substitution overrides on a
// (week_key, bucket_id) tuple. A row says "for this WTT week,
// the lane normally covered by teacher_coverage[bucket_id]
// is instead covered by override_teacher_id". Resolution
// order is override-first, then lane, then stamped fallback.
//
// Cluster 6a (this file): loader only. No writes — cluster 6c
// adds syncLaneOverridesToSupabase alongside the substitution
// UI. Until then, lane_overrides has no row producers and
// callers see an empty array (no behaviour change).
// ============================================================

import { supabase } from "../supabaseClient";

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

// syncLaneOverridesToSupabase lands in cluster 6c (substitution UI).
