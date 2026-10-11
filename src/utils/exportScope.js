// ============================================================
// exportScope.js — the Export dialog's teacher scope, as pure helpers.
// v2.49.15: extracted from ExportDialog so the teacher picker, preview
// filter and Teacher Schedules list are testable with the real code.
// ============================================================

import { getLiveTeacherName } from "./helpers";

/**
 * Week context for teacher resolution. A week source passes the live lane
 * overrides, its weekKey and its missed[] (band rows); the master source
 * passes null/null/undefined (lane-only, unchanged).
 */
export function exportWeekContext(selectedWeek, laneOverrides) {
  return {
    weekKey: selectedWeek ? selectedWeek.weekKey : null,
    laneOverrides: selectedWeek ? laneOverrides : null,
    missed: selectedWeek ? selectedWeek.missed : undefined,
  };
}

/**
 * Teacher names, class names and the preview/teacher filter for the dialog.
 * `day` is the dialog's Set of selected days (empty = every day).
 */
export function buildExportScope({ sourceLessons, students, teachers, enrolments, teacherCoverage, weekContext, schoolId, teacherName, className, day }) {
  const ctx = weekContext || {};
  const resolveLessonTeacherName = (l) => getLiveTeacherName(l, students, teachers, enrolments, teacherCoverage, ctx.laneOverrides, ctx.weekKey) || "";
  const scopedLessons = schoolId ? sourceLessons.filter(l => l.schoolId === schoolId) : sourceLessons;
  // Cluster 12a: lane-resolved name list rather than stamped lesson.teacherName.
  const teacherNames = [...new Set(scopedLessons.map(resolveLessonTeacherName).filter(n => n))].sort();
  const classNames = [...new Set(students.filter(s => scopedLessons.some(l => l.studentId === s.id) && s.className).map(s => s.className))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const days = day || new Set();
  const previewLessons = scopedLessons.filter(l => {
    if (teacherName && resolveLessonTeacherName(l) !== teacherName) return false;
    if (className) { const sids = new Set(students.filter(s => s.className === className).map(s => s.id)); if (!sids.has(l.studentId)) return false; }
    if (days.size > 0 && !days.has(l.day)) return false;
    return true;
  });
  const scheduleTeachers = [...new Set((schoolId ? sourceLessons.filter(l => l.schoolId === schoolId) : sourceLessons).map(resolveLessonTeacherName).filter(n => n))].sort();
  const scheduleTeachersFiltered = teacherName ? scheduleTeachers.filter(t => t === teacherName) : scheduleTeachers;
  return { resolveLessonTeacherName, scopedLessons, teacherNames, classNames, previewLessons, scheduleTeachers, scheduleTeachersFiltered };
}
