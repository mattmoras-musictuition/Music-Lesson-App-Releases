// ============================================================
// CATCH-UP SCOPE SMOKE TESTS
// v2.39.0 — the locked "offerable misses for a target week" rule
// (utils/catchupScope.js), called from runSmokeTests with its `assert`.
//
// Every date sits in 2099 (or late 2098 for "before the first term") so the
// real clock can never move a case. Calendar:
//   T1 2099-01-01 → 04-03 · break 04-04 → 04-19
//   T2 2099-04-20 → 06-26 · break 06-27 → 07-12
//   T3 2099-07-13 → 09-18 · break 09-19 → 10-04 (holiday Mondays 09-21, 09-28)
//   T4 2099-10-05 → est.  (after the last break, so labelled "(est.)")
// ============================================================

import { getOfferableMisses, groupOfferableByEnrolment, parseInvoiceDrafts, normalizeTermLabel, resolveAnchorTerm } from "../utils/catchupScope";
import { deriveTallyRows, getOpenCatchupRows } from "../utils/tallyDerive";
import { selectableMissesForStudent } from "./bandMemberStates";

const INTERRUPTIONS = [
  { id: "b1", type: "term_break", date: "2099-04-04", endDate: "2099-04-19" },
  { id: "b2", type: "term_break", date: "2099-06-27", endDate: "2099-07-12" },
  { id: "b3", type: "term_break", date: "2099-09-19", endDate: "2099-10-04" },
];

const HOL = "2099-09-21";     // first holiday week after T3
const T4W1 = "2099-10-05";    // term 4 week 1
const T3W5 = "2099-08-10";    // term 3 week 5
const T2WK = "2099-05-04";    // a term 2 week
const T3W2 = "2099-07-20", T3W3 = "2099-07-27", T3W4 = "2099-08-03";

const student = (id, name) => ({ id, name, schoolId: "S", status: "active" });
const enrol = (id, studentId, instrument, extra = {}) => ({ id, studentId, instrument, startDate: "2099-01-01", ...extra });
const card = (e) => ({ id: "M_" + e.id, enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day: "Thursday", start: "09:00", ...(e.isGroup ? { isGroup: true, groupId: e.groupId } : {}) });
const miss = (id, e, extra = {}) => ({ id, enrolmentId: e.id, studentId: e.studentId, instrument: e.instrument, schoolId: "S", day: "Thursday", start: "09:00", reason: "sick", makeupEligible: true, madeUp: false, ...extra });

function fixture() {
  const students = [student("amy", "Amy"), student("bob", "Bob"), student("cal", "Cal"), student("dee", "Dee")];
  const eA = enrol("e_amy", "amy", "Piano");
  const eB = enrol("e_bob", "bob", "Guitar");
  const eC = enrol("e_cal", "cal", "Drums");
  const eD = enrol("e_dee", "dee", "Violin");
  const enrolments = [eA, eB, eC, eD];
  const weeklyTimetables = {
    [`${T2WK}|S`]: { lessons: [], missed: [miss("m_amy_t2", eA)] },
    [`${T3W2}|S`]: { lessons: [], missed: [miss("m_amy_t3", eA), miss("m_dee_t3", eD)] },
    [`${T3W3}|S`]: { lessons: [], missed: [miss("m_bob_t3", eB)] },
    [`${T3W4}|S`]: { lessons: [], missed: [miss("m_cal_t3", eC)] },
  };
  // Dee's term 3 miss is already settled by a holiday-week catch-up.
  const catchups = [{
    id: "cu_dee", enrolmentId: "e_dee", instrument: "Violin", schoolId: "S",
    weekKey: HOL, day: "Tuesday", time: "10:00",
    resolvesEnrolmentId: "e_dee", resolvesWeekKey: T3W2, resolvesOriginalDay: "Thursday", resolvesOriginalTime: "09:00",
  }];
  return { students, enrolments, weeklyTimetables, catchups, timetable: { lessons: enrolments.map(card) } };
}

