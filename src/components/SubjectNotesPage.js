// ============================================================
// SubjectNotesPage.js  —  ADMIN (Student Notes, cluster 6.3a)
//
// The per-subject notes page rendered in the right pane of the admin
// Student Notes tab. Ported from the teacher-app SubjectNotesPage with
// the cluster-6.3a adaptations:
//
//   1. ALL terms render (newest first), not current-term-only. The
//      CURRENT term is editable (NoteEditor on its week cards); PAST
//      terms are read-only (existing notes via the static noteBody
//      renderer, no editor). Future terms appear once started. During a
//      holiday gap (no current term) past terms still render.
//   2. Primary-teacher badge ALWAYS shows for the admin (the admin is
//      never a subject's primary teacher). The primary teacher is
//      resolved in StudentNotesView (group.teacherId / MTT index) and
//      passed in as { id, name, colour }; the badge is tinted with it.
//      No primary resolved → a neutral "unassigned" badge.
//   3. Group members come from the admin group's studentIds (the
//      teacher-app used memberIds) — read as memberIds || studentIds.
//   4. groupDisplayLabel is imported from ../pages/StudentNotesView.
//   5. Author identity is the admin's myTeacherId. If it is null (the
//      my_teacher_id() RPC failed), the current term's cards show an
//      inline message instead of the editor — read-only rendering of
//      existing notes still works.
//
// Attachments (AttachmentsPanel / LibraryPicker / previews) are
// deliberately OUT of scope here — cluster 6.3b re-adds them at the
// marked seam.
// ============================================================

import React, { useMemo, useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Users } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { getTerms, getTermWeeks, getMondayOf } from "../utils/termWeeks";
import { groupDisplayLabel } from "../pages/StudentNotesView";
import { preferredDisplayName } from "../utils/studentName";
import { renderNoteBody } from "../utils/noteBody";
import { activeEnrolmentsFor } from "../utils/enrolmentsDB";
import { NoteEditor } from "./NoteEditor";

// ── Small helpers ────────────────────────────────────────────
function fmtTimestamp(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-AU", {
      day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
    });
  } catch { return iso; }
}

// Admin group members live in studentIds (teacher-app used memberIds).
function groupMemberIds(group) {
  return group?.memberIds || group?.studentIds || [];
}

