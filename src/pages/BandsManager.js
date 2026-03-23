// ============================================================
// BANDS MANAGER
// ============================================================

import React, { useState } from "react";
import { colors, BAND_LINK_CATEGORIES, BAND_COLOR, BAND_INSTRUMENTS } from "../constants";
import { uid } from "../utils/helpers";
import { Card, PageTitle, NavButtons, Tag, EmptyState } from "../components/ui/SharedUI";
import { PAGE_COLORS } from "../components/ui/SharedUI";

// Returns first name only; adds surname initial if another member shares the same first name
function bandDisplayName(student, allMembers) {
  if (!student) return "";
  const first = (student.name || "").split(" ")[0];
  const hasDupe = allMembers.some(s => s && s.id !== student.id && (s.name || "").split(" ")[0] === first);
  if (!hasDupe) return first;
  const parts = (student.name || "").split(" ");
  return parts.length > 1 ? `${first} ${parts[1][0]}.` : first;
}

export function BandsManager({ bands, setBands, schools, students, teachers, tallyEntries, setTallyEntries, notify, goBack, goForward, historyCursor, pageHistory }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [filterSchool, setFilterSchool] = useState("");

  const newBand = () => {
    setForm({ id: uid(), name: "", schoolId: schools.length === 1 ? schools[0].id : "", teacherId: "", teacherInstrument: "", members: [], links: [], notes: "" });
    setEditing("new");
  };

  const editBand = (b) => { setForm({ ...b, members: [...(b.members || [])], links: [...(b.links || [])] }); setEditing(b.id); };

  const saveBand = () => {
    if (!form.schoolId) { notify("Select a school", "warning"); return; }
    if (editing === "new") setBands(prev => [...prev, form]);
    else setBands(prev => prev.map(b => b.id === form.id ? form : b));
    setForm(null); setEditing(null);
    notify("Band saved!");
  };

  const deleteBand = (id) => { setBands(prev => prev.filter(b => b.id !== id)); notify("Band removed"); };

  const addMember = (student) => {
    if (!form || form.members.some(m => m.studentId === student.id)) return;
    const instrument = (student.instruments && student.instruments[0]?.name) || "";
    setForm(prev => ({ ...prev, members: [...prev.members, { id: uid(), studentId: student.id, instrument }] }));
    setMemberSearch("");
  };

  const removeMember = (memberId) => setForm(prev => ({ ...prev, members: prev.members.filter(m => m.id !== memberId) }));
  const addLink = () => setForm(prev => ({ ...prev, links: [...prev.links, { id: uid(), category: BAND_LINK_CATEGORIES[0], url: "" }] }));
  const updateLink = (linkId, field, value) => setForm(prev => ({ ...prev, links: prev.links.map(l => l.id === linkId ? { ...l, [field]: value } : l) }));
  const removeLink = (linkId) => setForm(prev => ({ ...prev, links: prev.links.filter(l => l.id !== linkId) }));

  const filteredBands = filterSchool ? bands.filter(b => b.schoolId === filterSchool) : bands;
  const memberResults = form && memberSearch.trim().length > 0
    ? students.filter(s => s.schoolId === form.schoolId && s.status === "active" && !form.members.some(m => m.studentId === s.id) && s.name.toLowerCase().includes(memberSearch.toLowerCase())).slice(0, 6)
    : [];

  const inputStyle = { width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" };
  const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 };

  if (form) {
    const formMemberStudents = form.members.map(m => ({ ...m, student: students.find(s => s.id === m.studentId) })).filter(m => m.student);
    return (
      <div>
        <PageTitle pageColor={PAGE_COLORS.bands} navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
          {editing === "new" ? "New Band" : "Edit Band"}
        </PageTitle>

        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>Song Title</label>
              <input style={inputStyle} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="TBC" />
            </div>
            <div>
              <label style={labelStyle}>School</label>
              <select style={inputStyle} value={form.schoolId} onChange={e => setForm(p => ({ ...p, schoolId: e.target.value, members: [] }))}>
                <option value="">Select school…</option>
                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>Teacher</label>
              <select style={inputStyle} value={form.teacherId} onChange={e => setForm(p => ({ ...p, teacherId: e.target.value }))}>
                <option value="">Select teacher…</option>
                {teachers.filter(t => !form.schoolId || t.availability.some(a => a.schoolId === form.schoolId)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Teacher's Instrument in Band</label>
              <select style={inputStyle} value={form.teacherInstrument} onChange={e => setForm(p => ({ ...p, teacherInstrument: e.target.value }))}>
                <option value="">Not performing</option>
                {BAND_INSTRUMENTS.map(i => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Notes</label>
            <textarea style={{ ...inputStyle, minHeight: 52, resize: "vertical" }} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Any notes…" />
          </div>
        </Card>

        <Card style={{ marginBottom: 16 }}>
          <label style={{ ...labelStyle, marginBottom: 10 }}>Members ({form.members.length})</label>
          {formMemberStudents.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
              {formMemberStudents.map(({ id: memberId, instrument, instrument2, student }) => (
                <div key={memberId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: colors.bg, borderRadius: 8 }}>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{student.name}</span>
                    <span style={{ color: colors.textMuted, fontSize: 12, marginLeft: 8 }}>{student.className}</span>
                  </div>
                  <select value={instrument} onChange={e => setForm(prev => ({ ...prev, members: prev.members.map(m => m.id === memberId ? { ...m, instrument: e.target.value } : m) }))} style={{ padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", background: colors.white }}>
                    <option value="">No instrument</option>
                    {BAND_INSTRUMENTS.map(i => <option key={i} value={i}>{i}</option>)}
                  </select>
                  <select value={instrument2 || ""} onChange={e => setForm(prev => ({ ...prev, members: prev.members.map(m => m.id === memberId ? { ...m, instrument2: e.target.value || undefined } : m) }))} style={{ padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", background: colors.white, color: instrument2 ? colors.text : colors.textMuted }}>
                    <option value="">+ 2nd</option>
                    {BAND_INSTRUMENTS.map(i => <option key={i} value={i}>{i}</option>)}
                  </select>
                  <button onClick={() => removeMember(memberId)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 4, lineHeight: 1 }}>×</button>
                </div>
              ))}
            </div>
          )}
          {form.schoolId && (
            <div style={{ position: "relative" }}>
              <input style={{ ...inputStyle, paddingLeft: 32 }} value={memberSearch} onChange={e => setMemberSearch(e.target.value)} placeholder="Search students to add…" />
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: colors.textMuted }}>🔍</span>
              {memberResults.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.1)", zIndex: 100, marginTop: 2 }}>
                  {memberResults.map(s => (
                    <button key={s.id} onClick={() => addMember(s)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
                      onMouseEnter={e => e.currentTarget.style.background = colors.bg} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      <span>{s.name}</span>
                      <span style={{ fontSize: 11, color: colors.textMuted }}>{s.className} · {s.instruments.map(i => i.name).join(", ")}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {!form.schoolId && <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>Select a school first</div>}
        </Card>

        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <label style={labelStyle}>Links</label>
            <button onClick={addLink} style={{ padding: "4px 12px", background: colors.sidebarActive, color: colors.white, border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+ Add Link</button>
          </div>
          {form.links.length === 0 && <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>No links yet</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {form.links.map(link => (
              <div key={link.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select value={link.category} onChange={e => updateLink(link.id, "category", e.target.value)} style={{ padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", flexShrink: 0 }}>
                  {BAND_LINK_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input style={{ ...inputStyle, flex: 1 }} value={link.url} onChange={e => updateLink(link.id, "url", e.target.value)} placeholder="https://…" />
                <button onClick={() => removeLink(link.id)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 4, lineHeight: 1, flexShrink: 0 }}>×</button>
              </div>
            ))}
          </div>
        </Card>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={saveBand} style={{ padding: "10px 24px", background: colors.sidebarActive, color: colors.white, border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Save Band</button>
          <button onClick={() => { setForm(null); setEditing(null); }} style={{ padding: "10px 24px", background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageTitle pageColor={PAGE_COLORS.bands} navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
        action={<button onClick={newBand} style={{ padding: "0 18px", height: 36, background: colors.accent, color: colors.white, border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ New Band</button>}>
        Bands
      </PageTitle>

      {schools.length > 0 && (
        <div style={{ display: "flex", gap: 0, marginBottom: 20, borderRadius: 10, overflow: "hidden", border: `2px solid ${colors.sidebarActive}` }}>
          {[{ id: "", label: "All Schools" }, ...schools.map(s => ({ id: s.id, label: s.name.replace(/Primary School/gi, "PS") }))].map(opt => {
            const isActive = opt.id ? filterSchool === opt.id : !filterSchool;
            const bandCount = opt.id ? bands.filter(b => b.schoolId === opt.id).length : bands.length;
            return (
              <button key={opt.id || "all"} onClick={() => setFilterSchool(opt.id)}
                style={{ flex: 1, padding: "12px 16px", border: "none", borderRight: `1px solid ${colors.sidebarActive}40`, background: isActive ? colors.sidebarActive : colors.white, color: isActive ? colors.white : colors.text, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", transition: "background 0.15s, color 0.15s", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "rgba(52,69,101,0.07)"; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = colors.white; }}>
                <span>{opt.label}</span>
                <span style={{ fontSize: 11, fontWeight: 600, opacity: isActive ? 0.75 : 0.45 }}>{bandCount} {bandCount === 1 ? "band" : "bands"}</span>
              </button>
            );
          })}
        </div>
      )}

      {filteredBands.length === 0 ? (
        <EmptyState icon="🎸" title="No bands yet" subtitle="Create a band to group students working on a song together." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filteredBands.map(band => {
            const school = schools.find(s => s.id === band.schoolId);
            const teacher = teachers.find(t => t.id === band.teacherId);
            const memberStudents = (band.members || []).map(m => students.find(s => s.id === m.studentId)).filter(Boolean);
            const displayNames = memberStudents.map(s => bandDisplayName(s, memberStudents));
            return (
              <Card key={band.id} onClick={() => editBand(band)} style={{ borderLeft: `4px solid ${BAND_COLOR}`, padding: "14px 16px", cursor: "pointer" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: 15, color: colors.text }}>{band.name || "TBC"}</span>
                      {school && <Tag color={colors.textMuted}>{school.name.replace(/Primary School/gi, "PS")}</Tag>}
                    </div>
                    {teacher && <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 6 }}>{teacher.name}{band.teacherInstrument ? ` · ${band.teacherInstrument}` : ""}</div>}
                    {displayNames.length > 0 && (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                        {displayNames.map((name, i) => {
                          const member = band.members[i];
                          return <span key={member.id} style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: BAND_COLOR + "22", color: BAND_COLOR, border: `1px solid ${BAND_COLOR}44` }}>{name}{member.instrument ? ` · ${member.instrument}` : ""}</span>;
                        })}
                      </div>
                    )}
                    {(band.links || []).filter(l => l.url).length > 0 && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {band.links.filter(l => l.url).map(l => (
                          <a key={l.id} href={l.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: 11, color: colors.sidebarActive, textDecoration: "none", padding: "2px 8px", borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bg }}>🔗 {l.category}</a>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginLeft: 12, flexShrink: 0 }}>
                    <button onClick={e => { e.stopPropagation(); deleteBand(band.id); }} style={{ padding: "5px 12px", background: "none", border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 12, cursor: "pointer", fontFamily: "inherit", color: colors.danger }}>×</button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
