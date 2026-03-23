// ============================================================
// App.js — Root component: MusicTimetableApp
// Refactored from monolithic App.js into modular structure.
// This file contains only the root component and wires together
// all pages, state, data loading, and handlers.
// ============================================================

import React, { useState, useEffect, useRef, useCallback } from "react";

// ── Constants & config ──────────────────────────────────────
import { colors, DAYS, STORAGE_KEYS, APP_VERSION, DATA_VERSION, TIMEZONE, HEADER_HEIGHT } from "./constants";

// ── Utilities ───────────────────────────────────────────────
import { uid, melbourneNow, melbourneToday, toLocalDateStr, getCurrentWeekMonday, getTermWeekLabel, timeToMin, to12h, _getMondayOf } from "./utils/helpers";
import { computeTermWeekNum, computeAutoTallyDay, computeExtraTicks } from "./utils/tallyHelpers";
import { migrateData, loadData, saveData, saveStudents, loadSchools, loadStudents, loadSpecialists, triggerAutoBackup } from "./utils/backup";
import { anthropicFetch, anthropicStreamChat, getAnthropicHeaders, setAnthropicApiKey } from "./utils/api";
import { parseSpecialistNotes, parseStudentNotes } from "./utils/claudeNotes";

// ── Data generators ─────────────────────────────────────────
import { generateMasterTimetable, compactTimetable, scheduleReadyGroups } from "./data/timetableGenerator";
import { printMasterTimetable } from "./data/weeklyTimetableGenerator";
import { runSmokeTests } from "./data/smokeTests";

// ── Shared UI ────────────────────────────────────────────────

// ── Components ───────────────────────────────────────────────
import { ComposeModal } from "./components/ComposeModal";
import { ExportDialog } from "./components/ExportDialog";

// ── Pages ────────────────────────────────────────────────────
import { Dashboard } from "./pages/Dashboard";
import { SchoolsManager } from "./pages/SchoolsManager";
import { TeachersManager } from "./pages/TeachersManager";
import { GroupsManager } from "./pages/GroupsManager";
import { BandsManager } from "./pages/BandsManager";
import { PendingManager } from "./pages/PendingManager";
import { ResourcesManager } from "./pages/ResourcesManager";
import { SpecialistManager } from "./pages/SpecialistManager";
import { CalendarManager } from "./pages/CalendarManager";
import { StudentsManager } from "./pages/StudentsManager";
import { TimetableView } from "./pages/TimetableView";
import { WeeklyAdjustments } from "./pages/WeeklyAdjustments";
import { ContactsManager } from "./pages/ContactsManager";
import { SettingsManager } from "./pages/SettingsManager";
import { TallyView } from "./pages/TallyView";

