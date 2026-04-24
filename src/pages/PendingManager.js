// ============================================================
// PENDING MANAGER (Waiting List)
// ============================================================

import React, { useState, useEffect } from "react";
import { StickyNote, Check, Trash2 } from "lucide-react";
import { DAYS } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { uid, toLocalDateStr, melbourneNow, to12h, getInstColor, clampMenuPos, getTermWeekLabel } from "../utils/helpers";
import { Tag, PageTitle, NavButtons, Btn, EmptyState, PAGE_COLORS } from "../components/ui/SharedUI";
import { enrolmentIdFor } from "../utils/enrolmentsDB";

export function PendingManager({ students, setStudents, schools, timetable, interruptions, weeklyTimetables, setWeeklyTimetables, enrolments, onSchedulePending, onViewStudent, onManualSchedule, notify, goBack, goForward, historyCursor, pageHistory }) {
  const { colors } = useTheme();
  const pendingStudents = students.filter(s => s.status === "pending" || s.status === "trial");
  const [manualSched, setManualSched] = useState({});
  const [pendingSortCol, setPendingSortCol] = useState("name");
  const [pendingSortDir, setPendingSortDir] = useState("asc");
  const [schedPopup, setSchedPopup] = useState(null);
  const schedPopupRef = React.useRef(null);
  const [confirmScheduleAll, setConfirmScheduleAll] = useState({});

  useEffect(() => {
    if (!schedPopup) return;
    const close = (e) => { if (schedPopupRef.current && schedPopupRef.current.contains(e.target)) return; setSchedPopup(null); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [schedPopup]);

  const termWeeks = (() => {
    const nowStr = toLocalDateStr(melbourneNow());
    const termBreaks = (interruptions || []).filter(i => i.type === "term_break");
    const weeks = [];
    const getMondayOf = (dt) => { const m = new Date(dt); const dow = m.getDay(); m.setDate(m.getDate() + (dow === 0 ? -6 : 1 - dow)); m.setHours(0,0,0,0); return m; };
    const sorted = [...termBreaks].sort((a, b) => a.date.localeCompare(b.date));
    let termEnd = null;
    for (const tb of sorted) { if (tb.date > nowStr) { termEnd = tb.date; break; } }
    const startMon = getMondayOf(new Date(nowStr + "T00:00:00"));
    for (let w = 0; w < 10; w++) {
      const mon = new Date(startMon); mon.setDate(startMon.getDate() + w * 7);
      const monStr = toLocalDateStr(mon);
      if (termEnd && monStr >= termEnd) break;
      const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
      const label = getTermWeekLabel(monStr, termBreaks);
      weeks.push({ weekKey: monStr, label, mon, fri });
    }
    return weeks;
  })();

  const trialScheduledMap = (() => {
    const map = {};
    for (const s of pendingStudents.filter(p => p.status === "trial")) {
      for (const [storageKey, data] of Object.entries(weeklyTimetables || {})) {
        const wk = storageKey.split("|")[0];
        const lesson = (data.lessons || []).find(l => l.studentId === s.id && l.isTrial);
        if (lesson) { map[s.id] = { storageKey, weekKey: wk, lesson }; break; }
      }
    }
    return map;
  })();

  const activateStudent = (id) => { setStudents(prev => prev.map(s => s.id === id ? { ...s, status: "active" } : s)); notify("Student moved to active — regenerate timetable to schedule them"); };
  const removeStudent = (id) => { setStudents(prev => prev.filter(s => s.id !== id)); notify("Student removed"); };

  const handleManualPlace = (studentId) => {
    const ms = manualSched[studentId];
    const student = pendingStudents.find(s => s.id === studentId);
    if (!student) return;
    if (student.status === "trial") {
      if (!ms || !ms.day || !ms.time || !ms.weekKey) return;
      const school = schools.find(sc => sc.id === student.schoolId);
      if (!school) return;
      const inst = student.instruments?.[0] || {};
      const slot = (school.slots || []).find(sl => sl.start === ms.time);
      const endTime = slot ? slot.end : ms.time;
      const storageKey = ms.weekKey + "|" + student.schoolId;
      const newLesson = { id: uid(), studentId: student.id, studentName: student.name, schoolId: student.schoolId, schoolName: school.name, instrument: inst.name || "", teacherId: inst.teacherId || "", teacherName: "", enrolmentId: enrolmentIdFor(student.id, inst.name || "", enrolments), day: ms.day, start: ms.time, end: endTime, isTrial: true, pinned: true };
      setWeeklyTimetables(prev => { const existing = prev[storageKey] || { lessons: [], missed: [] }; return { ...prev, [storageKey]: { ...existing, lessons: [...(existing.lessons || []), newLesson] } }; });
      setManualSched(prev => { const n = { ...prev }; delete n[studentId]; return n; });
      notify("Trial lesson scheduled for " + student.name);
    } else {
      if (!ms || !ms.day || !ms.time || !ms.target) return;
      if (onManualSchedule) onManualSchedule(studentId, ms.day, ms.time, ms.target);
      setManualSched(prev => { const n = { ...prev }; delete n[studentId]; return n; });
    }
  };

  const handlePendingSort = (col) => {
    if (pendingSortCol === col) setPendingSortDir(d => d === "asc" ? "desc" : "asc");
    else { setPendingSortCol(col); setPendingSortDir("asc"); }
  };

  const sortedPendingStudents = [...pendingStudents].sort((a, b) => {
    let av = "", bv = "";
    if (pendingSortCol === "name") { av = a.name || ""; bv = b.name || ""; }
    else if (pendingSortCol === "status") { av = a.status || ""; bv = b.status || ""; }
    else if (pendingSortCol === "school") { av = schools.find(sc => sc.id === a.schoolId)?.name || ""; bv = schools.find(sc => sc.id === b.schoolId)?.name || ""; }
    else if (pendingSortCol === "class") { av = a.className || ""; bv = b.className || ""; }
    else if (pendingSortCol === "instrument") { av = a.instruments?.[0]?.name || ""; bv = b.instruments?.[0]?.name || ""; }
    const cmp = av.localeCompare(bv, undefined, { numeric: true });
    return pendingSortDir === "asc" ? cmp : -cmp;
  });

  const statusLabels = { pending: "Pending", trial: "Trial" };
  const statusColors = { pending: colors.purple600, trial: colors.sidebarActive };

  return (
    <div>
      <PageTitle subtitle={`${pendingStudents.length} student${pendingStudents.length !== 1 ? "s" : ""} waiting`} pageColor={PAGE_COLORS.pending}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />} action={null}>
        Waiting List
      </PageTitle>

      {pendingStudents.length > 0 && !timetable && (
        <div style={{ marginBottom: 16, padding: 14, background: "#FEF3C7", border: "1px solid #F59E0B40", borderRadius: 10 }}>
          <div style={{ fontSize: 13, color: "#92400E" }}>Generate a timetable first, then use <strong>Schedule All Pending</strong> to add these students, or manually place them using the controls on each card.</div>
        </div>
      )}

      {pendingStudents.length === 0 ? (
        <EmptyState icon="⏳" title="No pending students" subtitle="Students set to 'Pending' or 'Trial Lesson' status will appear here." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {schools.map(school => {
            const schoolRows = sortedPendingStudents.filter(s => s.schoolId === school.id).flatMap(s =>
              ((s.instruments && s.instruments.length > 0) ? s.instruments : [{ name: "", teacherId: "" }]).map(inst => ({ ...s, _inst: inst }))
            );
            if (schoolRows.length === 0) return null;
            return (
              <div key={school.id} style={{ borderRadius: 10, overflow: "hidden", border: `2px solid ${colors.sidebarHover}` }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
                  <colgroup>
                    <col style={{ width: "20%" }} /><col style={{ width: "10%" }} /><col style={{ width: "8%" }} />
                    <col style={{ width: "20%" }} /><col style={{ width: "20%" }} /><col style={{ width: "12%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th colSpan={6} style={{ background: colors.sidebarHover, padding: "10px 14px", textAlign: "left" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ color: colors.white, fontWeight: 700, fontSize: 13 }}>{school.name}</span>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12 }}>{schoolRows.length} lesson{schoolRows.length !== 1 ? "s" : ""}</span>
                            {timetable && (
                              confirmScheduleAll[school.id] ? (
                                <div style={{ display: "flex", gap: 6, alignItems: "center", background: "rgba(255,255,255,0.12)", borderRadius: 8, padding: "3px 8px" }}>
                                  <span style={{ color: "rgba(255,255,255,0.8)", fontSize: 11, whiteSpace: "nowrap" }}>Schedule all?</span>
                                  <button onClick={() => { onSchedulePending(school.id); setConfirmScheduleAll(prev => { const n = { ...prev }; delete n[school.id]; return n; }); }} style={{ padding: "2px 8px", fontSize: 11, fontWeight: 700, border: "none", borderRadius: 5, background: colors.accent, color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>Yes</button>
                                  <button onClick={() => setConfirmScheduleAll(prev => { const n = { ...prev }; delete n[school.id]; return n; })} style={{ padding: "2px 8px", fontSize: 11, border: "1px solid rgba(255,255,255,0.3)", borderRadius: 5, background: "transparent", color: "rgba(255,255,255,0.8)", cursor: "pointer", fontFamily: "inherit" }}>No</button>
                                </div>
                              ) : (
                                <button onClick={() => setConfirmScheduleAll(prev => ({ ...prev, [school.id]: true }))} style={{ padding: "3px 8px", fontSize: 11, fontWeight: 600, border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6, background: "rgba(255,255,255,0.12)", color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>Schedule All</button>
                              )
                            )}
                          </div>
                        </div>
                      </th>
                    </tr>
                    <tr style={{ background: colors.sidebarActive }}>
                      {[{ key: "name", label: "Name" }, { key: "status", label: "Status" }, { key: "class", label: "Class" }, { key: "instrument", label: "Instrument" }, { key: null, label: "Schedule" }, { key: null, label: "" }].map((col, ci) => (
                        <th key={ci} onClick={col.key ? () => handlePendingSort(col.key) : undefined}
                          style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, fontWeight: 600, color: pendingSortCol === col.key ? colors.accent : "rgba(255,255,255,0.6)", textDecoration: pendingSortCol === col.key ? "underline" : "none", textTransform: "uppercase", letterSpacing: 0.5, cursor: col.key ? "pointer" : "default", userSelect: "none", whiteSpace: "nowrap", borderTop: "1px solid rgba(255,255,255,0.15)" }}>
                          {col.label}{pendingSortCol === col.key ? (pendingSortDir === "asc" ? " ▲" : " ▼") : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {schoolRows.map((s) => {
                      const sc = schools.find(sc2 => sc2.id === s.schoolId);
                      const ms = manualSched[s.id] || {};
                      return (
                        <tr key={s.id + (s._inst?.name || "")} style={{ borderBottom: `1px solid ${colors.borderLight}`, cursor: "pointer", background: colors.cardBg }}
                          onClick={() => onViewStudent && onViewStudent(s.id)}
                          onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                          onMouseLeave={e => e.currentTarget.style.background = colors.cardBg}>
                          <td style={{ padding: "8px 10px", fontWeight: 500, fontSize: 13 }}>
                            {s.name}
                            {s.notes && <div style={{ fontSize: 11, color: colors.textMuted, fontStyle: "italic", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}><StickyNote size={10} />{s.notes}</div>}
                          </td>
                          <td style={{ padding: "8px 10px" }}><Tag color={statusColors[s.status] || "#999"}>{statusLabels[s.status] || s.status}</Tag></td>
                          <td style={{ padding: "8px 10px", color: colors.textLight, fontSize: 12 }}>{s.className || "—"}</td>
                          <td style={{ padding: "8px 10px" }}><Tag color={getInstColor(s._inst?.name, s._inst?.isGroup)}>{s._inst?.isGroup ? "👥 " : ""}{s._inst?.name || "—"}</Tag></td>
                          <td style={{ padding: "6px 8px", position: "relative" }} onClick={e => e.stopPropagation()}>
                            {s.status === "trial" ? (() => {
                              const trialSched = trialScheduledMap[s.id];
                              if (trialSched) return <div style={{ display: "flex", alignItems: "center", gap: 5, color: colors.success, fontWeight: 600, fontSize: 12 }}><Check size={14} />Scheduled</div>;
                              return sc ? (
                                <div style={{ display: "inline-block" }}>
                                  {schedPopup && schedPopup.id === s.id && (
                                    <div ref={schedPopupRef} style={{ position: "fixed", ...clampMenuPos(schedPopup.x - 272, schedPopup.y, 272, 320), zIndex: 9999, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.14)", padding: "14px 16px", minWidth: 260 }} onClick={e => e.stopPropagation()}>
                                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                        <select value={ms.weekKey || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], weekKey: e.target.value } }))} style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                          <option value="">Select week...</option>
                                          {termWeeks.map(w => <option key={w.weekKey} value={w.weekKey}>{w.label}</option>)}
                                        </select>
                                        <select value={ms.day || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], day: e.target.value } }))} style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                          <option value="">Select day...</option>
                                          {(sc.days || DAYS).map(d => <option key={d} value={d}>{d}</option>)}
                                        </select>
                                        <select value={ms.time || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], time: e.target.value } }))} style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                          <option value="">Select time...</option>
                                          {(sc.slots || []).filter(sl => sl.type === "class" || sl.type === "before_school" || sl.type === "after_school").map(sl => <option key={sl.id} value={sl.start}>{to12h(sl.start)}</option>)}
                                        </select>
                                        <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                                          <Btn onClick={() => { handleManualPlace(s.id); setSchedPopup(null); }} disabled={!ms.day || !ms.time || !ms.weekKey} style={{ flex: 1, fontSize: 12 }}>📌 Pin lesson</Btn>
                                          <Btn variant="secondary" onClick={() => setSchedPopup(null)} style={{ fontSize: 12 }}>Cancel</Btn>
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ) : null;
                            })() : sc && (
                              <div style={{ display: "inline-block" }}>
                                {schedPopup && schedPopup.id === s.id && (
                                  <div ref={schedPopupRef} style={{ position: "fixed", ...clampMenuPos(schedPopup.x - 272, schedPopup.y, 272, 320), zIndex: 9999, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.14)", padding: "14px 16px", minWidth: 260 }} onClick={e => e.stopPropagation()}>
                                    <div style={{ fontWeight: 600, fontSize: 12, color: colors.sidebarActive, marginBottom: 10 }}>Schedule — {s.name}</div>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                      <select value={ms.day || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], day: e.target.value } }))} style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                        <option value="">Select day...</option>
                                        {(sc.days || DAYS).map(d => <option key={d} value={d}>{d}</option>)}
                                      </select>
                                      <select value={ms.time || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], time: e.target.value } }))} style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                        <option value="">Select time...</option>
                                        {(sc.slots || []).filter(sl => sl.type === "class" || sl.type === "before_school" || sl.type === "after_school").map(sl => <option key={sl.id} value={sl.start}>{to12h(sl.start)}</option>)}
                                      </select>
                                      <select value={ms.target || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], target: e.target.value } }))} style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                        <option value="">To...</option>
                                        <option value="master">Master timetable</option>
                                        <option value="weekly">This week only</option>
                                      </select>
                                      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                                        <Btn onClick={() => { handleManualPlace(s.id); setSchedPopup(null); }} disabled={!ms.day || !ms.time || !ms.target} style={{ flex: 1, fontSize: 12 }}>📌 Place</Btn>
                                        <Btn variant="secondary" onClick={() => setSchedPopup(null)} style={{ fontSize: 12 }}>Cancel</Btn>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: "6px 8px" }} onClick={e => e.stopPropagation()}>
                            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                              <button onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setSchedPopup(schedPopup && schedPopup.id === s.id ? null : { id: s.id, x: r.left, y: r.top }); }} title="Schedule student"
                                style={{ padding: "3px 8px", fontSize: 11, fontWeight: 600, border: `1px solid ${colors.sidebarHover}`, borderRadius: 6, background: colors.sidebarHover, color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>
                                Schedule
                              </button>
                              <button onClick={() => removeStudent(s.id)} title="Remove student"
                                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6, background: colors.redLight, border: `1px solid ${colors.danger}50`, color: colors.danger, cursor: "pointer", flexShrink: 0 }}>
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
