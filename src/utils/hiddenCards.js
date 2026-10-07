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
