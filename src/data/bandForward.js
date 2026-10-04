// ============================================================
// bandForward.js — which later weeks a band attendance may use up
// ("Lesson brought forward", Band Session Attribution phase 3, slice 1).
// Pure: no React, no I/O.
//
// A week is OPEN for a subject (one solo enrolment, or one group), relative
// to a band in week B, when it is a school week of B's term, strictly later
// than B, and:
//   (a) the subject is active that week — the v2.44.0 rule, deriveTallyCell
//       with no entry !== "inactive" (a group: at least one member);
//   (b) no missed entry of any kind is recorded for it that week, in any
//       school's row (ordinary misses and band-stamped misses alike; a group:
//       whole-group misses);
//   (c) no OTHER forward entry already uses that week for it (any band, any
//       school's row — the bandForwardIndex lookup; a group: by groupId);
//   (d) no Regular band entry replaces its lesson that week (a legacy band
//       listing the student counts too — it replaces the whole student);
//   (e) its lesson day is not closed by a whole-day interruption. This
//       mirrors the generator's own whole-day rule (isDayBlocked in
//       weeklyTimetableGenerator.js, which is not exported): a non-term-break
//       interruption for the school or "all", covering the date, displayed
//       as an interruption or public holiday, affecting all classes, with no
//       start time. With no known lesson day the week is treated as open.
//
// The walk runs backwards from the last term week, so the latest open week
// comes first and is the default (spec 3.11: last open, then second-last…).
// Kept apart from bandForwardIndex.js because it imports tallyDerive.
// ============================================================

import { deriveTallyCell } from "../utils/tallyDerive";
import { INTR_DISPLAY_TYPE } from "../utils/eventTypes";
import { buildForwardIndex } from "./bandForwardIndex";
import { resolveAnchorTerm } from "../utils/catchupScope";
import { getTermWeeks } from "../utils/termWeeks";

const DAY_OFFSET = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };

