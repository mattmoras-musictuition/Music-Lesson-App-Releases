// ============================================================
// EXPORT HELPERS
// Grid building, HTML generation, and file export functions
// for timetables, teacher schedules, and tally data.
// Session 96: unified visual system across all HTML exports —
// shared palette (matches invoice), shared header band with
// Matt's Music logo, shared fonts, fit-to-one-page-landscape,
// and a new list-style export for single-day phone exports.
// ============================================================

import { timeToMin, getBreaksForSchool, getSchoolAcronym, downloadFile, getLiveTeacherName } from "../utils/helpers";
import { getCardTeacherId } from "../utils/teacherCoverageDB";
import { DAYS, instruments_colors } from "../constants";
import { getXLSX } from "../utils/api";

// Cluster 12a: opts-cascade resolver for stamped-teacherName-free exports.
// Reads enrolments/laneOverrides/weekKey from opts (MTT exports pass null/null
// for the override args; WTT exports pass the live values). Returns "" when
// the lane misses — matches helpers.js getLiveTeacherName's post-12a contract.
function _liveTeacherName(lesson, students, teachers, opts) {
  return getLiveTeacherName(lesson, students, teachers, opts && opts.enrolments, opts && opts.teacherCoverage, opts && opts.laneOverrides, opts && opts.weekKey) || "";
}

// ── Shared visual system ──────────────────────────────────────────────────────
// Palette values match InvoicingManager._genHTML (which Matt approved on the
// invoice). Centralising here so any future tweak lands in one place.
const NAVY    = "#1B2432";  // primary — header band, table head, strong text
const SLATE   = "#5A6578";  // secondary — logo pill background, muted labels
const LBLUE   = "#DFE8F2";  // accent — time column tint, chips, break fill
const ROW_ALT = "#F6F8FB";  // very pale blue — even-row stripe
const BORDER  = "#E2E6EA";  // neutral cell borders
const TEXT    = "#2D2D2D";  // body copy
const MUTED   = "#6B7280";  // secondary labels / metadata
const ADJUST  = "#D97706";  // unchanged — amber for adjusted-lesson callout

// Session 96 v2: exports use the teacher's first name rather than
// initials (Matt's feedback — "Matt" reads better than "MM" on a PDF
// sent to parents/staff). Falls back to the whole name if there's no
// space in it. Handles titles crudely ("Dr. Matt Moras" → "Dr.") but
// no current teacher has a title so we're not solving for that.
function firstNameOf(name) {
  if (!name) return "";
  var first = name.split(" ")[0];
  return first || name;
}

// Display name for any lesson type. Band sessions don't carry studentName,
// so the old "l.isGroup && l.studentNames ? join : l.studentName" pattern
// rendered "undefined" for bands. Group lessons go through studentNames;
// band sessions fall back to bandName (then "Band" if even that's missing);
// regular lessons use studentName. Empty string for any unrecognised shape
// rather than the literal "undefined".
function lessonDisplayName(l) {
  if (!l) return "";
  if (l.isBandSession) return l.bandName || "Band";
  if (l.isGroup && l.studentNames) return l.studentNames.join(", ");
  return l.studentName || "";
}

// Comma-joined first names of a band session's student members. Used as the
// leading half of the subtitle on band rows so the export shows
// "Student1, Student2, Student3 · Teacher". Returns "" for non-band lessons
// and for bands without resolvable students; callers should keep the existing
// "(prefix ? prefix + ' · ' : '') + ti" tidy-up so an empty prefix collapses
// to just the teacher name.
function bandStudentFirstNames(l, students) {
  if (!l || !l.isBandSession) return "";
  var members = l.members || [];
  if (!members.length || !students) return "";
  var byId = {};
  for (var si = 0; si < students.length; si++) byId[students[si].id] = students[si];
  var names = [];
  for (var i = 0; i < members.length; i++) {
    var s = byId[members[i].studentId];
    if (s && s.name) {
      var first = (s.name + "").split(" ")[0];
      if (first) names.push(first);
    }
  }
  return names.join(", ");
}

// Default filename for exports. Examples:
//   single-day:  "Monday Week 4 - EBPS"
//   full-week:   "Week 4 - EBPS"
//   master:      "Master - EBPS" (no "Week N" available for master timetable)
// Class / teacher filters tack on after the short name: "Monday Week 4 - EBPS - 3B".
// Teacher schedule exports keep their own shape and route through their own caller.
export function buildExportFilename(opts) {
  opts = opts || {};
  // Extract "Week N" from weekLabel — accepts "Week 4", "Term 2 Week 4",
  // "Holidays Week 1"; falls back to the raw label when nothing matches.
  var wk;
  if (!opts.weekLabel || opts.weekLabel === "Master") {
    wk = "Master";
  } else {
    var m = String(opts.weekLabel).match(/Week\s+\d+/i);
    wk = m ? m[0] : opts.weekLabel;
  }
  var head = opts.day ? (opts.day + " " + wk) : wk;
  var tailParts = [];
  if (opts.schoolShortName) tailParts.push(opts.schoolShortName);
  if (opts.className) tailParts.push(opts.className);
  if (opts.teacherName) tailParts.push(opts.teacherName);
  var tail = tailParts.join(" - ");
  return tail ? (head + " - " + tail) : head;
}

// 12-hour time format for the portrait single-day export: lowercase am/pm,
// no space, no leading zero on the hour. "09:30" -> "9:30am", "13:00" -> "1:00pm".
// Local to this file; the shared helpers.to12h produces a different shape ("9:30 AM")
// and is used elsewhere in the app — don't touch it.
function fmt12(t) {
  if (!t || typeof t !== "string" || t.indexOf(":") === -1) return t || "";
  var parts = t.split(":");
  var h = parseInt(parts[0], 10);
  var m = parts[1];
  if (isNaN(h)) return t;
  var ap = h >= 12 ? "pm" : "am";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return h + ":" + m + ap;
}


// Matt's Music logo — base64 PNG (180px wide source). Kept in sync with
// InvoicingManager by copy; both render it in the same SLATE pill.
const LOGO_B64 = "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";

// ── Shared header band ────────────────────────────────────────────────────────
// Every HTML export gets the same navy header band so invoices and timetables
// feel like the same business. Logo on the left in a slate pill (matches
// invoice), school/context info on the right. `meta` is optional extra line
// under the title (e.g. lesson count, filter label).
function buildHeaderBand(title, subtitle, meta) {
  var logoSrc = "data:image/png;base64," + LOGO_B64;
  var subtitleHtml = subtitle ? '<div style="font-size:12px;color:' + LBLUE + ';letter-spacing:0.06em;text-transform:uppercase;margin-top:3px;font-weight:600">' + subtitle + '</div>' : '';
  var metaHtml = meta ? '<div style="font-size:11px;color:rgba(255,255,255,0.8);margin-top:4px">' + meta + '</div>' : '';
  // Session 96 v2: Matt's feedback — the old combo (deep navy band, slate
  // logo pill) was too dark overall. Swapped: the header band is now SLATE
  // (lighter grey-blue) and the logo pill is NAVY. Text contrast is fine
  // because the logo is white-on-navy anyway, and the title stays white on
  // the slightly lighter slate.
  return '<div class="mm-header" style="background:' + SLATE + ';color:#fff;padding:12px 18px;border-radius:8px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:24px">'
    + '<div style="background:' + NAVY + ';border-radius:8px;padding:8px 14px;display:flex;align-items:center;flex-shrink:0">'
    +   '<img src="' + logoSrc + '" alt="Matt\'s Music" style="width:140px;height:auto;display:block"/>'
    + '</div>'
    + '<div style="text-align:right;min-width:0">'
    +   '<div style="font-size:17px;font-weight:700;color:#fff;line-height:1.15">' + title + '</div>'
    +   subtitleHtml
    +   metaHtml
    + '</div>'
  + '</div>';
}

