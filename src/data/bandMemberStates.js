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

import { DAYS } from "../constants";
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
      // FILTER THEN PICK, not the other way round. pickEnrolment prefers a
      // live row over an ended one and then the LATEST startDate, so picking
      // first can hand back a row that has not started yet in this week and
      // drop a member who is perfectly active on an older row sitting one
      // index away. Narrowing to the week's active rows first means the
      // preference rule only ever chooses between rows that are genuinely
      // available, which is what it is for.
      //
      // Week activity uses the shared predicate rather than a re-derived date
      // test, so this agrees with the tally by construction. The probe is a
      // synthetic non-band card: isCardInactiveForWeek exempts band sessions
      // outright, and the resolver's enrolmentId fast path makes the lookup
      // unambiguous.
      const active = candidates.filter(
        (e) => !isCardInactiveForWeek({ studentId, instrument: inst, enrolmentId: e.id }, resolver, weekKey)
      );
      const enrolment = pickEnrolment(active);
      if (!enrolment || seenEnrolmentIds.has(enrolment.id)) continue;
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

// ── Attribution helpers (cluster 3a) ────────────────────────────────
//
// ONE CONSUMPTION PER STUDENT. The attribution window shows one row per
// member student, but the data stays per enrolment, because billing and
// the tally are per enrolment. The rule that reconciles the two: at most
// ONE of a student's entries may carry a non-null consumption, and a
// student counts as attributed when one of them does. Every helper below
// upholds that.

/**
 * True if `lesson` is a card that can be attributed to a member entry —
 * an ordinary solo lesson. Band sessions carry no top-level enrolment,
 * merged catch-ups are a render artefact rather than a scheduled card,
 * and group cards belong to a group enrolment which buildMemberStates
 * excludes by design.
 *
 * @param {Object|null|undefined} lesson
 * @returns {boolean}
 */
function isAttributableCard(lesson) {
  return !!(lesson && !lesson.isBandSession && !lesson.__isCatchup && !lesson.isGroup);
}

/**
 * True if `lesson` is the card belonging to `entry`'s enrolment.
 *
 * enrolmentId is the canonical link and is tried first. Cards predating
 * enrolmentId stamping carry only studentId + instrument, so the
 * fallback hands the card to the resolver and compares the enrolment it
 * maps to — rather than string-matching the pair, which would ignore the
 * duplicate-enrolment preference rule and could match a row that ended.
 *
 * @param {Object} lesson
 * @param {MemberState} entry
 * @param {Function|null} resolver  From makeEnrolmentResolver(enrolments).
 * @returns {boolean}
 */
function cardMatchesEntry(lesson, entry, resolver) {
  if (!lesson || !entry || !entry.enrolmentId) return false;
  if (lesson.enrolmentId) return lesson.enrolmentId === entry.enrolmentId;
  const resolved = resolver ? resolver(lesson) : null;
  return !!resolved && resolved.id === entry.enrolmentId;
}

/**
 * Collapse memberStates into one row per student, for the attribution
 * window. Rows come back in memberStates order (first appearance of each
 * studentId); a student's entries keep their relative order.
 *
 * `departed` marks a row whose ATTRIBUTED entry no longer appears in a
 * fresh build — the student has left the band, or that enrolment ended,
 * but the attribution is still standing and the owner should clear it
 * deliberately rather than have it vanish. Departed status is computed
 * from the ids passed in, never stored on the entry.
 *
 * @param {MemberState[]|null|undefined} memberStates
 * @param {Array<string>|Set<string>|null} [departedEnrolmentIds]
 *        From reconcileMemberStates.
 * @returns {Array<{studentId: string, entries: MemberState[],
 *   attributedEntry: MemberState|null, isAttributed: boolean,
 *   hasMultipleInstruments: boolean, departed: boolean}>}
 */
export function studentRows(memberStates, departedEnrolmentIds) {
  const departed = departedEnrolmentIds instanceof Set
    ? departedEnrolmentIds
    : new Set(departedEnrolmentIds || []);
  const byStudent = new Map();
  for (const entry of (memberStates || [])) {
    if (!entry || !entry.studentId) continue;
    if (!byStudent.has(entry.studentId)) byStudent.set(entry.studentId, []);
    byStudent.get(entry.studentId).push(entry);
  }
  const rows = [];
  for (const [studentId, entries] of byStudent) {
    const attributedEntry = entries.find((e) => e.consumption != null) || null;
    rows.push({
      studentId,
      entries,
      attributedEntry,
      isAttributed: !!attributedEntry,
      hasMultipleInstruments: entries.length > 1,
      departed: !!attributedEntry && departed.has(attributedEntry.enrolmentId),
    });
  }
  return rows;
}

