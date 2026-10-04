// ============================================================
// weeklyPresence.js — the shared "is this master lesson present this week?"
// rule. Moved out of WeeklyAdjustments (cluster 6b) so it can be tested; it is
// still the single source of truth for BOTH the amber "not scheduled this
// week" banner and the right-click "Add unscheduled" menu.
// ============================================================

import { bandCoversStudentForPresence } from "../data/bandSessionView";
import { bandCoversGroupForPresence } from "../data/bandMemberStates";
import { isForwardConsumedCard } from "../data/bandForwardIndex";

// A master lesson (ml) counts as PRESENT (i.e. scheduled this week) when:
//   • GROUP master lesson      → a matching group card (by groupId) is placed,
//                                or a group-keyed Missed entry exists, or
//                                (v2.43.0) a NEW band with that group Regular
//                                holds the group's card in its ledger.
//   • INDIVIDUAL master lesson → a direct individual card matches
//                                (studentId + instrument), OR a placed BAND
//                                session this week accounts for it, OR a
//                                matching Missed entry exists.
//
// A placed GROUP card does NOT cover a student's separate INDIVIDUAL lesson —
// a group and an individual lesson are distinct enrolments, each needing its
// own card. (Previously a group-membership branch masked the individual; see
// fix/wtt-unscheduled-group-masking.)
//
// BAND coverage (bandCoversStudentForPresence): a LEGACY band covers every
// member, as it always has. A NEW band covers only a member attributed
// "regular" on that instrument — the one case where the band replaces their
// lesson. Catch-up, free, not-in-session and unattributed members keep their
// own card, so a missing card for them is flagged (cluster 6b, closing the
// case where an attribution moved away from regular and the card could not
// go back because its slot had been taken).
//
// FORWARD (phase 3, slice 2): a subject whose week is used up by a "Lesson
// brought forward" entry — on a band in an EARLIER week, any school's row —
// counts as scheduled in that week. The cross-week index comes in through
// `opts` (bandForwardIndex.buildForwardIndex over all weekly rows) with the
// week's plain Monday key; without it the rule is the week-only one above.
//
// v2.46.0: a Regular GROUP on a new band covers the group whether or not its
// card reached the ledger, mirroring individuals (bandCoversGroupForPresence).
export function isLessonPresentThisWeek(ml, wttLessons, wttMissed, opts = {}) {
  const lessons = wttLessons || [];
  const missed = wttMissed || [];
  if (opts && opts.forwardIndex && opts.weekKey && isForwardConsumedCard(ml, opts.weekKey, opts.forwardIndex)) return true;
  if (ml.isGroup) {
    return lessons.some(wl => wl.groupId === ml.groupId)
        || missed.some(wm => wm.groupId === ml.groupId)
        || lessons.some(wl => wl.isBandSession && bandCoversGroupForPresence(wl, ml.groupId));
  }
  return lessons.some(wl => !wl.isBandSession && !wl.isGroup && wl.studentId === ml.studentId && wl.instrument === ml.instrument)
      || lessons.some(wl => wl.isBandSession && bandCoversStudentForPresence(wl, ml.studentId, ml.instrument))
      || missed.some(wm => wm.studentId === ml.studentId && wm.instrument === ml.instrument);
}
