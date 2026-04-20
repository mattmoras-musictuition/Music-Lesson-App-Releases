// ============================================================
// SCHOOLS MANAGER
// ============================================================

import { Building2, X, Trash2, AlertTriangle, CalendarDays, Coffee, Info, Newspaper, Mail, Upload } from "lucide-react";
import React, { useState, useEffect } from "react";
import { DAYS, SLOT_TYPES, SLOT_TYPE_LABELS } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { uid, timeToMin, toTimeLabel } from "../utils/helpers";
import { defaultSlots } from "../utils/backup";
import { Card, PageTitle, NavButtons, Btn, Input, EmptyState, PAGE_COLORS } from "../components/ui/SharedUI";

export function SchoolsManager({ schools, setSchools, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const { colors } = useTheme();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const [slotGen, setSlotGen] = useState(null);

  useEffect(() => { setEditing(null); setForm(null); }, [resetKey]);

  const newSchool = () => {
    const f = {
      id: uid(), name: "", acronym: "", days: [...DAYS],
      slots: defaultSlots(),
      specialistPolicy: "prefer-not",
      teacherBreaks: [],
      newsletterUrl: "",
      newsletterGuidance: "",
      senderEmail: "",
      timetableUploadUrl: "",
      color: "#4A6FA5",
      notes: ""
    };
    setForm(f); setEditing("new");
  };

  const editSchool = (school) => {
    setForm({ ...school, slots: school.slots.map(s => ({ ...s })), days: [...school.days], teacherBreaks: (school.teacherBreaks || []).map(b => ({ ...b })) });
    setEditing(school.id);
  };

  const saveSchool = () => {
    if (!form.name.trim()) { notify("School name required", "warning"); return; }
    if (editing === "new") setSchools(prev => [...prev, form]);
    else setSchools(prev => prev.map(s => s.id === form.id ? form : s));
    setForm(null); setEditing(null);
    notify("School saved!");
  };

  const deleteSchool = (id) => { setSchools(prev => prev.filter(s => s.id !== id)); notify("School removed"); };
  const updateSlot = (idx, key, val) => setForm(prev => { const slots = [...prev.slots]; slots[idx] = { ...slots[idx], [key]: val }; return { ...prev, slots }; });
  const addSlot = () => setForm(prev => ({ ...prev, slots: [...prev.slots, { id: uid(), name: "", start: "09:00", end: "09:30", type: "class" }] }));
  const removeSlot = (idx) => setForm(prev => ({ ...prev, slots: prev.slots.filter((_, i) => i !== idx) }));
  const addTeacherBreak = () => setForm(prev => ({ ...prev, teacherBreaks: [...(prev.teacherBreaks || []), { id: uid(), start: "11:00", end: "11:30" }] }));
  const updateTeacherBreak = (idx, key, val) => setForm(prev => { const breaks = [...(prev.teacherBreaks || [])]; breaks[idx] = { ...breaks[idx], [key]: val }; return { ...prev, teacherBreaks: breaks }; });
  const removeTeacherBreak = (idx) => setForm(prev => ({ ...prev, teacherBreaks: (prev.teacherBreaks || []).filter((_, i) => i !== idx) }));
  const toggleDay = (day) => setForm(prev => ({ ...prev, days: prev.days.includes(day) ? prev.days.filter(d => d !== day) : [...prev.days, day] }));

  const initSlotGenerator = () => setSlotGen({ blocks: [{ start: "08:30", end: "11:00" }, { start: "11:10", end: "13:40" }, { start: "14:00", end: "15:30" }], duration: 30, includeBeforeSchool: false, beforeSchoolStart: "08:00", includeAfterSchool: false, afterSchoolStart: "15:30" });

  const generateSlots = () => {
    if (!slotGen) return;
    const slots = [];
    let slotNum = 1;
    if (slotGen.includeBeforeSchool) {
      slots.push({ id: uid(), name: "Before School", start: slotGen.beforeSchoolStart, end: `${String(Math.floor((timeToMin(slotGen.beforeSchoolStart) + slotGen.duration) / 60)).padStart(2,"0")}:${String((timeToMin(slotGen.beforeSchoolStart) + slotGen.duration) % 60).padStart(2,"0")}`, type: "before_school" });
    }
    for (const block of slotGen.blocks) {
      let current = timeToMin(block.start);
      const end = timeToMin(block.end);
      while (current + slotGen.duration <= end) {
        const startStr = `${String(Math.floor(current/60)).padStart(2,"0")}:${String(current%60).padStart(2,"0")}`;
        const endMin = current + slotGen.duration;
        const endStr = `${String(Math.floor(endMin/60)).padStart(2,"0")}:${String(endMin%60).padStart(2,"0")}`;
        slots.push({ id: uid(), name: `Slot ${slotNum}`, start: startStr, end: endStr, type: "class" });
        slotNum++; current = endMin;
      }
    }
    if (slotGen.includeAfterSchool) {
      slots.push({ id: uid(), name: "After School", start: slotGen.afterSchoolStart, end: `${String(Math.floor((timeToMin(slotGen.afterSchoolStart) + slotGen.duration) / 60)).padStart(2,"0")}:${String((timeToMin(slotGen.afterSchoolStart) + slotGen.duration) % 60).padStart(2,"0")}`, type: "after_school" });
    }
    setForm(prev => ({ ...prev, slots }));
    setSlotGen(null);
    notify(`Generated ${slots.length} slots`);
  };

  if (form) {
    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveSchool(); } }}>
        <PageTitle subtitle="Configure school timetable structure" navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{editing === "new" ? "Add School" : "Edit School"}</PageTitle>
        <Card>
          <Input label="School Name" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder="e.g. Eastwood Primary" />

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Acronym</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input value={form.acronym || ""} onChange={e => setForm(p => ({ ...p, acronym: e.target.value.toUpperCase() }))}
                placeholder={form.name ? form.name.split(" ").filter(w => w.length > 0).map(w => w[0].toUpperCase()).join("") : "e.g. EPS"}
                maxLength={8}
                style={{ width: 100, padding: "8px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", letterSpacing: 1, fontWeight: 600, textTransform: "uppercase" }} />
              <span style={{ fontSize: 12, color: colors.textMuted }}>Used on timetable exports. Leave blank to auto-derive from name initials.</span>
            </div>
          </div>

          {/* School colour */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>School Colour</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input type="color" value={form.color || "#4A6FA5"} onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                style={{ width: 38, height: 38, padding: 2, border: `1px solid ${colors.inputBorder}`, borderRadius: 8, cursor: "pointer", background: "none" }} />
              <span style={{ fontSize: 12, color: colors.textMuted }}>Shown on school selector buttons, timetable headers, and other school-specific UI.</span>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Teaching Days</label>
            <div style={{ display: "flex", gap: 8 }}>
              {DAYS.map(d => (
                <button key={d} onClick={() => toggleDay(d)} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer", border: `1px solid ${form.days.includes(d) ? colors.accent : colors.border}`, background: form.days.includes(d) ? colors.accentLight : colors.cardBg, color: form.days.includes(d) ? colors.accentDark : colors.textLight, fontWeight: 500 }}>
                  {d.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>

          <Input label="Scheduling During Specialist Classes" value={form.specialistPolicy} onChange={v => setForm(p => ({ ...p, specialistPolicy: v }))}
            options={[
              { value: "yes", label: "Allow pulling students from specialist classes for music lessons" },
              { value: "prefer-not", label: "Allow if needed, but prefer to avoid" },
              { value: "no", label: "Never schedule during specialist classes" }
            ]} />
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: -8, marginBottom: 14, paddingLeft: 2 }}>
            <span style={{display:"inline-flex",alignItems:"center",gap:5}}><Info size={12}/>Specialist class times are managed in the "Specialist Classes" section — this controls whether the scheduler can pull students out of those classes.</span>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Teacher Breaks</label>
              <Btn variant="secondary" onClick={addTeacherBreak} style={{ fontSize: 12 }}>+ Add Break</Btn>
            </div>
            <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10, paddingLeft: 2 }}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><Coffee size={12}/>Times when no teacher</span> may have lessons at this school. These override individual teacher breaks set in the Teachers tab.</div>
            {(form.teacherBreaks || []).length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(form.teacherBreaks || []).map((brk, i) => (
                  <div key={brk.id || i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                    <input type="time" value={brk.start} onChange={e => updateTeacherBreak(i, "start", e.target.value)} style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                    <span style={{ color: colors.textMuted, fontSize: 13 }}>to</span>
                    <input type="time" value={brk.end} onChange={e => updateTeacherBreak(i, "end", e.target.value)} style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                    <button onClick={() => removeTeacherBreak(i)} style={{ border: `1px solid ${colors.danger}50`, background: colors.redLight, color: colors.danger, cursor: "pointer", padding: 4, borderRadius: 6, display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px dashed ${colors.border}` }}>No breaks defined — teachers can be scheduled in any slot.</div>
            )}
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Time Slots / Periods</label>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn variant="ghost" onClick={initSlotGenerator} style={{ fontSize: 12 }}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><CalendarDays size={12}/>Generate Slots</span></Btn>
                <Btn variant="secondary" onClick={addSlot} style={{ fontSize: 12 }}>+ Add Slot</Btn>
              </div>
            </div>

            {slotGen && (
              <Card style={{ marginBottom: 14, padding: 16, background: colors.accentLight, borderColor: colors.accent + "40" }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: colors.accentDark, marginBottom: 12 }}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><CalendarDays size={13}/>Slot Generator</span></div>
                <div style={{ fontSize: 12, color: colors.accentDark, marginBottom: 14 }}>Define time blocks and a lesson duration. Slots will be generated continuously within each block, with gaps between blocks left for breaks.</div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight }}>Lesson duration:</label>
                  <select value={slotGen.duration} onChange={e => setSlotGen(prev => ({ ...prev, duration: parseInt(e.target.value) }))} style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                    {[20, 25, 30, 35, 40, 45, 50, 60].map(d => <option key={d} value={d}>{d} min</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Time Blocks</label>
                    <Btn variant="ghost" onClick={() => setSlotGen(prev => ({ ...prev, blocks: [...prev.blocks, { start: "09:00", end: "12:00" }] }))} style={{ fontSize: 11 }}>+ Add Block</Btn>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {slotGen.blocks.map((block, i) => {
                      const slotCount = Math.floor((timeToMin(block.end) - timeToMin(block.start)) / slotGen.duration);
                      return (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", background: colors.cardBg, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                          <input type="time" value={block.start} onChange={e => setSlotGen(prev => ({ ...prev, blocks: prev.blocks.map((b, idx) => idx === i ? { ...b, start: e.target.value } : b) }))} style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                          <span style={{ color: colors.textMuted, fontSize: 13 }}>to</span>
                          <input type="time" value={block.end} onChange={e => setSlotGen(prev => ({ ...prev, blocks: prev.blocks.map((b, idx) => idx === i ? { ...b, end: e.target.value } : b) }))} style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                          <span style={{ fontSize: 12, color: colors.textMuted, minWidth: 60 }}>→ {slotCount} slot{slotCount !== 1 ? "s" : ""}</span>
                          {slotGen.blocks.length > 1 && <button onClick={() => setSlotGen(prev => ({ ...prev, blocks: prev.blocks.filter((_, idx) => idx !== i) }))} style={{ border: `1px solid ${colors.danger}50`, background: colors.redLight, color: colors.danger, cursor: "pointer", padding: 4, borderRadius: 6, display: "inline-flex", alignItems: "center" }}><X size={14} /></button>}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={slotGen.includeBeforeSchool} onChange={e => setSlotGen(prev => ({ ...prev, includeBeforeSchool: e.target.checked }))} />
                    Before school at
                    <input type="time" value={slotGen.beforeSchoolStart} onChange={e => setSlotGen(prev => ({ ...prev, beforeSchoolStart: e.target.value }))} style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", width: 90 }} disabled={!slotGen.includeBeforeSchool} />
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={slotGen.includeAfterSchool} onChange={e => setSlotGen(prev => ({ ...prev, includeAfterSchool: e.target.checked }))} />
                    After school at
                    <input type="time" value={slotGen.afterSchoolStart} onChange={e => setSlotGen(prev => ({ ...prev, afterSchoolStart: e.target.value }))} style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", width: 90 }} disabled={!slotGen.includeAfterSchool} />
                  </label>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Btn onClick={generateSlots}>Generate {slotGen.blocks.reduce((sum, b) => sum + Math.floor((timeToMin(b.end) - timeToMin(b.start)) / slotGen.duration), 0) + (slotGen.includeBeforeSchool ? 1 : 0) + (slotGen.includeAfterSchool ? 1 : 0)} Slots</Btn>
                  <Btn variant="secondary" onClick={() => setSlotGen(null)}>Cancel</Btn>
                  <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 8, display: "inline-flex", alignItems: "center", gap: 4 }}><AlertTriangle size={12} />This will replace all existing slots</span>
                </div>
              </Card>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {form.slots.map((slot, i) => (
                <div key={slot.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                  <input value={slot.name} onChange={e => updateSlot(i, "name", e.target.value)} placeholder="Period name" style={{ flex: 1, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                  <input type="time" value={slot.start} onChange={e => updateSlot(i, "start", e.target.value)} style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                  <span style={{ color: colors.textMuted }}>—</span>
                  <input type="time" value={slot.end} onChange={e => updateSlot(i, "end", e.target.value)} style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                  <select value={slot.type} onChange={e => updateSlot(i, "type", e.target.value)} style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: colors.cardBg }}>
                    {SLOT_TYPES.map(t => <option key={t} value={t}>{SLOT_TYPE_LABELS[t]}</option>)}
                  </select>
                  <button onClick={() => removeSlot(i)} style={{ border: `1px solid ${colors.danger}50`, background: colors.redLight, color: colors.danger, cursor: "pointer", padding: 4, borderRadius: 6, display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
                </div>
              ))}
            </div>
          </div>

          <Input label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} multiline placeholder="Any additional notes about this school..." />
          <Input label="Newsletter URL" value={form.newsletterUrl || ""} onChange={v => setForm(p => ({ ...p, newsletterUrl: v }))} placeholder="e.g. https://schoolname.vic.edu.au/newsletters" />
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: -8, marginBottom: 8, paddingLeft: 2 }}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><Newspaper size={12}/>Link to the school</span>'s newsletter page. Used in the Interruptions tab to scan for upcoming events.</div>
          <Input label="Sender Email Address" value={form.senderEmail || ""} onChange={v => setForm(p => ({ ...p, senderEmail: v }))} placeholder="e.g. sps@mattmorasmusic.com" />
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: -8, marginBottom: 8, paddingLeft: 2 }}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><Mail size={12}/>Gmail "Send mail as"</span> alias to use when emailing this school's contacts. Must be configured in your Gmail settings.</div>
          <Input label="Timetable Upload URL" value={form.timetableUploadUrl || ""} onChange={v => setForm(p => ({ ...p, timetableUploadUrl: v }))} placeholder="e.g. https://script.google.com/macros/s/…/exec" />
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: -8, marginBottom: 8, paddingLeft: 2 }}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><Upload size={12}/>Endpoint to receive</span> timetable uploads from the Export → Send → Upload to link option.</div>
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveSchool}>Save School</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); }}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageTitle subtitle="Configure schools with their timetable structure" pageColor={PAGE_COLORS.schools}
        navButtons={<><Btn onClick={newSchool} style={{ height: 34, fontSize: 13, padding: "0 14px", background: "rgba(255,255,255,0.15)", color: "#fff", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6, fontWeight: 600 }}>+ Add School</Btn><NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} /></>}>
        Schools
      </PageTitle>

      {schools.length === 0 ? (
        <EmptyState icon={<Building2 size={32} />} title="No schools yet" subtitle="Add your first school to define its timetable periods, break times, and constraints." action="+ Add School" onAction={newSchool} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {schools.map(school => (
            <div key={school.id} style={{ borderRadius: 10, overflow: "hidden", border: `1px solid ${colors.borderLight}` }}>
              <div onClick={() => editSchool(school)}
                style={{ background: school.color || colors.sidebarHover, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}>
                <span style={{ display: "inline-flex", alignItems: "center" }}><Building2 size={15} /></span>
                <span style={{ fontWeight: 700, fontSize: 15, color: "#fff", flex: 1 }}>
                  {school.name}
                  {school.acronym && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.55)", letterSpacing: 0.5 }}>({school.acronym})</span>}
                </span>
                <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginRight: 4 }}>{school.slots.length} slots · {school.days.length} days</span>
                <button onClick={e => { e.stopPropagation(); deleteSchool(school.id); }} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "3px 8px", borderRadius: 6, background: colors.redLight, border: `1px solid ${colors.danger}50`, color: colors.danger, cursor: "pointer", flexShrink: 0 }}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
