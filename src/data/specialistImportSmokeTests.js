// ============================================================
// Specialist import helpers (utils/specialistImport.js), v2.49.22.
// Called from runSmokeTests with its `assert`.
// ============================================================

import { classKey, knownClassNames, mapClassName, mapImportedClasses, isUnmatchedClass, toSpecialistEntry, swapSchoolEntries, buildReplacedBackup, REPLACED_BACKUP_KEY, INSTRUCTIONS_KEY, normalizeInstructionsMap, mergeInstructions, hasTimes, countRowsNeedingTimes,
  needsClassAttention, unhandledUnmatchedCodes, applyClassEdit, importDisabledReasons } from "../utils/specialistImport";

const stu = (className, schoolId = "ebps", status = "active") => ({ id: className + schoolId + status, schoolId, className, status });

export function runClassMappingTests(assert) {
  assert("class key: 3/4D", classKey("3/4D"), "34d");
  assert("class key: P/1M", classKey(" P/1M "), "p1m");

  const students = [stu("3/4D"), stu("3/4D"), stu("P/1M"), stu("5/6P"), stu("5L"), stu("Year 2Z", "other"), stu("6A", "ebps", "archived"), stu("", "ebps")];
  const known = knownClassNames(students, "ebps");
  assert("known: this school's active students only, distinct", known, ["3/4D", "5/6P", "5L", "P/1M"]);

  assert("map: 34D → 3/4D", mapClassName("34D", known), { name: "3/4D", status: "mapped" });
  assert("map: P1M → P/1M", mapClassName("P1M", known), { name: "P/1M", status: "mapped" });
  assert("map: 56P → 5/6P", mapClassName("56P", known), { name: "5/6P", status: "mapped" });
  assert("map: identical name unchanged", mapClassName("5L", known), { name: "5L", status: "same" });
  assert("map: unknown code kept as typed", mapClassName("PES", known), { name: "PES", status: "unmatched" });
  const collide = ["1/2H", "12H", "3/4D"];
  assert("map: collision → ambiguous, kept as typed", mapClassName("1-2H", collide), { name: "1-2H", status: "ambiguous" });
  assert("map: collision but exact text known → unchanged", mapClassName("12H", collide), { name: "12H", status: "same" });
  assert("map: no students → unchanged, not flagged", mapClassName("34D", []), { name: "34D", status: "unchecked" });

  const rows = [
    { id: "a", className: "34D", day: "Monday" }, { id: "b", className: "34D", day: "Tuesday" },
    { id: "c", className: "5L", day: "Monday" }, { id: "d", className: "PES", day: "Friday" },
  ];
  const m = mapImportedClasses(rows, known);
  assert("map rows: classes", m.rows.map(r => r.className), ["3/4D", "3/4D", "5L", "PES"]);
  assert("map rows: original code kept", m.rows.map(r => r.importedClass), ["34D", "34D", "5L", "PES"]);
  assert("map rows: summary once per code", m.mapping, [{ from: "34D", to: "3/4D" }]);
  assert("map rows: unmatched once per code", m.unmatched, ["PES"]);
  // School changed on Review: re-map from the imported code, not the mapped name.
  const again = mapImportedClasses(m.rows, ["34D"]);
  assert("map rows: re-map uses imported code", again.rows.map(r => r.className), ["34D", "34D", "5L", "PES"]);
  const none = mapImportedClasses(rows, []);
  assert("map rows: empty student list → unchanged, nothing flagged", [none.rows.map(r => r.className), none.mapping, none.unmatched], [["34D", "34D", "5L", "PES"], [], []]);

  assert("unmatched outline: unknown name", isUnmatchedClass("PES", known), true);
  assert("unmatched outline: known name", isUnmatchedClass("3/4D", known), false);
  assert("unmatched outline: no known names", isUnmatchedClass("PES", []), false);
  assert("saved entry drops Review fields", toSpecialistEntry({ id: "a", schoolId: "s", className: "3/4D", importedClass: "34D", day: "Monday", start: "09:00", end: "10:00", subject: "Art" }),
    { id: "a", schoolId: "s", className: "3/4D", day: "Monday", start: "09:00", end: "10:00", subject: "Art", notes: "" });
}

