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
import { getLiveTeacherId, isLessonUnassigned, timeToMin, to12h } from "./helpers";

// ============================================================
// Teacher double-booking — shared single source of truth (bug-2 + MTT parity).
// Both this file's WTT checker and the MTT shadow checker in TimetableView.js
// MUST resolve the same time-overlap predicate and emit the same cross-school
// wording. Keep these two exported helpers as the only definition — do not
// inline a second copy in either checker.
// ============================================================

// Time-overlap predicate (Matt's option 1): the exact-start clause catches
// freshly-added zero-duration cards; the range clause adds true overlap across
// schools whose slot grids differ. A same-teacher booking at a NON-overlapping
// time must NOT match.
export function lessonTimeOverlaps(lesson, slot) {
  return lesson.start === slot.start ||
    (timeToMin(lesson.start) < timeToMin(slot.end) && timeToMin(lesson.end) > timeToMin(slot.start));
}

// Cross-school clash wording — names the other school + the conflict's time.
export function crossSchoolClashMsg(teacherName, conflict, schools) {
  return `${teacherName} also teaching at ${(schools || []).find(s => s.id === conflict.schoolId)?.name || conflict.schoolName || "another school"} at ${to12h(conflict.start)}`;
}

// ============================================================
// v2.9.9 relational-constraint group acknowledge.
// Single source of truth for the two RELATIONAL (paired) constraint
// detections. Both checkConstraints (which pushes a warning string) and
// getRelationalPartnerIds (which returns the conflicting lessons' ids, so
// acknowledging one card of a conflict can clear the whole group) call these
// — keep all relational matching here, never inline.
// ============================================================

// Same-day double-booking: other lessons for this student on the same day.
// `day` is the candidate day (checkConstraints passes its newDay parameter;
// getRelationalPartnerIds passes the lesson's own day).
function findSameDayConflicts(lesson, day, lessons) {
  return (lessons || []).filter(l => l.id !== lesson.id && l.day === day && (
    l.studentId === lesson.studentId ||
    (l.isGroup && l.studentIds && l.studentIds.includes(lesson.studentId))
  ));
}

// Dual class-time pullout: other class-time lessons for this student on a
// DIFFERENT day. The caller gates on the subject lesson's own slot being a
// "class" slot; this only classifies the partner lessons' slots via schoolSlots.
function findClassTimeConflicts(lesson, day, lessons, schoolSlots) {
  const otherClassLessons = (lessons || []).filter(l =>
    l.id !== lesson.id &&
    l.day !== day &&
    (l.studentId === lesson.studentId || (l.isGroup && l.studentIds && l.studentIds.includes(lesson.studentId)))
  );
  return otherClassLessons.filter(ol => {
    const olSlot = (schoolSlots || []).find(sl => sl.start === ol.start);
    return olSlot && olSlot.type === "class";
  });
}

/**
 * v2.9.9 relational-constraint group acknowledge.
 * Return the ids of every lesson forming a relational conflict GROUP with
 * `lesson` — the union of the two relational detections checkConstraints runs
 * (same-day double-booking + dual class-time pullout). Returns the full group
 * (not just a 2-id pair), so a 3+-lesson same-day clash is fully cleared when
 * any one card is acknowledged.
 *
 * Solo-subject only: relational warning strings are pushed solely from
 * checkConstraints' solo branch, so a group/band subject returns [] (and the
 * subject-keyed studentId filter would otherwise mis-match group cards).
 * Group/band PARTNERS are still returned (a solo lesson can clash with a group
 * lesson that contains the same student).
 *
 * @param lesson         — the acknowledged solo lesson.
 * @param lessons        — the week's lesson list (same list the adjacent
 *                         checkConstraints call uses, e.g. weeklyData.lessons).
 * @param currentSchool  — the current school object; its .slots classify slot
 *                         types for the class-time gate (same value the adjacent
 *                         checkConstraints ctx carries).
 * @returns {string[]} partner lesson ids (excludes `lesson.id` itself).
 */
