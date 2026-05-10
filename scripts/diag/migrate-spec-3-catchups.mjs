// ============================================================
// scripts/diag/migrate-spec-3-catchups.mjs
//
// Spec 3 cluster 3 — one-shot migration of catchup data from the
// JSONB-on-weekly_adjustments model into the public.catchups
// table (schema landed cluster 1, loader cluster 2, currently 0
// production rows).
//
// Source data (per Phase 0 baseline):
//   - Group A: weekly_adjustments rows where school_id ===
//     '__catchup__'. All entries in lessons[] are catchups.
//   - Group B: weekly_adjustments rows where school_id !==
//     '__catchup__' AND any lessons[].isMakeup === true. Only
//     the isMakeup-flagged entries are catchups.
//
// V4 reversal: drop teacherId, teacherName, _swapTeacherId,
// _swapTeacherName from incoming JSONB without preserving them.
// The catchups table has no teacher_id column.
//
// This script writes to catchups ONLY in --execute mode. Source
// weekly_adjustments rows are NOT touched — strip is cluster 11.
//
// Modes:
//   --dry-run (default): print the migration plan + write JSON
//     dump. NO writes to catchups.
//   --execute:           refuse if catchups already has rows;
//     otherwise insert the planned rows one at a time, stopping
//     on first error.
//
// Conventions mirror audit-spec-3-catchup.mjs:
//   - URL + publishable key copied from src/supabaseClient.js
//   - Interactive login: email echoed, password masked
//   - persistSession: false (token never written to disk)
//   - signOut() in finally
//   - Generic error messages (no err.message bubbling)
//   - range(0, 9999) on bulk reads (defeats Supabase's 1000 cap)
//   - Section-based stdout output
//   - Exit codes: 0 ok, 2 query/data failure, 99 script error
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

const EXPECTED_TOTAL = 18;
const EXPECTED_GROUP_A = 7;
const EXPECTED_GROUP_B = 11;

// ── Args ────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    mode: "dry-run",
    outPath: "./audits/spec-3-cluster-3/migration-plan.json",
    today: null,
  };
  let modeFlag = null;
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") {
      if (modeFlag && modeFlag !== "--dry-run") throw new Error("--dry-run and --execute are mutually exclusive");
      modeFlag = "--dry-run";
      out.mode = "dry-run";
    } else if (arg === "--execute") {
      if (modeFlag && modeFlag !== "--execute") throw new Error("--dry-run and --execute are mutually exclusive");
      modeFlag = "--execute";
      out.mode = "execute";
    } else if (arg.startsWith("--out=")) {
      out.outPath = arg.slice("--out=".length);
    } else if (arg.startsWith("--today=")) {
      out.today = arg.slice("--today=".length);
    }
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

// ── Section printers ─────────────────────────────────────────
function printSection(title) {
  console.log("\n=== " + title + " ===");
}

