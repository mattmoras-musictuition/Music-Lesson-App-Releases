import React, { useState, useEffect, useMemo, useRef } from "react";

// API key for Anthropic — set by user in settings
let _anthropicApiKey = "";
function getAnthropicHeaders() {
  const key = _anthropicApiKey || (typeof localStorage !== "undefined" ? localStorage.getItem("mt-api-key") || "" : "");
  return { "Content-Type": "application/json", ...(key ? { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } : {}) };
}

// Wrapper around fetch that routes through Electron main process when running
// as a built app (file:// protocol blocks direct outbound fetch calls).
async function anthropicFetch(url, options) {
  if (window.electronAPI && window.electronAPI.anthropicFetch) {
    const body = options.body || "";
    const result = await window.electronAPI.anthropicFetch(url, options.method || "POST", options.headers || {}, body);
    // Wrap result in a fetch-like response object
    return {
      ok: result.ok,
      status: result.status,
      json: async () => JSON.parse(result.text),
      text: async () => result.text,
    };
  }
  return fetch(url, options);
}

// Load papaparse from CDN
let Papa = null;
async function getPapa() {
  if (Papa) return Papa;
  if (window.Papa) { Papa = window.Papa; return Papa; }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js";
    s.onload = () => { Papa = window.Papa; resolve(Papa); };
    s.onerror = () => reject(new Error("Failed to load PapaParse"));
    document.head.appendChild(s);
  });
}

// Lazy-load SheetJS from CDN
let _XLSX = null;
async function getXLSX() {
  if (_XLSX) return _XLSX;
  if (window.XLSX) { _XLSX = window.XLSX; return _XLSX; }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    script.onload = () => { _XLSX = window.XLSX; resolve(_XLSX); };
    script.onerror = () => reject(new Error("Failed to load SheetJS library"));
    document.head.appendChild(script);
  });
}

// ============================================================
// CONSTANTS & HELPERS
// ============================================================
const INSTRUMENTS = [
  "Piano", "Guitar", "Violin", "Viola", "Cello", "Double Bass",
  "Flute", "Clarinet", "Saxophone", "Trumpet", "Trombone", "Tuba",
  "French Horn", "Oboe", "Bassoon", "Drums", "Voice",
  "Ukulele", "Recorder", "Bass Guitar"
];

const APP_VERSION = "1.2.1";
const HEADER_HEIGHT = 90; // Height of page banners and logo box

const DATA_VERSION = 2;
// v1 → v2: added weekLabel to tallyEntries (was only weekKey)
// Migration runs on load for any stored data missing required fields.

function migrateData(key, data) {
  if (!data) return data;
  switch (key) {
    case "students":
      if (!Array.isArray(data)) return data;
      return data.map(s => {
        const base = {
          outsideClassOnly: false,
          outsideClassPreferred: false,
          availableBefore: false,
          availableAfter: false,
          avoidTimes: [],
          preferredTimes: [],
          notes: "",
          status: "active",
          ...s,
          instruments: Array.isArray(s.instruments) ? s.instruments.map(inst => ({ teacherId: "", ...inst })) : [{ name: "", teacherId: "" }],
        };
        // v1->v2: move top-level preferredTeacherId into instruments[0].teacherId
        if (base.preferredTeacherId) {
          if (base.instruments.length > 0 && !base.instruments[0].teacherId) {
            base.instruments[0] = { ...base.instruments[0], teacherId: base.preferredTeacherId };
          }
          delete base.preferredTeacherId;
        }
        // ensure parents array exists
        if (!Array.isArray(base.parents)) base.parents = [];
        return base;
      });
    case "teachers":
      if (!Array.isArray(data)) return data;
      return data.map(t => ({
        email: "",
        phone: "",
        ...t,
        availability: Array.isArray(t.availability) ? t.availability : [],
        instruments: Array.isArray(t.instruments) ? t.instruments : [],
      }));
    case "schools":
      if (!Array.isArray(data)) return data;
      return data.map(sc => ({
        ...sc,
        slots: Array.isArray(sc.slots) ? sc.slots : defaultSlots(),
        classNames: Array.isArray(sc.classNames) ? sc.classNames : [],
      }));
    case "tallyEntries":
      if (!Array.isArray(data)) return data;
      return data.map(e => ({
        ...e,
        // v2: ensure weekLabel exists; derive from weekKey if missing
        weekLabel: e.weekLabel || (e.weekKey ? `Week of ${e.weekKey}` : ""),
        makeupEligible: e.makeupEligible !== undefined ? e.makeupEligible : true,
        madeUp: e.madeUp !== undefined ? e.madeUp : false,
        status: e.status || "missed",
        // removed entries: ensure makeupEligible is always false
        ...(e.status === "removed" ? { makeupEligible: false, madeUp: false } : {}),
      }));
    case "groups":
      if (!Array.isArray(data)) return data;
      return data.map(g => ({
        status: "forming",
        memberIds: [],
        ...g,
      }));
    default:
      return data;
  }
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const SLOT_TYPES = ["class", "recess", "lunch", "before_school", "after_school"];
const SLOT_TYPE_LABELS = {
  class: "Class Period",
  recess: "Recess",
  lunch: "Lunch",
  before_school: "Before School",
  after_school: "After School"
};

const uid = () => Math.random().toString(36).slice(2, 10);

// Clamp a fixed-position menu so it stays within the viewport.
// Only nudges left/up if the menu would actually overflow — never moves
// it away from the cursor otherwise.
const clampMenuPos = (x, y, estW = 200, estH = 300, side = null) => {
  const vw = window.innerWidth, vh = window.innerHeight;
  let cx = x, cy = y;
  if (side === "right") {
    // open rightward; flip left only if it would overflow
    cx = x + estW > vw ? x - estW - 2 : x;
  } else {
    // only shift left if overflowing right edge
    if (cx + estW > vw) cx = vw - estW;
  }
  // only shift up if overflowing bottom edge
  if (cy + estH > vh) cy = vh - estH;
  return { left: cx, top: cy };
};

// Format date as YYYY-MM-DD using local timezone (NOT UTC)
// Melbourne timezone helpers — hardcoded to Australia/Melbourne
const TIMEZONE = "Australia/Melbourne";
const melbourneNow = () => {
  // Get current time in Melbourne regardless of browser timezone
  const now = new Date();
  const melb = new Date(now.toLocaleString("en-US", { timeZone: TIMEZONE }));
  return melb;
};
const melbourneToday = () => toLocalDateStr(melbourneNow());
const melbourneDayName = () => DAYS[((melbourneNow().getDay() + 6) % 7)]; // Mon=0

// Get Monday of the "current" working week.
// Rolls forward to NEXT Monday after 6pm Friday (i.e. the weekend shows next week).
const getCurrentWeekMonday = () => {
  const now = melbourneNow();
  const dow = now.getDay(); // 0=Sun, 5=Fri, 6=Sat
  const hour = now.getHours();
  // After 6pm Friday, or Saturday, or Sunday → use next Monday
  const rollForward = (dow === 5 && hour >= 18) || dow === 6 || dow === 0;
  const effective = new Date(now);
  if (rollForward) {
    // Jump to next Monday
    const daysUntilMon = dow === 0 ? 1 : (8 - dow);
    effective.setDate(effective.getDate() + daysUntilMon);
  }
  const edow = effective.getDay();
  const mondayOff = edow === 0 ? -6 : 1 - edow;
  const monday = new Date(effective);
  monday.setDate(effective.getDate() + mondayOff);
  monday.setHours(0, 0, 0, 0);
  return monday;
};

const toLocalDateStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const timeToMin = (t) => {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

function getTermWeekLabel(dateStr, termBreaks) {
  const getMondayOf = (dt) => {
    const m = new Date(dt);
    const dow = m.getDay();
    m.setDate(m.getDate() + (dow === 0 ? -6 : 1 - dow));
    m.setHours(0, 0, 0, 0);
    return m;
  };
  const d = new Date(dateStr + "T00:00:00");
  const sortedBreaks = [...(termBreaks || [])].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  let termStartDay = null;
  let breakEndMonth = -1;
  for (const tb of sortedBreaks) {
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
  const weekNum = Math.max(1, diffWeeks + 1);
  return `Week ${weekNum}`;
}

const minToTime = (m) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
};

// Convert 24h "HH:MM" to 12h "H:MM AM/PM"
const to12h = (t) => {
  if (!t || !t.includes(":")) return t;
  const [hStr, mStr] = t.split(":");
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return h + ":" + mStr + " " + ampm;
};
// Display time without AM/PM — school context makes it unambiguous
const toTimeLabel = (t) => {
  if (!t || !t.includes(":")) return t;
  const [hStr, mStr] = t.split(":");
  let h = parseInt(hStr, 10);
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return h + ":" + mStr;
};

const STORAGE_KEYS = {
  schools: "mt-schools",
  schoolsBak: "mt-schools-bak",
  students: "mt-students",
  studentsBak: "mt-students-bak",
  teachers: "mt-teachers",
  timetable: "mt-timetable",
  specialists: "mt-specialists",
  specialistsBak: "mt-specialists-bak",
  interruptions: "mt-interruptions",
  groups: "mt-groups",
  weeklyTimetables: "mt-weekly",
  tallyEntries: "mt-tally",
  timetableVersions: "mt-tt-versions",
  masterBreaks: "mt-master-breaks",
  lastScheduledBackup: "mt-last-sched-bak",
  weeklyVersions: "mt-wtt-versions",
  contacts: "mt-contacts"
};

// ============================================================
// STORAGE HELPERS
// ============================================================
// localStorage-based persistence for local app
async function saveData(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch(e) {
    console.error("saveData failed for", key, e);
  }
}

// Auto-backup: writes a downloadable JSON to a fixed filename so it can be 
// restored easily. Called after any significant data change.
function triggerAutoBackup(data) {
  try {
    const json = JSON.stringify(data, null, 2);
    localStorage.setItem("mt-last-autobak", json);
    localStorage.setItem("mt-last-autobak-time", new Date().toISOString());
  } catch(e) {}
}

// Saves students to both the primary and backup key
async function saveStudents(data) {
  await saveData(STORAGE_KEYS.students, data);
  await saveData(STORAGE_KEYS.studentsBak, data);
}

async function loadData(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch(e) {
    return fallback;
  }
}

// Loads students from primary key; if empty, tries backup and repairs primary
async function loadStudents() {
  const primary = await loadData(STORAGE_KEYS.students, []);
  if (primary.length > 0) return primary;
  const backup = await loadData(STORAGE_KEYS.studentsBak, []);
  if (backup.length > 0) {
    await saveData(STORAGE_KEYS.students, backup);
    return backup;
  }
  return [];
}

async function loadSchools() {
  const primary = await loadData(STORAGE_KEYS.schools, []);
  if (primary.length > 0) return primary;
  const backup = await loadData(STORAGE_KEYS.schoolsBak, []);
  if (backup.length > 0) {
    await saveData(STORAGE_KEYS.schools, backup);
    return backup;
  }
  return [];
}

async function loadSpecialists() {
  const primary = await loadData(STORAGE_KEYS.specialists, []);
  if (primary.length > 0) return primary;
  const backup = await loadData(STORAGE_KEYS.specialistsBak, []);
  if (backup.length > 0) {
    await saveData(STORAGE_KEYS.specialists, backup);
    return backup;
  }
  return [];
}

// ============================================================
// DEFAULT SCHOOL TEMPLATES
// ============================================================
const defaultSlots = () => [
  { id: uid(), name: "Slot 1", start: "08:00", end: "08:30", type: "before_school" },
  { id: uid(), name: "Slot 2", start: "08:30", end: "09:00", type: "before_school" },
  { id: uid(), name: "Slot 3", start: "09:00", end: "09:30", type: "class" },
  { id: uid(), name: "Slot 4", start: "09:30", end: "10:00", type: "class" },
  { id: uid(), name: "Slot 5", start: "10:00", end: "10:30", type: "class" },
  { id: uid(), name: "Slot 6", start: "10:30", end: "11:00", type: "class" },
  { id: uid(), name: "Slot 7", start: "11:00", end: "11:30", type: "recess" },
  { id: uid(), name: "Slot 8", start: "11:30", end: "12:00", type: "class" },
  { id: uid(), name: "Slot 9", start: "12:00", end: "12:30", type: "class" },
  { id: uid(), name: "Slot 10", start: "12:30", end: "13:00", type: "class" },
  { id: uid(), name: "Slot 11", start: "13:00", end: "13:30", type: "class" },
  { id: uid(), name: "Slot 12", start: "13:30", end: "14:00", type: "lunch" },
  { id: uid(), name: "Slot 13", start: "14:00", end: "14:30", type: "lunch" },
  { id: uid(), name: "Slot 14", start: "14:30", end: "15:00", type: "class" },
  { id: uid(), name: "Slot 15", start: "15:00", end: "15:30", type: "class" },
  { id: uid(), name: "Slot 16", start: "15:30", end: "16:00", type: "after_school" },
  { id: uid(), name: "Slot 17", start: "16:00", end: "16:30", type: "after_school" },
  { id: uid(), name: "Slot 18", start: "16:30", end: "17:00", type: "after_school" },
  { id: uid(), name: "Slot 19", start: "17:00", end: "17:30", type: "after_school" },
  { id: uid(), name: "Slot 20", start: "17:30", end: "18:00", type: "after_school" },
];

// ============================================================
// SCHEDULING ALGORITHM
// ============================================================
function generateMasterTimetable(schools, students, teachers, specialistTimetable = [], { existingLessons = [], targetSchoolId = null } = {}) {
  const activeStudents = students.filter(s => s.status === "active");
  // If targeting a specific school, only schedule students at that school
  const studentsToSchedule = targetSchoolId
    ? activeStudents.filter(s => s.schoolId === targetSchoolId)
    : activeStudents;
  const lessons = [];
  const unscheduled = [];

  // Build teacher availability map: teacher -> day -> [{start, end}]
  const teacherSchedule = {}; // teacherId -> [{day, slotId, schoolId, start, end}]
  teachers.forEach(t => { teacherSchedule[t.id] = []; });

  // Pre-populate teacher schedules with existing lessons from other schools
  // This prevents double-booking teachers when regenerating a single school
  const studentDayMap = {}; // studentId -> Set of days already scheduled
  for (const el of existingLessons) {
    if (teacherSchedule[el.teacherId]) {
      teacherSchedule[el.teacherId].push({
        day: el.day, slotId: el.slotId, schoolId: el.schoolId,
        start: el.start, end: el.end
      });
    }
    // Track student days from existing lessons (e.g. group lessons)
    if (el.studentId) {
      if (!studentDayMap[el.studentId]) studentDayMap[el.studentId] = new Set();
      studentDayMap[el.studentId].add(el.day);
    }
    // For group lessons, track all member student days
    if (el.isGroup && el.studentIds) {
      for (const sid of el.studentIds) {
        if (!studentDayMap[sid]) studentDayMap[sid] = new Set();
        studentDayMap[sid].add(el.day);
      }
    }
    lessons.push(el);
  }

  // Build break lookup: for each school+teacher combo, determine which breaks apply
  // Priority: school-defined breaks override teacher-defined per-school breaks
  const schoolBreaksLookup = {};
  for (const school of schools) {
    schoolBreaksLookup[school.id] = (school.teacherBreaks || []).map(b => ({
      start: timeToMin(b.start), end: timeToMin(b.end)
    }));
  }
  const teacherBreaksLookup = {};
  for (const teacher of teachers) {
    teacherBreaksLookup[teacher.id] = {};
    for (const tb of (teacher.teacherBreaks || [])) {
      if (!teacherBreaksLookup[teacher.id][tb.schoolId]) teacherBreaksLookup[teacher.id][tb.schoolId] = [];
      teacherBreaksLookup[teacher.id][tb.schoolId].push({ start: timeToMin(tb.start), end: timeToMin(tb.end), day: tb.day || "All" });
    }
  }

  // Check if a slot is during a break for a specific teacher at a specific school on a specific day
  // School-level breaks override and apply every day; teacher-level breaks can be day-specific
  // Uses midpoint check: the slot's midpoint must fall within the break window
  // This prevents a 5-minute edge overlap from blocking an entire 30-minute lesson
  const isDuringBreak = (teacherId, schoolId, day, slotStart, slotEnd) => {
    const sStart = timeToMin(slotStart);
    const sEnd = timeToMin(slotEnd);
    const sMid = (sStart + sEnd) / 2;

    const schoolBreaks = schoolBreaksLookup[schoolId];
    if (schoolBreaks && schoolBreaks.length > 0) {
      return schoolBreaks.some(b => sMid >= b.start && sMid < b.end);
    }
    // Fall back to teacher's per-school breaks, filtered by day
    const teacherBreaks = teacherBreaksLookup[teacherId]?.[schoolId] || [];
    if (teacherBreaks.length === 0) return false;
    return teacherBreaks.some(b => (b.day === "All" || b.day === day) && sMid >= b.start && sMid < b.end);
  };

  // Build specialist lookup: schoolId -> className -> day -> [{start, end, subject, partial}]
  const specLookup = {};
  for (const entry of specialistTimetable) {
    const key = `${entry.schoolId}|${entry.className}|${entry.day}`;
    if (!specLookup[key]) specLookup[key] = [];
    specLookup[key].push({ start: entry.start, end: entry.end, subject: entry.subject, partial: entry._partial || false });
  }

  // Check if a slot overlaps with a specialist class for a given student
  const isSpecialistTime = (schoolId, className, day, slotStart, slotEnd) => {
    const key = `${schoolId}|${className}|${day}`;
    const specs = specLookup[key];
    if (!specs) return false;
    const sStart = timeToMin(slotStart);
    const sEnd = timeToMin(slotEnd);
    return specs.some(sp => {
      const spStart = timeToMin(sp.start);
      const spEnd = timeToMin(sp.end);
      return sStart < spEnd && sEnd > spStart; // overlap check
    });
  };

  // Return the specialist subject name overlapping a slot, or null
  const getSpecialistName = (schoolId, className, day, slotStart, slotEnd) => {
    const key = `${schoolId}|${className}|${day}`;
    const specs = specLookup[key];
    if (!specs) return null;
    const sStart = timeToMin(slotStart);
    const sEnd = timeToMin(slotEnd);
    const match = specs.find(sp => {
      const spStart = timeToMin(sp.start);
      const spEnd = timeToMin(sp.end);
      return sStart < spEnd && sEnd > spStart;
    });
    return match ? match.subject : null;
  };

  // Check if a specialist time is partial (doesn't run every week — scheduling here is preferred)
  const isPartialSpecialist = (schoolId, className, day, slotStart, slotEnd) => {
    const key = `${schoolId}|${className}|${day}`;
    const specs = specLookup[key];
    if (!specs) return false;
    const sStart = timeToMin(slotStart);
    const sEnd = timeToMin(slotEnd);
    return specs.some(sp => {
      const spStart = timeToMin(sp.start);
      const spEnd = timeToMin(sp.end);
      return sStart < spEnd && sEnd > spStart && sp.partial;
    });
  };

  // Sort students: requiredTimes first (hardest to place), then most constraints,
  // then group by school and class for classmate clustering
  const sortedStudents = [...studentsToSchedule].sort((a, b) => {
    const aHints = a._noteHints || {};
    const bHints = b._noteHints || {};
    // Highest priority: students with requiredTimes in their notes
    const aRequired = (aHints.requiredTimes || []).length;
    const bRequired = (bHints.requiredTimes || []).length;
    if (aRequired !== bRequired) return bRequired - aRequired;
    // Then: students with more constraints
    const aConstraints = (a.outsideClassOnly ? 3 : 0) + (a.outsideClassPreferred ? 2 : 0) +
      (a.instruments.some(i => i.teacherId) ? 2 : 0) +
      ((aHints.avoidDays || []).length * 2) + ((aHints.avoidTimes || []).length * 2) +
      ((aHints.preferredDays || []).length) + ((aHints.preferredTimes || []).length) +
      (a.instruments.length > 1 ? 2 : 0) + (a.instruments.some(i => i.isGroup) ? 2 : 0);
    const bConstraints = (b.outsideClassOnly ? 3 : 0) + (b.outsideClassPreferred ? 2 : 0) +
      (b.instruments.some(i => i.teacherId) ? 2 : 0) +
      ((bHints.avoidDays || []).length * 2) + ((bHints.avoidTimes || []).length * 2) +
      ((bHints.preferredDays || []).length) + ((bHints.preferredTimes || []).length) +
      (b.instruments.length > 1 ? 2 : 0) + (b.instruments.some(i => i.isGroup) ? 2 : 0);
    if (aConstraints !== bConstraints) return bConstraints - aConstraints;
    // Group by school
    if (a.schoolId !== b.schoolId) return a.schoolId < b.schoolId ? -1 : 1;
    // Group by class within school
    if ((a.className || "") !== (b.className || "")) return (a.className || "").localeCompare(b.className || "");
    return 0;
  });

  // Build class membership lookup for efficient classmate adjacency checks
  const classMates = {}; // "schoolId|className" -> Set of studentIds
  for (const s of studentsToSchedule) {
    const key = `${s.schoolId}|${s.className || ""}`;
    if (!classMates[key]) classMates[key] = new Set();
    classMates[key].add(s.id);
  }

  for (const student of sortedStudents) {
    const school = schools.find(s => s.id === student.schoolId);
    if (!school) {
      unscheduled.push({ student, reason: "School not found" });
      continue;
    }

    const hints = student._noteHints || {};

    // Filter valid required times (must have both day and start) — shared across all instruments
    const allRequiredTimes = (hints.requiredTimes || []).filter(rt => rt.day && rt.start && rt.day !== "any");
    const usedRequiredTimeIdxs = new Set();

    // If requiredTimes specify multiple entries on the same day, allow same-day scheduling for that day
    const requiredSameDayAllowed = new Set();
    const reqDayCounts = {};
    for (const rt of allRequiredTimes) {
      reqDayCounts[rt.day] = (reqDayCounts[rt.day] || 0) + 1;
    }
    for (const d in reqDayCounts) {
      if (reqDayCounts[d] > 1) requiredSameDayAllowed.add(d);
    }

    // Collect non-group instruments for scheduling
    const individualInsts = student.instruments.filter(i => !i.isGroup);
    // Check if student has multiple lessons total (individual + group)
    const studentExistingDays = studentDayMap[student.id] || new Set();
    const hasGroupLesson = studentExistingDays.size > 0;
    const isMultiInstrument = individualInsts.length > 1 || hasGroupLesson;
    let classTimeUsedByInst = null; // track which instrument index used a class-time slot

    // If student already has a group lesson, treat first individual instrument as "second"
    // meaning it should be outside class time
    let classTimeUsedFromGroup = hasGroupLesson;

    // Try scheduling instruments. For multi-instrument students, if the second fails
    // with an outside-class constraint, retry with the instruments swapped.
    const scheduleInstruments = (instOrder) => {
      const scheduledLessons = []; // lessons we've added this round
      const scheduledTeacherEntries = []; // teacher schedule entries we've added
      let allScheduled = true;
      let perInstResults = []; // { inst, scheduled, reason, usedRequiredIdx }
      let classTimeUsed = classTimeUsedFromGroup;
      // Track days this student already has lessons on (for different-day constraint)
      const usedDays = new Set(studentExistingDays);

      for (let oi = 0; oi < instOrder.length; oi++) {
        const inst = instOrder[oi];
        const mustBeOutsideClass = isMultiInstrument && classTimeUsed;
        let scheduled = false;

        // Find compatible teachers (any teacher who teaches this instrument at this level at this school)
        let compatibleTeachers = teachers.filter(t => {
          const teachesInst = t.instruments.find(
            ti => ti.name === inst.name
          );
          const teachesAtSchool = t.availability.some(a => a.schoolId === school.id);
          return teachesInst && teachesAtSchool;
        });

        // Teacher is manually assigned per-instrument — always use the allocated teacher, no exceptions
        if (inst.teacherId) {
          const assignedTeacher = compatibleTeachers.find(t => t.id === inst.teacherId);
          if (assignedTeacher) {
            compatibleTeachers = [assignedTeacher];
          } else {
            // Assigned teacher can't teach this instrument at this school — fail with clear reason
            const assignedName = teachers.find(t => t.id === inst.teacherId)?.name || "Unknown";
            perInstResults.push({ inst, scheduled: false, reason: `Assigned teacher (${assignedName}) cannot teach ${inst.name} at ${school.name}` });
            allScheduled = false;
            continue;
          }
        }

        if (compatibleTeachers.length === 0) {
          perInstResults.push({ inst, scheduled: false, reason: "No compatible teacher" });
          allScheduled = false;
          continue;
        }

        const orderedDays = [...school.days].sort((a, b) => {
          const aPreferred = hints.preferredDays?.includes(a) ? -1 : 0;
          const bPreferred = hints.preferredDays?.includes(b) ? -1 : 0;
          const aAvoided = hints.avoidDays?.includes(a) ? 1 : 0;
          const bAvoided = hints.avoidDays?.includes(b) ? 1 : 0;
          const prefDiff = (aPreferred + aAvoided) - (bPreferred + bAvoided);
          if (prefDiff !== 0) return prefDiff;

          // Soft: prefer days where compatible teachers already have lessons at this school
          // (keeps teacher schedule compact, enables back-to-back)
          const aTeacherLessons = compatibleTeachers.reduce((sum, t) =>
            sum + teacherSchedule[t.id].filter(l => l.day === a && l.schoolId === school.id).length, 0);
          const bTeacherLessons = compatibleTeachers.reduce((sum, t) =>
            sum + teacherSchedule[t.id].filter(l => l.day === b && l.schoolId === school.id).length, 0);
          if (aTeacherLessons !== bTeacherLessons) return bTeacherLessons - aTeacherLessons;

          // Soft: prefer days where classmates already have lessons (class clustering)
          const classKey = `${school.id}|${student.className || ""}`;
          const classMateIds = classMates[classKey];
          const aClassmates = classMateIds ? lessons.filter(l => l.schoolId === school.id && l.day === a &&
            classMateIds.has(l.studentId) && l.studentId !== student.id).length : 0;
          const bClassmates = classMateIds ? lessons.filter(l => l.schoolId === school.id && l.day === b &&
            classMateIds.has(l.studentId) && l.studentId !== student.id).length : 0;
          if (aClassmates !== bClassmates) return bClassmates - aClassmates;

          // For prefer-not schools: strongly prefer days that have at least one free non-specialist
          // class slot available (checked against all compatible teachers)
          if (school.specialistPolicy === "prefer-not") {
            const hasFreeClassSlot = (day) => school.slots.some(slot => {
              if (slot.type !== "class") return false;
              if (isSpecialistTime(school.id, student.className, day, slot.start, slot.end)) return false;
              return compatibleTeachers.some(t => {
                const dayAvail = t.availability.find(av => av.schoolId === school.id && av.day === day);
                if (!dayAvail) return false;
                const slotStart = timeToMin(slot.start), slotEnd = timeToMin(slot.end);
                if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) return false;
                return !teacherSchedule[t.id].find(l => l.day === day && timeToMin(l.start) < slotEnd && timeToMin(l.end) > slotStart);
              });
            });
            const aHasFree = hasFreeClassSlot(a) ? 0 : 1;
            const bHasFree = hasFreeClassSlot(b) ? 0 : 1;
            if (aHasFree !== bHasFree) return aHasFree - bHasFree;
          }

          return 0;
        });

        // Helper: compute adjacency score for a slot on a given day
        // Lower = more adjacent to existing teacher lessons and classmate lessons
        const getAdjacencyScore = (slot, day) => {
          const slotMin = timeToMin(slot.start);
          let bestTeacherGap = 9999;
          let bestClassmateGap = 9999;

          // Check teacher adjacency: how close is this slot to the teacher's existing lessons?
          for (const teacher of compatibleTeachers) {
            for (const l of teacherSchedule[teacher.id]) {
              if (l.day !== day || l.schoolId !== school.id) continue;
              const existStart = timeToMin(l.start);
              const existEnd = timeToMin(l.end);
              // Gap = 0 means perfectly back-to-back
              const gap = Math.min(Math.abs(slotMin - existEnd), Math.abs(existStart - timeToMin(slot.end)));
              bestTeacherGap = Math.min(bestTeacherGap, gap);
            }
          }

          // Check classmate adjacency
          const classKey2 = `${school.id}|${student.className || ""}`;
          const myClassMates = classMates[classKey2];
          if (myClassMates) {
            for (const l of lessons) {
              if (l.schoolId !== school.id || l.day !== day) continue;
              if (!myClassMates.has(l.studentId) || l.studentId === student.id) continue;
              const existStart = timeToMin(l.start);
              const existEnd = timeToMin(l.end);
              const gap = Math.min(Math.abs(slotMin - existEnd), Math.abs(existStart - timeToMin(slot.end)));
              bestClassmateGap = Math.min(bestClassmateGap, gap);
            }
          }

          // Weight teacher adjacency more (back-to-back is most important), classmate as secondary
          return (bestTeacherGap === 9999 ? 500 : bestTeacherGap) + (bestClassmateGap === 9999 ? 200 : bestClassmateGap * 0.5);
        };

        const getSortedSlots = (day) => {
          return [...school.slots].sort((a, b) => {
            const aIsSpec = isSpecialistTime(school.id, student.className, day, a.start, a.end);
            const bIsSpec = isSpecialistTime(school.id, student.className, day, b.start, b.end);
            const aIsPartial = aIsSpec && isPartialSpecialist(school.id, student.className, day, a.start, a.end);
            const bIsPartial = bIsSpec && isPartialSpecialist(school.id, student.className, day, b.start, b.end);
            const aIsBreak = ["recess", "lunch", "before_school", "after_school"].includes(a.type);
            const bIsBreak = ["recess", "lunch", "before_school", "after_school"].includes(b.type);

            const aIsPrefTime = hints.preferredTimes?.some(pt => pt.day === day && a.start === pt.start) ? -2 : 0;
            const bIsPrefTime = hints.preferredTimes?.some(pt => pt.day === day && b.start === pt.start) ? -2 : 0;
            if (aIsPrefTime !== bIsPrefTime) return aIsPrefTime - bIsPrefTime;

            if (mustBeOutsideClass) {
              if ((aIsSpec || aIsBreak) && !(bIsSpec || bIsBreak)) return -1;
              if (!(aIsSpec || aIsBreak) && (bIsSpec || bIsBreak)) return 1;
            } else if (student.outsideClassPreferred) {
              if (aIsBreak && !bIsBreak) return -1;
              if (!aIsBreak && bIsBreak) return 1;
              if (aIsSpec && !bIsSpec) return -1;
              if (!aIsSpec && bIsSpec) return 1;
            } else if (isMultiInstrument && !classTimeUsed) {
              const aOutside = aIsSpec || aIsBreak ? -1 : 0;
              const bOutside = bIsSpec || bIsBreak ? -1 : 0;
              if (aOutside !== bOutside) return aOutside - bOutside;
            } else if (school.specialistPolicy === "prefer-not") {
              // Strong preference against specialist slots — try all non-specialist class slots first,
              // then breaks/before-after, then specialist slots as last resort
              const aSpecAllowed = aIsSpec && hints.allowedSpecialists?.length > 0 &&
                getSpecialistSubject(specLookup, school.id, student.className, day, a.start, a.end, hints.allowedSpecialists);
              const bSpecAllowed = bIsSpec && hints.allowedSpecialists?.length > 0 &&
                getSpecialistSubject(specLookup, school.id, student.className, day, b.start, b.end, hints.allowedSpecialists);
              // non-specialist class: 0, break: 1, allowed specialist: 5, any specialist: 8
              const aScore = !aIsSpec ? (aIsBreak ? 1 : 0) : aIsPartial ? 4 : aSpecAllowed ? 5 : 8;
              const bScore = !bIsSpec ? (bIsBreak ? 1 : 0) : bIsPartial ? 4 : bSpecAllowed ? 5 : 8;
              if (aScore !== bScore) return aScore - bScore;
            } else {
              const aSpecAllowed = aIsSpec && hints.allowedSpecialists?.length > 0 &&
                getSpecialistSubject(specLookup, school.id, student.className, day, a.start, a.end, hints.allowedSpecialists);
              const bSpecAllowed = bIsSpec && hints.allowedSpecialists?.length > 0 &&
                getSpecialistSubject(specLookup, school.id, student.className, day, b.start, b.end, hints.allowedSpecialists);
              const aScore = !aIsSpec ? 0 : aIsPartial ? 1 : aSpecAllowed ? 1.5 : 3;
              const bScore = !bIsSpec ? 0 : bIsPartial ? 1 : bSpecAllowed ? 1.5 : 3;
              if (aScore !== bScore) return aScore - bScore;
              if (!aIsBreak && bIsBreak) return -1;
              if (aIsBreak && !bIsBreak) return 1;
            }

            // Primary sort after constraints: back-to-back with teacher's existing lessons
            const aAdj = getAdjacencyScore(a, day);
            const bAdj = getAdjacencyScore(b, day);
            return aAdj - bAdj;
          });
        };

        const tryBook = (day, slot) => {
          // Hard constraint: multi-lesson students must have lessons on different days
          // (same-day override only applies in PASS 1 via tryBookForced for requiredTimes)
          if (isMultiInstrument && usedDays.has(day)) return false;

          const slotIsSpecialist = isSpecialistTime(school.id, student.className, day, slot.start, slot.end);
          if (!isSlotAllowed(slot, student, school, mustBeOutsideClass, slotIsSpecialist, day, hints)) return false;

          for (const teacher of compatibleTeachers) {
            if (isDuringBreak(teacher.id, school.id, day, slot.start, slot.end)) continue;
            const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === day);
            if (!dayAvail) continue;

            const slotStart = timeToMin(slot.start);
            const slotEnd = timeToMin(slot.end);
            if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) continue;

            if (teacherSchedule[teacher.id].find(l => l.day === day && timeToMin(l.start) < slotEnd && timeToMin(l.end) > slotStart)) continue;

            let travelConflict = false;
            for (const existing of teacherSchedule[teacher.id].filter(l => l.day === day)) {
              if (existing.schoolId !== school.id) {
                const existEnd = timeToMin(existing.end);
                const existStart = timeToMin(existing.start);
                if (Math.abs(slotStart - existEnd) < 30 && slotStart >= existEnd) { travelConflict = true; break; }
                if (Math.abs(existStart - slotEnd) < 30 && existStart >= slotEnd) { travelConflict = true; break; }
              }
            }
            if (travelConflict) continue;

            if (lessons.find(l => l.studentId === student.id && l.day === day && l.slotId === slot.id)) continue;

            const lesson = {
              id: uid(),
              studentId: student.id, studentName: student.name,
              teacherId: teacher.id, teacherName: teacher.name,
              schoolId: school.id, schoolName: school.name,
              day, slotId: slot.id, slotName: slot.name,
              start: slot.start, end: slot.end,
              instrument: inst.name,
              duringSpecialist: slotIsSpecialist ? (getSpecialistName(school.id, student.className, day, slot.start, slot.end) || true) : false
            };
            lessons.push(lesson);
            scheduledLessons.push(lesson);
            const tEntry = { day, slotId: slot.id, schoolId: school.id, start: slot.start, end: slot.end };
            teacherSchedule[teacher.id].push(tEntry);
            scheduledTeacherEntries.push({ teacherId: teacher.id, entry: tEntry });

            // Track if this used a class-time slot
            const isClassTime = slot.type === "class" && !slotIsSpecialist;
            if (isClassTime) classTimeUsed = true;
            usedDays.add(day);
            return true;
          }
          return false;
        };

        const findSlotForTime = (time) => {
          let targetMin = timeToMin(time);
          if (targetMin < 420) {
            const pmMin = targetMin + 720;
            const pmSlot = school.slots.find(s => s.start === `${String(Math.floor(pmMin / 60)).padStart(2, "0")}:${String(pmMin % 60).padStart(2, "0")}`);
            if (pmSlot) return pmSlot;
            const pmContain = school.slots.find(s => timeToMin(s.start) <= pmMin && timeToMin(s.end) > pmMin);
            if (pmContain) return pmContain;
            const pmClose = school.slots.reduce((best, s) => {
              const diff = Math.abs(timeToMin(s.start) - pmMin);
              return diff < 15 && diff < (best ? best.diff : Infinity) ? { slot: s, diff } : best;
            }, null);
            if (pmClose) return pmClose.slot;
          }
          let slot = school.slots.find(s => s.start === time);
          if (slot) return slot;
          slot = school.slots.find(s => timeToMin(s.start) <= targetMin && timeToMin(s.end) > targetMin);
          if (slot) return slot;
          let closest = null, closestDiff = Infinity;
          for (const s of school.slots) {
            const diff = Math.abs(timeToMin(s.start) - targetMin);
            if (diff < closestDiff && diff <= 15) { closestDiff = diff; closest = s; }
          }
          return closest;
        };

        const tryBookForced = (day, slot) => {
          // Hard constraint: multi-lesson students must have lessons on different days
          // (unless requiredTimes explicitly specify multiple lessons on this day)
          if (isMultiInstrument && usedDays.has(day) && !requiredSameDayAllowed.has(day)) return `student already has lesson on ${day}`;
          const reasons = [];
          for (const teacher of compatibleTeachers) {
            if (isDuringBreak(teacher.id, school.id, day, slot.start, slot.end)) {
              reasons.push(`${teacher.name}: break at ${slot.start}–${slot.end}`);
              continue;
            }
            const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === day);
            if (!dayAvail) { reasons.push(`${teacher.name}: not available ${day}`); continue; }
            const slotStart = timeToMin(slot.start);
            const slotEnd = timeToMin(slot.end);
            if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) {
              reasons.push(`${teacher.name}: slot outside availability (${dayAvail.start}–${dayAvail.end})`); continue;
            }
            if (teacherSchedule[teacher.id].find(l => l.day === day && timeToMin(l.start) < slotEnd && timeToMin(l.end) > slotStart)) {
              reasons.push(`${teacher.name}: already booked at ${slot.start}`); continue;
            }
            let travelConflict = false;
            for (const existing of teacherSchedule[teacher.id].filter(l => l.day === day)) {
              if (existing.schoolId !== school.id) {
                const existEnd = timeToMin(existing.end);
                const existStart = timeToMin(existing.start);
                if ((Math.abs(slotStart - existEnd) < 30 && slotStart >= existEnd) ||
                    (Math.abs(existStart - slotEnd) < 30 && existStart >= slotEnd)) { travelConflict = true; break; }
              }
            }
            if (travelConflict) { reasons.push(`${teacher.name}: travel conflict`); continue; }
            if (lessons.find(l => l.studentId === student.id && l.day === day && l.slotId === slot.id)) {
              reasons.push(`student already has lesson at ${slot.start}`); continue;
            }
            const slotIsSpecialist = isSpecialistTime(school.id, student.className, day, slot.start, slot.end);
            const lesson = {
              id: uid(),
              studentId: student.id, studentName: student.name,
              teacherId: teacher.id, teacherName: teacher.name,
              schoolId: school.id, schoolName: school.name,
              day, slotId: slot.id, slotName: slot.name,
              start: slot.start, end: slot.end,
              instrument: inst.name,
              duringSpecialist: slotIsSpecialist ? (getSpecialistName(school.id, student.className, day, slot.start, slot.end) || true) : false,
              _pinned: true // placed by required time — do not move during compaction
            };
            lessons.push(lesson);
            scheduledLessons.push(lesson);
            const tEntry = { day, slotId: slot.id, schoolId: school.id, start: slot.start, end: slot.end };
            teacherSchedule[teacher.id].push(tEntry);
            scheduledTeacherEntries.push({ teacherId: teacher.id, entry: tEntry });
            const isClassTime = slot.type === "class" && !slotIsSpecialist;
            if (isClassTime) classTimeUsed = true;
            usedDays.add(day);
            return true;
          }
          return reasons.length > 0 ? reasons.join("; ") : "no compatible teachers";
        };

        // PASS 1: required times — try instrument-specific matches first, then unspecified ones
        const remainingRequiredTimes = allRequiredTimes.filter((_, i) => !usedRequiredTimeIdxs.has(i));
        let noteMismatch = false;
        let pass1FailReason = "";
        if (remainingRequiredTimes.length > 0) {
          // First: try requiredTimes that match THIS instrument by name
          for (let ri = 0; ri < allRequiredTimes.length; ri++) {
            if (scheduled) break;
            if (usedRequiredTimeIdxs.has(ri)) continue;
            const rt = allRequiredTimes[ri];
            if (!rt.instrument || rt.instrument.toLowerCase() !== inst.name.toLowerCase()) continue;
            const slot = findSlotForTime(rt.start);
            if (!slot) { pass1FailReason = `No slot found for ${rt.day} ${rt.start}`; continue; }
            const result = tryBookForced(rt.day, slot);
            if (result === true) {
              scheduled = true;
              usedRequiredTimeIdxs.add(ri);
            } else {
              pass1FailReason = `${rt.day} ${slot.start}: ${result}`;
            }
          }
          // Second: try requiredTimes without an instrument specified (assigned in order)
          if (!scheduled) {
            for (let ri = 0; ri < allRequiredTimes.length; ri++) {
              if (scheduled) break;
              if (usedRequiredTimeIdxs.has(ri)) continue;
              const rt = allRequiredTimes[ri];
              if (rt.instrument) continue; // skip instrument-specific ones not matching us
              const slot = findSlotForTime(rt.start);
              if (!slot) { pass1FailReason = `No slot found for ${rt.day} ${rt.start}`; continue; }
              const result = tryBookForced(rt.day, slot);
              if (result === true) {
                scheduled = true;
                usedRequiredTimeIdxs.add(ri);
              } else {
                pass1FailReason = `${rt.day} ${slot.start}: ${result}`;
              }
            }
          }
          if (!scheduled) noteMismatch = true;
        }

        // PASS 2: normal scheduling
        if (!scheduled) {
          for (const day of orderedDays) {
            if (scheduled) break;
            const sortedSlots = getSortedSlots(day);
            for (const slot of sortedSlots) {
              if (scheduled) break;
              scheduled = tryBook(day, slot);
            }
          }
        }

        if (scheduled && noteMismatch) {
          const lastLesson = lessons[lessons.length - 1];
          lastLesson.noteMismatch = `Requested: ${allRequiredTimes.map(rt => `${rt.day} ${rt.start}`).join(", ")}${pass1FailReason ? ` — ${pass1FailReason}` : ""}`;
        }

        // Also mark ALL this student's lessons if any requiredTime failed
        if (noteMismatch && pass1FailReason) {
          for (const sl of scheduledLessons) {
            if (!sl.noteMismatch) sl.noteMismatch = pass1FailReason;
          }
        }

        perInstResults.push({
          inst, scheduled, noteMismatch, pass1FailReason,
          reason: !scheduled ? (noteMismatch
            ? `No slot available (requested: ${allRequiredTimes.map(rt => `${rt.day} ${rt.start}`).join(", ")}${pass1FailReason ? ` — ${pass1FailReason}` : ""})`
            : "No available slot") : null
        });
        if (!scheduled) allScheduled = false;
      }

      return { allScheduled, perInstResults, scheduledLessons, scheduledTeacherEntries };
    };

    // Helper: undo lessons and teacher entries added during a scheduling attempt
    const undoScheduling = (result) => {
      for (const lesson of result.scheduledLessons) {
        const idx = lessons.indexOf(lesson);
        if (idx >= 0) lessons.splice(idx, 1);
      }
      for (const { teacherId, entry } of result.scheduledTeacherEntries) {
        const idx = teacherSchedule[teacherId].indexOf(entry);
        if (idx >= 0) teacherSchedule[teacherId].splice(idx, 1);
      }
    };

    // Attempt 1: schedule instruments in original order
    let result = scheduleInstruments(individualInsts);

    // Attempt 2: if multi-instrument and not all scheduled, try reversed order
    // (lets the other instrument take class time instead)
    if (!result.allScheduled && isMultiInstrument) {
      undoScheduling(result);
      const reversed = [...individualInsts].reverse();
      const result2 = scheduleInstruments(reversed);
      if (result2.allScheduled || result2.perInstResults.filter(r => r.scheduled).length > result.perInstResults.filter(r => r.scheduled).length) {
        result = result2; // reversed order was better
      } else {
        // Original order was at least as good — undo reversed, redo original
        undoScheduling(result2);
        result = scheduleInstruments(individualInsts);
      }
    }

    // Record failures
    for (const r of result.perInstResults) {
      if (!r.scheduled && r.reason) {
        unscheduled.push({ student, instrument: r.inst.name, reason: r.reason });
      }
    }
    // Update global student day map for subsequent scheduling
    for (const l of result.scheduledLessons) {
      if (!studentDayMap[student.id]) studentDayMap[student.id] = new Set();
      studentDayMap[student.id].add(l.day);
    }
  }

  // SAFETY: detect and remove any teacher double-bookings
  const dbFound = [];
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) {
      if (lessons[i].teacherId === lessons[j].teacherId &&
          lessons[i].day === lessons[j].day &&
          timeToMin(lessons[i].start) < timeToMin(lessons[j].end) &&
          timeToMin(lessons[j].start) < timeToMin(lessons[i].end)) {
        dbFound.push(j);
      }
    }
  }
  if (dbFound.length > 0) {
    const removed = [...new Set(dbFound)].sort((a, b) => b - a);
    for (const idx of removed) {
      const l = lessons[idx];
      unscheduled.push({
        student: studentsToSchedule.find(s => s.id === l.studentId) || { id: l.studentId, name: l.studentName, schoolId: l.schoolId },
        instrument: l.instrument,
        reason: `Double-booking conflict with ${l.teacherName} on ${l.day} at ${l.start}`
      });
      lessons.splice(idx, 1);
    }
  }

  return { lessons, unscheduled };
}

// ============================================================
// COMPACTION: pack each teacher's daily lessons back-to-back
// Runs AFTER full timetable is assembled (groups + individuals).
// For each teacher/school/day, slides all class-time lessons into
// consecutive slots starting from the earliest, skipping breaks.
// ============================================================
function compactTimetable(result, schools, students, teachers, specialists) {
  var lessons = result.lessons;

  // Build specialist lookup for policy checks
  var specLookupC = {};
  for (var spi0 = 0; spi0 < (specialists || []).length; spi0++) {
    var sp0 = specialists[spi0];
    var spK0 = sp0.schoolId + '|' + sp0.className + '|' + sp0.day;
    if (!specLookupC[spK0]) specLookupC[spK0] = [];
    specLookupC[spK0].push({ start: timeToMin(sp0.start), end: timeToMin(sp0.end), subject: sp0.subject });
  }
  var isDuringSpecialistC = function(schoolId, className, day, slotStart, slotEnd) {
    var specs = specLookupC[schoolId + '|' + className + '|' + day];
    if (!specs) return false;
    var mid = (timeToMin(slotStart) + timeToMin(slotEnd)) / 2;
    return specs.some(function(sp) { return mid >= sp.start && mid < sp.end; });
  };

  var teacherBreaksLookup = {};
  for (var ti = 0; ti < teachers.length; ti++) {
    var teacher = teachers[ti];
    teacherBreaksLookup[teacher.id] = {};
    for (var bi = 0; bi < (teacher.teacherBreaks || []).length; bi++) {
      var tb = teacher.teacherBreaks[bi];
      if (!teacherBreaksLookup[teacher.id][tb.schoolId]) teacherBreaksLookup[teacher.id][tb.schoolId] = [];
      teacherBreaksLookup[teacher.id][tb.schoolId].push({ start: timeToMin(tb.start), end: timeToMin(tb.end), day: tb.day || 'All' });
    }
  }
  var schoolBreaksLookup = {};
  for (var si2 = 0; si2 < schools.length; si2++) {
    schoolBreaksLookup[schools[si2].id] = (schools[si2].teacherBreaks || []).map(function(b) {
      return { start: timeToMin(b.start), end: timeToMin(b.end), day: b.day || 'All' };
    });
  }
  var isTeacherOnBreak = function(tId, sId, day, ss, se) {
    var sMid = (timeToMin(ss) + timeToMin(se)) / 2;
    var sb = schoolBreaksLookup[sId];
    if (sb && sb.length > 0) return sb.some(function(b) { return (b.day === 'All' || b.day === day) && sMid >= b.start && sMid < b.end; });
    var tbs = (teacherBreaksLookup[tId] && teacherBreaksLookup[tId][sId]) ? teacherBreaksLookup[tId][sId] : [];
    return tbs.some(function(b) { return (b.day === 'All' || b.day === day) && sMid >= b.start && sMid < b.end; });
  };

  var mustBeInBreakSlot = function(lesson) {
    if (lesson.isGroup) return false;
    var student = students.find(function(s) { return s.id === lesson.studentId; });
    if (!student) return false;
    if (student.outsideClassOnly) return true;
    var studentInsts = student.instruments || [];
    var hasGroup = studentInsts.some(function(i) { return i.isGroup; });
    var isMulti = studentInsts.filter(function(i) { return !i.isGroup; }).length > 1 || hasGroup;
    if (isMulti) {
      var otherClassLesson = lessons.find(function(l) {
        if (l.id === lesson.id) return false;
        if (l.studentId !== lesson.studentId && !(l.isGroup && l.studentIds && l.studentIds.indexOf(lesson.studentId) >= 0)) return false;
        var otherSchool = schools.find(function(s2) { return s2.id === l.schoolId; });
        if (!otherSchool) return false;
        var otherSlot = otherSchool.slots.find(function(s3) { return s3.id === l.slotId; });
        return otherSlot && otherSlot.type === 'class';
      });
      if (otherClassLesson) return true;
    }
    return false;
  };

  var combos = {};
  for (var li = 0; li < lessons.length; li++) {
    var lesson = lessons[li];
    var key = lesson.teacherId + '|' + lesson.schoolId + '|' + lesson.day;
    if (!combos[key]) combos[key] = [];
    combos[key].push(lesson);
  }

  var totalMoved = 0;
  var comboKeys = Object.keys(combos);
  for (var ci = 0; ci < comboKeys.length; ci++) {
    var comboLessons = combos[comboKeys[ci]];
    if (comboLessons.length < 2) continue;

    var teacherId = comboLessons[0].teacherId;
    var schoolId = comboLessons[0].schoolId;
    var day = comboLessons[0].day;
    var teacherName = comboLessons[0].teacherName;
    var schoolName = comboLessons[0].schoolName;
    var sch = schools.find(function(s) { return s.id === schoolId; });
    if (!sch) continue;

    // All non-before/after slots sorted by time
    var allSlots = sch.slots
      .filter(function(s) { return ['before_school', 'after_school'].indexOf(s.type) < 0; })
      .sort(function(a, b) { return timeToMin(a.start) - timeToMin(b.start); });
    if (allSlots.length === 0) continue;

    comboLessons.sort(function(a, b) { return timeToMin(a.start) - timeToMin(b.start); });

    var movable = [];
    var breakOnly = [];
    var pinned = [];
    for (var mi = 0; mi < comboLessons.length; mi++) {
      if (comboLessons[mi]._pinned) {
        pinned.push(comboLessons[mi]); // placed by required time — never move
      } else if (mustBeInBreakSlot(comboLessons[mi])) {
        breakOnly.push(comboLessons[mi]);
      } else {
        movable.push(comboLessons[mi]);
      }
    }

    var currentTimes = comboLessons.map(function(l) {
      var tag = breakOnly.indexOf(l) >= 0 ? ' [break-only]' : '';
      return l.start + ' (' + (l.studentName || l.groupName) + tag + ')';
    }).join(', ');
  
    if (movable.length < 1) continue;

    // Valid class/recess/lunch slots where teacher is not on break
    // AND teacher doesn't have a lesson at another school at this time
    var otherSchoolLessons = lessons.filter(function(l) {
      return l.teacherId === teacherId && l.day === day && l.schoolId !== schoolId;
    });
    var isTeacherBusyElsewhere = function(slotStart, slotEnd) {
      var sS = timeToMin(slotStart), sE = timeToMin(slotEnd);
      return otherSchoolLessons.some(function(l) {
        return timeToMin(l.start) < sE && sS < timeToMin(l.end);
      });
    };
    // Teacher availability window for this school/day
    var teacher = teachers.find(function(t) { return t.id === teacherId; });
    var dayAvail = teacher ? teacher.availability.find(function(a) { return a.schoolId === schoolId && a.day === day; }) : null;
    var availStart = dayAvail ? timeToMin(dayAvail.start) : 0;
    var availEnd = dayAvail ? timeToMin(dayAvail.end) : 1440;
    var isOutsideAvailability = function(slotStart, slotEnd) {
      return timeToMin(slotStart) < availStart || timeToMin(slotEnd) > availEnd;
    };
    // Slots occupied by pinned lessons — can't move anything here
    var pinnedSlotTimes = {};
    for (var pi = 0; pi < pinned.length; pi++) {
      pinnedSlotTimes[pinned[pi].start] = true;
    }
    var validClassSlots = allSlots.filter(function(slot) {
      if (pinnedSlotTimes[slot.start]) return false;
      if (isOutsideAvailability(slot.start, slot.end)) return false;
      if (isTeacherOnBreak(teacherId, schoolId, day, slot.start, slot.end)) return false;
      if (isTeacherBusyElsewhere(slot.start, slot.end)) return false;
      return slot.type === 'class';
    });
    var validBreakSlots = allSlots.filter(function(slot) {
      if (pinnedSlotTimes[slot.start]) return false;
      if (isOutsideAvailability(slot.start, slot.end)) return false;
      if (isTeacherOnBreak(teacherId, schoolId, day, slot.start, slot.end)) return false;
      if (isTeacherBusyElsewhere(slot.start, slot.end)) return false;
      return ['recess', 'lunch'].indexOf(slot.type) >= 0;
    });


    // PHASE 1: Pack movable lessons into consecutive class slots, prefer earliest start
    var bestMovStart = -1;

    if (movable.length >= 2) {
      for (var tryStart = 0; tryStart <= validClassSlots.length - movable.length; tryStart++) {
        var allFit = true;
        for (var fi = 0; fi < movable.length; fi++) {
          var student = students.find(function(s) { return s.id === movable[fi].studentId; });
          if (student && student.outsideClassOnly) { allFit = false; break; }
          // Check specialist policy
          if (student && sch.specialistPolicy === 'no') {
            if (isDuringSpecialistC(schoolId, student.className || '', day, validClassSlots[tryStart + fi].start, validClassSlots[tryStart + fi].end)) {
              allFit = false; break;
            }
          }
        }
        if (allFit) {
          bestMovStart = tryStart;
          break; // earliest valid start wins
        }
      }
    } else if (movable.length === 1) {
      bestMovStart = 0; // single movable, just keep it
    }

    if (bestMovStart >= 0 && movable.length >= 2) {
      var movSlots = [];
      for (var msi = bestMovStart; msi < bestMovStart + movable.length; msi++) movSlots.push(validClassSlots[msi].start);

      for (var ai = 0; ai < movable.length; ai++) {
        var slot = validClassSlots[bestMovStart + ai];
        var oldStart = movable[ai].start;
        movable[ai].slotId = slot.id;
        movable[ai].slotName = slot.name;
        movable[ai].start = slot.start;
        movable[ai].end = slot.end;
        if (oldStart !== slot.start) {
          totalMoved++;
        }
      }
    }

    // PHASE 2: Place break-only lessons in nearest break slot to the movable block
    if (breakOnly.length > 0 && movable.length > 0) {
      // Find the time range of the packed movable block
      var blockEnd = timeToMin(movable[movable.length - 1].end);
      var blockStart = timeToMin(movable[0].start);

      // Sort break slots by distance to the end of the movable block (prefer just after)
      var sortedBreakSlots = validBreakSlots.slice().sort(function(a, b) {
        var aStart = timeToMin(a.start);
        var bStart = timeToMin(b.start);
        // Prefer slots just after the block end
        var aDist = aStart >= blockEnd ? (aStart - blockEnd) : (blockStart - timeToMin(a.end)) + 1000;
        var bDist = bStart >= blockEnd ? (bStart - blockEnd) : (blockStart - timeToMin(b.end)) + 1000;
        return aDist - bDist;
      });


      var usedBreakSlots = {};
      for (var boi = 0; boi < breakOnly.length; boi++) {
        var placed = false;
        for (var bsi = 0; bsi < sortedBreakSlots.length; bsi++) {
          var bSlot = sortedBreakSlots[bsi];
          if (usedBreakSlots[bSlot.start]) continue;
          usedBreakSlots[bSlot.start] = true;
          var oldStart2 = breakOnly[boi].start;
          breakOnly[boi].slotId = bSlot.id;
          breakOnly[boi].slotName = bSlot.name;
          breakOnly[boi].start = bSlot.start;
          breakOnly[boi].end = bSlot.end;
          if (oldStart2 !== bSlot.start) {
            totalMoved++;
          }
          placed = true;
          break;
        }
      }
    }
  }

  // ============================================================
  // CROSS-DAY BALANCING: even out lesson counts across days
  // For each teacher/school, move lessons from overloaded days
  // to lighter days to create balanced, compact schedules
  // ============================================================
  var teacherSchoolCombos = {};
  for (var tsi = 0; tsi < lessons.length; tsi++) {
    var tsLesson = lessons[tsi];
    var tsKey = tsLesson.teacherId + '|' + tsLesson.schoolId;
    if (!teacherSchoolCombos[tsKey]) teacherSchoolCombos[tsKey] = { teacherId: tsLesson.teacherId, schoolId: tsLesson.schoolId, lessons: [] };
    teacherSchoolCombos[tsKey].lessons.push(tsLesson);
  }

  var tsComboKeys = Object.keys(teacherSchoolCombos);
  for (var tsci = 0; tsci < tsComboKeys.length; tsci++) {
    var tsCombo = teacherSchoolCombos[tsComboKeys[tsci]];
    var tId = tsCombo.teacherId;
    var sId = tsCombo.schoolId;
    var tsch = schools.find(function(s) { return s.id === sId; });
    if (!tsch) continue;

    var tTeacher = teachers.find(function(t) { return t.id === tId; });
    if (!tTeacher) continue;

    // Group lessons by day
    var byDay = {};
    for (var tli = 0; tli < tsCombo.lessons.length; tli++) {
      var tl = tsCombo.lessons[tli];
      if (!byDay[tl.day]) byDay[tl.day] = [];
      byDay[tl.day].push(tl);
    }

    var dayKeys = Object.keys(byDay);
    if (dayKeys.length < 2) continue;

    // Keep balancing until no more moves improve things
    var balanceChanged = true;
    var balanceIterations = 0;
    while (balanceChanged && balanceIterations < 50) {
      balanceChanged = false;
      balanceIterations++;

      // Recalculate counts and find heaviest/lightest
      var dayCounts = {};
      for (var dki = 0; dki < dayKeys.length; dki++) {
        dayCounts[dayKeys[dki]] = (byDay[dayKeys[dki]] || []).length;
      }

      // Sort: heaviest first
      var sortedDays = dayKeys.slice().sort(function(a, b) { return dayCounts[b] - dayCounts[a]; });
      var heaviestDay = sortedDays[0];
      var lightestDay = sortedDays[sortedDays.length - 1];
      var diff = dayCounts[heaviestDay] - dayCounts[lightestDay];

      // Only balance if difference is 2+ (moving 1 would make it >=1 closer)
      if (diff < 2) continue;

      // Try to move a lesson from heaviest to lightest
      var heavyLessons = byDay[heaviestDay] || [];
      var moved = false;

      // Get available slots on lightest day
      var lightAvail = tTeacher.availability.find(function(a) { return a.schoolId === sId && a.day === lightestDay; });
      if (!lightAvail) continue;
      var lightAvailStart = timeToMin(lightAvail.start);
      var lightAvailEnd = timeToMin(lightAvail.end);

      // Get occupied slot times on lightest day for this teacher
      var occupiedOnLight = {};
      for (var oli = 0; oli < lessons.length; oli++) {
        if (lessons[oli].teacherId === tId && lessons[oli].day === lightestDay && lessons[oli].schoolId === sId) {
          occupiedOnLight[lessons[oli].start] = true;
        }
      }

      // Try each lesson on the heavy day (skip pinned, groups)
      for (var hli = heavyLessons.length - 1; hli >= 0; hli--) {
        if (moved) break;
        var hLesson = heavyLessons[hli];
        if (hLesson._pinned) continue;
        if (hLesson.isGroup) continue;

        var hStu = students.find(function(s) { return s.id === hLesson.studentId; });
        if (!hStu) continue;

        // Check student constraints for target day
        var hHints = hStu._noteHints || {};
        if (hHints.avoidDays && hHints.avoidDays.indexOf(lightestDay) >= 0) continue;

        // Multi-instrument: student can't have two lessons on same day
        var stuHasLessonOnLight = lessons.some(function(l) {
          return l.id !== hLesson.id && l.day === lightestDay && (
            l.studentId === hLesson.studentId ||
            (l.isGroup && l.studentIds && l.studentIds.indexOf(hLesson.studentId) >= 0)
          );
        });
        if (stuHasLessonOnLight) continue;

        if (hStu.outsideClassOnly) continue;

        // Find a free class slot on the lightest day
        var lightSlots = tsch.slots.filter(function(s) { return s.type === 'class'; }).sort(function(a, b) { return timeToMin(a.start) - timeToMin(b.start); });

        for (var lsi = 0; lsi < lightSlots.length; lsi++) {
          if (moved) break;
          var lSlot = lightSlots[lsi];
          var lsStart = timeToMin(lSlot.start);
          var lsEnd = timeToMin(lSlot.end);

          if (lsStart < lightAvailStart || lsEnd > lightAvailEnd) continue;
          if (occupiedOnLight[lSlot.start]) continue;
          if (isTeacherOnBreak(tId, sId, lightestDay, lSlot.start, lSlot.end)) continue;

          // Cross-school conflict
          var crossSchool = lessons.some(function(l) {
            return l.teacherId === tId && l.day === lightestDay && l.schoolId !== sId &&
              timeToMin(l.start) < lsEnd && lsStart < timeToMin(l.end);
          });
          if (crossSchool) continue;

          // Specialist policy
          if (tsch.specialistPolicy === 'no' && hStu.className) {
            if (isDuringSpecialistC(sId, hStu.className, lightestDay, lSlot.start, lSlot.end)) continue;
          }

          // Move the lesson
          hLesson.day = lightestDay;
          hLesson.slotId = lSlot.id;
          hLesson.slotName = lSlot.name;
          hLesson.start = lSlot.start;
          hLesson.end = lSlot.end;
          totalMoved++;
          moved = true;
          balanceChanged = true;

          // Update tracking
          heavyLessons.splice(hli, 1);
          if (!byDay[lightestDay]) byDay[lightestDay] = [];
          byDay[lightestDay].push(hLesson);
          occupiedOnLight[lSlot.start] = true;
        }
      }
    }
  }


  // Recalculate duringSpecialist for all lessons after compaction may have moved them
  var specLookup2 = {};
  for (var spi = 0; spi < (specialists || []).length; spi++) {
    var sp = specialists[spi];
    var spKey = sp.schoolId + '|' + sp.className + '|' + sp.day;
    if (!specLookup2[spKey]) specLookup2[spKey] = [];
    specLookup2[spKey].push({ start: timeToMin(sp.start), end: timeToMin(sp.end), subject: sp.subject });
  }
  for (var rli = 0; rli < lessons.length; rli++) {
    var rl = lessons[rli];
    var stu = students.find(function(s) { return s.id === rl.studentId; });
    var cn = stu ? (stu.className || '') : '';
    var rlSlot = schools.find(function(s) { return s.id === rl.schoolId; })?.slots?.find(function(s) { return s.id === rl.slotId; });
    if (rlSlot && rlSlot.type !== 'class') { rl.duringSpecialist = false; continue; }
    var rlS = timeToMin(rl.start), rlE = timeToMin(rl.end);
    if (rl.isGroup && rl.studentIds) {
      // Check all member classes for specialist overlap
      var groupSubjects = [];
      for (var gmi = 0; gmi < rl.studentIds.length; gmi++) {
        var gmStu = students.find(function(s) { return s.id === rl.studentIds[gmi]; });
        var gmCn = gmStu ? (gmStu.className || '') : '';
        if (!gmCn) continue;
        var gmKey = rl.schoolId + '|' + gmCn + '|' + rl.day;
        var gmSpecs = specLookup2[gmKey];
        if (!gmSpecs) continue;
        for (var gmSpi = 0; gmSpi < gmSpecs.length; gmSpi++) {
          if (rlS < gmSpecs[gmSpi].end && rlE > gmSpecs[gmSpi].start) {
            var subj = gmSpecs[gmSpi].subject;
            if (subj && groupSubjects.indexOf(subj) === -1) groupSubjects.push(subj);
            break;
          }
        }
      }
      rl.duringSpecialist = groupSubjects.length > 0 ? groupSubjects.join(', ') : false;
      continue;
    }
    if (!cn) { rl.duringSpecialist = false; continue; }
    var spKey2 = rl.schoolId + '|' + cn + '|' + rl.day;
    var specs2 = specLookup2[spKey2];
    if (!specs2) { rl.duringSpecialist = false; continue; }
    var found = false;
    for (var spi2 = 0; spi2 < specs2.length; spi2++) {
      if (rlS < specs2[spi2].end && rlE > specs2[spi2].start) { rl.duringSpecialist = specs2[spi2].subject; found = true; break; }
    }
    if (!found) rl.duringSpecialist = false;
  }

  return result;
}

function getSpecialistSubject(specLookup, schoolId, className, day, slotStart, slotEnd, allowedSubjects) {
  const key = `${schoolId}|${className}|${day}`;
  const specs = specLookup[key];
  if (!specs) return false;
  const sStart = timeToMin(slotStart);
  const sEnd = timeToMin(slotEnd);
  return specs.some(sp => {
    const spStart = timeToMin(sp.start);
    const spEnd = timeToMin(sp.end);
    if (sStart < spEnd && sEnd > spStart) {
      return allowedSubjects.some(subj => sp.subject.toLowerCase().includes(subj.toLowerCase()) || subj.toLowerCase().includes(sp.subject.toLowerCase()));
    }
    return false;
  });
}

function isSlotAllowed(slot, student, school, mustBeOutsideClass, slotIsSpecialist, day, hints) {
  const isBreakType = ["recess", "lunch"].includes(slot.type);
  const isBeforeAfter = ["before_school", "after_school"].includes(slot.type);

  // Before/after school slots require the student to have opted in
  // UNLESS their notes specify a required time at this slot
  const hasRequiredHere = hints && (hints.requiredTimes || []).some(function(rt) { return rt.day === day && rt.start === slot.start; });
  if (slot.type === "before_school" && !student.availableBefore && !hasRequiredHere) return false;
  if (slot.type === "after_school" && !student.availableAfter && !hasRequiredHere) return false;

  // If student must be outside class time only
  if (student.outsideClassOnly) {
    if (!isBreakType && !isBeforeAfter) return false;
  }

  // Check avoid times from notes (hard constraint — skip these slots)
  if (hints && hints.avoidTimes && hints.avoidTimes.length > 0) {
    const slotStart = timeToMin(slot.start);
    const slotEnd = timeToMin(slot.end);
    for (const at of hints.avoidTimes) {
      if (at.day === day) {
        const avStart = timeToMin(at.start);
        const avEnd = timeToMin(at.end);
        if (slotStart < avEnd && slotEnd > avStart) return false;
      }
    }
  }

  // Check avoid days from notes (hard constraint)
  if (hints && hints.avoidDays && hints.avoidDays.includes(day)) return false;

  // Multi-instrument constraint: this instrument must be outside class time
  // (because the other instrument already took a class period)
  // UNLESS requiredTimes explicitly specify this slot
  if (mustBeOutsideClass && !hasRequiredHere) {
    if (!slotIsSpecialist && !isBreakType && !isBeforeAfter) return false;
  }

  // Specialist class scheduling rules (for primary instrument in class time)
  if (!mustBeOutsideClass && slotIsSpecialist && slot.type === "class") {
    if (school.specialistPolicy === "no") return false;
  }

  return true;
}

// Schedule ready groups into available slots, respecting existing lessons
function scheduleReadyGroups(readyGroupsOrAll, existingLessons, schools, students, teachers, specialists) {
  const readyGroups = readyGroupsOrAll.filter(g => g.status === "ready");
  const scheduled = [];
  const failed = [];

  // Build teacher slot usage from existing lessons
  const teacherUsed = {};
  for (const l of existingLessons) {
    if (!teacherUsed[l.teacherId]) teacherUsed[l.teacherId] = new Set();
    teacherUsed[l.teacherId].add(`${l.day}|${l.start}`);
  }

  for (const group of readyGroups) {
    const school = schools.find(s => s.id === group.schoolId);
    const teacher = teachers.find(t => t.id === group.teacherId);
    if (!school || !teacher) {
      failed.push({ student: { id: group.id, name: group.name, schoolId: group.schoolId }, instrument: group.instrument || "Group", reason: !school ? "School not found" : "Teacher not found", isGroup: true });
      continue;
    }

    const teacherAvail = teacher.availability.filter(a => a.schoolId === school.id);
    if (teacherAvail.length === 0) {
      failed.push({ student: { id: group.id, name: group.name, schoolId: group.schoolId }, instrument: group.instrument || "Group", reason: `${teacher.name} not available at ${school.name}`, isGroup: true });
      continue;
    }

    if (!teacherUsed[teacher.id]) teacherUsed[teacher.id] = new Set();
    let booked = false;

    // Build list of teacher's existing lesson times for adjacency scoring
    const teacherExistingTimes = existingLessons
      .filter(l => l.teacherId === teacher.id && l.schoolId === school.id)
      .map(l => ({ day: l.day, start: timeToMin(l.start), end: timeToMin(l.end) }));

    // Prefer days where teacher already has lessons (packing)
    const sortedDays = [...school.days].sort((a, b) => {
      const aCount = teacherExistingTimes.filter(t => t.day === a).length;
      const bCount = teacherExistingTimes.filter(t => t.day === b).length;
      return bCount - aCount;
    });

    for (const day of sortedDays) {
      if (booked) break;
      const dayAvail = teacherAvail.find(a => a.day === day);
      if (!dayAvail) continue;
      const availStart = timeToMin(dayAvail.start);
      const availEnd = timeToMin(dayAvail.end);

      // Sort slots by adjacency to existing teacher lessons (back-to-back preferred)
      const sortedSlots = [...school.slots].filter(s => s.type === "class").sort((a, b) => {
        const aMin = timeToMin(a.start);
        const bMin = timeToMin(b.start);
        const dayTimes = teacherExistingTimes.filter(t => t.day === day);
        if (dayTimes.length === 0) return aMin - bMin; // no existing lessons: earliest first
        const aGap = Math.min(...dayTimes.map(t => Math.min(Math.abs(aMin - t.end), Math.abs(t.start - timeToMin(a.end)))));
        const bGap = Math.min(...dayTimes.map(t => Math.min(Math.abs(bMin - t.end), Math.abs(t.start - timeToMin(b.end)))));
        return aGap - bGap;
      });

      for (const slot of sortedSlots) {
        if (booked) break;
        if (slot.type !== "class") continue;
        const slotStart = timeToMin(slot.start);
        const slotEnd = timeToMin(slot.end);
        if (slotStart < availStart || slotEnd > availEnd) continue;
        if (teacherUsed[teacher.id].has(`${day}|${slot.start}`)) continue;

        // Check school-level breaks
        const schoolBreaks = (school.teacherBreaks || []).map(b => ({ start: timeToMin(b.start), end: timeToMin(b.end), day: b.day || "All" }));
        const sMid = (slotStart + slotEnd) / 2;
        if (schoolBreaks.some(b => (b.day === "All" || b.day === day) && sMid >= b.start && sMid < b.end)) continue;

        // Check teacher-level breaks
        const tBreaks = (teacher.teacherBreaks || []).filter(b => b.schoolId === school.id);
        if (tBreaks.some(b => {
          const bDay = b.day || "All";
          if (bDay !== "All" && bDay !== day) return false;
          return sMid >= timeToMin(b.start) && sMid < timeToMin(b.end);
        })) continue;

        // Check specialist policy — skip specialist slots if policy is "no"
        if (school.specialistPolicy === "no") {
          const memberClasses = group.studentIds.map(sid => {
            const st = students.find(s => s.id === sid);
            return st?.className || "";
          }).filter(Boolean);
          let isSpec = false;
          for (const cn of memberClasses) {
            const specKey = `${school.id}|${cn}|${day}`;
            // Quick inline specialist check
            const specEntries = specialists || [];
            for (const sp of specEntries) {
              if (sp.schoolId === school.id && sp.className === cn && sp.day === day) {
                const spS = timeToMin(sp.start), spE = timeToMin(sp.end);
                if (sMid >= spS && sMid < spE) { isSpec = true; break; }
              }
            }
            if (isSpec) break;
          }
          if (isSpec) continue;
        }

        const lesson = {
          id: uid(),
          isGroup: true, groupId: group.id, groupName: group.name,
          studentId: group.studentIds[0],
          studentName: group.name,
          studentIds: [...group.studentIds],
          studentNames: group.studentIds.map(sid => students.find(s => s.id === sid)?.name || "?"),
          teacherId: teacher.id, teacherName: teacher.name,
          schoolId: school.id, schoolName: school.name,
          day, slotId: slot.id, slotName: slot.name,
          start: slot.start, end: slot.end,
          instrument: group.instrument || "Group",
          
          duringSpecialist: false
        };
        scheduled.push(lesson);
        teacherUsed[teacher.id].add(`${day}|${slot.start}`);
        booked = true;
      }
    }

    if (!booked) {
      failed.push({ student: { id: group.id, name: group.name, schoolId: group.schoolId }, instrument: group.instrument || "Group", reason: "No available slot for assigned teacher", isGroup: true });
    }
  }

  return { scheduled, failed };
}

// ============================================================
// CSV IMPORT HELPERS
// ============================================================
function parseStudentCSV(csvData, schools, teachers = []) {
  // Helper: match school by name or abbreviation/initials
  const matchSchool = (raw) => {
    if (!raw) return null;
    const r = raw.trim().toLowerCase();
    let match = schools.find(s => s.name.toLowerCase() === r);
    if (match) return match;
    const rUpper = raw.trim().toUpperCase();
    match = schools.find(s => {
      const initials = s.name.split(/\s+/).map(w => w[0]).join("").toUpperCase();
      return initials === rUpper;
    });
    if (match) return match;
    match = schools.find(s => s.name.toLowerCase().includes(r) || r.includes(s.name.toLowerCase()));
    return match || null;
  };

  
  // Helper: match teacher by full name, first name, last name, or initials
  const matchTeacher = (raw) => {
    if (!raw) return null;
    const r = raw.trim();
    const rLower = r.toLowerCase();
    let match = teachers.find(t => t.name.toLowerCase() === rLower);
    if (match) return match;
    match = teachers.find(t => t.name.split(/\s+/)[0].toLowerCase() === rLower);
    if (match) return match;
    match = teachers.find(t => {
      const parts = t.name.split(/\s+/);
      return parts.length > 1 && parts[parts.length - 1].toLowerCase() === rLower;
    });
    if (match) return match;
    const rClean = r.replace(/[.\s]/g, "").toUpperCase();
    if (rClean.length >= 2 && rClean.length <= 4) {
      match = teachers.find(t => {
        const initials = t.name.split(/\s+/).map(w => w[0]).join("").toUpperCase();
        return initials === rClean;
      });
      if (match) return match;
    }
    match = teachers.find(t => t.name.toLowerCase().includes(rLower) || rLower.includes(t.name.toLowerCase()));
    if (match) return match;
    return null;
  };

  const results = [];
  for (const row of csvData) {
    if (!row.name && !row.Name) continue;
    const name = row.name || row.Name || "";
    const schoolName = row.school || row.School || "";
    const className = row.class || row.Class || row.className || "";
    const instrument = row.instrument || row.Instrument || "";
    const instrument2 = row.instrument2 || row.Instrument2 || "";
    const teacherName = row.teacher || row.Teacher || "";

    const school = matchSchool(schoolName);
    const matchedTeacher = matchTeacher(teacherName);

    // Use explicit level from file if provided, otherwise auto-assign from grade
    
    const isGroupAll = (row.isGroup || row.is_group || row.group || row.Group || "").toLowerCase() === "yes";
    const isGroup1 = (row.group1 || row.Group1 || "").toLowerCase() === "yes" || isGroupAll;
    const isGroup2 = (row.group2 || row.Group2 || "").toLowerCase() === "yes" || isGroupAll;

    const instruments = [{ name: instrument, isGroup: isGroup1 }];
    if (instrument2) instruments.push({ name: instrument2, isGroup: isGroup2 });

    results.push({
      id: uid(),
      name: name.trim(),
      schoolId: school ? school.id : "",
      schoolName: schoolName.trim(),
      className: className.trim(),
      instruments: instruments.map((inst, i) => i === 0 && matchedTeacher ? { ...inst, teacherId: matchedTeacher.id } : { ...inst, teacherId: "" }),
      outsideClassOnly: (row.outsideClassOnly || row.outside_class_only || row.breakTimeOnly || row.break_time_only || "").toLowerCase() === "yes",
      outsideClassPreferred: (row.outsideClassPreferred || row.outside_class_preferred || "").toLowerCase() === "yes",
      availableBefore: (row.availableBefore || row.available_before || row.availableBeforeAfter || row.available_before_after || row.beforeAfterOnly || row.before_after_only || "").toLowerCase() === "yes",
      availableAfter: (row.availableAfter || row.available_after || row.availableBeforeAfter || row.available_before_after || row.beforeAfterOnly || row.before_after_only || "").toLowerCase() === "yes",
      avoidTimes: [],
      preferredTimes: [],
      status: "active",
      notes: row.notes || row.Notes || ""
    });
  }

  // Consolidate: merge entries with same name + school into one student with multiple instruments
  const byKey = {};
  for (const e of results) {
    const key = `${e.name.toLowerCase()}|${e.schoolId}`;
    if (byKey[key]) {
      for (const inst of e.instruments) {
        if (!byKey[key].instruments.some(i => i.name === inst.name)) {
          byKey[key].instruments.push(inst);
        }
      }
      // teacherId is per-instrument; no separate top-level merge needed
      if (e.notes && !byKey[key].notes.includes(e.notes)) byKey[key].notes = [byKey[key].notes, e.notes].filter(Boolean).join("; ");
    } else {
      byKey[key] = { ...e };
    }
  }
  return Object.values(byKey);
}

function parseTeacherCSV(csvData, schools) {
  const results = [];
  for (const row of csvData) {
    if (!row.name && !row.Name) continue;
    const name = row.name || row.Name || "";
    const instrumentsRaw = row.instruments || row.Instruments || "";
        const schoolsRaw = row.schools || row.Schools || "";
    const daysRaw = row.days || row.Days || "Monday,Tuesday,Wednesday,Thursday,Friday";
    const startTime = row.start_time || row.startTime || "09:00";
    const endTime = row.end_time || row.endTime || "15:30";

    const instNames = instrumentsRaw.split(",").map(s => s.trim()).filter(Boolean);
        const schoolNames = schoolsRaw.split(",").map(s => s.trim()).filter(Boolean);
    const days = daysRaw.split(",").map(s => s.trim()).filter(Boolean);

    const instruments = instNames.map(name => ({ name }));

    const teacherSchools = schoolNames.map(sn => {
      const school = schools.find(s => s.name.toLowerCase() === sn.toLowerCase());
      return school ? school.id : null;
    }).filter(Boolean);

    // Build availability: each school × each day
    const availability = [];
    for (const schoolId of teacherSchools) {
      for (const day of days) {
        availability.push({ schoolId, day, start: startTime, end: endTime });
      }
    }

    results.push({
      id: uid(),
      name: name.trim(),
      instruments,
      schools: teacherSchools,
      availability,
      notes: row.notes || row.Notes || ""
    });
  }
  return results;
}

const instruments_colors = {
  Piano: "#ffb3ff", Guitar: "#8cc183", Violin: "#C47A6A", Viola: "#B07CD4",
  Cello: "#D45B5B", Flute: "#5BBDD4", Clarinet: "#D4C65B", Saxophone: "#D48B5B",
  Trumpet: "#C4A05B", Drums: "#ae85ad", Voice: "#6B9FD4", Ukulele: "#ebc382",
  Group: "#9E6B8A", default: "#888"
};

const getInstColor = (inst, isGroup) => isGroup ? instruments_colors.Group : (instruments_colors[inst] || instruments_colors.default);

// ============================================================
// EXPORT SYSTEM
// ============================================================
function getInitials(name) {
  return (name || "").split(" ").map(function(w) { return w[0] || ""; }).join("").toUpperCase();
}

function getBreaksForSchool(school, teachers, lessons) {
  var breaks = [];
  // School-level slot breaks (recess, lunch)
  if (school && school.slots) {
    for (var si = 0; si < school.slots.length; si++) {
      var slot = school.slots[si];
      if (slot.type === "recess" || slot.type === "lunch") {
        breaks.push({ start: slot.start, end: slot.end, day: "All", label: slot.name || (slot.type === "recess" ? "Recess" : "Lunch") });
      }
    }
  }
  // School-level teacher breaks
  var tb = (school ? school.teacherBreaks || [] : []);
  for (var i = 0; i < tb.length; i++) {
    var b = tb[i];
    var dup = breaks.some(function(x) { return x.start === b.start && x.end === b.end; });
    if (!dup) breaks.push({ start: b.start, end: b.end, day: b.day || "All", label: "Break" });
  }
  // Teacher-level breaks if no school breaks found
  if (breaks.length === 0) {
    var tids = [...new Set(lessons.filter(function(l) { return l.schoolId === school.id; }).map(function(l) { return l.teacherId; }))];
    var seen = {};
    for (var i2 = 0; i2 < tids.length; i2++) {
      var t = teachers.find(function(t2) { return t2.id === tids[i2]; });
      if (!t) continue;
      for (var j = 0; j < (t.teacherBreaks || []).length; j++) {
        var b2 = t.teacherBreaks[j];
        if (b2.schoolId !== school.id) continue;
        var key = (b2.day || "All") + "-" + b2.start + "-" + b2.end;
        if (!seen[key]) { seen[key] = true; breaks.push({ start: b2.start, end: b2.end, day: b2.day || "All", label: "Break" }); }
      }
    }
  }
  return breaks;
}

function buildGridRows(lessons, students, school, teachers, opts) {
  var allDays = opts && opts.allDays === false ? false : true;
  var days = allDays ? DAYS : DAYS.filter(function(d) { return lessons.some(function(l) { return l.day === d; }); });
  var breaks = school ? getBreaksForSchool(school, teachers || [], lessons) : [];
  var lessonTimes = [...new Set(lessons.map(function(l) { return l.start; }))];
  var breakTimes = breaks.map(function(b) { return b.start; });
  var slotTimes = school ? (school.slots || []).map(function(s) { return s.start; }) : [];
  var slotLookup = {};
  if (school && school.slots) {
    for (var si = 0; si < school.slots.length; si++) {
      slotLookup[school.slots[si].start] = school.slots[si];
    }
  }
  var allTimes = [...new Set(lessonTimes.concat(breakTimes).concat(slotTimes))].sort(function(a, b) { return timeToMin(a) - timeToMin(b); });

  var ic = instruments_colors;
  var result = allTimes.map(function(time) {
    var isBreak = breaks.some(function(b) { return b.start === time; });
    var breakInfo = isBreak ? breaks.find(function(b) { return b.start === time; }) : null;
    var slot = slotLookup[time];
    var _th = parseInt(time.split(":")[0], 10);
    var _tm = time.split(":")[1];
    var timeLabel = (_th === 0 ? 12 : _th > 12 ? _th - 12 : _th) + ":" + _tm;
    if (breakInfo) timeLabel = timeLabel;
    var row = { time: timeLabel, isBreak: isBreak, breakLabel: breakInfo ? breakInfo.label : "" };
    row.cells = {};
    for (var di = 0; di < days.length; di++) {
      var day = days[di];
      var dayBreak = breaks.find(function(b) { return b.start === time && (b.day === "All" || b.day === day); });
      var cell = lessons.filter(function(l) { return l.day === day && l.start === time; });
      row.cells[day] = cell.map(function(l) {
        var st = students ? students.find(function(s) { return s.id === l.studentId; }) : null;
        var name = l.isGroup && l.studentNames ? l.studentNames.join(", ") : l.studentName;
        var cls = st ? st.className || "" : "";
        var ti = getInitials(l.teacherName);
        var color = ic[l.instrument] || ic.default;
        return { name: name, cls: cls, ti: ti, instrument: l.instrument, color: color, adjusted: l.adjusted, adjustReason: l.adjustReason };
      });
      row.cells[day].isBreak = !!dayBreak;
      row.cells[day].breakLabel = dayBreak ? dayBreak.label : "";
    }
    return row;
  });
  result.days = days;
  return result;
}

function prepareLessonRows(lessons, students) {
  var DAY_ORDER = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4 };
  return [...lessons].sort(function(a, b) { return (DAY_ORDER[a.day] || 5) - (DAY_ORDER[b.day] || 5) || timeToMin(a.start) - timeToMin(b.start); }).map(function(l) {
    var st = students ? students.find(function(s) { return s.id === l.studentId; }) : null;
    var row = { Day: l.day, Time: l.start + "-" + l.end, Student: l.isGroup && l.studentNames ? l.studentNames.join(", ") : l.studentName, Class: st ? st.className || "" : "", Teacher: l.teacherName, School: l.schoolName, Instrument: l.instrument, Slot: l.slotName || "" };
    if (l.adjusted) row.Adjusted = l.adjustReason || "Yes";
    return row;
  });
}

function groupLessonsBySchool(lessons, schools) {
  var groups = [];
  var schoolIds = [...new Set(lessons.map(function(l) { return l.schoolId; }))];
  for (var i = 0; i < schoolIds.length; i++) {
    var school = schools.find(function(s) { return s.id === schoolIds[i]; });
    if (!school) continue;
    groups.push({ school: school, lessons: lessons.filter(function(l) { return l.schoolId === schoolIds[i]; }) });
  }
  return groups;
}

function buildStyledTable(gridRows, tableTitle) {
  var days = gridRows.days || DAYS;
  var ic = instruments_colors;
  function cellHtml(cellData) {
    if (cellData.isBreak && cellData.length === 0) {
      return '<td style="background:#FFF3F0;border:1px solid #E8E5E0;min-height:38px"></td>';
    }
    if (cellData.length === 0) return '<td style="background:#FAFAFA;border:1px solid #E8E5E0;min-height:38px"></td>';
    var inner = cellData.map(function(l) {
      var bg = l.color + "22";
      return '<div style="background:' + bg + ';border-left:4px solid ' + l.color + (l.adjusted ? ';border-bottom:2px solid #F59E0B' : '') + ';padding:4px 7px;border-radius:3px;margin:2px 0;font-size:12px;line-height:1.4"><b style="font-size:12.5px">' + l.name + '</b>' + (l.cls ? ' <span style="color:#6b7280;font-size:11px">' + l.cls + '</span>' : '') + ' <span style="color:#9ca3af;font-size:11px;font-style:italic">(' + l.ti + ')</span>' + (l.adjusted ? '<div style="color:#D97706;font-style:italic;font-size:10.5px">\u21BB ' + (l.adjustReason || 'Adjusted') + '</div>' : '') + '</div>';
    }).join('');
    return '<td style="border:1px solid #E8E5E0;vertical-align:top;padding:4px;min-height:38px' + (cellData.isBreak ? ';background:#FFF3F0' : '') + '">' + inner + '</td>';
  }
  var html = '';
  if (tableTitle) html += '<h2 style="font-size:15px;margin:20px 0 6px;color:#1B2432;border-bottom:2px solid #344565;padding-bottom:4px">' + tableTitle + '</h2>';
  html += '<table style="width:100%;border-collapse:collapse;table-layout:fixed"><thead><tr><th style="background:#344565;color:#fff;padding:10px 6px;text-align:center;font-size:12px;width:62px;border:1px solid #2a3654;letter-spacing:0.3px">Time</th>';
  for (var d = 0; d < days.length; d++) html += '<th style="background:#344565;color:#fff;padding:10px 6px;text-align:center;font-size:12px;border:1px solid #2a3654;letter-spacing:0.3px">' + days[d] + '</th>';
  html += '</tr></thead><tbody>';
  for (var r = 0; r < gridRows.length; r++) {
    var row = gridRows[r];
    var rowBg = row.isBreak ? '#FFF3F0' : (r % 2 === 0 ? '#FFFFFF' : '#F8EFED');
    html += '<tr><td style="background:' + (row.isBreak ? '#C47A6A' : rowBg) + ';text-align:center;font-weight:700;font-size:11px;color:' + (row.isBreak ? '#fff' : '#6b7280') + ';border:1px solid #E8E5E0;padding:8px 4px;letter-spacing:0.2px;vertical-align:middle">' + row.time + '</td>';
    for (var d2 = 0; d2 < days.length; d2++) html += cellHtml(row.cells[days[d2]]);
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

async function exportLessons(lessons, students, schools, teachers, opts) {
  var format = opts.format, filenameBase = opts.filenameBase, schoolId = opts.schoolId, teacherName = opts.teacherName, className = opts.className, day = opts.day;
  var filtered = [...lessons];
  if (schoolId) filtered = filtered.filter(function(l) { return l.schoolId === schoolId; });
  if (teacherName) filtered = filtered.filter(function(l) { return l.teacherName === teacherName; });
  if (className) { var sids = new Set(students.filter(function(s) { return s.className === className; }).map(function(s) { return s.id; })); filtered = filtered.filter(function(l) { return sids.has(l.studentId); }); }
  if (day) filtered = filtered.filter(function(l) { return l.day === day; });
  if (filtered.length === 0) throw new Error("No lessons match the selected filters");
  var filename = filenameBase + (day ? "-" + day : "");
  var showSeparate = !schoolId && !teacherName && !className;
  var gridOpts = { allDays: !className };

  if (format === "csv") {
    const Papa = window.Papa;
    if (showSeparate) {
      var groups = groupLessonsBySchool(filtered, schools);
      var parts = [];
      for (var g = 0; g < groups.length; g++) {
        parts.push(groups[g].school.name);
        var rows = buildGridRows(groups[g].lessons, students, groups[g].school, teachers, gridOpts);
        var useDays = rows.days;
        var csvRows = rows.map(function(r) {
          var row = { Time: r.time };
          for (var d = 0; d < useDays.length; d++) {
            var c = r.cells[useDays[d]];
            row[useDays[d]] = c.isBreak && c.length === 0 ? "" : c.map(function(l) { return l.name + (l.cls ? " " + l.cls : "") + " (" + l.ti + ")"; }).join(" / ");
          }
          return row;
        });
        parts.push(window.window.Papa.unparse(csvRows, { columns: ["Time"].concat(useDays) }));
        parts.push("");
      }
      downloadFile(parts.join("\n"), filename + ".csv", "text/csv");
    } else {
      var school = schoolId ? schools.find(function(s) { return s.id === schoolId; }) : (filtered.length > 0 ? schools.find(function(s) { return s.id === filtered[0].schoolId; }) : schools[0]);
      var rows2 = buildGridRows(filtered, students, school, teachers, gridOpts);
      var useDays2 = rows2.days;
      var csvRows2 = rows2.map(function(r) {
        var row = { Time: r.time };
        for (var d = 0; d < useDays2.length; d++) {
          var c = r.cells[useDays2[d]];
          row[useDays2[d]] = c.isBreak && c.length === 0 ? "" : c.map(function(l) { return l.name + (l.cls ? " " + l.cls : "") + " (" + l.ti + ")"; }).join(" / ");
        }
        return row;
      });
      downloadFile(window.window.Papa.unparse(csvRows2, { columns: ["Time"].concat(useDays2) }), filename + ".csv", "text/csv");
    }
  } else if (format === "xlsx") {
    var XLSX = await getXLSX();
    var wb = XLSX.utils.book_new();
    function gridToSheet(gridRows) {
      var sheetDays = gridRows.days;
      var aoa = [];
      aoa.push(["Time"].concat(sheetDays));
      for (var r = 0; r < gridRows.length; r++) {
        var row = [gridRows[r].time];
        for (var d = 0; d < sheetDays.length; d++) {
          var c = gridRows[r].cells[sheetDays[d]];
          if (c.isBreak && c.length === 0) { row.push(""); }
          else { row.push(c.map(function(l) { return l.name + (l.cls ? " " + l.cls : "") + " (" + l.ti + ")"; }).join("\n")); }
        }
        aoa.push(row);
      }
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [{ wch: 8 }].concat(sheetDays.map(function() { return { wch: 28 }; }));
      return ws;
    }
    if (showSeparate) {
      var groups2 = groupLessonsBySchool(filtered, schools);
      for (var g2 = 0; g2 < groups2.length; g2++) {
        var gRows = buildGridRows(groups2[g2].lessons, students, groups2[g2].school, teachers, gridOpts);
        XLSX.utils.book_append_sheet(wb, gridToSheet(gRows), groups2[g2].school.name.substring(0, 31));
      }
    } else {
      var school2 = schoolId ? schools.find(function(s) { return s.id === schoolId; }) : (filtered.length > 0 ? schools.find(function(s) { return s.id === filtered[0].schoolId; }) : schools[0]);
      var gRows2 = buildGridRows(filtered, students, school2, teachers, gridOpts);
      XLSX.utils.book_append_sheet(wb, gridToSheet(gRows2), "Timetable");
    }
    var listRows = prepareLessonRows(filtered, students);
    var listWs = XLSX.utils.json_to_sheet(listRows);
    var listCols = Object.keys(listRows[0] || {});
    listWs["!cols"] = listCols.map(function(k) { return { wch: Math.max(k.length, Math.max.apply(null, listRows.map(function(r) { return String(r[k] || "").length; }))) + 2 }; });
    XLSX.utils.book_append_sheet(wb, listWs, "List View");
    XLSX.writeFile(wb, filename + ".xlsx");
  } else if (format === "pdf") {
    var tables2 = '';
    if (showSeparate) {
      var groups3 = groupLessonsBySchool(filtered, schools);
      for (var g3 = 0; g3 < groups3.length; g3++) {
        if (g3 > 0) tables2 += '<div style="page-break-before:always"></div>';
        var gridRows3 = buildGridRows(groups3[g3].lessons, students, groups3[g3].school, teachers, gridOpts);
        tables2 += buildStyledTable(gridRows3, groups3[g3].school.name);
      }
    } else {
      var school3 = schoolId ? schools.find(function(s) { return s.id === schoolId; }) : (filtered.length > 0 ? schools.find(function(s) { return s.id === filtered[0].schoolId; }) : schools[0]);
      var gridRows4 = buildGridRows(filtered, students, school3, teachers, gridOpts);
      tables2 += buildStyledTable(gridRows4, null);
    }
    var css = 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:16px;font-size:12px;color:#1f2937}@media print{body{margin:6mm 8mm}@page{size:landscape;margin:6mm 8mm}}';
    var html = '<!DOCTYPE html><html><head><title>' + (opts.title || filename) + '</title><sty' + 'le>' + css + '</sty' + 'le></head><body><h1 style="font-size:16px;margin:0 0 2px;color:#374151">' + (opts.title || filename) + '</h1><div style="color:#6b7280;font-size:10px;margin-bottom:14px">Generated ' + new Date().toLocaleDateString() + ' &middot; ' + filtered.length + ' lessons</div>' + tables2 + '</body></html>';
    downloadFile(html, filename + '.html', 'text/html');
  }
}

function downloadFile(content, filename, mimeType) {
  var blob = new Blob([content], { type: mimeType });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getSchoolAcronym(school) {
  if (!school) return "";
  var n = school.name || "";
  if (n.includes("Solway")) return "SPS";
  if (n.includes("East Bentleigh")) return "EBPS";
  if (n.includes("Moorabbin")) return "MPS";
  return n.split(" ").filter(function(w) { return w.length > 0; }).map(function(w) { return w[0].toUpperCase(); }).join("");
}

// Build a grouped grid: days as column groups, schools as sub-columns within each day
// Build a per-school grid for a teacher (reuses buildGridRows logic, school-scoped)
function getTeacherBreaksForSchedule(school, teachers, lessons) {
  // Only use explicit teacher breaks — NOT school slot recess/lunch times
  var breaks = [];
  var tb = (school ? school.teacherBreaks || [] : []);
  for (var i = 0; i < tb.length; i++) {
    var b = tb[i];
    breaks.push({ start: b.start, end: b.end, day: b.day || "All", label: "Break" });
  }
  if (breaks.length === 0) {
    var tids = [...new Set(lessons.filter(function(l) { return school && l.schoolId === school.id; }).map(function(l) { return l.teacherId; }))];
    var seen = {};
    for (var i2 = 0; i2 < tids.length; i2++) {
      var t = teachers.find(function(t2) { return t2.id === tids[i2]; });
      if (!t) continue;
      for (var j = 0; j < (t.teacherBreaks || []).length; j++) {
        var b2 = t.teacherBreaks[j];
        if (school && b2.schoolId !== school.id) continue;
        var key = (b2.day || "All") + "-" + b2.start + "-" + b2.end;
        if (!seen[key]) { seen[key] = true; breaks.push({ start: b2.start, end: b2.end, day: b2.day || "All", label: "Break" }); }
      }
    }
  }
  return breaks;
}

function buildTeacherSchoolGrid(tLessons, students, school, teachers) {
  var days = ["Monday","Tuesday","Wednesday","Thursday","Friday"].filter(function(d) {
    return tLessons.some(function(l) { return l.day === d; });
  });
  var breaks = school ? getTeacherBreaksForSchedule(school, teachers || [], tLessons) : [];
  var lessonTimes = [...new Set(tLessons.map(function(l) { return l.start; }))];
  var breakTimes = breaks.map(function(b) { return b.start; });
  var allTimes = [...new Set(lessonTimes.concat(breakTimes))].sort(function(a,b){ return timeToMin(a)-timeToMin(b); });
  var ic = instruments_colors;
  var result = allTimes.map(function(time) {
    var breakInfo = breaks.find(function(b) { return b.start === time; });
    // Build lesson cells first
    var cells = {};
    var anyLesson = false;
    for (var di = 0; di < days.length; di++) {
      var day = days[di];
      var cell = tLessons.filter(function(l){ return l.day === day && l.start === time; });
      cells[day] = cell.map(function(l) {
        var st = students ? students.find(function(s){ return s.id === l.studentId; }) : null;
        var name = l.isGroup && l.studentNames ? l.studentNames.join(", ") : l.studentName;
        var cls = st ? st.className || "" : "";
        var color = ic[l.instrument] || ic.default;
        return { name: name, cls: cls, color: color, adjusted: l.adjusted, adjustReason: l.adjustReason };
      });
      if (cells[day].length > 0) anyLesson = true;
    }
    // Only treat as a pure break row if there are no lessons at this time at all
    var isBreak = !!breakInfo && !anyLesson;
    var breakLabel = breakInfo ? (breakInfo.label + " " + breakInfo.start + (breakInfo.end ? "–" + breakInfo.end : "")) : "";
    return { time: time, isBreak: isBreak, breakLabel: breakLabel, cells: cells };
  });
  result.days = days;
  return result;
}

// Build one compact HTML table for a single school's schedule
function buildTeacherSchoolTable(gridRows, school, dayColWidth) {
  var days = gridRows.days || [];
  var acronym = getSchoolAcronym(school);
  var colW = dayColWidth || 130;
  function cellHtml(cellData, isBreakRow) {
    var bg = isBreakRow ? '#FFF3F0' : '#FFFFFF';
    if (!cellData || cellData.length === 0) {
      return '<td style="background:'+bg+';border:1px solid #E8E5E0;padding:4px;width:'+colW+'px"></td>';
    }
    var inner = cellData.map(function(l) {
      return '<div style="background:'+l.color+'22;border-left:3px solid '+l.color+(l.adjusted?';border-bottom:2px solid #F59E0B':'')+';padding:4px 6px;border-radius:3px;margin:1px 0;font-size:11.5px;line-height:1.4">'+
        '<b style="font-size:12px">'+l.name+'</b>'+
        (l.cls?' <span style="color:#6b7280;font-size:10.5px">'+l.cls+'</span>':'')+
        (l.adjusted?'<div style="color:#D97706;font-style:italic;font-size:10px">↻ '+(l.adjustReason||'Adjusted')+'</div>':'')+
        '</div>';
    }).join('');
    return '<td style="background:'+bg+';border:1px solid #E8E5E0;vertical-align:top;padding:4px;width:'+colW+'px">'+inner+'</td>';
  }
  var totalCols = days.length + 1;
  var html = '<div style="display:inline-block;vertical-align:top">';
  html += '<table style="border-collapse:collapse;table-layout:fixed">';
  html += '<thead>';
  // School name row — inside the table so it's always exactly as wide as the columns
  html += '<tr><th colspan="'+totalCols+'" style="background:#344565;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.5px;padding:5px 10px;text-align:center;border:1px solid #2a3654;white-space:nowrap">'+acronym+' — '+(school.name||'')+'</th></tr>';
  // Day header row
  html += '<tr>';
  html += '<th style="background:#344565;color:#fff;padding:7px 5px;text-align:center;font-size:11px;width:52px;border:1px solid #2a3654">Time</th>';
  for (var d = 0; d < days.length; d++) {
    html += '<th style="background:#344565;color:#fff;padding:7px 5px;text-align:center;font-size:11px;width:'+colW+'px;border:1px solid #2a3654">'+days[d]+'</th>';
  }
  html += '</tr></thead><tbody>';
  for (var r = 0; r < gridRows.length; r++) {
    var row = gridRows[r];
    var isBreak = !!row.isBreak;
    if (isBreak) {
      // Break row: coral time cell spanning all day columns
      var totalCols = days.length + 1;
      html += '<tr>';
      html += '<td style="background:#C47A6A;color:#fff;text-align:center;font-weight:700;font-size:10px;border:1px solid #b36859;padding:4px 3px;white-space:nowrap;width:52px">'+row.time+'</td>';
      html += '<td colspan="'+days.length+'" style="background:#FFF3F0;border:1px solid #E8C5BF;padding:4px 8px;font-size:10.5px;font-style:italic;color:#9B5545;text-align:center">'+row.breakLabel+'</td>';
      html += '</tr>';
    } else {
      var even = r % 2 === 0;
      var rowBg = even ? '#FFFFFF' : '#F8EFED';
      html += '<tr>';
      html += '<td style="background:'+rowBg+';text-align:center;font-weight:700;font-size:10.5px;color:#6b7280;border:1px solid #E8E5E0;padding:7px 3px;vertical-align:middle;white-space:nowrap;width:52px">'+row.time+'</td>';
      for (var d2 = 0; d2 < days.length; d2++) html += cellHtml(row.cells[days[d2]], false);
      html += '</tr>';
    }
  }
  html += '</tbody></table></div>';
  return html;
}


async function exportTeacherSchedules(lessons, students, schools, teachers, opts) {
  var format = opts.format;
  var schoolId = opts.schoolId;
  var filtered = schoolId ? lessons.filter(function(l) { return l.schoolId === schoolId; }) : lessons;
  var teacherNames = [...new Set(filtered.map(function(l) { return l.teacherName; }))].sort();
  if (teacherNames.length === 0) throw new Error("No teacher schedules to export");
  var sourceLabel = opts.sourceLabel || "Master";
  var schoolName = schoolId ? (schools.find(function(s) { return s.id === schoolId; })?.name || "") : "All Schools";
  var filenameBase = opts.filenameBase || (sourceLabel + "-Teacher-Schedules").replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");

  if (format === "xlsx") {
    var XLSX = await getXLSX();
    var wb = XLSX.utils.book_new();
    for (var ti = 0; ti < teacherNames.length; ti++) {
      var tName = teacherNames[ti];
      var tLessons = filtered.filter(function(l) { return l.teacherName === tName; });
      var teacherSchoolGroups = groupLessonsBySchool(tLessons, schools);
      var aoa = [];
      aoa.push([tName + " — Schedule", schoolName]);
      aoa.push([]);
      // One section per school, stacked vertically in xlsx
      for (var sg = 0; sg < teacherSchoolGroups.length; sg++) {
        var sgSchool = teacherSchoolGroups[sg].school;
        var sgLessons = teacherSchoolGroups[sg].lessons;
        var sgGrid = buildTeacherSchoolGrid(sgLessons, students, sgSchool, teachers);
        var sgDays = sgGrid.days;
        aoa.push([getSchoolAcronym(sgSchool) + " — " + sgSchool.name]);
        aoa.push(["Time"].concat(sgDays));
        for (var r = 0; r < sgGrid.length; r++) {
          var row = [sgGrid[r].time];
          for (var d = 0; d < sgDays.length; d++) {
            var c = sgGrid[r].cells[sgDays[d]];
            row.push(!c || c.length === 0 ? "" : c.map(function(l){ return l.name+(l.cls?" "+l.cls:""); }).join(" / "));
          }
          aoa.push(row);
        }
        aoa.push([]);
      }
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [{ wch: 8 },{ wch: 26 },{ wch: 26 },{ wch: 26 },{ wch: 26 },{ wch: 26 }];
      var sheetName = tName.split(" ").pop().substring(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }
    XLSX.writeFile(wb, filenameBase + ".xlsx");
  } else {
    // PDF — one page per teacher, schools side-by-side in a flex row
    var DAYS_ORD = {Monday:0,Tuesday:1,Wednesday:2,Thursday:3,Friday:4};
    var css = 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:16px;font-size:12px;color:#1B2432}@media print{body{margin:6mm 8mm}@page{size:landscape;margin:6mm 8mm}}h1{font-size:19px;color:#344565;margin:0 0 2px}';
    var body = "";
    for (var ti2 = 0; ti2 < teacherNames.length; ti2++) {
      if (ti2 > 0) body += '<div style="page-break-before:always"></div>';
      var tName2 = teacherNames[ti2];
      var tLessons2 = filtered.filter(function(l) { return l.teacherName === tName2; });
      // Sort school groups by earliest day this teacher teaches at that school
      var teacherSchoolGroups2 = groupLessonsBySchool(tLessons2, schools);
      teacherSchoolGroups2.sort(function(a, b) {
        var aMin = Math.min.apply(null, a.lessons.map(function(l){ return DAYS_ORD[l.day] != null ? DAYS_ORD[l.day] : 99; }));
        var bMin = Math.min.apply(null, b.lessons.map(function(l){ return DAYS_ORD[l.day] != null ? DAYS_ORD[l.day] : 99; }));
        return aMin - bMin;
      });
      // Build all grids first so we can compute a shared column width
      var sg2Grids = teacherSchoolGroups2.map(function(sg) {
        return buildTeacherSchoolGrid(sg.lessons, students, sg.school, teachers);
      });
      // Estimate max cell content width: longest student name * ~7px per char, min 110, max 180
      var maxNameLen = 0;
      tLessons2.forEach(function(l) {
        var nm = (l.isGroup && l.studentNames ? l.studentNames.join(", ") : l.studentName) || "";
        if (nm.length > maxNameLen) maxNameLen = nm.length;
      });
      var dayColWidth = Math.min(180, Math.max(110, maxNameLen * 7 + 20));
      body += '<h1>' + tName2 + '</h1>';
      body += '<div style="color:#6b7280;font-size:10px;margin-bottom:12px">' + schoolName + ' &middot; ' + sourceLabel + ' &middot; Generated ' + new Date().toLocaleDateString() + '</div>';
      body += '<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">';
      for (var sg2 = 0; sg2 < teacherSchoolGroups2.length; sg2++) {
        body += buildTeacherSchoolTable(sg2Grids[sg2], teacherSchoolGroups2[sg2].school, dayColWidth);
      }
      body += '</div>';
    }
    var html = '<!DOCTYPE html><html><head><title>Teacher Schedules</title><style>' + css + '</style></head><body>' + body + '</body></html>';
    downloadFile(html, filenameBase + ".html", "text/html");
  }
}

async function exportTallyData(tallyEntries, lessons, students, schools, teachers, opts) {
  var format = opts.format || "csv";
  var schoolId = opts.schoolId || null;
  var filenameBase = opts.filenameBase || "Master-Tally";

  // Build enriched rows
  var rows = tallyEntries
    .filter(function(e) { return !schoolId || e.schoolId === schoolId; })
    .map(function(e) {
      var lesson = lessons.find(function(l) { return l.id === e.lessonId; });
      var student = students.find(function(s) { return s.id === e.studentId; });
      var school = schools.find(function(s) { return s.id === e.schoolId; });
      return {
        "Week": e.weekKey || "",
        "Date": e.date || "",
        "Day": lesson?.day || "",
        "Time": lesson ? (lesson.start + "–" + lesson.end) : "",
        "Student": e.studentName || "",
        "Class": student?.className || "",
        "School": school?.name || e.schoolName || "",
        "Instrument": e.instrument || lesson?.instrument || "",
        "Teacher": lesson?.teacherName || "",
        "Status": e.status || "",
        "Reason": e.reason || "",
        "Makeup Eligible": e.makeupEligible === true ? "Yes" : e.makeupEligible === false ? "No" : "",
        "Made Up": e.madeUp ? "Yes" : "No",
        "Notes": e.notes || ""
      };
    });

  if (rows.length === 0) throw new Error("No tally records to export");

  if (format === "csv") {
    const Papa = window.Papa;
    downloadFile(window.window.Papa.unparse(rows), filenameBase + ".csv", "text/csv");
  } else {
    var XLSX = await getXLSX();
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.json_to_sheet(rows);
    var cols = Object.keys(rows[0] || {});
    ws["!cols"] = cols.map(function(k) {
      var max = Math.max(k.length, ...rows.map(function(r) { return String(r[k] || "").length; }));
      return { wch: Math.min(max + 2, 40) };
    });
    XLSX.utils.book_append_sheet(wb, ws, "Master Tally");
    XLSX.writeFile(wb, filenameBase + ".xlsx");
  }
}


// ============================================================
// EXPORT DIALOG COMPONENT
// ============================================================
// Paper-plane-with-swoosh export icon
const ExportIcon = (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{display:"inline-block",verticalAlign:"middle",marginRight:4,flexShrink:0}}>
    <path d="M2 11.5 Q0.5 7 3.8 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.5"/>
    <path d="M1.5 7 L12.5 2 L9 12 L6.5 8.5 Z" fill="currentColor"/>
    <path d="M6.5 8.5 L12.5 2" stroke="white" strokeWidth="0.75" strokeLinecap="round"/>
  </svg>
);

function ExportDialog({ lessons, students, schools, teachers, tallyEntries, availableWeeks, initialType, onClose, notify }) {
  const [exportType, setExportType] = useState(initialType || "timetable"); // "timetable" | "teacher_schedules" | "tally"
  const [source, setSource] = useState("master"); // "master" | weekKey string
  const [schoolId, setSchoolId] = useState("");
  const [teacherName, setTeacherName] = useState("");
  const [className, setClassName] = useState("");
  const [day, setDay] = useState("");
  const [format, setFormat] = useState("xlsx");
  const [exporting, setExporting] = useState(false);
  const [customFilename, setCustomFilename] = useState(null); // null = use auto-generated name

  const selectedWeek = source !== "master" ? (availableWeeks || []).find(w => w.weekKey === source) : null;
  const sourceLessons = selectedWeek ? selectedWeek.lessons : lessons;
  const sourceLabel = selectedWeek ? selectedWeek.weekLabel : "Master";

  const schoolIds = [...new Set(sourceLessons.map(l => l.schoolId))];
  const filteredSchools = schools.filter(s => schoolIds.includes(s.id));
  const scopedLessons = schoolId ? sourceLessons.filter(l => l.schoolId === schoolId) : sourceLessons;
  const teacherNames = [...new Set(scopedLessons.map(l => l.teacherName))].sort();
  const classNames = [...new Set(students.filter(s => scopedLessons.some(l => l.studentId === s.id) && s.className).map(s => s.className))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const previewLessons = sourceLessons.filter(l => {
    if (schoolId && l.schoolId !== schoolId) return false;
    if (teacherName && l.teacherName !== teacherName) return false;
    if (className) { const sids = new Set(students.filter(s => s.className === className).map(s => s.id)); if (!sids.has(l.studentId)) return false; }
    if (day && l.day !== day) return false;
    return true;
  });

  // Teacher schedules preview
  const scheduleTeachers = [...new Set((schoolId ? sourceLessons.filter(l => l.schoolId === schoolId) : sourceLessons).map(l => l.teacherName))].sort();

  // Tally preview
  const tallyFiltered = (tallyEntries || []).filter(e => !schoolId || e.schoolId === schoolId);
  const tallySchoolIds = [...new Set((tallyEntries || []).map(e => e.schoolId))];
  const tallySchools = schools.filter(s => tallySchoolIds.includes(s.id));

  const getPreviewLabel = () => {
    if (exportType === "teacher_schedules") return `${scheduleTeachers.length} teacher schedule${scheduleTeachers.length !== 1 ? "s" : ""}`;
    if (exportType === "tally") return `${tallyFiltered.length} tally record${tallyFiltered.length !== 1 ? "s" : ""}`;
    return `${previewLessons.length} lesson${previewLessons.length !== 1 ? "s" : ""}`;
  };
  const isReady = exportType === "teacher_schedules" ? scheduleTeachers.length > 0 : exportType === "tally" ? tallyFiltered.length > 0 : previewLessons.length > 0;

  // Auto-generate filename from current filter state
  const autoFilename = (() => {
    if (exportType === "teacher_schedules") {
      const schoolPart = schoolId ? ("-" + (schools.find(s => s.id === schoolId)?.name || "School")) : "";
      return `${sourceLabel}-Teacher-Schedules${schoolPart}`.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
    }
    if (exportType === "tally") {
      const schoolPart = schoolId ? ("-" + (schools.find(s => s.id === schoolId)?.name || "School")) : "-All-Schools";
      return `Master-Tally${schoolPart}`.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
    }
    const parts = [];
    if (schoolId) parts.push(filteredSchools.find(s => s.id === schoolId)?.name || "School");
    if (teacherName) parts.push(teacherName);
    if (className) parts.push(className);
    if (day) parts.push(day);
    const filterLabel = parts.length > 0 ? parts.join("-") : "All";
    return `${sourceLabel}-${filterLabel}`.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
  })();

  // Reset custom filename when filters change
  React.useEffect(() => { setCustomFilename(null); }, [exportType, source, schoolId, teacherName, className, day]);

  const activeFilename = (customFilename !== null ? customFilename : autoFilename).trim() || autoFilename;
  const ext = format === "xlsx" ? ".xlsx" : format === "csv" ? ".csv" : ".html";

  const handleExport = async () => {
    setExporting(true);
    try {
      const filenameBase = activeFilename;
      if (exportType === "timetable") {
        const parts = [];
        if (schoolId) parts.push(filteredSchools.find(s => s.id === schoolId)?.name || "School");
        if (teacherName) parts.push(teacherName);
        if (className) parts.push(className);
        if (day) parts.push(day);
        const filterLabel = parts.length > 0 ? parts.join(" — ") : "All";
        await exportLessons(sourceLessons, students, schools, teachers, {
          format, filenameBase, view: schoolId ? "school" : "all",
          schoolId: schoolId || null, teacherName: teacherName || null,
          className: className || null, day: day || null,
          title: `${sourceLabel} Timetable — ${filterLabel}`
        });
        notify(`Exported ${previewLessons.length} lessons as ${format.toUpperCase()}`);
      } else if (exportType === "teacher_schedules") {
        await exportTeacherSchedules(sourceLessons, students, schools, teachers, {
          format: format === "csv" ? "pdf" : format,
          schoolId: schoolId || null,
          sourceLabel,
          filenameBase
        });
        notify(`Exported ${scheduleTeachers.length} teacher schedules`);
      } else if (exportType === "tally") {
        await exportTallyData(tallyEntries || [], lessons, students, schools, teachers, {
          format, schoolId: schoolId || null, filenameBase
        });
        notify(`Exported ${tallyFiltered.length} tally records as ${format.toUpperCase()}`);
      }
      onClose();
    } catch (e) {
      notify("Export failed: " + e.message, "danger");
    }
    setExporting(false);
  };

  const selectStyle = { padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", width: "100%" };
  const radioGroupStyle = { display: "flex", gap: 6, flexWrap: "wrap" };
  const RadioBtn = ({ value, current, onChange, children }) => (
    <button onClick={() => onChange(value)} style={{
      padding: "6px 14px", borderRadius: 8, fontSize: 12, fontFamily: "inherit", cursor: "pointer",
      border: `1.5px solid ${current === value ? colors.accent : colors.border}`,
      background: current === value ? colors.accentLight : colors.white,
      color: current === value ? colors.accentDark : colors.text, fontWeight: current === value ? 600 : 400
    }}>{children}</button>
  );
  const labelStyle = { fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 };
  const TypeCard = ({ value, icon, title, desc }) => (
    <div onClick={() => { setExportType(value); setSchoolId(""); setTeacherName(""); setClassName(""); setDay(""); }}
      style={{ flex: 1, padding: "12px 14px", borderRadius: 10, cursor: "pointer", border: `2px solid ${exportType === value ? colors.accent : colors.border}`,
        background: exportType === value ? colors.accentLight : colors.white, transition: "all 0.15s" }}>
      <div style={{ fontSize: 18, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: 13, color: exportType === value ? colors.accentDark : colors.text }}>{title}</div>
      <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)" }} onClick={onClose} />
      <div style={{ position: "relative", background: colors.white, borderRadius: 16, padding: "28px 32px", width: 560, maxHeight: "90vh", overflow: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.22)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <div style={{ fontWeight: 700, fontSize: 18, color: colors.text, display: "flex", alignItems: "center", gap: 4 }}>{ExportIcon}Export</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: colors.textMuted, lineHeight: 1 }}>×</button>
        </div>

        {/* Export Type */}
        <div style={{ marginBottom: 20 }}>
          <div style={labelStyle}>What to export</div>
          <div style={{ display: "flex", gap: 8 }}>
            <TypeCard value="timetable" icon="📅" title="Timetable" desc="Grid view by school, teacher or class" />
            <TypeCard value="teacher_schedules" icon="👩‍🏫" title="Teacher Schedules" desc="One page per teacher, all schools" />
            <TypeCard value="tally" icon="✓" title="Master Tally" desc="Lesson completion records as spreadsheet" />
          </div>
        </div>

        {/* Source — only for timetable & teacher schedules */}
        {exportType !== "tally" && (
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>Source</div>
            <div style={radioGroupStyle}>
              {lessons.length > 0 && <RadioBtn value="master" current={source} onChange={v => { setSource(v); setSchoolId(""); setTeacherName(""); setClassName(""); }}>Master Timetable</RadioBtn>}
              {(availableWeeks || []).map(w => (
                <RadioBtn key={w.weekKey} value={w.weekKey} current={source} onChange={v => { setSource(v); setSchoolId(""); setTeacherName(""); setClassName(""); }}>{w.weekLabel}</RadioBtn>
              ))}
            </div>
          </div>
        )}

        {/* School filter — all types */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>School</div>
          <select value={schoolId} onChange={e => { setSchoolId(e.target.value); setTeacherName(""); setClassName(""); }}
            style={selectStyle}>
            <option value="">All Schools</option>
            {(exportType === "tally" ? tallySchools : filteredSchools).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {/* Timetable-only filters */}
        {exportType === "timetable" && (<>
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>Teacher</div>
            <select value={teacherName} onChange={e => setTeacherName(e.target.value)} style={selectStyle}>
              <option value="">All Teachers</option>
              {teacherNames.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>Class</div>
            <select value={className} onChange={e => setClassName(e.target.value)} style={selectStyle}>
              <option value="">All Classes</option>
              {classNames.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>Day</div>
            <div style={radioGroupStyle}>
              <RadioBtn value="" current={day} onChange={setDay}>All Days</RadioBtn>
              {DAYS.map(d => <RadioBtn key={d} value={d} current={day} onChange={setDay}>{d.slice(0, 3)}</RadioBtn>)}
            </div>
          </div>
        </>)}

        {/* Teacher schedules info */}
        {exportType === "teacher_schedules" && scheduleTeachers.length > 0 && (
          <div style={{ marginBottom: 16, padding: "10px 14px", background: colors.accentLight, borderRadius: 8, fontSize: 12, color: colors.accentDark }}>
            Will export: {scheduleTeachers.join(", ")}
          </div>
        )}

        {/* Format */}
        <div style={{ marginBottom: 22 }}>
          <div style={labelStyle}>Format</div>
          <div style={radioGroupStyle}>
            <RadioBtn value="xlsx" current={format} onChange={setFormat}>Excel (.xlsx)</RadioBtn>
            {exportType !== "teacher_schedules" && <RadioBtn value="csv" current={format} onChange={setFormat}>CSV</RadioBtn>}
            {exportType !== "tally" && <RadioBtn value="pdf" current={format} onChange={setFormat}>PDF (printable)</RadioBtn>}
          </div>
          {format === "xlsx" && <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 6 }}>Opens in Excel, Numbers, and Google Sheets</div>}
          {format === "pdf" && <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 6 }}>Downloads as HTML — open and use File → Print → Save as PDF</div>}
          {exportType === "teacher_schedules" && format === "csv" && setFormat("xlsx") && null}
        </div>

        {/* Filename */}
        <div style={{ marginBottom: 22 }}>
          <div style={labelStyle}>File name</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="text"
              value={customFilename !== null ? customFilename : autoFilename}
              onChange={e => setCustomFilename(e.target.value)}
              style={{ flex: 1, padding: "8px 12px", border: `1.5px solid ${customFilename !== null ? colors.accent : colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", boxSizing: "border-box" }}
              spellCheck={false}
            />
            <span style={{ fontSize: 13, color: colors.textMuted, flexShrink: 0 }}>{ext}</span>
            {customFilename !== null && (
              <button onClick={() => setCustomFilename(null)} title="Reset to auto-generated name"
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: colors.textMuted, padding: "0 2px", lineHeight: 1 }}>↺</button>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 16, borderTop: `1px solid ${colors.borderLight}` }}>
          <span style={{ fontSize: 13, color: colors.textMuted }}>{getPreviewLabel()}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
            <Btn onClick={handleExport} disabled={exporting || !isReady}>
              {exporting ? "Exporting..." : <span style={{display:"flex",alignItems:"center",gap:4}}>{ExportIcon}Export</span>}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// STYLES
// ============================================================
const colors = {
  bg: "#F8EFED",
  sidebar: "#1B2432",
  sidebarHover: "#263347",
  sidebarActive: "#344565",
  accent: "#C47A6A",
  accentLight: "#F0DEDA",
  accentDark: "#A35E50",
  text: "#2D2D2D",
  textLight: "#6B6B6B",
  textMuted: "#9B9B9B",
  white: "#FFFFFF",
  border: "#E8E5E0",
  borderLight: "#F0EDE8",
  success: "#4A9B6E",
  warning: "#D97706",
  danger: "#C45454",
  cardBg: "#FFFFFF",
  inputBg: "#FFFFFF",
  inputBorder: "#D8D5D0",
  tagBg: "#F0EDE8",
  // Semantic greys / status colours — added to reduce hardcoded hex values
  gray700: "#374151",
  gray500: "#6B7280",
  gray400: "#9CA3AF",
  amber: "#D97706",
  amberLight: "#FFF7ED",
  amberDark: "#92400E",
  red600: "#DC2626",
  redLight: "#FEF2F2",
  blue600: "#2563EB",
  blueLight: "rgba(52,69,101,0.07)",
  purple600: "#7C3AED",
  purpleLight: "#F5F3FF",
  green600: "#16A34A",
  purple600: "#8B5CF6",
};

// ============================================================
// SMOKE TESTS — run once at startup in development
// ============================================================
function runSmokeTests(logErrorFn) {
  const results = [];
  const assert = (label, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ label, pass, actual, expected });
  };
  const assertTruthy = (label, val) => {
    results.push({ label, pass: !!val, actual: val, expected: "truthy" });
  };

  // timeToMin / minToTime roundtrip
  assert("timeToMin 09:00", timeToMin("09:00"), 540);
  assert("timeToMin 14:30", timeToMin("14:30"), 870);
  assert("minToTime 540",   minToTime(540), "09:00");
  assert("minToTime 870",   minToTime(870), "14:30");
  assert("minToTime roundtrip", minToTime(timeToMin("11:15")), "11:15");

  // getSchoolAcronym
  assert("acronym SPS",  getSchoolAcronym({ name: "Solway Primary School" }), "SPS");
  assert("acronym EBPS", getSchoolAcronym({ name: "East Bentleigh Primary School" }), "EBPS");

  // migrateData — students
  const rawStudent = { id: "x", name: "Test", schoolId: "s1", className: "3A", instruments: [{ name: "Piano" }] };
  const migrated = migrateData("students", [rawStudent])[0];
  assert("migrate student notes default", migrated.notes, "");
  assert("migrate student status default", migrated.status, "active");
  assert("migrate student instruments preserved", migrated.instruments[0].name, "Piano");

  // migrateData — tallyEntries weekLabel backfill
  const rawEntry = { id: "t1", weekKey: "2026-01-19", studentId: "s", instrument: "Piano", status: "missed", madeUp: false };
  const migratedEntry = migrateData("tallyEntries", [rawEntry])[0];
  assertTruthy("migrate tally weekLabel backfill", migratedEntry.weekLabel);
  assert("migrate tally makeupEligible default", migratedEntry.makeupEligible, true);

  // generateMasterTimetable basic smoke — one school, one student, one teacher
  try {
    const school = { id: "s1", name: "Test School", classNames: ["3A"], slots: defaultSlots() };
    const student = { id: "st1", name: "Alice", schoolId: "s1", className: "3A", status: "active",
      instruments: [{ name: "Piano", duration: 30 }], outsideClassOnly: false, availableBefore: false, availableAfter: false,
      outsideClassPreferred: false, avoidTimes: [], preferredTimes: [], notes: "" };
    const teacher = { id: "t1", name: "Teacher A",
      availability: [{ schoolId: "s1", days: ["Monday","Tuesday","Wednesday","Thursday","Friday"] }],
      instruments: ["Piano"] };
    const result = generateMasterTimetable([school], [student], [teacher]);
    assertTruthy("generateMasterTimetable returns result", result);
    assertTruthy("generateMasterTimetable has lessons array", Array.isArray(result.lessons));
  } catch(e) {
    results.push({ label: "generateMasterTimetable smoke", pass: false, actual: e.message, expected: "no error" });
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  if (failed.length > 0) {
    console.warn("Smoke tests: " + passed + "/" + results.length + " passed. Failures:");
    failed.forEach(r => console.warn("  FAIL: " + r.label + " - got " + JSON.stringify(r.actual) + ", expected " + JSON.stringify(r.expected)));
    if (logErrorFn) failed.forEach(r => logErrorFn("Smoke test failed: " + r.label, "got " + r.actual + ", expected " + r.expected));
  } else {
    console.log("Smoke tests: " + passed + "/" + results.length + " passed");
  }
}

export default function MusicTimetableApp() {
  const [page, _setPage] = useState("dashboard");
  const [focusStudentId, setFocusStudentId] = useState(null);
  const [focusReturnPage, setFocusReturnPage] = useState(null);
  const [focusGroupId, setFocusGroupId] = useState(null);
  const [focusGroupReturnPage, setFocusGroupReturnPage] = useState(null);
  // masterBreaks: slot-specific breaks that survive regen { id, schoolId, day, time }
  const [masterBreaks, setMasterBreaks] = useState([]);
  const [pageHistory, setPageHistory] = useState(["dashboard"]);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [resetKey, setResetKey] = useState(0); // increments to signal tab reset
  const mainScrollRef = useRef(null);

  // Save scroll position for the given page into its viewState
  const saveScrollForPage = (pg) => {
    const st = mainScrollRef.current?.scrollTop || 0;
    const map = { timetable: setTtViewState, weekly: setWeeklyViewState, students: setStudentsViewState, schools: setSchoolsViewState, teachers: setTeachersViewState, groups: setGroupsViewState, tally: setTallyViewState, specialists: setSpecialistsViewState, interruptions: setInterruptionsViewState, dashboard: setDashboardViewState, contacts: setContactsViewState };
    if (map[pg]) map[pg](prev => ({ ...prev, scrollTop: st }));
  };

  // Restore scroll position for the given page from its viewState
  const getScrollForPage = (pg) => {
    const map = { timetable: ttViewState, weekly: weeklyViewState, students: studentsViewState, schools: schoolsViewState, teachers: teachersViewState, groups: groupsViewState, tally: tallyViewState, specialists: specialistsViewState, interruptions: interruptionsViewState, dashboard: dashboardViewState, contacts: contactsViewState };
    return (map[pg] || {}).scrollTop || 0;
  };

  const resetViewStateForPage = (pg) => {
    const resets = {
      timetable: () => setTtViewState({ selectedSchool: "", viewMode: "grid", filterTeacher: "", scrollTop: 0, gridScroll: {} }),
      weekly: () => setWeeklyViewState({ selectedSchool: "", weekOffset: 0, showMissedTally: false, scrollTop: 0, gridScroll: {} }),
      students: () => setStudentsViewState({ filter: { school: "", className: "", instrument: "", teacher: "", search: "" }, sortCol: "name", sortDir: "asc", scrollTop: 0 }),
      schools: () => setSchoolsViewState({ scrollTop: 0 }),
      teachers: () => setTeachersViewState({ scrollTop: 0 }),
      groups: () => setGroupsViewState({ filterSchool: "", scrollTop: 0 }),
      tally: () => setTallyViewState({ selectedSchool: "all", groupBy: "teacher", scrollTop: 0 }),
      specialists: () => setSpecialistsViewState({ filterSchool: "", filterClass: "", filterDay: "", filterSubject: "", scrollTop: 0 }),
      interruptions: () => setInterruptionsViewState({ filterSchool: "", filterType: "", scrollTop: 0 }),
      dashboard: () => setDashboardViewState({ scrollTop: 0 }),
      contacts: () => setContactsViewState({ scrollTop: 0 }),
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
  const [timetable, setTimetableRaw] = useState(null);
  const timetableUndoStack = useRef([]);
  const timetableRedoStack = useRef([]);
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
  // Unified undo/redo for timetable page — picks the most recently pushed action across both stacks
  const undoTimetablePage = () => {
    const ttTop = timetableUndoStack.current[timetableUndoStack.current.length - 1];
    const teachTop = teachersUndoStack.current[teachersUndoStack.current.length - 1];
    if (ttTop && teachTop) { if (teachTop.seq > ttTop.seq) undoTeachers(); else undoTimetable(); }
    else if (ttTop) undoTimetable();
    else if (teachTop) undoTeachers();
  };
  const redoTimetablePage = () => {
    const ttTop = timetableRedoStack.current[timetableRedoStack.current.length - 1];
    const teachTop = teachersRedoStack.current[teachersRedoStack.current.length - 1];
    if (ttTop && teachTop) { if (teachTop.seq > ttTop.seq) redoTeachers(); else redoTimetable(); }
    else if (ttTop) redoTimetable();
    else if (teachTop) redoTeachers();
  };
  const ttPageUndoCount = () => timetableUndoStack.current.length + teachersUndoStack.current.length;
  const ttPageRedoCount = () => timetableRedoStack.current.length + teachersRedoStack.current.length;
  const [weeklyTimetables, setWeeklyTimetablesRaw] = useState({}); // { "2025-W10|schoolId": { lessons, missed, notes } }
  const weeklyUndoStack = useRef([]);
  const weeklyRedoStack = useRef([]);
  const setWeeklyTimetables = (valOrFn) => {
    setWeeklyTimetablesRaw(prev => {
      const newVal = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
      weeklyUndoStack.current.push(JSON.parse(JSON.stringify(prev)));
      if (weeklyUndoStack.current.length > 50) weeklyUndoStack.current.shift();
      weeklyRedoStack.current = [];
      // Prune oldest weeks — keep only the 20 most recent week dates
      const allKeys = Object.keys(newVal);
      const uniqueWeekDates = [...new Set(allKeys.map(k => k.split("|")[0]))].sort();
      if (uniqueWeekDates.length > 20) {
        const toKeep = new Set(uniqueWeekDates.slice(-20));
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
  const [notification, setNotification] = useState(null);
  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem("mt-api-key") || ""; } catch(e) { return ""; }
  });
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);

  // Sync apiKey to module-level variable for use in fetch calls
  useEffect(() => { _anthropicApiKey = apiKey; }, [apiKey]);

  // Persistent view state (survives tab switches)
  const [ttViewState, setTtViewState] = useState({ selectedSchool: "", viewMode: "grid", filterTeacher: "", scrollTop: 0 });
  const [weeklyViewState, setWeeklyViewState] = useState({ selectedSchool: "", weekOffset: 0, showMissedTally: false, scrollTop: 0 });
  const [sharedSchool, setSharedSchool] = useState("");
  const [studentsViewState, setStudentsViewState] = useState({ filter: { school: "", className: "", instrument: "", teacher: "", search: "" }, sortCol: "name", sortDir: "asc", scrollTop: 0 });
  const [schoolsViewState, setSchoolsViewState] = useState({ scrollTop: 0 });
  const [teachersViewState, setTeachersViewState] = useState({ scrollTop: 0 });
  const [groupsViewState, setGroupsViewState] = useState({ filterSchool: "", scrollTop: 0 });
  const [tallyViewState, setTallyViewState] = useState({ selectedSchool: "all", groupBy: "teacher", scrollTop: 0 });
  const [specialistsViewState, setSpecialistsViewState] = useState({ filterSchool: "", filterClass: "", filterDay: "", filterSubject: "", scrollTop: 0 });
  const [interruptionsViewState, setInterruptionsViewState] = useState({ filterSchool: "", filterType: "", scrollTop: 0 });
  const [dashboardViewState, setDashboardViewState] = useState({ scrollTop: 0 });
  const [contactsViewState, setContactsViewState] = useState({ scrollTop: 0 });
  const [contacts, setContacts] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
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
  useEffect(() => { if (storageReady.current) saveData(STORAGE_KEYS.contacts, contacts); }, [contacts]);

  // Auto-backup to localStorage whenever important data changes (silent, always available)
  useEffect(() => {
    if (!storageReady.current) return;
    triggerAutoBackup({ version: 1, exportedAt: new Date().toISOString(), schools, students, teachers, specialists, interruptions, groups, timetable, weeklyTimetables, tallyEntries });
  }, [schools, students, teachers, timetable, weeklyTimetables, tallyEntries]);


  // ── Scheduled daily file backup at 4:00am (or on-open if missed) ──────────
  useEffect(() => {
    const BACKUP_HOUR = 4; // 4:00am Melbourne time
    const MS_23H = 23 * 60 * 60 * 1000;

    const doScheduledBackup = async () => {
      try {
        const ttVersions = await loadData(STORAGE_KEYS.timetableVersions, []);
        const backup = {
          version: DATA_VERSION, exportedAt: new Date().toISOString(),
          schools, students, teachers, specialists, interruptions, groups,
          timetable, weeklyTimetables, tallyEntries, timetableVersions: ttVersions
        };
        const json = JSON.stringify(backup, null, 2);
        const dateStr = toLocalDateStr(melbourneNow());
        const filename = "timetabling-auto-" + dateStr + ".json";
        if (window.electronAPI) {
          // Electron: write directly to backup folder — no dialog, no prompt
          const result = await window.electronAPI.writeBackup(filename, json);
          if (!result.ok) throw new Error(result.error);
          localStorage.setItem(STORAGE_KEYS.lastScheduledBackup, new Date().toISOString());
          notify("Auto-backup saved to backup folder", "success", 4000);
        } else {
          // Browser: trigger download
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = filename;
          document.body.appendChild(a); a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          localStorage.setItem(STORAGE_KEYS.lastScheduledBackup, new Date().toISOString());
          notify("Auto-backup downloaded (scheduled 4am)", "success", 5000);
        }
      } catch(e) {
        logError("Scheduled backup failed", e.message);
      }
    };

    const checkAndBackup = () => {
      if (!storageReady.current || !schools.length) return;
      const now = melbourneNow();
      const hour = now.getHours();
      const lastStr = localStorage.getItem(STORAGE_KEYS.lastScheduledBackup);
      const last = lastStr ? new Date(lastStr) : null;
      const overdue = !last || (now - last) > MS_23H;
      if (overdue && (hour === BACKUP_HOUR || (!last && schools.length > 0))) {
        doScheduledBackup();
      }
    };

    // Check immediately on load (catches missed 4am if tab was closed)
    const onOpenTimer = setTimeout(checkAndBackup, 2000);
    // Then check every minute
    const interval = setInterval(checkAndBackup, 60 * 1000);
    return () => { clearTimeout(onOpenTimer); clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schools.length, storageReady.current]);

  // Listen for Cmd+Shift+B / Backup menu item from Electron main process
  React.useEffect(() => {
    if (!window.electronAPI) return;
    const unsub = window.electronAPI.onMenuBackup(() => {
      // Trigger manual backup — find the Dashboard handleBackup by dispatching a custom event
      window.dispatchEvent(new CustomEvent("electron-manual-backup"));
    });
    return unsub;
  }, []);

  // Listen for update status from electron-updater
  React.useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onUpdateStatus) return;
    const unsub = window.electronAPI.onUpdateStatus((status) => {
      console.log("[updater] status received:", status);
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
        setUpdateProgress(null);
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

  const notify = (msg, type = "success", duration = 3500) => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), duration);
  };

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
      notify(`Parsing scheduling notes...`);
      try {
        // Build specialist context (always included for reference)
        const specContext = specialists.length > 0
          ? `\nSpecialist timetable entries (with notes where relevant):\n${specialists
              .filter(s => s.notes && s.notes.trim())
              .map(s => `- ${s.className} ${s.day} ${s.start}–${s.end} ${s.subject}${s.notes ? ` [notes: "${s.notes}"]` : ""}`)
              .join("\n") || "(no specialist entries have notes)"}`
          : "";

        const specialistSubjects = [...new Set(specialists.map(s => s.subject))].join(", ");

        // --- Parse specialist notes ---
        if (specialistsWithNotes.length > 0) {
          const specPayload = specialistsWithNotes.map(s => ({
            id: s.id, className: s.className, day: s.day,
            start: s.start, end: s.end, subject: s.subject, notes: s.notes
          }));

          const specResponse = await anthropicFetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: getAnthropicHeaders(),
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 2000,
              messages: [{
                role: "user",
                content: `Parse these specialist class entry notes into scheduling hints.

Specialist entries with notes:
${JSON.stringify(specPayload, null, 2)}

For each entry, extract:
- id: the entry's id (pass through exactly)
- partialAvailability: true if the notes suggest this class does NOT run every week (e.g. "alternating weeks", "weeks 4 and 5 only", "fortnightly", "even weeks", "not every week"). false if it runs every week or unclear.
- extraInfo: any other scheduling-relevant info as a short string

Rules:
- "alternating weeks", "fortnightly", "every other week", "odd/even weeks" = partialAvailability: true
- "weeks X and Y only", "term 2 only" = partialAvailability: true
- If notes are just descriptive with no scheduling impact, set partialAvailability: false

Respond ONLY with a JSON array of {id, partialAvailability, extraInfo}. No other text, no markdown.`
              }]
            })
          });

          if (specResponse.ok) {
            const specData = await specResponse.json();
            const specText = specData.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
            const specCleaned = specText.replace(/```json|```/g, "").trim();
            try {
              const specHints = JSON.parse(specCleaned);
              if (Array.isArray(specHints)) {
                const specHintsMap = {};
                for (const h of specHints) { specHintsMap[h.id] = h; }
                enrichedSpecialists = specialists.map(s => {
                  const h = specHintsMap[s.id];
                  if (h) return { ...s, _partial: h.partialAvailability || false };
                  return s;
                });
              }
            } catch(e) { /* ignore */ }
          }
        }

        // --- Parse student notes ---
        if (studentsWithNotes.length > 0) {
          const notesPayload = studentsWithNotes.map(s => ({
            id: s.id, name: s.name, className: s.className,
            school: schools.find(sc => sc.id === s.schoolId)?.name || "",
            notes: s.notes
          }));

          const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: getAnthropicHeaders(),
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 4000,
              messages: [{
                role: "user",
                content: `Parse these student notes into scheduling hints. Each student may have preferences, constraints, or availability info in their notes.

Students:
${JSON.stringify(notesPayload, null, 2)}

Known specialist subjects at these schools: ${specialistSubjects}
School days: Monday, Tuesday, Wednesday, Thursday, Friday
School hours: typically 8:30am–3:30pm
${specContext}

For each student, extract:
- preferredDays: array of day names they prefer (e.g. ["Friday"]). Use this for soft preferences like "prefers Friday", "would like Monday"
- avoidDays: array of day names to avoid entirely
- avoidTimes: array of {day, start (HH:MM), end (HH:MM)} time blocks to avoid (e.g. OT sessions, appointments)
- requiredTimes: array of {day, start (HH:MM), instrument (optional)} — ONLY for notes that specify a CONCRETE day AND time for the lesson (e.g. "lesson at 10am Thursday", "scheduled for 2:30 on Wednesday", "music lesson Tuesday 11:00"). Both day AND time must be present in the note. NEVER put day-only preferences here. If the note specifies WHICH instrument goes at which time (e.g. "Guitar 8:30 Thursday, Piano 9:00 Thursday"), include the instrument name in the "instrument" field.
- preferredTimes: array of {day, start (HH:MM)} — for softer time preferences that aren't strict requirements (e.g. "ideally around 11am", "morning preferred"). Can have just a start without a day if only time-of-day is mentioned.
- allowedSpecialists: array of specialist subject names during which the student CAN be scheduled (e.g. if notes say "Can be scheduled during French", return ["LOTE"])
- extraNotes: any other scheduling-relevant info as a short string, or empty string

Rules:
- Only include fields where the notes give clear info — use empty arrays and empty strings for unknowns
- Convert 12-hour times to 24-hour format. IMPORTANT: School hours are 8:30am–3:30pm, so times like "1:10", "1:30", "2:00", "3:00" etc. always mean PM (13:10, 13:30, 14:00, 15:00). Times "4:00", "4:30", "5:00", "5:30", "6:00" are AFTER school and mean PM (16:00, 16:30, 17:00, 17:30, 18:00). Only times 7, 8, 9, 10, 11 could be AM. A time like "4:00" ALWAYS means 16:00, never 04:00.
- For avoid times, estimate a 30-minute window if no end time given
- Map language names (French, Japanese, Italian etc.) to "LOTE" for allowedSpecialists
- Map sport/PE references to "PE/Sport"
- If notes say things like "Can miss Art", that means Art is an allowedSpecialist
- Consider the specialist timetable context above when interpreting notes about specific classes or times
- CRITICAL: requiredTimes is ONLY for notes that explicitly state BOTH a specific day AND a specific time. "Prefers Friday" = preferredDays. "Lesson on Friday at 10am" = requiredTimes. "Morning if possible" = preferredTimes. If in doubt, use preferredDays or preferredTimes, NOT requiredTimes.
- If a student learns multiple instruments and the notes specify multiple times (e.g. "8:30 and 9:00 on Thursday"), include ALL the times as separate requiredTimes entries — they will be assigned to each instrument in order.
- If notes say lessons should be "back-to-back" on a specific day with a starting time, generate requiredTimes for consecutive 30-minute slots on that day.

Respond ONLY with a JSON array of {id, preferredDays, avoidDays, avoidTimes, requiredTimes, preferredTimes, allowedSpecialists, extraNotes}. requiredTimes entries should be {day, start} or {day, start, instrument} if the note specifies which instrument. No other text, no markdown.`
              }]
            })
          });

          if (!response.ok) {
            const errText = await response.text();
            if (logError) logError("Notes parse API error " + response.status, errText.slice(0, 200));
          }
          if (response.ok) {
            const data = await response.json();
            const text = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
            const cleaned = text.replace(/```json|```/g, "").trim();
            try {
              const hints = JSON.parse(cleaned);
              if (Array.isArray(hints)) {
                const hintsMap = {};
                for (const h of hints) { hintsMap[h.id] = h; }
                enrichedStudents = enrichedStudents.map(s => {
                  const h = hintsMap[s.id];
                  if (h) return { ...s, _noteHints: h };
                  return s;
                });
              }
            } catch(e) { /* ignore parse errors, proceed without hints */ }
          }
        }
      } catch (err) {
        console.error("Note parsing error:", err);
        if (err.message && (err.message.includes("401") || err.message.includes("403") || err.message.includes("API"))) {
          notify("⚠ AI note parsing failed — check your API key in settings", "warning");
        } else {
          notify("⚠ Note parsing skipped: " + err.message, "warning");
        }
        // Continue without hints
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
    let msg = `Timetable generated: ${result.lessons.length} lessons scheduled, ${result.unscheduled.length} unscheduled`;
    if (groupsSched > 0) msg += ` (incl. ${groupsSched} group${groupsSched !== 1 ? "s" : ""})`;
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
        const specContext = specialists.length > 0
          ? `\nSpecialist timetable entries (with notes where relevant):\n${specialists
              .filter(s => s.notes && s.notes.trim())
              .map(s => `- ${s.className} ${s.day} ${s.start}–${s.end} ${s.subject}${s.notes ? ` [notes: "${s.notes}"]` : ""}`)
              .join("\n") || "(no specialist entries have notes)"}`
          : "";
        const specialistSubjects = [...new Set(specialists.map(s => s.subject))].join(", ");

        if (specialistsWithNotes.length > 0) {
          const specPayload = specialistsWithNotes.map(s => ({
            id: s.id, className: s.className, day: s.day,
            start: s.start, end: s.end, subject: s.subject, notes: s.notes
          }));
          const specResponse = await anthropicFetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: getAnthropicHeaders(),
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514", max_tokens: 2000,
              messages: [{ role: "user", content: `Parse these specialist class notes for scheduling relevance.\n\nEntries:\n${JSON.stringify(specPayload, null, 2)}\n\nFor each entry, determine:\n- partialAvailability: true if the class doesn't run every week (e.g. "alternating weeks", "fortnightly", "even weeks", "weeks 4 and 5 only", "term 2 only")\n- extraInfo: any other scheduling-relevant info as a short string\n\nRespond ONLY with a JSON array of {id, partialAvailability, extraInfo}. No other text.` }]
            })
          });
          if (specResponse.ok) {
            const data = await specResponse.json();
            const text = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
            try {
              const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
              if (Array.isArray(parsed)) {
                const map = {}; for (const p of parsed) map[p.id] = p;
                enrichedSpecialists = specialists.map(s => map[s.id] ? { ...s, _partial: map[s.id].partialAvailability } : s);
              }
            } catch(e) {}
          }
        }

        if (studentsWithNotes.length > 0) {
          const notesPayload = studentsWithNotes.map(s => ({
            id: s.id, name: s.name, className: s.className,
            school: schools.find(sc => sc.id === s.schoolId)?.name || "", notes: s.notes
          }));
          const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: getAnthropicHeaders(),
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514", max_tokens: 4000,
              messages: [{ role: "user", content: `Parse these student notes into scheduling hints.\n\nStudents:\n${JSON.stringify(notesPayload, null, 2)}\n\nKnown specialist subjects: ${specialistSubjects}\nSchool days: Monday-Friday\nSchool hours: typically 8:30am–3:30pm\n${specContext}\n\nFor each student, extract:\n- preferredDays: array of day names they prefer\n- avoidDays: array of day names to avoid entirely\n- avoidTimes: array of {day, start (HH:MM), end (HH:MM)} time blocks to avoid\n- requiredTimes: array of {day, start (HH:MM)} — ONLY for notes with BOTH a specific day AND time\n- preferredTimes: array of {day, start (HH:MM)} — softer time preferences\n- allowedSpecialists: array of specialist subject names during which the student CAN be scheduled\n- extraNotes: any other scheduling-relevant info\n\nRules:\n- Only include fields where notes give clear info\n- Convert 12-hour to 24-hour format. School hours are 8:30am-3:30pm so times like 1:10, 1:30, 2:00 always mean PM (13:10, 13:30, 14:00)\n- For avoid times, estimate 30-min window if no end given\n- Map languages to "LOTE", sport/PE to "PE/Sport"\n- requiredTimes ONLY for explicit day+time. "Prefers Friday" = preferredDays, NOT requiredTimes\n- Multiple required times for multi-instrument students map to instruments in order\n\nRespond ONLY with a JSON array of {id, preferredDays, avoidDays, avoidTimes, requiredTimes, preferredTimes, allowedSpecialists, extraNotes}. No other text.` }]
            })
          });
          if (response.ok) {
            const data = await response.json();
            const text = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
            try {
              const hints = JSON.parse(text.replace(/```json|```/g, "").trim());
              if (Array.isArray(hints)) {
                const hintsMap = {}; for (const h of hints) hintsMap[h.id] = h;
                enrichedStudents = enrichedStudents.map(s => hintsMap[s.id] ? { ...s, _noteHints: hintsMap[s.id] } : s);
              }
            } catch(e) {}
          }
        }
      } catch (err) { console.error("Note parsing error:", err); }
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
        if (showApiKeyModal) { setShowApiKeyModal(false); return; }
        if (showExportDialog) { setShowExportDialog(null); return; }
      }
      // Arrow keys: left/right = history, up/down = navigate sidebar pages
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        if (e.key === "ArrowLeft" && historyCursor > 0) { e.preventDefault(); goBack(); }
        if (e.key === "ArrowRight" && historyCursor < pageHistory.length - 1) { e.preventDefault(); goForward(); }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const PAGE_ORDER = ["dashboard","schools","specialists","interruptions","teachers","students","contacts","pending","groups","timetable","weekly","tally"];
          const idx = PAGE_ORDER.indexOf(page);
          if (e.key === "ArrowUp" && idx > 0) setPage(PAGE_ORDER[idx - 1]);
          if (e.key === "ArrowDown" && idx < PAGE_ORDER.length - 1) setPage(PAGE_ORDER[idx + 1]);
        }
        return;
      }
      // Cmd+Z / Ctrl+Z: undo for timetable (lessons or breaks) or weekly
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        if (page === "timetable" && ttPageUndoCount() > 0) {
          e.preventDefault(); undoTimetablePage();
        } else if (page === "weekly" && weeklyUndoStack.current.length > 0) {
          e.preventDefault(); undoWeekly();
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
  }, [page, showApiKeyModal, showExportDialog, historyCursor, pageHistory]);


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
      <div className="no-print" style={{ width: 240, background: colors.sidebar, display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box", height: HEADER_HEIGHT, flexShrink: 0 }}>
          <div style={{ background: "#344565", borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", boxSizing: "border-box" }}>
            <img src={"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAL4AAAA6CAYAAAAOVeNTAAATHUlEQVR4nO2deZRfRZXHP7eXpJOQFQiExUAyCQFkOwkRBhFxQBYHZhzCFhVmZMKBERxgxgHOyBCUddDhAIOsAyObDNuogIAKsglBUBCQVZLgBBKDbAmQtfs7f9xb/avfy/t12pCmpft9z+nTv1evllv1bt26davqFlSoUKFChf4B620CKvxpQVInT5iZepOWnkTF+P0cOaND32b2HBXj92ME0yceaDKzlRF2ItACnAE0AR0pTX/pGBX6KCRZ+svCpki6Q9JcSbMltTaK+1FHU28TUKHX0STpHEnfAIYD+wK3APOAnSSNAtoqSV+hTyAkeFP8PSKpXdIekl6VtLek6yTNkzRH0l9H/ObeprtChQ+EYOSW+P13khYGwz8XzL5UNVwY8SrGr/DRR8b4O0paIOn3klaqHu9FZxgVcfuMnl+hH0JSU/zfQNKvJHUUGP4qSd+T9JCk1yXNiPh9QupXk9v+izRZbQE2pmbW/AWwALgI+AbwG+BpYMcPm8CeREtvE1Ch1/EmMBe4FrfXLwW2AA4ETgIuASYAQyJ+n7DuVIzfzxAqjnAzpgHLgAeBm4FncMn+C2DTMGE+IekZoBnAzDpKM/6IoWL8/gcjVmlTgKQBwK5mNkvSAzhfNGcruyvNbEXvkNszqBi/nyBNZs2sPZ4HA38O7A0cDNyaMfryPClgkqyvSHuoGL9PIjM5JkZWYlpJmwAH4Mw+BWiNuBuYmSR16vDZaq36mhmzYvxeRiZljZg4riXJ2gx0ZBJ+K+BQYDowLov3FvAUcEciKWiom8RWWxYqrDUk9aMsfE0kbNqGkD03S/q0pCskzS/Y6Z+QdJqknULtSeVWJu4KPYPCdgGTNFXS30qaLmlihDcF4zbsAKrtt+nML8IHStpP0i2x8prwrqTbopz1i3n1VH0rVADqtgpMkG8Geydjzt9JOl5SS1GCl+RjKV48ryPpIEk/Uf3Wg/mSLpW0u6S2LH3apFYxfX+FanvOm3KG0Freh67aVoEpkp5VY3wt4rWUMX/OsJIGSTpE0n2FPObItxxvU0hXmmeFfoCMuZu7wwQRr0WrUT+6SN8pvSWNKzD9jyUdKWmapIvkOyPflbRzxG/NOmGzYr9M/N4v0ud7bZ6XdIqkccXy13ZHrvARgzKdOJ4HSRojabykLSV9XK6KjJYv8ORx/2jmzxivVdKNwaDLJJ0qaVAh7hfkqsrtkgYkZle9Hr9L5LO8wPAnSdo0i1dNWCs4Msk7UNJfSrow1ITZkl6T701/Xa4bvyjpR5LOkLS/pA3yfLrbATIpfXAw9QpJJ2b5tESnSPr/acHMn4/nFL65pPNVPy94NTpQzvBrPDpV6GMIBksMOFnSD7Xq/vPV4WlJMyWNz/JNTNbIPJmk/bryLcCSdE1KkzOnaurIMLk69IykIRE+Q9LLGS1LJV0mt9Hn6VPHrpi+v0P1k9WvaFW79uvyI3jXSvqOfBS4RG4SnCU/hpfjRUknSlovy7/TwpKVm5suT460CxUTzrLOkjHujIh/TtCU40lJh2Z5V9K9Qj1Us360STqvwEBPSDpO0jaShpWkbZE0QtIkSYfJJfXCLP0suQlxcF6eapPn5Klg1+hcknRqhJUya5Z+ROSfY4WkKyWNjbirtfdX6IfIpOc6kq7OGOgNSf+qkoUcdWH9iPDtJZ2l+lHgPklHKdOzszTbyY/vJUm9QZTRcMtIRvf+qk1gn5XPEXKrTurUFeNXcGRMPDQkdcKjknbN4jVcyJHq7Pt1klXSVpL+M5PkkvSSfLFouqR9JP2LfNIsuYly30jbnVXZZEI9vZLyFbqNTGqenzHmHaodnG7pSuoW8rLsr2hanCTpgkIHKMOxWbldMq3qR57i/pvKHl9hVeTMIl/gSa4yHpI0JsLzpf41XZAqjgDbyheOHpa0OGP41+QT4RapbsW1O8yf/3U7bYV+iIw5RqlmPpwtaVKErzVPATljZmHDJH1C0uHxt2WEl1p+KlRYK1Bt8ndEMP0SSdMirKXIqB+wrKIKtEqnkluT2opp1kb5FdYMfe4gSoGhPoMfrLgNP1rXBLTD2jtYEaeWLPJrT1I9PA/vBHwFmAi8L+lJ4H+Bh8ysI0tXocIHQ6bmDFTNBr5XhPW4M6RstDlI9fb+hPflq62jVe2jqbC2kDF+m6TfyPe3D/8w1AvVrC2T5C758snty4WOcFZK05M0VShHn1N1wJnfzJZKWgi8b2bvqOZPpidhocJ8CdgA91lzNnAl7rlgGDAZ+CawVcNcKlRYE6i2f2WmpMdVMAX2UJn5oZBHQ6qf0SDu1pL2+jBUrwr9CKrZ8LeQbzwbm4f3UJmJ8TcKlWa+pA2j07Wqtqe+NUtTHfvrJfRJ/TKzmLyAOzz9mw+x+HdxFeceM1tAeCLD/VJ2ACvTpNbMOiqrTu+gTzJ+IEnSi/ErbdZLHaJHCnOzZpOZLcJ9Ub4aZZmZqfDX0Ze8klX4E0OmfuytODjSw3p+UrH2kHR4T5dXYc1RthuxidoVjyqJm6wjHfDheNgKmlL5HWnRKKOr812Rpt5YJIpJa4uZLWvwPm/3Zhq0Z+RjQHtvqUSFdm5kGUtuCtt7o73XBKucFioyTSGu0vtsGO/I43aRvvtEdaPhUvkRf3U0lDo8LaOvrOyyfMvy6O4HTx05ufdLYTmNjRioLLxRWBlNXcVtFJ8G7VdCWzPU/HSWlZl+d8Ub+fs1oLVbdbZiImASsA3wS2B2FkfAUODTuE36Z8CKntRVs0aaAGyPT1RfKDTc4KCpA7gfWBLhVmSkYliDMpu6W6eyuGm9oKtOkK0prA98Evg9MIsYzSJOMzAV2ATf4jC/uzQVy29Up7I2SepaQZg0445mh1HzpLw4ngEGAAuBH/SUtC/SlYV12dbdyTgttR8dNujT47nztL58260kPZCFp0MRLSksS7du2LXb5G4y0u/R8lNIbRGWvxulcOeR5XVolHt5Cs9omhjvXpA0PE8Xv0dLWrfYgHIT44CMhuLRwfSXTJGtqj+321Qoo9su+bJ6bRW0P6dwMZLR1yLpl/F+2whrk2/F6FyFjngD07fIyli/hKZU5+J26la56XVooQ1SfVslnSv3NnGDpJ8HXffG813y7ditQWN+MizRl/hlYNAwUtLgaPuUrk2+yj4ko7XY1sPkJuOWElpzVyyJ9ubIt9NlI5Sv3L6J9+ppki4A/gA0h/52KC5ZX41NWEk/FX5lzMdwb7xvASOAq4AVuMQYDbyBm/s+huuLc4FBuOR7E7+GZihwJPAKtdFmUdC0p6TNI11r0DQtaJoPLImKdUg6AviroK1V0nLgUjO7M+J8Er+yfmGiUdIQ4Cbgv6jNc4YDN+C3hZxApl5JOgA4PMpA0vvAw8D1wJsqGdYL0mkxfpHyJGAf4Nb4JsvxDXbbRFsuivinxP+vB33tkfY4YKaZzZO0T7TfQGCFpKXAY8ClwHbA14DjzGxO1Pcfoy2W47ekzANujHqsoObF+eR0mYSk7YF7gcPMbF6ENQHHAFvH/ySZRwOnA/8ebX0lfr/WZ6N+i4ExwHs4f2wC/DOwFzDAzE7x7LVNhK8X9W6T9BDwbTN7L+pyCb5ifjDwdrT9UOA84ALgidRuZYw/Er8KpgU4xsz+TRJyFxZ7AnfhzAk1xtwIv2RgIrBDNMqyKPAdYHxU+Cj8MrENg4AFUdHrga8GYSPxjw21idSwePc+cIKZHSt3CzIO+Dx+jc14wnQo3wdzEHBypGsF9gAulzTTzK6IhpqEbx94PcrZJj7QXNwOL0nbRZ0mAP8BzAum3xP4FnAabr4E2Bm/aOHWrvTUDG34x/418E+Sbsd3eLbizHw3zkjJ4dQEYmjPOlNHtPvbkqbiDH4mcE+8mwxMA74bbb4TsDTKuAZnlJnAb/FOfiBwBPBIVk5yNT4AX5NYJ32XYPiBZrZE7nNoSzNbEUKxHRdmE+NbLsY7XytwdZS3Eu/w1wLX4bz0HC5klkW5U/Hb1q8Hvo13knHAqcAUSQfiKu5YvBMfaWZnh5R/Dxe0CfUjsepVnTslfU7uqGijCP+u/HzpyZLujbDkQeC0CD9N0p0Rlg9Pm8hVkc0pQK7avKzMN0wJTdMl/UzSbvK7WJNH4YuCrhmSnouwreUbxKaU5PdFSXNjeP2M/PB2WyHOHGVXW8qvvDxAfmTxzCzeCXLPZQOK5aT6q6YmDI7nQar37TM+2mVPubqTTKAHyv337Bt12SLC/1vSlYW23yJoa5X05Yg/vAFNu0n6bdBxgHwD39CSeMNUUx9y9S7RvbOktzK6kvr1dUk/Kny7EcFPfyZXd56UtHuhvEckHVIIu0bSRfH7LkmXldA5KL7XYfH8fbkrxrmSvhphAyL84zldZQtYK4ERZnYHPgwfGcz/OVzC5R96pVyP3AW4DDgHmChpx5CKbdEBBke65Bgpd8A0BB9dOt+V0NQBDDOz+/EJ7j/I/dlMC5qgprbtArxiZo+rdtQvnZH9ScTbAle5xgPXye90vVnST/HR7gdySbcLLs1uAc4HDohywdWBV4BZku6RdH984COjrGRJ2Aj4Ia46nIRLvtxgMBAfYa4AjpfPNY7HJeDv4n0aMZJJMUcy9Q6Jch4DHgya7pV7Tj5ONStYUk8/ATxsZotVmyO0yM8SLMry71x4y+jofJe+TzaqFQ/BJ5Nsit+CXy2U+KAF540kFNoifW46HQdcHfGTHt9mZktwI8tOEW8IPvoeCMyUNN3MllPPs4LGuzNT456BD/07AHeb2Vy5itB5a4Z8mNkZH/Lb8Q99LHAYbn/ukJQ3UEc8piG7o+RdGVLjnYnrcpsDj5rZ05L2oKZTLgBGShpoZssyJlwRkrAFVy/GAm/jzLIAZ8r1cXUu1W0GMFnSecAofMg+GLgodNu95BPPTfHhe3N8N+YbZnZLdOx3caYWrlIlnTlBuOpwOa5iXBXPF+OqWL6e0gQsD8ZojrZbEe8HmNlCYL+QbmPxTrMhrs4twNWZVP5CXD0FF3ZNZDeoJDWnmxaT3NbfHmmb4lum7Rp1G/IK31qEGVRSWqdJ9QWff4w1s4ckDUzlxLuNgMezfNYzswclfQG4QdI7uLpdV36ZxE+NCXA78CqwP3COavpeMnUNxvfBnIXr0k/jetcekra02k15aZ9Ko0ase6dVLSJpj4vhPfz5oOncCBM+kTNct10S75rMbGUw/Tr4nGOWmf0fPgr9Afiemd2Nm+sM+GI0/La4pDkbeAGft1wCHB3D+v6SvmxmT5nZHWb2fTM7L/Ick7Xvm2Z2g5n9j5ndW9IG7bjxYBHO/AcB18TzgLy98Q+4WUjgpcGkm+BzgLcl/YWkY8zsmaDpVjP7Dj7x3xj/ru343OImYIKko82s3cxWhLFgslyFHGmrbvHI5xVl3/MdvMOR8sMFxsh4V8c/1Dphnlcqoz37fT1whqTxZrYs+6ZfwoXytUHncnz+0mRmdwIzcEPFDvj8ojP/RpPbETGULA1p95KZPQUQDLR+SLMZuCpwep6B3LJwuqSDwxIwFLfy5PpkqvRgfJIztBCeY0TQNcTM3pV0IS49ZwWTpvRDzWxR9PbLgHvkx/1a8YvOXgeOjjzXiTzHSJpnZm9KOjfovg+fXP3KzC7O6nUzMAefiM8GjooR70WcyScDz+LqU530i3oVV50H4xP3dSLsRlwFSTcQDop6JZ39cvwj3453xoER/0ozWy7X16dL2h94CWeeycBr+EgyJeq9rpnNlvT3wLfkvn6eB9bFJ58/xSfZRYmf6E7tnez4qU43AYfI54BP4Pw1FfixmS2QtGG0+YiUDu+EI7I65gaNJKXPDdpuk/QwNYPJJOAoM3te7gVvFDA8OuxAM7sxRr9Toq0667CKrTkk3cbAffiMvIWaia0DvwB4vWicyUHcLGqjRwduHdkYl75LccvBVOAxM5tfkCKjcF3612b2irJFCdXMgZOiovfjlp3m+FseDbVDlPEAfvBE8snfZ4HNopznQuKmEWVz/DDIQ9Sk0RDgUzjTbIovLD1PrTM24epBh5k9EGXsjo8MzXgHuCcavuFCWKpj0LwjziSvxus2YHlI349FGz8KzI96jYl6DcPViMfN7LFUnnzythtuAWrF5yF3R8cYh1uJfo6b+zrkc7R9Ir/FwANmNidrp06rVPY9NgO2xVWM+dE+FjQPB/alZnZ81szui7yGA7sCz5ibU5vwzv0pfD7zbLSBRbwVwCPUDvhsh3f0VlxNvcvM3og6t+EWneeDj1pwXtwg0syK79lk2Yp52cepc5uhVb36NvrdVMynqzLKnleXpvC3Snlq4CRKDTyQpXzKyi22QRZeeoikq7zK8uyiXsX3Dc/nqrZg09W1QX9MO3Xp07MB3V3R17C+DfKyQlinJaw7tHbFG+l3aeUoWe7Pen3n0nH+u5BH2bJ3mjyV7a8ofVeMY/V7W0ppKqGj06JQrFNZntSku0WaIr15/VP80jK6g/igHUWpmtNYfE/93KysXnU0pXp0Uec8v9WeEejm92xEX3MxXT7KF8LKtijkPNudfFbLXxUq9Bv8P5yMG5b5h35SAAAAAElFTkSuQmCC"} alt="Matt Moras Music Tuition" style={{ width: "100%", maxWidth: 180, height: "auto", display: "block" }} />
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
            { id: "interruptions", icon: "🚧", label: "Interruptions" },
            { id: "schools", icon: "🏫", label: "Schools" },
            { id: "teachers", icon: "🎵", label: "Teachers" },
            { id: "contacts", icon: "📇", label: "Contacts" },
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
          {/* Digital clock + term day/week */}
          <div style={{ textAlign: "center", marginBottom: 12, userSelect: "none" }}>
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 43, fontWeight: 700, color: colors.white, letterSpacing: 2, lineHeight: 1 }}>
              {clockTime}
            </div>
          </div>
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
                  window.electronAPI.checkForUpdates().then(() => {
                    // If still no update after check, show flash
                    setTimeout(() => {
                      setUpdateInfo(prev => {
                        if (!prev || !prev.available) {
                          setNoUpdateFlash(true);
                          setTimeout(() => setNoUpdateFlash(false), 2500);
                        }
                        return prev;
                      });
                    }, 4000);
                  }).catch(() => {
                    setNoUpdateFlash(true);
                    setTimeout(() => setNoUpdateFlash(false), 2500);
                  });
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
          <button
            onClick={() => setShowApiKeyModal(true)}
            style={{ marginTop: 8, width: "100%", padding: "7px", background: "transparent",
              color: apiKey ? colors.success : colors.textLight, border: `1px solid ${apiKey ? colors.success : "rgba(255,255,255,0.15)"}`,
              borderRadius: 8, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
          >
            <span>{apiKey ? "🔑 API Key ✓" : "🔑 Set API Key"}</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div ref={mainScrollRef} data-printarea="true" style={{ flex: 1, overflow: "auto", position: "relative" }}>
        {/* Export Dialog */}
        {showApiKeyModal && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div style={{ background: "#fff", borderRadius: 12, padding: 28, width: 420, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
              <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 6 }}>🔑 Anthropic API Key</div>
              <div style={{ fontSize: 13, color: "#666", marginBottom: 16 }}>
                Required for AI features (notes parsing, Week Assistant). Get your key at{" "}
                <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{ color: "#C47A6A" }}>console.anthropic.com</a>.
                <br />Your key is stored only in this browser and never sent anywhere except Anthropic.
              </div>
              <input
                type="password"
                placeholder="sk-ant-..."
                defaultValue={apiKey}
                id="api-key-input"
                style={{ width: "100%", padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, fontSize: 14, boxSizing: "border-box", marginBottom: 16 }}
                onKeyDown={e => { if (e.key === "Enter") {
                  const val = document.getElementById("api-key-input").value.trim();
                  setApiKey(val);
                  try { localStorage.setItem("mt-api-key", val); } catch(e) {}
                  setShowApiKeyModal(false);
                }}}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setShowApiKeyModal(false)}
                  style={{ padding: "8px 16px", border: "1px solid #ddd", borderRadius: 8, background: "#fff", cursor: "pointer", fontSize: 14 }}>Cancel</button>
                <button onClick={() => {
                  const val = document.getElementById("api-key-input").value.trim();
                  setApiKey(val);
                  try { localStorage.setItem("mt-api-key", val); } catch(e) {}
                  setShowApiKeyModal(false);
                }} style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: "#C47A6A", color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 600 }}>Save</button>
              </div>
            </div>
          </div>
        )}

        {showExportDialog && (
          <ExportDialog
            lessons={timetable?.lessons || []}
            students={students}
            schools={schools}
            teachers={teachers}
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
          {page === "dashboard" && <Dashboard schools={schools} students={students} teachers={teachers} specialists={specialists} interruptions={interruptions} groups={groups} timetable={timetable} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} tallyEntries={tallyEntries} setTallyEntries={setTallyEntries} masterBreaks={masterBreaks} pendingCount={pendingStudents.length} onNavigate={setPage} chatMessages={chatMessages} setChatMessages={setChatMessages} chatInput={chatInput} setChatInput={setChatInput} errorLog={errorLog} logError={logError} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} onRestore={(data) => {
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
            notify("Data restored from backup!");
          }} notify={notify} />}
          {page === "schools" && <SchoolsManager schools={schools} setSchools={setSchools} notify={notify} resetKey={resetKey} viewState={schoolsViewState} setViewState={setSchoolsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "specialists" && <SpecialistManager specialists={specialists} setSpecialists={setSpecialists} schools={schools} notify={notify} resetKey={resetKey} viewState={specialistsViewState} setViewState={setSpecialistsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "interruptions" && <InterruptionsManager interruptions={interruptions} setInterruptions={setInterruptions} schools={schools} specialists={specialists} notify={notify} resetKey={resetKey} viewState={interruptionsViewState} setViewState={setInterruptionsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "students" && <StudentsManager students={students} setStudents={setStudents} schools={schools} teachers={teachers} specialists={specialists} notify={notify} focusStudentId={focusStudentId} onClearFocus={() => setFocusStudentId(null)} returnPage={focusReturnPage} onReturn={() => { if (focusReturnPage) { setPage(focusReturnPage); setFocusReturnPage(null); } }} resetKey={resetKey} viewState={studentsViewState} setViewState={setStudentsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "teachers" && <TeachersManager teachers={teachers} setTeachers={setTeachers} schools={schools} notify={notify} resetKey={resetKey} viewState={teachersViewState} setViewState={setTeachersViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "pending" && <PendingManager students={students} setStudents={setStudents} schools={schools} timetable={timetable} interruptions={interruptions} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} onSchedulePending={handleSchedulePending} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("pending"); setPage("students"); }} onManualSchedule={handleManualSchedule} notify={notify} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "groups" && <GroupsManager groups={groups} setGroups={setGroups} students={activeStudents} schools={schools} teachers={teachers} timetable={timetable} onRevertGroup={handleRevertGroup} onAddGroupToMaster={handleAddGroupToMaster} notify={notify} focusGroupId={focusGroupId} onClearFocusGroup={() => setFocusGroupId(null)} onReturn={() => { if (focusGroupReturnPage) { setPage(focusGroupReturnPage); setFocusGroupReturnPage(null); } }} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("groups"); setPage("students"); }} viewState={groupsViewState} setViewState={setGroupsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "timetable" && <TimetableView timetable={timetable} schools={schools} students={activeStudents} allStudents={students} teachers={teachers} setTeachers={setTeachers} specialists={specialists} pendingStudents={pendingStudents} masterBreaks={masterBreaks} setMasterBreaks={setMasterBreaks} viewState={ttViewState} setViewState={setTtViewState} sharedSchool={sharedSchool} setSharedSchool={setSharedSchool} onExport={handleExport} onPrint={() => printMasterTimetable(timetable, schools, students, teachers)} onGenerate={handleGenerateTimetable} onGenerateSchool={handleGenerateSchool} onClearSchool={handleClearSchool} onWarningsChange={(w, a) => { setTtConstraintWarnings(w); setTtAckedConstraints(a); }} initialConstraintWarnings={ttConstraintWarnings} initialAckedConstraints={ttAckedConstraints} onClear={() => { setTimetable(null); setGroups(prev => prev.map(g => g.status === "scheduled" ? { ...g, status: "forming" } : g)); notify("Timetable cleared"); }} onSchedulePending={handleSchedulePending} onMoveLesson={(lessonId, newDay, newTime) => {
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
          {page === "weekly" && <WeeklyAdjustments timetable={timetable} schools={schools} students={students} setStudents={setStudents} teachers={teachers} setTeachers={setTeachers} specialists={specialists} interruptions={interruptions} groups={groups} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} tallyEntries={tallyEntries} setTallyEntries={setTallyEntries} masterBreaks={masterBreaks} notify={notify} viewState={weeklyViewState} setViewState={setWeeklyViewState} sharedSchool={sharedSchool} setSharedSchool={setSharedSchool} onViewStudent={(studentId) => { setFocusStudentId(studentId); setFocusReturnPage("weekly"); setPage("students"); }} onViewGroup={(groupId) => { setFocusGroupId(groupId); setFocusGroupReturnPage("weekly"); setPage("groups"); }} logError={logError} onExport={handleExport} onUndo={undoWeekly} onRedo={redoWeekly} undoCount={weeklyUndoStack.current.length} redoCount={weeklyRedoStack.current.length} onWarningsChange={(w, a) => { setWeeklyConstraintWarnings(w); setWeeklyAckedConstraints(a); }} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "tally" && <TallyView timetable={timetable} schools={schools} students={students} teachers={teachers} interruptions={interruptions} tallyEntries={tallyEntries} setTallyEntries={setTallyEntries} weeklyTimetables={weeklyTimetables} setWeeklyTimetables={setWeeklyTimetables} notify={notify} onExport={handleExport} viewState={tallyViewState} setViewState={setTallyViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
          {page === "bands" && (
            <div>
              <PageTitle pageColor={PAGE_COLORS.groups}
                navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
                Bands
              </PageTitle>
              <EmptyState icon="🎸" title="Bands coming soon" subtitle="Bands are temporary groups of private students — with shared sessions, repertoire, and their own scheduling rules. This feature is in development." />
            </div>
          )}
          {page === "contacts" && <ContactsManager contacts={contacts} setContacts={setContacts} schools={schools} students={students} specialists={specialists} notify={notify} resetKey={resetKey} viewState={contactsViewState} setViewState={setContactsViewState} goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// REUSABLE UI COMPONENTS
// ============================================================
function Card({ children, style, onClick, ...rest }) {
  return (
    <div onClick={onClick} {...rest} style={{ background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 24, cursor: onClick ? "pointer" : undefined, ...style }}>
      {children}
    </div>
  );
}

const PAGE_COLORS = {
  dashboard: "#344565",
  schools: "#344565",
  specialists: "#344565",
  interruptions: "#344565",
  students: "#344565",
  teachers: "#344565",
  groups: "#344565",
  pending: "#344565",
  timetable: "#344565",
  weekly: "#344565",
  tally: "#344565",
  contacts: "#344565",
};

function PageTitle({ children, subtitle, action, pageColor, navButtons }) {
  const bg = pageColor || colors.sidebarActive;
  return (
    <div style={{
      marginLeft: -36, marginRight: -36, marginTop: -28,
      marginBottom: 20,
      position: "sticky", top: 0, zIndex: 50,
      background: bg,
      borderBottom: `1px solid ${colors.border}`,
      minHeight: HEADER_HEIGHT, boxSizing: "border-box",
    }}>
      <div style={{ padding: "0 36px", minHeight: HEADER_HEIGHT, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, fontFamily: "'DM Sans', sans-serif", margin: 0, color: colors.white, lineHeight: 1.1, textTransform: "uppercase", whiteSpace: "nowrap" }}>{children}</h1>
          {subtitle && (
            <span style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 13, fontWeight: 500,
              color: "rgba(255,255,255,0.55)",
              lineHeight: 1, marginTop: 3,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              display: "block", whiteSpace: "nowrap",
            }}>
              {subtitle}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          {action && <ActionBar>{action}</ActionBar>}
          {navButtons}
        </div>
      </div>
    </div>
  );
}

function NavButtons({ goBack, goForward, historyCursor, pageHistory }) {
  const btnStyle = (disabled) => ({
    height: 28, padding: "0 4px", border: "none", borderRadius: 4,
    background: "none",
    color: disabled ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.8)",
    cursor: disabled ? "default" : "pointer", fontSize: 22, fontFamily: "inherit",
    display: "inline-flex", alignItems: "center", lineHeight: 1,
  });
  return (
    <div style={{ display: "flex", gap: 2 }}>
      <button onClick={goBack} disabled={historyCursor <= 0} style={btnStyle(historyCursor <= 0)} title="Back">‹</button>
      <button onClick={goForward} disabled={historyCursor >= pageHistory.length - 1} style={btnStyle(historyCursor >= pageHistory.length - 1)} title="Forward">›</button>
    </div>
  );
}

function ActionBar({ children }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
      {children}
    </div>
  );
}

function FrozenCard({ children, style }) {
  return (
    <>
      {/* Fixed card — always visible at same screen position below the banner */}
      <div style={{ position: "fixed", top: HEADER_HEIGHT + 13, left: 240, right: 0, zIndex: 40, padding: "0 36px 0" }}>
        <Card style={{ ...style, padding: 14, marginBottom: 0 }}>{children}</Card>
      </div>
      {/* Invisible spacer — keeps the same space in document flow so content below doesn't jump up */}
      <div style={{ visibility: "hidden", padding: "0 0 16px" }}>
        <Card style={{ ...style, padding: 14, marginBottom: 0 }}>{children}</Card>
      </div>
    </>
  );
}

function Btn({ children, onClick, variant = "primary", style, disabled }) {
  const base = {
    height: 34, padding: "0 16px", border: "2px solid transparent", borderRadius: 8, fontSize: 13,
    fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
    transition: "all 0.15s", opacity: disabled ? 0.5 : 1, display: "inline-flex",
    alignItems: "center", gap: 6, boxSizing: "border-box", flexShrink: 0, marginTop: -2
  };
  const variants = {
    primary: { background: colors.accent, color: colors.white },
    secondary: { background: colors.tagBg, color: colors.text, borderColor: colors.border },
    danger: { background: "#FEE", color: colors.danger, borderColor: "#FCC" },
    success: { background: "#EFE", color: colors.success, borderColor: "#CEC" },
    ghost: { background: "transparent", color: colors.textLight }
  };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...style }}>{children}</button>;
}

function Input({ label, value, onChange, type = "text", placeholder, style, options, multiline }) {
  const inputStyle = {
    width: "100%", padding: "9px 12px", border: `1px solid ${colors.inputBorder}`,
    borderRadius: 8, fontSize: 14, fontFamily: "inherit", background: colors.inputBg,
    color: colors.text, outline: "none", boxSizing: "border-box",
    transition: "border-color 0.15s"
  };

  return (
    <div style={{ marginBottom: 14, ...style }}>
      {label && <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</label>}
      {options ? (
        <select value={value} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
          <option value="">Select...</option>
          {options.map(o => <option key={typeof o === "string" ? o : o.value} value={typeof o === "string" ? o : o.value}>{typeof o === "string" ? o : o.label}</option>)}
        </select>
      ) : multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={3} style={{ ...inputStyle, resize: "vertical" }} />
      ) : (
        <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />
      )}
    </div>
  );
}

function Tag({ children, color = colors.accent, onRemove }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      background: color + "18", color: color, fontSize: 12, fontWeight: 600,
      padding: "3px 10px", borderRadius: 6, margin: "2px 4px 2px 0"
    }}>
      {children}
      {onRemove && <span onClick={onRemove} style={{ cursor: "pointer", marginLeft: 2, opacity: 0.7 }}>×</span>}
    </span>
  );
}

function EmptyState({ icon, title, subtitle, action, onAction }) {
  return (
    <div style={{ textAlign: "center", padding: "60px 20px", color: colors.textMuted }}>
      <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.5 }}>{icon}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: colors.textLight, marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 14, marginBottom: 24, maxWidth: 400, margin: "0 auto 24px" }}>{subtitle}</div>
      {action && <Btn onClick={onAction}>{action}</Btn>}
    </div>
  );
}

function FileUpload({ onData, accept = ".csv,.xlsx,.xls", label = "Import Spreadsheet" }) {
  const ref = useRef(null);
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.name.endsWith(".csv")) {
      window.Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => onData(results.data, file.name)
      });
    } else {
      // Excel files
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const XLSX = await getXLSX();
          const wb = XLSX.read(ev.target.result, { type: "binary" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
          onData(data, file.name);
        } catch (err) {
          console.error("Excel parse error:", err);
        }
      };
      reader.readAsBinaryString(file);
    }
    e.target.value = "";
  };

  return (
    <>
      <input ref={ref} type="file" accept={accept} onChange={handleFile} style={{ display: "none" }} />
      <Btn variant="secondary" onClick={() => ref.current?.click()}>📁 {label}</Btn>
    </>
  );
}

function Checkbox({ label, checked, onChange }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer", marginBottom: 8 }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: colors.accent, width: 16, height: 16 }} />
      {label}
    </label>
  );
}

// ============================================================
// WEEK AHEAD (Dashboard) + UI HELPERS
// ============================================================
function ChatActionCard({ actions, dismissed, onToggleDismiss, onApply, onDismissAll }) {
  const activeActions = actions.filter((_, ai) => !dismissed.has(ai));
  const actionLabel = (act) => {
    if (act.action === "cancel") return `Cancel ${act.studentName} (${act.instrument}) on ${act.day}`;
    if (act.action === "tally_miss") return `Tally: ${act.studentName} (${act.instrument}) — ${act.tallyReason || "missed"}${act.makeupEligible ? " (makeup owed)" : ""}`;
    if (act.action === "tally_remove") {
      const reasonLabel = act.reason === "extended_absence" ? "Extended Absence" : "Removed – Not Charged";
      const target = act.scope === "school" ? (act.schoolName || "school") : (act.studentName || "student");
      return `Tally remove (${reasonLabel}): ${target} — ${(act.weekKeys || []).length} week${(act.weekKeys || []).length !== 1 ? "s" : ""}`;
    }
    if (act.action === "move") return `Move ${act.studentName} (${act.instrument}) ${act.fromDay || act.day || "?"} ${act.fromTime || ""} → ${act.toDay || "?"} ${act.toTime || ""}`;
    if (act.action === "teacher_swap") return `Swap teacher for ${act.studentName} (${act.instrument}) on ${act.day} → ${act.replacementTeacherName}`;
    if (act.action === "batch_cancel") return `Batch cancel: ${[act.className, act.instrument, act.teacherName].filter(Boolean).join(", ")} on ${act.day}`;
    if (act.action === "create_catchup") return `Makeup: ${act.studentName} (${act.instrument}) on ${act.day} at ${act.time || "?"}`;
    if (act.action === "generate_week") return `Generate week +${act.weekOffset || 0}${act.schoolName ? " for " + act.schoolName : " (all schools)"}`;
    return act.action;
  };
  const actionIcon = (act) => {
    if (act.action === "cancel" || act.action === "batch_cancel") return <span style={{ color: "#DC2626" }}>✗</span>;
    if (act.action === "tally_miss") return <span>📊</span>;
    if (act.action === "tally_remove") return <span style={{ color: "#6B7280" }}>—</span>;
    if (act.action === "teacher_swap") return <span style={{ color: "#C47A6A" }}>⇄</span>;
    if (act.action === "create_catchup") return <span style={{ color: "#2563EB" }}>↺</span>;
    if (act.action === "generate_week") return <span style={{ color: "#059669" }}>📅</span>;
    return <span style={{ color: "#C47A6A" }}>→</span>;
  };
  return (
    <div style={{ marginTop: 10, padding: "10px 12px", background: "#F0F8F0", border: "1px solid #CEC", borderRadius: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 12, color: "#16A34A", marginBottom: 8 }}>Suggested changes:</div>
      {actions.map((act, ai) => {
        const isDismissed = dismissed.has(ai);
        return (
          <div key={ai} style={{ fontSize: 12, color: isDismissed ? "#9CA3AF" : "#374151", marginBottom: 4, display: "flex", gap: 6, alignItems: "center", textDecoration: isDismissed ? "line-through" : "none" }}>
            {actionIcon(act)}
            <span style={{ flex: 1 }}>{actionLabel(act)}{act.reason ? ` — ${act.reason}` : ""}</span>
            <button onClick={() => onToggleDismiss(ai)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: isDismissed ? "#2563EB" : "#9CA3AF", fontWeight: 600, padding: "0 4px", fontFamily: "inherit" }} title={isDismissed ? "Re-include" : "Skip this"}>
              {isDismissed ? "undo" : "skip"}
            </button>
          </div>
        );
      })}
      <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center" }}>
        <Btn variant="success" onClick={() => onApply(activeActions)} style={{ fontSize: 12 }} disabled={activeActions.length === 0}>
          ✓ Apply {activeActions.length < actions.length ? `${activeActions.length} selected` : "changes"}
        </Btn>
        <Btn variant="ghost" onClick={onDismissAll} style={{ fontSize: 12 }}>Dismiss all</Btn>
        {activeActions.length < actions.length && <span style={{ fontSize: 11, color: "#6B7280" }}>{actions.length - activeActions.length} skipped</span>}
      </div>
    </div>
  );
}

function ErrorLogPanel({ errorLog }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ marginTop: 16 }}>
      <button onClick={() => setOpen(o => !o)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#9CA3AF", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4, padding: 0 }}>
        <span style={{ color: "#EF4444", fontWeight: 700 }}>⚠</span>
        {errorLog.length} recent error{errorLog.length > 1 ? "s" : ""}
        <span style={{ fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 6, borderRadius: 8, border: "1px solid #FCA5A5", background: "#FFF5F5", padding: "8px 12px", maxHeight: 180, overflowY: "auto" }}>
          {errorLog.map(e => (
            <div key={e.id} style={{ fontSize: 11, color: "#7F1D1D", marginBottom: 6, lineHeight: 1.4 }}>
              <span style={{ color: "#9CA3AF", marginRight: 6 }}>{new Date(e.ts).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <strong>{e.message}</strong>
              {e.detail && <span style={{ color: "#B91C1C", marginLeft: 4 }}>— {e.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Dashboard({ schools, students, teachers, specialists, interruptions, groups, timetable, weeklyTimetables, setWeeklyTimetables, tallyEntries, setTallyEntries, masterBreaks, pendingCount, onNavigate, onRestore, chatMessages, setChatMessages, chatInput, setChatInput, errorLog, logError, notify, goBack, goForward, historyCursor, pageHistory }) {
  const activeStudents = students.filter(s => s.status === "active");
  const fileRef = useRef(null);

  const chatEndRef = useRef(null);
  const chatInputRef = useRef(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [dismissedActions, setDismissedActions] = useState({}); // msgIndex -> Set of action indices
  const [hintIdx, setHintIdx] = useState(0);
  const [hintVisible, setHintVisible] = useState(true);
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);
  const [hoveredDay, setHoveredDay] = useState(null);

  // Current week calculation
  const today = melbourneNow();
  const monday = getCurrentWeekMonday();
  const todayStr = toLocalDateStr(today);
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
          const lessonCount = timetable ? timetable.lessons.filter(l => l.teacherId === teacher.id && l.schoolId === school.id && l.day === wd.day).length : 0;
          teacherSchools.push({ teacher, school, start: avail.start, end: avail.end, lessonCount });
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
    if (!missedByStudent[k]) missedByStudent[k] = { studentName: e.studentName, instrument: e.instrument, schoolName: schools.find(s => s.id === e.schoolId)?.name || "", count: 0 };
    missedByStudent[k].count++;
  }
  const missedList = Object.values(missedByStudent).filter(m => m.count >= 2);

  // Unacknowledged timetable warnings
  const unschedCount = timetable ? timetable.unscheduled.length : 0;

  // Listen for Electron menu backup trigger (Cmd+Shift+B)
  React.useEffect(() => {
    const handler = () => handleBackup();
    window.addEventListener("electron-manual-backup", handler);
    return () => window.removeEventListener("electron-manual-backup", handler);
  });

  const handleBackup = async () => {
    const ttVersions = await loadData(STORAGE_KEYS.timetableVersions, []);
    const backup = {
      version: DATA_VERSION, exportedAt: new Date().toISOString(),
      schools, students, teachers, specialists, interruptions, groups,
      timetable, weeklyTimetables, tallyEntries, timetableVersions: ttVersions
    };
    const json = JSON.stringify(backup, null, 2);
    const defaultName = "timetabling-backup-" + melbourneToday() + ".json";
    if (window.electronAPI) {
      // Electron: native save dialog — user chooses location
      const result = await window.electronAPI.saveFileDialog(defaultName, json);
      if (result.ok) {
        notify("Backup saved to " + result.filePath.split("/").pop());
      }
    } else {
      // Browser fallback: trigger download
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = defaultName;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify("Backup downloaded!");
    }
  };

  const handleRestoreFile = async (e) => {
    // Electron: use native file dialog instead of hidden input
    if (window.electronAPI) {
      const result = await window.electronAPI.openFileDialog();
      if (!result.ok) return;
      try {
        const data = JSON.parse(result.json);
        if (!data.schools && !data.students) throw new Error("Not a valid backup file");
        if (onRestore) onRestore(data);
      } catch (err) {
        notify("Invalid backup file: " + err.message, "danger");
      }
      return;
    }
    // Browser fallback: hidden file input
    const file = e?.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.schools && !data.students) throw new Error("Not a valid backup file");
        if (onRestore) onRestore(data);
      } catch (err) {
        if (notify) notify("Invalid backup file: " + err.message, "danger");
      }
    };
    reader.readAsText(file);
    if (e?.target) e.target.value = "";
  };

  // Rotating hint chips
  const DASH_HINTS = [
    "Where am I on Monday?",
    "Which students have missed 2+ lessons?",
    "What if I'm sick Thursday?",
    "Who has makeups owed?",
    "Which students have cancelled this term?",
    "No lessons this week",
    "No lessons at [school] until week 4",
    "Remove [student] from tally this week",
    "[Student] on holidays weeks 5–7",
    "[Student] hasn't started yet — remove weeks 1–3",
    "Extended absence for [student] — holding their place",
    "No catch up needed",
  ];
  useEffect(() => {
    if (chatMessages.length > 0) return;
    const id = setInterval(() => {
      setHintVisible(false);
      setTimeout(() => {
        setHintIdx(i => (i + 1) % DASH_HINTS.length);
        setHintVisible(true);
      }, 800);
    }, 4500);
    return () => clearInterval(id);
  }, [chatMessages.length]);

  // Build context for AI assistant
  const buildContext = () => {
    const weekStr = weekDates.map(wd => `${wd.day} ${wd.dayNum} ${wd.month}`).join(", ");
    const todayLabel = `${todayDayName} ${weekDates.find(w => w.date === todayStr)?.dayNum || ""} ${weekDates.find(w => w.date === todayStr)?.month || ""}`;

    // Teacher schedules for the week
    const teacherSummaries = teachers.map(t => {
      const avails = t.availability.map(a => {
        const school = schools.find(s => s.id === a.schoolId);
        return `${a.day} at ${school?.name || "?"} (${a.start}–${a.end})`;
      }).join("; ");
      const lessonCount = timetable ? timetable.lessons.filter(l => l.teacherId === t.id).length : 0;
      return `${t.name}: ${avails} (${lessonCount} total lessons)`;
    }).join("\n");

    // This week's lessons by school and day
    const thisWeekKey = toLocalDateStr(monday);
    let lessonSummary = "No timetable generated yet.";
    if (timetable) {
      const bySchoolDay = {};
      for (const l of timetable.lessons) {
        const k = `${l.schoolName}|${l.day}`;
        if (!bySchoolDay[k]) bySchoolDay[k] = [];
        bySchoolDay[k].push(l);
      }
      lessonSummary = Object.entries(bySchoolDay).map(([k, ls]) => {
        const [schoolName, day] = k.split("|");
        const summary = ls.map(l => `${l.start} ${l.isGroup ? (l.groupName || "Group") + " (group, " + l.instrument + ")" : l.studentName + " (" + l.instrument + ")"} [teacher: ${l.teacherName}]`).join(", ");
        return `${schoolName} ${day}: ${ls.length} lessons — ${summary}`;
      }).join("\n");
    }

    // Upcoming weeks — which ones have been generated
    const upcomingWeeksStatus = [0, 1, 2, 3].map(offset => {
      const m = getCurrentWeekMonday();
      m.setDate(m.getDate() + offset * 7);
      const wk = toLocalDateStr(m);
      const label = offset === 0 ? "This week" : offset === 1 ? "Next week" : `+${offset} weeks`;
      const generated = schools.filter(s => weeklyTimetables[`${wk}|${s.id}`]).map(s => s.name);
      return `${label} (${wk}): ${generated.length === 0 ? "not generated" : generated.join(", ") + " generated"}`;
    }).join("\n");

    // Current weekly timetable adjustments for this week
    let weeklyAdjSummary = "No weekly timetables generated for this week yet.";
    const thisWeekEntries = schools.map(s => ({ school: s, entry: weeklyTimetables[`${thisWeekKey}|${s.id}`] })).filter(x => x.entry);
    if (thisWeekEntries.length > 0) {
      weeklyAdjSummary = thisWeekEntries.map(({ school, entry }) => {
        const adjustedLessons = (entry.lessons || []).filter(l => l.adjusted);
        const missedLessonsW = entry.missed || [];
        const adjustedStr = adjustedLessons.length > 0
          ? adjustedLessons.map(l => `  • ${l.studentName} (${l.instrument}) ${l.day} ${l.start} — ${l.adjustReason || "adjusted"}`).join("\n")
          : "  (none)";
        const missedStr = missedLessonsW.length > 0
          ? missedLessonsW.map(l => `  • ${l.studentName} (${l.instrument}) ${l.day} — ${l.reason || "missed"}`).join("\n")
          : "  (none)";
        return `${school.name} (generated ${new Date(entry.generatedAt).toLocaleString()}):\nAdjusted:\n${adjustedStr}\nMissed/cancelled:\n${missedStr}`;
      }).join("\n\n");
    }

    // Groups / ensembles
    const groupSummary = groups && groups.length > 0
      ? groups.filter(g => g.status === "scheduled").map(g => {
          const school = schools.find(s => s.id === g.schoolId);
          const teacher = teachers.find(t => t.id === g.teacherId);
          const memberNames = (g.studentIds || []).map(sid => students.find(s => s.id === sid)?.name || "?").join(", ");
          return `${g.name} (${g.instrument}, ${g.day || "?"} ${g.start || ""}–${g.end || ""}) at ${school?.name || "?"}, teacher: ${teacher?.name || "?"}, members: ${memberNames}`;
        }).join("\n")
      : "No scheduled groups.";

    // Tally summary — makeup owed, students with consecutive misses
    const makeupOwed = tallyEntries.filter(e => e.status === "missed" && e.makeupEligible && !e.madeUp);
    const makeupSummary = makeupOwed.length > 0
      ? makeupOwed.map(e => `${e.studentName} (${e.instrument}) — missed week of ${e.weekKey || "?"}`).join("\n")
      : "None";
    // Students with 3+ consecutive misses (using tallyEntries)
    const missByStudent = {};
    for (const e of tallyEntries) {
      if (e.status === "missed") {
        const k = `${e.studentId}|${e.instrument}`;
        if (!missByStudent[k]) missByStudent[k] = { name: e.studentName, instrument: e.instrument, count: 0 };
        missByStudent[k].count++;
      }
    }
    const frequentMissers = Object.values(missByStudent).filter(x => x.count >= 3).map(x => `${x.name} (${x.instrument}): ${x.count} misses`).join("\n") || "None";

    // Interruptions this week
    const weekIntrs = interruptions.filter(intr => {
      const start = intr.date;
      const end = intr.endDate || intr.date;
      return weekDates.some(wd => wd.date >= start && wd.date <= end);
    }).map(i => `${i.title} (${i.date}${i.endDate && i.endDate !== i.date ? "–" + i.endDate : ""}) affects: ${i.affectsClasses || "all"}`).join("\n") || "None";

    // Student details
    const studentSummary = activeStudents.map(s => {
      const school = schools.find(sc => sc.id === s.schoolId);
      const teacher = s.instruments && s.instruments[0] && s.instruments[0].teacherId ? teachers.find(t => t.id === s.instruments[0].teacherId) : null;
      const insts = s.instruments.map(i => i.name).join(", ");
      return `${s.name}: ${school?.name || "?"}, class ${s.className || "?"}, ${insts}, teacher: ${teacher?.name || "unassigned"}${s.notes ? `, notes: "${s.notes}"` : ""}${s.outsideClassOnly ? ", outside class only" : ""}`;
    }).join("\n");

    // Term weeks — for tally_remove actions
    const dashTermBreaks = interruptions.filter(i => i.type === "term_break")
      .reduce((acc, i) => { if (!acc.find(x => x.date === i.date)) acc.push(i); return acc; }, [])
      .sort((a, b) => a.date.localeCompare(b.date));
    const dashYear = melbourneNow().getFullYear();
    const dashTerm1Start = (() => { const s = new Date(dashYear, 0, 27); while (s.getDay() !== 2) s.setDate(s.getDate() + 1); return s; })();
    let dashTermStart = new Date(dashTerm1Start);
    let dashTermWeeks = [];
    let dashWNum = 1;
    const dashTermEnd = (() => {
      const breaks = dashTermBreaks.filter(tb => new Date(tb.date + "T00:00:00").getFullYear() === dashYear);
      let ts = new Date(dashTerm1Start);
      for (const tb of breaks) {
        const bs = new Date(tb.date + "T00:00:00");
        if (bs > ts) { const be = new Date((tb.endDate || tb.date) + "T00:00:00"); ts = new Date(be); ts.setDate(ts.getDate() + 1); while (ts.getDay() === 0 || ts.getDay() === 6) ts.setDate(ts.getDate() + 1); }
      }
      const ye = new Date(dashYear, 11, 18); while (ye.getDay() === 0 || ye.getDay() === 6) ye.setDate(ye.getDate() - 1); return ye;
    })();
    const dashNow = melbourneNow();
    // Find current term start
    let dashCurTermStart = new Date(dashTerm1Start);
    for (const tb of dashTermBreaks) {
      const bs = new Date(tb.date + "T00:00:00");
      const be = new Date((tb.endDate || tb.date) + "T00:00:00");
      if (bs <= dashNow && be >= dashCurTermStart) { dashCurTermStart = new Date(be); dashCurTermStart.setDate(dashCurTermStart.getDate() + 1); while (dashCurTermStart.getDay() === 0 || dashCurTermStart.getDay() === 6) dashCurTermStart.setDate(dashCurTermStart.getDate() + 1); }
    }
    let ww = new Date(dashCurTermStart); const dow = ww.getDay(); ww.setDate(ww.getDate() + (dow === 0 ? -6 : 1 - dow)); ww.setHours(0,0,0,0);
    while (ww <= dashTermEnd) {
      const wk = toLocalDateStr(ww); const fri = new Date(ww); fri.setDate(fri.getDate() + 4);
      const inBrk = dashTermBreaks.some(tb => wk >= tb.date && toLocalDateStr(fri) <= (tb.endDate || tb.date));
      if (!inBrk) dashTermWeeks.push({ weekNum: dashWNum, weekKey: wk });
      dashWNum++; ww = new Date(ww); ww.setDate(ww.getDate() + 7);
    }
    const termWeeksSummary = dashTermWeeks.map(w => "W" + w.weekNum + "=" + w.weekKey).join(", ");

    return `You are an AI scheduling assistant for a music lesson timetabling app. The user is Matt Moras, who is both the app administrator and one of the teachers. When he says "I" or "my", he means himself as teacher Matt Moras. You help manage weekly adjustments — handling absences, swaps, and rescheduling.

IMPORTANT: You SUGGEST changes but never apply them directly. Present options with clear trade-offs. Be concise and practical.

TODAY: ${todayLabel}
THIS WEEK: ${weekStr}

TEACHERS:
${teacherSummaries}

STUDENT ROSTER (${activeStudents.length} active):
${studentSummary}

THIS WEEK'S LESSON SCHEDULE:
${lessonSummary}

INTERRUPTIONS THIS WEEK:
${weekIntrs}

GROUPS / ENSEMBLES:
${groupSummary}

WEEKLY TIMETABLE STATUS (next 4 weeks):
${upcomingWeeksStatus}

THIS WEEK'S ADJUSTMENTS (already applied in Weekly tab):
${weeklyAdjSummary}

MAKEUP LESSONS OWED:
${makeupSummary}

STUDENTS WITH 3+ TOTAL MISSES:
${frequentMissers}

SCHOOLS:
${schools.map(s => `${s.name}: days ${(s.days || DAYS).join(", ")}, slots: ${(s.slots || []).map(sl => sl.start + "–" + sl.end + " (" + sl.type + ")").join(", ")}`).join("\n")}

CURRENT TERM WEEKS (week number = Monday date):
${termWeeksSummary}

When the conversation is FRESH (first message of the day or user asks "what do I need to know" / "what's on today" / "briefing" / "summary"), proactively lead with:
- Any interruptions today or this week that haven't been acted on
- Students with 3+ consecutive misses or outstanding makeups
- Any days where a teacher has an unusually heavy or light load
- Any pending/trial students not yet scheduled
Keep the briefing concise — bullet points, no waffle.

When the user reports an issue (absence, swap request, schedule conflict), respond with:
1. A brief analysis of the impact
2. Suggested solutions with trade-offs (which students are affected, what slots are free, etc.)
3. If relevant, flag students who have already missed recent lessons

When the user APPROVES a suggestion (says yes, go ahead, do it, apply, etc.), output a structured action block that the app can parse. Format:

[ACTIONS]
[
  {"action": "cancel", "studentName": "Full Name", "instrument": "Guitar", "day": "Wednesday", "schoolName": "School Name", "reason": "Teacher unavailable"},
  {"action": "move", "studentName": "Full Name", "instrument": "Piano", "fromDay": "Wednesday", "fromTime": "10:00", "toDay": "Thursday", "toTime": "10:30", "schoolName": "School Name", "reason": "Rescheduled due to teacher absence"},
  {"action": "tally_miss", "studentName": "Full Name", "instrument": "Guitar", "day": "Wednesday", "schoolName": "School Name", "tallyReason": "school_interruption", "makeupEligible": true, "notes": "Labour Day — makeup required"}
]
[/ACTIONS]

Rules for actions:
- Use the EXACT student full name, instrument name, school name, day name, and time (HH:MM) from the data above
- "cancel" removes the lesson for this week and marks it as missed. Fields: studentName, instrument, day, schoolName, reason
- "move" changes the lesson's day and/or time for this week only. Fields: studentName, instrument, fromDay, fromTime, toDay, toTime, schoolName, reason
- "teacher_swap" reassigns a lesson to a different teacher for this week only. Fields: studentName, instrument, day, schoolName, replacementTeacherName, reason. Use when a teacher is unavailable and another teacher can cover.
- "batch_cancel" cancels all lessons matching a class, instrument, or teacher on a given day — useful for camps, excursions, whole-class absences. Fields: schoolName, day, className (optional), instrument (optional), teacherName (optional), reason. At least one filter required.
- "create_catchup" schedules a makeup lesson for a student. Fields: studentName, instrument, day, time, schoolName, reason. Only use when the student has a makeup owed (check MAKEUP LESSONS OWED above).
- "generate_week" generates the standard weekly timetable for a future week. Fields: weekOffset (integer — number of weeks from current week, e.g. 1 = next week, 2 = week after), schoolName (optional — omit to generate all schools), force (optional boolean — set true to regenerate if already exists). Use when the user asks to "set up next week", "generate week 8", "prepare week X", etc.
- "tally_miss" records a missed lesson in the Tally tab. ALWAYS include a "tally_miss" action alongside every "cancel" action. Set tallyReason: "school_interruption" for holidays/excursions/camps/assemblies; "teacher_absent" if teacher away; "informed_absence" if student notified; "uninformed_absence" if no notice; "other" otherwise. makeupEligible is true for "school_interruption" and "teacher_absent", false for uninformed_absence, and user's choice for others.
- A single instruction can produce both a "cancel" and a "tally_miss" for the same lesson
- "tally_remove" removes lesson slots from the tally entirely across one or more weeks — they won't be counted or chased up. Use for delayed term starts (school not running lessons yet), student cancellations, and extended absences. Fields: reason ("removed_not_charged" or "extended_absence"), scope ("school" or "student"), schoolName (if scope=school), studentName (if scope=student), instrument (optional — omit to remove all instruments for that student), weekKeys (array of weekKey date strings from CURRENT TERM WEEKS above). Use "removed_not_charged" for delayed starts and cancellations; "extended_absence" when fees are still being charged and a place is held. Example: {"action":"tally_remove","reason":"removed_not_charged","scope":"school","schoolName":"Solway Primary","weekKeys":["2026-01-27","2026-02-03","2026-02-10"]}
- Only output [ACTIONS] when the user has explicitly approved. When just suggesting, describe the changes in plain text.
- Include a brief confirmation message before the action block

Keep responses short and actionable. Use student and teacher first names where unambiguous.

After every response, suggest 2–4 relevant follow-up actions or replies as a JSON array of short strings:

[QUICKREPLIES]
["Yes, apply that", "No, leave it", "Show me other options"]
[/QUICKREPLIES]

Choose quick replies that make sense given the context — e.g. approval/rejection buttons when you've made a suggestion, option selections when you've listed options, or common follow-ups like "What about next week?" or "Who else is affected?". Always include them — they should be short (2–5 words each).`;
  };

  // Ensure weekly timetable exists for a school, generating from master if needed
  // Returns the entry synchronously so applyActions can use it immediately
  const ensureWeeklyTimetable = (schoolId) => {
    const weekKey = toLocalDateStr(monday);
    const storageKey = `${weekKey}|${schoolId}`;
    if (weeklyTimetables[storageKey]) return weeklyTimetables[storageKey];

    // Generate from master
    if (!timetable) return null;
    const school = schools.find(s => s.id === schoolId);
    if (!school) return null;

    const dashMasterBreaks = (masterBreaks || []).filter(b => b.schoolId === school.id);
    const result = generateWeeklyTimetable(
      timetable.lessons, school, students, teachers, specialists, interruptions, weekDates, [], dashMasterBreaks
    );
    const entry = { lessons: result.lessons, missed: result.missed, notes: "", generatedAt: new Date().toISOString() };
    setWeeklyTimetables(prev => ({ ...prev, [storageKey]: entry }));
    return entry; // return directly so caller can use it without waiting for state update
  };

  // Apply structured actions from the AI
  const applyActions = (actions, msgIndex) => {
    const weekKey = toLocalDateStr(monday);
    let totalApplied = 0;
    const newTallyEntries = [];

    // Compute current term key once for all tally entries
    const termBreaksSorted = interruptions
      .filter(i => i.type === "term_break")
      .reduce((acc, i) => { if (!acc.find(x => x.date === i.date)) acc.push(i); return acc; }, [])
      .sort((a, b) => a.date.localeCompare(b.date));
    const _getT1 = (y) => { const s = new Date(y, 0, 27); while (s.getDay() !== 2) s.setDate(s.getDate() + 1); return s; };
    const _now = melbourneNow(); const _year = _now.getFullYear();
    let currentTermKey = null;
    for (const y of [_year - 1, _year, _year + 1]) {
      let tStart = _getT1(y);
      const yBreaks = termBreaksSorted.filter(tb => new Date(tb.date + "T00:00:00").getFullYear() === y);
      let tNum = 1;
      for (const tb of yBreaks) {
        const bs = new Date(tb.date + "T00:00:00");
        const be = new Date((tb.endDate || tb.date) + "T00:00:00");
        if (bs > tStart) {
          const te = new Date(bs); te.setDate(te.getDate() - 1);
          if (_now >= tStart && _now <= te) { currentTermKey = `${y}-T${tNum}`; break; }
          tNum++;
          tStart = new Date(be); tStart.setDate(tStart.getDate() + 1);
          while (tStart.getDay() === 0 || tStart.getDay() === 6) tStart.setDate(tStart.getDate() + 1);
        }
      }
      if (!currentTermKey && _now >= tStart) currentTermKey = `${y}-T${tNum}`;
      if (currentTermKey) break;
    }

    // Build a mutable snapshot of weekly timetables so multi-action batches work
    // even before React re-renders
    let wtSnapshot = { ...weeklyTimetables };

    for (const act of actions) {
      const school = schools.find(s => s.name === act.schoolName);
      if (!school) { notify(`School not found: ${act.schoolName}`, "warning"); continue; }
      const storageKey = `${weekKey}|${school.id}`;

      // Ensure entry exists in snapshot
      if (!wtSnapshot[storageKey]) {
        const fresh = ensureWeeklyTimetable(school.id);
        if (!fresh) { notify(`Could not generate timetable for ${act.schoolName}`, "warning"); continue; }
        wtSnapshot[storageKey] = fresh;
      }

      if (act.action === "cancel") {
        const entry = wtSnapshot[storageKey];
        const lesson = entry.lessons.find(l =>
          l.studentName === act.studentName &&
          l.instrument === act.instrument &&
          l.day === act.day
        );
        if (!lesson) { notify(`Lesson not found: ${act.studentName} on ${act.day}`, "warning"); continue; }
        totalApplied++;
        const missed = { ...lesson, reason: act.reason || "Cancelled by assistant" };
        wtSnapshot[storageKey] = {
          ...entry,
          lessons: entry.lessons.filter(l => l !== lesson),
          missed: [...(entry.missed || []), missed]
        };

        // Auto-create tally entry for every cancel — don't rely on AI to include tally_miss
        // Skip if the AI already included an explicit tally_miss for this student/day
        const hasTallyAction = actions.some(a =>
          a.action === "tally_miss" &&
          a.studentName === act.studentName &&
          a.instrument === act.instrument &&
          a.day === act.day
        );
        if (!hasTallyAction) {
          const reason = act.reason?.toLowerCase() || "";
          const tallyReason = reason.includes("holiday") || reason.includes("excursion") || reason.includes("camp") || reason.includes("assembly") || reason.includes("interruption")
            ? "school_interruption"
            : reason.includes("teacher") ? "teacher_absent"
            : reason.includes("absent") || reason.includes("sick") ? "informed_absence"
            : "school_interruption"; // default for AI-generated cancels
          const makeupEligible = tallyReason !== "absent";
          newTallyEntries.push({
            id: uid(),
            lessonKey: lesson.isGroup ? `group|${lesson.groupId}` : `${lesson.studentId}|${lesson.instrument}`,
            lessonId: lesson.id,
            isGroup: lesson.isGroup || false, groupName: lesson.groupName || "",
            studentId: lesson.studentId || "", studentName: lesson.studentName,
            instrument: lesson.instrument, schoolId: school.id,
            teacherId: lesson.teacherId, teacherName: lesson.teacherName,
            weekKey, termKey: currentTermKey,
            day: lesson.day,
            status: "missed", reason: tallyReason,
            notes: act.reason || "",
            makeupEligible, madeUp: false,
            recordedAt: new Date().toISOString(), recordedBy: "weekly_assistant",
          });
        }
      } else if (act.action === "move") {
        const fromDay = act.fromDay || act.day;
        const fromTime = act.fromTime || act.time;
        const toDay = act.toDay || act.targetDay;
        const toTime = act.toTime || act.targetTime;
        const entry = wtSnapshot[storageKey];
        const lesson = entry.lessons.find(l =>
          l.studentName === act.studentName &&
          l.instrument === act.instrument &&
          l.day === fromDay
        );
        if (!lesson) { notify(`Lesson not found to move: ${act.studentName} on ${fromDay}`, "warning"); continue; }
        const newSlot = school.slots.find(s => s.start === toTime);
        if (!newSlot) { notify(`Slot not found: ${toTime}`, "warning"); continue; }
        totalApplied++;
        const dayDate = weekDates.find(wd => wd.day === toDay);
        wtSnapshot[storageKey] = {
          ...entry,
          lessons: entry.lessons.map(l => l === lesson ? {
            ...l, day: toDay, start: newSlot.start, end: newSlot.end,
            slotId: newSlot.id, slotName: newSlot.name,
            weekDate: dayDate?.date || l.weekDate,
            adjusted: true, adjustReason: act.reason || "Moved by assistant"
          } : l)
        };
      } else if (act.action === "tally_miss") {
        if (!currentTermKey) { notify("Tally: couldn't determine current term", "warning"); continue; }
        const lesson = timetable?.lessons.find(l =>
          l.studentName === act.studentName &&
          l.instrument === act.instrument &&
          l.schoolId === school.id
        );
        if (!lesson) { notify(`Tally: lesson not found for ${act.studentName}`, "warning"); continue; }
        const lessonKey = lesson.isGroup ? `group|${lesson.groupId}` : `${lesson.studentId}|${lesson.instrument}`;
        const makeupEligible = act.makeupEligible !== undefined ? act.makeupEligible
          : (act.tallyReason === "school_interruption" || act.tallyReason === "teacher_absent");
        newTallyEntries.push({
          id: uid(), lessonKey, lessonId: lesson.id,
          isGroup: lesson.isGroup || false, groupName: lesson.groupName || "",
          studentId: lesson.studentId || "", studentName: act.studentName,
          instrument: lesson.instrument, schoolId: school.id,
          teacherId: lesson.teacherId, teacherName: lesson.teacherName,
          weekKey, termKey: currentTermKey,
          day: act.day || lesson.day,
          status: "missed", reason: act.tallyReason || "school_interruption",
          notes: act.notes || act.reason || "",
          makeupEligible, madeUp: false,
          recordedAt: new Date().toISOString(), recordedBy: "weekly_assistant",
        });
        totalApplied++;

      } else if (act.action === "tally_remove") {
        if (!currentTermKey) { notify("Tally remove: couldn't determine current term", "warning"); continue; }
        if (!timetable) continue;
        const reasonVal = (act.reason === "extended_absence") ? "extended_absence" : "removed_not_charged";
        const weekKeysToRemove = Array.isArray(act.weekKeys) ? act.weekKeys : [];
        if (weekKeysToRemove.length === 0) continue;
        // Match lessons
        let matchLessons = timetable.lessons;
        if (act.scope === "school" && act.schoolName) {
          const sc = schools.find(s => s.name.toLowerCase().includes((act.schoolName || "").toLowerCase().split(" ")[0]));
          if (sc) matchLessons = matchLessons.filter(l => l.schoolId === sc.id);
          else { notify("tally_remove: school not found: " + act.schoolName, "warning"); continue; }
        } else if (act.scope === "student" && act.studentName) {
          const nameLower = (act.studentName || "").toLowerCase();
          matchLessons = matchLessons.filter(l => {
            const n = (l.isGroup ? (l.groupName || "") : (l.studentName || "")).toLowerCase();
            return n.includes(nameLower) || nameLower.includes(n.split(" ")[0]);
          });
          if (act.instrument) matchLessons = matchLessons.filter(l => (l.instrument || "").toLowerCase() === act.instrument.toLowerCase());
        }
        // Deduplicate to lessonKey level
        const seenKeys = new Set();
        const uniqueLessons = [];
        for (const l of matchLessons) {
          const lk = l.isGroup ? "group|" + l.groupId : l.studentId + "|" + l.instrument;
          if (!seenKeys.has(lk)) { seenKeys.add(lk); uniqueLessons.push({ ...l, lessonKey: lk }); }
        }
        for (const row of uniqueLessons) {
          for (const wk of weekKeysToRemove) {
            newTallyEntries.push({
              id: uid(), lessonKey: row.lessonKey, lessonId: row.id,
              isGroup: row.isGroup || false, groupName: row.groupName || "",
              studentId: row.studentId || "",
              studentName: row.isGroup ? (row.groupName || row.studentNames?.join(", ") || "Group") : row.studentName,
              studentNames: row.studentNames || [],
              instrument: row.instrument, schoolId: row.schoolId,
              teacherId: row.teacherId, teacherName: row.teacherName,
              weekKey: wk, termKey: currentTermKey, day: row.day,
              status: "removed", reason: reasonVal,
              notes: "", makeupEligible: false, madeUp: false,
              recordedAt: new Date().toISOString(), recordedBy: "week_assistant",
            });
            totalApplied++;
          }
        }

      } else if (act.action === "teacher_swap") {
        // Reassign a lesson to a different teacher for this week
        const entry = wtSnapshot[storageKey];
        const lesson = entry?.lessons.find(l =>
          l.studentName === act.studentName &&
          l.instrument === act.instrument &&
          l.day === act.day
        );
        if (!lesson) { notify(`teacher_swap: lesson not found for ${act.studentName} on ${act.day}`, "warning"); continue; }
        const replacement = teachers.find(t => {
          const tn = t.name.toLowerCase();
          const rn = (act.replacementTeacherName || "").toLowerCase();
          return tn.includes(rn) || rn.includes(tn.split(" ")[0]);
        });
        if (!replacement) { notify(`teacher_swap: teacher not found: ${act.replacementTeacherName}`, "warning"); continue; }
        wtSnapshot[storageKey] = {
          ...entry,
          lessons: entry.lessons.map(l => l === lesson
            ? { ...l, teacherId: replacement.id, teacherName: replacement.name, adjusted: true, adjustReason: `Teacher: ${replacement.name}` }
            : l)
        };
        totalApplied++;

      } else if (act.action === "batch_cancel") {
        // Cancel all lessons matching className, instrument, or teacherName on a day
        const entry = wtSnapshot[storageKey];
        if (!entry) { notify(`batch_cancel: no weekly timetable for ${act.schoolName}`, "warning"); continue; }
        const toCancel = entry.lessons.filter(l => {
          if (l.day !== act.day) return false;
          if (act.teacherName) {
            const tn = l.teacherName?.toLowerCase() || "";
            const an = act.teacherName.toLowerCase();
            if (!tn.includes(an) && !an.includes(tn.split(" ")[0])) return false;
          }
          if (act.instrument) {
            if ((l.instrument || "").toLowerCase() !== act.instrument.toLowerCase()) return false;
          }
          if (act.className) {
            const student = students.find(s => s.id === l.studentId);
            const cn = (student?.className || "").toLowerCase();
            const acn = act.className.toLowerCase();
            if (!cn.includes(acn) && !acn.includes(cn)) return false;
          }
          return true;
        });
        if (toCancel.length === 0) { notify(`batch_cancel: no matching lessons on ${act.day}`, "warning"); continue; }
        const cancelledIds = new Set(toCancel.map(l => l.id));
        wtSnapshot[storageKey] = {
          ...entry,
          lessons: entry.lessons.filter(l => !cancelledIds.has(l.id)),
          missed: [...(entry.missed || []), ...toCancel.map(l => ({ ...l, reason: act.reason || "Batch cancelled" }))]
        };
        // Auto-tally each cancelled lesson
        if (currentTermKey) {
          for (const lesson of toCancel) {
            const lessonKey = lesson.isGroup ? `group|${lesson.groupId}` : `${lesson.studentId}|${lesson.instrument}`;
            const tallyReason = (act.reason || "").toLowerCase().includes("teacher") ? "teacher_absent" : "school_interruption";
            newTallyEntries.push({
              id: uid(), lessonKey, lessonId: lesson.id,
              isGroup: lesson.isGroup || false, groupName: lesson.groupName || "",
              studentId: lesson.studentId || "", studentName: lesson.studentName,
              instrument: lesson.instrument, schoolId: school.id,
              teacherId: lesson.teacherId, teacherName: lesson.teacherName,
              weekKey, termKey: currentTermKey, day: lesson.day,
              status: "missed", reason: tallyReason,
              notes: act.reason || "",
              makeupEligible: true, madeUp: false,
              recordedAt: new Date().toISOString(), recordedBy: "weekly_assistant",
            });
          }
        }
        totalApplied += toCancel.length;

      } else if (act.action === "create_catchup") {
        // Schedule a makeup lesson card in the weekly timetable
        const entry = wtSnapshot[storageKey];
        if (!entry) { notify(`create_catchup: no weekly timetable for ${act.schoolName}`, "warning"); continue; }
        const student = students.find(s => s.name === act.studentName || s.name.toLowerCase().includes((act.studentName || "").toLowerCase()));
        if (!student) { notify(`create_catchup: student not found: ${act.studentName}`, "warning"); continue; }
        const oldest = tallyEntries.filter(e =>
          e.studentId === student.id &&
          (!act.instrument || e.instrument === act.instrument) &&
          e.status === "missed" && e.makeupEligible && !e.madeUp
        ).sort((a, b) => (a.weekKey || "").localeCompare(b.weekKey || ""))[0];
        if (!oldest) { notify(`create_catchup: no makeup owed for ${act.studentName}`, "warning"); continue; }
        const newLesson = {
          id: uid(), studentId: student.id, studentName: student.name,
          schoolId: school.id, schoolName: school.name,
          instrument: oldest.instrument, teacherId: oldest.teacherId || "", teacherName: oldest.teacherName || "",
          day: act.day, start: act.time || "09:00", end: act.time || "09:00",
          isMakeup: true, makeupForTallyId: oldest.id,
          adjusted: true, adjustReason: act.reason || "Makeup lesson"
        };
        wtSnapshot[storageKey] = {
          ...entry,
          lessons: [...(entry.lessons || []), newLesson]
        };
        setTallyEntries(prev => prev.map(e => e.id !== oldest.id ? e : { ...e, madeUp: true, madeUpWeekKey: weekKey }));
        totalApplied++;

      } else if (act.action === "generate_week") {
        // Generate the weekly timetable for a future week offset
        const offsetWeeks = act.weekOffset || 0;
        const targetMonday = getCurrentWeekMonday();
        targetMonday.setDate(targetMonday.getDate() + offsetWeeks * 7);
        const targetDates = DAYS.map((day, d) => {
          const date = new Date(targetMonday);
          date.setDate(targetMonday.getDate() + d);
          return { day, date: toLocalDateStr(date), dateObj: date };
        });
        const targetWeekKey = targetDates[0].date;
        const targetDateMap = {};
        for (const wd of targetDates) targetDateMap[wd.day] = wd.date;
        const targetSchools = act.schoolName
          ? schools.filter(s => s.name === act.schoolName || s.name.toLowerCase().includes((act.schoolName || "").toLowerCase()))
          : schools;
        const dashMasterBreaks = masterBreaks || [];
        for (const targetSchool of targetSchools) {
          const sk = `${targetWeekKey}|${targetSchool.id}`;
          if (wtSnapshot[sk] && !act.force) { notify(`Week of ${targetWeekKey} already generated for ${targetSchool.name}`, "warning"); continue; }
          const result = generateWeeklyTimetable(
            timetable.lessons, targetSchool, students, teachers, specialists, interruptions,
            targetDates, [], dashMasterBreaks.filter(b => b.schoolId === targetSchool.id)
          );
          wtSnapshot[sk] = { lessons: result.lessons, missed: result.missed, notes: "", generatedAt: new Date().toISOString() };
          totalApplied++;
        }
      }
    }

    // Flush snapshot to state in one update
    setWeeklyTimetables(wtSnapshot);

    if (newTallyEntries.length > 0) {
      setTallyEntries(prev => {
        const updated = [...prev];
        for (const entry of newTallyEntries) {
          const idx = updated.findIndex(e => e.lessonKey === entry.lessonKey && e.weekKey === entry.weekKey);
          if (idx >= 0) updated[idx] = entry; else updated.push(entry);
        }
        return updated;
      });
    }

    // Mark actions as applied in the message
    setChatMessages(prev => prev.map((m, i) => i === msgIndex ? { ...m, actionsApplied: true } : m));
    notify(`Applied ${totalApplied} change${totalApplied !== 1 ? "s" : ""} to weekly timetable`);
  };

  // Parse [ACTIONS] blocks from AI response
  const parseActions = (text) => {
    const match = text.match(/\[ACTIONS\]\s*([\s\S]*?)\s*\[\/ACTIONS\]/);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch(e) {
      return null;
    }
  };

  // Parse [QUICKREPLIES] blocks from AI response
  const parseQuickReplies = (text) => {
    const match = text.match(/\[QUICKREPLIES\]\s*([\s\S]*?)\s*\[\/QUICKREPLIES\]/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[1]);
      return Array.isArray(parsed) ? parsed : null;
    } catch(e) {
      return null;
    }
  };

  const getDisplayText = (text) => {
    return text
      .replace(/\[ACTIONS\][\s\S]*?\[\/ACTIONS\]/, "")
      .replace(/\[QUICKREPLIES\][\s\S]*?\[\/QUICKREPLIES\]/, "")
      .trim();
  };

  const sendQuickReply = (text) => {
    setChatInput("");
    const userMsg = { role: "user", content: text };
    // Dismiss quick replies on all previous messages
    setChatMessages(prev => [
      ...prev.map(m => ({ ...m, quickReplies: undefined })),
      userMsg
    ]);
    setChatLoading(true);
    (async () => {
      try {
        const systemPrompt = buildContext();
        const history = [...chatMessages.map(m => ({ ...m, quickReplies: undefined })), userMsg]
          .map(m => ({ role: m.role, content: m.content }));
        const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: getAnthropicHeaders(),
          body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 2000, system: systemPrompt, messages: history })
        });
        const data = await response.json();
        const text2 = data.content?.map(c => c.text || "").join("\n") || "Sorry, I couldn't process that.";
        const actions = parseActions(text2);
        const quickReplies = parseQuickReplies(text2) || (actions ? ["Yes, apply changes", "No, dismiss"] : null);
        setChatMessages(prev => [...prev, { role: "assistant", content: text2, actions: actions || undefined, quickReplies: quickReplies || undefined }]);
      } catch (err) {
        if (logError) logError("Week Assistant (quick reply) error", err.message);
        setChatMessages(prev => [...prev, { role: "assistant", content: "Error: " + err.message }]);
      } finally {
        setChatLoading(false);
      }
    })();
  };

  const sendChat = async () => {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;
    setChatInput("");
    const userMsg = { role: "user", content: msg };
    setChatMessages(prev => [...prev, userMsg]);
    setChatLoading(true);

    try {
      const systemPrompt = buildContext();
      const history = [...chatMessages, userMsg].map(m => ({ role: m.role, content: m.content }));

      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          system: systemPrompt,
          messages: history
        })
      });

      const data = await response.json();
      const text = data.content?.map(c => c.text || "").join("\n") || "Sorry, I couldn't process that.";
      const actions = parseActions(text);
      const quickReplies = parseQuickReplies(text) || (actions ? ["Yes, apply changes", "No, dismiss"] : null);
      setChatMessages(prev => [...prev, { role: "assistant", content: text, actions: actions || undefined, quickReplies: quickReplies || undefined }]);
    } catch (err) {
      if (logError) logError("Week Assistant error", err.message);
      setChatMessages(prev => [...prev, { role: "assistant", content: "Error: " + err.message }]);
    } finally {
      setChatLoading(false);
      // auto-scroll removed — user scrolls manually
    }
  };

  return (
    <div>
      <PageTitle subtitle={todayDayName} pageColor={PAGE_COLORS.dashboard} navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{getTermWeekLabel(todayStr, interruptions.filter(i => i.type === "term_break")).toUpperCase()}</PageTitle>
      {/* AI Week Assistant */}
      <Card style={{ marginBottom: 20, padding: 0, overflow: "hidden" }}>
        <div style={{ background: colors.sidebarActive, padding: "10px 16px", borderRadius: "12px 12px 0 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: colors.white }}>Claude</div>
          {chatMessages.length > 0 && (
            <Btn variant="ghost" onClick={() => setChatMessages([])} style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", padding: "2px 8px" }}>Clear chat</Btn>
          )}
        </div>
        <div style={{ padding: "14px 18px" }}>

        {/* Chat messages */}
        <div style={{
          maxHeight: chatMessages.length > 0 ? 400 : 0,
          overflowY: "auto",
          marginBottom: chatMessages.length > 0 ? 12 : 0,
          borderRadius: 8,
          border: chatMessages.length > 0 ? `1px solid ${colors.border}` : "none",
          background: chatMessages.length > 0 ? colors.white : "transparent",
          transition: "max-height 0.3s"
        }}>
          {chatMessages.map((msg, i) => (
            <div key={i} style={{
              padding: "10px 14px",
              background: msg.role === "user" ? colors.sidebarActive + "0A" : colors.white,
              borderBottom: i < chatMessages.length - 1 ? `1px solid ${colors.border}` : "none",
              fontSize: 13, lineHeight: 1.6
            }}>
              <div style={{ fontWeight: 600, fontSize: 11, color: msg.role === "user" ? colors.sidebarActive : colors.accent, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {msg.role === "user" ? "You" : "Claude"}
              </div>
              <div style={{ whiteSpace: "pre-wrap", color: colors.text }}>{msg.role === "assistant" ? getDisplayText(msg.content) : msg.content}</div>
              {msg.actions && msg.actions.length > 0 && !msg.actionsApplied && (
                <ChatActionCard
                  actions={msg.actions}
                  dismissed={dismissedActions[i] || new Set()}
                  onToggleDismiss={(ai) => setDismissedActions(prev => {
                    const next = { ...prev };
                    const s = new Set(prev[i] || []);
                    if (s.has(ai)) s.delete(ai); else s.add(ai);
                    next[i] = s;
                    return next;
                  })}
                  onApply={(activeActions) => { applyActions(activeActions, i); setDismissedActions(prev => { const next = {...prev}; delete next[i]; return next; }); }}
                  onDismissAll={() => { setChatMessages(prev => prev.map((m, mi) => mi === i ? { ...m, actionsApplied: true } : m)); setDismissedActions(prev => { const next = {...prev}; delete next[i]; return next; }); }}
                />
              )}
              {msg.actionsApplied && msg.actions && (
                <div style={{ marginTop: 6, fontSize: 11, color: colors.success, fontWeight: 600 }}>
                  ✓ Applied — {[
                    msg.actions.filter(a => a.action === "cancel").length > 0 && `${msg.actions.filter(a => a.action === "cancel").length} cancelled`,
                    msg.actions.filter(a => a.action === "batch_cancel").length > 0 && `batch cancel (${msg.actions.filter(a => a.action === "batch_cancel").length})`,
                    msg.actions.filter(a => a.action === "move").length > 0 && `${msg.actions.filter(a => a.action === "move").length} moved`,
                    msg.actions.filter(a => a.action === "teacher_swap").length > 0 && `${msg.actions.filter(a => a.action === "teacher_swap").length} teacher swap`,
                    msg.actions.filter(a => a.action === "create_catchup").length > 0 && `${msg.actions.filter(a => a.action === "create_catchup").length} makeup scheduled`,
                    msg.actions.filter(a => a.action === "tally_miss").length > 0 && `${msg.actions.filter(a => a.action === "tally_miss").length} added to tally`
                  ].filter(Boolean).join(", ")}
                </div>
              )}
              {/* Quick reply buttons — only on last assistant message and not loading */}
              {msg.role === "assistant" && msg.quickReplies && msg.quickReplies.length > 0 && i === chatMessages.length - 1 && !chatLoading && (
                <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {msg.quickReplies.map((reply, ri) => (
                    <button key={ri} onClick={() => sendQuickReply(reply)}
                      style={{ padding: "6px 14px", borderRadius: 20, border: `1.5px solid ${colors.accent}`, background: "#fff", color: colors.accent, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "background 0.15s" }}
                      onMouseEnter={e => { e.target.style.background = colors.accentLight; }}
                      onMouseLeave={e => { e.target.style.background = "#fff"; }}>
                      {reply}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {chatLoading && (
            <div style={{ padding: "10px 14px", fontSize: 13, color: colors.textMuted, fontStyle: "italic" }}>
              Thinking...
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Input */}
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1, position: "relative" }}>
            <input
              ref={chatInputRef}
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
              placeholder=""
              style={{
                width: "100%", padding: "10px 14px", boxSizing: "border-box",
                border: `1px solid ${colors.inputBorder}`,
                borderRadius: 8, fontSize: 13, fontFamily: "inherit",
                background: colors.inputBg, color: colors.text, outline: "none"
              }}
            />
            {chatMessages.length === 0 && !chatInput && (
              <div style={{
                position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                padding: "10px 14px", fontSize: 13, fontFamily: "inherit",
                color: colors.textMuted, pointerEvents: "none",
                opacity: hintVisible ? 1 : 0, transition: "opacity 0.7s ease",
                whiteSpace: "nowrap", overflow: "hidden",
              }}>
                {"\u201C"}{DASH_HINTS[hintIdx]}{"\u201D"}
              </div>
            )}
          </div>
          <Btn onClick={sendChat} disabled={chatLoading || !chatInput.trim()}>
            {chatLoading ? "..." : "Send"}
          </Btn>
        </div>
        </div>
      </Card>

      {/* Alerts banner */}
      {(unschedCount > 0 || missedList.length > 0 || pendingCount > 0) && (
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          {unschedCount > 0 && (
            <div onClick={() => onNavigate("timetable")} style={{ padding: "8px 14px", background: "#FEF2F2", border: "1px solid #FCC", borderRadius: 8, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: colors.danger, fontWeight: 600 }}>⚠ {unschedCount} unscheduled</span>
              <span style={{ color: colors.textMuted }}>in master timetable</span>
            </div>
          )}
          {missedList.length > 0 && (
            <div onClick={() => onNavigate("weekly")} style={{ padding: "8px 14px", background: "#FEF6F0", border: "1px solid #FED7AA", borderRadius: 8, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#D97706", fontWeight: 600 }}>📋 {missedList.length} student{missedList.length > 1 ? "s" : ""}</span>
              <span style={{ color: colors.textMuted }}>missed 2+ lessons recently</span>
            </div>
          )}
          {pendingCount > 0 && (
            <div onClick={() => onNavigate("pending")} style={{ padding: "8px 14px", background: "#F0F4FE", border: "1px solid rgba(52,69,101,0.25)", borderRadius: 8, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: colors.blue600, fontWeight: 600 }}>⏳ {pendingCount} pending</span>
              <span style={{ color: colors.textMuted }}>on waiting list</span>
            </div>
          )}
        </div>
      )}

      {/* ── Term progress bar ── */}
      {(() => {
        const termBreaksForDash = interruptions.filter(i => i.type === "term_break");
        const currentLabel = getTermWeekLabel(todayStr, termBreaksForDash);
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

      {/* ── Week calendar strip ── */}
      {(() => {
        const TEACHER_CHIP_COLORS = ["#5B7FA6","#4A9B6E","#7B5EA7","#C47A6A","#3D7A8A","#A0522D","#6B7280","#B06090"];
        const teacherColorMap = {};
        teachers.forEach((t, i) => { teacherColorMap[t.id] = TEACHER_CHIP_COLORS[i % TEACHER_CHIP_COLORS.length]; });
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
          const dayTeacherSchools = [];
          for (const teacher of teachers) {
            for (const avail of teacher.availability.filter(a => a.day === wd.day)) {
              const school = schools.find(s => s.id === avail.schoolId);
              if (school) dayTeacherSchools.push({ teacher, school });
            }
          }
          const bySchool = {};
          for (const { teacher, school } of dayTeacherSchools) {
            if (!bySchool[school.id]) bySchool[school.id] = { school, teachers: [] };
            bySchool[school.id].teachers.push(teacher);
          }
          const schoolGroups = Object.values(bySchool);
          return (
            <div key={wd.date}
              onMouseEnter={() => setHoveredDay(wd.day)}
              onMouseLeave={() => setHoveredDay(null)}
              style={{
                borderRadius: 10,
                border: "2px solid " + (isActive ? colors.sidebarActive : "transparent"),
                outline: isActive ? "none" : "1px solid " + colors.border,
                outlineOffset: -1,
                background: isTermBreak ? "#F5F0FF" : isActive ? "#E8EDF5" : colors.white,
                padding: "8px 10px",
                transition: "border-color 0.15s, background 0.15s", cursor: "default",
              }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: isActive ? colors.sidebarActive : colors.textLight, textTransform: "uppercase", letterSpacing: "0.05em" }}>{wd.day.slice(0, 3)}</span>
                <span style={{ fontSize: 11, color: isActive ? colors.sidebarActive : colors.textMuted }}>{wd.dayNum}{isToday ? " ●" : ""}</span>
              </div>
              {isTermBreak ? (
                <div style={{ fontSize: 9, fontWeight: 700, color: "#7C3AED", letterSpacing: "0.03em" }}>School Holidays</div>
              ) : (
                <>
                  {dayInterrupts.length > 0 && (
                    <div style={{ marginBottom: 4 }}>
                      {dayInterrupts.slice(0, 2).map((intr, ii) => (
                        <div key={ii} style={{ fontSize: 9, background: "#FEF3C7", color: "#92400E", borderRadius: 3, padding: "1px 4px", marginBottom: 2, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{intr.title}</div>
                      ))}
                    </div>
                  )}
                  {schoolGroups.length === 0 ? (
                    <div style={{ fontSize: 9, color: colors.textMuted, fontStyle: "italic" }}>No lessons</div>
                  ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {schoolGroups.map(({ school, teachers: ts }) => (
                    <div key={school.id} style={{ display: "flex", alignItems: "center", gap: 3, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 9, color: colors.textMuted, fontWeight: 600, flexShrink: 0 }}>{school.name.split(" ").filter(w => /^[A-Z]/.test(w)).map(w => w[0]).join("") || school.name.slice(0, 4).toUpperCase()}</span>
                      {ts.map(t => (
                        <span key={t.id} style={{ fontSize: 9, fontWeight: 700, color: "#fff", background: teacherColorMap[t.id], borderRadius: 3, padding: "1px 4px" }}>
                          {t.name.split(" ").map(w => w[0]).join("")}
                        </span>
                      ))}
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
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <button onClick={() => setCalendarWeekOffset(o => o - 1)}
                style={{ background: "none", border: "none", cursor: "pointer", color: colors.sidebarActive, fontWeight: 700, fontSize: 18, padding: "0 4px", lineHeight: 1 }}>‹</button>
              <button onClick={() => setCalendarWeekOffset(o => o + 1)}
                style={{ background: "none", border: "none", cursor: "pointer", color: colors.sidebarActive, fontWeight: 700, fontSize: 18, padding: "0 4px", lineHeight: 1 }}>›</button>
              <span style={{ fontSize: 12, fontWeight: 600, color: colors.textMuted, letterSpacing: "0.05em", marginLeft: 4 }}>
                {calWeekLabel}{calendarWeekOffset === 0 ? " (this week)" : calendarWeekOffset === 1 ? " (next week)" : calendarWeekOffset === -1 ? " (last week)" : ""}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(" + stripDays.length + ", 1fr)", gap: 6 }}>
              {stripDays.map(wd => renderDayCell(wd))}
            </div>
          </div>
        );
      })()}

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
                            <div style={{ fontWeight: 600, marginBottom: 2 }}>🏫 {gs.school.name}</div>
                            <div style={{ color: colors.textLight }}>
                              {gs.teachers.map(t => t.teacher.name.split(" ")[0]).join(", ")}
                              <span style={{ marginLeft: 6, fontWeight: 600, color: colors.text }}>{gs.totalLessons} lessons</span>
                            </div>
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
      <Card style={{ marginTop: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>Data Backup</div>
            <div style={{ fontSize: 13, color: colors.textLight, marginTop: 4 }}>
              Download all your data as a JSON file, or restore from a previous backup.
            </div>
            <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
              {localStorage.getItem(STORAGE_KEYS.lastScheduledBackup) ? (
                <span>⏱ Auto-backup: {new Date(localStorage.getItem(STORAGE_KEYS.lastScheduledBackup)).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
              ) : (
                <span style={{ color: colors.amber }}>⚠ No scheduled backup yet — runs at 4:00am daily</span>
              )}
              {window.electronAPI && (
                <span style={{ color: colors.gray500 }}>
                  📁 Folder: <span
                    style={{ cursor: "pointer", textDecoration: "underline" }}
                    onClick={async () => { const f = await window.electronAPI.getBackupFolder(); window.electronAPI.revealInFinder(f); }}
                  >Open in Finder</span>
                </span>
              )}
              {localStorage.getItem("mt-last-autobak-time") && (
                <span>💾 Last in-app save: {new Date(localStorage.getItem("mt-last-autobak-time")).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}</span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={handleBackup}>💾 Download Backup</Btn>
            <Btn variant="secondary" onClick={() => window.electronAPI ? handleRestoreFile() : fileRef.current?.click()}>📂 Restore from File</Btn>
            {!window.electronAPI && <input ref={fileRef} type="file" accept=".json" onChange={handleRestoreFile} style={{ display: "none" }} />}
          </div>
        </div>
      </Card>

      {/* Error Log — subtle collapsible */}
      {errorLog && errorLog.length > 0 && <ErrorLogPanel errorLog={errorLog} />}

      <div style={{ textAlign: "center", padding: "16px 0 4px", fontSize: 11, color: colors.textMuted }}>
        Timetabling v{APP_VERSION}
      </div>
    </div>
  );
}

// ============================================================
// SPECIALIST TIMETABLE MANAGER
// ============================================================
function SpecialistManager({ specialists, setSpecialists, schools, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const filterSchool = (viewState || {}).filterSchool || "";
  const setFilterSchool = (v) => setViewState(prev => ({ ...prev, filterSchool: v }));
  const filterClass = (viewState || {}).filterClass || "";
  const setFilterClass = (v) => setViewState(prev => ({ ...prev, filterClass: v }));
  const filterDay = (viewState || {}).filterDay || "";
  const setFilterDay = (v) => setViewState(prev => ({ ...prev, filterDay: v }));
  const filterSubject = (viewState || {}).filterSubject || "";
  const setFilterSubject = (v) => setViewState(prev => ({ ...prev, filterSubject: v }));
  const [importMode, setImportMode] = useState(null);
  const [importInstructions, setImportInstructions] = useState("");
  const [importSchoolId, setImportSchoolId] = useState("");
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [importError, setImportError] = useState(null);
  const [updateSchoolId, setUpdateSchoolId] = useState(null); // schoolId being updated
  const [schoolBannerOpen, setSchoolBannerOpen] = useState({}); // schoolId -> bool
  const [schoolBannerMode, setSchoolBannerMode] = useState({}); // schoolId -> "all"|"day"|"class"
  const filterBarRef = React.useRef(null);
  const [filterBarHeight, setFilterBarHeight] = useState(0);
  const [updateInstructions, setUpdateInstructions] = useState("");
  const [updateUrl, setUpdateUrl] = useState(""); // optional URL to fetch
  const [diffPreview, setDiffPreview] = useState(null); // { schoolId, added, removed, changed, schoolName }
  const [diffAccepted, setDiffAccepted] = useState({}); // changeKey -> true/false
  const fileRef = useRef(null);
  const updateFileRef = useRef(null);

  useEffect(() => { setEditing(null); setForm(null); setImportMode(null); setPreview(null); setUpdateSchoolId(null); setUpdateUrl(""); setDiffPreview(null); }, [resetKey]);
  useEffect(() => {
    const el = filterBarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFilterBarHeight(el.offsetHeight));
    ro.observe(el);
    setFilterBarHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  const SPECIALIST_SUBJECTS = [
    "Art", "Music", "PE/Sport", "LOTE", "Science", "Library",
    "Digital Tech", "Drama", "Dance", "STEM", "Wellbeing", "Other"
  ];

  const normalizeSubject = (raw) => {
    if (!raw) return raw;
    const r = raw.trim().toLowerCase();
    // Strip dots for matching (P.E. -> pe, P.E./Sport -> pe/sport)
    const rNoDots = r.replace(/\./g, "");
    // LOTE variants
    if (r === "lote" || r === "language" || r === "languages" || r === "lote/language" ||
        r === "lote / language" || r === "lote/languages" || r === "lote / languages" ||
        r === "foreign language" || r === "second language" || r === "japanese" ||
        r === "italian" || r === "french" || r === "mandarin" || r === "chinese" ||
        r === "indonesian" || r === "german" || r === "spanish" || r === "auslan" ||
        r.startsWith("lote")) return "LOTE";
    // PE/Sport variants — check both with and without dots
    if (r === "pe" || rNoDots === "pe" || r === "sport" || r === "sports" ||
        r === "pe/sport" || rNoDots === "pe/sport" || r === "pe / sport" || rNoDots === "pe / sport" ||
        r === "pe/sports" || rNoDots === "pe/sports" || r === "pe / sports" ||
        r === "physical education" || r === "phys ed" ||
        r === "phys. ed" || r === "phys. ed." || r === "physical ed" || r === "gym" ||
        r === "gymnastics" || r === "fitness" || r === "health & pe" || r === "health and pe" ||
        r === "hpe" || r === "sport/pe" || r === "sport / pe" ||
        r.startsWith("pe ") || rNoDots.startsWith("pe ") || r.startsWith("pe/") || rNoDots.startsWith("pe/") ||
        r.startsWith("pe -") || rNoDots.startsWith("pe -") || rNoDots.startsWith("pe-") ||
        r.startsWith("sport") || r.startsWith("physical e")) return "PE/Sport";
    // Match existing subjects case-insensitively
    const match = SPECIALIST_SUBJECTS.find(s => s.toLowerCase() === r);
    if (match) return match;
    return raw.trim();
  };

  // Migrate existing entries to normalized subjects
  useEffect(() => {
    let changed = false;
    const migrated = specialists.map(s => {
      const norm = normalizeSubject(s.subject);
      if (norm !== s.subject) { changed = true; return { ...s, subject: norm }; }
      return s;
    });
    if (changed) setSpecialists(migrated);
  }, []);

  // Migrate: split comma-separated classNames into individual entries
  useEffect(() => {
    const grouped = specialists.filter(s => s.className && s.className.includes(","));
    if (grouped.length === 0) return;
    const expanded = [];
    const removeIds = new Set();
    for (const s of grouped) {
      removeIds.add(s.id);
      const classes = s.className.split(",").map(c => c.trim()).filter(Boolean);
      for (const cn of classes) {
        expanded.push({ ...s, id: uid(), className: cn });
      }
    }
    setSpecialists(prev => [...prev.filter(s => !removeIds.has(s.id)), ...expanded]);
  }, []);

  const openImport = (mode) => {
    setImportMode(mode);
    setImportInstructions("");
    setImportSchoolId(filterSchool || (schools.length === 1 ? schools[0].id : ""));
    setImportError(null);
  };

  const clearAllEntries = () => {
    if (specialists.length === 0) { notify("Nothing to clear", "warning"); return; }
    setSpecialists([]);
    notify("All specialist entries cleared");
  };

  // ---- FILE UPLOAD HANDLER ----
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    const isPdf = file.name.toLowerCase().endsWith(".pdf");
    if (importMode === "pdf" && !isPdf) { notify("Please select a PDF file", "warning"); return; }

    // Check file size (warn if >10MB)
    if (file.size > 10 * 1024 * 1024) {
      notify("File is very large (" + (file.size / 1024 / 1024).toFixed(1) + "MB). This may take longer or fail.", "warning");
    }

    setParsing(true);
    setImportMode(null);
    setImportError(null);

    try {
      if (isPdf) {
        await handlePdfImport(file);
      } else {
        await handleSpreadsheetImport(file);
      }
    } catch (err) {
      console.error("Import error:", err);
      const errorMsg = err.message || "Unknown error";
      setImportError({ message: errorMsg, filename: file.name, details: String(err) });
      notify("Import failed — see error details below.", "danger");
    }
    setParsing(false);
  };

  // ---- PDF IMPORT ----
  const handlePdfImport = async (file) => {
    const base64Data = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result.split(",")[1]);
      reader.onerror = () => rej(new Error("Failed to read the PDF file from disk."));
      reader.readAsDataURL(file);
    });

    let userGuidance = "";
    if (importInstructions.trim()) {
      userGuidance = `\n\nIMPORTANT — SPECIFIC INSTRUCTIONS FROM THE USER about this document. Follow these carefully, they override general assumptions:\n---\n${importInstructions.trim()}\n---`;
    }

    let response;
    try {
      response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 16000,
          messages: [{
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
              { type: "text", text: `This PDF contains a specialist class timetable for a primary/elementary school.\nExtract ALL specialist class entries from this document.\n\nFor each entry I need:\n- class: The class/grade name (e.g. "Prep A", "1B", "3/4C", "Year 5")\n- day: The day of the week (Monday, Tuesday, Wednesday, Thursday, or Friday)\n- start: Start time in HH:MM 24-hour format (e.g. "09:00", "14:30")\n- end: End time in HH:MM 24-hour format\n- subject: The specialist subject (e.g. "Art", "PE/Sport", "LOTE", "Music", "Science", "Library", "Digital Tech", "Drama", "Dance", "STEM")\n\nRespond ONLY with a JSON array, no other text, no markdown backticks. Example:\n[{"class":"3A","day":"Monday","start":"09:00","end":"09:50","subject":"Art"}]\n\nRules:\n- Extract EVERY entry you can find\n- If times are in 12-hour format, convert to 24-hour\n- Use exact class names from the document\n- If you can't determine exact times, estimate based on typical school day (9am-3:30pm)\n- Include ALL classes and ALL specialist subjects shown\n- Use compact JSON with no extra whitespace to fit everything${userGuidance}` }
            ]
          }]
        })
      });
    } catch (fetchErr) {
      throw new Error("Network error connecting to AI service. Check your internet connection and try again.");
    }

    if (!response.ok) {
      let errBody = "";
      try { errBody = await response.text(); } catch(e) {}
      throw new Error(`AI service returned error ${response.status}: ${errBody.substring(0, 200)}`);
    }

    const data = await response.json();

    // Check for API-level errors
    if (data.error) {
      throw new Error(`AI error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    const textContent = data.content?.map(c => c.type === "text" ? c.text : "").join("") || "";

    if (!textContent.trim()) {
      throw new Error("AI returned an empty response. The PDF may be image-based or unreadable. Try a clearer PDF or use a spreadsheet instead.");
    }

    const cleaned = textContent.replace(/```json|```/g, "").trim();

    let entries;
    try {
      entries = JSON.parse(cleaned);
    } catch (parseErr) {
      // Try to recover truncated JSON — the response may have been cut off mid-array
      let recovered = cleaned;
      // Remove any trailing incomplete object
      const lastCompleteObj = recovered.lastIndexOf("}");
      if (lastCompleteObj > 0) {
        recovered = recovered.substring(0, lastCompleteObj + 1);
        // Close the array if needed
        if (!recovered.trim().endsWith("]")) {
          recovered = recovered.trim() + "]";
        }
        try {
          entries = JSON.parse(recovered);
          notify(`Response was truncated — recovered ${entries.length} entries. Some may be missing from the end.`, "warning");
        } catch(e) {
          throw new Error("AI response was cut off and couldn't be recovered. Try adding instructions to limit extraction (e.g. 'only extract Prep–Year 2 classes') and import in batches.\n\nRaw response preview: " + cleaned.substring(0, 300));
        }
      } else {
        throw new Error("AI response wasn't valid JSON.\n\nRaw response preview: " + cleaned.substring(0, 300));
      }
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("AI could not find any specialist entries in this document. Try adding more specific instructions about what to look for.");
    }

    setPreview({
      entries: entries.map(e => ({ id: uid(), schoolId: importSchoolId, className: e.class || "", day: e.day || "", start: e.start || "", end: e.end || "", subject: normalizeSubject(e.subject || ""), notes: "" })),
      schoolId: importSchoolId,
      filename: file.name
    });
  };
  const handleSpreadsheetImport = async (file) => {
    const rawData = await new Promise((resolve) => {
      if (file.name.endsWith(".csv")) {
        window.Papa.parse(file, { header: true, skipEmptyLines: true, complete: (r) => resolve(r.data) });
      } else {
        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
          const XLSX = await getXLSX();
          const wb = XLSX.read(ev.target.result, { type: "binary" });
            const ws = wb.Sheets[wb.SheetNames[0]];
            resolve(XLSX.utils.sheet_to_json(ws, { defval: "" }));
          } catch(e) { resolve([]); }
        };
        reader.readAsBinaryString(file);
      }
    });

    if (rawData.length === 0) { notify("No data found in file", "warning"); return; }

    // If user provided instructions, use AI to interpret
    if (importInstructions.trim()) {
      let response;
      try {
        response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: getAnthropicHeaders(),
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 16000,
            messages: [{
              role: "user",
              content: `I have a spreadsheet with specialist class timetable data. Here are the first 5 rows as a sample:\n\n${JSON.stringify(rawData.slice(0, 5), null, 2)}\n\nFull data (${rawData.length} rows):\n${JSON.stringify(rawData)}\n\nIMPORTANT — SPECIFIC INSTRUCTIONS FROM THE USER. Follow these carefully:\n---\n${importInstructions.trim()}\n---\n\nExtract specialist class entries. For each return:\n- class: class/grade name\n- day: Day of week (Monday-Friday)\n- start: Start time HH:MM 24-hour\n- end: End time HH:MM 24-hour\n- subject: specialist subject name\n\nRespond ONLY with a JSON array, no other text, no markdown backticks.`
            }]
          })
        });
      } catch (fetchErr) {
        throw new Error("Network error connecting to AI service. The spreadsheet was read successfully — try again without instructions to use direct column mapping instead.");
      }

      if (!response.ok) {
        let errBody = ""; try { errBody = await response.text(); } catch(e) {}
        throw new Error(`AI service returned error ${response.status}: ${errBody.substring(0, 200)}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(`AI error: ${data.error.message || JSON.stringify(data.error)}`);
      }
      const textContent = data.content?.map(c => c.type === "text" ? c.text : "").join("") || "";
      const cleaned = textContent.replace(/```json|```/g, "").trim();
      try {
        const entries = JSON.parse(cleaned);
        if (Array.isArray(entries) && entries.length > 0) {
          setPreview({
            entries: entries.map(e => ({ id: uid(), schoolId: importSchoolId, className: e.class || "", day: e.day || "", start: e.start || "", end: e.end || "", subject: normalizeSubject(e.subject || ""), notes: "" })),
            schoolId: importSchoolId,
            filename: file.name
          });
          return;
        }
      } catch(e) { /* fall through to direct mapping */ }
      notify("AI couldn't extract entries with those instructions. Falling back to direct mapping.", "warning");
    }

    // Direct column-mapping fallback
    const imported = [];
    for (const row of rawData) {
      const className = row.class || row.Class || row.className || row.grade || row.Grade || "";
      const day = row.day || row.Day || "";
      const start = row.start || row.start_time || row.Start || "";
      const end = row.end || row.end_time || row.End || "";
      const subject = row.subject || row.Subject || row.specialist || row.Specialist || "";
      if (!className || !day || !subject) continue;
      imported.push({ id: uid(), schoolId: importSchoolId || (schools.length === 1 ? schools[0].id : ""), className: className.trim(), day: day.trim(), start: start.trim() || "09:00", end: end.trim() || "09:30", subject: normalizeSubject(subject.trim()), notes: row.notes || row.Notes || "" });
    }

    if (imported.length === 0) { notify("No valid entries found. Try adding instructions to help interpret the data.", "warning"); return; }
    setPreview({ entries: imported, schoolId: importSchoolId, filename: file.name });
  };

  // ---- PREVIEW HELPERS ----
  const confirmImport = () => {
    if (!preview) return;
    const valid = preview.entries.filter(e => e.schoolId && e.className && e.day && e.subject);
    if (valid.length === 0) { notify("No valid entries. Make sure a school is selected.", "warning"); return; }
    setSpecialists(prev => [...prev, ...valid]);
    notify(`Imported ${valid.length} specialist entries from ${preview.filename}`);
    setPreview(null);
  };

  // ---- UPDATE (DIFF) FLOW ----
  const handleUpdateFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (updateFileRef.current) updateFileRef.current.value = "";
    const schoolId = updateSchoolId;
    const school = schools.find(s => s.id === schoolId);
    const existingEntries = specialists.filter(s => s.schoolId === schoolId);
    const isPdf = file.name.toLowerCase().endsWith(".pdf");
    setParsing(true);
    setImportError(null);
    try {
      let parsedEntries = [];
      const toBase64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(f); });
      const existingDesc = existingEntries.map(e => e.className + " " + e.day + " " + e.start + "-" + e.end + " " + e.subject).join("; ");
      const updatePrompt = "This is an UPDATED specialist class timetable for " + (school ? school.name : "a school") + ". The existing timetable has these entries: " + existingDesc + ". This update likely has only a few changes from the existing timetable. Focus on identifying what is NEW, what has been REMOVED, and what has CHANGED (different time/day/subject for the same class). Extract ALL entries from this document as before." + (updateInstructions ? " Additional instructions: " + updateInstructions : "") + " For each entry return: class, day, start (HH:MM 24h), end (HH:MM 24h), subject. Respond ONLY with a JSON array, no other text, no markdown backticks.";
      if (isPdf) {
        const base64 = await toBase64(file);
        const resp = await anthropicFetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000,
            messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }, { type: "text", text: updatePrompt }] }] })
        });
        const data = await resp.json();
        const text = (data.content || []).map(c => c.type === "text" ? c.text : "").join("");
        parsedEntries = JSON.parse(text.replace(/```json|```/g, "").trim());
      } else {
        const SheetJS = window.XLSX;
        const ab = await file.arrayBuffer();
        const wb = SheetJS.read(ab); const ws = wb.Sheets[wb.SheetNames[0]];
        const rawData = SheetJS.utils.sheet_to_json(ws);
        const resp = await anthropicFetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000,
            messages: [{ role: "user", content: updatePrompt + " Data: " + JSON.stringify(rawData) }] })
        });
        const data = await resp.json();
        const text = (data.content || []).map(c => c.type === "text" ? c.text : "").join("");
        parsedEntries = JSON.parse(text.replace(/```json|```/g, "").trim());
      }
      if (!Array.isArray(parsedEntries)) throw new Error("Expected JSON array");
      const newEntries = parsedEntries.map(e => ({
        id: uid(), schoolId, className: (e.class || "").trim(),
        day: (e.day || "").trim(), start: (e.start || "").trim(),
        end: (e.end || "").trim(), subject: normalizeSubject((e.subject || "").trim()), notes: ""
      })).filter(e => e.className && e.day && e.subject);

      // Build diff: compare new vs existing
      const key = e => e.className + "|" + e.day + "|" + e.start + "|" + e.end + "|" + e.subject;
      const existKeys = new Set(existingEntries.map(key));
      const newKeys = new Set(newEntries.map(key));
      const added = newEntries.filter(e => !existKeys.has(key(e)));
      const removed = existingEntries.filter(e => !newKeys.has(key(e)));
      // Detect changes: same class+day but different time or subject
      const changed = [];
      for (const ne of newEntries) {
        const sameSlot = existingEntries.find(ex => ex.className === ne.className && ex.day === ne.day && (ex.start !== ne.start || ex.end !== ne.end || ex.subject !== ne.subject) && !newKeys.has(key(ex)));
        if (sameSlot) changed.push({ "old": sameSlot, "new": ne });
      }
      // Remove changed items from added/removed
      const changedOldKeys = new Set(changed.map(c => key(c.old)));
      const changedNewKeys = new Set(changed.map(c => key(c["new"])));
      const addedFinal = added.filter(e => !changedNewKeys.has(key(e)));
      const removedFinal = removed.filter(e => !changedOldKeys.has(key(e)));

      if (addedFinal.length === 0 && removedFinal.length === 0 && changed.length === 0) {
        notify("No changes detected — timetable appears identical to existing data.");
        setUpdateSchoolId(null);
        setParsing(false);
        return;
      }
      const initialAccepted = {};
      addedFinal.forEach((_, i) => { initialAccepted["add_" + i] = true; });
      removedFinal.forEach((_, i) => { initialAccepted["rem_" + i] = true; });
      changed.forEach((_, i) => { initialAccepted["chg_" + i] = true; });
      setDiffAccepted(initialAccepted);
      setDiffPreview({ schoolId, schoolName: school?.name || "", added: addedFinal, removed: removedFinal, changed });
      setUpdateSchoolId(null);
    } catch(err) {
      setImportError("Could not parse update file: " + err.message);
    }
    setParsing(false);
  };

  const handleUpdateUrl = async () => {
    const url = updateUrl.trim();
    if (!url) return;
    const schoolId = updateSchoolId;
    const school = schools.find(s => s.id === schoolId);
    const existingEntries = specialists.filter(s => s.schoolId === schoolId);
    setParsing(true);
    setImportError(null);
    try {
      const existingDesc = existingEntries.map(e => e.className + " " + e.day + " " + e.start + "-" + e.end + " " + e.subject).join("; ");
      const urlPrompt = "This is an UPDATED specialist class timetable for " + (school ? school.name : "a school") + ". The existing timetable has these entries: " + existingDesc + ". Please fetch the URL I provide and extract ALL specialist class entries from it." + (updateInstructions ? " Additional instructions: " + updateInstructions : "") + " For each entry return: class, day, start (HH:MM 24h), end (HH:MM 24h), subject. Respond ONLY with a JSON array, no other text, no markdown backticks. URL: " + url;
      const resp = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 4000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: urlPrompt }]
        })
      });
      const data = await resp.json();
      const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const cleaned = text.replace(/```json|```/g, "").trim();
      const arrMatch = cleaned.match(/\[[\s\S]*\]/);
      if (!arrMatch) throw new Error("No JSON array found in response");
      const parsedEntries = JSON.parse(arrMatch[0]);
      if (!Array.isArray(parsedEntries)) throw new Error("Expected JSON array");
      const newEntries = parsedEntries.map(e => ({
        id: uid(), schoolId, className: (e.class || "").trim(),
        day: (e.day || "").trim(), start: (e.start || "").trim(),
        end: (e.end || "").trim(), subject: normalizeSubject((e.subject || "").trim()), notes: ""
      })).filter(e => e.className && e.day && e.subject);
      const eKey = e => e.className + "|" + e.day + "|" + e.start + "|" + e.end + "|" + e.subject;
      const existKeys = new Set(existingEntries.map(eKey));
      const newKeys = new Set(newEntries.map(eKey));
      const added = newEntries.filter(e => !existKeys.has(eKey(e)));
      const removed = existingEntries.filter(e => !newKeys.has(eKey(e)));
      const changed = [];
      for (const ne of newEntries) {
        const sameSlot = existingEntries.find(ex => ex.className === ne.className && ex.day === ne.day && (ex.start !== ne.start || ex.end !== ne.end || ex.subject !== ne.subject) && !newKeys.has(eKey(ex)));
        if (sameSlot) changed.push({ "old": sameSlot, "new": ne });
      }
      const changedOldKeys = new Set(changed.map(c => eKey(c["old"])));
      const changedNewKeys = new Set(changed.map(c => eKey(c["new"])));
      const addedFinal = added.filter(e => !changedNewKeys.has(eKey(e)));
      const removedFinal = removed.filter(e => !changedOldKeys.has(eKey(e)));
      if (addedFinal.length === 0 && removedFinal.length === 0 && changed.length === 0) {
        notify("No changes detected — timetable appears identical to existing data.");
        setUpdateSchoolId(null); setParsing(false); return;
      }
      const initialAccepted = {};
      addedFinal.forEach((_, i) => { initialAccepted["add_" + i] = true; });
      removedFinal.forEach((_, i) => { initialAccepted["rem_" + i] = true; });
      changed.forEach((_, i) => { initialAccepted["chg_" + i] = true; });
      setDiffAccepted(initialAccepted);
      setDiffPreview({ schoolId, schoolName: school ? school.name : "", added: addedFinal, removed: removedFinal, changed });
      setUpdateSchoolId(null);
      setUpdateUrl("");
    } catch(err) {
      setImportError("Could not fetch or parse URL: " + err.message);
      notify("URL fetch failed: " + err.message, "danger");
    }
    setParsing(false);
  };

  const applyDiff = () => {
    if (!diffPreview) return;
    const { schoolId, added, removed, changed } = diffPreview;
    let updated = [...specialists];
    // Apply accepted removals
    const toRemove = new Set();
    removed.forEach((e, i) => { if (diffAccepted["rem_" + i]) toRemove.add(e.id); });
    changed.forEach((c, i) => { if (diffAccepted["chg_" + i]) toRemove.add(c["old"].id); });
    updated = updated.filter(e => !toRemove.has(e.id));
    // Apply accepted additions and changes
    added.forEach((e, i) => { if (diffAccepted["add_" + i]) updated.push(e); });
    changed.forEach((c, i) => { if (diffAccepted["chg_" + i]) updated.push(c["new"]); });
    setSpecialists(updated);
    const totalChanges = Object.values(diffAccepted).filter(Boolean).length;
    notify("Applied " + totalChanges + " change" + (totalChanges !== 1 ? "s" : "") + " to " + diffPreview.schoolName);
    setDiffPreview(null);
    setDiffAccepted({});
    setUpdateInstructions("");
  };

    const updatePreviewEntry = (idx, key, val) => {
    setPreview(prev => { const entries = [...prev.entries]; entries[idx] = { ...entries[idx], [key]: val }; return { ...prev, entries }; });
  };

  const removePreviewEntry = (idx) => {
    setPreview(prev => ({ ...prev, entries: prev.entries.filter((_, i) => i !== idx) }));
  };

  const updateAllPreviewSchool = (schoolId) => {
    setPreview(prev => ({ ...prev, schoolId, entries: prev.entries.map(e => ({ ...e, schoolId })) }));
  };

  // ---- MANUAL ENTRY ----
  const newEntry = () => {
    setForm({
      schoolId: "", className: "", subject: "", customSubject: "", notes: "",
      timeSlots: [{ id: uid(), day: "Monday", start: "09:00", end: "09:30" }]
    });
    setEditing("new");
  };
  const editEntry = (entry) => {
    const isCustom = entry.subject && !SPECIALIST_SUBJECTS.includes(entry.subject);
    setForm({
      ...entry,
      subject: isCustom ? "Other" : entry.subject,
      customSubject: isCustom ? entry.subject : "",
      timeSlots: [{ id: entry.id, day: entry.day, start: entry.start, end: entry.end }]
    });
    setEditing(entry.id);
  };

  const addTimeSlot = () => {
    setForm(p => {
      const last = p.timeSlots[p.timeSlots.length - 1];
      return { ...p, timeSlots: [...p.timeSlots, { id: uid(), day: last?.day || "Monday", start: last?.start || "09:00", end: last?.end || "09:30" }] };
    });
  };
  const updateTimeSlot = (idx, key, val) => {
    setForm(p => {
      const ts = [...p.timeSlots];
      ts[idx] = { ...ts[idx], [key]: val };
      return { ...p, timeSlots: ts };
    });
  };
  const removeTimeSlot = (idx) => {
    setForm(p => ({ ...p, timeSlots: p.timeSlots.filter((_, i) => i !== idx) }));
  };
  const duplicateTimeSlot = (idx) => {
    setForm(p => {
      const ts = [...p.timeSlots];
      ts.splice(idx + 1, 0, { ...ts[idx], id: uid() });
      return { ...p, timeSlots: ts };
    });
  };

  const saveEntry = () => {
    if (!form.schoolId) { notify("Select a school", "warning"); return; }
    if (!form.className.trim()) { notify("Class name required", "warning"); return; }
    if (!form.subject) { notify("Select a subject", "warning"); return; }
    if (form.subject === "Other" && !form.customSubject?.trim()) { notify("Enter a custom subject name", "warning"); return; }
    if (!form.timeSlots || form.timeSlots.length === 0) { notify("Add at least one day/time", "warning"); return; }
    // Resolve subject: use custom name for "Other", otherwise normalize
    const subject = form.subject === "Other" ? form.customSubject.trim() : normalizeSubject(form.subject);

    if (editing === "new") {
      // Split comma-separated class names into individual entries (one per class per time slot)
      const classNames = form.className.split(",").map(c => c.trim()).filter(Boolean);
      const newEntries = [];
      for (const cn of classNames) {
        for (const ts of form.timeSlots) {
          newEntries.push({
            id: uid(), schoolId: form.schoolId, className: cn,
            day: ts.day, start: ts.start, end: ts.end,
            subject, notes: form.notes || ""
          });
        }
      }
      setSpecialists(prev => [...prev, ...newEntries]);
      notify(`Added ${newEntries.length} specialist ${newEntries.length === 1 ? "entry" : "entries"}${classNames.length > 1 ? ` across ${classNames.length} classes` : ""}`);
    } else {
      // Editing existing — if className now has commas, expand into multiple entries
      const classNames = form.className.split(",").map(c => c.trim()).filter(Boolean);
      const ts = form.timeSlots[0];
      if (classNames.length === 1) {
        const normalized = {
          id: form.id, schoolId: form.schoolId, className: classNames[0],
          day: ts.day, start: ts.start, end: ts.end,
          subject, notes: form.notes || ""
        };
        setSpecialists(prev => prev.map(s => s.id === normalized.id ? normalized : s));
      } else {
        // Replace the original with multiple individual entries
        const newEntries = classNames.map(cn => ({
          id: uid(), schoolId: form.schoolId, className: cn,
          day: ts.day, start: ts.start, end: ts.end,
          subject, notes: form.notes || ""
        }));
        setSpecialists(prev => [...prev.filter(s => s.id !== form.id), ...newEntries]);
      }
      notify("Entry updated");
    }
    // Reset form for another entry
    setForm({
      schoolId: form.schoolId, className: form.className, subject: "", customSubject: "", notes: "",
      timeSlots: [{ id: uid(), day: form.timeSlots[0]?.day || "Monday", start: form.timeSlots[0]?.start || "09:00", end: form.timeSlots[0]?.end || "09:30" }]
    });
    setEditing("new");
  };

  const deleteEntry = (id) => { setSpecialists(prev => prev.filter(s => s.id !== id)); notify("Entry removed"); };

  const clearSchoolEntries = (schoolId) => {
    const count = specialists.filter(s => s.schoolId === schoolId).length;
    setSpecialists(prev => prev.filter(s => s.schoolId !== schoolId));
    notify(`Cleared ${count} entries`);
  };

  // ---- DATA ----
  const filtered = specialists.filter(s => {
    if (filterSchool && s.schoolId !== filterSchool) return false;
    if (filterClass && s.className !== filterClass) return false;
    if (filterDay && s.day !== filterDay) return false;
    if (filterSubject && s.subject !== filterSubject) return false;
    return true;
  });

  const dayOrder = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4 };

  // ==== RENDER: IMPORT PANEL ====
  if (diffPreview) {
    const { schoolName, added, removed, changed } = diffPreview;
    const changeCount = added.length + removed.length + changed.length;
    return (
      <div>
        <PageTitle subtitle={`${changeCount} change${changeCount !== 1 ? "s" : ""} detected for ${schoolName} — review and accept or reject each`}>
          Review Specialist Timetable Update
        </PageTitle>
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Btn onClick={applyDiff}>✓ Apply Accepted Changes</Btn>
            <Btn variant="secondary" onClick={() => { setDiffPreview(null); setDiffAccepted({}); }}>Cancel</Btn>
            <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 8 }}>
              {Object.values(diffAccepted).filter(Boolean).length} of {changeCount} changes accepted
            </span>
          </div>
        </Card>

        {added.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#16A34A", marginBottom: 8 }}>➕ Added ({added.length})</div>
            {added.map((e, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", marginBottom: 6, background: diffAccepted["add_" + i] ? "#F0FDF4" : colors.bg, border: `1px solid ${diffAccepted["add_" + i] ? "#86EFAC" : colors.border}`, borderRadius: 8, fontSize: 13 }}>
                <input type="checkbox" checked={!!diffAccepted["add_" + i]} onChange={ev => setDiffAccepted(p => ({ ...p, ["add_" + i]: ev.target.checked }))} style={{ width: 16, height: 16, cursor: "pointer" }} />
                <Tag color={colors.accent}>{e.className}</Tag>
                <span style={{ fontWeight: 600 }}>{e.day}</span>
                <span style={{ color: colors.textLight }}>{e.start}–{e.end}</span>
                <Tag color="#8B5CF6">{e.subject}</Tag>
              </div>
            ))}
          </div>
        )}

        {removed.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: colors.danger, marginBottom: 8 }}>➖ Removed ({removed.length})</div>
            {removed.map((e, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", marginBottom: 6, background: diffAccepted["rem_" + i] ? "#FEF2F2" : colors.bg, border: `1px solid ${diffAccepted["rem_" + i] ? "#FCA5A5" : colors.border}`, borderRadius: 8, fontSize: 13 }}>
                <input type="checkbox" checked={!!diffAccepted["rem_" + i]} onChange={ev => setDiffAccepted(p => ({ ...p, ["rem_" + i]: ev.target.checked }))} style={{ width: 16, height: 16, cursor: "pointer" }} />
                <Tag color={colors.accent}>{e.className}</Tag>
                <span style={{ fontWeight: 600 }}>{e.day}</span>
                <span style={{ color: colors.textLight }}>{e.start}–{e.end}</span>
                <Tag color="#8B5CF6">{e.subject}</Tag>
                <span style={{ fontSize: 11, color: colors.textMuted, fontStyle: "italic", marginLeft: 4 }}>will be deleted</span>
              </div>
            ))}
          </div>
        )}

        {changed.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: colors.purple600, marginBottom: 8 }}>✏️ Changed ({changed.length})</div>
            {changed.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", marginBottom: 6, background: diffAccepted["chg_" + i] ? "rgba(52,69,101,0.07)" : colors.bg, border: `1px solid ${diffAccepted["chg_" + i] ? "rgba(52,69,101,0.25)" : colors.border}`, borderRadius: 8, fontSize: 13, flexWrap: "wrap" }}>
                <input type="checkbox" checked={!!diffAccepted["chg_" + i]} onChange={ev => setDiffAccepted(p => ({ ...p, ["chg_" + i]: ev.target.checked }))} style={{ width: 16, height: 16, cursor: "pointer" }} />
                <Tag color={colors.accent}>{c["old"].className}</Tag>
                <span style={{ color: colors.textMuted, textDecoration: "line-through", fontSize: 12 }}>{c["old"].day} {c["old"].start}–{c["old"].end} {c["old"].subject}</span>
                <span style={{ color: colors.textMuted }}>→</span>
                <span style={{ fontWeight: 600 }}>{c["new"].day} {c["new"].start}–{c["new"].end}</span>
                <Tag color="#8B5CF6">{c["new"].subject}</Tag>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (updateSchoolId) {
    const school = schools.find(s => s.id === updateSchoolId);
    return (
      <div>
        <PageTitle subtitle={`Upload an updated specialist timetable for ${school?.name || "this school"} — the AI will compare it to existing data and show you what changed`}>
          Update Specialist Timetable
        </PageTitle>
        {parsing ? (
          <Card style={{ textAlign: "center", padding: 40 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔄</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: colors.text, marginBottom: 8 }}>Analysing changes...</div>
            <div style={{ fontSize: 13, color: colors.textMuted }}>Comparing new timetable to existing data</div>
          </Card>
        ) : (
          <Card>
            {importError && <div style={{ marginBottom: 12, padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, fontSize: 13, color: colors.danger }}>{importError}</div>}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Optional instructions</label>
              <textarea value={updateInstructions} onChange={e => setUpdateInstructions(e.target.value)}
                placeholder="Any hints for the AI about what changed, class name format, time format, etc..."
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", minHeight: 80, resize: "vertical", boxSizing: "border-box" }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Link (URL)</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={updateUrl} onChange={e => setUpdateUrl(e.target.value)}
                  placeholder="https://... paste a link to the updated timetable"
                  style={{ flex: 1, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} />
                <Btn onClick={handleUpdateUrl} disabled={!updateUrl.trim()} style={{ opacity: updateUrl.trim() ? 1 : 0.4, whiteSpace: "nowrap" }}>🔗 Fetch Link</Btn>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1, height: 1, background: colors.border }} />
              <span style={{ fontSize: 12, color: colors.textMuted }}>or upload a file</span>
              <div style={{ flex: 1, height: 1, background: colors.border }} />
            </div>
            <input ref={updateFileRef} type="file" accept=".pdf,.csv,.xlsx,.xls" onChange={handleUpdateFileUpload} style={{ display: "none" }} />
            <div style={{ display: "flex", gap: 10 }}>
              <Btn onClick={() => updateFileRef.current && updateFileRef.current.click()}>📄 Upload PDF / Spreadsheet</Btn>
              <Btn variant="secondary" onClick={() => { setUpdateSchoolId(null); setUpdateInstructions(""); setUpdateUrl(""); setImportError(null); }}>Cancel</Btn>
            </div>
          </Card>
        )}
      </div>
    );
  }

    if (importMode) {
    return (
      <div>
        <PageTitle subtitle={importMode === "pdf" ? "Upload a PDF and guide the AI on what to extract" : "Upload a spreadsheet and guide the AI on how to read it"}>
          Import Specialist Timetable
        </PageTitle>
        <Card>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <button onClick={() => setImportMode("pdf")} style={{
              flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer",
              border: "2px solid " + (importMode === "pdf" ? colors.accent : colors.border),
              background: importMode === "pdf" ? colors.accentLight : colors.white,
              color: importMode === "pdf" ? colors.accentDark : colors.text, fontWeight: 600
            }}>📄 PDF Document</button>
            <button onClick={() => setImportMode("spreadsheet")} style={{
              flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer",
              border: "2px solid " + (importMode === "spreadsheet" ? colors.accent : colors.border),
              background: importMode === "spreadsheet" ? colors.accentLight : colors.white,
              color: importMode === "spreadsheet" ? colors.accentDark : colors.text, fontWeight: 600
            }}>📁 Spreadsheet (CSV/XLSX)</button>
          </div>
          <Input label="School" value={importSchoolId} onChange={setImportSchoolId}
            options={schools.map(s => ({ value: s.id, label: s.name }))} />

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Import Instructions <span style={{ fontWeight: 400, textTransform: "none" }}>(optional but recommended)</span>
            </label>
            <textarea
              value={importInstructions}
              onChange={e => setImportInstructions(e.target.value)}
              rows={6}
              placeholder={importMode === "pdf"
                ? "Examples of things you can tell the AI:\n\n• Class names look like \"Prep A\", \"1/2B\", \"3/4C\"\n• Ignore \"Assembly\" and \"Recess\" — only extract specialist subjects\n• The times shown are session times, each session is 50 min\n• \"LOTE\" means Languages / LOTE\n• Only extract entries for Prep–Year 2 classes\n• The PDF has two tables — one per campus, only use the first"
                : "Examples of things you can tell the AI:\n\n• The \"Period\" column maps to times: P1=9:00-9:30, P2=9:30-10:00\n• Column \"Spec\" is the subject name\n• Ignore rows where subject is \"Library\"\n• Class names are in the \"Grade\" column, not \"Class\"\n• Times are in 12-hour format (e.g. 2:30pm)"}
              style={{
                width: "100%", padding: "12px 14px",
                border: `1px solid ${colors.inputBorder}`, borderRadius: 8,
                fontSize: 14, fontFamily: "inherit", background: colors.inputBg,
                color: colors.text, resize: "vertical", boxSizing: "border-box",
                lineHeight: 1.6
              }}
            />
            <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 6 }}>
              Tell the AI what class names look like, which subjects to include or ignore, how to interpret times, or anything else specific to this document.
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input ref={fileRef} type="file" accept={importMode === "pdf" ? ".pdf" : ".csv,.xlsx,.xls"} onChange={handleFileUpload} style={{ display: "none" }} />
            <Btn onClick={() => fileRef.current?.click()}>
              {importMode === "pdf" ? "📄 Select PDF File" : "📁 Select Spreadsheet"}
            </Btn>
            <Btn variant="secondary" onClick={() => setImportMode(null)}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: PARSING ====
  if (parsing) {
    return (
      <div>
        <PageTitle>Specialist Timetables</PageTitle>
        <Card style={{ background: "#FFF8F0", borderColor: colors.accent + "40" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontSize: 28 }}>⏳</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, color: colors.accent }}>Processing your file...</div>
              <div style={{ fontSize: 13, color: colors.textLight, marginTop: 4 }}>
                AI is reading the document and extracting specialist class data. This usually takes 10–20 seconds.
                {importInstructions.trim() && <span style={{ display: "block", marginTop: 4, color: colors.textMuted, fontStyle: "italic" }}>Using your instructions to guide extraction.</span>}
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: ERROR ====
  if (importError) {
    return (
      <div>
        <PageTitle subtitle="Something went wrong during import">Import Error</PageTitle>
        <Card style={{ background: "#FEF6F6", borderColor: "#FCC" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <div style={{ fontSize: 28, flexShrink: 0 }}>⚠️</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 15, color: colors.danger, marginBottom: 8 }}>
                Failed to import "{importError.filename}"
              </div>
              <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.6, marginBottom: 12 }}>
                {importError.message}
              </div>
              <div style={{ fontSize: 12, color: colors.textMuted, padding: "10px 14px", background: "#FFF", borderRadius: 8, border: "1px solid #F0E0E0", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 120, overflowY: "auto" }}>
                {importError.details}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <Btn onClick={() => { setImportError(null); openImport("pdf"); }}>Try PDF Again</Btn>
            <Btn variant="secondary" onClick={() => { setImportError(null); openImport("spreadsheet"); }}>Try Spreadsheet</Btn>
            <Btn variant="ghost" onClick={() => setImportError(null)}>Dismiss</Btn>
          </div>
        </Card>

        <Card style={{ marginTop: 16, background: colors.accentLight, borderColor: colors.accent + "40" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.accentDark, marginBottom: 6 }}>💡 Troubleshooting Tips</div>
          <div style={{ fontSize: 12, color: colors.accentDark, lineHeight: 1.8 }}>
            • <strong>Network error:</strong> Check your internet connection and try again
            <br />• <strong>Empty response:</strong> The PDF might be image-based (scanned). Try a text-based PDF or use a spreadsheet
            <br />• <strong>Unexpected format:</strong> Add more specific instructions about class names, time formats, and layout
            <br />• <strong>File too large:</strong> Try a smaller PDF or convert the relevant page to a spreadsheet
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: PREVIEW ====
  if (preview) {
    return (
      <div>
        <PageTitle subtitle={`Extracted ${preview.entries.length} entries from ${preview.filename} — review and edit before importing`}>Review Import</PageTitle>

        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: colors.textLight, whiteSpace: "nowrap" }}>Assign all to school:</label>
            <select value={preview.schoolId} onChange={e => updateAllPreviewSchool(e.target.value)}
              style={{ flex: 1, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
              <option value="">Select school...</option>
              {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          {!preview.schoolId && <div style={{ fontSize: 12, color: colors.danger, marginTop: 8 }}>⚠ Please select a school before importing</div>}
        </Card>

        <Card style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: colors.bg, borderBottom: `1px solid ${colors.border}`, position: "sticky", top: 0, zIndex: 1 }}>
                  {["Class", "Day", "Start", "End", "Subject", ""].map(h => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, background: colors.bg }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.entries.map((entry, i) => (
                  <tr key={entry.id} style={{ borderBottom: `1px solid ${colors.borderLight}` }}>
                    <td style={{ padding: "6px 12px" }}>
                      <input value={entry.className} onChange={e => updatePreviewEntry(i, "className", e.target.value)}
                        style={{ width: "100%", padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <select value={entry.day} onChange={e => updatePreviewEntry(i, "day", e.target.value)}
                        style={{ padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }}>
                        {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <input type="time" value={entry.start} onChange={e => updatePreviewEntry(i, "start", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <input type="time" value={entry.end} onChange={e => updatePreviewEntry(i, "end", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <input value={entry.subject} onChange={e => updatePreviewEntry(i, "subject", e.target.value)}
                        style={{ width: "100%", padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <button onClick={() => removePreviewEntry(i)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 16 }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={confirmImport} disabled={!preview.schoolId}>✓ Import {preview.entries.length} Entries</Btn>
          <Btn variant="secondary" onClick={() => setPreview(null)}>Cancel</Btn>
        </div>
      </div>
    );
  }

  // ==== RENDER: MANUAL FORM ====
  if (form) {
    const isNew = editing === "new";
    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveEntry(); } }}>
        <PageTitle subtitle={isNew ? "Add a subject to one or more day/time slots at once." : "Edit this specialist entry."}>{isNew ? "Add Specialist Entry" : "Edit Specialist Entry"}</PageTitle>
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" }}>
            <Input label="School" value={form.schoolId} onChange={v => setForm(p => ({ ...p, schoolId: v }))} options={schools.map(s => ({ value: s.id, label: s.name }))} />
            <Input label="Class / Grade" value={form.className} onChange={v => setForm(p => ({ ...p, className: v }))} placeholder="e.g. 3A, Prep B, Year 5" />
            <Input label="Subject" value={SPECIALIST_SUBJECTS.includes(form.subject) || !form.subject ? form.subject : "Other"} onChange={v => setForm(p => ({ ...p, subject: v, customSubject: v === "Other" ? (p.customSubject || "") : "" }))} options={SPECIALIST_SUBJECTS} />
            {(form.subject === "Other" || (!SPECIALIST_SUBJECTS.includes(form.subject) && form.subject)) && (
              <Input label="Custom Subject Name" value={form.customSubject || (form.subject !== "Other" ? form.subject : "")} onChange={v => setForm(p => ({ ...p, customSubject: v }))} placeholder="e.g. Spelling, Handwriting, Coding" />
            )}
          </div>

          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginTop: 16, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Day & Time Slots</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {form.timeSlots.map((ts, i) => (
              <div key={ts.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                <select value={ts.day} onChange={e => updateTimeSlot(i, "day", e.target.value)}
                  style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", minWidth: 110 }}>
                  {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <input type="time" value={ts.start} onChange={e => updateTimeSlot(i, "start", e.target.value)}
                  style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                <span style={{ color: colors.textMuted, fontSize: 13 }}>to</span>
                <input type="time" value={ts.end} onChange={e => updateTimeSlot(i, "end", e.target.value)}
                  style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                {isNew && (
                  <>
                    <button onClick={() => duplicateTimeSlot(i)} title="Duplicate" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 14, color: colors.textMuted, padding: "2px 4px" }}>⧉</button>
                    {form.timeSlots.length > 1 && (
                      <button onClick={() => removeTimeSlot(i)} title="Remove" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16, color: colors.danger, padding: "2px 4px" }}>×</button>
                    )}
                  </>
                )}
              </div>
            ))}
            {isNew && (
              <button onClick={addTimeSlot} style={{ alignSelf: "flex-start", padding: "6px 14px", background: "none", border: `1px dashed ${colors.border}`, borderRadius: 8, fontSize: 13, color: colors.accent, cursor: "pointer", fontFamily: "inherit" }}>
                + Add another day/time
              </button>
            )}
          </div>

          <Input label="Notes (optional)" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} placeholder="e.g. alternating weeks only" />
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveEntry}>{isNew ? (form.timeSlots.length > 1 ? `Save ${form.timeSlots.length} Entries & Add More` : "Save & Add Another") : "Save"}</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); }}>Done</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: MAIN LIST ====

  // Subject colour palette for the calendar strip
  const SUBJECT_COLORS = {
    "Art": "#F59E0B", "Music": "#8B5CF6", "PE/Sport": "#10B981", "LOTE": "#3B82F6",
    "Science": "#06B6D4", "Library": "#6366F1", "Digital Tech": "#EC4899",
    "Drama": "#F97316", "Dance": "#EF4444", "STEM": "#84CC16", "Wellbeing": "#14B8A6",
  };
  const subjectColor = (s) => SUBJECT_COLORS[s] || colors.accent;

  // Extract year level from class name: "5A" -> "5", "3/4A" -> "3/4", "Prep A" -> "Prep"
  const yearLevel = (className) => {
    if (!className) return className;
    // Strip trailing letter suffix (and any space before it), but only if something numeric/meaningful remains
    // e.g. "5A" -> "5", "3/4B" -> "3/4", "Prep A" -> "Prep", "Year 5A" -> "Year 5"
    const stripped = className.replace(/\s+[A-Za-z]$/, "").replace(/[A-Za-z]$/, "").trim();
    return stripped || className;
  };

  // Merge entries with same school+day+start+end+subject into one, combining year levels
  const mergeStripEntries = (entries) => {
    const groups = {};
    for (const e of entries) {
      const key = `${e.schoolId}|${e.day}|${e.start}|${e.end}|${e.subject}`;
      if (!groups[key]) groups[key] = { ...e, _classes: [e.className] };
      else groups[key]._classes.push(e.className);
    }
    return Object.values(groups).map(g => {
      if (g._classes.length === 1) return { ...g, displayClass: g.className };
      // Map to year levels, deduplicate, then sort
      const seen = new Set();
      const levels = [];
      for (const cn of g._classes) {
        const lv = yearLevel(cn);
        if (!seen.has(lv)) { seen.add(lv); levels.push(lv); }
      }
      levels.sort((a, b) => {
        const na = parseInt(a), nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });
      return { ...g, displayClass: levels.join("/") };
    });
  };

  // Build per-day data from filtered entries (grouped by school within each day)
  const STRIP_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const stripByDay = STRIP_DAYS.map(day => {
    const raw = filtered
      .filter(e => e.day === day)
      .sort((a, b) => a.start.localeCompare(b.start));
    const merged = mergeStripEntries(raw).sort((a, b) => a.start.localeCompare(b.start));
    // Group by school for display
    const bySchool = {};
    for (const e of merged) {
      const sName = (schools.find(s => s.id === e.schoolId) || {}).name || "Unknown";
      if (!bySchool[sName]) bySchool[sName] = [];
      bySchool[sName].push(e);
    }
    return { day, entries: merged, bySchool };
  });

  // Build per-school data for the collapsible banners (always use filtered)
  const bannerSchools = (() => {
    const map = {};
    for (const e of filtered) {
      const school = schools.find(s => s.id === e.schoolId);
      const id = e.schoolId;
      const name = school ? school.name : "Unknown School";
      if (!map[id]) map[id] = { id, name, entries: [] };
      map[id].entries.push(e);
    }
    // Sort schools by name
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  })();

  const toggleBanner = (id) => setSchoolBannerOpen(prev => ({ ...prev, [id]: !prev[id] }));
  const setBannerMode = (id, mode, e) => {
    e.stopPropagation();
    setSchoolBannerMode(prev => ({ ...prev, [id]: mode }));
    setSchoolBannerOpen(prev => ({ ...prev, [id]: true }));
  };

  return (
    <div>
      <PageTitle pageColor={PAGE_COLORS.specialists}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
        action={<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {filterSchool && (
            <Btn variant="secondary" onClick={() => { setUpdateSchoolId(filterSchool); setImportError(null); }} style={{ fontSize: 12 }}>🔄 Update</Btn>
          )}
          <div style={{ position: "relative", display: "inline-block" }}
            onMouseEnter={e => { const t = e.currentTarget.querySelector(".spec-import-tooltip"); if (t) t.style.display = "block"; }}
            onMouseLeave={e => { const t = e.currentTarget.querySelector(".spec-import-tooltip"); if (t) t.style.display = "none"; }}>
            <Btn variant="secondary" onClick={() => openImport("spreadsheet")}>Import</Btn>
            <div className="spec-import-tooltip" style={{
              display: "none", position: "absolute", top: "calc(100% + 8px)", right: 0,
              width: 360, background: colors.white, border: "1px solid " + colors.border,
              borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: "14px 16px",
              zIndex: 200, color: colors.text, fontSize: 12, lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: colors.sidebarActive }}>📋 Spreadsheet Import Format</div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Required columns:</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>class</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>day</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>start</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>end</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>subject</code>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Optional columns:</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>school</code> <span style={{ color: colors.textMuted }}>(school name, matched automatically)</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>notes</code> <span style={{ color: colors.textMuted }}>(any scheduling notes)</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Times:</span> 24-hour format preferred <span style={{ color: colors.textMuted }}>(e.g. 09:00, 14:30)</span><br/>
                <span style={{ color: colors.textMuted }}>Add instructions to explain 12-hour, period names, or other formats.</span>
              </div>
              <div style={{ marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>Subjects recognised:</span><br/>
                <span style={{ color: colors.textMuted }}>Art, Music, PE/Sport, LOTE, Science, Library, Digital Tech, Drama, Dance, STEM, Wellbeing — or any custom name.</span>
              </div>
              <div style={{ borderTop: "1px solid " + colors.border, paddingTop: 8, marginTop: 4, color: colors.textMuted }}>
                📄 PDF import also available — click Import to switch modes.
              </div>
            </div>
          </div>
          <Btn onClick={newEntry}>+ Add</Btn>
        </div>}>
        Specialist Timetables
      </PageTitle>

      {schools.length === 0 ? (
        <EmptyState icon="🏫" title="Add schools first" subtitle="Set up at least one school before adding specialist timetables." />
      ) : specialists.length === 0 ? (
        <EmptyState icon="🎨" title="No specialist timetables yet" subtitle="Import from a PDF or spreadsheet (with optional instructions), or add entries manually." action="+ Add Entry" onAction={newEntry} />
      ) : (
        <>
          {/* ── FILTER BAR ── */}
          <div ref={filterBarRef} style={{ position: "sticky", top: HEADER_HEIGHT, zIndex: 10, marginBottom: 16 }}>
            <Card style={{ padding: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <select value={filterSchool} onChange={e => { setFilterSchool(e.target.value); setFilterClass(""); }}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Schools</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select value={filterClass} onChange={e => setFilterClass(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Classes</option>
                  {[...new Set(specialists
                    .filter(s => !filterSchool || s.schoolId === filterSchool)
                    .map(s => s.className).filter(Boolean))]
                    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                    .map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={filterDay} onChange={e => setFilterDay(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Days</option>
                  {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <select value={filterSubject} onChange={e => setFilterSubject(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Subjects</option>
                  {[...new Set(specialists.map(s => s.subject).filter(Boolean))].sort().map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                {filterSchool && (
                  <Btn variant="danger" onClick={() => clearSchoolEntries(filterSchool)} style={{ fontSize: 12 }}>Clear This School</Btn>
                )}
                <Btn variant="danger" onClick={clearAllEntries} style={{ fontSize: 12 }}>Clear All</Btn>
              </div>
              {(filterSchool || filterClass || filterDay || filterSubject) && (
                <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 8 }}>
                  Showing {filtered.length} of {specialists.length} entries
                  <button onClick={() => { setFilterSchool(""); setFilterClass(""); setFilterDay(""); setFilterSubject(""); }}
                    style={{ border: "none", background: "none", color: colors.accent, cursor: "pointer", fontSize: 12, marginLeft: 8, textDecoration: "underline" }}>Clear filters</button>
                </div>
              )}
            </Card>
          </div>

          {/* ── CALENDAR STRIP ── */}
          <Card style={{ marginBottom: 20, padding: 0, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)" }}>
              {stripByDay.map(({ day, bySchool }, di) => {
                const allEntries = Object.values(bySchool).flat();
                return (
                  <div key={day} style={{
                    borderRight: di < 4 ? `1px solid ${colors.borderLight}` : "none",
                    display: "flex", flexDirection: "column",
                  }}>
                    {/* Day header */}
                    <div style={{
                      padding: "8px 10px", textAlign: "center", fontWeight: 700, fontSize: 12,
                      letterSpacing: 0.8, textTransform: "uppercase",
                      background: allEntries.length > 0 ? colors.sidebarActive : "rgba(52,69,101,0.55)",
                      color: allEntries.length > 0 ? "#fff" : "rgba(255,255,255,0.55)",
                      borderBottom: `1px solid ${colors.borderLight}`,
                    }}>
                      {day.slice(0, 3)}
                    </div>
                    {/* Entries */}
                    <div style={{ flex: 1, padding: allEntries.length > 0 ? "8px 6px" : "12px 8px", minHeight: 60 }}>
                      {allEntries.length === 0 ? (
                        <div style={{ fontSize: 11, color: colors.textMuted, textAlign: "center", paddingTop: 4, fontStyle: "italic" }}>—</div>
                      ) : (
                        Object.entries(bySchool).map(([schoolName, entries]) => (
                          <div key={schoolName} style={{ marginBottom: Object.keys(bySchool).length > 1 ? 8 : 0 }}>
                            {Object.keys(bySchool).length > 1 && (
                              <div style={{ fontSize: 9, fontWeight: 700, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{schoolName}</div>
                            )}
                            {entries.map(e => (
                              <div key={e.id} style={{
                                display: "flex", alignItems: "center", gap: 4,
                                padding: "3px 6px", marginBottom: 3, borderRadius: 5,
                                background: subjectColor(e.subject) + "18",
                                border: `1px solid ${subjectColor(e.subject)}40`,
                              }}>
                                <span style={{ fontSize: 10, color: colors.textMuted, whiteSpace: "nowrap", flexShrink: 0 }}>
                                  {e.start}
                                </span>
                                <span style={{ fontSize: 10, fontWeight: 600, color: colors.accent, whiteSpace: "nowrap", flexShrink: 0 }}>
                                  {e.displayClass || e.className}
                                </span>
                                <span style={{ fontSize: 11, fontWeight: 600, color: subjectColor(e.subject), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {e.subject}
                                </span>
                              </div>
                            ))}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* ── SCHOOL BANNERS ── */}
          {bannerSchools.map(({ id, name, entries }) => {
            const isOpen = !!schoolBannerOpen[id];
            const mode = schoolBannerMode[id] || "all";

            // Build display entries based on mode
            const displayContent = (() => {
              if (mode === "day") {
                // Group by day, chronological within each day
                return STRIP_DAYS.map(day => {
                  const dayEntries = entries.filter(e => e.day === day).sort((a, b) => a.start.localeCompare(b.start));
                  if (dayEntries.length === 0) return null;
                  return (
                    <div key={day} style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: colors.sidebarActive, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6, paddingBottom: 4, borderBottom: `1px solid ${colors.borderLight}` }}>{day}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {dayEntries.map(e => (
                          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: colors.bg, borderRadius: 7, border: `1px solid ${colors.borderLight}`, fontSize: 13 }}>
                            <span style={{ fontSize: 11, color: colors.textMuted, minWidth: 80, whiteSpace: "nowrap" }}>{to12h(e.start)}–{to12h(e.end)}</span>
                            <Tag color={subjectColor(e.subject)}>{e.subject}</Tag>
                            <Tag color={colors.accent}>{e.className}</Tag>
                            {e.notes && <span title={e.notes} style={{ fontSize: 11, color: colors.textMuted, cursor: "help" }}>📝</span>}
                            <div style={{ flex: 1 }} />
                            <button onClick={() => editEntry(e)} style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 12, padding: "2px 4px" }}>✏️</button>
                            <button onClick={() => deleteEntry(e.id)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 14, padding: "2px 4px" }}>×</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                }).filter(Boolean);
              } else if (mode === "class") {
                // Group by class name, alphabetically
                const byClass = {};
                for (const e of entries) {
                  if (!byClass[e.className]) byClass[e.className] = [];
                  byClass[e.className].push(e);
                }
                return Object.entries(byClass)
                  .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
                  .map(([className, clsEntries]) => {
                    const sorted = [...clsEntries].sort((a, b) => (dayOrder[a.day] || 0) - (dayOrder[b.day] || 0) || a.start.localeCompare(b.start));
                    return (
                      <div key={className} style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: colors.accent, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6, paddingBottom: 4, borderBottom: `1px solid ${colors.borderLight}` }}>Class {className}</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {sorted.map(e => (
                            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: colors.bg, borderRadius: 7, border: `1px solid ${colors.borderLight}`, fontSize: 13 }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color: colors.text, minWidth: 28 }}>{e.day.slice(0, 3)}</span>
                              <span style={{ fontSize: 11, color: colors.textMuted, minWidth: 80, whiteSpace: "nowrap" }}>{to12h(e.start)}–{to12h(e.end)}</span>
                              <Tag color={subjectColor(e.subject)}>{e.subject}</Tag>
                              {e.notes && <span title={e.notes} style={{ fontSize: 11, color: colors.textMuted, cursor: "help" }}>📝</span>}
                              <div style={{ flex: 1 }} />
                              <button onClick={() => editEntry(e)} style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 12, padding: "2px 4px" }}>✏️</button>
                              <button onClick={() => deleteEntry(e.id)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 14, padding: "2px 4px" }}>×</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  });
              } else {
                // "all" — flat list sorted by day then time
                const sorted = [...entries].sort((a, b) => (dayOrder[a.day] || 0) - (dayOrder[b.day] || 0) || a.start.localeCompare(b.start));
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {sorted.map(e => (
                      <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: colors.bg, borderRadius: 7, border: `1px solid ${colors.borderLight}`, fontSize: 13 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: colors.text, minWidth: 28 }}>{e.day.slice(0, 3)}</span>
                        <span style={{ fontSize: 11, color: colors.textMuted, minWidth: 80, whiteSpace: "nowrap" }}>{to12h(e.start)}–{to12h(e.end)}</span>
                        <Tag color={subjectColor(e.subject)}>{e.subject}</Tag>
                        <Tag color={colors.accent}>{e.className}</Tag>
                        {e.notes && <span title={e.notes} style={{ fontSize: 11, color: colors.textMuted, cursor: "help" }}>📝</span>}
                        <div style={{ flex: 1 }} />
                        <button onClick={() => editEntry(e)} style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 12, padding: "2px 4px" }}>✏️</button>
                        <button onClick={() => deleteEntry(e.id)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 14, padding: "2px 4px" }}>×</button>
                      </div>
                    ))}
                  </div>
                );
              }
            })();

            return (
              <div key={id} style={{ marginBottom: 8, borderRadius: 10, overflow: "hidden", border: `1px solid ${colors.borderLight}` }}>
                {/* Banner header — click to toggle */}
                <div
                  onClick={() => toggleBanner(id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: colors.sidebarActive, color: "#fff", cursor: "pointer", userSelect: "none" }}>
                  <span style={{ fontSize: 16 }}>🏫</span>
                  <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{name}</span>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginRight: 8 }}>{entries.length} {entries.length === 1 ? "entry" : "entries"}</span>
                  {/* Day / Class mode buttons */}
                  <button
                    onClick={e => setBannerMode(id, "day", e)}
                    style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: `1px solid ${mode === "day" && isOpen ? "#fff" : "rgba(255,255,255,0.35)"}`, background: mode === "day" && isOpen ? "rgba(255,255,255,0.22)" : "transparent", color: "#fff" }}>
                    Day
                  </button>
                  <button
                    onClick={e => setBannerMode(id, "class", e)}
                    style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", border: `1px solid ${mode === "class" && isOpen ? "#fff" : "rgba(255,255,255,0.35)"}`, background: mode === "class" && isOpen ? "rgba(255,255,255,0.22)" : "transparent", color: "#fff" }}>
                    Class
                  </button>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", marginLeft: 4 }}>{isOpen ? "▲" : "▼"}</span>
                </div>
                {/* Collapsible content */}
                {isOpen && (
                  <div style={{ padding: "14px 16px", background: colors.white }}>
                    {displayContent}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      <Card style={{ marginTop: 20, background: colors.accentLight, borderColor: colors.accent + "40" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.accentDark, marginBottom: 6 }}>📋 Import Tips</div>
        <div style={{ fontSize: 12, color: colors.accentDark, lineHeight: 1.8 }}>
          Both PDF and spreadsheet imports let you add <strong>instructions</strong> to guide the AI. Use them to specify:
          <br />• What class names look like (e.g. "Prep A", "1/2B", "3/4C")
          <br />• Which subjects to extract or ignore (e.g. "ignore Assembly and Library")
          <br />• How to interpret times (e.g. "P1 = 9:00–9:50, P2 = 9:50–10:40")
          <br />• Any other specifics about the document layout
          <br /><br /><strong>Spreadsheet columns:</strong> class, day, start, end, subject (optional: school, notes). Skip instructions if columns already match.
        </div>
      </Card>
    </div>
  );
}


// ============================================================
// INTERRUPTIONS MANAGER
// ============================================================
function InterruptionsManager({ interruptions, setInterruptions, schools, specialists, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(null);
  const filterSchool = (viewState || {}).filterSchool || "";
  const setFilterSchool = (v) => setViewState(prev => ({ ...prev, filterSchool: v }));
  const filterType = (viewState || {}).filterType || "";
  const setFilterType = (v) => setViewState(prev => ({ ...prev, filterType: v }));
  const [fetching, setFetching] = useState(null);
  const [scanUrl, setScanUrl] = useState("");
  const [scanInstructions, setScanInstructions] = useState("");
  const [scanSchoolId, setScanSchoolId] = useState("");
  const [swimInstructions, setSwimInstructions] = useState("");
  const [swimSchoolId, setSwimSchoolId] = useState("");
  const [swimScanUrl, setSwimScanUrl] = useState("");
  const [swimScanInstructions, setSwimScanInstructions] = useState("");
  const [naplanInstructions, setNaplanInstructions] = useState("");
  const [naplanSchoolId, setNaplanSchoolId] = useState("");
  const [naplanScanUrl, setNaplanScanUrl] = useState("");
  const [naplanScanInstructions, setNaplanScanInstructions] = useState("");
  const [addExpanded, setAddExpanded] = useState(false);
  const [upcomingExpanded, setUpcomingExpanded] = useState(false);
  const [preview, setPreview] = useState(null);
  const swimRef = useRef(null);
  const naplanRef = useRef(null);
  const importRef = useRef(null);
  const [importMode, setImportMode] = useState(null); // null | "pdf" | "spreadsheet"
  const [importInstructions, setImportInstructions] = useState("");
  const [importSchoolId, setImportSchoolId] = useState("");
  const [importing, setImporting] = useState(false);
  const [overviewSchool, setOverviewSchool] = useState("");
  const [overviewType, setOverviewType] = useState("");

  useEffect(() => { setForm(null); setEditing(null); setFetching(null); setPreview(null); setImportMode(null); }, [resetKey]);

  const INTERRUPTION_TYPES = [
    { value: "public_holiday", label: "Public Holiday", color: "#C45454" },
    { value: "student_free", label: "Student Free / Curriculum Day", color: "#C47A6A" },
    { value: "excursion", label: "Excursion / Incursion", color: "#5B8BD4" },
    { value: "carnival", label: "Athletics / Swimming Carnival", color: "#4A9B6E" },
    { value: "swimming", label: "Swimming Program", color: "#3B9EC4" },
    { value: "concert", label: "Concert / Performance", color: "#D45BA8" },
    { value: "camp", label: "Camp", color: "#5BBDD4" },
    { value: "assembly", label: "Assembly / Special Event", color: "#C4A05B" },
    { value: "photos", label: "School Photos", color: "#9B8EC4" },
    { value: "other", label: "Other", color: "#8B8B8B" }
  ];

  const getTypeInfo = (type) => INTERRUPTION_TYPES.find(t => t.value === type) || INTERRUPTION_TYPES[INTERRUPTION_TYPES.length - 1];

  const today = melbourneToday();

  // ---- AUTO-PURGE PAST EVENTS & MIGRATE TIME DATA on mount ----
  useEffect(() => {
    let changed = false;
    let updated = [...interruptions];

    // Purge past events (but keep term_break and public_holiday — they're needed for week numbering)
    const before = updated.length;
    updated = updated.filter(i => {
      if (i.type === "term_break" || i.type === "public_holiday") return true;
      const endDate = i.endDate || i.date;
      return !endDate || endDate >= today;
    });
    if (updated.length !== before) changed = true;

    // Migrate: move times from notes into startTime/endTime fields
    updated = updated.map(i => {
      if (!i.startTime && i.notes) {
        const timeMatch = i.notes.match(/^(\d{1,2}:\d{2})\s*[\u2013\-–]\s*(\d{1,2}:\d{2})$/);
        if (timeMatch) {
          changed = true;
          return { ...i, startTime: timeMatch[1], endTime: timeMatch[2], notes: "" };
        }
      }
      return i;
    });

    if (changed) setInterruptions(updated);
  }, []);

  // ---- TERM DATE HELPERS ----
  // Get stored term breaks to determine what's "in term"
  const termBreaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));

  const isWithinTerm = (dateStr) => {
    if (!dateStr || termBreaks.length === 0) return true; // no term data = show everything
    // A date is within term if it's NOT inside any term break period
    for (const tb of termBreaks) {
      if (dateStr >= tb.date && dateStr <= (tb.endDate || tb.date)) return false;
    }
    return true;
  };

  // Visible interruptions: exclude term_break entries, exclude public holidays outside terms, exclude past
  const visibleInterruptions = interruptions.filter(i => {
    if (i.type === "term_break") return false;
    if (i.type === "public_holiday" && !isWithinTerm(i.date)) return false;
    const endDate = i.endDate || i.date;
    if (endDate && endDate < today) return false;
    return true;
  });

  // ---- FETCH VIC TERM DATES & PUBLIC HOLIDAYS ----
  const fetchTermDatesAndHolidays = async () => {
    setFetching("terms");
    try {
      const currentYear = melbourneNow().getFullYear();
      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{
            role: "user",
            content: `Search for the current Victorian (Australia) school term dates for ${currentYear} and ${currentYear + 1}, plus all Victorian public holidays for those years.

Return ONLY a JSON array of date entries with NO other text, NO markdown backticks. Each entry should have:
- date: "YYYY-MM-DD" format
- endDate: "YYYY-MM-DD" format (same as date for single-day events, or end date for term breaks)
- title: descriptive name
- type: one of "public_holiday" or "term_break"

Include:
- All 4 term start/end dates (as term_break entries for the gaps BETWEEN terms — i.e. school holiday periods)
- All Victorian public holidays including: New Year's Day, Australia Day, Labour Day, Good Friday, Saturday before Easter, Easter Sunday, Easter Monday, Anzac Day, King's Birthday, Friday before AFL Grand Final, Melbourne Cup Day (metro only), Christmas Day, Boxing Day
- Any other gazetted public holidays

For term breaks, create entries spanning the entire break period (e.g. the gap between Term 1 end and Term 2 start).

Return the JSON array only.`
          }]
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      const textContent = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";

      let cleaned = textContent.replace(/```json|```/g, "").trim();
      let entries;
      try {
        // Try to find JSON array in response
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        entries = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(cleaned);
      } catch(e) {
        const lastObj = cleaned.lastIndexOf("}");
        if (lastObj > 0) {
          let recovered = cleaned.substring(0, lastObj + 1);
          if (!recovered.trim().endsWith("]")) recovered += "]";
          if (!recovered.trim().startsWith("[")) recovered = "[" + recovered;
          entries = JSON.parse(recovered);
        } else {
          throw new Error("Could not parse response");
        }
      }

      if (!Array.isArray(entries) || entries.length === 0) {
        notify("Could not find term dates. Try again later.", "warning");
        setFetching(null);
        return;
      }

      // Deduplicate against existing
      const existing = new Set(interruptions.map(i => `${i.date}|${i.title}`));
      const newEntries = entries
        .map(e => ({
          id: uid(),
          schoolId: "all",
          date: e.date || "",
          endDate: e.endDate || e.date || "",
          title: e.title || "",
          type: e.type || "public_holiday",
          affectsClasses: "all",
          startTime: "",
          endTime: "",
          notes: "",
          source: "auto-fetched"
        }))
        .filter(e => e.date && !existing.has(`${e.date}|${e.title}`))
        .filter(e => (e.endDate || e.date) >= today); // skip past dates

      if (newEntries.length === 0) {
        notify("Term dates and holidays are already up to date!", "success");
      } else {
        setInterruptions(prev => [...prev, ...newEntries]);
        const termCount = newEntries.filter(e => e.type === "term_break").length;
        const holCount = newEntries.filter(e => e.type === "public_holiday").length;
        notify(`Added ${termCount} term breaks and ${holCount} public holidays. Term breaks are stored but hidden from the list — public holidays only show if they fall within term time.`);
      }
    } catch (err) {
      console.error("Fetch error:", err);
      notify("Failed to fetch term dates: " + err.message, "danger");
    }
    setFetching(null);
  };

  // ---- SCAN URL ----
  const handleScanUrl = async () => {
    if (!scanUrl.trim()) { notify("Enter a URL to scan", "warning"); return; }

    setFetching("url");
    try {
      let userGuidance = "";
      if (scanInstructions.trim()) {
        userGuidance = `\n\nSPECIFIC INSTRUCTIONS FROM THE USER:\n---\n${scanInstructions.trim()}\n---`;
      }

      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 16000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{
            role: "user",
            content: `I need you to scan a web page for school events that could interrupt normal lesson timetables.

STEP 1: Visit this URL: ${scanUrl.trim()}
This may be a direct page, or it may be an archive/index page with links to newsletters or updates.

STEP 2: If this is an archive page (a list of newsletters, updates, or bulletins), find and follow the MOST RECENT link to get to the latest content.

STEP 3: Read the content and extract ANY dates or events that could interrupt the normal school timetable.

Look for:
- Student free days / curriculum days / pupil free days
- Excursions and incursions
- Athletics days, swimming carnivals, cross country
- Camps
- Concerts, performances, assemblies, presentation days
- School photos
- Parent-teacher interviews (if students are affected)
- Any other special events where normal classes won't run

For each event return:
- date: "YYYY-MM-DD" format (use the current year ${melbourneNow().getFullYear()} if not explicitly stated)
- endDate: "YYYY-MM-DD" (same as date for single-day, or end date for multi-day)
- title: descriptive name of the event
- type: one of "student_free", "excursion", "carnival", "concert", "camp", "assembly", "photos", "other"
- affectsClasses: "all" if whole school, or specific classes/grades affected (e.g. "Year 3/4", "Prep-Year 2")

After completing your research, output ONLY a JSON array at the very end. No markdown backticks. If no events found, return [].${userGuidance}`
          }]
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      const textContent = data.content?.filter(c => c.type === "text").map(c => c.text).join("\n") || "";

      let entries;
      const jsonMatch = textContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try { entries = JSON.parse(jsonMatch[0]); }
        catch(e) {
          const lastObj = jsonMatch[0].lastIndexOf("}");
          if (lastObj > 0) {
            entries = JSON.parse(jsonMatch[0].substring(0, lastObj + 1) + "]");
          }
        }
      }

      if (!entries || !Array.isArray(entries) || entries.length === 0) {
        notify("No timetable interruptions found at that URL. Try different instructions or a different page.", "warning");
        setFetching(null);
        return;
      }

      // Filter out past events
      const futureEntries = entries.filter(e => (e.endDate || e.date || "") >= today);

      if (futureEntries.length === 0) {
        notify("Found events but they're all in the past. Try a more recent newsletter.", "warning");
        setFetching(null);
        return;
      }

      setPreview({
        entries: futureEntries.map(e => ({
          id: uid(),
          schoolId: scanSchoolId || "all",
          date: e.date || "",
          endDate: e.endDate || e.date || "",
          title: e.title || "",
          type: e.type || "other",
          affectsClasses: e.affectsClasses || "all",
          startTime: e.start || "",
          endTime: e.end || "",
          notes: "",
          source: scanUrl.trim()
        })),
        source: scanUrl.trim()
      });
    } catch (err) {
      console.error("URL scan error:", err);
      notify("Failed to scan URL: " + err.message, "danger");
    }
    setFetching(null);
  };

  // ---- SWIMMING TIMETABLE UPLOAD ----
  const handleImportUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    e.target.value = "";
    setImporting(true);
    try {
      let userGuidance = "";
      if (importInstructions.trim()) userGuidance = "\n\nSPECIFIC INSTRUCTIONS FROM THE USER:\n---\n" + importInstructions.trim() + "\n---";
      let msgContent;
      const currentYear = melbourneNow().getFullYear();
      const basePrompt = "This document contains school event or interruption data. Extract ALL events that could interrupt normal lesson timetables.\n\nFor each event return:\n- date: \"YYYY-MM-DD\" format (use " + currentYear + " if year not specified)\n- endDate: \"YYYY-MM-DD\" (same as date for single-day events)\n- title: descriptive event name\n- type: one of \"student_free\", \"excursion\", \"carnival\", \"swimming\", \"concert\", \"camp\", \"assembly\", \"photos\", \"other\"\n- affectsClasses: \"all\" if whole school, or specific classes (e.g. \"3A, 3B\")\n- startTime: start time HH:MM 24-hour if available, else empty\n- endTime: end time HH:MM 24-hour if available, else empty\n\nRespond ONLY with a JSON array, no other text, no markdown backticks." + userGuidance;
      if (importMode === "pdf") {
        const base64Data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("Failed to read file")); r.readAsDataURL(files[0]); });
        msgContent = [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } }, { type: "text", text: basePrompt }];
      } else {
        const XLSX = await getXLSX();
        const rawData = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = (ev) => {
            try {
              const wb = XLSX.read(ev.target.result, { type: "binary" });
              const ws = wb.Sheets[wb.SheetNames[0]];
              res(XLSX.utils.sheet_to_json(ws, { defval: "" }));
            } catch(err2) { rej(err2); }
          };
          r.onerror = () => rej(new Error("Failed to read file"));
          r.readAsBinaryString(files[0]);
        });
        msgContent = [{ type: "text", text: "I have a spreadsheet with school event data. Here are the rows:\n\n" + JSON.stringify(rawData) + "\n\n" + basePrompt }];
      }
      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: getAnthropicHeaders(),
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 16000, messages: [{ role: "user", content: msgContent }] })
      });
      if (!response.ok) throw new Error("API error: " + response.status);
      const data = await response.json();
      const textContent = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const cleaned = textContent.replace(/```json|```/g, "").trim();
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      const entries = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(cleaned);
      if (!Array.isArray(entries) || entries.length === 0) { notify("No events found in file.", "warning"); setImporting(false); return; }
      const targetSchool = importSchoolId || (schools.length === 1 ? schools[0].id : "all");
      setPreview({ entries: entries.map(e => ({ id: uid(), schoolId: targetSchool, date: e.date || "", endDate: e.endDate || e.date || "", title: e.title || "", type: e.type || "other", affectsClasses: e.affectsClasses || "all", startTime: e.startTime || "", endTime: e.endTime || "", notes: "", source: "import: " + files[0].name })), source: files[0].name });
      setImportMode(null);
    } catch(err) { notify("Import failed: " + err.message, "danger"); }
    setImporting(false);
  };

  const handleSwimUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";

    setFetching("swim");
    try {
      const base64Data = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(",")[1]);
        reader.onerror = () => rej(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });

      let userGuidance = "";
      if (swimInstructions.trim()) {
        userGuidance = `\n\nSPECIFIC INSTRUCTIONS FROM THE USER:\n---\n${swimInstructions.trim()}\n---`;
      }

      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 16000,
          messages: [{
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
              { type: "text", text: `This PDF contains a school swimming program timetable. It shows which classes go swimming on which days and times over a period (usually 1-2 weeks).

Extract ALL swimming session entries. Each entry represents a class going to swimming at a particular date and time.

For each entry return:
- date: "YYYY-MM-DD" format (use ${melbourneNow().getFullYear()} if year not specified)
- endDate: same as date for single sessions
- title: descriptive name, e.g. "Swimming - 3A" or "Swimming Program - Prep B"
- type: "swimming"
- affectsClasses: the class or classes attending that session (e.g. "3A", "Prep A, Prep B", "Year 5/6")
- start: start time in HH:MM 24-hour format if available
- end: end time in HH:MM 24-hour format if available

Rules:
- Extract EVERY session for EVERY class across ALL days of the program
- If times are in 12-hour format, convert to 24-hour
- Use the exact class names as shown in the document
- If a date range is given (e.g. "Week of March 10"), create individual entries for each day
- If you can't determine exact dates but know the week, estimate using Monday-Friday

Respond ONLY with a JSON array, no other text, no markdown backticks.${userGuidance}` }
            ]
          }]
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();
      const textContent = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
      const cleaned = textContent.replace(/```json|```/g, "").trim();

      let entries;
      try { entries = JSON.parse(cleaned); }
      catch(e) {
        const lastObj = cleaned.lastIndexOf("}");
        if (lastObj > 0) {
          let recovered = cleaned.substring(0, lastObj + 1);
          if (!recovered.trim().endsWith("]")) recovered += "]";
          entries = JSON.parse(recovered);
          notify(`Response was truncated — recovered ${entries.length} entries.`, "warning");
        } else {
          throw new Error("Could not parse AI response");
        }
      }

      if (!Array.isArray(entries) || entries.length === 0) {
        notify("Could not extract swimming sessions. Try adding more specific instructions.", "warning");
        setFetching(null);
        return;
      }

      const targetSchool = swimSchoolId || (schools.length === 1 ? schools[0].id : "all");

      setPreview({
        entries: entries.map(e => ({
          id: uid(),
          schoolId: targetSchool,
          date: e.date || "",
          endDate: e.endDate || e.date || "",
          title: e.title || "Swimming Program",
          type: "swimming",
          affectsClasses: e.affectsClasses || "all",
          startTime: e.start || "",
          endTime: e.end || "",
          notes: "",
          source: "swimming: " + file.name
        })),
        source: "Swimming Timetable: " + file.name
      });
    } catch (err) {
      console.error("Swimming upload error:", err);
      notify("Failed to process swimming timetable: " + err.message, "danger");
    }
    setFetching(null);
  };

  // ---- SWIMMING URL SCAN ----
  const handleSwimScan = async () => {
    if (!swimScanUrl.trim()) { notify("Enter a URL to scan", "warning"); return; }
    setFetching("swim");
    try {
      let userGuidance = swimScanInstructions.trim() ? "\n\nSPECIFIC INSTRUCTIONS FROM THE USER:\n---\n" + swimScanInstructions.trim() + "\n---" : "";
      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 16000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: "Visit this URL and extract all swimming program sessions: " + swimScanUrl.trim() + "\n\nFor each session return:\n- date: \"YYYY-MM-DD\"\n- endDate: same as date\n- title: e.g. \"Swimming - 3A\"\n- type: \"swimming\"\n- affectsClasses: class or classes attending\n- start/end: HH:MM 24hr if available\n\nRespond ONLY with a JSON array, no markdown backticks." + userGuidance }]
        })
      });
      if (!response.ok) throw new Error("API error: " + response.status);
      const data = await response.json();
      const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const match = text.match(/\[[\s\S]*\]/);
      const entries = match ? JSON.parse(match[0]) : [];
      if (!Array.isArray(entries) || entries.length === 0) { notify("No swimming sessions found at that URL.", "warning"); setFetching(null); return; }
      const targetSchool = swimSchoolId || (schools.length === 1 ? schools[0].id : "all");
      setPreview({ entries: entries.map(e => ({ id: uid(), schoolId: targetSchool, date: e.date || "", endDate: e.endDate || e.date || "", title: e.title || "Swimming Program", type: "swimming", affectsClasses: e.affectsClasses || "all", startTime: e.start || "", endTime: e.end || "", notes: "", source: swimScanUrl.trim() })), source: "Swimming Scan: " + swimScanUrl.trim() });
    } catch(err) { notify("Failed to scan URL: " + err.message, "danger"); }
    setFetching(null);
  };

  // ---- NAPLAN UPLOAD ----
  const handleNaplanUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    setFetching("naplan");
    try {
      const base64Data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("Failed to read file")); r.readAsDataURL(file); });
      let userGuidance = naplanInstructions.trim() ? "\n\nSPECIFIC INSTRUCTIONS FROM THE USER:\n---\n" + naplanInstructions.trim() + "\n---" : "";
      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 16000,
          messages: [{ role: "user", content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
            { type: "text", text: "This PDF contains a NAPLAN testing timetable. Extract ALL NAPLAN test sessions. For each session return:\n- date: \"YYYY-MM-DD\" (use " + melbourneNow().getFullYear() + " if year not specified)\n- endDate: same as date\n- title: descriptive name e.g. \"NAPLAN - Writing - Year 3\"\n- type: \"other\"\n- affectsClasses: year levels or classes affected (e.g. \"Year 3, Year 5\")\n- start/end: HH:MM 24hr if available\n\nRespond ONLY with a JSON array, no markdown backticks." + userGuidance }
          ]}]
        })
      });
      if (!response.ok) throw new Error("API error: " + response.status);
      const data = await response.json();
      const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const match = text.replace(/```json|```/g, "").trim().match(/\[[\s\S]*\]/);
      const entries = match ? JSON.parse(match[0]) : [];
      if (!Array.isArray(entries) || entries.length === 0) { notify("No NAPLAN sessions found in file.", "warning"); setFetching(null); return; }
      const targetSchool = naplanSchoolId || (schools.length === 1 ? schools[0].id : "all");
      setPreview({ entries: entries.map(e => ({ id: uid(), schoolId: targetSchool, date: e.date || "", endDate: e.endDate || e.date || "", title: e.title || "NAPLAN", type: e.type || "other", affectsClasses: e.affectsClasses || "all", startTime: e.start || "", endTime: e.end || "", notes: "", source: "naplan: " + file.name })), source: "NAPLAN Timetable: " + file.name });
    } catch(err) { notify("Failed to process NAPLAN timetable: " + err.message, "danger"); }
    setFetching(null);
  };

  // ---- NAPLAN URL SCAN ----
  const handleNaplanScan = async () => {
    if (!naplanScanUrl.trim()) { notify("Enter a URL to scan", "warning"); return; }
    setFetching("naplan");
    try {
      let userGuidance = naplanScanInstructions.trim() ? "\n\nSPECIFIC INSTRUCTIONS FROM THE USER:\n---\n" + naplanScanInstructions.trim() + "\n---" : "";
      const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: getAnthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 16000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: "Visit this URL and extract all NAPLAN test sessions: " + naplanScanUrl.trim() + "\n\nFor each session return:\n- date: \"YYYY-MM-DD\"\n- endDate: same as date\n- title: e.g. \"NAPLAN - Writing - Year 3\"\n- type: \"other\"\n- affectsClasses: year levels affected\n- start/end: HH:MM 24hr if available\n\nRespond ONLY with a JSON array, no markdown backticks." + userGuidance }]
        })
      });
      if (!response.ok) throw new Error("API error: " + response.status);
      const data = await response.json();
      const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const match = text.match(/\[[\s\S]*\]/);
      const entries = match ? JSON.parse(match[0]) : [];
      if (!Array.isArray(entries) || entries.length === 0) { notify("No NAPLAN sessions found at that URL.", "warning"); setFetching(null); return; }
      const targetSchool = naplanSchoolId || (schools.length === 1 ? schools[0].id : "all");
      setPreview({ entries: entries.map(e => ({ id: uid(), schoolId: targetSchool, date: e.date || "", endDate: e.endDate || e.date || "", title: e.title || "NAPLAN", type: e.type || "other", affectsClasses: e.affectsClasses || "all", startTime: e.start || "", endTime: e.end || "", notes: "", source: naplanScanUrl.trim() })), source: "NAPLAN Scan: " + naplanScanUrl.trim() });
    } catch(err) { notify("Failed to scan URL: " + err.message, "danger"); }
    setFetching(null);
  };

  // ---- Import preview helpers ----
  const confirmImport = () => {
    if (!preview) return;
    const existing = new Set(interruptions.map(i => `${i.date}|${i.title}`));
    const newEntries = preview.entries.filter(e => e.date && e.title && !existing.has(`${e.date}|${e.title}`));
    const dupes = preview.entries.length - newEntries.length;

    setInterruptions(prev => [...prev, ...newEntries]);
    notify(`Added ${newEntries.length} interruptions${dupes > 0 ? ` (${dupes} duplicates skipped)` : ""}`);
    setPreview(null);
  };


    const updatePreviewEntry = (idx, key, val) => {
    setPreview(prev => { const entries = [...prev.entries]; entries[idx] = { ...entries[idx], [key]: val }; return { ...prev, entries }; });
  };

  const removePreviewEntry = (idx) => {
    setPreview(prev => ({ ...prev, entries: prev.entries.filter((_, i) => i !== idx) }));
  };

  const updateAllPreviewSchool = (schoolId) => {
    setPreview(prev => ({ ...prev, entries: prev.entries.map(e => ({ ...e, schoolId })) }));
  };

  // ---- MANUAL ENTRY ----
  const newEntry = () => {
    setForm({
      id: uid(), schoolId: "all", date: "", endDate: "", title: "",
      type: "other", affectsClasses: "all", startTime: "", endTime: "", notes: "", source: "manual"
    });
    setEditing("new");
  };

  const editEntry = (entry) => { setForm({ ...entry }); setEditing(entry.id); };

  const saveEntry = () => {
    if (!form.date) { notify("Date required", "warning"); return; }
    if (!form.title.trim()) { notify("Title required", "warning"); return; }
    const entry = { ...form, endDate: form.endDate || form.date };
    if (editing === "new") { setInterruptions(prev => [...prev, entry]); }
    else { setInterruptions(prev => prev.map(i => i.id === entry.id ? entry : i)); }
    setForm(null); setEditing(null);
    notify("Interruption saved!");
  };

  const deleteEntry = (id) => { setInterruptions(prev => prev.filter(i => i.id !== id)); notify("Removed"); };

  const clearAll = () => {
    // Keep term_break entries (they're hidden but needed for filtering)
    setInterruptions(prev => prev.filter(i => i.type === "term_break"));
    notify("All visible interruptions cleared (term date data retained)");
  };

  // ---- FILTERED & SORTED DATA ----
  const filtered = visibleInterruptions.filter(i => {
    if (filterSchool && i.schoolId !== filterSchool && i.schoolId !== "all") return false;
    if (filterType && i.type !== filterType) return false;
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));

  // Group by month
  const groupedByMonth = {};
  for (const item of filtered) {
    const monthKey = item.date ? item.date.substring(0, 7) : "unknown";
    const monthLabel = item.date ? new Date(item.date + "T00:00:00").toLocaleDateString("en-AU", { month: "long", year: "numeric" }) : "Unknown Date";
    if (!groupedByMonth[monthKey]) groupedByMonth[monthKey] = { label: monthLabel, items: [] };
    groupedByMonth[monthKey].items.push(item);
  }

  const hasTermData = termBreaks.length > 0;

  // ==== RENDER: IMPORT MODE ====
  if (importMode) {
    return (
      <div>
        <PageTitle subtitle={importMode === "pdf" ? "Upload a PDF with school events" : "Upload a spreadsheet with school events"}>Import Interruptions</PageTitle>
        <Card>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <button onClick={() => setImportMode("pdf")} style={{ flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer", border: "2px solid " + (importMode === "pdf" ? colors.accent : colors.border), background: importMode === "pdf" ? colors.accentLight : colors.white, color: importMode === "pdf" ? colors.accentDark : colors.text, fontWeight: 600 }}>📄 PDF Document</button>
            <button onClick={() => setImportMode("spreadsheet")} style={{ flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer", border: "2px solid " + (importMode === "spreadsheet" ? colors.accent : colors.border), background: importMode === "spreadsheet" ? colors.accentLight : colors.white, color: importMode === "spreadsheet" ? colors.accentDark : colors.text, fontWeight: 600 }}>📁 Spreadsheet (CSV/XLSX)</button>
          </div>
          {schools.length > 1 && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Default School <span style={{ fontWeight: 400, textTransform: "none" }}>(if not specified in file)</span></label>
              <select value={importSchoolId} onChange={e => setImportSchoolId(e.target.value)} style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">Auto-detect / All schools</option>
                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Import Instructions <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label>
            <textarea value={importInstructions} onChange={e => setImportInstructions(e.target.value)} rows={5}
              placeholder={importMode === "pdf" ? "Examples:\n• Only extract events from the \"Term 2 Calendar\" section\n• \"PD Day\' means student free day\n• Ignore parent-teacher interview entries\n• All events are for the whole school unless a class is listed" : "Examples:\n• Column 'Event' is the title\n• 'SD' means student free day\n• Date format is DD/MM/YYYY\n• 'All' in the class column means whole school"}
              style={{ width: "100%", padding: "12px 14px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 14, fontFamily: "inherit", background: colors.inputBg, color: colors.text, resize: "vertical", boxSizing: "border-box", lineHeight: 1.6 }} />
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input ref={importRef} type="file" accept={importMode === "pdf" ? ".pdf" : ".csv,.xlsx,.xls"} onChange={handleImportUpload} style={{ display: "none" }} />
            {importing ? <span style={{ fontSize: 13, color: colors.textMuted }}>⏳ Processing...</span> : <Btn onClick={() => importRef.current?.click()}>{importMode === "pdf" ? "📄 Select PDF File" : "📁 Select Spreadsheet"}</Btn>}
            <Btn variant="secondary" onClick={() => setImportMode(null)}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: FETCHING ====
  if (fetching) {
    return (
      <div>
        <PageTitle>Interruptions</PageTitle>
        <Card style={{ background: "#FFF8F0", borderColor: colors.accent + "40" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontSize: 28 }}>⏳</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, color: colors.accent }}>
                {fetching === "terms" ? "Fetching Victorian term dates & public holidays..."
                  : fetching === "swim" ? "Processing swimming timetable..."
                  : fetching === "naplan" ? "Processing NAPLAN timetable..."
                  : "Scanning URL for events..."}
              </div>
              <div style={{ fontSize: 13, color: colors.textLight, marginTop: 4 }}>
                {fetching === "terms"
                  ? "Searching for the latest school calendar data. This may take 15–30 seconds."
                  : fetching === "swim"
                  ? "AI is reading the swimming program PDF and extracting each class session with dates and times."
                  : fetching === "naplan"
                  ? "AI is reading the NAPLAN timetable and extracting each session with dates, times, and affected classes."
                  : "AI is visiting the page, following the most recent link if it's an archive, and extracting event dates. This may take 20–40 seconds."}
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: PREVIEW ====
  if (preview) {
    return (
      <div>
        <PageTitle subtitle={`Found ${preview.entries.length} upcoming events — review, assign to a school, and import`}>Review Scanned Events</PageTitle>

        {/* Assign all to school */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: colors.textLight, whiteSpace: "nowrap" }}>Assign all to:</label>
            <select value={preview.entries[0]?.schoolId || "all"} onChange={e => updateAllPreviewSchool(e.target.value)}
              style={{ flex: 1, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
              <option value="all">All Schools</option>
              {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 6 }}>
            Source: {preview.source}
          </div>
        </Card>

        <Card style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: colors.bg, borderBottom: `1px solid ${colors.border}`, position: "sticky", top: 0, zIndex: 1 }}>
                  {["Date", "End Date", "Title", "Type", "From", "To", "Affects", "School", ""].map((h, hi) => (
                    <th key={hi} style={{ padding: "10px 8px", textAlign: "left", fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, background: colors.bg }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.entries.map((entry, i) => (
                  <tr key={entry.id} style={{ borderBottom: `1px solid ${colors.borderLight}` }}>
                    <td style={{ padding: "6px 8px" }}>
                      <input type="date" value={entry.date} onChange={e => updatePreviewEntry(i, "date", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input type="date" value={entry.endDate} onChange={e => updatePreviewEntry(i, "endDate", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input value={entry.title} onChange={e => updatePreviewEntry(i, "title", e.target.value)}
                        style={{ width: "100%", padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select value={entry.type} onChange={e => updatePreviewEntry(i, "type", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        {INTERRUPTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input type="time" value={entry.startTime || ""} onChange={e => updatePreviewEntry(i, "startTime", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input type="time" value={entry.endTime || ""} onChange={e => updatePreviewEntry(i, "endTime", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input value={entry.affectsClasses} onChange={e => updatePreviewEntry(i, "affectsClasses", e.target.value)}
                        style={{ width: 70, padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select value={entry.schoolId} onChange={e => updatePreviewEntry(i, "schoolId", e.target.value)}
                        style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        <option value="all">All Schools</option>
                        {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <button onClick={() => removePreviewEntry(i)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 16 }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={confirmImport}>✓ Import {preview.entries.length} Events</Btn>
          <Btn variant="secondary" onClick={() => setPreview(null)}>Cancel</Btn>
        </div>
      </div>
    );
  }

  // ==== HELPERS: class list from specialists ====
  const getClassesForSchool = (schoolId) => {
    if (!schoolId || schoolId === "all") {
      return [...new Set(specialists.map(s => s.className))].sort();
    }
    return [...new Set(specialists.filter(s => s.schoolId === schoolId).map(s => s.className))].sort();
  };

  const toggleFormClass = (cls) => {
    if (!form) return;
    const current = form.affectsClasses === "all" ? [] : form.affectsClasses.split(",").map(c => c.trim()).filter(Boolean);
    const updated = current.includes(cls) ? current.filter(c => c !== cls) : [...current, cls];
    setForm(p => ({ ...p, affectsClasses: updated.length === 0 ? "all" : updated.join(", ") }));
  };

  // ==== RENDER: MANUAL FORM ====
  if (form) {
    const selectedClasses = form.affectsClasses === "all" ? [] : form.affectsClasses.split(",").map(c => c.trim()).filter(Boolean);
    const isAllClasses = form.affectsClasses === "all";
    const availableClasses = getClassesForSchool(form.schoolId);

    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveEntry(); } }}>
        <PageTitle>{editing === "new" ? "Add Interruption" : "Edit Interruption"}</PageTitle>
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" }}>
            <Input label="Title" value={form.title} onChange={v => setForm(p => ({ ...p, title: v }))} placeholder="e.g. Athletics Carnival" />
            <Input label="Type" value={form.type} onChange={v => setForm(p => ({ ...p, type: v }))}
              options={INTERRUPTION_TYPES.map(t => ({ value: t.value, label: t.label }))} />
            <Input label="Date" value={form.date} onChange={v => setForm(p => ({ ...p, date: v }))} type="date" />
            <Input label="End Date (if multi-day)" value={form.endDate} onChange={v => setForm(p => ({ ...p, endDate: v }))} type="date" />
            <Input label="School" value={form.schoolId} onChange={v => setForm(p => ({ ...p, schoolId: v, affectsClasses: "all" }))}
              options={[{ value: "all", label: "All Schools" }, ...schools.map(s => ({ value: s.id, label: s.name }))]} />
          </div>

          {/* Time range (optional — mostly for swimming/excursions) */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px", marginBottom: 4 }}>
            <Input label="Start Time (optional)" value={form.startTime || ""} onChange={v => setForm(p => ({ ...p, startTime: v }))} type="time" />
            <Input label="End Time (optional)" value={form.endTime || ""} onChange={v => setForm(p => ({ ...p, endTime: v }))} type="time" />
          </div>

          {/* Affected Classes multi-select */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Affected Classes
            </label>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={isAllClasses} onChange={() => setForm(p => ({ ...p, affectsClasses: isAllClasses ? "" : "all" }))}
                  style={{ accentColor: colors.accent, width: 16, height: 16 }} />
                <span style={{ fontWeight: isAllClasses ? 600 : 400, color: isAllClasses ? colors.accent : colors.text }}>Whole School</span>
              </label>
              {!isAllClasses && selectedClasses.length > 0 && (
                <span style={{ fontSize: 12, color: colors.textMuted }}>{selectedClasses.length} class{selectedClasses.length !== 1 ? "es" : ""} selected</span>
              )}
            </div>

            {!isAllClasses && (
              <>
                {availableClasses.length > 0 ? (
                  <div style={{
                    display: "flex", flexWrap: "wrap", gap: 6, padding: 12,
                    background: colors.bg, borderRadius: 8, border: `1px solid ${colors.borderLight}`,
                    maxHeight: 180, overflowY: "auto"
                  }}>
                    {availableClasses.map(cls => {
                      const isSel = selectedClasses.includes(cls);
                      return (
                        <button key={cls} onClick={() => toggleFormClass(cls)}
                          style={{
                            padding: "5px 14px", borderRadius: 6, fontSize: 13, fontFamily: "inherit",
                            cursor: "pointer", transition: "all 0.1s",
                            border: isSel ? `2px solid ${colors.accent}` : `1px solid ${colors.inputBorder}`,
                            background: isSel ? colors.accent + "15" : colors.white,
                            color: isSel ? colors.accent : colors.text,
                            fontWeight: isSel ? 600 : 400
                          }}>
                          {cls}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "8px 0" }}>
                    No classes found in specialist data{form.schoolId && form.schoolId !== "all" ? " for this school" : ""}. Type class names manually below.
                  </div>
                )}
                <input
                  value={form.affectsClasses === "all" ? "" : form.affectsClasses}
                  onChange={e => setForm(p => ({ ...p, affectsClasses: e.target.value || "all" }))}
                  placeholder="Or type manually, e.g. 3A, 3B, 4A"
                  style={{ marginTop: 8, width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }}
                />
              </>
            )}
          </div>

          <Input label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} placeholder="Any details..." />
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveEntry}>Save</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); }}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: MAIN VIEW ====
  return (
    <div>
      <PageTitle subtitle={(() => {
        const upcomingBreaks = termBreaks.filter(tb => tb.date > today).sort((a, b) => a.date.localeCompare(b.date));
        const termEnd = upcomingBreaks.length > 0 ? upcomingBreaks[0].date : (today.substring(0, 4) + "-12-20");
        const termCount = visibleInterruptions.filter(i => i.date <= termEnd).length;
        return termCount + " Upcoming this term" + (hasTermData ? "" : " · No term data yet");
      })()} pageColor={PAGE_COLORS.interruptions}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
        action={null}>
        Interruptions
      </PageTitle>

      {/* ==== ADD INTERRUPTIONS COLLAPSIBLE BANNER ==== */}
      <div style={{ marginBottom: 16 }}>
        <div onClick={() => setAddExpanded(v => !v)}
          style={{ background: colors.sidebarActive, borderRadius: addExpanded ? "10px 10px 0 0" : 10, padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}>
          <span style={{ color: colors.white, fontWeight: 700, fontSize: 14 }}>+ Add Interruptions</span>
          <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 18, lineHeight: 1 }}>{addExpanded ? "▲" : "▼"}</span>
        </div>
        {addExpanded && (
          <div style={{ border: `1px solid ${colors.sidebarActive}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 20, display: "flex", flexDirection: "column", gap: 16, background: colors.white }}>
            {/* Add / Import buttons */}
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={newEntry}>+ Add Manually</Btn>
              <Btn variant="secondary" onClick={() => setImportMode("spreadsheet")}>Import File</Btn>
            </div>

            {/* Term dates card */}
            <Card style={{ padding: "14px 20px", border: `1px solid #D8D0F8`, display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 0 }}
              onClick={!hasTermData ? fetchTermDatesAndHolidays : undefined}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 22 }}>📅</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: colors.text }}>Victorian Term Dates & Public Holidays</div>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                    {hasTermData ? `${termBreaks.length} term break periods stored · Public holidays within term time are shown below` : "Not yet fetched — click to search for current term dates and public holidays"}
                  </div>
                </div>
              </div>
              <Btn variant="secondary" onClick={(e) => { e.stopPropagation(); fetchTermDatesAndHolidays(); }} style={{ fontSize: 12 }}>
                {hasTermData ? "↻ Refresh" : "Fetch Now"}
              </Btn>
            </Card>

            {/* URL Scanner */}
            <Card style={{ border: `1px solid #D0E8D8`, marginBottom: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <span style={{ fontSize: 22 }}>🔍</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: colors.text }}>Scan a URL for Interruptions</div>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>Provide a link to a school newsletter, events page, or calendar. If it's an archive, the AI will follow the most recent entry.</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <input value={scanUrl} onChange={e => setScanUrl(e.target.value)} placeholder="https://school.vic.edu.au/newsletters"
                  style={{ flex: 1, padding: "9px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit" }} />
                <Btn onClick={handleScanUrl} disabled={!scanUrl.trim()}>Scan</Btn>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <textarea value={scanInstructions} onChange={e => setScanInstructions(e.target.value)} rows={2}
                  placeholder="Optional instructions, e.g. 'Only look for Year 3-6 events' or 'Ignore weekly assemblies, only special events'"
                  style={{ flex: 1, padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical" }} />
                <select value={scanSchoolId} onChange={e => setScanSchoolId(e.target.value)}
                  style={{ padding: "9px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", minWidth: 160 }}>
                  <option value="">All Schools</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              {schools.some(s => s.newsletterUrl) && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${colors.borderLight}` }}>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 8 }}>Quick fill from school newsletter URLs:</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {schools.filter(s => s.newsletterUrl).map(s => (
                      <button key={s.id} onClick={() => { setScanUrl(s.newsletterUrl); setScanSchoolId(s.id); if (s.newsletterGuidance) setScanInstructions(s.newsletterGuidance); }}
                        style={{ padding: "5px 12px", border: `1px solid ${colors.accent}30`, borderRadius: 6, background: colors.accentLight, color: colors.accent, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* Upload/Scan Swimming Timetable */}
            <Card style={{ border: `1px solid #B0D8E8`, marginBottom: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <span style={{ fontSize: 22 }}>🏊</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: colors.text }}>Upload/Scan Swimming Timetable</div>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>Upload a PDF or scan a URL — AI will extract each class session with dates, times, and affected classes.</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                <select value={swimSchoolId} onChange={e => setSwimSchoolId(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", minWidth: 160 }}>
                  <option value="">Select school...</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input ref={swimRef} type="file" accept=".pdf" onChange={handleSwimUpload} style={{ display: "none" }} />
                <Btn variant="secondary" onClick={() => swimRef.current?.click()} style={{ fontSize: 13 }}>📄 Upload PDF</Btn>
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <input value={swimScanUrl} onChange={e => setSwimScanUrl(e.target.value)} placeholder="Or paste a URL to scan..."
                  style={{ flex: 1, padding: "9px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} />
                <Btn variant="secondary" onClick={handleSwimScan} disabled={!swimScanUrl.trim()} style={{ fontSize: 13 }}>Scan URL</Btn>
              </div>
              <textarea value={swimInstructions} onChange={e => setSwimInstructions(e.target.value)} rows={2}
                placeholder="Tips for the AI — e.g. 'Only extract Year 3-6 sessions', 'Dates start from March 10', 'Sessions are 45 minutes from listed start time'"
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }} />
              {swimScanUrl.trim() && (
                <div style={{ marginTop: 8 }}>
                  <textarea value={swimScanInstructions} onChange={e => setSwimScanInstructions(e.target.value)} rows={2}
                    placeholder="Additional URL scan tips — e.g. 'The timetable is in the attached PDF link on the page'"
                    style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }} />
                </div>
              )}
            </Card>

            {/* Upload/Scan NAPLAN Timetable */}
            <Card style={{ border: `1px solid #D4B8E8`, marginBottom: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <span style={{ fontSize: 22 }}>📝</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: colors.text }}>Upload/Scan NAPLAN Timetable</div>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>Upload a PDF or scan a URL — AI will extract each NAPLAN test session with dates, times, and affected year levels.</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                <select value={naplanSchoolId} onChange={e => setNaplanSchoolId(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", minWidth: 160 }}>
                  <option value="">Select school...</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input ref={naplanRef} type="file" accept=".pdf" onChange={handleNaplanUpload} style={{ display: "none" }} />
                <Btn variant="secondary" onClick={() => naplanRef.current?.click()} style={{ fontSize: 13 }}>📄 Upload PDF</Btn>
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <input value={naplanScanUrl} onChange={e => setNaplanScanUrl(e.target.value)} placeholder="Or paste a URL to scan..."
                  style={{ flex: 1, padding: "9px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} />
                <Btn variant="secondary" onClick={handleNaplanScan} disabled={!naplanScanUrl.trim()} style={{ fontSize: 13 }}>Scan URL</Btn>
              </div>
              <textarea value={naplanInstructions} onChange={e => setNaplanInstructions(e.target.value)} rows={2}
                placeholder="Tips for the AI — e.g. 'Only extract Year 3 and Year 5 sessions', 'Sessions run for 45 minutes', 'Catch-up sessions on the following Friday'"
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }} />
              {naplanScanUrl.trim() && (
                <div style={{ marginTop: 8 }}>
                  <textarea value={naplanScanInstructions} onChange={e => setNaplanScanInstructions(e.target.value)} rows={2}
                    placeholder="Additional URL scan tips"
                    style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }} />
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      {/* ==== FULL-TERM OVERVIEW ==== */}
      {(() => {
        // Calculate term week number for a given date
        const getTermWeekNumber = (dateStr) => {
          if (termBreaks.length === 0) return null;
          const d = new Date(dateStr + "T00:00:00");
          const year = d.getFullYear();

          // Helper: find Monday of the week containing a date
          const getMondayOf = (dt) => {
            const m = new Date(dt);
            const dow = m.getDay(); // 0=Sun
            const off = dow === 0 ? -6 : 1 - dow;
            m.setDate(m.getDate() + off);
            m.setHours(0, 0, 0, 0);
            return m;
          };

          // Helper: get Term 1 start (always the weekday after Australia Day, Jan 26)
          const getTerm1Start = () => {
            // Check if we have an Australia Day public holiday stored
            const ausDayHoliday = interruptions.find(i =>
              i.type === "public_holiday" &&
              i.date && i.date.startsWith(year + "-01-2")
            );
            if (ausDayHoliday) {
              const d = new Date(ausDayHoliday.date + "T00:00:00");
              d.setDate(d.getDate() + 1);
              while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
              return d;
            }
            // Fallback: first Tuesday on or after Jan 27
            const start = new Date(year, 0, 27);
            while (start.getDay() !== 2) start.setDate(start.getDate() + 1);
            return start;
          };

          // Find the most recent break that ended before this date
          let termStartDay = null;
          let breakEndMonth = -1;
          for (const tb of termBreaks) {
            const tbEnd = new Date((tb.endDate || tb.date) + "T00:00:00");
            if (tbEnd < d) {
              termStartDay = new Date(tbEnd);
              termStartDay.setDate(termStartDay.getDate() + 1);
              breakEndMonth = tbEnd.getMonth(); // 0=Jan
            }
          }

          // If the most recent break ended in Dec or Jan, we're in Term 1
          // Use the reliable Australia Day anchor instead of the AI's break end date
          if (!termStartDay || breakEndMonth === 11 || breakEndMonth === 0) {
            termStartDay = getTerm1Start();
          }

          // Week 1 Monday = Monday of the week containing term start
          const week1Monday = getMondayOf(termStartDay);
          // Target Monday = Monday of the week containing d
          const targetMonday = getMondayOf(d);

          // Week number = difference in whole weeks + 1
          const diffMs = targetMonday.getTime() - week1Monday.getTime();
          const diffWeeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
          return Math.max(1, diffWeeks + 1);
        };


        // Build full-term weeks from current week to end of current term
        const thisMonday = getCurrentWeekMonday();
        const upcomingBreaks = termBreaks.filter(tb => tb.date > today).sort((a, b) => a.date.localeCompare(b.date));
        const termEndDate = upcomingBreaks.length > 0
          ? new Date(upcomingBreaks[0].date + "T00:00:00")
          : new Date(today.substring(0, 4) + "-12-20T00:00:00");
        const msPerWeek = 7 * 24 * 60 * 60 * 1000;
        const weeksToEnd = Math.ceil((termEndDate - thisMonday) / msPerWeek);
        const numWeeks = Math.max(1, Math.min(weeksToEnd, 20));

        // After 6pm Friday of a week, that week is considered past — skip it
        const now = melbourneNow();
        const isFridayPast = (mondayDate) => {
          const fri = new Date(mondayDate);
          fri.setDate(mondayDate.getDate() + 4);
          fri.setHours(18, 0, 0, 0);
          return now > fri;
        };

        const weeks = [];
        let wIdx = 0;
        for (let w = 0; w < numWeeks; w++) {
          const weekStart = new Date(thisMonday);
          weekStart.setDate(thisMonday.getDate() + w * 7);
          if (isFridayPast(weekStart)) continue; // skip past weeks
          const days = [];
          for (let d = 0; d < 5; d++) {
            const date = new Date(weekStart);
            date.setDate(weekStart.getDate() + d);
            const dateStr = toLocalDateStr(date);
            days.push({ date, dateStr, dayName: ["Mon", "Tue", "Wed", "Thu", "Fri"][d], dayNum: date.getDate() });
          }
          const weekNum = getTermWeekNumber(days[0].dateStr);
          weeks.push({ days, weekNum, weekLabel: weekNum ? "Week " + weekNum : "Week " + (wIdx + 1) });
          wIdx++;
        }

        // Consolidate events for overview: group swimming by school+day
        const getOverviewEvents = (dateStr) => {
          const dayEvents = visibleInterruptions.filter(i => {
            if (overviewSchool && i.schoolId !== overviewSchool && i.schoolId !== "all") return false;
            if (overviewType && i.type !== overviewType) return false;
            const start = i.date;
            const end = i.endDate || i.date;
            return dateStr >= start && dateStr <= end;
          });

          // Group swimming entries by school
          const swimBySchool = {};
          const nonSwim = [];
          for (const ev of dayEvents) {
            if (ev.type === "swimming") {
              const key = ev.schoolId || "all";
              if (!swimBySchool[key]) swimBySchool[key] = ev;
            } else {
              // Prefix school-specific events with school acronym
              if (ev.schoolId && ev.schoolId !== "all") {
                const school = schools.find(s => s.id === ev.schoolId);
                if (school) {
                  const abbrev = school.name.split(" ").map(w => w[0]).join("").toUpperCase();
                  nonSwim.push({ ...ev, title: `${abbrev} - ${ev.title}` });
                } else {
                  nonSwim.push(ev);
                }
              } else {
                nonSwim.push(ev);
              }
            }
          }

          const consolidated = [...nonSwim];
          for (const [schoolId, ev] of Object.entries(swimBySchool)) {
            const school = schools.find(s => s.id === schoolId);
            const abbrev = school ? school.name.split(" ").map(w => w[0]).join("").toUpperCase() : "";
            consolidated.push({
              ...ev,
              title: school ? `${abbrev} - Swimming Program` : "Swimming Program",
              _consolidated: true
            });
          }
          return consolidated;
        };

        const isTermBreakDay = (dateStr) => {
          for (const tb of termBreaks) {
            if (dateStr >= tb.date && dateStr <= (tb.endDate || tb.date)) return true;
          }
          return false;
        };

        return (
          <Card style={{ marginBottom: 20, padding: 0, overflow: "hidden" }}>
            {/* Overview header with filters */}
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: colors.text }}>Term Overview</div>
              <div style={{ display: "flex", gap: 8 }}>
                <select value={overviewSchool} onChange={e => setOverviewSchool(e.target.value)}
                  style={{ padding: "5px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                  <option value="">All Schools</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select value={overviewType} onChange={e => setOverviewType(e.target.value)}
                  style={{ padding: "5px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                  <option value="">All Types</option>
                  {INTERRUPTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
            </div>

            {/* Week grid */}
            <div style={{ display: "grid", gridTemplateColumns: "80px repeat(5, 1fr)", fontSize: 12 }}>
              {/* Header row */}
              <div style={{ padding: "8px 12px", background: colors.sidebarActive, borderBottom: `1px solid ${colors.border}`, fontWeight: 600, color: colors.textMuted }} />
              {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map(d => (
                <div key={d} style={{ padding: "8px 6px", background: colors.sidebarActive, borderBottom: `1px solid ${colors.border}`, borderLeft: `1px solid ${colors.borderLight}`, fontWeight: 600, color: colors.white, textAlign: "center", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{d}</div>
              ))}

              {/* Week rows */}
              {weeks.map((week, wi) => (
                <div key={wi} style={{ display: "contents" }}>
                  {/* Week label */}
                  <div style={{
                    padding: "8px 12px", borderBottom: wi < weeks.length - 1 ? `1px solid ${colors.border}` : "none",
                    display: "flex", alignItems: "flex-start", justifyContent: "center", flexDirection: "column",
                    background: wi % 2 === 0 ? colors.white : "#EEF1F7"
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: colors.accent }}>{week.weekLabel}</div>
                    <div style={{ fontSize: 10, color: colors.textMuted, marginTop: 2 }}>
                      {week.days[0].date.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                    </div>
                  </div>

                  {/* Day cells */}
                  {week.days.map((day, di) => {
                    const events = getOverviewEvents(day.dateStr);
                    const isBreak = isTermBreakDay(day.dateStr);
                    const isToday = day.dateStr === today;

                    return (
                      <div key={di} style={{
                        padding: "6px 6px", minHeight: 60,
                        borderLeft: `1px solid ${colors.borderLight}`,
                        borderBottom: wi < weeks.length - 1 ? `1px solid ${colors.border}` : "none",
                        background: isBreak ? "#F5F0FF" : isToday ? "#FFFFF0" : wi % 2 === 0 ? colors.white : "#EEF1F7",
                        position: "relative"
                      }}>
                        <div style={{
                          fontSize: 10, color: isToday ? colors.accent : colors.textMuted, fontWeight: isToday ? 700 : 400,
                          marginBottom: 3
                        }}>
                          {day.dayNum}{isToday && " ●"}
                        </div>
                        {isBreak ? (
                          <div style={{ fontSize: 10, color: "#8B5CF6", fontStyle: "italic" }}>Holiday</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            {events.map((ev, ei) => {
                              const typeInfo = getTypeInfo(ev.type);
                              const timeStr = ev.startTime && ev.endTime ? `${ev.startTime}–${ev.endTime}` : "";
                              return (
                                <div key={ei} style={{
                                  padding: "2px 5px", borderRadius: 4, fontSize: 10, lineHeight: 1.3,
                                  background: typeInfo.color + "18", color: typeInfo.color,
                                  fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                                }} title={ev.title + (timeStr ? ` (${timeStr})` : "") + (ev.affectsClasses && ev.affectsClasses !== "all" ? ` [${ev.affectsClasses}]` : "")}>
                                  {ev.title}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </Card>
        );
      })()}



      {/* ==== UPCOMING COLLAPSIBLE BANNER ==== */}
      <div style={{ marginBottom: 16 }}>
        <div onClick={() => setUpcomingExpanded(v => !v)}
          style={{ background: colors.sidebarActive, borderRadius: upcomingExpanded ? "10px 10px 0 0" : 10, padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}>
          <span style={{ color: colors.white, fontWeight: 700, fontSize: 14 }}>
            Upcoming{filtered.length > 0 ? " (" + filtered.length + ")" : ""}
          </span>
          <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 18, lineHeight: 1 }}>{upcomingExpanded ? "▲" : "▼"}</span>
        </div>
        {upcomingExpanded && (
          <div style={{ border: `1px solid ${colors.sidebarActive}`, borderTop: "none", borderRadius: "0 0 10px 10px", padding: 20, background: colors.white }}>
            {/* Filters */}
            {visibleInterruptions.length > 0 && (
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
                <select value={filterSchool} onChange={e => setFilterSchool(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Schools</option>
                  {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select value={filterType} onChange={e => setFilterType(e.target.value)}
                  style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  <option value="">All Types</option>
                  {INTERRUPTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <div style={{ marginLeft: "auto", fontSize: 13, color: colors.textMuted }}>{filtered.length} shown</div>
                <Btn variant="danger" onClick={clearAll} style={{ fontSize: 12 }}>Clear All</Btn>
              </div>
            )}

            {/* List */}
            {filtered.length === 0 ? (
              <Card style={{ textAlign: "center", padding: "40px 20px", color: colors.textMuted }}>
                <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.5 }}>🚧</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: colors.textLight, marginBottom: 8 }}>
                  {visibleInterruptions.length === 0 ? "No upcoming interruptions" : "No interruptions match your filters"}
                </div>
                <div style={{ fontSize: 14, maxWidth: 480, margin: "0 auto" }}>
                  {visibleInterruptions.length === 0
                    ? "Scan a newsletter URL, fetch term dates, or add interruptions manually. Past events are automatically removed."
                    : "Try adjusting your school or type filter."}
                </div>
              </Card>
            ) : (
              Object.entries(groupedByMonth).sort(([a], [b]) => a.localeCompare(b)).map(([monthKey, { label, items }]) => (
                <div key={monthKey} style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: colors.textLight, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {items.map(item => {
                    const typeInfo = getTypeInfo(item.type);
                    const school = item.schoolId === "all" ? null : schools.find(s => s.id === item.schoolId);
                    const dateStr = item.date ? new Date(item.date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) : "?";
                    const isMultiDay = item.endDate && item.endDate !== item.date;
                    const endDateStr = isMultiDay ? new Date(item.endDate + "T00:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) : "";
                    return (
                      <div key={item.id} style={{
                        display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                        background: colors.white, borderRadius: 10, border: `1px solid ${colors.border}`,
                        borderLeft: `4px solid ${typeInfo.color}`
                      }}>
                        <div style={{ minWidth: 110, fontSize: 13, fontWeight: 600, color: colors.text }}>
                          {dateStr}
                          {isMultiDay && <div style={{ fontSize: 11, fontWeight: 400, color: colors.textMuted }}>→ {endDateStr}</div>}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>{item.title}</div>
                          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                            <Tag color={typeInfo.color}>{typeInfo.label}</Tag>
                            {school && <Tag color="#666">{school.name}</Tag>}
                            {item.schoolId === "all" && <Tag color="#8B5CF6">All Schools</Tag>}
                            {item.affectsClasses && item.affectsClasses !== "all" && (
                              <Tag color={colors.warning}>{item.affectsClasses}</Tag>
                            )}
                            {item.startTime && item.endTime && (
                              <Tag color="#3B9EC4">{item.startTime}–{item.endTime}</Tag>
                            )}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button onClick={() => editEntry(item)} style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 13, padding: 4 }}>✏️</button>
                          <button onClick={() => deleteEntry(item.id)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 16, padding: 4 }}>×</button>
                        </div>
                      </div>
                    );
                  })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}


// ============================================================
// SCHOOLS MANAGER
// ============================================================
function SchoolsManager({ schools, setSchools, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);

  useEffect(() => { setEditing(null); setForm(null); }, [resetKey]);

  const newSchool = () => {
    const f = {
      id: uid(), name: "", days: [...DAYS],
      slots: defaultSlots(),
      specialistPolicy: "prefer-not",
      teacherBreaks: [],
      newsletterUrl: "",
      newsletterGuidance: "",
      notes: ""
    };
    setForm(f);
    setEditing("new");
  };

  const editSchool = (school) => {
    setForm({ ...school, slots: school.slots.map(s => ({ ...s })), days: [...school.days], teacherBreaks: (school.teacherBreaks || []).map(b => ({ ...b })) });
    setEditing(school.id);
  };

  const saveSchool = () => {
    if (!form.name.trim()) { notify("School name required", "warning"); return; }
    if (editing === "new") {
      setSchools(prev => [...prev, form]);
    } else {
      setSchools(prev => prev.map(s => s.id === form.id ? form : s));
    }
    setForm(null);
    setEditing(null);
    notify("School saved!");
  };

  const deleteSchool = (id) => {
    setSchools(prev => prev.filter(s => s.id !== id));
    notify("School removed");
  };

  const updateSlot = (idx, key, val) => {
    setForm(prev => {
      const slots = [...prev.slots];
      slots[idx] = { ...slots[idx], [key]: val };
      return { ...prev, slots };
    });
  };

  const addSlot = () => {
    setForm(prev => ({
      ...prev,
      slots: [...prev.slots, { id: uid(), name: "", start: "09:00", end: "09:30", type: "class" }]
    }));
  };

  const removeSlot = (idx) => {
    setForm(prev => ({ ...prev, slots: prev.slots.filter((_, i) => i !== idx) }));
  };

  const addTeacherBreak = () => {
    setForm(prev => ({ ...prev, teacherBreaks: [...(prev.teacherBreaks || []), { id: uid(), start: "11:00", end: "11:30" }] }));
  };
  const updateTeacherBreak = (idx, key, val) => {
    setForm(prev => {
      const breaks = [...(prev.teacherBreaks || [])];
      breaks[idx] = { ...breaks[idx], [key]: val };
      return { ...prev, teacherBreaks: breaks };
    });
  };
  const removeTeacherBreak = (idx) => {
    setForm(prev => ({ ...prev, teacherBreaks: (prev.teacherBreaks || []).filter((_, i) => i !== idx) }));
  };

  const toggleDay = (day) => {
    setForm(prev => ({
      ...prev,
      days: prev.days.includes(day) ? prev.days.filter(d => d !== day) : [...prev.days, day]
    }));
  };

  const [slotGen, setSlotGen] = useState(null);
  const [schoolOpen, setSchoolOpen] = useState({});

  const initSlotGenerator = () => {
    setSlotGen({
      blocks: [
        { start: "08:30", end: "11:00" },
        { start: "11:10", end: "13:40" },
        { start: "14:00", end: "15:30" }
      ],
      duration: 30,
      includeBeforeSchool: false,
      beforeSchoolStart: "08:00",
      includeAfterSchool: false,
      afterSchoolStart: "15:30"
    });
  };

  const generateSlots = () => {
    if (!slotGen) return;
    const slots = [];
    let slotNum = 1;

    if (slotGen.includeBeforeSchool) {
      slots.push({ id: uid(), name: "Before School", start: slotGen.beforeSchoolStart,
        end: `${String(Math.floor((timeToMin(slotGen.beforeSchoolStart) + slotGen.duration) / 60)).padStart(2, "0")}:${String((timeToMin(slotGen.beforeSchoolStart) + slotGen.duration) % 60).padStart(2, "0")}`,
        type: "before_school" });
    }

    for (const block of slotGen.blocks) {
      let current = timeToMin(block.start);
      const end = timeToMin(block.end);
      while (current + slotGen.duration <= end) {
        const startStr = `${String(Math.floor(current / 60)).padStart(2, "0")}:${String(current % 60).padStart(2, "0")}`;
        const endMin = current + slotGen.duration;
        const endStr = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
        slots.push({ id: uid(), name: `Slot ${slotNum}`, start: startStr, end: endStr, type: "class" });
        slotNum++;
        current = endMin;
      }
    }

    if (slotGen.includeAfterSchool) {
      slots.push({ id: uid(), name: "After School", start: slotGen.afterSchoolStart,
        end: `${String(Math.floor((timeToMin(slotGen.afterSchoolStart) + slotGen.duration) / 60)).padStart(2, "0")}:${String((timeToMin(slotGen.afterSchoolStart) + slotGen.duration) % 60).padStart(2, "0")}`,
        type: "after_school" });
    }

    setForm(prev => ({ ...prev, slots }));
    setSlotGen(null);
    notify(`Generated ${slots.length} slots`);
  };

  if (form) {
    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveSchool(); } }}>
        <PageTitle subtitle="Configure school timetable structure" navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{editing === "new" ? "Add School" : "Edit School"}</PageTitle>
        <Card>
          <Input label="School Name" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder="e.g. Eastwood Primary" />

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Teaching Days</label>
            <div style={{ display: "flex", gap: 8 }}>
              {DAYS.map(d => (
                <button key={d} onClick={() => toggleDay(d)} style={{
                  padding: "6px 14px", borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer",
                  border: `1px solid ${form.days.includes(d) ? colors.accent : colors.border}`,
                  background: form.days.includes(d) ? colors.accentLight : colors.white,
                  color: form.days.includes(d) ? colors.accentDark : colors.textLight, fontWeight: 500
                }}>
                  {d.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>

          <Input label="Scheduling During Specialist Classes" value={form.specialistPolicy} onChange={v => setForm(p => ({ ...p, specialistPolicy: v }))}
            options={[
              { value: "yes", label: "Allow pulling students from specialist classes for music lessons" },
              { value: "prefer-not", label: "Allow if needed, but prefer to avoid" },
              { value: "no", label: "Never schedule during specialist classes" }
            ]} />
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: -8, marginBottom: 14, paddingLeft: 2 }}>
            💡 Specialist class times are managed separately in the "Specialist Classes" section — this setting controls whether the scheduler can pull students out of those classes.
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Teacher Breaks</label>
              <Btn variant="secondary" onClick={addTeacherBreak} style={{ fontSize: 12 }}>+ Add Break</Btn>
            </div>
            <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10, paddingLeft: 2 }}>
              ☕ Times when no teacher may have lessons at this school (e.g. staff meetings, yard duty). These override any individual teacher breaks set in the Teachers tab.
            </div>
            {(form.teacherBreaks || []).length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(form.teacherBreaks || []).map((brk, i) => (
                  <div key={brk.id || i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                    <input type="time" value={brk.start} onChange={e => updateTeacherBreak(i, "start", e.target.value)}
                      style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                    <span style={{ color: colors.textMuted, fontSize: 13 }}>to</span>
                    <input type="time" value={brk.end} onChange={e => updateTeacherBreak(i, "end", e.target.value)}
                      style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                    <button onClick={() => removeTeacherBreak(i)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 4 }}>×</button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px dashed ${colors.border}` }}>
                No breaks defined — teachers can be scheduled in any slot. Individual breaks can also be set per-teacher in the Teachers tab.
              </div>
            )}
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Time Slots / Periods</label>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn variant="ghost" onClick={initSlotGenerator} style={{ fontSize: 12 }}>📅 Generate Slots</Btn>
                <Btn variant="secondary" onClick={addSlot} style={{ fontSize: 12 }}>+ Add Slot</Btn>
              </div>
            </div>

            {/* Slot Generator */}
            {slotGen && (
              <Card style={{ marginBottom: 14, padding: 16, background: colors.accentLight, borderColor: colors.accent + "40" }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: colors.accentDark, marginBottom: 12 }}>📅 Slot Generator</div>
                <div style={{ fontSize: 12, color: colors.accentDark, marginBottom: 14 }}>
                  Define time blocks and a lesson duration. Slots will be generated continuously within each block, with gaps between blocks left for breaks.
                </div>

                <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight }}>Lesson duration:</label>
                  <select value={slotGen.duration} onChange={e => setSlotGen(prev => ({ ...prev, duration: parseInt(e.target.value) }))}
                    style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                    {[20, 25, 30, 35, 40, 45, 50, 60].map(d => <option key={d} value={d}>{d} min</option>)}
                  </select>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Time Blocks</label>
                    <Btn variant="ghost" onClick={() => setSlotGen(prev => ({ ...prev, blocks: [...prev.blocks, { start: "09:00", end: "12:00" }] }))} style={{ fontSize: 11 }}>+ Add Block</Btn>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {slotGen.blocks.map((block, i) => {
                      const slots = Math.floor((timeToMin(block.end) - timeToMin(block.start)) / slotGen.duration);
                      return (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", background: colors.white, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                          <input type="time" value={block.start} onChange={e => setSlotGen(prev => ({ ...prev, blocks: prev.blocks.map((b, idx) => idx === i ? { ...b, start: e.target.value } : b) }))}
                            style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                          <span style={{ color: colors.textMuted, fontSize: 13 }}>to</span>
                          <input type="time" value={block.end} onChange={e => setSlotGen(prev => ({ ...prev, blocks: prev.blocks.map((b, idx) => idx === i ? { ...b, end: e.target.value } : b) }))}
                            style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                          <span style={{ fontSize: 12, color: colors.textMuted, minWidth: 60 }}>→ {slots} slot{slots !== 1 ? "s" : ""}</span>
                          {slotGen.blocks.length > 1 && (
                            <button onClick={() => setSlotGen(prev => ({ ...prev, blocks: prev.blocks.filter((_, idx) => idx !== i) }))}
                              style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 2 }}>×</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={slotGen.includeBeforeSchool} onChange={e => setSlotGen(prev => ({ ...prev, includeBeforeSchool: e.target.checked }))} />
                    Before school at
                    <input type="time" value={slotGen.beforeSchoolStart} onChange={e => setSlotGen(prev => ({ ...prev, beforeSchoolStart: e.target.value }))}
                      style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", width: 90 }}
                      disabled={!slotGen.includeBeforeSchool} />
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={slotGen.includeAfterSchool} onChange={e => setSlotGen(prev => ({ ...prev, includeAfterSchool: e.target.checked }))} />
                    After school at
                    <input type="time" value={slotGen.afterSchoolStart} onChange={e => setSlotGen(prev => ({ ...prev, afterSchoolStart: e.target.value }))}
                      style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", width: 90 }}
                      disabled={!slotGen.includeAfterSchool} />
                  </label>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Btn onClick={generateSlots}>Generate {slotGen.blocks.reduce((sum, b) => sum + Math.floor((timeToMin(b.end) - timeToMin(b.start)) / slotGen.duration), 0) + (slotGen.includeBeforeSchool ? 1 : 0) + (slotGen.includeAfterSchool ? 1 : 0)} Slots</Btn>
                  <Btn variant="secondary" onClick={() => setSlotGen(null)}>Cancel</Btn>
                  <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 8 }}>⚠ This will replace all existing slots</span>
                </div>
              </Card>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {form.slots.map((slot, i) => (
                <div key={slot.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.borderLight}` }}>
                  <input value={slot.name} onChange={e => updateSlot(i, "name", e.target.value)} placeholder="Period name"
                    style={{ flex: 1, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                  <input type="time" value={slot.start} onChange={e => updateSlot(i, "start", e.target.value)}
                    style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                  <span style={{ color: colors.textMuted }}>—</span>
                  <input type="time" value={slot.end} onChange={e => updateSlot(i, "end", e.target.value)}
                    style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                  <select value={slot.type} onChange={e => updateSlot(i, "type", e.target.value)}
                    style={{ padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: colors.white }}>
                    {SLOT_TYPES.map(t => <option key={t} value={t}>{SLOT_TYPE_LABELS[t]}</option>)}
                  </select>
                  <button onClick={() => removeSlot(i)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 4 }}>×</button>
                </div>
              ))}
            </div>
          </div>

          <Input label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} multiline placeholder="Any additional notes about this school..." />

          <Input label="Newsletter URL" value={form.newsletterUrl || ""} onChange={v => setForm(p => ({ ...p, newsletterUrl: v }))} placeholder="e.g. https://schoolname.vic.edu.au/newsletters" />
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: -8, marginBottom: 8, paddingLeft: 2 }}>
            📰 Link to the school's newsletter page. Used in the Interruptions tab to scan for upcoming events.
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 6 }}>AI Scanning Guidance</div>
            <textarea
              value={form.newsletterGuidance || ""}
              onChange={e => setForm(p => ({ ...p, newsletterGuidance: e.target.value }))}
              rows={3}
              placeholder={"e.g. \"Follow the link to the latest newsletter PDF\", \"Look for dates in the calendar section at the bottom\", \"Check both the newsletter and the events page linked at the top\", \"Term 2 dates are May-June 2026\"..."}
              style={{ width: "100%", padding: "10px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
            />
            <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4, paddingLeft: 2 }}>
              These instructions are automatically sent to the AI when scanning this school's newsletter from the Interruptions tab.
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveSchool}>Save School</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); }}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageTitle subtitle="Configure schools with their timetable structure" pageColor={PAGE_COLORS.schools}
        navButtons={<><Btn onClick={newSchool} style={{ height: 34, fontSize: 13, padding: "0 14px", background: "rgba(255,255,255,0.15)", color: colors.white, border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6, fontWeight: 600 }}>+ Add School</Btn><NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} /></>}>
        Schools
      </PageTitle>

      {schools.length === 0 ? (
        <EmptyState icon="🏫" title="No schools yet" subtitle="Add your first school to define its timetable periods, break times, and constraints." action="+ Add School" onAction={newSchool} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {schools.map(school => {
            const isOpen = !!schoolOpen[school.id];
            return (
              <div key={school.id} style={{ borderRadius: 10, overflow: "hidden", border: `1px solid ${colors.borderLight}` }}>
                {/* Clickable banner */}
                <div
                  onClick={() => setSchoolOpen(prev => ({ ...prev, [school.id]: !prev[school.id] }))}
                  style={{ background: colors.sidebarActive, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}>
                  <span style={{ fontSize: 16 }}>🏫</span>
                  <span style={{ fontWeight: 700, fontSize: 15, color: colors.white, flex: 1 }}>{school.name}</span>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginRight: 4 }}>{school.slots.length} slots · {school.days.length} days</span>
                  <button onClick={e => { e.stopPropagation(); editSchool(school); }} title="Edit school"
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "3px 10px", borderRadius: 6, background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.25)", color: colors.white, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 }}>
                    ✏️ Edit
                  </button>
                  <button onClick={e => { e.stopPropagation(); deleteSchool(school.id); }} title="Remove school"
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6, background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.25)", color: colors.white, cursor: "pointer", flexShrink: 0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                  </button>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginLeft: 2 }}>{isOpen ? "▲" : "▼"}</span>
                </div>
                {/* Collapsible info */}
                {isOpen && (
                  <div style={{ padding: "12px 14px", background: colors.white }}>
                    <div style={{ fontSize: 13, color: colors.textLight, marginBottom: 6 }}>
                      {school.days.map(d => d.slice(0, 3)).join(", ")} · {school.slots.length} time slots ·
                      Specialist scheduling: {school.specialistPolicy === "yes" ? "allowed" : school.specialistPolicy === "no" ? "not allowed" : "allowed, prefer to avoid"}
                    </div>
                    {(school.teacherBreaks || []).length > 0 && (
                      <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 6 }}>
                        ☕ Teacher breaks: {school.teacherBreaks.map(b => `${b.start}–${b.end}`).join(", ")}
                      </div>
                    )}
                    {school.newsletterUrl && (
                      <div style={{ fontSize: 12, color: colors.accent, marginBottom: 6 }}>
                        📰 Newsletter: {school.newsletterUrl}
                      </div>
                    )}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                      {school.slots.map(s => (
                        <Tag key={s.id} color={["recess", "lunch"].includes(s.type) ? colors.success : ["before_school", "after_school"].includes(s.type) ? "#8B7EC8" : "#666"}>
                          {s.name} ({toTimeLabel(s.start)}–{toTimeLabel(s.end)})
                        </Tag>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// STUDENTS MANAGER
// ============================================================
function StudentsManager({ students, setStudents, schools, teachers, specialists, notify, focusStudentId, onClearFocus, returnPage, onReturn, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  // Derive available instruments from what teachers can actually teach
  const availableInstruments = [...new Set(teachers.flatMap(t => t.instruments.map(i => i.name)))].sort();
  // Lazy initialisers: if focusStudentId is set on mount, open edit form immediately
  // (avoids the useEffect flash where the list renders first then the form opens)
  const [editing, setEditing] = useState(() => {
    if (focusStudentId) { const s = students.find(st => st.id === focusStudentId); return s ? s.id : null; }
    return null;
  });
  const [form, setForm] = useState(() => {
    if (focusStudentId) { const s = students.find(st => st.id === focusStudentId); return s ? { ...s, instruments: s.instruments.map(i => ({ ...i })) } : null; }
    return null;
  });
  const filter = (viewState || {}).filter || { school: "", className: "", instrument: "", teacher: "", search: "" };
  const setFilter = (v) => setViewState(prev => ({ ...prev, filter: typeof v === "function" ? v(prev.filter || {}) : v }));
  const sortCol = (viewState || {}).sortCol || "name";
  const setSortCol = (v) => setViewState(prev => ({ ...prev, sortCol: v }));
  const sortDir = (viewState || {}).sortDir || "asc";
  const setSortDir = (v) => setViewState(prev => ({ ...prev, sortDir: v }));
  const [importMode, setImportMode] = useState(null); // null | "pdf" | "spreadsheet"
  const [importInstructions, setImportInstructions] = useState("");
  const [importSchoolId, setImportSchoolId] = useState("");
  const [parsing, setParsing] = useState(false);
  const [importError, setImportError] = useState(null);
  const [preview, setPreview] = useState(null);
  const fileRef = useRef(null);

  const focusRowRef = useRef(null);

  // Clear focusStudentId after it's been consumed on mount (handled via lazy useState above)
  // This also handles the case where focusStudentId changes while the component is already mounted
  useEffect(() => {
    if (focusStudentId) {
      const student = students.find(s => s.id === focusStudentId);
      if (student) {
        setForm({ ...student, instruments: student.instruments.map(i => ({ ...i })) });
        setEditing(student.id);
      }
      if (onClearFocus) onClearFocus();
    }
  }, [focusStudentId]);

  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (resetKey === lastResetKey.current) return; // skip strict-mode double-fire and initial mount
    lastResetKey.current = resetKey;
    setEditing(null); setForm(null); setImportMode(null); setPreview(null);
  }, [resetKey]);

  // Migrate old constraint fields to new ones
  useEffect(() => {
    let changed = false;
    const migrated = students.map(s => {
      if (s.breakTimeOnly !== undefined || s.beforeAfterOnly !== undefined || s.availableBeforeAfter !== undefined) {
        changed = true;
        const { breakTimeOnly, beforeAfterOnly, availableBeforeAfter, ...rest } = s;
        return {
          ...rest,
          outsideClassOnly: rest.outsideClassOnly || breakTimeOnly || false,
          outsideClassPreferred: rest.outsideClassPreferred || false,
          availableBefore: rest.availableBefore || availableBeforeAfter || beforeAfterOnly || false,
          availableAfter: rest.availableAfter || availableBeforeAfter || beforeAfterOnly || false,
        };
      }
      // Ensure new fields exist
      if (s.availableBefore === undefined) {
        changed = true;
        return { ...s, outsideClassOnly: s.outsideClassOnly || false, outsideClassPreferred: s.outsideClassPreferred || false, availableBefore: false, availableAfter: false };
      }
      // Migrate student-level isGroup to instrument-level isGroup
      if (s.isGroup !== undefined) {
        changed = true;
        const { isGroup, ...rest } = s;
        return { ...rest, instruments: (rest.instruments || []).map(i => ({ ...i, isGroup: i.isGroup !== undefined ? i.isGroup : isGroup })) };
      }
      // Ensure all instruments have isGroup field
      if (s.instruments?.some(i => i.isGroup === undefined)) {
        changed = true;
        return { ...s, instruments: s.instruments.map(i => ({ ...i, isGroup: i.isGroup || false })) };
      }
      return s;
    });
    if (changed) setStudents(migrated);
  }, []);

  const activeStudents = students.filter(s => s.status === "active" || s.status === "pending" || s.status === "trial");

  const newStudent = () => {
    setForm({
      id: uid(), name: "", schoolId: "", className: "",
      instruments: [{ name: "", isGroup: false }],
      outsideClassOnly: false, outsideClassPreferred: false, availableBefore: false, availableAfter: false,
      avoidTimes: [], preferredTimes: [], status: "active", notes: "",
      parents: []
    });
    setEditing("new");
  };

  const editStudent = (student) => {
    setForm({ ...student, instruments: student.instruments.map(i => ({ ...i })) });
    setEditing(student.id);
  };

  const saveStudent = () => {
    if (!form.name.trim()) { notify("Student name required", "warning"); return; }
    if (!form.instruments[0]?.name) { notify("At least one instrument required", "warning"); return; }
    if (editing === "new") {
      setStudents(prev => [...prev, form]);
    } else {
      setStudents(prev => prev.map(s => s.id === form.id ? form : s));
    }
    setForm(null); setEditing(null);
    notify("Student saved!");
    if (onReturn) onReturn();
  };

  const deleteStudent = (id) => {
    setStudents(prev => prev.filter(s => s.id !== id));
    notify("Student removed");
  };

  const handleImport = (data, filename) => {
    const imported = parseStudentCSV(data, schools, teachers);
    if (imported.length === 0) { notify("No valid students found in file", "warning"); return; }
    setStudents(prev => [...prev, ...imported]);
    notify(`Imported ${imported.length} students from ${filename}`);
  };

  const openImport = (mode) => { setImportMode(mode); setImportError(null); };

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    e.target.value = "";

    setParsing(true);
    setImportMode(null);
    try {
      let userGuidance = "";
      if (importInstructions.trim()) {
        userGuidance = `\n\nIMPORTANT — SPECIFIC INSTRUCTIONS FROM THE USER about this document. Follow these carefully, they override general assumptions:\n---\n${importInstructions.trim()}\n---`;
      }

      const schoolListStr = schools.map(s => {
        const initials = s.name.split(/\s+/).map(w => w[0]).join("").toUpperCase();
        return `"${s.name}" (abbreviation: "${initials}")`;
      }).join(", ");
      const instrumentListStr = (availableInstruments.length > 0 ? availableInstruments : INSTRUMENTS).join(", ");
      const teacherListStr = teachers.map(t => t.name).join(", ");

      const prompt = `Extract student data from this document. Each student should have:
- name: student's full name
- school: the school value EXACTLY as it appears in the document (do NOT convert abbreviations — return the raw text e.g. "EBPS" not "East Bentleigh Primary School")
- class: class/grade name exactly as shown (e.g. "3A", "Prep B", "5/6C")
- instrument: instrument name (known instruments: ${instrumentListStr})
- teacher: the teacher value EXACTLY as it appears in the document (could be full name, first name only, or initials — return the raw text)
- notes: any other relevant info (optional)

For reference, known schools: ${schoolListStr}. Known teachers: ${teacherListStr}.

Rules:
- Extract ALL students from the document, one entry per student per instrument
- Return school and teacher values EXACTLY as they appear — do NOT try to expand abbreviations or match names
- Match instrument names to the known instruments listed above where possible
- Do NOT set level — it will be auto-assigned based on grade
- If teacher isn't specified, leave as empty string
- If the same student appears multiple times with different instruments, return each as a separate entry (they will be merged automatically)
- Ignore any headers, totals, or non-student rows

Respond ONLY with a JSON array, no other text, no markdown backticks.${userGuidance}`;

      // Helper: match school by name, abbreviation/initials, or partial match
      const matchSchool = (raw) => {
        if (!raw) return importSchoolId ? schools.find(s => s.id === importSchoolId) : null;
        const r = raw.trim();
        const rLower = r.toLowerCase();
        const rUpper = r.toUpperCase();
        // 1. Exact name match
        let match = schools.find(s => s.name.toLowerCase() === rLower);
        if (match) return match;
        // 2. Abbreviation/initials match (input is abbreviation of school name)
        match = schools.find(s => {
          const initials = s.name.split(/\s+/).map(w => w[0]).join("").toUpperCase();
          return initials === rUpper;
        });
        if (match) return match;
        // 3. Reverse initials match (school name is abbreviation of input)
        const inputInitials = r.split(/\s+/).map(w => w[0]).join("").toUpperCase();
        match = schools.find(s => s.name.toUpperCase() === inputInitials);
        if (match) return match;
        // 4. Initials without common words (skip "Primary", "School", "College" etc.)
        const skipWords = ["primary", "school", "college", "grammar", "academy", "the"];
        match = schools.find(s => {
          const significantWords = s.name.split(/\s+/).filter(w => !skipWords.includes(w.toLowerCase()));
          const sigInitials = significantWords.map(w => w[0]).join("").toUpperCase();
          return sigInitials === rUpper || s.name.split(/\s+/).map(w => w[0]).join("").toUpperCase() === rUpper;
        });
        if (match) return match;
        // 5. Partial/contains match
        match = schools.find(s => s.name.toLowerCase().includes(rLower) || rLower.includes(s.name.toLowerCase()));
        if (match) return match;
        // 6. First word match (e.g. "Solway" matches "Solway Primary School")
        match = schools.find(s => s.name.toLowerCase().startsWith(rLower) || rLower.startsWith(s.name.split(/\s+/)[0].toLowerCase()));
        if (match) return match;
        // Fallback to importSchoolId
        return importSchoolId ? schools.find(s => s.id === importSchoolId) : null;
      };

      // Helper: match teacher by full name, first name, last name, or initials
      const matchTeacher = (raw) => {
        if (!raw) return null;
        const r = raw.trim();
        const rLower = r.toLowerCase();
        // 1. Exact full name match
        let match = teachers.find(t => t.name.toLowerCase() === rLower);
        if (match) return match;
        // 2. First name match
        match = teachers.find(t => t.name.split(/\s+/)[0].toLowerCase() === rLower);
        if (match) return match;
        // 3. Last name match
        match = teachers.find(t => {
          const parts = t.name.split(/\s+/);
          return parts.length > 1 && parts[parts.length - 1].toLowerCase() === rLower;
        });
        if (match) return match;
        // 4. Initials match (e.g. "JS" matches "John Smith", "J.S." matches too)
        const rClean = r.replace(/[.\s]/g, "").toUpperCase();
        if (rClean.length >= 2 && rClean.length <= 4) {
          match = teachers.find(t => {
            const initials = t.name.split(/\s+/).map(w => w[0]).join("").toUpperCase();
            return initials === rClean;
          });
          if (match) return match;
        }
        // 5. Partial/contains match (e.g. "John S" or "J Smith")
        match = teachers.find(t => t.name.toLowerCase().includes(rLower) || rLower.includes(t.name.toLowerCase()));
        if (match) return match;
        // 6. First name starts-with (e.g. "Jo" matches "John Smith")
        match = teachers.find(t => t.name.split(/\s+/)[0].toLowerCase().startsWith(rLower));
        if (match) return match;
        return null;
      };

      // Helper: consolidate duplicate student names — merge instruments into one entry
      const consolidateStudents = (entries) => {
        const byKey = {};
        for (const e of entries) {
          // Key by name + school to handle same name at different schools
          const key = `${e.name.toLowerCase()}|${e.schoolId}`;
          if (byKey[key]) {
            // Merge instruments (avoid duplicates)
            for (const inst of e.instruments) {
              if (!byKey[key].instruments.some(i => i.name === inst.name)) {
                byKey[key].instruments.push(inst);
              }
            }
            // Keep preferred teacher if the existing entry doesn't have one
            // teacherId is per-instrument; merged via instruments array above
            // Merge notes
            if (e.notes && !byKey[key].notes.includes(e.notes)) {
              byKey[key].notes = [byKey[key].notes, e.notes].filter(Boolean).join("; ");
            }
          } else {
            byKey[key] = { ...e };
          }
        }
        return Object.values(byKey);
      };

      // Helper: convert AI entries to preview entries
      const toPreviewEntries = (entries) => {
        const mapped = entries.map(e => {
          const school = matchSchool(e.school);
          const matched = matchTeacher(e.teacher);
          const className = (e.class || e.className || "").trim();
          const instruments = [{ name: e.instrument || "", isGroup: false }];
          if (e.instrument2) instruments.push({ name: e.instrument2, isGroup: false });
          return {
            id: uid(), name: (e.name || "").trim(),
            schoolId: school ? school.id : importSchoolId || "",
            className,
            instruments,
            // teacherId handled per-instrument
            outsideClassOnly: false, outsideClassPreferred: false, availableBefore: false, availableAfter: false,
            avoidTimes: [], preferredTimes: [],
            status: "active", notes: e.notes || ""
          };
        });
        return consolidateStudents(mapped);
      };

      // Helper: parse AI response JSON with truncation recovery
      const parseAIResponse = (textContent) => {
        const cleaned = textContent.replace(/```json|```/g, "").trim();
        try { return JSON.parse(cleaned); }
        catch(e) {
          const lastObj = cleaned.lastIndexOf("}");
          if (lastObj > 0) {
            let recovered = cleaned.substring(0, lastObj + 1);
            if (!recovered.trim().endsWith("]")) recovered += "]";
            return JSON.parse(recovered);
          }
          throw new Error("Could not parse AI response.\n\nRaw: " + cleaned.substring(0, 300));
        }
      };

      // Helper: read a single spreadsheet file
      const readSpreadsheet = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
            if (file.name.endsWith(".csv")) {
              const Papa = window.Papa;
              const result = window.window.Papa.parse(ev.target.result, { header: true, skipEmptyLines: true });
              resolve(result.data);
            } else {
              const XLSX = await getXLSX();
              const wb = XLSX.read(ev.target.result, { type: "array" });
              const ws = wb.Sheets[wb.SheetNames[0]];
              resolve(XLSX.utils.sheet_to_json(ws));
            }
          } catch (err) { reject(err); }
        };
        reader.onerror = () => reject(new Error("Failed to read " + file.name));
        if (file.name.endsWith(".csv")) reader.readAsText(file);
        else reader.readAsArrayBuffer(file);
      });

      const file = files[0]; // For PDF or single file references

      if (file.name.endsWith(".pdf")) {
        // PDF: single file only
        const base64Data = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(",")[1]);
          reader.onerror = () => rej(new Error("Failed to read file"));
          reader.readAsDataURL(file);
        });

        const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: getAnthropicHeaders(),
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 16000,
            messages: [{
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
                { type: "text", text: prompt }
              ]
            }]
          })
        });

        if (!response.ok) throw new Error(`API error: ${response.status}`);

        const data = await response.json();
        const textContent = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
        const entries = parseAIResponse(textContent);

        if (!Array.isArray(entries) || entries.length === 0) {
          notify("No students found. Try adding more specific instructions.", "warning");
          setParsing(false);
          return;
        }

        setPreview({ entries: toPreviewEntries(entries), filename: file.name });
      } else {
        // Spreadsheet(s): process all files and merge
        const allEntries = [];
        const filenames = [];

        for (const f of files) {
          const rawData = await readSpreadsheet(f);
          if (!rawData || rawData.length === 0) continue;
          filenames.push(f.name);

          // Always use AI for spreadsheets — handles any column names, abbreviations, etc.
          const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: getAnthropicHeaders(),
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 16000,
              messages: [{
                role: "user",
                content: `I have a spreadsheet with student data. Here are the first 5 rows as a sample:\n\n${JSON.stringify(rawData.slice(0, 5), null, 2)}\n\nFull data (${rawData.length} rows):\n${JSON.stringify(rawData)}\n\n${prompt}`
              }]
            })
          });

          if (!response.ok) throw new Error(`API error for ${f.name}: ${response.status}`);

          const data = await response.json();
          const textContent = data.content?.filter(c => c.type === "text").map(c => c.text).join("") || "";
          const entries = parseAIResponse(textContent);
          allEntries.push(...toPreviewEntries(entries));
        }

        if (allEntries.length === 0) {
          notify("No valid students found in the selected file(s).", "warning");
          setParsing(false);
          return;
        }

        setPreview({
          entries: allEntries,
          filename: filenames.length === 1 ? filenames[0] : `${filenames.length} files (${filenames.join(", ")})`
        });
      }
    } catch (err) {
      console.error("Student import error:", err);
      setImportError({ filename: files.map(f => f.name).join(", "), message: err.message, details: err.stack || "" });
    }
    setParsing(false);
  };

  const confirmStudentImport = () => {
    if (!preview) return;
    const valid = preview.entries.filter(e => e.name && e.instruments[0]?.name);
    setStudents(prev => [...prev, ...valid]);
    notify(`Imported ${valid.length} students from ${preview.filename}`);
    setPreview(null);
  };

  const updatePreviewStudent = (idx, key, val) => {
    setPreview(prev => {
      const entries = [...prev.entries];
      entries[idx] = { ...entries[idx], [key]: val };
      return { ...prev, entries };
    });
  };

  const removePreviewStudent = (idx) => {
    setPreview(prev => ({ ...prev, entries: prev.entries.filter((_, i) => i !== idx) }));
  };

  const filtered = activeStudents.filter(s => {
    if (filter.school && s.schoolId !== filter.school) return false;
    if (filter.className && s.className !== filter.className) return false;
    if (filter.instrument && !s.instruments.some(i => i.name === filter.instrument)) return false;
    if (filter.teacher) {
      if (filter.teacher === "_none_") {
        if (s.instruments.some(i => i.teacherId)) return false;
      } else {
        if (!s.instruments.some(i => i.teacherId === filter.teacher)) return false;
      }
    }
    if (filter.search && !s.name.toLowerCase().includes(filter.search.toLowerCase())) return false;
    return true;
  });

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };

  const sortedFiltered = [...filtered].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    switch (sortCol) {
      case "name": return dir * a.name.localeCompare(b.name);
      case "school": {
        const aSchool = schools.find(sc => sc.id === a.schoolId)?.name || "";
        const bSchool = schools.find(sc => sc.id === b.schoolId)?.name || "";
        return dir * aSchool.localeCompare(bSchool);
      }
      case "class": return dir * (a.className || "").localeCompare(b.className || "", undefined, { numeric: true });
      case "instrument": {
        const aInst = a.instruments[0]?.name || "";
        const bInst = b.instruments[0]?.name || "";
        return dir * aInst.localeCompare(bInst);
      }
      case "teacher": {
        const aTid = a.instruments && a.instruments[0] && a.instruments[0].teacherId;
        const bTid = b.instruments && b.instruments[0] && b.instruments[0].teacherId;
        const aT = aTid ? (teachers.find(t => t.id === aTid)?.name || "") : "zzz";
        const bT = bTid ? (teachers.find(t => t.id === bTid)?.name || "") : "zzz";
        return dir * aT.localeCompare(bT);
      }
      default: return 0;
    }
  });


  // ==== RENDER: IMPORT MODE ====

    if (importMode) {
    return (
      <div>
        <PageTitle subtitle={importMode === "pdf" ? "Upload a PDF with student data" : "Upload a spreadsheet with student data"}>Import Students</PageTitle>
        <Card>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <button onClick={() => setImportMode("pdf")} style={{
              flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer",
              border: `2px solid ${importMode === "pdf" ? colors.accent : colors.border}`,
              background: importMode === "pdf" ? colors.accentLight : colors.white,
              color: importMode === "pdf" ? colors.accentDark : colors.text, fontWeight: 600
            }}>📄 PDF Document</button>
            <button onClick={() => setImportMode("spreadsheet")} style={{
              flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", cursor: "pointer",
              border: `2px solid ${importMode === "spreadsheet" ? colors.accent : colors.border}`,
              background: importMode === "spreadsheet" ? colors.accentLight : colors.white,
              color: importMode === "spreadsheet" ? colors.accentDark : colors.text, fontWeight: 600
            }}>📁 Spreadsheet (CSV/XLSX)</button>
          </div>

          {schools.length > 1 && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Default School <span style={{ fontWeight: 400, textTransform: "none" }}>(if not specified in file)</span>
              </label>
              <select value={importSchoolId} onChange={e => setImportSchoolId(e.target.value)}
                style={{ padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">Auto-detect from file</option>
                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Import Instructions <span style={{ fontWeight: 400, textTransform: "none" }}>(optional — helps AI understand your file)</span>
            </label>
            <textarea
              value={importInstructions}
              onChange={e => setImportInstructions(e.target.value)}
              rows={5}
              placeholder={importMode === "pdf"
                ? "Examples:\n• Only import students from the 'Current Enrolments' section\n• The instrument is listed under 'Program'\n• Ignore any students marked 'Withdrawn'\n• 'Gtr' means Guitar, 'Kbd' means Keyboard\n• All students on this page are from Moorabbin PS"
                : "Examples:\n• The 'Program' column is the instrument name\n• 'Gtr' means Guitar, 'Kbd' means Keyboard\n• Ignore rows where Status is 'Cancelled'\n• Class names are in the 'Home Group' column\n• Skill level is in the 'Year' column: Year 3-4 = Beginner, Year 5-6 = Intermediate"}
              style={{
                width: "100%", padding: "12px 14px",
                border: `1px solid ${colors.inputBorder}`, borderRadius: 8,
                fontSize: 14, fontFamily: "inherit", background: colors.inputBg,
                color: colors.text, resize: "vertical", boxSizing: "border-box",
                lineHeight: 1.6
              }}
            />
            <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 6 }}>
              Tell the AI which columns to use, what abbreviations mean, which rows to ignore, or anything else specific to your file.
              {importMode === "spreadsheet" && " AI will always interpret your spreadsheet — instructions help with tricky formats."}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input ref={fileRef} type="file" accept={importMode === "pdf" ? ".pdf" : ".csv,.xlsx,.xls"} multiple={importMode !== "pdf"} onChange={handleFileUpload} style={{ display: "none" }} />
            <Btn onClick={() => fileRef.current?.click()}>
              {importMode === "pdf" ? "📄 Select PDF File" : "📁 Select Spreadsheet(s)"}
            </Btn>
            <Btn variant="secondary" onClick={() => setImportMode(null)}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: PARSING ====
  if (parsing) {
    return (
      <div>
        <PageTitle>Students</PageTitle>
        <Card style={{ background: "#FFF8F0", borderColor: colors.accent + "40" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontSize: 28 }}>⏳</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, color: colors.accent }}>Processing student data...</div>
              <div style={{ fontSize: 13, color: colors.textLight, marginTop: 4 }}>
                AI is reading the document and extracting student records. This usually takes 10–20 seconds.
                {importInstructions.trim() && <span style={{ display: "block", marginTop: 4, color: colors.textMuted, fontStyle: "italic" }}>Using your instructions to guide extraction.</span>}
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: IMPORT ERROR ====
  if (importError) {
    return (
      <div>
        <PageTitle subtitle="Something went wrong during import">Import Error</PageTitle>
        <Card style={{ background: "#FEF6F6", borderColor: "#FCC" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <div style={{ fontSize: 28, flexShrink: 0 }}>⚠️</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 15, color: colors.danger, marginBottom: 8 }}>
                Failed to import "{importError.filename}"
              </div>
              <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.6, marginBottom: 12 }}>
                {importError.message}
              </div>
              {importError.details && (
                <div style={{ fontSize: 12, color: colors.textMuted, padding: "10px 14px", background: "#FFF", borderRadius: 8, border: "1px solid #F0E0E0", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 120, overflowY: "auto" }}>
                  {importError.details}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <Btn onClick={() => { setImportError(null); openImport("pdf"); }}>Try PDF Again</Btn>
            <Btn variant="secondary" onClick={() => { setImportError(null); openImport("spreadsheet"); }}>Try Spreadsheet</Btn>
            <Btn variant="ghost" onClick={() => setImportError(null)}>Dismiss</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ==== RENDER: IMPORT PREVIEW ====
  if (preview) {
    return (
      <div>
        <PageTitle subtitle={`Found ${preview.entries.length} students from ${preview.filename} — review before importing`}>Review Import</PageTitle>

        <Card style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: colors.bg, borderBottom: `1px solid ${colors.border}`, position: "sticky", top: 0, zIndex: 1 }}>
                  {["Name", "School", "Class", "Instrument", "Teacher", ""].map((h, i) => (
                    <th key={i} style={{ padding: "10px 8px", textAlign: "left", fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, background: colors.bg }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.entries.map((entry, i) => (
                  <tr key={entry.id} style={{ borderBottom: `1px solid ${colors.borderLight}` }}>
                    <td style={{ padding: "6px 8px" }}>
                      <input value={entry.name} onChange={e => updatePreviewStudent(i, "name", e.target.value)}
                        style={{ width: "100%", padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select value={entry.schoolId} onChange={e => updatePreviewStudent(i, "schoolId", e.target.value)}
                        style={{ width: "100%", padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        <option value="">Select...</option>
                        {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input value={entry.className} onChange={e => updatePreviewStudent(i, "className", e.target.value)}
                        style={{ width: 80, padding: "4px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }} />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select value={entry.instruments[0]?.name || ""} onChange={e => {
                        const insts = [...entry.instruments]; insts[0] = { ...insts[0], name: e.target.value };
                        updatePreviewStudent(i, "instruments", insts);
                      }} style={{ width: "100%", padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        <option value="">Select...</option>
                        {(() => {
                          const base = availableInstruments.length > 0 ? availableInstruments : INSTRUMENTS;
                          const current = entry.instruments[0]?.name;
                          if (current && !base.includes(current)) return [...base, current].sort();
                          return base;
                        })().map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select value={entry.instruments[0]?.level || "Beginner"} onChange={e => {
                        const insts = [...entry.instruments]; insts[0] = { ...insts[0], level: e.target.value };
                        updatePreviewStudent(i, "instruments", insts);
                      }} style={{ padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select value={entry.instruments && entry.instruments[0] && entry.instruments[0].teacherId || ""} onChange={e => {
                        const insts = entry.instruments ? [...entry.instruments] : [{ name: "" }];
                        if (insts.length > 0) insts[0] = { ...insts[0], teacherId: e.target.value };
                        updatePreviewStudent(i, "instruments", insts);
                      }}
                        style={{ width: "100%", padding: "4px 6px", border: `1px solid ${colors.inputBorder}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}>
                        <option value="">Auto</option>
                        {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <button onClick={() => removePreviewStudent(i)}
                        style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 16 }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={confirmStudentImport}>✓ Import {preview.entries.length} Students</Btn>
          <Btn variant="secondary" onClick={() => setPreview(null)}>Cancel</Btn>
        </div>
      </div>
    );
  }

  if (form) {
    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveStudent(); } }}>
        <PageTitle navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{editing === "new" ? "Add Student" : "Edit Student"}</PageTitle>
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" }}>
            <Input label="Student Name" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder="Full name" />
            <Input label="School" value={form.schoolId} onChange={v => setForm(p => ({ ...p, schoolId: v }))}
              options={schools.map(s => ({ value: s.id, label: s.name }))} />
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Class</label>
              <select
                value={form.className || ""}
                onChange={e => setForm(p => ({ ...p, className: e.target.value }))}
                disabled={!form.schoolId}
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: !form.schoolId ? colors.bg : colors.white, color: !form.schoolId ? colors.textMuted : colors.text, cursor: !form.schoolId ? "not-allowed" : "pointer" }}>
                <option value="">{form.schoolId ? "Select class..." : "Select a school first"}</option>
                {form.schoolId && [...new Set((specialists || []).filter(s => s.schoolId === form.schoolId).map(s => s.className).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <Input label="Status" value={form.status} onChange={v => setForm(p => ({ ...p, status: v }))}
              options={[{ value: "active", label: "Active" }, { value: "pending", label: "Pending (Waiting List)" }, { value: "trial", label: "Trial Lesson" }]} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Instruments</label>
              {form.instruments.length < 2 && (
                <Btn variant="ghost" onClick={() => setForm(p => ({ ...p, instruments: [...p.instruments, { name: "", isGroup: false }] }))} style={{ fontSize: 12 }}>
                  + Second Instrument
                </Btn>
              )}
            </div>
            {form.instruments.map((inst, i) => (
              <React.Fragment key={i}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 4 }}>
                  <div style={{ flex: 1 }}>
                    <Input value={inst.name} onChange={v => {
                      const insts = [...form.instruments]; insts[i] = { ...insts[i], name: v };
                      setForm(p => ({ ...p, instruments: insts }));
                    }} options={(() => {
                      const base = availableInstruments.length > 0 ? availableInstruments : INSTRUMENTS;
                      if (inst.name && !base.includes(inst.name)) return [...base, inst.name].sort();
                      return base;
                    })()} style={{ marginBottom: 0 }} />
                  </div>
                  <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12, color: inst.isGroup ? instruments_colors.Group : colors.textMuted, cursor: "pointer", whiteSpace: "nowrap" }}>
                    <input type="checkbox" checked={inst.isGroup || false} onChange={e => {
                      const insts = [...form.instruments]; insts[i] = { ...insts[i], isGroup: e.target.checked };
                      setForm(p => ({ ...p, instruments: insts }));
                    }} style={{ accentColor: instruments_colors.Group, width: 14, height: 14 }} />
                    Group
                  </label>
                  {i > 0 && (
                    <button onClick={() => setForm(p => ({ ...p, instruments: p.instruments.filter((_, idx) => idx !== i) }))}
                      style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18 }}>×</button>
                  )}
                  {i > 0 && !inst.isGroup && <span style={{ fontSize: 11, color: colors.textMuted, whiteSpace: "nowrap" }}>↑ 2nd: specialist/break/before-after only</span>}
                </div>
                <div style={{ marginBottom: 8 }}>
                  <select value={inst.teacherId || ""} onChange={e => {
                      const insts = [...form.instruments]; insts[i] = { ...insts[i], teacherId: e.target.value };
                      setForm(p => ({ ...p, instruments: insts }));
                    }}
                    style={{ padding: "5px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", color: inst.teacherId ? colors.text : colors.textMuted }}>
                    <option value="">No assigned teacher (auto)</option>
                    {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              </React.Fragment>
            ))}
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Scheduling Constraints</label>
            <Checkbox label="Outside of class time only" checked={form.outsideClassOnly} onChange={v => setForm(p => ({ ...p, outsideClassOnly: v, outsideClassPreferred: v ? false : p.outsideClassPreferred }))} />
            <Checkbox label="Outside of class time preferred" checked={form.outsideClassPreferred} onChange={v => setForm(p => ({ ...p, outsideClassPreferred: v, outsideClassOnly: v ? false : p.outsideClassOnly }))} />
            <Checkbox label="Available before school" checked={form.availableBefore} onChange={v => setForm(p => ({ ...p, availableBefore: v }))} />
            <Checkbox label="Available after school" checked={form.availableAfter} onChange={v => setForm(p => ({ ...p, availableAfter: v }))} />
          </div>

          <Input label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} multiline placeholder="Any preferences, restrictions, or notes..." />

          {/* Parent / Guardian contacts */}
          <div style={{ marginBottom: 14, marginTop: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Parent / Guardian
              </label>
              {(form.parents || []).length < 2 && (
                <Btn variant="ghost" onClick={() => setForm(p => ({ ...p, parents: [...(p.parents || []), { id: uid(), name: "", email: "", phone: "", relationship: "", isPrimary: (p.parents || []).length === 0 }] }))} style={{ fontSize: 12 }}>
                  {(form.parents || []).length === 0 ? "+ Add Parent" : "+ Add Second Parent"}
                </Btn>
              )}
            </div>
            {(form.parents || []).length === 0 ? (
              <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic", padding: "8px 0" }}>No parent details added</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {(form.parents || []).map((parent, pi) => (
                  <div key={parent.id || pi} style={{ padding: "12px 14px", background: colors.bg, borderRadius: 10, border: `1px solid ${colors.border}`, position: "relative" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
                      {pi === 0 ? "Primary Contact" : "Second Contact"}
                    </div>
                    <button onClick={() => setForm(p => ({ ...p, parents: (p.parents || []).filter((_, i) => i !== pi) }))}
                      style={{ position: "absolute", top: 8, right: 10, border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 16, lineHeight: 1 }}
                      title="Remove">×</button>
                    <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                      <div style={{ flex: 1 }}>
                        <Input label="Name" value={parent.name} onChange={v => setForm(p => ({ ...p, parents: (p.parents || []).map((pr, i) => i === pi ? { ...pr, name: v } : pr) }))} placeholder="Parent or guardian name" />
                      </div>
                      <div style={{ width: 140 }}>
                        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 4 }}>Relationship</label>
                        <select value={parent.relationship || ""} onChange={e => setForm(p => ({ ...p, parents: (p.parents || []).map((pr, i) => i === pi ? { ...pr, relationship: e.target.value } : pr) }))}
                          style={{ width: "100%", padding: "8px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                          <option value="">Select…</option>
                          <option value="Mother">Mother</option>
                          <option value="Father">Father</option>
                          <option value="Guardian">Guardian</option>
                          <option value="Carer">Carer</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <Input label="Email" value={parent.email} onChange={v => setForm(p => ({ ...p, parents: (p.parents || []).map((pr, i) => i === pi ? { ...pr, email: v } : pr) }))} placeholder="parent@example.com" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Input label="Phone" value={parent.phone} onChange={v => setForm(p => ({ ...p, parents: (p.parents || []).map((pr, i) => i === pi ? { ...pr, phone: v } : pr) }))} placeholder="04xx xxx xxx" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveStudent}>Save Student</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); if (onReturn) onReturn(); }}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageTitle subtitle={
          students.filter(s => s.status === "active").length + " active" +
          (students.filter(s => s.status === "pending").length > 0 ? " · " + students.filter(s => s.status === "pending").length + " pending" : "") +
          (students.filter(s => s.status === "trial").length > 0 ? " · " + students.filter(s => s.status === "trial").length + " trial" : "")
        }
        pageColor={PAGE_COLORS.students}
        action={<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ position: "relative", display: "inline-block" }}
            onMouseEnter={e => { const t = e.currentTarget.querySelector(".import-tooltip"); if (t) t.style.display = "block"; }}
            onMouseLeave={e => { const t = e.currentTarget.querySelector(".import-tooltip"); if (t) t.style.display = "none"; }}>
            <Btn variant="secondary" onClick={() => openImport("spreadsheet")}>Import</Btn>
            <div className="import-tooltip" style={{
              display: "none", position: "absolute", top: "calc(100% + 8px)", right: 0,
              width: 340, background: colors.white, border: "1px solid " + colors.border,
              borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: "14px 16px",
              zIndex: 200, color: colors.text, fontSize: 12, lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: colors.sidebarActive }}>📋 Spreadsheet Import Format</div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Required columns:</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>name</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>school</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>class</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>instrument</code>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Optional columns:</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>instrument2</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>teacher</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>status</code> <span style={{ color: colors.textMuted }}>(active/pending/trial)</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Constraint columns</span> <span style={{ color: colors.textMuted }}>(yes/no):</span><br/>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>outsideClassOnly</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>outsideClassPreferred</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>availableBefore</code> &nbsp;
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>availableAfter</code>
              </div>
              <div>
                <code style={{ background: colors.bg, borderRadius: 4, padding: "1px 5px", fontSize: 11 }}>notes</code> <span style={{ color: colors.textMuted }}>— any scheduling notes</span>
              </div>
            </div>
          </div>
          <Btn onClick={newStudent}>+ Add</Btn>
        </div>}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        Students
      </PageTitle>

      {activeStudents.length > 0 && (
        <Card style={{ marginBottom: 10, padding: "10px 14px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap" }}>
            <div style={{ flex: "1 1 140px", minWidth: 0, position: "relative" }}>
              <input value={filter.search} onChange={e => setFilter(p => ({ ...p, search: e.target.value }))} placeholder="Search name..."
                style={{ width: "100%", padding: "6px 28px 6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" }} />
              {filter.search && (
                <button onClick={() => setFilter(p => ({ ...p, search: "" }))}
                  style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
              )}
            </div>
            <select value={filter.school} onChange={e => setFilter(p => ({ ...p, school: e.target.value, className: "" }))}
              style={{ flex: "0 0 auto", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit" }}>
              <option value="">All Schools</option>
              {schools.map(s => <option key={s.id} value={s.id}>{s.name.split(" ").filter(w => /^[A-Z]/.test(w)).map(w => w[0]).join("") || s.name}</option>)}
            </select>
            <select value={filter.className} onChange={e => setFilter(p => ({ ...p, className: e.target.value }))}
              style={{ flex: "0 0 auto", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit" }}>
              <option value="">All Classes</option>
              {[...new Set(activeStudents
                .filter(s => !filter.school || s.schoolId === filter.school)
                .map(s => s.className).filter(Boolean))]
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                .map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filter.instrument} onChange={e => setFilter(p => ({ ...p, instrument: e.target.value }))}
              style={{ flex: "0 1 120px", minWidth: 0, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit" }}>
              <option value="">All Instruments</option>
              {[...new Set([
                ...(availableInstruments.length > 0 ? availableInstruments : INSTRUMENTS),
                ...activeStudents.flatMap(s => s.instruments.map(i => i.name)).filter(Boolean)
              ])].sort().map(i => <option key={i} value={i}>{i}</option>)}
            </select>
            <select value={filter.teacher} onChange={e => setFilter(p => ({ ...p, teacher: e.target.value }))}
              style={{ flex: "0 1 120px", minWidth: 0, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit" }}>
              <option value="">All Teachers</option>
              <option value="_none_">No teacher</option>
              {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </Card>
      )}

      {activeStudents.length === 0 ? (
        <EmptyState icon="👨‍🎓" title="No students yet" subtitle="Add students manually or import from a spreadsheet (CSV or Excel)." action="+ Add Student" onAction={newStudent} />
      ) : (
        <>
          <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 6 }}>Showing {filtered.length} of {activeStudents.length} students</div>
          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 210px)" }}>
            <div style={{ overflowY: "auto", flex: 1 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 10 }}>
                <tr style={{ background: colors.sidebarActive, borderBottom: `1px solid ${colors.border}` }}>
                  {[
                    { key: "name", label: "Name" },
                    { key: "school", label: "School" },
                    { key: "class", label: "Class" },
                    { key: "instrument", label: "Instrument(s)" },
                    { key: "teacher", label: "Teacher" },
                    { key: null, label: "Constraints" },
                    { key: null, label: "" }
                  ].map((col, ci) => (
                    <th key={ci}
                      onClick={col.key ? () => handleSort(col.key) : undefined}
                      style={{
                        padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 600,
                        color: sortCol === col.key ? "#fff" : "rgba(255,255,255,0.6)",
                        textTransform: "uppercase", letterSpacing: 0.5,
                        cursor: col.key ? "pointer" : "default",
                        userSelect: "none",
                        width: ci === 0 ? "18%" : ci === 1 ? "8%" : ci === 2 ? "7%" : ci === 3 ? "16%" : ci === 4 ? "20%" : ci === 5 ? "22%" : 72,
                      }}>
                      {col.label}{sortCol === col.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedFiltered.map(s => {
                  const school = schools.find(sc => sc.id === s.schoolId);
                  const prefTeacher = s.instruments && s.instruments[0] && s.instruments[0].teacherId ? teachers.find(t => t.id === s.instruments[0].teacherId) : null;
                  return (
                    <tr key={s.id} ref={s.id === editing ? focusRowRef : null} style={{ borderBottom: `1px solid ${colors.borderLight}`, cursor: "pointer", opacity: s.status !== "active" ? 0.6 : 1 }}
                      onClick={() => editStudent(s)}
                      onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <td style={{ padding: "10px 14px", fontWeight: 500 }}>{s.name}</td>
                      <td style={{ padding: "10px 14px", color: colors.textLight }}>{school ? school.name.split(" ").filter(w => /^[A-Z]/.test(w) || w.length <= 3).map(w => w[0]).join("") || school.name.slice(0, 4).toUpperCase() : "—"}</td>
                      <td style={{ padding: "10px 14px", color: colors.textLight }}>{s.className || "—"}</td>
                      <td style={{ padding: "10px 14px" }}>
                        {s.instruments.map((inst, i) => (
                          <Tag key={i} color={getInstColor(inst.name, inst.isGroup)}>{inst.isGroup ? "👥 " : ""}{inst.name}</Tag>
                        ))}
                      </td>
                      <td style={{ padding: "10px 14px", color: colors.textLight, fontSize: 13 }}>
                        {prefTeacher ? prefTeacher.name : <span style={{ color: colors.textMuted, fontStyle: "italic" }}>Auto</span>}
                      </td>
                      <td style={{ padding: "10px 14px", fontSize: 12, color: colors.textMuted }}>
                        {s.outsideClassOnly && <Tag color={colors.warning}>Outside class only</Tag>}
                        {s.outsideClassPreferred && <Tag color="#F59E0B">Outside class pref.</Tag>}
                        {s.availableBefore && <Tag color={colors.info || "#3B82F6"}>Before school</Tag>}
                        {s.availableAfter && <Tag color={colors.info || "#3B82F6"}>After school</Tag>}
                        {s.instruments.some(i => i.isGroup) && <Tag color={instruments_colors.Group}>Group</Tag>}
                      </td>
                      <td style={{ padding: "10px 8px", width: 72 }}>
                        <div style={{ display: "flex", gap: 4, alignItems: "center", justifyContent: "flex-end" }}>
                          {(() => {
                            const primaryParent = (s.parents || []).find(p => p.isPrimary) || (s.parents || [])[0];
                            return primaryParent?.email ? (
                              <a href={"mailto:" + primaryParent.email} onClick={e => e.stopPropagation()}
                                title={"Email " + (primaryParent.name || "parent") + " (" + primaryParent.email + ")"}
                                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, background: colors.sidebarActive, border: "none", color: "#fff", textDecoration: "none", flexShrink: 0 }}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                              </a>
                            ) : null;
                          })()}
                          <button onClick={(e) => { e.stopPropagation(); deleteStudent(s.id); }}
                            title="Remove student"
                            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, background: "#FEF2F2", border: "1px solid #FECACA", color: "#DC2626", cursor: "pointer", flexShrink: 0 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}


    </div>
  );
}

// ============================================================
// TEACHERS MANAGER
// ============================================================
function TeachersManager({ teachers, setTeachers, schools, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);

  useEffect(() => { setEditing(null); setForm(null); }, [resetKey]);

  const newTeacher = () => {
    setForm({
      id: uid(), name: "", email: "", phone: "",
      instruments: [{ name: "" }],
      availability: [],
      teacherBreaks: [],
      notes: ""
    });
    setEditing("new");
  };

  const editTeacher = (t) => {
    // Migrate old format: separate schools[] + availability[{day,start,end}]
    // to new format: availability[{schoolId,day,start,end}]
    let avail = t.availability.map(a => ({ ...a }));
    if (avail.length > 0 && !avail[0].schoolId && t.schools && t.schools.length > 0) {
      const migrated = [];
      for (const schoolId of t.schools) {
        for (const a of avail) {
          migrated.push({ schoolId, day: a.day, start: a.start, end: a.end });
        }
      }
      avail = migrated;
    }
    setForm({
      ...t,
      instruments: t.instruments.map(i => ({ name: i.name })),
      availability: avail,
      teacherBreaks: (t.teacherBreaks || []).map(b => ({ ...b }))
    });
    setEditing(t.id);
  };

  const saveTeacher = () => {
    if (!form.name.trim()) { notify("Teacher name required", "warning"); return; }
    if (!form.instruments[0]?.name) { notify("At least one instrument required", "warning"); return; }
    if (form.availability.length === 0) { notify("Add at least one availability entry", "warning"); return; }
    // Derive schools list from availability for backward compat
    const saved = { ...form, schools: [...new Set(form.availability.map(a => a.schoolId).filter(Boolean))] };
    if (editing === "new") {
      setTeachers(prev => [...prev, saved]);
    } else {
      setTeachers(prev => prev.map(t => t.id === saved.id ? saved : t));
    }
    setForm(null); setEditing(null);
    notify("Teacher saved!");
  };

  const deleteTeacher = (id) => {
    setTeachers(prev => prev.filter(t => t.id !== id));
    notify("Teacher removed");
  };

  const handleImport = (data, filename) => {
    const imported = parseTeacherCSV(data, schools);
    if (imported.length === 0) { notify("No valid teachers found in file", "warning"); return; }
    setTeachers(prev => [...prev, ...imported]);
    notify(`Imported ${imported.length} teachers from ${filename}`);
  };

  const addAvailRow = () => {
    setForm(prev => ({
      ...prev,
      availability: [...prev.availability, { schoolId: schools.length === 1 ? schools[0].id : "", day: "Monday", start: "09:00", end: "15:30" }]
    }));
  };

  const updateAvailRow = (idx, key, val) => {
    setForm(prev => ({
      ...prev,
      availability: prev.availability.map((a, i) => i === idx ? { ...a, [key]: val } : a)
    }));
  };

  const removeAvailRow = (idx) => {
    setForm(prev => ({ ...prev, availability: prev.availability.filter((_, i) => i !== idx) }));
  };

  const duplicateAvailRow = (idx) => {
    setForm(prev => {
      const row = { ...prev.availability[idx] };
      return { ...prev, availability: [...prev.availability.slice(0, idx + 1), row, ...prev.availability.slice(idx + 1)] };
    });
  };

  const addBreakRow = () => {
    setForm(prev => ({
      ...prev,
      teacherBreaks: [...(prev.teacherBreaks || []), { id: uid(), schoolId: schools.length === 1 ? schools[0].id : "", day: "All", start: "11:00", end: "11:30" }]
    }));
  };

  const updateBreakRow = (idx, key, val) => {
    setForm(prev => ({
      ...prev,
      teacherBreaks: (prev.teacherBreaks || []).map((b, i) => i === idx ? { ...b, [key]: val } : b)
    }));
  };

  const removeBreakRow = (idx) => {
    setForm(prev => ({ ...prev, teacherBreaks: (prev.teacherBreaks || []).filter((_, i) => i !== idx) }));
  };

  const duplicateBreakRow = (idx) => {
    setForm(prev => {
      const row = { ...(prev.teacherBreaks || [])[idx], id: uid() };
      return { ...prev, teacherBreaks: [...prev.teacherBreaks.slice(0, idx + 1), row, ...prev.teacherBreaks.slice(idx + 1)] };
    });
  };

  const addInstrument = () => {
    setForm(prev => ({ ...prev, instruments: [...prev.instruments, { name: "" }] }));
  };

  const updateInstrument = (idx, key, val) => {
    setForm(prev => {
      const insts = [...prev.instruments];
      insts[idx] = { ...insts[idx], [key]: val };
      return { ...prev, instruments: insts };
    });
  };

  if (form) {
    return (
      <div onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveTeacher(); } }}>
        <PageTitle navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{editing === "new" ? "Add Teacher" : "Edit Teacher"}</PageTitle>
        <Card>
          <Input label="Teacher Name" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder="Full name" />
          <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <Input label="Email" value={form.email || ""} onChange={v => setForm(p => ({ ...p, email: v }))} placeholder="teacher@example.com" />
            </div>
            <div style={{ flex: 1 }}>
              <Input label="Phone" value={form.phone || ""} onChange={v => setForm(p => ({ ...p, phone: v }))} placeholder="04xx xxx xxx" />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Instruments</label>
              <Btn variant="ghost" onClick={addInstrument} style={{ fontSize: 12 }}>+ Add Instrument</Btn>
            </div>
            {form.instruments.map((inst, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, padding: "8px 12px", background: colors.bg, borderRadius: 8 }}>
                <div style={{ flex: 1 }}>
                  <select value={inst.name} onChange={e => updateInstrument(i, "name", e.target.value)}
                    style={{ width: "100%", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                    <option value="">Select instrument...</option>
                    {INSTRUMENTS.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                {i > 0 && (
                  <button onClick={() => setForm(p => ({ ...p, instruments: p.instruments.filter((_, idx) => idx !== i) }))}
                    style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18 }}>×</button>
                )}
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Availability</label>
              <Btn variant="ghost" onClick={addAvailRow} style={{ fontSize: 12 }}>+ Add Row</Btn>
            </div>

            {form.availability.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", color: colors.textMuted, fontSize: 13, background: colors.bg, borderRadius: 8, border: `1px dashed ${colors.border}` }}>
                No availability set. Click "+ Add Row" to specify which schools & days this teacher is available.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {/* Header */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", paddingBottom: 4 }}>
                  <div style={{ flex: 2, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>School</div>
                  <div style={{ flex: 1, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Day</div>
                  <div style={{ width: 100, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Start</div>
                  <div style={{ width: 100, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>End</div>
                  <div style={{ width: 56 }}></div>
                </div>

                {form.availability.map((row, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", background: colors.bg, borderRadius: 8 }}>
                    <div style={{ flex: 2 }}>
                      <select value={row.schoolId || ""} onChange={e => updateAvailRow(i, "schoolId", e.target.value)}
                        style={{ width: "100%", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                        <option value="">Select school...</option>
                        {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <select value={row.day} onChange={e => updateAvailRow(i, "day", e.target.value)}
                        style={{ width: "100%", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                        {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                    <input type="time" value={row.start} onChange={e => updateAvailRow(i, "start", e.target.value)}
                      style={{ width: 100, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                    <input type="time" value={row.end} onChange={e => updateAvailRow(i, "end", e.target.value)}
                      style={{ width: 100, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                    <div style={{ display: "flex", gap: 2, width: 56 }}>
                      <button onClick={() => duplicateAvailRow(i)} title="Duplicate row"
                        style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 14, padding: 2 }}>⧉</button>
                      <button onClick={() => removeAvailRow(i)}
                        style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 2 }}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {form.availability.length > 0 && (
              <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 6 }}>
                Tip: Use the ⧉ button to duplicate a row, then change the day or school.
              </div>
            )}
          </div>

          <Input label="Notes" value={form.notes} onChange={v => setForm(p => ({ ...p, notes: v }))} multiline placeholder="Specialties, preferences, etc." />

          {/* Teacher Breaks per School */}
          <div style={{ marginBottom: 14, marginTop: -4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5 }}>Breaks</label>
              <Btn variant="ghost" onClick={addBreakRow} style={{ fontSize: 12 }}>+ Add Break</Btn>
            </div>
            <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10, paddingLeft: 2 }}>
              ☕ Times when this teacher must not have lessons at a specific school. If a school has its own break schedule (set in Schools tab), that will take priority.
            </div>
            {(form.teacherBreaks || []).length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {/* Header */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", paddingBottom: 4 }}>
                  <div style={{ flex: 2, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>School</div>
                  <div style={{ flex: 1, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Day</div>
                  <div style={{ width: 100, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Start</div>
                  <div style={{ width: 100, fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>End</div>
                  <div style={{ width: 56 }}></div>
                </div>
                {(form.teacherBreaks || []).map((brk, i) => {
                  const schoolHasBreaks = schools.find(s => s.id === brk.schoolId)?.teacherBreaks?.length > 0;
                  return (
                    <div key={brk.id || i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", background: schoolHasBreaks ? "#FFF7ED" : colors.bg, borderRadius: 8, border: schoolHasBreaks ? "1px solid #FED7AA" : undefined }}>
                      <div style={{ flex: 2 }}>
                        <select value={brk.schoolId || ""} onChange={e => updateBreakRow(i, "schoolId", e.target.value)}
                          style={{ width: "100%", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                          <option value="">Select school...</option>
                          {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </div>
                      <div style={{ flex: 1 }}>
                        <select value={brk.day || "All"} onChange={e => updateBreakRow(i, "day", e.target.value)}
                          style={{ width: "100%", padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                          <option value="All">Every day</option>
                          {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </div>
                      <input type="time" value={brk.start} onChange={e => updateBreakRow(i, "start", e.target.value)}
                        style={{ width: 100, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                      <input type="time" value={brk.end} onChange={e => updateBreakRow(i, "end", e.target.value)}
                        style={{ width: 100, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                      <div style={{ display: "flex", gap: 2, width: 56 }}>
                        <button onClick={() => duplicateBreakRow(i)} title="Duplicate row"
                          style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 14, padding: 2 }}>⧉</button>
                        <button onClick={() => removeBreakRow(i)}
                          style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 2 }}>×</button>
                      </div>
                      {schoolHasBreaks && (
                        <span style={{ fontSize: 10, color: "#B45309", fontWeight: 500, whiteSpace: "nowrap" }}>⚠ school override</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px dashed ${colors.border}` }}>
                No breaks defined — this teacher can be scheduled in any available slot
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveTeacher}>Save Teacher</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); }}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageTitle subtitle={`${teachers.length} teachers`} pageColor={PAGE_COLORS.teachers}
        action={<div style={{ display: "flex", gap: 8 }}><FileUpload onData={handleImport} label="Import" /><Btn onClick={newTeacher}>+ Add Teacher</Btn></div>}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        Teachers
      </PageTitle>

      {teachers.length === 0 ? (
        <EmptyState icon="🎵" title="No teachers yet" subtitle="Add teachers with their instruments, availability, and schools." action="+ Add Teacher" onAction={newTeacher} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {teachers.map(t => (
            <Card key={t.id} style={{ cursor: "pointer", padding: 0, overflow: "hidden" }} onClick={() => editTeacher(t)}>
              <div style={{ background: colors.sidebarActive, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 600, fontSize: 16, color: colors.white }}>{t.name}</div>
                <Btn variant="danger" onClick={(e) => { e.stopPropagation(); deleteTeacher(t.id); }} style={{ fontSize: 12, padding: "3px 10px" }}>Remove</Btn>
              </div>
              <div style={{ padding: "10px 14px" }}>
                {(t.email || t.phone) && (
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2, display: "flex", gap: 12 }}>
                    {t.email && <span>✉ {t.email}</span>}
                    {t.phone && <span>📞 {t.phone}</span>}
                  </div>
                )}
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {t.instruments.map((inst, i) => (
                    <Tag key={i} color={getInstColor(inst.name)}>
                      {inst.name}
                    </Tag>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: colors.textLight, marginTop: 6 }}>
                  {(() => {
                    const bySchool = {};
                    for (const a of t.availability) {
                      const sName = schools.find(s => s.id === a.schoolId)?.name || "Unknown";
                      if (!bySchool[sName]) bySchool[sName] = [];
                      bySchool[sName].push(a.day.slice(0, 3));
                    }
                    if (Object.keys(bySchool).length === 0) return "No availability set";
                    return Object.entries(bySchool).map(([school, days]) =>
                      `${school}: ${[...new Set(days)].join(", ")}`
                    ).join(" · ");
                  })()}
                </div>
                {(t.teacherBreaks || []).length > 0 && (
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
                    ☕ Breaks: {(() => {
                      const bySchool = {};
                      for (const b of t.teacherBreaks) {
                        const sName = schools.find(s => s.id === b.schoolId)?.name || "Unknown";
                        if (!bySchool[sName]) bySchool[sName] = [];
                        const dayLabel = b.day && b.day !== "All" ? `${b.day.slice(0, 3)} ` : "";
                        bySchool[sName].push(`${dayLabel}${b.start}–${b.end}`);
                      }
                      return Object.entries(bySchool).map(([school, times]) =>
                        `${school}: ${times.join(", ")}`
                      ).join(" · ");
                    })()}
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {teachers.length > 0 && (
        <Card style={{ marginTop: 20, background: colors.accentLight, borderColor: colors.accent + "40" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.accentDark, marginBottom: 6 }}>📋 Spreadsheet Import Format</div>
          <div style={{ fontSize: 12, color: colors.accentDark, lineHeight: 1.6 }}>
            Columns: <strong>name, instruments</strong> (comma-separated), <strong>schools</strong> (comma-separated school names),
            <strong> days</strong> (comma-separated), <strong>start_time, end_time</strong>, <strong>notes</strong>.
            <br />Each teacher will get an availability entry for each school × day combination.
          </div>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// GROUPS MANAGER
// ============================================================
function GroupsManager({ groups, setGroups, students, schools, teachers, timetable, onRevertGroup, onAddGroupToMaster, notify, focusGroupId, onClearFocusGroup, onReturn, onViewStudent, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  // Lazy initialisers: if focusGroupId is set on mount, open edit form immediately
  const [form, setForm] = useState(() => {
    if (focusGroupId) { const g = groups.find(gr => gr.id === focusGroupId); return g ? { ...g, studentIds: [...(g.studentIds || [])] } : null; }
    return null;
  });
  const [editing, setEditing] = useState(() => {
    if (focusGroupId) { const g = groups.find(gr => gr.id === focusGroupId); return g ? g.id : null; }
    return null;
  });
  const [groupWarnings, setGroupWarnings] = useState({}); // groupId -> { reason, showManual }
  const [manualSched, setManualSched] = useState(null); // { groupId, day, time }
  const [draggedStudentId, setDraggedStudentId] = useState(null);
  const [dragOverStudentId, setDragOverStudentId] = useState(null);
  const filterSchool = (viewState || {}).filterSchool || "";
  const setFilterSchool = (v) => setViewState(prev => ({ ...prev, filterSchool: v }));

  // Close form when sidebar re-navigates to this page
  const resetSignal = (viewState || {}).resetSignal || 0;
  const lastResetSignal = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal !== lastResetSignal.current) {
      lastResetSignal.current = resetSignal;
      setForm(null); setEditing(null);
    }
  }, [resetSignal]);

  // Clear focusGroupId after consumed; also handles focusGroupId changing while mounted
  const lastFocusGroupId = useRef(focusGroupId);
  useEffect(() => {
    if (focusGroupId && focusGroupId !== lastFocusGroupId.current) {
      const g = groups.find(gr => gr.id === focusGroupId);
      if (g) { setForm({ ...g, studentIds: [...(g.studentIds || [])] }); setEditing(g.id); }
    }
    if (focusGroupId) { lastFocusGroupId.current = null; if (onClearFocusGroup) onClearFocusGroup(); }
  }, [focusGroupId]);

  // Students eligible for groups: those with "group" or "club" in any instrument name
  const groupStudents = students.filter(s => s.instruments.some(i => i.isGroup));

  // Students already assigned to a group
  const assignedIds = new Set(groups.flatMap(g => g.studentIds || []));
  const unassignedStudents = groupStudents.filter(s => !assignedIds.has(s.id));

  // Filter by school
  const filteredUnassigned = filterSchool
    ? unassignedStudents.filter(s => s.schoolId === filterSchool)
    : unassignedStudents;

  const filteredGroups = filterSchool
    ? groups.filter(g => g.schoolId === filterSchool)
    : groups;

  const newGroup = () => {
    setForm({
      id: uid(), name: "", schoolId: schools.length === 1 ? schools[0].id : "",
      instrument: "", minSize: 2, maxSize: 4,
      teacherId: "", studentIds: [], status: "forming", notes: ""
    });
    setEditing("new");
  };

  const editGroup = (g) => {
    setForm({ ...g, studentIds: [...(g.studentIds || [])] });
    setEditing(g.id);
  };

  const saveGroup = () => {
    if (!form.schoolId) { notify("Select a school", "warning"); return; }
    if (editing === "new") {
      setGroups(prev => [...prev, form]);
    } else {
      setGroups(prev => prev.map(g => g.id === form.id ? form : g));
    }
    setForm(null); setEditing(null);
    notify("Group saved!");
    if (onReturn) onReturn();
  };

  const deleteGroup = (id) => {
    // If scheduled, remove the lesson from timetable
    const group = groups.find(g => g.id === id);
    if (group?.status === "scheduled") onRevertGroup(id);
    setGroups(prev => prev.filter(g => g.id !== id));
    notify("Group removed");
  };

  const clearAllGroups = () => {
    // Revert any scheduled groups first
    groups.filter(g => g.status === "scheduled").forEach(g => onRevertGroup(g.id));
    setGroups([]);
    setGroupWarnings({});
    setManualSched(null);
    notify("All groups cleared — students returned to unassigned");
  };

  const addStudentToGroup = (studentId) => {
    if (!form) return;
    if (form.studentIds.includes(studentId)) return;
    setForm(prev => ({ ...prev, studentIds: [...prev.studentIds, studentId] }));
  };

  const removeStudentFromGroup = (studentId) => {
    if (!form) return;
    setForm(prev => ({ ...prev, studentIds: prev.studentIds.filter(id => id !== studentId) }));
  };

  const handleAddToMaster = (groupId) => {
    if (!onAddGroupToMaster) return;
    const result = onAddGroupToMaster(groupId);
    if (result && !result.success) {
      setGroupWarnings(prev => ({ ...prev, [groupId]: { reason: result.reason, showManual: true } }));
    } else {
      setGroupWarnings(prev => { const n = { ...prev }; delete n[groupId]; return n; });
    }
  };

  const handleManualAdd = (groupId) => {
    if (!manualSched || !onAddGroupToMaster) return;
    const result = onAddGroupToMaster(groupId, manualSched.day, manualSched.time);
    if (result && result.success) {
      setManualSched(null);
      setGroupWarnings(prev => { const n = { ...prev }; delete n[groupId]; return n; });
    }
  };


  // Group form
  if (form) {
    const _saveGroupOnEnter = (e) => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") { e.preventDefault(); saveGroup(); } };
    const schoolStudents = groupStudents.filter(s => s.schoolId === form.schoolId && !assignedIds.has(s.id) && !form.studentIds.includes(s.id));
    const formMembers = form.studentIds.map(sid => students.find(s => s.id === sid)).filter(Boolean);
    const isFull = form.studentIds.length >= form.maxSize;
    const isReady = form.studentIds.length >= form.minSize;

    return (
      <div onKeyDown={_saveGroupOnEnter}>
        <PageTitle navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>{editing === "new" ? "Create Group" : "Edit Group"}</PageTitle>
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <Input label="Group Name (optional)" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder="e.g. Ukulele Club A" />
            <Input label="Instrument / Activity (optional)" value={form.instrument} onChange={v => setForm(p => ({ ...p, instrument: v }))} placeholder="e.g. Ukulele Club" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>School</label>
              <select value={form.schoolId} onChange={e => setForm(p => ({ ...p, schoolId: e.target.value, studentIds: [] }))}
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                <option value="">Select school...</option>
                {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Min Size</label>
              <input type="number" min={2} max={10} value={form.minSize} onChange={e => setForm(p => ({ ...p, minSize: parseInt(e.target.value) || 2 }))}
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Max Size</label>
              <input type="number" min={2} max={10} value={form.maxSize} onChange={e => setForm(p => ({ ...p, maxSize: parseInt(e.target.value) || 4 }))}
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Teacher</label>
            <select value={form.teacherId || ""} onChange={e => setForm(p => ({ ...p, teacherId: e.target.value }))}
              style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
              <option value="">Select teacher...</option>
              {teachers.filter(t => t.availability.some(a => a.schoolId === form.schoolId)).map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <Input label="Notes" value={form.notes || ""} onChange={v => setForm(p => ({ ...p, notes: v }))} multiline placeholder="Any notes about this group..." />

          {/* Current Members */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Members ({form.studentIds.length}/{form.maxSize})
            </label>
            {formMembers.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {formMembers.map(s => (
                  <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: colors.bg, borderRadius: 8 }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                      <span style={{ color: colors.textMuted, fontSize: 12, marginLeft: 8 }}>{s.className}</span>
                      <span style={{ color: colors.textMuted, fontSize: 12, marginLeft: 8 }}>
                        {s.instruments.filter(i => i.isGroup).map(i => i.name).join(", ")}
                      </span>
                    </div>
                    <button onClick={() => removeStudentFromGroup(s.id)}
                      style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", fontSize: 18, padding: 4 }}>×</button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic", padding: "10px 12px", background: colors.bg, borderRadius: 8, border: `1px dashed ${colors.border}` }}>
                No members yet — add students from the list below
              </div>
            )}
            {isReady && (
              <div style={{ marginTop: 6, fontSize: 12, color: colors.success, fontWeight: 500 }}>
                ✓ Group has reached minimum size ({form.minSize})
              </div>
            )}
          </div>

          {/* Available Students to Add */}
          {form.schoolId && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Available Students at {schools.find(s => s.id === form.schoolId)?.name}
              </label>
              {schoolStudents.length > 0 ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {schoolStudents.map(s => (
                    <button key={s.id} onClick={() => !isFull && addStudentToGroup(s.id)}
                      disabled={isFull}
                      style={{
                        padding: "6px 12px", borderRadius: 8, fontSize: 12, fontFamily: "inherit",
                        cursor: isFull ? "not-allowed" : "pointer",
                        border: `1px solid ${colors.border}`, background: colors.white,
                        color: isFull ? colors.textMuted : colors.text, fontWeight: 500,
                        opacity: isFull ? 0.5 : 1
                      }}>
                      + {s.name} <span style={{ color: colors.textMuted, marginLeft: 4 }}>{s.className}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic" }}>
                  No unassigned group students at this school
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn onClick={saveGroup}>Save Group</Btn>
            <Btn variant="secondary" onClick={() => { setForm(null); setEditing(null); if (onReturn) onReturn(); }}>Cancel</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // Main view
  const schoolsWithGroupStudents = [...new Set(groupStudents.map(s => s.schoolId))].map(sid => schools.find(s => s.id === sid)).filter(Boolean);

  return (
    <div>
      <PageTitle subtitle={`${groups.length} ${groups.length === 1 ? "group" : "groups"} · ${unassignedStudents.length} ungrouped ${unassignedStudents.length === 1 ? "student" : "students"}`} pageColor={PAGE_COLORS.groups}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
        action={<div style={{ display: "flex", gap: 8 }}>{groups.length > 0 && <Btn variant="danger" onClick={clearAllGroups}>🗑 Clear All</Btn>}<Btn onClick={newGroup}>+ Create Group</Btn></div>}>
        Groups
      </PageTitle>

      {/* School filter + Unassigned Students — combined blue card */}
      {(schoolsWithGroupStudents.length > 1 || filteredUnassigned.length > 0) && (
        <Card style={{ marginBottom: 20, background: "rgba(52,69,101,0.07)", borderColor: "rgba(52,69,101,0.25)" }}>
          {schoolsWithGroupStudents.length > 1 && (
            <div style={{ marginBottom: filteredUnassigned.length > 0 ? 12 : 0 }}>
              <select value={filterSchool} onChange={e => setFilterSchool(e.target.value)}
                style={{ padding: "8px 12px", border: "1px solid rgba(52,69,101,0.25)", borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: colors.white }}>
                <option value="">All Schools</option>
                {schoolsWithGroupStudents.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {filteredUnassigned.length > 0 && (
            <>
              <div style={{ fontWeight: 600, fontSize: 13, color: colors.sidebarActive, marginBottom: 10 }}>
                Unassigned Students ({filteredUnassigned.length})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {filteredUnassigned.map(s => {
                  const school = schools.find(sc => sc.id === s.schoolId);
                  const groupInsts = s.instruments.filter(i => i.isGroup).map(i => i.name).join(", ");
                  const isDragTarget = dragOverStudentId === s.id && draggedStudentId && draggedStudentId !== s.id;
                  return (
                    <div key={s.id}
                      draggable
                      onDragStart={() => { setDraggedStudentId(s.id); }}
                      onDragEnd={() => { setDraggedStudentId(null); setDragOverStudentId(null); }}
                      onDragOver={e => { e.preventDefault(); if (draggedStudentId && draggedStudentId !== s.id) setDragOverStudentId(s.id); }}
                      onDragLeave={() => setDragOverStudentId(null)}
                      onDrop={e => {
                        e.preventDefault();
                        if (draggedStudentId && draggedStudentId !== s.id) {
                          const schoolIdForGroup = s.schoolId;
                          setForm({ id: uid(), name: "", schoolId: schoolIdForGroup, instrument: "", minSize: 2, maxSize: 4, teacherId: "", studentIds: [draggedStudentId, s.id], status: "forming", notes: "" });
                          setEditing("new");
                        }
                        setDraggedStudentId(null); setDragOverStudentId(null);
                      }}
                      onClick={() => onViewStudent && onViewStudent(s.id)}
                      style={{
                        padding: "8px 12px", background: isDragTarget ? "rgba(52,69,101,0.12)" : colors.white,
                        borderRadius: 8, border: isDragTarget ? "2px solid " + colors.sidebarActive : "1px solid rgba(52,69,101,0.25)",
                        fontSize: 12, cursor: "grab", transition: "background 0.12s, border 0.12s",
                        opacity: draggedStudentId === s.id ? 0.4 : 1,
                        transform: isDragTarget ? "scale(1.03)" : "scale(1)"
                      }}
                      onMouseEnter={e => { if (!draggedStudentId) { e.currentTarget.style.background = "rgba(52,69,101,0.10)"; e.currentTarget.style.border = "1px solid rgba(52,69,101,0.35)"; e.currentTarget.style.cursor = "pointer"; } }}
                      onMouseLeave={e => { if (!isDragTarget) { e.currentTarget.style.background = colors.white; e.currentTarget.style.border = "1px solid rgba(52,69,101,0.25)"; } }}>
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      <div style={{ color: colors.textMuted, marginTop: 2 }}>{school?.name} · {s.className}</div>
                      <Tag color={colors.sidebarActive} style={{ marginTop: 4 }}>{groupInsts}</Tag>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Card>
      )}

      {/* Groups List */}
      {filteredGroups.length === 0 && filteredUnassigned.length === 0 ? (
        <EmptyState icon="👥" title="No group students" subtitle="Students with 'Group' or 'Club' in their instrument name will appear here for group allocation." action="+ Create Group" onAction={newGroup} />
      ) : filteredGroups.length === 0 ? (
        <Card style={{ textAlign: "center", padding: "30px 20px", color: colors.textMuted }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.textLight, marginBottom: 6 }}>No groups created yet</div>
          <div style={{ fontSize: 13 }}>Create a group to start assigning the students above.</div>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filteredGroups.map(g => {
            const school = schools.find(s => s.id === g.schoolId);
            const teacher = teachers.find(t => t.id === g.teacherId);
            const members = (g.studentIds || []).map(sid => students.find(s => s.id === sid)).filter(Boolean);
            const statusColors = { forming: "#6B7280", ready: colors.success, scheduled: colors.accent };
            const statusLabels = { forming: "Pending", ready: "Pending", scheduled: "Scheduled" };
            // Find scheduled lesson info
            const scheduledLesson = timetable?.lessons.find(l => l.groupId === g.id);
            const warning = groupWarnings[g.id];

            return (
              <Card key={g.id} onClick={() => editGroup(g)}
                style={{ cursor: "pointer", borderLeft: "3px solid " + colors.sidebarActive, transition: "background 0.12s, box-shadow 0.12s" }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(52,69,101,0.07)"; e.currentTarget.style.boxShadow = "0 0 0 1px rgba(52,69,101,0.25)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = ""; e.currentTarget.style.boxShadow = ""; }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 16 }}>{g.name || (members.length > 0 ? members.map(s => s.name).join(", ") : "Unnamed Group")}</span>
                      <Tag color={statusColors[g.status] || "#999"}>{statusLabels[g.status] || g.status}</Tag>
                      {g.instrument && <Tag color={instruments_colors.Group}>{g.instrument}</Tag>}
                    </div>
                    <div style={{ fontSize: 13, color: colors.textLight, marginBottom: 6 }}>
                      {school?.name} · {teacher?.name || <span style={{ fontStyle: "italic" }}>No teacher</span>} · {members.length}/{g.minSize}–{g.maxSize} members
                    </div>
                    {members.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                        {members.map(s => (
                          <Tag key={s.id} color="#666">{s.name} ({s.className})</Tag>
                        ))}
                      </div>
                    )}
                    {g.notes && <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>📝 {g.notes}</div>}
                    {scheduledLesson && (
                      <div style={{ fontSize: 12, color: colors.accent, fontWeight: 500, marginTop: 4 }}>
                        📅 {scheduledLesson.day} {toTimeLabel(scheduledLesson.start)}–{toTimeLabel(scheduledLesson.end)}
                      </div>
                    )}
                    {/* Warning when no slot found */}
                    {warning && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ padding: "8px 12px", background: "#FEF2F2", border: "1px solid #FCC", borderRadius: 8, fontSize: 12, color: colors.danger, marginBottom: 8 }}>
                          ⚠ {warning.reason}
                        </div>
                        {warning.showManual && (
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: colors.textLight }}>Manual placement:</span>
                            <select value={manualSched?.groupId === g.id ? manualSched.day : ""}
                              onChange={e => setManualSched({ groupId: g.id, day: e.target.value, time: manualSched?.time || school?.slots[0]?.start || "09:00" })}
                              style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                              <option value="">Day...</option>
                              {(school?.days || DAYS).map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                            <select value={manualSched?.groupId === g.id ? manualSched.time : ""}
                              onChange={e => setManualSched(prev => ({ ...prev, groupId: g.id, time: e.target.value }))}
                              style={{ padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                              <option value="">Time...</option>
                              {(school?.slots || []).filter(s => s.type === "class").map(s => <option key={s.id} value={s.start}>{s.start}–{s.end} ({s.name})</option>)}
                            </select>
                            {manualSched?.groupId === g.id && manualSched.day && manualSched.time && (
                              <Btn variant="secondary" onClick={() => handleManualAdd(g.id)} style={{ fontSize: 12 }}>📌 Place Here</Btn>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }} onClick={e => e.stopPropagation()}>
                    {g.status === "forming" && members.length >= g.minSize && timetable && (
                      <Btn variant="success" onClick={() => handleAddToMaster(g.id)} style={{ fontSize: 12 }}>📅 Add to Master</Btn>
                    )}
                    {g.status === "forming" && members.length >= g.minSize && !timetable && (
                      <Tag color="#D97706">Ready (generate timetable first)</Tag>
                    )}
                    <Btn variant="danger" onClick={() => deleteGroup(g.id)} style={{ fontSize: 12 }}>🗑 Delete</Btn>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// PENDING STUDENTS MANAGER
// ============================================================
function PendingManager({ students, setStudents, schools, timetable, interruptions, weeklyTimetables, setWeeklyTimetables, onSchedulePending, onViewStudent, onManualSchedule, notify, goBack, goForward, historyCursor, pageHistory }) {
  const pendingStudents = students.filter(s => s.status === "pending" || s.status === "trial");
  const [manualSched, setManualSched] = useState({}); // studentId -> { day, time, weekKey }

  // Compute remaining term weeks from today
  const termWeeks = (() => {
    const nowStr = toLocalDateStr(melbourneNow());
    const termBreaks = (interruptions || []).filter(i => i.type === "term_break");
    const weeks = [];
    const getMondayOf = (dt) => { const m = new Date(dt); const dow = m.getDay(); m.setDate(m.getDate() + (dow === 0 ? -6 : 1 - dow)); m.setHours(0,0,0,0); return m; };
    // Find term end (next term break start)
    const sorted = [...termBreaks].sort((a, b) => a.date.localeCompare(b.date));
    let termEnd = null;
    for (const tb of sorted) {
      if (tb.date > nowStr) { termEnd = tb.date; break; }
    }
    // Iterate weeks from this Monday up to term end (or 10 weeks max)
    const startMon = getMondayOf(new Date(nowStr + "T00:00:00"));
    for (let w = 0; w < 10; w++) {
      const mon = new Date(startMon); mon.setDate(startMon.getDate() + w * 7);
      const monStr = toLocalDateStr(mon);
      if (termEnd && monStr >= termEnd) break;
      const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
      const label = getTermWeekLabel(monStr, termBreaks);
      weeks.push({ weekKey: monStr, label, mon, fri });
    }
    return weeks;
  })();

  // Derive which trial students are already scheduled (have a lesson in weeklyTimetables)
  const trialScheduledMap = (() => {
    const map = {};
    for (const s of pendingStudents.filter(p => p.status === "trial")) {
      const nowStr = toLocalDateStr(melbourneNow());
      // Find lesson in any future or current week
      for (const [storageKey, data] of Object.entries(weeklyTimetables || {})) {
        const wk = storageKey.split("|")[0];
        const lessons = data.lessons || [];
        const lesson = lessons.find(l => l.studentId === s.id && l.isTrial);
        if (lesson) {
          map[s.id] = { storageKey, weekKey: wk, lesson };
          break;
        }
      }
    }
    return map;
  })();

  const activateStudent = (id) => {
    setStudents(prev => prev.map(s => s.id === id ? { ...s, status: "active" } : s));
    notify("Student moved to active — regenerate timetable to schedule them");
  };

  const removeStudent = (id) => {
    setStudents(prev => prev.filter(s => s.id !== id));
    notify("Student removed");
  };

  const schoolIds = [...new Set(pendingStudents.map(s => s.schoolId))];
  const schoolsWithPending = schoolIds.map(sid => {
    const school = schools.find(s => s.id === sid);
    const count = pendingStudents.filter(s => s.schoolId === sid).length;
    return school ? { ...school, count } : null;
  }).filter(Boolean);

  const handleManualPlace = (studentId) => {
    const ms = manualSched[studentId];
    const student = pendingStudents.find(s => s.id === studentId);
    if (!student) return;

    if (student.status === "trial") {
      if (!ms || !ms.day || !ms.time || !ms.weekKey) return;
      const school = schools.find(sc => sc.id === student.schoolId);
      if (!school) return;
      const inst = student.instruments?.[0] || {};
      const teacher = inst.teacherId ? (students.find(x => false) || null) : null; // teachers not in scope here — use teacherId only
      // Find slot end time
      const slot = (school.slots || []).find(sl => sl.start === ms.time);
      const endTime = slot ? slot.end : ms.time;
      const storageKey = ms.weekKey + "|" + student.schoolId;
      const newLesson = {
        id: uid(), studentId: student.id, studentName: student.name,
        schoolId: student.schoolId, schoolName: school.name,
        instrument: inst.name || "", teacherId: inst.teacherId || "", teacherName: "",
        day: ms.day, start: ms.time, end: endTime,
        isTrial: true, pinned: true,
      };
      setWeeklyTimetables(prev => {
        const existing = prev[storageKey] || { lessons: [], missed: [] };
        return { ...prev, [storageKey]: { ...existing, lessons: [...(existing.lessons || []), newLesson] } };
      });
      setManualSched(prev => { const n = { ...prev }; delete n[studentId]; return n; });
      notify("Trial lesson scheduled for " + student.name);
    } else {
      if (!ms || !ms.day || !ms.time || !ms.target) return;
      if (onManualSchedule) onManualSchedule(studentId, ms.day, ms.time, ms.target);
      setManualSched(prev => { const n = { ...prev }; delete n[studentId]; return n; });
    }
  };

  const statusLabels = { pending: "Pending", trial: "Trial" };
  const statusColors = { pending: "#D97706", trial: colors.sidebarActive };
  const [pendingSortCol, setPendingSortCol] = useState("name");
  const [pendingSortDir, setPendingSortDir] = useState("asc");
  const [schedPopup, setSchedPopup] = useState(null); // { id, x, y } or null
  useEffect(() => {
    if (!schedPopup) return;
    const close = () => setSchedPopup(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [schedPopup]);
  const handlePendingSort = (col) => {
    if (pendingSortCol === col) setPendingSortDir(d => d === "asc" ? "desc" : "asc");
    else { setPendingSortCol(col); setPendingSortDir("asc"); }
  };
  const sortedPendingStudents = [...pendingStudents].sort((a, b) => {
    let av = "", bv = "";
    if (pendingSortCol === "name") { av = a.name || ""; bv = b.name || ""; }
    else if (pendingSortCol === "status") { av = a.status || ""; bv = b.status || ""; }
    else if (pendingSortCol === "school") { av = schools.find(sc => sc.id === a.schoolId)?.name || ""; bv = schools.find(sc => sc.id === b.schoolId)?.name || ""; }
    else if (pendingSortCol === "class") { av = a.className || ""; bv = b.className || ""; }
    else if (pendingSortCol === "instrument") { av = a.instruments?.[0]?.name || ""; bv = b.instruments?.[0]?.name || ""; }
    const cmp = av.localeCompare(bv, undefined, { numeric: true });
    return pendingSortDir === "asc" ? cmp : -cmp;
  });

  return (
    <div>
      <PageTitle subtitle={`${pendingStudents.length} student${pendingStudents.length !== 1 ? "s" : ""} waiting`} pageColor={PAGE_COLORS.pending}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
        action={null}>
        Waiting List
      </PageTitle>

      {pendingStudents.length > 0 && !timetable && (
        <Card style={{ marginBottom: 16, padding: 14, background: "#FEF3C7", border: "1px solid #F59E0B40" }}>
          <div style={{ fontSize: 13, color: "#92400E" }}>Generate a timetable first, then use <strong>Schedule All Pending</strong> to add these students, or manually place them using the controls on each card.</div>
        </Card>
      )}

      {pendingStudents.length === 0 ? (
        <EmptyState icon="⏳" title="No pending students" subtitle="Students set to 'Pending' or 'Trial Lesson' status will appear here." />
      ) : (() => {
        const allSchools = schools.length > 0 ? schools : schools.filter(sc => pendingStudents.some(s => s.schoolId === sc.id));
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {allSchools.map(school => {
              const schoolRows = sortedPendingStudents.filter(s => s.schoolId === school.id).flatMap(s =>
                (s.instruments || [{ name: "", teacherId: "" }]).map(inst => ({ ...s, _inst: inst }))
              );
              if (schoolRows.length === 0) return null;
              return (
                <div key={school.id} style={{ borderRadius: 10, overflow: "hidden", border: `1px solid ${colors.sidebarActive}` }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
                    <colgroup>
                      <col style={{ width: "20%" }} />
                      <col style={{ width: "10%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "20%" }} />
                      <col style={{ width: "30%" }} />
                      <col style={{ width: "12%" }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th colSpan={6} style={{ background: colors.sidebarActive, padding: "10px 14px", textAlign: "left" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ color: colors.white, fontWeight: 700, fontSize: 13 }}>{school.name}</span>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12 }}>{schoolRows.length} lesson{schoolRows.length !== 1 ? "s" : ""}</span>
                              {timetable && (
                                <button onClick={() => onSchedulePending(school.id)}
                                  style={{ padding: "3px 8px", fontSize: 11, fontWeight: 600, border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6, background: "rgba(255,255,255,0.12)", color: colors.white, cursor: "pointer", fontFamily: "inherit" }}>
                                  Schedule
                                </button>
                              )}
                            </div>
                          </div>
                        </th>
                      </tr>
                      <tr style={{ background: colors.sidebarActive }}>
                        {[
                          { key: "name", label: "Name" }, { key: "status", label: "Status" },
                          { key: "class", label: "Class" }, { key: "instrument", label: "Instrument" },
                          { key: null, label: "Schedule" }, { key: null, label: "" }
                        ].map((col, ci) => (
                          <th key={ci} onClick={col.key ? () => handlePendingSort(col.key) : undefined}
                            style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, fontWeight: 600,
                              color: pendingSortCol === col.key ? "#fff" : "rgba(255,255,255,0.6)",
                              textTransform: "uppercase", letterSpacing: 0.5,
                              cursor: col.key ? "pointer" : "default", userSelect: "none",
                              whiteSpace: "nowrap", borderTop: "1px solid rgba(255,255,255,0.15)" }}>
                            {col.label}{pendingSortCol === col.key ? (pendingSortDir === "asc" ? " ▲" : " ▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                {schoolRows.map((s, _ri) => {
                  const school = schools.find(sc => sc.id === s.schoolId);
                  const ms = manualSched[s.id] || {};
                  return (
                    <tr key={s.id + (s._inst?.name || "")} style={{ borderBottom: `1px solid ${colors.borderLight}`, cursor: "pointer", background: colors.white }}
                      onClick={() => onViewStudent && onViewStudent(s.id)}
                      onMouseEnter={e => e.currentTarget.style.background = "rgba(52,69,101,0.07)"}
                      onMouseLeave={e => e.currentTarget.style.background = colors.white}>
                      <td style={{ padding: "8px 10px", fontWeight: 500, fontSize: 13 }}>
                        {s.name}
                        {s.notes && <div style={{ fontSize: 11, color: colors.textMuted, fontStyle: "italic", marginTop: 2 }}>📝 {s.notes}</div>}
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        <Tag color={statusColors[s.status] || "#999"}>{statusLabels[s.status] || s.status}</Tag>
                      </td>
                      <td style={{ padding: "8px 10px", color: colors.textLight, fontSize: 12 }}>{s.className || "—"}</td>
                      <td style={{ padding: "8px 10px" }}>
                        <Tag color={getInstColor(s._inst?.name, s._inst?.isGroup)}>{s._inst?.isGroup ? "👥 " : ""}{s._inst?.name || "—"}</Tag>
                      </td>
                      <td style={{ padding: "6px 8px", position: "relative" }} onClick={e => e.stopPropagation()}>
                        {s.status === "trial" ? (() => {
                          const trialSched = trialScheduledMap[s.id];
                          if (trialSched) {
                            return (
                              <div style={{ display: "flex", alignItems: "center", gap: 5, color: "#16A34A", fontWeight: 600, fontSize: 12 }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                Scheduled
                              </div>
                            );
                          }
                          return school ? (
                            <div style={{ display: "inline-block" }}>
                              <button onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setSchedPopup(schedPopup && schedPopup.id === s.id ? null : { id: s.id, x: r.left, y: r.top }); }}
                                style={{ padding: "4px 10px", fontSize: 12, border: `1px solid ${colors.inputBorder}`, borderRadius: 6, background: colors.white, cursor: "pointer", color: colors.sidebarActive, fontWeight: 600, fontFamily: "inherit" }}>
                                Add
                              </button>
                              {schedPopup && schedPopup.id === s.id && (
                                <div style={{ position: "fixed", ...clampMenuPos(schedPopup.x - 272, schedPopup.y, 272, 320), zIndex: 9999, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.14)", padding: "14px 16px", minWidth: 260 }}
                                  onClick={e => e.stopPropagation()}>
                                  <div style={{ fontWeight: 600, fontSize: 12, color: colors.sidebarActive, marginBottom: 10 }}>Schedule trial — {s.name}</div>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <select value={ms.weekKey || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], weekKey: e.target.value } }))}
                                      style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                      <option value="">Select week...</option>
                                      {termWeeks.map(w => <option key={w.weekKey} value={w.weekKey}>{w.label}</option>)}
                                    </select>
                                    <select value={ms.day || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], day: e.target.value } }))}
                                      style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                      <option value="">Select day...</option>
                                      {(school.days || DAYS).map(d => <option key={d} value={d}>{d}</option>)}
                                    </select>
                                    <select value={ms.time || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], time: e.target.value } }))}
                                      style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                      <option value="">Select time...</option>
                                      {(school.slots || []).filter(sl => sl.type === "class" || sl.type === "before_school" || sl.type === "after_school").map(sl => <option key={sl.id} value={sl.start}>{to12h(sl.start)}</option>)}
                                    </select>
                                    <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                                      <Btn onClick={() => { handleManualPlace(s.id); setSchedPopup(null); }} disabled={!ms.day || !ms.time || !ms.weekKey} style={{ flex: 1, fontSize: 12 }}>📌 Pin lesson</Btn>
                                      <Btn variant="secondary" onClick={() => setSchedPopup(null)} style={{ fontSize: 12 }}>Cancel</Btn>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : null;
                        })() : school && (
                          <div style={{ display: "inline-block" }}>
                            <button onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setSchedPopup(schedPopup && schedPopup.id === s.id ? null : { id: s.id, x: r.left, y: r.top }); }}
                              style={{ padding: "4px 10px", fontSize: 12, border: `1px solid ${colors.inputBorder}`, borderRadius: 6, background: colors.white, cursor: "pointer", color: colors.sidebarActive, fontWeight: 600, fontFamily: "inherit" }}>
                              Add
                            </button>
                            {schedPopup && schedPopup.id === s.id && (
                              <div style={{ position: "fixed", ...clampMenuPos(schedPopup.x - 272, schedPopup.y, 272, 320), zIndex: 9999, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.14)", padding: "14px 16px", minWidth: 260 }}
                                onClick={e => e.stopPropagation()}>
                                <div style={{ fontWeight: 600, fontSize: 12, color: colors.sidebarActive, marginBottom: 10 }}>Schedule — {s.name}</div>
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                  <select value={ms.day || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], day: e.target.value } }))}
                                    style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                    <option value="">Select day...</option>
                                    {(school.days || DAYS).map(d => <option key={d} value={d}>{d}</option>)}
                                  </select>
                                  <select value={ms.time || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], time: e.target.value } }))}
                                    style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                    <option value="">Select time...</option>
                                    {(school.slots || []).filter(sl => sl.type === "class" || sl.type === "before_school" || sl.type === "after_school").map(sl => <option key={sl.id} value={sl.start}>{to12h(sl.start)}</option>)}
                                  </select>
                                  <select value={ms.target || ""} onChange={e => setManualSched(prev => ({ ...prev, [s.id]: { ...prev[s.id], target: e.target.value } }))}
                                    style={{ padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
                                    <option value="">To...</option>
                                    <option value="master">Master timetable</option>
                                    <option value="weekly">This week only</option>
                                  </select>
                                  <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                                    <Btn onClick={() => { handleManualPlace(s.id); setSchedPopup(null); }} disabled={!ms.day || !ms.time || !ms.target} style={{ flex: 1, fontSize: 12 }}>📌 Place</Btn>
                                    <Btn variant="secondary" onClick={() => setSchedPopup(null)} style={{ fontSize: 12 }}>Cancel</Btn>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "6px 8px" }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          <button onClick={() => activateStudent(s.id)} title="Activate student"
                            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6, background: "#F0FDF4", border: "1px solid #BBF7D0", color: "#16A34A", cursor: "pointer", flexShrink: 0 }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          </button>
                          <button onClick={() => removeStudent(s.id)} title="Remove student"
                            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6, background: "#FEF2F2", border: "1px solid #FECACA", color: "#DC2626", cursor: "pointer", flexShrink: 0 }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

// ============================================================
// TIMETABLE VIEW
// ============================================================

// ============================================================
// CONFLICT SUMMARY BANNER
// ============================================================
function ConflictBanner({ constraintWarnings, ackedConstraints, lessons, students, onAckAll }) {
  const [expanded, setExpanded] = React.useState(false);
  const unacked = Object.entries(constraintWarnings).filter(([id]) => !ackedConstraints.has(id));
  if (unacked.length === 0) return null;

  const items = unacked.map(([id, warnings]) => {
    const lesson = lessons.find(l => l.id === id);
    const name = lesson
      ? (lesson.isGroup && lesson.studentNames ? lesson.studentNames.join(", ") : (lesson.studentName || "Unknown"))
      : "Unknown";
    const time = lesson ? `${lesson.day} ${lesson.start}` : "";
    return { id, name, time, warnings };
  });

  return (
    <div style={{
      marginBottom: 16, borderRadius: 10, overflow: "hidden",
      border: "1.5px solid #FCA5A5",
      boxShadow: "0 2px 8px rgba(239,68,68,0.12)",
    }}>
      {/* Header row */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 16px", cursor: "pointer",
          background: "#FEF2F2",
          userSelect: "none",
        }}>
        <span style={{ fontSize: 16 }}>⚠️</span>
        <span style={{ fontWeight: 700, fontSize: 13, color: "#DC2626", flex: 1 }}>
          {unacked.length} unacknowledged conflict{unacked.length > 1 ? "s" : ""}
        </span>
        <span style={{ fontSize: 11, color: "#DC2626", fontWeight: 500, marginRight: 6, opacity: 0.75 }}>
          Click a card and press ✓ to resolve
        </span>
        {onAckAll && (
          <button
            onClick={e => { e.stopPropagation(); onAckAll(); }}
            style={{
              fontSize: 11, fontWeight: 600, color: "#DC2626", background: "rgba(220,38,38,0.08)",
              border: "1px solid #FCA5A5", borderRadius: 6, padding: "3px 10px",
              cursor: "pointer", fontFamily: "inherit", marginRight: 6,
            }}>
            Acknowledge all
          </button>
        )}
        <span style={{ fontSize: 11, color: "#DC2626", fontWeight: 600 }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {/* Detail list */}
      {expanded && (
        <div style={{ background: "#FFF5F5", borderTop: "1px solid #FCA5A5" }}>
          {items.map((item, i) => (
            <div key={item.id} style={{
              display: "flex", alignItems: "flex-start", gap: 10,
              padding: "8px 16px",
              borderBottom: i < items.length - 1 ? "1px solid #FEE2E2" : "none",
            }}>
              <div style={{ fontSize: 11, minWidth: 120, color: "#374151", fontWeight: 600, paddingTop: 1 }}>
                {item.name}
                {item.time && <div style={{ fontWeight: 400, color: "#6B7280" }}>{item.time}</div>}
              </div>
              <div style={{ flex: 1 }}>
                {item.warnings.map((w, wi) => (
                  <div key={wi} style={{ fontSize: 11, color: "#DC2626", lineHeight: 1.5 }}>• {w}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TimetableView({ timetable, schools, students, allStudents, teachers, setTeachers, specialists, pendingStudents, masterBreaks, setMasterBreaks, viewState, setViewState, sharedSchool, setSharedSchool, onExport, onPrint, onGenerate, onGenerateSchool, onClearSchool, onClear, onSchedulePending, onMoveLesson, onDeleteLesson, onViewStudent, onViewGroup, onPlaceUnsched, onUndo, onRedo, undoCount, redoCount, onLoadVersion, onWarningsChange, initialConstraintWarnings, initialAckedConstraints, goBack, goForward, historyCursor, pageHistory }) {
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
  const [confirmClearSchool, setConfirmClearSchool] = useState(false);
  const [confirmRegenerateSchool, setConfirmRegenerateSchool] = useState(false);
  const [dragOver, setDragOver] = useState(null);
  const gridScrollRef = useRef(null);
  const savedGridScroll = useRef({});
  savedGridScroll.current = viewState.gridScroll || {};
  // Callback ref — fires when grid mounts (including when selectedSchool changes)
  const gridRefCb = React.useCallback((el) => {
    gridScrollRef.current = el;
    if (el) {
      const s = savedGridScroll.current[selectedSchool] || { top: 0, left: 0 };
      el.scrollTop = s.top; el.scrollLeft = s.left;
    }
  }, [selectedSchool]);
  const handleGridScroll = () => {
    const el = gridScrollRef.current;
    if (el) setViewState(prev => ({ ...prev, gridScroll: { ...(prev.gridScroll || {}), [selectedSchool]: { top: el.scrollTop, left: el.scrollLeft } } }));
  };
  const [draggingId, setDraggingId] = useState(null);
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
    const prevIds = prevLessonIdsRef.current;
    const newLessons = curr.filter(l => !prevIds.has(l.id));
    prevLessonIdsRef.current = new Set(curr.map(l => l.id));
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
  const [hoverNotes, setHoverNotes] = useState(false);
  const [mttAddSubmenu, setMttAddSubmenu] = useState(null); // { type, y }
  const mttSubMenuRef = React.useRef(null);
  const mttMenuRef = React.useRef(null);
  const mttCloseTimer = React.useRef(null);
  useEffect(() => {
    if (!contextMenu) return;
    const check = (e) => {
      const mx = e.clientX, my = e.clientY;
      const inMain = mttMenuRef.current && (() => { const r = mttMenuRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      const inSub = mttSubMenuRef.current && (() => { const r = mttSubMenuRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      if (inMain || inSub) {
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
          if (match) warnings.push(`${ms.name} (${ms.className}) has ${match.subject || "specialist"} at this time`);
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

    // Specialist clash — any overlap between lesson slot and specialist time
    if (student.className) {
      const key = lesson.schoolId + "|" + student.className + "|" + newDay;
      const specs = specLookupRef[key] || [];
      const match = specs.find(sp => slotStart < sp.end && slotEnd > sp.start);
      if (match) warnings.push(student.className + " has " + (match.subject || "specialist") + " at this time");
    }

    return warnings;
  };


  const showHoverPanel = (x, y, warnings, specs) => {
    const el = hoverPanelRef.current;
    if (!el) return;
    if (!warnings.length && !specs.length) { el.style.display = "none"; return; }
    let html = "";
    if (specs.length > 0) html += '<div style="color:#7C3AED;font-weight:600;margin-bottom:' + (warnings.length ? "4px" : "0") + '">' + specs.join(", ") + "</div>";
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
        <PageTitle subtitle="Generate a master timetable to view it here" pageColor={PAGE_COLORS.timetable}>Master Timetable</PageTitle>
        <div style={{ textAlign: "center", padding: "60px 20px", color: colors.textMuted }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.5 }}>📅</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: colors.textLight, marginBottom: 8 }}>No master timetable generated yet</div>
          <div style={{ fontSize: 14, marginBottom: 24, maxWidth: 400, margin: "0 auto 24px" }}>Set up your schools, students, and teachers, then hit Generate.</div>
          {confirmGenerateEmpty ? (
            <div style={{ display: "inline-flex", flexDirection: "column", gap: 8, border: `2px solid ${colors.accent}`, borderRadius: 10, padding: "12px 16px", minWidth: 200 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>Generate Timetable?</div>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn onClick={() => { setConfirmGenerateEmpty(false); onGenerate(); }} style={{ flex: 1, justifyContent: "center" }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmGenerateEmpty(false)} style={{ flex: 1, justifyContent: "center" }}>No</Btn>
              </div>
            </div>
          ) : (
            <Btn onClick={() => setConfirmGenerateEmpty(true)}>Generate Timetable</Btn>
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
    <div onClick={() => { if (contextMenu) { setContextMenu(null); setMttAddSubmenu(null); setHoverNotes(false); } if (expandedWarnings.size > 0) setExpandedWarnings(new Set()); if (showVersionMenu) setShowVersionMenu(false); }}>
      {/* Right-click context menu */}
      {contextMenu && (
        <div ref={mttMenuRef} style={{ position: "fixed", ...(contextMenu.fromMissed ? { bottom: window.innerHeight - contextMenu.y + 4, top: "auto" } : (contextMenu.y + 160 > window.innerHeight ? { bottom: window.innerHeight - contextMenu.y + 4, top: "auto" } : { top: contextMenu.y })), left: clampMenuPos(contextMenu.x, contextMenu.y, 200, 0).left, zIndex: 9999, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 160 }}
          onClick={e => e.stopPropagation()}>
          {contextMenu.isEmpty ? (
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
              {(pendingStudents || []).some(s => s.schoolId === contextMenu.schoolId && s.status === "pending") && (() => {
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
                    <SubPanel type="pending" color="#D97706" title="Add pending">
                      {[...pendingRows].sort((a, b) => (a.name || "").localeCompare(b.name || "") || (a._inst?.name || "").localeCompare(b._inst?.name || "")).map((row, ri) => (
                        <button key={row.id + (row._inst?.name || "") + ri} onClick={() => {
                          if (onSchedulePending) onSchedulePending(row.id, contextMenu.schoolId, contextMenu.day, contextMenu.time, row._inst?.name);
                          setContextMenu(null); setMttAddSubmenu(null);
                        }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit", textAlign: "left" }}
                          onMouseEnter={e => e.currentTarget.style.background = "#FFFBEB"}
                          onMouseLeave={e => e.currentTarget.style.background = "none"}>
                          <span>{row.name}</span>
                          <span style={{ fontSize: 11, color: "#6B7280" }}>{row._inst?.name || ""}</span>
                        </button>
                      ))}
                    </SubPanel>
                    <button style={mkItemStyle("#D97706")}
                      onMouseEnter={e => { e.currentTarget.style.background = "#FFFBEB"; setMttAddSubmenu({ type: "pending", y: e.currentTarget.getBoundingClientRect().top }); }}
                      onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      <span>⏳ Add pending</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                    </button>
                  </div>
                );
              })()}
            </div>
          ) : (
            <>
              <div style={{ padding: "8px 12px", fontSize: 12, color: colors.textMuted, borderBottom: `1px solid ${colors.borderLight}`, fontWeight: 600 }}>
                {contextMenu.lessonName}
              </div>
              <div style={{ padding: "6px 4px" }}>
                {contextMenu.isGroup ? (() => {
                  const lesson = timetable && timetable.lessons.find(l => l.id === contextMenu.lessonId);
                  const memberIds = (lesson && lesson.studentIds) || [];
                  const allStu = allStudents || students;
                  return memberIds.map((mid, mi) => {
                    const st = allStu.find(s => s.id === mid);
                    if (!st) return null;
                    const constraints = [];
                    if (st.outsideClassOnly) constraints.push("Outside class only");
                    if (st.outsideClassPreferred) constraints.push("Prefers outside class");
                    if (st.availableBefore) constraints.push("Available before school");
                    if (st.availableAfter) constraints.push("Available after school");
                    if (st.instruments && st.instruments.some(i => i.teacherId)) {
                      const assignedNames = st.instruments.filter(i => i.teacherId).map(i => { const t = teachers.find(t2 => t2.id === i.teacherId); return t ? i.name + ": " + t.name : null; }).filter(Boolean).join(", ");
                      if (assignedNames) constraints.push("Assigned: " + assignedNames);
                    }
                    const multiLesson = st.instruments.length > 1 || st.instruments.some(i => i.isGroup);
                    if (multiLesson) constraints.push("Multi-lesson: different days required");
                    return (
                      <div key={mid} style={{ borderBottom: mi < memberIds.length - 1 ? `1px solid ${colors.borderLight}` : "none" }}>
                        <div style={{ padding: "6px 12px 2px", fontSize: 12, fontWeight: 600, color: colors.text }}>
                          {st.name}{st.className ? " · " + st.className : ""}
                        </div>
                        <div style={{ padding: "2px 12px 6px", fontSize: 12 }}>
                          {constraints.length > 0 ? constraints.map((c, ci) => (
                            <div key={ci} style={{ color: colors.textMuted, padding: "1px 0" }}>• {c}</div>
                          )) : (
                            <div style={{ color: colors.textMuted, fontStyle: "italic" }}>No constraints</div>
                          )}
                          {st.notes && (
                            <div style={{ marginTop: 4, padding: "4px 8px", background: colors.bg, borderRadius: 4, fontSize: 11, color: colors.textMuted, whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
                              📝 {st.notes}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  });
                })() : (() => {
                  const st = (allStudents || students).find(s => s.id === contextMenu.studentId);
                  if (!st) return null;
                  const constraints = [];
                  if (st.outsideClassOnly) constraints.push("Outside class only");
                  if (st.outsideClassPreferred) constraints.push("Prefers outside class");
                  if (st.availableBefore) constraints.push("Available before school");
                  if (st.availableAfter) constraints.push("Available after school");
                  if (st.instruments && st.instruments.some(i => i.teacherId)) { const assignedNames = st.instruments.filter(i => i.teacherId).map(i => { const t = teachers.find(t2 => t2.id === i.teacherId); return t ? i.name + ": " + t.name : null; }).filter(Boolean).join(", "); if (assignedNames) constraints.push("Assigned teacher(s): " + assignedNames); }
                  const multiLesson = st.instruments.length > 1 || st.instruments.some(i => i.isGroup);
                  if (multiLesson) constraints.push("Multi-lesson: different days required");
                  return (<>
                    <div style={{ padding: "6px 12px", fontSize: 12, borderBottom: `1px solid ${colors.borderLight}` }}>
                      {constraints.length > 0 ? constraints.map((c, ci) => (
                        <div key={ci} style={{ color: colors.textMuted, padding: "2px 0" }}>• {c}</div>
                      )) : (
                        <div style={{ color: colors.textMuted, fontStyle: "italic" }}>No constraints</div>
                      )}
                    </div>
                    {st.notes && (
                      <div style={{ position: "relative" }}
                        onMouseEnter={() => setHoverNotes(true)}
                        onMouseLeave={() => setHoverNotes(false)}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", fontSize: 13, color: colors.text, borderRadius: 6, cursor: "default", borderBottom: `1px solid ${colors.borderLight}`, background: hoverNotes ? colors.bg : "none" }}>
                          📝 Notes
                        </div>
                        {hoverNotes && (
                          <div style={{ position: "absolute", left: "100%", top: 0, marginLeft: 4, padding: "10px 14px", background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", fontSize: 12, color: colors.text, maxWidth: 240, minWidth: 140, whiteSpace: "pre-wrap", zIndex: 10000, lineHeight: 1.5 }}>
                            {st.notes}
                          </div>
                        )}
                      </div>
                    )}
                  </>);
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
                <span style={{ fontSize: 12, color: "#5B3F7A", fontWeight: 500 }}>Regenerate all?</span>
                <Btn variant="primary" onClick={() => { onGenerate(); setConfirmRegenerate(false); }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, background: "#5B3F7A", color: "#fff", border: "none" }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmRegenerate(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
              </div>
            ) : (
              <Btn variant="secondary" onClick={() => setConfirmRegenerate(true)} title="Regenerate" style={{ color: colors.blue600, border: "none" }}>🔄</Btn>
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
                    <Btn variant="secondary" onClick={() => setShowSavePrompt(true)} style={{ fontSize: 12 }}>💾</Btn>
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
                    <span style={{ fontSize: 12, color: "#5B3F7A", fontWeight: 500, whiteSpace: "nowrap" }}>Regenerate?</span>
                    <Btn variant="primary" onClick={() => { onGenerateSchool(selectedSchool); setConfirmRegenerateSchool(false); }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, background: "#5B3F7A", color: "#fff", border: "none" }}>Yes</Btn>
                    <Btn variant="secondary" onClick={() => setConfirmRegenerateSchool(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
                  </div>
                ) : (
                  <Btn variant="secondary" onClick={() => setConfirmRegenerateSchool(true)} title="Regenerate this school" style={{ color: "#5B3F7A", border: "none" }}>🔄</Btn>
                )}
                {(() => {
                  const schoolPendingCount = (pendingStudents || []).filter(s => s.schoolId === selectedSchool).length;
                  return schoolPendingCount > 0 ? (
                    <Btn variant="success" onClick={() => onSchedulePending(selectedSchool)} style={{ fontSize: 12 }}>📅 Add Pending ({schoolPendingCount})</Btn>
                  ) : null;
                })()}
              </div>
            </div>
          </Card>
          {/* Grid View */}
          {viewMode === "grid" && (
            <div ref={gridRefCb} onScroll={handleGridScroll} style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 200px)", border: `1px solid ${colors.border}`, borderRadius: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: `50px repeat(${DAYS.length}, 1fr)`, gap: 1, background: colors.border }}>
                {/* Header row — sticky */}
                <div style={{ background: colors.sidebarActive, color: colors.white, padding: "12px 8px", fontSize: 11, fontWeight: 600, textAlign: "center", position: "sticky", top: 0, zIndex: 10 }}>Time</div>
                {DAYS.map(d => (
                  <div key={d} style={{ background: colors.sidebarActive, color: colors.white, padding: "12px 8px", fontSize: 13, fontWeight: 600, textAlign: "center", position: "sticky", top: 0, zIndex: 10 }}>{d}</div>
                ))}

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
                            if (draggingId && !draggingId.includes(":") && currentSchool) {
                              const ck = day + "|" + row.time;
                              if (!dragCache.current[ck]) {
                                try {
                                  const dl = (timetable ? timetable.lessons : []).find(l => l.id === draggingId);
                                  const sl = (currentSchool.slots || []).find(s => s.start === row.time);
                                  if (dl && sl) {
                                    const raw = checkConstraints(dl, day, sl);
                                    const warns = raw.filter(w => !(w.includes("already has") && w.includes("at this time")));
                                    const st = (allStudents || students).find(s => s.id === dl.studentId);
                                    const specs = st && st.className ? (specLookupRef[dl.schoolId + "|" + st.className + "|" + day] || []).filter(sp => { const sS = timeToMin(sl.start), sE = timeToMin(sl.end || sl.start); return sS < sp.end && sE > sp.start; }).map(sp => sp.subject || "Specialist") : [];
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
                          if (lid.startsWith("unsched:")) {
                            handleDropUnsched(lid, day, row.time);
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
                              onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, lessonId: l.id, studentId: l.studentId, isGroup: l.isGroup, lessonName: l.isGroup && l.studentNames ? `${l.studentNames.join(", ")} — ${l.instrument}` : `${l.studentName} — ${l.instrument}` }); }}
                              onDoubleClick={() => { if (l.isGroup && onViewGroup) onViewGroup(l.groupId); else if (!l.isGroup && onViewStudent) onViewStudent(l.studentId); }}
                              onClick={e => { if (isExpanded || showRed) { e.stopPropagation(); setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); return next; }); setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; }); } }}
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
                              <div style={{ fontWeight: 600, color: colors.text }}>{l.isGroup ? "👥 " : ""}{l.isGroup && l.studentNames ? (() => { const allStu = allStudents || students; const names = l.studentNames.join(", "); const classes = (l.studentIds || []).map(sid => { const ms = allStu.find(s => s.id === sid); return ms?.className || ""; }).filter(Boolean); const uniqueClasses = [...new Set(classes)]; const classSuffix = uniqueClasses.length > 0 ? " — " + (uniqueClasses.length === 1 ? uniqueClasses[0] : classes.join(", ")) : ""; return names + classSuffix; })() : l.studentName + (() => { const st = (allStudents || students).find(s => s.id === l.studentId); return st?.className ? " · " + st.className : ""; })()}</div>
                              <div style={{ color: colors.textLight }}>{l.instrument ? `${l.instrument} · ` : ""}{l.teacherName.split(" ")[0]}</div>
                              {(() => { const ds = getLiveSpecialistTag(l); return ds ? <div style={{ color: "#8B5CF6", fontSize: 10, fontWeight: 600 }}>during {typeof ds === "string" ? ds : "specialist"}</div> : null; })()}
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
                        <td style={{ padding: "8px 14px", fontWeight: 500 }}>{l.isGroup ? "👥 " : ""}{l.isGroup && l.studentNames ? l.studentNames.join(", ") : l.studentName}</td>
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
              <Card style={{ marginTop: 20,
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
                      <div style={{ fontWeight: 600 }}>{u.student.name} — {u.instrument || u.student.instruments[0]?.name}</div>
                      <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>{u.reason}</div>
                    </div>
                  ))}
                  {!hasItems && unschedDragOver && (
                    <div style={{ fontSize: 12, color: colors.danger, fontStyle: "italic" }}>Drop to remove from timetable</div>
                  )}
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
// WEEKLY TIMETABLE GENERATION
// ============================================================
function generateWeeklyTimetable(masterLessons, school, students, teachers, specialists, interruptions, weekDates, aiHints = [], masterBreaksForSchool = []) {
  const schoolLessons = masterLessons.filter(l => l.schoolId === school.id);
  const weekDateMap = {};
  for (const wd of weekDates) weekDateMap[wd.day] = wd.date;

  // Build interruption lookup for this week at this school
  const weekInterruptions = interruptions.filter(i => {
    if (i.type === "term_break") return false;
    if (i.schoolId !== school.id && i.schoolId !== "all") return false;
    const start = i.date;
    const end = i.endDate || i.date;
    return weekDates.some(wd => wd.date >= start && wd.date <= end);
  });

  const isLessonAffected = (lesson) => {
    const lessonDate = weekDateMap[lesson.day];
    if (!lessonDate) return false;
    for (const intr of weekInterruptions) {
      const start = intr.date;
      const end = intr.endDate || intr.date;
      if (lessonDate < start || lessonDate > end) continue;
      // Date matches — check class
      if (intr.affectsClasses !== "all") {
        const studentObj = students.find(s => s.id === lesson.studentId);
        const className = studentObj?.className || lesson.studentName || "";
        if (!classMatchesInterruption(className, intr.affectsClasses)) {
          continue;
        }
      }
      // Class matches — check time
      if (intr.startTime && intr.endTime) {
        const iStart = timeToMin(intr.startTime);
        const iEnd = timeToMin(intr.endTime);
        const lStart = timeToMin(lesson.start);
        const lEnd = timeToMin(lesson.end);
        if (lStart >= iEnd || lEnd <= iStart) {
          continue;
        }
      }
      return true;
    }
    for (const hint of aiHints) {
      if ((hint.action === "cancel" || hint.action === "move" || hint.action === "move_earlier" || hint.action === "move_later" || hint.action === "reschedule_day" || hint.action === "teacher_swap" || hint.action === "swap") && hint.lessonMatch && hint.lessonMatch(lesson)) return true;
    }
    return false;
  };

  const isDayBlocked = (dayName) => {
    const date = weekDateMap[dayName];
    if (!date) return true;
    return weekInterruptions.some(intr => {
      const start = intr.date;
      const end = intr.endDate || intr.date;
      if (date < start || date > end) return false;
      return intr.affectsClasses === "all" && !intr.startTime;
    });
  };

  const isSlotBlocked = (dayName, slotStart, slotEnd, className) => {
    const date = weekDateMap[dayName];
    if (!date) return true;
    for (const intr of weekInterruptions) {
      const start = intr.date;
      const end = intr.endDate || intr.date;
      if (date < start || date > end) continue;
      if (intr.affectsClasses !== "all") {
        if (!classMatchesInterruption(className, intr.affectsClasses)) continue;
      }
      if (!intr.startTime) return true;
      const iStart = timeToMin(intr.startTime);
      const iEnd = timeToMin(intr.endTime);
      const sStart = timeToMin(slotStart);
      const sEnd = timeToMin(slotEnd);
      if (sStart < iEnd && sEnd > iStart) return true;
    }
    return false;
  };

  // Build specialist lookup for this school
  const specLookup = {};
  for (const entry of specialists) {
    if (entry.schoolId !== school.id) continue;
    const key = `${entry.className}|${entry.day}`;
    if (!specLookup[key]) specLookup[key] = [];
    specLookup[key].push({ start: timeToMin(entry.start), end: timeToMin(entry.end), subject: entry.subject || true });
  }
  // Build set of freed specialist slots from aiHints (e.g. "spelling cancelled this afternoon")
  // A hint with action "free_specialist" removes that subject/time from clash checking
  const isSpecCancelled = (subject, className, day, slotStart, slotEnd) => {
    return aiHints.some(h => {
      if (h.action !== "free_specialist") return false;
      if (h.targetDay && h.targetDay !== day) return false;
      if (h.targetClassName) {
        const hCls = h.targetClassName.toLowerCase();
        const sCls = className.toLowerCase();
        if (!sCls.includes(hCls) && !hCls.includes(sCls)) return false;
      }
      if (h.targetSubject) {
        const hSub = h.targetSubject.toLowerCase();
        const sSub = (subject || "").toLowerCase();
        if (!sSub.includes(hSub) && !hSub.includes(sSub)) return false;
      }
      // Time range check: does the hint's time overlap this slot?
      if (h.targetStart && h.targetEnd) {
        const hS = timeToMin(h.targetStart), hE = timeToMin(h.targetEnd);
        const sS = timeToMin(slotStart), sE = timeToMin(slotEnd);
        if (sS >= hE || sE <= hS) return false;
      } else if (h.targetPeriod) {
        const sS = timeToMin(slotStart);
        if (h.targetPeriod === "morning" && sS >= timeToMin("12:00")) return false;
        if (h.targetPeriod === "afternoon" && sS < timeToMin("12:00")) return false;
      }
      return true;
    });
  };

  const isSpecialistClash = (className, day, slotStart, slotEnd) => {
    const specs = specLookup[`${className}|${day}`];
    if (!specs) return false;
    const sStart = timeToMin(slotStart);
    const sEnd = timeToMin(slotEnd);
    return specs.some(sp => {
      if (sStart >= sp.end || sEnd <= sp.start) return false;
      if (isSpecCancelled(sp.subject, className, day, slotStart, slotEnd)) return false;
      return true;
    });
  };
  // Returns specialist subject (or true) if slot clashes, else false
  const getSpecialistTag = (lesson, day, slotStart, slotEnd) => {
    if (lesson.isGroup) return false;
    const student = students.find(s => s.id === lesson.studentId);
    if (!student) return false;
    const specs = specLookup[`${student.className}|${day}`];
    if (!specs) return false;
    const sStart = timeToMin(slotStart), sEnd = timeToMin(slotEnd);
    const match = specs.find(sp => {
      if (sStart >= sp.end || sEnd <= sp.start) return false;
      if (isSpecCancelled(sp.subject, student.className, day, slotStart, slotEnd)) return false;
      return true;
    });
    return match ? match.subject : false;
  };

  // Break lookup
  const schoolBreaks = (school.teacherBreaks || []).map(b => ({
    start: timeToMin(b.start), end: timeToMin(b.end), day: b.day || "All"
  }));
  const isDuringBreak = (teacherId, day, slotStart, slotEnd) => {
    const sMid = (timeToMin(slotStart) + timeToMin(slotEnd)) / 2;
    if (schoolBreaks.some(b => (b.day === "All" || b.day === day) && sMid >= b.start && sMid < b.end)) return true;
    const teacher = teachers.find(t => t.id === teacherId);
    const tBreaks = (teacher?.teacherBreaks || []).filter(b => b.schoolId === school.id);
    if (tBreaks.some(b => {
      const bDay = b.day || "All";
      if (bDay !== "All" && bDay !== day) return false;
      return sMid >= timeToMin(b.start) && sMid < timeToMin(b.end);
    })) return true;
    // Master break cards block this slot
    return masterBreaksForSchool.some(b => b.day === day && timeToMin(b.time) === timeToMin(slotStart));
  };

  // Returns earliest time (mins) a student/teacher is available on a given day (notAvailableUntil hints)
  const getNotAvailUntil = (lesson, day) => {
    let until = 0;
    for (const h of aiHints) {
      if (!h.notAvailableUntil) continue;
      if (h.sourceDay && h.sourceDay !== day) continue;
      if (!h.lessonMatch || !h.lessonMatch({ ...lesson, day })) continue;
      const t = timeToMin(h.notAvailableUntil);
      if (t > until) until = t;
    }
    return until;
  };

  // Returns true if a blocked_window hint blocks the student/teacher from a specific slot
  const isBlockedWindow = (lesson, day, slotStart, slotEnd) => {
    const sS = timeToMin(slotStart), sE = timeToMin(slotEnd);
    return aiHints.some(h => {
      if (h.action !== "blocked_window") return false;
      if (h.sourceDay && h.sourceDay !== day) return false;
      if (!h.lessonMatch || !h.lessonMatch({ ...lesson, day })) return false;
      if (!h.blockedWindowStart || !h.blockedWindowEnd) return false;
      const wS = timeToMin(h.blockedWindowStart), wE = timeToMin(h.blockedWindowEnd);
      return sS < wE && sE > wS; // overlap
    });
  };

  // Teacher schedule tracker
  const teacherSched = {};
  teachers.forEach(t => { teacherSched[t.id] = []; });

  const isTeacherFree = (teacherId, day, slotStart, slotEnd) => {
    const teacher = teachers.find(t => t.id === teacherId);
    if (!teacher) return false;
    const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === day);
    if (!dayAvail) return false;
    if (timeToMin(slotStart) < timeToMin(dayAvail.start) || timeToMin(slotEnd) > timeToMin(dayAvail.end)) return false;
    if (isDuringBreak(teacherId, day, slotStart, slotEnd)) return false;
    if (teacherSched[teacherId]?.some(l => l.day === day && l.start === slotStart)) return false;
    return true;
  };

  // Relaxed check for AI-directed overrides: only prevents double-booking
  const isTeacherFreeOverride = (teacherId, day, slotStart) => {
    if (!teacherSched[teacherId]) return true;
    return !teacherSched[teacherId].some(l => l.day === day && l.start === slotStart);
  };

  // Separate affected / unaffected
  const affected = [];
  const unaffected = [];
  for (const lesson of schoolLessons) {
    if (isLessonAffected(lesson)) affected.push(lesson);
    else unaffected.push(lesson);
  }

  // AI forced moves
  const forcedMoves = {};
  const forcedDays = {};    // lessonId -> targetDay (for reschedule_day)
  const forcedTeacher = {}; // lessonId -> { teacherId, teacherName } (for teacher_swap)
  const swapPairs = [];     // [{ lessonA, lessonB }] (for swap action)

  for (const hint of aiHints) {
    if (hint.action === "move" && hint.targetDay && hint.targetStart) {
      for (const l of [...affected, ...unaffected]) {
        if (hint.lessonMatch && hint.lessonMatch(l)) {
          forcedMoves[l.id] = { day: hint.targetDay, start: hint.targetStart };
        }
      }
    }
    if (hint.action === "reschedule_day" && hint.targetDay) {
      for (const l of [...affected, ...unaffected]) {
        if (hint.lessonMatch && hint.lessonMatch(l)) {
          if (!forcedMoves[l.id]) forcedDays[l.id] = hint.targetDay;
        }
      }
    }
    // teacher_swap: assign a replacement teacher to matched lessons
    if (hint.action === "teacher_swap" && hint.replacementTeacherName) {
      const rName = hint.replacementTeacherName.toLowerCase();
      const replacement = teachers.find(t => {
        const tn = t.name.toLowerCase();
        return tn.includes(rName) || rName.includes(tn.split(" ")[0]);
      });
      if (replacement) {
        for (const l of [...affected, ...unaffected]) {
          if (hint.lessonMatch && hint.lessonMatch(l)) {
            forcedTeacher[l.id] = { teacherId: replacement.id, teacherName: replacement.name };
          }
        }
      }
    }
    // swap: collect two student names whose lesson times should be exchanged
    if (hint.action === "swap" && hint.targetStudentName && hint.swapWithStudentName) {
      const allLessons = [...affected, ...unaffected];
      const nameA = hint.targetStudentName.toLowerCase();
      const nameB = hint.swapWithStudentName.toLowerCase();
      const filterDay = hint.sourceDay || null;
      const lessonsA = allLessons.filter(l => {
        if (filterDay && l.day !== filterDay) return false;
        const sn = (l.studentName || "").toLowerCase();
        return sn.includes(nameA) || nameA.includes(sn.split(" ")[0]);
      });
      const lessonsB = allLessons.filter(l => {
        if (filterDay && l.day !== filterDay) return false;
        const sn = (l.studentName || "").toLowerCase();
        return sn.includes(nameB) || nameB.includes(sn.split(" ")[0]);
      });
      // Pair them up by index (handles multiple instruments)
      for (let i = 0; i < Math.min(lessonsA.length, lessonsB.length); i++) {
        swapPairs.push({ lessonA: lessonsA[i], lessonB: lessonsB[i] });
      }
    }
  }

  const placed = [];
  const missed = [];

  // Helper: check if a lesson is in a before/after school slot
  const isBeforeAfterLesson = (lesson) => {
    const slot = school.slots.find(s => s.id === lesson.slotId);
    return slot && (slot.type === "before_school" || slot.type === "after_school");
  };

  // Step 0: Place before/after school lessons FIRST — locked to exact master day+time
  // These only move if explicitly mentioned in AI adjustments
  const beforeAfterLessons = [];
  const regularUnaffected = [];
  for (const lesson of unaffected) {
    if (isBeforeAfterLesson(lesson) && !forcedMoves[lesson.id] && !forcedDays[lesson.id]) {
      beforeAfterLessons.push(lesson);
    } else {
      regularUnaffected.push(lesson);
    }
  }
  const beforeAfterAffected = [];
  const regularAffected = [];
  for (const lesson of affected) {
    if (isBeforeAfterLesson(lesson) && !forcedMoves[lesson.id] && !forcedDays[lesson.id]) {
      beforeAfterAffected.push(lesson);
    } else {
      regularAffected.push(lesson);
    }
  }

  // Lock before/after lessons to their exact time (unaffected ones)
  for (const lesson of beforeAfterLessons) {
    const baStudent = students.find(s => s.id === lesson.studentId);
    const baClassName = baStudent?.className || "";
    if (!isDayBlocked(lesson.day) && !isSlotBlocked(lesson.day, lesson.start, lesson.end, baClassName) && isTeacherFree(lesson.teacherId, lesson.day, lesson.start, lesson.end)) {
      placed.push({ ...lesson, weekDate: weekDateMap[lesson.day], adjusted: false , duringSpecialist: getSpecialistTag(lesson, lesson.day, lesson.start, lesson.end) });
      teacherSched[lesson.teacherId].push({ day: lesson.day, start: lesson.start, end: lesson.end });
    } else {
      // Day blocked, slot blocked, or teacher unavailable — missed, don't try to shift
      missed.push({ ...lesson, reason: "Before/after school slot unavailable this week" });
    }
  }

  // Before/after lessons that were affected by interruptions — try same time on other days, then miss
  for (const lesson of beforeAfterAffected) {
    const isCancelled = aiHints.some(h => h.action === "cancel" && h.lessonMatch && h.lessonMatch(lesson));
    if (isCancelled) { missed.push({ ...lesson, reason: "Cancelled by weekly adjustment" }); continue; }

    // Try same time slot on other available days (prioritize forcedDays target)
    let found = false;
    const baFd = forcedDays[lesson.id];
    const dayOrder = baFd
      ? [baFd, ...(school.days || DAYS).filter(d => d !== baFd)]
      : [lesson.day, ...(school.days || DAYS).filter(d => d !== lesson.day)];
    for (const day of dayOrder) {
      if (found) break;
      const isAiDirectedDay = baFd && day === baFd;
      if (!isAiDirectedDay && isDayBlocked(day)) continue;
      const studentObj = students.find(s => s.id === lesson.studentId);
      const className = studentObj?.className || "";
      if (!isAiDirectedDay && isSlotBlocked(day, lesson.start, lesson.end, className)) continue;
      const teacherOk = isAiDirectedDay ? isTeacherFreeOverride(lesson.teacherId, day, lesson.start) : isTeacherFree(lesson.teacherId, day, lesson.start, lesson.end);
      if (teacherOk) {
        const reason = baFd ? `Rescheduled to ${day}` : day === lesson.day ? null : `Moved to ${day} (interruption)`;
        placed.push({ ...lesson, day, weekDate: weekDateMap[day], adjusted: !!reason, adjustReason: reason || undefined, duringSpecialist: getSpecialistTag(lesson, day, lesson.start, lesson.end) });
        teacherSched[lesson.teacherId].push({ day, start: lesson.start, end: lesson.end });
        found = true;
      }
    }
    if (!found) {
      const intrTitle = weekInterruptions.find(intr => {
        const date = weekDateMap[lesson.day];
        return date && date >= intr.date && date <= (intr.endDate || intr.date);
      })?.title || "Interruption / no slot";
      missed.push({ ...lesson, reason: `No available slot — ${intrTitle}` });
    }
  }

  // Step 1: Place unaffected lessons (locked to their master day, may shift time)
  const sortedUnaffected = [...regularUnaffected].sort((a, b) => timeToMin(a.start) - timeToMin(b.start));
  for (const lesson of sortedUnaffected) {
    const fm = forcedMoves[lesson.id];
    if (fm) {
      const slot = school.slots.find(s => s.start === fm.start);
      if (slot && isTeacherFreeOverride(lesson.teacherId, fm.day, slot.start)) {
        placed.push({ ...lesson, day: fm.day, slotId: slot.id, start: slot.start, end: slot.end, weekDate: weekDateMap[fm.day], adjusted: true, adjustReason: "AI adjustment", duringSpecialist: getSpecialistTag(lesson, fm.day, slot.start, slot.end) });
        teacherSched[lesson.teacherId].push({ day: fm.day, start: slot.start, end: slot.end });
        continue;
      }
    }
    // Try master time — also check if slot is blocked for this student's class (e.g. swimming)
    const uStudentObj = students.find(s => s.id === lesson.studentId);
    const uClassName = uStudentObj?.className || "";
    const notAvailUntilOrig = getNotAvailUntil(lesson, lesson.day);
    if (!isDayBlocked(lesson.day) && !isSlotBlocked(lesson.day, lesson.start, lesson.end, uClassName) && isTeacherFree(lesson.teacherId, lesson.day, lesson.start, lesson.end) && notAvailUntilOrig <= timeToMin(lesson.start) && !isBlockedWindow(lesson, lesson.day, lesson.start, lesson.end)) {
      placed.push({ ...lesson, weekDate: weekDateMap[lesson.day], adjusted: false, duringSpecialist: getSpecialistTag(lesson, lesson.day, lesson.start, lesson.end) });
      teacherSched[lesson.teacherId].push({ day: lesson.day, start: lesson.start, end: lesson.end });
    } else if (!isDayBlocked(lesson.day)) {
      // Shift time on same day
      const className = uClassName;
      let found = false;
      const notAvailUntilSameDay = notAvailUntilOrig;
      for (const slot of school.slots) {
        if (slot.type !== "class" && !["recess", "lunch", "before_school", "after_school"].includes(slot.type)) continue;
        if (isSlotBlocked(lesson.day, slot.start, slot.end, className)) continue;
        if (!lesson.duringSpecialist && isSpecialistClash(className, lesson.day, slot.start, slot.end)) continue;
        if (!isTeacherFree(lesson.teacherId, lesson.day, slot.start, slot.end)) continue;
        if (notAvailUntilSameDay > timeToMin(slot.start)) continue;
        if (isBlockedWindow(lesson, lesson.day, slot.start, slot.end)) continue;
        placed.push({ ...lesson, slotId: slot.id, slotName: slot.name, start: slot.start, end: slot.end, weekDate: weekDateMap[lesson.day], adjusted: true, adjustReason: isSlotBlocked(lesson.day, lesson.start, lesson.end, className) ? "Time shifted (interruption)" : "Time shifted (teacher conflict)", duringSpecialist: getSpecialistTag(lesson, lesson.day, slot.start, slot.end) });
        teacherSched[lesson.teacherId].push({ day: lesson.day, start: slot.start, end: slot.end });
        found = true;
        break;
      }
      if (!found) regularAffected.push(lesson); // escalate to affected pool
    } else {
      regularAffected.push(lesson); // day blocked, treat as affected
    }
  }

  // Step 2: Place affected lessons (can move day + time, excludes before/after handled above)
  const sortedAffected = [...regularAffected].sort((a, b) => timeToMin(a.start) - timeToMin(b.start));
  for (const lesson of sortedAffected) {
    const isCancelled = aiHints.some(h => h.action === "cancel" && h.lessonMatch && h.lessonMatch(lesson));
    if (isCancelled) { missed.push({ ...lesson, reason: "Cancelled by weekly adjustment" }); continue; }

    const fm = forcedMoves[lesson.id];
    if (fm) {
      const slot = school.slots.find(s => s.start === fm.start);
      if (slot && isTeacherFreeOverride(lesson.teacherId, fm.day, slot.start)) {
        placed.push({ ...lesson, day: fm.day, slotId: slot.id, start: slot.start, end: slot.end, weekDate: weekDateMap[fm.day], adjusted: true, adjustReason: "AI adjustment", duringSpecialist: getSpecialistTag(lesson, fm.day, slot.start, slot.end) });
        teacherSched[lesson.teacherId].push({ day: fm.day, start: slot.start, end: slot.end });
        continue;
      }
    }

    // teacher_swap: re-place lesson at same time with replacement teacher
    if (forcedTeacher[lesson.id]) {
      const { teacherId: rTeacherId, teacherName: rTeacherName } = forcedTeacher[lesson.id];
      placed.push({ ...lesson, teacherId: rTeacherId, teacherName: rTeacherName, weekDate: weekDateMap[lesson.day], adjusted: true, adjustReason: `Teacher: ${rTeacherName}` });
      if (!teacherSched[rTeacherId]) teacherSched[rTeacherId] = [];
      teacherSched[rTeacherId].push({ day: lesson.day, start: lesson.start, end: lesson.end });
      continue;
    }

    // move_later: find the latest available slot AFTER current start on the same day
    const moveLaterHint = aiHints.find(h => h.action === "move_later" && h.lessonMatch && h.lessonMatch(lesson));
    if (moveLaterHint) {
      const origStart = timeToMin(lesson.start);
      const student3 = students.find(s => s.id === lesson.studentId);
      const className3 = student3?.className || "";
      let foundLater = false;
      const slotsDesc = [...school.slots]
        .filter(s => ["class", "recess", "lunch", "before_school", "after_school"].includes(s.type))
        .sort((a, b) => timeToMin(b.start) - timeToMin(a.start)); // descending — latest first? No, we want earliest-after. Sort asc then scan past origStart.
      const slotsAfter = [...school.slots]
        .filter(s => ["class", "recess", "lunch", "before_school", "after_school"].includes(s.type))
        .sort((a, b) => timeToMin(a.start) - timeToMin(b.start))
        .filter(s => timeToMin(s.start) > origStart);
      for (const slot of slotsAfter) {
        if (isSlotBlocked(lesson.day, slot.start, slot.end, className3)) continue;
        if (!lesson.duringSpecialist && isSpecialistClash(className3, lesson.day, slot.start, slot.end)) continue;
        if (!isTeacherFree(lesson.teacherId, lesson.day, slot.start, slot.end)) continue;
        if (isBlockedWindow(lesson, lesson.day, slot.start, slot.end)) continue;
        placed.push({ ...lesson, slotId: slot.id, slotName: slot.name, start: slot.start, end: slot.end, weekDate: weekDateMap[lesson.day], adjusted: true, adjustReason: "Moved later (AI)", duringSpecialist: getSpecialistTag(lesson, lesson.day, slot.start, slot.end) });
        teacherSched[lesson.teacherId].push({ day: lesson.day, start: slot.start, end: slot.end });
        foundLater = true;
        break;
      }
      if (foundLater) continue;
      // No later slot — keep at original time if possible
      if (!isDayBlocked(lesson.day) && isTeacherFree(lesson.teacherId, lesson.day, lesson.start, lesson.end)) {
        placed.push({ ...lesson, weekDate: weekDateMap[lesson.day], adjusted: false, duringSpecialist: getSpecialistTag(lesson, lesson.day, lesson.start, lesson.end) });
        teacherSched[lesson.teacherId].push({ day: lesson.day, start: lesson.start, end: lesson.end });
      } else {
        missed.push({ ...lesson, reason: "No later slot available" });
      }
      continue;
    }

    // move_earlier: find the earliest available slot before current start on the same day
    const moveEarlierHint = aiHints.find(h => (h.action === "move_earlier" || (h.action === "move" && !h.targetStart)) && h.lessonMatch && h.lessonMatch(lesson));
    if (moveEarlierHint) {
      const origStart = timeToMin(lesson.start);
      const student2 = students.find(s => s.id === lesson.studentId);
      const className2 = student2?.className || "";
      let foundEarlier = false;
      const slotsAsc = [...school.slots]
        .filter(s => ["class", "recess", "lunch", "before_school", "after_school"].includes(s.type))
        .sort((a, b) => timeToMin(a.start) - timeToMin(b.start));
      for (const slot of slotsAsc) {
        if (timeToMin(slot.start) >= origStart) break;
        if (isSlotBlocked(lesson.day, slot.start, slot.end, className2)) continue;
        if (!lesson.duringSpecialist && isSpecialistClash(className2, lesson.day, slot.start, slot.end)) continue;
        if (!isTeacherFree(lesson.teacherId, lesson.day, slot.start, slot.end)) continue;
        if (getNotAvailUntil(lesson, lesson.day) > timeToMin(slot.start)) continue;
        if (isBlockedWindow(lesson, lesson.day, slot.start, slot.end)) continue;
        placed.push({ ...lesson, slotId: slot.id, slotName: slot.name, start: slot.start, end: slot.end, weekDate: weekDateMap[lesson.day], adjusted: true, adjustReason: "Moved earlier (AI)", duringSpecialist: getSpecialistTag(lesson, lesson.day, slot.start, slot.end) });
        teacherSched[lesson.teacherId].push({ day: lesson.day, start: slot.start, end: slot.end });
        foundEarlier = true;
        break;
      }
      if (foundEarlier) continue;
      // No earlier slot — keep at original time if still possible
      if (!isDayBlocked(lesson.day) && isTeacherFree(lesson.teacherId, lesson.day, lesson.start, lesson.end)) {
        placed.push({ ...lesson, weekDate: weekDateMap[lesson.day], adjusted: false, duringSpecialist: getSpecialistTag(lesson, lesson.day, lesson.start, lesson.end) });
        teacherSched[lesson.teacherId].push({ day: lesson.day, start: lesson.start, end: lesson.end });
      } else {
        missed.push({ ...lesson, reason: "No earlier slot available" });
      }
      continue;
    }

    const studentObj = students.find(s => s.id === lesson.studentId);
    const className = studentObj?.className || "";
    let found = false;
    // If reschedule_day hint exists, try that day first
    const fd = forcedDays[lesson.id];
    const dayOrder = fd
      ? [fd, ...(school.days || DAYS).filter(d => d !== fd)]
      : [lesson.day, ...(school.days || DAYS).filter(d => d !== lesson.day)];
    for (const day of dayOrder) {
      if (found) break;
      const isAiDirectedDay = fd && day === fd;
      // AI-directed days skip day-blocked and teacher availability checks
      if (!isAiDirectedDay && isDayBlocked(day)) continue;
      for (const slot of school.slots) {
        if (slot.type !== "class" && !["recess", "lunch", "before_school", "after_school"].includes(slot.type)) continue;
        if (!isAiDirectedDay && isSlotBlocked(day, slot.start, slot.end, className)) continue;
        if (!isAiDirectedDay && !lesson.duringSpecialist && isSpecialistClash(className, day, slot.start, slot.end)) continue;
        // AI-directed: only prevent double-booking. Normal: full availability check.
        if (isAiDirectedDay ? !isTeacherFreeOverride(lesson.teacherId, day, slot.start) : !isTeacherFree(lesson.teacherId, day, slot.start, slot.end)) continue;
        if (getNotAvailUntil(lesson, day) > timeToMin(slot.start)) continue;
        if (isBlockedWindow(lesson, day, slot.start, slot.end)) continue;
        const reason = fd ? `Rescheduled to ${day}` : day === lesson.day ? "Time changed (interruption)" : `Moved to ${day} (interruption)`;
        placed.push({ ...lesson, day, slotId: slot.id, slotName: slot.name, start: slot.start, end: slot.end, weekDate: weekDateMap[day], adjusted: true, adjustReason: reason , duringSpecialist: getSpecialistTag(lesson, day, slot.start, slot.end) });
        teacherSched[lesson.teacherId].push({ day, start: slot.start, end: slot.end });
        found = true;
        break;
      }
    }
    if (!found) {
      const intrTitle = weekInterruptions.find(intr => {
        const date = weekDateMap[lesson.day];
        return date && date >= intr.date && date <= (intr.endDate || intr.date);
      })?.title || "Interruption / no slot";
      missed.push({ ...lesson, reason: `No available slot — ${intrTitle}` });
    }
  }

  // Swap pairs: exchange start times between paired lessons that were placed
  for (const { lessonA, lessonB } of swapPairs) {
    const idxA = placed.findIndex(l => l.id === lessonA.id);
    const idxB = placed.findIndex(l => l.id === lessonB.id);
    if (idxA !== -1 && idxB !== -1) {
      const pA = placed[idxA];
      const pB = placed[idxB];
      // Exchange day, slotId, slotName, start, end, weekDate
      placed[idxA] = { ...pA, day: pB.day, slotId: pB.slotId, slotName: pB.slotName, start: pB.start, end: pB.end, weekDate: pB.weekDate, adjusted: true, adjustReason: `Swapped with ${pB.studentName}` };
      placed[idxB] = { ...pB, day: pA.day, slotId: pA.slotId, slotName: pA.slotName, start: pA.start, end: pA.end, weekDate: pA.weekDate, adjusted: true, adjustReason: `Swapped with ${pA.studentName}` };
    }
  }

  return { lessons: placed, missed };
}

// Loose class name matching for interruptions - handles "3A" vs "Year 3A" vs "3/4A" etc.
function classMatchesInterruption(studentClassName, affectedClassesStr) {
  if (affectedClassesStr === "all") return true;
  const affected = affectedClassesStr.split(",").map(c => c.trim().toLowerCase());
  const cn = studentClassName.toLowerCase();
  return affected.some(ac => cn.includes(ac) || ac.includes(cn) || cn.replace(/[^a-z0-9]/g, "").includes(ac.replace(/[^a-z0-9]/g, "")) || ac.replace(/[^a-z0-9]/g, "").includes(cn.replace(/[^a-z0-9]/g, "")));
}

// ============================================================
// WEEKLY ADJUSTMENTS TAB
// ============================================================
// ─── Shared AI prompt builder for Weekly Adjustments ───────────
function buildWeeklyAIPrompt({ school, weekLabel, weekDates, todayDay, todayDate, classNames, teacherList, groupList, studentList, adjustmentNotes, targetDay }) {
  const regenLine = targetDay ? ("\nRegenerating: " + targetDay + " only") : "";
  return "Parse these weekly timetable adjustment notes for a music lesson schedule.\n\nSchool: " + school.name + "\nWeek: " + weekLabel + " (" + weekDates[0].date + " to " + weekDates[4].date + ")\nToday is: " + todayDay + " " + todayDate + regenLine + "\nClasses at this school: " + classNames + "\nTeachers at this school: " + teacherList + "\nGroups at this school:\n" + groupList + "\nStudents:\n" + studentList + "\n\nDays: Monday\u2013Friday\nSchool hours: typically 8:30am\u20133:30pm\n\nAdjustment notes:\n\"" + adjustmentNotes + "\"\n\nFor each adjustment, extract:\n- action: \"cancel\" | \"move\" (specific time) | \"move_earlier\" | \"move_later\" | \"reschedule_day\" | \"teacher_swap\" | \"swap\" (exchange two students\' times) | \"free_specialist\" | \"blocked_window\" | \"note\" | \"tally_remove\"\n- targetStudentName: student name if specific student mentioned (null otherwise)\n- targetClassName: class name if whole class mentioned (null otherwise)\n- targetTeacherName: teacher name if a teacher is mentioned (null otherwise). IMPORTANT: Check the Teachers list \u2014 if a first name matches a teacher, set this field, not targetStudentName.\n- sourceDay: the ORIGINAL day whose lessons are affected. e.g. \"was sick on Wednesday\" \u2192 sourceDay: \"Wednesday\". If no specific day is mentioned and this is a general unavailability, set sourceDay to null.\n- targetDay: the day to reschedule TO. e.g. \"take those lessons on Friday\" \u2192 targetDay: \"Friday\"\n- targetStart: time in HH:MM 24h format (for \"move\" actions with specific time only, null otherwise)\n- notAvailableUntil: if student/teacher is unavailable until a specific time, set this to that time in HH:MM 24h format\n- blockedWindowStart/blockedWindowEnd: HH:MM 24h times for a specific window to block (e.g. recess period)\n- targetSubject: specialist subject name (for free_specialist action only)\n- targetPeriod: \"morning\" or \"afternoon\" (for free_specialist when no specific time given)\n- makeupEligible: false if user says \"no catch up\", \"no makeup\", \"write it off\", \"don\'t reschedule\" \u2014 otherwise omit\n- targetInstrument: instrument name if a specific instrument is mentioned (null otherwise)\n- targetGroupName: group lesson name if a group is referenced (null otherwise)\n- replacementTeacherName: for teacher_swap \u2014 the name of the teacher TAKING OVER the lessons\n- swapWithStudentName: for swap \u2014 the name of the SECOND student whose time slot is being exchanged\n- wholeSchool: true for cancel actions that affect all lessons (e.g. \"no lessons today\", \"school photo day\", \"whole school assembly\") \u2014 null otherwise\n- tallyRemoveReason: for tally_remove only \u2014 \"removed_not_charged\" or \"extended_absence\". Use \"removed_not_charged\" for cancellations and lessons that simply aren\'t happening; \"extended_absence\" when fees are still being charged and a place is held.\n- recurringNote: true if the user uses words like \"always\", \"every week\", \"permanently\", \"from now on\" \u2014 null otherwise\n- noteText: if recurringNote is true, a clean concise version of the constraint to save \u2014 null otherwise\n- reason: short description\n\nRules:\n- Convert 12h times to 24h. Times like 1:10, 2:00 mean PM (13:10, 14:00).\n- \"not at school until X\", \"arrives at X\", \"late arrival until X\" \u2192 action: \"note\", notAvailableUntil: X (24h)\n- CRITICAL: If someone \"was sick/away on [DayA]\" and \"will take/do those lessons on [DayB]\", this is reschedule_day with sourceDay=[DayA] and targetDay=[DayB].\n- \"[Teacher] away [Day]\" without a replacement day = cancel with sourceDay set\n- \"[Student] away\", \"no lesson for [Student]\", \"[Student] absent\" = cancel (makeupEligible: true unless specified)\n- \"cancel [Student] no catch up\" = cancel with makeupEligible: false\n- \"Move [Student] to Thursday 10:00\" = move with targetDay and targetStart\n- \"[Subject] cancelled/not on/free [period/time]\" \u2192 action: \"free_specialist\", targetSubject: subject name, targetPeriod: \"morning\" or \"afternoon\" if mentioned\n- \"[Student] can\'t do recess\" \u2192 action: \"blocked_window\", blockedWindowStart/End: recess window times\n- Whole-school events (photo day, assembly, camp) \u2192 action: \"cancel\", wholeSchool: true\n- \"[Student] always [constraint]\" \u2192 set recurringNote: true, noteText: concise description\n- \"Remove [student] from tally\", \"[student] extended absence\", \"not charging this week\", \"no tally this week\" \u2192 action: \"tally_remove\", targetStudentName: student name (or null for whole school), tallyRemoveReason as above\n- \"No lessons this week\" (whole school) \u2192 action: \"tally_remove\", wholeSchool: true, tallyRemoveReason: \"removed_not_charged\"\n\nRespond ONLY with a JSON array. No other text.";
}

function printMasterTimetable(timetable, schools, students, teachers) {
  if (!timetable || !timetable.lessons || timetable.lessons.length === 0) return;
  const DAYS_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const timeToMin = t => { const [h, m] = (t || "0:0").split(":").map(Number); return h * 60 + m; };
  const inst_colors = {
    Piano: "#ffb3ff", Guitar: "#8cc183", Violin: "#C47A6A", Viola: "#B07CD4",
    Cello: "#D45B5B", Flute: "#5BBDD4", Clarinet: "#D4C65B", Saxophone: "#D48B5B",
    Trumpet: "#C4A05B", Drums: "#ae85ad", Voice: "#6B9FD4", Ukulele: "#ebc382",
    Group: "#9E6B8A", default: "#888"
  };
  const getColor = (inst, isGroup) => isGroup ? inst_colors.Group : (inst_colors[inst] || inst_colors.default);

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Master Timetable</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 11px; color: #1f2937; background: #fff; padding: 10mm; }
  @page { size: landscape; margin: 8mm 10mm; }
  @media print { body { padding: 0; } .no-print { display: none; } }
  h1 { font-size: 18px; color: #344565; margin-bottom: 12px; }
  h2 { font-size: 13px; color: #C47A6A; margin: 16px 0 6px; border-bottom: 2px solid #C47A6A; padding-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  th { background: #f3f4f6; font-weight: 700; font-size: 10px; padding: 5px 8px; text-align: center; border: 1px solid #e5e7eb; color: #374151; }
  th.time-col { width: 52px; text-align: left; }
  td { padding: 3px 4px; border: 1px solid #f3f4f6; vertical-align: top; min-width: 100px; }
  td.time-cell { font-size: 10px; color: #9ca3af; padding: 4px 6px; white-space: nowrap; }
  .lesson-card { border-radius: 4px; padding: 4px 6px; margin-bottom: 2px; border-left: 3px solid #ccc; }
  .lesson-name { font-weight: 700; font-size: 11px; }
  .lesson-detail { font-size: 10px; color: #374151; margin-top: 1px; }
  .print-btn { position: fixed; bottom: 16px; right: 16px; padding: 10px 20px; background: #344565; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-family: inherit; z-index: 999; }
</style></head><body>
<button class="no-print print-btn" onclick="window.print()">🖨 Print / Save PDF</button>
<h1>Master Timetable</h1>`;

  for (const school of schools) {
    const schoolLessons = timetable.lessons.filter(l => l.schoolId === school.id);
    if (schoolLessons.length === 0) continue;
    const allTimes = [...new Set(schoolLessons.map(l => l.start))].sort((a, b) => timeToMin(a) - timeToMin(b));
    html += `<h2>${school.name}</h2><table><thead><tr><th class="time-col">Time</th>`;
    for (const d of DAYS_ORDER) html += `<th>${d}</th>`;
    html += `</tr></thead><tbody>`;
    for (const time of allTimes) {
      html += `<tr><td class="time-cell">${time}</td>`;
      for (const d of DAYS_ORDER) {
        const cell = schoolLessons.filter(l => l.start === time && l.day === d);
        html += `<td>`;
        for (const l of cell) {
          const col = getColor(l.instrument, l.isGroup);
          html += `<div class="lesson-card" style="background:${col}22;border-left-color:${col}">
            <div class="lesson-name">${l.studentName || ""}</div>
            <div class="lesson-detail">${l.instrument || ""}${l.teacherName ? " · " + l.teacherName : ""}</div>
          </div>`;
        }
        html += `</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `</body></html>`;
  const w = window.open("", "_blank");
  if (w) { w.document.write(html); w.document.close(); }
}

function printWeeklyTimetable(weeklyTimetables, schools, students, weekDates, weekLabel) {
  const DAYS_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const timeToMin = t => { const [h, m] = (t || "0:0").split(":").map(Number); return h * 60 + m; };
  const inst_colors = {
    Piano: "#ffb3ff", Guitar: "#8cc183", Violin: "#C47A6A", Viola: "#B07CD4",
    Cello: "#D45B5B", Flute: "#5BBDD4", Clarinet: "#D4C65B", Saxophone: "#D48B5B",
    Trumpet: "#C4A05B", Drums: "#ae85ad", Voice: "#6B9FD4", Ukulele: "#ebc382",
    Group: "#9E6B8A", default: "#888"
  };
  const getColor = (inst, isGroup) => isGroup ? inst_colors.Group : (inst_colors[inst] || inst_colors.default);

  // Collect all lessons across all schools for this week
  const weekKey = weekDates[0].date;
  const allSchoolData = schools.map(s => {
    const entry = weeklyTimetables[`${weekKey}|${s.id}`];
    if (!entry) return null;
    return { school: s, lessons: entry.lessons || [], missed: entry.missed || [] };
  }).filter(Boolean);

  if (allSchoolData.length === 0) return;

  // Build all time slots across all schools
  const allTimes = new Set();
  for (const { lessons } of allSchoolData) {
    for (const l of lessons) if (l.start) allTimes.add(l.start);
  }
  const sortedTimes = [...allTimes].sort((a, b) => timeToMin(a) - timeToMin(b));

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Weekly Timetable — ${weekLabel}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 11px; color: #1f2937; background: #fff; padding: 10mm; }
  @page { size: landscape; margin: 8mm 10mm; }
  @media print { body { padding: 0; } .no-print { display: none; } }
  h1 { font-size: 18px; color: #344565; margin-bottom: 2px; }
  h2 { font-size: 13px; color: #C47A6A; margin: 14px 0 6px; border-bottom: 2px solid #C47A6A; padding-bottom: 3px; }
  .week-label { font-size: 12px; color: #6b7280; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  th { background: #f3f4f6; font-weight: 700; font-size: 10px; padding: 5px 8px; text-align: center; border: 1px solid #e5e7eb; color: #374151; }
  th.time-col { width: 52px; text-align: left; }
  td { padding: 3px 4px; border: 1px solid #f3f4f6; vertical-align: top; min-width: 100px; }
  td.time-cell { font-size: 10px; color: #9ca3af; padding: 4px 6px; white-space: nowrap; }
  .lesson-card { border-radius: 4px; padding: 4px 6px; margin-bottom: 2px; border-left: 3px solid #ccc; }
  .lesson-name { font-weight: 700; font-size: 11px; }
  .lesson-detail { font-size: 10px; color: #4b5563; }
  .lesson-teacher { font-size: 10px; color: #6b7280; }
  .adjusted { border-left-color: #D97706 !important; }
  .makeup { border-left-color: #2563EB !important; }
  .missed-section { margin-top: 8px; }
  .missed-chip { display: inline-block; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; padding: 2px 7px; font-size: 10px; color: #dc2626; margin: 2px; }
  .print-btn { position: fixed; bottom: 16px; right: 16px; padding: 10px 20px; background: #344565; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-family: inherit; z-index: 999; }
  .stats { display: flex; gap: 16px; margin-bottom: 14px; font-size: 11px; }
  .stat { background: #f9fafb; border-radius: 6px; padding: 5px 12px; }
  .stat strong { font-size: 14px; display: block; }
</style></head><body>
<h1>Weekly Timetable</h1>
<div class="week-label">${weekLabel} &nbsp;·&nbsp; ${weekDates.map(wd => `${wd.day.slice(0,3)} ${wd.date}`).join(" &nbsp; ")}</div>
<button class="no-print print-btn" onclick="window.print()">🖨 Print / Save PDF</button>
`;

  for (const { school, lessons, missed } of allSchoolData) {
    const totalLessons = lessons.length;
    const adjustedCount = lessons.filter(l => l.adjusted && !l.isMakeup).length;
    const makeupCount = lessons.filter(l => l.isMakeup).length;
    const missedCount = missed.length;

    html += `<h2>${school.name}</h2>
<div class="stats">
  <div class="stat"><strong>${totalLessons}</strong>Lessons</div>
  <div class="stat"><strong style="color:#D97706">${adjustedCount}</strong>Adjusted</div>
  <div class="stat"><strong style="color:#2563EB">${makeupCount}</strong>Makeups</div>
  <div class="stat"><strong style="color:#DC2626">${missedCount}</strong>Cancelled</div>
</div>`;

    // Build grid indexed by [day][time]
    const grid = {};
    for (const day of DAYS_ORDER) { grid[day] = {}; }
    for (const l of lessons) {
      if (!grid[l.day]) continue;
      if (!grid[l.day][l.start]) grid[l.day][l.start] = [];
      grid[l.day][l.start].push(l);
    }

    // Collect times used by this school
    const schoolTimes = new Set(lessons.map(l => l.start));
    const schoolSortedTimes = [...schoolTimes].sort((a, b) => timeToMin(a) - timeToMin(b));

    if (schoolSortedTimes.length === 0) continue;

    html += `<table><thead><tr><th class="time-col">Time</th>`;
    for (const day of DAYS_ORDER) {
      const wd = weekDates.find(w => w.day === day);
      html += `<th>${day.slice(0,3)}<br><span style="font-weight:400;color:#6b7280">${wd ? wd.date : ""}</span></th>`;
    }
    html += `</tr></thead><tbody>`;

    for (const time of schoolSortedTimes) {
      html += `<tr><td class="time-cell">${time}</td>`;
      for (const day of DAYS_ORDER) {
        const cellLessons = grid[day][time] || [];
        html += `<td>`;
        for (const l of cellLessons) {
          const col = getColor(l.instrument, l.isGroup);
          const cls = l.isMakeup ? "lesson-card makeup" : l.adjusted ? "lesson-card adjusted" : "lesson-card";
          const student = l.isGroup ? (l.groupName || "Group") : l.studentName;
          const stObj = students.find(s => s.id === l.studentId);
          const classLabel = stObj?.className ? ` · ${stObj.className}` : "";
          html += `<div class="${cls}" style="background:${col}18;border-left-color:${col}">
            <div class="lesson-name">${l.isMakeup ? "↺ " : ""}${student}${classLabel}</div>
            <div class="lesson-detail">${l.instrument || ""}${l.adjustReason && l.adjusted ? ` <span style="color:#D97706">· ${l.adjustReason}</span>` : ""}</div>
            <div class="lesson-teacher">${l.teacherName ? l.teacherName.split(" ")[0] : ""}</div>
          </div>`;
        }
        html += `</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;

    // Missed/cancelled
    if (missed.length > 0) {
      html += `<div class="missed-section"><strong style="font-size:11px;color:#6b7280">Cancelled/Missed:</strong><br>`;
      for (const m of missed) {
        html += `<span class="missed-chip">${m.studentName} (${m.instrument}) ${m.day}${m.reason ? " — " + m.reason : ""}</span>`;
      }
      html += `</div>`;
    }
  }

  html += `</body></html>`;
  const win = window.open("", "_blank");
  if (win) { win.document.write(html); win.document.close(); }
}

function WeeklyAdjustments({ timetable, schools, students, setStudents, teachers, setTeachers, specialists, interruptions, groups, weeklyTimetables, setWeeklyTimetables, tallyEntries, setTallyEntries, masterBreaks, notify, logError, viewState, setViewState, sharedSchool, setSharedSchool, onViewStudent, onViewGroup, onExport, onUndo, onRedo, undoCount, redoCount, onWarningsChange, goBack, goForward, historyCursor, pageHistory }) {
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
  const [confirmRegenerateWeek, setConfirmRegenerateWeek] = useState(false); // [{studentId, studentName, noteText}]
  const [showInterruptions, setShowInterruptions] = useState(false);
  const [editUnlocked, setEditUnlocked] = useState(false);
  const gridScrollRef = useRef(null);
  const savedGridScroll = useRef({});
  savedGridScroll.current = viewState.gridScroll || {};
  // Callback ref — fires when grid mounts (including when selectedSchool changes)
  const gridRefCb = React.useCallback((el) => {
    gridScrollRef.current = el;
    if (el) {
      const s = savedGridScroll.current[selectedSchool] || { top: 0, left: 0 };
      el.scrollTop = s.top; el.scrollLeft = s.left;
    }
  }, [selectedSchool, weekOffset]);
  const handleGridScroll = () => {
    const el = gridScrollRef.current;
    if (el) setViewState(prev => ({ ...prev, gridScroll: { ...(prev.gridScroll || {}), [selectedSchool]: { top: el.scrollTop, left: el.scrollLeft } } }));
  };
  const [dragOver, setDragOver] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
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
  const [addLessonSubmenu, setAddLessonSubmenu] = useState(null); // { type, y } or null
  const contextMenuRef = React.useRef(null);
  const subMenuRef = React.useRef(null);
  const menuCloseTimer = React.useRef(null);
  useEffect(() => {
    if (!contextMenu) return;
    const check = (e) => {
      const mx = e.clientX, my = e.clientY;
      const inMain = contextMenuRef.current && (() => { const r = contextMenuRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      const inSub = subMenuRef.current && (() => { const r = subMenuRef.current.getBoundingClientRect(); return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom; })();
      if (inMain || inSub) {
        if (menuCloseTimer.current) { clearTimeout(menuCloseTimer.current); menuCloseTimer.current = null; }
      } else {
        if (!menuCloseTimer.current) {
          menuCloseTimer.current = setTimeout(() => { setContextMenu(null); setAddLessonSubmenu(null); menuCloseTimer.current = null; }, 250);
        }
      }
    };
    window.addEventListener("mousemove", check);
    return () => { window.removeEventListener("mousemove", check); if (menuCloseTimer.current) clearTimeout(menuCloseTimer.current); };
  }, [contextMenu]);

  const [hoverNotes, setHoverNotes] = useState(false);
  // Tally prompt — shown when a lesson is manually dragged to missed area
  const [tallyPrompt, setTallyPrompt] = useState(null); // { lesson, missedEntry, weekKey, weekNum }
  const [tallyPromptNotes, setTallyPromptNotes] = useState("");
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
    if (lesson.isGroup) return false;
    const student = students.find(s => s.id === lesson.studentId);
    if (!student) return false;
    const key = `${lesson.schoolId}|${student.className}|${lesson.day}`;
    const specs = specLookupRef[key] || [];
    const sStart = timeToMin(lesson.start), sEnd = timeToMin(lesson.end);
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
    const teacher = teachers.find(t => t.id === lesson.teacherId);
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
      if (match) warnings.push(student.className + " has " + (match.subject || "specialist") + " at this time");
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
    const result = generateWeeklyTimetable(
      timetable.lessons, currentSchool, students, teachers, specialists, interruptions, weekDates, aiHints, schoolMasterBreaks2
    );

    setWeeklyTimetables(prev => ({
      ...prev,
      [storageKey]: { lessons: result.lessons, missed: result.missed, notes: adjustmentNotes, generatedAt: new Date().toISOString() }
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
      const result = generateWeeklyTimetable(
        timetable.lessons, school, students, teachers, specialists, interruptions, weekDates, [], schoolBreaks
      );
      const sk = weekDates[0].date + "|" + school.id;
      setWeeklyTimetables(prev => ({
        ...prev,
        [sk]: { lessons: result.lessons, missed: result.missed, generatedAt: new Date().toISOString() }
      }));
    }
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
    const result = generateWeeklyTimetable(
      timetable.lessons, currentSchool, students, teachers, specialists, interruptions, weekDates, aiHints, schoolMasterBreaks3
    );

    // Get existing weekly data (if any)
    const existing = weeklyTimetables[storageKey];

    // Keep existing lessons for other days, use new results only for target day
    const otherDayLessons = existing ? existing.lessons.filter(l => l.day !== targetDay) : [];
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
    // If it's a catch-up card, revert the linked tally entry
    const lesson = weeklyData?.lessons.find(l => l.id === lessonId);
    if (lesson?.isMakeup && lesson.makeupForTallyId) {
      setTallyEntries(prev => prev.map(e => e.id !== lesson.makeupForTallyId ? e : { ...e, madeUp: false, madeUpWeekKey: undefined }));
    }
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
    // Open tally prompt for manual drops
    setTallyPromptNotes("");
    setTallyPrompt({ lesson, missedEntry, weekKey, weekNum: termWeek });
  };


  const showHoverPanel = (x, y, warnings, specs) => {
    const el = hoverPanelRef.current;
    if (!el) return;
    if (!warnings.length && !specs.length) { el.style.display = "none"; return; }
    let html = "";
    if (specs.length > 0) html += '<div style="color:#7C3AED;font-weight:600;margin-bottom:' + (warnings.length ? "4px" : "0") + '">' + specs.join(", ") + "</div>";
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
            duringSpecialist: getSpecialistForSlot(l, newDay, slot)
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
    // Remove tally entry for this lesson+week if it exists (lesson is back in schedule)
    const lessonKey = missed.isGroup ? `group|${missed.groupId}` : `${missed.studentId}|${missed.instrument}`;
    setTallyEntries(prev => prev.filter(e => !(e.lessonKey === lessonKey && e.weekKey === weekKey)));
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
    // Mark tally entry as madeUp now that it's placed
    if (staged.makeupForTallyId) {
      setTallyEntries(prev => prev.map(e => e.id !== staged.makeupForTallyId ? e : { ...e, madeUp: true, madeUpWeekKey: storageKey }));
    }
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
    <div onClick={() => { if (contextMenu) { setContextMenu(null); setHoverNotes(false); } if (expandedWarnings.size > 0) setExpandedWarnings(new Set()); }}>

      {/* Tally prompt — shown when lesson is manually dragged to missed area */}
      {tallyPrompt && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setTallyPrompt(null)}>
          <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: 340, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 4 }}>
              {tallyPrompt.lesson.isGroup ? (tallyPrompt.lesson.groupName || "Group") : tallyPrompt.lesson.studentName}
            </div>
            <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 18 }}>
              {tallyPrompt.lesson.instrument} · {tallyPrompt.lesson.day} · {weekLabel}
            </div>
            <div style={{ marginBottom: 14 }}>
              <textarea value={tallyPromptNotes} onChange={e => setTallyPromptNotes(e.target.value)}
                placeholder="Notes (optional)…"
                style={{ width: "100%", padding: "8px 10px", border: "1px solid #D1D5DB", borderRadius: 7, fontSize: 13, fontFamily: "inherit", resize: "vertical", minHeight: 52, boxSizing: "border-box", color: "#374151" }} />
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Why was this lesson missed?</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {TALLY_REASONS.map(r => {
                const makeupElig = r.makeupEligible === null ? true : (r.makeupEligible || false);
                const lesson = tallyPrompt.lesson;
                return (
                  <button key={r.value} onClick={() => {
                    const lKey = lesson.isGroup ? `group|${lesson.groupId}` : `${lesson.studentId}|${lesson.instrument}`;
                    const entry = {
                      id: uid(),
                      lessonKey: lKey, lessonId: lesson.id,
                      isGroup: lesson.isGroup || false, groupName: lesson.groupName || "",
                      studentId: lesson.studentId || "",
                      studentName: lesson.isGroup ? (lesson.groupName || lesson.studentNames?.join(", ") || "Group") : lesson.studentName,
                      studentNames: lesson.studentNames || [],
                      instrument: lesson.instrument, schoolId: lesson.schoolId,
                      teacherId: lesson.teacherId, teacherName: lesson.teacherName,
                      weekKey: tallyPrompt.weekKey, weekLabel, weekNum: tallyPrompt.weekNum,
                      termKey: null, day: lesson.day,
                      status: "missed", reason: r.value,
                      notes: tallyPromptNotes.trim(),
                      makeupEligible: makeupElig, madeUp: false,
                      recordedAt: new Date().toISOString(),
                    };
                    setTallyEntries(prev => [...prev.filter(e => !(e.lessonKey === lKey && e.weekKey === tallyPrompt.weekKey)), entry]);
                    setTallyPrompt(null);
                    notify(`Missed lesson recorded: ${r.label}`);
                  }}
                    style={{ padding: "9px 12px", borderRadius: 7, border: "1.5px solid #E5E7EB", background: "#fff", color: "#374151", fontWeight: 400, fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#F5F3FF"}
                    onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
                    {r.label}
                    {r.makeupEligible === true && <span style={{ fontSize: 11, color: "#D97706", fontWeight: 600 }}>● makeup owed</span>}
                    {r.makeupEligible === false && <span style={{ fontSize: 11, color: "#9CA3AF" }}>no makeup</span>}
                  </button>
                );
              })}
            </div>
            <button onClick={() => setTallyPrompt(null)} style={{ width: "100%", padding: "9px 0", borderRadius: 8, background: "#F3F4F6", color: "#374151", fontWeight: 600, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
              Skip (record reason later)
            </button>
          </div>
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <div ref={contextMenuRef} style={{ position: "fixed", ...((contextMenu.fromMissed || contextMenu.isCatchupStage) ? { bottom: window.innerHeight - contextMenu.y + 4, top: "auto" } : (contextMenu.y + 160 > window.innerHeight ? { bottom: window.innerHeight - contextMenu.y + 4, top: "auto" } : { top: contextMenu.y })), left: clampMenuPos(contextMenu.x, contextMenu.y, 200, 0).left, zIndex: 9999, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 160 }}
          onClick={e => e.stopPropagation()}
>
          {contextMenu.isCatchupStage ? (
            <div style={{ padding: "6px 4px" }}>
              <div style={{ padding: "6px 10px", fontSize: 11, color: colors.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Add catch-up to staging
              </div>
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
                if (!hasCatchup && !hasTrial) return null;
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
                  setContextMenu(null); setAddLessonSubmenu(null);
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
                // Sub-panel component helper
                const SubPanel = ({ type, color, bgHover, title, children }) => addLessonSubmenu && addLessonSubmenu.type === type ? (
                  <div ref={subMenuRef} style={{ position: "fixed", ...clampMenuPos(subX, addLessonSubmenu.y, subMenuW, 280), zIndex: 10001, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: subMenuW, maxHeight: 280, overflowY: "auto" }}>
                    <div style={{ padding: "6px 12px", fontSize: 11, color: color, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${colors.borderLight}` }}>{title}</div>
                    {children}
                  </div>
                ) : null;
                return (
                  <div style={{ position: "relative" }}>

                    <SubPanel type="catchup" color="#7C3AED" bgHover="#F5F3FF" title="Add catch-up">
                      {[...schoolStudentsWithMakeup].sort((a, b) => { const cDiff = makeupCount(b) - makeupCount(a); return cDiff !== 0 ? cDiff : scoreStudent(a) - scoreStudent(b); }).map(s => {
                        const count = makeupCount(s);
                        const score = scoreStudent(s);
                        const scoreLabel = score >= 4 ? "⚠ interruption" : score >= 2 ? "constraint" : score >= 1 ? "specialist" : null;
                        return (
                          <button key={s.id} onClick={() => {
                            const oldest = tallyEntries.filter(e => e.studentId === s.id && e.status === "missed" && e.makeupEligible && !e.madeUp).sort((a, b) => (a.weekKey || "").localeCompare(b.weekKey || ""))[0];
                            if (!oldest) return;
                            placeLesson(s, { instrument: oldest.instrument, teacherId: oldest.teacherId || "", teacherName: oldest.teacherName || "", isMakeup: true, makeupForTallyId: oldest.id });
                            setTallyEntries(prev => prev.map(e => e.id !== oldest.id ? e : { ...e, madeUp: true, madeUpWeekKey: contextMenu.weekKey }));
                          }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit", textAlign: "left" }}
                            onMouseEnter={e => e.currentTarget.style.background = "#F5F3FF"}
                            onMouseLeave={e => e.currentTarget.style.background = "none"}>
                            <span>{s.name}</span>
                            <span style={{ fontSize: 11, color: score > 0 ? "#D97706" : "#6B7280", whiteSpace: "nowrap" }}>{count}{scoreLabel ? " · " + scoreLabel : ""}</span>
                          </button>
                        );
                      })}
                    </SubPanel>
                    <SubPanel type="missed" color="#DC2626" bgHover="#FEF2F2" title="Add missed lesson">
                      {missedStu.map(s => {
                        const count = missedByStudent[s.id] || 0;
                        const missedLesson = thisWeekMissed.find(m => m.studentId === s.id);
                        return (
                          <button key={s.id} onClick={() => {
                            if (!missedLesson) return;
                            placeLesson(s, { instrument: missedLesson.instrument || "", teacherId: missedLesson.teacherId || "", teacherName: missedLesson.teacherName || "" });
                          }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit", textAlign: "left" }}
                            onMouseEnter={e => e.currentTarget.style.background = "#FEF2F2"}
                            onMouseLeave={e => e.currentTarget.style.background = "none"}>
                            <span>{s.name}</span>
                            <span style={{ fontSize: 11, color: "#6B7280", whiteSpace: "nowrap" }}>{count} missed</span>
                          </button>
                        );
                      })}
                    </SubPanel>

                    <SubPanel type="trial" color="#0891B2" bgHover="#ECFEFF" title="Add trial">
                      {[...trialStu].sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(s => (
                        <button key={s.id} onClick={() => placeLesson(s, { isTrial: true })}
                          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.text, fontFamily: "inherit", textAlign: "left" }}
                          onMouseEnter={e => e.currentTarget.style.background = "#ECFEFF"}
                          onMouseLeave={e => e.currentTarget.style.background = "none"}>
                          <span>{s.name}</span>
                          <span style={{ fontSize: 11, color: "#6B7280" }}>{(s.instruments && s.instruments[0]?.name) || ""}</span>
                        </button>
                      ))}
                    </SubPanel>
                    {hasCatchup && (
                      <button style={mkItemStyle("#7C3AED")}
                        onMouseEnter={e => { e.currentTarget.style.background = "#F5F3FF"; setAddLessonSubmenu({ type: "catchup", y: e.currentTarget.getBoundingClientRect().top }); }}
                        onMouseLeave={e => e.currentTarget.style.background = "none"}>
                        <span>↺ Add catch-up</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                    )}
                    {hasMissed && (
                      <button style={mkItemStyle("#DC2626")}
                        onMouseEnter={e => { e.currentTarget.style.background = "#FEF2F2"; setAddLessonSubmenu({ type: "missed", y: e.currentTarget.getBoundingClientRect().top }); }}
                        onMouseLeave={e => e.currentTarget.style.background = "none"}>
                        <span>✕ Add missed</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                    )}

                    {hasTrial && (
                      <button style={mkItemStyle("#0891B2")}
                        onMouseEnter={e => { e.currentTarget.style.background = "#ECFEFF"; setAddLessonSubmenu({ type: "trial", y: e.currentTarget.getBoundingClientRect().top }); }}
                        onMouseLeave={e => e.currentTarget.style.background = "none"}>
                        <span>🎵 Add trial</span><span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
          ) : (
            <>
              <div style={{ padding: "8px 12px", fontSize: 12, color: colors.textMuted, borderBottom: `1px solid ${colors.borderLight}`, fontWeight: 600 }}>
                {contextMenu.lessonName}
              </div>
              <div style={{ padding: "6px 4px" }}>
                {!contextMenu.isGroup && (() => {
                  const st = students.find(s => s.id === contextMenu.studentId);
                  if (!st) return null;
                  const constraints = [];
                  if (st.outsideClassOnly) constraints.push("Outside class only");
                  if (st.outsideClassPreferred) constraints.push("Prefers outside class");
                  if (st.availableBefore) constraints.push("Available before school");
                  if (st.availableAfter) constraints.push("Available after school");
                  if (st.instruments && st.instruments.some(i => i.teacherId)) { const assignedNames = st.instruments.filter(i => i.teacherId).map(i => { const t = teachers.find(t2 => t2.id === i.teacherId); return t ? `${i.name}: ${t.name}` : null; }).filter(Boolean).join(", "); if (assignedNames) constraints.push(`Assigned teacher(s): ${assignedNames}`); }
                  const multiLesson = st.instruments.length > 1 || st.instruments.some(i => i.isGroup);
                  if (multiLesson) constraints.push("Multi-lesson: different days required");
                  return (<>
                    <div style={{ padding: "6px 12px", fontSize: 12, borderBottom: `1px solid ${colors.borderLight}` }}>
                      {constraints.length > 0 ? constraints.map((c, ci) => (
                        <div key={ci} style={{ color: colors.textMuted, padding: "2px 0" }}>• {c}</div>
                      )) : (
                        <div style={{ color: colors.textMuted, fontStyle: "italic" }}>No constraints</div>
                      )}
                    </div>
                    {st.notes && (
                      <div style={{ position: "relative" }}
                        onMouseEnter={() => setHoverNotes(true)}
                        onMouseLeave={() => setHoverNotes(false)}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", fontSize: 13, color: colors.text, borderRadius: 6, cursor: "default", borderBottom: `1px solid ${colors.borderLight}`, background: hoverNotes ? colors.bg : "none" }}>
                          📝 Notes
                        </div>
                        {hoverNotes && (
                          <div style={{ position: "absolute", left: "100%", top: 0, marginLeft: 4, padding: "10px 14px", background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", fontSize: 12, color: colors.text, maxWidth: 240, minWidth: 140, whiteSpace: "pre-wrap", zIndex: 10000, lineHeight: 1.5 }}>
                            {st.notes}
                          </div>
                        )}
                      </div>
                    )}
                  </>);
                })()}
                <button onClick={() => { handleDeleteWeeklyLesson(contextMenu.lessonId); setContextMenu(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", background: "none", border: "none", fontSize: 13, cursor: "pointer", color: colors.danger, borderRadius: 6, fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#FEF2F2"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  🗑 Delete lesson
                </button>
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
                <span style={{ fontSize: 12, color: "#5B3F7A", fontWeight: 500 }}>Regen all schools?</span>
                <Btn variant="primary" onClick={() => { handleGenerateAllSchools(); setConfirmRegenerateWeek(false); }} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, background: "#5B3F7A", color: "#fff", border: "none" }}>Yes</Btn>
                <Btn variant="secondary" onClick={() => setConfirmRegenerateWeek(false)} style={{ height: 28, padding: "0 10px", fontSize: 12, borderRadius: 6, fontWeight: 600 }}>No</Btn>
              </div>
            ) : (
              <Btn variant="secondary" onClick={() => setConfirmRegenerateWeek(true)} disabled={generating || isLocked} style={{ opacity: (generating || isLocked) ? 0.35 : 1, color: "#5B3F7A", border: "none" }} title="Regenerate all schools">🔄</Btn>
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
                    }} style={{ padding: "3px 10px", background: "#2563EB", color: "#fff", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Save</button>
                    <button onClick={() => setPendingRecurringNotes(prev => prev.filter((_, i) => i !== idx))}
                      style={{ padding: "3px 8px", background: "none", color: "#6B7280", border: "1px solid #D1D5DB", borderRadius: 6, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>Dismiss</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={handleGenerate} disabled={generating}
                style={{ padding: "6px 14px", border: "2px solid transparent", borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: generating ? "not-allowed" : "pointer", transition: "all 0.15s", opacity: generating ? 0.5 : 1, background: colors.accent, color: colors.white, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, minWidth: 80 }}
                onMouseEnter={e => { if (!generating) e.currentTarget.style.borderColor = colors.sidebarActive; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "transparent"; }}>
                {generating ? "Parsing adjustments..." : "🔄 Generate Full Week"}
              </button>
              {timetable && currentSchool && (currentSchool.days || DAYS).slice().sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)).map(d => {
                const dayDate = weekDates.find(wd => wd.day === d);
                const dateLabel = dayDate ? new Date(dayDate.date + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
                return (
                  <button key={d} onClick={() => handleGenerateDay(d)}
                    style={{ padding: "6px 12px", border: "2px solid transparent", borderRadius: 8, background: colors.accent, fontSize: 12, fontFamily: "inherit", cursor: "pointer", color: colors.white, fontWeight: 600, transition: "all 0.15s", minWidth: 80, textAlign: "center" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = colors.sidebarActive; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "transparent"; }}
                    title={`Regenerate ${d} only`}>{d.slice(0, 3)}</button>
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
                    <Btn variant="secondary" onClick={() => setShowWttSavePrompt(true)} style={{ fontSize: 12 }} title="Save this week's timetable as a version">💾</Btn>
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
                  <div ref={gridRefCb} onScroll={handleGridScroll} style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 200px)", border: `1px solid ${colors.border}`, borderRadius: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: `50px repeat(${schoolDays.length}, 1fr)`, gap: 1, background: colors.border }}>
                      {/* Header row */}
                      <div style={{ background: colors.sidebarActive, color: colors.white, padding: "12px 2px", fontSize: 11, fontWeight: 600, textAlign: "center", position: "sticky", top: 0, zIndex: 10 }}>Time</div>
                      {schoolDays.map(d => {
                        const dayDate = weekDates.find(wd => wd.day === d);
                        const blocked = isDayBlocked(d);
                        return (
                          <div key={d} style={{ background: blocked ? "#7F1D1D" : colors.sidebarActive, color: colors.white, padding: "10px 8px", textAlign: "center", position: "sticky", top: 0, zIndex: 10 }}>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{d}</div>
                            <div style={{ fontSize: 10, opacity: 0.7 }}>{dayDate?.date}</div>
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
                                        const st = students.find(s => s.id === dl.studentId);
                                        const specs = st && st.className ? (specLookupRef[dl.schoolId + "|" + st.className + "|" + day] || []).filter(sp => { const sS = timeToMin(sl.start), sE = timeToMin(sl.end || sl.start); return sS < sp.end && sE > sp.start; }).map(sp => sp.subject || "Specialist") : [];
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
                                  const hasConstraintIssue = cWarnings.length > 0 && !ackedConstraints.has(l.id);
                                  const constraintAcked = cWarnings.length > 0 && ackedConstraints.has(l.id);
                                  const showRed = hasConstraintIssue;
                                  const hasAckedWarning = constraintAcked;
                                  const isExpanded = expandedWarnings.has(l.id);
                                  return (
                                  <div key={li} draggable
                                    onDragStart={e => { e.dataTransfer.setData("text/plain", l.id); e.dataTransfer.effectAllowed = "move"; setDraggingId(l.id); setExpandedWarnings(new Set()); dragCache.current = {}; }}
                                    onDragEnd={() => { setDraggingId(null); setDragOver(null); hideHoverPanel(); dragCache.current = {}; }}
                                    onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, lessonId: l.id, studentId: l.studentId, isGroup: l.isGroup, isMakeup: l.isMakeup, makeupForTallyId: l.makeupForTallyId, lessonName: l.isGroup && l.studentNames ? `${l.studentNames.join(", ")} — ${l.instrument}` : `${l.studentName} — ${l.instrument}` }); }}
                                    onDoubleClick={() => { if (l.isGroup && onViewGroup) onViewGroup(l.groupId); else if (!l.isGroup && onViewStudent) onViewStudent(l.studentId); }}
                                    onClick={e => { if (isExpanded || showRed) { e.stopPropagation(); setAckedConstraints(prev => { const next = new Set(prev); next.add(l.id); return next; }); setExpandedWarnings(prev => { const next = new Set(prev); next.delete(l.id); return next; }); } }}
                                    style={{
                                      padding: "6px 10px", borderRadius: 6, fontSize: 13, lineHeight: 1.4, cursor: "grab", position: "relative",
                                      background: showRed ? "#FEF2F2" : getInstColor(l.instrument, l.isGroup) + "18",
                                      borderLeft: `3px solid ${showRed ? colors.danger : getInstColor(l.instrument, l.isGroup)}`,
                                      borderBottom: l.adjusted && !showRed && !hasAckedWarning ? "3px solid #F59E0B" : "none",
                                      opacity: draggingId === l.id ? 0.4 : 1,
                                      transition: "opacity 0.15s",
                                    }} title={l.isGroup ? l.groupName || l.studentName : l.adjustReason || undefined}>
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
                                    {l.isMakeup && (
                                      <span
                                        onClick={e => { e.stopPropagation();
                                          const wkData = weeklyTimetables[storageKey] || { lessons: [], missed: [] };
                                          setWeeklyTimetables(prev => ({ ...prev, [storageKey]: { ...wkData, lessons: (wkData.lessons || []).filter(x => x.id !== l.id) } }));
                                          if (l.makeupForTallyId) setTallyEntries(prev => prev.map(e => e.id !== l.makeupForTallyId ? e : { ...e, madeUp: false, madeUpWeekKey: undefined }));
                                        }}
                                        style={{ position: "absolute", top: 2, right: 4, fontSize: 13, color: "#2563EB", cursor: "pointer", lineHeight: 1, fontWeight: 700, zIndex: 2 }}
                                        title="Catch-up lesson — click to remove">↺</span>
                                    )}
                                    <div style={{ fontWeight: 600, color: colors.text }}>{l.isGroup ? "👥 " : ""}{l.isGroup && l.studentNames ? l.studentNames.join(", ") : l.studentName}{(() => { const st = students.find(s => s.id === l.studentId); return st?.className ? ` · ${st.className}` : ""; })()}</div>
                                    <div style={{ color: colors.textLight }}>{l.instrument ? `${l.instrument} · ` : ""}{l.teacherName.split(" ")[0]}</div>
                                    {(() => { const ds = getLiveSpecialistTag(l); return ds ? <div style={{ color: "#8B5CF6", fontSize: 10, fontWeight: 600 }}>during {typeof ds === "string" ? ds : "specialist"}</div> : null; })()}
                                    {l.adjusted && (
                                      <div style={{ fontSize: 10, color: "#D97706", marginTop: 2, fontStyle: "italic" }}>↻ {l.adjustReason}</div>
                                    )}
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
                );
              })()}

              {/* Hover warning panel — DOM-driven, no React state */}
              <div ref={hoverPanelRef} style={{
                display: "none", position: "fixed", zIndex: 9999, pointerEvents: "none",
                background: "#FFFBFF", border: "1px solid #E5E7EB",
                borderRadius: 8, padding: "8px 12px", fontSize: 11, lineHeight: 1.6,
                boxShadow: "0 4px 16px rgba(0,0,0,0.18)", minWidth: 180, maxWidth: 300,
              }} />

              <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "flex-start" }}>
                <Card style={{ flex: 1, borderColor: dragOverMissed ? colors.danger : colors.danger + "40", transition: "border-color 0.15s" }}
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                  onDragEnter={e => { e.preventDefault(); const lid = e.dataTransfer.getData("text/plain") || draggingId || ""; if (!lid.startsWith("missed:") && !lid.startsWith("staged:") && !lid.startsWith("wbreak:")) setDragOverMissed(true); }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverMissed(false); }}
                  onDrop={e => {
                    e.preventDefault(); setDragOverMissed(false);
                    const lid = e.dataTransfer.getData("text/plain");
                    if (lid && !lid.startsWith("missed:")) {
                      const dl = (weeklyData.lessons || []).find(l => l.id === lid);
                      if (dl && dl.fromStaged) return;
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
                  {weeklyData.missed.map((m, i) => (
                    <div key={i} draggable
                      onDragStart={e => { e.dataTransfer.setData("text/plain", `missed:${i}`); e.dataTransfer.effectAllowed = "move"; setDraggingId(`missed:${i}`); dragCache.current = {}; }}
                      onDragEnd={() => { setDraggingId(null); setDragOver(null); setDragOverMissed(false); setDragOverStaging(false); }}
                      onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, fromMissed: true, lessonId: m.id, studentId: m.studentId, isGroup: m.isGroup, lessonName: m.isGroup && m.studentNames ? `${m.studentNames.join(", ")} — ${m.instrument}` : `${m.studentName} — ${m.instrument}` }); }}
                      onDoubleClick={() => { if (m.isGroup && onViewGroup) onViewGroup(m.groupId); else if (!m.isGroup && onViewStudent) onViewStudent(m.studentId); }}
                      style={{
                        padding: "6px 10px", background: "#FEF2F2", borderRadius: 8, fontSize: 12,
                        border: `1px solid ${colors.danger}40`, borderLeft: `3px solid ${colors.danger}`,
                        cursor: "grab", opacity: draggingId === `missed:${i}` ? 0.4 : 1,
                        transition: "opacity 0.15s", maxWidth: 280
                      }}>
                      <div style={{ fontWeight: 600 }}>{m.isGroup ? "👥 " : ""}{m.isGroup ? m.groupName : m.studentName}</div>
                      <div style={{ color: colors.textLight, fontSize: 11 }}>{m.instrument}{m.day ? ` · was ${m.day} ${m.start}` : ""}</div>
                      <div style={{ color: colors.danger, fontSize: 10, marginTop: 2 }}>{m.reason}</div>
                    </div>
                  ))}
                </div>
                </Card>

                {/* Catch-Up Lessons staging area */}
                <Card style={{ flex: 1, borderColor: dragOverStaging ? colors.blue600 : colors.blue600 + "40", transition: "border-color 0.15s" }}
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
                    const restoredCard = {
                      id: draggedLesson.id, studentId: draggedLesson.studentId, studentName: draggedLesson.studentName,
                      schoolId: draggedLesson.schoolId, schoolName: draggedLesson.schoolName,
                      instrument: draggedLesson.instrument, teacherId: draggedLesson.teacherId, teacherName: draggedLesson.teacherName,
                      isMakeup: true, makeupForTallyId: draggedLesson.makeupForTallyId,
                    };
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
                    if (draggedLesson.makeupForTallyId) {
                      setTallyEntries(prev => prev.map(e => e.id !== draggedLesson.makeupForTallyId ? e : { ...e, madeUp: false, madeUpWeekKey: undefined }));
                    }
                    setConstraintWarnings(prev => { const next = { ...prev }; delete next[lid]; return next; });
                    setAckedConstraints(prev => { const next = new Set(prev); next.delete(lid); return next; });
                    setDraggingId(null); setDragOver(null);
                  }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: colors.blue600, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    {`Add Lesson${(weeklyData.catchupStaged || []).length > 0 ? ` (${weeklyData.catchupStaged.length})` : ""}`}
                    <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 400, marginLeft: 4 }}>· right-click any empty slot to add, then drag onto the grid</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minHeight: 72, alignContent: "flex-start", borderRadius: 8, padding: 4, background: dragOverStaging ? colors.purpleLight : "transparent", transition: "background 0.15s" }}>
                    {(weeklyData.catchupStaged || []).map((c) => (
                      <div key={c.id} draggable
                        onDragStart={e => { e.dataTransfer.setData("text/plain", "staged:" + c.id); e.dataTransfer.effectAllowed = "move"; setDraggingId("staged:" + c.id); dragCache.current = {}; }}
                        onDragEnd={() => { setDraggingId(null); setDragOver(null); setDragOverMissed(false); setDragOverStaging(false); }}
                        style={{
                          padding: "6px 10px", background: colors.purpleLight, borderRadius: 8, fontSize: 12,
                          border: "1px solid " + colors.purple600 + "40", borderLeft: "3px solid " + colors.purple600,
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
                        <div style={{ fontWeight: 600, color: colors.purple600 }}>↺ {c.studentName}</div>
                        <div style={{ color: colors.textMuted, fontSize: 11 }}>{c.instrument}{c.teacherName ? " · " + c.teacherName : ""}</div>
                        <div style={{ color: colors.purple600, fontSize: 10, marginTop: 2 }}>catch-up — drag to place</div>
                      </div>
                    ))}
                    {/* Always-visible empty slot — right-click to add */}
                    <div
                      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, isCatchupStage: true, schoolId: selectedSchool, weekKey: storageKey }); }}
                      style={{
                        padding: "6px 10px", borderRadius: 8, fontSize: 12, minWidth: 120, minHeight: 52,
                        border: "1.5px dashed " + colors.purple600 + "60",
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
              <div style={{ fontSize: 13, marginTop: 6 }}>Add any adjustments above and hit Generate to create a weekly version based on the master timetable.</div>
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

// ============================================================
// TALLY VIEW
// ============================================================
const TALLY_REASONS = [
  { value: "informed_absence", label: "Informed Absence", makeupEligible: true },
  { value: "uninformed_absence", label: "Uninformed Absence", makeupEligible: false },
  { value: "school_interruption", label: "School Interruption", makeupEligible: true },
  { value: "teacher_absent", label: "Teacher Absent", makeupEligible: true },
  { value: "timetable_clash", label: "Timetable Clash", makeupEligible: true },
  { value: "other", label: "Other", makeupEligible: null }, // null = user chooses
  { value: "removed_not_charged", label: "Removed – Not Charged", makeupEligible: false, invisible: true },
  { value: "extended_absence", label: "Extended Absence", makeupEligible: false, invisible: true },
];

// ============================================================
// CONTACTS MANAGER
// ============================================================
const CONTACT_ROLES = ["Principal", "Assistant Principal", "Office Manager", "Business Manager", "Classroom Teacher", "Specialist Teacher", "Other"];
const CLASS_ROLES = ["Classroom Teacher", "Specialist Teacher"];

function ContactsManager({ contacts, setContacts, schools, students, specialists, notify, resetKey, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [expandedNotes, setExpandedNotes] = useState(new Set());
  const [expandedPhone, setExpandedPhone] = useState(new Set());
  const [selected, setSelected] = useState(new Set());
  const [lastChecked, setLastChecked] = useState(null);
  const [filterSchool, setFilterSchool] = useState("");
  const [filterRole, setFilterRole] = useState("");
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState("name");
  const [sortDir, setSortDir] = useState("asc");
  const [tooltip, setTooltip] = useState(null); // { text, x, y }
  const anyExpandedRef = useRef(false);

  const showTooltip = (e, text) => {
    if (!text) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTooltip({ text, x: r.left + r.width / 2, y: r.top - 8 });
  };
  const hideTooltip = () => setTooltip(null);

  useEffect(() => { setEditingId(null); setEditForm(null); setSelected(new Set()); }, [resetKey]);

  // Keep ref in sync so click-outside handler doesn't need to re-register on every change
  useEffect(() => {
    anyExpandedRef.current = expandedNotes.size > 0 || expandedPhone.size > 0;
  }, [expandedNotes, expandedPhone]);

  // Collapse expanded phone/notes when clicking outside them — registered once only
  useEffect(() => {
    const handler = (e) => {
      if (!anyExpandedRef.current) return;
      if (e.target.closest("[data-expand-area]") || e.target.closest("[data-expand-toggle]")) return;
      setExpandedNotes(new Set());
      setExpandedPhone(new Set());
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const addContact = () => {
    const id = uid();
    const blank = { id, name: "", schoolId: "", role: "", roleOther: "", className: "", email: "", phone: "", notes: "", _isNew: true };
    setContacts(prev => [blank, ...prev]);
    setEditingId(id);
    setEditForm({ ...blank });
  };

  const startEdit = (c) => { setEditingId(c.id); setEditForm({ ...c }); };

  const saveEdit = () => {
    if (!editForm) return;
    const { _isNew, ...toSave } = editForm;
    setContacts(prev => prev.map(c => c.id === editingId ? toSave : c));
    setEditingId(null); setEditForm(null);
  };

  const cancelEdit = () => {
    // Only remove the row if it was a freshly added blank that was never saved
    const c = contacts.find(ct => ct.id === editingId);
    if (c && c._isNew) setContacts(prev => prev.filter(ct => ct.id !== editingId));
    setEditingId(null); setEditForm(null);
  };

  const deleteContact = (id) => {
    setContacts(prev => prev.filter(c => c.id !== id));
    setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
    if (editingId === id) { setEditingId(null); setEditForm(null); }
  };

  const updateNote = (id, val) => {
    setContacts(prev => prev.map(c => c.id === id ? { ...c, notes: val } : c));
  };

  const toggleNote = (id) => {
    setExpandedNotes(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const togglePhone = (id) => {
    setExpandedPhone(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const updatePhone = (id, val) => {
    setContacts(prev => prev.map(c => c.id === id ? { ...c, phone: val } : c));
  };

  const getClassOptions = (schoolId, role) => {
    if (role === "Classroom Teacher") {
      // Use specialist classNames as the source of truth — same as the Specialists tab
      const fromSpecialists = specialists.filter(s => !schoolId || s.schoolId === schoolId).map(s => s.className).filter(Boolean);
      const fromStudents = students.filter(s => !schoolId || s.schoolId === schoolId).map(s => s.className).filter(Boolean);
      const all = [...new Set([...fromSpecialists, ...fromStudents])];
      // Classes starting with P or F (Prep/Foundation) at top, rest sorted numerically
      const isFoundation = (n) => /^[PpFf]/i.test(n.trim());
      const foundation = all.filter(isFoundation).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const rest = all.filter(n => !isFoundation(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return [...foundation, ...rest];
    }
    if (role === "Specialist Teacher") {
      // Show only specialist subject names (Art, Music, PE etc.) for this school
      const schoolSpecialists = specialists.filter(s => !schoolId || s.schoolId === schoolId);
      return [...new Set(schoolSpecialists.map(s => s.subject).filter(Boolean))].sort();
    }
    return [];
  };

  const filtered = contacts.filter(c => {
    if (filterSchool && c.schoolId !== filterSchool) return false;
    if (filterRole && c.role !== filterRole) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(c.name || "").toLowerCase().includes(q) && !(c.email || "").toLowerCase().includes(q) && !(c.role || "").toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    let av = "", bv = "";
    if (sortCol === "name") { av = a.name || ""; bv = b.name || ""; }
    else if (sortCol === "school") { av = schools.find(s => s.id === a.schoolId)?.name || ""; bv = schools.find(s => s.id === b.schoolId)?.name || ""; }
    else if (sortCol === "role") { av = a.role || ""; bv = b.role || ""; }
    else if (sortCol === "class") { av = a.className || ""; bv = b.className || ""; }
    else if (sortCol === "email") { av = a.email || ""; bv = b.email || ""; }
    const cmp = av.localeCompare(bv, undefined, { sensitivity: "base" });
    return sortDir === "asc" ? cmp : -cmp;
  });

  const handleCheckbox = (id, e) => {
    const rows = filtered;
    const idx = rows.findIndex(r => r.id === id);
    if (e.shiftKey && lastChecked !== null) {
      const lastIdx = rows.findIndex(r => r.id === lastChecked);
      const [lo, hi] = [Math.min(idx, lastIdx), Math.max(idx, lastIdx)];
      setSelected(prev => {
        const n = new Set(prev);
        for (let i = lo; i <= hi; i++) n.add(rows[i].id);
        return n;
      });
    } else {
      setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    }
    setLastChecked(id);
  };

  const toggleSelectAll = () => {
    if (selected.size === filtered.length && filtered.length > 0) setSelected(new Set());
    else setSelected(new Set(filtered.map(c => c.id)));
  };

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };

  const SortTh = ({ col, children }) => {
    const active = sortCol === col;
    return (
      <th onClick={() => handleSort(col)} style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: active ? colors.accent : colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", whiteSpace: "nowrap", userSelect: "none", background: colors.sidebarActive }}>
        {children}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
      </th>
    );
  };

  const mailtoSelected = () => {
    const emails = [...selected].map(id => (contacts.find(c => c.id === id) || {}).email).filter(Boolean);
    if (emails.length === 0) { notify("No email addresses in selection", "warning"); return; }
    window.location.href = "mailto:" + emails.join(",");
  };

  return (
    <div>
      {tooltip && (
        <div style={{ position: "fixed", left: tooltip.x, top: tooltip.y, transform: "translate(-50%, -100%)", background: "rgba(30,30,30,0.92)", color: "#fff", fontSize: 12, padding: "4px 9px", borderRadius: 6, pointerEvents: "none", zIndex: 9999, whiteSpace: "pre-wrap", maxWidth: 260, lineHeight: 1.4 }}>
          {tooltip.text}
        </div>
      )}
      <PageTitle subtitle={contacts.length + " contacts"} pageColor={PAGE_COLORS.contacts}
        action={<Btn onClick={addContact}>+ Add Contact</Btn>}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
        Contacts
      </PageTitle>

      <Card style={{ marginBottom: 16, padding: 14 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 160, position: "relative" }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or email..."
              style={{ width: "100%", padding: "8px 32px 8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
            {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>}
          </div>
          <select value={filterSchool} onChange={e => setFilterSchool(e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
            <option value="">All Schools</option>
            {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={filterRole} onChange={e => setFilterRole(e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid " + colors.inputBorder, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
            <option value="">All Roles</option>
            {CONTACT_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          {selected.size > 0 && (
            <button onClick={mailtoSelected}
              style={{ padding: "8px 14px", border: "none", borderRadius: 8, fontSize: 13, fontFamily: "inherit", cursor: "pointer", background: colors.accent, color: colors.white, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              ✉ Email {selected.size} selected
            </button>
          )}
        </div>
      </Card>

      {contacts.length === 0 ? (
        <EmptyState icon="📇" title="No contacts yet" subtitle="Add school contacts like principals, office managers, and classroom teachers." action="+ Add Contact" onAction={addContact} />
      ) : (
        <div style={{ background: colors.white, border: "1px solid " + colors.border, borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ padding: "10px 12px", background: colors.sidebarActive, width: 36 }}>
                  <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleSelectAll}
                    style={{ cursor: "pointer" }} />
                </th>
                <SortTh col="name">Name</SortTh>
                <SortTh col="school">School</SortTh>
                <SortTh col="role">Role</SortTh>
                <SortTh col="class">Class / Subject</SortTh>
                <SortTh col="email">Email</SortTh>
                <th style={{ padding: "10px 12px", background: colors.sidebarActive, width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, idx) => {
                const isEditing = editingId === c.id;
                const noteOpen = expandedNotes.has(c.id);
                const schoolName = schools.find(s => s.id === c.schoolId)?.name || "";
                const classOpts = getClassOptions(isEditing ? editForm.schoolId : c.schoolId, isEditing ? editForm.role : c.role);
                const showClassField = CLASS_ROLES.includes(isEditing ? editForm.role : c.role);
                const rowBg = idx % 2 === 0 ? colors.white : colors.bg;

                return (
                  <React.Fragment key={c.id}>
                    <tr style={{ background: isEditing ? colors.blueLight : rowBg, borderBottom: noteOpen ? "none" : "1px solid " + colors.borderLight }}>
                      {/* Checkbox */}
                      <td style={{ padding: "8px 12px", textAlign: "center" }}>
                        <input type="checkbox" checked={selected.has(c.id)} onChange={e => handleCheckbox(c.id, e)} style={{ cursor: "pointer" }} />
                      </td>

                      {/* Name */}
                      <td style={{ padding: "6px 12px", fontWeight: 600 }}>
                        {isEditing
                          ? <input autoFocus value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} placeholder="Full name"
                              style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                          : c.name || <span style={{ color: colors.textMuted, fontStyle: "italic" }}>—</span>}
                      </td>

                      {/* School */}
                      <td style={{ padding: "6px 12px" }}>
                        {isEditing
                          ? <select value={editForm.schoolId} onChange={e => setEditForm(p => ({ ...p, schoolId: e.target.value, className: "" }))}
                              style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                              <option value="">Select…</option>
                              {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          : schoolName || <span style={{ color: colors.textMuted }}>—</span>}
                      </td>

                      {/* Role */}
                      <td style={{ padding: "6px 12px" }}>
                        {isEditing
                          ? <div style={{ display: "flex", gap: 4, flexDirection: "column" }}>
                              <select value={editForm.role} onChange={e => setEditForm(p => ({ ...p, role: e.target.value, className: "" }))}
                                style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                                <option value="">Select…</option>
                                {CONTACT_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                              </select>
                              {editForm.role === "Other" && (
                                <input value={editForm.roleOther || ""} onChange={e => setEditForm(p => ({ ...p, roleOther: e.target.value }))} placeholder="Specify role…"
                                  style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" }} />
                              )}
                            </div>
                          : <span>{c.role}{c.role === "Other" && c.roleOther ? " — " + c.roleOther : ""}</span>}
                      </td>

                      {/* Class */}
                      <td style={{ padding: "6px 12px" }}>
                        {isEditing && showClassField
                          ? <select value={editForm.className || ""} onChange={e => setEditForm(p => ({ ...p, className: e.target.value }))}
                              style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }}>
                              <option value="">Select…</option>
                              {classOpts.map(cl => <option key={cl} value={cl}>{cl}</option>)}
                            </select>
                          : c.className || <span style={{ color: colors.textMuted }}>—</span>}
                      </td>

                      {/* Email */}
                      <td style={{ padding: "6px 12px" }}>
                        {isEditing
                          ? <input type="email" value={editForm.email} onChange={e => setEditForm(p => ({ ...p, email: e.target.value }))} placeholder="email@school.edu.au"
                              style={{ width: "100%", padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
                          : c.email
                            ? <a href={"mailto:" + c.email} onClick={e => e.stopPropagation()} style={{ color: colors.blue600, textDecoration: "none" }}>{c.email}</a>
                            : <span style={{ color: colors.textMuted }}>—</span>}
                      </td>

                      {/* Actions */}
                      <td style={{ padding: "6px 12px", whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
                          {isEditing ? (
                            <>
                              <button onClick={saveEdit} title="Save" style={{ border: "none", background: colors.success, color: "#fff", borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600 }}>✓</button>
                              <button onClick={cancelEdit} title="Cancel" style={{ border: "1px solid " + colors.border, background: colors.white, color: colors.textMuted, borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>✕</button>
                            </>
                          ) : (
                            <>
                              {c.email && <a href={"mailto:" + c.email} onClick={e => e.stopPropagation()} title={"Email " + c.name} style={{ border: "1px solid " + colors.border, background: colors.white, color: colors.blue600, borderRadius: 6, padding: "4px 7px", fontSize: 13, textDecoration: "none", display: "inline-block" }}>✉</a>}
                              <button data-expand-toggle="true" onClick={() => toggleNote(c.id)} onMouseEnter={e => showTooltip(e, c.notes ? c.notes.slice(0, 80) : "Add notes")} onMouseLeave={hideTooltip} style={{ border: "1px solid " + colors.border, background: noteOpen ? colors.sidebarActive : colors.white, color: noteOpen ? colors.white : colors.textMuted, borderRadius: 6, padding: "4px 7px", cursor: "pointer", fontSize: 13 }}>📝</button>
                              <button data-expand-toggle="true" onClick={() => togglePhone(c.id)} onMouseEnter={e => showTooltip(e, c.phone || "Add phone number")} onMouseLeave={hideTooltip} style={{ border: "1px solid " + colors.border, background: expandedPhone.has(c.id) ? colors.sidebarActive : colors.white, color: expandedPhone.has(c.id) ? colors.white : (c.phone ? colors.text : colors.textMuted), borderRadius: 6, padding: "4px 7px", cursor: "pointer", fontSize: 13 }}>📞</button>
                              <button onClick={() => startEdit(c)} title="Edit" style={{ border: "1px solid " + colors.border, background: colors.white, color: colors.textMuted, borderRadius: 6, padding: "4px 7px", cursor: "pointer", fontSize: 13 }}>✏</button>
                              <button onClick={() => deleteContact(c.id)} title="Delete" style={{ border: "1px solid " + colors.danger + "60", background: colors.white, color: colors.danger, borderRadius: 6, padding: "4px 7px", cursor: "pointer", fontSize: 13 }}>🗑</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>

                    {/* Expandable phone row */}
                    {expandedPhone.has(c.id) && (
                      <tr style={{ background: rowBg, borderBottom: noteOpen ? "none" : "1px solid " + colors.borderLight }}>
                        <td data-expand-area="true" colSpan={7} style={{ padding: "0 12px 8px 48px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap" }}>Phone</span>
                            <input
                              value={isEditing ? (editForm.phone || "") : (c.phone || "")}
                              onChange={e => isEditing ? setEditForm(p => ({ ...p, phone: e.target.value })) : updatePhone(c.id, e.target.value)}
                              placeholder="04xx xxx xxx"
                              style={{ flex: 1, maxWidth: 200, padding: "5px 8px", border: "1px solid " + colors.inputBorder, borderRadius: 6, fontSize: 13, fontFamily: "inherit" }} />
                          </div>
                        </td>
                      </tr>
                    )}

                    {/* Expandable notes row */}
                    {noteOpen && !isEditing && (
                      <tr style={{ background: rowBg, borderBottom: "1px solid " + colors.borderLight }}>
                        <td data-expand-area="true" colSpan={7} style={{ padding: "0 12px 10px 48px" }}>
                          <textarea
                            value={c.notes || ""}
                            onChange={e => updateNote(c.id, e.target.value)}
                            placeholder="Notes…"
                            style={{ width: "100%", padding: "8px 10px", border: "1px solid " + colors.inputBorder, borderRadius: 7, fontSize: 12, fontFamily: "inherit", resize: "vertical", minHeight: 60, boxSizing: "border-box", color: colors.text, background: colors.white }} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div style={{ padding: "32px 20px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>No contacts match the current filters</div>
          )}
        </div>
      )}
    </div>
  );
}

function TallyView({ timetable, schools, students, teachers, interruptions, tallyEntries, setTallyEntries, weeklyTimetables, setWeeklyTimetables, notify, onExport, viewState, setViewState, goBack, goForward, historyCursor, pageHistory }) {
  const selectedSchool = (viewState || {}).selectedSchool ?? "all";
  const setSelectedSchool = (v) => setViewState(prev => ({ ...prev, selectedSchool: typeof v === "function" ? v(prev.selectedSchool ?? "all") : v }));
  const groupBy = (viewState || {}).groupBy || "teacher";
  const setGroupBy = (v) => setViewState(prev => ({ ...prev, groupBy: v }));
  const [editCell, setEditCell] = useState(null); // { lessonKey, lesson, weekKey, weekNum }
  const [editForm, setEditForm] = useState({ status: "completed", reason: "", notes: "", makeupEligible: false, madeUp: false });
  const [madeUpPopup, setMadeUpPopup] = useState(null); // { x, y, weekNum }
  const [tallyTooltip, setTallyTooltip] = useState(null); // { text, x, y } — instant hover for removed cells
  const [hoveredWeekKey, setHoveredWeekKey] = useState(null);

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
    while (w <= activeTerm.end) {
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

  // ── Quick complete (left click) ────────────────────────────
  const quickComplete = (lesson, week) => {
    const key = `${lesson.lessonKey}|${week.weekKey}`;
    const existing = entryMap[key];
    // Removed entry: left-click restores to unmarked
    if (existing?.status === "removed") {
      setTallyEntries(prev => prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== key));
      return;
    }
    // If already completed, toggle it off (remove entry). Otherwise mark completed.
    if (existing?.status === "completed") {
      setTallyEntries(prev => prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== key));
    } else {
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
        status: "completed", reason: null, notes: "",
        makeupEligible: false, madeUp: false,
        recordedAt: new Date().toISOString(),
      };
      setTallyEntries(prev => [...prev.filter(e => `${e.lessonKey}|${e.weekKey}` !== key), newEntry]);
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
      const order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
      const groups = {};
      for (const r of lessonRows) {
        const k = r.day || "Unknown";
        if (!groups[k]) groups[k] = [];
        groups[k].push(r);
      }
      return Object.entries(groups).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
    }
    if (groupBy === "instrument") {
      const groups = {};
      for (const r of lessonRows) {
        const k = r.instrument || "Unknown";
        if (!groups[k]) groups[k] = [];
        groups[k].push(r);
      }
      return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
    }
    return [["All Students", lessonRows]];
  }, [lessonRows, groupBy]);

  // ── Cell render ─────────────────────────────────────────────
  const CellIcon = ({ entry, isFuture }) => {
    if (!entry) {
      return <span style={{ color: isFuture ? "#9CA3AF" : "#4B5563", fontSize: 16, lineHeight: 1 }}>○</span>;
    }
    if (entry.status === "removed") return null;
    if (entry.status === "completed") return <span style={{ color: "#16A34A", fontSize: 16 }}>✓</span>;
    if (entry.status === "missed") {
      if (entry.madeUp) return <span style={{ color: "#2563EB", fontSize: 15, fontWeight: 700 }}>↺</span>;
      if (entry.makeupEligible) return <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", background: "#D97706" }} />;
      return <span style={{ color: "#DC2626", fontSize: 14, fontWeight: 700 }}>✕</span>;
    }
    return null;
  };

  const todayStr = melbourneToday();
  const isFutureWeek = (weekKey) => weekKey > todayStr;

  // ── Render ──────────────────────────────────────────────────
  const pageColor = PAGE_COLORS.tally;
  const headerBg = "#F3F4F6";

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
            const abbr = s.name.includes("Solway") ? "SPS" : s.name.includes("East Bentleigh") ? "EBPS" : s.name.includes("Moorabbin") ? "MPS" : s.name.split(" ").map(w => w[0]).join("");
            const active = selectedSchool === s.id;
            return (
              <Btn key={s.id} onClick={() => setSelectedSchool(active ? "all" : s.id)}
                variant={active ? "primary" : "secondary"}>🏫 {abbr}</Btn>
            );
          })}
          <select value={groupBy} onChange={e => setGroupBy(e.target.value)}
            style={{ height: 34, padding: "0 12px", border: `2px solid ${colors.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: colors.white, fontWeight: 600, cursor: "pointer", boxSizing: "border-box", marginTop: -2 }}>
            <option value="teacher">By Teacher</option>
            <option value="instrument">By Instrument</option>
            <option value="day">By Day</option>
            <option value="none">No Grouping</option>
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
          { label: "Made Up", value: stats.madeUp, color: "#2563EB", bg: "rgba(52,69,101,0.07)", icon: "↺" },
        ].map(s => (
          <div key={s.label} style={{ background: s.bg, border: `1px solid ${s.color}22`, borderRadius: 10, padding: "10px 18px", flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap" }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: s.color, lineHeight: 1, flexShrink: 0 }}>{s.value}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", lineHeight: 1.3 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, marginBottom: 14, fontSize: 12, color: "#6B7280", flexWrap: "wrap" }}>
        {[
          { icon: "○", color: "#9CA3AF", label: "Unmarked" },
          { icon: "✓", color: "#16A34A", label: "Completed" },
          { icon: "✕", color: "#DC2626", label: "Absent (no makeup)" },
          { icon: "●", color: "#D97706", label: "Makeup owed" },
          { icon: "↺", color: "#2563EB", label: "Made up" },
        ].map(l => (
          <span key={l.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ color: l.color, fontWeight: 700, fontSize: 14 }}>{l.icon}</span> {l.label}
          </span>
        ))}
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
        <div style={{ overflowX: "auto", borderRadius: 10, border: "1px solid #E5E7EB" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 600 }}>
            <thead style={{ position: "sticky", top: 0, zIndex: 3 }}>
              <tr style={{ background: headerBg }}>
                <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: "#374151", borderBottom: "2px solid #D1D5DB", position: "sticky", left: 0, background: headerBg, zIndex: 2, minWidth: 180, whiteSpace: "nowrap" }}>
                  Student / Group
                </th>
                <th style={{ padding: "10px 8px", textAlign: "center", fontWeight: 600, fontSize: 11, color: "#6B7280", borderBottom: "2px solid #D1D5DB", whiteSpace: "nowrap" }}>
                  Instrument
                </th>
                {termWeeks.map(w => (
                  <th key={w.weekKey} style={{ padding: "8px 4px", textAlign: "center", fontWeight: 600, fontSize: 11, color: isFutureWeek(w.weekKey) ? "#D1D5DB" : "#374151", borderBottom: "2px solid #D1D5DB", minWidth: 36, background: hoveredWeekKey === w.weekKey ? "#E5E7EB" : headerBg, transition: "background 0.1s" }}
                    onMouseEnter={() => setHoveredWeekKey(w.weekKey)}
                    onMouseLeave={() => setHoveredWeekKey(null)}>
                    {w.label}
                  </th>
                ))}
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 600, fontSize: 11, color: "#374151", borderBottom: "2px solid #D1D5DB", whiteSpace: "nowrap" }}>
                  Summary
                </th>
              </tr>
            </thead>
            <tbody>
              {groupedRows.map(([groupLabel, rows], gi) => (
                <React.Fragment key={groupLabel}>
                  {groupBy !== "none" && (
                    <tr>
                      <td colSpan={termWeeks.length + 3} style={{ padding: "8px 14px 4px", fontSize: 11, fontWeight: 700, color: "#fff", background: pageColor, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                        {groupLabel}
                      </td>
                    </tr>
                  )}
                  {rows.map((lesson, ri) => {
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
                          {selectedSchool === "all" && <div style={{ fontSize: 10, color: "#6366F1", fontWeight: 600 }}>{schools.find(s => s.id === lesson.schoolId)?.name.includes("Solway") ? "SPS" : schools.find(s => s.id === lesson.schoolId)?.name.includes("East Bentleigh") ? "EBPS" : schools.find(s => s.id === lesson.schoolId)?.name.includes("Moorabbin") ? "MPS" : ""}</div>}
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
                              onClick={e => { e.stopPropagation(); if (!future || entry?.status === "removed") quickComplete(lesson, w); else if (!future && !(entry?.madeUp)) quickComplete(lesson, w); }}
                              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (entry?.madeUp) { setMadeUpPopup({ x: e.clientX, y: e.clientY, weekNum: w.label }); } else if (!future || entry) openEdit(lesson, w); }}
                              onMouseEnter={e => {
                                setHoveredWeekKey(w.weekKey);
                                const r = e.currentTarget.getBoundingClientRect();
                                const text = entry?.status === "removed"
                                  ? (TALLY_REASONS.find(tr => tr.value === entry.reason)?.label || "Removed")
                                  : entry?.status === "completed" ? "Completed" + (entry.notes ? " — " + entry.notes : "")
                                  : entry?.status === "missed" ? ((TALLY_REASONS.find(tr => tr.value === entry.reason)?.label || "Missed") + (entry.notes ? " — " + entry.notes : ""))
                                  : future ? "Future week" : "Unmarked";
                                setTallyTooltip({ text, x: r.left + r.width / 2, y: r.top - 6 });
                              }}
                              onMouseLeave={() => { setHoveredWeekKey(null); setTallyTooltip(null); }}>
                              {entry?.status !== "removed" && (
                                <div style={{ width: 28, height: 28, margin: "0 auto", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: isEditing ? "rgba(52,69,101,0.07)" : entry ? (entry.status === "completed" ? "#F0FDF4" : entry.madeUp ? "rgba(52,69,101,0.07)" : entry.makeupEligible ? "#FFFBEB" : "#FEF2F2") : "transparent", border: isEditing ? "2px solid #3B82F6" : "none" }}>
                                  <CellIcon entry={entry} isFuture={future} />
                                </div>
                              )}
                            </td>
                          );
                        })}
                        <td style={{ padding: "8px 12px", borderBottom: "1px solid #F3F4F6", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", fontSize: 11 }}>
                            <span style={{ color: "#16A34A", fontWeight: 600 }}>{rowCompleted}✓</span>
                            {(rowMissed - rowMakeup - rowMadeUp) > 0 && <span style={{ color: "#DC2626", fontWeight: 600 }}>{rowMissed - rowMakeup - rowMadeUp}✕</span>}
                            {rowMakeup > 0 && <span style={{ color: "#D97706", fontWeight: 600 }}>{rowMakeup}●</span>}
                            {rowMadeUp > 0 && <span style={{ color: "#2563EB", fontWeight: 600 }}>{rowMadeUp}↺</span>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Made-up popup on right-click */}
      {madeUpPopup && (
        <div style={{ position: "fixed", inset: 0, zIndex: 999 }} onClick={() => setMadeUpPopup(null)}>
          <div style={{ position: "fixed", top: madeUpPopup.y, left: madeUpPopup.x, zIndex: 1000, background: "rgba(52,69,101,0.07)", border: "1px solid rgba(52,69,101,0.25)", borderRadius: 8, padding: "10px 16px", fontSize: 13, color: "#1D4ED8", fontWeight: 600, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", whiteSpace: "nowrap" }}
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
                      style={{ padding: "9px 12px", borderRadius: 7, border: isCurrentReason ? "2px solid #6D28D9" : "1.5px solid #E5E7EB", background: isCurrentReason ? "#F5F3FF" : "#fff", color: isCurrentReason ? "#5B21B6" : "#374151", fontWeight: isCurrentReason ? 700 : 400, fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                      onMouseEnter={e => { if (!isCurrentReason) e.currentTarget.style.background = "#F5F3FF"; }}
                      onMouseLeave={e => { if (!isCurrentReason) e.currentTarget.style.background = "#fff"; }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {isCurrentReason && <span style={{ fontSize: 10, color: "#6D28D9" }}>✓</span>}
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

            {/* Clear / Cancel */}
            <div style={{ display: "flex", gap: 8 }}>
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
