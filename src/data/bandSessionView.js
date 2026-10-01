// ============================================================
// bandSessionView.js — who is actually IN a band session, for display
// (Band Session Attribution cluster 6b). Pure: no React, no I/O.
//
// Every band surface used to list `members[]` — the roster snapshot taken
// when the band was placed. For a NEW band (memberStates array present) the
// session can differ from the roster: a member may be marked "Not in this
// session", or recorded absent. These helpers answer, per student, what the
// session looks like, so the card, popover, exports, Dashboard and emails all
// agree.
//
// LEGACY bands (no memberStates) have no session status. Every helper here
// returns exactly what the old code read — members[] in order, everyone
// attending, nothing flagged — so legacy rendering stays byte-identical.
//
// Deliberately dependency-light (bandMemberStates + bandAbsence only) so the
// teacher app can copy this file verbatim for phase 2 attendance marking.
// tallyDerive must NOT import this module: bandMemberStates sits on the
// tallyDerive → bandMemberStates → enrolmentActivity → tallyDerive cycle.
// ============================================================

import { hasMemberStates, studentRows, CONSUMPTION } from "./bandMemberStates";
import { bandMissesFor } from "./bandAbsence";

/**
 * A member's status in one band session.
 *   attending      — expected there (regular, catch-up, free, forward, billed).
 *   absent         — recorded absent (stamped miss, or attended:false).
 *   not_in_session — deliberately left out of this session.
 *   unattributed   — nobody has decided yet; assumed present.
 */
export const SESSION_STATUS = Object.freeze({
  attending: "attending",
  absent: "absent",
  notInSession: "not_in_session",
  unattributed: "unattributed",
});

function statusRow(studentId, instrument, attributedEntry, band, missed) {
  const row = { studentId, instrument: instrument || "", status: SESSION_STATUS.unattributed, absenceReason: null, absenceReasonDetail: "", isFree: false };
  const e = attributedEntry;
  if (!e) return row;
  row.isFree = e.consumption === CONSUMPTION.free;
  if (e.consumption === CONSUMPTION.notInSession) {
    row.status = SESSION_STATUS.notInSession;
  } else if (e.consumption === CONSUMPTION.regular) {
    const misses = bandMissesFor(missed, band.id, e);
    if (misses.length > 0) {
      row.status = SESSION_STATUS.absent;
      row.absenceReason = misses[0].reason || null;
      row.absenceReasonDetail = misses[0].reasonDetail || "";
    } else {
      row.status = SESSION_STATUS.attending;
    }
  } else if ((e.consumption === CONSUMPTION.catchup || e.consumption === CONSUMPTION.free) && e.attended === false) {
    row.status = SESSION_STATUS.absent;
    row.absenceReason = (e.absence && e.absence.reason) || null;
    row.absenceReasonDetail = (e.absence && e.absence.reasonDetail) || "";
  } else {
    row.status = SESSION_STATUS.attending;
  }
  return row;
}

/**
 * One row per STUDENT describing their part in this session.
 *
 * Rows start from band.members (placement order, one per student; the
 * member's band instrument is kept for display). A student who joined the
 * band definition after placement and has since been attributed — present in
 * memberStates with a non-null consumption, absent from members[] — is
 * appended. Multi-instrument entries collapse per student as studentRows
 * does: the attributed entry decides the status.
 *
 * Legacy band: members[] exactly as stored (duplicates included), every row
 * "attending".
 *
 * @param {Object} band     A band lesson.
 * @param {Array} missed    The band week's missed[] (regular absences).
 * @returns {Array<{studentId, instrument, status, absenceReason, absenceReasonDetail, isFree}>}
 */
export function sessionMemberRows(band, missed) {
  if (!band || !band.isBandSession) return [];
  const members = band.members || [];
  if (!hasMemberStates(band)) {
    return members.map(m => ({
      studentId: m && m.studentId, instrument: (m && m.instrument) || "",
      status: SESSION_STATUS.attending, absenceReason: null, absenceReasonDetail: "", isFree: false,
    }));
  }
  const byStudent = new Map(studentRows(band.memberStates).map(r => [r.studentId, r]));
  const out = [];
  const seen = new Set();
  for (const m of members) {
    const sid = m && m.studentId;
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    const r = byStudent.get(sid);
    out.push(statusRow(sid, m.instrument, r ? r.attributedEntry : null, band, missed));
  }
  for (const r of byStudent.values()) {
    if (seen.has(r.studentId) || !r.attributedEntry) continue;
    seen.add(r.studentId);
    out.push(statusRow(r.studentId, r.attributedEntry.instrument, r.attributedEntry, band, missed));
  }
  return out;
}

