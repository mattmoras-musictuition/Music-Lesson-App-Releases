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
//   the recipient lists are (lessonInViewedLaneForEmail with weekKey, the
//   week's temporary lanes and lane overrides — v2.49.15: a lesson left on a
//   lane that no longer applies goes under its own teacher's chip, else the
//   first chip). No teacherName, so the header names the chip's teacher. On a
//   single-lane day every lesson passes, as before.
// ============================================================

import { lessonInViewedLaneForEmail } from "./teacherCoverageDB";

// v2.49.15 — the lessons behind the weekly day-header email menu for the
// selected chip(s): the Parents / Class Teachers / Staff recipient lists read
// this for every active day, and the selected-chip attachment for its day.
export function dayHeaderEmailLessons({ lessons, days, schoolId, weekKey, teacherCoverage, viewedLanes, temporaryLanes = [], laneOverrides = null }) {
  return (lessons || []).filter(l => days.includes(l.day)
    && lessonInViewedLaneForEmail(l, viewedLanes, teacherCoverage, schoolId, weekKey, temporaryLanes, laneOverrides));
}

export function pickDayAttachment({ lessons, day, schoolId, weekKey, teacherCoverage, viewedLanes, temporaryLanes = [], laneOverrides = null, forTeacherName = null }) {
  if (forTeacherName) return { lessons: lessons || [], teacherName: forTeacherName };
  return {
    lessons: dayHeaderEmailLessons({ lessons, days: [day], schoolId, weekKey, teacherCoverage, viewedLanes, temporaryLanes, laneOverrides }),
    teacherName: null,
  };
}
