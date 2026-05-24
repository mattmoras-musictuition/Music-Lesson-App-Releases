// ============================================================
// AttachmentsPanel.js  —  Student Notes (cluster 5)
//
// Collapsible "Attachments (N)" dropdown beneath the subject header.
// Supports file uploads (button + drag-drop) and link attachments
// (inline URL form + dropped URLs). Each row opens in a new tab on
// click and shows a hover preview popover (image / PDF first page /
// og:image / metadata). Author-only delete (× ) with no confirm.
//
// Files resolve through short-lived signed URLs (never stored long);
// PDF first-page rendering lazy-loads pdfjs-dist so its weight stays
// out of the initial bundle.
// ============================================================

import React, { useState, useRef, useCallback, useEffect } from "react";
import { Paperclip, ChevronDown, ChevronRight, Plus, X, FileText, Image as ImageIcon, File as FileIcon, Link2, Music, Film, Pencil, Library } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { getAttachmentSignedUrl } from "../utils/studentNotesDB";
import { findResourcesByName } from "../utils/resourcesDB";
import { iconForResourceType, iconForFileName } from "../utils/resourceTypeIcons";
import { LibraryPicker } from "./LibraryPicker";
import { renderPdfFirstPage, useFileThumbnailHover, PreviewPopover } from "./filePreview";

const MAX_BYTES = 10 * 1024 * 1024;

// ── small helpers ────────────────────────────────────────────
function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return url || ""; }
}
// For a YouTube URL, the thumbnail image URL (the video's poster frame), else
// null. Used to give a library video REFERENCE the same preview a directly-
// pasted YouTube link gets — but derived from the resource's url (the resources
// table stores no og:image). Ends in .jpg so fileKind() treats it as an image
// and the shared hover-preview renders it. Covers watch?v=, youtu.be/<id>,
// /embed/<id> and /shorts/<id>; safe on empty/invalid input.
function youtubeThumbUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    let id = null;
    if (host === "youtu.be") {
      id = u.pathname.slice(1).split("/")[0];
    } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else {
        const m = u.pathname.match(/^\/(embed|shorts|v)\/([^/?#]+)/);
        if (m) id = m[2];
      }
    }
    return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
  } catch {
    return null;
  }
}
function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return ""; }
}
function attachmentLabel(att) {
  if (att.displayLabel) return att.displayLabel;
  if (att.kind === "file") return att.fileName || "File";
  return att.pageTitle || safeHostname(att.url) || att.url || "Link";
}