// Shared @page + body CSS for landscape timetable exports. Consolidated so
// the three entry points (generateExportHtml, generateTeacherSchedulesHtml,
// exportLessons PDF branch) all render identically.
function sharedLandscapeCss() {
  return "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','DM Sans',sans-serif;margin:14px;font-size:12px;color:" + TEXT + "}"
    + ".mm-school-block{page-break-inside:avoid;margin-bottom:14px}"
    + "@media print{body{margin:6mm 8mm}@page{size:A4 landscape;margin:6mm 8mm}.mm-header{page-break-after:avoid}}";
}

// ── Grid building ─────────────────────────────────────────────────────────────

export function buildGridRows(lessons, students, school, teachers, opts) {
  var allDays = opts && opts.allDays === false ? false : true;
  var teacherCoverage = opts && opts.teacherCoverage;
  var days = allDays ? DAYS : DAYS.filter(function(d) { return lessons.some(function(l) { return l.day === d; }); });
  var breaks = school ? getBreaksForSchool(school, teachers || [], lessons, teacherCoverage) : [];
  var lessonTimes = [...new Set(lessons.map(function(l) { return l.start; }))];
  var breakTimes = breaks.map(function(b) { return b.start; });
  var slotTimes = school ? (school.slots || []).map(function(s) { return s.start; }) : [];
  var slotLookup = {};
  if (school && school.slots) {
    for (var si = 0; si < school.slots.length; si++) {
      slotLookup[school.slots[si].start] = school.slots[si];
    }
  }
  var allTimes = [...new Set(lessonTimes.concat(breakTimes).concat(slotTimes))].sort(function(a, b) { return timeToMin(a) - timeToMin(b); });

  var specLookup = {};
  if (opts && opts.specialists) {
    for (var spi = 0; spi < opts.specialists.length; spi++) {
      var sp = opts.specialists[spi];
      var spKey = sp.schoolId + "|" + sp.className + "|" + sp.day;
      if (!specLookup[spKey]) specLookup[spKey] = [];
      specLookup[spKey].push({ start: timeToMin(sp.start), end: timeToMin(sp.end), subject: sp.subject });
    }
  }
  function getSpecTag(lesson) {
    if (!opts || !opts.specialists) return null;
    var sStart = timeToMin(lesson.start), sEnd = timeToMin(lesson.end);
    if (lesson.isGroup) {
      var subjects = [];
      var memberIds = lesson.studentIds || [];
      for (var mi = 0; mi < memberIds.length; mi++) {
        var ms = students ? students.find(function(s) { return s.id === memberIds[mi]; }) : null;
        if (!ms || !ms.className) continue;
        var key = lesson.schoolId + "|" + ms.className + "|" + lesson.day;
        var specs = specLookup[key] || [];
        var match = specs.find(function(sp) { return sStart < sp.end && sEnd > sp.start; });
        if (match && !subjects.includes(match.subject || "Specialist")) subjects.push(match.subject || "Specialist");
      }
      return subjects.length > 0 ? subjects.join(", ") : null;
    }
    var student = students ? students.find(function(s) { return s.id === lesson.studentId; }) : null;
    if (!student || !student.className) return null;
    var key2 = lesson.schoolId + "|" + student.className + "|" + lesson.day;
    var specs2 = specLookup[key2] || [];
    var match2 = specs2.find(function(sp) { return sStart < sp.end && sEnd > sp.start; });
    return match2 ? (match2.subject || "Specialist") : null;
  }

  var ic = instruments_colors;
  var result = allTimes.map(function(time) {
    var isBreak = breaks.some(function(b) { return b.start === time; });
    var breakInfo = isBreak ? breaks.find(function(b) { return b.start === time; }) : null;
    var _th = parseInt(time.split(":")[0], 10);
    var _tm = time.split(":")[1];
    var timeLabel = (_th === 0 ? 12 : _th > 12 ? _th - 12 : _th) + ":" + _tm;
    var row = { time: timeLabel, isBreak: isBreak, breakLabel: breakInfo ? breakInfo.label : "" };
    row.cells = {};
    for (var di = 0; di < days.length; di++) {
      var day = days[di];
      var dayBreak = breaks.find(function(b) { return b.start === time && (b.day === "All" || b.day === day); });
      var cell = lessons.filter(function(l) { return l.day === day && l.start === time; });
      row.cells[day] = cell.map(function(l) {
        var st = students ? students.find(function(s) { return s.id === l.studentId; }) : null;
        var name = lessonDisplayName(l);
        // Band sessions don't carry a className — slot the band's student first
        // names into the same visual position class info occupies for regular
        // and group lessons. Empty members fall back to "" so the tidy-up at
        // the render site (cls ? ... : '') drops the segment cleanly.
        var cls = l.isBandSession
          ? bandStudentFirstNames(l, students)
          : (st ? st.className || "" : "");
        // Cluster 12a: lane-resolved teacher name (override-aware on WTT).
        var ti = firstNameOf(_liveTeacherName(l, students, teachers, opts));
        var color = ic[l.instrument] || ic.default;
        var spec = getSpecTag(l);
        return { name: name, cls: cls, ti: ti, instrument: l.instrument, color: color, adjusted: l.adjusted, adjustReason: l.adjustReason, spec: spec };
      });
      row.cells[day].isBreak = !!dayBreak;
      row.cells[day].breakLabel = dayBreak ? dayBreak.label : "";
    }
    return row;
  });
  result.days = days;
  return result;
}

// Cluster 12a: opts arg added so Teacher resolves via lane (override-aware).
// Callers pass { teachers, enrolments, teacherCoverage, laneOverrides, weekKey }.
export function prepareLessonRows(lessons, students, opts) {
  var teachers = opts && opts.teachers;
  var DAY_ORDER = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4 };
  return [...lessons].sort(function(a, b) { return (DAY_ORDER[a.day] || 5) - (DAY_ORDER[b.day] || 5) || timeToMin(a.start) - timeToMin(b.start); }).map(function(l) {
    var st = students ? students.find(function(s) { return s.id === l.studentId; }) : null;
    var row = { Day: l.day, Time: l.start + "-" + l.end, Student: lessonDisplayName(l), Class: st ? st.className || "" : "", Teacher: _liveTeacherName(l, students, teachers, opts), School: l.schoolName, Instrument: l.instrument, Slot: l.slotName || "" };
    if (l.adjusted) row.Adjusted = l.adjustReason || "Yes";
    return row;
  });
}

export function groupLessonsBySchool(lessons, schools) {
  var groups = [];
  var schoolIds = [...new Set(lessons.map(function(l) { return l.schoolId; }))];
  for (var i = 0; i < schoolIds.length; i++) {
    var school = schools.find(function(s) { return s.id === schoolIds[i]; });
    if (!school) continue;
    groups.push({ school: school, lessons: lessons.filter(function(l) { return l.schoolId === schoolIds[i]; }) });
  }
  return groups;
}

