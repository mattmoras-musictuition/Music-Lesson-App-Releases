// ============================================================
// TEACHERS MANAGER
// ============================================================

import React, { useState, useEffect } from "react";
import { Guitar, Mail, Phone, Coffee, X, Copy, Plus, Download, Palette, ClipboardList, Trash2, Music, Mic, Piano, UserPlus, CheckCircle, ChevronDown, ChevronRight, FileText, RotateCcw, Pencil, KeyRound, AlertTriangle, Info, Lock, Eye, EyeOff, AtSign } from "lucide-react";
import { INSTRUMENTS } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { uid, getInstColor } from "../utils/helpers";
import { parseTeacherCSV } from "../data/parsers";
import { Card, PageTitle, NavButtons, Btn, Input, Tag, EmptyState, FileUpload, PAGE_COLORS } from "../components/ui/SharedUI";
import { supabase, createIsolatedAuthClient } from "../supabaseClient";
import { rowToInterruption } from "../utils/interruptionsDB";
import { deleteSlip } from "../data/slipsDB";
import { fetchResourceTaxonomies } from "../utils/resourcesDB";
import { SlipEditModal } from "./SlipEditModal";
import { listTeacherAccounts, setTeacherPassword, setTeacherLoginEmail, confirmTeacherAccount, deleteTeacherAccount, ADMIN_USER_ID } from "../utils/teacherAuthAdmin";

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

