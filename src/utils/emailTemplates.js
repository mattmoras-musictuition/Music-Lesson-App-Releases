// ============================================================
// EMAIL TEMPLATES
// Template loading, saving, merge-tag resolution, and the
// user-created template store.
// ============================================================

import { STORAGE_KEYS, TALLY_EMAIL_TEMPLATES } from "../constants";

// ── User template store ───────────────────────────────────────────────────────

// Load user-created templates from localStorage
export function getUserTemplates() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.userTemplates);
    return stored ? JSON.parse(stored) : [];
  } catch(e) { return []; }
}

export function saveUserTemplates(templates) {
  try {
    localStorage.setItem(STORAGE_KEYS.userTemplates, JSON.stringify(templates));
  } catch(e) {}
}

// ── Name helpers ──────────────────────────────────────────────────────────────

// Extract display first name: prefers bracketed preferred name e.g. "Jennifer (Jenny) Smith" → "Jenny",
// otherwise returns the first word of the name.
export function preferredFirstName(fullName) {
  if (!fullName) return "";
  const bracketed = fullName.match(/\(([^)]+)\)/);
  if (bracketed) return bracketed[1].trim();
  return fullName.trim().split(/\s+/)[0];
}

// ── Merge tag helpers ─────────────────────────────────────────────────────────

// Apply template merge tags to a string given a context object
export function applyMergeCtx(str, ctx) {
  if (!str || !ctx) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => ctx[k] !== undefined ? ctx[k] : `{{${k}}}`);
}

// ── Active template set ───────────────────────────────────────────────────────

// Returns the active template set — localStorage overrides per reason, falls back to built-in defaults.
export function getEmailTemplates() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.emailTemplates);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Merge: stored entries win, missing reasons fall back to built-in
      return { ...TALLY_EMAIL_TEMPLATES, ...parsed };
    }
  } catch(e) {}
  return { ...TALLY_EMAIL_TEMPLATES };
}

// Substitute {{field}} placeholders in a template subject/body.
// ctx: { studentName, parentName, instrument, day, weekLabel, teacherName, schoolName }
export function resolveTemplate(template, ctx) {
  const fields = {
    student_name: ctx.studentName || "",
    parent_name:  ctx.parentName  || "there",
    instrument:   ctx.instrument  || "",
    day:          ctx.day         || "",
    week_label:   ctx.weekLabel   || "",
    teacher_name: ctx.teacherName || "",
    school_name:  ctx.schoolName  || "",
  };
  const sub = (str) => str.replace(/\{\{(\w+)\}\}/g, (_, k) => k in fields ? fields[k] : `{{${k}}}`);
  return { subject: sub(template.subject), body: sub(template.body) };
}
