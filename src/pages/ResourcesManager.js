// ============================================================
// RESOURCES MANAGER
// Link library for books, equipment, websites, sheet music.
// ============================================================

import React, { useState, useEffect } from "react";
import { colors } from "../constants";
import { uid } from "../utils/helpers";
import { PageTitle, NavButtons, Btn, Card, EmptyState } from "../components/ui/SharedUI";
import { PAGE_COLORS } from "../components/ui/SharedUI";

const RESOURCE_CATEGORIES = ["Book", "Equipment", "Website", "Sheet Music", "Video", "Other"];

export function ResourcesManager({ resources, setResources, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("");

  useEffect(() => { setEditingId(null); setEditForm(null); }, [resetKey]);

  const addResource = () => {
    const id = uid();
    const blank = { id, label: "", url: "", category: "", description: "", _isNew: true };
    setResources(prev => [blank, ...prev]);
    setEditingId(id); setEditForm({ ...blank });
  };

  const startEdit = (r) => { setEditingId(r.id); setEditForm({ ...r }); };

  const saveEdit = () => {
    if (!editForm) return;
    const { _isNew, ...toSave } = editForm;
    setResources(prev => prev.map(r => r.id === editingId ? toSave : r));
    setEditingId(null); setEditForm(null);
  };

  const cancelEdit = () => {
    const r = resources.find(r => r.id === editingId);
    if (r && r._isNew) setResources(prev => prev.filter(r => r.id !== editingId));
    setEditingId(null); setEditForm(null);
  };

  const deleteResource = (id) => {
    setResources(prev => prev.filter(r => r.id !== id));
    if (editingId === id) { setEditingId(null); setEditForm(null); }
  };

  const copyLink = (url) => {
    if (!url) return;
    try { navigator.clipboard.writeText(url); notify("Link copied to clipboard"); } catch(e) {}
  };

  const filtered = resources.filter(r => {
    if (filterCategory && r.category !== filterCategory) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(r.label || "").toLowerCase().includes(q) && !(r.description || "").toLowerCase().includes(q) && !(r.url || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const thStyle = { padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: 0.5, background: colors.sidebarActive, whiteSpace: "nowrap" };
  const inputStyle = { width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" };

  return (
    <div>
      <PageTitle subtitle={resources.length + " resource" + (resources.length !== 1 ? "s" : "")} pageColor={PAGE_COLORS.resources}
        action={<Btn onClick={addResource}>+ Add Resource</Btn>}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        Resources
      </PageTitle>

      <Card style={{ marginBottom: 16, padding: 14 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 160, position: "relative" }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search resources…"
              style={{ width: "100%", padding: "8px 32px 8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
            {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>}
          </div>
          <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
            <option value="">All Categories</option>
            {RESOURCE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </Card>

      {resources.length === 0 ? (
        <EmptyState icon="📚" title="No resources yet" subtitle="Save links to recommended books, equipment, websites and other resources for easy access when drafting emails." action="+ Add Resource" onAction={addResource} />
      ) : (
        <div style={{ background: colors.white, border: "1px solid " + colors.border, borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={thStyle}>Label</th>
                <th style={thStyle}>Category</th>
                <th style={thStyle}>Description</th>
                <th style={thStyle}>Link</th>
                <th style={{ ...thStyle, width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, idx) => {
                const isEditing = editingId === r.id;
                const rowBg = idx % 2 === 0 ? colors.white : colors.bg;
                return (
                  <tr key={r.id} style={{ background: isEditing ? colors.blueLight : rowBg, borderBottom: "1px solid " + colors.borderLight }}>
                    <td style={{ padding: "8px 12px", fontWeight: 600, whiteSpace: "nowrap" }}>
                      {isEditing
                        ? <input autoFocus value={editForm.label} onChange={e => setEditForm(f => ({ ...f, label: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }} placeholder="e.g. Essential Music Theory Book 1" style={inputStyle} />
                        : r.label || <span style={{ color: colors.textMuted, fontStyle: "italic" }}>—</span>}
                    </td>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      {isEditing
                        ? <select value={editForm.category} onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))} style={{ padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                            <option value="">Select…</option>
                            {RESOURCE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        : r.category
                          ? <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: colors.accentLight, color: colors.accentDark }}>{r.category}</span>
                          : <span style={{ color: colors.textMuted }}>—</span>}
                    </td>
                    <td style={{ padding: "8px 12px", color: colors.textLight }}>
                      {isEditing
                        ? <input value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }} placeholder="Brief description (optional)" style={inputStyle} />
                        : r.description || <span style={{ color: colors.textMuted }}>—</span>}
                    </td>
                    <td style={{ padding: "8px 12px", maxWidth: 220 }}>
                      {isEditing
                        ? <input value={editForm.url} onChange={e => setEditForm(f => ({ ...f, url: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }} placeholder="https://…" style={inputStyle} />
                        : r.url
                          ? <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ color: colors.accent, textDecoration: "none", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", maxWidth: 200 }}>{r.url.replace(/^https?:\/\//, "")}</a>
                          : <span style={{ color: colors.textMuted }}>—</span>}
                    </td>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
                        {isEditing ? (
                          <>
                            <button onClick={saveEdit} title="Save" style={{ border: "none", background: colors.success, color: "#fff", borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600 }}>✓</button>
                            <button onClick={cancelEdit} title="Cancel" style={{ border: "1px solid " + colors.border, background: colors.white, color: colors.textMuted, borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>✕</button>
                          </>
                        ) : (
                          <>
                            {r.url && <button onClick={() => copyLink(r.url)} title="Copy link" style={{ border: "1px solid " + colors.border, background: colors.white, color: colors.textMuted, borderRadius: 6, padding: "4px 7px", cursor: "pointer", fontSize: 13 }}>📋</button>}
                            <button onClick={() => startEdit(r)} title="Edit" style={{ border: "1px solid " + colors.border, background: colors.white, color: colors.textMuted, borderRadius: 6, padding: "4px 7px", cursor: "pointer", fontSize: 13 }}>✏</button>
                            <button onClick={() => deleteResource(r.id)} title="Delete" style={{ border: "1px solid " + colors.danger + "60", background: colors.white, color: colors.danger, borderRadius: 6, padding: "4px 7px", cursor: "pointer", fontSize: 13 }}>🗑</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && resources.length > 0 && (
            <div style={{ padding: "32px 20px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>No resources match the current filters</div>
          )}
        </div>
      )}
    </div>
  );
}
