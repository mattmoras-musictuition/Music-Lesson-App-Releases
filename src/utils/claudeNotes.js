// utils/claudeNotes.js
// Shared AI note-parsing utilities used by timetable generation (all-schools and per-school).
// Previously duplicated inside handleGenerateTimetable and handleGenerateSchool in App.js.

import { anthropicFetch, getAnthropicHeaders } from "./api";
import { ANTHROPIC_MODEL } from "../constants";

const MODEL = ANTHROPIC_MODEL;

// ---------------------------------------------------------------------------
// parseSpecialistNotes
// ---------------------------------------------------------------------------
// Takes the subset of specialists that have notes, returns the FULL specialists
// array with _partial flags applied. Silent on failure — returns input unchanged.
//
// Usage:
//   enrichedSpecialists = await parseSpecialistNotes(specialists, specialistsWithNotes, recordUsage);
// ---------------------------------------------------------------------------
export async function parseSpecialistNotes(allSpecialists, specialistsWithNotes, recordUsage) {
  if (!specialistsWithNotes || specialistsWithNotes.length === 0) return allSpecialists;

  try {
    const payload = specialistsWithNotes.map(s => ({
      id: s.id, className: s.className, day: s.day,
      start: s.start, end: s.end, subject: s.subject, notes: s.notes,
    }));

    const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: getAnthropicHeaders(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `Parse these specialist class entry notes into scheduling hints.

Specialist entries with notes:
${JSON.stringify(payload, null, 2)}

For each entry, extract:
- id: the entry's id (pass through exactly)
- partialAvailability: true if the notes suggest this class does NOT run every week (e.g. "alternating weeks", "weeks 4 and 5 only", "fortnightly", "even weeks", "not every week"). false if it runs every week or unclear.
- extraInfo: any other scheduling-relevant info as a short string

Rules:
- "alternating weeks", "fortnightly", "every other week", "odd/even weeks" = partialAvailability: true
- "weeks X and Y only", "term 2 only" = partialAvailability: true
- If notes are just descriptive with no scheduling impact, set partialAvailability: false

Respond ONLY with a JSON array of {id, partialAvailability, extraInfo}. No other text, no markdown.`,
        }],
      }),
    });

    if (!response.ok) return allSpecialists;

    const data = await response.json();
    if (data.usage && recordUsage) {
      recordUsage(MODEL, data.usage.input_tokens || 0, data.usage.output_tokens || 0);
    }

    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const hints = JSON.parse(text.replace(/```json|```/g, "").trim());

    if (!Array.isArray(hints)) return allSpecialists;

    const hintsMap = {};
    for (const h of hints) hintsMap[h.id] = h;

    return allSpecialists.map(s => {
      const h = hintsMap[s.id];
      return h ? { ...s, _partial: h.partialAvailability || false } : s;
    });
  } catch {
    return allSpecialists;
  }
}

