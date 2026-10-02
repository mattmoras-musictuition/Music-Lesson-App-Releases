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
// v2.40.1 clean import — `dropBands: true` (every caller passes it) makes the
// import a sweeping reset instead: every band card in scope (the week, or the
// target day) is removed with everything attached to it, as if removed by
// hand. The result then also carries `rowsToDelete` — the removed bands'
// linked catchups rows, for the caller to delete — and, for a day import,
// the removed bands' cards on OTHER days are restored under the usual
// occupied-slot rule (the week import rebuilds every card from the master).
// See planCleanImport (data/bandAbsence.js).
//
// Returns null if `mtt` is missing/empty so callers can short-circuit.

import { uid, isPastWeek } from "./helpers";
import { makeEnrolmentResolver, isCardInactiveForWeek } from "./enrolmentActivity";
import { planCleanImport } from "../data/bandAbsence";
import { withoutLedgeredDuplicates, displaceRegularIntoBands, restoreCardsReporting } from "../data/bandMemberStates";

export function buildMttImportForWeekSchool({
  mtt,
  schoolId,
  weekDates,
  existingEntry = null,
  targetDay = null,
  enrolments = [],
  dropBands = false,
  catchups = [],
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

  if (dropBands) {
    const plan = planCleanImport(existingEntry, catchups, { day: targetDay, weekKey, schoolId });
    // v2.42.1 — a day import keeps the other days' bands, so it must respect
    // their ledgers: a master card whose lesson a kept NEW band already holds
    // is not re-added (no double-book), and any kept band's Regular member
    // whose card is now on the grid but not in its ledger is moved into it.
    const bandResolver = targetDay ? makeEnrolmentResolver(enrolments || []) : null;
    const dayImported = targetDay
      ? withoutLedgeredDuplicates(importedLessons, plan.lessons.filter(l => l.isBandSession), bandResolver)
      : importedLessons;
    // Restore the removed bands' other-day cards under the occupied-slot
    // rule; the ones that can't go back are reported (droppedRestoreCards)
    // for the caller's notice rather than dropped silently.
    const restored = targetDay
      ? restoreCardsReporting([...plan.lessons.filter(l => l.day !== targetDay), ...dayImported], plan.restoreCards)
      : null;
    const lessons = targetDay
      ? displaceRegularIntoBands(restored.lessons, bandResolver)
      : importedLessons;
    return {
      entry: {
        lessons,
        missed: targetDay ? (existingEntry?.missed || []).filter(m => m.day !== targetDay) : [],
        generatedAt: new Date().toISOString(),
      },
      importedCount: dayImported.length,
      droppedRestoreCards: restored ? restored.dropped : [],
      preservedBandCount: 0,
      removedBandCount: plan.removedBandCount,
      rowsToDelete: plan.rowsToDelete,
      skippedInactiveCount,
    };
  }

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

// ── Import confirmation: missed-lesson count line (v2.40.1) ──────────────

/**
 * How many recorded missed entries a clean import of this entry will clear.
 *
 *   Whole week (day null) — every entry: missed[] is wiped and, with every
 *     band removed, no band absence survives the carry-forward.
 *   Day import — that day's ordinary entries, plus any band absence whose
 *     band does not survive (bands on other days keep theirs; a band on the
 *     target day is removed, so its absences go, whichever day their card
 *     sits on).
 *
 * @param {Object|null} entry  The week+school entry before import.
 * @param {Object} [opts]
 * @param {string|null} [opts.day]
 * @returns {number}
 */
export function importClearedMissedCount(entry, { day = null } = {}) {
  const missed = (entry && entry.missed) || [];
  if (!day) return missed.length;
  const surviving = new Set(((entry && entry.lessons) || [])
    .filter(l => l && l.isBandSession && l.day !== day).map(l => l.id));
  return missed.filter(m => m && (m.bandLessonId ? !surviving.has(m.bandLessonId) : m.day === day)).length;
}

/**
 * The extra confirmation line, or null when nothing would be cleared.
 *
 * @param {number} n
 * @param {"week"|"day"|"all"} scope
 * @param {string} [day]  For scope "day".
 * @returns {string|null}
 */
export function importMissedLine(n, scope, day) {
  if (!n || n <= 0) return null;
  const what = `${n} missed lesson${n === 1 ? "" : "s"}`;
  if (scope === "day") return `${what} recorded on ${day} will be cleared.`;
  if (scope === "all") return `${what} recorded this week across all schools will be cleared.`;
  return `${what} recorded this week will be cleared.`;
}
