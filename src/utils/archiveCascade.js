// ============================================================
// archiveCascade.js — weekly-timetable cleanup when a student is archived.
// Pure function, no side effects, no state.
//
// v2.44.0 — archiving used to strip the student's lessons from EVERY weekly
// entry, including weeks already taught and invoiced, which erased their
// Tally history. That contradicts the v2.34.0 rule the End-enrolment cascade
// already follows: never destroy taught or invoiced weeks.
//
// Now only weeks whose Monday is strictly AFTER the archive date are cleared,
// of both lessons and misses — the same week-key comparison onEndEnrolment
// uses. The week containing the archive date and every earlier week are left
// exactly as they were (same object references).
//
// Matching is unchanged from the old archive path: by top-level studentId.
// Band sessions carry no top-level studentId, so band entries, their
// memberStates and their ledger (removedLessons) are untouched, as before.
// ============================================================

import { enrolmentIdFor } from "./enrolmentsDB";
import { pickEnrolment } from "./enrolmentPreference";
import { getTerms } from "./termWeeks";

export function purgeWeeklyAfterArchive(weeklyTimetables, studentId, archiveDate) {
  const prev = weeklyTimetables || {};
  const next = { ...prev };
  for (const key of Object.keys(next)) {
    const entry = next[key];
    if (!entry) continue;
    const weekKey = key.split("|")[0]; // monday of that week
    if (archiveDate && !(weekKey > archiveDate)) continue;
    next[key] = {
      ...entry,
      lessons: (entry.lessons || []).filter(l => l.studentId !== studentId),
      missed:  (entry.missed  || []).filter(m => m.studentId !== studentId),
    };
  }
  return next;
}

// ============================================================
// Group-aware archive cascade (fix/group-archive-member).
//
// The cascade above matched cards on top-level studentId. A group card's
// studentId is its FIRST member, so archiving that child deleted the whole
// group's card — master and every future week — and the others lost their
// lesson. Any other member stayed on the card. And the card's enrolmentId is
// ONE member's enrolment: once that child's enrolment ended, Generate and
// Import treated the whole group card as inactive and dropped it.
//
// archiveStudentCascade is the one function both archive paths call (the
// Students page and the assistant's archive_student). Owner rules (11 Oct):
//   - the child comes off every group they are in: the group record, the
//     master card, future weekly cards and future missed entries;
//   - one member left, archived inside a term → the group carries on as a
//     group of one; between terms → the group is deleted (its record, master
//     card and future cards), the remaining child keeps their group enrolment
//     and shows as Ungrouped;
//   - nobody left → the group is deleted;
//   - labels built from members' first names are rebuilt without the child;
//     any other label is left as it is;
//   - past weeks and the week containing the archive date are untouched;
//     band sessions (and their ledgers) are returned as the same objects.
// ============================================================

const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";
const firstNamesLabel = (names) => names.map(firstName).filter(Boolean).join(", ");

// A label counts as auto-built when it is its members' first names (or full
// names) joined with ", ", ignoring case — the convention the grids and
// groupDisplayNameLive use. Anything else is treated as typed and kept.
function isAutoLabel(label, names) {
  const l = String(label || "").trim().toLowerCase();
  if (!l) return false;
  return l === firstNamesLabel(names).toLowerCase()
    || l === names.map(n => String(n || "").trim()).filter(Boolean).join(", ").toLowerCase();
}

// True when `date` (YYYY-MM-DD) falls inside a term, start..end inclusive, on
// the canonical term calendar (termWeeks.getTerms over the term_break
// interruptions — the one Tally and the Dashboard use). Fails towards "in
// term" when there is no usable date, so a group is never deleted on a guess.
export function isDateInTerm(date, termBreaks) {
  if (!date) return true;
  const d = new Date(date + "T00:00:00");
  if (isNaN(d.getTime())) return true;
  return getTerms(termBreaks || [], d).some(t => d >= t.start && d <= t.end);
}

