// ============================================================
// scripts/diag/audit-spec-2-buckets.mjs
//
// READ-ONLY data audit for Spec 2 Phase 0 — staff scheduling
// redesign. Maps the existing teacher-per-card data model to
// the proposed (school, day, teacher) bucket model, surfaces
// multi-teacher pairs with time-block detail, divergence
// (substitute) patterns, FK orphans, and band-teacher status.
//
// Conventions mirror audit-instruments-state.mjs:
//   - URL + publishable key copied from src/supabaseClient.js
//   - Interactive login: email echoed, password masked
//   - persistSession: false (token never written to disk)
//   - signOut() in finally
//   - Generic error messages (no err.message bubbling)
//   - range(0, 9999) on bulk reads (defeats Supabase's 1000 cap)
//   - Section-based stdout output
//   - Exit codes: 0 ok, 2 query failure, 99 script error
//
// Output:
//   - Sectioned summary printed to stdout.
//   - Full machine-readable dump written to data.json under
//     --out=<path> (default: ./audits/spec-2-phase-0/data.json).
//
// Read scope:
//   - teachers, schools, students, enrolments, groups, bands
//   - interruptions (filter type='term_break' for term scoping)
//   - weekly_adjustments (full table; lessons[] JSONB carries
//     WTT cards — no master_timetable / weekly_timetable tables
//     exist in this Supabase project)
//
// Term scoping: termBreaks (sorted asc) + computeTermKey replicate
// the runtime logic from src/utils/tallyHelpers.js. "Today" defaults
// to system date — override with --today=YYYY-MM-DD.
//
// Past terms sampled (2 most recent past) for pattern discovery only.
// Current + populated future terms are the migration-target scope.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const SUPABASE_URL = "https://eoexqzxrdegyazglpzrv.supabase.co";
const SUPABASE_KEY = "sb_publishable_t8NIXquR2txP16eigi37Jw_GszCNStY";

const BULK_RANGE_MAX = 9999;

const CTRL_C = String.fromCharCode(3);
const DEL    = String.fromCharCode(127);
const BACK   = String.fromCharCode(8);

// ── Args ────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { outPath: "./audits/spec-2-phase-0/data.json", today: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--out=")) out.outPath = arg.slice("--out=".length);
    else if (arg.startsWith("--today=")) out.today = arg.slice("--today=".length);
  }
  return out;
}

// ── Stdin prompt (echo on for email, off for password) ─────
function promptStdin(prompt, { echo }) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("not a TTY — refusing to read credentials non-interactively"));
      return;
    }
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let buf = "";
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === CTRL_C) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("aborted"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === DEL || ch === BACK) {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            if (echo) process.stdout.write("\b \b");
          }
          continue;
        }
        buf += ch;
        if (echo) process.stdout.write(ch);
      }
    };
    process.stdin.on("data", onData);
  });
}

// ── Pure helpers (replicated from src/utils/tallyHelpers.js) ──
// Compute termKey for a date. Mirrors tallyHelpers.js:computeTermKey
// (with the bug-for-bug behaviour preserved — index-based term
// numbering inside a year). sortedTermBreaks must be ascending by date.
function _t1Tuesday(year) {
  const s = new Date(year, 0, 27);
  while (s.getDay() !== 2) s.setDate(s.getDate() + 1);
  return s;
}
function computeTermKey(dateStr, sortedTermBreaks) {
  const d = new Date(dateStr + "T00:00:00");
  for (const y of [d.getFullYear() - 1, d.getFullYear(), d.getFullYear() + 1]) {
    let tStart = _t1Tuesday(y);
    const yBreaks = sortedTermBreaks.filter(tb => new Date(tb.date + "T00:00:00").getFullYear() === y);
    for (const tb of yBreaks) {
      const bs = new Date(tb.date + "T00:00:00");
      const be = new Date((tb.endDate || tb.date) + "T00:00:00");
      if (bs > tStart) {
        const te = new Date(bs); te.setDate(te.getDate() - 1);
        if (d >= tStart && d <= te) return `${y}-T${sortedTermBreaks.indexOf(tb) + 1}`;
        tStart = new Date(be); tStart.setDate(tStart.getDate() + 1);
        while (tStart.getDay() === 0 || tStart.getDay() === 6) tStart.setDate(tStart.getDate() + 1);
      }
    }
    if (d >= tStart) return `${y}-T${yBreaks.length + 1}`;
  }
  return null;
}

