// ============================================================
// contactsDB.js — Supabase load/sync for contacts
// Pattern: same as schoolsDB, teachersDB, studentsDB
//
// loadContactsFromSupabase()            — read all rows for this user
// syncContactsToSupabase(contacts, userId) — upsert all, delete removed
// ============================================================

import { supabase } from "../supabaseClient";

// ── DB row → camelCase JS object ─────────────────────────────
function rowToContact(row) {
  return {
    id:          row.id,
    type:        row.type        || "school",
    name:        row.name        || "",
    schoolId:    row.school_id   || "",
    role:        row.role        || "",
    roleOther:   row.role_other  || "",
    className:   row.class_name  || "",
    email:       row.email       || "",
    phone:       row.phone       || "",
    cc:          row.cc          || "",
    notes:       row.notes       || "",
    relationship: row.relationship || "",
  };
}

// ── camelCase JS object → DB row ─────────────────────────────
function contactToRow(contact, userId) {
  return {
    id:           contact.id,
    user_id:      userId,
    type:         contact.type         || "school",
    name:         contact.name         || "",
    school_id:    contact.schoolId     || "",
    role:         contact.role         || "",
    role_other:   contact.roleOther    || "",
    class_name:   contact.className    || "",
    email:        contact.email        || "",
    phone:        contact.phone        || "",
    cc:           contact.cc           || "",
    notes:        contact.notes        || "",
    relationship: contact.relationship || "",
  };
}

// ── Load all contacts for the current user ───────────────────
export async function loadContactsFromSupabase() {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .order("name", { ascending: true });

  if (error) throw new Error(error.message);
  return (data || []).map(rowToContact);
}

// ── Sync local contacts array to Supabase ────────────────────
export async function syncContactsToSupabase(contacts, userId) {
  if (!userId) return;

  // 1. Upsert all current contacts
  const rows = contacts.map(c => contactToRow(c, userId));
  const { error: upsertError } = await supabase
    .from("contacts")
    .upsert(rows, { onConflict: "id" });

  if (upsertError) throw new Error(upsertError.message);

  // 2. Delete any Supabase rows no longer in the local array
  const currentIds = contacts.map(c => c.id);
  if (currentIds.length === 0) return;
  const { error: deleteError } = await supabase
    .from("contacts")
    .delete()
    .eq("user_id", userId)
    .not("id", "in", `(${currentIds.join(",")})`);

  if (deleteError) throw new Error(deleteError.message);
}