// ── One attachment row + its hover preview ───────────────────
function AttachmentRow({ att, authorId, teachersById, resourcesById, resourcesLoaded, onDelete, onEdit, onOpen }) {
  const { colors } = useTheme();
  const rowRef = useRef(null);
  const hoverTimer = useRef(null);
  const loadedRef = useRef(false);
  const [showPreview, setShowPreview] = useState(false);
  const [box, setBox] = useState({ top: 0, left: 0 });
  const [imgSrc, setImgSrc] = useState(null);
  const [previewErr, setPreviewErr] = useState(false);

  // rev-5 (cluster 8.2 / 8.3a). A reference-type attachment owns no payload
  // (classifyAttachment.isReference), recognised independent of resource_id —
  // so a former reference whose library item was deleted (FK cleared
  // resource_id) is still a reference. It is RESOLVED when its linked library
  // item loads from resourcesById, otherwise UNRESOLVED (resource_id null, or
  // set but not found): the library item is gone and the row renders dimmed and
  // inert with its last-known name. A published upload owns its file AND has
  // resource_id, so it is in the library (shows the pill) but is NOT a
  // reference — it renders exactly like any uploaded file.
  const isReference = !!att.isReference;
  const inLibrary = !!att.inLibrary;
  const resource = isReference && att.resourceId ? (resourcesById?.get?.(att.resourceId) || null) : null;
  const isResolvedReference = isReference && !!resource;
  // The dead treatment applies only AFTER the library has loaded — until then a
  // reference simply hasn't resolved yet and renders normally (8.3a-patch).
  const isUnresolvedReference = isReference && !resource && !!resourcesLoaded;

  const isFile = att.kind === "file";
  const mime = att.mimeType || "";
  const isImage = isFile && mime.startsWith("image/");
  const isPdf = isFile && mime === "application/pdf";
  const isAudio = isFile && mime.startsWith("audio/");
  const isVideo = isFile && mime.startsWith("video/");
  const hostname = att.url ? safeHostname(att.url) : "";
  const label = isReference ? (resource?.label || att.displayLabel || "Library item") : attachmentLabel(att);
  const canDelete = att.authorId === authorId;
  const uploaderName = teachersById?.get?.(att.authorId)?.name || "—";

  // 8.4 edit affordance: a non-reference attachment I authored (uploaded file or
  // link, incl. a published upload) is editable; a pure reference is editable
  // ONLY when I own the linked library item (editing it edits the shared item).
  // An unresolved reference (deleted item) and others' items get no edit pencil.
  const ownsLinkedLibraryItem = isResolvedReference && resource?.added_by_teacher_id === authorId;
  const canEditRow = (canDelete && !isReference) || ownsLinkedLibraryItem;

  // A library reference previews its linked resource's file (public file_url),
  // not the attachment's own (null) payload. A video link resource (e.g. a
  // YouTube url) previews its derived video thumbnail — the same treatment a
  // directly-pasted video link gets. Any other link resource (url, no file_url,
  // not a video) has no thumbnail, so — like the D&R list's ResourceFilePreview
  // — it shows a name + hostname card instead. Reuses the shared thumbnail hover;
  // inert for non-references and for non-previewable resources.
  const refFileUrl = isReference ? (resource?.file_url || youtubeThumbUrl(resource?.url) || null) : null;
  let refCard = null;
  if (isReference && !resource?.file_url && resource?.url) {
    let refHost = resource.url;
    try { refHost = new URL(resource.url).hostname || resource.url; } catch {}
    refCard = (
      <div style={{ fontSize: 12, color: colors.text }}>
        <div style={{ fontWeight: 600, marginBottom: 2, wordBreak: "break-word" }}>{label}</div>
        <div style={{ color: colors.textMuted, wordBreak: "break-all" }}>{refHost}</div>
      </div>
    );
  }
  const refHover = useFileThumbnailHover({ url: refFileUrl, name: resource?.file_name, card: refCard, enabled: isResolvedReference });

  const loadPreview = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    try {
      if (isImage) setImgSrc(await getAttachmentSignedUrl(att.storagePath));
      else if (isPdf) setImgSrc(await renderPdfFirstPage(await getAttachmentSignedUrl(att.storagePath)));
      else if (!isFile && att.ogImageUrl) setImgSrc(att.ogImageUrl);
    } catch (e) {
      console.error("Attachment preview failed:", e);
      setPreviewErr(true);
    }
  }, [att, isImage, isPdf, isFile]);

  const onEnter = () => {
    hoverTimer.current = setTimeout(() => {
      const r = rowRef.current?.getBoundingClientRect();
      if (r) {
        const W = 380;
        const toRight = r.right + W + 12 < window.innerWidth;
        setBox(toRight
          ? { top: r.top, left: r.right + 8 }
          : { top: r.bottom + 6, left: Math.max(8, r.right - W) });
      }
      setShowPreview(true);
      loadPreview();
    }, 200);
  };
  const onLeave = () => { clearTimeout(hoverTimer.current); setShowPreview(false); };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const openRow = async () => {
    try {
      // An unresolved reference (deleted library item) is inert — no-op.
      if (isUnresolvedReference) return;
      if (isReference) {
        // Reference rows carry no payload — open the linked resource's
        // url (link) or file_url (file). If the resource is gone, no-op.
        const target = resource?.url || resource?.file_url || null;
        if (target) onOpen({ url: target, title: label });
        return;
      }
      const target = isFile ? await getAttachmentSignedUrl(att.storagePath) : att.url;
      onOpen({ url: target, title: label });
    } catch (e) { console.error("Open attachment failed:", e); }
  };

  const LeadingIcon = () => {
    if (isReference) {
      // A library reference shows its resource type's icon; with no/unmapped
      // type it falls back to a file-format icon derived from the resolved
      // resource (its file extension, or Link2 for a link resource).
      const Icon = iconForResourceType(resource?.category)
        || iconForFileName({ fileName: resource?.file_name, url: resource?.url || resource?.file_url });
      return <Icon size={15} style={{ color: colors.textMuted }} />;
    }
    if (!isFile) {
      return hostname
        ? <img src={`https://www.google.com/s2/favicons?domain=${hostname}&sz=32`} alt="" width={16} height={16} style={{ borderRadius: 3 }} />
        : <Link2 size={15} style={{ color: colors.textMuted }} />;
    }
    if (isImage) return <ImageIcon size={15} style={{ color: colors.textMuted }} />;
    if (isPdf) return <FileText size={15} style={{ color: colors.textMuted }} />;
    if (isAudio) return <Music size={15} style={{ color: colors.textMuted }} />;
    if (isVideo) return <Film size={15} style={{ color: colors.textMuted }} />;
    return <FileIcon size={15} style={{ color: colors.textMuted }} />;
  };

  // Scoped previews: image/PDF go through imgSrc; links and non-previewable
  // files render a small text card. PreviewPopover (shared with reference and
  // D&R previews) clamps the result inside the viewport.
  const previewCard = (!isImage && !isPdf) ? (
    <div style={{ fontSize: 12, color: colors.text }}>
      {!isFile ? (
        <>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{label}</div>
          <div style={{ color: colors.textMuted }}>{hostname}</div>
        </>
      ) : (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4, wordBreak: "break-word" }}>{label}</div>
          <div style={{ color: colors.textMuted }}>
            {[fmtBytes(att.fileSizeBytes), uploaderName, fmtDate(att.createdAt)].filter(Boolean).join(" · ")}
          </div>
        </>
      )}
    </div>
  ) : null;

  return (
    <div
      ref={isReference ? refHover.ref : rowRef}
      onMouseEnter={isReference ? refHover.onMouseEnter : onEnter}
      onMouseLeave={isReference ? refHover.onMouseLeave : onLeave}
      // An unresolved reference (its library item was deleted) reads as a dead
      // row: dimmed, a row-level tooltip, inert click, and no library pill.
      title={isUnresolvedReference ? "This library item is no longer available" : undefined}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, opacity: isUnresolvedReference ? 0.5 : 1 }}
    >
      <span style={{ flexShrink: 0, display: "flex" }}><LeadingIcon /></span>
      <button
        onClick={openRow}
        disabled={isUnresolvedReference}
        title={isUnresolvedReference ? "This library item is no longer available" : (isFile ? label : (att.url || ""))}
        style={{
          flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none",
          padding: 0, cursor: isUnresolvedReference ? "default" : "pointer", fontFamily: "inherit", fontSize: 13,
          color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}
      >
        {label}
      </button>
      {inLibrary && !isUnresolvedReference && (
        <span
          title="From the resource library"
          style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, color: colors.textMuted, border: `1px solid ${colors.border}`, borderRadius: 10, padding: "1px 6px", display: "inline-flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}
        >
          <Library size={10} /> library
        </span>
      )}
      {canEditRow && (
        <button
          onClick={() => onEdit(att)}
          title="Edit"
          style={{ background: "none", border: "none", padding: 2, cursor: "pointer", color: colors.textMuted, display: "flex", flexShrink: 0 }}
        >
          <Pencil size={13} />
        </button>
      )}
      {canDelete && (
        <button
          onClick={() => onDelete(att)}
          title="Delete attachment"
          style={{ background: "none", border: "none", padding: 2, cursor: "pointer", color: colors.textMuted, display: "flex", flexShrink: 0 }}
        >
          <X size={14} />
        </button>
      )}

      {/* Reference attachments preview their linked resource's file via the
          shared thumbnail hover; scoped files/links use the inline popover. */}
      {isReference && refHover.popover}

      {!isReference && showPreview && (
        <PreviewPopover box={box} imgSrc={imgSrc} err={previewErr} width={380}>
          {previewCard}
        </PreviewPopover>
      )}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────
export function AttachmentsPanel({
  subjectType, subjectId, authorId,
  attachments, teachersById, resourcesById, resourcesLoaded, resourceTypes,
  onRefreshResources, onAddFile, onAddLink, onDelete, onSaveEdit, onOpen, onAttachFromLibrary, onPublishFile,
}) {
  const { colors, darkMode } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null); // attachment being renamed, or null

  const list = attachments || [];
  const count = list.length;

  // Already-loaded library, as an array, for the dedup check in the modal.
  const resourcesList = Array.from(resourcesById?.values?.() || []);

  // Drag-drop adds a scoped attachment (no publish — that's a modal opt-in).
  const addFiles = useCallback(async (fileList) => {
    setError("");
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_BYTES) { setError("File too large — 10 MB max"); continue; }
      try { await onAddFile(file); }
      catch (e) { console.error("Add file failed:", e); setError("Upload failed — try again"); }
    }
  }, [onAddFile]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    if (dt.files && dt.files.length > 0) { addFiles(dt.files); return; }
    const uri = dt.getData("text/uri-list") || dt.getData("text/plain");
    if (uri && /^https?:\/\//i.test(uri.trim())) onAddLink(uri.trim());
  }, [addFiles, onAddLink]);

  const accent = colors.accent || "#4F8EF7";

  // Refresh the library snapshot whenever the modal opens, so the duplicate-file
  // check sees current data (a resource deleted elsewhere won't match).
  const openAdd = () => { onRefreshResources?.(); setEditTarget(null); setModalOpen(true); };
  const openEdit = (att) => { onRefreshResources?.(); setEditTarget(att); setModalOpen(true); };
  const closeModal = () => { setModalOpen(false); setEditTarget(null); };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
      onDrop={onDrop}
      style={{
        margin: "0 0 14px",
        border: `1px ${dragOver ? "dashed" : "solid"} ${dragOver ? accent : colors.border}`,
        borderRadius: 10,
        background: dragOver ? accent + "10" : "transparent",
      }}
    >
      <button
        onClick={() => setExpanded(v => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "10px 12px", background: "none", border: "none", cursor: "pointer",
          fontFamily: "inherit", color: colors.text, fontWeight: 600, fontSize: 13,
        }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Paperclip size={14} style={{ color: colors.textMuted }} />
        <span>Attachments{count > 0 ? ` (${count})` : ""}</span>
      </button>

      {expanded && (
        <div style={{ padding: "0 12px 12px" }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
            <button onClick={openAdd} style={actionBtn(colors)}>
              <Plus size={13} /> Add attachment
            </button>
          </div>

          {error && (
            <div style={{ fontSize: 12, color: colors.danger || "#EF4444", marginBottom: 8 }}>{error}</div>
          )}

          {count === 0 ? (
            <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>
              No attachments yet — add one, or drop a file or link here.
            </div>
          ) : (
            list.map(att => (
              <AttachmentRow
                key={att.id}
                att={att}
                authorId={authorId}
                teachersById={teachersById}
                resourcesById={resourcesById}
                resourcesLoaded={resourcesLoaded}
                onDelete={onDelete}
                onEdit={openEdit}
                onOpen={onOpen}
              />
            ))
          )}
        </div>
      )}

      {modalOpen && (
        <AddAttachmentModal
          colors={colors}
          darkMode={darkMode}
          accent={accent}
          resources={resourcesList}
          resourceTypes={resourceTypes}
          editTarget={editTarget}
          onAddFile={onAddFile}
          onAddLink={onAddLink}
          onPublishFile={onPublishFile}
          onAttachFromLibrary={onAttachFromLibrary}
          onSaveEdit={onSaveEdit}
          onClose={closeModal}
        />
      )}
    </div>
  );
}

