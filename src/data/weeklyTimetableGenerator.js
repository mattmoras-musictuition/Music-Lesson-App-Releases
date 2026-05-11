// ============================================================
// WEEKLY TIMETABLE GENERATOR
// Per-week timetable generation with interruption handling,
// AI hint processing, and print/preview functions.
// ============================================================

import { timeToMin, groupDisplayName } from "../utils/helpers";
import { getMissedReasonProse } from "../utils/missedReasonLabels";
import { DAYS, instruments_colors } from "../constants";
import { getCardTeacherId } from "../utils/teacherCoverageDB";

// ── classMatchesInterruption ──────────────────────────────────────────────────

// Loose class name matching — handles "3A" vs "Year 3A" vs "3/4A" etc.
export function classMatchesInterruption(studentClassName, affectedClassesStr) {
  if (affectedClassesStr === "all") return true;
  const affected = affectedClassesStr.split(",").map(c => c.trim().toLowerCase());
  const cn = studentClassName.toLowerCase();
  return affected.some(ac =>
    cn.includes(ac) || ac.includes(cn) ||
    cn.replace(/[^a-z0-9]/g, "").includes(ac.replace(/[^a-z0-9]/g, "")) ||
    ac.replace(/[^a-z0-9]/g, "").includes(cn.replace(/[^a-z0-9]/g, ""))
  );
}

// ── buildWeeklyAIPrompt ───────────────────────────────────────────────────────