/**
 * Attribute ONE of a student's enrolments, returning a new array.
 *
 * The student's other entries are cleared — consumption, catchupId and
 * consumedWeekKey — so the one-consumption-per-student rule holds by
 * construction rather than by the caller remembering it. Passing
 * `consumption` null clears the student entirely, including the target.
 *
 * Never mutates. Never touches another student's entries, and never
 * touches fee, attended or writerTeacherId on any entry — those are
 * owned by other paths and are not part of choosing a consumption.
 *
 * catchupId is deliberately NOT set here: the catchups row does not
 * exist until the save path inserts it. The save path writes the id back.
 *
 * @param {MemberState[]|null|undefined} memberStates
 * @param {string} studentId
 * @param {string} enrolmentId  Which of that student's entries to attribute.
 * @param {string|null} consumption  One of CONSUMPTION, or null to clear.
 * @param {string|null} [consumedWeekKey]
 * @returns {MemberState[]} A new array.
 */
export function applyStudentAttribution(memberStates, studentId, enrolmentId, consumption, consumedWeekKey) {
  return (memberStates || []).map((entry) => {
    if (!entry || entry.studentId !== studentId) return entry;
    const isTarget = entry.enrolmentId === enrolmentId;
    if (isTarget && consumption != null) {
      return { ...entry, consumption, consumedWeekKey: consumedWeekKey != null ? consumedWeekKey : null };
    }
    // Every other entry of this student — and the target itself when
    // clearing — goes back to unattributed.
    if (entry.consumption == null && entry.catchupId == null && entry.consumedWeekKey == null) return entry;
    return { ...entry, consumption: null, catchupId: null, consumedWeekKey: null };
  });
}

/**
 * Position of a day name in the school week, for ordering misses.
 * Reuses the shared DAYS constant rather than defining another order.
 * An unknown day (a weekend, or malformed data) sorts last so it can
 * never masquerade as the oldest miss.
 *
 * @param {string} day
 * @returns {number}
 */
function dayRank(day) {
  const i = DAYS.indexOf(day);
  return i === -1 ? DAYS.length : i;
}

/**
 * Propose a default attribution for every student who has none yet.
 *
 * Per student:
 *   • If any of that student's enrolments has an open miss, default to
 *     "catchup" on the enrolment of the OLDEST open miss across all of
 *     them — week, then day, then time — so the band slot settles the
 *     longest-standing debt first.
 *   • Otherwise default to "regular" on the first-enrolled instrument:
 *     the entry whose enrolment has the earliest startDate, tie-broken
 *     by memberStates order.
 *
 * Students who already have an attributed entry are skipped entirely —
 * a default never overrides a decision the owner has made.
 *
 * Returns proposals only. Nothing is applied; the caller decides, and
 * applies each through applyStudentAttribution.
 *
 * @param {MemberState[]|null|undefined} memberStates
 * @param {{openMisses: Array, enrolments: Array}} ctx
 *        openMisses are picker-shaped candidates carrying enrolmentId,
 *        weekKey, day and start/time.
 * @returns {Array<{studentId: string, enrolmentId: string,
 *   consumption: string, settlesMiss: Object|null}>}
 */
export function defaultAttributions(memberStates, { openMisses, enrolments } = {}) {
  const missList = openMisses || [];
  const enrolmentList = enrolments || [];
  const out = [];

  for (const row of studentRows(memberStates)) {
    if (row.isAttributed) continue;

    const entryIds = new Set(row.entries.map((e) => e.enrolmentId));
    const mine = missList.filter((m) => m && entryIds.has(m.enrolmentId));

    if (mine.length > 0) {
      let oldest = mine[0];
      for (const m of mine) {
        if (compareMisses(m, oldest) < 0) oldest = m;
      }
      out.push({
        studentId: row.studentId,
        enrolmentId: oldest.enrolmentId,
        consumption: CONSUMPTION.catchup,
        settlesMiss: oldest,
      });
      continue;
    }

    // No open miss — first-enrolled instrument. A missing startDate sorts
    // last, so a row carrying a real date always wins; ties keep
    // memberStates order because the scan only replaces on a strict win.
    let best = null;
    let bestStart = null;
    for (const entry of row.entries) {
      const en = enrolmentList.find((e) => e && e.id === entry.enrolmentId);
      const start = (en && en.startDate) || "";
      if (best === null) { best = entry; bestStart = start; continue; }
      const bestMissing = bestStart === "";
      const thisMissing = start === "";
      if (bestMissing && !thisMissing) { best = entry; bestStart = start; continue; }
      if (!bestMissing && !thisMissing && start < bestStart) { best = entry; bestStart = start; }
    }
    if (!best) continue;
    out.push({
      studentId: row.studentId,
      enrolmentId: best.enrolmentId,
      consumption: CONSUMPTION.regular,
      settlesMiss: null,
    });
  }

  return out;
}

