// ============================================================
// DOCUMENTS & RESOURCES MANAGER
// Resources: books, sheet music, websites, equipment links.
// Documents: insurance, WWCC, licensing agreements, policies.
// ============================================================

import React, { useState, useEffect, useMemo } from "react";
import { Library, FileText, Link, Plus, X, Check, Pencil, Trash2, Copy, AlertTriangle, Clock, Building2, Guitar, Eye, Upload, Download as DownloadIcon, Loader, ChevronDown, Sparkles } from "lucide-react";
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
import { insertResource as insertResourceRow, updateResource as updateResourceRow, deleteResource as deleteResourceRow, fetchResourceTaxonomies, loadSubjectNameMaps, resolveSubjectName } from "../utils/resourcesDB";

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

  // Six multi-select filters; empty array = no constraint. Combine with AND.
  const [rfInstrument, setRfInstrument] = useState([]);
  const [rfType,       setRfType]       = useState([]);
  const [rfSkill,      setRfSkill]      = useState([]);
  const [rfSchool,     setRfSchool]     = useState([]);
  const [rfUploadedBy, setRfUploadedBy] = useState([]);
  const [rfSource,     setRfSource]     = useState([]);

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
    // If this row has an uploaded file, delete the storage object too
    // (path parsed from the public file_url). Non-blocking.
    if (r?.file_url) {
      const path = storagePathFromResourceUrl(r.file_url);
      if (path) deleteFromBucket(BUCKET_RESOURCES, path);
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
  const clearResourceFilters = () => { setRfInstrument([]); setRfType([]); setRfSkill([]); setRfSchool([]); setRfUploadedBy([]); setRfSource([]); };

  // ── Filter (all combine with AND; empty filter = no constraint) ─
  const filteredResources = useMemo(() => resources.filter(r => {
    if (rfInstrument.length && !rfInstrument.includes(r.instrument))     return false;
    if (rfType.length       && !rfType.includes(r.category))             return false;
    if (rfSkill.length      && !rfSkill.includes(r.skill_level))         return false;
    if (rfSchool.length     && !rfSchool.includes(r.school_id))          return false;
    if (rfUploadedBy.length && !rfUploadedBy.includes(r.added_by_name))  return false;
    if (rfSource.length     && !rfSource.includes(r.source || "direct")) return false;
    if (rSearch.trim()) {
      const q = rSearch.trim().toLowerCase();
      if (!(r.label||"").toLowerCase().includes(q) && !(r.description||"").toLowerCase().includes(q)) return false;
    }
    return true;
  }), [resources, rfInstrument, rfType, rfSkill, rfSchool, rfUploadedBy, rfSource, rSearch]);

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
  const inputStyle = { width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" };
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
          <Card style={{ marginBottom: 16, padding: 14 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 160, position: "relative" }}>
                <input value={rSearch} onChange={e => setRSearch(e.target.value)} placeholder="Search resources…"
                  style={{ width: "100%", padding: "8px 32px 8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                {rSearch && <button onClick={() => setRSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>}
              </div>
            </div>
            {/* Filter bar — six multi-selects, AND-combined */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
              <FilterDropdown label="Instrument"  options={instrumentOptions} selected={rfInstrument} onChange={setRfInstrument} colors={colors} />
              <FilterDropdown label="Type"        options={typeOptions}       selected={rfType}       onChange={setRfType}       colors={colors} />
              <FilterDropdown label="Skill level" options={skillOptions}      selected={rfSkill}      onChange={setRfSkill}      colors={colors} />
              <FilterDropdown label="School"      options={schoolOptions}     selected={rfSchool}     onChange={setRfSchool}     colors={colors} />
              <FilterDropdown label="Uploaded by" options={uploadedByOptions} selected={rfUploadedBy} onChange={setRfUploadedBy} colors={colors} />
              <FilterDropdown label="Source"      options={SOURCE_OPTIONS}    selected={rfSource}     onChange={setRfSource}     colors={colors} />
              {anyResourceFilter && (
                <button onClick={clearResourceFilters} style={{ padding: "7px 12px", border: "1px solid " + colors.border, borderRadius: 8, background: colors.cardBg, color: colors.textMuted, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <X size={12} /> Clear filters
                </button>
              )}
            </div>
          </Card>

          {resources.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px", gap: 12 }}>
              <Library size={40} style={{ color: colors.textMuted, opacity: 0.5 }} />
              <div style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>No resources yet</div>
              <div style={{ fontSize: 13, color: colors.textMuted, textAlign: "center", maxWidth: 380 }}>Save links to recommended books, equipment, websites and other resources for easy access when drafting emails.</div>
              <Btn onClick={addResource} style={{ marginTop: 4 }}>+ Add Resource</Btn>
            </div>
          ) : (
            <div style={{ background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 12, overflow: "hidden", overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Instrument</th>
                    <th style={thStyle}>Skill</th>
                    <th style={thStyle}>Uploaded by</th>
                    <th style={thStyle}>Date</th>
                    <th style={thStyle}>Source</th>
                    <th style={thStyle}>Link</th>
                    <th style={{ ...thStyle, width: 120 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResources.map(r => (
                    <tr key={r.id}
                      style={{ background: rHovered === r.id ? colors.blueLight : colors.cardBg, borderBottom: "1px solid " + colors.borderLight }}
                      onMouseEnter={() => setRHovered(r.id)} onMouseLeave={() => setRHovered(null)}>
                      {/* Name (+ origin line for student_note) */}
                      <td style={{ padding: "8px 12px", fontWeight: 600 }}>
                        {r.label || <span style={{ color: colors.textMuted, fontStyle: "italic" }}>—</span>}
                        {r.source === "student_note" && (() => {
                          const subjName = resolveSubjectName(r.source_subject_type, r.source_subject_id, subjectMaps);
                          return subjName ? <div style={{ fontSize: 11, fontWeight: 400, color: colors.textMuted, marginTop: 2 }}>from {subjName}'s notes</div> : null;
                        })()}
                      </td>
                      {/* Type */}
                      <td style={{ padding: "8px 12px" }}>
                        {r.category
                          ? <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: colors.accentLight, color: colors.accentDark }}>{r.category}</span>
                          : <span style={{ color: colors.textMuted }}>—</span>}
                      </td>
                      {/* Instrument */}
                      <td style={{ padding: "8px 12px", color: colors.textLight, fontSize: 12 }}>{r.instrument || <span style={{ color: colors.textMuted }}>—</span>}</td>
                      {/* Skill */}
                      <td style={{ padding: "8px 12px", color: colors.textLight, fontSize: 12 }}>{r.skill_level || <span style={{ color: colors.textMuted }}>—</span>}</td>
                      {/* Uploaded by */}
                      <td style={{ padding: "8px 12px", color: colors.textMuted, fontSize: 12 }}>{r.added_by_name || <span style={{ color: colors.textMuted }}>—</span>}</td>
                      {/* Date */}
                      <td style={{ padding: "8px 12px", color: colors.textMuted, fontSize: 12, whiteSpace: "nowrap" }}>{r.created_at ? new Date(r.created_at).toLocaleDateString("en-AU") : "—"}</td>
                      {/* Source */}
                      <td style={{ padding: "8px 12px" }}>
                        {r.source === "student_note" ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: colors.blueLight, color: colors.sidebarHover, border: "1px solid " + colors.sidebarHover + "30", whiteSpace: "nowrap" }}>
                            <Sparkles size={11} /> From Student Notes
                          </span>
                        ) : (
                          <span title="Direct upload" style={{ display: "inline-flex", color: colors.textMuted }}><Upload size={13} /></span>
                        )}
                      </td>
                      {/* Link / File */}
                      <td style={{ padding: "8px 12px", maxWidth: 220 }}>
                        {r.file_url && r.file_name ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: colors.textLight, fontSize: 12 }}>
                            <FileText size={11} style={{ color: colors.accent }} />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }} title={r.file_name}>{r.file_name}</span>
                          </span>
                        ) : r.url ? (
                          <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ color: colors.accent, textDecoration: "none", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", maxWidth: 200 }}>{r.url.replace(/^https?:\/\//, "")}</a>
                        ) : (
                          <span style={{ color: colors.textMuted }}>—</span>
                        )}
                      </td>
                      {/* Actions */}
                      <td style={{ padding: "8px 12px" }}>
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
                          {(r.url || r.file_url) && iconBtn(() => setBrowserLink({ url: r.url || r.file_url, title: r.label || r.category }), <Eye size={13} />, colors.textMuted, "View in browser")}
                          {(r.url || r.file_url) && iconBtn(() => copyLink(r.url || r.file_url), <Copy size={13} />, colors.textMuted, "Copy link")}
                          {iconBtn(() => openEditResource(r), <Pencil size={13} />, colors.textMuted, "Edit details")}
                          {iconBtn(() => deleteResource(r.id), <Trash2 size={13} />, colors.danger, "Delete", { border: "1px solid " + colors.danger + "60" })}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredResources.length === 0 && resources.length > 0 && (
                <div style={{ padding: "32px 20px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>No resources match the current filters</div>
              )}
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
          padding: "7px 10px", border: "1px solid " + (active ? colors.sidebarHover : colors.inputBorder),
          borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: "inherit",
          background: active ? colors.blueLight : colors.cardBg,
          color: active ? colors.sidebarHover : colors.textMuted,
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
