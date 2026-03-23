// ============================================================
// TALLYVIEW — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { colors, DAYS, TALLY_REASONS } from "../constants";
import { uid, toLocalDateStr, melbourneNow, melbourneToday, getTermWeekLabel, to12h, timeToMin, getInstColor, getSchoolAcronym, _getMondayOf, getParentEmails, openCompose } from "../utils/helpers";
import { computeTermWeekNum, computeTermKey, getTermWeeksList } from "../utils/tallyHelpers";
import { getEmailTemplates, resolveTemplate, preferredFirstName } from "../utils/emailTemplates";
import { ExportIcon } from "../components/ExportDialog";
import { Card, PageTitle, NavButtons, Btn, Tag, EmptyState, FrozenCard, PAGE_COLORS } from "../components/ui/SharedUI";

export function TallyView({ timetable, schools, students, teachers, interruptions, tallyEntries, setTallyEntries, weeklyTimetables, setWeeklyTimetables, notify, onExport, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const selectedSchool = (viewState || {}).selectedSchool ?? "all";
  const setSelectedSchool = (v) => setViewState(prev => ({ ...prev, selectedSchool: typeof v === "function" ? v(prev.selectedSchool ?? "all") : v }));
  const groupBy = (viewState || {}).groupBy || "day_school";
  const setGroupBy = (v) => setViewState(prev => ({ ...prev, groupBy: v }));
  const [editCell, setEditCell] = useState(null);
  const [editForm, setEditForm] = useState({ status: "completed", reason: "", notes: "", makeupEligible: false, madeUp: false });
  const [madeUpPopup, setMadeUpPopup] = useState(null);
  const [tallyTooltip, setTallyTooltip] = useState(null);
  const [hoveredWeekKey, setHoveredWeekKey] = useState(null);
  const [tallySearch, setTallySearch] = useState("");

  // ── Term calculation ──────────────────────────────────────────
  const termBreaks = useMemo(() =>
    interruptions.filter(i => i.type === "term_break")
      .reduce((acc, i) => { if (!acc.find(x => x.date === i.date)) acc.push(i); return acc; }, [])
      .sort((a, b) => a.date.localeCompare(b.date)),
    [interruptions]
  );

  const getMondayOf = (dt) => {
    const m = new Date(dt);
    const dow = m.getDay();
    m.setDate(m.getDate() + (dow === 0 ? -6 : 1 - dow));
    m.setHours(0, 0, 0, 0);
    return m;
  };

  const getTerms = useMemo(() => {
    const year = melbourneNow().getFullYear();
    const getTerm1Start = (y) => {
      const start = new Date(y, 0, 27);
      while (start.getDay() !== 2) start.setDate(start.getDate() + 1);
      return start;
    };
    const allBreaks = [...termBreaks];
    const terms = [];
    const years = [year - 1, year, year + 1];
    for (const y of years) {
      let termStart = getTerm1Start(y);
      const yearBreaks = allBreaks.filter(tb => {
        const d = new Date(tb.date + "T00:00:00");
        return d.getFullYear() === y || (d.getMonth() === 11 && d.getFullYear() === y);
      });
      let termNum = 1;
      for (const tb of yearBreaks) {
        const breakStart = new Date(tb.date + "T00:00:00");
        const breakEnd = new Date((tb.endDate || tb.date) + "T00:00:00");
        if (breakStart > termStart) {
          const termEnd = new Date(breakStart);
          termEnd.setDate(termEnd.getDate() - 1);
          while (termEnd.getDay() === 0 || termEnd.getDay() === 6) termEnd.setDate(termEnd.getDate() - 1);
          terms.push({ key: `${y}-T${termNum}`, label: `${y} Term ${termNum}`, start: new Date(termStart), end: termEnd, year: y, num: termNum });
          termNum++;
          termStart = new Date(breakEnd);
          termStart.setDate(termStart.getDate() + 1);
          while (termStart.getDay() === 0 || termStart.getDay() === 6) termStart.setDate(termStart.getDate() + 1);
        }
      }
      // Last term of the year
      const yearEnd = new Date(y, 11, 18);
      if (termStart <= yearEnd) {
        while (yearEnd.getDay() === 0 || yearEnd.getDay() === 6) yearEnd.setDate(yearEnd.getDate() - 1);
        terms.push({ key: `${y}-T${termNum}`, label: `${y} Term ${termNum}`, start: new Date(termStart), end: yearEnd, year: y, num: termNum });
      }
    }
    return terms;
  }, [termBreaks]);

  const currentTerm = useMemo(() => {
    const now = melbourneNow();
    return getTerms.find(t => now >= t.start && now <= t.end) || getTerms.find(t => now < t.start) || getTerms[getTerms.length - 1];
  }, [getTerms]);

  const activeTerm = currentTerm;

  // ── Term weeks list ────────────────────────────────────────
  const termWeeks = useMemo(() => {
    if (!activeTerm) return [];
    const weeks = [];
    const monday = getMondayOf(activeTerm.start);
    let w = new Date(monday);
    let weekNum = 1;
    // Always extend at least to today's week, in case the term end date is
    // miscalculated (e.g. due to a malformed term_break interruption entry).
    const todayMonday = getMondayOf(melbourneNow());
    const loopEnd = todayMonday > activeTerm.end ? todayMonday : activeTerm.end;
    while (w <= loopEnd) {
      const weekKey = toLocalDateStr(w);
      // Check if this week is entirely in a term break
      const fri = new Date(w); fri.setDate(fri.getDate() + 4);
      const inBreak = termBreaks.some(tb => {
        const bs = tb.date; const be = tb.endDate || tb.date;
        return weekKey >= bs && toLocalDateStr(fri) <= be;
      });
      if (!inBreak) weeks.push({ weekKey, weekNum, label: `W${weekNum}` });
      weekNum++;
      w = new Date(w); w.setDate(w.getDate() + 7);
    }
    return weeks;
  }, [activeTerm, termBreaks]);

  // ── Term-filtered entries (tallyEntries is now App-level state) ───────────

  // ── Lessons from master timetable ─────────────────────────
  const schoolLessons = useMemo(() => {
    if (!timetable) return [];
    return selectedSchool === "all"
      ? timetable.lessons
      : timetable.lessons.filter(l => l.schoolId === selectedSchool);
  }, [timetable, selectedSchool]);

  // Unique lesson identifiers: one row per student/group+instrument
  const lessonRows = useMemo(() => {
    const seen = new Set();
    const rows = [];
    for (const l of schoolLessons) {
      const key = l.isGroup ? `group|${l.groupId}` : `${l.studentId}|${l.instrument}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...l, lessonKey: key });
    }
    rows.sort((a, b) => {
      const nameA = (a.isGroup ? (a.groupName || "") : (a.studentName || "")).toLowerCase();
      const nameB = (b.isGroup ? (b.groupName || "") : (b.studentName || "")).toLowerCase();
      return nameA.localeCompare(nameB);
    });
    return rows;
  }, [schoolLessons]);

  // ── Entry lookup ────────────────────────────────────────────
  const entryMap = useMemo(() => {
    if (!activeTerm) return {};
    // Build set of valid weekKeys for this term so we only show relevant entries
    const validWeekKeys = new Set(termWeeks.map(w => w.weekKey));
    const map = {};
    for (const e of tallyEntries) {
      if (selectedSchool !== "all" && e.schoolId !== selectedSchool) continue;
      if (!validWeekKeys.has(e.weekKey)) continue;
      map[`${e.lessonKey}|${e.weekKey}`] = e;
    }
    return map;
  }, [tallyEntries, activeTerm, selectedSchool, termWeeks]);

  // ── Cycle status on left click ─────────────────────────────
  // Order: unchecked → completed → missed+catchup owed → caught up (↺) → missed no catchup → inactive → unchecked
  const quickComplete = (lesson, week) => {
    const key = `${lesson.lessonKey}|${week.weekKey}`;
    const existing = entryMap[key];
    const baseEntry = {
      lessonKey: lesson.lessonKey, lessonId: lesson.id,
      isGroup: lesson.isGroup || false, groupName: lesson.groupName || "",
      studentId: lesson.studentId || "",
      studentName: lesson.isGroup ? (lesson.groupName || lesson.studentNames?.join(", ") || "Group") : lesson.studentName,
      studentNames: lesson.studentNames || [],
      instrument: lesson.instrument, schoolId: lesson.schoolId,
      teacherId: lesson.teacherId, teacherName: lesson.teacherName,
      weekKey: week.weekKey, weekLabel: week.label, weekNum: week.weekNum,
      termKey: activeTerm?.key, day: lesson.day,
      notes: existing?.notes || "",
      recordedAt: new Date().toISOString(),
    };
    const upsert = (patch) => {
      const entry = { id: existing?.id || uid(), ...baseEntry, ...patch };
      setTallyEntries(prev => [...prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== key), entry]);
    };
    const status = existing?.status;
    if (!existing || status === "removed") {
      // unchecked (or inactive) → completed
      upsert({ status: "completed", reason: null, makeupEligible: false, madeUp: false });
    } else if (status === "completed") {
      // completed → missed + catch-up owed
      upsert({ status: "missed", reason: null, makeupEligible: true, madeUp: false });
    } else if (status === "missed" && existing.makeupEligible && !existing.madeUp) {
      // missed+catchup owed → caught up (↺)
      upsert({ status: "missed", reason: existing.reason || null, makeupEligible: true, madeUp: true });
    } else if (status === "missed" && existing.madeUp) {
      // caught up → missed no catchup
      upsert({ status: "missed", reason: existing.reason || null, makeupEligible: false, madeUp: false });
    } else if (status === "missed" && !existing.makeupEligible) {
      // missed no catchup → inactive (removed)
      upsert({ status: "removed", reason: "inactive", makeupEligible: false, madeUp: false });
    } else {
      // any other state → unchecked
      setTallyEntries(prev => prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== key));
    }
  };

  // ── Edit cell ───────────────────────────────────────────────
  const openEdit = (lesson, week) => {
    const key = `${lesson.lessonKey}|${week.weekKey}`;
    const existing = entryMap[key];
    setEditCell({ lesson, week, key });
    setEditForm(existing ? {
      status: existing.status,
      reason: existing.reason || "",
      notes: existing.notes || "",
      makeupEligible: existing.makeupEligible || false,
      madeUp: existing.madeUp || false,
    } : { status: "completed", reason: "", notes: "", makeupEligible: false, madeUp: false });
  };

  const saveEdit = () => {
    if (!editCell) return;
    const { lesson, week, key } = editCell;
    const reasonObj = TALLY_REASONS.find(r => r.value === editForm.reason);
    const makeupEligible = reasonObj?.makeupEligible === null ? editForm.makeupEligible : (reasonObj?.makeupEligible || false);
    const newEntry = {
      id: uid(),
      lessonKey: lesson.lessonKey,
      lessonId: lesson.id,
      isGroup: lesson.isGroup || false,
      groupName: lesson.groupName || "",
      studentId: lesson.studentId || "",
      studentName: lesson.isGroup ? (lesson.groupName || lesson.studentNames?.join(", ") || "Group") : lesson.studentName,
      studentNames: lesson.studentNames || [],
      instrument: lesson.instrument,
      schoolId: lesson.schoolId,
      teacherId: lesson.teacherId,
      teacherName: lesson.teacherName,
      weekKey: week.weekKey,
      weekNum: week.weekNum,
      termKey: activeTerm.key,
      day: lesson.day,
      status: "missed",
      reason: editForm.reason,
      notes: editForm.notes.trim(),
      makeupEligible,
      madeUp: makeupEligible ? editForm.madeUp : false,
      recordedAt: new Date().toISOString(),
    };
    setTallyEntries(prev => [...prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== key), newEntry]);
    setEditCell(null);
  };

  const clearEntry = () => {
    if (!editCell) return;
    setTallyEntries(prev => prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== editCell.key));
    setEditCell(null);
  };

  // ── Summary stats ───────────────────────────────────────────
  const stats = useMemo(() => {
    const marked = Object.values(entryMap);
    const removed = marked.filter(e => e.status === "removed").length;
    const totalCells = lessonRows.length * termWeeks.length - removed;
    const completed = marked.filter(e => e.status === "completed").length;
    const missed = marked.filter(e => e.status === "missed").length;
    const makeupOwed = marked.filter(e => e.status === "missed" && e.makeupEligible && !e.madeUp).length;
    const madeUp = marked.filter(e => e.madeUp).length;
    return { totalCells, completed, missed, makeupOwed, madeUp, unmarked: totalCells - completed - missed };
  }, [entryMap, lessonRows, termWeeks]);

  // ── Grouping ────────────────────────────────────────────────
  const groupedRows = useMemo(() => {
    const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    if (groupBy === "day_school") {
      const groups = {};
      for (const r of lessonRows) {
        const schoolName = schools.find(s => s.id === r.schoolId)?.name || "Unknown";
        const dayIdx = DAY_ORDER.indexOf(r.day || "");
        const k = `${String(dayIdx).padStart(2, "0")}|${r.day || "Unknown"} — ${schoolName}`;
        if (!groups[k]) groups[k] = [];
        groups[k].push(r);
      }
      return Object.entries(groups)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, rows]) => [k.split("|")[1], rows.sort((a, b) => (a.studentName || "").localeCompare(b.studentName || ""))]);
    }
    if (groupBy === "teacher") {
      const groups = {};
      for (const r of lessonRows) {
        const k = r.teacherName || "Unknown";
        if (!groups[k]) groups[k] = [];
        groups[k].push(r);
      }
      return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
    }
    if (groupBy === "day") {
      const groups = {};
      for (const r of lessonRows) {
        const k = r.day || "Unknown";
        if (!groups[k]) groups[k] = [];
        groups[k].push(r);
      }
      return Object.entries(groups).sort(([a], [b]) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
    }
    if (groupBy === "school") {
      const groups = {};
      for (const r of lessonRows) {
        const schoolName = schools.find(s => s.id === r.schoolId)?.name || "Unknown";
        if (!groups[schoolName]) groups[schoolName] = [];
        groups[schoolName].push(r);
      }
      return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
    }
    if (groupBy === "makeups") {
      const withCounts = lessonRows.map(r => {
        const makeupCount = Object.values(entryMap).filter(e =>
          e.lessonKey === r.lessonKey && e.status === "missed" && e.makeupEligible && !e.madeUp
        ).length;
        return { ...r, _makeupCount: makeupCount };
      }).filter(r => r._makeupCount > 0)
        .sort((a, b) => b._makeupCount - a._makeupCount);
      if (withCounts.length === 0) return [["No makeups owed", []]];
      const groups = {};
      for (const r of withCounts) {
        const k = `${r._makeupCount} makeup${r._makeupCount !== 1 ? "s" : ""} owed`;
        if (!groups[k]) groups[k] = [];
        groups[k].push(r);
      }
      return Object.entries(groups);
    }
    return [["All Students", lessonRows]];
  }, [lessonRows, groupBy, schools, entryMap]);

  // ── Cell render ─────────────────────────────────────────────
  const CellIcon = ({ entry, isFuture }) => {
    if (!entry) {
      return <span style={{ color: isFuture ? "#9CA3AF" : "#4B5563", fontSize: 16, lineHeight: 1 }}>○</span>;
    }
    if (entry.status === "removed") return <span style={{ color: "#D1D5DB", fontSize: 14, fontWeight: 700, lineHeight: 1 }}>—</span>;
    if (entry.status === "completed") return <span style={{ color: "#16A34A", fontSize: 16 }}>✓</span>;
    if (entry.status === "missed") {
      if (entry.madeUp) return <span style={{ color: colors.sidebarActive, fontSize: 16, lineHeight: 1 }}>↺</span>;
      if (entry.makeupEligible) return <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", background: "#D97706" }} />;
      return <span style={{ color: "#DC2626", fontSize: 14, fontWeight: 700 }}>✕</span>;
    }
    return null;
  };

  const todayStr = melbourneToday();
  const isFutureWeek = (weekKey) => weekKey > todayStr;

  // ── Render ──────────────────────────────────────────────────
  const pageColor = PAGE_COLORS.tally;
  const headerBg = colors.sidebarActive;

  if (!timetable) {
    return (
      <div>
        <PageTitle subtitle="Track lesson completion across all schools and teachers" pageColor={PAGE_COLORS.tally}>Master Tally</PageTitle>
        <div style={{ padding: 40, textAlign: "center", color: "#6B7280" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✓</div>
          <div style={{ fontWeight: 600, fontSize: 16 }}>No master timetable yet</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Generate a master timetable first to use the Tally.</div>
        </div>
      </div>
    );
  }

  return (
    <div onClick={() => editCell && setEditCell(null)}>
      <PageTitle subtitle={activeTerm ? activeTerm.label : "Track lesson completion across all schools and teachers"}
        pageColor={PAGE_COLORS.tally}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
        action={<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {schools.map(s => {
            const abbr = getSchoolAcronym(s);
            const active = selectedSchool === s.id;
            return (
              <Btn key={s.id} onClick={() => setSelectedSchool(active ? "all" : s.id)}
                variant={active ? "primary" : "secondary"}>🏫 {abbr}</Btn>
            );
          })}
          <select value={groupBy} onChange={e => setGroupBy(e.target.value)}
            style={{ height: 34, padding: "0 12px", border: `2px solid ${colors.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: colors.white, fontWeight: 600, cursor: "pointer", boxSizing: "border-box", marginTop: -2 }}>
            <option value="day_school">Day &amp; School</option>
            <option value="teacher">By Teacher</option>
            <option value="day">By Day</option>
            <option value="school">By School</option>
            <option value="makeups">Makeups Owed</option>
          </select>
          {onExport && <Btn onClick={() => onExport(null, "", "tally")}>{ExportIcon}Export</Btn>}
        </div>}>
        Master Tally
      </PageTitle>

      {/* Summary cards */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "nowrap", overflowX: "auto" }}>
        {[
          { label: "Not Yet Marked", value: stats.unmarked, color: "#6B7280", bg: "#F9FAFB", icon: "○" },
          { label: "Completed", value: stats.completed, color: "#16A34A", bg: "#F0FDF4", icon: "✓" },
          { label: "Absent (no makeup)", value: stats.missed - stats.makeupOwed - stats.madeUp, color: "#DC2626", bg: "#FEF2F2", icon: "✕" },
          { label: "Makeup Owed", value: stats.makeupOwed, color: "#D97706", bg: "#FFFBEB", icon: "●" },
          { label: "Made Up", value: stats.madeUp, color: colors.sidebarActive, bg: "rgba(52,69,101,0.07)", icon: "↺" },
        ].map(s => (
          <div key={s.label} style={{ background: s.bg, border: `1px solid ${s.color}22`, borderRadius: 10, padding: "10px 18px", flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap" }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: s.color, lineHeight: 1, flexShrink: 0 }}>{s.value}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", lineHeight: 1.3 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Search + Legend row */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14, flexWrap: "wrap" }}>
        <input
          value={tallySearch} onChange={e => setTallySearch(e.target.value)}
          placeholder="Search student…"
          style={{ padding: "6px 12px", border: `1.5px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", width: 180, flexShrink: 0 }}
        />
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#6B7280", flexWrap: "wrap", flex: 1, justifyContent: "flex-end" }}>
          {[
            { icon: "○", color: "#9CA3AF", label: "Unmarked" },
            { icon: "✓", color: "#16A34A", label: "Completed" },
            { icon: "●", color: "#D97706", label: "Makeup owed" },
            { icon: "↺", color: colors.sidebarActive, label: "Caught up" },
            { icon: "✕", color: "#DC2626", label: "No catch-up" },
            { icon: "—", color: "#D1D5DB", label: "Inactive" },
          ].map(l => (
            <span key={l.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: l.color, fontWeight: 700, fontSize: 14 }}>{l.icon}</span> {l.label}
            </span>
          ))}
        </div>
      </div>

      {/* Grid */}
      {Object.keys(weeklyTimetables || {}).length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "#9CA3AF" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📅</div>
          <div style={{ fontWeight: 600, fontSize: 15, color: "#6B7280", marginBottom: 6 }}>No weekly timetables generated yet</div>
          <div style={{ fontSize: 13 }}>Head to the <strong>Weekly Adjustments</strong> tab and generate a week to start tracking lessons.</div>
        </div>
      ) : lessonRows.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "#9CA3AF" }}>No lessons scheduled at this school.</div>
      ) : (
        <div style={{ overflowX: "auto", overflowY: "auto", borderRadius: 10, border: "1px solid #E5E7EB", maxHeight: "calc(100vh - 212px)" }}>
          <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", minWidth: 600 }}>
            <thead style={{ position: "sticky", top: 0, zIndex: 4 }}>
              <tr style={{ background: headerBg }}>
                <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: colors.white, borderBottom: `2px solid ${colors.sidebarHover}`, position: "sticky", left: 0, background: headerBg, zIndex: 2, minWidth: 180, whiteSpace: "nowrap" }}>
                  Student / Group
                </th>
                <th style={{ padding: "10px 8px", textAlign: "center", fontWeight: 600, fontSize: 11, color: "rgba(255,255,255,0.7)", borderBottom: `2px solid ${colors.sidebarHover}`, whiteSpace: "nowrap" }}>
                  Instrument
                </th>
                {termWeeks.map(w => (
                  <th key={w.weekKey} style={{ padding: "8px 4px", textAlign: "center", fontWeight: 600, fontSize: 11, color: isFutureWeek(w.weekKey) ? "rgba(255,255,255,0.3)" : colors.white, borderBottom: `2px solid ${colors.sidebarHover}`, minWidth: 36, background: hoveredWeekKey === w.weekKey ? colors.sidebarHover : headerBg, transition: "background 0.1s" }}
                    onMouseEnter={() => setHoveredWeekKey(w.weekKey)}
                    onMouseLeave={() => setHoveredWeekKey(null)}>
                    {w.label}
                  </th>
                ))}
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 600, fontSize: 11, color: colors.white, borderBottom: `2px solid ${colors.sidebarHover}`, whiteSpace: "nowrap" }}>
                  Summary
                </th>
              </tr>
            </thead>
            <tbody>
              {groupedRows.map(([groupLabel, rows]) => {
                const filteredRows = tallySearch.trim()
                  ? rows.filter(r => (r.studentName || r.groupName || "").toLowerCase().includes(tallySearch.trim().toLowerCase()))
                  : rows;
                if (filteredRows.length === 0) return null;
                return (
                <React.Fragment key={groupLabel}>
                  {groupBy !== "none" && groupBy !== "makeups" && (
                    <tr>
                      <td colSpan={termWeeks.length + 3} style={{ padding: "6px 14px", fontSize: 11, fontWeight: 700, color: "#fff", background: pageColor, letterSpacing: "0.05em", textTransform: "uppercase", position: "sticky", top: 36, zIndex: 3, borderBottom: `1px solid ${colors.sidebarHover}` }}>
                        {groupLabel}
                      </td>
                    </tr>
                  )}
                  {groupBy === "makeups" && (
                    <tr>
                      <td colSpan={termWeeks.length + 3} style={{ padding: "8px 14px 4px", fontSize: 11, fontWeight: 700, color: "#fff", background: colors.warning, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                        {groupLabel}
                      </td>
                    </tr>
                  )}
                  {filteredRows.map((lesson, ri) => {
                    const displayName = lesson.isGroup
                      ? (lesson.groupName || lesson.studentNames?.join(", ") || "Group")
                      : lesson.studentName;
                    const student = lesson.isGroup ? null : students.find(s => s.id === lesson.studentId);
                    const className = student?.className || "";
                    const rowEntries = termWeeks.map(w => entryMap[`${lesson.lessonKey}|${w.weekKey}`] || null);
                    const rowCompleted = rowEntries.filter(e => e?.status === "completed").length;
                    const rowMissed = rowEntries.filter(e => e?.status === "missed").length;
                    const rowMakeup = rowEntries.filter(e => e?.status === "missed" && e.makeupEligible && !e.madeUp).length;
                    const rowMadeUp = rowEntries.filter(e => e?.madeUp).length;
                    const rowBg = ri % 2 === 0 ? "#fff" : "#F9FAFB";
                    return (
                      <tr key={lesson.lessonKey} style={{ background: rowBg }}>
                        <td style={{ padding: "8px 14px", borderBottom: "1px solid #F3F4F6", position: "sticky", left: 0, background: rowBg, zIndex: 1 }}>
                          <div style={{ fontWeight: 500, fontSize: 13, color: "#111827" }}>{displayName}</div>
                          {selectedSchool === "all" && <div style={{ fontSize: 10, color: "#6366F1", fontWeight: 600 }}>{getSchoolAcronym(schools.find(s => s.id === lesson.schoolId))}</div>}
                          {selectedSchool !== "all" && className && <div style={{ fontSize: 11, color: "#9CA3AF" }}>{className}</div>}
                        </td>
                        <td style={{ padding: "8px 8px", borderBottom: "1px solid #F3F4F6", textAlign: "center", fontSize: 12, color: "#6B7280", whiteSpace: "nowrap" }}>
                          {lesson.instrument}
                          <div style={{ fontSize: 10, color: "#D1D5DB" }}>{lesson.day}</div>
                        </td>
                        {termWeeks.map((w, wi) => {
                          const entry = rowEntries[wi];
                          const future = isFutureWeek(w.weekKey);
                          const isEditing = editCell?.key === `${lesson.lessonKey}|${w.weekKey}`;
                          return (
                            <td key={w.weekKey} style={{ padding: "6px 2px", borderBottom: "1px solid #F3F4F6", textAlign: "center", cursor: (future && !entry) ? "default" : "pointer", position: "relative", background: hoveredWeekKey === w.weekKey ? "#F3F4F6" : "transparent", transition: "background 0.1s" }}
                              onClick={e => { e.stopPropagation(); if (!future || entry) quickComplete(lesson, w); }}
                              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (entry?.madeUp) { setMadeUpPopup({ x: e.clientX, y: e.clientY, weekNum: w.label }); } else if (!future || entry) openEdit(lesson, w); }}
                              onMouseEnter={e => {
                                setHoveredWeekKey(w.weekKey);
                                const r = e.currentTarget.getBoundingClientRect();
                                const madeUpWeekLabel = entry?.madeUp && entry?.madeUpWeekKey
                                  ? (termWeeks.find(tw => tw.weekKey === (entry.madeUpWeekKey || "").split("|")[0])?.label || null)
                                  : null;
                                const text = entry?.status === "removed"
                                  ? "Inactive (click to cycle to completed)"
                                  : entry?.status === "completed" ? (entry.bandSession ? (entry.notes || "Band Session") : "Completed" + (entry.notes ? " — " + entry.notes : ""))
                                  : entry?.status === "missed" && entry?.madeUp ? ("↺ Caught up" + (madeUpWeekLabel ? " — " + madeUpWeekLabel : ""))
                                  : entry?.status === "missed" && entry?.makeupEligible ? ("Missed — catch-up owed")
                                  : entry?.status === "missed" ? ("Missed — no catch-up")
                                  : future ? "Future week" : "Unmarked";
                                setTallyTooltip({ text, x: r.left + r.width / 2, y: r.top - 6 });
                              }}
                              onMouseLeave={() => { setHoveredWeekKey(null); setTallyTooltip(null); }}>
                              <div style={{ width: 28, height: 28, margin: "0 auto", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: isEditing ? "rgba(52,69,101,0.07)" : entry ? (entry.status === "completed" ? "#F0FDF4" : entry.status === "removed" ? "#F9FAFB" : entry.madeUp ? "rgba(52,69,101,0.07)" : entry.makeupEligible ? "#FFFBEB" : "#FEF2F2") : "transparent", border: isEditing ? "2px solid #3B82F6" : "none" }}>
                                <CellIcon entry={entry} isFuture={future} />
                              </div>
                            </td>
                          );
                        })}
                        <td style={{ padding: "8px 12px", borderBottom: "1px solid #F3F4F6", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", fontSize: 11 }}>
                            <span style={{ color: "#16A34A", fontWeight: 600 }}>{rowCompleted}✓</span>
                            {(rowMissed - rowMakeup - rowMadeUp) > 0 && <span style={{ color: "#DC2626", fontWeight: 600 }}>{rowMissed - rowMakeup - rowMadeUp}✕</span>}
                            {rowMakeup > 0 && <span style={{ color: "#D97706", fontWeight: 600 }}>{rowMakeup}●</span>}
                            {rowMadeUp > 0 && <span style={{ color: colors.sidebarActive, fontWeight: 600 }}>{rowMadeUp}↺</span>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Made-up popup on right-click */}
      {madeUpPopup && (
        <div style={{ position: "fixed", inset: 0, zIndex: 999 }} onClick={() => setMadeUpPopup(null)}>
          <div style={{ position: "fixed", top: madeUpPopup.y, left: madeUpPopup.x, zIndex: 1000, background: "rgba(52,69,101,0.07)", border: "1px solid rgba(52,69,101,0.25)", borderRadius: 8, padding: "10px 16px", fontSize: 13, color: colors.sidebarActive, fontWeight: 600, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", whiteSpace: "nowrap" }}
            onClick={e => e.stopPropagation()}>
            ↺ Caught up in {madeUpPopup.weekNum}
          </div>
        </div>
      )}
      {/* Instant tooltip for removed cells */}
      {tallyTooltip && (
        <div style={{ position: "fixed", left: tallyTooltip.x, top: tallyTooltip.y, transform: "translate(-50%, -100%)", background: "rgba(30,30,30,0.92)", color: "#fff", fontSize: 12, padding: "4px 9px", borderRadius: 6, pointerEvents: "none", zIndex: 9999, whiteSpace: "nowrap" }}>
          {tallyTooltip.text}
        </div>
      )}

      {/* Edit modal */}
      {editCell && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setEditCell(null)}>
          <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: 340, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", maxHeight: "90vh", overflowY: "auto" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 4 }}>
              {editCell.lesson.isGroup ? (editCell.lesson.groupName || "Group") : editCell.lesson.studentName}
            </div>
            <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 18 }}>
              {editCell.lesson.instrument} · {editCell.lesson.day} · {editCell.week.label} ({activeTerm?.label})
            </div>

            {/* Notes */}
            <div style={{ marginBottom: 14 }}>
              <textarea value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Notes (optional) — e.g. Will catch up Thursday lunch…"
                style={{ width: "100%", padding: "8px 10px", border: "1px solid #D1D5DB", borderRadius: 7, fontSize: 13, fontFamily: "inherit", resize: "vertical", minHeight: 52, boxSizing: "border-box", color: "#374151" }} />
              <button onClick={() => {
                const existing = entryMap[editCell.key];
                if (existing) {
                  setTallyEntries(prev => prev.map(e => `${e.lessonKey}|${e.weekKey}` === editCell.key ? { ...e, notes: editForm.notes.trim() } : e));
                } else {
                  // Save as completed with just a note
                  const newEntry = {
                    id: uid(),
                    lessonKey: editCell.lesson.lessonKey, lessonId: editCell.lesson.id,
                    isGroup: editCell.lesson.isGroup || false, groupName: editCell.lesson.groupName || "",
                    studentId: editCell.lesson.studentId || "",
                    studentName: editCell.lesson.isGroup ? (editCell.lesson.groupName || editCell.lesson.studentNames?.join(", ") || "Group") : editCell.lesson.studentName,
                    studentNames: editCell.lesson.studentNames || [],
                    instrument: editCell.lesson.instrument, schoolId: editCell.lesson.schoolId,
                    teacherId: editCell.lesson.teacherId, teacherName: editCell.lesson.teacherName,
                    weekKey: editCell.week.weekKey, weekLabel: editCell.week.label, weekNum: editCell.week.weekNum,
                    termKey: activeTerm?.key, day: editCell.lesson.day,
                    status: "completed", reason: "",
                    notes: editForm.notes.trim(),
                    makeupEligible: false, madeUp: false,
                    recordedAt: new Date().toISOString(),
                  };
                  setTallyEntries(prev => [...prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== editCell.key), newEntry]);
                }
                setEditCell(null);
              }} style={{ marginTop: 6, width: "100%", padding: "7px 0", borderRadius: 7, background: "#F0FDF4", color: "#16A34A", fontWeight: 600, fontSize: 13, border: "1px solid #BBF7D0", cursor: "pointer", fontFamily: "inherit" }}>
                Save note
              </button>
            </div>

            {/* Missed reasons */}
            <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Why was this lesson missed?</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {TALLY_REASONS.filter(r => !r.invisible).map(r => {
                const makeupElig = r.makeupEligible === null ? editForm.makeupEligible : (r.makeupEligible || false);
                const isCurrentReason = entryMap[editCell.key]?.reason === r.value;
                return (
                  <button key={r.value} onClick={() => {
                        const newEntry = {
                          id: uid(),
                          lessonKey: editCell.lesson.lessonKey, lessonId: editCell.lesson.id,
                          isGroup: editCell.lesson.isGroup || false, groupName: editCell.lesson.groupName || "",
                          studentId: editCell.lesson.studentId || "",
                          studentName: editCell.lesson.isGroup ? (editCell.lesson.groupName || editCell.lesson.studentNames?.join(", ") || "Group") : editCell.lesson.studentName,
                          studentNames: editCell.lesson.studentNames || [],
                          instrument: editCell.lesson.instrument, schoolId: editCell.lesson.schoolId,
                          teacherId: editCell.lesson.teacherId, teacherName: editCell.lesson.teacherName,
                          weekKey: editCell.week.weekKey, weekLabel: editCell.week.label, weekNum: editCell.week.weekNum,
                          termKey: activeTerm?.key, day: editCell.lesson.day,
                          status: "missed", reason: r.value,
                          notes: editForm.notes.trim(),
                          makeupEligible: makeupElig, madeUp: false,
                          recordedAt: new Date().toISOString(),
                        };
                        setTallyEntries(prev => [...prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== editCell.key), newEntry]);
                        if (setWeeklyTimetables) {
                          const wKey = editCell.week.weekKey;
                          const reasonLabel = TALLY_REASONS.find(tr => tr.value === r.value)?.label || r.value;
                          setWeeklyTimetables(prev => {
                            const next = { ...prev };
                            for (const storeKey of Object.keys(next)) {
                              if (!storeKey.startsWith(wKey + "|")) continue;
                              const ent = next[storeKey];
                              if (!ent?.missed) continue;
                              next[storeKey] = { ...ent, missed: ent.missed.map(m => {
                                const mKey = m.isGroup ? `group|${m.groupId}` : `${m.studentId}|${m.instrument}`;
                                return mKey === editCell.lesson.lessonKey ? { ...m, reason: reasonLabel } : m;
                              })};
                            }
                            return next;
                          });
                        }
                        setEditCell(null);
                      }}
                      style={{ padding: "9px 12px", borderRadius: 7, border: isCurrentReason ? "2px solid " + colors.accentDark : "1.5px solid #E5E7EB", background: isCurrentReason ? colors.accentLight : "#fff", color: isCurrentReason ? colors.accentDark : "#374151", fontWeight: isCurrentReason ? 700 : 400, fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                      onMouseEnter={e => { if (!isCurrentReason) e.currentTarget.style.background = colors.accentLight; }}
                      onMouseLeave={e => { if (!isCurrentReason) e.currentTarget.style.background = "#fff"; }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {isCurrentReason && <span style={{ fontSize: 10, color: colors.accentDark }}>✓</span>}
                        {r.label}
                      </span>
                      {r.makeupEligible === true && <span style={{ fontSize: 11, color: "#D97706", fontWeight: 600 }}>● makeup owed</span>}
                      {r.makeupEligible === false && <span style={{ fontSize: 11, color: "#9CA3AF" }}>no makeup</span>}
                  </button>
                );
              })}
            </div>

            {/* Remove from tally section */}
            <div style={{ borderTop: "1px solid #F3F4F6", paddingTop: 12, marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", marginBottom: 8 }}>Remove from tally entirely</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {TALLY_REASONS.filter(r => r.invisible).map(r => {
                  const isCurrentReason = entryMap[editCell.key]?.reason === r.value;
                  return (
                    <button key={r.value} onClick={() => {
                          const newEntry = {
                            id: uid(),
                            lessonKey: editCell.lesson.lessonKey, lessonId: editCell.lesson.id,
                            isGroup: editCell.lesson.isGroup || false, groupName: editCell.lesson.groupName || "",
                            studentId: editCell.lesson.studentId || "",
                            studentName: editCell.lesson.isGroup ? (editCell.lesson.groupName || editCell.lesson.studentNames?.join(", ") || "Group") : editCell.lesson.studentName,
                            studentNames: editCell.lesson.studentNames || [],
                            instrument: editCell.lesson.instrument, schoolId: editCell.lesson.schoolId,
                            teacherId: editCell.lesson.teacherId, teacherName: editCell.lesson.teacherName,
                            weekKey: editCell.week.weekKey, weekLabel: editCell.week.label, weekNum: editCell.week.weekNum,
                            termKey: activeTerm?.key, day: editCell.lesson.day,
                            status: "removed", reason: r.value,
                            notes: editForm.notes.trim(),
                            makeupEligible: false, madeUp: false,
                            recordedAt: new Date().toISOString(),
                          };
                          setTallyEntries(prev => [...prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== editCell.key), newEntry]);
                          setEditCell(null);
                        }}
                      style={{ padding: "9px 12px", borderRadius: 7, border: isCurrentReason ? "2px solid #6B7280" : "1.5px solid #E5E7EB", background: isCurrentReason ? "#F3F4F6" : "#fff", color: "#374151", fontWeight: isCurrentReason ? 700 : 400, fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                      onMouseEnter={e => { if (!isCurrentReason) e.currentTarget.style.background = "#F9FAFB"; }}
                      onMouseLeave={e => { if (!isCurrentReason) e.currentTarget.style.background = "#fff"; }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {isCurrentReason && <span style={{ fontSize: 10, color: "#6B7280" }}>✓</span>}
                        {r.label}
                      </span>
                      <span style={{ fontSize: 11, color: "#9CA3AF" }}>not counted</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Email parent — shown when entry is a recorded missed lesson for an individual student */}
            {(() => {
              const current = entryMap[editCell.key];
              if (!current || current.status !== "missed" || editCell.lesson.isGroup) return null;
              const st = students.find(s => s.id === editCell.lesson.studentId);
              const emails = st ? getParentEmails(st) : [];
              if (!emails.length) return null;
              const school = schools.find(s => s.id === editCell.lesson.schoolId);
              const reasonValue = current.reason || "other";
              const tmpl = getEmailTemplates()[reasonValue] || getEmailTemplates().other;
              const parentName = (st?.parents?.[0]?.name || "").split(" ")[0] || "there";
              const resolved = resolveTemplate(tmpl, {
                studentName: preferredFirstName(editCell.lesson.studentName),
                parentName: preferredFirstName(parentName) || 'there',
                instrument: editCell.lesson.instrument || "",
                day: editCell.lesson.day || "",
                weekLabel: editCell.week.label || "",
                teacherName: editCell.lesson.teacherName || "",
                schoolName: school?.name || "",
              });
              const tallyEditMergeCtx = {
                student_name: editCell.lesson.studentName || "",
                parent_name: preferredFirstName(parentName) || "there",
                instrument: editCell.lesson.instrument || "",
                day: editCell.lesson.day || "",
                lesson_time: editCell.lesson.start || "",
                week_label: editCell.week.label || "",
                absence_reason: current.reason || "",
                teacher_name: editCell.lesson.teacherName || "",
                school_name: school?.name || "",
                class_name: st?.className || "",
              };
              return (
                <button
                  onClick={() => { openCompose(emails, { subject: resolved.subject, body: resolved.body, from: school?.senderEmail || "", triggerId: "tally_missed", mergeCtx: tallyEditMergeCtx }); }}
                  style={{ width: "100%", marginTop: 8, padding: "9px 0", borderRadius: 8, background: colors.accentLight, color: colors.accentDark, fontWeight: 600, fontSize: 13, border: `1.5px solid ${colors.accent}`, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.accent + "33"}
                  onMouseLeave={e => e.currentTarget.style.background = colors.accentLight}>
                  <span style={{ fontSize: 17, lineHeight: 1 }}>✉</span> Email Parent
                </button>
              );
            })()}
            {/* Clear / Cancel */}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              {entryMap[editCell.key] && (
                <button onClick={clearEntry} style={{ flex: 1, padding: "9px 0", borderRadius: 8, background: "#FEF2F2", color: "#DC2626", fontWeight: 600, fontSize: 13, border: "1px solid #FECACA", cursor: "pointer", fontFamily: "inherit" }}>
                  Clear entry
                </button>
              )}
              <button onClick={() => setEditCell(null)} style={{ flex: 1, padding: "9px 0", borderRadius: 8, background: "#F3F4F6", color: "#374151", fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
