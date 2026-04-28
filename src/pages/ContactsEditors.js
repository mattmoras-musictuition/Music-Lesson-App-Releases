// ============================================================
// CONTACTSEDITORS — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Plus, Trash2, Bot, Download, X, Star, Link as LinkIcon, Paperclip, FileText, ChevronDown, ChevronRight } from "lucide-react";
import { STORAGE_KEYS, ALL_MERGE_FIELDS, EMAIL_TRIGGERS, TRIGGER_MAP } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { uid } from "../utils/helpers";
import { anthropicFetch, getAnthropicHeaders } from "../utils/api";
// Session 95: schoolAcronym + pickDefaultTemplate imported but only
// schoolAcronym is used here; ComposeModal is the other consumer.
import { getUserTemplates, saveUserTemplates, getCustomMergeFields, saveCustomMergeFields, schoolAcronym } from "../utils/emailTemplates";
import { Card, Btn, Input, Tag, PageTitle, NavButtons, PAGE_COLORS } from "../components/ui/SharedUI";
import { supabase } from "../supabaseClient";

// Session 96: resources + documents props are new (optional).
// Resources: used by the in-body Resource Picker to insert a clickable
// hyperlink (anchor tag) at the caret position in subject/body.
// Documents: used by the Auto-Attach picker to pre-select files that will
// be auto-attached every time the template is used in a send. Both degrade
// gracefully to empty if not passed in.
export function EmailTemplatesEditor({ notify, schools = [], resources = [], documents = [] }) {
  const { colors } = useTheme();
  const [templates, setTemplates] = React.useState(() => getUserTemplates());
  const [selectedTrigger, setSelectedTrigger] = React.useState("");
  // Session 95: school filter alongside trigger. "" = all, other = schoolId.
  // Setting to "generic" filters to templates with no schoolId.
  const [selectedSchool, setSelectedSchool] = React.useState("");
  // Session 96: track whether the resource picker dropdown is open.
  const [resourcePickerOpen, setResourcePickerOpen] = React.useState(false);
  // Session 97: collapse the auto-attach picker so the template editor stays
  // compact once you have a handful of documents. Default collapsed; opens
  // automatically when the editing template already has selections, so you
  // can see what's attached without an extra click.
  const [attachOpen, setAttachOpen] = React.useState(false);
  const resourcePickerRef = React.useRef(null);
  const [editing, setEditing] = React.useState(null); // null | "new" | templateId
  const [form, setForm] = React.useState(null); // { name, triggerId, schoolId, isDefault, subject, body }
  const [showAllFields, setShowAllFields] = React.useState(false);

  // ── Custom merge fields (Session 97) ─────────────────────────────────
  // Local state mirrors the localStorage store. Supabase sync via
  // app_settings key "custom_merge_fields" keeps fields shared across
  // devices — same pattern used for missed_reasons.
  const [customFields, setCustomFields] = React.useState(() => getCustomMergeFields());
  const [fieldsOpen, setFieldsOpen] = React.useState(false);
  const [editingFieldId, setEditingFieldId] = React.useState(null); // null | id | "new"
  const [fieldDraft, setFieldDraft] = React.useState(null); // { name, value }

  // Hydrate from Supabase on mount. Silent failure — local cache is always
  // usable; Supabase just keeps things in sync across sessions/devices.
  React.useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.from("app_settings").select("value").eq("key", "custom_merge_fields").single();
        if (data?.value) {
          const parsed = JSON.parse(data.value);
          if (Array.isArray(parsed)) {
            setCustomFields(parsed);
            saveCustomMergeFields(parsed);
          }
        }
      } catch {}
    })();
  }, []);

  const persistFields = async (list) => {
    setCustomFields(list);
    saveCustomMergeFields(list);
    try { await supabase.from("app_settings").upsert({ key: "custom_merge_fields", value: JSON.stringify(list) }, { onConflict: "key" }); } catch {}
  };

  // Validate a merge-field name: only word chars (letters, digits, underscore),
  // lowercased. Enforced on save so resolution always matches {{\w+}} tokens.
  const _normaliseName = (raw) => (raw || "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");

  // Built-in names set for detecting overrides (shown in the editor so Matt
  // knows when he's shadowing a built-in vs creating a new field).
  const BUILTIN_NAMES = React.useMemo(
    () => new Set(ALL_MERGE_FIELDS.map(f => f.tag.replace(/^\{\{|\}\}$/g, ""))),
    []
  );

  const startNewField = () => {
    setEditingFieldId("new");
    setFieldDraft({ name: "", value: "" });
  };
  const startEditField = (field) => {
    setEditingFieldId(field.id);
    setFieldDraft({ name: field.name || "", value: field.value || "" });
  };
  const cancelField = () => {
    setEditingFieldId(null);
    setFieldDraft(null);
  };
  const saveField = async () => {
    if (!fieldDraft) return;
    const name = _normaliseName(fieldDraft.name);
    if (!name) { notify?.("Field name can't be empty", "danger"); return; }
    // Prevent duplicate custom names (other than the row being edited)
    const clash = customFields.find(f => f.name === name && f.id !== editingFieldId);
    if (clash) { notify?.(`A field named "${name}" already exists`, "danger"); return; }
    const value = fieldDraft.value || "";
    let next;
    if (editingFieldId === "new") {
      next = [...customFields, { id: uid(), name, value }];
    } else {
      next = customFields.map(f => f.id === editingFieldId ? { ...f, name, value } : f);
    }
    await persistFields(next);
    setEditingFieldId(null);
    setFieldDraft(null);
    notify?.(BUILTIN_NAMES.has(name) ? `"${name}" override saved` : `"${name}" saved`);
  };
  const deleteField = async (id) => {
    const target = customFields.find(f => f.id === id);
    if (!target) return;
    await persistFields(customFields.filter(f => f.id !== id));
    if (editingFieldId === id) { setEditingFieldId(null); setFieldDraft(null); }
    notify?.(`"${target.name}" removed`);
  };

  const save = (tmpl) => {
    // Session 95: when a template is saved as default, clear the isDefault
    // flag on any other template with the same (triggerId, schoolId). Only
    // one default per (trigger, school) pair — generic templates and
    // school-tagged templates track their own defaults independently.
    const editingId = editing === "new" ? null : editing;
    let updated;
    if (editing === "new") {
      const newTmpl = { ...tmpl, id: uid(), createdAt: new Date().toISOString() };
      updated = [...templates, newTmpl];
    } else {
      updated = templates.map(t => t.id === editing ? { ...t, ...tmpl } : t);
    }
    if (tmpl.isDefault) {
      updated = updated.map(t => {
        if (t.id === editingId || (editing === "new" && t.createdAt === updated[updated.length - 1].createdAt)) return t;
        if (t.triggerId === tmpl.triggerId && (t.schoolId || null) === (tmpl.schoolId || null)) {
          return { ...t, isDefault: false };
        }
        return t;
      });
    }
    setTemplates(updated);
    saveUserTemplates(updated);
    setEditing(null); setForm(null);
    notify("Template saved");
  };

  // Session 95: toggle default flag from the list view. One-click promotion;
  // clears the flag from any other template sharing the same (trigger, school).
  const toggleDefault = (tmpl) => {
    const nowDefault = !tmpl.isDefault;
    const updated = templates.map(t => {
      if (t.id === tmpl.id) return { ...t, isDefault: nowDefault };
      if (nowDefault && t.triggerId === tmpl.triggerId && (t.schoolId || null) === (tmpl.schoolId || null)) {
        return { ...t, isDefault: false };
      }
      return t;
    });
    setTemplates(updated);
    saveUserTemplates(updated);
    notify(nowDefault ? "Set as default" : "Unset default");
  };

  const del = (id) => {
    const updated = templates.filter(t => t.id !== id);
    setTemplates(updated);
    saveUserTemplates(updated);
    notify("Template deleted");
  };

  const startNew = () => {
    const trigger = EMAIL_TRIGGERS.find(t => t.id === selectedTrigger);
    setForm({
      name: trigger ? trigger.label : "",
      triggerId: selectedTrigger,
      // Prefill schoolId from the school filter if one is active (convenience).
      schoolId: (selectedSchool && selectedSchool !== "generic") ? selectedSchool : "",
      isDefault: false,
      subject: "", body: "",
      // Session 96: auto-attach starts empty for new templates.
      autoAttachDocIds: [],
    });
    setEditing("new");
    setShowAllFields(false);
    setAttachOpen(false);
  };

  const startEdit = (tmpl) => {
    const attachIds = Array.isArray(tmpl.autoAttachDocIds) ? [...tmpl.autoAttachDocIds] : [];
    setForm({
      name: tmpl.name, triggerId: tmpl.triggerId,
      schoolId: tmpl.schoolId || "", isDefault: !!tmpl.isDefault,
      subject: tmpl.subject, body: tmpl.body,
      // Session 96: preserve auto-attach doc ids when editing.
      autoAttachDocIds: attachIds,
    });
    setEditing(tmpl.id);
    setSelectedTrigger(tmpl.triggerId);
    setShowAllFields(false);
    // Session 97: auto-open the Always-attach block when the template already
    // has selections — otherwise leave it collapsed so the editor stays
    // compact for templates without attachments.
    setAttachOpen(attachIds.length > 0);
  };

  // Session 96: close the resource picker when clicking outside. Kept
  // dead-simple — a document-level mousedown listener installed while the
  // dropdown is open. Also listens for Escape.
  React.useEffect(() => {
    if (!resourcePickerOpen) return;
    const onDocMouseDown = (e) => {
      if (resourcePickerRef.current && !resourcePickerRef.current.contains(e.target)) {
        setResourcePickerOpen(false);
      }
    };
    const onKeyDown = (e) => { if (e.key === "Escape") setResourcePickerOpen(false); };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [resourcePickerOpen]);

  // Session 95 BUG 4: track which text field (subject or body) was last
  // focused, so merge-tag pills insert into the right one. Before this,
  // pills only inserted into the body; to get a merge field in the subject
  // you had to type it manually. Default to body (matches prior behaviour).
  const [activeField, setActiveField] = React.useState("body"); // "body" | "subject"

  // Session 96: insert a clickable hyperlink from a Resource into the
  // focused field. Body = HTML (anchor tag); subject = plain text with the
  // URL inline after the label (emails show labels inline in subjects).
  // Resource must have a URL — file-only resources are filtered out of the
  // picker above. Links open in new tab by default.
  const insertResourceLink = (resource) => {
    if (!resource || !resource.url) return;
    const label = resource.label || resource.url;
    setForm(prev => {
      if (activeField === "subject") {
        const inp = document.getElementById("tmpl-subject-inp");
        const text = label; // subjects are plain text — label only
        if (inp) {
          const start = inp.selectionStart ?? (prev.subject || "").length;
          const end = inp.selectionEnd ?? (prev.subject || "").length;
          const newSubject = (prev.subject || "").slice(0, start) + text + (prev.subject || "").slice(end);
          setTimeout(() => { inp.selectionStart = inp.selectionEnd = start + text.length; inp.focus(); }, 0);
          return { ...prev, subject: newSubject };
        }
        return { ...prev, subject: (prev.subject || "") + text };
      }
      // Body: insert an HTML anchor. The template body is already HTML-safe
      // by convention (getCleanHtml in Dashboard uses DOMParser on it);
      // inserting <a> here works with the existing merge-ctx applier.
      const anchor = `<a href="${resource.url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      const ta = document.getElementById("tmpl-body-ta");
      if (ta) {
        const start = ta.selectionStart, end = ta.selectionEnd;
        const newBody = (prev.body || "").slice(0, start) + anchor + (prev.body || "").slice(end);
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = start + anchor.length; ta.focus(); }, 0);
        return { ...prev, body: newBody };
      }
      return { ...prev, body: (prev.body || "") + anchor };
    });
    setResourcePickerOpen(false);
  };

  // Session 96: toggle a document id in form.autoAttachDocIds. Used by the
  // multi-select checkbox list in the "Always attach" block. Docs without
  // a storage_path are still attachable by URL (existing behaviour) —
  // ComposeModal handles both at send time.
  const toggleAutoAttachDoc = (docId) => {
    setForm(prev => {
      const cur = Array.isArray(prev.autoAttachDocIds) ? prev.autoAttachDocIds : [];
      const next = cur.includes(docId) ? cur.filter(id => id !== docId) : [...cur, docId];
      return { ...prev, autoAttachDocIds: next };
    });
  };

  const insertTag = (tag) => {
    setForm(prev => {
      if (activeField === "subject") {
        const inp = document.getElementById("tmpl-subject-inp");
        if (inp) {
          const start = inp.selectionStart ?? (prev.subject || "").length;
          const end = inp.selectionEnd ?? (prev.subject || "").length;
          const newSubject = (prev.subject || "").slice(0, start) + tag + (prev.subject || "").slice(end);
          setTimeout(() => { inp.selectionStart = inp.selectionEnd = start + tag.length; inp.focus(); }, 0);
          return { ...prev, subject: newSubject };
        }
        return { ...prev, subject: (prev.subject || "") + tag };
      }
      const ta = document.getElementById("tmpl-body-ta");
      if (ta) {
        const start = ta.selectionStart, end = ta.selectionEnd;
        const newBody = prev.body.slice(0, start) + tag + prev.body.slice(end);
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = start + tag.length; ta.focus(); }, 0);
        return { ...prev, body: newBody };
      }
      return { ...prev, body: (prev.body || "") + tag };
    });
  };

  // Session 95: filter by both trigger AND school. schoolAcronym memo for
  // sort/chip rendering. Sort: isDefault first, then school acronym A→Z,
  // then createdAt (original order).
  const schoolById = useMemo(() => {
    const m = {};
    (schools || []).forEach(s => { m[s.id] = s; });
    return m;
  }, [schools]);
  const filteredTemplates = useMemo(() => {
    let list = templates;
    if (selectedTrigger) list = list.filter(t => t.triggerId === selectedTrigger);
    if (selectedSchool === "generic") list = list.filter(t => !t.schoolId);
    else if (selectedSchool) list = list.filter(t => t.schoolId === selectedSchool);
    // Sort: defaults first → school acronym A→Z (generic sorts first as empty) → creation order.
    return [...list].sort((a, b) => {
      if (!!b.isDefault !== !!a.isDefault) return b.isDefault ? 1 : -1;
      const ac = a.schoolId ? schoolAcronym(schoolById[a.schoolId]) : "";
      const bc = b.schoolId ? schoolAcronym(schoolById[b.schoolId]) : "";
      if (ac !== bc) return ac.localeCompare(bc);
      return (a.createdAt || "").localeCompare(b.createdAt || "");
    });
  }, [templates, selectedTrigger, selectedSchool, schoolById]);

  const trigger = EMAIL_TRIGGERS.find(t => t.id === (form?.triggerId || selectedTrigger));
  const relevantFields = trigger ? trigger.fields.map(f => ALL_MERGE_FIELDS.find(m => m.tag === `{{${f}}}`)).filter(Boolean) : [];
  const otherFields = ALL_MERGE_FIELDS.filter(m => !relevantFields.includes(m));
  // Session 97: custom merge fields are always insertable regardless of
  // trigger, since they're user-defined and may target any context. We
  // build pill-shaped entries matching the shape of ALL_MERGE_FIELDS
  // ({ tag, label }) so the existing pill renderer works unchanged.
  const customFieldPills = React.useMemo(
    () => customFields.map(f => ({ tag: `{{${f.name}}}`, label: f.name, _custom: true })),
    [customFields]
  );

  const pillStyle = (muted) => ({
    padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "none",
    background: muted ? colors.bg : colors.accentLight,
    color: muted ? colors.textMuted : colors.accentDark,
    transition: "background 0.1s",
  });

  return (
    <div>
      {/* Trigger + school filters */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: colors.textLight, flexShrink: 0 }}>Template for:</label>
        <select value={selectedTrigger} onChange={e => { setSelectedTrigger(e.target.value); setEditing(null); setForm(null); }}
          style={{ flex: 1, maxWidth: 400, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
          <option value="">— All templates —</option>
          {EMAIL_TRIGGERS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        {schools && schools.length > 0 && (
          <select value={selectedSchool} onChange={e => { setSelectedSchool(e.target.value); setEditing(null); setForm(null); }}
            title="Filter by school"
            style={{ maxWidth: 260, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
            <option value="">— All schools —</option>
            <option value="generic">Generic (no school)</option>
            {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <button onClick={startNew}
          style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: colors.sidebarHover, color: "#fff", fontSize: 13, fontFamily: "inherit", fontWeight: 600, cursor: "pointer", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Plus size={13} /> New Template
        </button>
      </div>

      {/* Editor */}
      {editing && form && (
        <div style={{ background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14, color: colors.sidebarHover }}>
            {editing === "new" ? "New Template" : "Edit Template"}
          </div>

          {/* Trigger selector (for new) */}
          {editing === "new" && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.4 }}>Trigger</label>
              <select value={form.triggerId} onChange={e => {
                const t = EMAIL_TRIGGERS.find(tr => tr.id === e.target.value);
                setForm(prev => ({ ...prev, triggerId: e.target.value, name: prev.name === (EMAIL_TRIGGERS.find(tr => tr.id === prev.triggerId)?.label || "") ? (t?.label || "") : prev.name }));
              }}
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">— Select a trigger —</option>
                {EMAIL_TRIGGERS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
          )}

          {/* Name */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.4 }}>Template Name</label>
            <input value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (form.triggerId && form.name) save(form); } }}
              style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
          </div>

          {/* Session 95: School selector + Default toggle on one row. */}
          {schools && schools.length > 0 && (
            <div style={{ display: "flex", gap: 18, alignItems: "flex-end", marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.4 }}>School</label>
                <select value={form.schoolId || ""} onChange={e => setForm(prev => ({ ...prev, schoolId: e.target.value }))}
                  style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">— Any school (generic) —</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}{schoolAcronym(s) ? ` (${schoolAcronym(s)})` : ""}</option>)}
                </select>
              </div>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "8px 12px", border: `1px solid ${form.isDefault ? colors.accent : colors.inputBorder}`, borderRadius: 8, background: form.isDefault ? colors.accentLight : "transparent", transition: "background 0.15s, border-color 0.15s", flexShrink: 0 }}
                title={form.schoolId ? "Make this the default template for this school + trigger" : "Make this the default template for this trigger (generic)"}
              >
                <input type="checkbox" checked={!!form.isDefault} onChange={e => setForm(prev => ({ ...prev, isDefault: e.target.checked }))}
                  style={{ margin: 0, cursor: "pointer" }} />
                <Star size={13} fill={form.isDefault ? colors.accent : "none"} color={form.isDefault ? colors.accent : colors.textMuted} />
                <span style={{ fontSize: 12, fontWeight: 600, color: form.isDefault ? colors.accentDark : colors.textLight }}>Default</span>
              </label>
            </div>
          )}

          {/* Subject */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.4 }}>Subject</label>
            <input id="tmpl-subject-inp" value={form.subject}
              onChange={e => setForm(prev => ({ ...prev, subject: e.target.value }))}
              onFocus={() => setActiveField("subject")}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (form.triggerId && form.name) save(form); } }}
              style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
          </div>

          {/* Body */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.4 }}>Body</label>
            <textarea id="tmpl-body-ta" value={form.body}
              onChange={e => setForm(prev => ({ ...prev, body: e.target.value }))}
              onFocus={() => setActiveField("body")}
              rows={10}
              style={{ width: "100%", padding: "10px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box", lineHeight: 1.6 }} />
          </div>

          {/* Merge tag pills — Session 97: moved below the body. The single
              pill row handles both subject and body insertion via activeField
              (set on focus of each input), so no need for two rows. The
              target-field indicator in the label makes it clear where the
              click will insert. */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
              Insert field <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: colors.textMuted, fontSize: 11 }}>→ {activeField === "subject" ? "subject" : "body"}</span>
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {relevantFields.map(f => (
                <button key={f.tag} onClick={() => insertTag(f.tag)} style={pillStyle(false)} title={f.tag}>{f.label}</button>
              ))}
              {/* Session 97: custom fields sit alongside the trigger-relevant
                  pills since they're user-defined and always applicable. They
                  use the same highlighted pill style but carry a subtle
                  accent-border so it's obvious they're custom. */}
              {customFieldPills.map(f => (
                <button key={f.tag} onClick={() => insertTag(f.tag)}
                  style={{ ...pillStyle(false), border: `1px solid ${colors.accent}60` }}
                  title={`Custom field: ${f.tag}`}>{f.label}</button>
              ))}
              {relevantFields.length > 0 && otherFields.length > 0 && (
                <button onClick={() => setShowAllFields(v => !v)}
                  style={{ ...pillStyle(true), border: `1px solid ${colors.border}` }}>
                  {showAllFields ? "Less ▲" : "More ▼"}
                </button>
              )}
              {(showAllFields || relevantFields.length === 0) && otherFields.map(f => (
                <button key={f.tag} onClick={() => insertTag(f.tag)} style={pillStyle(true)} title={f.tag}>{f.label}</button>
              ))}
            </div>
          </div>
          {/* Session 97: Custom merge fields panel. Collapsed by default so it
              doesn't dominate the page — expand to create/edit/delete fields
              that become available in all templates. A field named the same as
              a built-in (e.g. lesson_time) overrides the built-in at resolve
              time; values can reference other {{fields}} and will recurse. */}
          <div style={{ marginBottom: 18, border: `1px solid ${colors.border}`, borderRadius: 10, background: colors.cardBg, overflow: "hidden" }}>
            <div onClick={() => setFieldsOpen(v => !v)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", cursor: "pointer", userSelect: "none", background: fieldsOpen ? colors.bg : "transparent", transition: "background 0.12s" }}>
              {fieldsOpen
                ? <ChevronDown size={14} style={{ color: colors.textLight }} />
                : <ChevronRight size={14} style={{ color: colors.textLight }} />}
              <span style={{ fontSize: 13, fontWeight: 700, color: colors.text }}>Custom merge fields</span>
              <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 500 }}>
                {customFields.length === 0 ? "none yet" : `${customFields.length} defined`}
              </span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: colors.textMuted }}>
                Override built-ins or add your own
              </span>
            </div>
            {fieldsOpen && (
              <div style={{ padding: "12px 16px", borderTop: `1px solid ${colors.borderLight || colors.border}` }}>
                <div style={{ fontSize: 12, color: colors.textLight, marginBottom: 12, lineHeight: 1.5 }}>
                  Create fields you can insert into any template as <code style={{ background: colors.bg, padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>{"{{name}}"}</code>.
                  Values can contain other merge tags (e.g. <code style={{ background: colors.bg, padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>{"{{parent_name}}"}</code>) — they'll resolve when the email is sent.
                  Naming a field the same as a built-in overrides how it displays.
                </div>

                {customFields.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                    {customFields.map(f => {
                      const isEditing = editingFieldId === f.id;
                      const isOverride = BUILTIN_NAMES.has(f.name);
                      return (
                        <div key={f.id}
                          style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", borderRadius: 8, background: isEditing ? colors.blueLight : colors.bg, border: `1px solid ${isEditing ? colors.accent : colors.border}` }}>
                          {isEditing ? (
                            <>
                              <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                  <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Name</span>
                                  <input value={fieldDraft?.name || ""}
                                    autoFocus
                                    onChange={e => setFieldDraft(d => ({ ...d, name: e.target.value }))}
                                    onKeyDown={e => { if (e.key === "Enter") saveField(); if (e.key === "Escape") cancelField(); }}
                                    placeholder="e.g. signature"
                                    style={{ flex: 1, minWidth: 140, padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }} />
                                  {fieldDraft?.name && BUILTIN_NAMES.has(_normaliseName(fieldDraft.name)) && (
                                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: colors.accentLight, color: colors.accentDark, letterSpacing: 0.3, textTransform: "uppercase" }}>Overrides built-in</span>
                                  )}
                                </div>
                                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                                  <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, paddingTop: 6 }}>Value</span>
                                  <textarea value={fieldDraft?.value || ""}
                                    onChange={e => setFieldDraft(d => ({ ...d, value: e.target.value }))}
                                    onKeyDown={e => { if (e.key === "Escape") cancelField(); }}
                                    placeholder="The text this field should insert. May contain {{other_fields}}."
                                    rows={3}
                                    style={{ flex: 1, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text, resize: "vertical", lineHeight: 1.5, boxSizing: "border-box" }} />
                                </div>
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                                <button onClick={saveField}
                                  style={{ padding: "5px 12px", border: "none", borderRadius: 6, background: colors.sidebarHover, color: "#fff", fontSize: 12, fontFamily: "inherit", fontWeight: 600, cursor: "pointer" }}>
                                  Save
                                </button>
                                <button onClick={cancelField}
                                  style={{ padding: "5px 12px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, color: colors.textLight, fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>
                                  Cancel
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => startEditField(f)}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
                                  <code style={{ fontSize: 13, fontWeight: 700, color: colors.text, background: colors.cardBg, padding: "2px 8px", borderRadius: 5, border: `1px solid ${colors.border}` }}>{`{{${f.name}}}`}</code>
                                  {isOverride && (
                                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: colors.accentLight, color: colors.accentDark, letterSpacing: 0.3, textTransform: "uppercase" }}>Override</span>
                                  )}
                                </div>
                                <div style={{ fontSize: 12, color: colors.textLight, whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                                  {f.value || <span style={{ color: colors.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(empty)</span>}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                                <button onClick={() => startEditField(f)}
                                  title="Edit"
                                  style={{ padding: "5px 8px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, fontSize: 12, fontFamily: "inherit", cursor: "pointer", color: colors.textLight, display: "inline-flex", alignItems: "center" }}>
                                  Edit
                                </button>
                                <button onClick={() => deleteField(f.id)}
                                  title="Delete"
                                  style={{ padding: "5px 8px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, cursor: "pointer", color: colors.danger, display: "inline-flex", alignItems: "center" }}>
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {editingFieldId === "new" ? (
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", borderRadius: 8, background: colors.blueLight, border: `1px solid ${colors.accent}` }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Name</span>
                        <input value={fieldDraft?.name || ""}
                          autoFocus
                          onChange={e => setFieldDraft(d => ({ ...d, name: e.target.value }))}
                          onKeyDown={e => { if (e.key === "Enter") saveField(); if (e.key === "Escape") cancelField(); }}
                          placeholder="e.g. signature"
                          style={{ flex: 1, minWidth: 140, padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }} />
                        {fieldDraft?.name && BUILTIN_NAMES.has(_normaliseName(fieldDraft.name)) && (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: colors.accentLight, color: colors.accentDark, letterSpacing: 0.3, textTransform: "uppercase" }}>Overrides built-in</span>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                        <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, paddingTop: 6 }}>Value</span>
                        <textarea value={fieldDraft?.value || ""}
                          onChange={e => setFieldDraft(d => ({ ...d, value: e.target.value }))}
                          onKeyDown={e => { if (e.key === "Escape") cancelField(); }}
                          placeholder="The text this field should insert. May contain {{other_fields}}."
                          rows={3}
                          style={{ flex: 1, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text, resize: "vertical", lineHeight: 1.5, boxSizing: "border-box" }} />
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                      <button onClick={saveField}
                        style={{ padding: "5px 12px", border: "none", borderRadius: 6, background: colors.sidebarHover, color: "#fff", fontSize: 12, fontFamily: "inherit", fontWeight: 600, cursor: "pointer" }}>
                        Save
                      </button>
                      <button onClick={cancelField}
                        style={{ padding: "5px 12px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, color: colors.textLight, fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={startNewField}
                    style={{ padding: "6px 14px", border: `1px dashed ${colors.border}`, borderRadius: 8, background: "transparent", color: colors.textLight, fontSize: 12, fontFamily: "inherit", fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Plus size={12} /> Add merge field
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Session 96: Insert Resource Link picker. Only resources with
              a URL are eligible — file-only resources are filtered out here
              because the picker inserts an <a href="…"> into the body. For
              a resource with an uploaded file, the public URL is what gets
              stored when Matt uploads via DocumentsResourcesManager, so
              file-based resources DO have r.url set. File-only resources
              that somehow lost their URL are skipped. */}
          {resources.length > 0 && (
            <div style={{ marginBottom: 14, position: "relative" }} ref={resourcePickerRef}>
              <button onClick={() => setResourcePickerOpen(v => !v)}
                style={{ padding: "6px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, background: colors.cardBg, fontSize: 12, fontFamily: "inherit", fontWeight: 600, cursor: "pointer", color: colors.textLight, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <LinkIcon size={12} /> Insert resource link
                <span style={{ color: colors.textMuted, fontSize: 11, fontWeight: 400 }}>→ {activeField === "subject" ? "subject" : "body"}</span>
              </button>
              {resourcePickerOpen && (
                <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 10, minWidth: 320, maxHeight: 260, overflowY: "auto", background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 14px rgba(0,0,0,0.08)", padding: 4 }}>
                  {resources.filter(r => r.url).length === 0 ? (
                    <div style={{ padding: "12px 14px", fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>No resources with URLs — add a URL in Documents & Resources first.</div>
                  ) : (
                    resources.filter(r => r.url).map(r => (
                      <button key={r.id}
                        onClick={() => insertResourceLink(r)}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: 13, color: colors.text, borderRadius: 6 }}
                        onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <div style={{ fontWeight: 600 }}>{r.label || "(untitled)"}</div>
                        {r.category && <div style={{ fontSize: 10, color: colors.textMuted, marginTop: 1 }}>{r.category}</div>}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {/* Session 96: Auto-attach documents. When this template is
              selected in ComposeModal, each listed document's bytes are
              downloaded from the private bucket (or fetched by URL for
              URL-based docs) and added to the outgoing attachments array.
              Per-item attachments stay per-item (invoices), shared
              attachments ride on the template. Matt picks via multi-select
              checkboxes so the UI stays simple as the document list grows. */}
          {documents.length > 0 && (
            <div style={{ marginBottom: 14, padding: 12, border: `1px dashed ${colors.inputBorder}`, borderRadius: 8, background: colors.bg }}>
              {/* Session 97: header is now a toggle — click the whole row to
                  open/close the document list. Keeps the editor compact when
                  the document library grows. */}
              <div onClick={() => setAttachOpen(v => !v)}
                style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: attachOpen ? 8 : 0, cursor: "pointer", userSelect: "none" }}>
                {attachOpen
                  ? <ChevronDown size={14} style={{ color: colors.textLight }} />
                  : <ChevronRight size={14} style={{ color: colors.textLight }} />}
                <Paperclip size={12} style={{ color: colors.textLight }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.4 }}>Always attach</span>
                {(form.autoAttachDocIds || []).length > 0 && (
                  <span style={{ fontSize: 11, color: colors.accent, fontWeight: 600 }}>{(form.autoAttachDocIds || []).length} selected</span>
                )}
              </div>
              {attachOpen && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
                  {documents.map(d => {
                    const checked = (form.autoAttachDocIds || []).includes(d.id);
                    const hasFile = !!d.storage_path;
                    const hasUrl = !!d.url;
                    const attachable = hasFile || hasUrl;
                    return (
                      <label key={d.id}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 6, cursor: attachable ? "pointer" : "not-allowed", fontSize: 12, opacity: attachable ? 1 : 0.5 }}
                        onMouseEnter={e => { if (attachable) e.currentTarget.style.background = colors.blueLight; }}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <input type="checkbox"
                          checked={checked}
                          disabled={!attachable}
                          onChange={() => toggleAutoAttachDoc(d.id)}
                          style={{ margin: 0, cursor: attachable ? "pointer" : "not-allowed" }} />
                        <FileText size={11} style={{ color: colors.accent, flexShrink: 0 }} />
                        <span style={{ flex: 1, fontWeight: 500 }}>{d.label || d.filename || "(unnamed)"}</span>
                        {d.type && <span style={{ fontSize: 10, color: colors.textMuted, flexShrink: 0 }}>{d.type}</span>}
                        {!attachable && <span style={{ fontSize: 10, color: colors.textMuted, fontStyle: "italic", flexShrink: 0 }}>no file/URL</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => save(form)} disabled={!form.triggerId || !form.name}
              style={{ padding: "8px 20px", border: "none", borderRadius: 8, background: form.triggerId && form.name ? colors.sidebarHover : colors.border, color: form.triggerId && form.name ? "#fff" : colors.textMuted, fontSize: 13, fontFamily: "inherit", fontWeight: 600, cursor: form.triggerId && form.name ? "pointer" : "not-allowed" }}>
              Save
            </button>
            <button onClick={() => { setEditing(null); setForm(null); }}
              style={{ padding: "8px 16px", border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.cardBg, fontSize: 13, fontFamily: "inherit", cursor: "pointer", color: colors.textLight }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Template list */}
      {filteredTemplates.length === 0 && !editing && (
        <div style={{ textAlign: "center", padding: "40px 20px", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>
          {selectedTrigger ? "No templates yet for this trigger — click New Template to create one." : "No templates yet — select a trigger above and create your first template."}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filteredTemplates.map(tmpl => {
          const trig = TRIGGER_MAP[tmpl.triggerId];
          // Session 95: resolve school chip from id. If schoolId points at a
          // deleted school, show a neutral "?" chip rather than hiding it — so
          // the user knows the template is still tagged and can edit/retag.
          const school = tmpl.schoolId ? schoolById[tmpl.schoolId] : null;
          const chipText = tmpl.schoolId
            ? (school ? schoolAcronym(school) || "?" : "?")
            : null;
          return (
            <div key={tmpl.id}
              onClick={() => startEdit(tmpl)}
              onMouseEnter={e => { e.currentTarget.style.background = colors.blueLight; e.currentTarget.style.borderColor = colors.sidebarHover; }}
              onMouseLeave={e => { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.border; }}
              style={{ background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 10, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", cursor: "pointer", transition: "background 0.12s, border-color 0.12s" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: colors.text }}>{tmpl.name}</span>
                  {chipText && (
                    <span title={school ? school.name : "Tagged school no longer exists"}
                      style={{ padding: "1px 7px", borderRadius: 10, fontSize: 10, fontWeight: 700, letterSpacing: 0.3, background: school ? (school.color || colors.sidebarHover) + "22" : colors.border, color: school ? (school.color || colors.sidebarHover) : colors.textMuted, border: `1px solid ${school ? (school.color || colors.sidebarHover) + "55" : colors.border}` }}>
                      {chipText}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                  <span>{trig?.label || tmpl.triggerId}</span>
                  {/* Session 96: paperclip pill when this template auto-attaches docs. */}
                  {Array.isArray(tmpl.autoAttachDocIds) && tmpl.autoAttachDocIds.length > 0 && (
                    <span title={`${tmpl.autoAttachDocIds.length} document${tmpl.autoAttachDocIds.length === 1 ? "" : "s"} auto-attached`}
                      style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 6px", borderRadius: 8, fontSize: 10, fontWeight: 600, background: colors.accentLight, color: colors.accentDark }}>
                      <Paperclip size={9} /> {tmpl.autoAttachDocIds.length}
                    </span>
                  )}
                </div>
                {tmpl.subject && <div style={{ fontSize: 12, color: colors.textLight, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>"{tmpl.subject}"</div>}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0, marginLeft: 12, alignItems: "center" }} onClick={e => e.stopPropagation()}>
                {/* Session 95: default star. Filled = this template is the
                    default for its (trigger, school) pair. Click to promote/demote. */}
                <button onClick={() => toggleDefault(tmpl)}
                  title={tmpl.isDefault
                    ? (tmpl.schoolId ? "Default for this school + trigger (click to unset)" : "Generic default for this trigger (click to unset)")
                    : (tmpl.schoolId ? "Set as default for this school + trigger" : "Set as generic default for this trigger")}
                  style={{ padding: "5px 8px", border: `1px solid ${tmpl.isDefault ? colors.accent : colors.border}`, borderRadius: 6, background: tmpl.isDefault ? colors.accentLight : colors.cardBg, cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
                  <Star size={13} fill={tmpl.isDefault ? colors.accent : "none"} color={tmpl.isDefault ? colors.accent : colors.textMuted} />
                </button>
                <button onClick={() => del(tmpl.id)}
                  style={{ padding: "5px 8px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, fontSize: 12, fontFamily: "inherit", cursor: "pointer", color: colors.danger, display: "inline-flex", alignItems: "center" }}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AiEmailRulesEditor({ notify }) {
  const { colors } = useTheme();
  const STORAGE_KEY = "mt-ai-email-rules";
  const load = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch(e) { return {}; } };
  const [rules, setRules] = React.useState(load);
  const [newKeyword, setNewKeyword] = React.useState("");
  const save = (updated) => {
    setRules(updated);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch(e) {}
    notify("AI rules saved ✓");
  };
  const addKeyword = () => {
    const kw = newKeyword.trim().toLowerCase();
    if (!kw) return;
    const existing = rules.keywords || [];
    if (existing.includes(kw)) return;
    save({ ...rules, keywords: [...existing, kw] });
    setNewKeyword("");
  };
  const removeKeyword = (kw) => save({ ...rules, keywords: (rules.keywords || []).filter(k => k !== kw) });
  return (
    <div>
      <Card style={{ marginBottom: 16, padding: 18 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: colors.text, marginBottom: 4, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Bot size={14} /> AI Email Rules
        </div>
        <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 18 }}>These settings are injected into Claude every time it triages an email. Add to them over time as you learn what works.</div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: colors.text, display: "block", marginBottom: 5 }}>Sign-off name</label>
          <input value={rules.signOff || ""} onChange={e => setRules(r => ({ ...r, signOff: e.target.value }))}
            placeholder="e.g. Matt"
            style={{ width: "100%", maxWidth: 260, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: colors.text, display: "block", marginBottom: 5 }}>School context</label>
          <textarea value={rules.contextHints || ""} onChange={e => setRules(r => ({ ...r, contextHints: e.target.value }))}
            placeholder={"e.g. I teach piano, violin and guitar at 3 primary schools.\nLesson days: Tue (Maplewood), Wed (Riverside), Thu (Hilltop)."}
            rows={4} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", resize: "vertical" }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: colors.text, display: "block", marginBottom: 5 }}>Custom reply instructions</label>
          <textarea value={rules.customInstructions || ""} onChange={e => setRules(r => ({ ...r, customInstructions: e.target.value }))}
            placeholder={"e.g. Always suggest a makeup lesson when a student is absent.\nKeep replies brief and friendly."}
            rows={4} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", resize: "vertical" }} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: colors.text, display: "block", marginBottom: 5 }}>Keywords to watch for</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input value={newKeyword} onChange={e => setNewKeyword(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addKeyword(); } }}
              placeholder="e.g. sick, away, cancel…"
              style={{ flex: 1, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} />
            <Btn onClick={addKeyword} disabled={!newKeyword.trim()}>Add</Btn>
          </div>
          {(rules.keywords || []).length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(rules.keywords || []).map(kw => (
                <span key={kw} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", background: colors.sidebarHover + "15", border: `1px solid ${colors.sidebarHover}40`, borderRadius: 12, fontSize: 12, color: colors.sidebarHover, fontWeight: 600 }}>
                  {kw}
                  <button onClick={() => removeKeyword(kw)} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "inline-flex", alignItems: "center", padding: 0 }}><X size={12} /></button>
                </span>
              ))}
            </div>
          ) : <div style={{ fontSize: 11, color: colors.textMuted }}>No keywords yet.</div>}
        </div>
        <Btn onClick={() => save(rules)}>Save Rules</Btn>
      </Card>
    </div>
  );
}

export function AiImportContacts({ schools, contacts, setContacts, notify }) {
  const { colors } = useTheme();
  const [rawText, setRawText] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [parsed, setParsed] = React.useState(null);
  const [conflicts, setConflicts] = React.useState({});
  const [defaultSchoolId, setDefaultSchoolId] = React.useState("");

  const runParse = async () => {
    if (!rawText.trim()) return;
    setLoading(true); setParsed(null);
    try {
      const schoolNames = schools.map(s => `${s.name} (id: ${s.id})`).join(", ");
      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `Extract school contacts from this text. Known schools: ${schoolNames || "none"}.

Text:
${rawText}

Return ONLY a JSON array (no markdown) where each item has:
- name: full name
- email: email address (empty string if not found)
- role: one of "Principal", "Assistant Principal", "Office Manager", "Business Manager", "Classroom Teacher", "Specialist Teacher", "Other"
- className: class name if mentioned (e.g. "3/4T"), otherwise empty string
- schoolId: best matching school id from the list above, or empty string if unclear
- phone: phone number if present, otherwise empty string`
          }]
        })
      });
      const data = await response.json();
      const text = data.content?.map(c => c.text || "").join("") || "[]";
      const clean = text.replace(/```json|```/g, "").trim();
      const items = JSON.parse(clean);
      const newConflicts = {};
      items.forEach((item, i) => {
        if (item.email && contacts.some(c => c.email && c.email.toLowerCase() === item.email.toLowerCase())) {
          newConflicts[i] = "skip";
        }
      });
      setParsed(items);
      setConflicts(newConflicts);
    } catch(e) {
      notify("Parse failed: " + e.message, "danger");
    }
    setLoading(false);
  };

  const importAll = () => {
    if (!parsed) return;
    const toImport = parsed.filter((_, i) => conflicts[i] !== "skip");
    const newContacts = toImport.map(item => ({
      id: uid(),
      name: item.name || "",
      email: item.email || "",
      role: item.role || "Other",
      className: item.className || "",
      schoolId: item.schoolId || defaultSchoolId || "",
      phone: item.phone || "",
      notes: "",
    }));
    let updated = [...contacts];
    parsed.forEach((item, i) => {
      if (conflicts[i] === "overwrite" && item.email) {
        updated = updated.map(c => c.email?.toLowerCase() === item.email.toLowerCase()
          ? { ...c, name: item.name || c.name, role: item.role || c.role, className: item.className || c.className, phone: item.phone || c.phone, schoolId: item.schoolId || c.schoolId }
          : c
        );
      }
    });
    setContacts([...updated, ...newContacts]);
    notify(`Imported ${newContacts.length} contact${newContacts.length !== 1 ? "s" : ""} ✓`);
    setRawText(""); setParsed(null); setConflicts({});
  };

  return (
    <Card style={{ marginBottom: 16, padding: 18 }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: colors.text, marginBottom: 4, display: "inline-flex", alignItems: "center", gap: 6 }}>
        <Download size={14} /> Import Contacts with AI
      </div>
      <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 14 }}>
        Paste any text — a newsletter, email, website copy, or list — and Claude will extract names, emails, roles and classes automatically.
      </div>

      {schools.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: colors.text, display: "block", marginBottom: 5 }}>Default school (if not clear from text)</label>
          <select value={defaultSchoolId} onChange={e => setDefaultSchoolId(e.target.value)}
            style={{ padding: "7px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
            <option value="">— Not specified —</option>
            {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}

      <textarea
        value={rawText}
        onChange={e => { setRawText(e.target.value); setParsed(null); }}
        placeholder={"Paste text here — e.g.:\n\n3/4T — Sarah Johnson (sarah.johnson@school.edu.au)\n5/6B — Michael Chen (m.chen@school.edu.au)\nPrincipal: Rebecca Walsh — r.walsh@school.edu.au"}
        rows={6}
        style={{ width: "100%", padding: "10px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", resize: "vertical", marginBottom: 10 }}
      />

      <div style={{ display: "flex", gap: 8, marginBottom: parsed ? 16 : 0 }}>
        <Btn onClick={runParse} disabled={loading || !rawText.trim()} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Bot size={13} />{loading ? "Parsing…" : "Parse with Claude"}
        </Btn>
        {rawText && <Btn variant="ghost" onClick={() => { setRawText(""); setParsed(null); setConflicts({}); }}>Clear</Btn>}
      </div>

      {/* Parsed results */}
      {parsed && parsed.length === 0 && (
        <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic" }}>No contacts found in that text.</div>
      )}
      {parsed && parsed.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
            Found {parsed.length} contact{parsed.length !== 1 ? "s" : ""} — review before importing:
          </div>
          <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
            {parsed.map((item, i) => {
              const isConflict = Object.prototype.hasOwnProperty.call(conflicts, i);
              const school = schools.find(s => s.id === item.schoolId);
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: colors.white, borderBottom: i < parsed.length - 1 ? `1px solid ${colors.border}` : "none" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: colors.text }}>{item.name || "—"}</div>
                    <div style={{ fontSize: 11, color: colors.textMuted }}>
                      {[item.role, item.className, school?.name].filter(Boolean).join(" · ")}
                    </div>
                    <div style={{ fontSize: 11, color: colors.accent }}>{item.email || "no email"}</div>
                  </div>
                  {isConflict && (
                    <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                      <span style={{ fontSize: 10, color: colors.danger, fontWeight: 600, alignSelf: "center" }}>EXISTS</span>
                      <button onClick={() => setConflicts(prev => ({ ...prev, [i]: "skip" }))}
                        style={{ padding: "3px 8px", borderRadius: 6, border: `1px solid ${conflicts[i] === "skip" ? colors.danger : colors.border}`, background: conflicts[i] === "skip" ? "#FEF6F6" : colors.white, fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: conflicts[i] === "skip" ? 700 : 400, color: conflicts[i] === "skip" ? colors.danger : colors.textMuted }}>
                        Skip
                      </button>
                      <button onClick={() => setConflicts(prev => ({ ...prev, [i]: "overwrite" }))}
                        style={{ padding: "3px 8px", borderRadius: 6, border: `1px solid ${conflicts[i] === "overwrite" ? colors.accent : colors.border}`, background: conflicts[i] === "overwrite" ? colors.accentLight : colors.white, fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: conflicts[i] === "overwrite" ? 700 : 400, color: conflicts[i] === "overwrite" ? colors.accentDark : colors.textMuted }}>
                        Update
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Btn onClick={importAll}>
              Import {parsed.filter((_, i) => conflicts[i] !== "skip").length} contact{parsed.filter((_, i) => conflicts[i] !== "skip").length !== 1 ? "s" : ""}
            </Btn>
            <Btn variant="ghost" onClick={() => { setParsed(null); setConflicts({}); }}>Cancel</Btn>
          </div>
        </div>
      )}
    </Card>
  );
}
