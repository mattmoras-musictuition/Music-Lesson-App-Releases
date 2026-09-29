// ============================================================
// TALLY BAND SMOKE TESTS
// Band Session Attribution cluster 4b. Fixture cases for how deriveTallyRows
// ticks band sessions, called from runSmokeTests with its `assert`.
//
// isDayPast6pm reads the real clock, so every "past" week sits in 2020 and
// every "future" week in 2099 — both are far enough from today that the 6pm
// threshold can never move under a test.
// ============================================================

import { deriveTallyRows, derivePrivateTallyRows, getOpenCatchupRows, getEnrolmentTermDeductionMath } from "../utils/tallyDerive";
import { buildBankingIndex, isCaughtUpCell, isScheduledCatchupCell } from "./catchupsDerive";

const PW = "2020-03-09";   // past week — a Tuesday band here is well past 6pm
const PW0 = "2020-03-02";  // the week before PW, for settled misses
const FW = "2099-03-09";   // future week — never past 6pm

const WEEKS = [
  { weekKey: PW0, label: "W1", weekNum: 1 },
  { weekKey: PW, label: "W2", weekNum: 2 },
  { weekKey: FW, label: "W3", weekNum: 3 },
];

function student(id, schoolId = "S") {
  return { id, name: id, schoolId, status: "active" };
}

function enrol(id, studentId, instrument, extra = {}) {
  return { id, studentId, instrument, startDate: "2020-01-01", ...extra };
}

// A master-timetable card, so every fixture row exists whether or not the
// week walk finds anything.
function mtt(e) {
  return { id: "M_" + e.id, enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day: "Thursday", start: "09:00" };
}

function band(id, extra = {}) {
  return { id, isBandSession: true, bandId: "BAND", bandName: "Band", schoolId: "S", day: "Tuesday", start: "11:00", end: "11:00", members: [], removedLessons: [], ...extra };
}

function missed(id, e, extra = {}) {
  return { id, enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day: "Thursday", start: "09:00", reason: "sick", makeupEligible: true, madeUp: false, ...extra };
}

// Run the deriver and return a compact per-row view: for each lessonKey, the
// week's cell state plus where the tick came from ("band", a card id, or "").
function derive({ students, enrolments, wtt, cards }) {
  const { tallyRows, entryMap } = deriveTallyRows({
    enrolments, students, termWeeks: WEEKS, weeklyTimetables: wtt,
    timetable: { lessons: cards || enrolments.map(mtt) }, schoolFilter: "all",
  });
  const view = {};
  for (const r of tallyRows) {
    view[r.lessonKey] = {};
    for (const w of WEEKS) {
      const c = r.cells[w.weekKey];
      const src = !c.wttEntry ? "" : (c.wttEntry.isBandSession ? "band" : c.wttEntry.id);
      view[r.lessonKey][w.weekKey] = c.state + (src ? ":" + src : "");
    }
  }
  return { view, entryMap };
}

function openRows(input, catchups) {
  return getOpenCatchupRows({
    weeklyTimetables: input.wtt, enrolments: input.enrolments, students: input.students,
    timetable: { lessons: input.cards || input.enrolments.map(mtt) }, termWeeks: WEEKS, catchups,
  }).map(r => r.missed.studentId + "@" + r.weekKey);
}

