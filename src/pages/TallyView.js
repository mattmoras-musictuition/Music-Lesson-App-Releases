// ============================================================
// TALLYVIEW — extracted from App.js
// ============================================================

import React, { useState, useMemo } from "react";
import { ClipboardCheck, Check, X, RotateCcw, Building2, Mail, Send } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { toLocalDateStr, melbourneNow, melbourneToday, getSchoolAcronym, getParentEmails, openCompose, groupDisplayNameLive } from "../utils/helpers";
import { deriveTallyRows, derivePrivateTallyRows } from "../utils/tallyDerive";
import { buildBankingIndex, isCatchupCompleted, formatCatchupCompletionLabel } from "../data/catchupsDerive";
import { getMissedReasonProse } from "../utils/missedReasonLabels";
import { preferredFirstName } from "../utils/emailTemplates";
import { PageTitle, NavButtons, Btn, EmptyState, PAGE_COLORS } from "../components/ui/SharedUI";

// "Megumi (Meg) van Haven" → "Meg van Haven"  |  "Olive Teehan" → "Olive Teehan"
function buildPreferredDisplayName(name) {
  if (!name) return name;
  const match = name.match(/\(([^)]+)\)/);
  if (!match) return name;
  const prefFirst = match[1];
  const surname = name.replace(/^[^\s(]+\s*\([^)]+\)\s*/, "").trim();
  return surname ? `${prefFirst} ${surname}` : prefFirst;
}

// Spec 4 cluster 1 patch — tooltip-only unwrap of the "Other (X)" form.
// "Other" category with a free-text detail reads better in the cell hover
// without the redundant category prefix; other reason categories stay as
// `getMissedReasonProse` returns them (those category labels are informative).
// The email-body consumers of `getMissedReasonProse` still get the full form.
const formatReasonForTooltip = (prose) => {
  if (!prose) return "";
  const m = prose.match(/^Other \((.+)\)$/);
  return m ? m[1] : prose;
};

