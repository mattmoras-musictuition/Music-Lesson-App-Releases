// ============================================================
// bandForwardAbsence.js — marking a "Lesson brought forward" member absent
// from the band (Band Session Attribution phase 3, refinement 1).
// Pure: no React, no I/O, no clock reads (the caller passes `at`).
//
// bandAbsence.js, bandSessionView.js and bandMemberStates.js are held
// verbatim by the teacher app and never change. Their gate (eligibleForAbsence,
// ABSENCE_CAPABLE) leaves forward out, so the admin side wraps them here:
// every admin caller asks this module, which returns their answer plus the
// forward subjects.
//
// A forward SUBJECT is one solo enrolment or one whole group (forwardSubjects
// in bandForward.js). It is absent when its entries carry attended:false;
// the reason sits on `absence`, exactly as a catch-up member's does. Nothing
// is ever written to catchups or missed[] for it:
//   • catch-up owed  — the later week is given back (forwardConsumes is
//                      false), and the caller puts the lesson back there;
//   • no catch-up    — the later week stays used up; the Tally shows the
//                      red X in it.
// consumedWeekKey and forwardCard are never touched by an absence, so undo
// can take the same week again exactly as before.
// ============================================================

import { eligibleForAbsence, absentMembers, absentEnrolmentIds, memberAbsenceInfo, absenceMenuLabel } from "./bandAbsence";
import { hasMemberStates, CONSUMPTION } from "./bandMemberStates";
import { forwardSubjects, consumeForwardWeeks } from "./bandForward";
import { forwardConsumes } from "./bandForwardIndex";
import { sessionMemberRows, bandCardStatus, parentEmailStudentIds, SESSION_STATUS } from "./bandSessionView";
import { orderByGroup, studentNamesFor } from "../utils/bandsSync";

/** True if a memberStates entry is a forward entry marked absent. */
export function isForwardAbsent(entry) {
  return !!entry && entry.consumption === CONSUMPTION.forward && entry.attended === false;
}

function subjectsOf(band) {
  return hasMemberStates(band) ? forwardSubjects(band.memberStates) : [];
}

function subjectAbsent(subject) {
  return subject.entries.some(isForwardAbsent);
}

/** The band's forward subject with this key ("enrolment:<id>" / "group:<id>"), or null. */
export function findForwardSubject(band, subjectKey) {
  return subjectsOf(band).find(s => s.key === subjectKey) || null;
}

/** Forward subjects that may be marked absent now: holding a week, not absent. */
export function forwardAbsenceSubjects(band) {
  return subjectsOf(band).filter(s => !!s.consumedWeekKey && !subjectAbsent(s));
}

/** Forward subjects recorded absent. */
export function forwardAbsentSubjects(band) {
  return subjectsOf(band).filter(subjectAbsent);
}

// One "Mark absent ▸" / "Undo absence ▸" item. Non-forward items carry the
// entry bandAbsence offered; forward items stand for a whole subject.
function entryItem(e) {
  return { key: e.enrolmentId, forward: false, subjectKey: null, enrolmentId: e.enrolmentId, groupId: null, studentIds: [e.studentId], entry: e };
}
function subjectItem(s) {
  return {
    key: "fwd:" + s.key, forward: true, subjectKey: s.key, enrolmentId: s.enrolmentId, groupId: s.groupId,
    studentIds: [...new Set(s.entries.map(e => e.studentId).filter(Boolean))], entry: s.entries[0],
  };
}

/**
 * The band card's absence submenus, admin side: bandAbsence's eligible and
 * absent members (unchanged, in their order) followed by the forward
 * subjects — a group as ONE item.
 *
 * @param {Object} band
 * @param {Array} missed  The band week's missed[].
 * @returns {{eligible: Array, absent: Array}}
 */
export function adminAbsenceMenu(band, missed) {
  if (!hasMemberStates(band)) return { eligible: [], absent: [] };
  return {
    eligible: [...eligibleForAbsence(band, missed).map(entryItem), ...forwardAbsenceSubjects(band).map(subjectItem)],
    absent: [...absentMembers(band, missed).map(entryItem), ...forwardAbsentSubjects(band).map(subjectItem)],
  };
}