function _invoiceWeekLabel(periodStart, interruptions) {
  // Invoice fortnights are odd-first within a term (1/2, 3/4, …). Derive the
  // pair from period_start alone — period_end is unreliable (legacy rows store
  // the next fortnight's Monday, i.e. term-week N+2, which is what produced the
  // overlapping "N & N+2" labels). Snap period_start's term week down to the odd
  // week that begins its fortnight, then render the two-week span.
  const w = _getTermWeekNum(periodStart, interruptions);
  const w1 = (w % 2 === 1) ? w : w - 1;
  return `Week ${w1}/${w1 + 1}`;
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

// ── Login account helpers ───────────────────────────────────────────

// The RLS link between a teacher and their records is
// lower(teachers.email) = lower(auth.email()), so auth accounts are matched to
// teacher rows the same way: trimmed and lower-cased.
function _normEmail(e) {
  return (e || "").trim().toLowerCase();
}

// hour12 on purpose: Electron's ICU renders midnight as hour "24" under the
// default locale settings, which reads as a bug to anyone looking at it.
function _fmtStamp(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function _fmtDay(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

// ── TeacherInvoiceSection ──────────────────────────────────────────────────

function TeacherInvoiceSection({ teacherId, colors, notify }) {
  const [invoices,      setInvoices]      = useState([]);
  const [currentSlips,  setCurrentSlips]  = useState([]);
  const [interruptions, setInterruptions] = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [expanded,      setExpanded]      = useState(new Set());
  const [invSlips,      setInvSlips]      = useState({}); // { invoiceId: { status: "loading"|"loaded"|"error", rows: [slips] } }
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
      // Map raw rows to the app-standard shape so endDate (DB: end_date) is
      // populated — _getTermWeekNum reads tb.endDate. Without this the snake_case
      // end_date is missed, every term break collapses to its start day, and
      // Term-2 week labels come out a fortnight high.
      setInterruptions((intrRes.data || []).map(rowToInterruption));
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
      // Load slips for this invoice if not already loaded. Track distinct
      // states (loading / loaded / error) so the render can tell an empty
      // result or a failed query apart from a still-pending one — otherwise
      // both spin "Loading slips…" forever.
      if (!invSlips[inv.id]) {
        setInvSlips(prev => ({ ...prev, [inv.id]: { status: "loading", rows: [] } }));
        const { data, error } = await supabase.from("day_slips").select("*").eq("invoice_id", inv.id).order("slip_date");
        if (error) {
          console.error("Invoice slips load error:", error);
          setInvSlips(prev => ({ ...prev, [inv.id]: { status: "error", rows: [] } }));
        } else {
          setInvSlips(prev => ({ ...prev, [inv.id]: { status: "loaded", rows: data || [] } }));
        }
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
                        {_invoiceWeekLabel(inv.period_start, interruptions)}
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
                      {(invSlips[inv.id]?.status || "loading") === "loading" ? (
                        <div style={{ padding: "10px 28px", fontSize: 12, color: colors.textMuted }}>Loading slips…</div>
                      ) : invSlips[inv.id].status === "error" ? (
                        <div style={{ padding: "10px 28px", fontSize: 12, color: colors.danger }}>Couldn't load slips</div>
                      ) : (invSlips[inv.id].rows || []).length === 0 ? (
                        <div style={{ padding: "10px 28px", fontSize: 12, color: colors.textMuted }}>No slips found</div>
                      ) : (invSlips[inv.id].rows || []).map((slip, si) => (
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
              Delete {_invoiceWeekLabel(deleteConfirm.period_start, interruptions)}?
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

// ── Login modal pieces ─────────────────────────────────────────────────────
//
// Same backdrop + centred card the invoice and slip modals in this file use,
// factored out because the login actions need four of them.

function LoginModalShell({ colors, onClose, busy, icon, title, children, width = 420 }) {
  return (
    <>
      <div onClick={() => !busy && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 10000 }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 10001, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.22)", width, maxWidth: "90vw", padding: 24, fontFamily: "inherit" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 15, color: colors.text, marginBottom: 12 }}>
          {icon}{title}
        </div>
        {children}
      </div>
    </>
  );
}

// A password the owner has to read back to a teacher over the phone, so it is
// shown in full on request and copyable — hidden by default in case anyone is
// looking over the shoulder.
function PasswordField({ colors, notify, value, onChange, label = "Password", autoFocus }) {
  const [shown, setShown] = useState(false);
  const btn = { padding: "8px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.bg, cursor: "pointer", color: colors.textMuted, display: "inline-flex", alignItems: "center" };
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type={shown ? "text" : "password"}
          value={value}
          autoFocus={autoFocus}
          onChange={e => onChange(e.target.value)}
          style={{ flex: 1, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 15, fontFamily: "monospace", letterSpacing: 1, color: colors.text, background: colors.bg, boxSizing: "border-box" }}
        />
        <button onClick={() => setShown(v => !v)} title={shown ? "Hide password" : "Show password"} style={btn}>
          {shown ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button
          onClick={() => { navigator.clipboard.writeText(value); notify("Password copied!"); }}
          title="Copy password"
          style={btn}
        >
          <Copy size={14} />
        </button>
      </div>
    </div>
  );
}

// Shared by every login modal: the raw Postgres message, verbatim.
function ModalError({ colors, message }) {
  if (!message) return null;
  return (
    <div style={{ fontSize: 13, color: colors.danger, background: colors.bg, border: `1px solid ${colors.danger}40`, borderRadius: 8, padding: "10px 14px", marginBottom: 14, lineHeight: 1.45 }}>
      {message}
    </div>
  );
}

function SignOutWarning({ colors, name }) {
  return (
    <div style={{ fontSize: 12, color: "#b45309", background: "rgba(245,158,11,0.1)", borderRadius: 8, padding: "9px 12px", marginBottom: 16, lineHeight: 1.45, display: "flex", gap: 7 }}>
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>This signs {name} out on every device. They will need to log in again with the new password.</span>
    </div>
  );
}

function SetPasswordModal({ teacher, account, colors, notify, onClose, onDone }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // email returned by the function

  const tooShort = password.length > 0 && password.length < 8;

  async function submit() {
    if (password.length < 8) return;
    setBusy(true);
    setError(null);
    const res = await setTeacherPassword(account.user_id, password);
    setBusy(false);
    if (res.ok) { setDone(res.value); notify("Password updated"); }
    else setError(res.message);
    onDone();
  }

  return (
    <LoginModalShell colors={colors} onClose={onClose} busy={busy} icon={<KeyRound size={16} color={colors.accent} />} title={done ? "Password updated" : `Set a new password for ${teacher.name}`}>
      {done ? (
        <>
          <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5, marginBottom: 16 }}>
            The new password is now active for <strong>{done}</strong>. Read it back to {teacher.name.split(" ")[0]} before closing this — it is not stored anywhere.
          </div>
          <PasswordField colors={colors} notify={notify} value={password} onChange={() => {}} label="New password" />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
            <Btn onClick={onClose}>Done</Btn>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, color: colors.textMuted, lineHeight: 1.5, marginBottom: 16 }}>
            Type the password you want to give {teacher.name.split(" ")[0]} for <strong>{account.login_email}</strong>. You will need to read it back to them, so use the eye and copy buttons.
          </div>
          <SignOutWarning colors={colors} name={teacher.name} />
          <PasswordField colors={colors} notify={notify} value={password} onChange={setPassword} label="New password" autoFocus />
          <div style={{ fontSize: 12, color: tooShort ? colors.danger : colors.textMuted, marginTop: 6, marginBottom: 16 }}>
            {tooShort ? "Use at least 8 characters." : "At least 8 characters."}
          </div>
          <ModalError colors={colors} message={error} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
            <Btn onClick={submit} disabled={busy || password.length < 8}>{busy ? "Setting…" : "Set password"}</Btn>
          </div>
        </>
      )}
    </LoginModalShell>
  );
}

function ChangeEmailModal({ teacher, account, colors, onClose, onDone }) {
  const [email, setEmail] = useState(account.login_email || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const changed = _normEmail(email) !== _normEmail(account.login_email);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await setTeacherLoginEmail(account.user_id, teacher.id, email.trim());
    setBusy(false);
    if (res.ok) {
      setDone(res.value);
      // Push the new address into the teachers array as well. The teachers sync
      // effect writes the whole row back on change, so leaving the old address
      // in local state would overwrite what the function just set and break the
      // lower(teachers.email) = lower(auth.email()) link the teacher app's RLS
      // policies depend on.
      onDone(res.value);
    } else {
      setError(res.message);
    }
  }

  return (
    <LoginModalShell colors={colors} onClose={onClose} busy={busy} icon={<AtSign size={16} color={colors.accent} />} title={done ? "Login address changed" : `Change login address for ${teacher.name}`}>
      {done ? (
        <>
          <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5, marginBottom: 20 }}>
            {teacher.name.split(" ")[0]} now logs in with <strong>{done}</strong>. Their password is unchanged, and their records moved across with them.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn onClick={onClose}>Done</Btn>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, color: colors.textMuted, lineHeight: 1.5, marginBottom: 16 }}>
            This is the address {teacher.name.split(" ")[0]} types in to log in to the teacher app. Changing it here changes their login <em>and</em> the address on their staff record together — that pair is what connects them to their own students, lessons and invoices, so the two must never drift apart.
          </div>
          <SignOutWarning colors={colors} name={teacher.name} />
          <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Login address</div>
          <input
            type="email"
            value={email}
            autoFocus
            onChange={e => setEmail(e.target.value)}
            style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 14, fontFamily: "inherit", color: colors.text, background: colors.bg, boxSizing: "border-box", marginBottom: 16 }}
          />
          <ModalError colors={colors} message={error} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
            <Btn onClick={submit} disabled={busy || !email.trim() || !changed}>{busy ? "Changing…" : "Change address"}</Btn>
          </div>
        </>
      )}
    </LoginModalShell>
  );
}

