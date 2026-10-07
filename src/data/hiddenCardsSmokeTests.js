// ============================================================
// Hidden archived card rule (utils/hiddenCards.js) and its use in the
// warning check (utils/constraints.js). A non-group card of an archived
// student is hidden on the grid, gets no warnings, and never counts against a
// visible card. Called from runSmokeTests with its `assert`.
// ============================================================

import { isHiddenArchivedCard, makeHiddenArchivedCardTest } from "../utils/hiddenCards";
import { checkConstraints } from "../utils/constraints";

export function runHiddenCardTests(assert) {
  const studentsWith = ameliaStatus => [
    { id: "amelia", name: "Amelia Tarlamis", className: "3A", schoolId: "sch", status: ameliaStatus },
    { id: "maia",   name: "Maia Lafage",     className: "1T", schoolId: "sch", status: "active" },
    { id: "otto",   name: "Otto Group",      className: "2B", schoolId: "sch", status: "active" },
  ];
  const archived = studentsWith("archived");
  const active = studentsWith("active");

  const lane = { id: "lane1", teacherId: "rauzah", schoolId: "sch", day: "Wednesday", status: "active" };
  const card = (id, studentId, extra = {}) => ({ id, studentId, studentName: studentId, instrument: "Piano",
    schoolId: "sch", day: "Wednesday", start: "09:00", end: "09:30", bucket_id: "lane1", ...extra });
  const amelia = card("c-amelia", "amelia");
  const maia = card("c-maia", "maia");
  const group = { id: "c-group", isGroup: true, groupId: "g1", groupName: "Piano Group", studentId: "amelia",
    studentName: "Piano Group", studentIds: ["amelia", "otto"], schoolId: "sch", day: "Wednesday",
    start: "09:00", end: "09:30", bucket_id: "lane1" };
  const band = { id: "c-band", isBandSession: true, schoolId: "sch", day: "Wednesday", start: "09:00", end: "09:30",
    bucket_id: "lane1", members: [{ studentId: "amelia", instrument: "Piano" }] };

  const slot = { start: "09:00", end: "09:30", type: "class" };
  const ctx = students => ({
    weekKey: "2099-01-05", selectedSchool: "sch", currentSchool: { id: "sch", slots: [slot] },
    weeklyTimetables: {}, teacherCoverage: [lane], laneOverrides: [], students, enrolments: [],
    teachers: [{ id: "rauzah", name: "Rauzah Hamzah" }], schools: [{ id: "sch", name: "School" }], groups: [],
    weekDateMap: { Wednesday: "2099-01-07" }, weekInterruptions: [], specLookupRef: {}, timetable: null,
  });
  const clash = (lesson, list, students, extra = {}) =>
    checkConstraints(lesson, "Wednesday", slot, list, { ...ctx(students), ...extra })
      .filter(w => w.includes("at this time"));

  // The rule itself (what both grids now use)
  assert("hiddenCard: archived student's solo card is hidden", isHiddenArchivedCard(amelia, archived), true);
  assert("hiddenCard: active student's card is not hidden", isHiddenArchivedCard(amelia, active), false);
  assert("hiddenCard: group card with an archived member is never hidden", isHiddenArchivedCard(group, archived), false);
  assert("hiddenCard: band card is never hidden", isHiddenArchivedCard(band, archived), false);
  assert("hiddenCard: unknown student is not hidden", isHiddenArchivedCard(card("x", "ghost"), archived), false);
  const fast = makeHiddenArchivedCardTest(archived);
  assert("hiddenCard: fast test agrees with the rule on every card (MTT check uses it)",
    [amelia, maia, group, band].map(fast), [amelia, maia, group, band].map(l => isHiddenArchivedCard(l, archived)));

  // Grid filter output unchanged: the old inline filter vs the shared rule
  const oldGrid = (lessons, students) => lessons.filter(l => {
    if (!l.isGroup && l.studentId) {
      const liveStu = students.find(s => s.id === l.studentId);
      if (liveStu?.status === "archived") return false;
    }
    return true;
  });
  const all = [amelia, maia, group, band];
  for (const [label, sts] of [["archived", archived], ["active", active]]) {
    assert(`hiddenCard: grid output unchanged (${label})`,
      all.filter(l => !isHiddenArchivedCard(l, sts)).map(l => l.id), oldGrid(all, sts).map(l => l.id));
  }

  // Teacher clash on the visible card
  assert("hiddenCard: archived student's card does not clash with the visible card",
    clash(maia, [amelia, maia], archived), []);
  assert("hiddenCard: same case with the student active still clashes",
    clash(maia, [amelia, maia], active), ["Rauzah Hamzah already has Amelia Tarlamis at this time"]);
  assert("hiddenCard: cross-school pool also skips the hidden card",
    clash(maia, [maia], archived, { crossSchoolLessons: [amelia, maia] }), []);
  assert("hiddenCard: group card with an archived member still counts",
    clash(maia, [group, maia], archived), ["Rauzah Hamzah already has Piano Group at this time"]);
  assert("hiddenCard: band card with an archived member still counts",
    clash(maia, [band, maia], archived).length, 1);

  // Hidden card gets no warnings of its own (so it drops out of every count)
  assert("hiddenCard: hidden card produces no warnings",
    checkConstraints(amelia, "Wednesday", slot, [amelia, maia], ctx(archived)), []);
  assert("hiddenCard: un-archived card warns again with no extra step",
    clash(amelia, [amelia, maia], active), ["Rauzah Hamzah already has Maia Lafage at this time"]);

  // Group member double-booking: a hidden solo card is not a member clash
  const memberWarn = (students) =>
    checkConstraints(group, "Wednesday", slot, [group, card("c-amelia-tue", "amelia", { bucket_id: "none" })], ctx(students))
      .filter(w => w.includes("already has a lesson"));
  assert("hiddenCard: group member's hidden solo card is not a same-day clash", memberWarn(archived), []);
  assert("hiddenCard: group member's visible solo card is a same-day clash", memberWarn(active).length, 1);
}
