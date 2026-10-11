// ============================================================
// SPECIALIST IMPORT HELPERS (pure)
// Every specialist check matches a student's class name letter for letter,
// so imported class codes are mapped onto the school's own class names
// ("34D" → "3/4D") before they are saved.
// ============================================================

// Lowercase, letters and digits only: "3/4D" → "34d", "P/1M" → "p1m".
export function classKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Distinct class names of the school's active students (the names every
// clash check compares against). Specialist entries are not a source.
export function knownClassNames(students, schoolId) {
  const names = new Set();
  for (const s of students || []) {
    if (s && s.schoolId === schoolId && s.status === "active" && s.className && s.className.trim()) names.add(s.className.trim());
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// One imported code against the known names →
// { name, status }: "same" (already a known name), "mapped" (exactly one
// known name shares its key), "ambiguous" (two or more do), "unmatched"
// (none do), or "unchecked" (the school has no known names yet).
export function mapClassName(code, known) {
  const raw = String(code || "").trim();
  if (!known || known.length === 0) return { name: raw, status: "unchecked" };
  if (known.includes(raw)) return { name: raw, status: "same" };
  const k = classKey(raw);
  const hits = k ? known.filter(n => classKey(n) === k) : [];
  if (hits.length === 1) return { name: hits[0], status: "mapped" };
  return { name: raw, status: hits.length > 1 ? "ambiguous" : "unmatched" };
}

// Map every row's class. Each row keeps the code it was imported with
// (importedClass) so a later school change re-maps from the original.
// Returns { rows, mapping: [{ from, to }], unmatched: [code] } — mapping and
// unmatched list each distinct code once.
export function mapImportedClasses(rows, known) {
  const mapping = [];
  const unmatched = [];
  const seen = new Set();
  const out = (rows || []).map(r => {
    const imported = r.importedClass != null ? r.importedClass : r.className;
    const m = mapClassName(imported, known);
    if (!seen.has(imported)) {
      seen.add(imported);
      if (m.status === "mapped") mapping.push({ from: imported, to: m.name });
      if (m.status === "unmatched" || m.status === "ambiguous") unmatched.push(imported);
    }
    // autoClass = what the mapping chose; committedClass = the class as last
    // committed; classHandled = set by hand or filled from a hand edit;
    // classHandEdited = the owner typed or picked this row's class.
    return { ...r, importedClass: imported, className: m.name, autoClass: m.name, committedClass: m.name, classHandled: false, classHandEdited: false };
  });
  return { rows: out, mapping, unmatched };
}

// Whether a class name needs the owner's attention on Review: the school has
// known names and this isn't one of them.
export function isUnmatchedClass(className, known) {
  return !!(known && known.length > 0 && !known.includes(String(className || "").trim()));
}

// The fields a specialist entry is saved with (drops Review-only fields).
export function toSpecialistEntry(r) {
  return { id: r.id, schoolId: r.schoolId, className: r.className, day: r.day, start: r.start, end: r.end, subject: r.subject, notes: r.notes || "" };
}

// Replace one school's specialist entries. `fresh` is the list just re-read
// from the database; other schools' rows are kept exactly, this school's
// rows are all removed, and the reviewed rows are added with ids unique
// across the whole list. Refuses an empty reviewed set.
// Returns { list, removed, added }.
export function swapSchoolEntries(fresh, schoolId, reviewed, makeId) {
  if (!schoolId) throw new Error("No school chosen.");
  if (!reviewed || reviewed.length === 0) throw new Error("There are no reviewed entries to replace them with.");
  const others = (fresh || []).filter(s => s.schoolId !== schoolId);
  const removed = (fresh || []).filter(s => s.schoolId === schoolId);
  const used = new Set(others.map(s => s.id));
  const added = reviewed.map(r => {
    let id = r.id;
    while (!id || used.has(id)) id = makeId();
    used.add(id);
    return { ...r, id, schoolId };
  });
  return { list: [...others, ...added], removed, added };
}

// The app_settings value holding the rows a Replace removed (one backup,
// overwritten by the next Replace).
export const REPLACED_BACKUP_KEY = "specialists_last_replaced";
export function buildReplacedBackup({ schoolId, schoolName, rows, replacedAt }) {
  return { schoolId, schoolName: schoolName || "", replacedAt, count: rows.length, rows };
}

// Per-school import Instructions, kept in app_settings as one key holding
// { [schoolId]: text }. Pure read/merge helpers; specialistsDB does the I/O.
export const INSTRUCTIONS_KEY = "specialist_import_instructions";

export function normalizeInstructionsMap(value) {
  const out = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) if (k && typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

// Set one school's text; an emptied box removes the school's entry.
export function mergeInstructions(map, schoolId, text) {
  const next = { ...normalizeInstructionsMap(map) };
  if (!schoolId) return next;
  if (text && text.trim()) next[schoolId] = text;
  else delete next[schoolId];
  return next;
}

// Every saved entry needs a start and an end time.
export function hasTimes(row) {
  return !!(row && String(row.start || "").trim() && String(row.end || "").trim());
}

export function countRowsNeedingTimes(rows) {
  return (rows || []).filter(r => !hasTimes(r)).length;
}

// ── Review hand edits (v2.49.23) ──

// A row is outlined amber only while its class matches no student AND the
// owner hasn't set it by hand.
export function needsClassAttention(row, known) {
  return !!row && !row.classHandled && isUnmatchedClass(row.className, known);
}

// Imported codes that still have rows needing attention (the "No matching
// student class" line), each once, in row order.
export function unhandledUnmatchedCodes(rows, known) {
  const out = [];
  for (const r of rows || []) {
    if (!needsClassAttention(r, known)) continue;
    const code = r.importedClass != null ? r.importedClass : r.className;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

// The owner committed a class on row `idx` (blur, Enter or the dropdown);
// keystrokes have already put the typed text in row.className. The row is
// then set by hand (classHandEdited) and never amber again. If it came from
// an unmatched imported code, every other row of that code still showing the
// row's previous value — untouched rows, or rows filled by an earlier edit —
// gets the same value; rows the owner typed into themselves are left alone.
// Returns { rows, changedOthers, from, to }.
export function applyClassEdit(rows, idx, value, known) {
  const row = rows[idx];
  const none = { rows, changedOthers: 0, from: null, to: null };
  if (!row) return none;
  const next = String(value == null ? row.className : value).trim();
  const auto = row.autoClass != null ? row.autoClass : row.className;
  const prev = row.committedClass != null ? row.committedClass : auto;
  if (next === prev && (row.classHandled || next === auto)) {
    return row.className === next ? none : { ...none, rows: rows.map((r, i) => (i === idx ? { ...r, className: next } : r)) };
  }
  const code = row.importedClass != null ? row.importedClass : auto;
  const spread = isUnmatchedClass(auto, known);
  let changedOthers = 0;
  const out = rows.map((r, i) => {
    if (i === idx) return { ...r, className: next, committedClass: next, classHandled: true, classHandEdited: true };
    if (spread && !r.classHandEdited && r.importedClass === code && r.className === prev) {
      changedOthers++;
      return { ...r, className: next, committedClass: next, classHandled: true };
    }
    return r;
  });
  return { rows: out, changedOthers, from: prev, to: next };
}

// Why Import is greyed out, as short lines shown beside the button.
export function importDisabledReasons({ existingCount = 0, mode = null, needTimes = 0 } = {}) {
  const reasons = [];
  if (existingCount > 0 && !mode) reasons.push("Choose Replace or Add above");
  if (needTimes > 0) reasons.push(`${needTimes} row${needTimes === 1 ? " needs" : "s need"} times`);
  return reasons;
}