const isEmptyId = (v) => v === null || v === undefined || v === "";

// ── Section printers ─────────────────────────────────────────
function printSection(title) {
  console.log("\n=== " + title + " ===");
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const today = args.today || new Date().toISOString().slice(0, 10);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  console.log("Spec 2 Phase 0 audit — starting");
  console.log("today:    " + today);
  console.log("out:      " + args.outPath);

  const email = await promptStdin("Email:    ", { echo: true });
  const password = await promptStdin("Password: ", { echo: false });

  const { error: authErr } = await supabase.auth.signInWithPassword({ email, password });
  if (authErr) {
    console.error("auth failed");
    process.exit(1);
  }

  const data = {
    runMeta: { today, generatedAt: new Date().toISOString() },
    schema: {},
    counts: {},
    sections: {},
  };

  let exitCode = 0;
  try {
    // ── Schema probe ─────────────────────────────────────────
    // Pull 1 row from each table; capture column names actually present.
    printSection("SCHEMA PROBE");
    async function probe(table) {
      const { data: row, error } = await supabase.from(table).select("*").limit(1);
      if (error) {
        console.log(`  ${table.padEnd(22)} : ERROR (${error.code || "?"})`);
        return [];
      }
      const cols = row && row[0] ? Object.keys(row[0]) : [];
      console.log(`  ${table.padEnd(22)} : ${cols.length} cols → ${cols.join(", ")}`);
      return cols;
    }
    for (const t of ["teachers", "schools", "students", "enrolments", "groups", "bands", "interruptions", "weekly_adjustments"]) {
      data.schema[t] = await probe(t);
    }

    // ── Bulk fetches ─────────────────────────────────────────
    printSection("BULK FETCH");
    async function bulk(table, columns = "*") {
      const { data: rows, error } = await supabase.from(table).select(columns).range(0, BULK_RANGE_MAX);
      if (error) throw new Error(`${table} fetch failed`);
      if (rows.length > BULK_RANGE_MAX - 1) {
        console.warn(`  warning: ${table} hit bulk cap (${BULK_RANGE_MAX}) — counts may be truncated`);
      }
      console.log(`  ${table.padEnd(22)} : ${rows.length} rows`);
      return rows;
    }
    const teachers     = await bulk("teachers");
    const schools      = await bulk("schools");
    const students     = await bulk("students");
    const enrolments   = await bulk("enrolments");
    const groups       = await bulk("groups");
    const bands        = await bulk("bands");
    const interruptions = await bulk("interruptions");
    const wadjAll      = await bulk("weekly_adjustments");

    data.counts.teachers = teachers.length;
    data.counts.schools = schools.length;
    data.counts.students = students.length;
    data.counts.enrolments = enrolments.length;
    data.counts.groups = groups.length;
    data.counts.bands = bands.length;
    data.counts.interruptions = interruptions.length;
    data.counts.weeklyAdjustmentRows = wadjAll.length;

    // Indexes
    const teacherIds = new Set(teachers.map(t => t.id));
    const teacherById = new Map(teachers.map(t => [t.id, t]));
    const schoolById = new Map(schools.map(s => [s.id, s]));
    const studentById = new Map(students.map(s => [s.id, s]));
    const groupById = new Map(groups.map(g => [g.id, g]));
    const bandById = new Map(bands.map(b => [b.id, b]));
    // enrolments lookup: by (studentId, instrument); also by id (when stamped)
    const enrolmentByIdx = new Map();
    for (const e of enrolments) {
      enrolmentByIdx.set(`${e.student_id}|${e.instrument}`, e);
    }

    // ── Term scoping ─────────────────────────────────────────
    const termBreaks = interruptions
      .filter(i => i.type === "term_break")
      .map(i => ({ date: i.date, endDate: i.end_date || i.date }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const currentTermKey = computeTermKey(today, termBreaks);

    // For each weekly_adjustments row, attach termKey
    for (const r of wadjAll) {
      r._termKey = computeTermKey(r.week_key, termBreaks);
    }

    const termRowCounts = {};
    const termLessonCounts = {};
    for (const r of wadjAll) {
      const k = r._termKey || "(unmapped)";
      termRowCounts[k] = (termRowCounts[k] || 0) + 1;
      termLessonCounts[k] = (termLessonCounts[k] || 0) + (Array.isArray(r.lessons) ? r.lessons.length : 0);
    }
    const sortedTermKeys = Object.keys(termRowCounts).sort();

    printSection("TERM DISTRIBUTION");
    console.log("  current term (from today): " + currentTermKey);
    console.log("  termKey                rows  lessons");
    for (const k of sortedTermKeys) {
      console.log(`  ${k.padEnd(20)} ${String(termRowCounts[k]).padStart(5)}  ${String(termLessonCounts[k]).padStart(7)}`);
    }
    data.sections.termDistribution = { currentTermKey, perTerm: sortedTermKeys.map(k => ({ termKey: k, rows: termRowCounts[k], lessons: termLessonCounts[k] })) };

    // Determine scope:
    //   - currentTerm: rows whose _termKey === currentTermKey
    //   - futurePopulated: rows whose _termKey > currentTermKey AND have ≥1 lesson
    //   - pastSampled: 2 most recent past terms (rows where _termKey < currentTermKey)
    const futureTermKeys = sortedTermKeys.filter(k => k && currentTermKey && k > currentTermKey && termLessonCounts[k] > 0);
    const pastTermKeys = sortedTermKeys.filter(k => k && currentTermKey && k < currentTermKey);
    const pastSampleKeys = pastTermKeys.slice(-2); // 2 most recent past terms

    const scopeRows = wadjAll.filter(r => r._termKey === currentTermKey || futureTermKeys.includes(r._termKey));
    const sampleRows = wadjAll.filter(r => pastSampleKeys.includes(r._termKey));

    console.log(`  scope (current + future populated) : ${scopeRows.length} rows`);
    console.log(`  past sample (terms ${pastSampleKeys.join(", ") || "—"}): ${sampleRows.length} rows`);
    data.sections.termDistribution.scopeRows = scopeRows.length;
    data.sections.termDistribution.pastSampleKeys = pastSampleKeys;
    data.sections.termDistribution.futureTermKeys = futureTermKeys;

    // ── Helpers for per-lesson live teacher computation ──────
    // Returns { liveTeacherId, liveSource } or { liveTeacherId: null, liveSource: 'unknown' }.
    function computeLive(lesson) {
      // Group lessons: live = group.teacher_id
      if (lesson.isGroup && lesson.groupId) {
        const g = groupById.get(lesson.groupId);
        if (g) return { liveTeacherId: g.teacher_id || null, liveSource: "group" };
        return { liveTeacherId: null, liveSource: "group_missing" };
      }
      // Band sessions: live = band.teacher_id
      if (lesson.isBandSession) {
        const bandId = lesson.bandId || lesson.groupId;
        if (bandId) {
          const b = bandById.get(bandId);
          if (b) return { liveTeacherId: b.teacher_id || null, liveSource: "band" };
        }
        return { liveTeacherId: null, liveSource: "band_unmatched" };
      }
      // Solo lessons: live = enrolment.teacher_id, matched by enrolmentId else (studentId, instrument)
      if (lesson.enrolmentId) {
        const e = enrolments.find(en => en.id === lesson.enrolmentId);
        if (e) return { liveTeacherId: e.teacher_id || null, liveSource: "enrolment_id" };
      }
      const e = enrolmentByIdx.get(`${lesson.studentId}|${lesson.instrument}`);
      if (e) return { liveTeacherId: e.teacher_id || null, liveSource: "enrolment_pair" };
      return { liveTeacherId: null, liveSource: "unmatched" };
    }

    // ── Section: per-(school, day) teacher distribution ──────
    // Aggregate UNIQUE stored teacherIds present per (school_id, day) across
    // all in-scope weeks. Each lesson contributes its (schoolId, day, teacherId)
    // and start/end times. Multi-teacher pairs include time/slot data
    // (refinement 1: time-block segmentation visibility).
    printSection("PER-(SCHOOL, DAY) TEACHER DISTRIBUTION — current + future populated");
    const sdMap = new Map(); // key "schoolId|day" → { teacherIds: Set, slotsByTeacher: Map<tid, [{start,end,studentId,...}]> }
    for (const r of scopeRows) {
      const lessons = Array.isArray(r.lessons) ? r.lessons : [];
      for (const l of lessons) {
        const sid = l.schoolId || r.school_id || "(none)";
        const day = l.day || "(none)";
        const tid = isEmptyId(l.teacherId) ? "" : l.teacherId;
        const key = `${sid}|${day}`;
        if (!sdMap.has(key)) sdMap.set(key, { teacherIds: new Set(), slots: [] });
        const entry = sdMap.get(key);
        entry.teacherIds.add(tid);
        entry.slots.push({
          weekKey: r.week_key, teacherId: tid,
          start: l.start || "", end: l.end || "",
          studentId: l.studentId || "", instrument: l.instrument || "",
          isGroup: !!l.isGroup, isBandSession: !!l.isBandSession,
          groupId: l.groupId || null, bandId: l.bandId || null,
        });
      }
    }

    let pairs0 = 0, pairs1 = 0, pairs2 = 0, pairs3 = 0;
    const multiPairs = [];
    const zeroPairs = [];
    for (const [key, v] of sdMap.entries()) {
      const distinct = [...v.teacherIds];
      const realDistinct = distinct.filter(t => t !== "");
      const hasEmpty = distinct.includes("");
      const count = realDistinct.length;
      if (count === 0) { pairs0++; zeroPairs.push({ key, hasEmpty, slotCount: v.slots.length, sampleSlots: v.slots.slice(0, 5) }); }
      else if (count === 1) pairs1++;
      else if (count === 2) { pairs2++; multiPairs.push({ key, distinctTeachers: realDistinct, hasEmptyTeacher: hasEmpty, slots: v.slots }); }
      else { pairs3++; multiPairs.push({ key, distinctTeachers: realDistinct, hasEmptyTeacher: hasEmpty, slots: v.slots }); }
    }
    console.log(`  pairs with 1 teacher  : ${pairs1}`);
    console.log(`  pairs with 2 teachers : ${pairs2}`);
    console.log(`  pairs with 3+ teachers: ${pairs3}`);
    console.log(`  pairs with 0 teachers : ${pairs0}  (cards exist but all teacherId empty)`);
    console.log(`  total (school, day) pairs in scope: ${sdMap.size}`);

    // For multi-teacher pairs, report time-segmentation summary.
    // Compute, per teacher, [minStart, maxStart] from slots — gives a picture
    // of whether teachers occupy disjoint time bands.
    if (multiPairs.length > 0) {
      console.log("\n  multi-teacher pairs (showing time bands per teacher):");
      for (const mp of multiPairs.slice(0, 30)) {
        const [sid, day] = mp.key.split("|");
        const sName = schoolById.get(sid)?.name || sid;
        console.log(`  ─ ${sName} / ${day}  (${mp.distinctTeachers.length} teachers${mp.hasEmptyTeacher ? " + empty" : ""})`);
        for (const tid of mp.distinctTeachers) {
          const tname = teacherById.get(tid)?.name || `(unknown:${tid})`;
          const tslots = mp.slots.filter(s => s.teacherId === tid).map(s => s.start).filter(Boolean).sort();
          const minStart = tslots[0] || "?";
          const maxStart = tslots[tslots.length - 1] || "?";
          console.log(`     ${tname.padEnd(28)}  starts: ${minStart}–${maxStart}  (${tslots.length} slot-instances)`);
        }
      }
      if (multiPairs.length > 30) console.log(`  …${multiPairs.length - 30} more multi-teacher pairs (full list in data.json)`);
    }

    if (zeroPairs.length > 0) {
      console.log("\n  zero-real-teacher pairs (all-empty teacherId):");
      for (const zp of zeroPairs.slice(0, 20)) {
        const [sid, day] = zp.key.split("|");
        const sName = schoolById.get(sid)?.name || sid;
        console.log(`  ─ ${sName} / ${day}  ${zp.slotCount} slot-instances`);
      }
    }

    data.sections.teacherDistribution = {
      pairs0, pairs1, pairs2, pairs3,
      totalPairs: sdMap.size,
      multiPairs: multiPairs.map(mp => ({
        key: mp.key,
        distinctTeachers: mp.distinctTeachers,
        hasEmptyTeacher: mp.hasEmptyTeacher,
        slotsByTeacher: Object.fromEntries(
          mp.distinctTeachers.map(tid => [tid, mp.slots.filter(s => s.teacherId === tid)])
        ),
      })),
      zeroPairs,
    };

    // ── Section: stored-vs-live divergence ──────────────────
    // For each lesson in scope, compute live teacher and compare to stored.
    // Divergence = stored teacherId differs from live (and live is non-null).
    printSection("STORED-VS-LIVE TEACHER DIVERGENCE — current + future populated");
    let totalLessons = 0;
    let nullStored = 0;
    let nullLive = 0;
    let matchCount = 0;
    let divergeCount = 0;
    let unmatchedLive = 0;
    const divergePerEnrolment = new Map();
    const divergeSamples = [];
    for (const r of scopeRows) {
      const lessons = Array.isArray(r.lessons) ? r.lessons : [];
      for (const l of lessons) {
        totalLessons++;
        const stored = isEmptyId(l.teacherId) ? null : l.teacherId;
        const { liveTeacherId, liveSource } = computeLive(l);
        if (stored === null) nullStored++;
        if (liveTeacherId === null) nullLive++;
        if (liveSource === "unmatched" || liveSource === "band_unmatched" || liveSource === "group_missing") unmatchedLive++;
        if (stored && liveTeacherId) {
          if (stored === liveTeacherId) matchCount++;
          else {
            divergeCount++;
            const enrolKey = l.enrolmentId || `${l.studentId}|${l.instrument}` || (l.groupId && `group|${l.groupId}`) || "(no-key)";
            divergePerEnrolment.set(enrolKey, (divergePerEnrolment.get(enrolKey) || 0) + 1);
            if (divergeSamples.length < 25) {
              divergeSamples.push({
                weekKey: r.week_key, schoolId: l.schoolId || r.school_id || "",
                day: l.day || "", start: l.start || "",
                stored, live: liveTeacherId,
                storedName: teacherById.get(stored)?.name || `(unknown:${stored})`,
                liveName: teacherById.get(liveTeacherId)?.name || `(unknown:${liveTeacherId})`,
                enrolKey, isGroup: !!l.isGroup, isBandSession: !!l.isBandSession,
              });
            }
          }
        }
      }
    }
    console.log(`  total lessons in scope : ${totalLessons}`);
    console.log(`  stored=live (match)    : ${matchCount}`);
    console.log(`  stored≠live (diverge)  : ${divergeCount}`);
    console.log(`  stored teacherId null  : ${nullStored}`);
    console.log(`  live teacherId null    : ${nullLive}`);
    console.log(`  live source unmatched  : ${unmatchedLive}  (no enrolment / group / band found for the card)`);

    // Per-enrolment divergence histogram
    const enrolDivergeBuckets = { "1": 0, "2-5": 0, "6-10": 0, "11+": 0 };
    for (const v of divergePerEnrolment.values()) {
      if (v === 1) enrolDivergeBuckets["1"]++;
      else if (v <= 5) enrolDivergeBuckets["2-5"]++;
      else if (v <= 10) enrolDivergeBuckets["6-10"]++;
      else enrolDivergeBuckets["11+"]++;
    }
    console.log("\n  per-enrolment divergence frequency:");
    for (const [k, v] of Object.entries(enrolDivergeBuckets)) {
      console.log(`    ${k.padEnd(5)} divergent week(s): ${v} enrolments`);
    }
    console.log("\n  divergence samples (first 25):");
    for (const s of divergeSamples) {
      console.log(`    ${s.weekKey} ${s.day} ${s.start}  ${s.storedName} → ${s.liveName}  [${s.enrolKey}]`);
    }
    data.sections.divergence = {
      totalLessons, matchCount, divergeCount, nullStored, nullLive, unmatchedLive,
      enrolDivergeBuckets,
      enrolmentDivergenceMap: Object.fromEntries(divergePerEnrolment),
      samples: divergeSamples,
    };

    // ── Section: orphan / broken FK ─────────────────────────
    printSection("ORPHAN / BROKEN FK — stored lesson.teacherId");
    let nullOrEmpty = 0;
    let validFk = 0;
    let brokenFk = 0;
    const brokenFkSamples = [];
    for (const r of scopeRows) {
      const lessons = Array.isArray(r.lessons) ? r.lessons : [];
      for (const l of lessons) {
        if (isEmptyId(l.teacherId)) { nullOrEmpty++; continue; }
        if (teacherIds.has(l.teacherId)) { validFk++; continue; }
        brokenFk++;
        if (brokenFkSamples.length < 20) {
          brokenFkSamples.push({
            weekKey: r.week_key, schoolId: l.schoolId || r.school_id || "",
            day: l.day || "", start: l.start || "",
            badTeacherId: l.teacherId, studentId: l.studentId || "", instrument: l.instrument || "",
            enrolmentId: l.enrolmentId || null,
          });
        }
      }
    }
    console.log(`  null/empty teacherId   : ${nullOrEmpty}`);
    console.log(`  valid FK to teachers   : ${validFk}`);
    console.log(`  broken FK              : ${brokenFk}  (teacherId set but not in teachers table)`);
    if (brokenFkSamples.length > 0) {
      console.log("\n  broken-FK samples:");
      for (const s of brokenFkSamples) {
        console.log(`    ${s.weekKey} ${s.day} ${s.start}  bad=${s.badTeacherId}  student=${s.studentId} ${s.instrument}`);
      }
    }
    data.sections.orphans = { nullOrEmpty, validFk, brokenFk, brokenFkSamples };

    // ── Section: WTT-only trio analysis grouped by teacher_id status ──
    // For each (school, day, teacher) trio, count how many lessons reference it
    // across in-scope weeks. Group by teacher_id status:
    //   real      — teacherId in teachers table
    //   null      — teacherId empty/null
    //   broken    — teacherId set but not in teachers table
    // Within each status, list trios sorted by lesson count.
    // (refinement 2: band teacher_id behaviour visible at a glance.)
    printSection("(SCHOOL, DAY, TEACHER) TRIO ANALYSIS — grouped by teacher_id status");
    const trioMap = new Map(); // key "schoolId|day|teacherId(or '')" → { count, weekKeys: Set, isBandSession: bool, hasGroup: bool, sampleStudent }
    for (const r of scopeRows) {
      const lessons = Array.isArray(r.lessons) ? r.lessons : [];
      for (const l of lessons) {
        const sid = l.schoolId || r.school_id || "";
        const day = l.day || "";
        const tid = isEmptyId(l.teacherId) ? "" : l.teacherId;
        const key = `${sid}|${day}|${tid}`;
        if (!trioMap.has(key)) trioMap.set(key, { count: 0, weekKeys: new Set(), bandCount: 0, groupCount: 0, soloCount: 0, sample: null });
        const t = trioMap.get(key);
        t.count++;
        t.weekKeys.add(r.week_key);
        if (l.isBandSession) t.bandCount++;
        else if (l.isGroup) t.groupCount++;
        else t.soloCount++;
        if (!t.sample) t.sample = { studentId: l.studentId || "", instrument: l.instrument || "", isGroup: !!l.isGroup, isBandSession: !!l.isBandSession, groupId: l.groupId || null, bandId: l.bandId || null };
      }
    }
    const totalWeeksInScope = new Set(scopeRows.map(r => r.week_key)).size || 1;

    function classifyTrio(tid) {
      if (tid === "") return "null";
      if (teacherIds.has(tid)) return "real";
      return "broken";
    }
    const trioByStatus = { real: [], null: [], broken: [] };
    for (const [key, v] of trioMap.entries()) {
      const [sid, day, tid] = key.split("|");
      const status = classifyTrio(tid);
      trioByStatus[status].push({
        schoolId: sid, day, teacherId: tid,
        schoolName: schoolById.get(sid)?.name || sid,
        teacherName: teacherById.get(tid)?.name || (tid === "" ? "(empty)" : `(unknown:${tid})`),
        lessons: v.count, weeks: v.weekKeys.size,
        weeksFraction: +(v.weekKeys.size / totalWeeksInScope).toFixed(2),
        bandCount: v.bandCount, groupCount: v.groupCount, soloCount: v.soloCount,
        sample: v.sample,
      });
    }
    for (const k of ["real", "null", "broken"]) trioByStatus[k].sort((a, b) => b.lessons - a.lessons);

    for (const status of ["real", "null", "broken"]) {
      const trios = trioByStatus[status];
      console.log(`\n  status=${status}  trios: ${trios.length}`);
      if (status === "null" || status === "broken" || trios.length <= 25) {
        for (const t of trios.slice(0, 50)) {
          const composition = `${t.soloCount} solo / ${t.groupCount} group / ${t.bandCount} band`;
          console.log(`    ${t.schoolName.padEnd(22)} ${t.day.padEnd(10)} ${t.teacherName.padEnd(28)} ${String(t.lessons).padStart(4)} lessons across ${t.weeks}/${totalWeeksInScope} weeks (${composition})`);
        }
        if (trios.length > 50) console.log(`    …${trios.length - 50} more (full list in data.json)`);
      } else {
        console.log("    (real-status full list in data.json — only printing summary)");
        const totalRealLessons = trios.reduce((a, t) => a + t.lessons, 0);
        const stableTrios = trios.filter(t => t.weeksFraction >= 0.8).length;
        const oneOffTrios = trios.filter(t => t.weeks <= 1).length;
        console.log(`    total real-teacher lessons : ${totalRealLessons}`);
        console.log(`    stable trios (≥80% of weeks): ${stableTrios}  (likely MTT-implied)`);
        console.log(`    one-off trios (1 week only) : ${oneOffTrios}  (likely WTT-only / sub patterns)`);
      }
    }

    data.sections.trios = {
      totalWeeksInScope,
      byStatus: trioByStatus,
    };

    // ── Section: past-term sample ───────────────────────────
    if (sampleRows.length > 0) {
      printSection(`PAST-TERM SAMPLE (terms ${pastSampleKeys.join(", ")})`);
      let pastLessons = 0, pastDiverge = 0, pastNullStored = 0, pastBrokenFk = 0;
      for (const r of sampleRows) {
        const lessons = Array.isArray(r.lessons) ? r.lessons : [];
        for (const l of lessons) {
          pastLessons++;
          const stored = isEmptyId(l.teacherId) ? null : l.teacherId;
          if (stored === null) pastNullStored++;
          else if (!teacherIds.has(stored)) pastBrokenFk++;
          const { liveTeacherId } = computeLive(l);
          if (stored && liveTeacherId && stored !== liveTeacherId) pastDiverge++;
        }
      }
      console.log(`  total lessons in past sample  : ${pastLessons}`);
      console.log(`  divergence in past sample     : ${pastDiverge}`);
      console.log(`  null stored teacherId         : ${pastNullStored}`);
      console.log(`  broken FK                     : ${pastBrokenFk}`);
      data.sections.pastSample = { pastLessons, pastDiverge, pastNullStored, pastBrokenFk };
    } else {
      console.log("\n  (no past-term sample rows available — skipped)");
      data.sections.pastSample = null;
    }

    // ── Write data.json ──────────────────────────────────────
    printSection("WRITING DATA.JSON");
    const outDir = path.dirname(args.outPath);
    if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(args.outPath, JSON.stringify(data, null, 2));
    console.log(`  wrote ${args.outPath}`);
    console.log("\n  Audit complete. Use data.json + this stdout transcript for the report.");
  } catch (e) {
    console.error("query failed:", e?.message ?? "unknown stage");
    exitCode = 2;
  } finally {
    await supabase.auth.signOut().catch(() => {});
  }

  process.exit(exitCode);
}

main().catch(() => {
  console.error("script error");
  process.exit(99);
});