export default function MusicTimetableApp() {
  const [page, _setPage] = useState("dashboard");
  const [focusStudentId, setFocusStudentId] = useState(null);
  const [newStudentPrefill, setNewStudentPrefill] = useState(null); // prefill data for new student form
  const [focusReturnPage, setFocusReturnPage] = useState(null);
  const [focusGroupId, setFocusGroupId] = useState(null);
  const [focusGroupReturnPage, setFocusGroupReturnPage] = useState(null);
  // masterBreaks: slot-specific breaks that survive regen { id, schoolId, day, time }
  const [masterBreaks, setMasterBreaks] = useState([]);
  const [pageHistory, setPageHistory] = useState(["dashboard"]);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [resetKey, setResetKey] = useState(0); // increments to signal tab reset
  const mainScrollRef = useRef(null);
  const hoveredScrollRef = useRef(null); // points to whichever scrollable list the cursor is over
  const emailNavRef = useRef({ navigate: null }); // set by Dashboard to expose email keyboard navigation
  const emailListRef = useRef(null); // ref to email scroll container, set by Dashboard
  const filteredEmailsRef = useRef([]); // mirrors filteredEmails, set by Dashboard
  const todoUndoRef = useRef(null); // set by Dashboard — calls undo on todo list
  const sidebarRef = useRef(null);
  const sidebarWheelAttached = useRef(false);
  const sidebarRefCb = React.useCallback((el) => {
    sidebarRef.current = el;
    if (el && !sidebarWheelAttached.current) {
      sidebarWheelAttached.current = true;
      el.addEventListener("wheel", (e) => {
        // Don't hijack scroll if the event originated inside a scrollable child
        // (e.g. the Claude chat panel messages div)
        let target = e.target;
        while (target && target !== el) {
          if (target.scrollHeight > target.clientHeight + 2) {
            // This element is scrollable — let it handle its own scroll
            return;
          }
          target = target.parentElement;
        }
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && mainScrollRef.current) {
          e.preventDefault();
          mainScrollRef.current.scrollTop += e.deltaY;
        }
      }, { passive: false });
    }
  }, []);

  // Save scroll position for the given page into its viewState
  const saveScrollForPage = (pg) => {
    const st = mainScrollRef.current?.scrollTop || 0;
    const map = { timetable: setTtViewState, weekly: setWeeklyViewState, students: setStudentsViewState, schools: setSchoolsViewState, teachers: setTeachersViewState, groups: setGroupsViewState, tally: setTallyViewState, specialists: setSpecialistsViewState, calendar: setInterruptionsViewState, dashboard: setDashboardViewState, contacts: setContactsViewState, resources: setResourcesViewState, settings: setSettingsViewState };
    if (map[pg]) map[pg](prev => ({ ...prev, scrollTop: st }));
  };

  // Restore scroll position for the given page from its viewState
  const getScrollForPage = (pg) => {
    const map = { timetable: ttViewState, weekly: weeklyViewState, students: studentsViewState, schools: schoolsViewState, teachers: teachersViewState, groups: groupsViewState, tally: tallyViewState, specialists: specialistsViewState, calendar: interruptionsViewState, dashboard: dashboardViewState, contacts: contactsViewState, resources: resourcesViewState, settings: settingsViewState };
    return (map[pg] || {}).scrollTop || 0;
  };

  const resetViewStateForPage = (pg) => {
    const resets = {
      timetable: () => setTtViewState({ selectedSchool: "", viewMode: "grid", filterTeacher: "", scrollTop: 0, gridScroll: {} }),
      weekly: () => setWeeklyViewState({ selectedSchool: "", weekOffset: 0, showMissedTally: false, scrollTop: 0, gridScroll: {} }),
      students: () => setStudentsViewState({ filter: { school: "", className: "", instrument: "", teacher: "", search: "", hasNote: false, hasWarning: "" }, sortCol: "name", sortDir: "asc", scrollTop: 0 }),
      schools: () => setSchoolsViewState({ scrollTop: 0 }),
      teachers: () => setTeachersViewState({ scrollTop: 0 }),
      groups: () => setGroupsViewState({ filterSchool: "", scrollTop: 0 }),
      tally: () => setTallyViewState({ selectedSchool: "all", groupBy: "day_school", scrollTop: 0 }),
      specialists: () => setSpecialistsViewState({ filterSchool: "", filterClass: "", filterDay: "", filterSubject: "", scrollTop: 0 }),
      calendar: () => setInterruptionsViewState({ filterSchool: "", filterType: "", scrollTop: 0 }),
      dashboard: () => setDashboardViewState({ scrollTop: 0 }),
      contacts: () => setContactsViewState({ scrollTop: 0 }),
      resources: () => setResourcesViewState({ scrollTop: 0 }),
      settings: () => setSettingsViewState({ scrollTop: 0 }),
    };
    if (resets[pg]) resets[pg]();
    if (mainScrollRef.current) mainScrollRef.current.scrollTop = 0;
  };

  const setPage = (newPage) => {
    if (newPage === page) {
      setResetKey(k => k + 1);
      resetViewStateForPage(newPage);
      return;
    }
    saveScrollForPage(page);
    const newHistory = [...pageHistory.slice(0, historyCursor + 1), newPage];
    setPageHistory(newHistory);
    setHistoryCursor(newHistory.length - 1);
    _setPage(newPage);
    requestAnimationFrame(() => { if (mainScrollRef.current) mainScrollRef.current.scrollTop = getScrollForPage(newPage); });
  };

  const goBack = () => {
    if (historyCursor <= 0) return;
    saveScrollForPage(page);
    const newCursor = historyCursor - 1;
    setHistoryCursor(newCursor);
    _setPage(pageHistory[newCursor]);
    requestAnimationFrame(() => { if (mainScrollRef.current) mainScrollRef.current.scrollTop = getScrollForPage(pageHistory[newCursor]); });
  };

  const goForward = () => {
    if (historyCursor >= pageHistory.length - 1) return;
    saveScrollForPage(page);
    const newCursor = historyCursor + 1;
    setHistoryCursor(newCursor);
    _setPage(pageHistory[newCursor]);
    requestAnimationFrame(() => { if (mainScrollRef.current) mainScrollRef.current.scrollTop = getScrollForPage(pageHistory[newCursor]); });
  };
  const [schools, setSchools] = useState([]);
  const [students, setStudents] = useState([]);
  const [teachers, setTeachersRaw] = useState([]);
  const teachersUndoStack = useRef([]);
  const teachersRedoStack = useRef([]);
  const ttPageActionSeq = useRef(0); // global sequence so we always undo most-recent action first
  const setTeachers = (valOrFn) => {
    setTeachersRaw(prev => {
      const newVal = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
      teachersUndoStack.current.push({ seq: ++ttPageActionSeq.current, data: JSON.parse(JSON.stringify(prev)) });
      if (teachersUndoStack.current.length > 50) teachersUndoStack.current.shift();
      teachersRedoStack.current = [];
      return newVal;
    });
  };
  const [specialists, setSpecialists] = useState([]);
  const [interruptions, setInterruptions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [bands, setBands] = useState([]);
  const [resources, setResources] = useState([]);
  const [timetable, setTimetableRaw] = useState(null);
  const timetableUndoStack = useRef([]);
  const timetableRedoStack = useRef([]);
  // Combined undo stack that also captures students state (for pending placement)
  const pendingPlaceUndoStack = useRef([]);
  const pendingPlaceRedoStack = useRef([]);
  const setTimetable = (valOrFn) => {
    setTimetableRaw(prev => {
      const newVal = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
      if (prev && prev !== newVal) {
        timetableUndoStack.current.push({ seq: ++ttPageActionSeq.current, data: JSON.parse(JSON.stringify(prev)) });
        if (timetableUndoStack.current.length > 50) timetableUndoStack.current.shift();
        timetableRedoStack.current = [];
      }
      return newVal;
    });
  };
  const undoTimetable = () => {
    if (timetableUndoStack.current.length === 0) return;
    setTimetableRaw(prev => {
      const item = timetableUndoStack.current.pop();
      timetableRedoStack.current.push({ seq: item.seq, data: JSON.parse(JSON.stringify(prev)) });
      return item.data;
    });
    notify("Timetable change undone");
  };
  const redoTimetable = () => {
    if (timetableRedoStack.current.length === 0) return;
    setTimetableRaw(prev => {
      const item = timetableRedoStack.current.pop();
      timetableUndoStack.current.push({ seq: item.seq, data: JSON.parse(JSON.stringify(prev)) });
      return item.data;
    });
    notify("Timetable change redone");
  };
  const undoTeachers = () => {
    if (teachersUndoStack.current.length === 0) return;
    setTeachersRaw(prev => {
      const item = teachersUndoStack.current.pop();
      teachersRedoStack.current.push({ seq: item.seq, data: JSON.parse(JSON.stringify(prev)) });
      return item.data;
    });
    notify("Break move undone");
  };
  const redoTeachers = () => {
    if (teachersRedoStack.current.length === 0) return;
    setTeachersRaw(prev => {
      const item = teachersRedoStack.current.pop();
      teachersUndoStack.current.push({ seq: item.seq, data: JSON.parse(JSON.stringify(prev)) });
      return item.data;
    });
    notify("Break move redone");
  };
  // Unified undo/redo for timetable page — picks the most recently pushed action across all stacks
  const undoTimetablePage = () => {
    const ttTop = timetableUndoStack.current[timetableUndoStack.current.length - 1];
    const teachTop = teachersUndoStack.current[teachersUndoStack.current.length - 1];
    const pendTop = pendingPlaceUndoStack.current[pendingPlaceUndoStack.current.length - 1];
    const tops = [ttTop, teachTop, pendTop].filter(Boolean);
    if (tops.length === 0) return;
    const latest = tops.reduce((a, b) => (b.seq > a.seq ? b : a));
    if (latest === pendTop) {
      const item = pendingPlaceUndoStack.current.pop();
      pendingPlaceRedoStack.current.push({ seq: item.seq, timetable: JSON.parse(JSON.stringify(timetable)), students: JSON.parse(JSON.stringify(students)) });
      setTimetableRaw(item.timetable);
      setStudents(item.students);
      notify("Pending placement undone");
    } else if (latest === teachTop) {
      undoTeachers();
    } else {
      undoTimetable();
    }
  };
  const redoTimetablePage = () => {
    const ttTop = timetableRedoStack.current[timetableRedoStack.current.length - 1];
    const teachTop = teachersRedoStack.current[teachersRedoStack.current.length - 1];
    const pendTop = pendingPlaceRedoStack.current[pendingPlaceRedoStack.current.length - 1];
    const tops = [ttTop, teachTop, pendTop].filter(Boolean);
    if (tops.length === 0) return;
    const latest = tops.reduce((a, b) => (b.seq > a.seq ? b : a));
    if (latest === pendTop) {
      const item = pendingPlaceRedoStack.current.pop();
      pendingPlaceUndoStack.current.push({ seq: item.seq, timetable: JSON.parse(JSON.stringify(timetable)), students: JSON.parse(JSON.stringify(students)) });
      setTimetableRaw(item.timetable);
      setStudents(item.students);
      notify("Pending placement redone");
    } else if (latest === teachTop) {
      redoTeachers();
    } else {
      redoTimetable();
    }
  };
  const ttPageUndoCount = () => timetableUndoStack.current.length + teachersUndoStack.current.length + pendingPlaceUndoStack.current.length;
  const ttPageRedoCount = () => timetableRedoStack.current.length + teachersRedoStack.current.length + pendingPlaceRedoStack.current.length;
  const [weeklyTimetables, setWeeklyTimetablesRaw] = useState({}); // { "2025-W10|schoolId": { lessons, missed, notes } }
  const weeklyUndoStack = useRef([]);
  const weeklyRedoStack = useRef([]);
  const setWeeklyTimetables = (valOrFn) => {
    setWeeklyTimetablesRaw(prev => {
      const newVal = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
      weeklyUndoStack.current.push(JSON.parse(JSON.stringify(prev)));
      if (weeklyUndoStack.current.length > 50) weeklyUndoStack.current.shift();
      weeklyRedoStack.current = [];
      // Prune oldest weeks — keep only the 52 most recent week dates (one full year)
      const allKeys = Object.keys(newVal);
      const uniqueWeekDates = [...new Set(allKeys.map(k => k.split("|")[0]))].sort();
      if (uniqueWeekDates.length > 52) {
        const toKeep = new Set(uniqueWeekDates.slice(-52));
        const pruned = {};
        for (const k of allKeys) { if (toKeep.has(k.split("|")[0])) pruned[k] = newVal[k]; }
        return pruned;
      }
      return newVal;
    });
  };
  const undoWeekly = () => {
    if (weeklyUndoStack.current.length === 0) return;
    setWeeklyTimetablesRaw(prev => {
      weeklyRedoStack.current.push(JSON.parse(JSON.stringify(prev)));
      return weeklyUndoStack.current.pop();
    });
    notify("Weekly change undone");
  };
  const redoWeekly = () => {
    if (weeklyRedoStack.current.length === 0) return;
    setWeeklyTimetablesRaw(prev => {
      weeklyUndoStack.current.push(JSON.parse(JSON.stringify(prev)));
      return weeklyRedoStack.current.pop();
    });
    notify("Weekly change redone");
  };
  const [tallyEntries, setTallyEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  // storageReady is set to true only after initial load confirms data came from storage.
  // Save effects are gated on this ref so an empty load fallback can never overwrite real saved data.
  const storageReady = useRef(false);
  const autoProcessedDaysRef = useRef(new Set());
  // Refs for latest state values — used by auto-tally timer to avoid stale closures
  const weeklyTimetablesRef = useRef({});
  const timetableRef = useRef(null);
  const studentsRef = useRef([]);
  const interruptionsRef = useRef([]);
  const tallyEntriesRef = useRef([]);
  const schoolsRef = useRef([]);
  const [notification, setNotification] = useState(null);
  // Defined immediately after setNotification to prevent temporal dead zone in HMR
  const notify = (msg, type = "success", duration = 3500) => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), duration);
  };
  const [composeEmail, setComposeEmail] = useState(null); // null | { to[], from, subject, body }
  const [composeQueue, setComposeQueue] = useState([]); // queued sequential emails
  const [autoSendQueue, setAutoSendQueue] = useState([]); // { to, from, subject, bodyHtml, label }[]
  const autoSendTimerRef = React.useRef(null);
  const autoSendActiveRef = React.useRef(false);

  // ── Sidebar Claude panel ─────────────────────────────────────
  const [claudePanelOpen, setClaudePanelOpen] = useState(false);
  const [claudeInput, setClaudeInput] = useState("");
  const [claudeMessages, setClaudeMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.claudeMessages) || "[]"); } catch(e) { return []; }
  });
  const [claudeLoading, setClaudeLoading] = useState(false);
  const [claudeAttachment, setClaudeAttachment] = useState(null);
  const [claudeDragOver, setClaudeDragOver] = useState(false);
  const [claudeMemory, setClaudeMemory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.claudeMemory) || "[]"); } catch(e) { return []; }
  });
  const [claudeRememberOpen, setClaudeRememberOpen] = useState(false);
  const [claudeRememberInput, setClaudeRememberInput] = useState("");
  const [claudeNewsletterOpen, setClaudeNewsletterOpen] = useState(false);
  const [scanPreview, setScanPreview] = useState(null); // lifted from InterruptionsManager for sidebar scan
  const claudeInputRef = useRef(null);
  const claudeFileInputRef = useRef(null);
  const claudeMessagesEndRef = useRef(null);

  // Auto-scroll chat to bottom when messages change
  useEffect(() => {
    claudeMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [claudeMessages, claudeLoading]);

  // Persist last 20 messages across sessions
  useEffect(() => {
    try {
      const toSave = claudeMessages.slice(-20).map(m => ({
        role: m.role,
        // Store only text for persisted messages — strip base64 attachments to keep storage lean
        content: typeof m.content === "string" ? m.content : (m.displayText || ""),
        displayText: m.displayText,
      }));
      localStorage.setItem(STORAGE_KEYS.claudeMessages, JSON.stringify(toSave));
    } catch(e) {}
  }, [claudeMessages]);

  // Close newsletter popover on outside click
  useEffect(() => {
    if (!claudeNewsletterOpen) return;
    const handler = () => setClaudeNewsletterOpen(false);
    setTimeout(() => window.addEventListener("click", handler), 0);
    return () => window.removeEventListener("click", handler);
  }, [claudeNewsletterOpen]);
  const claudeDragCounter = useRef(0);
  useEffect(() => {
    const onEnter = (e) => {
      if (e.dataTransfer?.types?.includes("Files") || window._pendingAttachmentDrag) {
        claudeDragCounter.current += 1;
        setClaudeDragOver(true);
      }
    };
    const onLeave = () => {
      claudeDragCounter.current = Math.max(0, claudeDragCounter.current - 1);
      if (claudeDragCounter.current === 0) setClaudeDragOver(false);
    };
    const onReset = () => { claudeDragCounter.current = 0; setClaudeDragOver(false); };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onReset);
    window.addEventListener("dragend", onReset);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onReset);
      window.removeEventListener("dragend", onReset);
    };
  }, []);

  // ── Token usage tracker ──────────────────────────────────────
  // Stored as { "YYYY-MM": { inputTokens, outputTokens } }
  // Pricing (per million tokens): Haiku $0.80 in / $4 out, Sonnet $3 in / $15 out
  const MODEL_COSTS = {
    "claude-haiku-4-5-20251001": { in: 0.80, out: 4.00 },
    "claude-sonnet-4-20250514":  { in: 3.00, out: 15.00 },
  };
  const [tokenUsage, setTokenUsage] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.tokenUsage) || "{}"); } catch(e) { return {}; }
  });
  const [sessionTokens, setSessionTokens] = useState({ inputTokens: 0, outputTokens: 0, costUSD: 0 });
  const [claudeBudget, setClaudeBudget] = useState(() => {
    try { return parseFloat(localStorage.getItem(STORAGE_KEYS.claudeBudget) || "10"); } catch(e) { return 10; }
  });
  const [claudePersonalContext, setClaudePersonalContext] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEYS.claudePersonalContext) || ""; } catch(e) { return ""; }
  });
  const [apiStatus, setApiStatus] = useState("unknown"); // "ok" | "missing" | "error" | "unknown"

  const recordUsage = React.useCallback((model, inputTokens, outputTokens) => {
    const monthKey = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const costs = MODEL_COSTS[model] || MODEL_COSTS["claude-sonnet-4-20250514"];
    const cost = (inputTokens / 1e6) * costs.in + (outputTokens / 1e6) * costs.out;
    setSessionTokens(prev => ({
      inputTokens: prev.inputTokens + inputTokens,
      outputTokens: prev.outputTokens + outputTokens,
      costUSD: prev.costUSD + cost,
    }));
    setTokenUsage(prev => {
      const month = prev[monthKey] || { inputTokens: 0, outputTokens: 0, costUSD: 0 };
      const updated = {
        ...prev,
        [monthKey]: {
          inputTokens: month.inputTokens + inputTokens,
          outputTokens: month.outputTokens + outputTokens,
          costUSD: month.costUSD + cost,
        }
      };
      try { localStorage.setItem(STORAGE_KEYS.tokenUsage, JSON.stringify(updated)); } catch(e) {}
      return updated;
    });
  }, []);

  // Wire module-level openCompose() and openComposeQueue() to state setters
  useEffect(() => {
    window._openComposeModal = (opts) => setComposeEmail(opts);
    window._openComposeQueue = (items) => {
      if (items.length === 0) return;
      const keyed = items.map((item, i) => ({ ...item, _queueKey: `${item.to?.[0]}-${i}-${Date.now()}` }));
      const [first, ...rest] = keyed;
      setComposeEmail(first);
      setComposeQueue(rest);
    };
    window._autoSendBatch = (items) => {
      if (!items || items.length === 0) return;
      setAutoSendQueue(prev => [...prev, ...items]);
    };
    // Bridge for Dashboard to send attachment to Claude panel
    window._claudeAcceptAttachment = (attData) => {
      setClaudeAttachment(attData);
      setClaudePanelOpen(true);
    };
  }, [setComposeEmail, setComposeQueue]);

  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem("mt-api-key") || ""; } catch(e) { return ""; }
  });

  // Inject @keyframes spin for loading spinners (once on mount)
  useEffect(() => {
    if (!document.getElementById("mt-global-styles")) {
      const el = document.createElement("style");
      el.id = "mt-global-styles";
      el.textContent = "@keyframes spin { to { transform: rotate(360deg); } } @keyframes mmm-flash { from { opacity: 1; } to { opacity: 0.15; } } .mt-email-body a { color: #7C6FAD; } .mt-email-body blockquote { border-left: 3px solid #e5e7eb; margin: 8px 0; padding-left: 12px; color: #6b7280; } .mt-email-body table { max-width: 100%; } .mt-email-body img { display: none !important; } .mt-email-body * { max-width: 100%; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important; }";
      document.head.appendChild(el);
    }
  }, []);

  // Sync apiKey to module-level variable for use in fetch calls
  useEffect(() => {
    setAnthropicApiKey(apiKey);
    setApiStatus(apiKey.trim() ? "unknown" : "missing");
  }, [apiKey]);

  // Persistent view state (survives tab switches)
  const [ttViewState, setTtViewState] = useState({ selectedSchool: "", viewMode: "grid", filterTeacher: "", scrollTop: 0 });
  const [weeklyViewState, setWeeklyViewState] = useState({ selectedSchool: "", weekOffset: 0, showMissedTally: false, scrollTop: 0 });
  const [sharedSchool, setSharedSchool] = useState("");
  const [sharedTimetableScroll, setSharedTimetableScroll] = useState({ gridScroll: {} });
  const [studentsViewState, setStudentsViewState] = useState({ filter: { school: "", className: "", instrument: "", teacher: "", search: "", hasNote: false, hasWarning: "" }, sortCol: "name", sortDir: "asc", scrollTop: 0 });
  const [schoolsViewState, setSchoolsViewState] = useState({ scrollTop: 0 });
  const [teachersViewState, setTeachersViewState] = useState({ scrollTop: 0 });
  const [groupsViewState, setGroupsViewState] = useState({ filterSchool: "", scrollTop: 0 });
  const [tallyViewState, setTallyViewState] = useState({ selectedSchool: "all", groupBy: "day_school", scrollTop: 0 });
  const [specialistsViewState, setSpecialistsViewState] = useState({ filterSchool: "", filterClass: "", filterDay: "", filterSubject: "", scrollTop: 0 });
  const [interruptionsViewState, setInterruptionsViewState] = useState({ filterSchool: "", filterType: "", scrollTop: 0 });
  const [dashboardViewState, setDashboardViewState] = useState({ scrollTop: 0 });
  const [contactsViewState, setContactsViewState] = useState({ scrollTop: 0 });
  const [resourcesViewState, setResourcesViewState] = useState({ scrollTop: 0 });
  const [settingsViewState, setSettingsViewState] = useState({ scrollTop: 0 });
  const [contacts, setContacts] = useState([]);
  const [errorLog, setErrorLog] = useState([]); // [{ts, message, detail}] capped at 30
  const logError = React.useCallback((message, detail = "") => {
    setErrorLog(prev => [{ id: uid(), ts: new Date().toISOString(), message, detail }, ...prev].slice(0, 30));
  }, []);

  // Load data on mount — uses test data as fallback when storage is empty
  useEffect(() => {
    (async () => {
      const s = migrateData("schools", await loadSchools());
      const st = migrateData("students", await loadStudents());
      const t = migrateData("teachers", await loadData(STORAGE_KEYS.teachers, []));
      const sp = await loadSpecialists();
      const ir = await loadData(STORAGE_KEYS.interruptions, []);
      const gr = migrateData("groups", await loadData(STORAGE_KEYS.groups, []));
      const bn = await loadData(STORAGE_KEYS.bands, []);
      const rc = await loadData(STORAGE_KEYS.resources, []);
      const tt = await loadData(STORAGE_KEYS.timetable, null);
      const wt = await loadData(STORAGE_KEYS.weeklyTimetables, {});
      const tally = migrateData("tallyEntries", await loadData(STORAGE_KEYS.tallyEntries, []));
      const mb = await loadData(STORAGE_KEYS.masterBreaks, []);
      const ct = await loadData(STORAGE_KEYS.contacts, []);
      // Only seed ALL collections if this is a truly fresh install (no schools saved yet).
      // If schools exist, the user has real data — missing collections default to empty
      // rather than seed data, so a storage hiccup can't overwrite real data with demo data.
      setSchools(s);
      setStudents(st);
      setTeachersRaw(t);
      setSpecialists(sp);
      setInterruptions(ir);
      setGroups(gr.length > 0 ? gr : []);
      setBands(bn || []);
      setResources(rc || []);
      setTimetableRaw(tt);
      setWeeklyTimetablesRaw(wt);
      setTallyEntries(tally);
      setMasterBreaks(mb || []);
      setContacts(ct || []);
      setLoading(false);
      // Run smoke tests once after load (validates pure functions + migration)
      runSmokeTests(logError);
      // Clear undo stacks after load — nothing before this point should be undoable
      timetableUndoStack.current = [];
      timetableRedoStack.current = [];
      teachersUndoStack.current = [];
      teachersRedoStack.current = [];
      weeklyUndoStack.current = [];
      weeklyRedoStack.current = [];
      ttPageActionSeq.current = 0;
      // Delay storageReady so auto-save effects don't fire during initial state hydration.
      // Load all persisted data on startup
      setTimeout(() => { storageReady.current = true; }, 500);
    })();
  }, []);

  // Auto-save — NEVER save an empty array for any real data collection.
  // This ensures a failed/empty storage read can never silently destroy saved data.
  useEffect(() => { if (storageReady.current && schools.length > 0) { saveData(STORAGE_KEYS.schools, schools); saveData(STORAGE_KEYS.schoolsBak, schools); } }, [schools]);
  useEffect(() => { if (storageReady.current && students.length > 0) saveStudents(students); }, [students]);
  useEffect(() => { if (storageReady.current && teachers.length > 0) saveData(STORAGE_KEYS.teachers, teachers); }, [teachers]);
  useEffect(() => { if (storageReady.current && specialists.length > 0) { saveData(STORAGE_KEYS.specialists, specialists); saveData(STORAGE_KEYS.specialistsBak, specialists); } }, [specialists]);
  useEffect(() => { if (storageReady.current && interruptions.length > 0) saveData(STORAGE_KEYS.interruptions, interruptions); }, [interruptions]);
  useEffect(() => { if (storageReady.current) saveData(STORAGE_KEYS.groups, groups); }, [groups]);
  useEffect(() => { if (storageReady.current) saveData(STORAGE_KEYS.bands, bands); }, [bands]);
  useEffect(() => { if (storageReady.current) saveData(STORAGE_KEYS.resources, resources); }, [resources]);
  useEffect(() => { if (storageReady.current) saveData(STORAGE_KEYS.timetable, timetable); }, [timetable]);
  useEffect(() => { if (storageReady.current) saveData(STORAGE_KEYS.weeklyTimetables, weeklyTimetables); }, [weeklyTimetables]);

  // Auto-promote trial students to pending after 6pm on their trial lesson day
  useEffect(() => {
    const trialStudents = students.filter(s => s.status === "trial");
    if (trialStudents.length === 0) return;
    const now = melbourneNow();
    const nowStr = toLocalDateStr(now);
    const hour = now.getHours();
    const promotedIds = new Set();
    for (const s of trialStudents) {
      // Find any trial lesson for this student across all weekly timetables
      for (const [storageKey, data] of Object.entries(weeklyTimetables)) {
        const lessons = data.lessons || [];
        const trialLesson = lessons.find(l => l.studentId === s.id && l.isTrial);
        if (!trialLesson) continue;
        // Find the date of this lesson day within its week
        const wk = storageKey.split("|")[0]; // monday of that week
        const dayIndex = ["Monday","Tuesday","Wednesday","Thursday","Friday"].indexOf(trialLesson.day);
        if (dayIndex < 0) continue;
        const lessonDate = new Date(wk + "T00:00:00");
        lessonDate.setDate(lessonDate.getDate() + dayIndex);
        const lessonDateStr = toLocalDateStr(lessonDate);
        // Promote if lesson date is past, or is today after 6pm
        if (lessonDateStr < nowStr || (lessonDateStr === nowStr && hour >= 18)) {
          promotedIds.add(s.id);
          break;
        }
      }
    }
    if (promotedIds.size > 0) {
      setStudents(prev => prev.map(s => promotedIds.has(s.id) ? { ...s, status: "pending" } : s));
    }
  }, [weeklyTimetables]);
  useEffect(() => { if (storageReady.current) saveData(STORAGE_KEYS.tallyEntries, tallyEntries); }, [tallyEntries]);
  useEffect(() => { if (storageReady.current) saveData(STORAGE_KEYS.masterBreaks, masterBreaks); }, [masterBreaks]);

  // Keep refs in sync with latest state (for use in timer/backfill without stale closures)
  useEffect(() => { weeklyTimetablesRef.current = weeklyTimetables; }, [weeklyTimetables]);
  useEffect(() => { timetableRef.current = timetable; }, [timetable]);
  useEffect(() => { studentsRef.current = students; }, [students]);
  useEffect(() => { interruptionsRef.current = interruptions; }, [interruptions]);
  useEffect(() => { tallyEntriesRef.current = tallyEntries; }, [tallyEntries]);
  useEffect(() => { schoolsRef.current = schools; }, [schools]);

  // ── Auto-tally: process a single past school day ────────────────────────
  const doAutoTallyRef = useRef(null);
  const doAutoTallyForDate = (dateStr) => {
    if (autoProcessedDaysRef.current.has(dateStr)) return;
    const dateObj = new Date(dateStr + "T00:00:00");
    const dow = dateObj.getDay();
    // Mark weekends as processed and skip
    if (dow === 0 || dow === 6) { autoProcessedDaysRef.current.add(dateStr); return; }
    const prev = tallyEntriesRef.current;
    const newEntries = computeAutoTallyDay(dateStr, weeklyTimetablesRef.current, timetableRef.current, studentsRef.current, interruptionsRef.current, prev);
    const monday = _getMondayOf(dateObj);
    const weekKey = toLocalDateStr(monday);
    const extraTicks = computeExtraTicks(newEntries, prev, weekKey, timetableRef.current, studentsRef.current, interruptionsRef.current);
    const allNew = [...newEntries, ...extraTicks];
    autoProcessedDaysRef.current.add(dateStr);
    try { localStorage.setItem(STORAGE_KEYS.autoProcessedDays, JSON.stringify([...autoProcessedDaysRef.current])); } catch(e) {}
    if (allNew.length > 0) {
      setTallyEntries(p => [...p, ...allNew]);
    }

    // ── Catch-up card resolution at 6pm ──────────────────────────────────
    // For each isMakeup card on today's date, check whether it ended up in
    // the timetable (attended → madeUp: true) or the missed zone
    // (uninformed absence → makeupEligible: false, no further catch-up).
    // Deletion leaves the original missed entry untouched (catch-up still owed).
    const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dateObj.getDay()];
    const wt = weeklyTimetablesRef.current;
    const makeupUpdates = {}; // tallyEntryId → partial update

    for (const [sk, weeklyData] of Object.entries(wt)) {
      const parts = sk.split("|");
      if (parts[0] !== weekKey || !parts[1]) continue;

      // Attended catch-ups: isMakeup cards still on the timetable for today
      for (const lesson of (weeklyData.lessons || [])) {
        if (!lesson.isMakeup || lesson.day !== dayName) continue;
        if (!lesson.studentId) continue;
        const tallyEntries = tallyEntriesRef.current;
        // Use makeupForTallyId if present; fall back to oldest eligible entry
        const target = lesson.makeupForTallyId
          ? tallyEntries.find(e => e.id === lesson.makeupForTallyId && e.makeupEligible && !e.madeUp)
          : tallyEntries
              .filter(e => e.studentId === lesson.studentId && e.status === "missed" && e.makeupEligible && !e.madeUp)
              .sort((a, b) => (a.weekKey || "").localeCompare(b.weekKey || ""))[0];
        if (target && !makeupUpdates[target.id]) {
          makeupUpdates[target.id] = { madeUp: true, madeUpWeekKey: sk };
        }
      }

      // Missed catch-ups: isMakeup cards in the missed zone for today
      for (const lesson of (weeklyData.missed || [])) {
        if (!lesson.isMakeup || lesson.day !== dayName) continue;
        if (!lesson.studentId) continue;
        const tallyEntries = tallyEntriesRef.current;
        const target = lesson.makeupForTallyId
          ? tallyEntries.find(e => e.id === lesson.makeupForTallyId && e.makeupEligible && !e.madeUp)
          : tallyEntries
              .filter(e => e.studentId === lesson.studentId && e.status === "missed" && e.makeupEligible && !e.madeUp)
              .sort((a, b) => (a.weekKey || "").localeCompare(b.weekKey || ""))[0];
        if (target && !makeupUpdates[target.id]) {
          makeupUpdates[target.id] = { makeupEligible: false }; // uninformed absence — no further catch-up
        }
      }
    }

    if (Object.keys(makeupUpdates).length > 0) {
      setTallyEntries(p => p.map(e => makeupUpdates[e.id] ? { ...e, ...makeupUpdates[e.id] } : e));
    }
  };
  doAutoTallyRef.current = doAutoTallyForDate;

  // ── Auto-tally: backfill last 2 weeks on startup ────────────────────────
  useEffect(() => {
    if (loading) return;
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.autoProcessedDays) || "[]");
    autoProcessedDaysRef.current = new Set(stored);
    const t = setTimeout(() => {
      const now = melbourneNow();
      const nowStr = toLocalDateStr(now);
      const hour = now.getHours();
      // If it's past 6pm, always clear today from the cache and re-attempt —
      // this self-heals if a previous run used a wrong timezone and skipped entries.
      // Duplicate entries are safely blocked by the existingKeys check in computeAutoTallyDay.
      if (hour >= 18) autoProcessedDaysRef.current.delete(nowStr);
      for (let i = 1; i <= 14; i++) {
        const d = new Date(now); d.setDate(d.getDate() - i);
        const dateStr = toLocalDateStr(d);
        if (!autoProcessedDaysRef.current.has(dateStr)) doAutoTallyRef.current?.(dateStr);
      }
      if (hour >= 18) doAutoTallyRef.current?.(nowStr);
    }, 1200); // wait 1.2s for state to fully hydrate
    return () => clearTimeout(t);
  }, [loading]);

  // ── Auto-tally: fire at 6pm Melbourne each day ──────────────────────────
  useEffect(() => {
    if (loading) return;
    const schedule = () => {
      const now = melbourneNow();
      const next6pm = new Date(now); next6pm.setHours(18, 0, 0, 0);
      if (next6pm <= now) next6pm.setDate(next6pm.getDate() + 1);
      const msUntil = next6pm.getTime() - now.getTime();
      return setTimeout(() => {
        const todayStr = toLocalDateStr(melbourneNow());
        doAutoTallyRef.current?.(todayStr);
        timerRef.current = schedule(); // reschedule for tomorrow
      }, msUntil);
    };
    const timerRef = { current: schedule() };
    return () => clearTimeout(timerRef.current);
  }, [loading]);
  useEffect(() => { if (storageReady.current) saveData(STORAGE_KEYS.contacts, contacts); }, [contacts]);

  // ── Newsletter scan ──────────────────────────────────────────
  // Uses refs for schools/interruptions so doScan never goes stale
  // and the effect only ever runs once (on loading → false).
  const forceNewsletterScan = React.useRef(null);
  useEffect(() => {
    if (loading) return;

    const doScan = async (schoolIds = null) => {
      const apiKey = localStorage.getItem("mt-api-key") || "";
      if (!apiKey) { notify("Add your Anthropic API key in Settings → App to use AI scanning", "warning", 6000); return; }

      // Read live values from refs — never stale
      const currentSchools = schoolsRef.current;
      const currentInterruptions = interruptionsRef.current;

      const schoolsWithUrls = currentSchools.filter(s => s.newsletterUrl && (!schoolIds || schoolIds.includes(s.id)));
      if (schoolsWithUrls.length === 0) { notify("No newsletter URLs configured for selected schools", "warning"); return; }

      setClaudePanelOpen(true);
      const totalSchools = schoolsWithUrls.length;
      setClaudeMessages(prev => [...prev, {
        role: "assistant",
        content: `Scanning newsletter${totalSchools > 1 ? `s for ${totalSchools} schools` : ` for ${schoolsWithUrls[0].name}`}…${totalSchools > 1 ? " (scanning one at a time to stay within rate limits)" : ""}`
      }]);

      const today = melbourneToday();
      let allNew = [];
      for (let si = 0; si < schoolsWithUrls.length; si++) {
        const school = schoolsWithUrls[si];
        if (si > 0) await new Promise(r => setTimeout(r, 15000)); // 15s between schools

        const guidance = school.newsletterGuidance ? `\n\nSPECIFIC INSTRUCTIONS:\n${school.newsletterGuidance}` : "";
        const prompt = `Visit this school newsletter/events page and extract any upcoming interruptions to music lessons (excursions, carnivals, student free days, camps, assemblies, swimming, concerts, NAPLAN etc): ${school.newsletterUrl}\n\nFor each event return a JSON object with: date (YYYY-MM-DD), endDate (YYYY-MM-DD, same as date if single day), title, type (one of: student_free, excursion, carnival, swimming, concert, camp, assembly, photos, other), affectsClasses (comma-separated class names or "all"), startTime (HH:MM or ""), endTime (HH:MM or "").\n\nRespond ONLY with a JSON array. If there are no relevant events or the page is unavailable, respond with [].${guidance}`;

        let response = null;
        let attempts = 0;
        while (attempts < 3) {
          attempts++;
          try {
            response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
              method: "POST", headers: getAnthropicHeaders(),
              body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, tools: [{ type: "web_search_20250305", name: "web_search" }], messages: [{ role: "user", content: prompt }] })
            });
            if (response.status === 529 || response.status === 429) {
              const wait = attempts * 20000;
              setClaudeMessages(prev => [...prev, { role: "assistant", content: `Rate limit for ${school.name} — retrying in ${wait / 1000}s… (${attempts}/3)` }]);
              await new Promise(r => setTimeout(r, wait));
              response = null;
            } else {
              break;
            }
          } catch(err) {
            setClaudeMessages(prev => [...prev, { role: "assistant", content: `⚠ Error scanning ${school.name}: ${err.message}` }]);
            break;
          }
        }

        if (!response) continue;
        if (!response.ok) {
          let errText = "";
          try { const errData = await response.json(); errText = errData.error?.message || response.status; } catch(e) { errText = response.status; }
          setApiStatus("error");
          setClaudeMessages(prev => [...prev, { role: "assistant", content: `⚠ Scan failed for ${school.name}: ${errText}` }]);
          continue;
        }

        try {
          const data = await response.json();
          if (data.usage) { recordUsage("claude-sonnet-4-20250514", data.usage.input_tokens || 0, data.usage.output_tokens || 0); setApiStatus("ok"); }
          const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
          const match = text.match(/\[[\s\S]*\]/);
          if (!match) continue;
          const entries = JSON.parse(match[0]);
          if (!Array.isArray(entries)) continue;
          const newEntries = entries
            .filter(e => e.date && e.date >= today && e.title)
            .map(e => ({ id: uid(), schoolId: school.id, date: e.date, endDate: e.endDate || e.date, title: e.title, type: e.type || "other", affectsClasses: e.affectsClasses || "all", startTime: e.startTime || "", endTime: e.endTime || "", notes: "", source: school.newsletterUrl }));
          allNew = [...allNew, ...newEntries];
        } catch(err) {
          setClaudeMessages(prev => [...prev, { role: "assistant", content: `⚠ Error parsing response for ${school.name}: ${err.message}` }]);
        }
      }

      if (allNew.length === 0) {
        setClaudeMessages(prev => [...prev, { role: "assistant", content: "No upcoming interruptions found." }]);
        return;
      }

      // Dedupe using ref — always current
      const existing = new Set(currentInterruptions.map(i => `${i.date}|${i.title}`));
      const deduped = allNew.filter(e => !existing.has(`${e.date}|${e.title}`));

      if (deduped.length === 0) {
        setClaudeMessages(prev => [...prev, { role: "assistant", content: "Scan complete — no new interruptions found (all results already imported)." }]);
        return;
      }

      const summary = deduped
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 8)
        .map(e => `• ${e.date}: ${e.title}${e.affectsClasses && e.affectsClasses !== "all" ? ` (${e.affectsClasses})` : ""}`)
        .join("\n");
      const more = deduped.length > 8 ? `\n…and ${deduped.length - 8} more.` : "";

      setClaudeMessages(prev => [...prev, {
        role: "assistant",
        content: `Found ${deduped.length} new interruption${deduped.length !== 1 ? "s" : ""}:\n\n${summary}${more}\n\n__SCAN_REVIEW__`
      }]);

      setScanPreview({ entries: deduped, source: schoolsWithUrls.map(s => s.name).join(", ") });
    };

    forceNewsletterScan.current = doScan;
  // Only re-register if loading changes — refs handle everything else
  }, [loading]);

  // Auto-backup to localStorage whenever important data changes (silent, always available)
  useEffect(() => {
    if (!storageReady.current) return;
    triggerAutoBackup({ version: 1, exportedAt: new Date().toISOString(), schools, students, teachers, specialists, interruptions, groups, timetable, weeklyTimetables, tallyEntries, contacts, bands });
  }, [schools, students, teachers, timetable, weeklyTimetables, tallyEntries]);


  // ── Scheduled backup 4× per day at 6-hour intervals ──────────
  useEffect(() => {
    const MS_6H = 6 * 60 * 60 * 1000;

    const doScheduledBackup = async () => {
      try {
        const ttVersions = await loadData(STORAGE_KEYS.timetableVersions, []);
        const userTemplates = await loadData(STORAGE_KEYS.userTemplates, []);
        const emailTemplates = await loadData(STORAGE_KEYS.emailTemplates, {});
        let aiEmailRules = {};
        try { const raw = localStorage.getItem("mt-ai-email-rules"); if (raw) aiEmailRules = JSON.parse(raw); } catch(e) {}
        const backup = {
          version: DATA_VERSION, exportedAt: new Date().toISOString(),
          schools, students, teachers, specialists, interruptions, groups,
          timetable, weeklyTimetables, tallyEntries, timetableVersions: ttVersions,
          contacts, bands, masterBreaks, resources,
          userTemplates, emailTemplates, aiEmailRules,
        };
        const json = JSON.stringify(backup, null, 2);
        const now = melbourneNow();
        const dateStr = toLocalDateStr(now);
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const filename = `timetabling-auto-${dateStr}-${hh}${mm}.json`;
        if (window.electronAPI) {
          const savedFolder = localStorage.getItem(STORAGE_KEYS.backupFolder);
          const result = await window.electronAPI.writeBackup(filename, json, savedFolder || null);
          if (!result.ok) throw new Error(result.error);
          localStorage.setItem(STORAGE_KEYS.lastScheduledBackup, new Date().toISOString());
          notify("Auto-backup saved", "success", 4000);
        } else {
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = filename;
          document.body.appendChild(a); a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          localStorage.setItem(STORAGE_KEYS.lastScheduledBackup, new Date().toISOString());
          notify("Auto-backup downloaded", "success", 5000);
        }
      } catch(e) {
        logError("Scheduled backup failed", e.message);
      }
    };

    const checkAndBackup = () => {
      if (!storageReady.current || !schools.length) return;
      const lastStr = localStorage.getItem(STORAGE_KEYS.lastScheduledBackup);
      const last = lastStr ? new Date(lastStr) : null;
      const overdue = !last || (Date.now() - last.getTime()) > MS_6H;
      if (overdue) doScheduledBackup();
    };

    const onOpenTimer = setTimeout(checkAndBackup, 2000);
    const interval = setInterval(checkAndBackup, 60 * 1000);
    return () => { clearTimeout(onOpenTimer); clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schools.length, storageReady.current]);


  // Sync localStorage when user changes backup folder via the Backup menu
  React.useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onBackupFolderChanged) return;
    const unsub = window.electronAPI.onBackupFolderChanged((folder) => {
      localStorage.setItem(STORAGE_KEYS.backupFolder, folder);
    });
    return unsub;
  }, []);

  // Listen for update status from electron-updater
  React.useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onUpdateStatus) return;
    const unsub = window.electronAPI.onUpdateStatus((status) => {
      if (status.error) {
        console.error("[updater] error:", status.error);
        setUpdateProgress(null);
      }
      if (status.downloading) {
        setUpdateProgress(status.percent);
      } else if (status.ready) {
        setUpdateProgress(100);
        setUpdateInfo({ version: status.version, available: true, ready: true });
      } else if (status.available) {
        setUpdateInfo({ version: status.version, available: true });
        setUpdateProgress(0);
      } else {
        // No update available — show flash confirmation
        setUpdateProgress(null);
        setNoUpdateFlash(true);
        setTimeout(() => setNoUpdateFlash(false), 2500);
      }
    });
    return unsub;
  }, []);

  // Clock tick — update every 10s (only showing H:MM, no need for 1s precision)
  React.useEffect(() => {
    const tick = () => { const n = melbourneNow(); const h = n.getHours(); const h12 = h % 12 || 12; setClockTime(h12 + ":" + String(n.getMinutes()).padStart(2, "0")); };
    tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, []);

  // Auto-check for updates on launch
  React.useEffect(() => {
    if (window.electronAPI && window.electronAPI.checkForUpdates) {
      setTimeout(() => window.electronAPI.checkForUpdates(), 3000);
    }
  }, []);


  // Auto-send queue processor — sends one email every 5s with undo window
  useEffect(() => {
    if (autoSendQueue.length === 0 || autoSendActiveRef.current) return;
    autoSendActiveRef.current = true;
    autoSendTimerRef.current = setTimeout(async () => {
      setAutoSendQueue(prev => {
        if (prev.length === 0) { autoSendActiveRef.current = false; return prev; }
        const [first, ...rest] = prev;
        (async () => {
          try {
            if (window.electronAPI?.gmailSend) {
              const result = await window.electronAPI.gmailSend({
                to: first.to, from: first.from || undefined,
                subject: first.subject, bodyHtml: first.bodyHtml || first.body || ""
              });
              if (!result.ok) notify(`Send failed for ${first.label || first.to}: ${result.error}`, "danger");
            }
          } catch(e) { notify(`Send error: ${e.message}`, "danger"); }
          autoSendActiveRef.current = false;
        })();
        return rest;
      });
    }, 5000);
    return () => clearTimeout(autoSendTimerRef.current);
  }, [autoSendQueue]); // eslint-disable-line react-hooks/exhaustive-deps

  const readClaudeFile = (file) => {
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const isPdf = file.type === "application/pdf";
    if (!isImage && !isPdf) { notify("Claude can read images and PDFs — other file types aren't supported yet.", "warning"); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target.result.split(",")[1];
      setClaudeAttachment({ filename: file.name, base64, mediaType: file.type, kind: isImage ? "image" : "pdf" });
      setClaudePanelOpen(true);
      setTimeout(() => claudeInputRef.current?.focus(), 50);
    };
    reader.readAsDataURL(file);
  };

  // ── Claude system prompt builder ─────────────────────────────
  const buildClaudeSystemPrompt = (currentPage) => {
    const now = melbourneNow();
    const todayStr = toLocalDateStr(now);
    const dayName = now.toLocaleDateString("en-AU", { weekday: "long", timeZone: TIMEZONE });
    const termBreaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));
    const weekNum = computeTermWeekNum(todayStr, termBreaks);
    const activeStudents = students.filter(s => s.status === "active");
    const pendingStudents = students.filter(s => s.status === "pending" || s.status === "trial");
    const allLessons = timetable?.lessons || [];

    const lines = [];

    // ── Memory (persistent facts) ──
    if (claudeMemory.length > 0) {
      lines.push("## Remembered Facts");
      lines.push("These are things the user has specifically asked you to remember across sessions:");
      claudeMemory.forEach(m => lines.push(`- ${m}`));
      lines.push("");
    }

    // ── Personal context (user-written) ──
    if (claudePersonalContext.trim()) {
      lines.push("## About Me");
      lines.push(claudePersonalContext.trim());
      lines.push("");
    }

    // ── Universal base ──
    lines.push("## Current Context");
    lines.push(`Today is ${dayName} ${todayStr}${weekNum ? `, Term Week ${weekNum}` : ""}.`);
    lines.push(`You are the AI assistant built into the user's music lesson scheduling app.`);
    lines.push(`Current tab: ${currentPage}`);
    lines.push("");

    // ── Schools ──
    lines.push("## Schools");
    schools.forEach(s => lines.push(`- ${s.name} (id: ${s.id})`));
    lines.push("");

    // ── Teachers ──
    lines.push("## Teachers");
    teachers.forEach(t => lines.push(`- ${t.name}${t.email ? ` <${t.email}>` : ""}`));
    lines.push("");

    // ── Full student roster (always — not tab-gated) ──
    lines.push("## All Active Students");
    activeStudents.forEach(s => {
      const school = schools.find(sc => sc.id === s.schoolId)?.name || "";
      const instrs = (s.instruments || []).map(i => {
        const teacher = teachers.find(t => t.id === i.teacherId);
        return `${i.name}${teacher ? ` with ${teacher.name}` : ""}`;
      }).join(", ");
      const studentLessons = allLessons.filter(l => l.studentId === s.id);
      const schedule = studentLessons.length > 0
        ? studentLessons.map(l => `${l.day} ${l.start}`).join(", ")
        : "unscheduled";
      lines.push(`  - ${s.name}${school ? ` — ${school}` : ""}${s.className ? `, ${s.className}` : ""}${instrs ? ` (${instrs})` : ""} [${schedule}]`);
    });
    lines.push("");

    // ── Pending / trial students with setup details ──
    if (pendingStudents.length > 0) {
      lines.push("## Pending / Trial Students");
      lines.push("(Trial students have a one-off lesson booked in a specific week. They auto-promote to Pending status after their trial lesson day at 6pm. Pending students are waiting to be added to the regular timetable.)");
      pendingStudents.forEach(s => {
        const school = schools.find(sc => sc.id === s.schoolId)?.name || "";
        const instrs = (s.instruments || []).map(i => {
          const teacher = teachers.find(t => t.id === i.teacherId);
          return `${i.name}${teacher ? ` with ${teacher.name}` : " (no teacher assigned)"}`;
        }).join(", ");

        // For trial students, check weeklyTimetables for their trial lesson
        // (trial lessons are stored per-week, not in the master timetable)
        let scheduleNote;
        if (s.status === "trial") {
          let trialLesson = null;
          let trialWeekKey = null;
          for (const [storageKey, data] of Object.entries(weeklyTimetables || {})) {
            const lesson = (data.lessons || []).find(l => l.studentId === s.id && l.isTrial);
            if (lesson) {
              trialLesson = lesson;
              trialWeekKey = storageKey.split("|")[0];
              break;
            }
          }
          scheduleNote = trialLesson
            ? `trial lesson: ${trialLesson.day} ${trialLesson.start} (week of ${trialWeekKey})`
            : "trial lesson NOT YET SCHEDULED";
        } else {
          const studentLessons = allLessons.filter(l => l.studentId === s.id);
          scheduleNote = studentLessons.length > 0
            ? `scheduled: ${studentLessons.map(l => `${l.day} ${l.start}`).join(", ")}`
            : "NOT YET SCHEDULED";
        }

        const noteLine = s.notes ? ` — note: ${s.notes}` : "";
        lines.push(`  - ${s.name} [${s.status.toUpperCase()}]${school ? ` — ${school}` : ""}${s.className ? `, ${s.className}` : ""}${instrs ? ` (${instrs})` : ""} — ${scheduleNote}${noteLine}`);
      });
      lines.push("");
    }

    // ── Students awaiting scheduling (from timetable engine) ──
    const unscheduledList = timetable?.unscheduled || [];
    if (unscheduledList.length > 0) {
      lines.push("## Students Awaiting Scheduling");
      unscheduledList.forEach(u => {
        const s = u.student || u;
        const school = schools.find(sc => sc.id === s.schoolId)?.name || "";
        lines.push(`  - ${s.name}${school ? ` — ${school}` : ""} (${u.instrument || "unknown instrument"})`);
      });
      lines.push("");
    }

    // ── Full master timetable (always — not tab-gated) ──
    lines.push("## Master Timetable");
    if (allLessons.length === 0) {
      lines.push("No lessons scheduled yet.");
    } else {
      const bySchool = {};
      allLessons.forEach(l => {
        const sn = schools.find(s => s.id === l.schoolId)?.name || l.schoolId;
        if (!bySchool[sn]) bySchool[sn] = [];
        bySchool[sn].push(l);
      });
      Object.entries(bySchool).forEach(([sn, ls]) => {
        lines.push(`${sn}:`);
        const byDay = {};
        ls.forEach(l => { if (!byDay[l.day]) byDay[l.day] = []; byDay[l.day].push(l); });
        ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].forEach(day => {
          if (byDay[day]) {
            byDay[day].sort((a, b) => (a.start || "").localeCompare(b.start || ""));
            byDay[day].forEach(l => {
              let who;
              if (l.isGroup) {
                const grp = groups.find(g => g.id === l.groupId);
                const members = grp ? (grp.studentIds || []).map(sid => students.find(s => s.id === sid)?.name).filter(Boolean).join(", ") : "";
                who = l.groupName || "Group";
                if (members) who += ` [members: ${members}]`;
              } else {
                who = l.studentName;
              }
              lines.push(`  ${day} ${l.start}${String.fromCharCode(8211)}${l.end}: ${who} (${l.instrument}) ${String.fromCharCode(8212)} ${l.teacherName}`);
            });
          }
        });
      });
    }
    lines.push("");

    // ── Groups (always — not tab-gated) ──
    if (groups.length > 0) {
      lines.push("## Groups");
      groups.forEach(g => {
        const school = schools.find(s => s.id === g.schoolId)?.name || "";
        const teacher = teachers.find(t => t.id === g.teacherId)?.name || "";
        const memberNames = (g.studentIds || []).map(sid => students.find(s => s.id === sid)?.name).filter(Boolean).join(", ");
        const status = g.status || "forming";
        lines.push(`  - ${g.name}${school ? ` — ${school}` : ""}${teacher ? `, teacher: ${teacher}` : ""}, instrument: ${g.instrument || "unknown"}, status: ${status}`);
        if (memberNames) lines.push(`    members: ${memberNames}`);
      });
      lines.push("");
    }

    // ── Specialist timetable (always — not tab-gated) ──
    if (specialists.length > 0) {
      lines.push("## Specialist Timetable");
      lines.push("(These are the regular recurring specialist classes per school. When a student's music lesson overlaps with one of these, a purple tag appears on their lesson card.)");
      const bySchool = {};
      specialists.forEach(sp => {
        const schoolName = schools.find(s => s.id === sp.schoolId)?.name || sp.schoolId;
        if (!bySchool[schoolName]) bySchool[schoolName] = [];
        bySchool[schoolName].push(sp);
      });
      Object.entries(bySchool).forEach(([schoolName, entries]) => {
        lines.push(`${schoolName}:`);
        const byClass = {};
        entries.forEach(sp => {
          if (!byClass[sp.className]) byClass[sp.className] = [];
          byClass[sp.className].push(sp);
        });
        Object.entries(byClass).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).forEach(([className, slots]) => {
          const slotStrs = slots
            .sort((a, b) => ["Monday","Tuesday","Wednesday","Thursday","Friday"].indexOf(a.day) - ["Monday","Tuesday","Wednesday","Thursday","Friday"].indexOf(b.day) || a.start.localeCompare(b.start))
            .map(sp => `${sp.day} ${sp.start}–${sp.end} ${sp.subject}`)
            .join(", ");
          lines.push(`  Class ${className}: ${slotStrs}`);
        });
      });
      lines.push("");
    }

    // ── Contacts with emails (always — not tab-gated) ──
    if (contacts.length > 0) {
      lines.push("## Contacts");
      contacts.forEach(c => {
        const student = students.find(s => s.id === c.studentId);
        const link = student ? ` (${student.name}'s contact)` : "";
        const phone = c.phone ? `, ph: ${c.phone}` : "";
        lines.push(`  - ${c.name}${link}: ${c.email || "no email"}${phone}`);
      });
      lines.push("");
    }

    // ── Recent tally — last 3 weeks (always — not tab-gated) ──
    const recentWeekKeys = [...new Set(tallyEntries.map(e => e.weekKey).filter(Boolean))]
      .sort().reverse().slice(0, 3);
    lines.push("## Recent Tally (last 3 weeks)");
    if (recentWeekKeys.length === 0) {
      lines.push("No tally entries recorded yet.");
    } else {
      recentWeekKeys.forEach(wk => {
        const wkEntries = tallyEntries.filter(e => e.weekKey === wk);
        const completed = wkEntries.filter(e => e.status === "completed");
        const missed = wkEntries.filter(e => e.status === "missed");
        const label = wkEntries[0]?.weekLabel || wk;
        lines.push(`${label}: ${completed.length} completed, ${missed.length} missed`);
        missed.forEach(e => {
          const school = schools.find(s => s.id === e.schoolId)?.name || "";
          lines.push(`  - ${e.studentName} (${e.instrument})${school ? ` at ${school}` : ""}, ${e.day}${e.makeupEligible && !e.madeUp ? " — catch-up owed" : e.madeUp ? " — caught up" : ""}${e.reason ? `, reason: ${e.reason}` : ""}`);
        });
      });
    }
    lines.push("");

    // ── Outstanding catch-ups (all time, not yet made up) ──
    const catchupsOwed = tallyEntries.filter(e => e.status === "missed" && e.makeupEligible && !e.madeUp);
    if (catchupsOwed.length > 0) {
      lines.push("## Outstanding Catch-ups");
      catchupsOwed.forEach(e => lines.push(`  - ${e.studentName} (${e.instrument}), ${e.weekLabel || e.weekKey}`));
      lines.push("");
    }

    // ── Upcoming interruptions (next 30 days) ──
    const soon = interruptions
      .filter(i => i.type !== "term_break" && i.date >= todayStr && i.date <= (() => { const d = new Date(now); d.setDate(d.getDate() + 30); return toLocalDateStr(d); })())
      .sort((a, b) => a.date.localeCompare(b.date));
    if (soon.length > 0) {
      lines.push("## Upcoming Interruptions (next 30 days)");
      soon.forEach(i => {
        const school = schools.find(s => s.id === i.schoolId)?.name || "";
        lines.push(`  - ${i.date}${i.endDate && i.endDate !== i.date ? `–${i.endDate}` : ""}: ${i.title}${school ? ` (${school})` : ""}${i.affectsClasses && i.affectsClasses !== "all" ? ` — affects ${i.affectsClasses}` : ""}`);
      });
      lines.push("");
    }

    // ── Behavioural instructions ──
    lines.push("## Instructions");
    lines.push("- Be concise and practical. This is a working tool, not a chat app.");
    lines.push("- You have access to the user's live schedule data above — use it. Don't ask for information you already have.");
    lines.push("- When the user asks about students, lessons, or schedules, refer to the actual data provided.");
    lines.push("- Format responses with short paragraphs or brief bullet points. Avoid long prose.");
    lines.push("- If asked to draft an email, keep it friendly, professional, and brief.");
    lines.push("- Dates are in Melbourne, Australia time (AEDT/AEST).");
    lines.push("");
    lines.push("## Specialist Timetable Overrides");
    lines.push("When the user shares an image or description of an adjusted specialist timetable, follow this process exactly:");
    lines.push("1. Identify the school and the affected weeks from the image and the user's description.");
    lines.push("2. If anything is unclear or ambiguous — a class name, a time, a subject — stop and ask the user to clarify before continuing. Do not guess.");
    lines.push("3. Once you have enough information, compare the adjusted timetable against the regular specialist schedule shown above.");
    lines.push("4. Produce a dry-run report in this format:");
    lines.push("   - Plain English summary: school name, affected weeks, reason (e.g. Swimming carnival, NAPLAN).");
    lines.push("   - Per-class diff: for each change, state what the regular schedule has vs what the adjusted timetable shows. Use plain language: 'Class 3A — Tuesday 9:00–9:50 changes from PE/Sport → Swimming', 'Class 5/6B — Wednesday slot removed', 'Class Prep A — Friday 2:00–2:50 Swimming added (not in regular schedule)'.");
    lines.push("   - Affected students: list any students whose current music lessons overlap with changed slots. State the student name, class, day and time.");
    lines.push("5. End with: 'Let me know when you've checked these and I'll be ready for the next one.' Do not offer to apply changes.");
    lines.push("The data structure you are proposing changes to is called weekSpecialistOverrides, keyed by weekKey|schoolId (e.g. '2025-05-12|school-id'). Each entry has a reason string and an entries array of { className, day, start, end, subject }. These override the regular specialist schedule for that week only — only classes/days mentioned are overridden, the rest fall back to the regular schedule.");
    lines.push("This is a DRY RUN ONLY phase. You describe what would change. You do not apply changes.");

    return lines.join("\n");
  };
  const handleRestore = (data) => {
    if (data.schools) { const ms = migrateData("schools", data.schools); setSchools(ms); saveData(STORAGE_KEYS.schools, ms); saveData(STORAGE_KEYS.schoolsBak, ms); }
    if (data.students) { const mst = migrateData("students", data.students); setStudents(mst); saveStudents(mst); }
    if (data.teachers) { const mt = migrateData("teachers", data.teachers); setTeachers(mt); saveData(STORAGE_KEYS.teachers, mt); }
    if (data.specialists) { setSpecialists(data.specialists); saveData(STORAGE_KEYS.specialists, data.specialists); saveData(STORAGE_KEYS.specialistsBak, data.specialists); }
    if (data.interruptions) { setInterruptions(data.interruptions); saveData(STORAGE_KEYS.interruptions, data.interruptions); }
    if (data.groups) { const mg = migrateData("groups", data.groups); setGroups(mg); saveData(STORAGE_KEYS.groups, mg); }
    if (data.timetable !== undefined) { setTimetableRaw(data.timetable); saveData(STORAGE_KEYS.timetable, data.timetable); }
    if (data.weeklyTimetables) { setWeeklyTimetables(data.weeklyTimetables); saveData(STORAGE_KEYS.weeklyTimetables, data.weeklyTimetables); }
    if (data.tallyEntries) { const mte = migrateData("tallyEntries", data.tallyEntries); setTallyEntries(mte); saveData(STORAGE_KEYS.tallyEntries, mte); }
    if (data.timetableVersions) saveData(STORAGE_KEYS.timetableVersions, data.timetableVersions);
    if (data.contacts) { setContacts(data.contacts); saveData(STORAGE_KEYS.contacts, data.contacts); }
    if (data.bands) { setBands(data.bands); saveData(STORAGE_KEYS.bands, data.bands); }
    if (data.masterBreaks) { setMasterBreaks(data.masterBreaks); saveData(STORAGE_KEYS.masterBreaks, data.masterBreaks); }
    if (data.resources) { setResources(data.resources); saveData(STORAGE_KEYS.resources, data.resources); }
    if (data.userTemplates) saveData(STORAGE_KEYS.userTemplates, data.userTemplates);
    if (data.emailTemplates) saveData(STORAGE_KEYS.emailTemplates, data.emailTemplates);
    if (data.aiEmailRules) { try { localStorage.setItem("mt-ai-email-rules", JSON.stringify(data.aiEmailRules)); } catch(e) {} }
    notify("Data restored from backup!");
  };

  // Shared backup handler — accessible from Settings page and Cmd+Shift+B shortcut
  const handleBackup = React.useCallback(async () => {
    const ttVersions = await loadData(STORAGE_KEYS.timetableVersions, []);
    const userTemplates = await loadData(STORAGE_KEYS.userTemplates, []);
    const emailTemplates = await loadData(STORAGE_KEYS.emailTemplates, {});
    let aiEmailRules = {};
    try { const raw = localStorage.getItem("mt-ai-email-rules"); if (raw) aiEmailRules = JSON.parse(raw); } catch(e) {}
    const backup = {
      version: DATA_VERSION, exportedAt: new Date().toISOString(),
      schools, students, teachers, specialists, interruptions, groups,
      timetable, weeklyTimetables, tallyEntries, timetableVersions: ttVersions,
      contacts, bands, masterBreaks, resources,
      userTemplates, emailTemplates, aiEmailRules,
    };
    const json = JSON.stringify(backup, null, 2);
    const defaultName = "timetabling-backup-" + melbourneToday() + ".json";
    if (window.electronAPI) {
      // Show save dialog so user can choose location
      const result = await window.electronAPI.saveFileDialog(defaultName, json);
      if (result.ok) { notify("Backup saved ✓ — " + result.filePath.split("/").slice(-2).join("/")); return true; }
      else if (result.canceled) { return false; }
      else { notify("Backup failed: " + (result.error || "Unknown error"), "danger"); return false; }
    } else {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = defaultName;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify("Backup downloaded!");
      return true;
    }
  }, [schools, students, teachers, specialists, interruptions, groups, timetable, weeklyTimetables, tallyEntries, contacts, bands, masterBreaks, resources, notify]);

  // Cmd+Shift+B from Electron menu — works from any page
  React.useEffect(() => {
    if (!window.electronAPI) return;
    const unsub = window.electronAPI.onMenuBackup(() => handleBackup());
    return unsub;
  }, [handleBackup]);

  const activeStudents = students.filter(s => s.status === "active");
  const pendingStudents = students.filter(s => s.status === "pending" || s.status === "trial");

  // Track unacknowledged constraint warnings across both timetable tabs (for nav badges)
  const [ttConstraintWarnings, setTtConstraintWarnings] = React.useState({});
  const [ttAckedConstraints, setTtAckedConstraints] = React.useState(new Set());
  const [weeklyConstraintWarnings, setWeeklyConstraintWarnings] = React.useState({});
  const [weeklyAckedConstraints, setWeeklyAckedConstraints] = React.useState(new Set());
  const ttWarningCount = Object.keys(ttConstraintWarnings).filter(id => !ttAckedConstraints.has(id)).length;
  const weeklyWarningCount = Object.keys(weeklyConstraintWarnings).filter(id => !weeklyAckedConstraints.has(id)).length;

  const [generating, setGenerating] = useState(false);
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null); // null | { version, available }
  const [updateProgress, setUpdateProgress] = useState(null); // null | 0-100
  const [noUpdateFlash, setNoUpdateFlash] = useState(false); // briefly show "No new updates"
  const [clockTime, setClockTime] = useState(() => { const n = melbourneNow(); const h = n.getHours(); const h12 = h % 12 || 12; return h12 + ":" + String(n.getMinutes()).padStart(2, "0"); });

  const handleGenerateTimetable = async () => {
    setGenerating(false); // reset in case previous run got stuck
    if (schools.length === 0) { notify("Add at least one school first", "warning"); return; }
    const allSchedulable = students.filter(s => s.status === "active");
    if (allSchedulable.length === 0) { notify("Add at least one active student first", "warning"); return; }
    if (teachers.length === 0) { notify("Add at least one teacher first", "warning"); return; }

    // Data validation warnings
    const warnings = [];
    const noTeacher = allSchedulable.filter(s => !s.instruments.some(i => i.teacherId));
    if (noTeacher.length > 0) warnings.push(`${noTeacher.length} student${noTeacher.length > 1 ? "s" : ""} without assigned teacher: ${noTeacher.slice(0, 5).map(s => s.name).join(", ")}${noTeacher.length > 5 ? "..." : ""}`);
    const noInstrument = allSchedulable.filter(s => !s.instruments || s.instruments.length === 0 || !s.instruments[0].name);
    if (noInstrument.length > 0) warnings.push(`${noInstrument.length} student${noInstrument.length > 1 ? "s" : ""} without instruments: ${noInstrument.slice(0, 5).map(s => s.name).join(", ")}${noInstrument.length > 5 ? "..." : ""}`);
    const noSlots = schools.filter(s => !s.slots || s.slots.length === 0);
    if (noSlots.length > 0) warnings.push(`${noSlots.length} school${noSlots.length > 1 ? "s" : ""} without time slots: ${noSlots.map(s => s.name).join(", ")}`);
    const noAvail = teachers.filter(t => !t.availability || t.availability.length === 0);
    if (noAvail.length > 0) warnings.push(`${noAvail.length} teacher${noAvail.length > 1 ? "s" : ""} without availability: ${noAvail.map(t => t.name).join(", ")}`);
    if (warnings.length > 0) {
      notify("⚠ " + warnings.join(" · "), "warning");
    }

    try {

    // Check if any active students have notes that need AI parsing
    const studentsWithNotes = allSchedulable.filter(s => s.notes && s.notes.trim());
    const specialistsWithNotes = specialists.filter(s => s.notes && s.notes.trim());
    let enrichedStudents = [...students];
    let enrichedSpecialists = specialists;

    if (studentsWithNotes.length > 0 || specialistsWithNotes.length > 0) {
      setGenerating(true);
      notify("Parsing scheduling notes...");
      try {
        enrichedSpecialists = await parseSpecialistNotes(specialists, specialistsWithNotes, recordUsage);
        enrichedStudents    = await parseStudentNotes(students, studentsWithNotes, enrichedSpecialists, schools, recordUsage);
      } catch (err) {
        console.error("Note parsing error:", err);
        notify("⚠ Note parsing skipped: " + err.message, "warning");
      }
      setGenerating(false);
    }

    // Schedule eligible groups FIRST (equal priority — they compete for slots before individuals)
    // Eligible = any group with enough members, regardless of status
    const eligibleGroups = groups.filter(g => (g.studentIds || []).length >= g.minSize && g.status !== "scheduled");
    const groupLessons = eligibleGroups.length > 0
      ? scheduleReadyGroups(eligibleGroups.map(g => ({ ...g, status: "ready" })), [], schools, students, teachers, enrichedSpecialists)
      : { scheduled: [], failed: [] };

    // Generate individual lessons around the group lessons
    const result = generateMasterTimetable(schools, enrichedStudents, teachers, enrichedSpecialists, {
      existingLessons: groupLessons.scheduled
    });
    result.lessons = [...result.lessons, ...groupLessons.failed.length > 0 ? [] : []]; // lessons already include existingLessons
    result.unscheduled = [...result.unscheduled, ...groupLessons.failed];


    // Update group statuses
    const scheduledGroupIds = new Set(groupLessons.scheduled.map(l => l.groupId));
    if (scheduledGroupIds.size > 0) {
      setGroups(prev => prev.map(g => scheduledGroupIds.has(g.id) ? { ...g, status: "scheduled" } : g));
    }

    compactTimetable(result, schools, students, teachers, specialists);
    // Post-compaction double-booking check
    for (let i = result.lessons.length - 1; i >= 0; i--) {
      const l = result.lessons[i];
      const conflict = result.lessons.find((o, j) => j < i && o.teacherId === l.teacherId && o.day === l.day &&
        timeToMin(o.start) < timeToMin(l.end) && timeToMin(l.start) < timeToMin(o.end));
      if (conflict) {
        result.unscheduled.push({ student: students.find(s => s.id === l.studentId) || { id: l.studentId, name: l.studentName, schoolId: l.schoolId }, instrument: l.instrument, reason: `Double-booking: ${l.teacherName} on ${l.day} at ${l.start}` });
        result.lessons.splice(i, 1);
      }
    }
    // Seed masterBreaks from teacher-level break settings only.
    // School-level breaks (school.teacherBreaks) are rendered as spanning rows — not cards.
    const seededBreaks = [];
    const GEN_DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday"];
    for (const school of schools) {
      const schoolSlotTimes = (school.slots || []).map(s => s.start);
      // School-wide break time ranges — mark those slot times so we can exclude them
      const schoolBreakTimes = new Set();
      for (const b of (school.teacherBreaks || [])) {
        const bStart = timeToMin(b.start), bEnd = timeToMin(b.end);
        for (const t of schoolSlotTimes) {
          if (timeToMin(t) >= bStart && timeToMin(t) < bEnd) schoolBreakTimes.add(t);
        }
      }
      // Recess/lunch slot types also count as school-level breaks
      for (const s of (school.slots || [])) {
        if (s.type === "recess" || s.type === "lunch") schoolBreakTimes.add(s.start);
      }
      // Teacher-level breaks → per-day draggable cards
      for (const teacher of teachers) {
        for (const tb of (teacher.teacherBreaks || [])) {
          if (tb.schoolId !== school.id) continue;
          const bDay = tb.day || null;
          const bStart = timeToMin(tb.start), bEnd = timeToMin(tb.end);
          const days = bDay ? [bDay] : GEN_DAYS;
          for (const d of days) {
            for (const t of schoolSlotTimes) {
              if (schoolBreakTimes.has(t)) continue; // school break — skip, shown as row
              const tMin = timeToMin(t);
              if (tMin >= bStart && tMin < bEnd) {
                seededBreaks.push({ id: uid(), schoolId: school.id, day: d, time: t });
              }
            }
          }
        }
      }
    }
    // Deduplicate by schoolId+day+time
    const seen = new Set();
    const dedupedBreaks = seededBreaks.filter(b => {
      const k = `${b.schoolId}|${b.day}|${b.time}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    setMasterBreaks(dedupedBreaks);
    setTimetable(result);
    const groupsSched = groupLessons.scheduled.length;
    let msg = `Timetable scheduled: ${result.lessons.length} lessons scheduled, ${result.unscheduled.length} unscheduled`;
    if (groupsSched > 0) msg += ` (incl. ${groupsSched} group${groupsSched !== 1 ? "s" : ""})`;
    setGenerating(false);
    notify(msg);
    setPage("timetable");
    } catch (genErr) {
      setGenerating(false);
      notify(`Generation error: ${genErr.message}`, "danger");
    }
  };

  const handleGenerateSchool = async (schoolId) => {
    const schoolName = schools.find(s => s.id === schoolId)?.name || "school";
    const schoolStudents = students.filter(s => s.status === "active" && s.schoolId === schoolId);
    if (schoolStudents.length === 0) { notify(`No active students at ${schoolName}`, "warning"); return; }

    // Keep lessons from other schools (drop old group lessons at this school — will re-schedule)
    const otherLessons = timetable ? timetable.lessons.filter(l => l.schoolId !== schoolId) : [];
    const otherUnscheduled = timetable ? timetable.unscheduled.filter(u => u.student.schoolId !== schoolId) : [];

    // AI note parsing for this school's students only
    let enrichedStudents = [...students];
    let enrichedSpecialists = specialists;
    const studentsWithNotes = schoolStudents.filter(s => s.notes && s.notes.trim());
    const specialistsWithNotes = specialists.filter(s => s.notes && s.notes.trim() && s.schoolId === schoolId);

    if (studentsWithNotes.length > 0 || specialistsWithNotes.length > 0) {
      setGenerating(true);
      notify(`Parsing notes for ${schoolName}...`);
      try {
        enrichedSpecialists = await parseSpecialistNotes(specialists, specialistsWithNotes, recordUsage);
        enrichedStudents    = await parseStudentNotes(students, studentsWithNotes, enrichedSpecialists, schools, recordUsage);
      } catch (err) {
        console.error("Note parsing error:", err);
      }
      setGenerating(false);
    }

    // Schedule eligible groups at this school FIRST (equal priority)
    const eligibleSchoolGroups = groups.filter(g =>
      g.schoolId === schoolId && (g.studentIds || []).length >= g.minSize && g.status !== "scheduled"
    );
    const prevScheduledGroups = groups.filter(g => g.status === "scheduled" && g.schoolId === schoolId);
    const allGroupsToSchedule = [...eligibleSchoolGroups, ...prevScheduledGroups];
    const tempGroupsForSched = allGroupsToSchedule.map(g => ({ ...g, status: "ready" }));
    const groupLessons = tempGroupsForSched.length > 0
      ? scheduleReadyGroups(tempGroupsForSched, otherLessons, schools, students, teachers, enrichedSpecialists)
      : { scheduled: [], failed: [] };

    const result = generateMasterTimetable(schools, enrichedStudents, teachers, enrichedSpecialists, {
      existingLessons: [...otherLessons, ...groupLessons.scheduled],
      targetSchoolId: schoolId
    });
    result.unscheduled = [...otherUnscheduled, ...result.unscheduled.filter(u => u.student.schoolId === schoolId), ...groupLessons.failed];

    // Promote pending students that got scheduled
    // Update group statuses
    const scheduledGroupIds = new Set(groupLessons.scheduled.map(l => l.groupId));
    const revertedGroupIds = prevScheduledGroups.filter(g => !scheduledGroupIds.has(g.id)).map(g => g.id);
    setGroups(prev => prev.map(g => {
      if (scheduledGroupIds.has(g.id)) return { ...g, status: "scheduled" };
      if (revertedGroupIds.includes(g.id)) return { ...g, status: "forming" };
      return g;
    }));

    compactTimetable(result, schools, students, teachers, specialists);
    for (let i = result.lessons.length - 1; i >= 0; i--) {
      const l = result.lessons[i];
      const conflict = result.lessons.find((o, j) => j < i && o.teacherId === l.teacherId && o.day === l.day &&
        timeToMin(o.start) < timeToMin(l.end) && timeToMin(l.start) < timeToMin(o.end));
      if (conflict) {
        result.unscheduled.push({ student: students.find(s => s.id === l.studentId) || { id: l.studentId, name: l.studentName, schoolId: l.schoolId }, instrument: l.instrument, reason: `Double-booking: ${l.teacherName} on ${l.day} at ${l.start}` });
        result.lessons.splice(i, 1);
      }
    }
    setTimetable(result);
    const newCount = result.lessons.length - otherLessons.length;
    const newUnsched = result.unscheduled.filter(u => (u.student?.schoolId || u.schoolId) === schoolId).length;
    notify(`${schoolName}: ${newCount} lessons scheduled${newUnsched > 0 ? `, ${newUnsched} unscheduled` : ""}`);
  };

  const handleClearSchool = (schoolId) => {
    if (!timetable) return;
    const schoolName = schools.find(s => s.id === schoolId)?.name || "school";
    // Revert any scheduled groups at this school back to "forming"
    const clearedGroupIds = new Set(timetable.lessons.filter(l => l.schoolId === schoolId && l.isGroup).map(l => l.groupId));
    if (clearedGroupIds.size > 0) {
      setGroups(prev => prev.map(g => clearedGroupIds.has(g.id) ? { ...g, status: "forming" } : g));
    }
    const remaining = {
      lessons: timetable.lessons.filter(l => l.schoolId !== schoolId),
      unscheduled: timetable.unscheduled.filter(u => u.student.schoolId !== schoolId)
    };
    if (remaining.lessons.length === 0 && remaining.unscheduled.length === 0) {
      setTimetable(null);
    } else {
      setTimetable(remaining);
    }
    notify(`Cleared timetable for ${schoolName}`);
  };

  // Remove a scheduled group lesson from the timetable (when reverting to forming)
  const handleRevertGroup = (groupId) => {
    if (!timetable) return;
    setTimetable(prev => ({
      ...prev,
      lessons: prev.lessons.filter(l => l.groupId !== groupId)
    }));
  };

  // Smart group scheduling: tries to fit a group into the master timetable
  // Can shuffle existing lessons within the same day (9:00-15:30 class time only)
  // but cannot change days or move lessons to before/after school
  const handleAddGroupToMaster = (groupId, manualDay = null, manualTime = null) => {
    if (!timetable) { notify("Generate a Master Timetable first", "warning"); return null; }
    const group = groups.find(g => g.id === groupId);
    if (!group) return null;
    const school = schools.find(s => s.id === group.schoolId);
    const teacher = teachers.find(t => t.id === group.teacherId);
    if (!school || !teacher) { notify("School or teacher not found", "warning"); return null; }

    const teacherAvail = teacher.availability.filter(a => a.schoolId === school.id);
    if (teacherAvail.length === 0) { return { success: false, reason: `${teacher.name} not available at ${school.name}` }; }

    const schoolLessons = timetable.lessons.filter(l => l.schoolId === school.id);
    const classSlots = school.slots.filter(s => s.type === "class");
    const beforeAfterTypes = ["before_school", "after_school"];

    // If manual placement requested
    if (manualDay && manualTime) {
      const slot = school.slots.find(s => s.start === manualTime);
      if (!slot) return { success: false, reason: "Invalid time slot" };
      const lesson = {
        id: uid(), isGroup: true, groupId: group.id, groupName: group.name,
        studentId: group.studentIds[0], studentName: group.name,
        studentIds: [...group.studentIds],
        studentNames: group.studentIds.map(sid => students.find(s => s.id === sid)?.name || "?"),
        teacherId: teacher.id, teacherName: teacher.name,
        schoolId: school.id, schoolName: school.name,
        day: manualDay, slotId: slot.id, slotName: slot.name,
        start: slot.start, end: slot.end,
        instrument: group.instrument || "Group",  duringSpecialist: false
      };
      setTimetable(prev => ({ ...prev, lessons: [...prev.lessons, lesson] }));
      setGroups(prev => prev.map(g => g.id === groupId ? { ...g, status: "scheduled" } : g));
      notify(`Group "${group.name}" manually added on ${manualDay} at ${manualTime}`);
      return { success: true };
    }

    // Build school/teacher break checker
    const schoolBreaks = (school.teacherBreaks || []).map(b => ({ start: timeToMin(b.start), end: timeToMin(b.end), day: b.day || "All" }));
    const tBreaks = (teacher.teacherBreaks || []).filter(b => b.schoolId === school.id);
    const isDuringBreak = (day, slotStart, slotEnd) => {
      const sMid = (timeToMin(slotStart) + timeToMin(slotEnd)) / 2;
      if (schoolBreaks.some(b => (b.day === "All" || b.day === day) && sMid >= b.start && sMid < b.end)) return true;
      return tBreaks.some(b => {
        const bDay = b.day || "All";
        if (bDay !== "All" && bDay !== day) return false;
        return sMid >= timeToMin(b.start) && sMid < timeToMin(b.end);
      });
    };

    // Try each day the teacher is available
    for (const day of school.days) {
      const dayAvail = teacherAvail.find(a => a.day === day);
      if (!dayAvail) continue;
      const availStart = timeToMin(dayAvail.start);
      const availEnd = timeToMin(dayAvail.end);

      // Get all teacher lessons on this day at this school
      const teacherDayLessons = timetable.lessons.filter(l => l.teacherId === teacher.id && l.day === day);

      // Try each class-time slot (not before/after school)
      for (const slot of classSlots) {
        const slotStart = timeToMin(slot.start);
        const slotEnd = timeToMin(slot.end);
        if (slotStart < availStart || slotEnd > availEnd) continue;
        if (isDuringBreak(day, slot.start, slot.end)) continue;

        // Check if teacher is free at this slot
        const teacherBusy = teacherDayLessons.find(l => l.start === slot.start);
        if (teacherBusy) {
          // Try to shuffle this lesson to another class-time slot on the same day
          // Don't move before/after school lessons or group lessons
          const busySlotType = school.slots.find(s => s.id === teacherBusy.slotId);
          if (busySlotType && beforeAfterTypes.includes(busySlotType.type)) continue;
          if (teacherBusy.isGroup) continue;

          // Find an alternative class-time slot on the same day for the displaced lesson
          let canShuffle = false;
          for (const altSlot of classSlots) {
            if (altSlot.start === slot.start) continue;
            const altStart = timeToMin(altSlot.start);
            const altEnd = timeToMin(altSlot.end);
            if (altStart < availStart || altEnd > availEnd) continue;
            if (isDuringBreak(day, altSlot.start, altSlot.end)) continue;
            // Check no other lesson by this teacher at the alt time
            if (teacherDayLessons.some(l => l.start === altSlot.start && l.id !== teacherBusy.id)) continue;
            // Check no other lesson for the displaced student at the alt time
            if (timetable.lessons.some(l => l.studentId === teacherBusy.studentId && l.day === day && l.start === altSlot.start && l.id !== teacherBusy.id)) continue;

            canShuffle = true;
            // Do the shuffle: move existing lesson, place group
            const groupLesson = {
              id: uid(), isGroup: true, groupId: group.id, groupName: group.name,
              studentId: group.studentIds[0], studentName: group.name,
              studentIds: [...group.studentIds],
              studentNames: group.studentIds.map(sid => students.find(s => s.id === sid)?.name || "?"),
              teacherId: teacher.id, teacherName: teacher.name,
              schoolId: school.id, schoolName: school.name,
              day, slotId: slot.id, slotName: slot.name,
              start: slot.start, end: slot.end,
              instrument: group.instrument || "Group",  duringSpecialist: false
            };
            setTimetable(prev => ({
              ...prev,
              lessons: [
                ...prev.lessons.map(l => l.id === teacherBusy.id ? { ...l, slotId: altSlot.id, slotName: altSlot.name, start: altSlot.start, end: altSlot.end } : l),
                groupLesson
              ]
            }));
            setGroups(prev => prev.map(g => g.id === groupId ? { ...g, status: "scheduled" } : g));
            notify(`Group "${group.name}" added on ${day} at ${slot.start} (${teacherBusy.studentName} moved to ${altSlot.start})`);
            return { success: true };
          }
          continue; // couldn't shuffle, try next slot
        }

        // Slot is free — place directly
        const groupLesson = {
          id: uid(), isGroup: true, groupId: group.id, groupName: group.name,
          studentId: group.studentIds[0], studentName: group.name,
          studentIds: [...group.studentIds],
          studentNames: group.studentIds.map(sid => students.find(s => s.id === sid)?.name || "?"),
          teacherId: teacher.id, teacherName: teacher.name,
          schoolId: school.id, schoolName: school.name,
          day, slotId: slot.id, slotName: slot.name,
          start: slot.start, end: slot.end,
          instrument: group.instrument || "Group",  duringSpecialist: false
        };
        setTimetable(prev => ({ ...prev, lessons: [...prev.lessons, groupLesson] }));
        setGroups(prev => prev.map(g => g.id === groupId ? { ...g, status: "scheduled" } : g));
        notify(`Group "${group.name}" added on ${day} at ${slot.start}`);
        return { success: true };
      }
    }

    return { success: false, reason: "No available slot — all class-time slots are occupied" };
  };

  // Incremental scheduling: add pending students + ready groups without disturbing existing lessons
  const handleSchedulePending = (schoolIdOrStudentId = null, _schoolId, day, time, instrumentName) => {
    // When called from right-click with (studentId, schoolId, day, time, instrument) — place directly
    if (day && time) {
      const studentId = schoolIdOrStudentId;
      const student = students.find(s => s.id === studentId);
      if (!student) { notify("Student not found", "warning"); return; }
      const school = schools.find(s => s.id === student.schoolId);
      if (!school) { notify("School not found", "warning"); return; }
      const slot = school.slots.find(s => s.start === time);
      if (!slot) { notify("Invalid time slot", "warning"); return; }
      const inst = instrumentName
        ? (student.instruments || []).find(i => i.name === instrumentName) || student.instruments[0]
        : student.instruments[0];
      if (!inst) { notify("Student has no instruments", "warning"); return; }
      let teacher = null;
      if (inst.teacherId) teacher = teachers.find(t => t.id === inst.teacherId);
      if (!teacher) teacher = teachers.find(t =>
        t.instruments.some(ti => ti.name === inst.name) &&
        t.availability.some(a => a.schoolId === school.id && a.day === day)
      );
      if (!teacher) { notify("No compatible teacher available for " + inst.name, "warning"); return; }
      const lesson = {
        id: uid(),
        studentId: student.id, studentName: student.name,
        teacherId: teacher.id, teacherName: teacher.name,
        schoolId: school.id, schoolName: school.name,
        day, slotId: slot.id, slotName: slot.name,
        start: slot.start, end: slot.end,
        instrument: inst.name,
        duringSpecialist: false
      };
      if (!timetable) {
        setTimetable({ lessons: [lesson], unscheduled: [] });
      } else {
        setTimetable(prev => ({ ...prev, lessons: [...prev.lessons, lesson] }));
      }
      // Keep student as pending — they are scheduled but still on the waiting list until explicitly activated
      notify(student.name + " (" + inst.name + ") placed on " + day + " at " + to12h(time));
      return;
    }
    const schoolId = schoolIdOrStudentId;
    const existingLessons = timetable ? [...timetable.lessons] : [];
    const existingUnscheduled = timetable ? [...timetable.unscheduled] : [];

    let pendingToSchedule = students.filter(s => s.status === "pending" || s.status === "trial");
    if (schoolId) pendingToSchedule = pendingToSchedule.filter(s => s.schoolId === schoolId);

    if (pendingToSchedule.length === 0) {
      notify("No pending students to schedule", "warning");
      return;
    }

    const tempStudents = pendingToSchedule.map(s => ({ ...s, status: "active" }));
    const result = generateMasterTimetable(
      schools, tempStudents, teachers, specialists,
      { existingLessons, targetSchoolId: schoolId || null }
    );
    const newLessons = result.lessons.filter(l => !existingLessons.some(el => el.id === l.id));
    const newUnscheduled = result.unscheduled;
    const scheduledStudentIds = new Set(newLessons.map(l => l.studentId));

    if (scheduledStudentIds.size > 0) {
      setStudents(prev => prev.map(s =>
        scheduledStudentIds.has(s.id) ? { ...s, status: "active" } : s
      ));
    }

    const mergedLessons = [...existingLessons, ...newLessons];
    const keptUnscheduled = schoolId
      ? existingUnscheduled.filter(u => u.student.schoolId !== schoolId)
      : [];
    const mergedResult = {
      lessons: mergedLessons,
      unscheduled: [...keptUnscheduled, ...newUnscheduled]
    };
    compactTimetable(mergedResult, schools, students, teachers, specialists);
    setTimetable(mergedResult);

    const sched = newLessons.length;
    const unsched = newUnscheduled.length;
    if (sched > 0 && unsched > 0) {
      notify(`Scheduled ${sched} lesson${sched !== 1 ? "s" : ""}. Could not fit: ${unsched} student${unsched !== 1 ? "s" : ""}.`);
    } else if (sched > 0) {
      notify(`Scheduled ${sched} lesson${sched !== 1 ? "s" : ""} into existing timetable!`);
    } else {
      notify(`Could not fit any pending students.`, "warning");
    }
  };

  // Manual scheduling: place a pending/trial student at a specific day/time
  const handleManualSchedule = (studentId, day, time, target) => {
    const student = students.find(s => s.id === studentId);
    if (!student) { notify("Student not found", "warning"); return; }
    const school = schools.find(s => s.id === student.schoolId);
    if (!school) { notify("School not found", "warning"); return; }
    const slot = school.slots.find(s => s.start === time);
    if (!slot) { notify("Invalid time slot", "warning"); return; }

    // Find a compatible teacher
    const inst = student.instruments[0];
    if (!inst) { notify("Student has no instruments", "warning"); return; }
    let teacher = null;
    if (inst && inst.teacherId) {
      teacher = teachers.find(t => t.id === inst.teacherId);
    }
    if (!teacher) {
      teacher = teachers.find(t =>
        t.instruments.some(ti => ti.name === inst.name) &&
        t.availability.some(a => a.schoolId === school.id && a.day === day)
      );
    }
    if (!teacher) { notify("No compatible teacher available", "warning"); return; }

    const lesson = {
      id: uid(),
      studentId: student.id, studentName: student.name,
      teacherId: teacher.id, teacherName: teacher.name,
      schoolId: school.id, schoolName: school.name,
      day, slotId: slot.id, slotName: slot.name,
      start: slot.start, end: slot.end,
      instrument: inst.name,
      duringSpecialist: false
    };

    if (target === "master") {
      if (!timetable) {
        setTimetable({ lessons: [lesson], unscheduled: [] });
      } else {
        setTimetable(prev => ({ ...prev, lessons: [...prev.lessons, lesson] }));
      }
      notify(`${student.name} manually added to Master Timetable on ${day} at ${time}`);
    } else if (target === "weekly") {
      // Find current week key
      const monday = getCurrentWeekMonday();
      const weekKey = toLocalDateStr(monday);
      const storageKey = `${weekKey}|${student.schoolId}`;
      const dayDate = DAYS.map((d, di) => {
        const date = new Date(monday);
        date.setDate(monday.getDate() + di);
        return { day: d, date: toLocalDateStr(date) };
      });
      const weekDate = dayDate.find(wd => wd.day === day)?.date;

      setWeeklyTimetables(prev => {
        const entry = prev[storageKey] || { lessons: [], missed: [], notes: "", generatedAt: new Date().toISOString() };
        return {
          ...prev,
          [storageKey]: {
            ...entry,
            lessons: [...entry.lessons, { ...lesson, weekDate, adjusted: true, adjustReason: "Manually added" }]
          }
        };
      });
      notify(`${student.name} manually added to this week's timetable on ${day} at ${time}`);
    }
  };

  const [showExportDialog, setShowExportDialog] = useState(null);

  // ── Global keyboard shortcuts ──────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      // Escape: close any open modal/overlay
      if (e.key === "Escape") {
        if (showExportDialog) { setShowExportDialog(null); return; }
      }
      // Arrow keys: left/right = history navigation, up/down = scroll hovered list
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        if (e.key === "ArrowLeft" && historyCursor > 0) { e.preventDefault(); goBack(); }
        if (e.key === "ArrowRight" && historyCursor < pageHistory.length - 1) { e.preventDefault(); goForward(); }
        if ((e.key === "ArrowUp" || e.key === "ArrowDown") && hoveredScrollRef.current) {
          e.preventDefault();
          // If the email nav callback is set and the email list is hovered, navigate items
          if (emailNavRef.current?.navigate && hoveredScrollRef.current === emailListRef.current) {
            emailNavRef.current.navigate(e.key === "ArrowDown" ? 1 : -1);
          } else {
            hoveredScrollRef.current.scrollBy({ top: e.key === "ArrowDown" ? 60 : -60, behavior: "smooth" });
          }
        }
        return;
      }
      // Cmd+Z / Ctrl+Z: undo for timetable (lessons or breaks) or weekly
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        if (page === "timetable" && ttPageUndoCount() > 0) {
          e.preventDefault(); undoTimetablePage();
        } else if (page === "weekly" && weeklyUndoStack.current.length > 0) {
          e.preventDefault(); undoWeekly();
        } else if (page === "dashboard" && todoUndoRef.current) {
          e.preventDefault(); todoUndoRef.current();
        }
        return;
      }
      // Cmd+Shift+Z / Ctrl+Y: redo
      if (((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "z") || ((e.ctrlKey) && e.key === "y")) {
        if (page === "timetable" && ttPageRedoCount() > 0) {
          e.preventDefault(); redoTimetablePage();
        } else if (page === "weekly" && weeklyRedoStack.current.length > 0) {
          e.preventDefault(); redoWeekly();
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [page, showExportDialog, historyCursor, pageHistory]);


  const handleExport = (callerWeeklyData = null, callerWeekLabel = "", initialType = null) => {
    if (!timetable && !callerWeeklyData && initialType !== "tally") { notify("No timetable to export", "warning"); return; }
    // Build list of all weeks that have a generated timetable, sorted chronologically
    const termBreaksForLabel = interruptions.filter(i => i.type === "term_break");
    const weekKeys = [...new Set(Object.keys(weeklyTimetables).map(k => k.split("|")[0]))].sort();
    const availableWeeks = weekKeys.map(wKey => {
      const allLessons = [], allMissed = [];
      for (const s of schools) {
        const wd = weeklyTimetables[`${wKey}|${s.id}`];
        if (wd) { allLessons.push(...wd.lessons); allMissed.push(...(wd.missed || [])); }
      }
      return allLessons.length > 0
        ? { weekKey: wKey, weekLabel: getTermWeekLabel(wKey, termBreaksForLabel), lessons: allLessons, missed: allMissed }
        : null;
    }).filter(Boolean);
    setShowExportDialog({ availableWeeks, initialType });
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: colors.bg, fontFamily: "'DM Sans', sans-serif" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 32, color: colors.accent, marginBottom: 12 }}>♪</div>
          <div style={{ color: colors.textLight }}>Loading your timetable...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "'DM Sans', sans-serif", background: colors.bg, color: colors.text, overflow: "hidden" }}>
      {composeEmail && (
        <ComposeModal
          key={composeEmail._queueKey || composeEmail.to?.join(',') || 'compose'}
          initial={composeEmail}
          schools={schools}
          students={students}
          teachers={teachers}
          contacts={contacts}
          queueRemaining={composeQueue.length}
          onClose={() => {
            if (composeQueue.length > 0) {
              const [next, ...rest] = composeQueue;
              setComposeEmail(next);
              setComposeQueue(rest);
            } else {
              setComposeEmail(null);
            }
          }}
          onCancelAll={() => { setComposeEmail(null); setComposeQueue([]); }}
          notify={notify}
        />
      )}
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet" />
      <style>{`
        @media print {
          /* Hide chrome: sidebar, notifications, buttons, modals, export dialogs */
          nav, button, [data-noprint], .no-print { display: none !important; }
          /* Fill the page */
          body, html { background: white !important; }
          /* Remove fixed/sticky positioning so content flows */
          * { position: static !important; box-shadow: none !important; }
          /* Main content area fills full width */
          [data-printarea] { width: 100% !important; max-width: 100% !important; overflow: visible !important; }
          /* Keep timetable grid readable */
          table { page-break-inside: auto; font-size: 11px; }
          tr { page-break-inside: avoid; }
          thead { display: table-header-group; }
          /* Lesson cards */
          [data-lessoncard] { break-inside: avoid; border: 1px solid #ccc !important; }
          /* Force background colours to print */
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          /* Page margins */
          @page { margin: 15mm; }
        }
        * { outline: none !important; }
      `}</style>

      {/* Sidebar */}
      <div className="no-print" ref={sidebarRefCb} style={{ width: 240, background: colors.sidebar, display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box", height: HEADER_HEIGHT, flexShrink: 0, WebkitAppRegion: "drag" }}>
          <div style={{ background: "#344565", borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", boxSizing: "border-box" }}>
            <img src={"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAL4AAAA6CAYAAAAOVeNTAAATHUlEQVR4nO2deZRfRZXHP7eXpJOQFQiExUAyCQFkOwkRBhFxQBYHZhzCFhVmZMKBERxgxgHOyBCUddDhAIOsAyObDNuogIAKsglBUBCQVZLgBBKDbAmQtfs7f9xb/avfy/t12pCmpft9z+nTv1evllv1bt26davqFlSoUKFChf4B620CKvxpQVInT5iZepOWnkTF+P0cOaND32b2HBXj92ME0yceaDKzlRF2ItACnAE0AR0pTX/pGBX6KCRZ+svCpki6Q9JcSbMltTaK+1FHU28TUKHX0STpHEnfAIYD+wK3APOAnSSNAtoqSV+hTyAkeFP8PSKpXdIekl6VtLek6yTNkzRH0l9H/ObeprtChQ+EYOSW+P13khYGwz8XzL5UNVwY8SrGr/DRR8b4O0paIOn3klaqHu9FZxgVcfuMnl+hH0JSU/zfQNKvJHUUGP4qSd+T9JCk1yXNiPh9QupXk9v+izRZbQE2pmbW/AWwALgI+AbwG+BpYMcPm8CeREtvE1Ch1/EmMBe4FrfXLwW2AA4ETgIuASYAQyJ+n7DuVIzfzxAqjnAzpgHLgAeBm4FncMn+C2DTMGE+IekZoBnAzDpKM/6IoWL8/gcjVmlTgKQBwK5mNkvSAzhfNGcruyvNbEXvkNszqBi/nyBNZs2sPZ4HA38O7A0cDNyaMfryPClgkqyvSHuoGL9PIjM5JkZWYlpJmwAH4Mw+BWiNuBuYmSR16vDZaq36mhmzYvxeRiZljZg4riXJ2gx0ZBJ+K+BQYDowLov3FvAUcEciKWiom8RWWxYqrDUk9aMsfE0kbNqGkD03S/q0pCskzS/Y6Z+QdJqknULtSeVWJu4KPYPCdgGTNFXS30qaLmlihDcF4zbsAKrtt+nML8IHStpP0i2x8prwrqTbopz1i3n1VH0rVADqtgpMkG8Geydjzt9JOl5SS1GCl+RjKV48ryPpIEk/Uf3Wg/mSLpW0u6S2LH3apFYxfX+FanvOm3KG0Freh67aVoEpkp5VY3wt4rWUMX/OsJIGSTpE0n2FPObItxxvU0hXmmeFfoCMuZu7wwQRr0WrUT+6SN8pvSWNKzD9jyUdKWmapIvkOyPflbRzxG/NOmGzYr9M/N4v0ud7bZ6XdIqkccXy13ZHrvARgzKdOJ4HSRojabykLSV9XK6KjJYv8ORx/2jmzxivVdKNwaDLJJ0qaVAh7hfkqsrtkgYkZle9Hr9L5LO8wPAnSdo0i1dNWCs4Msk7UNJfSrow1ITZkl6T701/Xa4bvyjpR5LOkLS/pA3yfLrbATIpfXAw9QpJJ2b5tESnSPr/acHMn4/nFL65pPNVPy94NTpQzvBrPDpV6GMIBksMOFnSD7Xq/vPV4WlJMyWNz/JNTNbIPJmk/bryLcCSdE1KkzOnaurIMLk69IykIRE+Q9LLGS1LJV0mt9Hn6VPHrpi+v0P1k9WvaFW79uvyI3jXSvqOfBS4RG4SnCU/hpfjRUknSlovy7/TwpKVm5suT460CxUTzrLOkjHujIh/TtCU40lJh2Z5V9K9Qj1Us360STqvwEBPSDpO0jaShpWkbZE0QtIkSYfJJfXCLP0suQlxcF6eapPn5Klg1+hcknRqhJUya5Z+ROSfY4WkKyWNjbirtfdX6IfIpOc6kq7OGOgNSf+qkoUcdWH9iPDtJZ2l+lHgPklHKdOzszTbyY/vJUm9QZTRcMtIRvf+qk1gn5XPEXKrTurUFeNXcGRMPDQkdcKjknbN4jVcyJHq7Pt1klXSVpL+M5PkkvSSfLFouqR9JP2LfNIsuYly30jbnVXZZEI9vZLyFbqNTGqenzHmHaodnG7pSuoW8rLsr2hanCTpgkIHKMOxWbldMq3qR57i/pvKHl9hVeTMIl/gSa4yHpI0JsLzpf41XZAqjgDbyheOHpa0OGP41+QT4RapbsW1O8yf/3U7bYV+iIw5RqlmPpwtaVKErzVPATljZmHDJH1C0uHxt2WEl1p+KlRYK1Bt8ndEMP0SSdMirKXIqB+wrKIKtEqnkluT2opp1kb5FdYMfe4gSoGhPoMfrLgNP1rXBLTD2jtYEaeWLPJrT1I9PA/vBHwFmAi8L+lJ4H+Bh8ysI0tXocIHQ6bmDFTNBr5XhPW4M6RstDlI9fb+hPflq62jVe2jqbC2kDF+m6TfyPe3D/8w1AvVrC2T5C758snty4WOcFZK05M0VShHn1N1wJnfzJZKWgi8b2bvqOZPpidhocJ8CdgA91lzNnAl7rlgGDAZ+CawVcNcKlRYE6i2f2WmpMdVMAX2UJn5oZBHQ6qf0SDu1pL2+jBUrwr9CKrZ8LeQbzwbm4f3UJmJ8TcKlWa+pA2j07Wqtqe+NUtTHfvrJfRJ/TKzmLyAOzz9mw+x+HdxFeceM1tAeCLD/VJ2ACvTpNbMOiqrTu+gTzJ+IEnSi/ErbdZLHaJHCnOzZpOZLcJ9Ub4aZZmZqfDX0Ze8klX4E0OmfuytODjSw3p+UrH2kHR4T5dXYc1RthuxidoVjyqJm6wjHfDheNgKmlL5HWnRKKOr812Rpt5YJIpJa4uZLWvwPm/3Zhq0Z+RjQHtvqUSFdm5kGUtuCtt7o73XBKucFioyTSGu0vtsGO/I43aRvvtEdaPhUvkRf3U0lDo8LaOvrOyyfMvy6O4HTx05ufdLYTmNjRioLLxRWBlNXcVtFJ8G7VdCWzPU/HSWlZl+d8Ub+fs1oLVbdbZiImASsA3wS2B2FkfAUODTuE36Z8CKntRVs0aaAGyPT1RfKDTc4KCpA7gfWBLhVmSkYliDMpu6W6eyuGm9oKtOkK0prA98Evg9MIsYzSJOMzAV2ATf4jC/uzQVy29Up7I2SepaQZg0445mh1HzpLw4ngEGAAuBH/SUtC/SlYV12dbdyTgttR8dNujT47nztL58260kPZCFp0MRLSksS7du2LXb5G4y0u/R8lNIbRGWvxulcOeR5XVolHt5Cs9omhjvXpA0PE8Xv0dLWrfYgHIT44CMhuLRwfSXTJGtqj+321Qoo9su+bJ6bRW0P6dwMZLR1yLpl/F+2whrk2/F6FyFjngD07fIyli/hKZU5+J26la56XVooQ1SfVslnSv3NnGDpJ8HXffG813y7ditQWN+MizRl/hlYNAwUtLgaPuUrk2+yj4ko7XY1sPkJuOWElpzVyyJ9ubIt9NlI5Sv3L6J9+ppki4A/gA0h/52KC5ZX41NWEk/FX5lzMdwb7xvASOAq4AVuMQYDbyBm/s+huuLc4FBuOR7E7+GZihwJPAKtdFmUdC0p6TNI11r0DQtaJoPLImKdUg6AviroK1V0nLgUjO7M+J8Er+yfmGiUdIQ4Cbgv6jNc4YDN+C3hZxApl5JOgA4PMpA0vvAw8D1wJsqGdYL0mkxfpHyJGAf4Nb4JsvxDXbbRFsuivinxP+vB33tkfY4YKaZzZO0T7TfQGCFpKXAY8ClwHbA14DjzGxO1Pcfoy2W47ekzANujHqsoObF+eR0mYSk7YF7gcPMbF6ENQHHAFvH/ySZRwOnA/8ebX0lfr/WZ6N+i4ExwHs4f2wC/DOwFzDAzE7x7LVNhK8X9W6T9BDwbTN7L+pyCb5ifjDwdrT9UOA84ALgidRuZYw/Er8KpgU4xsz+TRJyFxZ7AnfhzAk1xtwIv2RgIrBDNMqyKPAdYHxU+Cj8MrENg4AFUdHrga8GYSPxjw21idSwePc+cIKZHSt3CzIO+Dx+jc14wnQo3wdzEHBypGsF9gAulzTTzK6IhpqEbx94PcrZJj7QXNwOL0nbRZ0mAP8BzAum3xP4FnAabr4E2Bm/aOHWrvTUDG34x/418E+Sbsd3eLbizHw3zkjJ4dQEYmjPOlNHtPvbkqbiDH4mcE+8mwxMA74bbb4TsDTKuAZnlJnAb/FOfiBwBPBIVk5yNT4AX5NYJ32XYPiBZrZE7nNoSzNbEUKxHRdmE+NbLsY7XytwdZS3Eu/w1wLX4bz0HC5klkW5U/Hb1q8Hvo13knHAqcAUSQfiKu5YvBMfaWZnh5R/Dxe0CfUjsepVnTslfU7uqGijCP+u/HzpyZLujbDkQeC0CD9N0p0Rlg9Pm8hVkc0pQK7avKzMN0wJTdMl/UzSbvK7WJNH4YuCrhmSnouwreUbxKaU5PdFSXNjeP2M/PB2WyHOHGVXW8qvvDxAfmTxzCzeCXLPZQOK5aT6q6YmDI7nQar37TM+2mVPubqTTKAHyv337Bt12SLC/1vSlYW23yJoa5X05Yg/vAFNu0n6bdBxgHwD39CSeMNUUx9y9S7RvbOktzK6kvr1dUk/Kny7EcFPfyZXd56UtHuhvEckHVIIu0bSRfH7LkmXldA5KL7XYfH8fbkrxrmSvhphAyL84zldZQtYK4ERZnYHPgwfGcz/OVzC5R96pVyP3AW4DDgHmChpx5CKbdEBBke65Bgpd8A0BB9dOt+V0NQBDDOz+/EJ7j/I/dlMC5qgprbtArxiZo+rdtQvnZH9ScTbAle5xgPXye90vVnST/HR7gdySbcLLs1uAc4HDohywdWBV4BZku6RdH984COjrGRJ2Aj4Ia46nIRLvtxgMBAfYa4AjpfPNY7HJeDv4n0aMZJJMUcy9Q6Jch4DHgya7pV7Tj5ONStYUk8/ATxsZotVmyO0yM8SLMry71x4y+jofJe+TzaqFQ/BJ5Nsit+CXy2U+KAF540kFNoifW46HQdcHfGTHt9mZktwI8tOEW8IPvoeCMyUNN3MllPPs4LGuzNT456BD/07AHeb2Vy5itB5a4Z8mNkZH/Lb8Q99LHAYbn/ukJQ3UEc8piG7o+RdGVLjnYnrcpsDj5rZ05L2oKZTLgBGShpoZssyJlwRkrAFVy/GAm/jzLIAZ8r1cXUu1W0GMFnSecAofMg+GLgodNu95BPPTfHhe3N8N+YbZnZLdOx3caYWrlIlnTlBuOpwOa5iXBXPF+OqWL6e0gQsD8ZojrZbEe8HmNlCYL+QbmPxTrMhrs4twNWZVP5CXD0FF3ZNZDeoJDWnmxaT3NbfHmmb4lum7Rp1G/IK31qEGVRSWqdJ9QWff4w1s4ckDUzlxLuNgMezfNYzswclfQG4QdI7uLpdV36ZxE+NCXA78CqwP3COavpeMnUNxvfBnIXr0k/jetcekra02k15aZ9Ko0ase6dVLSJpj4vhPfz5oOncCBM+kTNct10S75rMbGUw/Tr4nGOWmf0fPgr9Afiemd2Nm+sM+GI0/La4pDkbeAGft1wCHB3D+v6SvmxmT5nZHWb2fTM7L/Ick7Xvm2Z2g5n9j5ndW9IG7bjxYBHO/AcB18TzgLy98Q+4WUjgpcGkm+BzgLcl/YWkY8zsmaDpVjP7Dj7x3xj/ru343OImYIKko82s3cxWhLFgslyFHGmrbvHI5xVl3/MdvMOR8sMFxsh4V8c/1Dphnlcqoz37fT1whqTxZrYs+6ZfwoXytUHncnz+0mRmdwIzcEPFDvj8ojP/RpPbETGULA1p95KZPQUQDLR+SLMZuCpwep6B3LJwuqSDwxIwFLfy5PpkqvRgfJIztBCeY0TQNcTM3pV0IS49ZwWTpvRDzWxR9PbLgHvkx/1a8YvOXgeOjjzXiTzHSJpnZm9KOjfovg+fXP3KzC7O6nUzMAefiM8GjooR70WcyScDz+LqU530i3oVV50H4xP3dSLsRlwFSTcQDop6JZ39cvwj3453xoER/0ozWy7X16dL2h94CWeeycBr+EgyJeq9rpnNlvT3wLfkvn6eB9bFJ58/xSfZRYmf6E7tnez4qU43AYfI54BP4Pw1FfixmS2QtGG0+YiUDu+EI7I65gaNJKXPDdpuk/QwNYPJJOAoM3te7gVvFDA8OuxAM7sxRr9Toq0667CKrTkk3cbAffiMvIWaia0DvwB4vWicyUHcLGqjRwduHdkYl75LccvBVOAxM5tfkCKjcF3612b2irJFCdXMgZOiovfjlp3m+FseDbVDlPEAfvBE8snfZ4HNopznQuKmEWVz/DDIQ9Sk0RDgUzjTbIovLD1PrTM24epBh5k9EGXsjo8MzXgHuCcavuFCWKpj0LwjziSvxus2YHlI349FGz8KzI96jYl6DcPViMfN7LFUnnzythtuAWrF5yF3R8cYh1uJfo6b+zrkc7R9Ir/FwANmNidrp06rVPY9NgO2xVWM+dE+FjQPB/alZnZ81szui7yGA7sCz5ibU5vwzv0pfD7zbLSBRbwVwCPUDvhsh3f0VlxNvcvM3og6t+EWneeDj1pwXtwg0syK79lk2Yp52cepc5uhVb36NvrdVMynqzLKnleXpvC3Snlq4CRKDTyQpXzKyi22QRZeeoikq7zK8uyiXsX3Dc/nqrZg09W1QX9MO3Xp07MB3V3R17C+DfKyQlinJaw7tHbFG+l3aeUoWe7Pen3n0nH+u5BH2bJ3mjyV7a8ofVeMY/V7W0ppKqGj06JQrFNZntSku0WaIr15/VP80jK6g/igHUWpmtNYfE/93KysXnU0pXp0Uec8v9WeEejm92xEX3MxXT7KF8LKtijkPNudfFbLXxUq9Bv8P5yMG5b5h35SAAAAAElFTkSuQmCC"} alt="Matt Moras - Music Tuition" style={{ width: "100%", maxWidth: 180, height: "auto", display: "block" }} />
          </div>
        </div>
        <nav style={{ flex: 1, padding: "12px 8px" }}>
          {[
            { id: "dashboard", icon: "📅", label: "Dashboard" },
            { id: "timetable", icon: "📅", label: "Master Timetable" },
            { id: "weekly", icon: "📋", label: "Weekly Adjustments" },
            { id: "tally", icon: "✓", label: "Master Tally" },
            { id: "students", icon: "👨‍🎓", label: "Students" },
            { id: "groups", icon: "👥", label: "Groups" },
            { id: "pending", icon: "⏳", label: "Waiting List" },
            { id: "bands", icon: "🎸", label: "Bands" },
            { id: "specialists", icon: "🎨", label: "Specialist Classes" },
            { id: "calendar", icon: "📅", label: "Calendar" },
            { id: "schools", icon: "🏫", label: "Schools" },
            { id: "teachers", icon: "🎵", label: "Teachers" },
            { id: "contacts", icon: "📇", label: "Contacts" },
            { id: "resources", icon: "📚", label: "Resources" },
            { id: "settings", icon: "⚙", label: "Settings" },
          ].map(item => (
            <button
              key={item.id}
              onClick={() => {
                if (item.id === "groups" && page === "groups") {
                  setGroupsViewState(prev => ({ ...prev, resetSignal: ((prev.resetSignal || 0) + 1) }));
                } else {
                  setPage(item.id);
                }
              }}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                height: 34, padding: "0 16px", border: "2px solid transparent", borderRadius: 8, cursor: "pointer",
                background: page === item.id ? colors.sidebarActive : "transparent",
                color: page === item.id ? colors.white : "rgba(255,255,255,0.6)",
                fontSize: 13, fontFamily: "inherit", textAlign: "left", marginBottom: 2,
                fontWeight: 500, boxSizing: "border-box",
                transition: "all 0.15s"
              }}
              onMouseEnter={e => { if (page !== item.id) e.currentTarget.style.background = colors.sidebarHover; }}
              onMouseLeave={e => { if (page !== item.id) e.currentTarget.style.background = "transparent"; }}
            >
              {item.id === "tally" ? (
                <span style={{ fontSize: 16, width: 22, flexShrink: 0 }}>
                  <span style={{ width: 16, height: 16, borderRadius: 3, background: "#F8EFED", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 11, fontWeight: 900, color: "#16A34A", lineHeight: 1 }}>✓</span>
                  </span>
                </span>
              ) : (
                <span style={{ fontSize: 16, width: 22 }}>{item.icon}</span>
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{item.label}</span>
              {item.id === "pending" && pendingStudents.length > 0 && (
                <span style={{ marginLeft: "auto", background: colors.accent, color: colors.white, fontSize: 11, fontWeight: 700, borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {pendingStudents.length}
                </span>
              )}
              {item.id === "timetable" && ttWarningCount > 0 && (
                <span style={{ marginLeft: "auto", background: colors.accent, color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {ttWarningCount}
                </span>
              )}
              {item.id === "weekly" && weeklyWarningCount > 0 && (
                <span style={{ marginLeft: "auto", background: colors.accent, color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {weeklyWarningCount}
                </span>
              )}
              {item.id === "contacts" && (
                <span
                  title="Compose email"
                  onClick={e => { e.stopPropagation(); if (window._openComposeModal) window._openComposeModal({ to: [], from: "", subject: "", body: "", triggerId: "sidebar_compose", mergeCtx: null, attachments: null }); }}
                  style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 5, background: colors.sidebarActive, cursor: "pointer", flexShrink: 0, border: "1.5px solid rgba(255,255,255,0.18)" }}
                  onMouseEnter={e => { e.currentTarget.style.background = colors.accent; }}
                  onMouseLeave={e => { e.currentTarget.style.background = colors.sidebarActive; }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.white} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                </span>
              )}
              {item.id === "groups" && (() => {
                const groupStudents = activeStudents.filter(s => s.instruments.some(i => i.isGroup));
                const assignedIds = new Set(groups.flatMap(g => g.studentIds || []));
                const unassigned = groupStudents.filter(s => !assignedIds.has(s.id)).length;
                return unassigned > 0 ? (
                  <span style={{ marginLeft: "auto", background: colors.accent, color: colors.white, fontSize: 11, fontWeight: 700, borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    {unassigned}
                  </span>
                ) : null;
              })()}
            </button>
          ))}
        </nav>
        <div style={{ padding: "16px 12px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          {/* ── Claude Panel ─────────────────────────────────── */}
          {(() => {
              const sendMessage = () => {
              const text = claudeInput.trim();
              if ((!text && !claudeAttachment) || claudeLoading) return;
              let userContent;
              if (claudeAttachment) {
                const filePart = claudeAttachment.kind === "image"
                  ? { type: "image", source: { type: "base64", media_type: claudeAttachment.mediaType, data: claudeAttachment.base64 } }
                  : { type: "document", source: { type: "base64", media_type: "application/pdf", data: claudeAttachment.base64 } };
                userContent = text ? [filePart, { type: "text", text }] : [filePart, { type: "text", text: "What can you tell me about this?" }];
              } else {
                userContent = text;
              }
              const displayText = text || (claudeAttachment ? `📎 ${claudeAttachment.filename}` : "");
              const userMsg = { role: "user", content: userContent, displayText };
              setClaudeMessages(prev => [...prev, userMsg]);
              setClaudeInput("");
              setClaudeAttachment(null);
              setClaudeLoading(true);
              const systemPrompt = buildClaudeSystemPrompt(page);
              const history = [...claudeMessages.map(m => ({ role: m.role, content: m.content })), { role: "user", content: userContent }];
              let isFirstChunk = true;
              anthropicStreamChat(
                "https://api.anthropic.com/v1/messages",
                {
                  method: "POST", headers: getAnthropicHeaders(),
                  body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4096, stream: true, system: systemPrompt, tools: [{ type: "web_search_20250305", name: "web_search" }], messages: history })
                },
                {
                  onChunk: (text) => {
                    if (isFirstChunk) {
                      isFirstChunk = false;
                      setClaudeLoading(false);
                      // Add the assistant message with the first chunk — dots disappear, text takes over
                      setClaudeMessages(prev => [...prev, { role: "assistant", content: text, streaming: true }]);
                    } else {
                      setClaudeMessages(prev => {
                        const last = prev[prev.length - 1];
                        if (!last || last.role !== "assistant") return prev;
                        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
                      });
                    }
                  },
                  onEnd: (usage) => {
                    if (usage) recordUsage("claude-sonnet-4-20250514", usage.input_tokens || 0, usage.output_tokens || 0);
                    setApiStatus("ok");
                    setClaudeLoading(false);
                    // Remove streaming flag so message is treated as complete
                    setClaudeMessages(prev => {
                      const last = prev[prev.length - 1];
                      if (!last || last.role !== "assistant") return prev;
                      const content = last.content || "Sorry, I couldn't get a response.";
                      return [...prev.slice(0, -1), { role: "assistant", content }];
                    });
                  },
                  onError: (message, isAuth) => {
                    setApiStatus(isAuth ? "error" : "ok");
                    setClaudeLoading(false);
                    setClaudeMessages(prev => {
                      const last = prev[prev.length - 1];
                      if (last?.role === "assistant" && last.streaming) {
                        return [...prev.slice(0, -1), { role: "assistant", content: isAuth ? "API key error — check Settings." : `Something went wrong: ${message}` }];
                      }
                      return [...prev, { role: "assistant", content: isAuth ? "API key error — check Settings." : "Something went wrong. Check your API key in Settings." }];
                    });
                  },
                }
              );
            };
            const canSend = (claudeInput.trim() || claudeAttachment) && !claudeLoading;
            return (
              <>
                {/* Hidden file input */}
                <input
                  ref={claudeFileInputRef}
                  type="file"
                  accept="image/*,application/pdf"
                  style={{ display: "none" }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) readClaudeFile(f); e.target.value = ""; }}
                />
                <div style={{ marginBottom: 12 }}>
                  {/* Label */}
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 7 }}>
                    <span
                      title={!apiKey.trim() ? "No API key — add one in Settings" : ""}
                      onClick={!apiKey.trim() ? () => setPage("settings") : undefined}
                      style={{
                        fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                        cursor: !apiKey.trim() ? "pointer" : "default",
                        color: !apiKey.trim() ? "transparent" : colors.accent,
                        WebkitTextStroke: !apiKey.trim() ? "1px rgba(255,255,255,0.25)" : "0",
                      }}
                    >Claude</span>
                  </div>
                  {/* Button row */}
                  <div style={{ display: "flex", gap: 6 }}>
                    {/* Mic */}
                    <button
                      title="Speak to Claude"
                      style={{ flex: 1, height: 32, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 7, background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.7)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
                      onMouseEnter={e => { e.currentTarget.style.background = colors.sidebarActive; e.currentTarget.style.color = colors.white; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color = "rgba(255,255,255,0.7)"; }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="2" width="6" height="11" rx="3"/>
                        <path d="M5 10a7 7 0 0 0 14 0"/>
                        <line x1="12" y1="19" x2="12" y2="22"/>
                        <line x1="9" y1="22" x2="15" y2="22"/>
                      </svg>
                    </button>
                    {/* Text — toggles the floating chat panel */}
                    <button
                      title="Type to Claude"
                      onClick={() => { setClaudePanelOpen(o => !o); setTimeout(() => claudeInputRef.current?.focus(), 50); }}
                      style={{ flex: 1, height: 32, border: `1px solid ${claudePanelOpen ? colors.accent : "rgba(255,255,255,0.12)"}`, borderRadius: 7, background: claudePanelOpen ? colors.accent + "22" : "rgba(255,255,255,0.05)", color: claudePanelOpen ? colors.accent : "rgba(255,255,255,0.7)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
                      onMouseEnter={e => { if (!claudePanelOpen) { e.currentTarget.style.background = colors.sidebarActive; e.currentTarget.style.color = colors.white; } }}
                      onMouseLeave={e => { if (!claudePanelOpen) { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color = "rgba(255,255,255,0.7)"; } }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                      </svg>
                    </button>
                    {/* File / screenshot — click to browse, drag to drop */}
                    <button
                      title="Attach image or PDF"
                      onClick={() => claudeFileInputRef.current?.click()}
                      onDragEnter={e => { e.preventDefault(); setClaudeDragOver(true); }}
                      onDragOver={e => { e.preventDefault(); setClaudeDragOver(true); }}
                      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setClaudeDragOver(false); }}
                      onDrop={e => {
                        e.preventDefault(); setClaudeDragOver(false);
                        // Check for email attachment drag first
                        if (window._pendingAttachmentDrag) {
                          // Guard against double-fire (two overlapping drop targets)
                          if (window._claudeAttachFetching) return;
                          window._claudeAttachFetching = true;

                          const { att, messageId } = window._pendingAttachmentDrag;
                          window._pendingAttachmentDrag = null;
                          if (window.electronAPI?.gmailFetchAttachment) {
                            const mimeType = att.mimeType || "application/octet-stream";
                            const kind = mimeType.startsWith("image/") ? "image" : "pdf";
                            if (kind !== "image" && mimeType !== "application/pdf") {
                              notify("Claude can read images and PDFs only.", "warning");
                              window._claudeAttachFetching = false;
                              return;
                            }
                            window.electronAPI.gmailFetchAttachment(messageId, att.attachmentId)
                              .then(r => {
                                setClaudeDragOver(false);
                                if (r.ok) {
                                  setClaudeAttachment({ filename: att.filename, base64: r.base64, mediaType: mimeType, kind });
                                  setClaudePanelOpen(true);
                                } else {
                                  const retryMatch = (r.error || "").match(/Retry after ([^\s]+)/);
                                  if (retryMatch) {
                                    const retryTime = new Date(retryMatch[1]).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
                                    notify(`Gmail rate limit — try again after ${retryTime}`, "warning", 8000);
                                  } else {
                                    notify("Could not load attachment: " + r.error, "danger");
                                  }
                                }
                              })
                              .catch(err => { console.error("[Claude drop] fetch error", err); setClaudeDragOver(false); })
                              .finally(() => { window._claudeAttachFetching = false; });
                          } else {
                            window._claudeAttachFetching = false;
                          }
                          return;
                        }
                        const f = e.dataTransfer.files?.[0]; if (f) readClaudeFile(f);
                      }}
                      style={{ flex: 1, height: 32, border: `1px solid ${claudeDragOver ? colors.accent : "rgba(255,255,255,0.12)"}`, borderRadius: 7, background: claudeDragOver ? colors.accent + "33" : "rgba(255,255,255,0.05)", color: claudeDragOver ? colors.accent : "rgba(255,255,255,0.7)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
                      onMouseEnter={e => { if (!claudeAttachment && !claudeDragOver) { e.currentTarget.style.background = colors.sidebarActive; e.currentTarget.style.color = colors.white; } }}
                      onMouseLeave={e => { if (!claudeAttachment && !claudeDragOver) { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color = "rgba(255,255,255,0.7)"; } }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "none" }}>
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                      </svg>
                    </button>
                    {/* Newsletter scan — school picker */}
                    <div style={{ flex: 1, position: "relative" }}>
                      <button
                        title="Scan school newsletters"
                        onClick={() => setClaudeNewsletterOpen(o => !o)}
                        style={{ width: "100%", height: 32, border: `1px solid ${claudeNewsletterOpen ? colors.accent : "rgba(255,255,255,0.12)"}`, borderRadius: 7, background: claudeNewsletterOpen ? colors.accent + "22" : "rgba(255,255,255,0.05)", color: claudeNewsletterOpen ? colors.accent : "rgba(255,255,255,0.7)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
                        onMouseEnter={e => { if (!claudeNewsletterOpen) { e.currentTarget.style.background = colors.sidebarActive; e.currentTarget.style.color = colors.white; } }}
                        onMouseLeave={e => { if (!claudeNewsletterOpen) { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color = "rgba(255,255,255,0.7)"; } }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a4 4 0 0 1-4-4V6"/>
                          <path d="M2 13.5V18a2 2 0 0 0 4 0V2"/>
                          <line x1="8" y1="7" x2="16" y2="7"/>
                          <line x1="8" y1="11" x2="14" y2="11"/>
                        </svg>
                      </button>
                      {claudeNewsletterOpen && (
                        <div
                          onClick={e => e.stopPropagation()}
                          style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 0, background: colors.sidebar, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.2)", minWidth: 200, zIndex: 9995, overflow: "hidden" }}>
                          <div style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.08em", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                            Scan Newsletters
                          </div>
                          {/* All schools */}
                          <button
                            onClick={e => { e.stopPropagation(); setClaudeNewsletterOpen(false); forceNewsletterScan.current?.(); }}
                            style={{ width: "100%", padding: "9px 14px", background: "none", border: "none", color: colors.white, fontSize: 13, fontFamily: "inherit", textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                            onMouseEnter={e => e.currentTarget.style.background = colors.sidebarActive}
                            onMouseLeave={e => e.currentTarget.style.background = "none"}
                          >
                            <span style={{ fontSize: 14 }}>📰</span> All schools
                          </button>
                          <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }} />
                          {/* Per-school rows */}
                          {schools.map(s => {
                            const hasUrl = !!s.newsletterUrl;
                            return (
                              <button
                                key={s.id}
                                onClick={e => { e.stopPropagation(); if (!hasUrl) return; setClaudeNewsletterOpen(false); forceNewsletterScan.current?.([s.id]); }}
                                style={{ width: "100%", padding: "8px 14px", background: "none", border: "none", color: hasUrl ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.3)", fontSize: 12, fontFamily: "inherit", textAlign: "left", cursor: hasUrl ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                                onMouseEnter={e => { if (hasUrl) e.currentTarget.style.background = colors.sidebarActive; }}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}
                                title={hasUrl ? `Scan ${s.name}` : "No newsletter URL configured — add one in Schools settings"}
                              >
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                                {!hasUrl && <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", flexShrink: 0 }}>no URL</span>}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Token / budget bar */}
                  {(() => {
                    const monthKey = new Date().toISOString().slice(0, 7);
                    const monthSpend = (tokenUsage[monthKey]?.costUSD) || 0;
                    const pct = claudeBudget > 0 ? Math.min(1, monthSpend / claudeBudget) : 0;
                    const remaining = Math.max(0, claudeBudget - monthSpend);
                    const barColor = pct > 0.85 ? colors.danger : colors.accent;
                    const fmtCost = (c) => c < 0.005 ? "$0.00" : `$${c.toFixed(2)}`;
                    return (
                      <div style={{ marginTop: 8 }}>
                        {/* Bar */}
                        <div style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,0.1)", overflow: "hidden", marginBottom: 5 }}>
                          <div style={{ height: "100%", width: `${(1 - pct) * 100}%`, background: barColor, borderRadius: 2, transition: "width 0.4s ease, background 0.4s ease" }} />
                        </div>
                        {/* Labels */}
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span
                            title={`Session: ${fmtCost(sessionTokens.costUSD)} · Month: ${fmtCost(monthSpend)} of $${claudeBudget.toFixed(2)} budget`}
                            style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", cursor: "default", letterSpacing: "0.02em" }}
                          >
                            {fmtCost(remaining)} left
                          </span>
                          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", cursor: "default", letterSpacing: "0.02em" }}>
                            {new Date().toLocaleString("default", { month: "short" })}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
                {/* ── End Claude Panel ───────────────────────── */}

                {/* ── Claude floating chat panel ─────────────── */}
                {claudePanelOpen && (
                  <div style={{ position: "fixed", left: 248, bottom: 0, width: 340, height: 480, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: "12px 12px 0 0", boxShadow: "0 -4px 32px rgba(0,0,0,0.14)", display: "flex", flexDirection: "column", zIndex: 9990, overflow: "hidden" }}>
                    {/* Header */}
                    <div style={{ padding: "12px 16px", background: colors.sidebar, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, position: "relative" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: colors.accent, letterSpacing: "0.08em", textTransform: "uppercase" }}>Claude</span>
                        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>· {page}</span>
                        {claudeMemory.length > 0 && (
                          <span title={`${claudeMemory.length} remembered fact${claudeMemory.length !== 1 ? "s" : ""}`} style={{ fontSize: 10, color: colors.accent, opacity: 0.7 }}>
                            ✦{claudeMemory.length}
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {/* Remember button */}
                        <button
                          onClick={() => { setClaudeRememberOpen(o => !o); setClaudeRememberInput(""); }}
                          title="Remember something"
                          style={{ background: "none", border: "none", cursor: "pointer", color: claudeRememberOpen ? colors.accent : "rgba(255,255,255,0.35)", fontSize: 11, fontFamily: "inherit", padding: "0 2px" }}
                          onMouseEnter={e => { if (!claudeRememberOpen) e.currentTarget.style.color = colors.white; }}
                          onMouseLeave={e => { if (!claudeRememberOpen) e.currentTarget.style.color = "rgba(255,255,255,0.35)"; }}
                        >remember</button>
                        {claudeMessages.length > 0 && (
                          <button onClick={() => { setClaudeMessages([]); setClaudeAttachment(null); }}
                            title="Clear conversation"
                            style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.35)", fontSize: 11, fontFamily: "inherit", padding: "0 2px" }}
                            onMouseEnter={e => e.currentTarget.style.color = colors.white}
                            onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.35)"}
                          >clear</button>
                        )}
                        <button onClick={() => { setClaudePanelOpen(false); setClaudeRememberOpen(false); }}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.4)", fontSize: 18, lineHeight: 1, padding: "0 2px", fontFamily: "inherit" }}
                          onMouseEnter={e => e.currentTarget.style.color = colors.white}
                          onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.4)"}
                        >×</button>
                      </div>
                      {/* Remember popover */}
                      {claudeRememberOpen && (
                        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: colors.sidebar, borderTop: `1px solid rgba(255,255,255,0.08)`, padding: "10px 14px", zIndex: 1 }}>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>
                            Add a fact for Claude to remember across all sessions:
                          </div>
                          <div style={{ display: "flex", gap: 6 }}>
                            <input
                              autoFocus
                              value={claudeRememberInput}
                              onChange={e => setClaudeRememberInput(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === "Enter" && claudeRememberInput.trim()) {
                                  const updated = [...claudeMemory, claudeRememberInput.trim()];
                                  setClaudeMemory(updated);
                                  try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(err) {}
                                  setClaudeRememberInput("");
                                  setClaudeRememberOpen(false);
                                }
                                if (e.key === "Escape") setClaudeRememberOpen(false);
                              }}
                              placeholder="e.g. Jamie's mum prefers contact by text"
                              style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.08)", color: colors.white, fontSize: 12, fontFamily: "inherit", outline: "none" }}
                            />
                            <button
                              onClick={() => {
                                if (claudeRememberInput.trim()) {
                                  const updated = [...claudeMemory, claudeRememberInput.trim()];
                                  setClaudeMemory(updated);
                                  try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(err) {}
                                  setClaudeRememberInput("");
                                  setClaudeRememberOpen(false);
                                }
                              }}
                              style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: colors.accent, color: colors.white, fontSize: 12, fontFamily: "inherit", cursor: "pointer", flexShrink: 0 }}
                            >Save</button>
                          </div>
                          {/* Existing memories */}
                          {claudeMemory.length > 0 && (
                            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                              {claudeMemory.map((m, i) => (
                                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ flex: 1, fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.4 }}>✦ {m}</span>
                                  <button
                                    onClick={() => {
                                      const updated = claudeMemory.filter((_, idx) => idx !== i);
                                      setClaudeMemory(updated);
                                      try { localStorage.setItem(STORAGE_KEYS.claudeMemory, JSON.stringify(updated)); } catch(err) {}
                                    }}
                                    style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.3)", fontSize: 14, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
                                    onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                                    onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.3)"}
                                  >×</button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {/* Messages */}
                    <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                      {claudeMessages.length === 0 && !claudeAttachment && (
                        <div style={{ margin: "auto", textAlign: "center", color: colors.textMuted, fontSize: 13, lineHeight: 1.6, padding: "0 12px" }}>
                          <div style={{ fontSize: 22, marginBottom: 8 }}>✦</div>
                          Ask me anything about your schedule, students, or timetable. You can also drop in an image or PDF.
                        </div>
                      )}
                      {claudeMessages.map((m, i) => (
                        <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
                          <div style={{ maxWidth: "85%", padding: "8px 12px", borderRadius: m.role === "user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px", background: m.role === "user" ? colors.accent : colors.bg, color: m.role === "user" ? colors.white : colors.text, fontSize: 13, lineHeight: 1.55, border: m.role === "assistant" ? `1px solid ${colors.border}` : "none", whiteSpace: "pre-wrap" }}>
                            {typeof m.content === "string" && m.content.includes("__SCAN_REVIEW__")
                              ? <>
                                  {m.content.replace("__SCAN_REVIEW__", "").trimEnd()}
                                  <button
                                    onClick={() => { setPage("calendar"); setClaudePanelOpen(false); setClaudeNewsletterOpen(false); }}
                                    style={{ display: "block", marginTop: 10, padding: "6px 14px", background: colors.accent, color: colors.white, border: "none", borderRadius: 6, fontSize: 12, fontFamily: "inherit", cursor: "pointer", fontWeight: 600 }}
                                  >Review &amp; Import →</button>
                                </>
                              : (m.displayText || (typeof m.content === "string" ? m.content : ""))
                            }
                          </div>
                        </div>
                      ))}
                      {claudeLoading && (
                        <div style={{ display: "flex", alignItems: "flex-start" }}>
                          <div style={{ padding: "8px 14px", borderRadius: "12px 12px 12px 3px", background: colors.bg, border: `1px solid ${colors.border}`, fontSize: 18, letterSpacing: 3 }}>
                            <span style={{ animation: "mmm-flash 1s infinite" }}>···</span>
                          </div>
                        </div>
                      )}
                      <div ref={claudeMessagesEndRef} />
                    </div>
                    {/* Attachment preview */}
                    {claudeAttachment && (
                      <div style={{ padding: "8px 12px", borderTop: `1px solid ${colors.border}`, background: colors.accentLight, display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        {claudeAttachment.kind === "image"
                          ? <img src={`data:${claudeAttachment.mediaType};base64,${claudeAttachment.base64}`} alt="attachment" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 5, flexShrink: 0, border: `1px solid ${colors.border}` }} />
                          : <div style={{ width: 36, height: 36, borderRadius: 5, background: colors.accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            </div>
                        }
                        <span style={{ flex: 1, fontSize: 12, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{claudeAttachment.filename}</span>
                        <button onClick={() => setClaudeAttachment(null)} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
                          onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                          onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}
                        >×</button>
                      </div>
                    )}
                    {/* Input row */}
                    <div style={{ padding: "10px 12px", borderTop: `1px solid ${colors.border}`, display: "flex", gap: 8, flexShrink: 0, background: colors.white }}>
                      <textarea
                        ref={claudeInputRef}
                        value={claudeInput}
                        onChange={e => setClaudeInput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                        onPaste={e => {
                          const items = e.clipboardData?.items;
                          if (!items) return;
                          for (const item of items) {
                            if (item.type.startsWith("image/")) {
                              e.preventDefault();
                              const file = item.getAsFile();
                              if (file) readClaudeFile(file);
                              return;
                            }
                          }
                        }}
                        placeholder={claudeAttachment ? "Add a message, or just send…" : "Ask Claude… (Enter to send, Shift+Enter for newline, paste images)"}
                        rows={2}
                        style={{ flex: 1, resize: "none", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, padding: "7px 10px", fontSize: 13, fontFamily: "inherit", outline: "none", lineHeight: 1.4, color: colors.text, background: colors.inputBg }}
                      />
                      <button
                        onClick={sendMessage}
                        disabled={!canSend}
                        style={{ width: 34, height: 34, alignSelf: "flex-end", border: "none", borderRadius: 8, background: canSend ? colors.accent : colors.border, color: colors.white, cursor: canSend ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.15s" }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
                {/* ── End Claude floating chat panel ─────────── */}
              </>
            );
          })()}
          {/* Clock */}
          <div style={{ textAlign: "center", marginBottom: 6, userSelect: "none" }}>
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 43, fontWeight: 700, color: colors.white, letterSpacing: 2, lineHeight: 1 }}>
              {clockTime}
            </div>
          </div>
          {/* Day + term week */}
          {(() => {
            const now = melbourneNow();
            const dayName = now.toLocaleDateString("en-AU", { weekday: "long", timeZone: TIMEZONE });
            const todayStr = toLocalDateStr(now);
            const termBreaks = interruptions.filter(i => i.type === "term_break")
              .reduce((acc, i) => { if (!acc.find(x => x.date === i.date)) acc.push(i); return acc; }, [])
              .sort((a, b) => a.date.localeCompare(b.date));
            // After 6pm Friday, show next week's number so the weekend feels like "week ahead"
            const dow = now.getDay(); // 0=Sun,1=Mon,...5=Fri,6=Sat
            const hour = now.getHours();
            const rollToNextWeek = (dow === 5 && hour >= 18) || dow === 6 || dow === 0;
            const displayDate = rollToNextWeek ? (() => {
              const next = new Date(now);
              next.setDate(now.getDate() + (8 - (dow === 0 ? 7 : dow))); // next Monday
              return toLocalDateStr(next);
            })() : todayStr;
            const weekNum = computeTermWeekNum(displayDate, termBreaks);
            return (
              <div style={{ textAlign: "center", marginBottom: 10, userSelect: "none" }}>
                <span style={{ fontSize: 12, color: colors.accent, letterSpacing: "0.02em", opacity: 0.85 }}>
                  {dayName}{weekNum ? ` · Week ${weekNum}` : ""}
                </span>
              </div>
            );
          })()}
          {/* Version / update button */}
          <button
            onClick={() => {
              if (updateInfo && updateInfo.ready) {
                if (window.electronAPI && window.electronAPI.installUpdate) {
                  window.electronAPI.installUpdate();
                }
              } else if (updateInfo && updateInfo.available) {
                // already downloading, do nothing
              } else {
                if (window.electronAPI && window.electronAPI.checkForUpdates) {
                  window.electronAPI.checkForUpdates();
                } else {
                  setNoUpdateFlash(true);
                  setTimeout(() => setNoUpdateFlash(false), 2500);
                }
              }
            }}
            style={{
              width: "100%", padding: "7px",
              background: updateInfo && updateInfo.available ? colors.accent : "transparent",
              color: updateInfo && updateInfo.available ? colors.white : colors.textLight,
              border: `1px solid ${updateInfo && updateInfo.available ? colors.accent : "rgba(255,255,255,0.15)"}`,
              borderRadius: 8, fontSize: 12, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              transition: "all 0.15s", fontFamily: "inherit", flexDirection: "column", overflow: "hidden"
            }}
            title={updateInfo && updateInfo.ready ? "Click to install and restart" : updateInfo && updateInfo.available ? "Downloading..." : "Check for updates"}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {updateInfo && updateInfo.ready
                ? "⬆ Restart to update"
                : updateInfo && updateInfo.available
                  ? "⬇ Downloading..."
                  : noUpdateFlash
                    ? "✓ No new updates"
                    : `v${APP_VERSION}`}
            </span>
            {updateProgress !== null && (
              <div style={{ width: "100%", height: 3, background: "rgba(255,255,255,0.2)", borderRadius: 2, marginTop: 4, overflow: "hidden" }}>
                <div style={{ height: "100%", width: updateProgress + "%", background: updateInfo && updateInfo.ready ? "#4ade80" : colors.white, borderRadius: 2, transition: "width 0.3s" }} />
              </div>
            )}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div ref={mainScrollRef} data-printarea="true" style={{ flex: 1, overflow: "auto", position: "relative" }}
        onMouseEnter={e => { if (!hoveredScrollRef.current) hoveredScrollRef.current = e.currentTarget; }}
        onMouseLeave={e => { if (hoveredScrollRef.current === e.currentTarget) hoveredScrollRef.current = null; }}
        onScroll={() => {}}>
        {showExportDialog && (
          <ExportDialog
            lessons={timetable?.lessons || []}
            students={students}
            schools={schools}
            teachers={teachers}
            contacts={contacts}
            specialists={specialists}
            tallyEntries={tallyEntries}
            availableWeeks={showExportDialog.availableWeeks}
            initialType={showExportDialog.initialType}
            onClose={() => setShowExportDialog(null)}
            notify={notify}
          />
        )}

        <div style={{ padding: "28px 36px", maxWidth: 1200 }}>
          {/* Back/Forward nav — now rendered inside each page's PageTitle via navButtons prop */}
          {/* Nav button elements — passed into each page's PageTitle */}
          {(() => {
            // We inject navButtons into PageTitle components via a context-like trick.
            // Since PageTitle is rendered inside each page component, we pass them as props there.
            // This comment just marks where they used to float.
            return null;
          })()}
          <div style={{ display: page === "dashboard" ? undefined : "none" }}>
          <Dashboard schools={schools} students={students} teachers={teachers} specialists={specialists} interruptions={interruptions} setInterruptions={setInterruptions} groups={groups} timetable={timetable} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} tallyEntries={tallyEntries} setTallyEntries={setTallyEntries} masterBreaks={masterBreaks} contacts={contacts} bands={bands} resources={resources} onNavigate={setPage} setStudentsViewState={setStudentsViewState} setNewStudentPrefill={setNewStudentPrefill} setSharedSchool={setSharedSchool} errorLog={errorLog} logError={logError} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} onRestore={handleRestore} onBackup={handleBackup} notify={notify} recordUsage={recordUsage} hoveredScrollRef={hoveredScrollRef} emailNavRef={emailNavRef} emailListRef={emailListRef} filteredEmailsRef={filteredEmailsRef} todoUndoRef={todoUndoRef} autoSendQueue={autoSendQueue} setAutoSendQueue={setAutoSendQueue} autoSendTimerRef={autoSendTimerRef} autoSendActiveRef={autoSendActiveRef} />
          </div>
          {page === "schools" && <SchoolsManager schools={schools} setSchools={setSchools} notify={notify} resetKey={resetKey} viewState={schoolsViewState} setViewState={setSchoolsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "specialists" && <SpecialistManager specialists={specialists} setSpecialists={setSpecialists} schools={schools} notify={notify} resetKey={resetKey} viewState={specialistsViewState} setViewState={setSpecialistsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "calendar" && <CalendarManager interruptions={interruptions} setInterruptions={setInterruptions} schools={schools} specialists={specialists} notify={notify} resetKey={resetKey} viewState={interruptionsViewState} setViewState={setInterruptionsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} scanPreview={scanPreview} setScanPreview={setScanPreview} />}
          {page === "students" && <StudentsManager students={students} setStudents={setStudents} schools={schools} teachers={teachers} specialists={specialists} notify={notify} focusStudentId={focusStudentId} onClearFocus={() => setFocusStudentId(null)} returnPage={focusReturnPage} onReturn={() => { if (focusReturnPage) { setPage(focusReturnPage); setFocusReturnPage(null); } }} resetKey={resetKey} viewState={studentsViewState} setViewState={setStudentsViewState} newStudentPrefill={newStudentPrefill} onClearNewStudentPrefill={() => setNewStudentPrefill(null)} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "teachers" && <TeachersManager teachers={teachers} setTeachers={setTeachers} schools={schools} notify={notify} resetKey={resetKey} viewState={teachersViewState} setViewState={setTeachersViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "pending" && <PendingManager students={students} setStudents={setStudents} schools={schools} timetable={timetable} interruptions={interruptions} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} onSchedulePending={handleSchedulePending} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("pending"); setPage("students"); }} onManualSchedule={handleManualSchedule} notify={notify} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "groups" && <GroupsManager groups={groups} setGroups={setGroups} students={activeStudents} schools={schools} teachers={teachers} timetable={timetable} onRevertGroup={handleRevertGroup} onAddGroupToMaster={handleAddGroupToMaster} notify={notify} focusGroupId={focusGroupId} onClearFocusGroup={() => setFocusGroupId(null)} onReturn={() => { if (focusGroupReturnPage) { setPage(focusGroupReturnPage); setFocusGroupReturnPage(null); } }} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("groups"); setPage("students"); }} viewState={groupsViewState} setViewState={setGroupsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "timetable" && <TimetableView mainScrollRef={mainScrollRef} timetable={timetable} schools={schools} students={activeStudents} allStudents={students} teachers={teachers} setTeachers={setTeachers} specialists={specialists} pendingStudents={pendingStudents} masterBreaks={masterBreaks} setMasterBreaks={setMasterBreaks} viewState={ttViewState} setViewState={setTtViewState} sharedSchool={sharedSchool} setSharedSchool={setSharedSchool} sharedTimetableScroll={sharedTimetableScroll} setSharedTimetableScroll={setSharedTimetableScroll} onExport={handleExport} onPrint={() => printMasterTimetable(timetable, schools, students, teachers)} onGenerate={handleGenerateTimetable} onGenerateSchool={handleGenerateSchool} onClearSchool={handleClearSchool} contacts={contacts} onWarningsChange={(w, a) => { setTtConstraintWarnings(w); setTtAckedConstraints(a); }} initialConstraintWarnings={ttConstraintWarnings} initialAckedConstraints={ttAckedConstraints} onClear={() => { setTimetable(null); setGroups(prev => prev.map(g => g.status === "scheduled" ? { ...g, status: "forming" } : g)); notify("Timetable cleared"); }} onSchedulePending={handleSchedulePending} onMoveLesson={(lessonId, newDay, newTime) => {
            setTimetable(prev => {
              if (!prev) return prev;
              const lesson = prev.lessons.find(l => l.id === lessonId);
              if (!lesson) return prev;
              const school = schools.find(s => s.id === lesson.schoolId);
              const slot = school?.slots.find(s => s.start === newTime);
              if (!slot) return prev;
              // Recalculate duringSpecialist for new position
              const student = students.find(s => s.id === lesson.studentId);
              const className = student?.className || "";
              let newDuringSpec = false;
              if (className && slot.type === "class") {
                for (const sp of specialists) {
                  if (sp.schoolId === lesson.schoolId && sp.className === className && sp.day === newDay) {
                    const spS = timeToMin(sp.start), spE = timeToMin(sp.end);
                    const slS = timeToMin(slot.start), slE = timeToMin(slot.end);
                    if (slS < spE && slE > spS) { newDuringSpec = sp.subject; break; }
                  }
                }
              }
              return { ...prev, lessons: prev.lessons.map(l => l.id === lessonId ? { ...l, day: newDay, start: slot.start, end: slot.end, slotId: slot.id, slotName: slot.name, duringSpecialist: newDuringSpec, _pinned: false } : l) };
            });
          }} onDeleteLesson={(lessonId) => {
            setTimetable(prev => {
              if (!prev) return prev;
              const lesson = prev.lessons.find(l => l.id === lessonId);
              if (!lesson) return prev;
              const student = students.find(s => s.id === lesson.studentId);
              const isPending = student && (student.status === "pending" || student.status === "trial");
              const newLessons = prev.lessons.filter(l => l.id !== lessonId);
              if (isPending) {
                // Pending student — just remove the lesson, they stay on waiting list
                return { ...prev, lessons: newLessons };
              } else {
                // Active student — add to unscheduled so they can be re-placed
                const instName = lesson.instrument || student?.instruments?.[0]?.name || "";
                const alreadyUnscheduled = prev.unscheduled.some(u => u.student.id === lesson.studentId && (u.instrument || "") === instName);
                const newUnscheduled = alreadyUnscheduled ? prev.unscheduled : [
                  ...prev.unscheduled,
                  { student: student || { id: lesson.studentId, name: lesson.studentName, schoolId: lesson.schoolId, instruments: [] }, instrument: instName, reason: "Manually removed" }
                ];
                return { ...prev, lessons: newLessons, unscheduled: newUnscheduled };
              }
            });
          }} onViewStudent={(studentId) => {
            setFocusStudentId(studentId);
            setFocusReturnPage("timetable");
            setPage("students");
          }} onViewGroup={(groupId) => {
            setFocusGroupId(groupId);
            setFocusGroupReturnPage("timetable");
            setPage("groups");
          }} onPlaceUnsched={(data, day, time) => {
            const parts = data.split(":");
            if (parts.length < 3) return;
            const studentId = parts[1];
            const instrumentName = parts.slice(2).join(":");
            const student = students.find(s => s.id === studentId);
            if (!student) return;
            const school = schools.find(s => s.id === student.schoolId);
            if (!school) return;
            const slot = school.slots.find(s => s.start === time);
            if (!slot) return;
            const inst = student.instruments.find(i => i.name === instrumentName) || student.instruments[0];
            if (!inst) return;
            let teacher = null;
            if (inst && inst.teacherId) teacher = teachers.find(t => t.id === inst.teacherId);
            if (!teacher) teacher = teachers.find(t => t.instruments.some(ti => ti.name === inst.name) && t.availability.some(a => a.schoolId === school.id && a.day === day));
            if (!teacher) { notify("No compatible teacher available for " + student.name, "warning"); return; }
            const lesson = {
              id: uid(), studentId: student.id, studentName: student.name,
              teacherId: teacher.id, teacherName: teacher.name,
              schoolId: school.id, schoolName: school.name,
              day, slotId: slot.id, slotName: slot.name,
              start: slot.start, end: slot.end,
              instrument: inst.name, duringSpecialist: false
            };
            setTimetable(prev => ({
              ...prev,
              lessons: [...prev.lessons, lesson],
              unscheduled: prev.unscheduled.filter(u => !(u.student.id === studentId && (u.instrument || u.student.instruments[0]?.name) === instrumentName))
            }));
            notify(`${student.name} placed on ${day} at ${time}`);
          }} onPlacePending={(data, day, time) => {
            const parts = data.split(":");
            if (parts.length < 3) return;
            const studentId = parts[1];
            const instrumentName = parts.slice(2).join(":");
            const student = students.find(s => s.id === studentId);
            if (!student) return;
            const school = schools.find(s => s.id === student.schoolId);
            if (!school) return;
            const slot = school.slots.find(s => s.start === time);
            if (!slot) return;
            const inst = student.instruments.find(i => i.name === instrumentName) || student.instruments[0];
            if (!inst) return;
            let teacher = null;
            if (inst && inst.teacherId) teacher = teachers.find(t => t.id === inst.teacherId);
            if (!teacher) teacher = teachers.find(t => t.instruments.some(ti => ti.name === inst.name) && t.availability.some(a => a.schoolId === school.id && a.day === day));
            if (!teacher) { notify("No compatible teacher available for " + student.name, "warning"); return; }
            const lesson = {
              id: uid(), studentId: student.id, studentName: student.name,
              teacherId: teacher.id, teacherName: teacher.name,
              schoolId: school.id, schoolName: school.name,
              day, slotId: slot.id, slotName: slot.name,
              start: slot.start, end: slot.end,
              instrument: inst.name, duringSpecialist: false
            };
            // Snapshot both timetable and students before mutating — enables full undo
            pendingPlaceUndoStack.current.push({
              seq: ++ttPageActionSeq.current,
              timetable: JSON.parse(JSON.stringify(timetable)),
              students: JSON.parse(JSON.stringify(students)),
            });
            pendingPlaceRedoStack.current = [];
            if (pendingPlaceUndoStack.current.length > 50) pendingPlaceUndoStack.current.shift();
            setTimetableRaw(prev => ({
              ...(prev || { unscheduled: [] }),
              lessons: [...((prev || { lessons: [] }).lessons), lesson],
              unscheduled: (prev || { unscheduled: [] }).unscheduled,
            }));
            setStudents(prev => prev.map(s => s.id === studentId ? { ...s, status: "active" } : s));
            notify(`${student.name} added to timetable on ${day} at ${time}`);
          }} onUndo={undoTimetablePage} onRedo={redoTimetablePage} undoCount={ttPageUndoCount()} redoCount={ttPageRedoCount()} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} onLoadVersion={(schoolId, lessons) => {
            setTimetable(prev => {
              if (!prev) return prev;
              return {
                ...prev,
                lessons: [...prev.lessons.filter(l => l.schoolId !== schoolId), ...lessons],
                unscheduled: (prev.unscheduled || []).filter(u => u.student.schoolId !== schoolId)
              };
            });
            notify("Loaded saved version");
          }} />}
          {page === "weekly" && <WeeklyAdjustments mainScrollRef={mainScrollRef} timetable={timetable} schools={schools} students={students} setStudents={setStudents} teachers={teachers} setTeachers={setTeachers} specialists={specialists} interruptions={interruptions} groups={groups} bands={bands} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} tallyEntries={tallyEntries} setTallyEntries={setTallyEntries} masterBreaks={masterBreaks} notify={notify} contacts={contacts} viewState={weeklyViewState} setViewState={setWeeklyViewState} sharedSchool={sharedSchool} setSharedSchool={setSharedSchool} sharedTimetableScroll={sharedTimetableScroll} setSharedTimetableScroll={setSharedTimetableScroll} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("weekly"); setPage("students"); }} onViewGroup={(groupId) => { setFocusGroupId(groupId); setFocusGroupReturnPage("weekly"); setPage("groups"); }} logError={logError} onExport={handleExport} onUndo={undoWeekly} onRedo={redoWeekly} undoCount={weeklyUndoStack.current.length} redoCount={weeklyRedoStack.current.length} onWarningsChange={(w, a) => { setWeeklyConstraintWarnings(w); setWeeklyAckedConstraints(a); }} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "tally" && <TallyView timetable={timetable} schools={schools} students={students} teachers={teachers} interruptions={interruptions} tallyEntries={tallyEntries} setTallyEntries={setTallyEntries} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} notify={notify} onExport={handleExport} viewState={tallyViewState} setViewState={setTallyViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "bands" && <BandsManager bands={bands} setBands={setBands} schools={schools} students={students} teachers={teachers} tallyEntries={tallyEntries} setTallyEntries={setTallyEntries} notify={notify} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "contacts" && <ContactsManager contacts={contacts} setContacts={setContacts} schools={schools} students={students} setStudents={setStudents} teachers={teachers} specialists={specialists} notify={notify} resetKey={resetKey} viewState={contactsViewState} setViewState={setContactsViewState} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("contacts"); setPage("students"); }} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "resources" && <ResourcesManager resources={resources} setResources={setResources} notify={notify} resetKey={resetKey} viewState={resourcesViewState} setViewState={setResourcesViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "settings" && <SettingsManager
            apiKey={apiKey} setApiKey={setApiKey}
            schools={schools} students={students} teachers={teachers} specialists={specialists}
            interruptions={interruptions} setInterruptions={setInterruptions} groups={groups} timetable={timetable}
            weeklyTimetables={weeklyTimetables} tallyEntries={tallyEntries}
            contacts={contacts} bands={bands} masterBreaks={masterBreaks} resources={resources}
            onRestore={handleRestore} onBackup={handleBackup} notify={notify} resetKey={resetKey}
            updateInfo={updateInfo} noUpdateFlash={noUpdateFlash} setNoUpdateFlash={setNoUpdateFlash}
            updateProgress={updateProgress} APP_VERSION={APP_VERSION}
            viewState={settingsViewState} setViewState={setSettingsViewState}
            goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory}
            claudeBudget={claudeBudget} setClaudeBudget={setClaudeBudget} tokenUsage={tokenUsage}
            claudePersonalContext={claudePersonalContext} setClaudePersonalContext={setClaudePersonalContext}
            claudeMemory={claudeMemory} setClaudeMemory={setClaudeMemory}
          />}
        </div>
      </div>
    </div>
  );
}