const run = (fx, targetWeekKey, invoices = [], extra = {}) =>
  getOfferableMisses({ targetWeekKey, interruptions: INTERRUPTIONS, invoices, ...fx, ...extra });
const keys = (res) => res.entries.map(e => `${e.studentId}@${e.weekKey}`).sort();
const inv = (status, termLabel, lines) => ({ id: "i_" + termLabel + status, status, termLabel, lines });

export function runCatchupScopeTests(assert) {
  const fx = fixture();
  const base = [`amy@${T3W2}`, `bob@${T3W3}`, `cal@${T3W4}`];

  // Anchor + next term come from Invoicing's own detection.
  const hol = run(fx, HOL);
  assert("scope: holiday week anchors on the term before the break", hol.anchorTerm, { start: "2099-07-13", end: "2099-09-18" });
  assert("scope: next term label is Invoicing's", hol.nextTerm && hol.nextTerm.label, "Term 4 2099 (est.)");

  // a / c / d — holiday week after T3, nothing sent.
  assert("scope a/c/d: holiday target offers T3 misses only, minus settled ones", keys(hol), base);
  assert("scope a: entries keep start/time/enrolmentId for the pickers",
    hol.entries.find(e => e.studentId === "amy") && [hol.entries.find(e => e.studentId === "amy").start, hol.entries.find(e => e.studentId === "amy").enrolmentId],
    ["09:00", "e_amy"]);

  // b — term 4 week 1 anchors on T4, which has no misses.
  assert("scope b: term 4 week 1 does not offer term 3 misses", keys(run(fx, T4W1)), []);

  // e — draft vs sent.
  const amyLine = [{ studentId: "amy", studentName: "Amy" }];
  assert("scope e: a draft T4 invoice changes nothing", keys(run(fx, HOL, [inv("draft", "Term 4 2099", amyLine)])), base);
  const sentAmy = [inv("sent", "Term 4 2099", amyLine)];
  // f — Bob (sibling, not on the invoice's lines) is still offered.
  assert("scope e/f: a sent T4 invoice drops only its own student", keys(run(fx, HOL, sentAmy)), [`bob@${T3W3}`, `cal@${T3W4}`]);

  // g — legacy name-only line matches by name; an id'd line never falls back.
  assert("scope g: legacy name-only line matches by name",
    keys(run(fx, HOL, [inv("sent", "Term 4 2099", [{ studentName: "Cal" }])])), [`amy@${T3W2}`, `bob@${T3W3}`]);
  assert("scope g: a line with a studentId never falls back to the name",
    keys(run(fx, HOL, [inv("sent", "Term 4 2099", [{ studentId: "someone_else", studentName: "Bob" }])])), base);

  // h — "(est.)" is ignored on both sides.
  assert("scope h: est. suffix normalises", normalizeTermLabel("Term 4 2099 (est.)"), "Term 4 2099");
  assert("scope h: est. invoice label matches too",
    keys(run(fx, HOL, [inv("sent", "Term 4 2099 (est.)", amyLine)])), [`bob@${T3W3}`, `cal@${T3W4}`]);

  // i — a sent invoice for another term is ignored.
  assert("scope i: a sent invoice for another term is ignored", keys(run(fx, HOL, [inv("sent", "Term 3 2099", amyLine)])), base);

  // j — in-term target: T3's own misses, never T2's; the cutoff still applies.
  assert("scope j: T3 week 5 offers T3 weeks 2-4, not T2", keys(run(fx, T3W5)), base);
  assert("scope j: the sent cutoff applies in term weeks too", keys(run(fx, T3W5, sentAmy)), [`bob@${T3W3}`, `cal@${T3W4}`]);

  // k — before the first known term.
  const early = run(fx, "2098-12-07");
  assert("scope k: before the first term → nothing", [early.anchorTerm, early.entries.length], [null, 0]);
  assert("scope k: no term breaks → no anchor", resolveAnchorTerm([], HOL), null);

  // l — malformed storage reads as no invoices.
  assert("scope l: parse tolerates junk",
    [parseInvoiceDrafts(null), parseInvoiceDrafts(""), parseInvoiceDrafts("{bad"), parseInvoiceDrafts("{}"), parseInvoiceDrafts('[1,null,{"id":"x"}]')],
    [[], [], [], [], [{ id: "x" }]]);
  assert("scope l: junk storage → everything still offered", keys(run(fx, HOL, parseInvoiceDrafts("{bad"))), base);

  // Group miss drops only once every member is invoiced.
  const eGA = enrol("g_amy", "amy", "Ukulele", { isGroup: true, groupId: "g1" });
  const gfx = {
    ...fx,
    enrolments: [...fx.enrolments, eGA],
    timetable: { lessons: [...fx.timetable.lessons, card(eGA)] },
    weeklyTimetables: {
      ...fx.weeklyTimetables,
      [`${T3W4}|S`]: { lessons: [], missed: [...fx.weeklyTimetables[`${T3W4}|S`].missed,
        { id: "m_g1", isGroup: true, groupId: "g1", groupName: "Ukes", instrument: "Ukulele", schoolId: "S", day: "Thursday", start: "09:00", makeupEligible: true, madeUp: false }] },
    },
  };
  const groups = [{ id: "g1", studentIds: ["amy", "bob"] }];
  const hasGroup = (res) => res.entries.some(e => e.groupId === "g1");
  assert("scope group: offered while a member is uninvoiced", hasGroup(run(gfx, HOL, sentAmy, { groups })), true);
  assert("scope group: dropped once every member is invoiced",
    hasGroup(run(gfx, HOL, [inv("sent", "Term 4 2099", [{ studentId: "amy" }, { studentId: "bob" }])], { groups })), false);

  // Picker grouping keeps the memo's shape.
  const grouped = groupOfferableByEnrolment(hol.entries, fx);
  assert("scope: grouped per enrolment, sorted by name",
    grouped.map(g => [g.studentName, g.owedCount, g.missedEntries[0].weekKey]),
    [["Amy", 1, T3W2], ["Bob", 1, T3W3], ["Cal", 1, T3W4]]);

  // Band window — a miss a band's linked row already settles stays selectable
  // for that band even after the invoice is sent and the rule stops offering it.
  const linked = [{ id: "cu_band", bandLessonId: "BL", resolvesEnrolmentId: "e_amy", resolvesWeekKey: T3W2, resolvesOriginalDay: "Thursday", resolvesOriginalTime: "09:00" }];
  const afterSent = run(fx, HOL, sentAmy).entries;
  const sel = selectableMissesForStudent([{ studentId: "amy", instrument: "Piano", enrolmentId: "e_amy", catchupId: "cu_band" }], afterSent, linked);
  assert("scope band: linked miss stays selectable after the cutoff", sel.map(m => `${m.enrolmentId}@${m.weekKey}`), [`e_amy@${T3W2}`]);

  // m — the Tally is untouched: same cells and Unscheduled count as before,
  // and the helper never mutates its inputs.
  const snapshot = JSON.stringify(fx);
  run(fx, HOL, sentAmy);
  assert("scope m: helper leaves its inputs untouched", JSON.stringify(fx) === snapshot, true);
  const T3_WEEKS = [T3W2, T3W3, T3W4].map((weekKey, i) => ({ weekKey, weekNum: i + 2, label: `W${i + 2}` }));
  const { tallyRows } = deriveTallyRows({ ...fx, termWeeks: T3_WEEKS, schoolFilter: "all" });
  assert("scope m: Tally cells unchanged",
    tallyRows.map(r => [r.lessonKey, ...T3_WEEKS.map(w => r.cells[w.weekKey].state)]).sort(),
    [
      ["amy|Piano", "missed-makeup-owed", "blank", "blank"],
      ["bob|Guitar", "blank", "missed-makeup-owed", "blank"],
      ["cal|Drums", "blank", "blank", "missed-makeup-owed"],
      ["dee|Violin", "missed-makeup-owed", "blank", "blank"],
    ]);
  assert("scope m: Tally Unscheduled count unchanged",
    getOpenCatchupRows({ ...fx, termWeeks: T3_WEEKS, schoolFilter: "all" }).length, 3);
}
