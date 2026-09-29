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

// ── New bands (memberStates present) — the cluster 4b member-state matcher.
function ms(e, consumption, extra = {}) {
  return { enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, consumption, catchupId: null, consumedWeekKey: null, fee: null, attended: null, writerTeacherId: null, ...extra };
}

function own(id, e) {
  return { id, enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day: "Thursday", start: "09:00" };
}

export function runMemberStateTallyTests(assert) {
  const amy = student("amy"), bob = student("bob");
  const eAG = enrol("e_amy_gtr", "amy", "Guitar");
  const eAP = enrol("e_amy_pno", "amy", "Piano");
  const eBD = enrol("e_bob_drm", "bob", "Drums");
  const amyGtr = [{ studentId: "amy", instrument: "Guitar" }];

  // Regular ticks the band's own week, subject to the 6pm threshold.
  let input = {
    students: [amy], enrolments: [eAG],
    wtt: {
      [PW + "|S"]: { lessons: [band("BP", { members: amyGtr, memberStates: [ms(eAG, "regular", { consumedWeekKey: PW })] })], missed: [] },
      [FW + "|S"]: { lessons: [band("BF", { members: amyGtr, memberStates: [ms(eAG, "regular", { consumedWeekKey: FW })] })], missed: [] },
    },
  };
  let d = derive(input);
  assert("new band: regular ticks 2020 band week, 2099 blank",
    [d.view["amy|Guitar"][PW], d.view["amy|Guitar"][FW]], ["completed:band", "blank:band"]);
  assert("new band: regular shim carries bandSession true",
    d.entryMap["amy|Guitar|" + PW].bandSession, true);

  // Own card plus regular → one tick, from the card.
  input.wtt[PW + "|S"].lessons.push(own("OWN_G", eAG));
  d = derive(input);
  assert("new band: own card beats a regular attribution — one tick, from the card",
    [d.view["amy|Guitar"][PW], d.entryMap["amy|Guitar|" + PW].bandSession], ["completed:OWN_G", false]);

  // Catch-up: the band ticks nothing; the miss week is settled by the overlay.
  const catchupRow = (weekKey) => ({
    id: "CU", weekKey, day: "Tuesday", time: "11:00", instrument: "Guitar", schoolId: "S",
    enrolmentId: "e_amy_gtr", resolvesEnrolmentId: "e_amy_gtr", resolvesWeekKey: PW0,
    resolvesOriginalDay: "Thursday", resolvesOriginalTime: "09:00", madeUp: false, createdAt: "2020-03-01", bandLessonId: "BC",
  });
  const catchupBand = band("BC", { members: amyGtr, memberStates: [ms(eAG, "catchup", { catchupId: "CU", consumedWeekKey: PW0 })] });
  input = {
    students: [amy], enrolments: [eAG],
    wtt: { [PW0 + "|S"]: { lessons: [], missed: [missed("MS", eAG)] }, [PW + "|S"]: { lessons: [catchupBand], missed: [] } },
  };
  d = derive(input);
  const idxPast = buildBankingIndex([catchupRow(PW)]);
  const w1 = d.entryMap["amy|Guitar|" + PW0];
  assert("new band catchup: no band tick — W1 stays a miss, W2 blank",
    [d.view["amy|Guitar"][PW0], d.view["amy|Guitar"][PW]], ["missed-makeup-owed:MS", "blank"]);
  assert("new band catchup: W1 caught up once the band day has passed",
    [isCaughtUpCell(w1, idxPast), isScheduledCatchupCell(w1, idxPast), openRows(input, [catchupRow(PW)])], [true, false, []]);
  const idxAhead = buildBankingIndex([catchupRow(FW)]);
  assert("new band catchup: W1 scheduled while the band day is ahead",
    [isCaughtUpCell(w1, idxAhead), isScheduledCatchupCell(w1, idxAhead)], [false, true]);
  input.wtt[PW + "|S"].lessons.push(own("OWN_G", eAG));
  d = derive(input);
  assert("new band catchup: W2 comes from the own card when present",
    d.view["amy|Guitar"][PW], "completed:OWN_G");

  // free, not_in_session, null, forward, billed → nothing from the band.
  const noTick = ["free", "not_in_session", null, "forward", "billed"];
  let threw = false;
  let states = [];
  try {
    states = noTick.map((c) => derive({
      students: [amy], enrolments: [eAG],
      wtt: { [PW + "|S"]: { lessons: [band("B", { members: amyGtr, memberStates: [ms(eAG, c)] })], missed: [] } },
    }).view["amy|Guitar"][PW]);
  } catch (err) { threw = true; }
  assert("new band: free / not_in_session / null / forward / billed tick nothing and do not throw",
    [threw, states], [false, ["blank", "blank", "blank", "blank", "blank"]]);
  states = ["free", "not_in_session", null].map((c) => derive({
    students: [amy], enrolments: [eAG],
    wtt: { [PW + "|S"]: { lessons: [band("B", { members: amyGtr, memberStates: [ms(eAG, c)] }), own("OWN_G", eAG)], missed: [] } },
  }).view["amy|Guitar"][PW]);
  assert("new band: free / not_in_session / null — own card still ticks",
    states, ["completed:OWN_G", "completed:OWN_G", "completed:OWN_G"]);

  // Empty memberStates never falls through to members[] or the ledger.
  const emptyStates = (removedLessons) => derive({
    students: [amy, bob], enrolments: [eAG, eBD],
    wtt: { [PW + "|S"]: { lessons: [band("B", { members: [...amyGtr, { studentId: "bob", instrument: "Drums" }], memberStates: [], removedLessons })], missed: [] } },
  }).view;
  let v = emptyStates([]);
  assert("new band: empty memberStates with members[] and empty ledger ticks nothing",
    [v["amy|Guitar"][PW], v["bob|Drums"][PW]], ["blank", "blank"]);
  v = emptyStates([{ id: "RL", enrolmentId: "e_amy_gtr" }]);
  assert("new band: empty memberStates ignores a populated ledger too",
    v["amy|Guitar"][PW], "blank");

  // Multi-instrument: piano regular, guitar card present (and in the ledger
  // the legacy matcher would have read).
  d = derive({
    students: [amy], enrolments: [eAG, eAP],
    wtt: { [PW + "|S"]: { lessons: [
      band("B", { members: [{ studentId: "amy", instrument: "Piano" }], memberStates: [ms(eAG, null), ms(eAP, "regular", { consumedWeekKey: PW })], removedLessons: [{ id: "RL", enrolmentId: "e_amy_gtr" }] }),
      own("OWN_G", eAG),
    ], missed: [] } },
  });
  assert("new band: multi-instrument — piano ticks from the band, guitar from its own card",
    [d.view["amy|Piano"][PW], d.view["amy|Guitar"][PW]], ["completed:band", "completed:OWN_G"]);

  // Amendment B: a same-week miss beats a new band's regular tick.
  input = {
    students: [amy], enrolments: [eAG],
    wtt: { [PW + "|S"]: { lessons: [band("B", { members: amyGtr, memberStates: [ms(eAG, "regular", { consumedWeekKey: PW })] })], missed: [missed("MS", eAG)] } },
  };
  d = derive(input);
  assert("new band: regular plus same-week miss shows missed",
    d.view["amy|Guitar"][PW], "missed-makeup-owed:MS");
  assert("new band: that miss appears in getOpenCatchupRows",
    openRows(input, []), ["amy@" + PW]);

  // attended: false → no tick.
  d = derive({
    students: [amy], enrolments: [eAG],
    wtt: { [PW + "|S"]: { lessons: [band("B", { members: amyGtr, memberStates: [ms(eAG, "regular", { attended: false })] })], missed: [] } },
  });
  assert("new band: regular with attended false ticks nothing",
    d.view["amy|Guitar"][PW], "blank");

  // Duplicate enrolments: the entry names a different row for the same
  // student + instrument → falls back to studentId + instrument. A different
  // instrument never matches.
  d = derive({
    students: [amy], enrolments: [eAG, eAP],
    wtt: { [PW + "|S"]: { lessons: [band("B", { members: amyGtr, memberStates: [{ ...ms(eAG, "regular"), enrolmentId: "e_amy_gtr_other" }] })], missed: [] } },
  });
  assert("new band: duplicate-enrolment fallback to studentId + instrument",
    [d.view["amy|Guitar"][PW], d.view["amy|Piano"][PW]], ["completed:band", "blank"]);

  // A legacy band and a new band in the same week, each on its own matcher.
  // The new band lists dave in members[] but attributes him free, so only the
  // legacy fallback could tick him — and dave is not in the legacy band.
  const dave = student("dave");
  const eDV = enrol("e_dave_vox", "dave", "Voice");
  d = derive({
    students: [amy, bob, dave], enrolments: [eAG, eBD, eDV],
    wtt: { [PW + "|S"]: { lessons: [
      band("BN", { members: [...amyGtr, { studentId: "bob", instrument: "Drums" }, { studentId: "dave", instrument: "Voice" }], memberStates: [ms(eAG, "regular"), ms(eDV, "free")] }),
      band("BL", { members: [{ studentId: "bob", instrument: "Drums" }] }),
    ], missed: [] } },
  });
  assert("new + legacy band in one week: each uses its own matcher",
    [d.view["amy|Guitar"][PW], d.view["bob|Drums"][PW], d.view["dave|Voice"][PW]], ["completed:band", "completed:band", "blank"]);

  // The 4a Q4 scenario: six members, empty ledger, no own cards.
  const ids = ["cat", "fre", "nis", "nul", "reg", "abs"];
  const six = ids.map((id) => student(id));
  const sixE = ids.map((id) => enrol("e_" + id, id, "Guitar"));
  const byId = Object.fromEntries(sixE.map((e) => [e.studentId, e]));
  const q4Band = band("BQ", {
    members: ids.map((id) => ({ studentId: id, instrument: "Guitar" })),
    memberStates: [
      ms(byId.cat, "catchup", { catchupId: "CQ", consumedWeekKey: PW0 }),
      ms(byId.fre, "free"), ms(byId.nis, "not_in_session"), ms(byId.nul, null),
      ms(byId.reg, "regular", { consumedWeekKey: PW }), ms(byId.abs, "regular", { consumedWeekKey: PW }),
    ],
  });
  const q4Row = { ...catchupRow(PW), id: "CQ", enrolmentId: "e_cat", resolvesEnrolmentId: "e_cat", bandLessonId: "BQ" };
  input = {
    students: six, enrolments: sixE,
    wtt: {
      [PW0 + "|S"]: { lessons: [], missed: [missed("MC", byId.cat)] },
      [PW + "|S"]: { lessons: [q4Band], missed: [missed("MA", byId.abs, { day: "Tuesday" })] },
    },
  };
  d = derive(input);
  assert("4a Q4 scenario: only the plain regular member ticks the band week",
    ids.map((id) => d.view[id + "|Guitar"][PW]),
    ["blank", "blank", "blank", "blank", "completed:band", "missed-makeup-owed:MA"]);
  assert("4a Q4 scenario: catch-up member's W1 caught up, W2 blank; open rows hold only the absent regular",
    [isCaughtUpCell(d.entryMap["cat|Guitar|" + PW0], buildBankingIndex([q4Row])), d.view["cat|Guitar"][PW], openRows(input, [q4Row])],
    [true, "blank", ["abs@" + PW]]);
}
