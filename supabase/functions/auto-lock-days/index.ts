// ─────────────────────────────────────────────────────────────────────────────
// auto-lock-days  —  Supabase Edge Function
//
// Runs on a cron schedule (see README).
// At 6pm Melbourne time on weekdays, locks any teaching day that hasn't been
// manually confirmed by the teacher yet.
//
// Logic mirrors the old app-open fallback in InvoiceView.js:
//   1. Get today's date + day name in Melbourne timezone
//   2. Load timetable_data, filter to today's lessons
//   3. Group by teacherId → earliest start, latest end, school names
//   4. For each teacher:
//      - If a locked lesson_day slip already exists → skip
//      - If an unlocked slip exists → update + lock it
//      - If no slip exists → insert a new locked slip
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// These are automatically injected by Supabase — no need to set them manually.
const SUPABASE_URL            = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns today's date string (YYYY-MM-DD) in Melbourne timezone. */
function getMelbourneDateStr(): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
  }).formatToParts(new Date());

  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Returns today's day name (e.g. "Thursday") in Melbourne timezone. */
function getMelbourneDayName(): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    weekday:  "long",
  }).format(new Date());
}

/** Calculates hours worked, same logic as the app. */
function calcHours(start: string, end: string, breakMins = 0): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm) - breakMins;
  return Math.max(0, parseFloat((mins / 60).toFixed(2)));
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (_req) => {
  try {
    // Use service role so RLS doesn't block reads/writes
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const todayStr = getMelbourneDateStr();
    const dayName  = getMelbourneDayName();

    console.log(`auto-lock-days running for ${todayStr} (${dayName})`);

    // ── Load timetable ───────────────────────────────────────────────────────
    const { data: rows, error: ttError } = await supabase
      .from("timetable_data")
      .select("lessons")
      .limit(1);

    if (ttError || !rows?.[0]?.lessons) {
      console.error("Failed to load timetable_data:", ttError);
      return new Response(
        JSON.stringify({ error: "Could not load timetable data" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const allLessons = rows[0].lessons as Array<{
      teacherId:  string;
      day:        string;
      start:      string;
      end:        string;
      schoolName: string;
    }>;

    // ── Filter to today ──────────────────────────────────────────────────────
    const todaysLessons = allLessons.filter(l => l.day === dayName);

    if (todaysLessons.length === 0) {
      console.log(`No lessons found for ${dayName} — nothing to lock.`);
      return new Response(
        JSON.stringify({ message: `No lessons on ${dayName}`, date: todayStr }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Group by teacherId ───────────────────────────────────────────────────
    type TeacherGroup = { starts: string[]; ends: string[]; schools: string[] };
    const teacherMap: Record<string, TeacherGroup> = {};

    for (const lesson of todaysLessons) {
      if (!lesson.teacherId) continue;
      if (!teacherMap[lesson.teacherId]) {
        teacherMap[lesson.teacherId] = { starts: [], ends: [], schools: [] };
      }
      teacherMap[lesson.teacherId].starts.push(lesson.start);
      teacherMap[lesson.teacherId].ends.push(lesson.end);
      if (
        lesson.schoolName &&
        !teacherMap[lesson.teacherId].schools.includes(lesson.schoolName)
      ) {
        teacherMap[lesson.teacherId].schools.push(lesson.schoolName);
      }
    }

    // ── Lock each teacher's day ──────────────────────────────────────────────
    const results: Array<{ teacherId: string; action: string }> = [];

    for (const [teacherId, group] of Object.entries(teacherMap)) {
      group.starts.sort();
      group.ends.sort();

      const startTime  = group.starts[0];
      const endTime    = group.ends[group.ends.length - 1];
      const schoolNames = group.schools.join(", ");
      const hours      = calcHours(startTime, endTime, 0);
      const now        = new Date().toISOString();

      // Check for existing slip
      const { data: existing, error: fetchErr } = await supabase
        .from("day_slips")
        .select("id, is_locked")
        .eq("teacher_id", teacherId)
        .eq("slip_date",  todayStr)
        .eq("slip_type",  "lesson_day")
        .maybeSingle();

      if (fetchErr) {
        console.error(`Error checking slip for ${teacherId}:`, fetchErr);
        results.push({ teacherId, action: "error checking existing slip" });
        continue;
      }

      // Already locked — do nothing
      if (existing?.is_locked) {
        results.push({ teacherId, action: "skipped (already confirmed)" });
        continue;
      }

      if (!existing) {
        // Insert new locked slip
        const { error: insertErr } = await supabase.from("day_slips").insert({
          teacher_id:    teacherId,
          slip_date:     todayStr,
          slip_type:     "lesson_day",
          school_names:  schoolNames,
          start_time:    startTime,
          end_time:      endTime,
          break_minutes: 0,
          hours_worked:  hours,
          is_locked:     true,
          locked_at:     now,
        });

        if (insertErr) {
          console.error(`Insert failed for ${teacherId}:`, insertErr);
          results.push({ teacherId, action: "insert failed" });
        } else {
          results.push({ teacherId, action: "inserted + locked" });
        }
      } else {
        // Update existing unlocked slip
        const { error: updateErr } = await supabase
          .from("day_slips")
          .update({
            school_names:  schoolNames,
            start_time:    startTime,
            end_time:      endTime,
            hours_worked:  hours,
            is_locked:     true,
            locked_at:     now,
          })
          .eq("id", existing.id);

        if (updateErr) {
          console.error(`Update failed for ${teacherId}:`, updateErr);
          results.push({ teacherId, action: "update failed" });
        } else {
          results.push({ teacherId, action: "updated + locked" });
        }
      }
    }

    console.log("Results:", results);

    return new Response(
      JSON.stringify({ date: todayStr, day: dayName, results }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