export function buildWeeklyAIPrompt({ school, weekLabel, weekDates, todayDay, todayDate, classNames, teacherList, groupList, studentList, adjustmentNotes, targetDay }) {
  const regenLine = targetDay ? ("\nRegenerating: " + targetDay + " only") : "";
  return "Parse these weekly timetable adjustment notes for a music lesson schedule.\n\nSchool: " + school.name + "\nWeek: " + weekLabel + " (" + weekDates[0].date + " to " + weekDates[4].date + ")\nToday is: " + todayDay + " " + todayDate + regenLine + "\nClasses at this school: " + classNames + "\nTeachers at this school: " + teacherList + "\nGroups at this school:\n" + groupList + "\nStudents:\n" + studentList + "\n\nDays: Monday\u2013Friday\nSchool hours: typically 8:30am\u20133:30pm\n\nAdjustment notes:\n\"" + adjustmentNotes + "\"\n\nFor each adjustment, extract:\n- action: \"cancel\" | \"move\" (specific time) | \"move_earlier\" | \"move_later\" | \"reschedule_day\" | \"teacher_swap\" | \"swap\" (exchange two students\' times) | \"free_specialist\" | \"blocked_window\" | \"note\" | \"tally_remove\"\n- targetStudentName: student name if specific student mentioned (null otherwise)\n- targetClassName: class name if whole class mentioned (null otherwise)\n- targetTeacherName: teacher name if a teacher is mentioned (null otherwise). IMPORTANT: Check the Teachers list \u2014 if a first name matches a teacher, set this field, not targetStudentName.\n- sourceDay: the ORIGINAL day whose lessons are affected. e.g. \"was sick on Wednesday\" \u2192 sourceDay: \"Wednesday\". If no specific day is mentioned and this is a general unavailability, set sourceDay to null.\n- targetDay: the day to reschedule TO. e.g. \"take those lessons on Friday\" \u2192 targetDay: \"Friday\"\n- targetStart: time in HH:MM 24h format (for \"move\" actions with specific time only, null otherwise)\n- notAvailableUntil: if student/teacher is unavailable until a specific time, set this to that time in HH:MM 24h format\n- blockedWindowStart/blockedWindowEnd: HH:MM 24h times for a specific window to block (e.g. recess period)\n- targetSubject: specialist subject name (for free_specialist action only)\n- targetPeriod: \"morning\" or \"afternoon\" (for free_specialist when no specific time given)\n- makeupEligible: false if user says \"no catch up\", \"no makeup\", \"write it off\", \"don\'t reschedule\" \u2014 otherwise omit\n- targetInstrument: instrument name if a specific instrument is mentioned (null otherwise)\n- targetGroupName: group lesson name if a group is referenced (null otherwise)\n- replacementTeacherName: for teacher_swap \u2014 the name of the teacher TAKING OVER the lessons\n- swapWithStudentName: for swap \u2014 the name of the SECOND student whose time slot is being exchanged\n- wholeSchool: true for cancel actions that affect all lessons (e.g. \"no lessons today\", \"school photo day\", \"whole school assembly\") \u2014 null otherwise\n- tallyRemoveReason: for tally_remove only \u2014 \"removed_not_charged\" or \"extended_absence\". Use \"removed_not_charged\" for cancellations and lessons that simply aren\'t happening; \"extended_absence\" when fees are still being charged and a place is held.\n- recurringNote: true if the user uses words like \"always\", \"every week\", \"permanently\", \"from now on\" \u2014 null otherwise\n- noteText: if recurringNote is true, a clean concise version of the constraint to save \u2014 null otherwise\n- reason: short description\n\nRules:\n- Convert 12h times to 24h. Times like 1:10, 2:00 mean PM (13:10, 14:00).\n- \"not at school until X\", \"arrives at X\", \"late arrival until X\" \u2192 action: \"note\", notAvailableUntil: X (24h)\n- CRITICAL: If someone \"was sick/away on [DayA]\" and \"will take/do those lessons on [DayB]\", this is reschedule_day with sourceDay=[DayA] and targetDay=[DayB].\n- \"[Teacher] away [Day]\" without a replacement day = cancel with sourceDay set\n- \"[Student] away\", \"no lesson for [Student]\", \"[Student] absent\" = cancel (makeupEligible: true unless specified)\n- \"cancel [Student] no catch up\" = cancel with makeupEligible: false\n- \"Move [Student] to Thursday 10:00\" = move with targetDay and targetStart\n- \"[Subject] cancelled/not on/free [period/time]\" \u2192 action: \"free_specialist\", targetSubject: subject name, targetPeriod: \"morning\" or \"afternoon\" if mentioned\n- \"[Student] can\'t do recess\" \u2192 action: \"blocked_window\", blockedWindowStart/End: recess window times\n- Whole-school events (photo day, assembly, camp) \u2192 action: \"cancel\", wholeSchool: true\n- \"[Student] always [constraint]\" \u2192 set recurringNote: true, noteText: concise description\n- \"Remove [student] from tally\", \"[student] extended absence\", \"not charging this week\", \"no tally this week\" \u2192 action: \"tally_remove\", targetStudentName: student name (or null for whole school), tallyRemoveReason as above\n- \"No lessons this week\" (whole school) \u2192 action: \"tally_remove\", wholeSchool: true, tallyRemoveReason: \"removed_not_charged\"\n\nRespond ONLY with a JSON array. No other text.";
}

// ── generateWeeklyTimetable ───────────────────────────────────────────────────

