// ============================================================
// Specialist import helpers (utils/specialistImport.js), v2.49.22.
// Called from runSmokeTests with its `assert`.
// ============================================================

import { classKey, knownClassNames, mapClassName, mapImportedClasses, isUnmatchedClass, toSpecialistEntry } from "../utils/specialistImport";

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
