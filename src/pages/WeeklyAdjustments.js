// ============================================================
// WeeklyAdjustments.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { colors, DAYS, STORAGE_KEYS, instruments_colors } from "../constants";
import { uid, timeToMin, toTimeLabel, to12h, melbourneNow, melbourneToday, toLocalDateStr, getCurrentWeekMonday, getTermWeekLabel, _getMondayOf, getParentEmails, openCompose, groupDisplayName } from "../utils/helpers";
import { computeTermWeekNum, computeTermKey, computeAutoTallyDay, computeExtraTicks } from "../utils/tallyHelpers";
import { anthropicFetch, getAnthropicHeaders } from "../utils/api";
import { getUserTemplates, applyMergeCtx, preferredFirstName, getEmailTemplates, resolveTemplate } from "../utils/emailTemplates";
import { generateWeeklyTimetable, buildWeeklyAIPrompt, printWeeklyTimetable } from "../data/weeklyTimetableGenerator";
import { Card, PageTitle, NavButtons, Btn, Tag, EmptyState, FrozenCard, useDragScroll, PAGE_COLORS } from "../components/ui/SharedUI";
import { ConflictBanner } from "../components/ConflictBanner";
import { ExportIcon } from "../components/ExportDialog";

export function WeeklyAdjustments({ mainScrollRef, timetable, schools, students, setStudents, teachers, setTeachers, specialists, interruptions, groups, bands, weeklyTimetables, setWeeklyTimetables, tallyEntries, setTallyEntries, masterBreaks, notify, contacts, logError, viewState, setViewState, sharedSchool, setSharedSchool, sharedTimetableScroll, setSharedTimetableScroll, onViewStudent, onViewGroup, onExport, onUndo, onRedo, undoCount, redoCount, onWarningsChange, goBack, goForward, historyCursor, pageHistory }) {
  const selectedSchool = sharedSchool || viewState.selectedSchool;
  const weekOffset = viewState.weekOffset;
  const showMissedTally = viewState.showMissedTally;
  const setSelectedSchool = (v) => {
    const next = typeof v === "function" ? v(sharedSchool || viewState.selectedSchool) : v;
    setSharedSchool(next);
    setViewState(prev => ({ ...prev, selectedSchool: next }));
  };
  const setWeekOffset = (v) => setViewState(prev => ({ ...prev, weekOffset: typeof v === "function" ? v(prev.weekOffset) : v, gridScroll: {} }));
  const setShowMissedTally = (v) => setViewState(prev => ({ ...prev, showMissedTally: typeof v === "function" ? v(prev.showMissedTally) : v }));
  const [adjustmentNotes, setAdjustmentNotes] = useState("");
  const [wttSavedVersions, setWttSavedVersions] = useState([]);
  const [showWttSavePrompt, setShowWttSavePrompt] = useState(false);
  const [wttVersionName, setWttVersionName] = useState("");
  const lastWttVersionNameRef = React.useRef({}); // { [schoolId]: lastUsedName }
  const [showWttVersionMenu, setShowWttVersionMenu] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [wttHintIdx, setWttHintIdx] = useState(0);
  const [wttHintVisible, setWttHintVisible] = useState(true);
  React.useEffect(() => {
    (async () => {
      const v = await loadData(STORAGE_KEYS.weeklyVersions, []);
      setWttSavedVersions(v);
    })();
  }, []);

  const saveWttVersion = async (name) => {
    const weeklyData = weeklyTimetables[`${weekKey}|${selectedSchool}`];
    if (!weeklyData || !selectedSchool) return;
    const school = schools.find(s => s.id === selectedSchool);
    const version = {
      id: uid(),
      schoolId: selectedSchool,
      schoolName: school?.name || "",
      weekKey,
      weekLabel,
      name: name || `${school?.name || "School"} — ${weekLabel}`,
      date: new Date().toISOString(),
      lessons: JSON.parse(JSON.stringify(weeklyData.lessons)),
      missed: JSON.parse(JSON.stringify(weeklyData.missed || [])),
    };
    const updated = [...wttSavedVersions, version];
    setWttSavedVersions(updated);
    await saveData(STORAGE_KEYS.weeklyVersions, updated);
    lastWttVersionNameRef.current[selectedSchool] = name || version.name;
    setShowWttSavePrompt(false);
    setWttVersionName("");
    if (notify) notify("Weekly timetable version saved");
  };

  const loadWttVersion = (version) => {
    const key = `${version.weekKey}|${version.schoolId}`;
    setWeeklyTimetables(prev => ({
      ...prev,
      [key]: { lessons: version.lessons, missed: version.missed || [], generatedAt: version.date }
    }));
    setShowWttVersionMenu(false);
    if (notify) notify("Version loaded: " + version.name);
  };

  const deleteWttVersion = async (versionId) => {
    const updated = wttSavedVersions.filter(v => v.id !== versionId);
    setWttSavedVersions(updated);
    await saveData(STORAGE_KEYS.weeklyVersions, updated);
  };
  const [pendingRecurringNotes, setPendingRecurringNotes] = useState([]);
  const [confirmClearWeek, setConfirmClearWeek] = useState(false);
  const [showClearMenu, setShowClearMenu] = useState(false);
  const [clearMenuPos, setClearMenuPos] = useState({ top: 0, right: 0 });
  const clearMenuBtnRef = React.useRef(null);
  const clearMenuRef = React.useRef(null);
  const [confirmClearAllWeeks, setConfirmClearAllWeeks] = useState(false);
  const [confirmRegenerateWeek, setConfirmRegenerateWeek] = useState(false);
  const [confirmImportAllWeeks, setConfirmImportAllWeeks] = useState(false);
  const [expandedBtn, setExpandedBtn] = useState(null); // null | "week" | dayName
  const [confirmImportExpanded, setConfirmImportExpanded] = useState(false);
  const [showInterruptions, setShowInterruptions] = useState(false);
  const [editUnlocked, setEditUnlocked] = useState(false);
  const gridScrollRef = useRef(null);
  const savedGridScroll = useRef({});
  savedGridScroll.current = sharedTimetableScroll?.gridScroll || viewState.gridScroll || {};
  const hasAutoScrolled = useRef(false);
  // Callback ref — fires when grid mounts (including when selectedSchool changes)
  const gridRefCb = React.useCallback((el) => {
    gridScrollRef.current = el;
    if (el) {
      const s = savedGridScroll.current[selectedSchool] || { top: 0, left: 0 };
      el.scrollTop = s.top; el.scrollLeft = s.left;
      if (!hasAutoScrolled.current && mainScrollRef?.current) {
        hasAutoScrolled.current = true;
        requestAnimationFrame(() => {
          const mainEl = mainScrollRef.current;
          if (!mainEl || !el) return;
          const selectorEl = document.querySelector("[data-frozen-card]");
          const selectorBottom = selectorEl ? selectorEl.getBoundingClientRect().bottom : HEADER_HEIGHT + 60;
          const gridTop = el.getBoundingClientRect().top;
          const target = mainEl.scrollTop + (gridTop - selectorBottom) - 10;
          mainEl.scrollTop = Math.max(0, target);
        });
      }
    }
  }, [selectedSchool, weekOffset]);
  const handleGridScroll = () => {
    const el = gridScrollRef.current;
    if (el) {
      const gs = { ...(sharedTimetableScroll?.gridScroll || {}), [selectedSchool]: { top: el.scrollTop, left: el.scrollLeft } };
      setSharedTimetableScroll(prev => ({ ...prev, gridScroll: gs }));
      setViewState(prev => ({ ...prev, gridScroll: gs }));
    }
  };
  const [dragOver, setDragOver] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  useDragScroll(gridScrollRef, !!draggingId);
  const hoverPanelRef = React.useRef(null);
  const dragCache = React.useRef({});
  const [dragOverMissed, setDragOverMissed] = useState(false);
  const [dragOverStaging, setDragOverStaging] = useState(false);
  const [constraintWarnings, setConstraintWarnings] = useState({});
  const [ackedConstraints, setAckedConstraints] = useState(new Set());
  const [expandedWarnings, setExpandedWarnings] = useState(new Set());
  useEffect(() => { if (onWarningsChange) onWarningsChange(constraintWarnings, ackedConstraints); }, [constraintWarnings, ackedConstraints]);
  const [contextMenu, setContextMenu] = useState(null);
  const [catchupSubmenu, setCatchupSubmenu] = useState(null);
  const [pendingSubmenu, setPendingSubmenu] = useState(null);
  const [addLessonSubmenu, setAddLessonSubmenu] = useState(null);
  const [missedZoneSubmenu, setMissedZoneSubmenu] = useState(null);
  const [dayHeaderSubmenu, setDayHeaderSubmenu] = useState(null);
  const dayHeaderHideTimer = React.useRef(null);
  const [wttEmailSubmenu, setWttEmailSubmenu] = useState(null);
  const [wttEmailLevel2, setWttEmailLevel2] = useState(null);
  const [notePopup, setNotePopup] = useState(null); // { lessonId, storageKey, x, y, note }
  const [notePopupDraft, setNotePopupDraft] = useState("");
  const [selectedCards, setSelectedCards] = useState(new Set()); // Set of lessonIds
  const [selectedMissed, setSelectedMissed] = useState(new Set()); // Set of missed indices
  const [selectedDays, setSelectedDays] = useState(new Set()); // Set of day names selected via header click
  const [bulkMissedModal, setBulkMissedModal] = useState(null); // { lessonIds }
  const [swapTeacherSubmenu, setSwapTeacherSubmenu] = useState(null); // { y } or null
  const swapTeacherSubRef = React.useRef(null);
  const swapTeacherHideTimer = React.useRef(null);
  const level3MenuRef = React.useRef(null); // level-3 email panel in multi-card cascade
  const keepSwap = React.useCallback(() => { if (swapTeacherHideTimer.current) { clearTimeout(swapTeacherHideTimer.current); swapTeacherHideTimer.current = null; } }, []);
  const schedSwapClose = React.useCallback(() => { swapTeacherHideTimer.current = setTimeout(() => setSwapTeacherSubmenu(null), 200); }, []);
  const contextMenuRef = React.useRef(null);
  const subMenuRef = React.useRef(null);
  const clickTimerRef = React.useRef({}); // per-lessonId timers for single vs double click
  const subPanelScrollRef = React.useRef({});
  // Restore saved scroll position when the active submenu type changes
  useEffect(() => {
    if (subMenuRef.current && addLessonSubmenu?.type) {
      subMenuRef.current.scrollTop = subPanelScrollRef.current[addLessonSubmenu.type] || 0;
    }
  }, [addLessonSubmenu?.type]);
  const missedZoneSubRef = React.useRef(null);
  const dayHeaderSubRef = React.useRef(null);
  const addLessonSubmenuType = React.useRef(null); // tracks which type is currently positioned
  const menuCloseTimer = React.useRef(null);
  useEffect(() => {
    if (!contextMenu) return;
    const check = (e) => {
      const mx = e.clientX, my = e.clientY;
      const inMain = contextMenuRef.current && (() => { const r = contextMenuRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      const inSub = subMenuRef.current && (() => { const r = subMenuRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      const inSwap = swapTeacherSubRef.current && (() => { const r = swapTeacherSubRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      const inLevel3 = level3MenuRef.current && (() => { const r = level3MenuRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      const inDayHeader = dayHeaderSubRef.current && (() => { const r = dayHeaderSubRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      if (inMain || inSub || inSwap || inLevel3 || inDayHeader) {
        if (menuCloseTimer.current) { clearTimeout(menuCloseTimer.current); menuCloseTimer.current = null; }
      } else {
        if (!menuCloseTimer.current) {
          menuCloseTimer.current = setTimeout(() => { setContextMenu(null); setAddLessonSubmenu(null); addLessonSubmenuType.current = null; menuCloseTimer.current = null; }, 250);
        }
      }
    };
    window.addEventListener("mousemove", check);
    return () => { window.removeEventListener("mousemove", check); if (menuCloseTimer.current) clearTimeout(menuCloseTimer.current); };
  }, [contextMenu]);



  const [hoverNotes, setHoverNotes] = useState(null) // null | { text, x, y };
  // Tally prompt — shown when a lesson is manually dragged to missed area
  const [tallyPrompt, setTallyPrompt] = useState(null); // { lesson, missedEntry, weekKey, weekNum }
  const [tallyPromptNotes, setTallyPromptNotes] = useState("");
  const [tallyConfirm, setTallyConfirm] = useState(null); // step 2: { lesson, reasonValue, reasonLabel, makeupEligible, weekLabel }
  const specLookupRef = React.useMemo(() => {
    const lookup = {};
    for (const entry of (specialists || [])) {
      const key = `${entry.schoolId}|${entry.className}|${entry.day}`;
      if (!lookup[key]) lookup[key] = [];
      lookup[key].push({ start: timeToMin(entry.start), end: timeToMin(entry.end), subject: entry.subject });
    }
    return lookup;
  }, [specialists]);


  // Live specialist tag lookup — used at render so stored field doesn't matter
  const getLiveSpecialistTag = (lesson) => {
    const sStart = timeToMin(lesson.start), sEnd = timeToMin(lesson.end);
    if (lesson.isGroup) {
      const memberIds = lesson.studentIds || [];
      const subjects = [];
      for (const mid of memberIds) {
        const ms = students.find(s => s.id === mid);
        if (!ms || !ms.className) continue;
        const key = `${lesson.schoolId}|${ms.className}|${lesson.day}`;
        const specs = specLookupRef[key] || [];
        const match = specs.find(sp => sStart < sp.end && sEnd > sp.start);
        if (match && !subjects.includes(match.subject || "specialist")) subjects.push(match.subject || "specialist");
      }
      return subjects.length > 0 ? subjects.join(", ") : false;
    }
    const student = students.find(s => s.id === lesson.studentId);
    if (!student) return false;
    const key = `${lesson.schoolId}|${student.className}|${lesson.day}`;
    const specs = specLookupRef[key] || [];
    const match = specs.find(sp => sStart < sp.end && sEnd > sp.start);
    return match ? (match.subject || true) : false;
  };

  // Compute duringSpecialist value for a lesson placed at a given day/slot
  const getSpecialistForSlot = (lesson, day, slot) => {
    if (slot.type !== "class") return false;
    const sStart = timeToMin(slot.start), sEnd = timeToMin(slot.end);
    if (lesson.isGroup) {
      const memberIds = lesson.studentIds || [];
      const subjects = [];
      for (const mid of memberIds) {
        const ms = students.find(s => s.id === mid);
        if (!ms || !ms.className) continue;
        const key = `${lesson.schoolId}|${ms.className}|${day}`;
        const specs = specLookupRef[key] || [];
        const match = specs.find(sp => sStart < sp.end && sEnd > sp.start);
        if (match && !subjects.includes(match.subject || "specialist")) subjects.push(match.subject || "specialist");
      }
      return subjects.length > 0 ? subjects.join(", ") : false;
    }
    const student = students.find(s => s.id === lesson.studentId);
    if (!student) return false;
    const key = `${lesson.schoolId}|${student.className}|${day}`;
    const specs = specLookupRef[key] || [];
    const match = specs.find(sp => sStart < sp.end && sEnd > sp.start);
    return match ? match.subject : false;
  };

  const checkConstraints = (lesson, newDay, slot, _lessonList) => {
    if (lesson.isBandSession) {
      const warnings = [];
      const memberIds = (lesson.members || []).map(m => m.studentId);
      const _weeklyData = weeklyTimetables[`${weekKey}|${selectedSchool}`];
      const lessonsToCheck = _lessonList || (_weeklyData ? _weeklyData.lessons : (timetable ? timetable.lessons : []));
      for (const mid of memberIds) {
        const memberLesson = lessonsToCheck.find(l => l.id !== lesson.id && l.day === newDay && !l.isBandSession && l.studentId === mid);
        if (memberLesson) {
          const memberStudent = students.find(s => s.id === mid);
          warnings.push(`${memberStudent?.name || mid} already has a lesson on ${newDay} (${memberLesson.instrument})`);
        }
      }
      const school = schools.find(s => s.id === lesson.schoolId);
      const teacher = teachers.find(t => t.id === lesson.teacherId);
      if (teacher && school) {
        const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === newDay);
        if (!dayAvail) {
          warnings.push(`${teacher.name} not available at ${school.name} on ${newDay}`);
        } else {
          const slotStart = timeToMin(slot.start), slotEnd = timeToMin(slot.end);
          if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) {
            warnings.push(`Outside ${teacher.name}'s hours (${dayAvail.start}–${dayAvail.end})`);
          }
        }
        const conflict = lessonsToCheck.find(l => l.id !== lesson.id && l.teacherId === lesson.teacherId && l.day === newDay && l.start === slot.start);
        if (conflict) warnings.push(`${teacher.name} is double-booked at this time`);
      }
      const targetDate = weekDateMap[newDay];
      if (targetDate) {
        for (const intr of weekInterruptions) {
          const iStart = intr.date, iEnd = intr.endDate || intr.date;
          if (targetDate < iStart || targetDate > iEnd) continue;
          if (intr.startTime && intr.endTime) {
            const sStart = timeToMin(slot.start), sEnd = timeToMin(slot.end);
            if (sStart >= timeToMin(intr.endTime) || sEnd <= timeToMin(intr.startTime)) continue;
          }
          warnings.push(`⚠ ${intr.title} — interruption on ${newDay}`);
          break;
        }
      }
      return warnings;
    }
    if (lesson.isGroup) {
      const warnings = [];
      const memberIds = lesson.studentIds || [];
      const _weeklyData = weeklyTimetables[`${weekKey}|${selectedSchool}`];
      const lessonsToCheck = _lessonList || (_weeklyData ? _weeklyData.lessons : (timetable ? timetable.lessons : []));
      for (const mid of memberIds) {
        const memberLesson = lessonsToCheck.find(l => l.id !== lesson.id && l.day === newDay && (
          l.studentId === mid || (l.isGroup && l.studentIds && l.studentIds.includes(mid))
        ));
        if (memberLesson) {
          const memberStudent = students.find(s => s.id === mid);
          const memberName = memberStudent ? memberStudent.name : mid;
          warnings.push(`${memberName} already has a lesson on ${newDay} (${memberLesson.isGroup ? memberLesson.groupName || "Group" : memberLesson.instrument})`);
        }
      }
      // Teacher availability and double-booking for groups
      const school = schools.find(s => s.id === lesson.schoolId);
      const teacher = teachers.find(t => t.id === lesson.teacherId);
      if (teacher && school) {
        const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === newDay);
        if (!dayAvail) {
          warnings.push(`${teacher.name} not available at ${school.name} on ${newDay}`);
        } else {
          const slotStart = timeToMin(slot.start);
          const slotEnd = timeToMin(slot.end);
          if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) {
            warnings.push(`Outside ${teacher.name}'s hours (${dayAvail.start}–${dayAvail.end})`);
          }
        }
        const conflict = lessonsToCheck.find(l => l.id !== lesson.id && l.teacherId === lesson.teacherId && l.day === newDay && l.start === slot.start);
        if (conflict) warnings.push(`${teacher.name} already has ${conflict.isGroup ? conflict.groupName || "Group" : conflict.studentName} at this time`);
      }
      // Interruption check for groups
      const targetDate = weekDateMap[newDay];
      if (targetDate) {
        for (const intr of weekInterruptions) {
          const iStart = intr.date, iEnd = intr.endDate || intr.date;
          if (targetDate < iStart || targetDate > iEnd) continue;
          if (intr.startTime && intr.endTime) {
            const sStart = timeToMin(slot.start), sEnd = timeToMin(slot.end);
            if (sStart >= timeToMin(intr.endTime) || sEnd <= timeToMin(intr.startTime)) continue;
          }
          warnings.push(`⚠ ${intr.title} — interruption on ${newDay}`);
          break;
        }
      }
      return warnings;
    }
    const student = students.find(s => s.id === lesson.studentId);
    if (!student) return [];
    const school = schools.find(s => s.id === lesson.schoolId);
    if (!school) return [];
    const warnings = [];
    const slotStart = timeToMin(slot.start);
    const slotEnd = timeToMin(slot.end);
    const hints = student._noteHints || {};
    const hasRequiredHere = (hints.requiredTimes || []).some(function(rt) { return rt.day === newDay && rt.start === slot.start; });
    if (slot.type === "before_school" && !student.availableBefore && !hasRequiredHere) warnings.push("Student not available before school");
    if (slot.type === "after_school" && !student.availableAfter && !hasRequiredHere) warnings.push("Student not available after school");
    const isBreak = ["recess", "lunch"].includes(slot.type);
    const isBeforeAfter = ["before_school", "after_school"].includes(slot.type);
    if (student.outsideClassOnly && !isBreak && !isBeforeAfter) warnings.push("Student should only be scheduled outside class time");
    if (student.outsideClassPreferred && !isBreak && !isBeforeAfter && slot.type === "class") warnings.push("Student prefers outside class time");
    if (hints.avoidTimes) {
      for (const at of hints.avoidTimes) {
        if (at.day === newDay && slotStart < timeToMin(at.end) && slotEnd > timeToMin(at.start)) warnings.push(`Avoid time: ${at.day} ${at.start}–${at.end}`);
      }
    }
    if (hints.avoidDays && hints.avoidDays.includes(newDay)) warnings.push(`Student should avoid ${newDay}`);
    if (hints.preferredDays && hints.preferredDays.length > 0 && !hints.preferredDays.includes(newDay)) warnings.push(`Preferred day${hints.preferredDays.length > 1 ? "s" : ""}: ${hints.preferredDays.join(", ")}`);
    const _wttUnassigned = isLessonUnassigned(lesson, students);
    if (_wttUnassigned) {
      warnings.push("No teacher assigned — assign a teacher in student details");
    }
    const teacher = _wttUnassigned ? null : teachers.find(t => t.id === lesson.teacherId);
    if (teacher) {
      const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === newDay);
      if (!dayAvail) warnings.push(`${teacher.name} not available on ${newDay}`);
      else if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) warnings.push(`Outside ${teacher.name}'s hours (${dayAvail.start}–${dayAvail.end})`);
    }

    // Multi-lesson students: must have lessons on different days
    const _wd2 = weeklyTimetables[`${weekKey}|${selectedSchool}`];
    const lessonsToCheck2 = _lessonList || (_wd2 ? _wd2.lessons : (timetable ? timetable.lessons : []));
    const otherLessons = lessonsToCheck2.filter(l => l.id !== lesson.id && l.day === newDay && (
      l.studentId === lesson.studentId ||
      (l.isGroup && l.studentIds && l.studentIds.includes(lesson.studentId))
    ));
    if (otherLessons.length > 0) {
      const studentObj = student || { name: lesson.studentName };
      warnings.push(`${studentObj.name} already has a lesson on ${newDay} (${otherLessons.map(l => l.isGroup ? l.groupName || "Group" : l.instrument).join(", ")})`);
    }

    // Interruption check — warn if this slot falls within an active interruption
    const targetDate = weekDateMap[newDay];
    if (targetDate) {
      for (const intr of weekInterruptions) {
        const iStart = intr.date, iEnd = intr.endDate || intr.date;
        if (targetDate < iStart || targetDate > iEnd) continue;
        // Class filter
        if (intr.affectsClasses !== "all") {
          const cls = student?.className || lesson.studentName || "";
          if (!classMatchesInterruption(cls, intr.affectsClasses)) continue;
        }
        // Time filter
        if (intr.startTime && intr.endTime) {
          const sStart = timeToMin(slot.start), sEnd = timeToMin(slot.end);
          if (sStart >= timeToMin(intr.endTime) || sEnd <= timeToMin(intr.startTime)) continue;
        }
        warnings.push(`⚠ ${intr.title} — interruption on ${newDay}`);
        break;
      }
    }

    // Specialist clash — any overlap between lesson slot and specialist time
    if (student && student.className) {
      const key = lesson.schoolId + "|" + student.className + "|" + newDay;
      const specs = specLookupRef[key] || [];
      const match = specs.find(sp => slotStart < sp.end && slotEnd > sp.start);
      if (match) {} // specialist shown as purple tag, not a red warning
    }

    // Dual class-time pullout: warn if this slot is during class and the student already has
    // another class-time lesson on a different day in the same week
    if (slot.type === "class") {
      const allWeekLessons = lessonsToCheck2;
      const otherClassLessons = allWeekLessons.filter(l =>
        l.id !== lesson.id &&
        l.day !== newDay &&
        (l.studentId === lesson.studentId || (l.isGroup && l.studentIds && l.studentIds.includes(lesson.studentId)))
      );
      if (otherClassLessons.length > 0) {
        const classTimeConflicts = otherClassLessons.filter(ol => {
          const olSlot = (currentSchool && currentSchool.slots ? currentSchool.slots : []).find(sl => sl.start === ol.start);
          return olSlot && olSlot.type === "class";
        });
        if (classTimeConflicts.length > 0) {
          const studentObj = student || { name: lesson.studentName };
          warnings.push(`${studentObj.name} already has a lesson during class on ${classTimeConflicts[0].day}`);
        }
      }
    }

    return warnings;
  };

  useEffect(() => {
    if (schools.length > 0 && !selectedSchool) setSelectedSchool(schools[0].id);
  }, [schools]);

  const getWeekDates = (offset) => {
    const monday = getCurrentWeekMonday();
    monday.setDate(monday.getDate() + offset * 7);
    return DAYS.map((day, d) => {
      const date = new Date(monday);
      date.setDate(monday.getDate() + d);
      return { day, date: toLocalDateStr(date), dateObj: date };
    });
  };

  const weekDates = getWeekDates(weekOffset);
  const weekKey = weekDates[0].date;
  const weekDateMap = {};
  for (const wd of weekDates) weekDateMap[wd.day] = wd.date;
  const currentSchool = schools.find(s => s.id === selectedSchool);
  // ── Drag overlay: precomputed per-slot warnings + specialist tags ──

  // Term week number
  const termBreaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));
  const getTermWeekNum = (dateStr) => {
    if (termBreaks.length === 0) return null;
    const d = new Date(dateStr + "T00:00:00");
    const getMondayOf = (dt) => {
      const m = new Date(dt);
      const dow = m.getDay();
      m.setDate(m.getDate() + (dow === 0 ? -6 : 1 - dow));
      m.setHours(0, 0, 0, 0);
      return m;
    };
    let termStartDay = null;
    let breakEndMonth = -1;
    for (const tb of termBreaks) {
      const tbEnd = new Date((tb.endDate || tb.date) + "T00:00:00");
      if (tbEnd < d) {
        termStartDay = new Date(tbEnd);
        termStartDay.setDate(termStartDay.getDate() + 1);
        breakEndMonth = tbEnd.getMonth();
      }
    }
    if (!termStartDay || breakEndMonth === 11 || breakEndMonth === 0) {
      const year = d.getFullYear();
      const start = new Date(year, 0, 27);
      while (start.getDay() !== 2) start.setDate(start.getDate() + 1);
      termStartDay = start;
    }
    const week1Monday = getMondayOf(termStartDay);
    const targetMonday = getMondayOf(d);
    const diffWeeks = Math.round((targetMonday.getTime() - week1Monday.getTime()) / (7 * 24 * 60 * 60 * 1000));
    return Math.max(1, diffWeeks + 1);
  };

  const termWeek = getTermWeekNum(weekKey);
  const weekLabel = termWeek ? `Week ${termWeek}` : `Week of ${weekKey}`;
  // term week at offset 0 = current week; minOffset scrolls back to week 1
  const currentTermWeekNum = getTermWeekNum(getWeekDates(0)[0].date);
  const minWeekOffset = currentTermWeekNum ? -(currentTermWeekNum - 1) : -20;
  const isPastWeek = weekOffset < 0;
  const isLocked = isPastWeek && !editUnlocked;
  const storageKey = `${weekKey}|${selectedSchool}`;
  const weeklyData = weeklyTimetables[storageKey] || null;

  // ── Delete key: remove selected cards ─────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (selectedCards.size === 0) return;
      e.preventDefault();
      const idsToDelete = [...selectedCards];
      setWeeklyTimetables(prev => {
        const entry = prev[storageKey];
        if (!entry) return prev;
        const lessons = entry.lessons || [];
        return { ...prev, [storageKey]: { ...entry, lessons: lessons.filter(l => !idsToDelete.includes(l.id)) } };
      });
      notify(`${idsToDelete.length} lesson${idsToDelete.length !== 1 ? "s" : ""} deleted`);
      setSelectedCards(new Set());
      setSelectedDays(new Set());
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedCards, storageKey]);

  // Load saved notes when switching weeks/schools
  useEffect(() => {
    setEditUnlocked(false);
  }, [weekOffset]);

  useEffect(() => {
    setAdjustmentNotes(weeklyData?.notes || "");
    setConstraintWarnings({});
    setAckedConstraints(new Set());
  }, [storageKey]);

  const weekInterruptions = interruptions.filter(i => {
    if (i.type === "term_break") return false;
    if (selectedSchool && i.schoolId !== selectedSchool && i.schoolId !== "all") return false;
    const start = i.date;
    const end = i.endDate || i.date;
    return weekDates.some(wd => wd.date >= start && wd.date <= end);
  });

  // Rotating hint chips
  const WTT_HINTS = [
    "No lessons this week",
    "No lessons at [school] until week 4",
    "Remove [student] from tally this week",
    "[Student] on holidays this week",
    "Extended absence for [student] — holding their place",
    "[Student] hasn't started yet — remove from tally",
    "No catch up needed",
    "What if I'm sick Thursday?",
  ];
  useEffect(() => {
    const id = setInterval(() => {
      setWttHintVisible(false);
      setTimeout(() => {
        setWttHintIdx(i => (i + 1) % WTT_HINTS.length);
        setWttHintVisible(true);
      }, 800);
    }, 4500);
    return () => clearInterval(id);
  }, []);

  // ── Add band session to WTT ────────────────────────────────
  const handleAddBandSession = (band) => {
    const day = contextMenu.day;
    const time = contextMenu.time;
    const teacher = teachers.find(t => t.id === band.teacherId);
    const existingData = weeklyTimetables[storageKey] || { lessons: [], missed: [] };
    let lessons = [...(existingData.lessons || [])];
    const newTallyEntries = [];
    const bandRemovedLessons = [];
    for (const member of (band.members || [])) {
      const student = students.find(s => s.id === member.studentId);
      if (!student) continue;
      const existingBandCount = lessons.filter(l => l.isBandSession && (l.members || []).some(m => m.studentId === member.studentId)).length;
      const studentLessons = lessons.filter(l => !l.isBandSession && l.studentId === member.studentId);
      let removedLesson = null;
      if (studentLessons.length > 0) {
        const guitarLesson = studentLessons.find(l => /guitar/i.test(l.instrument));
        if (existingBandCount === 0) {
          removedLesson = guitarLesson || studentLessons.find(l => l.instrument === member.instrument) || studentLessons[0];
        } else {
          removedLesson = guitarLesson || studentLessons[0];
        }
        if (removedLesson) { bandRemovedLessons.push(removedLesson); lessons = lessons.filter(l => l.id !== removedLesson.id); }
      }
      const masterLesson = timetable?.lessons?.find(l =>
        l.studentId === member.studentId &&
        (removedLesson ? l.instrument === removedLesson.instrument : l.instrument === member.instrument)
      ) || timetable?.lessons?.find(l => l.studentId === member.studentId);
      if (masterLesson) {
        const lKey = `${member.studentId}|${masterLesson.instrument}`;
        newTallyEntries.push({
          id: uid(), lessonKey: lKey, lessonId: masterLesson.id,
          isGroup: false, studentId: member.studentId, studentName: student.name,
          instrument: masterLesson.instrument, schoolId: band.schoolId,
          teacherId: band.teacherId || "", teacherName: teacher?.name || "",
          weekKey, weekLabel, weekNum: termWeek, termKey: null, day,
          status: "completed", reason: null,
          notes: `Band Session ${weekLabel}`,
          bandSession: true,
          makeupEligible: false, madeUp: false,
          recordedAt: new Date().toISOString(),
        });
      }
    }
    const bandLesson = {
      id: uid(), isBandSession: true,
      bandId: band.id, bandName: band.name || "TBC",
      schoolId: band.schoolId,
      teacherId: band.teacherId || "", teacherName: teacher?.name || "",
      day, start: time, end: time,
      members: band.members || [],
      removedLessons: bandRemovedLessons,
    };
    lessons = [...lessons, bandLesson];
    setWeeklyTimetables(prev => ({ ...prev, [storageKey]: { ...existingData, lessons } }));
    // Check constraints for the newly placed band session
    const bSlot = (currentSchool?.slots || []).find(s => s.start === time);
    if (bSlot) {
      const bWarnings = checkConstraints(bandLesson, day, bSlot, lessons);
      if (bWarnings.length > 0) {
        setConstraintWarnings(prev => ({ ...prev, [bandLesson.id]: bWarnings }));
        setExpandedWarnings(prev => { const next = new Set(prev); next.add(bandLesson.id); return next; });
      }
    }
    setContextMenu(null); setAddLessonSubmenu(null); addLessonSubmenuType.current = null;
  };

  const handleGenerate = async () => {
    if (!timetable) { notify("Generate a Master Timetable first", "warning"); return; }
    if (!currentSchool) return;

    let aiHints = [];
    if (adjustmentNotes.trim()) {
      setGenerating(true);
      try {
        const schoolStudents = students.filter(s => s.schoolId === selectedSchool && s.status === "active");
        const studentList = schoolStudents.map(s => `${s.name} (${s.className}, ${s.instruments.map(i => i.name).join("+")})`).join("\n");
        const classNames = [...new Set(schoolStudents.map(s => s.className))].join(", ");

        const teacherList = teachers.filter(t => t.availability.some(a => a.schoolId === selectedSchool)).map(t => t.name).join(", ");
        const schoolGroups = groups.filter(g => g.schoolId === selectedSchool && g.status === "scheduled");
        const groupList = schoolGroups.length > 0 ? schoolGroups.map(g => `${g.name} (${g.instrument}, ${g.day || "various"})`).join("\n") : "(none)";

        const todayDay = melbourneDayName();
        const todayDate = melbourneToday();

        const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: getAnthropicHeaders(),
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514", max_tokens: 2000,
            messages: [{ role: "user", content: buildWeeklyAIPrompt({ school: currentSchool, weekLabel, weekDates, todayDay, todayDate, classNames, teacherList, groupList, studentList, adjustmentNotes }) }],
          })
        });

        if (response.ok) {
          const data = await response.json();
          const text = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
          try {
            const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
            if (Array.isArray(parsed)) {
              aiHints = parsed.map(h => ({
                ...h,
                lessonMatch: (lesson) => {
                  // Teacher match
                  if (h.targetTeacherName) {
                    const tName = (lesson.teacherName || "").toLowerCase();
                    const hTeacher = h.targetTeacherName.toLowerCase();
                    if (!tName.includes(hTeacher) && !hTeacher.includes(tName.split(" ")[0])) return false;
                  }
                  // Student match
                  if (h.targetStudentName) {
                    const sName = (lesson.studentName || "").toLowerCase();
                    const hName = h.targetStudentName.toLowerCase();
                    if (!sName.includes(hName) && !hName.includes(sName.split(" ")[0])) return false;
                  }
                  // Class match
                  if (h.targetClassName) {
                    const student = students.find(s => s.id === lesson.studentId);
                    const cName = (student?.className || "").toLowerCase();
                    const hClass = h.targetClassName.toLowerCase();
                    if (!cName.includes(hClass) && !hClass.includes(cName)) return false;
                  }
                  // Instrument match
                  if (h.targetInstrument) {
                    const iName = (lesson.instrument || "").toLowerCase();
                    const hInst = h.targetInstrument.toLowerCase();
                    if (!iName.includes(hInst) && !hInst.includes(iName)) return false;
                  }
                  // Group match — by name or instrument+isGroup
                  if (h.targetGroupName) {
                    if (!lesson.isGroup) return false;
                    const gName = (lesson.groupName || lesson.studentName || "").toLowerCase();
                    const hGroup = h.targetGroupName.toLowerCase();
                    if (!gName.includes(hGroup) && !hGroup.includes(gName)) return false;
                  }
                  // Source day match (for cancel/reschedule_day — only affects lessons on a specific day)
                  if (h.sourceDay && lesson.day !== h.sourceDay) return false;
                  // Whole-school/whole-day: if no targeting criterion set, match ALL lessons (for that day via sourceDay)
                  const hasTarget = !!(h.targetStudentName || h.targetClassName || h.targetTeacherName || h.targetInstrument || h.targetGroupName);
                  if (!hasTarget && h.action === "cancel" && h.wholeSchool) return true;
                  return hasTarget;
                }
              }));
              // Extract any recurring-note hints to offer saving to student record
              const recurringHints = parsed.filter(h => h.recurringNote && h.noteText && h.targetStudentName);
              if (recurringHints.length > 0) {
                const suggestions = recurringHints.map(h => {
                  const match = students.find(s => {
                    const sn = s.name.toLowerCase();
                    const hn = h.targetStudentName.toLowerCase();
                    return sn.includes(hn) || hn.includes(sn.split(" ")[0]);
                  });
                  return match ? { studentId: match.id, studentName: match.name, noteText: h.noteText } : null;
                }).filter(Boolean);
                if (suggestions.length > 0) setPendingRecurringNotes(suggestions);
              }
              // Process tally_remove hints — apply to current week immediately
              const removeHints = parsed.filter(h => h.action === "tally_remove");
              if (removeHints.length > 0) {
                const wttLessons = timetable.lessons.filter(l => l.schoolId === selectedSchool);
                const seen = new Set();
                const removeRows = [];
                for (const l of wttLessons) {
                  const lk = l.isGroup ? "group|" + l.groupId : l.studentId + "|" + l.instrument;
                  if (!seen.has(lk)) { seen.add(lk); removeRows.push({ ...l, lessonKey: lk }); }
                }
                const newRemoveEntries = [];
                for (const h of removeHints) {
                  const reasonVal = h.tallyRemoveReason === "extended_absence" ? "extended_absence" : "removed_not_charged";
                  let matchRows = removeRows;
                  if (h.targetStudentName && !h.wholeSchool) {
                    const nl = h.targetStudentName.toLowerCase();
                    matchRows = removeRows.filter(r => {
                      const n = (r.isGroup ? (r.groupName || "") : (r.studentName || "")).toLowerCase();
                      return n.includes(nl) || nl.includes(n.split(" ")[0]);
                    });
                    if (h.targetInstrument) matchRows = matchRows.filter(r => (r.instrument || "").toLowerCase() === h.targetInstrument.toLowerCase());
                  }
                  for (const row of matchRows) {
                    newRemoveEntries.push({
                      id: uid(), lessonKey: row.lessonKey, lessonId: row.id,
                      isGroup: row.isGroup || false, groupName: row.groupName || "",
                      studentId: row.studentId || "",
                      studentName: row.isGroup ? (row.groupName || row.studentNames?.join(", ") || "Group") : row.studentName,
                      studentNames: row.studentNames || [],
                      instrument: row.instrument, schoolId: row.schoolId,
                      teacherId: row.teacherId, teacherName: row.teacherName,
                      weekKey, weekLabel, weekNum: termWeek,
                      termKey: null, day: row.day,
                      status: "removed", reason: reasonVal,
                      notes: "", makeupEligible: false, madeUp: false,
                      recordedAt: new Date().toISOString(), recordedBy: "weekly_ai",
                    });
                  }
                }
                if (newRemoveEntries.length > 0) {
                  const removeKeys = new Set(newRemoveEntries.map(e => e.lessonKey + "|" + e.weekKey));
                  setTallyEntries(prev => [...prev.filter(e => !removeKeys.has(e.lessonKey + "|" + e.weekKey)), ...newRemoveEntries]);
                  notify("Tally: " + newRemoveEntries.length + " slot" + (newRemoveEntries.length !== 1 ? "s" : "") + " removed from tally");
                }
              }
            }
          } catch (parseErr) { notify("Could not parse adjustment notes — try rephrasing", "warning"); }
        } else {
          notify(`AI request failed: ${response.status}`, "warning");
        }
      } catch (err) { console.error("AI parse error:", err); if (logError) logError("AI parse error", err.message); }
      setGenerating(false);
    }

    const schoolMasterBreaks2 = (masterBreaks || []).filter(b => b.schoolId === selectedSchool);
    // Preserve existing band sessions; skip their members from generation
    const existingBandSessions = (weeklyData?.lessons || []).filter(l => l.isBandSession);
    const bandStudentIds = new Set(existingBandSessions.flatMap(l => (l.members || []).map(m => m.studentId)));
    const filteredMasterLessons = timetable.lessons.filter(l => !bandStudentIds.has(l.studentId));
    const result = generateWeeklyTimetable(
      filteredMasterLessons, currentSchool, students, teachers, specialists, interruptions, weekDates, aiHints, schoolMasterBreaks2
    );

    setWeeklyTimetables(prev => ({
      ...prev,
      [storageKey]: { lessons: [...existingBandSessions, ...result.lessons], missed: result.missed, notes: adjustmentNotes, generatedAt: new Date().toISOString() }
    }));

    // Update cumulative missed tally
    // Auto-tally scheduler-placed missed lessons as "timetable_clash"
    const autoTallyEntries = result.missed
      .filter(m => m.reason && (m.reason.includes("No available slot") || m.reason.includes("conflict") || m.reason.includes("Cancelled by weekly")))
      .map(m => {
        const lKey = m.isGroup ? `group|${m.groupId}` : `${m.studentId}|${m.instrument}`;
        return {
          id: uid(),
          lessonKey: lKey, lessonId: m.id,
          isGroup: m.isGroup || false, groupName: m.groupName || "",
          studentId: m.studentId || "",
          studentName: m.isGroup ? (m.groupName || m.studentNames?.join(", ") || "Group") : m.studentName,
          studentNames: m.studentNames || [],
          instrument: m.instrument, schoolId: m.schoolId,
          teacherId: m.teacherId, teacherName: m.teacherName,
          weekKey, weekLabel, weekNum: termWeek,
          termKey: null, day: m.day,
          status: "missed", reason: "timetable_clash",
          notes: m.reason || "",
          makeupEligible: (() => { const mh = aiHints.find(h => h.lessonMatch && h.lessonMatch(m)); return mh?.makeupEligible === false ? false : true; })(),
          madeUp: false,
          recordedAt: new Date().toISOString(), autoRecorded: true,
        };
      });
    if (autoTallyEntries.length > 0) {
      setTallyEntries(prev => {
        // Remove previous auto-recorded entries for this week+school, then add new ones
        const filtered = prev.filter(e => !(e.autoRecorded && e.weekKey === weekKey && e.schoolId === selectedSchool));
        return [...filtered, ...autoTallyEntries];
      });
    }

    const adj = result.lessons.filter(l => l.adjusted).length;
    notify(`Weekly timetable: ${result.lessons.length} lessons, ${adj} adjusted, ${result.missed.length} missed`);
  };

  const handleGenerateAllSchools = async () => {
    if (!timetable) { notify("Generate a Master Timetable first", "warning"); return; }
    for (const school of schools) {
      const schoolBreaks = (masterBreaks || []).filter(b => b.schoolId === school.id);
      const sk = weekDates[0].date + "|" + school.id;
      const existingBandSessionsAll = ((weeklyTimetables[sk] || {}).lessons || []).filter(l => l.isBandSession);
      const bandStudentIdsAll = new Set(existingBandSessionsAll.flatMap(l => (l.members || []).map(m => m.studentId)));
      const filteredAll = timetable.lessons.filter(l => !bandStudentIdsAll.has(l.studentId));
      const result = generateWeeklyTimetable(
        filteredAll, school, students, teachers, specialists, interruptions, weekDates, [], schoolBreaks
      );
      setWeeklyTimetables(prev => ({
        ...prev,
        [sk]: { lessons: [...existingBandSessionsAll, ...result.lessons], missed: result.missed, generatedAt: new Date().toISOString() }
      }));
    }
  };

  const importFromMTT = (targetDay) => {
    if (!timetable) { notify("No master timetable to import from", "warning"); return; }
    const weekDateMap = {};
    for (const wd of weekDates) weekDateMap[wd.day] = wd.date;
    const mttLessons = timetable.lessons.filter(l =>
      l.schoolId === selectedSchool && (!targetDay || l.day === targetDay)
    );
    const importedLessons = mttLessons.map(l => ({ ...l, id: uid(), weekDate: weekDateMap[l.day], adjusted: false }));
    if (targetDay) {
      const existing = weeklyTimetables[storageKey];
      const otherDays = existing ? existing.lessons.filter(l => l.day !== targetDay) : [];
      setWeeklyTimetables(prev => ({
        ...prev,
        [storageKey]: { lessons: [...otherDays, ...importedLessons], missed: existing?.missed || [], generatedAt: new Date().toISOString() }
      }));
      notify(`Imported ${importedLessons.length} lessons for ${targetDay}`);
    } else {
      setWeeklyTimetables(prev => ({
        ...prev,
        [storageKey]: { lessons: importedLessons, missed: [], generatedAt: new Date().toISOString() }
      }));
      notify(`Imported ${importedLessons.length} lessons for the week`);
    }
    setConfirmImportExpanded(false);
    setExpandedBtn(null);
  };

  const importAllSchoolsFromMTT = () => {
    if (!timetable) { notify("No master timetable to import from", "warning"); return; }
    const weekDateMap = {};
    for (const wd of weekDates) weekDateMap[wd.day] = wd.date;
    for (const school of schools) {
      const sk = weekDates[0].date + "|" + school.id;
      const mttLessons = timetable.lessons.filter(l => l.schoolId === school.id);
      const importedLessons = mttLessons.map(l => ({ ...l, id: uid(), weekDate: weekDateMap[l.day], adjusted: false }));
      setWeeklyTimetables(prev => ({
        ...prev,
        [sk]: { lessons: importedLessons, missed: [], generatedAt: new Date().toISOString() }
      }));
    }
    notify("Imported from MTT for all schools");
    setConfirmImportAllWeeks(false);
  };

  const handleGenerateDay = async (targetDay) => {
    if (!timetable) { notify("Generate a Master Timetable first", "warning"); return; }
    if (!currentSchool) return;

    // Parse adjustment notes for this day (same AI call as full-week generate)
    let aiHints = [];
    if (adjustmentNotes.trim()) {
      setGenerating(true);
      try {
        const schoolStudents = students.filter(s => s.schoolId === selectedSchool && s.status === "active");
        const studentList = schoolStudents.map(s => `${s.name} (${s.className}, ${s.instruments.map(i => i.name).join("+")})`).join("\n");
        const classNames = [...new Set(schoolStudents.map(s => s.className))].join(", ");
        const teacherList = teachers.filter(t => t.availability.some(a => a.schoolId === selectedSchool)).map(t => t.name).join(", ");
        const schoolGroups2 = groups.filter(g => g.schoolId === selectedSchool && g.status === "scheduled");
        const groupList2 = schoolGroups2.length > 0 ? schoolGroups2.map(g => `${g.name} (${g.instrument}, ${g.day || "various"})`).join("\n") : "(none)";
        const todayDay = melbourneDayName();
        const todayDate = melbourneToday();

        const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: getAnthropicHeaders(),
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514", max_tokens: 2000,
            messages: [{ role: "user", content: buildWeeklyAIPrompt({ school: currentSchool, weekLabel, weekDates, todayDay, todayDate, classNames, teacherList, groupList: groupList2, studentList, adjustmentNotes, targetDay }) }],
          })
        });

        if (response.ok) {
          const data = await response.json();
          const text = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
          try {
            const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
            if (Array.isArray(parsed)) {
              // Only keep hints that apply to the target day (sourceDay matches or is null/unset)
              const dayHints = parsed.filter(h => !h.sourceDay || h.sourceDay === targetDay);
              aiHints = dayHints.map(h => ({
                ...h,
                lessonMatch: (lesson) => {
                  // Teacher match
                  if (h.targetTeacherName) {
                    const tName = (lesson.teacherName || "").toLowerCase();
                    const hTeacher = h.targetTeacherName.toLowerCase();
                    if (!tName.includes(hTeacher) && !hTeacher.includes(tName.split(" ")[0])) return false;
                  }
                  // Student match
                  if (h.targetStudentName) {
                    const sName = (lesson.studentName || "").toLowerCase();
                    const hName = h.targetStudentName.toLowerCase();
                    if (!sName.includes(hName) && !hName.includes(sName.split(" ")[0])) return false;
                  }
                  // Class match
                  if (h.targetClassName) {
                    const student = students.find(s => s.id === lesson.studentId);
                    const cName = (student?.className || "").toLowerCase();
                    const hClass = h.targetClassName.toLowerCase();
                    if (!cName.includes(hClass) && !hClass.includes(cName)) return false;
                  }
                  // Instrument match
                  if (h.targetInstrument) {
                    const iName = (lesson.instrument || "").toLowerCase();
                    const hInst = h.targetInstrument.toLowerCase();
                    if (!iName.includes(hInst) && !hInst.includes(iName)) return false;
                  }
                  // Group match — by name or instrument+isGroup
                  if (h.targetGroupName) {
                    if (!lesson.isGroup) return false;
                    const gName = (lesson.groupName || lesson.studentName || "").toLowerCase();
                    const hGroup = h.targetGroupName.toLowerCase();
                    if (!gName.includes(hGroup) && !hGroup.includes(gName)) return false;
                  }
                  // Source day match (for cancel/reschedule_day — only affects lessons on a specific day)
                  if (h.sourceDay && lesson.day !== h.sourceDay) return false;
                  // Whole-school/whole-day: if no targeting criterion set, match ALL lessons (for that day via sourceDay)
                  const hasTarget = !!(h.targetStudentName || h.targetClassName || h.targetTeacherName || h.targetInstrument || h.targetGroupName);
                  if (!hasTarget && h.action === "cancel" && h.wholeSchool) return true;
                  return hasTarget;
                }
              }));
              // Extract any recurring-note hints to offer saving to student record
              const recurringHintsDay = parsed.filter(h => h.recurringNote && h.noteText && h.targetStudentName);
              if (recurringHintsDay.length > 0) {
                const suggestions = recurringHintsDay.map(h => {
                  const match = students.find(s => {
                    const sn = s.name.toLowerCase();
                    const hn = h.targetStudentName.toLowerCase();
                    return sn.includes(hn) || hn.includes(sn.split(" ")[0]);
                  });
                  return match ? { studentId: match.id, studentName: match.name, noteText: h.noteText } : null;
                }).filter(Boolean);
                if (suggestions.length > 0) setPendingRecurringNotes(suggestions);
              }
            }
          } catch(parseErr) { notify("Could not parse adjustment notes — try rephrasing", "warning"); }
        } else {
          notify(`AI request failed: ${response.status}`, "warning");
        }
      } catch (err) { console.error("AI parse error:", err); if (logError) logError("AI parse error", err.message); }
      setGenerating(false);
    }

    // Generate the full week to get correct results for the target day
    const schoolMasterBreaks3 = (masterBreaks || []).filter(b => b.schoolId === selectedSchool);
    const existingBandSessionsDay = (weeklyData?.lessons || []).filter(l => l.isBandSession);
    const bandStudentIdsDay = new Set(existingBandSessionsDay.flatMap(l => (l.members || []).map(m => m.studentId)));
    const filteredMasterDay = timetable.lessons.filter(l => !bandStudentIdsDay.has(l.studentId));
    const result = generateWeeklyTimetable(
      filteredMasterDay, currentSchool, students, teachers, specialists, interruptions, weekDates, aiHints, schoolMasterBreaks3
    );

    // Get existing weekly data (if any)
    const existing = weeklyTimetables[storageKey];

    // Keep existing lessons for other days (including band sessions), use new results only for target day
    const otherDayLessons = existing ? existing.lessons.filter(l => l.day !== targetDay || l.isBandSession) : [];
    const newDayLessons = result.lessons.filter(l => l.day === targetDay);
    const otherDayMissed = existing ? existing.missed.filter(m => m.day !== targetDay) : [];
    const newDayMissed = result.missed.filter(m => m.day === targetDay);

    const mergedLessons = [...otherDayLessons, ...newDayLessons];
    const mergedMissed = [...otherDayMissed, ...newDayMissed];

    setWeeklyTimetables(prev => ({
      ...prev,
      [storageKey]: { lessons: mergedLessons, missed: mergedMissed, notes: adjustmentNotes, generatedAt: new Date().toISOString() }
    }));

    // Auto-tally AI-cancelled and unplaceable lessons for this day
    const autoTallyDay = newDayMissed
      .filter(m => m.reason && (m.reason.includes("No available slot") || m.reason.includes("conflict") || m.reason.includes("Cancelled by weekly")))
      .map(m => {
        const lKey = m.isGroup ? `group|${m.groupId}` : `${m.studentId}|${m.instrument}`;
        // Find matching hint to check makeupEligible override
        const matchingHint = aiHints.find(h => h.lessonMatch && h.lessonMatch(m));
        const makeupElig = matchingHint?.makeupEligible === false ? false : true;
        return {
          id: uid(),
          lessonKey: lKey, lessonId: m.id,
          isGroup: m.isGroup || false, groupName: m.groupName || "",
          studentId: m.studentId || "",
          studentName: m.isGroup ? (m.groupName || m.studentNames?.join(", ") || "Group") : m.studentName,
          studentNames: m.studentNames || [],
          instrument: m.instrument, schoolId: m.schoolId,
          teacherId: m.teacherId, teacherName: m.teacherName,
          weekKey, weekLabel, weekNum: termWeek,
          termKey: null, day: m.day,
          status: "missed", reason: m.reason?.includes("Cancelled by weekly") ? "informed_absence" : "timetable_clash",
          notes: m.reason || "",
          makeupEligible: makeupElig, madeUp: false,
          recordedAt: new Date().toISOString(), autoRecorded: true,
        };
      });
    if (autoTallyDay.length > 0) {
      setTallyEntries(prev => {
        const filtered = prev.filter(e => !(e.autoRecorded && e.weekKey === weekKey && e.schoolId === selectedSchool && e.day === targetDay));
        return [...filtered, ...autoTallyDay];
      });
    }

    const adj = newDayLessons.filter(l => l.adjusted).length;
    notify(`${targetDay}: ${newDayLessons.length} lessons${adj > 0 ? `, ${adj} adjusted` : ""}${newDayMissed.length > 0 ? `, ${newDayMissed.length} missed` : ""}`);
  };

  React.useEffect(() => {
    if (!showClearMenu) return;
    const handler = (e) => {
      if (clearMenuRef.current && clearMenuRef.current.contains(e.target)) return;
      if (clearMenuBtnRef.current && clearMenuBtnRef.current.contains(e.target)) return;
      setShowClearMenu(false); setConfirmClearWeek(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showClearMenu]);

  const clearWeek = (day) => {
    if (day) {
      setWeeklyTimetables(prev => {
        const entry = prev[storageKey];
        if (!entry) return prev;
        return { ...prev, [storageKey]: { ...entry, lessons: entry.lessons.filter(l => l.day !== day) } };
      });
    } else {
      setWeeklyTimetables(prev => { const n = { ...prev }; delete n[storageKey]; return n; });
    }
  };

  const handleDeleteWeeklyLesson = (lessonId) => {
    setWeeklyTimetables(prev => {
      const entry = prev[storageKey];
      if (!entry) return prev;
      return { ...prev, [storageKey]: { ...entry, lessons: entry.lessons.filter(l => l.id !== lessonId) } };
    });
  };

  const handleMissedDrop = (lessonId) => {
    if (!weeklyData) return;
    const lesson = weeklyData.lessons.find(l => l.id === lessonId);
    if (!lesson) return;
    const missedEntry = { ...lesson, reason: "Removed from schedule" };
    // Move lesson to missed area
    setWeeklyTimetables(prev => {
      const entry = prev[storageKey];
      if (!entry) return prev;
      return { ...prev, [storageKey]: { ...entry, lessons: entry.lessons.filter(l => l.id !== lessonId), missed: [...(entry.missed || []), missedEntry] } };
    });
    const lessonKey = `${lesson.studentId}|${lesson.instrument}`;
    if (isPastWeek) {
      // Past week (unlocked): skip dialog, auto-record missed, remove any completed entry
      const tBreaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));
      const wNum = computeTermWeekNum(weekKey, tBreaks);
      const missedTallyEntry = {
        id: uid(), lessonKey, lessonId: lesson.id,
        isGroup: false, groupName: "",
        studentId: lesson.studentId || "", studentName: lesson.studentName || "",
        instrument: lesson.instrument, schoolId: lesson.schoolId,
        teacherId: lesson.teacherId, teacherName: lesson.teacherName,
        weekKey, weekLabel: wNum ? `Week ${wNum}` : `Week of ${weekKey}`,
        weekNum: wNum, termKey: computeTermKey(weekKey, tBreaks), day: lesson.day,
        status: "missed", reason: null, notes: "",
        makeupEligible: false, madeUp: false,
        recordedAt: new Date().toISOString(),
      };
      setTallyEntries(prev => [...prev.filter(e => !(e.lessonKey === lessonKey && e.weekKey === weekKey)), missedTallyEntry]);
    } else {
      // Current week: open tally prompt dialog
      setTallyPromptNotes("");
      setTallyPrompt({ lesson, missedEntry, weekKey, weekNum: termWeek });
    }
  };


  const showHoverPanel = (x, y, warnings, specs) => {
    const el = hoverPanelRef.current;
    if (!el) return;
    if (!warnings.length && !specs.length) { el.style.display = "none"; return; }
    let html = "";
    if (specs.length > 0) html += '<div style="color:#8B5CF6;font-weight:600;margin-bottom:' + (warnings.length ? "4px" : "0") + '">' + specs.join(", ") + "</div>";
    for (let i = 0; i < warnings.length; i++) html += '<div style="color:#DC2626;font-weight:500">&#9888; ' + warnings[i] + "</div>";
    el.innerHTML = html;
    el.style.display = "block";
    const pw = el.offsetWidth || 220;
    const ph = el.offsetHeight || 60;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 12;
    let left = x + 14;
    let top = y + 24;
    if (left + pw > vw - margin) left = x - pw - 8;
    if (left < margin) left = margin;
    if (top + ph > vh - margin) top = y - ph - 10;
    if (top < margin) top = margin;
    el.style.left = left + "px";
    el.style.top = top + "px";
  };
  const hideHoverPanel = () => { if (hoverPanelRef.current) hoverPanelRef.current.style.display = "none"; };

  const handleWeeklyMoveLesson = (lessonId, newDay, newTime) => {
    if (!weeklyData || !currentSchool) return;
    const slot = currentSchool.slots.find(s => s.start === newTime);
    if (!slot) return;
    const lesson = weeklyData.lessons.find(l => l.id === lessonId);
    setWeeklyTimetables(prev => {
      const entry = prev[storageKey];
      if (!entry) return prev;
      const dayDate = weekDates.find(wd => wd.day === newDay);
      return {
        ...prev,
        [storageKey]: {
          ...entry,
          lessons: entry.lessons.map(l => l.id === lessonId ? {
            ...l, day: newDay, start: slot.start, end: slot.end, slotId: slot.id, slotName: slot.name,
            weekDate: dayDate?.date || l.weekDate,
            adjusted: false, adjustReason: undefined,
            duringSpecialist: l.isBandSession ? false : getSpecialistForSlot(l, newDay, slot)
          } : l)
        }
      };
    });
    if (lesson) {
      // Simulate the weekly lesson list after the move for stale-warning re-evaluation
      const currentEntry = weeklyTimetables[`${weekKey}|${selectedSchool}`];
      const currentLessons = currentEntry ? currentEntry.lessons : [];
      const simulatedLessons = currentLessons.map(l =>
        l.id === lessonId ? { ...l, day: newDay, start: newTime, end: slot.end, slotId: slot.id } : l
      );
      const warnings = checkConstraints(lesson, newDay, slot, simulatedLessons);
      setConstraintWarnings(prev => {
        const next = { ...prev };
        if (warnings.length > 0) next[lessonId] = warnings;
        else delete next[lessonId];
        // Re-evaluate all other warned lessons with simulated state
        for (const warnId of Object.keys(prev)) {
          if (warnId === lessonId) continue;
          const wl = currentLessons.find(l => l.id === warnId);
          if (!wl) { delete next[warnId]; continue; }
          const wlSchool = schools.find(s => s.id === wl.schoolId);
          const wlSlot = wlSchool?.slots.find(s => s.start === wl.start);
          if (!wlSlot) continue;
          const recomputed = checkConstraints(wl, wl.day, wlSlot, simulatedLessons);
          if (recomputed.length > 0) next[warnId] = recomputed;
          else delete next[warnId];
        }
        return next;
      });
      setAckedConstraints(prev => { const next = new Set(prev); next.delete(lessonId); return next; });
      if (warnings.length > 0) {
        setExpandedWarnings(prev => { const next = new Set(prev); next.add(lessonId); return next; });
      } else {
        setExpandedWarnings(prev => { const next = new Set(prev); next.delete(lessonId); return next; });
      }
    }
  };

  // Rescue a missed lesson by placing it into the weekly timetable at a specific slot
  const handleRescueMissed = (missedIndex, newDay, newTime) => {
    if (!weeklyData || !currentSchool) return;
    const slot = currentSchool.slots.find(s => s.start === newTime);
    if (!slot) return;
    const missed = weeklyData.missed[missedIndex];
    if (!missed) return;
    const dayDate = weekDates.find(wd => wd.day === newDay);
    const rescuedLesson = {
      ...missed, day: newDay, slotId: slot.id, slotName: slot.name,
      start: slot.start, end: slot.end,
      weekDate: dayDate?.date, adjusted: true, adjustReason: "Rescheduled from missed",
      duringSpecialist: getSpecialistForSlot(missed, newDay, slot)
    };
    delete rescuedLesson.reason;
    setWeeklyTimetables(prev => {
      const entry = prev[storageKey];
      if (!entry) return prev;
      const newMissed = [...entry.missed];
      newMissed.splice(missedIndex, 1);
      return { ...prev, [storageKey]: { ...entry, lessons: [...entry.lessons, rescuedLesson], missed: newMissed } };
    });
    // Run constraint checks — same warning/expand logic as handleWeeklyMoveLesson
    const warnings = checkConstraints(rescuedLesson, newDay, slot);
    setConstraintWarnings(prev => {
      const next = { ...prev };
      if (warnings.length > 0) next[rescuedLesson.id] = warnings;
      else delete next[rescuedLesson.id];
      return next;
    });
    setAckedConstraints(prev => { const next = new Set(prev); next.delete(rescuedLesson.id); return next; });
    if (warnings.length > 0) {
      setExpandedWarnings(prev => { const next = new Set(prev); next.add(rescuedLesson.id); return next; });
    } else {
      setExpandedWarnings(prev => { const next = new Set(prev); next.delete(rescuedLesson.id); return next; });
    }
    // Update tally: remove missed entry; add completed entry if the slot day is past 6pm
    const lessonKey = missed.isGroup ? `group|${missed.groupId}` : `${missed.studentId}|${missed.instrument}`;
    if (isDayPast6pm(newDay, weekKey)) {
      const tBreaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));
      const wNum = computeTermWeekNum(weekKey, tBreaks);
      const completedEntry = {
        id: uid(), lessonKey, lessonId: missed.id,
        isGroup: false, groupName: "",
        studentId: missed.studentId || "", studentName: missed.studentName || "",
        instrument: missed.instrument, schoolId: missed.schoolId,
        teacherId: missed.teacherId, teacherName: missed.teacherName,
        weekKey, weekLabel: wNum ? `Week ${wNum}` : `Week of ${weekKey}`,
        weekNum: wNum, termKey: computeTermKey(weekKey, tBreaks), day: newDay,
        status: "completed", reason: null, notes: "",
        makeupEligible: false, madeUp: false,
        recordedAt: new Date().toISOString(),
      };
      setTallyEntries(prev => [...prev.filter(e => !(e.lessonKey === lessonKey && e.weekKey === weekKey)), completedEntry]);
    } else {
      setTallyEntries(prev => prev.filter(e => !(e.lessonKey === lessonKey && e.weekKey === weekKey)));
    }
    notify(`${missed.isGroup ? missed.groupName : missed.studentName} rescheduled to ${newDay} ${slot.start}`);
  };

  // Place a staged catch-up card onto the grid at a specific slot
  const handlePlaceStagedCatchup = (stagedId, newDay, newTime) => {
    if (!weeklyData || !currentSchool) return;
    const slot = currentSchool.slots.find(s => s.start === newTime);
    if (!slot) return;
    const staged = (weeklyData.catchupStaged || []).find(c => c.id === stagedId);
    if (!staged) return;
    const dayDate = weekDates.find(wd => wd.day === newDay);

    // ── Staged band session ──
    if (staged.isBandSession) {
      const band = bands.find(b => b.id === staged.bandId);
      if (!band) return;
      const existingData = weeklyTimetables[storageKey] || { lessons: [], missed: [] };
      let lessons = [...(existingData.lessons || [])];
      // Remove individual lesson cards for members (same logic as handleAddBandSession)
      const bandRemovedLessons = [];
      for (const member of (band.members || [])) {
        const matchInst = lessons.find(l => !l.isBandSession && l.studentId === member.studentId && l.instrument === member.instrument && l.day === newDay);
        if (matchInst) { bandRemovedLessons.push(matchInst); lessons = lessons.filter(l => l.id !== matchInst.id); continue; }
        const matchAny = lessons.find(l => !l.isBandSession && l.studentId === member.studentId && l.day === newDay);
        if (matchAny) { bandRemovedLessons.push(matchAny); lessons = lessons.filter(l => l.id !== matchAny.id); }
      }
      const teacher = teachers.find(t => t.id === band.teacherId);
      const bandLesson = {
        id: staged.id, isBandSession: true, bandId: band.id, bandName: band.name,
        schoolId: band.schoolId, teacherId: band.teacherId || "",
        teacherName: teacher?.name || "",
        day: newDay, start: slot.start, end: slot.end, slotId: slot.id,
        weekDate: dayDate?.date || "", fromStaged: true,
        members: (band.members || []).map(m => ({ id: m.id, studentId: m.studentId, instrument: m.instrument })),
        removedLessons: bandRemovedLessons,
      };
      lessons = [...lessons, bandLesson];
      setWeeklyTimetables(prev => ({
        ...prev,
        [storageKey]: { ...existingData, lessons, catchupStaged: (existingData.catchupStaged || []).filter(c => c.id !== stagedId) }
      }));
      const bWarnings = checkConstraints(bandLesson, newDay, slot, lessons);
      if (bWarnings.length > 0) {
        setConstraintWarnings(prev => ({ ...prev, [bandLesson.id]: bWarnings }));
        setExpandedWarnings(prev => { const next = new Set(prev); next.add(bandLesson.id); return next; });
      }
      notify(`Band session placed: ${band.name} — ${newDay} ${slot.start}`);
      return;
    }

    const placedLesson = {
      ...staged,
      day: newDay, slotId: slot.id, slotName: slot.name,
      start: slot.start, end: slot.end,
      weekDate: dayDate?.date || "",
      adjusted: false,
      fromStaged: true,
      duringSpecialist: getSpecialistForSlot(staged, newDay, slot),
    };
    setWeeklyTimetables(prev => {
      const entry = prev[storageKey];
      if (!entry) return prev;
      return {
        ...prev,
        [storageKey]: {
          ...entry,
          lessons: [...entry.lessons, placedLesson],
          catchupStaged: (entry.catchupStaged || []).filter(c => c.id !== stagedId),
        }
      };
    });
    // Run constraint checks
    const warnings = checkConstraints(placedLesson, newDay, slot);
    setConstraintWarnings(prev => {
      const next = { ...prev };
      if (warnings.length > 0) next[placedLesson.id] = warnings;
      else delete next[placedLesson.id];
      return next;
    });
    setAckedConstraints(prev => { const next = new Set(prev); next.delete(placedLesson.id); return next; });
    if (warnings.length > 0) {
      setExpandedWarnings(prev => { const next = new Set(prev); next.add(placedLesson.id); return next; });
    }
    notify("Catch-up lesson placed: " + (staged.studentName || "") + " " + newDay + " " + slot.start);
  };

  // Missed tally grouped by student+instrument — derived from tallyEntries
  const tallyByStudent = {};
  for (const e of tallyEntries) {
    if (e.status !== "missed") continue;
    const k = `${e.studentId}|${e.instrument}`;
    if (!tallyByStudent[k]) tallyByStudent[k] = { ...e, count: 0, weeks: [] };
    tallyByStudent[k].count++;
    tallyByStudent[k].weeks.push(e.weekLabel || e.weekKey || "?");
  }

  return (
    <div onClick={() => { if (contextMenu) { setContextMenu(null); setHoverNotes(false); setMissedZoneSubmenu(null); setDayHeaderSubmenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); setSwapTeacherSubmenu(null); } if (expandedWarnings.size > 0) setExpandedWarnings(new Set()); }}>

      {/* Tally prompt — shown when lesson is manually dragged to missed area */}
      {tallyPrompt && (() => {
        const closeBoth = () => { setTallyPrompt(null); setTallyConfirm(null); };
        const lesson = tallyPrompt.lesson;

        // Helper: save a tally entry and move to step 2
        const saveAndConfirm = (reasonValue, reasonLabel, makeupElig) => {
          const lKey = lesson.isGroup ? `group|${lesson.groupId}` : `${lesson.studentId}|${lesson.instrument}`;
          const entry = {
            id: uid(), lessonKey: lKey, lessonId: lesson.id,
            isGroup: lesson.isGroup || false, groupName: lesson.groupName || "",
            studentId: lesson.studentId || "",
            studentName: lesson.isGroup ? (lesson.groupName || lesson.studentNames?.join(", ") || "Group") : lesson.studentName,
            studentNames: lesson.studentNames || [],
            instrument: lesson.instrument, schoolId: lesson.schoolId,
            teacherId: lesson.teacherId, teacherName: lesson.teacherName,
            weekKey: tallyPrompt.weekKey, weekLabel, weekNum: tallyPrompt.weekNum,
            termKey: null, day: lesson.day,
            status: "missed", reason: reasonValue,
            notes: tallyPromptNotes.trim(),
            makeupEligible: makeupElig, madeUp: false,
            recordedAt: new Date().toISOString(),
          };
          setTallyEntries(prev => [...prev.filter(e => !(e.lessonKey === lKey && e.weekKey === tallyPrompt.weekKey)), entry]);
          notify(`Missed lesson recorded: ${reasonLabel}`);
          setTallyConfirm({ lesson, reasonValue, reasonLabel, makeupEligible: makeupElig, weekLabel });
        };

        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={closeBoth}>
            <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: 340, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", maxHeight: "90vh", overflowY: "auto" }}
              onClick={e => e.stopPropagation()}>

              {/* ── Header (same in both steps) ── */}
              <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 4 }}>
                {lesson.isGroup ? (lesson.groupName || "Group") : lesson.studentName}
              </div>
              <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 18 }}>
                {lesson.instrument} · {lesson.day} · {weekLabel}
              </div>

              {tallyConfirm ? (
                /* ── Step 2: confirmation + email ── */
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 9, padding: "10px 14px", marginBottom: 16 }}>
                    <span style={{ fontSize: 18, lineHeight: 1 }}>✓</span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "#16A34A" }}>Missed lesson recorded</div>
                      <div style={{ fontSize: 12, color: "#15803D", marginTop: 1 }}>{tallyConfirm.reasonLabel}{tallyConfirm.makeupEligible ? " · makeup owed" : ""}</div>
                    </div>
                  </div>
                  {(() => {
                    const st = !lesson.isGroup ? students.find(s => s.id === lesson.studentId) : null;
                    const emails = st ? getParentEmails(st) : [];
                    if (!emails.length) return null;
                    const school = schools.find(s => s.id === (lesson.schoolId || selectedSchool));
                    const tmpl = getEmailTemplates()[tallyConfirm.reasonValue] || getEmailTemplates().other;
                    const parentName = (st?.parents?.[0]?.name || "").split(" ")[0] || "there";
                    const resolved = resolveTemplate(tmpl, {
                      studentName: preferredFirstName(lesson.studentName),
                      parentName: preferredFirstName(parentName) || 'there',
                      instrument: lesson.instrument,
                      day: lesson.day,
                      weekLabel,
                      teacherName: lesson.teacherName || "",
                      schoolName: school?.name || "",
                    });
                    const tallyMergeCtx = {
                      student_name: lesson.studentName || "",
                      parent_name: parentName,
                      instrument: lesson.instrument || "",
                      day: lesson.day || "",
                      lesson_time: lesson.start || "",
                      week_label: weekLabel || "",
                      absence_reason: tallyConfirm.reasonLabel || "",
                      teacher_name: lesson.teacherName || "",
                      school_name: school?.name || "",
                      class_name: st?.className || "",
                    };
                    return (
                      <button
                        onClick={() => { openCompose(emails, { subject: resolved.subject, body: resolved.body, from: school?.senderEmail || "", triggerId: "tally_missed", mergeCtx: tallyMergeCtx }); }}
                        style={{ width: "100%", padding: "9px 0", borderRadius: 8, background: colors.accentLight, color: colors.accentDark, fontWeight: 600, fontSize: 13, border: `1.5px solid ${colors.accent}`, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 8 }}
                        onMouseEnter={e => e.currentTarget.style.background = colors.accent + "33"}
                        onMouseLeave={e => e.currentTarget.style.background = colors.accentLight}>
                        <span style={{ fontSize: 17, lineHeight: 1 }}>✉</span> Email Parent
                      </button>
                    );
                  })()}
                  <button onClick={closeBoth}
                    style={{ width: "100%", padding: "9px 0", borderRadius: 8, background: "#F3F4F6", color: "#374151", fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#E5E7EB"} onMouseLeave={e => e.currentTarget.style.background = "#F3F4F6"}>
                    Done
                  </button>
                </>
              ) : (
                /* ── Step 1: notes + reason picker ── */
                <>
                  <div style={{ marginBottom: 14 }}>
                    <textarea value={tallyPromptNotes} onChange={e => setTallyPromptNotes(e.target.value)}
                      placeholder="Notes (optional) — e.g. Will catch up Thursday lunch…"
                      style={{ width: "100%", padding: "8px 10px", border: "1px solid #D1D5DB", borderRadius: 7, fontSize: 13, fontFamily: "inherit", resize: "vertical", minHeight: 52, boxSizing: "border-box", color: "#374151" }} />
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Why was this lesson missed?</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                    {TALLY_REASONS.filter(r => !r.invisible).map(r => {
                      const makeupElig = r.makeupEligible === null ? true : (r.makeupEligible || false);
                      return (
                        <button key={r.value} onClick={() => saveAndConfirm(r.value, r.label, makeupElig)}
                          style={{ padding: "9px 12px", borderRadius: 7, border: "1.5px solid #E5E7EB", background: "#fff", color: "#374151", fontWeight: 400, fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                          onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                          onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
                          {r.label}
                          {r.makeupEligible === true && <span style={{ fontSize: 11, color: "#D97706", fontWeight: 600 }}>● makeup owed</span>}
                          {r.makeupEligible === false && <span style={{ fontSize: 11, color: "#9CA3AF" }}>no makeup</span>}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => saveAndConfirm("other", "Other", true)}
                      style={{ flex: 1, padding: "9px 0", borderRadius: 8, background: "#F3F4F6", color: "#374151", fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}
                      onMouseEnter={e => e.currentTarget.style.background = "#E5E7EB"} onMouseLeave={e => e.currentTarget.style.background = "#F3F4F6"}>
                      Save (no reason)
                    </button>
                    <button onClick={closeBoth}
                      style={{ flex: 1, padding: "9px 0", borderRadius: 8, background: "#F3F4F6", color: "#374151", fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}
                      onMouseEnter={e => e.currentTarget.style.background = "#E5E7EB"} onMouseLeave={e => e.currentTarget.style.background = "#F3F4F6"}>
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* 2: Note popup */}
      {notePopup && (() => {
        const POPUP_W = 260, POPUP_H = notePopup.studentNote ? 160 : 110;
        const gridEl = gridScrollRef.current;
        const gridRect = gridEl ? gridEl.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        const left = Math.min(Math.max(notePopup.x, gridRect.left + 8), gridRect.right - POPUP_W - 8);
        const top = Math.min(Math.max(notePopup.y, gridRect.top + 8), gridRect.bottom - POPUP_H - 8);
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 10100 }} onMouseDown={() => setNotePopup(null)}>
            <div style={{ position: "fixed", left, top, zIndex: 10101, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.18)", padding: 14, width: POPUP_W }}
              onMouseDown={e => e.stopPropagation()}>
              {notePopup.studentNote && (
                <div style={{ marginBottom: 10, padding: "7px 10px", background: colors.bg, borderRadius: 7, border: `1px solid ${colors.borderLight}` }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Student note</div>
                  <div style={{ fontSize: 12, color: colors.text, lineHeight: 1.5 }}>{notePopup.studentNote}</div>
                </div>
              )}
              <div style={{ fontSize: 12, fontWeight: 600, color: colors.sidebarActive, marginBottom: 6 }}>
                {notePopup.studentNote ? "Lesson note (this week)" : "Add lesson note"}
              </div>
              <input autoFocus value={notePopupDraft} onChange={e => setNotePopupDraft(e.target.value)}
                placeholder="e.g. catching up Thursday…"
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    setWeeklyTimetables(prev => { const d = prev[notePopup.storageKey]; if (!d) return prev; return { ...prev, [notePopup.storageKey]: { ...d, lessons: d.lessons.map(x => x.id === notePopup.lessonId ? { ...x, cardNote: notePopupDraft.trim() || undefined } : x) } }; });
                    setNotePopup(null);
                  }
                  if (e.key === "Escape") setNotePopup(null);
                }}
                style={{ width: "100%", padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
              <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 6 }}>Enter to save · Esc to cancel</div>
            </div>
          </div>
        );
      })()}

      {/* 6: Bulk missed modal */}
      {bulkMissedModal && (() => {
        const selLessons = (weeklyData?.lessons || []).filter(l => bulkMissedModal.lessonIds.includes(l.id));
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setBulkMissedModal(null)}>
            <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: 320, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }} onClick={e => e.stopPropagation()}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Mark {selLessons.length} lessons missed</div>
              <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 16 }}>{selLessons.map(l => l.studentName || l.groupName).join(", ")}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Reason (applied to all)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {TALLY_REASONS.filter(r => !r.invisible).map(r => (
                  <button key={r.value} onClick={() => {
                    const now = new Date().toISOString();
                    const newEntries = selLessons.map(l => ({
                      id: uid(), lessonKey: l.isGroup ? `group|${l.groupId}` : `${l.studentId}|${l.instrument}`,
                      lessonId: l.id, isGroup: l.isGroup || false, groupName: l.groupName || "",
                      studentId: l.studentId || "", studentName: l.isGroup ? (l.groupName || "Group") : l.studentName,
                      studentNames: l.studentNames || [], instrument: l.instrument, schoolId: l.schoolId,
                      teacherId: l._swapTeacherId || l.teacherId, teacherName: l._swapTeacherName || l.teacherName,
                      weekKey, weekLabel, weekNum: 0, termKey: null, day: l.day,
                      status: "missed", reason: r.value, notes: "", makeupEligible: r.makeupEligible ?? true,
                      madeUp: false, recordedAt: now,
                    }));
                    setTallyEntries(prev => {
                      const existingKeys = new Set(newEntries.map(e => `${e.lessonKey}|${e.weekKey}`));
                      return [...prev.filter(e => !existingKeys.has(`${e.lessonKey}|${e.weekKey}`)), ...newEntries];
                    });
                    selLessons.forEach(l => handleMissedDrop(l.id));
                    setBulkMissedModal(null); setSelectedCards(new Set());
                    notify(`${selLessons.length} lessons marked missed`);
                  }}
                    style={{ padding: "8px 12px", borderRadius: 7, border: "1.5px solid #E5E7EB", background: "#fff", color: "#374151", fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                    onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
                    {r.label}
                    {r.makeupEligible === true && <span style={{ fontSize: 11, color: "#D97706", fontWeight: 600 }}>● makeup owed</span>}
                  </button>
                ))}
              </div>
              <button onClick={() => setBulkMissedModal(null)} style={{ marginTop: 12, width: "100%", padding: "8px 0", borderRadius: 8, background: "#F3F4F6", color: "#374151", fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
            </div>
          </div>
        );
      })()}

      {/* Right-click context menu */}
      {contextMenu && (
        <div ref={contextMenuRef} style={{ position: "fixed", ...((contextMenu.fromMissed || contextMenu.isCatchupStage || contextMenu.isMissedZone) ? { bottom: window.innerHeight - contextMenu.y + 4, top: "auto" } : (contextMenu.y + 160 > window.innerHeight ? { bottom: window.innerHeight - contextMenu.y + 4, top: "auto" } : { top: contextMenu.y })), left: clampMenuPos(contextMenu.x, contextMenu.y, 220, 0).left, zIndex: 9999, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 200 }}
          onClick={e => e.stopPropagation()}>
          {contextMenu.isDayHeader ? (() => {
            const day = contextMenu.day;
            // Aggregate across all selected days, or just the right-clicked day
            const activeDays = selectedDays.size > 0 ? [...selectedDays] : [day];
            const dayLessons = (weeklyData?.lessons || []).filter(l => activeDays.includes(l.day));
            // Collect all parent emails
            const parentEmailSet = new Set();
            const parentRows = []; // { name, email } for individual list
            dayLessons.forEach(l => {
              const studentIds = l.isGroup ? (l.studentIds || []) : l.studentId ? [l.studentId] : [];
              studentIds.forEach(sid => {
                const st = students.find(s => s.id === sid);
                if (!st) return;
                (st.parents || []).forEach(p => {
                  if (p.email && !parentEmailSet.has(p.email)) {
                    parentEmailSet.add(p.email);
                    parentRows.push({ name: p.name || p.email, email: p.email });
                  }
                });
              });
            });
            const allParentEmails = [...parentEmailSet];
            // Collect all class teacher emails
            const teacherEmailSet = new Set();
            const teacherRows = []; // { name, email }
            dayLessons.forEach(l => {
              const studentIds = l.isGroup ? (l.studentIds || []) : l.studentId ? [l.studentId] : [];
              studentIds.forEach(sid => {
                const st = students.find(s => s.id === sid);
                if (!st) return;
                const ct = getClassTeacher(st, contacts || []);
                if (ct && ct.email && !teacherEmailSet.has(ct.email)) {
                  teacherEmailSet.add(ct.email);
                  teacherRows.push({ name: ct.name || ct.email, email: ct.email });
                }
              });
            });
            const allTeacherEmails = [...teacherEmailSet];
            // Collect music staff emails
            const staffEmailSet = new Set();
            const staffRows = [];
            dayLessons.forEach(l => {
              const tid = l._swapTeacherId || l.teacherId;
              const t = teachers.find(x => x.id === tid);
              if (t?.email && !staffEmailSet.has(t.email)) {
                staffEmailSet.add(t.email);
                staffRows.push({ name: t.name || t.email, email: t.email, color: t.color || null });
              }
            });
            const allStaffEmails = [...staffEmailSet];

            const subMenuW = 210;
            const menuRect = contextMenuRef.current ? contextMenuRef.current.getBoundingClientRect() : null;
            const menuRight = menuRect ? menuRect.right : contextMenu.x + 220;
            const menuLeft = menuRect ? menuRect.left : contextMenu.x;
            const subX = menuRight + subMenuW > window.innerWidth ? menuLeft - subMenuW : menuRight;

            const keepDayHeaderOpen = () => { if (dayHeaderHideTimer.current) clearTimeout(dayHeaderHideTimer.current); };
            const scheduleDayHeaderClose = () => { dayHeaderHideTimer.current = setTimeout(() => setDayHeaderSubmenu(null), 200); };

            const DaySubPanel = ({ type, rows, allEmails, color, multi, schoolSender }) => {
              if (!dayHeaderSubmenu || dayHeaderSubmenu.type !== type || !rows.length) return null;
              const btn = (c) => ({ display: "flex", alignItems: "center", width: "100%", padding: "8px 14px", background: "none", border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: c, fontWeight: 400 });
              const hov = (e) => e.currentTarget.style.background = colors.bg;
              const unhov = (e) => e.currentTarget.style.background = "none";
              return (
                <div ref={dayHeaderSubRef}
                  onMouseEnter={keepDayHeaderOpen}
                  onMouseLeave={scheduleDayHeaderClose}
                  style={{ position: "fixed", top: dayHeaderSubmenu.y, left: subX, zIndex: 10002, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, maxHeight: 300, overflowY: "auto", padding: "4px 0" }}>
                  {multi && <button onClick={() => { openCompose(allEmails, { from: schoolSender, triggerId: "wtt_day_header" }); setContextMenu(null); setDayHeaderSubmenu(null); }} style={btn(color)} onMouseEnter={hov} onMouseLeave={unhov}>Group</button>}
                  {multi && <button onClick={() => { openGmailSequential(allEmails, { from: schoolSender }); setContextMenu(null); setDayHeaderSubmenu(null); }} style={btn(color)} onMouseEnter={hov} onMouseLeave={unhov}>Individually</button>}
                  {multi && rows.length > 0 && <div style={{ height: 1, background: colors.borderLight, margin: "3px 8px" }} />}
                  {rows.map((r, i) => (
                    <button key={i} onClick={() => { openCompose([r.email], { from: schoolSender, triggerId: "wtt_day_header" }); setContextMenu(null); setDayHeaderSubmenu(null); }}
                      style={r.color ? btn(colors.text) : btn(color || colors.accent)}
                      onMouseEnter={e => { e.currentTarget.style.background = r.color ? r.color + "33" : colors.bg; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                      {r.color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.color, flexShrink: 0, display: "inline-block", marginRight: 6 }} />}
                      {r.name ? r.name.split(" ")[0] : r.email}
                    </button>
                  ))}
                </div>
              );
            };

            const mkEmailRow = (label, allEmails, rows, type, color) => {
              if (!allEmails.length) return null;
              const schoolSender = schools.find(s => s.id === selectedSchool)?.senderEmail || "";
              const isOpen = dayHeaderSubmenu?.type === type;
              const multi = allEmails.length > 1;
              return (
                <div style={{ position: "relative" }}>
                  <DaySubPanel type={type} rows={rows} allEmails={allEmails} color={color} multi={multi} schoolSender={schoolSender} />
                  {multi ? (
                    <button
                      onClick={() => { openCompose(allEmails, { from: schoolSender, triggerId: "wtt_day_header" }); setContextMenu(null); setDayHeaderSubmenu(null); }}
                      onMouseEnter={e => {
                        keepDayHeaderOpen();
                        e.currentTarget.style.background = colors.bg;
                        if (!isOpen) setDayHeaderSubmenu({ type, y: e.currentTarget.getBoundingClientRect().top });
                      }}
                      onMouseLeave={e => { e.currentTarget.style.background = "none"; scheduleDayHeaderClose(); }}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color, fontFamily: "inherit", fontWeight: 600 }}>
                      <span>{label} ({allEmails.length})</span>
                      <span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => { openCompose(allEmails, { from: schoolSender, triggerId: "wtt_day_header" }); setContextMenu(null); setDayHeaderSubmenu(null); }}
                      onMouseEnter={e => { keepDayHeaderOpen(); e.currentTarget.style.background = colors.bg; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "none"; scheduleDayHeaderClose(); }}
                      style={{ display: "flex", alignItems: "center", width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color, fontFamily: "inherit", fontWeight: 600 }}>
                      {rows[0] ? (rows[0].name || rows[0].email).split(" ")[0] : label}
                    </button>
                  )}
                </div>
              );
            };

            return (
              <div style={{ padding: "4px 0" }}>
                <div style={{ padding: "6px 12px 6px", fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${colors.borderLight}` }}>
                  {activeDays.length > 1 ? `${activeDays.join(", ")} — Email` : `${day} — Email`}
                </div>
                {!allParentEmails.length && !allTeacherEmails.length && !allStaffEmails.length && (
                  <div style={{ padding: "10px 12px", fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>No email addresses found</div>
                )}
                {mkEmailRow("Parents", allParentEmails, parentRows, "parents", colors.accent)}
                {mkEmailRow("Class Teachers", allTeacherEmails, teacherRows, "teachers", colors.sidebarActive)}
                {mkEmailRow("Staff", allStaffEmails, staffRows, "staff", colors.textLight)}
              </div>
            );
          })() : contextMenu.isMissedZone ? (() => {
            const missed = weeklyData.missed || [];
            // Group by reason
            const byReason = {};
            for (const m of missed) {
              const key = m.reason || "other";
              if (!byReason[key]) byReason[key] = [];
              byReason[key].push(m);
            }
            const reasonGroups = Object.entries(byReason);
            const subMenuW = 230;
            const menuRect = contextMenuRef.current ? contextMenuRef.current.getBoundingClientRect() : null;
            const menuRight = menuRect ? menuRect.right : contextMenu.x + 220;
            const menuLeft = menuRect ? menuRect.left : contextMenu.x;
            const subX = menuRight + subMenuW > window.innerWidth ? menuLeft - subMenuW : menuRight;

            // Helper: collect parent emails for a list of missed entries
            const missedParentEmails = (entries) => {
              const emails = new Set();
              for (const m of entries) {
                const st = students.find(s => s.id === m.studentId);
                if (st) getParentEmails(st).forEach(e => emails.add(e));
              }
              return [...emails];
            };

            // All parents across all missed
            const allParentEmails = missedParentEmails(missed);

            return (
              <div style={{ padding: "6px 4px" }}>
                <div style={{ padding: "6px 10px", fontSize: 11, color: colors.danger, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${colors.borderLight}` }}>
                  Missed Lessons · {missed.length}
                </div>
                {/* All parents group action */}
                {allParentEmails.length > 0 && (
                  <div style={{ padding: "6px 10px 4px", borderBottom: `1px solid ${colors.borderLight}` }}>
                    <div style={{ fontSize: 11, color: colors.textMuted, fontWeight: 600, marginBottom: 4 }}>All parents ({allParentEmails.length})</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => { openCompose(allParentEmails, { from: schools.find(s => s.id === selectedSchool)?.senderEmail || "", triggerId: "wtt_missed_parent" }); setContextMenu(null); setMissedZoneSubmenu(null); }}
                        title="BCC all parents"
                        style={{ padding: "4px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.white, fontSize: 13, cursor: "pointer", color: colors.accent, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}
                        onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = colors.white}>
                        <span style={{fontSize:17, lineHeight:1}}>✉</span><span>Group</span>
                      </button>
                      <button onClick={() => {
                        openGmailSequential(allParentEmails, { from: schools.find(s => s.id === selectedSchool)?.senderEmail || "" });
                        setContextMenu(null); setMissedZoneSubmenu(null);
                      }}
                        title="Email each parent individually"
                        style={{ padding: "4px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.white, fontSize: 13, cursor: "pointer", color: colors.accent, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}
                        onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = colors.white}>
                        <span style={{fontSize:17, lineHeight:1}}>✉</span><span>Individual</span>
                      </button>
                    </div>
                  </div>
                )}
                {/* Per-reason groups */}
                {reasonGroups.map(([reasonVal, entries]) => {
                  const reasonLabel = TALLY_REASONS.find(r => r.value === reasonVal)?.label || reasonVal;
                  const groupEmails = missedParentEmails(entries);
                  const isOpen = missedZoneSubmenu && missedZoneSubmenu.reasonValue === reasonVal;
                  return (
                    <div key={reasonVal} style={{ position: "relative" }}>
                      {isOpen && groupEmails.length > 0 && (
                        <div ref={missedZoneSubRef} style={{ position: "fixed", bottom: window.innerHeight - (missedZoneSubmenu.y + 28), left: subX, zIndex: 10002, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, padding: "6px 4px" }}>
                          <div style={{ padding: "4px 10px 6px", fontSize: 11, color: colors.danger, fontWeight: 600, borderBottom: `1px solid ${colors.borderLight}`, marginBottom: 4 }}>
                            {reasonLabel} ({entries.length})
                          </div>
                          {/* Student list */}
                          {entries.map((m, mi) => {
                            const st = students.find(s => s.id === m.studentId);
                            const pEmails = st ? getParentEmails(st) : [];
                            return (
                              <div key={mi} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 10px", fontSize: 12 }}>
                                <span style={{ color: colors.text, fontWeight: 500 }}>{m.isGroup ? (m.groupName || "Group") : m.studentName}</span>
                                {pEmails.length > 0 && (
                                  <button onClick={() => { openCompose(pEmails); setContextMenu(null); setMissedZoneSubmenu(null); }}
                                    style={{ padding: "3px 8px", border: `1px solid ${colors.border}`, borderRadius: 5, background: "none", fontSize: 11, cursor: "pointer", color: colors.accent, fontFamily: "inherit", fontWeight: 600 }}
                                    onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      <span style={{fontSize:16}}>✉</span>
                                  </button>
                                )}
                              </div>
                            );
                          })}
                          {/* Group actions */}
                          {groupEmails.length > 1 && (
                            <div style={{ borderTop: `1px solid ${colors.borderLight}`, padding: "6px 10px 2px" }}>
                              <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>Group ({groupEmails.length} parents)</div>
                              <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => { openCompose(groupEmails, { from: schools.find(s => s.id === selectedSchool)?.senderEmail || "" }); setContextMenu(null); setMissedZoneSubmenu(null); }}
                        title="BCC this group"
                        style={{ padding: "4px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.white, fontSize: 13, cursor: "pointer", color: colors.accent, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}
                        onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = colors.white}>
                        <span style={{fontSize:17, lineHeight:1}}>✉</span><span>Group</span>
                      </button>
                      <button onClick={() => {
                        openGmailSequential(groupEmails, { from: schools.find(s => s.id === selectedSchool)?.senderEmail || "" });
                        setContextMenu(null); setMissedZoneSubmenu(null);
                      }}
                        title="Email each individually"
                        style={{ padding: "4px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.white, fontSize: 13, cursor: "pointer", color: colors.accent, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}
                        onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = colors.white}>
                        <span style={{fontSize:17, lineHeight:1}}>✉</span><span>Individual</span>
                      </button>
                            </div>
                            </div>
                          )}
                        </div>
                      )}
                      <button
                        onMouseEnter={e => { e.currentTarget.style.background = "#FEF2F2"; setMissedZoneSubmenu({ reasonValue: reasonVal, y: e.currentTarget.getBoundingClientRect().top }); }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; }}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", borderTop: `1px solid ${colors.borderLight}`, fontSize: 13, cursor: "pointer", color: colors.danger, fontFamily: "inherit" }}>
                        <span>{reasonLabel}</span>
                        <span style={{ fontSize: 11, color: colors.textMuted }}>{entries.length} {entries.length === 1 ? "student" : "students"} ▶</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })() : contextMenu.isCatchupStage ? (
            <div style={{ padding: "6px 4px" }}>
              <div style={{ padding: "6px 10px", fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Add catch-up to staging
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto", overflowX: "hidden" }}>
              {(() => {
                const sId = contextMenu.schoolId;
                const alreadyStagedIds = new Set((weeklyData?.catchupStaged || []).map(c => c.studentId));
                const schoolStudentsWithMakeup = students.filter(s => {
                  if (s.schoolId !== sId) return false;
                  return tallyEntries.some(e => e.studentId === s.id && e.status === "missed" && e.makeupEligible && !e.madeUp);
                });
                if (schoolStudentsWithMakeup.length === 0) {
                  return <div style={{ padding: "8px 12px", fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>No students with outstanding make-ups</div>;
                }
                const makeupCount = (s) => tallyEntries.filter(e => e.studentId === s.id && e.status === "missed" && e.makeupEligible && !e.madeUp).length;
                const sorted = [...schoolStudentsWithMakeup].sort((a, b) => makeupCount(b) - makeupCount(a));
                return sorted.map(s => {
                  const count = makeupCount(s);
                  const alreadyStaged = alreadyStagedIds.has(s.id);
                  return (
                    <button key={s.id} onClick={() => {
                      if (alreadyStaged) return;
                      const oldest = tallyEntries.filter(e => e.studentId === s.id && e.status === "missed" && e.makeupEligible && !e.madeUp).sort((a, b) => (a.weekKey || "").localeCompare(b.weekKey || ""))[0];
                      if (!oldest) return;
                      const stagedCard = {
                        id: uid(), studentId: s.id, studentName: s.name,
                        schoolId: sId, schoolName: schools.find(sc => sc.id === sId)?.name || "",
                        instrument: oldest.instrument, teacherId: oldest.teacherId || "", teacherName: oldest.teacherName || "",
                        isMakeup: true, makeupForTallyId: oldest.id,
                      };
                      setWeeklyTimetables(prev => {
                        const entry = prev[storageKey] || { lessons: [], missed: [] };
                        return { ...prev, [storageKey]: { ...entry, catchupStaged: [...(entry.catchupStaged || []), stagedCard] } };
                      });
                      setContextMenu(null); setCatchupSubmenu(null);
                    }}
                      disabled={alreadyStaged}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: alreadyStaged ? "default" : "pointer", color: alreadyStaged ? colors.textMuted : colors.text, fontFamily: "inherit", textAlign: "left", opacity: alreadyStaged ? 0.5 : 1 }}
                      onMouseEnter={e => { if (!alreadyStaged) e.currentTarget.style.background = colors.bg; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                      <span>{s.name}</span>
                      <span style={{ fontSize: 11, color: "#6B7280", whiteSpace: "nowrap" }}>
                        {alreadyStaged ? "already staged" : count + " owed"}
                      </span>
                    </button>
                  );
                });
              })()}
              {/* Band sessions for this school */}
              {(() => {
                const sId = contextMenu.schoolId;
                const schoolBands = (bands || []).filter(b => b.schoolId === sId);
                if (schoolBands.length === 0) return null;
                const alreadyStagedBandIds = new Set((weeklyData?.catchupStaged || []).filter(c => c.isBandSession).map(c => c.bandId));
                const alreadyPlacedBandIds = new Set((weeklyData?.lessons || []).filter(l => l.isBandSession).map(l => l.bandId));
                return (
                  <>
                    <div style={{ margin: "4px 12px", borderTop: `1px solid ${colors.border}` }} />
                    <div style={{ padding: "4px 10px", fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Band session</div>
                    {schoolBands.map(band => {
                      const alreadyStaged = alreadyStagedBandIds.has(band.id);
                      const alreadyPlaced = alreadyPlacedBandIds.has(band.id);
                      const disabled = alreadyStaged || alreadyPlaced;
                      return (
                        <button key={band.id} disabled={disabled} onClick={() => {
                          if (disabled) return;
                          const stagedBand = { id: uid(), isBandSession: true, bandId: band.id, bandName: band.name, schoolId: band.schoolId, teacherId: band.teacherId || "", members: band.members || [] };
                          setWeeklyTimetables(prev => {
                            const entry = prev[storageKey] || { lessons: [], missed: [] };
                            return { ...prev, [storageKey]: { ...entry, catchupStaged: [...(entry.catchupStaged || []), stagedBand] } };
                          });
                          setContextMenu(null);
                        }}
                          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: disabled ? "default" : "pointer", color: disabled ? colors.textMuted : colors.text, fontFamily: "inherit", textAlign: "left", opacity: disabled ? 0.5 : 1 }}
                          onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = BAND_COLOR + "15"; }}
                          onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                          <span style={{ color: disabled ? colors.textMuted : BAND_COLOR, fontWeight: 600 }}>{band.name}</span>
                          <span style={{ fontSize: 11, color: colors.textMuted, whiteSpace: "nowrap" }}>
                            {alreadyPlaced ? "placed" : alreadyStaged ? "staged" : `${(band.members || []).length} members`}
                          </span>
                        </button>
                      );
                    })}
                  </>
                );
              })()}
              </div>
            </div>
          ) : contextMenu.isEmpty ? (
            <div style={{ padding: "6px 4px" }}>
              <div style={{ padding: "6px 10px", fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {contextMenu.day} {to12h(contextMenu.time)}
              </div>
              {/* Break */}
              <button onClick={() => {
                const weeklyData2 = weeklyTimetables[contextMenu.weekKey];
                const curBreaks = weeklyData2?.breaks || (masterBreaks || []).filter(b => b.schoolId === contextMenu.schoolId);
                setWeeklyTimetables(prev => ({ ...prev, [contextMenu.weekKey]: { ...(prev[contextMenu.weekKey] || {}), breaks: [...curBreaks, { id: uid(), schoolId: contextMenu.schoolId, day: contextMenu.day, time: contextMenu.time }] } }));
                setContextMenu(null);
              }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: "#92400E", borderRadius: 6, fontFamily: "inherit" }}
                onMouseEnter={e => e.currentTarget.style.background = "#FFF7ED"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                ☕ Add break
              </button>
              {/* Add Lesson — cascading upward menu */}
              {(() => {
                const sId = contextMenu.schoolId;
                const schoolStudentsWithMakeup = students.filter(s => s.schoolId === sId && tallyEntries.some(e => e.studentId === s.id && e.status === "missed" && e.makeupEligible && !e.madeUp));
                // Exclude students already scheduled in any week
                const scheduledStudentIds = new Set(
                  Object.values(weeklyTimetables || {}).flatMap(data => (data.lessons || []).map(l => l.studentId))
                );
                const trialStu = students.filter(s => s.schoolId === sId && s.status === "trial" && !scheduledStudentIds.has(s.id));
                const hasCatchup = schoolStudentsWithMakeup.length > 0;
                const hasTrial = trialStu.length > 0;
            const wkDay = contextMenu.day;
            const wkTime = contextMenu.time;
            const wkDate = (weekDates || []).find(wd => wd.day === wkDay)?.date || "";
            const mttLessons = timetable ? timetable.lessons.filter(l => l.schoolId === sId && !l.isBandSession) : [];
            const wttLessons = (weeklyTimetables[contextMenu.weekKey] || {}).lessons || [];
            const missing = mttLessons.filter(ml =>
              ml.isGroup
                ? !wttLessons.some(wl => wl.groupId === ml.groupId)
                : !wttLessons.some(wl => wl.studentId === ml.studentId && wl.instrument === ml.instrument)
            );
            const hasPending = students.some(s => s.schoolId === sId && s.status === "pending");
                if (!hasCatchup && !hasTrial && missing.length === 0 && !hasPending) return null;
                const makeupCount = (s) => tallyEntries.filter(e => e.studentId === s.id && e.status === "missed" && e.makeupEligible && !e.madeUp).length;
                const scoreStudent = (s) => {
                  let score = 0;
                  const weekDayDate = (weekDates || []).find(wd => wd.day === contextMenu.day)?.date;
                  if (weekDayDate) {
                    const slotInterruptions = interruptions.filter(i => {
                      if (i.type === "term_break") return false;
                      if (i.schoolId !== sId && i.schoolId !== "all") return false;
                      const start = i.date, end = i.endDate || i.date;
                      if (weekDayDate < start || weekDayDate > end) return false;
                      if (i.affectsClasses !== "all" && !classMatchesInterruption(s.className || "", i.affectsClasses)) return false;
                      if (i.startTime) { const iS = timeToMin(i.startTime), iE = timeToMin(i.endTime || i.startTime), tS = timeToMin(contextMenu.time); if (tS < iS || tS >= iE) return false; }
                      return true;
                    });
                    score += slotInterruptions.length * 4;
                  }
                  if (s.outsideClassOnly || s.outsideClassPreferred) score += 2;
                  const specClash = specialists.some(sp => sp.schoolId === sId && sp.className === s.className && sp.day === contextMenu.day && timeToMin(contextMenu.time) >= timeToMin(sp.start) && timeToMin(contextMenu.time) < timeToMin(sp.end));
                  if (specClash) score += 1;
                  return score;
                };
                // Helper to place a lesson directly at the right-clicked slot
                const placeLesson = (s, opts) => {
                  const newLesson = {
                    id: uid(), studentId: s.id, studentName: s.name,
                    schoolId: sId, schoolName: schools.find(sc => sc.id === sId)?.name || "",
                    instrument: (s.instruments && s.instruments[0]?.name) || "",
                    teacherId: (s.instruments && s.instruments[0]?.teacherId) || "",
                    teacherName: (() => { const tid = s.instruments && s.instruments[0]?.teacherId; return tid ? (teachers.find(t => t.id === tid)?.name || "") : ""; })(),
                    day: contextMenu.day, start: contextMenu.time, end: contextMenu.time,
                    ...opts
                  };
                  const wkData = weeklyTimetables[contextMenu.weekKey] || { lessons: [], missed: [] };
                  setWeeklyTimetables(prev => ({ ...prev, [contextMenu.weekKey]: { ...wkData, lessons: [...(wkData.lessons || []), newLesson] } }));
                  const cuSlot = (currentSchool?.slots || []).find(sl => sl.start === contextMenu.time) || { start: contextMenu.time, end: contextMenu.time };
                  const cuWarnings = checkConstraints(newLesson, contextMenu.day, cuSlot);
                  if (cuWarnings.length > 0) { setConstraintWarnings(prev => ({ ...prev, [newLesson.id]: cuWarnings })); setExpandedWarnings(prev => { const next = new Set(prev); next.add(newLesson.id); return next; }); }
                  setContextMenu(null); setAddLessonSubmenu(null); addLessonSubmenuType.current = null;
                };
                // Cascading submenus — open to the right at same Y as hovered item
                const subMenuW = 216;
                const menuRect = contextMenuRef.current ? contextMenuRef.current.getBoundingClientRect() : null;
                const menuRight = menuRect ? menuRect.right : contextMenu.x + 180;
                const menuLeft = menuRect ? menuRect.left : contextMenu.x;
                // Open submenu to the right; if it overflows viewport flip to the left of the main menu
                const subX = menuRight + subMenuW > window.innerWidth ? menuLeft - subMenuW : menuRight;
                const mkItemStyle = (fg) => ({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", borderTop: `1px solid ${colors.borderLight}`, fontSize: 13, cursor: "pointer", color: fg, borderRadius: 6, fontFamily: "inherit" });
                // Missed this week at this school
                const thisWeekMissed = ((weeklyTimetables[contextMenu.weekKey] || {}).missed || []).filter(m => (m.schoolId || (students.find(s => s.id === m.studentId) || {}).schoolId) === sId);
                const missedByStudent = {};
                for (const m of thisWeekMissed) { missedByStudent[m.studentId] = (missedByStudent[m.studentId] || 0) + 1; }
                const missedStu = Object.keys(missedByStudent).map(sid => students.find(s => s.id === sid)).filter(Boolean).sort((a, b) => (missedByStudent[b.id] || 0) - (missedByStudent[a.id] || 0));
                const hasMissed = missedStu.length > 0;
                // Hoist data needed by submenu types
                const schoolBands = (bands || []).filter(b => b.schoolId === sId && (b.members || []).length > 0);
                const placeOne = (ml) => {
                  const newLesson = {
                    id: uid(), studentId: ml.studentId, studentName: ml.studentName,
                    isGroup: ml.isGroup || false, groupId: ml.groupId || undefined,
                    groupName: ml.groupName || undefined, studentIds: ml.studentIds || undefined,
                    studentNames: ml.studentNames || undefined, members: ml.members || undefined,
                    schoolId: ml.schoolId, schoolName: ml.schoolName || "",
                    instrument: ml.instrument, teacherId: ml.teacherId || "", teacherName: ml.teacherName || "",
                    day: wkDay, start: wkTime, end: wkTime, weekDate: wkDate, adjusted: false,
                  };
                  const wkData = weeklyTimetables[contextMenu.weekKey] || { lessons: [], missed: [] };
                  setWeeklyTimetables(prev => ({ ...prev, [contextMenu.weekKey]: { ...wkData, lessons: [...(wkData.lessons || []), newLesson] } }));
                  const cuSlot = (currentSchool?.slots || []).find(sl => sl.start === wkTime) || { start: wkTime, end: wkTime };
                  const cuWarnings = checkConstraints(newLesson, wkDay, cuSlot);
                  if (cuWarnings.length > 0) { setConstraintWarnings(prev => ({ ...prev, [newLesson.id]: cuWarnings })); setExpandedWarnings(prev => { const next = new Set(prev); next.add(newLesson.id); return next; }); }
                  setContextMenu(null); setAddLessonSubmenu(null); addLessonSubmenuType.current = null;
                };
                const subHdr = (color) => ({ padding: "6px 12px", fontSize: 11, color, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${colors.borderLight}` });
                const subBtnStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit", textAlign: "left" };
                return (
                  <div style={{ position: "relative" }}>
                    {/* Single stable submenu div — no component boundary so scroll never resets on re-render */}
                    {addLessonSubmenu && (
                      <div ref={subMenuRef}
                        style={{ position: "fixed", ...clampMenuPos(subX, addLessonSubmenu.y, subMenuW, 280), zIndex: 10001, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, maxHeight: 280, overflowY: "auto" }}
                        onScroll={e => { subPanelScrollRef.current[addLessonSubmenu.type] = e.currentTarget.scrollTop; }}>
                        {addLessonSubmenu.type === "catchup" && <>
                          <div style={subHdr(colors.accentDark)}>Add catch-up</div>
                          {[...schoolStudentsWithMakeup].sort((a, b) => { const cDiff = makeupCount(b) - makeupCount(a); return cDiff !== 0 ? cDiff : scoreStudent(a) - scoreStudent(b); }).map(s => {
                            const count = makeupCount(s);
                            const score = scoreStudent(s);
                            const scoreLabel = score >= 4 ? "⚠ interruption" : score >= 2 ? "constraint" : score >= 1 ? "specialist" : null;
                            return (
                              <button key={s.id} onClick={() => {
                                const oldest = tallyEntries.filter(e => e.studentId === s.id && e.status === "missed" && e.makeupEligible && !e.madeUp).sort((a, b) => (a.weekKey || "").localeCompare(b.weekKey || ""))[0];
                                if (!oldest) return;
                                placeLesson(s, { instrument: oldest.instrument, teacherId: oldest.teacherId || "", teacherName: oldest.teacherName || "", isMakeup: true, makeupForTallyId: oldest.id });
                              }} style={subBtnStyle}
                                onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                <span>{s.name}</span>
                                <span style={{ fontSize: 11, color: score > 0 ? "#D97706" : "#6B7280", whiteSpace: "nowrap" }}>{count}{scoreLabel ? " · " + scoreLabel : ""}</span>
                              </button>
                            );
                          })}
                        </>}
                        {addLessonSubmenu.type === "missed" && <>
                          <div style={subHdr("#DC2626")}>Add missed lesson</div>
                          {missedStu.map(s => {
                            const count = missedByStudent[s.id] || 0;
                            const missedLesson = thisWeekMissed.find(m => m.studentId === s.id);
                            return (
                              <button key={s.id} onClick={() => { if (!missedLesson) return; placeLesson(s, { instrument: missedLesson.instrument || "", teacherId: missedLesson.teacherId || "", teacherName: missedLesson.teacherName || "" }); }}
                                style={subBtnStyle}
                                onMouseEnter={e => e.currentTarget.style.background = "#FEF2F2"}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                <span>{s.name}</span>
                                <span style={{ fontSize: 11, color: "#6B7280", whiteSpace: "nowrap" }}>{count} missed</span>
                              </button>
                            );
                          })}
                        </>}
                        {addLessonSubmenu.type === "trial" && <>
                          <div style={subHdr(colors.sidebarActive)}>Add trial</div>
                          {[...trialStu].sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(s => (
                            <button key={s.id} onClick={() => placeLesson(s, { isTrial: true })} style={subBtnStyle}
                              onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                              onMouseLeave={e => e.currentTarget.style.background = "none"}>
                              <span>{s.name}</span>
                              <span style={{ fontSize: 11, color: "#6B7280" }}>{(s.instruments && s.instruments[0]?.name) || ""}</span>
                            </button>
                          ))}
                        </>}
                        {addLessonSubmenu.type === "band" && <>
                          <div style={subHdr(instruments_colors.Band)}>Add band session</div>
                          {schoolBands.map(band => (
                            <button key={band.id} onClick={() => handleAddBandSession(band)} style={subBtnStyle}
                              onMouseEnter={e => e.currentTarget.style.background = instruments_colors.Band + "18"}
                              onMouseLeave={e => e.currentTarget.style.background = "none"}>
                              <span style={{ fontWeight: 600 }}>{band.name || "TBC"}</span>
                              <span style={{ fontSize: 11, color: colors.textMuted }}>{(band.members || []).length} members</span>
                            </button>
                          ))}
                        </>}
                        {addLessonSubmenu.type === "unsched" && <>
                          <div style={subHdr(colors.sidebarActive)}>Add unscheduled</div>
                          {missing.map((ml, mi) => {
                            const label = ml.isGroup ? (ml.groupName || ml.studentNames?.map(n => n.split(" ")[0]).join(", ") || ml.studentName || "Group") : ml.studentName;
                            return (
                              <button key={mi} onClick={() => placeOne(ml)} style={subBtnStyle}
                                onMouseEnter={e => e.currentTarget.style.background = "#EFF6FF"}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                <span>{ml.isGroup ? "👥 " : ""}{label}</span>
                                <span style={{ fontSize: 11, color: colors.textMuted }}>{ml.isGroup ? "" : ml.instrument}</span>
                              </button>
                            );
                          })}
                        </>}
                        {addLessonSubmenu.type === "temp" && <>
                          <div style={subHdr(colors.danger)}>Temp slot (waiting list)</div>
                          {students.filter(s => s.schoolId === sId && s.status === "pending").sort((a, b) => a.name.localeCompare(b.name)).map(s => (
                            <button key={s.id} onClick={() => {
                              const inst = s.instruments?.[0] || {};
                              const teacherForTemp = inst.teacherId ? teachers.find(t => t.id === inst.teacherId) : null;
                              const newLesson = {
                                id: uid(), studentId: s.id, studentName: s.name,
                                schoolId: sId, schoolName: schools.find(sc => sc.id === sId)?.name || "",
                                instrument: inst.name || "", teacherId: inst.teacherId || "", teacherName: teacherForTemp?.name || "",
                                day: wkDay, start: wkTime, end: wkTime, weekDate: wkDate, adjusted: false, isTemp: true,
                              };
                              const wkData = weeklyTimetables[contextMenu.weekKey] || { lessons: [], missed: [] };
                              setWeeklyTimetables(prev => ({ ...prev, [contextMenu.weekKey]: { ...wkData, lessons: [...(wkData.lessons || []), newLesson] } }));
                              const cuSlot = (currentSchool?.slots || []).find(sl => sl.start === wkTime) || { start: wkTime, end: wkTime };
                              const cuWarnings = checkConstraints(newLesson, wkDay, cuSlot);
                              if (cuWarnings.length > 0) { setConstraintWarnings(prev => ({ ...prev, [newLesson.id]: cuWarnings })); setExpandedWarnings(prev => { const next = new Set(prev); next.add(newLesson.id); return next; }); }
                              setContextMenu(null); setAddLessonSubmenu(null); addLessonSubmenuType.current = null;
                            }} style={subBtnStyle}
                              onMouseEnter={e => e.currentTarget.style.background = "#FEF2F2"}
                              onMouseLeave={e => e.currentTarget.style.background = "none"}>
                              <span>{s.name}</span>
                              <span style={{ fontSize: 11, color: colors.textMuted }}>{s.instruments?.[0]?.name || ""}</span>
                            </button>
                          ))}
                        </>}
                      </div>
                    )}
                    {hasCatchup && (
                      <button style={mkItemStyle(colors.accentDark)}
                        onMouseEnter={e => { e.currentTarget.style.background = colors.accentLight; if (addLessonSubmenuType.current !== "catchup") { addLessonSubmenuType.current = "catchup"; setAddLessonSubmenu({ type: "catchup", y: e.currentTarget.getBoundingClientRect().top }); } }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                        <span>↺ Add catch-up</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                    )}
                    {hasMissed && (
                      <button style={mkItemStyle("#DC2626")}
                        onMouseEnter={e => { e.currentTarget.style.background = "#FEF2F2"; if (addLessonSubmenuType.current !== "missed") { addLessonSubmenuType.current = "missed"; setAddLessonSubmenu({ type: "missed", y: e.currentTarget.getBoundingClientRect().top }); } }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                        <span>✕ Add missed</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                    )}
                    {hasTrial && (
                      <button style={mkItemStyle(colors.sidebarActive)}
                        onMouseEnter={e => { e.currentTarget.style.background = colors.blueLight; if (addLessonSubmenuType.current !== "trial") { addLessonSubmenuType.current = "trial"; setAddLessonSubmenu({ type: "trial", y: e.currentTarget.getBoundingClientRect().top }); } }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                        <span>🎵 Add trial</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                    )}
                    {schoolBands.length > 0 && (
                      <button style={mkItemStyle(instruments_colors.Band)}
                        onMouseEnter={e => { e.currentTarget.style.background = instruments_colors.Band + "18"; if (addLessonSubmenuType.current !== "band") { addLessonSubmenuType.current = "band"; setAddLessonSubmenu({ type: "band", y: e.currentTarget.getBoundingClientRect().top }); } }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                        <span>🎸 Add band session</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                    )}
                    {missing.length > 0 && (
                      <button style={mkItemStyle(colors.sidebarActive)}
                        onMouseEnter={e => { e.currentTarget.style.background = "#EFF6FF"; if (addLessonSubmenuType.current !== "unsched") { addLessonSubmenuType.current = "unsched"; setAddLessonSubmenu({ type: "unsched", y: e.currentTarget.getBoundingClientRect().top }); } }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                        <span>＋ Add unscheduled</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                    )}
                    {(() => {
                      const pendingStu = students.filter(s => s.schoolId === sId && s.status === "pending");
                      if (pendingStu.length === 0) return null;
                      return (
                        <button style={mkItemStyle(colors.danger)}
                          onMouseEnter={e => { e.currentTarget.style.background = "#FEF2F2"; if (addLessonSubmenuType.current !== "temp") { addLessonSubmenuType.current = "temp"; setAddLessonSubmenu({ type: "temp", y: e.currentTarget.getBoundingClientRect().top }); } }}
                          onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                          <span>⏳ Add temp (waiting list)</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                        </button>
                      );
                    })()}
                  </div>
                );
              })()}
            </div>
          ) : contextMenu.isBandSession ? (
            <>
              <div style={{ padding: "8px 12px", fontSize: 12, color: instruments_colors.Band, borderBottom: `1px solid ${colors.borderLight}`, fontWeight: 700 }}>
                🎸 {contextMenu.bandName || "Band Session"}
              </div>
              <div style={{ padding: "6px 4px" }}>
                {(() => {
                  const bandLesson = (weeklyData.lessons || []).find(l => l.id === contextMenu.lessonId);
                  const band = (bands || []).find(b => b.id === (bandLesson?.bandId || contextMenu.bandId));
                  const memberIds = (band?.members || bandLesson?.members || []).map(m => m.studentId || m).filter(Boolean);
                  const emailSet = new Set();
                  memberIds.forEach(mid => {
                    const st = students.find(s => s.id === mid);
                    if (st) getParentEmails(st).forEach(e => emailSet.add(e));
                  });
                  const bandEmails = [...emailSet];
                  if (!bandEmails.length) return null;
                  return (
              <button onClick={() => { openCompose(bandEmails, { from: schools.find(s => s.id === selectedSchool)?.senderEmail || "", triggerId: "bands_parent" }); setContextMenu(null); }}
                title="BCC all band parents"
                style={{ padding: "4px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.white, fontSize: 13, cursor: "pointer", color: colors.accent, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}
                onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = colors.white}>
                <span style={{fontSize:17, lineHeight:1}}>✉</span><span>Email Parents</span>
              </button>
                  );
                })()}
                <button onClick={() => {
                  setWeeklyTimetables(prev => {
                    const d = prev[storageKey];
                    if (!d) return prev;
                    const bandLesson = (d.lessons || []).find(l => l.id === contextMenu.lessonId);
                    const removedLessons = bandLesson?.removedLessons || [];
                    let lessons = d.lessons.filter(l => l.id !== contextMenu.lessonId);
                    // Restore individual cards — skip any whose slot is now occupied
                    for (const rl of removedLessons) {
                      const slotOccupied = lessons.some(l => l.day === rl.day && l.start === rl.start);
                      if (!slotOccupied) lessons = [...lessons, rl];
                      // If occupied, student stays missing → unscheduled banner picks it up
                    }
                    return { ...prev, [storageKey]: { ...d, lessons } };
                  });
                  setContextMenu(null);
                  notify("Band session removed");
                }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, borderRadius: 6, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#FEF2F2"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  ✕ Remove band session
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ padding: "6px 4px" }}>
                {/* ── Email buttons (WTT card) — single card only ── */}
                {!contextMenu.isMulti && (() => {
                  let parentEmails = [];
                  let classTeacher = null;
                  if (contextMenu.isGroup) {
                    const lesson = (weeklyData.lessons || []).find(l => l.id === contextMenu.lessonId);
                    const memberIds = (lesson && lesson.studentIds) || [];
                    const emailSet = new Set();
                    memberIds.forEach(mid => {
                      const st = students.find(s => s.id === mid);
                      if (st) getParentEmails(st).forEach(e => emailSet.add(e));
                    });
                    parentEmails = [...emailSet];
                  } else {
                    const wttSt = students.find(s => s.id === contextMenu.studentId);
                    if (wttSt) {
                      parentEmails = getParentEmails(wttSt);
                      classTeacher = getClassTeacher(wttSt, contacts || []);
                    }
                  }
                  const _wttLesson = (weeklyData.lessons || []).find(l => l.id === contextMenu.lessonId);
                  const _wttSt = !contextMenu.isGroup && students.find(s => s.id === contextMenu.studentId);
                  const _wttSchoolSender = schools.find(s => s.id === (selectedSchool || _wttLesson?.schoolId || _wttSt?.schoolId))?.senderEmail || "";
                  const lessonTeacher = _wttLesson?.teacherId ? teachers.find(t => t.id === _wttLesson.teacherId) : null;
                  const lessonTeacherEmail = lessonTeacher?.email || null;
                  const lessonTeacherColor = lessonTeacher?.color || colors.sidebarActive;
                  const lessonTeacherFirst = lessonTeacher ? lessonTeacher.name.split(" ")[0] : null;
                  const specSubject = _wttLesson ? getLiveSpecialistTag(_wttLesson) : false;
                  const specSubjects = specSubject && typeof specSubject === "string" ? specSubject.split(", ") : [];
                  const specContact = specSubjects.length > 0 && _wttLesson ? (contacts || []).find(c =>
                    c.role === "Specialist Teacher" && c.schoolId === _wttLesson.schoolId && specSubjects.includes(c.className) && c.email
                  ) : null;
                  const _wttSchool = schools.find(s => s.id === (selectedSchool || _wttLesson?.schoolId || _wttSt?.schoolId));
                  const _wttMergeCtx = {
                    student_name: preferredFirstName(_wttSt?.name || _wttLesson?.studentName || ""),
                    parent_name: preferredFirstName(_wttSt?.parents?.[0]?.name) || "there",
                    instrument: _wttLesson?.instrument || "",
                    day: _wttLesson?.day || "",
                    lesson_time: _wttLesson?.start || "",
                    week_label: weekLabel || "",
                    teacher_name: preferredFirstName(lessonTeacher?.name) || "",
                    school_name: _wttSchool?.name || "",
                    class_name: _wttSt?.className || "",
                    specialist_subject: specSubjects[0] || "",
                  };
                  const parentObjs = !contextMenu.isGroup && _wttSt ? (_wttSt.parents || []).filter(p => p.email) : [];
                  const groupParents = contextMenu.isGroup && _wttLesson
                    ? (() => (_wttLesson.studentIds || []).map(mid => {
                        const ms = students.find(s => s.id === mid);
                        if (!ms) return null;
                        const ps = (ms.parents || []).filter(p => p.email);
                        if (!ps.length) return null;
                        return { studentName: ms.name, studentFirst: ms.name.split(' ')[0], parents: ps };
                      }).filter(Boolean))()
                    : [];
                  const allGroupParentEmails = [...new Set(groupParents.flatMap(g => g.parents.map(p => p.email)))];
                  const groupClassTeachers = contextMenu.isGroup && _wttLesson
                    ? (() => {
                        const seen = new Set(); const result = [];
                        for (const mid of (_wttLesson.studentIds || [])) {
                          const ms = students.find(s => s.id === mid);
                          const ct = ms ? getClassTeacher(ms, contacts || []) : null;
                          if (ct && ct.email && !seen.has(ct.email)) { seen.add(ct.email); result.push({ name: ct.name, email: ct.email, color: colors.sidebarActive }); }
                        }
                        return result;
                      })() : [];
                  const schoolTeacherList = [
                    ...(!contextMenu.isGroup && classTeacher && classTeacher.email ? [{ name: classTeacher.name, email: classTeacher.email, color: colors.sidebarActive }] : []),
                    ...groupClassTeachers,
                    ...(specContact ? [{ name: specContact.name, email: specContact.email, color: colors.specialistTag }] : []),
                  ];

                  const hasEmail = parentEmails.length || allGroupParentEmails.length || classTeacher || lessonTeacherEmail || specContact;
                  if (!hasEmail) return null;

                  const menuRect = contextMenuRef.current ? contextMenuRef.current.getBoundingClientRect() : null;
                  const emailSubW = 160;
                  const subX = menuRect ? (menuRect.right + emailSubW > window.innerWidth ? menuRect.left - emailSubW : menuRect.right) : contextMenu.x + 180;
                  const level2X = subX + emailSubW;
                  const btn = (color) => ({ display: "flex", alignItems: "center", justifyContent: "flex-start", width: "100%", padding: "8px 14px", background: "none", border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color, fontWeight: 400 });
                  const btnChev = (color) => ({ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "8px 14px", background: "none", border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color, fontWeight: 600 });
                  const hov = (e) => e.currentTarget.style.background = colors.bg;
                  const unhov = (e) => e.currentTarget.style.background = "none";
                  const subPanel = { position: "fixed", zIndex: 10002, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: emailSubW, padding: "4px 0" };

                  return (
                    <div style={{ position: "relative" }}>
                      <button
                        onMouseEnter={e => { e.currentTarget.style.background = colors.bg; setWttEmailSubmenu({ y: e.currentTarget.getBoundingClientRect().top }); setWttEmailLevel2(null); }}
                        onMouseLeave={e => e.currentTarget.style.background = "none"}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit", fontWeight: 600 }}>
                        Email
                        <span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                      {wttEmailSubmenu && (
                        <div ref={subMenuRef} style={{ position: "fixed", top: wttEmailSubmenu.y, left: subX, zIndex: 10001, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: emailSubW, padding: "4px 0" }}>

                          {/* Single parent */}
                          {parentObjs.length === 1 && (
                            <button onClick={() => { openCompose([parentObjs[0].email], { from: _wttSchoolSender, triggerId: "lesson_parent", mergeCtx: _wttMergeCtx }); setContextMenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); }}
                              style={btn(colors.accent)} onMouseEnter={hov} onMouseLeave={unhov}>
                              {parentObjs[0].name ? parentObjs[0].name.split(" ")[0] : "Parent"}
                            </button>
                          )}
                          {/* Multiple parents — top item sends to all, hover reveals individuals */}
                          {parentObjs.length > 1 && (
                            <div style={{ position: "relative" }}>
                              <button
                                onClick={() => { openCompose(parentObjs.map(p => p.email), { from: _wttSchoolSender, triggerId: "lesson_parent", mergeCtx: _wttMergeCtx }); setContextMenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); }}
                                onMouseEnter={e => { hov(e); setWttEmailLevel2({ type: "parents", y: e.currentTarget.getBoundingClientRect().top }); }}
                                onMouseLeave={unhov}
                                style={btnChev(colors.accent)}>
                                Parents
                                <span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                              </button>
                              {wttEmailLevel2?.type === "parents" && (
                                <div style={{ ...subPanel, top: wttEmailLevel2.y, left: level2X }}>
                                  {parentObjs.map(p => (
                                    <button key={p.email} onClick={() => { openCompose([p.email], { from: _wttSchoolSender, triggerId: "lesson_parent", mergeCtx: _wttMergeCtx }); setContextMenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); }}
                                      style={btn(colors.accent)} onMouseEnter={hov} onMouseLeave={unhov}>
                                      {p.name ? p.name.split(" ")[0] : p.email}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {/* Fallback parent email */}
                          {parentEmails.length > 0 && parentObjs.length === 0 && !contextMenu.isGroup && (
                            <button onClick={() => { openCompose(parentEmails, { from: _wttSchoolSender, triggerId: "lesson_parent", mergeCtx: _wttMergeCtx }); setContextMenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); }}
                              style={btn(colors.accent)} onMouseEnter={hov} onMouseLeave={unhov}>
                              Parent
                            </button>
                          )}
                          {/* Group parents — top sends to all, hover reveals per-student */}
                          {contextMenu.isGroup && groupParents.length > 0 && (
                            <div style={{ position: "relative" }}>
                              <button
                                onClick={() => { openCompose(allGroupParentEmails, { from: _wttSchoolSender, triggerId: "lesson_parent", mergeCtx: _wttMergeCtx }); setContextMenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); }}
                                onMouseEnter={e => { hov(e); setWttEmailLevel2({ type: "groupParents", y: e.currentTarget.getBoundingClientRect().top }); }}
                                onMouseLeave={unhov}
                                style={btnChev(colors.accent)}>
                                All Parents
                                <span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                              </button>
                              {wttEmailLevel2?.type === "groupParents" && (
                                <div style={{ ...subPanel, top: wttEmailLevel2.y, left: level2X, minWidth: emailSubW + 20 }}>
                                  {groupParents.map(g => (
                                    <button key={g.studentName}
                                      onClick={() => { openCompose(g.parents.map(p => p.email), { from: _wttSchoolSender, triggerId: "lesson_parent", mergeCtx: _wttMergeCtx }); setContextMenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); }}
                                      style={btn(colors.accent)} onMouseEnter={hov} onMouseLeave={unhov}>
                                      {g.studentFirst}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Class / specialist teachers */}
                          {schoolTeacherList.length === 1 && (
                            <button onClick={() => { openCompose([schoolTeacherList[0].email], { from: _wttSchoolSender, triggerId: "lesson_class_teacher", mergeCtx: _wttMergeCtx }); setContextMenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); }}
                              style={btn(schoolTeacherList[0].color)} onMouseEnter={hov} onMouseLeave={unhov}>
                              {schoolTeacherList[0].name.split(" ")[0]}
                            </button>
                          )}
                          {schoolTeacherList.length > 1 && (
                            <div style={{ position: "relative" }}>
                              <button
                                onClick={() => { openCompose(schoolTeacherList.map(t => t.email), { from: _wttSchoolSender, triggerId: "lesson_class_teacher", mergeCtx: _wttMergeCtx }); setContextMenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); }}
                                onMouseEnter={e => { hov(e); setWttEmailLevel2({ type: "teachers", y: e.currentTarget.getBoundingClientRect().top }); }}
                                onMouseLeave={unhov}
                                style={btnChev(colors.sidebarActive)}>
                                Teachers
                                <span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                              </button>
                              {wttEmailLevel2?.type === "teachers" && (
                                <div style={{ ...subPanel, top: wttEmailLevel2.y, left: level2X }}>
                                  {schoolTeacherList.map(t => (
                                    <button key={t.email} onClick={() => { openCompose([t.email], { from: _wttSchoolSender, triggerId: "lesson_class_teacher", mergeCtx: _wttMergeCtx }); setContextMenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); }}
                                      style={btn(t.color)} onMouseEnter={hov} onMouseLeave={unhov}>
                                      {t.name.split(" ")[0]}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Music teacher */}
                          {lessonTeacher && lessonTeacherEmail && (
                            <button onClick={() => { openCompose([lessonTeacherEmail], { from: "", triggerId: "lesson_music_teacher", mergeCtx: _wttMergeCtx }); setContextMenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); }}
                              style={btn(lessonTeacherColor)} onMouseEnter={hov} onMouseLeave={unhov}>
                              {lessonTeacherFirst}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {!contextMenu.isMulti && <button onClick={() => { handleMissedDrop(contextMenu.lessonId); setContextMenu(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, borderRadius: 6, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#FEF2F2"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  ✕ Missed
                </button>}
                {/* 2: Add / edit note */}
                {!contextMenu.isGroup && !contextMenu.isMulti && (() => {
                  const _cm_lesson = (weeklyData?.lessons || []).find(l => l.id === contextMenu.lessonId);
                  const hasNote = !!(_cm_lesson?.cardNote);
                  return (
                    <button onClick={() => {
                      const l = (weeklyData?.lessons || []).find(x => x.id === contextMenu.lessonId);
                      const st = students.find(s => s.id === contextMenu.studentId);
                      setNotePopup({ lessonId: contextMenu.lessonId, storageKey, x: contextMenu.x, y: contextMenu.y, note: l?.cardNote || "", studentNote: st?.notes || "" });
                      setNotePopupDraft(l?.cardNote || "");
                      setContextMenu(null);
                    }}
                      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.textLight, borderRadius: 6, fontFamily: "inherit" }}
                      onMouseEnter={e => e.currentTarget.style.background = colors.bg} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      📝 {hasNote ? "Edit note" : "Add note"}
                    </button>
                  );
                })()}
                {/* 5: Swap Teacher */}
                {!contextMenu.isMulti && (() => {
                  const _cm_lesson = (weeklyData?.lessons || []).find(l => l.id === contextMenu.lessonId);
                  const menuRect = contextMenuRef.current?.getBoundingClientRect();
                  const subX = menuRect ? (menuRect.right + 190 > window.innerWidth ? menuRect.left - 190 : menuRect.right) : contextMenu.x + 220;
                  const availTeachers = teachers.filter(t => t.availability.some(a => a.schoolId === selectedSchool));
                  return (
                    <div style={{ position: "relative" }}>
                      {swapTeacherSubmenu?.type === "single" && (
                        <div ref={swapTeacherSubRef} onMouseEnter={keepSwap} onMouseLeave={schedSwapClose}
                          style={{ position: "fixed", top: swapTeacherSubmenu.y, left: subX, zIndex: 10002, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 160, padding: "4px 0" }}>
                          {_cm_lesson?._swapTeacherId && (
                            <button onClick={() => {
                              setWeeklyTimetables(prev => { const d = prev[storageKey]; if (!d) return prev; return { ...prev, [storageKey]: { ...d, lessons: d.lessons.map(x => x.id === contextMenu.lessonId ? { ...x, _swapTeacherId: undefined, _swapTeacherName: undefined } : x) } }; });
                              setContextMenu(null); setSwapTeacherSubmenu(null);
                            }} style={{ display: "flex", width: "100%", padding: "7px 12px", background: "none", border: "none", fontSize: 12, cursor: "pointer", color: colors.danger, fontFamily: "inherit" }}
                              onMouseEnter={e => e.currentTarget.style.background = "#FEF2F2"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                              ✕ Restore original
                            </button>
                          )}
                          {availTeachers.map(t => (
                            <button key={t.id} onClick={() => {
                              setWeeklyTimetables(prev => { const d = prev[storageKey]; if (!d) return prev; return { ...prev, [storageKey]: { ...d, lessons: d.lessons.map(x => x.id === contextMenu.lessonId ? { ...x, _swapTeacherId: t.id, _swapTeacherName: t.name } : x) } }; });
                              setConstraintWarnings(prev => { const next = { ...prev }; delete next[contextMenu.lessonId]; return next; });
                              setContextMenu(null); setSwapTeacherSubmenu(null);
                            }} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "7px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit" }}
                              onMouseEnter={e => e.currentTarget.style.background = colors.bg} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                              {t.color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: t.color, flexShrink: 0, display: "inline-block" }} />}
                              {t.name.split(" ")[0]}
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        onMouseEnter={e => { e.currentTarget.style.background = colors.bg; setSwapTeacherSubmenu({ type: "single", y: e.currentTarget.getBoundingClientRect().top }); keepSwap(); }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; schedSwapClose(); }}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.textLight, borderRadius: 6, fontFamily: "inherit" }}>
                        <span>🔄 Swap Teacher</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                    </div>
                  );
                })()}
                {/* 6: Bulk actions when multiple selected */}
                {contextMenu.isMulti && (() => {
                  const selLessons = (weeklyData?.lessons || []).filter(l => contextMenu.selectedIds.includes(l.id));
                  const schoolSender = schools.find(s => s.id === selectedSchool)?.senderEmail || "";

                  // Aggregate parent emails
                  const parentMap = {};
                  selLessons.forEach(l => {
                    const st = students.find(s => s.id === l.studentId);
                    if (!st) return;
                    (st.parents || []).forEach(p => { if (p.email) parentMap[p.email] = p.name || p.email; });
                  });
                  const allParentEmails = Object.keys(parentMap);
                  const parentRows = Object.entries(parentMap).map(([email, name]) => ({ email, name }));

                  // Aggregate class teachers
                  const ctMap = {};
                  selLessons.forEach(l => {
                    const st = students.find(s => s.id === l.studentId);
                    if (!st) return;
                    const ct = getClassTeacher(st, contacts || []);
                    if (ct && ct.email) ctMap[ct.email] = ct.name || ct.email;
                  });
                  const allCtEmails = Object.keys(ctMap);
                  const ctRows = Object.entries(ctMap).map(([email, name]) => ({ email, name }));

                  // Aggregate music staff (teachers on selected lessons)
                  const staffMap = {}; // email -> { name, color }
                  selLessons.forEach(l => {
                    const tid = l._swapTeacherId || l.teacherId;
                    const tname = l._swapTeacherName || l.teacherName;
                    const t = teachers.find(x => x.id === tid);
                    const email = t?.email;
                    if (email && !staffMap[email]) staffMap[email] = { name: tname || t?.name || email, color: t?.color || null };
                  });
                  const allStaffEmails = Object.keys(staffMap);
                  const staffRows = Object.entries(staffMap).map(([email, { name, color }]) => ({ email, name, color }));

                  const hasAnyEmail = allParentEmails.length > 0 || allCtEmails.length > 0 || allStaffEmails.length > 0;

                  const menuRect = contextMenuRef.current?.getBoundingClientRect();
                  const subX = menuRect ? (menuRect.right + 200 > window.innerWidth ? menuRect.left - 200 : menuRect.right) : contextMenu.x + 220;
                  const sub2Rect = swapTeacherSubRef.current?.getBoundingClientRect();
                  const level3X = sub2Rect ? (sub2Rect.right + 190 > window.innerWidth ? sub2Rect.left - 190 : sub2Rect.right) : subX + 200;

                  const btn = (color) => ({ display: "flex", alignItems: "center", width: "100%", padding: "7px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color, gap: 6 });
                  const hov = (e) => e.currentTarget.style.background = colors.bg;
                  const unhov = (e) => e.currentTarget.style.background = "none";
                  const closeAll = () => { setContextMenu(null); setSwapTeacherSubmenu(null); setWttEmailLevel2(null); setSelectedCards(new Set()); };

                  // Level-3 panel: Group / Individually / individual names
                  // If only 1 unique email, skip the group/individually options — just list the contact
                  const GroupEmailPanel = ({ type, allEmails, rows, color }) => {
                    if (wttEmailLevel2?.type !== type || !allEmails.length) return null;
                    const multi = allEmails.length > 1;
                    return (
                      <div ref={level3MenuRef} onMouseEnter={keepSwap} onMouseLeave={schedSwapClose}
                        style={{ position: "fixed", top: wttEmailLevel2.y, left: level3X, zIndex: 10003, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 170, padding: "4px 0", maxHeight: 300, overflowY: "auto" }}>
                        {multi && <button onClick={() => { openCompose(allEmails, { from: schoolSender }); closeAll(); }} style={btn(color)} onMouseEnter={hov} onMouseLeave={unhov}>Group</button>}
                        {multi && <button onClick={() => { openGmailSequential(allEmails, { from: schoolSender }); closeAll(); }} style={btn(color)} onMouseEnter={hov} onMouseLeave={unhov}>Individually</button>}
                        {multi && rows.length > 0 && <div style={{ height: 1, background: colors.borderLight, margin: "3px 8px" }} />}
                        {rows.map(r => (
                          <button key={r.email} onClick={() => { openCompose([r.email], { from: schoolSender }); closeAll(); }}
                            style={r.color ? btn(colors.text) : btn(color)}
                            onMouseEnter={e => { e.currentTarget.style.background = r.color ? r.color + "33" : colors.bg; }}
                            onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                            {r.color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.color, flexShrink: 0, display: "inline-block" }} />}
                            {(r.name || r.email).split(" ")[0]}
                          </button>
                        ))}
                        {/* Fallback if rows is empty but we have emails (no names) */}
                        {rows.length === 0 && allEmails.map(e => (
                          <button key={e} onClick={() => { openCompose([e], { from: schoolSender }); closeAll(); }} style={btn(color)} onMouseEnter={hov} onMouseLeave={unhov}>{e}</button>
                        ))}
                      </div>
                    );
                  };

                  // Level-2 panel: Parents / Teachers / Staff
                  const EmailLevel2Panel = () => {
                    if (swapTeacherSubmenu?.type !== "multiEmail") return null;
                    return (
                      <div ref={swapTeacherSubRef} onMouseEnter={keepSwap} onMouseLeave={schedSwapClose}
                        style={{ position: "fixed", top: swapTeacherSubmenu.y, left: subX, zIndex: 10002, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 190, padding: "4px 0" }}>
                        <GroupEmailPanel type="multiEmail_parents" allEmails={allParentEmails} rows={parentRows} color={colors.accent} />
                        <GroupEmailPanel type="multiEmail_teachers" allEmails={allCtEmails} rows={ctRows} color={colors.sidebarActive} />
                        <GroupEmailPanel type="multiEmail_staff" allEmails={allStaffEmails} rows={staffRows} color={colors.textLight} />
                        {allParentEmails.length > 0 && (allParentEmails.length === 1 ? (
                          <button onClick={() => { openCompose(allParentEmails, { from: schoolSender }); closeAll(); }}
                            style={{ display: "flex", alignItems: "center", width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.accent, fontFamily: "inherit", fontWeight: 600 }}
                            onMouseEnter={hov} onMouseLeave={unhov}>
                            {parentRows[0] ? (parentRows[0].name || parentRows[0].email).split(" ")[0] : "Parent"}
                          </button>
                        ) : (
                          <button style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.accent, fontFamily: "inherit", fontWeight: 600 }}
                            onMouseEnter={e => { hov(e); setWttEmailLevel2({ type: "multiEmail_parents", y: e.currentTarget.getBoundingClientRect().top }); }}
                            onMouseLeave={unhov}>
                            <span>Parents ({allParentEmails.length})</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                          </button>
                        ))}
                        {allCtEmails.length > 0 && (allCtEmails.length === 1 ? (
                          <button onClick={() => { openCompose(allCtEmails, { from: schoolSender }); closeAll(); }}
                            style={{ display: "flex", alignItems: "center", width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.sidebarActive, fontFamily: "inherit", fontWeight: 600 }}
                            onMouseEnter={hov} onMouseLeave={unhov}>
                            {ctRows[0] ? (ctRows[0].name || ctRows[0].email).split(" ")[0] : "Teacher"}
                          </button>
                        ) : (
                          <button style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.sidebarActive, fontFamily: "inherit", fontWeight: 600 }}
                            onMouseEnter={e => { hov(e); setWttEmailLevel2({ type: "multiEmail_teachers", y: e.currentTarget.getBoundingClientRect().top }); }}
                            onMouseLeave={unhov}>
                            <span>Teachers ({allCtEmails.length})</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                          </button>
                        ))}
                        {allStaffEmails.length > 0 && (allStaffEmails.length === 1 ? (
                          <button onClick={() => { openCompose(allStaffEmails, { from: schoolSender }); closeAll(); }}
                            style={{ display: "flex", alignItems: "center", width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.textLight, fontFamily: "inherit", fontWeight: 600 }}
                            onMouseEnter={hov} onMouseLeave={unhov}>
                            {staffRows[0] ? (staffRows[0].name || staffRows[0].email).split(" ")[0] : "Staff"}
                          </button>
                        ) : (
                          <button style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.textLight, fontFamily: "inherit", fontWeight: 600 }}
                            onMouseEnter={e => { hov(e); setWttEmailLevel2({ type: "multiEmail_staff", y: e.currentTarget.getBoundingClientRect().top }); }}
                            onMouseLeave={unhov}>
                            <span>Staff ({allStaffEmails.length})</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                          </button>
                        ))}
                        {!hasAnyEmail && <div style={{ padding: "8px 12px", fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>No email addresses found</div>}
                      </div>
                    );
                  };

                  return (<>
                    {/* Heading — at top */}
                    <div style={{ padding: "6px 12px 7px", fontSize: 11, color: colors.textMuted, borderBottom: `1px solid ${colors.borderLight}`, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>
                      {contextMenu.selectedIds.length} lessons selected
                    </div>

                    {/* Email ▶ */}
                    <div style={{ position: "relative" }}>
                      <EmailLevel2Panel />
                      <button
                        onMouseEnter={e => { hov(e); setSwapTeacherSubmenu({ type: "multiEmail", y: e.currentTarget.getBoundingClientRect().top }); setWttEmailLevel2(null); keepSwap(); }}
                        onMouseLeave={e => { unhov(e); schedSwapClose(); }}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: hasAnyEmail ? colors.accent : colors.textMuted, fontFamily: "inherit", fontWeight: 600 }}>
                        <span>✉ Email</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                    </div>

                    {/* Swap Teacher (all) ▶ */}
                    <div style={{ position: "relative" }}>
                      {swapTeacherSubmenu?.type === "swap" && (
                        <div ref={swapTeacherSubRef} onMouseEnter={keepSwap} onMouseLeave={schedSwapClose}
                          style={{ position: "fixed", top: swapTeacherSubmenu.y, left: subX, zIndex: 10002, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 160, padding: "4px 0" }}>
                          {teachers.map(t => (
                            <button key={t.id} onClick={() => {
                              setWeeklyTimetables(prev => { const d = prev[storageKey]; if (!d) return prev; return { ...prev, [storageKey]: { ...d, lessons: d.lessons.map(x => contextMenu.selectedIds.includes(x.id) ? { ...x, _swapTeacherId: t.id, _swapTeacherName: t.name } : x) } }; });
                              setContextMenu(null); setSwapTeacherSubmenu(null); setSelectedCards(new Set());
                            }} style={btn(colors.text)} onMouseEnter={hov} onMouseLeave={unhov}>
                              {t.color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: t.color, flexShrink: 0, display: "inline-block" }} />}
                              {t.name.split(" ")[0]}
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        onMouseEnter={e => { hov(e); setSwapTeacherSubmenu({ type: "swap", y: e.currentTarget.getBoundingClientRect().top }); setWttEmailLevel2(null); keepSwap(); }}
                        onMouseLeave={e => { unhov(e); schedSwapClose(); }}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.textLight, fontFamily: "inherit" }}>
                        <span>🔄 Swap Teacher (all)</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                    </div>

                    {/* Mark all missed */}
                    <button onClick={() => { setBulkMissedModal({ lessonIds: contextMenu.selectedIds }); setContextMenu(null); }}
                      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, fontFamily: "inherit" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "#FEF2F2"; setSwapTeacherSubmenu(null); setWttEmailLevel2(null); }} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      ✕ Mark all missed…
                    </button>

                    {/* Delete all selected */}
                    <button onClick={() => {
                      const idsToDelete = contextMenu.selectedIds;
                      setWeeklyTimetables(prev => {
                        const entry = prev[storageKey];
                        if (!entry) return prev;
                        return { ...prev, [storageKey]: { ...entry, lessons: entry.lessons.filter(l => !idsToDelete.includes(l.id)) } };
                      });
                      notify(`${idsToDelete.length} lessons deleted`);
                      setContextMenu(null); setSelectedCards(new Set());
                    }}
                      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, fontFamily: "inherit" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "#FEF2F2"; setSwapTeacherSubmenu(null); setWttEmailLevel2(null); }} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      🗑 Delete lessons
                    </button>
                  </>);
                })()}
                {!contextMenu.isMulti && <button onClick={() => { handleDeleteWeeklyLesson(contextMenu.lessonId); setContextMenu(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.textMuted, borderRadius: 6, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#FEF2F2"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  🗑 Delete lesson
                </button>}
              </div>
            </>
          )}
        </div>
      )}
      <PageTitle pageColor={PAGE_COLORS.weekly}
          navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          action={<>
            <Btn onClick={() => {
                const allWeekLessons = [];
                const allWeekMissed = [];
                for (const s of schools) {
                  const sk = `${weekKey}|${s.id}`;
                  const wd = weeklyTimetables[sk];
                  if (wd) { allWeekLessons.push(...wd.lessons); allWeekMissed.push(...(wd.missed || [])); }
                }
                onExport({ lessons: allWeekLessons, missed: allWeekMissed }, weekLabel);
              }} title="Export">{ExportIcon}</Btn>
            <Btn variant="secondary" onClick={() => printWeeklyTimetable(weeklyTimetables, schools, students, weekDates, weekLabel)} title="Print week">🖨</Btn>
            {confirmClearAllWeeks ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#FEF2F2", borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap", marginTop: -1 }}>
                <span style={{ fontSize: 12, color: colors.danger, fontWeight: 500 }}>Clear all?</span>
                <Btn variant="danger" onClick={() => { setWeeklyTimetables({}); setConfirmClearAllWeeks(false); }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmClearAllWeeks(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
              </div>
            ) : (
              <Btn variant="danger" disabled={isLocked} style={{ opacity: isLocked ? 0.35 : 1, border: "none" }} onClick={() => setConfirmClearAllWeeks(true)} title="Clear all weeks">🗑</Btn>
            )}
            {confirmRegenerateWeek ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#E9E4F0", borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap", marginTop: -1 }}>
                <span style={{ fontSize: 12, color: "#5B3F7A", fontWeight: 500 }}>Reschedule all schools?</span>
                <Btn variant="primary" onClick={() => { handleGenerateAllSchools(); setConfirmRegenerateWeek(false); }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, background: "#5B3F7A", color: "#fff", border: "none" }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmRegenerateWeek(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
              </div>
            ) : (
              <Btn variant="secondary" onClick={() => setConfirmRegenerateWeek(true)} disabled={generating || isLocked} style={{ opacity: (generating || isLocked) ? 0.35 : 1, color: "#5B3F7A", border: "none" }} title="Reschedule all schools">🔄</Btn>
            )}
            {confirmImportAllWeeks ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#EFF6FF", borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap", marginTop: -1 }}>
                <span style={{ fontSize: 12, color: colors.sidebarActive, fontWeight: 500 }}>Import all schools?</span>
                <Btn variant="primary" onClick={importAllSchoolsFromMTT} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, background: colors.sidebarActive, color: "#fff", border: "none" }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmImportAllWeeks(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
              </div>
            ) : (
              <Btn variant="secondary" onClick={() => setConfirmImportAllWeeks(true)} disabled={generating || isLocked} style={{ opacity: (generating || isLocked) ? 0.35 : 1, color: colors.sidebarActive, border: "none" }} title="Import MTT for all schools">📥</Btn>
            )}
            {onUndo && <Btn variant="secondary" onClick={onUndo} disabled={!undoCount} style={{ opacity: undoCount ? 1 : 0.4 }} title="Undo (Cmd+Z)">↩</Btn>}
            {onRedo && <Btn variant="secondary" onClick={onRedo} disabled={!redoCount} style={{ opacity: redoCount ? 1 : 0.4 }} title="Redo (Cmd+Shift+Z)">↪</Btn>}
          </>}>
          Weekly Adjustments
        </PageTitle>

      {!timetable ? (
        <EmptyState icon="📋" title="No master timetable" subtitle="Generate a Master Timetable first, then come here to make weekly adjustments." />
      ) : (
        <div>
          {/* School + Week Nav unified */}
          {expandedBtn && (
            <div
              style={{ position: "fixed", inset: 0, zIndex: 39 }}
              onMouseDown={() => { setExpandedBtn(null); setConfirmImportExpanded(false); }}
            />
          )}
          <FrozenCard style={{ border: `2px solid ${colors.sidebarActive}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "space-between" }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {schools.map(s => {
                  const sKey = weekKey + "|" + s.id; const wttCount = (weeklyTimetables[sKey]?.lessons || []).length;
                  const isActive = selectedSchool === s.id;
                  return (
                    <button key={s.id} onClick={() => setSelectedSchool(s.id)}
                      style={{
                        height: 34, padding: "0 14px", borderRadius: 8, fontSize: 13, fontFamily: "inherit", cursor: "pointer", boxSizing: "border-box",
                        border: `2px solid ${isActive ? colors.sidebarActive : colors.border}`,
                        background: isActive ? colors.sidebarActive : colors.white,
                        color: isActive ? colors.white : colors.text, fontWeight: 600,
                        transition: "all 0.15s", display: "flex", alignItems: "center", gap: 8
                      }}>
                      <span>🏫 {s.name.replace(/Primary School/gi, "PS")}</span>
                      <span style={{
                        fontSize: 11, padding: "2px 0", borderRadius: 10, fontWeight: 600,
                        background: isActive ? "rgba(255,255,255,0.2)" : colors.borderLight,
                        color: isActive ? colors.white : colors.textMuted,
                        minWidth: 28, textAlign: "center", display: "inline-block"
                      }}>{wttCount}</span>
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", alignItems: "center", background: colors.sidebarActive, borderRadius: 8, overflow: "hidden", height: 34, boxSizing: "border-box", flexShrink: 0 }}>
                <button onClick={() => setWeekOffset(o => o - 1)} disabled={weekOffset <= minWeekOffset}
                  style={{ background: "none", border: "none", color: colors.white, fontSize: 18, padding: "0 12px", height: "100%", cursor: weekOffset <= minWeekOffset ? "default" : "pointer", opacity: weekOffset <= minWeekOffset ? 0.3 : 1, fontFamily: "inherit", lineHeight: 1, display: "flex", alignItems: "center" }}>‹</button>
                <div style={{ fontWeight: 700, fontSize: 13, padding: "0 8px", color: colors.white, letterSpacing: 0.5, textTransform: "uppercase", whiteSpace: "nowrap" }}>{weekLabel}</div>
                <button onClick={() => setWeekOffset(o => o + 1)}
                  style={{ background: "none", border: "none", color: colors.white, fontSize: 18, padding: "0 12px", height: "100%", cursor: "pointer", fontFamily: "inherit", lineHeight: 1, display: "flex", alignItems: "center" }}>›</button>
              </div>
            </div>
          </FrozenCard>

          {weeklyData && !isLocked && (
            <ConflictBanner
              constraintWarnings={constraintWarnings}
              ackedConstraints={ackedConstraints}
              lessons={weeklyData.lessons || []}
              students={students}
              onAckAll={() => setAckedConstraints(prev => {
                const next = new Set(prev);
                Object.keys(constraintWarnings).forEach(id => next.add(id));
                return next;
              })}
            />
          )}

          {timetable && selectedSchool && (() => {
            const mttLessons = timetable.lessons.filter(l => l.schoolId === selectedSchool && !l.isBandSession);
            const wttLessons = (weeklyData?.lessons) || [];
            const seen = new Set();
            const missing = [];
            for (const ml of mttLessons) {
              const key = ml.isGroup ? `group|${ml.groupId}` : `${ml.studentId}|${ml.instrument}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const found = wttLessons.some(wl =>
                ml.isGroup ? wl.groupId === ml.groupId : (wl.studentId === ml.studentId && wl.instrument === ml.instrument)
              );
              if (!found) {
                const label = ml.isGroup
                  ? (ml.groupName || ml.studentNames?.map(n => n.split(" ")[0]).join(", ") || ml.studentName || "Group")
                  : ml.studentName;
                if (label) missing.push({ key, label, instrument: ml.instrument, isGroup: ml.isGroup });
              }
            }
            // Also include instruments flagged Unassigned in the MTT unscheduled list
            for (const u of (timetable.unscheduled || [])) {
              if (!u.student || u.student.schoolId !== selectedSchool) continue;
              if (u.reason !== "Unassigned") continue;
              const key = `${u.student.id}|${u.instrument}`;
              if (seen.has(key)) continue;
              seen.add(key);
              missing.push({ key, label: `${u.student.name} (${u.instrument} — Unassigned)`, instrument: u.instrument, isGroup: false, isUnassigned: true });
            }
            if (missing.length === 0) return null;
            return (
              <div style={{ marginBottom: 12, background: "#FFF7ED", border: "1px solid #F59E0B40", borderRadius: 10, padding: "10px 16px", display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ fontSize: 16, lineHeight: 1, marginTop: 1 }}>⚠️</span>
                <div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#92400E" }}>
                    {missing.length} {missing.length === 1 ? "student" : "students"} from the master timetable not scheduled this week:
                  </span>
                  <span style={{ fontSize: 12, color: "#92400E", marginLeft: 6 }}>
                    {missing.map(m => `${m.label}${m.isGroup ? "" : ` (${m.instrument})`}`).join(", ")}
                  </span>
                </div>
              </div>
            );
          })()}

          {isPastWeek && (
            <div style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ background: colors.sidebarActive, color: "#fff", borderRadius: 8, padding: "6px 18px", fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", border: `2px solid ${colors.sidebarActive}`, boxShadow: "0 2px 8px rgba(52,69,101,0.18)" }}>
                {weekLabel} RECORD
              </span>
              <button onClick={() => setEditUnlocked(v => !v)}
                style={{ padding: "5px 16px", background: "none", border: `1px solid ${colors.border}`, borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", color: colors.textMuted }}>
                {editUnlocked ? "Lock" : "Edit"}
              </button>
            </div>
          )}
          {isLocked ? null : (
          <>
          {/* Week Interruptions */}
          {weekInterruptions.length > 0 && (
            <Card style={{ marginBottom: 8, padding: 0, background: "#FEF3C7", border: "1px solid #F59E0B40", overflow: "hidden" }}>
              <div onClick={() => setShowInterruptions(v => !v)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", cursor: "pointer", fontWeight: 600, fontSize: 13, color: "#92400E" }}>
                <span>⚠ Interruptions this week ({weekInterruptions.length})</span>
                <span style={{ fontSize: 11, color: "#B45309" }}>{showInterruptions ? "▲" : "▼"}</span>
              </div>
              {showInterruptions && (
                <div style={{ padding: "0 14px 12px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {weekInterruptions.map((intr, i) => (
                    <Tag key={i} color="#D97706">
                      {intr.title} — {intr.date}{intr.date !== (intr.endDate || intr.date) ? ` to ${intr.endDate}` : ""}
                      {intr.startTime ? ` (${intr.startTime}–${intr.endTime})` : " (all day)"}
                      {intr.affectsClasses !== "all" ? ` [${intr.affectsClasses}]` : ""}
                    </Tag>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* AI Adjustments — current week only */}
          {!isPastWeek && <Card style={{ marginBottom: 16, padding: 0, overflow: "hidden" }}>
            <div style={{ background: colors.sidebarActive, padding: "10px 16px", borderRadius: "12px 12px 0 0", marginBottom: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: colors.white }}>Claude</div>
            </div>
            <div style={{ padding: "14px 18px" }}>
            {!_anthropicApiKey && !(typeof localStorage !== "undefined" && localStorage.getItem("mt-api-key")) && (
              <div style={{ marginBottom: 10, padding: "8px 12px", background: "#FFFBEB", border: "1px solid #FCD34D", borderRadius: 8, fontSize: 12, color: "#92400E", display: "flex", alignItems: "center", gap: 8 }}>
                <span>🔑</span>
                <span>Add your <strong>API key</strong> (via the key icon in the sidebar) to enable AI-powered adjustment parsing.</span>
              </div>
            )}
            <div style={{ position: "relative" }}>
              <textarea
                value={adjustmentNotes} onChange={e => { setAdjustmentNotes(e.target.value); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                onFocus={e => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                placeholder=""
                rows={1}
                style={{
                  width: "100%", padding: 12, border: `1px solid ${colors.inputBorder}`,
                  borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "none",
                  boxSizing: "border-box", overflow: "hidden", lineHeight: 1.5
                }}
              />
              {!adjustmentNotes && (
                <div style={{
                  position: "absolute", top: 0, left: 0, right: 0,
                  padding: 12, fontSize: 13, fontFamily: "inherit",
                  color: colors.textMuted, pointerEvents: "none", lineHeight: 1.5,
                  opacity: wttHintVisible ? 1 : 0, transition: "opacity 0.7s ease",
                  whiteSpace: "nowrap", overflow: "hidden",
                }}>
                  {"\u201C"}{WTT_HINTS[wttHintIdx]}{"\u201D"}
                </div>
              )}
            </div>
            {pendingRecurringNotes.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {pendingRecurringNotes.map((item, idx) => (
                  <div key={idx} style={{ padding: "8px 12px", background: "rgba(52,69,101,0.07)", border: "1px solid rgba(52,69,101,0.25)", borderRadius: 8, fontSize: 12, color: colors.sidebarActive, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span>💾</span>
                    <span style={{ flex: 1 }}>Save as recurring note for <strong>{item.studentName}</strong>: <em>"{item.noteText}"</em></span>
                    <button onClick={() => {
                      setStudents(prev => {
                        const updated = prev.map(s => s.id !== item.studentId ? s : {
                          ...s,
                          notes: s.notes ? `${s.notes.trimEnd()}; ${item.noteText}` : item.noteText
                        });
                        saveStudents(updated);
                        return updated;
                      });
                      setPendingRecurringNotes(prev => prev.filter((_, i) => i !== idx));
                      notify(`Recurring note saved for ${item.studentName}`);
                    }} style={{ padding: "3px 10px", background: colors.sidebarActive, color: "#fff", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Save</button>
                    <button onClick={() => setPendingRecurringNotes(prev => prev.filter((_, i) => i !== idx))}
                      style={{ padding: "3px 8px", background: "none", color: "#6B7280", border: "1px solid #D1D5DB", borderRadius: 6, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>Dismiss</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, whiteSpace: "nowrap", flexShrink: 0 }}>Reschedule:</span>
              {/* Week button — expands to Reschedule / Import */}
              <div key={expandedBtn === "week" ? "week-exp" : "week-col"} style={{ display: "flex", alignItems: "center", gap: 0, borderRadius: 8, overflow: "hidden", outline: `2px solid ${expandedBtn === "week" ? colors.sidebarActive : "transparent"}`, transition: "outline-color 0.15s", position: "relative", zIndex: expandedBtn === "week" ? 40 : "auto" }}>
                {expandedBtn === "week" ? (
                  <>
                    {confirmImportExpanded === "week" ? (
                      <>
                        <span style={{ padding: "6px 10px", fontSize: 12, fontWeight: 500, color: colors.sidebarActive, background: "#EFF6FF", whiteSpace: "nowrap" }}>Replace week?</span>
                        <button onClick={() => { importFromMTT(null); }} disabled={generating}
                          style={{ padding: "6px 10px", background: colors.sidebarActive, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)" }}>Yes</button>
                        <button onClick={() => setConfirmImportExpanded(false)}
                          style={{ padding: "6px 10px", background: colors.sidebarActive, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", opacity: 0.7 }}>No</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => setExpandedBtn(null)}
                          style={{ padding: "6px 12px", background: colors.accent, color: colors.white, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none" }}>Week</button>
                        <button onClick={() => { handleGenerate(); setExpandedBtn(null); }} disabled={generating}
                          style={{ padding: "6px 12px", background: colors.accent, color: colors.white, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: generating ? "not-allowed" : "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", opacity: generating ? 0.5 : 1, transition: "background 0.1s" }}
                          onMouseEnter={e => { if (!generating) e.currentTarget.style.background = colors.sidebarActive; }}
                          onMouseLeave={e => e.currentTarget.style.background = colors.accent}>
                          {generating ? "…" : "Reschedule"}
                        </button>
                        <button onClick={() => {
                          const hasLessons = (weeklyData?.lessons || []).filter(l => !l.isBandSession).length > 0;
                          if (hasLessons) { setConfirmImportExpanded("week"); } else { importFromMTT(null); }
                        }}
                          style={{ padding: "6px 12px", background: colors.accent, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", transition: "background 0.1s" }}
                          onMouseEnter={e => e.currentTarget.style.background = colors.sidebarActive}
                          onMouseLeave={e => e.currentTarget.style.background = colors.accent}>
                          Import
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <button onClick={() => setExpandedBtn("week")} disabled={generating}
                    style={{ padding: "6px 14px", background: colors.accent, color: colors.white, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: generating ? "not-allowed" : "pointer", border: "none", opacity: generating ? 0.5 : 1, transition: "background 0.1s" }}
                    onMouseEnter={e => { if (!generating) e.currentTarget.style.background = colors.sidebarActive; }}
                    onMouseLeave={e => e.currentTarget.style.background = colors.accent}>
                    {generating ? "Parsing adjustments…" : "Week"}
                  </button>
                )}
              </div>
              {timetable && currentSchool && (currentSchool.days || DAYS).slice().sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)).map(d => {
                const dayDate = weekDates.find(wd => wd.day === d);
                const dateLabel = dayDate ? new Date(dayDate.date + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
                const isExpanded = expandedBtn === d;
                return (
                  <React.Fragment key={d}>
                  <div key={isExpanded ? `${d}-exp` : `${d}-col`} style={{ display: "flex", alignItems: "center", gap: 0, borderRadius: 8, overflow: "hidden", outline: `2px solid ${isExpanded ? colors.sidebarActive : "transparent"}`, transition: "outline-color 0.15s", position: "relative", zIndex: isExpanded ? 40 : "auto" }}>
                    {isExpanded ? (
                      confirmImportExpanded === d ? (
                        <>
                          <span style={{ padding: "6px 10px", fontSize: 12, fontWeight: 500, color: colors.sidebarActive, background: "#EFF6FF", whiteSpace: "nowrap" }}>Replace {d.slice(0,3)}?</span>
                          <button onClick={() => { importFromMTT(d); }}
                            style={{ padding: "6px 10px", background: colors.sidebarActive, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)" }}>Yes</button>
                          <button onClick={() => setConfirmImportExpanded(false)}
                            style={{ padding: "6px 10px", background: colors.sidebarActive, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", opacity: 0.7 }}>No</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => setExpandedBtn(null)}
                            style={{ padding: "6px 12px", background: colors.accent, color: colors.white, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", minWidth: 52, textAlign: "center" }}
                            title={dateLabel}>{d.slice(0,3)}</button>
                          <button onClick={() => { handleGenerateDay(d); setExpandedBtn(null); }}
                            style={{ padding: "6px 12px", background: colors.accent, color: colors.white, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", transition: "background 0.1s" }}
                            onMouseEnter={e => e.currentTarget.style.background = colors.sidebarActive}
                            onMouseLeave={e => e.currentTarget.style.background = colors.accent}>Reschedule</button>
                          <button onClick={() => {
                            const hasLessons = (weeklyData?.lessons || []).filter(l => l.day === d && !l.isBandSession).length > 0;
                            if (hasLessons) { setConfirmImportExpanded(d); } else { importFromMTT(d); }
                          }}
                            style={{ padding: "6px 12px", background: colors.accent, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", transition: "background 0.1s" }}
                            onMouseEnter={e => e.currentTarget.style.background = colors.sidebarActive}
                            onMouseLeave={e => e.currentTarget.style.background = colors.accent}>Import</button>
                        </>
                      )
                    ) : (
                      <button onClick={() => { setExpandedBtn(d); setConfirmImportExpanded(false); }}
                        style={{ padding: "6px 12px", background: colors.accent, color: colors.white, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", minWidth: 52, textAlign: "center", transition: "background 0.1s" }}
                        onMouseEnter={e => e.currentTarget.style.background = colors.sidebarActive}
                        onMouseLeave={e => e.currentTarget.style.background = colors.accent}
                        title={`Options for ${d}${dateLabel ? " (" + dateLabel + ")" : ""}`}>{d.slice(0,3)}</button>
                    )}
                  </div>
                  </React.Fragment>
                );
              })}
              {weeklyData && (<div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                {/* Save/Load wtt versions */}
                <div style={{ position: "relative" }}>
                  {showWttSavePrompt ? (
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input value={wttVersionName} onChange={e => setWttVersionName(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") saveWttVersion(wttVersionName); if (e.key === "Escape") setShowWttSavePrompt(false); }}
                        placeholder="Version name..."
                        autoFocus
                        style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", width: 140 }} />
                      <Btn variant="success" onClick={() => saveWttVersion(wttVersionName)} style={{ fontSize: 11, padding: "4px 8px" }}>✓</Btn>
                      <Btn variant="ghost" onClick={() => setShowWttSavePrompt(false)} style={{ fontSize: 11, padding: "4px 6px" }}>✕</Btn>
                    </div>
                  ) : (
                    <Btn variant="secondary" onClick={() => { setWttVersionName(lastWttVersionNameRef.current[selectedSchool] || ""); setShowWttSavePrompt(true); }} style={{ fontSize: 12 }} title="Save this week's timetable as a version">💾</Btn>
                  )}
                </div>
                {wttSavedVersions.filter(v => v.schoolId === selectedSchool).length > 0 && (
                  <div style={{ position: "relative" }}>
                    <Btn variant="secondary" onClick={() => setShowWttVersionMenu(!showWttVersionMenu)} style={{ fontSize: 12 }}>
                      📂 {wttSavedVersions.filter(v => v.schoolId === selectedSchool).length}
                    </Btn>
                    {showWttVersionMenu && (
                      <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 260, zIndex: 50, maxHeight: 300, overflowY: "auto" }}>
                        <div style={{ padding: "8px 12px", fontSize: 11, color: colors.textMuted, borderBottom: `1px solid ${colors.borderLight}`, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                          Saved weekly versions
                        </div>
                        {wttSavedVersions.filter(v => v.schoolId === selectedSchool).sort((a, b) => new Date(b.date) - new Date(a.date)).map(v => (
                          <div key={v.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: `1px solid ${colors.borderLight}`, fontSize: 12 }}
                            onMouseEnter={e => e.currentTarget.style.background = colors.bg} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                            <div onClick={() => loadWttVersion(v)} style={{ cursor: "pointer", flex: 1 }}>
                              <div style={{ fontWeight: 600, color: colors.text }}>{v.name}</div>
                              <div style={{ fontSize: 11, color: colors.textMuted }}>{v.weekLabel} · {new Date(v.date).toLocaleDateString()} · {v.lessons.length} lessons</div>
                            </div>
                            <button onClick={e => { e.stopPropagation(); deleteWttVersion(v.id); }}
                              style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 14, padding: "2px 6px" }}
                              title="Delete version">×</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ position: "relative" }}>
                  <span ref={clearMenuBtnRef} style={{ display: "inline-block" }}>
                    <Btn variant="danger" onClick={() => {
                      const rect = clearMenuBtnRef.current?.getBoundingClientRect();
                      if (rect) setClearMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                      setShowClearMenu(v => !v); setConfirmClearWeek(false);
                    }} style={{ border: "none" }} title="Clear this week">🗑</Btn>
                  </span>
                  {showClearMenu && (() => {
                    const menuDays = (currentSchool?.days || DAYS).filter(d => (weeklyData?.lessons || []).some(l => l.day === d));
                    return (
                      <div ref={clearMenuRef} style={{ position: "fixed", top: clearMenuPos.top, right: clearMenuPos.right, background: colors.white, border: "1px solid " + colors.border, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 160, zIndex: 9999, overflow: "hidden" }}>
                        {menuDays.map(d => (
                          confirmClearWeek === d ? (
                            <div key={d} style={{ display: "flex", gap: 6, alignItems: "center", background: "#FEF2F2", padding: "8px 12px", whiteSpace: "nowrap" }}>
                              <span style={{ fontSize: 12, color: colors.danger, fontWeight: 500, flex: 1 }}>Clear {d}?</span>
                              <Btn variant="danger" onClick={() => { clearWeek(d); setShowClearMenu(false); setConfirmClearWeek(false); }} style={{ height: 24, padding: "0 8px", fontSize: 11, borderRadius: 5, fontWeight: 600 }}>Yes</Btn>
                              <Btn variant="secondary" onClick={() => setConfirmClearWeek(false)} style={{ height: 24, padding: "0 8px", fontSize: 11, borderRadius: 5, fontWeight: 600 }}>No</Btn>
                            </div>
                          ) : (
                            <div key={d} onClick={() => setConfirmClearWeek(d)}
                              style={{ padding: "8px 14px", fontSize: 12, cursor: "pointer", color: colors.text, fontWeight: 500 }}
                              onMouseEnter={e => e.currentTarget.style.background = "#FEF2F2"}
                              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>{d}</div>
                          )
                        ))}
                        {menuDays.length > 0 && <div style={{ height: 1, background: colors.border, margin: "2px 0" }} />}
                        {confirmClearWeek === "all" ? (
                          <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#FEF2F2", padding: "8px 12px", whiteSpace: "nowrap" }}>
                            <span style={{ fontSize: 12, color: colors.danger, fontWeight: 500, flex: 1 }}>Clear all?</span>
                            <Btn variant="danger" onClick={() => { clearWeek(); setShowClearMenu(false); setConfirmClearWeek(false); }} style={{ height: 24, padding: "0 8px", fontSize: 11, borderRadius: 5, fontWeight: 600 }}>Yes</Btn>
                            <Btn variant="secondary" onClick={() => setConfirmClearWeek(false)} style={{ height: 24, padding: "0 8px", fontSize: 11, borderRadius: 5, fontWeight: 600 }}>No</Btn>
                          </div>
                        ) : (
                          <div onClick={() => setConfirmClearWeek("all")}
                            style={{ padding: "8px 14px", fontSize: 12, cursor: "pointer", color: colors.danger, fontWeight: 600 }}
                            onMouseEnter={e => e.currentTarget.style.background = "#FEF2F2"}
                            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>Full week</div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>)}
            </div>
            {weeklyData && (
              <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 8 }}>
                Generated {new Date(weeklyData.generatedAt).toLocaleString()}
              </div>
            )}
            </div>
          </Card>}
          </>
          )}

          {/* Weekly Grid */}
          {weeklyData ? (
            <div style={{ pointerEvents: isLocked ? "none" : "auto" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <Card style={{ flex: 1, padding: "8px 14px" }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: colors.accent }}>{weeklyData.lessons.length}</span>
                  <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 6 }}>Lessons</span>
                </Card>
                <Card style={{ flex: 1, padding: "8px 14px" }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: "#D97706" }}>{weeklyData.lessons.filter(l => l.adjusted).length}</span>
                  <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 6 }}>Adjusted</span>
                </Card>
                <Card style={{ flex: 1, padding: "8px 14px" }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: colors.danger }}>{weeklyData.missed.length}</span>
                  <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 6 }}>Missed</span>
                </Card>
              </div>

              {(() => {
                const schoolDays = (currentSchool?.days || DAYS).slice().sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
                const wLessons = weeklyData.lessons;

                // Weekly break cards: stored in weeklyData.breaks; fall back to masterBreaks for this school
                const weeklyBreaks = weeklyData.breaks || (masterBreaks || []).filter(b => b.schoolId === selectedSchool);
                const wGetBreak = (time, day) => weeklyBreaks.find(b => b.day === day && b.time === time) || null;
                // Map slot start times to their type (recess/lunch) for display
                const schoolSlotTypeMap = {};
                if (currentSchool) {
                  for (const sl of (currentSchool.slots || [])) {
                    if (sl.type === "recess" || sl.type === "lunch") schoolSlotTypeMap[sl.start] = sl.type;
                  }
                }
                // Check if a time falls within a school-wide teacherBreak range (truly blocked)
                const isTeacherBreakTime = (time) => (currentSchool?.teacherBreaks || []).some(b => {
                  const tMin = timeToMin(time);
                  return tMin >= timeToMin(b.start) && tMin < timeToMin(b.end);
                });
                const updateWeeklyBreaks = (newBreaks) => {
                  setWeeklyTimetables(prev => ({ ...prev, [storageKey]: { ...weeklyData, breaks: newBreaks } }));
                };

                // Build grid rows from school slots (so empty slots always show)
                const schoolSlotTimes = currentSchool ? currentSchool.slots.map(s => s.start) : [];
                const schoolLevelBreakTimes = (currentSchool?.teacherBreaks || []).map(b => b.start);
                const allTimes = [...new Set([
                  ...schoolSlotTimes,
                  ...schoolLevelBreakTimes,
                  ...wLessons.map(l => l.start),
                  ...weeklyBreaks.map(b => b.time)
                ])].sort();

                // Day blocked helper
                const isDayBlocked = (dayName) => {
                  const dayDate = weekDates.find(wd => wd.day === dayName);
                  if (!dayDate) return false;
                  return weekInterruptions.some(intr => {
                    const start = intr.date;
                    const end = intr.endDate || intr.date;
                    if (dayDate.date < start || dayDate.date > end) return false;
                    return intr.affectsClasses === "all" && !intr.startTime;
                  });
                };

                return (
                  <div ref={gridRefCb} onScroll={handleGridScroll} onClick={() => { if (selectedCards.size > 0) setSelectedCards(new Set()); if (selectedDays.size > 0) setSelectedDays(new Set()); if (selectedMissed.size > 0) setSelectedMissed(new Set()); }} style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 200px)", border: `1px solid ${colors.border}`, borderRadius: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: `50px repeat(${schoolDays.length}, 1fr)`, gap: 1, background: colors.border }}>
                      {/* Header row */}
                      <div style={{ background: colors.sidebarActive, color: colors.white, padding: "12px 8px", fontSize: 11, fontWeight: 600, textAlign: "center", position: "sticky", top: 0, zIndex: 10 }}>Time</div>
                      {schoolDays.map(d => {
                        const blocked = isDayBlocked(d);
                        const daySelected = selectedDays.has(d);
                        return (
                          <div key={d}
                            style={{ background: daySelected ? colors.accent : blocked ? "#7F1D1D" : colors.sidebarActive, color: colors.white, padding: "12px 8px", fontSize: 13, fontWeight: 600, textAlign: "center", position: "sticky", top: 0, zIndex: 10, cursor: "pointer", userSelect: "none", transition: "background 0.15s" }}
                            onClick={e => {
                              e.stopPropagation();
                              const dayLessonIds = (weeklyData?.lessons || []).filter(l => l.day === d).map(l => l.id);
                              setSelectedDays(prev => {
                                const next = new Set(prev);
                                if (next.has(d)) {
                                  next.delete(d);
                                  setSelectedCards(cards => { const nc = new Set(cards); dayLessonIds.forEach(id => nc.delete(id)); return nc; });
                                } else {
                                  next.add(d);
                                  setSelectedCards(cards => { const nc = new Set(cards); dayLessonIds.forEach(id => nc.add(id)); return nc; });
                                }
                                return next;
                              });
                            }}
                            onContextMenu={e => {
                              e.preventDefault();
                              setContextMenu({ x: e.clientX, y: e.clientY, isDayHeader: true, day: d, schoolId: selectedSchool });
                              setDayHeaderSubmenu(null);
                              setSwapTeacherSubmenu(null);
                            }}>
                            {d}
                            {blocked && <div style={{ fontSize: 9, color: "#FCA5A5", marginTop: 2 }}>BLOCKED</div>}
                          </div>
                        );
                      })}

                      {/* Time rows */}
                      {allTimes.map(time => {
                        const isTeacherBreak = isTeacherBreakTime(time);
                        const isSlotBreak = !!schoolSlotTypeMap[time]; // subtle indicator only
                        return (
                        <React.Fragment key={`wrow-${time}`}>
                          <div style={{ background: colors.sidebarActive, padding: "8px 2px", fontSize: 11, fontWeight: 600, color: colors.white, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 1 }}>
                            {toTimeLabel(time)}
                            {isSlotBreak && !isTeacherBreak && <span style={{ fontSize: 9, opacity: 0.7 }}>☕</span>}
                          </div>
                          {isTeacherBreak ? (
                            <div style={{ gridColumn: `2 / -1`, background: "#FFF7ED", padding: "8px", minHeight: 36, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <span style={{ fontWeight: 600, color: "#92400E", fontSize: 12 }}>☕ Break</span>
                            </div>
                          ) : schoolDays.map(day => {
                            const cellBreak = wGetBreak(time, day);
                            const cellLessons = wLessons.filter(l => l.day === day && l.start === time);
                            const blocked = isDayBlocked(day);
                            const isDropTarget = dragOver && dragOver.day === day && dragOver.time === time;
                            return (
                              <div key={`${day}-${time}`}
                                onContextMenu={e => {
                                  const hasMasterLesson = cellLessons.length > 0 || wGetBreak(time, day);
                                  if (!hasMasterLesson) {
                                    e.preventDefault();
                                    setContextMenu({ x: e.clientX, y: e.clientY, isEmpty: true, day, time, schoolId: selectedSchool, weekKey: storageKey });
                                  }
                                }}
                                onDragOver={e => {
                                e.preventDefault(); e.dataTransfer.dropEffect = "move";
                                setDragOver({ day, time });
                                if (draggingId && currentSchool) {
                                  const ck = day + "|" + time;
                                  if (!dragCache.current[ck]) {
                                    try {
                                      let dl = null;
                                      if (draggingId.startsWith("missed:")) {
                                        const mi = parseInt(draggingId.split(":")[1]);
                                        dl = (weeklyData.missed || [])[mi] || null;
                                      } else if (draggingId.startsWith("staged:")) {
                                        const sid = draggingId.split(":")[1];
                                        dl = (weeklyData.catchupStaged || []).find(c => c.id === sid) || null;
                                      } else {
                                        dl = (weeklyData ? weeklyData.lessons : []).find(l => l.id === draggingId);
                                      }
                                      const sl = (currentSchool.slots || []).find(s => s.start === time);
                                      if (dl && sl) {
                                        const raw = checkConstraints(dl, day, sl);
                                        const warns = raw.filter(w => !(w.includes("already has") && w.includes("at this time")));
                                        let specs = [];
                                        if (dl.isBandSession) {
                                          const sS = timeToMin(sl.start), sE = timeToMin(sl.end || sl.start);
                                          const specSet = new Set();
                                          for (const m of (dl.members || [])) {
                                            const ms = students.find(s => s.id === m.studentId);
                                            if (!ms || !ms.className) continue;
                                            const mSpecs = (specLookupRef[dl.schoolId + "|" + ms.className + "|" + day] || []).filter(sp => sS < sp.end && sE > sp.start);
                                            mSpecs.forEach(sp => specSet.add((sp.subject || "Specialist") + " (" + ms.name.split(" ")[0] + ")"));
                                          }
                                          specs = [...specSet];
                                        } else {
                                          const st = students.find(s => s.id === dl.studentId);
                                          specs = st && st.className ? (specLookupRef[dl.schoolId + "|" + st.className + "|" + day] || []).filter(sp => { const sS = timeToMin(sl.start), sE = timeToMin(sl.end || sl.start); return sS < sp.end && sE > sp.start; }).map(sp => sp.subject || "Specialist") : [];
                                        }
                                        dragCache.current[ck] = { warns, specs };
                                      } else { dragCache.current[ck] = { warns: [], specs: [] }; }
                                    } catch(err) { dragCache.current[ck] = { warns: [], specs: [] }; }
                                  }
                                  const c = dragCache.current[ck] || { warns: [], specs: [] };
                                  showHoverPanel(e.clientX, e.clientY, c.warns, c.specs);
                                }
                              }}
                                onDragLeave={() => { setDragOver(null); hideHoverPanel(); }}
                                onDrop={e => {
                                  e.preventDefault(); setDragOver(null); setDraggingId(null); hideHoverPanel();
                                  const lid = e.dataTransfer.getData("text/plain");
                                  if (!lid) return;
                                  if (lid.startsWith("missed:")) {
                                    handleRescueMissed(parseInt(lid.split(":")[1]), day, time);
                                  } else if (lid.startsWith("wbreak:")) {
                                    const breakId = lid.split(":")[1];
                                    updateWeeklyBreaks(weeklyBreaks.map(b => b.id !== breakId ? b : { ...b, day, time }));
                                  } else if (lid.startsWith("staged:")) {
                                    handlePlaceStagedCatchup(lid.split(":")[1], day, time);
                                  } else {
                                    handleWeeklyMoveLesson(lid, day, time);
                                  }
                                }}
                                style={{
                                  background: isDropTarget ? colors.accentLight : blocked ? "#FEF2F2" : cellBreak ? "#FFF7ED" : colors.white,
                                  padding: 4, minHeight: 32, display: "flex", flexDirection: "column", gap: 3,
                                  outline: isDropTarget ? `2px dashed ${colors.accent}` : "none",
                                  transition: "background 0.15s, outline 0.15s"
                                }}
                              >
                                {cellBreak && (
                                  <div
                                    draggable
                                    onDragStart={e => {
                                      e.dataTransfer.setData("text/plain", `wbreak:${cellBreak.id}`);
                                      e.dataTransfer.effectAllowed = "move";
                                      setDraggingId(`wbreak:${cellBreak.id}`);
                                    }}
                                    onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
                                    style={{ padding: "6px 10px", borderRadius: 6, fontSize: 13, background: "#FED7AA40", borderLeft: "3px solid #D97706", textAlign: "center", cursor: "grab", position: "relative", opacity: draggingId === `wbreak:${cellBreak.id}` ? 0.4 : 1, transition: "opacity 0.15s" }}>
                                    <span style={{ fontWeight: 600, color: "#92400E" }}>☕ Break</span>
                                    <span
                                      onClick={e => { e.stopPropagation(); updateWeeklyBreaks(weeklyBreaks.filter(b => b.id !== cellBreak.id)); }}
                                      style={{ position: "absolute", top: 1, right: 3, fontSize: 10, color: "#DC2626", cursor: "pointer", lineHeight: 1, fontWeight: 700 }}
                                      title="Remove break">✕</span>
                                  </div>
                                )}
                                {cellLessons.map((l, li) => {
                                  const cWarnings = constraintWarnings[l.id] || [];
                                  // ── Band session card ──
                                  if (l.isBandSession) {
                                    const bandMembers = (l.members || []);
                                    const memberNames = bandMembers.map(m => {
                                      const s = students.find(st => st.id === m.studentId);
                                      if (!s) return null;
                                      const displayName = bandDisplayName(s, bandMembers.map(bm => students.find(st2 => st2.id === bm.studentId)).filter(Boolean));
                                      const abbr = m.instrument ? m.instrument : null;
                                      return displayName + (abbr ? ` (${abbr})` : "");
                                    }).filter(Boolean);
                                    const bandWarnings = cWarnings;
                                    const hasBandWarning = bandWarnings.length > 0 && !ackedConstraints.has(l.id);
                                    const bandWarningAcked = bandWarnings.length > 0 && ackedConstraints.has(l.id);
                                    const isBandExpanded = expandedWarnings.has(l.id);
                                    // Specialist conflicts across all members
                                    const sl = (currentSchool?.slots || []).find(s => s.start === l.start);
                                    const bandSpecTags = (() => {
                                      if (!sl) return [];
                                      const sS = timeToMin(sl.start), sE = timeToMin(sl.end || sl.start);
                                      const specSet = new Set();
                                      for (const m of bandMembers) {
                                        const ms = students.find(s => s.id === m.studentId);
                                        if (!ms?.className) continue;
                                        const mSpecs = (specLookupRef[l.schoolId + "|" + ms.className + "|" + l.day] || []).filter(sp => sS < sp.end && sE > sp.start);
                                        mSpecs.forEach(sp => specSet.add((sp.subject || "Specialist") + " (" + ms.name.split(" ")[0] + ")"));
                                      }
                                      return [...specSet];
                                    })();
                                    return (
                                      <div key={li} draggable
                                        onDragStart={e => { e.dataTransfer.setData("text/plain", l.id); e.dataTransfer.effectAllowed = "move"; setDraggingId(l.id); setExpandedWarnings(new Set()); dragCache.current = {}; }}
                                        onDragEnd={() => { setDraggingId(null); setDragOver(null); hideHoverPanel(); dragCache.current = {}; }}
                                        onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, isBandSession: true, lessonId: l.id, bandName: l.bandName, bandId: l.bandId }); }}
                                        onClick={e => { if (isBandExpanded || hasBandWarning) { e.stopPropagation(); setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); return next; }); setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; }); } }}
                                        style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12, lineHeight: 1.4, position: "relative", cursor: "grab",
                                          background: hasBandWarning ? "#FEF2F2" : instruments_colors.Band + "18",
                                          borderLeft: `3px solid ${hasBandWarning ? colors.danger : instruments_colors.Band}`,
                                          opacity: draggingId === l.id ? 0.4 : 1, transition: "opacity 0.15s"
                                        }}>
                                        {hasBandWarning && (
                                          <span onClick={e => { e.stopPropagation(); setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); return next; }); setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; }); }}
                                            style={{ position: "absolute", bottom: 2, right: 5, cursor: "pointer", fontSize: 13, lineHeight: 1, color: colors.success, fontWeight: 700 }} title="Confirm this time">✓</span>
                                        )}
                                        {bandWarningAcked && !hasBandWarning && (
                                          <span onClick={e => { e.stopPropagation(); setExpandedWarnings(prev => { const next = new Set(prev); if (next.has(l.id)) next.delete(l.id); else next.add(l.id); return next; }); }}
                                            style={{ position: "absolute", bottom: 2, right: 5, cursor: "pointer", fontSize: 11, lineHeight: 1, color: colors.danger, fontWeight: 700, opacity: 0.6 }} title="Click to view warnings">⚠</span>
                                        )}
                                        <div style={{ fontWeight: 600, color: hasBandWarning ? colors.text : colors.text }}>{l.bandName || "TBC"}</div>
                                        {memberNames.length > 0 && <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>{memberNames.join(", ")}</div>}
                                        {l.teacherName && <div style={{ color: colors.textLight, fontSize: 11 }}>{l.teacherName.split(" ")[0]}</div>}
                                        {bandSpecTags.length > 0 && draggingId !== l.id && <div style={{ color: colors.specialistTag, fontSize: 10, fontWeight: 600 }}>during {bandSpecTags.join(", ")}</div>}
                                        {isBandExpanded && (
                                          <div style={{ position: "absolute", left: -3, right: 0, top: "100%", marginTop: 2, padding: "6px 8px", background: "#FEF2F2", border: `1px solid ${colors.danger}30`, borderRadius: 6, fontSize: 10, lineHeight: 1.4, zIndex: 20, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
                                            {bandWarnings.map((w, wi) => <div key={wi} style={{ color: colors.danger, fontWeight: 500 }}>⚠ {w}</div>)}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  }
                                  // ── Regular lesson card ──
                                  const hasConstraintIssue = cWarnings.length > 0 && !ackedConstraints.has(l.id);
                                  const constraintAcked = cWarnings.length > 0 && ackedConstraints.has(l.id);
                                  const showRed = hasConstraintIssue;
                                  const hasAckedWarning = constraintAcked;
                                  const isExpanded = expandedWarnings.has(l.id);
                                  return (
                                  <div key={li} draggable
                                    onDragStart={e => {
                                      e.dataTransfer.setData("text/plain", l.id); e.dataTransfer.effectAllowed = "move";
                                      setDraggingId(l.id); setExpandedWarnings(new Set()); dragCache.current = {};
                                      if (l._swapTeacherId) setWeeklyTimetables(prev => { const d = prev[storageKey]; if (!d) return prev; return { ...prev, [storageKey]: { ...d, lessons: d.lessons.map(x => x.id === l.id ? { ...x, _swapTeacherId: undefined, _swapTeacherName: undefined } : x) } }; });
                                    }}
                                    onDragEnd={() => { setDraggingId(null); setDragOver(null); hideHoverPanel(); dragCache.current = {}; }}
                                    onContextMenu={e => { e.preventDefault(); setWttEmailSubmenu(null); setWttEmailLevel2(null); setSwapTeacherSubmenu(null); setContextMenu({ x: e.clientX, y: e.clientY, lessonId: l.id, studentId: l.studentId, isGroup: l.isGroup, isMakeup: l.isMakeup, makeupForTallyId: l.makeupForTallyId, isMulti: selectedCards.size > 1 && selectedCards.has(l.id), selectedIds: selectedCards.size > 1 && selectedCards.has(l.id) ? [...selectedCards] : null, lessonName: l.isGroup && l.studentNames ? `${l.studentNames.join(", ")} — ${l.instrument}` : `${l.studentName} — ${l.instrument}` }); }}
                                    onClick={e => {
                                      e.stopPropagation();
                                      // If a double-click timer is already running, this is the 2nd click → open details
                                      if (clickTimerRef.current[l.id]) {
                                        clearTimeout(clickTimerRef.current[l.id]);
                                        delete clickTimerRef.current[l.id];
                                        if (l.isGroup && onViewGroup) onViewGroup(l.groupId);
                                        else if (!l.isGroup && onViewStudent) onViewStudent(l.studentId);
                                        return;
                                      }
                                      // Start timer — if no second click within 220ms, treat as single click
                                      clickTimerRef.current[l.id] = setTimeout(() => {
                                        delete clickTimerRef.current[l.id];
                                        if (isExpanded || showRed) {
                                          setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); return next; });
                                          setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; });
                                        } else {
                                          setSelectedCards(prev => { const next = new Set(prev); if (next.has(l.id)) next.delete(l.id); else next.add(l.id); return next; });
                                        }
                                      }, 220);
                                    }}
                                    style={{
                                      padding: "6px 10px", borderRadius: 6, fontSize: 13, lineHeight: 1.4, cursor: "grab", position: "relative",
                                      background: selectedCards.has(l.id) ? `${colors.sidebarActive}18` : showRed ? "#FEF2F2" : getInstColor(l.instrument, l.isGroup) + "18",
                                      borderLeft: `3px solid ${selectedCards.has(l.id) ? colors.sidebarActive : showRed ? colors.danger : getInstColor(l.instrument, l.isGroup)}`,
                                      borderTop: selectedCards.has(l.id) ? `1.5px solid ${colors.sidebarActive}` : "none",
                                      borderRight: selectedCards.has(l.id) ? `1.5px solid ${colors.sidebarActive}` : "none",
                                      borderBottom: selectedCards.has(l.id) ? `1.5px solid ${colors.sidebarActive}` : l.adjusted && !showRed && !hasAckedWarning ? "3px solid #F59E0B" : "none",
                                      opacity: draggingId === l.id ? 0.4 : 1, transition: "opacity 0.15s",
                                    }} title={l.isGroup ? l.groupName || l.studentName : l.adjustReason || undefined}>
                                    {showRed && <span onClick={e => { e.stopPropagation(); setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); return next; }); setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; }); }} style={{ position: "absolute", bottom: 2, right: 5, cursor: "pointer", fontSize: 13, lineHeight: 1, color: colors.success, fontWeight: 700 }} title="Confirm this time">✓</span>}
                                    {hasAckedWarning && !showRed && <span onClick={e => { e.stopPropagation(); setExpandedWarnings(prev => { const next = new Set(prev); if (next.has(l.id)) next.delete(l.id); else next.add(l.id); return next; }); }} style={{ position: "absolute", bottom: 2, right: 5, cursor: "pointer", fontSize: 11, lineHeight: 1, color: colors.danger, fontWeight: 700, opacity: 0.6 }} title="Click to view warnings">⚠</span>}
                                    {l.isMakeup && <span onClick={e => { e.stopPropagation(); const wkData = weeklyTimetables[storageKey] || { lessons: [], missed: [] }; setWeeklyTimetables(prev => ({ ...prev, [storageKey]: { ...wkData, lessons: (wkData.lessons || []).filter(x => x.id !== l.id) } })); }} style={{ position: "absolute", top: 2, right: 4, fontSize: 13, color: colors.sidebarActive, cursor: "pointer", lineHeight: 1, fontWeight: 700, zIndex: 2 }} title="Catch-up lesson — click to remove">↺</span>}
                                    {/* 4: Name + inline note icon */}
                                    <div style={{ fontWeight: 600, color: colors.text, display: "flex", alignItems: "center", gap: 4, overflow: "hidden" }}>
                                      {l.isGroup ? "👥 " : ""}
                                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.isGroup && l.studentNames ? (() => { const names = groupDisplayName(l); const classes = (l.studentIds || []).map(sid => { const ms = students.find(s => s.id === sid); return ms?.className || ""; }).filter(Boolean); const uniqueClasses = [...new Set(classes)]; return names + (uniqueClasses.length > 0 ? " — " + (uniqueClasses.length === 1 ? uniqueClasses[0] : classes.join(", ")) : ""); })() : l.studentName + (() => { const st = students.find(s => s.id === l.studentId); return st?.className ? ` · ${st.className}` : ""; })()}</span>
                                      {(() => { const _wttSt = !l.isGroup ? students.find(s => s.id === l.studentId) : null; const noteText = l.cardNote || (_wttSt?.notes || ""); if (!noteText) return null; return <span onClick={e => e.stopPropagation()} onMouseEnter={e => setHoverNotes({ text: noteText, x: e.clientX, y: e.clientY })} onMouseMove={e => setHoverNotes(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : prev)} onMouseLeave={() => setHoverNotes(null)} style={{ fontSize: 10, color: l.cardNote ? colors.accent : colors.textMuted, cursor: "default", userSelect: "none", flexShrink: 0 }}>📝</span>; })()}
                                    </div>
                                    {/* 5: Teacher line — shows swap name */}
                                    {(() => { const _tn = l._swapTeacherId ? (l._swapTeacherName || teachers.find(t => t.id === l._swapTeacherId)?.name || "") : getLiveTeacherName(l, students, teachers); const _unassigned = !l._swapTeacherId && isLessonUnassigned(l, students); return <div style={{ color: _unassigned ? colors.danger : l._swapTeacherId ? "#7C3AED" : colors.textLight }}>{l.instrument ? `${l.instrument} · ` : ""}{_unassigned ? "Unassigned" : _tn.split(" ")[0]}{l.isTemp && <span style={{ color: colors.danger, fontWeight: 700, fontSize: 10, marginLeft: 4 }}>TEMP</span>}</div>; })()}
                                    {(() => { const ds = getLiveSpecialistTag(l); return ds && draggingId !== l.id ? <div style={{ color: colors.specialistTag, fontSize: 10, fontWeight: 600 }}>during {typeof ds === "string" ? ds : "specialist"}</div> : null; })()}
                                    {l.adjusted && <div style={{ fontSize: 10, color: "#D97706", marginTop: 2, fontStyle: "italic" }}>↻ {l.adjustReason}</div>}
                                    {isExpanded && <div style={{ position: "absolute", left: -3, right: 0, top: "100%", marginTop: 2, padding: "6px 8px", background: "#FEF2F2", border: `1px solid ${colors.danger}30`, borderRadius: 6, fontSize: 10, lineHeight: 1.4, zIndex: 20, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>{cWarnings.map((w, wi) => <div key={wi} style={{ color: colors.danger, fontWeight: 500 }}>⚠ {w}</div>)}</div>}
                                  </div>
                                  );
                                })}


                              </div>
                            );
                          })}
                        </React.Fragment>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Hover warning panel — DOM-driven, no React state */}
              <div ref={hoverPanelRef} style={{
                display: "none", position: "fixed", zIndex: 9999, pointerEvents: "none",
                background: "#FFFBFF", border: "1px solid #E5E7EB",
                borderRadius: 8, padding: "8px 12px", fontSize: 11, lineHeight: 1.6,
                boxShadow: "0 4px 16px rgba(0,0,0,0.18)", minWidth: 180, maxWidth: 300,
              }} />

              {/* Student note tooltip */}
              {hoverNotes && (
                <div style={{ position: "fixed", left: hoverNotes.x + 12, top: hoverNotes.y - 8, background: colors.sidebar, color: "#fff", fontSize: 12, padding: "7px 11px", borderRadius: 8, zIndex: 10001, maxWidth: 260, pointerEvents: "none", whiteSpace: "pre-wrap", lineHeight: 1.5, boxShadow: "0 4px 16px rgba(0,0,0,0.25)" }}>
                  {hoverNotes.text}
                </div>
              )}

              <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "flex-start" }}>
                <Card style={{ flex: 1, borderColor: dragOverMissed ? colors.danger : colors.danger + "40", transition: "border-color 0.15s" }}
                  onContextMenu={e => {
                    if (weeklyData.missed.length === 0) return;
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, isMissedZone: true, schoolId: selectedSchool });
                    setMissedZoneSubmenu(null);
                  }}
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                  onDragEnter={e => { e.preventDefault(); const lid = e.dataTransfer.getData("text/plain") || draggingId || ""; if (!lid.startsWith("missed:") && !lid.startsWith("staged:") && !lid.startsWith("wbreak:")) setDragOverMissed(true); }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverMissed(false); }}
                  onDrop={e => {
                    e.preventDefault(); setDragOverMissed(false);
                    const lid = e.dataTransfer.getData("text/plain");
                    if (lid && !lid.startsWith("missed:")) {
                      const dl = (weeklyData.lessons || []).find(l => l.id === lid);
                      if (dl && (dl.fromStaged || dl.isBandSession)) return;
                      handleMissedDrop(lid);
                    }
                  }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: colors.danger, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                  {`Missed Lessons${weeklyData.missed.length > 0 ? ` (${weeklyData.missed.length})` : ""}`}
                  <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 400, marginLeft: 4 }}>· drag lessons here to mark as missed, or drag missed lessons onto the grid to reschedule</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minHeight: 72, alignContent: "flex-start", borderRadius: 8, padding: 4, background: dragOverMissed ? "#FEF2F2" : "transparent", transition: "background 0.15s" }}>
                  {weeklyData.missed.length === 0 && !dragOverMissed && (
                    <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic", padding: "4px 0" }}>No missed lessons this week</div>
                  )}
                  {weeklyData.missed.map((m, i) => {
                    const isSelectedMissed = selectedMissed.has(i);
                    const missedStudent = !m.isGroup ? students.find(s => s.id === m.studentId) : null;
                    const missedClassName = missedStudent?.className || "";
                    return (
                    <div key={i} draggable
                      onDragStart={e => { e.dataTransfer.setData("text/plain", `missed:${i}`); e.dataTransfer.effectAllowed = "move"; setDraggingId(`missed:${i}`); dragCache.current = {}; }}
                      onDragEnd={() => { setDraggingId(null); setDragOver(null); setDragOverMissed(false); setDragOverStaging(false); }}
                      onClick={e => { e.stopPropagation(); setSelectedMissed(prev => { const next = new Set(prev); next.has(i) ? next.delete(i) : next.add(i); return next; }); }}
                      onContextMenu={e => { e.preventDefault(); setWttEmailSubmenu(null); setWttEmailLevel2(null); setSwapTeacherSubmenu(null);
                        const isMultiMissed = selectedMissed.size > 1 && selectedMissed.has(i);
                        setContextMenu({ x: e.clientX, y: e.clientY, fromMissed: true, lessonId: m.id, studentId: m.studentId, isGroup: m.isGroup,
                          isMultiMissed, selectedMissedIndices: isMultiMissed ? [...selectedMissed] : null,
                          lessonName: m.isGroup && m.studentNames ? `${m.studentNames.join(", ")} — ${m.instrument}` : `${m.studentName} — ${m.instrument}` }); }}
                      onDoubleClick={() => { if (m.isGroup && onViewGroup) onViewGroup(m.groupId); else if (!m.isGroup && onViewStudent) onViewStudent(m.studentId); }}
                      style={{
                        padding: "6px 10px", background: isSelectedMissed ? "#FEE2E2" : "#FEF2F2", borderRadius: 8, fontSize: 12,
                        border: `1px solid ${isSelectedMissed ? colors.danger : colors.danger + "40"}`,
                        borderLeft: `3px solid ${colors.danger}`,
                        cursor: "grab", opacity: draggingId === `missed:${i}` ? 0.4 : 1,
                        transition: "opacity 0.15s, background 0.1s", maxWidth: 280,
                        boxShadow: isSelectedMissed ? `0 0 0 2px ${colors.danger}40` : "none",
                        position: "relative",
                      }}>
                      {m.isMakeup && <span style={{ position: "absolute", top: 2, right: 4, fontSize: 13, color: colors.sidebarActive, lineHeight: 1, fontWeight: 700 }} title="Missed catch-up lesson">↺</span>}
                      <div style={{ fontWeight: 600 }}>{m.isGroup ? "👥 " : ""}{m.isGroup ? m.groupName : m.studentName}{missedClassName ? <span style={{ fontWeight: 400, color: colors.textMuted, marginLeft: 5 }}>{missedClassName}</span> : null}</div>
                      <div style={{ color: colors.textLight, fontSize: 11 }}>
                        {m.instrument}{m.day ? ` · was ${m.day} ${m.start}` : ""}
                      </div>
                      <div style={{ color: colors.danger, fontSize: 10, marginTop: 2 }}>{m.reason}</div>
                    </div>
                    );
                  })}
                </div>
                </Card>

                {/* Catch-Up Lessons staging area */}
                <Card style={{ flex: 1, borderColor: dragOverStaging ? colors.accent : colors.accent + "40", transition: "border-color 0.15s" }}
                  onDragOver={e => {
                    const lid = draggingId || "";
                    if (!lid.startsWith("staged:")) {
                      const draggedLesson = (weeklyData.lessons || []).find(l => l.id === lid);
                      if (!draggedLesson || !draggedLesson.fromStaged) return;
                    }
                    e.preventDefault(); e.dataTransfer.dropEffect = "move";
                  }}
                  onDragEnter={e => {
                    e.preventDefault();
                    const lid = draggingId || "";
                    if (lid.startsWith("staged:")) { setDragOverStaging(true); return; }
                    const draggedLesson = (weeklyData.lessons || []).find(l => l.id === lid);
                    if (draggedLesson && draggedLesson.fromStaged) setDragOverStaging(true);
                  }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverStaging(false); }}
                  onDrop={e => {
                    e.preventDefault(); setDragOverStaging(false);
                    const lid = e.dataTransfer.getData("text/plain");
                    if (!lid || lid.startsWith("staged:") || lid.startsWith("missed:") || lid.startsWith("wbreak:")) return;
                    const draggedLesson = (weeklyData.lessons || []).find(l => l.id === lid);
                    if (!draggedLesson || !draggedLesson.fromStaged) return;
                    let restoredCard;
                    if (draggedLesson.isBandSession) {
                      restoredCard = { id: draggedLesson.id, isBandSession: true, bandId: draggedLesson.bandId, bandName: draggedLesson.bandName, schoolId: draggedLesson.schoolId, teacherId: draggedLesson.teacherId, members: draggedLesson.members || [] };
                    } else {
                      restoredCard = {
                        id: draggedLesson.id, studentId: draggedLesson.studentId, studentName: draggedLesson.studentName,
                        schoolId: draggedLesson.schoolId, schoolName: draggedLesson.schoolName,
                        instrument: draggedLesson.instrument, teacherId: draggedLesson.teacherId, teacherName: draggedLesson.teacherName,
                        isMakeup: true, makeupForTallyId: draggedLesson.makeupForTallyId,
                      };
                    }
                    setWeeklyTimetables(prev => {
                      const entry = prev[storageKey];
                      if (!entry) return prev;
                      return {
                        ...prev,
                        [storageKey]: {
                          ...entry,
                          lessons: entry.lessons.filter(l => l.id !== lid),
                          catchupStaged: [...(entry.catchupStaged || []), restoredCard],
                        }
                      };
                    });
                    setConstraintWarnings(prev => { const next = { ...prev }; delete next[lid]; return next; });
                    setAckedConstraints(prev => { const next = new Set(prev); next.delete(lid); return next; });
                    setDraggingId(null); setDragOver(null);
                  }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: colors.sidebarActive, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    {`Add Lesson${(weeklyData.catchupStaged || []).length > 0 ? ` (${weeklyData.catchupStaged.length})` : ""}`}
                    <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 400, marginLeft: 4 }}>· right-click any empty slot to add, then drag onto the grid</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minHeight: 72, alignContent: "flex-start", borderRadius: 8, padding: 4, background: dragOverStaging ? colors.accentLight : "transparent", transition: "background 0.15s" }}>
                  {(weeklyData.catchupStaged || []).map((c) => (
                      <div key={c.id} draggable
                        onDragStart={e => { e.dataTransfer.setData("text/plain", "staged:" + c.id); e.dataTransfer.effectAllowed = "move"; setDraggingId("staged:" + c.id); dragCache.current = {}; }}
                        onDragEnd={() => { setDraggingId(null); setDragOver(null); setDragOverMissed(false); setDragOverStaging(false); }}
                        style={{
                          padding: "6px 10px", borderRadius: 8, fontSize: 12,
                          background: c.isBandSession ? BAND_COLOR + "15" : colors.accentLight,
                          border: "1px solid " + (c.isBandSession ? BAND_COLOR : colors.accent) + "40",
                          borderLeft: "3px solid " + (c.isBandSession ? BAND_COLOR : colors.accent),
                          cursor: "grab", opacity: draggingId === "staged:" + c.id ? 0.4 : 1,
                          transition: "opacity 0.15s", maxWidth: 280, position: "relative"
                        }}>
                        <span
                          onClick={e => { e.stopPropagation();
                            setWeeklyTimetables(prev => {
                              const entry = prev[storageKey];
                              if (!entry) return prev;
                              return { ...prev, [storageKey]: { ...entry, catchupStaged: (entry.catchupStaged || []).filter(sc => sc.id !== c.id) } };
                            });
                          }}
                          style={{ position: "absolute", top: 2, right: 5, fontSize: 11, color: colors.textMuted, cursor: "pointer", lineHeight: 1, fontWeight: 700 }}
                          title="Remove">✕</span>
                        {c.isBandSession ? (
                          <>
                            <div style={{ fontWeight: 600, color: BAND_COLOR }}>{c.bandName || "Band"}</div>
                            <div style={{ color: colors.textMuted, fontSize: 11 }}>{(c.members || []).length} members · band session</div>
                            <div style={{ color: BAND_COLOR, fontSize: 10, marginTop: 2 }}>drag to place</div>
                          </>
                        ) : (
                          <>
                            <div style={{ fontWeight: 600, color: colors.accent }}>↺ {c.studentName}</div>
                            <div style={{ color: colors.textMuted, fontSize: 11 }}>{c.instrument}{c.teacherName ? " · " + c.teacherName : ""}</div>
                            <div style={{ color: colors.accent, fontSize: 10, marginTop: 2 }}>catch-up — drag to place</div>
                          </>
                        )}
                      </div>
                    ))}
                    {/* Always-visible empty slot — right-click to add */}
                    <div
                      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, isCatchupStage: true, schoolId: selectedSchool, weekKey: storageKey }); }}
                      style={{
                        padding: "6px 10px", borderRadius: 8, fontSize: 12, minWidth: 120, minHeight: 52,
                        border: "1.5px dashed " + colors.accent + "60",
                        background: "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: colors.textMuted, fontStyle: "italic", cursor: "context-menu", userSelect: "none",
                      }}>
                      Right-click to add
                    </div>
                  </div>
                </Card>
              </div>
            </div>
          ) : (
            <Card style={{ textAlign: "center", padding: "40px 20px", color: colors.textMuted }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
              <div style={{ fontWeight: 600, color: colors.textLight }}>No weekly timetable for {currentSchool?.name || "this school"}</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Add any adjustments above and hit Reschedule to create a weekly version based on the master timetable.</div>
            </Card>
          )}

          {/* Missed Tally */}
          {showMissedTally && (
            <Card style={{ marginTop: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>✓ Term Missed Lessons Tally</div>
                {Object.keys(tallyByStudent).length > 0 && (
                  <Btn variant="danger" onClick={() => { setTallyEntries(prev => prev.filter(e => e.status !== "missed")); notify("Missed tally cleared"); }} style={{ fontSize: 11 }}>Clear All</Btn>
                )}
              </div>
              {Object.keys(tallyByStudent).length === 0 ? (
                <div style={{ color: colors.textMuted, fontSize: 13, textAlign: "center", padding: 20 }}>No missed lessons recorded.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {Object.values(tallyByStudent).sort((a, b) => b.count - a.count).map((entry, i) => (
                    <div key={i} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "8px 12px", background: entry.count >= 3 ? "#FEF2F2" : colors.white,
                      border: `1px solid ${entry.count >= 3 ? colors.danger + "40" : colors.border}`,
                      borderRadius: 8, fontSize: 13
                    }}>
                      <div>
                        <strong>{entry.studentName}</strong>
                        <span style={{ color: colors.textMuted }}> — {entry.instrument} · {entry.schoolName}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 11, color: colors.textMuted }}>{entry.weeks.join(", ")}</span>
                        <Tag color={entry.count >= 3 ? colors.danger : entry.count >= 2 ? "#D97706" : colors.textMuted}>
                          {entry.count} missed
                        </Tag>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

