// ============================================================
// enrolmentsDB.js — Supabase load/sync for enrolments
// Pattern: same as studentsDB.js.
//
// loadEnrolmentsFromSupabase()             — read all rows for this user
// syncEnrolmentsToSupabase(enrolments, userId) — upsert all, delete removed
// ============================================================

import { supabase } from "../supabaseClient";
import { pickEnrolment } from "./enrolmentPreference";

// ── Match a card's identity to an enrolment ──────────────────
// Returns the matching enrolment.id or null. Matching rule per
// SPEC 1 §5.2 Step C: studentId + instrument, plus groupId if
// the card is a group card.
//
// Spec 3 cluster 5b-3a-patch: group cards lookup is by (groupId,
// instrument, isGroup) only. Group enrolments come back from
// rowToEnrolment with `studentId: null` (DB column is null), while
// group missed entries can have `studentId` undefined or "" — strict
// equality between null/undefined/"" was failing the lookup. The
// dedicated group branch sidesteps the studentId comparison entirely.
//
// Spec 3 cluster 5b-3a-patch-2: the individual-lookup branch matches
// by (studentId, instrument) regardless of the matched enrolment's
// isGroup flag — the earlier defensive filter on that flag excluded
// legitimate "Group" instrument records (isGroup:true + groupId:null +
// real studentId), which the pre-patch shape handled correctly.
// v2.34.0: when more than one row matches, the choice is no longer array
// position. Both branches now collect every match and hand the set to
// pickEnrolment, which prefers a live row over an ended one. The MATCHING
// RULES ABOVE ARE UNCHANGED — only the choice among multiple matches is.
//
// This is the highest-leverage site in the app: several of its ~25 callers
// WRITE the returned id onto a card (new placements at App.js, the mark-missed
// handler in WeeklyAdjustments, which re-stamps over whatever the card already
// carried). While this returned the first array match it was minting ids of
// ended enrolments onto freshly created cards.
export function enrolmentIdFor(studentId, instrument, enrolments, groupId) {
  if (groupId) {
    const groupMatches = (enrolments || []).filter(e =>
      e.isGroup === true &&
      e.groupId === groupId &&
      e.instrument === instrument
    );
    const groupMatch = pickEnrolment(groupMatches);
    return groupMatch ? groupMatch.id : null;
  }
  const matches = (enrolments || []).filter(e =>
    e.studentId === studentId &&
    e.instrument === instrument
  );
  const match = pickEnrolment(matches);
  return match ? match.id : null;
}

// Active enrolments for a student: those without an endDate.
// Pure read-side helper. Use this everywhere instead of student.instruments
// (which was stripped from the data layer by Spec 1 Commit 2b).
export function activeEnrolmentsFor(studentId, enrolments) {
  return (enrolments || []).filter(e => e.studentId === studentId && !e.endDate);
}

// Adapter — return active enrolments shaped like the legacy student.instruments[]
// element format ({ name, isGroup }). Drop-in replacement for
// `student.instruments || []` at sites still written against the old shape.
// Session 3 / C7: teacherId field dropped — teacher is lane-derived, not
// carried on the enrolment.
export function instrumentsFromEnrolments(studentId, enrolments) {
  return activeEnrolmentsFor(studentId, enrolments).map(e => ({
    name: e.instrument,
    isGroup: e.isGroup || false,
  }));
}

// Stamp enrolmentId on every lesson in an array. Idempotent —
// re-stamping a stamped lesson resolves to the same id (or null
// if the underlying enrolment has been removed).
export function stampEnrolmentIds(lessons, enrolments) {
  return (lessons || []).map(l => ({
    ...l,
    enrolmentId: enrolmentIdFor(l.studentId, l.instrument, enrolments, l.groupId),
  }));
}

// ── DB row → camelCase JS object ─────────────────────────────
// Session 3 / C7: teacher_id field no longer round-tripped. The column
// still exists in Supabase (separate SQL migration drops it); load/save
// simply ignores it.
function rowToEnrolment(row) {
  return {
    id:         row.id,
    studentId:  row.student_id,
    instrument: row.instrument,
    isGroup:    row.is_group    || false,
    groupId:    row.group_id    || undefined,
    startDate:  row.start_date,
    endDate:    row.end_date    || undefined,
  };
}

// ── camelCase JS object → DB row ─────────────────────────────
// v2.34.0 — updated_at is now stamped on write. Without it the column was
// only ever set by its insert default, so ending an enrolment left rows whose
// end_date was LATER than their own updated_at, which made the five-duplicate
// incident only partly reconstructable.
//
// Stamped unconditionally, matching the two closest analogues in the codebase
// (schoolsDB toRow and teachersDB toRow, both bulk upsert-all syncs of this
// same shape). As there, the column therefore means "last written by a sync"
// rather than "last content change", and fromRow does not read it back. That
// is enough to make end_date > updated_at impossible, which is the defect;
// true per-row change forensics would need dirty-tracking against loaded
// state, which would change this module's sync contract.
function enrolmentToRow(enrolment, userId) {
  return {
    id:         enrolment.id,
    user_id:    userId,
    student_id: enrolment.studentId  || "",
    instrument: enrolment.instrument || "",
    is_group:   enrolment.isGroup    || false,
    group_id:   enrolment.groupId    || null,
    start_date: enrolment.startDate,
    end_date:   enrolment.endDate    || null,
    updated_at: new Date().toISOString(),
  };
}

// ── Load all enrolments for the current user ────────────────
export async function loadEnrolmentsFromSupabase() {
  const { data, error } = await supabase
    .from("enrolments")
    .select("*")
    .order("student_id", { ascending: true })
    .order("instrument", { ascending: true });

  if (error) throw new Error(error.message);
  return (data || []).map(rowToEnrolment);
}

// ── Sync local enrolments array to Supabase ─────────────────
// Upserts all current enrolments, then deletes any rows in Supabase
// that are no longer in the local array (i.e. the enrolment was deleted).
export async function syncEnrolmentsToSupabase(enrolments, userId) {
  if (!userId) return;

  // 1. Upsert all current enrolments
  const rows = enrolments.map(e => enrolmentToRow(e, userId));
  const { error: upsertError } = await supabase
    .from("enrolments")
    .upsert(rows, { onConflict: "id" });

  if (upsertError) throw new Error(upsertError.message);

  // 2. Delete any Supabase rows whose id is not in the current local array
  const currentIds = enrolments.map(e => e.id);
  const { error: deleteError } = await supabase
    .from("enrolments")
    .delete()
    .eq("user_id", userId)
    .not("id", "in", `(${currentIds.join(",")})`);

  if (deleteError) throw new Error(deleteError.message);
}
