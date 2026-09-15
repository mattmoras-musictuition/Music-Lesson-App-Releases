/**
 * Per-member attribution state for band sessions.
 *
 * A band session is an entry in weekly_adjustments.lessons carrying
 * `isBandSession: true`, `bandId`, `members[]` and `removedLessons[]`.
 * Historically, placing a band DISPLACED each member's regular lesson
 * card for that week (a guitar-preference heuristic) and recorded the
 * removed cards in `removedLessons` so they could be put back. The
 * v2.9.8 tally matcher ticks members off that ledger.
 *
 * Band Session Attribution replaces displacement-at-placement with
 * per-member attribution: each member's slot in the band is attributed
 * as a regular lesson, a catch-up, a free extra, a forward, or already
 * billed. `memberStates` is where those decisions live.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────
 * The PRESENCE of a memberStates array — `Array.isArray`, not its
 * contents — is the permanent discriminator between a NEW band and a
 * LEGACY one. An EMPTY array still means "new". The tally matches new
 * bands on memberStates and leaves legacy bands on the v2.9.8
 * removedLessons matcher, so past terms do not move.
 *
 * Therefore: NEVER add memberStates to a band session that already
 * exists without one. Not on regenerate, not on move, not on load, not
 * on stage or unstage, and not as an empty array. Stamp it ONLY where a
 * band session first comes into being, and CARRY it everywhere else —
 * conditionally, so a legacy band passing through a hand-picking carry
 * site never acquires the field. Retrofitting it onto a legacy band
 * silently rewrites history in a finished term.
 * ────────────────────────────────────────────────────────────────────
 *
 * This module is pure — no React, no Supabase, no I/O. Its only side
 * effect is a development-mode console warning for a member whose
 * enrolment cannot be resolved, mirroring the catch-up picker's
 * unresolvable-candidate warning.
 *
 * Band Session Attribution phase 1 cluster 2 — see spec §4.1.
 */

import { pickEnrolment } from "../utils/enrolmentPreference";
import { makeEnrolmentResolver, isCardInactiveForWeek } from "../utils/enrolmentActivity";

/**
 * How a band member's slot is accounted for. Frozen so a typo in a
 * consumer throws in strict mode rather than silently reading undefined.
 *
 * @type {Readonly<{regular: string, catchup: string, free: string, forward: string, billed: string}>}
 */
export const CONSUMPTION = Object.freeze({
  regular: "regular",
  catchup: "catchup",
  free: "free",
  forward: "forward",
  billed: "billed",
});

/**
 * One band member's attribution, keyed by enrolment rather than by
 * member: a student holding guitar AND piano enrolments gets two
 * entries, because each enrolment is billed and tallied separately.
 *
 * Every field except the three identity fields is null until the
 * attribution UI writes it — an unattributed entry is the initial
 * state, not a malformed one.
 *
 * @typedef {Object} MemberState
 * @property {string} enrolmentId   enrolments.id — the entry's identity.
 *                                  Unique within one memberStates array.
 * @property {string} studentId     students.id, taken from the RESOLVED
 *                                  enrolment, not from members[].
 * @property {string} instrument    Instrument, taken from the RESOLVED
 *                                  enrolment, not from members[].
 * @property {string|null} consumption      One of CONSUMPTION; null ⇒
 *                                  not yet attributed.
 * @property {string|null} catchupId        catchups.id of the row this
 *                                  attribution created, when
 *                                  consumption is "catchup". That row
 *                                  carries band_lesson_id back to this
 *                                  band card. null otherwise.
 * @property {string|null} consumedWeekKey  Monday (YYYY-MM-DD) of the
 *                                  week whose lesson this slot consumed,
 *                                  for forward/catch-up attribution.
 * @property {number|null} fee      Fee override in dollars; null ⇒ the
 *                                  enrolment's own rate applies.
 * @property {boolean|null} attended  Attendance, once recorded. null ⇒
 *                                  not yet marked.
 * @property {string|null} writerTeacherId  teachers.id of whoever last
 *                                  wrote this entry.
 */

