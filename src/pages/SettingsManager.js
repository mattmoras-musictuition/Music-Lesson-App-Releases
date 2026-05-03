// ============================================================
// SETTINGS MANAGER — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef } from "react";
import { Key, Brain, Sparkles, Save, RefreshCw, Folder, Clock, AlertTriangle, ChevronDown, Check, X, Moon, Trash2, Volume2, Filter, Tag as TagIcon, Plus, Palette, MessageSquare, FileText } from "lucide-react";
import { STORAGE_KEYS, APP_VERSION, DATA_VERSION, instruments_colors } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { GmailSettingsCard } from "./GmailSettingsCard";
import { Card, PageTitle, NavButtons, Btn, Input, Checkbox, Tag, EmptyState, AddMemoryInput, PAGE_COLORS } from "../components/ui/SharedUI";
import { setInstColorOverrides } from "../utils/helpers";
import { instrumentsFromEnrolments } from "../utils/enrolmentsDB";
import { supabase } from "../supabaseClient";
// Session 95: EmailTemplatesEditor lives in ContactsEditors but is no longer
// reached from the Contacts page — it's now a Settings section.
import { EmailTemplatesEditor } from "./ContactsEditors";

// ── Section helpers — defined outside SettingsManager so their identity is
// stable across re-renders, preventing the textarea from losing focus. ─────
function SectionBanner({ sectionKey, label, icon, danger = false, isOpen, onToggle, colors }) {
  const bg = danger ? colors.danger : colors.sidebarHover;
  return (
    <button onClick={() => onToggle(sectionKey)}
      style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
        background: bg, border: "none",
        borderRadius: isOpen ? "10px 10px 0 0" : 10,
        padding: "12px 18px", cursor: "pointer", fontFamily: "inherit",
        marginBottom: isOpen ? 0 : 12, transition: "border-radius 0.15s" }}>
      <span style={{ fontWeight: 700, fontSize: 14, color: "#fff", display: "inline-flex", alignItems: "center", gap: 8 }}>
        {icon}{label}
      </span>
      <span style={{ color: "rgba(255,255,255,0.65)", display: "inline-flex", alignItems: "center",
        transition: "transform 0.2s", transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
        <ChevronDown size={15} />
      </span>
    </button>
  );
}

function SectionPanel({ isOpen, danger = false, colors, children }) {
  if (!isOpen) return null;
  return (
    <div style={{
      border: `1px solid ${danger ? colors.danger + "50" : colors.border}`,
      borderTop: "none", borderRadius: "0 0 10px 10px",
      overflow: "hidden", marginBottom: 12,
    }}>
      {children}
    </div>
  );
}

// ── Context trigger category definitions ─────────────────────────────────────
// These are the display labels and descriptions shown in Settings.
// The actual keyword arrays live in App.js (DEFAULT_CONTEXT_TRIGGERS) and
// are stored in localStorage under "mt-context-triggers".
const TRIGGER_CATEGORIES = [
  { key: "contacts",        label: "Contacts & parents",       sub: "Include parent/contact details when these words appear in your message." },
  { key: "tally",           label: "Tally & missed lessons",   sub: "Include tally history when asking about missed lessons, catch-ups, or absences." },
  { key: "specialists",     label: "Specialist timetable",     sub: "Include specialist class times when asking about conflicts or pullouts." },
  { key: "masterFull",      label: "Full master timetable",    sub: "Include full master timetable detail (normally replaced by a short summary when WTT exists)." },
  { key: "pastWeeks",       label: "Past timetable weeks",     sub: "Include last week's WTT when referring to previous lessons." },
  { key: "resources",       label: "Documents & resources",    sub: "Include the documents and resources list." },
  { key: "groups",          label: "Groups & bands",           sub: "Include group and band details." },
  { key: "catchup",         label: "Holiday catch-up data",    sub: "Include holiday catch-up schedule." },
];

