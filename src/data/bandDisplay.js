// ============================================================
// bandDisplay.js — pure builders for what a band card and its hover popover
// show about members (cluster 6b). Moved VERBATIM out of WeeklyAdjustments
// (cardDisplayById, the drag-hover overlay, buildPopoverInfo) so smoke tests
// can pin them. Each takes the member LIST to show — the caller decides
// whether that is the roster (legacy) or the session's members.
// ============================================================

import { timeToMin } from "../utils/helpers";

/**
 * The band card's member subline: first name (plus surname initial when two
 * listed members share a first name), with the band instrument in brackets.
 * Members whose student can't be found are skipped.
 *
 * @param {Array<{studentId, instrument}>} memberList
 * @param {Array} students
 * @returns {string[]}
 */
export function bandCardMemberNames(memberList, students) {
  const bandMembers = memberList || [];
  const resolvedStudents = bandMembers.map(m => students.find(st => st.id === m.studentId));
  return bandMembers.map((m, mi) => {
    const s = resolvedStudents[mi];
    if (!s) return null;
    // Inline name logic: first name, add surname initial if duplicate first name
    const first = (s.name || "").split(" ")[0];
    const hasDupe = resolvedStudents.some((os, oi) => oi !== mi && os && (os.name || "").split(" ")[0] === first);
    const parts = (s.name || "").split(" ");
    const displayName = hasDupe && parts.length > 1 ? `${first} ${parts[1][0]}.` : first;
    return displayName + (m.instrument ? ` (${m.instrument})` : "");
  }).filter(Boolean);
}

/**
 * Specialist classes that overlap the slot for any listed member, e.g.
 * "Art (Amy)". Used by the band card and by the drag-hover overlay.
 *
 * @param {Array<{studentId}>} memberList
 * @param {Array} students
 * @param {Object} specLookupRef  { "school|class|day": [{start, end, subject}] } (minutes)
 * @param {string} schoolId
 * @param {string} day
 * @param {Object|null} slot      The school slot ({start, end}); none → [].
 * @returns {string[]}
 */
export function bandSpecialistTags(memberList, students, specLookupRef, schoolId, day, slot) {
  if (!slot) return [];
  const sS = timeToMin(slot.start), sE = timeToMin(slot.end || slot.start);
  const specSet = new Set();
  for (const m of (memberList || [])) {
    const ms = students.find(s => s.id === m.studentId);
    if (!ms?.className) continue;
    const mSpecs = (specLookupRef[schoolId + "|" + ms.className + "|" + day] || []).filter(sp => sS < sp.end && sE > sp.start);
    mSpecs.forEach(sp => specSet.add((sp.subject || "Specialist") + " (" + ms.name.split(" ")[0] + ")"));
  }
  return [...specSet];
}

/**
 * Popover member rows: preferred display name, band instrument, class and
 * class teacher. Members whose student can't be found are skipped.
 *
 * @param {Array<{studentId, instrument}>} memberList
 * @param {Array} students
 * @param {Object} fns
 * @param {Function} fns.displayName       name → preferred display name.
 * @param {Function} fns.classTeacherName  student → class teacher's name or "".
 * @returns {Array<{name, instrument, className, classTeacher}>}
 */
export function bandPopoverMembers(memberList, students, { displayName, classTeacherName }) {
  return (memberList || []).map(m => {
    const st = students.find(s => s.id === m.studentId);
    if (!st) return null;
    return {
      name: displayName(st.name),
      instrument: m.instrument || "",
      className: st.className || st.class_name || "",
      classTeacher: classTeacherName(st),
    };
  }).filter(Boolean);
}
