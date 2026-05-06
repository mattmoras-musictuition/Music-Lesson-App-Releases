// ============================================================
// scripts/diag/seed-spec-2-lanes.mjs
//
// Spec 2 Phase 1 cluster 2 — DRY-RUN seed planner for the
// teacher_coverage table (lane-ownership model). Reads only;
// emits a sectioned plan of inserts that cluster 3 will apply.
//
// Conventions mirror scripts/diag/audit-spec-2-buckets.mjs:
//   - URL + publishable key copied from src/supabaseClient.js
//   - Interactive login: email echoed, password masked
//   - persistSession: false (token never written to disk)
//   - signOut() in finally
//   - Generic error messages (no err.message bubbling)
//   - range(0, 9999) on bulk reads (defeats Supabase's 1000 cap)
//   - Section-based stdout output
//   - Exit codes:
//       0  dry-run clean
//       2  data-quality issue (table missing, fetch failure)
//      99  auth/connectivity failure
//
// Source scope: current-term weekly_adjustments rows; lessons[]
// JSONB iterated. termKey logic replicates tallyHelpers.js.
//
// Output sections:
//   1. SCHEMA PREFLIGHT          — teacher_coverage exists? active row count?
//   2. SOURCE DATA               — rows scanned, lessons, exclusions tally
//   3. CLASSIFICATION SUMMARY    — pairs per category
//   4. PLANNED INSERTS           — SOLO_REAL + DOMINANT_REAL with action
//   5. REVIEW NEEDED             — SECONDARY + AMBIGUOUS_REVIEW (banked #117)
//   6. EXCLUDED DATA             — broken FK / null teacher / _test / catchup
//
// READ-ONLY. No writes to teacher_coverage. Cluster 3 will execute
// the same plan with writes enabled.
// ============================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://eoexqzxrdegyazglpzrv.supabase.co";
const SUPABASE_KEY = "sb_publishable_t8NIXquR2txP16eigi37Jw_GszCNStY";

const BULK_RANGE_MAX = 9999;
const DOMINANT_THRESHOLD = 0.70; // strict >, per spec

const CTRL_C = String.fromCharCode(3);
const DEL    = String.fromCharCode(127);
const BACK   = String.fromCharCode(8);

// ── Args ────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { today: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--today=")) out.today = arg.slice("--today=".length);
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

// ── Pure helpers ─────────────────────────────────────────────
// uid() — matches src/utils/helpers.js:12 (Math.random().toString(36).slice(2,10))
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// computeTermKey — replicated from src/utils/tallyHelpers.js:34.
// sortedTermBreaks must be ascending by date.
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
const startsWithTest = (v) => typeof v === "string" && v.startsWith("_test_");

function printSection(title) {
  console.log("\n=== " + title + " ===");
}

