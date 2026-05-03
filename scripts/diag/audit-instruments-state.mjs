// ============================================================
// scripts/diag/audit-instruments-state.mjs
//
// READ-ONLY diagnostic, second pass — wider inventory of the
// students / enrolments / teachers / groups tables to scope
// any future repair of `students.instruments[]`.
//
// Auth pattern is identical to inspect-students-enrolments.mjs:
//   - URL + publishable key copied from src/supabaseClient.js
//   - Interactive login: email echoed, password masked
//   - persistSession: false (token never written to disk)
//   - signOut() in finally
//   - Generic error messages (no err.message bubbling)
//
// PK shapes for FK checks (verified against the existing app
// loaders before writing this script):
//   teachers.id  ←→ enrolments.teacher_id   (both string)
//   groups.id    ←→ enrolments.group_id     (both string)
// ============================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://eoexqzxrdegyazglpzrv.supabase.co";
const SUPABASE_KEY = "sb_publishable_t8NIXquR2txP16eigi37Jw_GszCNStY";

// Defensive cap on bulk reads — Supabase silently truncates at 1000 by default.
const BULK_RANGE_MAX = 9999;

// Control characters used during raw-mode stdin reads
const CTRL_C = String.fromCharCode(3);
const DEL    = String.fromCharCode(127);
const BACK   = String.fromCharCode(8);

// ── Stdin prompt (echo on for email, off for password) ───────
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

// "Active" enrolment = end_date is null or empty string
const isActive = (e) => e.end_date === null || e.end_date === undefined || e.end_date === "";

// "Empty" foreign key = null or empty string
const isEmptyId = (v) => v === null || v === undefined || v === "";

