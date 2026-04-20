// ============================================================
// TALLYVIEW — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo } from "react";
import { ClipboardCheck, Check, X, RotateCcw, Building2, Mail, Send, Palmtree } from "lucide-react";
import { DAYS, TALLY_REASONS, STORAGE_KEYS } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { uid, toLocalDateStr, melbourneNow, melbourneToday, getTermWeekLabel, to12h, timeToMin, getInstColor, getSchoolAcronym, _getMondayOf, getParentEmails, openCompose } from "../utils/helpers";
import { computeTermWeekNum, computeTermKey, getTermWeeksList } from "../utils/tallyHelpers";
import { getEmailTemplates, resolveTemplate, preferredFirstName } from "../utils/emailTemplates";
import { Card, PageTitle, NavButtons, Btn, Tag, EmptyState, FrozenCard, PAGE_COLORS } from "../components/ui/SharedUI";

// "Megumi (Meg) van Haven" → "Meg van Haven"  |  "Olive Teehan" → "Olive Teehan"
function buildPreferredDisplayName(name) {
  if (!name) return name;
  const match = name.match(/\(([^)]+)\)/);
  if (!match) return name;
  const prefFirst = match[1];
  const surname = name.replace(/^[^\s(]+\s*\([^)]+\)\s*/, "").trim();
  return surname ? `${prefFirst} ${surname}` : prefFirst;
}