function ContextTriggersPanel({ contextTriggers, setContextTriggers, colors, rowStyle, rowLast, rowLabel, notify }) {
  const [drafts, setDrafts] = React.useState({}); // { categoryKey: "new keyword draft" }

  if (!contextTriggers) {
    return (
      <div style={{ padding: "16px 18px", fontSize: 13, color: colors.textMuted, fontStyle: "italic" }}>
        Context triggers not yet loaded. Restart the app if this persists.
      </div>
    );
  }

  const updateKeyword = (catKey, keywords) => {
    const updated = { ...contextTriggers, [catKey]: keywords };
    setContextTriggers(updated);
    try { localStorage.setItem("mt-context-triggers", JSON.stringify(updated)); } catch {}
  };

  const removeKeyword = (catKey, word) => {
    updateKeyword(catKey, (contextTriggers[catKey] || []).filter(w => w !== word));
  };

  const addKeyword = (catKey) => {
    const raw = (drafts[catKey] || "").trim().toLowerCase();
    if (!raw) return;
    const current = contextTriggers[catKey] || [];
    if (current.includes(raw)) { notify(`"${raw}" is already in this list`, "warning"); return; }
    updateKeyword(catKey, [...current, raw]);
    setDrafts(prev => ({ ...prev, [catKey]: "" }));
  };

  const handleKeyDown = (e, catKey) => {
    if (e.key === "Enter") { e.preventDefault(); addKeyword(catKey); }
  };

  return (
    <>
      <div style={{ padding: "10px 18px 4px", fontSize: 12, color: colors.textMuted, lineHeight: 1.5 }}>
        Claude only pulls in data that's relevant to your message. Edit the keywords that trigger each section.
        Matching is case-insensitive and uses substring search — <strong style={{ color: colors.text }}>"parent"</strong> also matches "parents", "parent's", etc.
      </div>

      {TRIGGER_CATEGORIES.map((cat, i) => {
        const keywords = contextTriggers[cat.key] || [];
        const isLast = i === TRIGGER_CATEGORIES.length - 1;
        return (
          <div key={cat.key} style={isLast ? rowLast : rowStyle}>
            {rowLabel(cat.label, cat.sub)}
            <div style={{ flex: 1, maxWidth: 360, display: "flex", flexDirection: "column", gap: 8 }}>

              {/* Keyword chips */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minHeight: 28 }}>
                {keywords.length === 0 && (
                  <span style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic", lineHeight: "26px" }}>
                    No keywords — this section is never included
                  </span>
                )}
                {keywords.map(word => (
                  <span key={word} style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "3px 8px 3px 10px", borderRadius: 99,
                    background: colors.accentLight, border: `1px solid ${colors.accent}30`,
                    fontSize: 12, color: colors.accent, fontWeight: 500,
                  }}>
                    {word}
                    <button
                      onClick={() => removeKeyword(cat.key, word)}
                      title={`Remove "${word}"`}
                      style={{
                        background: "none", border: "none", cursor: "pointer",
                        color: colors.accent, opacity: 0.6,
                        display: "inline-flex", alignItems: "center", padding: 0,
                        borderRadius: 3,
                      }}
                      onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                      onMouseLeave={e => e.currentTarget.style.opacity = "0.6"}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>

              {/* Add keyword input */}
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  value={drafts[cat.key] || ""}
                  onChange={e => setDrafts(prev => ({ ...prev, [cat.key]: e.target.value }))}
                  onKeyDown={e => handleKeyDown(e, cat.key)}
                  placeholder="Add keyword…"
                  style={{
                    flex: 1, padding: "5px 9px",
                    border: `1.5px solid ${colors.inputBorder}`,
                    borderRadius: 7, fontSize: 12, fontFamily: "inherit",
                    color: colors.text, background: colors.cardBg, outline: "none",
                  }}
                  onFocus={e => e.target.style.borderColor = colors.accent}
                  onBlur={e => e.target.style.borderColor = colors.inputBorder}
                />
                <button
                  onClick={() => addKeyword(cat.key)}
                  disabled={!(drafts[cat.key] || "").trim()}
                  style={{
                    padding: "5px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600,
                    border: `1.5px solid ${colors.accent}`,
                    background: (drafts[cat.key] || "").trim() ? colors.accentLight : colors.bg,
                    color: (drafts[cat.key] || "").trim() ? colors.accent : colors.textMuted,
                    cursor: (drafts[cat.key] || "").trim() ? "pointer" : "not-allowed",
                    fontFamily: "inherit", transition: "all 0.15s",
                  }}
                >
                  Add
                </button>
              </div>

            </div>
          </div>
        );
      })}

      {/* Reset to defaults footer */}
      <div style={{ padding: "10px 18px", borderTop: `1px solid ${colors.borderLight}`, display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={() => {
            if (!window.confirm("Reset all context trigger keywords to their defaults?")) return;
            const defaults = window._getDefaultContextTriggers?.() || {};
            setContextTriggers(defaults);
            try { localStorage.removeItem("mt-context-triggers"); } catch {}
            notify("Context triggers reset to defaults");
          }}
          style={{
            fontSize: 12, color: colors.textMuted, background: "none", border: "none",
            cursor: "pointer", fontFamily: "inherit", padding: "2px 0",
          }}
          onMouseEnter={e => e.currentTarget.style.color = colors.danger}
          onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}
        >
          Reset to defaults
        </button>
      </div>
    </>
  );
}

export function SettingsManager({ apiKey, setApiKey, schools, students, enrolments, teachers, specialists, interruptions, setInterruptions, groups, timetable, weeklyTimetables, contacts, bands, masterBreaks, resources, documents, onRestore, onBackup, notify, resetKey, updateInfo, noUpdateFlash, setNoUpdateFlash, updateProgress, APP_VERSION, viewState, setViewState, goBack, goForward, historyCursor, pageHistory, claudeBudget, setClaudeBudget, tokenUsage, claudePersonalContext, setClaudePersonalContext, claudeMemory, setClaudeMemory, darkMode, toggleDarkMode, soundSettings, setSoundSettings, onPreviewSound, contextTriggers, setContextTriggers, emailStyle, setEmailStyle, messengerDisplayName, setMessengerDisplayName, messengerBubbleColour, setMessengerBubbleColour, orphanedLessons = [], onGoToOrphanStudent, onDeleteOrphanedLesson }) {
  const { colors } = useTheme();
  const fileRef = useRef(null);
  const [gmailStatus, setGmailStatus] = React.useState(null);
  const [backupDone, setBackupDone] = React.useState(false);

  const [timezone, setTimezoneState] = React.useState(() => localStorage.getItem("mt-timezone") || "Australia/Melbourne");
  const saveTimezone = (tz) => { setTimezoneState(tz); try { localStorage.setItem("mt-timezone", tz); } catch {} };

  const [rememberedReasons, setRememberedReasons] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.missedReasons) || "[]"); } catch { return []; }
  });
  React.useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.from("app_settings").select("value").eq("key", "missed_reasons").single();
        if (data?.value) {
          const parsed = JSON.parse(data.value);
          if (Array.isArray(parsed)) { setRememberedReasons(parsed); try { localStorage.setItem(STORAGE_KEYS.missedReasons, JSON.stringify(parsed)); } catch {} }
        }
      } catch {}
    })();
  }, []);
  const saveRememberedReasons = async (list) => {
    setRememberedReasons(list);
    try { localStorage.setItem(STORAGE_KEYS.missedReasons, JSON.stringify(list)); } catch {}
    try { await supabase.from("app_settings").upsert({ key: "missed_reasons", value: JSON.stringify(list) }); } catch {}
  };

  const [backupFolder, setBackupFolder] = React.useState("");
  const [timetableFolder, setTimetableFolder] = React.useState(() => localStorage.getItem(STORAGE_KEYS.timetableFolder) || "");

  // Load both folders from Electron on mount; listen for menu-driven backup folder changes
  React.useEffect(() => {
    if (!window.electronAPI) return;
    if (window.electronAPI.getBackupFolder) {
      window.electronAPI.getBackupFolder().then(f => { if (f) setBackupFolder(f); });
    }
    if (window.electronAPI.getTimetableFolder) {
      window.electronAPI.getTimetableFolder().then(f => { if (f) setTimetableFolder(f); });
    }
    if (window.electronAPI.onBackupFolderChanged) {
      const cleanup = window.electronAPI.onBackupFolderChanged(folder => {
        setBackupFolder(folder);
        notify("Backup folder updated");
      });
      return cleanup;
    }
  }, []);

  // ── Claude Personal Context ───────────────────────────────
  const [personalContextDraft, setPersonalContextDraft] = React.useState(claudePersonalContext || "");
  const [personalContextSaved, setPersonalContextSaved] = React.useState(false);
  const [emailStyleDraft, setEmailStyleDraft] = React.useState(emailStyle || "");
  const [emailStyleSaved, setEmailStyleSaved] = React.useState(false);

  const savePersonalContext = () => {
    setClaudePersonalContext(personalContextDraft);
    try { localStorage.setItem(STORAGE_KEYS.claudePersonalContext, personalContextDraft); } catch(err) {}
    setPersonalContextSaved(true);
    setTimeout(() => setPersonalContextSaved(false), 2000);
  };

  const saveEmailStyle = () => {
    setEmailStyle(emailStyleDraft);
    setEmailStyleSaved(true);
    setTimeout(() => setEmailStyleSaved(false), 2000);
  };

  // ── Memory modal ──────────────────────────────────────────
  const [memoryModalOpen, setMemoryModalOpen] = React.useState(false);
  const [memoryDrafts, setMemoryDrafts] = React.useState([]);

  const openMemoryModal = () => {
    setMemoryDrafts([...claudeMemory]);
    setMemoryModalOpen(true);
  };

  const saveMemoryModal = () => {
    const updated = memoryDrafts.filter(m => m && m.trim());
    setClaudeMemory(updated);
    try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(err) {}
    setMemoryModalOpen(false);
  };

  const TIMEZONES = [
    { value: "Australia/Melbourne", label: "Melbourne / Sydney (AEDT)" },
    { value: "Australia/Brisbane",  label: "Brisbane (AEST, no DST)" },
    { value: "Australia/Adelaide",  label: "Adelaide (ACDT)" },
    { value: "Australia/Perth",     label: "Perth (AWST)" },
    { value: "Australia/Darwin",    label: "Darwin (ACST)" },
    { value: "Australia/Hobart",    label: "Hobart (AEDT)" },
    { value: "Pacific/Auckland",    label: "Auckland (NZDT)" },
    { value: "Asia/Singapore",      label: "Singapore (SGT)" },
    { value: "Europe/London",       label: "London (GMT/BST)" },
    { value: "America/New_York",    label: "New York (ET)" },
    { value: "America/Los_Angeles", label: "Los Angeles (PT)" },
  ];

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

  // ── Fetch Term Dates ──────────────────────────────────────

  // ── Collapsible sections ──────────────────────────────────
  const [openSections, setOpenSections] = React.useState({ claude: false, context: false, categories: false, data: false, app: false, sounds: false, instruments: false, lessonrecords: false, datahealth: false, danger: false, messages: false, templates: false });
  const SECTIONS_ALL_CLOSED = { claude: false, context: false, categories: false, data: false, app: false, sounds: false, instruments: false, lessonrecords: false, datahealth: false, danger: false, messages: false, templates: false };

  // Todo categories state
  const [todoCats, setTodoCats] = React.useState(() => { try { return JSON.parse(localStorage.getItem("mt-todo-categories") || "[]"); } catch { return []; } });
  const [catNewName, setCatNewName] = React.useState("");
  const [catNewColor, setCatNewColor] = React.useState("#6B7280");
  const [catEditId, setCatEditId] = React.useState(null);
  const [catEditName, setCatEditName] = React.useState("");
  const [catEditColor, setCatEditColor] = React.useState("");
  const toggleSection = (key) => setOpenSections(prev => ({ ...SECTIONS_ALL_CLOSED, [key]: !prev[key] }));

  // ── Instrument colours ────────────────────────────────────
  const [customInstColors, setCustomInstColors] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem("mt-instrument-colors") || "{}"); } catch { return {}; }
  });

  const activeInstruments = React.useMemo(() => {
    const names = new Set();
    (students || []).filter(s => s.status === "active").forEach(s => {
      instrumentsFromEnrolments(s.id, enrolments).filter(i => !i.isGroup).forEach(i => { if (i.name) names.add(i.name); });
    });
    return [...names].sort();
  }, [students, enrolments]);

  const handleInstColorChange = (inst, color) => {
    const updated = { ...customInstColors, [inst]: color };
    setCustomInstColors(updated);
    setInstColorOverrides(updated);
  };

  const handleInstColorReset = (inst) => {
    const updated = { ...customInstColors };
    delete updated[inst];
    setCustomInstColors(updated);
    setInstColorOverrides(updated);
  };

  // ── Shared row styles ─────────────────────────────────────
  const rowStyle = {
    display: "flex", alignItems: "flex-start", justifyContent: "space-between",
    gap: 24, padding: "13px 18px", borderBottom: `1px solid ${colors.borderLight}`,
    background: colors.cardBg,
  };
  const rowLast = { ...rowStyle, borderBottom: "none" };
  const rowLabel = (text, sub) => (
    <div style={{ minWidth: 160, maxWidth: 220, flexShrink: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>{text}</div>
      {sub && <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
    </div>
  );

  // SectionBanner and SectionPanel are defined outside this component (above) to prevent
  // remounting on every re-render, which would cause the textarea to lose focus.

  return (
    <div>
      <PageTitle pageColor={PAGE_COLORS.settings || colors.sidebarActive}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        Settings
      </PageTitle>
      <div style={{ padding: "28px 36px", maxWidth: 680 }}>

        {/* ── CLAUDE AI ── */}
        <SectionBanner sectionKey="claude" label="Claude AI" icon={<Brain size={14} />} isOpen={openSections.claude} onToggle={toggleSection} colors={colors} />
        <SectionPanel isOpen={openSections.claude} colors={colors}>

          {/* Personal Context */}
          <div style={rowStyle}>
            {rowLabel("Personal context", "Included in every Claude request. Describe your teaching practice, preferences, and anything useful for Claude to know.")}
            <div style={{ flex: 1, maxWidth: 360 }}>
              <textarea
                value={personalContextDraft}
                onChange={e => setPersonalContextDraft(e.target.value)}
                placeholder={`I'm Matt, a self-employed music teacher based in Melbourne…`}
                rows={6}
                style={{
                  width: "100%", padding: "8px 10px",
                  border: `1.5px solid ${colors.inputBorder}`,
                  borderRadius: 8, fontSize: 12, fontFamily: "inherit",
                  color: colors.text, background: colors.cardBg,
                  outline: "none", resize: "vertical", lineHeight: 1.5, boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                <Btn
                  onClick={savePersonalContext}
                  variant={personalContextSaved ? "success" : "primary"}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                >
                  {personalContextSaved
                    ? <><Check size={13} /> Saved</>
                    : <><Save size={13} /> Save</>}
                </Btn>
              </div>
            </div>
          </div>

          {/* Email style */}
          <div style={rowStyle}>
            {rowLabel("Email style", "Paste 2–3 example emails or describe your style. Claude uses this when drafting triage replies.")}
            <div style={{ flex: 1, maxWidth: 360 }}>
              <textarea
                value={emailStyleDraft}
                onChange={e => setEmailStyleDraft(e.target.value)}
                placeholder={`e.g. Hey [name], just checking in re [student]'s lessons — happy to shift to Thursdays if that suits. Let me know! Cheers, Matt`}
                rows={6}
                style={{
                  width: "100%", padding: "8px 10px",
                  border: `1.5px solid ${colors.inputBorder}`,
                  borderRadius: 8, fontSize: 12, fontFamily: "inherit",
                  color: colors.text, background: colors.cardBg,
                  outline: "none", resize: "vertical", lineHeight: 1.5, boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                <Btn
                  onClick={saveEmailStyle}
                  variant={emailStyleSaved ? "success" : "primary"}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                >
                  {emailStyleSaved
                    ? <><Check size={13} /> Saved</>
                    : <><Save size={13} /> Save</>}
                </Btn>
              </div>
            </div>
          </div>

          {/* Memory */}
          <div style={rowStyle}>
            {rowLabel("Memory", "Facts Claude remembers across all sessions.")}
            <div style={{ flex: 1, maxWidth: 360, display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Manage button with count badge */}
              <div>
                <Btn
                  variant="secondary"
                  onClick={openMemoryModal}
                  style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
                >
                  <Brain size={13} />
                  Manage memories
                  {claudeMemory.length > 0 && (
                    <span style={{
                      background: colors.accent, color: "#fff",
                      borderRadius: 99, padding: "1px 7px",
                      fontSize: 11, fontWeight: 700, lineHeight: 1.6,
                    }}>
                      {claudeMemory.length}
                    </span>
                  )}
                </Btn>
              </div>
              {/* Quick-add input */}
              <AddMemoryInput onAdd={mem => {
                const updated = [...claudeMemory, mem];
                setClaudeMemory(updated);
                try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(err) {}
              }} />
            </div>
          </div>

          {/* Claude Budget */}
          <div style={rowLast}>
            {rowLabel("Monthly budget", "Reference point for the sidebar usage bar. Estimated from token counts.")}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 13, color: colors.textLight }}>$</span>
              <input type="number" min="1" max="500" step="1" defaultValue={claudeBudget.toFixed(0)}
                style={{ width: 70, padding: "7px 10px", border: `1.5px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none" }}
                onBlur={e => { const val = Math.max(1, parseFloat(e.target.value) || 10); setClaudeBudget(val); try { localStorage.setItem(STORAGE_KEYS.claudeBudget, String(val)); } catch(err) {} }}
                onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
              />
              <span style={{ fontSize: 12, color: colors.textLight }}>/ mo</span>
              {(() => {
                const monthKey = new Date().toISOString().slice(0, 7);
                const spent = tokenUsage[monthKey]?.costUSD || 0;
                const pct = claudeBudget > 0 ? Math.min(1, spent / claudeBudget) : 0;
                return (
                  <div style={{ width: 100, display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ height: 5, borderRadius: 3, background: colors.border, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${(1 - pct) * 100}%`, background: pct > 0.85 ? colors.danger : colors.accent, borderRadius: 3, transition: "width 0.4s ease" }} />
                    </div>
                    <div style={{ fontSize: 10, color: colors.textMuted }}>${spent.toFixed(2)} spent</div>
                  </div>
                );
              })()}
            </div>
          </div>
        </SectionPanel>

        {/* ── DATA & BACKUP ── */}
        <SectionBanner sectionKey="data" label="Data & Backup" icon={<Save size={14} />} isOpen={openSections.data} onToggle={toggleSection} colors={colors} />
        <SectionPanel isOpen={openSections.data} colors={colors}>
          {/* Last backup */}
          <div style={rowStyle}>
            {rowLabel("Auto-backup")}
            <div style={{ fontSize: 13, color: colors.textMuted, display: "inline-flex", alignItems: "center", gap: 5, paddingTop: 1 }}>
              {localStorage.getItem(STORAGE_KEYS.lastScheduledBackup)
                ? <><Clock size={12} /> Last run: {new Date(localStorage.getItem(STORAGE_KEYS.lastScheduledBackup)).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</>
                : <><AlertTriangle size={12} style={{ color: colors.amber }} /> No auto-backup yet — runs every 6 hours</>}
            </div>
          </div>

          {/* Backup folder */}
          {window.electronAPI && (
            <div style={rowStyle}>
              {rowLabel("Backup folder", "Where auto-backups are saved")}
              <div style={{ fontSize: 13, color: colors.textMuted, display: "flex", alignItems: "center", gap: 6, paddingTop: 1 }}>
                <Folder size={12} />
                {backupFolder ? (
                  <>
                    <span style={{ cursor: "pointer", textDecoration: "underline", color: colors.text }}
                      onClick={() => window.electronAPI.revealInFinder(backupFolder)}>
                      {backupFolder.split("/").pop() || backupFolder}
                    </span>
                    <button onClick={async () => { const p = await window.electronAPI.selectBackupFolder(); if (p) { setBackupFolder(p); notify("Backup folder updated"); } }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: colors.accent, fontSize: 12, fontFamily: "inherit", textDecoration: "underline", padding: 0 }}>Change</button>
                  </>
                ) : (
                  <button onClick={async () => { const p = await window.electronAPI.selectBackupFolder(); if (p) { setBackupFolder(p); notify("Backup folder set"); } }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: colors.accent, fontSize: 12, fontFamily: "inherit", textDecoration: "underline", padding: 0 }}>Choose folder…</button>
                )}
              </div>
            </div>
          )}

          {/* Timetable folder */}
          {window.electronAPI && (
            <div style={rowStyle}>
              {rowLabel("Timetable folder", "Where exported timetables are saved")}
              <div style={{ fontSize: 13, color: colors.textMuted, display: "flex", alignItems: "center", gap: 6, paddingTop: 1 }}>
                <Folder size={12} />
                {timetableFolder ? (
                  <>
                    <span style={{ cursor: "pointer", textDecoration: "underline", color: colors.text }}
                      onClick={() => window.electronAPI.revealInFinder(timetableFolder)}>
                      {timetableFolder.split("/").pop() || timetableFolder}
                    </span>
                    <button onClick={async () => { const p = await window.electronAPI.selectTimetableFolder(); if (p) { setTimetableFolder(p); notify("Timetable folder updated"); } }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: colors.accent, fontSize: 12, fontFamily: "inherit", textDecoration: "underline", padding: 0 }}>Change</button>
                  </>
                ) : (
                  <button onClick={async () => { const p = await window.electronAPI.selectTimetableFolder(); if (p) { setTimetableFolder(p); notify("Timetable folder set"); } }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: colors.accent, fontSize: 12, fontFamily: "inherit", textDecoration: "underline", padding: 0 }}>Choose folder…</button>
                )}
              </div>
            </div>
          )}

          {/* Backup / Restore buttons */}
          <div style={rowLast}>
            {rowLabel("Manual backup", "Save a snapshot of all app data")}
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={async () => { const ok = await onBackup(); if (ok) { setBackupDone(true); setTimeout(() => setBackupDone(false), 2500); } }}
                variant={backupDone ? "success" : "primary"}
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                {backupDone ? <><Check size={13} /> Saved</> : <><Save size={13} /> Backup now</>}
              </Btn>
              <Btn variant="secondary" onClick={() => window.electronAPI ? handleRestoreFile() : fileRef.current?.click()}>Restore</Btn>
              {!window.electronAPI && <input ref={fileRef} type="file" accept=".json" onChange={handleRestoreFile} style={{ display: "none" }} />}
            </div>
          </div>
        </SectionPanel>

        {/* ── APP ── */}
        <SectionBanner sectionKey="app" label="App" icon={<Key size={14} />} isOpen={openSections.app} onToggle={toggleSection} colors={colors} />
        <SectionPanel isOpen={openSections.app} colors={colors}>

          {/* API Key */}
          <div style={rowStyle}>
            {rowLabel("Anthropic API Key", <>Required for AI features. Get yours at <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{ color: colors.accent }}>console.anthropic.com</a>.</>)}
            <div style={{ display: "flex", gap: 8, flex: 1, maxWidth: 320 }}>
              <input type="password" value={apiKeyDraft} onChange={e => setApiKeyDraft(e.target.value)}
                placeholder="sk-ant-..."
                style={{ flex: 1, padding: "7px 10px", border: `1.5px solid ${apiKeySaved ? colors.success : colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", boxSizing: "border-box" }}
                onKeyDown={e => { if (e.key === "Enter") { setApiKey(apiKeyDraft); try { localStorage.setItem("mt-api-key", apiKeyDraft); } catch(err) {} setApiKeySaved(true); setTimeout(() => setApiKeySaved(false), 2000); } }}
              />
              <Btn onClick={() => { setApiKey(apiKeyDraft); try { localStorage.setItem("mt-api-key", apiKeyDraft); } catch(err) {} setApiKeySaved(true); setTimeout(() => setApiKeySaved(false), 2000); }}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                {apiKeySaved ? <><Check size={13} /> Saved</> : "Save"}
              </Btn>
            </div>
          </div>

          {/* Gmail */}
          {window.electronAPI?.gmailGetStatus && (
            <div style={rowStyle}>
              {rowLabel("Gmail", "Connect your Gmail account to send emails from the app.")}
              <div style={{ flex: 1, maxWidth: 360 }}>
                <GmailSettingsCard notify={notify} cardStyle={{ background: "transparent", border: "none", padding: 0, marginBottom: 0 }} gmailStatus={gmailStatus} setGmailStatus={setGmailStatus} />
              </div>
            </div>
          )}

          {/* Dark Mode */}
          <div style={rowStyle}>
            {rowLabel("Dark mode", "Switch between light and dark colour scheme. Hotkey: Cmd+Shift+D.")}
            <button
              onClick={toggleDarkMode}
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
                cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
                border: `1.5px solid ${darkMode ? colors.accent : colors.border}`,
                background: darkMode ? colors.accentLight : colors.bg,
                color: darkMode ? colors.accent : colors.textLight,
              }}
            >
              <Moon size={14} />
              {darkMode ? "Dark mode on" : "Dark mode off"}
            </button>
          </div>

          {/* Timezone */}
          <div style={rowStyle}>
            {rowLabel("Timezone", "Used by the Calendar and auto-tally. Defaults to Melbourne.")}
            <div style={{ flex: 1, maxWidth: 280 }}>
              <select value={timezone} onChange={e => saveTimezone(e.target.value)}
                style={{ width: "100%", padding: "7px 10px", border: `1.5px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                {TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
              </select>
            </div>
          </div>

          {/* App version */}
          <div style={rowLast}>
            {rowLabel("Version", updateInfo?.ready ? "Update ready to install" : updateInfo?.available ? "Downloading update…" : noUpdateFlash ? "Up to date" : "Music Timetabling")}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>{APP_VERSION}</span>
              {updateProgress !== null && (
                <div style={{ width: 80, height: 4, background: colors.border, borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: updateProgress + "%", background: colors.accent, borderRadius: 2, transition: "width 0.3s" }} />
                </div>
              )}
              <Btn variant={updateInfo?.available ? "primary" : "secondary"}
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                onClick={() => { if (updateInfo?.ready && window.electronAPI?.installUpdate) { window.electronAPI.installUpdate(); return; } if (window.electronAPI?.checkForUpdates) window.electronAPI.checkForUpdates(); }}>
                <RefreshCw size={13} />
                {updateInfo?.ready ? "Restart & install" : updateInfo?.available ? "Downloading…" : "Check for updates"}
              </Btn>
            </div>
          </div>
        </SectionPanel>

        {/* ── CLAUDE CONTEXT TRIGGERS ── */}
        <SectionBanner sectionKey="context" label="Claude Context Triggers" icon={<Filter size={14} />} isOpen={openSections.context} onToggle={toggleSection} colors={colors} />
        <SectionPanel isOpen={openSections.context} colors={colors}>
          <ContextTriggersPanel
            contextTriggers={contextTriggers}
            setContextTriggers={setContextTriggers}
            colors={colors}
            rowStyle={rowStyle}
            rowLast={rowLast}
            rowLabel={rowLabel}
            notify={notify}
          />
        </SectionPanel>

        {/* ── TODO CATEGORIES ── */}
        <SectionBanner sectionKey="categories" label="To Do Categories" icon={<TagIcon size={14} />} isOpen={openSections.categories} onToggle={toggleSection} colors={colors} />
        <SectionPanel isOpen={openSections.categories} colors={colors}>
          {(() => {
            const saveCats = (updated) => { setTodoCats(updated); try { localStorage.setItem("mt-todo-categories", JSON.stringify(updated)); } catch {} window.dispatchEvent(new Event("mt-todo-categories-updated")); };
            const addCat = () => { const n = catNewName.trim(); if (!n) return; saveCats([...todoCats, { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), name: n, color: catNewColor }]); setCatNewName(""); setCatNewColor("#6B7280"); };
            const deleteCat = (id) => { saveCats(todoCats.filter(c => c.id !== id)); };
            const saveEdit = () => { if (!catEditName.trim()) return; saveCats(todoCats.map(c => c.id === catEditId ? { ...c, name: catEditName.trim(), color: catEditColor } : c)); setCatEditId(null); };
            return (
              <div>
                <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 12 }}>
                  Create categories for your to-do items. Right-click any todo item to assign a category.
                </div>
                {todoCats.map(cat => (
                  <div key={cat.id} style={rowStyle}>
                    {catEditId === cat.id ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
                        <input type="color" value={catEditColor} onChange={e => setCatEditColor(e.target.value)} style={{ width: 28, height: 28, border: "none", borderRadius: 6, cursor: "pointer", padding: 0 }} />
                        <input value={catEditName} onChange={e => setCatEditName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setCatEditId(null); }}
                          style={{ flex: 1, padding: "6px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: colors.text, background: colors.cardBg, outline: "none" }} autoFocus />
                        <button onClick={saveEdit} style={{ background: colors.accent, color: "#fff", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Save</button>
                        <button onClick={() => setCatEditId(null)} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted }}><X size={14} /></button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
                        <span style={{ width: 14, height: 14, borderRadius: 4, background: cat.color, flexShrink: 0 }} />
                        <span style={{ fontSize: 13, fontWeight: 500, color: colors.text, flex: 1 }}>{cat.name}</span>
                        <button onClick={() => { setCatEditId(cat.id); setCatEditName(cat.name); setCatEditColor(cat.color); }}
                          style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "flex", alignItems: "center" }} title="Edit"><Sparkles size={13} /></button>
                        <button onClick={() => deleteCat(cat.id)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "flex", alignItems: "center" }} title="Delete"><Trash2 size={13} /></button>
                      </div>
                    )}
                  </div>
                ))}
                <div style={rowLast}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
                    <input type="color" value={catNewColor} onChange={e => setCatNewColor(e.target.value)} style={{ width: 28, height: 28, border: "none", borderRadius: 6, cursor: "pointer", padding: 0 }} />
                    <input value={catNewName} onChange={e => setCatNewName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addCat(); }}
                      placeholder="New category name…"
                      style={{ flex: 1, padding: "6px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: colors.text, background: colors.cardBg, outline: "none" }} />
                    <button onClick={addCat}
                      style={{ background: colors.accent, color: "#fff", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
                      <Plus size={13} /> Add
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}
        </SectionPanel>

        {/* ── SOUNDS ── */}
        <SectionBanner sectionKey="sounds" label="Sounds" icon={<Volume2 size={14} />} isOpen={openSections.sounds} onToggle={toggleSection} colors={colors} />
        <SectionPanel isOpen={openSections.sounds} colors={colors}>
          {[
            { key: "emailSend",      label: "Email sent",              sub: "Play a sound when an email is sent." },
            { key: "emailReceive",   label: "Email received",           sub: "Play a sound when a new email arrives." },
            { key: "messageSend",    label: "Message sent",             sub: "Play a sound when you send a staff message." },
            { key: "messageReceive", label: "Message received",         sub: "Play a sound when a staff message arrives." },
            { key: "drag",           label: "Lesson drag & drop",       sub: "Play a click when a lesson card is placed." },
            { key: "claude",         label: "Claude reply",             sub: "Play a chime when Claude finishes a response." },
            { key: "tally",          label: "Tally entry",              sub: "Play a sound when a tally entry is recorded." },
            { key: "backup",         label: "Backup saved",             sub: "Play a sound when a backup completes." },
            { key: "notifications",  label: "Notifications & alerts",   sub: "Play sounds for toasts and queue completion." },
          ].map(({ key, label, sub }, i, arr) => {
            const on = soundSettings?.[key] ?? true;
            return (
              <div key={key} style={i === arr.length - 1 ? rowLast : rowStyle}>
                {rowLabel(label, sub)}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    onClick={() => onPreviewSound?.(key)}
                    title="Preview this sound"
                    style={{
                      width: 32, height: 32, borderRadius: 8, border: `1.5px solid ${colors.border}`,
                      background: colors.bg, color: colors.textMuted, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      transition: "all 0.15s", flexShrink: 0,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = colors.accent; e.currentTarget.style.color = colors.accent; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textMuted; }}
                  >
                    <Volume2 size={13} />
                  </button>
                  <button
                    onClick={() => setSoundSettings(prev => ({ ...prev, [key]: !prev[key] }))}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 8,
                      padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
                      cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
                      border: `1.5px solid ${on ? colors.accent : colors.border}`,
                      background: on ? colors.accentLight : colors.bg,
                      color: on ? colors.accent : colors.textLight,
                    }}
                  >{on ? "On" : "Off"}</button>
                </div>
              </div>
            );
          })}
        </SectionPanel>

        {/* ── MESSAGES ── */}
        <SectionBanner sectionKey="messages" label="Messages" icon={<MessageSquare size={14} />} isOpen={openSections.messages} onToggle={toggleSection} colors={colors} />
        <SectionPanel isOpen={openSections.messages} colors={colors}>

          {/* Display name */}
          <div style={rowStyle}>
            {rowLabel("Your display name", "How your name appears in staff message threads.")}
            <div style={{ flex: 1, maxWidth: 280 }}>
              <input
                value={messengerDisplayName ?? ""}
                onChange={e => setMessengerDisplayName?.(e.target.value)}
                placeholder="e.g. Matt"
                style={{
                  width: "100%", padding: "7px 10px", boxSizing: "border-box",
                  border: `1.5px solid ${colors.inputBorder}`, borderRadius: 8,
                  fontSize: 13, fontFamily: "inherit",
                  color: colors.text, background: colors.inputBg, outline: "none",
                }}
                onFocus={e => e.target.style.borderColor = colors.accent}
                onBlur={e => e.target.style.borderColor = colors.inputBorder}
              />
            </div>
          </div>

          {/* Bubble colour */}
          <div style={rowLast}>
            {rowLabel("Your bubble colour", "The colour of your message bubbles in staff threads.")}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {/* Live preview bubble */}
              <div style={{
                padding: "6px 12px", borderRadius: "12px 12px 4px 12px",
                background: messengerBubbleColour || "#C47A6A",
                color: "#fff", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap",
              }}>
                {messengerDisplayName?.trim() || "Preview"}
              </div>
              {/* Hex label */}
              <span style={{ fontSize: 11, color: colors.textMuted, fontVariantNumeric: "tabular-nums", minWidth: 52 }}>
                {(messengerBubbleColour || "#C47A6A").toUpperCase()}
              </span>
              {/* Colour picker */}
              <input
                type="color"
                value={messengerBubbleColour || "#C47A6A"}
                onChange={e => setMessengerBubbleColour?.(e.target.value)}
                title="Pick your bubble colour"
                style={{ width: 32, height: 28, border: `1.5px solid ${colors.border}`, borderRadius: 6, cursor: "pointer", padding: 2, background: colors.cardBg }}
              />
              {/* Reset to default */}
              <button
                onClick={() => setMessengerBubbleColour?.("#C47A6A")}
                title="Reset to default"
                style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "inline-flex", alignItems: "center", padding: 4, borderRadius: 4 }}
                onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}
              >
                <RefreshCw size={12} />
              </button>
            </div>
          </div>

        </SectionPanel>

        {/* ── EMAIL TEMPLATES ── */}
        {/* Session 95: templates moved here from the Contacts page. Wrapping
            the editor in a padded div so it aligns with other section panels
            (the editor itself has no outer padding of its own). */}
        <SectionBanner sectionKey="templates" label="Email Templates" icon={<FileText size={14} />} isOpen={openSections.templates} onToggle={toggleSection} colors={colors} />
        <SectionPanel isOpen={openSections.templates} colors={colors}>
          <div style={{ padding: 18, background: colors.cardBg }}>
            <EmailTemplatesEditor notify={notify} schools={schools} resources={resources} documents={documents} />
          </div>
        </SectionPanel>

        {/* ── INSTRUMENT COLOURS ── */}
        <SectionBanner sectionKey="instruments" label="Instrument Colours" icon={<Palette size={14} />} isOpen={openSections.instruments} onToggle={toggleSection} colors={colors} />
        <SectionPanel isOpen={openSections.instruments} colors={colors}>
          {activeInstruments.length === 0 ? (
            <div style={{ padding: "14px 18px", fontSize: 13, color: colors.textMuted, fontStyle: "italic" }}>
              No active students enrolled yet — instrument rows appear here once students are active.
            </div>
          ) : (
            <div>
              <div style={{ padding: "10px 18px 6px", fontSize: 11, color: colors.textMuted, lineHeight: 1.5 }}>
                Customise the colour used for lesson cards. Only instruments with active enrolled students are shown. Changes apply immediately when you next view the timetable.
              </div>
              {activeInstruments.map((inst, i) => {
                const defaultColor = instruments_colors[inst] || instruments_colors.default || "#6B7280";
                const customColor = customInstColors[inst];
                const displayColor = customColor || defaultColor;
                const isCustomised = !!customColor;
                const isLast = i === activeInstruments.length - 1;
                return (
                  <div key={inst} style={isLast ? rowLast : rowStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
                      {/* Live colour swatch */}
                      <span style={{
                        width: 14, height: 14, borderRadius: 4,
                        background: displayColor, flexShrink: 0,
                        boxShadow: "0 0 0 1px rgba(0,0,0,0.12)",
                      }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: colors.text, flex: 1 }}>{inst}</span>
                      {isCustomised && (
                        <span style={{ fontSize: 11, color: colors.textMuted }}>custom</span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      {/* Hex label */}
                      <span style={{ fontSize: 11, color: colors.textMuted, fontVariantNumeric: "tabular-nums", minWidth: 52 }}>
                        {displayColor.toUpperCase()}
                      </span>
                      {/* Colour picker */}
                      <input
                        type="color"
                        value={displayColor}
                        onChange={e => handleInstColorChange(inst, e.target.value)}
                        title={`Pick colour for ${inst}`}
                        style={{ width: 32, height: 28, border: `1.5px solid ${colors.border}`, borderRadius: 6, cursor: "pointer", padding: 2, background: colors.cardBg }}
                      />
                      {/* Reset button — only shown when customised */}
                      {isCustomised ? (
                        <button
                          onClick={() => handleInstColorReset(inst)}
                          title="Reset to default colour"
                          style={{
                            background: "none", border: "none", cursor: "pointer",
                            color: colors.textMuted, display: "inline-flex", alignItems: "center",
                            padding: 4, borderRadius: 4,
                          }}
                          onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                          onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}
                        >
                          <RefreshCw size={12} />
                        </button>
                      ) : (
                        /* Spacer so rows stay aligned */
                        <span style={{ width: 20, flexShrink: 0 }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionPanel>

        {/* ── LESSON RECORDS ── */}
        <SectionBanner sectionKey="lessonrecords" label="Lesson Records" icon={<Clock size={14} />} isOpen={openSections.lessonrecords} onToggle={toggleSection} colors={colors} />
        <SectionPanel isOpen={openSections.lessonrecords} colors={colors}>
          <div style={rowLast}>
            {rowLabel("Remembered reasons", "Reasons saved when logging missed lessons. Shown as suggestions in the missed lesson modal.")}
            <div style={{ flex: 1, maxWidth: 360 }}>
              {rememberedReasons.length === 0 ? (
                <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "4px 0" }}>
                  No reasons saved yet — they appear here when you log missed lessons.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {rememberedReasons.map((r, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ flex: 1, fontSize: 13, color: colors.text, padding: "5px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, background: colors.bg }}>{r}</span>
                      <button
                        onClick={() => saveRememberedReasons(rememberedReasons.filter((_, idx) => idx !== i))}
                        title="Remove"
                        style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "inline-flex", alignItems: "center", padding: 4, borderRadius: 4, flexShrink: 0 }}
                        onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                        onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                    <button
                      onClick={() => saveRememberedReasons([])}
                      style={{ fontSize: 12, color: colors.danger, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "2px 0" }}
                      onMouseEnter={e => e.currentTarget.style.opacity = "0.7"}
                      onMouseLeave={e => e.currentTarget.style.opacity = "1"}
                    >
                      Clear all
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </SectionPanel>

        {/* ── DATA HEALTH (Session 97.1) ── */}
        {/* Shows the live list of orphaned lessons surfaced by the reconciler
            in App.js. "Orphaned" means the lesson's student/teacher/instrument
            linkage is broken — usually because a student or teacher was
            deleted, or an instrument was renamed/removed on the student
            record without updating the timetable. Each row offers two
            resolutions: jump to the student record (if they still exist) to
            fix the linkage, or delete the lesson outright. */}
        <SectionBanner sectionKey="datahealth" label={`Data Health${orphanedLessons.length > 0 ? ` — ${orphanedLessons.length} orphaned` : ""}`} icon={<AlertTriangle size={14} />} isOpen={openSections.datahealth} onToggle={toggleSection} colors={colors} danger={orphanedLessons.length > 0} />
        <SectionPanel isOpen={openSections.datahealth} colors={colors}>
          {orphanedLessons.length === 0 ? (
            <div style={{ ...rowLast, display: "block" }}>
              <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "4px 0" }}>
                No orphaned lessons. Your timetable data is clean.
              </div>
            </div>
          ) : (
            <div style={{ ...rowLast, display: "block" }}>
              <div style={{ fontSize: 12, color: colors.textLight, marginBottom: 12, lineHeight: 1.5 }}>
                These lessons reference a student, teacher, or instrument that no longer exists or isn't linked correctly. Either open the student record and fix the linkage, or delete the lesson if it's no longer needed.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {orphanedLessons.map((orphan, idx) => {
                  const studentExists = orphan.studentId && students.find(s => s.id === orphan.studentId);
                  const whereLabel = orphan.where === "master"
                    ? "Master timetable"
                    : (() => {
                        const [wk, sid] = (orphan.where || "").split("|");
                        const school = schools.find(s => s.id === sid);
                        return `Weekly ${wk || "?"}${school ? ` · ${school.name}` : ""}`;
                      })();
                  return (
                    <div key={`${orphan.where}|${orphan.lessonId || idx}`}
                      style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 12px", borderRadius: 8, background: colors.bg, border: `1px solid ${colors.border}` }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: colors.text }}>
                            {orphan.studentName || "(no name)"}
                          </span>
                          <span style={{ fontSize: 11, color: colors.textMuted }}>·</span>
                          <span style={{ fontSize: 12, color: colors.textLight }}>{orphan.instrument || "(no instrument)"}</span>
                          <span style={{ fontSize: 11, color: colors.textMuted }}>·</span>
                          <span style={{ fontSize: 12, color: colors.textLight }}>{orphan.day}{orphan.start ? ` ${orphan.start}` : ""}</span>
                        </div>
                        <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 3 }}>
                          {whereLabel}
                        </div>
                        <div style={{ fontSize: 12, color: colors.danger, fontWeight: 600 }}>
                          {orphan.reason}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        {studentExists && onGoToOrphanStudent && (
                          <button onClick={() => onGoToOrphanStudent(orphan.studentId)}
                            title="Open student record to fix linkage"
                            style={{ padding: "6px 12px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, color: colors.textLight, fontSize: 12, fontFamily: "inherit", fontWeight: 600, cursor: "pointer" }}>
                            Go to student
                          </button>
                        )}
                        {onDeleteOrphanedLesson && (
                          <button onClick={() => { if (window.confirm(`Delete this orphaned lesson?\n\n${orphan.studentName || "(no name)"} · ${orphan.instrument} · ${orphan.day}${orphan.start ? ` ${orphan.start}` : ""}\n\nThis removes the lesson from ${orphan.where === "master" ? "the master timetable" : "that weekly timetable"}.`)) onDeleteOrphanedLesson(orphan); }}
                            title="Delete this lesson"
                            style={{ padding: "6px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, color: colors.danger, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontFamily: "inherit", fontWeight: 600 }}>
                            <Trash2 size={13} /> Delete
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </SectionPanel>

        {/* ── DANGER ZONE ── */}
        <SectionBanner sectionKey="danger" label="Danger Zone" icon={<AlertTriangle size={14} />} danger isOpen={openSections.danger} onToggle={toggleSection} colors={colors} />
        <SectionPanel isOpen={openSections.danger} danger colors={colors}>
          <div style={rowLast}>
            {rowLabel("Clear all data", "Permanently removes all schools, students, timetable, and settings. Cannot be undone.")}
            {confirmClear ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                <span style={{ fontSize: 12, color: colors.danger, fontWeight: 600, whiteSpace: "nowrap" }}>Are you sure?</span>
                <Btn variant="danger" onClick={handleClearAll}>Yes, clear all</Btn>
                <Btn variant="secondary" onClick={() => setConfirmClear(false)}>Cancel</Btn>
              </div>
            ) : (
              <Btn variant="danger" onClick={() => setConfirmClear(true)} style={{ flexShrink: 0 }}>Clear all data</Btn>
            )}
          </div>
        </SectionPanel>

      </div>

      {/* ── MEMORY MODAL ── */}
      {memoryModalOpen && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={e => { if (e.target === e.currentTarget) setMemoryModalOpen(false); }}
        >
          <div style={{
            background: colors.cardBg,
            border: `1px solid ${colors.border}`,
            borderRadius: 14,
            padding: 24,
            width: 520,
            maxWidth: "90vw",
            maxHeight: "72vh",
            display: "flex",
            flexDirection: "column",
            gap: 0,
            boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
          }}>

            {/* Modal header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, display: "flex", alignItems: "center", gap: 8 }}>
                <Brain size={15} style={{ color: colors.accent }} />
                Claude Memory
                <span style={{ fontSize: 12, color: colors.textMuted, fontWeight: 400 }}>
                  — {memoryDrafts.filter(m => m.trim()).length} item{memoryDrafts.filter(m => m.trim()).length !== 1 ? "s" : ""}
                </span>
              </div>
              <button
                onClick={() => setMemoryModalOpen(false)}
                style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "inline-flex", alignItems: "center", borderRadius: 6, padding: 4 }}
                onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}
              >
                <X size={16} />
              </button>
            </div>

            {/* Memory list (scrollable) */}
            <div style={{
              overflowY: "auto", flex: 1,
              display: "flex", flexDirection: "column", gap: 6,
              marginBottom: 12, paddingRight: 2,
              minHeight: 60,
            }}>
              {memoryDrafts.length === 0 && (
                <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "16px 0", textAlign: "center" }}>
                  No memories saved yet. Add one below.
                </div>
              )}
              {memoryDrafts.map((m, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Sparkles size={11} style={{ color: colors.accent, flexShrink: 0 }} />
                  <input
                    value={m}
                    onChange={e => {
                      const updated = [...memoryDrafts];
                      updated[i] = e.target.value;
                      setMemoryDrafts(updated);
                    }}
                    style={{
                      flex: 1, padding: "6px 10px",
                      border: `1px solid ${colors.inputBorder}`,
                      borderRadius: 7, fontSize: 13, fontFamily: "inherit",
                      color: colors.text, background: colors.cardBg, outline: "none",
                    }}
                  />
                  <button
                    onClick={() => setMemoryDrafts(prev => prev.filter((_, idx) => idx !== i))}
                    title="Delete this memory"
                    style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "inline-flex", alignItems: "center", padding: 4, borderRadius: 4, flexShrink: 0 }}
                    onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                    onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            {/* Quick-add inside modal */}
            <div style={{ borderTop: `1px solid ${colors.borderLight}`, paddingTop: 12, marginBottom: 14 }}>
              <AddMemoryInput onAdd={mem => setMemoryDrafts(prev => [...prev, mem])} />
            </div>

            {/* Footer */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <Btn
                variant="danger"
                onClick={() => setMemoryDrafts([])}
                disabled={memoryDrafts.length === 0}
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                <Trash2 size={13} /> Clear all
              </Btn>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="secondary" onClick={() => setMemoryModalOpen(false)}>Cancel</Btn>
                <Btn
                  variant="primary"
                  onClick={saveMemoryModal}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                >
                  <Check size={13} /> Save changes
                </Btn>
              </div>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
