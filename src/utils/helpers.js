// ============================================================
// HELPERS
// General-purpose utility functions used across the app.
// ============================================================

import { DAYS, instruments_colors } from "../constants";
import { supabase } from "../supabaseClient";
import { instrumentsFromEnrolments } from "./enrolmentsDB";
import { getCardTeacherId } from "./teacherCoverageDB";

// ── ID generation ─────────────────────────────────────────────────────────────

export const uid = () => Math.random().toString(36).slice(2, 10);

// ── UI helpers ────────────────────────────────────────────────────────────────

// Clamp a fixed-position menu so it stays within the viewport.
// Only nudges left/up if the menu would actually overflow — never moves
// it away from the cursor otherwise.
export const clampMenuPos = (x, y, estW = 200, estH = 300, side = null) => {
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

// ── Date & time helpers ───────────────────────────────────────────────────────

// Timezone helpers — reads from localStorage (set in Settings), defaults to Melbourne.
const getTimezone = () => {
  try { return localStorage.getItem("mt-timezone") || "Australia/Melbourne"; } catch { return "Australia/Melbourne"; }
};

// Get current time in the user's configured timezone.
// Uses Intl.DateTimeFormat to extract date/time parts correctly,
// then constructs a plain Date with those values so .getHours(), .getDay() etc. work.
export const melbourneNow = () => {
  const TIMEZONE = getTimezone();
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t) => parseInt(parts.find(p => p.type === t)?.value || "0", 10);
  return new Date(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
};

export const melbourneToday = () => toLocalDateStr(melbourneNow());
export const melbourneDayName = () => DAYS[((melbourneNow().getDay() + 6) % 7)]; // Mon=0

// Get Monday of the "current" working week.
// Rolls forward to NEXT Monday after 6pm Friday (i.e. the weekend shows next week).
export const getCurrentWeekMonday = () => {
  const now = melbourneNow();
  const dow = now.getDay(); // 0=Sun, 5=Fri, 6=Sat
  const hour = now.getHours();
  // After 6pm Friday, or Saturday, or Sunday → use next Monday
  const rollForward = (dow === 5 && hour >= 18) || dow === 6 || dow === 0;
  const effective = new Date(now);
  if (rollForward) {
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

// Format date as YYYY-MM-DD using local timezone (NOT UTC)
export const toLocalDateStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Returns the Monday of the week containing dt (private helper, also exported for tally helpers)
export const _getMondayOf = (dt) => {
  const m = new Date(dt);
  const dow = m.getDay();
  m.setDate(m.getDate() + (dow === 0 ? -6 : 1 - dow));
  m.setHours(0, 0, 0, 0);
  return m;
};

export const timeToMin = (t) => {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

// Convert 24h "HH:MM" to 12h "H:MM AM/PM"
export const to12h = (t) => {
  if (!t || !t.includes(":")) return t;
  const [hStr, mStr] = t.split(":");
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return h + ":" + mStr + " " + ampm;
};

// Display time without AM/PM — school context makes it unambiguous
export const toTimeLabel = (t) => {
  if (!t || !t.includes(":")) return t;
  const [hStr, mStr] = t.split(":");
  let h = parseInt(hStr, 10);
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return h + ":" + mStr;
};

export function getTermWeekLabel(dateStr, termBreaks) {
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
  const week1Monday = _getMondayOf(termStartDay);
  const targetMonday = _getMondayOf(d);
  const diffWeeks = Math.round((targetMonday.getTime() - week1Monday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  const weekNum = Math.max(1, diffWeeks + 1);
  return `Week ${weekNum}`;
}

// ── Lesson / group display helpers ────────────────────────────────────────────

export const groupDisplayName = (l) =>
  l.groupName || l.studentNames?.map(n => n.split(" ")[0]).join(", ") || l.studentName || "Group";

export const bandDisplayName = (lesson, members) =>
  lesson.bandName || lesson.groupName || (members && members.length > 0 ? members.map(m => m.name.split(" ")[0]).join(", ") : null) || "Band";

// Derive the current teacher name for a lesson from live student/teacher data.
// Cluster 6b1: override-first via (weekKey, bucket_id) when WTT context provided.
// Cluster 5a: lane-first via bucket_id. Falls back to stored teacherName if no
// instrument match found.
export const getLiveTeacherName = (lesson, students, teachers, enrolments, teacherCoverage, laneOverrides = null, weekKey = null) => {
  if (!lesson) return "";
  const laneTid = getCardTeacherId(lesson, teacherCoverage, laneOverrides, weekKey);
  if (laneTid) {
    const t = teachers.find(x => x.id === laneTid);
    if (t?.name) return t.name;
  }
  if (lesson.isGroup || lesson.isBandSession) return lesson.teacherName || "";
  const student = students.find(s => s.id === lesson.studentId);
  if (student) {
    // Try the stored instrument first; if the student's instrument has changed,
    // fall back to their current primary non-group instrument.
    const studentInsts = instrumentsFromEnrolments(student.id, enrolments);
    const inst = studentInsts.find(i => i.name === lesson.instrument)
      || studentInsts.find(i => !i.isGroup);
    if (inst) {
      if (!inst.teacherId) return "Unassigned";
      const teacher = teachers.find(t => t.id === inst.teacherId);
      if (teacher) return teacher.name;
    }
  }
  return lesson.teacherName || "";
};

// Returns the live teacher ID for a lesson, derived from current student data.
// Cluster 6b1: override-first via (weekKey, bucket_id) when WTT context provided.
// Cluster 5a: lane-first via bucket_id (Path B). Falls back to existing chain
// for legacy cards without bucket_id and for lane-misses.
export const getLiveTeacherId = (lesson, students, enrolments, teacherCoverage, laneOverrides = null, weekKey = null) => {
  if (!lesson) return null;
  const laneTid = getCardTeacherId(lesson, teacherCoverage, laneOverrides, weekKey);
  if (laneTid) return laneTid;
  if (lesson.isGroup || lesson.isBandSession) return lesson.teacherId;
  const student = students.find(s => s.id === lesson.studentId);
  if (!student) return lesson.teacherId;
  const studentInsts = instrumentsFromEnrolments(student.id, enrolments);
  const inst = studentInsts.find(i => i.name === lesson.instrument)
    || studentInsts.find(i => !i.isGroup);
  return inst?.teacherId || lesson.teacherId || null;
};

// Returns true if the lesson's instrument has no assigned teacher in current student data.
// Cluster 6b1: override-first via (weekKey, bucket_id) when WTT context provided.
// Cluster 5a: lane-first — if a lane resolves a teacher, the lesson is assigned.
export const isLessonUnassigned = (lesson, students, enrolments, teacherCoverage, laneOverrides = null, weekKey = null) => {
  if (!lesson) return false;
  const laneTid = getCardTeacherId(lesson, teacherCoverage, laneOverrides, weekKey);
  if (laneTid) return false;
  if (lesson.isGroup || lesson.isBandSession) return false;
  const student = students.find(s => s.id === lesson.studentId);
  if (!student) return false;
  const studentInsts = instrumentsFromEnrolments(student.id, enrolments);
  const inst = studentInsts.find(i => i.name === lesson.instrument)
    || studentInsts.find(i => !i.isGroup);
  return inst ? !inst.teacherId : false;
};

// ── Colour helpers ────────────────────────────────────────────────────────────

// ── Instrument colour overrides (user-customised, synced to Supabase) ────

let _instColorOverrides = null;

const _loadInstColorOverrides = () => {
  if (_instColorOverrides !== null) return _instColorOverrides;
  try { _instColorOverrides = JSON.parse(localStorage.getItem("mt-instrument-colors") || "{}"); }
  catch { _instColorOverrides = {}; }
  return _instColorOverrides;
};

// Called by SettingsManager whenever the user changes or resets an instrument colour.
// Updates the in-memory cache, persists to localStorage, AND syncs to Supabase.
export const setInstColorOverrides = (map) => {
  _instColorOverrides = { ...map };
  try { localStorage.setItem("mt-instrument-colors", JSON.stringify(map)); } catch {}
  // Fire-and-forget Supabase upsert
  supabase.from("app_settings")
    .upsert({ key: "instrument_colors", value: map }, { onConflict: "key" })
    .then(({ error }) => { if (error) console.warn("[sync] instrument colours save failed:", error.message); });
};

// Load instrument colours from Supabase (called once on app mount).
// Falls back to localStorage if Supabase is unavailable.
export const loadInstColorsFromSupabase = async () => {
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "instrument_colors")
      .maybeSingle();
    if (error) throw error;
    if (data?.value && typeof data.value === "object") {
      _instColorOverrides = data.value;
      try { localStorage.setItem("mt-instrument-colors", JSON.stringify(data.value)); } catch {}
      return data.value;
    }
  } catch (err) {
    console.warn("[sync] instrument colours load failed, using localStorage:", err.message);
  }
  // Fall back to localStorage
  return _loadInstColorOverrides();
};

export const getInstColor = (inst, isGroup) => {
  if (isGroup) return instruments_colors.Group;
  const overrides = _loadInstColorOverrides();
  return overrides[inst] || instruments_colors[inst] || instruments_colors.default;
};

// ── Name / school helpers ─────────────────────────────────────────────────────

export function getInitials(name) {
  return (name || "").split(" ").map(w => w[0] || "").join("").toUpperCase();
}

export function getSchoolAcronym(school) {
  if (!school) return "";
  if (school.acronym && school.acronym.trim()) return school.acronym.trim().toUpperCase();
  const n = school.name || "";
  return n.split(" ").filter(w => w.length > 0).map(w => w[0].toUpperCase()).join("");
}

// ── Email plumbing helpers ────────────────────────────────────────────────────

// Get parent email addresses from a student record
export const getParentEmails = (student) => {
  if (!student) return [];
  return (student.parents || []).map(p => (p.email || "").trim()).filter(Boolean);
};

// Find the classroom teacher contact for a student (matched by schoolId + className)
export const getClassTeacher = (student, contacts) => {
  if (!student || !student.className || !contacts) return null;
  return contacts.find(c =>
    c.role === "Classroom Teacher" &&
    c.schoolId === student.schoolId &&
    (c.className || "").trim().toLowerCase() === (student.className || "").trim().toLowerCase()
  ) || null;
};

// Open the in-app email compose modal.
// Falls back to Gmail web URL if Electron API not available.
export const openCompose = (emails, { subject = "", from = "", body = "", triggerId = null, mergeCtx = null, attachments = null, bccGroup = false, forceTo = false, threadMessages = null } = {}) => {
  if (!emails || emails.length === 0) return;
  const unique = [...new Set(emails.filter(Boolean))];
  if (unique.length === 0) return;
  if (window._openComposeModal) {
    window._openComposeModal({ to: unique, from, subject, body, triggerId, mergeCtx, attachments, bccGroup, forceTo, threadMessages });
  } else {
    let url = "https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(unique.join(","));
    if (subject) url += "&su=" + encodeURIComponent(subject);
    if (body) url += "&body=" + encodeURIComponent(body);
    if (from) url += "&from=" + encodeURIComponent(from);
    window.open(url, "_blank");
  }
};

// Open individual Gmail compose windows for each email in sequence (300ms apart).
export const openGmailSequential = (emails, { subject = "", from = "", triggerId = null, mergeCtx = null, attachments = null } = {}) => {
  const unique = [...new Set(emails.filter(Boolean))];
  if (unique.length === 0) return;
  const items = unique.map(email => ({ to: [email], subject, from, triggerId, mergeCtx, attachments }));
  if (window._openComposeQueue) {
    window._openComposeQueue(items);
  } else {
    setTimeout(() => {
      if (window._openComposeQueue) {
        window._openComposeQueue(items);
      } else {
        unique.forEach((email, i) => {
          setTimeout(() => {
            let url = "https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(email);
            if (subject) url += "&su=" + encodeURIComponent(subject);
            if (from) url += "&from=" + encodeURIComponent(from);
            window.open(url, "_blank");
          }, i * 300);
        });
      }
    }, 100);
  }
};

// Get students affected by an interruption, with primary parent info
export function getInterruptionAffectedStudents(intr, students) {
  return students.filter(s => {
    if (s.status !== "active") return false;
    if (s.schoolId !== intr.schoolId) return false;
    if (!intr.affectsClasses || intr.affectsClasses === "all") return true;
    const classes = intr.affectsClasses.split(",").map(c => c.trim().toLowerCase());
    return classes.includes((s.className || "").trim().toLowerCase());
  }).map(s => ({
    studentId: s.id, studentName: s.name,
    parentName: s.parents?.[0]?.name || "", parentEmail: s.parents?.[0]?.email || "",
  }));
}

// Format a list of sibling students into natural possessive text.
// Same count → "Lola and Winnie's missed lessons"
// Different counts → "Lola's 2 and Winnie's missed lessons"
export function formatSiblingMissedText(students) {
  if (!students || students.length === 0) return "missed lesson";
  if (students.length === 1) {
    const s = students[0];
    const n = s.count || 1;
    return `${(s.studentName || "").split(" ")[0]}'s ${n === 1 ? "missed lesson" : `${n} missed lessons`}`;
  }
  const allSameCount = students.every(s => (s.count || 1) === (students[0].count || 1));
  const names = students.map(s => (s.studentName || "").split(" ")[0]);
  const nameStr = names.slice(0, -1).join(", ") + " and " + names.slice(-1);
  if (allSameCount) {
    const n = students[0].count || 1;
    return `${nameStr}'s ${n === 1 ? "missed lessons" : `${n} missed lessons`}`;
  }
  const parts = students.map(s => {
    const n = s.count || 1;
    return n === 1 ? (s.studentName || "").split(" ")[0] : `${(s.studentName || "").split(" ")[0]}'s ${n}`;
  });
  return parts.slice(0, -1).join(", ") + " and " + parts.slice(-1) + " missed lessons";
}

// ── Export / download helpers ─────────────────────────────────────────────────

export function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── School / break grid helpers ───────────────────────────────────────────────

export function getBreaksForSchool(school, teachers, lessons, teacherCoverage) {
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
    var tids = [...new Set(lessons.filter(function(l) { return l.schoolId === school.id; }).map(function(l) { return getCardTeacherId(l, teacherCoverage) || l.teacherId; }))];
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