export function TallyView({ timetable, schools, students, enrolments, setEnrolments, teachers, interruptions, tallyEntries, setTallyEntries, weeklyTimetables, setWeeklyTimetables, notify, onExport, viewState, setViewState, goBack, goForward, historyCursor, pageHistory, onViewStudent }) {
  const { colors, darkMode } = useTheme();
  const selectedSchool = (viewState || {}).selectedSchool ?? "all";
  const setSelectedSchool = (v) => setViewState(prev => ({ ...prev, selectedSchool: typeof v === "function" ? v(prev.selectedSchool ?? "all") : v }));
  const groupBy = (viewState || {}).groupBy || "day_school";
  const setGroupBy = (v) => setViewState(prev => ({ ...prev, groupBy: v }));
  const [editCell, setEditCell] = useState(null);
  const [editForm, setEditForm] = useState({ status: "completed", reason: "", reasonDetail: "", tvCategory: null, notes: "", makeupEligible: false, madeUp: false });
  const [rememberedReasons, setRememberedReasons] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.missedReasons) || "[]"); } catch { return []; }
  });
  const saveRememberedReasons = (list) => {
    setRememberedReasons(list);
    try { localStorage.setItem(STORAGE_KEYS.missedReasons, JSON.stringify(list)); } catch {}
  };
  const [madeUpPopup, setMadeUpPopup] = useState(null);
  const [tallyTooltip, setTallyTooltip] = useState(null);
  const [hoveredWeekKey, setHoveredWeekKey] = useState(null);
  const [tallySearch, setTallySearch] = useState("");
  const [hoveredNameKey, setHoveredNameKey] = useState(null);
  const [dragSelect, setDragSelect] = useState(null);     // { startWi, endWi, startRowIdx, endRowIdx } — live during drag
  const [privateDragSelect, setPrivateDragSelect] = useState(null); // same shape, for private students table
  const [selectedCells, setSelectedCells] = useState(null); // { keys: Set<string>, cells: [{lesson,week}] } — persists after drag
  const justDraggedRef = useRef(false); // prevents outer-div onClick from clearing selection after a drag

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
    // Also include archived students who have tally entries in the current term —
    // they should stay visible until the tally is closed at term end. Session 97:
    // require at least one non-"removed" entry, otherwise hide the row. This
    // auto-cleans up the case where a student was added to the timetable, all
    // their cells were marked Inactive (e.g. they hadn't actually started yet),
    // and the student was then archived — the row would otherwise linger with
    // no way to remove it. Mid-term quitters keep their rows because they have
    // real completed/missed entries.
    if (activeTerm) {
      const validWeekKeys = new Set(termWeeks.map(w => w.weekKey));
      const archivedByKey = new Map();
      for (const e of tallyEntries) {
        if (!validWeekKeys.has(e.weekKey)) continue;
        if (e.isGroup || !e.studentId) continue;
        const key = `${e.studentId}|${e.instrument}`;
        if (seen.has(key)) continue;
        const liveStu = students.find(s => s.id === e.studentId);
        if (!liveStu || liveStu.status !== "archived") continue;
        if (selectedSchool !== "all" && e.schoolId !== selectedSchool) continue;
        if (!archivedByKey.has(key)) archivedByKey.set(key, { firstEntry: e, liveStu, hasReal: false });
        if (e.status !== "removed") archivedByKey.get(key).hasReal = true;
      }
      for (const [key, { firstEntry: e, liveStu, hasReal }] of archivedByKey) {
        if (!hasReal) continue;
        seen.add(key);
        rows.push({
          id: e.lessonId || key,
          lessonKey: key,
          studentId: e.studentId,
          studentName: e.studentName || liveStu.name,
          instrument: e.instrument,
          schoolId: e.schoolId,
          teacherId: e.teacherId || "",
          teacherName: e.teacherName || "",
          day: e.day || "",
          isGroup: false,
          _archived: true,
        });
      }
    }
    rows.sort((a, b) => {
      const nameA = (a.isGroup ? (a.groupName || "") : (a.studentName || "")).toLowerCase();
      const nameB = (b.isGroup ? (b.groupName || "") : (b.studentName || "")).toLowerCase();
      return nameA.localeCompare(nameB);
    });
    return rows;
  }, [schoolLessons, tallyEntries, activeTerm, termWeeks, students, selectedSchool]);

  // ── Entry lookup ────────────────────────────────────────────
  const entryMap = useMemo(() => {
    if (!activeTerm) return {};
    // Build set of valid weekKeys for this term so we only show relevant entries
    const validWeekKeys = new Set(termWeeks.map(w => w.weekKey));
    const map = {};
    for (const e of tallyEntries) {
      if (e.schoolId === "__private__") continue; // private entries handled by privateEntryMap
      if (selectedSchool !== "all" && e.schoolId !== selectedSchool) continue;
      if (!validWeekKeys.has(e.weekKey)) continue;
      map[`${e.lessonKey}|${e.weekKey}`] = e;
    }
    return map;
  }, [tallyEntries, activeTerm, selectedSchool, termWeeks]);

  // ── Private students ─────────────────────────────────────────
  const privateStudents = useMemo(() =>
    students.filter(s => s.schoolId === "__private__" && (s.status === "active" || s.status === "pending" || s.status === "trial")),
    [students]
  );

  const privateLessonRows = useMemo(() =>
    privateStudents.flatMap(student =>
      (student.instruments || []).filter(inst => inst.name).map(inst => ({
        lessonKey: `private|${student.id}|${inst.name}`,
        id: `private|${student.id}|${inst.name}`,
        studentId: student.id,
        studentName: student.name,
        instrument: inst.name,
        schoolId: "__private__",
        teacherId: inst.teacherId || "",
        teacherName: teachers.find(t => t.id === inst.teacherId)?.name || "",
        day: "Saturday",
        isGroup: false,
      }))
    ),
    [privateStudents, teachers]
  );

  const privateEntryMap = useMemo(() => {
    if (!activeTerm) return {};
    const validWeekKeys = new Set(termWeeks.map(w => w.weekKey));
    const map = {};
    for (const e of tallyEntries) {
      if (e.schoolId !== "__private__") continue;
      if (!validWeekKeys.has(e.weekKey)) continue;
      map[`${e.lessonKey}|${e.weekKey}`] = e;
    }
    return map;
  }, [tallyEntries, activeTerm, termWeeks]);

  const privateStats = useMemo(() => {
    const marked = Object.values(privateEntryMap);
    const removed = marked.filter(e => e.status === "removed").length;
    const totalCells = privateLessonRows.length * termWeeks.length - removed;
    const completed = marked.filter(e => e.status === "completed").length;
    const missed = marked.filter(e => e.status === "missed").length;
    const makeupOwed = marked.filter(e => e.status === "missed" && e.makeupEligible && !e.madeUp).length;
    const madeUp = marked.filter(e => e.madeUp).length;
    return { totalCells, completed, missed, makeupOwed, madeUp };
  }, [privateEntryMap, privateLessonRows, termWeeks]);

  // ── Holiday lesson map: which cells have a catch-up card on the timetable ──
  const holidayLessonMap = useMemo(() => {
    const map = {};
    if (!weeklyTimetables) return map;
    const holidayWeekKeys = new Set(termWeeks.filter(w => w.isHoliday).map(w => w.weekKey));
    if (holidayWeekKeys.size === 0) return map;
    for (const [sk, weeklyData] of Object.entries(weeklyTimetables)) {
      const parts = sk.split("|");
      const wk = parts[0];
      if (!holidayWeekKeys.has(wk)) continue;
      for (const lesson of (weeklyData.lessons || [])) {
        if (!lesson.studentId) continue;
        if (!lesson.isMakeup) continue; // only catch-up cards make a holiday cell non-blank
        const lessonKey = lesson.isGroup ? `group|${lesson.groupId}` : `${lesson.studentId}|${lesson.instrument}`;
        map[`${lessonKey}|${wk}`] = true;
      }
    }
    return map;
  }, [weeklyTimetables, termWeeks]);

  // ── Cycle status on left click ─────────────────────────────
  // Term weeks: unchecked → completed → missed+catchup owed → caught up (↺) → missed no catchup → inactive → unchecked
  // Holiday weeks: unmarked → completed → missed (no catch-up) → unmarked
  const quickComplete = (lesson, week) => {
    const key = `${lesson.lessonKey}|${week.weekKey}`;
    const existing = entryMap[key] || privateEntryMap[key];
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
      // Session 98.1: explicitly flag as user-authored. Previously this field
      // was absent, which was functionally equivalent to false in the 97.1
      // predicate (!e.autoRecorded returns true for undefined) but would
      // silently break if anyone later changed the predicate to check
      // `e.autoRecorded === false` instead. Explicit is safer.
      autoRecorded: false,
    };
    const upsert = (patch) => {
      const entry = { id: existing?.id || uid(), ...baseEntry, ...patch };
      setTallyEntries(prev => [...prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== key), entry]);
    };
    const removeEntry = () => setTallyEntries(prev => prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== key));

    // ── Holiday week cycle ──────────────────────────────────
    if (week.isHoliday) {
      // Only consider entries explicitly created for holiday catch-ups
      const hExisting = existing?.isHolidayCatchup ? existing : null;
      const status = hExisting?.status;
      // Find earliest catch-up owed for this student/instrument
      const findCatchupTarget = () =>
        tallyEntries
          .filter(e => e.studentId === lesson.studentId && e.instrument === lesson.instrument && e.status === "missed" && e.makeupEligible && !e.madeUp)
          .sort((a, b) => (a.weekKey || "").localeCompare(b.weekKey || ""))[0] || null;

      if (!hExisting) {
        // unmarked → completed: resolve catch-up as attended
        const target = findCatchupTarget();
        upsert({ status: "completed", reason: null, makeupEligible: false, madeUp: false, isHolidayCatchup: true, resolvedTallyId: target?.id || null });
        if (target) setTallyEntries(prev => prev.map(e => e.id === target.id ? { ...e, madeUp: true, madeUpWeekKey: week.weekKey } : e));
      } else if (status === "completed") {
        // completed → missed: change catch-up resolution to forfeit
        const prevTargetId = hExisting.resolvedTallyId;
        if (prevTargetId) {
          // Undo the madeUp, then forfeit
          setTallyEntries(prev => prev.map(e => e.id === prevTargetId ? { ...e, madeUp: false, madeUpWeekKey: undefined } : e));
        }
        const target = prevTargetId ? tallyEntries.find(e => e.id === prevTargetId) : findCatchupTarget();
        upsert({ status: "missed", reason: null, makeupEligible: false, madeUp: false, isHolidayCatchup: true, resolvedTallyId: target?.id || null });
        if (target) {
          // Use setTimeout to let the undo settle first
          setTimeout(() => setTallyEntries(prev => prev.map(e => e.id === target.id ? { ...e, makeupEligible: false } : e)), 0);
        }
      } else {
        // missed → unmarked (delete entry + undo catch-up resolution)
        const prevTargetId = hExisting.resolvedTallyId;
        if (prevTargetId) {
          setTallyEntries(prev => prev.map(e => e.id === prevTargetId ? { ...e, makeupEligible: true, madeUp: false, madeUpWeekKey: undefined } : e));
        }
        removeEntry();
      }
      return;
    }

    // ── Term week cycle (unchanged) ─────────────────────────
    const status = existing?.status;
    if (!existing) {
      // unchecked → completed
      upsert({ status: "completed", reason: null, makeupEligible: false, madeUp: false });
    } else if (status === "removed") {
      // inactive → unmarked (clear the entry entirely)
      removeEntry();
    } else if (status === "completed") {
      // completed → missed + catch-up owed
      upsert({ status: "missed", reason: null, makeupEligible: true, madeUp: false });
    } else if (status === "missed" && existing.makeupEligible && !existing.madeUp) {
      // missed+catchup owed → caught up (↺)
      upsert({ status: "missed", reason: existing.reason || null, makeupEligible: true, madeUp: true });
    } else if (status === "missed" && existing.madeUp) {
      // caught up → missed no catchup
      upsert({ status: "missed", reason: existing.reason || null, makeupEligible: false, madeUp: false });
    } else if (status === "missed" && !existing.makeupEligible && existing.reason !== "extended_absence") {
      // missed no catchup → extended absence (half fees)
      upsert({ status: "missed", reason: "extended_absence", makeupEligible: false, madeUp: false });
    } else if (status === "missed" && existing.reason === "extended_absence") {
      // extended absence → inactive (removed)
      upsert({ status: "removed", reason: "inactive", makeupEligible: false, madeUp: false });
    } else {
      // any other state → unchecked
      removeEntry();
    }
  };

  // ── Edit cell ───────────────────────────────────────────────
  const openEdit = (lesson, week) => {
    const key = `${lesson.lessonKey}|${week.weekKey}`;
    const existing = entryMap[key] || privateEntryMap[key];
    setEditCell({ lesson, week, key });
    const validCategories = ["informed_absence", "uninformed_absence", "teacher_absent"];
    const preCategory = existing?.reason && validCategories.includes(existing.reason) ? existing.reason : null;
    setEditForm(existing ? {
      status: existing.status,
      reason: existing.reason || "",
      reasonDetail: existing.reasonDetail || "",
      tvCategory: preCategory,
      notes: existing.notes || "",
      makeupEligible: existing.makeupEligible || false,
      madeUp: existing.madeUp || false,
    } : { status: "completed", reason: "", reasonDetail: "", tvCategory: null, notes: "", makeupEligible: false, madeUp: false });
  };

  const saveEdit = () => {
    if (!editCell) return;
    const { lesson, week, key } = editCell;
    const existing = entryMap[key] || privateEntryMap[key];
    const finalCategory = editForm.tvCategory;
    const finalReasonDetail = editForm.reasonDetail.trim();
    const finalNotes = editForm.notes.trim();

    // Remember the reason if it's new and not "Other"
    if (finalReasonDetail && finalReasonDetail.toLowerCase() !== "other" && !rememberedReasons.includes(finalReasonDetail)) {
      saveRememberedReasons([finalReasonDetail, ...rememberedReasons]);
    }

    // Determine status and makeup from category selection
    let newStatus, newReason, newMakeup;
    if (finalCategory) {
      newStatus = "missed";
      newReason = finalCategory;
      const reasonObj = TALLY_REASONS.find(r => r.value === finalCategory);
      newMakeup = reasonObj?.makeupEligible !== false;
    } else {
      // No category selected — preserve existing status, don't overwrite reason
      newStatus = existing?.status || "completed";
      newReason = existing?.reason || "other";
      newMakeup = existing?.makeupEligible ?? false;
    }

    const newEntry = {
      id: existing?.id || uid(),
      lessonKey: lesson.lessonKey, lessonId: lesson.id,
      isGroup: lesson.isGroup || false, groupName: lesson.groupName || "",
      studentId: lesson.studentId || "",
      studentName: lesson.isGroup ? (lesson.groupName || lesson.studentNames?.join(", ") || "Group") : lesson.studentName,
      studentNames: lesson.studentNames || [],
      instrument: lesson.instrument, schoolId: lesson.schoolId,
      teacherId: lesson.teacherId, teacherName: lesson.teacherName,
      weekKey: week.weekKey, weekLabel: week.label, weekNum: week.weekNum,
      termKey: activeTerm?.key, day: lesson.day,
      status: newStatus, reason: newReason,
      reasonDetail: finalReasonDetail,
      notes: finalNotes,
      makeupEligible: newMakeup,
      madeUp: newMakeup ? (existing?.madeUp || false) : false,
      recordedAt: existing?.recordedAt || new Date().toISOString(),
      // Session 98.1: explicit user-authored flag (see quickComplete baseEntry).
      autoRecorded: false,
    };
    setTallyEntries(prev => [...prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== key), newEntry]);

    // Update the reason label on the missed zone card in weekly timetables
    if (finalCategory && setWeeklyTimetables) {
      const reasonLabel = TALLY_REASONS.find(r => r.value === finalCategory)?.label || finalCategory;
      setWeeklyTimetables(prev => {
        const next = { ...prev };
        for (const storeKey of Object.keys(next)) {
          if (!storeKey.startsWith(week.weekKey + "|")) continue;
          const ent = next[storeKey];
          if (!ent?.missed) continue;
          next[storeKey] = { ...ent, missed: ent.missed.map(m => {
            const mKey = m.isGroup ? `group|${m.groupId}` : `${m.studentId}|${m.instrument}`;
            return mKey === lesson.lessonKey ? { ...m, reason: reasonLabel } : m;
          })};
        }
        return next;
      });
    }

    // Auto-create reminder for future informed/extended absences
    if ((finalCategory === "informed_absence" || finalCategory === "extended_absence") && isFutureWeek(week.weekKey)) {
      try {
        const existing2 = JSON.parse(localStorage.getItem("mt-reminders") || "[]");
        const alreadyExists = existing2.some(r => r.absenceWeekKey === week.weekKey && r.studentId === (lesson.studentId || ""));
        if (!alreadyExists) {
          const prevMonday = (() => {
            const d = new Date(week.weekKey + "T00:00:00");
            d.setDate(d.getDate() - 7);
            return d.toISOString().slice(0, 10);
          })();
          const reminder = {
            id: uid(),
            text: `${lesson.isGroup ? (lesson.groupName || "Group") : lesson.studentName} away in ${week.label}`,
            studentName: lesson.isGroup ? "" : (lesson.studentName || ""),
            studentId: lesson.studentId || "",
            date: prevMonday,
            absenceWeekKey: week.weekKey,
            createdAt: new Date().toISOString(),
          };
          localStorage.setItem("mt-reminders", JSON.stringify([reminder, ...existing2]));
          notify("Absence pre-marked — reminder added ✓", "success");
        } else {
          notify("Absence updated ✓", "success");
        }
      } catch {
        notify("Absence pre-marked ✓", "success");
      }
    } else if (finalCategory || finalNotes || finalReasonDetail) {
      notify("Entry updated ✓", "success");
    }

    setEditCell(null);
  };

  const clearEntry = () => {
    if (!editCell) return;
    setTallyEntries(prev => prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== editCell.key));
    setEditCell(null);
  };

  // Cancel drag if mouse released outside the table
  useEffect(() => {
    const onUp = () => { setDragSelect(null); setPrivateDragSelect(null); };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, []);

  // Cycle all selected cells together — each advances from its own current state
  const cycleSelected = () => {
    if (!selectedCells) return;
    selectedCells.cells.forEach(({ lesson, week }) => quickComplete(lesson, week));
  };

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

  // ── Cell render ─────────────────────────────────────────────
  const CellIcon = ({ entry, isFuture }) => {
    if (!entry) {
      return <span style={{ color: isFuture ? "#9CA3AF" : "#C4C9D4", display: "inline-flex", alignItems: "center" }}><span style={{ width: 12, height: 12, borderRadius: "50%", border: `1.5px solid currentColor`, display: "inline-block" }} /></span>;
    }
    if (entry.status === "removed") return <span style={{ color: "#D1D5DB", fontSize: 14, fontWeight: 700, lineHeight: 1 }}>—</span>;
    if (entry.status === "completed") return <span style={{ color: colors.success, display: "inline-flex", alignItems: "center" }}><Check size={14} /></span>;
    if (entry.status === "missed") {
      if (entry.madeUp) return <span style={{ color: colors.sidebarActive, display: "inline-flex", alignItems: "center" }}><RotateCcw size={13} /></span>;
      if (entry.makeupEligible) return <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", background: colors.accent }} />;
      if (entry.reason === "extended_absence") return <span style={{ color: colors.warning, display: "inline-flex", alignItems: "center" }} title="Extended Absence — half fees"><Palmtree size={13} /></span>;
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
    <div onClick={() => { if (justDraggedRef.current) { justDraggedRef.current = false; return; } if (editCell) setEditCell(null); if (selectedCells) setSelectedCells(null); setPrivateDragSelect(null); }}>
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
            { icon: <span style={{ color: colors.warning, display: "inline-flex", alignItems: "center" }}><Palmtree size={13} /></span>, color: colors.warning, label: "Extended absence" },
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
                        ? (r.groupName || "")
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
                      ? (lesson.groupName || lesson.studentNames?.join(", ") || "Group")
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
                          const isEditing = editCell?.key === `${lesson.lessonKey}|${w.weekKey}`;
                          const cellKey = `${lesson.lessonKey}|${w.weekKey}`;
                          const rowIdx = flatRowKeyToIdx.get(lesson.lessonKey) ?? 0;
                          const isHoliday = !!w.isHoliday;
                          // For holiday cells: only show entries explicitly created as holiday catch-ups
                          const holidayEntry = isHoliday ? (entry?.isHolidayCatchup ? entry : null) : entry;
                          const holidayHasLesson = isHoliday && (!!holidayEntry || !!holidayLessonMap[cellKey]);
                          const holidayBlank = isHoliday && !holidayHasLesson;
                          // Use filtered entry for holiday cells so random old data doesn't show
                          const displayEntry = isHoliday ? holidayEntry : entry;

                          const inDragRange = dragSelect !== null && (() => {
                            const loWi  = Math.min(dragSelect.startWi,     dragSelect.endWi);
                            const hiWi  = Math.max(dragSelect.startWi,     dragSelect.endWi);
                            const loRow = Math.min(dragSelect.startRowIdx, dragSelect.endRowIdx);
                            const hiRow = Math.max(dragSelect.startRowIdx, dragSelect.endRowIdx);
                            return wi >= loWi && wi <= hiWi && rowIdx >= loRow && rowIdx <= hiRow;
                          })();
                          const inSelection = selectedCells?.keys.has(cellKey);
                          const highlighted = inDragRange || inSelection;

                          return (
                            <td key={w.weekKey}
                              style={{ padding: "6px 2px", borderBottom: `1px solid ${colors.border}`, textAlign: "center",
                                cursor: holidayBlank ? "default" : "pointer", position: "relative",
                                background: holidayBlank ? (darkMode ? "rgba(180,80,80,0.10)" : "rgba(248,113,113,0.08)")
                                  : isHoliday ? (highlighted ? `${colors.sidebarActive}18` : darkMode ? "rgba(180,80,80,0.15)" : "rgba(248,113,113,0.13)")
                                  : highlighted ? `${colors.sidebarActive}18` : hoveredWeekKey === w.weekKey ? (darkMode ? colors.sidebarHover : "#F3F4F6") : "transparent",
                                boxShadow: highlighted && !holidayBlank ? `inset 0 0 0 2px ${colors.sidebarActive}70` : "none",
                                transition: "background 0.1s",
                                userSelect: "none" }}
                              onMouseDown={e => {
                                if (e.button !== 0 || holidayBlank) return;
                                e.preventDefault();
                                if (selectedCells?.keys.has(cellKey)) return;
                                setSelectedCells(null);
                                setDragSelect({ startWi: wi, endWi: wi, startRowIdx: rowIdx, endRowIdx: rowIdx });
                              }}
                              onMouseEnter={e => {
                                setHoveredWeekKey(w.weekKey);
                                if (holidayBlank) return;
                                if (dragSelect) {
                                  setDragSelect(prev => prev ? { ...prev, endWi: wi, endRowIdx: rowIdx } : null);
                                } else if (!selectedCells) {
                                  const r = e.currentTarget.getBoundingClientRect();
                                  const madeUpWeekLabel = displayEntry?.madeUp && displayEntry?.madeUpWeekKey
                                    ? (termWeeks.find(tw => tw.weekKey === (displayEntry.madeUpWeekKey || "").split("|")[0])?.label || null)
                                    : null;
                                  const text = isHoliday
                                    ? (displayEntry?.status === "completed" ? "Holiday — Completed" : displayEntry?.status === "missed" ? "Holiday — Missed" : "Holiday — Unmarked")
                                    : displayEntry?.status === "removed"
                                    ? "Inactive (click to clear to unmarked)"
                                    : displayEntry?.status === "completed" ? (displayEntry.bandSession ? (displayEntry.notes || "Band Session") : "Completed" + (displayEntry.notes ? " — " + displayEntry.notes : ""))
                                    : displayEntry?.status === "missed" && displayEntry?.madeUp ? ("↺ Caught up" + (madeUpWeekLabel ? " — " + madeUpWeekLabel : ""))
                                    : displayEntry?.status === "missed" && displayEntry?.makeupEligible ? "Missed — catch-up owed"
                                    : displayEntry?.status === "missed" ? "Missed — no catch-up"
                                    : future ? "Future week — click to pre-mark" : "Unmarked";
                                  setTallyTooltip({ text, x: r.left + r.width / 2, y: r.top - 6, isMissed: displayEntry?.status === "missed" });
                                }
                              }}
                              onMouseUp={e => {
                                if (!dragSelect) return;
                                const loWi  = Math.min(dragSelect.startWi,     dragSelect.endWi);
                                const hiWi  = Math.max(dragSelect.startWi,     dragSelect.endWi);
                                const loRow = Math.min(dragSelect.startRowIdx, dragSelect.endRowIdx);
                                const hiRow = Math.max(dragSelect.startRowIdx, dragSelect.endRowIdx);
                                setDragSelect(null);
                                if (loWi === hiWi && loRow === hiRow) {
                                  // Single cell — normal cycle
                                  if (!holidayBlank) quickComplete(lesson, w);
                                } else {
                                  // Multi-cell — build selection from flatRows × week range
                                  const cells = [];
                                  for (let ri = loRow; ri <= hiRow; ri++) {
                                    const rowLesson = flatRows[ri];
                                    if (!rowLesson) continue;
                                    for (let wii = loWi; wii <= hiWi; wii++) {
                                      cells.push({ lesson: rowLesson, week: termWeeks[wii] });
                                    }
                                  }
                                  const keys = new Set(cells.map(c => `${c.lesson.lessonKey}|${c.week.weekKey}`));
                                  setSelectedCells({ keys, cells });
                                  justDraggedRef.current = true;
                                }
                              }}
                              onClick={e => {
                                e.stopPropagation();
                                if (holidayBlank) return;
                                if (inSelection) {
                                  selectedCells.cells.forEach(({ lesson: sl, week: sw }) => quickComplete(sl, sw));
                                }
                              }}
                              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (holidayBlank) return; if (displayEntry?.madeUp) { setMadeUpPopup({ x: e.clientX, y: e.clientY, weekNum: w.label }); } else if (!isHoliday) openEdit(lesson, w); }}
                              onMouseLeave={() => { if (!dragSelect && !selectedCells) { setHoveredWeekKey(null); setTallyTooltip(null); } }}>
                              {!holidayBlank && (
                                <div style={{ width: 28, height: 28, margin: "0 auto", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: isEditing ? "rgba(52,69,101,0.07)" : displayEntry ? (displayEntry.status === "completed" ? `${colors.success}18` : displayEntry.status === "removed" ? (darkMode ? colors.inputBg : "#F9FAFB") : displayEntry.madeUp ? "rgba(52,69,101,0.07)" : displayEntry.makeupEligible ? colors.accentLight : colors.redLight) : "transparent", border: isEditing ? "2px solid #3B82F6" : "none" }}>
                                  <CellIcon entry={displayEntry} isFuture={future} />
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
                                      const cat = entry.reason === "informed_absence" ? "Informed absence"
                                        : entry.reason === "uninformed_absence" ? "Uninformed absence"
                                        : entry.reason === "teacher_absent" ? "Teacher absent"
                                        : "Missed";
                                      const detail = entry.reasonDetail ? ` (${entry.reasonDetail})` : "";
                                      return `  • ${w.label}${detail ? ` — ${cat}${detail}` : ` — ${cat}`}`;
                                    });
                                  const catchupOwed = rowEntries.filter(e => e?.status === "missed" && e.makeupEligible && !e.madeUp).length;
                                  if (lesson.isGroup) {
                                    const groupLabel = lesson.groupName || "Group";
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
      {editCell && (() => {
        const existing = entryMap[editCell.key] || privateEntryMap[editCell.key];
        const { lesson, week } = editCell;
        const tvCategory = editForm.tvCategory;
        const showDetailsBorder = editForm.reasonDetail.trim().toLowerCase() === "other";
        const catBtnStyle = (val) => ({
          width: "100%", padding: "11px 14px", marginBottom: 6, borderRadius: 8, fontSize: 13,
          fontWeight: tvCategory === val ? 700 : 500, cursor: "pointer", fontFamily: "inherit",
          transition: "all 0.12s", textAlign: "left",
          border: `1.5px solid ${tvCategory === val ? colors.sidebarActive : colors.border}`,
          background: tvCategory === val ? "rgba(52,69,101,0.1)" : colors.cardBg,
          color: tvCategory === val ? colors.sidebarActive : colors.text,
        });
        const handleCategory = (val) => {
          setEditForm(f => ({ ...f, tvCategory: f.tvCategory === val ? null : val }));
        };
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setEditCell(null)}>
            <div style={{ background: colors.cardBg, borderRadius: 14, padding: 22, width: 360, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", maxHeight: "90vh", overflowY: "auto" }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, marginBottom: 3 }}>
                {lesson.isGroup ? (lesson.groupName || "Group") : lesson.studentName}
              </div>
              <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 16 }}>
                {lesson.instrument} · {lesson.day} · {week.label} ({activeTerm?.label})
              </div>
              {/* Reason combobox */}
              <input
                list="tv-reasons-list"
                value={editForm.reasonDetail}
                onChange={e => setEditForm(f => ({ ...f, reasonDetail: e.target.value }))}
                placeholder="Reason (e.g. swimming, excursion…)"
                style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", marginBottom: 10,
                  border: `1.5px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13,
                  fontFamily: "inherit", color: colors.text, background: colors.cardBg, outline: "none" }}
                onFocus={e => e.target.style.borderColor = colors.sidebarActive}
                onBlur={e => e.target.style.borderColor = colors.inputBorder}
              />
              <datalist id="tv-reasons-list">
                {rememberedReasons.map(r => <option key={r} value={r} />)}
                <option value="Other" />
              </datalist>
              {/* Category buttons */}
              {[
                { value: "informed_absence", label: "Informed Absence" },
                { value: "uninformed_absence", label: "Uninformed Absence" },
                { value: "teacher_absent", label: "Teacher Absence" },
                { value: "extended_absence", label: "Extended Absence (half fees)" },
              ].map(btn => (
                <button key={btn.value} onClick={() => handleCategory(btn.value)} style={catBtnStyle(btn.value)}
                  onMouseEnter={e => { if (tvCategory !== btn.value) e.currentTarget.style.background = colors.blueLight; }}
                  onMouseLeave={e => { if (tvCategory !== btn.value) e.currentTarget.style.background = colors.cardBg; }}>
                  {btn.label}
                </button>
              ))}
              {/* Details */}
              <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, marginTop: 10, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.3 }}>Details</div>
              <textarea
                value={editForm.notes}
                onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Optional — unusual circumstances, notes for your records…"
                rows={3}
                style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", resize: "vertical",
                  border: `1.5px solid ${showDetailsBorder ? colors.sidebarActive : colors.inputBorder}`,
                  borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text,
                  background: colors.cardBg, outline: "none", lineHeight: 1.5, marginBottom: 16 }}
                onFocus={e => e.target.style.borderColor = colors.sidebarActive}
                onBlur={e => e.target.style.borderColor = showDetailsBorder ? colors.sidebarActive : colors.inputBorder}
              />
              {/* Footer */}
              <div style={{ display: "flex", gap: 8 }}>
                {existing && (
                  <button onClick={clearEntry}
                    style={{ padding: "9px 14px", borderRadius: 8, background: colors.redLight, color: colors.danger, fontWeight: 600, fontSize: 13, border: `1px solid ${colors.danger}50`, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                    Clear
                  </button>
                )}
                <button onClick={() => setEditCell(null)}
                  style={{ flex: 1, padding: "9px 0", borderRadius: 8, background: colors.tagBg, color: colors.gray700, fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.border}
                  onMouseLeave={e => e.currentTarget.style.background = colors.tagBg}>
                  Cancel
                </button>
                <button onClick={saveEdit}
                  style={{ flex: 2, padding: "9px 0", borderRadius: 8, fontWeight: 700, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit",
                    background: colors.sidebarActive, color: "#fff" }}>
                  Save
                </button>
              </div>
              {/* Email parent — shown when entry is a recorded missed lesson for an individual student */}
              {(() => {
                if (!existing || existing.status !== "missed" || lesson.isGroup) return null;
                const st = students.find(s => s.id === lesson.studentId);
                const emails = st ? getParentEmails(st) : [];
                if (!emails.length) return null;
                const school = schools.find(s => s.id === lesson.schoolId);
                const tmpl = getEmailTemplates()[existing.reason] || getEmailTemplates().other;
                const parentName = (st?.parents?.[0]?.name || "").split(" ")[0] || "there";
                const resolved = resolveTemplate(tmpl, {
                  studentName: preferredFirstName(lesson.studentName),
                  parentName: preferredFirstName(parentName) || "there",
                  instrument: lesson.instrument || "",
                  day: lesson.day || "",
                  weekLabel: week.label || "",
                  teacherName: lesson.teacherName || "",
                  schoolName: school?.name || "",
                  absenceReason: existing.reasonDetail || "",
                });
                return (
                  <button onClick={() => { openCompose(emails, { subject: resolved.subject, body: resolved.body, from: school?.senderEmail || "", triggerId: "tally_missed" }); setEditCell(null); }}
                    style={{ marginTop: 10, width: "100%", padding: "8px 0", borderRadius: 8, background: "none", color: colors.accent, fontWeight: 600, fontSize: 13, border: `1px solid ${colors.accent}60`, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    <Mail size={13} /> Email parent
                  </button>
                );
              })()}
            </div>
          </div>
        );
      })()}

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
                        const isEditing = editCell?.key === `${lesson.lessonKey}|${w.weekKey}`;
                        const cellKey = `${lesson.lessonKey}|${w.weekKey}`;
                        const isHoliday = !!w.isHoliday;

                        const inPrivateDragRange = privateDragSelect !== null && (() => {
                          const loWi  = Math.min(privateDragSelect.startWi,     privateDragSelect.endWi);
                          const hiWi  = Math.max(privateDragSelect.startWi,     privateDragSelect.endWi);
                          const loRow = Math.min(privateDragSelect.startRowIdx, privateDragSelect.endRowIdx);
                          const hiRow = Math.max(privateDragSelect.startRowIdx, privateDragSelect.endRowIdx);
                          return wi >= loWi && wi <= hiWi && ri >= loRow && ri <= hiRow;
                        })();
                        const inSelection = selectedCells?.keys.has(cellKey);
                        const highlighted = inPrivateDragRange || inSelection;

                        return (
                          <td key={w.weekKey}
                            style={{ padding: "6px 2px", borderBottom: `1px solid ${colors.border}`, textAlign: "center", cursor: "pointer", position: "relative",
                              background: isHoliday ? (highlighted ? `${colors.sidebarActive}18` : darkMode ? "rgba(180,80,80,0.15)" : "rgba(248,113,113,0.13)")
                                : highlighted ? `${colors.sidebarActive}18` : hoveredWeekKey === w.weekKey ? (darkMode ? colors.sidebarHover : "#F3F4F6") : "transparent",
                              boxShadow: highlighted ? `inset 0 0 0 2px ${colors.sidebarActive}70` : "none",
                              transition: "background 0.1s",
                              userSelect: "none" }}
                            onMouseDown={e => {
                              if (e.button !== 0) return;
                              e.preventDefault();
                              if (selectedCells?.keys.has(cellKey)) return;
                              setSelectedCells(null);
                              setPrivateDragSelect({ startWi: wi, endWi: wi, startRowIdx: ri, endRowIdx: ri });
                            }}
                            onMouseEnter={e => {
                              setHoveredWeekKey(w.weekKey);
                              if (privateDragSelect) {
                                setPrivateDragSelect(prev => prev ? { ...prev, endWi: wi, endRowIdx: ri } : null);
                              } else if (!selectedCells) {
                                const r = e.currentTarget.getBoundingClientRect();
                                const madeUpWeekLabel = entry?.madeUp && entry?.madeUpWeekKey
                                  ? (termWeeks.find(tw => tw.weekKey === (entry.madeUpWeekKey || "").split("|")[0])?.label || null)
                                  : null;
                                const text = isHoliday
                                  ? (entry?.status === "completed" ? "Holiday — Completed" : entry?.status === "missed" ? "Holiday — Missed" : "Holiday — Unmarked")
                                  : entry?.status === "removed" ? "Inactive (click to clear)"
                                  : entry?.status === "completed" ? "Completed" + (entry.notes ? " — " + entry.notes : "")
                                  : entry?.status === "missed" && entry?.madeUp ? ("↺ Caught up" + (madeUpWeekLabel ? " — " + madeUpWeekLabel : ""))
                                  : entry?.status === "missed" && entry?.makeupEligible ? "Missed — catch-up owed"
                                  : entry?.status === "missed" ? "Missed — no catch-up"
                                  : future ? "Future — click to pre-mark" : "Unmarked";
                                setTallyTooltip({ text, x: r.left + r.width / 2, y: r.top - 6, isMissed: entry?.status === "missed" });
                              }
                            }}
                            onMouseUp={e => {
                              if (!privateDragSelect) return;
                              const loWi  = Math.min(privateDragSelect.startWi,     privateDragSelect.endWi);
                              const hiWi  = Math.max(privateDragSelect.startWi,     privateDragSelect.endWi);
                              const loRow = Math.min(privateDragSelect.startRowIdx, privateDragSelect.endRowIdx);
                              const hiRow = Math.max(privateDragSelect.startRowIdx, privateDragSelect.endRowIdx);
                              setPrivateDragSelect(null);
                              if (loWi === hiWi && loRow === hiRow) {
                                quickComplete(lesson, w);
                              } else {
                                const cells = [];
                                for (let rr = loRow; rr <= hiRow; rr++) {
                                  const rowLesson = privateLessonRows[rr];
                                  if (!rowLesson) continue;
                                  for (let wii = loWi; wii <= hiWi; wii++) {
                                    cells.push({ lesson: rowLesson, week: termWeeks[wii] });
                                  }
                                }
                                const keys = new Set(cells.map(c => `${c.lesson.lessonKey}|${c.week.weekKey}`));
                                setSelectedCells({ keys, cells });
                                justDraggedRef.current = true;
                              }
                            }}
                            onClick={e => {
                              e.stopPropagation();
                              if (inSelection) {
                                selectedCells.cells.forEach(({ lesson: sl, week: sw }) => quickComplete(sl, sw));
                              } else if (!privateDragSelect) {
                                quickComplete(lesson, w);
                              }
                            }}
                            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (entry?.madeUp) { setMadeUpPopup({ x: e.clientX, y: e.clientY, weekNum: w.label }); } else openEdit(lesson, w); }}
                            onMouseLeave={() => { if (!privateDragSelect && !selectedCells) { setHoveredWeekKey(null); setTallyTooltip(null); } }}>
                            <div style={{ width: 28, height: 28, margin: "0 auto", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                              background: isEditing ? "rgba(52,69,101,0.07)" : entry ? (entry.status === "completed" ? `${colors.success}18` : entry.status === "removed" ? (darkMode ? colors.inputBg : "#F9FAFB") : entry.madeUp ? "rgba(52,69,101,0.07)" : entry.makeupEligible ? colors.accentLight : colors.redLight) : "transparent",
                              border: isEditing ? "2px solid #3B82F6" : "none" }}>
                              <CellIcon entry={entry} isFuture={future} />
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
                                    const cat = entry.reason === "informed_absence" ? "Informed absence"
                                      : entry.reason === "uninformed_absence" ? "Uninformed absence"
                                      : entry.reason === "teacher_absent" ? "Teacher absent"
                                      : "Missed";
                                    const detail = entry.reasonDetail ? ` (${entry.reasonDetail})` : "";
                                    return `  • ${w.label}${detail ? ` — ${cat}${detail}` : ` — ${cat}`}`;
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
