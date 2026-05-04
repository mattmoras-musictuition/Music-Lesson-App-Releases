// ============================================================
// documentsDB.js — Supabase load/sync for documents
// ============================================================

import { supabase } from "../supabaseClient";

function rowToDocument(row) {
  return {
    id:          row.id,
    label:       row.label        || "",
    type:        row.type         || "",
    teacherId:   row.teacher_id   || "",
    schoolId:    row.school_id    || "",
    expiryDate:  row.expiry_date  || "",
    url:         row.url          || "",
    notes:       row.notes        || "",
    storage_path: row.storage_path || "",
    filename:    row.filename     || "",
    size_bytes:  row.size_bytes   ?? null,
    mime_type:   row.mime_type    || "",
  };
}

function documentToRow(document, userId) {
  return {
    id:          document.id,
    user_id:     userId,
    label:       document.label       || "",
    type:        document.type        || "",
    teacher_id:  document.teacherId   || "",
    school_id:   document.schoolId    || "",
    expiry_date: document.expiryDate  || null,
    url:         document.url         || "",
    notes:       document.notes       || "",
    storage_path: document.storage_path || "",
    filename:    document.filename    || "",
    size_bytes:  document.size_bytes  ?? null,
    mime_type:   document.mime_type   || "",
  };
}

export async function loadDocumentsFromSupabase() {
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .order("label", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToDocument);
}

export async function syncDocumentsToSupabase(documents, userId) {
  if (!userId) return;
  const rows = documents.map(d => documentToRow(d, userId));
  const { error: upsertError } = await supabase
    .from("documents")
    .upsert(rows, { onConflict: "id" });
  if (upsertError) throw new Error(upsertError.message);

  const currentIds = documents.map(d => d.id);
  if (currentIds.length === 0) return;
  const { error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("user_id", userId)
    .not("id", "in", `(${currentIds.join(",")})`);
  if (deleteError) throw new Error(deleteError.message);
}
