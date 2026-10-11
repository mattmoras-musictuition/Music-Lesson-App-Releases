// ============================================================
// frozenStampSmokeTests.js — v2.49.16 the frozen-teacher stamp
// (frozenTeacherId) Generate puts on every non-band weekly card, shared with
// Import from MTT. Fixture: a whole Moorabbin week from the master — a
// live-lane lesson each day, a card on an archived lane that is in the lane
// history, a card with no bucket_id, a band card, and one lesson an
// interruption cancels (lands in missed[]).
// ============================================================

import { generateWeeklyTimetable } from "./weeklyTimetableGenerator";
import { setLaneHistory, getLaneHistory, stampFrozenTeacher } from "../utils/teacherCoverageDB";

const S = "moorabbin";
export const FS_TC = [
  { id: "xov9t1ep", schoolId: S, day: "Tuesday", teacherId: "rauzah", status: "active", effectiveTo: null, createdAt: "2026-10-10T15:10" },
  { id: "npm9gxwu", schoolId: S, day: "Friday", teacherId: "matt", status: "active", effectiveTo: null, createdAt: "2026-10-10T15:20" },
  { id: "monlane1", schoolId: S, day: "Monday", teacherId: "matt", status: "active", effectiveTo: null, createdAt: "2026-01-01" },
];
export const FS_ARCHIVED = { id: "glkw2if8", schoolId: S, day: "Tuesday", teacherId: "matt", status: "archived", effectiveTo: null, createdAt: "2026-01-01" };
export const FS_SCHOOL = { id: S, name: "Moorabbin Primary", days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], slots: [
  { id: "p1", name: "P1", start: "09:00", end: "09:30", type: "class" },
  { id: "p2", name: "P2", start: "09:30", end: "10:00", type: "class" },
  { id: "p3", name: "P3", start: "10:00", end: "10:30", type: "class" }] };
const m = (id, day, start, bucket_id, extra = {}) => ({ id, studentId: "s_" + id, studentName: "Student " + id, schoolId: S, schoolName: "Moorabbin Primary",
  day, start, end: start === "09:00" ? "09:30" : start === "09:30" ? "10:00" : "10:30", slotId: start === "09:00" ? "p1" : start === "09:30" ? "p2" : "p3",
  instrument: "Piano", ...(bucket_id ? { bucket_id } : {}), ...extra });
export const FS_MASTER = [
  m("mon1", "Monday", "09:00", "monlane1"),
  m("tue1", "Tuesday", "09:00", "xov9t1ep"),
  m("tue2", "Tuesday", "09:30", "glkw2if8"),            // archived lane, in history
  m("tue3", "Tuesday", "10:00", null),                   // no bucket_id → day-lane fallback
  m("fri1", "Friday", "09:00", "npm9gxwu"),
  m("fri2", "Friday", "09:30", "npm9gxwu", { frozenTeacherId: "someoneelse" }),  // stale stamp on a master card
  m("band1", "Friday", "10:00", "npm9gxwu", { isBandSession: true, bandId: "B1", bandName: "Band", members: [] }),
  m("wed1", "Wednesday", "09:00", null),                 // no lane that day → unstamped
];
export const FS_STUDENTS = FS_MASTER.map(l => ({ id: l.studentId, name: l.studentName, schoolId: S, className: "3A", status: "active" }));
export const FS_TEACHERS = [{ id: "matt", name: "Matt Moras" }, { id: "rauzah", name: "Rauzah Hamzah" }];
export const fsWeekDates = (mon) => ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day, i) => {
  const d = new Date(mon + "T00:00:00"); d.setDate(d.getDate() + i);
  return { day, date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` };
});
const W = "2099-03-09";
const CANCEL = [{ action: "tally_remove", lessonMatch: (l) => l.id === "mon1" }];

export const withHistory = (fn) => {
  const saved = getLaneHistory();
  setLaneHistory([FS_ARCHIVED]);
  try { return fn(); } finally { setLaneHistory(saved); }
};
export const fsDigest = (v) => { const t = JSON.stringify(v); let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return t.length + ":" + h; };

export function runFrozenStampGeneratorTests(assert) {
  const gen = withHistory(() => generateWeeklyTimetable(FS_MASTER, FS_SCHOOL, FS_STUDENTS, FS_TEACHERS, [], [], fsWeekDates(W), CANCEL, [], FS_TC, []));
  assert("frozenStamp: generator stamps per card (band unstamped, no-lane unstamped)",
    [gen.lessons.map(l => [l.id, l.frozenTeacherId || null]), gen.missed.map(l => [l.id, l.frozenTeacherId || null])],
    [[["tue1", "rauzah"], ["tue2", "matt"], ["tue3", "rauzah"], ["fri1", "matt"], ["fri2", "matt"], ["band1", null], ["wed1", null]], [["mon1", "matt"]]]);
  assert("frozenStamp: generator whole-week output pinned", fsDigest(gen), "2369:3196917129");

  // The shared helper on its own.
  const stamped = withHistory(() => stampFrozenTeacher(FS_MASTER, FS_TC));
  assert("frozenStamp: helper stamps non-band cards, skips band and no-lane cards",
    stamped.map(l => [l.id, l.frozenTeacherId || null]),
    [["mon1", "matt"], ["tue1", "rauzah"], ["tue2", "matt"], ["tue3", "rauzah"], ["fri1", "matt"], ["fri2", "matt"], ["band1", null], ["wed1", null]]);
  assert("frozenStamp: helper returns band/unresolved entries as the same objects",
    [stamped[6] === FS_MASTER[6], stamped[7] === FS_MASTER[7]], [true, true]);
  assert("frozenStamp: helper leaves its input untouched", FS_MASTER[0].frozenTeacherId, undefined);
  assert("frozenStamp: no teacher coverage → nothing stamped", stampFrozenTeacher(FS_MASTER, null).some(l => l.frozenTeacherId && l.id !== "fri2"), false);
  assert("frozenStamp: empty input", [stampFrozenTeacher(null, FS_TC), stampFrozenTeacher([], FS_TC)], [[], []]);
}