export function getRelationalPartnerIds(lesson, lessons, currentSchool) {
  if (!lesson || lesson.isGroup || lesson.isBandSession) return [];
  const ids = new Set();
  for (const l of findSameDayConflicts(lesson, lesson.day, lessons)) ids.add(l.id);
  const slots = (currentSchool && currentSchool.slots) ? currentSchool.slots : [];
  const ownSlot = slots.find(sl => sl.start === lesson.start);
  if (ownSlot && ownSlot.type === "class") {
    for (const l of findClassTimeConflicts(lesson, lesson.day, lessons, slots)) ids.add(l.id);
  }
  return [...ids];
}

/**
 * v2.9.12 past-dated display gate.
 *
 * A constraint warning should DISPLAY on a lesson card only when:
 *   (a) the card's own date is today-or-later, AND
 *   (b) every relational-conflict partner (same-day double-booking /
 *       dual class-time pullout) is ALSO today-or-later — so a relational
 *       pair vanishes together the moment either side falls into the past.
 *
 * Non-relational-only cards satisfy (b) trivially (no partners); group/band
 * cards have no relational partners, so only (a) applies. This is a pure
 * DISPLAY gate — acknowledgement state, the warning strings, and the
 * constraint checker are all untouched; past lessons simply render as if
 * they had no warnings (if a date later moves forward, the existing ack
 * state applies again exactly as before).
 *
 * Dates are resolved via weekDateMap (day name -> 'YYYY-MM-DD'), the Weekly
 * view's canonical per-lesson date source (lessons don't carry their own
 * date). `todayStr` is a 'YYYY-MM-DD' string (e.g. melbourneToday()); the
 * YYYY-MM-DD format makes a plain string comparison a valid date comparison.
 * If a lesson's date can't be resolved (no weekDateMap entry — e.g. the
 * date-less Master Timetable), the gate fails OPEN and the warning shows as
 * before.
 *
 * @param lesson        — the card being gated.
 * @param lessons       — the week's lesson list (for partner lookup).
 * @param todayStr      — 'YYYY-MM-DD' reference for "today".
 * @param weekDateMap   — { [dayName]: 'YYYY-MM-DD' } for the displayed week.
 * @param currentSchool — current school object; forwarded to
 *                        getRelationalPartnerIds (its slots classify the
 *                        class-time partners).
 * @returns {boolean} true if warnings should display for this lesson.
 */
export function isConstraintVisibleForLesson(lesson, lessons, todayStr, weekDateMap, currentSchool) {
  if (!lesson) return false;
  const dateOf = (l) => (l && weekDateMap ? weekDateMap[l.day] : null);
  const own = dateOf(lesson);
  if (own && own < todayStr) return false;                       // (a)
  for (const pid of getRelationalPartnerIds(lesson, lessons, currentSchool)) {
    const partner = (lessons || []).find(l => l.id === pid);
    const pd = dateOf(partner);
    if (pd && pd < todayStr) return false;                       // (b)
  }
  return true;
}

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
 *                         students, enrolments, teachers, schools,
 *                         groups, weekDateMap, weekInterruptions,
 *                         specLookupRef, timetable }
 */