/**
 * Order two open misses oldest-first: week, then day, then time.
 * Picker candidates carry `start` with `time` as the fallback.
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
function compareMisses(a, b) {
  const aw = a.weekKey || "";
  const bw = b.weekKey || "";
  if (aw !== bw) return aw < bw ? -1 : 1;
  const ad = dayRank(a.day);
  const bd = dayRank(b.day);
  if (ad !== bd) return ad - bd;
  const at = a.start || a.time || "";
  const bt = b.start || b.time || "";
  if (at !== bt) return at < bt ? -1 : 1;
  return 0;
}

/**
 * Reconcile a stored memberStates array against a fresh build for the
 * band's CURRENT members, for when the attribution window reopens.
 *
 *   • In fresh, not stored  → added, unattributed.
 *   • Stored, unattributed, gone from fresh → dropped silently. Nothing
 *     was decided about it, so nothing is lost.
 *   • Stored, ATTRIBUTED, gone from fresh → KEPT and reported as
 *     departed. A standing attribution may already have created a
 *     catchups row or a fee, so it must not disappear on its own; the
 *     owner clears it deliberately.
 *
 * Output order is stored order, with the new entries appended in fresh
 * order, so the window does not reshuffle under the owner.
 *
 * This never creates the array. A legacy band has no memberStates and
 * must never acquire one — callers gate on hasMemberStates first.
 *
 * @param {MemberState[]|null|undefined} stored
 * @param {MemberState[]|null|undefined} fresh  From buildMemberStates.
 * @returns {{memberStates: MemberState[], departedEnrolmentIds: string[]}}
 */
export function reconcileMemberStates(stored, fresh) {
  const storedList = stored || [];
  const freshList = fresh || [];
  const freshIds = new Set(freshList.map((e) => e && e.enrolmentId));
  const storedIds = new Set(storedList.map((e) => e && e.enrolmentId));

  const memberStates = [];
  const departedEnrolmentIds = [];
  for (const entry of storedList) {
    if (!entry) continue;
    if (freshIds.has(entry.enrolmentId)) { memberStates.push(entry); continue; }
    if (entry.consumption != null) {
      memberStates.push(entry);
      departedEnrolmentIds.push(entry.enrolmentId);
    }
    // else: unattributed and gone — dropped.
  }
  for (const entry of freshList) {
    if (!entry || storedIds.has(entry.enrolmentId)) continue;
    memberStates.push(entry);
  }
  return { memberStates, departedEnrolmentIds };
}

/**
 * Every regular card in `weekLessons` belonging to this entry's
 * enrolment. Normally none or one; more than one means a duplicate the
 * caller should surface rather than silently pick from.
 *
 * @param {Array|null|undefined} weekLessons
 * @param {MemberState} entry
 * @param {Function|null} resolver  From makeEnrolmentResolver(enrolments).
 * @returns {Array} Matching cards, in weekLessons order.
 */
export function findMemberCards(weekLessons, entry, resolver) {
  return (weekLessons || []).filter(
    (l) => isAttributableCard(l) && cardMatchesEntry(l, entry, resolver)
  );
}

/**
 * True if this master-timetable card must NOT be generated into a week,
 * because a band session in that week already accounts for the student.
 *
 * The two band shapes answer differently, and both answers are the point:
 *
 *   • LEGACY band (no memberStates) — the whole student is excluded, as
 *     it has been since v2.9.8. Placement removed their card, so
 *     regeneration must not put it back.
 *   • NEW band — only the cards matching an entry attributed "regular"
 *     are excluded. Everything else generates, because a member
 *     attributed catchup, free, forward or billed is NOT consuming their
 *     regular lesson, and an unattributed member has not consumed
 *     anything yet. This is what makes regeneration agree with
 *     placement, which already displaces nothing for new bands.
 *
 * Shared by all three regenerate sites so they cannot drift apart.
 *
 * @param {Object} masterLesson  A master-timetable card.
 * @param {Array|null|undefined} weekBands  The week's band sessions.
 * @param {Function|null} resolver  From makeEnrolmentResolver(enrolments).
 * @returns {boolean}
 */