function ConfirmAccountModal({ teacher, account, colors, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await confirmTeacherAccount(account.user_id);
    setBusy(false);
    if (res.ok) setDone(res.value);
    else setError(res.message);
    onDone();
  }

  return (
    <LoginModalShell colors={colors} onClose={onClose} busy={busy} icon={<CheckCircle size={16} color={colors.success || "#3a9e6e"} />} title={done ? "Account confirmed" : `Confirm ${teacher.name}'s account`}>
      {done ? (
        <>
          <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5, marginBottom: 20 }}>
            <strong>{done}</strong> is confirmed and can sign in now. Their password is unchanged.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn onClick={onClose}>Done</Btn>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, color: colors.textMuted, lineHeight: 1.5, marginBottom: 16 }}>
            This account was created but never confirmed, which is why signing in fails with "invalid login credentials" even when the password is right. Confirming it makes <strong>{account.login_email}</strong> usable straight away. The password is not changed and nobody is signed out.
          </div>
          <ModalError colors={colors} message={error} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
            <Btn onClick={submit} disabled={busy}>{busy ? "Confirming…" : "Confirm account"}</Btn>
          </div>
        </>
      )}
    </LoginModalShell>
  );
}

function RemoveAccountModal({ teacher, account, colors, onClose, onDone }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const matches = typed.trim().toLowerCase() === (teacher.name || "").trim().toLowerCase();

  async function submit() {
    if (!matches) return;
    setBusy(true);
    setError(null);
    const res = await deleteTeacherAccount(account.user_id);
    setBusy(false);
    if (res.ok) setDone(res.value);
    else setError(res.message);
    onDone();
  }

  return (
    <LoginModalShell colors={colors} onClose={onClose} busy={busy} icon={<Trash2 size={16} color={colors.danger} />} title={done ? "Login removed" : `Remove ${teacher.name}'s login?`}>
      {done ? (
        <>
          <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5, marginBottom: 20 }}>
            The login for <strong>{done}</strong> has been removed. {teacher.name}'s staff record, students and history are untouched — create a new account for them whenever you need to.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn onClick={onClose}>Done</Btn>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, color: colors.textMuted, lineHeight: 1.5, marginBottom: 14 }}>
            This deletes {teacher.name.split(" ")[0]}'s ability to log in to the teacher app. They will not be able to sign in with <strong>{account.login_email}</strong> again.
          </div>
          <div style={{ fontSize: 13, color: colors.textMuted, lineHeight: 1.5, marginBottom: 16 }}>
            It does <strong>not</strong> delete their staff record, their students, or any of their lessons, invoices or history — all of that stays exactly as it is. You can create a new account for them afterwards.
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
            Type {teacher.name} to confirm
          </div>
          <input
            value={typed}
            autoFocus
            onChange={e => setTyped(e.target.value)}
            placeholder={teacher.name}
            style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 14, fontFamily: "inherit", color: colors.text, background: colors.bg, boxSizing: "border-box", marginBottom: 16 }}
          />
          <ModalError colors={colors} message={error} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
            <Btn variant="danger" onClick={submit} disabled={busy || !matches}>{busy ? "Removing…" : "Remove login"}</Btn>
          </div>
        </>
      )}
    </LoginModalShell>
  );
}

