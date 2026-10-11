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
