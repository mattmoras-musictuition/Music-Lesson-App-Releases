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

// ── Custom merge fields (Session 97) ─────────────────────────────────────────
// Each entry: { id, name, value }. `name` is the token WITHOUT braces
// (e.g. "signature", "lesson_time"). `value` is the replacement text, which
// can itself contain {{...}} tags — applyMergeCtx recurses so nested
// references work (e.g. a custom `greeting` = "Hi {{parent_name}},").
// A custom field whose `name` matches a built-in token overrides the
// built-in at resolve time.

export function getCustomMergeFields() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.customMergeFields);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch(e) { return []; }
}

export function saveCustomMergeFields(fields) {
  try {
    localStorage.setItem(STORAGE_KEYS.customMergeFields, JSON.stringify(fields));
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

// ── School helpers ────────────────────────────────────────────────────────────

// Session 95: resolves a display acronym for a school. Prefers the explicit
// school.acronym field (edited in SchoolsManager); falls back to initials of
// the name's words (matches SchoolsManager's "leave blank to auto-derive"
// behaviour). Used by the Templates editor chip and the ComposeModal dropdown.
export function schoolAcronym(school) {
  if (!school) return "";
  if (school.acronym) return school.acronym.toUpperCase();
  return (school.name || "")
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0])
    .join("")
    .toUpperCase();
}

// Session 95: resolves a school ID from a sender email by matching against
// schools[].senderEmail. Used by ComposeModal to figure out which school tag
// to prefer when auto-selecting a default template.
export function schoolIdForSenderEmail(schools, senderEmail) {
  if (!senderEmail || !Array.isArray(schools)) return null;
  const lower = senderEmail.toLowerCase();
  const hit = schools.find(s => (s.senderEmail || "").toLowerCase() === lower);
  return hit?.id || null;
}

// Session 95: picks the best template for a (triggerId, schoolId) pair.
// Precedence (highest first):
//   1. isDefault === true AND matching schoolId
//   2. isDefault === true AND no schoolId (generic default)
//   3. any matching schoolId
//   4. any for the trigger (fallback — matches old single-trigger behaviour)
//   5. null if no templates exist for the trigger
export function pickDefaultTemplate(templates, triggerId, schoolId) {
  if (!Array.isArray(templates) || !triggerId) return null;
  const forTrigger = templates.filter(t => t.triggerId === triggerId);
  if (forTrigger.length === 0) return null;
  if (schoolId) {
    const schoolDefault = forTrigger.find(t => t.isDefault && t.schoolId === schoolId);
    if (schoolDefault) return schoolDefault;
  }
  const genericDefault = forTrigger.find(t => t.isDefault && !t.schoolId);
  if (genericDefault) return genericDefault;
  if (schoolId) {
    const schoolAny = forTrigger.find(t => t.schoolId === schoolId);
    if (schoolAny) return schoolAny;
  }
  return forTrigger[0];
}

// ── Merge tag helpers ─────────────────────────────────────────────────────────

// Session 97: applyMergeCtx now recurses and checks the custom-merge-fields
// store before falling back to the ctx object. Resolution order per match:
//   1. If a custom field with that name exists → substitute its value
//   2. Else if ctx has that key → substitute ctx[k]
//   3. Else leave the {{k}} in place (so the user can see the bad reference)
// After each pass we loop again on the result so nested {{...}} references
// inside custom values resolve too. Capped at MAX_DEPTH iterations to catch
// cycles (e.g. custom a = "{{b}}", custom b = "{{a}}"). Customs are loaded
// lazily from localStorage each call — the store is tiny, the cost is trivial,
// and it means newly-saved fields take effect immediately.
const _MERGE_MAX_DEPTH = 10;

export function applyMergeCtx(str, ctx) {
  if (!str) return str;
  const safeCtx = ctx || {};
  const customs = getCustomMergeFields();
  const customMap = {};
  for (const c of customs) {
    const name = (c && c.name ? String(c.name) : "").trim();
    if (name) customMap[name] = c.value || "";
  }
  let current = String(str);
  for (let depth = 0; depth < _MERGE_MAX_DEPTH; depth++) {
    const next = current.replace(/\{\{(\w+)\}\}/g, (whole, k) => {
      if (Object.prototype.hasOwnProperty.call(customMap, k)) return customMap[k];
      if (safeCtx[k] !== undefined && safeCtx[k] !== null) return safeCtx[k];
      return whole;
    });
    // Session 97: exit on stable output rather than "did we attempt any
    // substitution" — catches self-references (e.g. a custom field whose
    // value IS its own token) without burning all 10 iterations.
    if (next === current) break;
    current = next;
  }
  return current;
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
// Session 97: routes through applyMergeCtx so custom merge fields work here
// too (was previously a local substitution loop that ignored customs).
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
  return {
    subject: applyMergeCtx(template.subject, fields),
    body:    applyMergeCtx(template.body, fields),
  };
}