// Readable-in-a-phone-call alphabet: no I/l/1/O/0.
function _genPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ── CreateAccountModal ─────────────────────────────────────────────────────
//
// signUp on an isolated, non-persisting client so creating a teacher's account
// never replaces the admin's session (which would re-stamp teachers.user_id
// under the teacher's identity via the teachers sync effect).
//
// The result handling is the fix for the 9 Sep incident. signUp reports success
// in two cases where the teacher still cannot log in:
//
//   1. The address is already registered. Supabase deliberately obfuscates this
//      to stop address enumeration: no error, a user object, and an EMPTY
//      identities array. Read as success, the owner hands over a password that
//      was never set on the existing account.
//   2. The account is created unconfirmed. Sign-in then fails with "invalid
//      login credentials", which reads to everyone as a wrong password. This is
//      what happened to the account created on 9 Sep.
//
// So: an empty identities array is reported as "already exists", and a genuine
// new account is confirmed immediately via admin_confirm_teacher_account. If
// that confirm fails, the modal says the account exists but is not usable yet
// rather than declaring success.

function CreateAccountModal({ teacher, colors, notify, onClose, onCreated, onRefreshAccounts }) {
  const [email, setEmail] = useState(teacher.email || "");
  const [password, setPassword] = useState(_genPassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(null); // created but not usable
  const [done, setDone] = useState(null);

  const trimmed = email.trim();
  const emailLooksOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  const canSubmit = emailLooksOk && password.length >= 8 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setWarning(null);

    let data, signUpError;
    try {
      const authClient = createIsolatedAuthClient();
      ({ data, error: signUpError } = await authClient.auth.signUp({ email: trimmed, password }));
    } catch (err) {
      setBusy(false);
      setError(err?.message || String(err));
      return;
    }

    if (signUpError) {
      setBusy(false);
      setError(signUpError.message);
      return;
    }

    const user = data?.user;
    if (user && Array.isArray(user.identities) && user.identities.length === 0) {
      setBusy(false);
      setError(`An account already exists for ${trimmed}. Nothing was created. Use Change login address or Set password on that account instead.`);
      onRefreshAccounts();
      return;
    }

    if (!user?.id) {
      setBusy(false);
      setError("Supabase returned no account for that address. Nothing was created — check the address and try again.");
      return;
    }

    // Confirm immediately, so the account works regardless of the project's
    // confirm-email setting.
    const confirmRes = await confirmTeacherAccount(user.id);
    setBusy(false);

    if (!confirmRes.ok) {
      setWarning(confirmRes.message);
      onRefreshAccounts();
      return;
    }

    setDone(trimmed);
    onCreated(teacher.id, trimmed);
    onRefreshAccounts();
    notify("Teacher account created");
  }

  return (
    <LoginModalShell colors={colors} onClose={onClose} busy={busy} icon={<UserPlus size={16} color={colors.accent} />} title={done ? `Account created for ${teacher.name}` : `Create a login for ${teacher.name}`}>
      {done ? (
        <>
          <div style={{ fontSize: 13, color: colors.textMuted, lineHeight: 1.5, marginBottom: 16 }}>
            {teacher.name.split(" ")[0]} can sign in to the teacher app now. Read these details back to them — the password is not stored anywhere.
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Login address</div>
            <div style={{ fontSize: 13, color: colors.text, padding: "8px 12px", background: colors.bg, borderRadius: 6, border: `1px solid ${colors.border}` }}>{done}</div>
          </div>
          <PasswordField colors={colors} notify={notify} value={password} onChange={() => {}} />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
            <Btn onClick={onClose}>Done</Btn>
          </div>
        </>
      ) : warning ? (
        <>
          <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5, marginBottom: 14 }}>
            The account for <strong>{trimmed}</strong> was created, but confirming it failed — so {teacher.name.split(" ")[0]} cannot log in yet. Use <strong>Confirm account</strong> on the panel to finish it.
          </div>
          <ModalError colors={colors} message={warning} />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn onClick={onClose}>Close</Btn>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, color: colors.textMuted, lineHeight: 1.5, marginBottom: 16 }}>
            This is the address {teacher.name.split(" ")[0]} will type in to log in, and the password they will start with. It is also the address that links them to their own students and history, so it should match their staff record.
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Login address</div>
          <input
            type="email"
            value={email}
            autoFocus={!teacher.email}
            onChange={e => setEmail(e.target.value)}
            placeholder="name@mattmorasmusic.com"
            style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 14, fontFamily: "inherit", color: colors.text, background: colors.bg, boxSizing: "border-box", marginBottom: 4 }}
          />
          <div style={{ fontSize: 12, color: (trimmed && !emailLooksOk) ? colors.danger : colors.textMuted, marginBottom: 14 }}>
            {(trimmed && !emailLooksOk) ? "That does not look like an email address." : " "}
          </div>
          <PasswordField colors={colors} notify={notify} value={password} onChange={setPassword} label="Starting password" />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, marginBottom: 16 }}>
            <span style={{ fontSize: 12, color: password.length < 8 ? colors.danger : colors.textMuted }}>
              {password.length < 8 ? "Use at least 8 characters." : "At least 8 characters."}
            </span>
            <button
              onClick={() => setPassword(_genPassword())}
              style={{ fontSize: 12, color: colors.accent, background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0, fontFamily: "inherit" }}
            >
              Generate another
            </button>
          </div>
          <ModalError colors={colors} message={error} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
            <Btn onClick={submit} disabled={!canSubmit}>{busy ? "Creating…" : "Create account"}</Btn>
          </div>
        </>
      )}
    </LoginModalShell>
  );
}