export function checkConstraints(lesson, newDay, slot, _lessonList, ctx) {
  const {
    weekKey, selectedSchool, currentSchool, weeklyTimetables,
    teacherCoverage, laneOverrides, students, enrolments, teachers,
    schools, groups, weekDateMap, weekInterruptions,
    specLookupRef, timetable, temporaryLanes = [], crossSchoolLessons,
  } = ctx;

  // Bug-2: same-teacher time-overlap clash detection. The teacher-double-booking
  // branches (solo/group/band) search this cross-school pool when supplied,
  // falling back to the single-school list otherwise so non-WTT callers are
  // unchanged. Time-overlap predicate (Matt's option 1): a same-teacher booking
  // at another school on the same day at a NON-overlapping time must NOT warn.
  // The exact-start clause is kept (catches freshly-added zero-duration cards);
  // the range clause adds true overlap across differing per-school slot grids.
  const teacherClash = (pool, conflictTeacherId, validatedLesson) =>
    (crossSchoolLessons || pool).find(l =>
      l.id !== validatedLesson.id &&
      getLiveTeacherId(l, students, enrolments, teacherCoverage, laneOverrides, weekKey, temporaryLanes) === conflictTeacherId &&
      l.day === newDay &&
      lessonTimeOverlaps(l, slot)
    );

  // Cross-school clash wording: name the other school + the conflict's time.
  // Same-school conflicts keep each branch's existing message untouched.
  const crossSchoolMsg = (teacherName, conflict) => crossSchoolClashMsg(teacherName, conflict, schools);

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
    // Band de-allocation — the band record's teacherId fallback is removed;
    // the occupying lane (via getCardTeacherId) is the sole teacher identity
    // for band clash detection, same as lesson cards.
    const effectiveBandTeacherId = getCardTeacherId(lesson, teacherCoverage, laneOverrides, weekKey, temporaryLanes);
    const teacher = teachers.find(t => t.id === effectiveBandTeacherId);
    if (teacher && school) {
      const conflict = teacherClash(lessonsToCheck, effectiveBandTeacherId, lesson);
      if (conflict) warnings.push(conflict.schoolId !== lesson.schoolId ? crossSchoolMsg(teacher.name, conflict) : `${teacher.name} is double-booked at this time`);
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
    // Teacher double-booking for groups
    const school = schools.find(s => s.id === lesson.schoolId);
    // Cluster 12a: stamped lesson.teacherId fallback removed; lane / live-group only.
    const liveGroup = groups?.find(g => g.id === lesson.groupId);
    const effectiveGroupTeacherId = getCardTeacherId(lesson, teacherCoverage, laneOverrides, weekKey, temporaryLanes) || liveGroup?.teacherId;
    const teacher = teachers.find(t => t.id === effectiveGroupTeacherId);
    if (teacher && school) {
      const conflict = teacherClash(lessonsToCheck, effectiveGroupTeacherId, lesson);
      if (conflict) warnings.push(conflict.schoolId !== lesson.schoolId ? crossSchoolMsg(teacher.name, conflict) : `${teacher.name} already has ${conflict.isGroup ? conflict.groupName || "Group" : conflict.studentName} at this time`);
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
  const _wttUnassigned = isLessonUnassigned(lesson, students, enrolments, teacherCoverage, laneOverrides, weekKey, temporaryLanes);
  if (_wttUnassigned) {
    warnings.push("No teacher assigned — assign a teacher in student details");
  }
  // Lane-first via getLiveTeacherId; fallback chain (instrument enrolment → stamped) lives in the helper.
  const liveTeacherId = getLiveTeacherId(lesson, students, enrolments, teacherCoverage, laneOverrides, weekKey, temporaryLanes);
  const teacher = _wttUnassigned ? null : teachers.find(t => t.id === liveTeacherId);
  if (teacher) {
    // Teacher double-booking: another lesson at the same time with the same teacher
    const _wd1 = weeklyTimetables[`${weekKey}|${selectedSchool}`];
    const lessonsToCheck1 = _lessonList || (_wd1 ? _wd1.lessons : (timetable ? timetable.lessons : []));
    const conflict1 = teacherClash(lessonsToCheck1, liveTeacherId, lesson);
    if (conflict1) warnings.push(conflict1.schoolId !== lesson.schoolId ? crossSchoolMsg(teacher.name, conflict1) : `${teacher.name} already has ${conflict1.isGroup ? conflict1.groupName || "Group" : (students.find(s => s.id === conflict1.studentId)?.name || conflict1.studentName)} at this time`);
  }

  // Multi-lesson students: must have lessons on different days
  const _wd2 = weeklyTimetables[`${weekKey}|${selectedSchool}`];
  const lessonsToCheck2 = _lessonList || (_wd2 ? _wd2.lessons : (timetable ? timetable.lessons : []));
  const otherLessons = findSameDayConflicts(lesson, newDay, lessonsToCheck2);
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
    const classTimeConflicts = findClassTimeConflicts(
      lesson, newDay, lessonsToCheck2,
      (currentSchool && currentSchool.slots) ? currentSchool.slots : []
    );
    if (classTimeConflicts.length > 0) {
      const studentObj = student || { name: lesson.studentName };
      warnings.push(`${studentObj.name} already has a lesson during class on ${classTimeConflicts[0].day}`);
    }
  }

  return warnings;
}
