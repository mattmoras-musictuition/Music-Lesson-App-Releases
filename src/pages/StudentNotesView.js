// ============================================================
// StudentNotesView.js (ADMIN) — Student Notes tab, list panel.
//
// Cluster 6.2: the admin-side Student Notes screen. This is a fresh
// REBUILD, not a port of the teacher-app StudentNotesView (which is
// coupled to that teacher's own week-of-lessons / coverage pipeline,
// none of which applies to the admin who oversees everyone).
//
// Left pane: every student and group, grouped by school (collapsible,
// collapsed by default), one combined alphabetical list per school,
// with search + primary-teacher / class / type filters. Right pane:
// a placeholder empty state — 6.3 ports the real SubjectNotesPage in.
//
// The list is driven purely by the admin app's existing students[] /
// groups[] data. No note data is loaded here (the "which subjects have
// a note" indicator is a deferred v2 item).
//
// my_teacher_id() is resolved on mount and held in state purely as
// prep for 6.3's note authoring; it has no visible effect in 6.2.
// ============================================================

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Users, Search, X, ChevronRight, ChevronDown, StickyNote, Paperclip } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { supabase } from "../supabaseClient";
import { PageTitle, EmptyState } from "../components/ui/SharedUI";
import { preferredDisplayName, preferredFirstName } from "../utils/studentName";
import { buildStudentMTTTeacherIndex } from "../utils/helpers";
import { activeEnrolmentsFor } from "../utils/enrolmentsDB";
import {
  getNotesForSubject, upsertNote, deleteNote, subscribeToSubjectNotes,
  getAttachmentsForSubject, uploadFileAttachment, addLinkAttachment, deleteAttachment,
  renameAttachment, subscribeToSubjectAttachments, addLibraryReference, publishUploadToLibrary,
  addUploadToLibrary, removeUploadFromLibrary, editLibraryItem, classifyAttachment,
} from "../utils/studentNotesDB";
import { loadResources, fetchResourceTaxonomies, subscribeToResources } from "../utils/resourcesDB";
import { SubjectNotesPage } from "../components/SubjectNotesPage";
import { LinkBrowser } from "../components/LinkBrowser";

// Raw realtime row (snake_case) → camelCase note, matching studentNotesDB's
// noteFromRow shape so optimistic state and realtime updates stay aligned.
function realtimeRowToNote(row) {
  return {
    id:          row.id,
    subjectType: row.subject_type,
    subjectId:   row.subject_id,
    weekKey:     row.week_key,
    termId:      row.term_id    || null,
    authorId:    row.author_id,
    body:        row.body       || {},
    createdAt:   row.created_at || "",
    updatedAt:   row.updated_at || "",
  };
}

// Raw realtime attachment row (snake_case) → camelCase + classification,
// matching studentNotesDB.attachmentFromRow so realtime rows carry the same
// isUploadedFile/isUploadedLink/isReference/inLibrary flags as the initial load.
function realtimeRowToAttachment(row) {
  const att = {
    id:            row.id,
    subjectType:   row.subject_type,
    subjectId:     row.subject_id,
    authorId:      row.author_id,
    kind:          row.kind,
    storagePath:   row.storage_path    || null,
    fileName:      row.file_name       || null,
    fileSizeBytes: row.file_size_bytes ?? null,
    mimeType:      row.mime_type       || null,
    url:           row.url             || null,
    pageTitle:     row.page_title      || null,
    ogImageUrl:    row.og_image_url    || null,
    displayLabel:  row.display_label   || null,
    resourceId:    row.resource_id     || null,
    createdAt:     row.created_at      || "",
  };
  return { ...att, ...classifyAttachment(att) };
}

function firstNameOf(full) {
  return preferredFirstName(full);
}

// Group display label. An empty name counts as "no name" (spec §4.1.2) —
// fall back to comma-separated member names. `full` toggles first-names-only
// (narrow list rows) vs full names (hover tooltip / subject header). Reads
// either memberIds (teacher-app shape) or studentIds (admin group shape).
// Exported so 6.3's ported SubjectNotesPage can import it from here.
export function groupDisplayLabel(group, studentsById, { full = false } = {}) {
  const named = (group?.name || "").trim();
  if (named) return named;
  const memberIds = group?.memberIds || group?.studentIds || [];
  const names = memberIds
    .map(id => studentsById.get(id)?.name || group?.memberNamesById?.[id] || "")
    .filter(Boolean)
    .map(n => (full ? preferredDisplayName(n) : firstNameOf(n)));
  return names.length ? names.join(", ") : "Unnamed group";
}