/**
 * True iff `lesson` is a band session carrying a memberStates array.
 *
 * This is THE new-vs-legacy test. It checks presence only: an empty
 * array returns true, because an empty array is a new band all of whose
 * members failed to resolve, not a legacy one. Use it to gate anything
 * that must behave differently for new bands — displacement, the tally
 * matcher — and never as a reason to create the field.
 *
 * @param {Object|null|undefined} lesson  A weekly-timetable lesson entry.
 * @returns {boolean}
 */
export function hasMemberStates(lesson) {
  return !!(lesson && lesson.isBandSession && Array.isArray(lesson.memberStates));
}

/**
 * Build the initial memberStates array for a band session being created.
 *
 * One entry per ENROLMENT, not per member. For each distinct member
 * studentId, that student's solo enrolments active in `weekKey` are
 * grouped by instrument and one enrolment per instrument is chosen via
 * pickEnrolment — duplicate enrolments for the same instrument are
 * legitimate by design (v2.34.0), so a bare `find` would pick by array
 * position and could return a row that has ended. A student with guitar
 * and piano therefore yields two entries.
 *
 * Group enrolments are excluded, consistent with the v2.9.8 matcher:
 * a band member participates as an individual.
 *
 * A member with no resolvable active solo enrolment yields NO entry, and
 * warns in development only. Returning a short array is correct — the
 * array's presence, not its length, is what marks the band as new.
 *
 * Order is members[] order, then the order in which instruments first
 * appear among that student's enrolments. Entries are deduped by
 * enrolmentId, so a student listed twice in members[] contributes once.
 *
 * Every entry is written UNATTRIBUTED: consumption and the rest are null.
 *
 * @param {Array<{studentId: string, instrument: string}>|null|undefined} members
 *        The band record's members[].
 * @param {Array|null|undefined} enrolments  The full enrolments collection.
 * @param {string|null|undefined} weekKey    Monday of the band's week,
 *        YYYY-MM-DD. Decides which enrolments count as active.
 * @returns {MemberState[]} A new array; never null.
 */
export function buildMemberStates(members, enrolments, weekKey) {
  const list = enrolments || [];
  const resolver = makeEnrolmentResolver(list);
  const out = [];
  const seenEnrolmentIds = new Set();
  const seenStudentIds = new Set();

  for (const member of (members || [])) {
    const studentId = member && member.studentId;
    if (!studentId || seenStudentIds.has(studentId)) continue;
    seenStudentIds.add(studentId);

    // Group by instrument in first-appearance order, so the resulting
    // entry order is stable for the same enrolments array.
    const byInstrument = new Map();
    for (const e of list) {
      if (!e || e.isGroup || e.studentId !== studentId) continue;
      const inst = e.instrument || "";
      if (!byInstrument.has(inst)) byInstrument.set(inst, []);
      byInstrument.get(inst).push(e);
    }

    let added = 0;
    for (const [inst, candidates] of byInstrument) {
      const enrolment = pickEnrolment(candidates);
      if (!enrolment || seenEnrolmentIds.has(enrolment.id)) continue;
      // Week activity via the shared predicate rather than a re-derived
      // date test, so this agrees with the tally by construction. The
      // probe is a synthetic non-band card: isCardInactiveForWeek exempts
      // band sessions outright, and the enrolmentId fast path in the
      // resolver makes the lookup unambiguous.
      if (isCardInactiveForWeek({ studentId, instrument: inst, enrolmentId: enrolment.id }, resolver, weekKey)) continue;
      seenEnrolmentIds.add(enrolment.id);
      out.push({
        enrolmentId: enrolment.id,
        studentId: enrolment.studentId,
        instrument: enrolment.instrument || "",
        consumption: null,
        catchupId: null,
        consumedWeekKey: null,
        fee: null,
        attended: null,
        writerTeacherId: null,
      });
      added++;
    }

    if (added === 0 && process.env.NODE_ENV !== "production") {
      console.warn("[band memberStates] dropping member — no active solo enrolment", {
        studentId,
        instrument: member && member.instrument,
        weekKey,
      });
    }
  }

  return out;
}