export function isExcludedByBands(masterLesson, weekBands, resolver) {
  if (!masterLesson) return false;
  for (const band of (weekBands || [])) {
    if (!band) continue;
    if (!hasMemberStates(band)) {
      // Flat per-student exclusion — identical to the Set membership test
      // this replaced, including for a card carrying no studentId.
      if ((band.members || []).some((m) => m && m.studentId === masterLesson.studentId)) return true;
      continue;
    }
    if (!isAttributableCard(masterLesson)) continue;
    const hit = (band.memberStates || []).some(
      (e) => e && e.consumption === CONSUMPTION.regular && cardMatchesEntry(masterLesson, e, resolver)
    );
    if (hit) return true;
  }
  return false;
}

/**
 * True if the band card's same-day "already has a lesson" warning should
 * be suppressed for this member.
 *
 * It is suppressed only when the band is a NEW band AND the student is
 * attributed "catchup" or "free" — both of which mean the band slot is
 * deliberately EXTRA to their regular lesson, so the regular card
 * standing alongside it is correct, not a clash.
 *
 * It is NOT suppressed for an unattributed student (owner decision — the
 * warning is the prompt to attribute them), nor for one attributed
 * "regular", whose card should have been removed: a surviving card there
 * is a genuine problem and must keep shouting. Legacy bands are
 * untouched.
 *
 * @param {Object} bandLesson
 * @param {string} studentId
 * @returns {boolean}
 */
export function suppressesSameDayClash(bandLesson, studentId) {
  if (!hasMemberStates(bandLesson)) return false;
  const entry = (bandLesson.memberStates || []).find(
    (e) => e && e.studentId === studentId && e.consumption != null
  );
  if (!entry) return false;
  return entry.consumption === CONSUMPTION.catchup || entry.consumption === CONSUMPTION.free;
}

// ── Window + save planning (cluster 3b) ─────────────────────────────

/**
 * The misses a student may choose to settle with this band slot.
 *
 * Their currently-open misses, PLUS the miss their existing linked
 * catch-up already settles. That one is no longer "open" precisely
 * BECAUSE this band closes it, so leaving it out would make the
 * student's own current choice unselectable and silently un-settle it on
 * the next save.
 *
 * Matching is by the four resolves_* coordinates the catch-up carries,
 * so the restored entry is the same miss object shape as the open ones.
 *
 * @param {Array} entries          One student's memberStates entries.
 * @param {Array} openMisses       Picker-shaped candidates (enrolmentId,
 *                                 weekKey, day, start/time).
 * @param {Array} catchupsForBand  Catch-up rows linked to this band.
 * @returns {Array} Selectable misses, open ones first.
 */
export function selectableMissesForStudent(entries, openMisses, catchupsForBand) {
  const ids = new Set((entries || []).map((e) => e && e.enrolmentId));
  const out = (openMisses || []).filter((m) => m && ids.has(m.enrolmentId));
  for (const entry of (entries || [])) {
    if (!entry || !entry.catchupId) continue;
    const row = (catchupsForBand || []).find((c) => c && c.id === entry.catchupId);
    if (!row || !row.resolvesEnrolmentId || !row.resolvesWeekKey) continue;
    const already = out.some(
      (m) => m.enrolmentId === row.resolvesEnrolmentId && m.weekKey === row.resolvesWeekKey
        && m.day === row.resolvesOriginalDay
    );
    if (already) continue;
    out.push({
      enrolmentId: row.resolvesEnrolmentId,
      weekKey: row.resolvesWeekKey,
      day: row.resolvesOriginalDay,
      start: row.resolvesOriginalTime,
      time: row.resolvesOriginalTime,
      studentId: entry.studentId,
      instrument: entry.instrument,
    });
  }
  return out;
}

/**
 * True if `row` (a catchups row) settles `miss`. Compares the four
 * resolves_* coordinates against the miss, tolerating the miss carrying
 * its time as `start` or `time`.
 *
 * @param {Object|null} row
 * @param {Object|null} miss
 * @returns {boolean}
 */
function rowSettlesMiss(row, miss) {
  if (!row || !miss) return false;
  const missTime = miss.start || miss.time || null;
  return row.resolvesEnrolmentId === miss.enrolmentId
    && row.resolvesWeekKey === miss.weekKey
    && row.resolvesOriginalDay === miss.day
    && (row.resolvesOriginalTime || null) === (missTime || null);
}