// What happens to each group the child is in.
// edits: groupId → { remaining, deleted, name }.
export function planGroupArchive({ studentId, archiveDate, termBreaks, groups, students }) {
  const nameOf = (sid) => ((students || []).find(s => s && s.id === sid) || {}).name || "";
  const inTerm = isDateInTerm(archiveDate, termBreaks);
  const edits = new Map();
  const typedNamesKept = [];
  for (const g of groups || []) {
    const ids = (g && g.studentIds) || [];
    if (!ids.includes(studentId)) continue;
    const remaining = ids.filter(id => id !== studentId);
    const deleted = remaining.length === 0 || (remaining.length === 1 && !inTerm);
    let name = g.name || "";
    if (!deleted && name) {
      if (isAutoLabel(name, ids.map(nameOf))) name = firstNamesLabel(remaining.map(nameOf));
      else typedNamesKept.push(g.id);
    }
    edits.set(g.id, { remaining, deleted, name });
  }
  return { edits, inTerm, typedNamesKept };
}

// One card (or missed entry) after the archive: the same object when it is
// not affected, null when it goes, otherwise a new card without the child.
function archiveCard(l, studentId, plan, enrolments, students) {
  if (!l || l.isBandSession) return l;
  if (!l.isGroup) return l.studentId === studentId ? null : l;
  const edit = l.groupId ? plan.edits.get(l.groupId) : null;
  if (edit && edit.deleted) return null;
  // A card without a member list stands for its group record's members.
  const ids = Array.isArray(l.studentIds) ? l.studentIds
    : edit ? [studentId, ...edit.remaining]
    : (l.studentId ? [l.studentId] : []);
  if (!ids.includes(studentId)) return l;
  const remaining = ids.filter(id => id !== studentId);
  if (remaining.length === 0) return null;

  const nameOf = (sid) => ((students || []).find(s => s && s.id === sid) || {}).name || "";
  const oldNames = Array.isArray(l.studentNames) && l.studentNames.length === ids.length
    ? l.studentNames : ids.map(nameOf);
  const studentNames = Array.isArray(l.studentNames) && l.studentNames.length === ids.length
    ? l.studentNames.filter((_, i) => ids[i] !== studentId)
    : remaining.map(sid => nameOf(sid) || "?");
  const relabel = (label) => (isAutoLabel(label, oldNames) ? firstNamesLabel(studentNames) : label);

  const next = { ...l, studentIds: remaining, studentNames, studentId: remaining[0] };
  if (l.groupName) next.groupName = relabel(l.groupName);
  if (l.studentName) next.studentName = relabel(l.studentName);

  // Re-point the card's enrolment only when it was the archived child's —
  // otherwise Generate/Import would read the ended row and drop the group.
  const owner = (enrolments || []).find(e => e && e.id === l.enrolmentId);
  if (owner && owner.studentId === studentId) {
    const pool = (enrolments || []).filter(e => e && remaining.includes(e.studentId));
    const groupPick = pickEnrolment(pool.filter(e => e.isGroup && e.groupId === l.groupId));
    next.enrolmentId = enrolmentIdFor(remaining[0], l.instrument, pool, l.groupId)
      || (groupPick ? groupPick.id : null);
  }
  return next;
}

// The list with every card run through archiveCard; the same array when
// nothing changed.
function archiveList(list, studentId, plan, enrolments, students) {
  let changed = false;
  const out = [];
  for (const x of list || []) {
    const y = archiveCard(x, studentId, plan, enrolments, students);
    if (y !== x) changed = true;
    if (y) out.push(y);
  }
  return changed ? out : list;
}

