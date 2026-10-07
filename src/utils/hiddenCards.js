// ============================================================
// hiddenCards.js — the one "hidden archived card" rule.
// Pure, no state.
//
// The WTT and MTT grids hide a NON-GROUP card whose student is archived (the
// slot reads as free). Archiving deliberately keeps the current week's saved
// lessons for Tally history (v2.44.0, archiveCascade.js), so such cards still
// sit in the saved data. Anything that decides what the owner sees — the
// grids, clash checks, warning passes — uses this rule so a card that is
// hidden is never counted against a visible one.
//
// Group and band cards are never hidden by this rule (band sessions carry no
// top-level studentId). It reads live student status, so un-archiving brings
// the card straight back with no extra step.
// ============================================================

export function isHiddenArchivedCard(lesson, students) {
  if (!lesson || lesson.isGroup || !lesson.studentId) return false;
  const stu = (students || []).find(s => s.id === lesson.studentId);
  return stu?.status === "archived";
}

// Same rule, precomputed for loops over many cards: one pass over students,
// then a Set lookup per card.
export function makeHiddenArchivedCardTest(students) {
  const archived = new Set((students || []).filter(s => s && s.status === "archived").map(s => s.id));
  return lesson => !!(lesson && !lesson.isGroup && lesson.studentId && archived.has(lesson.studentId));
}

// ── Visible-lessons selectors (v2.49.2) ──────────────────────────
// What the grid shows, for everything the owner or anyone else sees or
// receives: grids, exports, prints, day-header email recipient lists and the
// timetable attached to them, Dashboard counts. NOT for history (Tally,
// ledger, invoicing, Data Health, archive/restore, saving or syncing) — those
// keep reading the saved lessons as they are.

export function visibleLessons(lessons, students) {
  const isHidden = makeHiddenArchivedCardTest(students);
  return (lessons || []).filter(l => !isHidden(l));
}

// weeklyTimetables map with each entry's lessons narrowed to visible ones.
// A read-only view for print/output; never saved.
export function visibleWeeklyTimetables(weeklyTimetables, students) {
  const isHidden = makeHiddenArchivedCardTest(students);
  const out = {};
  for (const [key, entry] of Object.entries(weeklyTimetables || {})) {
    out[key] = entry ? { ...entry, lessons: (entry.lessons || []).filter(l => !isHidden(l)) } : entry;
  }
  return out;
}

// Day-header "email parents" recipients: one row per distinct address, in
// lesson order, from the given (already visible, day-narrowed) lessons.
// studentIdsOf(lesson) says which students a card stands for (solo, group
// members, band attendees). Covers both parent shapes: parents[] and the
// assistant-written top-level parentEmail.
export function dayParentRows(lessons, students, studentIdsOf) {
  const seen = new Set();
  const rows = [];
  const add = (name, email) => {
    const e = (email || "").trim();
    if (!e || seen.has(e.toLowerCase())) return;
    seen.add(e.toLowerCase());
    rows.push({ name: name || e, email: e });
  };
  for (const l of lessons || []) {
    for (const sid of studentIdsOf(l) || []) {
      const st = (students || []).find(s => s.id === sid);
      if (!st) continue;
      (st.parents || []).forEach(p => add(p.name, p.email));
      add(st.parentName, st.parentEmail);
    }
  }
  return rows;
}