/**
 * Work out what saving the attribution window must actually do.
 *
 * Pure: it decides, it does not act. The handler executes the plan, in
 * the plan's order — inserts first (so a failure changes nothing), then
 * one state commit, then deletes.
 *
 * Per student, comparing the working copy against what was stored when
 * the window opened:
 *
 *   • became CATCHUP, or is still catchup but against a DIFFERENT miss
 *     → insert a row. If a row already existed it is also deleted, so a
 *       re-pointed catch-up is a delete-and-insert rather than an update:
 *       the resolves_* set is the row's identity, and replacing it keeps
 *       insert-then-delete ordering safe if the insert fails.
 *   • moved AWAY from catchup (to regular, free, or cleared — including
 *     a departed entry being cleared) → delete the existing row.
 *   • became REGULAR → its card(s) leave the week and go into the band's
 *     removedLessons ledger.
 *   • moved AWAY from regular → its card(s) leave the ledger. They are
 *     dropped from it either way; whether they return to the grid is the
 *     caller's occupancy test, matching "Remove band session".
 *
 * consumedWeekKey follows the consumption: regular → the band's week,
 * catchup → the settled miss's week, anything else → null.
 *
 * @param {Object} args
 * @param {MemberState[]} args.stored     memberStates as at window open.
 * @param {MemberState[]} args.working    The edited copy.
 * @param {Object} args.missByEnrolment   { [enrolmentId]: miss } — the
 *        miss each catchup-attributed student is settling.
 * @param {Array} args.catchupsForBand    Catch-up rows linked to this band.
 * @param {string} args.weekKey           The band's week.
 * @returns {{inserts: Array, deletes: Array, regularOn: Array,
 *   regularOff: Array, memberStates: MemberState[], changed: boolean}}
 */
export function planAttributionSave({ stored, working, missByEnrolment, catchupsForBand, weekKey } = {}) {
  const storedList = stored || [];
  const workingList = working || [];
  const misses = missByEnrolment || {};
  const rows = catchupsForBand || [];
  const storedByEnrolment = new Map(storedList.map((e) => [e && e.enrolmentId, e]));

  const inserts = [];
  const deletes = [];
  const regularOn = [];
  const regularOff = [];

  const memberStates = workingList.map((entry) => {
    if (!entry) return entry;
    const before = storedByEnrolment.get(entry.enrolmentId) || null;
    const wasCatchup = !!(before && before.consumption === CONSUMPTION.catchup);
    const isCatchup = entry.consumption === CONSUMPTION.catchup;
    const wasRegular = !!(before && before.consumption === CONSUMPTION.regular);
    const isRegular = entry.consumption === CONSUMPTION.regular;
    const existingRow = before && before.catchupId
      ? rows.find((c) => c && c.id === before.catchupId) || null
      : null;
    const miss = isCatchup ? (misses[entry.enrolmentId] || null) : null;

    let catchupId = before ? before.catchupId || null : null;
    let consumedWeekKey = null;

    if (isCatchup) {
      const samePoint = wasCatchup && existingRow && rowSettlesMiss(existingRow, miss);
      if (samePoint) {
        consumedWeekKey = existingRow.resolvesWeekKey || (miss && miss.weekKey) || null;
      } else {
        if (existingRow) deletes.push(existingRow);
        inserts.push({ entry, miss });
        catchupId = null;          // stamped from the inserted row by the caller
        consumedWeekKey = miss ? miss.weekKey || null : null;
      }
    } else {
      if (existingRow) deletes.push(existingRow);
      catchupId = null;
      consumedWeekKey = isRegular ? weekKey || null : null;
    }

    if (isRegular && !wasRegular) regularOn.push(entry);
    if (wasRegular && !isRegular) regularOff.push(before);

    return { ...entry, catchupId, consumedWeekKey };
  });

  const changed = inserts.length > 0 || deletes.length > 0
    || regularOn.length > 0 || regularOff.length > 0
    || memberStates.some((e, i) => {
      const before = storedByEnrolment.get(e && e.enrolmentId) || null;
      return !before || before.consumption !== e.consumption;
    });

  return { inserts, deletes, regularOn, regularOff, memberStates, changed };
}

// ── Cluster 3b patch 1 ──────────────────────────────────────────────

