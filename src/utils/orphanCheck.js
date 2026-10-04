// ============================================================
// orphanCheck.js — Settings → Data Health orphan-lesson predicate.
// Pure functions, no side effects, no state.
//
// Extracted from the App.js reconciler (v2.44.0). Two rules:
//
//   MASTER cards keep the original rule: the student must hold a still-running
//   (no endDate) enrolment for the card's instrument. The master timetable is
//   the forward-looking template, so a card for an ended enrolment is a real
//   orphan.
//
//   WEEKLY lessons are history. One is NOT orphaned when any enrolment that
//   matches it — by enrolmentId, or by studentId + instrument (case-
//   insensitive) — was active in the lesson's own week. The old rule asked
//   only "is there a running enrolment?", so every taught week on an ended
//   enrolment was flagged and the only remedy offered was Delete, which
//   erases Tally history.
//
// "Active in the week" is not re-derived here: deriveTallyCell with no WTT
// entry IS the predicate, so Data Health agrees with the Tally's dash by
// construction. Missing startDate = started, missing endDate = running, and
// the week containing the end date is active.
// ============================================================

import { deriveTallyCell } from "./tallyDerive";
import { instrumentsFromEnrolments } from "./enrolmentsDB";

const normalize = (s) => (s || "").trim().toLowerCase();

// `where` is "master" or the weekly storage key "<weekKey>|<schoolId>".
// Returns { reason } for an orphan, or null.
export function checkOrphan(lesson, where, { students, enrolments }) {
  if (!lesson) return null;
  if (lesson.isGroup) return null; // groups carry their own teacherId; skip
  // Bands are stored on weekly timetables with shape { isBandSession,
  // members[], bandName/bandId, removedLessons[] } and intentionally
  // carry NO top-level studentId / studentName / instrument — they
  // aren't single-student lessons. Without this skip the band falls
  // through to the studentId lookup, fails, and surfaces in Settings
  // → Data Health as "(no name) · (no instrument) · student not
  // found". That entry's Delete then wipes the band AND the regular
  // lessons it absorbed (stashed in band.removedLessons), so the
  // mis-flag is destructive, not just cosmetic.
  if (lesson.isBandSession) return null;

  const stu = (students || []).find(s => s.id === lesson.studentId);
  if (!stu) return { reason: "student not found" };

  if (where === "master") {
    const hasMatchingEnrolment = instrumentsFromEnrolments(stu.id, enrolments).some(
      i => normalize(i.name) === normalize(lesson.instrument)
    );
    if (!hasMatchingEnrolment) return { reason: "instrument not in student record" };
    return null;
  }

  const weekKey = String(where || "").split("|")[0];
  const matching = (enrolments || []).filter(e =>
    (lesson.enrolmentId && e.id === lesson.enrolmentId) ||
    (e.studentId === stu.id && normalize(e.instrument) === normalize(lesson.instrument)));
  if (matching.length === 0) return { reason: "instrument not in student record" };
  const activeThatWeek = matching.some(e =>
    deriveTallyCell({ enrolment: e, week: { weekKey }, wttEntry: null }) !== "inactive");
  if (!activeThatWeek) return { reason: "enrolment not active that week" };
  return null;
}
