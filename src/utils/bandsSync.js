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