export function TallyView({ timetable, schools, students, enrolments, setEnrolments, teachers, interruptions, weeklyTimetables, setWeeklyTimetables, catchups = [], groups = [], notify, onExport, viewState, setViewState, goBack, goForward, historyCursor, pageHistory, onViewStudent }) {
  const { colors, darkMode } = useTheme();
  const selectedSchool = (viewState || {}).selectedSchool ?? "all";
  const setSelectedSchool = (v) => setViewState(prev => ({ ...prev, selectedSchool: typeof v === "function" ? v(prev.selectedSchool ?? "all") : v }));
  const groupBy = (viewState || {}).groupBy || "day_school";
  const setGroupBy = (v) => setViewState(prev => ({ ...prev, groupBy: v }));
  const [tallyTooltip, setTallyTooltip] = useState(null);
  const [hoveredWeekKey, setHoveredWeekKey] = useState(null);
  const [tallySearch, setTallySearch] = useState("");
  const [hoveredNameKey, setHoveredNameKey] = useState(null);

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
    // During a term: show that term
    const inTerm = getTerms.find(t => now >= t.start && now <= t.end);
    if (inTerm) return inTerm;
    // During holidays: show the most recently completed term (not the upcoming one)
    const pastTerms = getTerms.filter(t => now > t.end);
    if (pastTerms.length > 0) return pastTerms[pastTerms.length - 1];
    // Before any term starts: show the first upcoming term
    return getTerms.find(t => now < t.start) || getTerms[getTerms.length - 1];
  }, [getTerms]);

  const activeTerm = currentTerm;

  // ── Term weeks list (including holiday weeks after term) ────
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
    // Append holiday weeks from the break following this term (H1, H2, …)
    const nextBreak = termBreaks.find(tb => {
      const bs = new Date(tb.date + "T00:00:00");
      return bs > activeTerm.end;
    });
    if (nextBreak) {
      const breakStart = nextBreak.date;
      const breakEnd = nextBreak.endDate || nextBreak.date;
      const breakStartMon = getMondayOf(new Date(breakStart + "T00:00:00"));
      let hw = new Date(breakStartMon);
      let hNum = 1;
      while (toLocalDateStr(hw) <= breakEnd) {
        const hwStr = toLocalDateStr(hw);
        // Only include if this Monday actually falls within the break period
        if (hwStr >= breakStart) {
          weeks.push({ weekKey: hwStr, weekNum: hNum, label: `H${hNum}`, isHoliday: true });
          hNum++;
        }
        hw = new Date(hw); hw.setDate(hw.getDate() + 7);
      }
    }
    return weeks;
  }, [activeTerm, termBreaks]);

  // ── Term-filtered entries — derived from WTT ──────────────────────────────

  // ── Lessons from master timetable ─────────────────────────
  const schoolLessons = useMemo(() => {
    if (!timetable) return [];
    return selectedSchool === "all"
      ? timetable.lessons
      : timetable.lessons.filter(l => l.schoolId === selectedSchool);
  }, [timetable, selectedSchool]);

  // ── Tally rows + entryMap (derived from WTT via tallyDerive helper) ──
  // Replaces today's lessonRows + entryMap useMemos as of Commit 5a.
  // The helper returns BOTH the canonical tallyRows shape (which 5b's cycle
  // handler and 5c's edit modal will read) AND a transitional entryMap shim
  // synthesized from WTT data so existing render code (CellIcon, tooltips,
  // stats, makeups filter, holiday-rendering branches) keeps working
  // unmodified through 5a–5c.
  const { tallyRows, entryMap } = useMemo(() => {
    if (!activeTerm) return { tallyRows: [], entryMap: {} };
    return deriveTallyRows({
      enrolments,
      students,
      termWeeks,
      weeklyTimetables,
      timetable,
      schoolFilter: selectedSchool,
    });
  }, [enrolments, students, termWeeks, weeklyTimetables, timetable, selectedSchool, activeTerm]);
  const lessonRows = tallyRows;

  // ── Private students (stub) ─────────────────────────────────
  // TODO Spec 7 — private students use the enrolments collection too once
  // that spec resolves Type-A pending + private. Today's privateStudents
  // filter is preserved (gates the panel render); rows / entryMap / stats
  // are stubbed empty since student.instruments is empty post-Commit-3.
  const privateStudents = useMemo(() =>
    students.filter(s => s.schoolId === "__private__" && (s.status === "active" || s.status === "pending" || s.status === "trial")),
    [students]
  );
  // ── Private students derived rows (Spec 4 cluster 5) ───────────
  // Storage architecture: private-student tally state lives in WTT under
  // `<weekKey>|__private__`. Cluster 5 wires the read path; C6 wires
  // the click-cycle write. Until C6 ships, cells render all-blank.
  const { tallyRows: privateLessonRows, entryMap: privateEntryMap } = useMemo(() => {
    if (!activeTerm) return { tallyRows: [], entryMap: {} };
    return derivePrivateTallyRows({ enrolments, students, termWeeks, weeklyTimetables, teachers });
  }, [enrolments, students, termWeeks, weeklyTimetables, teachers, activeTerm]);

  // ── Holiday catchup map: which holiday-week cells have a catchup row ──
  // Value is a minimal entry-shape so the downstream tooltip read
  // ("Holiday — Completed") hits the entry.status === "completed" branch.
  // enrolments provides the join from catchup.enrolmentId → studentId/groupId.
  const holidayCatchupsMap = useMemo(() => {
    const map = {};
    const holidayWeekKeys = new Set(termWeeks.filter(w => w.isHoliday).map(w => w.weekKey));
    if (holidayWeekKeys.size === 0) return map;
    for (const c of (catchups || [])) {
      if (!holidayWeekKeys.has(c.weekKey)) continue;
      const en = (enrolments || []).find(e => e.id === c.enrolmentId);
      if (!en) continue;
      const lessonKey = en.isGroup ? `group|${en.groupId}` : `${en.studentId}|${c.instrument}`;
      map[`${lessonKey}|${c.weekKey}`] = { status: "completed", isHolidayCatchup: true };
    }
    return map;
  }, [catchups, enrolments, termWeeks]);

  // ── Summary stats (term weeks only — holiday weeks excluded) ─────
  const termWeekKeys = useMemo(() => new Set(termWeeks.filter(w => !w.isHoliday).map(w => w.weekKey)), [termWeeks]);
  const stats = useMemo(() => {
    const lessonKeySet = new Set(lessonRows.map(r => r.lessonKey));
    const visibleEntries = Object.values(entryMap).filter(e => lessonKeySet.has(e.lessonKey) && termWeekKeys.has(e.weekKey));
    const removed = visibleEntries.filter(e => e.status === "removed").length;
    const termWeekCount = termWeeks.filter(w => !w.isHoliday).length;
    const totalCells = lessonRows.length * termWeekCount - removed;
    const completed = visibleEntries.filter(e => e.status === "completed").length;
    const missed = visibleEntries.filter(e => e.status === "missed").length;
    const makeupOwed = visibleEntries.filter(e => e.status === "missed" && e.makeupEligible && !e.madeUp).length;
    const madeUp = visibleEntries.filter(e => e.madeUp).length;
    return { totalCells, completed, missed, makeupOwed, madeUp, unmarked: totalCells - completed - missed };
  }, [entryMap, lessonRows, termWeeks, termWeekKeys]);

  // Private-students panel stats — mirrors the main grid's `stats` shape
  // but scoped to privateLessonRows + privateEntryMap.
  const privateStats = useMemo(() => {
    const lessonKeySet = new Set(privateLessonRows.map(r => r.lessonKey));
    const visibleEntries = Object.values(privateEntryMap).filter(e => lessonKeySet.has(e.lessonKey) && termWeekKeys.has(e.weekKey));
    const removed = visibleEntries.filter(e => e.status === "removed").length;
    const termWeekCount = termWeeks.filter(w => !w.isHoliday).length;
    const totalCells = privateLessonRows.length * termWeekCount - removed;
    const completed = visibleEntries.filter(e => e.status === "completed").length;
    const missed = visibleEntries.filter(e => e.status === "missed").length;
    const makeupOwed = visibleEntries.filter(e => e.status === "missed" && e.makeupEligible && !e.madeUp).length;
    const madeUp = visibleEntries.filter(e => e.madeUp).length;
    return { totalCells, completed, missed, makeupOwed, madeUp };
  }, [privateEntryMap, privateLessonRows, termWeeks, termWeekKeys]);

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

  // Flat ordered list of all rendered rows — used for cross-row drag range
  const flatRows = useMemo(() => groupedRows.flatMap(([, rows]) => rows), [groupedRows]);
  const flatRowKeyToIdx = useMemo(() => {
    const m = new Map();
    flatRows.forEach((r, i) => m.set(r.lessonKey, i));
    return m;
  }, [flatRows]);

  // Spec 3 cluster 8 — banking index for blue-tick "caught up" render.
  const bankingIndex = useMemo(() => buildBankingIndex(catchups || []), [catchups]);

  // ── Cell render ─────────────────────────────────────────────
  const CellIcon = ({ entry, isFuture, caughtUp }) => {
    if (!entry) {
      return <span style={{ color: isFuture ? "#9CA3AF" : "#C4C9D4", display: "inline-flex", alignItems: "center" }}><span style={{ width: 12, height: 12, borderRadius: "50%", border: `1.5px solid currentColor`, display: "inline-block" }} /></span>;
    }
    if (entry.status === "removed") return <span style={{ color: "#D1D5DB", fontSize: 14, fontWeight: 700, lineHeight: 1 }}>—</span>;
    if (entry.status === "completed") return <span style={{ color: colors.success, display: "inline-flex", alignItems: "center" }}><Check size={14} /></span>;
    if (entry.status === "missed") {
      if (entry.madeUp) return <span style={{ color: colors.sidebarActive, display: "inline-flex", alignItems: "center" }}><RotateCcw size={13} /></span>;
      if (caughtUp) return <span style={{ color: colors.blue600, display: "inline-flex", alignItems: "center" }}><Check size={14} /></span>;
      if (entry.makeupEligible) return <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", background: colors.accent }} />;
      return <span style={{ color: colors.danger, display: "inline-flex", alignItems: "center" }}><X size={13} /></span>;
    }
    return null;
  };

  const todayStr = melbourneToday();
  const isFutureWeek = (weekKey) => weekKey > todayStr;

  // ── Render ──────────────────────────────────────────────────
  const pageColor = PAGE_COLORS.tally;
  const headerBg = colors.sidebarHover;

  if (!timetable) {
    return (
      <div>
        <PageTitle subtitle="Track lesson completion across all schools and teachers" pageColor={PAGE_COLORS.tally}>Master Tally</PageTitle>
        <EmptyState icon={<ClipboardCheck size={32} />} title="No master timetable yet" subtitle="Generate a master timetable first to use the Tally." />
      </div>
    );
  }

  return (
    <div>
      <PageTitle subtitle={activeTerm ? activeTerm.label : "Track lesson completion across all schools and teachers"}
        pageColor={PAGE_COLORS.tally}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
        action={<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {schools.map(s => {
            const abbr = getSchoolAcronym(s);
            const active = selectedSchool === s.id;
            const schoolColor = s.color || colors.sidebarActive;
            return (
              <Btn key={s.id} onClick={() => setSelectedSchool(active ? "all" : s.id)}
                variant={active ? "primary" : "secondary"}
                style={active ? { background: schoolColor, borderColor: schoolColor, color: "#fff" } : {}}
              ><span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Building2 size={12} /> {abbr}</span></Btn>
            );
          })}
          <select value={groupBy} onChange={e => setGroupBy(e.target.value)}
            style={{ height: 34, padding: "0 12px", border: `2px solid ${colors.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, fontWeight: 600, cursor: "pointer", boxSizing: "border-box", marginTop: -2 }}>
            <option value="day_school">Day &amp; School</option>
            <option value="teacher">By Teacher</option>
            <option value="day">By Day</option>
            <option value="school">By School</option>
            <option value="makeups">Makeups Owed</option>
          </select>
          {onExport && <Btn onClick={() => onExport(null, "", "tally")}><span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Send size={13} /> Export</span></Btn>}
        </div>}>
        Master Tally
      </PageTitle>

      {/* Summary cards */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "nowrap", overflowX: "auto" }}>
        {[
          { label: "Not Yet Marked", value: stats.unmarked, color: colors.gray500, bg: darkMode ? colors.cardBg : "#F9FAFB", icon: "○" },
          { label: "Completed", value: stats.completed, color: colors.success, bg: `${colors.success}18`, icon: "✓" },
          { label: "Absent (no makeup)", value: stats.missed - stats.makeupOwed - stats.madeUp, color: colors.danger, bg: colors.redLight, icon: "✕" },
          { label: "Makeup Owed", value: stats.makeupOwed, color: colors.accent, bg: colors.accentLight, icon: "●" },
          { label: "Made Up", value: stats.madeUp, color: colors.sidebarActive, bg: "rgba(52,69,101,0.07)", icon: "↺" },
        ].map(s => (
          <div key={s.label} style={{ background: s.bg, border: `1px solid ${s.color}22`, borderRadius: 10, padding: "10px 18px", flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap" }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: s.color, lineHeight: 1, flexShrink: 0 }}>{s.value}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: colors.gray700, lineHeight: 1.3 }}>{s.label}</div>
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
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: colors.gray500, flexWrap: "wrap", flex: 1, justifyContent: "flex-end" }}>
          {[
            { icon: <span style={{ width: 11, height: 11, borderRadius: "50%", border: "1.5px solid #9CA3AF", display: "inline-block" }} />, color: "#9CA3AF", label: "Unmarked" },
            { icon: <Check size={13} />, color: colors.success, label: "Completed" },
            { icon: <span style={{ width: 10, height: 10, borderRadius: "50%", background: colors.accent, display: "inline-block" }} />, color: colors.accent, label: "Makeup owed" },
            { icon: <RotateCcw size={12} />, color: colors.sidebarActive, label: "Caught up" },
            { icon: <X size={13} />, color: colors.danger, label: "No catch-up" },
            { icon: <span style={{ fontSize: 13, lineHeight: 1, color: "#D1D5DB", fontWeight: 700 }}>—</span>, color: "#D1D5DB", label: "Inactive" },
          ].map(l => (
            <span key={l.label} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: l.color }}>
              {l.icon} <span style={{ color: colors.gray500 }}>{l.label}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Grid */}
      {Object.keys(weeklyTimetables || {}).length === 0 ? (
        <EmptyState icon={<ClipboardCheck size={32} />} title="No weekly timetables generated yet" subtitle={<>Head to the <strong>Weekly Adjustments</strong> tab and generate a week to start tracking lessons.</>} />
      ) : lessonRows.length === 0 ? (
        <EmptyState icon={<ClipboardCheck size={32} />} title="No lessons at this school" subtitle="No lessons are scheduled here in the master timetable." />
      ) : (
        <div style={{ overflowX: "auto", overflowY: "auto", borderRadius: 10, border: `1px solid ${colors.border}`, maxHeight: "calc(100vh - 212px)", position: "relative" }}>
          <table style={{ borderCollapse: "separate", borderSpacing: 0, width: `calc(100% + ${termWeeks.filter(w => w.isHoliday).length * 44}px)`, tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 200 }} />
              <col style={{ width: 110 }} />
              {termWeeks.map(w => w.isHoliday
                ? <col key={w.weekKey} style={{ width: 44 }} />
                : <col key={w.weekKey} />
              )}
              <col style={{ width: 110 }} />
              <col style={{ width: 60 }} />
            </colgroup>
            <thead style={{ position: "sticky", top: 0, zIndex: 6 }}>
              <tr style={{ background: headerBg }}>
                <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: colors.cardBg, borderBottom: `2px solid ${colors.sidebarHover}`, position: "sticky", left: 0, background: headerBg, zIndex: 5, whiteSpace: "nowrap" }}>
                  Student / Group
                </th>
                <th style={{ padding: "10px 8px", textAlign: "center", fontWeight: 600, fontSize: 11, color: "rgba(255,255,255,0.7)", borderBottom: `2px solid ${colors.sidebarHover}`, whiteSpace: "nowrap", position: "sticky", left: 200, background: headerBg, zIndex: 5, borderRight: `1px solid rgba(255,255,255,0.1)` }}>
                  Instrument
                </th>
                {termWeeks.map(w => (
                  <th key={w.weekKey} style={{ padding: "8px 4px", textAlign: "center", fontWeight: 600, fontSize: 11, color: w.isHoliday ? "rgba(255,200,200,0.85)" : isFutureWeek(w.weekKey) ? "rgba(255,255,255,0.3)" : colors.cardBg, borderBottom: `2px solid ${colors.sidebarHover}`, minWidth: 36, background: w.isHoliday ? "#6B3030" : hoveredWeekKey === w.weekKey ? colors.sidebarHover : headerBg, transition: "background 0.1s" }}
                    onMouseEnter={() => setHoveredWeekKey(w.weekKey)}
                    onMouseLeave={() => setHoveredWeekKey(null)}>
                    {w.label}
                  </th>
                ))}
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 600, fontSize: 11, color: colors.white, borderBottom: `2px solid ${colors.sidebarHover}`, whiteSpace: "nowrap", position: "sticky", right: 60, background: headerBg, zIndex: 5, borderLeft: `1px solid rgba(255,255,255,0.1)` }}>
                  Summary
                </th>
                <th style={{ padding: "10px 10px", textAlign: "center", fontWeight: 600, fontSize: 11, color: "rgba(255,255,255,0.7)", borderBottom: `2px solid ${colors.sidebarHover}`, whiteSpace: "nowrap", position: "sticky", right: 0, background: headerBg, zIndex: 5 }}>
                  Email
                </th>
              </tr>
            </thead>
            <tbody>
              {groupedRows.map(([groupLabel, rows]) => {
                const filteredRows = tallySearch.trim()
                  ? rows.filter(r => {
                      const liveStu = r.isGroup ? null : students.find(s => s.id === r.studentId);
                      const name = r.isGroup
                        ? (groupDisplayNameLive(r, groups, students) || "")
                        : buildPreferredDisplayName(liveStu?.name || r.studentName || "");
                      return name.toLowerCase().includes(tallySearch.trim().toLowerCase());
                    })
                  : rows;
                if (filteredRows.length === 0) return null;
                return (
                <React.Fragment key={groupLabel}>
                  {groupBy !== "none" && groupBy !== "makeups" && (
                    <tr>
                      <td colSpan={termWeeks.length + 4} style={{ padding: "6px 14px", fontSize: 11, fontWeight: 700, color: "#fff", background: (() => { const sid = rows[0]?.schoolId; const sc = (groupBy === "day_school" || groupBy === "school") ? schools.find(s => s.id === sid) : null; return sc?.color || pageColor; })(), letterSpacing: "0.05em", textTransform: "uppercase", position: "sticky", top: 36, zIndex: 3, borderBottom: `1px solid ${colors.sidebarHover}` }}>
                        {groupLabel}
                      </td>
                    </tr>
                  )}
                  {groupBy === "makeups" && (
                    <tr>
                      <td colSpan={termWeeks.length + 4} style={{ padding: "8px 14px 4px", fontSize: 11, fontWeight: 700, color: "#fff", background: colors.accent, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                        {groupLabel}
                      </td>
                    </tr>
                  )}
                  {filteredRows.map((lesson, ri) => {
                    // Resolve live name from students prop so renames immediately reflect in the tally
                    const liveStudent = lesson.isGroup ? null : students.find(s => s.id === lesson.studentId);
                    const displayName = lesson.isGroup
                      ? groupDisplayNameLive(lesson, groups, students)
                      : buildPreferredDisplayName(liveStudent?.name || lesson.studentName);
                    const student = liveStudent;
                    const className = student?.className || "";
                    const rowEntries = termWeeks.map(w => entryMap[`${lesson.lessonKey}|${w.weekKey}`] || null);
                    const rowCompleted = rowEntries.filter(e => e?.status === "completed").length;
                    const rowMissed = rowEntries.filter(e => e?.status === "missed").length;
                    const rowMakeup = rowEntries.filter(e => e?.status === "missed" && e.makeupEligible && !e.madeUp).length;
                    const rowMadeUp = rowEntries.filter(e => e?.madeUp).length;
                    const rowBg = ri % 2 === 0 ? colors.cardBg : (darkMode ? colors.bg : "#F9FAFB");
                    return (
                      <tr key={lesson.lessonKey} style={{ background: rowBg }}>
                      <td style={{ padding: "8px 14px", borderBottom: `1px solid ${colors.border}`, position: "sticky", left: 0, background: rowBg, zIndex: 1 }}>
                          <div
                            style={{ fontWeight: 500, fontSize: 13, color: hoveredNameKey === lesson.lessonKey ? colors.warning : colors.text, cursor: (!lesson.isGroup && onViewStudent) ? "pointer" : "default", transition: "color 0.12s", display: "inline-block" }}
                            onClick={e => { if (!lesson.isGroup && onViewStudent) { e.stopPropagation(); onViewStudent(lesson.studentId); } }}
                            onMouseEnter={() => { if (!lesson.isGroup && onViewStudent) setHoveredNameKey(lesson.lessonKey); }}
                            onMouseLeave={() => setHoveredNameKey(null)}
                          >{displayName}</div>
                          {selectedSchool === "all" && <div style={{ fontSize: 10, color: schools.find(s => s.id === lesson.schoolId)?.color || colors.sidebarActive, fontWeight: 600 }}>{getSchoolAcronym(schools.find(s => s.id === lesson.schoolId))}</div>}
                          {selectedSchool !== "all" && className && <div style={{ fontSize: 11, color: colors.textMuted }}>{className}</div>}
                        </td>
                        <td style={{ padding: "8px 8px", borderBottom: `1px solid ${colors.border}`, textAlign: "center", fontSize: 12, color: colors.textLight, whiteSpace: "nowrap", position: "sticky", left: 200, background: rowBg, zIndex: 1, borderRight: `1px solid ${colors.border}` }}>
                          {lesson.instrument}
                          <div style={{ fontSize: 10, color: colors.textMuted }}>{lesson.day}</div>
                        </td>
                        {termWeeks.map((w, wi) => {
                          const entry = rowEntries[wi];
                          const future = isFutureWeek(w.weekKey);
                          const cellKey = `${lesson.lessonKey}|${w.weekKey}`;
                          const isHoliday = !!w.isHoliday;
                          // For holiday cells: source from the catchups-backed map (cluster 12b).
                          const holidayCatchupEntry = isHoliday ? (holidayCatchupsMap[cellKey] || null) : null;
                          const holidayHasLesson = isHoliday && !!holidayCatchupEntry;
                          const holidayBlank = isHoliday && !holidayHasLesson;
                          const displayEntry = isHoliday ? holidayCatchupEntry : entry;

                          // Spec 3 cluster 8 — banking-eligible catchup whose
                          // (weekKey + day + 18:00) has passed flips the cell
                          // from "catch-up owed" (orange dot) to "caught up"
                          // (blue tick). Render-time derive only.
                          const bankingCatchup = (
                            displayEntry?.status === "missed"
                            && displayEntry.makeupEligible
                            && !displayEntry.madeUp
                            && lesson.enrolmentId
                          ) ? (bankingIndex.get(`${lesson.enrolmentId}|${w.weekKey}`) || null) : null;
                          const caughtUp = !!(bankingCatchup && isCatchupCompleted(bankingCatchup));

                          return (
                            <td key={w.weekKey}
                              style={{ padding: "6px 2px", borderBottom: `1px solid ${colors.border}`, textAlign: "center",
                                cursor: "default", position: "relative",
                                background: holidayBlank ? (darkMode ? "rgba(180,80,80,0.10)" : "rgba(248,113,113,0.08)")
                                  : isHoliday ? (darkMode ? "rgba(180,80,80,0.15)" : "rgba(248,113,113,0.13)")
                                  : hoveredWeekKey === w.weekKey ? (darkMode ? colors.sidebarHover : "#F3F4F6") : "transparent",
                                transition: "background 0.1s",
                                userSelect: "none" }}
                              onMouseEnter={e => {
                                setHoveredWeekKey(w.weekKey);
                                if (holidayBlank) return;
                                const r = e.currentTarget.getBoundingClientRect();
                                const madeUpWeekLabel = displayEntry?.madeUp && displayEntry?.madeUpWeekKey
                                  ? (termWeeks.find(tw => tw.weekKey === (displayEntry.madeUpWeekKey || "").split("|")[0])?.label || null)
                                  : null;
                                const missedReason = formatReasonForTooltip(getMissedReasonProse(displayEntry?.reason, displayEntry?.reasonDetail));
                                const text = isHoliday
                                  ? (displayEntry?.status === "completed" ? "Holiday — Completed" : displayEntry?.status === "missed" ? "Holiday — Missed" : "Holiday — Unmarked")
                                  : displayEntry?.status === "removed" ? "Inactive"
                                  : displayEntry?.status === "completed" ? (displayEntry.bandSession ? (displayEntry.notes || "Band Session") : "Completed" + (displayEntry.notes ? " — " + displayEntry.notes : ""))
                                  : displayEntry?.status === "missed" && displayEntry?.madeUp ? ("↺ Caught up" + (madeUpWeekLabel ? " — " + madeUpWeekLabel : ""))
                                  : caughtUp ? ("Caught up on " + formatCatchupCompletionLabel(bankingCatchup))
                                  : displayEntry?.status === "missed" ? ("Missed" + (missedReason ? " — " + missedReason : ""))
                                  : future ? "Future week" : "Unmarked";
                                setTallyTooltip({ text, x: r.left + r.width / 2, y: r.top - 6, isMissed: displayEntry?.status === "missed" });
                              }}
                              onMouseLeave={() => { setHoveredWeekKey(null); setTallyTooltip(null); }}>
                              {!holidayBlank && (
                                <div style={{ width: 28, height: 28, margin: "0 auto", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: displayEntry ? (displayEntry.status === "completed" ? `${colors.success}18` : displayEntry.status === "removed" ? (darkMode ? colors.inputBg : "#F9FAFB") : displayEntry.madeUp ? "rgba(52,69,101,0.07)" : caughtUp ? `${colors.blue600}18` : displayEntry.makeupEligible ? colors.accentLight : colors.redLight) : "transparent" }}>
                                  <CellIcon entry={displayEntry} isFuture={future} caughtUp={caughtUp} />
                                </div>
                              )}
                            </td>
                          );
                        })}
                        <td style={{ padding: "8px 12px", borderBottom: `1px solid ${colors.border}`, whiteSpace: "nowrap", position: "sticky", right: 60, background: rowBg, zIndex: 1, borderLeft: `1px solid ${colors.border}` }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", fontSize: 11 }}>
                            <span style={{ color: colors.success, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 2 }}>{rowCompleted}<Check size={11} /></span>
                            {(rowMissed - rowMakeup - rowMadeUp) > 0 && <span style={{ color: colors.danger, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 2 }}>{rowMissed - rowMakeup - rowMadeUp}<X size={11} /></span>}
                            {rowMakeup > 0 && <span style={{ color: colors.accent, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 2 }}>{rowMakeup}<span style={{ width: 8, height: 8, borderRadius: "50%", background: colors.accent, display: "inline-block" }} /></span>}
                            {rowMadeUp > 0 && <span style={{ color: colors.sidebarActive, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 2 }}>{rowMadeUp}<RotateCcw size={11} /></span>}
                          </div>
                        </td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${colors.border}`, textAlign: "center", position: "sticky", right: 0, background: rowBg, zIndex: 1 }}>
                          {(() => {
                            const school = schools.find(s => s.id === lesson.schoolId);
                            let emails = [];
                            if (lesson.isGroup) {
                              // Collect one primary parent email per group member via name matching
                              emails = (lesson.studentNames || []).flatMap(sName => {
                                const st = students.find(s => s.name === sName);
                                return st ? getParentEmails(st) : [];
                              }).filter((e, i, arr) => arr.indexOf(e) === i);
                            } else {
                              const st = students.find(s => s.id === lesson.studentId);
                              emails = st ? getParentEmails(st) : [];
                            }
                            if (!emails.length) return null;
                            const hasMissed = rowMissed > 0;
                            return (
                              <button
                                title={hasMissed ? "Email parents — missed lesson summary" : "Email parents"}
                                onClick={e => {
                                  e.stopPropagation();
                                  const termLabel = activeTerm?.label || "";
                                  const missedLines = termWeeks
                                    .map((w, wi) => ({ w, entry: rowEntries[wi] }))
                                    .filter(({ entry }) => entry?.status === "missed")
                                    .map(({ w, entry }) => {
                                      const reasonText = getMissedReasonProse(entry.reason, entry.reasonDetail) || "Missed";
                                      return `  • ${w.label} — ${reasonText}`;
                                    });
                                  const catchupOwed = rowEntries.filter(e => e?.status === "missed" && e.makeupEligible && !e.madeUp).length;
                                  if (lesson.isGroup) {
                                    const groupLabel = groupDisplayNameLive(lesson, groups, students) || "Group";
                                    const subject = `${groupLabel} — ${lesson.instrument} lessons — ${termLabel} summary`;
                                    const body = `Hi,\n\nI wanted to reach out with a summary of the ${groupLabel} ${lesson.instrument} group lessons for ${termLabel}.\n\nLessons attended: ${rowCompleted}\nLessons missed: ${rowMissed}${missedLines.length ? "\n" + missedLines.join("\n") : ""}${catchupOwed > 0 ? `\nCatch-ups still owed: ${catchupOwed}` : ""}\n\nPlease don't hesitate to get in touch if you have any questions.\n\nKind regards,`;
                                    openCompose(emails, { subject, body, from: school?.senderEmail || "", triggerId: "tally_end_of_term", forceTo: true });
                                  } else {
                                    const st = students.find(s => s.id === lesson.studentId);
                                    const parentName = preferredFirstName(st?.parents?.[0]?.name || "") || "there";
                                    const subject = `${preferredFirstName(lesson.studentName)}'s ${lesson.instrument} lessons — ${termLabel} summary`;
                                    const body = `Hi ${parentName},\n\nI wanted to reach out with a summary of ${preferredFirstName(lesson.studentName)}'s ${lesson.instrument} lessons for ${termLabel}.\n\nLessons attended: ${rowCompleted}\nLessons missed: ${rowMissed}${missedLines.length ? "\n" + missedLines.join("\n") : ""}${catchupOwed > 0 ? `\nCatch-ups still owed: ${catchupOwed}` : ""}\n\nPlease don't hesitate to get in touch if you have any questions.\n\nKind regards,`;
                                    openCompose(emails, { subject, body, from: school?.senderEmail || "", triggerId: "tally_end_of_term", forceTo: true });
                                  }
                                }}
                                style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px", borderRadius: 5, color: hasMissed ? colors.accent : colors.textMuted, display: "inline-flex", alignItems: "center", opacity: hasMissed ? 1 : 0.45 }}
                                onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}
                              >
                                <Mail size={13} />
                              </button>
                            );
                          })()}
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

      {/* Instant tooltip for removed cells */}
      {tallyTooltip && (
        <div style={{ position: "fixed", left: tallyTooltip.x, top: tallyTooltip.y, transform: "translate(-50%, -100%)", background: "rgba(30,30,30,0.92)", color: "#fff", fontSize: 12, padding: "4px 9px", borderRadius: 6, pointerEvents: "none", zIndex: 9999, whiteSpace: "nowrap" }}>
          {tallyTooltip.text}
        </div>
      )}

      {/* Private Students Tally Panel */}
      {privateStudents.length > 0 && (
        <div style={{ marginTop: 36 }}>
          {/* Panel header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: colors.text }}>Private Students</div>
            <span style={{ fontSize: 11, fontWeight: 700, color: colors.accent, background: colors.accentLight, borderRadius: 4, padding: "2px 8px" }}>Private</span>
            <div style={{ display: "flex", gap: 12, marginLeft: 4, fontSize: 12 }}>
              <span style={{ color: colors.success, display: "inline-flex", alignItems: "center", gap: 3 }}><Check size={12} />{privateStats.completed}</span>
              {(privateStats.missed - privateStats.makeupOwed - privateStats.madeUp) > 0 && (
                <span style={{ color: colors.danger, display: "inline-flex", alignItems: "center", gap: 3 }}><X size={12} />{privateStats.missed - privateStats.makeupOwed - privateStats.madeUp}</span>
              )}
              {privateStats.makeupOwed > 0 && (
                <span style={{ color: colors.accent, display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: colors.accent, display: "inline-block" }} />{privateStats.makeupOwed} owed
                </span>
              )}
              {privateStats.madeUp > 0 && (
                <span style={{ color: colors.sidebarActive, display: "inline-flex", alignItems: "center", gap: 3 }}><RotateCcw size={12} />{privateStats.madeUp}</span>
              )}
            </div>
          </div>

          {/* Private grid */}
          <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${colors.border}`, position: "relative" }}>
            <table style={{ borderCollapse: "separate", borderSpacing: 0, width: `calc(100% + ${termWeeks.filter(w => w.isHoliday).length * 44}px)`, tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: 200 }} />
                <col style={{ width: 110 }} />
                {termWeeks.map(w => w.isHoliday
                  ? <col key={w.weekKey} style={{ width: 44 }} />
                  : <col key={w.weekKey} />
                )}
                <col style={{ width: 110 }} />
                <col style={{ width: 60 }} />
              </colgroup>
              <thead style={{ position: "sticky", top: 0, zIndex: 6 }}>
                <tr style={{ background: headerBg }}>
                  <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: colors.cardBg, borderBottom: `2px solid ${colors.sidebarHover}`, position: "sticky", left: 0, background: headerBg, zIndex: 5, minWidth: 180, whiteSpace: "nowrap" }}>
                    Student
                  </th>
                  <th style={{ padding: "10px 8px", textAlign: "center", fontWeight: 600, fontSize: 11, color: "rgba(255,255,255,0.7)", borderBottom: `2px solid ${colors.sidebarHover}`, whiteSpace: "nowrap", position: "sticky", left: 200, background: headerBg, zIndex: 5, borderRight: `1px solid rgba(255,255,255,0.1)` }}>
                    Instrument
                  </th>
                  {termWeeks.map(w => (
                    <th key={w.weekKey} style={{ padding: "8px 4px", textAlign: "center", fontWeight: 600, fontSize: 11, color: w.isHoliday ? "rgba(255,200,200,0.85)" : isFutureWeek(w.weekKey) ? "rgba(255,255,255,0.3)" : colors.cardBg, borderBottom: `2px solid ${colors.sidebarHover}`, minWidth: 36, background: w.isHoliday ? "#6B3030" : hoveredWeekKey === w.weekKey ? colors.sidebarHover : headerBg, transition: "background 0.1s" }}
                      onMouseEnter={() => setHoveredWeekKey(w.weekKey)}
                      onMouseLeave={() => setHoveredWeekKey(null)}>
                      {w.label}
                    </th>
                  ))}
                  <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 600, fontSize: 11, color: colors.white, borderBottom: `2px solid ${colors.sidebarHover}`, whiteSpace: "nowrap", position: "sticky", right: 60, background: headerBg, zIndex: 5, borderLeft: `1px solid rgba(255,255,255,0.1)` }}>
                    Summary
                  </th>
                  <th style={{ padding: "10px 10px", textAlign: "center", fontWeight: 600, fontSize: 11, color: "rgba(255,255,255,0.7)", borderBottom: `2px solid ${colors.sidebarHover}`, whiteSpace: "nowrap", position: "sticky", right: 0, background: headerBg, zIndex: 5 }}>
                    Email
                  </th>
                </tr>
              </thead>
              <tbody>
                {privateLessonRows.map((lesson, ri) => {
                  const rowEntries = termWeeks.map(w => privateEntryMap[`${lesson.lessonKey}|${w.weekKey}`] || null);
                  const rowCompleted = rowEntries.filter(e => e?.status === "completed").length;
                  const rowMissed   = rowEntries.filter(e => e?.status === "missed").length;
                  const rowMakeup   = rowEntries.filter(e => e?.status === "missed" && e.makeupEligible && !e.madeUp).length;
                  const rowMadeUp   = rowEntries.filter(e => e?.madeUp).length;
                  const rowBg = ri % 2 === 0 ? colors.cardBg : (darkMode ? colors.bg : "#F9FAFB");
                  return (
                    <tr key={lesson.lessonKey} style={{ background: rowBg }}>
                      <td style={{ padding: "8px 14px", borderBottom: `1px solid ${colors.border}`, position: "sticky", left: 0, background: rowBg, zIndex: 1 }}>
                        <div
                          style={{ fontWeight: 500, fontSize: 13, color: hoveredNameKey === lesson.lessonKey ? colors.warning : colors.text, cursor: onViewStudent ? "pointer" : "default", transition: "color 0.12s", display: "inline-block" }}
                          onClick={e => { if (onViewStudent) { e.stopPropagation(); onViewStudent(lesson.studentId); } }}
                          onMouseEnter={() => { if (onViewStudent) setHoveredNameKey(lesson.lessonKey); }}
                          onMouseLeave={() => setHoveredNameKey(null)}
                        >{buildPreferredDisplayName(lesson.studentName)}</div>
                      </td>
                      <td style={{ padding: "8px 8px", borderBottom: `1px solid ${colors.border}`, textAlign: "center", fontSize: 12, color: colors.textLight, whiteSpace: "nowrap", position: "sticky", left: 200, background: rowBg, zIndex: 1, borderRight: `1px solid ${colors.border}` }}>
                        {lesson.instrument}
                        {lesson.day && <div style={{ fontSize: 10, color: colors.textMuted }}>{lesson.day}</div>}
                      </td>
                      {termWeeks.map((w, wi) => {
                        const entry = rowEntries[wi];
                        const future = isFutureWeek(w.weekKey);
                        const cellKey = `${lesson.lessonKey}|${w.weekKey}`;
                        const isHoliday = !!w.isHoliday;
                        // Spec 4 cluster 5 — wire holiday-catchup map into the private
                        // panel so private-student holiday catchups render. The map
                        // already covers __private__ catchups (it's school-agnostic).
                        const holidayCatchupEntry = isHoliday ? (holidayCatchupsMap[cellKey] || null) : null;
                        const displayEntry = isHoliday ? holidayCatchupEntry : entry;

                        // Spec 3 cluster 8 — banking-eligible catchup completion (private section).
                        const bankingCatchup = (
                          displayEntry?.status === "missed"
                          && displayEntry.makeupEligible
                          && !displayEntry.madeUp
                          && lesson.enrolmentId
                        ) ? (bankingIndex.get(`${lesson.enrolmentId}|${w.weekKey}`) || null) : null;
                        const caughtUp = !!(bankingCatchup && isCatchupCompleted(bankingCatchup));

                        return (
                          <td key={w.weekKey}
                            style={{ padding: "6px 2px", borderBottom: `1px solid ${colors.border}`, textAlign: "center", cursor: "default", position: "relative",
                              background: isHoliday ? (darkMode ? "rgba(180,80,80,0.15)" : "rgba(248,113,113,0.13)")
                                : hoveredWeekKey === w.weekKey ? (darkMode ? colors.sidebarHover : "#F3F4F6") : "transparent",
                              transition: "background 0.1s",
                              userSelect: "none" }}
                            onMouseEnter={e => {
                              setHoveredWeekKey(w.weekKey);
                              const r = e.currentTarget.getBoundingClientRect();
                              const madeUpWeekLabel = displayEntry?.madeUp && displayEntry?.madeUpWeekKey
                                ? (termWeeks.find(tw => tw.weekKey === (displayEntry.madeUpWeekKey || "").split("|")[0])?.label || null)
                                : null;
                              const missedReason = formatReasonForTooltip(getMissedReasonProse(displayEntry?.reason, displayEntry?.reasonDetail));
                              const text = isHoliday
                                ? (displayEntry?.status === "completed" ? "Holiday — Completed" : displayEntry?.status === "missed" ? "Holiday — Missed" : "Holiday — Unmarked")
                                : displayEntry?.status === "removed" ? "Inactive"
                                : displayEntry?.status === "completed" ? "Completed" + (displayEntry.notes ? " — " + displayEntry.notes : "")
                                : displayEntry?.status === "missed" && displayEntry?.madeUp ? ("↺ Caught up" + (madeUpWeekLabel ? " — " + madeUpWeekLabel : ""))
                                : caughtUp ? ("Caught up on " + formatCatchupCompletionLabel(bankingCatchup))
                                : displayEntry?.status === "missed" ? ("Missed" + (missedReason ? " — " + missedReason : ""))
                                : future ? "Future" : "Unmarked";
                              setTallyTooltip({ text, x: r.left + r.width / 2, y: r.top - 6, isMissed: displayEntry?.status === "missed" });
                            }}
                            onMouseLeave={() => { setHoveredWeekKey(null); setTallyTooltip(null); }}>
                            <div style={{ width: 28, height: 28, margin: "0 auto", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                              background: displayEntry ? (displayEntry.status === "completed" ? `${colors.success}18` : displayEntry.status === "removed" ? (darkMode ? colors.inputBg : "#F9FAFB") : displayEntry.madeUp ? "rgba(52,69,101,0.07)" : caughtUp ? `${colors.blue600}18` : displayEntry.makeupEligible ? colors.accentLight : colors.redLight) : "transparent" }}>
                              <CellIcon entry={displayEntry} isFuture={future} caughtUp={caughtUp} />
                            </div>
                          </td>
                        );
                      })}
                      <td style={{ padding: "8px 12px", borderBottom: `1px solid ${colors.border}`, whiteSpace: "nowrap", position: "sticky", right: 60, background: rowBg, zIndex: 1, borderLeft: `1px solid ${colors.border}` }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", fontSize: 11 }}>
                          <span style={{ color: colors.success, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 2 }}>{rowCompleted}<Check size={11} /></span>
                          {(rowMissed - rowMakeup - rowMadeUp) > 0 && <span style={{ color: colors.danger, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 2 }}>{rowMissed - rowMakeup - rowMadeUp}<X size={11} /></span>}
                          {rowMakeup > 0 && <span style={{ color: colors.accent, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 2 }}>{rowMakeup}<span style={{ width: 8, height: 8, borderRadius: "50%", background: colors.accent, display: "inline-block" }} /></span>}
                          {rowMadeUp > 0 && <span style={{ color: colors.sidebarActive, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 2 }}>{rowMadeUp}<RotateCcw size={11} /></span>}
                        </div>
                      </td>
                      <td style={{ padding: "8px 10px", borderBottom: `1px solid ${colors.border}`, textAlign: "center", position: "sticky", right: 0, background: rowBg, zIndex: 1 }}>
                        {(() => {
                          const st = students.find(s => s.id === lesson.studentId);
                          const emails = st ? getParentEmails(st) : [];
                          if (!emails.length) return null;
                          const hasMissed = rowMissed > 0;
                          const termLabel = activeTerm?.label || "";
                          return (
                            <button
                              title={hasMissed ? "Email parent — missed lesson summary" : "Email parent"}
                              onClick={e => {
                                e.stopPropagation();
                                const parentName = preferredFirstName(st?.parents?.[0]?.name || "") || "there";
                                const missedLines = termWeeks
                                  .map((w, wi) => ({ w, entry: rowEntries[wi] }))
                                  .filter(({ entry }) => entry?.status === "missed")
                                  .map(({ w, entry }) => {
                                    const reasonText = getMissedReasonProse(entry.reason, entry.reasonDetail) || "Missed";
                                    return `  • ${w.label} — ${reasonText}`;
                                  });
                                const catchupOwed = rowEntries.filter(e => e?.status === "missed" && e.makeupEligible && !e.madeUp).length;
                                const subject = `${preferredFirstName(lesson.studentName)}'s ${lesson.instrument} lessons — ${termLabel} summary`;
                                const body = `Hi ${parentName},\n\nI wanted to reach out with a summary of ${preferredFirstName(lesson.studentName)}'s ${lesson.instrument} lessons for ${termLabel}.\n\nLessons attended: ${rowCompleted}\nLessons missed: ${rowMissed}${missedLines.length ? "\n" + missedLines.join("\n") : ""}${catchupOwed > 0 ? `\nCatch-ups still owed: ${catchupOwed}` : ""}\n\nPlease don't hesitate to get in touch if you have any questions.\n\nKind regards,`;
                                openCompose(emails, { subject, body, triggerId: "tally_end_of_term", forceTo: true });
                              }}
                              style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px", borderRadius: 5, color: hasMissed ? colors.accent : colors.textMuted, display: "inline-flex", alignItems: "center", opacity: hasMissed ? 1 : 0.45 }}
                              onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                              onMouseLeave={e => e.currentTarget.style.background = "none"}
                            >
                              <Mail size={13} />
                            </button>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}
