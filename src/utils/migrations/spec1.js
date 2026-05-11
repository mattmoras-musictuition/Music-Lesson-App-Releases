// ============================================================
// migrations/spec1.js — Phase 3 Spec 1 one-shot migration
//
// Pure function. Does not mutate React state, write to
// localStorage, or call Supabase. Reads localStorage once for
// the idempotency marker (acceptable per spec §4.2, only ever
// runs in a browser context). Caller applies results via setters.
//
// See SPEC_1_enrolments_and_tally_from_wtt.md §5 for design.
// ============================================================

import { uid } from "../helpers";
import { enrolmentIdFor } from "../enrolmentsDB";

const MIGRATION_MARKER_KEY = "mt-migration-spec1-done";

function emptyStats() {
  return {
    enrolmentsCreated: 0,
    mttCardsStamped: 0,
    wttLessonsStamped: 0,
    wttMissedStamped: 0,
    tallyEntriesReconciled: 0,
    warningCount: 0,
  };
}

// Three-tier groupId resolution (locked 21 April 2026).
// Tier 1: strict — group.instrument explicitly matches.
// Tier 2: fallback for legacy blank-instrument groups, confirmed
//         by consensus (another member has this instrument as isGroup).
// Tier 3: no match — warn + null.
function resolveGroupId(student, instr, groups, students, warnings) {
  if (!instr.isGroup) return undefined;

  const strictMatch = (groups || []).find(g =>
    g.instrument === instr.name &&
    Array.isArray(g.studentIds) &&
    g.studentIds.includes(student.id)
  );
  if (strictMatch) return strictMatch.id;

  const blankInstrGroups = (groups || []).filter(g =>
    (!g.instrument || g.instrument === "") &&
    Array.isArray(g.studentIds) &&
    g.studentIds.includes(student.id)
  );

  const confirmedByConsensus = blankInstrGroups.filter(g => {
    const otherMemberIds = g.studentIds.filter(sid => sid !== student.id);
    if (otherMemberIds.length === 0) return true;
    return otherMemberIds.some(sid => {
      const other = (students || []).find(s => s.id === sid);
      return other && (other.instruments || []).some(
        i => i.name === instr.name && i.isGroup
      );
    });
  });

  if (confirmedByConsensus.length === 1) {
    warnings.push(
      `Resolved ${student.name}'s ${instr.name} (group) to group ${confirmedByConsensus[0].id} via studentIds-only fallback — group record has blank instrument field. Consider backfilling group.instrument in GroupsManager.`
    );
    return confirmedByConsensus[0].id;
  }
  if (confirmedByConsensus.length > 1) {
    warnings.push(
      `Ambiguous group match for ${student.name} (${instr.name}) — multiple blank-instrument groups claim this student and match by consensus. Using groupId: null.`
    );
    return null;
  }
  if (blankInstrGroups.length > 0) {
    warnings.push(
      `Could not confirm group instrument for ${student.name}'s ${instr.name} (group) — matching blank-instrument groups don't have other members with this instrument. Using groupId: null.`
    );
    return null;
  }

  warnings.push(
    `Group enrolment for ${student.name} (${instr.name}) has no matching group in groups collection — created with groupId: null.`
  );
  return null;
}

function inferStartDate(student, instr, weeklyTimetables, tallyEntries, termStartDate) {
  if (student.status === "trial" || student.status === "pending") {
    return new Date().toISOString().slice(0, 10);
  }

  let earliest = null;
  for (const key in weeklyTimetables) {
    const wd = weeklyTimetables[key] || {};
    const weekKey = (key.split("|")[0]) || "";
    const appears =
      (wd.lessons || []).some(l => l.studentId === student.id && l.instrument === instr.name) ||
      (wd.missed || []).some(m => m.studentId === student.id && m.instrument === instr.name);
    if (appears && (!earliest || weekKey < earliest)) earliest = weekKey;
  }
  if (earliest) return earliest;

  const tEntries = (tallyEntries || []).filter(t =>
    t.studentId === student.id && t.instrument === instr.name
  );
  if (tEntries.length > 0) {
    return tEntries.reduce((min, t) => (!min || t.weekKey < min ? t.weekKey : min), null);
  }

  return termStartDate;
}

function inferEndDate(student) {
  if (student.status === "archived") {
    return student.archivedAt
      ? student.archivedAt.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  }
  return undefined;
}

// Resolve groupId for a tally entry by matching the new enrolments on
// studentId + instrument + isGroup. Returns the matched enrolment's
// groupId, or null if no match (undefined if not a group).
function resolveGroupIdForTally(t, enrolments, warnings) {
  if (!t.isGroup) return undefined;
  const matches = enrolments.filter(e =>
    e.studentId === t.studentId &&
    e.instrument === t.instrument &&
    e.isGroup === true
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    warnings.push(
      `Multiple group enrolments match tally entry for ${t.studentName || t.studentId} (${t.instrument}) week ${t.weekKey} — using first.`
    );
  }
  return matches[0].groupId ?? null;
}

