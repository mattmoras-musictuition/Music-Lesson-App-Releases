// ============================================================
// uninvoicedDerive.js
// Derives the "uninvoiced students" warning rows shared by the
// Invoicing-tab banner and the Dashboard alert chip.
// Pure functions, no side effects, no state.
//
// Logic relocated verbatim from InvoicingManager.js's
// uninvoicedStudents useMemo (Session 9) — single source of truth,
// NOT a parallel copy (Session 1 lesson). _primaryParent moved here
// with it; InvoicingManager imports it back.
// ============================================================

import { getSchoolAcronym } from "./helpers";

// Pull the primary parent record from a student — checks parentEmail/parentName
// and also the parents[] array some students may have.
// (Relocated verbatim from InvoicingManager.js.)
export function _primaryParent(student) {
  const email = student.parentEmail?.trim() || "";
  const name  = student.parentName?.trim()  || "";
  if (email || name) return { email, name };
  if (Array.isArray(student.parents) && student.parents.length) {
    const p = student.parents[0];
    return {
      email: (p.email || p.parentEmail || "").trim(),
      name:  (p.name  || p.parentName  || "").trim(),
    };
  }
  return { email: "", name: "" };
}

// Dismissal keys are term-scoped: "<termLabel>|<studentName>". A new term
// therefore starts clean, and a student later covered by an invoice drops
// out of the uninvoiced set regardless of dismissal state.
export function uninvoicedDismissKey(termLabel, studentName) {
  return `${termLabel}|${studentName}`;
}

// Session 9 — students with an active MTT enrolment in the given term who
// haven't been included on any generated invoice for that term. Returns the
// detail rows the expanded banner renders; the count is just the length.
//
// "Active MTT enrolment" = appears in timetable.lessons (non-group) OR is in
// a scheduled group's studentIds. Mirrors the two MTT paths in buildInvoices.
// Private enrolments (driven by `enrolments`, not the MTT) and band sessions
// (no top-level studentId, skipped by buildInvoices' indLessons filter)
// are not invoiced via these paths and are correctly excluded.
//
// "Covered by an invoice for the term" = any invoice with
// termLabel === termInfo.label has a line whose studentId matches the
// student's id, OR (fallback) whose studentName matches the student's name.
// Lines generated from v2.18.0 onward carry studentId, so a corrected
// spelling no longer makes a student show as permanently uninvoiced; older
// invoices have name-only lines and keep matching by name.
//
// Row shape mirrors what buildInvoices would emit: parentName resolved via
// _primaryParent (same helper buildInvoices uses transitively); instruments
// = distinct l.instrument values for individual lessons + grp.instrument ||
// grp.name fallback for groups (mirrors the group line description in
// buildInvoices); schoolAcronym via getSchoolAcronym.
//
// `dismissals` is an optional Set of uninvoicedDismissKey() strings; any
// student whose key for this term is in the set is excluded.
export function getUninvoicedStudents({ timetable, groups, students, schools, invoices, termInfo, dismissals }) {
  if (!termInfo) return [];
  const active = (students || []).filter(s => s.status !== "archived");
  const coveredIds = new Set();
  const coveredNames = new Set();
  for (const inv of (invoices || [])) {
    if (inv.termLabel !== termInfo.label) continue;
    for (const line of (inv.lines || [])) {
      if (line.studentId) coveredIds.add(line.studentId);
      if (line.studentName) coveredNames.add(line.studentName);
    }
  }
  const rows = [];
  for (const s of active) {
    if (coveredIds.has(s.id)) continue;
    if (coveredNames.has(s.name)) continue;
    if (dismissals && dismissals.has(uninvoicedDismissKey(termInfo.label, s.name))) continue;
    const instruments = [];
    // Individual lessons — distinct instruments.
    const seenInst = new Set();
    for (const l of (timetable?.lessons || [])) {
      if (l.studentId !== s.id || l.isGroup) continue;
      if (!l.instrument || seenInst.has(l.instrument)) continue;
      seenInst.add(l.instrument);
      instruments.push(l.instrument);
    }
    // Groups — grp.instrument with grp.name fallback (matches buildInvoices's
    // group line description).
    for (const g of (groups || [])) {
      if (g.status !== "scheduled") continue;
      if (!(g.studentIds || []).includes(s.id)) continue;
      const label = g.instrument || g.name || "Group";
      if (!seenInst.has(label)) {
        seenInst.add(label);
        instruments.push(label);
      }
    }
    if (instruments.length === 0) continue; // no MTT enrolment — skip
    const school = (schools || []).find(sc => sc.id === s.schoolId);
    const parentName = _primaryParent(s).name;
    rows.push({
      id: s.id,
      studentId: s.id,
      parentName: parentName || "—",
      studentName: s.name,
      instruments,
      schoolAcronym: school ? getSchoolAcronym(school) : "",
    });
  }
  return rows;
}
