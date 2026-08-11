// ============================================================
// ConcertAttachmentsPanel.js — attachments for one concert piece
//
// Purpose-built rather than a reuse of AttachmentsPanel. That
// component is clean on the subject axis, but it gates delete on
// `att.authorId === authorId` and edit on library ownership
// (AttachmentsPanel.js:109 / :117), and its add-modal offers a
// publish-to-library opt-in. Concerts have flat permissions
// (§4.4) and deliberately never publish to the library, so reuse
// would mean forging a matching authorId on every row purely to
// defeat the permission check — which would also destroy the
// "added by" display, since that reads the same field.
//
// Visual language matches AttachmentsPanel: a leading type icon,
// the label as the clickable element, a `library` pill on
// reference rows, and small muted trailing icon buttons.
//
// created_by is DISPLAY ONLY. Nothing here reads it to decide
// what a user may do — removal is available to everyone.
// ============================================================

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { X, Link2, Upload, Library, Pencil, Check } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { supabase } from "../supabaseClient";
import { loadResources, fetchResourceTaxonomies } from "../utils/resourcesDB";
import { iconForResourceType, iconForFileName } from "../utils/resourceTypeIcons";
import { LibraryPicker } from "./LibraryPicker";
import {
  uploadFileAttachment, addLinkAttachment, addLibraryReference,
  renameAttachment, deleteAttachment, resolveAttachmentTarget,
} from "../utils/concertsDB";

const MAX_BYTES = 10 * 1024 * 1024;

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

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return url || ""; }
}