export function runSpec1Migration({
  students,
  timetable,
  weeklyTimetables,
  tallyEntries,
  groups,
  termStartDate,
}) {
  // §4.2 — idempotency: bail before doing any work
  const stateAlreadyMigrated =
    !students.some(s => Array.isArray(s.instruments) && s.instruments.length > 0);
  const markerSet =
    typeof localStorage !== "undefined" &&
    !!localStorage.getItem(MIGRATION_MARKER_KEY);

  if (stateAlreadyMigrated || markerSet) {
    return {
      skipped: true,
      reason: stateAlreadyMigrated ? "state already migrated" : "marker set",
      students,
      enrolments: [],
      timetable,
      weeklyTimetables,
      tallyEntries,
      warnings: [],
      stats: emptyStats(),
    };
  }

  const warnings = [];

  // §4.3 Step A — build enrolments from students × instruments[]
  const enrolments = [];
  for (const student of students) {
    for (const instr of (student.instruments || [])) {
      enrolments.push({
        id: uid(),
        studentId: student.id,
        instrument: instr.name,
        teacherId: instr.teacherId || "",
        isGroup: instr.isGroup || false,
        groupId: resolveGroupId(student, instr, groups, students, warnings),
        startDate: inferStartDate(student, instr, weeklyTimetables, tallyEntries, termStartDate),
        endDate: inferEndDate(student),
      });
    }
  }

  // §4.4 Step B — strip instruments[] from students
  const newStudents = students.map(s => {
    const { instruments, ...rest } = s;
    return rest;
  });

  // §4.5 Step C — stamp enrolmentId on MTT cards
  let mttCardsStamped = 0;
  const newLessons = (timetable?.lessons || []).map(l => {
    const id = enrolmentIdFor(l.studentId, l.instrument, enrolments, l.groupId);
    if (id) {
      mttCardsStamped++;
    } else {
      warnings.push(
        `Dangling MTT card: ${l.studentName || l.studentId} (${l.instrument}) at ${l.day} ${l.start} — no matching enrolment.`
      );
    }
    return { ...l, enrolmentId: id };
  });
  const newTimetable = { ...timetable, lessons: newLessons };

  // §4.6 Step D — stamp enrolmentId on WTT lessons + missed entries
  let wttLessonsStamped = 0;
  let wttMissedStamped = 0;
  const newWeeklyTimetables = {};
  for (const key in weeklyTimetables) {
    const wd = weeklyTimetables[key] || {};
    const newLessonsWTT = (wd.lessons || []).map(l => {
      const id = enrolmentIdFor(l.studentId, l.instrument, enrolments, l.groupId);
      if (id) wttLessonsStamped++;
      else warnings.push(`Dangling WTT lesson in ${key}: ${l.studentName || l.studentId} (${l.instrument}).`);
      return { ...l, enrolmentId: id };
    });
    const newMissedWTT = (wd.missed || []).map(m => {
      const id = enrolmentIdFor(m.studentId, m.instrument, enrolments, m.groupId);
      if (id) wttMissedStamped++;
      else warnings.push(`Dangling WTT missed in ${key}: ${m.studentName || m.studentId} (${m.instrument}).`);
      return { ...m, enrolmentId: id };
    });
    newWeeklyTimetables[key] = { ...wd, lessons: newLessonsWTT, missed: newMissedWTT };
  }

  // §4.7 Step E — reconcile tallyEntries
  let tallyEntriesReconciled = 0;
  const newTallyEntries = [];

  for (const t of (tallyEntries || [])) {
    newTallyEntries.push(t);

    const wttKey = `${t.weekKey}|${t.schoolId}`;
    const wd = newWeeklyTimetables[wttKey];
    if (!wd) continue;

    const resolvedGroupId = resolveGroupIdForTally(t, enrolments, warnings);
    const resolvedEnrolmentId = enrolmentIdFor(
      t.studentId,
      t.instrument,
      enrolments,
      t.isGroup ? resolvedGroupId : undefined
    );

    // Missed entries don't carry weekKey — they're scoped by the wd we're
    // already inside. Match on enrolmentId first, then on studentId + instrument.
    const existingMissed = (wd.missed || []).find(m =>
      (m.enrolmentId && m.enrolmentId === resolvedEnrolmentId) ||
      (m.studentId === t.studentId && m.instrument === t.instrument)
    );

    if (existingMissed) {
      const fields = ["reason", "notes", "makeupEligible", "madeUp"];
      const differs = fields.some(f => existingMissed[f] !== t[f]);
      if (differs) {
        warnings.push(
          `Tally/WTT annotation mismatch for ${t.studentName || t.studentId} (${t.instrument}) in ${t.weekKey}: WTT values retained.`
        );
      }
      tallyEntriesReconciled++;
    } else if (t.status === "missed") {
      // Explicit allowlist (locked 21 April 2026 — see spec §3.2 vs §3.3).
      // Do NOT carry t.invoiced — budgeting app owns billed state (session 102).
      wd.missed = wd.missed || [];
      wd.missed.push({
        studentId:      t.studentId,
        studentName:    t.studentName,
        instrument:     t.instrument,
        schoolId:       t.schoolId,
        teacherId:      t.teacherId,
        teacherName:    t.teacherName,
        day:            t.day,
        isGroup:        t.isGroup || false,
        groupId:        resolvedGroupId,
        groupName:      t.groupName,
        reason:         t.reason,
        reasonDetail:   t.reasonDetail,
        notes:          t.notes,
        makeupEligible: t.makeupEligible,
        madeUp:         t.madeUp,
        enrolmentId:    resolvedEnrolmentId,
      });
      tallyEntriesReconciled++;
    }
    // status === "completed" or "removed": no action needed
  }

  // §4.8 — return
  return {
    skipped: false,
    students: newStudents,
    enrolments,
    timetable: newTimetable,
    weeklyTimetables: newWeeklyTimetables,
    tallyEntries: newTallyEntries,
    warnings,
    stats: {
      enrolmentsCreated: enrolments.length,
      mttCardsStamped,
      wttLessonsStamped,
      wttMissedStamped,
      tallyEntriesReconciled,
      warningCount: warnings.length,
    },
  };
}