// ── Add-attachment modal ──────────────────────────────────────
// One modal with a three-mode segmented control (upload a file /
// paste a link / attach from the library). Each mode maps to an
// existing data-layer call; the rename field threads through as a
// display label. Reused as a rename-only dialog via `editTarget`.
function AddAttachmentModal({
  colors, darkMode, accent, resources, resourceTypes, editTarget,
  onAddFile, onAddLink, onPublishFile, onAttachFromLibrary, onSaveEdit, onClose,
}) {
  const isEdit = !!editTarget;
  // Edit-mode classification + the linked library row (for name/type prefill).
  const editResource = isEdit && editTarget.resourceId ? (resources.find(r => r.id === editTarget.resourceId) || null) : null;
  const editIsRef  = isEdit && !!editTarget.isReference;
  const editIsFile = isEdit && !!editTarget.isUploadedFile;
  const [mode, setMode] = useState(isEdit ? (editTarget.kind === "link" ? "link" : "file") : "file");
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState(isEdit && editTarget.kind === "link" ? (editTarget.url || "") : "");
  const [name, setName] = useState(isEdit ? (editIsRef ? (editResource?.label || editTarget.displayLabel || "") : attachmentLabel(editTarget)) : "");
  const [publish, setPublish] = useState(false);
  const [category, setCategory] = useState(editResource?.category || ""); // Type (publish + edit)
  const [inLibrary, setInLibrary] = useState(isEdit ? !!editTarget.resourceId : false); // edit toggle (files)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dup, setDup] = useState(null);            // { name, matches } when a duplicate is found
  const [pickerSearch, setPickerSearch] = useState(null); // string => open LibraryPicker pre-filtered
  const fileRef = useRef(null);
  // Show a Type dropdown when publishing on add, or for an in-library edit.
  const showTypeField = (!isEdit && mode === "file" && publish) || (isEdit && (editIsRef || (editIsFile && inLibrary)));

  const renameDisabled = mode === "library";       // a library item carries its own name
  const publishDisabled = mode !== "file";          // links/library can't be published to the library here

  const pickFile = (f) => { setFile(f || null); setName(f ? f.name : ""); setError(""); setDup(null); };

  const doPublish = async () => {
    setBusy(true); setError("");
    try { await onPublishFile(file, name, category); onClose(); }
    catch (e) { console.error("Publish failed:", e); setError("Upload failed — try again"); setBusy(false); }
  };
  const doScopedFile = async () => {
    setBusy(true); setError("");
    try { await onAddFile(file, name); onClose(); }
    catch (e) { console.error("Add file failed:", e); setError("Upload failed — try again"); setBusy(false); }
  };

  const confirm = async () => {
    setError("");
    if (isEdit) {
      const trimmed = name.trim();
      // Name is required when the item is (or is becoming) a library item — the
      // resources row's label is NOT NULL.
      const willBeInLibrary = editIsRef || (editIsFile && inLibrary);
      if (willBeInLibrary && !trimmed) { setError("Name is required."); return; }
      // Removing a file from the library deletes the shared library item, which
      // other teachers may reference — confirm before doing so.
      if (editIsFile && !!editTarget.resourceId && !inLibrary) {
        if (!window.confirm("Remove this from the resource library? It will no longer be available to other teachers; the file stays attached here.")) return;
      }
      setBusy(true);
      try { await onSaveEdit(editTarget, { name: trimmed, category, inLibrary }); onClose(); }
      catch (e) { console.error("Save edit failed:", e); setError("Couldn't save — try again"); setBusy(false); }
      return;
    }
    if (mode === "file") {
      if (!file) { setError("Choose a file first."); return; }
      if (file.size > MAX_BYTES) { setError("File too large — 10 MB max"); return; }
      if (publish) {
        const matches = findResourcesByName(resources, file.name);
        if (matches.length) { setDup({ name: file.name, matches }); return; }
        await doPublish();
        return;
      }
      await doScopedFile();
      return;
    }
    if (mode === "link") {
      const u = url.trim();
      if (!u) { setError("Enter a URL."); return; }
      setBusy(true);
      try { await onAddLink(u, name); onClose(); }
      catch (e) { console.error("Add link failed:", e); setError("Couldn't add that link"); setBusy(false); }
      return;
    }
    // library mode confirms via the picker's own selection
  };

  // Duplicate-warning choices.
  const useExisting = async () => {
    if (!dup) return;
    if (dup.matches.length === 1) {
      // Await the reference insert so a failure (e.g. the matched resource was
      // just deleted — a dangling FK) is handled here, not surfaced as an
      // uncaught rejection. On failure leave the modal open with a message.
      setBusy(true); setError("");
      const res = await (onAttachFromLibrary ? onAttachFromLibrary(dup.matches[0]) : { ok: true });
      setBusy(false);
      if (res?.ok === false) {
        setDup(null);
        setError("That library item is no longer available — it may have just been removed. Try adding it again.");
        return;
      }
      onClose();
    } else {
      // Several library items share the name — let the teacher pick which.
      setDup(null);
      setMode("library");
      setPickerSearch(dup.name);
    }
  };

  const inputStyle = {
    width: "100%", padding: "8px 12px", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
    border: `1px solid ${colors.inputBorder || colors.border}`, borderRadius: 8,
    background: colors.bg, color: colors.text, outline: "none",
  };
  const labelStyle = { display: "block", fontSize: 11, fontWeight: 700, letterSpacing: 0.3, color: colors.textMuted, marginBottom: 5 };

  const MODES = [
    { id: "file",    label: "Upload a file" },
    { id: "link",    label: "Paste a link" },
    { id: "library", label: "Attach from the library" },
  ];

  return (
    <>
    <div onMouseDown={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 9985, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onMouseDown={e => e.stopPropagation()}
        style={{ background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 12, width: 480, maxWidth: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid " + colors.border }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Paperclip size={16} /> {isEdit ? "Edit attachment" : "Add attachment"}
          </div>
          <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", color: colors.textMuted, display: "inline-flex" }}><X size={18} /></button>
        </div>

        <div style={{ padding: "16px 18px", overflowY: "auto" }}>
          {/* Mode selector (hidden when renaming an existing attachment) */}
          {!isEdit && (
            <div style={{ display: "flex", gap: 0, border: "1px solid " + colors.inputBorder, borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
              {MODES.map(m => (
                <button
                  key={m.id}
                  onClick={() => { setMode(m.id); setError(""); setDup(null); }}
                  style={{
                    flex: 1, padding: "8px 6px", border: "none", fontSize: 12, fontWeight: 600,
                    fontFamily: "inherit", cursor: "pointer",
                    background: mode === m.id ? accent : colors.cardBg,
                    color: mode === m.id ? "#fff" : colors.textMuted,
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}

          {/* Upload-a-file mode */}
          {mode === "file" && !isEdit && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>FILE</label>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  ref={fileRef}
                  type="file"
                  onChange={(e) => pickFile(e.target.files?.[0] || null)}
                  style={{ fontSize: 13, color: colors.text, fontFamily: "inherit" }}
                />
                {file && <span style={{ fontSize: 12, color: colors.textMuted }}>{fmtBytes(file.size)}</span>}
              </div>
            </div>
          )}

          {/* Paste-a-link mode */}
          {mode === "link" && !isEdit && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>URL</label>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoFocus style={inputStyle} />
            </div>
          )}

          {/* Rename field (active for file + link; greyed for library) */}
          {(mode !== "library") && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>NAME{isEdit ? "" : " (optional)"}</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={renameDisabled}
                placeholder={mode === "file" ? "Defaults to the file name" : "A name for this link"}
                autoFocus={isEdit}
                style={{ ...inputStyle, opacity: renameDisabled ? 0.5 : 1 }}
              />
            </div>
          )}

          {/* Add-to-library checkbox (active for file; greyed for link; n/a for library) */}
          {mode !== "library" && !isEdit && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: publishDisabled ? colors.textMuted : colors.text, marginBottom: 14, cursor: publishDisabled ? "default" : "pointer", opacity: publishDisabled ? 0.5 : 1 }}>
              <input type="checkbox" checked={publish && !publishDisabled} disabled={publishDisabled} onChange={(e) => setPublish(e.target.checked)} />
              Add to the Resource Library
            </label>
          )}

          {/* Add-to / remove-from-library toggle (edit mode, uploaded files only —
              links can't be published to the library). */}
          {isEdit && editIsFile && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: colors.text, marginBottom: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={inLibrary} onChange={(e) => setInLibrary(e.target.checked)} />
              In the resource library
            </label>
          )}

          {/* Type dropdown (publishing on add; or editing an in-library item —
              published upload, or owned pure reference). Options come from the
              resource_types taxonomy. */}
          {showTypeField && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>TYPE</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                style={{ ...inputStyle, cursor: "pointer" }}
              >
                <option value="">No type</option>
                {(resourceTypes || []).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}

          {mode === "library" && !isEdit && (
            <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 8 }}>
              Pick an item from the library — it keeps its own name.
            </div>
          )}

          {/* Duplicate-file warning (upload + publish) */}
          {dup && (
            <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: 12, marginBottom: 12, background: darkMode ? "#2a2417" : "#FFFBEB" }}>
              <div style={{ fontSize: 13, color: colors.text, marginBottom: 10 }}>
                A resource named “{dup.name}” is already in the library.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={useExisting} style={{ ...actionBtn(colors), background: accent, color: "#fff", border: "none" }}>
                  Use the existing one
                </button>
                <button onClick={doPublish} disabled={busy} style={actionBtn(colors)}>
                  Add anyway
                </button>
              </div>
            </div>
          )}

          {error && <div style={{ fontSize: 12, color: colors.danger || "#EF4444", marginBottom: 8 }}>{error}</div>}
        </div>

        {/* Footer */}
        {mode !== "library" && !dup && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: "1px solid " + colors.border }}>
            <button onClick={onClose} style={actionBtn(colors)}>Cancel</button>
            <button onClick={confirm} disabled={busy} style={{ ...actionBtn(colors), background: busy ? colors.textMuted : accent, color: "#fff", border: "none", cursor: busy ? "default" : "pointer" }}>
              {busy ? "Saving…" : (isEdit ? "Save" : "Add")}
            </button>
          </div>
        )}
      </div>
    </div>

      {/* Library mode reuses the existing picker verbatim. Closing it
          returns to upload mode rather than dismissing the whole dialog;
          `pickerSearch` pre-filters it when "Use the existing one" matched
          several library items. Rendered as a sibling (not nested in the
          modal overlay) so its backdrop click doesn't bubble up and close
          the whole dialog. */}
      {mode === "library" && (
        <LibraryPicker
          initialSearch={pickerSearch || ""}
          onSelect={async (resource) => {
            // Await so a failed reference insert (resource just removed) is
            // caught and shown rather than thrown uncaught.
            const res = await (onAttachFromLibrary ? onAttachFromLibrary(resource) : { ok: true });
            if (res?.ok === false) { setMode("file"); setError("That library item is no longer available — it may have just been removed."); return; }
            onClose();
          }}
          onClose={() => { setMode("file"); setPickerSearch(null); }}
        />
      )}
    </>
  );
}

function actionBtn(colors) {
  return {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "5px 10px", fontSize: 12, fontFamily: "inherit", cursor: "pointer",
    border: `1px solid ${colors.border}`, borderRadius: 6,
    background: "transparent", color: colors.text,
  };
}