/**
 * Menu label for an item: a group by its members' full names in the group's
 * own order; anyone else as bandAbsence labels them.
 *
 * @param {Object} band
 * @param {Object} item     From adminAbsenceMenu.
 * @param {Array} students
 * @param {Array} groups
 */
export function absenceItemLabel(band, item, students, groups) {
  if (item.groupId) {
    const group = (groups || []).find(g => g && g.id === item.groupId) || null;
    return studentNamesFor(orderByGroup(item.studentIds, group), students).join(", ") || "Group";
  }
  return absenceMenuLabel(band, item.entry, students);
}

/** absentEnrolmentIds plus every forward-absent entry — the window's lock set. */
export function adminAbsentEnrolmentIds(band, missed) {
  const ids = absentEnrolmentIds(band, missed);
  if (hasMemberStates(band)) for (const e of band.memberStates) if (isForwardAbsent(e)) ids.add(e.enrolmentId);
  return ids;
}

/** memberAbsenceInfo, plus the reason of a forward-absent entry. */
export function adminMemberAbsenceInfo(band, entry, missed) {
  if (isForwardAbsent(entry)) {
    return { reason: (entry.absence && entry.absence.reason) || null, reasonDetail: (entry.absence && entry.absence.reasonDetail) || "" };
  }
  return memberAbsenceInfo(band, entry, missed);
}

// memberStates with every entry of `subject` replaced by fn(entry).
function mapSubject(memberStates, subject, fn) {
  const ids = new Set(subject.entries.map(e => e.enrolmentId));
  return (memberStates || []).map(e => (e && ids.has(e.enrolmentId) ? fn(e) : e));
}

// An admin absence action owns the entry from now on (bandAttendance's
// stampAdminOverride, applied to every entry of the subject).
const stamped = (e, at) => ({ ...e, adminOverrideAt: at, writerTeacherId: null });

/**
 * Record a forward subject's absence once the reason prompt saves.
 * Every entry of the subject gets attended:false and the same `absence`,
 * and is stamped. With catch-up owed the later week is returned in
 * `released` for the caller to give back (releaseForwardWeeks input); with
 * no catch-up nothing is released. Returns null when the subject is not
 * there or is already absent.
 *
 * @param {Object} args
 * @param {Object} args.band
 * @param {string} args.subjectKey
 * @param {{reason, reasonDetail, notes, makeupEligible}} args.absence
 * @param {string} args.at  ISO timestamp.
 * @returns {{band: Object, released: Array<{subject, weekKey, snapshot}>}|null}
 */
export function applyForwardAbsence({ band, subjectKey, absence, at } = {}) {
  const subject = findForwardSubject(band, subjectKey);
  if (!subject || !subject.consumedWeekKey || subjectAbsent(subject)) return null;
  const abs = {
    reason: (absence && absence.reason) || "other",
    reasonDetail: (absence && absence.reasonDetail) || "",
    notes: (absence && absence.notes) || "",
    makeupEligible: !!absence && absence.makeupEligible === true,
  };
  const memberStates = mapSubject(band.memberStates, subject, e => stamped({ ...e, attended: false, absence: abs }, at));
  const released = abs.makeupEligible
    ? [{ subject, weekKey: subject.consumedWeekKey, snapshot: subject.forwardCard || null }]
    : [];
  return { band: { ...band, memberStates }, released };
}

/**
 * Plan undoing a forward subject's absence.
 *
 *   restore — the week is still open for the subject (weekStillOpen): the
 *             absence is cleared and the week used up again — its card comes
 *             out of that week (consumeForwardWeeks, for THIS subject only)
 *             and is snapshotted as before. `rows` are the row updates.
 *   reset   — the week can no longer be used (a miss there, holiday, ended
 *             enrolment…): the subject goes back to Not set, as the catch-up
 *             undo does. If the week was still used up (no catch-up), it is
 *             returned in `released` for the caller to give back.
 *
 * @param {Object} args
 * @param {Object} args.band
 * @param {string} args.subjectKey
 * @param {Object} args.weeklyTimetables
 * @param {Function} [args.weekStillOpen]  (subject) → boolean; omitted → open.
 * @param {string} args.at  ISO timestamp.
 * @returns {{kind: "restore"|"reset", band: Object, rows: Object, released: Array}|null}
 */