// ── ID minting ───────────────────────────────────────────────
// Inlined from src/utils/helpers.js (uid). 8-char base36 lowercase
// alphanumeric. Math.random().toString(36).slice(2, 10) can produce
// strings shorter than 8 chars when the random value lacks fractional
// digits — pad to 8 to keep IDs consistent with the existing JSONB
// lesson-ID format observed in production.
function mintId(usedIds) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
  throw new Error("mintId: 16 collisions in a row — RNG issue");
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

  console.log("Spec 3 cluster 3 — catchups migration (" + args.mode + ")");
  console.log("today:    " + today);
  console.log("out:      " + args.outPath);

  const email = await promptStdin("Email:    ", { echo: true });
  const password = await promptStdin("Password: ", { echo: false });

  const { error: authErr } = await supabase.auth.signInWithPassword({ email, password });
  if (authErr) {
    console.error("auth failed");
    process.exit(1);
  }

  let exitCode = 0;
  try {
    // ── Resolve authenticated user id ────────────────────────
    // catchups.user_id is NOT NULL with RLS WITH CHECK (auth.uid() =
    // user_id), so every insert payload must carry the authed user's
    // id. Resolved once here and threaded through buildCard's target.
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user?.id) {
      throw new Error("Failed to resolve authenticated user id — cannot proceed with --execute");
    }
    const authedUserId = userData.user.id;
    console.log(`auth ok — user_id resolved.`);

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
    const wadjAll    = await bulk("weekly_adjustments");
    const tallyAll   = await bulk("tally_entries");
    const enrolments = await bulk("enrolments");
    const schools    = await bulk("schools");

    // ── Lookup indices ───────────────────────────────────────
    const tallyById = new Map();
    for (const t of tallyAll) tallyById.set(t.id, t);

    const enrolmentById = new Map();
    for (const e of enrolments) enrolmentById.set(e.id, e);

    const schoolNameById = new Map();
    for (const s of schools) schoolNameById.set(s.id, s.name || s.id);

    function schoolAcronym(schoolId) {
      if (!schoolId) return "(none)";
      if (schoolId === "__catchup__") return "__catchup__";
      const name = schoolNameById.get(schoolId) || schoolId;
      return name.split(/\s+/).map(w => w[0] || "").join("").slice(0, 6).toUpperCase() || schoolId;
    }

    function findActiveEnrolment(studentId, instrument) {
      return enrolments.find(e =>
        e.student_id === studentId &&
        e.instrument === instrument &&
        (e.end_date === null || e.end_date === undefined)
      ) || null;
    }

    // missed[] match: row matching (week_key, school_id), entry
    // matching (studentId, instrument).
    function findMissedMatch(weekKey, schoolId, studentId, instrument) {
      const row = wadjAll.find(r => r.week_key === weekKey && r.school_id === schoolId);
      if (!row) return null;
      const missed = Array.isArray(row.missed) ? row.missed : [];
      const match = missed.find(m => m && m.studentId === studentId && m.instrument === instrument);
      return match || null;
    }

    // ── Source extraction ────────────────────────────────────
    printSection("SOURCE EXTRACTION");
    const groupA = []; // { parentRow, lesson }
    const groupB = [];
    for (const r of wadjAll) {
      const lessons = Array.isArray(r.lessons) ? r.lessons : [];
      if (r.school_id === "__catchup__") {
        for (const l of lessons) {
          if (l) groupA.push({ parentRow: r, lesson: l });
        }
      } else {
        for (const l of lessons) {
          if (l && l.isMakeup === true) {
            groupB.push({ parentRow: r, lesson: l });
          }
        }
      }
    }
    const observedTotal = groupA.length + groupB.length;
    const groupARowIds = new Set(groupA.map(c => c.parentRow.id));
    const groupBRowIds = new Set(groupB.map(c => c.parentRow.id));
    console.log(`  Group A (__catchup__ rows)        : ${groupA.length} cards across ${groupARowIds.size} row(s)`);
    console.log(`  Group B (regular WTT isMakeup)    : ${groupB.length} cards across ${groupBRowIds.size} row(s)`);
    console.log(`  Total observed                    : ${observedTotal}`);

    // ── Section 1: Pre-flight summary ────────────────────────
    printSection("SECTION 1 — PRE-FLIGHT SUMMARY");
    console.log(`  weekly_adjustments rows : ${wadjAll.length}`);
    console.log(`  tally_entries rows      : ${tallyAll.length}`);
    console.log(`  enrolments rows         : ${enrolments.length}`);
    console.log(`  schools rows            : ${schools.length}`);
    console.log(``);
    console.log(`  expected total / A / B  : ${EXPECTED_TOTAL} / ${EXPECTED_GROUP_A} / ${EXPECTED_GROUP_B}`);
    console.log(`  observed total / A / B  : ${observedTotal} / ${groupA.length} / ${groupB.length}`);
    const driftTotal = observedTotal !== EXPECTED_TOTAL;
    const driftA = groupA.length !== EXPECTED_GROUP_A;
    const driftB = groupB.length !== EXPECTED_GROUP_B;
    if (driftTotal || driftA || driftB) {
      console.log(`  *** DRIFT FROM BASELINE — script proceeds with all observed cards ***`);
      if (driftTotal) console.log(`     total drift:   expected ${EXPECTED_TOTAL}, observed ${observedTotal}`);
      if (driftA)     console.log(`     group A drift: expected ${EXPECTED_GROUP_A}, observed ${groupA.length}`);
      if (driftB)     console.log(`     group B drift: expected ${EXPECTED_GROUP_B}, observed ${groupB.length}`);
    } else {
      console.log(`  no drift — counts match Phase 0 baseline.`);
    }

    // ── Per-card target computation ──────────────────────────
    const usedIds = new Set();
    const cards = [];
    let droppedTeacherId = 0;
    let droppedTeacherName = 0;
    let droppedSwap = 0;

    function buildCard(group, parentRow, lesson) {
      // Stamped-field drop accounting (V4 reversal).
      const drops = { teacherId: 0, teacherName: 0, swap: 0 };
      if (lesson.teacherId)        drops.teacherId   = 1;
      if (lesson.teacherName)      drops.teacherName = 1;
      if (lesson.__swapTeacherId || lesson._swapTeacherId || lesson._swapTeacherName) drops.swap = 1;

      // enrolment_id sanity (ABORT if absent).
      if (!lesson.enrolmentId) {
        const err = new Error(`card missing enrolmentId — group=${group} weekKey=${parentRow.week_key} parentRowId=${parentRow.id} lesson.id=${lesson.id || "?"}`);
        err.kind = "missing_enrolment_id";
        throw err;
      }
      const enrolment = enrolmentById.get(lesson.enrolmentId);
      if (!enrolment) {
        const err = new Error(`enrolment ${lesson.enrolmentId} not found in enrolments bulk — group=${group} weekKey=${parentRow.week_key}`);
        err.kind = "enrolment_not_found";
        throw err;
      }

      // Tally lookup (if linked).
      const tallyId = lesson.makeupForTallyId || null;
      const tally = tallyId ? (tallyById.get(tallyId) || null) : null;

      // school_id determination.
      // Group A: primary path is the linked tally entry's school_id.
      // When the primary tally lookup fails (deleted entry, etc.), fall
      // back to any other tally entry matching (student_id, instrument)
      // — student/instrument is unique enough at the school level that
      // another row's school_id is the right answer.
      // Group B: parent row's school_id directly.
      let schoolId, schoolIdSource;
      if (group === "A") {
        if (tally && tally.school_id) {
          schoolId = tally.school_id;
          schoolIdSource = "tally.school_id";
        } else {
          const fallbackTally = tallyAll.find(t =>
            t.student_id === lesson.studentId &&
            t.instrument === lesson.instrument &&
            t.school_id
          );
          if (fallbackTally) {
            schoolId = fallbackTally.school_id;
            schoolIdSource = "fallback_via_student_instrument";
          } else {
            schoolId = null;
            schoolIdSource = "tally-not-found / null";
          }
        }
      } else {
        schoolId = parentRow.school_id;
        schoolIdSource = "parent_row.school_id";
      }

      // resolves_* derivation.
      // Orphan = !tallyFound || !missedMatched. The matched missed[] entry
      // can have a missing `start` field — that's an informational note on
      // the row, NOT an orphan condition.
      const tallyFound = !!tally;
      let missedMatched = false;
      let originalTimeMissing = false;
      let resolvesEnrolmentId = null;
      let resolvesWeekKey = null;
      let resolvesOriginalDay = null;
      let resolvesOriginalTime = null;
      let linkageNote;
      if (tally) {
        resolvesEnrolmentId = lesson.enrolmentId;
        resolvesWeekKey = tally.week_key || null;
        const missed = findMissedMatch(tally.week_key, tally.school_id, tally.student_id, tally.instrument);
        if (missed) {
          missedMatched = true;
          resolvesOriginalDay = missed.day || null;
          resolvesOriginalTime = missed.start || null;
          if (!resolvesOriginalTime) originalTimeMissing = true;
          linkageNote = `tally found (${tallyId}); missed[] matched in (${tally.week_key}, ${tally.school_id})`
            + (originalTimeMissing ? "; original time missing on source missed[] entry" : "");
        } else {
          linkageNote = `tally found (${tallyId}) BUT no matching missed[] row — resolves_original_day/time null`;
        }
      } else {
        if (tallyId) {
          linkageNote = `tally lookup miss (${tallyId}) — unlinked Holiday Lesson candidate`;
        } else {
          linkageNote = `no makeupForTallyId on card — unlinked Holiday Lesson candidate`;
        }
      }

      const isOrphan = !tallyFound || !missedMatched;
      const flags = [];
      if (isOrphan) flags.push("orphan");
      if (enrolment.end_date) flags.push("enrolment-ended");

      // Enrolment drift: (studentId, instrument) → active enrolment
      // should match lesson.enrolmentId.
      const activeMatch = findActiveEnrolment(lesson.studentId, lesson.instrument);
      if (activeMatch && activeMatch.id !== lesson.enrolmentId) {
        flags.push("enrolment-drift");
      }

      // Mint id (collision-checked).
      const id = mintId(usedIds);

      const target = {
        id,
        user_id: authedUserId,
        school_id: schoolId,
        week_key: parentRow.week_key || "",
        day: lesson.day || "",
        time: lesson.start || "",
        duration_minutes: null,
        instrument: lesson.instrument || "",
        enrolment_id: lesson.enrolmentId,
        resolves_enrolment_id: resolvesEnrolmentId,
        resolves_week_key: resolvesWeekKey,
        resolves_original_day: resolvesOriginalDay,
        resolves_original_time: resolvesOriginalTime,
        made_up: false,
        notes: originalTimeMissing
          ? "missed[] matched but original time missing on source card"
          : null,
      };

      const orphanReason =
        flags.includes("orphan")
          ? (tally
              ? "missed[] not matched"
              : (tallyId ? "tally-not-found" : "no-makeupForTallyId"))
          : null;

      droppedTeacherId   += drops.teacherId;
      droppedTeacherName += drops.teacherName;
      droppedSwap        += drops.swap;

      return {
        group,
        source: {
          parent_row_id: parentRow.id,
          parent_week_key: parentRow.week_key,
          parent_school_id: parentRow.school_id,
          lesson,
        },
        target,
        linkage: {
          tally_id: tallyId,
          tally_found: tallyFound,
          tally_week_key: tally ? tally.week_key : null,
          missed_matched: missedMatched,
          school_id_source: schoolIdSource,
          note: linkageNote,
        },
        flags: {
          orphan: flags.includes("orphan"),
          orphan_reason: orphanReason,
          enrolment_ended: flags.includes("enrolment-ended"),
          enrolment_drift: flags.includes("enrolment-drift"),
          dropped_stamps: drops,
        },
      };
    }

    // Build all cards. Abort on missing enrolmentId / unresolvable enrolment.
    try {
      for (const c of groupA) cards.push(buildCard("A", c.parentRow, c.lesson));
      for (const c of groupB) cards.push(buildCard("B", c.parentRow, c.lesson));
    } catch (e) {
      console.error(`\n*** ABORT during card build: ${e.kind || "unknown"} ***`);
      console.error(`    ${e.message}`);
      throw e;
    }

    // Order cards by (group, week_key, day, time).
    const dayOrder = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5 };
    cards.sort((a, b) => {
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      if (a.target.week_key !== b.target.week_key) return a.target.week_key.localeCompare(b.target.week_key);
      const ad = dayOrder[a.target.day] || 9;
      const bd = dayOrder[b.target.day] || 9;
      if (ad !== bd) return ad - bd;
      return a.target.time.localeCompare(b.target.time);
    });

    // ── Section 2: Per-card blocks ───────────────────────────
    printSection("SECTION 2 — PER-CARD BLOCKS");
    const targetCols = [
      "id", "school_id", "week_key", "day", "time", "duration_minutes",
      "instrument", "enrolment_id", "resolves_enrolment_id", "resolves_week_key",
      "resolves_original_day", "resolves_original_time", "made_up", "notes",
    ];
    cards.forEach((c, idx) => {
      console.log(`\n  ── Card ${idx + 1} / ${cards.length} ── group=${c.group} (${schoolAcronym(c.target.school_id)}) ──`);
      console.log(`    SOURCE:`);
      console.log(`      parent_row.id:        ${c.source.parent_row_id}`);
      console.log(`      parent_row.week_key:  ${c.source.parent_week_key}`);
      console.log(`      parent_row.school_id: ${c.source.parent_school_id}`);
      console.log(`      lesson: ${JSON.stringify(c.source.lesson)}`);
      console.log(`    TARGET (catchups row):`);
      for (const col of targetCols) {
        const v = c.target[col];
        const display = v === null ? "null" : (typeof v === "string" ? `"${v}"` : String(v));
        console.log(`      ${col.padEnd(24)} : ${display}`);
      }
      console.log(`    LINKAGE:`);
      console.log(`      tally_id:        ${c.linkage.tally_id || "(none)"}`);
      console.log(`      tally_found:     ${c.linkage.tally_found}`);
      console.log(`      tally_week_key:  ${c.linkage.tally_week_key || "(n/a)"}`);
      console.log(`      missed_matched:  ${c.linkage.missed_matched}`);
      console.log(`      school_id_src:   ${c.linkage.school_id_source}`);
      console.log(`      note:            ${c.linkage.note}`);
      console.log(`    FLAGS:`);
      console.log(`      orphan:          ${c.flags.orphan}${c.flags.orphan_reason ? ` (${c.flags.orphan_reason})` : ""}`);
      console.log(`      enrolment_ended: ${c.flags.enrolment_ended}`);
      console.log(`      enrolment_drift: ${c.flags.enrolment_drift}`);
      console.log(`      dropped_stamps:  teacherId=${c.flags.dropped_stamps.teacherId} teacherName=${c.flags.dropped_stamps.teacherName} swap=${c.flags.dropped_stamps.swap}`);
    });

    // ── Section 3: Summary ───────────────────────────────────
    printSection("SECTION 3 — SUMMARY");
    const linkedCount = cards.filter(c => !c.flags.orphan).length;
    const orphanCount = cards.length - linkedCount;
    const enrolmentEndedCount = cards.filter(c => c.flags.enrolment_ended).length;
    const enrolmentDriftCount = cards.filter(c => c.flags.enrolment_drift).length;
    console.log(`  total cards            : ${cards.length}`);
    console.log(`  linked / orphan        : ${linkedCount} / ${orphanCount}`);
    console.log(`  dropped teacherId      : ${droppedTeacherId}`);
    console.log(`  dropped teacherName    : ${droppedTeacherName}`);
    console.log(`  dropped _swap*         : ${droppedSwap}`);
    console.log(`  enrolment_ended flag   : ${enrolmentEndedCount}`);
    console.log(`  enrolment_drift flag   : ${enrolmentDriftCount}`);
    if (orphanCount > 0) {
      console.log(`\n  Orphan breakdown:`);
      const byReason = {};
      for (const c of cards) {
        if (!c.flags.orphan) continue;
        const r = c.flags.orphan_reason || "unknown";
        byReason[r] = (byReason[r] || 0) + 1;
      }
      for (const [r, n] of Object.entries(byReason)) {
        console.log(`    ${r.padEnd(28)} : ${n}`);
      }
    }

    // ── Write migration plan JSON ────────────────────────────
    printSection("WRITING MIGRATION PLAN");
    const outDir = path.dirname(args.outPath);
    if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const plan = {
      runMeta: {
        today,
        generatedAt: new Date().toISOString(),
        supabaseUrl: SUPABASE_URL,
        mode: args.mode,
        baseline_version: "spec-3-phase-0-v1",
      },
      expected: { total: EXPECTED_TOTAL, group_a: EXPECTED_GROUP_A, group_b: EXPECTED_GROUP_B },
      observed: { total: observedTotal, group_a: groupA.length, group_b: groupB.length },
      cards,
      summary: {
        linked_count: linkedCount,
        orphan_count: orphanCount,
        dropped_teacherid: droppedTeacherId,
        dropped_teachername: droppedTeacherName,
        dropped_swap: droppedSwap,
        enrolment_ended_count: enrolmentEndedCount,
        enrolment_drift_count: enrolmentDriftCount,
      },
    };
    fs.writeFileSync(args.outPath, JSON.stringify(plan, null, 2));
    console.log(`  wrote ${args.outPath}`);

    // ── Execute branch (cluster 3b — DO NOT RUN THIS DISPATCH) ─
    if (args.mode === "execute") {
      printSection("EXECUTE — pre-flight catchups table check");
      const { data: existing, error: existingErr } = await supabase
        .from("catchups")
        .select("id", { count: "exact", head: false })
        .range(0, BULK_RANGE_MAX);
      if (existingErr) throw new Error("catchups pre-flight read failed");
      if (existing.length > 0) {
        console.error(`  STOP — catchups table non-empty (${existing.length} row(s)). Run \`DELETE FROM catchups;\` in Supabase dashboard before retry.`);
        exitCode = 2;
        return;
      }
      console.log("  catchups empty — proceeding with inserts.");
      printSection("EXECUTE — inserting rows");
      let inserted = 0;
      for (const c of cards) {
        const { error: insErr } = await supabase.from("catchups").insert(c.target);
        if (insErr) {
          console.error(`  INSERT FAILED on card ${inserted + 1} / ${cards.length} (id=${c.target.id}, week_key=${c.target.week_key}, day=${c.target.day}, time=${c.target.time})`);
          console.error(`  ERROR:   ${insErr.message ?? "(none)"}`);
          console.error(`  CODE:    ${insErr.code ?? "(none)"}`);
          console.error(`  DETAILS: ${insErr.details ?? "(none)"}`);
          console.error(`  HINT:    ${insErr.hint ?? "(none)"}`);
          console.error(`  STOP — partial state (${inserted} row(s) written). Run \`DELETE FROM catchups;\` in dashboard before retry.`);
          exitCode = 2;
          return;
        }
        inserted++;
      }
      console.log(`  successfully inserted ${inserted} row(s) into catchups.`);
    } else {
      console.log("\n  Dry-run complete. No writes to catchups. Review migration-plan.json before running --execute.");
    }
  } catch (e) {
    console.error("query failed:", e?.message ?? "unknown stage");
    if (exitCode === 0) exitCode = 2;
  } finally {
    await supabase.auth.signOut().catch(() => {});
  }

  process.exit(exitCode);
}

main().catch(() => {
  console.error("script error");
  process.exit(99);
});