// ── Legacy bands (no memberStates) — pinned before the member-state matcher.
export function runLegacyBandTallyTests(assert) {
  const amy = student("amy"), bob = student("bob");
  const eAG = enrol("e_amy_gtr", "amy", "Guitar");
  const eAP = enrol("e_amy_pno", "amy", "Piano");
  const eBD = enrol("e_bob_drm", "bob", "Drums");

  // Ledger anchored by enrolmentId: the ledger card carries only the id.
  let input = {
    students: [amy, bob], enrolments: [eAG, eBD],
    wtt: { [PW + "|S"]: { lessons: [band("B", { members: [{ studentId: "amy", instrument: "Guitar" }, { studentId: "bob", instrument: "Drums" }], removedLessons: [{ id: "RL", enrolmentId: "e_amy_gtr" }] })], missed: [] } },
  };
  let d = derive(input);
  assert("legacy band: ledger match by enrolmentId ticks only that enrolment",
    [d.view["amy|Guitar"][PW], d.view["bob|Drums"][PW]], ["completed:band", "blank"]);

  // Ledger anchored by studentId + instrument (card predates enrolmentId stamping).
  input.wtt[PW + "|S"].lessons[0].removedLessons = [{ id: "RL", studentId: "amy", instrument: "Guitar" }];
  d = derive(input);
  assert("legacy band: ledger match by studentId + instrument",
    [d.view["amy|Guitar"][PW], d.view["bob|Drums"][PW]], ["completed:band", "blank"]);

  // Empty ledger → members[] fallback ticks every listed member.
  input.wtt[PW + "|S"].lessons[0].removedLessons = [];
  d = derive(input);
  assert("legacy band: empty ledger falls back to members[] and ticks every member",
    [d.view["amy|Guitar"][PW], d.view["bob|Drums"][PW]], ["completed:band", "completed:band"]);

  // Multi-instrument: ledger holds the guitar card while members[] says piano.
  input = {
    students: [amy], enrolments: [eAG, eAP],
    wtt: { [PW + "|S"]: { lessons: [
      band("B", { members: [{ studentId: "amy", instrument: "Piano" }], removedLessons: [{ id: "RL", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar" }] }),
      { id: "OWN_P", enrolmentId: "e_amy_pno", studentId: "amy", instrument: "Piano", schoolId: "S", day: "Thursday", start: "09:00" },
    ], missed: [] } },
  };
  d = derive(input);
  assert("legacy band: multi-instrument — ledger's guitar ticks from the band, piano from its own card",
    [d.view["amy|Guitar"][PW], d.view["amy|Piano"][PW]], ["completed:band", "completed:OWN_P"]);

  // Past vs future week, same band shape.
  const fb = { members: [{ studentId: "amy", instrument: "Guitar" }] };
  input = {
    students: [amy], enrolments: [eAG],
    wtt: { [PW + "|S"]: { lessons: [band("BP", fb)], missed: [] }, [FW + "|S"]: { lessons: [band("BF", fb)], missed: [] } },
  };
  d = derive(input);
  assert("legacy band: 2020 week completed, 2099 week blank",
    [d.view["amy|Guitar"][PW], d.view["amy|Guitar"][FW]], ["completed:band", "blank:band"]);

  // Shim carries bandSession and the band's own day.
  const shim = d.entryMap["amy|Guitar|" + PW];
  assert("legacy band: shim carries bandSession true and the band's day",
    [shim && shim.bandSession, shim && shim.day], [true, "Tuesday"]);

  // Own card plus band → the own card wins.
  input.wtt[PW + "|S"].lessons.push({ id: "OWN_G", enrolmentId: "e_amy_gtr", studentId: "amy", instrument: "Guitar", schoolId: "S", day: "Thursday", start: "09:00" });
  d = derive(input);
  assert("legacy band: own card beats the band — one tick, from the card",
    [d.view["amy|Guitar"][PW], d.entryMap["amy|Guitar|" + PW].bandSession], ["completed:OWN_G", false]);

  // Legacy band plus a same-week miss → the band wins and the miss is hidden.
  input = {
    students: [amy], enrolments: [eAG],
    wtt: { [PW + "|S"]: { lessons: [band("B", fb)], missed: [missed("MS", eAG)] } },
  };
  d = derive(input);
  assert("legacy band: band beats a same-week miss",
    d.view["amy|Guitar"][PW], "completed:band");
  assert("legacy band: that miss is absent from getOpenCatchupRows",
    openRows(input, []), []);

  // Group enrolments are never band-matched, even with a ledger naming them.
  const gina = student("gina");
  const eGrp = enrol("e_grp", "gina", "Guitar", { isGroup: true, groupId: "g1" });
  input = {
    students: [gina], enrolments: [eGrp],
    cards: [{ id: "M_GRP", enrolmentId: "e_grp", isGroup: true, groupId: "g1", schoolId: "S", day: "Thursday" }],
    wtt: { [PW + "|S"]: { lessons: [band("B", { members: [{ studentId: "gina", instrument: "Guitar" }], removedLessons: [{ id: "RL", enrolmentId: "e_grp" }] })], missed: [] } },
  };
  d = derive(input);
  assert("legacy band: group enrolment never band-matched",
    d.view["group|g1"][PW], "blank");

  // derivePrivateTallyRows has no band path.
  const pia = student("pia", "__private__");
  const eP = enrol("e_pia", "pia", "Voice");
  const priv = derivePrivateTallyRows({
    enrolments: [eP], students: [pia], termWeeks: WEEKS,
    weeklyTimetables: { [PW + "|__private__"]: { lessons: [band("B", { schoolId: "__private__", members: [{ studentId: "pia", instrument: "Voice" }], removedLessons: [{ id: "RL", enrolmentId: "e_pia" }] })], missed: [] } },
  });
  assert("derivePrivateTallyRows ignores band sessions",
    priv.tallyRows[0] && priv.tallyRows[0].cells[PW].state, "blank");

  // A picker-created catch-up and a band-linked one are the same catch-up
  // everywhere that counts. The rows differ ONLY in bandLessonId.
  const picker = (weekKey) => ({
    id: "CU", weekKey, day: "Tuesday", time: "11:00", instrument: "Guitar", schoolId: "S",
    enrolmentId: "e_amy_gtr", resolvesEnrolmentId: "e_amy_gtr", resolvesWeekKey: PW0,
    resolvesOriginalDay: "Thursday", resolvesOriginalTime: "09:00", madeUp: false, createdAt: "2020-03-01",
  });
  const linked = (weekKey) => ({ ...picker(weekKey), bandLessonId: "B" });
  input = {
    students: [amy], enrolments: [eAG],
    wtt: { [PW0 + "|S"]: { lessons: [], missed: [missed("MS", eAG)] } },
  };
  const cell = { status: "missed", makeupEligible: true, madeUp: false, enrolmentId: "e_amy_gtr", weekKey: PW0 };
  const math = (rows) => getEnrolmentTermDeductionMath({
    weeklyTimetables: input.wtt, catchups: rows, enrolmentId: "e_amy_gtr", instrument: "Guitar",
    prevTerm: { start: PW0, end: FW }, interruptions: [], nextTermStart: "2100-01-01",
  });
  const probe = (row) => {
    const idx = buildBankingIndex([row]);
    return [isCaughtUpCell(cell, idx), isScheduledCatchupCell(cell, idx), openRows(input, [row]), math([row])];
  };
  assert("catch-up parity: picker and band-linked rows agree (slot passed)",
    probe(linked(PW)), probe(picker(PW)));
  assert("catch-up parity: picker and band-linked rows agree (slot ahead)",
    probe(linked(FW)), probe(picker(FW)));
  assert("catch-up parity: slot passed reads caught up, not scheduled, not open",
    probe(linked(PW)).slice(0, 3), [true, false, []]);
}