export function planForwardUndo({ band, subjectKey, weeklyTimetables, weekStillOpen, at } = {}) {
  const subject = findForwardSubject(band, subjectKey);
  if (!subject || !subjectAbsent(subject)) return null;
  const wasConsuming = forwardConsumes(subject.entries[0]);
  const open = !!subject.consumedWeekKey && (!weekStillOpen || weekStillOpen(subject));

  if (open) {
    const cleared = mapSubject(band.memberStates, subject, e => {
      const { absence, ...rest } = e;
      return stamped({ ...rest, attended: null }, at);
    });
    const ids = new Set(subject.entries.map(e => e.enrolmentId));
    const consumed = consumeForwardWeeks(weeklyTimetables, cleared.filter(e => e && ids.has(e.enrolmentId)));
    const byId = new Map(consumed.memberStates.map(e => [e.enrolmentId, e]));
    const memberStates = cleared.map(e => (e && byId.has(e.enrolmentId) ? byId.get(e.enrolmentId) : e));
    return { kind: "restore", band: { ...band, memberStates }, rows: consumed.rows, released: [] };
  }

  const memberStates = mapSubject(band.memberStates, subject, e => {
    const { absence, forwardCard, ...rest } = e;
    return stamped({ ...rest, consumption: null, catchupId: null, consumedWeekKey: null, attended: null }, at);
  });
  const released = wasConsuming && subject.consumedWeekKey
    ? [{ subject, weekKey: subject.consumedWeekKey, snapshot: subject.forwardCard || null }]
    : [];
  return { kind: "reset", band: { ...band, memberStates }, rows: {}, released };
}

// ── Band card display (refinement 1) ────────────────────────────────────
//
// The protected session view reads a forward attended:false member as
// attending. These wrappers re-label them absent for every admin surface:
// the card's names and "N absent", the hover popover and band parent emails.

/**
 * sessionMemberRows, with brought-forward absentees as absent (reason from
 * their absence). Every other row is exactly as the protected view gives it.
 *
 * @param {Object} band
 * @param {Array} missed  The band week's missed[].
 */
export function adminSessionMemberRows(band, missed) {
  const rows = sessionMemberRows(band, missed);
  if (!hasMemberStates(band)) return rows;
  const fwdAbsent = new Map();
  for (const e of band.memberStates) if (isForwardAbsent(e) && e.studentId && !fwdAbsent.has(e.studentId)) fwdAbsent.set(e.studentId, e);
  if (fwdAbsent.size === 0) return rows;
  return rows.map(r => {
    const e = fwdAbsent.get(r.studentId);
    if (!e || r.status !== SESSION_STATUS.attending) return r;
    return { ...r, status: SESSION_STATUS.absent, absenceReason: (e.absence && e.absence.reason) || null, absenceReasonDetail: (e.absence && e.absence.reasonDetail) || "" };
  });
}

/** sessionMembers over adminSessionMemberRows: attending plus unattributed. */
export function adminSessionMembers(band, missed) {
  return adminSessionMemberRows(band, missed).filter(r =>
    r.status === SESSION_STATUS.attending || r.status === SESSION_STATUS.unattributed);
}

/** bandCardStatus with "N absent" counting brought-forward absentees too. */
export function adminBandCardStatus(band, missed) {
  const base = bandCardStatus(band, missed);
  if (!hasMemberStates(band)) return base;
  return { ...base, absentN: adminSessionMemberRows(band, missed).filter(r => r.status === SESSION_STATUS.absent).length };
}

/** parentEmailStudentIds, leaving brought-forward absentees out of a band. */
export function adminParentEmailStudentIds(lesson, missed) {
  if (lesson && lesson.isBandSession) return adminSessionMembers(lesson, missed).map(r => r.studentId).filter(Boolean);
  return parentEmailStudentIds(lesson, missed);
}