function addDays(weekKey, n) {
  const d = new Date(weekKey + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Every weekly row of `weekKey`, whatever the school.
function rowsOfWeek(weeklyTimetables, weekKey) {
  const out = [];
  const prefix = weekKey + "|";
  for (const sk of Object.keys(weeklyTimetables || {})) {
    if (sk.startsWith(prefix) && weeklyTimetables[sk]) out.push(weeklyTimetables[sk]);
  }
  return out;
}

/**
 * (e) True if a whole-day interruption closes `day` of `weekKey` at `schoolId`.
 *
 * @param {Array} interruptions
 * @param {string} schoolId
 * @param {string} weekKey
 * @param {string} day
 * @returns {boolean}
 */
export function isLessonDayClosed(interruptions, schoolId, weekKey, day) {
  if (!day || DAY_OFFSET[day] === undefined) return false;
  const date = addDays(weekKey, DAY_OFFSET[day]);
  return (interruptions || []).some((i) => {
    if (!i || i.type === "term_break") return false;
    if (i.schoolId !== schoolId && i.schoolId !== "all") return false;
    if (date < i.date || date > (i.endDate || i.date)) return false;
    const kind = INTR_DISPLAY_TYPE[i.type];
    return (kind === "interruption" || kind === "public_holiday") && i.affectsClasses === "all" && !i.startTime;
  });
}

/**
 * The open weeks for a forward attribution, latest first.
 *
 * @param {Object} args
 * @param {Object} args.subject  Either { enrolment } (a solo enrolment) or
 *        { groupId, enrolments } (a group; enrolments = the members' group
 *        enrolments on this band).
 * @param {string} args.bandWeekKey      Monday of the band's week.
 * @param {string} [args.bandLessonId]   The band itself — its own forward
 *        entry never blocks a week (so re-saving keeps the current week open).
 * @param {Array} args.termWeeks  The band's term's weeks, each
 *        { weekKey, weekNum, isHoliday? } (getTermWeeks shape).
 * @param {Object} args.weeklyTimetables
 * @param {Object} [args.forwardIndex]  From buildForwardIndex; built from
 *        weeklyTimetables when omitted.
 * @param {Array} [args.interruptions]
 * @param {string} [args.schoolId]   The subject's lesson school, for (e).
 * @param {string} [args.lessonDay]  The subject's lesson day, for (e).
 * @returns {Array<{weekKey: string, weekNum: number}>}
 */
export function openForwardWeeks({ subject, bandWeekKey, bandLessonId = null, termWeeks, weeklyTimetables,
  forwardIndex, interruptions = [], schoolId = "", lessonDay = "" } = {}) {
  if (!subject || !bandWeekKey) return [];
  const weeks = termWeeks || [];
  // D4 — a band outside the term's school weeks (a holiday week) has no later lesson to use.
  if (!weeks.some((w) => w && w.weekKey === bandWeekKey && !w.isHoliday)) return [];
  const index = forwardIndex || buildForwardIndex(weeklyTimetables);
  const isGroup = !!subject.groupId;
  const solo = isGroup ? null : subject.enrolment;
  if (!isGroup && !solo) return [];
  const members = isGroup ? (subject.enrolments || []).filter(Boolean) : [solo];

  const isActive = (weekKey) => members.some((e) => deriveTallyCell({ enrolment: e, week: { weekKey }, wttEntry: null }) !== "inactive");

  const soloMatch = (x) => !!x && !x.isGroup && (x.enrolmentId === solo.id
    || (x.studentId === solo.studentId && x.instrument === solo.instrument));
  const hasMiss = (rows) => rows.some((d) => (d.missed || []).some((m) => m && (isGroup
    ? (m.isGroup === true && m.groupId === subject.groupId)
    : soloMatch(m))));
  const usedByOtherForward = (weekKey) => index.entries.some((f) => f.consumedWeekKey === weekKey && f.bandLessonId !== bandLessonId
    && (isGroup ? f.groupId === subject.groupId
      : (!f.groupId && (f.enrolmentId === solo.id || (f.studentId === solo.studentId && f.instrument === solo.instrument)))));
  const replacedByRegular = (rows) => rows.some((d) => (d.lessons || []).some((l) => {
    if (!l || !l.isBandSession) return false;
    if (!Array.isArray(l.memberStates)) {
      // Legacy band: it replaces the whole student (never a group).
      return !isGroup && (l.members || []).some((m) => m && m.studentId === solo.studentId);
    }
    return l.memberStates.some((e) => e && e.consumption === "regular" && e.attended !== false && (isGroup
      ? (e.isGroup === true && e.groupId === subject.groupId)
      : (!e.isGroup && (e.enrolmentId === solo.id || (e.studentId === solo.studentId && e.instrument === solo.instrument)))));
  }));

  const out = [];
  const candidates = weeks.filter((w) => w && !w.isHoliday && w.weekKey > bandWeekKey)
    .sort((a, b) => (a.weekKey < b.weekKey ? 1 : -1));
  for (const w of candidates) {
    if (!isActive(w.weekKey)) continue;                                        // (a)
    const rows = rowsOfWeek(weeklyTimetables, w.weekKey);
    if (hasMiss(rows)) continue;                                               // (b)
    if (usedByOtherForward(w.weekKey)) continue;                               // (c)
    if (replacedByRegular(rows)) continue;                                     // (d)
    if (isLessonDayClosed(interruptions, schoolId, w.weekKey, lessonDay)) continue; // (e)
    out.push({ weekKey: w.weekKey, weekNum: w.weekNum });
  }
  return out;
}

/**
 * The term weeks a band in `bandWeekKey` may bring a lesson forward from:
 * its term's weeks (getTermWeeks shape), resolved exactly as the catch-up
 * picker resolves a target week's term (resolveAnchorTerm, now = term end so
 * the list never stretches to today). A band in a holiday break gets that
 * break's term, whose weeks flag the holiday — openForwardWeeks then offers
 * nothing (D4). No term found → [].
 *
 * @param {Array} interruptions
 * @param {string} bandWeekKey
 * @returns {Array<{weekKey: string, weekNum: number, label: string, isHoliday?: boolean}>}
 */
export function forwardTermWeeks(interruptions, bandWeekKey) {
  const anchor = resolveAnchorTerm(interruptions, bandWeekKey);
  if (!anchor) return [];
  const T = anchor.term;
  const termBreaks = (interruptions || []).filter((i) => i && i.type === "term_break")
    .sort((a, b) => a.date.localeCompare(b.date));
  return getTermWeeks({
    activeTerm: { start: new Date(T.start + "T00:00:00"), end: new Date(T.end + "T00:00:00") },
    termBreaks,
    now: new Date(T.end + "T00:00:00"),
  });
}

/**
 * The lesson school and day of a forward subject, from its master card, for
 * the whole-day closure test (e). A solo enrolment: the master card carrying
 * its enrolmentId, else the student's non-group card on that instrument. A
 * group: the group's master card. School falls back to the student's school;
 * day falls back to "" (the closure test then treats the week as open).
 *
 * @param {Object} subject  { enrolment } or { groupId, enrolments }.
 * @param {Array} masterLessons  timetable.lessons.
 * @param {Array} students
 * @returns {{schoolId: string, lessonDay: string}}
 */
export function forwardLessonContext(subject, masterLessons, students) {
  const lessons = masterLessons || [];
  let card = null;
  let studentId = null;
  if (subject && subject.groupId) {
    card = lessons.find((l) => l && l.isGroup && l.groupId === subject.groupId) || null;
    studentId = ((subject.enrolments || [])[0] || {}).studentId || null;
  } else if (subject && subject.enrolment) {
    const e = subject.enrolment;
    card = lessons.find((l) => l && !l.isGroup && !l.isBandSession && l.enrolmentId === e.id)
      || lessons.find((l) => l && !l.isGroup && !l.isBandSession && l.studentId === e.studentId && l.instrument === e.instrument)
      || null;
    studentId = e.studentId;
  }
  const st = studentId ? (students || []).find((s) => s && s.id === studentId) : null;
  return { schoolId: (card && card.schoolId) || (st && st.schoolId) || "", lessonDay: (card && card.day) || "" };
}

/** "Week N" — how a forward week is named everywhere in the window. */
export function forwardWeekLabel(weekNum) {
  return `Week ${weekNum}`;
}

/** The disabled-option reason (D4). */
export const NO_FORWARD_WEEK_TEXT = "No later lesson this term to bring forward";
