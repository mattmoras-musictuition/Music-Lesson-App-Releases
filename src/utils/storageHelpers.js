// ============================================================
// SUPABASE STORAGE HELPERS
// Shared upload / signed-URL / delete utilities for the two
// session 96 buckets:
//   resources          — parent-facing (Hal Leonard method books,
//                        exported timetables, anything you'd link
//                        in an email). PUBLIC bucket — getPublicUrl()
//                        returns stable URLs that work without auth,
//                        so email recipients can click through.
//   teacher-documents  — internal (WWCC, insurance, policies).
//                        PRIVATE bucket. Needs createSignedUrl()
//                        with ~1hr expiry for view-in-app; email
//                        attachments read bytes directly so expiry
//                        is moot for email.
// Both buckets were pre-created in Supabase before this session;
// this file just wires their exact names into one place so changing
// them later is a single-point edit.
// ============================================================

import { supabase } from "../supabaseClient";

export const BUCKET_RESOURCES = "resources";
export const BUCKET_DOCUMENTS = "teacher-documents";
// Private bucket holding teacher voice-note audio uploaded by the teacher app.
// Read-only here (admin plays via signed URLs); admin never uploads to it.
export const BUCKET_VOICE_NOTES = "voice-notes";

// Path pattern: <id>/<timestamp>-<random>.<ext>. ID scopes files to the
// logical record (resource/document/timetable-export) so deletes can also
// clear by prefix. Random suffix prevents collisions on rapid re-upload.
export function makeStoragePath(recordId, filename) {
  const ext = (filename.split(".").pop() || "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${recordId}/${Date.now()}-${rand}.${ext}`;
}

// Upload a File blob to the given bucket. Returns { storagePath, publicUrl? }
// on success, null on failure (caller should notify). publicUrl is only
// returned for the public bucket; private-bucket callers should sign on demand.
export async function uploadToBucket(bucket, storagePath, file) {
  try {
    const { error } = await supabase.storage
      .from(bucket)
      .upload(storagePath, file, { contentType: file.type || "application/octet-stream", upsert: false });
    if (error) throw error;
    let publicUrl = null;
    if (bucket === BUCKET_RESOURCES) {
      const res = supabase.storage.from(bucket).getPublicUrl(storagePath);
      publicUrl = res?.data?.publicUrl || null;
    }
    return { storagePath, publicUrl };
  } catch (e) {
    console.warn("[storage] upload failed", bucket, storagePath, e?.message || e);
    return null;
  }
}

// Generate a short-lived signed URL for a private bucket. Defaults to the
// teacher-documents bucket (existing callers); pass BUCKET_VOICE_NOTES to sign
// a voice-note audio object instead. 3600s = 1hr; enough for a user clicking
// View / Play, reloading once, etc.
export async function signedUrlFor(storagePath, expiresIn = 3600, bucket = BUCKET_DOCUMENTS) {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(storagePath, expiresIn);
    if (error) throw error;
    return data?.signedUrl || null;
  } catch (e) {
    console.warn("[storage] sign failed", bucket, storagePath, e?.message || e);
    return null;
  }
}

// Download file bytes from either bucket. Used when attaching to emails —
// we need the raw bytes as base64 regardless of public/private status, so
// this routes via supabase.storage.download() which works for both buckets
// when the user is authenticated.
export async function downloadAsBase64(bucket, storagePath) {
  try {
    const { data, error } = await supabase.storage.from(bucket).download(storagePath);
    if (error) throw error;
    // data is a Blob. Convert to base64 via FileReader.
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(data);
    });
  } catch (e) {
    console.warn("[storage] download failed", bucket, storagePath, e?.message || e);
    return null;
  }
}

// Delete an object from a bucket. Non-fatal on failure (row can still be
// removed locally; orphaned blob will linger until manual cleanup).
export async function deleteFromBucket(bucket, storagePath) {
  if (!storagePath) return true;
  try {
    const { error } = await supabase.storage.from(bucket).remove([storagePath]);
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn("[storage] delete failed", bucket, storagePath, e?.message || e);
    return false;
  }
}
