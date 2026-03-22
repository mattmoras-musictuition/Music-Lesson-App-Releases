// ============================================================
// SETTINGS MANAGER — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { colors, STORAGE_KEYS, APP_VERSION, DATA_VERSION } from "../constants";
import { uid, melbourneToday, toLocalDateStr } from "../utils/helpers";
import { migrateData, loadData, saveData } from "../utils/backup";
import { GmailSettingsCard } from "./GmailSettingsCard";
import { Card, PageTitle, NavButtons, Btn, Input, Checkbox, Tag, EmptyState, AddMemoryInput, PAGE_COLORS } from "../components/ui/SharedUI";

export function SettingsManager({ apiKey, setApiKey, schools, students, teachers, specialists, interruptions, groups, timetable, weeklyTimetables, tallyEntries, contacts, bands, masterBreaks, resources, onRestore, onBackup, notify, resetKey, updateInfo, noUpdateFlash, setNoUpdateFlash, updateProgress, APP_VERSION, viewState, setViewState, goBack, goForward, historyCursor, pageHistory, claudeBudget, setClaudeBudget, tokenUsage, claudePersonalContext, setClaudePersonalContext, claudeMemory, setClaudeMemory }) {
  const fileRef = useRef(null);
  const [gmailStatus, setGmailStatus] = React.useState(null);
  const [backupDone, setBackupDone] = React.useState(false);
  React.useEffect(() => {
    if (window.electronAPI?.gmailGetStatus) window.electronAPI.gmailGetStatus().then(s => setGmailStatus(s));
  }, []);

  // ── Backup / Restore ──────────────────────────────────────
  const handleRestoreFile = async (e) => {
    if (window.electronAPI) {
      const result = await window.electronAPI.openFileDialog();
      if (!result.ok) return;
      try {
        const data = JSON.parse(result.json);
        if (!data.schools && !data.students) throw new Error("Not a valid backup file");
        if (onRestore) onRestore(data);
      } catch (err) { notify("Invalid backup file: " + err.message, "danger"); }
      return;
    }
    const file = e?.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.schools && !data.students) throw new Error("Not a valid backup file");
        if (onRestore) onRestore(data);
      } catch (err) { if (notify) notify("Invalid backup file: " + err.message, "danger"); }
    };
    reader.readAsText(file);
    if (e?.target) e.target.value = "";
  };

  // ── API Key ───────────────────────────────────────────────
  const [apiKeyDraft, setApiKeyDraft] = React.useState(apiKey || "");
  const [apiKeySaved, setApiKeySaved] = React.useState(false);

  // ── Clear all data ────────────────────────────────────────
  const [confirmClear, setConfirmClear] = React.useState(false);
  const handleClearAll = () => {
    const keys = Object.values(STORAGE_KEYS);
    keys.forEach(k => { try { localStorage.removeItem(k); } catch(e) {} });
    try { localStorage.removeItem("mt-api-key"); localStorage.removeItem("mt-last-autobak-time"); } catch(e) {}
    notify("All data cleared — reloading…");
    setTimeout(() => window.location.reload(), 1200);
  };

  // Collapsible sections
  const [openSections, setOpenSections] = React.useState({ data: false, app: false, term: false, danger: false });
  const toggleSection = (key) => setOpenSections(prev => ({ ...prev, [key]: !prev[key] }));

  const cardStyle = { background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: "18px 20px", marginBottom: 10 };

  const SectionBanner = ({ sectionKey, label, sub, danger = false }) => {
    const open = openSections[sectionKey];
    const bg = danger ? colors.danger : colors.sidebarActive;
    return (
      <div style={{ marginBottom: open ? 14 : 24 }}>
        <button onClick={() => toggleSection(sectionKey)}
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            background: bg, border: "none", borderRadius: open ? "10px 10px 0 0" : 10,
            padding: "11px 16px", cursor: "pointer", fontFamily: "inherit", transition: "border-radius 0.15s" }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#fff" }}>{label}</span>
          <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, transition: "transform 0.2s",
            display: "inline-block", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}>▾</span>
        </button>
        {open && sub && (
          <div style={{ background: danger ? colors.danger + "12" : colors.blueLight, border: `1px solid ${danger ? colors.danger + "30" : colors.sidebarActive + "22"}`,
            borderTop: "none", borderRadius: "0 0 10px 10px", padding: "9px 16px 10px",
            fontSize: 12.5, color: danger ? colors.danger : colors.sidebarActive, lineHeight: 1.5 }}>
            {sub}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <PageTitle pageColor={PAGE_COLORS.settings || colors.sidebarActive}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        Settings
      </PageTitle>
      <div style={{ padding: "28px 36px", maxWidth: 720 }}>

        {/* ── DATA & BACKUP ── */}
        <div style={{ marginBottom: 24 }}>
          <SectionBanner sectionKey="data" label="Data & Backup"
            sub="Manually save a backup or restore from a previous file. Auto-backup runs every 6 hours." />

          {openSections.data && (
            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: colors.textMuted }}>
                  {localStorage.getItem(STORAGE_KEYS.lastScheduledBackup) ? (
                    <span>⏱ Last auto-backup: {new Date(localStorage.getItem(STORAGE_KEYS.lastScheduledBackup)).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  ) : (
                    <span style={{ color: colors.amber }}>⚠ No auto-backup yet — runs every 6 hours</span>
                  )}
                  {window.electronAPI && (() => {
                    const savedFolder = localStorage.getItem(STORAGE_KEYS.backupFolder);
                    return (
                      <span>
                        📁 {savedFolder ? (
                          <>
                            <span style={{ cursor: "pointer", textDecoration: "underline" }}
                              onClick={() => window.electronAPI.revealInFinder(savedFolder)}>
                              {savedFolder.split("/").pop() || savedFolder}
                            </span>
                            {" · "}
                            <span style={{ cursor: "pointer", textDecoration: "underline" }}
                              onClick={async () => { const p = await window.electronAPI.selectBackupFolder(); if (p) { localStorage.setItem(STORAGE_KEYS.backupFolder, p); notify("Backup folder updated"); } }}>
                              Change
                            </span>
                          </>
                        ) : (
                          <span style={{ cursor: "pointer", textDecoration: "underline" }}
                            onClick={async () => { const p = await window.electronAPI.selectBackupFolder(); if (p) { localStorage.setItem(STORAGE_KEYS.backupFolder, p); notify("Backup folder set"); } }}>
                            Choose backup folder…
                          </span>
                        )}
                      </span>
                    );
                  })()}
                  {window.electronAPI && (() => {
                    const ttFolder = localStorage.getItem(STORAGE_KEYS.timetableFolder);
                    return (
                      <span>
                        🗂 Timetables: {ttFolder ? (
                          <>
                            <span style={{ cursor: "pointer", textDecoration: "underline" }}
                              onClick={() => window.electronAPI.revealInFinder(ttFolder)}>
                              {ttFolder.split("/").pop() || ttFolder}
                            </span>
                            {" · "}
                            <span style={{ cursor: "pointer", textDecoration: "underline" }}
                              onClick={async () => { const p = await window.electronAPI.selectBackupFolder(); if (p) { localStorage.setItem(STORAGE_KEYS.timetableFolder, p); notify("Timetable folder updated"); } }}>
                              Change
                            </span>
                          </>
                        ) : (
                          <span style={{ cursor: "pointer", textDecoration: "underline" }}
                            onClick={async () => { const p = await window.electronAPI.selectBackupFolder(); if (p) { localStorage.setItem(STORAGE_KEYS.timetableFolder, p); notify("Timetable folder set"); } }}>
                            Choose timetable folder…
                          </span>
                        )}
                      </span>
                    );
                  })()}
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <Btn onClick={async () => { const ok = await onBackup(); if (ok) { setBackupDone(true); setTimeout(() => setBackupDone(false), 2500); } }} variant={backupDone ? "success" : "primary"}>
                    {backupDone ? "✓ Saved" : "Backup now"}
                  </Btn>
                  <Btn variant="secondary" onClick={() => window.electronAPI ? handleRestoreFile() : fileRef.current?.click()}>Restore</Btn>
                  {!window.electronAPI && <input ref={fileRef} type="file" accept=".json" onChange={handleRestoreFile} style={{ display: "none" }} />}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── APP ── */}
        <div style={{ marginBottom: 24 }}>
          <SectionBanner sectionKey="app" label="App"
            sub="API key for AI features, app version, and update settings." />

          {openSections.app && <>
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>🔑 Anthropic API Key</div>
              <div style={{ fontSize: 12, color: colors.textLight, marginBottom: 10 }}>
                Required for AI features (notes parsing, Week Assistant). Get your key at{" "}
                <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{ color: colors.accent }}>console.anthropic.com</a>.
                Your key is stored only on this device.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="password" value={apiKeyDraft} onChange={e => setApiKeyDraft(e.target.value)}
                  placeholder="sk-ant-..."
                  style={{ flex: 1, padding: "8px 12px", border: `1.5px solid ${apiKeySaved ? colors.success : colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", boxSizing: "border-box" }}
                  onKeyDown={e => { if (e.key === "Enter") { setApiKey(apiKeyDraft); try { localStorage.setItem("mt-api-key", apiKeyDraft); } catch(err) {} setApiKeySaved(true); setTimeout(() => setApiKeySaved(false), 2000); } }}
                />
                <Btn onClick={() => { setApiKey(apiKeyDraft); try { localStorage.setItem("mt-api-key", apiKeyDraft); } catch(err) {} setApiKeySaved(true); setTimeout(() => setApiKeySaved(false), 2000); }}>
                  {apiKeySaved ? "✓ Saved" : "Save"}
                </Btn>
              </div>
            </div>

            {/* ── Claude personal context ── */}
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>🧠 Claude Personal Context</div>
              <div style={{ fontSize: 12, color: colors.textLight, marginBottom: 10 }}>
                This is included in every Claude request. Describe yourself, your practice, and any standing preferences. Claude also receives your live schedule data automatically.
              </div>
              <textarea
                defaultValue={claudePersonalContext}
                placeholder={`I'm Matt, a self-employed music teacher based in Melbourne, Australia.\nI teach piano, guitar, and other instruments across multiple primary schools in Melbourne's north. I run a solo teaching practice and manage my own scheduling, invoicing, and parent communication.\n\nMy schools operate on the Victorian school term calendar. Lessons are typically 30 minutes and happen during school hours. Some students have lessons pulled from class, others during lunch or after school.\n\nWhen lessons are missed I track whether a catch-up is owed. I prefer to be proactive about following up with parents when students miss multiple lessons. I communicate with both parents and school staff.\n\nKeep responses concise and practical. Use my live data — don't ask me for information you already have.`}
                rows={8}
                style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", resize: "vertical", lineHeight: 1.5, boxSizing: "border-box" }}
                onBlur={e => {
                  setClaudePersonalContext(e.target.value);
                  try { localStorage.setItem(STORAGE_KEYS.claudePersonalContext, e.target.value); } catch(err) {}
                }}
              />
              <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 6 }}>Saves automatically when you click away.</div>
            </div>

            {/* ── Claude memory ── */}
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>✦ Claude Memory</div>
              <div style={{ fontSize: 12, color: colors.textLight, marginBottom: 10 }}>
                Facts Claude remembers across all sessions. Add them here or use the "remember" button in the chat panel.
              </div>
              {claudeMemory.length === 0 && (
                <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic", marginBottom: 10 }}>No memories saved yet.</div>
              )}
              {claudeMemory.map((m, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: colors.accent, marginTop: 1, flexShrink: 0 }}>✦</span>
                  <input
                    defaultValue={m}
                    onBlur={e => {
                      const updated = claudeMemory.map((item, idx) => idx === i ? e.target.value.trim() : item).filter(Boolean);
                      setClaudeMemory(updated);
                      try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(err) {}
                    }}
                    style={{ flex: 1, padding: "5px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", color: colors.text, outline: "none" }}
                  />
                  <button
                    onClick={() => {
                      const updated = claudeMemory.filter((_, idx) => idx !== i);
                      setClaudeMemory(updated);
                      try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(err) {}
                    }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 16, lineHeight: 1, padding: "4px 2px", flexShrink: 0 }}
                    onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                    onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}
                  >×</button>
                </div>
              ))}
              {/* Add new */}
              <AddMemoryInput onAdd={mem => {
                const updated = [...claudeMemory, mem];
                setClaudeMemory(updated);
                try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(err) {}
              }} />
            </div>

            {/* ── Claude monthly budget ── */}
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>💰 Claude Monthly Budget</div>
              <div style={{ fontSize: 12, color: colors.textLight, marginBottom: 10 }}>
                Sets the reference point for the usage bar in the sidebar. The bar depletes as you spend toward this limit. Spend is estimated from token counts — not a live balance.
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 13, color: colors.textLight }}>$</span>
                <input
                  type="number" min="1" max="500" step="1"
                  defaultValue={claudeBudget.toFixed(0)}
                  style={{ width: 80, padding: "8px 12px", border: `1.5px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none" }}
                  onBlur={e => {
                    const val = Math.max(1, parseFloat(e.target.value) || 10);
                    setClaudeBudget(val);
                    try { localStorage.setItem(STORAGE_KEYS.claudeBudget, String(val)); } catch(err) {}
                  }}
                  onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                />
                <span style={{ fontSize: 12, color: colors.textLight }}>per month</span>
                {(() => {
                  const monthKey = new Date().toISOString().slice(0, 7);
                  const spent = tokenUsage[monthKey]?.costUSD || 0;
                  const pct = claudeBudget > 0 ? Math.min(1, spent / claudeBudget) : 0;
                  const barColor = pct > 0.85 ? colors.danger : colors.accent;
                  return (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
                      <div style={{ height: 6, borderRadius: 3, background: colors.border, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${(1 - pct) * 100}%`, background: barColor, borderRadius: 3, transition: "width 0.4s ease" }} />
                      </div>
                      <div style={{ fontSize: 11, color: colors.textMuted }}>
                        ${spent.toFixed(3)} spent · ${Math.max(0, claudeBudget - spent).toFixed(3)} remaining
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* ── Gmail ── */}
            {window.electronAPI?.gmailGetStatus && <GmailSettingsCard notify={notify} cardStyle={cardStyle} gmailStatus={gmailStatus} setGmailStatus={setGmailStatus} />}

            <div style={{ ...cardStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Version {APP_VERSION}</div>
                <div style={{ fontSize: 12, color: colors.textLight, marginTop: 2 }}>
                  {updateInfo?.ready ? "Update ready to install" : updateInfo?.available ? "Downloading update…" : noUpdateFlash ? "Up to date" : "Music Timetabling"}
                </div>
                {updateProgress !== null && (
                  <div style={{ width: 160, height: 4, background: colors.border, borderRadius: 2, marginTop: 6, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: updateProgress + "%", background: colors.accent, borderRadius: 2, transition: "width 0.3s" }} />
                  </div>
                )}
              </div>
              <Btn variant={updateInfo?.available ? "primary" : "secondary"}
                onClick={() => {
                  if (updateInfo?.ready && window.electronAPI?.installUpdate) { window.electronAPI.installUpdate(); return; }
                  if (window.electronAPI?.checkForUpdates) { window.electronAPI.checkForUpdates(); }
                }}>
                {updateInfo?.ready ? "Restart & install" : updateInfo?.available ? "Downloading…" : "Check for updates"}
              </Btn>
            </div>
          </>}
        </div>

        {/* ── TERM MANAGEMENT ── */}
        <div style={{ marginBottom: 24 }}>
          <SectionBanner sectionKey="term" label="Term Management"
            sub="End-of-term actions for resetting and archiving data between terms." />

          {openSections.term && (
            <div style={{ ...cardStyle, opacity: 0.6, pointerEvents: "none" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: colors.text }}>Finalise Term 1</div>
                  <div style={{ fontSize: 12, color: colors.textLight, marginTop: 2 }}>Archive tally data, reset weekly adjustments, and prepare for Term 2. Coming soon.</div>
                </div>
                <Btn variant="secondary" disabled>Finalise Term →</Btn>
              </div>
            </div>
          )}
        </div>

        {/* ── DANGER ZONE ── */}
        <div style={{ marginBottom: 24 }}>
          <SectionBanner sectionKey="danger" label="Danger Zone" danger
            sub="Irreversible actions. Make a backup before proceeding." />

          {openSections.danger && (
            <div style={{ ...cardStyle, border: `1px solid ${colors.danger}30` }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Clear all data</div>
                  <div style={{ fontSize: 12, color: colors.textLight, marginTop: 2 }}>Permanently removes all schools, students, timetable, and settings. Cannot be undone.</div>
                </div>
                {confirmClear ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                    <span style={{ fontSize: 12, color: colors.danger, fontWeight: 500, whiteSpace: "nowrap" }}>Are you sure?</span>
                    <Btn variant="danger" onClick={handleClearAll}>Yes, clear all</Btn>
                    <Btn variant="secondary" onClick={() => setConfirmClear(false)}>Cancel</Btn>
                  </div>
                ) : (
                  <Btn variant="danger" onClick={() => setConfirmClear(true)} style={{ flexShrink: 0 }}>Clear all data</Btn>
                )}
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
// ============================================================
function ResourcesManager({ resources, setResources, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("");

  useEffect(() => { setEditingId(null); setEditForm(null); }, [resetKey]);

  const RESOURCE_CATEGORIES = ["Book", "Equipment", "Website", "Sheet Music", "Video", "Other"];

  const addResource = () => {
    const id = uid();
    const blank = { id, label: "", url: "", category: "", description: "", _isNew: true };
    setResources(prev => [blank, ...prev]);
    setEditingId(id);
    setEditForm({ ...blank });
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

  const allCategories = [...new Set(resources.map(r => r.category).filter(Boolean))].sort();

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
          <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
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
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, background: colors.sidebarActive, whiteSpace: "nowrap" }}>Label</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, background: colors.sidebarActive, whiteSpace: "nowrap" }}>Category</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, background: colors.sidebarActive }}>Description</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, background: colors.sidebarActive }}>Link</th>
                <th style={{ padding: "10px 12px", background: colors.sidebarActive, width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, idx) => {
                const isEditing = editingId === r.id;
                const rowBg = idx % 2 === 0 ? colors.white : colors.bg;
                return (
                  <tr key={r.id} style={{ background: isEditing ? colors.blueLight : rowBg, borderBottom: "1px solid " + colors.borderLight }}>
                    {/* Label */}
                    <td style={{ padding: "8px 12px", fontWeight: 600, whiteSpace: "nowrap" }}>
                      {isEditing
                        ? <input autoFocus value={editForm.label} onChange={e => setEditForm(f => ({ ...f, label: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }} placeholder="e.g. Essential Music Theory Book 1"
                            style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                        : r.label || <span style={{ color: colors.textMuted, fontStyle: "italic" }}>—</span>}
                    </td>
                    {/* Category */}
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      {isEditing
                        ? <select value={editForm.category} onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}
                            style={{ padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                            <option value="">Select…</option>
                            {RESOURCE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        : r.category
                          ? <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: colors.accentLight, color: colors.accentDark }}>{r.category}</span>
                          : <span style={{ color: colors.textMuted }}>—</span>}
                    </td>
                    {/* Description */}
                    <td style={{ padding: "8px 12px", color: colors.textLight }}>
                      {isEditing
                        ? <input value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }} placeholder="Brief description (optional)"
                            style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                        : r.description || <span style={{ color: colors.textMuted }}>—</span>}
                    </td>
                    {/* URL */}
                    <td style={{ padding: "8px 12px", maxWidth: 220 }}>
                      {isEditing
                        ? <input value={editForm.url} onChange={e => setEditForm(f => ({ ...f, url: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }} placeholder="https://…"
                            style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                        : r.url
                          ? <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ color: colors.accent, textDecoration: "none", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", maxWidth: 200 }}>{r.url.replace(/^https?:\/\//, "")}</a>
                          : <span style={{ color: colors.textMuted }}>—</span>}
                    </td>
                    {/* Actions */}
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

