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
      .filter(e => !newNameSet.has(e.instrument))
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
