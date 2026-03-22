// ============================================================
// BACKUP & STORAGE
// Data migration, localStorage persistence, default school
// templates, and auto-backup helpers.
// ============================================================

import { uid } from "./helpers";
import { STORAGE_KEYS } from "../constants";

// ── Default school template ───────────────────────────────────────────────────

export const defaultSlots = () => [
  { id: uid(), name: "Slot 1",  start: "08:00", end: "08:30", type: "before_school" },
  { id: uid(), name: "Slot 2",  start: "08:30", end: "09:00", type: "before_school" },
  { id: uid(), name: "Slot 3",  start: "09:00", end: "09:30", type: "class" },
  { id: uid(), name: "Slot 4",  start: "09:30", end: "10:00", type: "class" },
  { id: uid(), name: "Slot 5",  start: "10:00", end: "10:30", type: "class" },
  { id: uid(), name: "Slot 6",  start: "10:30", end: "11:00", type: "class" },
  { id: uid(), name: "Slot 7",  start: "11:00", end: "11:30", type: "recess" },
  { id: uid(), name: "Slot 8",  start: "11:30", end: "12:00", type: "class" },
  { id: uid(), name: "Slot 9",  start: "12:00", end: "12:30", type: "class" },
  { id: uid(), name: "Slot 10", start: "12:30", end: "13:00", type: "class" },
  { id: uid(), name: "Slot 11", start: "13:00", end: "13:30", type: "class" },
  { id: uid(), name: "Slot 12", start: "13:30", end: "14:00", type: "lunch" },
  { id: uid(), name: "Slot 13", start: "14:00", end: "14:30", type: "lunch" },
  { id: uid(), name: "Slot 14", start: "14:30", end: "15:00", type: "class" },
  { id: uid(), name: "Slot 15", start: "15:00", end: "15:30", type: "class" },
  { id: uid(), name: "Slot 16", start: "15:30", end: "16:00", type: "after_school" },
  { id: uid(), name: "Slot 17", start: "16:00", end: "16:30", type: "after_school" },
  { id: uid(), name: "Slot 18", start: "16:30", end: "17:00", type: "after_school" },
  { id: uid(), name: "Slot 19", start: "17:00", end: "17:30", type: "after_school" },
  { id: uid(), name: "Slot 20", start: "17:30", end: "18:00", type: "after_school" },
];

// ── Data migration ────────────────────────────────────────────────────────────
// migrateData runs on load for any stored data missing required fields.
// DATA_VERSION history:
//   v1 → v2: added weekLabel to tallyEntries (was only weekKey)

export function migrateData(key, data) {
  if (!data) return data;
  switch (key) {
    case "students":
      if (!Array.isArray(data)) return data;
      return data.map(s => {
        const base = {
          outsideClassOnly: false,
          outsideClassPreferred: false,
          availableBefore: false,
          availableAfter: false,
          avoidTimes: [],
          preferredTimes: [],
          notes: "",
          status: "active",
          ...s,
          instruments: Array.isArray(s.instruments)
            ? s.instruments.map(inst => ({ teacherId: "", ...inst }))
            : [{ name: "", teacherId: "" }],
        };
        // v1→v2: move top-level preferredTeacherId into instruments[0].teacherId
        if (base.preferredTeacherId) {
          if (base.instruments.length > 0 && !base.instruments[0].teacherId) {
            base.instruments[0] = { ...base.instruments[0], teacherId: base.preferredTeacherId };
          }
          delete base.preferredTeacherId;
        }
        // ensure parents array exists
        if (!Array.isArray(base.parents)) base.parents = [];
        return base;
      });

    case "teachers":
      if (!Array.isArray(data)) return data;
      return data.map(t => ({
        email: "",
        phone: "",
        ...t,
        availability: Array.isArray(t.availability) ? t.availability : [],
        instruments: Array.isArray(t.instruments) ? t.instruments : [],
      }));

    case "schools":
      if (!Array.isArray(data)) return data;
      return data.map(sc => ({
        acronym: "",
        ...sc,
        slots: Array.isArray(sc.slots) ? sc.slots : defaultSlots(),
        classNames: Array.isArray(sc.classNames) ? sc.classNames : [],
      }));

    case "tallyEntries":
      if (!Array.isArray(data)) return data;
      return data.map(e => ({
        ...e,
        // v2: ensure weekLabel exists; derive from weekKey if missing
        weekLabel: e.weekLabel || (e.weekKey ? `Week of ${e.weekKey}` : ""),
        makeupEligible: e.makeupEligible !== undefined ? e.makeupEligible : true,
        madeUp: e.madeUp !== undefined ? e.madeUp : false,
        status: e.status || "missed",
        // removed entries: ensure makeupEligible is always false
        ...(e.status === "removed" ? { makeupEligible: false, madeUp: false } : {}),
      }));

    case "groups":
      if (!Array.isArray(data)) return data;
      return data.map(g => ({
        status: "forming",
        memberIds: [],
        ...g,
      }));

    default:
      return data;
  }
}

// ── localStorage helpers ──────────────────────────────────────────────────────

export async function saveData(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch(e) {
    console.error("saveData failed for", key, e);
  }
}

export async function loadData(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch(e) {
    return fallback;
  }
}

// Saves students to both the primary and backup key
export async function saveStudents(data) {
  await saveData(STORAGE_KEYS.students, data);
  await saveData(STORAGE_KEYS.studentsBak, data);
}

// Loads students from primary key; if empty, tries backup and repairs primary
export async function loadStudents() {
  const primary = await loadData(STORAGE_KEYS.students, []);
  if (primary.length > 0) return primary;
  const backup = await loadData(STORAGE_KEYS.studentsBak, []);
  if (backup.length > 0) {
    await saveData(STORAGE_KEYS.students, backup);
    return backup;
  }
  return [];
}

export async function loadSchools() {
  const primary = await loadData(STORAGE_KEYS.schools, []);
  if (primary.length > 0) return primary;
  const backup = await loadData(STORAGE_KEYS.schoolsBak, []);
  if (backup.length > 0) {
    await saveData(STORAGE_KEYS.schools, backup);
    return backup;
  }
  return [];
}

export async function loadSpecialists() {
  const primary = await loadData(STORAGE_KEYS.specialists, []);
  if (primary.length > 0) return primary;
  const backup = await loadData(STORAGE_KEYS.specialistsBak, []);
  if (backup.length > 0) {
    await saveData(STORAGE_KEYS.specialists, backup);
    return backup;
  }
  return [];
}

// ── Auto-backup ───────────────────────────────────────────────────────────────

// Auto-backup: writes a snapshot to localStorage so it can be restored easily.
// Called after any significant data change.
export function triggerAutoBackup(data) {
  try {
    const json = JSON.stringify(data, null, 2);
    localStorage.setItem("mt-last-autobak", json);
    localStorage.setItem("mt-last-autobak-time", new Date().toISOString());
  } catch(e) {}
}
