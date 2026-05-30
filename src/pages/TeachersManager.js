// ============================================================
// TEACHERS MANAGER
// ============================================================

import React, { useState, useEffect } from "react";
import { Guitar, Mail, Phone, Coffee, X, Copy, Plus, Download, Palette, ClipboardList, Trash2, Music, Mic, Piano, UserPlus, CheckCircle, ChevronDown, ChevronRight, FileText, RotateCcw, Pencil } from "lucide-react";
import { DAYS, INSTRUMENTS } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { uid, getInstColor } from "../utils/helpers";
import { parseTeacherCSV } from "../data/parsers";
import { Card, PageTitle, NavButtons, Btn, Input, Tag, EmptyState, FileUpload, PAGE_COLORS } from "../components/ui/SharedUI";
import { supabase } from "../supabaseClient";
import { deleteSlip } from "../data/slipsDB";
import { SlipEditModal } from "./SlipEditModal";

// ── Term week helpers (standalone, no props needed) ────────────────────────

function _getMondayOf(dt) {
  const m = new Date(dt);
  const dow = m.getDay();
  m.setDate(m.getDate() + (dow === 0 ? -6 : 1 - dow));
  m.setHours(0, 0, 0, 0);
  return m;
}

function _getTermWeekNum(dateStr, interruptions) {
  const termBreaks = (interruptions || [])
    .filter(i => i.type === "term_break")
    .sort((a, b) => a.date.localeCompare(b.date));
  const d = new Date(dateStr + "T00:00:00");
  let termStartDay = null;
  let breakEndMonth = -1;
  for (const tb of termBreaks) {
    const tbEnd = new Date((tb.endDate || tb.date) + "T00:00:00");
    if (tbEnd < d) {
      termStartDay = new Date(tbEnd);
      termStartDay.setDate(termStartDay.getDate() + 1);
      breakEndMonth = tbEnd.getMonth();
    }
  }
  if (!termStartDay || breakEndMonth === 11 || breakEndMonth === 0) {
    const year = d.getFullYear();
    const start = new Date(year, 0, 27);
    while (start.getDay() !== 2) start.setDate(start.getDate() + 1);
    termStartDay = start;
  }
  const week1Monday = _getMondayOf(termStartDay);
  const targetMonday = _getMondayOf(d);
  const diffWeeks = Math.round(
    (targetMonday.getTime() - week1Monday.getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  return Math.max(1, diffWeeks + 1);
}

function _invoiceWeekLabel(periodStart, periodEnd, interruptions) {
  const w1 = _getTermWeekNum(periodStart, interruptions);
  const w2 = _getTermWeekNum(periodEnd, interruptions);
  if (w1 === w2) return `Week ${w1}`;
  return `Week ${w1} & ${w2}`;
}

function _fmtShort(dateStr) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-AU", {
    weekday: "short", day: "numeric", month: "short"
  });
}

function _fmt12(t) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

// ── TeacherInvoiceSection ──────────────────────────────────────────────────

