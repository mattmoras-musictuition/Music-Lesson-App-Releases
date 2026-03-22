// ============================================================
// EXPORT HELPERS
// Grid building, HTML generation, and file export functions
// for timetables, teacher schedules, and tally data.
// ============================================================

import { timeToMin, getBreaksForSchool, getInitials, getSchoolAcronym, downloadFile } from "../utils/helpers";
import { DAYS, instruments_colors } from "../constants";
import { getXLSX } from "../utils/api";

// ── Grid building ─────────────────────────────────────────────────────────────

export function buildGridRows(lessons, students, school, teachers, opts) {
  var allDays = opts && opts.allDays === false ? false : true;
  var days = allDays ? DAYS : DAYS.filter(function(d) { return lessons.some(function(l) { return l.day === d; }); });
  var breaks = school ? getBreaksForSchool(school, teachers || [], lessons) : [];
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
        var name = l.isGroup && l.studentNames ? l.studentNames.join(", ") : l.studentName;
        var cls = st ? st.className || "" : "";
        var ti = getInitials(l.teacherName);
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

export function prepareLessonRows(lessons, students) {
  var DAY_ORDER = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4 };
  return [...lessons].sort(function(a, b) { return (DAY_ORDER[a.day] || 5) - (DAY_ORDER[b.day] || 5) || timeToMin(a.start) - timeToMin(b.start); }).map(function(l) {
    var st = students ? students.find(function(s) { return s.id === l.studentId; }) : null;
    var row = { Day: l.day, Time: l.start + "-" + l.end, Student: l.isGroup && l.studentNames ? l.studentNames.join(", ") : l.studentName, Class: st ? st.className || "" : "", Teacher: l.teacherName, School: l.schoolName, Instrument: l.instrument, Slot: l.slotName || "" };
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
  var ic = instruments_colors;
  function cellHtml(cellData) {
    if (cellData.isBreak && cellData.length === 0) {
      return '<td style="background:#FFF3F0;border:1px solid #E8E5E0;min-height:54px"></td>';
    }
    if (cellData.length === 0) return '<td style="background:#FAFAFA;border:1px solid #E8E5E0;min-height:54px"></td>';
    var inner = cellData.map(function(l) {
      var bg = l.color + "22";
      var specHtml = l.spec ? '<div style="color:#7C3AED;font-size:11px;font-weight:600;margin-top:3px">during ' + l.spec + '</div>' : '';
      return '<div style="background:' + bg + ';border-left:4px solid ' + l.color + (l.adjusted ? ';border-bottom:2px solid #F59E0B' : '') + ';padding:6px 9px;border-radius:3px;margin:3px 0;font-size:14px;line-height:1.5"><b style="font-size:14px">' + l.name + '</b>' + (l.cls ? ' <span style="color:#6b7280;font-size:12px">' + l.cls + '</span>' : '') + ' <span style="color:#9ca3af;font-size:12px;font-style:italic">(' + l.ti + ')</span>' + (l.adjusted ? '<div style="color:#D97706;font-style:italic;font-size:12px">\u21BB ' + (l.adjustReason || 'Adjusted') + '</div>' : '') + specHtml + '</div>';
    }).join('');
    return '<td style="border:1px solid #E8E5E0;vertical-align:top;padding:5px;min-height:54px' + (cellData.isBreak ? ';background:#FFF3F0' : '') + '">' + inner + '</td>';
  }
  var html = '';
  if (tableTitle) html += '<h2 style="font-size:16px;margin:20px 0 6px;color:#1B2432;border-bottom:2px solid #344565;padding-bottom:4px">' + tableTitle + '</h2>';
  html += '<table style="width:100%;border-collapse:collapse;table-layout:fixed"><thead><tr><th style="background:#344565;color:#fff;padding:12px 6px;text-align:center;font-size:13px;width:54px;border:1px solid #2a3654;letter-spacing:0.3px">Time</th>';
  for (var d = 0; d < days.length; d++) html += '<th style="background:#344565;color:#fff;padding:12px 6px;text-align:center;font-size:13px;border:1px solid #2a3654;letter-spacing:0.3px">' + days[d] + '</th>';
  html += '</tr></thead><tbody>';
  for (var r = 0; r < gridRows.length; r++) {
    var row = gridRows[r];
    var rowBg = row.isBreak ? '#FFF3F0' : (r % 2 === 0 ? '#FFFFFF' : '#F8EFED');
    html += '<tr><td style="background:' + (row.isBreak ? '#C47A6A' : rowBg) + ';text-align:center;font-weight:700;font-size:12px;color:' + (row.isBreak ? '#fff' : '#6b7280') + ';border:1px solid #E8E5E0;padding:10px 4px;letter-spacing:0.2px;vertical-align:middle">' + row.time + '</td>';
    for (var d2 = 0; d2 < days.length; d2++) html += cellHtml(row.cells[days[d2]]);
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// ── HTML generation for email attachments ─────────────────────────────────────

export function generateExportHtml(lessons, students, schools, teachers, opts) {
  var schoolId = opts.schoolId, teacherName = opts.teacherName, className = opts.className, day = opts.day;
  var filtered = [...lessons];
  if (schoolId) filtered = filtered.filter(function(l) { return l.schoolId === schoolId; });
  if (teacherName) filtered = filtered.filter(function(l) { return l.teacherName === teacherName; });
  if (className) { var sids = new Set(students.filter(function(s) { return s.className === className; }).map(function(s) { return s.id; })); filtered = filtered.filter(function(l) { return sids.has(l.studentId); }); }
  if (day) filtered = filtered.filter(function(l) { return l.day === day; });
  if (filtered.length === 0) return null;
  var gridOpts = { allDays: !day, specialists: opts.specialists || null };
  var showSeparate = !schoolId && !teacherName && !className;
  var tables = "";
  if (showSeparate) {
    var groups = groupLessonsBySchool(filtered, schools);
    for (var g = 0; g < groups.length; g++) {
      if (g > 0) tables += '<div style="page-break-before:always"></div>';
      var gridRows = buildGridRows(groups[g].lessons, students, groups[g].school, teachers, gridOpts);
      tables += buildStyledTable(gridRows, groups[g].school.name);
    }
  } else {
    var school = schoolId ? schools.find(function(s) { return s.id === schoolId; }) : (filtered.length > 0 ? schools.find(function(s) { return s.id === filtered[0].schoolId; }) : schools[0]);
    var gridRows2 = buildGridRows(filtered, students, school, teachers, gridOpts);
    tables += buildStyledTable(gridRows2, null);
  }
  var isPhone = !!day;
  var css = isPhone
    ? 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:12px;font-size:12px;color:#1f2937;max-width:420px}table{width:100%!important}td,th{padding:5px 6px!important;font-size:11px!important}@media print{body{margin:4mm}@page{size:portrait;margin:4mm}}'
    : 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:16px;font-size:12px;color:#1f2937}@media print{body{margin:6mm 8mm}@page{size:landscape;margin:6mm 8mm}}';
  var title = opts.title || "Timetable";
  return '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><sty' + 'le>' + css + '</sty' + 'le></head><body><h1 style="font-size:' + (isPhone ? '14' : '16') + 'px;margin:0 0 2px;color:#374151">' + title + '</h1><div style="color:#6b7280;font-size:10px;margin-bottom:14px">Generated ' + new Date().toLocaleDateString() + ' &middot; ' + filtered.length + ' lessons</div>' + tables + '</body></html>';
}

export function generateTeacherSchedulesHtml(lessons, students, schools, teachers, opts) {
  var schoolId = opts.schoolId;
  var teacherNameFilter = opts.teacherName || null;
  var sourceLabel = opts.sourceLabel || "Master";
  var filtered = schoolId ? lessons.filter(function(l) { return l.schoolId === schoolId; }) : lessons;
  if (teacherNameFilter) filtered = filtered.filter(function(l) { return l.teacherName === teacherNameFilter; });
  var tNames = [...new Set(filtered.map(function(l) { return l.teacherName; }))].sort();
  if (tNames.length === 0) return null;
  var schoolName = schoolId ? (schools.find(function(s) { return s.id === schoolId; })?.name || "") : "All Schools";
  var DAYS_ORD = {Monday:0,Tuesday:1,Wednesday:2,Thursday:3,Friday:4};
  var css = 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:16px;font-size:12px;color:#1B2432}@media print{body{margin:6mm 8mm}@page{size:landscape;margin:6mm 8mm}}h1{font-size:19px;color:#344565;margin:0 0 2px}';
  var body = "";
  for (var ti = 0; ti < tNames.length; ti++) {
    if (ti > 0) body += '<div style="page-break-before:always"></div>';
    var tName = tNames[ti];
    var tLessons = filtered.filter(function(l) { return l.teacherName === tName; });
    var teacherSchoolGroups = groupLessonsBySchool(tLessons, schools);
    teacherSchoolGroups.sort(function(a, b) {
      var aMin = Math.min.apply(null, a.lessons.map(function(l){ return DAYS_ORD[l.day] != null ? DAYS_ORD[l.day] : 99; }));
      var bMin = Math.min.apply(null, b.lessons.map(function(l){ return DAYS_ORD[l.day] != null ? DAYS_ORD[l.day] : 99; }));
      return aMin - bMin;
    });
    var maxNameLen = 0;
    tLessons.forEach(function(l) {
      var nm = (l.isGroup && l.studentNames ? l.studentNames.join(", ") : l.studentName) || "";
      if (nm.length > maxNameLen) maxNameLen = nm.length;
    });
    var dayColWidth = Math.min(180, Math.max(110, maxNameLen * 7 + 20));
    var grids = teacherSchoolGroups.map(function(sg) { return buildTeacherSchoolGrid(sg.lessons, students, sg.school, teachers); });
    body += '<h1>' + tName + '</h1>';
    body += '<div style="color:#6b7280;font-size:10px;margin-bottom:12px">' + schoolName + ' &middot; ' + sourceLabel + ' &middot; Generated ' + new Date().toLocaleDateString() + '</div>';
    body += '<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">';
    for (var sg = 0; sg < teacherSchoolGroups.length; sg++) {
      body += buildTeacherSchoolTable(grids[sg], teacherSchoolGroups[sg].school, dayColWidth);
    }
    body += '</div>';
  }
  return '<!DOCTYPE html><html><head><title>Teacher Schedules</title><style>' + css + '</style></head><body>' + body + '</body></html>';
}

// ── Teacher schedule grid ─────────────────────────────────────────────────────

export function getTeacherBreaksForSchedule(school, teachers, lessons) {
  var breaks = [];
  var tb = (school ? school.teacherBreaks || [] : []);
  for (var i = 0; i < tb.length; i++) {
    var b = tb[i];
    breaks.push({ start: b.start, end: b.end, day: b.day || "All", label: "Break" });
  }
  if (breaks.length === 0) {
    var tids = [...new Set(lessons.filter(function(l) { return school && l.schoolId === school.id; }).map(function(l) { return l.teacherId; }))];
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

export function buildTeacherSchoolGrid(tLessons, students, school, teachers) {
  var days = ["Monday","Tuesday","Wednesday","Thursday","Friday"].filter(function(d) {
    return tLessons.some(function(l) { return l.day === d; });
  });
  var breaks = school ? getTeacherBreaksForSchedule(school, teachers || [], tLessons) : [];
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
        var name = l.isGroup && l.studentNames ? l.studentNames.join(", ") : l.studentName;
        var cls = st ? st.className || "" : "";
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
  function cellHtml(cellData, isBreakRow) {
    var bg = isBreakRow ? '#FFF3F0' : '#FFFFFF';
    if (!cellData || cellData.length === 0) {
      return '<td style="background:'+bg+';border:1px solid #E8E5E0;padding:4px;width:'+colW+'px"></td>';
    }
    var inner = cellData.map(function(l) {
      return '<div style="background:'+l.color+'22;border-left:3px solid '+l.color+(l.adjusted?';border-bottom:2px solid #F59E0B':'')+';padding:4px 6px;border-radius:3px;margin:1px 0;font-size:11.5px;line-height:1.4">'+
        '<b style="font-size:12px">'+l.name+'</b>'+
        (l.cls?' <span style="color:#6b7280;font-size:10.5px">'+l.cls+'</span>':'')+
        (l.adjusted?'<div style="color:#D97706;font-style:italic;font-size:10px">↻ '+(l.adjustReason||'Adjusted')+'</div>':'')+
        '</div>';
    }).join('');
    return '<td style="background:'+bg+';border:1px solid #E8E5E0;vertical-align:top;padding:4px;width:'+colW+'px">'+inner+'</td>';
  }
  var totalCols = days.length + 1;
  var html = '<div style="display:inline-block;vertical-align:top">';
  html += '<table style="border-collapse:collapse;table-layout:fixed">';
  html += '<thead>';
  html += '<tr><th colspan="'+totalCols+'" style="background:#344565;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.5px;padding:5px 10px;text-align:center;border:1px solid #2a3654;white-space:nowrap">'+acronym+' — '+(school.name||'')+'</th></tr>';
  html += '<tr>';
  html += '<th style="background:#344565;color:#fff;padding:7px 5px;text-align:center;font-size:11px;width:52px;border:1px solid #2a3654">Time</th>';
  for (var d = 0; d < days.length; d++) {
    html += '<th style="background:#344565;color:#fff;padding:7px 5px;text-align:center;font-size:11px;width:'+colW+'px;border:1px solid #2a3654">'+days[d]+'</th>';
  }
  html += '</tr></thead><tbody>';
  for (var r = 0; r < gridRows.length; r++) {
    var row = gridRows[r];
    var isBreak = !!row.isBreak;
    if (isBreak) {
      var totalColsBreak = days.length + 1;
      html += '<tr>';
      html += '<td style="background:#C47A6A;color:#fff;text-align:center;font-weight:700;font-size:10px;border:1px solid #b36859;padding:4px 3px;white-space:nowrap;width:52px">'+row.time+'</td>';
      html += '<td colspan="'+days.length+'" style="background:#FFF3F0;border:1px solid #E8C5BF;padding:4px 8px;font-size:10.5px;font-style:italic;color:#9B5545;text-align:center">'+row.breakLabel+'</td>';
      html += '</tr>';
    } else {
      var even = r % 2 === 0;
      var rowBg = even ? '#FFFFFF' : '#F8EFED';
      html += '<tr>';
      html += '<td style="background:'+rowBg+';text-align:center;font-weight:700;font-size:10.5px;color:#6b7280;border:1px solid #E8E5E0;padding:7px 3px;vertical-align:middle;white-space:nowrap;width:52px">'+row.time+'</td>';
      for (var d2 = 0; d2 < days.length; d2++) html += cellHtml(row.cells[days[d2]], false);
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
  if (teacherName) filtered = filtered.filter(function(l) { return l.teacherName === teacherName; });
  if (className) { var sids = new Set(students.filter(function(s) { return s.className === className; }).map(function(s) { return s.id; })); filtered = filtered.filter(function(l) { return sids.has(l.studentId); }); }
  if (day) filtered = filtered.filter(function(l) { return l.day === day; });
  if (filtered.length === 0) throw new Error("No lessons match the selected filters");
  var filename = filenameBase + (day ? "-" + day : "");
  var showSeparate = !schoolId && !teacherName && !className;
  var gridOpts = { allDays: !day, specialists: opts.specialists || null };

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
    var listRows = prepareLessonRows(filtered, students);
    var listWs = XLSX.utils.json_to_sheet(listRows);
    var listCols = Object.keys(listRows[0] || {});
    listWs["!cols"] = listCols.map(function(k) { return { wch: Math.max(k.length, Math.max.apply(null, listRows.map(function(r) { return String(r[k] || "").length; }))) + 2 }; });
    XLSX.utils.book_append_sheet(wb, listWs, "List View");
    XLSX.writeFile(wb, filename + ".xlsx");
  } else if (format === "pdf") {
    var tables2 = '';
    if (showSeparate) {
      var groups3 = groupLessonsBySchool(filtered, schools);
      for (var g3 = 0; g3 < groups3.length; g3++) {
        if (g3 > 0) tables2 += '<div style="page-break-before:always"></div>';
        var gridRows3 = buildGridRows(groups3[g3].lessons, students, groups3[g3].school, teachers, gridOpts);
        tables2 += buildStyledTable(gridRows3, groups3[g3].school.name);
      }
    } else {
      var school3 = schoolId ? schools.find(function(s) { return s.id === schoolId; }) : (filtered.length > 0 ? schools.find(function(s) { return s.id === filtered[0].schoolId; }) : schools[0]);
      var gridRows4 = buildGridRows(filtered, students, school3, teachers, gridOpts);
      tables2 += buildStyledTable(gridRows4, null);
    }
    var css = 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:16px;font-size:12px;color:#1f2937}@media print{body{margin:6mm 8mm}@page{size:landscape;margin:6mm 8mm}}';
    var html = '<!DOCTYPE html><html><head><title>' + (opts.title || filename) + '</title><sty' + 'le>' + css + '</sty' + 'le></head><body><h1 style="font-size:16px;margin:0 0 2px;color:#374151">' + (opts.title || filename) + '</h1><div style="color:#6b7280;font-size:10px;margin-bottom:14px">Generated ' + new Date().toLocaleDateString() + ' &middot; ' + filtered.length + ' lessons</div>' + tables2 + '</body></html>';
    downloadFile(html, filename + '.html', 'text/html');
  }
}

export async function exportTeacherSchedules(lessons, students, schools, teachers, opts) {
  var format = opts.format;
  var schoolId = opts.schoolId;
  var teacherNameFilter = opts.teacherName || null;
  var filtered = schoolId ? lessons.filter(function(l) { return l.schoolId === schoolId; }) : lessons;
  if (teacherNameFilter) filtered = filtered.filter(function(l) { return l.teacherName === teacherNameFilter; });
  var teacherNames = [...new Set(filtered.map(function(l) { return l.teacherName; }))].sort();
  if (teacherNames.length === 0) throw new Error("No teacher schedules to export");
  var sourceLabel = opts.sourceLabel || "Master";
  var schoolName = schoolId ? (schools.find(function(s) { return s.id === schoolId; })?.name || "") : "All Schools";
  var filenameBase = opts.filenameBase || (sourceLabel + "-Teacher-Schedules").replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");

  if (format === "xlsx") {
    var XLSX = await getXLSX();
    var wb = XLSX.utils.book_new();
    for (var ti = 0; ti < teacherNames.length; ti++) {
      var tName = teacherNames[ti];
      var tLessons = filtered.filter(function(l) { return l.teacherName === tName; });
      var teacherSchoolGroups = groupLessonsBySchool(tLessons, schools);
      var aoa = [];
      aoa.push([tName + " — Schedule", schoolName]);
      aoa.push([]);
      for (var sg = 0; sg < teacherSchoolGroups.length; sg++) {
        var sgSchool = teacherSchoolGroups[sg].school;
        var sgLessons = teacherSchoolGroups[sg].lessons;
        var sgGrid = buildTeacherSchoolGrid(sgLessons, students, sgSchool, teachers);
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
      var tLessons2 = filtered.filter(function(l) { return l.teacherName === tName2; });
      var teacherSchoolGroups2 = groupLessonsBySchool(tLessons2, schools);
      teacherSchoolGroups2.sort(function(a, b) {
        var aMin = Math.min.apply(null, a.lessons.map(function(l){ return DAYS_ORD[l.day] != null ? DAYS_ORD[l.day] : 99; }));
        var bMin = Math.min.apply(null, b.lessons.map(function(l){ return DAYS_ORD[l.day] != null ? DAYS_ORD[l.day] : 99; }));
        return aMin - bMin;
      });
      var sg2Grids = teacherSchoolGroups2.map(function(sg) {
        return buildTeacherSchoolGrid(sg.lessons, students, sg.school, teachers);
      });
      var maxNameLen = 0;
      tLessons2.forEach(function(l) {
        var nm = (l.isGroup && l.studentNames ? l.studentNames.join(", ") : l.studentName) || "";
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

export async function exportTallyData(tallyEntries, lessons, students, schools, teachers, opts) {
  var format = opts.format || "csv";
  var schoolId = opts.schoolId || null;
  var filenameBase = opts.filenameBase || "Master-Tally";
  var rows = tallyEntries
    .filter(function(e) { return !schoolId || e.schoolId === schoolId; })
    .map(function(e) {
      var lesson = lessons.find(function(l) { return l.id === e.lessonId; });
      var student = students.find(function(s) { return s.id === e.studentId; });
      var school = schools.find(function(s) { return s.id === e.schoolId; });
      return {
        "Week": e.weekKey || "",
        "Date": e.date || "",
        "Day": lesson?.day || "",
        "Time": lesson ? (lesson.start + "–" + lesson.end) : "",
        "Student": e.studentName || "",
        "Class": student?.className || "",
        "School": school?.name || e.schoolName || "",
        "Instrument": e.instrument || lesson?.instrument || "",
        "Teacher": lesson?.teacherName || "",
        "Status": e.status || "",
        "Reason": e.reason || "",
        "Makeup Eligible": e.makeupEligible === true ? "Yes" : e.makeupEligible === false ? "No" : "",
        "Made Up": e.madeUp ? "Yes" : "No",
        "Notes": e.notes || ""
      };
    });
  if (rows.length === 0) throw new Error("No tally records to export");
  if (format === "csv") {
    const Papa = window.Papa;
    downloadFile(window.window.Papa.unparse(rows), filenameBase + ".csv", "text/csv");
  } else {
    var XLSX = await getXLSX();
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.json_to_sheet(rows);
    var cols = Object.keys(rows[0] || {});
    ws["!cols"] = cols.map(function(k) {
      var max = Math.max(k.length, ...rows.map(function(r) { return String(r[k] || "").length; }));
      return { wch: Math.min(max + 2, 40) };
    });
    XLSX.utils.book_append_sheet(wb, ws, "Master Tally");
    XLSX.writeFile(wb, filenameBase + ".xlsx");
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