export function generateWeeklyTimetable(masterLessons, school, students, teachers, specialists, interruptions, weekDates, aiHints = [], masterBreaksForSchool = [], teacherCoverage = []) {
  const schoolLessons = masterLessons.filter(l => l.schoolId === school.id);
  const weekDateMap = {};
  for (const wd of weekDates) weekDateMap[wd.day] = wd.date;

  // Build interruption lookup for this week at this school
  const weekInterruptions = interruptions.filter(i => {
    if (i.type === "term_break") return false;
    if (i.schoolId !== school.id && i.schoolId !== "all") return false;
    const start = i.date;
    const end = i.endDate || i.date;
    return weekDates.some(wd => wd.date >= start && wd.date <= end);
  });

  const isLessonAffected = (lesson) => {
    const lessonDate = weekDateMap[lesson.day];
    if (!lessonDate) return false;
    for (const intr of weekInterruptions) {
      const start = intr.date;
      const end = intr.endDate || intr.date;
      if (lessonDate < start || lessonDate > end) continue;
      if (intr.affectsClasses !== "all") {
        const studentObj = students.find(s => s.id === lesson.studentId);
        const className = studentObj?.className || lesson.studentName || "";
        if (!classMatchesInterruption(className, intr.affectsClasses)) continue;
      }
      if (intr.startTime && intr.endTime) {
        const iStart = timeToMin(intr.startTime);
        const iEnd = timeToMin(intr.endTime);
        const lStart = timeToMin(lesson.start);
        const lEnd = timeToMin(lesson.end);
        if (lStart >= iEnd || lEnd <= iStart) continue;
      }
      return true;
    }
    for (const hint of aiHints) {
      if ((hint.action === "cancel" || hint.action === "move" || hint.action === "move_earlier" || hint.action === "move_later" || hint.action === "reschedule_day" || hint.action === "teacher_swap" || hint.action === "swap") && hint.lessonMatch && hint.lessonMatch(lesson)) return true;
    }
    return false;
  };

  const isDayBlocked = (dayName) => {
    const date = weekDateMap[dayName];
    if (!date) return true;
    return weekInterruptions.some(intr => {
      const start = intr.date;
      const end = intr.endDate || intr.date;
      if (date < start || date > end) return false;
      return intr.affectsClasses === "all" && !intr.startTime;
    });
  };

  const isSlotBlocked = (dayName, slotStart, slotEnd, className) => {
    const date = weekDateMap[dayName];
    if (!date) return true;
    for (const intr of weekInterruptions) {
      const start = intr.date;
      const end = intr.endDate || intr.date;
      if (date < start || date > end) continue;
      if (intr.affectsClasses !== "all") {
        if (!classMatchesInterruption(className, intr.affectsClasses)) continue;
      }
      if (!intr.startTime) return true;
      const iStart = timeToMin(intr.startTime);
      const iEnd = timeToMin(intr.endTime);
      const sStart = timeToMin(slotStart);
      const sEnd = timeToMin(slotEnd);
      if (sStart < iEnd && sEnd > iStart) return true;
    }
    return false;
  };

  // Build specialist lookup for this school
  const specLookup = {};
  for (const entry of specialists) {
    if (entry.schoolId !== school.id) continue;
    const key = `${entry.className}|${entry.day}`;
    if (!specLookup[key]) specLookup[key] = [];
    specLookup[key].push({ start: timeToMin(entry.start), end: timeToMin(entry.end), subject: entry.subject || true });
  }

  const isSpecCancelled = (subject, className, day, slotStart, slotEnd) => {
    return aiHints.some(h => {
      if (h.action !== "free_specialist") return false;
      if (h.targetDay && h.targetDay !== day) return false;
      if (h.targetClassName) {
        const hCls = h.targetClassName.toLowerCase();
        const sCls = className.toLowerCase();
        if (!sCls.includes(hCls) && !hCls.includes(sCls)) return false;
      }
      if (h.targetSubject) {
        const sub = (subject || "").toLowerCase();
        const hSub = h.targetSubject.toLowerCase();
        if (!sub.includes(hSub) && !hSub.includes(sub)) return false;
      }
      if (h.targetPeriod) {
        const slotHour = Math.floor(timeToMin(slotStart) / 60);
        if (h.targetPeriod === "morning" && slotHour >= 12) return false;
        if (h.targetPeriod === "afternoon" && slotHour < 12) return false;
      }
      return true;
    });
  };

  const isSpecialistClash = (className, day, slotStart, slotEnd) => {
    if (!className) return false;
    const key = `${className}|${day}`;
    const specs = specLookup[key];
    if (!specs) return false;
    const sStart = timeToMin(slotStart);
    const sEnd = timeToMin(slotEnd);
    return specs.some(sp => {
      if (sStart >= sp.end || sEnd <= sp.start) return false;
      if (isSpecCancelled(sp.subject, className, day, slotStart, slotEnd)) return false;
      return true;
    });
  };

  const getSpecialistTag = (lesson, day, slotStart, slotEnd) => {
    const studentObj = students.find(s => s.id === lesson.studentId);
    const className = studentObj?.className || "";
    if (!className) return false;
    const key = `${className}|${day}`;
    const specs = specLookup[key];
    if (!specs) return false;
    const sStart = timeToMin(slotStart);
    const sEnd = timeToMin(slotEnd);
    const match = specs.find(sp => sStart < sp.end && sEnd > sp.start);
    return match ? (match.subject || true) : false;
  };

  // Build teacher schedule from placed lessons
  const teacherSched = {};
  for (const t of teachers) teacherSched[t.id] = [];

  const isTeacherFree = (teacherId, day, slotStart, slotEnd) => {
    const avail = teachers.find(t => t.id === teacherId)?.availability.find(a => a.schoolId === school.id && a.day === day);
    if (!avail) return false;
    if (timeToMin(slotStart) < timeToMin(avail.start) || timeToMin(slotEnd) > timeToMin(avail.end)) return false;
    return !teacherSched[teacherId]?.some(s => timeToMin(s.start) < timeToMin(slotEnd) && timeToMin(slotStart) < timeToMin(s.end));
  };

  const isTeacherFreeOverride = (teacherId, day, slotStart) => {
    return !teacherSched[teacherId]?.some(s => s.day === day && s.start === slotStart);
  };

  const getNotAvailUntil = (lesson, day) => {
    for (const hint of aiHints) {
      if (hint.action !== "note" || !hint.notAvailableUntil) continue;
      if (hint.lessonMatch && hint.lessonMatch(lesson)) {
        if (!hint.sourceDay || hint.sourceDay === day) return timeToMin(hint.notAvailableUntil);
      }
    }
    return 0;
  };

  const isBlockedWindow = (lesson, day, slotStart, slotEnd) => {
    for (const hint of aiHints) {
      if (hint.action !== "blocked_window") continue;
      if (hint.lessonMatch && !hint.lessonMatch(lesson)) continue;
      if (hint.sourceDay && hint.sourceDay !== day) continue;
      if (hint.blockedWindowStart && hint.blockedWindowEnd) {
        const bS = timeToMin(hint.blockedWindowStart);
        const bE = timeToMin(hint.blockedWindowEnd);
        const sS = timeToMin(slotStart);
        const sE = timeToMin(slotEnd);
        if (sS < bE && sE > bS) return true;
      }
    }
    return false;
  };

  const placed = [];
  const missed = [];
  const swapPairs = [];

  // Process AI hints: swaps, teacher swaps, reschedule_day
  for (const hint of aiHints) {
    if (hint.action === "swap" && hint.lessonAId && hint.lessonBId) {
      const lA = schoolLessons.find(l => l.id === hint.lessonAId);
      const lB = schoolLessons.find(l => l.id === hint.lessonBId);
      if (lA && lB) swapPairs.push({ lessonA: lA, lessonB: lB });
    }
  }

  for (const lesson of schoolLessons) {
    const studentObj = students.find(s => s.id === lesson.studentId);
    const className = studentObj?.className || "";

    // Check for tally_remove hint — skip placing this lesson this week
    const isTallyRemoved = aiHints.some(h =>
      h.action === "tally_remove" && (h.wholeSchool || (h.lessonMatch && h.lessonMatch(lesson)))
    );
    if (isTallyRemoved) {
      missed.push({ ...lesson, reason: "Tally removed this week" });
      continue;
    }

    const affected = isLessonAffected(lesson);

    // Check for explicit cancel hints
    const cancelHint = aiHints.find(h =>
      h.action === "cancel" && (h.wholeSchool || (h.lessonMatch && h.lessonMatch(lesson)))
    );
    if (cancelHint && !affected) {
      const makeupEligible = cancelHint.makeupEligible !== false;
      missed.push({ ...lesson, reason: cancelHint.reason || "Cancelled", makeupEligible });
      continue;
    }

    // Check for teacher_swap hint
    const swapHint = aiHints.find(h =>
      h.action === "teacher_swap" && h.lessonMatch && h.lessonMatch(lesson) && h.replacementTeacherId
    );

    if (!affected) {
      // Lesson runs as normal — check master break conflicts
      const masterBreak = masterBreaksForSchool.find(mb =>
        mb.day === lesson.day && mb.time === lesson.start
      );
      if (masterBreak) {
        missed.push({ ...lesson, reason: "Master break conflict" });
        continue;
      }
      // Spec 2 cluster 4b — Path B: swapHint operates on teacherName only;
      // bucket_id propagates through unchanged from the source MTT card.
      // TODO(cluster-6): swapHint becomes a lane_overrides row; this
      // teacherName-override pathway gets deleted then.
      const sourceTeacherId = getCardTeacherId(lesson, teacherCoverage);
      const teacherId = swapHint ? swapHint.replacementTeacherId : sourceTeacherId;
      const teacherName = swapHint
        ? (teachers.find(t => t.id === swapHint.replacementTeacherId)?.name || lesson.teacherName)
        : lesson.teacherName;
      if (teacherId) {
        if (!teacherSched[teacherId]) teacherSched[teacherId] = [];
        teacherSched[teacherId].push({ day: lesson.day, start: lesson.start, end: lesson.end });
      }
      placed.push({
        ...lesson,
        // bucket_id propagates via spread; teacherName retained per Path B
        teacherName,
        weekDate: weekDateMap[lesson.day],
        duringSpecialist: getSpecialistTag(lesson, lesson.day, lesson.start, lesson.end),
        ...(swapHint ? { adjusted: true, adjustReason: `Teacher: ${teacherName}` } : {})
      });
      continue;
    }

    // Lesson is affected — try to reschedule
    const reschedHint = aiHints.find(h =>
      (h.action === "move" || h.action === "move_earlier" || h.action === "move_later" ||
       h.action === "reschedule_day") && h.lessonMatch && h.lessonMatch(lesson)
    );
    const fd = reschedHint?.targetDay || null;
    const ft = reschedHint?.targetStart || null;
    let found = false;

    // Spec 2 cluster 4b — resolve teacherId from bucket_id for the
    // re-scheduling teacher-busy predicates.
    const lessonTeacherId = getCardTeacherId(lesson, teacherCoverage);

    if (ft && fd) {
      // Specific target time given — find nearest slot
      const targetMin = timeToMin(ft);
      const targetSlot = school.slots.reduce((best, s) => {
        const diff = Math.abs(timeToMin(s.start) - targetMin);
        return !best || diff < best.diff ? { slot: s, diff } : best;
      }, null)?.slot;
      if (targetSlot && lessonTeacherId && isTeacherFree(lessonTeacherId, fd, targetSlot.start, targetSlot.end)) {
        if (!isSlotBlocked(fd, targetSlot.start, targetSlot.end, className)) {
          placed.push({ ...lesson, day: fd, slotId: targetSlot.id, slotName: targetSlot.name, start: targetSlot.start, end: targetSlot.end, weekDate: weekDateMap[fd], adjusted: true, adjustReason: `Moved to ${fd} ${targetSlot.start}`, duringSpecialist: getSpecialistTag(lesson, fd, targetSlot.start, targetSlot.end) });
          teacherSched[lessonTeacherId].push({ day: fd, start: targetSlot.start, end: targetSlot.end });
          found = true;
        }
      }
    }

    if (!found) {
      // Try all days/slots to find an open slot
      const dayOrder = fd
        ? [fd, ...(school.days || DAYS).filter(d => d !== fd)]
        : [lesson.day, ...(school.days || DAYS).filter(d => d !== lesson.day)];
      for (const day of dayOrder) {
        if (found) break;
        const isAiDirectedDay = fd && day === fd;
        if (!isAiDirectedDay && isDayBlocked(day)) continue;
        for (const slot of school.slots) {
          if (slot.type !== "class" && !["recess", "lunch", "before_school", "after_school"].includes(slot.type)) continue;
          if (!isAiDirectedDay && isSlotBlocked(day, slot.start, slot.end, className)) continue;
          if (!isAiDirectedDay && !lesson.duringSpecialist && isSpecialistClash(className, day, slot.start, slot.end)) continue;
          if (!lessonTeacherId) continue;
          if (isAiDirectedDay ? !isTeacherFreeOverride(lessonTeacherId, day, slot.start) : !isTeacherFree(lessonTeacherId, day, slot.start, slot.end)) continue;
          if (getNotAvailUntil(lesson, day) > timeToMin(slot.start)) continue;
          if (isBlockedWindow(lesson, day, slot.start, slot.end)) continue;
          const reason = fd ? `Rescheduled to ${day}` : day === lesson.day ? "Time changed (interruption)" : `Moved to ${day} (interruption)`;
          placed.push({ ...lesson, day, slotId: slot.id, slotName: slot.name, start: slot.start, end: slot.end, weekDate: weekDateMap[day], adjusted: true, adjustReason: reason, duringSpecialist: getSpecialistTag(lesson, day, slot.start, slot.end) });
          teacherSched[lessonTeacherId].push({ day, start: slot.start, end: slot.end });
          found = true;
          break;
        }
      }
      if (!found) {
        const intrTitle = weekInterruptions.find(intr => {
          const date = weekDateMap[lesson.day];
          return date && date >= intr.date && date <= (intr.endDate || intr.date);
        })?.title || "Interruption / no slot";
        missed.push({ ...lesson, reason: `No available slot — ${intrTitle}` });
      }
    }
  }

  // Process swap pairs
  for (const { lessonA, lessonB } of swapPairs) {
    const idxA = placed.findIndex(l => l.id === lessonA.id);
    const idxB = placed.findIndex(l => l.id === lessonB.id);
    if (idxA !== -1 && idxB !== -1) {
      const pA = placed[idxA];
      const pB = placed[idxB];
      placed[idxA] = { ...pA, day: pB.day, slotId: pB.slotId, slotName: pB.slotName, start: pB.start, end: pB.end, weekDate: pB.weekDate, adjusted: true, adjustReason: `Swapped with ${pB.studentName}` };
      placed[idxB] = { ...pB, day: pA.day, slotId: pA.slotId, slotName: pA.slotName, start: pA.start, end: pA.end, weekDate: pA.weekDate, adjusted: true, adjustReason: `Swapped with ${pA.studentName}` };
    }
  }

  return { lessons: placed, missed };
}

