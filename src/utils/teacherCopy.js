// ============================================================
// teacherCopy.js — stale teacher-copy warning (v2.49.3). Pure, no state.
//
// A teacher's Import stores a frozen copy of a day in teacher_actuals. At
// 6pm on (or after) that day the drain replaces that teacher's cards on the
// day with the copy, whatever the admin changed since. The WTT day header
// warns while such a copy is stored, naming the teacher(s).
//
// The "Actuals" pill is pointless once a day has drained: past days, and
// today from 18:00 Melbourne.
// ============================================================

import { groupDisplayName } from "./helpers";
import { getCardTeacherId } from "./teacherCoverageDB";

// { "<Day>": [teacherId, ...] } for teachers whose stored copy for this
// week and school holds any lesson or missed entry on that day. Missed
// entries count: the drain replaces those too.
export function teacherCopyDays(teacherActuals, weekKey, schoolId) {
  const out = {};
  if (!teacherActuals || !weekKey || !schoolId) return out;
  const prefix = `${weekKey}|${schoolId}|`;
  for (const [key, entry] of Object.entries(teacherActuals)) {
    if (!key.startsWith(prefix) || !entry) continue;
    const teacherId = key.substring(prefix.length);
    const days = new Set([...(entry.lessons || []), ...(entry.missed || [])].map(x => x && x.day).filter(Boolean));
    for (const day of days) {
      if (!out[day]) out[day] = [];
      if (!out[day].includes(teacherId)) out[day].push(teacherId);
    }
  }
  return out;
}

// Note shows on today and future days only (dates are 'YYYY-MM-DD').
export function showTeacherCopyNote(dayDateStr, todayStr) {
  return !!dayDateStr && !!todayStr && dayDateStr >= todayStr;
}

// Hide the Actuals pill on drained days: past days, and today from 18:00.
export function actualsPillHidden(dayDateStr, todayStr, melbourneHour) {
  if (!dayDateStr || !todayStr) return false;
  if (dayDateStr < todayStr) return true;
  return dayDateStr === todayStr && melbourneHour >= 18;
}

export function teacherCopyTooltip(teacherIds, teachers) {
  const names = (teacherIds || []).map(id => (teachers || []).find(t => t.id === id)?.name || "Unknown teacher");
  return `Teacher copy stored by ${names.join(", ")}. At 6pm the drain replaces ${names.length === 1 ? "this teacher's" : "these teachers'"} cards on this day with the stored copy, including any changes made here since it was imported.`;
}

// Text of a teacher-copy ghost card on the WTT. student = the live student
// record for a solo ghost (or null); prefName = the screen's preferred-name
// formatter; teacherFirst = lane-derived teacher first name. A band ghost
// shows only its name (as the admin band card does); line2 "" = no line.
export function ghostCardLines(g, { student, prefName, teacherFirst }) {
  if (g.isBandSession) return { line1: g.bandName || "TBC", line2: "" };
  let line1;
  if (g.isGroup) {
    line1 = groupDisplayName(g);
  } else {
    line1 = prefName(student?.name || g.studentName || "");
    if (student?.className) line1 += ` · ${student.className}`;
  }
  const line2 = `${g.instrument || ""}${teacherFirst ? ` · ${teacherFirst}` : ""}`;
  return { line1, line2 };
}

// The teacher a teacher-copy ghost belongs to: (a) its own teacherId (old
// data only); else (b) the teacher of its lane (bucket_id), resolved as
// normal cards are by getCardTeacherId (override-aware) but without the
// day-lane fallback, which would just pick the day's first lane; else (c)
// the copy's writer (writerTeacherId on new copies, or _copyTeacherId = the
// stored copy's teacher key, set when the screen combines copies).
export function ghostTeacherId(g, { teacherCoverage, laneOverrides, weekKey, temporaryLanes } = {}) {
  if (g.teacherId) return g.teacherId;
  if (g.bucket_id) {
    const laneTeacher = getCardTeacherId({ bucket_id: g.bucket_id }, teacherCoverage, laneOverrides, weekKey, temporaryLanes || []);
    if (laneTeacher) return laneTeacher;
  }
  return g.writerTeacherId || g._copyTeacherId || null;
}

// Whether a teacher-copy ghost shows in the WTT cell being drawn. On a day
// with 2+ lanes (isMultiLane) only the viewed chip's teacher's ghosts show;
// viewedTeacherId = that chip's effective teacher (null when unresolved, in
// which case every ghost shows, as on single-lane days). A ghost whose
// teacher cannot be resolved is hidden on multi-lane days.
export function ghostBelongsToView(g, { viewedTeacherId, isMultiLane, teacherCoverage, laneOverrides, weekKey, temporaryLanes }) {
  if (!isMultiLane || !viewedTeacherId) return true;
  return ghostTeacherId(g, { teacherCoverage, laneOverrides, weekKey, temporaryLanes }) === viewedTeacherId;
}

// Day-header copy state for the WTT column being drawn. teacherIds = the
// teachers whose stored copy the orange "Teacher copy stored" line names
// (null = no line); pillAvailable = whether the Actuals pill can be switched
// on for this view (false draws it off and ignores clicks). view is the same
// object the ghost layer passes to ghostBelongsToView.
export function dayCopyStateForView(teacherActuals, weekKey, schoolId, day, view) {
  const teacherIds = teacherCopyDays(teacherActuals, weekKey, schoolId)[day] || null;
  return { teacherIds, pillAvailable: true };
}