/**
 * Which of a student's same-day cards the band card should warn about,
 * or null for no warning.
 *
 * The same-day warning exists to say "this member is already booked that
 * day". Whether that is a problem depends entirely on how the member is
 * attributed:
 *
 *   • LEGACY band, or a student nobody has attributed → the first
 *     same-day card, exactly as before. Unchanged behaviour.
 *   • attributed CATCHUP or FREE → null. The band slot is deliberately
 *     EXTRA to their regular lesson, so a regular card that day is
 *     correct rather than a clash.
 *   • attributed REGULAR → only a card belonging to the REGULAR
 *     enrolment warrants a warning, because that card should have been
 *     moved into the ledger and a surviving one is a real problem. A
 *     card for a DIFFERENT instrument is not: a student attributed
 *     regular on guitar is expected to still have their piano lesson
 *     that day. So every same-day card is considered, not just the
 *     first, and only a guitar one warns.
 *
 * Card matching mirrors findMemberCards: enrolmentId when the card
 * carries one, instrument otherwise (cards predating enrolmentId
 * stamping). No resolver is threaded here — constraints.js has none, and
 * an instrument comparison within a single student is unambiguous.
 *
 * @param {Object|null} bandLesson
 * @param {string} studentId
 * @param {Array|null|undefined} sameDayCards  That student's cards on the
 *        day in question, in the order the caller found them.
 * @returns {Object|null} The card to warn about, or null.
 */
export function sameDayClashCard(bandLesson, studentId, sameDayCards) {
  const cards = sameDayCards || [];
  const first = cards[0] || null;
  if (!hasMemberStates(bandLesson)) return first;

  const entry = (bandLesson.memberStates || []).find(
    (e) => e && e.studentId === studentId && e.consumption != null
  );
  if (!entry) return first;                                  // unattributed
  if (entry.consumption !== CONSUMPTION.regular) return null; // catchup / free

  return cards.find((c) => c && (
    c.enrolmentId ? c.enrolmentId === entry.enrolmentId : c.instrument === entry.instrument
  )) || null;
}

/**
 * Apply a new band's "regular" attributions to a week's lessons: every
 * regular-attributed entry's card(s) leave the grid and join the ledger.
 *
 * This is displacement, but driven by attribution rather than by the old
 * guitar-preference heuristic — it is what the attribution window's save
 * does, and what re-placing a band out of staging must redo, since the
 * ledger is deliberately emptied while a band is parked.
 *
 * Pure: returns new arrays and never mutates its inputs. Entries that are
 * not "regular", and entries whose card is not in the week, contribute
 * nothing.
 *
 * @param {Array} lessons            The week's lessons.
 * @param {MemberState[]} memberStates
 * @param {Array} ledger             Existing removedLessons.
 * @param {Function|null} resolver   From makeEnrolmentResolver(enrolments).
 * @returns {{lessons: Array, removedLessons: Array}}
 */
export function applyRegularDisplacement(lessons, memberStates, ledger, resolver) {
  let nextLessons = lessons || [];
  let nextLedger = ledger || [];
  for (const entry of (memberStates || [])) {
    if (!entry || entry.consumption !== CONSUMPTION.regular) continue;
    const cards = findMemberCards(nextLessons, entry, resolver);
    if (cards.length === 0) continue;
    const ids = new Set(cards.map((c) => c.id));
    nextLessons = nextLessons.filter((l) => !ids.has(l.id));
    nextLedger = [...nextLedger, ...cards];
  }
  return { lessons: nextLessons, removedLessons: nextLedger };
}

/**
 * Put a band's ledger cards back on the grid, for a band leaving the grid
 * with its attributions intact (grid → staging).
 *
 * A card whose slot is now occupied is NOT restored — the student stays
 * missing and the unscheduled banner picks them up. That is the same
 * precedent "Remove band session" already sets, deliberately reused so
 * the two paths cannot drift.
 *
 * The ledger is emptied either way: while a band is parked in staging it
 * displaces nothing, so holding cards it is not displacing would be a
 * lie, and re-placing it re-derives the ledger from memberStates via
 * applyRegularDisplacement.
 *
 * @param {Array} lessons        The week's lessons.
 * @param {Array} ledger         The band's removedLessons.
 * @returns {Array} lessons with the restorable cards added back.
 */
export function restoreLedgerCards(lessons, ledger) {
  let out = lessons || [];
  for (const rl of (ledger || [])) {
    if (!rl) continue;
    const slotOccupied = out.some((l) => l.day === rl.day && l.start === rl.start);
    if (!slotOccupied) out = [...out, rl];
  }
  return out;
}
