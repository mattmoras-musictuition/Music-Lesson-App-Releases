// ============================================================
// DASHBOARD — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Mail, Reply, Copy, Search, UserPlus, Plus, Zap, Bell, CalendarOff, AlertTriangle, RefreshCw, CalendarDays, ExternalLink, RotateCcw, Music, Building2, Pencil, Pin, ChevronLeft, ChevronRight, CalendarCheck, Loader2, CircleDot, Circle, Paperclip, ChevronUp, ChevronDown, Folder, ArrowUp, Download, FolderInput, Guitar } from "lucide-react";
import { DAYS, STORAGE_KEYS, INSTRUMENTS, APP_VERSION, instruments_colors, BAND_COLOR } from "../constants";
import { INTR_DISPLAY_TYPE } from "../utils/eventTypes";
import { loadTeacherSharedEvents, normaliseTeacherSharedEvent } from "../utils/interruptionsDB";
import { useTheme } from "../context/ThemeContext";
import { uid, melbourneNow, melbourneToday, toLocalDateStr, to12h, getCurrentWeekMonday, getTermWeekLabel, getParentEmails, openCompose, openGmailSequential, getInitials, getSchoolAcronym, timeToMin, toTimeLabel, _getMondayOf, getInterruptionAffectedStudents, formatSiblingMissedText, getLiveTeacherName } from "../utils/helpers";
import { computeTermWeekNum, computeTermKey } from "../utils/tallyHelpers";
import { getMissedSince, getMissedEntries, getInformedAbsencesForWeek, getOpenCatchupRows } from "../utils/tallyDerive";
import { getTerms, getCurrentTerm, getTermWeeks } from "../utils/termWeeks";
// v2.18.0 — uninvoiced-students alert chip. Same derivation + term resolution
// the Invoicing tab uses (NOT termWeeks' getCurrentTerm — invoicing terms come
// from detectTerms over term-break interruptions).
import { getUninvoicedStudents, uninvoicedDismissKey } from "../utils/uninvoicedDerive";
import { resolveCurrentTerm } from "../utils/invoiceTerms";
import { anthropicFetch, getAnthropicHeaders } from "../utils/api";
import { getUserTemplates, applyMergeCtx, preferredFirstName, getEmailTemplates, resolveTemplate } from "../utils/emailTemplates";
import { preprocessEmail, resolveDisplayName, decodeEntities, isPlainTextHtml, getPlainParts, formatWallOfText, getCleanHtml, schoolSenderForSourceEmail, getPrimaryAddress, lessonChangeInfo } from "../utils/emailHelpers";
import { instrumentsFromEnrolments } from "../utils/enrolmentsDB";
import { insertResource as insertResourceRow } from "../utils/resourcesDB";
import { getCardTeacherId } from "../utils/teacherCoverageDB";
import { checkConstraints, isConstraintVisibleForLesson } from "../utils/constraints";
import { buildStudentMTTTeacherIndex, getStudentMTTTeacher } from "../utils/helpers";
import { TEACHER_COLORS } from "../data/parsers";
import { Card, PageTitle, NavButtons, Btn, Input, Tag, EmptyState, FileUpload, Checkbox, AddMemoryInput, FrozenCard, useDragScroll, PAGE_COLORS } from "../components/ui/SharedUI";
import { ErrorLogPanel, DashboardBackupBar } from "../components/ErrorLogPanel";
import { ExportDialog } from "../components/ExportDialog";
import { supabase } from "../supabaseClient";

// Strip leading Re:/RE:/Fwd:/FW: before prepending a prefix — prevents "Re: Re: ..."
const reSubject  = s => `Re: ${(s || "").replace(/^(re|fwd?)\s*:\s*/i, "").trim()}`;
const fwdSubject = s => `Fwd: ${(s || "").replace(/^(re|fwd?)\s*:\s*/i, "").trim()}`;

// Parses date ranges from reminder text — e.g. "20 April to 8 May" → { date, endDate }
function parseReminderDates(text) {
  if (!text) return {};
  const MONTHS = {
    jan:0,january:0, feb:1,february:1, mar:2,march:2, apr:3,april:3, may:4,
    jun:5,june:5, jul:6,july:6, aug:7,august:7, sep:8,september:8,
    oct:9,october:9, nov:10,november:10, dec:11,december:11
  };
  const pad = (y,m,d) => `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  function parseOne(str) {
    const s = str.trim().toLowerCase();
    const yr = new Date().getFullYear();
    let m;
    m = s.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/);
    if (m && MONTHS[m[2]] !== undefined) return pad(m[3]?+m[3]:yr, MONTHS[m[2]], +m[1]);
    m = s.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
    if (m && MONTHS[m[1]] !== undefined) return pad(m[3]?+m[3]:yr, MONTHS[m[1]], +m[2]);
    return null;
  }
  const D = '(?:\\d{1,2}\\s+[A-Za-z]+|[A-Za-z]+\\s+\\d{1,2})(?:\\s+\\d{4})?';
  const rangeRe = new RegExp(`(${D})\\s*(?:to|–|-|—)\\s*(${D})`, 'i');
  let m = text.match(rangeRe);
  if (m) {
    const start = parseOne(m[1]), end = parseOne(m[2]);
    if (start || end) return { ...(start?{date:start}:{}), ...(end?{endDate:end}:{}) };
  }
  const singleRe = new RegExp(`(${D})`, 'i');
  m = text.match(singleRe);
  if (m) { const d = parseOne(m[1]); if (d) return { date: d }; }
  return {};
}

// ── Instrument synonym map — maps what parents write to canonical teacher names ──
const INSTRUMENT_SYNONYMS = {
  "singing": "Voice", "voice": "Voice", "vocals": "Voice", "vocal": "Voice",
  "piano": "Piano", "keyboard": "Piano", "keys": "Piano", "pianoforte": "Piano",
  "guitar": "Guitar", "acoustic guitar": "Guitar", "electric guitar": "Guitar", "classical guitar": "Guitar", "nylon guitar": "Guitar",
  "bass guitar": "Bass Guitar", "bass": "Bass Guitar", "electric bass": "Bass Guitar",
  "violin": "Violin", "fiddle": "Violin",
  "viola": "Viola",
  "cello": "Cello",
  "double bass": "Double Bass", "upright bass": "Double Bass", "contrabass": "Double Bass",
  "drums": "Drums", "drum kit": "Drums", "drumkit": "Drums", "percussion": "Drums", "drum": "Drums",
  "flute": "Flute",
  "trumpet": "Trumpet",
  "trombone": "Trombone",
  "ukulele": "Ukulele", "uke": "Ukulele",
  "recorder": "Recorder",
  "saxophone": "Saxophone", "alto saxophone": "Saxophone", "tenor saxophone": "Saxophone", "sax": "Saxophone",
  "clarinet": "Clarinet",
  "french horn": "French Horn", "horn": "French Horn",
  "oboe": "Oboe",
  "bassoon": "Bassoon",
};

// Resolves a raw instrument word/phrase from email text to the exact name a teacher offers.
// Returns "" if no match found — prevents unrecognised instruments being pre-filled.
function resolveInstrument(text, teacherInstrumentNames) {
  if (!text || !teacherInstrumentNames || !teacherInstrumentNames.length) return "";
  // Try each synonym in longest-first order (so "bass guitar" beats "bass")
  const sorted = Object.entries(INSTRUMENT_SYNONYMS).sort((a, b) => b[0].length - a[0].length);
  for (const [synonym, canonical] of sorted) {
    const pattern = new RegExp(`\\b${synonym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i");
    if (pattern.test(text)) {
      const match = teacherInstrumentNames.find(n => n.toLowerCase() === canonical.toLowerCase());
      if (match) return match;
    }
  }
  // Direct match against teacher instrument names (catches anything not in synonym map)
  for (const name of teacherInstrumentNames) {
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i");
    if (pattern.test(text)) return name;
  }
  return "";
}

// Returns the previewable type for a given filename
function getAttachmentType(filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["txt", "csv", "md", "log", "json", "xml", "html", "htm", "css", "js"].includes(ext)) return "text";
  return "other";
}

export function Dashboard({ schools, students, enrolments, catchups = [], teachers, teacherCoverage, laneOverrides = [], specialists, interruptions, setInterruptions, groups, timetable, weeklyTimetables, setWeeklyTimetables, weeklyAckedConstraints, masterBreaks, contacts, bands, resources, setResources, documents, setDocuments, onNavigate, onImportFromMtt, onJumpToWeekly, onRestore, onBackup, errorLog, logError, notify, goBack, goForward, historyCursor, pageHistory, setStudentsViewState, setNewStudentPrefill, setAddParentPrefill, setNewContactPrefill, setSharedSchool, recordUsage, hoveredScrollRef, emailNavRef, emailListRef, filteredEmailsRef, todoUndoRef, autoSendQueue, cancelAutoSend, setDashBadges, onViewStudent, onViewGroups, onNewEmail, quickAddTodoTrigger, quickAddReminderTrigger, emailStyle }) {
  const { colors, darkMode } = useTheme();
  const activeStudents = students.filter(s => s.status === "active");

  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);
  const [hoveredDay, setHoveredDay] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null); // persists after click
  const [calendarEvents, setCalendarEvents] = useState(() => { try { return JSON.parse(localStorage.getItem("mt-calendar-events") || "[]"); } catch { return []; } });
  const saveCalendarEvents = (evs) => { setCalendarEvents(evs); try { localStorage.setItem("mt-calendar-events", JSON.stringify(evs)); } catch {} };
  // Teacher-shared events (read-only), loaded from calendar_events on
  // mount. Separate state so saveCalendarEvents never persists them back.
  const [teacherShared, setTeacherShared] = useState([]);
  useEffect(() => { (async () => { const rows = await loadTeacherSharedEvents(); setTeacherShared(rows.map(normaliseTeacherSharedEvent)); })(); }, []);
  const [calEventMenu, setCalEventMenu] = useState(null); // { x, y, date, time, prefill }
  const [calEventForm, setCalEventForm] = useState(null); // rich form: { type, title, startDate, endDate, startTime, endTime, schoolId, affectsClasses, interruptionSubtype, details, id?, sourceStore?, x?, y? }
  const [expandedDays, setExpandedDays] = useState(new Set()); // Set of date strings with open expanded strips
  const [warningPopover, setWarningPopover] = useState(null); // { chipKey, rect, lines } — hover detail for per-school warning chips

  // Keep in sync with EVENT_TYPE_META in CalendarManager.js (different
  // shape: that copy uses `darkBg` instead of `dot`). public_holiday +
  // staff_event palettes transcribed from CalendarManager (dot = border).
  const EVENT_TYPE_META = {
    personal:       { label: "Personal",       bg: "#E8EDF5", border: "#6B82A8", text: "#3B4E6E", dot: "#6B82A8" },
    performance:    { label: "Performance",    bg: "#EEE9F5", border: "#8B7AAF", text: "#5C4A80", dot: "#8B7AAF" },
    interruption:   { label: "Interruption",   bg: "#F7F0E0", border: "#B8892E", text: "#705218", dot: "#B8892E" },
    public_holiday: { label: "Public Holiday", bg: "#FEE8E8", border: "#C45454", text: "#7A1A1A", dot: "#C45454" },
    staff_event:    { label: "Staff Event",    bg: "#F0EEFF", border: "#7C3AED", text: "#4C1D95", dot: "#7C3AED" },
    // teacher_event = teacher-sourced shared events from calendar_events;
    // staff_event = admin-authored Staff Events. Distinct concepts.
    teacher_event:  { label: "Teacher Events", bg: "#E5EFED", border: "#4D8C82", text: "#245C52", dot: "#4D8C82" },
  };
  // Keep in sync with INTERRUPTION_SUBTYPES in CalendarManager.js (that
  // copy omits curriculum_day). Display category resolved via the shared
  // INTR_DISPLAY_TYPE util.
  const INTERRUPTION_SUBTYPES = [
    { value: "student_free",   label: "Student Free Day" },
    { value: "curriculum_day", label: "Curriculum Day" },
    { value: "excursion",      label: "Excursion" },
    { value: "carnival",     label: "Carnival / Sports" },
    { value: "swimming",     label: "Swimming" },
    { value: "assembly",     label: "Assembly" },
    { value: "camp",         label: "Camp" },
    { value: "photos",       label: "Photo Day" },
    { value: "concert",      label: "Concert" },
    { value: "other",        label: "Other" },
  ];

  // Current week calculation
  const today = melbourneNow();
  const monday = getCurrentWeekMonday();
  const todayStr = toLocalDateStr(today);

  // ── Term weeks (shared with TallyView via src/utils/termWeeks.js) ──
  // Hoisted here so both sidebarAlertCount (L1383 catch-ups badge) and
  // the alerts-panel render block (L2676 catch-ups chip) can feed
  // termWeeks into getOpenCatchupRows.
  const termBreaks = useMemo(() =>
    interruptions.filter(i => i.type === "term_break")
      .reduce((acc, i) => { if (!acc.find(x => x.date === i.date)) acc.push(i); return acc; }, [])
      .sort((a, b) => a.date.localeCompare(b.date)),
    [interruptions]
  );
  const terms = useMemo(() => getTerms(termBreaks, melbourneNow()), [termBreaks]);
  const currentTerm = useMemo(() => getCurrentTerm(terms, melbourneNow()), [terms]);
  const termWeeks = useMemo(
    () => getTermWeeks({ activeTerm: currentTerm, termBreaks, now: melbourneNow() }),
    [currentTerm, termBreaks]
  );

  // Session 5B / C6 + chips-followup — per-day per-school unacked
  // constraint-warning entries for the day dropdown. Return shape:
  //   { [dateStr]: [ { schoolId, schoolCode, count, lines }, ... ] }
  // where `count` is the number of LESSONS (matches App.js
  // weeklyWarningCount semantic) and `lines` is one pre-formatted
  // string per (lesson, warning) pair, time-sorted then name-sorted.
  // Walks both the offset week AND (at offset=0) the next week's
  // Mon-Fri to cover the rolling boundary case where visibleDays
  // straddles weeks. Per-school entries with count===0 are omitted.
  const dropdownWarningCounts = useMemo(() => {
    const result = {};
    // v2.9.12 past-dated display gate: today's date (Melbourne local) as a
    // 'YYYY-MM-DD' string. Computed via the stable imported helper so it's not
    // a reactive dependency of this memo.
    const todayStrGate = melbourneToday();
    const baseMonday = getCurrentWeekMonday();
    baseMonday.setDate(baseMonday.getDate() + calendarWeekOffset * 7);
    const weeksToCompute = [baseMonday];
    if (calendarWeekOffset === 0) {
      const nextMonday = new Date(baseMonday);
      nextMonday.setDate(baseMonday.getDate() + 7);
      weeksToCompute.push(nextMonday);
    }
    // Specialist lookup — identical pattern to WeeklyAdjustments.js:241
    const specLookupRef = {};
    for (const entry of (specialists || [])) {
      const key = `${entry.schoolId}|${entry.className}|${entry.day}`;
      if (!specLookupRef[key]) specLookupRef[key] = [];
      specLookupRef[key].push({ start: timeToMin(entry.start), end: timeToMin(entry.end), subject: entry.subject });
    }
    for (const wkMonday of weeksToCompute) {
      const calMondayStr = toLocalDateStr(wkMonday);
      const weekDateMap = {};
      DAYS.forEach((day, i) => {
        const date = new Date(wkMonday);
        date.setDate(wkMonday.getDate() + i);
        weekDateMap[day] = toLocalDateStr(date);
      });
      const weekStart = weekDateMap.Monday;
      const weekEnd = weekDateMap.Friday;
      const weekInterruptions = (interruptions || []).filter(intr => {
        if (intr.type === "term_break") return false;
        const iStart = intr.date;
        const iEnd = intr.endDate || intr.date;
        return iStart <= weekEnd && iEnd >= weekStart;
      });
      for (const day of DAYS) {
        const dateStr = weekDateMap[day];
        const perSchool = [];
        for (const school of schools) {
          const wttKey = `${calMondayStr}|${school.id}`;
          const wttEntry = weeklyTimetables[wttKey];
          const lessonsSource = wttEntry ? (wttEntry.lessons || []) : (timetable ? timetable.lessons : []);
          // Bug A fix — pass the school's full-week lessons (not day-narrowed)
          // as the 4th positional arg so the helper's dual-class-time-pullout
          // check (which filters by l.day !== newDay) can see lessons on other
          // days. dayLessons is the OUTER iteration (which lessons to compute
          // warnings ON); schoolWeekLessons is what the helper sees internally.
          const schoolWeekLessons = lessonsSource.filter(l => l.schoolId === school.id);
          const dayLessons = schoolWeekLessons.filter(l => l.day === day);
          const lessonRows = [];
          for (const l of dayLessons) {
            if (weeklyAckedConstraints && weeklyAckedConstraints.has(l.id)) continue;
            // v2.9.12 past-dated display gate: keep the dashboard count in sync
            // with the Weekly view — past lessons (and future lessons whose
            // relational partner is past) contribute no warnings.
            if (!isConstraintVisibleForLesson(l, schoolWeekLessons, todayStrGate, weekDateMap, school)) continue;
            const slot = (school.slots || []).find(s => s.start === l.start) || { start: l.start, end: l.end || l.start, type: "class" };
            const ws = checkConstraints(l, day, slot, schoolWeekLessons, {
              weekKey: calMondayStr, selectedSchool: school.id, currentSchool: school,
              weeklyTimetables, teacherCoverage, laneOverrides,
              students, enrolments, teachers, schools, bands, groups,
              weekDateMap, weekInterruptions, specLookupRef, timetable,
            });
            if (ws.length === 0) continue;
            const stu = l.isGroup
              ? null
              : students.find(s => s.id === l.studentId);
            const name = l.isGroup
              ? (l.groupName || "Group")
              : (l.isBandSession
                  ? (l.bandName || "Band")
                  : (stu?.name || l.studentName || "Unknown"));
            const timeLabel = l.start ? toTimeLabel(l.start) : "";
            lessonRows.push({ start: l.start || "", name, timeLabel, ws });
          }
          if (lessonRows.length === 0) continue;
          lessonRows.sort((a, b) => {
            const t = (a.start || "").localeCompare(b.start || "");
            if (t !== 0) return t;
            return a.name.localeCompare(b.name);
          });
          const lines = [];
          for (const row of lessonRows) {
            for (const w of row.ws) {
              lines.push(`${row.name} ${row.timeLabel} — ${w}`);
            }
          }
          perSchool.push({
            schoolId: school.id,
            schoolCode: getSchoolAcronym(school),
            count: lessonRows.length,
            lines,
          });
        }
        if (perSchool.length > 0) result[dateStr] = perSchool;
      }
    }
    return result;
  }, [calendarWeekOffset, schools, weeklyTimetables, timetable, laneOverrides, weeklyAckedConstraints, teacherCoverage, students, enrolments, teachers, bands, groups, specialists, interruptions]);

  // After 6pm Fri / Sat / Sun, calendar rolls to next week — progress bar should match
  const _tdow = today.getDay(); const _tHour = today.getHours();
  const _rollFwd = (_tdow === 5 && _tHour >= 18) || _tdow === 6 || _tdow === 0;
  const effectiveTodayStr = _rollFwd ? toLocalDateStr(monday) : todayStr;
  const dow = today.getDay();
  const todayDayName = DAYS[dow === 0 ? 6 : dow - 1];
  const weekDates = DAYS.map((d, i) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + i);
    return { day: d, date: toLocalDateStr(date), dayNum: date.getDate(), month: date.toLocaleDateString(undefined, { month: "short" }) };
  });
  const weekLabel = `${weekDates[0].dayNum} ${weekDates[0].month} – ${weekDates[4].dayNum} ${weekDates[4].month}`;

  // Build rolling 5-day view: skip days past 6pm, fill from next week (used when offset=0)
  const hour = today.getHours();
  const allDaySlots = [];
  for (let w = 0; w < 2; w++) { // this week + next week
    for (let i = 0; i < 5; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + w * 7 + i);
      const dateStr = toLocalDateStr(date);
      const isToday = dateStr === todayStr;
      // Skip if past (before today, or today after 6pm)
      if (dateStr < todayStr) continue;
      if (isToday && hour >= 18) continue;
      allDaySlots.push({
        day: DAYS[i],
        date: dateStr,
        dayNum: date.getDate(),
        month: date.toLocaleDateString(undefined, { month: "short" }),
        isNextWeek: w > 0
      });
    }
  }
  const rollingDays = allDaySlots.slice(0, 5);
  // When offset != 0, show full Mon-Fri of the offset week
  const visibleDays = calendarWeekOffset === 0 ? rollingDays : (() => {
    const offMon = new Date(monday);
    offMon.setDate(monday.getDate() + calendarWeekOffset * 7);
    return DAYS.map((d, i) => {
      const date = new Date(offMon);
      date.setDate(offMon.getDate() + i);
      return { day: d, date: toLocalDateStr(date), dayNum: date.getDate(), month: date.toLocaleDateString(undefined, { month: "short" }), isNextWeek: false };
    });
  })();

  // Build per-day data
  const dayData = visibleDays.map(wd => {
    // Which teachers are at which schools on this day
    const teacherSchools = [];
    for (const teacher of teachers) {
      const dayLanes = teacherCoverage.filter(l => l.teacherId === teacher.id && l.day === wd.day && l.status === "active");
      for (const lane of dayLanes) {
        const school = schools.find(s => s.id === lane.schoolId);
        if (school) {
          const dayLessons = timetable ? timetable.lessons.filter(l => getCardTeacherId(l, teacherCoverage) === teacher.id && l.schoolId === school.id && l.day === wd.day) : [];
          const lessonCount = dayLessons.length;
          let firstLesson = null, lastLesson = null;
          if (dayLessons.length > 0) {
            firstLesson = dayLessons.reduce((a, b) => (a.start < b.start ? a : b));
            lastLesson = dayLessons.reduce((a, b) => (a.end > b.end ? a : b));
          }
          teacherSchools.push({ teacher, school, lessonCount, firstLesson, lastLesson });
        }
      }
    }

    // Interruptions on this day
    const dayInterruptions = interruptions.filter(intr => {
      if (intr.type === "term_break") return false;
      const start = intr.date;
      const end = intr.endDate || intr.date;
      if (wd.date < start || wd.date > end) return false;
      // Check school relevance
      return true;
    });

    // Weekly timetable status per school
    const weeklyStatus = {};
    for (const school of schools) {
      const key = `${toLocalDateStr(monday)}|${school.id}`;
      weeklyStatus[school.id] = weeklyTimetables[key] ? "generated" : "not generated";
    }

    // Students with notes at schools on this day
    const studentsWithNotes = activeStudents.filter(s => {
      if (!s.notes || !s.notes.trim()) return false;
      const school = schools.find(sc => sc.id === s.schoolId);
      if (!school) return false;
      return teacherCoverage.some(l => l.schoolId === school.id && l.day === wd.day && l.status === "active");
    });

    // Pending/trial students
    const pendingOnDay = students.filter(s => (s.status === "pending" || s.status === "trial") && schools.some(sc => sc.id === s.schoolId));

    return { ...wd, teacherSchools, dayInterruptions, weeklyStatus, studentsWithNotes, pendingOnDay };
  });

  // Students with 2+ missed lessons in the last 14 days — derived from WTT.missed.
  // Helper applies the count >= 2 threshold internally; cutoff snaps to the
  // containing Monday since WTT.missed lacks recordedAt (audit-acknowledged).
  const recentCutoff = new Date(today);
  recentCutoff.setDate(today.getDate() - 14);
  const sinceWeekKey = toLocalDateStr(_getMondayOf(recentCutoff));
  const missedList = getMissedSince({ weeklyTimetables, sinceWeekKey })
    .map(r => ({ ...r, schoolName: schools.find(s => s.id === r.schoolId)?.name || "" }));

  // Unacknowledged timetable warnings
  const archivedStudentIds = new Set(students.filter(s => s.status === "archived").map(s => s.id));
  const unschedCount = timetable ? timetable.unscheduled.filter(u => u.reason !== "Unassigned" && !archivedStudentIds.has(u.student?.id)).length : 0;
  // Session 3 / C2 — "unassigned" semantics shift from "enrolment has no
  // teacherId" to "non-group enrolment has no MTT placement yet." On Matt's
  // data this typically reduces the count: enrolments with a stamped teacher
  // but no scheduled MTT lesson used to be silent, now they surface here.
  const mttTeacherIdx = React.useMemo(
    () => buildStudentMTTTeacherIndex(timetable, teacherCoverage),
    [timetable, teacherCoverage]
  );
  const studentHasUnplacedEnrolment = React.useCallback((s) => {
    if (s.schoolId === "__private__") return false;
    return instrumentsFromEnrolments(s.id, enrolments).some(i => {
      if (i.isGroup) return false;
      const key = `${s.id}:${(i.name || "").trim().toLowerCase()}`;
      return !mttTeacherIdx.has(key);
    });
  }, [enrolments, mttTeacherIdx]);
  const unassignedCount = students.filter(s => s.status === "active" && studentHasUnplacedEnrolment(s)).length;
  const [bannerTip, setBannerTip] = React.useState(null);
  const [dashPanels, setDashPanels] = React.useState(() => { try { return { emails: false, todo: false, alerts: false, ...JSON.parse(localStorage.getItem(STORAGE_KEYS.dashPanels) || "{}") }; } catch { return { emails: false, todo: false, alerts: false }; } });
  const saveDashPanels = (next) => { setDashPanels(next); try { localStorage.setItem(STORAGE_KEYS.dashPanels, JSON.stringify(next)); } catch {} };

  // ── Reminders ─────────────────────────────────────────────────
  const [reminders, setReminders] = React.useState(() => { try { return JSON.parse(localStorage.getItem("mt-reminders") || "[]"); } catch { return []; } });
  const saveReminders = (r) => { setReminders(r); try { localStorage.setItem("mt-reminders", JSON.stringify(r)); } catch {} };

  // Sync reminders if BrowserPanel saves one externally
  React.useEffect(() => {
    const handler = () => { try { setReminders(JSON.parse(localStorage.getItem("mt-reminders") || "[]")); } catch {} };
    window.addEventListener("mt-reminders-updated", handler);
    return () => window.removeEventListener("mt-reminders-updated", handler);
  }, []);

  // Close the reminders panel, saving any pending typed input and any open expanded form
  const handleRemindersToggle = () => {
    if (!remindersOpen) { setRemindersOpen(true); return; }
    let arr = [...reminders];
    const t = remindersInput.trim();
    if (t) {
      const entry = { id: uid(), text: t, createdAt: new Date().toISOString() };
      if (remindersInputMentions.length) entry.mentions = remindersInputMentions;
      arr = [entry, ...arr];
      setRemindersInput("");
      setRemindersInputMentions([]);
    }
    if (remindersMetaModal && remindersMetaForm) {
      const f = remindersMetaForm;
      arr = arr.map(x => x.id === remindersMetaModal
        ? { ...x, ...f, text: f.text || x.text, mentions: f.mentions || x.mentions || [], week: f.week ? String(parseInt(f.week)) : "" }
        : x);
      setRemindersMetaModal(null);
      setRemindersMetaForm(null);
      setRemindersMentionQuery(null);
    }
    saveReminders(arr);
    setRemindersOpen(false);
  };
  const [remindersOpen, setRemindersOpen] = React.useState(false);
  const [remindersPanelSize, setRemindersPanelSize] = React.useState(() => { try { return JSON.parse(localStorage.getItem("mt-reminders-size") || '{"w":300,"h":480}'); } catch { return { w: 300, h: 480 }; } });
  const saveRemindersPanelSize = (s) => { setRemindersPanelSize(s); try { localStorage.setItem("mt-reminders-size", JSON.stringify(s)); } catch {} };
  const [remindersDragOver, setRemindersDragOver] = React.useState(false);
  const [remindersDropTarget, setRemindersDropTarget] = React.useState(false);
  const [remindersGlobalDrag, setRemindersGlobalDrag] = React.useState(false);
  const remindersGlobalDragCounter = React.useRef(0);
  const [remindersMetaModal, setRemindersMetaModal] = React.useState(null);
  const [remindersMetaForm, setRemindersMetaForm] = React.useState(null);
  const [remindersInput, setRemindersInput] = React.useState("");
  const [remindersInputMentions, setRemindersInputMentions] = React.useState([]);
  const remindersBtnRef = React.useRef(null);
  const remindersPanelRef = React.useRef(null);
  const remindersTypeRef = React.useRef(null);
  const dragSourceEmailRef = React.useRef(null);
  const [studentDropOpen, setStudentDropOpen] = React.useState(false);
  const bannerWrapperRef = React.useRef(null);
  const [splitRatio, setSplitRatio] = React.useState(() => { try { return parseFloat(localStorage.getItem("mt-dash-split-ratio") || "0.5"); } catch { return 0.5; } });
  const panelCardRef = React.useRef(null);
  const panelDividerDragging = React.useRef(false);
  const alertsPillRef = React.useRef(null);
  const [pillW, setPillW] = React.useState(90);
  React.useEffect(() => {
    if (!alertsPillRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setPillW(Math.round(e.contentRect.width + 20)); // +20 for horizontal padding
    });
    ro.observe(alertsPillRef.current);
    return () => ro.disconnect();
  }, []);
  // Track reminders button width so the right-side fade always clears the button
  const [remindersBtnW, setRemindersBtnW] = React.useState(100);
  React.useEffect(() => {
    if (!remindersBtnRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setRemindersBtnW(Math.round(e.contentRect.width + 20));
    });
    ro.observe(remindersBtnRef.current);
    return () => ro.disconnect();
  }, []);
  const saveSplitRatio = (r) => { const c = Math.min(0.7, Math.max(0.3, r)); setSplitRatio(c); try { localStorage.setItem("mt-dash-split-ratio", String(c)); } catch {} return c; };
  const handleDividerMouseDown = React.useCallback((e) => {
    e.preventDefault();
    panelDividerDragging.current = true;
    const onMove = (ev) => {
      if (!panelDividerDragging.current || !panelCardRef.current) return;
      const rect = panelCardRef.current.getBoundingClientRect();
      saveSplitRatio((ev.clientX - rect.left) / rect.width);
    };
    const onUp = () => { panelDividerDragging.current = false; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // Re-sync panel position after any render (day strip expand, panel open/close, etc.)
  // Button is position:absolute in the banner wrapper — pure CSS, no JS needed.
  React.useLayoutEffect(() => {
    if (!remindersOpen || !remindersPanelRef.current || !bannerWrapperRef.current) return;
    const rect = bannerWrapperRef.current.getBoundingClientRect();
    const sc = document.querySelector("[data-printarea]");
    if (!sc) return;
    const cRect = sc.getBoundingClientRect();
    remindersPanelRef.current.style.top = (rect.top - cRect.top + sc.scrollTop) + "px";
    remindersPanelRef.current.style.right = (cRect.right - rect.right) + "px";
  });

  React.useEffect(() => {
    const onEnter = () => { remindersGlobalDragCounter.current += 1; setRemindersGlobalDrag(true); };
    const onLeave = () => { remindersGlobalDragCounter.current = Math.max(0, remindersGlobalDragCounter.current - 1); if (remindersGlobalDragCounter.current === 0) setRemindersGlobalDrag(false); };
    const onReset = () => { remindersGlobalDragCounter.current = 0; setRemindersGlobalDrag(false); setRemindersDragOver(false); setRemindersDropTarget(false); };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onReset);
    window.addEventListener("dragend", onReset);
    return () => { window.removeEventListener("dragenter", onEnter); window.removeEventListener("dragleave", onLeave); window.removeEventListener("drop", onReset); window.removeEventListener("dragend", onReset); };
  }, []);

  const [inboxEmails, setInboxEmails] = React.useState(() => { try { const c = JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxCache) || "null"); return Array.isArray(c?.emails) ? c.emails.map(preprocessEmail) : []; } catch { return []; } });
  const inboxEmailsRef = React.useRef(inboxEmails);
  React.useEffect(() => { inboxEmailsRef.current = inboxEmails; }, [inboxEmails]);
  const onNewEmailRef = React.useRef(onNewEmail);
  React.useEffect(() => { onNewEmailRef.current = onNewEmail; }, [onNewEmail]);
  const [emailFolder, setEmailFolder] = React.useState(() => { try { return localStorage.getItem("mt-email-folder") || "inbox"; } catch { return "inbox"; } }); // "inbox" | "sent"
  const setEmailFolderPersist = (v) => { setEmailFolder(v); try { localStorage.setItem("mt-email-folder", v); } catch {} };
  const [sentEmails, setSentEmails] = React.useState([]);
  const [sentLoading, setSentLoading] = React.useState(false);
  const [inboxLastFetched, setInboxLastFetched] = React.useState(() => { try { const c = JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxCache) || "null"); return c?.ts || 0; } catch { return 0; } });
  const [gmailRateLimitUntil, setGmailRateLimitUntil] = React.useState(() => {
    try { return parseInt(localStorage.getItem("mt-gmail-rate-limit-until") || "0", 10); } catch { return 0; }
  });
  // Ref so fetchInbox/fetchSent can read rate-limit state without being in their dep arrays
  const gmailRateLimitUntilRef = React.useRef(gmailRateLimitUntil);
  React.useEffect(() => { gmailRateLimitUntilRef.current = gmailRateLimitUntil; }, [gmailRateLimitUntil]);
  const [inboxLoading, setInboxLoading] = React.useState(false);
  const [inboxError, setInboxError] = React.useState(null);
  const [inboxSelected, setInboxSelected] = React.useState(null);

  // Register keyboard navigation callback so parent's keydown handler can call it
  React.useEffect(() => {
    // Handle messages from email iframes
    const handleIframeMessage = (e) => {
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type === "open-link" && e.data.url) {
        if (window.electronAPI?.openExternal) window.electronAPI.openExternal(e.data.url);
        else window.open(e.data.url, "_blank");
      }
    };
    window.addEventListener("message", handleIframeMessage);
    return () => window.removeEventListener("message", handleIframeMessage);
  }, []);

  React.useEffect(() => {
    if (!emailNavRef) return;
    emailNavRef.current = {
      navigate: (dir) => {
        const emails = filteredEmailsRef.current;
        if (!emails.length) return;
        setInboxSelected(prev => {
          const currentIdx = emails.findIndex(em => em.id === prev);
          const nextIdx = currentIdx === -1
            ? (dir > 0 ? 0 : emails.length - 1)
            : Math.max(0, Math.min(emails.length - 1, currentIdx + dir));
          const next = emails[nextIdx];
          // Mark as read and scroll into view
          setEmailReadIds(ids => { const n = new Set(ids); n.add(next.id); try { localStorage.setItem(STORAGE_KEYS.inboxReadIds, JSON.stringify([...n])); } catch {} return n; });
          requestAnimationFrame(() => {
            const el = emailListRef.current?.querySelector(`[data-emailid="${next.id}"]`);
            if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
          });
          return next.id;
        });
      }
    };
    return () => { if (emailNavRef) emailNavRef.current = { navigate: null }; };
  }, [emailNavRef]);

  // Register todo undo callback
  React.useEffect(() => {
    if (!todoUndoRef) return;
    todoUndoRef.current = () => {
      if (todoUndoStack.current.length === 0) return;
      const prev = todoUndoStack.current.pop();
      setTodoItems(prev); todoItemsRef.current = prev;
      try { localStorage.setItem(STORAGE_KEYS.todoItems, JSON.stringify(prev)); } catch {}
    };
    return () => { if (todoUndoRef) todoUndoRef.current = null; };
  }, [todoUndoRef]);
  const [emailHistoryExpanded, setEmailHistoryExpanded] = React.useState(new Set());
  const [threadMsgSelected, setThreadMsgSelected] = React.useState({}); // threadId -> messageId
  const [emailContextMenu, setEmailContextMenu] = React.useState(null); // { x, y, text, emailId, email?, fromAddr?, fromName?, isSenderCtx? }
  const [emailContextSubMenu, setEmailContextSubMenu] = React.useState(null); // "contacts" | null
  const [emailCategoryFilter, setEmailCategoryFilter] = React.useState(new Set()); // ★ | parent | teacher | staff | admin | enquiry | other
  const [emailCategoryOverrides, setEmailCategoryOverrides] = React.useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.emailCategoryOverrides) || "{}"); } catch { return {}; } });
  const [emailNoReplyOverrides, setEmailNoReplyOverrides] = React.useState(() => { try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.emailNoReplyOverrides) || "[]")); } catch { return new Set(); } });
  const [emailMoveToOpen, setEmailMoveToOpen] = React.useState(null); // emailId of open Move To popup
  const [bulkMoveOpen, setBulkMoveOpen] = React.useState(false);
  const [emailSchoolFilter, setEmailSchoolFilter] = React.useState(new Set()); // school:id
  const [emailSearch, setEmailSearch] = React.useState(() => { try { return localStorage.getItem("mt-email-search") || ""; } catch { return ""; } });
  const setEmailSearchPersist = (v) => { setEmailSearch(v); try { localStorage.setItem("mt-email-search", v); } catch {} };
  const [emailSuggestOpen, setEmailSuggestOpen] = React.useState(false);
  const [gmailSearchResults, setGmailSearchResults] = React.useState(null); // null = inactive, [] or [...] = active
  const [gmailSearchLoading, setGmailSearchLoading] = React.useState(false);
  const gmailSearchTimerRef = React.useRef(null);
  const [emailReadIds, setEmailReadIds] = React.useState(() => { try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxReadIds) || "[]")); } catch { return new Set(); } });
  const [emailSwipeState, setEmailSwipeState] = React.useState({}); // emailId -> deltaX (for swipe animation)
  const emailSwipeRef = React.useRef({}); // tracks ongoing swipe per email { [id]: dx, [lock_id]: dir, [t_id]: timer }
  const [emailSummaries, setEmailSummaries] = React.useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.emailSummaryCache) || "{}"); } catch { return {}; } });
  const emailSummariesRef = React.useRef(emailSummaries); // always-current mirror so generateSummaries doesn't need emailSummaries as a dep
  const [summariesLoading, setSummariesLoading] = React.useState(false);
  const [emailPinned, setEmailPinned] = React.useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.emailPinned) || "[]"); } catch { return []; } });
  const [emailManuallyUnpinned, setEmailManuallyUnpinned] = React.useState(() => { try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.emailManuallyUnpinned) || "[]")); } catch { return new Set(); } });
  const [emailSelectedIds, setEmailSelectedIds] = React.useState(new Set());
  const emailLastSelectedRef = React.useRef(null); // anchor for shift+click range
  const [suppressPatterns, setSuppressPatterns] = React.useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.emailSuppress) || "[]"); } catch { return []; } });
  const [triageLoading, setTriageLoading] = React.useState({}); // emailId -> bool
  const [triageDraft, setTriageDraft] = React.useState({}); // emailId -> string
  const [emailDragging, setEmailDragging] = React.useState(null);
  const [attachmentDragging, setAttachmentDragging] = React.useState(null); // { att, messageId }
  const [attachmentPreview, setAttachmentPreview] = React.useState(null); // { att, messageId, loading, base64, blobUrl, error }
  const [previewPos,  setPreviewPos]  = React.useState({ x: 0, y: 0 });
  const [previewSize, setPreviewSize] = React.useState({ w: 820, h: 600 });
  const previewPosRef  = React.useRef({ x: 0, y: 0 });
  const previewSizeRef = React.useRef({ w: 820, h: 600 });
  React.useEffect(() => { previewPosRef.current  = previewPos;  }, [previewPos]);
  React.useEffect(() => { previewSizeRef.current = previewSize; }, [previewSize]);

  // ── Save attachment to Documents/Resources ───────────────────
  const SAVE_ATT_DOC_TYPES  = ["Insurance", "WWCC", "License Agreement", "Policy", "Other"];
  const SAVE_ATT_RES_CATS   = ["Book", "Equipment", "Website", "Sheet Music", "Video", "Other"];
  const [attCtxMenu,       setAttCtxMenu]       = React.useState(null); // { att, messageId, x, y }
  const [saveAttachModal,  setSaveAttachModal]  = React.useState(null); // { att, messageId }
  const [saveAttachSection,setSaveAttachSection]= React.useState("documents");
  const [saveAttachForm,   setSaveAttachForm]   = React.useState({});
  const attCtxRef = React.useRef(null);
  React.useEffect(() => {
    if (!attCtxMenu) return;
    const close = (e) => { if (attCtxRef.current && attCtxRef.current.contains(e.target)) return; setAttCtxMenu(null); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [attCtxMenu]);
  const openSaveAttachModal = (att, messageId) => {
    setAttCtxMenu(null);
    setSaveAttachSection("documents");
    setSaveAttachForm({ label: att.filename || "", type: "Other", teacherId: "", schoolId: "", expiryDate: "", notes: "", category: "Other", description: "" });
    setSaveAttachModal({ att, messageId });
  };
  const confirmSaveAttach = () => {
    if (!saveAttachModal || !setDocuments || !setResources) return;
    const { att, messageId } = saveAttachModal;
    const gmailRef = { messageId, attachmentId: att.attachmentId, filename: att.filename, mimeType: att.mimeType || "" };
    const id = uid();
    if (saveAttachSection === "documents") {
      const doc = { id, label: saveAttachForm.label || att.filename, type: saveAttachForm.type, teacherId: saveAttachForm.teacherId, schoolId: saveAttachForm.schoolId, expiryDate: saveAttachForm.expiryDate, url: "", notes: saveAttachForm.notes, gmailRef };
      setDocuments(prev => [doc, ...prev]);
      notify("Saved to Documents");
    } else {
      // Resources are a shared pool persisted per-row (no whole-list sync),
      // so insert this row directly. A fresh uuid keeps the id format aligned
      // with the shared table. gmailRef stays in local state only (not a
      // resources column); source/added_by_name are carried for the library.
      const res = { id: crypto.randomUUID(), label: saveAttachForm.label || att.filename, url: "", category: saveAttachForm.category, description: saveAttachForm.description, source: "direct", added_by_name: "Admin", gmailRef };
      setResources(prev => [res, ...prev]);
      insertResourceRow(res).catch(() => notify("Saved locally, but couldn't sync to the server", "danger"));
      notify("Saved to Resources");
    }
    setSaveAttachModal(null);
  };

  const closeAttachmentPreview = React.useCallback(() => {
    setAttachmentPreview(prev => {
      if (prev?.blobUrl) URL.revokeObjectURL(prev.blobUrl);
      return null;
    });
  }, []);

  // Centre the window on screen when opening
  const initPreviewLayout = React.useCallback(() => {
    const w = Math.min(820, Math.round(window.innerWidth * 0.82));
    const h = Math.min(680, Math.round(window.innerHeight * 0.85));
    setPreviewSize({ w, h });
    setPreviewPos({ x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2) });
  }, []);

  // Drag the modal by its header
  const handlePreviewDragStart = React.useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const { x: ox, y: oy } = previewPosRef.current;
    const onMove = (ev) => setPreviewPos({ x: ox + ev.clientX - startX, y: oy + ev.clientY - startY });
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // Resize from any edge or corner — n/s/e/w flags indicate which edges move
  const startResize = React.useCallback((e, n, s, east, w) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const { x: ox, y: oy } = previewPosRef.current;
    const { w: ow, h: oh } = previewSizeRef.current;
    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      let nx = ox, ny = oy, nw = ow, nh = oh;
      if (east) nw = Math.max(420, ow + dx);
      if (w)    { nw = Math.max(420, ow - dx); nx = ox + ow - nw; }
      if (s)    nh = Math.max(300, oh + dy);
      if (n)    { nh = Math.max(300, oh - dy); ny = oy + oh - nh; }
      setPreviewPos({ x: nx, y: ny });
      setPreviewSize({ w: nw, h: nh });
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  const handlePreviewAttachment = React.useCallback(async (att, messageId) => {
    initPreviewLayout();
    const type = getAttachmentType(att.filename);
    // For unsupported types, open modal immediately without fetching
    if (type === "other") {
      setAttachmentPreview({ att, messageId, loading: false, base64: null, blobUrl: null, error: null });
      return;
    }
    setAttachmentPreview({ att, messageId, loading: true, base64: null, blobUrl: null, error: null });
    try {
      if (!window.electronAPI?.gmailFetchAttachment) throw new Error("Preview is only available in the desktop app.");
      const result = await window.electronAPI.gmailFetchAttachment(messageId, att.attachmentId);
      if (!result.ok) throw new Error(result.error || "Failed to fetch attachment.");
      const base64 = result.base64;
      let blobUrl = null;
      if (type === "pdf") {
        const bytes = atob(base64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        const blob = new Blob([arr], { type: "application/pdf" });
        blobUrl = URL.createObjectURL(blob);
      }
      setAttachmentPreview(prev => prev ? { ...prev, loading: false, base64, blobUrl } : prev);
    } catch (e) {
      setAttachmentPreview(prev => prev ? { ...prev, loading: false, error: e.message } : prev);
    }
  }, [initPreviewLayout]);
  const [alertDragging, setAlertDragging] = React.useState(null); // { text, tag } being dragged from alert chip
  // Teacher notes alert tracking — stores { id, seenAt } for notes already seen
  const [seenTeacherNoteIds, setSeenTeacherNoteIds] = React.useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("mt-seen-teacher-note-ids") || "[]")); } catch { return new Set(); }
  });
  const dismissTeacherNoteAlert = (noteId) => {
    setSeenTeacherNoteIds(prev => {
      const next = new Set([...prev, noteId]);
      localStorage.setItem("mt-seen-teacher-note-ids", JSON.stringify([...next]));
      return next;
    });
  };
  const dismissAllTeacherNoteAlerts = (noteIds) => {
    setSeenTeacherNoteIds(prev => {
      const next = new Set([...prev, ...noteIds]);
      localStorage.setItem("mt-seen-teacher-note-ids", JSON.stringify([...next]));
      return next;
    });
  };
  // Staff document alert tracking — stores seen uploaded doc IDs
  const [seenStaffDocIds, setSeenStaffDocIds] = React.useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("mt-seen-staff-doc-ids") || "[]")); } catch { return new Set(); }
  });
  const dismissStaffDocAlert = (docId) => {
    setSeenStaffDocIds(prev => {
      const next = new Set([...prev, docId]);
      localStorage.setItem("mt-seen-staff-doc-ids", JSON.stringify([...next]));
      return next;
    });
  };
  const dismissAllStaffDocAlerts = (docIds) => {
    setSeenStaffDocIds(prev => {
      const next = new Set([...prev, ...docIds]);
      localStorage.setItem("mt-seen-staff-doc-ids", JSON.stringify([...next]));
      return next;
    });
  };
  // Load recent staff-uploaded documents from Supabase
  const [staffUploadedDocs, setStaffUploadedDocs] = React.useState([]);
  React.useEffect(() => {
    async function loadStaffDocs() {
      try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30); // show uploads from last 30 days
        const { data } = await supabase
          .from("documents")
          .select("id, label, type, file_name, teacher_id, uploaded_at")
          .not("teacher_id", "is", null)
          .gte("uploaded_at", cutoff.toISOString())
          .order("uploaded_at", { ascending: false });
        setStaffUploadedDocs(data || []);
      } catch (err) {
        console.error("Dashboard: failed to load staff docs", err);
      }
    }
    loadStaffDocs();
  }, []);

  // ── Invoice alert tracking ─────────────────────────────────
  const [submittedInvoices, setSubmittedInvoices] = React.useState([]);
  const [seenInvoiceIds, setSeenInvoiceIds] = React.useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("mt-seen-invoice-ids") || "[]")); } catch { return new Set(); }
  });
  const dismissInvoiceAlert = (id) => {
    setSeenInvoiceIds(prev => {
      const next = new Set([...prev, id]);
      localStorage.setItem("mt-seen-invoice-ids", JSON.stringify([...next]));
      return next;
    });
  };
  const dismissAllInvoiceAlerts = (ids) => {
    setSeenInvoiceIds(prev => {
      const next = new Set([...prev, ...ids]);
      localStorage.setItem("mt-seen-invoice-ids", JSON.stringify([...next]));
      return next;
    });
  };
  React.useEffect(() => {
    async function loadInvoices() {
      try {
        const { data } = await supabase
          .from("teacher_invoices")
          .select("id, teacher_id, period_start, period_end, total_hours, total_amount, submitted_at")
          .eq("status", "sent")
          .order("submitted_at", { ascending: false })
          .limit(50);
        setSubmittedInvoices(data || []);
      } catch (e) { console.warn("Dashboard: failed to load invoices", e); }
    }
    loadInvoices();
    const interval = setInterval(loadInvoices, 30000);
    return () => clearInterval(interval);
  }, []);

  // ── Classroom teacher email alert tracking ─────────────────
  // Cache of { emailId: { type, summary } } — persisted to localStorage
  const [teacherEmailAlerts, setTeacherEmailAlerts] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem("mt-teacher-email-alerts") || "{}"); } catch { return {}; }
  });
  const [seenTeacherEmailAlertIds, setSeenTeacherEmailAlertIds] = React.useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("mt-seen-teacher-email-alert-ids") || "[]")); } catch { return new Set(); }
  });
  const dismissTeacherEmailAlert = (emailId) => {
    setSeenTeacherEmailAlertIds(prev => {
      const next = new Set([...prev, emailId]);
      localStorage.setItem("mt-seen-teacher-email-alert-ids", JSON.stringify([...next]));
      return next;
    });
  };
  const dismissAllTeacherEmailAlerts = (emailIds) => {
    setSeenTeacherEmailAlertIds(prev => {
      const next = new Set([...prev, ...emailIds]);
      localStorage.setItem("mt-seen-teacher-email-alert-ids", JSON.stringify([...next]));
      return next;
    });
  };
  // Build list of classroom/specialist teacher contacts with their emails
  const teacherContacts = React.useMemo(() =>
    contacts.filter(c => c.role === "Classroom Teacher" || c.role === "Specialist Teacher").filter(c => c.email),
  [contacts]);
  // Analyse any unprocessed emails from classroom/specialist teachers via Claude API
  React.useEffect(() => {
    if (!inboxEmails.length || !teacherContacts.length) return;
    const teacherEmailSet = new Set(teacherContacts.map(c => c.email.toLowerCase()));
    const unprocessed = inboxEmails.filter(em => {
      const fromAddr = (em.from?.match(/<(.+)>/)?.[1] || em.from || "").toLowerCase();
      return teacherEmailSet.has(fromAddr) && !teacherEmailAlerts[em.id];
    });
    if (!unprocessed.length) return;
    // Process one at a time to avoid hammering the API
    (async () => {
      const updated = { ...teacherEmailAlerts };
      for (const em of unprocessed.slice(0, 5)) { // max 5 per render cycle
        const contact = teacherContacts.find(c => {
          const fromAddr = (em.from?.match(/<(.+)>/)?.[1] || em.from || "").toLowerCase();
          return c.email.toLowerCase() === fromAddr;
        });
        if (!contact) continue;
        // Build student list for this teacher's class
        const classStudents = students.filter(s => s.schoolId === contact.schoolId && s.className === contact.className && s.status === "active").map(s => s.name);
        const emailText = `Subject: ${em.subject || ""}\n${em.snippet || em.body || ""}`.slice(0, 600);
        try {
          const res = await anthropicFetch("/v1/messages", {
            method: "POST",
            headers: getAnthropicHeaders(),
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 120,
              system: `You classify emails from classroom teachers to a music tutor. 
Known students in this teacher's class: ${classStudents.join(", ") || "unknown"}.
Reply ONLY with valid JSON: {"type":"absence"|"class_change"|"other","summary":"short label max 6 words"}
For absences use format: "Name away today" or "Name went home sick".
For class changes: "Subject moved to HH:MM" or "Class cancelled today".
For other: {"type":"other","summary":""}`,
              messages: [{ role: "user", content: emailText }],
            }),
          });
          const txt = res?.content?.[0]?.text || "";
          const clean = txt.replace(/```json|```/g, "").trim();
          const parsed = JSON.parse(clean);
          if (parsed.type && parsed.type !== "other" && parsed.summary) {
            updated[em.id] = { type: parsed.type, summary: parsed.summary, emailId: em.id };
          } else {
            updated[em.id] = { type: "other", summary: "", emailId: em.id };
          }
        } catch (e) {
          updated[em.id] = { type: "other", summary: "", emailId: em.id };
        }
      }
      setTeacherEmailAlerts(updated);
      try { localStorage.setItem("mt-teacher-email-alerts", JSON.stringify(updated)); } catch {}
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxEmails, teacherContacts]);

  const [alertDropdown, setAlertDropdown] = React.useState(null); // { rect, title, borderColor, items: [{label, dragPayload, chipColor}] }
  // Wrapper: converts chip's viewport rect to absolute coords in scroll container at hover time,
  // so the dropdown stays locked to the chip as the page scrolls.
  const openAlertDropdown = React.useCallback((data) => {
    if (!data?.rect) { setAlertDropdown(data); return; }
    const sc = document.querySelector("[data-printarea]");
    if (!sc) { setAlertDropdown(data); return; }
    const cRect = sc.getBoundingClientRect();
    // Viewport clamp constants shared by both anchor branches so a pill
    // near either edge keeps the dropdown fully on-screen. The else
    // branch previously had no clamp — a collapsed alerts row shifted
    // pills left and dropped the dropdown off the left edge.
    const DROPDOWN_WIDTH = 400;
    const VIEWPORT_MARGIN = 12;
    const minLeft = cRect.left + VIEWPORT_MARGIN;     // 12px inside the content area, not the window
    const maxLeft = window.innerWidth - DROPDOWN_WIDTH - VIEWPORT_MARGIN;
    let absLeft;
    if (data.anchor === "right") {
      // Right-anchored opener: align dropdown's right edge to chip's right edge,
      // clamped so it never spills off the viewport. Only the lesson-change pill
      // uses this; other pills keep the default left-flush behaviour below.
      const desiredLeft = data.rect.right - DROPDOWN_WIDTH;
      const finalLeft = Math.max(minLeft, Math.min(desiredLeft, maxLeft));
      absLeft = finalLeft - cRect.left;
    } else {
      // Left-flush opener: align to the pill's left edge, same viewport clamp.
      const desiredLeft = data.rect.left;
      const finalLeft = Math.max(minLeft, Math.min(desiredLeft, maxLeft));
      absLeft = finalLeft - cRect.left;
    }
    setAlertDropdown({
      ...data,
      absLeft,
      absBottom: data.rect.bottom - cRect.top + sc.scrollTop,
    });
  }, []);
  const alertDropdownTimer = React.useRef(null); // delay timer for hover close
  const [missedContactMenu, setMissedContactMenu] = React.useState(null); // { x, y, item } for Contact all submenu
  const [catchupContactMenu, setCatchupContactMenu] = React.useState(null); // { x, y, item } for catch-up Contact all submenu
  const [emailGroupContactMenu, setEmailGroupContactMenu] = React.useState(null); // { x, y, item } for group email contact menu

  // Close contact submenus on outside click
  React.useEffect(() => {
    if (!missedContactMenu && !catchupContactMenu && !emailGroupContactMenu) return;
    const handler = () => { setMissedContactMenu(null); setCatchupContactMenu(null); setEmailGroupContactMenu(null); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [missedContactMenu, catchupContactMenu]);
  const saveInboxCache = (emails) => { try { localStorage.setItem(STORAGE_KEYS.inboxCache, JSON.stringify({ emails, ts: Date.now() })); } catch {} };

  // Parse a "Retry after <ISO timestamp>" string from a Gmail 429 error and store
  // the blocked-until time so all subsequent calls skip the API until it clears.
  // A 5-minute cooldown buffer is added on top of Gmail's specified window — this
  // prevents the background poll from firing the instant the window technically
  // expires and immediately triggering another 429 before Gmail is fully ready.
  const GMAIL_RATE_LIMIT_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
  const applyGmailRateLimit = React.useCallback((errorStr) => {
    const match = (errorStr || "").match(/Retry after ([^\s]+)/i);
    if (match) {
      const gmailUntil = new Date(match[1]).getTime();
      if (!isNaN(gmailUntil) && gmailUntil > Date.now()) {
        const until = gmailUntil + GMAIL_RATE_LIMIT_BUFFER_MS;
        setGmailRateLimitUntil(until);
        gmailRateLimitUntilRef.current = until;
        try { localStorage.setItem("mt-gmail-rate-limit-until", String(until)); } catch {}
      }
    }
  }, []);
  const [emailArchivedIds, setEmailArchivedIds] = React.useState(() => { try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxArchivedIds) || "[]")); } catch { return new Set(); } });
  const markArchived = React.useCallback((emailId) => {
    setEmailArchivedIds(prev => { const next = new Set(prev); next.add(emailId); try { localStorage.setItem(STORAGE_KEYS.inboxArchivedIds, JSON.stringify([...next])); } catch {} return next; });
    setEmailReadIds(prev => { const next = new Set(prev); next.add(emailId); try { localStorage.setItem(STORAGE_KEYS.inboxReadIds, JSON.stringify([...next])); } catch {} return next; });
  }, []);
  const markRead = (emailId) => { const next = new Set(emailReadIds); next.add(emailId); setEmailReadIds(next); try { localStorage.setItem(STORAGE_KEYS.inboxReadIds, JSON.stringify([...next])); } catch {} };

  // To Do state — todoItemsRef MUST be declared before todoItems useState so the lazy
  // initializer can set todoItemsRef.current = v without a ReferenceError (which would
  // be swallowed by try/catch and return [] every mount, losing all saved items).
  const todoItemsRef = React.useRef([]); // always-current mirror of todoItems for drop handlers
  const todoUndoStack = React.useRef([]); // stack of previous todoItems states for Ctrl+Z
  const [todoItems, setTodoItems] = React.useState(() => { try { const v = JSON.parse(localStorage.getItem(STORAGE_KEYS.todoItems) || "[]"); todoItemsRef.current = v; return v; } catch { return []; } });

  // Sync todo list if Claude panel adds an item externally
  React.useEffect(() => {
    const handler = () => {
      try {
        const v = JSON.parse(localStorage.getItem(STORAGE_KEYS.todoItems) || "[]");
        setTodoItems(v);
        todoItemsRef.current = v;
      } catch {}
    };
    window.addEventListener("mt-todos-updated", handler);
    return () => window.removeEventListener("mt-todos-updated", handler);
  }, []);
  const [todoInput, setTodoInput] = React.useState("");
  const [todoCategories, setTodoCategories] = React.useState(() => { try { return JSON.parse(localStorage.getItem("mt-todo-categories") || "[]"); } catch { return []; } });
  const [todoFilterCategory, setTodoFilterCategory] = React.useState(new Set());
  const saveTodoCategories = (cats) => { setTodoCategories(cats); try { localStorage.setItem("mt-todo-categories", JSON.stringify(cats)); } catch {} };
  React.useEffect(() => { const h = () => { try { setTodoCategories(JSON.parse(localStorage.getItem("mt-todo-categories") || "[]")); } catch {} }; window.addEventListener("mt-todo-categories-updated", h); return () => window.removeEventListener("mt-todo-categories-updated", h); }, []);
  const [todoDragIdx, setTodoDragIdx] = React.useState(null);
  const todoDragIdxRef = React.useRef(null);
  const todoDragItemIdRef = React.useRef(null); // id of item being dragged — stable across preview shuffles
  const [todoDragHoverItemId, setTodoDragHoverItemId] = React.useState(null);
  const todoDragHoverIdxRef = React.useRef(null); // hover idx in activeTodo, always-current mirror
  const [todoDropZoneIdx, setTodoDropZoneIdx] = React.useState(null); // kept for email/alert drop visual
  const [todoSelectedIds, setTodoSelectedIds] = React.useState(new Set()); // shift+click multi-select
  const [todoContextMenu, setTodoContextMenu] = React.useState(null); // { x, y, itemId }
  const todoSubDragRef = React.useRef(null); // { parentId, subId, subItem } when dragging a sub-item out
  const [todoEditId, setTodoEditId] = React.useState(null); // id of item being inline-edited
  const [todoSubEditId, setTodoSubEditId] = React.useState(null); // { itemId, subId } for sub-item edit
  const [todoSubEditValue, setTodoSubEditValue] = React.useState("");
  const [todoEditValue, setTodoEditValue] = React.useState(""); // controlled value for inline edit
  const [todoSubInput, setTodoSubInput] = React.useState(""); // sub-item add field
  const [todoMentionQuery, setTodoMentionQuery] = React.useState(null); // { query, anchorPos, field, top, left, width }
  const [todoMentionIndex, setTodoMentionIndex] = React.useState(0);
  const [todoEditMentions, setTodoEditMentions] = React.useState([]); // { name, email } for current inline edit
  const [todoAddMentions, setTodoAddMentions] = React.useState([]);   // { name, email } for main add field

  // ── Quick-add modals (Cmd+Shift+T / Cmd+Shift+R from any page) ──────────
  const [quickTodoOpen, setQuickTodoOpen] = React.useState(false);
  const [quickTodoInput, setQuickTodoInput] = React.useState("");
  const [quickTodoCategory, setQuickTodoCategory] = React.useState(null); // category id or null
  const quickTodoInputRef = React.useRef(null);
  const [quickReminderOpen, setQuickReminderOpen] = React.useState(false);
  const [quickReminderInput, setQuickReminderInput] = React.useState("");
  const quickReminderInputRef = React.useRef(null);

  React.useEffect(() => {
    if (!quickAddTodoTrigger) return;
    setQuickTodoOpen(prev => {
      if (prev) return false; // already open → toggle closed
      setQuickTodoInput("");
      setQuickTodoCategory(null);
      setTimeout(() => quickTodoInputRef.current?.focus(), 50);
      return true;
    });
  }, [quickAddTodoTrigger]);

  React.useEffect(() => {
    if (!quickAddReminderTrigger) return;
    setQuickReminderOpen(prev => {
      if (prev) return false; // already open → toggle closed
      setQuickReminderInput("");
      setTimeout(() => quickReminderInputRef.current?.focus(), 50);
      return true;
    });
  }, [quickAddReminderTrigger]);
  const [todoSubMentions, setTodoSubMentions] = React.useState([]);   // { name, email } for sub-item add field
  const [todoNotesValue, setTodoNotesValue] = React.useState("");     // controlled notes textarea value
  const [todoNotesItemId, setTodoNotesItemId] = React.useState(null); // which item's notes are focused
  const [todoNotesMentions, setTodoNotesMentions] = React.useState([]); // { name, email } for notes field
  const todoNotesRef = React.useRef(null);
  const todoInputRef = React.useRef(null);
  const todoEditInputRef = React.useRef(null);
  const todoSubInputRef = React.useRef(null);
  const [todoDropTarget, setTodoDropTarget] = React.useState(false); // email being dragged over todo panel
  const [todoExpanded, setTodoExpanded] = React.useState(new Set()); // Set of item IDs that are expanded

  const saveTodo = (items) => {
    todoUndoStack.current.push(todoItemsRef.current.slice()); // snapshot before change
    if (todoUndoStack.current.length > 30) todoUndoStack.current.shift(); // cap at 30
    // Stamp any newly-added item with today's Melbourne date so the overdue clock
    // starts from when it enters the list, not when the email/alert was created.
    // Removed-and-readded items get a fresh stamp because their ID is gone from prevIds.
    const prevIds = new Set(todoItemsRef.current.map(t => t.id));
    const today = melbourneToday();
    const stamped = items.map(t => prevIds.has(t.id) ? t : { ...t, todoDate: today, ...(todoFilterCategory.size === 1 && !t.category ? { category: [...todoFilterCategory][0] } : {}) });
    setTodoItems(stamped); todoItemsRef.current = stamped;
    try { localStorage.setItem(STORAGE_KEYS.todoItems, JSON.stringify(stamped)); } catch {}
  };

  // Shared alert drop handler — deduplicates by groupType, callable from any drop zone
  const handleAlertDrop = React.useCallback((alert, currentItems) => {
    if (!alert) return currentItems;
    // Individual missed lesson drop — standalone, but remove from any existing group item
    if (alert.missedLesson) {
      const ml = alert.missedLesson;
      const firstName = (ml.studentName || "").split(" ")[0];
      const lessonWord = ml.count === 1 ? "missed lesson" : `${ml.count} missed lessons`;
      const parentLabel = ml.parentName ? ml.parentName.split(" ")[0] : "parent";
      const newItem = { id: uid(), text: `Contact ${parentLabel} re: ${firstName}'s ${lessonWord}`, done: false, tag: "lesson", groupType: alert.groupType, missedLesson: ml, createdAt: new Date().toISOString() };
      // Remove this student from any existing group item's sub-items
      const updated = currentItems.map(t => {
        if (t.done || t.groupType !== "alert-missed-week" || !Array.isArray(t.subItems)) return t;
        let modified = false;
        const newSubs = t.subItems.map(sub => {
          if (Array.isArray(sub.students)) {
            const remaining = sub.students.filter(s => s.studentId !== ml.studentId);
            if (remaining.length === sub.students.length) return sub; // student not in this sub-item
            modified = true;
            if (remaining.length === 0) return null; // whole sub-item removed
            const parentLabel = (sub.parentName || "parent").split(" ")[0];
            return { ...sub, students: remaining, text: `Contact ${parentLabel} re: ${formatSiblingMissedText(remaining)}` };
          }
          // Legacy sub-item with top-level studentId
          if (sub.studentId === ml.studentId) { modified = true; return null; }
          return sub;
        }).filter(Boolean);
        if (!modified) return t;
        return { ...t, subItems: newSubs };
      });
      // Don't add if already standalone in list
      if (updated.find(t => !t.done && t.groupType === alert.groupType)) return updated;
      return [newItem, ...updated];
    }
    // Group missed lesson drop — add group, absorbing any existing standalone individual items
    if (alert.missedLessons) {
      if (currentItems.find(t => !t.done && t.groupType === "alert-missed-week")) return currentItems; // already in list
      const studentIds = new Set(alert.missedLessons.map(ml => ml.studentId));
      // Remove any standalone individual items for students in this group
      const filtered = currentItems.filter(t => {
        if (t.done || !t.missedLesson) return true;
        return !studentIds.has(t.missedLesson.studentId);
      });
      // Group by parent — siblings share one sub-item
      const byParent = {};
      for (const ml of alert.missedLessons) {
        const key = ml.parentEmail || ml.studentId;
        if (!byParent[key]) byParent[key] = { parentEmail: ml.parentEmail, parentName: ml.parentName, students: [] };
        byParent[key].students.push({ studentName: ml.studentName, studentId: ml.studentId, count: ml.count });
      }
      const subItems = Object.values(byParent).map(p => {
        const parentLabel = (p.parentName || "parent").split(" ")[0];
        const parts = p.students.map(s => `${(s.studentName || "").split(" ")[0]}'s ${s.count === 1 ? "missed lesson" : `${s.count} missed lessons`}`);
        const text = `Contact ${parentLabel} re: ${formatSiblingMissedText(p.students)}`;
        return { id: uid(), text, done: false, parentEmail: p.parentEmail, parentName: p.parentName, students: p.students };
      });
      return [{ id: uid(), text: "Contact all re: missed lessons", done: false, tag: "lesson", groupType: "alert-missed-week", missedLessons: alert.missedLessons, subItems, createdAt: new Date().toISOString() }, ...filtered];
    }
    // Admin items (unassigned/unscheduled/incomplete) — plain text sub-items, no compose
    if (alert.adminItems) {
      if (currentItems.find(t => !t.done && t.groupType === alert.groupType)) return currentItems;
      const subItems = alert.adminItems.map(a => ({ id: uid(), text: a.text, done: false }));
      return [{ id: uid(), text: alert.text, done: false, tag: alert.tag, groupType: alert.groupType, subItems, createdAt: new Date().toISOString() }, ...currentItems];
    }
    // Response required emails — sub-item per email with reply link
    if (alert.responseEmails) {
      if (currentItems.find(t => !t.done && t.groupType === alert.groupType)) return currentItems;
      const subItems = alert.responseEmails.map(e => {
        const senderName = e.from?.includes("<") ? e.from.split("<")[0].trim().replace(/^"|"$/g, "") : e.from || "Unknown";
        const senderEmail = e.from?.includes("<") ? e.from.match(/<(.+)>/)?.[1] || "" : e.from || "";
        return { id: uid(), text: `Reply to ${senderName} re: ${e.subject || "(no subject)"}`, done: false, replyEmailId: e.id, replyTo: senderEmail, senderName };
      });
      return [{ id: uid(), text: alert.text, done: false, tag: alert.tag, groupType: alert.groupType, responseEmails: alert.responseEmails, subItems, createdAt: new Date().toISOString() }, ...currentItems];
    }
    // Individual catch-up drop — standalone, remove from any existing group's sub-items
    if (alert.catchupLesson) {
      const s = alert.catchupLesson;
      const isGroupLesson = (s.instrument || "").toLowerCase().includes("group");
      let itemText, itemData;
      if (isGroupLesson) {
        // Look up all parents from each student name in the group
        const studentNames = (s.studentName || "").split(/,\s*/).map(n => n.trim()).filter(Boolean);
        const parentContacts = studentNames.map(sName => {
          const st = students.find(st => st.name === sName || st.name.split(" ")[0] === sName.split(" ")[0]);
          return st ? { parentName: st.parents?.[0]?.name || "", parentEmail: st.parents?.[0]?.email || "", studentName: st.name } : null;
        }).filter(Boolean);
        const parentFirstNames = parentContacts.map(p => preferredFirstName(p.parentName) || "parent");
        const parentStr = parentFirstNames.length > 1
          ? parentFirstNames.slice(0, -1).join(", ") + " & " + parentFirstNames.slice(-1)
          : (parentFirstNames[0] || preferredFirstName(s.parentName) || "parents");
        itemText = `Contact ${parentStr} re: group catch-ups`;
        const subItems = parentContacts.map(p => ({
          id: uid(), text: `Contact ${preferredFirstName(p.parentName) || "parent"} re: ${p.studentName.split(" ")[0]}'s catch-up`,
          done: false, parentEmail: p.parentEmail, parentName: p.parentName,
          students: [{ studentName: p.studentName, studentId: s.studentId, count: s.count }],
          textSuffix: `${p.studentName.split(" ")[0]}'s catch-up`, tag: "lesson", createdAt: new Date().toISOString()
        }));
        itemData = { catchupLesson: { ...s, isGroup: true, groupParentNames: parentFirstNames }, subItems };
      } else {
        const firstName = preferredFirstName(s.studentName) || (s.studentName || "").split(" ")[0];
        const parentLabel = preferredFirstName(s.parentName) || "parent";
        itemText = `Contact ${parentLabel} re: ${firstName}'s catch-up${s.count !== 1 ? "s" : ""}`;
        itemData = { catchupLesson: s };
      }
      // Remove from any existing catch-up group sub-items
      let modified = false;
      const updated = currentItems.map(t => {
        if (t.done || t.groupType !== "alert-catchup" || !Array.isArray(t.subItems)) return t;
        const newSubs = t.subItems.map(sub => {
          if (!Array.isArray(sub.students)) return sub.studentId === s.studentId ? (modified = true, null) : sub;
          const remaining = sub.students.filter(st => st.studentId !== s.studentId);
          if (remaining.length === sub.students.length) return sub;
          modified = true;
          if (remaining.length === 0) return null;
          const pLabel = preferredFirstName(sub.parentName) || "parent";
          return { ...sub, students: remaining, textSuffix: `${remaining.map(st => preferredFirstName(st.studentName)).join(" and ")}'s catch-ups` };
        }).filter(Boolean);
        if (!modified) return t;
        return { ...t, subItems: newSubs };
      });
      if (updated.find(t => !t.done && t.groupType === alert.groupType)) return updated;
      const { subItems: groupSubItems, ...itemDataWithoutSubs } = itemData;
      const newItem = { id: uid(), text: itemText, done: false, tag: "lesson", groupType: alert.groupType, ...itemDataWithoutSubs, ...(groupSubItems ? { subItems: groupSubItems } : {}), createdAt: new Date().toISOString() };
      return [newItem, ...updated];
    }
    // Catch-up group drop — absorbs existing standalone catchupLesson items
    if (alert.catchupStudents) {
      if (currentItems.find(t => !t.done && t.groupType === "alert-catchup")) return currentItems;
      const studentIds = new Set(alert.catchupStudents.map(s => s.studentId));
      const filtered = currentItems.filter(t => !(t.catchupLesson && !t.done && studentIds.has(t.catchupLesson.studentId)));
      const byParent = {};
      for (const s of alert.catchupStudents) {
        const key = s.parentEmail || s.studentId;
        if (!byParent[key]) byParent[key] = { parentEmail: s.parentEmail, parentName: s.parentName, students: [] };
        byParent[key].students.push({ studentName: s.studentName, studentId: s.studentId, count: s.count });
      }
      const uniqueParents = Object.values(byParent);
      const subItems = uniqueParents.map(p => {
        const pLabel = preferredFirstName(p.parentName) || "parent";
        const names = p.students.map(s => preferredFirstName(s.studentName) || (s.studentName || "").split(" ")[0]);
        const nameStr = names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names.slice(-1) : names[0];
        const totalCatchups = p.students.reduce((sum, s) => sum + s.count, 0);
        return { id: uid(), text: `Contact ${pLabel} re: ${nameStr}'s catch-up${totalCatchups !== 1 ? "s" : ""}`, done: false, parentEmail: p.parentEmail, parentName: p.parentName, students: p.students, textSuffix: `${nameStr}'s catch-up${totalCatchups !== 1 ? "s" : ""}` };
      });
      // Build group item text: "Contact [Parent1] and [Parent2] re: group catch-ups"
      const parentNames = uniqueParents.map(p => preferredFirstName(p.parentName) || "parent");
      const parentStr = parentNames.length > 2
        ? parentNames.slice(0, 2).join(", ") + ` and ${parentNames.length - 2} more`
        : parentNames.length === 2 ? `${parentNames[0]} and ${parentNames[1]}` : parentNames[0] || "parents";
      return [{ id: uid(), text: `Contact ${parentStr} re: group catch-ups`, done: false, tag: "lesson", groupType: "alert-catchup", catchupStudents: alert.catchupStudents, subItems, createdAt: new Date().toISOString() }, ...filtered];
    }
    // Default: plain text alert
    const existing = alert.groupType ? currentItems.find(t => !t.done && t.groupType === alert.groupType) : null;
    if (existing) return currentItems.map(t => t.id === existing.id ? { ...t, text: alert.text } : t);
    // Interruption with affected students — sub-items per parent per interruption
    if (alert.interruptionStudents) {
      if (currentItems.find(t => !t.done && t.groupType === alert.groupType)) return currentItems;
      const subItems = alert.interruptionStudents.flatMap(({ intr, students }) => {
        const byParent = {};
        for (const s of students) {
          const key = s.parentEmail || s.studentId;
          if (!byParent[key]) byParent[key] = { parentEmail: s.parentEmail, parentName: s.parentName, studentNames: [] };
          byParent[key].studentNames.push(s.studentName);
        }
        return Object.values(byParent).map(p => {
          const parentLabel = (p.parentName || "parent").split(" ")[0];
          const names = p.studentNames.map(n => n.split(" ")[0]);
          const nameStr = names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names.slice(-1) : names[0];
          return { id: uid(), text: `Contact ${parentLabel} re: ${nameStr}'s lesson — ${intr.title}`, done: false, parentEmail: p.parentEmail, parentName: p.parentName, studentNames: p.studentNames, intrTitle: intr.title };
        });
      });
      return [{ id: uid(), text: alert.text, done: false, tag: alert.tag, groupType: alert.groupType, interruptionStudents: alert.interruptionStudents, subItems, createdAt: new Date().toISOString() }, ...currentItems];
    }
    // Pending/trial students — sub-items per student with parent contact
    // Individual pending/trial drop — standalone, remove from any existing group sub-items
    if (alert.pendingOrTrialLesson) {
      const s = alert.pendingOrTrialLesson;
      const label = alert.groupType?.includes("pending") ? "pending enrolment" : "trial";
      const parentLabel = preferredFirstName(s.parentName) || "parent";
      const firstName = preferredFirstName(s.studentName) || (s.studentName || "").split(" ")[0];
      const newItem = { id: uid(), text: `Contact ${parentLabel} re: ${firstName}'s ${label}`, done: false, tag: "admin", groupType: alert.groupType, pendingOrTrialLesson: s, createdAt: new Date().toISOString() };
      // Remove from any existing group sub-items
      const baseGroupType = alert.groupType?.includes("pending") ? "alert-pending" : "alert-trial";
      let modified = false;
      const updated = currentItems.map(t => {
        if (t.done || t.groupType !== baseGroupType || !Array.isArray(t.subItems)) return t;
        const newSubs = t.subItems.filter(sub => {
          if (sub.studentName === s.studentName) { modified = true; return false; }
          return true;
        });
        return modified ? { ...t, subItems: newSubs } : t;
      });
      if (updated.find(t => !t.done && t.groupType === alert.groupType)) return updated;
      return [newItem, ...updated];
    }
    // Group pending/trial drop — absorbs existing standalone items
    if (alert.pendingOrTrialStudents) {
      const baseGroupType = alert.groupType;
      if (currentItems.find(t => !t.done && t.groupType === baseGroupType)) return currentItems;
      const studentIds = new Set(alert.pendingOrTrialStudents.map(s => s.studentId));
      const filtered = currentItems.filter(t => !(t.pendingOrTrialLesson && !t.done && studentIds.has(t.pendingOrTrialLesson.studentId)));
      const label = baseGroupType === "alert-pending" ? "pending enrolment" : "trial";
      const subItems = alert.pendingOrTrialStudents.map(s => {
        const parentLabel = preferredFirstName(s.parentName) || "parent";
        const firstName = preferredFirstName(s.studentName) || (s.studentName || "").split(" ")[0];
        const instrSuffix = s.instrument ? ` — ${s.instrument}` : "";
        return { id: uid(), text: `Contact ${parentLabel} re: ${firstName}'s ${label}${instrSuffix}`, done: false, parentEmail: s.parentEmail, parentName: s.parentName, studentName: s.studentName, studentId: s.studentId, instrument: s.instrument || "", pendingLabel: label };
      });
      return [{ id: uid(), text: alert.text, done: false, tag: alert.tag, groupType: baseGroupType, pendingOrTrialStudents: alert.pendingOrTrialStudents, subItems, createdAt: new Date().toISOString() }, ...filtered];
    }
    return [{ id: uid(), text: alert.text, done: false, tag: alert.tag, groupType: alert.groupType, createdAt: new Date().toISOString() }, ...currentItems];
  }, []);
  // Inbox emails are by definition incoming — pin any that carry an attachment.
  const togglePin = (emailId) => {
    const isPinned = emailPinned.includes(emailId);
    const next = isPinned ? emailPinned.filter(id => id !== emailId) : [...emailPinned, emailId];
    setEmailPinned(next);
    // Reset swipe so the pinned email doesn't stay showing the action buttons
    emailSwipeRef.current[emailId] = 0;
    setEmailSwipeState(prev => ({ ...prev, [emailId]: 0 }));
    try { localStorage.setItem(STORAGE_KEYS.emailPinned, JSON.stringify(next)); } catch {}
  };

  // Classify a sender email address into: parent | teacher | staff | admin | enquiry | other
  // - parent:  email found in any student's parents array
  // - teacher: email found in school contacts with role Classroom Teacher or Specialist Teacher
  // - staff:   email found in the Teachers tab (my music teachers)
  // - admin:   email found in school contacts with admin roles (Principal, AP, Business/Office Manager)
  const classifyEmail = React.useCallback((fromAddr) => {
    if (!fromAddr) return "other";
    const addr = fromAddr.toLowerCase();
    // Parent — in any student's parent contacts
    const allParents = students.flatMap(s => (s.parents || []).map(p => p.email || "").filter(Boolean));
    if (allParents.some(e => e.toLowerCase() === addr)) return "parent";
    // Staff — my music teachers tab
    if (teachers.some(t => t.email && t.email.toLowerCase() === addr)) return "staff";
    // School contacts — split by role
    const contact = contacts.find(c => c.email && c.email.toLowerCase() === addr);
    if (contact) {
      const role = (contact.role || "").toLowerCase();
      if (role.includes("classroom") || role.includes("specialist")) return "teacher";
      if (role.includes("principal") || role.includes("assistant principal") ||
          role.includes("business") || role.includes("office")) return "admin";
      return "admin"; // any other school contact defaults to admin
    }
    return "other";
  }, [teachers, students, contacts]);

  // Classify an email (including subject-based enquiry detection)
  const classifyEmailFull = React.useCallback((email) => {
    if (emailCategoryOverrides[email.id]) return emailCategoryOverrides[email.id];
    const base = classifyEmail(email.from?.match(/<(.+)>/)?.[1] || email.from || "");
    if (base === "other") {
      // Skip known automated/corporate domains — these are never genuine lesson enquiries
      const fromDomain = (email.from?.match(/@([\w.-]+)/)?.[1] || "").toLowerCase();
      const automatedDomains = ["google.com", "googlecloud.com", "workspace.google.com", "accounts.google.com",
        "github.com", "linkedin.com", "facebook.com", "twitter.com", "noreply.com", "amazonses.com"];
      if (automatedDomains.some(d => fromDomain === d || fromDomain.endsWith("." + d))) return "other";
      // Require a music-specific keyword, or two general enquiry keywords together
      const subj = (email.subject || "").toLowerCase();
      const snippet = (email.snippet || "").toLowerCase();
      const text = subj + " " + snippet;
      const musicKw = ["guitar", "piano", "violin", "drums", "music lesson", "music tuition", "instrument", "singing", "voice lesson", "bass", "flute", "clarinet", "trumpet", "cello"];
      const generalKw = ["enrol", "enroll", "enquir", "inquir", "lesson", "interest", "trial", "start", "availab", "sign up", "join"];
      const hasMusicKw = musicKw.some(kw => text.includes(kw));
      const generalMatches = generalKw.filter(kw => subj.includes(kw));
      if (hasMusicKw || generalMatches.length >= 2) return "enquiry";
      // Single general keyword in subject is enough if it's a clear enquiry word
      if (["enrol", "enroll", "enquir", "inquir"].some(kw => subj.includes(kw))) return "enquiry";
    }
    return base;
  }, [classifyEmail, emailCategoryOverrides]);

  // Classify a SENT email by its recipients (to field) rather than the sender.
  // Returns the highest-priority category found across all recipients:
  // parent > staff > teacher > admin > other
  // Enquiry and pinned are inbox-only concepts so are never returned here.
  const classifySentEmailFull = React.useCallback((email) => {
    if (emailCategoryOverrides[email.id]) return emailCategoryOverrides[email.id];
    const toRaw = email.to || "";
    const addrs = toRaw.split(",").map(a => {
      const m = a.match(/<(.+)>/);
      return (m ? m[1] : a).trim();
    }).filter(Boolean);
    const cats = addrs.map(a => classifyEmail(a));
    const priority = ["parent", "staff", "teacher", "admin"];
    for (const p of priority) {
      if (cats.includes(p)) return p;
    }
    return "other";
  }, [classifyEmail, emailCategoryOverrides]);

  // Generate AI summaries for all emails in a single batch call (uses Haiku for cost)
  const generateSummaries = React.useCallback(async (emails) => {
    if (!emails || emails.length === 0) return;
    const apiKey = typeof localStorage !== "undefined" ? localStorage.getItem("mt-api-key") || "" : "";
    if (!apiKey) return;

    // Use ref so this callback doesn't need emailSummaries in its deps (which caused polling to reset)
    const toSummarise = emails.filter(e => {
      const cacheKey = `${e.threadId || e.id}-${e.id}`;
      return !emailSummariesRef.current[cacheKey];
    });
    if (toSummarise.length === 0) return;

    setSummariesLoading(true);
    try {
      const prompt = `Analyse each email below. For each, return a JSON object with:\n- "summary": ONE short sentence (max 12 words) describing the email\n- "needsReply": true if the email contains a question, request, or clearly expects a response; false otherwise\n\nReturn ONLY a JSON object mapping each email id to { "summary": "...", "needsReply": true/false }. No other text.\n\nEmails:\n${toSummarise.map(e => `id:${e.id}\nFrom:${e.from}\nSubject:${e.subject}\nSnippet:${e.snippet || e.body?.slice(0, 200) || ""}`).join("\n---\n")}`;
      const res = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await res.json();
      if (data.usage && recordUsage) recordUsage("claude-haiku-4-5-20251001", data.usage.input_tokens || 0, data.usage.output_tokens || 0);
      const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").replace(/```json|```/g, "").trim();
      let parsed = {};
      try { parsed = JSON.parse(text); } catch {}
      const newCache = { ...emailSummariesRef.current };
      for (const e of toSummarise) {
        const cacheKey = `${e.threadId || e.id}-${e.id}`;
        if (parsed[e.id]) {
          const val = parsed[e.id];
          newCache[cacheKey] = typeof val === "string" ? { summary: val, needsReply: false } : { summary: val.summary || "", needsReply: !!val.needsReply };
        }
      }
      emailSummariesRef.current = newCache; // keep ref in sync before state update
      setEmailSummaries(newCache);
      try { localStorage.setItem(STORAGE_KEYS.emailSummaryCache, JSON.stringify(newCache)); } catch {}
    } catch {}
    setSummariesLoading(false);
  }, [recordUsage]); // emailSummaries removed from deps — read via ref instead

  // Triage a single email — draft a reply using app context
  const triageEmail = React.useCallback(async (email) => {
    const apiKey = typeof localStorage !== "undefined" ? localStorage.getItem("mt-api-key") || "" : "";
    if (!apiKey) return;
    setTriageLoading(prev => ({ ...prev, [email.id]: true }));
    try {
      const schoolList = schools.map(s => s.name).join(", ");
      const teacherList = teachers.map(t => t.name).join(", ");
      const prompt = `You are helping a music tuition coordinator reply to an email. Draft a concise reply that matches the coordinator's writing style.

Context:
- Schools: ${schoolList}
- Teachers: ${teacherList}
- Active students: ${students.filter(s => s.status === "active").length}
${emailStyle && emailStyle.trim() ? `
Writing style guide (match this closely):
${emailStyle.trim()}
` : ""}
Email:
From: ${email.from}
Subject: ${email.subject}
Body: ${email.body || email.snippet}

Write ONLY the reply body. No subject line, no sign-off placeholder, no explanation.`;
      const res = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await res.json();
      if (data.usage && recordUsage) recordUsage("claude-haiku-4-5-20251001", data.usage.input_tokens || 0, data.usage.output_tokens || 0);
      const draft = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
      setTriageDraft(prev => ({ ...prev, [email.id]: draft }));
    } catch {}
    setTriageLoading(prev => ({ ...prev, [email.id]: false }));
  }, [schools, teachers, students, recordUsage, emailStyle]);

  // Alert dismissals — keyed by groupType. Persist across days; the only
  // way to restore dismissed alerts is the refresh button on the alerts
  // panel header (Dashboard.js, "Restore dismissed alerts" RotateCcw).
  const [alertDismissals, setAlertDismissals] = React.useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.alertDismissals) || "{}");
      if (stored && typeof stored.dismissed === "object") return stored;
      return { dismissed: {} };
    } catch { return { dismissed: {} }; }
  });
  const dismissAlert = (key) => {
    const next = { ...alertDismissals, dismissed: { ...alertDismissals.dismissed, [key]: true } };
    setAlertDismissals(next);
    try { localStorage.setItem(STORAGE_KEYS.alertDismissals, JSON.stringify(next)); } catch {}
  };
  const isAlertDismissed = (key) => !!alertDismissals.dismissed[key];
  const pendingDismissed = isAlertDismissed("alert-pending");
  const trialDismissed = isAlertDismissed("alert-trial");

  // v2.18.0 — uninvoiced-students alert chip data.
  // READ-ONLY reads of the invoice drafts and dismissal keys InvoicingManager
  // persists to localStorage. Dashboard never writes invoiceDrafts.
  //
  // IMPORTANT: Dashboard NEVER remounts — App keeps it permanently mounted
  // behind display:none — so a mount-time useState read goes stale forever.
  // Instead the RAW strings are read on every render (cheap: in-memory
  // localStorage cache) and the derivation memo is keyed on them, so it
  // re-parses only when the stored values actually change. A dismissal made
  // on the Invoicing banner is therefore picked up by the very next render
  // (at latest, the navigation back to the Dashboard), and freshly generated
  // invoices drop students off the chip the same way.
  let uninvoicedDismissalsRaw = "[]";
  try { uninvoicedDismissalsRaw = localStorage.getItem(STORAGE_KEYS.uninvoicedDismissals) || "[]"; } catch {}
  let dashInvoiceDraftsRaw = "[]";
  try { dashInvoiceDraftsRaw = localStorage.getItem(STORAGE_KEYS.invoiceDrafts) || "[]"; } catch {}
  // Per-student, term-scoped dismissal from the chip dropdown — SAME key the
  // Invoicing banner writes ("<termLabel>|<studentName>"), so chip and banner
  // stay in lockstep. Read-modify-write against localStorage (NOT React
  // state) so banner-side keys written since the last read are never
  // clobbered; the tick state just forces a re-render to re-read.
  const [, setUninvoicedSyncTick] = React.useState(0);
  const dismissUninvoicedStudent = (termLabel, studentName) => {
    try {
      const cur = new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.uninvoicedDismissals) || "[]"));
      cur.add(uninvoicedDismissKey(termLabel, studentName));
      localStorage.setItem(STORAGE_KEYS.uninvoicedDismissals, JSON.stringify([...cur]));
    } catch {}
    setUninvoicedSyncTick(t => t + 1);
  };
  // Current term resolved exactly as Invoicing's default selection (selIdx 0).
  const uninvoicedAlert = React.useMemo(() => {
    const term = resolveCurrentTerm(interruptions || []);
    if (!term) return { term: null, rows: [] };
    let dismissals; let invoices;
    try { dismissals = new Set(JSON.parse(uninvoicedDismissalsRaw)); } catch { dismissals = new Set(); }
    try { const v = JSON.parse(dashInvoiceDraftsRaw); invoices = Array.isArray(v) ? v : []; } catch { invoices = []; }
    const rows = getUninvoicedStudents({ timetable, groups, students, schools, invoices, termInfo: term, dismissals });
    return { term, rows };
  }, [interruptions, timetable, groups, students, schools, uninvoicedDismissalsRaw, dashInvoiceDraftsRaw]);

  // Lesson-change email dismissals — keyed by email id, persistent across midnight
  // (parallel to alertDismissals but no `date` field and no daily reset)
  const [lessonChangeDismissals, setLessonChangeDismissals] = React.useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.lessonChangeDismissals) || "{}");
      if (stored && typeof stored.dismissed === "object") return stored;
      return { dismissed: {} };
    } catch { return { dismissed: {} }; }
  });
  const dismissLessonChange = (emailId) => {
    const next = { dismissed: { ...lessonChangeDismissals.dismissed, [emailId]: true } };
    setLessonChangeDismissals(next);
    try { localStorage.setItem(STORAGE_KEYS.lessonChangeDismissals, JSON.stringify(next)); } catch {}
  };
  const dismissLessonChangesBulk = (emailIds) => {
    if (!emailIds || emailIds.length === 0) return;
    const additions = Object.fromEntries(emailIds.map(id => [id, true]));
    const next = { dismissed: { ...lessonChangeDismissals.dismissed, ...additions } };
    setLessonChangeDismissals(next);
    try { localStorage.setItem(STORAGE_KEYS.lessonChangeDismissals, JSON.stringify(next)); } catch {}
  };
  const isLessonChangeDismissed = (emailId) => !!lessonChangeDismissals.dismissed[emailId];

  // ── Sidebar badge counts ────────────────────────────────────
  const unreadEmailCount = useMemo(() =>
    inboxEmails.filter(e => !emailReadIds.has(e.id)).length,
  [inboxEmails, emailReadIds]);

  const sidebarAlertCount = useMemo(() => {
    const dismissed = (key) => !!alertDismissals?.dismissed?.[key];
    const todayStr2 = melbourneToday();
    const mon = getCurrentWeekMonday();
    const currentWeekKey = toLocalDateStr(mon);
    const nextWeekKey = toLocalDateStr((() => { const d = new Date(mon); d.setDate(d.getDate() + 7); return d; })());
    const alertIntrEnd = toLocalDateStr((() => { const d = new Date(mon); d.setDate(d.getDate() + 14); return d; })());
    const startOfToday = new Date(todayStr2 + "T00:00:00").getTime();
    const startOfYesterday = startOfToday - 86400000;
    const emailAgeMs2 = (e) => e.internalDate || (e.date ? new Date(e.date).getTime() : 0);

    const incompleteCount = students.filter(s =>
      s.status === "active" && (!s.schoolId || !s.className || !(s.parents || []).some(p => p.email || p.phone))
    ).length;

    const missedThisWeekCount = new Set(
      getMissedEntries({ weeklyTimetables, weekKey: currentWeekKey })
        .map(e => `${e.studentId}|${e.instrument}`)
    ).size;

    // Aligned with the alerts-panel chip (and TallyView's stats.makeupOwed):
    // term scope, all schools, __private__/pending/trial/archived-overlap
    // filters all inherited from deriveTallyRows. Current week is included
    // — matches the tally summary card.
    const catchupTotal = getOpenCatchupRows({
      weeklyTimetables, enrolments, students, timetable, termWeeks, schoolFilter: "all", catchups,
    }).length;

    const allRR = inboxEmails.filter(e => {
      if (emailNoReplyOverrides.has(e.id)) return false;
      const cached = emailSummaries[`${e.threadId || e.id}-${e.id}`];
      if (!(typeof cached === "object" ? !!cached?.needsReply : false)) return false;
      // Exclude emails already replied to
      const msgs = e.threadMessages || [];
      if (msgs.some(m => m.isSent)) return false;
      if (sentEmails.length > 0) {
        const tid = e.threadId || e.id;
        const normSubject = (e.subject || "").replace(/^(re|fwd?):\s*/gi, "").trim().toLowerCase();
        if (sentEmails.some(s => {
          if (s.threadId && s.threadId === e.threadId) return true;
          if (normSubject) { const sNorm = (s.subject || "").replace(/^(re|fwd?):\s*/gi, "").trim().toLowerCase(); if (sNorm === normSubject) return true; }
          return (s.threadId || s.id) === tid;
        })) return false;
      }
      return true;
    });
    const rrRed = allRR.filter(e => emailAgeMs2(e) < startOfYesterday);
    const rrYellow = allRR.filter(e => emailAgeMs2(e) >= startOfYesterday && emailAgeMs2(e) < startOfToday);
    const rrBlue = allRR.filter(e => emailAgeMs2(e) >= startOfToday);

    const pendingOnly = students.filter(s => s.status === "pending").reduce((s, st) => s + Math.max(1, instrumentsFromEnrolments(st.id, enrolments).filter(i => !i.isGroup).length), 0);
    const trialOnly = students.filter(s => s.status === "trial").reduce((s, st) => s + Math.max(1, instrumentsFromEnrolments(st.id, enrolments).filter(i => !i.isGroup).length), 0);

    const upcomingInterruptions = interruptions.filter(i => i.type !== "term_break" && i.date >= todayStr2 && i.date <= alertIntrEnd);

    const lcKeywords = ["reschedul","change","swap","move","different time","different day","can't make","cannot make","won't be","will not be","away","absent","cancel","conflict","clash"];
    const lcEmails = inboxEmails.filter(e => {
      const addr = (e.from?.match(/<(.+)>/)?.[1] || e.from || "").toLowerCase();
      if (!students.some(s => (s.parents || []).some(p => p.email?.toLowerCase() === addr))) return false;
      const text = ((e.subject || "") + " " + (e.snippet || "") + " " + (e.body || "")).toLowerCase();
      return lcKeywords.some(kw => text.includes(kw));
    });

    const upcomingAbsences = new Set(
      getInformedAbsencesForWeek({ weeklyTimetables, weekKey: nextWeekKey })
        .map(e => `${e.studentId || e.studentName}|${e.instrument}`)
    ).size;

    let count = 0;
    if (unassignedCount > 0 && !dismissed("alert-unassigned")) count++;
    if (unschedCount > 0 && !dismissed("alert-unscheduled")) count++;
    if (incompleteCount > 0 && !dismissed("alert-incomplete")) count++;
    if (missedThisWeekCount > 0 && !dismissed("alert-missed-week")) count++;
    if (rrRed.length > 0 && !dismissed("alert-response-red")) count++;
    if (rrYellow.length > 0 && !dismissed("alert-response-yellow")) count++;
    if (rrBlue.length > 0 && !dismissed("alert-response-blue")) count++;
    if (upcomingInterruptions.filter(i => !dismissed(`alert-interruption-${i.id}`)).length > 0) count++;
    if (catchupTotal > 0 && !dismissed("alert-catchup")) count++;
    if (pendingOnly > 0 && !dismissed("alert-pending")) count++;
    if (trialOnly > 0 && !dismissed("alert-trial")) count++;
    if (lcEmails.filter(em => !isLessonChangeDismissed(em.id)).length > 0 && !dismissed("alert-lesson-change")) count++;
    if (upcomingAbsences > 0 && !dismissed("alert-upcoming-absences")) count++;
    const assignedGroupIds = new Set((groups || []).flatMap(g => (g.studentIds || [])));
    const ungroupedCount = students.filter(s => ["active", "pending", "trial"].includes(s.status) && instrumentsFromEnrolments(s.id, enrolments).some(i => i.isGroup) && !assignedGroupIds.has(s.id)).length;
    if (ungroupedCount > 0 && !dismissed("alert-unassigned-groups")) count++;
    return count;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unassignedCount, unschedCount, students, enrolments, weeklyTimetables, timetable, termWeeks, inboxEmails, emailNoReplyOverrides, emailSummaries, interruptions, alertDismissals, lessonChangeDismissals, groups, sentEmails]);

  useEffect(() => {
    if (setDashBadges) setDashBadges({ alerts: sidebarAlertCount, email: unreadEmailCount });
  }, [sidebarAlertCount, unreadEmailCount, setDashBadges]);
  // ── End sidebar badge counts ────────────────────────────────

  // Parse metadata from an enquiry email (client-side, no API call)
  const parseEnquiryMeta = React.useCallback((email) => {
    const fromName = email.from?.includes("<")
      ? email.from.split("<")[0].trim().replace(/^"|"$/g, "")
      : (email.from?.split("@")[0] || "Unknown");
    const text = `${email.subject || ""} ${email.snippet || ""} ${email.body || ""}`;
    const textLow = text.toLowerCase();
    const STOPWORDS = new Set(["the","and","for","this","that","with","from","have","has","his","her","him","are","was","were","will","would","could","should","been","being","they","them","their","there","then","than","when","what","which","who","how","but","not","can","may","our","its","more","also","just","now","about","into","onto","upon","over","under","only","here","even","such","like","some","any","all","does","did","your","you","guitar","piano","violin","viola","cello","drums","voice","flute","trumpet","bass","ukulele","lessons","lesson","lessons","class","booking","bookings","response","enquiry","inquiry","trial","information","availability","school"]);
    // Proper name = two adjacent Title-case words, neither a stopword, each ≥ 2 chars
    const PROPER_NAME = /\b([A-Z][a-z]{1,})\s+([A-Z][a-z]{1,})\b/g;
    let studentName = "";
    // Priority 1: Subject line — look for proper name pair
    const subj = email.subject || "";
    const subjNames = [...subj.matchAll(PROPER_NAME)].map(m => `${m[1]} ${m[2]}`).filter(n => {
      const [a, b] = n.toLowerCase().split(" ");
      return !STOPWORDS.has(a) && !STOPWORDS.has(b);
    });
    if (subjNames.length > 0) studentName = subjNames[0];
    // Priority 2: Body text proper name pair in context clues
    if (!studentName) {
      const bodyMatch = text.match(/\b(?:son|daughter|child|student|my)\s+(?:is\s+)?([A-Z][a-z]{1,}\s+[A-Z][a-z]{1,})\b/) ||
                        text.match(/\bfor\s+([A-Z][a-z]{1,}\s+[A-Z][a-z]{1,})\b/);
      if (bodyMatch) {
        const [a, b] = bodyMatch[1].toLowerCase().split(" ");
        if (!STOPWORDS.has(a) && !STOPWORDS.has(b)) studentName = bodyMatch[1];
      }
    }
    // School — match name or acronym against known schools, also check the
    // address it was sent to. Combine Delivered-To + To + Cc: mail to a free
    // alias lands in the primary mailbox, so Delivered-To is matt@ and the alias
    // appears only in To/Cc.
    let school = "";
    const rawToField = `${email.deliveredTo || ""} ${email.to || ""} ${email.cc || ""}`;
    const toEmails = [...rawToField.matchAll(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g)].map(m => m[1].toLowerCase());
    for (const sc of schools) {
      const sName = (sc.name || "").toLowerCase();
      const acronym = sName.split(/\s+/).filter(Boolean).map(w => w[0]).join("").toLowerCase();
      // Body text match
      if (textLow.includes(sName) || (acronym.length > 1 && new RegExp(`\\b${acronym}\\b`).test(textLow))) { school = sc.name; break; }
      // to-address: exact senderEmail match
      if (sc.senderEmail && toEmails.includes(sc.senderEmail.toLowerCase())) { school = sc.name; break; }
      // to-address: local part matches school acronym
      if (acronym.length > 1 && toEmails.some(a => a.split("@")[0] === acronym)) { school = sc.name; break; }
    }
    // Class — "Year 4A", "3B", "Room 5", "Class 6C" — must contain a digit to avoid matching phrases like "class times"
    let className = "";
    const classMatch = text.match(/\b(year\s*\d+[a-zA-Z]?|class\s*\d+[a-zA-Z]?|\d[a-zA-Z]\b|room\s*\d+[a-zA-Z]?)/i);
    if (classMatch) className = classMatch[1];
    return { parentName: fromName, studentName, school, className };
  }, [schools]);

  // Build a student prefill object from an enquiry email — used by both the
  // right-click "Add to waiting list" context menu and the to-do drop flow.
  const buildEnquiryPrefill = React.useCallback((email, status = "pending") => {
    const meta = parseEnquiryMeta(email);
    const fromAddr = email.from?.match(/<(.+)>/)?.[1] || email.from || "";
    const fullText = `${email.subject || ""} ${email.snippet || ""} ${email.body || ""}`;
    const _teacherInstrs = [...new Set(teachers.flatMap(t => (t.instruments || []).map(i => i.name)))];
    let instrument = resolveInstrument(meta.instrument || "", _teacherInstrs) || resolveInstrument(fullText, _teacherInstrs);
    let enquirySchool = meta.school || "";
    if (!enquirySchool) {
      const rawTo = `${email.deliveredTo || ""} ${email.to || ""} ${email.cc || ""}`;
      const toAddrs = [...rawTo.matchAll(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g)].map(m => m[1].toLowerCase());
      const bodyLow = fullText.toLowerCase();
      const fromDomain = (fromAddr.split("@")[1] || "").toLowerCase();
      const matched = schools.find(s => {
        const acronym = s.name.split(/\s+/).filter(Boolean).map(w => w[0]).join("").toLowerCase();
        if (s.senderEmail && toAddrs.includes(s.senderEmail.toLowerCase())) return true;
        if (s.senderEmail && rawTo.toLowerCase().includes(s.senderEmail.toLowerCase())) return true;
        if (acronym.length > 1 && toAddrs.some(a => a.startsWith(acronym + "@"))) return true;
        if (fromDomain && contacts.some(c => c.schoolId === s.id && c.email && c.email.toLowerCase().endsWith("@" + fromDomain))) return true;
        if (bodyLow.includes(s.name.toLowerCase())) return true;
        if (acronym.length > 1 && new RegExp(`\\b${acronym}\\b`).test(bodyLow)) return true;
        return false;
      });
      if (matched) enquirySchool = matched.name;
    }
    return {
      name: meta.studentName || "",
      status,
      parents: [{ name: meta.parentName, email: fromAddr }],
      schoolId: schools.find(s => s.name === enquirySchool)?.id || "",
      className: meta.className || "",
      instruments: instrument
        ? [{ name: instrument, teacherId: "" }]
        : [{ name: "", teacherId: "" }],
    };
  }, [parseEnquiryMeta, schools, contacts, teachers]);

  // Drop an email onto the To Do list — fully structured output.
  const dropEmailToTodo = React.useCallback((email, currentItems) => {
    // Deduplicate
    const alreadyExists = currentItems.some(t =>
      t.emailId === email.id ||
      (t.subItems || []).some(s => s.emailId === email.id)
    );
    if (alreadyExists) return currentItems;

    const category = classifyEmailFull(email);
    const fromAddr = email.from?.match(/<(.+)>/)?.[1] || email.from || "";
    const fromName = email.from?.includes("<")
      ? email.from.split("<")[0].trim().replace(/^"|"$/g, "")
      : (email.from || "Unknown");
    const firstName = preferredFirstName(fromName) || fromName.split(" ")[0];
    const isEnquiry = category === "enquiry";
    const isParent = category === "parent";
    const cleanSubject = (email.subject || "").replace(/^(re:\s*)+/gi, "").trim();

    // Find linked student for known parents
    const linkedStudent = isParent
      ? students.find(s => (s.parents || []).some(p => p.email?.toLowerCase() === fromAddr.toLowerCase()))
      : null;

    const meta = isEnquiry ? parseEnquiryMeta(email) : { parentName: fromName };

    // Thread messages
    const allMsgs = email.threadMessages || [];
    const nonSentMsgs = allMsgs.filter(m => !m.isSent);
    const uniqueSenderAddrs = new Set(nonSentMsgs.map(m => m.from?.match(/<(.+)>/)?.[1] || m.from || ""));
    const isConversation = uniqueSenderAddrs.size <= 1; // single sender = 1:1 conversation regardless of sent msgs

    // Helper: build a structured sub-item for a message
    const msgSubItem = (m) => {
      const mAddr = m.from?.match(/<(.+)>/)?.[1] || m.from || "";
      const mName = m.from?.includes("<") ? m.from.split("<")[0].trim().replace(/^"|"$/g, "") : (m.from || "");
      const mFirst = preferredFirstName(mName) || mName.split(" ")[0];
      return { id: uid(), text: `Reply to ${mFirst}`, fullName: mName, replyTo: mAddr,
        replyEmailId: email.id, senderName: mFirst, done: false, emailId: email.id,
        composeSubject: email.subject ? reSubject(email.subject) : "",
        meta: { parentName: mName }, tag: "email", createdAt: new Date().toISOString() };
    };

    // === MULTI-SENDER THREAD (not a 1:1 conversation) ===
    if (nonSentMsgs.length > 1 && !isConversation) {
      const subItems = nonSentMsgs.map(msgSubItem);
      const replyAddrs = nonSentMsgs.map(m => m.from?.match(/<(.+)>/)?.[1] || m.from || "").filter(Boolean);
      // Detect if all senders are known parents
      const allParents = replyAddrs.every(addr => students.some(s => (s.parents || []).some(p => p.email?.toLowerCase() === addr.toLowerCase())));
      // Build sender names in order for label
      const senderFirstNames = [...new Map(nonSentMsgs.map(m => {
        const addr = m.from?.match(/<(.+)>/)?.[1] || m.from || "";
        const name = m.from?.includes("<") ? m.from.split("<")[0].trim().replace(/^"|"$/g, "") : (m.from || "");
        return [addr, preferredFirstName(name) || name.split(" ")[0]];
      })).values()];
      const groupText = allParents
        ? `Contact parents re: ${cleanSubject || "(no subject)"} — ${nonSentMsgs.length}`
        : `Contact ${senderFirstNames.slice(0, 3).join(", ")}${senderFirstNames.length > 3 ? ` +${senderFirstNames.length - 3}` : ""} re: ${cleanSubject || "(no subject)"}`;
      return [{ id: uid(), text: groupText, done: false, tag: "email", emailId: email.id,
        composeSubject: email.subject ? reSubject(email.subject) : "",
        meta, subItems, replyAddrs, createdAt: new Date().toISOString() }, ...currentItems];
    }

    // === ENQUIRY → structured sub-items ===
    if (isEnquiry) {
      const enquiryFirst = preferredFirstName(meta.parentName) || meta.parentName;
      const fullText = `${email.subject || ""} ${email.snippet || ""} ${email.body || ""}`;
      const _teacherInstrs2 = [...new Set(teachers.flatMap(t => (t.instruments || []).map(i => i.name)))];
      // Try to extract instrument — subject first (e.g. "Emerson Murphy – Piano"), then body
      let instrument = "";
      const instrMatch = cleanSubject.match(/[–—-]\s*([A-Za-z\s]+)$/);
      if (instrMatch) {
        instrument = resolveInstrument(instrMatch[1].trim(), _teacherInstrs2);
      }
      if (!instrument) {
        instrument = resolveInstrument(fullText, _teacherInstrs2);
      }
      // Try to parse school — multiple strategies
      let enquirySchool = meta.school || "";
      if (!enquirySchool) {
        // Extract all bare email addresses from the to/deliveredTo field (handles "Name <addr>" format)
        const rawTo = `${email.deliveredTo || ""} ${email.to || ""} ${email.cc || ""}`;
        const toAddrs = [...rawTo.matchAll(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g)].map(m => m[1].toLowerCase());
        const bodyLow = fullText.toLowerCase();
        const fromDomain = (fromAddr.split("@")[1] || "").toLowerCase();
        const matchedSchool = schools.find(s => {
          const acronym = s.name.split(/\s+/).filter(Boolean).map(w => w[0]).join("").toLowerCase();
          // 1. Any to-address matches school senderEmail exactly
          if (s.senderEmail && toAddrs.includes(s.senderEmail.toLowerCase())) return true;
          // 2. School senderEmail substring in raw to field
          if (s.senderEmail && rawTo.toLowerCase().includes(s.senderEmail.toLowerCase())) return true;
          // 3. School acronym@... in any to-address
          if (acronym.length > 1 && toAddrs.some(a => a.startsWith(acronym + "@"))) return true;
          // 4. From domain matches a school contact's domain
          if (fromDomain && contacts.some(c => c.schoolId === s.id && c.email && c.email.toLowerCase().endsWith("@" + fromDomain))) return true;
          // 5. School name in body
          if (bodyLow.includes(s.name.toLowerCase())) return true;
          // 6. School acronym in body
          if (acronym.length > 1 && new RegExp(`\\b${acronym}\\b`).test(bodyLow)) return true;
          return false;
        });
        if (matchedSchool) enquirySchool = matchedSchool.name;
      }
      const itemText = meta.studentName
        ? `Contact ${enquiryFirst} re: ${meta.studentName}${instrument ? `, ${instrument} enquiry` : ""}`
        : instrument ? `Contact ${enquiryFirst} re: ${instrument} enquiry`
        : `Contact ${enquiryFirst} — new enquiry`;
      const prefill = {
        name: meta.studentName || "",
        status: "pending",
        parents: [{ name: meta.parentName, email: fromAddr }],
        schoolId: schools.find(s => s.name === enquirySchool)?.id || "",
        className: meta.className || "",
        instruments: instrument ? [{ name: instrument, teacherId: "" }] : [{ name: "", teacherId: "" }]
      };
      const subItems = [
        { id: uid(), text: "Add to pending students", done: false, tag: "admin", navigateTo: "students", studentPrefill: prefill, createdAt: new Date().toISOString() },
        { id: uid(), text: "Schedule trial lesson", done: false, tag: "admin", navigateTo: "students", studentPrefill: { ...prefill, status: "trial" }, createdAt: new Date().toISOString() },
      ];
      return [{ id: uid(), text: itemText, done: false, tag: "email", groupType: "enquiry", emailId: email.id, replyTo: fromAddr, senderName: enquiryFirst, composeSubject: email.subject ? reSubject(email.subject) : "", meta, subItems, createdAt: new Date().toISOString() }, ...currentItems];
    }

    // === KNOWN PARENT with linked student ===
    let itemText, itemExtra;
    if (isParent && linkedStudent) {
      const studentFirst = linkedStudent.name.split(" ")[0];
      itemText = `Contact ${firstName} re: ${studentFirst}'s ${cleanSubject || "message"}`;
      itemExtra = { groupType: "parent-reply", replyTo: fromAddr, senderName: firstName, fullName: fromName };
    } else {
      // === GENERIC (1:1 conversation or unknown sender) ===
      itemText = `Contact ${firstName}${cleanSubject ? ` re: ${cleanSubject}` : ""}`;
      itemExtra = { groupType: isParent ? "parent-reply" : undefined, replyTo: fromAddr, senderName: firstName, fullName: fromName };
    }

    const newItem = { id: uid(), text: itemText, done: false, tag: "email", emailId: email.id, composeSubject: email.subject ? reSubject(email.subject) : "", meta, ...itemExtra, createdAt: new Date().toISOString() };

    // Auto-group by subject if a matching item already exists
    if (cleanSubject) {
      const matchIdx = currentItems.findIndex(t => {
        if (t.done || t.id === newItem.id) return false;
        const tSubject = (t.emailId
          ? (inboxEmails.find(e => e.id === t.emailId)?.subject || "").replace(/^(re:\s*)+/gi, "").trim()
          : t.text
        ).toLowerCase().replace(/^contact \S+ re: /i, "").replace(/^contact parents re: /i, "");
        return tSubject === cleanSubject.toLowerCase() || t.text.toLowerCase().includes(cleanSubject.toLowerCase());
      });
      if (matchIdx >= 0) {
        const target = currentItems[matchIdx];
        const newSubItem = { id: newItem.id, text: `Reply to ${firstName}`, fullName: fromName,
          replyTo: fromAddr, replyEmailId: email.id, senderName: firstName, done: false, emailId: email.id,
          composeSubject: email.subject ? reSubject(email.subject) : "", meta };
        const prevSubItems = target.subItems || [{ id: uid(), text: target.senderName ? `Reply to ${target.senderName}` : target.text,
          fullName: target.fullName, replyTo: target.replyTo, replyEmailId: target.emailId,
          composeSubject: target.composeSubject ?? (target.emailId ? (target.emailId ? reSubject(inboxEmails.find(e => e.id === target.emailId)?.subject || "") : "") : ""),
          senderName: target.senderName, done: false, emailId: target.emailId, meta: target.meta }];
        const newSubItems = [...prevSubItems, newSubItem];
        const allParents = newSubItems.every(s => s.replyTo &&
          students.some(st => (st.parents || []).some(p => p.email?.toLowerCase() === (s.replyTo || "").toLowerCase())));
        const newText = allParents
          ? `Contact parents re: ${cleanSubject}`
          : `${cleanSubject} — ${newSubItems.length} contacts`;
        return currentItems.map((t, i) => i === matchIdx ? { ...t, text: newText, subItems: newSubItems } : t);
      }
    }

    return [newItem, ...currentItems];
  }, [classifyEmailFull, parseEnquiryMeta, inboxEmails, students, contacts, schools]);

  // Drop multiple selected emails onto the To Do list.
  // Groups by sender: same sender → one grouped item; mixed → individual items via dropEmailToTodo.
  const dropMultipleEmailsToTodo = React.useCallback((emails, currentItems) => {
    if (emails.length === 0) return currentItems;
    if (emails.length === 1) return dropEmailToTodo(emails[0], currentItems);
    let result = [...currentItems];
    const bySender = {};
    emails.forEach(e => {
      const addr = e.from?.match(/<(.+)>/)?.[1] || e.from || "unknown";
      if (!bySender[addr]) bySender[addr] = [];
      bySender[addr].push(e);
    });
    Object.values(bySender).forEach(group => {
      if (group.length === 1) { result = dropEmailToTodo(group[0], result); return; }
      const e0 = group[0];
      const category = classifyEmailFull(e0);
      const fromAddr0 = e0.from?.match(/<(.+)>/)?.[1] || e0.from || "";
      const fromName = e0.from?.includes("<") ? e0.from.split("<")[0].trim().replace(/^"|"$/g, "") : (e0.from || "Unknown");
      const firstName = preferredFirstName(fromName) || fromName.split(" ")[0];
      const isParent = category === "parent";
      const isEnquiry = category === "enquiry";
      // Find linked student for parent emails
      const linkedStudent = (isParent || isEnquiry) ? students.find(s => (s.parents || []).some(p => p.email?.toLowerCase() === fromAddr0.toLowerCase())) : null;
      // Extract instrument from any subject in the group
      const _teacherInstrs3 = [...new Set(teachers.flatMap(t => (t.instruments || []).map(i => i.name)))];
      let instrument = "";
      for (const e of group) {
        const m = (e.subject || "").match(/[–—-]\s*([A-Za-z\s]+)$/);
        if (m) { instrument = resolveInstrument(m[1].trim(), _teacherInstrs3); if (instrument) break; }
        instrument = resolveInstrument(`${e.subject || ""} ${e.snippet || ""}`, _teacherInstrs3);
        if (instrument) break;
      }
      const studentLabel = linkedStudent ? linkedStudent.name.split(" ")[0] : null;
      const instrLabel = instrument ? `, ${instrument} enquiry` : "";
      const groupText = studentLabel
        ? `Contact ${firstName} re: ${studentLabel}${instrLabel}`
        : `Contact ${firstName} re:${instrument ? ` ${instrument} enquiry` : ` ${group.length} emails`}`;
      const subItems = group.map(e => ({
        id: uid(), text: e.subject?.replace(/^(re:\s*)+/gi, "").trim() || "(no subject)",
        fullName: fromName, replyTo: fromAddr0, replyEmailId: e.id, senderName: firstName,
        done: false, emailId: e.id, tag: "email", meta: { parentName: fromName }, createdAt: new Date().toISOString()
      }));
      const alreadyExists = result.some(t => group.some(e => t.emailId === e.id || (t.subItems || []).some(s => s.emailId === e.id)));
      if (!alreadyExists) result = [{ id: uid(), text: groupText, done: false, tag: "email",
        replyTo: fromAddr0, senderName: firstName, fullName: fromName,
        subItems, createdAt: new Date().toISOString() }, ...result];
    });
    return result;
  }, [dropEmailToTodo, classifyEmailFull, contacts, students]);

  // ── Open an email in the inbox panel ─────────────────────────
  const openEmail = React.useCallback((emailId) => {
    saveDashPanels({ ...dashPanels, emails: true });
    setInboxSelected(emailId);
    setTimeout(() => {
      const el = emailListRef.current?.querySelector(`[data-emailid="${emailId}"]`);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 80);
  }, [dashPanels, emailListRef]); // eslint-disable-line

  // ── Resolve email sender → parent / student ──────────────────
  const resolveEmailSender = React.useCallback((addr) => {
    if (!addr) return {};
    const lAddr = addr.toLowerCase();
    for (const student of students) {
      for (const parent of student.parents || []) {
        if (parent.email && parent.email.toLowerCase() === lAddr) {
          return { parentName: parent.name || parent.email, studentName: student.name, studentId: student.id };
        }
      }
    }
    for (const contact of contacts) {
      if (contact.email && contact.email.toLowerCase() === lAddr) {
        const linked = students.find(s => s.id === contact.studentId);
        return { parentName: contact.name, studentName: linked?.name || null, studentId: linked?.id || null };
      }
    }
    return {};
  }, [students, contacts]);

  // ── All people with email addresses (for @ mentions) ─────────
  const allEmailContacts = React.useMemo(() => {
    const seen = new Set();
    const result = [];
    for (const student of students) {
      for (const parent of (student.parents || [])) {
        if (parent.email && !seen.has(parent.email.toLowerCase())) {
          seen.add(parent.email.toLowerCase());
          result.push({ name: parent.name || parent.email, email: parent.email, sub: student.name });
        }
      }
    }
    for (const contact of contacts) {
      if (contact.email && !seen.has(contact.email.toLowerCase())) {
        seen.add(contact.email.toLowerCase());
        const linked = students.find(s => s.id === contact.studentId);
        const sub = linked?.name || ([contact.role, contact.className].filter(Boolean).join(" · ")) || null;
        result.push({ name: contact.name, email: contact.email, sub });
      }
    }
    return result;
  }, [students, contacts]);

  // Mention autocomplete state
  const [remindersMentionQuery, setRemindersMentionQuery] = React.useState(null);
  const [remindersMentionIndex, setRemindersMentionIndex] = React.useState(0);

  // Render reminder text — @mentions show as first name, clickable
  const renderReminderText = (text, mentions) => {
    if (!mentions?.length) return <span>{text}</span>;
    const parts = [];
    let pos = 0, key = 0;
    const sorted = mentions
      .map(m => ({ m, idx: text.indexOf(`@${m.name}`) }))
      .filter(x => x.idx >= 0)
      .sort((a, b) => a.idx - b.idx);
    for (const { m, idx } of sorted) {
      if (idx < pos) continue;
      if (idx > pos) parts.push(<span key={key++}>{text.slice(pos, idx)}</span>);
      const displayName = m.name.split(" ")[0]; // first name only
      parts.push(
        <button key={key++} onClick={e => { e.stopPropagation(); openCompose([m.email]); }}
          style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:colors.accent, fontFamily:"inherit", fontSize:"inherit", lineHeight:"inherit", fontWeight:500, textDecoration:"underline", textDecorationStyle:"dotted" }}>
          {displayName}
        </button>
      );
      pos = idx + `@${m.name}`.length;
    }
    if (pos < text.length) parts.push(<span key={key++}>{text.slice(pos)}</span>);
    return <>{parts}</>;
  };

  // Render todo item text — single source of truth from item.text, with contact name linkified
  const renderTodoItemText = (item) => {
    const text = item.text;
    const linkStyle = { color: colors.accentDark, fontWeight: 700, textDecoration: "underline", cursor: "pointer" };

    // Group summary items with dynamic counts
    if (item.pendingOrTrialStudents) {
      const activeCount = (item.subItems || []).filter(s => !s.done).length;
      const label = (item.groupType || "").includes("pending") ? "pending" : "trial";
      return <span>{`Follow up ${activeCount} ${label} student${activeCount !== 1 ? "s" : ""}`}</span>;
    }
    if (item.catchupStudents) {
      const remaining = (item.subItems || []).filter(s => !s.done).length;
      const base = text.replace(/\s*\(\d+ remaining\)$/, "");
      const cm = base.match(/^(Contact\s+.+?)(\s+re:\s|$)/);
      if (cm) {
        return (
          <>
            <span onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setCatchupContactMenu({ x: r.left, y: r.bottom + 4, item }); }} style={linkStyle}>
              {cm[1]}
            </span>
            {base.slice(cm[1].length)}{" ("}{remaining}{" remaining)"}
          </>
        );
      }
      return <span>{base} ({remaining} remaining)</span>;
    }

    // Determine click handler
    let onClick = null;
    let style = linkStyle;
    if (item.missedLessons) {
      onClick = (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMissedContactMenu({ x: r.left, y: r.bottom + 4, item }); };
    } else if (item.missedLesson?.parentEmail) {
      onClick = (e) => { e.stopPropagation(); openCompose([item.missedLesson.parentEmail], { triggerId: "todo_missed_lesson" }); };
    } else if (item.catchupLesson?.isGroup) {
      onClick = (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setCatchupContactMenu({ x: r.left, y: r.bottom + 4, item }); };
    } else if (item.catchupLesson?.parentEmail) {
      onClick = (e) => { e.stopPropagation(); openCompose([item.catchupLesson.parentEmail], { triggerId: "todo_catchup" }); };
    } else if (item.pendingOrTrialLesson?.parentEmail) {
      onClick = (e) => { e.stopPropagation(); openCompose([item.pendingOrTrialLesson.parentEmail], { triggerId: "todo_pending" }); };
      style = { ...linkStyle, color: colors.sidebarActive };
    } else if (item.replyAddrs) {
      onClick = (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setEmailGroupContactMenu({ x: r.left, y: r.bottom + 4, item }); };
    } else if (item.replyTo) {
      onClick = (e) => { e.stopPropagation(); openCompose([item.replyTo], { from: schoolSenderForSourceEmail(item.emailId ? inboxEmails.find(e2 => e2.id === item.emailId) : null, schools) || "", subject: item.composeSubject ?? (item.emailId ? reSubject(inboxEmails.find(e2 => e2.id === item.emailId)?.subject || "") : ""), triggerId: "todo_email" }); };
    }

    if (!onClick) {
      if (item.mentions?.length) return renderReminderText(text, item.mentions);
      return <span>{text}</span>;
    }

    // Extract the specific name to linkify from metadata (individual items only)
    let linkName = null;
    if (item.missedLesson) {
      linkName = preferredFirstName(item.missedLesson.parentName) || (item.missedLesson.parentName || "").split(" ")[0];
    } else if (item.catchupLesson && !item.catchupLesson.isGroup) {
      linkName = preferredFirstName(item.catchupLesson.parentName) || (item.catchupLesson.parentName || "").split(" ")[0];
    } else if (item.pendingOrTrialLesson) {
      linkName = preferredFirstName(item.pendingOrTrialLesson.parentName) || (item.pendingOrTrialLesson.parentName || "").split(" ")[0];
    } else if (item.senderName) {
      linkName = item.senderName;
    }

    // Individual items — find the name in text and linkify just that name
    if (linkName) {
      const idx = text.indexOf(linkName);
      if (idx >= 0) {
        return <>{text.slice(0, idx)}<span onClick={onClick} style={style}>{linkName}</span>{text.slice(idx + linkName.length)}</>;
      }
      // Name was edited out — show plain text, no link
      return <span>{text}</span>;
    }

    // Group items (missedLessons, catchupLesson.isGroup, replyAddrs) — link "Contact [names]" prefix
    const m = text.match(/^(Contact\s+.+?)(\s+re:\s|\s+—\s|$)/);
    if (m) {
      return <><span onClick={onClick} style={style}>{m[1]}</span>{text.slice(m[1].length)}</>;
    }

    return <span>{text}</span>;
  };

  // ── Sorted + filtered reminders ───────────────────────────────
  const sortedReminders = React.useMemo(() => {
    const todayStr = melbourneToday();
    // Derive term start from interruptions (same logic used in week label elsewhere)
    let termStartDate = null;
    const breaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const br of breaks) {
      const tbEnd = br.endDate || br.date;
      if (tbEnd < todayStr) {
        const ts = new Date(tbEnd); ts.setDate(ts.getDate() + 1);
        while (ts.getDay() === 6 || ts.getDay() === 0) ts.setDate(ts.getDate() + 1);
        termStartDate = ts; break;
      }
    }
    if (!termStartDate) { const y = new Date().getFullYear(); const s = new Date(y, 0, 27); while (s.getDay() !== 2) s.setDate(s.getDate() + 1); termStartDate = s; }

    const weekToMonday = (wn) => {
      const d = new Date(termStartDate); d.setDate(d.getDate() + (wn - 1) * 7); return toLocalDateStr(d);
    };
    const weekToFriday = (wn) => {
      const d = new Date(termStartDate); d.setDate(d.getDate() + (wn - 1) * 7 + 4); return toLocalDateStr(d);
    };
    const getSortDate = (r) => {
      if (r.date) return r.date;
      if (r.week) { const wn = parseInt(r.week); if (!isNaN(wn)) return weekToMonday(wn); }
      return null;
    };
    const active = reminders.filter(r => {
      // Has both a start date and an event week — show between start date and end of event week
      if (r.date && r.week) return r.date <= todayStr && weekToFriday(parseInt(r.week)) >= todayStr;
      const sd = getSortDate(r);
      if (!sd) return true;
      if (r.week && !r.date) return weekToFriday(parseInt(r.week)) >= todayStr;
      return sd >= todayStr;
    });
    const undated = active.filter(r => !getSortDate(r));
    const dated = active.filter(r => !!getSortDate(r)).sort((a, b) => { const da = getSortDate(a), db = getSortDate(b); return da < db ? -1 : da > db ? 1 : 0; });
    return [...undated, ...dated];
  }, [reminders, interruptions]);

  const fetchInbox = React.useCallback(async (opts = {}) => {
    if (!window.electronAPI) return;
    const { silent = false } = opts;
    // Respect rate limit — don't hit the API while blocked
    if (gmailRateLimitUntilRef.current > Date.now()) return;
    if (!silent) { setInboxLoading(true); setInboxError(null); }
    try {
      const res = await window.electronAPI.gmailListInbox();
      if (!res.ok) {
        applyGmailRateLimit(res.error); // parse + store rate limit time if present
        if (!silent) setInboxError(res.error || "Failed to fetch emails.");
        return;
      }
      const fetched = res.emails || [];
      // Compute new threads BEFORE the state update, using the ref for current state
      let archived = new Set();
      try { archived = new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxArchivedIds) || "[]")); } catch {}
      const allowed = fetched.filter(e => !archived.has(e.id));
      const fetchedIds = new Set(allowed.map(e => e.id));
      const existingIds = new Set(inboxEmailsRef.current.map(e => e.id));
      const newThreads = allowed.filter(e => !existingIds.has(e.id));
      // Fire side effects outside the state updater
      if (newThreads.length > 0) generateSummaries(newThreads);
      if (newThreads.length > 0 && onNewEmailRef.current) {
        const readIds = (() => { try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxReadIds) || "[]")); } catch { return new Set(); } })();
        console.log("[email-sound] new threads:", newThreads.length, "unread:", newThreads.filter(e => !readIds.has(e.id)).length, "callback:", !!onNewEmailRef.current);
        if (newThreads.some(e => !readIds.has(e.id))) onNewEmailRef.current();
      } else if (newThreads.length === 0) {
        console.log("[email-sound] poll ran — no new threads detected");
      } else {
        console.log("[email-sound] new threads found but onNewEmailRef.current is null");
      }
      // Pure state update — no side effects inside
      setInboxEmails(prev => {
        let arc = new Set();
        try { arc = new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxArchivedIds) || "[]")); } catch {}
        const prevAllowed = fetched.filter(e => !arc.has(e.id));
        const fIds = new Set(prevAllowed.map(e => e.id));
        const eIds = new Set(prev.map(e => e.id));
        const newT = prevAllowed.filter(e => !eIds.has(e.id));
        const merged = [
          ...newT,
          ...prev
            .filter(e => !arc.has(e.id))
            .map(old => fIds.has(old.id) ? prevAllowed.find(f => f.id === old.id) : old)
        ].map(preprocessEmail);
        saveInboxCache(merged);
        return merged;
      });
      setInboxLastFetched(Date.now());
    } catch (err) { if (!silent) setInboxError("Failed to fetch emails."); }
    if (!silent) setInboxLoading(false);
  }, [generateSummaries]);

  const fetchSent = React.useCallback(async () => {
    if (!window.electronAPI) return;
    if (gmailRateLimitUntilRef.current > Date.now()) return;
    setSentLoading(true);
    try {
      const res = await window.electronAPI.gmailListSent();
      if (res.ok) setSentEmails((res.emails || []).map(preprocessEmail));
    } catch {}
    setSentLoading(false);
  }, []);

  // On first mount: if rate-limited, use cache as-is. If cache is stale (>5min) or
  // empty, full-fetch. Otherwise use cache silently and re-run any pending summaries.
  // Also silently pre-fetch sent emails so reply indicators and attachment logic have thread data.
  useEffect(() => {
    if (gmailRateLimitUntilRef.current > Date.now()) {
      // Still rate-limited from a previous session — don't touch the API
      generateSummaries(inboxEmails);
      return;
    }
    const cacheAge = Date.now() - inboxLastFetched;
    if (inboxEmails.length === 0 || cacheAge > 5 * 60 * 1000) {
      fetchInbox();
    } else {
      // Cache is fresh — just re-run summaries on any unsummarised emails
      generateSummaries(inboxEmails);
    }
    // Pre-load sent emails for cross-thread reply + attachment detection
    if (sentEmails.length === 0) fetchSent();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 30-second background polling — inbox silent+incremental, sent silent full refresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetchInbox({ silent: true });
      fetchSent();
    }, 30 * 1000);
    return () => clearInterval(interval);
  }, [fetchInbox, fetchSent]);

  // Full-history Gmail search — debounced 600ms, fires when search bar has a value
  useEffect(() => {
    if (gmailSearchTimerRef.current) clearTimeout(gmailSearchTimerRef.current);
    if (!emailSearch.trim() || emailSearch.trim().length < 5 || !window.electronAPI?.gmailSearch) {
      setGmailSearchResults(null);
      setGmailSearchLoading(false);
      return;
    }
    setGmailSearchLoading(true);
    gmailSearchTimerRef.current = setTimeout(async () => {
      try {
        const res = await window.electronAPI.gmailSearch(emailSearch.trim(), emailFolder);
        if (res.ok) {
          setGmailSearchResults(res.emails || []);
        } else {
          setGmailSearchResults([]);
          setInboxError(res.error || "Search failed — try refreshing Gmail.");
        }
      } catch { setGmailSearchResults([]); }
      setGmailSearchLoading(false);
    }, 600);
  }, [emailSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <PageTitle subtitle={_rollFwd ? "Monday" : todayDayName} pageColor={PAGE_COLORS.dashboard} navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{(() => {
          const termBreaksForTitle = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));
          const hBreak = termBreaksForTitle.find(tb => effectiveTodayStr >= tb.date && effectiveTodayStr <= (tb.endDate || tb.date));
          if (hBreak) {
            const breakStart = new Date(hBreak.date + "T00:00:00");
            const dow = breakStart.getDay();
            const firstMonday = new Date(breakStart);
            firstMonday.setDate(breakStart.getDate() + (dow === 1 ? 0 : dow === 0 ? 1 : 8 - dow));
            const curMonday = _getMondayOf(new Date(effectiveTodayStr + "T00:00:00"));
            const wkNum = Math.max(1, Math.round((curMonday - firstMonday) / (7 * 24 * 60 * 60 * 1000)) + 1);
            return `Holidays Week ${wkNum}`;
          }
          return getTermWeekLabel(effectiveTodayStr, termBreaksForTitle);
        })().toUpperCase()}</PageTitle>
      {/* ── Week calendar strip ── */}
      {(() => {
        const teacherColorMap = {};
        teachers.forEach((t, i) => { teacherColorMap[t.id] = t.color || TEACHER_COLORS[i % TEACHER_COLORS.length]; });
        const termBreaksForStrip = interruptions.filter(i => i.type === "term_break");
        const calMonday = new Date(monday);
        calMonday.setDate(calMonday.getDate() + calendarWeekOffset * 7);
        const calMondayStr = toLocalDateStr(calMonday);
        const fullWeekDays = DAYS.map((d, i) => {
          const date = new Date(calMonday);
          date.setDate(calMonday.getDate() + i);
          return { day: d, date: toLocalDateStr(date), dayNum: date.getDate(), isNextWeek: false };
        });
        // When offset=0, mirror the rolling visibleDays; otherwise full Mon-Fri of offset week
        const stripDays = calendarWeekOffset === 0 ? visibleDays : fullWeekDays;
        const calWeekLabel = (() => {
          const hBreak = termBreaksForStrip.find(tb => fullWeekDays[0].date >= tb.date && fullWeekDays[0].date <= (tb.endDate || tb.date));
          if (hBreak) {
            const breakStart = new Date(hBreak.date + "T00:00:00");
            const dow = breakStart.getDay();
            const firstMonday = new Date(breakStart);
            firstMonday.setDate(breakStart.getDate() + (dow === 1 ? 0 : dow === 0 ? 1 : 8 - dow));
            const curMonday = _getMondayOf(new Date(fullWeekDays[0].date + "T00:00:00"));
            const wkNum = Math.max(1, Math.round((curMonday - firstMonday) / (7 * 24 * 60 * 60 * 1000)) + 1);
            return `Holidays Week ${wkNum}`;
          }
          return getTermWeekLabel(fullWeekDays[0].date, termBreaksForStrip);
        })();
        const activeDay = hoveredDay !== null ? hoveredDay : selectedDay !== null ? selectedDay : (stripDays[0]?.day || todayDayName);

        const renderDayCell = (wd) => {
          // Session 6 hotfix #2 — mirror hotfix #1: derive the row's actual
          // containing-Monday from wd.date instead of using the strip's
          // anchor calMondayStr. stripDays at calendarWeekOffset === 0 can
          // include rolled-forward isNextWeek rows that belong to Week N+1.
          const rowMondayStr = toLocalDateStr(_getMondayOf(new Date(wd.date + "T00:00:00")));
          const isActive = activeDay === wd.day;
          const isToday = wd.date === todayStr;
          const isExpanded = expandedDays.has(wd.date);
          const isTermBreak = interruptions.some(intr => intr.type === "term_break" && wd.date >= intr.date && wd.date <= (intr.endDate || intr.date));
          const dayInterrupts = interruptions.filter(intr => {
            if (intr.type === "term_break") return false;
            return wd.date >= intr.date && wd.date <= (intr.endDate || intr.date);
          });
          const dayEvents = [...calendarEvents, ...teacherShared].filter(ev => {
            const start = ev.startDate || ev.date;
            const end = ev.endDate || start;
            return start <= wd.date && end >= wd.date;
          });
          const dayTeacherSchools = [];
          for (const teacher of teachers) {
            for (const lane of teacherCoverage.filter(l => l.teacherId === teacher.id && l.day === wd.day && l.status === "active")) {
              const school = schools.find(s => s.id === lane.schoolId);
              if (school) {
                const wttKey = `${rowMondayStr}|${school.id}`;
                const wttEntry = weeklyTimetables[wttKey];
                const lessonsSource = wttEntry ? (wttEntry.lessons || []) : (timetable ? timetable.lessons : []);
                const dayLessons = lessonsSource.filter(l => getCardTeacherId(l, teacherCoverage, wttEntry ? laneOverrides : null, wttEntry ? rowMondayStr : null) === teacher.id && l.schoolId === school.id && l.day === wd.day);
                const firstLesson = dayLessons.length ? dayLessons.reduce((a, b) => a.start < b.start ? a : b) : null;
                const lastLesson = dayLessons.length ? dayLessons.reduce((a, b) => a.end > b.end ? a : b) : null;
                dayTeacherSchools.push({ teacher, school, firstLesson, lastLesson, lessonCount: dayLessons.length });
              }
            }
          }
          const bySchool = {};
          for (const { teacher, school, firstLesson, lastLesson, lessonCount } of dayTeacherSchools) {
            if (!bySchool[school.id]) bySchool[school.id] = { school, teachers: [] };
            bySchool[school.id].teachers.push({ teacher, firstLesson, lastLesson, lessonCount });
          }
          const schoolGroups = Object.values(bySchool);
          const dayReminders = sortedReminders.filter(r => {
            const rd = r.date || (() => {
              if (!r.week) return null;
              const wn = parseInt(r.week); if (isNaN(wn)) return null;
              let termStart = null;
              const breaks = interruptions.filter(i => i.type === "term_break").sort((a,b) => a.date < b.date ? 1 : -1);
              for (const br of breaks) { const tbEnd = br.endDate || br.date; if (tbEnd < wd.date) { const ts = new Date(tbEnd); ts.setDate(ts.getDate()+1); while(ts.getDay()===6||ts.getDay()===0) ts.setDate(ts.getDate()+1); termStart=ts; break; } }
              if (!termStart) { const y=new Date().getFullYear(); const s=new Date(y,0,27); while(s.getDay()!==2) s.setDate(s.getDate()+1); termStart=s; }
              const mon = new Date(termStart); mon.setDate(mon.getDate()+(wn-1)*7);
              const fri = new Date(mon); fri.setDate(fri.getDate()+4);
              return wd.date >= toLocalDateStr(mon) && wd.date <= toLocalDateStr(fri) ? wd.date : null;
            })();
            return rd === wd.date;
          });
          const hasDot = dayEvents.length > 0 || dayInterrupts.length > 0;
          const hasReminderDot = dayReminders.length > 0;
          // Session 6 / Phase 4 — red dot for any un-acked constraint
          // warning on this day (across all schools). Reuses the
          // dropdownWarningCounts memo: entries with count===0 are already
          // omitted in the memo, so a non-empty array means at least one
          // school has un-acked warnings. Lights up on MTT-fallback weeks
          // too — the memo's lessonsSource at L218-219 covers that branch.
          const hasWarningDot = Array.isArray(dropdownWarningCounts[wd.date]) && dropdownWarningCounts[wd.date].length > 0;
          return (
            <div key={wd.date}
              onMouseEnter={() => setHoveredDay(wd.day)}
              onMouseLeave={() => setHoveredDay(null)}
              onClick={() => { setExpandedDays(prev => { const next = new Set(prev); next.has(wd.date) ? next.delete(wd.date) : next.add(wd.date); return next; }); setSelectedDay(prev => prev === wd.day ? null : wd.day); }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setCalEventForm({ startDate: wd.date, endDate: wd.date, type: "personal", title: "", startTime: "", endTime: "", schoolId: "", affectsClasses: "all", interruptionSubtype: "other", details: "", x: e.clientX, y: e.clientY }); }}
              style={{
                borderRadius: 0,
                borderBottom: `2px solid ${(isActive || isExpanded) ? colors.sidebarActive : "transparent"}`,
                borderRight: `1px solid ${colors.border}`,
                borderLeft: wd.isNextWeek ? `3px solid ${colors.textMuted}` : "none",
                background: isTermBreak ? colors.purpleLight : (isActive || isExpanded) ? (darkMode ? `${colors.sidebarActive}18` : colors.blueLight) : colors.cardBg,
                padding: "10px 10px",
                minHeight: 90,
                transition: "border-color 0.15s, background 0.15s",
                cursor: "pointer",
                display: "flex", flexDirection: "column",
              }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: isActive ? (darkMode ? "#fff" : colors.sidebarActive) : colors.textLight, textTransform: "uppercase", letterSpacing: "0.05em" }}>{wd.day.slice(0, 3)}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {hasDot && <span style={{ width: 5, height: 5, borderRadius: "50%", background: dayInterrupts.length > 0 ? EVENT_TYPE_META.interruption.dot : (dayEvents[0]?.type ? (EVENT_TYPE_META[dayEvents[0].type]?.dot || EVENT_TYPE_META.personal.dot) : EVENT_TYPE_META.personal.dot), display: "inline-block", flexShrink: 0 }} />}
                  {hasWarningDot && <span style={{ width: 5, height: 5, borderRadius: "50%", background: colors.danger, display: "inline-block", flexShrink: 0 }} />}
                  {hasReminderDot && <span style={{ width: 5, height: 5, borderRadius: "50%", background: colors.accent, display: "inline-block", flexShrink: 0 }} />}
                  <span style={{ fontSize: 11, color: isActive ? (darkMode ? "#fff" : colors.sidebarActive) : colors.textMuted }}>{wd.dayNum}{isToday ? " ●" : ""}</span>
                </div>
              </div>
              {isTermBreak ? (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: colors.warning, letterSpacing: "0.03em", marginBottom: 2 }}>School Holidays</div>
                  {(() => {
                    const wdDate = new Date(wd.date + "T00:00:00");
                    const wdDow = wdDate.getDay();
                    const wdMon = new Date(wdDate); wdMon.setDate(wdDate.getDate() - (wdDow === 0 ? 6 : wdDow - 1));
                    const wdMonStr = toLocalDateStr(wdMon);
                    const cs = (catchups || []).filter(c => c.weekKey === wdMonStr && c.day === wd.day);
                    if (cs.length === 0) return null;
                    const byTeacher = {};
                    for (const c of cs) {
                      const enrol = enrolments.find(e => e.id === c.enrolmentId);
                      // Session 3 / C7 — catchup teacher derives from MTT placement, not enrolment stamp.
                      const mtt = enrol ? getStudentMTTTeacher(enrol.studentId, enrol.instrument, timetable, students, teachers, enrolments, teacherCoverage) : null;
                      const tid = mtt?.teacherId || "";
                      if (!byTeacher[tid]) byTeacher[tid] = [];
                      byTeacher[tid].push(c);
                    }
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
                        {Object.entries(byTeacher).map(([tid, tCatchups]) => {
                          const sorted = tCatchups.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
                          const first = sorted[0];
                          const lastTime = sorted[sorted.length - 1].time || "";
                          const [lh, lm] = lastTime.split(":").map(Number);
                          const endMin = lh * 60 + lm + 30;
                          const endStr = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
                          const tName = teachers.find(tc => tc.id === tid)?.name || "";
                          return (
                            <span key={tid} style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 9, fontWeight: 700, color: "#fff", background: teacherColorMap[tid] || colors.accent, borderRadius: 3, padding: "1px 4px" }}>
                              {tName.split(" ").map(w => w[0]).join("")}
                              <span style={{ fontWeight: 400, opacity: 0.9 }}>{toTimeLabel(first.time)}–{toTimeLabel(endStr)}</span>
                            </span>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <>
                  {dayInterrupts.length > 0 && (
                    <div style={{ marginBottom: 4 }}>
                      {dayInterrupts.slice(0, 2).map((intr, ii) => (
                        <div key={ii} style={{ fontSize: 9, background: colors.amberLight, color: "#92400E", borderRadius: 3, padding: "1px 4px", marginBottom: 2, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{intr.title}</div>
                      ))}
                    </div>
                  )}
                  {dayEvents.length > 0 && (
                    <div style={{ marginBottom: 4 }}>
                      {dayEvents.map(ev => {
                        const isTE = ev.type === "teacher_event";
                        const tm = EVENT_TYPE_META[ev.type] || EVENT_TYPE_META.personal;
                        return (
                          <div key={ev.id} style={{ fontSize: 9, background: isTE ? (ev.teacher_color || tm.bg) : tm.bg, color: isTE ? "#fff" : tm.text, borderRadius: 3, padding: "1px 4px", marginBottom: 2, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {(ev.startTime || ev.time) ? (ev.startTime || ev.time) + " " : ""}{isTE ? `${ev.teacher_name || "Staff"} Event` : ev.title}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {schoolGroups.length === 0 ? (
                    <div style={{ fontSize: 9, color: colors.textMuted, fontStyle: "italic" }}>No lessons</div>
                  ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {schoolGroups.map(({ school, teachers: ts }) => (
                    <div key={school.id}>
                      <div style={{ display: "flex", alignItems: "center", gap: 3, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 9, color: school.color || colors.textMuted, fontWeight: 600, flexShrink: 0 }}>{school.name.split(" ").filter(w => /^[A-Z]/.test(w)).map(w => w[0]).join("") || school.name.slice(0, 4).toUpperCase()}</span>
                        {ts.map(({ teacher: t, firstLesson, lastLesson }) => (
                          <span key={t.id} style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 9, fontWeight: 700, color: "#fff", background: teacherColorMap[t.id], borderRadius: 3, padding: "1px 4px" }}>
                            {t.name.split(" ").map(w => w[0]).join("")}
                            {firstLesson && lastLesson && (
                              <span style={{ fontWeight: 400, opacity: 0.9 }}>{toTimeLabel(firstLesson.start)}–{toTimeLabel(lastLesson.end)}</span>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
                </>
              )}
            </div>
          );
        };

        // Build expanded strip data for each open day, in date order
        const expandedStripData = stripDays
          .filter(wd => expandedDays.has(wd.date))
          .map(wd => {
            // Session 6 hotfix — derive the row's actual containing-Monday
            // from wd.date instead of using the strip's anchor calMondayStr.
            // At calendarWeekOffset === 0, stripDays can include rolled-
            // forward isNextWeek days (per allDaySlots at L290+), so the
            // strip anchor and the row's week are not always the same.
            // dropdownWarningCounts (L180) already uses per-week wkMonday
            // for the same reason.
            const rowMondayStr = toLocalDateStr(_getMondayOf(new Date(wd.date + "T00:00:00")));
            const isTermBreak = interruptions.some(intr => intr.type === "term_break" && wd.date >= intr.date && wd.date <= (intr.endDate || intr.date));
            const dayInterrupts = interruptions.filter(intr => {
              if (intr.type === "term_break") return false;
              return wd.date >= intr.date && wd.date <= (intr.endDate || intr.date);
            });
            const dayEvents = [...calendarEvents, ...teacherShared].filter(ev => {
              const start = ev.startDate || ev.date;
              const end = ev.endDate || start;
              return start <= wd.date && end >= wd.date;
            });
            const teacherSchoolsData = [];
            for (const teacher of teachers) {
              for (const lane of teacherCoverage.filter(l => l.teacherId === teacher.id && l.day === wd.day && l.status === "active")) {
                const school = schools.find(s => s.id === lane.schoolId);
                if (school) {
                  const wttKey = `${rowMondayStr}|${school.id}`;
                  const wttEntry = weeklyTimetables[wttKey];
                  const lessonsSource = wttEntry ? (wttEntry.lessons || []) : (timetable ? timetable.lessons : []);
                  const dayLessons = lessonsSource.filter(l => getCardTeacherId(l, teacherCoverage, wttEntry ? laneOverrides : null, wttEntry ? rowMondayStr : null) === teacher.id && l.schoolId === school.id && l.day === wd.day);
                  const firstLesson = dayLessons.length ? dayLessons.reduce((a, b) => a.start < b.start ? a : b) : null;
                  const lastLesson = dayLessons.length ? dayLessons.reduce((a, b) => a.end > b.end ? a : b) : null;
                  teacherSchoolsData.push({ teacher, school, firstLesson, lastLesson, lessonCount: dayLessons.length });
                }
              }
            }
            const bySchool = {};
            for (const ts of teacherSchoolsData) {
              if (!bySchool[ts.school.id]) bySchool[ts.school.id] = { school: ts.school, teachers: [] };
              bySchool[ts.school.id].teachers.push(ts);
            }
            const schoolGroups = Object.values(bySchool);
            const weeklyStatus = {};
            for (const sg of schoolGroups) {
              const key = `${rowMondayStr}|${sg.school.id}`;
              weeklyStatus[sg.school.id] = !!weeklyTimetables[key];
              // Substitution chips — only on WTT-backed weeks. Each active lane at
              // (school, day) is checked for a (weekKey, bucketId) override row;
              // if the override's teacher differs from the lane's default teacher,
              // record a (cover, default) pair for chip rendering.
              sg.subs = [];
              if (weeklyStatus[sg.school.id]) {
                const dayLanes = (teacherCoverage || []).filter(c => c.schoolId === sg.school.id && c.day === wd.day && c.status === "active");
                for (const lane of dayLanes) {
                  const override = (laneOverrides || []).find(o => o.weekKey === rowMondayStr && o.bucketId === lane.id);
                  if (!override || !override.overrideTeacherId || override.overrideTeacherId === lane.teacherId) continue;
                  const coverTeacher = teachers.find(t => t.id === override.overrideTeacherId);
                  const defaultTeacher = teachers.find(t => t.id === lane.teacherId);
                  if (coverTeacher && defaultTeacher) sg.subs.push({ coverTeacher, defaultTeacher });
                }
              }
            }
            const schoolIdsOnDay = new Set(schoolGroups.map(sg => sg.school.id));
            const pendingTrialOnDay = students.filter(s =>
              (s.status === "pending" || s.status === "trial") && schoolIdsOnDay.has(s.schoolId)
            );
            // Bands row — collected across all schools on this day. Bands only
            // exist in WTT, so MTT-fallback schools contribute nothing here.
            const bandEntries = [];
            for (const sch of schools) {
              const wttKey = `${rowMondayStr}|${sch.id}`;
              const wttEntry = weeklyTimetables[wttKey];
              if (!wttEntry) continue;
              const dayBands = (wttEntry.lessons || []).filter(l => l.schoolId === sch.id && l.day === wd.day && l.isBandSession);
              for (const l of dayBands) {
                bandEntries.push({ lesson: l, school: sch, weekKey: rowMondayStr });
              }
            }
            bandEntries.sort((a, b) => (a.lesson.start || "").localeCompare(b.lesson.start || ""));
            return { ...wd, isTermBreak, dayInterrupts, dayEvents, schoolGroups, weeklyStatus, pendingTrialOnDay, bandEntries };
          });

        // Auto-append Saturday/Sunday catch-up strips during holiday weeks (no tile, not dismissable)
        const isHolidayWeek = termBreaksForStrip.some(tb => fullWeekDays[0].date >= tb.date && fullWeekDays[0].date <= (tb.endDate || tb.date));
        if (isHolidayWeek) {
          const friDate = new Date(fullWeekDays[4].date + "T00:00:00");
          const wkCatchups = (catchups || []).filter(c => c.weekKey === calMondayStr);
          ["Saturday", "Sunday"].forEach((dayName, i) => {
            const wkendDate = new Date(friDate); wkendDate.setDate(friDate.getDate() + 1 + i);
            const dateStr = toLocalDateStr(wkendDate);
            if (wkCatchups.some(c => c.day === dayName)) {
              expandedStripData.push({
                day: dayName, date: dateStr, dayNum: wkendDate.getDate(), isNextWeek: false,
                isTermBreak: true, isWeekendCatchup: true,
                dayInterrupts: [], dayEvents: [], schoolGroups: [], weeklyStatus: {}, pendingTrialOnDay: []
              });
            }
          });
        }

        const linkStyle = { color: colors.accentDark, fontWeight: 600, textDecoration: "underline", cursor: "pointer", fontSize: 12 };
        const sectionLabel = { fontSize: 10, fontWeight: 700, color: colors.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 };

        return (
          <div style={{ marginBottom: 0 }}>
            <div style={{ background: colors.sidebarHover, borderRadius: "8px 8px 0 0", padding: "11px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: "#fff" }}>Upcoming</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {calendarWeekOffset !== 0 && (
                  <button onClick={() => setCalendarWeekOffset(0)}
                    style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6, padding: "2px 10px", cursor: "pointer", color: "#fff", fontSize: 11, fontFamily: "inherit" }}>
                    Today
                  </button>
                )}
                <button onClick={() => setCalendarWeekOffset(o => o - 1)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.6)", display: "flex", alignItems: "center", padding: "2px 4px" }}><ChevronLeft size={15} /></button>
                <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", minWidth: 60, textAlign: "center" }}>
                  {calWeekLabel}
                </span>
                <button onClick={() => setCalendarWeekOffset(o => o + 1)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.6)", display: "flex", alignItems: "center", padding: "2px 4px" }}><ChevronRight size={15} /></button>
              </div>
            </div>
            <div style={{ background: colors.cardBg, border: "1px solid rgba(74,85,104,0.18)", borderTop: "none", borderRadius: expandedStripData.length > 0 ? 0 : "0 0 8px 8px", overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(" + stripDays.length + ", 1fr)", background: "rgba(74,85,104,0.06)" }}>
                {stripDays.map(wd => renderDayCell(wd))}
              </div>
            </div>

            {/* ── Expanded day rows (connected table style) ── */}
            {expandedStripData.length > 0 && (
              <div style={{ border: "1px solid rgba(74,85,104,0.18)", borderTop: "none", borderRadius: "0 0 8px 8px", overflow: "hidden", marginBottom: 0 }}>
                {expandedStripData.map((sd, sdIdx) => (
              <div key={sd.date} style={{ background: colors.cardBg, borderTop: sdIdx > 0 ? `1px solid ${colors.border}` : "none", padding: "14px 18px" }}
                onContextMenu={e => { e.preventDefault(); setCalEventForm({ startDate: sd.date, endDate: sd.date, type: "personal", title: "", startTime: "", endTime: "", schoolId: "", affectsClasses: "all", interruptionSubtype: "other", details: "", x: e.clientX, y: e.clientY }); }}>
                {/* Strip header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: sd.isTermBreak ? 8 : 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: colors.sidebarActive }}>{sd.day}</span>
                    <span style={{ fontSize: 13, color: colors.textLight }}>{sd.dayNum} {new Date(sd.date + "T00:00:00").toLocaleDateString("en-AU", { month: "short" })}</span>
                    {sd.date === todayStr && <span style={{ fontSize: 10, fontWeight: 700, background: colors.sidebarActive, color: "#fff", borderRadius: 10, padding: "2px 8px" }}>Today</span>}
                    {sd.isNextWeek && <span style={{ fontSize: 10, fontWeight: 700, background: colors.textMuted, color: "#fff", borderRadius: 10, padding: "2px 8px" }}>Next week</span>}
                    {!sd.isTermBreak && Array.isArray(dropdownWarningCounts[sd.date]) && dropdownWarningCounts[sd.date].length > 0 && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                        {dropdownWarningCounts[sd.date].map(entry => {
                          const chipKey = `${sd.date}|${entry.schoolId}`;
                          return (
                            <span key={entry.schoolId}
                              onMouseEnter={e => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                setWarningPopover({ chipKey, rect, lines: entry.lines });
                              }}
                              onMouseLeave={() => setWarningPopover(prev => (prev && prev.chipKey === chipKey ? null : prev))}
                              style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, fontWeight: 700, color: colors.danger, background: colors.redLight, border: `1px solid ${colors.danger}40`, borderRadius: 10, padding: "2px 8px" }}>
                              {entry.schoolCode} <AlertTriangle size={11} /> {entry.count}
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </div>
                  {!sd.isWeekendCatchup && (
                    <button onClick={e => { e.stopPropagation(); setExpandedDays(prev => { const next = new Set(prev); next.delete(sd.date); return next; }); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, lineHeight: 1, padding: "0 2px", display: "flex", alignItems: "center" }}><X size={14} /></button>
                  )}
                </div>

                {sd.isTermBreak ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ fontSize: 13, color: colors.warning, fontWeight: 600 }}>School Holidays</div>
                    {(() => {
                      const sdDate = new Date(sd.date + "T00:00:00");
                      const sdDow = sdDate.getDay();
                      const sdMon = new Date(sdDate); sdMon.setDate(sdDate.getDate() - (sdDow === 0 ? 6 : sdDow - 1));
                      const sdMonStr = toLocalDateStr(sdMon);
                      const cs = (catchups || []).filter(c => c.weekKey === sdMonStr && c.day === sd.day);
                      if (cs.length === 0) return null;
                      const byTeacher = {};
                      for (const c of cs) {
                        const enrol = enrolments.find(e => e.id === c.enrolmentId);
                        // Session 3 / C7 — catchup teacher derives from MTT placement, not enrolment stamp.
                        const mtt = enrol ? getStudentMTTTeacher(enrol.studentId, enrol.instrument, timetable, students, teachers, enrolments, teacherCoverage) : null;
                        const tid = mtt?.teacherId || "";
                        const studentName = students.find(s => s.id === enrol?.studentId)?.name || "";
                        if (!byTeacher[tid]) byTeacher[tid] = { lessons: [] };
                        byTeacher[tid].lessons.push({ ...c, _studentName: studentName });
                      }
                      return (
                        <div>
                          <div style={sectionLabel}>Catch-up Lessons</div>
                          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                            {Object.entries(byTeacher).map(([tid, { lessons: tCatchups }]) => {
                              const sorted = tCatchups.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
                              const first = sorted[0];
                              const lastTime = sorted[sorted.length - 1].time || "";
                              const [lh, lm] = lastTime.split(":").map(Number);
                              const endMin = lh * 60 + lm + 30;
                              const endStr = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
                              const teacher = teachers.find(tc => tc.id === tid);
                              const displayName = teacher?.name || "Teacher";
                              return (
                                <div key={tid} style={{ padding: "8px 14px", background: `${teacherColorMap[tid] || colors.accent}12`, borderRadius: 8, border: `1px solid ${teacherColorMap[tid] || colors.accent}30`, fontSize: 12, minWidth: 160 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                                    <span style={{ fontWeight: 700, color: "#fff", background: teacherColorMap[tid] || colors.accent, borderRadius: 3, padding: "1px 5px", fontSize: 11 }}>{displayName.split(" ")[0]}</span>
                                    <span style={{ fontSize: 11, color: colors.textMuted }}>{toTimeLabel(first.time)}–{toTimeLabel(endStr)}</span>
                                    <span style={{ fontSize: 11, fontWeight: 600, color: colors.text }}>({sorted.length})</span>
                                  </div>
                                  {sorted.map(c => (
                                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, fontSize: 11 }}>
                                      <span style={{ color: colors.textMuted, fontWeight: 600, flexShrink: 0 }}>{toTimeLabel(c.time)}</span>
                                      <span style={{ color: colors.text }}>{c._studentName}</span>
                                      {c.instrument && <span style={{ color: colors.textMuted }}>· {c.instrument}</span>}
                                    </div>
                                  ))}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

                    {/* Calendar events */}
                    {sd.dayEvents.length > 0 && (
                      <div>
                        <div style={sectionLabel}>Events</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                          {sd.dayEvents.map(ev => {
                            const isTE = ev.type === "teacher_event";
                            const tm = EVENT_TYPE_META[ev.type] || EVENT_TYPE_META.personal;
                            const teBg = isTE ? (ev.teacher_color || tm.bg) : tm.bg;
                            const teBd = isTE ? (ev.teacher_color || tm.border) : tm.border;
                            const teFg = isTE ? "#fff" : tm.text;
                            const teLabel = isTE ? `${ev.teacher_name || "Staff"} Event` : tm.label;
                            return (
                              <div key={ev.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: teBg, borderRadius: 7, border: `1px solid ${teBd}40` }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: teFg, background: isTE ? "rgba(255,255,255,0.25)" : `${tm.border}22`, padding: "1px 6px", borderRadius: 4, flexShrink: 0 }}>{teLabel}</span>
                                {(ev.startTime || ev.time) && <span style={{ fontSize: 11, color: teFg, fontWeight: 600, flexShrink: 0 }}>{ev.startTime || ev.time}{ev.endTime ? `–${ev.endTime}` : ""}</span>}
                                <span style={{ fontSize: 13, color: teFg, fontWeight: 600, flex: 1 }}>{ev.title}</span>
                                {ev.details && <span style={{ fontSize: 11, color: teFg, opacity: 0.7, flex: 1 }}>{ev.details}</span>}
                                {!isTE && <>
                                <button onClick={e => { e.stopPropagation(); setCalEventForm({ id: ev.id, sourceStore: "calendar", type: ev.type || "personal", title: ev.title, startDate: ev.startDate || ev.date, endDate: ev.endDate || ev.startDate || ev.date, startTime: ev.startTime || ev.time || "", endTime: ev.endTime || "", schoolId: ev.schoolId || "", affectsClasses: ev.affectsClasses || "all", interruptionSubtype: ev.interruptionSubtype || "other", details: ev.details || "", x: null, y: null }); }}
                                  style={{ background: "none", border: "none", cursor: "pointer", color: teFg, opacity: 0.5, padding: "0 2px", flexShrink: 0, display: "flex", alignItems: "center" }} title="Edit"><Pencil size={12} /></button>
                                <button onClick={e => { e.stopPropagation(); saveCalendarEvents(calendarEvents.filter(ce => ce.id !== ev.id)); }}
                                  style={{ background: "none", border: "none", cursor: "pointer", color: teFg, opacity: 0.5, padding: 0, flexShrink: 0, display: "flex", alignItems: "center" }} title="Delete"><X size={12} /></button>
                                </>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Interruptions */}
                    {sd.dayInterrupts.length > 0 && (
                      <div>
                        <div style={sectionLabel}>Interruptions</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                          {sd.dayInterrupts.map((intr, i) => {
                            const tm = EVENT_TYPE_META.interruption;
                            const isCalSource = intr.source === "calendar";
                            return (
                              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: tm.bg, borderRadius: 7, border: `1px solid ${tm.border}40` }}>
                                <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
                                  <span onClick={() => onNavigate("interruptions")} style={linkStyle}>{intr.title}</span>
                                  {intr.affectsClasses && intr.affectsClasses !== "all" && (
                                    <span style={{ fontSize: 11, color: tm.text, fontWeight: 400, marginLeft: 6 }}>({intr.affectsClasses})</span>
                                  )}
                                  {intr.schoolId && (
                                    <span style={{ fontSize: 11, color: tm.text, opacity: 0.6, marginLeft: 6 }}>{schools.find(s => s.id === intr.schoolId)?.name || ""}</span>
                                  )}
                                </span>
                                {isCalSource && (
                                  <button onClick={e => { e.stopPropagation(); setCalEventForm({ id: intr.id, sourceStore: "interruptions", type: INTR_DISPLAY_TYPE[intr.type] || "interruption", title: intr.title, startDate: intr.date, endDate: intr.endDate || intr.date, startTime: intr.startTime || "", endTime: intr.endTime || "", schoolId: intr.schoolId || "", affectsClasses: intr.affectsClasses || "all", interruptionSubtype: intr.type || "other", details: intr.notes || "", x: null, y: null }); }}
                                    style={{ background: "none", border: "none", cursor: "pointer", color: tm.text, opacity: 0.5, padding: "0 2px", flexShrink: 0, display: "flex", alignItems: "center" }} title="Edit"><Pencil size={12} /></button>
                                )}
                                {isCalSource && (
                                  <button onClick={e => { e.stopPropagation(); setInterruptions(prev => prev.filter(ii => ii.id !== intr.id)); }}
                                    style={{ background: "none", border: "none", cursor: "pointer", color: tm.text, opacity: 0.5, padding: 0, flexShrink: 0, display: "flex", alignItems: "center" }} title="Delete"><X size={12} /></button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Bands — visually distinct row above the per-school schedule (WTT-only) */}
                    {sd.bandEntries && sd.bandEntries.length > 0 && (
                      <div>
                        <div style={sectionLabel}>Bands</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {sd.bandEntries.map((gb, gi) => {
                            const l = gb.lesson;
                            const title = l.bandName || "Band";
                            const teacherName = getLiveTeacherName(l, students, teachers, enrolments, teacherCoverage, laneOverrides, gb.weekKey) || "";
                            const timeLabel = l.start ? toTimeLabel(l.start) : "";
                            return (
                              <div key={gi} style={{
                                padding: "6px 10px",
                                background: BAND_COLOR + "15",
                                border: `1px solid ${BAND_COLOR}40`,
                                borderLeft: `3px solid ${BAND_COLOR}`,
                                borderRadius: 7,
                                fontSize: 12,
                                minWidth: 140,
                                display: "flex",
                                flexDirection: "column",
                                gap: 2,
                              }}>
                                <div style={{ fontWeight: 600, color: BAND_COLOR, display: "flex", alignItems: "center", gap: 5 }}>
                                  <Guitar size={12} />
                                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
                                </div>
                                <div style={{ fontSize: 10, color: colors.textMuted, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                  {timeLabel && <span>{timeLabel}</span>}
                                  {teacherName && <span>{teacherName.split(" ")[0]}</span>}
                                  <span style={{ opacity: 0.7 }}>{gb.school.name}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Teacher/school schedule */}
                    {sd.schoolGroups.length === 0 ? (
                      <div style={{ fontSize: 13, color: colors.textLight, fontStyle: "italic" }}>No lessons scheduled</div>
                    ) : (
                      <div>
                        <div style={sectionLabel}>Schedule</div>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          {sd.schoolGroups.map(gs => {
                            const isPlanned = !sd.weeklyStatus[gs.school.id];
                            return (
                            <div key={gs.school.id}
                              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setCalEventForm({ startDate: sd.date, endDate: sd.date, type: "interruption", title: "", startTime: "", endTime: "", schoolId: gs.school.id, affectsClasses: "all", interruptionSubtype: "other", details: "", x: e.clientX, y: e.clientY }); }}
                              style={{ padding: "8px 14px", background: gs.school.color ? `${gs.school.color}12` : colors.bg, borderRadius: 8, border: `1px solid ${gs.school.color ? `${gs.school.color}30` : colors.border}`, fontSize: 12, minWidth: 160, cursor: "context-menu", opacity: isPlanned ? 0.55 : 1, fontStyle: isPlanned ? "italic" : "normal" }}>
                              <div
                                onClick={(e) => { e.stopPropagation(); onJumpToWeekly && onJumpToWeekly(gs.school, calendarWeekOffset + (sd.isNextWeek ? 1 : 0)); }}
                                title={`Open ${gs.school.name} in the Weekly Timetable for this week`}
                                style={{ fontWeight: 600, marginBottom: 6, color: gs.school.color || colors.text, display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                                <Building2 size={13} /> {gs.school.name}
                                {isPlanned && <span style={{ fontSize: 10, fontWeight: 500, color: colors.textMuted, fontStyle: "italic" }}>(planned)</span>}
                              </div>
                              {gs.subs && gs.subs.length > 0 && (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                                  {gs.subs.map(({ coverTeacher, defaultTeacher }, si) => (
                                    <span key={si} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10 }}>
                                      <span style={{ fontWeight: 700, color: "#fff", background: teacherColorMap[coverTeacher.id] || colors.accent, borderRadius: 3, padding: "1px 4px" }}>
                                        {coverTeacher.name.split(" ").map(w => w[0]).join("")}
                                      </span>
                                      <span style={{ color: colors.textMuted, fontWeight: 600 }}>←</span>
                                      <span style={{ fontWeight: 700, color: "#fff", background: teacherColorMap[defaultTeacher.id] || colors.accent, borderRadius: 3, padding: "1px 4px", opacity: 0.7 }}>
                                        {defaultTeacher.name.split(" ").map(w => w[0]).join("")}
                                      </span>
                                    </span>
                                  ))}
                                </div>
                              )}
                              {gs.teachers.map(t => (
                                <div key={t.teacher.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: teacherColorMap[t.teacher.id], borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>
                                    {t.teacher.name.split(" ")[0]}
                                  </span>
                                  {t.firstLesson && t.lastLesson && (
                                    <span style={{ fontSize: 11, color: colors.textMuted }}>{toTimeLabel(t.firstLesson.start)}–{toTimeLabel(t.lastLesson.end)}</span>
                                  )}
                                  {t.lessonCount > 0 && (
                                    <span style={{ fontSize: 11, fontWeight: 600, color: colors.text }}>({t.lessonCount})</span>
                                  )}
                                </div>
                              ))}
                              <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${colors.borderLight}` }}>
                                {sd.weeklyStatus[gs.school.id] ? (
                                  <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 500 }}>
                                    Weekly: ✓ generated
                                  </span>
                                ) : (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); onImportFromMtt && onImportFromMtt(gs.school, calendarWeekOffset + (sd.isNextWeek ? 1 : 0)); }}
                                    style={{ fontSize: 11, fontWeight: 600, color: colors.accentDark, background: "transparent", border: `1px solid ${colors.accentDark}40`, borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}
                                    title={`Import ${gs.school.name} lessons from the Master Timetable for this week`}>
                                    Import from MTT
                                  </button>
                                )}
                              </div>
                            </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Pending / trial students at schools on this day */}
                    {sd.pendingTrialOnDay.length > 0 && (
                      <div>
                        <div style={sectionLabel}>Pending & Trial</div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {sd.pendingTrialOnDay.map(s => {
                            const sc = schools.find(sc2 => sc2.id === s.schoolId);
                            const scColor = sc?.color || colors.sidebarActive;
                            return (
                              <span key={s.id} onClick={() => onNavigate("pending")}
                                style={{ fontSize: 11, fontWeight: 600, color: scColor, background: `${scColor}18`, padding: "3px 10px", borderRadius: 10, cursor: "pointer", border: `1px solid ${scColor}40` }}>
                                {s.name} <span style={{ opacity: 0.6, fontWeight: 400 }}>({s.status})</span>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    )}

                  </div>
                )}
              </div>
            ))}
              </div>
            )}

            {/* ── Term progress bar ── */}
            {(() => {
              const termBreaksForDash = interruptions.filter(i => i.type === "term_break");
              const currentLabel = getTermWeekLabel(effectiveTodayStr, termBreaksForDash);
              const currentWeekNum = parseInt((currentLabel.match(/\d+/) || ["1"])[0], 10);
              let termStart = null, termEnd = null;
              const sorted = [...termBreaksForDash].sort((a, b) => a.date.localeCompare(b.date));
              for (const tb of sorted) {
                const tbEnd = new Date((tb.endDate || tb.date) + "T00:00:00");
                if (tbEnd < today) {
                  const ts = new Date(tbEnd); ts.setDate(ts.getDate() + 1); termStart = ts;
                } else if (!termEnd) {
                  termEnd = new Date(tb.date + "T00:00:00");
                }
              }
              if (!termStart) { const y = today.getFullYear(); const s = new Date(y, 0, 27); while (s.getDay() !== 2) s.setDate(s.getDate() + 1); termStart = s; }
              let totalWeeks = currentWeekNum;
              if (termEnd) {
                const lastSchoolDay = new Date(termEnd); lastSchoolDay.setDate(lastSchoolDay.getDate() - 1);
                const lastLabel = getTermWeekLabel(toLocalDateStr(lastSchoolDay), termBreaksForDash);
                const lastNum = parseInt((lastLabel.match(/\d+/) || ["0"])[0], 10);
                if (lastNum > 0) totalWeeks = lastNum;
              }
              const progress = totalWeeks > 0 ? Math.min(1, (currentWeekNum - 0.5) / totalWeeks) : 0;
              return (
                <div style={{ marginTop: expandedStripData.length > 0 ? 6 : 0, marginBottom: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: "0.06em" }}>Term Progress</span>
                    <span style={{ fontSize: 12, color: colors.textMuted }}>{currentLabel}{totalWeeks > currentWeekNum ? " of " + totalWeeks : ""}</span>
                  </div>
                  <div style={{ height: 7, background: colors.borderLight, borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: (progress * 100) + "%", background: colors.sidebarActive, borderRadius: 4, transition: "width 0.4s ease" }} />
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })()}

      {/* ── Emails / To Do / Alerts — unified banner card ── */}
      {(() => {
        // Alerts data
        const unassignedStudents = students.filter(s => s.status === "active" && studentHasUnplacedEnrolment(s));
        // Unassigned group students — active/pending/trial students with a group instrument not yet placed in any group
        const assignedGroupStudentIds = new Set((groups || []).flatMap(g => (g.studentIds || [])));
        const unassignedGroupStudents = students.filter(s => ["active", "pending", "trial"].includes(s.status) && instrumentsFromEnrolments(s.id, enrolments).some(i => i.isGroup) && !assignedGroupStudentIds.has(s.id));
        const unassignedGroupCount = unassignedGroupStudents.length;
        const unschedEntries = timetable ? timetable.unscheduled.filter(u => u.reason !== "Unassigned" && !archivedStudentIds.has(u.student?.id)) : [];
        // Incomplete student profiles — missing school, class, or parent contact
        const incompleteStudents = students.filter(s => {
          if (s.status !== "active" && s.status !== "pending") return false;
          const isPrivate = s.schoolId === "__private__";
          const hasParent = (s.parents || []).some(p => (p.email || "").trim() || (p.phone || "").trim());
          if (isPrivate) return !hasParent; // private students only need a parent contact
          const hasSchool = !!s.schoolId;
          const rawClass = (s.className || "").trim().toLowerCase();
          const hasClass = !!rawClass && !/^class\s*(times?|info|information|schedule|details?)?$/i.test(rawClass);
          return !hasSchool || !hasClass || !hasParent;
        });
        // Response required — tiered by age: red (2+ days), yellow (1 day), blue (today)
        const emailAgeMs = (e) => e.internalDate || (e.date ? new Date(e.date).getTime() : 0);
        const startOfToday = new Date(todayStr + "T00:00:00").getTime();
        const startOfYesterday = startOfToday - 86400000;
        const allResponseRequired = inboxEmails.filter(e => {
          if (emailNoReplyOverrides.has(e.id)) return false;
          const cacheKey = `${e.threadId || e.id}-${e.id}`;
          const cached = emailSummaries[cacheKey];
          if (!(typeof cached === "object" ? !!cached?.needsReply : false)) return false;
          // Exclude emails already replied to
          const msgs = e.threadMessages || [];
          if (msgs.some(m => m.isSent)) return false;
          if (sentEmails.length > 0) {
            const tid = e.threadId || e.id;
            const normSubject = (e.subject || "").replace(/^(re|fwd?):\s*/gi, "").trim().toLowerCase();
            if (sentEmails.some(s => {
              if (s.threadId && s.threadId === e.threadId) return true;
              if (normSubject) { const sNorm = (s.subject || "").replace(/^(re|fwd?):\s*/gi, "").trim().toLowerCase(); if (sNorm === normSubject) return true; }
              return (s.threadId || s.id) === tid;
            })) return false;
          }
          return true;
        });
        const responseRequiredRed = allResponseRequired.filter(e => emailAgeMs(e) < startOfYesterday);
        const responseRequiredYellow = allResponseRequired.filter(e => emailAgeMs(e) >= startOfYesterday && emailAgeMs(e) < startOfToday);
        const responseRequiredBlue = allResponseRequired.filter(e => emailAgeMs(e) >= startOfToday);
        const pendingOnly = students.filter(s => s.status === "pending").reduce((sum, s) => sum + Math.max(1, instrumentsFromEnrolments(s.id, enrolments).filter(i => !i.isGroup).length), 0);
        const trialOnly = students.filter(s => s.status === "trial").reduce((sum, s) => sum + Math.max(1, instrumentsFromEnrolments(s.id, enrolments).filter(i => !i.isGroup).length), 0);
        // Interruptions: today through next 14 days
        const alertIntrEnd = toLocalDateStr((() => { const d = new Date(monday); d.setDate(d.getDate() + 14); return d; })());
        const upcomingInterruptions = interruptions.filter(i => i.type !== "term_break" && i.date >= todayStr && i.date <= alertIntrEnd);
        // Missed lessons: split this week (red) vs prior weeks (coral)
        const currentWeekKey = toLocalDateStr(monday);
        const nextWeekKey = toLocalDateStr((() => { const d = new Date(monday); d.setDate(d.getDate() + 7); return d; })());
        const missedThisWeek = (() => {
          const byStudent = {};
          for (const e of getMissedEntries({ weeklyTimetables, weekKey: currentWeekKey })) {
            const k = `${e.studentId}|${e.instrument}`;
            if (!byStudent[k]) byStudent[k] = { studentId: e.studentId, studentName: e.studentName, instrument: e.instrument, schoolId: e.schoolId || "", count: 0 };
            byStudent[k].count++;
          }
          return Object.values(byStudent);
        })();
        const missedPriorSorted = (() => {
          // Canonical iterator aligned with TallyView's stats.makeupOwed
          // (term scope, school filter "all", __private__ exclusion,
          // pending/trial exclusion, archived-overlap, enrolment-join).
          // Current week is INCLUDED — matches the tally summary card,
          // which counts all term-week owed catchups including the
          // current week.
          const byKey = {};
          for (const r of getOpenCatchupRows({ weeklyTimetables, enrolments, students, timetable, termWeeks, schoolFilter: "all", catchups })) {
            const e = r.missed;
            const k = `${e.studentId}|${e.instrument}`;
            if (!byKey[k]) {
              const st = students.find(s => s.id === e.studentId);
              byKey[k] = { studentId: e.studentId, studentName: e.studentName, instrument: e.instrument, schoolId: st?.schoolId || e.schoolId || "", count: 0 };
            }
            byKey[k].count++;
          }
          return Object.values(byKey).sort((a, b) => b.count - a.count);
        })();
        // Catch-ups: total lessons owed, tooltip grouped by student name
        const catchupTotal = missedPriorSorted.reduce((sum, m) => sum + m.count, 0);
        const catchupByStudent = {};
        for (const m of missedPriorSorted) {
          catchupByStudent[m.studentName] = (catchupByStudent[m.studentName] || 0) + m.count;
        }
        const catchupTooltipLines = Object.entries(catchupByStudent)
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => `${name} — ${count} owed`);
        // Lesson-change emails: inbox emails from known parents that mention schedule/time keywords
        const lessonChangeKeywords = ["reschedul", "change", "swap", "move", "different time", "different day", "can't make", "cannot make", "won't be", "will not be", "away", "absent", "cancel", "conflict", "clash"];
        const lessonChangeEmails = inboxEmails.filter(e => {
          const addr = (e.from?.match(/<(.+)>/)?.[1] || e.from || "").toLowerCase();
          const isParent = students.some(s => (s.parents || []).some(p => p.email?.toLowerCase() === addr));
          if (!isParent) return false;
          const text = ((e.subject || "") + " " + (e.snippet || "") + " " + (e.body || "")).toLowerCase();
          return lessonChangeKeywords.some(kw => text.includes(kw));
        });
        // Upcoming absences: informed_absence entries for NEXT week (alert fires the week before)
        const upcomingAbsences = (() => {
          // weekLabel is absent on WTT.missed; the || nextWeekKey fallback always resolves
          // to nextWeekKey post-migration (audit-acknowledged degradation).
          const byStudent = {};
          for (const e of getInformedAbsencesForWeek({ weeklyTimetables, weekKey: nextWeekKey })) {
            const k = `${e.studentId || e.studentName}|${e.instrument}`;
            if (!byStudent[k]) byStudent[k] = { studentId: e.studentId, studentName: e.studentName, instrument: e.instrument, weekLabel: e.weekLabel || nextWeekKey, count: 0 };
            byStudent[k].count++;
          }
          return Object.values(byStudent);
        })();
        // Reminder alerts — reminders whose event week fires an alert the week before
        const termBreaksForAlerts = interruptions.filter(i => i.type === "term_break").sort((a,b) => a.date.localeCompare(b.date));
        const currentTermWeekNum = computeTermWeekNum(currentWeekKey, termBreaksForAlerts);
        const upcomingReminderAlerts = currentTermWeekNum
          ? sortedReminders.filter(r => r.week && parseInt(r.week) - 1 === currentTermWeekNum)
          : [];
        const warningCount = (unassignedCount > 0 && !isAlertDismissed("alert-unassigned") ? 1 : 0) + (unschedCount > 0 && !isAlertDismissed("alert-unscheduled") ? 1 : 0) + (incompleteStudents.length > 0 && !isAlertDismissed("alert-incomplete") ? 1 : 0) + (missedThisWeek.length > 0 && !isAlertDismissed("alert-missed-week") ? 1 : 0) + (responseRequiredRed.length > 0 && !isAlertDismissed("alert-response-red") ? 1 : 0);
        const totalAlerts = warningCount
          + (responseRequiredYellow.length > 0 && !isAlertDismissed("alert-response-yellow") ? 1 : 0)
          + (responseRequiredBlue.length > 0 && !isAlertDismissed("alert-response-blue") ? 1 : 0)
          + (upcomingInterruptions.filter(i => !isAlertDismissed(`alert-interruption-${i.id}`)).length > 0 ? 1 : 0)
          + (catchupTotal > 0 && !isAlertDismissed("alert-catchup") ? 1 : 0)
          + (pendingOnly > 0 && !pendingDismissed ? 1 : 0)
          + (trialOnly > 0 && !trialDismissed ? 1 : 0)
          + (lessonChangeEmails.filter(em => !isLessonChangeDismissed(em.id)).length > 0 && !isAlertDismissed("alert-lesson-change") ? 1 : 0)
          + (upcomingAbsences.length > 0 && !isAlertDismissed("alert-upcoming-absences") ? 1 : 0)
          + (unassignedGroupCount > 0 && !isAlertDismissed("alert-unassigned-groups") ? 1 : 0)
          + (upcomingReminderAlerts.length > 0 && !isAlertDismissed("alert-reminder-upcoming") ? 1 : 0);
        // Teacher notes alert
        const newTeacherNotes = students.flatMap(s =>
          (s.teacher_notes || []).map(n => ({ ...n, studentId: s.id, studentName: s.name }))
        ).filter(n => !seenTeacherNoteIds.has(n.id));
        const hasNewTeacherNotes = newTeacherNotes.length > 0;
        // Staff document uploads
        const newStaffDocs = staffUploadedDocs.filter(d => !seenStaffDocIds.has(d.id));
        const hasNewStaffDocs = newStaffDocs.length > 0;
        // Invoice alerts — submitted invoices not yet seen
        const newInvoices = submittedInvoices.filter(inv => !seenInvoiceIds.has(inv.id));
        const hasNewInvoices = newInvoices.length > 0;
        // Classroom/specialist teacher email alerts
        const newTeacherEmailAlerts = Object.values(teacherEmailAlerts)
          .filter(a => a.type !== "other" && a.summary && !seenTeacherEmailAlertIds.has(a.emailId));
        const hasTeacherEmailAlerts = newTeacherEmailAlerts.length > 0;
        const totalAlertsWithTeacherNotes = totalAlerts + (hasNewTeacherNotes ? 1 : 0) + (hasNewStaffDocs ? 1 : 0) + (hasNewInvoices ? 1 : 0) + (hasTeacherEmailAlerts ? 1 : 0);

        const bothOpen = dashPanels.emails && dashPanels.todo;
        const anyPanelOpen = dashPanels.emails || dashPanels.todo || dashPanels.alerts;
        const togglePanel = (key) => saveDashPanels({ ...dashPanels, [key]: !dashPanels[key] });
        const dismissAllActive = () => {
          const keys = {};
          if (unassignedCount > 0) keys["alert-unassigned"] = true;
          if (unschedCount > 0) keys["alert-unscheduled"] = true;
          if (incompleteStudents.length > 0) keys["alert-incomplete"] = true;
          if (missedThisWeek.length > 0) keys["alert-missed-week"] = true;
          if (responseRequiredRed.length > 0) keys["alert-response-red"] = true;
          if (responseRequiredYellow.length > 0) keys["alert-response-yellow"] = true;
          if (responseRequiredBlue.length > 0) keys["alert-response-blue"] = true;
          upcomingInterruptions.forEach(intr => { keys[`alert-interruption-${intr.id}`] = true; });
          if (catchupTotal > 0) keys["alert-catchup"] = true;
          if (pendingOnly > 0) keys["alert-pending"] = true;
          if (trialOnly > 0) keys["alert-trial"] = true;
          if (lessonChangeEmails.length > 0) keys["alert-lesson-change"] = true;
          if (upcomingAbsences.length > 0) keys["alert-upcoming-absences"] = true;
          if (unassignedGroupCount > 0) keys["alert-unassigned-groups"] = true;
          if (upcomingReminderAlerts.length > 0) keys["alert-reminder-upcoming"] = true;
          const next = { date: todayStr, dismissed: { ...alertDismissals.dismissed, ...keys } };
          setAlertDismissals(next);
          try { localStorage.setItem(STORAGE_KEYS.alertDismissals, JSON.stringify(next)); } catch {}
          // Lesson-change emails live in their own persistent store (no midnight reset),
          // so route them through the dedicated bulk helper to preserve global Dismiss-all coverage.
          const visibleLessonChangeIds = lessonChangeEmails.filter(em => !isLessonChangeDismissed(em.id)).map(em => em.id);
          if (visibleLessonChangeIds.length > 0) dismissLessonChangesBulk(visibleLessonChangeIds);
        };

        const CATEGORY_FILTERS = [
          { key: "pinned", label: <Pin size={12} /> },
          { key: "parent", label: "Parents" },
          { key: "teacher", label: "Teachers" },
          { key: "staff", label: "Staff" },
          { key: "admin", label: "Admin" },
          { key: "enquiry", label: "Enquiries" },
          { key: "other", label: "Other" },
        ];
        const SCHOOL_FILTERS = schools.map(s => ({ key: `school:${s.id}`, label: s.name.split(" ").filter(w => /^[A-Z]/.test(w)).map(w => w[0]).join("").toUpperCase() || s.name.slice(0, 4).toUpperCase(), color: s.color || null }));

        // Email address autocomplete suggestions — drawn from parents, contacts, teachers
        const emailSuggestions = (() => {
          const q = emailSearch.toLowerCase().trim();
          if (!q) return [];
          const seen = new Set();
          const results = [];
          const add = (name, email) => {
            if (!email) return;
            const ek = email.toLowerCase();
            if (seen.has(ek)) return;
            if (!name.toLowerCase().includes(q) && !ek.includes(q)) return;
            seen.add(ek);
            results.push({ name, email });
          };
          for (const s of students) for (const p of (s.parents || [])) add(p.name || "", p.email || "");
          for (const c of contacts) add(c.name || "", c.email || "");
          for (const t of teachers) add(t.name || "", t.email || "");
          return results.slice(0, 8);
        })();

        const filteredEmails = (() => {
          // Always start with local emails — substring filter works on partial names (e.g. "karm" → "Karmen")
          let sorted = emailFolder === "sent" ? [...sentEmails] : [...inboxEmails];
          if (emailSearch.trim()) {
            const q = emailSearch.toLowerCase();
            const matchEmail = e => {
              const fromName = (e.from || "").toLowerCase();
              const toName = (e.to || "").toLowerCase();
              const subj = (e.subject || "").toLowerCase();
              const body = (e.snippet || e.body || "").toLowerCase();
              return fromName.includes(q) || toName.includes(q) || subj.includes(q) || body.includes(q);
            };
            sorted = sorted.filter(matchEmail);
            // For inbox, also surface threads where a sent message matches the query
            if (emailFolder === "inbox" && sentEmails.length > 0) {
              const matchedThreadIds = new Set(
                sentEmails.filter(matchEmail).map(s => s.threadId || s.id).filter(Boolean)
              );
              if (matchedThreadIds.size > 0) {
                const extraIds = new Set(sorted.map(e => e.id));
                const extras = [...inboxEmails].filter(e =>
                  matchedThreadIds.has(e.threadId || e.id) && !extraIds.has(e.id)
                );
                sorted = [...sorted, ...extras];
              }
            }
            // Merge in full-history Gmail search results — surfaces older emails not in local 50
            // Gmail uses whole-word matching so this complements (not replaces) the substring filter
            if (gmailSearchResults !== null && gmailSearchResults.length > 0) {
              const localIds = new Set(sorted.map(e => e.threadId || e.id));
              const extras = gmailSearchResults.filter(e => !localIds.has(e.threadId) && !localIds.has(e.id));
              sorted = [...sorted, ...extras];
            }
          }
          sorted.sort((a, b) => {
            const da = a.internalDate || (a.date ? new Date(a.date).getTime() : 0);
            const db = b.internalDate || (b.date ? new Date(b.date).getTime() : 0);
            return db - da;
          });
          // Category + school filters apply to both inbox and sent
          if (emailCategoryFilter.size > 0) {
            sorted = sorted.filter(e => {
              const cat = emailFolder === "sent" ? classifySentEmailFull(e) : classifyEmailFull(e);
              for (const f of emailCategoryFilter) {
                if (f === "pinned" && emailFolder !== "sent" && emailPinned.includes(e.id)) return true;
                if (f !== "pinned" && cat === f) return true;
              }
              return false;
            });
          }
          if (emailSchoolFilter.size > 0) {
            sorted = sorted.filter(e => {
              // For inbox: match sender; for sent: match recipients or the from-address being the school sender
              const fromAddr2 = (e.from?.match(/<(.+)>/)?.[1] || e.from || "").toLowerCase();
              const toAddrs = emailFolder === "sent"
                ? (e.to || "").split(",").map(a => { const m = a.match(/<(.+)>/); return (m ? m[1] : a).trim().toLowerCase(); }).filter(Boolean)
                : null;
              for (const f of emailSchoolFilter) {
                const schoolId = f.slice(7);
                const school = schools.find(s => s.id === schoolId);
                if (!school) continue;
                if (emailFolder === "sent") {
                  // Sent FROM the school's sender address (legacy: pre-DKIM-fix mail)
                  if (school.senderEmail && fromAddr2 === school.senderEmail.toLowerCase()) return true;
                  // DKIM fix: school identity now rides in Reply-To (From is the
                  // signed primary mailbox), so match the alias there too.
                  const replyToAddr2 = (e.replyTo?.match(/<(.+)>/)?.[1] || e.replyTo || "").toLowerCase();
                  if (school.senderEmail && replyToAddr2 === school.senderEmail.toLowerCase()) return true;
                  // Any recipient is a parent of a student at this school
                  if (students.some(s => s.schoolId === schoolId && (s.parents || []).some(p => p.email && toAddrs.includes(p.email.toLowerCase())))) return true;
                  // Any recipient is a school contact
                  if (contacts.some(c => c.schoolId === schoolId && c.email && toAddrs.includes(c.email.toLowerCase()))) return true;
                  // Any recipient is a teacher with an active lane at this school
                  if (teachers.some(t => t.email && toAddrs.includes(t.email.toLowerCase()) && teacherCoverage.some(l => l.teacherId === t.id && l.schoolId === schoolId && l.status === "active"))) return true;
                } else {
                  if (school.senderEmail) { const toAddr = `${e.deliveredTo || ""} ${e.to || ""} ${e.cc || ""}`.toLowerCase(); if (toAddr.includes(school.senderEmail.toLowerCase())) return true; }
                  if (students.some(s => s.schoolId === schoolId && (s.parents || []).some(p => p.email && p.email.toLowerCase() === fromAddr2))) return true;
                  if (contacts.some(c => c.schoolId === schoolId && c.email && c.email.toLowerCase() === fromAddr2)) return true;
                  if (teachers.some(t => t.email && t.email.toLowerCase() === fromAddr2 && teacherCoverage.some(l => l.teacherId === t.id && l.schoolId === schoolId && l.status === "active"))) return true;
                }
              }
              return false;
            });
          }
          return sorted;
        })();
        filteredEmailsRef.current = filteredEmails; // keep ref in sync for keyboard nav

        // Overdue level always returns 0 — age-based colouring removed (session 69)
        const todoOverdueLevel = (_item) => 0;

        const activeTodo = todoItems.filter(t => !t.done);
        const doneTodo = todoItems.filter(t => t.done);

        // Preview order during todo-to-todo drag — items shuffle as you hover
        const previewActiveTodo = (() => {
          const srcIdx = todoDragIdx;
          const hoverIdx = todoDragHoverItemId ? activeTodo.findIndex(t => t.id === todoDragHoverItemId) : -1;
          if (srcIdx === null || hoverIdx < 0 || hoverIdx === srcIdx) return activeTodo;
          const arr = [...activeTodo];
          const [moved] = arr.splice(srcIdx, 1);
          arr.splice(hoverIdx, 0, moved);
          return arr;
        })();
        const displayActiveTodo = todoFilterCategory.size > 0 ? previewActiveTodo.filter(t => (todoFilterCategory.has("__other__") && !t.category) || todoFilterCategory.has(t.category)) : previewActiveTodo;
        const displayDoneTodo = todoFilterCategory.size > 0 ? doneTodo.filter(t => (todoFilterCategory.has("__other__") && !t.category) || todoFilterCategory.has(t.category)) : doneTodo;

        // ungroupSub: pull a sub-item out of a group and prepend as standalone
        const ungroupSub = () => {
          const drag = todoSubDragRef.current;
          if (!drag) return false;
          todoSubDragRef.current = null;
          const { parentId, subId, subItem } = drag;
          const items = todoItemsRef.current;
          const parent = items.find(t => t.id === parentId);
          if (!parent) return false;
          const newSubItems = (parent.subItems || []).filter(s => s.id !== subId);
          const standalone = { id: uid(), text: subItem.text, done: false, tag: subItem.tag || parent.tag, emailId: subItem.emailId, meta: subItem.meta, createdAt: new Date().toISOString() };
          let updated;
          if (newSubItems.length === 0) {
            updated = items.filter(t => t.id !== parentId);
          } else if (newSubItems.length === 1) {
            updated = items.map(t => t.id === parentId ? { ...t, text: newSubItems[0].text, subItems: undefined, count: undefined } : t);
          } else {
            const newText = parent.text.replace(/\s*\+\d+$/, "") + ` +${newSubItems.length - 1}`;
            updated = items.map(t => t.id === parentId ? { ...t, text: newText, subItems: newSubItems, count: newSubItems.length } : t);
          }
          const active = updated.filter(t => !t.done);
          const done = updated.filter(t => t.done);
          saveTodo([standalone, ...active, ...done]);
          return true;
        };

        return (
          <>
            {bannerTip && (
              <div style={{ position: "fixed", zIndex: 9999, background: "rgba(30,30,30,0.93)", color: "#fff", fontSize: 12, padding: "8px 12px", borderRadius: 8, pointerEvents: "none", maxWidth: 260, lineHeight: 1.6, boxShadow: "0 4px 16px rgba(0,0,0,0.25)", left: bannerTip.x, top: bannerTip.y + 20 }}>
                {bannerTip.lines.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
            {/* Missed-this-week dropdown panel */}
            {/* Generic alert dropdown panel */}
            {alertDropdown && (() => {
              const { rect, title, borderColor, items, sections, headerAction } = alertDropdown;
              const removeDropdownItem = (idx, sectionIdx) => {
                setAlertDropdown(prev => {
                  if (!prev) return prev;
                  if (prev.sections) {
                    const newSections = prev.sections.map((s, si) => si === sectionIdx ? { ...s, items: s.items.filter((_, ii) => ii !== idx) } : s).filter(s => s.items.length > 0);
                    return newSections.length > 0 ? { ...prev, sections: newSections } : null;
                  }
                  const newItems = (prev.items || []).filter((_, ii) => ii !== idx);
                  return newItems.length > 0 ? { ...prev, items: newItems } : null;
                });
              };
              const renderItem = (item, i, sectionIdx) => {
                const isClickable = !!(item.composeData || item.navigateTo || item.openEmailId || item.navigateToStudent);
                return (
                  <div
                    key={i}
                    draggable={!!item.dragPayload}
                    onDragStart={item.dragPayload ? () => { clearTimeout(alertDropdownTimer.current); setAlertDragging(item.dragPayload); } : undefined}
                    onDragEnd={item.dragPayload ? () => { setAlertDragging(null); setAlertDropdown(null); } : undefined}
                    onClick={isClickable ? () => {
                      if (item.openEmailId) { openEmail(item.openEmailId); setAlertDropdown(null); }
                      else if (item.navigateToStudent) { if (onViewStudent) { onViewStudent(item.navigateToStudent); } else { onNavigate("students"); } setAlertDropdown(null); }
                      else if (item.composeData) { openCompose([item.composeData.addr], { subject: item.composeData.subject, triggerId: item.composeData.triggerId }); setAlertDropdown(null); }
                      else if (item.navigateTo) { onNavigate(item.navigateTo); setAlertDropdown(null); }
                    } : undefined}
                    onMouseEnter={isClickable ? e => { e.currentTarget.style.boxShadow = `0 0 0 1.5px ${item.chipColor || borderColor || colors.danger}`; } : undefined}
                    onMouseLeave={isClickable ? e => { e.currentTarget.style.boxShadow = "none"; } : undefined}
                    style={{ padding: "4px 10px", background: item.chipBg || (darkMode ? "rgba(196,84,84,0.18)" : "#FEF2F2"), border: `1px solid ${item.chipBorder || borderColor || colors.danger}`, borderRadius: 16, fontSize: 11, cursor: item.dragPayload ? "grab" : isClickable ? "pointer" : "default", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", userSelect: "none", width: "100%", boxSizing: "border-box" }}>
                    <span style={{ color: item.chipColor || colors.danger, fontWeight: 700, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{item.label}</span>
                    <span onClick={e => { e.stopPropagation(); if (item.onDismiss) item.onDismiss(); else if (item.dismissKey) dismissAlert(item.dismissKey); removeDropdownItem(i, sectionIdx); }}
                      style={{ color: item.chipColor || colors.danger, opacity: 0.4, lineHeight: 1, cursor: "pointer", display: "inline-flex", alignItems: "center", flexShrink: 0, marginLeft: "auto" }}
                      onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                      onMouseLeave={e => e.currentTarget.style.opacity = "0.4"}>
                      <X size={10} />
                    </span>
                  </div>
                );
              };
              return (
                <div
                  style={{ position: "absolute", left: alertDropdown.absLeft, top: (alertDropdown.absBottom || 0) + 6, zIndex: 49, background: colors.cardBg, border: `1.5px solid ${borderColor || colors.danger}`, borderRadius: 10, boxShadow: "0 4px 18px rgba(0,0,0,0.13)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, minWidth: 180, maxWidth: 400, maxHeight: "60vh", overflowY: "auto", scrollbarWidth: "thin" }}
                  onMouseEnter={() => clearTimeout(alertDropdownTimer.current)}
                  onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}>
                  {title && (
                    <div style={{ fontSize: 10, fontWeight: 700, color: colors.textMuted, marginBottom: 2, letterSpacing: "0.04em", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                      <span>{title}</span>
                      {headerAction && (
                        <span onClick={e => { e.stopPropagation(); headerAction.onClick(); }}
                          style={{ cursor: "pointer", color: colors.accentDark, textTransform: "none", letterSpacing: 0, fontSize: 10, fontWeight: 600, textDecoration: "underline" }}>
                          {headerAction.label}
                        </span>
                      )}
                    </div>
                  )}
                  {sections ? sections.map((section, si) => (
                    <div key={si} style={{ marginTop: si > 0 ? 8 : 0 }}>
                      {sections.length > 1 && section.headingDragPayload && (
                        <div
                          draggable
                          onDragStart={() => { clearTimeout(alertDropdownTimer.current); setAlertDragging(section.headingDragPayload); }}
                          onDragEnd={() => { setAlertDragging(null); setAlertDropdown(null); }}
                          onClick={section.headingComposeEmails?.length ? () => { openCompose(section.headingComposeEmails, { subject: "Catch-ups", triggerId: "alert_catchup", bccGroup: true }); setAlertDropdown(null); } : undefined}
                          style={{ padding: "4px 10px", background: section.headingColor ? `${section.headingColor}18` : colors.blueLight, border: `1px solid ${section.headingColor ? `${section.headingColor}60` : `${darkMode ? colors.blue600 : colors.sidebarActive}60`}`, borderRadius: 16, fontSize: 11, fontWeight: 700, cursor: section.headingComposeEmails?.length ? "pointer" : "grab", display: "inline-flex", alignItems: "center", color: section.headingColor || (darkMode ? colors.blue600 : colors.sidebarActive), userSelect: "none", marginBottom: 4 }}>
                          {section.heading.split(" ").filter(w => /^[A-Z]/.test(w)).map(w => w[0]).join("").toUpperCase() || section.heading.slice(0, 4).toUpperCase()}
                        </div>
                      )}
                      {sections.length > 1 && !section.headingDragPayload && (
                        <div style={{ fontSize: 9, fontWeight: 700, color: colors.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", paddingBottom: 2, borderBottom: `1px solid ${colors.borderLight}`, marginBottom: 4 }}>{section.heading}</div>
                      )}
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {section.items.map((item, ii) => renderItem(item, ii, si))}
                      </div>
                    </div>
                  )) : (items || []).map(renderItem)}
                </div>
              );
            })()}
            {/* Contact-all submenu for missed lesson To Do items */}
            {missedContactMenu && (() => {
              const { x, y, item } = missedContactMenu;
              const allEmails = (item.missedLessons || []).map(ml => ml.parentEmail).filter(Boolean);
              const perStudentItems = (item.missedLessons || []).map(ml => {
                const firstName = (ml.studentName || "").split(" ")[0];
                const lessonWord = ml.count === 1 ? "missed lesson" : `${ml.count} missed lessons`;
                const tmpl = getEmailTemplates().other || { subject: "Missed lesson", body: "" };
                const resolved = resolveTemplate(tmpl, { studentName: firstName, parentName: (ml.parentName || "").split(" ")[0] || "there", instrument: "" });
                return { to: [ml.parentEmail], subject: resolved.subject, body: resolved.body, triggerId: "todo_missed_lesson" };
              }).filter(p => p.to[0]);
              const btnStyle = { display: "block", width: "100%", padding: "8px 14px", background: "none", border: "none", textAlign: "left", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: colors.text, borderRadius: 6 };
              return (
                <div
                  style={{ position: "fixed", left: x, top: y, zIndex: 9995, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 9, boxShadow: "0 4px 18px rgba(0,0,0,0.14)", padding: "6px 4px", minWidth: 220 }}
                  onMouseDown={e => e.stopPropagation()}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: colors.textMuted, padding: "4px 12px 6px", letterSpacing: "0.04em" }}>CONTACT ALL PARENTS</div>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (allEmails.length) openCompose(allEmails, { triggerId: "todo_missed_group", bccGroup: true }); setMissedContactMenu(null); }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Mail size={13} /> Send as group (all in To)</span>
                  </button>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (perStudentItems.length) window._openComposeQueue && window._openComposeQueue(perStudentItems); setMissedContactMenu(null); }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Mail size={13} /> Send individually (preview each)</span>
                  </button>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => {
                      if (allEmails.length) { const richBatch = (item.missedLessons || []).filter(ml => ml.parentEmail).map(ml => ({ addr: ml.parentEmail, ctx: { parent_name: preferredFirstName(ml.parentName) || "", student_name: (ml.studentName || "").split(" ")[0], school_name: "" } })); window._openComposeModal && window._openComposeModal({ to: [], batchTo: richBatch, subject: "", body: "" }); }
                      setMissedContactMenu(null);
                    }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Zap size={13} /> Send individually (compose once → auto-send)</span>
                  </button>
                </div>
              );
            })()}
            {/* Contact-all submenu for catch-up To Do items */}
            {catchupContactMenu && (() => {              const { x, y, item } = catchupContactMenu;
              // Support both catchupStudents (group drag) and subItems (group lesson individual drag)
              const sourceStudents = item.catchupStudents ||
                (item.subItems || []).filter(s => s.parentEmail).map(s => ({ parentEmail: s.parentEmail, parentName: s.parentName, studentId: s.id }));
              const byParent = {};
              for (const s of sourceStudents) {
                const key = s.parentEmail || s.studentId;
                if (!byParent[key]) byParent[key] = { parentEmail: s.parentEmail, parentName: s.parentName };
              }
              const allEmails = Object.values(byParent).map(p => p.parentEmail).filter(Boolean);
              const perParentItems = Object.values(byParent).map(p => ({ to: [p.parentEmail], subject: "Catch-up lesson", triggerId: "todo_catchup" })).filter(p => p.to[0]);
              const btnStyle = { display: "block", width: "100%", padding: "8px 14px", background: "none", border: "none", textAlign: "left", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: colors.text, borderRadius: 6 };
              return (
                <div
                  style={{ position: "fixed", left: x, top: y, zIndex: 9995, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 9, boxShadow: "0 4px 18px rgba(0,0,0,0.14)", padding: "6px 4px", minWidth: 220 }}
                  onMouseDown={e => e.stopPropagation()}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: colors.textMuted, padding: "4px 12px 6px", letterSpacing: "0.04em" }}>CONTACT RE: CATCH-UPS</div>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (allEmails.length) openCompose(allEmails, { triggerId: "todo_catchup_group", bccGroup: true }); setCatchupContactMenu(null); }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Mail size={13} /> Send as group (all in To)</span>
                  </button>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (perParentItems.length) window._openComposeQueue && window._openComposeQueue(perParentItems); setCatchupContactMenu(null); }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Mail size={13} /> Send individually (preview each)</span>
                  </button>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => {
                      if (allEmails.length) { const richBatch = Object.values(byParent).filter(p => p.parentEmail).map(p => ({ addr: p.parentEmail, ctx: { parent_name: preferredFirstName(p.parentName) || "", student_name: "" } })); window._openComposeModal && window._openComposeModal({ to: [], batchTo: richBatch, subject: "Catch-up lesson", body: "" }); }
                      setCatchupContactMenu(null);
                    }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Zap size={13} /> Send individually (compose once → auto-send)</span>
                  </button>
                </div>
              );
            })()}
            {emailGroupContactMenu && (() => {
              const { x, y, item } = emailGroupContactMenu;
              const addrs = item.replyAddrs || (item.subItems || []).map(s => s.replyTo).filter(Boolean);
              // Resolve compose subject: prefer stored composeSubject, fall back to live inbox lookup
              const resolveSubject = (src) =>
                src?.composeSubject ??
                (src?.emailId ? reSubject(inboxEmails.find(e => e.id === src.emailId)?.subject || "") : "");
              const groupSubject = resolveSubject(item);
              const perItems = addrs.map(addr => {
                const sub = (item.subItems || []).find(s => s.replyTo === addr);
                return { to: [addr], subject: resolveSubject(sub) || groupSubject, triggerId: "todo_email_group", label: sub?.senderName || addr };
              }).filter(p => p.to[0]);
              const btnStyle = { display: "block", width: "100%", padding: "8px 14px", background: "none", border: "none", textAlign: "left", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: colors.text, borderRadius: 6 };
              return (
                <div style={{ position: "fixed", left: x, top: y, zIndex: 9995, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 9, boxShadow: "0 4px 18px rgba(0,0,0,0.14)", padding: "6px 4px", minWidth: 220 }}
                  onMouseDown={e => e.stopPropagation()}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: colors.textMuted, padding: "4px 12px 6px", letterSpacing: "0.04em" }}>CONTACT — {addrs.length} RECIPIENTS</div>
                  <button style={btnStyle} onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { openCompose(addrs, { subject: groupSubject, bccGroup: true }); setEmailGroupContactMenu(null); }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Mail size={13} /> Send as group (all in To)</span>
                  </button>
                  <button style={btnStyle} onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (perItems.length) window._openComposeQueue && window._openComposeQueue(perItems); setEmailGroupContactMenu(null); }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Mail size={13} /> Send individually (preview each)</span>
                  </button>
                  <button style={btnStyle} onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (perItems.length) { const richBatch = addrs.map(addr => { const sub = (item.subItems || []).find(s => s.replyTo === addr); return { addr, ctx: { parent_name: sub?.senderName || "", student_name: "" } }; }); window._openComposeModal && window._openComposeModal({ to: [], batchTo: richBatch, subject: groupSubject, body: "" }); } setEmailGroupContactMenu(null); }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Zap size={13} /> Send individually (compose once → auto-send)</span>
                  </button>
                </div>
              );
            })()}
            {emailGroupContactMenu && <div onClick={() => setEmailGroupContactMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 9994 }} />}
            {/* ── Unified banner: alerts card behind, pill floating, banner on top ── */}
            <div ref={bannerWrapperRef} style={{ position: "relative", marginBottom: 20 }}>
              <div style={{ position: "relative", overflow: "hidden", borderRadius: 12 }}>

              {/* Alerts card — 1.5× banner height, always behind (zIndex 0) */}
              {(() => {
                const bannerH = 42;
                const alertsH = Math.round(bannerH * 1.5); // 63px
                // Reusable dismiss button
                const DismissBtn = ({ groupType, color, onClick: customOnClick }) => (
                  <span
                    onClick={e => { e.stopPropagation(); customOnClick ? customOnClick() : dismissAlert(groupType); }}
                    style={{ marginLeft: 3, color: color || colors.danger, opacity: 0.45, fontSize: 13, lineHeight: 1, cursor: "pointer", padding: "0 1px", userSelect: "none", display: "inline-flex", alignItems: "center" }}
                    onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                    onMouseLeave={e => e.currentTarget.style.opacity = "0.45"}
                  ><X size={11} /></span>
                );
                return (
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: alertsH, zIndex: 0,
                    background: "rgba(196,84,84,0.08)", border: `2px solid ${colors.danger}`, borderRadius: 12 }}>
                    <div style={{ padding: `0 ${remindersBtnW + 30}px 0 ${pillW + 24}px`, display: "flex", gap: 10, flexWrap: "nowrap", alignItems: "center", height: 38, boxSizing: "border-box", overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none", msOverflowStyle: "none", position: "relative", top: -1, maskImage: `linear-gradient(to right, transparent ${pillW + 10}px, black ${pillW + 22}px, black calc(100% - ${remindersBtnW + 22}px), transparent calc(100% - ${remindersBtnW + 10}px))`, WebkitMaskImage: `linear-gradient(to right, transparent ${pillW + 10}px, black ${pillW + 22}px, black calc(100% - ${remindersBtnW + 22}px), transparent calc(100% - ${remindersBtnW + 10}px))` }}>
                      {/* Red — blockers + urgent */}
                      {unassignedCount > 0 && !isAlertDismissed("alert-unassigned") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Assign teachers to ${unassignedCount} student${unassignedCount !== 1 ? "s" : ""}`, tag: "admin", groupType: "alert-unassigned", adminItems: unassignedStudents.map(s => ({ text: `${s.name} — ${instrumentsFromEnrolments(s.id, enrolments).filter(i => !i.isGroup && !mttTeacherIdx.has(`${s.id}:${(i.name || "").trim().toLowerCase()}`)).map(i => i.name).join(", ")}` })) })} onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => { if (setStudentsViewState) setStudentsViewState(prev => ({ ...prev, filter: { ...prev.filter, hasWarning: "any" } })); onNavigate("students"); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "UNASSIGNED", borderColor: colors.danger, items: unassignedStudents.map(s => { const sc = schools.find(sc2 => sc2.id === s.schoolId); const scColor = sc?.color || colors.danger; const instrs = instrumentsFromEnrolments(s.id, enrolments).filter(i => !i.isGroup && !mttTeacherIdx.has(`${s.id}:${(i.name || "").trim().toLowerCase()}`)).map(i => i.name).join(", "); return { label: `${s.name} — ${instrs}`, chipColor: scColor, chipBg: `${scColor}18`, chipBorder: `${scColor}60`, navigateToStudent: s.id }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: darkMode ? "rgba(196,84,84,0.18)" : colors.redLight, border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.danger, fontWeight: 700 }}>{unassignedCount} unassigned</span>
                          <DismissBtn groupType="alert-unassigned" />
                        </div>
                      )}
                      {unassignedGroupCount > 0 && !isAlertDismissed("alert-unassigned-groups") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Place ${unassignedGroupCount} student${unassignedGroupCount !== 1 ? "s" : ""} in groups`, tag: "admin", groupType: "alert-unassigned-groups", adminItems: unassignedGroupStudents.map(s => ({ text: `${s.name} — ${instrumentsFromEnrolments(s.id, enrolments).filter(i => i.isGroup).map(i => i.name).join(", ")}` })) })} onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => { if (onViewGroups) onViewGroups(); else onNavigate("students"); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "NO GROUP ASSIGNED", borderColor: "#D97706", items: unassignedGroupStudents.map(s => { const sc = schools.find(sc2 => sc2.id === s.schoolId); const scColor = sc?.color || "#D97706"; const instrs = instrumentsFromEnrolments(s.id, enrolments).filter(i => i.isGroup).map(i => i.name).join(", "); return { label: `${s.name} — ${instrs}`, chipColor: scColor, chipBg: `${scColor}18`, chipBorder: `${scColor}60`, navigateToStudent: s.id }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: darkMode ? "rgba(217,119,6,0.15)" : "#FEF3C7", border: "1px solid #D97706", borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: "#D97706", fontWeight: 700 }}>{unassignedGroupCount} ungrouped</span>
                          <DismissBtn groupType="alert-unassigned-groups" color="#D97706" />
                        </div>
                      )}
                      {unschedCount > 0 && !isAlertDismissed("alert-unscheduled") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Schedule ${unschedCount} unscheduled student${unschedCount !== 1 ? "s" : ""} in timetable`, tag: "admin", groupType: "alert-unscheduled", adminItems: unschedEntries.map(u => ({ text: `${u.student.name} — ${u.instrument}${u.reason ? ` (${u.reason})` : ""}` })) })} onDragEnd={() => setAlertDragging(null)}
                          onClick={() => { const f = unschedEntries[0]; if (f && setSharedSchool) setSharedSchool(f.student.schoolId); onNavigate("timetable"); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "UNSCHEDULED", borderColor: colors.danger, items: unschedEntries.map(u => ({ label: `${u.student.name} — ${u.instrument}${u.reason ? ` (${u.reason})` : ""}`, chipColor: colors.danger, navigateToStudent: u.student.id })) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: darkMode ? "rgba(196,84,84,0.18)" : colors.redLight, border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.danger, fontWeight: 700 }}>{unschedCount} unscheduled</span>
                          <DismissBtn groupType="alert-unscheduled" />
                        </div>
                      )}
                      {incompleteStudents.length > 0 && !isAlertDismissed("alert-incomplete") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Complete profiles for ${incompleteStudents.length} student${incompleteStudents.length !== 1 ? "s" : ""}`, tag: "admin", groupType: "alert-incomplete", adminItems: incompleteStudents.map(s => { const missing = [!s.schoolId && "school", !s.className && "class", !(s.parents || []).some(p => p.email || p.phone) && "parent contact"].filter(Boolean).join(", "); return { text: `${s.name} — missing ${missing}` }; }) })} onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => onNavigate("students")}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "INCOMPLETE PROFILES", borderColor: colors.danger, items: incompleteStudents.map(s => { const sc = schools.find(sc2 => sc2.id === s.schoolId); const scColor = sc?.color || colors.danger; const missing = [!s.schoolId && "school", !s.className && "class", !(s.parents || []).some(p => p.email || p.phone) && "parent contact"].filter(Boolean).join(", "); return { label: `${s.name} — missing ${missing}`, chipColor: scColor, chipBg: `${scColor}18`, chipBorder: `${scColor}60`, navigateToStudent: s.id }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: darkMode ? "rgba(196,84,84,0.18)" : colors.redLight, border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.danger, fontWeight: 700 }}>{incompleteStudents.length} incomplete profile{incompleteStudents.length !== 1 ? "s" : ""}</span>
                          <DismissBtn groupType="alert-incomplete" />
                        </div>
                      )}
                      {/* v2.18.0 — uninvoiced students (current term). Consumes the
                          same shared derivation as the Invoicing banner. Per-row X
                          writes the term-scoped permanent dismissal key (lockstep
                          with the banner); the whole-chip DismissBtn is the standard
                          alertDismissals hide ONLY — deliberately does NOT batch-add
                          students to the permanent dismissal set (a money warning
                          should not be bulk-silenced). */}
                      {uninvoicedAlert.rows.length > 0 && !isAlertDismissed("alert-uninvoiced") && (
                        <div
                          onClick={() => onNavigate("invoicing")}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "UNINVOICED STUDENTS", borderColor: colors.danger, items: uninvoicedAlert.rows.map(row => ({ label: `${row.studentName} — ${row.parentName}${row.schoolAcronym ? ` (${row.schoolAcronym})` : ""}`, chipColor: colors.danger, navigateToStudent: row.studentId, onDismiss: () => dismissUninvoicedStudent(uninvoicedAlert.term.label, row.studentName) })) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: darkMode ? "rgba(196,84,84,0.18)" : colors.redLight, border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.danger, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><AlertTriangle size={11} /> {uninvoicedAlert.rows.length} uninvoiced student{uninvoicedAlert.rows.length !== 1 ? "s" : ""}</span>
                          <DismissBtn groupType="alert-uninvoiced" />
                        </div>
                      )}
                      {/* Response required — red (2+ days old) */}
                      {(() => { const visibleResponseRed = responseRequiredRed.filter(em => !isAlertDismissed(`alert-response-email-${em.id}`)); return visibleResponseRed.length > 0 && !isAlertDismissed("alert-response-red") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Reply to ${visibleResponseRed.length} overdue email${visibleResponseRed.length !== 1 ? "s" : ""} requiring response`, tag: "email", groupType: "alert-response-red", responseEmails: responseRequiredRed })} onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => { saveDashPanels({ ...dashPanels, emails: true }); setEmailCategoryFilter(new Set()); setEmailSchoolFilter(new Set()); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "RESPONSE OVERDUE", borderColor: colors.danger, items: responseRequiredRed.filter(em => !isAlertDismissed(`alert-response-email-${em.id}`)).slice(0, 8).map(em => { const n = em.from?.includes("<") ? em.from.split("<")[0].trim().replace(/^"|"$/g, "") : em.from || "Unknown"; const d = em.date ? new Date(em.date).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""; return { label: `${n} — ${d}`, chipColor: colors.danger, openEmailId: em.id, dismissKey: `alert-response-email-${em.id}`, onDismiss: () => { const next = new Set(emailNoReplyOverrides); next.add(em.id); setEmailNoReplyOverrides(next); try { localStorage.setItem(STORAGE_KEYS.emailNoReplyOverrides, JSON.stringify([...next])); } catch {} }, dragPayload: { text: `Reply to ${n} re: ${em.subject || "(no subject)"}`, tag: "email", groupType: `alert-response-email-${em.id}`, responseEmails: [em] } }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: darkMode ? "rgba(196,84,84,0.18)" : colors.redLight, border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.danger, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><Reply size={11} /> {visibleResponseRed.length} response overdue</span>
                          <DismissBtn groupType="alert-response-red" onClick={() => {
                            const next = new Set(emailNoReplyOverrides);
                            for (const em of responseRequiredRed) next.add(em.id);
                            setEmailNoReplyOverrides(next);
                            try { localStorage.setItem(STORAGE_KEYS.emailNoReplyOverrides, JSON.stringify([...next])); } catch {}
                            dismissAlert("alert-response-red");
                          }} />
                        </div>
                      ); })()}
                      {missedThisWeek.length > 0 && !isAlertDismissed("alert-missed-week") && (() => {
                        const missedWithParents = missedThisWeek.map(m => {
                          const st = students.find(s => s.id === m.studentId);
                          const primaryParent = st?.parents?.[0];
                          return { ...m, parentName: primaryParent?.name || "", parentEmail: primaryParent?.email || "" };
                        });
                        return (
                          <div
                            draggable
                            onDragStart={() => { clearTimeout(alertDropdownTimer.current); setAlertDragging({ text: "Contact all re: missed lessons", tag: "lesson", groupType: "alert-missed-week", missedLessons: missedWithParents }); }}
                            onDragEnd={() => { setAlertDragging(null); setAlertDropdown(null); }}
                            onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "MISSED THIS WEEK", borderColor: colors.danger, items: missedWithParents.map(m => { const sc = schools.find(s => s.id === m.schoolId); const scColor = sc?.color || colors.danger; return { label: `${m.studentName} — ${m.count}`, chipColor: scColor, chipBg: `${scColor}18`, chipBorder: scColor, ...(m.parentEmail ? { composeData: { addr: m.parentEmail, subject: `Re: ${m.studentName}'s lesson`, triggerId: "alert_missed" } } : {}), dragPayload: { text: `Contact ${(m.parentName || "parent").split(" ")[0]} re: ${(m.studentName || "").split(" ")[0]}'s ${m.count === 1 ? "missed lesson" : `${m.count} missed lessons`}`, tag: "lesson", groupType: `alert-missed-student-${m.studentId}`, missedLesson: m } }; }) }); }}
                            onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                            style={{ padding: "3px 10px", background: darkMode ? "rgba(196,84,84,0.18)" : colors.redLight, border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                            <span style={{ color: colors.danger, fontWeight: 700 }}>{missedThisWeek.length} missed this week</span>
                            <DismissBtn groupType="alert-missed-week" />
                        </div>
                        );
                      })()}
                      {/* Upcoming informed absences — fires the week before */}
                      {upcomingAbsences.length > 0 && !isAlertDismissed("alert-upcoming-absences") && (
                        <div
                          draggable
                          onDragStart={() => setAlertDragging({ text: `${upcomingAbsences.length} informed absence${upcomingAbsences.length !== 1 ? "s" : ""} next week`, tag: "lesson", groupType: "alert-upcoming-absences" })}
                          onDragEnd={() => { setAlertDragging(null); setAlertDropdown(null); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "ABSENCES NEXT WEEK", borderColor: colors.purple700, items: upcomingAbsences.map(m => ({ label: `${m.studentName}${m.instrument ? ` — ${m.instrument}` : ""}`, chipColor: colors.purple700, chipBg: colors.purpleLight, chipBorder: `${colors.purple700}40`, navigateTo: "calendar", dragPayload: { text: `${m.studentName} away — ${m.weekLabel}`, tag: "lesson", groupType: `alert-upcoming-absence-${m.studentId}` } })) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          onClick={() => onNavigate("tally")}
                          style={{ padding: "3px 10px", background: darkMode ? "rgba(124,58,237,0.15)" : colors.purpleLight, border: `1px solid ${colors.purple700}40`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.purple700, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><CalendarCheck size={11} /> {upcomingAbsences.length} away next week</span>
                          <DismissBtn groupType="alert-upcoming-absences" color={colors.purple700} />
                        </div>
                      )}
                      {upcomingReminderAlerts.length > 0 && !isAlertDismissed("alert-reminder-upcoming") && (
                        <div
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "REMINDERS — NEXT WEEK", borderColor: "#D97706", items: upcomingReminderAlerts.map(rem => ({ label: rem.text + (rem.studentName ? ` — ${rem.studentName}` : ""), chipColor: "#D97706", chipBg: darkMode ? "rgba(217,119,6,0.15)" : "#FEF3C7", chipBorder: "#D97706" })) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: darkMode ? "rgba(217,119,6,0.15)" : "#FEF3C7", border: "1px solid #D97706", borderRadius: 20, fontSize: 11, cursor: "default", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: "#D97706", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><Bell size={11} /> {upcomingReminderAlerts.length === 1 ? upcomingReminderAlerts[0].text.slice(0, 40) + (upcomingReminderAlerts[0].text.length > 40 ? "…" : "") : `${upcomingReminderAlerts.length} reminders next week`}</span>
                          <DismissBtn groupType="alert-reminder-upcoming" color="#D97706" />
                        </div>
                      )}
                      {/* Yellow — response required yesterday */}
                      {(() => { const visibleResponseYellow = responseRequiredYellow.filter(em => !isAlertDismissed(`alert-response-email-${em.id}`)); return visibleResponseYellow.length > 0 && !isAlertDismissed("alert-response-yellow") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Reply to ${visibleResponseYellow.length} email${visibleResponseYellow.length !== 1 ? "s" : ""} awaiting response`, tag: "email", groupType: "alert-response-yellow", responseEmails: responseRequiredYellow })} onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => { saveDashPanels({ ...dashPanels, emails: true }); setEmailCategoryFilter(new Set()); setEmailSchoolFilter(new Set()); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "RESPONSE PENDING", borderColor: colors.accent, items: responseRequiredYellow.filter(em => !isAlertDismissed(`alert-response-email-${em.id}`)).slice(0, 8).map(em => { const n = em.from?.includes("<") ? em.from.split("<")[0].trim().replace(/^"|"$/g, "") : em.from || "Unknown"; const d = em.date ? new Date(em.date).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""; return { label: `${n} — ${d}`, chipColor: darkMode ? colors.accent : colors.accentDark, chipBg: darkMode ? "rgba(196,122,106,0.18)" : colors.redLight, chipBorder: colors.accent, openEmailId: em.id, dismissKey: `alert-response-email-${em.id}`, onDismiss: () => { const next = new Set(emailNoReplyOverrides); next.add(em.id); setEmailNoReplyOverrides(next); try { localStorage.setItem(STORAGE_KEYS.emailNoReplyOverrides, JSON.stringify([...next])); } catch {} }, dragPayload: { text: `Reply to ${n} re: ${em.subject || "(no subject)"}`, tag: "email", groupType: `alert-response-email-${em.id}`, responseEmails: [em] } }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: darkMode ? "rgba(196,122,106,0.18)" : colors.redLight, border: `1px solid ${colors.accent}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: darkMode ? colors.accent : colors.accentDark, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><Reply size={11} /> {visibleResponseYellow.length} response pending</span>
                          <DismissBtn groupType="alert-response-yellow" color={colors.accent} onClick={() => {
                            const next = new Set(emailNoReplyOverrides);
                            for (const em of responseRequiredYellow) next.add(em.id);
                            setEmailNoReplyOverrides(next);
                            try { localStorage.setItem(STORAGE_KEYS.emailNoReplyOverrides, JSON.stringify([...next])); } catch {}
                            dismissAlert("alert-response-yellow");
                          }} />
                        </div>
                      ); })()}
                      {/* Coral — catch-ups + interruptions */}
                      {catchupTotal > 0 && !isAlertDismissed("alert-catchup") && (() => {
                        const catchupStudents = missedPriorSorted.map(m => {
                          const st = students.find(s => s.id === m.studentId);
                          const primaryParent = st?.parents?.[0];
                          return { studentId: m.studentId, studentName: m.studentName, instrument: m.instrument || "", count: m.count, schoolId: st?.schoolId || m.schoolId || "", parentName: primaryParent?.name || "", parentEmail: primaryParent?.email || "" };
                        });
                        return (
                          <div draggable onDragStart={() => setAlertDragging({ text: `Arrange ${catchupTotal} catch-up${catchupTotal !== 1 ? "s" : ""} owed`, tag: "lesson", groupType: "alert-catchup", catchupStudents })} onDragEnd={() => setAlertDragging(null)}
                          onClick={() => onNavigate("weekly")}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); const bySchool = {}; for (const s of catchupStudents) { const school = schools.find(sc => sc.id === s.schoolId); const key = school?.name || "Other"; if (!bySchool[key]) bySchool[key] = { students: [], color: school?.color || null }; bySchool[key].students.push(s); } const sections = Object.entries(bySchool).map(([schoolName, { students: sts, color: schoolColor }]) => { const schoolStudents = sts; const allParentEmails = [...new Set(schoolStudents.filter(s => s.parentEmail).map(s => s.parentEmail))]; const schoolDragPayload = { text: `Arrange catch-ups — ${schoolName}`, tag: "lesson", groupType: `alert-catchup-school-${schoolName}`, catchupStudents: schoolStudents }; return { heading: schoolName, headingColor: schoolColor, headingDragPayload: schoolDragPayload, headingComposeEmails: allParentEmails, items: sts.map(s => { const sc = schools.find(sc2 => sc2.id === s.schoolId); const scColor = sc?.color || (darkMode ? colors.accent : colors.accentDark); return { label: `${s.studentName} — ${s.instrument || ""} (${s.count})`, chipColor: scColor, chipBg: darkMode ? `${scColor}22` : `${scColor}18`, chipBorder: scColor, ...(s.parentEmail ? { composeData: { addr: s.parentEmail, subject: "Catch-ups", triggerId: "alert_catchup" } } : {}), dragPayload: { text: `Contact ${preferredFirstName(s.parentName) || "parent"} re: ${preferredFirstName(s.studentName)}'s catch-up${s.count !== 1 ? "s" : ""}`, tag: "lesson", groupType: `alert-catchup-student-${s.studentId}-${s.instrument}`, catchupLesson: s } }; }) }; }); openAlertDropdown({ rect: r, anchor: "right", title: "CATCH-UPS OWED", borderColor: colors.accent, sections }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: darkMode ? "rgba(196,122,106,0.18)" : colors.redLight, border: `1px solid ${colors.accent}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.accentDark, fontWeight: 700 }}>{catchupTotal} catch-up{catchupTotal !== 1 ? "s" : ""} owed</span>
                          <DismissBtn groupType="alert-catchup" color={colors.accentDark} />
                        </div>
                        );
                      })()}
                      {(() => {
                        const visible = upcomingInterruptions.filter(i => !isAlertDismissed(`alert-interruption-${i.id}`));
                        if (visible.length === 0) return null;
                        // Curriculum-day discriminator covers both new entries
                        // (type "curriculum_day", per INTERRUPTION_SUBTYPES) and
                        // legacy free-text-title entries.
                        const isCurriculumDay = (i) => i.type !== "public_holiday" && (
                          i.type === "curriculum_day" ||
                          i.title?.trim().toLowerCase() === "curriculum day"
                        );
                        const curriculumDays = visible.filter(isCurriculumDay);
                        const remaining = visible.filter(i => !isCurriculumDay(i));
                        const publicHols = remaining.filter(i => i.type === "public_holiday");
                        const schoolEvents = remaining.filter(i => i.type !== "public_holiday");
                        // Group school events by schoolId
                        const bySchool = {};
                        schoolEvents.forEach(i => {
                          const key = i.schoolId || "unknown";
                          if (!bySchool[key]) bySchool[key] = [];
                          bySchool[key].push(i);
                        });
                        // Build drag payload for one interruption
                        const singleIntrPayload = (intr) => {
                          const affectedStudents = getInterruptionAffectedStudents(intr, students);
                          const school = schools.find(s => s.id === intr.schoolId);
                          const acronym = school ? getSchoolAcronym(school) : "";
                          const subItems = affectedStudents.map(st => ({
                            id: uid(), text: `Contact ${preferredFirstName(st.parentName) || "parent"} re: ${st.studentName.split(" ")[0]}'s ${intr.title}`,
                            done: false, tag: "lesson", parentEmail: st.parentEmail, parentName: st.parentName, studentName: st.studentName,
                          }));
                          const groupText = `Prepare for ${intr.title}${acronym ? ` — ${acronym}` : ""}`;
                          return { text: groupText, tag: "interruption", groupType: `alert-interruption-${intr.id}`, interruptionStudents: [{ intr, students: affectedStudents }], subItems };
                        };
                        // Build drag payload for multiple interruptions (school or holiday group)
                        const multiIntrPayload = (intrs, label) => {
                          const interruptionStudents = intrs.map(intr => ({ intr, students: getInterruptionAffectedStudents(intr, students) }));
                          const subItems = interruptionStudents.flatMap(({ intr, students: stus }) =>
                            stus.map(st => ({ id: uid(), text: `Contact ${preferredFirstName(st.parentName) || "parent"} re: ${st.studentName.split(" ")[0]}'s ${intr.title}`, done: false, tag: "lesson", parentEmail: st.parentEmail, parentName: st.parentName, studentName: st.studentName }))
                          );
                          return { text: `Prepare for ${intrs.length} interruptions${label ? ` — ${label}` : ""}`, tag: "interruption", groupType: `alert-interruption-group-${label}`, interruptionStudents, subItems };
                        };
                        const dateLabel = (intr) => {
                          const d = new Date(intr.date + "T00:00:00");
                          return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
                        };
                        const chipStyle = (bg, border, color) => ({ padding: "3px 10px", background: darkMode ? "rgba(196,84,84,0.18)" : bg, border: `1px solid ${border}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" });
                        const intrChipBg = darkMode ? "rgba(196,84,84,0.18)" : "#FEF2F2";
                        return (
                          <>
                            {/* Public holidays — single chip or grouped */}
                            {publicHols.length === 1 && (
                              <div draggable
                                onDragStart={() => setAlertDragging(singleIntrPayload(publicHols[0]))}
                                onDragEnd={() => { setAlertDragging(null); }}
                                style={chipStyle(intrChipBg, colors.danger, colors.danger)}>
                                <span style={{ color: colors.danger, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><CalendarOff size={11} /> {publicHols[0].title} — {dateLabel(publicHols[0])}</span>
                                <DismissBtn groupType={`alert-interruption-${publicHols[0].id}`} color={colors.danger} />
                              </div>
                            )}
                            {publicHols.length > 1 && (
                              <div draggable
                                onDragStart={() => setAlertDragging(multiIntrPayload(publicHols, "Public Holidays"))}
                                onDragEnd={() => { setAlertDragging(null); }}
                                onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "PUBLIC HOLIDAYS", borderColor: colors.danger, items: publicHols.map(i => ({ label: `${i.title} — ${dateLabel(i)}`, chipColor: colors.danger, chipBg: intrChipBg, chipBorder: colors.danger, navigateTo: "calendar", dismissKey: `alert-interruption-${i.id}`, dragPayload: singleIntrPayload(i) })) }); }}
                                onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                                style={chipStyle(intrChipBg, colors.danger, colors.danger)}>
                                <span style={{ color: colors.danger, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><CalendarOff size={11} /> Public Holidays — {publicHols.length}</span>
                                <DismissBtn groupType="alert-interruption-ph-group" color={colors.danger} onClick={() => {
                                  const next = { ...alertDismissals, dismissed: { ...alertDismissals.dismissed, ...Object.fromEntries(publicHols.map(i => [`alert-interruption-${i.id}`, true])) } };
                                  setAlertDismissals(next);
                                  try { localStorage.setItem(STORAGE_KEYS.alertDismissals, JSON.stringify(next)); } catch {}
                                }} />
                              </div>
                            )}
                            {/* Curriculum days — aggregated across schools into a single grouped chip */}
                            {curriculumDays.length > 0 && (
                              <div draggable
                                onDragStart={() => setAlertDragging(multiIntrPayload(curriculumDays, "Curriculum Days"))}
                                onDragEnd={() => { setAlertDragging(null); }}
                                onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "CURRICULUM DAYS", borderColor: colors.accentDark, items: curriculumDays.map(i => {
                                  const sc = schools.find(s => s.id === i.schoolId);
                                  const acr = sc ? getSchoolAcronym(sc) : "?";
                                  const weekday = new Date(i.date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "long" });
                                  const weekLabel = getTermWeekLabel(i.date, termBreaks);
                                  return { label: `${acr} — ${weekday} ${weekLabel}`, chipColor: sc?.color || colors.accentDark, chipBg: intrChipBg, chipBorder: `${sc?.color || colors.accentDark}60`, navigateTo: "calendar", dismissKey: `alert-interruption-${i.id}`, dragPayload: singleIntrPayload(i) };
                                }) }); }}
                                onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                                style={chipStyle(intrChipBg, colors.accentDark, colors.accentDark)}>
                                <span style={{ color: colors.accentDark, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><AlertTriangle size={11} /> Curriculum Days</span>
                                <DismissBtn groupType="alert-interruption-cd-group" color={colors.accentDark} onClick={() => {
                                  const next = { ...alertDismissals, dismissed: { ...alertDismissals.dismissed, ...Object.fromEntries(curriculumDays.map(i => [`alert-interruption-${i.id}`, true])) } };
                                  setAlertDismissals(next);
                                  try { localStorage.setItem(STORAGE_KEYS.alertDismissals, JSON.stringify(next)); } catch {}
                                }} />
                              </div>
                            )}
                            {/* Per-school interruptions — single chip or grouped */}
                            {Object.entries(bySchool).map(([schoolId, intrs]) => {
                              const school = schools.find(s => s.id === schoolId);
                              const acronym = school ? getSchoolAcronym(school) : "?";
                              if (intrs.length === 1) {
                                const intr = intrs[0];
                                return (
                                  <div key={schoolId} draggable
                                    onDragStart={() => setAlertDragging(singleIntrPayload(intr))}
                                    onDragEnd={() => { setAlertDragging(null); }}
                                    style={chipStyle(intrChipBg, school?.color || colors.accentDark, school?.color || colors.accentDark)}>
                                    <span style={{ color: school?.color || colors.accentDark, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><AlertTriangle size={11} /> {acronym} — {intr.title}</span>
                                    <DismissBtn groupType={`alert-interruption-${intr.id}`} color={school?.color || colors.accentDark} />
                                  </div>
                                );
                              }
                              return (
                                <div key={schoolId} draggable
                                  onDragStart={() => setAlertDragging(multiIntrPayload(intrs, acronym))}
                                  onDragEnd={() => { setAlertDragging(null); }}
                                  onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: `${acronym} INTERRUPTIONS`, borderColor: school?.color || colors.accentDark, items: intrs.map(i => ({ label: `${i.title} — ${dateLabel(i)}`, chipColor: school?.color || colors.accentDark, chipBg: intrChipBg, chipBorder: `${school?.color || colors.accentDark}60`, navigateTo: "calendar", dismissKey: `alert-interruption-${i.id}`, dragPayload: singleIntrPayload(i) })) }); }}
                                  onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                                  style={chipStyle(intrChipBg, school?.color || colors.accentDark, school?.color || colors.accentDark)}>
                                  <span style={{ color: school?.color || colors.accentDark, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><AlertTriangle size={11} /> {acronym} — {intrs.length} events</span>
                                  <DismissBtn groupType={`alert-interruption-school-${schoolId}`} color={school?.color || colors.accentDark} onClick={() => {
                                    const next = { ...alertDismissals, dismissed: { ...alertDismissals.dismissed, ...Object.fromEntries(intrs.map(i => [`alert-interruption-${i.id}`, true])) } };
                                    setAlertDismissals(next);
                                    try { localStorage.setItem(STORAGE_KEYS.alertDismissals, JSON.stringify(next)); } catch {}
                                  }} />
                                </div>
                              );
                            })}
                          </>
                        );
                      })()}
                      {/* Blue — response required today + informational */}
                      {(() => { const visibleResponseBlue = responseRequiredBlue.filter(em => !isAlertDismissed(`alert-response-email-${em.id}`)); return visibleResponseBlue.length > 0 && !isAlertDismissed("alert-response-blue") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Reply to ${visibleResponseBlue.length} email${visibleResponseBlue.length !== 1 ? "s" : ""} with questions today`, tag: "email", groupType: "alert-response-blue", responseEmails: responseRequiredBlue })} onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => { saveDashPanels({ ...dashPanels, emails: true }); setEmailCategoryFilter(new Set()); setEmailSchoolFilter(new Set()); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "QUESTIONS TODAY", borderColor: `${colors.sidebarActive}80`, items: responseRequiredBlue.filter(em => !isAlertDismissed(`alert-response-email-${em.id}`)).slice(0, 8).map(em => { const n = em.from?.includes("<") ? em.from.split("<")[0].trim().replace(/^"|"$/g, "") : em.from || "Unknown"; return { label: `${n} — today`, chipColor: darkMode ? colors.blue600 : colors.sidebarActive, chipBg: colors.blueLight, chipBorder: `${darkMode ? colors.blue600 : colors.sidebarActive}40`, openEmailId: em.id, dismissKey: `alert-response-email-${em.id}`, onDismiss: () => { const next = new Set(emailNoReplyOverrides); next.add(em.id); setEmailNoReplyOverrides(next); try { localStorage.setItem(STORAGE_KEYS.emailNoReplyOverrides, JSON.stringify([...next])); } catch {} }, dragPayload: { text: `Reply to ${n} re: ${em.subject || "(no subject)"}`, tag: "email", groupType: `alert-response-email-${em.id}`, responseEmails: [em] } }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: colors.blueLight, border: `1px solid ${darkMode ? colors.blue600 : colors.sidebarActive}40`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: darkMode ? colors.blue600 : colors.sidebarActive, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><Reply size={11} /> {visibleResponseBlue.length} question{visibleResponseBlue.length !== 1 ? "s" : ""} today</span>
                          <DismissBtn groupType="alert-response-blue" color={darkMode ? colors.blue600 : colors.sidebarActive} onClick={() => {
                            const next = new Set(emailNoReplyOverrides);
                            for (const em of responseRequiredBlue) next.add(em.id);
                            setEmailNoReplyOverrides(next);
                            try { localStorage.setItem(STORAGE_KEYS.emailNoReplyOverrides, JSON.stringify([...next])); } catch {}
                            dismissAlert("alert-response-blue");
                          }} />
                        </div>
                      ); })()}
                      {/* Lesson change requests from parents */}
                      {(() => { const visibleLessonChangeEmails = lessonChangeEmails.filter(em => !isLessonChangeDismissed(em.id)); return visibleLessonChangeEmails.length > 0 && !isAlertDismissed("alert-lesson-change") && (
                        <div draggable
                          onDragStart={() => setAlertDragging({ text: `Review ${visibleLessonChangeEmails.length} lesson change request${visibleLessonChangeEmails.length !== 1 ? "s" : ""}`, tag: "email", groupType: "alert-lesson-change", responseEmails: visibleLessonChangeEmails })}
                          onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => { saveDashPanels({ ...dashPanels, emails: true }); setEmailCategoryFilter(new Set(["parent"])); setEmailSchoolFilter(new Set()); }}
                          onMouseEnter={e => {
                            clearTimeout(alertDropdownTimer.current);
                            const r = e.currentTarget.getBoundingClientRect();
                            const visEms = lessonChangeEmails.filter(em => !isLessonChangeDismissed(em.id));
                            const visIds = visEms.map(em => em.id);
                            openAlertDropdown({
                              rect: r,
                              anchor: "right",
                              title: "LESSON CHANGE REQUESTS",
                              borderColor: colors.accent,
                              headerAction: visEms.length > 1 ? {
                                label: `Dismiss all ${visEms.length}`,
                                onClick: () => {
                                  if (window.confirm(`Dismiss all ${visEms.length} lesson change request${visEms.length !== 1 ? "s" : ""}?`)) {
                                    dismissLessonChangesBulk(visIds);
                                    setAlertDropdown(null);
                                  }
                                }
                              } : undefined,
                              items: visEms.map(em => {
                                const n = em.from?.includes("<") ? em.from.split("<")[0].trim().replace(/^"|"$/g, "") : em.from || "Unknown";
                                const fromAddr = (em.from?.match(/<(.+)>/)?.[1] || em.from || "").toLowerCase();
                                const parentStudent = students.find(s => (s.parents || []).some(p => p.email?.toLowerCase() === fromAddr));
                                const sc = parentStudent ? schools.find(sc2 => sc2.id === parentStudent.schoolId) : null;
                                const scColor = sc?.color || (darkMode ? colors.accent : colors.accentDark);
                                return {
                                  label: `${n} — ${em.subject || "(no subject)"}`,
                                  chipColor: scColor, chipBg: `${scColor}18`, chipBorder: scColor,
                                  openEmailId: em.id,
                                  onDismiss: () => dismissLessonChange(em.id),
                                  dragPayload: { text: `Reply to ${n} re: ${em.subject || "lesson change"}`, tag: "email", groupType: `alert-lesson-change-${em.id}`, responseEmails: [em] }
                                };
                              })
                            });
                          }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: darkMode ? "rgba(196,122,106,0.18)" : colors.redLight, border: `1px solid ${colors.accent}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: darkMode ? colors.accent : colors.accentDark, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}><RefreshCw size={11} /> {visibleLessonChangeEmails.length} lesson change{visibleLessonChangeEmails.length !== 1 ? "s" : ""}</span>
                          <DismissBtn groupType="alert-lesson-change" color={colors.accent} />
                        </div>
                      ); })()}
                      {pendingOnly > 0 && !pendingDismissed && (() => {
                        const pendingStudents = students.filter(s => s.status === "pending").flatMap(s => {
                          const nonGroup = instrumentsFromEnrolments(s.id, enrolments).filter(i => !i.isGroup);
                          if (nonGroup.length === 0) {
                            // Placeholder row — keeps dropdown items aligned with the
                            // Math.max(1, ...) floor in pendingOnly count for instrument-less students.
                            return [{
                              studentId: s.id, studentName: s.name, instrument: "(no instrument)", schoolId: s.schoolId || "",
                              parentName: s.parents?.[0]?.name || "", parentEmail: s.parents?.[0]?.email || ""
                            }];
                          }
                          return nonGroup.map(i => ({
                            studentId: s.id, studentName: s.name, instrument: i.name, schoolId: s.schoolId || "",
                            parentName: s.parents?.[0]?.name || "", parentEmail: s.parents?.[0]?.email || ""
                          }));
                        });
                        return (
                          <div draggable onDragStart={() => setAlertDragging({ text: `Follow up ${pendingOnly} pending student${pendingOnly !== 1 ? "s" : ""}`, tag: "admin", groupType: "alert-pending", pendingOrTrialStudents: pendingStudents })} onDragEnd={() => setAlertDragging(null)}
                            onClick={() => onNavigate("pending")}
                            onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "PENDING STUDENTS", borderColor: `${colors.sidebarActive}80`, items: pendingStudents.map(s => { const sc = schools.find(sc2 => sc2.id === s.schoolId); const scColor = sc?.color || (darkMode ? colors.blue600 : colors.sidebarActive); return { label: `${s.studentName} — ${s.instrument}`, chipColor: scColor, chipBg: `${scColor}18`, chipBorder: `${scColor}40`, navigateToStudent: s.studentId, dismissKey: `alert-pending-student-${s.studentId}`, dragPayload: { text: `Contact ${preferredFirstName(s.parentName) || "parent"} re: ${preferredFirstName(s.studentName)}'s pending enrolment (${s.instrument})`, tag: "admin", groupType: `alert-pending-student-${s.studentId}-${s.instrument}`, pendingOrTrialLesson: s } }; }) }); }}
                            onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                            style={{ padding: "3px 10px", background: colors.blueLight, border: `1px solid ${darkMode ? colors.blue600 : colors.sidebarActive}40`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                            <span style={{ color: darkMode ? colors.blue600 : colors.sidebarActive, fontWeight: 700 }}>{pendingOnly} pending</span>
                            <DismissBtn groupType="alert-pending" color={darkMode ? colors.blue600 : colors.sidebarActive} />
                        </div>
                        );
                      })()}
                      {trialOnly > 0 && !trialDismissed && (() => {
                        const trialStudents = students.filter(s => s.status === "trial").flatMap(s => {
                          const nonGroup = instrumentsFromEnrolments(s.id, enrolments).filter(i => !i.isGroup);
                          if (nonGroup.length === 0) {
                            // Placeholder row — keeps dropdown items aligned with the
                            // Math.max(1, ...) floor in trialOnly count for instrument-less students.
                            return [{
                              studentId: s.id, studentName: s.name, instrument: "(no instrument)", schoolId: s.schoolId || "",
                              parentName: s.parents?.[0]?.name || "", parentEmail: s.parents?.[0]?.email || ""
                            }];
                          }
                          return nonGroup.map(i => ({
                            studentId: s.id, studentName: s.name, instrument: i.name, schoolId: s.schoolId || "",
                            parentName: s.parents?.[0]?.name || "", parentEmail: s.parents?.[0]?.email || ""
                          }));
                        });
                        return (
                          <div draggable onDragStart={() => setAlertDragging({ text: `Follow up ${trialOnly} trial student${trialOnly !== 1 ? "s" : ""}`, tag: "admin", groupType: "alert-trial", pendingOrTrialStudents: trialStudents })} onDragEnd={() => setAlertDragging(null)}
                            onClick={() => onNavigate("pending")}
                            onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); openAlertDropdown({ rect: r, title: "TRIAL STUDENTS", borderColor: `${colors.sidebarActive}80`, items: trialStudents.map(s => { const sc = schools.find(sc2 => sc2.id === s.schoolId); const scColor = sc?.color || (darkMode ? colors.blue600 : colors.sidebarActive); return { label: `${s.studentName} — ${s.instrument}`, chipColor: scColor, chipBg: `${scColor}18`, chipBorder: `${scColor}40`, navigateToStudent: s.studentId, dismissKey: `alert-trial-student-${s.studentId}`, dragPayload: { text: `Contact ${preferredFirstName(s.parentName) || "parent"} re: ${preferredFirstName(s.studentName)}'s trial (${s.instrument})`, tag: "admin", groupType: `alert-trial-student-${s.studentId}-${s.instrument}`, pendingOrTrialLesson: s } }; }) }); }}
                            onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                            style={{ padding: "3px 10px", background: colors.blueLight, border: `1px solid ${darkMode ? colors.blue600 : colors.sidebarActive}40`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                            <span style={{ color: darkMode ? colors.blue600 : colors.sidebarActive, fontWeight: 700 }}>{trialOnly} trial</span>
                            <DismissBtn groupType="alert-trial" color={darkMode ? colors.blue600 : colors.sidebarActive} />
                        </div>
                        );
                      })()}
                      {/* ── Teacher notes chip ── */}
                      {hasNewTeacherNotes && (() => {
                        const noteColor = "#7C3AED";
                        const chipItems = newTeacherNotes.map(n => ({
                          label: `${n.studentName} — ${n.teacherName || "Teacher"}${n.editedAt ? " (edited)" : ""}`,
                          chipColor: n.teacherColor || noteColor,
                          navigateToStudent: n.studentId,
                          dismissKey: n.id,
                        }));
                        return (
                          <div
                            onMouseEnter={e => {
                              clearTimeout(alertDropdownTimer.current);
                              const r = e.currentTarget.getBoundingClientRect();
                              openAlertDropdown({
                                rect: r,
                                title: "NEW TEACHER NOTES",
                                borderColor: noteColor,
                                items: chipItems,
                                onDismissAll: () => dismissAllTeacherNoteAlerts(newTeacherNotes.map(n => n.id)),
                                onDismissItem: (key) => dismissTeacherNoteAlert(key),
                              });
                            }}
                            onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                            style={{ padding: "3px 10px", background: darkMode ? "rgba(124,58,237,0.15)" : "#F5F3FF", border: `1px solid ${noteColor}40`, borderRadius: 20, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", userSelect: "none" }}>
                            <span style={{ color: noteColor, fontWeight: 700 }}>📝 {newTeacherNotes.length} teacher note{newTeacherNotes.length !== 1 ? "s" : ""}</span>
                            <span onClick={e => { e.stopPropagation(); dismissAllTeacherNoteAlerts(newTeacherNotes.map(n => n.id)); }} title="Dismiss all" style={{ marginLeft: 2, color: noteColor, opacity: 0.5, cursor: "pointer", display: "inline-flex", alignItems: "center", lineHeight: 1 }}><X size={10} /></span>
                          </div>
                        );
                      })()}
                      {/* ── Staff document uploads chip ── */}
                      {hasNewStaffDocs && (() => {
                        const docColor = "#0369A1"; // blue-700
                        const chipItems = newStaffDocs.map(d => {
                          const teacher = teachers.find(t => t.id === d.teacher_id);
                          const teacherName = teacher?.name || "Staff";
                          return {
                            label: `${teacherName} — ${d.type || "Document"}${d.file_name ? ` (${d.file_name})` : ""}`,
                            chipColor: docColor,
                            navigateTo: "resources",
                            dismissKey: d.id,
                          };
                        });
                        return (
                          <div
                            onMouseEnter={e => {
                              clearTimeout(alertDropdownTimer.current);
                              const r = e.currentTarget.getBoundingClientRect();
                              openAlertDropdown({
                                rect: r,
                                title: "NEW STAFF DOCUMENTS",
                                borderColor: docColor,
                                items: chipItems,
                                onDismissAll: () => dismissAllStaffDocAlerts(newStaffDocs.map(d => d.id)),
                                onDismissItem: (key) => dismissStaffDocAlert(key),
                              });
                            }}
                            onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                            style={{ padding: "3px 10px", background: darkMode ? "rgba(3,105,161,0.15)" : "#E0F2FE", border: `1px solid ${docColor}40`, borderRadius: 20, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", userSelect: "none" }}>
                            <span style={{ color: docColor, fontWeight: 700 }}>📄 {newStaffDocs.length} staff doc{newStaffDocs.length !== 1 ? "s" : ""}</span>
                            <span onClick={e => { e.stopPropagation(); dismissAllStaffDocAlerts(newStaffDocs.map(d => d.id)); }} title="Dismiss all" style={{ marginLeft: 2, color: docColor, opacity: 0.5, cursor: "pointer", display: "inline-flex", alignItems: "center", lineHeight: 1 }}><X size={10} /></span>
                          </div>
                        );
                      })()}
                      {/* ── Classroom teacher email alerts chip (red — high priority) ── */}
                      {hasTeacherEmailAlerts && (() => {
                        const chipItems = newTeacherEmailAlerts.map(a => {
                          const em = inboxEmails.find(e => e.id === a.emailId);
                          return {
                            label: a.summary,
                            chipColor: colors.danger,
                            openEmailId: a.emailId,
                            dismissKey: a.emailId,
                          };
                        });
                        const single = newTeacherEmailAlerts.length === 1;
                        return (
                          <div
                            onClick={single ? () => { openEmail(newTeacherEmailAlerts[0].emailId); } : undefined}
                            onMouseEnter={!single ? e => {
                              clearTimeout(alertDropdownTimer.current);
                              const r = e.currentTarget.getBoundingClientRect();
                              openAlertDropdown({ rect: r, title: "CLASSROOM UPDATES", borderColor: colors.danger, items: chipItems });
                            } : undefined}
                            onMouseLeave={!single ? () => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); } : undefined}
                            style={{ padding: "3px 10px", background: darkMode ? "rgba(196,84,84,0.18)" : colors.redLight, border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", userSelect: "none" }}>
                            <span style={{ color: colors.danger, fontWeight: 700 }}>
                              {single ? `🏫 ${newTeacherEmailAlerts[0].summary}` : `🏫 ${newTeacherEmailAlerts.length} classroom updates`}
                            </span>
                            <span onClick={e => { e.stopPropagation(); dismissAllTeacherEmailAlerts(newTeacherEmailAlerts.map(a => a.emailId)); }} title="Dismiss all" style={{ marginLeft: 2, color: colors.danger, opacity: 0.5, cursor: "pointer", display: "inline-flex", alignItems: "center", lineHeight: 1 }}><X size={10} /></span>
                          </div>
                        );
                      })()}
                      {/* ── Invoice received chip ── */}
                      {hasNewInvoices && (() => {
                        const invColor = "#0D9488"; // teal-600
                        const invBg = darkMode ? "rgba(13,148,136,0.15)" : "#CCFBF1";
                        const chipItems = newInvoices.map(inv => {
                          const teacher = teachers.find(t => t.id === inv.teacher_id);
                          const teacherName = teacher?.name || "Teacher";
                          const periodLabel = inv.period_start
                            ? `${new Date(inv.period_start + "T12:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" })}–${new Date(inv.period_end + "T12:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" })}`
                            : "";
                          return {
                            label: `${teacherName}${periodLabel ? ` — ${periodLabel}` : ""}${inv.total_amount ? ` ($${Number(inv.total_amount).toFixed(2)})` : ""}`,
                            chipColor: invColor,
                            chipBg: invBg,
                            chipBorder: invColor,
                            navigateTo: "teachers",
                            dismissKey: inv.id,
                          };
                        });
                        const single = newInvoices.length === 1;
                        const singleInv = single ? newInvoices[0] : null;
                        const singleTeacher = singleInv ? teachers.find(t => t.id === singleInv.teacher_id) : null;
                        const singleLabel = singleTeacher
                          ? `${singleTeacher.name}${singleInv.period_start ? ` — ${new Date(singleInv.period_start + "T12:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" })}–${new Date(singleInv.period_end + "T12:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : ""}`
                          : "New invoice";
                        return (
                          <div
                            onClick={single ? () => { onNavigate("teachers"); } : undefined}
                            onMouseEnter={!single ? e => {
                              clearTimeout(alertDropdownTimer.current);
                              const r = e.currentTarget.getBoundingClientRect();
                              openAlertDropdown({ rect: r, title: "INVOICES RECEIVED", borderColor: invColor, items: chipItems });
                            } : undefined}
                            onMouseLeave={!single ? () => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); } : undefined}
                            style={{ padding: "3px 10px", background: invBg, border: `1px solid ${invColor}60`, borderRadius: 20, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", userSelect: "none" }}>
                            <span style={{ color: invColor, fontWeight: 700 }}>
                              {single ? `🧾 ${singleLabel}` : `🧾 ${newInvoices.length} invoices received`}
                            </span>
                            <span onClick={e => { e.stopPropagation(); dismissAllInvoiceAlerts(newInvoices.map(inv => inv.id)); }} title="Dismiss all" style={{ marginLeft: 2, color: invColor, opacity: 0.5, cursor: "pointer", display: "inline-flex", alignItems: "center", lineHeight: 1 }}><X size={10} /></span>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })()}

              {/* Spacer — exactly 1× banner height when open, pushes banner down to expose alerts */}
              <div style={{ height: dashPanels.alerts ? 42 : 0, transition: "height 0.28s ease" }} />

              {/* Alerts pill — fixed to outer wrapper top, never moves */}
              <div ref={alertsPillRef} onClick={() => togglePanel("alerts")}
                style={{ position: "absolute", left: 10, top: 9, zIndex: 5,
                  display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 12,
                  background: dashPanels.alerts ? colors.danger : totalAlertsWithTeacherNotes > 0 ? colors.danger : colors.sidebarActive,
                  cursor: "pointer", transition: "background 0.15s", userSelect: "none",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.3)" }}
                onMouseEnter={e => { e.currentTarget.style.background = colors.accentDark; }}
                onMouseLeave={e => { e.currentTarget.style.background = dashPanels.alerts ? colors.danger : totalAlertsWithTeacherNotes > 0 ? colors.danger : colors.sidebarActive; }}>
                <span style={{ fontWeight: 700, fontSize: 11, color: "#fff", letterSpacing: "0.03em" }}>Alerts</span>
                {totalAlertsWithTeacherNotes > 0 && <span style={{ fontSize: 10, fontWeight: 700, background: "rgba(255,255,255,0.3)", color: "#fff", borderRadius: 8, padding: "0px 5px" }}>{totalAlertsWithTeacherNotes}</span>}
                {totalAlertsWithTeacherNotes > 0 && (
                  <span
                    onClick={e => { e.stopPropagation(); dismissAllActive(); }}
                    title="Dismiss all alerts"
                    style={{ fontSize: 12, color: "#fff", opacity: 0.75, lineHeight: 1, cursor: "pointer", display: "inline-flex", alignItems: "center" }}
                    onMouseEnter={e => { e.stopPropagation(); e.currentTarget.style.opacity = "1"; }}
                    onMouseLeave={e => { e.stopPropagation(); e.currentTarget.style.opacity = "0.75"; }}>
                    <X size={12} />
                  </span>
                )}
                {Object.keys(alertDismissals.dismissed).length > 0 && (
                  <span
                    onClick={e => { e.stopPropagation(); const reset = { date: todayStr, dismissed: {} }; setAlertDismissals(reset); try { localStorage.setItem(STORAGE_KEYS.alertDismissals, JSON.stringify(reset)); } catch {} }}
                    title="Restore dismissed alerts"
                    style={{ fontSize: 12, color: "#fff", opacity: 0.75, lineHeight: 1, cursor: "pointer", display: "inline-flex", alignItems: "center" }}
                    onMouseEnter={e => { e.stopPropagation(); e.currentTarget.style.opacity = "1"; }}
                    onMouseLeave={e => { e.stopPropagation(); e.currentTarget.style.opacity = "0.75"; }}><RotateCcw size={12} /></span>
                )}
              </div>

              {/* Banner card — z-index 1, sits above the alerts card */}
              <div ref={panelCardRef} style={{ position: "relative", zIndex: 1 }}>
                <Card style={{ marginBottom: 0, padding: 0, overflow: "hidden" }}>

                  {/* ── Header bar ── */}
                  <div style={{ background: colors.sidebarHover, borderRadius: anyPanelOpen ? "12px 12px 0 0" : 12, display: "flex", alignItems: "stretch", userSelect: "none", position: "relative" }}>

                    {/* Emails tab */}
                    <div onClick={() => togglePanel("emails")}
                      style={{ flex: splitRatio, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "11px 0",
                        cursor: "pointer", borderRight: "1px solid rgba(0,0,0,0.25)",
                        borderBottom: dashPanels.emails ? `3px solid ${colors.accent}` : "3px solid transparent",
                        background: "transparent", transition: "border-color 0.15s" }}
                      onMouseEnter={e => { if (!dashPanels.emails) e.currentTarget.style.borderBottomColor = "rgba(196,122,106,0.4)"; }}
                      onMouseLeave={e => { if (!dashPanels.emails) e.currentTarget.style.borderBottomColor = "transparent"; }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: "#fff" }}>Emails</span>
                      {(() => { const unread = inboxEmails.filter(e => !emailReadIds.has(e.id)).length; return unread > 0 && <span style={{ fontSize: 11, fontWeight: 700, background: "rgba(255,255,255,0.22)", color: "#fff", borderRadius: 10, padding: "1px 7px" }}>{unread}</span>; })()}
                    </div>

                    {/* Drag handle on the header divider — extends col-resize to header */}
                    {bothOpen && <div onMouseDown={handleDividerMouseDown} style={{ position: "absolute", left: `calc(${(splitRatio * 100).toFixed(1)}% - 4px)`, top: 0, bottom: 0, width: 8, cursor: "col-resize", zIndex: 10 }} />}

                    {/* To Do tab */}
                    <div onClick={() => togglePanel("todo")}
                      style={{ flex: 1 - splitRatio, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "11px 0",
                        cursor: "pointer",
                        borderBottom: dashPanels.todo ? `3px solid ${colors.accent}` : "3px solid transparent",
                        background: "transparent", transition: "border-color 0.15s" }}
                      onMouseEnter={e => { if (!dashPanels.todo) e.currentTarget.style.borderBottomColor = "rgba(196,122,106,0.4)"; }}
                      onMouseLeave={e => { if (!dashPanels.todo) e.currentTarget.style.borderBottomColor = "transparent"; }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: "#fff" }}>To Do</span>
                      {activeTodo.length > 0 && <span style={{ fontSize: 11, fontWeight: 700, background: "rgba(255,255,255,0.22)", color: "#fff", borderRadius: 10, padding: "1px 7px" }}>{activeTodo.length}</span>}
                    </div>
                  </div>

              {/* ── Panels — side-by-side when both open ── */}
              {(dashPanels.emails || dashPanels.todo) && (
                <div style={{ display: "flex", alignItems: "stretch" }}>

                  {/* ── Emails panel ── */}
                  {dashPanels.emails && (
                    <div style={{ flex: bothOpen ? splitRatio : 1, minWidth: 0, borderRight: bothOpen ? "1px solid rgba(0,0,0,0.12)" : "none", position: "relative" }}
                      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "none"; }}
                      onDrop={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        setEmailDragging(null); setTodoDropTarget(false);
                      }}>
                      {bothOpen && <div onMouseDown={handleDividerMouseDown} style={{ position: "absolute", right: -4, top: 0, bottom: 0, width: 8, cursor: "col-resize", zIndex: 10 }} />}
                      {/* Sticky search + filter header */}
                      <div style={{ padding: "12px 16px 8px", borderBottom: `1px solid ${colors.borderLight}` }}>

                        {/* ── Folder toggle + Search + refresh ── */}
                        <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
                          {/* Compose button */}
                          <button onClick={() => window._openComposeModal && window._openComposeModal({ to: [], from: "", subject: "", body: "" })}
                            style={{ padding: "5px 12px", borderRadius: 7, border: `1.5px solid ${colors.border}`, background: colors.cardBg, color: colors.text, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                            Compose
                          </button>
                          {/* Inbox / Sent pills */}
                          {["inbox", "sent"].map(folder => (
                            <button key={folder} onClick={() => {
                              setEmailFolderPersist(folder);
                              if (folder === "sent" && sentEmails.length === 0) fetchSent();
                              // Drop inbox-only filter chips (★ pinned, enquiry) when entering sent
                              if (folder === "sent") {
                                setEmailCategoryFilter(prev => {
                                  const next = new Set(prev);
                                  next.delete("pinned");
                                  next.delete("enquiry");
                                  return next;
                                });
                              }
                            }}
                              style={{ padding: "5px 12px", borderRadius: 7, border: emailFolder === folder ? `1.5px solid ${colors.sidebarActive}` : `1.5px solid ${colors.border}`, background: emailFolder === folder ? colors.blueLight : colors.cardBg, color: emailFolder === folder ? colors.sidebarActive : colors.textLight, fontSize: 12, fontWeight: emailFolder === folder ? 700 : 400, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                              {folder === "inbox" ? "Inbox" : "Sent"}
                            </button>
                          ))}
                          {/* Auto-send undo toast — replaces search+fetch space when active */}
                          {autoSendQueue.length > 0 ? (
                            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, background: colors.amberLight, border: `1px solid ${colors.warning}`, borderRadius: 7, padding: "5px 10px", minWidth: 0 }}>
                              <span style={{ fontSize: 11, color: colors.amberDark, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 5 }}>
                                <Loader2 size={11} style={{ animation: "spin 1s linear infinite", flexShrink: 0 }} /> Sending {autoSendQueue[0]?.label || autoSendQueue[0]?.to?.[0] || "email"}{autoSendQueue.length > 1 ? ` (+${autoSendQueue.length - 1} queued)` : ""}…
                              </span>
                              <button onClick={() => { cancelAutoSend(); notify("Auto-send cancelled", "warning"); }}
                                style={{ padding: "2px 8px", borderRadius: 5, border: `1px solid ${colors.warning}`, background: colors.cardBg, color: colors.amberDark, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                                Undo
                              </button>
                            </div>
                          ) : (
                            <div style={{ position: "relative", flex: 1 }}>
                              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: colors.textMuted, pointerEvents: "none", display: "flex", alignItems: "center" }}><Search size={13} /></span>
                              <input value={emailSearch} onChange={e => { setEmailSearchPersist(e.target.value); setEmailSuggestOpen(true); }}
                                onFocus={() => setEmailSuggestOpen(true)}
                                onBlur={() => setTimeout(() => setEmailSuggestOpen(false), 150)}
                                onKeyDown={e => { if (e.key === "Escape") { setEmailSearchPersist(""); setEmailSuggestOpen(false); } }}
                                placeholder="Search…"
                                style={{ width: "100%", boxSizing: "border-box", paddingLeft: 30, paddingRight: emailSearch ? 26 : 8, paddingTop: 6, paddingBottom: 6, border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", color: colors.text, outline: "none", background: colors.cardBg }} />
                              {emailSearch && (
                                <button onClick={() => { setEmailSearchPersist(""); setEmailSuggestOpen(false); }}
                                  style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: colors.textMuted, lineHeight: 1, padding: 0, display: "flex", alignItems: "center" }}>
                                  <X size={12} />
                                </button>
                              )}
                              {/* Suggestion dropdown */}
                              {emailSuggestOpen && emailSuggestions.length > 0 && (
                                <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 9999, overflow: "hidden" }}>
                                  {emailSuggestions.map((s, i) => (
                                    <button key={i} onMouseDown={() => { setEmailSearchPersist(s.email); setEmailSuggestOpen(false); }}
                                      style={{ display: "flex", flexDirection: "column", width: "100%", padding: "7px 12px", background: "none", border: "none", borderBottom: i < emailSuggestions.length - 1 ? `1px solid ${colors.border}` : "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
                                      onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                                      onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                      <span style={{ fontSize: 12, fontWeight: 600, color: colors.text }}>{s.name}</span>
                                      <span style={{ fontSize: 11, color: colors.textMuted }}>{s.email}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          <button onClick={() => emailFolder === "sent" ? fetchSent() : fetchInbox()} disabled={inboxLoading || sentLoading} title="Refresh"
                            style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${colors.border}`, background: (inboxLoading || sentLoading) ? colors.bg : colors.cardBg, color: (inboxLoading || sentLoading) ? colors.textMuted : colors.text, cursor: (inboxLoading || sentLoading) ? "default" : "pointer", fontSize: 14, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
                            <span style={{ display: "inline-flex", animation: (inboxLoading || sentLoading) ? "spin 1s linear infinite" : "none" }}><RefreshCw size={14} /></span>
                            {gmailRateLimitUntil > Date.now() ? (
                              <span style={{ fontSize: 11, color: colors.warning, whiteSpace: "nowrap" }} title="Gmail rate limit active — all polling paused until this clears">
                                ⏳ Retry after {new Date(gmailRateLimitUntil).toLocaleTimeString("en-AU", { timeZone: "Australia/Melbourne", hour: "numeric", minute: "2-digit" })}
                              </span>
                            ) : inboxError ? (
                              <span onClick={() => console.error('Inbox error:', inboxError)} style={{ fontSize: 11, color: colors.danger, cursor: "pointer" }} title={inboxError}>Error ⓘ</span>
                            ) : null}
                            {summariesLoading && <span style={{ fontSize: 11, color: colors.textMuted }}>…</span>}
                          </button>
                        </div>

                        {/* ── Filters — inbox + sent ── */}
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                          {CATEGORY_FILTERS.filter(ft => emailFolder !== "sent" || (ft.key !== "pinned" && ft.key !== "enquiry")).map(ft => {
                            const active = emailCategoryFilter.has(ft.key);
                            return (
                              <button key={ft.key} onClick={() => setEmailCategoryFilter(prev => { const next = new Set(prev); active ? next.delete(ft.key) : next.add(ft.key); return next; })}
                                style={{ padding: ft.key === "pinned" ? "3px 8px" : "3px 9px", borderRadius: 12,
                                  border: active ? `1.5px solid ${colors.sidebarActive}` : `1.5px solid ${colors.border}`,
                                  background: active ? colors.blueLight : "transparent",
                                  color: active ? colors.sidebarActive : colors.textMuted,
                                  fontSize: ft.key === "pinned" ? 13 : 11, fontWeight: active ? 700 : 400,
                                  cursor: "pointer", fontFamily: "inherit" }}>
                                {ft.label}
                              </button>
                            );
                          })}
                          {SCHOOL_FILTERS.length > 0 && <>
                            <div style={{ width: 1, height: 16, background: colors.border, margin: "0 2px", flexShrink: 0 }} />
                            {SCHOOL_FILTERS.map(ft => {
                              const active = emailSchoolFilter.has(ft.key);
                              const chipColor = ft.color || colors.accentDark;
                              const chipBg = ft.color ? `${ft.color}18` : colors.accentLight;
                              return (
                                <button key={ft.key} onClick={() => setEmailSchoolFilter(prev => { const next = new Set(prev); active ? next.delete(ft.key) : next.add(ft.key); return next; })}
                                  style={{ padding: "3px 9px", borderRadius: 12,
                                    border: active ? `1.5px solid ${chipColor}` : `1.5px solid ${colors.border}`,
                                    background: active ? chipBg : "transparent",
                                    color: active ? chipColor : colors.textMuted,
                                    fontSize: 11, fontWeight: active ? 700 : 400,
                                    cursor: "pointer", fontFamily: "inherit" }}>
                                  {ft.label}
                                </button>
                              );
                            })}
                          </>}
                        </div>
                      </div>

                      {/* Scrollable email list — fills remaining panel height */}
                      <div ref={emailListRef} style={{ overflowY: "auto", maxHeight: "calc(100vh - 280px)" }}
                        onMouseEnter={e => { hoveredScrollRef.current = e.currentTarget; }}
                        onMouseLeave={() => { hoveredScrollRef.current = null; }}>
                        {/* All-mail search indicator */}
                        {emailSearch.trim().length >= 5 && window.electronAPI?.gmailSearch && (
                          <div style={{ fontSize: 11, color: gmailSearchLoading ? colors.accent : colors.textMuted, padding: "5px 14px 4px", fontStyle: "italic", borderBottom: `1px solid ${colors.border}` }}>
                            {gmailSearchLoading ? "Searching all mail…" : `Showing results from all mail${filteredEmails.length > 0 ? ` — ${filteredEmails.length} result${filteredEmails.length !== 1 ? "s" : ""}` : ""}`}
                          </div>
                        )}
                        {gmailSearchLoading ? null : filteredEmails.length === 0 ? (
                          <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "12px 16px" }}>
                            {emailSearch.trim()
                              ? "No emails found."
                              : emailFolder === "sent"
                                ? (sentEmails.length === 0 ? "No sent emails loaded." : "No emails match.")
                                : (inboxEmails.length === 0 ? (window.electronAPI ? "No emails loaded." : "Gmail not connected.") : "No emails match.")}
                          </div>
                        ) : (
                          <div style={{ border: `1px solid ${colors.border}`, borderRadius: "0 0 8px 8px", borderTop: "none", overflow: "hidden" }}>
                            {filteredEmails.map((email, idx) => {
                              const isSelected = inboxSelected === email.id;
                              const isPinned = emailPinned.includes(email.id);
                              const isRead = emailReadIds.has(email.id);
                              const category = classifyEmailFull(email);
                              // For sent emails show recipient name; for inbox use contact-aware lookup
                              const displayHeader = emailFolder === "sent" ? (email.to || "") : (email.from || "");
                              const fromName = resolveDisplayName(displayHeader, contacts, students);
                              const fromAddr = email.from?.match(/<(.+)>/)?.[1] || email.from || "";
                              // Thread name: show ALL distinct external respondents (most-recent first),
                              // not just the primary sender — so a reply from someone else inside the
                              // thread is visible when scanning. Reuses the same per-message from-name
                              // resolution as the participant chips; excludes our own sends ("You") and
                              // the school-alias / primary mailbox addresses. Inbox only; falls back to
                              // the single sender for sent mail and single-message / not-yet-loaded threads.
                              const threadDisplayNames = (() => {
                                if (emailFolder === "sent") return fromName;
                                const msgs = email.threadMessages || [];
                                if (msgs.length <= 1) return fromName;
                                const aliasAddrs = new Set((schools || []).map(s => (s.senderEmail || "").trim().toLowerCase()).filter(Boolean));
                                try { const p = getPrimaryAddress(); if (p) aliasAddrs.add(p.toLowerCase()); } catch {}
                                const seen = new Set();
                                const names = [];
                                for (const m of [...msgs].reverse()) {
                                  if (m.isSent) continue;
                                  const addr = (m.from?.match(/<(.+)>/)?.[1] || m.from || "").trim().toLowerCase();
                                  if (addr && aliasAddrs.has(addr)) continue;
                                  const nm = resolveDisplayName(m.from, contacts, students);
                                  const key = nm.toLowerCase();
                                  if (seen.has(key)) continue;
                                  seen.add(key);
                                  names.push(nm);
                                }
                                return names.length ? names.join(", ") : fromName;
                              })();
                              // Reply-all recipients: extract all To/CC addresses excluding own address
                              const allRecipients = [fromAddr, ...(email.cc || "").split(",").map(s => s.trim()).filter(Boolean)].filter(Boolean);
                              const dateObj = email.date ? new Date(email.date) : null;
                              const dateStr = (() => {
                                if (!dateObj || isNaN(dateObj)) return "";
                                const timeStr = dateObj.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
                                const isToday = toLocalDateStr(dateObj) === todayStr;
                                if (isToday) return timeStr;
                                return `${dateObj.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}, ${timeStr}`;
                              })();
                              const cacheKey = `${email.threadId || email.id}-${email.id}`;
                              const summaryData = emailSummaries[cacheKey];
                              const summary = typeof summaryData === "string" ? summaryData : summaryData?.summary;
                              const needsReply = typeof summaryData === "object" ? !!summaryData?.needsReply : false;
                              const isTriaging = triageLoading[email.id];
                              const draft = triageDraft[email.id];
                              const hasAttachment = !!(
                                email.hasAttachment ||
                                (email.attachments && email.attachments.length > 0) ||
                                (email.payload?.parts && email.payload.parts.some(p => p.filename && p.filename.length > 0)) ||
                                email.files?.length > 0
                              );
                              const threadCount = email.threadCount || email.messageCount || null;

                              // Replied indicator — true if we have sent anything in this thread.
                              // Intentionally thread-level (not chip-level) so clicking a 'You' chip
                              // never hides the icon on the collapsed row. Per-chip status is shown
                              // separately inside the thread chip row when the email is expanded.
                              const isReplied = (() => {
                                // Fallback A: threadMessages (fast, works when complete)
                                const msgs = email.threadMessages || [];
                                if (msgs.some(m => m.isSent)) return true;
                                // Fallback B: sentEmails cross-reference
                                if (sentEmails.length > 0) {
                                  const tid = email.threadId || email.id;
                                  const normSubject = (email.subject || "").replace(/^(re|fwd?):\s*/gi, "").trim().toLowerCase();
                                  return sentEmails.some(s => {
                                    // Match by threadId first (most reliable)
                                    if (s.threadId && s.threadId === email.threadId) return true;
                                    // Match by normalised subject (catches cases where threadId isn't
                                    // populated on sent emails by the Gmail list API)
                                    if (normSubject) {
                                      const sNorm = (s.subject || "").replace(/^(re|fwd?):\s*/gi, "").trim().toLowerCase();
                                      if (sNorm === normSubject) return true;
                                    }
                                    // Last resort: message id matches thread id (first msg in thread)
                                    return (s.threadId || s.id) === tid;
                                  });
                                }
                                return false;
                              })();

                              // Quote/history and signature — computed per selected message in expanded view

                              // Swipe — intent-based: accumulate deltaX quietly, snap to open/closed on threshold
                              // Swipe — right only, snaps open/closed, real-time visual feedback
                              const SWIPE_CAP = 210;
                              const SWIPE_THRESHOLD = 80; // snap open if released past here
                              const swipeDx = emailSwipeState[email.id] || 0;
                              const swipeLocked = swipeDx >= SWIPE_CAP;

                              return (
                                <div key={email.id} data-emailid={email.id}
                                  style={{ position: "relative", overflow: "hidden" }}
                                  onWheel={e => {
                                    if (isSelected) return;
                                    if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 0.7) return;
                                    if (Math.abs(e.deltaX) < 2) return;
                                    const id = email.id;
                                    const current = emailSwipeRef.current[id] || 0;
                                    // Ignore rightward scroll if already open
                                    if (current >= SWIPE_CAP && e.deltaX > 0) return;
                                    // Ignore leftward scroll if already closed
                                    if (e.deltaX < 0 && current <= 0) return;
                                    // Move in real-time, clamped
                                    const next = Math.max(0, Math.min(SWIPE_CAP, current + e.deltaX * 0.8));
                                    emailSwipeRef.current[id] = next;
                                    setEmailSwipeState(prev => ({ ...prev, [id]: next }));
                                    // Snap to fully open or closed on gesture pause
                                    clearTimeout(emailSwipeRef.current[`t_${id}`]);
                                    emailSwipeRef.current[`t_${id}`] = setTimeout(() => {
                                      const settled = emailSwipeRef.current[id] || 0;
                                      const snapped = settled >= SWIPE_THRESHOLD ? SWIPE_CAP : 0;
                                      emailSwipeRef.current[id] = snapped;
                                      setEmailSwipeState(prev => ({ ...prev, [id]: snapped }));
                                    }, 120);
                                  }}>

                                  {/* Swipe buttons — always rendered, row slides to reveal */}
                                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: SWIPE_CAP, display: "flex", zIndex: 0 }}>
                                      {/* Archive */}
                                      <button onClick={() => {
                                        if (emailFolder !== "sent") {
                                          markArchived(email.id);
                                          setInboxEmails(prev => { const next = prev.filter(em => em.id !== email.id); saveInboxCache(next); return next; });
                                          setInboxSelected(null);
                                          if (window.electronAPI?.gmailArchive) window.electronAPI.gmailArchive(email.id).catch(() => {});
                                        }
                                        emailSwipeRef.current[email.id] = 0;
                                        setEmailSwipeState(prev => ({ ...prev, [email.id]: 0 }));
                                      }} style={{ flex: 1, background: colors.danger, border: "none", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", lineHeight: 1.3 }}>
                                        <X size={13} /><br/>{emailFolder === "sent" ? "Dismiss" : "Archive"}
                                      </button>
                                      {/* Read / Unread */}
                                      <button onClick={e => {
                                        e.stopPropagation();
                                        const next = new Set(emailReadIds);
                                        if (isRead) next.delete(email.id); else next.add(email.id);
                                        setEmailReadIds(next);
                                        try { localStorage.setItem(STORAGE_KEYS.inboxReadIds, JSON.stringify([...next])); } catch {}
                                        emailSwipeRef.current[email.id] = 0;
                                        setEmailSwipeState(prev => ({ ...prev, [email.id]: 0 }));
                                      }} style={{ flex: 1, background: colors.sidebarActive, border: "none", borderLeft: "1px solid rgba(255,255,255,0.15)", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", lineHeight: 1.3 }}>
                                        {isRead ? <CircleDot size={13} /> : <Circle size={13} />}<br/>{isRead ? "Unread" : "Read"}
                                      </button>
                                      {/* Reply */}
                                      <button onClick={e => {
                                        e.stopPropagation();
                                        const replyAddr = email.from?.match(/<(.+)>/)?.[1] || email.from || "";
                                        openCompose([replyAddr], { from: schoolSenderForSourceEmail(email, schools) || "", subject: reSubject(email.subject), body: "", threadMessages: email.threadMessages });
                                        emailSwipeRef.current[email.id] = 0;
                                        setEmailSwipeState(prev => ({ ...prev, [email.id]: 0 }));
                                      }} style={{ flex: 1, background: colors.accent, border: "none", borderLeft: "1px solid rgba(255,255,255,0.15)", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", lineHeight: 1.3 }}>
                                        <Mail size={13} /><br/>Reply
                                      </button>
                                    </div>
                                  {/* Row */}
                                  <div
                                    draggable={!isSelected}
                                    onDragStart={e => {
                                      if (isSelected) return;
                                      if (e.shiftKey) { e.preventDefault(); return; }
                                      if (emailSelectedIds.size > 1 && emailSelectedIds.has(email.id)) {
                                        const sel = filteredEmails.filter(em => emailSelectedIds.has(em.id));
                                        setEmailDragging(sel);
                                      } else {
                                        setEmailDragging(email);
                                      }
                                      setTodoDropTarget(true);
                                    }}
                                    onDragEnd={() => { if (isSelected) return; setEmailDragging(null); setTodoDropTarget(false); }}
                                    onContextMenu={e => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const sel = window.getSelection()?.toString().trim();
                                      setEmailContextMenu({ x: e.clientX, y: e.clientY, text: sel || "", emailId: email.id, email });
                                    }}
                                    onClick={e => {
                                      if (swipeDx !== 0) { emailSwipeRef.current[email.id] = 0; setEmailSwipeState(prev => ({ ...prev, [email.id]: 0 })); return; }
                                      // Cmd/Ctrl+click — toggle individual selection
                                      if (e.metaKey || e.ctrlKey) {
                                        const next = new Set(emailSelectedIds);
                                        if (next.has(email.id)) next.delete(email.id); else next.add(email.id);
                                        setEmailSelectedIds(next);
                                        emailLastSelectedRef.current = email.id;
                                        return;
                                      }
                                      // Shift+click — range select
                                      if (e.shiftKey && emailLastSelectedRef.current) {
                                        const ids = filteredEmails.map(em => em.id);
                                        const lastIdx = ids.indexOf(emailLastSelectedRef.current);
                                        const curIdx = ids.indexOf(email.id);
                                        const [lo, hi] = [Math.min(lastIdx, curIdx), Math.max(lastIdx, curIdx)];
                                        const next = new Set(emailSelectedIds);
                                        ids.slice(lo, hi + 1).forEach(id => next.add(id));
                                        setEmailSelectedIds(next);
                                        return;
                                      }
                                      // Plain click — clear selection and open/close
                                      if (emailSelectedIds.size > 0) { setEmailSelectedIds(new Set()); return; }
                                      const opening = !isSelected;
                                      setInboxSelected(opening ? email.id : null);
                                      emailLastSelectedRef.current = email.id;
                                      if (opening) markRead(email.id);
                                      if (opening) {
                                        requestAnimationFrame(() => {
                                          const container = emailListRef.current;
                                          const el = container?.querySelector(`[data-emailid="${email.id}"]`);
                                          if (el && container) container.scrollTop = el.offsetTop - container.offsetTop;
                                        });
                                      }
                                    }}
                                    style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column",
                                      transform: `translateX(${swipeDx}px)`, transition: "transform 0.22s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                                      background: emailSelectedIds.has(email.id) ? (darkMode ? colors.sidebarActive : "#E8EDF4") : isSelected ? (darkMode ? colors.sidebarHover : "#F0F2F6") : (isPinned ? `linear-gradient(rgba(255,251,235,${darkMode ? "0.06" : "0.85"}), rgba(255,251,235,${darkMode ? "0.06" : "0.85"})), ${colors.cardBg}` : colors.cardBg),
                                      borderLeft: emailSelectedIds.has(email.id) ? `3px solid ${colors.sidebarActive}` : "3px solid transparent",
                                      borderBottom: `1px solid ${colors.sidebarActive}22`,
                                      cursor: "pointer" }}>
                                    {/* Summary row — drag handle when open */}
                                    <div
                                      draggable={isSelected}
                                      onDragStart={isSelected ? (e => {
                                        e.stopPropagation();
                                        if (e.shiftKey) { e.preventDefault(); return; }
                                        if (emailSelectedIds.size > 1 && emailSelectedIds.has(email.id)) {
                                          setEmailDragging(filteredEmails.filter(em => emailSelectedIds.has(em.id)));
                                        } else {
                                          setEmailDragging(email);
                                        }
                                        setTodoDropTarget(true);
                                      }) : undefined}
                                      onDragEnd={isSelected ? (() => { setEmailDragging(null); setTodoDropTarget(false); }) : undefined}
                                      style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 12px", cursor: isSelected ? "grab" : undefined }}>
                                    {/* Read/replied indicator — hidden in sent folder */}
                                    {emailFolder !== "sent" ? (
                                      <span style={{ flexShrink: 0, width: 14, display: "flex", alignItems: "flex-start", justifyContent: "center", marginTop: 3 }}>
                                        {!isRead
                                          ? <span style={{ width: 7, height: 7, borderRadius: "50%", background: colors.sidebarActive, display: "inline-block", marginTop: 2, flexShrink: 0 }} />
                                          : isReplied
                                            ? <span title="Replied" style={{ fontSize: 11, color: colors.sidebarActive, lineHeight: 1, opacity: 0.75, display: "inline-flex", alignItems: "center" }}><Reply size={11} /></span>
                                            : null
                                        }
                                      </span>
                                    ) : (
                                      <span style={{ flexShrink: 0, width: 14 }} />
                                    )}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      {/* Sender / Recipient row */}
                                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                        <span
                                          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setEmailContextMenu({ x: e.clientX, y: e.clientY, text: "", emailId: email.id, email, fromAddr, fromName, isSenderCtx: true }); }}
                                          style={{ fontWeight: 700, fontSize: 13, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "context-menu" }}>
                                          {emailFolder === "sent" && <span style={{ fontWeight: 400, color: colors.textMuted, marginRight: 3 }}>To:</span>}
                                          {threadDisplayNames}
                                        </span>
                                        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                                          {needsReply && !isReplied && <span title="Response required" style={{ fontSize: 10, color: colors.danger, fontWeight: 700, lineHeight: 1, display: "inline-flex", alignItems: "center" }}><Reply size={10} /></span>}
                                          {hasAttachment && <span title="Has attachment" style={{ color: colors.textMuted, display: "inline-flex", alignItems: "center" }}><Paperclip size={10} /></span>}
                                          {threadCount > 1 && <span style={{ fontSize: 10, fontWeight: 700, background: colors.tagBg, color: colors.textLight, borderRadius: 8, padding: "1px 5px" }}>{threadCount}</span>}
                                          <span style={{ fontSize: 11, color: colors.textMuted }}>{dateStr}</span>
                                          {emailFolder !== "sent" && <button onClick={e => { e.stopPropagation(); togglePin(email.id); }} title={isPinned ? "Unpin" : "Pin"}
                                            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: isPinned ? colors.warning : colors.textMuted, padding: "0 2px", lineHeight: 1, display: "flex", alignItems: "center" }}>
                                            <Pin size={12} />
                                          </button>}
                                          <span style={{ color: colors.textMuted, display: "inline-flex", alignItems: "center" }}>{isSelected ? <ChevronUp size={11} /> : <ChevronDown size={11} />}</span>
                                        </div>
                                      </div>
                                      {/* Subject — bold, smaller; prepend Re: if thread has replies and subject doesn't already show it */}
                                      <div style={{ fontWeight: 600, fontSize: 12, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>
                                        {threadCount > 1 && !/(^re\s*:|^re\s*\[)/i.test(email.subject || "") && (
                                          <span style={{ fontWeight: 400, color: colors.textMuted }}>Re: </span>
                                        )}
                                        {email.subject || "(no subject)"}
                                      </div>
                                      {/* Snippet — plain, smaller, hidden when expanded */}
                                      {!isSelected && <div style={{ fontSize: 11, color: colors.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary || decodeEntities(email.snippet)}</div>}
                                    </div>
                                    </div>
                                  {isSelected && (() => {
                                    // Determine which message to display
                                    const nonSentMsgs = (email.threadMessages || []).filter(m => !m.isSent);
                                    const defaultMsgId = nonSentMsgs.slice(-1)[0]?.id || (email.threadMessages || []).slice(-1)[0]?.id;
                                    const activeMsgId = threadMsgSelected[email.id] || defaultMsgId;
                                    const activeMsg = (email.threadMessages || []).find(m => m.id === activeMsgId);
                                    const isThread = (email.threadMessages || []).length > 1;
                                    // When activeMsg exists, use its content exclusively — never fall back to
                                    // email.bodyHtml (that's the display message, would show a false duplicate)
                                    const bodyHtml = activeMsg ? (activeMsg.bodyHtml || "") : (email.bodyHtml || "");
                                    const bodyText = activeMsg ? (activeMsg.body || "") : (email.body || "");
                                    const activeMsgHistoryShown = emailHistoryExpanded.has(activeMsgId || email.id);
                                    const activeMsgHasHistory = activeMsg ? preprocessEmail({ bodyHtml: activeMsg.bodyHtml, body: activeMsg.body || "" })._hasHistory : email._hasHistory;
                                    const activeFromAddr = activeMsg?.from?.match(/<(.+)>/)?.[1] || activeMsg?.from || fromAddr;
                                    const activeFromName = resolveDisplayName(activeMsg?.from || email.from, contacts, students);

                                    return (
                                    <div style={{ padding: "12px 14px", background: colors.bg, borderBottom: idx < filteredEmails.length - 1 ? `1px solid ${colors.border}` : "none" }}
                                      onClick={e => e.stopPropagation()}>

                                      {/* Thread participant chips — most recent first, consecutive same-sender runs collapsed */}
                                      {isThread && (
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
                                          {(() => {
                                            const threadMsgsOrig = email.threadMessages || [];
                                            const reversed = [...threadMsgsOrig].reverse();
                                            // Collapse consecutive same-sender messages into one chip with a count,
                                            // unless one of those messages is the active one (always shown alone).
                                            const groups = [];
                                            for (const m of reversed) {
                                              const addr = m.from?.match(/<(.+)>/)?.[1] || m.from || m.isSent && "__you__" || "";
                                              const last = groups[groups.length - 1];
                                              if (last && last.addr === addr && !last.msgs.some(x => x.id === activeMsgId) && m.id !== activeMsgId) {
                                                last.msgs.push(m);
                                              } else {
                                                groups.push({ addr, msgs: [m] });
                                              }
                                            }
                                            return groups.map(({ msgs }, gi) => {
                                              const m = msgs[0];
                                              const name = resolveDisplayName(m.from, contacts, students);
                                              const isActive = msgs.some(msg => msg.id === activeMsgId);
                                              const count = msgs.length;
                                              // chipReplied: any message in this group was replied to
                                              const chipReplied = !m.isSent && msgs.some(msg => {
                                                const origIdx = threadMsgsOrig.findIndex(x => x.id === msg.id);
                                                const mDate = (() => {
                                                  if (msg.internalDate) return Number(msg.internalDate);
                                                  if (msg.date) { const t = new Date(msg.date).getTime(); if (!isNaN(t)) return t; }
                                                  return 0;
                                                })();
                                                const repliedInThread = threadMsgsOrig.some((other, j) => other.isSent && j > origIdx);
                                                const tid = email.threadId || email.id;
                                                const normSubj = (email.subject || "").replace(/^(re|fwd?):\s*/gi, "").trim().toLowerCase();
                                                const repliedViaSent = sentEmails.length > 0 && sentEmails.some(s => {
                                                  const sameThread = (s.threadId && s.threadId === email.threadId) ||
                                                    (normSubj && (s.subject || "").replace(/^(re|fwd?):\s*/gi, "").trim().toLowerCase() === normSubj) ||
                                                    (s.threadId || s.id) === tid;
                                                  if (!sameThread) return false;
                                                  if (!mDate) return true;
                                                  const sDate = Number(s.internalDate) || (s.date ? new Date(s.date).getTime() : 0) || 0;
                                                  return sDate > mDate;
                                                });
                                                return repliedInThread || repliedViaSent;
                                              });
                                              // Clicking a collapsed chip selects the most recent message in the group
                                              return (
                                                <button key={gi} onClick={e => { e.stopPropagation(); setThreadMsgSelected(prev => ({ ...prev, [email.id]: m.id })); }}
                                                  style={{ padding: "3px 10px", borderRadius: 12, border: isActive ? `1.5px solid ${colors.sidebarActive}` : `1.5px solid ${colors.border}`,
                                                    background: isActive ? colors.blueLight : m.isSent ? colors.bg : colors.cardBg,
                                                    color: isActive ? colors.sidebarActive : m.isSent ? colors.textMuted : colors.text,
                                                    fontSize: 11, fontWeight: isActive ? 700 : 400, cursor: "pointer", fontFamily: "inherit",
                                                    fontStyle: m.isSent ? "italic" : "normal",
                                                    display: "inline-flex", alignItems: "center", gap: 4 }}>
                                                  {chipReplied && <span title="Replied" style={{ fontSize: 10, opacity: 0.75, lineHeight: 1, display: "inline-flex", alignItems: "center" }}><Reply size={10} /></span>}
                                                  {m.isSent ? "You" : name}
                                                  {count > 1 && <span style={{ fontSize: 9, fontWeight: 700, background: isActive ? colors.sidebarActive : colors.border, color: isActive ? colors.white : colors.textMuted, borderRadius: 8, padding: "1px 5px", marginLeft: 1 }}>{count}</span>}
                                                </button>
                                              );
                                            });
                                          })()}
                                        </div>
                                      )}

                                      {/* Selected message sender line */}
                                      <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 8 }}>
                                        <span
                                          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setEmailContextMenu({ x: e.clientX, y: e.clientY, text: "", emailId: email.id, email, fromAddr: activeFromAddr, fromName: activeFromName, isSenderCtx: true }); }}
                                          style={{ fontWeight: 600, color: colors.text, cursor: "context-menu" }}>{activeFromName}</span>
                                        <span> &lt;{activeFromAddr}&gt;</span>
                                        {activeMsg?.to && <span style={{ marginLeft: 8, fontSize: 11 }}>To: {activeMsg.to}</span>}
                                        {(() => {
                                          const msgDate = activeMsg?.date || email.date;
                                          const d = msgDate ? new Date(msgDate) : null;
                                          if (!d || isNaN(d)) return null;
                                          const isToday = toLocalDateStr(d) === todayStr;
                                          const dayLabel = isToday ? "Today" : d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
                                          const timeLabel = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
                                          return <span style={{ marginLeft: 8, fontSize: 11 }}>{dayLabel} at {timeLabel}</span>;
                                        })()}                                      </div>

                                      {/* Thread participants note */}
                                      {!isThread && email.cc && (
                                        <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 8 }}>CC: {email.cc}</div>
                                      )}

                                      {/* Message body */}
                                      {(() => {
                                        const isWallOfText = bodyHtml && isPlainTextHtml(bodyHtml);
                                        const bodyContextHandlers = {
                                          onContextMenu: e => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            const sel = window.getSelection()?.toString().trim();
                                            if (sel) setEmailContextMenu({ x: e.clientX, y: e.clientY, text: sel, emailId: email.id, email, fromAddr: activeFromAddr, fromName: activeFromName });
                                          },
                                          onDragStart: () => {
                                            dragSourceEmailRef.current = { emailId: email.id, fromAddr: activeFromAddr, fromName: activeFromName };
                                          },
                                          onDragEnd: () => {
                                            setTimeout(() => { dragSourceEmailRef.current = null; }, 200);
                                          },
                                        };
                                        if (isWallOfText) {
                                          // Flat HTML — extract text, strip sig/history, reformat into paragraphs
                                          const rawText = (() => { try { return new DOMParser().parseFromString(bodyHtml, "text/html").body.textContent || ""; } catch { return bodyHtml; } })();
                                          const parts = getPlainParts(rawText);
                                          const formatted = formatWallOfText(parts.main);
                                          return (
                                            <div {...bodyContextHandlers}
                                              style={{ fontSize: 13, color: colors.text, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word", marginBottom: activeMsgHasHistory ? 4 : 12, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", userSelect: "text" }}>
                                              {formatted}
                                            </div>
                                          );
                                        }
                                        if (bodyHtml) {
                                          // Always render main content only — history is shown separately below the toggle button
                                          const cleanedHtml = getCleanHtml(bodyHtml, { showHistory: false, showSig: false, suppressPatterns });
                                          return (
                                            <iframe
                                              key={`${activeMsgId}-${suppressPatterns.length}`}
                                              srcDoc={cleanedHtml}
                                              sandbox="allow-same-origin"
                                              onLoad={e => {
                                                try {
                                                  const doc = e.target.contentDocument;
                                                  if (doc) {
                                                    e.target.style.height = doc.documentElement.scrollHeight + "px";
                                                    doc.querySelectorAll("a[href]").forEach(a => {
                                                      a.addEventListener("click", ev => {
                                                        ev.preventDefault();
                                                        const href = a.getAttribute("href");
                                                        if (href && window.electronAPI?.openExternal) window.electronAPI.openExternal(href);
                                                        else if (href) window.open(href, "_blank");
                                                      });
                                                    });
                                                  }
                                                } catch {}
                                              }}
                                              style={{
                                                width: "100%", minHeight: 80, border: "none", display: "block",
                                                marginBottom: activeMsgHasHistory ? 4 : 12,
                                                filter: darkMode ? "invert(1) hue-rotate(180deg)" : "none"
                                              }}
                                              title="email-body"
                                            />
                                          );
                                        }
                                        // Pure plain-text (no bodyHtml at all)
                                        const parts = email._plainParts || getPlainParts(bodyText);
                                        const formatted = formatWallOfText(parts.main || bodyText);
                                        return (
                                          <div {...bodyContextHandlers}
                                            style={{ fontSize: 13, color: colors.text, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word", marginBottom: 12, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", userSelect: "text" }}>
                                            {formatted}
                                          </div>
                                        );
                                      })()}

                                      {/* Attachment badges — click to preview, download icon to save */}
                                      {(activeMsg?.attachments || []).length > 0 && (
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8, marginTop: 4 }}>
                                          {(activeMsg.attachments).map((att, i) => (
                                            <div key={i}
                                              draggable
                                              onDragStart={() => { setAttachmentDragging({ att, messageId: activeMsg.messageId || activeMsg.id }); setTodoDropTarget(true); window._pendingAttachmentDrag = { att, messageId: activeMsg.messageId || activeMsg.id }; }}
                                              onDragEnd={() => { setAttachmentDragging(null); setTodoDropTarget(false); setTimeout(() => { window._pendingAttachmentDrag = null; }, 100); }}
                                              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setAttCtxMenu({ att, messageId: activeMsg.messageId || activeMsg.id, x: e.clientX, y: e.clientY }); }}
                                              style={{ display: "flex", alignItems: "stretch", border: `1px solid ${colors.border}`, borderRadius: 6, overflow: "hidden", fontSize: 11 }}>
                                              {/* Preview button */}
                                              <button
                                                onClick={e => { e.stopPropagation(); handlePreviewAttachment(att, activeMsg.messageId || activeMsg.id); }}
                                                title="Click to preview"
                                                style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 8px", background: colors.cardBg, border: "none", fontSize: 11, color: colors.textLight, cursor: "pointer", fontFamily: "inherit" }}
                                                onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                                                onMouseLeave={e => e.currentTarget.style.background = colors.cardBg}>
                                                <span style={{ display: "flex", alignItems: "center" }}><Paperclip size={13} /></span>
                                                <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.filename}</span>
                                                {att.size > 0 && <span style={{ color: colors.textMuted, flexShrink: 0 }}>{att.size > 1024*1024 ? `${(att.size/1024/1024).toFixed(1)}MB` : `${Math.round(att.size/1024)}KB`}</span>}
                                              </button>
                                              {/* Download button */}
                                              <button
                                                onClick={e => {
                                                  e.stopPropagation();
                                                  if (window.electronAPI?.gmailGetAttachment) {
                                                    window.electronAPI.gmailGetAttachment(activeMsg.messageId || activeMsg.id, att.attachmentId, att.filename)
                                                      .then(r => { if (!r.ok && r.error !== "Cancelled") alert("Download failed: " + r.error); });
                                                  }
                                                }}
                                                title="Download"
                                                style={{ padding: "3px 7px", background: colors.tagBg, border: "none", borderLeft: `1px solid ${colors.border}`, cursor: "pointer", display: "flex", alignItems: "center", color: colors.textMuted }}
                                                onMouseEnter={e => { e.currentTarget.style.background = colors.bg; e.currentTarget.style.color = colors.text; }}
                                                onMouseLeave={e => { e.currentTarget.style.background = colors.tagBg; e.currentTarget.style.color = colors.textMuted; }}>
                                                <Download size={11} />
                                              </button>
                                            </div>
                                          ))}
                                        </div>
                                      )}

                                      {/* History toggle — sits between main body and quoted replies */}
                                      {activeMsgHasHistory && (
                                        <div style={{ display: "flex", gap: 6, marginBottom: activeMsgHistoryShown ? 6 : 10 }}>
                                          <button onClick={e => {
                                            e.stopPropagation();
                                            const id = activeMsgId || email.id;
                                            setEmailHistoryExpanded(prev => { const next = new Set(prev); activeMsgHistoryShown ? next.delete(id) : next.add(id); return next; });
                                          }}
                                            style={{ background: "none", border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 11, color: colors.textMuted, cursor: "pointer", padding: "2px 10px", fontFamily: "inherit" }}>
                                            {activeMsgHistoryShown ? "▾ Hide previous messages" : "▸ Show previous messages"}
                                          </button>
                                        </div>
                                      )}

                                      {/* History content — rendered in a separate iframe below the toggle */}
                                      {activeMsgHasHistory && activeMsgHistoryShown && (() => {
                                        if (bodyHtml) {
                                          const historyHtml = (() => {
                                            try {
                                              const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
                                              const quote = doc.querySelector('.gmail_quote') || doc.querySelector('blockquote');
                                              if (!quote) return null;
                                              const bg = darkMode ? "#1a1a2e" : "#ffffff";
                                              const fg = darkMode ? "#aaaaaa" : "#666666";
                                              return `<html><head><style>*{box-sizing:border-box;}body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:${fg};background:${bg};}blockquote{margin:4px 0 0 6px;padding-left:10px;border-left:2px solid #ccc;color:${fg};}a{color:inherit;pointer-events:none;}</style></head><body>${quote.outerHTML}</body></html>`;
                                            } catch { return null; }
                                          })();
                                          if (historyHtml) return (
                                            <iframe
                                              key={`${activeMsgId}-history`}
                                              srcDoc={historyHtml}
                                              sandbox="allow-same-origin"
                                              onLoad={e => {
                                                try { if (e.target.contentDocument) e.target.style.height = e.target.contentDocument.documentElement.scrollHeight + "px"; } catch {}
                                              }}
                                              style={{ width: "100%", border: "none", display: "block", marginBottom: 10 }}
                                              title="email-history"
                                            />
                                          );
                                        }
                                        // Plain-text fallback
                                        const historyText = (() => {
                                          const src = bodyText || "";
                                          const idx = src.search(/\nOn .+wrote:/s);
                                          return idx > 0 ? src.slice(idx + 1).trim() : "";
                                        })();
                                        if (!historyText) return null;
                                        return (
                                          <div style={{ fontSize: 12, color: colors.textMuted, whiteSpace: "pre-wrap", lineHeight: 1.6, marginBottom: 10, paddingLeft: 10, borderLeft: `2px solid ${colors.border}`, wordBreak: "break-word" }}>
                                            {historyText}
                                          </div>
                                        );
                                      })()}

                                      {/* Suggested reply draft */}
                                      {draft && (
                                        <div style={{ background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, padding: "10px 12px", marginBottom: 10, fontSize: 13, color: colors.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                                          <div style={{ fontSize: 11, fontWeight: 700, color: colors.accent, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>✦ Suggested reply</div>
                                          {draft}
                                        </div>
                                      )}

                                      {/* Response flagged chip — dismissible */}
                                      {needsReply && !isReplied && !emailNoReplyOverrides.has(email.id) && (
                                        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", background: darkMode ? "rgba(196,122,106,0.18)" : colors.redLight, border: `1px solid ${colors.accent}`, borderRadius: 20, marginBottom: 10, alignSelf: "flex-start" }}>
                                          <span style={{ fontSize: 11, color: darkMode ? colors.accent : colors.accentDark, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4 }}><Reply size={11} /> Response flagged</span>
                                          <button onMouseDown={e => e.preventDefault()} onClick={() => {
                                            const next = new Set(emailNoReplyOverrides); next.add(email.id);
                                            setEmailNoReplyOverrides(next);
                                            try { localStorage.setItem(STORAGE_KEYS.emailNoReplyOverrides, JSON.stringify([...next])); } catch {}
                                          }} style={{ background: "none", border: "none", cursor: "pointer", color: darkMode ? colors.accent : colors.accentDark, fontSize: 13, lineHeight: 1, padding: 0, opacity: 0.7, display: "flex", alignItems: "center" }}><X size={12} /></button>
                                        </div>
                                      )}

                                      {/* Action buttons */}
                                      {/* ── Scheduled lessons strip ── */}
                                      {emailFolder !== "sent" && (() => {
                                        // Use the active message sender (follows chip selection in group threads)
                                        const activeSender = (activeMsg?.from?.match(/<(.+)>/)?.[1] || activeMsg?.from || email.from?.match(/<(.+)>/)?.[1] || email.from || "").toLowerCase();
                                        const linkedStudents = students.filter(s =>
                                          (s.parents || []).some(p => p.email?.toLowerCase() === activeSender)
                                        );
                                        if (linkedStudents.length === 0) return null;
                                        // Prefer this week's weekly timetable; fall back to master
                                        const currentMonday = toLocalDateStr(getCurrentWeekMonday());
                                        const weeklyLessons = linkedStudents.flatMap(s => {
                                          const key = `${currentMonday}|${s.schoolId}`;
                                          return (weeklyTimetables[key]?.lessons || []).filter(l => l.studentId === s.id);
                                        });
                                        const masterLessons = (timetable?.lessons || []).filter(l =>
                                          linkedStudents.some(s => s.id === l.studentId)
                                        );
                                        // Use weekly if we have data for at least one of their schools this week,
                                        // otherwise fall back to master
                                        const hasWeeklyData = linkedStudents.some(s =>
                                          weeklyTimetables[`${currentMonday}|${s.schoolId}`]
                                        );
                                        const lessons = hasWeeklyData ? weeklyLessons : masterLessons;
                                        // Show students with no lesson: pending/trial always; active if they have no scheduled slot
                                        const pendingTrialWithoutLesson = linkedStudents.filter(s =>
                                          !lessons.some(l => l.studentId === s.id) &&
                                          (s.status === "pending" || s.status === "trial" ||
                                           (s.status === "active"))
                                        );
                                        if (lessons.length === 0 && pendingTrialWithoutLesson.length === 0) return null;
                                        return (
                                          <div style={{ marginBottom: 10, padding: "8px 12px", background: colors.blueLight, borderRadius: 8, border: `1px solid ${colors.sidebarActive}30`, cursor: "pointer" }}
                                            onClick={() => { const school = schools.find(s => s.id === (lessons[0] || linkedStudents[0])?.schoolId); if (school) { setSharedSchool(school.id); onNavigate(hasWeeklyData ? "weekly" : "timetable"); } }}
                                            onMouseEnter={e => e.currentTarget.style.opacity = "0.85"}
                                            onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
                                            <div style={{ fontSize: 11, fontWeight: 700, color: colors.sidebarActive, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5, display: "flex", alignItems: "center", gap: 5 }}>
                                              <CalendarDays size={12} /> {hasWeeklyData ? "This week's lessons" : "Scheduled lessons"} <ExternalLink size={11} />
                                            </div>
                                            {lessons.map(l => {
                                              const st = linkedStudents.find(s => s.id === l.studentId);
                                              const school = schools.find(s => s.id === l.schoolId);
                                              // Pair this week's slot with the regular Master-Timetable slot
                                              // (matched by student + instrument) and flag if it changed.
                                              const regular = (timetable?.lessons || []).find(r => r.studentId === l.studentId && (r.instrument || "").trim().toLowerCase() === (l.instrument || "").trim().toLowerCase()) || null;
                                              const { thisWeekStr, regularStr, changed } = lessonChangeInfo(l, regular, hasWeeklyData);
                                              return (
                                                <div key={l.id}
                                                  onClick={e => { e.stopPropagation(); if (school) { setSharedSchool(school.id); onNavigate(hasWeeklyData ? "weekly" : "timetable"); } }}
                                                  style={{ fontSize: 12, color: colors.text, lineHeight: 1.6, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                                                  <strong>{st?.name}</strong> — {l.instrument}
                                                  {hasWeeklyData
                                                    ? <> · this week {thisWeekStr} · {regular ? `regular ${regularStr}` : <span style={{ color: colors.textMuted }}>no regular slot</span>}</>
                                                    : <> · {l.day} {l.start}</>}
                                                  {changed && (
                                                    <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10, background: "rgba(217,119,6,0.12)", color: "#D97706", textTransform: "uppercase", letterSpacing: "0.04em" }}>Changed</span>
                                                  )}
                                                  {school && lessons.some((x, i) => i > 0 && x.schoolId !== lessons[0].schoolId) ? <span style={{ color: colors.textMuted }}> · {school.name}</span> : null}
                                                </div>
                                              );
                                            })}
                                            {pendingTrialWithoutLesson.map(s => (
                                              <div key={s.id}
                                                onClick={e => { e.stopPropagation(); onViewStudent && onViewStudent(s.id); }}
                                                style={{ fontSize: 12, color: colors.text, lineHeight: 1.6, display: "flex", alignItems: "center", gap: 6 }}>
                                                <strong>{s.name}</strong>
                                                <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10,
                                                  background: s.status === "trial" ? "rgba(124,58,237,0.12)" : s.status === "pending" ? "rgba(217,119,6,0.12)" : "rgba(100,116,139,0.12)",
                                                  color: s.status === "trial" ? "#7C3AED" : s.status === "pending" ? "#D97706" : colors.textMuted,
                                                  textTransform: "uppercase", letterSpacing: "0.04em" }}>
                                                  {s.status === "trial" ? "Trial" : s.status === "pending" ? "Pending" : "Unscheduled"}
                                                </span>
                                                {(() => { const _ins = instrumentsFromEnrolments(s.id, enrolments); return _ins.length > 0 && <span style={{ color: colors.textMuted }}>— {_ins.map(i => i.name).join(", ")}</span>; })()}
                                              </div>
                                            ))}
                                          </div>
                                        );
                                      })()}
                                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                        {emailFolder !== "sent" && <Btn onClick={() => { openCompose([activeFromAddr], { from: schoolSenderForSourceEmail(email, schools) || "", subject: reSubject(email.subject), body: draft || "", threadMessages: email.threadMessages }); markRead(email.id); }} style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}><Mail size={12} /> Reply{draft ? " with draft" : ""}</Btn>}
                                        {emailFolder !== "sent" && allRecipients.length > 1 && (
                                          <Btn variant="secondary" onClick={() => { openCompose(allRecipients, { from: schoolSenderForSourceEmail(email, schools) || "", subject: reSubject(email.subject), body: draft || "" }); markRead(email.id); }} style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}><Mail size={12} /> Reply All</Btn>
                                        )}
                                        {emailFolder !== "sent" && (
                                          <Btn variant="secondary" onClick={() => {
                                            const fwdBody = `<br><br><div style="border-left:2px solid #ccc;padding-left:12px;margin-top:8px;color:#999;font-size:12px"><div><strong>Forwarded message</strong> &nbsp;·&nbsp; From: ${activeFromName} &lt;${activeFromAddr}&gt; &nbsp;·&nbsp; Subject: ${email.subject || ""}</div><br>${bodyHtml || (bodyText || "").replace(/\n/g, "<br>") || ""}</div>`;
                                            openCompose([], { from: schoolSenderForSourceEmail(email, schools) || "", subject: fwdSubject(email.subject), body: fwdBody });
                                          }} style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}><Reply size={12} style={{ transform: "scaleX(-1)" }} /> Fwd</Btn>
                                        )}
                                        {emailFolder !== "sent" && <Btn variant="secondary" onClick={() => triageEmail(email)} disabled={isTriaging} style={{ fontSize: 12 }}>{isTriaging ? "✦ Drafting…" : draft ? "✦ Re-draft" : "✦ Triage"}</Btn>}
                                        {emailFolder !== "sent" && <Btn variant="secondary" onClick={() => {
                                          saveTodo(dropEmailToTodo(email, todoItemsRef.current));
                                          if (!dashPanels.todo) saveDashPanels({ ...dashPanels, todo: true });
                                        }} style={{ fontSize: 12 }}>+ To Do</Btn>}
                                        {/* Move To — shows current category, opens popup */}
                                        {emailFolder !== "sent" && (() => {
                                          const MOVE_LABELS = { parent: "Parent", teacher: "Teacher", staff: "Staff", admin: "Admin", enquiry: "Enquiry", other: "Other" };
                                          const currentLabel = MOVE_LABELS[category] || "Other";
                                          const isOpen = emailMoveToOpen === email.id;
                                          const MOVE_CATS = ["parent", "teacher", "staff", "admin", "enquiry", "other"];
                                          return (
                                            <div style={{ position: "relative" }}>
                                              <Btn variant="secondary" onClick={e => { e.stopPropagation(); setEmailMoveToOpen(isOpen ? null : email.id); }} style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
                                                <Folder size={12} /> {currentLabel} {emailCategoryOverrides[email.id] ? <CircleDot size={8} /> : ""}
                                              </Btn>
                                              {isOpen && (
                                                <>
                                                  <div onClick={() => setEmailMoveToOpen(null)} style={{ position: "fixed", inset: 0, zIndex: 9997 }} />
                                                  <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, zIndex: 9998, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.13)", minWidth: 130, overflow: "hidden", fontFamily: "inherit" }}>
                                                    {MOVE_CATS.map(cat => (
                                                      <button key={cat} onClick={() => {
                                                        const next = { ...emailCategoryOverrides };
                                                        if (cat === category && !emailCategoryOverrides[email.id]) { /* no change */ }
                                                        else if (cat === category) { delete next[email.id]; }
                                                        else { next[email.id] = cat; }
                                                        setEmailCategoryOverrides(next);
                                                        try { localStorage.setItem(STORAGE_KEYS.emailCategoryOverrides, JSON.stringify(next)); } catch {}
                                                        setEmailMoveToOpen(null);
                                                      }} style={{ display: "block", width: "100%", padding: "8px 14px", background: cat === category ? colors.blueLight : "none", border: "none", textAlign: "left", cursor: "pointer", fontSize: 12, color: cat === category ? colors.sidebarActive : colors.text, fontWeight: cat === category ? 700 : 400, fontFamily: "inherit" }}
                                                        onMouseEnter={e => { if (cat !== category) e.currentTarget.style.background = colors.blueLight; }}
                                                        onMouseLeave={e => { if (cat !== category) e.currentTarget.style.background = "none"; }}>
                                                        {MOVE_LABELS[cat]}{emailCategoryOverrides[email.id] === cat ? " ●" : ""}
                                                      </button>
                                                    ))}
                                                    {emailCategoryOverrides[email.id] && (
                                                      <button onClick={() => {
                                                        const next = { ...emailCategoryOverrides }; delete next[email.id];
                                                        setEmailCategoryOverrides(next);
                                                        try { localStorage.setItem(STORAGE_KEYS.emailCategoryOverrides, JSON.stringify(next)); } catch {}
                                                        setEmailMoveToOpen(null);
                                                      }} style={{ display: "block", width: "100%", padding: "8px 14px", background: "none", border: "none", borderTop: `1px solid ${colors.border}`, textAlign: "left", cursor: "pointer", fontSize: 11, color: colors.textMuted, fontFamily: "inherit" }}
                                                        onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                                                        onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                                        <RotateCcw size={11} /> Reset to auto
                                                      </button>
                                                    )}
                                                  </div>
                                                </>
                                              )}
                                            </div>
                                          );
                                        })()}
                                        {emailFolder !== "sent" && <Btn variant="secondary" onClick={() => {
                                          markArchived(email.id);
                                          setInboxEmails(prev => { const next = prev.filter(em => em.id !== email.id); saveInboxCache(next); return next; });
                                          setInboxSelected(null);
                                          if (window.electronAPI?.gmailArchive) window.electronAPI.gmailArchive(email.id).catch(() => {});
                                        }} style={{ fontSize: 12, color: colors.danger, borderColor: `${colors.danger}50` }}>Archive</Btn>}
                                      </div>
                                    </div>
                                    );
                                  })()}
                                </div>
                              </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── Bulk action bar — appears when emails are selected ── */}
                  {emailSelectedIds.size > 0 && dashPanels.emails && (() => {
                    const selectedEmails = filteredEmails.filter(e => emailSelectedIds.has(e.id));
                    const allRead = selectedEmails.every(e => emailReadIds.has(e.id));
                    const MOVE_LABELS = { parent: "Parent", teacher: "Teacher", staff: "Staff", admin: "Admin", enquiry: "Enquiry", other: "Other" };
                    const MOVE_CATS = ["parent", "teacher", "staff", "admin", "enquiry", "other"];
                    return (
                      <div style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 200,
                        background: colors.sidebarHover, borderRadius: 10, padding: "10px 14px",
                        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                        boxShadow: "0 4px 20px rgba(0,0,0,0.25)", minWidth: 360, maxWidth: "80vw" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", marginRight: 4 }}>
                          {emailSelectedIds.size} selected
                        </span>
                        {/* Mark read/unread */}
                        <button onClick={() => {
                          const next = new Set(emailReadIds);
                          selectedEmails.forEach(e => allRead ? next.delete(e.id) : next.add(e.id));
                          setEmailReadIds(next);
                          try { localStorage.setItem(STORAGE_KEYS.inboxReadIds, JSON.stringify([...next])); } catch {}
                        }} style={{ padding: "4px 11px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.25)", background: "none", color: "#fff", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                          {allRead ? "Mark Unread" : "Mark Read"}
                        </button>
                        {/* Move To */}
                        <div style={{ position: "relative" }}>
                          <button onClick={() => setBulkMoveOpen(v => !v)}
                            style={{ padding: "4px 11px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.25)", background: "none", color: "#fff", fontSize: 12, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}>
                            <Folder size={12} /> Move To <ChevronDown size={11} />
                          </button>
                          {bulkMoveOpen && (
                            <>
                              <div onClick={() => setBulkMoveOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 9997 }} />
                              <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, zIndex: 9998, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.13)", minWidth: 130, overflow: "hidden" }}>
                                {MOVE_CATS.map(cat => (
                                  <button key={cat} onClick={() => {
                                    const next = { ...emailCategoryOverrides };
                                    selectedEmails.forEach(e => { next[e.id] = cat; });
                                    setEmailCategoryOverrides(next);
                                    try { localStorage.setItem(STORAGE_KEYS.emailCategoryOverrides, JSON.stringify(next)); } catch {}
                                    setBulkMoveOpen(false);
                                    setEmailSelectedIds(new Set());
                                  }} style={{ display: "block", width: "100%", padding: "8px 14px", background: "none", border: "none", textAlign: "left", cursor: "pointer", fontSize: 12, color: colors.text, fontFamily: "inherit" }}
                                    onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                                    onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                    {MOVE_LABELS[cat]}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                        {/* Add to To Do */}
                        <button
                          draggable
                          onDragStart={() => { setEmailDragging(selectedEmails); setTodoDropTarget(true); }}
                          onDragEnd={() => { setEmailDragging(null); setTodoDropTarget(false); }}
                          onClick={() => {
                            saveTodo(dropMultipleEmailsToTodo(selectedEmails, todoItemsRef.current));
                            if (!dashPanels.todo) saveDashPanels({ ...dashPanels, todo: true });
                            setEmailSelectedIds(new Set());
                          }}
                          style={{ padding: "4px 11px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.25)", background: "none", color: "#fff", fontSize: 12, cursor: "grab", fontFamily: "inherit" }}>
                          + To Do
                        </button>
                        {/* Archive all */}
                        <button onClick={() => {
                          selectedEmails.forEach(e => {
                            markArchived(e.id);
                            if (window.electronAPI?.gmailArchive) window.electronAPI.gmailArchive(e.id).catch(() => {});
                          });
                          setInboxEmails(prev => { const next = prev.filter(e => !emailSelectedIds.has(e.id)); saveInboxCache(next); return next; });
                          setInboxSelected(null);
                          setEmailSelectedIds(new Set());
                        }} style={{ padding: "4px 11px", borderRadius: 6, border: `1px solid ${colors.danger}80`, background: "none", color: colors.danger, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                          Archive all
                        </button>
                        {/* Clear selection */}
                        <button onClick={() => { setEmailSelectedIds(new Set()); setBulkMoveOpen(false); }}
                          style={{ marginLeft: "auto", background: "none", border: "none", color: "rgba(255,255,255,0.5)", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: "0 2px", display: "flex", alignItems: "center" }}><X size={14} /></button>
                      </div>
                    );
                  })()}

                  {/* ── To Do panel ── */}
                  {dashPanels.todo && (
                    <div style={{ flex: bothOpen ? 1 - splitRatio : 1, minWidth: 0,
                      background: todoDropTarget && emailDragging ? colors.accentLight : "transparent", transition: "background 0.15s" }}
                      onDragEnter={e => { e.preventDefault(); if (emailDragging || alertDragging) setTodoDropTarget(true); }}
                      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = emailDragging || alertDragging ? "move" : "none"; }}
                      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setTodoDropTarget(false); }}
                      onDrop={e => {
                        e.preventDefault();
                        // Sub-item dragged out of group — promote to standalone
                        if (todoSubDragRef.current) {
                          ungroupSub();
                          setTodoDropTarget(false);
                          return;
                        }
                        // Attachment dropped onto todo — create a simple filename item
                        if (attachmentDragging) {
                          const { att } = attachmentDragging;
                          saveTodo([{ id: uid(), text: att.filename, done: false, tag: "admin", createdAt: new Date().toISOString() }, ...todoItemsRef.current]);
                          setAttachmentDragging(null); setTodoDropTarget(false);
                          return;
                        }
                        if (alertDragging) {
                          saveTodo(handleAlertDrop(alertDragging, todoItems));
                          setAlertDragging(null); setTodoDropTarget(false);
                          if (!dashPanels.todo) saveDashPanels({ ...dashPanels, todo: true });
                          return;
                        }
                        if (!emailDragging) return;
                        const result = Array.isArray(emailDragging)
                          ? dropMultipleEmailsToTodo(emailDragging, todoItemsRef.current)
                          : dropEmailToTodo(emailDragging, todoItemsRef.current);
                        if (result !== todoItems && todoDropZoneIdx === -1) {
                          // Bottom zone — move newly added item to end
                          const active = result.filter(t => !t.done);
                          const done = result.filter(t => t.done);
                          const [first, ...rest] = active;
                          saveTodo([...rest, first, ...done]);
                        } else {
                          saveTodo(result);
                        }
                        setEmailDragging(null); setTodoDropTarget(false);
                      }}>
                      <div style={{ padding: "12px 16px 9px" }}>
                        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                          <div style={{ flex: 1, position: "relative" }}>
                            <input ref={todoInputRef} value={todoInput}
                              onChange={e => {
                                const val = e.target.value;
                                setTodoInput(val);
                                const cursor = e.target.selectionStart;
                                const before = val.slice(0, cursor);
                                const m = before.match(/@([\w ]*)$/);
                                if (m) {
                                  const rect = e.target.getBoundingClientRect();
                                  setTodoMentionQuery({ query: m[1], anchorPos: cursor - m[0].length, field: "main", top: rect.bottom + 4, left: rect.left, width: rect.width });
                                  setTodoMentionIndex(0);
                                } else { setTodoMentionQuery(null); }
                              }}
                              onKeyDown={e => {
                                if (todoMentionQuery?.field === "main") {
                                  const hits = allEmailContacts.filter(c => c.name.toLowerCase().includes(todoMentionQuery.query.toLowerCase()) || (c.sub||"").toLowerCase().includes(todoMentionQuery.query.toLowerCase())).slice(0, 6);
                                  if (e.key === "ArrowDown") { e.preventDefault(); setTodoMentionIndex(i => Math.min(i+1, hits.length-1)); return; }
                                  if (e.key === "ArrowUp")   { e.preventDefault(); setTodoMentionIndex(i => Math.max(i-1, 0)); return; }
                                  if (e.key === "Enter" && hits.length) {
                                    e.preventDefault();
                                    const c = hits[todoMentionIndex] || hits[0];
                                    const mq = todoMentionQuery;
                                    const tag = preferredFirstName(c.name) || c.name.split(" ")[0];
                                    setTodoInput(prev => prev.slice(0, mq.anchorPos) + `@${tag}` + prev.slice(mq.anchorPos + mq.query.length + 1));
                                    setTodoAddMentions(prev => [...prev.filter(m => m.name !== tag), { name: tag, email: c.email }]);
                                    setTodoMentionQuery(null); setTodoMentionIndex(0); return;
                                  }
                                  if (e.key === "Escape") { setTodoMentionQuery(null); return; }
                                }
                                if (e.key === "Enter" && todoInput.trim()) {
                                  const item = { id: uid(), text: todoInput.trim(), done: false, tag: "manual", createdAt: new Date().toISOString() };
                                  if (todoAddMentions.length) item.mentions = todoAddMentions;
                                  saveTodo([item, ...todoItems]);
                                  setTodoInput(""); setTodoAddMentions([]); setTodoMentionQuery(null);
                                }
                              }}
                              placeholder="Add a task… (press Enter)"
                              style={{ width: "100%", boxSizing: "border-box", padding: "6px 28px 6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", color: colors.text, outline: "none", background: colors.cardBg }} />
                            {todoInput && (
                              <button onClick={() => setTodoInput("")}
                                style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: colors.textMuted, lineHeight: 1, padding: 0, display: "flex", alignItems: "center" }}><X size={12} /></button>
                            )}
                          </div>
                        </div>
                        {(emailDragging || alertDragging) && (
                          <div style={{ padding: "10px", border: `2px dashed ${colors.accent}`, borderRadius: 8, marginBottom: 10, textAlign: "center", fontSize: 12, color: colors.accent, fontWeight: 600 }}>
                            Drop here to add as task
                          </div>
                        )}
                        {todoCategories.length > 0 && (
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 0, paddingTop: 2, alignItems: "center" }}>
                            {todoCategories.map(cat => {
                              const active = todoFilterCategory.has(cat.id);
                              return <button key={cat.id} onClick={() => setTodoFilterCategory(prev => { const next = new Set(prev); active ? next.delete(cat.id) : next.add(cat.id); return next; })}
                                style={{ padding: "3px 9px", borderRadius: 12, border: active ? `1.5px solid ${cat.color}` : `1.5px solid ${colors.border}`, background: active ? `${cat.color}18` : colors.cardBg, color: active ? cat.color : colors.textMuted, fontSize: 11, fontWeight: active ? 700 : 400, cursor: "pointer", fontFamily: "inherit" }}>{cat.name}</button>;
                            })}
                            {(() => { const active = todoFilterCategory.has("__other__"); return (
                              <button onClick={() => setTodoFilterCategory(prev => { const next = new Set(prev); active ? next.delete("__other__") : next.add("__other__"); return next; })}
                                style={{ padding: "3px 9px", borderRadius: 12, border: active ? `1.5px solid ${colors.textMuted}` : `1.5px solid ${colors.border}`, background: active ? `${colors.textMuted}18` : colors.cardBg, color: colors.textMuted, fontSize: 11, fontWeight: active ? 700 : 400, cursor: "pointer", fontFamily: "inherit" }}>Other</button>
                            ); })()}
                          </div>
                        )}
                      </div>
                      <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 280px)", padding: "0 16px 12px" }}
                        onMouseEnter={e => { hoveredScrollRef.current = e.currentTarget; }}
                        onMouseLeave={() => { hoveredScrollRef.current = null; }}>
                        {activeTodo.length === 0 && doneTodo.length === 0 ? (
                          <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "6px 0" }}>No tasks yet. Add one above or drag an email here.</div>
                        ) : (
                          <div>
                            {displayActiveTodo.map((item, idx) => {
                              const catObj = item.category ? todoCategories.find(c => c.id === item.category) : null;
                              const TAG_COLORS = { email: { bg: colors.accentLight, color: colors.accentDark }, manual: { bg: colors.tagBg, color: colors.textLight }, interruption: { bg: "#FFF7ED", color: colors.warning }, lesson: { bg: "#F0FDF4", color: colors.success }, admin: { bg: colors.tagBg, color: colors.textLight } };
                              const tc = TAG_COLORS[item.tag] || TAG_COLORS.manual;
                              const hasSubItems = Array.isArray(item.subItems) && item.subItems.length > 0;
                              const isExpanded = todoExpanded.has(item.id);
                              const toggleExpand = (e) => {
                                if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON" || e.target.tagName === "TEXTAREA") return;
                                setTodoExpanded(prev => { const next = new Set(prev); isExpanded ? next.delete(item.id) : next.add(item.id); return next; });
                              };
                              const sourceEmail = item.emailId ? inboxEmails.find(e => e.id === item.emailId) : null;
                              const sourceFromName = sourceEmail?.from?.includes("<") ? sourceEmail.from.split("<")[0].trim().replace(/^"|"$/g, "") : sourceEmail?.from || null;
                              const createdAt = item.createdAt ? new Date(item.createdAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null;

                              // groupEmail: merge an email drag into this item
                              const groupEmail = (email) => {
                                const fromName = email.from?.includes("<") ? email.from.split("<")[0].trim().replace(/^"|"$/g,"") : (email.from || "Unknown");
                                const newSubItem = { id: uid(), text: `Reply to ${fromName} — ${email.subject || "(no subject)"}`, done: false, emailId: email.id };
                                const prevSubItems = item.subItems || [{ id: uid(), text: item.text, done: false, emailId: item.emailId, meta: item.meta }];
                                const newSubItems = [...prevSubItems, newSubItem];
                                const newText = `${item.text.replace(/\s*\+\d+$/, "")} +${newSubItems.length - 1}`;
                                saveTodo(todoItemsRef.current.map(t => t.id === item.id ? { ...t, text: newText, subItems: newSubItems } : t));
                              };

                              // groupTodo: merge another todo into this item on drop
                              const groupTodo = (srcIdx) => {
                                const items = todoItemsRef.current;
                                const active = items.filter(t => !t.done);
                                const done = items.filter(t => t.done);
                                const dragged = active[srcIdx];
                                if (!dragged || dragged.id === item.id) return;
                                const newSubItem = { id: dragged.id, text: dragged.text, done: false, emailId: dragged.emailId, meta: dragged.meta, tag: dragged.tag };
                                const prevSubItems = item.subItems || [{ id: uid(), text: item.text, done: false, emailId: item.emailId, meta: item.meta }];
                                const newSubItems = [...prevSubItems, newSubItem];
                                const newText = `${item.text.replace(/\s*\+\d+$/, "")} +${newSubItems.length - 1}`;
                                const merged = active.filter((_, i) => i !== srcIdx).map(t => t.id === item.id ? { ...t, text: newText, subItems: newSubItems } : t);
                                saveTodo([...merged, ...done]);
                              };


                              return (
                                <React.Fragment key={item.id}>
                                  <div style={{ marginBottom: 2 }}>
                                  {/* Item card */}
                                  {(() => {
                                    const ol = todoOverdueLevel(item); // always 0 — kept for any downstream refs
                                    const cardBg     = catObj ? `${catObj.color}12` : "rgba(52,69,101,0.1)";
                                    const cardBorder = catObj ? `${catObj.color}50` : "rgba(52,69,101,0.1)";
                                    const overdueBadge = null;
                                  return (
                                  <div
                                    draggable={todoEditId !== item.id}
                                    onDragStart={e => {
                                      e.stopPropagation();
                                      const origIdx = activeTodo.findIndex(t => t.id === item.id);
                                      setTodoDragIdx(origIdx); todoDragIdxRef.current = origIdx;
                                      todoDragItemIdRef.current = item.id;
                                      setTodoDragHoverItemId(item.id);
                                      todoDragHoverIdxRef.current = origIdx;
                                    }}
                                    onDragEnd={e => {
                                      e.stopPropagation();
                                      setTodoDragIdx(null); todoDragIdxRef.current = null;
                                      todoDragItemIdRef.current = null;
                                      setTodoDragHoverItemId(null); todoDragHoverIdxRef.current = null;
                                      setTodoDropZoneIdx(null);
                                    }}
                                    onDragOver={e => {
                                      e.preventDefault(); e.stopPropagation();
                                      if (emailDragging || alertDragging) { e.dataTransfer.dropEffect = "move"; return; }
                                      if (todoDragItemIdRef.current === null) return;
                                      e.dataTransfer.dropEffect = "move";
                                      if (todoDragHoverIdxRef.current !== idx) {
                                        setTodoDragHoverItemId(item.id);
                                        todoDragHoverIdxRef.current = idx;
                                      }
                                    }}
                                    onDrop={e => {
                                      e.preventDefault(); e.stopPropagation();
                                      setTodoDropZoneIdx(null);
                                      // Sub-item dragged out of group onto another item
                                      if (todoSubDragRef.current) { ungroupSub(); return; }
                                      if (emailDragging) {
                                        if (Array.isArray(emailDragging)) { saveTodo(dropMultipleEmailsToTodo(emailDragging, todoItemsRef.current)); }
                                        else { groupEmail(emailDragging); }
                                        setEmailDragging(null); setTodoDropTarget(false);
                                        setTodoDragHoverItemId(null); todoDragHoverIdxRef.current = null;
                                        return;
                                      }
                                      if (alertDragging) return;
                                      const srcIdx = todoDragIdxRef.current;
                                      const hoverIdx = todoDragHoverIdxRef.current;
                                      setTodoDragIdx(null); todoDragIdxRef.current = null; todoDragItemIdRef.current = null;
                                      setTodoDragHoverItemId(null); todoDragHoverIdxRef.current = null;
                                      if (srcIdx === null || hoverIdx === null || srcIdx === hoverIdx) return;
                                      // Reorder: commit the current preview order
                                      const items = todoItemsRef.current;
                                      const active = items.filter(t => !t.done);
                                      const done = items.filter(t => t.done);
                                      const arr = [...active];
                                      const [moved] = arr.splice(srcIdx, 1);
                                      arr.splice(hoverIdx, 0, moved);
                                      saveTodo([...arr, ...done]);
                                    }}
                                    onClick={e => {
                                      if (e.shiftKey) {
                                        e.preventDefault(); e.stopPropagation();
                                        setTodoSelectedIds(prev => {
                                          const next = new Set(prev);
                                          next.has(item.id) ? next.delete(item.id) : next.add(item.id);
                                          return next;
                                        });
                                        return;
                                      }
                                      toggleExpand(e);
                                    }}
                                    onContextMenu={e => {
                                      e.preventDefault(); e.stopPropagation();
                                      setTodoContextMenu({ x: e.clientX, y: e.clientY, itemId: item.id });
                                    }}
                                    style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px",
                                      borderRadius: isExpanded ? "8px 8px 0 0" : 8,
                                      background: todoSelectedIds.has(item.id) ? (darkMode ? `${colors.sidebarActive}66` : colors.blueLight) : cardBg,
                                      border: "none",
                                      borderLeft: todoSelectedIds.has(item.id)
                                        ? `4px solid ${colors.sidebarActive}`
                                        : hasSubItems ? `4px solid ${colors.accent}` : `3px solid ${cardBorder}`,
                                      borderBottom: isExpanded ? `1px solid ${colors.accent}22` : undefined,
                                      opacity: todoDragItemIdRef.current === item.id ? 0.3 : 1,
                                      transition: "opacity 0.1s, background 0.15s, border-left 0.15s",
                                      cursor: "grab" }}>
                                    <input type="checkbox" checked={false}
                                      onChange={() => {
                                        if (hasSubItems) {
                                          saveTodo(todoItems.map(t => t.id === item.id ? { ...t, done: true, doneAt: new Date().toISOString(), subItems: (t.subItems || []).map(s => ({ ...s, done: true })) } : t));
                                        } else {
                                          saveTodo(todoItems.map(t => t.id === item.id ? { ...t, done: true, doneAt: new Date().toISOString() } : t));
                                        }
                                      }}
                                      style={{ marginTop: 3, flexShrink: 0, cursor: "pointer" }} />
                                    {/* Item text — editable when todoEditId matches */}
                                    {todoEditId === item.id ? (
                                      <input
                                        ref={todoEditInputRef}
                                        autoFocus
                                        value={todoEditValue}
                                        onChange={e => {
                                          const val = e.target.value;
                                          setTodoEditValue(val);
                                          const cursor = e.target.selectionStart;
                                          const before = val.slice(0, cursor);
                                          const m = before.match(/@([\w ]*)$/);
                                          if (m) {
                                            const rect = e.target.getBoundingClientRect();
                                            setTodoMentionQuery({ query: m[1], anchorPos: cursor - m[0].length, field: "edit", top: rect.bottom + 4, left: rect.left, width: rect.width });
                                            setTodoMentionIndex(0);
                                          } else { setTodoMentionQuery(null); }
                                        }}
                                        onClick={e => e.stopPropagation()}
                                        onMouseDown={e => e.stopPropagation()}
                                        onDragStart={e => { e.stopPropagation(); e.preventDefault(); }}
                                        onBlur={e => {
                                          if (todoMentionQuery?.field === "edit") return;
                                          if (e.relatedTarget === todoSubInputRef.current) return; // focus moving to sub-item — keep edit open
                                          const updated = todoItems.map(t => t.id === item.id ? { ...t, text: todoEditValue.trim() || t.text, ...(todoEditMentions.length ? { mentions: todoEditMentions } : {}) } : t);
                                          saveTodo(updated);
                                          setTodoEditId(null); setTodoMentionQuery(null); setTodoEditMentions([]);
                                        }}
                                        onKeyDown={e => {
                                          if (todoMentionQuery?.field === "edit") {
                                            const hits = allEmailContacts.filter(c => c.name.toLowerCase().includes(todoMentionQuery.query.toLowerCase()) || (c.sub||"").toLowerCase().includes(todoMentionQuery.query.toLowerCase())).slice(0, 6);
                                            if (e.key === "ArrowDown") { e.preventDefault(); setTodoMentionIndex(i => Math.min(i+1, hits.length-1)); return; }
                                            if (e.key === "ArrowUp")   { e.preventDefault(); setTodoMentionIndex(i => Math.max(i-1, 0)); return; }
                                            if (e.key === "Enter" && hits.length) {
                                              e.preventDefault();
                                              const c = hits[todoMentionIndex] || hits[0];
                                              const mq = todoMentionQuery;
                                              const tag = preferredFirstName(c.name) || c.name.split(" ")[0];
                                              setTodoEditValue(prev => prev.slice(0, mq.anchorPos) + `@${tag}` + prev.slice(mq.anchorPos + mq.query.length + 1));
                                              setTodoEditMentions(prev => [...prev.filter(m => m.name !== tag), { name: tag, email: c.email }]);
                                              setTodoMentionQuery(null); setTodoMentionIndex(0); return;
                                            }
                                            if (e.key === "Escape") { setTodoMentionQuery(null); return; }
                                          }
                                          if (e.key === "Enter") { e.target.blur(); }
                                          if (e.key === "Escape") { setTodoEditId(null); setTodoMentionQuery(null); setTodoEditMentions([]); }
                                          if (e.key === "Tab") { e.preventDefault(); todoSubInputRef.current?.focus(); }
                                        }}
                                        style={{ flex: 1, fontSize: 13, color: colors.text, border: "none", borderBottom: `1px solid ${colors.accent}`, outline: "none", background: "transparent", fontFamily: "inherit", lineHeight: 1.4, padding: "0 2px" }}
                                      />
                                    ) : (
                                      <span style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 1.4 }}>{renderTodoItemText(item)}</span>
                                    )}
                                    {/* Inline controls: count badge + tag chips + edit + delete */}
                                    {hasSubItems && (
                                      <span style={{ fontSize: 10, fontWeight: 700, minWidth: 18, height: 18, borderRadius: "50%", background: colors.accent, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 4px", flexShrink: 0 }}>
                                        {item.subItems.length}
                                      </span>
                                    )}
                                    {item.tag && item.tag !== "manual" && (
                                      <div style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 3, flexShrink: 0 }}>
                                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: tc.bg, color: tc.color, textAlign: "center" }}>{item.tag}</span>
                                        {item.emailId && isExpanded && (
                                          <button onClick={e => { e.stopPropagation();
                                              setInboxSelected(item.emailId);
                                              saveDashPanels({ ...dashPanels, emails: true });
                                              requestAnimationFrame(() => { requestAnimationFrame(() => {
                                                const container = emailListRef.current;
                                                const el = container?.querySelector(`[data-emailid="${item.emailId}"]`);
                                                if (el && container) container.scrollTop = el.offsetTop - container.offsetTop;
                                              }); });
                                            }}
                                            style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(52,69,101,0.1)", color: colors.sidebarActive, border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "center" }}>
                                            view
                                          </button>
                                        )}
                                      </div>
                                    )}
                                    {!(item.tag && item.tag !== "manual") && item.emailId && isExpanded && (
                                      <button onClick={e => { e.stopPropagation();
                                          setInboxSelected(item.emailId);
                                          saveDashPanels({ ...dashPanels, emails: true });
                                          requestAnimationFrame(() => { requestAnimationFrame(() => {
                                            const container = emailListRef.current;
                                            const el = container?.querySelector(`[data-emailid="${item.emailId}"]`);
                                            if (el && container) container.scrollTop = el.offsetTop - container.offsetTop;
                                          }); });
                                        }}
                                        style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(52,69,101,0.1)", color: colors.sidebarActive, border: "none", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                                        view
                                      </button>
                                    )}
                                    <button title="Edit" onClick={e => { e.stopPropagation(); const opening = todoEditId !== item.id; setTodoEditId(opening ? item.id : null); if (opening) { setTodoEditValue(item.text); setTodoEditMentions(item.mentions ? [...item.mentions] : []); setTodoSubInput(""); setTodoMentionQuery(null); } }} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, lineHeight: 1, padding: "0 1px", flexShrink: 0, opacity: 0.6, display: "flex", alignItems: "center" }}><Pencil size={12} /></button>
                                    <button onClick={e => { e.stopPropagation(); saveTodo(todoItems.filter(t => t.id !== item.id)); }} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, lineHeight: 1, padding: 0, flexShrink: 0, display: "flex", alignItems: "center" }}><X size={12} /></button>
                                    {overdueBadge}
                                  </div>
                                  );
                                  })()}

                                  {/* ── Add sub-item row — visible while editing ── */}
                                  {todoEditId === item.id && (
                                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px 5px 36px",
                                      background: colors.bg, borderTop: `1px solid ${colors.borderLight}`,
                                      borderRadius: "0 0 8px 8px" }}>
                                      <Plus size={11} style={{ color: colors.textMuted, flexShrink: 0 }} />
                                      <input
                                        ref={todoSubInputRef}
                                        value={todoSubInput}
                                        onClick={e => e.stopPropagation()}
                                        onChange={e => {
                                          const val = e.target.value;
                                          setTodoSubInput(val);
                                          const cursor = e.target.selectionStart;
                                          const before = val.slice(0, cursor);
                                          const m = before.match(/@([\w ]*)$/);
                                          if (m) {
                                            const rect = e.target.getBoundingClientRect();
                                            setTodoMentionQuery({ query: m[1], anchorPos: cursor - m[0].length, field: "sub", top: rect.bottom + 4, left: rect.left, width: rect.width });
                                            setTodoMentionIndex(0);
                                          } else { setTodoMentionQuery(null); }
                                        }}
                                        onKeyDown={e => {
                                          if (todoMentionQuery?.field === "sub") {
                                            const hits = allEmailContacts.filter(c => c.name.toLowerCase().includes(todoMentionQuery.query.toLowerCase()) || (c.sub||"").toLowerCase().includes(todoMentionQuery.query.toLowerCase())).slice(0, 6);
                                            if (e.key === "ArrowDown") { e.preventDefault(); setTodoMentionIndex(i => Math.min(i+1, hits.length-1)); return; }
                                            if (e.key === "ArrowUp")   { e.preventDefault(); setTodoMentionIndex(i => Math.max(i-1, 0)); return; }
                                            if (e.key === "Enter" && hits.length) {
                                              e.preventDefault();
                                              const c = hits[todoMentionIndex] || hits[0];
                                              const mq = todoMentionQuery;
                                              const tag = preferredFirstName(c.name) || c.name.split(" ")[0];
                                              setTodoSubInput(prev => prev.slice(0, mq.anchorPos) + `@${tag}` + prev.slice(mq.anchorPos + mq.query.length + 1));
                                              setTodoSubMentions(prev => [...prev.filter(m => m.name !== tag), { name: tag, email: c.email }]);
                                              setTodoMentionQuery(null); setTodoMentionIndex(0); return;
                                            }
                                            if (e.key === "Escape") { setTodoMentionQuery(null); return; }
                                          }
                                          if (e.key === "Enter" && todoSubInput.trim()) {
                                            e.preventDefault();
                                            const newSub = { id: uid(), text: todoSubInput.trim(), done: false, ...(todoSubMentions.length ? { mentions: todoSubMentions } : {}) };
                                            const prevSubs = item.subItems || [];
                                            const newSubs = [...prevSubs, newSub];
                                            const newText = `${item.text.replace(/\s*\+\d+$/, "")} +${newSubs.length - 1}`;
                                            saveTodo(todoItems.map(t => t.id === item.id ? { ...t, text: newText, subItems: newSubs } : t));
                                            setTodoSubInput(""); setTodoSubMentions([]); setTodoMentionQuery(null);
                                            if (!todoExpanded.has(item.id)) setTodoExpanded(prev => { const n = new Set(prev); n.add(item.id); return n; });
                                          }
                                          if (e.key === "Escape") { setTodoSubInput(""); setTodoSubMentions([]); setTodoMentionQuery(null); todoEditInputRef.current?.focus(); }
                                        }}
                                        placeholder="Add sub-item… (Enter to add, Tab to switch)"
                                        style={{ flex: 1, fontSize: 12, color: colors.text, border: "none", borderBottom: `1px solid ${colors.borderLight}`, outline: "none", background: "transparent", fontFamily: "inherit", lineHeight: 1.5, padding: "0 2px" }}
                                      />
                                    </div>
                                  )}
                                  {isExpanded && (
                                    <div style={{ border: "none", borderLeft: hasSubItems ? `4px solid ${colors.accent}` : `3px solid ${colors.accentLight}`, borderTop: "1px solid rgba(52,69,101,0.12)", borderRadius: "0 0 8px 8px", background: "rgba(52,69,101,0.1)", overflow: "hidden", opacity: 0.95 }}>
                                      {hasSubItems && item.subItems.map((sub, si) => (
                                        <div key={sub.id}
                                          draggable
                                          onDragStart={e => {
                                            e.stopPropagation();
                                            todoSubDragRef.current = { parentId: item.id, subId: sub.id, subItem: sub };
                                            todoDragIdxRef.current = null; // ensure normal todo drag is cleared
                                          }}
                                          onDragEnd={e => {
                                            e.stopPropagation();
                                            todoSubDragRef.current = null;
                                          }}
                                          style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 10px 7px 20px",
                                            borderTop: si > 0 ? `1px solid ${colors.borderLight}` : "none",
                                            background: sub.done ? "transparent" : colors.cardBg,
                                            cursor: "grab" }}>
                                          <input type="checkbox" checked={sub.done}
                                            onChange={() => {
                                              const toggled = item.subItems.map(s => s.id === sub.id ? { ...s, done: !s.done, doneAt: !s.done ? new Date().toISOString() : undefined } : s);
                                              const active = toggled.filter(s => !s.done);
                                              const done = toggled.filter(s => s.done).sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));
                                              const newSubItems = [...active, ...done];
                                              const allDone = newSubItems.every(s => s.done);
                                              saveTodo(todoItems.map(t => t.id === item.id
                                                ? { ...t, subItems: newSubItems, done: allDone, doneAt: allDone ? new Date().toISOString() : undefined }
                                                : t));
                                            }}
                                            style={{ marginTop: 3, flexShrink: 0, cursor: "pointer" }} />
                                          <div style={{ flex: 1, minWidth: 0 }}>
                                            {todoSubEditId?.itemId === item.id && todoSubEditId?.subId === sub.id ? (
                                              <input
                                                autoFocus
                                                value={todoSubEditValue}
                                                onChange={e => setTodoSubEditValue(e.target.value)}
                                                onClick={e => e.stopPropagation()}
                                                onMouseDown={e => e.stopPropagation()}
                                                onDragStart={e => { e.stopPropagation(); e.preventDefault(); }}
                                                onBlur={() => {
                                                  saveTodo(todoItems.map(t => t.id === item.id ? { ...t, subItems: (t.subItems || []).map(s => s.id === sub.id ? { ...s, text: todoSubEditValue.trim() || s.text } : s) } : t));
                                                  setTodoSubEditId(null);
                                                }}
                                                onKeyDown={e => {
                                                  if (e.key === "Enter") e.target.blur();
                                                  if (e.key === "Escape") setTodoSubEditId(null);
                                                }}
                                                style={{ width: "100%", fontSize: 12, color: colors.text, border: "none", borderBottom: `1px solid ${colors.accent}`, outline: "none", background: "transparent", fontFamily: "inherit", lineHeight: 1.4, padding: "0 2px" }}
                                              />
                                            ) : sub.replyEmailId || sub.replyTo ? (
                                              // Email sub-item — "Reply to [FirstName]" opens compose, "from Full Name" below
                                              <span style={{ fontSize: 12, color: sub.done ? colors.textMuted : colors.text, lineHeight: 1.4, textDecoration: sub.done ? "line-through" : "none" }}>
                                                <span
                                                  onClick={e => { e.stopPropagation(); openCompose([sub.replyTo], { from: schoolSenderForSourceEmail(sub.replyEmailId ? inboxEmails.find(e2 => e2.id === sub.replyEmailId) : null, schools) || "", subject: sub.composeSubject ?? (sub.replyEmailId ? reSubject(inboxEmails.find(e2 => e2.id === sub.replyEmailId)?.subject || "") : ""), triggerId: "todo_reply" }); }}
                                                  style={{ color: sub.done ? colors.textMuted : colors.accentDark, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>
                                                  {sub.senderName || "Reply"}
                                                </span>
                                                {sub.fullName && sub.fullName !== sub.senderName && (
                                                  <span style={{ fontSize: 10, color: colors.textMuted, marginLeft: 5 }}>from {sub.fullName}</span>
                                                )}
                                              </span>
                                            ) : sub.parentEmail ? (
                                              <span style={{ fontSize: 12, color: sub.done ? colors.textMuted : colors.text, lineHeight: 1.4, textDecoration: sub.done ? "line-through" : "none" }}>
                                                <span
                                                  onClick={e => { e.stopPropagation(); openCompose([sub.parentEmail], { triggerId: "todo_contact_parent" }); }}
                                                  style={{ color: sub.done ? colors.textMuted : colors.accentDark, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>
                                                  Contact {(sub.parentName || "parent").split(" ")[0]}
                                                </span>
                                                {" re: "}
                                                {sub.students
                                                  ? formatSiblingMissedText(sub.students)
                                                  : sub.textSuffix || sub.text.replace(/^Contact \S+ re: /, "")}
                                              </span>
                                            ) : sub.navigateTo ? (
                                              // Enquiry action sub-item — navigates to another page
                                              <span
                                                onClick={e => { e.stopPropagation(); if (sub.studentPrefill) { setNewStudentPrefill(sub.studentPrefill); } onNavigate(sub.navigateTo); }}
                                                style={{ fontSize: 12, color: sub.done ? colors.textMuted : colors.sidebarActive, fontWeight: 600, textDecoration: sub.done ? "line-through" : "underline", cursor: "pointer", lineHeight: 1.4 }}>
                                                {sub.text}
                                              </span>
                                            ) : (
                                              <span style={{ fontSize: 12, color: sub.done ? colors.textMuted : colors.text, lineHeight: 1.4, textDecoration: sub.done ? "line-through" : "none" }}>{renderReminderText(sub.text, sub.mentions)}</span>
                                            )}
                                            {sub.emailId && !sub.replyTo && (() => {
                                              const sn = sub.fullName || (() => { const se = inboxEmails.find(e => e.id === sub.emailId); return se?.from?.includes("<") ? se.from.split("<")[0].trim().replace(/^"|"$/g, "") : se?.from; })();
                                              return sn ? <span style={{ fontSize: 10, color: colors.textMuted, marginLeft: 6 }}>from {sn}</span> : null;
                                            })()}
                                          </div>
                                          {/* Edit button — only for plain manual sub-items */}
                                          {!sub.replyEmailId && !sub.replyTo && !sub.parentEmail && !sub.navigateTo && (
                                            <button title="Edit" onClick={e => { e.stopPropagation(); setTodoSubEditId({ itemId: item.id, subId: sub.id }); setTodoSubEditValue(sub.text); }}
                                              style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, lineHeight: 1, padding: "0 1px", flexShrink: 0, opacity: 0.6, display: "flex", alignItems: "center" }}><Pencil size={11} /></button>
                                          )}
                                          {/* Ungroup button */}
                                          <button title="Remove from group" onClick={e => { e.stopPropagation();
                                            const newSubItems = item.subItems.filter(s => s.id !== sub.id);
                                            const standalone = { id: uid(), text: sub.text, done: false, tag: sub.tag || item.tag, emailId: sub.emailId, meta: sub.meta, createdAt: new Date().toISOString() };
                                            if (newSubItems.length === 0) {
                                              // Parent becomes standalone again
                                              saveTodo([...todoItems.filter(t => t.id !== item.id).map(t => t), standalone]);
                                            } else if (newSubItems.length === 1) {
                                              const newText = newSubItems[0].text;
                                              saveTodo([standalone, ...todoItems.map(t => t.id === item.id ? { ...t, text: newText, subItems: undefined, count: undefined } : t)]);
                                            } else {
                                              const newText = item.text.replace(/\s*\+\d+$/, "") + ` +${newSubItems.length - 1}`;
                                              saveTodo([standalone, ...todoItems.map(t => t.id === item.id ? { ...t, text: newText, subItems: newSubItems, count: newSubItems.length } : t)]);
                                            }
                                          }} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, lineHeight: 1, padding: "0 0 0 4px", flexShrink: 0, opacity: 0.6, display: "flex", alignItems: "center" }}><ArrowUp size={11} /></button>
                                          <button onClick={() => {
                                            const newSubItems = item.subItems.filter(s => s.id !== sub.id);
                                            if (newSubItems.length === 0) { saveTodo(todoItems.filter(t => t.id !== item.id)); }
                                            else if (newSubItems.length === 1) { saveTodo(todoItems.map(t => t.id === item.id ? { ...t, text: newSubItems[0].text, subItems: undefined, count: undefined, emailId: newSubItems[0].emailId, meta: newSubItems[0].meta } : t)); }
                                            else {
                                              const newCount = newSubItems.length;
                                              const newText = item.text.replace(/\s*\+\d+$/, "") + ` +${newCount - 1}`;
                                              saveTodo(todoItems.map(t => t.id === item.id ? { ...t, text: newText, subItems: newSubItems, count: newCount } : t));
                                            }
                                          }} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, lineHeight: 1, padding: 0, flexShrink: 0, display: "flex", alignItems: "center" }}><X size={12} /></button>
                                        </div>
                                      ))}
                                      <div style={{ padding: "8px 12px", borderTop: hasSubItems ? `1px solid ${colors.borderLight}` : "none", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                        {createdAt && <span style={{ fontSize: 10, color: colors.textMuted }}>Added {createdAt}</span>}
                                        {sourceFromName && <span style={{ fontSize: 10, color: colors.textMuted }}>· from {sourceFromName}</span>}
                                        {sourceEmail && <span style={{ fontSize: 10, color: colors.textMuted }}>· {sourceEmail.subject || "(no subject)"}</span>}
                                        {item.meta?.school && <span style={{ fontSize: 10, color: colors.textMuted }}>· {item.meta.school}</span>}
                                      </div>
                                      <div style={{ padding: "0 12px 10px" }}>
                                        <textarea
                                          ref={todoNotesItemId === item.id ? todoNotesRef : undefined}
                                          value={todoNotesItemId === item.id ? todoNotesValue : (item.notes || "")}
                                          onFocus={() => { setTodoNotesItemId(item.id); setTodoNotesValue(item.notes || ""); setTodoNotesMentions(item.noteMentions ? [...item.noteMentions] : []); }}
                                          onChange={e => {
                                            const val = e.target.value;
                                            setTodoNotesValue(val);
                                            const cursor = e.target.selectionStart;
                                            const before = val.slice(0, cursor);
                                            const m = before.match(/@([\w ]*)$/);
                                            if (m) {
                                              const rect = e.target.getBoundingClientRect();
                                              setTodoMentionQuery({ query: m[1], anchorPos: cursor - m[0].length, field: "notes", top: rect.bottom + 4, left: rect.left, width: rect.width });
                                              setTodoMentionIndex(0);
                                            } else { if (todoMentionQuery?.field === "notes") setTodoMentionQuery(null); }
                                          }}
                                          onClick={e => e.stopPropagation()}
                                          onBlur={e => {
                                            if (todoMentionQuery?.field === "notes") return;
                                            saveTodo(todoItems.map(t => t.id === item.id ? { ...t, notes: todoNotesValue, ...(todoNotesMentions.length ? { noteMentions: todoNotesMentions } : { noteMentions: undefined }) } : t));
                                            setTodoNotesItemId(null); setTodoNotesMentions([]);
                                          }}
                                          onKeyDown={e => {
                                            if (todoMentionQuery?.field === "notes") {
                                              const hits = allEmailContacts.filter(c => c.name.toLowerCase().includes(todoMentionQuery.query.toLowerCase()) || (c.sub||"").toLowerCase().includes(todoMentionQuery.query.toLowerCase())).slice(0, 6);
                                              if (e.key === "ArrowDown") { e.preventDefault(); setTodoMentionIndex(i => Math.min(i+1, hits.length-1)); return; }
                                              if (e.key === "ArrowUp")   { e.preventDefault(); setTodoMentionIndex(i => Math.max(i-1, 0)); return; }
                                              if (e.key === "Enter" && hits.length) {
                                                e.preventDefault();
                                                const c = hits[todoMentionIndex] || hits[0];
                                                const mq = todoMentionQuery;
                                                const tag = preferredFirstName(c.name) || c.name.split(" ")[0];
                                                setTodoNotesValue(prev => prev.slice(0, mq.anchorPos) + `@${tag}` + prev.slice(mq.anchorPos + mq.query.length + 1));
                                                setTodoNotesMentions(prev => [...prev.filter(m => m.name !== tag), { name: tag, email: c.email }]);
                                                setTodoMentionQuery(null); setTodoMentionIndex(0); return;
                                              }
                                              if (e.key === "Escape") { setTodoMentionQuery(null); return; }
                                            }
                                          }}
                                          placeholder="Add a note… (type @ to mention a contact)"
                                          rows={2}
                                          style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 12, fontFamily: "inherit", color: colors.text, border: `1px solid ${colors.inputBorder}`, borderRadius: 6, resize: "vertical", outline: "none", background: colors.cardBg, lineHeight: 1.5 }} />
                                        {(item.noteMentions || []).length > 0 && (
                                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                                            {item.noteMentions.map((m, mi) => (
                                              <span key={mi}
                                                onClick={e => { e.stopPropagation(); openCompose([m.email], { triggerId: "todo_note_mention" }); }}
                                                style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: colors.accentLight, color: colors.accentDark, cursor: "pointer", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 3 }}>
                                                @{m.name} <span style={{ fontSize: 9, opacity: 0.7 }}>✉</span>
                                              </span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  </div>{/* end 2px margin wrapper */}
                                </React.Fragment>
                              );
                            })}
                            {/* ── Bottom catch-all — handles email/alert/sub drops in empty space ── */}
                            <div
                              onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (emailDragging || alertDragging || todoSubDragRef.current) e.dataTransfer.dropEffect = "move"; }}
                              onDrop={e => {
                                e.preventDefault(); e.stopPropagation();
                                if (todoSubDragRef.current) { ungroupSub(); return; }
                                if (alertDragging) { saveTodo(handleAlertDrop(alertDragging, todoItemsRef.current)); setAlertDragging(null); setTodoDropTarget(false); return; }
                              }}
                              style={{ minHeight: 40, flex: 1 }} />
                            {/* ── Todo context menu ── */}
                            {todoContextMenu && (() => {
                              const ctxItem = todoItems.find(t => t.id === todoContextMenu.itemId);
                              const selArr = activeTodo.filter(t => todoSelectedIds.has(t.id));
                              const ctxInSelection = todoSelectedIds.has(todoContextMenu.itemId);
                              // Items that will be grouped: if right-clicked item is in selection, group all selected; else group right-clicked + selected
                              const toGroup = ctxInSelection && selArr.length >= 2 ? selArr : null;
                              const btnStyle = { display: "block", width: "100%", padding: "8px 14px", background: "none", border: "none", textAlign: "left", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: colors.text, borderRadius: 6 };
                              const groupSelected = () => {
                                const groupName = window.prompt("Group name:");
                                if (!groupName || !groupName.trim()) return;
                                const items = todoItemsRef.current;
                                const active = items.filter(t => !t.done);
                                const done = items.filter(t => t.done);
                                const groupIds = new Set(toGroup.map(t => t.id));
                                // Build sub-items from all selected items, preserving their data/links
                                const newSubItems = toGroup.map(t => {
                                  const sub = { id: t.id, text: t.text, done: false };
                                  if (t.emailId) sub.emailId = t.emailId;
                                  if (t.meta) sub.meta = t.meta;
                                  if (t.tag) sub.tag = t.tag;
                                  if (t.replyTo) sub.replyTo = t.replyTo;
                                  if (t.replyEmailId) sub.replyEmailId = t.replyEmailId;
                                  if (t.composeSubject) sub.composeSubject = t.composeSubject;
                                  if (t.senderName) sub.senderName = t.senderName;
                                  if (t.fullName) sub.fullName = t.fullName;
                                  if (t.parentEmail) sub.parentEmail = t.parentEmail;
                                  if (t.parentName) sub.parentName = t.parentName;
                                  if (t.students) sub.students = t.students;
                                  if (t.mentions) sub.mentions = t.mentions;
                                  // If this item already had sub-items, flatten them in
                                  if (t.subItems && t.subItems.length > 0) {
                                    sub.text = t.text.replace(/\s*\+\d+$/, "");
                                    return [sub, ...t.subItems.map(s => ({ ...s }))];
                                  }
                                  return [sub];
                                }).flat();
                                const groupItem = {
                                  id: uid(),
                                  text: `${groupName.trim()} +${newSubItems.length}`,
                                  done: false,
                                  tag: toGroup[0]?.tag,
                                  subItems: newSubItems,
                                  createdAt: new Date().toISOString()
                                };
                                // Insert group at position of first selected item, remove all selected
                                const firstIdx = active.findIndex(t => groupIds.has(t.id));
                                const remaining = active.filter(t => !groupIds.has(t.id));
                                remaining.splice(firstIdx >= 0 ? firstIdx : 0, 0, groupItem);
                                saveTodo([...remaining, ...done]);
                                setTodoSelectedIds(new Set());
                                setTodoContextMenu(null);
                                // Auto-expand the new group
                                setTodoExpanded(prev => { const n = new Set(prev); n.add(groupItem.id); return n; });
                              };
                              const setItemCategory = (catId) => {
                                const ids = toGroup ? new Set(toGroup.map(t => t.id)) : new Set([todoContextMenu.itemId]);
                                saveTodo(todoItemsRef.current.map(t => ids.has(t.id) ? { ...t, category: catId || undefined } : t));
                                setTodoSelectedIds(new Set());
                                setTodoContextMenu(null);
                              };
                              return (
                                <>
                                  <div onMouseDown={e => e.stopPropagation()}
                                    style={{ position: "fixed", left: todoContextMenu.x, top: todoContextMenu.y, zIndex: 9999,
                                      background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8,
                                      boxShadow: "0 4px 16px rgba(0,0,0,0.14)", minWidth: 180, overflow: "hidden",
                                      fontFamily: "inherit", fontSize: 13 }}>
                                    {toGroup && (
                                      <>
                                        <div style={{ padding: "6px 14px 4px", fontSize: 10, fontWeight: 700, color: colors.textMuted, letterSpacing: "0.04em" }}>
                                          {toGroup.length} ITEMS SELECTED
                                        </div>
                                        <button style={btnStyle}
                                          onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                                          onMouseLeave={e => e.currentTarget.style.background = "none"}
                                          onClick={() => groupSelected()}>
                                          Group items
                                        </button>
                                        <button style={{ ...btnStyle, color: colors.textMuted }}
                                          onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                                          onMouseLeave={e => e.currentTarget.style.background = "none"}
                                          onClick={() => { setTodoSelectedIds(new Set()); setTodoContextMenu(null); }}>
                                          Clear selection
                                        </button>
                                        <div style={{ borderTop: `1px solid ${colors.border}`, margin: "3px 0" }} />
                                      </>
                                    )}
                                    {!toGroup && (
                                      <div style={{ padding: "6px 14px 4px", fontSize: 10, fontWeight: 700, color: colors.textMuted, letterSpacing: "0.04em" }}>
                                        {ctxItem ? (ctxItem.text.length > 30 ? ctxItem.text.slice(0,30) + "…" : ctxItem.text).toUpperCase() : "ITEM"}
                                      </div>
                                    )}
                                    {todoCategories.length > 0 && (
                                      <>
                                        <div style={{ padding: "4px 14px 2px", fontSize: 10, fontWeight: 700, color: colors.textMuted, letterSpacing: "0.04em" }}>CATEGORY</div>
                                        {todoCategories.map(cat => (
                                          <button key={cat.id} style={btnStyle}
                                            onMouseEnter={e => e.currentTarget.style.background = `${cat.color}18`}
                                            onMouseLeave={e => e.currentTarget.style.background = "none"}
                                            onClick={() => setItemCategory(cat.id)}>
                                            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                              <span style={{ width: 10, height: 10, borderRadius: 3, background: cat.color, flexShrink: 0 }} />
                                              {cat.name}
                                              {(toGroup ? toGroup.every(t => t.category === cat.id) : ctxItem?.category === cat.id) && <span style={{ fontSize: 11, color: colors.textMuted }}>✓</span>}
                                            </span>
                                          </button>
                                        ))}
                                        {(toGroup ? toGroup.some(t => t.category) : ctxItem?.category) && (
                                          <button style={{ ...btnStyle, color: colors.textMuted, fontStyle: "italic" }}
                                            onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                                            onMouseLeave={e => e.currentTarget.style.background = "none"}
                                            onClick={() => setItemCategory(null)}>
                                            Remove category
                                          </button>
                                        )}
                                        <div style={{ borderTop: `1px solid ${colors.border}`, margin: "3px 0" }} />
                                      </>
                                    )}
                                    {!toGroup && (
                                      <div style={{ padding: "4px 14px", fontSize: 11, color: colors.textMuted, fontStyle: "italic" }}>
                                        Shift+click to select, then right-click to group
                                      </div>
                                    )}
                                  </div>
                                  <div onClick={() => setTodoContextMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 9998 }} />
                                </>
                              );
                            })()}
                            {displayDoneTodo.length > 0 && (
                              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.borderLight}` }}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                                  <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Done</div>
                                  {doneTodo.length > 0 && (
                                    <button title="Clear all completed" onClick={() => saveTodo(todoItems.filter(t => !t.done))} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, lineHeight: 1, padding: 0, display: "flex", alignItems: "center" }}><X size={12} /></button>
                                  )}
                                </div>
                                {displayDoneTodo.map(item => (
                                  <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, marginBottom: 3, background: colors.bg, opacity: 0.6 }}>
                                    <input type="checkbox" checked={true} onChange={() => saveTodo(todoItems.map(t => t.id === item.id ? { ...t, done: false, doneAt: undefined } : t))} style={{ flexShrink: 0, cursor: "pointer" }} />
                                    <span style={{ flex: 1, fontSize: 12, color: colors.textMuted, textDecoration: "line-through" }}>{item.text}</span>
                                    <button onClick={() => saveTodo(todoItems.filter(t => t.id !== item.id))} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, lineHeight: 1, padding: 0, display: "flex", alignItems: "center" }}><X size={12} /></button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card></div>
              </div>  {/* end inner overflow:hidden wrapper */}

              {/* Reminders button — position:absolute in outer wrapper, scrolls with banner, no JS needed */}
              <div
                ref={remindersBtnRef}
                onClick={handleRemindersToggle}
                onDragEnter={e => { e.preventDefault(); setRemindersDragOver(true); setRemindersDropTarget(true); }}
                onDragOver={e => { e.preventDefault(); setRemindersDragOver(true); setRemindersDropTarget(true); }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setRemindersDragOver(false); setRemindersDropTarget(false); } }}
                onDrop={e => {
                  e.preventDefault(); setRemindersDragOver(false); setRemindersDropTarget(false);
                  const text = e.dataTransfer.getData("text/plain") || "";
                  if (text.trim()) { saveReminders([{ id: uid(), text: text.trim(), createdAt: new Date().toISOString() }, ...reminders]); setRemindersOpen(true); }
                  else if (emailDragging) {
                    const em = Array.isArray(emailDragging) ? emailDragging[0] : emailDragging;
                    if (em) { const t = (em.subject || em.snippet || "Email reminder").slice(0, 120); saveReminders([{ id: uid(), text: t, emailId: em.id, createdAt: new Date().toISOString() }, ...reminders]); setRemindersOpen(true); setEmailDragging(null); }
                  } else if (alertDragging?.text) {
                    saveReminders([{ id: uid(), text: alertDragging.text, createdAt: new Date().toISOString() }, ...reminders]); setRemindersOpen(true);
                  }
                }}
                style={{ position: "absolute", right: 10, top: 9, zIndex: 48,
                  display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 12,
                  background: remindersDragOver || (remindersGlobalDrag && !remindersOpen) ? colors.accent : remindersOpen || sortedReminders.length > 0 ? colors.accentDark : colors.sidebarActive,
                  cursor: "pointer", transition: "background 0.15s", userSelect: "none",
                  boxShadow: remindersDragOver ? `0 0 0 3px ${colors.accent}55, 0 2px 6px rgba(0,0,0,0.3)` : "0 2px 6px rgba(0,0,0,0.25)" }}
                onMouseEnter={e => { e.currentTarget.style.background = remindersOpen || sortedReminders.length > 0 ? colors.accentDark : colors.sidebarActive; }}
                onMouseLeave={e => { e.currentTarget.style.background = remindersDragOver || remindersOpen || sortedReminders.length > 0 ? colors.accentDark : colors.sidebarActive; }}>
                <span style={{ fontWeight: 700, fontSize: 11, color: "#fff", letterSpacing: "0.03em" }}>Reminders</span>
                {sortedReminders.length > 0 && <span style={{ fontSize: 10, fontWeight: 700, background: "rgba(255,255,255,0.3)", color: "#fff", borderRadius: 8, padding: "0px 5px" }}>{sortedReminders.length}</span>}
              </div>
            </div>  {/* end outer banner wrapper */}
          </>
        );
      })()}



      {/* ── Reminders Panel ── */}
      {remindersOpen && remindersBtnRef.current && (() => {
        const W = remindersPanelSize.w;
        const H = remindersPanelSize.h;
        const CORAL_BG = darkMode ? colors.accentLight : "#FDF0ED";
        const CORAL_BORDER = colors.accent;

        const handleResizeMouseDown = (e, type) => {
          e.preventDefault(); e.stopPropagation();
          const startX = e.clientX, startY = e.clientY;
          const startW = W, startH = H;
          const onMove = (ev) => {
            let nw = startW, nh = startH;
            if (type === "left" || type === "corner") nw = Math.max(220, startW + (startX - ev.clientX));
            if (type === "bottom" || type === "corner") nh = Math.max(200, startH + (ev.clientY - startY));
            saveRemindersPanelSize({ w: nw, h: nh });
          };
          const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        };

        const addReminder = () => {
          const t = remindersInput.trim();
          if (!t) return;
          const entry = { id: uid(), text: t, createdAt: new Date().toISOString() };
          if (remindersInputMentions.length) entry.mentions = remindersInputMentions;
          saveReminders([entry, ...reminders]);
          setRemindersInput("");
          setRemindersInputMentions([]);
        };

        return (
          <div
            ref={remindersPanelRef}
            onClick={e => { if (!remindersDropTarget && e.target === e.currentTarget) remindersTypeRef.current?.focus(); }}
            style={{ position: "absolute", right: 0, top: 0, width: W, height: H, zIndex: 47,
              background: remindersDropTarget ? `${CORAL_BG}` : CORAL_BG, border: `1.5px solid ${CORAL_BORDER}`, borderRadius: 12,
              boxShadow: "0 8px 32px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", overflow: "hidden", userSelect: "none",
              cursor: "text" }}
            onDragEnter={e => { e.preventDefault(); setRemindersDropTarget(true); }}
            onDragOver={e => { e.preventDefault(); setRemindersDropTarget(true); e.dataTransfer.dropEffect = "copy"; }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setRemindersDropTarget(false); }}
            onDrop={e => {
              e.preventDefault(); setRemindersDropTarget(false);
              const text = e.dataTransfer.getData("text/plain") || "";
              if (text.trim()) {
                const src = dragSourceEmailRef.current;
                let extra = {};
                if (src?.fromAddr) {
                  extra.emailId = src.emailId;
                  extra.emailFrom = src.fromName || src.fromAddr;
                  extra.emailFromAddr = src.fromAddr;
                  const match = resolveEmailSender(src.fromAddr);
                  if (match.parentName) extra.parentName = match.parentName;
                  if (match.studentName) extra.studentName = match.studentName;
                  if (match.studentId) extra.studentId = match.studentId;
                  const st = match.studentId ? students.find(s => s.id === match.studentId) : null;
                  if (st?.schoolId) extra.schoolId = st.schoolId;
                  if (st?.className) extra.className = st.className;
                }
                const parsedDates = parseReminderDates(text);
                dragSourceEmailRef.current = null;
                saveReminders([{ id: uid(), text: text.trim(), createdAt: new Date().toISOString(), ...parsedDates, ...extra }, ...reminders]);
                return;
              }
              if (emailDragging) {
                const em = Array.isArray(emailDragging) ? emailDragging[0] : emailDragging;
                if (em) { const t = (em.subject || em.snippet || "Email reminder").slice(0, 120); saveReminders([{ id: uid(), text: t, emailId: em.id, createdAt: new Date().toISOString() }, ...reminders]); setEmailDragging(null); }
              } else if (alertDragging?.text) {
                saveReminders([{ id: uid(), text: alertDragging.text, createdAt: new Date().toISOString() }, ...reminders]);
              }
            }}>

            {/* Resize — left edge */}
            <div onMouseDown={e => handleResizeMouseDown(e, "left")}
              style={{ position: "absolute", left: 0, top: 12, bottom: 12, width: 6, cursor: "ew-resize", zIndex: 10, borderRadius: "3px 0 0 3px" }} />
            {/* Resize — bottom edge */}
            <div onMouseDown={e => handleResizeMouseDown(e, "bottom")}
              style={{ position: "absolute", left: 12, right: 12, bottom: 0, height: 6, cursor: "ns-resize", zIndex: 10 }} />
            {/* Resize — bottom-left corner */}
            <div onMouseDown={e => handleResizeMouseDown(e, "corner")}
              style={{ position: "absolute", left: 0, bottom: 0, width: 14, height: 14, cursor: "nesw-resize", zIndex: 11 }} />

            {/* List — invisible textarea at top captures typing; click anywhere focuses it */}
            <div data-scroll-list style={{ flex: 1, overflowY: "auto", padding: "10px 12px 12px",
              background: remindersDropTarget ? `${colors.accent}10` : "transparent", transition: "background 0.15s",
              cursor: "text" }}
              onClick={e => { if (e.target === e.currentTarget) remindersTypeRef.current?.focus(); }}>
              {/* Ghost textarea — invisible, sits at top, shows cursor when focused */}
              <textarea
                ref={remindersTypeRef}
                value={remindersInput}
                onChange={e => {
                  const val = e.target.value;
                  setRemindersInput(val);
                  const cursor = e.target.selectionStart;
                  const before = val.slice(0, cursor);
                  const m = before.match(/@([\w ]*)$/);
                  if (m) {
                    const rect = e.target.getBoundingClientRect();
                    setRemindersMentionQuery({ query: m[1], anchorPos: cursor - m[0].length, remId: "__new__", top: rect.bottom + 4, left: rect.left, width: rect.width });
                  } else {
                    setRemindersMentionQuery(null);
                  }
                }}
                onKeyDown={e => {
                  if (remindersMentionQuery) {
                    const q = remindersMentionQuery.query.toLowerCase();
                    const hits = allEmailContacts.filter(c => c.name.toLowerCase().includes(q) || (c.sub||"").toLowerCase().includes(q)).slice(0, 6);
                    if (e.key === "ArrowDown") { e.preventDefault(); setRemindersMentionIndex(i => Math.min(i + 1, hits.length - 1)); return; }
                    if (e.key === "ArrowUp")   { e.preventDefault(); setRemindersMentionIndex(i => Math.max(i - 1, 0)); return; }
                    if (e.key === "Enter" && hits.length) {
                      e.preventDefault();
                      const c = hits[remindersMentionIndex] || hits[0];
                      const mq = remindersMentionQuery;
                      const tag = `@${c.name}`;
                      setRemindersInput(prev => { const before = prev.slice(0, mq.anchorPos); const after = prev.slice(mq.anchorPos + mq.query.length + 1); return before + tag + after; });
                      setRemindersInputMentions(prev => [...prev.filter(m => m.name !== c.name), { name: c.name, email: c.email }]);
                      setRemindersMentionQuery(null); setRemindersMentionIndex(0); return;
                    }
                    if (e.key === "Escape") { setRemindersMentionQuery(null); setRemindersMentionIndex(0); return; }
                  }
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addReminder(); }
                  if (e.key === "Escape") setRemindersMentionQuery(null);
                }}
                rows={1}
                placeholder=""
                style={{ display: "block", width: "100%", fontSize: 12, lineHeight: 1.5,
                  padding: 0, margin: "0 0 4px 0", border: "none", background: CORAL_BG,
                  boxShadow: `inset 0 0 0 1000px ${CORAL_BG}`, WebkitBoxShadow: `inset 0 0 0 1000px ${CORAL_BG}`,
                  color: colors.text, caretColor: colors.accent, outline: "none",
                  fontFamily: "inherit", resize: "none", overflow: "hidden",
                  userSelect: "text", cursor: "text", WebkitAppearance: "none",
                  height: remindersInput ? "auto" : "1.5em" }}
                onInput={e => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }} />
              {sortedReminders.length === 0 && null}
              {sortedReminders.map(r => {
                const isExpanded = remindersMetaModal === r.id;
                const f = isExpanded ? remindersMetaForm : null;
                const school = r.schoolId ? schools.find(s => s.id === r.schoolId) : null;

                // Term week options (only computed when expanded)
                let weekOptions = [];
                if (isExpanded) {
                  const todayStr2 = melbourneToday();
                  let termStart2 = null;
                  const bks2 = interruptions.filter(i => i.type === "term_break").sort((a,b) => a.date < b.date ? 1 : -1);
                  for (const br of bks2) { const tbEnd = br.endDate || br.date; if (tbEnd < todayStr2) { const ts = new Date(tbEnd); ts.setDate(ts.getDate()+1); while(ts.getDay()===6||ts.getDay()===0) ts.setDate(ts.getDate()+1); termStart2=ts; break; } }
                  if (!termStart2) { const y=new Date().getFullYear(); const s=new Date(y,0,27); while(s.getDay()!==2) s.setDate(s.getDate()+1); termStart2=s; }
                  const nextBreak2 = interruptions.filter(i => i.type==="term_break" && i.date > todayStr2).sort((a,b)=>a.date<b.date?-1:1)[0];
                  const termEnd2 = nextBreak2 ? new Date(nextBreak2.date) : new Date(termStart2.getTime()+10*7*86400000);
                  const totalW2 = Math.ceil((termEnd2-termStart2)/(7*86400000));
                  const curW2 = Math.max(1, Math.ceil((new Date(todayStr2)-termStart2)/(7*86400*1000))+1);
                  for (let w=curW2; w<=Math.max(totalW2,curW2+4); w++) {
                    const mon=new Date(termStart2); mon.setDate(mon.getDate()+(w-1)*7);
                    const fri=new Date(mon); fri.setDate(fri.getDate()+4);
                    const fmt=d=>d.toLocaleDateString("en-AU",{day:"numeric",month:"short"});
                    weekOptions.push({ value:String(w), label:`Wk ${w}  (${fmt(mon)}–${fmt(fri)})` });
                  }
                }

                const schoolClasses2 = (isExpanded && f?.schoolId)
                  ? [...new Set(students.filter(s=>s.schoolId===f.schoolId&&s.className).map(s=>s.className))].sort()
                  : [];
                const matchedStudents2 = (isExpanded && (f?.studentName||"").length>=1)
                  ? students.filter(s=>s.status==="active"&&s.name.toLowerCase().includes((f.studentName||"").toLowerCase())&&(!f.schoolId||s.schoolId===f.schoolId)).slice(0,6)
                  : [];

                // Minimal underline-only input style
                const uInput = { width:"100%", fontSize:11, padding:"2px 0", border:"none", borderBottom:`1px solid ${colors.border}`, background:"transparent", color:colors.text, fontFamily:"inherit", outline:"none", appearance:"none" };
                const uLabel = { fontSize:10, color:colors.textMuted, display:"block", marginBottom:2, letterSpacing:"0.04em" };

                return (
                  <div key={r.id}
                    onDoubleClick={() => {
                      if (isExpanded) { setRemindersMetaModal(null); setRemindersMetaForm(null); }
                      else { setRemindersMetaModal(r.id); setRemindersMetaForm({ text:r.text||"", date:r.date||"", endDate:r.endDate||"", week:r.week||"", time:r.time||"", schoolId:r.schoolId||"", className:r.className||"", studentName:r.studentName||"", notes:r.notes||"", mentions:r.mentions||[] }); setRemindersMentionQuery(null); }
                    }}
                    style={{ padding:"5px 2px", cursor:"default", userSelect: isExpanded ? "text" : "none" }}>

                    {/* ── Collapsed row ── */}
                    <div style={{ display:"flex", alignItems:"flex-start", gap:6 }}>
                      <span style={{ color:colors.accent, fontSize:14, lineHeight:"18px", flexShrink:0 }}>•</span>
                      {isExpanded && f
                        ? <div style={{ flex:1, position:"relative" }}>
                            <textarea
                              value={f.text}
                              onChange={e => {
                                const val = e.target.value;
                                setRemindersMetaForm(p => ({ ...p, text: val }));
                                const cursor = e.target.selectionStart;
                                const before = val.slice(0, cursor);
                                const m = before.match(/@([\w ]*)$/);
                                if (m) {
                                  const rect = e.target.getBoundingClientRect();
                                  setRemindersMentionQuery({ query: m[1], anchorPos: cursor - m[0].length, remId: r.id, top: rect.bottom + 4, left: rect.left, width: rect.width });
                                } else {
                                  setRemindersMentionQuery(null);
                                }
                              }}
                              onClick={e => e.stopPropagation()}
                              onDoubleClick={e => e.stopPropagation()}
                              onKeyDown={e => {
                                if (remindersMentionQuery) {
                                  const q = remindersMentionQuery.query.toLowerCase();
                                  const hits = allEmailContacts.filter(c => c.name.toLowerCase().includes(q) || (c.sub||"").toLowerCase().includes(q)).slice(0, 6);
                                  if (e.key === "ArrowDown") { e.preventDefault(); setRemindersMentionIndex(i => Math.min(i + 1, hits.length - 1)); return; }
                                  if (e.key === "ArrowUp")   { e.preventDefault(); setRemindersMentionIndex(i => Math.max(i - 1, 0)); return; }
                                  if (e.key === "Enter" && hits.length) {
                                    e.preventDefault();
                                    const c = hits[remindersMentionIndex] || hits[0];
                                    const mq = remindersMentionQuery;
                                    const tag = `@${c.name}`;
                                    setRemindersMetaForm(prev => { if (!prev) return prev; const cur = prev.text||""; const before = cur.slice(0, mq.anchorPos); const after = cur.slice(mq.anchorPos + mq.query.length + 1); const newMentions = [...(prev.mentions||[]).filter(m => m.name !== c.name), { name: c.name, email: c.email }]; return { ...prev, text: before + tag + after, mentions: newMentions }; });
                                    setRemindersMentionQuery(null); setRemindersMentionIndex(0); return;
                                  }
                                  if (e.key === "Escape") { setRemindersMentionQuery(null); setRemindersMentionIndex(0); e.stopPropagation(); return; }
                                }
                                if (e.key === "Escape") { setRemindersMentionQuery(null); e.stopPropagation(); }
                              }}
                              rows={1}
                              placeholder=""
                              style={{ width:"100%", fontSize:12, color:colors.text, lineHeight:1.45, background:"transparent", border:"none", borderBottom:`1px solid ${colors.border}`, outline:"none", fontFamily:"inherit", resize:"none", padding:"0 0 2px 0", overflow:"hidden", boxSizing:"border-box" }}
                              onInput={e => { e.target.style.height="auto"; e.target.style.height=e.target.scrollHeight+"px"; }}
                            />
                          </div>
                        : <div style={{ flex:1, minWidth:0, fontSize:12, color:colors.text, lineHeight:1.45, wordBreak:"break-word" }}>
                          {renderReminderText(r.text, r.mentions)}
                          {(r.date || r.endDate) && (
                            <div style={{ fontSize:10, color:colors.textMuted, marginTop:2 }}>
                              {r.date && new Date(r.date+"T12:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short"})}
                              {r.date && r.endDate && " – "}
                              {r.endDate && new Date(r.endDate+"T12:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short"})}
                            </div>
                          )}
                        </div>
                      }
                      <button
                        onClick={e => { e.stopPropagation(); saveReminders(reminders.filter(x=>x.id!==r.id)); }}
                        style={{ background:"none", border:"none", cursor:"pointer", color:colors.textMuted, padding:0, flexShrink:0, opacity:0.4, display:"inline-flex", alignItems:"center" }}
                        onMouseEnter={e=>e.currentTarget.style.opacity="1"}
                        onMouseLeave={e=>e.currentTarget.style.opacity="0.4"}>
                        <X size={12} />
                      </button>
                    </div>

                    {/* ── Expanded inline ── */}
                    {isExpanded && f && (
                      <div style={{ marginLeft:18, marginTop:6, paddingTop:8, borderTop:`1px solid ${colors.borderLight}` }}>

                        {/* Auto-detected email/parent info — clickable if email known */}
                        {(r.emailFrom || r.parentName || r.studentName) && (
                          <div style={{ fontSize:11, color:colors.textMuted, marginBottom:8, lineHeight:1.5 }}>
                            {r.emailFrom && (
                              <button onClick={() => r.emailFromAddr && openCompose([r.emailFromAddr])}
                                style={{ background:"none", border:"none", padding:0, cursor: r.emailFromAddr ? "pointer" : "default", color: r.emailFromAddr ? colors.accent : colors.textMuted, fontFamily:"inherit", fontSize:"inherit", textDecoration: r.emailFromAddr ? "underline" : "none", textDecorationStyle:"dotted" }}>
                                ✉ {r.emailFrom}
                              </button>
                            )}
                            {(r.parentName || r.studentName) && r.emailFrom && <span> · </span>}
                            {r.studentName && (() => {
                              const st = students.find(s => s.name === r.studentName || s.id === r.studentId);
                              const pEmail = st?.parents?.[0]?.email;
                              return st && onViewStudent
                                ? <button onClick={() => onViewStudent(st.id)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:colors.accent, fontFamily:"inherit", fontSize:"inherit", textDecoration:"underline", textDecorationStyle:"dotted" }}>{r.studentName}</button>
                                : pEmail
                                  ? <button onClick={() => openCompose([pEmail])} style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:colors.accent, fontFamily:"inherit", fontSize:"inherit", textDecoration:"underline", textDecorationStyle:"dotted" }}>{r.studentName}</button>
                                  : <span>{r.studentName}</span>;
                            })()}
                            {r.studentName && r.parentName && <span style={{ color:colors.textMuted }}>{" "}(</span>}
                            {r.parentName && (() => {
                              const allC = allEmailContacts.find(c => c.name === r.parentName);
                              const pEmail = allC?.email;
                              return pEmail
                                ? <button onClick={() => openCompose([pEmail])} style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:colors.accent, fontFamily:"inherit", fontSize:"inherit", textDecoration:"underline", textDecorationStyle:"dotted" }}>{r.parentName}</button>
                                : <span>{r.parentName}</span>;
                            })()}
                            {r.studentName && r.parentName && <span style={{ color:colors.textMuted }}>)</span>}
                          </div>
                        )}

                        {/* Form fields — 2 col grid */}
                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px 14px", marginBottom:8 }}>
                          <div>
                            <span style={uLabel}>Date from</span>
                            <input type="date" value={f.date} onChange={e=>setRemindersMetaForm(p=>({...p,date:e.target.value}))} style={uInput} />
                          </div>
                          <div>
                            <span style={uLabel}>Date to</span>
                            <input type="date" value={f.endDate||""} onChange={e=>setRemindersMetaForm(p=>({...p,endDate:e.target.value}))} style={uInput} />
                          </div>
                          <div>
                            <span style={uLabel}>Week</span>
                            <select value={f.week} onChange={e=>setRemindersMetaForm(p=>({...p,week:e.target.value}))} style={uInput}>
                              <option value="">—</option>
                              {weekOptions.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <span style={uLabel}>Time</span>
                            <input type="time" value={f.time} onChange={e=>setRemindersMetaForm(p=>({...p,time:e.target.value}))} style={uInput} />
                          </div>
                          <div>
                            <span style={uLabel}>School</span>
                            <select value={f.schoolId} onChange={e=>setRemindersMetaForm(p=>({...p,schoolId:e.target.value,className:""}))} style={uInput}>
                              <option value="">—</option>
                              {schools.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          </div>
                          <div>
                            <span style={uLabel}>Class</span>
                            {schoolClasses2.length>0
                              ? <select value={f.className} onChange={e=>setRemindersMetaForm(p=>({...p,className:e.target.value}))} style={uInput}><option value="">—</option>{schoolClasses2.map(c=><option key={c} value={c}>{c}</option>)}</select>
                              : <input placeholder="e.g. 5A" value={f.className} onChange={e=>setRemindersMetaForm(p=>({...p,className:e.target.value}))} style={uInput} />}
                          </div>
                          <div style={{ position:"relative" }}>
                            <span style={uLabel}>Student</span>
                            <input placeholder="Search…" value={f.studentName} onChange={e=>{setRemindersMetaForm(p=>({...p,studentName:e.target.value}));setStudentDropOpen(true);}} onFocus={()=>setStudentDropOpen(true)} onBlur={()=>setTimeout(()=>setStudentDropOpen(false),150)} style={uInput} />
                            {studentDropOpen && matchedStudents2.length>0 && (
                              <div style={{ position:"absolute", top:"100%", left:0, right:0, zIndex:10, background:colors.cardBg, border:`1px solid ${colors.border}`, borderRadius:6, boxShadow:"0 4px 12px rgba(0,0,0,0.12)", maxHeight:120, overflowY:"auto" }}>
                                {matchedStudents2.map(s=>(
                                  <div key={s.id} onMouseDown={()=>{setRemindersMetaForm(p=>({...p,studentName:s.name,schoolId:p.schoolId||s.schoolId||""}));setStudentDropOpen(false);}}
                                    style={{ padding:"5px 8px", fontSize:11, cursor:"pointer" }}
                                    onMouseEnter={e=>e.currentTarget.style.background=colors.blueLight}
                                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                                    {s.name}{s.schoolId&&<span style={{fontSize:10,color:colors.textMuted,marginLeft:5}}>{schools.find(sc=>sc.id===s.schoolId)?.name?.split(" ")[0]}</span>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Notes */}
                        <div style={{ marginBottom:10 }}>
                          <span style={uLabel}>Notes</span>
                          <textarea rows={2} value={f.notes} onChange={e=>setRemindersMetaForm(p=>({...p,notes:e.target.value}))} placeholder="Extra context…" style={{ ...uInput, resize:"vertical", lineHeight:1.4 }} />
                        </div>

                        {/* Actions */}
                        <div style={{ display:"flex", gap:12, alignItems:"center" }}>
                          <button onClick={()=>{ saveReminders(reminders.map(x=>x.id===r.id?{...x,...f,text:f.text||x.text,mentions:f.mentions||x.mentions||[],week:f.week?String(parseInt(f.week)):"",endDate:f.endDate||undefined}:x)); setRemindersMetaModal(null); setRemindersMetaForm(null); setRemindersMentionQuery(null); }}
                            style={{ background:"none", border:"none", padding:0, cursor:"pointer", fontSize:11, fontWeight:600, color:colors.accent, fontFamily:"inherit" }}>save</button>
                          <button onClick={()=>{ saveReminders(reminders.filter(x=>x.id!==r.id)); setRemindersMetaModal(null); setRemindersMetaForm(null); }}
                            style={{ background:"none", border:"none", padding:0, cursor:"pointer", fontSize:11, color:colors.danger, fontFamily:"inherit" }}>delete</button>
                          <button onClick={()=>{ setRemindersMetaModal(null); setRemindersMetaForm(null); }}
                            style={{ background:"none", border:"none", padding:0, cursor:"pointer", fontSize:11, color:colors.textMuted, fontFamily:"inherit", marginLeft:"auto" }}>close</button>
                        </div>

                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Backup / Restore */}
      <DashboardBackupBar onBackup={onBackup} onRestore={onRestore} notify={notify} />

      {/* Error Log — subtle collapsible */}
      {errorLog && errorLog.length > 0 && <ErrorLogPanel errorLog={errorLog} />}

      <div style={{ textAlign: "center", padding: "16px 0 4px", fontSize: 11, color: colors.textMuted }}>
        Timetabling v{APP_VERSION}
      </div>

      {/* ── Calendar event form modal ── */}
      {calEventForm && (() => {
        const f = calEventForm;
        const tm = EVENT_TYPE_META[f.type] || EVENT_TYPE_META.personal;
        const isEdit = !!f.id;
        const needsSchool = f.type === "interruption" || f.type === "performance" || f.type === "public_holiday" || f.type === "staff_event";
        const needsClasses = f.type === "interruption";
        const needsSubtype = f.type === "interruption";
        const schoolClasses = f.schoolId
          ? [...new Set(students.filter(s => s.schoolId === f.schoolId).map(s => s.className).filter(Boolean))].sort()
          : [];
        const selectedClasses = (f.affectsClasses && f.affectsClasses !== "all")
          ? f.affectsClasses.split(",").map(c => c.trim()).filter(Boolean)
          : [];
        const toggleClass = (cls) => {
          const current = selectedClasses;
          const next = current.includes(cls) ? current.filter(c => c !== cls) : [...current, cls];
          setCalEventForm(prev => ({ ...prev, affectsClasses: next.length === 0 ? "all" : next.join(", ") }));
        };
        const inputStyle = { padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", width: "100%", boxSizing: "border-box", background: colors.cardBg };
        const labelStyle = { fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, display: "block" };

        const saveEvent = () => {
          if (!f.title.trim()) return;
          if (f.type !== "personal") {
            const entry = {
              id: (isEdit && f.sourceStore === "interruptions") ? f.id : uid(),
              schoolId: f.schoolId || "all",
              date: f.startDate,
              endDate: f.endDate || f.startDate,
              title: f.title.trim(),
              type: f.type === "interruption" ? (f.interruptionSubtype || "other") : f.type,
              affectsClasses: f.type === "interruption" ? (f.affectsClasses || "all") : "all",
              startTime: f.startTime || "",
              endTime: f.endTime || "",
              notes: f.details || "",
              source: "calendar",
            };
            if (isEdit && f.sourceStore === "interruptions") {
              setInterruptions(prev => prev.map(i => i.id === f.id ? entry : i));
            } else {
              setInterruptions(prev => [...prev, entry]);
            }
          } else {
            const entry = {
              id: (isEdit && f.sourceStore === "calendar") ? f.id : uid(),
              date: f.startDate,
              startDate: f.startDate,
              endDate: f.endDate || f.startDate,
              title: f.title.trim(),
              type: f.type,
              startTime: f.startTime || "",
              endTime: f.endTime || "",
              schoolId: f.schoolId || "",
              details: f.details || "",
              createdAt: new Date().toISOString(),
            };
            if (isEdit && f.sourceStore === "calendar") {
              saveCalendarEvents(calendarEvents.map(ev => ev.id === f.id ? entry : ev));
            } else {
              saveCalendarEvents([...calendarEvents, entry]);
            }
          }
          setCalEventForm(null);
        };

        const deleteEvent = () => {
          if (f.sourceStore === "interruptions") {
            setInterruptions(prev => prev.filter(i => i.id !== f.id));
          } else {
            saveCalendarEvents(calendarEvents.filter(ev => ev.id !== f.id));
          }
          setCalEventForm(null);
        };

        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.25)" }}
            onClick={e => { if (e.target === e.currentTarget) setCalEventForm(null); }}>
            <div style={{
              position: "fixed",
              left: f.x ? Math.min(f.x, window.innerWidth - 440) : "50%",
              top: f.y ? Math.min(f.y, window.innerHeight - 520) : "50%",
              transform: f.x ? "none" : "translate(-50%,-50%)",
              background: colors.cardBg, borderRadius: 14, padding: "20px 22px", width: 420,
              boxShadow: "0 8px 40px rgba(0,0,0,0.22)", zIndex: 10001,
              maxHeight: "90vh", overflowY: "auto",
            }}>
              {/* Header */}
              <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, marginBottom: 16 }}>
                {isEdit ? "Edit Event" : "New Event"}
              </div>

              {/* Type picker */}
              <div style={{ marginBottom: 16 }}>
                <span style={labelStyle}>Type</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {Object.entries(EVENT_TYPE_META).map(([key, meta]) => (
                    <button key={key} onClick={() => setCalEventForm(prev => ({ ...prev, type: key, schoolId: (key === "personal") ? "" : prev.schoolId, affectsClasses: "all", interruptionSubtype: "other" }))}
                      style={{ padding: "5px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: `1.5px solid ${f.type === key ? meta.border : colors.border}`, background: f.type === key ? meta.bg : colors.cardBg, color: f.type === key ? meta.text : colors.textMuted, transition: "all 0.12s" }}>
                      {meta.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Title */}
              <div style={{ marginBottom: 12 }}>
                <span style={labelStyle}>Title</span>
                <input value={f.title} onChange={e => setCalEventForm(prev => ({ ...prev, title: e.target.value }))}
                  placeholder="Event title *" autoFocus onKeyDown={e => { if (e.key === "Enter") saveEvent(); if (e.key === "Escape") setCalEventForm(null); }}
                  style={inputStyle} />
              </div>

              {/* Date range */}
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <span style={labelStyle}>Start date</span>
                  <input type="date" value={f.startDate} onChange={e => setCalEventForm(prev => ({ ...prev, startDate: e.target.value, endDate: prev.endDate < e.target.value ? e.target.value : prev.endDate }))}
                    style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <span style={labelStyle}>End date</span>
                  <input type="date" value={f.endDate || f.startDate} min={f.startDate} onChange={e => setCalEventForm(prev => ({ ...prev, endDate: e.target.value }))}
                    style={inputStyle} />
                </div>
              </div>

              {/* Time range */}
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <span style={labelStyle}>Start time <span style={{ textTransform: "none", fontWeight: 400 }}>(optional)</span></span>
                  <input type="time" value={f.startTime || ""} onChange={e => setCalEventForm(prev => ({ ...prev, startTime: e.target.value }))}
                    style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <span style={labelStyle}>End time <span style={{ textTransform: "none", fontWeight: 400 }}>(optional)</span></span>
                  <input type="time" value={f.endTime || ""} onChange={e => setCalEventForm(prev => ({ ...prev, endTime: e.target.value }))}
                    style={inputStyle} />
                </div>
              </div>

              {/* School selector */}
              {needsSchool && (
                <div style={{ marginBottom: 12 }}>
                  <span style={labelStyle}>School <span style={{ textTransform: "none", fontWeight: 400 }}>(optional)</span></span>
                  <select value={f.schoolId || ""} onChange={e => setCalEventForm(prev => ({ ...prev, schoolId: e.target.value, affectsClasses: "all" }))}
                    style={{ ...inputStyle, appearance: "none" }}>
                    <option value="">All Schools</option>
                    {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              )}

              {/* Interruption subtype */}
              {needsSubtype && (
                <div style={{ marginBottom: 12 }}>
                  <span style={labelStyle}>Interruption type</span>
                  <select value={f.interruptionSubtype || "other"} onChange={e => setCalEventForm(prev => ({ ...prev, interruptionSubtype: e.target.value }))}
                    style={{ ...inputStyle, appearance: "none" }}>
                    {INTERRUPTION_SUBTYPES.map(st => <option key={st.value} value={st.value}>{st.label}</option>)}
                  </select>
                </div>
              )}

              {/* Affects classes */}
              {needsClasses && f.schoolId && schoolClasses.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={labelStyle}>Affects classes</span>
                    <button onClick={() => setCalEventForm(prev => ({ ...prev, affectsClasses: "all" }))}
                      style={{ fontSize: 11, fontWeight: 600, color: f.affectsClasses === "all" ? colors.sidebarActive : colors.textMuted, background: f.affectsClasses === "all" ? colors.blueLight : "none", border: `1px solid ${f.affectsClasses === "all" ? colors.sidebarActive : colors.border}`, borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}>
                      All classes
                    </button>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {schoolClasses.map(cls => {
                      const sel = selectedClasses.includes(cls);
                      return (
                        <button key={cls} onClick={() => toggleClass(cls)}
                          style={{ padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: sel ? 700 : 400, fontFamily: "inherit", cursor: "pointer", border: `1.5px solid ${sel ? tm.border : colors.border}`, background: sel ? tm.bg : colors.cardBg, color: sel ? tm.text : colors.textMuted, transition: "all 0.12s" }}>
                          {cls}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Details */}
              <div style={{ marginBottom: 16 }}>
                <span style={labelStyle}>Notes <span style={{ textTransform: "none", fontWeight: 400 }}>(optional)</span></span>
                <textarea value={f.details || ""} onChange={e => setCalEventForm(prev => ({ ...prev, details: e.target.value }))}
                  placeholder="Any additional details…" rows={2}
                  style={{ ...inputStyle, resize: "vertical" }} />
              </div>

              {/* Action buttons */}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={saveEvent}
                  style={{ flex: 1, padding: "9px 0", borderRadius: 8, background: tm.border, color: "#fff", fontWeight: 700, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                  {isEdit ? "Save" : "Add"}
                </button>
                {isEdit && (
                  <button onClick={deleteEvent}
                    style={{ padding: "9px 14px", borderRadius: 8, background: colors.redLight, color: colors.danger, fontWeight: 700, fontSize: 13, border: `1px solid ${colors.danger}`, cursor: "pointer", fontFamily: "inherit" }}>
                    Delete
                  </button>
                )}
                <button onClick={() => setCalEventForm(null)}
                  style={{ padding: "9px 14px", borderRadius: 8, background: colors.bg, color: colors.textMuted, fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {/* ── Reminders @ mention dropdown (fixed, escapes overflow) ── */}
      {todoMentionQuery && (() => {
        const q = todoMentionQuery.query.toLowerCase();
        const hits = allEmailContacts.filter(c => c.name.toLowerCase().includes(q) || (c.sub||"").toLowerCase().includes(q)).slice(0, 6);
        if (!hits.length) return null;
        return (
          <div style={{ position:"fixed", top: todoMentionQuery.top, left: todoMentionQuery.left,
            width: Math.max(todoMentionQuery.width || 0, 220), zIndex: 10001,
            background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)", overflow: "hidden", fontFamily: "inherit" }}>
            <div style={{ padding: "4px 10px 2px", fontSize: 10, fontWeight: 700, color: colors.textMuted, letterSpacing: "0.04em" }}>@MENTION</div>
            {hits.map((c, i) => (
              <div key={c.email} onMouseDown={e => {
                e.preventDefault();
                const mq = todoMentionQuery;
                const tag = preferredFirstName(c.name) || c.name.split(" ")[0];
                if (mq.field === "main")  { setTodoInput(prev => prev.slice(0, mq.anchorPos) + `@${tag}` + prev.slice(mq.anchorPos + mq.query.length + 1)); setTodoAddMentions(prev => [...prev.filter(m => m.name !== tag), { name: tag, email: c.email }]); }
                if (mq.field === "edit")  { setTodoEditValue(prev => prev.slice(0, mq.anchorPos) + `@${tag}` + prev.slice(mq.anchorPos + mq.query.length + 1)); setTodoEditMentions(prev => [...prev.filter(m => m.name !== tag), { name: tag, email: c.email }]); }
                if (mq.field === "sub")   { setTodoSubInput(prev => prev.slice(0, mq.anchorPos) + `@${tag}` + prev.slice(mq.anchorPos + mq.query.length + 1)); setTodoSubMentions(prev => [...prev.filter(m => m.name !== tag), { name: tag, email: c.email }]); }
                if (mq.field === "notes") { setTodoNotesValue(prev => prev.slice(0, mq.anchorPos) + `@${tag}` + prev.slice(mq.anchorPos + mq.query.length + 1)); setTodoNotesMentions(prev => [...prev.filter(m => m.name !== tag), { name: tag, email: c.email }]); setTimeout(() => todoNotesRef.current?.focus(), 0); }
                setTodoMentionQuery(null); setTodoMentionIndex(0);
              }}
              style={{ padding:"6px 10px", fontSize:11, cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center",
                background: i === todoMentionIndex ? colors.blueLight : "transparent" }}>
                <span style={{ fontWeight:500, color:colors.text }}>{c.name}</span>
                {c.sub && <span style={{ fontSize:10, color:colors.textMuted }}>{c.sub}</span>}
              </div>
            ))}
          </div>
        );
      })()}
      {remindersMentionQuery && (() => {
        const q = remindersMentionQuery.query.toLowerCase();
        const hits = allEmailContacts.filter(c =>
          c.name.toLowerCase().includes(q) || (c.sub||"").toLowerCase().includes(q)
        ).slice(0, 6);
        return (
          <>
            <div style={{ position:"fixed", inset:0, zIndex:9990 }}
              onMouseDown={() => { setRemindersMentionQuery(null); setRemindersMentionIndex(0); }} />
            {hits.length > 0 && (
              <div style={{
                position:"fixed", top: remindersMentionQuery.top, left: remindersMentionQuery.left,
                width: Math.max(remindersMentionQuery.width || 0, 200),
                zIndex:9991, background:colors.cardBg, border:`1px solid ${colors.border}`,
                borderRadius:6, boxShadow:"0 4px 16px rgba(0,0,0,0.15)", overflow:"hidden", fontFamily:"inherit"
              }}>
                {hits.map((c, i) => (
                  <div key={i}
                    onMouseEnter={() => setRemindersMentionIndex(i)}
                    onMouseDown={e => {
                      e.stopPropagation();
                      const mq = remindersMentionQuery;
                      if (mq.remId === "__new__") {
                        setRemindersInput(prev => { const tag=`@${c.name}`; const before=prev.slice(0,mq.anchorPos); const after=prev.slice(mq.anchorPos+mq.query.length+1); return before+tag+after; });
                        setRemindersInputMentions(prev => [...prev.filter(m=>m.name!==c.name), { name:c.name, email:c.email }]);
                      } else {
                        setRemindersMetaForm(prev => { if (!prev) return prev; const cur=prev.text||""; const tag=`@${c.name}`; const before=cur.slice(0,mq.anchorPos); const after=cur.slice(mq.anchorPos+mq.query.length+1); const newMentions=[...(prev.mentions||[]).filter(m=>m.name!==c.name),{name:c.name,email:c.email}]; return {...prev,text:before+tag+after,mentions:newMentions}; });
                      }
                      setRemindersMentionQuery(null); setRemindersMentionIndex(0);
                    }}
                    style={{ padding:"6px 10px", fontSize:11, cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center", background: i === remindersMentionIndex ? colors.blueLight : "transparent" }}>
                    <span style={{ fontWeight:500, color:colors.text }}>{c.name}</span>
                    {c.sub && <span style={{ fontSize:10, color:colors.textMuted }}>{c.sub}</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        );
      })()}

      {/* ── Email body right-click context menu ── */}
      {emailContextMenu && (() => {
        const isEnquiry = emailContextMenu.email && classifyEmailFull(emailContextMenu.email) === "enquiry";
        const btnStyle = { display: "block", width: "100%", padding: "9px 14px", background: "none", border: "none", textAlign: "left", cursor: "pointer", color: colors.text, fontFamily: "inherit", fontSize: 13 };
        const btnHover = e => e.currentTarget.style.background = colors.blueLight;
        const btnLeave = e => e.currentTarget.style.background = "none";
        return (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{ position: "fixed", left: emailContextMenu.x, top: emailContextMenu.y, zIndex: 9999,
            background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)", minWidth: 180, overflow: "hidden",
            fontFamily: "inherit", fontSize: 13 }}>
          {emailContextMenu.fromAddr && (<>
            <button onClick={() => { openCompose([emailContextMenu.fromAddr], { from: schoolSenderForSourceEmail(emailContextMenu.email, schools) || "" }); setEmailContextMenu(null); setEmailContextSubMenu(null); }}
              style={btnStyle} onMouseEnter={btnHover} onMouseLeave={btnLeave}><span style={{ display: "flex", alignItems: "center", gap: 6 }}><Mail size={13} /> New Email</span></button>
            <button onClick={() => { navigator.clipboard?.writeText(emailContextMenu.fromAddr); setEmailContextMenu(null); setEmailContextSubMenu(null); }}
              style={btnStyle} onMouseEnter={btnHover} onMouseLeave={btnLeave}><span style={{ display: "flex", alignItems: "center", gap: 6 }}><Copy size={13} /> Copy Address</span></button>
            <button onClick={() => { setEmailSearchPersist(emailContextMenu.fromAddr); setEmailContextMenu(null); setEmailContextSubMenu(null); }}
              style={btnStyle} onMouseEnter={btnHover} onMouseLeave={btnLeave}><span style={{ display: "flex", alignItems: "center", gap: 6 }}><Search size={13} /> Search</span></button>
            <div style={{ position: "relative" }}
              onMouseEnter={() => setEmailContextSubMenu("contacts")}
              onMouseLeave={() => setEmailContextSubMenu(null)}>
              <button style={{ ...btnStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}
                onMouseEnter={btnHover} onMouseLeave={btnLeave}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}><UserPlus size={13} /> Add to Contacts</span><span style={{ fontSize: 11, color: colors.textMuted }}>›</span>
              </button>
              {emailContextSubMenu === "contacts" && (
                <div style={{ position: "absolute", left: "100%", top: 0, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.14)", minWidth: 160, overflow: "hidden", fontFamily: "inherit", fontSize: 13, zIndex: 10000 }}>
                  <button onClick={() => { setAddParentPrefill({ name: emailContextMenu.fromName, email: emailContextMenu.fromAddr }); onNavigate("students"); setEmailContextMenu(null); setEmailContextSubMenu(null); }}
                    style={btnStyle} onMouseEnter={btnHover} onMouseLeave={btnLeave}>Add Parent</button>
                  <button onClick={() => { setNewContactPrefill({ name: emailContextMenu.fromName, email: emailContextMenu.fromAddr }); onNavigate("contacts"); setEmailContextMenu(null); setEmailContextSubMenu(null); }}
                    style={btnStyle} onMouseEnter={btnHover} onMouseLeave={btnLeave}>Add School Contact</button>
                </div>
              )}
            </div>
            {(emailContextMenu.text || isEnquiry) && <div style={{ borderTop: `1px solid ${colors.border}`, margin: "3px 0" }} />}
          </>)}
          {emailContextMenu.text && (
            <button
              onClick={() => { navigator.clipboard?.writeText(emailContextMenu.text); setEmailContextMenu(null); setEmailContextSubMenu(null); }}
              style={btnStyle} onMouseEnter={btnHover} onMouseLeave={btnLeave}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Copy size={13} /> Copy</span>
            </button>
          )}
          {emailContextMenu.text && (
            <button
              onClick={() => {
                const match = resolveEmailSender(emailContextMenu.fromAddr);
                const _st = match.studentId ? students.find(s => s.id === match.studentId) : null;
                const _pd = parseReminderDates(emailContextMenu.text);
                const reminder = {
                  id: uid(), text: emailContextMenu.text.trim(), createdAt: new Date().toISOString(),
                  ..._pd,
                  ...(emailContextMenu.emailId ? { emailId: emailContextMenu.emailId } : {}),
                  ...(emailContextMenu.fromAddr ? { emailFrom: emailContextMenu.fromName || emailContextMenu.fromAddr, emailFromAddr: emailContextMenu.fromAddr } : {}),
                  ...(match.parentName ? { parentName: match.parentName } : {}),
                  ...(match.studentName ? { studentName: match.studentName } : {}),
                  ...(match.studentId ? { studentId: match.studentId } : {}),
                  ...(_st?.schoolId ? { schoolId: _st.schoolId } : {}),
                  ...(_st?.className ? { className: _st.className } : {}),
                };
                saveReminders([reminder, ...reminders]);
                notify("Added to Reminders", "success");
                setEmailContextMenu(null); setEmailContextSubMenu(null);
              }}
              style={btnStyle} onMouseEnter={btnHover} onMouseLeave={btnLeave}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Bell size={13} /> Add to Reminders</span>
            </button>
          )}
          {isEnquiry && (
            <button
              onClick={() => {
                const prefill = buildEnquiryPrefill(emailContextMenu.email, "pending");
                setNewStudentPrefill(prefill);
                onNavigate("students");
                setEmailContextMenu(null); setEmailContextSubMenu(null);
              }}
              style={btnStyle}
              onMouseEnter={btnHover}
              onMouseLeave={btnLeave}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Plus size={13} /> Add to waiting list</span>
            </button>
          )}
          {isEnquiry && (
            <button
              onClick={() => {
                const prefill = buildEnquiryPrefill(emailContextMenu.email, "trial");
                setNewStudentPrefill(prefill);
                onNavigate("students");
                setEmailContextMenu(null); setEmailContextSubMenu(null);
              }}
              style={btnStyle}
              onMouseEnter={btnHover}
              onMouseLeave={btnLeave}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Music size={13} /> Schedule trial lesson</span>
            </button>
          )}
        </div>
        );
      })()}
      {/* ── Attachment preview modal — draggable + resizable ── */}
      {attachmentPreview && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 10100, background: "rgba(0,0,0,0.45)", pointerEvents: "auto" }}
          onClick={closeAttachmentPreview}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: "fixed",
              left: previewPos.x, top: previewPos.y,
              width: previewSize.w, height: previewSize.h,
              background: colors.cardBg, borderRadius: 12,
              display: "flex", flexDirection: "column",
              boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
              overflow: "hidden", userSelect: "none",
            }}>
            {/* Header — drag handle */}
            <div
              onMouseDown={handlePreviewDragStart}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", borderBottom: `1px solid ${colors.border}`, flexShrink: 0, gap: 12, cursor: "grab", userSelect: "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden", minWidth: 0 }}>
                <Paperclip size={14} style={{ flexShrink: 0, color: colors.textMuted }} />
                <span style={{ fontWeight: 600, fontSize: 14, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {attachmentPreview.att.filename}
                </span>
                {attachmentPreview.att.size > 0 && (
                  <span style={{ fontSize: 11, color: colors.textMuted, flexShrink: 0 }}>
                    {attachmentPreview.att.size > 1024 * 1024
                      ? `${(attachmentPreview.att.size / 1024 / 1024).toFixed(1)} MB`
                      : `${Math.round(attachmentPreview.att.size / 1024)} KB`}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }} onMouseDown={e => e.stopPropagation()}>
                {!attachmentPreview.loading && (
                  <button
                    onClick={() => {
                      if (window.electronAPI?.gmailGetAttachment) {
                        window.electronAPI.gmailGetAttachment(attachmentPreview.messageId, attachmentPreview.att.attachmentId, attachmentPreview.att.filename)
                          .then(r => { if (!r.ok && r.error !== "Cancelled") alert("Download failed: " + r.error); });
                      }
                    }}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", background: colors.sidebarActive, color: "#fff", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                    <Download size={13} /> Download
                  </button>
                )}
                {!attachmentPreview.loading && setDocuments && (
                  <button
                    onClick={() => openSaveAttachModal(attachmentPreview.att, attachmentPreview.messageId)}
                    title="Save to Documents / Resources"
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", background: colors.accentLight, color: colors.accentDark, border: `1px solid ${colors.accent}40`, borderRadius: 6, fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                    <FolderInput size={13} /> Save to App
                  </button>
                )}
                <button onClick={closeAttachmentPreview}
                  style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "flex", alignItems: "center", padding: 4, borderRadius: 4 }}
                  onMouseEnter={e => e.currentTarget.style.color = colors.text}
                  onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}>
                  <X size={18} />
                </button>
              </div>
            </div>
            {/* Body */}
            <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
              {attachmentPreview.loading ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, color: colors.textMuted }}>
                  <Loader2 size={28} style={{ animation: "spin 1s linear infinite" }} />
                  <span style={{ fontSize: 13 }}>Loading preview…</span>
                </div>
              ) : attachmentPreview.error ? (
                <div style={{ textAlign: "center", color: colors.textMuted, padding: 24 }}>
                  <div style={{ fontSize: 32, marginBottom: 10 }}>⚠️</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 6 }}>Could not load preview</div>
                  <div style={{ fontSize: 12 }}>{attachmentPreview.error}</div>
                </div>
              ) : (() => {
                const type = getAttachmentType(attachmentPreview.att.filename);
                if (type === "image") {
                  const ext = (attachmentPreview.att.filename || "").split(".").pop().toLowerCase();
                  const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
                  return (
                    <img
                      src={`data:${mimeMap[ext] || "image/jpeg"};base64,${attachmentPreview.base64}`}
                      alt={attachmentPreview.att.filename}
                      style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 6, display: "block" }} />
                  );
                }
                if (type === "pdf") {
                  return (
                    <iframe
                      src={attachmentPreview.blobUrl}
                      title={attachmentPreview.att.filename}
                      style={{ width: "100%", height: "100%", border: "none", borderRadius: 6 }} />
                  );
                }
                if (type === "text") {
                  let text = "";
                  try {
                    text = new TextDecoder().decode(Uint8Array.from(atob(attachmentPreview.base64), c => c.charCodeAt(0)));
                  } catch {
                    text = "(Could not decode file content)";
                  }
                  return (
                    <pre style={{ width: "100%", height: "100%", overflow: "auto", margin: 0, fontSize: 12, lineHeight: 1.6, color: colors.text, background: colors.bg, padding: "12px 16px", borderRadius: 8, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace", boxSizing: "border-box" }}>
                      {text}
                    </pre>
                  );
                }
                // Other — no preview available
                return (
                  <div style={{ textAlign: "center", color: colors.textMuted, padding: 32 }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>📎</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 6 }}>Preview not available</div>
                    <div style={{ fontSize: 12, marginBottom: 20 }}>This file type can't be previewed in the app.</div>
                    <button
                      onClick={() => {
                        if (window.electronAPI?.gmailGetAttachment) {
                          window.electronAPI.gmailGetAttachment(attachmentPreview.messageId, attachmentPreview.att.attachmentId, attachmentPreview.att.filename)
                            .then(r => { if (!r.ok && r.error !== "Cancelled") alert("Download failed: " + r.error); });
                        }
                      }}
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 18px", background: colors.sidebarActive, color: "#fff", border: "none", borderRadius: 7, fontSize: 13, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                      <Download size={14} /> Download to view
                    </button>
                  </div>
                );
              })()}
            </div>
            {/* Resize handles — edges */}
            <div onMouseDown={e => startResize(e, false, false, true,  false)} style={{ position:"absolute", top:8,    right:0,  bottom:8,  width:5,  cursor:"ew-resize",   zIndex:11 }} />
            <div onMouseDown={e => startResize(e, false, false, false, true)}  style={{ position:"absolute", top:8,    left:0,   bottom:8,  width:5,  cursor:"ew-resize",   zIndex:11 }} />
            <div onMouseDown={e => startResize(e, false, true,  false, false)} style={{ position:"absolute", bottom:0, left:8,   right:8,   height:5, cursor:"ns-resize",   zIndex:11 }} />
            <div onMouseDown={e => startResize(e, true,  false, false, false)} style={{ position:"absolute", top:0,    left:8,   right:8,   height:5, cursor:"ns-resize",   zIndex:11 }} />
            {/* Corners */}
            <div onMouseDown={e => startResize(e, false, true,  true,  false)} style={{ position:"absolute", bottom:0, right:0,  width:10,  height:10, cursor:"nwse-resize", zIndex:12 }} />
            <div onMouseDown={e => startResize(e, false, true,  false, true)}  style={{ position:"absolute", bottom:0, left:0,   width:10,  height:10, cursor:"nesw-resize", zIndex:12 }} />
            <div onMouseDown={e => startResize(e, true,  false, true,  false)} style={{ position:"absolute", top:0,    right:0,  width:10,  height:10, cursor:"nesw-resize", zIndex:12 }} />
            <div onMouseDown={e => startResize(e, true,  false, false, true)}  style={{ position:"absolute", top:0,    left:0,   width:10,  height:10, cursor:"nwse-resize", zIndex:12 }} />
          </div>
        </div>
      )}

      {emailContextMenu && (
        <div onClick={() => { setEmailContextMenu(null); setEmailContextSubMenu(null); }} onContextMenu={e => { e.preventDefault(); setEmailContextMenu(null); setEmailContextSubMenu(null); }}
          style={{ position: "fixed", inset: 0, zIndex: 9998 }} />
      )}

      {/* ── Quick-add To-Do modal (⌘.) ── rendered via portal to escape display:none parent */}
      {quickTodoOpen && createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 10200, background: "rgba(0,0,0,0.18)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setQuickTodoOpen(false)}>
          <div style={{ background: colors.cardBg, borderRadius: 14, width: 400, maxWidth: "90vw", boxShadow: "0 20px 60px rgba(0,0,0,0.28)", border: `1px solid ${colors.border}`, overflow: "hidden" }}
            onClick={e => e.stopPropagation()}>
            {/* Header — matches the todo panel tab strip */}
            <div style={{ background: colors.sidebar, padding: "11px 16px", display: "flex", alignItems: "center", justifyContent: "center", borderBottom: `3px solid ${colors.accent}` }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: "#fff" }}>To Do</span>
            </div>
            {/* Input area */}
            <div style={{ padding: "12px 16px 14px" }}>
              <input
                ref={quickTodoInputRef}
                value={quickTodoInput}
                onChange={e => setQuickTodoInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && quickTodoInput.trim()) {
                    const item = { id: uid(), text: quickTodoInput.trim(), done: false, tag: "manual", createdAt: new Date().toISOString(), ...(quickTodoCategory ? { category: quickTodoCategory } : {}) };
                    saveTodo([item, ...todoItemsRef.current]);
                    setQuickTodoOpen(false);
                    notify("Task added");
                  }
                }}
                placeholder="Add a task… (press Enter)"
                style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: colors.text, background: colors.cardBg, outline: "none" }}
                onFocus={e => e.target.style.borderColor = colors.accent}
                onBlur={e => e.target.style.borderColor = colors.inputBorder}
              />
              {/* Category chips */}
              {todoCategories.length > 0 && (
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 9 }}>
                  {todoCategories.map(cat => {
                    const active = quickTodoCategory === cat.id;
                    return (
                      <button key={cat.id}
                        onMouseDown={e => { e.preventDefault(); setQuickTodoCategory(active ? null : cat.id); }}
                        style={{ padding: "3px 9px", borderRadius: 12, border: active ? `1.5px solid ${cat.color}` : `1.5px solid ${colors.border}`, background: active ? `${cat.color}18` : "transparent", color: active ? cat.color : colors.textMuted, fontSize: 11, fontWeight: active ? 700 : 400, cursor: "pointer", fontFamily: "inherit" }}>
                        {cat.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Quick-add Reminder modal (⌘/) ── rendered via portal to escape display:none parent */}
      {quickReminderOpen && (() => {
        const CORAL_BG = darkMode ? colors.accentLight : "#FDF0ED";
        const CORAL_BORDER = colors.accent;
        return createPortal(
          <div style={{ position: "fixed", inset: 0, zIndex: 10200, background: "rgba(0,0,0,0.18)", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setQuickReminderOpen(false)}>
            <div style={{ background: CORAL_BG, borderRadius: 12, width: 340, maxWidth: "90vw", minHeight: 160, boxShadow: "0 20px 60px rgba(0,0,0,0.22)", border: `1.5px solid ${CORAL_BORDER}`, overflow: "hidden", display: "flex", flexDirection: "column" }}
              onClick={e => e.stopPropagation()}>
              {/* Ghost textarea at top — matches real reminder panel */}
              <div style={{ flex: 1, padding: "10px 12px 4px", cursor: "text" }}
                onClick={() => quickReminderInputRef.current?.focus()}>
                <textarea
                  ref={quickReminderInputRef}
                  value={quickReminderInput}
                  onChange={e => setQuickReminderInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (!quickReminderInput.trim()) return;
                      const entry = { id: uid(), text: quickReminderInput.trim(), createdAt: new Date().toISOString() };
                      saveReminders([entry, ...reminders]);
                      setQuickReminderOpen(false);
                      notify("Reminder added");
                    }
                  }}
                  rows={1}
                  placeholder=""
                  style={{ display: "block", width: "100%", boxSizing: "border-box", fontSize: 12, lineHeight: 1.5,
                    padding: 0, margin: "0 0 4px 0", border: "none", background: CORAL_BG,
                    boxShadow: `inset 0 0 0 1000px ${CORAL_BG}`, WebkitBoxShadow: `inset 0 0 0 1000px ${CORAL_BG}`,
                    color: colors.text, caretColor: CORAL_BORDER, outline: "none",
                    fontFamily: "inherit", resize: "none", overflow: "hidden",
                    userSelect: "text", cursor: "text", WebkitAppearance: "none",
                    height: "1.5em" }}
                  onInput={e => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                />
              </div>
            </div>
          </div>,
          document.body
        );
      })()}
      {/* ── Attachment right-click context menu ── */}
      {attCtxMenu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={() => setAttCtxMenu(null)} />
          <div ref={attCtxRef} style={{ position: "fixed", top: attCtxMenu.y, left: attCtxMenu.x, zIndex: 9999, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 200, overflow: "hidden", fontFamily: "inherit" }}>
            <button
              onClick={() => openSaveAttachModal(attCtxMenu.att, attCtxMenu.messageId)}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 14px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit" }}
              onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
              onMouseLeave={e => e.currentTarget.style.background = "none"}>
              <FolderInput size={13} style={{ color: colors.accent }} />
              Save to Documents / Resources
            </button>
          </div>
        </>
      )}

      {/* ── Save Attachment Modal ── */}
      {saveAttachModal && createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 10200, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setSaveAttachModal(null)}>
          <div style={{ background: colors.cardBg, borderRadius: 14, width: 460, maxWidth: "92vw", boxShadow: "0 20px 60px rgba(0,0,0,0.28)", border: `1px solid ${colors.border}`, overflow: "hidden" }}
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ background: colors.sidebarHover, padding: "13px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <FolderInput size={15} style={{ color: "#fff", opacity: 0.8 }} />
                <span style={{ fontWeight: 600, fontSize: 14, color: "#fff" }}>Save Attachment</span>
              </div>
              <button onClick={() => setSaveAttachModal(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.6)", display: "flex", alignItems: "center", padding: 2, borderRadius: 4 }}
                onMouseEnter={e => e.currentTarget.style.color = "#fff"} onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.6)"}>
                <X size={16} />
              </button>
            </div>
            {/* Filename display */}
            <div style={{ padding: "12px 18px 0", display: "flex", alignItems: "center", gap: 7 }}>
              <Paperclip size={13} style={{ color: colors.textMuted, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: colors.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{saveAttachModal.att.filename}</span>
            </div>
            {/* Section toggle */}
            <div style={{ padding: "14px 18px 0" }}>
              <div style={{ display: "flex", gap: 0, background: colors.bg, border: `2px solid ${colors.sidebarHover}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
                {[{ id: "documents", label: "Documents" }, { id: "resources", label: "Resources" }].map(s => (
                  <button key={s.id} onClick={() => setSaveAttachSection(s.id)}
                    style={{ flex: 1, padding: "7px 0", border: "none", fontSize: 13, fontFamily: "inherit", cursor: "pointer", fontWeight: 600, background: saveAttachSection === s.id ? colors.sidebarHover : "transparent", color: saveAttachSection === s.id ? "#fff" : colors.textMuted, transition: "background 0.15s, color 0.15s" }}>
                    {s.label}
                  </button>
                ))}
              </div>

              {/* Fields */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {/* Label — shared */}
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Label</label>
                  <input value={saveAttachForm.label} onChange={e => setSaveAttachForm(f => ({ ...f, label: e.target.value }))}
                    style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: colors.text, background: colors.cardBg }} />
                </div>

                {saveAttachSection === "documents" ? (<>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div>
                      <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Type</label>
                      <select value={saveAttachForm.type} onChange={e => setSaveAttachForm(f => ({ ...f, type: e.target.value }))}
                        style={{ width: "100%", padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
                        {SAVE_ATT_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Expiry Date</label>
                      <input type="date" value={saveAttachForm.expiryDate} onChange={e => setSaveAttachForm(f => ({ ...f, expiryDate: e.target.value }))}
                        style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit" }} />
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div>
                      <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Teacher <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label>
                      <select value={saveAttachForm.teacherId} onChange={e => setSaveAttachForm(f => ({ ...f, teacherId: e.target.value }))}
                        style={{ width: "100%", padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
                        <option value="">No teacher</option>
                        {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>School <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label>
                      <select value={saveAttachForm.schoolId} onChange={e => setSaveAttachForm(f => ({ ...f, schoolId: e.target.value }))}
                        style={{ width: "100%", padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
                        <option value="">No school</option>
                        {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Notes <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label>
                    <input value={saveAttachForm.notes} onChange={e => setSaveAttachForm(f => ({ ...f, notes: e.target.value }))}
                      placeholder="Any additional notes…"
                      style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: colors.text, background: colors.cardBg }} />
                  </div>
                </>) : (<>
                  <div>
                    <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Category</label>
                    <select value={saveAttachForm.category} onChange={e => setSaveAttachForm(f => ({ ...f, category: e.target.value }))}
                      style={{ width: "100%", padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
                      {SAVE_ATT_RES_CATS.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Description <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label>
                    <input value={saveAttachForm.description} onChange={e => setSaveAttachForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="Brief description…"
                      style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: colors.text, background: colors.cardBg }} />
                  </div>
                </>)}
              </div>
            </div>

            {/* Footer */}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "16px 18px" }}>
              <button onClick={() => setSaveAttachModal(null)}
                style={{ padding: "7px 18px", background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: colors.textLight, fontWeight: 500 }}>
                Cancel
              </button>
              <button onClick={confirmSaveAttach}
                style={{ padding: "7px 18px", background: colors.accent, border: "none", borderRadius: 7, fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: "#fff", fontWeight: 600 }}>
                Save to {saveAttachSection === "documents" ? "Documents" : "Resources"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Session 5B follow-up — styled hover popover for per-school warning chips.
          Style values lifted verbatim from WeeklyAdjustments.js renderHoverPopover's
          "constraints" variant (L344-368) so the two surfaces read as the same family. */}
      {warningPopover && (() => {
        const { rect, lines } = warningPopover;
        const spaceBelow = window.innerHeight - rect.bottom;
        const topPos = spaceBelow > 200 ? rect.bottom + 6 : rect.top - 6;
        const anchor = spaceBelow > 200 ? "top" : "bottom";
        const popLeft = Math.min(rect.left, window.innerWidth - 280);
        return (
          <div style={{
            position: "fixed", left: popLeft,
            [anchor]: anchor === "top" ? topPos : window.innerHeight - topPos,
            zIndex: 2000, background: colors.cardBg, borderRadius: 10,
            boxShadow: "0 4px 20px rgba(0,0,0,0.15)", border: `1.5px solid ${colors.danger}`,
            padding: "10px 13px", width: 260, pointerEvents: "none", fontFamily: "inherit",
          }}>
            {lines.map((line, li) => (
              <div key={li} style={{ color: colors.danger, fontWeight: 500, fontSize: 11, display: "flex", alignItems: "flex-start", gap: 5, marginBottom: li < lines.length - 1 ? 4 : 0 }}>
                <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 2 }} /> <span>{line}</span>
              </div>
            ))}
          </div>
        );
      })()}

    </div>
  );
}

// ============================================================
// SPECIALIST TIMETABLE MANAGER
// ============================================================
