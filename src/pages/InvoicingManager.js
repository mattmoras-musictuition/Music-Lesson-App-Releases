// ============================================================
// InvoicingManager.js — End-of-Term Invoicing
// ============================================================

import React, { useState, useMemo, useEffect } from "react";
import {
  Receipt, ChevronDown, ChevronUp, Plus, Trash2, Send,
  Eye, RefreshCw, DollarSign, FileText, Check, AlertTriangle,
  Users
} from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { uid } from "../utils/helpers";
import { STORAGE_KEYS } from "../constants";
import { enrolmentIdFor } from "../utils/enrolmentsDB";
import { getEnrolmentTermDeductionMath, getGroupTermDeductionMath } from "../utils/tallyDerive";
import { PageTitle, NavButtons, Btn } from "../components/ui/SharedUI";
import { supabase } from "../supabaseClient";
// Session 95: preferredFirstName — extracts "Jenny" from "Jennifer (Jenny) Smith",
// else returns first word. Used in _invoiceMergeCtx so parent/student names in
// invoice emails show the short/familiar form instead of full legal name.
import { preferredFirstName } from "../utils/emailTemplates";

// ─────────────────────────────────────────────────────────────
// DEFAULTS
// ─────────────────────────────────────────────────────────────
const LOGO_B64 = "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";

const DEFAULT_SETTINGS = {
  name: "Matt Moras",
  addressLine1: "1/7 Leonard St",
  addressLine2: "Hampton East VIC 3188 Australia",
  phone: "0407149340",
  email: "mattmoras@gmail.com",
  abn: "29 643 233 953",
  bsb: "923100",
  account: "38324228",
  nextInvoiceNumber: 1600,
};

