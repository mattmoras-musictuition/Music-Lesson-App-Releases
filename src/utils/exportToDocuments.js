// ============================================================
// exportToDocuments.js — file a generated PDF into the Documents tab.
//
// Extracted verbatim from the uploadExportToDocuments useCallback that
// lived inside ExportDialog.js (Session 96), which was not exported and
// had type: "Timetable" and schoolId: "" hardcoded. The concert program
// (§4.7) needs the same upload-and-register behaviour under a different
// type and against a real school, so the implementation moved here and
// gained parameters rather than being copied. ExportDialog now calls
// this one — there is deliberately not a second implementation.
//
// ── WHY setDocuments AND NOT A DIRECT ROW WRITE ─────────────
// Documents are whole-list synced from App.js:2327 via
// syncDocumentsToSupabase, which upserts the in-memory list and then
// DELETES every row for the user that is not in it. A row written
// straight to Supabase is therefore not merely redundant — it is
// deleted the next time anything touches the documents list. Every
// caller must go through setDocuments so the new document is part of
// that list before the next sync runs.
// ============================================================

import { uid as makeId } from "./helpers";
import { BUCKET_DOCUMENTS, makeStoragePath, uploadToBucket } from "./storageHelpers";

/**
 * Upload a base64 PDF to the private documents bucket and register it as
 * a Document, so it appears in the Documents tab and becomes attachable
 * in emails via the template editor's auto-attach picker.
 *
 * Non-fatal on failure by design: callers do not await success, and a
 * failed upload must not take down the export it came from. A missing
 * setDocuments simply skips registration, exactly as before.
 *
 * @param {Object}   params
 * @param {string}   params.pdfBase64    — the rendered PDF
 * @param {string}   params.filename     — e.g. "Week 4 - SPS.pdf"
 * @param {string}   [params.label]      — Documents-tab label; defaults to filename sans .pdf
 * @param {Function} params.setDocuments — App's documents setter (see note above)
 * @param {string}   [params.type="Timetable"] — Documents "type" facet
 * @param {string}   [params.schoolId=""]      — owning school, "" for none
 * @returns {Promise<Object|null>} the registered document, or null if nothing was filed
 */
export async function uploadExportToDocuments({
  pdfBase64,
  filename,
  label,
  setDocuments,
  type = "Timetable",
  schoolId = "",
}) {
  if (!setDocuments || !pdfBase64) return null;
  try {
    // Convert base64 → Blob for Supabase upload. The storage SDK accepts
    // Blob/File/ArrayBuffer; a Blob is simplest here since we already have
    // the data as base64 and don't need to touch the filesystem.
    const byteChars = atob(pdfBase64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const docId = makeId();
    const storagePath = makeStoragePath(docId, filename);
    const res = await uploadToBucket(BUCKET_DOCUMENTS, storagePath, blob);
    if (!res) return null;
    const today = new Date().toISOString().slice(0, 10);
    const newDoc = {
      id: docId,
      label: label || filename.replace(/\.pdf$/, ""),
      type,
      teacherId: "", schoolId,
      expiryDate: "",
      url: "",
      notes: `Exported ${today}`,
      storage_path: storagePath,
      filename,
      size_bytes: blob.size,
      mime_type: "application/pdf",
    };
    setDocuments(prev => [newDoc, ...prev]);
    return newDoc;
  } catch (e) {
    console.warn("[export] Supabase upload failed:", e?.message || e);
    return null;
  }
}