/**
 * The rows a band card lists: attending plus unattributed (assumed present).
 */
export function sessionMembers(band, missed) {
  return sessionMemberRows(band, missed).filter(r =>
    r.status === SESSION_STATUS.attending || r.status === SESSION_STATUS.unattributed);
}

/**
 * True for a NEW band with at least one member student nobody has decided
 * about. Legacy bands are never unattributed.
 */
export function isBandUnattributed(band) {
  return hasMemberStates(band) && studentRows(band.memberStates).some(r => !r.isAttributed);
}

/**
 * How many member students have a decision, out of how many. Counts
 * students, not entries (a guitar + piano student is one). null for legacy.
 */
export function attributionProgress(band) {
  if (!hasMemberStates(band)) return null;
  const rows = studentRows(band.memberStates);
  return { set: rows.filter(r => r.isAttributed).length, total: rows.length };
}

/**
 * Number of students recorded absent from this session. 0 for legacy.
 */
export function absentCount(band, missed) {
  if (!hasMemberStates(band)) return 0;
  return sessionMemberRows(band, missed).filter(r => r.status === SESSION_STATUS.absent).length;
}

/**
 * The band card's status lines: "Needs attribution" (amber) and "N absent"
 * (muted red). Independent — both can show. Legacy: neither.
 */
export function bandCardStatus(band, missed) {
  return { needsAttribution: isBandUnattributed(band), absentN: absentCount(band, missed) };
}

/**
 * Does this band account for the student's lesson this week, for the
 * "not scheduled this week" check?
 *
 *   LEGACY band — any member counts as covered (unchanged since v2.9.8).
 *   NEW band    — only an entry attributed "regular" covers, and only for
 *                 that entry's instrument when one is given. Catch-up, free,
 *                 not-in-session, unattributed, forward and billed members
 *                 keep their own lesson, so the band does not stand in for
 *                 it. (An absent regular is regular here, and its miss
 *                 covers it anyway.)
 *
 * @param {Object} band
 * @param {string} studentId
 * @param {string} [instrument]
 * @returns {boolean}
 */
export function bandCoversStudentForPresence(band, studentId, instrument) {
  if (!band || !band.isBandSession) return false;
  if (!hasMemberStates(band)) {
    return (band.members || []).some(mb => mb.studentId === studentId);
  }
  return (band.memberStates || []).some(e => e && e.studentId === studentId
    && e.consumption === CONSUMPTION.regular
    && (instrument == null || e.instrument === instrument));
}

/**
 * The students whose parents a day-header "email parents" should reach for
 * one lesson card: a group's students, an individual's student, and — for a
 * band — the students attending this session (unattributed included;
 * not-in-session and absent members left out). A legacy band contributes
 * members[] as listed. Callers de-duplicate recipients.
 *
 * @param {Object} lesson
 * @param {Array} missed   The week's missed[] (regular band absences).
 * @returns {string[]}
 */
export function parentEmailStudentIds(lesson, missed) {
  if (!lesson) return [];
  if (lesson.isBandSession) return sessionMembers(lesson, missed).map(r => r.studentId).filter(Boolean);
  if (lesson.isGroup) return lesson.studentIds || [];
  return lesson.studentId ? [lesson.studentId] : [];
}

/**
 * The band a band-linked catch-up row belongs to, looked up in the row's own
 * week and school (as bandCatchupTooltip does). Its name, or null when the
 * row isn't band-linked, the band can't be found, or it has no name.
 */
export function bandNameForCatchup(row, weeklyTimetables) {
  if (!row || !row.bandLessonId) return null;
  const entry = weeklyTimetables && weeklyTimetables[`${row.weekKey}|${row.schoolId}`];
  const band = ((entry && entry.lessons) || []).find(l => l && l.isBandSession && l.id === row.bandLessonId);
  return (band && band.bandName) || null;
}

const DAY_RANK = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };

/**
 * Every unattributed NEW band in the given weeks and schools, in date order.
 *
 * @param {Object} weeklyTimetables  { "weekKey|schoolId": entry }
 * @param {Object} [scope]
 * @param {Array<string>} [scope.weekKeys]   Only these weeks (all if omitted).
 * @param {Array<string>} [scope.schoolIds]  Only these schools (all if omitted).
 * @param {string} [scope.fromWeekKey]       Only weeks on or after this Monday
 *        (YYYY-MM-DD; ISO dates compare correctly as strings).
 * @returns {Array<{weekKey, schoolId, bandLessonId, bandName, day, start, set, total}>}
 */
