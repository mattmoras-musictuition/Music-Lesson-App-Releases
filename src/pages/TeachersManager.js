// ============================================================
// TEACHERS MANAGER
// ============================================================

import React, { useState, useEffect } from "react";
import { colors, DAYS, INSTRUMENTS } from "../constants";
import { uid, getInstColor } from "../utils/helpers";
import { parseTeacherCSV } from "../data/parsers";
import { Card, PageTitle, NavButtons, Btn, Input, Tag, EmptyState, FileUpload } from "../components/ui/SharedUI";
import { PAGE_COLORS } from "../components/ui/SharedUI";

export function TeachersManager({ teachers, setTeachers, schools, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);

  useEffect(() => { setEditing(null); setForm(null); }, [resetKey]);

  const newTeacher = () => {
    setForm({ id: uid(), name: "", email: "", phone: "", instruments: [{ name: "" }], availability: [], teacherBreaks: [], notes: "", color: "" });
    setEditing("new");
  };

  const editTeacher = (t) => {
    let avail = t.availability.map(a => ({ ...a }));
    if (avail.length > 0 && !avail[0].schoolId && t.schools && t.schools.length > 0) {
      const migrated = [];
      for (const schoolId of t.schools) for (const a of avail) migrated.push({ schoolId, day: a.day, start: a.start, end: a.end });
      avail = migrated;
    }
    setForm({ ...t, instruments: t.instruments.map(i => ({ name: i.name })), availability: avail, teacherBreaks: (t.teacherBreaks || []).map(b => ({ ...b })), color: t.color || "" });
    setEditing(t.id);
  };

  const saveTeacher = () => {
    if (!form.name.trim()) { notify("Teacher name required", "warning"); return; }
    if (!form.instruments[0]?.name) { notify("At least one instrument required", "warning"); return; }
    if (form.availability.length === 0) { notify("Add at least one availability entry", "warning"); return; }
    const saved = { ...form, schools: [...new Set(form.availability.map(a => a.schoolId).filter(Boolean))] };
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

  const addAvailRow = () => setForm(prev => ({ ...prev, availability: [...prev.availability, { schoolId: schools.length === 1 ? schools[0].id : "", day: "Monday", start: "09:00", end: "15:30" }] }));
  const updateAvailRow = (idx, key, val) => setForm(prev => ({ ...prev, availability: prev.availability.map((a, i) => i === idx ? { ...a, [key]: val } : a) }));
  const removeAvailRow = (idx) => setForm(prev => ({ ...prev, availability: prev.availability.filter((_, i) => i !== idx) }));
  const duplicateAvailRow = (idx) => setForm(prev => { const row = { ...prev.availability[idx] }; return { ...prev, availability: [...prev.availability.slice(0, idx + 1), row, ...prev.availability.slice(idx + 1)] }; });

  const addBreakRow = () => setForm(prev => ({ ...prev, teacherBreaks: [...(prev.teacherBreaks || []), { id: uid(), schoolId: schools.length === 1 ? schools[0].id : "", day: "All", start: "11:00", end: "11:30" }] }));
  const updateBreakRow = (idx, key, val) => setForm(prev => ({ ...prev, teacherBreaks: (prev.teacherBreaks || []).map((b, i) => i === idx ? { ...b, [key]: val } : b) }));
  const removeBreakRow = (idx) => setForm(prev => ({ ...prev, teacherBreaks: (prev.teacherBreaks || []).filter((_, i) => i !== idx) }));
  const duplicateBreakRow = (idx) => setForm(prev => { const row = { ...(prev.teacherBreaks || [])[idx], id: uid() }; return { ...prev, teacherBreaks: [...prev.teacherBreaks.slice(0, idx + 1), row, ...prev.teacherBreaks.slice(idx + 1)] }; });

  const addInstrument = () => setForm(prev => ({ ...prev, instruments: [...prev.instruments, { name: "" }] }));
  const updateInstrument = (idx, key, val) => setForm(prev => { const insts = [...prev.instruments]; insts[idx] = { ...insts[idx], [key]: val }; return { ...prev, instruments: insts }; });

  const rowStyle = { display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", background: colors.bg, borderRadius: 8 };
  const headerCell = (w, label) => <div style={{ width: w, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>;
  const inputSel = { width: "100%", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" };
  const inputTime = { width: 100, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" };

  if (form) {
    const current = form.color || "";
    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveTeacher(); } }}>
        <PageTitle navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{editing === "new" ? "Add Teacher" : "Edit Teacher"}</PageTitle>
        <Card>
          <Input label="Teacher Name" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder="Full name" />

          {/* Colour picker */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 8 }}>Colour</label>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <input type="color" value={current || "#5B7FA6"} onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                  style={{ opacity: 0, position: "absolute", width: "100%", height: "100%", top: 0, left: 0, cursor: "pointer", border: "none", padding: 0 }} />
                <div style={{ width: 36, height: 36, borderRadius: 8, border: current ? "3px solid " + colors.text : "2px dashed " + colors.border, outline: current ? "2px solid " + current : "none", outlineOffset: 2, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", background: current || "transparent", fontSize: 16 }} title="Pick colour">
                  {current ? "" : "🎨"}
                </div>
              </div>
              <span style={{ fontSize: 11, color: colors.textMuted }}>{current ? "Custom colour set" : "Using auto-assigned colour"}</span>
              {current && <button onClick={() => setForm(p => ({ ...p, color: "" }))} style={{ fontSize: 11, color: colors.textMuted, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Reset</button>}
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
            <div style={{ flex: 1 }}><Input label="Email" value={form.email || ""} onChange={v => setForm(p => ({ ...p, email: v }))} placeholder="teacher@example.com" /></div>
            <div style={{ flex: 1 }}><Input label="Phone" value={form.phone || ""} onChange={v => setForm(p => ({ ...p, phone: v }))} placeholder="04xx xxx xxx" /></div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Instruments</label>
              <Btn variant="ghost" onClick={addInstrument} style={{ fontSize: 12 }}>+ Add Instrument</Btn>
            </div>
            {form.instruments.map((inst, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, padding: "8px 12px", background: colors.bg, borderRadius: 8 }}>
                <div style={{ flex: 1 }}>
                  <select value={inst.name} onChange={e => updateInstrument(i, "name", e.target.value)} style={{ width: "100%", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                    <option value="">Select instrument...</option>
                    {INSTRUMENTS.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                {i > 0 && <button onClick={() => setForm(p => ({ ...p, instruments: p.instruments.filter((_, idx) => idx !== i) }))} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18 }}>×</button>}
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Availability</label>
              <Btn variant="ghost" onClick={addAvailRow} style={{ fontSize: 12 }}>+ Add Row</Btn>
            </div>
            {form.availability.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", color: colors.textMuted, fontSize: 13, background: colors.bg, borderRadius: 8, border: `1px dashed ${colors.border}` }}>No availability set. Click "+ Add Row" to specify which schools & days this teacher is available.</div>
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
                    <div style={{ display: "flex", gap: 2, width: 56 }}>
                      <button onClick={() => duplicateAvailRow(i)} title="Duplicate row" style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 14, padding: 2 }}>⧉</button>
                      <button onClick={() => removeAvailRow(i)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 2 }}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {form.availability.length > 0 && <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 6 }}>Tip: Use the ⧉ button to duplicate a row, then change the day or school.</div>}
          </div>

          <Input label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} multiline placeholder="Specialties, preferences, etc." />

          <div style={{ marginBottom: 14, marginTop: -4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Breaks</label>
              <Btn variant="ghost" onClick={addBreakRow} style={{ fontSize: 12 }}>+ Add Break</Btn>
            </div>
            <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10, paddingLeft: 2 }}>☕ Times when this teacher must not have lessons at a specific school. If a school has its own break schedule, that will take priority.</div>
            {(form.teacherBreaks || []).length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", paddingBottom: 4 }}>
                  {headerCell("auto", "School")}{headerCell("auto", "Day")}{headerCell(100, "Start")}{headerCell(100, "End")}<div style={{ width: 56 }}></div>
                </div>
                {(form.teacherBreaks || []).map((brk, i) => {
                  const schoolHasBreaks = schools.find(s => s.id === brk.schoolId)?.teacherBreaks?.length > 0;
                  return (
                    <div key={brk.id || i} style={{ ...rowStyle, background: schoolHasBreaks ? "#FFF7ED" : colors.bg, border: schoolHasBreaks ? "1px solid #FED7AA" : undefined }}>
                      <div style={{ flex: 2 }}><select value={brk.schoolId || ""} onChange={e => updateBreakRow(i, "schoolId", e.target.value)} style={inputSel}><option value="">Select school...</option>{schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                      <div style={{ flex: 1 }}><select value={brk.day || "All"} onChange={e => updateBreakRow(i, "day", e.target.value)} style={inputSel}><option value="All">Every day</option>{DAYS.map(d => <option key={d} value={d}>{d}</option>)}</select></div>
                      <input type="time" value={brk.start} onChange={e => updateBreakRow(i, "start", e.target.value)} style={inputTime} />
                      <input type="time" value={brk.end} onChange={e => updateBreakRow(i, "end", e.target.value)} style={inputTime} />
                      <div style={{ display: "flex", gap: 2, width: 56 }}>
                        <button onClick={() => duplicateBreakRow(i)} title="Duplicate row" style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 14, padding: 2 }}>⧉</button>
                        <button onClick={() => removeBreakRow(i)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 2 }}>×</button>
                      </div>
                      {schoolHasBreaks && <span style={{ fontSize: 10, color: "#B45309", fontWeight: 500, whiteSpace: "nowrap" }}>⚠ school override</span>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px dashed ${colors.border}` }}>No breaks defined — this teacher can be scheduled in any available slot</div>
            )}
          </div>

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
      <PageTitle subtitle={`${teachers.length} teachers`} pageColor={PAGE_COLORS.teachers}
        action={<div style={{ display: "flex", gap: 8 }}><FileUpload onData={handleImport} label="Import" /><Btn onClick={newTeacher}>+ Add Teacher</Btn></div>}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        Teachers
      </PageTitle>

      {teachers.length === 0 ? (
        <EmptyState icon="🎵" title="No teachers yet" subtitle="Add teachers with their instruments, availability, and schools." action="+ Add Teacher" onAction={newTeacher} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {teachers.map(t => (
            <Card key={t.id} style={{ cursor: "pointer", padding: 0, overflow: "hidden" }} onClick={() => editTeacher(t)}>
              <div style={{ background: t.color || colors.sidebarActive, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 600, fontSize: 16, color: colors.white }}>{t.name}</div>
                <Btn variant="danger" onClick={e => { e.stopPropagation(); deleteTeacher(t.id); }} style={{ fontSize: 12, padding: "3px 10px" }}>Remove</Btn>
              </div>
              <div style={{ padding: "10px 14px" }}>
                {(t.email || t.phone) && (
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2, display: "flex", gap: 12 }}>
                    {t.email && <span>✉ {t.email}</span>}
                    {t.phone && <span>📞 {t.phone}</span>}
                  </div>
                )}
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {t.instruments.map((inst, i) => <Tag key={i} color={getInstColor(inst.name)}>{inst.name}</Tag>)}
                </div>
                <div style={{ fontSize: 12, color: colors.textLight, marginTop: 6 }}>
                  {(() => {
                    const bySchool = {};
                    for (const a of t.availability) {
                      const sName = schools.find(s => s.id === a.schoolId)?.name || "Unknown";
                      if (!bySchool[sName]) bySchool[sName] = [];
                      bySchool[sName].push(a.day.slice(0, 3));
                    }
                    if (Object.keys(bySchool).length === 0) return "No availability set";
                    return Object.entries(bySchool).map(([school, days]) => `${school}: ${[...new Set(days)].join(", ")}`).join(" · ");
                  })()}
                </div>
                {(t.teacherBreaks || []).length > 0 && (
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
                    ☕ Breaks: {(() => {
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
              </div>
            </Card>
          ))}
        </div>
      )}

      {teachers.length > 0 && (
        <Card style={{ marginTop: 20, background: colors.accentLight, borderColor: colors.accent + "40" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.accentDark, marginBottom: 6 }}>📋 Spreadsheet Import Format</div>
          <div style={{ fontSize: 12, color: colors.accentDark, lineHeight: 1.6 }}>
            Columns: <strong>name, instruments</strong> (comma-separated), <strong>schools</strong> (comma-separated school names), <strong>days</strong> (comma-separated), <strong>start_time, end_time</strong>, <strong>notes</strong>.<br />
            Each teacher will get an availability entry for each school × day combination.
          </div>
        </Card>
      )}
    </div>
  );
}
