// ============================================================
// WeeklyAdjustments.js
// ============================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Printer, Trash2, RefreshCw, Undo2, Redo2, Save, FolderOpen, Coffee, Plus, Clock, Users, Check, X, AlertTriangle, ChevronRight, ChevronUp, ChevronDown, Send, Music, Guitar, Mail, RotateCcw, Building2, StickyNote, Download } from "lucide-react";
import { DAYS, STORAGE_KEYS, instruments_colors, HEADER_HEIGHT, BAND_COLOR } from "../constants";
import { useTheme } from "../context/ThemeContext";
import { uid, timeToMin, toTimeLabel, to12h, melbourneNow, melbourneToday, melbourneDayName, toLocalDateStr, getCurrentWeekMonday, getTermWeekLabel, _getMondayOf, getParentEmails, openCompose, openGmailSequential, groupDisplayName, bandDisplayName, getLiveTeacherName, getLiveTeacherId, isLessonUnassigned, getInstColor, clampMenuPos, getClassTeacher, getSchoolAcronym } from "../utils/helpers";
import { loadData, saveData, saveStudents } from "../utils/backup";
import { computeTermWeekNum, isDayPast6pm } from "../utils/tallyHelpers";
import { getMissedEntries, findOpenCatchups, getOpenCatchupRows } from "../utils/tallyDerive";
import { getTerms, getCurrentTerm, getTermWeeks } from "../utils/termWeeks";
import { getMissedReasonLabel } from "../utils/missedReasonLabels";
import { INTR_DISPLAY_TYPE } from "../utils/eventTypes";
import { anthropicFetch, getAnthropicHeaders } from "../utils/api";
import { getUserTemplates, applyMergeCtx, preferredFirstName, getEmailTemplates, resolveTemplate } from "../utils/emailTemplates";
import { generateWeeklyTimetable, buildWeeklyAIPrompt, printWeeklyTimetable, classMatchesInterruption } from "../data/weeklyTimetableGenerator";
import { generateExportHtml, electronPrintToPdf, buildExportFilename } from "../data/exportHelpers";
import { Card, PageTitle, NavButtons, Btn, Tag, EmptyState, FrozenCard, useDragScroll, PAGE_COLORS } from "../components/ui/SharedUI";
import { ConflictBanner } from "../components/ConflictBanner";
import { supabase } from "../supabaseClient";
import { enrolmentIdFor, instrumentsFromEnrolments } from "../utils/enrolmentsDB";
import { findLaneId, getDayLaneTeacher, getDayLanes, lessonBelongsToViewedLane, isPastWeek } from "../utils/teacherCoverageDB";
import { insertTemporaryLane, deleteTemporaryLane } from "../utils/temporaryLanesDB";
import { checkConstraints, getRelationalPartnerIds, isConstraintVisibleForLesson } from "../utils/constraints";
import { buildMttImportForWeekSchool } from "../utils/mttImport";
import { getCatchupsForWeek, getCatchupsForGridCell, mergeCatchupsIntoLessons } from "../data/catchupsDerive";
import { insertCatchup, updateCatchup, deleteCatchup } from "../utils/catchupsDB";

