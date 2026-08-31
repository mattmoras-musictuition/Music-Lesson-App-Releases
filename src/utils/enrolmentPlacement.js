// ============================================================
// enrolmentPlacement.js — first-placement start-date stamping.
// Pure functions, no side effects, no state, no date arithmetic.
//
// Background: enrolments.start_date has always meant "the day the record was
// typed in", never "the day lessons begin". Every creation path stamps today,
// and nothing restamped it when a waiting-list student was later placed on the
// timetable — so a student entered in June and first taught in week 6 carried a
// June start date. That fed two visible defects: the tally rendered Unmarked
// circles instead of the Inactive dash for the weeks before they started, and
// invoicing billed them a full term.
//
// Per Matt's decision, first placement now stamps the enrolment's startDate to
// the Monday of the week of that placement, and the date stays editable in the
// student form afterwards.
//
// The Monday string is always supplied BY THE CALLER, from the repo's existing
// getCurrentWeekMonday/toLocalDateStr helpers or from a WTT weekKey (already
// Monday-anchored). This module deliberately contains no date maths and no
// Intl call, so there is exactly one Monday-anchoring implementation in the app.
// ============================================================

// Does this enrolment already have a card on the master timetable?
//
// Deliberately generous about what counts as a match. enrolmentId is the
// canonical link, but cards predating enrolmentId stamping carry only
// studentId + instrument (this is why tallyDerive keeps a lessonKey fallback),
// and group cards key off groupId. Any of the three counts as "already placed".
//
// The generosity is the safe direction: a false "already placed" leaves today's
// behaviour untouched, whereas a false "not placed yet" would rewrite a start
// date that was already correct.
export function isEnrolmentPlaced(enrolment, timetableLessons) {
  if (!enrolment) return false;
  const lessons = timetableLessons || [];
  return lessons.some(l => {
    if (l.enrolmentId && l.enrolmentId === enrolment.id) return true;
    if (enrolment.isGroup) return !!l.isGroup && !!l.groupId && l.groupId === enrolment.groupId;
    return !l.isGroup && l.studentId === enrolment.studentId && l.instrument === enrolment.instrument;
  });
}

// Stamp startDate on ONE enrolment, but only when this is its first placement.
//
// Returns a new enrolments array, or the SAME array reference when nothing
// changed — so `setEnrolments(prev => stampFirstPlacementStart({ ... }))` is a
// no-op render when the guard declines, matching enrolmentSync's contract.
//
// `timetableLessons` must be the master timetable as it stood BEFORE this
// placement. Every caller passes the `timetable` closure value, which is the
// pre-placement snapshot for the render in which the handler was created.
//
// Declines to stamp — leaving the stored date exactly as it was — when:
//   - there is no enrolmentId, or it matches no enrolment
//   - no weekMonday was supplied
//   - the enrolment already has a card on the master timetable
//   - the enrolment has ended (endDate set); its range is history, not a
//     first placement
//   - the value would not actually change
export function stampFirstPlacementStart({ enrolments, enrolmentId, weekMonday, timetableLessons }) {
  const list = enrolments || [];
  if (!enrolmentId || !weekMonday) return list;

  const target = list.find(e => e.id === enrolmentId);
  if (!target) return list;
  if (target.endDate) return list;
  if (isEnrolmentPlaced(target, timetableLessons)) return list;
  if (target.startDate === weekMonday) return list;

  return list.map(e => e.id === enrolmentId ? { ...e, startDate: weekMonday } : e);
}
