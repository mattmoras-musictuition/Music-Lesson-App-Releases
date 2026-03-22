// ============================================================
// SMOKE TESTS
// Runs once at startup in development to catch regressions
// in core logic functions.
// ============================================================

import { timeToMin, getSchoolAcronym } from "../utils/helpers";
import { migrateData, defaultSlots } from "../utils/backup";
import { generateMasterTimetable } from "./timetableGenerator";

export function runSmokeTests(logErrorFn) {
  const results = [];
  const assert = (label, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ label, pass, actual, expected });
  };
  const assertTruthy = (label, val) => {
    results.push({ label, pass: !!val, actual: val, expected: "truthy" });
  };

  // timeToMin roundtrip
  assert("timeToMin 09:00", timeToMin("09:00"), 540);
  assert("timeToMin 14:30", timeToMin("14:30"), 870);

  // getSchoolAcronym — explicit acronym field takes priority over auto-derivation
  assert("acronym explicit field", getSchoolAcronym({ name: "Solway Primary School", acronym: "SPS" }), "SPS");
  assert("acronym auto-derive",    getSchoolAcronym({ name: "East Bentleigh Primary School" }), "EBPS");
  assert("acronym fallback empty", getSchoolAcronym({ name: "Moorabbin Primary School", acronym: "" }), "MPS");

  // migrateData — students
  const rawStudent = { id: "x", name: "Test", schoolId: "s1", className: "3A", instruments: [{ name: "Piano" }] };
  const migrated = migrateData("students", [rawStudent])[0];
  assert("migrate student notes default", migrated.notes, "");
  assert("migrate student status default", migrated.status, "active");
  assert("migrate student instruments preserved", migrated.instruments[0].name, "Piano");

  // migrateData — tallyEntries weekLabel backfill
  const rawEntry = { id: "t1", weekKey: "2026-01-19", studentId: "s", instrument: "Piano", status: "missed", madeUp: false };
  const migratedEntry = migrateData("tallyEntries", [rawEntry])[0];
  assertTruthy("migrate tally weekLabel backfill", migratedEntry.weekLabel);
  assert("migrate tally makeupEligible default", migratedEntry.makeupEligible, true);

  // generateMasterTimetable basic smoke — one school, one student, one teacher
  try {
    const school = { id: "s1", name: "Test School", classNames: ["3A"], slots: defaultSlots() };
    const student = { id: "st1", name: "Alice", schoolId: "s1", className: "3A", status: "active",
      instruments: [{ name: "Piano", duration: 30 }], outsideClassOnly: false, availableBefore: false, availableAfter: false,
      outsideClassPreferred: false, avoidTimes: [], preferredTimes: [], notes: "" };
    const teacher = { id: "t1", name: "Teacher A",
      availability: [{ schoolId: "s1", days: ["Monday","Tuesday","Wednesday","Thursday","Friday"] }],
      instruments: ["Piano"] };
    const result = generateMasterTimetable([school], [student], [teacher]);
    assertTruthy("generateMasterTimetable returns result", result);
    assertTruthy("generateMasterTimetable has lessons array", Array.isArray(result.lessons));
  } catch(e) {
    results.push({ label: "generateMasterTimetable smoke", pass: false, actual: e.message, expected: "no error" });
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  if (failed.length > 0) {
    console.warn("Smoke tests: " + passed + "/" + results.length + " passed. Failures:");
    failed.forEach(r => console.warn("  FAIL: " + r.label + " - got " + JSON.stringify(r.actual) + ", expected " + JSON.stringify(r.expected)));
    if (logErrorFn) failed.forEach(r => logErrorFn("Smoke test failed: " + r.label, "got " + r.actual + ", expected " + r.expected));
  } else {
    console.log("Smoke tests: " + passed + "/" + results.length + " passed");
  }
}
