// ============================================================
// DOCUMENTS & RESOURCES MANAGER
// Resources: books, sheet music, websites, equipment links.
// Documents: insurance, WWCC, licensing agreements, policies.
// ============================================================

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Library, FileText, Plus, X, Check, Pencil, Trash2, Copy, AlertTriangle, Clock, Eye, Upload, Loader, ChevronDown, ChevronRight, Sparkles, Folder, FolderPlus, EyeOff, SlidersHorizontal } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { uid as makeId } from "../utils/helpers";
import { PageTitle, NavButtons, Btn, PAGE_COLORS } from "../components/ui/SharedUI";
import { LinkBrowser } from "../components/LinkBrowser";
// Session 96: storage helpers — resources-public + documents-private buckets.
// uploadToBucket handles the upload and returns a storagePath (+ publicUrl
// for public bucket). signedUrlFor generates a fresh short-lived URL for
// viewing private docs. deleteFromBucket is called on row delete so orphan
// blobs don't accumulate in storage.
import {
  BUCKET_RESOURCES, BUCKET_DOCUMENTS,
  makeStoragePath, uploadToBucket, signedUrlFor, deleteFromBucket,
} from "../utils/storageHelpers";
// Resources are a shared pool persisted per-row (no whole-list sync).
import { insertResource as insertResourceRow, updateResource as updateResourceRow, deleteResource as deleteResourceRow, resourceFileSharedByUpload, fetchResourceTaxonomies, loadSubjectNameMaps, resolveSubjectName, fetchFolderOverrides, saveFolderOverrides } from "../utils/resourcesDB";
// Resources-side real, nestable SHARED folder tree (replaces the old smart
// folders). Documents keep their smart folders via useFolderOverrides below.
import { listSharedFolders, createSharedFolder, renameFolder as renameSharedFolder, deleteFolder as deleteSharedFolder, listFolderItemResourceIds, addResourceToFolder, removeResourceFromFolder, subscribeSharedFolders, subscribeFolderItems } from "../utils/resourceFoldersDB";
import { iconForResourceType, iconForFileName } from "../utils/resourceTypeIcons";
import ResourcePreview from "../components/ResourcePreview";

// Fixed Source filter options (the `source` column).
const SOURCE_OPTIONS = [
  { value: "direct",       label: "Direct upload" },
  { value: "student_note", label: "From Student Notes" },
];

// Parse the storage object path out of a public resources file_url
// (".../object/public/resources/<path>"), for storage cleanup on delete.
function storagePathFromResourceUrl(fileUrl) {
  if (!fileUrl) return null;
  const m = fileUrl.match(/\/object\/public\/resources\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

const DOCUMENT_TYPES     = ["Insurance", "WWCC", "License Agreement", "Policy", "Other"];

// Session 97: union of the hardcoded defaults and any custom values currently
// in use, so the dropdowns / datalists pick up user-typed categories
// automatically. Empty / falsy entries skipped, dedupe is case-insensitive
// but preserves the first-seen casing for display.
function _mergeOptions(defaults, items, key) {
  const seen = new Map();
  for (const v of defaults) if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  for (const it of (items || [])) {
    const v = (it?.[key] || "").trim();
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()];
}
const EXPIRY_WARN_DAYS   = 30;


// ── Expiry helpers ──────────────────────────────────────────
function daysUntilExpiry(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp   = new Date(dateStr + "T00:00:00");
  return Math.floor((exp - today) / 86400000);
}

function ExpiryBadge({ dateStr }) {
  const { colors } = useTheme();
  const days = daysUntilExpiry(dateStr);
  if (days === null) return null;
  const expired = days < 0;
  const warning = days >= 0 && days <= EXPIRY_WARN_DAYS;
  if (!expired && !warning) {
    return <span style={{ fontSize: 12, color: colors.textMuted }}>{new Date(dateStr + "T00:00:00").toLocaleDateString("en-AU")}</span>;
  }
  const bg    = expired ? colors.redLight : colors.amberLight;
  const border= expired ? colors.danger + "60" : colors.warning + "60";
  const text  = expired ? colors.danger : colors.amberDark;
  const label = expired ? `Expired ${Math.abs(days)}d ago` : days === 0 ? "Expires today" : `Expires in ${days}d`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: bg, border: `1px solid ${border}`, color: text }}>
      <Clock size={10} />{label}
    </span>
  );
}

