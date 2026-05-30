// ============================================================
// PARSERS
// CSV/spreadsheet import helpers for students and teachers.
// ============================================================

import { uid } from "../utils/helpers";

// Shared teacher colour palette — used by the colour picker and calendar auto-assignment
export const TEACHER_COLORS = [
  "#5B7FA6","#4A9B6E","#7B5EA7","#C47A6A","#3D7A8A",
  "#A0522D","#B06090","#6B7280","#2E86AB","#A23B72",
  "#F18F01","#4B5320"
];

export function parseStudentCSV(csvData, schools, teachers = []) {
  // Helper: match school by name or abbreviation/initials
  const matchSchool = (raw) => {
    if (!raw) return null;
    const r = raw.trim().toLowerCase();
    let match = schools.find(s => s.name.toLowerCase() === r);
    if (match) return match;
    const rUpper = raw.trim().toUpperCase();
    match = schools.find(s => {
      const initials = s.name.split(/\s+/).map(w => w[0]).join("").toUpperCase();
      return initials === rUpper;
    });
    if (match) return match;
    match = schools.find(s => s.name.toLowerCase().includes(r) || r.includes(s.name.toLowerCase()));
    return match || null;
  };

  const results = [];
  for (const row of csvData) {
    if (!row.name && !row.Name) continue;
    const name = row.name || row.Name || "";
    const schoolName = row.school || row.School || "";
    const className = row.class || row.Class || row.className || "";
    const instrument = row.instrument || row.Instrument || "";
    const instrument2 = row.instrument2 || row.Instrument2 || "";

    const school = matchSchool(schoolName);

    const isGroupAll = (row.isGroup || row.is_group || row.group || row.Group || "").toLowerCase() === "yes";
    const isGroup1 = (row.group1 || row.Group1 || "").toLowerCase() === "yes" || isGroupAll;
    const isGroup2 = (row.group2 || row.Group2 || "").toLowerCase() === "yes" || isGroupAll;

    const instruments = [{ name: instrument, isGroup: isGroup1 }];
    if (instrument2) instruments.push({ name: instrument2, isGroup: isGroup2 });

    results.push({
      id: uid(),
      name: name.trim(),
      schoolId: school ? school.id : "",
      schoolName: schoolName.trim(),
      className: className.trim(),
      instruments,
      outsideClassOnly: (row.outsideClassOnly || row.outside_class_only || row.breakTimeOnly || row.break_time_only || "").toLowerCase() === "yes",
      outsideClassPreferred: (row.outsideClassPreferred || row.outside_class_preferred || "").toLowerCase() === "yes",
      availableBefore: (row.availableBefore || row.available_before || row.availableBeforeAfter || row.available_before_after || row.beforeAfterOnly || row.before_after_only || "").toLowerCase() === "yes",
      availableAfter: (row.availableAfter || row.available_after || row.availableBeforeAfter || row.available_before_after || row.beforeAfterOnly || row.before_after_only || "").toLowerCase() === "yes",
      avoidTimes: [],
      preferredTimes: [],
      status: "active",
      notes: row.notes || row.Notes || ""
    });
  }

  // Consolidate: merge entries with same name + school into one student with multiple instruments
  const byKey = {};
  for (const e of results) {
    const key = `${e.name.toLowerCase()}|${e.schoolId}`;
    if (byKey[key]) {
      for (const inst of e.instruments) {
        if (!byKey[key].instruments.some(i => i.name === inst.name)) {
          byKey[key].instruments.push(inst);
        }
      }
      if (e.notes && !byKey[key].notes.includes(e.notes)) byKey[key].notes = [byKey[key].notes, e.notes].filter(Boolean).join("; ");
    } else {
      byKey[key] = { ...e };
    }
  }
  return Object.values(byKey);
}

export function parseTeacherCSV(csvData, schools) {
  const results = [];
  for (const row of csvData) {
    if (!row.name && !row.Name) continue;
    const name = row.name || row.Name || "";
    const instrumentsRaw = row.instruments || row.Instruments || "";
    const schoolsRaw = row.schools || row.Schools || "";
    const daysRaw = row.days || row.Days || "Monday,Tuesday,Wednesday,Thursday,Friday";
    const startTime = row.start_time || row.startTime || "09:00";
    const endTime = row.end_time || row.endTime || "15:30";

    const instNames = instrumentsRaw.split(",").map(s => s.trim()).filter(Boolean);
    const schoolNames = schoolsRaw.split(",").map(s => s.trim()).filter(Boolean);
    const days = daysRaw.split(",").map(s => s.trim()).filter(Boolean);

    const instruments = instNames.map(name => ({ name }));

    const teacherSchools = schoolNames.map(sn => {
      const school = schools.find(s => s.name.toLowerCase() === sn.toLowerCase());
      return school ? school.id : null;
    }).filter(Boolean);

    const availability = [];
    for (const schoolId of teacherSchools) {
      for (const day of days) {
        availability.push({ schoolId, day, start: startTime, end: endTime });
      }
    }

    results.push({
      id: uid(),
      name: name.trim(),
      instruments,
      // teacher.schools (membership) now derives from teacher_coverage lanes,
      // not availability — not stamped on import. teacherSchools still drives
      // the availability rows built above.
      availability,
      notes: row.notes || row.Notes || ""
    });
  }
  return results;
}
