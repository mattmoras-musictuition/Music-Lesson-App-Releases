// ============================================================
// DOCUMENTS & RESOURCES MANAGER
// Resources: books, sheet music, websites, equipment links.
// Documents: insurance, WWCC, licensing agreements, policies.
// ============================================================

import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Library, FileText, Link, Plus, X, Check, Pencil, Trash2, Copy, AlertTriangle, Clock, Building2, Guitar, Eye, Upload, Download as DownloadIcon, Loader, ChevronDown, Sparkles, Folder, FolderPlus, EyeOff, SlidersHorizontal, Save } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { uid as makeId } from "../utils/helpers";
import { PageTitle, NavButtons, Btn, Card, EmptyState, PAGE_COLORS } from "../components/ui/SharedUI";
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
import { iconForResourceType, iconForFileName } from "../utils/resourceTypeIcons";

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

  // Remaining filters (instrument + type now live in the sidebar). Each is a
  // multi-select; empty array = no constraint. Combine with AND. Tucked behind
  // the compact "Filters" control so the three-pane view stays calm.
  const [rfSkill,      setRfSkill]      = useState([]);
  const [rfSchool,     setRfSchool]     = useState([]);
  const [rfUploadedBy, setRfUploadedBy] = useState([]);
  const [rfSource,     setRfSource]     = useState([]);
  const [showFilters,  setShowFilters]  = useState(false);
  const rFiltersBtnRef = useRef(null);

  // ── Finder-style library state ───────────────────────────────
  // selectedFolder narrows the middle list: { dim:"all" } shows everything;
  // { dim:"instrument"|"type", value } narrows to that folder. selectedId is
  // the row whose detail shows in the right pane (null = placeholder).
  const [selectedFolder, setSelectedFolder] = useState({ dim: "all", value: null });
  const [selectedId,     setSelectedId]     = useState(null);
  // Shared sidebar overrides (aliases + hidden folders) from app_settings.
  const [overrides,  setOverrides]  = useState({ aliases: {}, hidden: [] });
  const [showHidden, setShowHidden] = useState(false);
  // Right-click context menu on a folder: { x, y, dim, value }.
  const [folderMenu, setFolderMenu] = useState(null);
  // Inline rename of a folder alias: the folder key being renamed + draft text.
  const [renamingKey, setRenamingKey] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");

  // ── Documents state ─────────────────────────────────────────
  const [dEditId,   setDEditId]   = useState(null);
  const [dEditForm, setDEditForm] = useState(null);
  const [dSearch,   setDSearch]   = useState("");
  const [dTypeFilter, setDTypeFilter] = useState("");
  const [dSchoolFilter, setDSchoolFilter] = useState("");
  const [dHovered,  setDHovered]  = useState(null);

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
  // Shared folder overrides (aliases + hidden) for the sidebar.
  useEffect(() => { fetchFolderOverrides().then(setOverrides); }, []);

  // ── Folder helpers ───────────────────────────────────────────
  // A folder is identified by `${dim}:${value}` (dim = "instrument" | "type").
  const folderKey = (dim, value) => `${dim}:${value}`;
  const folderLabel = (dim, value) => overrides.aliases[folderKey(dim, value)] || value;
  const isFolderHidden = (dim, value) => overrides.hidden.includes(folderKey(dim, value));

  // Persist overrides optimistically: update local state immediately, then write
  // the shared app_settings row. On failure, reload the canonical row so local
  // state never drifts from what other clients see.
  const persistOverrides = async (next) => {
    setOverrides(next);
    try { await saveFolderOverrides(next); }
    catch (e) { notify("Couldn't save folder change — try again", "danger"); fetchFolderOverrides().then(setOverrides); }
  };
  const renameFolder = (dim, value, alias) => {
    const key = folderKey(dim, value);
    const aliases = { ...overrides.aliases };
    const trimmed = (alias || "").trim();
    if (trimmed && trimmed !== value) aliases[key] = trimmed; else delete aliases[key];
    persistOverrides({ ...overrides, aliases });
  };
  const hideFolder = (dim, value) => {
    const key = folderKey(dim, value);
    if (overrides.hidden.includes(key)) return;
    // Leaving a hidden folder selected would show an empty/odd list — fall back
    // to "All resources" if the folder being hidden is the current selection.
    if (selectedFolder.dim === dim && selectedFolder.value === value) setSelectedFolder({ dim: "all", value: null });
    persistOverrides({ ...overrides, hidden: [...overrides.hidden, key] });
  };
  const unhideFolder = (dim, value) => {
    const key = folderKey(dim, value);
    persistOverrides({ ...overrides, hidden: overrides.hidden.filter(k => k !== key) });
  };
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

  const anyResourceFilter = !!(rfSkill.length || rfSchool.length || rfUploadedBy.length || rfSource.length);
  const filterCount = rfSkill.length + rfSchool.length + rfUploadedBy.length + rfSource.length;
  const clearResourceFilters = () => { setRfSkill([]); setRfSchool([]); setRfUploadedBy([]); setRfSource([]); };

  // ── Sidebar folders (auto-derived live from the data) ─────────
  // One folder per distinct instrument value, one per distinct type/category
  // value present in the resources. New values appear automatically. Each folder
  // carries its own resource count (ignores search/filters/other folders).
  const instrumentFolders = useMemo(() => {
    const counts = new Map();
    for (const r of resources) { const v = (r.instrument || "").trim(); if (v) counts.set(v, (counts.get(v) || 0) + 1); }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
  }, [resources]);
  const typeFolders = useMemo(() => {
    const counts = new Map();
    for (const r of resources) { const v = (r.category || "").trim(); if (v) counts.set(v, (counts.get(v) || 0) + 1); }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
  }, [resources]);

  // ── Filter: folder narrowing + remaining filters + search (AND) ─
  const filteredResources = useMemo(() => resources.filter(r => {
    if (selectedFolder.dim === "instrument" && r.instrument !== selectedFolder.value) return false;
    if (selectedFolder.dim === "type"       && r.category   !== selectedFolder.value) return false;
    if (rfSkill.length      && !rfSkill.includes(r.skill_level))         return false;
    if (rfSchool.length     && !rfSchool.includes(r.school_id))          return false;
    if (rfUploadedBy.length && !rfUploadedBy.includes(r.added_by_name))  return false;
    if (rfSource.length     && !rfSource.includes(r.source || "direct")) return false;
    if (rSearch.trim()) {
      const q = rSearch.trim().toLowerCase();
      if (!(r.label||"").toLowerCase().includes(q) && !(r.description||"").toLowerCase().includes(q)) return false;
    }
    return true;
  }), [resources, selectedFolder, rfSkill, rfSchool, rfUploadedBy, rfSource, rSearch]);

  // Keep the detail pane coherent: if the selected row drops out of the list
  // (folder/filter/search change or deletion), clear the selection.
  useEffect(() => {
    if (selectedId && !filteredResources.some(r => r.id === selectedId)) setSelectedId(null);
  }, [filteredResources, selectedId]);

  const selectedResource = useMemo(() => resources.find(r => r.id === selectedId) || null, [resources, selectedId]);
  const schoolNameById = useMemo(() => {
    const m = new Map(); for (const s of (schools || [])) m.set(s.id, s.name); return m;
  }, [schools]);

  // ── Documents CRUD ──────────────────────────────────────────
  const addDocument = () => {
    const id = makeId();
    // Session 96: storage_path / filename / size_bytes / mime_type set on
    // upload. Row is either URL-based (d.url) OR file-based (d.storage_path),
    // but the edit form is initialised blank and user picks one.
    const blank = { id, label: "", type: "", teacherId: "", schoolId: "", expiryDate: "", url: "", notes: "", storage_path: "", filename: "", size_bytes: null, mime_type: "", _isNew: true };
    setDocuments(prev => [blank, ...prev]);
    setDEditId(id); setDEditForm({ ...blank });
  };
  const saveDocument = () => {
    if (!dEditForm) return;
    const { _isNew, ...toSave } = dEditForm;
    setDocuments(prev => prev.map(d => d.id === dEditId ? toSave : d));
    setDEditId(null); setDEditForm(null);
    notify("Document saved");
  };
  const cancelDocument = () => {
    const d = documents.find(d => d.id === dEditId);
    if (d && d._isNew) setDocuments(prev => prev.filter(d => d.id !== dEditId));
    setDEditId(null); setDEditForm(null);
  };
  const deleteDocument = (id) => {
    const d = documents.find(d => d.id === id);
    // Session 96: remove uploaded blob from private bucket alongside the row.
    if (d?.storage_path) deleteFromBucket(BUCKET_DOCUMENTS, d.storage_path);
    setDocuments(prev => prev.filter(d => d.id !== id));
    if (dEditId === id) { setDEditId(null); setDEditForm(null); }
    notify("Document removed");
  };

  const filteredDocuments = useMemo(() => documents.filter(d => {
    if (d._isNew) return true;
    if (dTypeFilter && d.type !== dTypeFilter) return false;
    if (dSchoolFilter && d.schoolId !== dSchoolFilter) return false;
    if (dSearch) {
      const q = dSearch.toLowerCase();
      return (d.label||"").toLowerCase().includes(q) || (d.notes||"").toLowerCase().includes(q);
    }
    return true;
  }), [documents, dSearch, dTypeFilter, dSchoolFilter]);

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
  const thStyle = { padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "#fff", textTransform: "uppercase", letterSpacing: 0.5, background: colors.sidebarHover, whiteSpace: "nowrap" };
  const inputStyle = { width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", background: colors.inputBg, color: colors.text };
  const iconBtn = (onClick, icon, col, title, extra = {}) => (
    <button onClick={onClick} title={title} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: col, borderRadius: 6, padding: "4px 7px", cursor: "pointer", display: "inline-flex", alignItems: "center", ...extra }}>{icon}</button>
  );
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

              {/* ── LEFT: folder sidebar ── */}
              <div style={{ padding: 8, borderRight: `1px solid ${colors.borderLight}` }}>
                <FolderRow icon={Library} label="All resources" count={resources.length}
                  selected={selectedFolder.dim === "all"}
                  onClick={() => setSelectedFolder({ dim: "all", value: null })} colors={colors} />

                {instrumentFolders.length > 0 && <SidebarGroupLabel colors={colors}>By instrument</SidebarGroupLabel>}
                {instrumentFolders.map(f => (
                  isFolderHidden("instrument", f.value) ? null : (
                    <FolderRow key={"i:" + f.value} icon={Folder} count={f.count}
                      label={folderLabel("instrument", f.value)}
                      aliased={!!overrides.aliases[folderKey("instrument", f.value)]}
                      selected={selectedFolder.dim === "instrument" && selectedFolder.value === f.value}
                      onClick={() => setSelectedFolder({ dim: "instrument", value: f.value })}
                      onContextMenu={(e) => { e.preventDefault(); setFolderMenu({ x: e.clientX, y: e.clientY, dim: "instrument", value: f.value }); }}
                      renaming={renamingKey === folderKey("instrument", f.value)}
                      renameDraft={renameDraft} setRenameDraft={setRenameDraft}
                      onCommitRename={() => { renameFolder("instrument", f.value, renameDraft); setRenamingKey(null); }}
                      onCancelRename={() => setRenamingKey(null)}
                      colors={colors} />
                  )
                ))}

                {typeFolders.length > 0 && <SidebarGroupLabel colors={colors}>By type</SidebarGroupLabel>}
                {typeFolders.map(f => (
                  isFolderHidden("type", f.value) ? null : (
                    <FolderRow key={"t:" + f.value} icon={Folder} count={f.count}
                      label={folderLabel("type", f.value)}
                      aliased={!!overrides.aliases[folderKey("type", f.value)]}
                      selected={selectedFolder.dim === "type" && selectedFolder.value === f.value}
                      onClick={() => setSelectedFolder({ dim: "type", value: f.value })}
                      onContextMenu={(e) => { e.preventDefault(); setFolderMenu({ x: e.clientX, y: e.clientY, dim: "type", value: f.value }); }}
                      renaming={renamingKey === folderKey("type", f.value)}
                      renameDraft={renameDraft} setRenameDraft={setRenameDraft}
                      onCommitRename={() => { renameFolder("type", f.value, renameDraft); setRenamingKey(null); }}
                      onCancelRename={() => setRenamingKey(null)}
                      colors={colors} />
                  )
                ))}

                {/* Show-hidden control + greyed hidden folders with right-click Unhide */}
                {overrides.hidden.length > 0 && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${colors.borderLight}` }}>
                    <button onClick={() => setShowHidden(h => !h)}
                      style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, color: colors.textLight, fontFamily: "inherit", padding: "4px 8px", display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <EyeOff size={12} /> {showHidden ? "Hide hidden folders" : `Show hidden folders (${overrides.hidden.length})`}
                    </button>
                    {showHidden && overrides.hidden.map(key => {
                      const [dim, ...rest] = key.split(":"); const value = rest.join(":");
                      return (
                        <FolderRow key={"h:" + key} icon={Folder} dim greyed
                          label={folderLabel(dim, value)}
                          onContextMenu={(e) => { e.preventDefault(); setFolderMenu({ x: e.clientX, y: e.clientY, dim, value, hidden: true }); }}
                          colors={colors} />
                      );
                    })}
                  </div>
                )}
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

                <div style={{ flex: 1 }}>
                  {filteredResources.length === 0 ? (
                    <div style={{ padding: "32px 20px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>No resources match the current view</div>
                  ) : filteredResources.map(r => {
                    const RowIcon = iconForResourceType(r.category)
                      || iconForFileName({ fileName: r.file_name, url: r.file_url || r.url });
                    const isSel = selectedId === r.id;
                    const subjName = r.source === "student_note" ? resolveSubjectName(r.source_subject_type, r.source_subject_id, subjectMaps) : null;
                    const sub = [r.instrument, r.category].filter(Boolean).join(" · ") || (subjName ? `from ${subjName}'s notes` : "");
                    return (
                      <div key={r.id} onClick={() => setSelectedId(r.id)}
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
                  const isImg = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(r.file_url || r.url || r.file_name || "");
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
                      <div style={{ height: 140, background: colors.bg, display: "flex", alignItems: "center", justifyContent: "center", borderBottom: `1px solid ${colors.borderLight}`, overflow: "hidden" }}>
                        {isImg && (r.file_url || r.url)
                          ? <img src={r.file_url || r.url} alt={r.label} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                          : <BigIcon size={48} style={{ color: colors.textMuted, opacity: 0.7 }} />}
                      </div>
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
                          {link && <button onClick={() => setBrowserLink({ url: link, title: r.label || r.category })} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Eye size={13} /> Preview</button>}
                          {link && <button onClick={() => copyLink(link)} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Copy size={13} /> Copy</button>}
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

          {/* Folder right-click context menu (overlay closes on outside click) */}
          {folderMenu && (
            <>
              <div onMouseDown={() => setFolderMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFolderMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 9970 }} />
              <div style={{ position: "fixed", zIndex: 9971, top: folderMenu.y, left: folderMenu.x, minWidth: 160, background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.22)", padding: 4 }}>
                {folderMenu.hidden ? (
                  <button onClick={() => { unhideFolder(folderMenu.dim, folderMenu.value); setFolderMenu(null); }}
                    style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                    <Eye size={13} /> Unhide
                  </button>
                ) : (
                  <>
                    <button onClick={() => { setRenamingKey(folderKey(folderMenu.dim, folderMenu.value)); setRenameDraft(folderLabel(folderMenu.dim, folderMenu.value)); setFolderMenu(null); }}
                      style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                      <Pencil size={13} /> Rename…
                    </button>
                    {!!overrides.aliases[folderKey(folderMenu.dim, folderMenu.value)] && (
                      <button onClick={() => { renameFolder(folderMenu.dim, folderMenu.value, ""); setFolderMenu(null); }}
                        style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                        <X size={13} /> Reset name
                      </button>
                    )}
                    <button onClick={() => { hideFolder(folderMenu.dim, folderMenu.value); setFolderMenu(null); }}
                      style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: colors.text, fontFamily: "inherit", padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                      <EyeOff size={13} /> Hide
                    </button>
                  </>
                )}
              </div>
            </>
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
            <div style={{ marginBottom: 16, padding: "12px 16px", background: colors.amberLight, border: "1px solid #FED7AA", borderRadius: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 13, color: colors.amberDark }}>
                <AlertTriangle size={14} /> {expiringDocs.length} document{expiringDocs.length !== 1 ? "s" : ""} expiring soon
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {expiringDocs.map(d => {
                  const days = daysUntilExpiry(d.expiryDate);
                  const expired = days < 0;
                  return (
                    <span key={d.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", background: expired ? "#FEF2F2" : colors.cardBg, border: `1px solid ${expired ? colors.danger + "60" : "#FED7AA"}`, borderRadius: 20, fontSize: 12, color: expired ? colors.danger : colors.amberDark, fontWeight: 600 }}>
                      {d.label} — {expired ? `expired ${Math.abs(days)}d ago` : days === 0 ? "expires today" : `expires in ${days}d`}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          <Card style={{ marginBottom: 16, padding: 14 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 160, position: "relative" }}>
                <input value={dSearch} onChange={e => setDSearch(e.target.value)} placeholder="Search documents…"
                  style={{ width: "100%", padding: "8px 32px 8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                {dSearch && <button onClick={() => setDSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>}
              </div>
              <select value={dTypeFilter} onChange={e => setDTypeFilter(e.target.value)} style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
                <option value="">All Types</option>
                {documentTypeOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={dSchoolFilter} onChange={e => setDSchoolFilter(e.target.value)} style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
                <option value="">All Schools</option>
                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </Card>

          {documents.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px", gap: 12 }}>
              <FileText size={40} style={{ color: colors.textMuted, opacity: 0.5 }} />
              <div style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>No documents yet</div>
              <div style={{ fontSize: 13, color: colors.textMuted, textAlign: "center", maxWidth: 380 }}>Store links to important documents like insurance, WWCC certificates and licensing agreements.</div>
              <Btn onClick={addDocument} style={{ marginTop: 4 }}>+ Add Document</Btn>
            </div>
          ) : (
            <div style={{ background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 12, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Label</th>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Assigned to</th>
                    <th style={thStyle}>Expiry</th>
                    <th style={thStyle}>Link</th>
                    <th style={{ ...thStyle, width: 100 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDocuments.map(d => {
                    const isEditing = dEditId === d.id;
                    const teacherName = teachers.find(t => t.id === d.teacherId)?.name || "";
                    const schoolName  = schools.find(s => s.id === d.schoolId)?.name || "";
                    const assignedTo  = [teacherName, schoolName].filter(Boolean).join(", ");
                    return (
                      <tr key={d.id}
                        style={{ background: isEditing ? colors.blueLight : (dHovered === d.id ? colors.blueLight : colors.cardBg), borderBottom: "1px solid " + colors.borderLight }}
                        onMouseEnter={() => setDHovered(d.id)} onMouseLeave={() => setDHovered(null)}>

                        {/* Label */}
                        <td style={{ padding: "8px 12px", fontWeight: 600 }}>
                          {isEditing
                            ? <input autoFocus value={dEditForm.label} onChange={e => setDEditForm(f => ({ ...f, label: e.target.value }))} onKeyDown={e => { if (e.key === "Escape") cancelDocument(); }} placeholder="e.g. Public Liability Insurance 2025" style={inputStyle} />
                            : d.label || <span style={{ color: colors.textMuted, fontStyle: "italic" }}>—</span>}
                        </td>

                        {/* Type */}
                        <td style={{ padding: "8px 12px" }}>
                          {isEditing
                            ? <>
                                <input list={`docTypeList-${d.id}`} value={dEditForm.type} onChange={e => setDEditForm(f => ({ ...f, type: e.target.value }))} placeholder="Type or pick…" onKeyDown={e => { if (e.key === "Escape") cancelDocument(); }} style={{ padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text, width: 140 }} />
                                <datalist id={`docTypeList-${d.id}`}>
                                  {documentTypeOptions.map(t => <option key={t} value={t} />)}
                                </datalist>
                              </>
                            : d.type
                              ? <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: colors.blueLight, color: colors.sidebarHover, border: "1px solid " + colors.sidebarHover + "30" }}>{d.type}</span>
                              : <span style={{ color: colors.textMuted }}>—</span>}
                        </td>

                        {/* Assigned to */}
                        <td style={{ padding: "8px 12px", color: colors.textLight, fontSize: 12 }}>
                          {isEditing ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              <select value={dEditForm.teacherId} onChange={e => setDEditForm(f => ({ ...f, teacherId: e.target.value }))} style={{ padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 12, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
                                <option value="">No teacher</option>
                                {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                              </select>
                              <select value={dEditForm.schoolId} onChange={e => setDEditForm(f => ({ ...f, schoolId: e.target.value }))} style={{ padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 12, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
                                <option value="">No school</option>
                                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                              </select>
                            </div>
                          ) : assignedTo || <span style={{ color: colors.textMuted }}>—</span>}
                        </td>

                        {/* Expiry */}
                        <td style={{ padding: "8px 12px" }}>
                          {isEditing
                            ? <input type="date" value={dEditForm.expiryDate || ""} onChange={e => setDEditForm(f => ({ ...f, expiryDate: e.target.value }))} style={{ padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                            : <ExpiryBadge dateStr={d.expiryDate} />}
                        </td>

                        {/* Link */}
                        <td style={{ padding: "8px 12px", maxWidth: 220 }}>
                          {isEditing ? (
                            dEditForm.storage_path ? (
                              // Session 96: uploaded-file display for Documents.
                              // Same pattern as Resources but bucket is private.
                              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, background: colors.blueLight, fontSize: 12 }}>
                                  <FileText size={12} style={{ color: colors.accent, flexShrink: 0 }} />
                                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={dEditForm.filename}>{dEditForm.filename}</span>
                                  {dEditForm.size_bytes ? <span style={{ color: colors.textMuted, fontSize: 10, flexShrink: 0 }}>{fmtBytes(dEditForm.size_bytes)}</span> : null}
                                  <button onClick={() => setDEditForm(f => ({ ...f, storage_path: "", filename: "", size_bytes: null, mime_type: "" }))} title="Clear uploaded file"
                                    style={{ border: "none", background: "none", cursor: "pointer", color: colors.textMuted, display: "inline-flex" }}>
                                    <X size={12} />
                                  </button>
                                </div>
                                <input value={dEditForm.notes || ""} onChange={e => setDEditForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes (optional)" style={{ ...inputStyle, fontSize: 12, color: colors.textLight }} />
                              </div>
                            ) : (
                              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                  <input value={dEditForm.url} onChange={e => setDEditForm(f => ({ ...f, url: e.target.value }))} placeholder="https://…" style={{ ...inputStyle, flex: 1 }} />
                                  <button onClick={() => pickAndUploadFile(BUCKET_DOCUMENTS, dEditId, (patch) => setDEditForm(f => ({ ...f, ...patch })))}
                                    disabled={uploadingFor === dEditId}
                                    title="Upload a file instead"
                                    style={{ border: `1px solid ${colors.inputBorder}`, background: colors.cardBg, borderRadius: 6, padding: "5px 7px", cursor: uploadingFor === dEditId ? "wait" : "pointer", display: "inline-flex", alignItems: "center", color: colors.textLight }}>
                                    {uploadingFor === dEditId ? <Loader size={12} className="spin" /> : <Upload size={12} />}
                                  </button>
                                </div>
                                <input value={dEditForm.notes || ""} onChange={e => setDEditForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes (optional)" style={{ ...inputStyle, fontSize: 12, color: colors.textLight }} />
                              </div>
                            )
                          ) : d.storage_path && d.filename ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: colors.textLight, fontSize: 12 }}>
                              <FileText size={11} style={{ color: colors.accent }} />
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }} title={d.filename}>{d.filename}</span>
                            </span>
                          ) : d.url ? (
                            <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: colors.accent, textDecoration: "none", fontSize: 12 }}><Link size={11} />{d.url.replace(/^https?:\/\//, "").slice(0, 28)}{d.url.replace(/^https?:\/\//, "").length > 28 ? "…" : ""}</a>
                          ) : (
                            <span style={{ color: colors.textMuted }}>—</span>
                          )}
                        </td>

                        {/* Actions */}
                        <td style={{ padding: "8px 12px" }}>
                          <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
                            {isEditing ? (
                              <>
                                <button onClick={saveDocument} title="Save" style={{ border: "none", background: colors.success, color: "#fff", borderRadius: 6, padding: "4px 8px", cursor: "pointer", display: "inline-flex", alignItems: "center" }}><Check size={14} /></button>
                                <button onClick={cancelDocument} title="Cancel" style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.textMuted, borderRadius: 6, padding: "4px 8px", cursor: "pointer", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
                              </>
                            ) : (
                              <>
                                {/* Session 96: view button routes by source.
                                    Uploaded doc → sign + open (private bucket).
                                    URL doc → open directly. */}
                                {d.storage_path
                                  ? iconBtn(() => openPrivate(d.storage_path, d.label || d.type), <Eye size={13} />, colors.textMuted, "View document")
                                  : (d.url || d.file_url) && iconBtn(() => setBrowserLink({ url: d.url || d.file_url, title: d.label || d.type }), <Eye size={13} />, colors.textMuted, "View in browser")
                                }
                                {d.url && iconBtn(() => copyLink(d.url), <Copy size={13} />, colors.textMuted, "Copy link")}
                                {iconBtn(() => { setDEditId(d.id); setDEditForm({ ...d }); }, <Pencil size={13} />, colors.textMuted, "Edit")}
                                {iconBtn(() => deleteDocument(d.id), <Trash2 size={13} />, colors.danger, "Delete", { border: "1px solid " + colors.danger + "60" })}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredDocuments.length === 0 && documents.length > 0 && (
                <div style={{ padding: "32px 20px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>No documents match the current filters</div>
              )}
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
function FolderRow({ icon: Icon, label, count, selected, greyed, aliased, onClick, onContextMenu, renaming, renameDraft, setRenameDraft, onCommitRename, onCancelRename, colors }) {
  const [hover, setHover] = useState(false);
  if (renaming) {
    return (
      <div style={{ padding: "2px 4px" }}>
        <input autoFocus value={renameDraft} onChange={e => setRenameDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") onCommitRename(); if (e.key === "Escape") onCancelRename(); }}
          onBlur={onCommitRename}
          style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.accent, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
      </div>
    );
  }
  const bg = selected ? colors.sidebarHover : (hover ? colors.blueLight : "transparent");
  const fg = selected ? colors.white : (greyed ? colors.textMuted : colors.text);
  return (
    <div onClick={onClick} onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      title={aliased ? "Renamed folder (label only)" : undefined}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 7, cursor: "pointer", background: bg, opacity: greyed ? 0.55 : 1, userSelect: "none" }}>
      <Icon size={15} style={{ flexShrink: 0, color: selected ? colors.white : colors.textMuted }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: selected ? 600 : 500, color: fg, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {typeof count === "number" && <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, color: selected ? colors.white : colors.textMuted, opacity: selected ? 0.85 : 1 }}>{count}</span>}
    </div>
  );
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
