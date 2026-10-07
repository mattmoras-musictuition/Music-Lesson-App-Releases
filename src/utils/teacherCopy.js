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
