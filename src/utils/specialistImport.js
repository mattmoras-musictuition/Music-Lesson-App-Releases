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
    return { ...r, importedClass: imported, className: m.name };
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