export function DocumentsResourcesManager({ resources, setResources, documents, setDocuments, schools, teachers, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const { colors } = useTheme();
  const [section, setSection] = useState("resources");
  const [browserLink, setBrowserLink] = useState(null);

  // ── Resources state ─────────────────────────────────────────
  // Edit-details modal: rEditId === "new" for a fresh resource, an id for
  // an existing one, null when closed. rEditForm holds the in-flight row.
  const [rEditId,   setREditId]   = useState(null);
  const [rEditForm, setREditForm] = useState(null);
  const [rEditErr,  setREditErr]  = useState("");
  const [rSaving,   setRSaving]   = useState(false);
  const [rSearch,   setRSearch]   = useState("");
  const [rHovered,  setRHovered]  = useState(null);

  // Taxonomy lists + schools feed the filter bar and the edit modal.
  const [tax, setTax] = useState({ resourceTypes: [], skillLevels: [], instruments: [] });
  // Subject-name maps, loaded lazily only when a student_note resource exists.
  const [subjectMaps, setSubjectMaps] = useState(null);

  // All six filter dimensions now live in the tucked "Filters" control
  // (instrument + type moved off the sidebar). Each is a multi-select; empty
  // array = no constraint. Combined with AND, applied on top of the active
  // folder / All-resources view.
  const [rfInstrument, setRfInstrument] = useState([]);
  const [rfType,       setRfType]       = useState([]);
  const [rfSkill,      setRfSkill]      = useState([]);
  const [rfSchool,     setRfSchool]     = useState([]);
  const [rfUploadedBy, setRfUploadedBy] = useState([]);
  const [rfSource,     setRfSource]     = useState([]);
  const [showFilters,  setShowFilters]  = useState(false);
  const rFiltersBtnRef = useRef(null);

  // ── Finder-style library state (real, nestable SHARED folder tree) ──
  // selectedFolderId === null shows the whole library ("All resources");
  // a folder id narrows the middle list to that folder's direct subfolders +
  // the resources filed directly into it. selectedId is the row whose detail
  // shows in the right pane (null = placeholder).
  const [selectedFolderId, setSelectedFolderId] = useState(null);
  const [selectedId,       setSelectedId]       = useState(null);
  // The shared folder tree (flat rows with parent_id) + the resource ids filed
  // directly in the selected folder. Both kept live via realtime.
  const [folders,       setFolders]       = useState([]);
  const [folderItemIds, setFolderItemIds] = useState([]);
  // Folder right-click menu { x, y, id } + inline rename / create editors.
  const [folderMenu,      setFolderMenu]      = useState(null);
  const [renamingId,      setRenamingId]      = useState(null); // folder id being renamed
  const [renameDraft,     setRenameDraft]     = useState("");
  const [newFolderParent, setNewFolderParent] = useState(undefined); // undefined=idle, null=new root, id=new subfolder
  const [newFolderName,   setNewFolderName]   = useState("");
  // Filing: the resource being filed (folder-picker modal) + the row menu.
  const [filingResource,  setFilingResource]  = useState(null);
  const [resourceMenu,    setResourceMenu]    = useState(null); // { x, y, id }
  // Sidebar expand/collapse — we track the COLLAPSED folder ids (default is
  // expanded, so an empty set = everything open). In-memory only; resets on
  // relaunch. Ancestors of the selected folder are always force-expanded so
  // the current selection can never be hidden.
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set());

  // ── Documents state ─────────────────────────────────────────
  // Mirrors the Resources Finder: add/edit happens in a modal and the old
  // table is replaced by a three-pane folder / list / detail view.
  const [dEditId,   setDEditId]   = useState(null);   // "new" | id | null
  const [dEditForm, setDEditForm] = useState(null);
  const [dEditErr,  setDEditErr]  = useState("");
  const [dSearch,   setDSearch]   = useState("");
  const [dHovered,  setDHovered]  = useState(null);

  // Tucked filter — assigned teacher (Type + School are sidebar folders).
  const [dfTeacher,    setDfTeacher]    = useState([]);
  const [dShowFilters, setDShowFilters] = useState(false);
  const dFiltersBtnRef = useRef(null);

  // Finder state: own folder + detail selection.
  const [dSelectedFolder, setDSelectedFolder] = useState({ dim: "all", value: null });
  const [dSelectedId,     setDSelectedId]     = useState(null);

  // Documents folder overrides — a SEPARATE app_settings key from Resources,
  // so the two surfaces never interfere.
  const { overrides: dOverrides, folderKey: dFolderKey, folderLabel: dFolderLabelFn, isFolderHidden: dIsFolderHidden, renameFolder: dRenameFolder, hideFolder: dHideFolder, unhideFolder: dUnhideFolder, addCustom: dAddCustom, renameCustom: dRenameCustom, deleteCustom: dDeleteCustom } = useFolderOverrides("document_folder_overrides:admin", notify);
  const [dShowHidden,     setDShowHidden]     = useState(false);
  const [dFolderMenu,     setDFolderMenu]     = useState(null);
  const [dRenamingKey,    setDRenamingKey]    = useState(null);
  const [dRenameDraft,    setDRenameDraft]    = useState("");
  const [dActiveCustomId, setDActiveCustomId] = useState(null);
  const [dSavingView,     setDSavingView]     = useState(false);
  const [dNewViewName,    setDNewViewName]    = useState("");

  useEffect(() => {
    setREditId(null); setREditForm(null);
    setDEditId(null); setDEditForm(null);
  }, [resetKey]);

  // Session 96: upload state (shared across both tabs). A single upload-in-
  // flight at a time is plenty — this isn't a bulk-import UI. uploadingFor
  // tracks the record id so the row can show a spinner.
  const [uploadingFor, setUploadingFor] = useState(null);

  // Format a size nicely for display next to uploaded filenames.
  const fmtBytes = (n) => {
    if (!n && n !== 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  // Session 96: trigger a hidden file picker and, on pick, upload to the
  // given bucket. On success, merges filename/storage_path/size/mime into
  // the edit form so the user can see it before saving the row. URL is
  // cleared because a row is either URL-based OR file-based, not both.
  const pickAndUploadFile = (bucket, recordId, updateForm) => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setUploadingFor(recordId);
      const storagePath = makeStoragePath(recordId, file.name);
      const res = await uploadToBucket(bucket, storagePath, file);
      setUploadingFor(null);
      if (!res) { notify("Upload failed — try again", "danger"); return; }
      if (bucket === BUCKET_RESOURCES) {
        // Resources (public bucket): store the public file location in
        // file_url / file_name; a file resource carries no separate URL.
        updateForm({ file_url: res.publicUrl || "", file_name: file.name, url: "" });
      } else {
        // Documents (private bucket) keep the storage_path model — signed
        // on demand via openPrivate(). Unchanged by the resources rework.
        updateForm({
          filename: file.name,
          storage_path: res.storagePath,
          size_bytes: file.size,
          mime_type: file.type || "application/octet-stream",
        });
      }
      notify("File uploaded ✓");
    };
    input.click();
  };

  // Open a private Document — sign a short URL and open in the in-app
  // browser. Public Resources just pass the stored url through directly.
  const openPrivate = async (storagePath, title) => {
    const url = await signedUrlFor(storagePath);
    if (!url) { notify("Could not open document — try again", "danger"); return; }
    setBrowserLink({ url, title: title || "Document" });
  };

  // ── Resources CRUD ──────────────────────────────────────────
  // Add and edit both go through one modal (rEditForm). rEditId === "new"
  // for a fresh resource. A new resource is written only on save, so
  // cancelling leaves nothing behind. source / added_by_name are carried
  // on the row but not shown in the form.
  const addResource = () => {
    setREditErr("");
    setREditForm({ id: crypto.randomUUID(), label: "", url: "", category: "", description: "", file_url: "", file_name: "", instrument: "", skill_level: "", school_id: "", source: "direct", added_by_name: "Admin" });
    setREditId("new");
  };
  const openEditResource = (r) => {
    setREditErr("");
    setREditForm({ ...r });
    setREditId(r.id);
  };
  const saveResource = async () => {
    if (!rEditForm) return;
    if (!rEditForm.label.trim()) { setREditErr("Name is required."); return; }
    setRSaving(true);
    try {
      const isNew = rEditId === "new";
      const payload = { ...rEditForm, label: rEditForm.label.trim() };
      // Per-row write: insert a brand-new row, update an existing one.
      const saved = isNew ? await insertResourceRow(payload) : await updateResourceRow(payload);
      setResources(prev => isNew ? [saved, ...prev] : prev.map(r => r.id === saved.id ? saved : r));
      setREditId(null); setREditForm(null);
    } catch (e) {
      setREditErr("Couldn't save — try again.");
    } finally {
      setRSaving(false);
    }
  };
  const cancelResource = () => { setREditId(null); setREditForm(null); setREditErr(""); };
  const deleteResource = async (id) => {
    const r = resources.find(r => r.id === id);
    // 8.1's RLS lets an admin delete ANY library item, so this confirm is the
    // guard against an accidental deletion.
    if (!window.confirm(`Remove "${r?.label || "this resource"}"?`)) return;
    // Shared-file-safe (8.3b): if a teacher-app published upload still shares
    // this stored file (a student_attachments row with resource_id = this
    // resource AND a non-null storage_path), keep the file — only the resources
    // row is deleted, and the FK then clears resource_id on referrers. If the
    // referrer check itself errors, err safe and keep the file (a stray unused
    // object is harmless; deleting an in-use file is not). Otherwise remove the
    // storage object as before.
    if (r?.file_url) {
      let sharedByUpload = false;
      try {
        sharedByUpload = await resourceFileSharedByUpload(id);
      } catch (e) {
        console.error("[resources delete] shared-file check failed — keeping file:", e);
        sharedByUpload = true;
      }
      if (!sharedByUpload) {
        const path = storagePathFromResourceUrl(r.file_url);
        if (path) deleteFromBucket(BUCKET_RESOURCES, path);
      }
    }
    setResources(prev => prev.filter(r => r.id !== id));
    if (rEditId === id) { setREditId(null); setREditForm(null); }
    try { await deleteResourceRow(id); } catch (e) { notify("Couldn't remove resource — try again", "danger"); }
    notify("Resource removed");
  };
  const copyLink = (url) => {
    if (!url) return;
    try { navigator.clipboard.writeText(url); notify("Link copied"); } catch(e) {}
  };

  // Taxonomy lists for the filter bar + edit modal.
  useEffect(() => { fetchResourceTaxonomies().then(setTax); }, []);

  // ── Shared folder tree: load + keep live ─────────────────────
  const reloadFolders = useCallback(() => {
    listSharedFolders().then(setFolders).catch((e) => {
      console.error("listSharedFolders failed", e);
      notify("Couldn't load folders: " + (e?.message || "unknown error"), "danger");
    });
  }, [notify]);
  useEffect(() => {
    reloadFolders();
    const unsub = subscribeSharedFolders(reloadFolders);
    return unsub;
  }, [reloadFolders]);

  // Resources filed DIRECTLY in the selected folder (non-recursive).
  const reloadFolderItems = useCallback(() => {
    if (!selectedFolderId) { setFolderItemIds([]); return; }
    listFolderItemResourceIds(selectedFolderId).then(setFolderItemIds).catch((e) => {
      console.error("listFolderItemResourceIds failed", e);
      notify("Couldn't load this folder's contents: " + (e?.message || "unknown error"), "danger");
    });
  }, [selectedFolderId, notify]);
  useEffect(() => { reloadFolderItems(); }, [reloadFolderItems]);
  useEffect(() => {
    const unsub = subscribeFolderItems(reloadFolderItems);
    return unsub;
  }, [reloadFolderItems]);

  // ── Folder tree helpers (shape the flat rows into a tree) ─────
  const folderById = useMemo(() => {
    const m = new Map(); for (const f of folders) m.set(f.id, f); return m;
  }, [folders]);
  const foldersByParent = useMemo(() => {
    const m = new Map();
    for (const f of folders) {
      const k = f.parent_id || "__root__";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(f);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name));
    return m;
  }, [folders]);
  const childrenOf = useCallback((pid) => foldersByParent.get(pid || "__root__") || [], [foldersByParent]);
  // Root→selected path for the breadcrumb (guards against any cycle).
  const breadcrumb = useMemo(() => {
    const path = []; const guard = new Set();
    let cur = selectedFolderId ? folderById.get(selectedFolderId) : null;
    while (cur && !guard.has(cur.id)) { guard.add(cur.id); path.unshift(cur); cur = cur.parent_id ? folderById.get(cur.parent_id) : null; }
    return path;
  }, [selectedFolderId, folderById]);
  // True when `nodeId` is `ancestorId` or sits beneath it — used to reset the
  // selection to "All resources" when the selected folder (or an ancestor) is
  // deleted out from under it.
  const isSelfOrDescendant = useCallback((nodeId, ancestorId) => {
    let cur = nodeId; const guard = new Set();
    while (cur && !guard.has(cur)) { if (cur === ancestorId) return true; guard.add(cur); cur = folderById.get(cur)?.parent_id || null; }
    return false;
  }, [folderById]);

  // ── Sidebar expand/collapse ──────────────────────────────────
  // The strict ancestors of the selected folder (not the folder itself). These
  // are always shown expanded so the selection stays visible even if the user
  // had collapsed one of them earlier.
  const ancestorsOfSelected = useMemo(() => {
    const s = new Set(); const guard = new Set();
    let cur = selectedFolderId ? (folderById.get(selectedFolderId)?.parent_id || null) : null;
    while (cur && !guard.has(cur)) { guard.add(cur); s.add(cur); cur = folderById.get(cur)?.parent_id || null; }
    return s;
  }, [selectedFolderId, folderById]);
  // A folder's children are shown when it isn't collapsed OR it's an ancestor
  // of the current selection (force-open).
  const isExpanded = useCallback(
    (id) => ancestorsOfSelected.has(id) || !collapsedFolders.has(id),
    [ancestorsOfSelected, collapsedFolders]
  );
  // Toggle a folder open/closed. We decide collapse-vs-expand from the VISIBLE
  // state (isExpanded), not raw collapsedFolders membership, so a force-open
  // folder still collapses on click. Collapsing a folder that contains the
  // current selection would otherwise be undone instantly by the force-expand
  // rule, so in that case we move the selection up to the folder being
  // collapsed (its contents + breadcrumb follow); its own ancestors stay open.
  const toggleExpand = useCallback((id) => {
    const collapsing = isExpanded(id);
    if (collapsing && isSelfOrDescendant(selectedFolderId, id)) setSelectedFolderId(id);
    setCollapsedFolders(prev => {
      const next = new Set(prev);
      if (collapsing) next.add(id); else next.delete(id);
      return next;
    });
  }, [isExpanded, isSelfOrDescendant, selectedFolderId]);
  const expandFolder = useCallback((id) => {
    setCollapsedFolders(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev); next.delete(id); return next;
    });
  }, []);

  // ── Folder mutations ─────────────────────────────────────────
  const commitNewFolder = async () => {
    const name = newFolderName.trim();
    const parent = newFolderParent;
    setNewFolderParent(undefined); setNewFolderName("");
    if (!name || parent === undefined) return;
    try { await createSharedFolder(name, parent || null); reloadFolders(); notify("Folder created"); }
    catch (e) { console.error("createSharedFolder failed", e); notify("Couldn't create folder: " + (e?.message || "unknown error"), "danger"); }
  };
  const commitRenameFolder = async (id) => {
    const name = renameDraft.trim(); setRenamingId(null);
    const current = folderById.get(id);
    if (!name || !current || name === current.name) return;
    // Optimistic, name-ONLY update: spread the existing row so parent_id and
    // position are preserved exactly. The sidebar tree is built from parent_id,
    // so updating the label this way keeps the folder at its true depth without
    // depending on the refetch round-trip. reloadFolders() then reconciles with
    // the server (and the catch refetches to roll back if the write failed).
    setFolders(prev => prev.map(f => (f.id === id ? { ...f, name } : f)));
    try { await renameSharedFolder(id, name); reloadFolders(); }
    catch (e) { console.error("renameFolder failed", e); notify("Couldn't rename folder: " + (e?.message || "unknown error"), "danger"); reloadFolders(); }
  };
  const removeFolder = async (id) => {
    const f = folderById.get(id);
    if (!window.confirm(`Delete "${f?.name || "this folder"}"? This removes the folder, its subfolders, and everything filed in them. The resources themselves stay in the library.`)) return;
    if (isSelfOrDescendant(selectedFolderId, id)) setSelectedFolderId(null);
    try { await deleteSharedFolder(id); reloadFolders(); reloadFolderItems(); notify("Folder deleted"); }
    catch (e) { console.error("deleteFolder failed", e); notify("Couldn't delete folder: " + (e?.message || "unknown error"), "danger"); }
  };

  // ── Filing (file a resource into / out of a folder) ──────────
  const fileResourceInto = async (folderId) => {
    const r = filingResource; setFilingResource(null);
    if (!r) return;
    try {
      await addResourceToFolder(folderId, r.id);
      reloadFolders();
      if (folderId === selectedFolderId) reloadFolderItems();
      notify("Added to folder");
    } catch (e) { console.error("addResourceToFolder failed", e); notify("Couldn't add to folder: " + (e?.message || "unknown error"), "danger"); }
  };
  const removeResourceFromCurrentFolder = async (resourceId) => {
    if (!selectedFolderId) return;
    try {
      await removeResourceFromFolder(selectedFolderId, resourceId);
      reloadFolderItems();
      notify("Removed from folder");
    } catch (e) { console.error("removeResourceFromFolder failed", e); notify("Couldn't remove from folder: " + (e?.message || "unknown error"), "danger"); }
  };

  // Recursively render the shared folder tree (indented by depth). An inline
  // name input appears in place when creating a subfolder of a node.
  const renderFolderTree = (parentId, depth) => childrenOf(parentId).map(f => {
    const hasChildren = childrenOf(f.id).length > 0;
    const expanded = hasChildren && isExpanded(f.id);
    // Show the new-subfolder input even when collapsed (creating one expands it).
    const showChildren = expanded || newFolderParent === f.id;
    return (
      <React.Fragment key={f.id}>
        <FolderRow icon={Folder} label={f.name} indent={depth}
          selected={selectedFolderId === f.id}
          hasChildren={hasChildren} expanded={expanded}
          onToggleExpand={() => toggleExpand(f.id)}
          onDoubleClick={() => { if (hasChildren) toggleExpand(f.id); }}
          onClick={() => setSelectedFolderId(f.id)}
          onContextMenu={(e) => { e.preventDefault(); setFolderMenu({ x: e.clientX, y: e.clientY, id: f.id }); }}
          renaming={renamingId === f.id}
          renameDraft={renameDraft} setRenameDraft={setRenameDraft}
          onCommitRename={() => commitRenameFolder(f.id)}
          onCancelRename={() => setRenamingId(null)}
          colors={colors} />
        {newFolderParent === f.id && (
          <FolderNameInput depth={depth + 1} value={newFolderName} setValue={setNewFolderName}
            onCommit={commitNewFolder} onCancel={() => { setNewFolderParent(undefined); setNewFolderName(""); }} colors={colors} />
        )}
        {showChildren && renderFolderTree(f.id, depth + 1)}
      </React.Fragment>
    );
  });

  // Resolve student_note origin names only if such a resource exists
  // (none until cluster 4) — avoids extra queries in the common case.
  useEffect(() => {
    if (!subjectMaps && resources.some(r => r.source === "student_note")) {
      loadSubjectNameMaps().then(setSubjectMaps);
    }
  }, [resources, subjectMaps]);

  // ── Filter options ───────────────────────────────────────────
  const instrumentOptions = useMemo(() => tax.instruments.map(v => ({ value: v, label: v })), [tax.instruments]);
  const typeOptions       = useMemo(() => tax.resourceTypes.map(v => ({ value: v, label: v })), [tax.resourceTypes]);
  const skillOptions      = useMemo(() => tax.skillLevels.map(v => ({ value: v, label: v })), [tax.skillLevels]);
  const schoolOptions     = useMemo(() => (schools || []).map(s => ({ value: s.id, label: s.name })), [schools]);
  const uploadedByOptions = useMemo(() => {
    const set = new Set();
    for (const r of resources) if (r.added_by_name) set.add(r.added_by_name);
    return [...set].sort().map(n => ({ value: n, label: n }));
  }, [resources]);

  const anyResourceFilter = !!(rfInstrument.length || rfType.length || rfSkill.length || rfSchool.length || rfUploadedBy.length || rfSource.length);
  const filterCount = rfInstrument.length + rfType.length + rfSkill.length + rfSchool.length + rfUploadedBy.length + rfSource.length;
  const clearResourceFilters = () => { setRfInstrument([]); setRfType([]); setRfSkill([]); setRfSchool([]); setRfUploadedBy([]); setRfSource([]); };

  // ── Filter: folder scope + the six filters + search ───────────
  // All six filters (instrument, type, skill, school, uploaded-by, source)
  // combine with AND and apply on top of the active view.
  const searchActive = !!rSearch.trim();
  const matchesFilters = useCallback((r) => {
    if (rfInstrument.length && !rfInstrument.includes(r.instrument))     return false;
    if (rfType.length       && !rfType.includes(r.category))             return false;
    if (rfSkill.length      && !rfSkill.includes(r.skill_level))         return false;
    if (rfSchool.length     && !rfSchool.includes(r.school_id))          return false;
    if (rfUploadedBy.length && !rfUploadedBy.includes(r.added_by_name))  return false;
    if (rfSource.length     && !rfSource.includes(r.source || "direct")) return false;
    return true;
  }, [rfInstrument, rfType, rfSkill, rfSchool, rfUploadedBy, rfSource]);

  const filteredResources = useMemo(() => {
    const q = rSearch.trim().toLowerCase();
    const bySearch = (r) => !q || (r.label||"").toLowerCase().includes(q) || (r.description||"").toLowerCase().includes(q);
    // Free-text search is GLOBAL — it ignores the current folder and matches
    // the whole library (filters still apply on top).
    if (searchActive) return resources.filter(r => matchesFilters(r) && bySearch(r));
    // "All resources" — the whole library.
    if (!selectedFolderId) return resources.filter(matchesFilters);
    // A folder — only the resources filed DIRECTLY into it (non-recursive).
    const idSet = new Set(folderItemIds);
    return resources.filter(r => idSet.has(r.id) && matchesFilters(r));
  }, [resources, searchActive, rSearch, selectedFolderId, folderItemIds, matchesFilters]);

  // Direct subfolders shown above the resource list — only when inside a
  // folder and not running a global search.
  const visibleSubfolders = useMemo(
    () => (searchActive || !selectedFolderId) ? [] : childrenOf(selectedFolderId),
    [searchActive, selectedFolderId, childrenOf]
  );

  // Keep the detail pane coherent: if the selected row drops out of the list
  // (folder/filter/search change or deletion), clear the selection.
  useEffect(() => {
    if (selectedId && !filteredResources.some(r => r.id === selectedId)) setSelectedId(null);
  }, [filteredResources, selectedId]);

  const selectedResource = useMemo(() => resources.find(r => r.id === selectedId) || null, [resources, selectedId]);
  const schoolNameById = useMemo(() => {
    const m = new Map(); for (const s of (schools || [])) m.set(s.id, s.name); return m;
  }, [schools]);

  // ── Documents CRUD (modal add/edit, mirrors Resources) ───────
  // The row is written to the list only on Save, so cancelling leaves nothing
  // behind. storage_path / filename / size_bytes / mime_type are set on upload;
  // a row is either URL-based (d.url) OR file-based (d.storage_path).
  const blankDocument = () => ({ id: makeId(), label: "", type: "", teacherId: "", schoolId: "", expiryDate: "", url: "", notes: "", storage_path: "", filename: "", size_bytes: null, mime_type: "" });
  const addDocument = () => { setDEditErr(""); setDEditForm(blankDocument()); setDEditId("new"); };
  const openEditDocument = (d) => { setDEditErr(""); setDEditForm({ ...d }); setDEditId(d.id); };
  const saveDocument = () => {
    if (!dEditForm) return;
    if (!dEditForm.label.trim()) { setDEditErr("Name is required."); return; }
    const isNew = dEditId === "new";
    const toSave = { ...dEditForm, label: dEditForm.label.trim() };
    setDocuments(prev => isNew ? [toSave, ...prev] : prev.map(d => d.id === toSave.id ? toSave : d));
    setDSelectedId(toSave.id);
    setDEditId(null); setDEditForm(null); setDEditErr("");
    notify("Document saved");
  };
  const cancelDocument = () => { setDEditId(null); setDEditForm(null); setDEditErr(""); };
  const deleteDocument = (id) => {
    const d = documents.find(d => d.id === id);
    if (!window.confirm(`Remove "${d?.label || "this document"}"?`)) return;
    // Session 96: remove uploaded blob from private bucket alongside the row.
    if (d?.storage_path) deleteFromBucket(BUCKET_DOCUMENTS, d.storage_path);
    setDocuments(prev => prev.filter(d => d.id !== id));
    if (dEditId === id) { setDEditId(null); setDEditForm(null); }
    notify("Document removed");
  };

  // ── Documents folders (auto-derived live): by type + by school ─
  const docTypeFolders = useMemo(() => {
    const counts = new Map();
    for (const d of documents) { const v = (d.type || "").trim(); if (v) counts.set(v, (counts.get(v) || 0) + 1); }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
  }, [documents]);
  const docSchoolFolders = useMemo(() => {
    const counts = new Map();
    for (const d of documents) { if (d.schoolId) counts.set(d.schoolId, (counts.get(d.schoolId) || 0) + 1); }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count, name: (schools.find(s => s.id === value)?.name) || "Unknown school" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [documents, schools]);

  // Tucked teacher filter — only teachers actually assigned to a document.
  const dfTeacherOptions = useMemo(() => {
    const ids = new Set(documents.map(d => d.teacherId).filter(Boolean));
    return (teachers || []).filter(t => ids.has(t.id)).map(t => ({ value: t.id, label: t.name }));
  }, [documents, teachers]);
  const anyDocFilter = !!dfTeacher.length;
  const dFilterCount = dfTeacher.length;
  const clearDocFilters = () => setDfTeacher([]);

  // ── Filter: folder narrowing + teacher filter + search (AND) ──
  const filteredDocuments = useMemo(() => documents.filter(d => {
    if (dSelectedFolder.dim === "type"   && d.type     !== dSelectedFolder.value) return false;
    if (dSelectedFolder.dim === "school" && d.schoolId !== dSelectedFolder.value) return false;
    if (dfTeacher.length && !dfTeacher.includes(d.teacherId)) return false;
    if (dSearch.trim()) {
      const q = dSearch.trim().toLowerCase();
      if (!(d.label||"").toLowerCase().includes(q) && !(d.notes||"").toLowerCase().includes(q)) return false;
    }
    return true;
  }), [documents, dSelectedFolder, dfTeacher, dSearch]);

  useEffect(() => {
    if (dSelectedId && !filteredDocuments.some(d => d.id === dSelectedId)) setDSelectedId(null);
  }, [filteredDocuments, dSelectedId]);
  const selectedDocument = useMemo(() => documents.find(d => d.id === dSelectedId) || null, [documents, dSelectedId]);

  // ── Documents custom saved views (own snapshot shape) ────────
  const dCurrentSnapshot = useMemo(() => ({ folder: dSelectedFolder, teacher: dfTeacher, search: dSearch.trim() }), [dSelectedFolder, dfTeacher, dSearch]);
  const dViewIsCustomizable = dSelectedFolder.dim !== "all" || anyDocFilter || !!dSearch.trim();
  const applyDocCustom = (c) => {
    const f = c.filters || {};
    setDSelectedFolder(f.folder || { dim: "all", value: null });
    setDfTeacher(f.teacher || []);
    setDSearch(f.search || "");
    setDActiveCustomId(c.id);
  };
  const dCommitSaveView = () => {
    const name = dNewViewName.trim();
    if (name) setDActiveCustomId(dAddCustom(name, dCurrentSnapshot));
    setDSavingView(false); setDNewViewName("");
  };
  useEffect(() => {
    if (!dActiveCustomId) return;
    const c = dOverrides.custom.find(x => x.id === dActiveCustomId);
    if (!c || JSON.stringify(c.filters) !== JSON.stringify(dCurrentSnapshot)) setDActiveCustomId(null);
  }, [dActiveCustomId, dOverrides.custom, dCurrentSnapshot]);
  useEffect(() => {
    if (dSelectedFolder.dim !== "all" && dOverrides.hidden.includes(`${dSelectedFolder.dim}:${dSelectedFolder.value}`)) {
      setDSelectedFolder({ dim: "all", value: null });
    }
  }, [dOverrides.hidden, dSelectedFolder]);

  // Session 97: merged option list — defaults plus any custom types in use.
  const documentTypeOptions = useMemo(
    () => _mergeOptions(DOCUMENT_TYPES, documents, "type"),
    [documents]
  );

  // Documents expiring within 30 days (shown as alert banner)
  const expiringDocs = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + EXPIRY_WARN_DAYS);
    return documents.filter(d => {
      if (!d.expiryDate || d._isNew) return false;
      const exp = new Date(d.expiryDate + "T00:00:00");
      return exp <= cutoff;
    }).sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  }, [documents]);

  // ── Shared styles ───────────────────────────────────────────
  const inputStyle = { width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", background: colors.inputBg, color: colors.text };
  const modalLabel = { display: "block", fontSize: 11, fontWeight: 600, color: colors.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 };
  const modalSelect = { width: "100%", padding: "6px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text, boxSizing: "border-box" };

  return (
    <div>
      {/* Session 96: spinner keyframes for the upload Loader icons. */}
      <style>{`
        @keyframes mt-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: mt-spin 0.8s linear infinite; }
      `}</style>
      <PageTitle
        subtitle={section === "resources" ? `${resources.length} resource${resources.length !== 1 ? "s" : ""}` : `${documents.length} document${documents.length !== 1 ? "s" : ""}`}
        pageColor={PAGE_COLORS.resources}
        action={section === "resources"
          ? <Btn onClick={addResource} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Plus size={13} /> Add Resource</Btn>
          : section === "documents"
          ? <Btn onClick={addDocument} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Plus size={13} /> Add Document</Btn>
          : null}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        <span>Documents &amp; Resources</span>
      </PageTitle>

      {/* Section toggle */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16, gap: 8 }}>
        <div style={{ display: "flex", gap: 0, background: colors.bg, border: "2px solid " + colors.sidebarHover, borderRadius: 10, overflow: "hidden", flexShrink: 0 }}>
          {[
            { id: "resources", label: "Resources", icon: <Library size={13} /> },
            { id: "documents", label: "Documents", icon: <FileText size={13} /> },
          ].map(s => (
            <button key={s.id} onClick={() => setSection(s.id)}
              style={{ padding: "8px 20px", border: "none", fontSize: 13, fontFamily: "inherit", cursor: "pointer", fontWeight: 600, background: section === s.id ? colors.sidebarHover : "transparent", color: section === s.id ? colors.white : colors.textMuted, transition: "background 0.15s, color 0.15s", display: "inline-flex", alignItems: "center", gap: 6 }}>
              {s.icon}{s.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── RESOURCES ── */}
      {section === "resources" && (
        <div>
          {resources.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px", gap: 12 }}>
              <Library size={40} style={{ color: colors.textMuted, opacity: 0.5 }} />
              <div style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>No resources yet</div>
              <div style={{ fontSize: 13, color: colors.textMuted, textAlign: "center", maxWidth: 380 }}>Save links to recommended books, equipment, websites and other resources for easy access when drafting emails.</div>
              <Btn onClick={addResource} style={{ marginTop: 4 }}>+ Add Resource</Btn>
            </div>
          ) : (
            /* Finder-style three-pane library: folder sidebar / list / detail. */
            <div style={{ display: "grid", gridTemplateColumns: "224px minmax(0, 1fr) 332px", alignItems: "stretch", border: `1px solid ${colors.border}`, borderRadius: 12, overflow: "hidden", background: colors.cardBg }}>

              {/* ── LEFT: folder sidebar (real, nestable shared tree) ── */}
              <div style={{ padding: 8, borderRight: `1px solid ${colors.borderLight}` }}>
                <FolderRow icon={Library} label="All resources" count={resources.length}
                  selected={!selectedFolderId}
                  onClick={() => setSelectedFolderId(null)} colors={colors} />

                {/* + New folder (top-level) */}
                {newFolderParent === null ? (
                  <FolderNameInput value={newFolderName} setValue={setNewFolderName}
                    onCommit={commitNewFolder} onCancel={() => { setNewFolderParent(undefined); setNewFolderName(""); }} colors={colors} />
                ) : (
                  <div onClick={() => { setNewFolderName(""); setNewFolderParent(null); }}
                    title="Create a new top-level folder"
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 7, cursor: "pointer", userSelect: "none" }}>
                    <FolderPlus size={15} style={{ flexShrink: 0, color: colors.textMuted }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: colors.text }}>New folder…</span>
                  </div>
                )}

                {/* The shared folder tree */}
                {renderFolderTree(null, 0)}
              </div>

              {/* ── MIDDLE: compact resource list ── */}
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0, borderRight: `1px solid ${colors.borderLight}` }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 10, borderBottom: `1px solid ${colors.borderLight}` }}>
                  <div style={{ flex: 1, minWidth: 120, position: "relative" }}>
                    <input value={rSearch} onChange={e => setRSearch(e.target.value)} placeholder="Search resources…"
                      style={{ width: "100%", padding: "7px 30px 7px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", background: colors.inputBg, color: colors.text }} />
                    {rSearch && <button onClick={() => setRSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>}
                  </div>
                  {/* Filters — skill / school / uploaded-by / source tucked behind one control */}
                  <div>
                    <button ref={rFiltersBtnRef} onClick={() => setShowFilters(o => !o)}
                      style={{ padding: "7px 11px", border: "1px solid " + (anyResourceFilter ? colors.accent : colors.inputBorder), borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: "inherit", background: anyResourceFilter ? colors.accentLight : colors.cardBg, color: anyResourceFilter ? colors.accent : colors.textLight, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
                      <SlidersHorizontal size={13} /> Filters{anyResourceFilter ? ` (${filterCount})` : ""}
                    </button>
                    <PortalPopover anchorRef={rFiltersBtnRef} open={showFilters} onClose={() => setShowFilters(false)} width={224}>
                      <div style={{ background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.35)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                        <FilterDropdown label="Instrument"  options={instrumentOptions} selected={rfInstrument} onChange={setRfInstrument} colors={colors} />
                        <FilterDropdown label="Type"        options={typeOptions}       selected={rfType}       onChange={setRfType}       colors={colors} />
                        <FilterDropdown label="Skill level" options={skillOptions}      selected={rfSkill}      onChange={setRfSkill}      colors={colors} />
                        <FilterDropdown label="School"      options={schoolOptions}     selected={rfSchool}     onChange={setRfSchool}     colors={colors} />
                        <FilterDropdown label="Uploaded by" options={uploadedByOptions} selected={rfUploadedBy} onChange={setRfUploadedBy} colors={colors} />
                        <FilterDropdown label="Source"      options={SOURCE_OPTIONS}    selected={rfSource}     onChange={setRfSource}     colors={colors} />
                        {anyResourceFilter && (
                          <button onClick={clearResourceFilters} style={{ padding: "6px 10px", border: "1px solid " + colors.border, borderRadius: 8, background: colors.cardBg, color: colors.textLight, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                            <X size={12} /> Clear filters
                          </button>
                        )}
                      </div>
                    </PortalPopover>
                  </div>
                </div>

                {/* Breadcrumb — depth/navigation. Root is just "All resources". */}
                {!searchActive && breadcrumb.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 2, padding: "8px 12px", borderBottom: `1px solid ${colors.borderLight}` }}>
                    <button onClick={() => setSelectedFolderId(null)}
                      style={{ border: "none", background: "none", cursor: "pointer", color: colors.textLight, fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "2px 4px" }}>All resources</button>
                    {breadcrumb.map((f, i) => {
                      const last = i === breadcrumb.length - 1;
                      return (
                        <React.Fragment key={f.id}>
                          <ChevronRight size={12} style={{ color: colors.textMuted, flexShrink: 0 }} />
                          <button onClick={() => { if (!last) setSelectedFolderId(f.id); }} disabled={last}
                            style={{ border: "none", background: "none", cursor: last ? "default" : "pointer", color: last ? colors.text : colors.textLight, fontFamily: "inherit", fontSize: 12, fontWeight: last ? 700 : 600, padding: "2px 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{f.name}</button>
                        </React.Fragment>
                      );
                    })}
                  </div>
                )}

                <div style={{ flex: 1 }}>
                  {/* Direct subfolders (click to descend) */}
                  {visibleSubfolders.map(f => (
                    <div key={"sf:" + f.id} onClick={() => setSelectedFolderId(f.id)}
                      onContextMenu={(e) => { e.preventDefault(); setFolderMenu({ x: e.clientX, y: e.clientY, id: f.id }); }}
                      onMouseEnter={() => setRHovered("sf:" + f.id)} onMouseLeave={() => setRHovered(null)}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", cursor: "pointer", borderBottom: "1px solid " + colors.borderLight, background: rHovered === ("sf:" + f.id) ? colors.blueLight : colors.cardBg }}>
                      <Folder size={17} style={{ flexShrink: 0, color: colors.textMuted }} />
                      <div style={{ minWidth: 0, flex: 1, fontSize: 13, fontWeight: 600, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
                      <ChevronRight size={14} style={{ flexShrink: 0, color: colors.textMuted }} />
                    </div>
                  ))}

                  {filteredResources.length === 0 && visibleSubfolders.length === 0 ? (
                    <div style={{ padding: "32px 20px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>{selectedFolderId && !searchActive ? "This folder is empty" : "No resources match the current view"}</div>
                  ) : filteredResources.map(r => {
                    const RowIcon = iconForResourceType(r.category)
                      || iconForFileName({ fileName: r.file_name, url: r.file_url || r.url });
                    const isSel = selectedId === r.id;
                    const subjName = r.source === "student_note" ? resolveSubjectName(r.source_subject_type, r.source_subject_id, subjectMaps) : null;
                    const sub = [r.instrument, r.category].filter(Boolean).join(" · ") || (subjName ? `from ${subjName}'s notes` : "");
                    return (
                      <div key={r.id} onClick={() => setSelectedId(r.id)}
                        onContextMenu={(e) => { e.preventDefault(); setResourceMenu({ x: e.clientX, y: e.clientY, id: r.id }); }}
                        onMouseEnter={() => setRHovered(r.id)} onMouseLeave={() => setRHovered(null)}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", cursor: "pointer", borderBottom: "1px solid " + colors.borderLight, background: isSel ? colors.sidebarHover : (rHovered === r.id ? colors.blueLight : colors.cardBg) }}>
                        <RowIcon size={17} style={{ flexShrink: 0, color: isSel ? colors.white : colors.textMuted }} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: isSel ? colors.white : colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {r.label || <span style={{ fontStyle: "italic", color: isSel ? colors.white : colors.textMuted }}>Untitled</span>}
                          </div>
                          {sub && <div style={{ fontSize: 11, color: isSel ? "rgba(255,255,255,0.8)" : colors.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>}
                        </div>
                        {r.source === "student_note" && <Sparkles size={12} style={{ flexShrink: 0, color: isSel ? colors.white : colors.accent }} />}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ── RIGHT: detail panel ── */}
              <div style={{ minWidth: 0 }}>
                {!selectedResource ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: "60px 24px", textAlign: "center", color: colors.textMuted }}>
                    <Library size={32} style={{ opacity: 0.4 }} />
                    <div style={{ fontSize: 13 }}>Select a resource to see its details</div>
                  </div>
                ) : (() => {
                  const r = selectedResource;
                  const link = r.url || r.file_url || "";
                  const BigIcon = iconForResourceType(r.category) || iconForFileName({ fileName: r.file_name, url: r.file_url || r.url });
                  const subjName = r.source === "student_note" ? resolveSubjectName(r.source_subject_type, r.source_subject_id, subjectMaps) : null;
                  const schoolName = r.school_id ? schoolNameById.get(r.school_id) : "";
                  const detailRow = (label, value) => (
                    <div style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: `1px solid ${colors.borderLight}` }}>
                      <div style={{ width: 92, flexShrink: 0, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: colors.text }}>{value}</div>
                    </div>
                  );
                  return (
                    <div>
                      {/* Preview / thumbnail */}
                      <ResourcePreview
                        fileUrl={r.file_url || null}
                        linkUrl={r.url || null}
                        fileName={r.file_name || null}
                        title={r.label}
                        fallbackIcon={BigIcon}
                      />
                      <div style={{ padding: 16 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: colors.text, marginBottom: 6 }}>{r.label || <span style={{ fontStyle: "italic", color: colors.textMuted }}>Untitled</span>}</div>
                        {r.category && <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: colors.accentLight, color: colors.accentDark, marginBottom: 12 }}>{r.category}</span>}

                        <div style={{ marginTop: 6 }}>
                          {detailRow("Instrument", r.instrument || <span style={{ color: colors.textMuted }}>—</span>)}
                          {detailRow("Skill", r.skill_level || <span style={{ color: colors.textMuted }}>—</span>)}
                          {detailRow("School", schoolName || <span style={{ color: colors.textMuted }}>—</span>)}
                          {detailRow("Uploaded by", r.added_by_name || <span style={{ color: colors.textMuted }}>—</span>)}
                          {detailRow("Date", r.created_at ? new Date(r.created_at).toLocaleDateString("en-AU") : <span style={{ color: colors.textMuted }}>—</span>)}
                          {detailRow("Source", r.source === "student_note"
                            ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: colors.accent, fontWeight: 600 }}><Sparkles size={12} /> {subjName ? `From ${subjName}'s notes` : "From Student Notes"}</span>
                            : <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: colors.textMuted }}><Upload size={12} /> Direct upload</span>)}
                          {detailRow("Link", r.file_url && r.file_name
                            ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}><FileText size={12} style={{ color: colors.accent, flexShrink: 0 }} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.file_name}>{r.file_name}</span></span>
                            : r.url
                              ? <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ color: colors.accent, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{r.url.replace(/^https?:\/\//, "")}</a>
                              : <span style={{ color: colors.textMuted }}>—</span>)}
                          {r.description && detailRow("Notes", r.description)}
                        </div>

                        {/* Action row — wired to the existing handlers */}
                        <div style={{ display: "flex", gap: 6, marginTop: 16, flexWrap: "wrap" }}>
                          {link && <button onClick={() => setBrowserLink({ url: link, title: r.label || r.category })} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Eye size={13} /> Open</button>}
                          {link && <button onClick={() => copyLink(link)} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Copy size={13} /> Copy</button>}
                          <button onClick={() => setFilingResource(r)} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><FolderPlus size={13} /> Add to folder…</button>
                          {selectedFolderId && folderItemIds.includes(r.id) && <button onClick={() => removeResourceFromCurrentFolder(r.id)} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><X size={13} /> Remove from this folder</button>}
                          <button onClick={() => openEditResource(r)} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Pencil size={13} /> Edit</button>
                          <button onClick={() => deleteResource(r.id)} style={{ border: "1px solid " + colors.danger + "60", background: colors.cardBg, color: colors.danger, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Trash2 size={13} /> Delete</button>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Folder right-click context menu — New subfolder / Rename / Delete */}
          {folderMenu && (
            <>
              <div onMouseDown={() => setFolderMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFolderMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 9970 }} />
              <div style={{ position: "fixed", zIndex: 9971, top: folderMenu.y, left: folderMenu.x, minWidth: 160, background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.22)", padding: 4 }}>
                <button onClick={() => { setNewFolderName(""); setSelectedFolderId(folderMenu.id); expandFolder(folderMenu.id); setNewFolderParent(folderMenu.id); setFolderMenu(null); }}
                  style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                  <FolderPlus size={13} /> New subfolder…
                </button>
                <button onClick={() => { setRenamingId(folderMenu.id); setRenameDraft(folderById.get(folderMenu.id)?.name || ""); setFolderMenu(null); }}
                  style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                  <Pencil size={13} /> Rename…
                </button>
                <button onClick={() => { const id = folderMenu.id; setFolderMenu(null); removeFolder(id); }}
                  style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.danger, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            </>
          )}

          {/* Resource right-click menu — Add to folder… / Remove from this folder */}
          {resourceMenu && (
            <>
              <div onMouseDown={() => setResourceMenu(null)} onContextMenu={(e) => { e.preventDefault(); setResourceMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 9970 }} />
              <div style={{ position: "fixed", zIndex: 9971, top: resourceMenu.y, left: resourceMenu.x, minWidth: 180, background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.22)", padding: 4 }}>
                <button onClick={() => { const r = resources.find(x => x.id === resourceMenu.id); setResourceMenu(null); if (r) setFilingResource(r); }}
                  style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                  <FolderPlus size={13} /> Add to folder…
                </button>
                {selectedFolderId && folderItemIds.includes(resourceMenu.id) && (
                  <button onClick={() => { const id = resourceMenu.id; setResourceMenu(null); removeResourceFromCurrentFolder(id); }}
                    style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                    <X size={13} /> Remove from this folder
                  </button>
                )}
              </div>
            </>
          )}

          {/* Folder picker — file the chosen resource into a shared folder */}
          {filingResource && (
            <div onMouseDown={() => setFilingResource(null)} style={{ position: "fixed", inset: 0, zIndex: 9980, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
              <div onMouseDown={e => e.stopPropagation()} style={{ background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 12, padding: 16, width: 360, maxWidth: "100%", maxHeight: "80vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: colors.text, marginBottom: 4, display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <FolderPlus size={14} /> Add to folder
                </div>
                <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{filingResource.label || "Untitled"}</div>
                {folders.length === 0 ? (
                  <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "8px 4px" }}>No folders yet — create one in the sidebar first.</div>
                ) : (
                  <FolderPicker childrenOf={childrenOf} onPick={fileResourceInto} colors={colors} />
                )}
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                  <button onClick={() => setFilingResource(null)} style={{ padding: "7px 14px", border: "1px solid " + colors.border, borderRadius: 8, background: colors.cardBg, color: colors.textMuted, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>Cancel</button>
                </div>
              </div>
            </div>
          )}

          {/* Add / edit-details modal — the single edit path */}
          {rEditId && rEditForm && (
            <div onMouseDown={cancelResource} style={{ position: "fixed", inset: 0, zIndex: 9980, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
              <div onMouseDown={e => e.stopPropagation()} style={{ background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 12, padding: 20, width: 480, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, marginBottom: 16, display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Library size={15} /> {rEditId === "new" ? "Add resource" : "Edit details"}
                </div>

                {/* Name */}
                <label style={modalLabel}>NAME *</label>
                <input value={rEditForm.label} onChange={e => setREditForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. Essential Music Theory Book 1" style={{ ...inputStyle, padding: "7px 10px", marginBottom: 12 }} autoFocus />

                {/* Link OR uploaded file (exclusive) */}
                <label style={modalLabel}>LINK / FILE</label>
                {rEditForm.file_url ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, background: colors.blueLight, fontSize: 12, marginBottom: 12 }}>
                    <FileText size={12} style={{ color: colors.accent, flexShrink: 0 }} />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={rEditForm.file_name}>{rEditForm.file_name}</span>
                    <button onClick={() => setREditForm(f => ({ ...f, file_url: "", file_name: "" }))} title="Clear uploaded file" style={{ border: "none", background: "none", cursor: "pointer", color: colors.textMuted, display: "inline-flex" }}><X size={12} /></button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 12 }}>
                    <input value={rEditForm.url} onChange={e => setREditForm(f => ({ ...f, url: e.target.value }))} placeholder="https://…" style={{ ...inputStyle, padding: "7px 10px", flex: 1 }} />
                    <button onClick={() => pickAndUploadFile(BUCKET_RESOURCES, rEditForm.id, (patch) => setREditForm(f => ({ ...f, ...patch })))} disabled={uploadingFor === rEditForm.id} title="Upload a file instead"
                      style={{ border: `1px solid ${colors.inputBorder}`, background: colors.cardBg, borderRadius: 6, padding: "7px 9px", cursor: uploadingFor === rEditForm.id ? "wait" : "pointer", display: "inline-flex", alignItems: "center", color: colors.textLight }}>
                      {uploadingFor === rEditForm.id ? <Loader size={13} className="spin" /> : <Upload size={13} />}
                    </button>
                  </div>
                )}

                {/* Type + Instrument */}
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={modalLabel}>TYPE</label>
                    <select value={rEditForm.category || ""} onChange={e => setREditForm(f => ({ ...f, category: e.target.value }))} style={modalSelect}>
                      <option value="">Select…</option>
                      {typeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={modalLabel}>INSTRUMENT</label>
                    <select value={rEditForm.instrument || ""} onChange={e => setREditForm(f => ({ ...f, instrument: e.target.value }))} style={modalSelect}>
                      <option value="">Select…</option>
                      {instrumentOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                </div>

                {/* Skill level + School */}
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={modalLabel}>SKILL LEVEL</label>
                    <select value={rEditForm.skill_level || ""} onChange={e => setREditForm(f => ({ ...f, skill_level: e.target.value }))} style={modalSelect}>
                      <option value="">Select…</option>
                      {skillOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={modalLabel}>SCHOOL</label>
                    <select value={rEditForm.school_id || ""} onChange={e => setREditForm(f => ({ ...f, school_id: e.target.value }))} style={modalSelect}>
                      <option value="">Select…</option>
                      {schoolOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                </div>

                {/* Description */}
                <label style={modalLabel}>DESCRIPTION</label>
                <input value={rEditForm.description || ""} onChange={e => setREditForm(f => ({ ...f, description: e.target.value }))} placeholder="Brief description (optional)" style={{ ...inputStyle, padding: "7px 10px", marginBottom: 14 }} />

                {rEditErr && <div style={{ fontSize: 12, color: colors.danger, marginBottom: 10 }}>{rEditErr}</div>}

                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={saveResource} disabled={rSaving} style={{ padding: "8px 18px", border: "none", borderRadius: 8, background: rSaving ? colors.textMuted : colors.success, color: "#fff", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: rSaving ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {rSaving ? "Saving…" : <><Check size={14} /> Save</>}
                  </button>
                  <button onClick={cancelResource} style={{ padding: "8px 16px", border: "1px solid " + colors.border, borderRadius: 8, background: colors.cardBg, color: colors.textMuted, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>Cancel</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── DOCUMENTS ── */}
      {section === "documents" && (
        <div>
          {/* Expiry alert banner */}
          {expiringDocs.length > 0 && (
            <div style={{ marginBottom: 16, padding: "12px 16px", background: colors.amberLight, border: "1px solid " + colors.warning + "40", borderRadius: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 13, color: colors.amberDark }}>
                <AlertTriangle size={14} /> {expiringDocs.length} document{expiringDocs.length !== 1 ? "s" : ""} expiring soon
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {expiringDocs.map(d => {
                  const days = daysUntilExpiry(d.expiryDate);
                  const expired = days < 0;
                  return (
                    <span key={d.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", background: expired ? colors.redLight : colors.cardBg, border: `1px solid ${expired ? colors.danger + "60" : colors.warning + "40"}`, borderRadius: 20, fontSize: 12, color: expired ? colors.danger : colors.amberDark, fontWeight: 600 }}>
                      {d.label} — {expired ? `expired ${Math.abs(days)}d ago` : days === 0 ? "expires today" : `expires in ${days}d`}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {documents.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px", gap: 12 }}>
              <FileText size={40} style={{ color: colors.textMuted, opacity: 0.5 }} />
              <div style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>No documents yet</div>
              <div style={{ fontSize: 13, color: colors.textMuted, textAlign: "center", maxWidth: 380 }}>Store links to important documents like insurance, WWCC certificates and licensing agreements.</div>
              <Btn onClick={addDocument} style={{ marginTop: 4 }}>+ Add Document</Btn>
            </div>
          ) : (
            /* Finder-style three-pane library: folder sidebar / list / detail. */
            <div style={{ display: "grid", gridTemplateColumns: "224px minmax(0, 1fr) 332px", alignItems: "stretch", border: `1px solid ${colors.border}`, borderRadius: 12, overflow: "hidden", background: colors.cardBg }}>

              {/* ── LEFT: folder sidebar ── */}
              <div style={{ padding: 8, borderRight: `1px solid ${colors.borderLight}` }}>
                <FolderRow icon={FileText} label="All documents" count={documents.length}
                  selected={!dActiveCustomId && dSelectedFolder.dim === "all"}
                  onClick={() => setDSelectedFolder({ dim: "all", value: null })} colors={colors} />

                {/* Custom saved views — "Save current view" plus any saved folders. */}
                <SidebarGroupLabel colors={colors}>Custom</SidebarGroupLabel>
                {dSavingView ? (
                  <div style={{ padding: "2px 4px" }}>
                    <input autoFocus value={dNewViewName} onChange={e => setDNewViewName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") dCommitSaveView(); if (e.key === "Escape") { setDSavingView(false); setDNewViewName(""); } }}
                      onBlur={dCommitSaveView} placeholder="Folder name…"
                      style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.accent, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", background: colors.inputBg, color: colors.text }} />
                  </div>
                ) : (
                  <div onClick={() => { if (dViewIsCustomizable) { setDNewViewName(""); setDSavingView(true); } }}
                    title={dViewIsCustomizable ? "Save the current folder, filters and search as a custom folder" : "Pick a folder, filter or search first"}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 7, cursor: dViewIsCustomizable ? "pointer" : "not-allowed", opacity: dViewIsCustomizable ? 1 : 0.45, userSelect: "none" }}>
                    <FolderPlus size={15} style={{ flexShrink: 0, color: colors.textMuted }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: colors.text }}>Save current view…</span>
                  </div>
                )}
                {dOverrides.custom.map(c => (
                  <FolderRow key={"c:" + c.id} icon={Folder} label={c.name}
                    selected={dActiveCustomId === c.id}
                    onClick={() => applyDocCustom(c)}
                    onContextMenu={(e) => { e.preventDefault(); setDFolderMenu({ x: e.clientX, y: e.clientY, custom: c.id }); }}
                    renaming={dRenamingKey === "custom:" + c.id}
                    renameDraft={dRenameDraft} setRenameDraft={setDRenameDraft}
                    onCommitRename={() => { dRenameCustom(c.id, dRenameDraft); setDRenamingKey(null); }}
                    onCancelRename={() => setDRenamingKey(null)}
                    colors={colors} />
                ))}

                {docTypeFolders.length > 0 && <SidebarGroupLabel colors={colors}>By type</SidebarGroupLabel>}
                {docTypeFolders.map(f => (
                  dIsFolderHidden("type", f.value) ? null : (
                    <FolderRow key={"t:" + f.value} icon={Folder} count={f.count}
                      label={dFolderLabelFn("type", f.value)}
                      aliased={!!dOverrides.aliases[dFolderKey("type", f.value)]}
                      selected={!dActiveCustomId && dSelectedFolder.dim === "type" && dSelectedFolder.value === f.value}
                      onClick={() => setDSelectedFolder({ dim: "type", value: f.value })}
                      onContextMenu={(e) => { e.preventDefault(); setDFolderMenu({ x: e.clientX, y: e.clientY, dim: "type", value: f.value }); }}
                      renaming={dRenamingKey === dFolderKey("type", f.value)}
                      renameDraft={dRenameDraft} setRenameDraft={setDRenameDraft}
                      onCommitRename={() => { dRenameFolder("type", f.value, dRenameDraft); setDRenamingKey(null); }}
                      onCancelRename={() => setDRenamingKey(null)}
                      colors={colors} />
                  )
                ))}

                {docSchoolFolders.length > 0 && <SidebarGroupLabel colors={colors}>By school</SidebarGroupLabel>}
                {docSchoolFolders.map(f => (
                  dIsFolderHidden("school", f.value) ? null : (
                    <FolderRow key={"s:" + f.value} icon={Folder} count={f.count}
                      label={dOverrides.aliases[dFolderKey("school", f.value)] || f.name}
                      aliased={!!dOverrides.aliases[dFolderKey("school", f.value)]}
                      selected={!dActiveCustomId && dSelectedFolder.dim === "school" && dSelectedFolder.value === f.value}
                      onClick={() => setDSelectedFolder({ dim: "school", value: f.value })}
                      onContextMenu={(e) => { e.preventDefault(); setDFolderMenu({ x: e.clientX, y: e.clientY, dim: "school", value: f.value, fallback: f.name }); }}
                      renaming={dRenamingKey === dFolderKey("school", f.value)}
                      renameDraft={dRenameDraft} setRenameDraft={setDRenameDraft}
                      onCommitRename={() => { dRenameFolder("school", f.value, dRenameDraft); setDRenamingKey(null); }}
                      onCancelRename={() => setDRenamingKey(null)}
                      colors={colors} />
                  )
                ))}

                {/* Show-hidden control + greyed hidden folders with right-click Unhide */}
                {dOverrides.hidden.length > 0 && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${colors.borderLight}` }}>
                    <button onClick={() => setDShowHidden(h => !h)}
                      style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, color: colors.textLight, fontFamily: "inherit", padding: "4px 8px", display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <EyeOff size={12} /> {dShowHidden ? "Hide hidden folders" : `Show hidden folders (${dOverrides.hidden.length})`}
                    </button>
                    {dShowHidden && dOverrides.hidden.map(key => {
                      const [dim, ...rest] = key.split(":"); const value = rest.join(":");
                      const fallback = dim === "school" ? (schools.find(s => s.id === value)?.name || value) : value;
                      return (
                        <FolderRow key={"h:" + key} icon={Folder} dim greyed
                          label={dOverrides.aliases[key] || fallback}
                          onContextMenu={(e) => { e.preventDefault(); setDFolderMenu({ x: e.clientX, y: e.clientY, dim, value, hidden: true }); }}
                          colors={colors} />
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── MIDDLE: compact document list ── */}
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0, borderRight: `1px solid ${colors.borderLight}` }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 10, borderBottom: `1px solid ${colors.borderLight}` }}>
                  <div style={{ flex: 1, minWidth: 120, position: "relative" }}>
                    <input value={dSearch} onChange={e => setDSearch(e.target.value)} placeholder="Search documents…"
                      style={{ width: "100%", padding: "7px 30px 7px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", background: colors.inputBg, color: colors.text }} />
                    {dSearch && <button onClick={() => setDSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>}
                  </div>
                  {/* Filters — assigned teacher tucked behind one control */}
                  <div>
                    <button ref={dFiltersBtnRef} onClick={() => setDShowFilters(o => !o)}
                      style={{ padding: "7px 11px", border: "1px solid " + (anyDocFilter ? colors.accent : colors.inputBorder), borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: "inherit", background: anyDocFilter ? colors.accentLight : colors.cardBg, color: anyDocFilter ? colors.accent : colors.textLight, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
                      <SlidersHorizontal size={13} /> Filters{anyDocFilter ? ` (${dFilterCount})` : ""}
                    </button>
                    <PortalPopover anchorRef={dFiltersBtnRef} open={dShowFilters} onClose={() => setDShowFilters(false)} width={224}>
                      <div style={{ background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.35)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                        <FilterDropdown label="Assigned teacher" options={dfTeacherOptions} selected={dfTeacher} onChange={setDfTeacher} colors={colors} />
                        {anyDocFilter && (
                          <button onClick={clearDocFilters} style={{ padding: "6px 10px", border: "1px solid " + colors.border, borderRadius: 8, background: colors.cardBg, color: colors.textLight, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                            <X size={12} /> Clear filters
                          </button>
                        )}
                      </div>
                    </PortalPopover>
                  </div>
                </div>

                <div style={{ flex: 1 }}>
                  {filteredDocuments.length === 0 ? (
                    <div style={{ padding: "32px 20px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>No documents match the current view</div>
                  ) : filteredDocuments.map(d => {
                    const RowIcon = iconForFileName({ fileName: d.filename, url: d.url }) || FileText;
                    const isSel = dSelectedId === d.id;
                    const schoolName = d.schoolId ? (schools.find(s => s.id === d.schoolId)?.name || "") : "";
                    const sub = [d.type, schoolName].filter(Boolean).join(" · ");
                    return (
                      <div key={d.id} onClick={() => setDSelectedId(d.id)}
                        onMouseEnter={() => setDHovered(d.id)} onMouseLeave={() => setDHovered(null)}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", cursor: "pointer", borderBottom: "1px solid " + colors.borderLight, background: isSel ? colors.sidebarHover : (dHovered === d.id ? colors.blueLight : colors.cardBg) }}>
                        <RowIcon size={17} style={{ flexShrink: 0, color: isSel ? colors.white : colors.textMuted }} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: isSel ? colors.white : colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {d.label || <span style={{ fontStyle: "italic", color: isSel ? colors.white : colors.textMuted }}>Untitled</span>}
                          </div>
                          {sub && <div style={{ fontSize: 11, color: isSel ? "rgba(255,255,255,0.8)" : colors.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>}
                        </div>
                        {d.expiryDate && <ExpiryBadge dateStr={d.expiryDate} />}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ── RIGHT: detail panel ── */}
              <div style={{ minWidth: 0 }}>
                {!selectedDocument ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: "60px 24px", textAlign: "center", color: colors.textMuted }}>
                    <FileText size={32} style={{ opacity: 0.4 }} />
                    <div style={{ fontSize: 13 }}>Select a document to see its details</div>
                  </div>
                ) : (() => {
                  const d = selectedDocument;
                  const BigIcon = iconForFileName({ fileName: d.filename, url: d.url }) || FileText;
                  const teacherName = d.teacherId ? (teachers.find(t => t.id === d.teacherId)?.name || "") : "";
                  const schoolName = d.schoolId ? (schools.find(s => s.id === d.schoolId)?.name || "") : "";
                  const assignedTo = [teacherName, schoolName].filter(Boolean).join(", ");
                  const detailRow = (label, value) => (
                    <div style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: `1px solid ${colors.borderLight}` }}>
                      <div style={{ width: 92, flexShrink: 0, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: colors.text }}>{value}</div>
                    </div>
                  );
                  return (
                    <div>
                      <ResourcePreview
                        storagePath={d.storage_path || null}
                        linkUrl={d.url || null}
                        fileName={d.filename || null}
                        mime={d.mime_type || null}
                        title={d.label}
                        fallbackIcon={BigIcon}
                      />
                      <div style={{ padding: 16 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: colors.text, marginBottom: 6 }}>{d.label || <span style={{ fontStyle: "italic", color: colors.textMuted }}>Untitled</span>}</div>
                        {d.type && <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: colors.accentLight, color: colors.accentDark, marginBottom: 12 }}>{d.type}</span>}

                        <div style={{ marginTop: 6 }}>
                          {detailRow("Assigned to", assignedTo || <span style={{ color: colors.textMuted }}>—</span>)}
                          {detailRow("Expiry", d.expiryDate ? <ExpiryBadge dateStr={d.expiryDate} /> : <span style={{ color: colors.textMuted }}>—</span>)}
                          {detailRow("Link", d.storage_path && d.filename
                            ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}><FileText size={12} style={{ color: colors.accent, flexShrink: 0 }} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.filename}>{d.filename}</span></span>
                            : d.url
                              ? <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ color: colors.accent, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{d.url.replace(/^https?:\/\//, "")}</a>
                              : <span style={{ color: colors.textMuted }}>—</span>)}
                          {d.notes && detailRow("Notes", d.notes)}
                        </div>

                        {/* Action row — wired to the existing handlers */}
                        <div style={{ display: "flex", gap: 6, marginTop: 16, flexWrap: "wrap" }}>
                          {d.storage_path
                            ? <button onClick={() => openPrivate(d.storage_path, d.label || d.type)} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Eye size={13} /> View</button>
                            : d.url && <button onClick={() => setBrowserLink({ url: d.url, title: d.label || d.type })} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Eye size={13} /> View</button>}
                          {d.url && <button onClick={() => copyLink(d.url)} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Copy size={13} /> Copy</button>}
                          <button onClick={() => openEditDocument(d)} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Pencil size={13} /> Edit</button>
                          <button onClick={() => deleteDocument(d.id)} style={{ border: "1px solid " + colors.danger + "60", background: colors.cardBg, color: colors.danger, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Trash2 size={13} /> Delete</button>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Folder right-click context menu (overlay closes on outside click) */}
          {dFolderMenu && (
            <>
              <div onMouseDown={() => setDFolderMenu(null)} onContextMenu={(e) => { e.preventDefault(); setDFolderMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 9970 }} />
              <div style={{ position: "fixed", zIndex: 9971, top: dFolderMenu.y, left: dFolderMenu.x, minWidth: 160, background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.22)", padding: 4 }}>
                {dFolderMenu.custom ? (
                  <>
                    <button onClick={() => { const c = dOverrides.custom.find(x => x.id === dFolderMenu.custom); setDRenamingKey("custom:" + dFolderMenu.custom); setDRenameDraft(c?.name || ""); setDFolderMenu(null); }}
                      style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                      <Pencil size={13} /> Rename…
                    </button>
                    <button onClick={() => { if (dActiveCustomId === dFolderMenu.custom) { setDActiveCustomId(null); setDSelectedFolder({ dim: "all", value: null }); clearDocFilters(); setDSearch(""); } dDeleteCustom(dFolderMenu.custom); setDFolderMenu(null); }}
                      style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.danger, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                      <Trash2 size={13} /> Delete
                    </button>
                  </>
                ) : dFolderMenu.hidden ? (
                  <button onClick={() => { dUnhideFolder(dFolderMenu.dim, dFolderMenu.value); setDFolderMenu(null); }}
                    style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                    <Eye size={13} /> Unhide
                  </button>
                ) : (
                  <>
                    <button onClick={() => { setDRenamingKey(dFolderKey(dFolderMenu.dim, dFolderMenu.value)); setDRenameDraft(dFolderMenu.dim === "school" ? (dOverrides.aliases[dFolderKey("school", dFolderMenu.value)] || dFolderMenu.fallback || "") : dFolderLabelFn(dFolderMenu.dim, dFolderMenu.value)); setDFolderMenu(null); }}
                      style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                      <Pencil size={13} /> Rename…
                    </button>
                    {!!dOverrides.aliases[dFolderKey(dFolderMenu.dim, dFolderMenu.value)] && (
                      <button onClick={() => { dRenameFolder(dFolderMenu.dim, dFolderMenu.value, ""); setDFolderMenu(null); }}
                        style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                        <X size={13} /> Reset name
                      </button>
                    )}
                    <button onClick={() => { dHideFolder(dFolderMenu.dim, dFolderMenu.value); setDFolderMenu(null); }}
                      style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                      <EyeOff size={13} /> Hide
                    </button>
                  </>
                )}
              </div>
            </>
          )}

          {/* Add / edit-details modal — the single edit path */}
          {dEditId && dEditForm && (
            <div onMouseDown={cancelDocument} style={{ position: "fixed", inset: 0, zIndex: 9980, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
              <div onMouseDown={e => e.stopPropagation()} style={{ background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 12, padding: 20, width: 480, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, marginBottom: 16, display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <FileText size={15} /> {dEditId === "new" ? "Add document" : "Edit details"}
                </div>

                {/* Name */}
                <label style={modalLabel}>NAME *</label>
                <input value={dEditForm.label} onChange={e => setDEditForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. Public Liability Insurance 2025" style={{ ...inputStyle, padding: "7px 10px", marginBottom: 12 }} autoFocus />

                {/* Link OR uploaded file (exclusive) */}
                <label style={modalLabel}>LINK / FILE</label>
                {dEditForm.storage_path ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, background: colors.blueLight, fontSize: 12, marginBottom: 12 }}>
                    <FileText size={12} style={{ color: colors.accent, flexShrink: 0 }} />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={dEditForm.filename}>{dEditForm.filename}</span>
                    {dEditForm.size_bytes ? <span style={{ color: colors.textMuted, fontSize: 10, flexShrink: 0 }}>{fmtBytes(dEditForm.size_bytes)}</span> : null}
                    <button onClick={() => setDEditForm(f => ({ ...f, storage_path: "", filename: "", size_bytes: null, mime_type: "" }))} title="Clear uploaded file" style={{ border: "none", background: "none", cursor: "pointer", color: colors.textMuted, display: "inline-flex" }}><X size={12} /></button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 12 }}>
                    <input value={dEditForm.url} onChange={e => setDEditForm(f => ({ ...f, url: e.target.value }))} placeholder="https://…" style={{ ...inputStyle, padding: "7px 10px", flex: 1 }} />
                    <button onClick={() => pickAndUploadFile(BUCKET_DOCUMENTS, dEditForm.id, (patch) => setDEditForm(f => ({ ...f, ...patch })))} disabled={uploadingFor === dEditForm.id} title="Upload a file instead"
                      style={{ border: `1px solid ${colors.inputBorder}`, background: colors.cardBg, borderRadius: 6, padding: "7px 9px", cursor: uploadingFor === dEditForm.id ? "wait" : "pointer", display: "inline-flex", alignItems: "center", color: colors.textLight }}>
                      {uploadingFor === dEditForm.id ? <Loader size={13} className="spin" /> : <Upload size={13} />}
                    </button>
                  </div>
                )}

                {/* Type + Expiry */}
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={modalLabel}>TYPE</label>
                    <input list="docTypeModalList" value={dEditForm.type} onChange={e => setDEditForm(f => ({ ...f, type: e.target.value }))} placeholder="Type or pick…" style={{ ...inputStyle, padding: "7px 10px" }} />
                    <datalist id="docTypeModalList">
                      {documentTypeOptions.map(t => <option key={t} value={t} />)}
                    </datalist>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={modalLabel}>EXPIRY</label>
                    <input type="date" value={dEditForm.expiryDate || ""} onChange={e => setDEditForm(f => ({ ...f, expiryDate: e.target.value }))} style={{ ...inputStyle, padding: "7px 10px" }} />
                  </div>
                </div>

                {/* Teacher + School */}
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={modalLabel}>TEACHER</label>
                    <select value={dEditForm.teacherId || ""} onChange={e => setDEditForm(f => ({ ...f, teacherId: e.target.value }))} style={modalSelect}>
                      <option value="">No teacher</option>
                      {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={modalLabel}>SCHOOL</label>
                    <select value={dEditForm.schoolId || ""} onChange={e => setDEditForm(f => ({ ...f, schoolId: e.target.value }))} style={modalSelect}>
                      <option value="">No school</option>
                      {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                </div>

                {/* Notes */}
                <label style={modalLabel}>NOTES</label>
                <input value={dEditForm.notes || ""} onChange={e => setDEditForm(f => ({ ...f, notes: e.target.value }))} placeholder="Brief note (optional)" style={{ ...inputStyle, padding: "7px 10px", marginBottom: 14 }} />

                {dEditErr && <div style={{ fontSize: 12, color: colors.danger, marginBottom: 10 }}>{dEditErr}</div>}

                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={saveDocument} style={{ padding: "8px 18px", border: "none", borderRadius: 8, background: colors.success, color: "#fff", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Check size={14} /> Save
                  </button>
                  <button onClick={cancelDocument} style={{ padding: "8px 16px", border: "1px solid " + colors.border, borderRadius: 8, background: colors.cardBg, color: colors.textMuted, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>Cancel</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {browserLink && (
        <LinkBrowser initialUrl={browserLink.url} title={browserLink.title} onClose={() => setBrowserLink(null)} />
      )}
    </div>
  );
}

// ── Sidebar group heading (e.g. "By instrument") ──────────────
function SidebarGroupLabel({ children, colors }) {
  return <div style={{ fontSize: 10, fontWeight: 700, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, padding: "10px 8px 4px" }}>{children}</div>;
}

// ── One folder row in the library sidebar ─────────────────────
// Renders a clickable folder with an optional count. When `renaming` is set it
// becomes an inline alias editor (commit on Enter/blur, cancel on Escape).
// `greyed` is used for hidden folders revealed by "Show hidden folders".
function FolderRow({ icon: Icon, label, count, selected, greyed, aliased, indent = 0, onClick, onDoubleClick, onContextMenu, renaming, renameDraft, setRenameDraft, onCommitRename, onCancelRename, hasChildren, expanded, onToggleExpand, colors }) {
  const [hover, setHover] = useState(false);
  if (renaming) {
    return (
      <div style={{ padding: "2px 4px", paddingLeft: 8 + indent * 14 }}>
        <input autoFocus value={renameDraft} onChange={e => setRenameDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") onCommitRename(); if (e.key === "Escape") onCancelRename(); }}
          onBlur={onCommitRename}
          style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.accent, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", background: colors.inputBg, color: colors.text }} />
      </div>
    );
  }
  const bg = selected ? colors.sidebarHover : (hover ? colors.blueLight : "transparent");
  const fg = selected ? colors.white : (greyed ? colors.textMuted : colors.text);
  // The disclosure slot only renders for tree rows that opt in via onToggleExpand
  // (the Resources folder tree). Without it the layout is byte-for-byte the old
  // one, so the Documents-side rows are unaffected.
  const disclosure = onToggleExpand ? (
    hasChildren ? (
      <button onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
        title={expanded ? "Collapse" : "Expand"} aria-label={expanded ? "Collapse folder" : "Expand folder"}
        style={{ flexShrink: 0, width: 16, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", background: "none", padding: 0, cursor: "pointer", color: selected ? colors.white : colors.textMuted }}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
    ) : <span style={{ flexShrink: 0, width: 16 }} />
  ) : null;
  return (
    <div onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      title={aliased ? "Renamed folder (label only)" : undefined}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", paddingLeft: 8 + indent * 14, borderRadius: 7, cursor: "pointer", background: bg, opacity: greyed ? 0.55 : 1, userSelect: "none" }}>
      {disclosure}
      <Icon size={15} style={{ flexShrink: 0, color: selected ? colors.white : colors.textMuted }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: selected ? 600 : 500, color: fg, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {typeof count === "number" && <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, color: selected ? colors.white : colors.textMuted, opacity: selected ? 0.85 : 1 }}>{count}</span>}
    </div>
  );
}

// ── Inline folder-name input (new root folder / new subfolder) ─
// Commits on Enter or blur, cancels on Escape. Indented to sit under its
// parent in the tree.
function FolderNameInput({ depth = 0, value, setValue, onCommit, onCancel, colors }) {
  return (
    <div style={{ padding: "2px 4px", paddingLeft: 8 + depth * 14 }}>
      <input autoFocus value={value} onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") onCommit(); if (e.key === "Escape") onCancel(); }}
        onBlur={onCommit} placeholder="Folder name…"
        style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.accent, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", background: colors.inputBg, color: colors.text }} />
    </div>
  );
}

// ── Folder picker (the "Add to folder…" tree of buttons) ───────
// Renders the shared tree as indented, clickable rows. Picking a folder
// files the in-flight resource there.
function FolderPicker({ childrenOf, onPick, colors }) {
  const render = (parentId, depth) => childrenOf(parentId).map(f => (
    <React.Fragment key={f.id}>
      <button onClick={() => onPick(f.id)}
        style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 8px", paddingLeft: 8 + depth * 16, borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}
        onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
        onMouseLeave={e => e.currentTarget.style.background = "none"}>
        <Folder size={14} style={{ flexShrink: 0, color: colors.textMuted }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
      </button>
      {render(f.id, depth + 1)}
    </React.Fragment>
  ));
  return <div>{render(null, 0)}</div>;
}

// ── Shared folder-overrides hook ──────────────────────────────
// One copy of the sidebar-override logic for both surfaces. `settingsKey` is
// "resource_folder_overrides" or "document_folder_overrides" — the two rows
// never interfere. Returns the live overrides plus aliasing / hiding / custom-
// folder operations. Each op persists optimistically and rolls back on error.
function useFolderOverrides(settingsKey, notify) {
  const [overrides, setOverrides] = useState({ aliases: {}, hidden: [], custom: [] });
  useEffect(() => { fetchFolderOverrides(settingsKey).then(setOverrides); }, [settingsKey]);
  const persist = (next) => {
    setOverrides(next);
    saveFolderOverrides(settingsKey, next).catch(() => {
      notify("Couldn't save folder change — try again", "danger");
      fetchFolderOverrides(settingsKey).then(setOverrides);
    });
  };
  const folderKey = (dim, value) => `${dim}:${value}`;
  const folderLabel = (dim, value) => overrides.aliases[folderKey(dim, value)] || value;
  const isFolderHidden = (dim, value) => overrides.hidden.includes(folderKey(dim, value));
  const renameFolder = (dim, value, alias) => {
    const key = folderKey(dim, value);
    const aliases = { ...overrides.aliases };
    const trimmed = (alias || "").trim();
    if (trimmed && trimmed !== value) aliases[key] = trimmed; else delete aliases[key];
    persist({ ...overrides, aliases });
  };
  const hideFolder = (dim, value) => {
    const key = folderKey(dim, value);
    if (overrides.hidden.includes(key)) return;
    persist({ ...overrides, hidden: [...overrides.hidden, key] });
  };
  const unhideFolder = (dim, value) =>
    persist({ ...overrides, hidden: overrides.hidden.filter(k => k !== folderKey(dim, value)) });
  const addCustom = (name, filters) => {
    const id = crypto.randomUUID();
    persist({ ...overrides, custom: [...overrides.custom, { id, name: name.trim(), filters }] });
    return id;
  };
  const renameCustom = (id, name) => {
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    persist({ ...overrides, custom: overrides.custom.map(c => c.id === id ? { ...c, name: trimmed } : c) });
  };
  const deleteCustom = (id) =>
    persist({ ...overrides, custom: overrides.custom.filter(c => c.id !== id) });
  return { overrides, folderKey, folderLabel, isFolderHidden, renameFolder, hideFolder, unhideFolder, addCustom, renameCustom, deleteCustom };
}

// ── Portal popover ────────────────────────────────────────────
// Renders its children in a fixed-position layer attached to document.body,
// anchored under `anchorRef`, so it can never be clipped by an ancestor's
// overflow:hidden (the unified library container). Re-positions on scroll /
// resize and is kept inside the viewport. A full-screen overlay closes it on
// an outside click.
function PortalPopover({ anchorRef, open, onClose, width = 224, children }) {
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const margin = 8;
      let left = r.right - width;                       // right-aligned to trigger
      left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
      const top = Math.min(r.bottom + 6, window.innerHeight - margin);
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, width]);
  if (!open || !pos) return null;
  return createPortal(
    <>
      <div onMouseDown={onClose} style={{ position: "fixed", inset: 0, zIndex: 9990 }} />
      <div style={{ position: "fixed", zIndex: 9991, top: pos.top, left: pos.left, width }}>{children}</div>
    </>,
    document.body
  );
}

// ── Multi-select filter dropdown ──────────────────────────────
// Button + checkbox popover. `options` is [{value, label}]; `selected`
// is an array of values. Empty selection = no filter.
function FilterDropdown({ label, options, selected, onChange, colors }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (val) =>
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);

  const count = selected.length;
  const active = count > 0;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)}
        style={{
          padding: "7px 10px", border: "1px solid " + (active ? colors.accent : colors.inputBorder),
          borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: "inherit",
          background: active ? colors.accentLight : colors.cardBg,
          color: active ? colors.accent : colors.textLight,
          cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap",
        }}>
        {label}{active ? ` (${count})` : ""} <ChevronDown size={13} />
      </button>
      {open && (
        <div style={{
          position: "absolute", zIndex: 30, top: "calc(100% + 4px)", left: 0,
          minWidth: 180, maxHeight: 280, overflowY: "auto",
          background: colors.cardBg, border: "1px solid " + colors.border,
          borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.18)", padding: 6,
        }}>
          {options.length === 0 ? (
            <div style={{ padding: "6px 8px", fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>No options</div>
          ) : options.map(opt => (
            <label key={opt.value}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 6, cursor: "pointer", fontSize: 13, color: colors.text }}>
              <input type="checkbox" checked={selected.includes(opt.value)} onChange={() => toggle(opt.value)} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opt.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