// ── Component ─────────────────────────────────────────────────
export function SubjectNotesPage({
  selected, setSelected,
  myTeacherId,
  lessons = [],            // timetable.lessons — header day/time/instrument display only
  enrolments = [],         // student instruments derived from active enrolments
  studentsById, groupsById, schoolName, teachersById,
  primaryTeacher,          // { id, name, colour } | null — resolved in StudentNotesView
  termBreaks,
  notes, notesLoading,
  onSaveNote, onDeleteNote, onEditActivity,
}) {
  const { colors, darkMode } = useTheme();

  // Today (captured once per mount).
  const now = useMemo(() => new Date(), []);
  const todayMondayKey = useMemo(() => toLocalDateStr(getMondayOf(now)), [now]);

  // ── Subject resolution ──────────────────────────────────────
  const isStudent = selected?.type === "student";
  const student = isStudent ? (studentsById.get(selected.id) || null) : null;
  const group   = !isStudent && selected?.id ? (groupsById.get(selected.id) || null) : null;

  // Lesson card for slot/instrument display only (NOT primary-teacher —
  // that is resolved by the parent and passed in as `primaryTeacher`).
  const subjectLesson = useMemo(() => {
    if (!selected) return null;
    if (isStudent) {
      return lessons.find(l => !l.isGroup && l.studentId === selected.id) || null;
    }
    return lessons.find(l => l.isGroup && l.groupId === selected.id) || null;
  }, [lessons, selected, isStudent]);

  const primaryTeacherId = primaryTeacher?.id || null;
  const primaryIsMe = !!primaryTeacherId && primaryTeacherId === myTeacherId;

  // Groups this student is a member of (for the "Also in" row).
  const alsoInGroups = useMemo(() => {
    if (!isStudent || !selected) return [];
    const out = [];
    for (const g of groupsById.values()) {
      if (groupMemberIds(g).includes(selected.id)) out.push(g);
    }
    out.sort((a, b) => groupDisplayLabel(a, studentsById, { full: true })
      .localeCompare(groupDisplayLabel(b, studentsById, { full: true })));
    return out;
  }, [isStudent, selected, groupsById, studentsById]);

  // ── Terms: all started terms, newest first ──────────────────
  // A term renders once it has started (start <= today): past, current,
  // and future-once-started. The current term (today within [start,end])
  // is editable; past terms are read-only. During a holiday gap there is
  // no current term but past terms still render — the page is not blank.
  const allTerms = useMemo(() => getTerms(termBreaks, now), [termBreaks, now]);
  const startedTerms = useMemo(
    () => (allTerms || []).filter(t => t.start <= now),
    [allTerms, now]
  );
  const currentTerm = useMemo(
    () => startedTerms.find(t => now >= t.start && now <= t.end) || null,
    [startedTerms, now]
  );
  const termsToRender = useMemo(
    () => [...startedTerms].sort((a, b) => b.start - a.start), // newest first
    [startedTerms]
  );

  const [expandedTerms, setExpandedTerms] = useState(() => new Set());
  // Auto-expand the current term once it's known (past terms collapsed).
  useEffect(() => {
    if (currentTerm) setExpandedTerms(prev => new Set(prev).add(currentTerm.key));
  }, [currentTerm]);

  const toggleTerm = (key) => setExpandedTerms(prev => {
    const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n;
  });

  // ── Notes bucketed by week_key ──────────────────────────────
  const notesByWeek = useMemo(() => {
    const m = new Map();
    for (const note of (notes || [])) {
      const key = note.weekKey;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(note);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    }
    return m;
  }, [notes]);

  // ── Header (student variant or group variant) ───────────────
  const Header = () => {
    if (!selected) return null;

    // Admin is never a subject's primary teacher, so the badge always
    // shows. Tint with the teacher's colour; if none resolved, show a
    // neutral "unassigned" badge.
    const PrimaryBadge = () => {
      if (!primaryTeacher) {
        return (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 999,
            background: colors.bg, color: colors.textMuted, border: `1px solid ${colors.border}`,
          }}>
            Primary teacher: unassigned
          </span>
        );
      }
      const c = primaryTeacher.colour || colors.accent || "#4F8EF7";
      return (
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 999,
          background: c + "18", color: c, border: `1px solid ${c}55`,
        }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: c }} />
          Primary teacher: {primaryTeacher.name || "—"}
        </span>
      );
    };

    if (isStudent) {
      if (!student) {
        return <div style={{ padding: 24, color: colors.textMuted }}>(unknown student)</div>;
      }
      const instruments = activeEnrolmentsFor(student.id, enrolments)
        .map(e => e.instrument).filter(Boolean).join(", ");
      return (
        <div style={{ padding: "20px 24px 16px", borderBottom: `1px solid ${colors.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: colors.text }}>{preferredDisplayName(student.name)}</h2>
            <PrimaryBadge />
          </div>
          <div style={{ fontSize: 13, color: colors.textMuted, marginBottom: 4 }}>
            {[instruments, schoolName(student.schoolId), student.className].filter(Boolean).join(" · ")}
          </div>
          {alsoInGroups.length > 0 && (
            <div style={{ fontSize: 12, color: colors.textLight, marginTop: 8 }}>
              <span style={{ color: colors.textMuted }}>Also in: </span>
              {alsoInGroups.map((g, i) => (
                <React.Fragment key={g.id}>
                  {i > 0 && <span style={{ color: colors.textMuted }}>, </span>}
                  <button
                    onClick={() => setSelected({ type: "group", id: g.id })}
                    style={{
                      background: "none", border: "none", padding: 0,
                      color: colors.accent, fontFamily: "inherit", fontSize: 12,
                      cursor: "pointer", textDecoration: "underline",
                    }}
                  >
                    <Users size={11} style={{ display: "inline-block", verticalAlign: "-1px", marginRight: 3 }} />
                    {groupDisplayLabel(g, studentsById, { full: true })}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
      );
    }

    // Group variant
    if (!group) {
      return <div style={{ padding: 24, color: colors.textMuted }}>(unknown group)</div>;
    }
    const label = groupDisplayLabel(group, studentsById, { full: true });
    const dayTime = subjectLesson?.day && subjectLesson?.start
      ? `${subjectLesson.day} ${subjectLesson.start}${subjectLesson.end ? `–${subjectLesson.end}` : ""}`
      : "";
    const instrument = group.instrument || subjectLesson?.instrument || "Group";
    const memberIds = groupMemberIds(group);

    return (
      <div style={{ padding: "20px 24px 16px", borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
          <Users size={20} style={{ color: colors.textMuted }} />
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: colors.text }}>{label}</h2>
          <PrimaryBadge />
        </div>
        <div style={{ fontSize: 13, color: colors.textMuted, marginBottom: 10 }}>
          {[instrument, schoolName(group.schoolId), dayTime].filter(Boolean).join(" · ")}
        </div>
        {memberIds.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Members
            </div>
            {memberIds.map(mid => {
              const st = studentsById.get(mid);
              const name = preferredDisplayName(st?.name || group.memberNamesById?.[mid]) || "(unknown)";
              const sub = st ? [schoolName(st.schoolId), st.className].filter(Boolean).join(" · ") : "";
              return (
                <button
                  key={mid}
                  onClick={() => setSelected({ type: "student", id: mid })}
                  disabled={!st}
                  style={{
                    background: "none", border: "none", padding: "2px 0",
                    textAlign: "left", fontFamily: "inherit",
                    cursor: st ? "pointer" : "default",
                    color: st ? colors.text : colors.textMuted,
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 13, textDecoration: st ? "underline" : "none", color: st ? colors.accent : colors.textMuted }}>
                    {name}
                  </span>
                  {sub && <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 8 }}>{sub}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // ── Read-only note row (other authors + all past-term notes) ─
  const NoteRow = ({ note }) => {
    const author = teachersById.get(note.authorId) || null;
    const authorName = author?.name || "—";
    const authorColor = author?.colour || author?.color || colors.accent || "#4F8EF7";
    const isPrimary = !!primaryTeacherId && note.authorId === primaryTeacherId;
    const rendered = renderNoteBody(note.body);
    return (
      <div style={{
        padding: "10px 12px 10px",
        borderLeft: isPrimary ? `1px solid ${colors.border}` : `4px solid ${authorColor}`,
        background: darkMode ? "rgba(255,255,255,0.02)" : "#FAFBFC",
        borderRadius: 8, marginBottom: 8,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, marginBottom: 6,
          color: isPrimary ? colors.textMuted : authorColor,
        }}>
          Written by {authorName} · {fmtTimestamp(note.createdAt)}
        </div>
        {rendered
          ? <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5 }}>{rendered}</div>
          : <div style={{ fontSize: 12, color: colors.textMuted, fontStyle: "italic" }}>(empty note)</div>}
      </div>
    );
  };

  // ── Week card ────────────────────────────────────────────────
  // `editable` = this is the current term. When editable AND myTeacherId
  // is known, the admin's own note is the editable tail instance and the
  // others render read-only above. When editable but myTeacherId is null,
  // every note renders read-only and an inline message replaces the
  // editor. Past terms (editable=false) are always fully read-only.
  const WeekCard = ({ weekKey, weekNum, termId, editable }) => {
    const isCurrent = weekKey === todayMondayKey;
    const weekNotes = notesByWeek.get(weekKey) || [];
    const accent = colors.accent || "#4F8EF7";
    const canEdit = editable && !!myTeacherId;
    const others = canEdit ? weekNotes.filter(n => n.authorId !== myTeacherId) : weekNotes;
    const myNote = canEdit ? (weekNotes.find(n => n.authorId === myTeacherId) || null) : null;
    const myTeacher = myTeacherId ? teachersById.get(myTeacherId) : null;
    const myColor = !primaryIsMe ? (myTeacher?.colour || myTeacher?.color || null) : null;
    return (
      <div style={{
        marginBottom: 10, borderRadius: 10,
        border: `1px solid ${isCurrent ? accent + "60" : colors.border}`,
        background: isCurrent ? (darkMode ? "rgba(79,142,247,0.06)" : "#F8FBFF") : colors.cardBg,
        overflow: "hidden",
      }}>
        <div style={{
          padding: "8px 14px", fontSize: 12, fontWeight: 700,
          color: isCurrent ? accent : colors.textLight,
          background: isCurrent ? accent + "12" : "transparent",
          borderBottom: `1px solid ${colors.border}`,
          letterSpacing: 0.2,
        }}>
          Week {weekNum}
        </div>
        <div style={{ padding: "10px 14px 12px" }}>
          {others.map(n => <NoteRow key={n.id} note={n} />)}
          {canEdit && (
            <NoteEditor
              key={`${selected.type}:${selected.id}:${weekKey}`}
              initialBody={myNote?.body || null}
              placeholder="Add note for this week…"
              onSave={(body) => onSaveNote(weekKey, termId, body)}
              onDelete={myNote ? () => onDeleteNote(myNote.id) : undefined}
              onActivity={() => onEditActivity(weekKey)}
              savedAt={myNote?.updatedAt || null}
              authorColor={myColor}
              isEmpty={!myNote}
            />
          )}
          {editable && !myTeacherId && (
            <div style={{
              marginTop: 8, padding: "8px 12px", borderRadius: 8,
              border: `1px solid ${colors.border}`, background: colors.bg,
              fontSize: 12, color: colors.textMuted,
            }}>
              Couldn't identify your account — notes can't be added.
            </div>
          )}
        </div>
      </div>
    );
  };

  const TermAccordion = ({ term, editable }) => {
    const open = expandedTerms.has(term.key);
    const weeks = getTermWeeks({ activeTerm: term, termBreaks, now: term.end })
      .filter(w => !w.isHoliday);
    return (
      <div style={{ marginBottom: 14 }}>
        <button
          onClick={() => toggleTerm(term.key)}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            width: "100%", padding: "10px 12px",
            background: "transparent", border: `1px solid ${colors.border}`,
            borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
            textAlign: "left", color: colors.text, fontWeight: 700, fontSize: 14,
          }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {/* Built locally (Term {N} {year}) rather than term.label
              ("{year} Term {N}") — termWeeks.js is a byte-identical mirror
              and must not be edited. */}
          <span>Term {term.num} {term.year}</span>
          {!editable && (
            <span style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, marginLeft: "auto" }}>
              Read-only
            </span>
          )}
        </button>
        {open && (
          <div style={{ marginTop: 8 }}>
            {weeks.map(w => (
              <WeekCard key={`${term.key}-${w.weekKey}`} weekKey={w.weekKey} weekNum={w.weekNum} termId={term.key} editable={editable} />
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── Render ──────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
      <div style={{ overflowY: "auto" }}>
        <Header />
        <div style={{ padding: "16px 20px 24px" }}>
          {/* ── Attachments seam — cluster 6.3b re-adds <AttachmentsPanel> here. ── */}
          {notesLoading && (
            <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10 }}>
              Loading notes…
            </div>
          )}
          {termsToRender.length === 0 ? (
            <div style={{ fontSize: 13, color: colors.textMuted }}>
              No terms have started yet.
            </div>
          ) : (
            termsToRender.map(term => (
              <TermAccordion
                key={term.key}
                term={term}
                editable={!!currentTerm && term.key === currentTerm.key}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// Local YYYY-MM-DD formatter (kept local; termWeeks.js inlines its own).
function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
