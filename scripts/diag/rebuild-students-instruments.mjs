// ============================================================
// scripts/diag/rebuild-students-instruments.mjs
//
// Phase 1 repair script for `students.instruments[]` corruption
// caused by the Phase 3 Spec 1 migration (Commit 3, sessions
// 104/105). Rebuilds each student's instruments array from
// their currently-active enrolments.
//
// Modes:
//   node rebuild-students-instruments.mjs            → DRY-RUN
//   node rebuild-students-instruments.mjs --write    → DRY-RUN
//                                                       then prompt
//                                                       "WRITE" to
//                                                       commit
//
// Same auth pattern as the other diag scripts:
//   - URL + publishable key copied from src/supabaseClient.js
//   - Interactive login: email echoed, password masked
//   - persistSession: false
//   - signOut() in finally
//   - Generic error messages
//
// Proposed shape per enrolment (drops fields not in the v2.3.4
// students.instruments shape):
//   { name: e.instrument, teacherId: e.teacher_id, isGroup: e.is_group }
//
// Canary: Oscar Pascoe (id d8se4h2u) is the only pre-existing
// non-empty row. He's classified SKIP_HAS_DATA and never written.
// Post-write, we re-read his row and verify it didn't change.
// ============================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://eoexqzxrdegyazglpzrv.supabase.co";
const SUPABASE_KEY = "sb_publishable_t8NIXquR2txP16eigi37Jw_GszCNStY";

const BULK_RANGE_MAX = 9999;
const OSCAR_ID = "d8se4h2u";

const CTRL_C = String.fromCharCode(3);
const DEL    = String.fromCharCode(127);
const BACK   = String.fromCharCode(8);

// ── Stdin prompt (echo on for email/confirm, off for password) ──
function promptStdin(prompt, { echo }) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("not a TTY — refusing to read input non-interactively"));
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

// Active enrolment = end_date null/undefined/empty string
const isActive = (e) =>
  e.end_date === null || e.end_date === undefined || e.end_date === "";

// Empty FK = null/undefined/empty string
const isEmptyId = (v) => v === null || v === undefined || v === "";

// Canonical-key JSON for order-insensitive deep equality
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v).sort().map((k) => [k, canonical(v[k])])
    );
  }
  return v;
}
const deepEq = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Build the v2.3.4 instruments entry from one enrolment row
const buildInstrumentEntry = (e) => ({
  name:      e.instrument,
  teacherId: e.teacher_id,
  isGroup:   e.is_group,
});

