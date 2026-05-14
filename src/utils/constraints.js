// ============================================================
// constraints.js — pure constraint-warning helper
//
// Extracted from WeeklyAdjustments.js in Session 5B Part 1.
// Unblocks Session 5B Part 2 (Dashboard dropdown consumer) by
// making per-lesson warning computation callable outside the
// WeeklyAdjustments component scope.
// ============================================================

import { hasMissedEntry } from "./tallyDerive";
import { classMatchesInterruption } from "../data/weeklyTimetableGenerator";
import { getCardTeacherId } from "./teacherCoverageDB";
import { getLiveTeacherId, isLessonUnassigned, timeToMin } from "./helpers";

/**
 * Compute constraint warnings for a single lesson in a (day, slot, lessons)
 * context, with all environment data supplied via ctx.
 *
 * Pure function — does not mutate any input. Returns an array of warning
 * strings. Extracted from WeeklyAdjustments.js in Session 5B Part 1 to allow
 * the Dashboard dropdown (Session 5B Part 2) to compute per-day warning
 * counts across all schools.
 *
 * @param lesson       — the lesson row being validated.
 * @param newDay       — the candidate day name ("Monday" ... "Friday").
 * @param slot         — the candidate slot { start, end, type, ... }.
 * @param _lessonList  — optional explicit lesson set; falls back to
 *                       weeklyTimetables[weekKey|selectedSchool].lessons,
 *                       then timetable.lessons.
 * @param ctx          — captured environment:
 *                       { weekKey, selectedSchool, currentSchool,
 *                         weeklyTimetables, teacherCoverage, laneOverrides,
 *                         students, enrolments, teachers, schools, bands,
 *                         groups, weekDateMap, weekInterruptions,
 *                         specLookupRef, timetable }
 */
