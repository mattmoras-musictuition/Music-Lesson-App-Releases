// ============================================================
// TIMETABLE GENERATOR
// Master timetable generation algorithm, compaction pass, and
// the helper functions that support scheduling logic.
// ============================================================

import { uid, timeToMin } from "../utils/helpers";
import { defaultSlots } from "../utils/backup";
import { DAYS } from "../constants";
import { instrumentsFromEnrolments } from "../utils/enrolmentsDB";
import { findLaneId, getCardTeacherId } from "../utils/teacherCoverageDB";

// ── getSpecialistSubject ──────────────────────────────────────────────────────
// Used inside generateMasterTimetable AND exported for TimetableView warnings.

export function getSpecialistSubject(specLookup, schoolId, className, day, slotStart, slotEnd, allowedSubjects) {
  const key = `${schoolId}|${className}|${day}`;
  const specs = specLookup[key];
  if (!specs) return false;
  const sStart = timeToMin(slotStart);
  const sEnd = timeToMin(slotEnd);
  return specs.some(sp => {
    const spStart = timeToMin(sp.start);
    const spEnd = timeToMin(sp.end);
    if (sStart < spEnd && sEnd > spStart) {
      return allowedSubjects.some(subj => sp.subject.toLowerCase().includes(subj.toLowerCase()) || subj.toLowerCase().includes(sp.subject.toLowerCase()));
    }
    return false;
  });
}

// ── isSlotAllowed ─────────────────────────────────────────────────────────────

export function isSlotAllowed(slot, student, school, mustBeOutsideClass, slotIsSpecialist, day, hints) {
  const isBreakType = ["recess", "lunch"].includes(slot.type);
  const isBeforeAfter = ["before_school", "after_school"].includes(slot.type);

  // Before/after school slots require the student to have opted in
  // UNLESS their notes specify a required time at this slot
  const hasRequiredHere = hints && (hints.requiredTimes || []).some(function(rt) { return rt.day === day && rt.start === slot.start; });
  if (slot.type === "before_school" && !student.availableBefore && !hasRequiredHere) return false;
  if (slot.type === "after_school" && !student.availableAfter && !hasRequiredHere) return false;

  // If student must be outside class time only
  if (student.outsideClassOnly) {
    if (!isBreakType && !isBeforeAfter) return false;
  }

  // Check avoid times from notes (hard constraint — skip these slots)
  if (hints && hints.avoidTimes && hints.avoidTimes.length > 0) {
    const slotStart = timeToMin(slot.start);
    const slotEnd = timeToMin(slot.end);
    for (const at of hints.avoidTimes) {
      if (at.day === day) {
        const avStart = timeToMin(at.start);
        const avEnd = timeToMin(at.end);
        if (slotStart < avEnd && slotEnd > avStart) return false;
      }
    }
  }

  // Check avoid days from notes (hard constraint)
  if (hints && hints.avoidDays && hints.avoidDays.includes(day)) return false;

  // Multi-instrument constraint: this instrument must be outside class time
  // UNLESS requiredTimes explicitly specify this slot
  if (mustBeOutsideClass && !hasRequiredHere) {
    if (!slotIsSpecialist && !isBreakType && !isBeforeAfter) return false;
  }

  // Specialist class scheduling rules (for primary instrument in class time)
  if (!mustBeOutsideClass && slotIsSpecialist && slot.type === "class") {
    if (school.specialistPolicy === "no") return false;
  }

  return true;
}

// ── scheduleReadyGroups ───────────────────────────────────────────────────────

export function scheduleReadyGroups(readyGroupsOrAll, existingLessons, schools, students, teachers, specialists, teacherCoverage = []) {
  const readyGroups = readyGroupsOrAll.filter(g => g.status === "ready");
  const scheduled = [];
  const failed = [];

  // Build teacher slot usage from existing lessons
  const teacherUsed = {};
  for (const l of existingLessons) {
    const lTeacherId = getCardTeacherId(l, teacherCoverage);
    if (!lTeacherId) continue;
    if (!teacherUsed[lTeacherId]) teacherUsed[lTeacherId] = new Set();
    teacherUsed[lTeacherId].add(`${l.day}|${l.start}`);
  }

  for (const group of readyGroups) {
    const school = schools.find(s => s.id === group.schoolId);
    const teacher = teachers.find(t => t.id === group.teacherId);
    if (!school || !teacher) {
      failed.push({ student: { id: group.id, name: group.name, schoolId: group.schoolId }, instrument: group.instrument || "Group", reason: !school ? "School not found" : "Teacher not found", isGroup: true });
      continue;
    }

    const teacherAvail = teacher.availability.filter(a => a.schoolId === school.id);
    if (teacherAvail.length === 0) {
      failed.push({ student: { id: group.id, name: group.name, schoolId: group.schoolId }, instrument: group.instrument || "Group", reason: `${teacher.name} not available at ${school.name}`, isGroup: true });
      continue;
    }

    if (!teacherUsed[teacher.id]) teacherUsed[teacher.id] = new Set();
    let booked = false;

    // Build list of teacher's existing lesson times for adjacency scoring
    const teacherExistingTimes = existingLessons
      .filter(l => getCardTeacherId(l, teacherCoverage) === teacher.id && l.schoolId === school.id)
      .map(l => ({ day: l.day, start: timeToMin(l.start), end: timeToMin(l.end) }));

    // Prefer days where teacher already has lessons (packing)
    const sortedDays = [...school.days].sort((a, b) => {
      const aCount = teacherExistingTimes.filter(t => t.day === a).length;
      const bCount = teacherExistingTimes.filter(t => t.day === b).length;
      return bCount - aCount;
    });

    for (const day of sortedDays) {
      if (booked) break;
      const dayAvail = teacherAvail.find(a => a.day === day);
      if (!dayAvail) continue;
      const availStart = timeToMin(dayAvail.start);
      const availEnd = timeToMin(dayAvail.end);

      // Sort slots by adjacency to existing teacher lessons (back-to-back preferred)
      const sortedSlots = [...school.slots].filter(s => s.type === "class").sort((a, b) => {
        const aMin = timeToMin(a.start);
        const bMin = timeToMin(b.start);
        const dayTimes = teacherExistingTimes.filter(t => t.day === day);
        if (dayTimes.length === 0) return aMin - bMin;
        const aGap = Math.min(...dayTimes.map(t => Math.min(Math.abs(aMin - t.end), Math.abs(t.start - timeToMin(a.end)))));
        const bGap = Math.min(...dayTimes.map(t => Math.min(Math.abs(bMin - t.end), Math.abs(t.start - timeToMin(b.end)))));
        return aGap - bGap;
      });

      for (const slot of sortedSlots) {
        if (booked) break;
        if (slot.type !== "class") continue;
        const slotStart = timeToMin(slot.start);
        const slotEnd = timeToMin(slot.end);
        if (slotStart < availStart || slotEnd > availEnd) continue;
        if (teacherUsed[teacher.id].has(`${day}|${slot.start}`)) continue;

        // Check school-level breaks
        const schoolBreaks = (school.teacherBreaks || []).map(b => ({ start: timeToMin(b.start), end: timeToMin(b.end), day: b.day || "All" }));
        const sMid = (slotStart + slotEnd) / 2;
        if (schoolBreaks.some(b => (b.day === "All" || b.day === day) && sMid >= b.start && sMid < b.end)) continue;

        // Check teacher-level breaks
        const tBreaks = (teacher.teacherBreaks || []).filter(b => b.schoolId === school.id);
        if (tBreaks.some(b => {
          const bDay = b.day || "All";
          if (bDay !== "All" && bDay !== day) return false;
          return sMid >= timeToMin(b.start) && sMid < timeToMin(b.end);
        })) continue;

        // Check specialist policy — skip specialist slots if policy is "no"
        if (school.specialistPolicy === "no") {
          const memberClasses = group.studentIds.map(sid => {
            const st = students.find(s => s.id === sid);
            return st?.className || "";
          }).filter(Boolean);
          let isSpec = false;
          for (const cn of memberClasses) {
            const specEntries = specialists || [];
            for (const sp of specEntries) {
              if (sp.schoolId === school.id && sp.className === cn && sp.day === day) {
                const spS = timeToMin(sp.start), spE = timeToMin(sp.end);
                if (sMid >= spS && sMid < spE) { isSpec = true; break; }
              }
            }
            if (isSpec) break;
          }
          if (isSpec) continue;
        }

        // Spec 2 cluster 4b — resolve lane before stamping. Skip if no
        // active lane covers (school, day, teacher); the regenerate flow
        // surfaces missing lanes via the failed/unscheduled arrays.
        const bucketId = findLaneId(teacherCoverage, school.id, day, teacher.id);
        if (!bucketId) {
          failed.push({
            student: { id: group.id, name: group.name, schoolId: group.schoolId },
            instrument: group.instrument || "Group",
            reason: `no covering lane for (${school.name}, ${day}, ${teacher.name})`,
            isGroup: true,
          });
          booked = true; // suppress the "No available slot" fallback below — lane absence is the actual reason
          break;
        }
        const lesson = {
          id: uid(),
          isGroup: true, groupId: group.id, groupName: group.name,
          studentId: group.studentIds[0],
          studentName: group.name,
          studentIds: [...group.studentIds],
          studentNames: group.studentIds.map(sid => students.find(s => s.id === sid)?.name || "?"),
          bucket_id: bucketId, teacherName: teacher.name,
          schoolId: school.id, schoolName: school.name,
          day, slotId: slot.id, slotName: slot.name,
          start: slot.start, end: slot.end,
          instrument: group.instrument || "Group",
          duringSpecialist: false
        };
        scheduled.push(lesson);
        teacherUsed[teacher.id].add(`${day}|${slot.start}`);
        booked = true;
      }
    }

    if (!booked) {
      failed.push({ student: { id: group.id, name: group.name, schoolId: group.schoolId }, instrument: group.instrument || "Group", reason: "No available slot for assigned teacher", isGroup: true });
    }
  }

  return { scheduled, failed };
}

