// ============================================================
// bandAttendance.js — teacher-recorded band attendance, admin side
// (Band Session Attribution phase 2, v2.42.0). Pure: no React, no I/O,
// no clock reads (the caller passes `at`).
//
// Teachers record absences on their band copy; drain v3 (supabase/sql/
// drain_teacher_actuals_v3.sql) writes them onto the admin band card in the
// same shapes as an admin absence, plus bookkeeping on the member entry:
//   writerTeacherId   — set when a teacher stamp was applied: the absence
//                       (or the clear) is teacher-owned;
//   teacherWrittenAt  — writtenAt of the last teacher stamp applied;
//   adminOverrideAt   — set by EVERY admin absence action on the member.
// The drain skips any stamp not newer than both timestamps, and never
// overrides an admin-owned absence (attended:false, or a band miss, with no
// writerTeacherId). So an admin action also clears writerTeacherId: the
// state it leaves is the admin's, and a later teacher clear can't undo an
// owed-on confirmation (which would leave a catch-up member with no row).
//
// Kept apart from bandAbsence.js so its planners — and their tests — stay
// exactly as they were; the handlers stamp the planners' output.
// ============================================================

import { hasMemberStates, CONSUMPTION } from "./bandMemberStates";
import { applyCatchupAbsence } from "./bandAbsence";

/**
 * The band with one member entry marked as touched by an admin absence
 * action: adminOverrideAt = at, writerTeacherId = null. Every other field is
 * kept. A band without memberStates, or without that entry, is returned
 * unchanged.
 *
 * @param {Object} band
 * @param {string} enrolmentId
 * @param {string} at   ISO timestamp.
 * @returns {Object}
 */
export function stampAdminOverride(band, enrolmentId, at) {
  if (!hasMemberStates(band)) return band;
  if (!band.memberStates.some(e => e && e.enrolmentId === enrolmentId)) return band;
  return {
    ...band,
    memberStates: band.memberStates.map(e => (e && e.enrolmentId === enrolmentId
      ? { ...e, adminOverrideAt: at, writerTeacherId: null }
      : e)),
  };
}

// ── Catch-up suggestions (teacher suggests catch-up owed) ───────────────
//
// A teacher marking a CATCH-UP member absent can only record a forfeit
// (makeupEligible false — the band-linked row stays). They may add
// absence.suggestOwed: true. The admin then Confirms (the cluster-5 owed-on
// path: the row is deleted, a snapshot kept, the original miss re-opens) or
// Dismisses (stays a forfeit). Either clears suggestOwed.

/**
 * True for an entry carrying a pending suggestion: catch-up, absent,
 * absence.suggestOwed === true.
 */
export function isPendingSuggestion(entry) {
  return !!(entry && entry.consumption === CONSUMPTION.catchup && entry.attended === false
    && entry.absence && entry.absence.suggestOwed === true);
}

/**
 * A band's entries with a pending suggestion, in memberStates order. [] for
 * legacy bands.
 */
export function pendingSuggestions(band) {
  if (!hasMemberStates(band)) return [];
  return band.memberStates.filter(isPendingSuggestion);
}

/**
 * Confirm: run the owed-on path (applyCatchupAbsence with makeupEligible
 * true — the linked row, if found, is returned as deleteRow for the caller's
 * no-flash delete; the entry keeps absentCatchupSnapshot and catchupId goes
 * null), then suggestOwed false, and the admin stamp. null when the entry
 * has no pending suggestion.
 *
 * @param {Object} args
 * @param {Object} args.band
 * @param {Object} args.entry
 * @param {Object|null} args.row   The entry's linked catchups row, if found.
 * @param {string} args.at         ISO timestamp.
 * @returns {{band: Object, deleteRow: Object|null}|null}
 */
export function planConfirmSuggestion({ band, entry, row, at } = {}) {
  if (!band || !isPendingSuggestion(entry)) return null;
  const owed = applyCatchupAbsence({ band, entry, absence: { ...entry.absence, makeupEligible: true }, row });
  const memberStates = owed.band.memberStates.map(e => (e && e.enrolmentId === entry.enrolmentId
    ? { ...e, absence: { ...e.absence, suggestOwed: false } }
    : e));
  return { band: stampAdminOverride({ ...owed.band, memberStates }, entry.enrolmentId, at), deleteRow: owed.deleteRow };
}

/**
 * Dismiss: suggestOwed false and the admin stamp; the member stays a
 * forfeit absence (row untouched). null when nothing is pending.
 *
 * @returns {{band: Object}|null}
 */
export function planDismissSuggestion({ band, entry, at } = {}) {
  if (!band || !isPendingSuggestion(entry)) return null;
  const memberStates = band.memberStates.map(e => (e && e.enrolmentId === entry.enrolmentId
    ? { ...e, absence: { ...e.absence, suggestOwed: false } }
    : e));
  return { band: stampAdminOverride({ ...band, memberStates }, entry.enrolmentId, at) };
}
