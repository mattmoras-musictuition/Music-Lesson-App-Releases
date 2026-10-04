// ============================================================
// bandsSync.js — pure helpers behind bandsDB.js and BandsManager
// ============================================================
//
// No Supabase import, so the smoke tests can exercise every band
// write path without a client. bandsDB.js does the I/O; this file
// decides WHAT is written and how the in-memory list changes.
//
// Mappers allow-list columns in BOTH directions. A column missing
// from either mapper vanishes silently, so if the bands schema gains
// a column, both rowToBand and bandToRow must learn about it.

export function rowToBand(row) {
  return {
    id:                row.id,
    name:              row.name               || "",
    schoolId:          row.school_id          || "",
    teacherId:         row.teacher_id         || "",
    teacherInstrument: row.teacher_instrument || "",
    // Cosmetic personnel list [{teacherId, instrument}] — display-only,
    // replaces the legacy teacher_id+teacher_instrument pair for admin logic.
    // The legacy columns are still mapped because the teacher app writes them.
    personnel:         row.personnel          || [],
    members:           row.members            || [],
    links:             row.links              || [],
    notes:             row.notes              || "",
  };
}

export function bandToRow(band, userId) {
  return {
    id:                 band.id,
    user_id:            userId,
    name:               band.name               || "",
    school_id:          band.schoolId           || "",
    teacher_id:         band.teacherId          || "",
    teacher_instrument: band.teacherInstrument  || "",
    personnel:          band.personnel          || [],
    members:            band.members            || [],
    links:              band.links              || [],
    notes:              band.notes              || "",
  };
}

// BandsManager Save: a new band is appended, an edited one replaces the
// entry with the same id in place.
export function applyBandSave(bands, band, isNew) {
  if (isNew) return [...bands, band];
  return bands.map(b => b.id === band.id ? band : b);
}

// BandsManager Delete.
export function applyBandDelete(bands, id) {
  return bands.filter(b => b.id !== id);
}

// v2.41.2 per-row writes. Only the band the admin actually saved is
// upserted (stamped with the admin's user_id, which re-owns a band a
// teacher created), and only an explicitly deleted band is deleted, by id.
// There is no sweep: rows the admin never touched — including bands a
// teacher created or edited since the admin loaded — are never written.
// null when signed out.
export function planBandUpsert(band, userId) {
  if (!userId || !band || !band.id) return null;
  return bandToRow(band, userId);
}

// v2.41.2 freshness. Merges a fresh server list into the in-memory list
// when the Bands page opens or the window regains focus, so bands a teacher
// created or edited appear without a restart.
//   - Server wins for every row the admin has no write in flight for.
//   - pendingSaves (Map id → band): the admin's save is still in flight, so
//     the local version wins; a new band not yet on the server is kept.
//   - pendingDeletes (Set of ids): the admin's delete is still in flight, so
//     the band is NOT resurrected even though the server still returns it.
//   - Rows in memory but absent from the server (and not pending) are
//     dropped: they were deleted elsewhere.
//   - An empty server list is treated like the startup fallback: the
//     in-memory list is kept rather than blanked.
// Unchanged rows keep their in-memory object, and an unchanged list returns
// `local` itself, so a refresh that finds nothing new re-renders nothing.
export function reconcileBands(local, server, { pendingSaves = new Map(), pendingDeletes = new Set() } = {}) {
  if (!Array.isArray(server) || server.length === 0) return local;
  const localById = new Map((local || []).map(b => [b.id, b]));
  const same = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
  const out = [];
  const seen = new Set();
  for (const s of server) {
    if (pendingDeletes.has(s.id)) continue;
    const next = pendingSaves.has(s.id) ? pendingSaves.get(s.id) : s;
    const prev = localById.get(s.id);
    out.push(same(prev, next) ? prev : next);
    seen.add(s.id);
  }
  for (const [id, b] of pendingSaves) {
    if (seen.has(id) || pendingDeletes.has(id)) continue;
    const prev = localById.get(id);
    out.push(same(prev, b) ? prev : b);
  }
  const unchanged = out.length === (local || []).length && out.every((b, i) => b === local[i]);
  return unchanged ? local : out;
}

// A refresh response is stale — and must be ignored — when a newer refresh
// has started since, or when a band write started after this refresh did
// (the response may predate that write; the next refresh picks it up).
export function isStaleBandsRefresh({ refreshSeq, latestRefreshSeq, writeSeqAtStart, writeSeqNow }) {
  return refreshSeq !== latestRefreshSeq || writeSeqAtStart !== writeSeqNow;
}

// ── Groups on a band (v2.43.0) ──────────────────────────────────────
// A group joins a band as one unit. members[] stays one record per student
// (every members[] consumer keeps working); a group's members carry
// viaGroupId + groupName. Membership is copied when the group is added —
// later changes to the group are not followed (remove and re-add).

// Edit Band "Add group". Every current group member is added with the marker
// and the group's instrument; a student already on the band individually is
// CONVERTED in place (same record id and position) rather than duplicated —
// their second instrument goes, as a group row has one instrument. A student
// already on the band through a DIFFERENT group is left as they are.
export function addGroupToMembers(members, group, newId) {
  const list = members || [];
  if (!group || !group.id) return list;
  if (list.some(m => m && m.viaGroupId === group.id)) return list;
  const marker = { viaGroupId: group.id, groupName: group.name || "", instrument: group.instrument || "" };
  const ids = (group.studentIds || []).filter(Boolean);
  const out = list.map(m => {
    if (!m || !ids.includes(m.studentId) || m.viaGroupId) return m;
    const { instrument2, ...rest } = m;
    return { ...rest, ...marker };
  });
  for (const sid of ids) {
    if (out.some(m => m && m.studentId === sid)) continue;
    out.push({ id: newId(), studentId: sid, ...marker });
  }
  return out;
}