// ── generateMasterTimetable ───────────────────────────────────────────────────

export function generateMasterTimetable(schools, students, teachers, enrolments, specialistTimetable = [], { existingLessons = [], targetSchoolId = null, teacherCoverage = [] } = {}) {
  const activeStudents = students.filter(s => s.status === "active");
  const studentsToSchedule = targetSchoolId
    ? activeStudents.filter(s => s.schoolId === targetSchoolId)
    : activeStudents;
  const lessons = [];
  const unscheduled = [];

  // Build teacher availability map: teacher -> day -> [{start, end}]
  const teacherSchedule = {};
  teachers.forEach(t => { teacherSchedule[t.id] = []; });

  // Pre-populate teacher schedules with existing lessons from other schools
  const studentDayMap = {};
  for (const el of existingLessons) {
    const elTeacherId = getCardTeacherId(el, teacherCoverage);
    if (elTeacherId && teacherSchedule[elTeacherId]) {
      teacherSchedule[elTeacherId].push({
        day: el.day, slotId: el.slotId, schoolId: el.schoolId,
        start: el.start, end: el.end
      });
    }
    if (el.studentId) {
      if (!studentDayMap[el.studentId]) studentDayMap[el.studentId] = new Set();
      studentDayMap[el.studentId].add(el.day);
    }
    if (el.isGroup && el.studentIds) {
      for (const sid of el.studentIds) {
        if (!studentDayMap[sid]) studentDayMap[sid] = new Set();
        studentDayMap[sid].add(el.day);
      }
    }
    lessons.push(el);
  }

  // Build break lookup
  const schoolBreaksLookup = {};
  for (const school of schools) {
    schoolBreaksLookup[school.id] = (school.teacherBreaks || []).map(b => ({
      start: timeToMin(b.start), end: timeToMin(b.end)
    }));
  }
  const teacherBreaksLookup = {};
  for (const teacher of teachers) {
    teacherBreaksLookup[teacher.id] = {};
    for (const tb of (teacher.teacherBreaks || [])) {
      if (!teacherBreaksLookup[teacher.id][tb.schoolId]) teacherBreaksLookup[teacher.id][tb.schoolId] = [];
      teacherBreaksLookup[teacher.id][tb.schoolId].push({ start: timeToMin(tb.start), end: timeToMin(tb.end), day: tb.day || "All" });
    }
  }

  // Uses midpoint check: the slot's midpoint must fall within the break window
  const isDuringBreak = (teacherId, schoolId, day, slotStart, slotEnd) => {
    const sStart = timeToMin(slotStart);
    const sEnd = timeToMin(slotEnd);
    const sMid = (sStart + sEnd) / 2;
    const schoolBreaks = schoolBreaksLookup[schoolId];
    if (schoolBreaks && schoolBreaks.length > 0) {
      return schoolBreaks.some(b => sMid >= b.start && sMid < b.end);
    }
    const teacherBreaks = teacherBreaksLookup[teacherId]?.[schoolId] || [];
    if (teacherBreaks.length === 0) return false;
    return teacherBreaks.some(b => (b.day === "All" || b.day === day) && sMid >= b.start && sMid < b.end);
  };

  // Build specialist lookup
  const specLookup = {};
  for (const entry of specialistTimetable) {
    const key = `${entry.schoolId}|${entry.className}|${entry.day}`;
    if (!specLookup[key]) specLookup[key] = [];
    specLookup[key].push({ start: entry.start, end: entry.end, subject: entry.subject, partial: entry._partial || false });
  }

  const isSpecialistTime = (schoolId, className, day, slotStart, slotEnd) => {
    const key = `${schoolId}|${className}|${day}`;
    const specs = specLookup[key];
    if (!specs) return false;
    const sStart = timeToMin(slotStart);
    const sEnd = timeToMin(slotEnd);
    return specs.some(sp => {
      const spStart = timeToMin(sp.start);
      const spEnd = timeToMin(sp.end);
      return sStart < spEnd && sEnd > spStart;
    });
  };

  const getSpecialistName = (schoolId, className, day, slotStart, slotEnd) => {
    const key = `${schoolId}|${className}|${day}`;
    const specs = specLookup[key];
    if (!specs) return null;
    const sStart = timeToMin(slotStart);
    const sEnd = timeToMin(slotEnd);
    const match = specs.find(sp => {
      const spStart = timeToMin(sp.start);
      const spEnd = timeToMin(sp.end);
      return sStart < spEnd && sEnd > spStart;
    });
    return match ? match.subject : null;
  };

  const isPartialSpecialist = (schoolId, className, day, slotStart, slotEnd) => {
    const key = `${schoolId}|${className}|${day}`;
    const specs = specLookup[key];
    if (!specs) return false;
    const sStart = timeToMin(slotStart);
    const sEnd = timeToMin(slotEnd);
    return specs.some(sp => {
      const spStart = timeToMin(sp.start);
      const spEnd = timeToMin(sp.end);
      return sStart < spEnd && sEnd > spStart && sp.partial;
    });
  };

  // Sort students: requiredTimes first, then most constraints, then class grouping
  const sortedStudents = [...studentsToSchedule].sort((a, b) => {
    const aHints = a._noteHints || {};
    const bHints = b._noteHints || {};
    const aRequired = (aHints.requiredTimes || []).length;
    const bRequired = (bHints.requiredTimes || []).length;
    if (aRequired !== bRequired) return bRequired - aRequired;
    const aInsts = instrumentsFromEnrolments(a.id, enrolments);
    const bInsts = instrumentsFromEnrolments(b.id, enrolments);
    const aConstraints = (a.outsideClassOnly ? 3 : 0) + (a.outsideClassPreferred ? 2 : 0) +
      (aInsts.some(i => i.teacherId) ? 2 : 0) +
      ((aHints.avoidDays || []).length * 2) + ((aHints.avoidTimes || []).length * 2) +
      ((aHints.preferredDays || []).length) + ((aHints.preferredTimes || []).length) +
      (aInsts.length > 1 ? 2 : 0) + (aInsts.some(i => i.isGroup) ? 2 : 0);
    const bConstraints = (b.outsideClassOnly ? 3 : 0) + (b.outsideClassPreferred ? 2 : 0) +
      (bInsts.some(i => i.teacherId) ? 2 : 0) +
      ((bHints.avoidDays || []).length * 2) + ((bHints.avoidTimes || []).length * 2) +
      ((bHints.preferredDays || []).length) + ((bHints.preferredTimes || []).length) +
      (bInsts.length > 1 ? 2 : 0) + (bInsts.some(i => i.isGroup) ? 2 : 0);
    if (aConstraints !== bConstraints) return bConstraints - aConstraints;
    if (a.schoolId !== b.schoolId) return a.schoolId < b.schoolId ? -1 : 1;
    if ((a.className || "") !== (b.className || "")) return (a.className || "").localeCompare(b.className || "");
    return 0;
  });

  // Build class membership lookup for classmate clustering
  const classMates = {};
  for (const s of studentsToSchedule) {
    const key = `${s.schoolId}|${s.className || ""}`;
    if (!classMates[key]) classMates[key] = new Set();
    classMates[key].add(s.id);
  }

  for (const student of sortedStudents) {
    const school = schools.find(s => s.id === student.schoolId);
    if (!school) {
      unscheduled.push({ student, reason: "School not found" });
      continue;
    }

    const hints = student._noteHints || {};
    const allRequiredTimes = (hints.requiredTimes || []).filter(rt => rt.day && rt.start && rt.day !== "any");
    const usedRequiredTimeIdxs = new Set();

    const requiredSameDayAllowed = new Set();
    const reqDayCounts = {};
    for (const rt of allRequiredTimes) {
      reqDayCounts[rt.day] = (reqDayCounts[rt.day] || 0) + 1;
    }
    for (const d in reqDayCounts) {
      if (reqDayCounts[d] > 1) requiredSameDayAllowed.add(d);
    }

    const allInsts = instrumentsFromEnrolments(student.id, enrolments);
    const individualInsts = allInsts.filter(i => !i.isGroup);
    if (individualInsts.length === 0) {
      // Suppress emit when student is already covered by a placed group lesson.
      // scheduleReadyGroups runs before this loop and feeds placed group lessons
      // into existingLessons; the entry-time traversal populates studentDayMap
      // for each member of every group lesson. A non-empty studentDayMap means
      // the student has effective scheduling via group — emitting here would
      // be a false positive. Genuinely orphaned group-only students (group
      // failed to schedule) still fall through and emit.
      if (allInsts.length > 0 && (studentDayMap[student.id] || new Set()).size > 0) {
        continue;
      }
      // Pre-Spec-1 the generator silently dropped students with no instruments[].
      // Post-migration: emit an explicit unscheduled reason so the data state is
      // visible rather than the student vanishing from the timetable invisibly.
      // Disambiguate: zero enrolments vs group-only — different remediation paths.
      const reason = allInsts.length === 0
        ? "No instruments — set one in student details"
        : "Group-only enrolment — manage via Groups & Bands";
      unscheduled.push({ student, reason });
      continue;
    }
    const studentExistingDays = studentDayMap[student.id] || new Set();
    const hasGroupLesson = studentExistingDays.size > 0;
    const isMultiInstrument = individualInsts.length > 1 || hasGroupLesson;
    let classTimeUsedFromGroup = hasGroupLesson;

    const scheduleInstruments = (instOrder) => {
      const scheduledLessons = [];
      const scheduledTeacherEntries = [];
      let allScheduled = true;
      let perInstResults = [];
      let classTimeUsed = classTimeUsedFromGroup;
      const usedDays = new Set(studentExistingDays);

      for (let oi = 0; oi < instOrder.length; oi++) {
        const inst = instOrder[oi];
        const mustBeOutsideClass = isMultiInstrument && classTimeUsed;
        let scheduled = false;

        // Spec 2 cluster 4b — accumulator for (day, teacher) combos skipped
        // because no active lane covers them. Surfaced into the perInstResults
        // reason if the lesson doesn't schedule anywhere.
        const laneAbsentDays = new Set();

        let compatibleTeachers = teachers.filter(t => {
          const teachesInst = t.instruments.find(ti => ti.name === inst.name);
          const teachesAtSchool = t.availability.some(a => a.schoolId === school.id);
          return teachesInst && teachesAtSchool;
        });

        if (!inst.teacherId) {
          perInstResults.push({ inst, scheduled: false, reason: "Unassigned" });
          allScheduled = false;
          continue;
        }

        const assignedTeacher = compatibleTeachers.find(t => t.id === inst.teacherId);
        if (assignedTeacher) {
          compatibleTeachers = [assignedTeacher];
        } else {
          const assignedName = teachers.find(t => t.id === inst.teacherId)?.name || "Unknown";
          perInstResults.push({ inst, scheduled: false, reason: `Assigned teacher (${assignedName}) cannot teach ${inst.name} at ${school.name}` });
          allScheduled = false;
          continue;
        }

        if (compatibleTeachers.length === 0) {
          perInstResults.push({ inst, scheduled: false, reason: "No compatible teacher" });
          allScheduled = false;
          continue;
        }

        const orderedDays = [...school.days].sort((a, b) => {
          const aPreferred = hints.preferredDays?.includes(a) ? -1 : 0;
          const bPreferred = hints.preferredDays?.includes(b) ? -1 : 0;
          const aAvoided = hints.avoidDays?.includes(a) ? 1 : 0;
          const bAvoided = hints.avoidDays?.includes(b) ? 1 : 0;
          const prefDiff = (aPreferred + aAvoided) - (bPreferred + bAvoided);
          if (prefDiff !== 0) return prefDiff;
          const aTeacherLessons = compatibleTeachers.reduce((sum, t) =>
            sum + teacherSchedule[t.id].filter(l => l.day === a && l.schoolId === school.id).length, 0);
          const bTeacherLessons = compatibleTeachers.reduce((sum, t) =>
            sum + teacherSchedule[t.id].filter(l => l.day === b && l.schoolId === school.id).length, 0);
          if (aTeacherLessons !== bTeacherLessons) return bTeacherLessons - aTeacherLessons;
          const classKey = `${school.id}|${student.className || ""}`;
          const classMateIds = classMates[classKey];
          const aClassmates = classMateIds ? lessons.filter(l => l.schoolId === school.id && l.day === a &&
            classMateIds.has(l.studentId) && l.studentId !== student.id).length : 0;
          const bClassmates = classMateIds ? lessons.filter(l => l.schoolId === school.id && l.day === b &&
            classMateIds.has(l.studentId) && l.studentId !== student.id).length : 0;
          if (aClassmates !== bClassmates) return bClassmates - aClassmates;
          if (school.specialistPolicy === "prefer-not") {
            const hasFreeClassSlot = (day) => school.slots.some(slot => {
              if (slot.type !== "class") return false;
              if (isSpecialistTime(school.id, student.className, day, slot.start, slot.end)) return false;
              return compatibleTeachers.some(t => {
                const dayAvail = t.availability.find(av => av.schoolId === school.id && av.day === day);
                if (!dayAvail) return false;
                const slotStart = timeToMin(slot.start), slotEnd = timeToMin(slot.end);
                if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) return false;
                return !teacherSchedule[t.id].find(l => l.day === day && timeToMin(l.start) < slotEnd && timeToMin(l.end) > slotStart);
              });
            });
            const aHasFree = hasFreeClassSlot(a) ? 0 : 1;
            const bHasFree = hasFreeClassSlot(b) ? 0 : 1;
            if (aHasFree !== bHasFree) return aHasFree - bHasFree;
          }
          return 0;
        });

        const getAdjacencyScore = (slot, day) => {
          const slotMin = timeToMin(slot.start);
          let bestTeacherGap = 9999;
          let bestClassmateGap = 9999;
          for (const teacher of compatibleTeachers) {
            for (const l of teacherSchedule[teacher.id]) {
              if (l.day !== day || l.schoolId !== school.id) continue;
              const existStart = timeToMin(l.start);
              const existEnd = timeToMin(l.end);
              const gap = Math.min(Math.abs(slotMin - existEnd), Math.abs(existStart - timeToMin(slot.end)));
              bestTeacherGap = Math.min(bestTeacherGap, gap);
            }
          }
          const classKey2 = `${school.id}|${student.className || ""}`;
          const myClassMates = classMates[classKey2];
          if (myClassMates) {
            for (const l of lessons) {
              if (l.schoolId !== school.id || l.day !== day) continue;
              if (!myClassMates.has(l.studentId) || l.studentId === student.id) continue;
              const existStart = timeToMin(l.start);
              const existEnd = timeToMin(l.end);
              const gap = Math.min(Math.abs(slotMin - existEnd), Math.abs(existStart - timeToMin(slot.end)));
              bestClassmateGap = Math.min(bestClassmateGap, gap);
            }
          }
          return (bestTeacherGap === 9999 ? 500 : bestTeacherGap) + (bestClassmateGap === 9999 ? 200 : bestClassmateGap * 0.5);
        };

        const getSortedSlots = (day) => {
          return [...school.slots].sort((a, b) => {
            const aIsSpec = isSpecialistTime(school.id, student.className, day, a.start, a.end);
            const bIsSpec = isSpecialistTime(school.id, student.className, day, b.start, b.end);
            const aIsPartial = aIsSpec && isPartialSpecialist(school.id, student.className, day, a.start, a.end);
            const bIsPartial = bIsSpec && isPartialSpecialist(school.id, student.className, day, b.start, b.end);
            const aIsBreak = ["recess", "lunch", "before_school", "after_school"].includes(a.type);
            const bIsBreak = ["recess", "lunch", "before_school", "after_school"].includes(b.type);
            const aIsPrefTime = hints.preferredTimes?.some(pt => pt.day === day && a.start === pt.start) ? -2 : 0;
            const bIsPrefTime = hints.preferredTimes?.some(pt => pt.day === day && b.start === pt.start) ? -2 : 0;
            if (aIsPrefTime !== bIsPrefTime) return aIsPrefTime - bIsPrefTime;
            if (mustBeOutsideClass) {
              if ((aIsSpec || aIsBreak) && !(bIsSpec || bIsBreak)) return -1;
              if (!(aIsSpec || aIsBreak) && (bIsSpec || bIsBreak)) return 1;
            } else if (student.outsideClassPreferred) {
              if (aIsBreak && !bIsBreak) return -1;
              if (!aIsBreak && bIsBreak) return 1;
              if (aIsSpec && !bIsSpec) return -1;
              if (!aIsSpec && bIsSpec) return 1;
            } else if (isMultiInstrument && !classTimeUsed) {
              const aOutside = aIsSpec || aIsBreak ? -1 : 0;
              const bOutside = bIsSpec || bIsBreak ? -1 : 0;
              if (aOutside !== bOutside) return aOutside - bOutside;
            } else if (school.specialistPolicy === "prefer-not") {
              const aSpecAllowed = aIsSpec && hints.allowedSpecialists?.length > 0 &&
                getSpecialistSubject(specLookup, school.id, student.className, day, a.start, a.end, hints.allowedSpecialists);
              const bSpecAllowed = bIsSpec && hints.allowedSpecialists?.length > 0 &&
                getSpecialistSubject(specLookup, school.id, student.className, day, b.start, b.end, hints.allowedSpecialists);
              const aScore = !aIsSpec ? (aIsBreak ? 1 : 0) : aIsPartial ? 4 : aSpecAllowed ? 5 : 8;
              const bScore = !bIsSpec ? (bIsBreak ? 1 : 0) : bIsPartial ? 4 : bSpecAllowed ? 5 : 8;
              if (aScore !== bScore) return aScore - bScore;
            } else {
              const aSpecAllowed = aIsSpec && hints.allowedSpecialists?.length > 0 &&
                getSpecialistSubject(specLookup, school.id, student.className, day, a.start, a.end, hints.allowedSpecialists);
              const bSpecAllowed = bIsSpec && hints.allowedSpecialists?.length > 0 &&
                getSpecialistSubject(specLookup, school.id, student.className, day, b.start, b.end, hints.allowedSpecialists);
              const aScore = !aIsSpec ? 0 : aIsPartial ? 1 : aSpecAllowed ? 1.5 : 3;
              const bScore = !bIsSpec ? 0 : bIsPartial ? 1 : bSpecAllowed ? 1.5 : 3;
              if (aScore !== bScore) return aScore - bScore;
              if (!aIsBreak && bIsBreak) return -1;
              if (aIsBreak && !bIsBreak) return 1;
            }
            const aAdj = getAdjacencyScore(a, day);
            const bAdj = getAdjacencyScore(b, day);
            return aAdj - bAdj;
          });
        };

        const tryBook = (day, slot) => {
          if (isMultiInstrument && usedDays.has(day)) return false;
          const slotIsSpecialist = isSpecialistTime(school.id, student.className, day, slot.start, slot.end);
          if (!isSlotAllowed(slot, student, school, mustBeOutsideClass, slotIsSpecialist, day, hints)) return false;
          for (const teacher of compatibleTeachers) {
            if (isDuringBreak(teacher.id, school.id, day, slot.start, slot.end)) continue;
            const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === day);
            if (!dayAvail) continue;
            const slotStart = timeToMin(slot.start);
            const slotEnd = timeToMin(slot.end);
            if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) continue;
            if (teacherSchedule[teacher.id].find(l => l.day === day && timeToMin(l.start) < slotEnd && timeToMin(l.end) > slotStart)) continue;
            let travelConflict = false;
            for (const existing of teacherSchedule[teacher.id].filter(l => l.day === day)) {
              if (existing.schoolId !== school.id) {
                const existEnd = timeToMin(existing.end);
                const existStart = timeToMin(existing.start);
                if (Math.abs(slotStart - existEnd) < 30 && slotStart >= existEnd) { travelConflict = true; break; }
                if (Math.abs(existStart - slotEnd) < 30 && existStart >= slotEnd) { travelConflict = true; break; }
              }
            }
            if (travelConflict) continue;
            if (lessons.find(l => l.studentId === student.id && l.day === day && l.slotId === slot.id)) continue;
            // Spec 2 cluster 4b — resolve lane before stamping bucket_id.
            // No active lane covering (school, day, teacher) → skip teacher
            // for this slot; absence accumulates into laneAbsentDays.
            const bucketId = findLaneId(teacherCoverage, school.id, day, teacher.id);
            if (!bucketId) {
              laneAbsentDays.add(`${day}|${teacher.name}`);
              continue;
            }
            const lesson = {
              id: uid(),
              studentId: student.id, studentName: student.name,
              bucket_id: bucketId, teacherName: teacher.name,
              schoolId: school.id, schoolName: school.name,
              day, slotId: slot.id, slotName: slot.name,
              start: slot.start, end: slot.end,
              instrument: inst.name,
              duringSpecialist: slotIsSpecialist ? (getSpecialistName(school.id, student.className, day, slot.start, slot.end) || true) : false
            };
            lessons.push(lesson);
            scheduledLessons.push(lesson);
            const tEntry = { day, slotId: slot.id, schoolId: school.id, start: slot.start, end: slot.end };
            teacherSchedule[teacher.id].push(tEntry);
            scheduledTeacherEntries.push({ teacherId: teacher.id, entry: tEntry });
            const isClassTime = slot.type === "class" && !slotIsSpecialist;
            if (isClassTime) classTimeUsed = true;
            usedDays.add(day);
            return true;
          }
          return false;
        };

        const findSlotForTime = (time) => {
          let targetMin = timeToMin(time);
          if (targetMin < 420) {
            const pmMin = targetMin + 720;
            const pmSlot = school.slots.find(s => s.start === `${String(Math.floor(pmMin / 60)).padStart(2, "0")}:${String(pmMin % 60).padStart(2, "0")}`);
            if (pmSlot) return pmSlot;
            const pmContain = school.slots.find(s => timeToMin(s.start) <= pmMin && timeToMin(s.end) > pmMin);
            if (pmContain) return pmContain;
            const pmClose = school.slots.reduce((best, s) => {
              const diff = Math.abs(timeToMin(s.start) - pmMin);
              return diff < 15 && diff < (best ? best.diff : Infinity) ? { slot: s, diff } : best;
            }, null);
            if (pmClose) return pmClose.slot;
          }
          let slot = school.slots.find(s => s.start === time);
          if (slot) return slot;
          slot = school.slots.find(s => timeToMin(s.start) <= targetMin && timeToMin(s.end) > targetMin);
          if (slot) return slot;
          let closest = null, closestDiff = Infinity;
          for (const s of school.slots) {
            const diff = Math.abs(timeToMin(s.start) - targetMin);
            if (diff < closestDiff && diff <= 15) { closestDiff = diff; closest = s; }
          }
          return closest;
        };

        const tryBookForced = (day, slot) => {
          if (isMultiInstrument && usedDays.has(day) && !requiredSameDayAllowed.has(day)) return `student already has lesson on ${day}`;
          const reasons = [];
          for (const teacher of compatibleTeachers) {
            if (isDuringBreak(teacher.id, school.id, day, slot.start, slot.end)) {
              reasons.push(`${teacher.name}: break at ${slot.start}–${slot.end}`);
              continue;
            }
            const dayAvail = teacher.availability.find(a => a.schoolId === school.id && a.day === day);
            if (!dayAvail) { reasons.push(`${teacher.name}: not available ${day}`); continue; }
            const slotStart = timeToMin(slot.start);
            const slotEnd = timeToMin(slot.end);
            if (slotStart < timeToMin(dayAvail.start) || slotEnd > timeToMin(dayAvail.end)) {
              reasons.push(`${teacher.name}: slot outside availability (${dayAvail.start}–${dayAvail.end})`); continue;
            }
            if (teacherSchedule[teacher.id].find(l => l.day === day && timeToMin(l.start) < slotEnd && timeToMin(l.end) > slotStart)) {
              reasons.push(`${teacher.name}: already booked at ${slot.start}`); continue;
            }
            let travelConflict = false;
            for (const existing of teacherSchedule[teacher.id].filter(l => l.day === day)) {
              if (existing.schoolId !== school.id) {
                const existEnd = timeToMin(existing.end);
                const existStart = timeToMin(existing.start);
                if ((Math.abs(slotStart - existEnd) < 30 && slotStart >= existEnd) ||
                    (Math.abs(existStart - slotEnd) < 30 && existStart >= slotEnd)) { travelConflict = true; break; }
              }
            }
            if (travelConflict) { reasons.push(`${teacher.name}: travel conflict`); continue; }
            if (lessons.find(l => l.studentId === student.id && l.day === day && l.slotId === slot.id)) {
              reasons.push(`student already has lesson at ${slot.start}`); continue;
            }
            // Spec 2 cluster 4b — resolve lane before stamping. Skip if no
            // active lane covers this (school, day, teacher).
            const bucketId = findLaneId(teacherCoverage, school.id, day, teacher.id);
            if (!bucketId) {
              laneAbsentDays.add(`${day}|${teacher.name}`);
              reasons.push(`${teacher.name}: no covering lane on ${day}`);
              continue;
            }
            const slotIsSpecialist = isSpecialistTime(school.id, student.className, day, slot.start, slot.end);
            const lesson = {
              id: uid(),
              studentId: student.id, studentName: student.name,
              bucket_id: bucketId, teacherName: teacher.name,
              schoolId: school.id, schoolName: school.name,
              day, slotId: slot.id, slotName: slot.name,
              start: slot.start, end: slot.end,
              instrument: inst.name,
              duringSpecialist: slotIsSpecialist ? (getSpecialistName(school.id, student.className, day, slot.start, slot.end) || true) : false,
              _pinned: true
            };
            lessons.push(lesson);
            scheduledLessons.push(lesson);
            const tEntry = { day, slotId: slot.id, schoolId: school.id, start: slot.start, end: slot.end };
            teacherSchedule[teacher.id].push(tEntry);
            scheduledTeacherEntries.push({ teacherId: teacher.id, entry: tEntry });
            const isClassTime = slot.type === "class" && !slotIsSpecialist;
            if (isClassTime) classTimeUsed = true;
            usedDays.add(day);
            return true;
          }
          return reasons.length > 0 ? reasons.join("; ") : "no compatible teachers";
        };

        // PASS 1: required times
        const remainingRequiredTimes = allRequiredTimes.filter((_, i) => !usedRequiredTimeIdxs.has(i));
        let noteMismatch = false;
        let pass1FailReason = "";
        if (remainingRequiredTimes.length > 0) {
          for (let ri = 0; ri < allRequiredTimes.length; ri++) {
            if (scheduled) break;
            if (usedRequiredTimeIdxs.has(ri)) continue;
            const rt = allRequiredTimes[ri];
            if (!rt.instrument || rt.instrument.toLowerCase() !== inst.name.toLowerCase()) continue;
            const slot = findSlotForTime(rt.start);
            if (!slot) { pass1FailReason = `No slot found for ${rt.day} ${rt.start}`; continue; }
            const result = tryBookForced(rt.day, slot);
            if (result === true) {
              scheduled = true;
              usedRequiredTimeIdxs.add(ri);
            } else {
              pass1FailReason = `${rt.day} ${slot.start}: ${result}`;
            }
          }
          if (!scheduled) {
            for (let ri = 0; ri < allRequiredTimes.length; ri++) {
              if (scheduled) break;
              if (usedRequiredTimeIdxs.has(ri)) continue;
              const rt = allRequiredTimes[ri];
              if (rt.instrument) continue;
              const slot = findSlotForTime(rt.start);
              if (!slot) { pass1FailReason = `No slot found for ${rt.day} ${rt.start}`; continue; }
              const result = tryBookForced(rt.day, slot);
              if (result === true) {
                scheduled = true;
                usedRequiredTimeIdxs.add(ri);
              } else {
                pass1FailReason = `${rt.day} ${slot.start}: ${result}`;
              }
            }
          }
          if (!scheduled) noteMismatch = true;
        }

        // PASS 2: normal scheduling
        if (!scheduled) {
          for (const day of orderedDays) {
            if (scheduled) break;
            const sortedSlots = getSortedSlots(day);
            for (const slot of sortedSlots) {
              if (scheduled) break;
              scheduled = tryBook(day, slot);
            }
          }
        }

        if (scheduled && noteMismatch) {
          const lastLesson = lessons[lessons.length - 1];
          lastLesson.noteMismatch = `Requested: ${allRequiredTimes.map(rt => `${rt.day} ${rt.start}`).join(", ")}${pass1FailReason ? ` — ${pass1FailReason}` : ""}`;
        }
        if (noteMismatch && pass1FailReason) {
          for (const sl of scheduledLessons) {
            if (!sl.noteMismatch) sl.noteMismatch = pass1FailReason;
          }
        }

        // Spec 2 cluster 4b — if scheduling failed AND every attempt was
        // blocked by lane absence, surface that as the reason. Otherwise the
        // existing fallback messaging applies.
        let failReason = null;
        if (!scheduled) {
          if (laneAbsentDays.size > 0) {
            const combos = [...laneAbsentDays].map(k => {
              const [d, tname] = k.split("|");
              return `${school.name}/${d}/${tname}`;
            }).join(", ");
            failReason = `no covering lane (${combos})`;
          } else if (noteMismatch) {
            failReason = `No slot available (requested: ${allRequiredTimes.map(rt => `${rt.day} ${rt.start}`).join(", ")}${pass1FailReason ? ` — ${pass1FailReason}` : ""})`;
          } else {
            failReason = "No available slot";
          }
        }
        perInstResults.push({
          inst, scheduled, noteMismatch, pass1FailReason,
          reason: failReason,
        });
        if (!scheduled) allScheduled = false;
      }

      return { allScheduled, perInstResults, scheduledLessons, scheduledTeacherEntries };
    };

    const undoScheduling = (result) => {
      for (const lesson of result.scheduledLessons) {
        const idx = lessons.indexOf(lesson);
        if (idx >= 0) lessons.splice(idx, 1);
      }
      for (const { teacherId, entry } of result.scheduledTeacherEntries) {
        const idx = teacherSchedule[teacherId].indexOf(entry);
        if (idx >= 0) teacherSchedule[teacherId].splice(idx, 1);
      }
    };

    let result = scheduleInstruments(individualInsts);

    const _hasUnassignedFail = result.perInstResults.some(r => !r.scheduled && r.reason === "Unassigned");
    if (!result.allScheduled && isMultiInstrument && !_hasUnassignedFail) {
      undoScheduling(result);
      const reversed = [...individualInsts].reverse();
      const result2 = scheduleInstruments(reversed);
      if (result2.allScheduled || result2.perInstResults.filter(r => r.scheduled).length > result.perInstResults.filter(r => r.scheduled).length) {
        result = result2;
      } else {
        undoScheduling(result2);
        result = scheduleInstruments(individualInsts);
      }
    }

    for (const r of result.perInstResults) {
      if (!r.scheduled && r.reason) {
        unscheduled.push({ student, instrument: r.inst.name, reason: r.reason });
      }
    }
    for (const l of result.scheduledLessons) {
      if (!studentDayMap[student.id]) studentDayMap[student.id] = new Set();
      studentDayMap[student.id].add(l.day);
    }
  }

  // SAFETY: detect and remove any teacher double-bookings.
  // Spec 2 cluster 4b — resolve teacherId via bucket_id Map; the check is
  // cross-school same-teacher (so bucket_id equality isn't sufficient).
  const dbFound = [];
  for (let i = 0; i < lessons.length; i++) {
    const tIdI = getCardTeacherId(lessons[i], teacherCoverage);
    if (!tIdI) continue;
    for (let j = i + 1; j < lessons.length; j++) {
      const tIdJ = getCardTeacherId(lessons[j], teacherCoverage);
      if (tIdI === tIdJ &&
          lessons[i].day === lessons[j].day &&
          timeToMin(lessons[i].start) < timeToMin(lessons[j].end) &&
          timeToMin(lessons[j].start) < timeToMin(lessons[i].end)) {
        dbFound.push(j);
      }
    }
  }
  if (dbFound.length > 0) {
    const removed = [...new Set(dbFound)].sort((a, b) => b - a);
    for (const idx of removed) {
      const l = lessons[idx];
      unscheduled.push({
        student: studentsToSchedule.find(s => s.id === l.studentId) || { id: l.studentId, name: l.studentName, schoolId: l.schoolId },
        instrument: l.instrument,
        reason: `Double-booking conflict with ${l.teacherName} on ${l.day} at ${l.start}`
      });
      lessons.splice(idx, 1);
    }
  }

  return { lessons, unscheduled };
}