function pct(n) {
  return (n * 100).toFixed(1) + "%";
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

  console.log("Spec 2 cluster 2 — teacher_coverage seed planner (DRY RUN)");
  console.log("today:    " + today);

  const email = await promptStdin("Email:    ", { echo: true });
  const password = await promptStdin("Password: ", { echo: false });

  const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
  if (authErr || !authData?.user?.id) {
    console.error("auth failed");
    process.exit(99);
  }
  const userId = authData.user.id;

  let exitCode = 0;
  try {
    // ── 1. SCHEMA PREFLIGHT ────────────────────────────────
    printSection("SCHEMA PREFLIGHT");
    {
      const { data: probe, error: probeErr } = await supabase
        .from("teacher_coverage")
        .select("id, status")
        .limit(1);
      if (probeErr) {
        console.error("  teacher_coverage probe failed (" + (probeErr.code || "?") + ") — table missing or RLS blocked");
        process.exit(2);
      }
      const { data: activeRows, error: activeErr } = await supabase
        .from("teacher_coverage")
        .select("id, school_id, day, teacher_id")
        .eq("status", "active")
        .range(0, BULK_RANGE_MAX);
      if (activeErr) {
        console.error("  teacher_coverage active-rows fetch failed");
        process.exit(2);
      }
      console.log("  teacher_coverage table     : present");
      console.log("  current active row count   : " + activeRows.length);
      // Hold for cross-check in step 6.
      var existingActive = activeRows;
    }

    // ── 2. SOURCE DATA — bulk loads + scope ────────────────
    async function bulk(table, columns = "*") {
      const { data: rows, error } = await supabase.from(table).select(columns).range(0, BULK_RANGE_MAX);
      if (error) throw new Error(`${table} fetch failed`);
      if (rows.length > BULK_RANGE_MAX - 1) {
        console.warn(`  warning: ${table} hit bulk cap (${BULK_RANGE_MAX}) — counts may be truncated`);
      }
      return rows;
    }

    const teachers      = await bulk("teachers");
    const schools       = await bulk("schools");
    const interruptions = await bulk("interruptions");
    const wadjAll       = await bulk("weekly_adjustments");

    const teacherIds = new Set(teachers.map(t => t.id));
    const teacherById = new Map(teachers.map(t => [t.id, t]));
    const schoolById  = new Map(schools.map(s => [s.id, s]));

    const termBreaks = interruptions
      .filter(i => i.type === "term_break")
      .map(i => ({ date: i.date, endDate: i.end_date || i.date }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const currentTermKey = computeTermKey(today, termBreaks);
    const scopeRows = wadjAll.filter(r => computeTermKey(r.week_key, termBreaks) === currentTermKey);

    printSection("SOURCE DATA");
    console.log("  current termKey            : " + currentTermKey);
    console.log("  weekly_adjustments rows    : " + wadjAll.length);
    console.log("  rows in current-term scope : " + scopeRows.length);

    // ── 3. Iterate lessons + classify exclusions ───────────
    let totalLessons = 0;
    const excl = {
      catchup_school: 0,
      test_school:    0,
      test_teacher:   0,
      null_teacher:   0,
      broken_fk:      0,
    };
    const exclSamples = {
      catchup_school: [],
      test_school:    [],
      test_teacher:   [],
      null_teacher:   [],
      broken_fk:      [],
    };
    // Surviving — keyed by "schoolId|day|teacherId"
    const trioMap = new Map();

    for (const r of scopeRows) {
      const lessons = Array.isArray(r.lessons) ? r.lessons : [];
      for (const l of lessons) {
        totalLessons++;
        const sid = l.schoolId || r.school_id || "";
        const day = l.day || "";
        const tid = isEmptyId(l.teacherId) ? "" : l.teacherId;

        // Exclusion priority order
        if (sid === "__catchup__") {
          excl.catchup_school++;
          if (exclSamples.catchup_school.length < 5) exclSamples.catchup_school.push({ weekKey: r.week_key, sid, day, tid });
          continue;
        }
        if (startsWithTest(sid)) {
          excl.test_school++;
          if (exclSamples.test_school.length < 5) exclSamples.test_school.push({ weekKey: r.week_key, sid, day, tid });
          continue;
        }
        if (startsWithTest(tid)) {
          excl.test_teacher++;
          if (exclSamples.test_teacher.length < 5) exclSamples.test_teacher.push({ weekKey: r.week_key, sid, day, tid });
          continue;
        }
        if (tid === "") {
          excl.null_teacher++;
          if (exclSamples.null_teacher.length < 5) exclSamples.null_teacher.push({ weekKey: r.week_key, sid, day, studentId: l.studentId || "", instrument: l.instrument || "" });
          continue;
        }
        if (!teacherIds.has(tid)) {
          excl.broken_fk++;
          if (exclSamples.broken_fk.length < 5) exclSamples.broken_fk.push({ weekKey: r.week_key, sid, day, tid });
          continue;
        }

        // Surviving — aggregate
        const key = `${sid}|${day}|${tid}`;
        if (!trioMap.has(key)) trioMap.set(key, { sid, day, tid, count: 0, weeks: new Set() });
        const t = trioMap.get(key);
        t.count++;
        t.weeks.add(r.week_key);
      }
    }

    const survivingLessons = totalLessons - Object.values(excl).reduce((a, b) => a + b, 0);

    console.log("  total lessons in scope     : " + totalLessons);
    console.log("  surviving (post-exclusion) : " + survivingLessons);
    console.log("  excluded — __catchup__     : " + excl.catchup_school);
    console.log("  excluded — _test_ school   : " + excl.test_school);
    console.log("  excluded — _test_ teacher  : " + excl.test_teacher);
    console.log("  excluded — null teacher    : " + excl.null_teacher);
    console.log("  excluded — broken FK       : " + excl.broken_fk);

    // ── 4. Aggregate + 5. classify per (school, day) ──────
    // Group surviving trios by (school, day)
    const sdMap = new Map(); // "schoolId|day" → [trio, ...]
    for (const t of trioMap.values()) {
      const sdKey = `${t.sid}|${t.day}`;
      if (!sdMap.has(sdKey)) sdMap.set(sdKey, []);
      sdMap.get(sdKey).push(t);
    }

    // Compute share + classify
    const SOLO_REAL = [];
    const DOMINANT_REAL = [];
    const SECONDARY = [];
    const AMBIGUOUS_REVIEW = [];
    for (const [sdKey, trios] of sdMap.entries()) {
      const total = trios.reduce((a, t) => a + t.count, 0);
      for (const t of trios) {
        t.share = total > 0 ? t.count / total : 0;
      }
      if (trios.length === 1) {
        SOLO_REAL.push(trios[0]);
      } else {
        const dom = trios.find(t => t.share > DOMINANT_THRESHOLD);
        if (dom) {
          DOMINANT_REAL.push(dom);
          for (const t of trios) {
            if (t !== dom) SECONDARY.push(t);
          }
        } else {
          for (const t of trios) AMBIGUOUS_REVIEW.push(t);
        }
      }
    }

    printSection("CLASSIFICATION SUMMARY");
    console.log("  (school, day) pairs in scope : " + sdMap.size);
    console.log("  SOLO_REAL trios              : " + SOLO_REAL.length);
    console.log("  DOMINANT_REAL trios          : " + DOMINANT_REAL.length);
    console.log("  SECONDARY trios              : " + SECONDARY.length);
    console.log("  AMBIGUOUS_REVIEW trios       : " + AMBIGUOUS_REVIEW.length);

    // ── 6. Compare planned inserts to existing active rows ─
    const existingKeys = new Set(
      existingActive.map(r => `${r.school_id}|${r.day}|${r.teacher_id}`)
    );

    const planned = [...SOLO_REAL, ...DOMINANT_REAL].sort((a, b) => {
      const an = (schoolById.get(a.sid)?.name || a.sid) + "|" + a.day;
      const bn = (schoolById.get(b.sid)?.name || b.sid) + "|" + b.day;
      return an.localeCompare(bn);
    });

    let insertPlanned = 0, skipExisting = 0;
    for (const t of planned) {
      const key = `${t.sid}|${t.day}|${t.tid}`;
      if (existingKeys.has(key)) {
        t._action = "SKIP_EXISTING";
        skipExisting++;
      } else {
        t._action = "INSERT_PLANNED";
        insertPlanned++;
      }
    }

    printSection("PLANNED INSERTS");
    console.log("  total planned trios        : " + planned.length);
    console.log("  INSERT_PLANNED             : " + insertPlanned);
    console.log("  SKIP_EXISTING (idempotent) : " + skipExisting);
    console.log("");
    if (planned.length === 0) {
      console.log("  (none)");
    } else {
      console.log(
        "  " +
        "ACTION".padEnd(16) +
        "SCHOOL".padEnd(28) +
        "DAY".padEnd(11) +
        "TEACHER".padEnd(24) +
        "SHARE   LESSONS  WEEKS"
      );
      for (const t of planned) {
        const sname = schoolById.get(t.sid)?.name || `(${t.sid})`;
        const tname = teacherById.get(t.tid)?.name || `(${t.tid})`;
        console.log(
          "  " +
          t._action.padEnd(16) +
          sname.padEnd(28) +
          t.day.padEnd(11) +
          tname.padEnd(24) +
          (t.share === 1 ? "100.0%" : pct(t.share)).padStart(6) +
          "  " + String(t.count).padStart(7) +
          "  " + String(t.weeks.size).padStart(5)
        );
      }
      console.log("");
      console.log("  Cluster 3 insert payload shape (per planned trio):");
      console.log("    {");
      console.log("      id: <uid()>,                        // 8-char base36, generated client-side");
      console.log("      user_id: '" + userId + "',");
      console.log("      school_id: <trio.sid>,");
      console.log("      day: <trio.day>,");
      console.log("      teacher_id: <trio.tid>,");
      console.log("      status: 'active',");
      console.log("      notes: null,");
      console.log("      // created_at / updated_at default now()");
      console.log("    }");
    }

    // ── REVIEW NEEDED ─────────────────────────────────────
    printSection("REVIEW NEEDED");
    console.log("  SECONDARY trios            : " + SECONDARY.length + "  (skipped — secondary teacher on a dominant pair)");
    console.log("  AMBIGUOUS_REVIEW trios     : " + AMBIGUOUS_REVIEW.length + "  (no teacher >70% — human eyeball before cluster 3)");

    // Print SECONDARY sorted by (school, day)
    if (SECONDARY.length > 0) {
      console.log("");
      console.log("  SECONDARY trios — skipped from auto-seed:");
      console.log(
        "    " +
        "SCHOOL".padEnd(28) +
        "DAY".padEnd(11) +
        "TEACHER".padEnd(24) +
        "SHARE   LESSONS  WEEKS"
      );
      const secSorted = [...SECONDARY].sort((a, b) => {
        const an = (schoolById.get(a.sid)?.name || a.sid) + "|" + a.day;
        const bn = (schoolById.get(b.sid)?.name || b.sid) + "|" + b.day;
        return an.localeCompare(bn);
      });
      for (const t of secSorted) {
        const sname = schoolById.get(t.sid)?.name || `(${t.sid})`;
        const tname = teacherById.get(t.tid)?.name || `(${t.tid})`;
        console.log(
          "    " +
          sname.padEnd(28) +
          t.day.padEnd(11) +
          tname.padEnd(24) +
          pct(t.share).padStart(6) +
          "  " + String(t.count).padStart(7) +
          "  " + String(t.weeks.size).padStart(5)
        );
      }
    }

    if (AMBIGUOUS_REVIEW.length > 0) {
      console.log("");
      console.log("  AMBIGUOUS_REVIEW — needs human decision:");
      // Group by (school, day) so the reviewer sees competing teachers together
      const ambByPair = new Map();
      for (const t of AMBIGUOUS_REVIEW) {
        const key = `${t.sid}|${t.day}`;
        if (!ambByPair.has(key)) ambByPair.set(key, []);
        ambByPair.get(key).push(t);
      }
      for (const [, group] of ambByPair) {
        const sname = schoolById.get(group[0].sid)?.name || `(${group[0].sid})`;
        console.log(`    ─ ${sname} / ${group[0].day}:`);
        const sorted = [...group].sort((a, b) => b.share - a.share);
        for (const t of sorted) {
          const tname = teacherById.get(t.tid)?.name || `(${t.tid})`;
          console.log(
            "        " + tname.padEnd(24) +
            pct(t.share).padStart(6) +
            "  " + String(t.count).padStart(4) + " lessons" +
            "  " + t.weeks.size + " wks"
          );
        }
      }
    }

    // ── EXCLUDED DATA ─────────────────────────────────────
    printSection("EXCLUDED DATA");
    console.log("  __catchup__ pseudo-school  : " + excl.catchup_school + "  (Spec 3 territory)");
    console.log("  _test_ school              : " + excl.test_school);
    console.log("  _test_ teacher             : " + excl.test_teacher);
    console.log("  null/empty teacher_id      : " + excl.null_teacher);
    console.log("  broken FK (teacher absent) : " + excl.broken_fk);

    function printExclSamples(label, arr) {
      if (arr.length === 0) return;
      console.log("");
      console.log(`  ${label} (first ${arr.length}):`);
      for (const s of arr) {
        const sname = schoolById.get(s.sid)?.name || s.sid || "(none)";
        const extra = s.studentId ? ` student=${s.studentId} instr=${s.instrument || ""}` : (s.tid ? ` teacherId=${s.tid}` : "");
        console.log(`    ${s.weekKey}  ${sname}/${s.day}${extra}`);
      }
    }
    printExclSamples("__catchup__ samples", exclSamples.catchup_school);
    printExclSamples("_test_ school samples", exclSamples.test_school);
    printExclSamples("_test_ teacher samples", exclSamples.test_teacher);
    printExclSamples("null teacher samples", exclSamples.null_teacher);
    printExclSamples("broken FK samples", exclSamples.broken_fk);

    console.log("");
    console.log("  Dry run complete. No writes performed. Cluster 3 will execute the same plan with writes enabled.");
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
