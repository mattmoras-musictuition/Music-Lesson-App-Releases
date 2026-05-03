// ============================================================
// scripts/diag/inspect-students-enrolments.mjs
//
// READ-ONLY diagnostic: dumps a small slice of `students` and
// `enrolments` from the same Supabase project the app uses, so
// we can see whether `students.instruments[]` was mutated by
// the Phase 3 Spec 1 migration.
//
// - Reuses URL + publishable key from src/supabaseClient.js
// - Signs in via email + password (read from stdin, password masked)
// - Performs no writes/updates/deletes
// - Never logs the email or password (auth errors print "auth failed")
// - Generic error messages everywhere (no err.message bubbling out
//   in case an underlying lib formatted the request body in it)
// - Signs out before exit
// ============================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://eoexqzxrdegyazglpzrv.supabase.co";
const SUPABASE_KEY = "sb_publishable_t8NIXquR2txP16eigi37Jw_GszCNStY";

const TARGET_NAMES = [
  "Aarya Modi",
  "Abigail Palecek",
  "Albert Stokes",
  "Alex Little",
  "Alison Hackett",
];

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

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,        // never write the session token to disk
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
    // 2. Row counts
    const { count: studentsCount, error: sCntErr } = await supabase
      .from("students")
      .select("*", { count: "exact", head: true });
    if (sCntErr) throw new Error("students count failed");
    console.log("students total rows:", studentsCount);

    const { count: enrCount, error: eCntErr } = await supabase
      .from("enrolments")
      .select("*", { count: "exact", head: true });
    if (eCntErr) throw new Error("enrolments count failed");
    console.log("enrolments total rows:", enrCount);

    // 3. One sample row per table — to expose all column names
    const { data: sSample, error: sSampErr } = await supabase
      .from("students")
      .select("*")
      .limit(1);
    if (sSampErr) throw new Error("students sample failed");
    console.log("\nSAMPLE students row:");
    console.log(JSON.stringify(sSample?.[0] ?? null));

    const { data: eSample, error: eSampErr } = await supabase
      .from("enrolments")
      .select("*")
      .limit(1);
    if (eSampErr) throw new Error("enrolments sample failed");
    console.log("\nSAMPLE enrolments row:");
    console.log(JSON.stringify(eSample?.[0] ?? null));

    // 4. The 5 named students
    const { data: students, error: stErr } = await supabase
      .from("students")
      .select("*")
      .in("name", TARGET_NAMES);
    if (stErr) throw new Error("students fetch failed");

    console.log(
      `\n=== TARGET STUDENTS (${students?.length ?? 0} returned of ${TARGET_NAMES.length} requested) ===`
    );
    for (const name of TARGET_NAMES) {
      const matches = (students || []).filter((s) => s.name === name);
      if (matches.length === 0) {
        console.log(`\n--- ${name} ---`);
        console.log("NOT FOUND");
      } else {
        for (const row of matches) {
          console.log(`\n--- ${name} ---`);
          console.log("full row: " + JSON.stringify(row));
          console.log("instruments (raw): " + JSON.stringify(row.instruments));
        }
      }
    }

    // 5. Matching enrolments by student_id
    const ids = (students || []).map((s) => s.id);
    if (ids.length > 0) {
      const { data: enrs, error: enErr } = await supabase
        .from("enrolments")
        .select("*")
        .in("student_id", ids);
      if (enErr) throw new Error("enrolments fetch failed");

      console.log(
        `\n=== ENROLMENTS for target students (${enrs?.length ?? 0} row(s) total) ===`
      );
      for (const s of students || []) {
        const mine = (enrs || []).filter((e) => e.student_id === s.id);
        console.log(`\n--- ${s.name} (id ${s.id}) — ${mine.length} enrolment(s) ---`);
        for (const e of mine) console.log(JSON.stringify(e));
      }
    } else {
      console.log("\n(no target students found, skipping enrolments lookup)");
    }
  } catch (e) {
    // Generic only — never bubble e.message in case it contains a request body
    console.error("query failed:", e?.message ?? "unknown stage");
    exitCode = 2;
  } finally {
    await supabase.auth.signOut().catch(() => {});
  }

  process.exit(exitCode);
}

main().catch(() => {
  // Generic to avoid leaking anything from underlying libs
  console.error("script error");
  process.exit(99);
});