// ---------------------------------------------------------------------------
// parseStudentNotes
// ---------------------------------------------------------------------------
// Takes the subset of students that have notes plus supporting context,
// returns the FULL students array with _noteHints applied. Silent on failure.
//
// Usage:
//   enrichedStudents = await parseStudentNotes(allStudents, studentsWithNotes, specialists, schools, recordUsage);
// ---------------------------------------------------------------------------
export async function parseStudentNotes(allStudents, studentsWithNotes, specialists, schools, recordUsage) {
  if (!studentsWithNotes || studentsWithNotes.length === 0) return allStudents;

  try {
    const notesPayload = studentsWithNotes.map(s => ({
      id: s.id, name: s.name, className: s.className,
      school: schools.find(sc => sc.id === s.schoolId)?.name || "",
      notes: s.notes,
    }));

    const specialistSubjects = [...new Set(specialists.map(s => s.subject))].join(", ");

    const specContext = specialists.length > 0
      ? `\nSpecialist timetable entries (with notes where relevant):\n${
          specialists
            .filter(s => s.notes && s.notes.trim())
            .map(s => `- ${s.className} ${s.day} ${s.start}–${s.end} ${s.subject}${s.notes ? ` [notes: "${s.notes}"]` : ""}`)
            .join("\n") || "(no specialist entries have notes)"
        }`
      : "";

    const response = await anthropicFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: getAnthropicHeaders(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: `Parse these student notes into scheduling hints. Each student may have preferences, constraints, or availability info in their notes.

Students:
${JSON.stringify(notesPayload, null, 2)}

Known specialist subjects at these schools: ${specialistSubjects}
School days: Monday, Tuesday, Wednesday, Thursday, Friday
School hours: typically 8:30am–3:30pm
${specContext}

For each student, extract:
- preferredDays: array of day names they prefer (e.g. ["Friday"]). Use this for soft preferences like "prefers Friday", "would like Monday"
- avoidDays: array of day names to avoid entirely
- avoidTimes: array of {day, start (HH:MM), end (HH:MM)} time blocks to avoid (e.g. OT sessions, appointments)
- requiredTimes: array of {day, start (HH:MM), instrument (optional)} — ONLY for notes that specify a CONCRETE day AND time for the lesson (e.g. "lesson at 10am Thursday", "scheduled for 2:30 on Wednesday", "music lesson Tuesday 11:00"). Both day AND time must be present in the note. NEVER put day-only preferences here. If the note specifies WHICH instrument goes at which time (e.g. "Guitar 8:30 Thursday, Piano 9:00 Thursday"), include the instrument name in the "instrument" field.
- preferredTimes: array of {day, start (HH:MM)} — for softer time preferences that aren't strict requirements (e.g. "ideally around 11am", "morning preferred"). Can have just a start without a day if only time-of-day is mentioned.
- allowedSpecialists: array of specialist subject names during which the student CAN be scheduled (e.g. if notes say "Can be scheduled during French", return ["LOTE"])
- extraNotes: any other scheduling-relevant info as a short string, or empty string

Rules:
- Only include fields where the notes give clear info — use empty arrays and empty strings for unknowns
- Convert 12-hour times to 24-hour format. IMPORTANT: School hours are 8:30am–3:30pm, so times like "1:10", "1:30", "2:00", "3:00" etc. always mean PM (13:10, 13:30, 14:00, 15:00). Times "4:00", "4:30", "5:00", "5:30", "6:00" are AFTER school and mean PM (16:00, 16:30, 17:00, 17:30, 18:00). Only times 7, 8, 9, 10, 11 could be AM. A time like "4:00" ALWAYS means 16:00, never 04:00.
- For avoid times, estimate a 30-minute window if no end time given
- Map language names (French, Japanese, Italian etc.) to "LOTE" for allowedSpecialists
- Map sport/PE references to "PE/Sport"
- If notes say things like "Can miss Art", that means Art is an allowedSpecialist
- Consider the specialist timetable context above when interpreting notes about specific classes or times
- CRITICAL: requiredTimes is ONLY for notes that explicitly state BOTH a specific day AND a specific time. "Prefers Friday" = preferredDays. "Lesson on Friday at 10am" = requiredTimes. "Morning if possible" = preferredTimes. If in doubt, use preferredDays or preferredTimes, NOT requiredTimes.
- If a student learns multiple instruments and the notes specify multiple times (e.g. "8:30 and 9:00 on Thursday"), include ALL the times as separate requiredTimes entries — they will be assigned to each instrument in order.
- If notes say lessons should be "back-to-back" on a specific day with a starting time, generate requiredTimes for consecutive 30-minute slots on that day.

Respond ONLY with a JSON array of {id, preferredDays, avoidDays, avoidTimes, requiredTimes, preferredTimes, allowedSpecialists, extraNotes}. requiredTimes entries should be {day, start} or {day, start, instrument} if the note specifies which instrument. No other text, no markdown.`,
        }],
      }),
    });

    if (!response.ok) return allStudents;

    const data = await response.json();
    if (data.usage && recordUsage) {
      recordUsage(MODEL, data.usage.input_tokens || 0, data.usage.output_tokens || 0);
    }

    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const hints = JSON.parse(text.replace(/```json|```/g, "").trim());

    if (!Array.isArray(hints)) return allStudents;

    const hintsMap = {};
    for (const h of hints) hintsMap[h.id] = h;

    return allStudents.map(s => {
      const h = hintsMap[s.id];
      return h ? { ...s, _noteHints: h } : s;
    });
  } catch {
    return allStudents;
  }
}