// "Replace all" for one school (v2.49.22).
export function runReplaceSwapTests(assert) {
  const fresh = [
    { id: "o1", schoolId: "other", className: "3A", day: "Monday", start: "09:00", end: "10:00", subject: "Art", notes: "" },
    { id: "e1", schoolId: "ebps", className: "3/4D", day: "Monday", start: "09:00", end: "09:50", subject: "Art", notes: "" },
    { id: "e2", schoolId: "ebps", className: "34D", day: "Monday", start: "11:30", end: "12:30", subject: "Kitchen", notes: "" },
    { id: "t1", schoolId: "third", className: "5B", day: "Friday", start: "13:00", end: "14:00", subject: "PE", notes: "" },
  ];
  const reviewed = [
    { id: "n1", schoolId: "ebps", className: "3/4D", day: "Monday", start: "11:30", end: "12:30", subject: "Kitchen", notes: "" },
    { id: "o1", schoolId: "ebps", className: "3/4M", day: "Monday", start: "14:30", end: "15:30", subject: "LOTE", notes: "" },
    { id: "n1", schoolId: "ebps", className: "3/4R", day: "Monday", start: "14:30", end: "15:30", subject: "Kitchen", notes: "" },
  ];
  let n = 0;
  const makeId = () => "gen" + (++n);
  const swap = swapSchoolEntries(fresh, "ebps", reviewed, makeId);
  assert("replace: other schools untouched", swap.list.filter(s => s.schoolId !== "ebps"), [fresh[0], fresh[3]]);
  assert("replace: this school's old rows all gone", swap.list.some(s => s.id === "e1" || s.id === "e2"), false);
  assert("replace: removed = this school's old rows", swap.removed.map(s => s.id), ["e1", "e2"]);
  assert("replace: reviewed rows added", swap.list.filter(s => s.schoolId === "ebps").map(s => s.className), ["3/4D", "3/4M", "3/4R"]);
  const ids = swap.list.map(s => s.id);
  assert("replace: ids unique across the list", new Set(ids).size, ids.length);
  assert("replace: clashing ids regenerated", swap.added.map(s => s.id), ["n1", "gen1", "gen2"]);
  const throws = fn => { try { fn(); return null; } catch (e) { return e.message; } };
  assert("replace: empty reviewed set refused", throws(() => swapSchoolEntries(fresh, "ebps", [], makeId)), "There are no reviewed entries to replace them with.");
  assert("replace: no school refused", throws(() => swapSchoolEntries(fresh, "", reviewed, makeId)), "No school chosen.");
  assert("replace: school with no old rows just adds", swapSchoolEntries(fresh, "new", [reviewed[0]], makeId).removed, []);
  assert("replace backup: key", REPLACED_BACKUP_KEY, "specialists_last_replaced");
  assert("replace backup: value", buildReplacedBackup({ schoolId: "ebps", schoolName: "East Bentleigh PS", rows: swap.removed, replacedAt: "2026-10-12T00:00:00.000Z" }),
    { schoolId: "ebps", schoolName: "East Bentleigh PS", replacedAt: "2026-10-12T00:00:00.000Z", count: 2, rows: swap.removed });
}

// Per-school Instructions (app_settings map), v2.49.22.
export function runInstructionsMapTests(assert) {
  assert("instructions: key", INSTRUCTIONS_KEY, "specialist_import_instructions");
  assert("instructions: bad stored values ignored", normalizeInstructionsMap({ a: "Skip RR", b: "", c: 5, d: "  " }), { a: "Skip RR" });
  assert("instructions: non-object → {}", [normalizeInstructionsMap(null), normalizeInstructionsMap("x"), normalizeInstructionsMap(["a"])], [{}, {}, {}]);
  const start = { other: "Prep only" };
  const set = mergeInstructions(start, "ebps", "Ignore Ready Room cards");
  assert("instructions: set keeps other schools", set, { other: "Prep only", ebps: "Ignore Ready Room cards" });
  assert("instructions: input not mutated", start, { other: "Prep only" });
  assert("instructions: edit replaces", mergeInstructions(set, "ebps", "New text"), { other: "Prep only", ebps: "New text" });
  assert("instructions: emptied clears", mergeInstructions(set, "ebps", "   "), { other: "Prep only" });
  assert("instructions: no school → unchanged", mergeInstructions(set, "", "x"), set);
}

// Import needs a start and an end on every row (v2.49.22).
export function runBlankTimeTests(assert) {
  assert("times: both present", hasTimes({ start: "09:00", end: "10:00" }), true);
  assert("times: empty start", hasTimes({ start: "", end: "10:00" }), false);
  assert("times: blank end", hasTimes({ start: "09:00", end: "  " }), false);
  assert("times: missing fields", hasTimes({}), false);
  assert("times: no row", hasTimes(null), false);
  assert("times: count rows needing times", countRowsNeedingTimes([{ start: "09:00", end: "10:00" }, { start: "", end: "" }, { start: "11:00" }, { end: "12:00" }]), 3);
  assert("times: none needing", countRowsNeedingTimes([{ start: "09:00", end: "10:00" }]), 0);
  assert("times: empty list", countRowsNeedingTimes([]), 0);
}

