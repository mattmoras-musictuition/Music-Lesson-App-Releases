// ============================================================
// bandForwardStale.js — brought-forward weeks that need checking
// (Band Session Attribution phase 3, refinement 2). Pure: no React, no I/O.
//
// A forward entry's given-up week is chosen once and sticks (spec 3.11). If
// that week later stops making sense, nothing is re-picked: this selector
// only FLAGS it, for the Dashboard chip and the attribution window's note.
// Everything is derived from the weekly rows, interruptions, enrolments and
// master timetable — there is no stored flag.
//
// A subject still USING its week up (forwardConsumes) is flagged when:
//   not_school_week — the week is now a holiday, or no longer in the term;
//   day_closed      — a whole-day closure covers its lesson day that week;
//   inactive        — the enrolment (a group: every member) is not active;
//   missed          — a miss is recorded for it that week;
//   card_present    — its regular lesson is on the timetable that week.
// A subject whose absence (catch-up owed) GAVE the week back is flagged
// not_put_back when that week is a normal school week for it, its row is
// generated, and the lesson is still not there (the slot was taken).
// Releases from a role change or band removal leave no entry behind and are
// not flagged (owner decision).
//
// Kept out of bandForwardIndex.js: it imports tallyDerive.
// ============================================================

import { forwardTermWeeks, forwardSubjects, forwardLessonContext, isLessonDayClosed, subjectOwnsCard, isGeneratedRow } from "./bandForward";
import { forwardConsumes } from "./bandForwardIndex";
import { deriveTallyCell } from "../utils/tallyDerive";

export const FORWARD_PROBLEM = Object.freeze({
  notSchoolWeek: "not_school_week",
  dayClosed: "day_closed",
  inactive: "inactive",
  missed: "missed",
  cardPresent: "card_present",
  notPutBack: "not_put_back",
});

const PROBLEM_TEXT = {
  not_school_week: "it is no longer a school week",
  day_closed: "the lesson day is closed that week",
  inactive: "the enrolment has ended by then",
  missed: "an absence is recorded that week",
  card_present: "the regular lesson is back on the timetable",
  not_put_back: "the regular lesson could not be put back",
};

const DAY_RANK = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };

// Every weekly row of `weekKey`, whatever the school.
function rowsOfWeek(weeklyTimetables, weekKey) {
  const prefix = weekKey + "|";
  return Object.keys(weeklyTimetables || {}).filter(k => k.startsWith(prefix)).map(k => weeklyTimetables[k]).filter(Boolean);
}

// A miss belonging to the subject (openForwardWeeks' rule (b)).
function missBelongs(subject, m) {
  if (!m) return false;
  if (subject.groupId) return m.isGroup === true && m.groupId === subject.groupId;
  return !m.isGroup && (m.enrolmentId === subject.enrolmentId
    || (m.studentId === subject.studentId && m.instrument === subject.instrument));
}

/**
 * Every brought-forward subject whose given-up week needs checking.
 *
 * @param {Object} args
 * @param {Object} args.weeklyTimetables
 * @param {Array} [args.interruptions]
 * @param {Array} [args.enrolments]
 * @param {Array} [args.masterLessons]  timetable.lessons.
 * @param {Array} [args.students]
 * @param {string} [args.fromWeekKey]   Only bands in weeks on or after this Monday.
 * @param {string} [args.bandLessonId]  Only this band.
 * @returns {Array<{bandLessonId, bandName, bandWeekKey, schoolId, day, subjectKey, groupId, enrolmentId,
 *   studentId, studentIds, consumedWeekKey, consumedWeekNum, reasons: string[]}>}
 */