function TeacherInvoiceSection({ teacherId, colors, notify }) {
  const [invoices,      setInvoices]      = useState([]);
  const [currentSlips,  setCurrentSlips]  = useState([]);
  const [interruptions, setInterruptions] = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [expanded,      setExpanded]      = useState(new Set());
  const [invSlips,      setInvSlips]      = useState({}); // { invoiceId: [slips] }
  const [deleteConfirm, setDeleteConfirm] = useState(null); // invoice object
  const [deleting,      setDeleting]      = useState(false);
  const [editingSlip,   setEditingSlip]   = useState(null); // slip object being edited
  const [deletingSlip,  setDeletingSlip]  = useState(null); // slip object pending delete confirm
  const [slipDeleting,  setSlipDeleting]  = useState(false);
  const [slipDeleteError, setSlipDeleteError] = useState(null);

  useEffect(() => {
    if (!teacherId) return;
    loadAll();
  }, [teacherId]);

  async function loadAll() {
    setLoading(true);
    try {
      const [invRes, slipRes, intrRes] = await Promise.all([
        supabase.from("teacher_invoices").select("*").eq("teacher_id", teacherId).order("period_start", { ascending: false }),
        supabase.from("day_slips").select("*").eq("teacher_id", teacherId).is("invoice_id", null).order("slip_date"),
        supabase.from("interruptions").select("*"),
      ]);
      setInvoices(invRes.data || []);
      setCurrentSlips(slipRes.data || []);
      setInterruptions(intrRes.data || []);
    } catch (e) {
      console.error("TeacherInvoiceSection load error:", e);
    } finally {
      setLoading(false);
    }
  }

  async function toggleInvoice(inv) {
    const next = new Set(expanded);
    if (next.has(inv.id)) {
      next.delete(inv.id);
    } else {
      next.add(inv.id);
      // Load slips for this invoice if not already loaded
      if (!invSlips[inv.id]) {
        const { data } = await supabase.from("day_slips").select("*").eq("invoice_id", inv.id).order("slip_date");
        setInvSlips(prev => ({ ...prev, [inv.id]: data || [] }));
      }
    }
    setExpanded(next);
  }

  async function deleteInvoice() {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      // Restore slips — remove invoice_id (keep is_locked: true so they reappear as confirmed)
      await supabase.from("day_slips").update({ invoice_id: null }).eq("invoice_id", deleteConfirm.id);
      await supabase.from("teacher_invoices").delete().eq("id", deleteConfirm.id);
      setDeleteConfirm(null);
      if (notify) notify("Invoice deleted — slips restored");
      await loadAll();
    } catch (e) {
      console.error("deleteInvoice error:", e);
    } finally {
      setDeleting(false);
    }
  }

  const sH = {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    background: colors.sidebarHover, borderRadius: 6, padding: "7px 12px", marginBottom: 8,
  };
  const pill = (col) => ({
    display: "inline-flex", alignItems: "center", gap: 4,
    fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 999,
    background: col === "green" ? (colors.successBg || "rgba(34,197,94,0.1)") : col === "blue" ? (colors.blueLight || "rgba(59,130,246,0.1)") : "rgba(245,158,11,0.1)",
    color: col === "green" ? (colors.success || "#22c55e") : col === "blue" ? (colors.accent || "#3B82F6") : "#f59e0b",
  });
  const slipRow = (even) => ({
    display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
    borderBottom: `1px solid ${colors.border}`, fontSize: 12,
    background: even ? colors.bg : colors.cardBg,
  });

  return (
    <div style={{ marginTop: 20 }}>
      {/* Section header */}
      <div style={sH}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#fff", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <FileText size={12} /> Invoice History
        </span>
        {!loading && (
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
            {invoices.length} submitted
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ padding: "14px 12px", fontSize: 13, color: colors.textMuted }}>Loading…</div>
      ) : (
        <>
          {/* Current unsubmitted slips */}
          {currentSlips.length > 0 && (
            <div style={{ marginBottom: 12, border: `1px solid ${colors.border}`, borderRadius: 8, overflow: "hidden" }}>
              <div style={{ padding: "8px 12px", fontSize: 11, fontWeight: 600, color: colors.accent, background: colors.blueLight || "rgba(59,130,246,0.07)", borderBottom: `1px solid ${colors.border}`, textTransform: "uppercase", letterSpacing: 0.5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Current — not yet submitted</span>
                <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: colors.textMuted }}>
                  {parseFloat(currentSlips.reduce((s, sl) => s + (sl.hours_worked || 0), 0).toFixed(2))} hrs total
                </span>
              </div>
              {currentSlips.map((slip, i) => (
                <div key={slip.id} style={slipRow(i % 2 === 0)}>
                  <div style={{ width: 120, flexShrink: 0 }}>
                    <div style={{ fontWeight: 600, color: colors.text }}>{_fmtShort(slip.slip_date)}</div>
                    <div style={{ fontSize: 11, color: colors.textMuted }}>{slip.school_names || slip.description || ""}</div>
                  </div>
                  <div style={{ flex: 1, color: colors.textMuted }}>
                    {slip.start_time ? `${_fmt12(slip.start_time)} – ${_fmt12(slip.end_time)}` : "No times"}
                    {slip.break_minutes > 0 && ` · −${slip.break_minutes}m`}
                  </div>
                  <span style={{ fontWeight: 600, color: colors.text, marginRight: 8 }}>
                    {parseFloat((slip.hours_worked || 0).toFixed(2))} hrs
                  </span>
                  <span style={pill(slip.slip_type === "extra" ? "yellow" : "blue")}>
                    {slip.slip_type === "extra" ? "Extra" : "Confirmed"}
                  </span>
                  <button
                    onClick={() => setEditingSlip(slip)}
                    title="Edit slip"
                    style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, padding: "2px 4px", display: "inline-flex", alignItems: "center", marginLeft: 4, opacity: 0.6 }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = colors.accent; }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = "0.6"; e.currentTarget.style.color = colors.textMuted; }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => setDeletingSlip(slip)}
                    title="Delete slip"
                    style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, padding: "2px 4px", display: "inline-flex", alignItems: "center", marginLeft: 2, opacity: 0.6 }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = colors.danger; }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = "0.6"; e.currentTarget.style.color = colors.textMuted; }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {currentSlips.length === 0 && invoices.length === 0 && (
            <div style={{ padding: "14px 12px", fontSize: 13, color: colors.textMuted, textAlign: "center", background: colors.bg, borderRadius: 8, border: `1px dashed ${colors.border}` }}>
              No invoices or pending slips yet.
            </div>
          )}

          {/* Submitted invoices */}
          {invoices.length > 0 && (
            <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, overflow: "hidden" }}>
              {invoices.map((inv, i) => (
                <div key={inv.id}>
                  {/* Invoice row */}
                  <div
                    onClick={() => toggleInvoice(inv)}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: `1px solid ${colors.border}`, cursor: "pointer", background: i % 2 === 0 ? colors.cardBg : colors.bg, userSelect: "none" }}
                    onMouseEnter={e => e.currentTarget.style.background = colors.blueLight || "rgba(59,130,246,0.06)"}
                    onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? colors.cardBg : colors.bg}
                  >
                    {expanded.has(inv.id)
                      ? <ChevronDown size={13} color={colors.textMuted} style={{ flexShrink: 0 }} />
                      : <ChevronRight size={13} color={colors.textMuted} style={{ flexShrink: 0 }} />
                    }
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
                        {_invoiceWeekLabel(inv.period_start, inv.period_end, interruptions)}
                      </div>
                      <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 1 }}>
                        Submitted {new Date(inv.submitted_at).toLocaleDateString("en-AU")}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginRight: 8 }}>
                      {parseFloat((inv.total_hours || 0).toFixed(2))} hrs
                    </div>
                    <span style={pill("green")}>Submitted</span>
                    <button
                      onClick={e => { e.stopPropagation(); setDeleteConfirm(inv); }}
                      title="Delete invoice and restore slips"
                      style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, padding: "2px 4px", display: "inline-flex", alignItems: "center", marginLeft: 4, opacity: 0.6 }}
                      onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = colors.danger; }}
                      onMouseLeave={e => { e.currentTarget.style.opacity = "0.6"; e.currentTarget.style.color = colors.textMuted; }}
                    >
                      <RotateCcw size={13} />
                    </button>
                  </div>

                  {/* Expanded slips */}
                  {expanded.has(inv.id) && (
                    <div>
                      {(invSlips[inv.id] || []).length === 0 ? (
                        <div style={{ padding: "10px 28px", fontSize: 12, color: colors.textMuted }}>Loading slips…</div>
                      ) : (invSlips[inv.id] || []).map((slip, si) => (
                        <div key={slip.id} style={{ ...slipRow(si % 2 === 0), paddingLeft: 28, background: si % 2 === 0 ? (colors.blueLight || "rgba(59,130,246,0.04)") : colors.bg }}>
                          <div style={{ width: 120, flexShrink: 0 }}>
                            <div style={{ fontWeight: 600, color: colors.text }}>{_fmtShort(slip.slip_date)}</div>
                            <div style={{ fontSize: 11, color: colors.textMuted }}>{slip.school_names || slip.description || ""}</div>
                          </div>
                          <div style={{ flex: 1, color: colors.textMuted }}>
                            {slip.start_time ? `${_fmt12(slip.start_time)} – ${_fmt12(slip.end_time)}` : "No times"}
                            {slip.break_minutes > 0 && ` · −${slip.break_minutes}m`}
                          </div>
                          <span style={{ fontWeight: 600, color: colors.text, marginRight: 8 }}>
                            {parseFloat((slip.hours_worked || 0).toFixed(2))} hrs
                          </span>
                          <span style={pill(slip.slip_type === "extra" ? "yellow" : "green")}>
                            {slip.slip_type === "extra" ? "Extra" : "Confirmed"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <>
          <div onClick={() => !deleting && setDeleteConfirm(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 10000 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 10001, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.22)", width: 380, maxWidth: "90vw", padding: 24, fontFamily: "inherit" }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <RotateCcw size={16} color={colors.danger} />
              Delete {_invoiceWeekLabel(deleteConfirm.period_start, deleteConfirm.period_end, interruptions)}?
            </div>
            <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 20, lineHeight: 1.5 }}>
              The invoice will be deleted and all slips restored. The teacher will be able to resubmit.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setDeleteConfirm(null)} disabled={deleting}>Cancel</Btn>
              <Btn variant="danger" onClick={deleteInvoice} disabled={deleting}>
                {deleting ? "Deleting…" : "Yes, delete invoice"}
              </Btn>
            </div>
          </div>
        </>
      )}

      {/* Slip edit modal */}
      {editingSlip && (
        <SlipEditModal
          slip={editingSlip}
          colors={colors}
          onClose={() => setEditingSlip(null)}
          onSaved={(updatedSlip) => {
            setCurrentSlips(prev => prev.map(s => s.id === updatedSlip.id ? updatedSlip : s));
            setEditingSlip(null);
          }}
        />
      )}

      {/* Slip delete confirmation modal */}
      {deletingSlip && (
        <>
          <div onClick={() => !slipDeleting && setDeletingSlip(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 10000 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 10001, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.22)", width: 380, maxWidth: "90vw", padding: 24, fontFamily: "inherit" }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <Trash2 size={16} color={colors.danger} />
              Delete slip?
            </div>
            <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 20, lineHeight: 1.5 }}>
              This will permanently remove the slip from the teacher's current totals. This cannot be undone.
            </p>
            {slipDeleteError && (
              <div style={{ color: colors.danger, fontSize: 12, marginBottom: 12 }}>{slipDeleteError}</div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => { setDeletingSlip(null); setSlipDeleteError(null); }} disabled={slipDeleting}>Cancel</Btn>
              <Btn
                variant="danger"
                disabled={slipDeleting}
                onClick={async () => {
                  setSlipDeleting(true);
                  setSlipDeleteError(null);
                  try {
                    const { error } = await deleteSlip(deletingSlip.id);
                    if (error) throw error;
                    setCurrentSlips(prev => prev.filter(s => s.id !== deletingSlip.id));
                    setDeletingSlip(null);
                  } catch (e) {
                    console.error("deleteSlip error:", e);
                    setSlipDeleteError(e.message || "Failed to delete slip");
                  } finally {
                    setSlipDeleting(false);
                  }
                }}
              >
                {slipDeleting ? "Deleting…" : "Delete"}
              </Btn>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const INSTRUMENT_ICON = (name = "", size = 15) => {
  const n = name.toLowerCase();
  if (/guitar|bass|ukulele/.test(n)) return <Guitar size={size} />;
  if (/piano|keyboard/.test(n)) return <Piano size={size} />;
  if (/vocal|voice|singing|singer/.test(n)) return <Mic size={size} />;
  return <Music size={size} />;
};

export function TeachersManager({ teachers, setTeachers, schools, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory, onAddMemory }) {
  const { colors } = useTheme();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const [teacherCtxMenu, setTeacherCtxMenu] = useState(null); // { x, y, teacher }
  const [inviteResult, setInviteResult] = useState(null); // { loading, teacher, password, error }
  const teacherCtxRef = React.useRef(null);
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  useEffect(() => {
    if (!teacherCtxMenu) return;
    const close = (e) => {
      if (teacherCtxRef.current && teacherCtxRef.current.contains(e.target)) return;
      setTeacherCtxMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [teacherCtxMenu]);

  useEffect(() => { setEditing(null); setForm(null); }, [resetKey]);

  const newTeacher = () => {
    setForm({ id: uid(), name: "", email: "", personalEmail: "", phone: "", hourlyRate: "", instruments: [{ name: "" }], availability: [], teacherBreaks: [], notes: "", color: "", hasAccount: false });
    setEditing("new");
  };

  const editTeacher = (t) => {
    let avail = t.availability.map(a => ({ ...a }));
    if (avail.length > 0 && !avail[0].schoolId && t.schools && t.schools.length > 0) {
      const migrated = [];
      for (const schoolId of t.schools) for (const a of avail) migrated.push({ schoolId, day: a.day, start: a.start, end: a.end });
      avail = migrated;
    }
    setForm({ ...t, personalEmail: t.personalEmail || "", hourlyRate: t.hourlyRate || "", instruments: t.instruments.map(i => ({ name: i.name })), availability: avail, teacherBreaks: (t.teacherBreaks || []).map(b => ({ ...b })), color: t.color || "", hasAccount: t.hasAccount || false });
    setEditing(t.id);
  };

  const saveTeacher = () => {
    if (!form.name.trim()) { notify("Teacher name required", "warning"); return; }
    if (!form.instruments[0]?.name) { notify("At least one instrument required", "warning"); return; }
    if (form.availability.length === 0) { notify("Add at least one availability entry", "warning"); return; }
    // teacher.schools (membership) now derives from teacher_coverage lanes,
    // not availability — no longer stamped here.
    const saved = { ...form };
    if (editing === "new") setTeachers(prev => [...prev, saved]);
    else setTeachers(prev => prev.map(t => t.id === saved.id ? saved : t));
    setForm(null); setEditing(null);
    notify("Teacher saved!");
  };

  const deleteTeacher = (id) => { setTeachers(prev => prev.filter(t => t.id !== id)); notify("Teacher removed"); };

  const handleImport = (data, filename) => {
    const imported = parseTeacherCSV(data, schools);
    if (imported.length === 0) { notify("No valid teachers found in file", "warning"); return; }
    setTeachers(prev => [...prev, ...imported]);
    notify(`Imported ${imported.length} teachers from ${filename}`);
  };

  const createTeacherAccount = async (t) => {
    if (!t.email) { notify("This teacher has no email address set. Add one first.", "warning"); return; }
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    const tempPassword = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    setInviteResult({ loading: true, teacher: t, password: null, error: null });
    try {
      const { error } = await supabase.auth.signUp({ email: t.email, password: tempPassword });
      if (error) {
        setInviteResult({ loading: false, teacher: t, password: null, error: error.message });
      } else {
        setTeachers(prev => prev.map(x => x.id === t.id ? { ...x, hasAccount: true } : x));
        setInviteResult({ loading: false, teacher: t, password: tempPassword, error: null });
      }
    } catch (err) {
      setInviteResult({ loading: false, teacher: t, password: null, error: err.message });
    }
  };

  const addAvailRow = () => setForm(prev => ({ ...prev, availability: [...prev.availability, { schoolId: schools.length === 1 ? schools[0].id : "", day: "Monday", start: "09:00", end: "15:30" }] }));
  const updateAvailRow = (idx, key, val) => setForm(prev => ({ ...prev, availability: prev.availability.map((a, i) => i === idx ? { ...a, [key]: val } : a) }));
  const removeAvailRow = (idx) => setForm(prev => ({ ...prev, availability: prev.availability.filter((_, i) => i !== idx) }));
  const duplicateAvailRow = (idx) => setForm(prev => { const row = { ...prev.availability[idx] }; return { ...prev, availability: [...prev.availability.slice(0, idx + 1), row, ...prev.availability.slice(idx + 1)] }; });

  const addInstrument = () => setForm(prev => ({ ...prev, instruments: [...prev.instruments, { name: "" }] }));
  const updateInstrument = (idx, key, val) => setForm(prev => { const insts = [...prev.instruments]; insts[idx] = { ...insts[idx], [key]: val }; return { ...prev, instruments: insts }; });

  const rowStyle = { display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", background: colors.bg, borderRadius: 8 };
  const sectionHeader = (label, action) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: colors.sidebarHover, borderRadius: 6, padding: "7px 12px", marginBottom: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "#fff", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      {action}
    </div>
  );
  const headerCell = (w, label) => <div style={{ width: w, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>;
  const inputSel = { width: "100%", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" };
  const inputTime = { width: 100, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" };
  const iconBtn = (onClick, icon, color, title) => (
    <button onClick={onClick} title={title} style={{ border: "none", background: "none", color, cursor: "pointer", padding: 2, display: "inline-flex", alignItems: "center" }}>{icon}</button>
  );

  if (form) {
    const current = form.color || "";
    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveTeacher(); } }}>
        <PageTitle navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{editing === "new" ? "Add Staff Member" : "Edit Staff Member"}</PageTitle>
        <Card>
          {form.name.trim() && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: form.color || colors.sidebarHover, color: "#fff", fontWeight: 600, fontSize: 15, borderRadius: 20, padding: "5px 14px", marginBottom: 16 }}>
              {INSTRUMENT_ICON(form.instruments[0]?.name, 14)}
              {form.name.trim()}
            </div>
          )}
          <Input label="Name" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder="Full name" />

          {/* Colour picker */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 8 }}>Colour</label>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <input type="color" value={current || "#5B7FA6"} onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                  style={{ opacity: 0, position: "absolute", width: "100%", height: "100%", top: 0, left: 0, cursor: "pointer", border: "none", padding: 0 }} />
                <div style={{ width: 36, height: 36, borderRadius: 8, border: current ? "3px solid " + colors.text : "2px dashed " + colors.border, outline: current ? "2px solid " + current : "none", outlineOffset: 2, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", background: current || "transparent" }} title="Pick colour">
                  {!current && <Palette size={16} color={colors.textMuted} />}
                </div>
              </div>
              <span style={{ fontSize: 11, color: colors.textMuted }}>{current ? "Custom colour set" : "Using auto-assigned colour"}</span>
              {current && <button onClick={() => setForm(p => ({ ...p, color: "" }))} style={{ fontSize: 11, color: colors.textMuted, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Reset</button>}
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
            <div style={{ flex: 1 }}><Input label="App Email" value={form.email || ""} onChange={v => setForm(p => ({ ...p, email: v }))} placeholder="name@mattmorasmusic.com" /></div>
            <div style={{ flex: 1 }}><Input label="Personal Email" value={form.personalEmail || ""} onChange={v => setForm(p => ({ ...p, personalEmail: v }))} placeholder="Optional" /></div>
          </div>
          <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
            <div style={{ flex: 1 }}><Input label="Phone" value={form.phone || ""} onChange={v => setForm(p => ({ ...p, phone: v }))} placeholder="04xx xxx xxx" /></div>
          </div>

          {/* Hourly Rate */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 6 }}>Hourly Rate</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ position: "relative", width: 140 }}>
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: colors.textMuted, pointerEvents: "none" }}>$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.hourlyRate}
                  onChange={e => setForm(p => ({ ...p, hourlyRate: e.target.value }))}
                  placeholder="0.00"
                  style={{ width: "100%", padding: "6px 8px 6px 22px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }}
                />
              </div>
              <span style={{ fontSize: 12, color: colors.textMuted, display: "inline-flex", alignItems: "center", gap: 4 }}>
                🔒 Not visible to teachers
              </span>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            {sectionHeader("Instruments",
              <Btn variant="ghost" onClick={addInstrument} style={{ fontSize: 12, color: "#fff", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Plus size={12} /> Add Instrument
              </Btn>
            )}
            {form.instruments.map((inst, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, padding: "8px 12px", background: colors.bg, borderRadius: 8 }}>
                <div style={{ flex: 1 }}>
                  <select value={inst.name} onChange={e => updateInstrument(i, "name", e.target.value)} style={{ width: "100%", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                    <option value="">Select instrument...</option>
                    {INSTRUMENTS.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                {i > 0 && iconBtn(() => setForm(p => ({ ...p, instruments: p.instruments.filter((_, idx) => idx !== i) })), <X size={14} />, colors.danger, "Remove instrument")}
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 14 }}>
            {sectionHeader("Availability",
              <Btn variant="ghost" onClick={addAvailRow} style={{ fontSize: 12, color: "#fff", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Plus size={12} /> Add Row
              </Btn>
            )}
            {form.availability.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", color: colors.textMuted, fontSize: 13, background: colors.bg, borderRadius: 8, border: `1px dashed ${colors.border}` }}>No availability set. Click "+ Add Row" to specify which schools &amp; days this teacher is available.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", paddingBottom: 4 }}>
                  {headerCell("auto", "School")}{headerCell("auto", "Day")}{headerCell(100, "Start")}{headerCell(100, "End")}<div style={{ width: 56 }}></div>
                </div>
                {form.availability.map((row, i) => (
                  <div key={i} style={rowStyle}>
                    <div style={{ flex: 2 }}><select value={row.schoolId || ""} onChange={e => updateAvailRow(i, "schoolId", e.target.value)} style={inputSel}><option value="">Select school...</option>{schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                    <div style={{ flex: 1 }}><select value={row.day} onChange={e => updateAvailRow(i, "day", e.target.value)} style={inputSel}>{DAYS.map(d => <option key={d} value={d}>{d}</option>)}</select></div>
                    <input type="time" value={row.start} onChange={e => updateAvailRow(i, "start", e.target.value)} style={inputTime} />
                    <input type="time" value={row.end} onChange={e => updateAvailRow(i, "end", e.target.value)} style={inputTime} />
                    <div style={{ display: "flex", gap: 2, width: 56, alignItems: "center" }}>
                      {iconBtn(() => duplicateAvailRow(i), <Copy size={13} />, colors.textMuted, "Duplicate row")}
                      {iconBtn(() => removeAvailRow(i), <X size={14} />, colors.danger, "Remove row")}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {form.availability.length > 0 && <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 6 }}>Tip: Use the copy button to duplicate a row, then change the day or school.</div>}
          </div>

          {/* Invoice history — only shown when editing an existing teacher */}
          {editing !== "new" && (
            <TeacherInvoiceSection teacherId={form.id} colors={colors} notify={notify} />
          )}

          <Input label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} multiline placeholder="Specialties, preferences, etc." />

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveTeacher}>Save Teacher</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); }}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageTitle subtitle={`${teachers.length} staff members`} pageColor={PAGE_COLORS.teachers}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <FileUpload onData={handleImport} label={<span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Download size={13} /> Import</span>} />
            <Btn onClick={newTeacher} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Plus size={13} /> Add Staff Member</Btn>
          </div>
        }
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Guitar size={16} /> Teachers</span>
      </PageTitle>

      {teachers.length === 0 ? (
        <EmptyState icon="🎵" title="No staff yet" subtitle="Add staff members with their instruments, availability, and schools." action="+ Add Staff Member" onAction={newTeacher} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {teachers.map((t, idx) => (
            <Card key={t.id}
              draggable
              onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDraggingIdx(idx); }}
              onDragEnd={() => { setDraggingIdx(null); setDragOverIdx(null); }}
              onDragOver={e => { e.preventDefault(); if (draggingIdx !== null && draggingIdx !== idx) setDragOverIdx(idx); }}
              onDragLeave={() => setDragOverIdx(null)}
              onDrop={e => {
                e.preventDefault();
                if (draggingIdx === null || draggingIdx === idx) { setDraggingIdx(null); setDragOverIdx(null); return; }
                setTeachers(prev => {
                  const next = [...prev];
                  const [moved] = next.splice(draggingIdx, 1);
                  next.splice(idx, 0, moved);
                  return next;
                });
                setDraggingIdx(null); setDragOverIdx(null);
              }}
              style={{
                cursor: draggingIdx === idx ? "grabbing" : "grab", padding: 0, overflow: "hidden",
                opacity: draggingIdx === idx ? 0.4 : 1,
                borderTop: dragOverIdx === idx && draggingIdx !== null && draggingIdx > idx ? `2.5px solid ${colors.accent}` : undefined,
                borderBottom: dragOverIdx === idx && draggingIdx !== null && draggingIdx < idx ? `2.5px solid ${colors.accent}` : undefined,
                transition: "opacity 0.15s",
              }}
              onClick={() => editTeacher(t)} onContextMenu={e => { e.preventDefault(); setTeacherCtxMenu({ x: e.clientX, y: e.clientY, teacher: t }); }}>
              <div style={{ background: t.color || colors.sidebarHover, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 600, fontSize: 16, color: colors.white, display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {INSTRUMENT_ICON(t.instruments[0]?.name, 15)}
                  {t.name}
                </div>
                <button onClick={e => { e.stopPropagation(); deleteTeacher(t.id); }} title="Remove staff member" style={{ background: "none", border: "none", cursor: "pointer", color: "#fff", opacity: 0.75, display: "inline-flex", alignItems: "center", padding: 4, borderRadius: 4 }} onMouseEnter={e => e.currentTarget.style.opacity = 1} onMouseLeave={e => e.currentTarget.style.opacity = 0.75}><Trash2 size={15} /></button>
              </div>
              <div style={{ padding: "10px 14px" }}>
                {(t.email || t.personalEmail || t.phone) && (
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {t.email && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Mail size={12} /> {t.email}</span>}
                    {t.personalEmail && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Mail size={12} style={{ opacity: 0.5 }} /> {t.personalEmail}</span>}
                    {t.phone && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Phone size={12} /> {t.phone}</span>}
                  </div>
                )}
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {t.instruments.map((inst, i) => <Tag key={i} color={getInstColor(inst.name)}>{inst.name}</Tag>)}
                </div>
                <div style={{ fontSize: 12, color: colors.textLight, marginTop: 6 }}>
                  {(() => {
                    const bySchool = {};
                    for (const a of t.availability) {
                      const sc = schools.find(s => s.id === a.schoolId);
                      const sName = sc?.name || "Unknown";
                      if (!bySchool[sName]) bySchool[sName] = { days: [], color: sc?.color || null };
                      bySchool[sName].days.push(a.day.slice(0, 3));
                    }
                    if (Object.keys(bySchool).length === 0) return "No availability set";
                    return Object.entries(bySchool).map(([school, { days, color }], i) => (
                      <span key={school}>{i > 0 && " · "}<span style={{ color: color || colors.textLight, fontWeight: color ? 600 : 400 }}>{school}</span>{`: ${[...new Set(days)].join(", ")}`}</span>
                    ));
                  })()}
                </div>
                {(t.teacherBreaks || []).length > 0 && (
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4, display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <Coffee size={12} />
                    {(() => {
                      const bySchool = {};
                      for (const b of t.teacherBreaks) {
                        const sName = schools.find(s => s.id === b.schoolId)?.name || "Unknown";
                        if (!bySchool[sName]) bySchool[sName] = [];
                        const dayLabel = b.day && b.day !== "All" ? `${b.day.slice(0, 3)} ` : "";
                        bySchool[sName].push(`${dayLabel}${b.start}–${b.end}`);
                      }
                      return Object.entries(bySchool).map(([school, times]) => `${school}: ${times.join(", ")}`).join(" · ");
                    })()}
                  </div>
                )}

                {/* Teacher account status / create button */}
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.border}`, display: "flex", justifyContent: "flex-end" }} onClick={e => e.stopPropagation()}>
                  {t.hasAccount ? (
                    <span style={{ fontSize: 12, color: colors.success || "#3a9e6e", display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 500 }}>
                      <CheckCircle size={13} /> Teacher account active
                    </span>
                  ) : (
                    <button
                      onClick={() => createTeacherAccount(t)}
                      title={t.email ? "Create a login account for this staff member" : "Add an email address to this staff member first"}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500,
                        border: `1px solid ${t.email ? colors.accent : colors.border}`,
                        background: "none",
                        color: t.email ? colors.accent : colors.textMuted,
                        cursor: t.email ? "pointer" : "default",
                        opacity: t.email ? 1 : 0.5,
                      }}
                    >
                      <UserPlus size={13} />
                      Create Teacher Account
                    </button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {teachers.length > 0 && (
        <Card style={{ marginTop: 20, background: colors.accentLight, borderColor: colors.accent + "40" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.accentDark, marginBottom: 6, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ClipboardList size={13} /> Spreadsheet Import Format
          </div>
          <div style={{ fontSize: 12, color: colors.accentDark, lineHeight: 1.6 }}>
            Columns: <strong>name, instruments</strong> (comma-separated), <strong>schools</strong> (comma-separated school names), <strong>days</strong> (comma-separated), <strong>start_time, end_time</strong>, <strong>notes</strong>.<br />
            Each teacher will get an availability entry for each school × day combination.
          </div>
        </Card>
      )}

      {teacherCtxMenu && onAddMemory && (() => {
        const t = teacherCtxMenu.teacher;
        const instrs = (t.instruments || []).map(i => i.name).join(", ");
        const bySchool = {};
        for (const a of (t.availability || [])) {
          const sName = schools.find(s => s.id === a.schoolId)?.name || "Unknown";
          if (!bySchool[sName]) bySchool[sName] = [];
          bySchool[sName].push(a.day.slice(0, 3));
        }
        const availStr = Object.entries(bySchool).map(([school, days]) => `${school}: ${[...new Set(days)].join(", ")}`).join("; ");
        const memText = [
          `Teacher: ${t.name}`,
          instrs && `instruments: ${instrs}`,
          availStr && `availability: ${availStr}`,
          t.notes && `note: ${t.notes.trim()}`,
        ].filter(Boolean).join(" — ");
        const menuY = teacherCtxMenu.y + 44 > window.innerHeight ? teacherCtxMenu.y - 44 : teacherCtxMenu.y;
        return (
          <>
            <div onMouseDown={() => setTeacherCtxMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 9998 }} />
            <div ref={teacherCtxRef}
              style={{ position: "fixed", left: teacherCtxMenu.x, top: menuY, zIndex: 9999, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.14)", minWidth: 180, overflow: "hidden", fontFamily: "inherit" }}>
              <button
                onClick={() => { onAddMemory(memText); setTeacherCtxMenu(null); }}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 14px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit" }}
                onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z"/><path d="M12 8v4l3 3"/></svg>
                Add to Claude memory
              </button>
            </div>
          </>
        );
      })()}

      {/* Create account result modal */}
      {inviteResult && (
        <>
          <div onClick={() => !inviteResult.loading && setInviteResult(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 10000 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 10001, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.22)", width: 420, maxWidth: "90vw", padding: 28, fontFamily: "inherit" }}>
            {inviteResult.loading ? (
              <div style={{ textAlign: "center", padding: "20px 0", color: colors.textMuted, fontSize: 14 }}>Creating account…</div>
            ) : inviteResult.error ? (
              <>
                <div style={{ fontWeight: 700, fontSize: 16, color: colors.danger, marginBottom: 10 }}>Account creation failed</div>
                <div style={{ fontSize: 13, color: colors.text, marginBottom: 20, background: colors.bg, borderRadius: 8, padding: "10px 14px" }}>{inviteResult.error}</div>
                <Btn onClick={() => setInviteResult(null)}>Close</Btn>
              </>
            ) : (
              <>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 16, color: colors.text, marginBottom: 6 }}>
                  <CheckCircle size={18} color={colors.success || "#3a9e6e"} />
                  Account created for {inviteResult.teacher.name}
                </div>
                <div style={{ fontSize: 13, color: colors.textMuted, marginBottom: 18 }}>
                  Share these login details with {inviteResult.teacher.name.split(" ")[0]}. They can change their password once they're logged in.
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Email</div>
                  <div style={{ fontSize: 13, color: colors.text, padding: "8px 12px", background: colors.bg, borderRadius: 6, border: `1px solid ${colors.border}` }}>{inviteResult.teacher.email}</div>
                </div>
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Temporary Password</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, fontSize: 15, fontWeight: 700, fontFamily: "monospace", letterSpacing: 1, color: colors.text, padding: "8px 12px", background: colors.bg, borderRadius: 6, border: `1px solid ${colors.border}` }}>{inviteResult.password}</div>
                    <button
                      onClick={() => { navigator.clipboard.writeText(inviteResult.password); notify("Password copied!"); }}
                      title="Copy password"
                      style={{ padding: "8px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.bg, cursor: "pointer", color: colors.textMuted, display: "inline-flex", alignItems: "center" }}>
                      <Copy size={14} />
                    </button>
                  </div>
                </div>
                <Btn onClick={() => setInviteResult(null)}>Done</Btn>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