/**
 * Archive cascade for one student. Every collection is optional; a
 * collection left out comes back undefined, so a caller can run it inside
 * each state setter against that setter's latest value.
 *
 * @param {Object} p
 * @param {string} p.studentId    The child being archived.
 * @param {string} p.archiveDate  YYYY-MM-DD (Melbourne today).
 * @param {Array}  p.termBreaks   term_break interruptions.
 * @param {Array}  p.groups       Group records — always needed: the plan reads them.
 * @param {Array}  p.students     For member names (labels).
 * @param {Array}  p.enrolments   For re-pointing a group card's enrolmentId.
 * @param {Array}  [p.lessons]           Master lessons.
 * @param {Array}  [p.unscheduled]       Master unscheduled entries.
 * @param {Object} [p.weeklyTimetables]  "weekKey|schoolId" → entry.
 * @param {Array}  [p.groupsToUpdate]    Group list to rewrite (defaults to p.groups).
 */
export function archiveStudentCascade(p) {
  const { studentId, archiveDate, groups, students, enrolments } = p;
  const plan = planGroupArchive(p);
  const deletedGroupIds = [...plan.edits].filter(([, e]) => e.deleted).map(([id]) => id);

  const groupsIn = p.groupsToUpdate !== undefined ? p.groupsToUpdate : groups;
  const groupsOut = groupsIn === undefined ? undefined : (groupsIn || [])
    .filter(g => !(plan.edits.get(g.id) || {}).deleted)
    .map(g => {
      const e = plan.edits.get(g.id);
      return e ? { ...g, studentIds: e.remaining, name: e.name } : g;
    });

  const lessons = p.lessons === undefined ? undefined
    : archiveList(p.lessons, studentId, plan, enrolments, students);
  const unscheduled = p.unscheduled === undefined ? undefined
    : (p.unscheduled || []).filter(u => !(u && u.student && u.student.id === studentId));

  let weeklyTimetables;
  if (p.weeklyTimetables !== undefined) {
    const prev = p.weeklyTimetables || {};
    weeklyTimetables = { ...prev };
    for (const key of Object.keys(weeklyTimetables)) {
      const entry = weeklyTimetables[key];
      if (!entry) continue;
      const weekKey = key.split("|")[0]; // monday of that week
      if (archiveDate && !(weekKey > archiveDate)) continue;
      const l2 = archiveList(entry.lessons || [], studentId, plan, enrolments, students);
      const m2 = archiveList(entry.missed || [], studentId, plan, enrolments, students);
      if (l2 === (entry.lessons || []) && m2 === (entry.missed || [])) continue;
      weeklyTimetables[key] = { ...entry, lessons: l2, missed: m2 };
    }
  }

  return { groups: groupsOut, lessons, unscheduled, weeklyTimetables,
    deletedGroupIds, typedNamesKept: plan.typedNamesKept, inTerm: plan.inTerm };
}

// One master card brought in line with its group record — the per-card rule
// of App's group sync effect, moved here verbatim so the archive cascade's
// output can be checked against it: a card the cascade has already fixed
// must come back as the same object (the effect must never re-add the child
// or touch the re-pointed enrolmentId).
export function syncCardToGroup(l, groups, students) {
  if (!l.groupId) return l;
  const group = groups.find(g => g.id === l.groupId);
  if (!group) return l;
  const changes = {};
  // Cluster 12a: teacher-sync arm removed. Stamped teacherId/teacherName no longer
  // read post-cluster-12a; lane resolves at render time. Group name + student list
  // syncs below stay — those fields are still read at render.
  // Sync group name
  if (group.name && l.groupName !== group.name) {
    changes.groupName = group.name; changes.studentName = group.name;
  }
  // Sync student list
  const groupStudentIds = group.studentIds || [];
  if (JSON.stringify(l.studentIds || []) !== JSON.stringify(groupStudentIds)) {
    changes.studentIds = [...groupStudentIds];
    changes.studentNames = groupStudentIds.map(sid => students.find(s => s.id === sid)?.name || "?");
    if (groupStudentIds.length > 0 && l.studentId !== groupStudentIds[0]) changes.studentId = groupStudentIds[0];
  }
  if (Object.keys(changes).length === 0) return l;
  return { ...l, ...changes };
}
