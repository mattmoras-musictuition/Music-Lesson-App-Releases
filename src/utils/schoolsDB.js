// ============================================================
// schoolsDB.js — Supabase read/write helpers for Schools
// All Supabase logic for the schools collection lives here.
// App.js calls these functions; nothing else needs to change.
// ============================================================

import { supabase } from "../supabaseClient";

// ── Shape converters ─────────────────────────────────────────
// The app uses camelCase; Supabase columns use snake_case.
// These two functions translate between them.

function toRow(school, userId) {
  return {
    id:                   school.id,
    user_id:              userId,
    name:                 school.name           || "",
    acronym:              school.acronym         || "",
    days:                 school.days            || [],
    slots:                school.slots           || [],
    specialist_policy:    school.specialistPolicy || "prefer-not",
    teacher_breaks:       school.teacherBreaks   || [],
    newsletter_url:       school.newsletterUrl   || "",
    newsletter_guidance:  school.newsletterGuidance || "",
    sender_email:         school.senderEmail     || "",
    timetable_upload_url: school.timetableUploadUrl || "",
    notes:                school.notes           || "",
    color:                school.color           || "",
    updated_at:           new Date().toISOString(),
  };
}

function fromRow(row) {
  return {
    id:                  row.id,
    name:                row.name                 || "",
    acronym:             row.acronym              || "",
    days:                row.days                 || [],
    slots:               row.slots                || [],
    specialistPolicy:    row.specialist_policy    || "prefer-not",
    teacherBreaks:       row.teacher_breaks       || [],
    newsletterUrl:       row.newsletter_url       || "",
    newsletterGuidance:  row.newsletter_guidance  || "",
    senderEmail:         row.sender_email         || "",
    timetableUploadUrl:  row.timetable_upload_url || "",
    notes:               row.notes                || "",
    color:               row.color                || "",
  };
}

// ── Load ─────────────────────────────────────────────────────

/**
 * Load all schools for the current user from Supabase.
 * Returns an array of school objects in the app's camelCase shape.
 * Throws on network/auth error — caller should catch and fall back.
 */
export async function loadSchoolsFromSupabase() {
  const { data, error } = await supabase
    .from("schools")
    .select("*")
    .order("name");
  if (error) throw error;
  return (data || []).map(fromRow);
}

// ── Save (sync) ───────────────────────────────────────────────

/**
 * Sync the full schools array to Supabase.
 * - Upserts all schools currently in the app (handles add + edit)
 * - Deletes any Supabase rows that no longer exist in the local array
 *
 * Called from App.js whenever the schools state changes.
 * Throws on error — caller logs and continues (localStorage is the fallback).
 */
export async function syncSchoolsToSupabase(schools, userId) {
  if (!userId) throw new Error("No user ID — cannot sync schools");

  // 1. Upsert all current schools
  if (schools.length > 0) {
    const rows = schools.map(s => toRow(s, userId));
    const { error: upsertError } = await supabase
      .from("schools")
      .upsert(rows, { onConflict: "id" });
    if (upsertError) throw upsertError;
  }

  // 2. Delete any Supabase schools that no longer exist locally
  //    Fetch all Supabase IDs for this user first, then delete the extras.
  const { data: remoteRows, error: fetchError } = await supabase
    .from("schools")
    .select("id")
    .eq("user_id", userId);
  if (fetchError) throw fetchError;

  const localIds = new Set(schools.map(s => s.id));
  const toDelete = (remoteRows || [])
    .map(r => r.id)
    .filter(id => !localIds.has(id));

  if (toDelete.length > 0) {
    const { error: deleteError } = await supabase
      .from("schools")
      .delete()
      .in("id", toDelete);
    if (deleteError) throw deleteError;
  }
}