export function buildStyledTable(gridRows, tableTitle) {
  var days = gridRows.days || DAYS;
  // Session 96 v2: table headers match the header band's slate. Time column
  // keeps the pale-blue LBLUE tint so it still reads distinct, with navy
  // text. Break rows' time cell switches to slate too (was navy).
  function cellHtml(cellData) {
    if (cellData.isBreak && cellData.length === 0) {
      return '<td style="background:' + LBLUE + ';border:1px solid ' + BORDER + ';min-height:40px"></td>';
    }
    if (cellData.length === 0) return '<td style="background:#FFFFFF;border:1px solid ' + BORDER + ';min-height:40px"></td>';
    var inner = cellData.map(function(l) {
      var bg = l.color + "22";
      var specHtml = l.spec ? '<div style="color:#7C3AED;font-size:10px;font-weight:600;margin-top:2px">during ' + l.spec + '</div>' : '';
      return '<div style="background:' + bg + ';border-left:3px solid ' + l.color + (l.adjusted ? ';border-bottom:2px solid ' + ADJUST : '') + ';padding:4px 7px;border-radius:3px;margin:2px 0;font-size:11.5px;line-height:1.35">'
        + '<b style="font-size:12px">' + l.name + '</b>'
        + (l.cls ? ' <span style="color:' + MUTED + ';font-size:10.5px">' + l.cls + '</span>' : '')
        + ' <span style="color:#9ca3af;font-size:10.5px;font-style:italic">(' + l.ti + ')</span>'
        + (l.adjusted ? '<div style="color:' + ADJUST + ';font-style:italic;font-size:10px">\u21BB ' + (l.adjustReason || 'Adjusted') + '</div>' : '')
        + specHtml
      + '</div>';
    }).join('');
    return '<td style="border:1px solid ' + BORDER + ';vertical-align:top;padding:3px;min-height:40px' + (cellData.isBreak ? ';background:' + LBLUE : '') + '">' + inner + '</td>';
  }
  var html = '<div class="mm-school-block">';
  if (tableTitle) html += '<h2 style="font-size:14px;margin:8px 0 6px;color:' + NAVY + ';border-bottom:2px solid ' + SLATE + ';padding-bottom:4px;font-weight:700">' + tableTitle + '</h2>';
  html += '<table style="width:100%;border-collapse:collapse;table-layout:fixed"><thead><tr>';
  html += '<th style="background:' + SLATE + ';color:#fff;padding:9px 4px;text-align:center;font-size:11.5px;width:50px;border:1px solid ' + SLATE + ';letter-spacing:0.3px;font-weight:600">Time</th>';
  for (var d = 0; d < days.length; d++) {
    html += '<th style="background:' + SLATE + ';color:#fff;padding:9px 4px;text-align:center;font-size:11.5px;border:1px solid ' + SLATE + ';letter-spacing:0.3px;font-weight:600">' + days[d] + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (var r = 0; r < gridRows.length; r++) {
    var row = gridRows[r];
    var isFullBreak = row.isBreak;
    var rowBg = isFullBreak ? LBLUE : (r % 2 === 0 ? '#FFFFFF' : ROW_ALT);
    var timeCellBg = isFullBreak ? SLATE : LBLUE;
    var timeCellColor = isFullBreak ? '#fff' : NAVY;
    html += '<tr>';
    html += '<td style="background:' + timeCellBg + ';text-align:center;font-weight:700;font-size:11px;color:' + timeCellColor + ';border:1px solid ' + BORDER + ';padding:6px 3px;letter-spacing:0.2px;vertical-align:middle;white-space:nowrap">' + row.time + '</td>';
    for (var d2 = 0; d2 < days.length; d2++) html += cellHtml(row.cells[days[d2]]);
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

// Session 96: list-style single-day export for phone/quick-check use.
// Replaces the cramped narrow-portrait timetable grid. Groups lessons by
// time ascending, shows day name + filter label at the top, instrument
// dot + teacher initials on each row. Portrait phone-sized CSS.
//
// Session 8 (inline breaks): teacher breaks for the day — both
// school-wide recurring (school.teacherBreaks) and per-teacher
// (teacher.teacherBreaks, scoped to this schoolId) — merge into the
// same time-ordered list with a slate-blue dot and "Break" label.
// School-wide breaks render without a teacher subtitle; per-teacher
// breaks show the teacher's first name. Per-teacher breaks are only
// emitted for teachers whose lessons appear in the filtered set, so
// teacher- or class-filtered exports don't show unrelated breaks.
function buildSingleDayListHtml(lessons, students, day, title, meta, opts) {
  if (!lessons || lessons.length === 0) return null;
  var ic = instruments_colors;
  var teachers = opts && opts.teachers;
  var school = opts && opts.school;
  var dayTeacherIds = new Set();
  for (var dti = 0; dti < lessons.length; dti++) {
    var dtid = getCardTeacherId(lessons[dti], opts && opts.teacherCoverage);
    if (dtid) dayTeacherIds.add(dtid);
  }
  var breakRows = [];
  if (school) {
    var stb = school.teacherBreaks || [];
    for (var sbi = 0; sbi < stb.length; sbi++) {
      var sb = stb[sbi];
      var sbDay = sb.day || "All";
      if (sbDay !== "All" && sbDay !== day) continue;
      breakRows.push({ _kind: "break", start: sb.start, end: sb.end, teacherName: "" });
    }
    if (teachers) {
      for (var ti2 = 0; ti2 < teachers.length; ti2++) {
        var tch = teachers[ti2];
        if (!dayTeacherIds.has(tch.id)) continue;
        var ttb = tch.teacherBreaks || [];
        for (var tj = 0; tj < ttb.length; tj++) {
          var tb = ttb[tj];
          if (tb.schoolId && tb.schoolId !== school.id) continue;
          if (tb.day && tb.day !== day) continue;
          breakRows.push({ _kind: "break", start: tb.start, end: tb.end, teacherName: tch.name });
        }
      }
    }
  }
  var lessonItems = lessons.map(function(l) { return Object.assign({}, l, { _kind: "lesson" }); });
  var sorted = lessonItems.concat(breakRows).sort(function(a, b) { return timeToMin(a.start) - timeToMin(b.start); });
  var rows = sorted.map(function(l) {
    if (l._kind === "break") {
      var btf = firstNameOf(l.teacherName || "");
      return '<tr>'
        + '<td style="padding:9px 10px;border-bottom:1px solid ' + BORDER + ';vertical-align:top;white-space:nowrap;font-weight:700;color:' + NAVY + ';font-size:13px">' + fmt12(l.start) + '<div style="font-size:10px;color:' + MUTED + ';font-weight:500;margin-top:1px">' + fmt12(l.end) + '</div></td>'
        + '<td style="padding:9px 10px;border-bottom:1px solid ' + BORDER + ';vertical-align:top">'
          + '<div style="display:flex;align-items:center;gap:8px">'
            + '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + SLATE + ';flex-shrink:0"></span>'
            + '<div><div style="font-weight:600;font-size:13px;color:' + TEXT + '">Break</div>'
            + (btf ? '<div style="font-size:11px;color:' + MUTED + ';margin-top:1px">' + btf + '</div>' : '')
            + '</div>'
          + '</div>'
        + '</td></tr>';
    }
    var st = students ? students.find(function(s) { return s.id === l.studentId; }) : null;
    var name = lessonDisplayName(l);
    var cls = st ? st.className || "" : "";
    var color = ic[l.instrument] || ic.default;
    // Cluster 12a: lane-resolved teacher name.
    var ti = firstNameOf(_liveTeacherName(l, students, teachers, opts));
    return '<tr>'
      + '<td style="padding:9px 10px;border-bottom:1px solid ' + BORDER + ';vertical-align:top;white-space:nowrap;font-weight:700;color:' + NAVY + ';font-size:13px">' + fmt12(l.start) + '<div style="font-size:10px;color:' + MUTED + ';font-weight:500;margin-top:1px">' + fmt12(l.end) + '</div></td>'
      + '<td style="padding:9px 10px;border-bottom:1px solid ' + BORDER + ';vertical-align:top">'
        + '<div style="display:flex;align-items:center;gap:8px">'
          + '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + color + ';flex-shrink:0"></span>'
          + '<div><div style="font-weight:600;font-size:13px;color:' + TEXT + '">' + name + (cls ? ' <span style="color:' + MUTED + ';font-size:11.5px;font-weight:500">' + cls + '</span>' : '') + '</div>'
          + '<div style="font-size:11px;color:' + MUTED + ';margin-top:1px">' + ((function(){ var p = l.isBandSession ? bandStudentFirstNames(l, students) : (l.instrument || ''); return p ? p + ' · ' : ''; })()) + ti + '</div></div>'
        + '</div>'
        + (l.adjusted ? '<div style="color:' + ADJUST + ';font-style:italic;font-size:11px;margin-top:3px">\u21BB ' + (l.adjustReason || 'Adjusted') + '</div>' : '')
      + '</td></tr>';
  }).join('');
  var phoneCss = "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','DM Sans',sans-serif;margin:14px;font-size:12px;color:" + TEXT + ";max-width:440px}"
    + "@media print{body{margin:6mm}@page{size:A4 portrait;margin:6mm}}";
  var body = buildHeaderBand(title, day, meta)
    + '<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid ' + BORDER + ';border-radius:8px;overflow:hidden">' + rows + '</table>';
  return '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>' + phoneCss + '</style></head><body>' + body + '</body></html>';
}

// Session 96: day-panels layout for classroom-teacher exports. When a
// class filter is active, render each day-with-lessons as its own list
// column side-by-side across landscape A4. Each column gets a day header
// with a lesson count, then time-sorted rows (same row style as the
// single-day list). Empty days are hidden entirely per Matt's request.
// Columns divide page width evenly so 2 days get half-width each, 5 days
// get fifth-width, etc.
function buildDaysListHtml(lessons, students, title, meta, opts) {
  if (!lessons || lessons.length === 0) return null;
  var ic = instruments_colors;
  var teachers = opts && opts.teachers;
  // Group by day, preserving DAYS order; skip empties.
  var byDay = {};
  for (var i = 0; i < DAYS.length; i++) {
    var d = DAYS[i];
    var dl = lessons.filter(function(l) { return l.day === d; });
    if (dl.length > 0) byDay[d] = dl.sort(function(a, b) { return timeToMin(a.start) - timeToMin(b.start); });
  }
  var activeDays = Object.keys(byDay);
  if (activeDays.length === 0) return null;
  // Each day panel is a flex item so they resize evenly. flex:1 with a
  // sensible min-width so at 5 days on landscape A4 each reads cleanly.
  var rowHtml = function(l) {
    var st = students ? students.find(function(s) { return s.id === l.studentId; }) : null;
    var name = lessonDisplayName(l);
    var cls = st ? st.className || "" : "";
    var color = ic[l.instrument] || ic.default;
    // Cluster 12a: lane-resolved teacher name.
    var ti = firstNameOf(_liveTeacherName(l, students, teachers, opts));
    return '<tr>'
      + '<td style="padding:7px 8px;border-bottom:1px solid ' + BORDER + ';vertical-align:top;white-space:nowrap;font-weight:700;color:' + NAVY + ';font-size:12px">' + l.start + '<div style="font-size:9.5px;color:' + MUTED + ';font-weight:500;margin-top:1px">' + l.end + '</div></td>'
      + '<td style="padding:7px 8px;border-bottom:1px solid ' + BORDER + ';vertical-align:top">'
        + '<div style="display:flex;align-items:flex-start;gap:7px">'
          + '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + color + ';flex-shrink:0;margin-top:3px"></span>'
          + '<div style="min-width:0;flex:1"><div style="font-weight:600;font-size:12px;color:' + TEXT + ';line-height:1.3">' + name + (cls ? ' <span style="color:' + MUTED + ';font-size:10.5px;font-weight:500">' + cls + '</span>' : '') + '</div>'
          + '<div style="font-size:10.5px;color:' + MUTED + ';margin-top:1px">' + ((function(){ var p = l.isBandSession ? bandStudentFirstNames(l, students) : (l.instrument || ''); return p ? p + ' \u00b7 ' : ''; })()) + ti + '</div></div>'
        + '</div>'
        + (l.adjusted ? '<div style="color:' + ADJUST + ';font-style:italic;font-size:10.5px;margin-top:2px">\u21BB ' + (l.adjustReason || 'Adjusted') + '</div>' : '')
      + '</td></tr>';
  };
  var panels = activeDays.map(function(day) {
    var dl = byDay[day];
    var rowsHtml = dl.map(rowHtml).join('');
    // Session 96 v2: fixed 280px width, left-aligned, not stretched.
    // With 5 days you get ~1400px of panels — fits landscape A4 (~277mm
    // usable ≈ 1047px at 96dpi, so at 5 panels we're wider than page, but
    // 4 days or fewer sits comfortably). At >4 days we accept a slight
    // squeeze via flex-shrink so nothing overflows.
    return '<div class="mm-day-panel" style="width:280px;flex:0 1 280px;background:#fff;border:1px solid ' + BORDER + ';border-radius:8px;overflow:hidden;page-break-inside:avoid">'
      + '<div style="background:' + SLATE + ';color:#fff;padding:7px 10px;font-size:12px;font-weight:700;letter-spacing:0.4px;display:flex;justify-content:space-between;align-items:center">'
      +   '<span>' + day + '</span>'
      +   '<span style="font-size:10px;font-weight:600;color:' + LBLUE + ';opacity:0.9">' + dl.length + '</span>'
      + '</div>'
      + '<table style="width:100%;border-collapse:collapse">' + rowsHtml + '</table>'
    + '</div>';
  }).join('');
  var body = buildHeaderBand(title, null, meta)
    + '<div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;justify-content:flex-start">' + panels + '</div>';
  return '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>' + sharedLandscapeCss() + '</style></head><body>' + body + '</body></html>';
}

// ── HTML generation for email attachments ─────────────────────────────────────

export function generateExportHtml(lessons, students, schools, teachers, opts) {
  var schoolId = opts.schoolId, teacherName = opts.teacherName, className = opts.className, day = opts.day;
  var filtered = [...lessons];
  if (schoolId) filtered = filtered.filter(function(l) { return l.schoolId === schoolId; });
  // Cluster 12a: filter by lane-resolved name rather than stamped lesson.teacherName.
  if (teacherName) filtered = filtered.filter(function(l) { return _liveTeacherName(l, students, teachers, opts) === teacherName; });
  if (className) { var sids = new Set(students.filter(function(s) { return s.className === className; }).map(function(s) { return s.id; })); filtered = filtered.filter(function(l) { return sids.has(l.studentId); }); }
  if (day) filtered = filtered.filter(function(l) { return l.day === day; });
  if (filtered.length === 0) return null;

  var title = opts.title || "Timetable";
  var metaParts = [];
  if (className) metaParts.push(className);
  if (teacherName) metaParts.push(teacherName);
  metaParts.push(filtered.length + " lesson" + (filtered.length !== 1 ? "s" : ""));
  var meta = metaParts.join(" \u00b7 ");

  // Cluster 12a: leafOpts adds teachers to the cascade so leaf renderers can
  // call _liveTeacherName. opts already carries enrolments / laneOverrides /
  // weekKey from the entry-point caller (ExportDialog).
  var leafOpts = Object.assign({}, opts, { teachers: teachers });

  // Session 96: for single-day exports, use the list-style renderer.
  if (day) {
    // Session 8: resolve the school so the renderer can pull teacher breaks.
    var sdSchool = schoolId
      ? schools.find(function(s) { return s.id === schoolId; })
      : (filtered.length > 0 ? schools.find(function(s) { return s.id === filtered[0].schoolId; }) : null);
    var sdOpts = Object.assign({}, leafOpts, { school: sdSchool });
    return buildSingleDayListHtml(filtered, students, day, title, meta, sdOpts);
  }

  // Session 96 v2: class-filtered exports get the per-day list layout —
  // days stacked horizontally, empty days hidden. Matches Matt's request
  // for classroom-teacher exports, where they want to scan "what's
  // happening each day this week" rather than read a full time grid.
  if (className) {
    return buildDaysListHtml(filtered, students, title, meta, leafOpts);
  }

  // Session 96 v2: when filtering to a specific teacher, hide days the
  // teacher doesn't work (allDays:false makes buildGridRows only include
  // days that have lessons). Useful for a part-time staff member's
  // schedule — Monday-Wednesday-only teacher gets a 3-day grid rather
  // than a 5-day grid with blanks on Thu/Fri.
  // Cluster 12a: gridOpts extended with enrolments / laneOverrides / weekKey for buildGridRows leaf-resolver.
  var gridOpts = { allDays: !day && !teacherName, specialists: opts.specialists || null, teacherCoverage: opts && opts.teacherCoverage, enrolments: opts && opts.enrolments, laneOverrides: opts && opts.laneOverrides, weekKey: opts && opts.weekKey };
  var showSeparate = !schoolId && !teacherName && !className;
  var body = buildHeaderBand(title, null, meta);
  if (showSeparate) {
    var groups = groupLessonsBySchool(filtered, schools);
    for (var g = 0; g < groups.length; g++) {
      if (g > 0) body += '<div style="page-break-before:always"></div>';
      var gridRows = buildGridRows(groups[g].lessons, students, groups[g].school, teachers, gridOpts);
      body += buildStyledTable(gridRows, groups[g].school.name);
    }
  } else {
    var school = schoolId ? schools.find(function(s) { return s.id === schoolId; }) : (filtered.length > 0 ? schools.find(function(s) { return s.id === filtered[0].schoolId; }) : schools[0]);
    var gridRows2 = buildGridRows(filtered, students, school, teachers, gridOpts);
    body += buildStyledTable(gridRows2, null);
  }
  return '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>' + sharedLandscapeCss() + '</style></head><body>' + body + '</body></html>';
}

export function generateTeacherSchedulesHtml(lessons, students, schools, teachers, opts) {
  var schoolId = opts.schoolId;
  var teacherNameFilter = opts.teacherName || null;
  var sourceLabel = opts.sourceLabel || "Master";
  var filtered = schoolId ? lessons.filter(function(l) { return l.schoolId === schoolId; }) : lessons;
  // Cluster 12a: filter and group by lane-resolved name rather than stamped lesson.teacherName.
  if (teacherNameFilter) filtered = filtered.filter(function(l) { return _liveTeacherName(l, students, teachers, opts) === teacherNameFilter; });
  var tNames = [...new Set(filtered.map(function(l) { return _liveTeacherName(l, students, teachers, opts); }).filter(function(n) { return n; }))].sort();
  if (tNames.length === 0) return null;
  var schoolName = schoolId ? (schools.find(function(s) { return s.id === schoolId; })?.name || "") : "All Schools";
  var DAYS_ORD = {Monday:0,Tuesday:1,Wednesday:2,Thursday:3,Friday:4};
  var body = "";
  for (var ti = 0; ti < tNames.length; ti++) {
    if (ti > 0) body += '<div style="page-break-before:always"></div>';
    var tName = tNames[ti];
    var tLessons = filtered.filter(function(l) { return _liveTeacherName(l, students, teachers, opts) === tName; });
    var teacherSchoolGroups = groupLessonsBySchool(tLessons, schools);
    teacherSchoolGroups.sort(function(a, b) {
      var aMin = Math.min.apply(null, a.lessons.map(function(l){ return DAYS_ORD[l.day] != null ? DAYS_ORD[l.day] : 99; }));
      var bMin = Math.min.apply(null, b.lessons.map(function(l){ return DAYS_ORD[l.day] != null ? DAYS_ORD[l.day] : 99; }));
      return aMin - bMin;
    });
    var maxNameLen = 0;
    tLessons.forEach(function(l) {
      var nm = lessonDisplayName(l);
      if (nm.length > maxNameLen) maxNameLen = nm.length;
    });
    var dayColWidth = Math.min(170, Math.max(105, maxNameLen * 6.5 + 16));
    var grids = teacherSchoolGroups.map(function(sg) { return buildTeacherSchoolGrid(sg.lessons, students, sg.school, teachers, { teacherCoverage: opts && opts.teacherCoverage, enrolments: opts && opts.enrolments, laneOverrides: opts && opts.laneOverrides, weekKey: opts && opts.weekKey }); });
    // Session 96: single header band per teacher instead of separate h1 + meta.
    var metaLine = schoolName + " \u00b7 " + sourceLabel + " \u00b7 " + tLessons.length + " lesson" + (tLessons.length !== 1 ? "s" : "");
    body += buildHeaderBand(tName, "Teacher schedule", metaLine);
    body += '<div class="mm-school-block" style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">';
    for (var sg = 0; sg < teacherSchoolGroups.length; sg++) {
      body += buildTeacherSchoolTable(grids[sg], teacherSchoolGroups[sg].school, dayColWidth);
    }
    body += '</div>';
  }
  return '<!DOCTYPE html><html><head><title>Teacher Schedules</title><style>' + sharedLandscapeCss() + '</style></head><body>' + body + '</body></html>';
}

// ── Teacher schedule grid ─────────────────────────────────────────────────────

export function getTeacherBreaksForSchedule(school, teachers, lessons, teacherCoverage) {
  var breaks = [];
  var tb = (school ? school.teacherBreaks || [] : []);
  for (var i = 0; i < tb.length; i++) {
    var b = tb[i];
    breaks.push({ start: b.start, end: b.end, day: b.day || "All", label: "Break" });
  }
  if (breaks.length === 0) {
    // Cluster 12a: stamped lesson.teacherId fallback removed — lane only.
    var tids = [...new Set(lessons.filter(function(l) { return school && l.schoolId === school.id; }).map(function(l) { return getCardTeacherId(l, teacherCoverage); }).filter(function(t) { return t; }))];
    var seen = {};
    for (var i2 = 0; i2 < tids.length; i2++) {
      var t = teachers.find(function(t2) { return t2.id === tids[i2]; });
      if (!t) continue;
      for (var j = 0; j < (t.teacherBreaks || []).length; j++) {
        var b2 = t.teacherBreaks[j];
        if (school && b2.schoolId !== school.id) continue;
        var key = (b2.day || "All") + "-" + b2.start + "-" + b2.end;
        if (!seen[key]) { seen[key] = true; breaks.push({ start: b2.start, end: b2.end, day: b2.day || "All", label: "Break" }); }
      }
    }
  }
  return breaks;
}

export function buildTeacherSchoolGrid(tLessons, students, school, teachers, opts) {
  var teacherCoverage = opts && opts.teacherCoverage;
  var days = ["Monday","Tuesday","Wednesday","Thursday","Friday"].filter(function(d) {
    return tLessons.some(function(l) { return l.day === d; });
  });
  var breaks = school ? getTeacherBreaksForSchedule(school, teachers || [], tLessons, teacherCoverage) : [];
  var lessonTimes = [...new Set(tLessons.map(function(l) { return l.start; }))];
  var breakTimes = breaks.map(function(b) { return b.start; });
  var allTimes = [...new Set(lessonTimes.concat(breakTimes))].sort(function(a,b){ return timeToMin(a)-timeToMin(b); });
  var ic = instruments_colors;
  var result = allTimes.map(function(time) {
    var breakInfo = breaks.find(function(b) { return b.start === time; });
    var cells = {};
    var anyLesson = false;
    for (var di = 0; di < days.length; di++) {
      var day = days[di];
      var cell = tLessons.filter(function(l){ return l.day === day && l.start === time; });
      cells[day] = cell.map(function(l) {
        var st = students ? students.find(function(s){ return s.id === l.studentId; }) : null;
        var name = lessonDisplayName(l);
        // Match buildGridRows: bands slot first names into the cls position.
        var cls = l.isBandSession
          ? bandStudentFirstNames(l, students)
          : (st ? st.className || "" : "");
        var color = ic[l.instrument] || ic.default;
        return { name: name, cls: cls, color: color, adjusted: l.adjusted, adjustReason: l.adjustReason };
      });
      if (cells[day].length > 0) anyLesson = true;
    }
    var isBreak = !!breakInfo && !anyLesson;
    var breakLabel = breakInfo ? (breakInfo.label + " " + breakInfo.start + (breakInfo.end ? "–" + breakInfo.end : "")) : "";
    return { time: time, isBreak: isBreak, breakLabel: breakLabel, cells: cells };
  });
  result.days = days;
  return result;
}

export function buildTeacherSchoolTable(gridRows, school, dayColWidth) {
  var days = gridRows.days || [];
  var acronym = getSchoolAcronym(school);
  var colW = dayColWidth || 130;
  // Session 96: same palette as master timetable — navy headers, pale blue
  // time column, pale blue break-row fill, instrument-colored lesson cards.
  function cellHtml(cellData, isBreakRow) {
    var bg = isBreakRow ? LBLUE : '#FFFFFF';
    if (!cellData || cellData.length === 0) {
      return '<td style="background:' + bg + ';border:1px solid ' + BORDER + ';padding:3px;width:' + colW + 'px"></td>';
    }
    var inner = cellData.map(function(l) {
      return '<div style="background:' + l.color + '22;border-left:3px solid ' + l.color + (l.adjusted ? ';border-bottom:2px solid ' + ADJUST : '') + ';padding:3px 6px;border-radius:3px;margin:1px 0;font-size:11px;line-height:1.35">'
        + '<b style="font-size:11.5px">' + l.name + '</b>'
        + (l.cls ? ' <span style="color:' + MUTED + ';font-size:10px">' + l.cls + '</span>' : '')
        + (l.adjusted ? '<div style="color:' + ADJUST + ';font-style:italic;font-size:9.5px">\u21BB ' + (l.adjustReason || 'Adjusted') + '</div>' : '')
      + '</div>';
    }).join('');
    return '<td style="background:' + bg + ';border:1px solid ' + BORDER + ';vertical-align:top;padding:3px;width:' + colW + 'px">' + inner + '</td>';
  }
  var totalCols = days.length + 1;
  var html = '<div class="mm-school-block" style="display:inline-block;vertical-align:top">';
  html += '<table style="border-collapse:collapse;table-layout:fixed">';
  html += '<thead>';
  // School banner row: acronym chip + full name in pale blue pill next to it.
  html += '<tr><th colspan="' + totalCols + '" style="background:' + SLATE + ';color:#fff;font-size:11px;font-weight:700;letter-spacing:0.4px;padding:6px 10px;text-align:left;border:1px solid ' + SLATE + ';white-space:nowrap">'
    + '<span style="display:inline-block;background:' + LBLUE + ';color:' + NAVY + ';padding:1px 8px;border-radius:10px;font-size:10.5px;margin-right:8px">' + acronym + '</span>'
    + (school.name || '') + '</th></tr>';
  html += '<tr>';
  html += '<th style="background:' + SLATE + ';color:#fff;padding:6px 4px;text-align:center;font-size:10.5px;width:48px;border:1px solid ' + SLATE + ';font-weight:600">Time</th>';
  for (var d = 0; d < days.length; d++) {
    html += '<th style="background:' + SLATE + ';color:#fff;padding:6px 4px;text-align:center;font-size:10.5px;width:' + colW + 'px;border:1px solid ' + SLATE + ';font-weight:600">' + days[d] + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (var r = 0; r < gridRows.length; r++) {
    var row = gridRows[r];
    var isBreak = !!row.isBreak;
    if (isBreak) {
      html += '<tr>';
      html += '<td style="background:' + SLATE + ';color:#fff;text-align:center;font-weight:700;font-size:10px;border:1px solid ' + SLATE + ';padding:4px 3px;white-space:nowrap;width:48px">' + row.time + '</td>';
      html += '<td colspan="' + days.length + '" style="background:' + LBLUE + ';border:1px solid ' + BORDER + ';padding:4px 8px;font-size:10.5px;font-style:italic;color:' + NAVY + ';text-align:center;font-weight:600">' + row.breakLabel + '</td>';
      html += '</tr>';
    } else {
      var even = r % 2 === 0;
      var rowBg = even ? '#FFFFFF' : ROW_ALT;
      html += '<tr>';
      html += '<td style="background:' + LBLUE + ';text-align:center;font-weight:700;font-size:10.5px;color:' + NAVY + ';border:1px solid ' + BORDER + ';padding:5px 3px;vertical-align:middle;white-space:nowrap;width:48px">' + row.time + '</td>';
      for (var d2 = 0; d2 < days.length; d2++) {
        // Use alternating row bg for lesson cells when no lesson is present
        var cd = row.cells[days[d2]];
        if (!cd || cd.length === 0) {
          html += '<td style="background:' + rowBg + ';border:1px solid ' + BORDER + ';padding:3px;width:' + colW + 'px"></td>';
        } else {
          html += cellHtml(cd, false);
        }
      }
      html += '</tr>';
    }
  }
  html += '</tbody></table></div>';
  return html;
}

// ── Full export functions ─────────────────────────────────────────────────────

export async function exportLessons(lessons, students, schools, teachers, opts) {
  var format = opts.format, filenameBase = opts.filenameBase, schoolId = opts.schoolId, teacherName = opts.teacherName, className = opts.className, day = opts.day;
  var filtered = [...lessons];
  if (schoolId) filtered = filtered.filter(function(l) { return l.schoolId === schoolId; });
  // Cluster 12a: filter by lane-resolved name.
  if (teacherName) filtered = filtered.filter(function(l) { return _liveTeacherName(l, students, teachers, opts) === teacherName; });
  if (className) { var sids = new Set(students.filter(function(s) { return s.className === className; }).map(function(s) { return s.id; })); filtered = filtered.filter(function(l) { return sids.has(l.studentId); }); }
  if (day) filtered = filtered.filter(function(l) { return l.day === day; });
  if (filtered.length === 0) throw new Error("No lessons match the selected filters");
  var filename = filenameBase + (day ? "-" + day : "");
  var showSeparate = !schoolId && !teacherName && !className;
  // Cluster 12a: gridOpts extended for lane-resolved teacher resolution.
  var gridOpts = { allDays: !day, specialists: opts.specialists || null, teacherCoverage: opts && opts.teacherCoverage, enrolments: opts && opts.enrolments, laneOverrides: opts && opts.laneOverrides, weekKey: opts && opts.weekKey };

  if (format === "csv") {
    const Papa = window.Papa;
    if (showSeparate) {
      var groups = groupLessonsBySchool(filtered, schools);
      var parts = [];
      for (var g = 0; g < groups.length; g++) {
        parts.push(groups[g].school.name);
        var rows = buildGridRows(groups[g].lessons, students, groups[g].school, teachers, gridOpts);
        var useDays = rows.days;
        var csvRows = rows.map(function(r) {
          var row = { Time: r.time };
          for (var d = 0; d < useDays.length; d++) {
            var c = r.cells[useDays[d]];
            row[useDays[d]] = c.isBreak && c.length === 0 ? "" : c.map(function(l) { return l.name + (l.cls ? " " + l.cls : "") + " (" + l.ti + ")"; }).join(" / ");
          }
          return row;
        });
        parts.push(window.window.Papa.unparse(csvRows, { columns: ["Time"].concat(useDays) }));
        parts.push("");
      }
      downloadFile(parts.join("\n"), filename + ".csv", "text/csv");
    } else {
      var school = schoolId ? schools.find(function(s) { return s.id === schoolId; }) : (filtered.length > 0 ? schools.find(function(s) { return s.id === filtered[0].schoolId; }) : schools[0]);
      var rows2 = buildGridRows(filtered, students, school, teachers, gridOpts);
      var useDays2 = rows2.days;
      var csvRows2 = rows2.map(function(r) {
        var row = { Time: r.time };
        for (var d = 0; d < useDays2.length; d++) {
          var c = r.cells[useDays2[d]];
          row[useDays2[d]] = c.isBreak && c.length === 0 ? "" : c.map(function(l) { return l.name + (l.cls ? " " + l.cls : "") + " (" + l.ti + ")"; }).join(" / ");
        }
        return row;
      });
      downloadFile(window.window.Papa.unparse(csvRows2, { columns: ["Time"].concat(useDays2) }), filename + ".csv", "text/csv");
    }
  } else if (format === "xlsx") {
    var XLSX = await getXLSX();
    var wb = XLSX.utils.book_new();
    function gridToSheet(gridRows) {
      var sheetDays = gridRows.days;
      var aoa = [];
      aoa.push(["Time"].concat(sheetDays));
      for (var r = 0; r < gridRows.length; r++) {
        var row = [gridRows[r].time];
        for (var d = 0; d < sheetDays.length; d++) {
          var c = gridRows[r].cells[sheetDays[d]];
          if (c.isBreak && c.length === 0) { row.push(""); }
          else { row.push(c.map(function(l) { return l.name + (l.cls ? " " + l.cls : "") + " (" + l.ti + ")"; }).join("\n")); }
        }
        aoa.push(row);
      }
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [{ wch: 8 }].concat(sheetDays.map(function() { return { wch: 28 }; }));
      return ws;
    }
    if (showSeparate) {
      var groups2 = groupLessonsBySchool(filtered, schools);
      for (var g2 = 0; g2 < groups2.length; g2++) {
        var gRows = buildGridRows(groups2[g2].lessons, students, groups2[g2].school, teachers, gridOpts);
        XLSX.utils.book_append_sheet(wb, gridToSheet(gRows), groups2[g2].school.name.substring(0, 31));
      }
    } else {
      var school2 = schoolId ? schools.find(function(s) { return s.id === schoolId; }) : (filtered.length > 0 ? schools.find(function(s) { return s.id === filtered[0].schoolId; }) : schools[0]);
      var gRows2 = buildGridRows(filtered, students, school2, teachers, gridOpts);
      XLSX.utils.book_append_sheet(wb, gridToSheet(gRows2), "Timetable");
    }
    // Cluster 12a: prepareLessonRows now takes opts so Teacher resolves lane-aware.
    var listRows = prepareLessonRows(filtered, students, { teachers: teachers, enrolments: opts && opts.enrolments, teacherCoverage: opts && opts.teacherCoverage, laneOverrides: opts && opts.laneOverrides, weekKey: opts && opts.weekKey });
    var listWs = XLSX.utils.json_to_sheet(listRows);
    var listCols = Object.keys(listRows[0] || {});
    listWs["!cols"] = listCols.map(function(k) { return { wch: Math.max(k.length, Math.max.apply(null, listRows.map(function(r) { return String(r[k] || "").length; }))) + 2 }; });
    XLSX.utils.book_append_sheet(wb, listWs, "List View");
    XLSX.writeFile(wb, filename + ".xlsx");
  } else if (format === "pdf") {
    // Session 96 v2: route identically to generateExportHtml. Class filter
    // → per-day list. Teacher filter → days-worked grid. Otherwise grid.
    var pdfTitle = opts.title || filename;
    var pdfMetaParts = [];
    if (className) pdfMetaParts.push(className);
    if (teacherName) pdfMetaParts.push(teacherName);
    pdfMetaParts.push(filtered.length + " lesson" + (filtered.length !== 1 ? "s" : ""));
    var pdfMeta = pdfMetaParts.join(" \u00b7 ");
    var html;
    if (className) {
      // Cluster 12a: leafOpts adds teachers for lane-resolver.
      html = buildDaysListHtml(filtered, students, pdfTitle, pdfMeta, Object.assign({}, opts, { teachers: teachers }));
    } else {
      var body = buildHeaderBand(pdfTitle, null, pdfMeta);
      // Cluster 12a: pdfGridOpts extended for lane-resolved teacher resolution.
      var pdfGridOpts = { allDays: !day && !teacherName, specialists: opts.specialists || null, teacherCoverage: opts && opts.teacherCoverage, enrolments: opts && opts.enrolments, laneOverrides: opts && opts.laneOverrides, weekKey: opts && opts.weekKey };
      if (showSeparate) {
        var groups3 = groupLessonsBySchool(filtered, schools);
        for (var g3 = 0; g3 < groups3.length; g3++) {
          if (g3 > 0) body += '<div style="page-break-before:always"></div>';
          var gridRows3 = buildGridRows(groups3[g3].lessons, students, groups3[g3].school, teachers, pdfGridOpts);
          body += buildStyledTable(gridRows3, groups3[g3].school.name);
        }
      } else {
        var school3 = schoolId ? schools.find(function(s) { return s.id === schoolId; }) : (filtered.length > 0 ? schools.find(function(s) { return s.id === filtered[0].schoolId; }) : schools[0]);
        var gridRows4 = buildGridRows(filtered, students, school3, teachers, pdfGridOpts);
        body += buildStyledTable(gridRows4, null);
      }
      html = '<!DOCTYPE html><html><head><title>' + pdfTitle + '</title><style>' + sharedLandscapeCss() + '</style></head><body>' + body + '</body></html>';
    }
    if (html) downloadFile(html, filename + '.html', 'text/html');
  }
}

export async function exportTeacherSchedules(lessons, students, schools, teachers, opts) {
  var format = opts.format;
  var schoolId = opts.schoolId;
  var teacherNameFilter = opts.teacherName || null;
  var filtered = schoolId ? lessons.filter(function(l) { return l.schoolId === schoolId; }) : lessons;
  // Cluster 12a: filter and group by lane-resolved name.
  if (teacherNameFilter) filtered = filtered.filter(function(l) { return _liveTeacherName(l, students, teachers, opts) === teacherNameFilter; });
  var teacherNames = [...new Set(filtered.map(function(l) { return _liveTeacherName(l, students, teachers, opts); }).filter(function(n) { return n; }))].sort();
  if (teacherNames.length === 0) throw new Error("No teacher schedules to export");
  var sourceLabel = opts.sourceLabel || "Master";
  var schoolName = schoolId ? (schools.find(function(s) { return s.id === schoolId; })?.name || "") : "All Schools";
  var filenameBase = opts.filenameBase || (sourceLabel + "-Teacher-Schedules").replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");

  if (format === "xlsx") {
    var XLSX = await getXLSX();
    var wb = XLSX.utils.book_new();
    for (var ti = 0; ti < teacherNames.length; ti++) {
      var tName = teacherNames[ti];
      var tLessons = filtered.filter(function(l) { return _liveTeacherName(l, students, teachers, opts) === tName; });
      var teacherSchoolGroups = groupLessonsBySchool(tLessons, schools);
      var aoa = [];
      aoa.push([tName + " — Schedule", schoolName]);
      aoa.push([]);
      for (var sg = 0; sg < teacherSchoolGroups.length; sg++) {
        var sgSchool = teacherSchoolGroups[sg].school;
        var sgLessons = teacherSchoolGroups[sg].lessons;
        var sgGrid = buildTeacherSchoolGrid(sgLessons, students, sgSchool, teachers, { teacherCoverage: opts && opts.teacherCoverage, enrolments: opts && opts.enrolments, laneOverrides: opts && opts.laneOverrides, weekKey: opts && opts.weekKey });
        var sgDays = sgGrid.days;
        aoa.push([getSchoolAcronym(sgSchool) + " — " + sgSchool.name]);
        aoa.push(["Time"].concat(sgDays));
        for (var r = 0; r < sgGrid.length; r++) {
          var row = [sgGrid[r].time];
          for (var d = 0; d < sgDays.length; d++) {
            var c = sgGrid[r].cells[sgDays[d]];
            row.push(!c || c.length === 0 ? "" : c.map(function(l){ return l.name+(l.cls?" "+l.cls:""); }).join(" / "));
          }
          aoa.push(row);
        }
        aoa.push([]);
      }
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [{ wch: 8 },{ wch: 26 },{ wch: 26 },{ wch: 26 },{ wch: 26 },{ wch: 26 }];
      var sheetName = tName.split(" ").pop().substring(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }
    XLSX.writeFile(wb, filenameBase + ".xlsx");
  } else {
    var DAYS_ORD = {Monday:0,Tuesday:1,Wednesday:2,Thursday:3,Friday:4};
    var css = 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:16px;font-size:12px;color:#1B2432}@media print{body{margin:6mm 8mm}@page{size:landscape;margin:6mm 8mm}}h1{font-size:19px;color:#344565;margin:0 0 2px}';
    var body = "";
    for (var ti2 = 0; ti2 < teacherNames.length; ti2++) {
      if (ti2 > 0) body += '<div style="page-break-before:always"></div>';
      var tName2 = teacherNames[ti2];
      var tLessons2 = filtered.filter(function(l) { return _liveTeacherName(l, students, teachers, opts) === tName2; });
      var teacherSchoolGroups2 = groupLessonsBySchool(tLessons2, schools);
      teacherSchoolGroups2.sort(function(a, b) {
        var aMin = Math.min.apply(null, a.lessons.map(function(l){ return DAYS_ORD[l.day] != null ? DAYS_ORD[l.day] : 99; }));
        var bMin = Math.min.apply(null, b.lessons.map(function(l){ return DAYS_ORD[l.day] != null ? DAYS_ORD[l.day] : 99; }));
        return aMin - bMin;
      });
      var sg2Grids = teacherSchoolGroups2.map(function(sg) {
        return buildTeacherSchoolGrid(sg.lessons, students, sg.school, teachers, { teacherCoverage: opts && opts.teacherCoverage, enrolments: opts && opts.enrolments, laneOverrides: opts && opts.laneOverrides, weekKey: opts && opts.weekKey });
      });
      var maxNameLen = 0;
      tLessons2.forEach(function(l) {
        var nm = lessonDisplayName(l);
        if (nm.length > maxNameLen) maxNameLen = nm.length;
      });
      var dayColWidth = Math.min(180, Math.max(110, maxNameLen * 7 + 20));
      body += '<h1>' + tName2 + '</h1>';
      body += '<div style="color:#6b7280;font-size:10px;margin-bottom:12px">' + schoolName + ' &middot; ' + sourceLabel + ' &middot; Generated ' + new Date().toLocaleDateString() + '</div>';
      body += '<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">';
      for (var sg2 = 0; sg2 < teacherSchoolGroups2.length; sg2++) {
        body += buildTeacherSchoolTable(sg2Grids[sg2], teacherSchoolGroups2[sg2].school, dayColWidth);
      }
      body += '</div>';
    }
    var html = '<!DOCTYPE html><html><head><title>Teacher Schedules</title><style>' + css + '</style></head><body>' + body + '</body></html>';
    downloadFile(html, filenameBase + ".html", "text/html");
  }
}

// ── Electron PDF / PNG helpers ────────────────────────────────────────────────

export async function electronPrintToPdf(html) {
  if (!window.electronAPI?.printToPdf) return null;
  const result = await window.electronAPI.printToPdf(html);
  return result.ok ? result.base64 : null;
}

export async function electronCapturePng(html) {
  if (!window.electronAPI?.capturePng) return null;
  const result = await window.electronAPI.capturePng(html);
  return result.ok ? result.base64 : null;
}
