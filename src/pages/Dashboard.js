// ============================================================
// DASHBOARD — extracted from App.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { colors, DAYS, STORAGE_KEYS, INSTRUMENTS, APP_VERSION, instruments_colors } from "../constants";
import { uid, melbourneNow, melbourneToday, toLocalDateStr, to12h, getCurrentWeekMonday, getTermWeekLabel, getParentEmails, openCompose, openGmailSequential, groupDisplayName, getLiveTeacherName, getInstColor, getInitials, getSchoolAcronym, timeToMin, toTimeLabel, _getMondayOf } from "../utils/helpers";
import { computeTermWeekNum, computeTermKey, computeAutoTallyDay, computeExtraTicks } from "../utils/tallyHelpers";
import { anthropicFetch, getAnthropicHeaders } from "../utils/api";
import { getUserTemplates, applyMergeCtx } from "../utils/emailTemplates";
import { Card, PageTitle, NavButtons, Btn, Input, Tag, EmptyState, FileUpload, Checkbox, AddMemoryInput, FrozenCard, useDragScroll, PAGE_COLORS } from "../components/ui/SharedUI";
import { ErrorLogPanel, DashboardBackupBar } from "../components/ErrorLogPanel";
import { ExportDialog } from "../components/ExportDialog";

export function Dashboard({ schools, students, teachers, specialists, interruptions, groups, timetable, weeklyTimetables, setWeeklyTimetables, tallyEntries, setTallyEntries, masterBreaks, contacts, bands, resources, onNavigate, onRestore, onBackup, errorLog, logError, notify, goBack, goForward, historyCursor, pageHistory, setStudentsViewState, setNewStudentPrefill, setSharedSchool, recordUsage, hoveredScrollRef, emailNavRef, emailListRef, filteredEmailsRef, todoUndoRef, autoSendQueue, setAutoSendQueue, autoSendTimerRef, autoSendActiveRef }) {
  const activeStudents = students.filter(s => s.status === "active");

  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);
  const [hoveredDay, setHoveredDay] = useState(null);
  const [calendarEvents, setCalendarEvents] = useState(() => { try { return JSON.parse(localStorage.getItem("mt-calendar-events") || "[]"); } catch { return []; } });
  const saveCalendarEvents = (evs) => { setCalendarEvents(evs); try { localStorage.setItem("mt-calendar-events", JSON.stringify(evs)); } catch {} };
  const [calEventMenu, setCalEventMenu] = useState(null); // { x, y, date, time, prefill }
  const [calEventForm, setCalEventForm] = useState(null); // { date, time, title, details, id? }

  // Current week calculation
  const today = melbourneNow();
  const monday = getCurrentWeekMonday();
  const todayStr = toLocalDateStr(today);
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
      const dayAvails = teacher.availability.filter(a => a.day === wd.day);
      for (const avail of dayAvails) {
        const school = schools.find(s => s.id === avail.schoolId);
        if (school) {
          const dayLessons = timetable ? timetable.lessons.filter(l => l.teacherId === teacher.id && l.schoolId === school.id && l.day === wd.day) : [];
          const lessonCount = dayLessons.length;
          let firstLesson = null, lastLesson = null;
          if (dayLessons.length > 0) {
            firstLesson = dayLessons.reduce((a, b) => (a.start < b.start ? a : b));
            lastLesson = dayLessons.reduce((a, b) => (a.end > b.end ? a : b));
          }
          teacherSchools.push({ teacher, school, start: avail.start, end: avail.end, lessonCount, firstLesson, lastLesson });
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
      return teachers.some(t => t.availability.some(a => a.schoolId === school.id && a.day === wd.day));
    });

    // Pending/trial students
    const pendingOnDay = students.filter(s => (s.status === "pending" || s.status === "trial") && schools.some(sc => sc.id === s.schoolId));

    return { ...wd, teacherSchools, dayInterruptions, weeklyStatus, studentsWithNotes, pendingOnDay };
  });

  // Students with 2+ missed lessons in the last 14 days — derived from tallyEntries
  const recentCutoff = new Date(today);
  recentCutoff.setDate(today.getDate() - 14);
  const missedByStudent = {};
  for (const e of tallyEntries) {
    if (e.status !== "missed") continue;
    if (new Date(e.recordedAt) < recentCutoff) continue;
    const k = `${e.studentId}|${e.instrument}`;
    if (!missedByStudent[k]) missedByStudent[k] = { studentId: e.studentId, studentName: e.studentName, instrument: e.instrument, schoolId: e.schoolId, schoolName: schools.find(s => s.id === e.schoolId)?.name || "", count: 0 };
    missedByStudent[k].count++;
  }
  const missedList = Object.values(missedByStudent).filter(m => m.count >= 2);

  // Unacknowledged timetable warnings
  const unschedCount = timetable ? timetable.unscheduled.filter(u => u.reason !== "Unassigned").length : 0;
  const unassignedCount = students.filter(s => s.status === "active" && (s.instruments || []).some(i => !i.isGroup && !i.teacherId)).length;
  const [bannerTip, setBannerTip] = React.useState(null);
  const [dashPanels, setDashPanels] = React.useState(() => { try { return { emails: false, todo: false, alerts: false, ...JSON.parse(localStorage.getItem(STORAGE_KEYS.dashPanels) || "{}") }; } catch { return { emails: false, todo: false, alerts: false }; } });
  const saveDashPanels = (next) => { setDashPanels(next); try { localStorage.setItem(STORAGE_KEYS.dashPanels, JSON.stringify(next)); } catch {} };
  const [splitRatio, setSplitRatio] = React.useState(() => { try { return parseFloat(localStorage.getItem("mt-dash-split-ratio") || "0.5"); } catch { return 0.5; } });
  const panelCardRef = React.useRef(null);
  const panelDividerDragging = React.useRef(false);
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
  const [inboxEmails, setInboxEmails] = React.useState(() => { try { const c = JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxCache) || "null"); return Array.isArray(c?.emails) ? c.emails.map(preprocessEmail) : []; } catch { return []; } });
  const [emailFolder, setEmailFolder] = React.useState("inbox"); // "inbox" | "sent"
  const [sentEmails, setSentEmails] = React.useState([]);
  const [sentLoading, setSentLoading] = React.useState(false);
  const [inboxLastFetched, setInboxLastFetched] = React.useState(() => { try { const c = JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxCache) || "null"); return c?.ts || 0; } catch { return 0; } });
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
  const [emailContextMenu, setEmailContextMenu] = React.useState(null); // { x, y, text, emailId }
  const [emailCategoryFilter, setEmailCategoryFilter] = React.useState(new Set()); // ★ | parent | teacher | staff | admin | enquiry | other
  const [emailCategoryOverrides, setEmailCategoryOverrides] = React.useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.emailCategoryOverrides) || "{}"); } catch { return {}; } });
  const [emailNoReplyOverrides, setEmailNoReplyOverrides] = React.useState(() => { try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.emailNoReplyOverrides) || "[]")); } catch { return new Set(); } });
  const [emailMoveToOpen, setEmailMoveToOpen] = React.useState(null); // emailId of open Move To popup
  const [bulkMoveOpen, setBulkMoveOpen] = React.useState(false);
  const [emailSchoolFilter, setEmailSchoolFilter] = React.useState(new Set()); // school:id
  const [emailSearch, setEmailSearch] = React.useState("");
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
  const [alertDragging, setAlertDragging] = React.useState(null); // { text, tag } being dragged from alert chip
  const [alertDropdown, setAlertDropdown] = React.useState(null); // { rect, title, borderColor, items: [{label, dragPayload, chipColor}] }
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
  const [emailArchivedIds, setEmailArchivedIds] = React.useState(() => { try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxArchivedIds) || "[]")); } catch { return new Set(); } });
  const markArchived = React.useCallback((emailId) => {
    setEmailArchivedIds(prev => { const next = new Set(prev); next.add(emailId); try { localStorage.setItem(STORAGE_KEYS.inboxArchivedIds, JSON.stringify([...next])); } catch {} return next; });
    setEmailReadIds(prev => { const next = new Set(prev); next.add(emailId); try { localStorage.setItem(STORAGE_KEYS.inboxReadIds, JSON.stringify([...next])); } catch {} return next; });
  }, []);
  const markRead = (emailId) => { const next = new Set(emailReadIds); next.add(emailId); setEmailReadIds(next); try { localStorage.setItem(STORAGE_KEYS.inboxReadIds, JSON.stringify([...next])); } catch {} };

  // To Do state
  const [todoItems, setTodoItems] = React.useState(() => { try { const v = JSON.parse(localStorage.getItem(STORAGE_KEYS.todoItems) || "[]"); todoItemsRef.current = v; return v; } catch { return []; } });
  const [todoInput, setTodoInput] = React.useState("");
  const [todoDragIdx, setTodoDragIdx] = React.useState(null);
  const todoDragIdxRef = React.useRef(null);
  const [todoDropZoneIdx, setTodoDropZoneIdx] = React.useState(null); // index of gap being hovered (0 = before item 0, 1 = between 0 and 1, etc.)
  const todoItemsRef = React.useRef([]); // always-current mirror of todoItems for drop handlers
  const todoUndoStack = React.useRef([]); // stack of previous todoItems states for Ctrl+Z
  const todoSubDragRef = React.useRef(null); // { parentId, subId, subItem } when dragging a sub-item out
  const [todoEditId, setTodoEditId] = React.useState(null); // id of item being inline-edited
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
    const stamped = items.map(t => prevIds.has(t.id) ? t : { ...t, todoDate: today });
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
      const prompt = `You are helping a music tuition coordinator reply to an email. Draft a concise, professional reply.\n\nContext:\n- Schools: ${schoolList}\n- Teachers: ${teacherList}\n- Active students: ${students.filter(s => s.status === "active").length}\n\nEmail:\nFrom: ${email.from}\nSubject: ${email.subject}\nBody: ${email.body || email.snippet}\n\nWrite ONLY the reply body. No subject line, no sign-off placeholder, no explanation.`;
      const res = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await res.json();
      if (data.usage && recordUsage) recordUsage("claude-sonnet-4-20250514", data.usage.input_tokens || 0, data.usage.output_tokens || 0);
      const draft = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
      setTriageDraft(prev => ({ ...prev, [email.id]: draft }));
    } catch {}
    setTriageLoading(prev => ({ ...prev, [email.id]: false }));
  }, [schools, teachers, students, recordUsage]);

  // Alert dismissals — keyed by groupType, reset at midnight
  const [alertDismissals, setAlertDismissals] = React.useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.alertDismissals) || "{}");
      if (stored.date !== todayStr) return { date: todayStr, dismissed: {} };
      return stored;
    } catch { return { date: todayStr, dismissed: {} }; }
  });
  const dismissAlert = (key) => {
    const next = { ...alertDismissals, dismissed: { ...alertDismissals.dismissed, [key]: true } };
    setAlertDismissals(next);
    try { localStorage.setItem(STORAGE_KEYS.alertDismissals, JSON.stringify(next)); } catch {}
  };
  const isAlertDismissed = (key) => !!alertDismissals.dismissed[key];
  const pendingDismissed = isAlertDismissed("alert-pending");
  const trialDismissed = isAlertDismissed("alert-trial");

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
    // School — match name or acronym against known schools, also check to/deliveredTo address
    let school = "";
    const rawToField = email.deliveredTo || email.to || "";
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
    let instrument = meta.instrument || "";
    if (!instrument) {
      const m = fullText.match(/\b(piano|guitar|violin|viola|cello|double bass|drums?|voice|singing|flute|trumpet|trombone|bass guitar|ukulele|recorder|saxophone|clarinet|french horn|oboe|bassoon)\b/i);
      if (m) instrument = m[1];
    }
    let enquirySchool = meta.school || "";
    if (!enquirySchool) {
      const rawTo = email.deliveredTo || email.to || "";
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
        ? [{ name: instrument.charAt(0).toUpperCase() + instrument.slice(1), teacherId: "" }]
        : [{ name: "", teacherId: "" }],
    };
  }, [parseEnquiryMeta, schools, contacts]);

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
        composeSubject: email.subject ? `Re: ${email.subject}` : "",
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
        composeSubject: email.subject ? `Re: ${email.subject}` : "",
        meta, subItems, replyAddrs, createdAt: new Date().toISOString() }, ...currentItems];
    }

    // === ENQUIRY → structured sub-items ===
    if (isEnquiry) {
      const enquiryFirst = preferredFirstName(meta.parentName) || meta.parentName;
      const fullText = `${email.subject || ""} ${email.snippet || ""} ${email.body || ""}`;
      const INSTRUMENTS_LC = ["piano","guitar","violin","viola","cello","double bass","drums","voice","singing","flute","trumpet","trombone","bass guitar","ukulele","recorder","saxophone","clarinet","french horn","oboe","bassoon"];
      // Try to extract instrument — subject first (e.g. "Emerson Murphy – Piano"), then body
      let instrument = "";
      const instrMatch = cleanSubject.match(/[–—-]\s*([A-Za-z\s]+)$/);
      if (instrMatch) {
        const candidate = instrMatch[1].trim();
        if (INSTRUMENTS_LC.some(i => candidate.toLowerCase().includes(i))) instrument = candidate;
      }
      if (!instrument) {
        const bodyInstrMatch = fullText.match(/\b(piano|guitar|violin|viola|cello|double bass|drums?|voice|singing|flute|trumpet|trombone|bass guitar|ukulele|recorder|saxophone|clarinet|french horn|oboe|bassoon)\b/i);
        if (bodyInstrMatch) instrument = bodyInstrMatch[1];
      }
      // Try to parse school — multiple strategies
      let enquirySchool = meta.school || "";
      if (!enquirySchool) {
        // Extract all bare email addresses from the to/deliveredTo field (handles "Name <addr>" format)
        const rawTo = email.deliveredTo || email.to || "";
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
        ? `Contact ${enquiryFirst} re: ${meta.studentName}${instrument ? `, ${instrument.charAt(0).toUpperCase() + instrument.slice(1)} enquiry` : ""}`
        : instrument ? `Contact ${enquiryFirst} re: ${instrument.charAt(0).toUpperCase() + instrument.slice(1)} enquiry`
        : `Contact ${enquiryFirst} — new enquiry`;
      const prefill = {
        name: meta.studentName || "",
        status: "pending",
        parents: [{ name: meta.parentName, email: fromAddr }],
        schoolId: schools.find(s => s.name === enquirySchool)?.id || "",
        className: meta.className || "",
        instruments: instrument ? [{ name: instrument.charAt(0).toUpperCase() + instrument.slice(1), teacherId: "" }] : [{ name: "", teacherId: "" }]
      };
      const subItems = [
        { id: uid(), text: "Add to pending students", done: false, tag: "admin", navigateTo: "students", studentPrefill: prefill, createdAt: new Date().toISOString() },
        { id: uid(), text: "Schedule trial lesson", done: false, tag: "admin", navigateTo: "students", studentPrefill: { ...prefill, status: "trial" }, createdAt: new Date().toISOString() },
      ];
      return [{ id: uid(), text: itemText, done: false, tag: "email", groupType: "enquiry", emailId: email.id, replyTo: fromAddr, senderName: enquiryFirst, composeSubject: email.subject ? `Re: ${email.subject}` : "", meta, subItems, createdAt: new Date().toISOString() }, ...currentItems];
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

    const newItem = { id: uid(), text: itemText, done: false, tag: "email", emailId: email.id, composeSubject: email.subject ? `Re: ${email.subject}` : "", meta, ...itemExtra, createdAt: new Date().toISOString() };

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
          composeSubject: email.subject ? `Re: ${email.subject}` : "", meta };
        const prevSubItems = target.subItems || [{ id: uid(), text: target.senderName ? `Reply to ${target.senderName}` : target.text,
          fullName: target.fullName, replyTo: target.replyTo, replyEmailId: target.emailId,
          composeSubject: target.composeSubject ?? (target.emailId ? (inboxEmails.find(e => e.id === target.emailId)?.subject ? `Re: ${inboxEmails.find(e => e.id === target.emailId).subject}` : "") : ""),
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
      const INSTRUMENTS_LC = ["piano","guitar","violin","viola","cello","drums","voice","singing","flute","trumpet","trombone","bass","ukulele","recorder","saxophone","clarinet"];
      let instrument = "";
      for (const e of group) {
        const m = (e.subject || "").match(/[–—-]\s*([A-Za-z\s]+)$/);
        if (m) { const c = m[1].trim(); if (INSTRUMENTS_LC.some(i => c.toLowerCase().includes(i))) { instrument = c; break; } }
        const bm = `${e.subject || ""} ${e.snippet || ""}`.match(/\b(piano|guitar|violin|viola|cello|drums?|voice|singing|flute|trumpet|trombone|bass|ukulele|recorder|saxophone|clarinet)\b/i);
        if (bm) { instrument = bm[1]; break; }
      }
      const studentLabel = linkedStudent ? linkedStudent.name.split(" ")[0] : null;
      const instrLabel = instrument ? `, ${instrument.charAt(0).toUpperCase() + instrument.slice(1)} enquiry` : "";
      const groupText = studentLabel
        ? `Contact ${firstName} re: ${studentLabel}${instrLabel}`
        : `Contact ${firstName} re:${instrument ? ` ${instrument.charAt(0).toUpperCase() + instrument.slice(1)} enquiry` : ` ${group.length} emails`}`;
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


  const fetchInbox = React.useCallback(async (opts = {}) => {
    if (!window.electronAPI) return;
    const { silent = false } = opts;
    if (!silent) { setInboxLoading(true); setInboxError(null); }
    try {
      const res = await window.electronAPI.gmailListInbox();
      if (!res.ok) { if (!silent) setInboxError(res.error || "Failed to fetch emails."); return; }
      const fetched = res.emails || [];
      setInboxEmails(prev => {
        let archived = new Set();
        try { archived = new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.inboxArchivedIds) || "[]")); } catch {}
        const allowed = fetched.filter(e => !archived.has(e.id));
        // Always replace existing threads with fresh data (new replies change threadCount/body)
        // Prepend genuinely new threads, preserve order of others
        const fetchedIds = new Set(allowed.map(e => e.id));
        const existingIds = new Set(prev.map(e => e.id));
        const newThreads = allowed.filter(e => !existingIds.has(e.id));
        const merged = [
          ...newThreads,
          ...prev
            .filter(e => !archived.has(e.id))
            .map(old => fetchedIds.has(old.id) ? allowed.find(f => f.id === old.id) : old)
        ].map(preprocessEmail);
        saveInboxCache(merged);
        if (newThreads.length > 0) generateSummaries(newThreads);
        return merged;
      });
      setInboxLastFetched(Date.now());
    } catch (err) { if (!silent) setInboxError("Failed to fetch emails."); }
    if (!silent) setInboxLoading(false);
  }, [generateSummaries]);

  const fetchSent = React.useCallback(async () => {
    if (!window.electronAPI) return;
    setSentLoading(true);
    try {
      const res = await window.electronAPI.gmailListSent();
      if (res.ok) setSentEmails((res.emails || []).map(preprocessEmail));
    } catch {}
    setSentLoading(false);
  }, []);

  // On first mount: if cache is stale (>5min) or empty, full-fetch. Otherwise use cache silently.
  // Also silently pre-fetch sent emails so reply indicators and attachment logic have thread data.
  useEffect(() => {
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

  return (
    <div>
      <PageTitle subtitle={_rollFwd ? "Monday" : todayDayName} pageColor={PAGE_COLORS.dashboard} navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{getTermWeekLabel(effectiveTodayStr, interruptions.filter(i => i.type === "term_break")).toUpperCase()}</PageTitle>
      {/* ── Week calendar strip ── */}
      {(() => {
        const teacherColorMap = {};
        teachers.forEach((t, i) => { teacherColorMap[t.id] = t.color || TEACHER_COLORS[i % TEACHER_COLORS.length]; });
        const termBreaksForStrip = interruptions.filter(i => i.type === "term_break");
        const calMonday = new Date(monday);
        calMonday.setDate(calMonday.getDate() + calendarWeekOffset * 7);
        const fullWeekDays = DAYS.map((d, i) => {
          const date = new Date(calMonday);
          date.setDate(calMonday.getDate() + i);
          return { day: d, date: toLocalDateStr(date), dayNum: date.getDate(), isNextWeek: false };
        });
        // When offset=0, mirror the rolling visibleDays; otherwise full Mon-Fri of offset week
        const stripDays = calendarWeekOffset === 0 ? visibleDays : fullWeekDays;
        const calWeekLabel = getTermWeekLabel(fullWeekDays[0].date, termBreaksForStrip);
        const activeDay = hoveredDay !== null ? hoveredDay : (stripDays[0]?.day || todayDayName);

        const renderDayCell = (wd) => {
          const isActive = activeDay === wd.day;
          const isToday = wd.date === todayStr;
          const isTermBreak = interruptions.some(intr => intr.type === "term_break" && wd.date >= intr.date && wd.date <= (intr.endDate || intr.date));
          const dayInterrupts = interruptions.filter(intr => {
            if (intr.type === "term_break") return false;
            return wd.date >= intr.date && wd.date <= (intr.endDate || intr.date);
          });
          const dayEvents = calendarEvents.filter(ev => ev.date === wd.date);
          const dayTeacherSchools = [];
          for (const teacher of teachers) {
            for (const avail of teacher.availability.filter(a => a.day === wd.day)) {
              const school = schools.find(s => s.id === avail.schoolId);
              if (school) {
                const dayLessons = timetable ? timetable.lessons.filter(l => l.teacherId === teacher.id && l.schoolId === school.id && l.day === wd.day) : [];
                const firstLesson = dayLessons.length ? dayLessons.reduce((a, b) => a.start < b.start ? a : b) : null;
                const lastLesson = dayLessons.length ? dayLessons.reduce((a, b) => a.end > b.end ? a : b) : null;
                dayTeacherSchools.push({ teacher, school, firstLesson, lastLesson });
              }
            }
          }
          const bySchool = {};
          for (const { teacher, school, firstLesson, lastLesson } of dayTeacherSchools) {
            if (!bySchool[school.id]) bySchool[school.id] = { school, teachers: [] };
            bySchool[school.id].teachers.push({ teacher, firstLesson, lastLesson });
          }
          const schoolGroups = Object.values(bySchool);
          return (
            <div key={wd.date}
              onMouseEnter={() => setHoveredDay(wd.day)}
              onMouseLeave={() => setHoveredDay(null)}
              onContextMenu={e => { e.preventDefault(); setCalEventForm({ date: wd.date, time: "", title: "", details: "", x: e.clientX, y: e.clientY }); }}
              style={{
                borderRadius: 10,
                border: "2px solid " + (isActive ? colors.sidebarActive : "transparent"),
                outline: isActive ? "none" : "1px solid " + colors.border,
                outlineOffset: -1,
                borderLeft: wd.isNextWeek ? `4px solid ${colors.textMuted}` : isActive ? `2px solid ${colors.sidebarActive}` : undefined,
                background: isTermBreak ? "#F5F0FF" : isActive ? "#E8EDF5" : colors.white,
                padding: "10px 10px",
                minHeight: 90, // ~1.5x the previous ~60px effective height
                transition: "border-color 0.15s, background 0.15s", cursor: "default",
                display: "flex", flexDirection: "column",
              }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: isActive ? colors.sidebarActive : colors.textLight, textTransform: "uppercase", letterSpacing: "0.05em" }}>{wd.day.slice(0, 3)}</span>
                <span style={{ fontSize: 11, color: isActive ? colors.sidebarActive : colors.textMuted }}>{wd.dayNum}{isToday ? " ●" : ""}</span>
              </div>
              {isTermBreak ? (
                <div style={{ fontSize: 9, fontWeight: 700, color: colors.warning, letterSpacing: "0.03em" }}>School Holidays</div>
              ) : (
                <>
                  {dayInterrupts.length > 0 && (
                    <div style={{ marginBottom: 4 }}>
                      {dayInterrupts.slice(0, 2).map((intr, ii) => (
                        <div key={ii} style={{ fontSize: 9, background: "#FEF3C7", color: "#92400E", borderRadius: 3, padding: "1px 4px", marginBottom: 2, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{intr.title}</div>
                      ))}
                    </div>
                  )}
                  {dayEvents.length > 0 && (
                    <div style={{ marginBottom: 4 }}>
                      {dayEvents.map(ev => (
                        <div key={ev.id} style={{ fontSize: 9, background: colors.accentLight, color: colors.accentDark, borderRadius: 3, padding: "1px 4px", marginBottom: 2, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ev.time ? ev.time + " " : ""}{ev.title}
                        </div>
                      ))}
                    </div>
                  )}
                  {schoolGroups.length === 0 ? (
                    <div style={{ fontSize: 9, color: colors.textMuted, fontStyle: "italic" }}>No lessons</div>
                  ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {schoolGroups.map(({ school, teachers: ts }) => (
                    <div key={school.id}>
                      <div style={{ display: "flex", alignItems: "center", gap: 3, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 9, color: colors.textMuted, fontWeight: 600, flexShrink: 0 }}>{school.name.split(" ").filter(w => /^[A-Z]/.test(w)).map(w => w[0]).join("") || school.name.slice(0, 4).toUpperCase()}</span>
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

        return (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(" + stripDays.length + ", 1fr)", gap: 6, marginBottom: 10 }}>
              {stripDays.map(wd => renderDayCell(wd))}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 4, marginBottom: 2 }}>
              <button onClick={() => setCalendarWeekOffset(o => o - 1)}
                style={{ background: "none", border: "none", cursor: "pointer", color: colors.sidebarActive, fontWeight: 700, fontSize: 18, padding: "0 4px", lineHeight: 1 }}>‹</button>
              <span style={{ fontSize: 12, fontWeight: 600, color: colors.textMuted, letterSpacing: "0.05em" }}>
                {calWeekLabel}
              </span>
              <button onClick={() => setCalendarWeekOffset(o => o + 1)}
                style={{ background: "none", border: "none", cursor: "pointer", color: colors.sidebarActive, fontWeight: 700, fontSize: 18, padding: "0 4px", lineHeight: 1 }}>›</button>
            </div>
          </div>
        );
      })()}

      {/* ── Emails / To Do / Alerts — unified banner card ── */}
      {(() => {
        // Alerts data
        const unassignedStudents = students.filter(s => s.status === "active" && (s.instruments || []).some(i => !i.isGroup && !i.teacherId));
        const unschedEntries = timetable ? timetable.unscheduled.filter(u => u.reason !== "Unassigned") : [];
        // Incomplete student profiles — missing school, class, or parent contact
        const incompleteStudents = students.filter(s => {
          if (s.status !== "active" && s.status !== "pending") return false;
          const hasSchool = !!s.schoolId;
          const rawClass = (s.className || "").trim().toLowerCase();
          const hasClass = !!rawClass && !/^class\s*(times?|info|information|schedule|details?)?$/i.test(rawClass);
          const hasParent = (s.parents || []).some(p => (p.email || "").trim() || (p.phone || "").trim());
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
          return typeof cached === "object" ? !!cached?.needsReply : false;
        });
        const responseRequiredRed = allResponseRequired.filter(e => emailAgeMs(e) < startOfYesterday);
        const responseRequiredYellow = allResponseRequired.filter(e => emailAgeMs(e) >= startOfYesterday && emailAgeMs(e) < startOfToday);
        const responseRequiredBlue = allResponseRequired.filter(e => emailAgeMs(e) >= startOfToday);
        const pendingOnly = students.filter(s => s.status === "pending").reduce((sum, s) => sum + Math.max(1, (s.instruments || []).filter(i => !i.isGroup).length), 0);
        const trialOnly = students.filter(s => s.status === "trial").reduce((sum, s) => sum + Math.max(1, (s.instruments || []).filter(i => !i.isGroup).length), 0);
        // Interruptions: today through next 14 days
        const alertIntrEnd = toLocalDateStr((() => { const d = new Date(monday); d.setDate(d.getDate() + 14); return d; })());
        const upcomingInterruptions = interruptions.filter(i => i.type !== "term_break" && i.date >= todayStr && i.date <= alertIntrEnd);
        // Missed lessons: split this week (red) vs prior weeks (coral)
        const currentWeekKey = toLocalDateStr(monday);
        const missedThisWeek = Object.values((() => {
          const byStudent = {};
          for (const e of tallyEntries) {
            if (e.status !== "missed" || e.weekKey !== currentWeekKey) continue;
            const k = `${e.studentId}|${e.instrument}`;
            if (!byStudent[k]) byStudent[k] = { studentId: e.studentId, studentName: e.studentName, instrument: e.instrument, count: 0 };
            byStudent[k].count++;
          }
          return byStudent;
        })());
        const missedPriorSorted = (() => {
          // All makeup-eligible, un-made-up misses from prior weeks — no 14-day cap, no 2+ filter
          const byKey = {};
          for (const e of tallyEntries) {
            if (e.status !== "missed") continue;
            if (e.weekKey === currentWeekKey) continue;
            if (e.makeupEligible === false) continue;
            if (e.madeUp === true) continue;
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
        const warningCount = (unassignedCount > 0 && !isAlertDismissed("alert-unassigned") ? 1 : 0) + (unschedCount > 0 && !isAlertDismissed("alert-unscheduled") ? 1 : 0) + (incompleteStudents.length > 0 && !isAlertDismissed("alert-incomplete") ? 1 : 0) + (missedThisWeek.length > 0 && !isAlertDismissed("alert-missed-week") ? 1 : 0) + (responseRequiredRed.length > 0 && !isAlertDismissed("alert-response-red") ? 1 : 0);
        const totalAlerts = warningCount
          + (responseRequiredYellow.length > 0 && !isAlertDismissed("alert-response-yellow") ? 1 : 0)
          + (responseRequiredBlue.length > 0 && !isAlertDismissed("alert-response-blue") ? 1 : 0)
          + (upcomingInterruptions.filter(i => !isAlertDismissed(`alert-interruption-${i.id}`)).length > 0 ? 1 : 0)
          + (catchupTotal > 0 && !isAlertDismissed("alert-catchup") ? 1 : 0)
          + (pendingOnly > 0 && !pendingDismissed ? 1 : 0)
          + (trialOnly > 0 && !trialDismissed ? 1 : 0)
          + (lessonChangeEmails.length > 0 && !isAlertDismissed("alert-lesson-change") ? 1 : 0);

        const bothOpen = dashPanels.emails && dashPanels.todo;
        const anyPanelOpen = dashPanels.emails || dashPanels.todo || dashPanels.alerts;
        const togglePanel = (key) => saveDashPanels({ ...dashPanels, [key]: !dashPanels[key] });

        const CATEGORY_FILTERS = [
          { key: "pinned", label: "★" },
          { key: "parent", label: "Parents" },
          { key: "teacher", label: "Teachers" },
          { key: "staff", label: "Staff" },
          { key: "admin", label: "Admin" },
          { key: "enquiry", label: "Enquiries" },
          { key: "other", label: "Other" },
        ];
        const SCHOOL_FILTERS = schools.map(s => ({ key: `school:${s.id}`, label: s.name.split(" ").filter(w => /^[A-Z]/.test(w)).map(w => w[0]).join("").toUpperCase() || s.name.slice(0, 4).toUpperCase() }));

        const filteredEmails = (() => {
          // Use sent or inbox depending on folder, newest first
          let sorted = emailFolder === "sent" ? [...sentEmails] : [...inboxEmails];
          sorted.sort((a, b) => {
            const da = a.internalDate || (a.date ? new Date(a.date).getTime() : 0);
            const db = b.internalDate || (b.date ? new Date(b.date).getTime() : 0);
            return db - da;
          });
          // Text search — searches active folder; also searches sentEmails for inbox so
          // you can find threads by what you wrote, not just what was received.
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
                // Re-add inbox emails from matching threads that were filtered out
                const allInbox = [...inboxEmails];
                allInbox.sort((a, b) => {
                  const da = a.internalDate || (a.date ? new Date(a.date).getTime() : 0);
                  const db = b.internalDate || (b.date ? new Date(b.date).getTime() : 0);
                  return db - da;
                });
                const extraIds = new Set(sorted.map(e => e.id));
                const extras = allInbox.filter(e =>
                  matchedThreadIds.has(e.threadId || e.id) && !extraIds.has(e.id)
                );
                sorted = [...sorted, ...extras];
                sorted.sort((a, b) => {
                  const da = a.internalDate || (a.date ? new Date(a.date).getTime() : 0);
                  const db = b.internalDate || (b.date ? new Date(b.date).getTime() : 0);
                  return db - da;
                });
              }
            }
          }
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
                  // Sent FROM the school's sender address
                  if (school.senderEmail && fromAddr2 === school.senderEmail.toLowerCase()) return true;
                  // Any recipient is a parent of a student at this school
                  if (students.some(s => s.schoolId === schoolId && (s.parents || []).some(p => p.email && toAddrs.includes(p.email.toLowerCase())))) return true;
                  // Any recipient is a school contact
                  if (contacts.some(c => c.schoolId === schoolId && c.email && toAddrs.includes(c.email.toLowerCase()))) return true;
                  // Any recipient is a teacher with availability at this school
                  if (teachers.some(t => t.email && toAddrs.includes(t.email.toLowerCase()) && t.availability.some(a => a.schoolId === schoolId))) return true;
                } else {
                  if (school.senderEmail) { const toAddr = (e.deliveredTo || e.to || "").toLowerCase(); if (toAddr.includes(school.senderEmail.toLowerCase())) return true; }
                  if (students.some(s => s.schoolId === schoolId && (s.parents || []).some(p => p.email && p.email.toLowerCase() === fromAddr2))) return true;
                  if (contacts.some(c => c.schoolId === schoolId && c.email && c.email.toLowerCase() === fromAddr2)) return true;
                  if (teachers.some(t => t.email && t.email.toLowerCase() === fromAddr2 && t.availability.some(a => a.schoolId === schoolId))) return true;
                }
              }
              return false;
            });
          }
          return sorted;
        })();
        filteredEmailsRef.current = filteredEmails; // keep ref in sync for keyboard nav

        // Overdue level for a todo item: 0=today, 1=1 day overdue (coral), 2+=2+ days (red)
        // Uses todoDate (Melbourne YYYY-MM-DD stamped by saveTodo), not createdAt, so the
        // clock starts from when the item entered the list — not when the email was received.
        const todoOverdueLevel = (item) => {
          if (item.done || !item.todoDate) return 0;
          const todayDateStr = melbourneToday();
          if (item.todoDate >= todayDateStr) return 0;
          const diffDays = Math.round((new Date(todayDateStr + "T00:00:00").getTime() - new Date(item.todoDate + "T00:00:00").getTime()) / 86400000);
          return diffDays >= 2 ? 2 : 1;
        };

        const activeTodo = (() => {
          const raw = todoItems.filter(t => !t.done);
          // Stable sort: red (2+) → coral (1) → normal (0), preserving relative order within each tier
          const red    = raw.filter(t => todoOverdueLevel(t) >= 2);
          const coral  = raw.filter(t => todoOverdueLevel(t) === 1);
          const normal = raw.filter(t => todoOverdueLevel(t) === 0);
          return [...red, ...coral, ...normal];
        })();
        const doneTodo = todoItems.filter(t => t.done);

        // ungroupSub: pull a sub-item out of a group and insert as standalone
        const ungroupSub = (insertAtIdx) => {
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
          const clampedIdx = Math.max(0, Math.min(insertAtIdx, active.length));
          active.splice(clampedIdx, 0, standalone);
          saveTodo([...active, ...done]);
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
              const { rect, title, borderColor, items, sections } = alertDropdown;
              const renderItem = (item, i) => (
                <div
                  key={i}
                  draggable={!!item.dragPayload}
                  onDragStart={item.dragPayload ? () => { clearTimeout(alertDropdownTimer.current); setAlertDragging(item.dragPayload); } : undefined}
                  onDragEnd={item.dragPayload ? () => { setAlertDragging(null); setAlertDropdown(null); } : undefined}
                  style={{ padding: "4px 10px", background: item.chipBg || "#FEF2F2", border: `1px solid ${item.chipBorder || borderColor || colors.danger}`, borderRadius: 16, fontSize: 11, cursor: item.dragPayload ? "grab" : "default", display: "inline-flex", alignItems: "center", whiteSpace: "nowrap", userSelect: "none" }}>
                  <span style={{ color: item.chipColor || colors.danger, fontWeight: 700 }}>{item.label}</span>
                </div>
              );
              return (
                <div
                  style={{ position: "fixed", left: rect.left, top: rect.bottom + 6, zIndex: 9990, background: colors.white, border: `1.5px solid ${borderColor || colors.danger}`, borderRadius: 10, boxShadow: "0 4px 18px rgba(0,0,0,0.13)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, minWidth: 180, maxHeight: "60vh", overflowY: "auto", scrollbarWidth: "thin" }}
                  onMouseEnter={() => clearTimeout(alertDropdownTimer.current)}
                  onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}>
                  {title && <div style={{ fontSize: 10, fontWeight: 700, color: colors.textMuted, marginBottom: 2, letterSpacing: "0.04em" }}>{title}</div>}
                  {sections ? sections.map((section, si) => (
                    <div key={si} style={{ marginTop: si > 0 ? 8 : 0 }}>
                      {sections.length > 1 && section.headingDragPayload && (
                        <div
                          draggable
                          onDragStart={() => { clearTimeout(alertDropdownTimer.current); setAlertDragging(section.headingDragPayload); }}
                          onDragEnd={() => { setAlertDragging(null); setAlertDropdown(null); }}
                          style={{ padding: "4px 10px", background: colors.blueLight, border: `1px solid ${colors.sidebarActive}60`, borderRadius: 16, fontSize: 11, fontWeight: 700, cursor: "grab", display: "inline-flex", alignItems: "center", color: colors.sidebarActive, userSelect: "none", marginBottom: 4 }}>
                          {section.heading.split(" ").filter(w => /^[A-Z]/.test(w)).map(w => w[0]).join("").toUpperCase() || section.heading.slice(0, 4).toUpperCase()}
                        </div>
                      )}
                      {sections.length > 1 && !section.headingDragPayload && (
                        <div style={{ fontSize: 9, fontWeight: 700, color: colors.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", paddingBottom: 2, borderBottom: `1px solid ${colors.borderLight}`, marginBottom: 4 }}>{section.heading}</div>
                      )}
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {section.items.map(renderItem)}
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
                  style={{ position: "fixed", left: x, top: y, zIndex: 9995, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 9, boxShadow: "0 4px 18px rgba(0,0,0,0.14)", padding: "6px 4px", minWidth: 220 }}
                  onMouseDown={e => e.stopPropagation()}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: colors.textMuted, padding: "4px 12px 6px", letterSpacing: "0.04em" }}>CONTACT ALL PARENTS</div>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (allEmails.length) openCompose(allEmails, { triggerId: "todo_missed_group" }); setMissedContactMenu(null); }}>
                    📧 Send as group (all in To)
                  </button>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (perStudentItems.length) window._openComposeQueue && window._openComposeQueue(perStudentItems); setMissedContactMenu(null); }}>
                    📧 Send individually (preview each)
                  </button>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => {
                      if (allEmails.length) { const richBatch = (item.missedLessons || []).filter(ml => ml.parentEmail).map(ml => ({ addr: ml.parentEmail, ctx: { parent_name: preferredFirstName(ml.parentName) || "", student_name: (ml.studentName || "").split(" ")[0], school_name: "" } })); window._openComposeModal && window._openComposeModal({ to: [], batchTo: richBatch, subject: "", body: "" }); }
                      setMissedContactMenu(null);
                    }}>
                    ⚡ Send individually (compose once → auto-send)
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
                  style={{ position: "fixed", left: x, top: y, zIndex: 9995, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 9, boxShadow: "0 4px 18px rgba(0,0,0,0.14)", padding: "6px 4px", minWidth: 220 }}
                  onMouseDown={e => e.stopPropagation()}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: colors.textMuted, padding: "4px 12px 6px", letterSpacing: "0.04em" }}>CONTACT RE: CATCH-UPS</div>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (allEmails.length) openCompose(allEmails, { triggerId: "todo_catchup_group" }); setCatchupContactMenu(null); }}>
                    📧 Send as group (all in To)
                  </button>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (perParentItems.length) window._openComposeQueue && window._openComposeQueue(perParentItems); setCatchupContactMenu(null); }}>
                    📧 Send individually (preview each)
                  </button>
                  <button style={btnStyle}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => {
                      if (allEmails.length) { const richBatch = Object.values(byParent).filter(p => p.parentEmail).map(p => ({ addr: p.parentEmail, ctx: { parent_name: preferredFirstName(p.parentName) || "", student_name: "" } })); window._openComposeModal && window._openComposeModal({ to: [], batchTo: richBatch, subject: "Catch-up lesson", body: "" }); }
                      setCatchupContactMenu(null);
                    }}>
                    ⚡ Send individually (compose once → auto-send)
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
                (src?.emailId ? (inboxEmails.find(e => e.id === src.emailId)?.subject ? `Re: ${inboxEmails.find(e => e.id === src.emailId).subject}` : "") : "");
              const groupSubject = resolveSubject(item);
              const perItems = addrs.map(addr => {
                const sub = (item.subItems || []).find(s => s.replyTo === addr);
                return { to: [addr], subject: resolveSubject(sub) || groupSubject, triggerId: "todo_email_group", label: sub?.senderName || addr };
              }).filter(p => p.to[0]);
              const btnStyle = { display: "block", width: "100%", padding: "8px 14px", background: "none", border: "none", textAlign: "left", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: colors.text, borderRadius: 6 };
              return (
                <div style={{ position: "fixed", left: x, top: y, zIndex: 9995, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 9, boxShadow: "0 4px 18px rgba(0,0,0,0.14)", padding: "6px 4px", minWidth: 220 }}
                  onMouseDown={e => e.stopPropagation()}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: colors.textMuted, padding: "4px 12px 6px", letterSpacing: "0.04em" }}>CONTACT — {addrs.length} RECIPIENTS</div>
                  <button style={btnStyle} onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { openCompose(addrs, { subject: groupSubject }); setEmailGroupContactMenu(null); }}>
                    📧 Send as group (all in To)
                  </button>
                  <button style={btnStyle} onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (perItems.length) window._openComposeQueue && window._openComposeQueue(perItems); setEmailGroupContactMenu(null); }}>
                    📧 Send individually (preview each)
                  </button>
                  <button style={btnStyle} onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={() => { if (perItems.length) { const richBatch = addrs.map(addr => { const sub = (item.subItems || []).find(s => s.replyTo === addr); return { addr, ctx: { parent_name: sub?.senderName || "", student_name: "" } }; }); window._openComposeModal && window._openComposeModal({ to: [], batchTo: richBatch, subject: groupSubject, body: "" }); } setEmailGroupContactMenu(null); }}>
                    ⚡ Send individually (compose once → auto-send)
                  </button>
                </div>
              );
            })()}
            {emailGroupContactMenu && <div onClick={() => setEmailGroupContactMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 9994 }} />}
            {/* ── Unified banner: alerts card behind, pill floating, banner on top ── */}
            <div style={{ position: "relative", marginBottom: 20, overflow: "hidden", borderRadius: 12 }}>

              {/* Alerts card — 1.5× banner height, always behind (zIndex 0) */}
              {(() => {
                const bannerH = 42;
                const alertsH = Math.round(bannerH * 1.5); // 63px
                // Reusable dismiss button
                const DismissBtn = ({ groupType, color, onClick: customOnClick }) => (
                  <span
                    onClick={e => { e.stopPropagation(); customOnClick ? customOnClick() : dismissAlert(groupType); }}
                    style={{ marginLeft: 3, color: color || colors.danger, opacity: 0.45, fontSize: 13, lineHeight: 1, cursor: "pointer", padding: "0 1px", userSelect: "none" }}
                    onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                    onMouseLeave={e => e.currentTarget.style.opacity = "0.45"}
                  >×</span>
                );
                return (
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: alertsH, zIndex: 0,
                    background: "rgba(196,84,84,0.08)", border: `2px solid ${colors.danger}`, borderRadius: 12 }}>
                    <div style={{ padding: "0 12px 0 104px", display: "flex", gap: 10, flexWrap: "nowrap", alignItems: "center", height: 38, boxSizing: "border-box", overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none", msOverflowStyle: "none" }}>
                      {/* Red — blockers + urgent */}
                      {unassignedCount > 0 && !isAlertDismissed("alert-unassigned") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Assign teachers to ${unassignedCount} student${unassignedCount !== 1 ? "s" : ""}`, tag: "admin", groupType: "alert-unassigned", adminItems: unassignedStudents.map(s => ({ text: `${s.name} — ${(s.instruments || []).filter(i => !i.isGroup && !i.teacherId).map(i => i.name).join(", ")}` })) })} onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => { if (setStudentsViewState) setStudentsViewState(prev => ({ ...prev, filter: { ...prev.filter, hasWarning: "any" } })); onNavigate("students"); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: "UNASSIGNED", borderColor: colors.danger, items: unassignedStudents.map(s => { const instrs = (s.instruments || []).filter(i => !i.isGroup && !i.teacherId).map(i => i.name).join(", "); return { label: `${s.name} — ${instrs}`, chipColor: colors.danger }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: "#FEF2F2", border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.danger, fontWeight: 700 }}>{unassignedCount} unassigned</span>
                          <DismissBtn groupType="alert-unassigned" />
                        </div>
                      )}
                      {unschedCount > 0 && !isAlertDismissed("alert-unscheduled") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Schedule ${unschedCount} unscheduled student${unschedCount !== 1 ? "s" : ""} in timetable`, tag: "admin", groupType: "alert-unscheduled", adminItems: unschedEntries.map(u => ({ text: `${u.student.name} — ${u.instrument}${u.reason ? ` (${u.reason})` : ""}` })) })} onDragEnd={() => setAlertDragging(null)}
                          onClick={() => { const f = unschedEntries[0]; if (f && setSharedSchool) setSharedSchool(f.student.schoolId); onNavigate("timetable"); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: "UNSCHEDULED", borderColor: colors.danger, items: unschedEntries.map(u => ({ label: `${u.student.name} — ${u.instrument}${u.reason ? ` (${u.reason})` : ""}`, chipColor: colors.danger })) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: "#FEF2F2", border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.danger, fontWeight: 700 }}>{unschedCount} unscheduled</span>
                          <DismissBtn groupType="alert-unscheduled" />
                        </div>
                      )}
                      {incompleteStudents.length > 0 && !isAlertDismissed("alert-incomplete") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Complete profiles for ${incompleteStudents.length} student${incompleteStudents.length !== 1 ? "s" : ""}`, tag: "admin", groupType: "alert-incomplete", adminItems: incompleteStudents.map(s => { const missing = [!s.schoolId && "school", !s.className && "class", !(s.parents || []).some(p => p.email || p.phone) && "parent contact"].filter(Boolean).join(", "); return { text: `${s.name} — missing ${missing}` }; }) })} onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => onNavigate("students")}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: "INCOMPLETE PROFILES", borderColor: colors.danger, items: incompleteStudents.map(s => { const missing = [!s.schoolId && "school", !s.className && "class", !(s.parents || []).some(p => p.email || p.phone) && "parent contact"].filter(Boolean).join(", "); return { label: `${s.name} — missing ${missing}`, chipColor: colors.danger }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: "#FEF2F2", border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.danger, fontWeight: 700 }}>{incompleteStudents.length} incomplete profile{incompleteStudents.length !== 1 ? "s" : ""}</span>
                          <DismissBtn groupType="alert-incomplete" />
                        </div>
                      )}
                      {/* Response required — red (2+ days old) */}
                      {responseRequiredRed.length > 0 && !isAlertDismissed("alert-response-red") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Reply to ${responseRequiredRed.length} overdue email${responseRequiredRed.length !== 1 ? "s" : ""} requiring response`, tag: "email", groupType: "alert-response-red", responseEmails: responseRequiredRed })} onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => { saveDashPanels({ ...dashPanels, emails: true }); setEmailCategoryFilter(new Set()); setEmailSchoolFilter(new Set()); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: "RESPONSE OVERDUE", borderColor: colors.danger, items: responseRequiredRed.slice(0, 8).map(em => { const n = em.from?.includes("<") ? em.from.split("<")[0].trim().replace(/^"|"$/g, "") : em.from || "Unknown"; const senderEmail = em.from?.includes("<") ? em.from.match(/<(.+)>/)?.[1] || "" : em.from || ""; const d = em.date ? new Date(em.date).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""; return { label: `${n} — ${d}`, chipColor: colors.danger, dragPayload: { text: `Reply to ${n} re: ${em.subject || "(no subject)"}`, tag: "email", groupType: `alert-response-email-${em.id}`, responseEmails: [em] } }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: "#FEF2F2", border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.danger, fontWeight: 700 }}>↩ {responseRequiredRed.length} response overdue</span>
                          <DismissBtn groupType="alert-response-red" />
                        </div>
                      )}
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
                            onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: "MISSED THIS WEEK", borderColor: colors.danger, items: missedWithParents.map(m => ({ label: `${m.studentName} — ${m.count}`, chipColor: colors.danger, dragPayload: { text: `Contact ${(m.parentName || "parent").split(" ")[0]} re: ${(m.studentName || "").split(" ")[0]}'s ${m.count === 1 ? "missed lesson" : `${m.count} missed lessons`}`, tag: "lesson", groupType: `alert-missed-student-${m.studentId}`, missedLesson: m } })) }); }}
                            onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                            style={{ padding: "3px 10px", background: "#FEF2F2", border: `1px solid ${colors.danger}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                            <span style={{ color: colors.danger, fontWeight: 700 }}>{missedThisWeek.length} missed this week</span>
                            <DismissBtn groupType="alert-missed-week" />
                          </div>
                        );
                      })()}
                      {/* Yellow — response required yesterday */}
                      {responseRequiredYellow.length > 0 && !isAlertDismissed("alert-response-yellow") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Reply to ${responseRequiredYellow.length} email${responseRequiredYellow.length !== 1 ? "s" : ""} awaiting response`, tag: "email", groupType: "alert-response-yellow", responseEmails: responseRequiredYellow })} onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => { saveDashPanels({ ...dashPanels, emails: true }); setEmailCategoryFilter(new Set()); setEmailSchoolFilter(new Set()); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: "RESPONSE PENDING", borderColor: colors.warning, items: responseRequiredYellow.slice(0, 8).map(em => { const n = em.from?.includes("<") ? em.from.split("<")[0].trim().replace(/^"|"$/g, "") : em.from || "Unknown"; const d = em.date ? new Date(em.date).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : ""; return { label: `${n} — ${d}`, chipColor: colors.amberDark, chipBg: colors.amberLight, chipBorder: colors.warning, dragPayload: { text: `Reply to ${n} re: ${em.subject || "(no subject)"}`, tag: "email", groupType: `alert-response-email-${em.id}`, responseEmails: [em] } }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: colors.amberLight, border: `1px solid ${colors.warning}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.amberDark, fontWeight: 700 }}>↩ {responseRequiredYellow.length} response pending</span>
                          <DismissBtn groupType="alert-response-yellow" color={colors.warning} />
                        </div>
                      )}
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
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); const bySchool = {}; for (const s of catchupStudents) { const school = schools.find(sc => sc.id === s.schoolId); const key = school?.name || "Other"; if (!bySchool[key]) bySchool[key] = []; bySchool[key].push(s); } const sections = Object.entries(bySchool).map(([schoolName, sts]) => { const schoolStudents = sts; const schoolDragPayload = { text: `Arrange catch-ups — ${schoolName}`, tag: "lesson", groupType: `alert-catchup-school-${schoolName}`, catchupStudents: schoolStudents }; return { heading: schoolName, headingDragPayload: schoolDragPayload, items: sts.map(s => ({ label: `${s.studentName} — ${s.instrument || ""} (${s.count})`, chipColor: colors.accentDark, chipBg: "#FEF2F2", chipBorder: colors.accent, dragPayload: { text: `Contact ${preferredFirstName(s.parentName) || "parent"} re: ${preferredFirstName(s.studentName)}'s catch-up${s.count !== 1 ? "s" : ""}`, tag: "lesson", groupType: `alert-catchup-student-${s.studentId}-${s.instrument}`, catchupLesson: s } })) }; }); setAlertDropdown({ rect: r, title: "CATCH-UPS OWED", borderColor: colors.accent, sections }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: "#FEF2F2", border: `1px solid ${colors.accent}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.accentDark, fontWeight: 700 }}>{catchupTotal} catch-up{catchupTotal !== 1 ? "s" : ""} owed</span>
                          <DismissBtn groupType="alert-catchup" color={colors.accentDark} />
                        </div>
                        );
                      })()}
                      {(() => {
                        const visible = upcomingInterruptions.filter(i => !isAlertDismissed(`alert-interruption-${i.id}`));
                        if (visible.length === 0) return null;
                        const publicHols = visible.filter(i => i.type === "public_holiday");
                        const schoolEvents = visible.filter(i => i.type !== "public_holiday");
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
                        const chipStyle = (bg, border, color) => ({ padding: "3px 10px", background: bg, border: `1px solid ${border}`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" });
                        return (
                          <>
                            {/* Public holidays — single chip or grouped */}
                            {publicHols.length === 1 && (
                              <div draggable
                                onDragStart={() => setAlertDragging(singleIntrPayload(publicHols[0]))}
                                onDragEnd={() => { setAlertDragging(null); }}
                                style={chipStyle("#FEF2F2", colors.danger, colors.danger)}>
                                <span style={{ color: colors.danger, fontWeight: 700 }}>📅 {publicHols[0].title} — {dateLabel(publicHols[0])}</span>
                                <DismissBtn groupType={`alert-interruption-${publicHols[0].id}`} color={colors.danger} />
                              </div>
                            )}
                            {publicHols.length > 1 && (
                              <div draggable
                                onDragStart={() => setAlertDragging(multiIntrPayload(publicHols, "Public Holidays"))}
                                onDragEnd={() => { setAlertDragging(null); }}
                                onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: "PUBLIC HOLIDAYS", borderColor: colors.danger, items: publicHols.map(i => ({ label: `${i.title} — ${dateLabel(i)}`, chipColor: colors.danger, chipBg: "#FEF2F2", chipBorder: colors.danger, dragPayload: singleIntrPayload(i) })) }); }}
                                onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                                style={chipStyle("#FEF2F2", colors.danger, colors.danger)}>
                                <span style={{ color: colors.danger, fontWeight: 700 }}>📅 Public Holidays — {publicHols.length}</span>
                                <DismissBtn groupType={`alert-interruption-ph-group`} color={colors.danger} onClick={() => publicHols.forEach(i => dismissAlert(`alert-interruption-${i.id}`))} />
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
                                    style={chipStyle("#FEF2F2", colors.accentDark, colors.accentDark)}>
                                    <span style={{ color: colors.accentDark, fontWeight: 700 }}>🚧 {acronym} — {intr.title}</span>
                                    <DismissBtn groupType={`alert-interruption-${intr.id}`} color={colors.accentDark} />
                                  </div>
                                );
                              }
                              return (
                                <div key={schoolId} draggable
                                  onDragStart={() => setAlertDragging(multiIntrPayload(intrs, acronym))}
                                  onDragEnd={() => { setAlertDragging(null); }}
                                  onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: `${acronym} INTERRUPTIONS`, borderColor: colors.accentDark, items: intrs.map(i => ({ label: `${i.title} — ${dateLabel(i)}`, chipColor: colors.accentDark, chipBg: "#FEF2F2", chipBorder: `${colors.accentDark}60`, dragPayload: singleIntrPayload(i) })) }); }}
                                  onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                                  style={chipStyle("#FEF2F2", colors.accentDark, colors.accentDark)}>
                                  <span style={{ color: colors.accentDark, fontWeight: 700 }}>🚧 {acronym} — {intrs.length} events</span>
                                  <DismissBtn groupType={`alert-interruption-school-${schoolId}`} color={colors.accentDark} onClick={() => intrs.forEach(i => dismissAlert(`alert-interruption-${i.id}`))} />
                                </div>
                              );
                            })}
                          </>
                        );
                      })()}
                      {/* Blue — response required today + informational */}
                      {responseRequiredBlue.length > 0 && !isAlertDismissed("alert-response-blue") && (
                        <div draggable onDragStart={() => setAlertDragging({ text: `Reply to ${responseRequiredBlue.length} email${responseRequiredBlue.length !== 1 ? "s" : ""} with questions today`, tag: "email", groupType: "alert-response-blue", responseEmails: responseRequiredBlue })} onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => { saveDashPanels({ ...dashPanels, emails: true }); setEmailCategoryFilter(new Set()); setEmailSchoolFilter(new Set()); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: "QUESTIONS TODAY", borderColor: `${colors.sidebarActive}80`, items: responseRequiredBlue.slice(0, 8).map(em => { const n = em.from?.includes("<") ? em.from.split("<")[0].trim().replace(/^"|"$/g, "") : em.from || "Unknown"; return { label: `${n} — today`, chipColor: colors.sidebarActive, chipBg: colors.blueLight, chipBorder: `${colors.sidebarActive}40`, dragPayload: { text: `Reply to ${n} re: ${em.subject || "(no subject)"}`, tag: "email", groupType: `alert-response-email-${em.id}`, responseEmails: [em] } }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: colors.blueLight, border: `1px solid ${colors.sidebarActive}40`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.sidebarActive, fontWeight: 700 }}>↩ {responseRequiredBlue.length} question{responseRequiredBlue.length !== 1 ? "s" : ""} today</span>
                          <DismissBtn groupType="alert-response-blue" color={colors.sidebarActive} />
                        </div>
                      )}
                      {/* Lesson change requests from parents */}
                      {lessonChangeEmails.length > 0 && !isAlertDismissed("alert-lesson-change") && (
                        <div draggable
                          onDragStart={() => setAlertDragging({ text: `Review ${lessonChangeEmails.length} lesson change request${lessonChangeEmails.length !== 1 ? "s" : ""}`, tag: "email", groupType: "alert-lesson-change", responseEmails: lessonChangeEmails })}
                          onDragEnd={() => { setAlertDragging(null); setTodoDropTarget(false); }}
                          onClick={() => { saveDashPanels({ ...dashPanels, emails: true }); setEmailCategoryFilter(new Set(["parent"])); setEmailSchoolFilter(new Set()); }}
                          onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: "LESSON CHANGE REQUESTS", borderColor: colors.warning, items: lessonChangeEmails.slice(0, 8).map(em => { const n = em.from?.includes("<") ? em.from.split("<")[0].trim().replace(/^"|"$/g, "") : em.from || "Unknown"; return { label: `${n} — ${em.subject || "(no subject)"}`, chipColor: colors.warning, chipBg: "#FFF7ED", chipBorder: `${colors.warning}60`, dragPayload: { text: `Reply to ${n} re: ${em.subject || "lesson change"}`, tag: "email", groupType: `alert-lesson-change-${em.id}`, responseEmails: [em] } }; }) }); }}
                          onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                          style={{ padding: "3px 10px", background: "#FFF7ED", border: `1px solid ${colors.warning}60`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ color: colors.amberDark, fontWeight: 700 }}>🔄 {lessonChangeEmails.length} lesson change{lessonChangeEmails.length !== 1 ? "s" : ""}</span>
                          <DismissBtn groupType="alert-lesson-change" color={colors.amberDark} />
                        </div>
                      )}
                      {pendingOnly > 0 && !pendingDismissed && (() => {
                        const pendingStudents = students.filter(s => s.status === "pending").flatMap(s =>
                          (s.instruments || []).filter(i => !i.isGroup).map(i => ({
                            studentId: s.id, studentName: s.name, instrument: i.name,
                            parentName: s.parents?.[0]?.name || "", parentEmail: s.parents?.[0]?.email || ""
                          }))
                        );
                        return (
                          <div draggable onDragStart={() => setAlertDragging({ text: `Follow up ${pendingOnly} pending student${pendingOnly !== 1 ? "s" : ""}`, tag: "admin", groupType: "alert-pending", pendingOrTrialStudents: pendingStudents })} onDragEnd={() => setAlertDragging(null)}
                            onClick={() => onNavigate("pending")}
                            onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: "PENDING STUDENTS", borderColor: `${colors.sidebarActive}80`, items: pendingStudents.map(s => ({ label: `${s.studentName} — ${s.instrument}`, chipColor: colors.sidebarActive, chipBg: colors.blueLight, chipBorder: `${colors.sidebarActive}40`, dragPayload: { text: `Contact ${preferredFirstName(s.parentName) || "parent"} re: ${preferredFirstName(s.studentName)}'s pending enrolment (${s.instrument})`, tag: "admin", groupType: `alert-pending-student-${s.studentId}-${s.instrument}`, pendingOrTrialLesson: s } })) }); }}
                            onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                            style={{ padding: "3px 10px", background: colors.blueLight, border: `1px solid ${colors.sidebarActive}40`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                            <span style={{ color: colors.sidebarActive, fontWeight: 700 }}>{pendingOnly} pending</span>
                            <DismissBtn groupType="alert-pending" color={colors.sidebarActive} />
                          </div>
                        );
                      })()}
                      {trialOnly > 0 && !trialDismissed && (() => {
                        const trialStudents = students.filter(s => s.status === "trial").flatMap(s =>
                          (s.instruments || []).filter(i => !i.isGroup).map(i => ({
                            studentId: s.id, studentName: s.name, instrument: i.name,
                            parentName: s.parents?.[0]?.name || "", parentEmail: s.parents?.[0]?.email || ""
                          }))
                        );
                        return (
                          <div draggable onDragStart={() => setAlertDragging({ text: `Follow up ${trialOnly} trial student${trialOnly !== 1 ? "s" : ""}`, tag: "admin", groupType: "alert-trial", pendingOrTrialStudents: trialStudents })} onDragEnd={() => setAlertDragging(null)}
                            onClick={() => onNavigate("pending")}
                            onMouseEnter={e => { clearTimeout(alertDropdownTimer.current); const r = e.currentTarget.getBoundingClientRect(); setAlertDropdown({ rect: r, title: "TRIAL STUDENTS", borderColor: `${colors.sidebarActive}80`, items: trialStudents.map(s => ({ label: `${s.studentName} — ${s.instrument}`, chipColor: colors.sidebarActive, chipBg: colors.blueLight, chipBorder: `${colors.sidebarActive}40`, dragPayload: { text: `Contact ${preferredFirstName(s.parentName) || "parent"} re: ${preferredFirstName(s.studentName)}'s trial (${s.instrument})`, tag: "admin", groupType: `alert-trial-student-${s.studentId}-${s.instrument}`, pendingOrTrialLesson: s } })) }); }}
                            onMouseLeave={() => { alertDropdownTimer.current = setTimeout(() => setAlertDropdown(null), 200); }}
                            style={{ padding: "3px 10px", background: colors.blueLight, border: `1px solid ${colors.sidebarActive}40`, borderRadius: 20, fontSize: 11, cursor: "grab", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                            <span style={{ color: colors.sidebarActive, fontWeight: 700 }}>{trialOnly} trial</span>
                            <DismissBtn groupType="alert-trial" color={colors.sidebarActive} />
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
              <div onClick={() => togglePanel("alerts")}
                style={{ position: "absolute", left: 10, top: 9, zIndex: 5,
                  display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 12,
                  background: dashPanels.alerts ? colors.danger : totalAlerts > 0 ? colors.danger : colors.sidebarActive,
                  cursor: "pointer", transition: "background 0.15s", userSelect: "none",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.3)" }}
                onMouseEnter={e => { e.currentTarget.style.background = colors.accentDark; }}
                onMouseLeave={e => { e.currentTarget.style.background = dashPanels.alerts ? colors.danger : totalAlerts > 0 ? colors.danger : colors.sidebarActive; }}>
                <span style={{ fontWeight: 700, fontSize: 11, color: "#fff", letterSpacing: "0.03em" }}>Alerts</span>
                {totalAlerts > 0 && <span style={{ fontSize: 10, fontWeight: 700, background: "rgba(255,255,255,0.3)", color: "#fff", borderRadius: 8, padding: "0px 5px" }}>{totalAlerts}</span>}
                {totalAlerts === 0 && Object.keys(alertDismissals.dismissed).length > 0 && (
                  <span
                    onClick={e => { e.stopPropagation(); const reset = { date: todayStr, dismissed: {} }; setAlertDismissals(reset); try { localStorage.setItem(STORAGE_KEYS.alertDismissals, JSON.stringify(reset)); } catch {} }}
                    title="Restore dismissed alerts"
                    style={{ fontSize: 12, color: "#fff", opacity: 0.85, lineHeight: 1, cursor: "pointer" }}
                    onMouseEnter={e => { e.stopPropagation(); e.currentTarget.style.opacity = "1"; }}
                    onMouseLeave={e => { e.stopPropagation(); e.currentTarget.style.opacity = "0.85"; }}>↺</span>
                )}
              </div>

              {/* Banner card — z-index 1, sits above the alerts card */}
              <div ref={panelCardRef} style={{ position: "relative", zIndex: 1 }}>
                <Card style={{ marginBottom: 0, padding: 0, overflow: "hidden" }}>

                  {/* ── Header bar ── */}
                  <div style={{ background: colors.sidebarActive, borderRadius: anyPanelOpen ? "12px 12px 0 0" : 12, display: "flex", alignItems: "stretch", userSelect: "none", position: "relative" }}>

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
                          {/* Inbox / Sent pills */}
                          {["inbox", "sent"].map(folder => (
                            <button key={folder} onClick={() => {
                              setEmailFolder(folder);
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
                              style={{ padding: "5px 12px", borderRadius: 7, border: emailFolder === folder ? `1.5px solid ${colors.sidebarActive}` : `1px solid ${colors.border}`, background: emailFolder === folder ? colors.blueLight : colors.white, color: emailFolder === folder ? colors.sidebarActive : colors.textLight, fontSize: 12, fontWeight: emailFolder === folder ? 700 : 400, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                              {folder === "inbox" ? "Inbox" : "Sent"}
                            </button>
                          ))}
                          {/* Auto-send undo toast — replaces search+fetch space when active */}
                          {autoSendQueue.length > 0 ? (
                            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, background: colors.amberLight, border: `1px solid ${colors.warning}`, borderRadius: 7, padding: "5px 10px", minWidth: 0 }}>
                              <span style={{ fontSize: 11, color: colors.amberDark, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                ↻ Sending {autoSendQueue[0]?.label || autoSendQueue[0]?.to?.[0] || "email"}{autoSendQueue.length > 1 ? ` (+${autoSendQueue.length - 1} queued)` : ""}…
                              </span>
                              <button onClick={() => { clearTimeout(autoSendTimerRef.current); autoSendActiveRef.current = false; setAutoSendQueue([]); notify("Auto-send cancelled", "warning"); }}
                                style={{ padding: "2px 8px", borderRadius: 5, border: `1px solid ${colors.warning}`, background: colors.white, color: colors.amberDark, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                                Undo
                              </button>
                            </div>
                          ) : (
                            <div style={{ position: "relative", flex: 1 }}>
                              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: colors.textMuted, pointerEvents: "none" }}>🔍</span>
                              <input value={emailSearch} onChange={e => setEmailSearch(e.target.value)}
                                placeholder="Search…"
                                style={{ width: "100%", boxSizing: "border-box", paddingLeft: 30, paddingRight: emailSearch ? 26 : 8, paddingTop: 6, paddingBottom: 6, border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", color: colors.text, outline: "none", background: colors.white }} />
                              {emailSearch && (
                                <button onClick={() => setEmailSearch("")}
                                  style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: colors.textMuted, lineHeight: 1, padding: 0, display: "flex", alignItems: "center" }}>
                                  ×
                                </button>
                              )}
                            </div>
                          )}
                          <button onClick={() => emailFolder === "sent" ? fetchSent() : fetchInbox()} disabled={inboxLoading || sentLoading} title="Refresh"
                            style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${colors.border}`, background: (inboxLoading || sentLoading) ? colors.bg : colors.white, color: (inboxLoading || sentLoading) ? colors.textMuted : colors.text, cursor: (inboxLoading || sentLoading) ? "default" : "pointer", fontSize: 14, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
                            <span style={{ display: "inline-block", animation: (inboxLoading || sentLoading) ? "spin 1s linear infinite" : "none" }}>↻</span>
                            {inboxError && <span onClick={() => console.error('Inbox error:', inboxError)} style={{ fontSize: 11, color: colors.danger, cursor: "pointer" }} title={inboxError}>Error ⓘ</span>}
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
                                  border: active ? `1.5px solid ${colors.sidebarActive}` : `1px solid ${colors.border}`,
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
                              return (
                                <button key={ft.key} onClick={() => setEmailSchoolFilter(prev => { const next = new Set(prev); active ? next.delete(ft.key) : next.add(ft.key); return next; })}
                                  style={{ padding: "3px 9px", borderRadius: 12,
                                    border: active ? `1.5px solid ${colors.accent}` : `1px solid ${colors.border}`,
                                    background: active ? colors.accentLight : "transparent",
                                    color: active ? colors.accentDark : colors.textMuted,
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
                        {filteredEmails.length === 0 ? (
                          <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "12px 16px" }}>
                            {emailFolder === "sent"
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
                              // Reply-all recipients: extract all To/CC addresses excluding own address
                              const allRecipients = [fromAddr, ...(email.cc || "").split(",").map(s => s.trim()).filter(Boolean)].filter(Boolean);
                              const dateObj = email.date ? new Date(email.date) : null;
                              const dateStr = dateObj && !isNaN(dateObj) ? dateObj.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "";
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
                                    e.preventDefault();
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
                                        ✕<br/>{emailFolder === "sent" ? "Dismiss" : "Archive"}
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
                                        {isRead ? "●" : "○"}<br/>{isRead ? "Unread" : "Read"}
                                      </button>
                                      {/* Reply */}
                                      <button onClick={e => {
                                        e.stopPropagation();
                                        const replyAddr = email.from?.match(/<(.+)>/)?.[1] || email.from || "";
                                        openCompose([replyAddr], { subject: `Re: ${email.subject || ""}`, body: "" });
                                        emailSwipeRef.current[email.id] = 0;
                                        setEmailSwipeState(prev => ({ ...prev, [email.id]: 0 }));
                                      }} style={{ flex: 1, background: colors.accent, border: "none", borderLeft: "1px solid rgba(255,255,255,0.15)", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", lineHeight: 1.3 }}>
                                        ✉<br/>Reply
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
                                      background: emailSelectedIds.has(email.id) ? "#E8EDF4" : isSelected ? "#F0F2F6" : (isPinned ? "#FFFBEB" : colors.white),
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
                                    {emailFolder !== "sent" && (
                                      <span style={{ flexShrink: 0, width: 14, display: "flex", alignItems: "flex-start", justifyContent: "center", marginTop: 3 }}>
                                        {!isRead
                                          ? <span style={{ width: 7, height: 7, borderRadius: "50%", background: colors.sidebarActive, display: "inline-block", marginTop: 2, flexShrink: 0 }} />
                                          : isReplied
                                            ? <span title="Replied" style={{ fontSize: 11, color: colors.sidebarActive, lineHeight: 1, opacity: 0.75 }}>↩</span>
                                            : null
                                        }
                                      </span>
                                    )}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      {/* Sender / Recipient row */}
                                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                        <span style={{ fontWeight: 700, fontSize: 13, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                          {emailFolder === "sent" && <span style={{ fontWeight: 400, color: colors.textMuted, marginRight: 3 }}>To:</span>}
                                          {fromName}
                                        </span>
                                        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                                          {needsReply && <span title="Response required" style={{ fontSize: 10, color: colors.danger, fontWeight: 700, lineHeight: 1 }}>↩</span>}
                                          {hasAttachment && <span title="Has attachment" style={{ fontSize: 10, color: colors.textMuted }}>📎</span>}
                                          {threadCount > 1 && <span style={{ fontSize: 10, fontWeight: 700, background: colors.tagBg, color: colors.textLight, borderRadius: 8, padding: "1px 5px" }}>{threadCount}</span>}
                                          <span style={{ fontSize: 11, color: colors.textMuted }}>{dateStr}</span>
                                          {emailFolder !== "sent" && <button onClick={e => { e.stopPropagation(); togglePin(email.id); }} title={isPinned ? "Unpin" : "Pin"}
                                            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: isPinned ? colors.warning : colors.textMuted, padding: "0 2px", lineHeight: 1 }}>
                                            {isPinned ? "★" : "☆"}
                                          </button>}
                                          <span style={{ fontSize: 11, color: colors.textMuted }}>{isSelected ? "▲" : "▼"}</span>
                                        </div>
                                      </div>
                                      {/* Subject — bold, smaller */}
                                      <div style={{ fontWeight: 600, fontSize: 12, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>{email.subject || "(no subject)"}</div>
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
                                                  style={{ padding: "3px 10px", borderRadius: 12, border: isActive ? `1.5px solid ${colors.sidebarActive}` : `1px solid ${colors.border}`,
                                                    background: isActive ? colors.blueLight : m.isSent ? colors.bg : colors.white,
                                                    color: isActive ? colors.sidebarActive : m.isSent ? colors.textMuted : colors.text,
                                                    fontSize: 11, fontWeight: isActive ? 700 : 400, cursor: "pointer", fontFamily: "inherit",
                                                    fontStyle: m.isSent ? "italic" : "normal",
                                                    display: "inline-flex", alignItems: "center", gap: 4 }}>
                                                  {chipReplied && <span title="Replied" style={{ fontSize: 10, opacity: 0.75, lineHeight: 1 }}>↩</span>}
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
                                        <span style={{ fontWeight: 600, color: colors.text }}>{activeFromName}</span>
                                        <span> &lt;{activeFromAddr}&gt;</span>
                                        {activeMsg?.to && <span style={{ marginLeft: 8, fontSize: 11 }}>To: {activeMsg.to}</span>}
                                      </div>

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
                                            if (sel) setEmailContextMenu({ x: e.clientX, y: e.clientY, text: sel, emailId: email.id });
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
                                          return (
                                            <div
                                              key={`${activeMsgId}-${suppressPatterns.length}`}
                                              onClick={e => { const a = e.target.closest("a"); if (a?.href) { e.preventDefault(); if (window.electronAPI?.openExternal) window.electronAPI.openExternal(a.href); else window.open(a.href, "_blank"); } }}
                                              {...bodyContextHandlers}
                                              className="mt-email-body"
                                              dangerouslySetInnerHTML={{ __html: getCleanHtml(bodyHtml, { showHistory: activeMsgHistoryShown, showSig: false, suppressPatterns }) }}
                                              style={{ fontSize: 13, color: "#1f2937", lineHeight: 1.65, marginBottom: activeMsgHasHistory ? 4 : 12, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", userSelect: "text", wordBreak: "break-word", overflowWrap: "break-word" }}
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

                                      {/* Attachment badges — click to download, drag to Claude or To Do */}
                                      {(activeMsg?.attachments || []).length > 0 && (
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8, marginTop: 4 }}>
                                          {(activeMsg.attachments).map((att, i) => (
                                            <button key={i}
                                              draggable
                                              onDragStart={() => { setAttachmentDragging({ att, messageId: activeMsg.messageId || activeMsg.id }); setTodoDropTarget(true); window._pendingAttachmentDrag = { att, messageId: activeMsg.messageId || activeMsg.id }; }}
                                              onDragEnd={() => { setAttachmentDragging(null); setTodoDropTarget(false); window._pendingAttachmentDrag = null; }}
                                              onClick={e => {
                                                e.stopPropagation();
                                                if (window.electronAPI?.gmailGetAttachment) {
                                                  window.electronAPI.gmailGetAttachment(activeMsg.messageId || activeMsg.id, att.attachmentId, att.filename)
                                                    .then(r => { if (!r.ok && r.error !== "Cancelled") alert("Download failed: " + r.error); });
                                                }
                                              }}
                                              style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 11, color: colors.textLight, cursor: "pointer", fontFamily: "inherit" }}>
                                              <span style={{ fontSize: 13 }}>📎</span>
                                              <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.filename}</span>
                                              {att.size > 0 && <span style={{ color: colors.textMuted, flexShrink: 0 }}>{att.size > 1024*1024 ? `${(att.size/1024/1024).toFixed(1)}MB` : `${Math.round(att.size/1024)}KB`}</span>}
                                            </button>
                                          ))}
                                        </div>
                                      )}

                                      {/* History toggle for this message */}
                                      {activeMsgHasHistory && (
                                        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                                          <button onClick={e => {
                                            e.stopPropagation();
                                            const id = activeMsgId || email.id;
                                            const wasShown = activeMsgHistoryShown;
                                            setEmailHistoryExpanded(prev => { const next = new Set(prev); wasShown ? next.delete(id) : next.add(id); return next; });
                                            if (wasShown) {
                                              requestAnimationFrame(() => {
                                                const row = emailListRef.current?.querySelector(`[data-emailid="${email.id}"]`);
                                                const list = emailListRef.current;
                                                if (row && list) {
                                                  const rowTop = row.getBoundingClientRect().top;
                                                  const listTop = list.getBoundingClientRect().top;
                                                  list.scrollTop += rowTop - listTop - 8;
                                                }
                                              });
                                            }
                                          }}
                                            style={{ background: "none", border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 11, color: colors.textMuted, cursor: "pointer", padding: "2px 10px", fontFamily: "inherit" }}>
                                            {activeMsgHistoryShown ? "Hide previous messages" : "Show previous messages"}
                                          </button>
                                        </div>
                                      )}

                                      {/* Suggested reply draft */}
                                      {draft && (
                                        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, padding: "10px 12px", marginBottom: 10, fontSize: 13, color: colors.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                                          <div style={{ fontSize: 11, fontWeight: 700, color: colors.accent, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>✦ Suggested reply</div>
                                          {draft}
                                        </div>
                                      )}

                                      {/* Response flagged chip — dismissible */}
                                      {needsReply && !emailNoReplyOverrides.has(email.id) && (
                                        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", background: colors.amberLight, border: `1px solid ${colors.warning}40`, borderRadius: 20, marginBottom: 10, alignSelf: "flex-start" }}>
                                          <span style={{ fontSize: 11, color: colors.amberDark, fontWeight: 600 }}>↩ Response flagged</span>
                                          <button onMouseDown={e => e.preventDefault()} onClick={() => {
                                            const next = new Set(emailNoReplyOverrides); next.add(email.id);
                                            setEmailNoReplyOverrides(next);
                                            try { localStorage.setItem(STORAGE_KEYS.emailNoReplyOverrides, JSON.stringify([...next])); } catch {}
                                          }} style={{ background: "none", border: "none", cursor: "pointer", color: colors.amberDark, fontSize: 13, lineHeight: 1, padding: 0, opacity: 0.7 }}>×</button>
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
                                        if (lessons.length === 0) return null;
                                        return (
                                          <div style={{ marginBottom: 10, padding: "8px 12px", background: colors.blueLight, borderRadius: 8, border: `1px solid ${colors.sidebarActive}30`, cursor: "pointer" }}
                                            onClick={() => { const school = schools.find(s => s.id === lessons[0]?.schoolId); if (school) { setSharedSchool(school.id); onNavigate(hasWeeklyData ? "weekly" : "timetable"); } }}
                                            onMouseEnter={e => e.currentTarget.style.opacity = "0.85"}
                                            onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
                                            <div style={{ fontSize: 11, fontWeight: 700, color: colors.sidebarActive, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>
                                              📅 {hasWeeklyData ? "This week's lessons" : "Scheduled lessons"} ↗
                                            </div>
                                            {lessons.map(l => {
                                              const st = linkedStudents.find(s => s.id === l.studentId);
                                              const school = schools.find(s => s.id === l.schoolId);
                                              return (
                                                <div key={l.id}
                                                  onClick={e => { e.stopPropagation(); if (school) { setSharedSchool(school.id); onNavigate(hasWeeklyData ? "weekly" : "timetable"); } }}
                                                  style={{ fontSize: 12, color: colors.text, lineHeight: 1.6, display: "flex", alignItems: "center", gap: 4 }}>
                                                  <strong>{st?.name}</strong> — {l.instrument} · {l.day} {l.start}
                                                  {school && lessons.some((x, i) => i > 0 && x.schoolId !== lessons[0].schoolId) ? <span style={{ color: colors.textMuted }}> · {school.name}</span> : null}
                                                </div>
                                              );
                                            })}
                                          </div>
                                        );
                                      })()}
                                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                        {emailFolder !== "sent" && <Btn onClick={() => { openCompose([activeFromAddr], { subject: `Re: ${email.subject}`, body: draft || "" }); markRead(email.id); }} style={{ fontSize: 12 }}>✉ Reply{draft ? " with draft" : ""}</Btn>}
                                        {emailFolder !== "sent" && allRecipients.length > 1 && (
                                          <Btn variant="secondary" onClick={() => { openCompose(allRecipients, { subject: `Re: ${email.subject}`, body: draft || "" }); markRead(email.id); }} style={{ fontSize: 12 }}>✉ Reply All</Btn>
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
                                              <Btn variant="secondary" onClick={e => { e.stopPropagation(); setEmailMoveToOpen(isOpen ? null : email.id); }} style={{ fontSize: 12 }}>
                                                📁 {currentLabel} {emailCategoryOverrides[email.id] ? "●" : ""}
                                              </Btn>
                                              {isOpen && (
                                                <>
                                                  <div onClick={() => setEmailMoveToOpen(null)} style={{ position: "fixed", inset: 0, zIndex: 9997 }} />
                                                  <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, zIndex: 9998, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.13)", minWidth: 130, overflow: "hidden", fontFamily: "inherit" }}>
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
                                                        ↩ Reset to auto
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
                        background: colors.sidebar, borderRadius: 10, padding: "10px 14px",
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
                            style={{ padding: "4px 11px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.25)", background: "none", color: "#fff", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                            📁 Move To ▾
                          </button>
                          {bulkMoveOpen && (
                            <>
                              <div onClick={() => setBulkMoveOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 9997 }} />
                              <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, zIndex: 9998, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.13)", minWidth: 130, overflow: "hidden" }}>
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
                          style={{ marginLeft: "auto", background: "none", border: "none", color: "rgba(255,255,255,0.5)", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: "0 2px" }}>×</button>
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
                      <div style={{ padding: "12px 16px 0" }}>
                        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                          <div style={{ flex: 1, position: "relative" }}>
                            <input value={todoInput} onChange={e => setTodoInput(e.target.value)}
                              onKeyDown={e => { if (e.key === "Enter" && todoInput.trim()) { saveTodo([{ id: uid(), text: todoInput.trim(), done: false, tag: "manual", createdAt: new Date().toISOString() }, ...todoItems]); setTodoInput(""); } }}
                              placeholder="Add a task… (press Enter)"
                              style={{ width: "100%", boxSizing: "border-box", padding: "7px 28px 7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", background: colors.white }} />
                            {todoInput && (
                              <button onClick={() => setTodoInput("")}
                                style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: colors.textMuted, lineHeight: 1, padding: 0 }}>×</button>
                            )}
                          </div>
                        </div>
                        {(emailDragging || alertDragging) && (
                          <div style={{ padding: "10px", border: `2px dashed ${colors.accent}`, borderRadius: 8, marginBottom: 10, textAlign: "center", fontSize: 12, color: colors.accent, fontWeight: 600 }}>
                            Drop here to add as task
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
                            {/* ── Gap before first item ── */}
                            {(emailDragging || alertDragging || todoDragIdxRef.current !== null || todoSubDragRef.current) && (
                              <div
                                onDragOver={e => { e.preventDefault(); e.stopPropagation(); setTodoDropZoneIdx(0); }}
                                onDragLeave={() => setTodoDropZoneIdx(null)}
                                onDrop={e => {
                                  e.preventDefault(); e.stopPropagation();
                                  setTodoDropZoneIdx(null);
                                  if (todoSubDragRef.current) { ungroupSub(0); return; }
                                  if (alertDragging) { saveTodo(handleAlertDrop(alertDragging, todoItemsRef.current)); setAlertDragging(null); setTodoDropTarget(false); return; }
                                  const srcIdx = todoDragIdxRef.current;
                                  if (srcIdx === null) return;
                                  const items = todoItemsRef.current;
                                  const active = items.filter(t => !t.done);
                                  const done = items.filter(t => t.done);
                                  const reordered = [...active];
                                  const [moved] = reordered.splice(srcIdx, 1);
                                  reordered.splice(0, 0, moved);
                                  saveTodo([...reordered, ...done]);
                                  setTodoDragIdx(null); todoDragIdxRef.current = null;
                                }}
                                style={{ height: todoDropZoneIdx === 0 ? 32 : 16, transition: "height 0.12s", display: "flex", alignItems: "center", marginBottom: 0, padding: "0 4px" }}>
                                {todoDropZoneIdx === 0 && <div style={{ flex: 1, height: 3, borderRadius: 2, background: colors.accent }} />}
                              </div>
                            )}
                            {activeTodo.map((item, idx) => {
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
                                  {/* Item card — handles grouping only */}
                                  {(() => {
                                    const ol = todoOverdueLevel(item);
                                    const cardBg     = ol >= 2 ? "#FDF3F3" : ol === 1 ? "#FDF5F2" : "rgba(52,69,101,0.1)";
                                    const cardBorder = ol >= 2 ? "#CC9999"  : ol === 1 ? "#D4A898" : "rgba(52,69,101,0.1)";
                                    const overdueBadge = ol >= 2
                                      ? <span style={{ fontSize: 10, fontWeight: 600, color: "#B07070", whiteSpace: "nowrap", flexShrink: 0 }}>2+ days</span>
                                      : ol === 1
                                      ? <span style={{ fontSize: 10, fontWeight: 600, color: "#B08878", whiteSpace: "nowrap", flexShrink: 0 }}>yesterday</span>
                                      : null;
                                  return (
                                  <div
                                    draggable={todoEditId !== item.id}
                                    onDragStart={e => { e.stopPropagation(); setTodoDragIdx(idx); todoDragIdxRef.current = idx; }}
                                    onDragEnd={e => { e.stopPropagation(); setTodoDragIdx(null); todoDragIdxRef.current = null; setTodoDropZoneIdx(null); }}
                                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; }}
                                    onDrop={e => {
                                      e.preventDefault(); e.stopPropagation();
                                      setTodoDropZoneIdx(null);
                                      if (emailDragging) { 
                                        if (Array.isArray(emailDragging)) { saveTodo(dropMultipleEmailsToTodo(emailDragging, todoItemsRef.current)); } 
                                        else { groupEmail(emailDragging); } 
                                        setEmailDragging(null); setTodoDropTarget(false); return; 
                                      }
                                      if (alertDragging) return;
                                      const srcIdx = todoDragIdxRef.current;
                                      if (srcIdx === null || srcIdx === idx) { setTodoDragIdx(null); todoDragIdxRef.current = null; return; }
                                      groupTodo(srcIdx);
                                      setTodoDragIdx(null); todoDragIdxRef.current = null;
                                    }}
                                    onClick={toggleExpand}
                                    style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px",
                                      borderRadius: isExpanded ? "8px 8px 0 0" : 8,
                                      background: cardBg,
                                      border: "none",
                                      borderLeft: hasSubItems ? `4px solid ${ol >= 2 ? "#CC9999" : ol === 1 ? "#D4A898" : colors.sidebarActive}` : `3px solid ${cardBorder}`,
                                      borderBottom: isExpanded ? `1px solid ${colors.accent}22` : undefined,
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
                                        autoFocus
                                        defaultValue={item.text}
                                        onClick={e => e.stopPropagation()}
                                        onBlur={e => { saveTodo(todoItems.map(t => t.id === item.id ? { ...t, text: e.target.value.trim() || t.text } : t)); setTodoEditId(null); }}
                                        onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setTodoEditId(null); }}
                                        style={{ flex: 1, fontSize: 13, color: colors.text, border: "none", borderBottom: `1px solid ${colors.accent}`, outline: "none", background: "transparent", fontFamily: "inherit", lineHeight: 1.4, padding: "0 2px" }}
                                      />
                                    ) : item.missedLessons ? (
                                      // Group missed lesson item — "Contact all" is a link
                                      <span style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 1.4 }}>
                                        <span
                                          onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMissedContactMenu({ x: r.left, y: r.bottom + 4, item }); }}
                                          style={{ color: colors.accentDark, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>Contact all</span>
                                        {" re: missed lessons"}
                                      </span>
                                    ) : item.missedLesson ? (
                                      // Individual missed lesson item — "Contact [Parent]" is a link
                                      <span style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 1.4 }}>
                                        {item.missedLesson.parentEmail ? (
                                          <span
                                            onClick={e => { e.stopPropagation(); openCompose([item.missedLesson.parentEmail], { triggerId: "todo_missed_lesson" }); }}
                                            style={{ color: colors.accentDark, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>
                                            Contact {(item.missedLesson.parentName || "parent").split(" ")[0]}
                                          </span>
                                        ) : (
                                          <span style={{ color: colors.textMuted }}>Contact parent</span>
                                        )}
                                        {" re: "}{(item.missedLesson.studentName || "").split(" ")[0]}{"'s "}
                                        {item.missedLesson.count === 1 ? "missed lesson" : `${item.missedLesson.count} missed lessons`}
                                      </span>
                                    ) : item.catchupStudents ? (
                                      // Group catch-up item — parent names as link opening submenu
                                      <span style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 1.4 }}>
                                        <span
                                          onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setCatchupContactMenu({ x: r.left, y: r.bottom + 4, item }); }}
                                          style={{ color: colors.accentDark, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>
                                          {(() => {
                                            const byParent = {};
                                            for (const s of item.catchupStudents) {
                                              const key = s.parentEmail || s.studentId;
                                              if (!byParent[key]) byParent[key] = preferredFirstName(s.parentName) || "parent";
                                            }
                                            const names = Object.values(byParent);
                                            return names.length > 2 ? `Contact ${names.slice(0,2).join(", ")} and ${names.length-2} more` : `Contact ${names.length === 2 ? `${names[0]} and ${names[1]}` : names[0]}`;
                                          })()}
                                        </span>
                                        {" re: group catch-ups ("}
                                        {(item.subItems || []).filter(s => !s.done).length}
                                        {" remaining)"}
                                      </span>
                                    ) : item.catchupLesson ? (
                                      // Catch-up item — group lesson gets special label
                                      <span style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 1.4 }}>
                                        {item.catchupLesson.isGroup ? (
                                          <span
                                            onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setCatchupContactMenu({ x: r.left, y: r.bottom + 4, item }); }}
                                            style={{ color: colors.accentDark, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>
                                            {item.text.replace(/ re:.*$/, "")}
                                          </span>
                                        ) : item.catchupLesson.parentEmail ? (
                                          <span
                                            onClick={e => { e.stopPropagation(); openCompose([item.catchupLesson.parentEmail], { triggerId: "todo_catchup" }); }}
                                            style={{ color: colors.accentDark, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>
                                            Contact {preferredFirstName(item.catchupLesson.parentName) || "parent"}
                                          </span>
                                        ) : (
                                          <span style={{ color: colors.textMuted }}>Contact parent</span>
                                        )}
                                        {item.catchupLesson.isGroup
                                          ? " re: group catch-ups"
                                          : <>{" re: "}{preferredFirstName(item.catchupLesson.studentName) || (item.catchupLesson.studentName || "").split(" ")[0]}{"'s "}{item.catchupLesson.count === 1 ? "catch-up" : `${item.catchupLesson.count} catch-ups`}</>
                                        }
                                      </span>
                                    ) : item.interruptionStudents ? (
                                      // Interruption group item — plain text, expand to see contacts
                                      <span style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 1.4 }}>{item.text}</span>
                                    ) : item.pendingOrTrialStudents ? (
                                      // Pending/trial group item — count derived from active sub-items
                                      <span style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 1.4 }}>
                                        {(() => {
                                          const activeCount = (item.subItems || []).filter(s => !s.done).length;
                                          const label = item.groupType === "alert-pending" ? "pending" : "trial";
                                          return `Follow up ${activeCount} ${label} student${activeCount !== 1 ? "s" : ""}`;
                                        })()}
                                      </span>
                                    ) : item.pendingOrTrialLesson ? (
                                      // Individual pending/trial item — Contact [Parent] link
                                      <span style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 1.4 }}>
                                        {item.pendingOrTrialLesson.parentEmail ? (
                                          <span onClick={e => { e.stopPropagation(); openCompose([item.pendingOrTrialLesson.parentEmail], { triggerId: "todo_pending" }); }}
                                            style={{ color: colors.sidebarActive, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>
                                            Contact {preferredFirstName(item.pendingOrTrialLesson.parentName) || "parent"}
                                          </span>
                                        ) : <span style={{ color: colors.textMuted }}>Contact parent</span>}
                                        {" re: "}{preferredFirstName(item.pendingOrTrialLesson.studentName) || (item.pendingOrTrialLesson.studentName || "").split(" ")[0]}
                                        {"'s "}{item.pendingOrTrialLesson.groupType?.includes("pending") || item.groupType?.includes("pending") ? "pending enrolment" : "trial"}
                                      </span>
                                    ) : item.replyAddrs ? (
                                      // Group email item — "Contact parents/names" opens group send menu
                                      <span style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 1.4 }}>
                                        <span
                                          onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setEmailGroupContactMenu({ x: r.left, y: r.bottom + 4, item }); }}
                                          style={{ color: colors.accentDark, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>
                                          {item.text.replace(/\s*—\s*\d+.*$/, "")}
                                        </span>
                                        {item.text.match(/\s*—\s*\d+.*$/) || ""}
                                      </span>
                                    ) : item.replyTo ? (
                                      // Email item with compose link — "Contact [FirstName]"
                                      <span style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 1.4 }}>
                                        <span
                                          onClick={e => { e.stopPropagation(); openCompose([item.replyTo], { subject: item.composeSubject ?? (item.emailId ? (inboxEmails.find(e2 => e2.id === item.emailId)?.subject ? `Re: ${inboxEmails.find(e2 => e2.id === item.emailId).subject}` : "") : ""), triggerId: "todo_email" }); }}
                                          style={{ color: colors.accentDark, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>
                                          Contact {item.senderName || item.text.split(" ")[1] || "sender"}
                                        </span>
                                        {item.text.replace(/^Contact \S+/, "")}
                                      </span>
                                    ) : (
                                      <span style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 1.4 }}>{item.text}</span>
                                    )}
                                    {/* Inline controls: count badge + tag chips + edit + delete */}
                                    {hasSubItems && (
                                      <span style={{ fontSize: 10, fontWeight: 700, minWidth: 18, height: 18, borderRadius: "50%", background: colors.accent, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 4px", flexShrink: 0 }}>
                                        {item.subItems.length}
                                      </span>
                                    )}
                                    {item.tag && item.tag !== "manual" && (
                                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0 }}>
                                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: tc.bg, color: tc.color }}>{item.tag}</span>
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
                                            style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(52,69,101,0.1)", color: colors.sidebarActive, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
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
                                    <button title="Edit" onClick={e => { e.stopPropagation(); setTodoEditId(todoEditId === item.id ? null : item.id); }} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 12, lineHeight: 1, padding: "0 1px", flexShrink: 0, opacity: 0.6 }}>✎</button>
                                    <button onClick={e => { e.stopPropagation(); saveTodo(todoItems.filter(t => t.id !== item.id)); }} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 14, lineHeight: 1, padding: 0, flexShrink: 0, marginTop: 1 }}>✕</button>
                                    {overdueBadge}
                                  </div>
                                  );
                                  })()}

                                  {/* Expanded panel */}
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
                                            background: sub.done ? "transparent" : colors.white,
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
                                            {sub.replyEmailId || sub.replyTo ? (
                                              // Email sub-item — "Reply to [FirstName]" opens compose, "from Full Name" below
                                              <span style={{ fontSize: 12, color: sub.done ? colors.textMuted : colors.text, lineHeight: 1.4, textDecoration: sub.done ? "line-through" : "none" }}>
                                                <span
                                                  onClick={e => { e.stopPropagation(); openCompose([sub.replyTo], { subject: sub.composeSubject ?? (sub.replyEmailId ? (inboxEmails.find(e2 => e2.id === sub.replyEmailId)?.subject ? `Re: ${inboxEmails.find(e2 => e2.id === sub.replyEmailId).subject}` : "") : ""), triggerId: "todo_reply" }); }}
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
                                              <span style={{ fontSize: 12, color: sub.done ? colors.textMuted : colors.text, lineHeight: 1.4, textDecoration: sub.done ? "line-through" : "none" }}>{sub.text}</span>
                                            )}
                                            {sub.emailId && !sub.replyTo && (() => {
                                              const sn = sub.fullName || (() => { const se = inboxEmails.find(e => e.id === sub.emailId); return se?.from?.includes("<") ? se.from.split("<")[0].trim().replace(/^"|"$/g, "") : se?.from; })();
                                              return sn ? <span style={{ fontSize: 10, color: colors.textMuted, marginLeft: 6 }}>from {sn}</span> : null;
                                            })()}
                                          </div>
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
                                          }} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 11, lineHeight: 1, padding: "0 0 0 4px", flexShrink: 0, opacity: 0.6 }}>↑</button>
                                          <button onClick={() => {
                                            const newSubItems = item.subItems.filter(s => s.id !== sub.id);
                                            if (newSubItems.length === 0) { saveTodo(todoItems.filter(t => t.id !== item.id)); }
                                            else if (newSubItems.length === 1) { saveTodo(todoItems.map(t => t.id === item.id ? { ...t, text: newSubItems[0].text, subItems: undefined, count: undefined, emailId: newSubItems[0].emailId, meta: newSubItems[0].meta } : t)); }
                                            else {
                                              const newCount = newSubItems.length;
                                              const newText = item.text.replace(/\s*\+\d+$/, "") + ` +${newCount - 1}`;
                                              saveTodo(todoItems.map(t => t.id === item.id ? { ...t, text: newText, subItems: newSubItems, count: newCount } : t));
                                            }
                                          }} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 13, lineHeight: 1, padding: 0, flexShrink: 0 }}>✕</button>
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
                                          value={item.notes || ""}
                                          onChange={e => saveTodo(todoItems.map(t => t.id === item.id ? { ...t, notes: e.target.value } : t))}
                                          placeholder="Add a note…"
                                          rows={2}
                                          style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 12, fontFamily: "inherit", color: colors.text, border: `1px solid ${colors.inputBorder}`, borderRadius: 6, resize: "vertical", outline: "none", background: colors.white, lineHeight: 1.5 }} />
                                      </div>
                                    </div>
                                  )}

                                  {/* ── Gap after each item — reorder drop zone ── */}
                                  <div
                                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); setTodoDropZoneIdx(idx + 1); }}
                                    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setTodoDropZoneIdx(null); }}
                                    onDrop={e => {
                                      e.preventDefault(); e.stopPropagation();
                                      setTodoDropZoneIdx(null);
                                      if (todoSubDragRef.current) { ungroupSub(idx + 1); return; }
                                      if (alertDragging) { saveTodo(handleAlertDrop(alertDragging, todoItemsRef.current)); setAlertDragging(null); setTodoDropTarget(false); return; }
                                      if (emailDragging) return;
                                      const srcIdx = todoDragIdxRef.current;
                                      if (srcIdx === null) return;
                                      const items = todoItemsRef.current;
                                      const active = items.filter(t => !t.done);
                                      const done = items.filter(t => t.done);
                                      const reordered = [...active];
                                      const [moved] = reordered.splice(srcIdx, 1);
                                      const insertAt = srcIdx < idx ? idx : idx + 1;
                                      reordered.splice(insertAt, 0, moved);
                                      saveTodo([...reordered, ...done]);
                                      setTodoDragIdx(null); todoDragIdxRef.current = null;
                                    }}
                                    style={{ height: todoDropZoneIdx === idx + 1 ? 32 : 16, transition: "height 0.12s", display: "flex", alignItems: "center", padding: "0 4px" }}>
                                    {todoDropZoneIdx === idx + 1 && <div style={{ flex: 1, height: 3, borderRadius: 2, background: colors.accent }} />}
                                  </div>
                                </React.Fragment>
                              );
                            })}
                            {/* ── Bottom catch-all drop zone — covers all remaining panel space ── */}
                            <div
                              onDragOver={e => { e.preventDefault(); e.stopPropagation(); setTodoDropZoneIdx(-1); }}
                              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setTodoDropZoneIdx(null); }}
                              onDrop={e => {
                                e.preventDefault(); e.stopPropagation();
                                setTodoDropZoneIdx(null);
                                if (todoSubDragRef.current) { ungroupSub(activeTodo.length); return; }
                                if (alertDragging) { saveTodo(handleAlertDrop(alertDragging, todoItemsRef.current)); setAlertDragging(null); setTodoDropTarget(false); return; }
                                if (emailDragging) return;
                                const srcIdx = todoDragIdxRef.current;
                                if (srcIdx === null) return;
                                const items = todoItemsRef.current;
                                const active = items.filter(t => !t.done);
                                const done = items.filter(t => t.done);
                                const reordered = [...active];
                                const [moved] = reordered.splice(srcIdx, 1);
                                reordered.push(moved);
                                saveTodo([...reordered, ...done]);
                                setTodoDragIdx(null); todoDragIdxRef.current = null;
                              }}
                              style={{ minHeight: 40, flex: 1 }}>
                              {todoDropZoneIdx === -1 && <div style={{ height: 3, borderRadius: 2, background: colors.accent, margin: "0 4px" }} />}
                            </div>
                            {doneTodo.length > 0 && (
                              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.borderLight}` }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Done</div>
                                {doneTodo.map(item => (
                                  <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, marginBottom: 3, background: colors.bg, opacity: 0.6 }}>
                                    <input type="checkbox" checked={true} onChange={() => saveTodo(todoItems.map(t => t.id === item.id ? { ...t, done: false, doneAt: undefined } : t))} style={{ flexShrink: 0, cursor: "pointer" }} />
                                    <span style={{ flex: 1, fontSize: 12, color: colors.textMuted, textDecoration: "line-through" }}>{item.text}</span>
                                    <button onClick={() => saveTodo(todoItems.filter(t => t.id !== item.id))} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
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
            </div>  {/* end outer banner wrapper */}
          </>
        );
      })()}

      {/* ── Term progress bar ── */}
      {(() => {
        const termBreaksForDash = interruptions.filter(i => i.type === "term_break");
        const currentLabel = getTermWeekLabel(effectiveTodayStr, termBreaksForDash);
        const currentWeekNum = parseInt((currentLabel.match(/\d+/) || ["1"])[0], 10);
        const getMondayOf = (dt) => { const m = new Date(dt); const dow = m.getDay(); m.setDate(m.getDate() + (dow === 0 ? -6 : 1 - dow)); m.setHours(0, 0, 0, 0); return m; };
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
        // Total weeks = week number of the last Mon before term break
        let totalWeeks = currentWeekNum;
        if (termEnd) {
          const lastSchoolDay = new Date(termEnd); lastSchoolDay.setDate(lastSchoolDay.getDate() - 1);
          const lastLabel = getTermWeekLabel(toLocalDateStr(lastSchoolDay), termBreaksForDash);
          const lastNum = parseInt((lastLabel.match(/\d+/) || ["0"])[0], 10);
          if (lastNum > 0) totalWeeks = lastNum;
        }
        const progress = totalWeeks > 0 ? Math.min(1, (currentWeekNum - 0.5) / totalWeeks) : 0;
        return (
          <div style={{ marginBottom: 16 }}>
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

      {/* ── Divider between week grid and day strips ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 14px" }}>
        <div style={{ flex: 1, height: 1, background: `linear-gradient(to right, transparent, ${colors.border})` }} />
        <span style={{ fontSize: 10, color: colors.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600 }}>Schedule</span>
        <div style={{ flex: 1, height: 1, background: `linear-gradient(to left, transparent, ${colors.border})` }} />
      </div>

      {/* Day strips */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
        {dayData.map((dd, ddIdx) => {
          const isToday = dd.date === todayStr;
          const activeDay = hoveredDay !== null ? hoveredDay : (visibleDays[0]?.day || todayDayName);
          const isActive = activeDay === dd.day;
          const hasInterruptions = dd.dayInterruptions.length > 0;
          const totalLessons = dd.teacherSchools.reduce((sum, ts) => sum + ts.lessonCount, 0);
          const isFirstNextWeek = dd.isNextWeek && (ddIdx === 0 || !dayData[ddIdx - 1].isNextWeek);

          return (
            <React.Fragment key={dd.date}>
              {isFirstNextWeek && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0" }}>
                  <div style={{ flex: 1, height: 1, background: "rgba(52,69,101,0.25)" }} />
                  <span style={{ fontSize: 11, color: colors.sidebarActive, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6 }}>Next Week</span>
                  <div style={{ flex: 1, height: 1, background: "rgba(52,69,101,0.25)" }} />
                </div>
              )}
            <Card
              onMouseEnter={() => setHoveredDay(dd.day)}
              onMouseLeave={() => setHoveredDay(null)}
              onContextMenu={e => { e.preventDefault(); setCalEventForm({ date: dd.date, time: "", title: "", details: "", x: e.clientX, y: e.clientY }); }}
              style={{
                padding: "14px 18px",
                borderLeft: isActive ? "4px solid " + colors.sidebarActive : dd.isNextWeek ? "4px solid " + colors.textMuted : "4px solid " + colors.border,
                background: isActive ? "#E8EDF5" : colors.white,
                boxShadow: isActive ? "0 2px 12px rgba(52,69,101,0.2)" : "0 1px 4px rgba(0,0,0,0.06)",
                transition: "background 0.15s, border-color 0.15s",
              }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: isActive ? colors.sidebarActive : colors.text }}>
                      {dd.day}
                    </span>
                    <span style={{ fontSize: 13, color: colors.textLight }}>{dd.dayNum} {dd.month}</span>
                    {isToday && <Tag color={colors.sidebarActive}>Today</Tag>}
                    {dd.isNextWeek && <Tag color={colors.textMuted}>Next week</Tag>}
                    {hasInterruptions && dd.dayInterruptions.map((intr, i) => (
                      <Tag key={i} color="#D97706">{intr.title}{intr.affectsClasses !== "all" ? ` (${intr.affectsClasses})` : ""}</Tag>
                    ))}
                  </div>

                  {/* Calendar events */}
                  {(() => {
                    const dayEvents = calendarEvents.filter(ev => ev.date === dd.date);
                    if (!dayEvents.length) return null;
                    return (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                        {dayEvents.map(ev => (
                          <div key={ev.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, background: colors.accentLight, color: colors.accentDark, borderRadius: 6, padding: "3px 8px", fontWeight: 600, cursor: "pointer" }}
                            onClick={() => setCalEventForm({ ...ev, x: null, y: null })}>
                            {ev.time && <span style={{ opacity: 0.75 }}>{ev.time}</span>}
                            <span>{ev.title}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {dd.teacherSchools.length === 0 ? (
                    <div style={{ fontSize: 13, color: colors.textLight, fontStyle: "italic" }}>No lessons scheduled</div>
                  ) : (
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {(() => {
                        const bySchool = {};
                        for (const ts of dd.teacherSchools) {
                          if (!bySchool[ts.school.id]) bySchool[ts.school.id] = { school: ts.school, teachers: [], totalLessons: 0 };
                          bySchool[ts.school.id].teachers.push(ts);
                          bySchool[ts.school.id].totalLessons += ts.lessonCount;
                        }
                        return Object.values(bySchool).map(gs => (
                          <div key={gs.school.id} style={{
                            padding: "8px 14px", background: isToday ? colors.white : "#F5F3EF", borderRadius: 8,
                            border: `1px solid ${isToday ? "rgba(52,69,101,0.25)" : colors.border}`, fontSize: 12,
                            boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
                          }}>
                            <div style={{ fontWeight: 600, marginBottom: 4 }}>🏫 {gs.school.name}</div>
                            {gs.teachers.map(t => (
                              <div key={t.teacher.id} style={{ display: "flex", alignItems: "center", gap: 6, color: colors.textLight, marginBottom: 1 }}>
                                <span>{t.teacher.name.split(" ")[0]}</span>
                                {t.firstLesson && t.lastLesson ? (
                                  <span style={{ color: colors.textMuted, fontSize: 11 }}>
                                    {toTimeLabel(t.firstLesson.start)}–{toTimeLabel(t.lastLesson.end)}
                                  </span>
                                ) : null}
                                {t.lessonCount > 0 && <span style={{ fontWeight: 600, color: colors.text, fontSize: 11 }}>({t.lessonCount})</span>}
                              </div>
                            ))}
                          </div>
                        ));
                      })()}
                    </div>
                  )}
                </div>

                {/* Quick action: jump to weekly */}
                {timetable && dd.teacherSchools.length > 0 && (
                  <Btn variant="secondary" onClick={() => onNavigate("weekly")} style={{ fontSize: 11, padding: "5px 10px", whiteSpace: "nowrap" }}>
                    Weekly →
                  </Btn>
                )}
              </div>
            </Card>
            </React.Fragment>
          );
        })}
      </div>


      {/* Backup / Restore */}
      <DashboardBackupBar onBackup={onBackup} onRestore={onRestore} notify={notify} />

      {/* Error Log — subtle collapsible */}
      {errorLog && errorLog.length > 0 && <ErrorLogPanel errorLog={errorLog} />}

      <div style={{ textAlign: "center", padding: "16px 0 4px", fontSize: 11, color: colors.textMuted }}>
        Timetabling v{APP_VERSION}
      </div>

      {/* ── Calendar event form modal ── */}
      {calEventForm && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.25)" }}
          onClick={e => { if (e.target === e.currentTarget) setCalEventForm(null); }}>
          <div style={{
            position: "fixed",
            left: calEventForm.x ? Math.min(calEventForm.x, window.innerWidth - 320) : "50%",
            top: calEventForm.y ? Math.min(calEventForm.y, window.innerHeight - 320) : "50%",
            transform: calEventForm.x ? "none" : "translate(-50%,-50%)",
            background: colors.white, borderRadius: 12, padding: "18px 20px", width: 300,
            boxShadow: "0 8px 32px rgba(0,0,0,0.2)", zIndex: 10001,
          }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: colors.text, marginBottom: 14 }}>
              {calEventForm.id ? "Edit Event" : "Add Event"}
              <span style={{ fontWeight: 400, fontSize: 12, color: colors.textMuted, marginLeft: 8 }}>
                {(() => { const d = new Date(calEventForm.date + "T00:00:00"); return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }); })()}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input value={calEventForm.title} onChange={e => setCalEventForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Title *" autoFocus
                style={{ padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none" }} />
              <input value={calEventForm.time} onChange={e => setCalEventForm(f => ({ ...f, time: e.target.value }))}
                placeholder="Time (e.g. 9:00am)"
                style={{ padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none" }} />
              <textarea value={calEventForm.details} onChange={e => setCalEventForm(f => ({ ...f, details: e.target.value }))}
                placeholder="Details (optional)" rows={2}
                style={{ padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", resize: "vertical" }} />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => {
                if (!calEventForm.title.trim()) return;
                if (calEventForm.id) {
                  saveCalendarEvents(calendarEvents.map(ev => ev.id === calEventForm.id ? { ...ev, title: calEventForm.title, time: calEventForm.time, details: calEventForm.details } : ev));
                } else {
                  saveCalendarEvents([...calendarEvents, { id: uid(), date: calEventForm.date, title: calEventForm.title.trim(), time: calEventForm.time.trim(), details: calEventForm.details.trim(), createdAt: new Date().toISOString() }]);
                }
                setCalEventForm(null);
              }} style={{ flex: 1, padding: "8px 0", borderRadius: 8, background: colors.sidebarActive, color: "#fff", fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                {calEventForm.id ? "Save" : "Add"}
              </button>
              {calEventForm.id && (
                <button onClick={() => { saveCalendarEvents(calendarEvents.filter(ev => ev.id !== calEventForm.id)); setCalEventForm(null); }}
                  style={{ padding: "8px 14px", borderRadius: 8, background: "#FEF2F2", color: colors.danger, fontWeight: 600, fontSize: 13, border: `1px solid ${colors.danger}`, cursor: "pointer", fontFamily: "inherit" }}>
                  Delete
                </button>
              )}
              <button onClick={() => setCalEventForm(null)}
                style={{ padding: "8px 14px", borderRadius: 8, background: colors.bg, color: colors.textMuted, fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Email body right-click context menu ── */}
      {emailContextMenu && (() => {
        const isEnquiry = emailContextMenu.email && classifyEmailFull(emailContextMenu.email) === "enquiry";
        return (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{ position: "fixed", left: emailContextMenu.x, top: emailContextMenu.y, zIndex: 9999,
            background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)", minWidth: 180, overflow: "hidden",
            fontFamily: "inherit", fontSize: 13 }}>
          {emailContextMenu.text && (
            <button
              onClick={() => { navigator.clipboard?.writeText(emailContextMenu.text); setEmailContextMenu(null); }}
              style={{ display: "block", width: "100%", padding: "9px 14px", background: "none", border: "none",
                textAlign: "left", cursor: "pointer", color: colors.text, fontFamily: "inherit", fontSize: 13 }}
              onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
              onMouseLeave={e => e.currentTarget.style.background = "none"}>
              📋 Copy
            </button>
          )}
          {isEnquiry && (
            <button
              onClick={() => {
                const prefill = buildEnquiryPrefill(emailContextMenu.email, "pending");
                setNewStudentPrefill(prefill);
                onNavigate("students");
                setEmailContextMenu(null);
              }}
              style={{ display: "block", width: "100%", padding: "9px 14px", background: "none", border: "none",
                textAlign: "left", cursor: "pointer", color: colors.text, fontFamily: "inherit", fontSize: 13 }}
              onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
              onMouseLeave={e => e.currentTarget.style.background = "none"}>
              ➕ Add to waiting list
            </button>
          )}
          {isEnquiry && (
            <button
              onClick={() => {
                const prefill = buildEnquiryPrefill(emailContextMenu.email, "trial");
                setNewStudentPrefill(prefill);
                onNavigate("students");
                setEmailContextMenu(null);
              }}
              style={{ display: "block", width: "100%", padding: "9px 14px", background: "none", border: "none",
                textAlign: "left", cursor: "pointer", color: colors.text, fontFamily: "inherit", fontSize: 13 }}
              onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
              onMouseLeave={e => e.currentTarget.style.background = "none"}>
              🎵 Schedule trial lesson
            </button>
          )}
        </div>
        );
      })()}
      {emailContextMenu && (
        <div onClick={() => setEmailContextMenu(null)} onContextMenu={e => { e.preventDefault(); setEmailContextMenu(null); }}
          style={{ position: "fixed", inset: 0, zIndex: 9998 }} />
      )}
    </div>
  );
}

// ============================================================
// SPECIALIST TIMETABLE MANAGER
// ============================================================
