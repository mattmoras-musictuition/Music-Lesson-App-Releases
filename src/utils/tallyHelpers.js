// ============================================================
// TALLY HELPERS
// Pure functions for auto-tally computation, term week
// numbering, and catch-up (extra-tick) logic.
// ============================================================

import { uid, toLocalDateStr, melbourneNow, _getMondayOf } from "./helpers";

// ── Term week computation ─────────────────────────────────────────────────────

export function computeTermWeekNum(weekKey, sortedTermBreaks) {
  const d = new Date(weekKey + "T00:00:00");
  let termStartDay = null, breakEndMonth = -1;
  for (const tb of sortedTermBreaks) {
    const tbEnd = new Date((tb.endDate || tb.date) + "T00:00:00");
    if (tbEnd < d) {
      termStartDay = new Date(tbEnd);
      termStartDay.setDate(termStartDay.getDate() + 1);
      breakEndMonth = tbEnd.getMonth();
    }
  }
  if (!termStartDay || breakEndMonth === 11 || breakEndMonth === 0) {
    const year = d.getFullYear();
    const start = new Date(year, 0, 27);
    while (start.getDay() !== 2) start.setDate(start.getDate() + 1);
    termStartDay = start;
  }
  const diffWeeks = Math.round(
    (_getMondayOf(d).getTime() - _getMondayOf(termStartDay).getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  return Math.max(1, diffWeeks + 1);
}

export function computeTermKey(dateStr, sortedTermBreaks) {
  const _getT1 = (y) => {
    const s = new Date(y, 0, 27);
    while (s.getDay() !== 2) s.setDate(s.getDate() + 1);
    return s;
  };
  const d = new Date(dateStr + "T00:00:00");
  for (const y of [d.getFullYear() - 1, d.getFullYear(), d.getFullYear() + 1]) {
    let tStart = _getT1(y);
    for (const tb of sortedTermBreaks.filter(tb => new Date(tb.date + "T00:00:00").getFullYear() === y)) {
      const bs = new Date(tb.date + "T00:00:00"), be = new Date((tb.endDate || tb.date) + "T00:00:00");
      if (bs > tStart) {
        const te = new Date(bs); te.setDate(te.getDate() - 1);
        if (d >= tStart && d <= te) return `${y}-T${sortedTermBreaks.indexOf(tb) + 1}`;
        tStart = new Date(be); tStart.setDate(tStart.getDate() + 1);
        while (tStart.getDay() === 0 || tStart.getDay() === 6) tStart.setDate(tStart.getDate() + 1);
      }
    }
    if (d >= tStart) return `${y}-T${sortedTermBreaks.filter(tb => new Date(tb.date + "T00:00:00").getFullYear() === y).length + 1}`;
  }
  return null;
}

export function getTermWeeksList(dateStr, sortedTermBreaks) {
  const _getT1 = (y) => {
    const s = new Date(y, 0, 27);
    while (s.getDay() !== 2) s.setDate(s.getDate() + 1);
    return s;
  };
  const d = new Date(dateStr + "T00:00:00");
  let termStart = null, termEnd = null;
  for (const y of [d.getFullYear() - 1, d.getFullYear(), d.getFullYear() + 1]) {
    let tStart = _getT1(y);
    const yBreaks = sortedTermBreaks.filter(tb => new Date(tb.date + "T00:00:00").getFullYear() === y);
    for (const tb of yBreaks) {
      const bs = new Date(tb.date + "T00:00:00"), be = new Date((tb.endDate || tb.date) + "T00:00:00");
      if (bs > tStart) {
        const te = new Date(bs); te.setDate(te.getDate() - 1);
        if (d >= tStart && d <= te) { termStart = tStart; termEnd = te; break; }
        tStart = new Date(be); tStart.setDate(tStart.getDate() + 1);
        while (tStart.getDay() === 0 || tStart.getDay() === 6) tStart.setDate(tStart.getDate() + 1);
      }
    }
    if (!termStart && d >= tStart) { termStart = tStart; termEnd = new Date(y, 11, 18); }
    if (termStart) break;
  }
  if (!termStart || !termEnd) return [];
  const weeks = [];
  let w = _getMondayOf(termStart);
  let weekNum = 1;
  while (w <= termEnd) {
    const weekKey = toLocalDateStr(w);
    const fri = new Date(w); fri.setDate(fri.getDate() + 4);
    const inBreak = sortedTermBreaks.some(tb => weekKey >= tb.date && toLocalDateStr(fri) <= (tb.endDate || tb.date));
    if (!inBreak) weeks.push({ weekKey, weekNum });
    weekNum++;
    w = new Date(w); w.setDate(w.getDate() + 7);
  }
  return weeks;
}

// Returns true if the given school day has passed 6pm Melbourne time
export function isDayPast6pm(dayName, weekKey) {
  const dayIndex = ["Monday","Tuesday","Wednesday","Thursday","Friday"].indexOf(dayName);
  if (dayIndex < 0) return false;
  const dayDate = new Date(weekKey + "T00:00:00");
  dayDate.setDate(dayDate.getDate() + dayIndex);
  const dayDateStr = toLocalDateStr(dayDate);
  const now = melbourneNow();
  const nowStr = toLocalDateStr(now);
  return dayDateStr < nowStr || (dayDateStr === nowStr && now.getHours() >= 18);
}

// ── Auto-tally computation ────────────────────────────────────────────────────

// Compute completed tally entries for all lessons on a given past school day
export function computeAutoTallyDay(dateStr, weeklyTimetables, timetable, students, interruptions, existingTallyEntries) {
  const newEntries = [];
  const dateObj = new Date(dateStr + "T00:00:00");
  const dow = dateObj.getDay();
  if (dow === 0 || dow === 6) return newEntries;
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dow];
  const monday = _getMondayOf(dateObj);
  const weekKey = toLocalDateStr(monday);
  const termBreaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));
  const termWeekNum = computeTermWeekNum(weekKey, termBreaks);
  const weekLabel = termWeekNum ? `Week ${termWeekNum}` : `Week of ${weekKey}`;
  const termKey = computeTermKey(dateStr, termBreaks);
  const existingKeys = new Set(existingTallyEntries.map(e => `${e.lessonKey}|${e.weekKey}`));

  for (const [sk, weeklyData] of Object.entries(weeklyTimetables)) {
    const parts = sk.split("|");
    if (parts[0] !== weekKey || !parts[1]) continue;
    const schoolId = parts[1];
    const dayLessons = (weeklyData?.lessons || []).filter(l => l.day === dayName);

    for (const lesson of dayLessons) {
      if (lesson.isBandSession) {
        for (const member of (lesson.members || [])) {
          const student = students.find(s => s.id === member.studentId);
          if (!student) continue;
          const lessonKey = `${member.studentId}|${member.instrument}`;
          if (existingKeys.has(`${lessonKey}|${weekKey}`)) continue;
          existingKeys.add(`${lessonKey}|${weekKey}`);
          newEntries.push({
            id: uid(), lessonKey, lessonId: lesson.id, isGroup: false, groupName: "",
            studentId: member.studentId, studentName: student.name,
            instrument: member.instrument, schoolId,
            teacherId: lesson.teacherId || "", teacherName: lesson.teacherName || "",
            weekKey, weekLabel, weekNum: termWeekNum, termKey, day: dayName,
            status: "completed", reason: null, notes: `Band Session — ${weekLabel}`,
            bandSession: true, makeupEligible: false, madeUp: false,
            recordedAt: new Date().toISOString(), autoRecorded: true,
          });
        }
      } else if (lesson.isGroup) {
        // Group lessons: one tally entry per group row (key = group|groupId), matching TallyView lessonRows
        const lessonKey = `group|${lesson.groupId}`;
        if (existingKeys.has(`${lessonKey}|${weekKey}`)) continue;
        existingKeys.add(`${lessonKey}|${weekKey}`);
        newEntries.push({
          id: uid(), lessonKey, lessonId: lesson.id, isGroup: true,
          groupName: lesson.groupName || "", studentId: "", studentName: lesson.groupName || "",
          instrument: lesson.instrument, schoolId,
          teacherId: lesson.teacherId || "", teacherName: lesson.teacherName || "",
          weekKey, weekLabel, weekNum: termWeekNum, termKey, day: dayName,
          status: "completed", reason: null, notes: "",
          makeupEligible: false, madeUp: false,
          recordedAt: new Date().toISOString(), autoRecorded: true,
        });
      } else {
        // catch-up cards resolved by 6pm batch post-step, not as regular completed entries
        if (lesson.isMakeup) continue;
        const lessonKey = `${lesson.studentId}|${lesson.instrument}`;
        if (!lesson.studentId) continue;
        if (existingKeys.has(`${lessonKey}|${weekKey}`)) continue;
        existingKeys.add(`${lessonKey}|${weekKey}`);
        const student = students.find(s => s.id === lesson.studentId);
        newEntries.push({
          id: uid(), lessonKey, lessonId: lesson.id, isGroup: false, groupName: "",
          studentId: lesson.studentId, studentName: student?.name || lesson.studentName || "",
          instrument: lesson.instrument, schoolId,
          teacherId: lesson.teacherId || "", teacherName: lesson.teacherName || "",
          weekKey, weekLabel, weekNum: termWeekNum, termKey, day: dayName,
          status: "completed", reason: null, notes: "",
          makeupEligible: false, madeUp: false,
          recordedAt: new Date().toISOString(), autoRecorded: true,
        });
      }
    }
  }
  return newEntries;
}

