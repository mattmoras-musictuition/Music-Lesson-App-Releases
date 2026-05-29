// ============================================================
// resourceFoldersDB.js — Supabase data-access for the SHARED,
// nestable Resource Library folder tree.
//
// Two tables back this (created in the schema cluster, locked):
//   resource_folders      — the tree. Admin always writes
//                           scope='shared', owner_id=null,
//                           created_by=auth.uid().
//   resource_folder_items — which resources are filed DIRECTLY in
//                           which folder. PK (folder_id, resource_id).
//
// Admin-only writes are enforced by RLS (public.is_admin()); these
// helpers just do ordinary inserts/updates as the logged-in admin
// (same anon key as everywhere else — no service role). ON DELETE
// CASCADE on resource_folders handles subfolders + item links, so a
// folder delete is a single row delete.
// ============================================================

import { supabase } from "../supabaseClient";

// auth.uid() for the logged-in admin — set on created_by / added_by.
// Best-effort: a null uid lets the DB column default (which is also
// auth.uid()) take over, so a transient session read never blocks a write.
async function _authUid() {
  try {
    const { data } = await supabase.auth.getUser();
    return data?.user?.id || null;
  } catch {
    return null;
  }
}

// All shared folders as a flat list, ordered by position then name.
// The component shapes them into a tree via parent_id. Never returns
// personal-scope rows (admin only ever creates shared folders, and RLS
// keeps other scopes out of reach anyway).
export async function listSharedFolders() {
  const { data, error } = await supabase
    .from("resource_folders")
    .select("id, name, parent_id, position")
    .eq("scope", "shared")
    .order("position", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(f => ({
    id: f.id,
    name: f.name || "",
    parent_id: f.parent_id || null,
    position: f.position ?? 0,
  }));
}

// Create a shared folder (root when parentId is null, else a subfolder).
// position 0 — sibling ordering is by position then name (reorder deferred).
export async function createSharedFolder(name, parentId = null) {
  const created_by = await _authUid();
  const { data, error } = await supabase
    .from("resource_folders")
    .insert({
      name: (name || "").trim(),
      parent_id: parentId || null,
      scope: "shared",
      owner_id: null,
      position: 0,
      created_by,
    })
    .select("id, name, parent_id, position")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Rename a folder (label only).
export async function renameFolder(id, name) {
  const { error } = await supabase
    .from("resource_folders")
    .update({ name: (name || "").trim() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

// Delete a folder. ON DELETE CASCADE removes its subfolders and every
// resource_folder_items link beneath it — the resources themselves stay
// in the library (resource_folder_items only references resources.id).
export async function deleteFolder(id) {
  const { error } = await supabase
    .from("resource_folders")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
}

// Resource ids filed DIRECTLY in this folder (non-recursive).
export async function listFolderItemResourceIds(folderId) {
  if (!folderId) return [];
  const { data, error } = await supabase
    .from("resource_folder_items")
    .select("resource_id")
    .eq("folder_id", folderId)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(r => r.resource_id);
}

// File a resource into a folder. PK is (folder_id, resource_id), so a
// repeat filing is a no-op — upsert with ignoreDuplicates swallows the
// conflict without erroring.
export async function addResourceToFolder(folderId, resourceId) {
  const added_by = await _authUid();
  const { error } = await supabase
    .from("resource_folder_items")
    .upsert(
      { folder_id: folderId, resource_id: resourceId, position: 0, added_by },
      { onConflict: "folder_id,resource_id", ignoreDuplicates: true }
    );
  if (error) throw new Error(error.message);
}

// Remove a resource from one folder (the resource stays in the library
// and in any other folders it's filed in).
export async function removeResourceFromFolder(folderId, resourceId) {
  const { error } = await supabase
    .from("resource_folder_items")
    .delete()
    .eq("folder_id", folderId)
    .eq("resource_id", resourceId);
  if (error) throw new Error(error.message);
}

// Realtime: fire `cb` on any change to the shared folder tree. One channel
// per subscriber (uuid-suffixed name) so remounts never collide. Returns an
// unsubscribe fn. Both tables are in supabase_realtime with replica identity
// full, so payloads carry full old/new rows.
export function subscribeSharedFolders(cb) {
  const channel = supabase
    .channel(`resource_folders:${crypto.randomUUID()}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "resource_folders" }, payload => cb(payload))
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

// Realtime: fire `cb` on any change to folder↔resource filings.
export function subscribeFolderItems(cb) {
  const channel = supabase
    .channel(`resource_folder_items:${crypto.randomUUID()}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "resource_folder_items" }, payload => cb(payload))
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}
