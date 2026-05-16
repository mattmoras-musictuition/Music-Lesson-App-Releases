// ============================================================
// CalendarManager.js  — full calendar page (replaces InterruptionsManager)
// ============================================================

import React, { useState, useEffect, useMemo } from "react";
import { ChevronUp, ChevronDown, Printer, PalmtreeIcon, X, AlertTriangle } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { uid } from "../utils/helpers";
import { anthropicFetch, getAnthropicHeaders } from "../utils/api";
import { PageTitle, NavButtons, Btn } from "../components/ui/SharedUI";
import { INTR_DISPLAY_TYPE } from "../utils/eventTypes";

// ---- Constants ----
const WEEK_DAYS   = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Keep in sync with EVENT_TYPE_META in Dashboard.js (different shape:
// that copy uses `dot` instead of `darkBg`).
const EVENT_TYPE_META = {
  personal:       { label: "Personal",       bg: "#E8EDF5", darkBg: "rgba(107,130,168,0.18)", border: "#6B82A8", text: "#3B4E6E" },
  performance:    { label: "Performance",    bg: "#EEE9F5", darkBg: "rgba(139,122,175,0.18)", border: "#8B7AAF", text: "#5C4A80" },
  interruption:   { label: "Interruption",   bg: "#FEF3E2", darkBg: "rgba(212,136,42,0.18)",  border: "#D4882A", text: "#7A4E10" },
  public_holiday: { label: "Public Holiday", bg: "#FEE8E8", darkBg: "rgba(196,84,84,0.18)",   border: "#C45454", text: "#7A1A1A" },
  staff_event:    { label: "Staff Event",    bg: "#F0EEFF", darkBg: "rgba(124,58,237,0.18)",  border: "#7C3AED", text: "#4C1D95" },
};

// Keep in sync with INTERRUPTION_SUBTYPES in Dashboard.js (that copy
// also carries `curriculum_day` and omits the displayType field).
// Display category is resolved via INTR_DISPLAY_TYPE (shared util).
const INTERRUPTION_SUBTYPES = [
  { value: "student_free", label: "Student Free Day"  },
  { value: "excursion",    label: "Excursion"          },
  { value: "carnival",     label: "Carnival / Sports"  },
  { value: "swimming",     label: "Swimming"           },
  { value: "assembly",     label: "Assembly"           },
  { value: "camp",         label: "Camp"               },
  { value: "photos",       label: "Photo Day"          },
  { value: "concert",      label: "Concert"            },
  { value: "other",        label: "Other"              },
];

// ---- Helpers ----
function getDatesInRange(a, b) {
  const start = a < b ? a : b;
  const end   = a < b ? b : a;
  const dates = [];
  let cur = start;
  while (cur <= end) { dates.push(cur); cur = addDays(cur, 1); }
  return dates;
}
function getMondayOf(date) {
  const d = new Date(date);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}
function toDS(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function addDays(ds, n) {
  const d = new Date(ds + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toDS(d);
}
function fmtDate(ds) {
  if (!ds) return "";
  const d = new Date(ds + "T00:00:00");
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}
function getAppToday() {
  const tz = localStorage.getItem("mt-timezone") || "Australia/Melbourne";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return toDS(new Date());
  }
}

// ============================================================
// MINI MONTH COMPONENT
// ============================================================
function MiniMonth({ year, month, todayDs, eventMap, termBreaks, displayYear, displayMonth, onClick, hoveredDs, hoveredRange }) {
  const { colors, darkMode } = useTheme();
  const base  = new Date(year, month, 1);
  const start = getMondayOf(base);
  const weeks = [];
  const cur   = new Date(start);
  for (let w = 0; w < 6; w++) {
    const week = Array.from({ length: 7 }, () => { const d = new Date(cur); cur.setDate(cur.getDate() + 1); return d; });
    weeks.push(week);
    if (w >= 4 && week[6].getMonth() !== month) break;
  }
  const isCurrent = year === displayYear && month === displayMonth;
  const CORAL = colors.accent;
  const NAVY  = colors.sidebarActive;
  return (
    <div style={{ flex: "1 1 0", minWidth: 0, cursor: "pointer" }} onClick={() => onClick(year, month)}>
      <div style={{ fontSize: 10, fontWeight: 700,
        color: isCurrent ? CORAL : colors.textMuted,
        textAlign: "center", marginBottom: 5, letterSpacing: 0.5,
        textTransform: "uppercase",
        borderBottom: isCurrent ? `2px solid ${CORAL}` : "2px solid transparent",
        paddingBottom: 3 }}>
        {MONTH_SHORT[month]} {year}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1 }}>
        {WEEK_DAYS.map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: 8, color: colors.textMuted, fontWeight: 700, paddingBottom: 2 }}>
            {d[0]}
          </div>
        ))}
        {weeks.flat().map((date, i) => {
          const ds       = toDS(date);
          const inMonth  = date.getMonth() === month;
          const isToday  = ds === todayDs;
          const tb       = termBreaks.find(tb => ds >= tb.date && ds <= (tb.endDate || tb.date));
          const isWknd   = date.getDay() === 0 || date.getDay() === 6;
          const firstEv  = inMonth && !isToday ? eventMap[ds]?.[0] : null;
          const evMeta   = firstEv ? EVENT_TYPE_META[firstEv._displayType || firstEv.type] : null;
          const isInHoveredRange = inMonth && !isToday && hoveredRange
            && ds >= hoveredRange.start && ds <= hoveredRange.end;
          const hoveredEvMeta = isInHoveredRange && hoveredRange.type
            ? EVENT_TYPE_META[hoveredRange.type]
            : null;
          const borderColor = isInHoveredRange ? colors.sidebarActive : CORAL;
          const bg = isToday           ? NAVY
                   : evMeta            ? (darkMode ? "rgba(52,69,101,0.25)" : "rgba(52,69,101,0.10)")
                   : tb && inMonth     ? (darkMode ? "#2A2810" : "#FFF9E0")
                   : isWknd && inMonth ? (darkMode ? "#252232" : "#E8EDF5")
                   : "transparent";
          return (
            <div key={i} style={{ textAlign: "center", fontSize: 9, borderRadius: 3,
              padding: "1px 0", width: "100%", lineHeight: "16px", position: "relative",
              opacity: inMonth ? 1 : 0.2, fontWeight: isToday ? 700 : 400,
              color: isToday ? "#fff" : colors.text,
              background: bg,
              boxShadow: isInHoveredRange ? `inset 0 0 0 1.5px ${borderColor}` : "none" }}>
              {date.getDate()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export function CalendarManager({ interruptions, setInterruptions, schools, specialists, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory, scanPreview, setScanPreview }) {
  const { colors, darkMode } = useTheme();

  // ---- View state ----
  const monthOffset    = (viewState || {}).monthOffset ?? 0;
  const setMonthOffset = v => setViewState(p => ({ ...p, monthOffset: typeof v === "function" ? v(p.monthOffset ?? 0) : v }));



  // ---- Calendar events ----
  const [calEvents, setCalEventsState] = useState(() => {
    try { return JSON.parse(localStorage.getItem("mt-calendar-events") || "[]"); } catch { return []; }
  });
  const saveCalEvents = evs => {
    setCalEventsState(evs);
    try { localStorage.setItem("mt-calendar-events", JSON.stringify(evs)); } catch {}
  };

  // ---- UI state ----
  const [eventForm,         setEventForm]         = useState(null);
  const [activeFilters,     setActiveFilters]      = useState([]);   // [] = All
  const [hoverPopover,      setHoverPopover]       = useState(null);
  const showWeekNums = true;

  // ---- Fetch Term Dates ----
  const [fetchingTermDates, setFetchingTermDates] = useState(false);
  const fetchTermDatesAndHolidays = async () => {
    setFetchingTermDates(true);
    try {
      const yr = new Date().getFullYear();
      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 4000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content:
            `Search for Victorian (Australia) school term dates for ${yr} and ${yr+1}, plus all Victorian public holidays for those years.\n\nReturn ONLY a JSON array, no other text, no markdown backticks. Each entry:\n- date: "YYYY-MM-DD"\n- endDate: "YYYY-MM-DD" (same as date for single-day events; full break span for term breaks)\n- title: descriptive name\n- type: "public_holiday" or "term_break"\n\nFor term breaks, use the full holiday period between terms. Return the JSON array only.`
          }]
        })
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data  = await response.json();
      const text  = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const clean = text.replace(/```json|```/g, "").trim();
      const match = clean.match(/\[[\s\S]*\]/);
      let entries;
      try { entries = match ? JSON.parse(match[0]) : JSON.parse(clean); }
      catch { const last = clean.lastIndexOf("}"); if (last > 0) { let rec = clean.slice(0, last+1); if (!rec.trim().endsWith("]")) rec += "]"; if (!rec.trim().startsWith("[")) rec = "[" + rec; entries = JSON.parse(rec); } else throw new Error("Could not parse response"); }
      if (!Array.isArray(entries) || !entries.length) { notify("Could not find term dates. Try again later.", "warning"); return; }
      const today = new Date().toISOString().slice(0, 10);
      const existing = new Set(interruptions.map(i => `${i.date}|${i.title}`));
      const newEntries = entries
        .map(e => ({ id: uid(), schoolId: "all", date: e.date||"", endDate: e.endDate||e.date||"", title: e.title||"", type: e.type||"public_holiday", affectsClasses: "all", startTime: "", endTime: "", notes: "", source: "auto-fetched" }))
        .filter(e => e.date && !existing.has(`${e.date}|${e.title}`) && (e.endDate||e.date) >= today);
      if (!newEntries.length) { notify("Term dates and holidays are already up to date!", "success"); return; }
      setInterruptions(prev => [...prev, ...newEntries]);
      const termCount = newEntries.filter(e => e.type === "term_break").length;
      const holCount  = newEntries.filter(e => e.type === "public_holiday").length;
      notify(`Added ${termCount} term break${termCount !== 1 ? "s" : ""} and ${holCount} public holiday${holCount !== 1 ? "s" : ""}. These now appear on the Calendar.`);
    } catch (err) {
      notify("Failed to fetch term dates: " + err.message, "danger");
    }
    setFetchingTermDates(false);
  };
  const [showMiniMonths,    setShowMiniMonths]     = useState(() => localStorage.getItem("mt-cal-minimonths") === "1");
  const [upcomingExpanded,  setUpcomingExpanded]   = useState(false);
  const [hoveredDs,         setHoveredDs]          = useState(null);
  const [selectedDays,      setSelectedDays]       = useState(new Set());
  const [selectionIsRange,  setSelectionIsRange]   = useState(false);
  const [modalOffset,       setModalOffset]        = useState({ x:0, y:0 });
  const [modalCenter,       setModalCenter]        = useState({ x:"50%", y:"50%" });
  const selectionAnchorRef = React.useRef(null);
  const dragRef            = React.useRef(null);
  const calendarRef        = React.useRef(null);

  const today = getAppToday();
  const now   = new Date();

  // ---- Keyboard arrow navigation ----
  useEffect(() => {
    const handler = e => {
      if (eventForm) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowDown") { e.preventDefault(); setMonthOffset(v => v + 1); }
      if (e.key === "ArrowUp")   { e.preventDefault(); setMonthOffset(v => v - 1); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [eventForm]);

  // ---- Effects ----
  useEffect(() => { setMonthOffset(0); }, []);
  useEffect(() => { setEventForm(null); setSelectedDays(new Set()); selectionAnchorRef.current = null; }, [resetKey]);
  useEffect(() => { if (scanPreview) setScanPreview?.(null); }, [scanPreview]);
  useEffect(() => { localStorage.setItem("mt-cal-minimonths", showMiniMonths ? "1" : "0"); }, [showMiniMonths]);

  // Auto-purge past non-permanent interruptions on mount
  useEffect(() => {
    let changed = false;
    let updated = interruptions.filter(i => {
      if (i.type === "term_break" || i.type === "public_holiday") return true;
      const end = i.endDate || i.date;
      if (end && end < today) { changed = true; return false; }
      return true;
    });
    updated = updated.map(i => {
      if (!i.startTime && i.notes) {
        const m = i.notes.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
        if (m) { changed = true; return { ...i, startTime: m[1], endTime: m[2], notes: "" }; }
      }
      return i;
    });
    if (changed) setInterruptions(updated);
  }, []);

  // ---- Computed: term breaks ----
  const termBreaks = useMemo(() =>
    interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date)),
    [interruptions]
  );
  const getTermBreak = ds => termBreaks.find(tb => ds >= tb.date && ds <= (tb.endDate || tb.date));

  // ---- Term periods: derive T1/T2/T3/T4 from gaps between breaks ----
  const termPeriods = useMemo(() => {
    if (termBreaks.length < 1) return [];

    // Helper: first weekday after Australia Day for a given year.
    // Uses a stored public_holiday entry if available; otherwise falls back to
    // the first Tuesday on or after Jan 27 (matching InterruptionsManager logic).
    const getTerm1Start = (year) => {
      const ausDayHol = interruptions.find(i =>
        i.type === "public_holiday" && i.date && i.date.startsWith(year + "-01-2")
      );
      if (ausDayHol) {
        const d = new Date(ausDayHol.date + "T00:00:00");
        d.setDate(d.getDate() + 1);
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
        return toDS(d);
      }
      // Fallback: first Tuesday on or after Jan 27
      const d = new Date(year, 0, 27);
      while (d.getDay() !== 2) d.setDate(d.getDate() + 1);
      return toDS(d);
    };

    // Gaps between consecutive breaks → T2, T3, T4
    const raw = [];
    for (let i = 1; i < termBreaks.length; i++) {
      const prev  = termBreaks[i - 1];
      const curr  = termBreaks[i];
      const start = addDays(prev.endDate || prev.date, 1);
      const end   = addDays(curr.date, -1);
      if (start <= end) raw.push({ start, end });
    }

    // Group by school year and number T2–T4
    const byYear = {};
    raw.forEach(p => {
      const yr = p.start.slice(0, 4);
      if (!byYear[yr]) byYear[yr] = [];
      byYear[yr].push(p);
    });

    // Synthesise Term 1 for each year: from Australia Day anchor to day before first break
    const years = [...new Set(termBreaks.map(tb => tb.date.slice(0, 4)))];
    years.forEach(yr => {
      const firstBreakOfYear = termBreaks.find(tb => tb.date.startsWith(yr));
      if (!firstBreakOfYear) return;
      const t1Start = getTerm1Start(parseInt(yr, 10));
      const t1End   = addDays(firstBreakOfYear.date, -1);
      if (t1Start <= t1End) {
        if (!byYear[yr]) byYear[yr] = [];
        // Only add if nothing already starts before the first break
        const alreadyHasT1 = byYear[yr].some(p => p.start < firstBreakOfYear.date);
        if (!alreadyHasT1) byYear[yr].unshift({ start: t1Start, end: t1End });
      }
    });

    const result = [];
    Object.values(byYear).forEach(yt => {
      yt.sort((a, b) => a.start.localeCompare(b.start));
      yt.forEach((t, i) => result.push({ ...t, termNum: i + 1 }));
    });
    return result.sort((a, b) => a.start.localeCompare(b.start));
  }, [termBreaks, interruptions]);

  // Returns week info for the Monday of a given week row
  const getTermWeekInfo = (mondayDs) => {
    const MS_WEEK = 7 * 24 * 60 * 60 * 1000;
    // In a term?
    const term = termPeriods.find(t => mondayDs >= t.start && mondayDs <= t.end);
    if (term) {
      // Anchor to the Monday of the week containing the term's first day
      const termFirstDay  = new Date(term.start + "T00:00:00");
      const termFirstMon  = getMondayOf(termFirstDay);
      const thisMonday    = new Date(mondayDs + "T00:00:00");
      const diffMs        = thisMonday.getTime() - termFirstMon.getTime();
      const wk            = Math.round(diffMs / MS_WEEK) + 1;
      return { type: "term", termNum: term.termNum, weekNum: Math.max(1, wk) };
    }
    // In a holiday break?
    const tb = termBreaks.find(b => mondayDs >= b.date && mondayDs <= (b.endDate || b.date));
    if (tb) {
      const wk = Math.floor((new Date(mondayDs + "T00:00:00") - new Date(tb.date + "T00:00:00")) / MS_WEEK) + 1;
      return { type: "holiday", weekNum: wk };
    }
    return null;
  };

  // ---- Term start dates (for stripe + label) ----
  const termStartInfo = useMemo(() => {
    const set = new Set();
    const map = {};
    termBreaks.forEach((tb, i) => {
      const ds = addDays(tb.endDate || tb.date, 1);
      set.add(ds);
      map[ds] = i + 2;
    });
    return { set, map };
  }, [termBreaks]);

  // ---- Event map ----
  const eventMap = useMemo(() => {
    const map = {};
    const add = (ds, ev) => { if (!map[ds]) map[ds] = []; map[ds].push(ev); };
    for (const ev of calEvents) {
      const start = ev.startDate || ev.date;
      if (!start) continue;
      // Skip private teacher events (is_private true) — only show shared ones
      if (ev.type === "teacher_event" && ev.is_private) continue;
      // For teacher events, enrich the meta label with teacher name
      const evWithMeta = ev.type === "teacher_event"
        ? { ...ev, _store: "cal", _teacherEventMeta: { ...EVENT_TYPE_META.staff_event, label: `${ev.teacher_name || "Staff"} Event`, border: ev.teacher_color || "#7C3AED" } }
        : { ...ev, _store: "cal" };
      add(start, evWithMeta);
      if (ev.endDate && ev.endDate > start) {
        const cur = new Date(start + "T00:00:00");
        cur.setDate(cur.getDate() + 1);
        while (toDS(cur) <= ev.endDate) { add(toDS(cur), { ...evWithMeta, _cont: true }); cur.setDate(cur.getDate() + 1); }
      }
    }
    for (const intr of interruptions) {
      if (intr.type === "term_break") continue;
      const start = intr.date;
      if (!start) continue;
      const _displayType = INTR_DISPLAY_TYPE[intr.type] || "interruption";
      add(start, { ...intr, _store: "intr", _displayType });
      if (intr.endDate && intr.endDate > start) {
        const cur = new Date(start + "T00:00:00");
        cur.setDate(cur.getDate() + 1);
        while (toDS(cur) <= intr.endDate) { add(toDS(cur), { ...intr, _store: "intr", _displayType, _cont: true }); cur.setDate(cur.getDate() + 1); }
      }
    }
    return map;
  }, [calEvents, interruptions]);

  // ---- Upcoming events (next 2 months, respects filter) ----
  const upcomingEvents = useMemo(() => {
    const d = new Date(today + "T00:00:00");
    d.setMonth(d.getMonth() + 2);
    const limit = toDS(d);
    const all = [];
    for (const ev of calEvents) {
      const ds = ev.startDate || ev.date;
      if (ds && ds >= today && ds <= limit)
        all.push({ ds, title: ev.title, type: ev.type || "personal", startTime: ev.startTime, endTime: ev.endTime, endDate: ev.endDate || ds });
    }
    for (const intr of interruptions) {
      if (intr.type === "term_break") continue;
      if (intr.date && intr.date >= today && intr.date <= limit) {
        const tp = INTR_DISPLAY_TYPE[intr.type] || "interruption";
        all.push({ ds: intr.date, title: intr.title, type: tp, startTime: intr.startTime, endTime: intr.endTime, endDate: intr.endDate || intr.date });
      }
    }
    const filtered = activeFilters.length > 0 ? all.filter(e => activeFilters.includes(e.type)) : all;
    return filtered.sort((a, b) => a.ds.localeCompare(b.ds));
  }, [calEvents, interruptions, today, activeFilters]);

  // ---- Hovered event range (for mini month border span) ----
  const _hoveredEvent = hoveredDs ? upcomingEvents.find(e => e.ds === hoveredDs) : null;
  const hoveredRange  = _hoveredEvent
    ? { start: _hoveredEvent.ds, end: _hoveredEvent.endDate || _hoveredEvent.ds, type: _hoveredEvent.type }
    : hoveredDs ? { start: hoveredDs, end: hoveredDs, type: null } : null;

  // ---- Display values ----
  const displayBase  = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const displayMonth = displayBase.getMonth();
  const displayYear  = displayBase.getFullYear();

  const monthGrid = useMemo(() => {
    const base  = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const dm    = base.getMonth();
    const start = getMondayOf(base);
    const weeks = [];
    const cur   = new Date(start);
    for (let w = 0; w < 6; w++) {
      const week = Array.from({ length: 7 }, () => { const d = new Date(cur); cur.setDate(cur.getDate() + 1); return d; });
      weeks.push(week);
      if (w >= 4 && week[6].getMonth() !== dm) break;
    }
    return weeks;
  }, [monthOffset, now.getFullYear(), now.getMonth()]);

  // ---- Filter pill helpers ----
  const toggleFilter = key => {
    if (key === null) { setActiveFilters([]); return; }
    setActiveFilters(prev => {
      if (prev.includes(key)) {
        const next = prev.filter(k => k !== key);
        return next; // may become [] which = All
      }
      return [...prev, key];
    });
  };

  // ---- Event form helpers ----
  const openNewEvent = (ds) => {
    const sorted = selectedDays.size > 0 ? [...selectedDays].sort() : [ds];
    const startDate = sorted[0];
    const endDate   = sorted[sorted.length - 1];
    // Centre modal over the calendar element
    const rect = calendarRef.current?.getBoundingClientRect();
    if (rect) setModalCenter({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    else      setModalCenter({ x:"50%", y:"50%" });
    setModalOffset({ x:0, y:0 });
    setEventForm({
      id: null, type: "personal", title: "",
      startDate,
      endDate: selectionIsRange ? endDate : startDate,
      _selectedDates: !selectionIsRange && sorted.length > 1 ? sorted : null,
      startTime: "", endTime: "", schoolId: "",
      interruptionSubtype: "other", affectsClasses: "all", details: "", _store: null,
    });
  };
  const openEditEvent = ev => setEventForm({
    id: ev.id,
    type: ev._store === "cal" ? (ev.type || "personal") : (INTR_DISPLAY_TYPE[ev.type] || "interruption"),
    title:       ev.title       || "",
    startDate:   ev.startDate   || ev.date || "",
    endDate:     ev.endDate     || ev.startDate || ev.date || "",
    startTime:   ev.startTime   || "",
    endTime:     ev.endTime     || "",
    schoolId:    ev.schoolId    || "",
    interruptionSubtype: INTERRUPTION_SUBTYPES.find(s => s.value === ev.type) ? ev.type : "other",
    affectsClasses: ev.affectsClasses || "all",
    details:     ev.details || ev.notes || "",
    _store:      ev._store,
    _readOnly:   ev._store === "intr" && !!ev.source && ev.source !== "calendar",
  });

  const saveEvent = () => {
    const f = eventForm;
    if (!f.title.trim()) { notify("Please enter a title", "warning"); return; }
    if (!f.startDate)    { notify("Please select a date",  "warning"); return; }
    // Personal stays localStorage-only; everything else (interruption,
    // performance, public_holiday, staff_event) syncs to interruptions.
    const toIntr = f.type !== "personal";
    // Interruption stores its subtype in `type`; the synced top-level
    // types store their display key directly. Subtype/affectsClasses are
    // interruption-only — synced top-level types default to whole-school.
    const mkIntr = (id, d, ed) => ({
      id,
      type: f.type === "interruption" ? (f.interruptionSubtype || "other") : f.type,
      title: f.title, date: d, endDate: ed,
      startTime: f.startTime, endTime: f.endTime,
      schoolId: f.schoolId || "all",
      affectsClasses: f.type === "interruption" ? (f.affectsClasses || "all") : "all",
      notes: f.details, source: "calendar",
    });

    // Multi-date individual selection — create one event per date
    if (!f.id && f._selectedDates) {
      if (toIntr) {
        setInterruptions(prev => [...prev, ...f._selectedDates.map(d => mkIntr(uid(), d, d))]);
      } else {
        saveCalEvents([...calEvents, ...f._selectedDates.map(d => ({
          id: uid(), type: f.type, title: f.title,
          startDate: d, endDate: d, startTime: f.startTime, endTime: f.endTime,
          details: f.details,
        }))]);
      }
      notify(`${f._selectedDates.length} events added`);
      setEventForm(null);
      setSelectedDays(new Set());
      return;
    }

    if (f.id) {
      if (f._store === "cal") saveCalEvents(calEvents.map(e => e.id !== f.id ? e : { ...e, type: f.type, title: f.title, startDate: f.startDate, endDate: f.endDate || f.startDate, startTime: f.startTime, endTime: f.endTime, details: f.details }));
      else setInterruptions(prev => prev.map(e => e.id !== f.id ? e : { ...e, ...mkIntr(f.id, f.startDate, f.endDate || f.startDate) }));
      notify("Event updated");
    } else {
      const id = uid();
      if (toIntr) setInterruptions(prev => [...prev, mkIntr(id, f.startDate, f.endDate || f.startDate)]);
      else saveCalEvents([...calEvents, { id, type: f.type, title: f.title, startDate: f.startDate, endDate: f.endDate || f.startDate, startTime: f.startTime, endTime: f.endTime, details: f.details }]);
      notify("Event added");
    }
    setEventForm(null);
    setSelectedDays(new Set());
  };

  const deleteEvent = () => {
    if (!eventForm?.id) return;
    if (eventForm._store === "cal") saveCalEvents(calEvents.filter(e => e.id !== eventForm.id));
    else setInterruptions(prev => prev.filter(e => e.id !== eventForm.id));
    notify("Event deleted");
    setEventForm(null);
  };

  // ---- Colour constants ----
  const SLATE_BLUE  = colors.sidebarHover;
  const NAVY        = colors.sidebarActive;  // #344565
  const CORAL       = colors.accent;         // #C47A6A
  const CORAL_LITE  = colors.accentLight;
  const WEEKEND_BG  = darkMode ? "#252232" : "#E8EDF5";

  // ---- Span position ----
  const getSpanPos = (ev, ds) => {
    const start = ev.startDate || ev.date;
    const end   = ev.endDate || start;
    if (!end || end <= start) return "single";
    if (!ev._cont && ds === start) return "start";
    if (ev._cont  && ds === end)   return "end";
    if (ev._cont)                  return "mid";
    return "single";
  };

  // ---- Event chip ----
  const renderChip = (ev, idx, ds) => {
    const meta    = ev._teacherEventMeta || EVENT_TYPE_META[ev._displayType || ev.type] || EVENT_TYPE_META.personal;
    const isTeacherEvent = ev.type === "teacher_event";
    const teacherColor = isTeacherEvent ? (ev.teacher_color || "#7C3AED") : null;
    const isSchoolIntr = (ev._displayType === "interruption" || ev._displayType === "school_event" || ev.type === "interruption" || ev.type === "school_event") && ev.schoolId && ev.schoolId !== "all";
    const schoolColor = isSchoolIntr ? schools.find(s => s.id === ev.schoolId)?.color : null;
    const chipBorder = teacherColor || schoolColor || SLATE_BLUE;
    const chipBg     = teacherColor ? (darkMode ? `${teacherColor}22` : `${teacherColor}18`) : schoolColor ? (darkMode ? `${schoolColor}22` : `${schoolColor}18`) : (darkMode ? "rgba(52,69,101,0.25)" : "rgba(52,69,101,0.08)");
    const chipText   = teacherColor || schoolColor || (darkMode ? "rgba(255,255,255,0.85)" : colors.sidebarActive);
    const spanPos = getSpanPos(ev, ds);
    const isBar   = spanPos === "mid" || spanPos === "end";
    const brLeft  = (spanPos === "start" || spanPos === "single") ? 3 : 0;
    const brRight = (spanPos === "end"   || spanPos === "single") ? 3 : 0;
    const mLeft   = isBar                                          ? -7 : 0;
    const mRight  = spanPos === "start" || spanPos === "mid"       ? -7 : 0;

    return (
      <div key={`${ev.id}-${idx}`}
        onClick={e => { e.stopPropagation(); openEditEvent(ev); }}
        onMouseEnter={e => {
          if (!isBar) {
            e.currentTarget.style.whiteSpace = "normal";
            const fade = e.currentTarget.querySelector(".chip-fade");
            if (fade) fade.style.display = "none";
          }
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverPopover({ ev, rect, meta });
        }}
        onMouseLeave={e => {
          if (!isBar) {
            e.currentTarget.style.whiteSpace = "nowrap";
            const fade = e.currentTarget.querySelector(".chip-fade");
            if (fade) fade.style.display = "block";
          }
          setHoverPopover(null);
        }}
        style={{
          position:      "relative",
          fontSize:      11,
          fontWeight:    600,
          paddingLeft:   isBar ? 0 : 5,
          paddingRight:  5,
          paddingTop:    isBar ? 0 : 2,
          paddingBottom: isBar ? 0 : 2,
          height:        isBar ? 8 : "auto",
          borderRadius:  `${brLeft}px ${brRight}px ${brRight}px ${brLeft}px`,
          marginBottom:  2,
          marginLeft:    mLeft,
          marginRight:   mRight,
          background:    chipBg,
          color:         isBar ? "transparent" : chipText,
          borderLeft:    (spanPos === "start" || spanPos === "single") ? `3px solid ${chipBorder}` : "none",
          borderTop:     isBar ? `2px solid ${chipBorder}` : "none",
          borderBottom:  isBar ? `2px solid ${chipBorder}` : "none",
          whiteSpace:    "nowrap",
          overflow:      "hidden",
          cursor:        "pointer",
          lineHeight:    1.5,
          zIndex:        1,
        }}>
        {!isBar && (ev._cont ? "↳ " : "") + ev.title}
        {!isBar && (
          <span className="chip-fade" style={{ position:"absolute", top:0, right:0, bottom:0, width:22,
            background:`linear-gradient(to right, transparent, ${chipBg})`, pointerEvents:"none" }} />
        )}
      </div>
    );
  };

  // ---- Hover popover ----
  const renderHoverPopover = () => {
    if (!hoverPopover || eventForm) return null;
    const { ev, rect, meta } = hoverPopover;
    const isTeacherEv2 = ev.type === "teacher_event";
    const isSchoolIntr2 = (ev._displayType === "interruption" || ev._displayType === "school_event" || ev.type === "interruption" || ev.type === "school_event") && ev.schoolId && ev.schoolId !== "all";
    const popColor = isTeacherEv2 ? (ev.teacher_color || "#7C3AED") : isSchoolIntr2 ? (schools.find(s => s.id === ev.schoolId)?.color || SLATE_BLUE) : SLATE_BLUE;
    const start   = ev.startDate || ev.date;
    const end     = ev.endDate;
    const isMulti = end && end !== start;
    const timeStr = ev.startTime ? `${ev.startTime}${ev.endTime ? ` – ${ev.endTime}` : ""}` : null;
    const notes   = ev.details || ev.notes;
    const spaceBelow = window.innerHeight - rect.bottom;
    const topPos  = spaceBelow > 160 ? rect.bottom + 6 : rect.top - 6;
    const anchor  = spaceBelow > 160 ? "top" : "bottom";
    return (
      <div style={{ position:"fixed", left: Math.min(rect.left, window.innerWidth - 235),
        [anchor]: anchor === "top" ? topPos : window.innerHeight - topPos,
        zIndex:2000, background:colors.cardBg, borderRadius:10,
        boxShadow:"0 4px 20px rgba(0,0,0,0.15)", border:`1.5px solid ${popColor}`,
        padding:"10px 13px", width:222, pointerEvents:"none", fontFamily:"inherit" }}>
        <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:5 }}>
          <span style={{ width:8, height:8, borderRadius:"50%", background:popColor, flexShrink:0 }} />
          <span style={{ fontSize:10, fontWeight:700, color:popColor, textTransform:"uppercase", letterSpacing:0.4 }}>{meta.label}</span>
        </div>
        <div style={{ fontSize:13, fontWeight:700, color:colors.text, marginBottom:4, lineHeight:1.3 }}>{ev.title}</div>
        <div style={{ fontSize:11, color:colors.textLight }}>{isMulti ? `${fmtDate(start)} – ${fmtDate(end)}` : fmtDate(start)}</div>
        {timeStr && <div style={{ fontSize:11, color:colors.textLight }}>{timeStr}</div>}
        {notes && <div style={{ fontSize:11, color:colors.textMuted, marginTop:5, fontStyle:"italic" }}>{notes.slice(0, 90)}{notes.length > 90 ? "…" : ""}</div>}
      </div>
    );
  };

  // ---- Holiday badge ----
  const HolidayBadge = ({ tb }) => (
    <div title={tb.title || "School Holidays"}
      style={{ position:"absolute", top:4, right:5, lineHeight:1, cursor:"default", userSelect:"none", opacity:0.45, transition:"opacity 0.15s", display:"inline-flex", alignItems:"center" }}
      onMouseEnter={e => e.currentTarget.style.opacity = "0.9"}
      onMouseLeave={e => e.currentTarget.style.opacity = "0.45"}>
      <PalmtreeIcon size={11} />
    </div>
  );

  // ---- Upcoming events panel ----
  const renderUpcomingBanner = () => (
    <div style={{ background:WEEKEND_BG, borderTop:`1px solid ${colors.border}`, padding:"6px 14px 10px" }}>
      {upcomingEvents.length === 0
        ? <div style={{ fontSize:12, color:colors.textMuted, padding:"4px 0", fontStyle:"italic" }}>No upcoming events in the next two months.</div>
        : upcomingEvents.map((ev, i) => {
            const meta    = EVENT_TYPE_META[ev.type] || EVENT_TYPE_META.personal;
            const isTeacherEv = ev.type === "teacher_event";
            const teacherEvColor = isTeacherEv ? (ev.teacher_color || "#7C3AED") : null;
            const isSchoolIntr = (ev._displayType === "interruption" || ev._displayType === "school_event" || ev.type === "interruption" || ev.type === "school_event") && ev.schoolId && ev.schoolId !== "all";
            const schoolColor = isSchoolIntr ? schools.find(s => s.id === ev.schoolId)?.color : null;
            const dotColor = teacherEvColor || schoolColor || SLATE_BLUE;
            const hoverBg  = teacherEvColor ? (darkMode ? `${teacherEvColor}22` : `${teacherEvColor}18`) : schoolColor ? (darkMode ? `${schoolColor}22` : `${schoolColor}18`) : (darkMode ? "rgba(52,69,101,0.25)" : "rgba(52,69,101,0.08)");
            const tmw     = addDays(today, 1);
            const lbl     = ev.ds === today ? "Today" : ev.ds === tmw ? "Tomorrow" : fmtDate(ev.ds);
            const timeStr = ev.startTime ? ` · ${ev.startTime}${ev.endTime ? `–${ev.endTime}` : ""}` : "";
            return (
              <div key={i}
                onMouseEnter={e => { e.currentTarget.style.background = hoverBg; setHoveredDs(ev.ds); }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; setHoveredDs(null); }}
                style={{ display:"flex", gap:10, padding:"5px 6px", margin:"0 -6px",
                  borderRadius:6,
                  borderBottom: i < upcomingEvents.length - 1 ? `1px solid ${colors.borderLight}` : "none",
                  alignItems:"center", cursor:"default", transition:"background 0.1s" }}>
                <span style={{ width:7, height:7, borderRadius:"50%", background:dotColor, flexShrink:0 }} />
                <span style={{ flex:1, fontSize:12, fontWeight:600, color:colors.text }}>{ev.title}{timeStr && <span style={{ fontWeight:400, color:colors.textMuted }}>{timeStr}</span>}</span>
                <span style={{ fontSize:11, color:colors.textMuted, flexShrink:0, whiteSpace:"nowrap" }}>{lbl}</span>
              </div>
            );
          })
      }
    </div>
  );

  // ---- Grid template ----
  const gridCols = showWeekNums ? "32px repeat(7, 1fr)" : "repeat(7, 1fr)";

  // ============================================================
  // MONTH VIEW
  // ============================================================
  const renderMonth = () => (
    <div ref={calendarRef} onClick={() => { setSelectedDays(new Set()); selectionAnchorRef.current = null; }}>

      {/* ── 3px navy border wrapper ── */}
      <div style={{ border:`3px solid ${colors.sidebarHover}`, borderRadius:14 }}>

        {/* ── Unified header, rounded top ── */}
        <div style={{ borderRadius:"11px 11px 0 0", overflow:"hidden" }}>

          {/* Navy control bar */}
          <div onClick={e => e.stopPropagation()} style={{ background:colors.sidebarHover, padding:"10px 14px", display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>

            {/* Stacked nav arrows */}
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:26, gap:1, flexShrink:0 }}>
              <button onClick={() => setMonthOffset(v => v - 1)} title="Previous month"
                style={{ width:18, height:12, padding:0, border:"none", borderRadius:3, background:"none",
                  color:"rgba(255,255,255,0.85)", cursor:"pointer",
                  fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 }}>
                <ChevronUp size={12} />
              </button>
              <button onClick={() => setMonthOffset(v => v + 1)} title="Next month"
                style={{ width:18, height:12, padding:0, border:"none", borderRadius:3, background:"none",
                  color:"rgba(255,255,255,0.85)", cursor:"pointer",
                  fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 }}>
                <ChevronDown size={12} />
              </button>
            </div>
            <span style={{ fontWeight:700, fontSize:15, color:CORAL, height:26, display:"inline-flex", alignItems:"center", whiteSpace:"nowrap", textTransform:"uppercase", letterSpacing:"0.06em" }}>
              {MONTH_NAMES[displayMonth]}
            </span>
            {monthOffset !== 0 && (
              <button onClick={() => setMonthOffset(0)}
                style={{ background:"rgba(255,255,255,0.12)", border:"1px solid rgba(255,255,255,0.25)", color:"rgba(255,255,255,0.8)", fontSize:12, fontWeight:600, borderRadius:20, padding:"0 11px", cursor:"pointer", fontFamily:"inherit", height:26, display:"inline-flex", alignItems:"center" }}>
                Today
              </button>
            )}

            {/* Divider */}
            <div style={{ width:1, height:18, background:"rgba(255,255,255,0.2)", margin:"0 4px", flexShrink:0 }} />

            {/* Filter pills — multi-select, always coloured */}
            <div style={{ display:"flex", gap:5, flexWrap:"wrap", alignItems:"center" }}>
              {/* All */}
              <button onClick={() => toggleFilter(null)}
                style={{ padding:"0 11px", borderRadius:20, fontSize:12, fontFamily:"inherit", cursor:"pointer", transition:"all 0.12s",
                  height:26, display:"inline-flex", alignItems:"center",
                  fontWeight: activeFilters.length === 0 ? 700 : 500,
                  border:`1.5px solid ${activeFilters.length === 0 ? SLATE_BLUE : "rgba(255,255,255,0.45)"}`,
                  background: activeFilters.length === 0 ? SLATE_BLUE : "rgba(255,255,255,0.14)",
                  color: activeFilters.length === 0 ? "#fff" : "rgba(255,255,255,0.85)" }}>
                All
              </button>
              {/* Type pills */}
              {Object.entries(EVENT_TYPE_META).map(([key, meta]) => {
                const isActive = activeFilters.includes(key);
                return (
                  <button key={key} onClick={() => toggleFilter(key)}
                    style={{ padding:"0 11px", borderRadius:20, fontSize:12, fontFamily:"inherit",
                      cursor:"pointer", transition:"all 0.12s",
                      height:26, display:"inline-flex", alignItems:"center",
                      fontWeight: isActive ? 700 : 500,
                      border:`1.5px solid ${isActive ? SLATE_BLUE : "rgba(255,255,255,0.45)"}`,
                      background: isActive ? SLATE_BLUE : "rgba(255,255,255,0.14)",
                      color: isActive ? "#fff" : "rgba(255,255,255,0.85)",
                      boxShadow: isActive ? "0 0 0 2px rgba(255,255,255,0.25)" : "none" }}>
                    {meta.label}
                  </button>
                );
              })}
            </div>

            {/* Right-side toggles */}
            <div style={{ marginLeft:"auto", display:"flex", gap:5, alignItems:"center" }}>
              {[
                { key: "upcomingExpanded", val: upcomingExpanded, set: setUpcomingExpanded, label: "Upcoming" },
                { key: "showMiniMonths",   val: showMiniMonths,   set: setShowMiniMonths,   label: "5-month"  },
              ].map(({ key, val, set, label }) => (
                <button key={key} onClick={() => set(v => !v)}
                  style={{ background: val ? "rgba(255,255,255,0.18)" : "none",
                    border:`1px solid ${val ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.22)"}`,
                    color:"rgba(255,255,255,0.8)", fontSize:10, fontWeight:600,
                    borderRadius:6, padding:"0 8px", cursor:"pointer", fontFamily:"inherit",
                    height:26, display:"inline-flex", alignItems:"center", transition:"color 0.15s" }}
                  onMouseEnter={e => e.currentTarget.style.color = CORAL}
                  onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.8)"}>
                  {label}
                </button>
              ))}
              <button onClick={() => window.print()}
                style={{ background:"none", border:"1px solid rgba(255,255,255,0.22)",
                  color:"rgba(255,255,255,0.8)", fontSize:10, fontWeight:600,
                  borderRadius:6, padding:"0 8px", cursor:"pointer", fontFamily:"inherit",
                  height:26, display:"inline-flex", alignItems:"center", gap:5, transition:"color 0.15s" }}
                onMouseEnter={e => e.currentTarget.style.color = CORAL}
                onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.8)"}>
                <Printer size={12} /> Print
              </button>
            </div>
          </div>

          {/* Upcoming events — shown when toggled, always expanded */}
          {upcomingExpanded && <div onClick={e => e.stopPropagation()}>{renderUpcomingBanner()}</div>}

          {/* ── 5-month strip ── */}
          {showMiniMonths && (
            <div onClick={e => e.stopPropagation()} style={{ background:colors.bg, padding:"12px 16px",
              borderTop:`1px solid ${colors.border}`,
              display:"flex", gap:16, alignItems:"flex-start" }}>
              {[-2, -1, 0, 1, 2].map(offset => {
                const d = new Date(displayYear, displayMonth + offset, 1);
                return (
                  <MiniMonth
                    key={offset}
                    year={d.getFullYear()}
                    month={d.getMonth()}
                    todayDs={today}
                    eventMap={eventMap}
                    termBreaks={termBreaks}
                    displayYear={displayYear}
                    displayMonth={displayMonth}
                    hoveredDs={hoveredDs}
                    hoveredRange={hoveredRange}
                    onClick={(y, m) => {
                      const base    = new Date(now.getFullYear(), now.getMonth(), 1);
                      const clicked = new Date(y, m, 1);
                      const diff    = (clicked.getFullYear() - base.getFullYear()) * 12 + (clicked.getMonth() - base.getMonth());
                      setMonthOffset(diff);
                    }}
                  />
                );
              })}
            </div>
          )}

          {/* Day-of-week header — slate blue, white text */}
          <div onClick={e => e.stopPropagation()} style={{ display:"grid", gridTemplateColumns:gridCols, background:SLATE_BLUE }}>
            {showWeekNums && <div />}
            {WEEK_DAYS.map((d, i) => (
              <div key={d} style={{ textAlign:"center", fontSize:11, fontWeight:700,
                color:"rgba(255,255,255,0.85)",
                padding:"7px 0", textTransform:"uppercase", letterSpacing:0.7,
                borderLeft: i === 0 && showWeekNums ? "1px solid rgba(255,255,255,0.12)" : "none",
                borderRight: i < 6 ? "1px solid rgba(255,255,255,0.12)" : "none" }}>
                {d}
              </div>
            ))}
          </div>
        </div>

        {/* ── Calendar grid ── */}
        <div style={{ position:"relative", background:colors.cardBg, borderRadius:"0 0 11px 11px", overflow:"hidden" }}>
          {monthGrid.map((week, wi) => {
            const mondayDs  = toDS(week[0]);
            const wkInfo    = showWeekNums ? getTermWeekInfo(mondayDs) : null;
            return (
              <div key={wi} style={{ display:"grid", gridTemplateColumns:gridCols,
                borderBottom: wi < monthGrid.length - 1 ? `1px solid ${colors.borderLight}` : "none" }}>

                {/* Week number / holiday cell */}
                {showWeekNums && (
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
                    padding:"4px 2px", background:SLATE_BLUE,
                    gap:1 }}>
                    {wkInfo?.type === "term" && (
                      <span style={{ fontSize:9, fontWeight:700, color:"rgba(255,255,255,0.85)", letterSpacing:0.2 }}>
                        {wkInfo.weekNum}
                      </span>
                    )}
                    {wkInfo?.type === "holiday" && (
                      <>
                        <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", color:"rgba(255,255,255,0.85)", lineHeight:1 }}><PalmtreeIcon size={11} /></span>
                        <span style={{ fontSize:8, fontWeight:700, color:"rgba(255,255,255,0.75)" }}>H{wkInfo.weekNum}</span>
                      </>
                    )}
                    {!wkInfo && (
                      <span style={{ fontSize:9, color:"rgba(255,255,255,0.25)" }}>–</span>
                    )}
                  </div>
                )}

                {week.map((date, di) => {
                  const ds          = toDS(date);
                  const isCurrMonth = date.getMonth() === displayMonth;
                  const isToday     = ds === today;
                  const tb          = getTermBreak(ds);
                  const isWeekend   = di >= 5;
                  const isTermStart = termStartInfo.set.has(ds);
                  const termNum     = termStartInfo.map[ds];
                  // Check if this day is within the range of the hovered upcoming event
                  const isHovered   = (() => {
                    if (!hoveredDs) return false;
                    // Find the event matching hoveredDs to get its full range
                    const match = upcomingEvents.find(e => e.ds === hoveredDs);
                    if (!match) return ds === hoveredDs;
                    const evStart = match.ds;
                    const evEnd   = match.endDate || match.ds;
                    return ds >= evStart && ds <= evEnd;
                  })();
                  const baseBg  = tb ? (darkMode ? "#2A2810" : "#FFFEF7") : isWeekend ? WEEKEND_BG : colors.cardBg;
                  const hoverBg = isToday ? colors.blueLight : tb ? (darkMode ? "#332F10" : "#FFF9E0") : isWeekend ? (darkMode ? "#2C2A3A" : "#D8E2F0") : CORAL_LITE;
                  const cellBg  = isHovered
                    ? (darkMode ? "rgba(52,69,101,0.25)" : "rgba(52,69,101,0.08)")
                    : baseBg;
                  const allDayEvs   = eventMap[ds] || [];
                  const dayEvs      = activeFilters.length > 0
                    ? allDayEvs.filter(ev => activeFilters.includes(ev._displayType || ev.type))
                    : allDayEvs;
                  return (
                    <div key={di}
                      onClick={e => {
                        e.stopPropagation();
                        const isSelected = selectedDays.has(ds);
                        if (e.metaKey || e.ctrlKey) {
                          // Cmd/Ctrl — add or remove from multi-selection
                          setSelectedDays(prev => {
                            const next = new Set(prev);
                            if (next.has(ds)) next.delete(ds); else next.add(ds);
                            return next;
                          });
                          selectionAnchorRef.current = ds;
                          setSelectionIsRange(false);
                        } else if (e.shiftKey && selectionAnchorRef.current) {
                          // Shift — range from anchor to here
                          setSelectedDays(new Set(getDatesInRange(selectionAnchorRef.current, ds)));
                          setSelectionIsRange(true);
                        } else {
                          // Plain click — select only this day, or deselect if already sole selection
                          if (isSelected && selectedDays.size === 1) {
                            setSelectedDays(new Set());
                            selectionAnchorRef.current = null;
                          } else {
                            setSelectedDays(new Set([ds]));
                            selectionAnchorRef.current = ds;
                          }
                          setSelectionIsRange(false);
                        }
                      }}
                      onContextMenu={e => { e.preventDefault(); openNewEvent(ds); }}
                      onMouseEnter={e => { if (!hoveredDs) e.currentTarget.style.background = hoverBg; }}
                      onMouseLeave={e => { if (!hoveredDs) e.currentTarget.style.background = baseBg; }}
                      style={{ position:"relative", height:100, padding:"6px 7px",
                        background: cellBg,
                        boxShadow: selectedDays.has(ds)
                          ? `inset 0 0 0 2px ${CORAL}`
                          : isHovered ? `inset 0 0 0 2px ${SLATE_BLUE}` : "none",
                        borderLeft: di === 0 && showWeekNums ? `1px solid ${colors.borderLight}` : "none",
                        borderRight: di < 6 ? `1px solid ${colors.borderLight}` : "none",
                        opacity: isCurrMonth ? 1 : 0.35, cursor:"default",
                        transition:"background 0.1s", overflow:"hidden" }}>

                      {/* Term start stripe */}
                      {isTermStart && isCurrMonth && (
                        <div style={{ position:"absolute", top:0, left:0, right:0, height:3, background:CORAL, opacity:0.55 }} />
                      )}

                      {/* Date number */}
                      <div style={{ width:24, height:24, borderRadius:"50%", marginBottom:2,
                        display:"flex", alignItems:"center", justifyContent:"center",
                        fontSize:12, fontWeight: isToday ? 700 : 500, flexShrink:0,
                        background: isToday ? NAVY : "transparent",
                        color: isToday ? "#fff" : isCurrMonth ? colors.text : colors.textMuted }}>
                        {date.getDate()}
                      </div>

                      {/* Term label */}
                      {isTermStart && isCurrMonth && (
                        <div style={{ fontSize:8, fontWeight:700, color:CORAL, letterSpacing:0.5,
                          textTransform:"uppercase", marginBottom:2, opacity:0.8 }}>
                          Term {termNum}
                        </div>
                      )}

                      {tb && isCurrMonth && <HolidayBadge tb={tb} />}
                      {dayEvs.slice(0, 3).map((ev, ei) => renderChip(ev, ei, ds))}
                      {allDayEvs.length > 3 && activeFilters.length === 0 && (
                        <div style={{ fontSize:10, color:colors.textMuted, fontWeight:600, lineHeight:1.3 }}>
                          +{allDayEvs.length - 3} more
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

      </div>{/* end navy border wrapper */}

      {/* Scroll hint */}
      <div style={{ textAlign:"right", fontSize:10, color:colors.textMuted, marginTop:6, paddingRight:4 }}>
        ↑ ↓ arrow keys to navigate · left-click to select days · shift-click for a range · right-click to add an event
      </div>
    </div>
  );

  // ============================================================
  // EVENT FORM MODAL
  // ============================================================
  const renderEventForm = () => {
    if (!eventForm) return null;
    const f         = eventForm;
    const isEdit    = !!f.id;
    const needsIntr   = f.type === "interruption";
    const needsSchool = f.type === "interruption" || f.type === "performance" || f.type === "public_holiday" || f.type === "staff_event";
    const tm        = EVENT_TYPE_META[f.type] || EVENT_TYPE_META.personal;
    const schoolClasses = f.schoolId && f.schoolId !== "all"
      ? [...new Set(specialists.filter(s => s.schoolId === f.schoolId).map(s => s.className))].sort()
      : [...new Set(specialists.map(s => s.className))].sort();
    const selectedClasses = f.affectsClasses === "all" ? [] : f.affectsClasses.split(",").map(c => c.trim()).filter(Boolean);
    const toggleClass = cls => {
      const cur  = f.affectsClasses === "all" ? [] : f.affectsClasses.split(",").map(c => c.trim()).filter(Boolean);
      const next = cur.includes(cls) ? cur.filter(c => c !== cls) : [...cur, cls];
      setEventForm(p => ({ ...p, affectsClasses: next.length ? next.join(", ") : "all" }));
    };
    const inp = { width:"100%", padding:"8px 10px", border:`1px solid ${colors.inputBorder}`, borderRadius:8, fontSize:13, fontFamily:"inherit", boxSizing:"border-box" };
    const lbl = { display:"block", fontSize:11, fontWeight:700, color:colors.textLight, textTransform:"uppercase", letterSpacing:0.5, marginBottom:4 };
    return (
      <>
        <div onClick={() => { setEventForm(null); setSelectedDays(new Set()); }} style={{ position:"fixed", inset:0, zIndex:1000, background:"rgba(0,0,0,0.25)" }} />
        <div style={{ position:"fixed",
          left: typeof modalCenter.x === "number" ? modalCenter.x : "50%",
          top:  typeof modalCenter.y === "number" ? Math.max(300, Math.min(modalCenter.y, window.innerHeight - 300)) : "50%",
          transform:`translate(calc(-50% + ${modalOffset.x}px), calc(-50% + ${modalOffset.y}px))`,
          zIndex:1001, background:colors.cardBg, borderRadius:14, boxShadow:"0 8px 40px rgba(0,0,0,0.18)",
          width:600, maxWidth:"94vw", maxHeight:"90vh", overflowY:"auto", padding:24, fontFamily:"inherit" }}>
          <div
            onMouseDown={e => {
              const start = { x: e.clientX, y: e.clientY, ox: modalOffset.x, oy: modalOffset.y };
              dragRef.current = start;
              const onMove = ev => {
                if (!dragRef.current) return;
                setModalOffset({ x: dragRef.current.ox + ev.clientX - dragRef.current.x, y: dragRef.current.oy + ev.clientY - dragRef.current.y });
              };
              const onUp = () => { dragRef.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
            style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18, cursor:"grab", userSelect:"none" }}>
            <div style={{ fontWeight:700, fontSize:16 }}>{isEdit ? "Edit Event" : "New Event"}</div>
            <button onClick={() => { setEventForm(null); setSelectedDays(new Set()); }} style={{ border:"none", background:"none", color:colors.textMuted, cursor:"pointer", lineHeight:1, display:"inline-flex", alignItems:"center" }}><X size={16} /></button>
          </div>
          {f._readOnly && <div style={{ padding:"8px 12px", background:"#FFF8E6", border:"1px solid #E8C878", borderRadius:8, fontSize:12, color:"#7A5520", marginBottom:14, display:"flex", alignItems:"center", gap:7 }}><AlertTriangle size={13} style={{ flexShrink:0 }} /> This event was imported from a newsletter scan. You can still edit it here.</div>}
          {/* Type */}
          <div style={{ marginBottom:14 }}>
            <label style={lbl}>Type</label>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {Object.entries(EVENT_TYPE_META).map(([key, meta]) => (
                <button key={key} onClick={() => setEventForm(p => ({ ...p, type: key }))}
                  style={{ padding:"5px 12px", borderRadius:7, fontSize:12, fontWeight: f.type === key ? 700 : 400,
                    fontFamily:"inherit", cursor:"pointer",
                    border:`1.5px solid ${f.type === key ? colors.sidebarHover : colors.border}`,
                    background: f.type === key ? colors.sidebarHover : colors.cardBg,
                    color: f.type === key ? "#fff" : colors.textMuted }}>
                  {meta.label}
                </button>
              ))}
            </div>
          </div>
          {/* Title */}
          <div style={{ marginBottom:12 }}>
            <label style={lbl}>Title</label>
            <input style={inp} value={f.title} onChange={e => setEventForm(p => ({ ...p, title: e.target.value }))} placeholder="e.g. Year 3 Excursion" autoFocus />
          </div>
          {/* Dates — read-only display */}
          <div style={{ marginBottom:12 }}>
            <label style={lbl}>Date{f._selectedDates || (f.endDate && f.endDate !== f.startDate) ? "s" : ""}</label>
            <div style={{ padding:"8px 12px", background:WEEKEND_BG, borderRadius:8, fontSize:13, color:colors.text, lineHeight:1.6 }}>
              {f._selectedDates
                ? f._selectedDates.map(d => fmtDate(d)).join("  ·  ")
                : f.endDate && f.endDate !== f.startDate
                  ? `${fmtDate(f.startDate)} – ${fmtDate(f.endDate)}`
                  : fmtDate(f.startDate)
              }
            </div>
          </div>
          {/* Times */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
            <div><label style={lbl}>Start Time <span style={{ textTransform:"none", fontWeight:400 }}>(optional)</span></label><input type="time" style={inp} value={f.startTime} onChange={e => setEventForm(p => ({ ...p, startTime: e.target.value }))} /></div>
            <div><label style={lbl}>End Time <span style={{ textTransform:"none", fontWeight:400 }}>(optional)</span></label><input type="time" style={inp} value={f.endTime} onChange={e => setEventForm(p => ({ ...p, endTime: e.target.value }))} /></div>
          </div>
          {/* School — interruption + performance + public_holiday + staff_event */}
          {needsSchool && (
            <div style={{ marginBottom:12 }}>
              <label style={lbl}>School</label>
              <select style={{ ...inp, appearance:"none" }} value={f.schoolId||""} onChange={e => setEventForm(p => ({ ...p, schoolId: e.target.value, affectsClasses:"all" }))}>
                <option value="">All Schools</option>
                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {/* Interruption-only fields */}
          {needsIntr && <>
            <div style={{ marginBottom:12 }}>
              <label style={lbl}>Subtype</label>
              <select style={{ ...inp, appearance:"none" }} value={f.interruptionSubtype} onChange={e => setEventForm(p => ({ ...p, interruptionSubtype: e.target.value }))}>
                {INTERRUPTION_SUBTYPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            {schoolClasses.length > 0 && f.schoolId && f.schoolId !== "all" && (
              <div style={{ marginBottom:12 }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
                  <label style={lbl}>Affects Classes</label>
                  <button onClick={() => setEventForm(p => ({ ...p, affectsClasses:"all" }))}
                    style={{ fontSize:11, fontWeight:600,
                      color: f.affectsClasses==="all" ? colors.sidebarActive : colors.textMuted,
                      background: f.affectsClasses==="all" ? colors.blueLight : "none",
                      border:`1px solid ${f.affectsClasses==="all" ? colors.sidebarActive : colors.border}`,
                      borderRadius:6, padding:"2px 8px", cursor:"pointer", fontFamily:"inherit" }}>
                    Whole school
                  </button>
                </div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                  {schoolClasses.map(cls => {
                    const sel = selectedClasses.includes(cls);
                    return (
                      <button key={cls} onClick={() => toggleClass(cls)}
                        style={{ padding:"3px 10px", borderRadius:6, fontSize:12,
                          fontWeight: sel ? 700 : 400, fontFamily:"inherit", cursor:"pointer",
                          border:`1.5px solid ${sel ? colors.sidebarHover : colors.border}`,
                          background: sel ? colors.sidebarHover : colors.cardBg,
                          color: sel ? "#fff" : colors.textMuted }}>
                        {cls}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>}
          {/* Notes */}
          <div style={{ marginBottom:18 }}>
            <label style={lbl}>Notes <span style={{ textTransform:"none", fontWeight:400 }}>(optional)</span></label>
            <textarea style={{ ...inp, resize:"vertical" }} rows={2} value={f.details}
              onChange={e => setEventForm(p => ({ ...p, details: e.target.value }))}
              placeholder="Any additional details…" />
          </div>
          {/* Buttons */}
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={saveEvent}
              style={{ flex:1, padding:"10px 0", borderRadius:8, background:colors.sidebarHover, color:"#fff", fontWeight:700, fontSize:13, border:"none", cursor:"pointer", fontFamily:"inherit" }}>
              {isEdit ? "Save Changes" : "Add Event"}
            </button>
            {isEdit && (
              <button onClick={deleteEvent}
                style={{ padding:"10px 14px", borderRadius:8, background:"#FEF2F2", color:colors.danger, fontWeight:700, fontSize:13, border:`1px solid ${colors.danger}`, cursor:"pointer", fontFamily:"inherit" }}>
                Delete
              </button>
            )}
            <button onClick={() => { setEventForm(null); setSelectedDays(new Set()); }}
              style={{ padding:"10px 14px", borderRadius:8, background:colors.bg, color:colors.textMuted, fontWeight:600, fontSize:13, border:"none", cursor:"pointer", fontFamily:"inherit" }}>
              Cancel
            </button>
          </div>
        </div>
      </>
    );
  };

  // ============================================================
  // MAIN RENDER
  // ============================================================
  return (
    <div>
      <PageTitle navButtons={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Btn onClick={fetchTermDatesAndHolidays} disabled={fetchingTermDates} style={{ fontSize: 12, height: 30, padding: "0 14px" }}>
            {fetchingTermDates ? "Fetching…" : "Fetch Term Dates"}
          </Btn>
          <NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />
        </div>
      }>
        Calendar
      </PageTitle>
      {renderMonth()}
      {renderEventForm()}
      {renderHoverPopover()}
    </div>
  );
}
