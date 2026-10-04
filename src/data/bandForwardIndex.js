// ============================================================
// bandForwardIndex.js — the cross-week index of "forward" band entries
// (Band Session Attribution phase 3, slice 1). Pure: no React, no I/O.
//
// A forward entry ("Lesson brought forward") lives on a band card in the
// BAND's week, but what it uses up is a LATER week of the same term
// (consumedWeekKey). Anything asking about that later week therefore has to
// look across weeks — and across schools, because the band can sit in a
// different school's weekly row from the student. This module builds that
// lookup once.
//
// Deliberately imports NOTHING: tallyDerive reads this index, and importing
// bandMemberStates here would close the tallyDerive → bandMemberStates →
// enrolmentActivity → tallyDerive cycle. Consumption values are therefore
// literal strings, exactly as tallyDerive does.
// ============================================================

/**
 * One indexed forward entry.
 * @typedef {Object} ForwardInfo
 * @property {string} bandLessonId   The band card's id.
 * @property {string} bandWeekKey    Monday of the band's week.
 * @property {string} bandName
 * @property {string} schoolId       School of the weekly row holding the band.
 * @property {string} day            The band session's day.
 * @property {string} consumedWeekKey
 * @property {string} enrolmentId
 * @property {string} studentId
 * @property {string} instrument
 * @property {string|null} groupId   Set for a group entry.
 * @property {boolean|null} attended
 */

/**
 * Build the forward index from the weekly timetables.
 *
 *   byEnrolment: Map "<enrolmentId>|<consumedWeekKey>" → ForwardInfo (solo entries)
 *   byGroup:     Map "<groupId>|<consumedWeekKey>"     → ForwardInfo (group entries;
 *                one per group — every entry of a group shares the week)
 *   entries:     every indexed ForwardInfo, in scan order
 *
 * Only NEW bands (memberStates an array) carrying an entry with consumption
 * "forward" and a consumedWeekKey are indexed. When two entries claim the
 * same key the first one scanned wins in the maps (the save path never lets
 * that happen); `entries` keeps them all.
 *
 * @param {Object} weeklyTimetables  "<weekKey>|<schoolId>" → { lessons, missed }.
 * @param {Iterable<string>} [bandWeekKeys]  Only bands in these weeks are
 *        scanned (e.g. one term's weeks). Omitted → every week.
 * @returns {{byEnrolment: Map<string, ForwardInfo>, byGroup: Map<string, ForwardInfo>, entries: ForwardInfo[]}}
 */
export function buildForwardIndex(weeklyTimetables, bandWeekKeys) {
  const scope = bandWeekKeys ? new Set(bandWeekKeys) : null;
  const byEnrolment = new Map();
  const byGroup = new Map();
  const entries = [];
  const keys = Object.keys(weeklyTimetables || {}).sort();
  for (const sk of keys) {
    const bar = sk.indexOf("|");
    const weekKey = bar === -1 ? sk : sk.slice(0, bar);
    const schoolId = bar === -1 ? "" : sk.slice(bar + 1);
    if (scope && !scope.has(weekKey)) continue;
    const data = weeklyTimetables[sk];
    for (const l of ((data && data.lessons) || [])) {
      if (!l || !l.isBandSession || !Array.isArray(l.memberStates)) continue;
      for (const e of l.memberStates) {
        if (!e || e.consumption !== "forward" || !e.consumedWeekKey) continue;
        const isGroup = e.isGroup === true && !!e.groupId;
        const info = {
          bandLessonId: l.id,
          bandWeekKey: weekKey,
          bandName: l.bandName || "",
          schoolId,
          day: l.day || "",
          consumedWeekKey: e.consumedWeekKey,
          enrolmentId: e.enrolmentId,
          studentId: e.studentId,
          instrument: e.instrument || "",
          groupId: isGroup ? e.groupId : null,
          attended: e.attended === undefined ? null : e.attended,
        };
        entries.push(info);
        if (isGroup) {
          const k = `${e.groupId}|${e.consumedWeekKey}`;
          if (!byGroup.has(k)) byGroup.set(k, info);
        } else {
          const k = `${e.enrolmentId}|${e.consumedWeekKey}`;
          if (!byEnrolment.has(k)) byEnrolment.set(k, info);
        }
      }
    }
  }
  return { byEnrolment, byGroup, entries };
}

/**
 * The forward entry using up `weekKey` for this Tally subject, or null.
 * Solo enrolments match on enrolmentId first, then studentId + instrument
 * (the band's week-active pick and the Tally's preferred row can differ when
 * duplicate enrolments exist — the same rule as the Regular band matcher).
 * Group enrolments match on groupId.
 *
 * @param {{byEnrolment: Map, byGroup: Map, entries: Array}} index
 * @param {{id: string, studentId: string, instrument: string, isGroup?: boolean, groupId?: string}} enrolment
 * @param {string} weekKey
 * @returns {ForwardInfo|null}
 */
export function forwardFor(index, enrolment, weekKey) {
  if (!index || !enrolment || !weekKey) return null;
  if (enrolment.isGroup) {
    return enrolment.groupId ? index.byGroup.get(`${enrolment.groupId}|${weekKey}`) || null : null;
  }
  const direct = index.byEnrolment.get(`${enrolment.id}|${weekKey}`);
  if (direct) return direct;
  return index.entries.find((f) => !f.groupId && f.consumedWeekKey === weekKey
    && f.studentId === enrolment.studentId && f.instrument === enrolment.instrument) || null;
}