export function findUnattributedBands(weeklyTimetables, { weekKeys, schoolIds, fromWeekKey } = {}) {
  const weekSet = weekKeys ? new Set(weekKeys) : null;
  const schoolSet = schoolIds ? new Set(schoolIds) : null;
  const out = [];
  for (const [key, entry] of Object.entries(weeklyTimetables || {})) {
    const [weekKey, schoolId] = key.split("|");
    if (weekSet && !weekSet.has(weekKey)) continue;
    if (fromWeekKey && weekKey < fromWeekKey) continue;
    if (schoolSet && !schoolSet.has(schoolId)) continue;
    for (const l of ((entry && entry.lessons) || [])) {
      if (!l || !l.isBandSession || !isBandUnattributed(l)) continue;
      const p = attributionProgress(l);
      out.push({ weekKey, schoolId, bandLessonId: l.id, bandName: l.bandName || "", day: l.day || "", start: l.start || "", set: p.set, total: p.total });
    }
  }
  return out.sort((a, b) => a.weekKey.localeCompare(b.weekKey)
    || (DAY_RANK[a.day] ?? 9) - (DAY_RANK[b.day] ?? 9)
    || a.start.localeCompare(b.start)
    || a.bandName.localeCompare(b.bandName));
}

// ── Dashboard alert (cluster 6b) ────────────────────────────────────

const DAY_MS = 86400000;
const keyToUtc = (k) => { const [y, m, d] = String(k).split("-").map(Number); return Date.UTC(y, m - 1, d); };
const utcToKey = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Every Monday (YYYY-MM-DD) from the week holding term.start through
 * term.end, inclusive. Timezone-free (UTC arithmetic on date strings).
 *
 * @param {{start: string, end: string}|null} term
 * @returns {string[]}
 */
export function termWeekKeys(term) {
  if (!term || !term.start || !term.end) return [];
  const s = keyToUtc(term.start);
  const dow = (new Date(s).getUTCDay() + 6) % 7;   // Monday = 0
  const end = keyToUtc(term.end);
  const out = [];
  for (let t = s - dow * DAY_MS; t <= end; t += 7 * DAY_MS) out.push(utcToKey(t));
  return out;
}

/**
 * Whole weeks from one Monday to another (negative = earlier).
 */
export function weekOffsetBetween(fromWeekKey, toWeekKey) {
  return Math.round((keyToUtc(toWeekKey) - keyToUtc(fromWeekKey)) / (7 * DAY_MS));
}

// The alert is dismissed for the SET of bands it listed, never for good: each
// dismissal key carries band lesson ids, and a band no key covers shows again.
export const UNATTRIBUTED_ALERT_PREFIX = "alert-unattributed-bands|";

/**
 * The alertDismissals key that dismisses exactly these bands.
 */
export function unattributedAlertDismissKey(bandLessonIds) {
  return UNATTRIBUTED_ALERT_PREFIX + [...new Set(bandLessonIds || [])].sort().join(",");
}

/**
 * The band lesson ids no dismissal key covers, in input order.
 *
 * @param {Array<string>} bandLessonIds
 * @param {Object} dismissed  alertDismissals.dismissed
 */
export function undismissedBandIds(bandLessonIds, dismissed) {
  const covered = new Set();
  for (const [key, on] of Object.entries(dismissed || {})) {
    if (!on || !key.startsWith(UNATTRIBUTED_ALERT_PREFIX)) continue;
    for (const id of key.slice(UNATTRIBUTED_ALERT_PREFIX.length).split(",")) if (id) covered.add(id);
  }
  return (bandLessonIds || []).filter(id => !covered.has(id));
}

/**
 * The unattributed band sessions the Dashboard alert lists: every NEW band
 * with a member nobody has decided about, in any week from the Monday of the
 * anchor term's start onwards — no end limit (v2.41.1: during the holidays
 * the anchor is the term just finished, so next term's bands must show too) —
 * minus the bands an earlier dismissal covered.
 *
 * @param {Object} weeklyTimetables
 * @param {{start, end}|null} term   The anchor term (catch-ups owed's rule).
 * @param {Object} dismissed         alertDismissals.dismissed
 * @returns {Array} findUnattributedBands rows.
 */
export function unattributedBandsForAlert(weeklyTimetables, term, dismissed) {
  if (!term) return [];
  const fromWeekKey = termWeekKeys(term)[0];
  if (!fromWeekKey) return [];
  const bands = findUnattributedBands(weeklyTimetables, { fromWeekKey });
  const keep = new Set(undismissedBandIds(bands.map(b => b.bandLessonId), dismissed));
  return bands.filter(b => keep.has(b.bandLessonId));
}