// ─────────────────────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────────────────────
function _toDS(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function _addDays(ds, n) {
  const d = new Date(ds + "T00:00:00");
  d.setDate(d.getDate() + n);
  return _toDS(d);
}
function _today() {
  try {
    const tz = localStorage.getItem("mt-timezone") || "Australia/Melbourne";
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch { return _toDS(new Date()); }
}
function _fmtLong(ds) {
  if (!ds) return "";
  return new Date(ds + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}
function _dowNum(dayName) {
  return { Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5 }[dayName] ?? -1;
}
function _fmtMoney(n) {
  const abs = Math.abs(n ?? 0);
  return (n < 0 ? "-$" : "$") + abs.toFixed(2);
}
// Session 95: joins a list of names with natural English punctuation.
// 1 → "John"; 2 → "John and Sarah"; 3+ → "John, Sarah and Mike".
// Used by _invoiceMergeCtx to produce the {{student_name}} merge tag.
function _joinNames(names) {
  const filtered = (names || []).filter(Boolean);
  if (filtered.length === 0) return "";
  if (filtered.length === 1) return filtered[0];
  if (filtered.length === 2) return `${filtered[0]} and ${filtered[1]}`;
  return `${filtered.slice(0, -1).join(", ")} and ${filtered[filtered.length - 1]}`;
}
// Session 95: builds the {{missed_clause}} merge tag for the invoice_send
// template. Returns "" when there are no missed-lesson deductions so the
// sentence reads naturally ("…lessons this term."). When deductions exist,
// returns a leading-comma clause with correct singular/plural so it slots in
// cleanly ("…this term, with 2 missed lessons from last term deducted.").
// Detection: adjustment lines whose description mentions "missed" and which
// actually deduct money (negative rate) — matches the buildInvoices output
// at the "${instr} – Missed Lessons" lines. Excludes $0 covered-catchup rows.
function _buildMissedClause(lines) {
  let count = 0;
  for (const l of (lines || [])) {
    if (l.type !== "adjustment") continue;
    if (!/missed/i.test(l.description || "")) continue;
    if ((l.rate || 0) >= 0) continue; // only deductions, not $0 covered-catchup notes
    count += Number(l.qty) || 0;
  }
  if (count <= 0) return "";
  const word = count === 1 ? "lesson" : "lessons";
  return `, with ${count} missed ${word} from last term deducted`;
}
// Session 95: produces the merge context passed to the invoice_send template.
// Centralised so the single-send (sendInv) and bulk-send paths stay in lockstep.
// Keys are snake_case to match the rest of the template system (ALL_MERGE_FIELDS
// in constants.js — tally/lesson templates all use snake_case). Prior to this
// session the invoice path was using camelCase out of step with everything else;
// migrated with no break risk because invoice_send wasn't a registered trigger,
// so no user template existed yet to carry the old convention.
// BUG 3: parent and student names are reduced to preferred/first-name form so
// emails read as "Hi Tom, Here's the invoice for Jenny's lessons…" rather than
// full legal names. preferredFirstName catches "Jennifer (Jenny) Smith" → "Jenny"
// and otherwise just takes the first word.
function _invoiceMergeCtx(inv, settings) {
  const uniqueStudents = [...new Set((inv.lines || []).map(l => l.studentName).filter(Boolean))];
  const studentFirstNames = uniqueStudents.map(n => preferredFirstName(n));
  // Session 95: derive a naturally-joined instrument list from the lesson
  // lines. Each line's description is "Guitar Lessons" / "Piano Lessons" etc.
  // — strip a trailing "Lessons" / "Lesson" to get the instrument. Also
  // accept lines like "Bass Lessons", "Drum Kit Lessons", "Voice" etc. We
  // only consider type === "lesson" lines (not adjustments/custom), and
  // dedupe case-insensitively. Pluralisation follows the same _joinNames
  // helper used for student_name: "Guitar", "Guitar and Piano",
  // "Guitar, Piano and Drums".
  const instrumentSet = new Set();
  for (const l of (inv.lines || [])) {
    if (l.type !== "lesson") continue;
    const desc = (l.description || "").trim();
    if (!desc) continue;
    // Strip trailing " Lessons" or " Lesson" — case insensitive.
    const instr = desc.replace(/\s+lessons?\s*$/i, "").trim();
    if (instr) instrumentSet.add(instr);
  }
  return {
    parent_name:    preferredFirstName(inv.parentName) || inv.parentName,
    student_name:   _joinNames(studentFirstNames),
    instrument:     _joinNames([...instrumentSet]),
    invoice_number: String(inv.invoiceNumber),
    total:          _fmtMoney((inv.lines || []).reduce((s, l) => s + (l.subtotal || 0), 0)),
    due_date:       _fmtLong(inv.dueDate),
    invoice_date:   _fmtLong(inv.invoiceDate),
    term_label:     inv.termLabel,
    bsb:            settings.bsb,
    account:        settings.account,
    missed_clause:  _buildMissedClause(inv.lines),
  };
}
// Friday of the week BEFORE termStart's week
function _getInvoiceFriday(termStart) {
  const d = new Date(termStart + "T00:00:00");
  const dow = d.getDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - daysToMon - 3);
  return _toDS(d);
}
// Friday of Week 2 of the term (Monday-of-term-week + 11 days = Friday of the second week)
function _getFridayOfWeek2(termStart) {
  const d = new Date(termStart + "T00:00:00");
  const dow = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysToMonday = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + daysToMonday + 11);
  return _toDS(d);
}

// ─────────────────────────────────────────────────────────────
// TERM DETECTION
// ─────────────────────────────────────────────────────────────
function _sortedBreaks(interruptions) {
  return interruptions
    .filter(i => i.type === "term_break")
    .map(i => ({ start: i.date, end: i.endDate || i.date }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

function detectTerms(interruptions) {
  const breaks = _sortedBreaks(interruptions);
  if (!breaks.length) return [];
  const today = _today();
  const allTerms = [];

  for (let i = 0; i < breaks.length - 1; i++) {
    const start = _addDays(breaks[i].end, 1);
    const end   = _addDays(breaks[i + 1].start, -1);
    if (start > end) continue;
    allTerms.push({ start, end });
  }

  // Term after last known break
  const last = breaks[breaks.length - 1];
  const afterStart = _addDays(last.end, 1);
  if (afterStart >= _addDays(today, -14)) {
    allTerms.push({ start: afterStart, end: _addDays(afterStart, 70), isEst: true });
  }

  // Derive term number from the month the term starts — reliable for Australian schools:
  // Term 1 = Jan–Mar, Term 2 = Apr–Jun, Term 3 = Jul–Sep, Term 4 = Oct–Dec.
  // This doesn't require historical break data (e.g. the summer break) to be stored.
  const labeled = allTerms.map(term => {
    const d = new Date(term.start + "T00:00:00");
    const yr = d.getFullYear();
    const month = d.getMonth() + 1;
    const num = month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4;
    return { ...term, label: `Term ${num} ${yr}${term.isEst ? " (est.)" : ""}` };
  });

  return labeled.filter(t => t.end >= today).slice(0, 6);
}

function _findPrevTerm(interruptions, termStart) {
  const breaks = _sortedBreaks(interruptions);
  const prevBreak = [...breaks].reverse().find(b => b.end < termStart);
  if (!prevBreak) return null;
  const prev2 = [...breaks].reverse().find(b => b.end < prevBreak.start);
  return {
    start: prev2 ? _addDays(prev2.end, 1) : `${new Date(prevBreak.start + "T00:00:00").getFullYear()}-01-01`,
    end: _addDays(prevBreak.start, -1),
  };
}

function _countWeekday(dowNum, start, end) {
  if (!start || !end || start > end) return 0;
  let n = 0;
  const endD = new Date(end + "T00:00:00");
  const cur  = new Date(start + "T00:00:00");
  while (cur <= endD) {
    if (cur.getDay() === dowNum) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────
// PARENT UTILITIES
// ─────────────────────────────────────────────────────────────
// Returns a stable key for grouping students by parent
// Pull the primary parent record from a student — checks parentEmail/parentName
// and also the parents[] array some students may have.
function _primaryParent(student) {
  const email = student.parentEmail?.trim() || "";
  const name  = student.parentName?.trim()  || "";
  if (email || name) return { email, name };
  if (Array.isArray(student.parents) && student.parents.length) {
    const p = student.parents[0];
    return {
      email: (p.email || p.parentEmail || "").trim(),
      name:  (p.name  || p.parentName  || "").trim(),
    };
  }
  return { email: "", name: "" };
}
function _parentKey(student) {
  const { email, name } = _primaryParent(student);
  if (email) return `email:${email.toLowerCase()}`;
  if (name)  return `name:${name.toLowerCase()}`;
  // No parent info — one invoice per student so they don't all merge into one
  return `student:${student.id}`;
}
function _parentEmail(student) { return _primaryParent(student).email; }
function _parentName(student)  {
  const { name } = _primaryParent(student);
  return name || "";
}

// Returns all unique parents from active students
function _allParents(students) {
  const seen = {};
  for (const s of students.filter(st => st.status !== "archived")) {
    const key   = _parentKey(s);
    const name  = _parentName(s) || s.name;
    const email = _parentEmail(s);
    if (!seen[key]) seen[key] = { key, name, email, hasParentInfo: !!(name && email) };
  }
  return Object.values(seen).sort((a, b) => a.name.localeCompare(b.name));
}

// ─────────────────────────────────────────────────────────────
// INVOICE GENERATION
// ─────────────────────────────────────────────────────────────
function buildInvoices({ students, enrolments, groups, timetable, weeklyTimetables, catchups, schools, rates, interruptions, termInfo, invoiceDate, dueDate, startNum, scopeType, scopeSchoolId, scopeParentKey }) {
  // Filter students by scope
  let active = students.filter(s => s.status !== "archived");
  if (scopeType === "school" && scopeSchoolId)
    active = active.filter(s => s.schoolId === scopeSchoolId);
  if (scopeType === "parent" && scopeParentKey)
    active = active.filter(s => _parentKey(s) === scopeParentKey);

  const prevTerm = _findPrevTerm(interruptions, termInfo.start);
  const abbr = name => (name || "").split(/\s+/).map(w => w[0] || "").join("").toUpperCase().slice(0, 5) || "?";

  // Group by parent key
  const byParent = {};
  for (const s of active) {
    const key = _parentKey(s);
    if (!byParent[key]) byParent[key] = { parentName: _parentName(s) || s.name, parentEmail: _parentEmail(s), students: [] };
    byParent[key].students.push(s);
  }

  const invoices = [];
  let num = startNum;
  let skippedNoLessons = 0;

  for (const pd of Object.values(byParent)) {
    const lines = [];

    for (const student of pd.students) {
      const school  = schools.find(sc => sc.id === student.schoolId);
      const sAbbr     = abbr(school?.name);
      const schoolName  = school?.name || "";
      const sRates  = rates[student.schoolId] || {};
      const indRate = Number(sRates.individual) || 0;
      const grpRate = Number(sRates.group) || 0;

      // ── Individual lessons ────────────────────────────────
      const indLessons = (timetable?.lessons || []).filter(l => l.studentId === student.id && !l.isGroup);
      const byInstr = {};
      for (const l of indLessons) {
        if (!byInstr[l.instrument]) byInstr[l.instrument] = [];
        byInstr[l.instrument].push(l.day);
      }

      for (const [instr, days] of Object.entries(byInstr)) {
        let termN = 0;
        for (const day of days) termN += _countWeekday(_dowNum(day), termInfo.start, termInfo.end);

        const billable = termN;

        if (billable > 0 && indRate > 0)
          lines.push({ id: uid(), type: "lesson", studentName: student.name,
            description: `${instr} Lessons`, qty: billable, rate: indRate, subtotal: billable * indRate, schoolName });

        if (prevTerm && indRate > 0) {
          const enrolmentId = enrolmentIdFor(student.id, instr, enrolments);
          const { deductions, extras } = getEnrolmentTermDeductionMath({
            weeklyTimetables,
            catchups,
            enrolmentId,
            instrument: instr,
            prevTerm,
            interruptions,
            nextTermStart: termInfo.start,
          });
          if (deductions > 0)
            lines.push({ id: uid(), type: "adjustment", studentName: student.name,
              description: `${instr} – Missed Lessons`, qty: deductions, rate: -indRate, subtotal: -deductions * indRate, schoolName });
          if (extras > 0)
            lines.push({ id: uid(), type: "adjustment", studentName: student.name,
              description: `${instr} – Extra Lessons`, qty: extras, rate: indRate, subtotal: extras * indRate, schoolName });
        }
      }

      // ── Private-student path (Spec 4 cluster 7) ───────────────────────
      // Mirrors the main path's emit pattern but reads from enrolments (no
      // MTT entries exist for private students). Base line bills the term's
      // Monday-anchored week count at the private rate. Adjustment line
      // routes through the shared math helper, which already enforces the
      // "max one of deductions/extras per (enrolmentId, instrument)"
      // semantics. The fallback below is gated on !isPrivate so private
      // students never fall through to it.
      const isPrivate = student.schoolId === "__private__";
      if (isPrivate && indRate > 0) {
        // Count Monday-anchored weeks overlapping [termInfo.start, termInfo.end].
        // A week counts if it contains at least one term day — handles terms
        // that start or end mid-week (e.g. Tuesday public-holiday delay).
        const _toMon = (ds) => { const d = new Date(ds + "T00:00:00"); while (d.getDay() !== 1) d.setDate(d.getDate() - 1); return d; };
        const startMon = _toMon(termInfo.start);
        const endMon = _toMon(termInfo.end);
        const termWeeksCount = Math.round((endMon.getTime() - startMon.getTime()) / (7 * 86400000)) + 1;

        const privEnrolments = (enrolments || []).filter(en => en.studentId === student.id && !en.isGroup);
        for (const en of privEnrolments) {
          const instr = en.instrument;
          if (termWeeksCount > 0) {
            lines.push({ id: uid(), type: "lesson", studentName: student.name,
              description: `${instr} Lessons`, qty: termWeeksCount, rate: indRate,
              subtotal: termWeeksCount * indRate, schoolName: "Private" });
          }
          if (prevTerm) {
            const { deductions, extras } = getEnrolmentTermDeductionMath({
              weeklyTimetables,
              catchups,
              enrolmentId: en.id,
              instrument: instr,
              prevTerm,
              interruptions,
              nextTermStart: termInfo.start,
            });
            if (deductions > 0) {
              lines.push({ id: uid(), type: "adjustment", studentName: student.name,
                description: `${instr} – Missed Lessons`, qty: deductions, rate: -indRate,
                subtotal: -deductions * indRate, schoolName: "Private" });
            }
            if (extras > 0) {
              lines.push({ id: uid(), type: "adjustment", studentName: student.name,
                description: `${instr} – Extra Lessons`, qty: extras, rate: indRate,
                subtotal: extras * indRate, schoolName: "Private" });
            }
          }
        }
      }

      // ── Enrolment-based fallback (private / non-timetabled students) ──
      // Runs only when the student has no individual MTT lessons AND is not in
      // any scheduled group. Forward-projects current-term billing using a
      // (instrument, day) frequency derived from the student's prev-term WTT
      // lessons. Per-enrolment deductions/extras come from HELPER 4.
      // Spec 4 cluster 7 — gated on !isPrivate so private students take the
      // dedicated branch above instead of falling through here.
      const isInAnyGroup = (groups || []).some(g => g.status === "scheduled" && (g.studentIds || []).includes(student.id));
      if (!isPrivate && Object.keys(byInstr).length === 0 && indRate > 0 && !isInAnyGroup) {
        // Walk prev-term WTT once: capture day-frequency per instrument (for
        // forward-projection) and the union of instruments touched by lessons
        // or missed entries (for deduction iteration).
        const schedByInstr = {};
        const prevTermInstruments = new Set();
        if (prevTerm) {
          for (const [sk, week] of Object.entries(weeklyTimetables || {})) {
            const wk = sk.split("|")[0];
            if (wk < prevTerm.start || wk > prevTerm.end) continue;
            for (const lesson of (week.lessons || [])) {
              if (lesson.studentId !== student.id || lesson.isGroup || !lesson.instrument) continue;
              prevTermInstruments.add(lesson.instrument);
              if (!lesson.day) continue;
              if (!schedByInstr[lesson.instrument]) schedByInstr[lesson.instrument] = {};
              schedByInstr[lesson.instrument][lesson.day] = (schedByInstr[lesson.instrument][lesson.day] || 0) + 1;
            }
            for (const m of (week.missed || [])) {
              if (m.studentId !== student.id || m.isGroup || !m.instrument) continue;
              prevTermInstruments.add(m.instrument);
            }
          }
        }
        // Forward-project current-term billing using each instrument's most-used
        // prev-term day. Instruments touched only by missed entries (no lesson
        // day data) skip projection — they appear only as deduction lines below.
        for (const [instr, dayCounts] of Object.entries(schedByInstr)) {
          const topDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
          if (!topDay) continue;
          const termN = _countWeekday(_dowNum(topDay), termInfo.start, termInfo.end);
          if (termN > 0)
            lines.push({ id: uid(), type: "lesson", studentName: student.name,
              description: `${instr} Lessons`, qty: termN, rate: indRate, subtotal: termN * indRate, schoolName });
        }
        // Per-enrolment prev-term deductions for every instrument with prev-term
        // WTT activity. HELPER 4 returns zero counts when enrolmentIdFor produces
        // null — safe fallback for any data-integrity edges.
        if (prevTerm) {
          for (const instr of prevTermInstruments) {
            const enrolmentId = enrolmentIdFor(student.id, instr, enrolments);
            const { deductions, extras } = getEnrolmentTermDeductionMath({
              weeklyTimetables,
              catchups,
              enrolmentId,
              instrument: instr,
              prevTerm,
              interruptions,
              nextTermStart: termInfo.start,
            });
            if (deductions > 0)
              lines.push({ id: uid(), type: "adjustment", studentName: student.name,
                description: `${instr} – Missed Lessons`, qty: deductions, rate: -indRate, subtotal: -deductions * indRate, schoolName });
            if (extras > 0)
              lines.push({ id: uid(), type: "adjustment", studentName: student.name,
                description: `${instr} – Extra Lessons`, qty: extras, rate: indRate, subtotal: extras * indRate, schoolName });
          }
        }
      }

      // ── Group lessons ─────────────────────────────────────
      for (const grp of (groups || []).filter(g => g.status === "scheduled" && (g.studentIds || []).includes(student.id))) {
        const gl = (timetable?.lessons || []).find(l => l.isGroup && l.groupId === grp.id);
        if (!gl || grpRate <= 0) continue;
        const termN = _countWeekday(_dowNum(gl.day), termInfo.start, termInfo.end);
        const bill = termN;

        if (bill > 0)
          lines.push({ id: uid(), type: "lesson", studentName: student.name,
            description: grp.name || `Group`, qty: bill, rate: grpRate, subtotal: bill * grpRate, schoolName });

        if (prevTerm) {
          const groupMath = getGroupTermDeductionMath({
            weeklyTimetables,
            catchups,
            enrolments,
            groupId: grp.id,
            prevTerm,
            interruptions,
            nextTermStart: termInfo.start,
          });
          if (groupMath.deductions > 0 && grpRate > 0)
            lines.push({ id: uid(), type: "adjustment", studentName: student.name,
              description: `${grp.name || "Group"} – Missed`, qty: groupMath.deductions, rate: -grpRate, subtotal: -groupMath.deductions * grpRate, schoolName });
          if (groupMath.extras > 0 && grpRate > 0)
            lines.push({ id: uid(), type: "adjustment", studentName: student.name,
              description: `${grp.name || "Group"} – Extra Lessons`, qty: groupMath.extras, rate: grpRate, subtotal: groupMath.extras * grpRate, schoolName });
        }
      }
    }

    if (!lines.length) { skippedNoLessons++; continue; }
    const total = lines.reduce((s, l) => s + (l.subtotal || 0), 0);
    invoices.push({
      id: uid(), parentName: pd.parentName, parentEmail: pd.parentEmail,
      invoiceNumber: num++, invoiceDate, dueDate, termLabel: termInfo.label, paidAt: null,
      lines, total, status: "draft", createdAt: new Date().toISOString(),
    });
  }

  return { invoices, nextNum: num, skippedNoLessons, totalParents: Object.keys(byParent).length };
}

// ─────────────────────────────────────────────────────────────
// PDF HTML GENERATION
// ─────────────────────────────────────────────────────────────
function _genHTML(invoice, settings) {
  const NAVY  = "#1B2432";
  const SLATE = "#5A6578";
  const LBLUE = "#DFE8F2";
  const NEG   = "#A04040";

  // Full school names for the reference line
  const schoolNames = [...new Set(invoice.lines.map(l => l.schoolName).filter(Boolean))];
  const ref = schoolNames.length
    ? schoolNames.join(" & ") + " Music Lessons"
    : "Music Lessons";
  const total = invoice.lines.reduce((s, l) => s + (l.subtotal || 0), 0);

  // Only prefix descriptions with school name when multiple schools are involved
  const multiSchool = schoolNames.length > 1;

  const rowsHtml = invoice.lines.map(l => {
    const neg  = (l.subtotal || 0) < 0;
    const desc = multiSchool && l.schoolName ? `${l.schoolName} – ${l.description}` : l.description;
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #ece8e4;font-size:13px;color:#333;">${desc}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #ece8e4;text-align:center;font-size:13px;color:#444;">
        ${l.qty}<br/><span style="font-size:11px;color:#888;">${_fmtMoney(l.rate)}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #ece8e4;text-align:right;font-size:13px;font-weight:600;color:${neg ? NEG : "#2D2D2D"};">
        ${_fmtMoney(l.subtotal || 0)}
      </td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Invoice #${invoice.invoiceNumber} — ${invoice.parentName}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#2D2D2D;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .wrap{width:720px;margin:40px auto;padding:52px 60px;background:#fff}
  .print-btn{margin-top:36px;text-align:center}
  .print-btn button{padding:11px 32px;background:${SLATE};color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit}
  @media print{.print-btn{display:none!important}.wrap{width:100%;margin:0;padding:32px 40px}@page{size:A4;margin:10mm}}
</style>
</head>
<body>
<div class="wrap">

  <div style="display:flex;justify-content:space-between;align-items:stretch;gap:40px">
    <div style="background:${SLATE};border-radius:10px;padding:14px 18px;display:flex;align-items:center">
      <img src="data:image/png;base64,${LOGO_B64}" alt="Matt Moras - Music Tuition" style="width:180px;height:auto;display:block"/>
    </div>
    <div style="padding:7px 10px;background:${LBLUE};border-radius:6px;text-align:right;display:flex;flex-direction:column;justify-content:center">
      <div style="font-size:14px;font-weight:700;color:${NAVY};margin-bottom:2px;letter-spacing:0.04em;text-decoration:underline">DIRECT TRANSFER</div>
      <div style="font-size:12px;color:${NAVY};font-weight:500;margin-bottom:1px">${settings.name}</div>
      <div style="font-size:12px;color:#2D2D2D;line-height:1.35;font-weight:500">BSB: ${settings.bsb}<br/>ACC: ${settings.account}</div>
    </div>
  </div>

  <div style="display:flex;justify-content:space-between;margin-top:10px;align-items:flex-start">
    <div style="margin-left:10px;font-size:11px;color:#aaa;letter-spacing:0.02em">ABN: ${settings.abn}</div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:14px">
      <div style="text-align:right">
        <div style="font-size:12px;color:#888">${_fmtLong(invoice.invoiceDate)}</div>
        <div style="font-size:12px;color:#888;margin-top:3px">Invoice # ${invoice.invoiceNumber}</div>
      </div>
      <div style="font-size:60px;font-weight:200;color:#dde2e8;letter-spacing:0.01em;line-height:1">Invoice</div>
    </div>
  </div>

  <div style="margin-top:36px;margin-bottom:28px">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#aaa;margin-bottom:3px">Invoice for</div>
    <div style="font-size:17px;font-weight:700;color:${NAVY}">${invoice.parentName}</div>
    <div style="margin-top:14px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#aaa;margin-bottom:3px">In reference to</div>
      <div style="font-size:14px;font-weight:600;color:#444">${ref}</div>
    </div>
  </div>

  <table style="width:100%;border-collapse:collapse;border-top:2px solid ${NAVY}">
    <thead>
      <tr style="background:${SLATE}">
        <th style="width:58%;text-align:left;padding:10px 12px;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.92)">Item</th>
        <th style="width:22%;text-align:center;padding:10px 12px;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.92)">Qty / Price</th>
        <th style="width:20%;text-align:right;padding:10px 12px;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.92)">Subtotal</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>

  <table style="width:100%;border-collapse:collapse;margin-top:0;border-top:2px solid #eee">
    <tr>
      <td colspan="2" style="padding:9px 12px;font-size:13px;color:#555">Invoice Subtotal</td>
      <td style="padding:9px 12px;font-size:13px;text-align:right;font-weight:600;color:#333">${_fmtMoney(total)}</td>
    </tr>
    <tr>
      <td colspan="2" style="background:${SLATE};color:#fff;font-weight:700;font-size:14px;padding:11px 12px">Total due by ${_fmtLong(invoice.dueDate)}</td>
      <td style="background:${SLATE};color:#fff;font-weight:700;font-size:14px;padding:11px 12px;text-align:right">${_fmtMoney(total)}</td>
    </tr>
  </table>

  <div class="print-btn"><button onclick="window.print()">Print / Save as PDF</button></div>
</div>
</body>
</html>`;
}

function _openPrintWindow(invoice, settings) {
  // Session 98: route through IPC so the preview opens in a standalone
  // top-level BrowserWindow rather than a child of mainWindow. When the
  // app is in macOS fullscreen mode, child popups are parked in the same
  // fullscreen space and become inaccessible — the IPC-spawned window
  // sits in the regular desktop space, closes with Cmd+W, and has working
  // traffic lights. Falls back to window.open if the Electron bridge isn't
  // present (e.g. running in a browser for dev).
  const html = _genHTML(invoice, settings);
  if (window.electronAPI?.openInvoicePreview) {
    const title = `Invoice #${invoice.invoiceNumber} — ${invoice.parentName}`;
    window.electronAPI.openInvoicePreview(html, title).catch(err => {
      console.warn("[invoice preview] IPC failed, falling back to window.open:", err);
      const win = window.open("", "_blank");
      if (!win) { alert("Pop-ups are blocked — please allow pop-ups and try again."); return; }
      win.document.write(html); win.document.close();
    });
    return;
  }
  const win = window.open("", "_blank");
  if (!win) { alert("Pop-ups are blocked — please allow pop-ups and try again."); return; }
  win.document.write(html);
  win.document.close();
}

// Session 98: make sure the invoice save folder is configured before the
// first send/bulk-send. Electron auto-defaults to ~/Documents/Invoices on
// first use, so this rarely returns null — only if the Electron bridge
// is unavailable (browser-dev mode) or the home directory is somehow
// unwritable. Users can still change the location via selectInvoiceFolder
// from Settings if they want.
async function _ensureInvoiceFolder(notify) {
  if (!window.electronAPI?.getInvoiceFolder) {
    notify?.("Invoice save requires the desktop app — running in browser only", "warning");
    return null;
  }
  const folder = await window.electronAPI.getInvoiceFolder();
  if (!folder) {
    notify?.("Could not set up invoice save folder — check disk permissions", "danger", 6000);
    return null;
  }
  return folder;
}

// Session 98: build a PDF attachment for an invoice and save it to the
// configured invoice folder. Returns an attachment object using the
// contentBase64/mimeType key names that ComposeModal + electron.js
// gmail-send actually read (previous base64/mediaType keys were silently
// ignored, producing 0-byte attachments — the root cause of the Term 2
// 2026 Solway send going out with empty PDFs).
//
// Returns { attachment, savedPath, error } — attachment is the object to
// hand to ComposeModal; savedPath is where the PDF landed on disk (or
// null if save failed non-fatally); error is a user-facing message when
// the whole build failed (caller should abort the send).
async function _buildInvoicePdfAttachment(inv, settings) {
  try {
    const html = _genHTML(inv, settings);
    const pdfRes = await window.electronAPI.printToPdf(html, {
      landscape: false,
      printBackground: true,
      pageSize: "A4",
      margins: { top: 0.3, bottom: 0.3, left: 0.3, right: 0.3 },
    });
    if (!pdfRes?.ok) {
      return { attachment: null, savedPath: null, error: pdfRes?.error || "PDF generation failed" };
    }
    const safeParent = (inv.parentName || "Invoice").replace(/\s+/g, "_");
    const filename   = `Invoice_${inv.invoiceNumber}_${safeParent}.pdf`;

    // Save-to-disk is best-effort — if it fails for any reason (e.g. folder
    // was deleted between setup and now), we still hand back a valid
    // attachment so the email can go out with content. Matt can re-save
    // later via the regenerate tool.
    let savedPath = null;
    try {
      const schoolNames = [...new Set((inv.lines || []).map(l => l.schoolName).filter(Boolean))];
      const schoolName  = schoolNames.length === 1 ? schoolNames[0] : "Multi-school";
      const saveRes = await window.electronAPI.saveInvoicePdf({
        base64:     pdfRes.base64,
        schoolName,
        termLabel:  inv.termLabel || "",
        filename,
      });
      if (saveRes?.ok) savedPath = saveRes.filePath;
      else console.warn("[invoice save] non-fatal:", saveRes?.error);
    } catch (e) {
      console.warn("[invoice save] non-fatal:", e?.message || e);
    }

    return {
      attachment: { filename, contentBase64: pdfRes.base64, mimeType: "application/pdf" },
      savedPath,
      error: null,
    };
  } catch (e) {
    return { attachment: null, savedPath: null, error: e?.message || "PDF build failed" };
  }
}

function _plainText(invoice, settings) {
  const lines = invoice.lines
    .map(l => `${l.description}: ${l.qty} × ${_fmtMoney(l.rate)} = ${_fmtMoney(l.subtotal || 0)}`)
    .join("\n");
  const total = invoice.lines.reduce((s, l) => s + (l.subtotal || 0), 0);
  return `Invoice #${invoice.invoiceNumber}\nDate: ${_fmtLong(invoice.invoiceDate)}\nDue:  ${_fmtLong(invoice.dueDate)}\nTerm: ${invoice.termLabel}\n\n${lines}\n\nTotal: ${_fmtMoney(total)}\n\nPayment by direct bank transfer:\nBSB: ${settings.bsb}\nACC: ${settings.account}\nABN: ${settings.abn}`;
}

// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────
export function InvoicingManager({
  students, enrolments, schools, groups, timetable,
  weeklyTimetables, catchups = [], interruptions,
  notify, goBack, goForward, historyCursor, pageHistory,
}) {
  const { colors } = useTheme();

  // ── Persisted state ───────────────────────────────────────
  const [settings, setSettings] = useState(() => {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEYS.invoiceSettings) || "{}") }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  });
  const [rates, setRates] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.invoiceRates) || "{}"); }
    catch { return {}; }
  });
  const [invoices, setInvoices] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.invoiceDrafts) || "[]"); }
    catch { return []; }
  });

  // ── UI state ──────────────────────────────────────────────
  const [view, setView]         = useState(invoices.length ? "invoices" : "setup");
  const [sections, setSections] = useState({ details: false, rates: true, term: true });
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [confirmRegen, setConfirmRegen] = useState(false);

  // ── Term selection ────────────────────────────────────────
  const terms = useMemo(() => detectTerms(interruptions), [interruptions]);
  const [selIdx, setSelIdx] = useState(0);
  const selTerm = terms[selIdx] || null;
  const [invoiceDate, setInvoiceDate] = useState(() => _today());
  const [dueDate, setDueDate]         = useState(() => selTerm ? _getFridayOfWeek2(selTerm.start) : "");

  useEffect(() => {
    if (!selTerm) return;
    setInvoiceDate(_today());
    setDueDate(_getFridayOfWeek2(selTerm.start));
  }, [selIdx]);

  // ── Generation scope ──────────────────────────────────────
  // scopeType: "all" | "school" | "parent"
  const [scopeType, setScopeType]         = useState("all");
  const [scopeSchoolId, setScopeSchoolId] = useState("");
  const [scopeParentKey, setScopeParentKey] = useState("");
  const [parentSearch, setParentSearch]     = useState("");
  const [showParentSugg, setShowParentSugg] = useState(false);

  // Invoice list filters
  const [invSearch,     setInvSearch]     = useState("");
  const [bulkSending, setBulkSending]         = useState(false);
  // School accordion — exactly one school banner open at a time (null = all closed).
  // Sub-banners (Drafted / Sent) remember per-school state so re-opening a school
  // restores the previous sub-layout instead of resetting.
  const [openSchoolId, setOpenSchoolId] = useState(null);
  const [openSubs, setOpenSubs]         = useState({}); // { [schoolId]: { draft: bool, sent: bool } }

  const allParents = useMemo(() => _allParents(students), [students]);

  // ── Persist invoices ──────────────────────────────────────
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.invoiceDrafts, JSON.stringify(invoices)); } catch {}
  }, [invoices]);

  // ── Supabase sync — push sent invoices to the shared `invoices` table ──
  // One-way: admin (source of truth for invoice data) → Supabase → budget app.
  // Runs on any change to `invoices`, debounced 1s so line-item edits don't
  // hammer the API. Only `status === "sent"` invoices are written.
  //
  // Admin-owned columns: id, invoice_number, parent_*, school_name, term_label,
  //                      dates, amount_invoiced, sent_at.
  // Budget-owned columns: amount_received, is_cash_payment. The upsert
  // deliberately omits these so budget-app edits are preserved when admin
  // re-syncs (e.g. after a late line-item correction on a sent invoice).
  //
  // Un-marking a sent invoice or deleting it causes the corresponding
  // Supabase row to be deleted on the next sync — budget-app payment data
  // for that row is lost by design (per Matt: delete, don't archive).
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const sent = invoices.filter(i => i.status === "sent");
        const sentIdSet = new Set(sent.map(i => i.id));

        // 1. Read current Supabase state (id-only, cheap)
        const { data: existing, error: selErr } = await supabase
          .from("invoices").select("id");
        if (selErr) throw selErr;
        const existingIds = new Set((existing || []).map(r => r.id));

        // 2. Upsert currently-sent invoices
        if (sent.length > 0) {
          const rows = sent.map(inv => ({
            id:              inv.id,
            invoice_number:  inv.invoiceNumber,
            parent_name:     inv.parentName,
            parent_email:    inv.parentEmail || null,
            school_name:     [...new Set(inv.lines.map(l => l.schoolName).filter(Boolean))][0] || null,
            term_label:      inv.termLabel || null,
            invoice_date:    inv.invoiceDate,
            due_date:        inv.dueDate,
            amount_invoiced: inv.lines.reduce((s, l) => s + (l.subtotal || 0), 0),
            sent_at:         inv.sentAt || new Date().toISOString(),
          }));
          const { error: upErr } = await supabase
            .from("invoices").upsert(rows, { onConflict: "id" });
          if (upErr) throw upErr;
        }

        // 3. Delete rows that are no longer sent in admin
        const toDelete = [...existingIds].filter(id => !sentIdSet.has(id));
        if (toDelete.length > 0) {
          const { error: delErr } = await supabase
            .from("invoices").delete().in("id", toDelete);
          if (delErr) throw delErr;
        }
      } catch (err) {
        // Non-fatal — local state is authoritative; retry on next change.
        console.warn("[invoices] Supabase sync failed:", err?.message || err);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [invoices]);

  // ── Rates helpers ─────────────────────────────────────────
  const setRate = (schoolId, field, val) => {
    const next = { ...rates, [schoolId]: { ...(rates[schoolId] || {}), [field]: val } };
    setRates(next);
    try { localStorage.setItem(STORAGE_KEYS.invoiceRates, JSON.stringify(next)); } catch {}
  };

  const saveSettings = (s) => {
    const next = s || settings;
    try { localStorage.setItem(STORAGE_KEYS.invoiceSettings, JSON.stringify(next)); } catch {}
    notify("Settings saved");
  };

  // ── Generate ──────────────────────────────────────────────
  const doGenerate = () => {
    if (!selTerm) { notify("Select a term first — add term breaks in the Calendar tab", "warning"); return; }

    // Rate validation (only for "all" scope or "school" scope)
    if (scopeType !== "parent") {
      const schoolsWithLessons = new Set((timetable?.lessons || []).map(l => l.schoolId));
      // Also include schools with active students who have WTT activity at that school.
      if (selTerm) {
        for (const s of students.filter(st => st.status !== "archived" && st.schoolId)) {
          if (schoolsWithLessons.has(s.schoolId)) continue;
          const hasActivityAtSchool = Object.entries(weeklyTimetables || {}).some(([wk, week]) => {
            const [, weekSchoolId] = wk.split("|");
            if (weekSchoolId !== s.schoolId) return false;
            return (week.lessons || []).some(l => l.studentId === s.id) ||
                   (week.missed  || []).some(m => m.studentId === s.id);
          });
          if (hasActivityAtSchool) schoolsWithLessons.add(s.schoolId);
        }
      }
      const checkSchools = scopeType === "school" && scopeSchoolId
        ? schools.filter(sc => sc.id === scopeSchoolId)
        : schools;
      const missingRates = checkSchools.filter(sc => schoolsWithLessons.has(sc.id) && !Number(rates[sc.id]?.individual));
      if (missingRates.length) {
        notify(`Set rates for: ${missingRates.map(s => s.name).join(", ")}`, "warning", 5000);
        setSections(p => ({ ...p, rates: true }));
        return;
      }
    }

    const { invoices: newInvs, nextNum, skippedNoLessons, totalParents } = buildInvoices({
      students, enrolments, groups, timetable, weeklyTimetables, catchups,
      schools, rates, interruptions, termInfo: selTerm,
      invoiceDate, dueDate, startNum: settings.nextInvoiceNumber,
      scopeType, scopeSchoolId, scopeParentKey,
    });

    // Feedback if 0 generated
    if (!newInvs.length) {
      let reason = "No invoices generated.";
      if (totalParents === 0) reason += " No matching students found.";
      else if (skippedNoLessons === totalParents) reason += ` ${skippedNoLessons} parent${skippedNoLessons !== 1 ? "s" : ""} had no lesson data — check the master timetable or tally entries for ${selTerm.label}.`;
      notify(reason, "warning", 7000);
      setConfirmRegen(false);
      return;
    }

    // Session 95: regenerate preserves sent invoices. Previously the merge
    // below replaced ANY invoice matching the affected parent keys — which
    // silently overwrote sent invoices with fresh drafts, and on the next
    // Supabase sync the orphaned sent row was cascade-deleted from the
    // shared invoices table (losing its budget-app payment data). Now:
    //   - sent invoices always survive
    //   - new drafts are skipped for parents who already have a sent invoice
    //     for this term (un-mark first if you really want to regenerate)
    //   - a notify message surfaces how many were skipped
    const affectedKeys = new Set(newInvs.map(i => (i.parentEmail || i.parentName).toLowerCase().trim()));
    const sentParentKeys = new Set(
      invoices
        .filter(inv => inv.status === "sent")
        .map(inv => (inv.parentEmail || inv.parentName).toLowerCase().trim())
    );
    const skipped = newInvs.filter(inv => sentParentKeys.has((inv.parentEmail || inv.parentName).toLowerCase().trim()));
    const toAdd = newInvs.filter(inv => !sentParentKeys.has((inv.parentEmail || inv.parentName).toLowerCase().trim()));
    setInvoices(prev => {
      const unchanged = prev.filter(inv =>
        inv.status === "sent" ||
        !affectedKeys.has((inv.parentEmail || inv.parentName).toLowerCase().trim())
      );
      return [...unchanged, ...toAdd];
    });

    // Update invoice counter only for "all" scope
    if (scopeType === "all") {
      const s = { ...settings, nextInvoiceNumber: nextNum };
      setSettings(s);
      saveSettings(s);
    }

    setConfirmRegen(false);
    setView("invoices");
    const msg = skipped.length > 0
      ? `Generated ${toAdd.length} invoice${toAdd.length !== 1 ? "s" : ""} for ${selTerm.label}. Skipped ${skipped.length} parent${skipped.length !== 1 ? "s" : ""} with existing sent invoice${skipped.length !== 1 ? "s" : ""} — un-mark to regenerate.`
      : `Generated ${newInvs.length} invoice${newInvs.length !== 1 ? "s" : ""} for ${selTerm.label}`;
    notify(msg);
  };

  // ── Create blank invoices (no auto-calculation — Matt fills in manually) ──
  const doCreateBlank = () => {
    if (!selTerm) { notify("Select a term first", "warning"); return; }
    let active = students.filter(s => s.status !== "archived");
    if (scopeType === "school" && scopeSchoolId) active = active.filter(s => s.schoolId === scopeSchoolId);
    if (scopeType === "parent" && scopeParentKey) active = active.filter(s => _parentKey(s) === scopeParentKey);
    const byParent = {};
    for (const s of active) {
      const key = _parentKey(s);
      if (!byParent[key]) byParent[key] = { parentName: _parentName(s) || s.name, parentEmail: _parentEmail(s) };
    }
    if (!Object.keys(byParent).length) { notify("No matching students found", "warning"); return; }
    let num = settings.nextInvoiceNumber;
    const newInvs = Object.values(byParent).map(pd => ({
      id: uid(), parentName: pd.parentName, parentEmail: pd.parentEmail,
      invoiceNumber: num++, invoiceDate, dueDate,
      termLabel: selTerm.label, paidAt: null,
      lines: [{ id: uid(), type: "custom", description: "", qty: 1, rate: 0, subtotal: 0, studentName: "" }],
      total: 0, status: "draft", createdAt: new Date().toISOString(),
    }));
    // Session 95: same sent-preservation logic as doGenerate. See that
    // block for the full reasoning.
    const affectedKeys = new Set(newInvs.map(i => (i.parentEmail || i.parentName).toLowerCase().trim()));
    const sentParentKeys = new Set(
      invoices
        .filter(inv => inv.status === "sent")
        .map(inv => (inv.parentEmail || inv.parentName).toLowerCase().trim())
    );
    const blankSkipped = newInvs.filter(inv => sentParentKeys.has((inv.parentEmail || inv.parentName).toLowerCase().trim()));
    const blankToAdd = newInvs.filter(inv => !sentParentKeys.has((inv.parentEmail || inv.parentName).toLowerCase().trim()));
    setInvoices(prev => {
      const unchanged = prev.filter(inv =>
        inv.status === "sent" ||
        !affectedKeys.has((inv.parentEmail || inv.parentName).toLowerCase().trim())
      );
      return [...unchanged, ...blankToAdd];
    });
    if (scopeType === "all") { const s = { ...settings, nextInvoiceNumber: num }; setSettings(s); saveSettings(s); }
    setConfirmRegen(false);
    setView("invoices");
    const blankMsg = blankSkipped.length > 0
      ? `Created ${blankToAdd.length} blank invoice${blankToAdd.length !== 1 ? "s" : ""} — add line items manually. Skipped ${blankSkipped.length} parent${blankSkipped.length !== 1 ? "s" : ""} with existing sent invoice${blankSkipped.length !== 1 ? "s" : ""}.`
      : `Created ${newInvs.length} blank invoice${newInvs.length !== 1 ? "s" : ""} — add line items manually`;
    notify(blankMsg);
  };

  const handleGenerate = () => {
    const willReplace = invoices.some(inv => {
      if (scopeType === "all") return true;
      if (scopeType === "school") {
        const studentsAtSchool = students.filter(s => s.schoolId === scopeSchoolId);
        const parentKeys = new Set(studentsAtSchool.map(_parentKey));
        return parentKeys.has((inv.parentEmail || inv.parentName).toLowerCase().trim());
      }
      if (scopeType === "parent") return _parentKey({ parentEmail: inv.parentEmail, parentName: inv.parentName }) === scopeParentKey;
      return false;
    });
    if (willReplace && !confirmRegen) { setConfirmRegen(true); return; }
    doGenerate();
  };

  // ── Invoice line helpers ──────────────────────────────────
  const updInv = (id, fn) => setInvoices(prev => prev.map(inv => {
    if (inv.id !== id) return inv;
    const u = fn(inv);
    return { ...u, total: (u.lines || []).reduce((s, l) => s + (l.subtotal || 0), 0) };
  }));
  const updLine = (invId, lineId, field, val) => updInv(invId, inv => ({
    ...inv,
    lines: inv.lines.map(l => {
      if (l.id !== lineId) return l;
      const u = { ...l, [field]: val };
      if (field === "qty" || field === "rate") {
        const qty  = field === "qty"  ? Number(val) || 0 : Number(l.qty)  || 0;
        const rate = field === "rate" ? Number(val) || 0 : Number(l.rate) || 0;
        u.subtotal = qty * rate;
      }
      return u;
    }),
  }));
  const addLine  = id => updInv(id, inv => ({ ...inv, lines: [...inv.lines, { id: uid(), type: "custom", description: "", qty: 1, rate: 0, subtotal: 0, studentName: "" }] }));
  const delLine    = (invId, lineId) => updInv(invId, inv => ({ ...inv, lines: inv.lines.filter(l => l.id !== lineId) }));
  const delInvoice = id => setInvoices(prev => prev.filter(inv => inv.id !== id));
  // Session 95 BUG 2: split markSent into two distinct functions.
  // The old markSent was a toggle — if it ever fired twice (double onSent,
  // stale closure, queue retry, etc.) it would un-send an already-sent
  // invoice. That's dangerous for Supabase sync too, because unsending
  // deletes the row. setSent is now idempotent (only sets sent → sent);
  // toggleSent stays for the manual UI button which deliberately cycles.
  const setSent = id => {
    console.log("[invoice] setSent fired for id:", id);
    updInv(id, inv => {
      if (inv.status === "sent") return inv; // already sent, no-op
      return { ...inv, status: "sent", sentAt: new Date().toISOString() };
    });
  };
  const toggleSent = id => updInv(id, inv => ({
    ...inv,
    status: inv.status === "sent" ? "draft" : "sent",
    sentAt: inv.status === "sent" ? inv.sentAt : new Date().toISOString(),
  }));
  const markPaid = id => updInv(id, inv => ({ ...inv, paidAt: inv.paidAt ? null : new Date().toISOString() }));
  const sendInv = async (inv) => {
    if (!window._openComposeModal) { notify("Compose window not available", "warning"); return; }

    // Session 98: ensure the local invoice folder is set up before the first
    // send. One-time prompt; subsequent sends skip this.
    const folder = await _ensureInvoiceFolder(notify);
    if (!folder) return; // user cancelled folder picker

    // Detect school sender email — use it as the From address if this invoice is single-school.
    // Requires the school address to be configured as a Gmail "Send As" alias to take effect.
    const schoolNames = [...new Set((inv.lines || []).map(l => l.schoolName).filter(Boolean))];
    const fromEmail = schoolNames.length === 1
      ? (schools.find(s => s.name === schoolNames[0])?.senderEmail || "")
      : "";

    // Session 98: generate a real PDF (portrait, A4) via Electron's
    // printToPDF, save a copy to <invoiceFolder>/<School>/<Term>/, and attach
    // with the contentBase64/mimeType keys that ComposeModal + gmail-send
    // actually read. Previous implementation used base64/mediaType (silently
    // ignored) plus an HTML payload — producing 0-byte attachments. See
    // ComposeModal.js line ~141 and electron.js line ~225 for the key
    // contract we're conforming to.
    notify("Generating invoice PDF…", "info", 2000);
    const { attachment, savedPath, error } = await _buildInvoicePdfAttachment(inv, settings);
    if (error || !attachment) {
      notify(`Could not prepare invoice PDF: ${error || "unknown error"}`, "danger", 6000);
      return;
    }
    if (savedPath) console.log("[invoice] saved to", savedPath);

    window._openComposeModal({
      to:        [inv.parentEmail].filter(Boolean),
      from:      fromEmail || undefined,
      subject:   `Invoice #${inv.invoiceNumber} — Music Lessons ${inv.termLabel}`,
      body:      "",   // email template fills this via invoice_send trigger
      triggerId: "invoice_send",
      mergeCtx:  _invoiceMergeCtx(inv, settings),
      attachments: [attachment],
      // Session 95 BUG 2: setSent (not toggle) so double-firing is safe.
      onSent: () => setSent(inv.id),
    });
    // Note: setSent is NOT called here — it fires only via onSent when Gmail confirms delivery
  };

  // ── Shared styles ─────────────────────────────────────────
  const card    = { background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 12, marginBottom: 14, overflow: "hidden" };
  const secHdr  = open => ({ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 18px", cursor: "pointer", background: colors.sidebarHover, border: "none", width: "100%", fontFamily: "inherit", marginBottom: open ? 0 : 14, borderRadius: open ? "12px 12px 0 0" : 12 });
  const row     = { display: "flex", alignItems: "center", gap: 16, padding: "12px 18px", borderBottom: `1px solid ${colors.borderLight}`, background: colors.cardBg };
  const rowLast = { ...row, borderBottom: "none" };
  const inp     = { padding: "6px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: colors.text, background: colors.inputBg, outline: "none" };
  const radio   = (active) => ({ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: active ? 600 : 400, color: active ? colors.accent : colors.textMuted, background: active ? colors.accentLight : "none", border: `1px solid ${active ? colors.accent + "60" : colors.border}`, fontFamily: "inherit" });

  // ─────────────────────────────────────────────────────────
  // SETUP VIEW
  // ─────────────────────────────────────────────────────────
  // Compute missing-parent warning once
  const missingParentInfo = useMemo(() => {
    const active = students.filter(s => s.status !== "archived");
    const missing = active.filter(s => {
      const { email, name } = _primaryParent(s);
      return !email && !name;
    });
    return missing;
  }, [students]);

  const renderSetup = () => (
    <div style={{ maxWidth: 760 }}>

      {/* Missing parent info warning */}
      {missingParentInfo.length > 0 && (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 16px", background: colors.amberLight, borderRadius: 10, border: `1px solid ${colors.amber}40`, marginBottom: 18 }}>
          <AlertTriangle size={15} style={{ color: colors.amber, flexShrink: 0, marginTop: 1 }}/>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: colors.amberDark, marginBottom: 3 }}>
              {missingParentInfo.length} student{missingParentInfo.length !== 1 ? "s" : ""} missing parent contact info
            </div>
            <div style={{ fontSize: 12, color: colors.amberDark }}>
              {missingParentInfo.slice(0, 5).map(s => s.name).join(", ")}{missingParentInfo.length > 5 ? ` and ${missingParentInfo.length - 5} more` : ""}. Add a parent name and email in the Students tab so these can be grouped correctly. Until then, each will generate as a separate invoice using the student's name.
            </div>
          </div>
        </div>
      )}

      {/* Business Details */}
      <button style={secHdr(sections.details)} onClick={() => setSections(p => ({ ...p, details: !p.details }))}>
        <span style={{ fontWeight: 700, fontSize: 14, color: "#fff", display: "flex", alignItems: "center", gap: 8 }}><FileText size={14}/> Business Details</span>
        {sections.details ? <ChevronUp size={15} style={{ color: "rgba(255,255,255,.6)" }}/> : <ChevronDown size={15} style={{ color: "rgba(255,255,255,.6)" }}/>}
      </button>
      {sections.details && (
        <div style={{ ...card, borderRadius: "0 0 12px 12px", marginTop: 0 }}>
          {[["Name","name"],["Address Line 1","addressLine1"],["Address Line 2","addressLine2"],["Phone","phone"],["Email","email"],["ABN","abn"],["BSB","bsb"],["Account #","account"]].map(([label, key], i, arr) => (
            <div key={key} style={i === arr.length - 1 ? rowLast : row}>
              <span style={{ fontSize: 13, fontWeight: 600, color: colors.text, minWidth: 130 }}>{label}</span>
              <input value={settings[key] || ""} onChange={e => setSettings(p => ({ ...p, [key]: e.target.value }))} style={{ ...inp, flex: 1, maxWidth: 320 }}/>
            </div>
          ))}
          <div style={rowLast}>
            <span style={{ fontSize: 13, fontWeight: 600, color: colors.text, minWidth: 130 }}>Next Invoice #</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="number" value={settings.nextInvoiceNumber || 1} onChange={e => setSettings(p => ({ ...p, nextInvoiceNumber: Number(e.target.value) }))} style={{ ...inp, width: 100 }}/>
              <Btn variant="primary" onClick={() => saveSettings()}>Save</Btn>
            </div>
          </div>
        </div>
      )}

      {/* School Rates */}
      <button style={secHdr(sections.rates)} onClick={() => setSections(p => ({ ...p, rates: !p.rates }))}>
        <span style={{ fontWeight: 700, fontSize: 14, color: "#fff", display: "flex", alignItems: "center", gap: 8 }}><DollarSign size={14}/> Rates</span>
        {sections.rates ? <ChevronUp size={15} style={{ color: "rgba(255,255,255,.6)" }}/> : <ChevronDown size={15} style={{ color: "rgba(255,255,255,.6)" }}/>}
      </button>
      {sections.rates && (
        <div style={{ ...card, borderRadius: "0 0 12px 12px", marginTop: 0 }}>
          <div style={{ ...row, background: colors.bg, borderBottom: `1px solid ${colors.border}` }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: colors.textMuted, flex: 1, textTransform: "uppercase", letterSpacing: ".05em" }}>School</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: colors.textMuted, width: 140, textAlign: "center", textTransform: "uppercase", letterSpacing: ".05em" }}>Individual / lesson</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: colors.textMuted, width: 140, textAlign: "center", textTransform: "uppercase", letterSpacing: ".05em" }}>Group / lesson</span>
          </div>
          {schools.length === 0 && <div style={{ padding: "20px 18px", color: colors.textMuted, fontSize: 13 }}>No schools added yet.</div>}
          {schools.filter(sc => sc.id !== "__private__").map(sc => (
            <div key={sc.id} style={row}>
              <span style={{ fontSize: 14, fontWeight: 600, color: colors.text, flex: 1 }}>{sc.name}</span>
              {["individual","group"].map(field => (
                <div key={field} style={{ width: 140, display: "flex", justifyContent: "center", alignItems: "center", gap: 3 }}>
                  <span style={{ fontSize: 13, color: colors.textMuted }}>$</span>
                  <input type="number" step="0.5" min="0" value={rates[sc.id]?.[field] ?? ""} placeholder="0.00"
                    onChange={e => setRate(sc.id, field, e.target.value)}
                    style={{ ...inp, width: 80, textAlign: "center" }}/>
                </div>
              ))}
            </div>
          ))}
          {/* Spec 4 cluster 7 — explicit private-students rate row. Appended
              independently of the schools array so the editor surfaces it even
              when the upstream schools collection doesn't yet contain the
              __private__ sentinel row. Group rate is not applicable for
              private students; the column renders an em-dash placeholder. */}
          <div key="__private__" style={rowLast}>
            <span style={{ fontSize: 14, fontWeight: 600, color: colors.text, flex: 1 }}>Private</span>
            <div style={{ width: 140, display: "flex", justifyContent: "center", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: 13, color: colors.textMuted }}>$</span>
              <input type="number" step="0.5" min="0" value={rates["__private__"]?.individual ?? ""} placeholder="0.00"
                onChange={e => setRate("__private__", "individual", e.target.value)}
                style={{ ...inp, width: 80, textAlign: "center" }}/>
            </div>
            <div style={{ width: 140, display: "flex", justifyContent: "center", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: colors.textMuted }}>—</span>
            </div>
          </div>
          <div style={{ padding: "10px 18px", borderTop: `1px solid ${colors.borderLight}`, background: colors.bg }}>
            <span style={{ fontSize: 12, color: colors.textMuted }}>Rates save automatically as you type.</span>
          </div>
        </div>
      )}

      {/* Term & Dates */}
      <button style={secHdr(sections.term)} onClick={() => setSections(p => ({ ...p, term: !p.term }))}>
        <span style={{ fontWeight: 700, fontSize: 14, color: "#fff", display: "flex", alignItems: "center", gap: 8 }}><Receipt size={14}/> Term & Invoice Dates</span>
        {sections.term ? <ChevronUp size={15} style={{ color: "rgba(255,255,255,.6)" }}/> : <ChevronDown size={15} style={{ color: "rgba(255,255,255,.6)" }}/>}
      </button>
      {sections.term && (
        <div style={{ ...card, borderRadius: "0 0 12px 12px", marginTop: 0 }}>
          {terms.length === 0 ? (
            <div style={{ padding: "20px 18px" }}>
              <div style={{ fontSize: 13, color: colors.textMuted, marginBottom: 10 }}>No term breaks found — add them in the Calendar tab first.</div>
              <div style={{ display: "flex", gap: 8, padding: "10px 14px", background: colors.amberLight, borderRadius: 8, border: `1px solid ${colors.amber}30` }}>
                <AlertTriangle size={14} style={{ color: colors.amber, flexShrink: 0, marginTop: 1 }}/>
                <span style={{ fontSize: 12, color: colors.amberDark }}>Use Settings → Fetch Term Dates to import Victorian school term dates.</span>
              </div>
            </div>
          ) : (
            <>
              <div style={row}>
                <span style={{ fontSize: 13, fontWeight: 600, color: colors.text, minWidth: 130 }}>Invoicing for</span>
                <select value={selIdx} onChange={e => setSelIdx(Number(e.target.value))} style={{ ...inp, flex: 1, maxWidth: 320 }}>
                  {terms.map((t, i) => <option key={i} value={i}>{t.label}  ({_fmtLong(t.start)} – {_fmtLong(t.end)})</option>)}
                </select>
              </div>
              <div style={row}>
                <span style={{ fontSize: 13, fontWeight: 600, color: colors.text, minWidth: 130 }}>Invoice date</span>
                <input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} style={inp}/>
                <span style={{ fontSize: 12, color: colors.textMuted }}>(auto: today)</span>
              </div>
              <div style={rowLast}>
                <span style={{ fontSize: 13, fontWeight: 600, color: colors.text, minWidth: 130 }}>Due date</span>
                <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={inp}/>
                <span style={{ fontSize: 12, color: colors.textMuted }}>(auto: Friday of Week 2)</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Generation Scope */}
      <div style={{ ...card, padding: "16px 18px", overflow: "visible" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: colors.text, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <Users size={14} style={{ color: colors.accent }}/> Generate invoices for
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: scopeType !== "all" ? 10 : 0 }}>
          {[["all","All parents"],["school","By school"],["parent","Specific parent"]].map(([val, label]) => (
            <button key={val} style={radio(scopeType === val)} onClick={() => { setScopeType(val); setConfirmRegen(false); }}>
              {label}
            </button>
          ))}
        </div>
        {scopeType === "school" && (
          <select value={scopeSchoolId} onChange={e => setScopeSchoolId(e.target.value)} style={{ ...inp, minWidth: 220, marginTop: 4 }}>
            <option value="">— select school —</option>
            {schools.map(sc => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
          </select>
        )}
        {scopeType === "parent" && (() => {
          const selectedParent = allParents.find(p => p.key === scopeParentKey);
          const suggestions = parentSearch.trim()
            ? allParents.filter(p =>
                p.name.toLowerCase().includes(parentSearch.toLowerCase()) ||
                p.email.toLowerCase().includes(parentSearch.toLowerCase())
              ).slice(0, 8)
            : [];
          return (
            <div style={{ position: "relative", marginTop: 4, zIndex: 100 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  value={selectedParent ? selectedParent.name : parentSearch}
                  onChange={e => { setParentSearch(e.target.value); setScopeParentKey(""); setShowParentSugg(true); }}
                  onFocus={() => setShowParentSugg(true)}
                  onBlur={() => setTimeout(() => setShowParentSugg(false), 150)}
                  placeholder="Search parent name or email…"
                  style={{ ...inp, minWidth: 300 }}
                />
                {scopeParentKey && (
                  <button onClick={() => { setScopeParentKey(""); setParentSearch(""); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, padding: 4, fontFamily: "inherit", fontSize: 13 }}>✕</button>
                )}
              </div>
              {showParentSugg && suggestions.length > 0 && (
                <div style={{ position: "absolute", bottom: "100%", left: 0, zIndex: 999, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,.12)", minWidth: 320, marginBottom: 3, overflow: "hidden" }}>
                  {suggestions.map(p => (
                    <button key={p.key}
                      onMouseDown={() => { setScopeParentKey(p.key); setParentSearch(""); setShowParentSugg(false); }}
                      style={{ display: "block", width: "100%", padding: "9px 14px", background: "none", border: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit", borderBottom: `1px solid ${colors.borderLight}` }}
                      onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                      onMouseLeave={e => e.currentTarget.style.background = "none"}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>{p.name}</span>
                      {p.email && <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 8 }}>{p.email}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Generate + Create buttons */}
      <div style={{ marginTop: 6 }}>
        {confirmRegen ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "14px 18px", background: colors.amberLight, borderRadius: 10, border: `1px solid ${colors.amber}40` }}>
            <AlertTriangle size={16} style={{ color: colors.amber, flexShrink: 0 }}/>
            <span style={{ fontSize: 13, color: colors.amberDark, flex: 1 }}>
              This will replace existing draft{scopeType === "all" ? "s" : ""} for the affected parent{scopeType !== "parent" ? "s" : ""}. Continue?
            </span>
            <Btn variant="danger" onClick={doGenerate}>Regenerate</Btn>
            <Btn variant="secondary" onClick={() => setConfirmRegen(false)}>Cancel</Btn>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Btn variant="primary"
              disabled={scopeType === "school" && !scopeSchoolId || scopeType === "parent" && !scopeParentKey}
              onClick={handleGenerate}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 24px", fontSize: 14 }}>
              <RefreshCw size={14}/>
              {scopeType === "parent" && scopeParentKey ? `Generate for ${allParents.find(p => p.key === scopeParentKey)?.name || "parent"}` :
               scopeType === "school" && scopeSchoolId ? `Generate for ${schools.find(s => s.id === scopeSchoolId)?.name || "school"}` :
               "Generate Invoices"}
            </Btn>
            <Btn variant="secondary"
              disabled={scopeType === "school" && !scopeSchoolId || scopeType === "parent" && !scopeParentKey}
              onClick={doCreateBlank}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 20px", fontSize: 14 }}
              title="Create a blank invoice to fill in manually — no auto-calculation">
              + Create Blank
            </Btn>
            {invoices.length > 0 && (
              <button onClick={() => setView("invoices")} style={{ fontSize: 13, color: colors.accent, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
                View {invoices.length} invoice{invoices.length !== 1 ? "s" : ""} →
              </button>
            )}
          </div>
        )}
      </div>

    </div>
  );

  // ─────────────────────────────────────────────────────────
  // INVOICE CARD
  // ─────────────────────────────────────────────────────────
  const renderCard = (inv) => {
    const open      = expandedIds.has(inv.id);
    const total     = inv.lines.reduce((s, l) => s + (l.subtotal || 0), 0);
    const isSent    = inv.status === "sent";
    const isPaid    = !!inv.paidAt;
    const isOverdue = isSent && !isPaid && !!inv.dueDate && inv.dueDate < _today();
    const payColor  = isPaid ? colors.success : isOverdue ? colors.danger : colors.textMuted;
    const payTitle  = isPaid ? `Paid ${_fmtLong(inv.paidAt?.slice(0,10))} — click to unmark` : isOverdue ? "Overdue — click to mark as paid" : "Unpaid — click to mark as paid";

    return (
      <div key={inv.id} style={card}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <button onClick={() => setExpandedIds(prev => { const n = new Set(prev); n.has(inv.id) ? n.delete(inv.id) : n.add(inv.id); return n; })}
            style={{ flex: 1, display: "flex", alignItems: "center", padding: "13px 18px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", gap: 12, textAlign: "left" }}>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: colors.text }}>{inv.parentName}</span>
              {inv.parentEmail && <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 10 }}>{inv.parentEmail}</span>}
            </div>
            <span style={{ fontSize: 11, color: colors.textMuted }}>#{inv.invoiceNumber}</span>
            <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 12, background: isSent ? `${colors.success}20` : colors.accentLight, color: isSent ? colors.success : colors.accent }}>
              {isSent ? "Sent" : "Draft"}
            </span>
            <span style={{ fontSize: 15, fontWeight: 700, color: colors.text, minWidth: 80, textAlign: "right" }}>{_fmtMoney(total)}</span>
            {open ? <ChevronUp size={16} style={{ color: colors.textMuted, flexShrink: 0 }}/> : <ChevronDown size={16} style={{ color: colors.textMuted, flexShrink: 0 }}/>}
          </button>
          {/* Session 98: inline Send button for drafts — skip the expand-and-click dance */}
          {!isSent && inv.parentEmail && (
            <button
              onClick={() => sendInv(inv)}
              title="Send invoice"
              style={{ flexShrink: 0, padding: "13px 14px", background: "none", border: "none", borderLeft: `1px solid ${colors.borderLight}`, cursor: "pointer", color: colors.accent, display: "flex", alignItems: "center", transition: "all 0.15s" }}
              onMouseEnter={e => { e.currentTarget.style.background = colors.accentLight; }}
              onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
              <Send size={14}/>
            </button>
          )}
          {/* Session 98: revert sent → draft for resends (and for the Term 2 Solway recovery) */}
          {isSent && (
            <button
              onClick={() => {
                if (window.confirm(`Revert invoice #${inv.invoiceNumber} for ${inv.parentName} back to draft? This clears the sent timestamp but keeps the invoice.`)) {
                  toggleSent(inv.id);
                }
              }}
              title="Revert to draft"
              style={{ flexShrink: 0, padding: "13px 14px", background: "none", border: "none", borderLeft: `1px solid ${colors.borderLight}`, cursor: "pointer", color: colors.textMuted, display: "flex", alignItems: "center", transition: "all 0.15s" }}
              onMouseEnter={e => { e.currentTarget.style.color = colors.accent; e.currentTarget.style.background = colors.accentLight; }}
              onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = "none"; }}>
              <RefreshCw size={14}/>
            </button>
          )}
          {isSent && (
            <button
              onClick={() => markPaid(inv.id)}
              title={payTitle}
              style={{ flexShrink: 0, padding: "13px 14px", background: "none", border: "none", borderLeft: `1px solid ${colors.borderLight}`, cursor: "pointer", color: payColor, display: "flex", alignItems: "center", transition: "color 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.opacity = "0.7"}
              onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
              <DollarSign size={14}/>
            </button>
          )}
          <button
            onClick={() => { if (window.confirm(`Delete invoice for ${inv.parentName}?`)) delInvoice(inv.id); }}
            title="Delete invoice"
            style={{ flexShrink: 0, padding: "13px 14px", background: "none", border: "none", borderLeft: `1px solid ${colors.borderLight}`, cursor: "pointer", color: colors.textMuted, display: "flex", alignItems: "center" }}
            onMouseEnter={e => { e.currentTarget.style.color = colors.danger; e.currentTarget.style.background = colors.redLight; }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = "none"; }}>
            <Trash2 size={14}/>
          </button>
        </div>

        {open && (
          <div style={{ borderTop: `1px solid ${colors.borderLight}` }}>
            <div style={{ padding: "9px 18px", background: colors.blueLight, borderBottom: `1px solid ${colors.border}`, display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ fontSize: 12, color: colors.textMuted, display: "inline-flex", alignItems: "center", gap: 6 }}>
                Invoice date:
                <input type="date" value={inv.invoiceDate || ""}
                  onChange={e => updInv(inv.id, i => ({ ...i, invoiceDate: e.target.value }))}
                  style={{ ...inp, padding: "4px 8px", fontSize: 12, fontWeight: 600, color: colors.text }}/>
              </label>
              <label style={{ fontSize: 12, color: colors.textMuted, display: "inline-flex", alignItems: "center", gap: 6 }}>
                Due:
                <input type="date" value={inv.dueDate || ""}
                  onChange={e => updInv(inv.id, i => ({ ...i, dueDate: e.target.value }))}
                  style={{ ...inp, padding: "4px 8px", fontSize: 12, fontWeight: 600, color: colors.text }}/>
              </label>
              <span style={{ fontSize: 12, color: colors.textMuted }}>{inv.termLabel}</span>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: colors.sidebarHover }}>
                    {["Description","Student","Qty","Rate","Subtotal",""].map((h, i) => (
                      <th key={i} style={{ padding: "8px 10px", fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,.8)", letterSpacing: ".06em", textAlign: i >= 2 && i <= 4 ? "center" : i === 5 ? "right" : "left", textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((line, li) => (
                    <tr key={line.id} style={{ background: colors.cardBg }}>
                      <td style={{ padding: "7px 10px" }}>
                        <input value={line.description} onChange={e => updLine(inv.id, line.id, "description", e.target.value)}
                          style={{ ...inp, width: "100%", maxWidth: 220 }}/>
                      </td>
                      <td style={{ padding: "7px 10px" }}>
                        <span style={{ fontSize: 12, color: colors.textMuted, whiteSpace: "nowrap" }}>{line.studentName || ""}</span>
                      </td>
                      <td style={{ padding: "7px 10px", textAlign: "center" }}>
                        <input type="number" min="0" value={line.qty} onChange={e => updLine(inv.id, line.id, "qty", e.target.value)}
                          style={{ ...inp, width: 60, textAlign: "center" }}/>
                      </td>
                      <td style={{ padding: "7px 10px", textAlign: "center" }}>
                        <input type="number" step="0.01" value={line.rate} onChange={e => updLine(inv.id, line.id, "rate", e.target.value)}
                          style={{ ...inp, width: 80, textAlign: "center" }}/>
                      </td>
                      <td style={{ padding: "7px 10px", textAlign: "center", fontWeight: 600, fontSize: 13, color: (line.subtotal || 0) < 0 ? colors.danger : colors.text, whiteSpace: "nowrap" }}>
                        {_fmtMoney(line.subtotal || 0)}
                      </td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>
                        <button onClick={() => delLine(inv.id, line.id)} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, display: "inline-flex", padding: 4, borderRadius: 4 }}
                          onMouseEnter={e => e.currentTarget.style.color = colors.danger}
                          onMouseLeave={e => e.currentTarget.style.color = colors.textMuted}>
                          <Trash2 size={13}/>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ padding: "12px 18px", borderTop: `1px solid ${colors.borderLight}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <button onClick={() => addLine(inv.id)}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: colors.accent, background: "none", border: `1px dashed ${colors.accent}60`, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontFamily: "inherit" }}
                onMouseEnter={e => e.currentTarget.style.background = colors.accentLight}
                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                <Plus size={13}/> Add line
              </button>
              <span style={{ fontSize: 15, fontWeight: 700, color: colors.text }}>
                Total: <span style={{ color: colors.accent }}>{_fmtMoney(total)}</span>
              </span>
            </div>

            <div style={{ padding: "10px 18px", borderTop: `1px solid ${colors.border}`, display: "flex", gap: 8, background: colors.blueLight, alignItems: "center" }}>
              <Btn variant="secondary" onClick={() => _openPrintWindow(inv, settings)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Eye size={13}/> Preview PDF
              </Btn>
              <Btn variant="primary" onClick={() => sendInv(inv)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Send size={13}/> Send
              </Btn>
              <button onClick={() => toggleSent(inv.id)}
                style={{ marginLeft: "auto", fontSize: 12, color: isSent ? colors.success : colors.textMuted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 5 }}>
                {isSent ? <><Check size={12}/> Marked sent</> : "Mark as sent"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ─────────────────────────────────────────────────────────
  // INVOICES VIEW
  // Nested accordion: School banners (exclusive open, school's custom colour)
  //   → Drafted / Sent sub-banners (non-exclusive, remembered per school)
  //     → Invoice cards (rendered via renderCard)
  // ─────────────────────────────────────────────────────────
  const _invTotal = (inv) => inv.lines.reduce((s, l) => s + (l.subtotal || 0), 0);

  const renderInvoices = () => {
    const sentN      = invoices.filter(i => i.status === "sent").length;
    const allTotal   = invoices.reduce((s, inv) => s + _invTotal(inv), 0);
    const sentTotal  = invoices.filter(i => i.status === "sent").reduce((s, inv) => s + _invTotal(inv), 0);
    const unsentTotal = allTotal - sentTotal;

    // Sort alphabetically for stable order within each group
    const sorted = [...invoices].sort((a, b) => a.parentName.localeCompare(b.parentName));

    // Derive which school(s) each invoice covers from its line schoolNames.
    // Per Matt: in practice each invoice belongs to exactly one school (or Private).
    // Parents with kids at two schools are registered per-school and get two
    // separate invoices — so defensive multi-school handling isn't needed.
    const invSchoolMap = {};
    for (const inv of sorted) {
      invSchoolMap[inv.id] = [...new Set(inv.lines.map(l => l.schoolName).filter(Boolean))];
    }

    // Build school groups in the order schools appear in the `schools` array
    // (preserves Matt's drag-reorder preference). Any invoice not matched to a
    // school falls into the Private group at the end.
    const groups = [];
    const assigned = new Set();
    for (const sc of schools) {
      const scInvs = sorted.filter(inv => (invSchoolMap[inv.id] || []).includes(sc.name));
      if (scInvs.length === 0) continue;
      scInvs.forEach(inv => assigned.add(inv.id));
      groups.push({
        id: sc.id, name: sc.name,
        color: sc.color || colors.sidebar,
        school: sc, isPrivate: false,
        invoices: scInvs,
      });
    }
    const privateInvs = sorted.filter(inv => !assigned.has(inv.id));
    if (privateInvs.length > 0) {
      groups.push({
        id: "__private__", name: "Private",
        color: colors.sidebar,
        school: null, isPrivate: true,
        invoices: privateInvs,
      });
    }

    // Search matches parent name or email. When active, all groups auto-expand
    // and both sub-banners auto-open, so matches are visible anywhere.
    const searchActive = invSearch.trim().length > 0;
    const matchesSearch = (inv) => {
      if (!searchActive) return true;
      const q = invSearch.toLowerCase();
      return inv.parentName.toLowerCase().includes(q) || (inv.parentEmail || "").toLowerCase().includes(q);
    };
    const visibleGroups = searchActive
      ? groups.filter(g => g.invoices.some(matchesSearch))
      : groups;

    // Sub-banner toggle — flips the named sub (draft|sent) for this school.
    // Default when no saved state: both closed. Once the user opens one, the
    // state is stored in openSubs[schoolId] and persists across close/re-open
    // of the parent school banner for this session.
    const toggleSub = (groupId, key) => {
      setOpenSubs(prev => {
        const cur = prev[groupId] || { draft: false, sent: false };
        return { ...prev, [groupId]: { ...cur, [key]: !cur[key] } };
      });
    };

    // Per-school bulk send — opens the compose modal for each parent in turn
    // so you can review + tweak + attach before clicking Send & Next. Session
    // 95: was a silent auto-queue (window._autoSendBatch). Now uses
    // _openComposeQueue so the modal re-renders for each recipient with full
    // template resolution, per-invoice attachment attached, and Skip + Cancel
    // All controls. setSent fires only when a specific invoice's email send
    // actually succeeds — not at queue time — so skipped invoices stay drafts.
    const handleBulkSendForGroup = async (group) => {
      const unsent = group.invoices.filter(inv => inv.status !== "sent" && inv.parentEmail && matchesSearch(inv));
      if (!unsent.length) { notify("No unsent invoices with email in this school.", "warning"); return; }
      if (!window._openComposeQueue) { notify("Compose queue not available", "warning"); return; }

      // Session 98: ensure invoice save folder is configured before doing
      // any of the PDF-gen work — no point spinning up renderer windows if
      // the user cancels the folder picker.
      const folder = await _ensureInvoiceFolder(notify);
      if (!folder) return;

      const bulkFromEmail = group.school?.senderEmail || "";

      // Session 98: PDFs are generated sequentially (not Promise.all) because
      // each printToPdf call spawns an offscreen BrowserWindow — doing 40 in
      // parallel would thrash memory and race the renderer. Sequential adds
      // ~0.5-1s per invoice; for 40 that's ~30s, surfaced as a progress toast.
      // Failed PDFs are dropped from the queue with a warning rather than
      // aborting the whole batch — better to send the 38 that worked than
      // block everyone because one had a rendering hiccup.
      notify(`Generating ${unsent.length} invoice PDF${unsent.length === 1 ? "" : "s"}…`, "info", 3000);
      setBulkSending?.(true);

      const queueItems = [];
      const failed = [];
      for (let i = 0; i < unsent.length; i++) {
        const inv = unsent[i];
        if (i % 5 === 0 && i > 0) {
          notify(`Generated ${i} of ${unsent.length}…`, "info", 2000);
        }
        const { attachment, error } = await _buildInvoicePdfAttachment(inv, settings);
        if (error || !attachment) {
          console.warn("[bulk send] PDF failed for", inv.parentName, error);
          failed.push(inv.parentName || `#${inv.invoiceNumber}`);
          continue;
        }
        queueItems.push({
          to: [inv.parentEmail],
          from: bulkFromEmail || undefined,
          subject: `Invoice #${inv.invoiceNumber} — Music Lessons ${inv.termLabel}`,
          body: "",
          triggerId: "invoice_send",
          mergeCtx: _invoiceMergeCtx(inv, settings),
          attachments: [attachment],
          // Per-item onSent — fires only when THIS invoice's send succeeds.
          // Closes cleanly if the user hits Skip. setSent is idempotent.
          onSent: () => setSent(inv.id),
        });
      }

      setBulkSending?.(false);

      if (!queueItems.length) {
        notify(`All ${unsent.length} PDFs failed to generate — no invoices queued`, "danger", 6000);
        return;
      }
      if (failed.length) {
        notify(`${failed.length} PDF${failed.length === 1 ? "" : "s"} failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`, "warning", 6000);
      }
      notify(`Ready to review ${queueItems.length} invoice${queueItems.length === 1 ? "" : "s"}`, "success", 2500);
      window._openComposeQueue(queueItems);
    };

    return (
      <div style={{ maxWidth: 900 }}>
        {/* Top bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
          <button onClick={() => setView("setup")} style={{ fontSize: 13, color: colors.accent, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
            ← Draft
          </button>
          <div style={{ width: 1, height: 16, background: colors.border }}/>
          <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>{invoices[0]?.termLabel || ""}</span>
          {invoices[0]?.invoiceDate && <span style={{ fontSize: 12, color: colors.textMuted }}>Invoice date: {_fmtLong(invoices[0].invoiceDate)}</span>}
          {invoices[0]?.dueDate     && <span style={{ fontSize: 12, color: colors.textMuted }}>Due: {_fmtLong(invoices[0].dueDate)}</span>}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 12, color: colors.success }}>{sentN} / {invoices.length} sent</span>
            {invoices.some(i => i.status !== "sent") && (
              <button
                onClick={() => {
                  // Session 95: Delete all only removes DRAFTS — sent invoices
                  // represent real billing records (they also exist in the
                  // shared Supabase invoices table once marked sent). Those
                  // must only be deleted one at a time via the per-row delete
                  // button. Count + confirm phrased to reflect drafts only.
                  const draftCount = invoices.filter(i => i.status !== "sent").length;
                  if (window.confirm(`Delete all ${draftCount} invoice draft${draftCount === 1 ? "" : "s"}? Sent invoices are preserved. This cannot be undone.`)) {
                    setInvoices(prev => prev.filter(i => i.status === "sent"));
                  }
                }}
                style={{ fontSize: 12, color: colors.textMuted, background: "none", border: `1px solid ${colors.border}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 5 }}
                onMouseEnter={e => { e.currentTarget.style.color = colors.danger; e.currentTarget.style.borderColor = colors.danger; }}
                onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.borderColor = colors.border; }}>
                <Trash2 size={12}/> Delete all drafts
              </button>
            )}
          </div>
        </div>

        {/* Search — auto-expands all folders when active */}
        {invoices.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
            <input
              value={invSearch} onChange={e => setInvSearch(e.target.value)}
              placeholder="Search by name or email…"
              style={{ ...inp, flex: 1 }}
            />
          </div>
        )}

        {invoices.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: colors.textMuted, fontSize: 14 }}>
            No invoices yet. Go back to Setup and click Generate.
          </div>
        )}

        {invoices.length > 0 && visibleGroups.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: colors.textMuted, fontSize: 13 }}>
            No invoices match your search.
          </div>
        )}

        {/* School accordion */}
        {visibleGroups.map(group => {
          const isOpen = searchActive || openSchoolId === group.id;
          const savedSubs = openSubs[group.id];
          const draftSubOpen = searchActive || (savedSubs ? savedSubs.draft : false);
          const sentSubOpen  = searchActive || (savedSubs ? savedSubs.sent  : false);

          const draftInvs = group.invoices.filter(i => i.status !== "sent" && matchesSearch(i));
          const sentInvs  = group.invoices.filter(i => i.status === "sent"  && matchesSearch(i));
          const visibleInvs = [...draftInvs, ...sentInvs];
          const groupTotal = visibleInvs.reduce((s, inv) => s + _invTotal(inv), 0);
          const draftTotal = draftInvs.reduce((s, inv) => s + _invTotal(inv), 0);
          const sentTotalG = sentInvs.reduce((s, inv) => s + _invTotal(inv), 0);

          return (
            <div key={group.id} style={{ marginBottom: 10, borderRadius: 10, overflow: "hidden", border: `1px solid ${colors.border}` }}>
              {/* School banner — in the school's custom colour */}
              <button
                onClick={() => setOpenSchoolId(isOpen && !searchActive ? null : group.id)}
                disabled={searchActive}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 12,
                  padding: "12px 16px", border: "none", cursor: searchActive ? "default" : "pointer",
                  fontFamily: "inherit", textAlign: "left",
                  background: group.color, color: "#fff",
                  borderBottom: isOpen ? `1px solid rgba(0,0,0,0.15)` : "none",
                }}>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 700, letterSpacing: "0.01em" }}>
                  {group.name}
                  <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, opacity: 0.75 }}>
                    ({visibleInvs.length} invoice{visibleInvs.length !== 1 ? "s" : ""})
                  </span>
                </span>
                <span style={{ fontSize: 15, fontWeight: 700, minWidth: 90, textAlign: "right" }}>
                  {_fmtMoney(groupTotal)}
                </span>
                {isOpen
                  ? <ChevronUp size={16} style={{ opacity: 0.85, flexShrink: 0 }}/>
                  : <ChevronDown size={16} style={{ opacity: 0.85, flexShrink: 0 }}/>}
              </button>

              {isOpen && (
                <div style={{ background: colors.bg }}>
                  {/* Drafted sub-banner */}
                  <button
                    onClick={() => toggleSub(group.id, "draft")}
                    disabled={searchActive}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 10,
                      padding: "10px 16px", border: "none",
                      borderBottom: `1px solid ${group.color}33`,
                      cursor: searchActive ? "default" : "pointer", fontFamily: "inherit", textAlign: "left",
                      background: `${group.color}1F`, color: group.color,
                    }}>
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      Drafted
                      <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 10, background: `${group.color}33`, color: group.color }}>
                        {draftInvs.length}
                      </span>
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: group.color, minWidth: 90, textAlign: "right" }}>
                      {_fmtMoney(draftTotal)}
                    </span>
                    {draftSubOpen
                      ? <ChevronUp size={14} style={{ color: group.color, opacity: 0.85, flexShrink: 0 }}/>
                      : <ChevronDown size={14} style={{ color: group.color, opacity: 0.85, flexShrink: 0 }}/>}
                  </button>
                  {draftSubOpen && (
                    <div>
                      {draftInvs.length === 0 && (
                        <div style={{ padding: "14px 18px", color: colors.textMuted, fontSize: 12, fontStyle: "italic" }}>
                          No drafts.
                        </div>
                      )}
                      {draftInvs.length > 0 && !group.isPrivate && (
                        <div style={{ padding: "10px 16px", borderBottom: `1px solid ${colors.borderLight}`, background: colors.cardBg, display: "flex", justifyContent: "flex-end" }}>
                          <button onClick={() => handleBulkSendForGroup(group)} disabled={bulkSending}
                            style={{ padding: "6px 14px", borderRadius: 7, border: "none", background: colors.sidebar, color: "#fff", fontSize: 12, fontWeight: 600, cursor: bulkSending ? "wait" : "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6, opacity: bulkSending ? 0.6 : 1 }}
                            onMouseEnter={e => { if (!bulkSending) e.currentTarget.style.background = colors.sidebarHover; }}
                            onMouseLeave={e => e.currentTarget.style.background = colors.sidebar}>
                            <Send size={12}/> {bulkSending ? "Sending…" : `Send all (${group.name})`}
                          </button>
                        </div>
                      )}
                      {draftInvs.map(renderCard)}
                    </div>
                  )}

                  {/* Sent sub-banner */}
                  <button
                    onClick={() => toggleSub(group.id, "sent")}
                    disabled={searchActive}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 10,
                      padding: "10px 16px", border: "none",
                      borderTop: `1px solid ${group.color}33`,
                      cursor: searchActive ? "default" : "pointer", fontFamily: "inherit", textAlign: "left",
                      background: `${group.color}1F`, color: group.color,
                    }}>
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      Sent
                      <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 10, background: sentInvs.length > 0 ? `${colors.success}33` : `${group.color}33`, color: sentInvs.length > 0 ? colors.success : group.color }}>
                        {sentInvs.length}
                      </span>
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: group.color, minWidth: 90, textAlign: "right" }}>
                      {_fmtMoney(sentTotalG)}
                    </span>
                    {sentSubOpen
                      ? <ChevronUp size={14} style={{ color: group.color, opacity: 0.85, flexShrink: 0 }}/>
                      : <ChevronDown size={14} style={{ color: group.color, opacity: 0.85, flexShrink: 0 }}/>}
                  </button>
                  {sentSubOpen && (
                    <div>
                      {sentInvs.length === 0 && (
                        <div style={{ padding: "14px 18px", color: colors.textMuted, fontSize: 12, fontStyle: "italic" }}>
                          Nothing sent yet.
                        </div>
                      )}
                      {/* Session 98: bulk revert — needed for the Term 2 2026 Solway
                          recovery (40 invoices sent with broken attachments); kept
                          as a general tool for any future resend scenario. */}
                      {sentInvs.length > 0 && !group.isPrivate && (
                        <div style={{ padding: "10px 16px", borderBottom: `1px solid ${colors.borderLight}`, background: colors.cardBg, display: "flex", justifyContent: "flex-end" }}>
                          <button
                            onClick={() => {
                              const n = sentInvs.length;
                              if (window.confirm(`Revert all ${n} sent invoice${n === 1 ? "" : "s"} for ${group.name} back to draft?\n\nThis clears the sent timestamps but keeps the invoices. Use this when you need to resend (e.g. with a new template).`)) {
                                sentInvs.forEach(inv => toggleSent(inv.id));
                                notify(`Reverted ${n} invoice${n === 1 ? "" : "s"} to draft`, "success", 3500);
                              }
                            }}
                            style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${colors.border}`, background: "transparent", color: colors.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}
                            onMouseEnter={e => { e.currentTarget.style.color = colors.accent; e.currentTarget.style.borderColor = colors.accent; }}
                            onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.borderColor = colors.border; }}>
                            <RefreshCw size={12}/> Revert all to draft
                          </button>
                        </div>
                      )}
                      {sentInvs.map(renderCard)}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Grand total footer */}
        {invoices.length > 0 && (
          <div style={{ marginTop: 14, padding: "16px 20px", background: colors.sidebar, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "rgba(255,255,255,.45)", marginBottom: 3 }}>Total invoiced</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{_fmtMoney(allTotal)}</div>
              </div>
              {sentN > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "rgba(255,255,255,.45)", marginBottom: 3 }}>Sent ({sentN})</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: colors.success }}>{_fmtMoney(sentTotal)}</div>
                </div>
              )}
              {sentN < invoices.length && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "rgba(255,255,255,.45)", marginBottom: 3 }}>Unsent ({invoices.length - sentN})</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: colors.accent }}>{_fmtMoney(unsentTotal)}</div>
                </div>
              )}
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,.35)" }}>{invoices.length} invoice{invoices.length !== 1 ? "s" : ""}</div>
          </div>
        )}
      </div>
    );
  };

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────
  return (
    <div>
      <PageTitle
        pageColor={colors.sidebarActive}
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory}/>}
      >
        Invoicing
      </PageTitle>
      <div style={{ padding: "28px 36px" }}>
        {view === "setup" ? renderSetup() : renderInvoices()}
      </div>
    </div>
  );
}
