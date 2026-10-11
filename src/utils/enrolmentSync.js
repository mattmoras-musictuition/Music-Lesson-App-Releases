// ============================================================
// enrolmentSync.js — Mirror student.instruments[] writes into
// the enrolments collection for AI-tool callers (add_student,
// edit_student).
//
// The form-driven path in pages/StudentsManager.js does a full
// slice replacement based on a form-tracked formEnrolments copy.
// AI tools have no form — they write instruments[] directly via
// setStudents and need this helper to keep enrolments[] in sync.
//
// Convention matches the four existing form-side new-enrolment
// sites (StudentsManager.js:135, :430, :748, :1286): today's
// date for startDate, fresh uid() for id, isGroup false. Group
// enrolments are not produced by AI tools — those flow through
// the StudentsManager UI only.
//
// Removed instruments get a silent endDate stamp (refinement D —
// endDate is permanent; drop-and-resume creates a new row, not a
// resurrected one).
//
// Group enrolments are never ended here, whatever the instrument list
// says: ending one member's group enrolment made Generate and Import drop
// the whole group card for every member. Group lessons change through
// Groups or Archive; groupLessonsUnchangedNote lets the assistant say so.
// ============================================================

import { uid } from "./helpers";

export function syncEnrolmentsFromInstruments({
  studentId,
  newInstruments,
  enrolments,
  todayDate,
  generateId = uid,
}) {
  const current = enrolments || [];
  const newNames = (newInstruments || []).map(i =>
    typeof i === "string" ? i : i.name
  );
  const newNameSet = new Set(newNames);

  const activeForStudent = current.filter(
    e => e.studentId === studentId && !e.endDate
  );
  const activeNameSet = new Set(activeForStudent.map(e => e.instrument));

  const toAdd = newNames.filter(n => !activeNameSet.has(n));
  const toEndIds = new Set(
    activeForStudent
      .filter(e => !e.isGroup && !newNameSet.has(e.instrument))
      .map(e => e.id)
  );

  // Idempotent: no diff means same reference returned, so React
  // setEnrolments(prev => helper(...)) is a no-op when nothing changed.
  if (toAdd.length === 0 && toEndIds.size === 0) return current;

  const ended = current.map(e =>
    toEndIds.has(e.id) ? { ...e, endDate: todayDate } : e
  );

  const additions = toAdd.map(name => ({
    id: generateId(),
    studentId,
    instrument: name,
    isGroup: false,
    groupId: undefined,
    startDate: todayDate,
    endDate: undefined,
  }));

  return [...ended, ...additions];
}

// The sentence the assistant's edit_student result ends with when the new
// instrument list left out one of the student's active group enrolments —
// the ones syncEnrolmentsFromInstruments deliberately did not end. Empty
// string otherwise.
export function groupLessonsUnchangedNote({ studentId, newInstruments, enrolments }) {
  const newNameSet = new Set((newInstruments || []).map(i => (typeof i === "string" ? i : i.name)));
  const kept = (enrolments || []).filter(e =>
    e.studentId === studentId && !e.endDate && e.isGroup && !newNameSet.has(e.instrument)
  );
  if (kept.length === 0) return "";
  return ` Group lessons were not changed (still enrolled in group ${kept.map(e => e.instrument).join(", ")}) — `
    + "to change a child's group lessons, use Students › Groups, or Archive if they are leaving.";
}
