// ============================================================
// studentName.js — preferred-name display (Student Notes tab)
//
// Student names are stored as a single string; there is no structured
// preferred-name field. A preferred name may be embedded in the
// "Given (Preferred) Last" form, e.g. "Megumi (Meg) Van Haven". These
// helpers surface the preferred name for display. Same intent as
// MyWeek's buildPreferredDisplayName; kept as a small shared util so
// the Student Notes tab can reuse it without touching MyWeek.
//
// The match is anchored to the "Given (Preferred) …" position so a
// placeholder like "(unknown student)" (no leading given name) is left
// untouched rather than mangled.
// ============================================================

// Full display name using the preferred first name when present:
//   "Megumi (Meg) Van Haven" -> "Meg Van Haven"
//   "Megumi (Meg)"           -> "Meg"
//   "Bob Smith" / no parens  -> unchanged
export function preferredDisplayName(name) {
  if (!name) return name;
  const m = name.match(/^([^\s(]+)\s*\(([^)]+)\)\s*(.*)$/);
  if (!m) return name;
  const pref = m[2].trim();
  const rest = m[3].trim();
  return rest ? `${pref} ${rest}` : pref;
}

// Preferred first name only:
//   "Megumi (Meg) Van Haven" -> "Meg"
//   "Bob Smith" / no parens  -> "Bob" (first whitespace-separated token)
export function preferredFirstName(name) {
  const t = (name || "").trim();
  if (!t) return "";
  const m = t.match(/^([^\s(]+)\s*\(([^)]+)\)/);
  if (m) return m[2].trim();
  return t.split(/\s+/)[0];
}
