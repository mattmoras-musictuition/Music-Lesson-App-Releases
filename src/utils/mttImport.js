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
import { planCleanImport, carryBandMisses } from "../data/bandAbsence";
import { withoutMarkedCards, withoutBandAbsentCards } from "../data/bandRegularAbsence";
import { withoutLedgeredDuplicates, displaceRegularIntoBands, restoreCardsReporting } from "../data/bandMemberStates";
import { withoutForwardConsumed } from "../data/bandForwardIndex";
import { stampFrozenTeacher } from "./teacherCoverageDB";

export function buildMttImportForWeekSchool({
  mtt,
  schoolId,
  weekDates,
  existingEntry = null,
  targetDay = null,
  enrolments = [],
  dropBands = false,
  catchups = [],
  forwardIndex = null,
  teacherCoverage = null,
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
  const activeLessons = guardActive
    ? candidateLessons.filter(l => !isCardInactiveForWeek(l, resolver, weekKey))
    : candidateLessons;
  const skippedInactiveCount = candidateLessons.length - activeLessons.length;
  // Phase 3 slice 2 — a lesson brought forward into a band in another week
  // is used up: its card is not imported into this week. `forwardIndex` is
  // buildForwardIndex over ALL schools' weekly rows; null → no filter.
  const mttLessons = withoutForwardConsumed(activeLessons, weekKey, forwardIndex);
  const skippedForwardCount = activeLessons.length - mttLessons.length;
  // v2.49.16 — each card the import creates carries the teacher at the time
  // (frozenTeacherId), stamped exactly as Generate stamps. Only these new cards:
  // kept weekly cards and restored band cards are passed through untouched.
  const importedLessons = stampFrozenTeacher(mttLessons.map(l => ({
    ...l,
    id: uid(),
    weekDate: weekDateMap[l.day],
    adjusted: false,
  })), teacherCoverage);

  if (dropBands) {
    const plan = planCleanImport(existingEntry, catchups, { day: targetDay, weekKey, schoolId });
    // v2.42.1 — a day import keeps the other days' bands, so it must respect
    // their ledgers: a master card whose lesson a kept NEW band already holds
    // is not re-added (no double-book), and any kept band's Regular member
    // whose card is now on the grid but not in its ledger is moved into it.
    const bandResolver = targetDay ? makeEnrolmentResolver(enrolments || []) : null;
    // v2.48.0 — nor one a kept band's absence already holds (it would be
    // swept into the band's ledger as a second copy).
    const dayImported = targetDay
      ? withoutBandAbsentCards(withoutLedgeredDuplicates(importedLessons, plan.lessons.filter(l => l.isBandSession), bandResolver),
        [{ lessons: plan.lessons, missed: (existingEntry && existingEntry.missed) || [] }])
      : importedLessons;
    // Restore the removed bands' other-day cards under the occupied-slot
    // rule; the ones that can't go back are reported (droppedRestoreCards)
    // for the caller's notice rather than dropped silently.
    // v2.48.0 — never a lesson a removed band never held (bandNoCard), nor
    // one taken from another school's row (the caller returns it there).
    const restored = targetDay
      ? restoreCardsReporting([...plan.lessons.filter(l => l.day !== targetDay), ...dayImported], withoutMarkedCards(plan.restoreCards))
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
      skippedForwardCount,
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
      skippedForwardCount,
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
    skippedForwardCount,
  };
}

// ── Import all schools (moved out of WeeklyAdjustments in v2.49.16) ──────
// The per-school loop of the Weekly page's "Import all schools", unchanged:
// it has its own shape (originId on every card, no band sessions kept, its
// own inactive-enrolment guard and past-week test) so it does NOT go through
// buildMttImportForWeekSchool. Pure: returns the row updates, the removed
// bands' linked catch-up rows to delete and the skipped-inactive count; the
// caller applies them.
export function buildMttImportAllSchools({ mtt, schools, weekDates, weeklyTimetables, enrolments, catchups, forwardIndex, teacherCoverage = null }) {
  const weekDateMap = {};
  for (const wd of weekDates) weekDateMap[wd.day] = wd.date;
  // Same inactive-enrolment guard weekly generation and the single-school
  // import already apply, via the same shared helper. This path has its own
  // week key, so it does its own past-week test rather than importing one:
  // "Import all schools" is reachable on a PAST week through the per-week
  // Edit unlock, and a past week must import exactly as it does today.
  // Fails open on an empty enrolments list, a band session, or a card whose
  // enrolment cannot be resolved.
  const weekKeyAll = weekDates[0].date;
  const guardAllActive = !!weekKeyAll && !isPastWeek(weekKeyAll) && (enrolments || []).length > 0;
  const resolverAll = guardAllActive ? makeEnrolmentResolver(enrolments) : null;
  let skippedAllCount = 0;
  // v2.40.1 clean import — one batched timetable update for every school,
  // then ONE background delete of every removed band's linked catch-ups
  // (this path always dropped band cards but left those rows orphaned).
  const allUpdates = {};
  const allRowsToDelete = [];
  for (const school of schools) {
    const sk = weekDates[0].date + "|" + school.id;
    allRowsToDelete.push(...planCleanImport(weeklyTimetables[sk] || null, catchups, { weekKey: weekKeyAll, schoolId: school.id }).rowsToDelete);
    const candidateLessons = mtt.lessons.filter(l => l.schoolId === school.id);
    const activeLessons = guardAllActive
      ? candidateLessons.filter(l => !isCardInactiveForWeek(l, resolverAll, weekKeyAll))
      : candidateLessons;
    skippedAllCount += candidateLessons.length - activeLessons.length;
    // Slice 2 — lessons brought forward into a band in another week are used up.
    const mttLessons = withoutForwardConsumed(activeLessons, weekKeyAll, forwardIndex);
    // v2.49.16 — stamped exactly as Generate stamps (see stampFrozenTeacher).
    const importedLessons = stampFrozenTeacher(mttLessons.map(l => ({ ...l, id: uid(), originId: l.id, weekDate: weekDateMap[l.day], adjusted: false })), teacherCoverage);
    // This path keeps no band sessions, so band absences cannot survive it;
    // carryBandMisses drops them with their band.
    const importedMissed = carryBandMisses([], (weeklyTimetables[sk] || {}).missed, importedLessons);
    allUpdates[sk] = { lessons: importedLessons, missed: importedMissed, generatedAt: new Date().toISOString() };
  }
  return { allUpdates, allRowsToDelete, skippedAllCount };
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
