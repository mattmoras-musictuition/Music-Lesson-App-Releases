// ============================================================
// CONTACTSMANAGER — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo } from "react";
import { Mail, Phone, StickyNote, Pencil, Trash2, Check, X, Users, Building2, Download, Bot } from "lucide-react";
import { STORAGE_KEYS } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { uid, openCompose, openGmailSequential, getParentEmails } from "../utils/helpers";
import { instrumentsFromEnrolments } from "../utils/enrolmentsDB";
// Session 95: EmailTemplatesEditor is no longer imported here — templates
// moved to Settings. AiEmailRulesEditor and AiImportContacts still render
// inline on the Contacts page.
import { AiEmailRulesEditor, AiImportContacts } from "./ContactsEditors";
import { Card, PageTitle, NavButtons, Btn, Input, Tag, EmptyState, PAGE_COLORS } from "../components/ui/SharedUI";

const CONTACT_ROLES = ["Principal", "Assistant Principal", "Office Manager", "Business Manager", "Classroom Teacher", "Specialist Teacher", "Other"];
const CLASS_ROLES = ["Classroom Teacher", "Specialist Teacher"];

export function ContactsManager({ contacts, setContacts, schools, students, enrolments, setStudents, teachers, specialists, notify, resetKey, viewState, setViewState, onViewStudent, newContactPrefill, onClearNewContactPrefill, goBack, goForward, historyCursor, pageHistory }) {
  const { colors, darkMode } = useTheme();
  const ROW_HOVER_BG = darkMode ? colors.sidebarHover : "#EDF2FA";
  const [section, setSection] = useState("parents"); // "parents" | "school"

  // ── School contacts state ──────────────────────────────────────
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [expandedNotes, setExpandedNotes] = useState(new Set());
  const [expandedPhone, setExpandedPhone] = useState(new Set());
  const [selected, setSelected] = useState(new Set());
  const [lastChecked, setLastChecked] = useState(null);
  const [filterSchool, setFilterSchool] = useState("");
  const [filterRole, setFilterRole] = useState("");
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState("name");
  const [sortDir, setSortDir] = useState("asc");
  const [tooltip, setTooltip] = useState(null);
  const [hoveredRow, setHoveredRow] = useState(null);
  const anyExpandedRef = useRef(false);

  // ── Parent contacts state ──────────────────────────────────────
  const [pSearch, setPSearch] = useState("");
  const [pFilterSchool, setPFilterSchool] = useState("");
  const [pFilterTeacher, setPFilterTeacher] = useState("");
  const [pFilterInstrument, setPFilterInstrument] = useState("");
  const [pSortCol, setPSortCol] = useState("name");
  const [pSortDir, setPSortDir] = useState("asc");
  const [pSelected, setPSelected] = useState(new Set());
  const [pLastChecked, setPLastChecked] = useState(null);
  const [pEditingKey, setPEditingKey] = useState(null); // "studentId|parentIdx"
  const [pEditForm, setPEditForm] = useState(null);
  const [pExpandedPhone, setPExpandedPhone] = useState(new Set());
  const [pExpandedNotes, setPExpandedNotes] = useState(new Set());
  const [pExpandedCC, setPExpandedCC] = useState(new Set());
  const [hoveredPRow, setHoveredPRow] = useState(null);
  const pAnyExpandedRef = useRef(false);

  useEffect(() => { setEditingId(null); setEditForm(null); setSelected(new Set()); setPEditingKey(null); setPEditForm(null); setPSelected(new Set()); }, [resetKey]);

  // Pre-fill a new school contact row from email context menu "Add School Contact"
  useEffect(() => {
    if (!newContactPrefill) return;
    setSection("school");
    const id = uid();
    const blank = { id, name: newContactPrefill.name || "", schoolId: "", role: "", roleOther: "", className: "", email: newContactPrefill.email || "", phone: "", notes: "", _isNew: true };
    setContacts(prev => [blank, ...prev]);
    setEditingId(id);
    setEditForm({ ...blank });
    if (onClearNewContactPrefill) onClearNewContactPrefill();
  }, [newContactPrefill]);

  // ── Derived parent rows ────────────────────────────────────────
  const parentRows = useMemo(() => {
    const activeStudents = students.filter(s => s.status === "active" || s.status === "pending" || s.status === "trial");
    const map = {};
    for (const st of activeStudents) {
      for (let pi = 0; pi < (st.parents || []).length; pi++) {
        const p = st.parents[pi];
        if (!p || (!p.name && !p.email)) continue;
        const dedupKey = (p.email || "").trim().toLowerCase() || (p.name || "").trim().toLowerCase();
        if (!dedupKey) continue;
        if (!map[dedupKey]) {
          map[dedupKey] = { ...p, _studentIds: [], _studentNames: [], _schoolIds: [], _instrumentNames: [], _teacherIds: [] };
        }
        if (!map[dedupKey]._studentIds.includes(st.id)) {
          map[dedupKey]._studentIds.push(st.id);
          map[dedupKey]._studentNames.push(st.name);
          map[dedupKey]._schoolIds.push(st.schoolId);
        }
        instrumentsFromEnrolments(st.id, enrolments).forEach(inst => { if (inst.name && !map[dedupKey]._instrumentNames.includes(inst.name)) map[dedupKey]._instrumentNames.push(inst.name); });
        instrumentsFromEnrolments(st.id, enrolments).forEach(inst => { if (inst.teacherId && !map[dedupKey]._teacherIds.includes(inst.teacherId)) map[dedupKey]._teacherIds.push(inst.teacherId); });
      }
    }
    for (const c of contacts.filter(c => c.type === "parent")) {
      const dedupKey = (c.email || "").trim().toLowerCase() || (c.name || "").trim().toLowerCase();
      if (!dedupKey) continue;
      if (!map[dedupKey]) {
        map[dedupKey] = { ...c, _studentIds: [], _studentNames: [], _schoolIds: [], _instrumentNames: [], _teacherIds: [], _isManual: true };
      }
    }
    return Object.values(map);
  }, [students, contacts, enrolments]);

  const addManualParent = () => {
    const id = uid();
    const blank = { id, type: "parent", name: "", email: "", phone: "", cc: "", notes: "", relationship: "", _isNew: true };
    setContacts(prev => [blank, ...prev]);
    setPEditingKey("__new__" + id);
    setPEditForm({ name: "", email: "", phone: "", cc: "", notes: "", relationship: "", _newContactId: id });
  };

  const saveParentEditWithNew = () => {
    if (!pEditForm || !pEditingKey) return;
    if (pEditingKey.startsWith("__new__")) {
      const contactId = pEditForm._newContactId;
      const { _newContactId, ...rest } = pEditForm;
      setContacts(prev => prev.map(c => c.id === contactId ? { ...c, ...rest, _isNew: undefined } : c));
      setPEditingKey(null); setPEditForm(null);
      return;
    }
    const dedupKey = pEditingKey;
    setStudents(prev => prev.map(st => {
      const newParents = (st.parents || []).map(p => {
        const pKey = (p.email || "").trim().toLowerCase() || (p.name || "").trim().toLowerCase();
        if (pKey !== dedupKey) return p;
        return { ...p, name: pEditForm.name, email: pEditForm.email, phone: pEditForm.phone, cc: pEditForm.cc, notes: pEditForm.notes, relationship: pEditForm.relationship };
      });
      return { ...st, parents: newParents };
    }));
    setContacts(prev => prev.map(c => {
      if (c.type !== "parent") return c;
      const cKey = (c.email || "").trim().toLowerCase() || (c.name || "").trim().toLowerCase();
      if (cKey !== dedupKey) return c;
      return { ...c, name: pEditForm.name, email: pEditForm.email, phone: pEditForm.phone, cc: pEditForm.cc, notes: pEditForm.notes };
    }));
    setPEditingKey(null); setPEditForm(null);
  };

  const allInstruments = useMemo(() => [...new Set(parentRows.flatMap(r => r._instrumentNames))].sort(), [parentRows]);
  const allTeachersInParents = useMemo(() => [...new Set(parentRows.flatMap(r => r._teacherIds))].map(tid => teachers.find(t => t.id === tid)).filter(Boolean), [parentRows, teachers]);

  const filteredParents = useMemo(() => {
    return parentRows.filter(p => {
      if (pFilterSchool && !p._schoolIds.includes(pFilterSchool)) return false;
      if (pFilterTeacher && !p._teacherIds.includes(pFilterTeacher)) return false;
      if (pFilterInstrument && !p._instrumentNames.includes(pFilterInstrument)) return false;
      if (pSearch) {
        const q = pSearch.toLowerCase();
        const nameMatch = (p.name || "").toLowerCase().includes(q);
        const studentMatch = p._studentNames.some(n => n.toLowerCase().includes(q));
        if (!nameMatch && !studentMatch) return false;
      }
      return true;
    }).sort((a, b) => {
      let av = "", bv = "";
      if (pSortCol === "name") { av = a.name || ""; bv = b.name || ""; }
      else if (pSortCol === "students") { av = a._studentNames.join(","); bv = b._studentNames.join(","); }
      else if (pSortCol === "email") { av = a.email || ""; bv = b.email || ""; }
      const cmp = av.localeCompare(bv, undefined, { sensitivity: "base" });
      return pSortDir === "asc" ? cmp : -cmp;
    });
  }, [parentRows, pSearch, pFilterSchool, pFilterTeacher, pFilterInstrument, pSortCol, pSortDir]);

  const startParentEdit = (p) => {
    const dedupKey = (p.email || "").trim().toLowerCase() || (p.name || "").trim().toLowerCase();
    setPEditingKey(dedupKey);
    setPEditForm({ name: p.name || "", email: p.email || "", phone: p.phone || "", cc: p.cc || "", notes: p.notes || "", relationship: p.relationship || "" });
  };
  const cancelParentEdit = () => {
    if (pEditingKey && pEditingKey.startsWith("__new__") && pEditForm?._newContactId) {
      setContacts(prev => prev.filter(c => c.id !== pEditForm._newContactId));
    }
    setPEditingKey(null); setPEditForm(null);
  };

  const updateParentField = (dedupKey, field, val) => {
    setStudents(prev => prev.map(st => {
      const newParents = (st.parents || []).map(p => {
        const pKey = (p.email || "").trim().toLowerCase() || (p.name || "").trim().toLowerCase();
        if (pKey !== dedupKey) return p;
        return { ...p, [field]: val };
      });
      return { ...st, parents: newParents };
    }));
  };

  const getPreferredName = (name) => {
    if (!name) return "";
    const m = name.match(/\(([^)]+)\)/);
    return m ? m[1] : name.split(" ")[0];
  };
  const getDisplayName = (name) => {
    if (!name) return "";
    return name.replace(/\s*\([^)]*\)/, "").trim();
  };

  const getDedupKey = (p) => (p.email || "").trim().toLowerCase() || (p.name || "").trim().toLowerCase();

  const pMailtoSelected = () => {
    const emails = [...pSelected].map(key => {
      const row = filteredParents.find(p => getDedupKey(p) === key);
      return row ? row.email : null;
    }).filter(Boolean);
    if (emails.length === 0) { notify("No email addresses in selection", "warning"); return; }
    openCompose(emails, { from: schools.find(s => s.id === pFilterSchool)?.senderEmail || "", triggerId: "contacts_group" });
  };

  const handlePCheckbox = (key, e) => {
    const rows = filteredParents;
    const idx = rows.findIndex(r => getDedupKey(r) === key);
    if (e.shiftKey && pLastChecked !== null) {
      const lastIdx = rows.findIndex(r => getDedupKey(r) === pLastChecked);
      const [lo, hi] = [Math.min(idx, lastIdx), Math.max(idx, lastIdx)];
      setPSelected(prev => { const n = new Set(prev); for (let i = lo; i <= hi; i++) n.add(getDedupKey(rows[i])); return n; });
    } else {
      setPSelected(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
    }
    setPLastChecked(key);
  };

  const pToggleSelectAll = () => {
    if (pSelected.size === filteredParents.length && filteredParents.length > 0) setPSelected(new Set());
    else setPSelected(new Set(filteredParents.map(p => getDedupKey(p))));
  };

  const pTogglePhone = (id) => setPExpandedPhone(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pToggleNotes = (id) => setPExpandedNotes(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pToggleCC = (id) => setPExpandedCC(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // ── School contacts ──────────────────────────────────────────
  const showTooltip = (e, text) => {
    if (!text) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTooltip({ text, x: r.left + r.width / 2, y: r.top - 8 });
  };
  const hideTooltip = () => setTooltip(null);

  useEffect(() => { anyExpandedRef.current = expandedNotes.size > 0 || expandedPhone.size > 0; }, [expandedNotes, expandedPhone]);
  useEffect(() => { pAnyExpandedRef.current = pExpandedPhone.size > 0 || pExpandedNotes.size > 0 || pExpandedCC.size > 0; }, [pExpandedPhone, pExpandedNotes, pExpandedCC]);

  useEffect(() => {
    const handler = (e) => {
      if (anyExpandedRef.current && !e.target.closest("[data-expand-area]") && !e.target.closest("[data-expand-toggle]")) {
        setExpandedNotes(new Set()); setExpandedPhone(new Set());
      }
      if (pAnyExpandedRef.current && !e.target.closest("[data-expand-area]") && !e.target.closest("[data-expand-toggle]")) {
        setPExpandedPhone(new Set()); setPExpandedNotes(new Set()); setPExpandedCC(new Set());
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const addContact = () => {
    const id = uid();
    const blank = { id, name: "", schoolId: "", role: "", roleOther: "", className: "", email: "", phone: "", notes: "", _isNew: true };
    setContacts(prev => [blank, ...prev]);
    setEditingId(id);
    setEditForm({ ...blank });
  };

  const startEdit = (c) => { setEditingId(c.id); setEditForm({ ...c }); };

  const saveEdit = () => {
    if (!editForm) return;
    const { _isNew, ...toSave } = editForm;
    setContacts(prev => prev.map(c => c.id === editingId ? toSave : c));
    setEditingId(null); setEditForm(null);
  };

  const cancelEdit = () => {
    const c = contacts.find(ct => ct.id === editingId);
    if (c && c._isNew) setContacts(prev => prev.filter(ct => ct.id !== editingId));
    setEditingId(null); setEditForm(null);
  };

  const deleteContact = (id) => {
    setContacts(prev => prev.filter(c => c.id !== id));
    setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
    if (editingId === id) { setEditingId(null); setEditForm(null); }
  };

  const updateNote = (id, val) => setContacts(prev => prev.map(c => c.id === id ? { ...c, notes: val } : c));
  const toggleNote = (id) => setExpandedNotes(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const togglePhone = (id) => setExpandedPhone(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const updatePhone = (id, val) => setContacts(prev => prev.map(c => c.id === id ? { ...c, phone: val } : c));

  const getClassOptions = (schoolId, role) => {
    if (role === "Classroom Teacher") {
      const fromSpecialists = specialists.filter(s => !schoolId || s.schoolId === schoolId).map(s => s.className).filter(Boolean);
      const fromStudents = students.filter(s => !schoolId || s.schoolId === schoolId).map(s => s.className).filter(Boolean);
      const all = [...new Set([...fromSpecialists, ...fromStudents])];
      const isFoundation = (n) => /^[PpFf]/i.test(n.trim());
      const foundation = all.filter(isFoundation).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const rest = all.filter(n => !isFoundation(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return [...foundation, ...rest];
    }
    if (role === "Specialist Teacher") {
      const schoolSpecialists = specialists.filter(s => !schoolId || s.schoolId === schoolId);
      return [...new Set(schoolSpecialists.map(s => s.subject).filter(Boolean))].sort();
    }
    return [];
  };

  const filtered = contacts.filter(c => {
    if (c.type === "parent") return false;
    if (c._isNew) return true;
    if (filterSchool && c.schoolId !== filterSchool) return false;
    if (filterRole && c.role !== filterRole) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(c.name || "").toLowerCase().includes(q) && !(c.email || "").toLowerCase().includes(q) && !(c.role || "").toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    let av = "", bv = "";
    if (sortCol === "name") { av = a.name || ""; bv = b.name || ""; }
    else if (sortCol === "school") { av = schools.find(s => s.id === a.schoolId)?.name || ""; bv = schools.find(s => s.id === b.schoolId)?.name || ""; }
    else if (sortCol === "role") { av = a.role || ""; bv = b.role || ""; }
    else if (sortCol === "class") { av = a.className || ""; bv = b.className || ""; }
    else if (sortCol === "email") { av = a.email || ""; bv = b.email || ""; }
    const cmp = av.localeCompare(bv, undefined, { sensitivity: "base" });
    return sortDir === "asc" ? cmp : -cmp;
  });

  const handleCheckbox = (id, e) => {
    const rows = filtered;
    const idx = rows.findIndex(r => r.id === id);
    if (e.shiftKey && lastChecked !== null) {
      const lastIdx = rows.findIndex(r => r.id === lastChecked);
      const [lo, hi] = [Math.min(idx, lastIdx), Math.max(idx, lastIdx)];
      setSelected(prev => { const n = new Set(prev); for (let i = lo; i <= hi; i++) n.add(rows[i].id); return n; });
    } else {
      setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    }
    setLastChecked(id);
  };

  const toggleSelectAll = () => {
    if (selected.size === filtered.length && filtered.length > 0) setSelected(new Set());
    else setSelected(new Set(filtered.map(c => c.id)));
  };

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };

  const SortTh = ({ col, children }) => {
    const active = sortCol === col;
    return (
      <th onClick={() => handleSort(col)} style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: active ? colors.accent : "#fff", textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", whiteSpace: "nowrap", userSelect: "none", background: colors.sidebarHover }}>
        {children}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
      </th>
    );
  };

  const handlePSort = (col) => {
    if (pSortCol === col) setPSortDir(d => d === "asc" ? "desc" : "asc");
    else { setPSortCol(col); setPSortDir("asc"); }
  };

  const PSortTh = ({ col, children }) => {
    const active = pSortCol === col;
    return (
      <th onClick={() => handlePSort(col)}
        style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: active ? colors.accent : "#fff", textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", whiteSpace: "nowrap", userSelect: "none", background: colors.sidebarHover }}>
        {children}{active ? (pSortDir === "asc" ? " ▲" : " ▼") : ""}
      </th>
    );
  };

  const mailtoSelected = () => {
    const emails = [...selected].map(id => (contacts.find(c => c.id === id) || {}).email).filter(Boolean);
    if (emails.length === 0) { notify("No email addresses in selection", "warning"); return; }
    openCompose(emails, { from: schools.find(s => s.id === filterSchool)?.senderEmail || "", triggerId: "contacts_group" });
  };

  const totalContacts = section === "parents" ? parentRows.length : contacts.length;

  const iconBtn = (onClick, icon, color, title, extraStyle = {}) => (
    <button onClick={onClick} title={title} style={{ border: "1px solid " + colors.border, background: colors.cardBg, color, borderRadius: 6, padding: "4px 7px", cursor: "pointer", fontSize: 13, display: "inline-flex", alignItems: "center", ...extraStyle }}>{icon}</button>
  );

  return (
    <div>
      {tooltip && (
        <div style={{ position: "fixed", left: tooltip.x, top: tooltip.y, transform: "translate(-50%, -100%)", background: "rgba(30,30,30,0.92)", color: "#fff", fontSize: 12, padding: "4px 9px", borderRadius: 6, pointerEvents: "none", zIndex: 9999, whiteSpace: "pre-wrap", maxWidth: 260, lineHeight: 1.4 }}>
          {tooltip.text}
        </div>
      )}
      <PageTitle subtitle={totalContacts + " contacts"} pageColor={PAGE_COLORS.contacts}
        action={["airules","import"].includes(section) ? null : section === "school"
          ? <Btn onClick={addContact} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>+ Add Contact</Btn>
          : null}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        Contacts
      </PageTitle>

      {/* Section toggle + AI Rules + Import */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16, gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 0, background: colors.bg, border: "2px solid " + colors.sidebarHover, borderRadius: 10, overflow: "hidden", flexShrink: 0 }}>
          {[
            { id: "parents", label: "Parent Contacts", icon: <Users size={13} /> },
            { id: "school", label: "School Contacts", icon: <Building2 size={13} /> }
          ].map(s => (
            <button key={s.id} onClick={() => setSection(s.id)}
              style={{ padding: "8px 20px", border: "none", fontSize: 13, fontFamily: "inherit", cursor: "pointer", fontWeight: 600, background: section === s.id ? colors.sidebarHover : "transparent", color: section === s.id ? colors.white : colors.textMuted, transition: "background 0.15s, color 0.15s", display: "inline-flex", alignItems: "center", gap: 6 }}>
              {s.icon}{s.label}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {[
            { id: "import", label: "Import", icon: <Download size={13} /> },
            { id: "airules", label: "AI Rules", icon: <Bot size={13} /> }
            // Session 95: Templates button removed — editor lives in Settings now.
          ].map(btn => (
            <button key={btn.id} onClick={() => setSection(section === btn.id ? "parents" : btn.id)}
              style={{ padding: "8px 16px", border: "1px solid " + (section === btn.id ? colors.sidebarHover : colors.border), borderRadius: 10, fontSize: 13, fontFamily: "inherit", cursor: "pointer", fontWeight: 600, background: section === btn.id ? colors.sidebarHover : colors.cardBg, color: section === btn.id ? colors.cardBg : colors.textMuted, transition: "background 0.15s, color 0.15s, border-color 0.15s", display: "inline-flex", alignItems: "center", gap: 6 }}>
              {btn.icon}{btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── PARENT CONTACTS ── */}
      {section === "parents" && (
        <div>
          <Card style={{ marginBottom: 16, padding: 14 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 160, position: "relative" }}>
                <input value={pSearch} onChange={e => setPSearch(e.target.value)} placeholder="Search parent or student name…"
                  style={{ width: "100%", padding: "8px 32px 8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                {pSearch && <button onClick={() => setPSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>}
              </div>
              <select value={pFilterSchool} onChange={e => setPFilterSchool(e.target.value)}
                style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">All Schools</option>
                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select value={pFilterTeacher} onChange={e => setPFilterTeacher(e.target.value)}
                style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">All Teachers</option>
                {allTeachersInParents.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <select value={pFilterInstrument} onChange={e => setPFilterInstrument(e.target.value)}
                style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">All Instruments</option>
                {allInstruments.map(i => <option key={i} value={i}>{i}</option>)}
              </select>
              {pSelected.size > 0 && (
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => {
                    const emails = [...pSelected].map(key => { const row = filteredParents.find(p => getDedupKey(p) === key); return row ? row.email : null; }).filter(Boolean);
                    if (!emails.length) { notify("No email addresses in selection", "warning"); return; }
                    openCompose(emails, { from: schools.find(s => s.id === pFilterSchool)?.senderEmail || "", triggerId: "contacts_individual" });
                  }}
                    style={{ padding: "5px 12px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, fontSize: 13, fontFamily: "inherit", cursor: "pointer", color: colors.accent, display: "flex", alignItems: "center", gap: 5 }}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = colors.cardBg}>
                    <Mail size={14} /><span>Group ({pSelected.size})</span>
                  </button>
                  <button onClick={() => {
                    const emails = [...pSelected].map(key => { const row = filteredParents.find(p => getDedupKey(p) === key); return row ? row.email : null; }).filter(Boolean);
                    if (!emails.length) { notify("No email addresses in selection", "warning"); return; }
                    openGmailSequential(emails, { from: schools.find(s => s.id === pFilterSchool)?.senderEmail || "" });
                  }}
                    style={{ padding: "5px 12px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, fontSize: 13, fontFamily: "inherit", cursor: "pointer", color: colors.accent, display: "flex", alignItems: "center", gap: 5 }}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = colors.cardBg}>
                    <Mail size={14} /><span>Individually</span>
                  </button>
                </div>
              )}
            </div>
          </Card>

          {filteredParents.length === 0 ? (
            <EmptyState icon="👨‍👩‍👧" title="No parent contacts" subtitle="Parent contacts are automatically built from student records. Add parent details to a student to see them here." />
          ) : (
            <div style={{ background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 280px)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
                  <tr>
                    <th style={{ padding: "10px 12px", background: colors.sidebarHover, width: 36 }}>
                      <input type="checkbox" checked={pSelected.size === filteredParents.length && filteredParents.length > 0} onChange={pToggleSelectAll} style={{ cursor: "pointer" }} />
                    </th>
                    <PSortTh col="name">Name</PSortTh>
                    <PSortTh col="students">Student(s)</PSortTh>
                    <PSortTh col="email">Email</PSortTh>
                    <th style={{ padding: "10px 12px", background: colors.sidebarHover, width: 100 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredParents.map((p, idx) => {
                    const dedupKey = (p.email || "").trim().toLowerCase() || (p.name || "").trim().toLowerCase();
                    const isEditing = pEditingKey === dedupKey || (pEditingKey && pEditingKey.startsWith("__new__") && p._isManual && pEditForm?._newContactId === p.id);
                    const phoneOpen = pExpandedPhone.has(dedupKey);
                    const notesOpen = pExpandedNotes.has(dedupKey);
                    const ccOpen = pExpandedCC.has(dedupKey);
                    const isHovered = hoveredPRow === dedupKey;
                    const rowBg = isEditing ? colors.blueLight : (isHovered ? ROW_HOVER_BG : colors.cardBg);
                    const preferredName = getPreferredName(p.name);
                    const displayName = getDisplayName(p.name);

                    return (
                      <React.Fragment key={dedupKey}>
                        <tr
                          style={{ background: rowBg, borderBottom: (phoneOpen || notesOpen || ccOpen) ? "none" : "1px solid " + colors.borderLight }}
                          onMouseEnter={() => setHoveredPRow(dedupKey)}
                          onMouseLeave={() => setHoveredPRow(null)}>
                          <td style={{ padding: "8px 12px", textAlign: "center" }}>
                            <input type="checkbox" checked={pSelected.has(dedupKey)} onChange={e => handlePCheckbox(dedupKey, e)} style={{ cursor: "pointer" }} />
                          </td>
                          {/* Name */}
                          <td style={{ padding: "6px 12px", fontWeight: 600 }}>
                            {isEditing
                              ? <input autoFocus value={pEditForm.name} onChange={e => setPEditForm(f => ({ ...f, name: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveParentEditWithNew(); if (e.key === "Escape") cancelParentEdit(); }} placeholder="Full name e.g. Jennifer (Jen) Smith"
                                  style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                              : <div>
                                  <span>{displayName || <span style={{ color: colors.textMuted, fontStyle: "italic" }}>—</span>}</span>
                                  {preferredName && preferredName !== displayName.split(" ")[0] && (
                                    <span style={{ fontSize: 11, color: colors.textMuted, marginLeft: 6 }}>({preferredName})</span>
                                  )}
                                </div>}
                          </td>
                          {/* Students */}
                          <td style={{ padding: "6px 12px", color: colors.textLight, fontSize: 12 }}>
                            {p._studentIds.length > 0 ? p._studentIds.map((sid, si) => {
                              const sName = p._studentNames[si] || "";
                              return (
                                <span key={sid}>
                                  {si > 0 && ", "}
                                  <span
                                    onClick={e => { e.stopPropagation(); if (onViewStudent) onViewStudent(sid); }}
                                    onMouseEnter={e => e.currentTarget.style.color = colors.accent}
                                    onMouseLeave={e => e.currentTarget.style.color = colors.textLight}
                                    style={{ cursor: "pointer", color: colors.textLight }}>
                                    {sName}
                                  </span>
                                </span>
                              );
                            }) : <span style={{ color: colors.textMuted }}>—</span>}
                          </td>
                          {/* Email */}
                          <td style={{ padding: "6px 12px" }}>
                            {isEditing
                              ? <input type="email" value={pEditForm.email} onChange={e => setPEditForm(f => ({ ...f, email: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveParentEditWithNew(); if (e.key === "Escape") cancelParentEdit(); }} placeholder="parent@example.com"
                                  style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                              : p.email
                                ? <span onClick={e => { e.stopPropagation(); openCompose([p.email], { triggerId: "contacts_individual" }); }} style={{ color: colors.accent, textDecoration: "underline", cursor: "pointer" }}>{p.email}</span>
                                : <span style={{ color: colors.textMuted }}>—</span>}
                          </td>
                          {/* Actions */}
                          <td style={{ padding: "6px 12px", whiteSpace: "nowrap" }}>
                            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
                              {isEditing ? (
                                <>
                                  <button onClick={saveParentEditWithNew} title="Save" style={{ border: "none", background: colors.success, color: "#fff", borderRadius: 6, padding: "4px 8px", cursor: "pointer", display: "inline-flex", alignItems: "center" }}><Check size={14} /></button>
                                  <button onClick={cancelParentEdit} title="Cancel" style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.textMuted, borderRadius: 6, padding: "4px 8px", cursor: "pointer", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
                                </>
                              ) : (
                                <>
                                  {p.email && iconBtn(e => { e.stopPropagation(); openCompose([p.email]); }, <Mail size={13} />, colors.accent, "Email " + displayName)}
                                  <button data-expand-toggle="true" onClick={() => pToggleCC(dedupKey)} onMouseEnter={e => showTooltip(e, p.cc ? "CC: " + p.cc : "Add CC address")} onMouseLeave={hideTooltip}
                                    style={{ border: "1px solid " + colors.border, background: ccOpen ? colors.sidebarActive : (p.cc ? colors.blueLight : colors.cardBg), color: ccOpen ? colors.cardBg : (p.cc ? colors.accent : colors.textMuted), borderRadius: 6, padding: "4px 7px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>CC</button>
                                  {iconBtn(e => { e.stopPropagation(); pTogglePhone(dedupKey); }, <Phone size={13} />, phoneOpen ? colors.white : (p.phone ? colors.text : colors.textMuted), p.phone || "Add phone",
                                    { background: phoneOpen ? colors.sidebarActive : colors.cardBg })}
                                  {iconBtn(e => { e.stopPropagation(); pToggleNotes(dedupKey); }, <StickyNote size={13} />, notesOpen ? colors.white : colors.textMuted, p.notes ? p.notes.slice(0, 80) : "Add notes",
                                    { background: notesOpen ? colors.sidebarActive : colors.cardBg })}
                                  {iconBtn(e => { e.stopPropagation(); startParentEdit(p); }, <Pencil size={13} />, colors.textMuted, "Edit")}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>

                        {/* CC expand row */}
                        {ccOpen && !isEditing && (
                          <tr style={{ background: rowBg, borderBottom: (phoneOpen || notesOpen) ? "none" : "1px solid " + colors.borderLight }}>
                            <td data-expand-area="true" colSpan={5} style={{ padding: "0 12px 8px 48px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap" }}>CC</span>
                                <input value={p.cc || ""} onChange={e => updateParentField(dedupKey, "cc", e.target.value)} placeholder="cc@example.com"
                                  style={{ flex: 1, maxWidth: 280, padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                                <span style={{ fontSize: 11, color: colors.textMuted }}>Pre-filled in email drafts</span>
                              </div>
                            </td>
                          </tr>
                        )}

                        {/* Phone expand row */}
                        {phoneOpen && !isEditing && (
                          <tr style={{ background: rowBg, borderBottom: notesOpen ? "none" : "1px solid " + colors.borderLight }}>
                            <td data-expand-area="true" colSpan={5} style={{ padding: "0 12px 8px 48px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap" }}>Phone</span>
                                <input value={p.phone || ""} onChange={e => updateParentField(dedupKey, "phone", e.target.value)} placeholder="04xx xxx xxx"
                                  style={{ flex: 1, maxWidth: 200, padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                              </div>
                            </td>
                          </tr>
                        )}

                        {/* Notes expand row */}
                        {notesOpen && !isEditing && (
                          <tr style={{ background: rowBg, borderBottom: "1px solid " + colors.borderLight }}>
                            <td data-expand-area="true" colSpan={5} style={{ padding: "0 12px 10px 48px" }}>
                              <textarea value={p.notes || ""} onChange={e => updateParentField(dedupKey, "notes", e.target.value)} placeholder="Notes…"
                                style={{ width: "100%", padding: "8px 10px", border: "1px solid " + colors.inputBorder, borderRadius: 7, fontSize: 12, fontFamily: "inherit", resize: "vertical", minHeight: 60, boxSizing: "border-box", color: colors.text, background: colors.cardBg }} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
              </div>
              {filteredParents.length === 0 && parentRows.length > 0 && (
                <div style={{ padding: "32px 20px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>No parents match the current filters</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── SCHOOL CONTACTS ── */}
      {section === "school" && (
        <div>
          <Card style={{ marginBottom: 16, padding: 14 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 160, position: "relative" }}>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or email…"
                  style={{ width: "100%", padding: "8px 32px 8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>}
              </div>
              <select value={filterSchool} onChange={e => setFilterSchool(e.target.value)}
                style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">All Schools</option>
                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select value={filterRole} onChange={e => setFilterRole(e.target.value)}
                style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">All Roles</option>
                {CONTACT_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              {selected.size > 0 && (
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => {
                    const emails = [...selected].map(id => (contacts.find(c => c.id === id) || {}).email).filter(Boolean);
                    if (!emails.length) { notify("No email addresses in selection", "warning"); return; }
                    openCompose(emails, { from: schools.find(s => s.id === filterSchool)?.senderEmail || "", triggerId: "contacts_individual" });
                  }}
                    style={{ padding: "5px 12px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, fontSize: 13, fontFamily: "inherit", cursor: "pointer", color: colors.accent, display: "flex", alignItems: "center", gap: 5 }}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = colors.cardBg}>
                    <Mail size={14} /><span>Group ({selected.size})</span>
                  </button>
                  <button onClick={() => {
                    const emails = [...selected].map(id => (contacts.find(c => c.id === id) || {}).email).filter(Boolean);
                    if (!emails.length) { notify("No email addresses in selection", "warning"); return; }
                    openGmailSequential(emails, { from: schools.find(s => s.id === filterSchool)?.senderEmail || "" });
                  }}
                    style={{ padding: "5px 12px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, fontSize: 13, fontFamily: "inherit", cursor: "pointer", color: colors.accent, display: "flex", alignItems: "center", gap: 5 }}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = colors.cardBg}>
                    <Mail size={14} /><span>Individually</span>
                  </button>
                </div>
              )}
            </div>
          </Card>

          {contacts.length === 0 ? (
            <EmptyState icon="🏫" title="No school contacts yet" subtitle="Add school contacts like principals, office managers, and classroom teachers." action="+ Add Contact" onAction={addContact} />
          ) : (
            <div style={{ background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 280px)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
                  <tr>
                    <th style={{ padding: "10px 12px", background: colors.sidebarHover, width: 36 }}>
                      <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleSelectAll} style={{ cursor: "pointer" }} />
                    </th>
                    <SortTh col="name">Name</SortTh>
                    <SortTh col="school">School</SortTh>
                    <SortTh col="role">Role</SortTh>
                    <SortTh col="class">Class / Subject</SortTh>
                    <th style={{ padding: "10px 12px", background: colors.sidebarHover, width: 80 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c, idx) => {
                    const isEditing = editingId === c.id;
                    const noteOpen = expandedNotes.has(c.id);
                    const schoolName = schools.find(s => s.id === c.schoolId)?.name || "";
                    const classOpts = getClassOptions(isEditing ? editForm.schoolId : c.schoolId, isEditing ? editForm.role : c.role);
                    const showClassField = CLASS_ROLES.includes(isEditing ? editForm.role : c.role);
                    const isHovered = hoveredRow === c.id;
                    const rowBg = isEditing ? colors.blueLight : (isHovered ? ROW_HOVER_BG : colors.cardBg);

                    return (
                      <React.Fragment key={c.id}>
                        <tr
                          style={{ background: rowBg, borderBottom: noteOpen ? "none" : "1px solid " + colors.borderLight }}
                          onMouseEnter={() => setHoveredRow(c.id)}
                          onMouseLeave={() => setHoveredRow(null)}>
                          <td style={{ padding: "8px 12px", textAlign: "center" }}>
                            <input type="checkbox" checked={selected.has(c.id)} onChange={e => handleCheckbox(c.id, e)} style={{ cursor: "pointer" }} />
                          </td>
                          <td style={{ padding: "6px 12px", fontWeight: 600 }}>
                            {isEditing
                              ? <input autoFocus value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }} placeholder="Full name"
                                  style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                              : c.name || <span style={{ color: colors.textMuted, fontStyle: "italic" }}>—</span>}
                          </td>
                          <td style={{ padding: "6px 12px" }}>
                            {isEditing
                              ? <select value={editForm.schoolId} onChange={e => setEditForm(p => ({ ...p, schoolId: e.target.value, className: "" }))}
                                  style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                                  <option value="">Select…</option>
                                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                              : schoolName ? <span style={{ color: schools.find(s => s.id === c.schoolId)?.color || colors.text, fontWeight: 600 }}>{schoolName}</span> : <span style={{ color: colors.textMuted }}>—</span>}
                          </td>
                          <td style={{ padding: "6px 12px" }}>
                            {isEditing
                              ? <div style={{ display: "flex", gap: 4, flexDirection: "column" }}>
                                  <select value={editForm.role} onChange={e => setEditForm(p => ({ ...p, role: e.target.value, className: "" }))}
                                    style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                                    <option value="">Select…</option>
                                    {CONTACT_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                                  </select>
                                  {editForm.role === "Other" && (
                                    <input value={editForm.roleOther || ""} onChange={e => setEditForm(p => ({ ...p, roleOther: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }} placeholder="Specify role…"
                                      style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" }} />
                                  )}
                                </div>
                              : <span>{c.role}{c.role === "Other" && c.roleOther ? " — " + c.roleOther : ""}</span>}
                          </td>
                          <td style={{ padding: "6px 12px" }}>
                            {isEditing
                              ? <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  {showClassField && (
                                    <select value={editForm.className || ""} onChange={e => setEditForm(p => ({ ...p, className: e.target.value }))}
                                      style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                                      <option value="">Select…</option>
                                      {classOpts.map(o => <option key={o} value={o}>{o}</option>)}
                                    </select>
                                  )}
                                  <input type="email" value={editForm.email} onChange={e => setEditForm(p => ({ ...p, email: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }} placeholder="email@school.edu.au"
                                    style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                                </div>
                              : c.className || <span style={{ color: colors.textMuted }}>—</span>}
                          </td>
                          <td style={{ padding: "6px 12px", whiteSpace: "nowrap" }}>
                            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
                              {isEditing ? (
                                <>
                                  <button onClick={saveEdit} title="Save" style={{ border: "none", background: colors.success, color: "#fff", borderRadius: 6, padding: "4px 8px", cursor: "pointer", display: "inline-flex", alignItems: "center" }}><Check size={14} /></button>
                                  <button onClick={cancelEdit} title="Cancel" style={{ border: "1px solid " + colors.border, background: colors.cardBg, color: colors.textMuted, borderRadius: 6, padding: "4px 8px", cursor: "pointer", display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
                                </>
                              ) : (
                                <>
                                  {c.email && iconBtn(e => { e.stopPropagation(); openCompose([c.email]); }, <Mail size={13} />, colors.accent, "Email " + c.name)}
                                  {iconBtn(e => { e.stopPropagation(); toggleNote(c.id); }, <StickyNote size={13} />, noteOpen ? colors.white : colors.textMuted, c.notes ? c.notes.slice(0, 80) : "Add notes",
                                    { background: noteOpen ? colors.sidebarActive : colors.cardBg })}
                                  {iconBtn(e => { e.stopPropagation(); togglePhone(c.id); }, <Phone size={13} />, expandedPhone.has(c.id) ? colors.white : (c.phone ? colors.text : colors.textMuted), c.phone || "Add phone number",
                                    { background: expandedPhone.has(c.id) ? colors.sidebarActive : colors.cardBg })}
                                  {iconBtn(e => { e.stopPropagation(); startEdit(c); }, <Pencil size={13} />, colors.textMuted, "Edit")}
                                  {iconBtn(e => { e.stopPropagation(); deleteContact(c.id); }, <Trash2 size={13} />, colors.danger, "Delete",
                                    { border: "1px solid " + colors.danger + "60" })}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                        {expandedPhone.has(c.id) && (
                          <tr style={{ background: rowBg, borderBottom: noteOpen ? "none" : "1px solid " + colors.borderLight }}>
                            <td data-expand-area="true" colSpan={7} style={{ padding: "0 12px 8px 48px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap" }}>Phone</span>
                                <input value={isEditing ? (editForm.phone || "") : (c.phone || "")} onChange={e => isEditing ? setEditForm(p => ({ ...p, phone: e.target.value })) : updatePhone(c.id, e.target.value)} placeholder="04xx xxx xxx"
                                  style={{ flex: 1, maxWidth: 200, padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                              </div>
                            </td>
                          </tr>
                        )}
                        {noteOpen && !isEditing && (
                          <tr style={{ background: rowBg, borderBottom: "1px solid " + colors.borderLight }}>
                            <td data-expand-area="true" colSpan={7} style={{ padding: "0 12px 10px 48px" }}>
                              <textarea value={c.notes || ""} onChange={e => updateNote(c.id, e.target.value)} placeholder="Notes…"
                                style={{ width: "100%", padding: "8px 10px", border: "1px solid " + colors.inputBorder, borderRadius: 7, fontSize: 12, fontFamily: "inherit", resize: "vertical", minHeight: 60, boxSizing: "border-box", color: colors.text, background: colors.cardBg }} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
              </div>
              {filtered.length === 0 && contacts.length > 0 && (
                <div style={{ padding: "32px 20px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>No contacts match the current filters</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── AI EMAIL RULES ── */}
      {section === "airules" && (
        <AiEmailRulesEditor notify={notify} />
      )}

      {/* ── IMPORT ── */}
      {section === "import" && (
        <AiImportContacts schools={schools} contacts={contacts} setContacts={setContacts} notify={notify} />
      )}
    </div>
  );
}
