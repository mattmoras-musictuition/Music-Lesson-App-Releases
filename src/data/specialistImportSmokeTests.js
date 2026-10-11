// ============================================================
// Specialist import helpers (utils/specialistImport.js), v2.49.22.
// Called from runSmokeTests with its `assert`.
// ============================================================

import { classKey, knownClassNames, mapClassName, mapImportedClasses, isUnmatchedClass, toSpecialistEntry, swapSchoolEntries, buildReplacedBackup, REPLACED_BACKUP_KEY, INSTRUCTIONS_KEY, normalizeInstructionsMap, mergeInstructions, hasTimes, countRowsNeedingTimes } from "../utils/specialistImport";

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
