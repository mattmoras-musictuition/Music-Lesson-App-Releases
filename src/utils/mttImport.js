// Session 6 / Phase 1 — pure builder for the MTT → WTT import payload.
// Extracted from WeeklyAdjustments.js (importFromMTT) so the Dashboard
// "Import from MTT" button can reuse the exact same logic without flipping
// the WTT view. No side effects: no Supabase calls, no React state mutations,
// no toasts. Caller is responsible for setWeeklyTimetables() and notify().
//
// Behaviour parity with the original (Session 97.1):
//   - whole-week import preserves existing band sessions; wipes missed[]
//   - per-day import preserves band sessions on the target day; only filters
//     missed[] entries whose day matches the target
//   - lessons get freshly-minted IDs (this is intentional — see audit A.5)
//
// Returns null if `mtt` is missing/empty so callers can short-circuit.

import { uid, isPastWeek } from "./helpers";
import { makeEnrolmentResolver, isCardInactiveForWeek } from "./enrolmentActivity";

export function buildMttImportForWeekSchool({
  mtt,
  schoolId,
  weekDates,
  existingEntry = null,
  targetDay = null,
  enrolments = [],
}) {
  if (!mtt || !Array.isArray(mtt.lessons)) return null;

  const weekDateMap = {};
  for (const wd of weekDates) weekDateMap[wd.day] = wd.date;

  // ── Inactive-enrolment guard ──────────────────────────────────────────
  // Importing was enrolment-date-blind, so it copied every master card into
  // the target week regardless of whether that enrolment had started. The
  // tally then read the copied card as a real lesson — and it was billable.
  // Same rule weekly GENERATION has carried since v2.31.0, via the same
  // shared helper, so the two cannot disagree.
  //
  // The past-week test lives here rather than at the callers: the week is
  // derived from the weekDates this function already receives, matching how
  // the generator derives it, so a caller's UI state can never drift from it.
  // Both of this helper's callers can reach a past week, and retroactively
  // dropping cards from an already-delivered week is a different decision
  // that this guard does not take.
  //
  // Fails open throughout: no week key, a past week, empty enrolments, a band
  // session, or a card whose enrolment cannot be resolved all import exactly
  // as they do today.
  const weekKey = (weekDates && weekDates[0] && weekDates[0].date) || "";
  const guardActive = !!weekKey && !isPastWeek(weekKey) && (enrolments || []).length > 0;
  const resolver = guardActive ? makeEnrolmentResolver(enrolments) : null;

  const candidateLessons = mtt.lessons.filter(l =>
    l.schoolId === schoolId && (!targetDay || l.day === targetDay)
  );
  const mttLessons = guardActive
    ? candidateLessons.filter(l => !isCardInactiveForWeek(l, resolver, weekKey))
    : candidateLessons;
  const skippedInactiveCount = candidateLessons.length - mttLessons.length;
  const importedLessons = mttLessons.map(l => ({
    ...l,
    id: uid(),
    weekDate: weekDateMap[l.day],
    adjusted: false,
  }));

  if (targetDay) {
    const otherDays = existingEntry
      ? (existingEntry.lessons || []).filter(l => l.day !== targetDay)
      : [];
    const preservedDayExtras = existingEntry
      ? (existingEntry.lessons || []).filter(l => l.day === targetDay && l.isBandSession)
      : [];
    return {
      entry: {
        lessons: [...otherDays, ...preservedDayExtras, ...importedLessons],
        missed: (existingEntry?.missed || []).filter(m => m.day !== targetDay),
        generatedAt: new Date().toISOString(),
      },
      importedCount: importedLessons.length,
      preservedBandCount: preservedDayExtras.length,
      skippedInactiveCount,
    };
  }

  const preservedExtras = existingEntry
    ? (existingEntry.lessons || []).filter(l => l.isBandSession)
    : [];
  return {
    entry: {
      lessons: [...preservedExtras, ...importedLessons],
      missed: [],
      generatedAt: new Date().toISOString(),
    },
    importedCount: importedLessons.length,
    preservedBandCount: preservedExtras.length,
    skippedInactiveCount,
  };
}