export function ConcertAttachmentsPanel({
  item, attachments, teachersById, onChange, onOpenLink, onClose, notify, schoolId,
}) {
  const { colors } = useTheme();

  const [resourcesById, setResourcesById] = useState(() => new Map());
  const [resourcesLoaded, setResourcesLoaded] = useState(false);
  const [createdBy, setCreatedBy] = useState(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [linkMode, setLinkMode] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renaming, setRenaming] = useState(null);   // attachment being renamed
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(null);

  // ── Staged file upload + opt-in library publish ──────────────
  // A picked file is held here rather than uploaded straight away, so the
  // publish choice and its metadata can be made BEFORE the single upload.
  const [pendingFile, setPendingFile] = useState(null);
  const [publish, setPublish] = useState(false);          // opt-IN, per Student Notes
  const [pubLabel, setPubLabel] = useState("");
  const [pubCategory, setPubCategory] = useState("");
  const [pubInstrument, setPubInstrument] = useState("");
  const [pubSkill, setPubSkill] = useState("");
  const [tax, setTax] = useState({ resourceTypes: [], skillLevels: [], instruments: [] });

  useEffect(() => {
    fetchResourceTaxonomies().then(setTax).catch(() => { /* dropdowns degrade to free of options */ });
  }, []);

  const resetStagedFile = () => {
    setPendingFile(null); setPublish(false);
    setPubLabel(""); setPubCategory(""); setPubInstrument(""); setPubSkill("");
  };

  const list = useMemo(() => attachments || [], [attachments]);

  // Library rows are resolved for their icon and their open target.
  // Loaded here rather than threaded down from App.js so the panel
  // stays self-contained (LibraryPicker does the same on mount).
  useEffect(() => {
    let cancelled = false;
    loadResources()
      .then(rows => {
        if (cancelled) return;
        setResourcesById(new Map((rows || []).map(r => [r.id, r])));
        setResourcesLoaded(true);
      })
      .catch(err => {
        if (cancelled) return;
        console.warn("[concert-attachments] library load failed:", err?.message || err);
        setResourcesLoaded(true);   // references degrade to their stored label
      });
    return () => { cancelled = true; };
  }, []);

  // Who is adding this. Fails soft to null — created_by is nullable,
  // has no FK, and is display-only, so an admin with no teacher record
  // is a perfectly valid case, not an error.
  useEffect(() => {
    let cancelled = false;
    supabase.rpc("my_teacher_id")
      .then(({ data }) => { if (!cancelled) setCreatedBy(data || null); })
      .catch(() => { /* display-only; null is fine */ });
    return () => { cancelled = true; };
  }, []);

  const labelFor = useCallback((att) => {
    if (att.displayLabel) return att.displayLabel;
    if (att.isReference) return resourcesById.get(att.resourceId)?.label || "Library item";
    if (att.isFile) return att.fileName || "File";
    return att.pageTitle || safeHostname(att.url) || att.url || "Link";
  }, [resourcesById]);

  const addedByFor = useCallback((att) => {
    if (!att.createdBy) return "";
    return teachersById?.get?.(att.createdBy)?.name || "";
  }, [teachersById]);

  const push = (next) => onChange(item.id, next);

  // ── Open ────────────────────────────────────────────────────
  // Target resolution lives in concertsDB (resolveAttachmentTarget) so the
  // paperclip hover list on the piece rows opens attachments by exactly the
  // same rules. The already-loaded resources Map is handed in, so a reference
  // still costs no extra query here.
  const openAttachment = async (att) => {
    try {
      const target = await resolveAttachmentTarget(att, {
        resource: att.isReference ? resourcesById.get(att.resourceId) : null,
      });
      if (!target) {
        notify && notify(
          att.isReference ? "That library item is no longer available" : "Couldn't open that file",
          att.isReference ? "warning" : "danger"
        );
        return;
      }
      onOpenLink({ url: target, title: labelFor(att) });
    } catch (err) {
      console.error("[concert-attachments] open failed:", err);
      notify && notify("Couldn't open that attachment", "danger");
    }
  };

  // ── Add: file ───────────────────────────────────────────────
  // Picking only STAGES the file. The upload happens on confirm, once the
  // publish choice is known, so a published file is uploaded exactly once
  // and both the attachment and the library row point at that one object.
  const onPickFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";              // allow re-picking the same file
    if (!file) return;
    if (file.size > MAX_BYTES) { setError("File too large — 10 MB max"); return; }
    setError("");
    setPendingFile(file);
    setPubLabel(file.name);           // sensible default; editable before attaching
  };

  const confirmUpload = async () => {
    if (!pendingFile) return;
    setBusy(true); setError("");
    try {
      const { published, ...att } = await uploadFileAttachment(item.id, pendingFile, {
        createdBy,
        // Omitted entirely when unticked — no library row is written at all.
        publish: publish ? {
          label:      pubLabel,
          category:   pubCategory,
          instrument: pubInstrument,
          skillLevel: pubSkill,
          // Inferred from the concert's school rather than asked for.
          schoolId:   schoolId || "",
        } : null,
      });
      push([...list, att]);
      resetStagedFile();
      // Publishing is best-effort by design: the attachment is kept either
      // way, so say plainly when the library half didn't land.
      if (publish && !published) notify && notify("File attached, but adding it to the library failed", "warning");
      else notify && notify(published ? "File attached and added to the library" : "File attached");
    } catch (err) {
      console.error("[concert-attachments] upload failed:", err);
      setError(err?.message || "Upload failed — try again");
    } finally {
      setBusy(false);
    }
  };

  // ── Add: link ───────────────────────────────────────────────
  const submitLink = async () => {
    const url = urlDraft.trim();
    if (!url) return;
    setBusy(true); setError("");
    try {
      const att = await addLinkAttachment(item.id, url, {
        displayLabel: labelDraft, createdBy,
      });
      push([...list, att]);
      setUrlDraft(""); setLabelDraft(""); setLinkMode(false);
      notify && notify("Link attached");
    } catch (err) {
      console.error("[concert-attachments] link failed:", err);
      setError(err?.message || "Couldn't attach that link");
    } finally {
      setBusy(false);
    }
  };

  // ── Add: from the library ───────────────────────────────────
  const attachFromLibrary = async (resource) => {
    setPickerOpen(false);
    if (!resource?.id) return;
    setBusy(true); setError("");
    try {
      const att = await addLibraryReference(item.id, resource.id, {
        displayLabel: resource.label || "",
        createdBy,
        // Describes what the referenced resource IS, for the icon —
        // the row itself owns no payload either way.
        kind: resource.file_url ? "file" : "link",
      });
      // Keep the just-attached resource resolvable even if it landed in
      // the library after this panel loaded its snapshot.
      setResourcesById(prev => {
        if (prev.has(resource.id)) return prev;
        const next = new Map(prev);
        next.set(resource.id, resource);
        return next;
      });
      push([...list, att]);
      notify && notify("Attached from library");
    } catch (err) {
      console.error("[concert-attachments] library attach failed:", err);
      setError(err?.message || "Couldn't attach that item");
    } finally {
      setBusy(false);
    }
  };

  // ── Rename ──────────────────────────────────────────────────
  const startRename = (att) => { setRenaming(att); setRenameDraft(labelFor(att)); };
  const commitRename = async () => {
    if (!renaming) return;
    const target = renaming;
    setRenaming(null);
    try {
      const updated = await renameAttachment(target.id, renameDraft);
      push(list.map(a => a.id === updated.id ? updated : a));
    } catch (err) {
      console.error("[concert-attachments] rename failed:", err);
      notify && notify("Couldn't rename that attachment", "danger");
    }
  };

  // ── Remove — available to everyone (§4.4) ───────────────────
  const removeAttachment = async (att) => {
    setConfirmRemove(null);
    try {
      await deleteAttachment(att.id);
      push(list.filter(a => a.id !== att.id));
      notify && notify("Attachment removed");
    } catch (err) {
      console.error("[concert-attachments] delete failed:", err);
      notify && notify("Couldn't remove that attachment", "danger");
    }
  };

  // ── Row ─────────────────────────────────────────────────────
  const renderRow = (att) => {
    const resource = att.isReference ? resourcesById.get(att.resourceId) : null;
    const isDeadReference = att.isReference && resourcesLoaded && !resource;
    const label = labelFor(att);
    const addedBy = addedByFor(att);

    const RowIcon = att.isReference
      ? (iconForResourceType(resource?.category) || iconForFileName({ fileName: resource?.file_name, url: resource?.file_url || resource?.url }))
      : iconForFileName({ fileName: att.fileName, url: att.url });

    const meta = [
      att.isFile ? fmtBytes(att.fileSizeBytes) : "",
      att.isLink ? safeHostname(att.url) : "",
      addedBy ? `added by ${addedBy}` : "",
      fmtDate(att.createdAt),
    ].filter(Boolean).join(" · ");

    if (renaming && renaming.id === att.id) {
      return (
        <div key={att.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px" }}>
          <input value={renameDraft} autoFocus
            onChange={e => setRenameDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(null); }}
            style={{ flex: 1, padding: "5px 9px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text, outline: "none" }} />
          <button onClick={commitRename} title="Save name"
            style={{ background: "none", border: "none", padding: 2, cursor: "pointer", color: colors.success, display: "flex" }}><Check size={14} /></button>
          <button onClick={() => setRenaming(null)} title="Cancel"
            style={{ background: "none", border: "none", padding: 2, cursor: "pointer", color: colors.textMuted, display: "flex" }}><X size={14} /></button>
        </div>
      );
    }

    return (
      <div key={att.id}
        title={isDeadReference ? "This library item is no longer available" : undefined}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, opacity: isDeadReference ? 0.5 : 1 }}>
        <span style={{ flexShrink: 0, display: "flex", color: colors.textMuted }}>
          <RowIcon size={15} />
        </span>

        <button onClick={() => openAttachment(att)} disabled={isDeadReference}
          title={isDeadReference ? "This library item is no longer available" : label}
          style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: 0, cursor: isDeadReference ? "default" : "pointer", fontFamily: "inherit", color: colors.text, overflow: "hidden" }}>
          <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
          {meta && <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 1 }}>{meta}</div>}
        </button>

        {att.isReference && !isDeadReference && (
          <span title="From the resource library"
            style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, color: colors.textMuted, border: `1px solid ${colors.border}`, borderRadius: 10, padding: "1px 6px", display: "inline-flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}>
            <Library size={10} /> library
          </span>
        )}

        <button onClick={() => startRename(att)} title="Rename"
          style={{ background: "none", border: "none", padding: 2, cursor: "pointer", color: colors.textMuted, display: "flex", flexShrink: 0 }}><Pencil size={13} /></button>
        <button onClick={() => setConfirmRemove(att)} title="Remove attachment"
          style={{ background: "none", border: "none", padding: 2, cursor: "pointer", color: colors.textMuted, display: "flex", flexShrink: 0 }}><X size={14} /></button>
      </div>
    );
  };

  const addBtn = {
    padding: "6px 11px", border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.bg, cursor: busy ? "not-allowed" : "pointer", color: colors.text,
    display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12,
    fontFamily: "inherit", opacity: busy ? 0.6 : 1,
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}>
      <div style={{ background: colors.cardBg, borderRadius: 14, padding: 24, maxWidth: 560, width: "92%", maxHeight: "80vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
        onClick={e => e.stopPropagation()}>

        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: colors.text }}>
            Attachments{list.length > 0 ? ` (${list.length})` : ""}
          </div>
          <button onClick={onClose} title="Close"
            style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "flex", padding: 2 }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 14 }}>
          {item.title || "Untitled piece"} · attachments never appear on the printed program
        </div>

        {list.length === 0 && (
          <div style={{ fontSize: 12.5, color: colors.textMuted, fontStyle: "italic", padding: "4px 8px 12px" }}>
            Nothing attached yet.
          </div>
        )}
        {list.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 14 }}>
            {list.map(renderRow)}
          </div>
        )}

        {error && (
          <div style={{ fontSize: 12, color: colors.danger, fontWeight: 600, marginBottom: 10 }}>{error}</div>
        )}

        {pendingFile ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 0 4px", borderTop: `1px solid ${colors.borderLight}` }}>
            <div style={{ fontSize: 12.5, color: colors.text }}>
              <strong>{pendingFile.name}</strong>
              <span style={{ color: colors.textMuted }}> · {fmtBytes(pendingFile.size)}</span>
            </div>

            {/* Opt-IN, unticked by default — matches Student Notes. */}
            <label style={{ display: "inline-flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, color: colors.text, cursor: "pointer" }}>
              <input type="checkbox" checked={publish} onChange={e => setPublish(e.target.checked)}
                style={{ marginTop: 2, cursor: "pointer" }} />
              <span>
                Add this to the Resource Library
                <span style={{ display: "block", fontSize: 11, color: colors.textMuted, marginTop: 1 }}>
                  One file, two places — the library item and this attachment share it.
                </span>
              </span>
            </label>

            {publish && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 24 }}>
                <input value={pubLabel} placeholder="Name in the library"
                  onChange={e => setPubLabel(e.target.value)}
                  style={{ padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text, outline: "none" }} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <select value={pubCategory} onChange={e => setPubCategory(e.target.value)}
                    style={{ padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
                    <option value="">Type…</option>
                    {(tax.resourceTypes || []).map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={pubInstrument} onChange={e => setPubInstrument(e.target.value)}
                    style={{ padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
                    <option value="">Instrument…</option>
                    {(tax.instruments || []).map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <select value={pubSkill} onChange={e => setPubSkill(e.target.value)}
                  style={{ padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
                  <option value="">Skill level…</option>
                  {(tax.skillLevels || []).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <div style={{ fontSize: 11, color: colors.textMuted }}>
                  Filed against this concert's school.
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={confirmUpload} disabled={busy}
                style={{ padding: "6px 14px", background: colors.sidebarActive, color: colors.cardBg, border: "none", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: busy ? 0.6 : 1 }}>
                {busy ? "Uploading…" : "Attach file"}
              </button>
              <button onClick={() => { resetStagedFile(); setError(""); }} disabled={busy}
                style={{ padding: "6px 14px", background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
                Cancel
              </button>
            </div>
          </div>
        ) : linkMode ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 0 4px", borderTop: `1px solid ${colors.borderLight}` }}>
            <input value={urlDraft} autoFocus placeholder="https://…"
              onChange={e => setUrlDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submitLink(); if (e.key === "Escape") { setLinkMode(false); setUrlDraft(""); setLabelDraft(""); } }}
              style={{ padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text, outline: "none" }} />
            <input value={labelDraft} placeholder="Name (optional)"
              onChange={e => setLabelDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submitLink(); if (e.key === "Escape") { setLinkMode(false); setUrlDraft(""); setLabelDraft(""); } }}
              style={{ padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text, outline: "none" }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={submitLink} disabled={busy || !urlDraft.trim()}
                style={{ padding: "6px 14px", background: colors.sidebarActive, color: colors.cardBg, border: "none", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: (busy || !urlDraft.trim()) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (busy || !urlDraft.trim()) ? 0.6 : 1 }}>
                Attach link
              </button>
              <button onClick={() => { setLinkMode(false); setUrlDraft(""); setLabelDraft(""); setError(""); }}
                style={{ padding: "6px 14px", background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingTop: 12, borderTop: `1px solid ${colors.borderLight}` }}>
            <label style={{ ...addBtn, ...(busy ? {} : { cursor: "pointer" }) }}>
              <Upload size={13} /> {busy ? "Working…" : "Upload file"}
              <input type="file" onChange={onPickFile} disabled={busy} style={{ display: "none" }} />
            </label>
            <button onClick={() => { setLinkMode(true); setError(""); }} disabled={busy} style={addBtn}>
              <Link2 size={13} /> Add link
            </button>
            <button onClick={() => { setPickerOpen(true); setError(""); }} disabled={busy} style={addBtn}>
              <Library size={13} /> From library
            </button>
          </div>
        )}

        {/* LibraryPicker paints its own overlay at zIndex 9990, BELOW this
            panel's 9999 — so it needs a wrapper that raises the stacking
            context, or it opens invisibly behind the panel. Wrapping is
            the fix rather than editing LibraryPicker, which is shared. */}
        {pickerOpen && (
          <div style={{ position: "fixed", inset: 0, zIndex: 10000 }}>
            <LibraryPicker
              title="Attach from library"
              onSelect={attachFromLibrary}
              onClose={() => setPickerOpen(false)}
            />
          </div>
        )}

        {confirmRemove && (
          <div style={{ position: "fixed", inset: 0, zIndex: 10001, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setConfirmRemove(null)}>
            <div style={{ background: colors.cardBg, borderRadius: 14, padding: 28, maxWidth: 440, width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontWeight: 700, fontSize: 15, color: colors.danger, marginBottom: 10 }}>Remove this attachment?</div>
              <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.65, marginBottom: 20 }}>
                <strong>{labelFor(confirmRemove)}</strong> will be removed from this piece.
                {confirmRemove.isReference
                  ? " The library item itself is kept."
                  : confirmRemove.isFile
                    ? " The uploaded file is deleted and cannot be recovered."
                    : ""}
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button onClick={() => setConfirmRemove(null)}
                  style={{ padding: "8px 16px", border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.bg, color: colors.text, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                <button onClick={() => removeAttachment(confirmRemove)}
                  style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: colors.danger, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Remove</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