// Edit Band group row's remove control: every member of that group goes.
export function removeGroupFromMembers(members, groupId) {
  return (members || []).filter(m => !(m && m.viaGroupId === groupId));
}

// Edit Band group row's single instrument control.
export function setGroupInstrument(members, groupId, instrument) {
  return (members || []).map(m => (m && m.viaGroupId === groupId ? { ...m, instrument } : m));
}

// The roster split for display: individuals in order, then one block per
// group in first-appearance order ({ groupId, groupName, instrument, members }).
export function bandRosterBlocks(members) {
  const individuals = [];
  const groups = [];
  const byId = new Map();
  for (const m of (members || [])) {
    if (!m) continue;
    if (!m.viaGroupId) { individuals.push(m); continue; }
    if (!byId.has(m.viaGroupId)) {
      const g = { groupId: m.viaGroupId, groupName: m.groupName || "", instrument: m.instrument || "", members: [] };
      byId.set(m.viaGroupId, g);
      groups.push(g);
    }
    byId.get(m.viaGroupId).members.push(m);
  }
  return { individuals, groups };
}

// ── Group display (v2.43.1) ─────────────────────────────────────────
// Display only: owner-visible text names a group in a band by its MEMBERS,
// never by the group's own name. Nothing here changes members[] shape,
// memberStates or matching.

// Student ids in the group's OWN member order (group.studentIds); ids the
// group doesn't list keep their relative order after it. No group → as given.
export function orderByGroup(studentIds, group) {
  const ids = studentIds || [];
  const order = (group && group.studentIds) || [];
  if (order.length === 0) return [...ids];
  const rank = (sid) => { const i = order.indexOf(sid); return i === -1 ? order.length : i; };
  return ids.map((sid, i) => [sid, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
}

// Full names (or first names) for student ids, in the order given. A student
// who can't be found is skipped.
export function studentNamesFor(studentIds, students, { first = false } = {}) {
  return (studentIds || []).map(sid => {
    const name = ((students || []).find(s => s && s.id === sid) || {}).name || "";
    return first ? name.split(" ")[0] : name;
  }).filter(Boolean);
}

// "Ivy, Libby's group lesson" — the noun form for a group in a sentence.
export function groupLessonNoun(firstNames) {
  const list = (firstNames || []).filter(Boolean);
  return list.length ? `${list.join(", ")}'s group lesson` : "the group lesson";
}

// The instrument a group brings to a band when it is added: the group's own
// instrument; if blank, the instrument of the members' group enrolments when
// every member has one and they all agree (case-insensitive); otherwise "".
// "Group" (the placeholder a blank-instrument group's cards carry) never
// counts as an instrument. Display/default only — reads enrolments, writes
// nothing. A member's group enrolment here is an un-ended isGroup row for
// this group, or else their only un-ended isGroup row with no groupId.
export function defaultGroupInstrument(group, enrolments) {
  if (!group) return "";
  const own = (group.instrument || "").trim();
  if (own && own.toLowerCase() !== "group") return own;
  const ids = group.studentIds || [];
  if (ids.length === 0) return "";
  const list = enrolments || [];
  let agreed = null;
  for (const sid of ids) {
    const live = list.filter(e => e && e.isGroup && e.studentId === sid && !e.endDate);
    const byGroup = live.filter(e => e.groupId === group.id);
    const noGid = live.filter(e => !e.groupId);
    const rows = byGroup.length > 0 ? byGroup : (noGid.length === 1 ? noGid : []);
    const insts = [...new Set(rows.map(e => (e.instrument || "").trim()).filter(i => i && i.toLowerCase() !== "group"))];
    if (insts.length !== 1) return "";
    if (agreed === null) agreed = insts[0];
    else if (agreed.toLowerCase() !== insts[0].toLowerCase()) return "";
  }
  return agreed || "";
}

// Edit Band "Search students to add…" results: the matching students exactly
// as before (same school, active, not on the band, name contains the query,
// first 6), followed by matching GROUPS — same school, with members, not
// already on the band — where the query is in the group's name or in any
// member's name. A group result is { kind: "group", group, label } with the
// label its members' full names in the group's order; a student result is
// { kind: "student", student }. Empty query → [].
export function bandMemberSearchResults({ query, schoolId, students, groups, members, limit = 6 }) {
  const q = query || "";
  if (q.trim().length === 0) return [];
  const needle = q.toLowerCase();
  const onBand = members || [];
  const studentHits = (students || []).filter(s => s.schoolId === schoolId && s.status === "active"
    && !onBand.some(m => m.studentId === s.id) && s.name.toLowerCase().includes(needle)).slice(0, limit)
    .map(student => ({ kind: "student", student }));
  const groupHits = (groups || []).filter(g => g && g.schoolId === schoolId && (g.studentIds || []).length > 0
    && !onBand.some(m => m && m.viaGroupId === g.id)
    && ((g.name || "").toLowerCase().includes(needle)
      || studentNamesFor(g.studentIds, students).some(n => n.toLowerCase().includes(needle))))
    .slice(0, limit)
    .map(group => ({ kind: "group", group, label: studentNamesFor(group.studentIds, students).join(", ") }));
  return [...studentHits, ...groupHits];
}