export function WeeklyAdjustments({ mainScrollRef, timetable, schools, students, setStudents, enrolments, setEnrolments, teachers, setTeachers, teacherCoverage = [], laneOverrides = [], temporaryLanes = [], setTemporaryLanes = () => {}, catchups = [], setCatchups = () => {}, onSetLaneOverride, onClearLaneOverride, viewedLanes = {}, onSwitchLane, specialists, interruptions, groups, bands, weeklyTimetables, setWeeklyTimetables, teacherActuals = {}, ackedConstraints, setAckedConstraints, tallyEntries, setTallyEntries, masterBreaks, notify, contacts, logError, viewState, setViewState, sharedSchool, setSharedSchool, sharedTimetableScroll, setSharedTimetableScroll, onViewStudent, onViewGroup, onExport, onUndo, onRedo, undoCount, redoCount, onWarningsChange, goBack, goForward, historyCursor, pageHistory, onAddMemory, onSoundPlay }) {
  const { colors, darkMode } = useTheme();
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
  // ── Confirmed days (teacher-locked day slips) ─────────────
  const [confirmedDaysMap, setConfirmedDaysMap] = useState({}); // { dateStr: [{id, teacherId}] }
  const [resettingDay,  setResettingDay]  = useState(null);  // dateStr being reset
  const [confirmingDay, setConfirmingDay] = useState(null);  // dateStr being confirmed by admin
  const [resetConfirm,  setResetConfirm]  = useState(null);  // dateStr awaiting confirmation
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
  const [expandedWarnings, setExpandedWarnings] = useState(new Set());
  const [hoverPopover, setHoverPopover] = useState(null); // { info, rect, color }
  // NOTE: the onWarningsChange emit lives lower down (after visibleWarnings is
  // derived) so the value pushed to App.js is the past-dated-GATED warning set,
  // keeping the sidebar nav badge in agreement with the cards / banner / Dashboard.
  const [contextMenu, setContextMenu] = useState(null);
  // Per-day teacher-actuals ghost visibility. Key: `${weekKey}_${day}`.
  // Default empty = all days hidden. Session-scoped (not persisted).
  const [dayGhostsVisible, setDayGhostsVisible] = useState({});
  const [pendingSubmenu, setPendingSubmenu] = useState(null);
  const [addLessonSubmenu, setAddLessonSubmenu] = useState(null);
  const [missedZoneSubmenu, setMissedZoneSubmenu] = useState(null);
  const [dayHeaderSubmenu, setDayHeaderSubmenu] = useState(null);
  const dayHeaderHideTimer = React.useRef(null);
  const missedZoneHideTimer = React.useRef(null);
  const [wttEmailSubmenu, setWttEmailSubmenu] = useState(null);
  const [wttEmailLevel2, setWttEmailLevel2] = useState(null);
  const [notePopup, setNotePopup] = useState(null); // { lessonId, storageKey, x, y, note }
  const [notePopupDraft, setNotePopupDraft] = useState("");
  const [selectedCards, setSelectedCards] = useState(new Set()); // Set of lessonIds
  const [selectedMissed, setSelectedMissed] = useState(new Set()); // Set of missed indices
  const [selectedDays, setSelectedDays] = useState(new Set()); // Set of day names selected via header click
  const [missedModal, setMissedModal] = useState(null); // unified single+bulk missed modal
  const [rememberedReasons, setRememberedReasons] = useState(() => {
    try { return JSON.parse(localStorage.getItem("mt-missed-reasons") || "[]"); } catch { return []; }
  });
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.from("app_settings").select("value").eq("key", "missed_reasons").single();
        if (data?.value) {
          const parsed = JSON.parse(data.value);
          if (Array.isArray(parsed)) { setRememberedReasons(parsed); try { localStorage.setItem("mt-missed-reasons", JSON.stringify(parsed)); } catch {} }
        }
      } catch {}
    })();
  }, []);
  const saveRememberedReasons = async (list) => {
    setRememberedReasons(list);
    try { localStorage.setItem("mt-missed-reasons", JSON.stringify(list)); } catch {}
    try { await supabase.from("app_settings").upsert({ key: "missed_reasons", value: JSON.stringify(list) }); } catch {}
  };
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
      const inMissedZone = missedZoneSubRef.current && (() => { const r = missedZoneSubRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      if (inMain || inSub || inSwap || inLevel3 || inDayHeader || inMissedZone) {
        if (menuCloseTimer.current) { clearTimeout(menuCloseTimer.current); menuCloseTimer.current = null; }
      } else {
        if (!menuCloseTimer.current) {
          menuCloseTimer.current = setTimeout(() => { setContextMenu(null); setAddLessonSubmenu(null); addLessonSubmenuType.current = null; menuCloseTimer.current = null; }, 450);
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
  const [tallyPromptCategory, setTallyPromptCategory] = useState(null);
  const [tallyPromptReasonDetail, setTallyPromptReasonDetail] = useState("");
  const [tallyPromptCatchup, setTallyPromptCatchup] = useState(null);
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
  // Extracts preferred display name from bracket notation: "Jonathan (Johnny) Smith" → "Johnny Smith"
  const getPrefDisplayName = (name) => {
    if (!name) return name;
    const m = name.match(/\(([^)]+)\)/);
    if (!m) return name;
    const stripped = name.replace(/\s*\([^)]+\)/, "");
    const parts = stripped.split(" ");
    parts[0] = m[1];
    return parts.join(" ");
  };

  // ── Popover helpers (hover info card on lesson cards) ─────
  const buildPreferredDisplayName = (name) => {
    if (!name) return name;
    const match = name.match(/\(([^)]+)\)/);
    if (!match) return name;
    const prefFirst = match[1];
    const surname = name.replace(/^[^\s(]+\s*\([^)]+\)\s*/, "").trim();
    return surname ? `${prefFirst} ${surname}` : prefFirst;
  };

  const getStudentBands = (studentId) => {
    if (!studentId || !(bands || []).length) return [];
    return (bands || []).filter(b =>
      (b.members || []).some(m => m.studentId === studentId || m.student_id === studentId)
    ).map(b => b.name);
  };

  const buildPopoverInfo = (lesson) => {
    const info = {
      title: "",
      instrument: lesson.instrument || "",
      // Cluster 12a: lane-resolved teacher name (override-aware on WTT).
      teacher: getLiveTeacherName(lesson, students, teachers, enrolments, teacherCoverage, laneOverrides, weekKey),
      time: `${toTimeLabel(lesson.start)}${lesson.end ? " – " + toTimeLabel(lesson.end) : ""}`,
      parentName: null,
      className: null,
      classTeacher: null,
      bands: [],
      groupMembers: [],
      bandMembers: [],
    };

    if (lesson.isGroup) {
      info.title = lesson.groupName || lesson.studentName || "Group Lesson";
      const memberIds = lesson.studentIds || [];
      info.groupMembers = memberIds.map(sid => {
        const st = students.find(s => s.id === sid);
        if (!st) return null;
        const parentName = (st.parents || []).find(p => p.name)?.name;
        const studentBands = getStudentBands(sid);
        return {
          name: buildPreferredDisplayName(st.name),
          className: st.className || st.class_name || "",
          parentName: parentName || null,
          bands: studentBands,
          classTeacher: (() => { const ct = getClassTeacher(st, contacts || []); return ct ? ct.name : null; })(),
        };
      }).filter(Boolean);
    } else if (lesson.isBandSession) {
      info.title = lesson.bandName || "Band";
      info.time = "";
      const memberArr = lesson.members || [];
      info.bandMembers = memberArr.map(m => {
        const st = students.find(s => s.id === m.studentId);
        if (!st) return null;
        const ct = getClassTeacher(st, contacts || []);
        return {
          name: buildPreferredDisplayName(st.name),
          instrument: m.instrument || "",
          className: st.className || st.class_name || "",
          classTeacher: ct ? ct.name : "",
        };
      }).filter(Boolean);
    } else {
      const st = students.find(s => s.id === lesson.studentId);
      info.title = buildPreferredDisplayName(st?.name || lesson.studentName);
      info.className = st?.className || st?.class_name || lesson.className || null;
      if (st) {
        const parent = (st.parents || []).find(p => p.name);
        info.parentName = parent ? parent.name : null;
        info.bands = getStudentBands(st.id);
        const ct = getClassTeacher(st, contacts || []);
        info.classTeacher = ct ? ct.name : null;
      }
    }

    return info;
  };

  const renderHoverPopover = () => {
    if (!hoverPopover) return null;
    const { type = "student", info, rect, color } = hoverPopover;
    const spaceBelow = window.innerHeight - rect.bottom;
    const topPos = spaceBelow > 200 ? rect.bottom + 6 : rect.top - 6;
    const anchor = spaceBelow > 200 ? "top" : "bottom";
    const popLeft = Math.min(rect.left, window.innerWidth - 260);

    if (type === "constraints") {
      const warnings = hoverPopover.warnings || [];
      return (
        <div style={{
          position: "fixed", left: popLeft,
          [anchor]: anchor === "top" ? topPos : window.innerHeight - topPos,
          zIndex: 2000, background: colors.cardBg, borderRadius: 10,
          boxShadow: "0 4px 20px rgba(0,0,0,0.15)", border: `1.5px solid ${color}`,
          padding: "10px 13px", width: 240, pointerEvents: "none", fontFamily: "inherit",
        }}>
          {warnings.map((w, wi) => (
            <div key={wi} style={{ color: colors.danger, fontWeight: 500, fontSize: 11, display: "flex", alignItems: "center", gap: 5, marginBottom: wi < warnings.length - 1 ? 4 : 0 }}>
              <AlertTriangle size={11} style={{ flexShrink: 0 }} /> {w}
            </div>
          ))}
        </div>
      );
    }

    return (
      <div style={{
        position: "fixed", left: popLeft,
        [anchor]: anchor === "top" ? topPos : window.innerHeight - topPos,
        zIndex: 2000, background: colors.cardBg, borderRadius: 10,
        boxShadow: "0 4px 20px rgba(0,0,0,0.15)", border: `1.5px solid ${color}`,
        padding: "10px 13px", width: 240, pointerEvents: "none", fontFamily: "inherit",
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: colors.text, marginBottom: 4, lineHeight: 1.3 }}>
          {info.title}
        </div>
        <div style={{ fontSize: 11, color: colors.textLight, marginBottom: 2 }}>
          {info.instrument}{info.teacher ? ` · ${info.teacher}` : ""}
        </div>
        {info.time && <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>{info.time}</div>}
        {!info.groupMembers.length && (
          <>
            {(info.className || info.classTeacher) && (
              <div style={{ fontSize: 11, color: colors.textLight }}>
                Class: {info.className || ""}{info.classTeacher ? `${info.className ? " - " : ""}${info.classTeacher}` : ""}
              </div>
            )}
            {info.parentName && (
              <div style={{ fontSize: 11, color: colors.textLight }}>Parent: {info.parentName}</div>
            )}
            {info.bands.length > 0 && (
              <div style={{ fontSize: 11, color: colors.textLight }}>
                Band: {info.bands.join(", ")}
              </div>
            )}
          </>
        )}
        {info.groupMembers.length > 0 && (
          <div style={{ marginTop: 4, borderTop: `1px solid ${colors.borderLight}`, paddingTop: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>
              Members
            </div>
            {info.groupMembers.map((m, i) => (
              <div key={i} style={{ fontSize: 11, color: colors.text, marginBottom: i < info.groupMembers.length - 1 ? 4 : 0 }}>
                <div style={{ fontWeight: 600 }}>{m.name}</div>
                {(m.className || m.classTeacher) && (
                  <div style={{ color: colors.textMuted }}>
                    Class: {m.className || ""}{m.classTeacher ? `${m.className ? " - " : ""}${m.classTeacher}` : ""}
                  </div>
                )}
                {m.parentName && (
                  <div style={{ color: colors.textMuted }}>Parent: {m.parentName}</div>
                )}
                {m.bands.length > 0 && (
                  <div style={{ color: colors.textMuted }}>Band: {m.bands.join(", ")}</div>
                )}
              </div>
            ))}
          </div>
        )}
        {info.bandMembers.length > 0 && (
          <div style={{ marginTop: 4, borderTop: `1px solid ${colors.borderLight}`, paddingTop: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>
              Members
            </div>
            {info.bandMembers.map((m, i) => (
              <div key={i} style={{ fontSize: 11, color: colors.text, marginBottom: i < info.bandMembers.length - 1 ? 4 : 0 }}>
                <div style={{ fontWeight: 600 }}>{m.name}{m.instrument ? <span style={{ color: colors.textMuted, fontWeight: 400 }}> · {m.instrument}</span> : null}</div>
                {m.className && (
                  <div style={{ color: colors.textMuted }}>
                    Class: {m.className}{m.classTeacher ? ` – ${m.classTeacher}` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

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
  // v2.9.12 past-dated display gate: today's date in Melbourne local time, as
  // a 'YYYY-MM-DD' string for comparison against weekDateMap entries.
  const weeklyTodayStr = melbourneToday();
  const currentSchool = schools.find(s => s.id === selectedSchool);

  // Flatten all teacher_actuals lessons for the current (week, school)
  // across every teacher into a single array. Used by the ghost layer
  // in each slot cell.
  const currentTeacherActualsLessons = useMemo(() => {
    if (!selectedSchool) return [];
    const prefix = `${weekKey}|${selectedSchool}|`;
    return Object.entries(teacherActuals)
      .filter(([k]) => k.startsWith(prefix))
      .flatMap(([, entry]) => entry.lessons || []);
  }, [teacherActuals, weekKey, selectedSchool]);

  // Parallel flatten for teacher-actuals missed entries — used by the
  // missed zone when a day's Actuals toggle is ON.
  const currentTeacherActualsMissed = useMemo(() => {
    if (!selectedSchool) return [];
    const prefix = `${weekKey}|${selectedSchool}|`;
    return Object.entries(teacherActuals)
      .filter(([k]) => k.startsWith(prefix))
      .flatMap(([, entry]) => entry.missed || []);
  }, [teacherActuals, weekKey, selectedSchool]);
  // ── Drag overlay: precomputed per-slot warnings + specialist tags ──

  // Term week number
  const termBreaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));
  const holidayBreak = termBreaks.find(tb => weekKey >= tb.date && weekKey <= (tb.endDate || tb.date));
  const isHolidayWeek = !!holidayBreak;
  const holidayWeekNum = isHolidayWeek ? (() => {
    const breakStartDate = new Date(holidayBreak.date + "T00:00:00");
    const dow = breakStartDate.getDay();
    const daysToNextMonday = dow === 1 ? 0 : (dow === 0 ? 1 : 8 - dow);
    const firstMondayOfBreak = new Date(breakStartDate);
    firstMondayOfBreak.setDate(firstMondayOfBreak.getDate() + daysToNextMonday);
    const currentMonday = _getMondayOf(new Date(weekKey + "T00:00:00"));
    return Math.max(1, Math.round((currentMonday.getTime() - firstMondayOfBreak.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1);
  })() : null;
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
  const weekLabel = isHolidayWeek ? `Holidays Week ${holidayWeekNum}` : (termWeek ? `Week ${termWeek}` : `Week of ${weekKey}`);
  // term week at offset 0 = current week; minOffset scrolls back to week 1
  const currentTermWeekNum = getTermWeekNum(getWeekDates(0)[0].date);
  const minWeekOffset = currentTermWeekNum ? -(currentTermWeekNum - 1 + 8) : -20;
  const isPastWeek = weekOffset < 0;
  const isLocked = isPastWeek && !editUnlocked;
  const storageKey = `${weekKey}|${selectedSchool}`;
  const weeklyData = weeklyTimetables[storageKey] || null;

  // v2.9.12 SINGLE GATED SOURCE OF TRUTH for warning DISPLAY.
  // Filters the raw constraintWarnings store down to only the lessons whose
  // warnings should still show (own date today-or-later, and every relational
  // partner today-or-later) using the SAME predicate the per-card render uses.
  // Every display surface — per-card, the conflicts banner, and (via the emit
  // effect below) the App.js sidebar nav badge — reads from this, so they all
  // agree. Ack state, the constraint checker, and the warning strings are
  // untouched; this is purely a display filter.
  const visibleWarnings = useMemo(() => {
    const out = {};
    const lessons = weeklyData?.lessons || [];
    for (const id of Object.keys(constraintWarnings)) {
      const lesson = lessons.find(l => l.id === id);
      if (isConstraintVisibleForLesson(lesson, lessons, weeklyTodayStr, weekDateMap, currentSchool)) {
        out[id] = constraintWarnings[id];
      }
    }
    return out;
  }, [constraintWarnings, weeklyData, weeklyTodayStr, weekDateMap, currentSchool]);

  // Emit the GATED set up to App.js so the sidebar nav badge counts only what's
  // visible. App.js applies its own acknowledged-filter on top of this.
  useEffect(() => { if (onWarningsChange) onWarningsChange(visibleWarnings, ackedConstraints); }, [visibleWarnings, ackedConstraints]);

  // Archived students are hidden from the grid — their slot becomes free.
  // Cluster 8a: when a (school, day) has 2+ active lanes, also restrict the
  // grid to lessons bound to the day's viewed lane (or, for legacy cards
  // without bucket_id, only show under the default first-added lane).
  // All other logic (generation, tally, etc.) still uses weeklyData.lessons directly.
  const displayLessons = (weeklyData?.lessons || []).filter(l => {
    if (!l.isGroup && l.studentId) {
      const liveStu = students.find(s => s.id === l.studentId);
      if (liveStu?.status === "archived") return false;
    }
    return lessonBelongsToViewedLane(l, viewedLanes, teacherCoverage, selectedSchool);
  });

  // ── Spec 3 cluster 5b-3a: catchup create / delete plumbing ───────────────

  // Spec 3 cluster 5b-3c-a — score helper for the catchup picker
  // annotation badges. Mirrors the OLD "Add catch-up" cascade's
  // scoreStudent logic verbatim (now retired): interruption hits at the
  // candidate slot weigh 4 each, outsideClass hint adds 2, specialist
  // clash adds 1. The label thresholds match the OLD: ≥4 ⚠ interruption,
  // ≥2 constraint, ≥1 specialist, else null. Pure function — no closures.
  const computeStudentSlotScore = ({ student, day, time, weekDate, interruptions, specialists }) => {
    let score = 0;
    if (weekDate && student) {
      const slotInterruptions = (interruptions || []).filter(i => {
        if (i.type === "term_break") return false;
        if (i.schoolId !== student.schoolId && i.schoolId !== "all") return false;
        const start = i.date, end = i.endDate || i.date;
        if (weekDate < start || weekDate > end) return false;
        if (i.affectsClasses !== "all" && !classMatchesInterruption(student.className || "", i.affectsClasses)) return false;
        if (i.startTime) { const iS = timeToMin(i.startTime), iE = timeToMin(i.endTime || i.startTime), tS = timeToMin(time); if (tS < iS || tS >= iE) return false; }
        return true;
      });
      score += slotInterruptions.length * 4;
    }
    if (student?.outsideClassOnly || student?.outsideClassPreferred) score += 2;
    if (student) {
      const specClash = (specialists || []).some(sp =>
        sp.schoolId === student.schoolId &&
        sp.className === student.className &&
        sp.day === day &&
        timeToMin(time) >= timeToMin(sp.start) && timeToMin(time) < timeToMin(sp.end)
      );
      if (specClash) score += 1;
    }
    const label = score >= 4 ? "⚠ interruption" : score >= 2 ? "constraint" : score >= 1 ? "specialist" : null;
    return { score, label };
  };

  // Unresolved missed lessons across the current term, grouped by
  // enrolment. Drives the "Schedule catchup for…" menu.
  //
  // Single source of truth: getOpenCatchupRows applies deriveTallyRows's
  // containment filters (school filter, __private__ exclusion,
  // pending/trial exclusion, archived enrolment-overlap, enrolment join)
  // so the picker stays aligned with TallyView's makeupOwed instead of
  // walking raw missed entries. Picker-only post-processing stays here:
  // a raw-WTT re-join recovers start/time (the shim carries day/weekKey
  // but not start/time, and handleScheduleCatchup reads
  // missedEntries[0].start ?? .time for resolvesOriginalTime), then
  // enrolment-id resolution, already-scheduled exclusion, group, sort.
  //
  // Each group carries missedEntries[] sorted oldest-first so the click
  // handler can pick missedEntries[0] as the target. Groups sort
  // alphabetical by studentName, tie-break by instrument.
  const unresolvedMissedGroups = useMemo(() => {
    const allTerms = getTerms(termBreaks);
    const activeTerm = getCurrentTerm(allTerms, new Date(weekKey + "T00:00:00"));
    if (!activeTerm) return [];
    const termWeeks = getTermWeeks({ activeTerm, termBreaks, now: new Date() });
    const openRows = getOpenCatchupRows({
      weeklyTimetables, enrolments, students, timetable, termWeeks, schoolFilter: "all",
    });
    const byEnrolment = new Map();
    for (const row of openRows) {
      // Re-join to the raw WTT missed entry to recover start/time, which
      // the buildShimEntry object doesn't carry but handleScheduleCatchup
      // needs for resolvesOriginalTime. Storage key mirrors deriveTallyRows
      // (`${weekKey}|${schoolId}`, schoolId = mttCard||student schoolId,
      // which is exactly row.missed.schoolId).
      const wttMissed = weeklyTimetables[`${row.weekKey}|${row.missed.schoolId}`]?.missed || [];
      const matchDay = row.missed.day;
      const matchById = row.missed.groupId
        ? (m) => m.day === matchDay && m.groupId === row.missed.groupId
        : (m) => m.day === matchDay && m.studentId === row.missed.studentId && m.instrument === row.missed.instrument;
      const rawMissed = wttMissed.find(matchById);
      if (!rawMissed && process.env.NODE_ENV !== "production") {
        console.warn("[catchup picker] start/time re-join missed raw WTT entry", {
          weekKey: row.weekKey, schoolId: row.missed.schoolId, day: matchDay,
          studentId: row.missed.studentId, instrument: row.missed.instrument, groupId: row.missed.groupId,
        });
      }
      const enriched = {
        ...row.missed,
        start: row.missed.start ?? rawMissed?.start ?? null,
        time: row.missed.time ?? rawMissed?.time ?? null,
      };
      const resolvedId = enriched.enrolmentId ?? enrolmentIdFor(enriched.studentId, enriched.instrument, enrolments, enriched.groupId);
      if (!resolvedId) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[catchup picker] dropping candidate — could not resolve enrolment", {
            studentId: enriched.studentId,
            studentName: enriched.studentName,
            instrument: enriched.instrument,
            weekKey: row.weekKey,
            day: enriched.day,
          });
        }
        continue;
      }
      enriched.enrolmentId = resolvedId;
      if (catchups.some(c => c.resolvesEnrolmentId === resolvedId && c.resolvesWeekKey === row.weekKey)) continue;
      if (!byEnrolment.has(resolvedId)) byEnrolment.set(resolvedId, []);
      byEnrolment.get(resolvedId).push(enriched);
    }
    const groups = [];
    for (const [enrolmentId, entries] of byEnrolment) {
      if (entries.length === 0) continue;
      entries.sort((a, b) => (a.weekKey || "").localeCompare(b.weekKey || "")); // oldest first
      const first = entries[0];
      const en = enrolments.find(e => e.id === enrolmentId);
      const st = en && !en.isGroup ? students.find(s => s.id === en.studentId) : null;
      const studentName = en?.isGroup
        ? (first.groupName || "Group")
        : (st?.name || first.studentName || "—");
      groups.push({
        enrolmentId,
        studentName,
        instrument: first.instrument || en?.instrument || "",
        schoolId: first.schoolId || "",
        owedCount: entries.length,
        missedEntries: entries,
      });
    }
    groups.sort((a, b) => {
      const na = a.studentName.toLowerCase();
      const nb = b.studentName.toLowerCase();
      if (na !== nb) return na.localeCompare(nb);
      return (a.instrument || "").localeCompare(b.instrument || "");
    });
    return groups;
  }, [weeklyTimetables, enrolments, students, timetable, termBreaks, catchups, weekKey]);

  // Set of studentNames that appear more than once in the grouped list —
  // drives the instrument-disambiguator decision in display.
  const collidingStudentNames = useMemo(() => {
    const counts = new Map();
    for (const g of unresolvedMissedGroups) {
      counts.set(g.studentName, (counts.get(g.studentName) || 0) + 1);
    }
    const out = new Set();
    for (const [name, n] of counts) if (n > 1) out.add(name);
    return out;
  }, [unresolvedMissedGroups]);

  const formatCatchupDisplay = (c) => {
    const en = enrolments.find(e => e.id === c.enrolmentId);
    const st = en ? students.find(s => s.id === en.studentId) : null;
    const name = st?.name || "this student";
    const dayShort = (c.day || "").slice(0, 3);
    const timeLabel = c.time
      ? (() => { const [h, mm] = c.time.split(":"); const hr = parseInt(h) % 12 || 12; return `${hr}:${mm}`; })()
      : "";
    return `${name} — ${dayShort}${timeLabel ? " " + timeLabel : ""}`;
  };

  // Right-click handlers — open the new catchup menu branches.
  const handleEmptyCellRightClick = (e, day, time, targetWeekKey) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX, y: e.clientY,
      isCatchupCreate: true,
      targetDay: day,
      targetTime: time,
      targetWeekKey: targetWeekKey || weekKey,
    });
  };
  const handleCatchupCardRightClick = (e, catchup) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX, y: e.clientY,
      isCatchupAction: true,
      targetCatchup: catchup,
    });
  };

  // Action handlers — call catchupsDB write helpers + bubble local state.
  // Spec 3 cluster 5b-3c-a: takes an explicit target { day, time, weekKey,
  // schoolId? } so both surfaces can call it without coordinating contextMenu
  // shape. Period-grid path (cascade from isEmpty) builds target from
  // contextMenu.day/time/schoolId + parent weekKey. Mon-Sun grid path
  // (isCatchupCreate root menu) builds target from contextMenu.targetDay/Time/WeekKey.
  // Picks group.missedEntries[0] (oldest first per the memo's sort).
  const handleScheduleCatchup = async (group, target) => {
    try {
      const targetMissed = group.missedEntries[0];
      if (!targetMissed) throw new Error("Group has no missed entries");
      const enrolment = enrolments.find(en => en.id === group.enrolmentId);
      const instrument = group.instrument || enrolment?.instrument || "";
      const schoolId = target.schoolId || group.schoolId || enrolment?.schoolId || "__private__";
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.id) throw new Error("Not authenticated");
      const inserted = await insertCatchup({
        userId: user.id,
        schoolId,
        weekKey: target.weekKey,
        day: target.day,
        time: target.time,
        instrument,
        enrolmentId: group.enrolmentId,
        resolvesEnrolmentId: group.enrolmentId,
        resolvesWeekKey: targetMissed.weekKey,
        resolvesOriginalDay: targetMissed.day,
        resolvesOriginalTime: targetMissed.start ?? targetMissed.time ?? null,
        madeUp: false,
        notes: null,
      });
      setCatchups(prev => [...prev, inserted]);
      setContextMenu(null);
      setAddLessonSubmenu(null);
      addLessonSubmenuType.current = null;
      if (notify) notify("Catchup scheduled");
    } catch (err) {
      logError && logError("Failed to schedule catchup", err?.message || String(err));
      console.error("[catchup create] failed:", err);
      alert("Failed to schedule catchup. See console.");
    }
  };
  // Spec 3 cluster 5b-3c-b — drag-drop relocate handler. Same-cell no-op
  // and missing-id no-op are handled here; the drop-side wiring also
  // checks cellLessons.length === 0 / cell.length === 0 before calling.
  // updateCatchup gets currentRow so its dev-mode synthesis can return a
  // properly merged row (see catchupsDB.js post-patch-5 pattern).
  const handleCatchupRelocate = async (catchupId, targetDay, targetTime) => {
    const current = (catchups || []).find(c => c.id === catchupId);
    if (!current) return;
    if (current.day === targetDay && current.time === targetTime) return;
    try {
      const updated = await updateCatchup({
        id: catchupId,
        currentRow: current,
        day: targetDay,
        time: targetTime,
      });
      setCatchups(prev => prev.map(c => c.id === catchupId ? updated : c));
      if (notify) notify("Catchup moved");
    } catch (err) {
      logError && logError("Failed to move catchup", err?.message || String(err));
      console.error("[catchup move] failed:", err);
      alert("Failed to move catchup. See console.");
    }
  };

  const handleDeleteCatchup = async (catchup) => {
    if (!window.confirm(`Delete catchup for ${formatCatchupDisplay(catchup)}?`)) {
      setContextMenu(null);
      return;
    }
    try {
      await deleteCatchup({ id: catchup.id });
      setCatchups(prev => prev.filter(c => c.id !== catchup.id));
      setContextMenu(null);
      if (notify) notify("Catchup deleted");
    } catch (err) {
      logError && logError("Failed to delete catchup", err?.message || String(err));
      console.error("[catchup delete] failed:", err);
      alert("Failed to delete catchup. See console.");
    }
  };

  // Temporary-lanes session 3 — create a one-week-only lane row. userId
  // via supabase.auth.getUser(), mirroring handleScheduleCatchup. weekKey/
  // schoolId/day are passed from component scope at the call site (the
  // day-header context menu state carries no weekKey — see :2312/:2505).
  const handleAddTemporaryTeacher = async (schoolId, day, weekKey, teacherId) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.id) throw new Error("Not authenticated");
      const inserted = await insertTemporaryLane({ userId: user.id, schoolId, day, weekKey, teacherId });
      setTemporaryLanes(prev => [...prev, inserted]);
      setContextMenu(null);
      setDayHeaderSubmenu(null);
      if (notify) notify("Temporary teacher added");
    } catch (err) {
      logError && logError("Failed to add temporary teacher", err?.message || String(err));
      console.error("[temporary-lane add] failed:", err);
      alert("Failed to add temporary teacher. See console.");
    }
  };

  // Temporary-lanes session 3 — remove a temp lane row. No confirm dialog:
  // single right-click + click, trivially redoable (matches the lightweight
  // substitute-teacher change pattern).
  const handleRemoveTemporaryLane = async (laneId) => {
    try {
      await deleteTemporaryLane({ id: laneId });
      setTemporaryLanes(prev => prev.filter(t => t.id !== laneId));
      setContextMenu(null);
      setDayHeaderSubmenu(null);
      if (notify) notify("Temporary teacher removed");
    } catch (err) {
      logError && logError("Failed to remove temporary teacher", err?.message || String(err));
      console.error("[temporary-lane remove] failed:", err);
      alert("Failed to remove temporary teacher. See console.");
    }
  };

  // ── Revalidate warnings whenever lessons or student data changes ─────────
  // Runs on weeklyTimetables change (drag/poll) AND on students change (teacher/instrument edit).
  // - Existing warnings: recomputed, cleared if now clean.
  // - All lessons: also checked fresh so new warnings appear immediately when
  //   a student's teacher or instrument changes (previously only warned lessons were rechecked).
  useEffect(() => {
    const lessons = weeklyData?.lessons || [];
    setConstraintWarnings(prev => {
      const updated = { ...prev };
      let changed = false;
      for (const l of lessons) {
        const school = schools.find(s => s.id === l.schoolId);
        const slot = school?.slots?.find(s => s.start === l.start);
        if (!slot) {
          if (updated[l.id]) { delete updated[l.id]; changed = true; }
          continue;
        }
        const recomputed = checkConstraints(l, l.day, slot, lessons, { weekKey, selectedSchool, currentSchool, weeklyTimetables, teacherCoverage, laneOverrides, students, enrolments, teachers, schools, bands, groups, weekDateMap, weekInterruptions, specLookupRef, timetable });
        const existing = prev[l.id];
        const same = existing
          ? recomputed.length === existing.length && recomputed.every((w, i) => w === existing[i])
          : recomputed.length === 0;
        if (!same) {
          if (recomputed.length > 0) updated[l.id] = recomputed;
          else {
            delete updated[l.id];
            setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; });
          }
          changed = true;
        }
      }
      // Remove warnings for lessons that no longer exist
      for (const id of Object.keys(updated)) {
        if (!lessons.find(l => l.id === id)) { delete updated[id]; changed = true; }
      }
      return changed ? updated : prev;
    });
  }, [weeklyTimetables, storageKey, students, teachers, schools, enrolments, bands, groups, interruptions, specialists, timetable]);


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

  // ── Load confirmed day slips for displayed week ───────────
  useEffect(() => {
    (async () => {
      try {
        const weekStart = weekDates[0].date;
        const weekEnd   = weekDates[weekDates.length - 1].date;
        const { data } = await supabase
          .from("day_slips")
          .select("id, teacher_id, slip_date")
          .eq("slip_type", "lesson_day")
          .eq("is_locked", true)
          .gte("slip_date", weekStart)
          .lte("slip_date", weekEnd);
        if (data) {
          const map = {};
          for (const row of data) {
            if (!map[row.slip_date]) map[row.slip_date] = [];
            map[row.slip_date].push({ id: row.id, teacherId: row.teacher_id });
          }
          setConfirmedDaysMap(map);
        }
      } catch (e) {
        console.warn("WeeklyAdjustments: failed to load day slips:", e);
      }
    })();
  }, [weekKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime: day_slips INSERT + DELETE ───────────────────
  useEffect(() => {
    const channel = supabase
      .channel("admin-wa-day-slips")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "day_slips" }, (payload) => {
        const row = payload.new;
        if (row.slip_type !== "lesson_day" || !row.is_locked) return;
        setConfirmedDaysMap(prev => {
          const existing = prev[row.slip_date] || [];
          if (existing.some(s => s.id === row.id)) return prev;
          return { ...prev, [row.slip_date]: [...existing, { id: row.id, teacherId: row.teacher_id }] };
        });
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "day_slips" }, (payload) => {
        const row = payload.old;
        if (!row?.slip_date) return;
        setConfirmedDaysMap(prev => {
          const updated = { ...prev };
          if (updated[row.slip_date]) {
            updated[row.slip_date] = updated[row.slip_date].filter(s => s.id !== row.id);
            if (updated[row.slip_date].length === 0) delete updated[row.slip_date];
          }
          return updated;
        });
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  // ── Reset a confirmed day (admin) ─────────────────────────
  async function resetConfirmedDay(dateStr) {
    setResettingDay(dateStr);
    try {
      const slips = confirmedDaysMap[dateStr] || [];
      const ids = slips.map(s => s.id);
      if (ids.length > 0) {
        await supabase.from("day_slips").delete().in("id", ids);
      }
      setConfirmedDaysMap(prev => { const next = { ...prev }; delete next[dateStr]; return next; });
      setResetConfirm(null);
      if (notify) notify("Day reset — teacher can re-confirm");
    } catch (e) {
      console.error("resetConfirmedDay error:", e);
    } finally {
      setResettingDay(null);
    }
  }

  // ── Confirm a day from admin side (inserts one slip per teacher on that day) ─
  async function confirmDay(dateStr, dayName) {
    setConfirmingDay(dateStr);
    try {
      const teacherIds = [...new Set(
        (weeklyData?.lessons || [])
          .filter(l => l.day === dayName)
          .map(l => getLiveTeacherId(l, students, enrolments, teacherCoverage, laneOverrides, weekKey))
          .filter(Boolean)
      )];
      if (teacherIds.length === 0) {
        if (notify) notify("No lessons found for this day");
        return;
      }
      const rows = teacherIds.map(tid => ({
        teacher_id: tid,
        slip_date: dateStr,
        slip_type: "lesson_day",
        is_locked: true,
        school_id: selectedSchool,
      }));
      const { data, error } = await supabase.from("day_slips").insert(rows).select("id, teacher_id, slip_date");
      if (error) throw error;
      if (data) {
        setConfirmedDaysMap(prev => ({
          ...prev,
          [dateStr]: [...(prev[dateStr] || []), ...data.map(r => ({ id: r.id, teacherId: r.teacher_id }))]
        }));
      }
      if (notify) notify("Day confirmed");
    } catch (e) {
      console.error("confirmDay error:", e);
      if (notify) notify("Failed to confirm day");
    } finally {
      setConfirmingDay(null);
    }
  }

  useEffect(() => {
    setAdjustmentNotes(weeklyData?.notes || "");
  }, [storageKey]);

  const weekInterruptions = interruptions.filter(i => {
    if (i.type === "term_break") return false;
    if (selectedSchool && i.schoolId !== selectedSchool && i.schoolId !== "all") return false;
    const start = i.date;
    const end = i.endDate || i.date;
    return weekDates.some(wd => wd.date >= start && wd.date <= end);
  });

  // ── Add band session to WTT ────────────────────────────────
  const handleAddBandSession = (band) => {
    const day = contextMenu.day;
    const time = contextMenu.time;
    const teacher = teachers.find(t => t.id === band.teacherId);
    const existingData = weeklyTimetables[storageKey] || { lessons: [], missed: [] };
    let lessons = [...(existingData.lessons || [])];
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
    }
    // Spec 2 cluster 4c — lane lookup before stamping bucket_id.
    const bandBucketId = band.teacherId
      ? findLaneId(teacherCoverage, band.schoolId, day, band.teacherId)
      : null;
    if (!bandBucketId) {
      const sName = schools.find(s => s.id === band.schoolId)?.name || band.schoolId;
      if (notify) notify(`No covering lane for ${teacher?.name || "(unassigned)"} at ${sName} on ${day}. Add staff first.`, "warning");
      return;
    }
    const bandLesson = {
      id: uid(), isBandSession: true,
      bandId: band.id, bandName: band.name || "TBC",
      schoolId: band.schoolId,
      bucket_id: bandBucketId, teacherName: teacher?.name || "",
      day, start: time, end: time,
      members: band.members || [],
      removedLessons: bandRemovedLessons,
    };
    lessons = [...lessons, bandLesson];
    setWeeklyTimetables(prev => ({ ...prev, [storageKey]: { ...existingData, lessons } }));
    // Check constraints for the newly placed band session
    const bSlot = (currentSchool?.slots || []).find(s => s.start === time);
    if (bSlot) {
      const bWarnings = checkConstraints(bandLesson, day, bSlot, lessons, { weekKey, selectedSchool, currentSchool, weeklyTimetables, teacherCoverage, laneOverrides, students, enrolments, teachers, schools, bands, groups, weekDateMap, weekInterruptions, specLookupRef, timetable });
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
        const studentList = schoolStudents.map(s => `${s.name} (${s.className}, ${instrumentsFromEnrolments(s.id, enrolments).map(i => i.name).join("+")})`).join("\n");
        const classNames = [...new Set(schoolStudents.map(s => s.className))].join(", ");

        const teacherList = teachers.filter(t => teacherCoverage.some(l => l.teacherId === t.id && l.schoolId === selectedSchool && l.status === "active")).map(t => t.name).join(", ");
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
                  // Teacher match — cluster 12a: lane-resolved name (override-aware).
                  if (h.targetTeacherName) {
                    const tName = (getLiveTeacherName(lesson, students, teachers, enrolments, teacherCoverage, laneOverrides, weekKey) || "").toLowerCase();
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
              // tally_remove hints are consumed by the scheduler-side filter (weeklyTimetableGenerator.js); no longer persisted post-Commit-5
              const removeHints = parsed.filter(h => h.action === "tally_remove");
              if (removeHints.length > 0) {
                console.log("[AI] tally_remove hints received but no longer persisted (post-Commit-5):", removeHints.length);
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
      filteredMasterLessons, currentSchool, students, teachers, specialists, interruptions, weekDates, aiHints, schoolMasterBreaks2, teacherCoverage
    );

    // Skip students with a pre-marked informed_absence for this week — remove from
    // scheduled lessons and push into missed so they don't appear on the grid.
    const _preAbsentEntries = getMissedEntries({
      weeklyTimetables,
      weekKey,
      schoolId: selectedSchool,
      reasons: ["informed_absence"],
    });
    const _preAbsentIds = new Set(
      _preAbsentEntries.filter(e => e.studentId).map(e => e.studentId)
    );
    const _absentLessons = _preAbsentIds.size > 0
      ? result.lessons.filter(l => !l.isBandSession && !l.isGroup && _preAbsentIds.has(l.studentId))
      : [];
    const scheduledLessons = _preAbsentIds.size > 0
      ? result.lessons.filter(l => l.isBandSession || l.isGroup || !_preAbsentIds.has(l.studentId))
      : result.lessons;
    const allMissed = [
      ...result.missed.map(m => ({ ...m, enrolmentId: enrolmentIdFor(m.studentId, m.instrument, enrolments, m.groupId) })),
      ..._absentLessons.map(l => {
        const tallyEntry = _preAbsentEntries.find(e => e.studentId === l.studentId);
        return { ...l, reason: tallyEntry?.reason || "informed_absence", enrolmentId: enrolmentIdFor(l.studentId, l.instrument, enrolments, l.groupId) };
      }),
    ];

    const allMissedNormalized = allMissed.map(m => {
      const isClashOrCancel = m.reason && (
        m.reason.includes("No available slot") ||
        m.reason.includes("conflict") ||
        m.reason.includes("Cancelled by weekly")
      );
      if (!isClashOrCancel) return m;
      const matchingHint = aiHints.find(h => h.lessonMatch && h.lessonMatch(m));
      const makeupElig = matchingHint?.makeupEligible === false ? false : true;
      return {
        ...m,
        reason: m.reason.includes("Cancelled by weekly") ? "informed_absence" : "timetable_clash",
        reasonDetail: "",
        notes: m.reason || "",
        makeupEligible: makeupElig,
        madeUp: false,
        cardNote: "",
      };
    });

    setWeeklyTimetables(prev => ({
      ...prev,
      [storageKey]: { lessons: [...existingBandSessions, ...scheduledLessons], missed: allMissedNormalized, notes: adjustmentNotes, generatedAt: new Date().toISOString() }
    }));

    const adj = scheduledLessons.filter(l => l.adjusted).length;
    const absentSkipped = _absentLessons.length;
    notify(`Weekly timetable: ${scheduledLessons.length} lessons, ${adj} adjusted, ${allMissed.length} missed${absentSkipped > 0 ? ` (${absentSkipped} skipped — pre-marked absent)` : ""}`);
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
        filteredAll, school, students, teachers, specialists, interruptions, weekDates, [], schoolBreaks, teacherCoverage
      );
      const _allPreAbsentEntries = getMissedEntries({
        weeklyTimetables,
        weekKey,
        schoolId: school.id,
        reasons: ["informed_absence"],
      });
      const _allPreAbsentIds = new Set(
        _allPreAbsentEntries.filter(e => e.studentId).map(e => e.studentId)
      );
      const _allAbsentLessons = _allPreAbsentIds.size > 0
        ? result.lessons.filter(l => !l.isBandSession && !l.isGroup && _allPreAbsentIds.has(l.studentId))
        : [];
      const _allScheduledLessons = _allPreAbsentIds.size > 0
        ? result.lessons.filter(l => l.isBandSession || l.isGroup || !_allPreAbsentIds.has(l.studentId))
        : result.lessons;
      const _allMissed = [
        ...result.missed.map(m => ({ ...m, enrolmentId: enrolmentIdFor(m.studentId, m.instrument, enrolments, m.groupId) })),
        ..._allAbsentLessons.map(l => {
          const tallyEntry = _allPreAbsentEntries.find(e => e.studentId === l.studentId);
          return { ...l, reason: tallyEntry?.reason || "informed_absence", enrolmentId: enrolmentIdFor(l.studentId, l.instrument, enrolments, l.groupId) };
        }),
      ];
      setWeeklyTimetables(prev => ({
        ...prev,
        [sk]: { lessons: [...existingBandSessionsAll, ..._allScheduledLessons], missed: _allMissed, generatedAt: new Date().toISOString() }
      }));
    }
  };

  const importFromMTT = (targetDay) => {
    if (!timetable) { notify("No master timetable to import from", "warning"); return; }
    const result = buildMttImportForWeekSchool({
      mtt: timetable,
      schoolId: selectedSchool,
      weekDates,
      existingEntry: weeklyTimetables[storageKey] || null,
      targetDay,
    });
    if (!result) { notify("No master timetable to import from", "warning"); return; }
    setWeeklyTimetables(prev => ({ ...prev, [storageKey]: result.entry }));
    if (targetDay) {
      notify(`Imported ${result.importedCount} lessons for ${targetDay}`);
    } else {
      const extraNote = result.preservedBandCount > 0
        ? ` (${result.preservedBandCount} band ${result.preservedBandCount === 1 ? "session" : "sessions"} preserved)`
        : "";
      notify(`Imported ${result.importedCount} lessons for the week${extraNote}`);
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
        const studentList = schoolStudents.map(s => `${s.name} (${s.className}, ${instrumentsFromEnrolments(s.id, enrolments).map(i => i.name).join("+")})`).join("\n");
        const classNames = [...new Set(schoolStudents.map(s => s.className))].join(", ");
        const teacherList = teachers.filter(t => teacherCoverage.some(l => l.teacherId === t.id && l.schoolId === selectedSchool && l.status === "active")).map(t => t.name).join(", ");
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
                  // Teacher match — cluster 12a: lane-resolved name (override-aware).
                  if (h.targetTeacherName) {
                    const tName = (getLiveTeacherName(lesson, students, teachers, enrolments, teacherCoverage, laneOverrides, weekKey) || "").toLowerCase();
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
      filteredMasterDay, currentSchool, students, teachers, specialists, interruptions, weekDates, aiHints, schoolMasterBreaks3, teacherCoverage
    );

    // Skip students with a pre-marked informed_absence for this week
    const _dayPreAbsentEntries = getMissedEntries({
      weeklyTimetables,
      weekKey,
      schoolId: selectedSchool,
      reasons: ["informed_absence"],
    });
    const _dayPreAbsentIds = new Set(
      _dayPreAbsentEntries.filter(e => e.studentId).map(e => e.studentId)
    );
    const _rawNewDayLessons = result.lessons.filter(l => l.day === targetDay);
    const _dayAbsentLessons = _dayPreAbsentIds.size > 0
      ? _rawNewDayLessons.filter(l => !l.isBandSession && !l.isGroup && _dayPreAbsentIds.has(l.studentId))
      : [];
    const newDayLessonsFiltered = _dayPreAbsentIds.size > 0
      ? _rawNewDayLessons.filter(l => l.isBandSession || l.isGroup || !_dayPreAbsentIds.has(l.studentId))
      : _rawNewDayLessons;

    // Get existing weekly data (if any)
    const existing = weeklyTimetables[storageKey];

    // Keep existing lessons for other days (including band sessions), use new results only for target day
    const otherDayLessons = existing ? existing.lessons.filter(l => l.day !== targetDay || l.isBandSession) : [];
    const newDayLessons = newDayLessonsFiltered;
    const otherDayMissed = existing ? existing.missed.filter(m => m.day !== targetDay) : [];
    const newDayMissed = [
      ...result.missed.filter(m => m.day === targetDay).map(m => ({ ...m, enrolmentId: enrolmentIdFor(m.studentId, m.instrument, enrolments, m.groupId) })),
      ..._dayAbsentLessons.map(l => {
        const tallyEntry = _dayPreAbsentEntries.find(e => e.studentId === l.studentId);
        return { ...l, reason: tallyEntry?.reason || "informed_absence", enrolmentId: enrolmentIdFor(l.studentId, l.instrument, enrolments, l.groupId) };
      }),
    ];

    const newDayMissedNormalized = newDayMissed.map(m => {
      const isClashOrCancel = m.reason && (
        m.reason.includes("No available slot") ||
        m.reason.includes("conflict") ||
        m.reason.includes("Cancelled by weekly")
      );
      if (!isClashOrCancel) return m;
      const matchingHint = aiHints.find(h => h.lessonMatch && h.lessonMatch(m));
      const makeupElig = matchingHint?.makeupEligible === false ? false : true;
      return {
        ...m,
        reason: m.reason.includes("Cancelled by weekly") ? "informed_absence" : "timetable_clash",
        reasonDetail: "",
        notes: m.reason || "",
        makeupEligible: makeupElig,
        madeUp: false,
        cardNote: "",
      };
    });

    const mergedLessons = [...otherDayLessons, ...newDayLessons];
    const mergedMissed = [...otherDayMissed, ...newDayMissedNormalized];

    setWeeklyTimetables(prev => ({
      ...prev,
      [storageKey]: { lessons: mergedLessons, missed: mergedMissed, notes: adjustmentNotes, generatedAt: new Date().toISOString() }
    }));

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
    if (!weeklyData) return;
    if (day) {
      // Spec 2 cluster 10 — lane-filter the per-day clear so chip-A trash
      // doesn't nuke chip-B's lessons. Single-lane days behave identically
      // to today (helper returns true for single-lane / zero-lane days).
      const beforeCount = (weeklyData.lessons || []).filter(l => l.day === day && lessonBelongsToViewedLane(l, viewedLanes, teacherCoverage, selectedSchool)).length;
      const clearedLessons = (weeklyData.lessons || []).filter(l => l.day !== day || !lessonBelongsToViewedLane(l, viewedLanes, teacherCoverage, selectedSchool));
      const clearedMissed = (weeklyData.missed || []).filter(m => m.day !== day || !lessonBelongsToViewedLane(m, viewedLanes, teacherCoverage, selectedSchool));
      setWeeklyTimetables(prev => ({
        ...prev,
        [storageKey]: { ...(prev[storageKey] || {}), lessons: clearedLessons, missed: clearedMissed }
      }));
      // Toast mirrors the pill wording. Override-aware via getDayLaneTeacher.
      // Defensive fallback to today's wording if no lane resolves.
      const laneTeacher = getDayLaneTeacher(teacherCoverage, teachers, selectedSchool, day, laneOverrides, weekKey, viewedLanes, temporaryLanes)?.teacher;
      if (laneTeacher) {
        const firstName = laneTeacher.name.split(" ")[0];
        notify(`Cleared ${firstName}'s ${beforeCount} lesson${beforeCount !== 1 ? "s" : ""} on ${day}`);
      } else {
        notify(`${day} cleared`);
      }
    } else {
      setWeeklyTimetables(prev => {
        const updated = { ...prev };
        delete updated[storageKey];
        return updated;
      });
      notify("Week cleared");
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
    const missedEntry = {
      ...lesson,
      enrolmentId: enrolmentIdFor(lesson.studentId, lesson.instrument, enrolments, lesson.groupId),
      reason: "",
      reasonDetail: "",
      notes: "",
      makeupEligible: false,
      madeUp: false,
      cardNote: "",
    };
    // Move lesson to missed area
    setWeeklyTimetables(prev => {
      const entry = prev[storageKey];
      if (!entry) return prev;
      return { ...prev, [storageKey]: { ...entry, lessons: entry.lessons.filter(l => l.id !== lessonId), missed: [...(entry.missed || []), missedEntry] } };
    });
    // Always show the reasons dialog so a reason can be recorded
    setTallyPromptNotes("");
    setTallyPrompt({ lesson, missedEntry, weekKey, weekNum: termWeek });
    setTallyPromptNotes(""); setTallyPromptCategory(null); setTallyPromptReasonDetail(""); setTallyPromptCatchup(null);
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
    const oldDay = lesson?.day;
    if (!lesson) return;
    // Spec 2 cluster 10b Commit 2 — Q2=β WTT lane-only stamp via
    // getDayLaneTeacher (override-aware). No modal regardless of teacher
    // match; the chip-active lane determines bucket_id and teacherName stamp.
    // Effective teacher rendering picks up via cluster 6b1 override-aware
    // resolution at render time.
    const destLane = getDayLaneTeacher(teacherCoverage, teachers, lesson.schoolId, newDay, laneOverrides, weekKey, viewedLanes, temporaryLanes);
    if (!destLane || !destLane.lane) {
      if (notify) notify(`No covering lane for ${currentSchool.name} on ${newDay}.`, "warning");
      return;
    }
    const destBucketId = destLane.lane.id;
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
            bucket_id: destBucketId,
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
      const warnings = checkConstraints(lesson, newDay, slot, simulatedLessons, { weekKey, selectedSchool, currentSchool, weeklyTimetables, teacherCoverage, laneOverrides, students, enrolments, teachers, schools, bands, groups, weekDateMap, weekInterruptions, specLookupRef, timetable });
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
          const recomputed = checkConstraints(wl, wl.day, wlSlot, simulatedLessons, { weekKey, selectedSchool, currentSchool, weeklyTimetables, teacherCoverage, laneOverrides, students, enrolments, teachers, schools, bands, groups, weekDateMap, weekInterruptions, specLookupRef, timetable });
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
    // Spec 2 cluster 10b Commit 2 — Q2=β viewedLanes-aware destination.
    // The missed entry's bucket_id was stale on day-change; use the chip-active
    // lane instead. No modal regardless of teacher match (WTT week-scoped).
    const destLane = getDayLaneTeacher(teacherCoverage, teachers, missed.schoolId, newDay, laneOverrides, weekKey, viewedLanes, temporaryLanes);
    if (!destLane || !destLane.lane) {
      if (notify) notify(`No covering lane for ${currentSchool.name} on ${newDay}.`, "warning");
      return;
    }
    const dayDate = weekDates.find(wd => wd.day === newDay);
    const rescuedLesson = {
      ...missed, day: newDay, slotId: slot.id, slotName: slot.name,
      start: slot.start, end: slot.end,
      weekDate: dayDate?.date, adjusted: false, adjustReason: undefined,
      bucket_id: destLane.lane.id,
      teacherName: destLane.teacher?.name || missed.teacherName || "",
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
    const warnings = checkConstraints(rescuedLesson, newDay, slot, undefined, { weekKey, selectedSchool, currentSchool, weeklyTimetables, teacherCoverage, laneOverrides, students, enrolments, teachers, schools, bands, groups, weekDateMap, weekInterruptions, specLookupRef, timetable });
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
    notify(`${missed.isGroup ? missed.groupName : missed.studentName} rescheduled to ${newDay} ${slot.start}`);
  };

  // Place a staged catch-up card onto the grid at a specific slot.
  // Spec 3 cluster 12a — async because solo placement awaits insertCatchup.
  // The drop call site (cell onDrop, "staged:" branch) doesn't await; errors
  // surface via the inner try/catch with notify + alert.
  const handlePlaceStagedCatchup = async (stagedId, newDay, newTime) => {
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
      // Spec 2 cluster 4c — lane lookup before stamping bucket_id.
      const dropBucketId = band.teacherId
        ? findLaneId(teacherCoverage, band.schoolId, newDay, band.teacherId)
        : null;
      if (!dropBucketId) {
        const sName = schools.find(s => s.id === band.schoolId)?.name || band.schoolId;
        if (notify) notify(`No covering lane for ${teacher?.name || "(unassigned)"} at ${sName} on ${newDay}. Add staff first.`, "warning");
        return;
      }
      const bandLesson = {
        id: staged.id, isBandSession: true, bandId: band.id, bandName: band.name,
        schoolId: band.schoolId, bucket_id: dropBucketId,
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
      const bWarnings = checkConstraints(bandLesson, newDay, slot, lessons, { weekKey, selectedSchool, currentSchool, weeklyTimetables, teacherCoverage, laneOverrides, students, enrolments, teachers, schools, bands, groups, weekDateMap, weekInterruptions, specLookupRef, timetable });
      if (bWarnings.length > 0) {
        setConstraintWarnings(prev => ({ ...prev, [bandLesson.id]: bWarnings }));
        setExpandedWarnings(prev => { const next = new Set(prev); next.add(bandLesson.id); return next; });
      }
      notify(`Band session placed: ${band.name} — ${newDay} ${slot.start}`);
      return;
    }

    // Spec 3 cluster 12a — solo catchup placement persists to the catchups
    // table via insertCatchup, not the weekly_adjustments.lessons JSONB. The
    // enrichedCatchups site (L4544) stamps bucket_id at render time from the
    // destination lane, so first-drop teacher attribution resolves correctly
    // without re-drop. Mirrors handleScheduleCatchup at L979-1014. Dev-mode
    // wrapper handling lives in insertCatchup per cluster 5b-3a final addendum.
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.id) throw new Error("Not authenticated");
      const weekKey = storageKey.split("|")[0];
      const inserted = await insertCatchup({
        userId: user.id,
        schoolId: staged.schoolId,
        weekKey,
        day: newDay,
        time: newTime,
        instrument: staged.instrument,
        enrolmentId: staged.resolvesEnrolmentId,
        resolvesEnrolmentId: staged.resolvesEnrolmentId,
        resolvesWeekKey: staged.resolvesWeekKey,
        resolvesOriginalDay: staged.resolvesOriginalDay,
        resolvesOriginalTime: staged.resolvesOriginalTime,
      });
      setCatchups(prev => [...prev, inserted]);
      setWeeklyTimetables(prev => {
        const entry = prev[storageKey];
        if (!entry) return prev;
        return {
          ...prev,
          [storageKey]: {
            ...entry,
            catchupStaged: (entry.catchupStaged || []).filter(c => c.id !== stagedId),
          },
        };
      });
      if (notify) notify("Catch-up lesson placed: " + (staged.studentName || "") + " " + newDay + " " + newTime);
    } catch (err) {
      logError && logError("Failed to place catchup", err?.message || String(err));
      console.error("[catchup place] failed:", err);
      alert("Failed to place catchup. See console.");
    }
  };

  // Confirm a catch-up day — marks tally entries and locks the day
  // Missed tally grouped by student+instrument — derived from WTT.missed across all weeks.
  // WTT.missed entries don't carry a `status` field (status is implicit from the
  // missed array itself), so no status filter is needed. weekLabel is also absent
  // on WTT.missed; weeks[] degrades to weekKey only (audit-acknowledged).
  const tallyByStudent = {};
  for (const e of getMissedEntries({ weeklyTimetables })) {
    if (e.schoolId === "__private__") continue; // private students have their own tally panel
    const k = `${e.studentId}|${e.instrument}`;
    if (!tallyByStudent[k]) tallyByStudent[k] = { ...e, count: 0, weeks: [] };
    tallyByStudent[k].count++;
    tallyByStudent[k].weeks.push(e.weekLabel || e.weekKey || "?");
  }

  return (
    <div onClick={() => { setHoverNotes(null); if (contextMenu) { setContextMenu(null); setMissedZoneSubmenu(null); setDayHeaderSubmenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); setSwapTeacherSubmenu(null); } if (expandedWarnings.size > 0) setExpandedWarnings(new Set()); }} >

      {/* Tally prompt — shown when lesson is manually dragged to missed area */}
      {tallyPrompt && (() => {
        const closeBoth = () => { setTallyPrompt(null); setTallyConfirm(null); };
        const lesson = tallyPrompt.lesson;
        const handleTpCategory = (cat) => {
          const newCat = tallyPromptCategory === cat ? null : cat;
          setTallyPromptCategory(newCat);
          if (newCat === "uninformed_absence") setTallyPromptCatchup(false);
          else if (newCat) setTallyPromptCatchup(true);
        };
        const tpShowDetailsBorder = tallyPromptReasonDetail.trim().toLowerCase() === "other";
        const tpCanSave = tallyPromptCatchup !== null;
        const saveAndConfirm = () => {
          const finalReason = tallyPromptCategory || "other";
          const finalReasonDetail = tallyPromptReasonDetail.trim();
          const finalDetails = tallyPromptNotes.trim();
          const finalMakeup = tallyPromptCatchup === true;
          if (finalReasonDetail && finalReasonDetail.toLowerCase() !== "other" && !rememberedReasons.includes(finalReasonDetail)) {
            saveRememberedReasons([finalReasonDetail, ...rememberedReasons]);
          }
          const lKey = lesson.isGroup ? `group|${lesson.groupId}` : `${lesson.studentId}|${lesson.instrument}`;
          setWeeklyTimetables(prev => {
            const wEntry = prev[storageKey];
            if (!wEntry) return prev;
            return {
              ...prev,
              [storageKey]: {
                ...wEntry,
                missed: (wEntry.missed || []).map(m => m.id === lesson.id ? {
                  ...m,
                  reason: finalReason,
                  reasonDetail: finalReasonDetail,
                  notes: finalDetails,
                  makeupEligible: finalMakeup,
                  madeUp: m.madeUp || false,
                } : m)
              }
            };
          });
          const displayReason = getMissedReasonLabel(finalReason, finalReasonDetail) || "Other";
          notify(`Missed lesson recorded${displayReason ? ": " + displayReason : ""}`);
          setTallyPrompt(null); setTallyConfirm(null);
        };
        const catBtnStyle = (val) => ({
          width: "100%", padding: "11px 14px", marginBottom: 6, borderRadius: 8, fontSize: 13,
          fontWeight: tallyPromptCategory === val ? 700 : 500, cursor: "pointer", fontFamily: "inherit",
          transition: "all 0.12s", textAlign: "left",
          border: `1.5px solid ${tallyPromptCategory === val ? colors.sidebarActive : colors.border}`,
          background: tallyPromptCategory === val ? "rgba(52,69,101,0.1)" : colors.cardBg,
          color: tallyPromptCategory === val ? colors.sidebarActive : colors.text,
        });
        const catchupBtnStyle = (val) => ({
          width: 34, height: 34, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", fontFamily: "inherit", transition: "all 0.12s", flexShrink: 0,
          border: `1.5px solid ${tallyPromptCatchup === val ? colors.sidebarActive : colors.border}`,
          background: tallyPromptCatchup === val ? "rgba(52,69,101,0.1)" : colors.cardBg,
          color: tallyPromptCatchup === val ? colors.sidebarActive : colors.textMuted,
        });
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={closeBoth}>
            <div style={{ background: colors.cardBg, borderRadius: 14, padding: 22, width: 360, boxShadow: "0 20px 60px rgba(0,0,0,0.22)", maxHeight: "90vh", overflowY: "auto" }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, marginBottom: 3 }}>
                {lesson.isGroup ? (lesson.groupName || "Group") : lesson.studentName}
              </div>
              <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 16 }}>
                {lesson.instrument} · {lesson.day} · {weekLabel}
              </div>
              <input
                list="tp-reasons-list"
                value={tallyPromptReasonDetail}
                onChange={e => setTallyPromptReasonDetail(e.target.value)}
                placeholder="Reason (e.g. swimming, excursion…)"
                style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", marginBottom: 10,
                  border: `1.5px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13,
                  fontFamily: "inherit", color: colors.text, background: colors.cardBg, outline: "none" }}
                onFocus={e => e.target.style.borderColor = colors.sidebarActive}
                onBlur={e => e.target.style.borderColor = colors.inputBorder}
              />
              <datalist id="tp-reasons-list">
                {rememberedReasons.map(r => <option key={r} value={r} />)}
                <option value="Other" />
              </datalist>
              {[
                { value: "informed_absence", label: "Informed Absence" },
                { value: "uninformed_absence", label: "Uninformed Absence" },
                { value: "teacher_absent", label: "Teacher Absence" },
              ].map(btn => (
                <button key={btn.value} onClick={() => handleTpCategory(btn.value)} style={catBtnStyle(btn.value)}
                  onMouseEnter={e => { if (tallyPromptCategory !== btn.value) e.currentTarget.style.background = colors.blueLight; }}
                  onMouseLeave={e => { if (tallyPromptCategory !== btn.value) e.currentTarget.style.background = colors.cardBg; }}>
                  {btn.label}
                </button>
              ))}
              <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, marginTop: 10, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.3 }}>Details</div>
              <textarea
                value={tallyPromptNotes}
                onChange={e => setTallyPromptNotes(e.target.value)}
                placeholder="Optional — unusual circumstances, notes for your records…"
                rows={3}
                style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", resize: "vertical",
                  border: `1.5px solid ${tpShowDetailsBorder ? colors.sidebarActive : colors.inputBorder}`,
                  borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text,
                  background: colors.cardBg, outline: "none", lineHeight: 1.5, marginBottom: 14 }}
                onFocus={e => e.target.style.borderColor = colors.sidebarActive}
                onBlur={e => e.target.style.borderColor = tpShowDetailsBorder ? colors.sidebarActive : colors.inputBorder}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: colors.text }}>Catch Up</span>
                <button style={catchupBtnStyle(true)} onClick={() => setTallyPromptCatchup(tallyPromptCatchup === true ? null : true)}
                  onMouseEnter={e => { if (tallyPromptCatchup !== true) e.currentTarget.style.background = colors.blueLight; }}
                  onMouseLeave={e => { if (tallyPromptCatchup !== true) e.currentTarget.style.background = colors.cardBg; }}>
                  <Check size={14} />
                </button>
                <button style={catchupBtnStyle(false)} onClick={() => setTallyPromptCatchup(tallyPromptCatchup === false ? null : false)}
                  onMouseEnter={e => { if (tallyPromptCatchup !== false) e.currentTarget.style.background = colors.blueLight; }}
                  onMouseLeave={e => { if (tallyPromptCatchup !== false) e.currentTarget.style.background = colors.cardBg; }}>
                  <X size={14} />
                </button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={closeBoth}
                  style={{ flex: 1, padding: "9px 0", borderRadius: 8, background: colors.tagBg, color: colors.gray700, fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.border}
                  onMouseLeave={e => e.currentTarget.style.background = colors.tagBg}>
                  Cancel
                </button>
                <button onClick={saveAndConfirm} disabled={!tpCanSave}
                  style={{ flex: 1, padding: "9px 0", borderRadius: 8, fontWeight: 700, fontSize: 13, border: "none",
                    cursor: tpCanSave ? "pointer" : "not-allowed", fontFamily: "inherit", transition: "all 0.12s",
                    background: tpCanSave ? colors.sidebarActive : colors.border,
                    color: tpCanSave ? "#fff" : colors.textMuted, opacity: tpCanSave ? 1 : 0.6 }}>
                  Save
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Unified missed lesson modal — single (right-click) and bulk (multi-select) */}
      {missedModal && (() => {
        const isBulk = missedModal.type === "bulk";
        const { lesson, weekKey: mmWeekKey, category, reasonDetail, catchup, details } = missedModal;
        const selLessons = isBulk ? (weeklyData?.lessons || []).filter(l => missedModal.lessonIds.includes(l.id)) : null;
        const tBreaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));
        const wNum = computeTermWeekNum(mmWeekKey, tBreaks);
        const mmWeekLabel = wNum ? `Week ${wNum}` : `Week of ${mmWeekKey}`;
        const setField = (field, val) => setMissedModal(prev => ({ ...prev, [field]: val }));
        const handleCategory = (cat) => {
          const newCat = category === cat ? null : cat;
          const newCatchup = newCat === "uninformed_absence" ? false : newCat ? true : catchup;
          setMissedModal(prev => ({ ...prev, category: newCat, catchup: newCatchup }));
        };
        const showDetailsBorder = reasonDetail.trim().toLowerCase() === "other";
        const canSave = catchup !== null;
        const handleSave = () => {
          const now = new Date().toISOString();
          const finalReason = category || "other";
          const finalReasonDetail = reasonDetail.trim();
          const finalDetails = details.trim();
          const finalMakeup = catchup === true;
          if (finalReasonDetail && finalReasonDetail.toLowerCase() !== "other" && !rememberedReasons.includes(finalReasonDetail)) {
            saveRememberedReasons([finalReasonDetail, ...rememberedReasons]);
          }
          if (isBulk) {
            setWeeklyTimetables(prev => {
              const out = { ...prev };
              for (const l of selLessons) {
                const sk = mmWeekKey + "|" + l.schoolId;
                const data = out[sk] || { lessons: [], missed: [] };
                const newMissedEntry = {
                  ...l,
                  enrolmentId: enrolmentIdFor(l.studentId, l.instrument, enrolments, l.groupId),
                  reason: finalReason,
                  reasonDetail: finalReasonDetail,
                  notes: finalDetails,
                  makeupEligible: finalMakeup,
                  madeUp: false,
                  cardNote: "",
                };
                out[sk] = {
                  ...data,
                  lessons: data.lessons.filter(ll => ll.id !== l.id),
                  missed: [...(data.missed || []), newMissedEntry],
                };
              }
              return out;
            });
            setMissedModal(null); setSelectedCards(new Set());
            notify(`${selLessons.length} lessons marked missed`);
          } else {
            setWeeklyTimetables(prev => {
              const wEntry = prev[storageKey];
              if (!wEntry) return prev;
              return {
                ...prev,
                [storageKey]: {
                  ...wEntry,
                  missed: (wEntry.missed || []).map(m => m.id === lesson.id ? {
                    ...m,
                    reason: finalReason,
                    reasonDetail: finalReasonDetail,
                    notes: finalDetails,
                    makeupEligible: finalMakeup,
                    madeUp: m.madeUp && finalMakeup,
                  } : m)
                }
              };
            });
            setMissedModal(null);
          }
        };
        const catBtnStyle = (val) => ({
          width: "100%", padding: "11px 14px", marginBottom: 6, borderRadius: 8, fontSize: 13,
          fontWeight: category === val ? 700 : 500, cursor: "pointer", fontFamily: "inherit",
          transition: "all 0.12s", textAlign: "left",
          border: `1.5px solid ${category === val ? colors.sidebarActive : colors.border}`,
          background: category === val ? "rgba(52,69,101,0.1)" : colors.cardBg,
          color: category === val ? colors.sidebarActive : colors.text,
        });
        const catchupBtnStyle = (val) => ({
          width: 34, height: 34, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", fontFamily: "inherit", transition: "all 0.12s", flexShrink: 0,
          border: `1.5px solid ${catchup === val ? colors.sidebarActive : colors.border}`,
          background: catchup === val ? "rgba(52,69,101,0.1)" : colors.cardBg,
          color: catchup === val ? colors.sidebarActive : colors.textMuted,
        });
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setMissedModal(null)}>
            <div style={{ background: colors.cardBg, borderRadius: 14, padding: 22, width: 360, boxShadow: "0 20px 60px rgba(0,0,0,0.22)", maxHeight: "90vh", overflowY: "auto" }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, marginBottom: 3 }}>
                {isBulk ? `Mark ${selLessons.length} lessons missed` : (lesson.isGroup ? (lesson.groupName || "Group") : lesson.studentName)}
              </div>
              <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 16 }}>
                {isBulk ? selLessons.map(l => l.studentName || l.groupName).join(", ") : `${lesson.instrument} · ${lesson.day} · ${mmWeekLabel}`}
              </div>
              <input
                list="mm-reasons-list"
                value={reasonDetail}
                onChange={e => setField("reasonDetail", e.target.value)}
                placeholder="Reason (e.g. swimming, excursion…)"
                style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", marginBottom: 10,
                  border: `1.5px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13,
                  fontFamily: "inherit", color: colors.text, background: colors.cardBg, outline: "none" }}
                onFocus={e => e.target.style.borderColor = colors.sidebarActive}
                onBlur={e => e.target.style.borderColor = colors.inputBorder}
              />
              <datalist id="mm-reasons-list">
                {rememberedReasons.map(r => <option key={r} value={r} />)}
                <option value="Other" />
              </datalist>
              {[
                { value: "informed_absence", label: "Informed Absence" },
                { value: "uninformed_absence", label: "Uninformed Absence" },
                { value: "teacher_absent", label: "Teacher Absence" },
              ].map(btn => (
                <button key={btn.value} onClick={() => handleCategory(btn.value)} style={catBtnStyle(btn.value)}
                  onMouseEnter={e => { if (category !== btn.value) e.currentTarget.style.background = colors.blueLight; }}
                  onMouseLeave={e => { if (category !== btn.value) e.currentTarget.style.background = colors.cardBg; }}>
                  {btn.label}
                </button>
              ))}
              <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, marginTop: 10, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.3 }}>Details</div>
              <textarea
                value={details}
                onChange={e => setField("details", e.target.value)}
                placeholder="Optional — unusual circumstances, notes for your records…"
                rows={3}
                style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", resize: "vertical",
                  border: `1.5px solid ${showDetailsBorder ? colors.sidebarActive : colors.inputBorder}`,
                  borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text,
                  background: colors.cardBg, outline: "none", lineHeight: 1.5, marginBottom: 14 }}
                onFocus={e => e.target.style.borderColor = colors.sidebarActive}
                onBlur={e => e.target.style.borderColor = showDetailsBorder ? colors.sidebarActive : colors.inputBorder}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: colors.text }}>Catch Up</span>
                <button style={catchupBtnStyle(true)} onClick={() => setField("catchup", catchup === true ? null : true)}
                  onMouseEnter={e => { if (catchup !== true) e.currentTarget.style.background = colors.blueLight; }}
                  onMouseLeave={e => { if (catchup !== true) e.currentTarget.style.background = colors.cardBg; }}>
                  <Check size={14} />
                </button>
                <button style={catchupBtnStyle(false)} onClick={() => setField("catchup", catchup === false ? null : false)}
                  onMouseEnter={e => { if (catchup !== false) e.currentTarget.style.background = colors.blueLight; }}
                  onMouseLeave={e => { if (catchup !== false) e.currentTarget.style.background = colors.cardBg; }}>
                  <X size={14} />
                </button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setMissedModal(null)}
                  style={{ flex: 1, padding: "9px 0", borderRadius: 8, background: colors.tagBg, color: colors.gray700, fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.border}
                  onMouseLeave={e => e.currentTarget.style.background = colors.tagBg}>
                  Cancel
                </button>
                <button onClick={handleSave} disabled={!canSave}
                  style={{ flex: 1, padding: "9px 0", borderRadius: 8, fontWeight: 700, fontSize: 13, border: "none",
                    cursor: canSave ? "pointer" : "not-allowed", fontFamily: "inherit", transition: "all 0.12s",
                    background: canSave ? colors.sidebarActive : colors.border,
                    color: canSave ? "#fff" : colors.textMuted, opacity: canSave ? 1 : 0.6 }}>
                  Save
                </button>
              </div>
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
            <div style={{ position: "fixed", left, top, zIndex: 10101, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.18)", padding: 14, width: POPUP_W }}
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

      {/* Right-click context menu */}
      {contextMenu && (
        <div ref={contextMenuRef} style={{ position: "fixed", ...((contextMenu.fromMissed || contextMenu.isCatchupStage || contextMenu.isMissedZone) ? { bottom: window.innerHeight - contextMenu.y + 4, top: "auto" } : (contextMenu.y + 160 > window.innerHeight ? { bottom: window.innerHeight - contextMenu.y + 4, top: "auto" } : { top: contextMenu.y })), left: clampMenuPos(contextMenu.x, contextMenu.y, 220, 0).left, zIndex: 9999, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 200 }}
          onClick={e => e.stopPropagation()}>
          {contextMenu.fromMissed ? (() => {
            const missedIdx = (weeklyData?.missed || []).findIndex(m => m.id === contextMenu.lessonId);
            const missedLesson = missedIdx >= 0 ? weeklyData.missed[missedIdx] : null;
            if (!missedLesson) return null;
            const currentReason = missedLesson.reason || null;
            const currentReasonDetail = missedLesson.reasonDetail || "";
            const currentReasonLabel = currentReason ? getMissedReasonLabel(currentReason, currentReasonDetail) : null;
            const missedSt = !missedLesson.isGroup ? students.find(s => s.id === missedLesson.studentId) : null;
            const parentEmails = missedSt ? getParentEmails(missedSt) : [];
            const school = schools.find(s => s.id === (missedLesson.schoolId || selectedSchool));
            return (
              <div style={{ padding: "4px 0", minWidth: 210 }}>
                <div style={{ padding: "6px 12px 6px", fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${colors.borderLight}` }}>
                  {missedLesson.isGroup ? (missedLesson.groupName || "Group") : missedLesson.studentName}
                </div>
                {currentReasonLabel && (
                  <div style={{ padding: "5px 12px 3px", fontSize: 11, color: colors.textMuted, display: "flex", alignItems: "center", gap: 5 }}>
                    <Check size={10} style={{ flexShrink: 0, color: colors.textMuted }} /> {currentReasonLabel}
                  </div>
                )}
                <button
                  onClick={() => { setMissedModal({ type: "single", missedIndex: missedIdx, lesson: missedLesson, weekKey, category: missedLesson.reason || null, reasonDetail: missedLesson.reasonDetail || "", catchup: missedLesson.makeupEligible === true ? true : missedLesson.makeupEligible === false ? false : null, details: missedLesson.notes || "" }); setContextMenu(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <StickyNote size={13} style={{ flexShrink: 0, color: colors.textMuted }} /> {currentReason ? "Edit reason…" : "Add reason…"}
                </button>
                {parentEmails.length > 0 && (
                  <button
                    onClick={() => {
                      const tmpl = getEmailTemplates()[currentReason] || getEmailTemplates().other;
                      const parentName = (missedSt?.parents?.[0]?.name || "").split(" ")[0] || "there";
                      const resolved = resolveTemplate(tmpl, {
                        studentName: preferredFirstName(missedLesson.studentName),
                        parentName: preferredFirstName(parentName) || "there",
                        instrument: missedLesson.instrument || "",
                        day: missedLesson.day || "",
                        weekLabel: weekLabel || "",
                        teacherName: missedLesson.teacherName || "",
                        schoolName: school?.name || "",
                        absenceReason: missedLesson.reasonDetail || "",
                      });
                      openCompose(parentEmails, { subject: resolved.subject, body: resolved.body, from: school?.senderEmail || "", triggerId: "tally_missed" });
                      setContextMenu(null);
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit" }}
                    onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}>
                    <Mail size={13} style={{ flexShrink: 0, color: colors.textMuted }} /> Email parent
                  </button>
                )}
                <div style={{ height: 1, background: colors.borderLight, margin: "3px 8px" }} />
                <button
                  onClick={() => {
                    setWeeklyTimetables(prev => {
                      const entry = prev[storageKey];
                      if (!entry) return prev;
                      const newMissed = entry.missed.filter((_, i) => i !== missedIdx);
                      return { ...prev, [storageKey]: { ...entry, missed: newMissed } };
                    });
                    setContextMenu(null);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><X size={13} /> Remove from missed</span>
                </button>
              </div>
            );
          })() : contextMenu.isDayHeader ? (() => {
            const day = contextMenu.day;
            // Aggregate across all selected days, or just the right-clicked day
            const activeDays = selectedDays.size > 0 ? [...selectedDays] : [day];
            // Spec 2 cluster 10 — lane-filter the day-header email aggregation.
            // Per-lesson because multi-day select means each lesson's day has
            // its own viewed lane.
            const dayLessons = (weeklyData?.lessons || []).filter(l => {
              if (!activeDays.includes(l.day)) return false;
              return lessonBelongsToViewedLane(l, viewedLanes, teacherCoverage, selectedSchool);
            });
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
              const tid = getLiveTeacherId(l, students, enrolments, teacherCoverage, laneOverrides, weekKey);
              const t = teachers.find(x => x.id === tid);
              if (!t) return;
              // Add BOTH the app email and the personal email as recipients;
              // skip whichever is blank so we never add an empty recipient.
              [t.email, t.personalEmail].forEach(em => {
                if (em && !staffEmailSet.has(em)) {
                  staffEmailSet.add(em);
                  staffRows.push({ name: t.name || em, email: em, color: t.color || null });
                }
              });
            });
            const allStaffEmails = [...staffEmailSet];

            const subMenuW = 210;
            const menuRect = contextMenuRef.current ? contextMenuRef.current.getBoundingClientRect() : null;
            const menuRight = menuRect ? menuRect.right : contextMenu.x + 220;
            const menuLeft = menuRect ? menuRect.left : contextMenu.x;
            const subX = menuRight + subMenuW > window.innerWidth ? menuLeft - subMenuW : menuRight;

            const keepDayHeaderOpen = () => { if (dayHeaderHideTimer.current) clearTimeout(dayHeaderHideTimer.current); };
            const scheduleDayHeaderClose = () => { dayHeaderHideTimer.current = setTimeout(() => setDayHeaderSubmenu(null), 200); };

            // Session 8 follow-up Item 3 — auto-attach the day's portrait
            // single-day export to whichever email handler the user picks
            // from the day-header menu. Fold into the existing handlers
            // (Parents / Class Teachers / Staff, group + individual). Matt's
            // escape hatch is removing the chip from the compose modal
            // before sending. Failure to render the attachment is non-fatal:
            // open the compose modal anyway and notify.
            const composeForDay = async (emails, openOpts, useSequential) => {
              let atts = null;
              try {
                const schoolForExport = schools.find(s => s.id === selectedSchool);
                const exportTitle = `${weekLabel} Timetable — ${schoolForExport?.name || "School"} — ${day}`;
                const html = generateExportHtml(
                  weeklyData?.lessons || [],
                  students, schools, teachers,
                  {
                    schoolId: selectedSchool,
                    day,
                    title: exportTitle,
                    specialists: specialists || null,
                    teacherCoverage,
                    enrolments,
                    laneOverrides,
                    weekKey,
                    weekLabel,
                    schoolShortName: schoolForExport ? getSchoolAcronym(schoolForExport) : "",
                    breaks: weeklyData?.breaks || [],
                  }
                );
                if (html) {
                  const filenameBase = buildExportFilename({
                    weekLabel,
                    day,
                    schoolShortName: schoolForExport ? getSchoolAcronym(schoolForExport) : "",
                  });
                  const pdfBase64 = await electronPrintToPdf(html);
                  if (pdfBase64) {
                    atts = [{ filename: filenameBase + ".pdf", contentBase64: pdfBase64, mimeType: "application/pdf" }];
                  } else {
                    const contentBase64 = btoa(unescape(encodeURIComponent(html)));
                    atts = [{ filename: filenameBase + ".html", contentBase64, mimeType: "text/html" }];
                  }
                }
              } catch (e) {
                notify && notify("Couldn't attach the day's timetable — " + (e?.message || "unknown error"), "warning", 4000);
              }
              const finalOpts = atts ? Object.assign({}, openOpts, { attachments: atts }) : openOpts;
              if (useSequential) openGmailSequential(emails, finalOpts);
              else openCompose(emails, finalOpts);
            };

            const DaySubPanel = ({ type, rows, allEmails, color, multi, schoolSender }) => {
              if (!dayHeaderSubmenu || dayHeaderSubmenu.type !== type || !rows.length) return null;
              const btn = (c) => ({ display: "flex", alignItems: "center", width: "100%", padding: "8px 14px", background: "none", border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: c, fontWeight: 400 });
              const hov = (e) => e.currentTarget.style.background = colors.bg;
              const unhov = (e) => e.currentTarget.style.background = "none";
              return (
                <div ref={dayHeaderSubRef}
                  onMouseEnter={keepDayHeaderOpen}
                  onMouseLeave={scheduleDayHeaderClose}
                  style={{ position: "fixed", top: dayHeaderSubmenu.y, left: subX, zIndex: 10002, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, maxHeight: 300, overflowY: "auto", padding: "4px 0" }}>
                  {multi && <button onClick={() => { setContextMenu(null); setDayHeaderSubmenu(null); composeForDay(allEmails, { from: schoolSender, triggerId: "wtt_day_header" }, false); }} style={btn(color)} onMouseEnter={hov} onMouseLeave={unhov}>Group</button>}
                  {multi && <button onClick={() => { setContextMenu(null); setDayHeaderSubmenu(null); composeForDay(allEmails, { from: schoolSender }, true); }} style={btn(color)} onMouseEnter={hov} onMouseLeave={unhov}>Individually</button>}
                  {multi && rows.length > 0 && <div style={{ height: 1, background: colors.borderLight, margin: "3px 8px" }} />}
                  {rows.map((r, i) => (
                    <button key={i} onClick={() => { setContextMenu(null); setDayHeaderSubmenu(null); composeForDay([r.email], { from: schoolSender, triggerId: "wtt_day_header" }, false); }}
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
                      onClick={() => { setContextMenu(null); setDayHeaderSubmenu(null); composeForDay(allEmails, { from: schoolSender, triggerId: "wtt_day_header" }, false); }}
                      onMouseEnter={e => {
                        keepDayHeaderOpen();
                        e.currentTarget.style.background = colors.bg;
                        if (!isOpen) setDayHeaderSubmenu({ type, y: e.currentTarget.getBoundingClientRect().top });
                      }}
                      onMouseLeave={e => { e.currentTarget.style.background = "none"; scheduleDayHeaderClose(); }}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color, fontFamily: "inherit", fontWeight: 600 }}>
                      <span>{label} ({allEmails.length})</span>
                      <ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                    </button>
                  ) : (
                    <button
                      onClick={() => { setContextMenu(null); setDayHeaderSubmenu(null); composeForDay(allEmails, { from: schoolSender, triggerId: "wtt_day_header" }, false); }}
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
                {/* Spec 2 cluster 6c — Substitute teacher (single-day; cluster 9a Q8 — viewed-lane aware) */}
                {(() => {
                  if (isLocked) return null;
                  const dayLanes = getDayLanes(teacherCoverage, selectedSchool, day, temporaryLanes, weekKey);
                  if (dayLanes.length === 0) return null;
                  const storedLaneId = viewedLanes?.[selectedSchool]?.[day];
                  const targetLane = (storedLaneId && dayLanes.find(l => l.id === storedLaneId)) || dayLanes[0];
                  const originalTeacher = teachers.find(t => t.id === targetLane.teacherId);
                  if (!originalTeacher) return null;
                  const existingOverride = laneOverrides.find(o => o.weekKey === weekKey && o.bucketId === targetLane.id);
                  const overrideTeacher = existingOverride ? teachers.find(t => t.id === existingOverride.overrideTeacherId) : null;
                  const availTeachers = teachers.filter(t => t.id !== originalTeacher.id);
                  if (availTeachers.length === 0 && !existingOverride) return null;
                  const isOpen = dayHeaderSubmenu?.type === "substitute";
                  const triggerLabel = existingOverride && overrideTeacher ? `Substitute: ${overrideTeacher.name.split(" ")[0]}` : "Set substitute";
                  return (
                    <>
                      <div style={{ height: 1, background: colors.borderLight, margin: "4px 8px" }} />
                      <div style={{ position: "relative" }}>
                        {isOpen && (
                          <div ref={dayHeaderSubRef}
                            onMouseEnter={keepDayHeaderOpen}
                            onMouseLeave={scheduleDayHeaderClose}
                            style={{ position: "fixed", top: dayHeaderSubmenu.y, left: subX, zIndex: 10002, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, maxHeight: 300, overflowY: "auto", padding: "4px 0" }}>
                            {existingOverride && (
                              <button onClick={() => { onClearLaneOverride && onClearLaneOverride(weekKey, targetLane.id); setContextMenu(null); setDayHeaderSubmenu(null); }}
                                style={{ display: "flex", width: "100%", padding: "7px 12px", background: "none", border: "none", fontSize: 12, cursor: "pointer", color: colors.danger, fontFamily: "inherit" }}
                                onMouseEnter={e => e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><X size={13} /> Restore {originalTeacher.name.split(" ")[0]}</span>
                              </button>
                            )}
                            {availTeachers.map(t => (
                              <button key={t.id} onClick={() => { onSetLaneOverride && onSetLaneOverride(weekKey, targetLane.id, t.id); setContextMenu(null); setDayHeaderSubmenu(null); }}
                                style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "7px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit" }}
                                onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                {t.color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: t.color, flexShrink: 0, display: "inline-block" }} />}
                                {t.name.split(" ")[0]}
                              </button>
                            ))}
                          </div>
                        )}
                        <button
                          onMouseEnter={e => {
                            keepDayHeaderOpen();
                            e.currentTarget.style.background = colors.bg;
                            if (!isOpen) setDayHeaderSubmenu({ type: "substitute", y: e.currentTarget.getBoundingClientRect().top });
                          }}
                          onMouseLeave={e => { e.currentTarget.style.background = "none"; scheduleDayHeaderClose(); }}
                          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.textLight, fontFamily: "inherit" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><RefreshCw size={13} /> {triggerLabel}</span>
                          <ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                        </button>
                      </div>
                    </>
                  );
                })()}
                {/* Temporary-lanes session 3 — Add Teacher. Unconditional on
                    day headers (works on empty days, unlike the lane-gated
                    Substitute item). weekKey/selectedSchool come from
                    component scope, mirroring the Substitute submenu. */}
                {(() => {
                  const isOpen = dayHeaderSubmenu?.type === "addteacher";
                  const sortedTeachers = teachers.slice().sort((a, b) => a.name.localeCompare(b.name));
                  return (
                    <>
                      <div style={{ height: 1, background: colors.borderLight, margin: "4px 8px" }} />
                      <div style={{ position: "relative" }}>
                        {isOpen && (
                          <div ref={dayHeaderSubRef}
                            onMouseEnter={keepDayHeaderOpen}
                            onMouseLeave={scheduleDayHeaderClose}
                            style={{ position: "fixed", top: dayHeaderSubmenu.y, left: subX, zIndex: 10002, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, maxHeight: 300, overflowY: "auto", padding: "4px 0" }}>
                            {sortedTeachers.map(t => (
                              <button key={t.id} onClick={() => { handleAddTemporaryTeacher(selectedSchool, day, weekKey, t.id); }}
                                style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "7px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit" }}
                                onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                {t.color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: t.color, flexShrink: 0, display: "inline-block" }} />}
                                {t.name.split(" ")[0]}
                              </button>
                            ))}
                          </div>
                        )}
                        <button
                          onMouseEnter={e => {
                            keepDayHeaderOpen();
                            e.currentTarget.style.background = colors.bg;
                            if (!isOpen) setDayHeaderSubmenu({ type: "addteacher", y: e.currentTarget.getBoundingClientRect().top });
                          }}
                          onMouseLeave={e => { e.currentTarget.style.background = "none"; scheduleDayHeaderClose(); }}
                          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.textLight, fontFamily: "inherit" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Plus size={13} /> Add Teacher</span>
                          <ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                        </button>
                      </div>
                    </>
                  );
                })()}
                {/* Temporary-lanes session 3 — Remove temporary teacher.
                    Conditional: only when a temp lane matches
                    (selectedSchool, contextMenu.day, weekKey). Single →
                    direct action; multiple → submenu. */}
                {(() => {
                  const matching = (temporaryLanes || []).filter(t => t.schoolId === selectedSchool && t.day === day && t.weekKey === weekKey);
                  if (matching.length === 0) return null;
                  if (matching.length === 1) {
                    const lane = matching[0];
                    const tName = teachers.find(t => t.id === lane.teacherId)?.name || "teacher";
                    return (
                      <>
                        <div style={{ height: 1, background: colors.borderLight, margin: "4px 8px" }} />
                        <button onClick={() => { handleRemoveTemporaryLane(lane.id); }}
                          style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, fontFamily: "inherit" }}
                          onMouseEnter={e => e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"}
                          onMouseLeave={e => e.currentTarget.style.background = "none"}>
                          <X size={13} /> Remove temporary teacher: {tName.split(" ")[0]}
                        </button>
                      </>
                    );
                  }
                  const isOpen = dayHeaderSubmenu?.type === "removetemp";
                  return (
                    <>
                      <div style={{ height: 1, background: colors.borderLight, margin: "4px 8px" }} />
                      <div style={{ position: "relative" }}>
                        {isOpen && (
                          <div ref={dayHeaderSubRef}
                            onMouseEnter={keepDayHeaderOpen}
                            onMouseLeave={scheduleDayHeaderClose}
                            style={{ position: "fixed", top: dayHeaderSubmenu.y, left: subX, zIndex: 10002, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, maxHeight: 300, overflowY: "auto", padding: "4px 0" }}>
                            {matching.map(lane => {
                              const tName = teachers.find(t => t.id === lane.teacherId)?.name || "teacher";
                              return (
                                <button key={lane.id} onClick={() => { handleRemoveTemporaryLane(lane.id); }}
                                  style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "7px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, fontFamily: "inherit" }}
                                  onMouseEnter={e => e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"}
                                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                  <X size={12} /> {tName.split(" ")[0]}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <button
                          onMouseEnter={e => {
                            keepDayHeaderOpen();
                            e.currentTarget.style.background = colors.bg;
                            if (!isOpen) setDayHeaderSubmenu({ type: "removetemp", y: e.currentTarget.getBoundingClientRect().top });
                          }}
                          onMouseLeave={e => { e.currentTarget.style.background = "none"; scheduleDayHeaderClose(); }}
                          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, fontFamily: "inherit" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><X size={13} /> Remove temporary teacher</span>
                          <ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            );
          })() : contextMenu.isMissedZone ? (() => {
            const missed = weeklyData.missed || [];
            const scheduleMissedZoneClose = () => { missedZoneHideTimer.current = setTimeout(() => setMissedZoneSubmenu(null), 300); };

            // Group by reasonDetail from tally entry, falling back to "Other"
            const byReason = {};
            for (const m of missed) {
              const key = m.reasonDetail?.trim() || "Other";
              if (!byReason[key]) byReason[key] = [];
              byReason[key].push(m);
            }
            // Sort: named reasons first, "Other" always last
            const reasonGroups = Object.entries(byReason).sort(([a], [b]) => {
              if (a === "Other") return 1;
              if (b === "Other") return -1;
              return a.localeCompare(b);
            });

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

            return (
              <div style={{ padding: "6px 4px" }}>
                <div style={{ padding: "6px 10px", fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${colors.borderLight}` }}>
                  Missed Lessons · {missed.length}
                </div>
                {/* Email section label */}
                {reasonGroups.length > 0 && (
                  <div style={{ padding: "7px 12px 3px", fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    Email
                  </div>
                )}
                {/* Per-reason buttons */}
                {reasonGroups.map(([reasonKey, entries]) => {
                  const groupEmails = missedParentEmails(entries);
                  const isOpen = missedZoneSubmenu && missedZoneSubmenu.reasonValue === reasonKey;
                  return (
                    <div key={reasonKey} style={{ position: "relative" }}>
                      {isOpen && (
                        <div ref={missedZoneSubRef}
                          onMouseEnter={() => { if (missedZoneHideTimer.current) clearTimeout(missedZoneHideTimer.current); }}
                          onMouseLeave={() => { missedZoneHideTimer.current = setTimeout(() => setMissedZoneSubmenu(null), 300); }}
                          style={{ position: "fixed", bottom: window.innerHeight - (missedZoneSubmenu.y + 28), left: subX, zIndex: 10002, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, padding: "6px 4px" }}>
                          <div style={{ padding: "4px 10px 6px", fontSize: 11, color: colors.textMuted, fontWeight: 600, borderBottom: `1px solid ${colors.borderLight}`, marginBottom: 4 }}>
                            {reasonKey} ({entries.length})
                          </div>
                          {/* Group email actions */}
                          {groupEmails.length > 0 && (
                            <div style={{ borderBottom: `1px solid ${colors.borderLight}`, paddingBottom: 4, marginBottom: 4 }}>
                              <button onClick={() => { openCompose(groupEmails, { from: schools.find(s => s.id === selectedSchool)?.senderEmail || "", triggerId: "wtt_missed_parent" }); setContextMenu(null); setMissedZoneSubmenu(null); }}
                                style={{ display: "flex", alignItems: "center", width: "100%", padding: "7px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit" }}
                                onMouseEnter={e => e.currentTarget.style.background = colors.bg} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                Email group (BCC)
                              </button>
                              <button onClick={() => { openGmailSequential(groupEmails, { from: schools.find(s => s.id === selectedSchool)?.senderEmail || "" }); setContextMenu(null); setMissedZoneSubmenu(null); }}
                                style={{ display: "flex", alignItems: "center", width: "100%", padding: "7px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit" }}
                                onMouseEnter={e => e.currentTarget.style.background = colors.bg} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                Email individually
                              </button>
                            </div>
                          )}
                          {/* Individual student list */}
                          {entries.map((m, mi) => {
                            const st = students.find(s => s.id === m.studentId);
                            const pEmails = st ? getParentEmails(st) : [];
                            return (
                              <button key={mi} onClick={() => { if (pEmails.length > 0) { openCompose(pEmails); setContextMenu(null); setMissedZoneSubmenu(null); } }}
                                style={{ display: "flex", alignItems: "center", width: "100%", padding: "7px 12px", background: "none", border: "none", fontSize: 13, cursor: pEmails.length > 0 ? "pointer" : "default", color: colors.text, fontFamily: "inherit", opacity: pEmails.length > 0 ? 1 : 0.45 }}
                                onMouseEnter={e => { if (pEmails.length > 0) e.currentTarget.style.background = colors.bg; }}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                {m.isGroup ? (m.groupName || "Group") : m.studentName}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <button
                        onMouseEnter={e => { e.currentTarget.style.background = colors.bg; if (missedZoneHideTimer.current) clearTimeout(missedZoneHideTimer.current); setMissedZoneSubmenu({ reasonValue: reasonKey, y: e.currentTarget.getBoundingClientRect().top }); }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; scheduleMissedZoneClose(); }}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit" }}>
                        <span>{reasonKey}</span>
                        <span style={{ fontSize: 11, color: colors.textMuted }}>{entries.length === 1 ? "1 student" : `${entries.length} students`} ▶</span>
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
                // Build one row per (student, instrument) pair that has owed make-ups.
                // schoolId filter is on the missed entry's schoolId (audit decision:
                // theoretical-only shift vs students-table school join).
                const eligibleEntries = findOpenCatchups({ weeklyTimetables, schoolId: sId })
                  .map(r => ({ ...r.missed, weekKey: r.weekKey }));
                // Group by studentId + instrument
                const pairMap = {};
                for (const e of eligibleEntries) {
                  const key = e.studentId + "|" + e.instrument;
                  if (!pairMap[key]) pairMap[key] = { studentId: e.studentId, instrument: e.instrument, entries: [] };
                  pairMap[key].entries.push(e);
                }
                const pairs = Object.values(pairMap).sort((a, b) => b.entries.length - a.entries.length || a.instrument.localeCompare(b.instrument));
                if (pairs.length === 0) {
                  return <div style={{ padding: "8px 12px", fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>No students with outstanding make-ups</div>;
                }
                // Track already-staged by studentId+instrument key
                const alreadyStagedKeys = new Set(
                  (weeklyData?.catchupStaged || []).filter(c => !c.isBandSession).map(c => c.studentId + "|" + c.instrument)
                );
                return pairs.map(pair => {
                  const s = students.find(st => st.id === pair.studentId);
                  if (!s) return null;
                  const pairKey = pair.studentId + "|" + pair.instrument;
                  const alreadyStaged = alreadyStagedKeys.has(pairKey);
                  const count = pair.entries.length;
                  const oldest = [...pair.entries].sort((a, b) => (a.weekKey || "").localeCompare(b.weekKey || ""))[0];
                  // Show instrument label only if student has multiple instruments with owed make-ups
                  const studentPairs = pairs.filter(p => p.studentId === pair.studentId);
                  const showInstrument = studentPairs.length > 1;
                  return (
                    <button key={pairKey} onClick={() => {
                      if (alreadyStaged) return;
                      // Spec 2 cluster 4c — staged entry: no day/slot yet, so
                      // bucket_id is deferred until drag-into-slot stamps it.
                      // Spec 3 cluster 12a — forward-carry resolves_* fields +
                      // catchup's own enrolmentId so the drop handler can call
                      // insertCatchup. Catchup's enrolmentId equals its
                      // resolvesEnrolmentId (a make-up resolves the same enrolment).
                      const stagedEnrolmentId = enrolmentIdFor(oldest.studentId, oldest.instrument, enrolments, oldest.groupId);
                      const stagedCard = {
                        id: uid(), studentId: s.id, studentName: s.name,
                        schoolId: sId, schoolName: schools.find(sc => sc.id === sId)?.name || "",
                        instrument: oldest.instrument, teacherId: oldest.teacherId || "", teacherName: oldest.teacherName || "",
                        enrolmentId: stagedEnrolmentId,
                        resolvesEnrolmentId: stagedEnrolmentId,
                        resolvesWeekKey: oldest.weekKey,
                        resolvesOriginalDay: oldest.day,
                        resolvesOriginalTime: oldest.start ?? oldest.time ?? null,
                      };
                      setWeeklyTimetables(prev => {
                        const entry = prev[storageKey] || { lessons: [], missed: [] };
                        return { ...prev, [storageKey]: { ...entry, catchupStaged: [...(entry.catchupStaged || []), stagedCard] } };
                      });
                      setContextMenu(null);
                    }}
                      disabled={alreadyStaged}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: alreadyStaged ? "default" : "pointer", color: alreadyStaged ? colors.textMuted : colors.text, fontFamily: "inherit", textAlign: "left", opacity: alreadyStaged ? 0.5 : 1 }}
                      onMouseEnter={e => { if (!alreadyStaged) e.currentTarget.style.background = colors.bg; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                      <span>{s.name}{showInstrument ? <span style={{ fontSize: 11, color: colors.textMuted, marginLeft: 6 }}>· {pair.instrument}</span> : null}</span>
                      <span style={{ fontSize: 11, color: colors.gray500, whiteSpace: "nowrap" }}>
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
                          // Spec 2 cluster 4c — staged entry: bucket_id deferred until drag-into-slot.
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
                onMouseEnter={e => e.currentTarget.style.background = colors.amberLight} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Coffee size={13} /> Add break</span>
              </button>
              {/* Add Lesson — cascading upward menu */}
              {(() => {
                const sId = contextMenu.schoolId;
                // Spec 3 cluster 5b-3c-a: catchup is always shown via the
                // unified "Schedule catchup…" trigger; the OLD school-scoped
                // hasCatchup precheck is retired. trialStu still gates the
                // Add trial trigger; missing/pending similar.
                const scheduledStudentIds = new Set(
                  Object.values(weeklyTimetables || {}).flatMap(data => (data.lessons || []).map(l => l.studentId))
                );
                const trialStu = students.filter(s => s.schoolId === sId && s.status === "trial" && !scheduledStudentIds.has(s.id));
                const hasTrial = trialStu.length > 0;
            const wkDay = contextMenu.day;
            const wkTime = contextMenu.time;
            const wkDate = (weekDates || []).find(wd => wd.day === wkDay)?.date || "";
            const mttLessons = timetable ? timetable.lessons.filter(l => l.schoolId === sId && !l.isBandSession) : [];
            const wttLessons = (weeklyTimetables[contextMenu.weekKey] || {}).lessons || [];
            const wttMissed = (weeklyTimetables[contextMenu.weekKey] || {}).missed || [];
            // Unified "unscheduled" rule (matches the banner source): a
            // student counts as unscheduled ONLY if they have no presence in
            // the (school, week) — no grid lesson (individual OR group OR
            // band-session member) and no Missed-zone card.
            const missing = mttLessons.filter(ml => {
              if (ml.isGroup) {
                if (wttLessons.some(wl => wl.groupId === ml.groupId)) return false;
                if (wttMissed.some(wm => wm.groupId === ml.groupId)) return false;
                return true;
              }
              if (wttLessons.some(wl => !wl.isBandSession && !wl.isGroup && wl.studentId === ml.studentId && wl.instrument === ml.instrument)) return false;
              if (wttLessons.some(wl => wl.isGroup && (wl.studentIds || []).includes(ml.studentId))) return false;
              if (wttLessons.some(wl => wl.isBandSession && (wl.members || []).some(mb => mb.studentId === ml.studentId))) return false;
              if (wttMissed.some(wm => wm.studentId === ml.studentId && wm.instrument === ml.instrument)) return false;
              return true;
            });
                // Helper to place a lesson directly at the right-clicked slot
                const placeLesson = (s, opts) => {
                  const activeEnrolment = (enrolments || []).find(e =>
                    e.studentId === s.id && !e.endDate && !e.isGroup
                  );
                  if (!activeEnrolment) {
                    if (notify) notify(`${s.name} has no active enrolment — can't place lesson`, "warning");
                    return;
                  }
                  // Spec 2 cluster 10b Commit 2 — Q2=β viewedLanes-aware destination.
                  // opts.teacherId/teacherName are vestigial here; the chip-active
                  // lane determines bucket_id and teacherName stamp. Destination
                  // resolution is override-aware (laneOverrides + weekKey) so a
                  // sub-this-week lane lands in the right place.
                  const { teacherId: _optsTid, teacherName: _optsTname, ...restOpts } = opts || {};
                  const destLane = getDayLaneTeacher(teacherCoverage, teachers, sId, contextMenu.day, laneOverrides, contextMenu.weekKey, viewedLanes, temporaryLanes);
                  if (!destLane || !destLane.lane) {
                    const sName = schools.find(sc => sc.id === sId)?.name || sId;
                    if (notify) notify(`No covering lane for ${sName} on ${contextMenu.day}. Add staff first.`, "warning");
                    return;
                  }
                  const newLesson = {
                    id: uid(), studentId: s.id, studentName: s.name,
                    schoolId: sId, schoolName: schools.find(sc => sc.id === sId)?.name || "",
                    instrument: activeEnrolment.instrument,
                    bucket_id: destLane.lane.id,
                    enrolmentId: activeEnrolment.id,
                    day: contextMenu.day, start: contextMenu.time, end: contextMenu.time,
                    ...restOpts
                  };
                  const wkData = weeklyTimetables[contextMenu.weekKey] || { lessons: [], missed: [] };
                  setWeeklyTimetables(prev => ({ ...prev, [contextMenu.weekKey]: { ...wkData, lessons: [...(wkData.lessons || []), newLesson] } }));
                  const cuSlot = (currentSchool?.slots || []).find(sl => sl.start === contextMenu.time) || { start: contextMenu.time, end: contextMenu.time };
                  const cuWarnings = checkConstraints(newLesson, contextMenu.day, cuSlot, undefined, { weekKey, selectedSchool, currentSchool, weeklyTimetables, teacherCoverage, laneOverrides, students, enrolments, teachers, schools, bands, groups, weekDateMap, weekInterruptions, specLookupRef, timetable });
                  setAckedConstraints(prev => { const next = new Set(prev); next.delete(newLesson.id); return next; });
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
                // Missed this week at this school — keep BOTH individuals and
                // group-shaped entries. Group entries have isGroup/groupId and
                // a null/missing top-level studentId, so we resolve their
                // schoolId via the groups table when m.schoolId isn't set.
                const thisWeekMissed = ((weeklyTimetables[contextMenu.weekKey] || {}).missed || []).filter(m => {
                  if (m.isGroup) {
                    const grp = (groups || []).find(g => g.id === m.groupId);
                    return (m.schoolId || grp?.schoolId) === sId;
                  }
                  return (m.schoolId || (students.find(s => s.id === m.studentId) || {}).schoolId) === sId;
                });
                const missedByStudent = {};
                for (const m of thisWeekMissed) {
                  if (m.isGroup) continue; // groups counted separately
                  missedByStudent[m.studentId] = (missedByStudent[m.studentId] || 0) + 1;
                }
                const missedStu = Object.keys(missedByStudent).map(sid => students.find(s => s.id === sid)).filter(Boolean).sort((a, b) => (missedByStudent[b.id] || 0) - (missedByStudent[a.id] || 0));
                // Group-shaped missed entries — dedupe by groupId, count
                // occurrences, render the way the Missed-zone card does
                // (member first names + class codes).
                const missedGroupCounts = {};
                for (const m of thisWeekMissed) {
                  if (!m.isGroup || !m.groupId) continue;
                  missedGroupCounts[m.groupId] = (missedGroupCounts[m.groupId] || 0) + 1;
                }
                const missedGroupRows = Object.keys(missedGroupCounts).map(gid => {
                  const m = thisWeekMissed.find(x => x.isGroup && x.groupId === gid);
                  const grp = (groups || []).find(g => g.id === gid);
                  const memberStudents = (grp?.studentIds || []).map(sid => students.find(s => s.id === sid)).filter(Boolean);
                  const names = memberStudents.length > 0
                    ? memberStudents.map(s => (s.name || "").split(" ")[0]).join(", ")
                    : (m.groupName || grp?.name || "Group");
                  const uniqueClasses = [...new Set(memberStudents.map(s => s.className || "").filter(Boolean))];
                  const classSuffix = uniqueClasses.length > 0
                    ? " — " + (uniqueClasses.length === 1 ? uniqueClasses[0] : uniqueClasses.join(", "))
                    : "";
                  return { groupId: gid, label: names + classSuffix, count: missedGroupCounts[gid], m, grp, memberStudents };
                }).sort((a, b) => b.count - a.count);
                const hasMissed = missedStu.length > 0 || missedGroupRows.length > 0;
                // Hoist data needed by submenu types
                const schoolBands = (bands || []).filter(b => b.schoolId === sId && (b.members || []).length > 0);
                const placeOne = (ml) => {
                  // Spec 2 cluster 10b Commit 2 — Q2=β viewedLanes-aware destination.
                  // ml.teacherId/teacherName are vestigial for lane lookup; the
                  // chip-active lane decides where the missed-rescue card lands.
                  const destLane = getDayLaneTeacher(teacherCoverage, teachers, ml.schoolId, wkDay, laneOverrides, weekKey, viewedLanes, temporaryLanes);
                  if (!destLane || !destLane.lane) {
                    const sName = schools.find(sc => sc.id === ml.schoolId)?.name || ml.schoolId;
                    if (notify) notify(`No covering lane for ${sName} on ${wkDay}. Add staff first.`, "warning");
                    return;
                  }
                  const newLesson = {
                    id: uid(), studentId: ml.studentId, studentName: ml.studentName,
                    isGroup: ml.isGroup || false, groupId: ml.groupId || undefined,
                    groupName: ml.groupName || undefined, studentIds: ml.studentIds || undefined,
                    studentNames: ml.studentNames || undefined, members: ml.members || undefined,
                    schoolId: ml.schoolId, schoolName: ml.schoolName || "",
                    instrument: ml.instrument, bucket_id: destLane.lane.id, teacherName: destLane.teacher?.name || "",
                    enrolmentId: ml.enrolmentId || enrolmentIdFor(ml.studentId, ml.instrument, enrolments, ml.groupId),
                    day: wkDay, start: wkTime, end: wkTime, weekDate: wkDate, adjusted: false,
                  };
                  const wkData = weeklyTimetables[contextMenu.weekKey] || { lessons: [], missed: [] };
                  setWeeklyTimetables(prev => ({ ...prev, [contextMenu.weekKey]: { ...wkData, lessons: [...(wkData.lessons || []), newLesson] } }));
                  const cuSlot = (currentSchool?.slots || []).find(sl => sl.start === wkTime) || { start: wkTime, end: wkTime };
                  const cuWarnings = checkConstraints(newLesson, wkDay, cuSlot, undefined, { weekKey, selectedSchool, currentSchool, weeklyTimetables, teacherCoverage, laneOverrides, students, enrolments, teachers, schools, bands, groups, weekDateMap, weekInterruptions, specLookupRef, timetable });
                  setAckedConstraints(prev => { const next = new Set(prev); next.delete(newLesson.id); return next; });
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
                        style={{ position: "fixed", ...clampMenuPos(subX, addLessonSubmenu.y, subMenuW, 280), zIndex: 10001, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, maxHeight: 280, overflowY: "auto" }}
                        onScroll={e => { subPanelScrollRef.current[addLessonSubmenu.type] = e.currentTarget.scrollTop; }}>
                        {addLessonSubmenu.type === "catchup" && <>
                          <div style={subHdr(colors.accentDark)}>Schedule catchup</div>
                          {(() => {
                            // Spec 3 cluster 5b-3c-a: replaces the OLD JSONB-lesson
                            // catchup creation. Aggregation comes from the
                            // unresolvedMissedGroups useMemo (per-enrolment, current-
                            // term scope), school-filtered to the period grid's
                            // school context, scored via computeStudentSlotScore.
                            // Click → handleScheduleCatchup with target cell from
                            // contextMenu (period-grid path uses contextMenu.day/
                            // time/schoolId + parent weekKey).
                            const target = { day: contextMenu.day, time: contextMenu.time, weekKey, schoolId: sId };
                            const targetWeekDate = (weekDates || []).find(wd => wd.day === target.day)?.date || null;
                            const filtered = unresolvedMissedGroups.filter(g => g.schoolId === sId);
                            const annotated = filtered.map(g => {
                              const en = enrolments.find(e => e.id === g.enrolmentId);
                              const st = en && !en.isGroup ? students.find(s => s.id === en.studentId) : null;
                              let score = 0, scoreLabel = null;
                              if (st) ({ score, label: scoreLabel } = computeStudentSlotScore({ student: st, day: target.day, time: target.time, weekDate: targetWeekDate, interruptions, specialists }));
                              return { ...g, score, scoreLabel };
                            }).sort((a, b) => {
                              if (a.owedCount !== b.owedCount) return b.owedCount - a.owedCount;
                              if (a.score !== b.score) return a.score - b.score;
                              return (a.studentName || "").localeCompare(b.studentName || "");
                            });
                            if (annotated.length === 0) {
                              return <div style={{ padding: "10px 12px", fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>No missed lessons in current term</div>;
                            }
                            return annotated.map(group => {
                              const showInstrument = collidingStudentNames.has(group.studentName);
                              return (
                                <button key={group.enrolmentId} onClick={() => handleScheduleCatchup(group, target)} style={subBtnStyle}
                                  onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                  <span>{group.studentName}{showInstrument && group.instrument ? <span style={{ fontSize: 11, color: colors.textMuted, marginLeft: 6 }}>· {group.instrument}</span> : null}</span>
                                  <span style={{ fontSize: 11, color: group.score > 0 ? "#D97706" : "#6B7280", whiteSpace: "nowrap" }}>{group.owedCount}{group.scoreLabel ? " · " + group.scoreLabel : ""}</span>
                                </button>
                              );
                            });
                          })()}
                        </>}
                        {addLessonSubmenu.type === "missed" && <>
                          <div style={subHdr("#DC2626")}>Add missed lesson</div>
                          {missedStu.map(s => {
                            const count = missedByStudent[s.id] || 0;
                            const missedLesson = thisWeekMissed.find(m => !m.isGroup && m.studentId === s.id);
                            return (
                              <button key={s.id} onClick={() => { if (!missedLesson) return; placeLesson(s, { instrument: missedLesson.instrument || "", teacherId: missedLesson.teacherId || "", teacherName: missedLesson.teacherName || "" }); }}
                                style={subBtnStyle}
                                onMouseEnter={e => e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                <span>{s.name}</span>
                                <span style={{ fontSize: 11, color: colors.gray500, whiteSpace: "nowrap" }}>{count} missed</span>
                              </button>
                            );
                          })}
                          {missedGroupRows.map(row => (
                            <button key={"g:" + row.groupId} onClick={() => placeOne({
                              isGroup: true,
                              groupId: row.groupId,
                              groupName: row.m.groupName || row.grp?.name || "Group",
                              studentIds: row.m.studentIds || (row.grp?.studentIds || []),
                              studentNames: row.m.studentNames || row.memberStudents.map(s => s.name),
                              members: row.m.members || undefined,
                              schoolId: row.m.schoolId || row.grp?.schoolId || sId,
                              schoolName: schools.find(sc => sc.id === (row.m.schoolId || row.grp?.schoolId || sId))?.name || "",
                              instrument: row.m.instrument || row.grp?.instrument || "",
                              teacherId: row.m.teacherId || row.grp?.teacherId || "",
                              teacherName: row.m.teacherName || "",
                              enrolmentId: row.m.enrolmentId,
                            })}
                              style={subBtnStyle}
                              onMouseEnter={e => e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"}
                              onMouseLeave={e => e.currentTarget.style.background = "none"}>
                              <span><Users size={11} style={{ display: "inline-flex", verticalAlign: "middle", marginRight: 3, flexShrink: 0 }} />{row.label}</span>
                              <span style={{ fontSize: 11, color: colors.gray500, whiteSpace: "nowrap" }}>{row.count} missed</span>
                            </button>
                          ))}
                        </>}
                        {addLessonSubmenu.type === "trial" && <>
                          <div style={subHdr(colors.sidebarActive)}>Add trial</div>
                          {[...trialStu].sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(s => (
                            <button key={s.id} onClick={() => placeLesson(s, { isTrial: true })} style={subBtnStyle}
                              onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                              onMouseLeave={e => e.currentTarget.style.background = "none"}>
                              <span>{s.name}</span>
                              <span style={{ fontSize: 11, color: colors.gray500 }}>{instrumentsFromEnrolments(s.id, enrolments)[0]?.name || ""}</span>
                            </button>
                          ))}
                        </>}
                        {addLessonSubmenu.type === "band" && <>
                          <div style={subHdr(instruments_colors.Band)}>Add band session</div>
                          {schoolBands.map(band => (
                            <button key={band.id} onClick={() => handleAddBandSession(band)} style={subBtnStyle}
                              onMouseEnter={e => {
                                e.currentTarget.style.background = instruments_colors.Band + "18";
                                // Reuse the grid band card's hover popover so
                                // same-song bands can be told apart by member
                                // identity. Synthetic band-shaped lesson →
                                // buildPopoverInfo handles the isBandSession
                                // branch and produces the "Members" list.
                                const rect = e.currentTarget.getBoundingClientRect();
                                const info = buildPopoverInfo({ isBandSession: true, bandName: band.name, members: band.members || [] });
                                setHoverPopover({ type: "student", info, rect, color: instruments_colors.Band });
                              }}
                              onMouseLeave={e => {
                                e.currentTarget.style.background = "none";
                                setHoverPopover(null);
                              }}>
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
                                onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                <span>{ml.isGroup && <Users size={11} style={{ display: "inline-flex", verticalAlign: "middle", marginRight: 3, flexShrink: 0 }} />}{label}</span>
                                <span style={{ fontSize: 11, color: colors.textMuted }}>{ml.isGroup ? "" : ml.instrument}</span>
                              </button>
                            );
                          })}
                        </>}
                        {addLessonSubmenu.type === "temp" && <>
                          <div style={subHdr(colors.danger)}>Temp slot (waiting list)</div>
                          {students.filter(s => s.schoolId === sId && s.status === "pending").sort((a, b) => a.name.localeCompare(b.name)).map(s => (
                            <button key={s.id} onClick={() => {
                              const activeEnrolment = (enrolments || []).find(e =>
                                e.studentId === s.id && !e.endDate && !e.isGroup
                              );
                              if (!activeEnrolment) {
                                if (notify) notify(`${s.name} has no active enrolment — can't place lesson`, "warning");
                                return;
                              }
                              const teacherForTemp = activeEnrolment.teacherId
                                ? teachers.find(t => t.id === activeEnrolment.teacherId) : null;
                              // Spec 2 cluster 4c — lane lookup before stamping bucket_id.
                              const tempBucketId = activeEnrolment.teacherId
                                ? findLaneId(teacherCoverage, sId, wkDay, activeEnrolment.teacherId)
                                : null;
                              if (!tempBucketId) {
                                const sName = schools.find(sc => sc.id === sId)?.name || sId;
                                if (notify) notify(`No covering lane for ${teacherForTemp?.name || "(unassigned)"} at ${sName} on ${wkDay}. Add staff first.`, "warning");
                                return;
                              }
                              const newLesson = {
                                id: uid(), studentId: s.id, studentName: s.name,
                                schoolId: sId, schoolName: schools.find(sc => sc.id === sId)?.name || "",
                                instrument: activeEnrolment.instrument,
                                bucket_id: tempBucketId,
                                enrolmentId: activeEnrolment.id,
                                day: wkDay, start: wkTime, end: wkTime, weekDate: wkDate, adjusted: false, isTemp: true,
                              };
                              const wkData = weeklyTimetables[contextMenu.weekKey] || { lessons: [], missed: [] };
                              setWeeklyTimetables(prev => ({ ...prev, [contextMenu.weekKey]: { ...wkData, lessons: [...(wkData.lessons || []), newLesson] } }));
                              const cuSlot = (currentSchool?.slots || []).find(sl => sl.start === wkTime) || { start: wkTime, end: wkTime };
                              const cuWarnings = checkConstraints(newLesson, wkDay, cuSlot, undefined, { weekKey, selectedSchool, currentSchool, weeklyTimetables, teacherCoverage, laneOverrides, students, enrolments, teachers, schools, bands, groups, weekDateMap, weekInterruptions, specLookupRef, timetable });
                              if (cuWarnings.length > 0) { setConstraintWarnings(prev => ({ ...prev, [newLesson.id]: cuWarnings })); setExpandedWarnings(prev => { const next = new Set(prev); next.add(newLesson.id); return next; }); }
                              setContextMenu(null); setAddLessonSubmenu(null); addLessonSubmenuType.current = null;
                            }} style={subBtnStyle}
                              onMouseEnter={e => e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"}
                              onMouseLeave={e => e.currentTarget.style.background = "none"}>
                              <span>{s.name}</span>
                              <span style={{ fontSize: 11, color: colors.textMuted }}>{instrumentsFromEnrolments(s.id, enrolments)[0]?.name || ""}</span>
                            </button>
                          ))}
                        </>}
                      </div>
                    )}
                    {/* Spec 3 cluster 5b-3c-a: Schedule catchup — always shown
                        (cascade panel handles empty case). Replaces the OLD
                        "Add catch-up" trigger that was gated on hasCatchup. */}
                    <button style={mkItemStyle(colors.accentDark)}
                      onMouseEnter={e => { e.currentTarget.style.background = colors.accentLight; if (addLessonSubmenuType.current !== "catchup") { addLessonSubmenuType.current = "catchup"; setAddLessonSubmenu({ type: "catchup", y: e.currentTarget.getBoundingClientRect().top }); } }}
                      onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><RotateCcw size={13} /> Schedule catchup…</span><ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                    </button>
                    {hasMissed && (
                      <button style={mkItemStyle("#DC2626")}
                        onMouseEnter={e => { e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"; if (addLessonSubmenuType.current !== "missed") { addLessonSubmenuType.current = "missed"; setAddLessonSubmenu({ type: "missed", y: e.currentTarget.getBoundingClientRect().top }); } }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><X size={13} /> Add missed</span><ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                      </button>
                    )}
                    {hasTrial && (
                      <button style={mkItemStyle(colors.sidebarActive)}
                        onMouseEnter={e => { e.currentTarget.style.background = colors.blueLight; if (addLessonSubmenuType.current !== "trial") { addLessonSubmenuType.current = "trial"; setAddLessonSubmenu({ type: "trial", y: e.currentTarget.getBoundingClientRect().top }); } }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Music size={13} /> Add trial</span><ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                      </button>
                    )}
                    {schoolBands.length > 0 && (
                      <button style={mkItemStyle(instruments_colors.Band)}
                        onMouseEnter={e => { e.currentTarget.style.background = instruments_colors.Band + "18"; if (addLessonSubmenuType.current !== "band") { addLessonSubmenuType.current = "band"; setAddLessonSubmenu({ type: "band", y: e.currentTarget.getBoundingClientRect().top }); } }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Guitar size={13} /> Add band session</span><ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                      </button>
                    )}
                    {missing.length > 0 && (
                      <button style={mkItemStyle(colors.sidebarActive)}
                        onMouseEnter={e => { e.currentTarget.style.background = colors.blueLight; if (addLessonSubmenuType.current !== "unsched") { addLessonSubmenuType.current = "unsched"; setAddLessonSubmenu({ type: "unsched", y: e.currentTarget.getBoundingClientRect().top }); } }}
                        onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Plus size={13} /> Add unscheduled</span><ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                      </button>
                    )}
                    {(() => {
                      const pendingStu = students.filter(s => s.schoolId === sId && s.status === "pending");
                      if (pendingStu.length === 0) return null;
                      return (
                        <button style={mkItemStyle(colors.danger)}
                          onMouseEnter={e => { e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"; if (addLessonSubmenuType.current !== "temp") { addLessonSubmenuType.current = "temp"; setAddLessonSubmenu({ type: "temp", y: e.currentTarget.getBoundingClientRect().top }); } }}
                          onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Clock size={13} /> Add temp (waiting list)</span><ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                        </button>
                      );
                    })()}
                  </div>
                );
              })()}
            </div>
          ) : contextMenu.isCatchupCreate ? (() => {
            // Spec 3 cluster 5b-3c-a — Mon-Sun holiday grid path. Opens the
            // student-aggregated picker directly (no parent menu wrapper). No
            // school filter applied (Mon-Sun is school-agnostic per Event 12).
            // Same aggregation/score/sort logic as the period-grid cascade
            // above; differs only in the school-filter pass-through.
            const target = { day: contextMenu.targetDay, time: contextMenu.targetTime, weekKey: contextMenu.targetWeekKey };
            const targetWeekDate = (weekDates || []).find(wd => wd.day === target.day)?.date || null;
            const annotated = unresolvedMissedGroups.map(g => {
              const en = enrolments.find(e => e.id === g.enrolmentId);
              const st = en && !en.isGroup ? students.find(s => s.id === en.studentId) : null;
              let score = 0, scoreLabel = null;
              if (st) ({ score, label: scoreLabel } = computeStudentSlotScore({ student: st, day: target.day, time: target.time, weekDate: targetWeekDate, interruptions, specialists }));
              return { ...g, score, scoreLabel };
            }).sort((a, b) => {
              if (a.owedCount !== b.owedCount) return b.owedCount - a.owedCount;
              if (a.score !== b.score) return a.score - b.score;
              return (a.studentName || "").localeCompare(b.studentName || "");
            });
            const subBtnStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit", textAlign: "left" };
            return (
              <div style={{ padding: "6px 4px", maxHeight: 360, overflowY: "auto" }}>
                <div style={{ padding: "6px 12px", fontSize: 11, color: colors.accentDark, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${colors.borderLight}` }}>
                  Schedule catchup
                </div>
                {annotated.length === 0 ? (
                  <div style={{ padding: "10px 12px", fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>
                    No missed lessons in current term
                  </div>
                ) : (
                  annotated.map(group => {
                    const showInstrument = collidingStudentNames.has(group.studentName);
                    return (
                      <button key={group.enrolmentId} onClick={() => handleScheduleCatchup(group, target)} style={subBtnStyle}
                        onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                        onMouseLeave={e => e.currentTarget.style.background = "none"}>
                        <span>{group.studentName}{showInstrument && group.instrument ? <span style={{ fontSize: 11, color: colors.textMuted, marginLeft: 6 }}>· {group.instrument}</span> : null}</span>
                        <span style={{ fontSize: 11, color: group.score > 0 ? "#D97706" : "#6B7280", whiteSpace: "nowrap" }}>{group.owedCount}{group.scoreLabel ? " · " + group.scoreLabel : ""}</span>
                      </button>
                    );
                  })
                )}
              </div>
            );
          })() : contextMenu.isCatchupAction ? (() => {
            // Spec 3 cluster 5b-3b — email rows mirror the day-header email
            // pattern (isDayHeader branch above). Reuses the component-level
            // dayHeaderSubmenu / dayHeaderSubRef / dayHeaderHideTimer state —
            // only one context menu renders at a time, so no collision with
            // the isDayHeader branch. Mark complete / Edit / Unlink were
            // intentionally dropped per planner+Matt review (placement IS
            // the completion signal per anchor Event 12; drag-drop in 5b-3c
            // covers day/time edits; enrolment fields are fixed).
            const cu = contextMenu.targetCatchup;
            const enrolment = enrolments.find(e => e.id === cu.enrolmentId) || null;
            const isGroup = enrolment?.isGroup === true;
            const group = isGroup ? (groups || []).find(g => g.id === enrolment.groupId) : null;
            const studentIds = isGroup
              ? (group?.members || []).map(m => m.studentId).filter(Boolean)
              : (enrolment?.studentId ? [enrolment.studentId] : []);

            // Parents — aggregated across all students in the catchup
            const parentEmailSet = new Set();
            const parentRows = [];
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
            const allParentEmails = [...parentEmailSet];

            // Class teachers — via getClassTeacher per student
            const teacherEmailSet = new Set();
            const teacherRows = [];
            studentIds.forEach(sid => {
              const st = students.find(s => s.id === sid);
              if (!st) return;
              const ct = getClassTeacher(st, contacts || []);
              if (ct?.email && !teacherEmailSet.has(ct.email)) {
                teacherEmailSet.add(ct.email);
                teacherRows.push({ name: ct.name || ct.email, email: ct.email });
              }
            });
            const allTeacherEmails = [...teacherEmailSet];

            // Staff — Session 3 / C7 — the music teacher attribution previously
            // came from enrolment.teacherId (retired). Staff row dropped here;
            // music-teacher resolution would now require an MTT lookup, which
            // is overkill for this catchup-email staff list. Class-teacher
            // emails above remain unchanged.
            const staffRows = [];
            const allStaffEmails = [];

            const noEmails = !allParentEmails.length && !allTeacherEmails.length && !allStaffEmails.length;
            if (noEmails && process.env.NODE_ENV !== 'production' && (!enrolment || studentIds.length === 0)) {
              console.info('[catchup card menu] no contacts resolved for bare group catchup', {
                catchupId: cu.id, enrolmentId: cu.enrolmentId,
              });
            }

            const subMenuW = 210;
            const menuRect = contextMenuRef.current ? contextMenuRef.current.getBoundingClientRect() : null;
            const menuRight = menuRect ? menuRect.right : contextMenu.x + 220;
            const menuLeft = menuRect ? menuRect.left : contextMenu.x;
            const subX = menuRight + subMenuW > window.innerWidth ? menuLeft - subMenuW : menuRight;

            const keepOpen = () => { if (dayHeaderHideTimer.current) clearTimeout(dayHeaderHideTimer.current); };
            const scheduleClose = () => { dayHeaderHideTimer.current = setTimeout(() => setDayHeaderSubmenu(null), 200); };
            const schoolSender = schools.find(s => s.id === cu.schoolId)?.senderEmail || "";

            const SubPanel = ({ type, rows, allEmails, color, multi }) => {
              if (!dayHeaderSubmenu || dayHeaderSubmenu.type !== type || !rows.length) return null;
              const btn = (c) => ({ display: "flex", alignItems: "center", width: "100%", padding: "8px 14px", background: "none", border: "none", fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: c, fontWeight: 400 });
              const hov = (e) => e.currentTarget.style.background = colors.bg;
              const unhov = (e) => e.currentTarget.style.background = "none";
              return (
                <div ref={dayHeaderSubRef}
                  onMouseEnter={keepOpen}
                  onMouseLeave={scheduleClose}
                  style={{ position: "fixed", top: dayHeaderSubmenu.y, left: subX, zIndex: 10002, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, maxHeight: 300, overflowY: "auto", padding: "4px 0" }}>
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
              const isOpen = dayHeaderSubmenu?.type === type;
              const multi = allEmails.length > 1;
              return (
                <div style={{ position: "relative" }}>
                  <SubPanel type={type} rows={rows} allEmails={allEmails} color={color} multi={multi} />
                  {multi ? (
                    <button
                      onClick={() => { openCompose(allEmails, { from: schoolSender, triggerId: "wtt_day_header" }); setContextMenu(null); setDayHeaderSubmenu(null); }}
                      onMouseEnter={e => {
                        keepOpen();
                        e.currentTarget.style.background = colors.bg;
                        if (!isOpen) setDayHeaderSubmenu({ type, y: e.currentTarget.getBoundingClientRect().top });
                      }}
                      onMouseLeave={e => { e.currentTarget.style.background = "none"; scheduleClose(); }}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color, fontFamily: "inherit", fontWeight: 600 }}>
                      <span>{label} ({allEmails.length})</span>
                      <ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                    </button>
                  ) : (
                    <button
                      onClick={() => { openCompose(allEmails, { from: schoolSender, triggerId: "wtt_day_header" }); setContextMenu(null); setDayHeaderSubmenu(null); }}
                      onMouseEnter={e => { keepOpen(); e.currentTarget.style.background = colors.bg; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "none"; scheduleClose(); }}
                      style={{ display: "flex", alignItems: "center", width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color, fontFamily: "inherit", fontWeight: 600 }}>
                      {rows[0] ? (rows[0].name || rows[0].email).split(" ")[0] : label}
                    </button>
                  )}
                </div>
              );
            };

            return (
              <div style={{ padding: "4px 0" }}>
                {noEmails && (
                  <div style={{ padding: "10px 12px", fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>No email addresses found</div>
                )}
                {mkEmailRow("Parents", allParentEmails, parentRows, "parents", colors.accent)}
                {mkEmailRow("Class Teachers", allTeacherEmails, teacherRows, "teachers", colors.sidebarActive)}
                {mkEmailRow("Staff", allStaffEmails, staffRows, "staff", colors.textLight)}
                <div style={{ height: 1, background: colors.borderLight, margin: "4px 8px" }} />
                <button
                  onClick={() => handleDeleteCatchup(cu)}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, borderRadius: 6, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.redLight}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><X size={13} /> Delete catchup</span>
                </button>
              </div>
            );
          })() : contextMenu.isBandSession ? (
            <>
              <div style={{ padding: "8px 12px", fontSize: 12, color: instruments_colors.Band, borderBottom: `1px solid ${colors.borderLight}`, fontWeight: 700 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Guitar size={13} /> {contextMenu.bandName || "Band Session"}</span>
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
                style={{ padding: "4px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.cardBg, fontSize: 13, cursor: "pointer", color: colors.accent, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}
                onMouseEnter={e => e.currentTarget.style.background = colors.accentLight} onMouseLeave={e => e.currentTarget.style.background = colors.white}>
                <Mail size={14} style={{ flexShrink: 0 }} /><span>Email Parents</span>
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
                  onMouseEnter={e => e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><X size={13} /> Remove band session</span>
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
                  // Cluster 12a: helper handles null lesson — drop the redundant ternary.
                  const _wttResolvedTid = getLiveTeacherId(_wttLesson, students, enrolments, teacherCoverage, laneOverrides, weekKey);
                  const lessonTeacher = _wttResolvedTid ? teachers.find(t => t.id === _wttResolvedTid) : null;
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
                  const subPanel = { position: "fixed", zIndex: 10002, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: emailSubW, padding: "4px 0" };

                  return (
                    <div style={{ position: "relative" }}>
                      <button
                        onMouseEnter={e => { e.currentTarget.style.background = colors.bg; setWttEmailSubmenu({ y: e.currentTarget.getBoundingClientRect().top }); setWttEmailLevel2(null); }}
                        onMouseLeave={e => e.currentTarget.style.background = "none"}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit", fontWeight: 600 }}>
                        Email
                        <ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                      </button>
                      {wttEmailSubmenu && (
                        <div ref={subMenuRef} style={{ position: "fixed", top: wttEmailSubmenu.y, left: subX, zIndex: 10001, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: emailSubW, padding: "4px 0" }}>

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
                                <ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
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
                                <ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
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
                                <ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
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
                  onMouseEnter={e => e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><X size={13} /> Missed</span>
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
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><StickyNote size={13} /> {hasNote ? "Edit note" : "Add note"}</span>
                    </button>
                  );
                })()}
                {/* 5: Swap Teacher */}
                {/* Cluster 12a: single-card "Swap Teacher" submenu deleted alongside the
                    _swapTeacherId mechanism strip. Lane-level substitution is handled by
                    cluster 6c's Substitute Teacher flow on the day header instead. */}
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
                    // Cluster 12a: lane-resolved teacher only; stamped fallbacks gone.
                    const tid = getLiveTeacherId(l, students, enrolments, teacherCoverage, laneOverrides, weekKey);
                    const t = teachers.find(x => x.id === tid);
                    if (!t) return;
                    // Add BOTH app + personal email; skip blanks (no empty recipient).
                    [t.email, t.personalEmail].forEach(email => {
                      if (email && !staffMap[email]) staffMap[email] = { name: t.name || email, color: t.color || null };
                    });
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
                        style={{ position: "fixed", top: wttEmailLevel2.y, left: level3X, zIndex: 10003, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 170, padding: "4px 0", maxHeight: 300, overflowY: "auto" }}>
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
                        style={{ position: "fixed", top: swapTeacherSubmenu.y, left: subX, zIndex: 10002, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 190, padding: "4px 0" }}>
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
                            <span>Parents ({allParentEmails.length})</span><ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
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
                            <span>Teachers ({allCtEmails.length})</span><ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
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
                            <span>Staff ({allStaffEmails.length})</span><ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
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
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Mail size={13} /> Email</span><ChevronRight size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                      </button>
                    </div>

                    {/* Cluster 12a: bulk "Swap Teacher (all)" submenu deleted alongside the
                        _swapTeacherId mechanism strip. */}

                    {/* Mark all missed */}
                    <button onClick={() => { setMissedModal({ type: "bulk", lessonIds: contextMenu.selectedIds, weekKey, category: null, reasonDetail: "", catchup: null, details: "" }); setContextMenu(null); }}
                      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, fontFamily: "inherit" }}
                      onMouseEnter={e => { e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"; setSwapTeacherSubmenu(null); setWttEmailLevel2(null); }} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><X size={13} /> Mark all missed…</span>
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
                      onMouseEnter={e => { e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"; setSwapTeacherSubmenu(null); setWttEmailLevel2(null); }} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Trash2 size={13} /> Delete lessons</span>
                    </button>
                  </>);
                })()}
                {onAddMemory && !contextMenu.isMulti && (() => {
                  const lesson = (weeklyData?.lessons || []).find(l => l.id === contextMenu.lessonId);
                  if (!lesson) return null;
                  const schoolName = schools.find(s => s.id === (lesson.schoolId || selectedSchool))?.name || "";
                  const teacherName = teachers.find(t => t.id === getLiveTeacherId(lesson, students, enrolments, teacherCoverage, laneOverrides, weekKey))?.name || "";
                  const memText = `${lesson.isGroup ? (lesson.studentNames?.join(", ") || "Group") : lesson.studentName} — ${lesson.instrument} — ${lesson.day} ${lesson.start}${schoolName ? ` at ${schoolName}` : ""}${teacherName ? ` — teacher: ${teacherName}` : ""}`;
                  return (
                    <>
                      <div style={{ borderTop: `1px solid ${colors.border}`, margin: "3px 0" }} />
                      <button
                        onClick={() => { onAddMemory(memText); setContextMenu(null); setWttEmailSubmenu(null); setWttEmailLevel2(null); setSwapTeacherSubmenu(null); }}
                        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, borderRadius: 6, fontFamily: "inherit" }}
                        onMouseEnter={e => e.currentTarget.style.background = colors.blueLight}
                        onMouseLeave={e => e.currentTarget.style.background = "none"}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z"/><path d="M12 8v4l3 3"/></svg>
                          Add to Claude memory
                        </span>
                      </button>
                    </>
                  );
                })()}
                {!contextMenu.isMulti && <button onClick={() => { handleDeleteWeeklyLesson(contextMenu.lessonId); setContextMenu(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.textMuted, borderRadius: 6, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Trash2 size={13} /> Delete lesson</span>
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
              }} title={isHolidayWeek ? "Disabled" : "Export"} disabled={isHolidayWeek} style={{ opacity: isHolidayWeek ? 0.35 : 1 }}><Send size={13} /></Btn>
            <Btn variant="secondary" onClick={() => !isHolidayWeek && printWeeklyTimetable(weeklyTimetables, schools, students, weekDates, weekLabel)} title={isHolidayWeek ? "Disabled" : "Print week"} disabled={isHolidayWeek} style={{ opacity: isHolidayWeek ? 0.35 : 1 }}><Printer size={13} /></Btn>
            {confirmClearAllWeeks ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", background: "rgba(255,255,255,0.1)", borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap", marginTop: -1 }}>
                <span style={{ fontSize: 12, color: colors.cardBg, fontWeight: 500 }}>Clear all?</span>
                <Btn variant="danger" onClick={() => {
                  // Only wipe current + future weeks. Past weeks are locked
                  // (isLocked = isPastWeek && !editUnlocked) and Clear all
                  // must respect that — otherwise it retroactively erases
                  // already-delivered timetables, which was the bug.
                  setWeeklyTimetables(prev => {
                    const currentMondayStr = toLocalDateStr(getCurrentWeekMonday());
                    const next = {};
                    for (const key of Object.keys(prev)) {
                      const [mondayStr] = key.split("|");
                      if (mondayStr < currentMondayStr) next[key] = prev[key];
                    }
                    return next;
                  });
                  setConfirmClearAllWeeks(false);
                }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmClearAllWeeks(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
              </div>
            ) : (
              <Btn variant="danger" disabled={isLocked || isHolidayWeek} style={{ opacity: (isLocked || isHolidayWeek) ? 0.35 : 1, border: "none" }} onClick={() => setConfirmClearAllWeeks(true)} title={isHolidayWeek ? "Disabled" : "Clear all weeks"}><Trash2 size={13} /></Btn>
            )}
            {!isHolidayWeek && confirmRegenerateWeek ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", background: "rgba(255,255,255,0.1)", borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap", marginTop: -1 }}>
                <span style={{ fontSize: 12, color: colors.cardBg, fontWeight: 500 }}>Reschedule all schools?</span>
                <Btn variant="primary" onClick={() => { handleGenerateAllSchools(); setConfirmRegenerateWeek(false); }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, background: colors.sidebarActive, color: "#fff", border: "none" }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmRegenerateWeek(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
              </div>
            ) : (
              <Btn variant="secondary" onClick={() => setConfirmRegenerateWeek(true)} disabled={generating || isLocked || isHolidayWeek} style={{ opacity: (generating || isLocked || isHolidayWeek) ? 0.35 : 1, color: colors.sidebarActive, border: "none" }} title={isHolidayWeek ? "Disabled" : "Reschedule all schools"}><RefreshCw size={13} /></Btn>
            )}
            {confirmImportAllWeeks ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", background: "rgba(255,255,255,0.1)", borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap", marginTop: -1 }}>
                <span style={{ fontSize: 12, color: colors.cardBg, fontWeight: 500 }}>Import all schools?</span>
                <Btn variant="primary" onClick={importAllSchoolsFromMTT} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, background: colors.sidebarActive, color: "#fff", border: "none" }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmImportAllWeeks(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
              </div>
            ) : (
              <Btn variant="secondary" onClick={() => setConfirmImportAllWeeks(true)} disabled={generating || isLocked || isHolidayWeek} style={{ opacity: (generating || isLocked || isHolidayWeek) ? 0.35 : 1, color: colors.sidebarActive, border: "none" }} title={isHolidayWeek ? "Disabled" : "Import MTT for all schools"}><Download size={13} /></Btn>
            )}
            {onUndo && <Btn variant="secondary" onClick={onUndo} disabled={!undoCount} style={{ opacity: undoCount ? 1 : 0.4 }} title="Undo (Cmd+Z)"><Undo2 size={13} /></Btn>}
            {onRedo && <Btn variant="secondary" onClick={onRedo} disabled={!redoCount} style={{ opacity: redoCount ? 1 : 0.4 }} title="Redo (Cmd+Shift+Z)"><Redo2 size={13} /></Btn>}
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
          <FrozenCard style={{ border: `2px solid ${colors.sidebarHover}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "space-between" }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {isHolidayWeek ? (
                  <div style={{ height: 34, padding: "0 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 8, background: colors.accentDark, color: "#fff", border: `2px solid ${colors.accentDark}`, userSelect: "none" }}>
                    <RotateCcw size={13} /> Holiday Catch-Ups
                  </div>
                ) : (
                  schools.map(s => {
                    const sKey = weekKey + "|" + s.id; const wttCount = (weeklyTimetables[sKey]?.lessons || []).length;
                    const isActive = selectedSchool === s.id;
                    return (
                      <button key={s.id} onClick={() => setSelectedSchool(s.id)}
                        style={{
                          height: 34, padding: "0 14px", borderRadius: 8, fontSize: 13, fontFamily: "inherit", cursor: "pointer", boxSizing: "border-box",
                          border: `2px solid ${isActive ? (s.color || colors.sidebarHover) : colors.border}`,
                          background: isActive ? (s.color || colors.sidebarHover) : colors.cardBg,
                          color: isActive ? colors.white : colors.text, fontWeight: 600,
                          transition: "all 0.15s", display: "flex", alignItems: "center", gap: 8
                        }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Building2 size={13} /> {s.name.replace(/Primary School/gi, "PS")}</span>
                        <span style={{
                          fontSize: 11, padding: "2px 0", borderRadius: 10, fontWeight: 600,
                          background: isActive ? "rgba(255,255,255,0.2)" : colors.borderLight,
                          color: isActive ? colors.white : colors.textMuted,
                          minWidth: 28, textAlign: "center", display: "inline-block"
                        }}>{wttCount}</span>
                      </button>
                    );
                  })
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", background: colors.sidebarHover, borderRadius: 8, overflow: "hidden", height: 34, boxSizing: "border-box", flexShrink: 0 }}>
                <button onClick={() => setWeekOffset(o => o - 1)} disabled={weekOffset <= minWeekOffset}
                  style={{ background: "none", border: "none", color: colors.cardBg, fontSize: 18, padding: "0 12px", height: "100%", cursor: weekOffset <= minWeekOffset ? "default" : "pointer", opacity: weekOffset <= minWeekOffset ? 0.3 : 1, fontFamily: "inherit", lineHeight: 1, display: "flex", alignItems: "center" }}>‹</button>
                <div style={{ fontWeight: 700, fontSize: 13, padding: "0 8px", color: colors.white, letterSpacing: 0.5, textTransform: "uppercase", whiteSpace: "nowrap" }}>{weekLabel}</div>
                <button onClick={() => setWeekOffset(o => o + 1)}
                  style={{ background: "none", border: "none", color: colors.cardBg, fontSize: 18, padding: "0 12px", height: "100%", cursor: "pointer", fontFamily: "inherit", lineHeight: 1, display: "flex", alignItems: "center" }}>›</button>
              </div>
            </div>
          </FrozenCard>

          {/* Past-holiday WEEK RECORD banner + Edit/Lock toggle.
              Mirrors the non-holiday banner further down the render tree.
              Without this, past holiday weeks had no lock affordance at all
              and the catch-up grid could be mutated retroactively. */}
          {isHolidayWeek && isPastWeek && (
            <div style={{ marginTop: 12, marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ background: colors.sidebarActive, color: "#fff", borderRadius: 8, padding: "6px 18px", fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", border: `2px solid ${colors.sidebarActive}`, boxShadow: "0 2px 8px rgba(52,69,101,0.18)" }}>
                {weekLabel} RECORD
              </span>
              <button onClick={() => setEditUnlocked(v => !v)}
                style={{ padding: "5px 16px", background: "none", border: `1px solid ${colors.border}`, borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", color: colors.textMuted }}>
                {editUnlocked ? "Lock" : "Edit"}
              </button>
            </div>
          )}

          {/* ── New Mon-Sun Catchup Grid (Spec 3 cluster 5b-2) ── */}
          {isHolidayWeek && (() => {
            const TIME_SLOTS = ["09:00","09:30","10:00","10:30","11:00","11:30","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30"];
            const DAY_COLS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
            const weekCatchups = getCatchupsForWeek(catchups, weekKey);
            // Off-grid catchup detection (dev-only — Matt-visible data anomaly signal).
            if (process.env.NODE_ENV !== "production") {
              weekCatchups.forEach((c) => {
                if (!TIME_SLOTS.includes(c.time)) {
                  console.warn("[catchup grid] off-grid catchup time", { id: c.id, time: c.time, day: c.day });
                }
              });
            }
            // Snap an off-grid time to the nearest 30-min boundary at-or-before.
            // 09:15 → 09:00, 09:45 → 09:30. Off-grid catchups render in the
            // nearest visible cell rather than being silently dropped.
            const snapToSlot = (time) => {
              if (!time) return null;
              const [h, m] = time.split(":").map(Number);
              if (Number.isNaN(h) || Number.isNaN(m)) return null;
              const snappedM = m < 30 ? "00" : "30";
              return `${String(h).padStart(2, "0")}:${snappedM}`;
            };
            // Inline sub-component — closure access to enrolments, students,
            // colors. Cluster 5b-3c-b: draggable; bare-group artefacts
            // (null enrolmentId) are non-draggable since their relocation
            // semantics are undefined in the new model.
            function CatchupCard({ catchup }) {
              const enrolment = (enrolments || []).find(e => e.id === catchup.enrolmentId);
              const student = enrolment ? (students || []).find(s => s.id === enrolment.studentId) : null;
              const displayName = student?.name || enrolment?.studentName || "—";
              const inst = catchup.instrument || "";
              const isBareGroup = !catchup.enrolmentId;
              const regularDay = catchup.resolvesOriginalDay;
              const laneTeacher = regularDay
                ? getDayLaneTeacher(teacherCoverage, teachers, catchup.schoolId, regularDay)?.teacher || null
                : null;
              // Session 3 / C7 — enrolment.teacherId fallback retired. When
              // no regular-day lane resolves a teacher, the catchup card
              // renders with an empty teacher name. Acceptable: cards with
              // resolvable lanes are the common case post-Refinement-B.
              const teacherName = laneTeacher?.name || "";
              return (
                <div
                  draggable={!isBareGroup}
                  onDragStart={isBareGroup ? undefined : (e => {
                    e.dataTransfer.setData("text/plain", "catchup:" + catchup.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDraggingId("catchup:" + catchup.id);
                  })}
                  onDragEnd={isBareGroup ? undefined : (() => { setDraggingId(null); setDragOver(null); })}
                  onContextMenu={(e) => handleCatchupCardRightClick(e, catchup)}
                  style={{
                    padding: "4px 6px", borderRadius: 4, fontSize: 11, lineHeight: 1.3,
                    background: getInstColor(inst) + "18",
                    borderLeft: `3px solid ${getInstColor(inst)}`,
                    position: "relative",
                    cursor: isBareGroup ? "default" : "grab",
                    opacity: draggingId === "catchup:" + catchup.id ? 0.4 : 1,
                  }}>
                  <span style={{ position: "absolute", top: 2, right: 4, color: colors.sidebarActive, lineHeight: 1, fontWeight: 700, display: "inline-flex", alignItems: "center" }} title="Catch-up lesson"><RotateCcw size={9} /></span>
                  <div style={{ fontWeight: 600, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 14 }}>
                    {displayName}
                  </div>
                  <div style={{ color: colors.textLight, fontSize: 10 }}>
                    {teacherName ? `${inst} · ${teacherName}` : inst}
                  </div>
                </div>
              );
            }
            return (
              <div style={{ marginTop: 12, marginBottom: 16, opacity: isLocked ? 0.7 : 1 }}>
                <div style={{ display: "grid", gridTemplateColumns: "60px repeat(7, 1fr)", gap: 1, background: colors.border, borderRadius: 8, overflow: "hidden", border: `1px solid ${colors.border}` }}>
                  {/* Header row */}
                  <div style={{ background: colors.sidebarHover, color: "#fff", padding: "8px 6px", fontSize: 11, fontWeight: 600, textAlign: "center" }}>Time</div>
                  {DAY_COLS.map(day => (
                    <div key={day} style={{ background: colors.sidebarHover, color: "#fff", padding: "8px 6px", fontSize: 12, fontWeight: 700, textAlign: "center" }}>
                      {day.slice(0, 3)}
                    </div>
                  ))}
                  {/* Body rows */}
                  {TIME_SLOTS.map(time => (
                    <React.Fragment key={`row-${time}`}>
                      <div style={{ background: colors.sidebarHover, color: "#fff", padding: "6px 6px", fontSize: 11, fontWeight: 600, textAlign: "right", display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                        {(() => { const [h, m] = time.split(":"); const hour = parseInt(h) % 12 || 12; return `${hour}:${m}`; })()}
                      </div>
                      {DAY_COLS.map(day => {
                        const onGrid = getCatchupsForGridCell(catchups, weekKey, day, time);
                        const offGrid = weekCatchups.filter(c => c.day === day && !TIME_SLOTS.includes(c.time) && snapToSlot(c.time) === time);
                        const cell = [...onGrid, ...offGrid];
                        return (
                          <div key={`${day}-${time}`}
                            onContextMenu={cell.length === 0 ? (e => handleEmptyCellRightClick(e, day, time, weekKey)) : undefined}
                            onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                            onDrop={e => {
                              // Spec 3 cluster 5b-3c-b-patch-1: empty-cell gate
                              // removed — catchup cards stack on non-empty cells
                              // the same way regular lesson cards already do
                              // (e.g. handleWeeklyMoveLesson at the period-grid
                              // drop handler has no equivalent gate).
                              e.preventDefault();
                              const lid = e.dataTransfer.getData("text/plain");
                              if (!lid || !lid.startsWith("catchup:")) return;
                              const id = lid.slice("catchup:".length);
                              handleCatchupRelocate(id, day, time);
                              setDraggingId(null);
                            }}
                            style={{ background: colors.cardBg, minHeight: 36, padding: 2, display: "flex", flexDirection: "column", gap: 2 }}>
                            {cell.map(c => <CatchupCard key={c.id} catchup={c} />)}
                          </div>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            );
          })()}

          {!isHolidayWeek && weeklyData && !isLocked && (
            <ConflictBanner
              constraintWarnings={visibleWarnings}
              ackedConstraints={ackedConstraints}
              lessons={weeklyData.lessons || []}
              students={students}
              onAckAll={() => setAckedConstraints(prev => {
                const next = new Set(prev);
                // Only acknowledge what's actually shown in the banner (the gated
                // set); past-dated warnings aren't displayed, so leave their ack
                // state alone.
                Object.keys(visibleWarnings).forEach(id => next.add(id));
                return next;
              })}
            />
          )}

          {!isHolidayWeek && timetable && selectedSchool && (() => {
            const mttLessons = timetable.lessons.filter(l => l.schoolId === selectedSchool && !l.isBandSession);
            const wttLessons = (weeklyData?.lessons) || [];
            const wttMissed = (weeklyData?.missed) || [];
            const seen = new Set();
            const missing = [];
            for (const ml of mttLessons) {
              const key = ml.isGroup ? `group|${ml.groupId}` : `${ml.studentId}|${ml.instrument}`;
              if (seen.has(key)) continue;
              seen.add(key);
              // Unified "unscheduled" rule (matches the add-unscheduled menu
              // source): in grid (individual OR group OR band-session member)
              // or in Missed zone → not unscheduled.
              let present;
              if (ml.isGroup) {
                present = wttLessons.some(wl => wl.groupId === ml.groupId)
                       || wttMissed.some(wm => wm.groupId === ml.groupId);
              } else {
                present = wttLessons.some(wl => !wl.isBandSession && !wl.isGroup && wl.studentId === ml.studentId && wl.instrument === ml.instrument)
                       || wttLessons.some(wl => wl.isGroup && (wl.studentIds || []).includes(ml.studentId))
                       || wttLessons.some(wl => wl.isBandSession && (wl.members || []).some(mb => mb.studentId === ml.studentId))
                       || wttMissed.some(wm => wm.studentId === ml.studentId && wm.instrument === ml.instrument);
              }
              if (!present) {
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
              <div style={{ marginBottom: 12, background: colors.tagBg, border: "1px solid #F59E0B40", borderRadius: 10, padding: "10px 16px", display: "flex", gap: 10, alignItems: "flex-start" }}>
                <AlertTriangle size={16} style={{ flexShrink: 0, color: "#92400E", marginTop: 1 }} />
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

          {!isHolidayWeek && isPastWeek && (
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
          {!isHolidayWeek && !isLocked && (
          <>
          {/* Week Interruptions */}
          {weekInterruptions.length > 0 && (
            <Card style={{ marginBottom: 8, padding: 0, background: colors.amberLight, border: "1px solid #F59E0B40", overflow: "hidden" }}>
              <div onClick={() => setShowInterruptions(v => !v)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", cursor: "pointer", fontWeight: 600, fontSize: 13, color: "#92400E" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><AlertTriangle size={13} /> Interruptions this week ({weekInterruptions.length})</span>
                <span style={{ fontSize: 11, color: "#B45309" }}>{showInterruptions ? <ChevronUp size={11} /> : <ChevronDown size={11} />}</span>
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

          {/* Reschedule — current week only */}
          {!isPastWeek && <Card style={{ marginBottom: 16, padding: 0, overflow: "hidden" }}>
            <div style={{ background: colors.sidebarHover, padding: "10px 16px", borderRadius: "12px 12px 0 0", marginBottom: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: colors.white }}>Reschedule</div>
            </div>
            <div style={{ padding: "14px 18px" }}>
            <div style={{ display: "flex", gap: 8, marginTop: 0, alignItems: "center", flexWrap: "wrap" }}>
              {/* Week button — expands to Reschedule / Import */}
              <div key={expandedBtn === "week" ? "week-exp" : "week-col"} style={{ display: "flex", alignItems: "center", gap: 0, borderRadius: 8, overflow: "hidden", outline: `2px solid ${expandedBtn === "week" ? colors.sidebarHover : "transparent"}`, transition: "outline-color 0.15s", position: "relative", zIndex: expandedBtn === "week" ? 40 : "auto" }}>
                {expandedBtn === "week" ? (
                  <>
                    {confirmImportExpanded === "week" ? (
                      <>
                        <span style={{ padding: "6px 10px", fontSize: 12, fontWeight: 500, color: colors.sidebarActive, background: colors.blueLight, whiteSpace: "nowrap" }}>Replace week?</span>
                        <button onClick={() => { importFromMTT(null); }} disabled={generating}
                          style={{ padding: "6px 10px", background: colors.sidebarActive, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)" }}>Yes</button>
                        <button onClick={() => setConfirmImportExpanded(false)}
                          style={{ padding: "6px 10px", background: colors.sidebarActive, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", opacity: 0.7 }}>No</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => setExpandedBtn(null)}
                          style={{ padding: "6px 12px", background: colors.accent, color: colors.cardBg, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none" }}>Week</button>
                        <button onClick={() => { handleGenerate(); setExpandedBtn(null); }} disabled={generating}
                          style={{ padding: "6px 12px", background: colors.accent, color: colors.cardBg, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: generating ? "not-allowed" : "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", opacity: generating ? 0.5 : 1, transition: "background 0.1s" }}
                          onMouseEnter={e => { if (!generating) e.currentTarget.style.background = colors.sidebarHover; }}
                          onMouseLeave={e => e.currentTarget.style.background = colors.accent}>
                          {generating ? "…" : "Auto"}
                        </button>
                        <button onClick={() => {
                          const hasLessons = (weeklyData?.lessons || []).filter(l => !l.isBandSession).length > 0;
                          if (hasLessons) { setConfirmImportExpanded("week"); } else { importFromMTT(null); }
                        }}
                          style={{ padding: "6px 12px", background: colors.accent, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", transition: "background 0.1s" }}
                          onMouseEnter={e => e.currentTarget.style.background = colors.sidebarHover}
                          onMouseLeave={e => e.currentTarget.style.background = colors.accent}>
                          Import
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <button onClick={() => setExpandedBtn("week")} disabled={generating}
                    style={{ padding: "6px 14px", background: colors.accent, color: colors.cardBg, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: generating ? "not-allowed" : "pointer", border: "none", opacity: generating ? 0.5 : 1, transition: "background 0.1s" }}
                    onMouseEnter={e => { if (!generating) e.currentTarget.style.background = colors.sidebarHover; }}
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
                  <div key={isExpanded ? `${d}-exp` : `${d}-col`} style={{ display: "flex", alignItems: "center", gap: 0, borderRadius: 8, overflow: "hidden", outline: `2px solid ${isExpanded ? colors.sidebarHover : "transparent"}`, transition: "outline-color 0.15s", position: "relative", zIndex: isExpanded ? 40 : "auto" }}>
                    {isExpanded ? (
                      confirmImportExpanded === d ? (
                        <>
                          <span style={{ padding: "6px 10px", fontSize: 12, fontWeight: 500, color: colors.sidebarActive, background: colors.blueLight, whiteSpace: "nowrap" }}>Replace {d.slice(0,3)}?</span>
                          <button onClick={() => { importFromMTT(d); }}
                            style={{ padding: "6px 10px", background: colors.sidebarActive, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)" }}>Yes</button>
                          <button onClick={() => setConfirmImportExpanded(false)}
                            style={{ padding: "6px 10px", background: colors.sidebarActive, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", opacity: 0.7 }}>No</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => setExpandedBtn(null)}
                            style={{ padding: "6px 12px", background: colors.accent, color: colors.cardBg, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", minWidth: 52, textAlign: "center" }}
                            title={dateLabel}>{d.slice(0,3)}</button>
                          <button onClick={() => { handleGenerateDay(d); setExpandedBtn(null); }}
                            style={{ padding: "6px 12px", background: colors.accent, color: colors.cardBg, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", transition: "background 0.1s" }}
                            onMouseEnter={e => e.currentTarget.style.background = colors.sidebarHover}
                            onMouseLeave={e => e.currentTarget.style.background = colors.accent}>Auto</button>
                          <button onClick={() => {
                            const hasLessons = (weeklyData?.lessons || []).filter(l => l.day === d && !l.isBandSession).length > 0;
                            if (hasLessons) { setConfirmImportExpanded(d); } else { importFromMTT(d); }
                          }}
                            style={{ padding: "6px 12px", background: colors.accent, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", borderLeft: "1px solid rgba(255,255,255,0.3)", transition: "background 0.1s" }}
                            onMouseEnter={e => e.currentTarget.style.background = colors.sidebarHover}
                            onMouseLeave={e => e.currentTarget.style.background = colors.accent}>Import</button>
                        </>
                      )
                    ) : (
                      <button onClick={() => { setExpandedBtn(d); setConfirmImportExpanded(false); }}
                        style={{ padding: "6px 12px", background: colors.accent, color: colors.cardBg, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: "none", minWidth: 52, textAlign: "center", transition: "background 0.1s" }}
                        onMouseEnter={e => e.currentTarget.style.background = colors.sidebarHover}
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
                      <Btn variant="success" onClick={() => saveWttVersion(wttVersionName)} style={{ fontSize: 11, padding: "4px 8px" }}><Check size={12} /></Btn>
                      <Btn variant="ghost" onClick={() => setShowWttSavePrompt(false)} style={{ fontSize: 11, padding: "4px 6px" }}><X size={12} /></Btn>
                    </div>
                  ) : (
                    <Btn variant="secondary" onClick={() => { setWttVersionName(lastWttVersionNameRef.current[selectedSchool] || ""); setShowWttSavePrompt(true); }} style={{ fontSize: 12 }} title="Save this week's timetable as a version"><Save size={13} /></Btn>
                  )}
                </div>
                {wttSavedVersions.filter(v => v.schoolId === selectedSchool).length > 0 && (
                  <div style={{ position: "relative" }}>
                    <Btn variant="secondary" onClick={() => setShowWttVersionMenu(!showWttVersionMenu)} style={{ fontSize: 12 }}>
                      <FolderOpen size={13} /> {wttSavedVersions.filter(v => v.schoolId === selectedSchool).length}
                    </Btn>
                    {showWttVersionMenu && (
                      <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 260, zIndex: 50, maxHeight: 300, overflowY: "auto" }}>
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
                              style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", padding: "2px 6px", display: "inline-flex", alignItems: "center" }}
                              title="Delete version"><X size={13} /></button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div ref={clearMenuRef} style={{ display: "inline-flex", alignItems: "center" }}>
                {confirmClearWeek ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", background: colors.redLight, borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap" }}>
                    <span style={{ fontSize: 12, color: colors.danger, fontWeight: 500 }}>{(() => {
                      // Spec 2 cluster 10 — pill names the (override-aware) viewed-lane
                      // teacher and shows the lane-filtered count. Same lane-filter
                      // shape as S1/S2 above. Defensive fallback to today's wording
                      // if no lane resolves (shouldn't happen — menuDays already
                      // filters to days with lessons).
                      if (confirmClearWeek === "all") return "Clear full week?";
                      const day = confirmClearWeek;
                      const count = (weeklyData?.lessons || []).filter(l => l.day === day && lessonBelongsToViewedLane(l, viewedLanes, teacherCoverage, selectedSchool)).length;
                      const laneTeacher = getDayLaneTeacher(teacherCoverage, teachers, selectedSchool, day, laneOverrides, weekKey, viewedLanes, temporaryLanes)?.teacher;
                      if (!laneTeacher) return `Clear ${day}?`;
                      const firstName = laneTeacher.name.split(" ")[0];
                      return `Clear ${firstName}'s ${count} lesson${count !== 1 ? "s" : ""} on ${day}?`;
                    })()}</span>
                    <Btn variant="danger" onClick={() => { confirmClearWeek === "all" ? clearWeek() : clearWeek(confirmClearWeek); setConfirmClearWeek(false); setShowClearMenu(false); }} style={{ height: 24, padding: "0 8px", fontSize: 11, borderRadius: 5, fontWeight: 600 }}>Yes</Btn>
                    <Btn variant="secondary" onClick={() => setConfirmClearWeek(false)} style={{ height: 24, padding: "0 8px", fontSize: 11, borderRadius: 5, fontWeight: 600 }}>No</Btn>
                  </div>
                ) : showClearMenu ? (() => {
                  // Spec 2 cluster 10 — multi-lane day appears only if the
                  // viewed lane has lessons there. Single-lane days fall back
                  // to the original any-lesson check via the helper's
                  // single-lane true short-circuit.
                  const menuDays = (currentSchool?.days || DAYS).filter(d => {
                    return (weeklyData?.lessons || []).some(l => l.day === d && lessonBelongsToViewedLane(l, viewedLanes, teacherCoverage, selectedSchool));
                  });
                  return (
                    <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                      {menuDays.map(d => (
                        <button key={d} onClick={() => setConfirmClearWeek(d)}
                          style={{ height: 28, padding: "0 10px", borderRadius: 6, fontSize: 12, fontFamily: "inherit", cursor: "pointer", border: `1px solid ${colors.danger}`, background: colors.redLight, color: colors.danger, fontWeight: 500 }}
                          onMouseEnter={e => e.currentTarget.style.background = "#FEE2E2"}
                          onMouseLeave={e => e.currentTarget.style.background = darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2"}>{d.slice(0, 3)}</button>
                      ))}
                      <button onClick={() => setConfirmClearWeek("all")}
                        style={{ height: 28, padding: "0 10px", borderRadius: 6, fontSize: 12, fontFamily: "inherit", cursor: "pointer", border: `1px solid ${colors.danger}`, background: colors.danger, color: "#fff", fontWeight: 600 }}
                        onMouseEnter={e => e.currentTarget.style.opacity = "0.85"}
                        onMouseLeave={e => e.currentTarget.style.opacity = "1"}>All</button>
                      <button onClick={() => setShowClearMenu(false)}
                        style={{ height: 28, padding: "0 8px", borderRadius: 6, fontSize: 12, fontFamily: "inherit", cursor: "pointer", border: "none", background: "none", color: colors.textMuted }}>
                        <X size={12} /></button>
                    </div>
                  );
                })() : (
                  <Btn variant="danger" onClick={() => setShowClearMenu(true)} style={{ border: "none" }} title="Clear this week"><Trash2 size={13} /></Btn>
                )}
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
          {!isHolidayWeek && (weeklyData ? (
            <div>
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
                // Spec 3 cluster 5b-2: enrich each catchup with `studentId`
                // (derived from enrolment) so the period-grid card render
                // resolves the student name correctly. mergeCatchupsIntoLessons
                // adds `start: c.time` so the existing `l.start === time`
                // cell filter at the per-cell map below sees the catchup
                // at the right slot.
                // Scope catch-ups to the selected school before merging into
                // the period grid (regular displayLessons are already
                // school-scoped via the weekKey|selectedSchool storageKey).
                // Fail-safe: no selectedSchool → no catch-ups (never leak all).
                const enrichedCatchups = (selectedSchool ? (catchups || []).filter(c => c.schoolId === selectedSchool) : []).map(c => {
                  const en = (enrolments || []).find(e => e.id === c.enrolmentId);
                  const laneResult = getDayLaneTeacher(teacherCoverage, teachers, c.schoolId, c.day);
                  const base = en ? { ...c, studentId: en.studentId } : c;
                  return laneResult?.lane ? { ...base, bucket_id: laneResult.lane.id } : base;
                });
                const wLessons = mergeCatchupsIntoLessons(displayLessons, enrichedCatchups, weekKey);

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
                    return (INTR_DISPLAY_TYPE[intr.type] === "interruption" || INTR_DISPLAY_TYPE[intr.type] === "public_holiday") && intr.affectsClasses === "all" && !intr.startTime;
                  });
                };

                return (
                  <div ref={gridRefCb} onScroll={handleGridScroll} onClick={() => { if (selectedCards.size > 0) setSelectedCards(new Set()); if (selectedDays.size > 0) setSelectedDays(new Set()); if (selectedMissed.size > 0) setSelectedMissed(new Set()); }} style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 200px)", border: `1px solid ${colors.border}`, borderRadius: 12 }}>
                    <div style={{ pointerEvents: isLocked ? "none" : "auto" }}>
                    <div style={{ display: "grid", gridTemplateColumns: `50px repeat(${schoolDays.length}, 200px)`, gap: 1, background: colors.border, minWidth: `calc(50px + ${schoolDays.length} * 200px + 1000px)` }}>
                      {/* Header row */}
                      <div style={{ background: colors.sidebarHover, color: "#fff", padding: "12px 8px", fontSize: 11, fontWeight: 600, textAlign: "center", position: "sticky", top: 0, left: 0, zIndex: 20 }}>Time</div>
                      {schoolDays.map(d => {
                        const blocked = isDayBlocked(d);
                        const daySelected = selectedDays.has(d);
                        const dayDateStr = weekDateMap[d];
                        const isDayConfirmed = (confirmedDaysMap[dayDateStr] || []).length > 0;
                        const isResettingThis = resettingDay === dayDateStr;
                        const isConfirmingThis = confirmingDay === dayDateStr;
                        const dayHasLessons = (weeklyData?.lessons || []).some(l => l.day === d);
                        const laneTeacher = getDayLaneTeacher(teacherCoverage, teachers, selectedSchool, d, laneOverrides, weekKey, viewedLanes, temporaryLanes)?.teacher;
                        // Frozen header teacher (2.12.0 batch, follow-up to d770d34): on a PAST
                        // week the lesson cards show the locked historical teacher, so the day
                        // header must match. Derive it from the frozenTeacherId stamped on this
                        // column's non-band lessons (most common, in case a column mixes ids);
                        // ignore band sessions and unstamped lessons. Empty/band-only days and
                        // current/future weeks fall back to the live laneTeacher unchanged. This
                        // is header-only — the shared getDayLaneTeacher (catch-up path) is untouched.
                        let headerTeacher = laneTeacher;
                        if (isPastWeek(weekKey)) {
                          const counts = {};
                          let frozenId = null, frozenN = 0;
                          for (const l of (weeklyData?.lessons || [])) {
                            if (l.day !== d || l.isBandSession || !l.frozenTeacherId) continue;
                            counts[l.frozenTeacherId] = (counts[l.frozenTeacherId] || 0) + 1;
                            if (counts[l.frozenTeacherId] > frozenN) { frozenN = counts[l.frozenTeacherId]; frozenId = l.frozenTeacherId; }
                          }
                          if (frozenId) {
                            const frozenT = teachers.find(t => t.id === frozenId);
                            if (frozenT) headerTeacher = frozenT;
                          }
                        }
                        const dayLanes = getDayLanes(teacherCoverage, selectedSchool, d, temporaryLanes, weekKey);
                        const viewedLaneId = (viewedLanes?.[selectedSchool]?.[d] && dayLanes.some(c => c.id === viewedLanes[selectedSchool][d])) ? viewedLanes[selectedSchool][d] : (dayLanes[0]?.id || null);
                        // Header label "Mon 4 May" — reuses precomputed dayDateStr.
                        const colDate = dayDateStr ? new Date(`${dayDateStr}T00:00:00`) : null;
                        const headerLabel = colDate
                          ? `${colDate.toLocaleDateString("en-AU", { weekday: "short" })} ${colDate.getDate()} ${colDate.toLocaleDateString("en-AU", { month: "short" })}`
                          : d;
                        return (
                          <div key={d}
                            style={{ background: daySelected ? colors.accent : blocked ? "#7F1D1D" : (headerTeacher?.color || colors.sidebarHover), color: "#fff", padding: "12px 8px", fontSize: 13, fontWeight: 600, textAlign: "center", position: "sticky", top: 0, zIndex: 10, cursor: "pointer", userSelect: "none", transition: "background 0.15s" }}
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
                            {/* Top row: [confirm/reset] [Day Date Month] [Actuals] */}
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                              {/* Left: confirm or reset (when applicable) */}
                              <span style={{ width: 13, height: 13, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
                                {isDayConfirmed && (
                                  isResettingThis ? (
                                    <div style={{ width: 13, height: 13, border: "2px solid rgba(255,255,255,0.2)", borderTopColor: "rgba(255,255,255,0.8)", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                                  ) : (
                                    <button
                                      onClick={e => { e.stopPropagation(); setResetConfirm(dayDateStr); }}
                                      title="Reset confirmed day"
                                      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "inline-flex", alignItems: "center", lineHeight: 1, opacity: 0.75 }}
                                      onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                                      onMouseLeave={e => e.currentTarget.style.opacity = "0.75"}>
                                      <RotateCcw size={12} color="rgba(34,197,94,0.9)" />
                                    </button>
                                  )
                                )}
                                {!isDayConfirmed && dayHasLessons && (
                                  isConfirmingThis ? (
                                    <div style={{ width: 13, height: 13, border: "2px solid rgba(255,255,255,0.2)", borderTopColor: "rgba(34,197,94,0.8)", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                                  ) : (
                                    <button
                                      onClick={e => { e.stopPropagation(); confirmDay(dayDateStr, d); }}
                                      title="Confirm day (admin)"
                                      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "inline-flex", alignItems: "center", lineHeight: 1, opacity: 0.45 }}
                                      onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                                      onMouseLeave={e => e.currentTarget.style.opacity = "0.45"}>
                                      <Check size={12} color="rgba(34,197,94,0.9)" />
                                    </button>
                                  )
                                )}
                              </span>
                              {/* Middle: day label "Mon 4 May" */}
                              <span style={{ flex: 1, textAlign: "center" }}>{headerLabel}</span>
                            </div>
                            {isDayConfirmed && (
                              <div style={{ fontSize: 9, color: "rgba(34,197,94,0.85)", fontWeight: 500, marginTop: 2 }}>confirmed</div>
                            )}
                            {blocked && <div style={{ fontSize: 9, color: "#FCA5A5", marginTop: 2 }}>BLOCKED</div>}
                            {/* Bottom row: lane chips (left, when 2+ lanes) + Actuals (right) */}
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                              {dayLanes.length >= 2 ? (
                                <div style={{ display: "flex", gap: 3 }}>
                                  {dayLanes.map(lane => {
                                    const t = teachers.find(tt => tt.id === lane.teacherId);
                                    if (!t) return null;
                                    const initials = t.name.split(" ").filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join("");
                                    const isActive = lane.id === viewedLaneId;
                                    return (
                                      <button key={lane.id}
                                        onClick={e => { e.stopPropagation(); onSwitchLane && onSwitchLane(selectedSchool, d, lane.id); }}
                                        title={t.name}
                                        style={{
                                          height: 20, minWidth: 26, padding: "0 4px", borderRadius: 4,
                                          fontSize: 10, fontWeight: 700, fontFamily: "inherit", cursor: "pointer",
                                          background: t.color || colors.sidebarActive, color: "#fff",
                                          opacity: isActive ? 1 : 0.65,
                                          border: isActive ? "2px solid #fff" : "none",
                                        }}>
                                        {initials}
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : <div />}
                              {(() => {
                                // Suppress entirely on drained past days — pg_cron has already
                                // merged teacher_actuals into weekly_adjustments, so the admin
                                // view IS the actuals. No toggle needed.
                                const isDayDrained = dayDateStr && dayDateStr < melbourneToday();
                                if (isDayDrained) return null;
                                const ghostKey = `${weekKey}_${d}`;
                                const ghostsVisible = !!dayGhostsVisible[ghostKey];
                                return (
                                  <button
                                    type="button"
                                    onClick={e => { e.stopPropagation(); setDayGhostsVisible(prev => ({ ...prev, [ghostKey]: !prev[ghostKey] })); }}
                                    title={ghostsVisible ? "Hide teacher actuals" : "Show teacher actuals"}
                                    style={{
                                      padding: "2px 8px",
                                      fontSize: 11,
                                      fontWeight: ghostsVisible ? 700 : 500,
                                      border: ghostsVisible ? "1.5px solid #fff" : "1px solid rgba(255,255,255,0.35)",
                                      background: ghostsVisible ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.08)",
                                      color: ghostsVisible ? "#111" : "inherit",
                                      fontFamily: "inherit",
                                      borderRadius: 999,
                                      cursor: "pointer",
                                      opacity: ghostsVisible ? 1 : 0.55,
                                      transition: "opacity 0.12s, background 0.12s, color 0.12s, border 0.12s",
                                      flexShrink: 0,
                                    }}>
                                    Actuals
                                  </button>
                                );
                              })()}
                            </div>
                          </div>
                        );
                      })}

                      {/* Time rows */}
                      {allTimes.map(time => {
                        const isTeacherBreak = isTeacherBreakTime(time);
                        const isSlotBreak = !!schoolSlotTypeMap[time]; // subtle indicator only
                        return (
                        <React.Fragment key={`wrow-${time}`}>
                          <div style={{ background: colors.sidebarHover, padding: "8px 2px", fontSize: 11, fontWeight: 600, color: "#fff", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 1, position: "sticky", left: 0, zIndex: 5 }}>
                            {toTimeLabel(time)}
                            {isSlotBreak && !isTeacherBreak && <span style={{ opacity: 0.7, display: "inline-flex", alignItems: "center" }}><Coffee size={9} /></span>}
                          </div>
                          {isTeacherBreak ? (
                            <div style={{ gridColumn: `2 / -1`, background: colors.tagBg, padding: "8px", minHeight: 36, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <span style={{ fontWeight: 600, color: "#555", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}><Coffee size={12} /> Break</span>
                            </div>
                          ) : schoolDays.map(day => {
                            const cellBreak = wGetBreak(time, day);
                            const cellLessons = wLessons.filter(l => l.day === day && l.start === time);
                            const blocked = isDayBlocked(day);
                            const isDropTarget = dragOver && dragOver.day === day && dragOver.time === time;
                            const isDayConfirmed = (confirmedDaysMap[weekDateMap[day]] || []).length > 0;
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
                                        const raw = checkConstraints(dl, day, sl, undefined, { weekKey, selectedSchool, currentSchool, weeklyTimetables, teacherCoverage, laneOverrides, students, enrolments, teachers, schools, bands, groups, weekDateMap, weekInterruptions, specLookupRef, timetable });
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
                                  } else if (lid.startsWith("catchup:")) {
                                    // Cluster 5b-3c-b-patch-1: empty-cell gate removed.
                                    // Catchup cards stack on non-empty cells the same way
                                    // regular lesson cards do via handleWeeklyMoveLesson
                                    // below. Same-cell no-op handled inside
                                    // handleCatchupRelocate.
                                    handleCatchupRelocate(lid.slice("catchup:".length), day, time);
                                  } else {
                                    handleWeeklyMoveLesson(lid, day, time);
                                  }
                                  if (onSoundPlay) onSoundPlay();
                                }}
                                style={{
                                  background: isDayConfirmed
                                    ? (darkMode ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.04)")
                                    : isDropTarget ? (darkMode ? "rgba(79,142,247,0.15)" : "#EFF6FF") : blocked ? (darkMode ? "rgba(196,84,84,0.18)" : "#FEF2F2") : colors.cardBg,
                                  position: "relative",
                                  padding: 4, minHeight: 56, display: "flex", flexDirection: "column", gap: 3,
                                  outline: "none",
                                  transition: "background 0.15s, outline 0.15s"
                                }}
                              >
                                {/* Teacher-actuals cards — read-only,
                                    pointer-events:none. When the per-day Actuals
                                    toggle is ON these are the only lesson layer
                                    for that day (admin cards hidden below). */}
                                {(() => {
                                  const ghostKey = `${weekKey}_${day}`;
                                  if (!dayGhostsVisible[ghostKey]) return null;
                                  // Cluster 8a: in multi-lane days, also filter ghosts to the viewed lane's effective teacher.
                                  const ghostDayLanes = getDayLanes(teacherCoverage, selectedSchool, day, temporaryLanes, weekKey);
                                  const ghostViewedTeacher = ghostDayLanes.length >= 2 ? getDayLaneTeacher(teacherCoverage, teachers, selectedSchool, day, laneOverrides, weekKey, viewedLanes, temporaryLanes)?.teacher : null;
                                  const cellGhosts = currentTeacherActualsLessons.filter(g => g.day === day && g.start === time && (!ghostViewedTeacher || g.teacherId === ghostViewedTeacher.id));
                                  return cellGhosts.map((g, gi) => {
                                    const color = getInstColor(g.instrument, g.isGroup);
                                    const isGroup = !!g.isGroup;
                                    let displayName;
                                    let classSuffix = "";
                                    if (isGroup) {
                                      displayName = groupDisplayName(g);
                                    } else {
                                      const ghostSt = students.find(s => s.id === g.studentId);
                                      displayName = getPrefDisplayName(ghostSt?.name || g.studentName || "");
                                      if (ghostSt?.className) classSuffix = ` · ${ghostSt.className}`;
                                    }
                                    // Lane-derived teacher name (matches regular-card render at
                                    // line ~4827). The stamped g.teacherName in teacher_actuals JSONB
                                    // can be stale when the day's lane has shifted (e.g. fill-in
                                    // teacher); deriving from teacherCoverage + laneOverrides keeps
                                    // the actuals card consistent with the admin view.
                                    const _gtn = getLiveTeacherName(g, students, teachers, enrolments, teacherCoverage, laneOverrides, weekKey);
                                    const teacherFirst = _gtn ? _gtn.split(" ")[0] : "";
                                    return (
                                      <div
                                        key={`ghost-${g.id || gi}`}
                                        aria-hidden="true"
                                        title="Teacher's actual (read-only)"
                                        style={{
                                          padding: "6px 10px",
                                          borderRadius: 6,
                                          fontSize: 13,
                                          lineHeight: 1.4,
                                          background: color + "18",
                                          borderLeft: `3px solid ${color}`,
                                          borderStyle: "dashed",
                                          borderTop: `1px dashed ${color}40`,
                                          borderRight: `1px dashed ${color}40`,
                                          borderBottom: `1px dashed ${color}40`,
                                          cursor: "default",
                                          opacity: 0.42,
                                          transition: "opacity 0.12s",
                                          pointerEvents: "none",
                                        }}>
                                        <div style={{ fontWeight: 600, color: colors.text }}>
                                          {isGroup && <Users size={11} style={{ display: "inline-flex", verticalAlign: "middle", marginRight: 3 }} />}
                                          {displayName}{classSuffix}
                                        </div>
                                        <div style={{ color: colors.textLight, fontSize: 12 }}>
                                          {g.instrument || ""}{teacherFirst ? ` · ${teacherFirst}` : ""}
                                        </div>
                                      </div>
                                    );
                                  });
                                })()}
                                {cellBreak && (
                                  <div
                                    draggable
                                    onDragStart={e => {
                                      e.dataTransfer.setData("text/plain", `wbreak:${cellBreak.id}`);
                                      e.dataTransfer.effectAllowed = "move";
                                      setDraggingId(`wbreak:${cellBreak.id}`);
                                    }}
                                    onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
                                    style={{ flex: 1, padding: "6px 10px", borderRadius: 6, fontSize: 13, background: darkMode ? "#2D2A35" : "#E8E8E8", borderLeft: "3px solid #999", textAlign: "center", cursor: "grab", position: "relative", opacity: draggingId === `wbreak:${cellBreak.id}` ? 0.4 : 1, transition: "opacity 0.15s", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    <span style={{ fontWeight: 600, color: "#555", display: "inline-flex", alignItems: "center", gap: 5 }}><Coffee size={12} /> Break</span>
                                    <span
                                      onClick={e => { e.stopPropagation(); updateWeeklyBreaks(weeklyBreaks.filter(b => b.id !== cellBreak.id)); }}
                                      style={{ position: "absolute", top: 1, right: 3, fontSize: 10, color: "#DC2626", cursor: "pointer", lineHeight: 1, fontWeight: 700 }}
                                      title="Remove break" style={{ display: "inline-flex", alignItems: "center" }}><X size={10} /></span>
                                  </div>
                                )}
                                {!dayGhostsVisible[`${weekKey}_${day}`] && cellLessons.map((l, li) => {
                                  // v2.9.12 past-dated display gate: read from the single gated
                                  // source of truth (visibleWarnings) so the card, the conflicts
                                  // banner, the sidebar badge and the Dashboard count all agree.
                                  // Past lessons (or future lessons with a past relational partner)
                                  // simply have no entry here. Ack state untouched.
                                  const cWarnings = visibleWarnings[l.id] || [];
                                  // ── Band session card ──
                                  if (l.isBandSession) {
                                    const bandMembers = (l.members || []);
                                    const resolvedStudents = bandMembers.map(m => students.find(st => st.id === m.studentId));
                                    const memberNames = bandMembers.map((m, mi) => {
                                      const s = resolvedStudents[mi];
                                      if (!s) return null;
                                      // Inline name logic: first name, add surname initial if duplicate first name
                                      const first = (s.name || "").split(" ")[0];
                                      const hasDupe = resolvedStudents.some((os, oi) => oi !== mi && os && (os.name || "").split(" ")[0] === first);
                                      const parts = (s.name || "").split(" ");
                                      const displayName = hasDupe && parts.length > 1 ? `${first} ${parts[1][0]}.` : first;
                                      return displayName + (m.instrument ? ` (${m.instrument})` : "");
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
                                        onDragStart={e => { e.dataTransfer.setData("text/plain", l.id); e.dataTransfer.effectAllowed = "move"; setDraggingId(l.id); setExpandedWarnings(new Set()); setHoverPopover(null); dragCache.current = {}; }}
                                        onDragEnd={() => { setDraggingId(null); setDragOver(null); hideHoverPanel(); dragCache.current = {}; }}
                                        onMouseEnter={e => {
                                          if (draggingId || expandedWarnings.size > 0) return;
                                          const rect = e.currentTarget.getBoundingClientRect();
                                          const info = buildPopoverInfo(l);
                                          setHoverPopover({ type: "student", info, rect, color: instruments_colors.Band });
                                        }}
                                        onMouseLeave={() => setHoverPopover(null)}
                                        onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, isBandSession: true, lessonId: l.id, bandName: l.bandName, bandId: l.bandId }); }}
                                        onClick={e => { if (isBandExpanded || hasBandWarning) { e.stopPropagation(); setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); return next; }); setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; }); } }}
                                        style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12, lineHeight: 1.4, position: "relative", zIndex: isBandExpanded ? 40 : "auto", cursor: "grab",
                                          background: hasBandWarning ? (darkMode ? "rgba(196,84,84,0.18)" : "#FEF2F2") : instruments_colors.Band + "18",
                                          borderLeft: `3px solid ${hasBandWarning ? colors.danger : instruments_colors.Band}`,
                                          opacity: draggingId === l.id ? 0.4 : 1, transition: "opacity 0.15s"
                                        }}>
                                        {hasBandWarning && (
                                          <span onClick={e => { e.stopPropagation(); setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); return next; }); setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; }); }}
                                            onMouseEnter={e => { e.stopPropagation(); if (expandedWarnings.has(l.id)) return; const rect = e.currentTarget.parentElement.getBoundingClientRect(); setHoverPopover({ type: "constraints", warnings: bandWarnings, rect, color: colors.danger }); }}
                                            onMouseLeave={e => { e.stopPropagation(); if (draggingId || expandedWarnings.size > 0) return; const cardEl = e.currentTarget.parentElement; const rect = cardEl.getBoundingClientRect(); const info = buildPopoverInfo(l); setHoverPopover({ type: "student", info, rect, color: instruments_colors.Band }); }}
                                            style={{ position: "absolute", bottom: 2, right: 5, cursor: "pointer", lineHeight: 1, color: colors.success, fontWeight: 700, display: "inline-flex", alignItems: "center" }} title="Confirm this time"><Check size={11} /></span>
                                        )}
                                        {bandWarningAcked && !hasBandWarning && (
                                          <span onMouseEnter={e => { e.stopPropagation(); if (expandedWarnings.has(l.id)) return; const rect = e.currentTarget.parentElement.getBoundingClientRect(); setHoverPopover({ type: "constraints", warnings: bandWarnings, rect, color: colors.danger }); }}
                                            onMouseLeave={e => { e.stopPropagation(); if (draggingId || expandedWarnings.size > 0) return; const cardEl = e.currentTarget.parentElement; const rect = cardEl.getBoundingClientRect(); const info = buildPopoverInfo(l); setHoverPopover({ type: "student", info, rect, color: instruments_colors.Band }); }}
                                            style={{ position: "absolute", bottom: 2, right: 5, lineHeight: 1, color: colors.danger, fontWeight: 700, opacity: 0.6, display: "inline-flex", alignItems: "center" }}><AlertTriangle size={11} /></span>
                                        )}
                                        <div style={{ fontWeight: 600, color: hasBandWarning ? colors.text : colors.text }}>{l.bandName || "TBC"}</div>
                                        {memberNames.length > 0 && <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>{memberNames.join(", ")}</div>}
                                        {(() => { const tn = getLiveTeacherName(l, students, teachers, enrolments, teacherCoverage, laneOverrides, weekKey); return tn ? <div style={{ color: colors.textLight, fontSize: 11 }}>{tn.split(" ")[0]}</div> : null; })()}
                                        {bandSpecTags.length > 0 && draggingId !== l.id && <div style={{ color: colors.specialistTag, fontSize: 10, fontWeight: 600 }}>during {bandSpecTags.join(", ")}</div>}
                                        {isBandExpanded && (
                                          <div style={{ position: "absolute", left: -3, right: 0, top: "100%", marginTop: 2, padding: "6px 8px", background: colors.redLight, border: `1px solid ${colors.danger}30`, borderRadius: 6, fontSize: 10, lineHeight: 1.4, zIndex: 20, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
                                            {bandWarnings.map((w, wi) => <div key={wi} style={{ color: colors.danger, fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}><AlertTriangle size={10} style={{ flexShrink: 0 }} /> {w}</div>)}
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
                                  // Live instrument: if the student's instrument changed, reflect it on the card
                                  const _cardStuW = !l.isGroup ? students.find(s => s.id === l.studentId) : null;
                                  const _cardWInsts = _cardStuW ? instrumentsFromEnrolments(_cardStuW.id, enrolments) : [];
                                  const liveInst = _cardStuW
                                    ? (_cardWInsts.find(i => i.name === l.instrument)
                                        ? l.instrument
                                        : (_cardWInsts.find(i => !i.isGroup)?.name || l.instrument))
                                    : l.instrument;
                                  return (
                                  <div key={li} draggable
                                    onDragStart={e => {
                                      // Cluster 5b-3c-b: catchup cards drag with a "catchup:" prefix
                                      // so the cell drop handler can route to handleCatchupRelocate
                                      // (writes to catchups table) instead of handleWeeklyMoveLesson
                                      // (writes to weekly_adjustments JSONB).
                                      const payload = l.__isCatchup ? "catchup:" + l.id : l.id;
                                      e.dataTransfer.setData("text/plain", payload); e.dataTransfer.effectAllowed = "move";
                                      setDraggingId(l.__isCatchup ? "catchup:" + l.id : l.id); setExpandedWarnings(new Set()); setHoverPopover(null); dragCache.current = {};
                                      // Cluster 12a: drag auto-clear of _swapTeacherId removed (mechanism gone).
                                    }}
                                    onDragEnd={() => { setDraggingId(null); setDragOver(null); hideHoverPanel(); dragCache.current = {}; }}
                                    onMouseEnter={e => {
                                      if (draggingId || expandedWarnings.size > 0) return;
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      const _popColor = getInstColor(liveInst, l.isGroup);
                                      const info = buildPopoverInfo(l);
                                      setHoverPopover({ type: "student", info, rect, color: _popColor });
                                    }}
                                    onMouseLeave={() => setHoverPopover(null)}
                                    onContextMenu={e => { if (l.__isCatchup) { handleCatchupCardRightClick(e, l); return; } e.preventDefault(); setWttEmailSubmenu(null); setWttEmailLevel2(null); setSwapTeacherSubmenu(null); setContextMenu({ x: e.clientX, y: e.clientY, lessonId: l.id, studentId: l.studentId, isGroup: l.isGroup, isMulti: selectedCards.size > 1 && selectedCards.has(l.id), selectedIds: selectedCards.size > 1 && selectedCards.has(l.id) ? [...selectedCards] : null, lessonName: l.isGroup && l.studentNames ? `${l.studentNames.join(", ")} — ${l.instrument}` : `${l.studentName} — ${liveInst}` }); }}
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
                                          // v2.9.9 relational-constraint group acknowledge — ack the
                                          // whole conflict group, not just this card, so the symmetric
                                          // partner doesn't re-red on the next recompute.
                                          setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); for (const pid of getRelationalPartnerIds(l, weeklyData?.lessons, currentSchool)) next.add(pid); return next; });
                                          setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; });
                                        } else {
                                          setSelectedCards(prev => { const next = new Set(prev); if (next.has(l.id)) next.delete(l.id); else next.add(l.id); return next; });
                                        }
                                      }, 220);
                                    }}
                                    style={{
                                      padding: "6px 10px", borderRadius: 6, fontSize: 13, lineHeight: 1.4, cursor: "grab", position: "relative", zIndex: isExpanded ? 40 : 1,
                                      background: selectedCards.has(l.id) ? `${colors.sidebarActive}18` : showRed ? (darkMode ? "rgba(196,84,84,0.18)" : "#FEF2F2") : getInstColor(liveInst, l.isGroup) + "18",
                                      borderLeft: `3px solid ${selectedCards.has(l.id) ? colors.sidebarActive : showRed ? colors.danger : getInstColor(liveInst, l.isGroup)}`,
                                      borderTop: selectedCards.has(l.id) ? `1.5px solid ${colors.sidebarActive}` : "none",
                                      borderRight: selectedCards.has(l.id) ? `1.5px solid ${colors.sidebarActive}` : "none",
                                      borderBottom: selectedCards.has(l.id) ? `1.5px solid ${colors.sidebarActive}` : l.adjusted && !showRed && !hasAckedWarning ? "3px solid #F59E0B" : "none",
                                      opacity: draggingId === l.id ? 0.4 : isDayConfirmed ? 0.5 : 1, transition: "opacity 0.15s",
                                    }} title={l.isGroup ? l.groupName || l.studentName : l.adjustReason || undefined}>
                                    {showRed && <span onClick={e => { e.stopPropagation(); /* v2.9.9 relational-constraint group acknowledge — clear the whole conflict group */ setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); for (const pid of getRelationalPartnerIds(l, weeklyData?.lessons, currentSchool)) next.add(pid); return next; }); setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; }); }} onMouseEnter={e => { e.stopPropagation(); if (expandedWarnings.has(l.id)) return; const rect = e.currentTarget.parentElement.getBoundingClientRect(); setHoverPopover({ type: "constraints", warnings: cWarnings, rect, color: colors.danger }); }} onMouseLeave={e => { e.stopPropagation(); if (draggingId || expandedWarnings.size > 0) return; const cardEl = e.currentTarget.parentElement; const rect = cardEl.getBoundingClientRect(); const _popColor = getInstColor(liveInst, l.isGroup); const info = buildPopoverInfo(l); setHoverPopover({ type: "student", info, rect, color: _popColor }); }} style={{ position: "absolute", bottom: 2, right: 5, cursor: "pointer", lineHeight: 1, color: colors.success, fontWeight: 700, display: "inline-flex", alignItems: "center" }} title="Confirm this time"><Check size={11} /></span>}
                                    {hasAckedWarning && !showRed && <span onMouseEnter={e => { e.stopPropagation(); if (expandedWarnings.has(l.id)) return; const rect = e.currentTarget.parentElement.getBoundingClientRect(); setHoverPopover({ type: "constraints", warnings: cWarnings, rect, color: colors.danger }); }} onMouseLeave={e => { e.stopPropagation(); if (draggingId || expandedWarnings.size > 0) return; const cardEl = e.currentTarget.parentElement; const rect = cardEl.getBoundingClientRect(); const _popColor = getInstColor(liveInst, l.isGroup); const info = buildPopoverInfo(l); setHoverPopover({ type: "student", info, rect, color: _popColor }); }} style={{ position: "absolute", bottom: 2, right: 5, lineHeight: 1, color: colors.danger, fontWeight: 700, opacity: 0.6, display: "inline-flex", alignItems: "center" }}><AlertTriangle size={11} /></span>}
                                    {l.__isCatchup && <span style={{ position: "absolute", top: 2, right: 4, color: colors.sidebarActive, cursor: "default", lineHeight: 1, fontWeight: 700, zIndex: 2, display: "inline-flex", alignItems: "center" }} title="Catch-up lesson"><RotateCcw size={11} /></span>}
                                    {/* 4: Name + inline note icon */}
                                    <div style={{ fontWeight: 600, color: colors.text, display: "flex", alignItems: "center", gap: 4, overflow: "hidden" }}>
                                      {l.isGroup && <Users size={11} style={{ display: "inline-flex", verticalAlign: "middle", marginRight: 3, flexShrink: 0 }} />}
                                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.isGroup && l.studentNames ? (() => { const names = groupDisplayName(l); const classes = (l.studentIds || []).map(sid => { const ms = students.find(s => s.id === sid); return ms?.className || ""; }).filter(Boolean); const uniqueClasses = [...new Set(classes)]; return names + (uniqueClasses.length > 0 ? " — " + (uniqueClasses.length === 1 ? uniqueClasses[0] : uniqueClasses.join(", ")) : ""); })() : (() => { const st = students.find(s => s.id === l.studentId); return getPrefDisplayName(st?.name || l.studentName) + (st?.className ? ` · ${st.className}` : ""); })()}</span>
                                      {(() => { const _wttSt = !l.isGroup ? students.find(s => s.id === l.studentId) : null; const noteText = l.cardNote || (_wttSt?.notes || ""); if (!noteText) return null; return <span onClick={e => e.stopPropagation()} onMouseEnter={e => setHoverNotes({ text: noteText, x: e.clientX, y: e.clientY })} onMouseMove={e => setHoverNotes(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : prev)} onMouseLeave={() => setHoverNotes(null)} style={{ color: l.cardNote ? colors.accent : colors.textMuted, cursor: "default", userSelect: "none", flexShrink: 0, display: "inline-flex", alignItems: "center" }}><StickyNote size={10} /></span>; })()}
                                    </div>
                                    {/* 5: Teacher line — shows swap name */}
                                    {/* Cluster 12a: _swapTeacherId branch + _overrideActive purple-text both removed.
                                        Lane resolution carries the substitute-divergence signal at the column level
                                        via clusters 6c/7/8 (cluster 11 was retired as over-engineering). */}
                                    {(() => { const _tn = getLiveTeacherName(l, students, teachers, enrolments, teacherCoverage, laneOverrides, weekKey); const _unassigned = isLessonUnassigned(l, students, enrolments, teacherCoverage, laneOverrides, weekKey); return <div style={{ color: _unassigned ? colors.danger : colors.textLight }}>{liveInst ? `${liveInst} · ` : ""}{_unassigned ? "Unassigned" : _tn.split(" ")[0]}{l.isTemp && <span style={{ color: colors.danger, fontWeight: 700, fontSize: 10, marginLeft: 4 }}>TEMP</span>}</div>; })()}
                                    {(() => { const ds = getLiveSpecialistTag(l); return ds && draggingId !== l.id ? <div style={{ color: colors.specialistTag, fontSize: 10, fontWeight: 600 }}>during {typeof ds === "string" ? ds : "specialist"}</div> : null; })()}
                                    {l.adjusted && <div style={{ fontSize: 10, color: "#D97706", marginTop: 2, fontStyle: "italic", display: "flex", alignItems: "center", gap: 4 }}><RotateCcw size={9} /> {l.adjustReason}</div>}
                                    {isExpanded && <div style={{ position: "absolute", left: -3, right: 0, top: "100%", marginTop: 2, padding: "6px 8px", background: colors.redLight, border: `1px solid ${colors.danger}30`, borderRadius: 6, fontSize: 10, lineHeight: 1.4, zIndex: 20, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>{cWarnings.map((w, wi) => <div key={wi} style={{ color: colors.danger, fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}><AlertTriangle size={10} style={{ flexShrink: 0 }} /> {w}</div>)}</div>}
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
                  </div>
                );
              })()}

              {/* Hover warning panel — DOM-driven, no React state */}
              <div ref={hoverPanelRef} style={{
                display: "none", position: "fixed", zIndex: 9999, pointerEvents: "none",
                background: colors.cardBg, border: `1px solid ${colors.border}`,
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
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minHeight: 72, alignContent: "flex-start", borderRadius: 8, padding: 4, background: dragOverMissed ? (darkMode ? "rgba(196,84,84,0.18)" : "#FEF2F2") : "transparent", transition: "background 0.15s" }}>
                  {weeklyData.missed.length === 0 && !dragOverMissed && (
                    <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic", padding: "4px 0" }}>No missed lessons this week</div>
                  )}
                  {weeklyData.missed.map((m, i) => {
                    // When the day's Actuals toggle is ON, hide admin's missed for that day —
                    // teacher's missed will render below in their place.
                    if (m.day && dayGhostsVisible[`${weekKey}_${m.day}`]) return null;
                    const isSelectedMissed = selectedMissed.has(i);
                    const missedStudent = !m.isGroup ? students.find(s => s.id === m.studentId) : null;
                    const missedClassName = missedStudent?.className || "";
                    return (
                    <div key={i} draggable
                      onDragStart={e => { e.dataTransfer.setData("text/plain", `missed:${i}`); e.dataTransfer.effectAllowed = "move"; setDraggingId(`missed:${i}`); dragCache.current = {}; }}
                      onDragEnd={() => { setDraggingId(null); setDragOver(null); setDragOverMissed(false); setDragOverStaging(false); }}
                      onClick={e => { e.stopPropagation(); setSelectedMissed(prev => { const next = new Set(prev); next.has(i) ? next.delete(i) : next.add(i); return next; }); }}
                      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setWttEmailSubmenu(null); setWttEmailLevel2(null); setSwapTeacherSubmenu(null);
                        const isMultiMissed = selectedMissed.size > 1 && selectedMissed.has(i);
                        setContextMenu({ x: e.clientX, y: e.clientY, fromMissed: true, lessonId: m.id, studentId: m.studentId, isGroup: m.isGroup,
                          isMultiMissed, selectedMissedIndices: isMultiMissed ? [...selectedMissed] : null,
                          lessonName: m.isGroup && m.studentNames ? `${m.studentNames.join(", ")} — ${m.instrument}` : `${m.studentName} — ${m.instrument}` }); }}
                      onDoubleClick={() => { if (m.isGroup && onViewGroup) onViewGroup(m.groupId); else if (!m.isGroup && onViewStudent) onViewStudent(m.studentId); }}
                      onMouseEnter={e => {
                        let info;
                        if (m.isGroup) {
                          const grp = (groups || []).find(g => g.id === m.groupId);
                          if (!grp) return;
                          const adapted = { ...m, studentIds: grp.studentIds || [] };
                          info = buildPopoverInfo(adapted);
                        } else {
                          info = buildPopoverInfo(m);
                        }
                        const rect = e.currentTarget.getBoundingClientRect();
                        setHoverPopover({ type: "student", info, rect, color: getInstColor(m.instrument) });
                      }}
                      onMouseLeave={() => setHoverPopover(null)}
                      style={{
                        padding: "6px 10px", background: isSelectedMissed ? getInstColor(m.instrument) + "30" : getInstColor(m.instrument) + "18", borderRadius: 8, fontSize: 12,
                        border: `1px solid ${isSelectedMissed ? getInstColor(m.instrument) : getInstColor(m.instrument) + "40"}`,
                        borderLeft: `3px solid ${getInstColor(m.instrument)}`,
                        cursor: "grab", opacity: draggingId === `missed:${i}` ? 0.4 : 1,
                        transition: "opacity 0.15s, background 0.1s", maxWidth: 280,
                        boxShadow: isSelectedMissed ? `0 0 0 2px ${getInstColor(m.instrument)}40` : "none",
                        position: "relative",
                      }}>
                      <div style={{ fontWeight: 600 }}>{m.isGroup && <Users size={11} style={{ display: "inline-flex", verticalAlign: "middle", marginRight: 3, flexShrink: 0 }} />}{m.isGroup ? (() => { const grp = (groups || []).find(g => g.id === m.groupId); const memberStudents = (grp?.studentIds || []).map(sid => students.find(s => s.id === sid)).filter(Boolean); const names = memberStudents.length > 0 ? memberStudents.map(s => (s.name || "").split(" ")[0]).join(", ") : (m.groupName || "Group"); const classes = memberStudents.map(s => s.className || "").filter(Boolean); const uniqueClasses = [...new Set(classes)]; const classSuffix = uniqueClasses.length > 0 ? " — " + (uniqueClasses.length === 1 ? uniqueClasses[0] : uniqueClasses.join(", ")) : ""; return names + classSuffix; })() : getPrefDisplayName(missedStudent?.name || m.studentName)}{missedClassName ? <span style={{ fontWeight: 400, color: colors.textMuted, marginLeft: 5 }}>{missedClassName}</span> : null}</div>
                      <div style={{ color: colors.textLight, fontSize: 11 }}>
                        {m.instrument}{m.day ? ` · was ${m.day} ${m.start}` : ""}
                      </div>
                      {m.reason ? <div style={{ color: colors.danger, fontSize: 10, marginTop: 2 }}>{m.reason === "informed_absence" ? "Pre-marked absent" : getMissedReasonLabel(m.reason, m.reasonDetail)}</div> : null}
                    </div>
                    );
                  })}
                  {/* Teacher-actuals missed — read-only, pointer-events:none.
                      Only renders for days whose Actuals toggle is ON; admin's
                      missed for those same days are hidden above. */}
                  {currentTeacherActualsMissed
                    .filter(tm => tm.day && dayGhostsVisible[`${weekKey}_${tm.day}`])
                    .map((tm, ti) => {
                      const tmColor = getInstColor(tm.instrument, tm.isGroup);
                      const tmStudent = !tm.isGroup ? students.find(s => s.id === tm.studentId) : null;
                      const tmClass = tmStudent?.className || "";
                      const tmName = tm.isGroup
                        ? (groupDisplayName(tm) || tm.groupName || "Group")
                        : getPrefDisplayName(tmStudent?.name || tm.studentName || "");
                      return (
                        <div key={`teacher-missed-${tm.id || ti}`}
                          aria-hidden="true"
                          title="Teacher's actual missed (read-only)"
                          style={{
                            padding: "6px 10px",
                            background: tmColor + "18",
                            borderRadius: 8,
                            fontSize: 12,
                            border: `1px dashed ${tmColor}40`,
                            borderLeft: `3px dashed ${tmColor}`,
                            cursor: "default",
                            opacity: 0.42,
                            pointerEvents: "none",
                            maxWidth: 280,
                            position: "relative",
                          }}>
                          <div style={{ fontWeight: 600 }}>
                            {tm.isGroup && <Users size={11} style={{ display: "inline-flex", verticalAlign: "middle", marginRight: 3, flexShrink: 0 }} />}
                            {tmName}
                            {tmClass ? <span style={{ fontWeight: 400, color: colors.textMuted, marginLeft: 5 }}>{tmClass}</span> : null}
                          </div>
                          <div style={{ color: colors.textLight, fontSize: 11 }}>
                            {tm.instrument || ""}{tm.day ? ` · was ${tm.day} ${tm.start || ""}` : ""}
                          </div>
                          {tm.reason ? <div style={{ color: colors.danger, fontSize: 10, marginTop: 2 }}>{tm.reason === "informed_absence" ? "Pre-marked absent" : getMissedReasonLabel(tm.reason, tm.reasonDetail)}</div> : null}
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
                    // Spec 2 cluster 4c — card→staged transition. Card has bucket_id (post-4b);
                    // staged entries deliberately carry teacherId+teacherName instead (no day/slot →
                    // no bucket_id). Resolve teacherId from the card's bucket_id via Map; fall back
                    // to draggedLesson.teacherId for legacy pre-4b cards.
                    const bucketIdToTeacherId = new Map((teacherCoverage || []).map(l => [l.id, l.teacherId]));
                    const stagedTeacherId = (draggedLesson.bucket_id && bucketIdToTeacherId.get(draggedLesson.bucket_id))
                      || draggedLesson.teacherId
                      || "";
                    let restoredCard;
                    if (draggedLesson.isBandSession) {
                      restoredCard = { id: draggedLesson.id, isBandSession: true, bandId: draggedLesson.bandId, bandName: draggedLesson.bandName, schoolId: draggedLesson.schoolId, teacherId: stagedTeacherId, members: draggedLesson.members || [] };
                    } else {
                      restoredCard = {
                        id: draggedLesson.id, studentId: draggedLesson.studentId, studentName: draggedLesson.studentName,
                        schoolId: draggedLesson.schoolId, schoolName: draggedLesson.schoolName,
                        instrument: draggedLesson.instrument, teacherId: stagedTeacherId, teacherName: draggedLesson.teacherName,
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
                          background: c.isBandSession ? BAND_COLOR + "15" : getInstColor(c.instrument) + "18",
                          border: "1px solid " + (c.isBandSession ? BAND_COLOR : getInstColor(c.instrument)) + "40",
                          borderLeft: "3px solid " + (c.isBandSession ? BAND_COLOR : getInstColor(c.instrument)),
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
                          title="Remove" style={{ display: "inline-flex", alignItems: "center" }}><X size={10} /></span>
                        {c.isBandSession ? (
                          <>
                            <div style={{ fontWeight: 600, color: BAND_COLOR }}>{c.bandName || "Band"}</div>
                            <div style={{ color: colors.textMuted, fontSize: 11 }}>{(c.members || []).length} members · band session</div>
                            <div style={{ color: BAND_COLOR, fontSize: 10, marginTop: 2 }}>drag to place</div>
                          </>
                        ) : (
                          <>
                            <div style={{ fontWeight: 600, color: colors.text, display: "flex", alignItems: "center", gap: 5 }}><RotateCcw size={11} /> {c.studentName}</div>
                            <div style={{ color: colors.textMuted, fontSize: 11 }}>{c.instrument}{c.teacherName ? " · " + c.teacherName : ""}</div>
                            <div style={{ color: colors.textLight, fontSize: 10, marginTop: 2 }}>catch-up — drag to place</div>
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
              <div style={{ marginBottom: 12, display: "flex", justifyContent: "center", opacity: 0.5 }}><Check size={32} /></div>
              <div style={{ fontWeight: 600, color: colors.textLight }}>No weekly timetable for {currentSchool?.name || "this school"}</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Add any adjustments above and hit Reschedule to create a weekly version based on the master timetable.</div>
            </Card>
          ))}

          {/* Missed Tally */}
          {!isHolidayWeek && showMissedTally && (
            <Card style={{ marginTop: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}><Check size={15} /> Term Missed Lessons Tally</div>
              </div>
              {Object.keys(tallyByStudent).length === 0 ? (
                <div style={{ color: colors.textMuted, fontSize: 13, textAlign: "center", padding: 20 }}>No missed lessons recorded.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {Object.values(tallyByStudent).sort((a, b) => b.count - a.count).map((entry, i) => (
                    <div key={i} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "8px 12px", background: entry.count >= 3 ? (darkMode ? "rgba(196,84,84,0.18)" : "#FEF2F2") : colors.cardBg,
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

      {/* Hover popover — rendered unconditionally (position:fixed) */}
      {renderHoverPopover()}

      {/* ── Reset confirmed day modal ── */}
      {resetConfirm && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setResetConfirm(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: colors.cardBg, borderRadius: 14, padding: 24, width: 340, maxWidth: "90vw", boxShadow: "0 8px 40px rgba(0,0,0,0.25)" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(217,119,6,0.12)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <RotateCcw size={18} color="#D97706" />
              </div>
              <div style={{ fontWeight: 700, fontSize: 16, color: colors.text }}>
                Reset {new Date(resetConfirm + "T12:00:00").toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}?
              </div>
            </div>
            <p style={{ fontSize: 13, color: colors.textMuted, margin: "0 0 20px", lineHeight: 1.5 }}>
              This will delete the day slip and reopen the day for editing. The teacher will be able to re-confirm once changes are made.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setResetConfirm(null)}
                style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${colors.border}`, background: "none", fontSize: 13, cursor: "pointer", color: colors.textMuted, fontFamily: "inherit" }}
              >
                Cancel
              </button>
              <button
                onClick={() => resetConfirmedDay(resetConfirm)}
                style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: "#D97706", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}
              >
                <RotateCcw size={13} /> Reset Day
              </button>
            </div>
          </div>
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