// ── TeacherLoginPanel ──────────────────────────────────────────────────────
//
// Live view of a teacher's auth account, plus the actions that manage it.
// Everything shown here comes from admin_list_teacher_accounts (auth.users),
// never from the persisted hasAccount flag — that flag was written
// optimistically at creation time and stayed true for accounts that could not
// actually be signed into.

function TeacherLoginPanel({ teacher, account, loading, loadError, readOnly, colors, notify, onRefreshAccounts, onEmailChanged, onAccountCreated }) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(null); // "create" | "password" | "email" | "confirm" | "remove"

  const summary = loading ? "Checking…"
    : loadError ? "Couldn't check"
    : !account ? "No login account"
    : !account.confirmed_at ? "Unconfirmed"
    : "Active";

  const summaryColor = loading ? colors.textMuted
    : loadError ? colors.danger
    : !account ? colors.textMuted
    : !account.confirmed_at ? "#f59e0b"
    : (colors.success || "#3a9e6e");

  const label = { fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 };
  const value = { fontSize: 13, color: colors.text, marginTop: 2, wordBreak: "break-all" };
  const field = { marginBottom: 10 };

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.border}` }} onClick={e => e.stopPropagation()}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", color: colors.text }}
      >
        {open ? <ChevronDown size={13} color={colors.textMuted} /> : <ChevronRight size={13} color={colors.textMuted} />}
        <KeyRound size={13} color={colors.textMuted} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>Login &amp; Access</span>
        <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 500, color: summaryColor, display: "inline-flex", alignItems: "center", gap: 5 }}>
          {!loading && !loadError && account && account.confirmed_at && <CheckCircle size={13} />}
          {!loading && !loadError && account && !account.confirmed_at && <AlertTriangle size={13} />}
          {summary}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 10, padding: "12px 14px", background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 8 }}>
          {loading ? (
            <div style={{ fontSize: 13, color: colors.textMuted }}>Checking login accounts…</div>
          ) : loadError ? (
            <div style={{ fontSize: 13, color: colors.danger }}>{loadError}</div>
          ) : !account ? (
            <>
              <div style={{ fontSize: 13, color: colors.textMuted, marginBottom: readOnly ? 0 : 12 }}>
                No login account. {teacher.name.split(" ")[0]} cannot sign in to the teacher app.
              </div>
              {readOnly ? (
                <div style={{ fontSize: 12, color: colors.textMuted, display: "inline-flex", alignItems: "center", gap: 5, marginTop: 10 }}>
                  <Lock size={12} /> Manage your own login in the Supabase dashboard.
                </div>
              ) : (
                <Btn onClick={() => setModal("create")}>
                  <UserPlus size={13} /> Create account
                </Btn>
              )}
            </>
          ) : (
            <>
              <div style={field}>
                <div style={label}>Login address</div>
                <div style={value}>{account.login_email}</div>
              </div>
              <div style={field}>
                <div style={label}>Confirmed</div>
                <div style={{ ...value, color: account.confirmed_at ? colors.text : "#f59e0b" }}>
                  {account.confirmed_at ? `Yes — ${_fmtDay(account.confirmed_at)}` : "No — they cannot sign in yet"}
                </div>
              </div>
              <div style={field}>
                <div style={{ ...label, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  Last password sign-in
                  <span title="Only updates when they type their password in. Staying logged in on a device does not change this." style={{ display: "inline-flex", cursor: "help" }}>
                    <Info size={11} />
                  </span>
                </div>
                <div style={value}>{account.last_password_sign_in ? _fmtStamp(account.last_password_sign_in) : "never"}</div>
              </div>
              <div style={field}>
                <div style={label}>Created</div>
                <div style={value}>{_fmtDay(account.created)}</div>
              </div>

              {readOnly ? (
                <div style={{ fontSize: 12, color: colors.textMuted, display: "inline-flex", alignItems: "center", gap: 5, marginTop: 4 }}>
                  <Lock size={12} /> Manage your own login in the Supabase dashboard.
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                  <Btn variant="secondary" onClick={() => setModal("password")}>
                    <KeyRound size={13} /> Set password
                  </Btn>
                  <Btn variant="secondary" onClick={() => setModal("email")}>
                    <AtSign size={13} /> Change login address
                  </Btn>
                  {!account.confirmed_at && (
                    <Btn variant="success" onClick={() => setModal("confirm")}>
                      <CheckCircle size={13} /> Confirm account
                    </Btn>
                  )}
                  <Btn variant="danger" onClick={() => setModal("remove")}>
                    <Trash2 size={13} /> Remove account
                  </Btn>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {modal === "create" && !account && (
        <CreateAccountModal
          teacher={teacher}
          colors={colors}
          notify={notify}
          onClose={() => setModal(null)}
          onCreated={onAccountCreated}
          onRefreshAccounts={onRefreshAccounts}
        />
      )}
      {modal === "password" && account && (
        <SetPasswordModal
          teacher={teacher}
          account={account}
          colors={colors}
          notify={notify}
          onClose={() => setModal(null)}
          onDone={onRefreshAccounts}
        />
      )}
      {modal === "email" && account && (
        <ChangeEmailModal
          teacher={teacher}
          account={account}
          colors={colors}
          onClose={() => setModal(null)}
          onDone={(newEmail) => { onEmailChanged(teacher.id, newEmail); onRefreshAccounts(); }}
        />
      )}
      {modal === "confirm" && account && (
        <ConfirmAccountModal
          teacher={teacher}
          account={account}
          colors={colors}
          onClose={() => setModal(null)}
          onDone={onRefreshAccounts}
        />
      )}
      {modal === "remove" && account && (
        <RemoveAccountModal
          teacher={teacher}
          account={account}
          colors={colors}
          onClose={() => setModal(null)}
          onDone={onRefreshAccounts}
        />
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
  const teacherCtxRef = React.useRef(null);
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  // ── Instrument options (managed in Settings > Resource Library Lists) ──
  // Single source of truth is the app_settings `instruments` row, read through
  // the same fetchResourceTaxonomies helper every other consumer uses. null =
  // not loaded yet; [] = loaded-but-empty or the read failed.
  const [taxInstruments, setTaxInstruments] = useState(null);
  useEffect(() => {
    fetchResourceTaxonomies()
      .then(tax => setTaxInstruments(tax?.instruments || []))
      .catch(() => setTaxInstruments([]));
  }, []);
  // Fallback is deliberate and load-bearing: an empty or failed read must never
  // yield an empty dropdown, because this select is the only way to give a
  // teacher an instrument. Falling back to the INSTRUMENTS constant keeps the
  // form usable when the managed row is missing or Supabase is unreachable.
  const instrumentOptions = (taxInstruments && taxInstruments.length) ? taxInstruments : INSTRUMENTS;

  // ── Teacher login accounts ──────────────────────────────────────────────
  // Read once on mount and after every successful mutation. This is the only
  // source of truth for whether a teacher can actually sign in — the persisted
  // hasAccount flag is deliberately not consulted (a teacher created on 9 Sep
  // showed "account active" for an unconfirmed account that always failed
  // login with "invalid login credentials").
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState(null);

  const refreshAccounts = React.useCallback(async () => {
    setAccountsLoading(true);
    const res = await listTeacherAccounts();
    if (res.ok) {
      setAccounts(res.value || []);
      setAccountsError(null);
    } else {
      setAccounts([]);
      setAccountsError(res.message);
    }
    setAccountsLoading(false);
  }, []);

  useEffect(() => { refreshAccounts(); }, [refreshAccounts]);

  // The signed-in admin's own address. Used alongside ADMIN_USER_ID so Matt's
  // own row renders read-only — the RPCs refuse to act on the admin account,
  // and an action that can only ever fail should not be offered.
  const [adminEmail, setAdminEmail] = useState("");
  useEffect(() => {
    supabase.auth.getUser()
      .then(({ data }) => setAdminEmail(data?.user?.email || ""))
      .catch(() => {});
  }, []);

  const accountByEmail = React.useMemo(() => {
    const m = new Map();
    for (const a of accounts) {
      const k = _normEmail(a.login_email);
      if (k) m.set(k, a);
    }
    return m;
  }, [accounts]);

  const accountFor = (t) => {
    const k = _normEmail(t.email);
    return k ? (accountByEmail.get(k) || null) : null;
  };

  // Keep the teachers array in step with an address the RPC just changed.
  // admin_set_teacher_login_email updates public.teachers.email itself; without
  // this the next teachers sync would write the stale address back over it and
  // break the teacher's RLS link to their own records.
  const applyTeacherEmail = (teacherId, email) => {
    setTeachers(prev => prev.map(x => x.id === teacherId ? { ...x, email } : x));
  };

  // A new account's address becomes the teacher's record address, for the same
  // RLS reason as applyTeacherEmail. hasAccount is still written here so the
  // stored column keeps tracking reality, but nothing reads it for status any
  // more — the panel derives that from auth.users.
  const applyAccountCreated = (teacherId, email) => {
    setTeachers(prev => prev.map(x => x.id === teacherId ? { ...x, email, hasAccount: true } : x));
  };

  const isOwnRow = (t, acct) => {
    if (acct && acct.user_id === ADMIN_USER_ID) return true;
    const k = _normEmail(t.email);
    return !!k && k === _normEmail(adminEmail);
  };

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
    // Availability is no longer editable (editor retired); the array is cloned
    // through unchanged so toRow keeps persisting the now-dormant column.
    const avail = t.availability.map(a => ({ ...a }));
    setForm({ ...t, personalEmail: t.personalEmail || "", hourlyRate: t.hourlyRate || "", instruments: t.instruments.map(i => ({ name: i.name })), availability: avail, teacherBreaks: (t.teacherBreaks || []).map(b => ({ ...b })), color: t.color || "", hasAccount: t.hasAccount || false });
    setEditing(t.id);
  };

  const saveTeacher = () => {
    if (!form.name.trim()) { notify("Teacher name required", "warning"); return; }
    if (!form.instruments[0]?.name) { notify("At least one instrument required", "warning"); return; }
    // No availability requirement — the editor is retired and membership/eligibility
    // now derive from teacher_coverage lanes. The dormant availability array on
    // form is carried through unchanged for toRow.
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

  const addInstrument = () => setForm(prev => ({ ...prev, instruments: [...prev.instruments, { name: "" }] }));
  const updateInstrument = (idx, key, val) => setForm(prev => { const insts = [...prev.instruments]; insts[idx] = { ...insts[idx], [key]: val }; return { ...prev, instruments: insts }; });

  const sectionHeader = (label, action) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: colors.sidebarHover, borderRadius: 6, padding: "7px 12px", marginBottom: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "#fff", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      {action}
    </div>
  );
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
                    {instrumentOptions.map(n => <option key={n} value={n}>{n}</option>)}
                    {/* Stale value preservation: a stored name that has since been
                        pruned from the managed list is rendered as an extra option
                        on its own row, so the select still displays it and saving
                        the form doesn't silently blank or rewrite the teacher's
                        instrument. This is what makes pruning in Settings safe. */}
                    {inst.name && !instrumentOptions.includes(inst.name) && (
                      <option value={inst.name}>{inst.name}</option>
                    )}
                  </select>
                </div>
                {i > 0 && iconBtn(() => setForm(p => ({ ...p, instruments: p.instruments.filter((_, idx) => idx !== i) })), <X size={14} />, colors.danger, "Remove instrument")}
              </div>
            ))}
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

                {/* Login & Access — live auth account state */}
                <TeacherLoginPanel
                  teacher={t}
                  account={accountFor(t)}
                  loading={accountsLoading}
                  loadError={accountsError}
                  readOnly={isOwnRow(t, accountFor(t))}
                  colors={colors}
                  notify={notify}
                  onRefreshAccounts={refreshAccounts}
                  onEmailChanged={applyTeacherEmail}
                  onAccountCreated={applyAccountCreated}
                />
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
        const memText = [
          `Teacher: ${t.name}`,
          instrs && `instruments: ${instrs}`,
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

    </div>
  );
}
