// ============================================================
// SMOKE TESTS
// Runs once at startup in development to catch regressions
// in core logic functions.
// ============================================================

import { timeToMin, getSchoolAcronym } from "../utils/helpers";
import { migrateData } from "../utils/backup";
import { makeEnrolmentResolver } from "../utils/enrolmentActivity";
import {
  buildMemberStates, applyStudentAttribution, defaultAttributions,
  reconcileMemberStates, findMemberCards, isExcludedByBands, studentRows,
  selectableMissesForStudent, planAttributionSave,
} from "./bandMemberStates";
import { isHiddenBehindBandCard, mergeCatchupsIntoLessons } from "./catchupsDerive";

export function runSmokeTests(logErrorFn) {
  const results = [];
  const assert = (label, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ label, pass, actual, expected });
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

  // ── Band Session Attribution (cluster 3a) ──────────────────────
  // Fixture enrolments. Amy holds guitar (started first, ENDED before the
  // band's week) plus a live guitar row starting mid-term, and piano.
  const bandWeek = "2026-05-11";
  const enr = [
    { id: "e_amy_gtr_old", studentId: "amy", instrument: "Guitar", startDate: "2026-01-01", endDate: "2026-12-31" },
    { id: "e_amy_gtr_new", studentId: "amy", instrument: "Guitar", startDate: "2026-09-01" },
    { id: "e_amy_pno",     studentId: "amy", instrument: "Piano",  startDate: "2026-02-01" },
    { id: "e_bob_drm",     studentId: "bob", instrument: "Drums",  startDate: "2026-03-01" },
  ];
  const members = [{ studentId: "amy", instrument: "Guitar" }, { studentId: "bob", instrument: "Drums" }];

  // Pick-order fix: the newer guitar row starts AFTER the band's week, so
  // filtering to active rows first must keep the older one. Picking first
  // would have chosen e_amy_gtr_new (latest startDate) and then dropped it.
  const built = buildMemberStates(members, enr, bandWeek);
  assert("memberStates picks week-active guitar row", built.map(e => e.enrolmentId),
    ["e_amy_gtr_old", "e_amy_pno", "e_bob_drm"]);
  assert("memberStates all unattributed", built.every(e => e.consumption === null), true);

  // One consumption per student: attributing piano clears guitar.
  const guitarFirst = applyStudentAttribution(built, "amy", "e_amy_gtr_old", "regular", null);
  const pianoNext = applyStudentAttribution(guitarFirst, "amy", "e_amy_pno", "free", null);
  assert("one consumption per student", pianoNext.filter(e => e.studentId === "amy" && e.consumption != null).map(e => e.enrolmentId),
    ["e_amy_pno"]);
  assert("other students untouched by attribution", pianoNext.find(e => e.studentId === "bob").consumption, null);
  assert("attribution clears whole student on null", 
    applyStudentAttribution(pianoNext, "amy", "e_amy_pno", null, null).filter(e => e.studentId === "amy" && e.consumption != null).length, 0);

  // Defaults: an open miss on the SECOND instrument beats first-enrolled.
  const misses = [
    { enrolmentId: "e_amy_pno", weekKey: "2026-04-20", day: "Wednesday", start: "10:00" },
    { enrolmentId: "e_amy_pno", weekKey: "2026-04-13", day: "Friday",   start: "09:00" },
    { enrolmentId: "e_amy_pno", weekKey: "2026-04-13", day: "Tuesday",  start: "14:00" },
  ];
  const withMiss = defaultAttributions(built, { openMisses: misses, enrolments: enr });
  assert("default catchup targets oldest miss (week, then day)",
    withMiss.filter(d => d.studentId === "amy").map(d => [d.consumption, d.enrolmentId, d.settlesMiss.day]),
    [["catchup", "e_amy_pno", "Tuesday"]]);
  // Bob has no miss → regular on his only (earliest) enrolment.
  assert("default regular when no miss",
    withMiss.filter(d => d.studentId === "bob").map(d => [d.consumption, d.enrolmentId]),
    [["regular", "e_bob_drm"]]);
  // No misses at all → earliest startDate wins (guitar 2026-01-01 over piano 2026-02-01).
  assert("default regular picks earliest startDate",
    defaultAttributions(built, { openMisses: [], enrolments: enr }).filter(d => d.studentId === "amy").map(d => d.enrolmentId),
    ["e_amy_gtr_old"]);
  // An already-attributed student gets no default.
  assert("no default for attributed student",
    defaultAttributions(guitarFirst, { openMisses: misses, enrolments: enr }).map(d => d.studentId), ["bob"]);

  // Reconciliation: add / drop-unattributed / keep-departed-attributed.
  const stored = [
    { enrolmentId: "e_amy_gtr_old", studentId: "amy", instrument: "Guitar", consumption: "regular", catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
    { enrolmentId: "e_amy_pno",     studentId: "amy", instrument: "Piano",  consumption: null,      catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
  ];
  const fresh = [
    { enrolmentId: "e_amy_pno", studentId: "amy", instrument: "Piano", consumption: null, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
    { enrolmentId: "e_bob_drm", studentId: "bob", instrument: "Drums", consumption: null, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
  ];
  const rec = reconcileMemberStates(stored, fresh);
  assert("reconcile keeps departed attributed, drops departed unattributed, appends new",
    rec.memberStates.map(e => e.enrolmentId), ["e_amy_gtr_old", "e_amy_pno", "e_bob_drm"]);
  assert("reconcile reports departed", rec.departedEnrolmentIds, ["e_amy_gtr_old"]);
  assert("departed surfaces on the student row",
    studentRows(rec.memberStates, rec.departedEnrolmentIds).find(r => r.studentId === "amy").departed, true);

  // findMemberCards: stamped enrolmentId, and the studentId+instrument fallback.
  const resolver = makeEnrolmentResolver(enr);
  const pianoEntry = built.find(e => e.enrolmentId === "e_amy_pno");
  const weekCards = [
    { id: "L1", enrolmentId: "e_amy_pno", studentId: "amy", instrument: "Piano", day: "Monday" },
    { id: "L2", studentId: "amy", instrument: "Piano", day: "Tuesday" },          // unstamped → fallback
    { id: "L3", studentId: "amy", instrument: "Guitar", day: "Monday" },
    { id: "L4", isBandSession: true, members: [{ studentId: "amy" }] },
    { id: "L5", __isCatchup: true, enrolmentId: "e_amy_pno", studentId: "amy" },
    { id: "L6", isGroup: true, studentIds: ["amy"], enrolmentId: "e_amy_pno" },
  ];
  assert("findMemberCards matches stamped + unstamped, skips band/catchup/group",
    findMemberCards(weekCards, pianoEntry, resolver).map(l => l.id), ["L1", "L2"]);

  // isExcludedByBands: legacy excludes the whole student; a new band excludes
  // only the "regular"-attributed enrolment.
  const legacyBand = { isBandSession: true, members: [{ studentId: "amy" }] };
  const newBand = { isBandSession: true, members: [{ studentId: "amy" }], memberStates: guitarFirst };
  const amyPiano = { id: "M1", enrolmentId: "e_amy_pno", studentId: "amy", instrument: "Piano" };
  const amyGuitar = { id: "M2", enrolmentId: "e_amy_gtr_old", studentId: "amy", instrument: "Guitar" };
  assert("legacy band excludes every card of the student",
    [isExcludedByBands(amyPiano, [legacyBand], resolver), isExcludedByBands(amyGuitar, [legacyBand], resolver)], [true, true]);
  assert("new band excludes only the regular-attributed enrolment",
    [isExcludedByBands(amyPiano, [newBand], resolver), isExcludedByBands(amyGuitar, [newBand], resolver)], [false, true]);
  assert("new band with no attribution excludes nothing",
    isExcludedByBands(amyGuitar, [{ isBandSession: true, members: [{ studentId: "amy" }], memberStates: built }], resolver), false);

  // ── Band attribution: hide test + save plan (cluster 3b) ───────
  // The hide test needs BOTH directions of the link: the band present, and
  // that band still claiming the row.
  const cu = { id: "cu1", bandLessonId: "BL1", weekKey: bandWeek, time: "10:00", day: "Monday" };
  const claiming = { id: "BL1", isBandSession: true, memberStates: [{ enrolmentId: "e_amy_pno", studentId: "amy", catchupId: "cu1", consumption: "catchup" }] };
  const notClaiming = { id: "BL1", isBandSession: true, memberStates: [{ enrolmentId: "e_amy_pno", studentId: "amy", catchupId: null, consumption: null }] };
  assert("hidden when band present AND claims the row", isHiddenBehindBandCard(cu, [claiming]), true);
  assert("visible when band present but claims nothing", isHiddenBehindBandCard(cu, [notClaiming]), false);
  assert("visible when band absent", isHiddenBehindBandCard(cu, []), false);
  assert("visible when band is legacy (no memberStates)",
    isHiddenBehindBandCard(cu, [{ id: "BL1", isBandSession: true }]), false);
  assert("merge hides a claimed catchup, keeps an orphan",
    mergeCatchupsIntoLessons([], [cu, { id: "cu2", bandLessonId: "GONE", weekKey: bandWeek }], bandWeek, [claiming]).map(l => l.id),
    ["cu2"]);

  // selectableMissesForStudent restores the miss the existing row settles.
  const linkedRow = { id: "cu1", bandLessonId: "BL1", resolvesEnrolmentId: "e_amy_pno", resolvesWeekKey: "2026-03-02", resolvesOriginalDay: "Monday", resolvesOriginalTime: "11:00" };
  const amyEntries = built.filter(e => e.studentId === "amy").map(e =>
    e.enrolmentId === "e_amy_pno" ? { ...e, consumption: "catchup", catchupId: "cu1" } : e);
  assert("selectable misses include the already-settled one",
    selectableMissesForStudent(amyEntries, [], [linkedRow]).map(m => [m.enrolmentId, m.weekKey]),
    [["e_amy_pno", "2026-03-02"]]);

  // planAttributionSave — one case per transition.
  const base = (consumption, catchupId) => [
    { enrolmentId: "e_amy_pno", studentId: "amy", instrument: "Piano", consumption, catchupId: catchupId || null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null },
  ];
  const missA = { enrolmentId: "e_amy_pno", weekKey: "2026-03-02", day: "Monday", start: "11:00" };
  const missB = { enrolmentId: "e_amy_pno", weekKey: "2026-03-09", day: "Tuesday", start: "09:00" };
  const rowA = { id: "cu1", resolvesEnrolmentId: "e_amy_pno", resolvesWeekKey: "2026-03-02", resolvesOriginalDay: "Monday", resolvesOriginalTime: "11:00" };
  const planOf = (stored, working, missBy, rows) => planAttributionSave({
    stored, working, missByEnrolment: missBy || {}, catchupsForBand: rows || [], weekKey: bandWeek });

  let pl = planOf(base(null), base("regular"));
  assert("unattributed → regular", [pl.inserts.length, pl.deletes.length, pl.regularOn.length, pl.memberStates[0].consumedWeekKey],
    [0, 0, 1, bandWeek]);

  pl = planOf(base(null), base("catchup"), { e_amy_pno: missA });
  assert("unattributed → catchup inserts one row",
    [pl.inserts.length, pl.deletes.length, pl.memberStates[0].consumedWeekKey], [1, 0, "2026-03-02"]);

  pl = planOf(base("catchup", "cu1"), base("catchup", "cu1"), { e_amy_pno: missA }, [rowA]);
  assert("catchup → same miss is a no-op", [pl.inserts.length, pl.deletes.length, pl.changed], [0, 0, false]);

  pl = planOf(base("catchup", "cu1"), base("catchup", "cu1"), { e_amy_pno: missB }, [rowA]);
  assert("catchup → different miss replaces the row",
    [pl.inserts.length, pl.deletes.map(d => d.id)], [1, ["cu1"]]);

  pl = planOf(base("catchup", "cu1"), base("free"), {}, [rowA]);
  assert("catchup → free deletes the row",
    [pl.inserts.length, pl.deletes.map(d => d.id), pl.memberStates[0].catchupId, pl.memberStates[0].consumedWeekKey],
    [0, ["cu1"], null, null]);

  pl = planOf(base("regular"), base("catchup"), { e_amy_pno: missA });
  assert("regular → catchup inserts and releases the card",
    [pl.inserts.length, pl.regularOff.length, pl.regularOn.length], [1, 1, 0]);

  pl = planOf(base("catchup", "cu1"), base(null), {}, [rowA]);
  assert("departed catchup cleared deletes the row",
    [pl.deletes.map(d => d.id), pl.memberStates[0].consumption], [["cu1"], null]);

  assert("no-op save reports unchanged", planOf(base(null), base(null)).changed, false);

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
