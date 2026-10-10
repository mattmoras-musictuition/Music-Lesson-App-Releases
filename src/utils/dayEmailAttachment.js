// ============================================================
// dayEmailAttachment.js — v2.49.12 which lessons the weekly day-header email
// attaches as the day's timetable, and under whose name.
//
//   For teacher X (Staff → a named teacher): every lesson goes in and X's
//   full name is passed as teacherName; generateExportHtml's own week-aware
//   teacher filter (temporary teachers included) keeps X's lessons, heads
//   the page with X and counts X's breaks. Independent of the selected chip,
//   and X's lessons on a retired or ended slot are included.
//
//   Selected chip (everything else): the day's lessons filtered exactly as
//   the recipient lists are (lessonBelongsToViewedLane with weekKey and the
//   week's temporary lanes). No teacherName, so the header names the chip's
//   teacher. On a single-lane day every lesson passes, as before.
// ============================================================

import { lessonBelongsToViewedLane } from "./teacherCoverageDB";

export function pickDayAttachment({ lessons, day, schoolId, weekKey, teacherCoverage, viewedLanes, temporaryLanes = [], forTeacherName = null }) {
  if (forTeacherName) return { lessons: lessons || [], teacherName: forTeacherName };
  return {
    lessons: (lessons || []).filter(l => l.day === day
      && lessonBelongsToViewedLane(l, viewedLanes, teacherCoverage, schoolId, weekKey, temporaryLanes)),
    teacherName: null,
  };
}
