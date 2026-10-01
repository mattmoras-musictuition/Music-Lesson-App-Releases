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

// The whole-list sync: every band in memory is upserted (stamped with the
// admin's user_id), then every admin-owned row whose id is not in memory is
// deleted. No delete when the list is empty. null when signed out.
export function planWholeListSync(bands, userId) {
  if (!userId) return null;
  const upsertRows = bands.map(b => bandToRow(b, userId));
  const keepIds = bands.map(b => b.id);
  return { upsertRows, deleteSweep: keepIds.length === 0 ? null : { ownedBy: userId, keepIds } };
}