export function checkConstraints(lesson, newDay, slot, _lessonList, ctx) {
  const {
    weekKey, selectedSchool, currentSchool, weeklyTimetables,
    teacherCoverage, laneOverrides, students, enrolments, teachers,
    schools, bands, groups, weekDateMap, weekInterruptions,
    specLookupRef, timetable,
  } = ctx;

  if (lesson.isBandSession) {
    const warnings = [];
    const memberIds = (lesson.members || []).map(m => m.studentId);
    const _weeklyData = weeklyTimetables[`${weekKey}|${selectedSchool}`];
    const lessonsToCheck = _lessonList || (_weeklyData ? _weeklyData.lessons : (timetable ? timetable.lessons : []));
    for (const mid of memberIds) {
      const memberLesson = lessonsToCheck.find(l => l.id !== lesson.id && l.day === newDay && !l.isBandSession && l.studentId === mid);
      if (memberLesson) {
        const memberStudent = students.find(s => s.id === mid);
        warnings.push(`${memberStudent?.name || mid} already has a lesson on ${newDay} (${memberLesson.instrument})`);
      }
    }
    const school = schools.find(s => s.id === lesson.schoolId);
    const liveBand = bands?.find(b => b.id === lesson.bandId);
    // Cluster 12a: stamped lesson.teacherId fallback removed.
    const effectiveBandTeacherId = getCardTeacherId(lesson, teacherCoverage, laneOverrides, weekKey) || liveBand?.teacherId;
    const teacher = teachers.find(t => t.id === effectiveBandTeacherId);
    if (teacher && school) {
      const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === newDay);
      if (!dayAvail) {
        warnings.push(`${teacher.name} not available at ${school.name} on ${newDay}`);
      } else {
        const slotStart = timeToMin(slot.start), slotEnd = timeToMin(slot.end);
        if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) {
          warnings.push(`Outside ${teacher.name}'s hours (${dayAvail.start}–${dayAvail.end})`);
        }
      }
      const conflict = lessonsToCheck.find(l => l.id !== lesson.id && getLiveTeacherId(l, students, enrolments, teacherCoverage, laneOverrides, weekKey) === effectiveBandTeacherId && l.day === newDay && l.start === slot.start);
      if (conflict) warnings.push(`${teacher.name} is double-booked at this time`);
    }
    const targetDate = weekDateMap[newDay];
    if (targetDate) {
      for (const intr of weekInterruptions) {
        if (intr.schoolId !== lesson.schoolId && intr.schoolId !== "all") continue;
        const iStart = intr.date, iEnd = intr.endDate || intr.date;
        if (targetDate < iStart || targetDate > iEnd) continue;
        if (intr.startTime && intr.endTime) {
          const sStart = timeToMin(slot.start), sEnd = timeToMin(slot.end);
          if (sStart >= timeToMin(intr.endTime) || sEnd <= timeToMin(intr.startTime)) continue;
        }
        warnings.push(`⚠ ${intr.title} — interruption on ${newDay}`);
        break;
      }
    }
    return warnings;
  }
  if (lesson.isGroup) {
    const warnings = [];
    const memberIds = lesson.studentIds || [];
    const _weeklyData = weeklyTimetables[`${weekKey}|${selectedSchool}`];
    const lessonsToCheck = _lessonList || (_weeklyData ? _weeklyData.lessons : (timetable ? timetable.lessons : []));
    for (const mid of memberIds) {
      const memberLesson = lessonsToCheck.find(l => l.id !== lesson.id && l.day === newDay && (
        l.studentId === mid || (l.isGroup && l.studentIds && l.studentIds.includes(mid))
      ));
      if (memberLesson) {
        const memberStudent = students.find(s => s.id === mid);
        const memberName = memberStudent ? memberStudent.name : mid;
        warnings.push(`${memberName} already has a lesson on ${newDay} (${memberLesson.isGroup ? memberLesson.groupName || "Group" : memberLesson.instrument})`);
      }
    }
    // Teacher availability and double-booking for groups
    const school = schools.find(s => s.id === lesson.schoolId);
    // Cluster 12a: stamped lesson.teacherId fallback removed; lane / live-group only.
    const liveGroup = groups?.find(g => g.id === lesson.groupId);
    const effectiveGroupTeacherId = getCardTeacherId(lesson, teacherCoverage, laneOverrides, weekKey) || liveGroup?.teacherId;
    const teacher = teachers.find(t => t.id === effectiveGroupTeacherId);
    if (teacher && school) {
      const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === newDay);
      if (!dayAvail) {
        warnings.push(`${teacher.name} not available at ${school.name} on ${newDay}`);
      } else {
        const slotStart = timeToMin(slot.start);
        const slotEnd = timeToMin(slot.end);
        if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) {
          warnings.push(`Outside ${teacher.name}'s hours (${dayAvail.start}–${dayAvail.end})`);
        }
      }
      const conflict = lessonsToCheck.find(l => l.id !== lesson.id && getLiveTeacherId(l, students, enrolments, teacherCoverage, laneOverrides, weekKey) === effectiveGroupTeacherId && l.day === newDay && l.start === slot.start);
      if (conflict) warnings.push(`${teacher.name} already has ${conflict.isGroup ? conflict.groupName || "Group" : conflict.studentName} at this time`);
    }
    // Interruption check for groups
    const targetDate = weekDateMap[newDay];
    if (targetDate) {
      for (const intr of weekInterruptions) {
        if (intr.schoolId !== lesson.schoolId && intr.schoolId !== "all") continue;
        const iStart = intr.date, iEnd = intr.endDate || intr.date;
        if (targetDate < iStart || targetDate > iEnd) continue;
        if (intr.startTime && intr.endTime) {
          const sStart = timeToMin(slot.start), sEnd = timeToMin(slot.end);
          if (sStart >= timeToMin(intr.endTime) || sEnd <= timeToMin(intr.startTime)) continue;
        }
        warnings.push(`⚠ ${intr.title} — interruption on ${newDay}`);
        break;
      }
    }
    return warnings;
  }
  const student = students.find(s => s.id === lesson.studentId);
  if (!student) return [];
  const school = schools.find(s => s.id === lesson.schoolId);
  if (!school) return [];
  const warnings = [];
  const slotStart = timeToMin(slot.start);
  const slotEnd = timeToMin(slot.end);
  const hints = student._noteHints || {};

  // Pre-marked absence: warn if student has an informed_absence missed entry for this week
  const hasPreMarkedAbsence = hasMissedEntry({
    weeklyTimetables,
    studentId: lesson.studentId,
    weekKey,
    reasons: ["informed_absence"],
  });
  if (hasPreMarkedAbsence) warnings.push("⚠ Pre-marked absence this week — student not expected in");
  const hasRequiredHere = (hints.requiredTimes || []).some(function(rt) { return rt.day === newDay && rt.start === slot.start; });
  if (slot.type === "before_school" && !student.availableBefore && !hasRequiredHere) warnings.push("Student not available before school");
  if (slot.type === "after_school" && !student.availableAfter && !hasRequiredHere) warnings.push("Student not available after school");
  const isBreak = ["recess", "lunch"].includes(slot.type);
  const isBeforeAfter = ["before_school", "after_school"].includes(slot.type);
  if (student.outsideClassOnly && !isBreak && !isBeforeAfter) warnings.push("Student should only be scheduled outside class time");
  if (student.outsideClassPreferred && !isBreak && !isBeforeAfter && slot.type === "class") warnings.push("Student prefers outside class time");
  if (student.avoidRecessLunch && isBreak) warnings.push("Student prefers to avoid recess/lunch lessons");
  if (hints.avoidTimes) {
    for (const at of hints.avoidTimes) {
      if (at.day === newDay && slotStart < timeToMin(at.end) && slotEnd > timeToMin(at.start)) warnings.push(`Avoid time: ${at.day} ${at.start}–${at.end}`);
    }
  }
  if (hints.avoidDays && hints.avoidDays.includes(newDay)) warnings.push(`Student should avoid ${newDay}`);
  if (hints.preferredDays && hints.preferredDays.length > 0 && !hints.preferredDays.includes(newDay)) warnings.push(`Preferred day${hints.preferredDays.length > 1 ? "s" : ""}: ${hints.preferredDays.join(", ")}`);
  const _wttUnassigned = isLessonUnassigned(lesson, students, enrolments, teacherCoverage, laneOverrides, weekKey);
  if (_wttUnassigned) {
    warnings.push("No teacher assigned — assign a teacher in student details");
  }
  // Lane-first via getLiveTeacherId; fallback chain (instrument enrolment → stamped) lives in the helper.
  const liveTeacherId = getLiveTeacherId(lesson, students, enrolments, teacherCoverage, laneOverrides, weekKey);
  const teacher = _wttUnassigned ? null : teachers.find(t => t.id === liveTeacherId);
  if (teacher) {
    const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === newDay);
    if (!dayAvail) warnings.push(`${teacher.name} not available on ${newDay}`);
    else if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) warnings.push(`Outside ${teacher.name}'s hours (${dayAvail.start}–${dayAvail.end})`);
    // Teacher double-booking: another lesson at the same time with the same teacher
    const _wd1 = weeklyTimetables[`${weekKey}|${selectedSchool}`];
    const lessonsToCheck1 = _lessonList || (_wd1 ? _wd1.lessons : (timetable ? timetable.lessons : []));
    const conflict1 = lessonsToCheck1.find(l => l.id !== lesson.id && getLiveTeacherId(l, students, enrolments, teacherCoverage, laneOverrides, weekKey) === liveTeacherId && l.day === newDay && l.start === slot.start);
    if (conflict1) warnings.push(`${teacher.name} already has ${conflict1.isGroup ? conflict1.groupName || "Group" : (students.find(s => s.id === conflict1.studentId)?.name || conflict1.studentName)} at this time`);
  }

  // Multi-lesson students: must have lessons on different days
  const _wd2 = weeklyTimetables[`${weekKey}|${selectedSchool}`];
  const lessonsToCheck2 = _lessonList || (_wd2 ? _wd2.lessons : (timetable ? timetable.lessons : []));
  const otherLessons = lessonsToCheck2.filter(l => l.id !== lesson.id && l.day === newDay && (
    l.studentId === lesson.studentId ||
    (l.isGroup && l.studentIds && l.studentIds.includes(lesson.studentId))
  ));
  if (otherLessons.length > 0) {
    const studentObj = student || { name: lesson.studentName };
    warnings.push(`${studentObj.name} already has a lesson on ${newDay} (${otherLessons.map(l => l.isGroup ? l.groupName || "Group" : l.instrument).join(", ")})`);
  }

  // Interruption check — warn if this slot falls within an active interruption
  const targetDate = weekDateMap[newDay];
  if (targetDate) {
    for (const intr of weekInterruptions) {
      // School filter — mirrors generator pattern at weeklyTimetableGenerator.js:43.
      // Interruptions with schoolId === "all" apply globally; otherwise only the
      // matching school's lessons get flagged.
      if (intr.schoolId !== lesson.schoolId && intr.schoolId !== "all") continue;
      const iStart = intr.date, iEnd = intr.endDate || intr.date;
      if (targetDate < iStart || targetDate > iEnd) continue;
      // Class filter
      if (intr.affectsClasses !== "all") {
        const cls = student?.className || lesson.studentName || "";
        if (!classMatchesInterruption(cls, intr.affectsClasses)) continue;
      }
      // Time filter
      if (intr.startTime && intr.endTime) {
        const sStart = timeToMin(slot.start), sEnd = timeToMin(slot.end);
        if (sStart >= timeToMin(intr.endTime) || sEnd <= timeToMin(intr.startTime)) continue;
      }
      warnings.push(`⚠ ${intr.title} — interruption on ${newDay}`);
      break;
    }
  }

  // Specialist clash — any overlap between lesson slot and specialist time
  if (student && student.className) {
    const key = lesson.schoolId + "|" + student.className + "|" + newDay;
    const specs = specLookupRef[key] || [];
    const match = specs.find(sp => slotStart < sp.end && slotEnd > sp.start);
    if (match) {} // specialist shown as purple tag, not a red warning
  }

  // Dual class-time pullout: warn if this slot is during class and the student already has
  // another class-time lesson on a different day in the same week
  if (slot.type === "class") {
    const allWeekLessons = lessonsToCheck2;
    const otherClassLessons = allWeekLessons.filter(l =>
      l.id !== lesson.id &&
      l.day !== newDay &&
      (l.studentId === lesson.studentId || (l.isGroup && l.studentIds && l.studentIds.includes(lesson.studentId)))
    );
    if (otherClassLessons.length > 0) {
      const classTimeConflicts = otherClassLessons.filter(ol => {
        const olSlot = (currentSchool && currentSchool.slots ? currentSchool.slots : []).find(sl => sl.start === ol.start);
        return olSlot && olSlot.type === "class";
      });
      if (classTimeConflicts.length > 0) {
        const studentObj = student || { name: lesson.studentName };
        warnings.push(`${studentObj.name} already has a lesson during class on ${classTimeConflicts[0].day}`);
      }
    }
  }

  return warnings;
}