export function forwardWeekProblems({ weeklyTimetables, interruptions = [], enrolments = [], masterLessons = [], students = [],
  fromWeekKey = null, bandLessonId = null } = {}) {
  const out = [];
  const termWeeksCache = new Map();
  const termWeeksOf = (wk) => {
    if (!termWeeksCache.has(wk)) termWeeksCache.set(wk, forwardTermWeeks(interruptions, wk));
    return termWeeksCache.get(wk);
  };
  for (const sk of Object.keys(weeklyTimetables || {}).sort()) {
    const bar = sk.indexOf("|");
    const bandWeekKey = bar === -1 ? sk : sk.slice(0, bar);
    const rowSchool = bar === -1 ? "" : sk.slice(bar + 1);
    if (fromWeekKey && bandWeekKey < fromWeekKey) continue;
    for (const band of ((weeklyTimetables[sk] || {}).lessons || [])) {
      if (!band || !band.isBandSession || !Array.isArray(band.memberStates)) continue;
      if (bandLessonId && band.id !== bandLessonId) continue;
      for (const subject of forwardSubjects(band.memberStates)) {
        const week = subject.consumedWeekKey;
        if (!week) continue;
        const first = subject.entries[0];
        const consuming = forwardConsumes(first);
        const released = !consuming && first.attended === false && !!first.absence && first.absence.makeupEligible === true;
        if (!consuming && !released) continue;

        const members = subject.entries.map(e => (enrolments || []).find(en => en && en.id === e.enrolmentId)
          || { id: e.enrolmentId, studentId: e.studentId, instrument: e.instrument, isGroup: !!subject.groupId, groupId: subject.groupId || undefined });
        const ctx = forwardLessonContext(subject.groupId ? { groupId: subject.groupId, enrolments: members } : { enrolment: members[0] }, masterLessons, students);
        const snap = subject.forwardCard;
        const lessonSchool = ctx.schoolId || (snap && snap.schoolId) || "";
        const lessonDay = ctx.lessonDay || (snap && snap.day) || "";
        const tw = termWeeksOf(bandWeekKey).find(w => w && w.weekKey === week) || null;
        const rows = rowsOfWeek(weeklyTimetables, week);

        const notSchool = !tw || !!tw.isHoliday;
        const closed = isLessonDayClosed(interruptions, lessonSchool, week, lessonDay);
        const active = members.some(e => deriveTallyCell({ enrolment: e, week: { weekKey: week }, wttEntry: null }) !== "inactive");
        const hasMiss = rows.some(d => (d.missed || []).some(m => missBelongs(subject, m)));
        const cardPresent = rows.some(d => (d.lessons || []).some(l => subjectOwnsCard(subject, l)));

        const reasons = [];
        if (consuming) {
          if (notSchool) reasons.push(FORWARD_PROBLEM.notSchoolWeek);
          if (closed) reasons.push(FORWARD_PROBLEM.dayClosed);
          if (!active) reasons.push(FORWARD_PROBLEM.inactive);
          if (hasMiss) reasons.push(FORWARD_PROBLEM.missed);
          if (cardPresent) reasons.push(FORWARD_PROBLEM.cardPresent);
        } else if (!notSchool && !closed && active && !hasMiss && !cardPresent) {
          const master = (masterLessons || []).find(l => subjectOwnsCard(subject, l)) || null;
          const target = snap ? (snap.schoolId || "") : master ? (master.schoolId || "") : null;
          if (target !== null && isGeneratedRow((weeklyTimetables || {})[`${week}|${target}`])) reasons.push(FORWARD_PROBLEM.notPutBack);
        }
        if (reasons.length === 0) continue;
        out.push({
          bandLessonId: band.id, bandName: band.bandName || "", bandWeekKey, schoolId: rowSchool, day: band.day || "",
          subjectKey: subject.key, groupId: subject.groupId, enrolmentId: subject.enrolmentId, studentId: subject.studentId,
          studentIds: [...new Set(subject.entries.map(e => e.studentId).filter(Boolean))],
          consumedWeekKey: week, consumedWeekNum: tw && !tw.isHoliday ? tw.weekNum : null, reasons,
        });
      }
    }
  }
  return out.sort((a, b) => a.bandWeekKey.localeCompare(b.bandWeekKey)
    || (DAY_RANK[a.day] ?? 9) - (DAY_RANK[b.day] ?? 9)
    || a.bandName.localeCompare(b.bandName)
    || a.subjectKey.localeCompare(b.subjectKey));
}

/**
 * The plain-English reasons, joined: "an absence is recorded that week; …".
 */
export function forwardProblemText(reasons) {
  return (reasons || []).map(r => PROBLEM_TEXT[r] || r).join("; ");
}

/**
 * The attribution window's amber note for one problem:
 * "Check week 8 — an absence is recorded that week".
 *
 * @param {Object} problem   A forwardWeekProblems row.
 * @param {string} weekName  How the window names the week ("Week 8").
 */
export function forwardStaleNote(problem, weekName) {
  if (!problem) return "";
  return `Check ${String(weekName || "").replace(/^Week/, "week")} — ${forwardProblemText(problem.reasons)}`;
}