// Compute extra-lesson reverse-tick entries (catch-up back-fill)
export function computeExtraTicks(newEntries, allEntries, weekKey, timetable, students, interruptions) {
  const extraTicks = [];
  const termBreaks = interruptions.filter(i => i.type === "term_break").sort((a, b) => a.date.localeCompare(b.date));
  const termWeeksList = getTermWeeksList(weekKey, termBreaks);
  if (termWeeksList.length === 0) return extraTicks;
  const studentIds = [...new Set(newEntries.filter(e => e.status === "completed" && e.studentId).map(e => e.studentId))];
  for (const studentId of studentIds) {
    const weekCompleted = new Set([
      ...allEntries.filter(e => e.studentId === studentId && e.weekKey === weekKey && e.status === "completed").map(e => e.lessonKey),
      ...newEntries.filter(e => e.studentId === studentId && e.weekKey === weekKey && e.status === "completed").map(e => e.lessonKey),
    ]);
    const weekCompletedCount = weekCompleted.size;
    const masterInstruments = new Set(
      (timetable?.lessons || []).filter(l => !l.isGroup && !l.isBandSession && l.studentId === studentId).map(l => l.instrument)
    );
    const expectedCount = Math.max(1, masterInstruments.size);
    if (weekCompletedCount <= expectedCount) continue;
    const extraCount = weekCompletedCount - expectedCount;
    const primaryInstrument = newEntries.find(e => e.studentId === studentId)?.instrument || [...masterInstruments][0];
    if (!primaryInstrument) continue;
    const lessonKey = `${studentId}|${primaryInstrument}`;
    const usedWeekKeys = new Set([
      ...allEntries.filter(e => e.lessonKey === lessonKey).map(e => e.weekKey),
      ...extraTicks.filter(e => e.lessonKey === lessonKey).map(e => e.weekKey),
      weekKey,
    ]);
    const unmarkedWeeks = [...termWeeksList].reverse().filter(w => !usedWeekKeys.has(w.weekKey));
    const weeksToTick = unmarkedWeeks.slice(0, extraCount);
    const student = students.find(s => s.id === studentId);
    const masterLesson = (timetable?.lessons || []).find(l => l.studentId === studentId && l.instrument === primaryInstrument);
    for (const w of weeksToTick) {
      const tKey = computeTermKey(w.weekKey, termBreaks);
      const srcWeekLabel = computeTermWeekNum(weekKey, termBreaks) ? `Week ${computeTermWeekNum(weekKey, termBreaks)}` : `Week of ${weekKey}`;
      extraTicks.push({
        id: uid(), lessonKey, lessonId: masterLesson?.id || "", isGroup: false, groupName: "",
        studentId, studentName: student?.name || "",
        instrument: primaryInstrument,
        schoolId: masterLesson?.schoolId || newEntries.find(e => e.studentId === studentId)?.schoolId || "",
        teacherId: masterLesson?.teacherId || "", teacherName: masterLesson?.teacherName || "",
        weekKey: w.weekKey, weekLabel: `Week ${w.weekNum}`, weekNum: w.weekNum, termKey: tKey,
        day: masterLesson?.day || "", status: "completed", reason: null,
        notes: `Extra Lesson — ${srcWeekLabel}`,
        makeupEligible: false, madeUp: false,
        recordedAt: new Date().toISOString(), autoRecorded: true,
      });
    }
  }
  return extraTicks;
}
