// ============================================================
// CONTACTSEDITORS — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { colors, STORAGE_KEYS, ALL_MERGE_FIELDS, EMAIL_TRIGGERS, TRIGGER_MAP } from "../constants";
import { uid } from "../utils/helpers";
import { anthropicFetch, getAnthropicHeaders } from "../utils/api";
import { getUserTemplates, saveUserTemplates } from "../utils/emailTemplates";
import { Card, Btn, Input, Tag, PageTitle, NavButtons, PAGE_COLORS } from "../components/ui/SharedUI";

export function EmailTemplatesEditor({ notify }) {
  const [templates, setTemplates] = React.useState(() => getUserTemplates());
  const [selectedTrigger, setSelectedTrigger] = React.useState("");
  const [editing, setEditing] = React.useState(null); // null | "new" | templateId
  const [form, setForm] = React.useState(null); // { name, triggerId, subject, body }
  const [showAllFields, setShowAllFields] = React.useState(false);

  const save = (tmpl) => {
    const updated = editing === "new"
      ? [...templates, { ...tmpl, id: uid(), createdAt: new Date().toISOString() }]
      : templates.map(t => t.id === editing ? { ...t, ...tmpl } : t);
    setTemplates(updated);
    saveUserTemplates(updated);
    setEditing(null); setForm(null);
    notify("Template saved");
  };

  const del = (id) => {
    const updated = templates.filter(t => t.id !== id);
    setTemplates(updated);
    saveUserTemplates(updated);
    notify("Template deleted");
  };

  const startNew = () => {
    const trigger = EMAIL_TRIGGERS.find(t => t.id === selectedTrigger);
    setForm({ name: trigger ? trigger.label : "", triggerId: selectedTrigger, subject: "", body: "" });
    setEditing("new");
    setShowAllFields(false);
  };

  const startEdit = (tmpl) => {
    setForm({ name: tmpl.name, triggerId: tmpl.triggerId, subject: tmpl.subject, body: tmpl.body });
    setEditing(tmpl.id);
    setSelectedTrigger(tmpl.triggerId);
    setShowAllFields(false);
  };

  const insertTag = (tag) => {
    setForm(prev => {
      // Insert into body textarea at cursor — simple append if no selection
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

  const filteredByTrigger = selectedTrigger
    ? templates.filter(t => t.triggerId === selectedTrigger)
    : templates;

  const trigger = EMAIL_TRIGGERS.find(t => t.id === (form?.triggerId || selectedTrigger));
  const relevantFields = trigger ? trigger.fields.map(f => ALL_MERGE_FIELDS.find(m => m.tag === `{{${f}}}`)).filter(Boolean) : [];
  const otherFields = ALL_MERGE_FIELDS.filter(m => !relevantFields.includes(m));

  const pillStyle = (muted) => ({
    padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "none",
    background: muted ? colors.bg : colors.accentLight,
    color: muted ? colors.textMuted : colors.accentDark,
    transition: "background 0.1s",
  });

  return (
    <div>
      {/* Trigger filter */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: colors.textLight, flexShrink: 0 }}>Template for:</label>
        <select value={selectedTrigger} onChange={e => { setSelectedTrigger(e.target.value); setEditing(null); setForm(null); }}
          style={{ flex: 1, maxWidth: 400, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
          <option value="">— All templates —</option>
          {EMAIL_TRIGGERS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <button onClick={startNew}
          style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: colors.sidebarActive, color: "#fff", fontSize: 13, fontFamily: "inherit", fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>
          + New Template
        </button>
      </div>

      {/* Editor */}
      {editing && form && (
        <div style={{ background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14, color: colors.sidebarActive }}>
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

          {/* Subject */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.4 }}>Subject</label>
            <input value={form.subject} onChange={e => setForm(prev => ({ ...prev, subject: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (form.triggerId && form.name) save(form); } }}
              style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
          </div>

          {/* Merge tag pills */}
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>Insert field</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {relevantFields.map(f => (
                <button key={f.tag} onClick={() => insertTag(f.tag)} style={pillStyle(false)} title={f.tag}>{f.label}</button>
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

          {/* Body */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.4 }}>Body</label>
            <textarea id="tmpl-body-ta" value={form.body} onChange={e => setForm(prev => ({ ...prev, body: e.target.value }))}
              rows={10}
              style={{ width: "100%", padding: "10px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box", lineHeight: 1.6 }} />
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => save(form)} disabled={!form.triggerId || !form.name}
              style={{ padding: "8px 20px", border: "none", borderRadius: 8, background: form.triggerId && form.name ? colors.sidebarActive : colors.border, color: form.triggerId && form.name ? "#fff" : colors.textMuted, fontSize: 13, fontFamily: "inherit", fontWeight: 600, cursor: form.triggerId && form.name ? "pointer" : "not-allowed" }}>
              Save
            </button>
            <button onClick={() => { setEditing(null); setForm(null); }}
              style={{ padding: "8px 16px", border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.white, fontSize: 13, fontFamily: "inherit", cursor: "pointer", color: colors.textLight }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Template list */}
      {filteredByTrigger.length === 0 && !editing && (
        <div style={{ textAlign: "center", padding: "40px 20px", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>
          {selectedTrigger ? "No templates yet for this trigger — click + New Template to create one." : "No templates yet — select a trigger above and create your first template."}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filteredByTrigger.map(tmpl => {
          const trig = TRIGGER_MAP[tmpl.triggerId];
          return (
            <div key={tmpl.id}
              onClick={() => startEdit(tmpl)}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(52,69,101,0.08)"; e.currentTarget.style.borderColor = colors.sidebarActive; }}
              onMouseLeave={e => { e.currentTarget.style.background = colors.white; e.currentTarget.style.borderColor = colors.border; }}
              style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", cursor: "pointer", transition: "background 0.12s, border-color 0.12s" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: colors.text, marginBottom: 3 }}>{tmpl.name}</div>
                <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>{trig?.label || tmpl.triggerId}</div>
                {tmpl.subject && <div style={{ fontSize: 12, color: colors.textLight, fontStyle: "italic" }}>"{tmpl.subject}"</div>}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0, marginLeft: 12 }} onClick={e => e.stopPropagation()}>
                <button onClick={() => del(tmpl.id)}
                  style={{ padding: "5px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.white, fontSize: 12, fontFamily: "inherit", cursor: "pointer", color: colors.danger }}>
                  🗑
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
        <div style={{ fontWeight: 700, fontSize: 14, color: colors.text, marginBottom: 4 }}>🤖 AI Email Rules</div>
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
                <span key={kw} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", background: colors.sidebarActive + "15", border: `1px solid ${colors.sidebarActive}40`, borderRadius: 12, fontSize: 12, color: colors.sidebarActive, fontWeight: 600 }}>
                  {kw}
                  <button onClick={() => removeKeyword(kw)} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
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
  const [rawText, setRawText] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [parsed, setParsed] = React.useState(null); // array of suggested contacts
  const [conflicts, setConflicts] = React.useState({}); // id -> "skip" | "overwrite"
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
      // Check for conflicts with existing contacts
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
    // Handle overwrites
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
      <div style={{ fontWeight: 700, fontSize: 14, color: colors.text, marginBottom: 4 }}>📥 Import Contacts with AI</div>
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
        <Btn onClick={runParse} disabled={loading || !rawText.trim()}>
          {loading ? "Parsing…" : "🤖 Parse with Claude"}
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
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: i % 2 === 0 ? colors.white : colors.bg, borderBottom: i < parsed.length - 1 ? `1px solid ${colors.border}` : "none" }}>
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