async function main() {
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
    // ── Bulk fetch tables we need up-front ───────────────────
    const { data: students, error: stErr } = await supabase
      .from("students").select("*").range(0, BULK_RANGE_MAX);
    if (stErr) throw new Error("students fetch failed");
    if (students.length > BULK_RANGE_MAX - 1) {
      console.warn("warning: students fetch hit the bulk cap; counts may be truncated");
    }

    const { data: enrolments, error: enErr } = await supabase
      .from("enrolments").select("*").range(0, BULK_RANGE_MAX);
    if (enErr) throw new Error("enrolments fetch failed");
    if (enrolments.length > BULK_RANGE_MAX - 1) {
      console.warn("warning: enrolments fetch hit the bulk cap; counts may be truncated");
    }

    // teachers / groups: probe-and-skip if RLS or schema blocks us
    let teacherIds = null;
    let teachersSkipReason = null;
    {
      const { data: t, error } = await supabase
        .from("teachers").select("id").range(0, BULK_RANGE_MAX);
      if (error) {
        teachersSkipReason = "teachers table not readable";
      } else {
        teacherIds = new Set((t || []).map((r) => r.id));
      }
    }

    let groupIds = null;
    let groupsSkipReason = null;
    {
      const { data: g, error } = await supabase
        .from("groups").select("id").range(0, BULK_RANGE_MAX);
      if (error) {
        groupsSkipReason = "groups table not readable";
      } else {
        groupIds = new Set((g || []).map((r) => r.id));
      }
    }

    // ── SECTION 1: instruments-array shape buckets ───────────
    let bEmpty = 0, bNull = 0, bNonEmpty = 0, bWeird = 0;
    const weirdSamples = [];
    for (const s of students) {
      const v = s.instruments;
      if (v === null || v === undefined) {
        bNull++;
      } else if (Array.isArray(v)) {
        if (v.length === 0) bEmpty++;
        else bNonEmpty++;
      } else {
        bWeird++;
        if (weirdSamples.length < 10) {
          weirdSamples.push({ id: s.id, name: s.name, instruments: v });
        }
      }
    }
    console.log("=== SECTION 1: students.instruments shape ===");
    console.log("empty array []           : " + bEmpty);
    console.log("null/undefined           : " + bNull);
    console.log("array with 1+ items      : " + bNonEmpty);
    console.log("not an array (weird)     : " + bWeird);
    console.log("total students           : " + students.length);
    if (weirdSamples.length > 0) {
      console.log("weird samples (up to 10):");
      for (const s of weirdSamples) console.log("  " + JSON.stringify(s));
    }

    // ── SECTION 2: full list of students with non-empty instruments
    console.log("\n=== SECTION 2: students with non-empty instruments ===");
    const nonEmpty = students.filter(
      (s) => Array.isArray(s.instruments) && s.instruments.length > 0
    );
    console.log("count: " + nonEmpty.length);
    for (const s of nonEmpty) {
      console.log(
        "- id=" + s.id +
        ", name=" + JSON.stringify(s.name) +
        ", instruments=" + JSON.stringify(s.instruments)
      );
    }

    // ── SECTION 3: enrolments by end_date ────────────────────
    const active = enrolments.filter(isActive);
    const ended = enrolments.filter((e) => !isActive(e));
    console.log("\n=== SECTION 3: enrolments by end_date ===");
    console.log("active (end_date null/empty): " + active.length);
    console.log("ended  (end_date set)       : " + ended.length);
    console.log("total enrolments            : " + enrolments.length);

    // ── SECTION 4: students with zero active enrolments ──────
    const studentsWithActive = new Set(active.map((e) => e.student_id));
    const zeroActive = students
      .filter((s) => !studentsWithActive.has(s.id))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    console.log("\n=== SECTION 4: students with ZERO active enrolments (sorted by name) ===");
    console.log("count: " + zeroActive.length);
    for (const s of zeroActive) {
      console.log(
        "- id=" + s.id +
        ", name=" + JSON.stringify(s.name) +
        ", status=" + JSON.stringify(s.status) +
        ", school_id=" + JSON.stringify(s.school_id) +
        ", class_name=" + JSON.stringify(s.class_name)
      );
    }

    // ── SECTION 5: histogram of active enrolments per student ──
    const perStudent = new Map();
    for (const s of students) perStudent.set(s.id, 0);
    for (const e of active) {
      if (perStudent.has(e.student_id)) {
        perStudent.set(e.student_id, perStudent.get(e.student_id) + 1);
      }
      // orphans handled in section 6
    }
    const histogram = new Map();
    for (const c of perStudent.values()) {
      histogram.set(c, (histogram.get(c) || 0) + 1);
    }
    const buckets = [...histogram.keys()].sort((a, b) => a - b);
    console.log("\n=== SECTION 5: active-enrolment count histogram ===");
    for (const k of buckets) {
      console.log(
        k + " enrolment" + (k === 1 ? "" : "s") + ": " + histogram.get(k) + " students"
      );
    }

    // ── SECTION 6: orphan enrolments ─────────────────────────
    const studentIdSet = new Set(students.map((s) => s.id));
    const orphans = enrolments.filter((e) => !studentIdSet.has(e.student_id));
    console.log("\n=== SECTION 6: orphan enrolments (student_id not in students) ===");
    console.log("count: " + orphans.length);
    for (const e of orphans) console.log(JSON.stringify(e));

    // ── SECTION 7: FK sanity ─────────────────────────────────
    console.log("\n=== SECTION 7: FK sanity ===");

    const teacherIdNull = enrolments.filter((e) => isEmptyId(e.teacher_id)).length;
    console.log("teacher_id null/empty                     : " + teacherIdNull);

    if (teachersSkipReason) {
      console.log("teacher_id missing-in-teachers check     : skipped (" + teachersSkipReason + ")");
    } else {
      const missingTeacher = enrolments.filter(
        (e) => !isEmptyId(e.teacher_id) && !teacherIds.has(e.teacher_id)
      );
      console.log(
        "teacher_id set but not in teachers       : " + missingTeacher.length +
        " (teachers PK = `id`, " + teacherIds.size + " teachers loaded)"
      );
      for (const e of missingTeacher) console.log("  " + JSON.stringify(e));
    }

    const groupTrueNullGid = enrolments.filter(
      (e) => e.is_group === true && isEmptyId(e.group_id)
    ).length;
    console.log("is_group=true with group_id null/empty   : " + groupTrueNullGid);

    if (groupsSkipReason) {
      console.log("group_id missing-in-groups check         : skipped (" + groupsSkipReason + ")");
    } else {
      const missingGroup = enrolments.filter(
        (e) => !isEmptyId(e.group_id) && !groupIds.has(e.group_id)
      );
      console.log(
        "group_id set but not in groups           : " + missingGroup.length +
        " (groups PK = `id`, " + groupIds.size + " groups loaded)"
      );
      for (const e of missingGroup) console.log("  " + JSON.stringify(e));
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