// Review hand edits (v2.49.23): amber clears once the owner sets a class,
// the value fills the other rows of the same unmatched code, the summary
// shrinks, and a greyed-out Import says why.
export function runReviewEditTests(assert) {
  const known = ["3/4D", "5/6P", "5L"];
  // Students lack the "3/4D" style here so 34D stays unmatched.
  const known2 = ["5/6P", "5L"];
  const base = mapImportedClasses([
    { id: "1", className: "34D" }, { id: "2", className: "34D" }, { id: "3", className: "PES" },
    { id: "4", className: "34D" }, { id: "5", className: "5L" }, { id: "6", className: "PES" },
  ], known2).rows;
  assert("edit: starts amber on unmatched rows", base.map(r => needsClassAttention(r, known2)), [true, true, true, true, false, true]);
  assert("edit: summary lists unmatched codes", unhandledUnmatchedCodes(base, known2), ["34D", "PES"]);

  // Owner types "3/4D" into row 0 (keystrokes) then presses Enter.
  const typed = base.map((r, i) => (i === 0 ? { ...r, className: "3/4D" } : r));
  const e1 = applyClassEdit(typed, 0, undefined, known2);
  assert("edit: same-code rows filled", e1.rows.map(r => r.className), ["3/4D", "3/4D", "PES", "3/4D", "5L", "PES"]);
  assert("edit: count and toast values", [e1.changedOthers, e1.from, e1.to], [2, "34D", "3/4D"]);
  assert("edit: amber cleared even though 3/4D matches no student", e1.rows.map(r => needsClassAttention(r, known2)), [false, false, true, false, false, true]);
  assert("edit: other codes untouched", [e1.rows[2], e1.rows[5]], [base[2], base[5]]);
  assert("edit: summary shrinks", unhandledUnmatchedCodes(e1.rows, known2), ["PES"]);

  // Owner hand-types row 3 to "3/4X", then corrects row 0 to "3/4E":
  // rows filled from row 0 follow; row 3 (typed by hand) is not overwritten.
  const t2 = e1.rows.map((r, i) => (i === 3 ? { ...r, className: "3/4X" } : r));
  const e2 = applyClassEdit(t2, 3, undefined, known2);
  // Row 3 was filled from row 0: editing it moves the other filled row (1)
  // with it, but not row 0, which the owner typed.
  assert("edit: filled rows follow a later edit", [e2.changedOthers, e2.rows.map(r => r.className)], [1, ["3/4D", "3/4X", "PES", "3/4X", "5L", "PES"]]);
  const e3 = applyClassEdit(e2.rows, 0, "3/4E", known2);
  assert("edit: hand-edited rows not overwritten", [e3.changedOthers, e3.rows.map(r => r.className)], [0, ["3/4E", "3/4X", "PES", "3/4X", "5L", "PES"]]);

  // Dropdown pick on a PES row fills the other PES row; summary empties.
  const e4 = applyClassEdit(e3.rows, 2, "P/1M", known2);
  assert("edit: dropdown pick fills same code", [e4.changedOthers, e4.rows[5].className], [1, "P/1M"]);
  assert("edit: summary empties", unhandledUnmatchedCodes(e4.rows, known2), []);

  // No change on blur: nothing happens, row stays amber.
  const same = applyClassEdit(base, 0, undefined, known2);
  assert("edit: blur without change is a no-op", [same.rows === base, needsClassAttention(same.rows[0], known2)], [true, true]);
  // Editing a matched row never fills other rows.
  const mapped = mapImportedClasses([{ id: "a", className: "34D" }, { id: "b", className: "34D" }], known).rows;
  const e5 = applyClassEdit(mapped.map((r, i) => (i === 0 ? { ...r, className: "3/4E" } : r)), 0, undefined, known);
  assert("edit: matched rows don't spread", [e5.changedOthers, e5.rows.map(r => r.className)], [0, ["3/4E", "3/4D"]]);
  assert("edit: no school names → never amber", needsClassAttention({ className: "34D" }, []), false);

  assert("disabled: needs a choice", importDisabledReasons({ existingCount: 166, mode: null, needTimes: 0 }), ["Choose Replace or Add above"]);
  assert("disabled: needs times (1)", importDisabledReasons({ existingCount: 0, needTimes: 1 }), ["1 row needs times"]);
  assert("disabled: both", importDisabledReasons({ existingCount: 166, mode: null, needTimes: 3 }), ["Choose Replace or Add above", "3 rows need times"]);
  assert("disabled: choice made, times fine", importDisabledReasons({ existingCount: 166, mode: "replace", needTimes: 0 }), []);
  assert("disabled: new school, times fine", importDisabledReasons({ existingCount: 0, mode: null, needTimes: 0 }), []);
}
