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

import { uid } from "./helpers";

export function buildMttImportForWeekSchool({
  mtt,
  schoolId,
  weekDates,
  existingEntry = null,
  targetDay = null,
}) {
  if (!mtt || !Array.isArray(mtt.lessons)) return null;

  const weekDateMap = {};
  for (const wd of weekDates) weekDateMap[wd.day] = wd.date;

  const mttLessons = mtt.lessons.filter(l =>
    l.schoolId === schoolId && (!targetDay || l.day === targetDay)
  );
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
  };
}