const NO_SCHOOL_KEY = "__none__";

export function StudentNotesView({
  students = [],
  groups = [],
  schools = [],
  teachers = [],
  enrolments = [],
  timetable = null,
  teacherCoverage = [],
  interruptions = [],
}) {
  const { colors } = useTheme();

  // ── Component state ───────────────────────────────────────
  const [myTeacherId, setMyTeacherId] = useState(null);          // author identity (6.3)
  const [selected, setSelected] = useState(null);                // { type, id } | null
  const [search, setSearch] = useState("");
  const [filterTeacher, setFilterTeacher] = useState("");
  const [filterClass, setFilterClass] = useState("");
  const [filterType, setFilterType] = useState("");              // "" | "student" | "group"
  const [expandedSchools, setExpandedSchools] = useState(() => new Set()); // collapsed by default
  const [notes, setNotes] = useState([]);                        // notes for the selected subject
  const [notesLoading, setNotesLoading] = useState(false);
  const [attachments, setAttachments] = useState([]);            // attachments for the selected subject
  const [resourcesById, setResourcesById] = useState(() => new Map()); // id → raw resources row (reference resolution)
  const [resourcesLoaded, setResourcesLoaded] = useState(false); // false until the library has loaded (avoids dead-reference flash)
  const [resourceTypes, setResourceTypes] = useState([]);        // Type options for attachment edit/publish
  const [browserLink, setBrowserLink] = useState(null);          // { url, title } | null — in-app browser

  // ── Resolve the admin's own teacher id (prep for 6.3 authoring) ──
  // No visible effect in 6.2. Fail soft: hold null + log, never break the list.
  useEffect(() => {
    let cancelled = false;
    supabase
      .rpc("my_teacher_id")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.warn("[student-notes] my_teacher_id() failed:", error.message);
          setMyTeacherId(null);
          return;
        }
        setMyTeacherId(data || null);
      })
      .catch(e => {
        if (cancelled) return;
        console.warn("[student-notes] my_teacher_id() threw:", e?.message || e);
        setMyTeacherId(null);
      });
    return () => { cancelled = true; };
  }, []);

  // ── Per-subject status flags for the left-panel rows ──────
  // One query each (NOT per-row): which subjects have at least one note,
  // and which have at least one attachment. Keyed `${subjectType}:${subjectId}`.
  const [subjectsWithNotes, setSubjectsWithNotes] = useState(() => new Set());
  const [subjectsWithAttachments, setSubjectsWithAttachments] = useState(() => new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [notesRes, attsRes] = await Promise.all([
          supabase.from("student_notes").select("subject_type, subject_id"),
          supabase.from("student_attachments").select("subject_type, subject_id"),
        ]);
        if (cancelled) return;
        if (!notesRes.error) {
          setSubjectsWithNotes(new Set((notesRes.data || []).map(r => `${r.subject_type}:${r.subject_id}`)));
        }
        if (!attsRes.error) {
          setSubjectsWithAttachments(new Set((attsRes.data || []).map(r => `${r.subject_type}:${r.subject_id}`)));
        }
      } catch (e) {
        if (!cancelled) console.warn("[student-notes] row-status load failed:", e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Lookups ───────────────────────────────────────────────
  const studentsById = useMemo(() => {
    const m = new Map();
    for (const s of students) m.set(s.id, s);
    return m;
  }, [students]);

  const schoolsById = useMemo(() => {
    const m = new Map();
    for (const sc of schools) m.set(sc.id, sc);
    return m;
  }, [schools]);

  // MTT teacher index — same machinery StudentsManager uses for its teacher
  // filter. Keyed `${studentId}:${instrument}` → teacherId. Groups carry their
  // own teacherId, so they don't need this.
  const mttTeacherIdx = useMemo(
    () => buildStudentMTTTeacherIndex(timetable, teacherCoverage),
    [timetable, teacherCoverage]
  );

  const studentTeacherIds = (student) => {
    const ids = new Set();
    for (const en of activeEnrolmentsFor(student.id, enrolments)) {
      if (en.isGroup) continue;
      const tid = mttTeacherIdx.get(`${student.id}:${(en.instrument || "").trim().toLowerCase()}`);
      if (tid) ids.add(tid);
    }
    return ids;
  };

  // ── Lookups for the subject page ──────────────────────────
  const groupsById = useMemo(() => {
    const m = new Map();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  const teachersById = useMemo(() => {
    const m = new Map();
    for (const t of teachers) m.set(t.id, t);
    return m;
  }, [teachers]);

  const schoolName = useCallback((id) => schoolsById.get(id)?.name || "", [schoolsById]);

  // Term boundaries for the subject page, from the admin's interruptions
  // (term_break entries) — same source the rest of the app uses.
  const termBreaks = useMemo(
    () => (interruptions || [])
      .filter(i => i.type === "term_break")
      .map(i => ({ date: i.date, endDate: i.endDate || null })),
    [interruptions]
  );

  const lessons = useMemo(() => timetable?.lessons || [], [timetable]);

  // Primary teacher for the selected subject — same source as 6.2's teacher
  // filter: group.teacherId for groups; first MTT-resolved teacher for a
  // student. Returns { id, name, colour } or null when unassigned.
  const selectedPrimaryTeacher = useMemo(() => {
    if (!selected) return null;
    let tid = null;
    if (selected.type === "group") {
      tid = groupsById.get(selected.id)?.teacherId || null;
    } else {
      const st = studentsById.get(selected.id);
      if (st) {
        for (const en of activeEnrolmentsFor(st.id, enrolments)) {
          if (en.isGroup) continue;
          const t = mttTeacherIdx.get(`${st.id}:${(en.instrument || "").trim().toLowerCase()}`);
          if (t) { tid = t; break; }
        }
      }
    }
    if (!tid) return null;
    const t = teachersById.get(tid);
    return { id: tid, name: t?.name || "", colour: t?.colour || t?.color || null };
  }, [selected, groupsById, studentsById, teachersById, enrolments, mttTeacherIdx]);

  // ── Notes for the selected subject (cancellable load) ─────
  useEffect(() => {
    if (!selected) { setNotes([]); setNotesLoading(false); return; }
    let cancelled = false;
    setNotesLoading(true);
    (async () => {
      try {
        const rows = await getNotesForSubject(selected.type, selected.id);
        if (!cancelled) setNotes(rows);
      } catch (e) {
        console.error("[student-notes] notes load error:", e);
        if (!cancelled) setNotes([]);
      } finally {
        if (!cancelled) setNotesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selected]);

  // ── Note writes (optimistic) ──────────────────────────────
  const handleSaveNote = useCallback(async (weekKey, termId, body) => {
    if (!selected || !myTeacherId) return;
    const existing = notes.find(n => n.weekKey === weekKey && n.authorId === myTeacherId);
    if (body == null) {                 // empty body → delete any existing row
      if (existing) {
        await deleteNote(existing.id);
        setNotes(prev => prev.filter(n => n.id !== existing.id));
      }
      return;
    }
    const row = await upsertNote({
      subjectType: selected.type, subjectId: selected.id,
      weekKey, termId, authorId: myTeacherId, body,
    });
    setNotes(prev => {
      const idx = prev.findIndex(n => n.id === row.id);
      if (idx >= 0) { const next = prev.slice(); next[idx] = row; return next; }
      return [...prev, row];
    });
  }, [selected, myTeacherId, notes]);

  const handleDeleteNote = useCallback(async (id) => {
    await deleteNote(id);
    setNotes(prev => prev.filter(n => n.id !== id));
  }, []);

  // ── Realtime: live sync of other authors' (and cross-tab) edits ─
  // The guard ignores echoes of my own in-progress typing (within 2s of my
  // last keystroke) so the cursor never jumps mid-edit; everything else applies.
  const editActivityRef = useRef({ weekKey: null, ts: 0 });
  const handleEditActivity = useCallback((weekKey) => {
    editActivityRef.current = { weekKey, ts: Date.now() };
  }, []);

  useEffect(() => {
    if (!selected) return;
    const unsubscribe = subscribeToSubjectNotes(selected.type, selected.id, (payload) => {
      const row = payload.new || payload.old;
      if (!row) return;
      if (row.author_id === myTeacherId) {
        const a = editActivityRef.current;
        if (a.weekKey === row.week_key && Date.now() - a.ts < 2000) return;
      }
      setNotes(prev => {
        if (payload.eventType === "DELETE") {
          const id = payload.old?.id;
          return id ? prev.filter(n => n.id !== id) : prev;
        }
        const note = realtimeRowToNote(payload.new);
        const idx = prev.findIndex(n => n.id === note.id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = { ...next[idx], ...note };
          return next;
        }
        return [...prev, note];
      });
    });
    return unsubscribe;
  }, [selected, myTeacherId]);

  // ── Attachments for the selected subject (cancellable load) ─
  useEffect(() => {
    if (!selected) { setAttachments([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const rows = await getAttachmentsForSubject(selected.type, selected.id);
        if (!cancelled) setAttachments(rows);
      } catch (e) {
        console.error("[student-notes] attachments load error:", e);
        if (!cancelled) setAttachments([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selected]);

  // ── Shared resources library (for reference resolution + Type options) ─
  // Refresh on mount; resourcesLoaded only flips true on success so a failed
  // load never marks live references dead.
  const refreshResources = useCallback(async () => {
    try {
      const rows = await loadResources();
      setResourcesById(new Map((rows || []).map(r => [r.id, r])));
      setResourcesLoaded(true);
    } catch { /* keep last-known snapshot */ }
  }, []);

  useEffect(() => {
    refreshResources();
    fetchResourceTaxonomies()
      .then(tax => setResourceTypes(tax?.resourceTypes || []))
      .catch(() => {});
  }, [refreshResources]);

  // ── Realtime: attachments (no edit guard needed) ────────────
  useEffect(() => {
    if (!selected) return;
    const unsubscribe = subscribeToSubjectAttachments(selected.type, selected.id, (payload) => {
      setAttachments(prev => {
        if (payload.eventType === "DELETE") {
          const id = payload.old?.id;
          return id ? prev.filter(a => a.id !== id) : prev;
        }
        const att = realtimeRowToAttachment(payload.new);
        const idx = prev.findIndex(a => a.id === att.id);
        if (idx >= 0) { const next = prev.slice(); next[idx] = att; return next; }
        return [...prev, att];
      });
    });
    return unsubscribe;
  }, [selected]);

  // ── Realtime: the shared resources library ──────────────────
  // Keeps resourcesById live so reference attachments re-resolve without a
  // restart. Rows stored raw (snake_case), matching loadResources / the payload.
  useEffect(() => {
    const unsubscribe = subscribeToResources((payload) => {
      setResourcesById(prev => {
        const m = new Map(prev);
        if (payload.eventType === "DELETE") {
          const id = payload.old?.id;
          if (id) m.delete(id);
        } else if (payload.new?.id) {
          m.set(payload.new.id, payload.new);
        }
        return m;
      });
    });
    return unsubscribe;
  }, []);

  // Derive the library-row fields auto-set from the current subject (school,
  // instrument, teacher name) for publish / add-to-library. Admin shape:
  // camelCase schoolId; a student's instrument comes from active enrolments
  // (student.instruments is deprecated/empty); a group carries its own
  // instrument.
  const deriveSubjectLibraryFields = useCallback(() => {
    let schoolId = null, instrument = null;
    if (!selected) return { schoolId, instrument, teacherName: "" };
    if (selected.type === "student") {
      const s = studentsById.get(selected.id);
      schoolId = s?.schoolId || null;
      instrument = activeEnrolmentsFor(selected.id, enrolments).map(e => e.instrument).find(Boolean) || null;
    } else {
      const g = groupsById.get(selected.id);
      schoolId = g?.schoolId || null;
      instrument = g?.instrument || null;
    }
    const teacherName = teachersById.get(myTeacherId)?.name || "";
    return { schoolId, instrument, teacherName };
  }, [selected, myTeacherId, studentsById, groupsById, teachersById, enrolments]);

  // ── Attachment writes (optimistic) ──────────────────────────
  const handleAddFile = useCallback(async (file, displayLabel) => {
    if (!selected || !myTeacherId) return;
    const row = await uploadFileAttachment({
      subjectType: selected.type, subjectId: selected.id, authorId: myTeacherId, file, displayLabel,
    });
    setAttachments(prev => (prev.some(a => a.id === row.id) ? prev : [...prev, row]));
  }, [selected, myTeacherId]);

  const handleAddLink = useCallback(async (url, displayLabel) => {
    if (!selected || !myTeacherId) return;
    const row = await addLinkAttachment({
      subjectType: selected.type, subjectId: selected.id, authorId: myTeacherId, url, displayLabel,
    });
    setAttachments(prev => (prev.some(a => a.id === row.id) ? prev : [...prev, row]));
  }, [selected, myTeacherId]);

  const handleDeleteAttachment = useCallback(async (row) => {
    await deleteAttachment(row);
    setAttachments(prev => prev.filter(a => a.id !== row.id));
  }, []);

  // Attach an existing library item by reference (no copy). Never throws —
  // returns { ok }. On failure (e.g. the resource was deleted between the
  // snapshot and the click, so the FK rejects) we drop the stale entry.
  const handleAttachFromLibrary = useCallback(async (resource) => {
    if (!selected || !myTeacherId || !resource?.id) return { ok: false };
    try {
      const row = await addLibraryReference({
        subjectType: selected.type, subjectId: selected.id, authorId: myTeacherId, resource,
      });
      setResourcesById(prev => { const m = new Map(prev); m.set(resource.id, resource); return m; });
      setAttachments(prev => (prev.some(a => a.id === row.id) ? prev : [...prev, row]));
      return { ok: true };
    } catch (e) {
      console.error("[attach-from-library] failed — the resource may have been removed:", e);
      setResourcesById(prev => { if (!prev.has(resource.id)) return prev; const m = new Map(prev); m.delete(resource.id); return m; });
      return { ok: false };
    }
  }, [selected, myTeacherId]);

  // Opt-in publish: upload a file AND create a library item referencing it.
  const handlePublishFile = useCallback(async (file, displayLabel, category) => {
    if (!selected || !myTeacherId) throw new Error("No subject selected");
    const { schoolId, instrument, teacherName } = deriveSubjectLibraryFields();
    const res = await publishUploadToLibrary({
      subjectType: selected.type, subjectId: selected.id, authorId: myTeacherId, file,
      schoolId, instrument, category, teacherId: myTeacherId, teacherName, displayLabel,
    });
    setAttachments(prev => (prev.some(a => a.id === res.attachment.id) ? prev : [...prev, res.attachment]));
    if (res.published && res.resource) {
      setResourcesById(prev => { const m = new Map(prev); m.set(res.resource.id, res.resource); return m; });
    }
    return res;
  }, [selected, myTeacherId, deriveSubjectLibraryFields]);

  // Full attachment edit: name (+ Type / library membership) per kind.
  const handleSaveAttachmentEdit = useCallback(async (att, { name, category, inLibrary }) => {
    if (!att) return;
    const wasInLibrary = !!att.resourceId;

    if (att.isReference) {             // owned pure reference → edit the library item
      const { attachment, resource } = await editLibraryItem({
        attachmentId: att.id, resourceId: att.resourceId, name, category,
      });
      setAttachments(prev => prev.map(a => (a.id === att.id ? attachment : a)));
      if (resource) setResourcesById(prev => { const m = new Map(prev); m.set(resource.id, resource); return m; });
      return;
    }

    if (att.isUploadedFile) {          // name/type + add/remove-from-library toggle
      if (wasInLibrary && !inLibrary) {
        const resource = resourcesById.get(att.resourceId) || null;
        const { attachment } = await removeUploadFromLibrary({ attachment: att, resource, name });
        setAttachments(prev => prev.map(a => (a.id === att.id ? attachment : a)));
        setResourcesById(prev => { const m = new Map(prev); m.delete(att.resourceId); return m; });
        return;
      }
      if (!wasInLibrary && inLibrary) {
        const { schoolId, instrument, teacherName } = deriveSubjectLibraryFields();
        const { attachment, resource } = await addUploadToLibrary({
          attachment: att, name, category, schoolId, instrument, teacherId: myTeacherId, teacherName,
        });
        setAttachments(prev => prev.map(a => (a.id === att.id ? attachment : a)));
        setResourcesById(prev => { const m = new Map(prev); m.set(resource.id, resource); return m; });
        return;
      }
      if (wasInLibrary && inLibrary) {
        const { attachment, resource } = await editLibraryItem({
          attachmentId: att.id, resourceId: att.resourceId, name, category,
        });
        setAttachments(prev => prev.map(a => (a.id === att.id ? attachment : a)));
        if (resource) setResourcesById(prev => { const m = new Map(prev); m.set(resource.id, resource); return m; });
        return;
      }
      const row = await renameAttachment(att.id, name);   // plain file, not in library → name only
      setAttachments(prev => prev.map(a => (a.id === att.id ? row : a)));
      return;
    }

    const row = await renameAttachment(att.id, name);      // uploaded link → name only
    setAttachments(prev => prev.map(a => (a.id === att.id ? row : a)));
  }, [resourcesById, myTeacherId, deriveSubjectLibraryFields]);

  // ── Unified subject list (students + groups) ──────────────
  const subjects = useMemo(() => {
    const arr = [];
    for (const s of students) {
      const name = preferredDisplayName(s.name) || "(unnamed)";
      arr.push({
        type: "student",
        id: s.id,
        schoolId: s.schoolId || "",
        displayName: name,
        sortName: name.toLowerCase(),
        className: s.className || "",
        raw: s,
      });
    }
    for (const g of groups) {
      const label = groupDisplayLabel(g, studentsById, { full: true });
      arr.push({
        type: "group",
        id: g.id,
        schoolId: g.schoolId || "",
        displayName: label,
        sortName: label.toLowerCase(),
        className: "",
        teacherId: g.teacherId || "",
        raw: g,
      });
    }
    return arr;
  }, [students, groups, studentsById]);

  // ── Filter option lists ───────────────────────────────────
  const classOptions = useMemo(() => {
    const set = new Set();
    for (const s of students) if (s.className) set.add(s.className);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [students]);

  const teacherOptions = useMemo(
    () => [...teachers].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [teachers]
  );

  // ── Filter predicate ──────────────────────────────────────
  const passesFilters = (subj) => {
    if (filterType && subj.type !== filterType) return false;
    if (filterClass) {
      if (subj.type !== "student" || subj.className !== filterClass) return false;
    }
    if (filterTeacher) {
      if (subj.type === "group") {
        if (subj.teacherId !== filterTeacher) return false;
      } else {
        if (!studentTeacherIds(subj.raw).has(filterTeacher)) return false;
      }
    }
    return true;
  };

  const matchesSearch = (subj, q) =>
    subj.sortName.includes(q) || (subj.className || "").toLowerCase().includes(q);

  const schoolNameOf = (schoolId) => schoolsById.get(schoolId)?.name || "";

  // ── Grouped view (no search) ──────────────────────────────
  const groupedBySchool = useMemo(() => {
    const buckets = new Map(); // schoolId → subjects[]
    for (const subj of subjects) {
      if (!passesFilters(subj)) continue;
      const key = subj.schoolId && schoolsById.has(subj.schoolId) ? subj.schoolId : NO_SCHOOL_KEY;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(subj);
    }
    const order = [...buckets.keys()].sort((a, b) => {
      if (a === NO_SCHOOL_KEY) return 1;
      if (b === NO_SCHOOL_KEY) return -1;
      return schoolNameOf(a).localeCompare(schoolNameOf(b));
    });
    return order.map(schoolId => ({
      schoolId,
      schoolName: schoolId === NO_SCHOOL_KEY ? "No school" : (schoolNameOf(schoolId) || "School"),
      items: buckets.get(schoolId).sort((a, b) => a.sortName.localeCompare(b.sortName)),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjects, schoolsById, filterType, filterClass, filterTeacher]);

  // ── Search results (flat) ─────────────────────────────────
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return subjects
      .filter(subj => passesFilters(subj) && matchesSearch(subj, q))
      .sort((a, b) => {
        const sn = schoolNameOf(a.schoolId).localeCompare(schoolNameOf(b.schoolId));
        return sn !== 0 ? sn : a.sortName.localeCompare(b.sortName);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjects, search, schoolsById, filterType, filterClass, filterTeacher]);

  const isSearching = search.trim().length > 0;

  const toggleSchool = (schoolId) => {
    setExpandedSchools(prev => {
      const next = new Set(prev);
      if (next.has(schoolId)) next.delete(schoolId);
      else next.add(schoolId);
      return next;
    });
  };

  // ── Row + small presentational pieces ─────────────────────
  const SubjectRow = ({ subj }) => {
    const isSel = selected && selected.type === subj.type && selected.id === subj.id;
    const [hover, setHover] = useState(false);
    const subjKey = `${subj.type}:${subj.id}`;
    const hasNotes = subjectsWithNotes.has(subjKey);
    const hasAttachments = subjectsWithAttachments.has(subjKey);
    // Navy highlight (the admin standard for selected/active list rows —
    // sidebarActive selected, sidebarHover on hover) flips the row's content to
    // the inverted light colour (colors.white) so name, subline and group icon
    // stay readable against it. Resting unselected rows are unchanged.
    const active = isSel || hover;
    return (
      <button
        onClick={() => setSelected({ type: subj.type, id: subj.id })}
        title={subj.displayName}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "7px 10px", border: "none", borderRadius: 7, cursor: "pointer",
          background: isSel ? colors.sidebarActive : hover ? colors.sidebarHover : "transparent",
          textAlign: "left", fontFamily: "inherit", marginBottom: 1,
          transition: "background 0.12s",
        }}
      >
        {subj.type === "group" && (
          <Users size={13} style={{ flexShrink: 0, color: active ? colors.white : colors.textMuted }} />
        )}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            display: "block", fontSize: 13, fontWeight: isSel ? 600 : 500,
            color: active ? colors.white : colors.text,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {subj.displayName}
          </span>
          {subj.type === "student" && subj.className && (
            <span style={{ display: "block", fontSize: 11, color: active ? colors.white : colors.textMuted, marginTop: 1 }}>
              {subj.className}
            </span>
          )}
        </span>
        {(hasNotes || hasAttachments) && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
            {hasNotes && <StickyNote size={13} style={{ color: active ? colors.white : colors.textMuted, opacity: active ? 0.9 : 0.65 }} />}
            {hasAttachments && <Paperclip size={13} style={{ color: active ? colors.white : colors.textMuted, opacity: active ? 0.9 : 0.65 }} />}
          </span>
        )}
      </button>
    );
  };

  const selectStyle = {
    flex: 1, minWidth: 0, padding: "6px 8px", borderRadius: 7,
    border: `1px solid ${colors.border}`, background: colors.cardBg,
    color: colors.text, fontSize: 12, fontFamily: "inherit", cursor: "pointer",
  };

  return (
    <>
      <PageTitle subtitle="Notes for every student and group, grouped by school.">
        Student Notes
      </PageTitle>

      <div style={{ display: "flex", gap: 16, height: "calc(100vh - 150px)" }}>
        {/* ── Left pane: subject list ── */}
        <div style={{
          width: 340, flexShrink: 0, display: "flex", flexDirection: "column",
          border: `1px solid ${colors.border}`, borderRadius: 12,
          background: colors.cardBg, overflow: "hidden",
        }}>
          {/* Search */}
          <div style={{ padding: 12, borderBottom: `1px solid ${colors.border}` }}>
            <div style={{ position: "relative", marginBottom: 8 }}>
              <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: colors.textMuted }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search students & groups…"
                style={{
                  width: "100%", boxSizing: "border-box", padding: "7px 28px 7px 30px",
                  borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bg,
                  color: colors.text, fontSize: 13, fontFamily: "inherit", outline: "none",
                }}
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  title="Clear search"
                  style={{
                    position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                    background: "none", border: "none", cursor: "pointer", color: colors.textMuted,
                    display: "inline-flex", padding: 4,
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {/* Filters */}
            <div style={{ display: "flex", gap: 6 }}>
              <select value={filterTeacher} onChange={e => setFilterTeacher(e.target.value)} style={selectStyle} title="Filter by primary teacher">
                <option value="">All teachers</option>
                {teacherOptions.map(t => <option key={t.id} value={t.id}>{t.name || "(unnamed)"}</option>)}
              </select>
              <select value={filterClass} onChange={e => setFilterClass(e.target.value)} style={selectStyle} title="Filter by class">
                <option value="">All classes</option>
                {classOptions.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={filterType} onChange={e => setFilterType(e.target.value)} style={selectStyle} title="Filter by type">
                <option value="">All types</option>
                <option value="student">Students</option>
                <option value="group">Groups</option>
              </select>
            </div>
          </div>

          {/* List body */}
          <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
            {isSearching ? (
              searchResults.length === 0 ? (
                <div style={{ padding: "24px 12px", textAlign: "center", color: colors.textMuted, fontSize: 13 }}>
                  No matches
                </div>
              ) : (
                searchResults.map(subj => <SubjectRow key={`${subj.type}-${subj.id}`} subj={subj} />)
              )
            ) : (
              groupedBySchool.length === 0 ? (
                <div style={{ padding: "24px 12px", textAlign: "center", color: colors.textMuted, fontSize: 13 }}>
                  No students or groups
                </div>
              ) : (
                groupedBySchool.map(grp => {
                  const open = expandedSchools.has(grp.schoolId);
                  return (
                    <div key={grp.schoolId} style={{ marginBottom: 4 }}>
                      <button
                        onClick={() => toggleSchool(grp.schoolId)}
                        style={{
                          display: "flex", alignItems: "center", gap: 6, width: "100%",
                          padding: "8px 10px", border: "none", borderRadius: 7, cursor: "pointer",
                          background: colors.bg, color: colors.text, fontFamily: "inherit",
                          fontSize: 13, fontWeight: 600, textAlign: "left",
                        }}
                      >
                        {open ? <ChevronDown size={14} style={{ flexShrink: 0 }} /> : <ChevronRight size={14} style={{ flexShrink: 0 }} />}
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {grp.schoolName}
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted }}>{grp.items.length}</span>
                      </button>
                      {open && (
                        <div style={{ padding: "2px 0 2px 8px" }}>
                          {grp.items.map(subj => <SubjectRow key={`${subj.type}-${subj.id}`} subj={subj} />)}
                        </div>
                      )}
                    </div>
                  );
                })
              )
            )}
          </div>
        </div>

        {/* ── Right pane: subject notes page (or empty state) ── */}
        <div style={{
          flex: 1, minWidth: 0, border: `1px solid ${colors.border}`, borderRadius: 12,
          background: colors.cardBg, overflow: "hidden", display: "flex",
          alignItems: selected ? "stretch" : "center", justifyContent: selected ? "stretch" : "center",
        }}>
          {selected ? (
            <SubjectNotesPage
              selected={selected}
              setSelected={setSelected}
              myTeacherId={myTeacherId}
              lessons={lessons}
              enrolments={enrolments}
              studentsById={studentsById}
              groupsById={groupsById}
              schoolName={schoolName}
              teachersById={teachersById}
              primaryTeacher={selectedPrimaryTeacher}
              termBreaks={termBreaks}
              notes={notes}
              notesLoading={notesLoading}
              onSaveNote={handleSaveNote}
              onDeleteNote={handleDeleteNote}
              onEditActivity={handleEditActivity}
              attachments={attachments}
              resourcesById={resourcesById}
              resourcesLoaded={resourcesLoaded}
              resourceTypes={resourceTypes}
              onRefreshResources={refreshResources}
              onAddFile={handleAddFile}
              onAddLink={handleAddLink}
              onDeleteAttachment={handleDeleteAttachment}
              onSaveAttachmentEdit={handleSaveAttachmentEdit}
              onOpenAttachment={setBrowserLink}
              onAttachFromLibrary={handleAttachFromLibrary}
              onPublishFile={handlePublishFile}
            />
          ) : (
            <EmptyState
              icon="🎓"
              title="Select a student or group to view their notes"
              subtitle="Pick a name from the list on the left."
            />
          )}
        </div>
      </div>

      {browserLink && (
        <LinkBrowser
          initialUrl={browserLink.url}
          title={browserLink.title}
          onClose={() => setBrowserLink(null)}
        />
      )}
    </>
  );
}
