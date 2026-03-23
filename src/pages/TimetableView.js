// ============================================================
// TimetableView.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { colors, DAYS, STORAGE_KEYS, HEADER_HEIGHT } from "../constants";
import { uid, timeToMin, toTimeLabel, to12h, getInstColor, getInitials, getSchoolAcronym, melbourneNow, toLocalDateStr, getLiveTeacherName, isLessonUnassigned, openCompose, openGmailSequential, getParentEmails, groupDisplayName, clampMenuPos, getClassTeacher } from "../utils/helpers";
import { loadData, saveData } from "../utils/backup";
import { preferredFirstName, getEmailTemplates, resolveTemplate } from "../utils/emailTemplates";
import { generateWeeklyTimetable, buildWeeklyAIPrompt, printMasterTimetable, printWeeklyTimetable } from "../data/weeklyTimetableGenerator";
import { Card, PageTitle, NavButtons, Btn, Tag, EmptyState, FrozenCard, useDragScroll, PAGE_COLORS } from "../components/ui/SharedUI";
import { ConflictBanner } from "../components/ConflictBanner";
import { ExportDialog, ExportIcon } from "../components/ExportDialog";



export function TimetableView({ mainScrollRef, timetable, schools, students, allStudents, teachers, setTeachers, specialists, pendingStudents, masterBreaks, setMasterBreaks, viewState, setViewState, sharedSchool, setSharedSchool, sharedTimetableScroll, setSharedTimetableScroll, onExport, onPrint, onGenerate, onGenerateSchool, onClearSchool, onClear, onSchedulePending, onMoveLesson, onDeleteLesson, onViewStudent, onViewGroup, onPlaceUnsched, onPlacePending, onUndo, onRedo, undoCount, redoCount, onLoadVersion, onWarningsChange, initialConstraintWarnings, initialAckedConstraints, contacts, goBack, goForward, historyCursor, pageHistory }) {
  const selectedSchool = sharedSchool || viewState.selectedSchool;
  const viewMode = viewState.viewMode;
  const filterTeacher = viewState.filterTeacher;
  const setSelectedSchool = (v) => {
    const next = typeof v === "function" ? v(sharedSchool || viewState.selectedSchool) : v;
    setSharedSchool(next);
    setViewState(prev => ({ ...prev, selectedSchool: next }));
  };
  const setViewMode = (v) => setViewState(prev => ({ ...prev, viewMode: v }));
  const setFilterTeacher = (v) => setViewState(prev => ({ ...prev, filterTeacher: v }));
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmGenerateEmpty, setConfirmGenerateEmpty] = useState(false);
  const [isScheduling, setIsScheduling] = useState(false);
  const [confirmClearSchool, setConfirmClearSchool] = useState(false);
  const [confirmRegenerateSchool, setConfirmRegenerateSchool] = useState(false);
  const [dragOver, setDragOver] = useState(null);
  const gridScrollRef = useRef(null);
  const savedGridScroll = useRef({});
  savedGridScroll.current = sharedTimetableScroll?.gridScroll || viewState.gridScroll || {};
  // Callback ref — fires when grid mounts (including when selectedSchool changes)
  const hasAutoScrolled = useRef(false);
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
  }, [selectedSchool]);
  const handleGridScroll = () => {
    const el = gridScrollRef.current;
    if (el) {
      const gs = { ...(sharedTimetableScroll?.gridScroll || {}), [selectedSchool]: { top: el.scrollTop, left: el.scrollLeft } };
      setSharedTimetableScroll(prev => ({ ...prev, gridScroll: gs }));
      setViewState(prev => ({ ...prev, gridScroll: gs }));
    }
  };
  const [draggingId, setDraggingId] = useState(null);
  useDragScroll(mainScrollRef, !!draggingId);
  const [unschedDragOver, setUnschedDragOver] = useState(false);
  const hoverPanelRef = React.useRef(null);
  const dragCache = React.useRef({});
  const [constraintWarnings, setConstraintWarnings] = useState(() => initialConstraintWarnings || {});
  const [ackedConstraints, setAckedConstraints] = useState(() => initialAckedConstraints || new Set());
  const [expandedWarnings, setExpandedWarnings] = useState(new Set());
  useEffect(() => { if (onWarningsChange) onWarningsChange(constraintWarnings, ackedConstraints); }, [constraintWarnings, ackedConstraints]);

  // Auto-check constraints for newly added lessons (e.g. right-click pending placement)
  const prevLessonIdsRef = React.useRef(new Set((timetable?.lessons || []).map(l => l.id)));
  useEffect(() => {
    if (!timetable) return;
    const curr = timetable.lessons;
    const currIds = new Set(curr.map(l => l.id));
    const prevIds = prevLessonIdsRef.current;
    const newLessons = curr.filter(l => !prevIds.has(l.id));
    prevLessonIdsRef.current = currIds;
    // Purge warnings for lessons that no longer exist
    setConstraintWarnings(prev => {
      const stale = Object.keys(prev).filter(id => !currIds.has(id));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      stale.forEach(id => delete next[id]);
      return next;
    });
    if (newLessons.length === 0) return;
    setConstraintWarnings(prev => {
      const next = { ...prev };
      for (const lesson of newLessons) {
        const school = schools.find(s => s.id === lesson.schoolId);
        const slot = school?.slots.find(s => s.start === lesson.start);
        if (!slot) continue;
        const w = checkConstraints(lesson, lesson.day, slot, curr);
        if (w.length > 0) { next[lesson.id] = w; }
      }
      return next;
    });
    setAckedConstraints(prev => { const next = new Set(prev); for (const l of newLessons) next.delete(l.id); return next; });
    setExpandedWarnings(prev => {
      const next = new Set(prev);
      for (const lesson of newLessons) {
        const school = schools.find(s => s.id === lesson.schoolId);
        const slot = school?.slots.find(s => s.start === lesson.start);
        if (slot && checkConstraints(lesson, lesson.day, slot, curr).length > 0) next.add(lesson.id);
      }
      return next;
    });
  }, [timetable?.lessons]);

  const [contextMenu, setContextMenu] = useState(null);
  const [hoverNotes, setHoverNotes] = useState(null) // null | { text, x, y };
  const [mttAddSubmenu, setMttAddSubmenu] = useState(null); // { type, y }
  const [mttEmailSubmenu, setMttEmailSubmenu] = useState(null); // { y } or null
  const [mttEmailLevel2, setMttEmailLevel2] = useState(null); // { type: "parents"|"teachers", y } or null
  const [mttDayHeaderSubmenu, setMttDayHeaderSubmenu] = useState(null); // { type, y } or null
  const [mttSelectedDays, setMttSelectedDays] = useState(new Set()); // Set of day names selected via header click
  const mttSubMenuRef = React.useRef(null);
  const mttMenuRef = React.useRef(null);
  const mttDayHeaderSubRef = React.useRef(null);
  const mttLevel2Ref = React.useRef(null);
  const mttCloseTimer = React.useRef(null);
  useEffect(() => {
    if (!contextMenu) return;
    const check = (e) => {
      const mx = e.clientX, my = e.clientY;
      const inMain = mttMenuRef.current && (() => { const r = mttMenuRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      const inSub = mttSubMenuRef.current && (() => { const r = mttSubMenuRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      const inDayHdr = mttDayHeaderSubRef.current && (() => { const r = mttDayHeaderSubRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      const inLevel2 = mttLevel2Ref.current && (() => { const r = mttLevel2Ref.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      if (inMain || inSub || inDayHdr || inLevel2) {
        if (mttCloseTimer.current) { clearTimeout(mttCloseTimer.current); mttCloseTimer.current = null; }
      } else {
        if (!mttCloseTimer.current) {
          mttCloseTimer.current = setTimeout(() => { setContextMenu(null); setMttAddSubmenu(null); mttCloseTimer.current = null; }, 250);
        }
      }
    };
    window.addEventListener("mousemove", check);
    return () => { window.removeEventListener("mousemove", check); if (mttCloseTimer.current) clearTimeout(mttCloseTimer.current); };
  }, [contextMenu]);
  // Tally prompt — shown when a lesson is manually dragged to missed area
  const [tallyPrompt, setTallyPrompt] = useState(null); // { lesson, missedEntry, weekKey, weekNum }
  const [tallyPromptNotes, setTallyPromptNotes] = useState("");
  const [savedVersions, setSavedVersions] = useState([]);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [versionName, setVersionName] = useState("");
  const lastVersionNameRef = React.useRef({}); // { [schoolId]: lastUsedName }
  const [showVersionMenu, setShowVersionMenu] = useState(false);

  // Load saved versions from storage on mount
  useEffect(() => {
    (async () => {
      const v = await loadData(STORAGE_KEYS.timetableVersions, []);
      setSavedVersions(v);
    })();
  }, []);

  const saveVersion = async (name) => {
    if (!timetable || !selectedSchool) return;
    const schoolLessons = timetable.lessons.filter(l => l.schoolId === selectedSchool);
    const school = schools.find(s => s.id === selectedSchool);
    const version = {
      id: uid(),
      schoolId: selectedSchool,
      schoolName: school?.name || "",
      name: name || `${school?.name || "School"} — ${new Date().toLocaleDateString()}`,
      date: new Date().toISOString(),
      lessons: JSON.parse(JSON.stringify(schoolLessons))
    };
    const updated = [...savedVersions, version];
    setSavedVersions(updated);
    await saveData(STORAGE_KEYS.timetableVersions, updated);
    lastVersionNameRef.current[selectedSchool] = name || version.name;
    setShowSavePrompt(false);
    setVersionName("");
  };

  const loadVersion = (version) => {
    if (onLoadVersion) onLoadVersion(version.schoolId, version.lessons);
    setShowVersionMenu(false);
  };

  const deleteVersion = async (versionId) => {
    const updated = savedVersions.filter(v => v.id !== versionId);
    setSavedVersions(updated);
    await saveData(STORAGE_KEYS.timetableVersions, updated);
  };

  const schoolVersions = savedVersions.filter(v => v.schoolId === selectedSchool);  const specLookupRef = React.useMemo(() => {
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
        const ms = (allStudents || students).find(s => s.id === mid);
        if (!ms || !ms.className) continue;
        const key = `${lesson.schoolId}|${ms.className}|${lesson.day}`;
        const specs = specLookupRef[key] || [];
        const match = specs.find(sp => sStart < sp.end && sEnd > sp.start);
        if (match && !subjects.includes(match.subject || "specialist")) subjects.push(match.subject || "specialist");
      }
      return subjects.length > 0 ? subjects.join(", ") : false;
    }
    const student = (allStudents || students).find(s => s.id === lesson.studentId);
    if (!student) return false;
    const key = `${lesson.schoolId}|${student.className}|${lesson.day}`;
    const specs = specLookupRef[key] || [];
    const match = specs.find(sp => sStart < sp.end && sEnd > sp.start);
    return match ? (match.subject || true) : false;
  };

  // Check student constraints against a destination slot

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
    const lessonList = _lessonList || (timetable ? timetable.lessons : []);
    if (lesson.isGroup) {
      const warnings = [];
      const memberIds = lesson.studentIds || [];
      // Member double-booking
      {
        for (const mid of memberIds) {
          const memberLesson = lessonList.find(l => l.id !== lesson.id && l.day === newDay && (
            l.studentId === mid || (l.isGroup && l.studentIds && l.studentIds.includes(mid))
          ));
          if (memberLesson) {
            const memberStudent = (allStudents || students).find(s => s.id === mid);
            const memberName = memberStudent ? memberStudent.name : mid;
            warnings.push(`${memberName} already has a lesson on ${newDay} (${memberLesson.isGroup ? memberLesson.groupName || "Group" : memberLesson.instrument})`);
          }
        }
      }
      // Specialist clash — check each member's class
      if (slot.type === "class") {
        const sStart = timeToMin(slot.start), sEnd = timeToMin(slot.end);
        for (const mid of memberIds) {
          const ms = (allStudents || students).find(s => s.id === mid);
          if (!ms || !ms.className) continue;
          const key = `${lesson.schoolId}|${ms.className}|${newDay}`;
          const specs = specLookupRef[key] || [];
          const match = specs.find(sp => sStart < sp.end && sEnd > sp.start);
          if (match) {} // specialist shown as purple tag, not a red warning
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
        {
          const conflict = lessonList.find(l => l.id !== lesson.id && l.teacherId === lesson.teacherId && l.day === newDay && l.start === slot.start);
          if (conflict) warnings.push(`${teacher.name} already has ${conflict.isGroup ? conflict.groupName || "Group" : conflict.studentName} at this time`);
        }
      }
      return warnings;
    }
    const student = (allStudents || students).find(s => s.id === lesson.studentId);
    if (!student) return [];
    const school = schools.find(s => s.id === lesson.schoolId);
    if (!school) return [];
    const warnings = [];
    const slotStart = timeToMin(slot.start);
    const slotEnd = timeToMin(slot.end);

    // Before/after school without opt-in (skip if notes specify a required time in this slot)
    const hints = student._noteHints || {};
    const hasRequiredHere = (hints.requiredTimes || []).some(function(rt) { return rt.day === newDay && rt.start === slot.start; });
    if (slot.type === "before_school" && !student.availableBefore && !hasRequiredHere) warnings.push("Student not available before school");
    if (slot.type === "after_school" && !student.availableAfter && !hasRequiredHere) warnings.push("Student not available after school");

    // Outside class only
    const isBreak = ["recess", "lunch"].includes(slot.type);
    const isBeforeAfter = ["before_school", "after_school"].includes(slot.type);
    if (student.outsideClassOnly && !isBreak && !isBeforeAfter) warnings.push("Student should only be scheduled outside class time");
    if (student.outsideClassPreferred && !isBreak && !isBeforeAfter && slot.type === "class") warnings.push("Student prefers outside class time");

    // Avoid times from notes
    if (hints.avoidTimes) {
      for (const at of hints.avoidTimes) {
        if (at.day === newDay) {
          const avStart = timeToMin(at.start);
          const avEnd = timeToMin(at.end);
          if (slotStart < avEnd && slotEnd > avStart) warnings.push(`Avoid time: ${at.day} ${at.start}–${at.end}`);
        }
      }
    }

    // Avoid days from notes
    if (hints.avoidDays && hints.avoidDays.includes(newDay)) warnings.push(`Student should avoid ${newDay}`);

    // Preferred days (soft — still warn)
    if (hints.preferredDays && hints.preferredDays.length > 0 && !hints.preferredDays.includes(newDay)) {
      warnings.push(`Preferred day${hints.preferredDays.length > 1 ? "s" : ""}: ${hints.preferredDays.join(", ")}`);
    }

    // Check teacher availability
    const _liveTeacherUnassigned = isLessonUnassigned(lesson, (allStudents || students));
    if (_liveTeacherUnassigned) {
      warnings.push("No teacher assigned — assign a teacher in student details");
    } else {
      const teacher = teachers.find(t => t.id === lesson.teacherId);
      if (teacher) {
        const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === newDay);
        if (!dayAvail) {
          warnings.push(`${teacher.name} not available at ${school.name} on ${newDay}`);
        } else if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) {
          warnings.push(`Outside ${teacher.name}'s hours (${dayAvail.start}–${dayAvail.end})`);
        }
      }
      // Check teacher double-booking (another lesson at the same time)
      {
        const conflict = lessonList.find(l => l.id !== lesson.id && l.teacherId === lesson.teacherId && l.day === newDay && l.start === slot.start);
        if (conflict) warnings.push(`${lesson.teacherName} already has ${conflict.studentName} at this time`);
      }
    }

    // Multi-lesson students: must have lessons on different days
    {
      const otherLessons = lessonList.filter(l => l.id !== lesson.id && l.day === newDay && (
        l.studentId === lesson.studentId ||
        (l.isGroup && l.studentIds && l.studentIds.includes(lesson.studentId))
      ));
      if (otherLessons.length > 0) {
        warnings.push(`${student.name} already has a lesson on ${newDay} (${otherLessons.map(l => l.isGroup ? l.groupName || "Group" : l.instrument).join(", ")})`);
      }
    }

    // Dual class-time pullout: warn if this slot is during class and the student already has
    // another class-time lesson on a different day (two class pullouts in the same week)
    if (slot.type === "class") {
      const otherClassLessons = lessonList.filter(l =>
        l.id !== lesson.id &&
        l.day !== newDay &&
        (l.studentId === lesson.studentId || (l.isGroup && l.studentIds && l.studentIds.includes(lesson.studentId)))
      );
      // Check if any of those other lessons are also in a class-time slot
      const school2 = schools.find(s => s.id === lesson.schoolId);
      if (school2 && otherClassLessons.length > 0) {
        const classTimeConflicts = otherClassLessons.filter(ol => {
          const olSlot = (school2.slots || []).find(sl => sl.start === ol.start);
          return olSlot && olSlot.type === "class";
        });
        if (classTimeConflicts.length > 0) {
          warnings.push(`${student.name} already has a lesson during class on ${classTimeConflicts[0].day}`);
        }
      }
    }

    // Specialist clash — any overlap between lesson slot and specialist time
    if (student.className) {
      const key = lesson.schoolId + "|" + student.className + "|" + newDay;
      const specs = specLookupRef[key] || [];
      const match = specs.find(sp => slotStart < sp.end && slotEnd > sp.start);
      if (match) {} // specialist shown as purple tag, not a red warning
    }

    return warnings;
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

  // Handle dropping an unscheduled card onto the grid
  const handleDropUnsched = (data, day, time) => {
    if (onPlaceUnsched) onPlaceUnsched(data, day, time);
  };

  // Wrap onMoveLesson to check specialist clash + constraints at destination
  const handleMoveLesson = (lessonId, newDay, newTime) => {
    if (!onMoveLesson || !timetable) return;
    const lesson = timetable.lessons.find(l => l.id === lessonId);
    if (!lesson) return;
    const school = schools.find(s => s.id === lesson.schoolId);
    const slot = school?.slots.find(s => s.start === newTime);
    if (!slot) return;
    onMoveLesson(lessonId, newDay, newTime);

    // Simulate the timetable after the move so all warning re-checks use the correct state
    const simulatedLessons = timetable.lessons.map(l =>
      l.id === lessonId ? { ...l, day: newDay, start: newTime, end: slot.end, slotId: slot.id } : l
    );

    const warnings = checkConstraints(lesson, newDay, slot, simulatedLessons);
    setConstraintWarnings(prev => {
      const next = { ...prev };
      if (warnings.length > 0) next[lessonId] = warnings;
      else delete next[lessonId];
      // Re-evaluate all other lessons that currently have warnings — they may now be clear
      for (const warnId of Object.keys(prev)) {
        if (warnId === lessonId) continue;
        const wl = timetable.lessons.find(l => l.id === warnId);
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
    // Auto-expand popout if there are warnings
    if (warnings.length > 0) {
      setExpandedWarnings(prev => { const next = new Set(prev); next.add(lessonId); return next; });
    } else {
      setExpandedWarnings(prev => { const next = new Set(prev); next.delete(lessonId); return next; });
    }
  };

  // Show all schools in tabs (so cleared schools can be regenerated)
  const schoolsWithLessons = timetable ? schools.filter(s => timetable.lessons.some(l => l.schoolId === s.id)) : [];
  const displaySchools = schools.length > 0 ? schools : [];
  useEffect(() => {
    if (displaySchools.length > 0 && (!selectedSchool || !displaySchools.find(s => s.id === selectedSchool))) {
      // Prefer first school with lessons, otherwise first school
      const firstWithLessons = displaySchools.find(s => schoolsWithLessons.some(sw => sw.id === s.id));
      setSelectedSchool((firstWithLessons || displaySchools[0]).id);
    }
  }, [timetable, schools]);

  if (!timetable) {
    return (
      <div>
        <PageTitle subtitle="Schedule a master timetable to view it here" pageColor={PAGE_COLORS.timetable}>Master Timetable</PageTitle>
        <div style={{ textAlign: "center", padding: "60px 20px", color: colors.textMuted }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.5 }}>📅</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: colors.textLight, marginBottom: 8 }}>No master timetable scheduled yet</div>
          <div style={{ fontSize: 14, marginBottom: 24, maxWidth: 400, margin: "0 auto 24px" }}>Set up your schools, students, and teachers, then hit Schedule Full Term.</div>
          {isScheduling ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: colors.textLight }}>
              <div style={{ width: 36, height: 36, border: `3px solid ${colors.accentLight}`, borderTopColor: colors.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
              <div style={{ fontSize: 13, fontWeight: 500 }}>Scheduling… this may take a moment</div>
            </div>
          ) : confirmGenerateEmpty ? (
            <div style={{ display: "inline-flex", flexDirection: "column", gap: 8, border: `2px solid ${colors.accent}`, borderRadius: 10, padding: "12px 16px", minWidth: 200 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>Schedule Full Term?</div>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn onClick={() => { setConfirmGenerateEmpty(false); setIsScheduling(true); if (onGenerate) onGenerate(); }} style={{ flex: 1, justifyContent: "center" }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmGenerateEmpty(false)} style={{ flex: 1, justifyContent: "center" }}>No</Btn>
              </div>
            </div>
          ) : (
            <>
              <Btn onClick={() => setConfirmGenerateEmpty(true)}>Schedule Full Term</Btn>
              {(() => {
                const issues = [];
                if (schools.length === 0) issues.push("No schools set up");
                else if (schools.every(s => !s.slots || s.slots.length === 0)) issues.push("No time slots defined on any school");
                const active = (allStudents || students).filter(s => s.status === "active");
                if (active.length === 0) {
                  const pending = (allStudents || students).filter(s => s.status === "pending" || s.status === "trial");
                  if (pending.length > 0) issues.push(`${pending.length} student${pending.length !== 1 ? "s" : ""} on waiting list — set status to Active first`);
                  else issues.push("No active students");
                }
                if (teachers.length === 0) issues.push("No teachers set up");
                if (issues.length === 0) return null;
                return (
                  <div style={{ marginTop: 12, fontSize: 12, color: colors.warning, maxWidth: 340, margin: "12px auto 0" }}>
                    {issues.map((issue, i) => <div key={i}>⚠ {issue}</div>)}
                  </div>
                );
              })()}
            </>
          )}
        </div>
      </div>
    );
  }

  const { lessons, unscheduled } = timetable;

  const schoolLessons = lessons.filter(l => l.schoolId === selectedSchool);
  let filteredLessons = schoolLessons;
  if (filterTeacher) filteredLessons = filteredLessons.filter(l => l.teacherId === filterTeacher);

  const schoolUnscheduled = unscheduled.filter(u => {
    const student = u.student;
    return student.schoolId === selectedSchool;
  });

  const currentSchool = schools.find(s => s.id === selectedSchool);
  // ── Drag overlay: precomputed per-slot warnings + specialist tags ──

  // Build grid data: day -> time slots -> lessons
  // Interleave break rows with lesson time rows
  // Priority: school-level breaks; if none, merge teacher-level breaks for this school
  // Build break lookup for inline display: check if a specific time+day is during a break
  // masterBreaks for this school — slot-specific break cards
  const schoolMasterBreaks = (masterBreaks || []).filter(b => b.schoolId === selectedSchool);
  const getBreakForCell = (time, day) =>
    schoolMasterBreaks.find(b => b.day === day && b.time === time) || null;

  // Build grid rows: all school slot times + school-level break start times + master break card times
  const schoolSlotTimes = currentSchool ? currentSchool.slots.map(s => s.start) : [];
  const schoolLevelBreakTimes = (currentSchool?.teacherBreaks || []).map(b => b.start);
  const allLessonTimes = [...new Set(filteredLessons.map(l => l.start))];
  const breakTimes = schoolMasterBreaks.map(b => b.time);
  const allTimes = [...new Set([...schoolSlotTimes, ...schoolLevelBreakTimes, ...allLessonTimes, ...breakTimes])].sort();
  const gridRows = allTimes.map(time => ({ type: "lesson", time }));

  // Teachers with lessons at this school
  const schoolTeachers = [...new Set(schoolLessons.map(l => l.teacherId))].map(tid => teachers.find(t => t.id === tid)).filter(Boolean);

  const handleExportSchool = () => {
    onExport(); // Opens export dialog for master timetable
  };

  return (
    <div onClick={() => { if (contextMenu) { setContextMenu(null); setMttAddSubmenu(null); setMttEmailSubmenu(null); setMttEmailLevel2(null); setMttDayHeaderSubmenu(null); setHoverNotes(false); } if (expandedWarnings.size > 0) setExpandedWarnings(new Set()); if (showVersionMenu) setShowVersionMenu(false); }}>
      {/* Right-click context menu */}
      {contextMenu && (
        <div ref={mttMenuRef} style={{ position: "fixed", ...(contextMenu.fromMissed ? { bottom: window.innerHeight - contextMenu.y + 4, top: "auto" } : (contextMenu.y + 160 > window.innerHeight ? { bottom: window.innerHeight - contextMenu.y + 4, top: "auto" } : { top: contextMenu.y })), left: clampMenuPos(contextMenu.x, contextMenu.y, 200, 0).left, zIndex: 9999, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 160 }}
          onClick={e => e.stopPropagation()}>
          {contextMenu.isDayHeader && contextMenu.isMtt ? (() => {
            const day = contextMenu.day;
            const activeDays = mttSelectedDays.size > 0 ? [...mttSelectedDays] : [day];
            const dayLessons = (timetable?.lessons || []).filter(l => activeDays.includes(l.day) && (!selectedSchool || l.schoolId === selectedSchool));
            const parentEmailSet = new Set();
            const parentRows = [];
            dayLessons.forEach(l => {
              const studentIds = l.isGroup ? (l.studentIds || []) : l.studentId ? [l.studentId] : [];
              studentIds.forEach(sid => {
                const st = (allStudents || students).find(s => s.id === sid);
                if (!st) return;
                (st.parents || []).forEach(p => {
                  if (p.email && !parentEmailSet.has(p.email)) { parentEmailSet.add(p.email); parentRows.push({ name: p.name || p.email, email: p.email }); }
                });
              });
            });
            const allParentEmails = [...parentEmailSet];
            const teacherEmailSet = new Set();
            const teacherRows = [];
            dayLessons.forEach(l => {
              const studentIds = l.isGroup ? (l.studentIds || []) : l.studentId ? [l.studentId] : [];
              studentIds.forEach(sid => {
                const st = (allStudents || students).find(s => s.id === sid);
                if (!st) return;
                const ct = getClassTeacher(st, contacts || []);
                if (ct && ct.email && !teacherEmailSet.has(ct.email)) { teacherEmailSet.add(ct.email); teacherRows.push({ name: ct.name || ct.email, email: ct.email }); }
              });
            });
            const allTeacherEmails = [...teacherEmailSet];
            const staffEmailSet = new Set();
            const staffRows = [];
            dayLessons.forEach(l => {
              const t = teachers.find(x => x.id === l.teacherId);
              if (t?.email && !staffEmailSet.has(t.email)) { staffEmailSet.add(t.email); staffRows.push({ name: t.name || t.email, email: t.email, color: t.color || null }); }
            });
            const allStaffEmails = [...staffEmailSet];
            const schoolSender = schools.find(s => s.id === selectedSchool)?.senderEmail || "";

            const subMenuW = 190;
            const menuRect = mttMenuRef.current ? mttMenuRef.current.getBoundingClientRect() : null;
            const menuRight = menuRect ? menuRect.right : contextMenu.x + 200;
            const menuLeft = menuRect ? menuRect.left : contextMenu.x;
            const subX = menuRight + subMenuW > window.innerWidth ? menuLeft - subMenuW : menuRight;

            const btn = (color) => ({ display: "flex", alignItems: "center", justifyContent: "flex-start", width: "100%", padding: "8px 14px", background: "none", border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color, fontWeight: 400 });
            const hov = (e) => e.currentTarget.style.background = colors.bg;
            const unhov = (e) => e.currentTarget.style.background = "none";

            const MttDaySubPanel = ({ type, rows, allEmails, color, multi }) => {
              if (mttDayHeaderSubmenu?.type !== type || !rows.length) return null;
              return (
                <div ref={mttDayHeaderSubRef}
                  style={{ position: "fixed", top: mttDayHeaderSubmenu.y, left: subX, zIndex: 10002, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, maxHeight: 300, overflowY: "auto", padding: "4px 0" }}>
                  {multi && <button onClick={() => { openCompose(allEmails, { from: schoolSender, triggerId: "wtt_day_header" }); setContextMenu(null); setMttDayHeaderSubmenu(null); }} style={btn(color)} onMouseEnter={hov} onMouseLeave={unhov}>Group</button>}
                  {multi && <button onClick={() => { openGmailSequential(allEmails, { from: schoolSender }); setContextMenu(null); setMttDayHeaderSubmenu(null); }} style={btn(color)} onMouseEnter={hov} onMouseLeave={unhov}>Individually</button>}
                  {multi && rows.length > 0 && <div style={{ height: 1, background: colors.borderLight, margin: "3px 8px" }} />}
                  {rows.map((r, i) => (
                    <button key={i} onClick={() => { openCompose([r.email], { from: schoolSender, triggerId: "wtt_day_header" }); setContextMenu(null); setMttDayHeaderSubmenu(null); }}
                      style={{ ...btn(colors.text) }}
                      onMouseEnter={e => { e.currentTarget.style.background = r.color ? r.color + "33" : colors.bg; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                      {r.color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.color, flexShrink: 0, display: "inline-block", marginRight: 6 }} />}
                      {r.name ? r.name.split(" ")[0] : r.email}
                    </button>
                  ))}
                </div>
              );
            };

            const mkMttEmailRow = (label, allEmails, rows, type, color) => {
              if (!allEmails.length) return null;
              const multi = allEmails.length > 1;
              return (
                <div style={{ position: "relative" }}>
                  <MttDaySubPanel type={type} rows={rows} allEmails={allEmails} color={color} multi={multi} />
                  {multi ? (
                    <button
                      onClick={() => { openCompose(allEmails, { from: schoolSender, triggerId: "wtt_day_header" }); setContextMenu(null); setMttDayHeaderSubmenu(null); }}
                      onMouseEnter={e => { hov(e); setMttDayHeaderSubmenu({ type, y: e.currentTarget.getBoundingClientRect().top }); }}
                      onMouseLeave={unhov}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color, fontFamily: "inherit", fontWeight: 600 }}>
                      <span>{label} ({allEmails.length})</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => { openCompose(allEmails, { from: schoolSender, triggerId: "wtt_day_header" }); setContextMenu(null); setMttDayHeaderSubmenu(null); }}
                      onMouseEnter={hov} onMouseLeave={unhov}
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
                {mkMttEmailRow("Parents", allParentEmails, parentRows, "parents", colors.accent)}
                {mkMttEmailRow("Class Teachers", allTeacherEmails, teacherRows, "teachers", colors.sidebarActive)}
                {mkMttEmailRow("Staff", allStaffEmails, staffRows, "staff", colors.textLight)}
              </div>
            );
          })() : contextMenu.isEmpty ? (
            <div style={{ padding: "6px 4px" }}>
              <div style={{ padding: "6px 10px", fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {contextMenu.day} {to12h(contextMenu.time)}
              </div>
              <button onClick={() => {
                if (setMasterBreaks) setMasterBreaks(prev => [...prev, { id: uid(), schoolId: contextMenu.schoolId, day: contextMenu.day, time: contextMenu.time }]);
                setContextMenu(null);
              }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: "#92400E", borderRadius: 6, fontFamily: "inherit" }}
                onMouseEnter={e => e.currentTarget.style.background = "#FFF7ED"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                ☕ Add break
              </button>
              {timetable && schoolUnscheduled && schoolUnscheduled.length > 0 && (() => {
                const cDay = contextMenu.day;
                const cTime = contextMenu.time;
                return (
                  <button onClick={() => {
                    let count = 0;
                    for (const u of schoolUnscheduled) {
                      const student = u.student;
                      if (!student) continue;
                      const instrumentName = u.instrument || student.instruments?.[0]?.name;
                      if (!instrumentName) continue;
                      const data = `unsched:${student.id}:${instrumentName}`;
                      handleDropUnsched(data, cDay, cTime);
                      count++;
                    }
                    setContextMenu(null); setMttAddSubmenu(null);
                  }}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", borderTop: `1px solid ${colors.borderLight}`, fontSize: 13, cursor: "pointer", color: colors.sidebarActive, fontFamily: "inherit", fontWeight: 600 }}
                    onMouseEnter={e => e.currentTarget.style.background = "#EFF6FF"}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}>
                    <span>＋ Add unscheduled</span>
                    <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 400 }}>{schoolUnscheduled.length}</span>
                  </button>
                );
              })()}
              {((pendingStudents || []).some(s => s.schoolId === contextMenu.schoolId && s.status === "pending") || (schoolUnscheduled || []).length > 0) && (() => {
                const sId = contextMenu.schoolId;
                const pendingRows = (pendingStudents || [])
                  .filter(s => s.schoolId === sId && s.status === "pending")
                  .flatMap(s => (s.instruments && s.instruments.length ? s.instruments : [{ name: "", teacherId: "" }]).map(inst => ({ ...s, _inst: inst })))
                  .filter(row => !(timetable && timetable.lessons && timetable.lessons.some(l => l.studentId === row.id && (l.instrument || "") === (row._inst.name || ""))));
                const subMenuW = 216;
                const menuRect = mttMenuRef.current ? mttMenuRef.current.getBoundingClientRect() : null;
                const menuRight = menuRect ? menuRect.right : contextMenu.x + 180;
                const menuLeft = menuRect ? menuRect.left : contextMenu.x;
                const subX = menuRight + subMenuW > window.innerWidth ? menuLeft - subMenuW : menuRight;
                const mkItemStyle = (fg) => ({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", borderTop: `1px solid ${colors.borderLight}`, fontSize: 13, cursor: "pointer", color: fg, borderRadius: 6, fontFamily: "inherit" });
                const SubPanel = ({ type, color, title, children }) => mttAddSubmenu && mttAddSubmenu.type === type ? (
                  <div ref={mttSubMenuRef} style={{ position: "fixed", ...clampMenuPos(subX, mttAddSubmenu.y, subMenuW, 280), zIndex: 10001, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, maxHeight: 280, overflowY: "auto" }}>
                    <div style={{ padding: "6px 12px", fontSize: 11, color: color, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${colors.borderLight}` }}>{title}</div>
                    {children}
                  </div>
                ) : null;
                return (
                  <div style={{ position: "relative" }}>
                    <SubPanel type="pending" color={colors.purple600} title="Add pending">
                      {[...pendingRows].sort((a, b) => (a.name || "").localeCompare(b.name || "") || (a._inst?.name || "").localeCompare(b._inst?.name || "")).map((row, ri) => (
                        <button key={row.id + (row._inst?.name || "") + ri} onClick={() => {
                          if (onSchedulePending) onSchedulePending(row.id, contextMenu.schoolId, contextMenu.day, contextMenu.time, row._inst?.name);
                          setContextMenu(null); setMttAddSubmenu(null);
                        }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit", textAlign: "left" }}
                          onMouseEnter={e => e.currentTarget.style.background = colors.purpleLight}
                          onMouseLeave={e => e.currentTarget.style.background = "none"}>
                          <span>{row.name}</span>
                          <span style={{ fontSize: 11, color: "#6B7280" }}>{row._inst?.name || ""}</span>
                        </button>
                      ))}
                    </SubPanel>
                    <button style={mkItemStyle(colors.purple600)}
                      onMouseEnter={e => { e.currentTarget.style.background = colors.purpleLight; const y = e.currentTarget.getBoundingClientRect().top; setMttAddSubmenu(prev => prev?.type === "pending" ? prev : { type: "pending", y }); }}
                      onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      <span>⏳ Add pending</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                    </button>
                <SubPanel type="unsched" color={colors.sidebarActive} title="Add unscheduled">
                  {(schoolUnscheduled || []).map((u, ui) => (
                    <button key={ui} onClick={() => {
                      const student = u.student;
                      if (!student) return;
                      const instrumentName = u.instrument || student.instruments?.[0]?.name;
                      if (!instrumentName) return;
                      handleDropUnsched(`unsched:${student.id}:${instrumentName}`, contextMenu.day, contextMenu.time);
                      setContextMenu(null); setMttAddSubmenu(null);
                    }}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}
                      onMouseEnter={e => e.currentTarget.style.background = "#EFF6FF"}
                      onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      <span>{u.student?.name}</span>
                      <span style={{ fontSize: 11, color: "#6B7280" }}>{(u.instrument || "") + (u.reason === "Unassigned" ? " — Unassigned" : "")}</span>
                    </button>
                  ))}
                </SubPanel>
                {(schoolUnscheduled || []).length > 0 && (
                  <button style={mkItemStyle(colors.sidebarActive)}
                    onMouseEnter={e => { e.currentTarget.style.background = "#EFF6FF"; const y = e.currentTarget.getBoundingClientRect().top; setMttAddSubmenu({ type: "unsched", y }); }}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}>
                    <span>＋ Add unscheduled</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                  </button>
                )}
                  </div>
                );
              })()}
            </div>
          ) : (
            <>
              <div style={{ padding: "6px 4px" }}>
                {/* ── Email buttons (MTT card) ── */}
                {(() => {
                  const allStu2 = allStudents || students;
                  let parentEmails = [];
                  let classTeacher = null;
                  if (contextMenu.isGroup) {
                    const lesson = timetable && timetable.lessons.find(l => l.id === contextMenu.lessonId);
                    const memberIds = (lesson && lesson.studentIds) || [];
                    const emailSet = new Set();
                    memberIds.forEach(mid => {
                      const st = allStu2.find(s => s.id === mid);
                      if (st) getParentEmails(st).forEach(e => emailSet.add(e));
                    });
                    parentEmails = [...emailSet];
                  } else {
                    const mttSt = allStu2.find(s => s.id === contextMenu.studentId);
                    if (mttSt) {
                      parentEmails = getParentEmails(mttSt);
                      classTeacher = getClassTeacher(mttSt, contacts || []);
                    }
                  }
                  const _mttLesson = timetable && timetable.lessons.find(l => l.id === contextMenu.lessonId);
                  const _mttSt = !contextMenu.isGroup && allStu2.find(s => s.id === contextMenu.studentId);
                  const _mttSchoolSender = schools.find(s => s.id === (_mttLesson?.schoolId || _mttSt?.schoolId))?.senderEmail || "";
                  const lessonTeacher = _mttLesson?.teacherId ? teachers.find(t => t.id === _mttLesson.teacherId) : null;
                  const lessonTeacherEmail = lessonTeacher?.email || null;
                  const lessonTeacherColor = lessonTeacher?.color || colors.sidebarActive;
                  const lessonTeacherFirst = lessonTeacher ? lessonTeacher.name.split(" ")[0] : null;
                  const specSubject = _mttLesson ? getLiveSpecialistTag(_mttLesson) : false;
                  const specSubjects = specSubject && typeof specSubject === "string" ? specSubject.split(", ") : [];
                  const specContact = specSubjects.length > 0 && _mttLesson ? (contacts || []).find(c =>
                    c.role === "Specialist Teacher" && c.schoolId === _mttLesson.schoolId && specSubjects.includes(c.className) && c.email
                  ) : null;
                  const _mttSchool = schools.find(s => s.id === (_mttLesson?.schoolId || _mttSt?.schoolId));
                  const _mttMergeCtx = {
                    student_name: preferredFirstName(_mttSt?.name || _mttLesson?.studentName || ""),
                    parent_name: preferredFirstName(_mttSt?.parents?.[0]?.name) || "there",
                    instrument: _mttLesson?.instrument || "",
                    day: _mttLesson?.day || "",
                    lesson_time: _mttLesson?.start || "",
                    week_label: "",
                    teacher_name: preferredFirstName(lessonTeacher?.name) || "",
                    school_name: _mttSchool?.name || "",
                    class_name: _mttSt?.className || "",
                    specialist_subject: specSubjects[0] || "",
                  };
                  const parentObjs = !contextMenu.isGroup && _mttSt ? (_mttSt.parents || []).filter(p => p.email) : [];
                  const groupParents = contextMenu.isGroup && _mttLesson
                    ? (() => {
                        const allStuRef = allStudents || students;
                        return (_mttLesson.studentIds || []).map(mid => {
                          const ms = allStuRef.find(s => s.id === mid);
                          if (!ms) return null;
                          const ps = (ms.parents || []).filter(p => p.email);
                          if (!ps.length) return null;
                          return { studentName: ms.name, studentFirst: ms.name.split(' ')[0], parents: ps };
                        }).filter(Boolean);
                      })() : [];
                  const allGroupParentEmails = [...new Set(groupParents.flatMap(g => g.parents.map(p => p.email)))];
                  const groupClassTeachers = contextMenu.isGroup && _mttLesson
                    ? (() => {
                        const allStuRef = allStudents || students;
                        const seen = new Set(); const result = [];
                        for (const mid of (_mttLesson.studentIds || [])) {
                          const ms = allStuRef.find(s => s.id === mid);
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

                  const menuRect = mttMenuRef.current ? mttMenuRef.current.getBoundingClientRect() : null;
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
                        onMouseEnter={e => { e.currentTarget.style.background = colors.bg; setMttEmailSubmenu({ y: e.currentTarget.getBoundingClientRect().top }); setMttEmailLevel2(null); }}
                        onMouseLeave={e => e.currentTarget.style.background = "none"}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit", fontWeight: 600 }}>
                        Email
                        <span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                      {mttEmailSubmenu && (
                        <div ref={mttSubMenuRef} style={{ position: "fixed", top: mttEmailSubmenu.y, left: subX, zIndex: 10001, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: emailSubW, padding: "4px 0" }}>

                          {/* Single parent */}
                          {parentObjs.length === 1 && (
                            <button onClick={() => { openCompose([parentObjs[0].email], { from: _mttSchoolSender, triggerId: "lesson_parent", mergeCtx: _mttMergeCtx }); setContextMenu(null); setMttEmailSubmenu(null); setMttEmailLevel2(null); }}
                              style={btn(colors.accent)} onMouseEnter={hov} onMouseLeave={unhov}>
                              {parentObjs[0].name ? parentObjs[0].name.split(" ")[0] : "Parent"}
                            </button>
                          )}
                          {/* Multiple parents — top item sends to all, hover reveals individuals */}
                          {parentObjs.length > 1 && (
                            <div style={{ position: "relative" }}>
                              <button
                                onClick={() => { openCompose(parentObjs.map(p => p.email), { from: _mttSchoolSender, triggerId: "lesson_parent", mergeCtx: _mttMergeCtx }); setContextMenu(null); setMttEmailSubmenu(null); setMttEmailLevel2(null); }}
                                onMouseEnter={e => { hov(e); setMttEmailLevel2({ type: "parents", y: e.currentTarget.getBoundingClientRect().top }); }}
                                onMouseLeave={unhov}
                                style={btnChev(colors.accent)}>
                                Parents
                                <span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                              </button>
                              {mttEmailLevel2?.type === "parents" && (
                                <div ref={mttLevel2Ref} style={{ ...subPanel, top: mttEmailLevel2.y, left: level2X }}>
                                  {parentObjs.map(p => (
                                    <button key={p.email} onClick={() => { openCompose([p.email], { from: _mttSchoolSender, triggerId: "lesson_parent", mergeCtx: _mttMergeCtx }); setContextMenu(null); setMttEmailSubmenu(null); setMttEmailLevel2(null); }}
                                      style={btn(colors.accent)} onMouseEnter={hov} onMouseLeave={unhov}>
                                      {p.name ? p.name.split(" ")[0] : p.email}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {/* Fallback parent email (no parent objects) */}
                          {parentEmails.length > 0 && parentObjs.length === 0 && !contextMenu.isGroup && (
                            <button onClick={() => { openCompose(parentEmails, { from: _mttSchoolSender, triggerId: "lesson_parent", mergeCtx: _mttMergeCtx }); setContextMenu(null); setMttEmailSubmenu(null); setMttEmailLevel2(null); }}
                              style={btn(colors.accent)} onMouseEnter={hov} onMouseLeave={unhov}>
                              Parent
                            </button>
                          )}
                          {/* Group lesson parents — top item sends to all, hover reveals per-student */}
                          {contextMenu.isGroup && groupParents.length > 0 && (
                            <div style={{ position: "relative" }}>
                              <button
                                onClick={() => { openCompose(allGroupParentEmails, { from: _mttSchoolSender, triggerId: "lesson_parent", mergeCtx: _mttMergeCtx }); setContextMenu(null); setMttEmailSubmenu(null); setMttEmailLevel2(null); }}
                                onMouseEnter={e => { hov(e); setMttEmailLevel2({ type: "groupParents", y: e.currentTarget.getBoundingClientRect().top }); }}
                                onMouseLeave={unhov}
                                style={btnChev(colors.accent)}>
                                All Parents
                                <span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                              </button>
                              {mttEmailLevel2?.type === "groupParents" && (
                                <div ref={mttLevel2Ref} style={{ ...subPanel, top: mttEmailLevel2.y, left: level2X, minWidth: emailSubW + 20 }}>
                                  {groupParents.map(g => (
                                    <button key={g.studentName}
                                      onClick={() => { openCompose(g.parents.map(p => p.email), { from: _mttSchoolSender, triggerId: "lesson_parent", mergeCtx: _mttMergeCtx }); setContextMenu(null); setMttEmailSubmenu(null); setMttEmailLevel2(null); }}
                                      style={btn(colors.accent)} onMouseEnter={hov} onMouseLeave={unhov}>
                                      {g.studentFirst}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Class / specialist teachers — top item sends to all if multiple */}
                          {schoolTeacherList.length === 1 && (
                            <button onClick={() => { openCompose([schoolTeacherList[0].email], { from: _mttSchoolSender, triggerId: "lesson_class_teacher", mergeCtx: _mttMergeCtx }); setContextMenu(null); setMttEmailSubmenu(null); setMttEmailLevel2(null); }}
                              style={btn(schoolTeacherList[0].color)} onMouseEnter={hov} onMouseLeave={unhov}>
                              {schoolTeacherList[0].name.split(" ")[0]}
                            </button>
                          )}
                          {schoolTeacherList.length > 1 && (
                            <div style={{ position: "relative" }}>
                              <button
                                onClick={() => { openCompose(schoolTeacherList.map(t => t.email), { from: _mttSchoolSender, triggerId: "lesson_class_teacher", mergeCtx: _mttMergeCtx }); setContextMenu(null); setMttEmailSubmenu(null); setMttEmailLevel2(null); }}
                                onMouseEnter={e => { hov(e); setMttEmailLevel2({ type: "teachers", y: e.currentTarget.getBoundingClientRect().top }); }}
                                onMouseLeave={unhov}
                                style={btnChev(colors.sidebarActive)}>
                                Teachers
                                <span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                              </button>
                              {mttEmailLevel2?.type === "teachers" && (
                                <div ref={mttLevel2Ref} style={{ ...subPanel, top: mttEmailLevel2.y, left: level2X }}>
                                  {schoolTeacherList.map(t => (
                                    <button key={t.email} onClick={() => { openCompose([t.email], { from: _mttSchoolSender, triggerId: "lesson_class_teacher", mergeCtx: _mttMergeCtx }); setContextMenu(null); setMttEmailSubmenu(null); setMttEmailLevel2(null); }}
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
                            <button onClick={() => { openCompose([lessonTeacherEmail], { from: "", triggerId: "lesson_music_teacher", mergeCtx: _mttMergeCtx }); setContextMenu(null); setMttEmailSubmenu(null); setMttEmailLevel2(null); }}
                              style={btn(lessonTeacherColor)} onMouseEnter={hov} onMouseLeave={unhov}>
                              {lessonTeacherFirst}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <button onClick={() => { if (onDeleteLesson) onDeleteLesson(contextMenu.lessonId); setContextMenu(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, borderRadius: 6, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#FEF2F2"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  🗑 Delete lesson
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <PageTitle subtitle={`${lessons.length} lessons · ${schoolsWithLessons.length} ${schoolsWithLessons.length === 1 ? "school" : "schools"}${unscheduled.length > 0 ? " · " + unscheduled.length + " unscheduled" : ""}`}
          navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          action={<>
            <Btn onClick={handleExportSchool} title="Export">{ExportIcon}</Btn>
            <Btn variant="secondary" onClick={() => onPrint && onPrint()} title="Print master timetable">🖨</Btn>
            {confirmClear ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#FEF2F2", borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap", marginTop: -1 }}>
                <span style={{ fontSize: 12, color: colors.danger, fontWeight: 500 }}>Clear all?</span>
                <Btn variant="danger" onClick={() => { onClear(); setConfirmClear(false); }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmClear(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
              </div>
            ) : (
              <Btn variant="danger" onClick={() => setConfirmClear(true)} title="Clear all" style={{ border: "none" }}>🗑</Btn>
            )}
            {confirmRegenerate ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#E9E4F0", borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap", marginTop: -1 }}>
                <span style={{ fontSize: 12, color: "#5B3F7A", fontWeight: 500 }}>Reschedule all?</span>
                <Btn variant="primary" onClick={() => { onGenerate(); setConfirmRegenerate(false); }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, background: "#5B3F7A", color: "#fff", border: "none" }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmRegenerate(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
              </div>
            ) : (
              <Btn variant="secondary" onClick={() => setConfirmRegenerate(true)} title="Reschedule" style={{ color: colors.sidebarActive, border: "none" }}>🔄</Btn>
            )}
            {onUndo && <Btn variant="secondary" onClick={onUndo} disabled={!undoCount} style={{ opacity: undoCount ? 1 : 0.4 }} title="Undo (Cmd+Z)">↩</Btn>}
            {onRedo && <Btn variant="secondary" onClick={onRedo} disabled={!redoCount} style={{ opacity: redoCount ? 1 : 0.4 }} title="Redo (Cmd+Shift+Z)">↪</Btn>}
          </>}
          pageColor={PAGE_COLORS.timetable}>
          Timetable
        </PageTitle>

      {/* School selector + conflict banner — sticky block */}
      <FrozenCard style={{ border: `2px solid ${colors.sidebarActive}` }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {displaySchools.map(s => {
            const count = lessons.filter(l => l.schoolId === s.id).length;
            const isActive = selectedSchool === s.id;
            return (
              <button key={s.id} onClick={() => { setSelectedSchool(s.id); setFilterTeacher(""); setConfirmClearSchool(false); }}
                style={{
                  height: 34, padding: "0 14px", borderRadius: 8, fontSize: 13, fontFamily: "inherit", cursor: "pointer", boxSizing: "border-box",
                  border: `2px solid ${isActive ? colors.sidebarActive : colors.border}`,
                  background: isActive ? colors.sidebarActive : colors.white,
                  color: isActive ? colors.white : colors.text, fontWeight: 600,
                  transition: "all 0.15s", display: "flex", alignItems: "center", gap: 8
                }}>
                <span>🏫 {s.name.replace(/Primary School/gi, "PS").replace(/primary school/gi, "PS")}</span>
                <span style={{
                  fontSize: 11, padding: "2px 0", borderRadius: 10, fontWeight: 600,
                  background: isActive ? "rgba(255,255,255,0.2)" : colors.borderLight,
                  color: isActive ? colors.white : colors.textMuted,
                  minWidth: 28, textAlign: "center", display: "inline-block"
                }}>{count}</span>
              </button>
            );
          })}
        </div>
      </FrozenCard>

      <ConflictBanner
        constraintWarnings={constraintWarnings}
        ackedConstraints={ackedConstraints}
        lessons={lessons}
        students={students}
        unscheduled={schoolUnscheduled}
        onAckAll={() => setAckedConstraints(prev => {
          const next = new Set(prev);
          Object.keys(constraintWarnings).forEach(id => next.add(id));
          return next;
        })}
      />

      {currentSchool && (
        <>
          {/* Toolbar */}
          <Card style={{ marginBottom: 16, padding: 14 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select value={filterTeacher} onChange={e => setFilterTeacher(e.target.value)}
                style={{ height: 34, padding: "0 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }}>
                <option value="">All Teachers</option>
                {schoolTeachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <div style={{ display: "flex", gap: 4 }}>
                {["grid", "list"].map(m => (
                  <button key={m} onClick={() => setViewMode(m)} style={{
                    height: 34, padding: "0 14px", borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer", boxSizing: "border-box",
                    border: `1px solid ${viewMode === m ? colors.accent : colors.border}`,
                    background: viewMode === m ? colors.accentLight : colors.white,
                    color: viewMode === m ? colors.accentDark : colors.textLight, fontWeight: 500,
                    textTransform: "capitalize"
                  }}>
                    {m}
                  </button>
                ))}
              </div>
              <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                {/* Save/Load versions */}
                <div style={{ position: "relative" }}>
                  {showSavePrompt ? (
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input value={versionName} onChange={e => setVersionName(e.target.value)} 
                        onKeyDown={e => { if (e.key === "Enter") saveVersion(versionName); if (e.key === "Escape") setShowSavePrompt(false); }}
                        placeholder="Version name..."
                        autoFocus
                        style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", width: 140 }} />
                      <Btn variant="success" onClick={() => saveVersion(versionName)} style={{ fontSize: 11, padding: "4px 8px" }}>✓</Btn>
                      <Btn variant="ghost" onClick={() => setShowSavePrompt(false)} style={{ fontSize: 11, padding: "4px 6px" }}>✕</Btn>
                    </div>
                  ) : (
                    <Btn variant="secondary" onClick={() => { setVersionName(lastVersionNameRef.current[selectedSchool] || ""); setShowSavePrompt(true); }} style={{ fontSize: 12 }}>💾</Btn>
                  )}
                </div>
                {schoolVersions.length > 0 && (
                  <div style={{ position: "relative" }}>
                    <Btn variant="secondary" onClick={() => setShowVersionMenu(!showVersionMenu)} style={{ fontSize: 12 }}>
                      📂 {schoolVersions.length}
                    </Btn>
                    {showVersionMenu && (
                      <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 240, zIndex: 50, maxHeight: 300, overflowY: "auto" }}>
                        <div style={{ padding: "8px 12px", fontSize: 11, color: colors.textMuted, borderBottom: `1px solid ${colors.borderLight}`, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                          Saved versions
                        </div>
                        {schoolVersions.sort((a, b) => new Date(b.date) - new Date(a.date)).map(v => (
                          <div key={v.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: `1px solid ${colors.borderLight}`, fontSize: 12 }}
                            onMouseEnter={e => e.currentTarget.style.background = colors.bg} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                            <div onClick={() => loadVersion(v)} style={{ cursor: "pointer", flex: 1 }}>
                              <div style={{ fontWeight: 600, color: colors.text }}>{v.name}</div>
                              <div style={{ fontSize: 11, color: colors.textMuted }}>{new Date(v.date).toLocaleDateString()} · {v.lessons.length} lessons</div>
                            </div>
                            <button onClick={e => { e.stopPropagation(); deleteVersion(v.id); }}
                              style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 14, padding: "2px 6px" }}
                              title="Delete version">×</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {confirmClearSchool ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#FEF2F2", borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap", marginTop: -1 }}>
                    <span style={{ fontSize: 12, color: colors.danger, fontWeight: 500, whiteSpace: "nowrap" }}>Clear?</span>
                    <Btn variant="danger" onClick={() => { onClearSchool(selectedSchool); setConfirmClearSchool(false); }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>Yes</Btn>
                    <Btn variant="secondary" onClick={() => setConfirmClearSchool(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
                  </div>
                ) : (
                  <Btn variant="danger" onClick={() => setConfirmClearSchool(true)} title="Clear this school" style={{ border: "none" }}>🗑</Btn>
                )}
                {confirmRegenerateSchool ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", background: "#E9E4F0", borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap", marginTop: -1 }}>
                    <span style={{ fontSize: 12, color: "#5B3F7A", fontWeight: 500, whiteSpace: "nowrap" }}>Reschedule?</span>
                    <Btn variant="primary" onClick={() => { onGenerateSchool(selectedSchool); setConfirmRegenerateSchool(false); }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, background: "#5B3F7A", color: "#fff", border: "none" }}>Yes</Btn>
                    <Btn variant="secondary" onClick={() => setConfirmRegenerateSchool(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
                  </div>
                ) : (
                  <Btn variant="secondary" onClick={() => setConfirmRegenerateSchool(true)} title="Reschedule this school" style={{ color: "#5B3F7A", border: "none" }}>🔄</Btn>
                )}
              </div>
            </div>
          </Card>
          {/* Grid View */}
          {viewMode === "grid" && (
            <div ref={gridRefCb} onScroll={handleGridScroll} onClick={() => { if (mttSelectedDays.size > 0) setMttSelectedDays(new Set()); }} style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 200px)", border: `1px solid ${colors.border}`, borderRadius: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: `50px repeat(${DAYS.length}, 1fr)`, gap: 1, background: colors.border }}>
                {/* Header row — sticky */}
                <div style={{ background: colors.sidebarActive, color: colors.white, padding: "12px 8px", fontSize: 11, fontWeight: 600, textAlign: "center", position: "sticky", top: 0, zIndex: 10 }}>Time</div>
                {DAYS.map(d => {
                  const daySelected = mttSelectedDays.has(d);
                  return (
                    <div key={d}
                      onClick={e => { e.stopPropagation(); setMttSelectedDays(prev => { const next = new Set(prev); if (next.has(d)) next.delete(d); else next.add(d); return next; }); }}
                      onContextMenu={e => { e.preventDefault(); setMttEmailSubmenu(null); setMttEmailLevel2(null); setMttDayHeaderSubmenu(null); setContextMenu({ x: e.clientX, y: e.clientY, isDayHeader: true, isMtt: true, day: d, schoolId: selectedSchool }); }}
                      style={{ background: daySelected ? colors.accent : colors.sidebarActive, color: colors.white, padding: "12px 8px", fontSize: 13, fontWeight: 600, textAlign: "center", position: "sticky", top: 0, zIndex: 10, cursor: "pointer", userSelect: "none", transition: "background 0.15s" }}>{d}</div>
                  );
                })}

                {/* Time rows — breaks shown inline per-cell */}
                {gridRows.map((row, ri) => {
                  // Check if this row is a school-level break:
                  //   (a) slot typed as recess/lunch, or (b) falls within school.teacherBreaks ranges
                  const breakSlot = currentSchool?.slots.find(s => s.start === row.time);
                  const slotType = breakSlot?.type;
                  const schoolBreakMatch = (currentSchool?.teacherBreaks || []).find(b => {
                    const tMin = timeToMin(row.time);
                    return tMin >= timeToMin(b.start) && tMin < timeToMin(b.end);
                  });
                  // Break bands only for actual teacher break ranges, not just slot type.
                  // Slot types recess/lunch just mean the class is at break — lessons can still occur.
                  const isSchoolBreakRow = !!schoolBreakMatch;
                  const isSlotTypeBreak = slotType === "recess" || slotType === "lunch";
                  const breakLabel = "Break";
                  const breakTimeRange = schoolBreakMatch
                    ? toTimeLabel(schoolBreakMatch.start) + "–" + toTimeLabel(schoolBreakMatch.end)
                    : toTimeLabel(row.time);

                  // Check if any lessons are scheduled in this break row
                  const breakRowLessons = isSchoolBreakRow ? filteredLessons.filter(l => l.start === row.time) : [];

                  if (isSchoolBreakRow && breakRowLessons.length === 0) {
                    // Render as a single spanning cell
                    return (
                      <React.Fragment key={`row-${row.time}`}>
                        <div style={{ background: colors.sidebarActive, padding: "8px 2px", fontSize: 11, fontWeight: 600, color: colors.white, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {toTimeLabel(row.time)}
                        </div>
                        <div style={{
                          gridColumn: `2 / -1`,
                          background: "#FFF7ED",
                          padding: "8px", minHeight: 36,
                          display: "flex", alignItems: "center", justifyContent: "center"
                        }}>
                          <span style={{ fontWeight: 600, color: "#92400E", fontSize: 12 }}>☕ {breakLabel} {breakTimeRange}</span>
                        </div>
                      </React.Fragment>
                    );
                  }

                  return (
                  <React.Fragment key={`row-${row.time}`}>
                    <div style={{ background: colors.sidebarActive, padding: "8px 2px", fontSize: 11, fontWeight: 600, color: colors.white, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 1 }}>
                      {toTimeLabel(row.time)}
                      {isSlotTypeBreak && <span style={{ fontSize: 9, opacity: 0.7 }}>☕</span>}
                    </div>
                    {DAYS.map(day => {
                      const cellBreak = getBreakForCell(row.time, day);
                      const cellLessons = filteredLessons.filter(l => l.day === day && l.start === row.time);
                      const isDropTarget = dragOver && dragOver.day === day && dragOver.time === row.time;
                      return (
                        <div key={`${day}-${row.time}`}
                          onContextMenu={e => {
                            const cellHasContent = filteredLessons.some(l => l.day === day && l.start === row.time) || getBreakForCell(row.time, day);
                            if (!cellHasContent) { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, isEmpty: true, day, time: row.time, schoolId: selectedSchool }); }
                          }}
                          onDragOver={e => {
                            e.preventDefault(); e.dataTransfer.dropEffect = "move";
                            setDragOver({ day, time: row.time });
                            if (draggingId && currentSchool) {
                              const ck = day + "|" + row.time + "|" + draggingId;
                              if (!dragCache.current[ck]) {
                                try {
                                  const sl = (currentSchool.slots || []).find(s => s.start === row.time);
                                  if (sl) {
                                    let dl = null; let st = null;
                                    if (!draggingId.includes(":")) {
                                      dl = (timetable ? timetable.lessons : []).find(l => l.id === draggingId);
                                      st = dl ? (allStudents || students).find(s => s.id === dl.studentId) : null;
                                    } else if (draggingId.startsWith("pending:") || draggingId.startsWith("unsched:")) {
                                      const parts = draggingId.split(":");
                                      const sid = parts[1]; const inst = parts.slice(2).join(":");
                                      st = (allStudents || students).find(s => s.id === sid);
                                      if (st) dl = { studentId: sid, studentName: st.name, instrument: inst, schoolId: st.schoolId, day, start: sl.start, end: sl.end, isGroup: false };
                                    }
                                    if (dl && sl) {
                                      const raw = checkConstraints(dl, day, sl);
                                      const warns = raw.filter(w => !(w.includes("already has") && w.includes("at this time")));
                                      const specs = st && st.className ? (specLookupRef[(dl.schoolId || st.schoolId) + "|" + st.className + "|" + day] || []).filter(sp => { const sS = timeToMin(sl.start), sE = timeToMin(sl.end || sl.start); return sS < sp.end && sE > sp.start; }).map(sp => sp.subject || "Specialist") : [];
                                      dragCache.current[ck] = { warns, specs };
                                    } else { dragCache.current[ck] = { warns: [], specs: [] }; }
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
                          if (lid.startsWith("unsched:")) {
                            handleDropUnsched(lid, day, row.time);
                          } else if (lid.startsWith("pending:")) {
                            if (onPlacePending) onPlacePending(lid, day, row.time);
                          } else if (lid.startsWith("mbreak:")) {
                            const breakId = lid.split(":")[1];
                            if (setMasterBreaks) {
                              setMasterBreaks(prev => prev.map(b => b.id !== breakId ? b : { ...b, day, time: row.time }));
                            }
                          } else if (onMoveLesson) {
                            handleMoveLesson(lid, day, row.time);
                          }
                        }}
                          style={{
                            background: isDropTarget ? colors.accentLight : cellBreak ? "#FFF7ED" : colors.white,
                            padding: 4, minHeight: 32, display: "flex", flexDirection: "column", gap: 3,
                            outline: isDropTarget ? `2px dashed ${colors.accent}` : "none",
                            transition: "background 0.15s, outline 0.15s"
                          }}
                        >
                          {cellBreak && (
                            <div
                              draggable
                              onDragStart={e => {
                                e.dataTransfer.setData("text/plain", `mbreak:${cellBreak.id}`);
                                e.dataTransfer.effectAllowed = "move";
                                setDraggingId(`mbreak:${cellBreak.id}`);
                              }}
                              onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
                              style={{ padding: "6px 10px", borderRadius: 6, fontSize: 13, background: "#FED7AA40", borderLeft: "3px solid #D97706", textAlign: "center", cursor: "grab", position: "relative", opacity: draggingId === `mbreak:${cellBreak.id}` ? 0.4 : 1, transition: "opacity 0.15s" }}>
                              <span style={{ fontWeight: 600, color: "#92400E" }}>☕ Break</span>
                              {setMasterBreaks && (
                                <span
                                  onClick={e => { e.stopPropagation(); setMasterBreaks(prev => prev.filter(b => b.id !== cellBreak.id)); }}
                                  style={{ position: "absolute", top: 1, right: 3, fontSize: 10, color: "#DC2626", cursor: "pointer", lineHeight: 1, fontWeight: 700 }}
                                  title="Remove break">✕</span>
                              )}
                            </div>
                          )}
                          {cellLessons.map(l => {
                            const cWarnings = constraintWarnings[l.id] || [];
                            const hasConstraintIssue = cWarnings.length > 0 && !ackedConstraints.has(l.id);
                            const constraintAcked = cWarnings.length > 0 && ackedConstraints.has(l.id);
                            const showRed = hasConstraintIssue;
                            const hasAckedWarning = constraintAcked;
                            const isExpanded = expandedWarnings.has(l.id);
                            return (
                            <div key={l.id} draggable
                              onDragStart={e => { e.dataTransfer.setData("text/plain", l.id); e.dataTransfer.effectAllowed = "move"; setDraggingId(l.id); setExpandedWarnings(new Set()); dragCache.current = {}; }}
                              onDragEnd={() => { setDraggingId(null); setDragOver(null); hideHoverPanel(); dragCache.current = {}; }}
                              onContextMenu={e => { e.preventDefault(); setMttEmailSubmenu(null); setMttEmailLevel2(null); setContextMenu({ x: e.clientX, y: e.clientY, lessonId: l.id, studentId: l.studentId, isGroup: l.isGroup, lessonName: l.isGroup && l.studentNames ? `${l.studentNames.join(", ")} — ${l.instrument}` : `${l.studentName} — ${l.instrument}` }); }}
                              onDoubleClick={() => { if (l.isGroup && onViewGroup) onViewGroup(l.groupId); else if (!l.isGroup && onViewStudent) onViewStudent(l.studentId); }}
                              onClick={e => { if (showRed && !isExpanded) { e.stopPropagation(); setExpandedWarnings(prev => { const next = new Set(prev); next.add(l.id); return next; }); } else if (isExpanded || showRed) { e.stopPropagation(); setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); return next; }); setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; }); } }}
                              style={{
                                padding: "6px 10px", borderRadius: 6, fontSize: 13, position: "relative",
                                background: showRed ? "#FEF2F2" : getInstColor(l.instrument, l.isGroup) + "18",
                                borderLeft: `3px solid ${showRed ? colors.danger : getInstColor(l.instrument, l.isGroup)}`,
                                lineHeight: 1.4, cursor: "grab",
                                opacity: draggingId === l.id ? 0.4 : 1,
                                transition: "opacity 0.15s",
                              }} title={l.isGroup ? l.groupName || l.studentName : undefined}>
                              {showRed && (
                                <span onClick={e => { e.stopPropagation(); setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); return next; }); setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; }); }}
                                  style={{ position: "absolute", bottom: 2, right: 5, cursor: "pointer", fontSize: 13, lineHeight: 1, color: colors.success, fontWeight: 700 }}
                                  title="Confirm this time">✓</span>
                              )}
                              {hasAckedWarning && !showRed && (
                                <span onClick={e => { e.stopPropagation(); setExpandedWarnings(prev => { const next = new Set(prev); if (next.has(l.id)) next.delete(l.id); else next.add(l.id); return next; }); }}
                                  style={{ position: "absolute", bottom: 2, right: 5, cursor: "pointer", fontSize: 11, lineHeight: 1, color: colors.danger, fontWeight: 700, opacity: 0.6 }}
                                  title="Click to view warnings">⚠</span>
                              )}
                              {(() => {
                                const _st = (allStudents || students).find(s => s.id === l.studentId);
                                if (!_st || !_st.notes || l.isGroup) return null;
                                return (
                                  <span
                                    onClick={e => e.stopPropagation()}
                                    onMouseEnter={e => { e.stopPropagation(); setHoverNotes({ text: _st.notes, x: e.clientX, y: e.clientY }); }}
                                    onMouseMove={e => setHoverNotes(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : prev)}
                                    onMouseLeave={() => setHoverNotes(null)}
                                    style={{ position: "absolute", top: 3, right: 5, fontSize: 11, lineHeight: 1, color: colors.textMuted, cursor: "default", userSelect: "none" }}>
                                    📝
                                  </span>
                                );
                              })()}
                              <div style={{ fontWeight: 600, color: colors.text }}>{l.isGroup ? "👥 " : ""}{l.isGroup && l.studentNames ? (() => { const allStu = allStudents || students; const names = groupDisplayName(l); const classes = (l.studentIds || []).map(sid => { const ms = allStu.find(s => s.id === sid); return ms?.className || ""; }).filter(Boolean); const uniqueClasses = [...new Set(classes)]; const classSuffix = uniqueClasses.length > 0 ? " — " + (uniqueClasses.length === 1 ? uniqueClasses[0] : classes.join(", ")) : ""; return names + classSuffix; })() : l.studentName + (() => { const st = (allStudents || students).find(s => s.id === l.studentId); return st?.className ? " · " + st.className : ""; })()}</div>
                              {(() => { const _tn = getLiveTeacherName(l, allStudents || students, teachers); const _unassigned = isLessonUnassigned(l, allStudents || students); return <div style={{ color: _unassigned ? colors.danger : colors.textLight }}>{l.instrument ? `${l.instrument} · ` : ""}{_unassigned ? "Unassigned" : _tn.split(" ")[0]}</div>; })()}
                              {(() => { const ds = getLiveSpecialistTag(l); return ds && draggingId !== l.id ? <div style={{ color: colors.specialistTag, fontSize: 10, fontWeight: 600 }}>during {typeof ds === "string" ? ds : "specialist"}</div> : null; })()}
                              {l.noteMismatch && <div style={{ color: "#D97706", fontSize: 10, fontWeight: 600 }} title={l.noteMismatch}>⚠ not at requested time</div>}
                              {isExpanded && (
                                <div style={{ position: "absolute", left: -3, right: 0, top: "100%", marginTop: 2, padding: "6px 8px", background: "#FEF2F2", border: `1px solid ${colors.danger}30`, borderRadius: 6, fontSize: 10, lineHeight: 1.4, zIndex: 20, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
                                  {cWarnings.map((w, wi) => (
                                    <div key={wi} style={{ color: colors.danger, fontWeight: 500 }}>⚠ {w}</div>
                                  ))}
                                </div>
                              )}
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
          )}

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

          {/* List View */}
          {viewMode === "list" && (() => {
            const columns = [
              { key: "day", label: "Day", sortFn: (a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) },
              { key: "time", label: "Time", sortFn: (a, b) => a.start.localeCompare(b.start) },
              { key: "student", label: "Student", sortFn: (a, b) => (a.isGroup && a.studentNames ? a.studentNames.join(", ") : a.studentName).localeCompare(b.isGroup && b.studentNames ? b.studentNames.join(", ") : b.studentName) },
              { key: "class", label: "Class", sortFn: (a, b) => {
                const sa = (students.find(s => s.id === a.studentId) || {}).className || "";
                const sb = (students.find(s => s.id === b.studentId) || {}).className || "";
                return sa.localeCompare(sb);
              }},
              { key: "teacher", label: "Teacher", sortFn: (a, b) => a.teacherName.localeCompare(b.teacherName) },
              { key: "instrument", label: "Instrument", sortFn: (a, b) => (a.instrument || "").localeCompare(b.instrument || "") },
            ];
            const sortKey = viewState?.listSortKey || "day";
            const sortDir = viewState?.listSortDir || "asc";
            const col = columns.find(c => c.key === sortKey) || columns[0];
            const sorted = [...filteredLessons].sort((a, b) => {
              let r = col.sortFn(a, b);
              // Secondary sort: day then time for non-day/time columns
              if (r === 0 && sortKey !== "day") r = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
              if (r === 0 && sortKey !== "time") r = a.start.localeCompare(b.start);
              return sortDir === "desc" ? -r : r;
            });
            const toggleSort = (key) => {
              if (sortKey === key) {
                setViewState(prev => ({ ...prev, listSortDir: sortDir === "asc" ? "desc" : "asc" }));
              } else {
                setViewState(prev => ({ ...prev, listSortKey: key, listSortDir: "asc" }));
              }
            };
            return (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: colors.bg, borderBottom: `1px solid ${colors.border}` }}>
                    {columns.map(c => (
                      <th key={c.key} onClick={() => toggleSort(c.key)} style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 600, color: sortKey === c.key ? colors.sidebarActive : colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", userSelect: "none" }}>
                        {c.label} {sortKey === c.key ? (sortDir === "asc" ? "▲" : "▼") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(l => {
                    const student = students.find(s => s.id === l.studentId);
                    return (
                      <tr key={l.id} style={{ borderBottom: `1px solid ${colors.borderLight}` }}>
                        <td style={{ padding: "8px 14px" }}>{l.day}</td>
                        <td style={{ padding: "8px 14px", color: colors.textLight }}>{toTimeLabel(l.start)}</td>
                        <td style={{ padding: "8px 14px", fontWeight: 500 }}>{l.isGroup ? "👥 " : ""}{l.isGroup ? groupDisplayName(l) : l.studentName}</td>
                        <td style={{ padding: "8px 14px", color: colors.textLight }}>{student?.className || ""}</td>
                        <td style={{ padding: "8px 14px" }}>{l.teacherName}</td>
                        <td style={{ padding: "8px 14px" }}><Tag color={getInstColor(l.instrument, l.isGroup)}>{l.instrument}</Tag></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
            );
          })()}

          {/* Unscheduled area — always visible, accepts drops from grid */}
          {(() => {
            const hasItems = schoolUnscheduled.length > 0;
            return (
              <Card style={{ marginTop: 20, minHeight: 110,
                background: unschedDragOver ? "rgba(220,38,38,0.06)" : hasItems ? "#FEF6F6" : colors.bg,
                borderColor: unschedDragOver ? colors.danger : hasItems ? "#FCC" : colors.border,
                transition: "background 0.15s, border-color 0.15s",
                border: unschedDragOver ? `2px dashed ${colors.danger}` : undefined
              }}
                onDragOver={e => { if (draggingId && !draggingId.startsWith("unsched:")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setUnschedDragOver(true); } }}
                onDragLeave={() => setUnschedDragOver(false)}
                onDrop={e => {
                  e.preventDefault(); setUnschedDragOver(false);
                  const raw = e.dataTransfer.getData("text/plain");
                  if (!raw || raw.startsWith("unsched:")) return;
                  // lessonId being dragged back to unscheduled — remove from timetable
                  const lessonId = raw;
                  if (onDeleteLesson) onDeleteLesson(lessonId);
                  setDraggingId(null); setDragOver(null);
                }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: hasItems ? colors.danger : colors.textMuted, marginBottom: hasItems ? 4 : 0, display: "flex", alignItems: "center", gap: 6 }}>
                  {hasItems ? "⚠ " : ""}Unscheduled{hasItems ? ` at ${currentSchool?.name} (${schoolUnscheduled.length})` : " — drag a lesson here to remove it from the timetable"}
                </div>
                {hasItems && <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 10 }}>Drag a card into the timetable grid to place it, or use 📌 Place</div>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minHeight: hasItems ? undefined : 36 }}>
                  {schoolUnscheduled.map((u, i) => (
                    <div key={i} draggable
                      onDragStart={e => { e.dataTransfer.setData("text/plain", `unsched:${u.student.id}:${u.instrument || u.student.instruments[0]?.name}`); e.dataTransfer.effectAllowed = "move"; setDraggingId(`unsched:${i}`); }}
                      onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
                      style={{
                        padding: "6px 10px", background: colors.white, borderRadius: 8, fontSize: 12,
                        border: `1px solid ${colors.danger}40`, borderLeft: `3px solid ${colors.danger}`,
                        cursor: "grab", opacity: draggingId === `unsched:${i}` ? 0.4 : 1,
                        transition: "opacity 0.15s", maxWidth: 280
                      }}>
                      <div style={{ fontWeight: 600 }}>{u.student.name} — {(u.instrument || u.student.instruments[0]?.name) + (u.reason === "Unassigned" ? " — Unassigned" : "")}</div>
                      {u.reason && u.reason !== "Unassigned" && <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>{u.reason}</div>}
                    </div>
                  ))}
                  {!hasItems && unschedDragOver && (
                    <div style={{ fontSize: 12, color: colors.danger, fontStyle: "italic" }}>Drop to remove from timetable</div>
                  )}
                </div>
              </Card>
            );
          })()}

          {/* Pending (waiting list) panel — drag cards into the timetable grid to schedule */}
          {(() => {
            const PENDING_PURPLE = "#5B21B6";
            const PENDING_PURPLE_LIGHT = "#EDE9F6";
            const PENDING_PURPLE_BORDER = "#C4B5FD";
            const schoolPending = (pendingStudents || [])
              .filter(s => s.schoolId === selectedSchool)
              .flatMap(s =>
                (s.instruments && s.instruments.length > 0 ? s.instruments : [{ name: "", teacherId: "" }])
                  .filter(inst => !inst.isGroup)
                  .filter(inst => !(timetable && timetable.lessons && timetable.lessons.some(l => l.studentId === s.id && l.instrument === inst.name)))
                  .map(inst => ({ student: s, instrument: inst.name, teacherName: teachers.find(t => t.id === inst.teacherId)?.name || "" }))
              );
            if (schoolPending.length === 0) return null;
            return (
              <Card style={{ marginTop: 12, background: PENDING_PURPLE_LIGHT, borderColor: PENDING_PURPLE_BORDER }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: PENDING_PURPLE, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                  ⏳ Waiting List — {currentSchool?.name} ({schoolPending.length})
                </div>
                <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 10 }}>Drag a card into the timetable grid to schedule and activate the student</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {schoolPending.map((row, i) => {
                    const dragId = `pending:${row.student.id}:${row.instrument}`;
                    const instColor = getInstColor(row.instrument, false);
                    return (
                      <div key={row.student.id + row.instrument} draggable
                        onDragStart={e => { e.dataTransfer.setData("text/plain", dragId); e.dataTransfer.effectAllowed = "move"; setDraggingId(dragId); }}
                        onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
                        style={{
                          padding: "6px 10px", background: colors.white, borderRadius: 8, fontSize: 12,
                          border: `1px solid ${PENDING_PURPLE}40`, borderLeft: `3px solid ${instColor}`,
                          cursor: "grab", opacity: draggingId === dragId ? 0.4 : 1,
                          transition: "opacity 0.15s", minWidth: 140, maxWidth: 240
                        }}>
                        <div style={{ fontWeight: 600, color: colors.text }}>{row.student.name}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                          <Tag color={instColor}>{row.instrument || "No instrument"}</Tag>
                        </div>
                        {row.teacherName && <div style={{ fontSize: 10, color: colors.textMuted, marginTop: 2 }}>{row.teacherName}</div>}
                      </div>
                    );
                  })}
                </div>
              </Card>
            );
          })()}
        </>
      )}
    </div>
  );
}

// ============================================================
