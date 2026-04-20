// ============================================================
// GROUPS MANAGER
// Drag-and-drop group creation and scheduling.
// ============================================================

import React, { useState, useEffect, useRef } from "react";
import { X, Check, StickyNote, AlertTriangle, Users, CalendarDays, Trash2 } from "lucide-react";
import { DAYS, instruments_colors } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { uid, toTimeLabel } from "../utils/helpers";
import { Card, PageTitle, NavButtons, Btn, Input, Tag, EmptyState, PAGE_COLORS } from "../components/ui/SharedUI";

export function GroupsManager({ groups, setGroups, students, schools, teachers, timetable, onRevertGroup, onAddGroupToMaster, notify, focusGroupId, onClearFocusGroup, onReturn, onViewStudent, viewState, setViewState, goBack, goForward, historyCursor, pageHistory, hideTitle = false, triggerNew = 0 }) {
  const { colors } = useTheme();
  const [form, setForm] = useState(() => {
    if (focusGroupId) { const g = groups.find(gr => gr.id === focusGroupId); return g ? { ...g, studentIds: [...(g.studentIds || [])] } : null; }
    return null;
  });
  const [editing, setEditing] = useState(() => {
    if (focusGroupId) { const g = groups.find(gr => gr.id === focusGroupId); return g ? g.id : null; }
    return null;
  });
  const [groupWarnings, setGroupWarnings] = useState({});
  const [manualSched, setManualSched] = useState(null);
  const [draggedStudentId, setDraggedStudentId] = useState(null);
  const [dragOverStudentId, setDragOverStudentId] = useState(null);
  const [dragOverGroupId, setDragOverGroupId] = useState(null);
  const [hoveredGroupId, setHoveredGroupId] = useState(null);
  const [hoveredStudentCardId, setHoveredStudentCardId] = useState(null);
  const [confirmScheduleGroupId, setConfirmScheduleGroupId] = useState(null);
  const filterSchool = (viewState || {}).filterSchool || "";
  const setFilterSchool = (v) => setViewState(prev => ({ ...prev, filterSchool: v }));

  const resetSignal = (viewState || {}).resetSignal || 0;
  const lastResetSignal = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal !== lastResetSignal.current) { lastResetSignal.current = resetSignal; setForm(null); setEditing(null); }
  }, [resetSignal]);

  const lastFocusGroupId = useRef(focusGroupId);
  useEffect(() => {
    if (focusGroupId && focusGroupId !== lastFocusGroupId.current) {
      const g = groups.find(gr => gr.id === focusGroupId);
      if (g) { setForm({ ...g, studentIds: [...(g.studentIds || [])] }); setEditing(g.id); }
    }
    if (focusGroupId) { lastFocusGroupId.current = null; if (onClearFocusGroup) onClearFocusGroup(); }
  }, [focusGroupId]);

  const groupStudents = students.filter(s => ["active", "pending", "trial"].includes(s.status) && s.instruments.some(i => i.isGroup));
  const assignedIds = new Set(groups.flatMap(g => g.studentIds || []));
  const unassignedStudents = groupStudents.filter(s => !assignedIds.has(s.id));
  const filteredUnassigned = filterSchool ? unassignedStudents.filter(s => s.schoolId === filterSchool) : unassignedStudents;
  const filteredGroups = filterSchool ? groups.filter(g => g.schoolId === filterSchool) : groups;

  const newGroup = () => { setForm({ id: uid(), name: "", schoolId: schools.length === 1 ? schools[0].id : "", instrument: "", minSize: 2, maxSize: 4, teacherId: "", studentIds: [], status: "forming", notes: "" }); setEditing("new"); };

  // External trigger from parent header button
  const triggerRef = useRef(0);
  useEffect(() => {
    if (triggerNew && triggerNew !== triggerRef.current) { triggerRef.current = triggerNew; newGroup(); }
  }, [triggerNew]); // eslint-disable-line

  const editGroup = (g) => { setForm({ ...g, studentIds: [...(g.studentIds || [])] }); setEditing(g.id); };

  const saveGroup = () => {
    if (!form.schoolId) { notify("Select a school", "warning"); return; }
    if (editing === "new") setGroups(prev => [...prev, form]);
    else setGroups(prev => prev.map(g => g.id === form.id ? form : g));
    setForm(null); setEditing(null);
    notify("Group saved!");
    if (onReturn) onReturn();
  };

  const deleteGroup = (id) => {
    const group = groups.find(g => g.id === id);
    if (group?.status === "scheduled") onRevertGroup(id);
    setGroups(prev => prev.filter(g => g.id !== id));
    notify("Group removed");
  };

  const clearAllGroups = () => {
    groups.filter(g => g.status === "scheduled").forEach(g => onRevertGroup(g.id));
    setGroups([]); setGroupWarnings({}); setManualSched(null);
    notify("All groups cleared — students returned to unassigned");
  };

  const addStudentToGroup = (studentId) => {
    if (!form || form.studentIds.includes(studentId)) return;
    setForm(prev => ({ ...prev, studentIds: [...prev.studentIds, studentId] }));
  };
  const removeStudentFromGroup = (studentId) => setForm(prev => ({ ...prev, studentIds: prev.studentIds.filter(id => id !== studentId) }));

  const handleAddToMaster = (groupId) => {
    if (!onAddGroupToMaster) return;
    const result = onAddGroupToMaster(groupId);
    if (result && !result.success) setGroupWarnings(prev => ({ ...prev, [groupId]: { reason: result.reason, showManual: true } }));
    else setGroupWarnings(prev => { const n = { ...prev }; delete n[groupId]; return n; });
  };

  const handleManualAdd = (groupId) => {
    if (!manualSched || !onAddGroupToMaster) return;
    const result = onAddGroupToMaster(groupId, manualSched.day, manualSched.time);
    if (result && result.success) { setManualSched(null); setGroupWarnings(prev => { const n = { ...prev }; delete n[groupId]; return n; }); }
  };

  if (form) {
    const schoolStudents = groupStudents.filter(s => s.schoolId === form.schoolId && !assignedIds.has(s.id) && !form.studentIds.includes(s.id));
    const formMembers = form.studentIds.map(sid => students.find(s => s.id === sid)).filter(Boolean);
    const isFull = form.studentIds.length >= form.maxSize;
    const isReady = form.studentIds.length >= form.minSize;

    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveGroup(); } }}>
        {!hideTitle && <PageTitle navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{editing === "new" ? "Create Group" : "Edit Group"}</PageTitle>}
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <Input label="Group Name (optional)" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder="e.g. Ukulele Club A" />
            <Input label="Instrument / Activity (optional)" value={form.instrument} onChange={v => setForm(p => ({ ...p, instrument: v }))} placeholder="e.g. Ukulele Club" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>School</label>
              <select value={form.schoolId} onChange={e => setForm(p => ({ ...p, schoolId: e.target.value, studentIds: [] }))} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">Select school...</option>
                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Min Size</label>
              <input type="number" min={2} max={10} value={form.minSize} onChange={e => setForm(p => ({ ...p, minSize: parseInt(e.target.value) || 2 }))} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Max Size</label>
              <input type="number" min={2} max={10} value={form.maxSize} onChange={e => setForm(p => ({ ...p, maxSize: parseInt(e.target.value) || 4 }))} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Teacher</label>
            <select value={form.teacherId || ""} onChange={e => setForm(p => ({ ...p, teacherId: e.target.value }))} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
              <option value="">Select teacher...</option>
              {teachers.filter(t => t.availability.some(a => a.schoolId === form.schoolId)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>

          <Input label="Notes" value={form.notes || ""} onChange={v => setForm(p => ({ ...p, notes: v }))} multiline placeholder="Any notes about this group..." />

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Members ({form.studentIds.length}/{form.maxSize})</label>
            {formMembers.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {formMembers.map(s => (
                  <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: colors.bg, borderRadius: 8 }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                      <span style={{ color: colors.textMuted, fontSize: 12, marginLeft: 8 }}>{s.className}</span>
                      <span style={{ color: colors.textMuted, fontSize: 12, marginLeft: 8 }}>{s.instruments.filter(i => i.isGroup).map(i => i.name).join(", ")}</span>
                    </div>
                    <button onClick={() => removeStudentFromGroup(s.id)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", padding: 4, display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "10px 12px", background: colors.bg, borderRadius: 8, border: `1px dashed ${colors.border}` }}>No members yet — add students from the list below</div>
            )}
            {isReady && <div style={{ marginTop: 6, fontSize: 12, color: colors.success, fontWeight: 500, display: "flex", alignItems: "center", gap: 5 }}><Check size={13} />Group has reached minimum size ({form.minSize})</div>}
          </div>

          {form.schoolId && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Available Students at {schools.find(s => s.id === form.schoolId)?.name}</label>
              {schoolStudents.length > 0 ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {schoolStudents.map(s => (
                    <button key={s.id} onClick={() => !isFull && addStudentToGroup(s.id)} disabled={isFull}
                      style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontFamily: "inherit", cursor: isFull ? "not-allowed" : "pointer", border: `1px solid ${colors.border}`, background: colors.cardBg, color: isFull ? colors.textMuted : colors.text, fontWeight: 500, opacity: isFull ? 0.5 : 1 }}>
                      + {s.name} <span style={{ color: colors.textMuted, marginLeft: 4 }}>{s.className}</span>
                    </button>
                  ))}
                </div>
              ) : <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic" }}>No unassigned group students at this school</div>}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveGroup}>Save Group</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); if (onReturn) onReturn(); }}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  const schoolsWithGroupStudents = [...new Set(groupStudents.map(s => s.schoolId))].map(sid => schools.find(s => s.id === sid)).filter(Boolean);

  return (
    <div>
      {!hideTitle && (
        <PageTitle subtitle={`${groups.length} ${groups.length === 1 ? "group" : "groups"} · ${unassignedStudents.length} ungrouped ${unassignedStudents.length === 1 ? "student" : "students"}`} pageColor={PAGE_COLORS.groups}
          navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          action={<Btn onClick={newGroup}>+ Create Group</Btn>}>
          Groups
        </PageTitle>
      )}

      {(schoolsWithGroupStudents.length > 1 || filteredUnassigned.length > 0) && (
        <Card style={{ marginBottom: 20, background: "rgba(52,69,101,0.07)", border: `2px solid ${colors.sidebarHover}` }}>
          {schoolsWithGroupStudents.length > 1 && (
            <div style={{ marginBottom: filteredUnassigned.length > 0 ? 12 : 0 }}>
              <select value={filterSchool} onChange={e => setFilterSchool(e.target.value)} style={{ padding: "8px 12px", border: "1px solid rgba(52,69,101,0.25)", borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: colors.cardBg }}>
                <option value="">All Schools</option>
                {schoolsWithGroupStudents.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {filteredUnassigned.length > 0 && (
            <>
              <div style={{ fontWeight: 600, fontSize: 13, color: colors.sidebarActive, marginBottom: 10 }}>Unassigned Students ({filteredUnassigned.length})</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {filteredUnassigned.map(s => {
                  const school = schools.find(sc => sc.id === s.schoolId);
                  const groupInsts = s.instruments.filter(i => i.isGroup).map(i => i.name).join(", ");
                  const isDragTarget = dragOverStudentId === s.id && draggedStudentId && draggedStudentId !== s.id;
                  return (
                    <div key={s.id} draggable
                      onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDraggedStudentId(s.id); }}
                      onDragEnd={() => { setDraggedStudentId(null); setDragOverStudentId(null); }}
                      onDragOver={e => { if (draggedStudentId && draggedStudentId !== s.id) { const ds = students.find(st => st.id === draggedStudentId); if (ds && ds.schoolId === s.schoolId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverStudentId(s.id); } else setDragOverStudentId(null); } }}
                      onDragLeave={() => setDragOverStudentId(null)}
                      onDrop={e => {
                        e.preventDefault();
                        if (draggedStudentId && draggedStudentId !== s.id) {
                          const ds = students.find(st => st.id === draggedStudentId);
                          if (ds && ds.schoolId !== s.schoolId) notify("Students must be from the same school", "warning");
                          else { const ng = { id: uid(), name: "", schoolId: s.schoolId, instrument: "", minSize: 2, maxSize: 4, teacherId: "", studentIds: [draggedStudentId, s.id], status: "forming", notes: "" }; setGroups(prev => [...prev, ng]); notify("Group created — assign a teacher to enable scheduling"); }
                        }
                        setDraggedStudentId(null); setDragOverStudentId(null);
                      }}
                      onClick={() => onViewStudent && onViewStudent(s.id)}
                      onMouseEnter={() => { if (!draggedStudentId) setHoveredStudentCardId(s.id); }}
                      onMouseLeave={() => setHoveredStudentCardId(null)}
                      style={{ padding: "8px 12px", background: isDragTarget ? "rgba(52,69,101,0.12)" : hoveredStudentCardId === s.id ? "rgba(52,69,101,0.07)" : colors.cardBg, borderRadius: 8, border: "1px solid rgba(52,69,101,0.25)", fontSize: 12, cursor: "grab", transition: "background 0.12s", opacity: draggedStudentId === s.id ? 0.4 : 1 }}>
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      <div style={{ color: colors.textMuted, marginTop: 2 }}>{school?.name} · {s.className}</div>
                      <Tag color={colors.sidebarActive} style={{ marginTop: 4 }}>{groupInsts}</Tag>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Card>
      )}

      {filteredGroups.length === 0 && filteredUnassigned.length === 0 ? (
        <EmptyState icon={<Users size={32} />} title="No group students" subtitle="Students with 'Group' or 'Club' in their instrument name will appear here for group allocation." action="+ Create Group" onAction={newGroup} />
      ) : filteredGroups.length === 0 ? (
        <Card style={{ textAlign: "center", padding: "30px 20px", color: colors.textMuted }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.textLight, marginBottom: 6 }}>No groups created yet</div>
          <div style={{ fontSize: 13 }}>Create a group to start assigning the students above.</div>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filteredGroups.map(g => {
            const school = schools.find(s => s.id === g.schoolId);
            const teacher = teachers.find(t => t.id === g.teacherId);
            const members = (g.studentIds || []).map(sid => students.find(s => s.id === sid)).filter(Boolean);
            const statusColors = { forming: "#6B7280", ready: colors.success, scheduled: colors.accent };
            const statusLabels = { forming: "Pending", ready: "Pending", scheduled: "Scheduled" };
            const scheduledLesson = timetable?.lessons.find(l => l.groupId === g.id);
            const warning = groupWarnings[g.id];
            const isHovered = hoveredGroupId === g.id && !draggedStudentId;
            const isDragOver = dragOverGroupId === g.id;
            const bgColor = isDragOver ? "rgba(217,119,6,0.08)" : isHovered ? "rgba(217,119,6,0.04)" : colors.cardBg;

            return (
              <Card key={g.id} onClick={() => editGroup(g)}
                onMouseEnter={() => setHoveredGroupId(g.id)} onMouseLeave={() => setHoveredGroupId(null)}
                onDragOver={e => { if (draggedStudentId) { const ds = students.find(st => st.id === draggedStudentId); const ok = ds && ds.schoolId === g.schoolId && !g.studentIds.includes(draggedStudentId) && g.studentIds.length < g.maxSize; if (ok) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverGroupId(g.id); } else setDragOverGroupId(null); } }}
                onDragLeave={() => setDragOverGroupId(null)}
                onDrop={e => {
                  e.preventDefault();
                  if (draggedStudentId) {
                    const ds = students.find(s => s.id === draggedStudentId);
                    if (ds && ds.schoolId !== g.schoolId) notify("Students must be from the same school", "warning");
                    else if ((g.studentIds || []).includes(draggedStudentId)) notify("Student already in this group", "warning");
                    else if (g.studentIds.length >= g.maxSize) notify("Group is full", "warning");
                    else { setGroups(prev => prev.map(gr => gr.id === g.id ? { ...gr, studentIds: [...(gr.studentIds || []), draggedStudentId] } : gr)); notify("Student added to group"); }
                  }
                  setDraggedStudentId(null); setDragOverGroupId(null);
                }}
                style={{ cursor: "pointer", borderLeft: `4px solid ${instruments_colors.Group}`, transition: "background 0.12s", background: bgColor }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 16 }}>{g.name || (members.length > 0 ? members.map(s => s.name).join(", ") : "Unnamed Group")}</span>
                      <Tag color={statusColors[g.status] || "#999"}>{statusLabels[g.status] || g.status}</Tag>
                      {g.instrument && <Tag color={instruments_colors.Group}>{g.instrument}</Tag>}
                    </div>
                    <div style={{ fontSize: 13, color: colors.textLight, marginBottom: 6, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {school && <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: school.color || colors.sidebarActive, borderRadius: 4, padding: "2px 7px", flexShrink: 0 }}>{school.name.replace(/Primary School/gi, "PS")}</span>}
                      · {teacher ? teacher.name : <span style={{ color: colors.danger, fontWeight: 600 }}>Assign teacher for auto-scheduling</span>} · {members.length}/{g.minSize}–{g.maxSize} members
                    </div>
                    {members.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>{members.map(s => <Tag key={s.id} color="#666">{s.name} ({s.className})</Tag>)}</div>}
                    {g.notes && <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic", display: "flex", alignItems: "center", gap: 5 }}><StickyNote size={11} />{g.notes}</div>}
                    {scheduledLesson && <div style={{ fontSize: 12, color: colors.accent, fontWeight: 500, marginTop: 4, display:"flex", alignItems:"center", gap:5 }}><CalendarDays size={11}/>{scheduledLesson.day} {toTimeLabel(scheduledLesson.start)}–{toTimeLabel(scheduledLesson.end)}</div>}
                    {warning && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ padding: "8px 12px", background: colors.redLight, border: `1px solid ${colors.danger}40`, borderRadius: 8, fontSize: 12, color: colors.danger, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}><AlertTriangle size={12} style={{flexShrink:0}} />{warning.reason}</div>
                        {warning.showManual && (
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: colors.textLight }}>Manual placement:</span>
                            <select value={manualSched?.groupId === g.id ? manualSched.day : ""} onChange={e => setManualSched({ groupId: g.id, day: e.target.value, time: manualSched?.time || school?.slots[0]?.start || "09:00" })} style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                              <option value="">Day...</option>
                              {(school?.days || DAYS).map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                            <select value={manualSched?.groupId === g.id ? manualSched.time : ""} onChange={e => setManualSched(prev => ({ ...prev, groupId: g.id, time: e.target.value }))} style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                              <option value="">Time...</option>
                              {(school?.slots || []).filter(s => s.type === "class").map(s => <option key={s.id} value={s.start}>{s.start}–{s.end} ({s.name})</option>)}
                            </select>
                            {manualSched?.groupId === g.id && manualSched.day && manualSched.time && <Btn variant="secondary" onClick={() => handleManualAdd(g.id)} style={{ fontSize: 12 }}>📌 Place Here</Btn>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }} onClick={e => e.stopPropagation()}>
                    {g.status === "forming" && members.length >= g.minSize && g.teacherId && timetable && (
                      confirmScheduleGroupId === g.id ? (
                        <div style={{ display: "flex", gap: 6, alignItems: "center", background: "rgba(52,69,101,0.08)", borderRadius: 8, padding: "3px 8px" }}>
                          <span style={{ fontSize: 11, color: colors.sidebarActive, fontWeight: 500, whiteSpace: "nowrap" }}>Schedule?</span>
                          <Btn variant="primary" onClick={() => { handleAddToMaster(g.id); setConfirmScheduleGroupId(null); }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6 }}>Yes</Btn>
                          <Btn variant="secondary" onClick={() => setConfirmScheduleGroupId(null)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6 }}>No</Btn>
                        </div>
                      ) : <Btn variant="primary" onClick={() => setConfirmScheduleGroupId(g.id)} style={{ fontSize: 12 }}><span style={{display:"inline-flex",alignItems:"center",gap:5}}><CalendarDays size={12}/>Schedule</span></Btn>
                    )}
                    {g.status === "forming" && members.length >= g.minSize && !timetable && <Tag color="#D97706">Ready (generate timetable first)</Tag>}
                    <Btn variant="danger" onClick={() => deleteGroup(g.id)} style={{ fontSize: 12 }}><Trash2 size={13}/></Btn>
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