async function main() {
  const args = process.argv.slice(2);
  const writeMode = args.includes("--write");

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  // 1. Sign in
  const email = await promptStdin("Email: ", { echo: true });
  const password = await promptStdin("Password: ", { echo: false });

  const { error: authErr } = await supabase.auth.signInWithPassword({ email, password });
  if (authErr) {
    console.error("auth failed");
    process.exit(1);
  }

  let exitCode = 0;
  try {
    // 2. Fetch all students and all enrolments
    const { data: students, error: stErr } = await supabase
      .from("students")
      .select("*")
      .range(0, BULK_RANGE_MAX);
    if (stErr) throw new Error("students fetch failed");
    if (students.length > BULK_RANGE_MAX - 1) {
      console.warn("warning: students fetch hit the bulk cap; data may be truncated");
    }

    const { data: enrolmentsAll, error: enErr } = await supabase
      .from("enrolments")
      .select("*")
      .order("student_id", { ascending: true })
      .order("instrument", { ascending: true })
      .range(0, BULK_RANGE_MAX);
    if (enErr) throw new Error("enrolments fetch failed");
    if (enrolmentsAll.length > BULK_RANGE_MAX - 1) {
      console.warn("warning: enrolments fetch hit the bulk cap; data may be truncated");
    }

    const enrolments = enrolmentsAll.filter(isActive);

    // 3. Capture Oscar's original instruments value (canary)
    const oscar = students.find((s) => s.id === OSCAR_ID);
    const oscarOriginalInstruments = oscar ? oscar.instruments : null;

    // 4. Group active enrolments by student_id
    const enrByStudent = new Map();
    for (const e of enrolments) {
      if (!enrByStudent.has(e.student_id)) enrByStudent.set(e.student_id, []);
      enrByStudent.get(e.student_id).push(e);
    }

    // 5. Detect anomalies (still rebuilt — just flagged)
    const studentName = (id) => {
      const s = students.find((x) => x.id === id);
      return s ? s.name : "(orphan — no student)";
    };
    const anomNullTeacher = enrolments.filter((e) => isEmptyId(e.teacher_id));
    const anomGroupNullGid = enrolments.filter(
      (e) => e.is_group === true && isEmptyId(e.group_id)
    );

    // 6. Classify each student
    const skipHasData = [];
    const skipNoEnrolments = [];
    const rebuild = [];
    for (const s of students) {
      const has = Array.isArray(s.instruments) && s.instruments.length > 0;
      const list = enrByStudent.get(s.id) || [];
      if (has) {
        skipHasData.push({ student: s });
      } else if (list.length === 0) {
        skipNoEnrolments.push({ student: s });
      } else {
        const proposed = list.map(buildInstrumentEntry);
        rebuild.push({ student: s, enrolments: list, proposed });
      }
    }

    // ── DRY-RUN OUTPUT ──────────────────────────────────────
    console.log("=== ANOMALIES (do not block rebuild — flagged for review) ===");
    if (anomNullTeacher.length === 0 && anomGroupNullGid.length === 0) {
      console.log("(none)");
    }
    for (const e of anomNullTeacher) {
      console.log("ANOMALY: enrolment with null/empty teacher_id");
      console.log("  enrolment: " + JSON.stringify(e));
      console.log("  belongs to student: id=" + e.student_id + ", name=" + JSON.stringify(studentName(e.student_id)));
    }
    for (const e of anomGroupNullGid) {
      console.log("ANOMALY: enrolment with is_group=true and null/empty group_id");
      console.log("  enrolment: " + JSON.stringify(e));
      console.log("  belongs to student: id=" + e.student_id + ", name=" + JSON.stringify(studentName(e.student_id)));
    }

    console.log("\n=== SKIP_HAS_DATA (already populated, will not touch) ===");
    console.log("count: " + skipHasData.length);
    for (const { student: s } of skipHasData) {
      console.log(
        "- id=" + s.id +
        ", name=" + JSON.stringify(s.name) +
        ", current=" + JSON.stringify(s.instruments) +
        ", action=skip — already has data"
      );
    }

    console.log("\n=== SKIP_NO_ENROLMENTS (no active enrolments to rebuild from) ===");
    console.log("count: " + skipNoEnrolments.length);
    for (const { student: s } of skipNoEnrolments) {
      console.log(
        "- id=" + s.id +
        ", name=" + JSON.stringify(s.name) +
        ", status=" + JSON.stringify(s.status) +
        ", action=skip — nothing to rebuild from"
      );
    }

    console.log("\n=== REBUILD (will overwrite empty instruments[] with derived value) ===");
    console.log("count: " + rebuild.length);
    for (const { student: s, proposed } of rebuild) {
      console.log(
        "- id=" + s.id +
        ", name=" + JSON.stringify(s.name) +
        ", current=" + JSON.stringify(s.instruments) +
        ", proposed (" + proposed.length + " items)=" + JSON.stringify(proposed)
      );
    }

    const totalEnrolmentsInPlan = rebuild.reduce((sum, r) => sum + r.enrolments.length, 0);
    console.log("\n=== SUMMARY ===");
    console.log("SKIP_HAS_DATA       : " + skipHasData.length);
    console.log("SKIP_NO_ENROLMENTS  : " + skipNoEnrolments.length);
    console.log("REBUILD             : " + rebuild.length);
    console.log("total students      : " + students.length);
    console.log("active enrolments   : " + enrolments.length);
    console.log("enrolments in plan  : " + totalEnrolmentsInPlan);
    console.log("anomalies (null teacher_id) : " + anomNullTeacher.length);
    console.log("anomalies (is_group + null group_id) : " + anomGroupNullGid.length);
    if (!oscar) {
      console.log("WARNING: canary student (Oscar Pascoe, id " + OSCAR_ID + ") NOT FOUND in initial fetch");
    }

    // ── WRITE PATH (only if --write AND user types WRITE) ──
    if (!writeMode) {
      console.log("\n(dry-run only — pass --write to perform updates)");
      return;
    }

    if (rebuild.length === 0) {
      console.log("\nNo REBUILD entries — nothing to write. Exiting.");
      return;
    }

    if (!oscar) {
      console.log("\nRefusing to --write because canary (Oscar) was not found. Investigate first.");
      exitCode = 3;
      return;
    }

    const expectedNonEmptyAfter = skipHasData.length + rebuild.length;
    console.log("\n=== WRITE CONFIRMATION ===");
    console.log("About to update " + rebuild.length + " students (one .update() per id).");
    console.log("Currently populated rows : " + skipHasData.length);
    console.log("Expected populated after : " + expectedNonEmptyAfter);
    console.log("Canary (Oscar, id " + OSCAR_ID + ") will be skipped and verified after.");
    const ans = await promptStdin(
      'Type WRITE (uppercase, exact match, no spaces) to proceed, anything else to abort: ',
      { echo: true }
    );
    if (ans !== "WRITE") {
      console.log("aborted — no writes performed");
      return;
    }

    // ── Perform updates ─────────────────────────────────────
    console.log("\n=== APPLYING UPDATES ===");
    const failures = [];
    for (const { student: s, proposed } of rebuild) {
      const { error } = await supabase
        .from("students")
        .update({ instruments: proposed })
        .eq("id", s.id);
      if (error) {
        failures.push({ id: s.id, name: s.name });
        console.log("FAILED  id=" + s.id + " name=" + JSON.stringify(s.name) + " (update returned an error)");
      } else {
        console.log("updated id=" + s.id + " name=" + JSON.stringify(s.name) + " (" + proposed.length + " instruments)");
      }
    }
    console.log("update loop complete: " + (rebuild.length - failures.length) + " ok, " + failures.length + " failed");

    // ── Verification: count check ───────────────────────────
    console.log("\n=== POST-WRITE COUNT VERIFICATION ===");
    const { data: studentsAfter, error: vErr } = await supabase
      .from("students")
      .select("id,instruments")
      .range(0, BULK_RANGE_MAX);
    if (vErr) {
      console.log("verification FAILED — could not re-fetch students");
      exitCode = 4;
    } else {
      const populated = (studentsAfter || []).filter(
        (s) => Array.isArray(s.instruments) && s.instruments.length > 0
      ).length;
      console.log("populated rows after writes: " + populated);
      console.log("expected                    : " + expectedNonEmptyAfter);
      if (populated === expectedNonEmptyAfter) {
        console.log("verification PASSED");
      } else {
        console.log("verification FAILED — mismatch");
        exitCode = 4;
      }
    }

    // ── Canary verification: Oscar's row unchanged ──────────
    console.log("\n=== POST-WRITE CANARY CHECK (Oscar Pascoe, id " + OSCAR_ID + ") ===");
    const { data: oscarAfter, error: oErr } = await supabase
      .from("students")
      .select("id,name,instruments")
      .eq("id", OSCAR_ID)
      .maybeSingle();
    if (oErr || !oscarAfter) {
      console.log("canary FAILED — could not re-fetch Oscar's row");
      exitCode = 5;
    } else {
      console.log("Oscar's instruments BEFORE writes : " + JSON.stringify(oscarOriginalInstruments));
      console.log("Oscar's instruments AFTER writes  : " + JSON.stringify(oscarAfter.instruments));
      if (deepEq(oscarOriginalInstruments, oscarAfter.instruments)) {
        console.log("canary PASSED — Oscar's row was not modified");
      } else {
        console.log("canary FAILED — Oscar's row CHANGED");
        exitCode = 5;
      }
    }

    if (failures.length > 0) {
      console.log("\nNote: " + failures.length + " update(s) failed — see APPLYING UPDATES section above");
      exitCode = exitCode || 6;
    }
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
