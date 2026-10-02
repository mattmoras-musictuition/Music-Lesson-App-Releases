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

import { hasMemberStates } from "./bandMemberStates";

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