// ── Print functions ───────────────────────────────────────────────────────────

// TODO(cluster-5): teacherName is read from the stamped lesson field for now;
// cluster 5 swaps render-side teacher resolution to lane lookup via bucket_id.
// Phase 3 cleanup (cluster 12) strips teacherName from JSONB cards entirely.
export function printMasterTimetable(timetable, schools, students, teachers) {
  if (!timetable || !timetable.lessons || timetable.lessons.length === 0) return;
  const DAYS_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const inst_colors = instruments_colors;
  const getColor = (inst, isGroup) => isGroup ? inst_colors.Group : (inst_colors[inst] || inst_colors.default);

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Master Timetable</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 11px; color: #1f2937; background: #fff; padding: 10mm; }
  @page { size: landscape; margin: 8mm 10mm; }
  @media print { body { padding: 0; } .no-print { display: none; } }
  h1 { font-size: 18px; color: #344565; margin-bottom: 12px; }
  h2 { font-size: 13px; color: #C47A6A; margin: 16px 0 6px; border-bottom: 2px solid #C47A6A; padding-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  th { background: #f3f4f6; font-weight: 700; font-size: 10px; padding: 5px 8px; text-align: center; border: 1px solid #e5e7eb; color: #374151; }
  th.time-col { width: 52px; text-align: left; }
  td { padding: 3px 4px; border: 1px solid #f3f4f6; vertical-align: top; min-width: 100px; }
  td.time-cell { font-size: 10px; color: #9ca3af; padding: 4px 6px; white-space: nowrap; }
  .lesson-card { border-radius: 4px; padding: 4px 6px; margin-bottom: 2px; border-left: 3px solid #ccc; }
  .lesson-name { font-weight: 700; font-size: 11px; }
  .lesson-detail { font-size: 10px; color: #374151; margin-top: 1px; }
  .lesson-teacher { font-size: 9px; color: #9ca3af; }
  .print-btn { position: fixed; bottom: 16px; right: 16px; padding: 10px 20px; background: #344565; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-family: inherit; z-index: 999; }
</style></head><body>
<h1>Master Timetable</h1>
<button class="no-print print-btn" onclick="window.print()">🖨 Print / Save PDF</button>
`;

  for (const school of schools) {
    const schoolLessons = timetable.lessons.filter(l => l.schoolId === school.id);
    if (schoolLessons.length === 0) continue;
    const times = [...new Set(schoolLessons.map(l => l.start))].sort((a, b) => timeToMin(a) - timeToMin(b));
    const grid = {};
    for (const day of DAYS_ORDER) grid[day] = {};
    for (const l of schoolLessons) {
      if (!grid[l.day]) continue;
      if (!grid[l.day][l.start]) grid[l.day][l.start] = [];
      grid[l.day][l.start].push(l);
    }
    html += `<h2>${school.name}</h2>`;
    html += `<table><thead><tr><th class="time-col">Time</th>`;
    for (const day of DAYS_ORDER) html += `<th>${day}</th>`;
    html += `</tr></thead><tbody>`;
    for (const time of times) {
      html += `<tr><td class="time-cell">${time}</td>`;
      for (const day of DAYS_ORDER) {
        const cells = grid[day][time] || [];
        html += `<td>`;
        for (const l of cells) {
          const col = getColor(l.instrument, l.isGroup);
          const student = l.isGroup ? groupDisplayName(l) : l.studentName;
          const stObj = students.find(s => s.id === l.studentId);
          const classLabel = stObj?.className ? ` · ${stObj.className}` : "";
          html += `<div class="lesson-card" style="background:${col}18;border-left-color:${col}">
            <div class="lesson-name">${student}${classLabel}</div>
            <div class="lesson-detail">${l.instrument || ""}</div>
            <div class="lesson-teacher">${l.teacherName || ""}</div>
          </div>`;
        }
        html += `</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `</body></html>`;
  const win = window.open("", "_blank");
  if (win) { win.document.write(html); win.document.close(); }
}

export function printWeeklyTimetable(weeklyTimetables, schools, students, weekDates, weekLabel) {
  const DAYS_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const inst_colors = instruments_colors;
  const getColor = (inst, isGroup) => isGroup ? inst_colors.Group : (inst_colors[inst] || inst_colors.default);

  // Build per-school data
  const allSchoolData = [];
  for (const school of schools) {
    const key = `${weekDates[0].date}|${school.id}`;
    const weekData = weeklyTimetables[key];
    if (!weekData) continue;
    allSchoolData.push({ school, lessons: weekData.lessons || [], missed: weekData.missed || [] });
  }
  if (allSchoolData.length === 0) return;

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Weekly Timetable</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 11px; color: #1f2937; background: #fff; padding: 10mm; }
  @page { size: landscape; margin: 8mm 10mm; }
  @media print { body { padding: 0; } .no-print { display: none; } }
  h1 { font-size: 18px; color: #344565; margin-bottom: 4px; }
  h2 { font-size: 13px; color: #C47A6A; margin: 16px 0 6px; border-bottom: 2px solid #C47A6A; padding-bottom: 3px; }
  .week-label { font-size: 11px; color: #6b7280; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  th { background: #344565; color: #fff; font-weight: 600; font-size: 10px; padding: 6px 8px; text-align: center; border: 1px solid #2a3654; }
  th.time-col { width: 52px; text-align: left; background: #f3f4f6; color: #374151; }
  td { padding: 3px 4px; border: 1px solid #f3f4f6; vertical-align: top; min-width: 100px; }
  td.time-cell { font-size: 10px; color: #9ca3af; padding: 4px 6px; white-space: nowrap; background: #fafafa; }
  .lesson-card { border-radius: 4px; padding: 4px 6px; margin-bottom: 2px; border-left: 3px solid #ccc; }
  .lesson-card.adjusted { border-bottom: 2px solid #F59E0B; }
  .lesson-name { font-weight: 700; font-size: 11px; }
  .lesson-detail { font-size: 10px; color: #374151; margin-top: 1px; }
  .lesson-teacher { font-size: 9px; color: #9ca3af; }
  .missed-section { margin-top: 6px; margin-bottom: 12px; }
  .missed-chip { display: inline-block; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; padding: 2px 7px; font-size: 10px; color: #dc2626; margin: 2px; }
  .print-btn { position: fixed; bottom: 16px; right: 16px; padding: 10px 20px; background: #344565; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-family: inherit; z-index: 999; }
  .stats { display: flex; gap: 16px; margin-bottom: 14px; font-size: 11px; }
  .stat { background: #f9fafb; border-radius: 6px; padding: 5px 12px; }
  .stat strong { font-size: 14px; display: block; }
</style></head><body>
<h1>Weekly Timetable</h1>
<div class="week-label">${weekLabel} &nbsp;·&nbsp; ${weekDates.map(wd => `${wd.day.slice(0,3)} ${wd.date}`).join(" &nbsp; ")}</div>
<button class="no-print print-btn" onclick="window.print()">🖨 Print / Save PDF</button>
`;

  for (const { school, lessons, missed } of allSchoolData) {
    const totalLessons = lessons.length;
    const adjustedCount = lessons.filter(l => l.adjusted).length;
    const missedCount = missed.length;

    html += `<h2>${school.name}</h2>
<div class="stats">
  <div class="stat"><strong>${totalLessons}</strong>Lessons</div>
  <div class="stat"><strong style="color:#D97706">${adjustedCount}</strong>Adjusted</div>
  <div class="stat"><strong style="color:#DC2626">${missedCount}</strong>Cancelled</div>
</div>`;

    const grid = {};
    for (const day of DAYS_ORDER) { grid[day] = {}; }
    for (const l of lessons) {
      if (!grid[l.day]) continue;
      if (!grid[l.day][l.start]) grid[l.day][l.start] = [];
      grid[l.day][l.start].push(l);
    }

    const schoolTimes = new Set(lessons.map(l => l.start));
    const schoolSortedTimes = [...schoolTimes].sort((a, b) => timeToMin(a) - timeToMin(b));
    if (schoolSortedTimes.length === 0) continue;

    html += `<table><thead><tr><th class="time-col">Time</th>`;
    for (const day of DAYS_ORDER) {
      const wd = weekDates.find(w => w.day === day);
      html += `<th>${day.slice(0,3)}<br><span style="font-weight:400;color:rgba(255,255,255,0.7)">${wd ? wd.date : ""}</span></th>`;
    }
    html += `</tr></thead><tbody>`;

    for (const time of schoolSortedTimes) {
      html += `<tr><td class="time-cell">${time}</td>`;
      for (const day of DAYS_ORDER) {
        const cellLessons = grid[day][time] || [];
        html += `<td>`;
        for (const l of cellLessons) {
          const col = getColor(l.instrument, l.isGroup);
          const cls = l.adjusted ? "lesson-card adjusted" : "lesson-card";
          const student = l.isGroup ? groupDisplayName(l) : l.studentName;
          const stObj = students.find(s => s.id === l.studentId);
          const classLabel = stObj?.className ? ` · ${stObj.className}` : "";
          html += `<div class="${cls}" style="background:${col}18;border-left-color:${col}">
            <div class="lesson-name">${student}${classLabel}</div>
            <div class="lesson-detail">${l.instrument || ""}${l.adjustReason && l.adjusted ? ` <span style="color:#D97706">· ${l.adjustReason}</span>` : ""}</div>
            <div class="lesson-teacher">${l.teacherName ? l.teacherName.split(" ")[0] : ""}</div>
          </div>`;
        }
        html += `</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;

    if (missed.length > 0) {
      html += `<div class="missed-section"><strong style="font-size:11px;color:#6b7280">Cancelled/Missed:</strong><br>`;
      for (const m of missed) {
        const reasonProse = getMissedReasonProse(m.reason, m.reasonDetail);
        const reasonText = reasonProse ? ` — ${reasonProse}` : "";
        html += `<span class="missed-chip">${m.studentName} (${m.instrument}) ${m.day}${reasonText}</span>`;
      }
      html += `</div>`;
    }
  }

  html += `</body></html>`;
  const win = window.open("", "_blank");
  if (win) { win.document.write(html); win.document.close(); }
}