// ── compactTimetable ──────────────────────────────────────────────────────────

export function compactTimetable(result, schools, students, teachers, enrolments, specialists, teacherCoverage = []) {
  var lessons = result.lessons;

  var specLookupC = {};
  for (var spi0 = 0; spi0 < (specialists || []).length; spi0++) {
    var sp0 = specialists[spi0];
    var spK0 = sp0.schoolId + '|' + sp0.className + '|' + sp0.day;
    if (!specLookupC[spK0]) specLookupC[spK0] = [];
    specLookupC[spK0].push({ start: timeToMin(sp0.start), end: timeToMin(sp0.end), subject: sp0.subject });
  }
  var isDuringSpecialistC = function(schoolId, className, day, slotStart, slotEnd) {
    var specs = specLookupC[schoolId + '|' + className + '|' + day];
    if (!specs) return false;
    var mid = (timeToMin(slotStart) + timeToMin(slotEnd)) / 2;
    return specs.some(function(sp) { return mid >= sp.start && mid < sp.end; });
  };

  var teacherBreaksLookup = {};
  for (var ti = 0; ti < teachers.length; ti++) {
    var teacher = teachers[ti];
    teacherBreaksLookup[teacher.id] = {};
    for (var bi = 0; bi < (teacher.teacherBreaks || []).length; bi++) {
      var tb = teacher.teacherBreaks[bi];
      if (!teacherBreaksLookup[teacher.id][tb.schoolId]) teacherBreaksLookup[teacher.id][tb.schoolId] = [];
      teacherBreaksLookup[teacher.id][tb.schoolId].push({ start: timeToMin(tb.start), end: timeToMin(tb.end), day: tb.day || 'All' });
    }
  }
  var schoolBreaksLookup = {};
  for (var si2 = 0; si2 < schools.length; si2++) {
    schoolBreaksLookup[schools[si2].id] = (schools[si2].teacherBreaks || []).map(function(b) {
      return { start: timeToMin(b.start), end: timeToMin(b.end), day: b.day || 'All' };
    });
  }
  var isTeacherOnBreak = function(tId, sId, day, ss, se) {
    var sMid = (timeToMin(ss) + timeToMin(se)) / 2;
    var sb = schoolBreaksLookup[sId];
    if (sb && sb.length > 0) return sb.some(function(b) { return (b.day === 'All' || b.day === day) && sMid >= b.start && sMid < b.end; });
    var tbs = (teacherBreaksLookup[tId] && teacherBreaksLookup[tId][sId]) ? teacherBreaksLookup[tId][sId] : [];
    return tbs.some(function(b) { return (b.day === 'All' || b.day === day) && sMid >= b.start && sMid < b.end; });
  };

  var mustBeInBreakSlot = function(lesson) {
    if (lesson.isGroup) return false;
    var student = students.find(function(s) { return s.id === lesson.studentId; });
    if (!student) return false;
    if (student.outsideClassOnly) return true;
    var studentInsts = instrumentsFromEnrolments(student.id, enrolments);
    var hasGroup = studentInsts.some(function(i) { return i.isGroup; });
    var isMulti = studentInsts.filter(function(i) { return !i.isGroup; }).length > 1 || hasGroup;
    if (isMulti) {
      var otherClassLesson = lessons.find(function(l) {
        if (l.id === lesson.id) return false;
        if (l.studentId !== lesson.studentId && !(l.isGroup && l.studentIds && l.studentIds.indexOf(lesson.studentId) >= 0)) return false;
        var otherSchool = schools.find(function(s2) { return s2.id === l.schoolId; });
        if (!otherSchool) return false;
        var otherSlot = otherSchool.slots.find(function(s3) { return s3.id === l.slotId; });
        return otherSlot && otherSlot.type === 'class';
      });
      if (otherClassLesson) return true;
    }
    return false;
  };

  // bucket_id IS the (school, day, teacher) tuple — use it directly as the combos key.
  var combos = {};
  for (var li = 0; li < lessons.length; li++) {
    var lesson = lessons[li];
    if (!lesson.bucket_id) continue; // skip non-lane-stamped cards (e.g. legacy)
    if (!combos[lesson.bucket_id]) combos[lesson.bucket_id] = [];
    combos[lesson.bucket_id].push(lesson);
  }

  var totalMoved = 0;
  var comboKeys = Object.keys(combos);
  for (var ci = 0; ci < comboKeys.length; ci++) {
    var comboLessons = combos[comboKeys[ci]];
    if (comboLessons.length < 2) continue;

    var teacherId = getCardTeacherId(comboLessons[0], teacherCoverage);
    var schoolId = comboLessons[0].schoolId;
    var day = comboLessons[0].day;
    if (!teacherId) continue; // bucket_id missing from teacherCoverage map → can't resolve
    var sch = schools.find(function(s) { return s.id === schoolId; });
    if (!sch) continue;

    var allSlots = sch.slots
      .filter(function(s) { return ['before_school', 'after_school'].indexOf(s.type) < 0; })
      .sort(function(a, b) { return timeToMin(a.start) - timeToMin(b.start); });
    if (allSlots.length === 0) continue;

    comboLessons.sort(function(a, b) { return timeToMin(a.start) - timeToMin(b.start); });

    var movable = [];
    var breakOnly = [];
    var pinned = [];
    for (var mi = 0; mi < comboLessons.length; mi++) {
      if (comboLessons[mi]._pinned) {
        pinned.push(comboLessons[mi]);
      } else if (mustBeInBreakSlot(comboLessons[mi])) {
        breakOnly.push(comboLessons[mi]);
      } else {
        movable.push(comboLessons[mi]);
      }
    }

    if (movable.length < 1) continue;

    var otherSchoolLessons = lessons.filter(function(l) {
      return getCardTeacherId(l, teacherCoverage) === teacherId && l.day === day && l.schoolId !== schoolId;
    });
    var isTeacherBusyElsewhere = function(slotStart, slotEnd) {
      var sS = timeToMin(slotStart), sE = timeToMin(slotEnd);
      return otherSchoolLessons.some(function(l) {
        return timeToMin(l.start) < sE && sS < timeToMin(l.end);
      });
    };
    var teacher = teachers.find(function(t) { return t.id === teacherId; });
    var dayAvail = teacher ? teacher.availability.find(function(a) { return a.schoolId === schoolId && a.day === day; }) : null;
    var availStart = dayAvail ? timeToMin(dayAvail.start) : 0;
    var availEnd = dayAvail ? timeToMin(dayAvail.end) : 1440;
    var isOutsideAvailability = function(slotStart, slotEnd) {
      return timeToMin(slotStart) < availStart || timeToMin(slotEnd) > availEnd;
    };
    var pinnedSlotTimes = {};
    for (var pi = 0; pi < pinned.length; pi++) {
      pinnedSlotTimes[pinned[pi].start] = true;
    }
    var validClassSlots = allSlots.filter(function(slot) {
      if (pinnedSlotTimes[slot.start]) return false;
      if (isOutsideAvailability(slot.start, slot.end)) return false;
      if (isTeacherOnBreak(teacherId, schoolId, day, slot.start, slot.end)) return false;
      if (isTeacherBusyElsewhere(slot.start, slot.end)) return false;
      return slot.type === 'class';
    });
    var validBreakSlots = allSlots.filter(function(slot) {
      if (pinnedSlotTimes[slot.start]) return false;
      if (isOutsideAvailability(slot.start, slot.end)) return false;
      if (isTeacherOnBreak(teacherId, schoolId, day, slot.start, slot.end)) return false;
      if (isTeacherBusyElsewhere(slot.start, slot.end)) return false;
      return ['recess', 'lunch'].indexOf(slot.type) >= 0;
    });

    // PHASE 1: Pack movable lessons into consecutive class slots
    var bestMovStart = -1;
    if (movable.length >= 2) {
      for (var tryStart = 0; tryStart <= validClassSlots.length - movable.length; tryStart++) {
        var allFit = true;
        for (var fi = 0; fi < movable.length; fi++) {
          var fitStudent = students.find(function(s) { return s.id === movable[fi].studentId; });
          if (fitStudent && fitStudent.outsideClassOnly) { allFit = false; break; }
          if (fitStudent && sch.specialistPolicy === 'no') {
            if (isDuringSpecialistC(schoolId, fitStudent.className || '', day, validClassSlots[tryStart + fi].start, validClassSlots[tryStart + fi].end)) {
              allFit = false; break;
            }
          }
        }
        if (allFit) { bestMovStart = tryStart; break; }
      }
    } else if (movable.length === 1) {
      bestMovStart = 0;
    }

    if (bestMovStart >= 0 && movable.length >= 2) {
      for (var ai = 0; ai < movable.length; ai++) {
        var slot = validClassSlots[bestMovStart + ai];
        var oldStart = movable[ai].start;
        movable[ai].slotId = slot.id;
        movable[ai].slotName = slot.name;
        movable[ai].start = slot.start;
        movable[ai].end = slot.end;
        if (oldStart !== slot.start) totalMoved++;
      }
    }

    // PHASE 2: Place break-only lessons in nearest break slot to the movable block
    if (breakOnly.length > 0 && movable.length > 0) {
      var blockEnd = timeToMin(movable[movable.length - 1].end);
      var blockStart = timeToMin(movable[0].start);
      var sortedBreakSlots = validBreakSlots.slice().sort(function(a, b) {
        var aStart = timeToMin(a.start);
        var bStart = timeToMin(b.start);
        var aDist = aStart >= blockEnd ? (aStart - blockEnd) : (blockStart - timeToMin(a.end)) + 1000;
        var bDist = bStart >= blockEnd ? (bStart - blockEnd) : (blockStart - timeToMin(b.end)) + 1000;
        return aDist - bDist;
      });
      var usedBreakSlots = {};
      for (var boi = 0; boi < breakOnly.length; boi++) {
        var placed = false;
        for (var bsi = 0; bsi < sortedBreakSlots.length; bsi++) {
          var bSlot = sortedBreakSlots[bsi];
          if (usedBreakSlots[bSlot.start]) continue;
          usedBreakSlots[bSlot.start] = true;
          var oldStart2 = breakOnly[boi].start;
          breakOnly[boi].slotId = bSlot.id;
          breakOnly[boi].slotName = bSlot.name;
          breakOnly[boi].start = bSlot.start;
          breakOnly[boi].end = bSlot.end;
          if (oldStart2 !== bSlot.start) totalMoved++;
          placed = true;
          break;
        }
      }
    }
  }

  // CROSS-DAY BALANCING: even out lesson counts across days
  // Cross-day balancing groups by (teacher, school) deliberately spanning days,
  // so bucket_id (which includes day) can't be the key. Resolve teacherId via
  // the Map.
  var teacherSchoolCombos = {};
  for (var tsi = 0; tsi < lessons.length; tsi++) {
    var tsLesson = lessons[tsi];
    var tsTeacherId = getCardTeacherId(tsLesson, teacherCoverage);
    if (!tsTeacherId) continue;
    var tsKey = tsTeacherId + '|' + tsLesson.schoolId;
    if (!teacherSchoolCombos[tsKey]) teacherSchoolCombos[tsKey] = { teacherId: tsTeacherId, schoolId: tsLesson.schoolId, lessons: [] };
    teacherSchoolCombos[tsKey].lessons.push(tsLesson);
  }

  var tsComboKeys = Object.keys(teacherSchoolCombos);
  for (var tsci = 0; tsci < tsComboKeys.length; tsci++) {
    var tsCombo = teacherSchoolCombos[tsComboKeys[tsci]];
    var tId = tsCombo.teacherId;
    var sId = tsCombo.schoolId;
    var tsch = schools.find(function(s) { return s.id === sId; });
    if (!tsch) continue;
    var tTeacher = teachers.find(function(t) { return t.id === tId; });
    if (!tTeacher) continue;

    var byDay = {};
    for (var tli = 0; tli < tsCombo.lessons.length; tli++) {
      var tl = tsCombo.lessons[tli];
      if (!byDay[tl.day]) byDay[tl.day] = [];
      byDay[tl.day].push(tl);
    }

    var dayKeys = Object.keys(byDay);
    if (dayKeys.length < 2) continue;

    var balanceChanged = true;
    var balanceIterations = 0;
    while (balanceChanged && balanceIterations < 50) {
      balanceChanged = false;
      balanceIterations++;
      var dayCounts = {};
      for (var dki = 0; dki < dayKeys.length; dki++) {
        dayCounts[dayKeys[dki]] = (byDay[dayKeys[dki]] || []).length;
      }
      var sortedDays = dayKeys.slice().sort(function(a, b) { return dayCounts[b] - dayCounts[a]; });
      var heaviestDay = sortedDays[0];
      var lightestDay = sortedDays[sortedDays.length - 1];
      var diff = dayCounts[heaviestDay] - dayCounts[lightestDay];
      if (diff < 2) continue;
      var heavyLessons = byDay[heaviestDay] || [];
      var moved = false;
      var lightAvail = tTeacher.availability.find(function(a) { return a.schoolId === sId && a.day === lightestDay; });
      if (!lightAvail) continue;
      var lightAvailStart = timeToMin(lightAvail.start);
      var lightAvailEnd = timeToMin(lightAvail.end);
      var occupiedOnLight = {};
      for (var oli = 0; oli < lessons.length; oli++) {
        if (getCardTeacherId(lessons[oli], teacherCoverage) === tId && lessons[oli].day === lightestDay && lessons[oli].schoolId === sId) {
          occupiedOnLight[lessons[oli].start] = true;
        }
      }
      for (var hli = heavyLessons.length - 1; hli >= 0; hli--) {
        if (moved) break;
        var hLesson = heavyLessons[hli];
        if (hLesson._pinned) continue;
        if (hLesson.isGroup) continue;
        var hStu = students.find(function(s) { return s.id === hLesson.studentId; });
        if (!hStu) continue;
        var hHints = hStu._noteHints || {};
        if (hHints.avoidDays && hHints.avoidDays.indexOf(lightestDay) >= 0) continue;
        var stuHasLessonOnLight = lessons.some(function(l) {
          return l.id !== hLesson.id && l.day === lightestDay && (
            l.studentId === hLesson.studentId ||
            (l.isGroup && l.studentIds && l.studentIds.indexOf(hLesson.studentId) >= 0)
          );
        });
        if (stuHasLessonOnLight) continue;
        if (hStu.outsideClassOnly) continue;
        var lightSlots = tsch.slots.filter(function(s) { return s.type === 'class'; }).sort(function(a, b) { return timeToMin(a.start) - timeToMin(b.start); });
        for (var lsi = 0; lsi < lightSlots.length; lsi++) {
          if (moved) break;
          var lSlot = lightSlots[lsi];
          var lsStart = timeToMin(lSlot.start);
          var lsEnd = timeToMin(lSlot.end);
          if (lsStart < lightAvailStart || lsEnd > lightAvailEnd) continue;
          if (occupiedOnLight[lSlot.start]) continue;
          if (isTeacherOnBreak(tId, sId, lightestDay, lSlot.start, lSlot.end)) continue;
          var crossSchool = lessons.some(function(l) {
            return getCardTeacherId(l, teacherCoverage) === tId && l.day === lightestDay && l.schoolId !== sId &&
              timeToMin(l.start) < lsEnd && lsStart < timeToMin(l.end);
          });
          if (crossSchool) continue;
          if (tsch.specialistPolicy === 'no' && hStu.className) {
            if (isDuringSpecialistC(sId, hStu.className, lightestDay, lSlot.start, lSlot.end)) continue;
          }
          hLesson.day = lightestDay;
          hLesson.slotId = lSlot.id;
          hLesson.slotName = lSlot.name;
          hLesson.start = lSlot.start;
          hLesson.end = lSlot.end;
          totalMoved++;
          moved = true;
          balanceChanged = true;
          heavyLessons.splice(hli, 1);
          if (!byDay[lightestDay]) byDay[lightestDay] = [];
          byDay[lightestDay].push(hLesson);
          occupiedOnLight[lSlot.start] = true;
        }
      }
    }
  }

  // Recalculate duringSpecialist for all lessons after compaction
  var specLookup2 = {};
  for (var spi = 0; spi < (specialists || []).length; spi++) {
    var sp = specialists[spi];
    var spKey = sp.schoolId + '|' + sp.className + '|' + sp.day;
    if (!specLookup2[spKey]) specLookup2[spKey] = [];
    specLookup2[spKey].push({ start: timeToMin(sp.start), end: timeToMin(sp.end), subject: sp.subject });
  }
  for (var rli = 0; rli < lessons.length; rli++) {
    var rl = lessons[rli];
    var stu = students.find(function(s) { return s.id === rl.studentId; });
    var cn = stu ? (stu.className || '') : '';
    var rlSlot = schools.find(function(s) { return s.id === rl.schoolId; })?.slots?.find(function(s) { return s.id === rl.slotId; });
    if (rlSlot && rlSlot.type !== 'class') { rl.duringSpecialist = false; continue; }
    var rlS = timeToMin(rl.start), rlE = timeToMin(rl.end);
    if (rl.isGroup && rl.studentIds) {
      var groupSubjects = [];
      for (var gmi = 0; gmi < rl.studentIds.length; gmi++) {
        var gmStu = students.find(function(s) { return s.id === rl.studentIds[gmi]; });
        var gmCn = gmStu ? (gmStu.className || '') : '';
        if (!gmCn) continue;
        var gmKey = rl.schoolId + '|' + gmCn + '|' + rl.day;
        var gmSpecs = specLookup2[gmKey];
        if (!gmSpecs) continue;
        for (var gmSpi = 0; gmSpi < gmSpecs.length; gmSpi++) {
          if (rlS < gmSpecs[gmSpi].end && rlE > gmSpecs[gmSpi].start) {
            var subj = gmSpecs[gmSpi].subject;
            if (subj && groupSubjects.indexOf(subj) === -1) groupSubjects.push(subj);
            break;
          }
        }
      }
      rl.duringSpecialist = groupSubjects.length > 0 ? groupSubjects.join(', ') : false;
      continue;
    }
    if (!cn) { rl.duringSpecialist = false; continue; }
    var spKey2 = rl.schoolId + '|' + cn + '|' + rl.day;
    var specs2 = specLookup2[spKey2];
    if (!specs2) { rl.duringSpecialist = false; continue; }
    var found = false;
    for (var spi2 = 0; spi2 < specs2.length; spi2++) {
      if (rlS < specs2[spi2].end && rlE > specs2[spi2].start) { rl.duringSpecialist = specs2[spi2].subject; found = true; break; }
    }
    if (!found) rl.duringSpecialist = false;
  }

  return result;
}
