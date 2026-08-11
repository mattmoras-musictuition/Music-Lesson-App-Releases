// ============================================================
// CONCERTS MANAGER
//
// One concert per school (spec §5.1), holding an ordered list of
// pieces built and reordered over the year and finally printed as
// an audience program. Concert pieces deliberately do NOT touch the
// timetable — they never generate lesson cards (§3).
//
// Permissions are flat by design (§4.4): every authenticated user
// can create, edit, reorder and delete every piece at every school.
// There is no ownership model here and none should be added — the
// RLS behind it is USING (true) WITH CHECK (true), and client-side
// gating that isn't backed by RLS is explicitly out of scope.
//
// Instrument abbreviations (cluster 4) are EDITED in Settings, not
// here; this file only reads them so the short form that will print
// is visible at the point of choosing an instrument. The printed
// program export (cluster 5) is NOT part of this file yet.
// ============================================================

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Trash2, Music, GripVertical, StickyNote, Plus, Pencil, Paperclip, FileDown, Minus, Library } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
// PAGE_COLORS deliberately not imported: it has no `concerts` key, and the
// four other keyless pages (Messages, Calendar, Student Notes, Invoicing)
// simply omit `pageColor` and let PageTitle fall back to colors.sidebarActive
// — which is the value every PAGE_COLORS entry already holds.
import { Card, PageTitle, NavButtons, EmptyState, Btn } from "../components/ui/SharedUI";
import { fetchResourceTaxonomies, fetchInstrumentAbbreviations, abbreviateInstrument } from "../utils/resourcesDB";
import { getSchoolAcronym } from "../utils/helpers";
import { preferredDisplayName } from "../utils/studentName";
// The program export (§4.7). electronPrintToPdf is used as-is — the PDF's
// portrait orientation comes from the document's own @page rule, not from
// bridge options, which preload.js drops.
import { electronPrintToPdf } from "../data/exportHelpers";
import { uploadExportToDocuments } from "../utils/exportToDocuments";
import {
  buildConcertProgramHtml, buildProgramRows, estimateProgramPages,
  autoFitProgramScale, clampProgramScale,
  MIN_PROGRAM_SCALE, MAX_PROGRAM_SCALE, PROGRAM_SCALE_STEP,
} from "../utils/concertProgramHtml";
import { LinkBrowser } from "../components/LinkBrowser";
import { ConcertAttachmentsPanel } from "../components/ConcertAttachmentsPanel";
import {
  getOrCreateConcertForSchool, updateConcertTitle, getConcertItems,
  createConcertItem, updateConcertItem, deleteConcertItem,
  reorderConcertItems, clearConcertItems, getAttachmentsForItems,
  resolveAttachmentTarget,
} from "../utils/concertsDB";
import { iconForFileName } from "../utils/resourceTypeIcons";

// A blank performer row. Exactly one of studentId / name carries a
// value in a saved row (§5.2); `mode` is editor-only state and is
// stripped before the row is written.
const blankPerformer = () => ({ studentId: "", name: "", instrument: "", mode: "student" });

// Copy-once fill from a band (§4.1). The result is fully independent
// of the band from this point on — nothing here ever writes back, and
// later edits to the band never reach the piece.
function copyFromBand(band) {
  // A member playing two instruments becomes TWO performer rows for
  // the same student, one per instrument — the concert performer
  // shape carries a single instrument each.
  const performers = (band.members || []).flatMap(m => {
    const rows = [{ studentId: m.studentId || "", name: "", instrument: m.instrument || "", mode: "student" }];
    if (m.instrument2) {
      rows.push({ studentId: m.studentId || "", name: "", instrument: m.instrument2, mode: "student" });
    }
    return rows;
  });

  // personnel is the source of truth; the legacy teacher_id +
  // teacher_instrument pair is read only as a fallback when
  // personnel is empty. Same precedence BandsManager displays with.
  const personnel = (band.personnel || []).length > 0
    ? (band.personnel || []).map(p => ({ teacherId: p.teacherId || "", instrument: p.instrument || "" }))
    : (band.teacherId ? [{ teacherId: band.teacherId, instrument: band.teacherInstrument || "" }] : []);

  return { performers, personnel, bandId: band.id };
}

// NOTE ON setDocuments: the program files itself into the Documents tab, and
// documents are whole-list synced from App.js — a row written directly to
// Supabase is deleted by the next sync's delete-not-in-list sweep, so
// setDocuments is the only correct path. App.js passes it at the ConcertsManager
// render alongside `documents`, the same pair ExportDialog receives.
//
// It stays optional here rather than required: the export is one action on this
// page, and a page that renders nothing because a Documents prop went missing
// would be a worse failure than an export that can't file its output. If it ever
// does go missing that is a wiring regression, not a user-facing state, so
// runExport logs it to the console instead of blaming the upload.
export function ConcertsManager({ schools, students, teachers, bands, notify, goBack, goForward, historyCursor, pageHistory, setDocuments }) {
  const { colors } = useTheme();

  const [selectedSchool, setSelectedSchool] = useState("");
  const [concert, setConcert] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [titleDraft, setTitleDraft] = useState("");
  const [taxInstruments, setTaxInstruments] = useState([]);
  const [instAbbrevs, setInstAbbrevs] = useState({});

  const [form, setForm] = useState(null);          // the piece being edited
  const [editing, setEditing] = useState(null);    // "new" | item id
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [draggingIdx, setDraggingIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  // itemId → its attachments. Fetched in one batched query with the
  // list; the paperclip on each row reads its count from here.
  const [attachmentsByItem, setAttachmentsByItem] = useState(() => new Map());
  const [attachmentsFor, setAttachmentsFor] = useState(null); // the piece whose panel is open
  const [browserLink, setBrowserLink] = useState(null);       // { url, title } for the in-app browser

  // ── Program export (§4.7) ───────────────────────────────────
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScale, setExportScale] = useState(1);
  const [exportBusy, setExportBusy] = useState(false);

  // ── Paperclip hover list ────────────────────────────────────
  // { itemId, rect } — the anchor's viewport rect, captured on enter.
  const [hoverAtts, setHoverAtts] = useState(null);
  const hoverTimer = useRef(null);

  const cancelHoverClose = () => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
  };
  // A short grace period so the pointer can travel from the paperclip into
  // the popover without it vanishing underneath.
  const closeHoverSoon = () => {
    cancelHoverClose();
    hoverTimer.current = setTimeout(() => setHoverAtts(null), 140);
  };
  const openHover = (e, itemId) => {
    // Reads the already-batched map — hovering never triggers a fetch. No
    // attachments means no popover at all, rather than an empty one.
    if ((attachmentsByItem.get(itemId) || []).length === 0) return;
    cancelHoverClose();
    setHoverAtts({ itemId, rect: e.currentTarget.getBoundingClientRect() });
  };

  // The anchor rect is captured once, so scrolling would leave the popover
  // floating over unrelated rows. Close instead of chasing it — a hover
  // affordance shouldn't outlive the hover.
  useEffect(() => {
    if (!hoverAtts) return undefined;
    const close = () => setHoverAtts(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [hoverAtts]);

  useEffect(() => () => cancelHoverClose(), []);

  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDeleteRow, setConfirmDeleteRow] = useState(null); // item pending delete from the list
  const [confirmDeleteForm, setConfirmDeleteForm] = useState(false); // delete from inside the editor
  const [confirmRepull, setConfirmRepull] = useState(false);

  // ── Lookups ─────────────────────────────────────────────────
  const studentsById = useMemo(() => {
    const m = new Map();
    for (const s of students || []) m.set(s.id, s);
    return m;
  }, [students]);

  const teachersById = useMemo(() => {
    const m = new Map();
    for (const t of teachers || []) m.set(t.id, t);
    return m;
  }, [teachers]);

  // Bands offered by the piece editor's picker — the selected school's
  // only. Read from the in-memory prop; bandsDB syncs the whole list
  // with a delete sweep, so this page never queries or writes it.
  const schoolBands = useMemo(
    () => (bands || []).filter(b => b.schoolId === selectedSchool),
    [bands, selectedSchool]
  );

  // Options for the performer student picker. Same pool the Bands
  // member search draws from (this school, active).
  const schoolStudents = useMemo(
    () => (students || [])
      .filter(s => s.schoolId === selectedSchool && s.status === "active")
      .sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [students, selectedSchool]
  );

  // ── Default the school selection ────────────────────────────
  useEffect(() => {
    if (selectedSchool || !(schools || []).length) return;
    setSelectedSchool(schools[0].id);
  }, [schools, selectedSchool]);

  // ── Instrument taxonomy + abbreviations (managed in Settings) ─
  // Two separate app_settings rows, read independently: the names come
  // from `instruments`, the short forms from `instrument_abbreviations`.
  useEffect(() => {
    fetchResourceTaxonomies()
      .then(tax => setTaxInstruments(tax?.instruments || []))
      .catch(() => { /* dropdown falls back to whatever the row already holds */ });
    // Never throws (missing row → {}); an empty map just means every
    // option shows its computed short form.
    fetchInstrumentAbbreviations().then(setInstAbbrevs);
  }, []);

  // ── Load the selected school's concert + items ──────────────
  useEffect(() => {
    if (!selectedSchool) return;
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    (async () => {
      try {
        const row = await getOrCreateConcertForSchool(selectedSchool);
        if (cancelled) return;
        setConcert(row);
        setTitleDraft(row.title || "");
        const list = await getConcertItems(row.id);
        if (cancelled) return;
        setItems(list);

        // One batched query for the whole list rather than one per row.
        // Non-fatal: a failure here costs the paperclip counts, not the
        // concert, so the page still renders.
        try {
          const byItem = await getAttachmentsForItems(list.map(it => it.id));
          if (!cancelled) setAttachmentsByItem(byItem);
        } catch (attErr) {
          if (!cancelled) {
            console.warn("[concerts] attachment counts failed:", attErr?.message || attErr);
            setAttachmentsByItem(new Map());
          }
        }
      } catch (err) {
        if (cancelled) return;
        console.error("[concerts] load failed:", err);
        setLoadError(err?.message || "Couldn't load this school's concert.");
        setConcert(null);
        setItems([]);
        setAttachmentsByItem(new Map());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedSchool]);

  // Leaving a school mid-edit would save the piece against the wrong
  // concert, so switching schools closes the editor.
  const changeSchool = (schoolId) => {
    if (schoolId === selectedSchool) return;
    setForm(null); setEditing(null); setFormError("");
    setSelectedSchool(schoolId);
  };

  // ── Concert title (saves on blur) ───────────────────────────
  const commitTitle = async () => {
    if (!concert) return;
    const next = titleDraft.trim();
    if (next === (concert.title || "")) return;
    try {
      const updated = await updateConcertTitle(concert.id, next);
      setConcert(updated);
      setTitleDraft(updated.title || "");
    } catch (err) {
      console.error("[concerts] title save failed:", err);
      notify && notify("Couldn't save the concert title", "danger");
      setTitleDraft(concert.title || "");
    }
  };

  // ── Instrument options ──────────────────────────────────────
  // The managed taxonomy, plus the row's own value when it isn't in
  // the list. Band-copied instruments come from BAND_INSTRUMENTS in
  // constants.js, which is a separate hardcoded list that disagrees
  // with the taxonomy ("Bass" vs "Bass Guitar") — so a copied value
  // must render as a selected, valid option rather than silently
  // blanking or being auto-corrected to something the user didn't
  // choose. The two lists are NOT reconciled here by design.
  const instrumentOptions = useCallback((current) => {
    const list = taxInstruments || [];
    if (current && !list.includes(current)) return [...list, current];
    return list;
  }, [taxInstruments]);

  // Option label only — "Guitar (Gtr)" — so the abbreviation that will print
  // is visible at the point of choosing. What's STORED stays the instrument
  // name alone; the <option value> is untouched. An off-taxonomy value like
  // the band-copied "Bass" resolves through the same helper and falls back to
  // a computed short form when the map has no entry for it.
  const instrumentOptionLabel = useCallback((name) => {
    const ab = abbreviateInstrument(name, instAbbrevs);
    return ab ? `${name} (${ab})` : name;
  }, [instAbbrevs]);

  // ── Display helpers ─────────────────────────────────────────
  // A linked student shows their preferred name — "Megumi (Meg) Van Haven"
  // reads as "Meg Van Haven", matching what the printed program does through
  // the same helper. A free-text performer is left verbatim: that field is
  // labelled "Name as it should print".
  const performerLabel = useCallback((p) => {
    const stored = p.studentId ? (studentsById.get(p.studentId)?.name || "") : "";
    const name = p.studentId
      ? ((preferredDisplayName(stored) || stored).trim() || "Unknown student")
      : (p.name || "");
    if (!name) return "";
    return p.instrument ? `${name} (${p.instrument})` : name;
  }, [studentsById]);

  // Structured rather than a joined string, so the NAME alone can carry the
  // teacher's own colour while "with" and the instrument parenthetical keep
  // the row's muted styling. `color` is teachers.color — the same hex the
  // Teachers page, Dashboard chips and Calendar read — and is "" when unset,
  // which the renderer treats as "leave it alone".
  const teacherParts = useCallback((personnel) => (
    (personnel || []).map(p => {
      const t = teachersById.get(p.teacherId);
      const name = t?.name || "";
      if (!name) return null;
      return { id: p.teacherId, name, color: t?.color || "", instrument: p.instrument || "" };
    }).filter(Boolean)
  ), [teachersById]);

  // ── Piece editor open / close ───────────────────────────────
  const newPiece = () => {
    setForm({ id: null, title: "", bandId: null, performers: [], personnel: [], notes: "" });
    setEditing("new");
    setFormError("");
  };

  const editPiece = (item) => {
    setForm({
      id: item.id,
      title: item.title || "",
      bandId: item.bandId || null,
      // `mode` is editor-only: a saved row carries either studentId or
      // name, and which one tells us which control to show.
      performers: (item.performers || []).map(p => ({ ...p, mode: p.studentId ? "student" : "other" })),
      personnel: (item.personnel || []).map(p => ({ ...p })),
      notes: item.notes || "",
    });
    setEditing(item.id);
    setFormError("");
  };

  const closeForm = () => {
    setForm(null); setEditing(null); setFormError("");
    setConfirmDeleteForm(false); setConfirmRepull(false);
  };

  // ── Save ────────────────────────────────────────────────────
  const savePiece = async () => {
    if (!form || !concert) return;
    const title = (form.title || "").trim();
    if (!title) { setFormError("A song title is required."); return; }

    // Strip editor-only state and drop the field the mode doesn't use,
    // so a saved performer carries exactly one of studentId / name.
    const performers = (form.performers || [])
      .map(p => p.mode === "other"
        ? { studentId: "", name: (p.name || "").trim(), instrument: p.instrument || "" }
        : { studentId: p.studentId || "", name: "", instrument: p.instrument || "" })
      // A row with neither a picked student nor a typed name is an
      // unfinished row, not a performer — drop it rather than saving
      // a blank line that would print as "()" on the program.
      .filter(p => p.studentId || p.name);

    const personnel = (form.personnel || [])
      .map(p => ({ teacherId: p.teacherId || "", instrument: p.instrument || "" }))
      .filter(p => p.teacherId);

    const payload = { title, bandId: form.bandId || null, performers, personnel, notes: form.notes || "" };

    setSaving(true);
    setFormError("");
    try {
      if (editing === "new") {
        const created = await createConcertItem(concert.id, payload);
        setItems(prev => [...prev, created]);
        notify && notify("Piece added");
      } else {
        const updated = await updateConcertItem(form.id, payload);
        setItems(prev => prev.map(it => it.id === updated.id ? updated : it));
        notify && notify("Piece saved");
      }
      closeForm();
    } catch (err) {
      console.error("[concerts] save failed:", err);
      setFormError(err?.message || "Couldn't save this piece — try again.");
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ──────────────────────────────────────────────────
  const removePiece = async (itemId) => {
    try {
      await deleteConcertItem(itemId);
      setItems(prev => prev.filter(it => it.id !== itemId));
      // The attachment rows cascade in the database (ON DELETE CASCADE);
      // drop the local entry so a re-created id can't inherit a count.
      setAttachmentsByItem(prev => {
        if (!prev.has(itemId)) return prev;
        const next = new Map(prev);
        next.delete(itemId);
        return next;
      });
      notify && notify("Piece removed");
      if (form && form.id === itemId) closeForm();
    } catch (err) {
      console.error("[concerts] delete failed:", err);
      notify && notify("Couldn't remove that piece", "danger");
    }
    setConfirmDeleteRow(null); setConfirmDeleteForm(false);
  };

  // ── Clear all (§4.5) ────────────────────────────────────────
  // The concert row and its title survive so next year's list starts
  // against the same record. Offering the export first is cluster 5.
  const doClearAll = async () => {
    if (!concert) return;
    try {
      await clearConcertItems(concert.id);
      setItems([]);
      setAttachmentsByItem(new Map());   // rows cascaded with their pieces
      notify && notify("All pieces cleared");
    } catch (err) {
      console.error("[concerts] clear failed:", err);
      notify && notify("Couldn't clear the list", "danger");
    }
    setConfirmClear(false);
  };

  // ── Program export (§4.7) ───────────────────────────────────
  // The heading prints what's on screen: titleDraft is committed to
  // concerts.title on blur, but clicking Export blurs and saves in the same
  // beat, so reading the draft avoids printing a title one edit behind.
  const programTitle = (titleDraft || "").trim() || (concert?.title || "").trim();

  const programRows = useMemo(
    () => buildProgramRows(items, studentsById, instAbbrevs),
    [items, studentsById, instAbbrevs]
  );

  // Page count for the "before saving" report. Recomputed as the nudge moves,
  // from the same layout model the builder uses, so the number shown and the
  // document produced can't disagree.
  const exportPages = useMemo(
    () => estimateProgramPages({ title: programTitle, rows: programRows, scale: exportScale }),
    [programTitle, programRows, exportScale]
  );

  // buildExportFilename is not reused here: it is week-centric and always
  // produces a "Master"/"Week N" head, which would label a concert program
  // "Master - MPS". Built locally instead — school acronym plus the concert's
  // own title, stripped of characters that are illegal in a filename.
  const programFilename = useMemo(() => {
    const school = (schools || []).find(s => s.id === selectedSchool);
    const acronym = school ? getSchoolAcronym(school) : "";
    return [acronym, programTitle || "Concert Program"]
      .filter(Boolean).join(" - ")
      .replace(/[/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim() || "Concert Program";
  }, [schools, selectedSchool, programTitle]);

  const openExport = () => {
    // Guard: an empty concert would produce a page with a heading and nothing
    // under it. Warn rather than render it.
    if (items.length === 0) {
      notify && notify("Add at least one piece before exporting the program", "warning");
      return;
    }
    setExportScale(autoFitProgramScale({ title: programTitle, rows: programRows }));
    setExportOpen(true);
  };

  const nudgeScale = (delta) =>
    setExportScale(s => Math.round(clampProgramScale(s + delta) * 100) / 100);

  const runExport = async () => {
    if (!concert || items.length === 0) return;
    setExportBusy(true);
    try {
      const html = buildConcertProgramHtml({
        title: programTitle, items, studentsById,
        abbreviations: instAbbrevs, scale: exportScale,
      });
      const pdfBase64 = await electronPrintToPdf(html);
      if (!pdfBase64) {
        notify && notify("PDF generation unavailable — program not saved", "danger");
        return;
      }
      // Filed through setDocuments, never a direct row write: the documents
      // whole-list sync deletes any row that isn't in the in-memory list.
      //
      // App.js passes setDocuments, so a missing one here means the prop was
      // dropped from the render — a wiring regression the user can do nothing
      // about. Name it in the console rather than reporting it as a failed
      // upload, which is what the message below now describes.
      if (!setDocuments) {
        console.error("[concerts] setDocuments prop missing — the program cannot be filed in Documents");
      }
      const doc = await uploadExportToDocuments({
        pdfBase64,
        filename: `${programFilename}.pdf`,
        label: programFilename,
        setDocuments,
        type: "Concert",
        schoolId: selectedSchool,
      });
      if (doc) {
        notify && notify(`Program saved to Documents — ${exportPages} page${exportPages === 1 ? "" : "s"}`);
        setExportOpen(false);
      } else {
        // Reached when the upload to the documents bucket fails — the PDF
        // rendered, but nothing was filed, so nothing is left half-saved.
        notify && notify("Couldn't upload the program to Documents — try again", "danger");
      }
    } catch (err) {
      console.error("[concerts] export failed:", err);
      notify && notify("Export failed: " + (err?.message || "unknown error"), "danger");
    } finally {
      setExportBusy(false);
    }
  };

  // Label for a hover-list row. The panel resolves a reference's label from
  // its loaded library Map; here displayLabel already holds it (addLibraryReference
  // stores resource.label at attach time), so the list needs no library load.
  const attachmentLabel = useCallback((att) => {
    if (att.displayLabel) return att.displayLabel;
    if (att.isFile) return att.fileName || "File";
    if (att.isReference) return "Library item";
    if (att.pageTitle) return att.pageTitle;
    try { return new URL(att.url).hostname || att.url; } catch { return att.url || "Link"; }
  }, []);

  // Opens by exactly the panel's rules — both go through resolveAttachmentTarget.
  const openAttachmentFromHover = async (att) => {
    try {
      const target = await resolveAttachmentTarget(att);
      if (!target) {
        notify && notify(
          att.isReference ? "That library item is no longer available" : "Couldn't open that file",
          att.isReference ? "warning" : "danger"
        );
        return;
      }
      setHoverAtts(null);
      setBrowserLink({ url: target, title: attachmentLabel(att) });
    } catch (err) {
      console.error("[concerts] hover open failed:", err);
      notify && notify("Couldn't open that attachment", "danger");
    }
  };

  // ── Band copy (§4.1) ────────────────────────────────────────
  const applyBandCopy = (band) => {
    const copy = copyFromBand(band);
    setForm(prev => ({
      ...prev,
      // Never clobber a typed title — fill it only when it's empty.
      title: (prev.title || "").trim() ? prev.title : (band.name || ""),
      performers: copy.performers,
      personnel: copy.personnel,
      bandId: copy.bandId,
    }));
    setFormError("");
  };

  const linkedBand = form?.bandId ? (bands || []).find(b => b.id === form.bandId) : null;

  // ── Drag to reorder ─────────────────────────────────────────
  // TeachersManager persists a reorder by whole-list sync; this must
  // not. The new array index becomes each piece's position, and only
  // the rows whose position actually changed are written (§8).
  const handleDrop = async (targetIdx) => {
    if (draggingIdx === null || draggingIdx === targetIdx) {
      setDraggingIdx(null); setDragOverIdx(null);
      return;
    }
    const previous = items;
    const next = [...items];
    const [moved] = next.splice(draggingIdx, 1);
    next.splice(targetIdx, 0, moved);

    const changed = next
      .map((it, i) => (it.position === i ? null : { id: it.id, position: i }))
      .filter(Boolean);

    // Optimistic: the list reorders under the cursor immediately.
    setItems(next.map((it, i) => ({ ...it, position: i })));
    setDraggingIdx(null); setDragOverIdx(null);

    if (changed.length === 0) return;
    try {
      await reorderConcertItems(changed);
    } catch (err) {
      console.error("[concerts] reorder failed:", err);
      notify && notify("Couldn't save the new order", "danger");
      // The writes go out in parallel, so a failure can leave SOME rows
      // moved. Re-reading is the only way to show what the database
      // actually holds — reverting to the pre-drag snapshot would
      // display an order that may no longer be true. Fall back to that
      // snapshot only if the re-read itself fails.
      try {
        setItems(await getConcertItems(concert.id));
      } catch (reloadErr) {
        console.error("[concerts] reorder reload failed:", reloadErr);
        setItems(previous);
      }
    }
  };

  // ── Shared styles ───────────────────────────────────────────
  const inputStyle = { width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", background: colors.cardBg, color: colors.text };
  const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: colors.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 };
  const addBtnStyle = { padding: "4px 12px", background: colors.sidebarActive, color: colors.cardBg, border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };
  const emptyNote = { fontSize: 12, color: colors.textMuted, fontStyle: "italic" };

  // A confirmation dialog. Matches the app's existing modal shape
  // (fixed overlay, centred card, explicit confirm button).
  // `extraAction` is an optional non-destructive escape hatch, rendered away
  // from the confirm button on the opposite side so it can't be mistaken for
  // the default. Used by clear-all to offer the export first (§4.5).
  const confirmDialog = ({ heading, body, confirmLabel, onConfirm, onCancel, extraAction }) => (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onCancel}>
      <div style={{ background: colors.cardBg, borderRadius: 14, padding: 28, maxWidth: 460, width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, color: colors.danger, marginBottom: 10 }}>{heading}</div>
        <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.65, marginBottom: 20 }}>{body}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "center" }}>
          {extraAction && (
            <button onClick={extraAction.onClick}
              style={{ marginRight: "auto", padding: "8px 14px", background: "none", color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}>
              {extraAction.icon}{extraAction.label}
            </button>
          )}
          <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
          <button onClick={onConfirm}
            style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: colors.danger, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  // ══ PIECE EDITOR ═══════════════════════════════════════════
  if (form) {
    const setPerformer = (idx, patch) => setForm(prev => ({
      ...prev,
      performers: prev.performers.map((row, i) => i === idx ? { ...row, ...patch } : row),
    }));
    const setTeacherRow = (idx, patch) => setForm(prev => ({
      ...prev,
      personnel: prev.personnel.map((row, i) => i === idx ? { ...row, ...patch } : row),
    }));

    return (
      <div>
        <PageTitle
          navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}>
          {editing === "new" ? "New Piece" : "Edit Piece"}
        </PageTitle>

        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <label style={labelStyle}>Song Title</label>
              <input style={inputStyle} value={form.title} autoFocus
                onChange={e => { setForm(p => ({ ...p, title: e.target.value })); if (formError) setFormError(""); }}
                placeholder="Song title" />
            </div>
            <div>
              <label style={labelStyle}>Copy from a band</label>
              <select style={inputStyle} value=""
                onChange={e => {
                  const band = schoolBands.find(b => b.id === e.target.value);
                  if (band) applyBandCopy(band);
                }}>
                <option value="">
                  {schoolBands.length === 0 ? "No bands at this school" : "Pick a band to copy…"}
                </option>
                {schoolBands.map(b => <option key={b.id} value={b.id}>{b.name || "Untitled band"}</option>)}
              </select>
              {linkedBand && (
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: colors.textMuted }}>
                    Copied from <strong style={{ color: colors.text }}>{linkedBand.name || "band"}</strong>
                  </span>
                  <button onClick={() => setConfirmRepull(true)}
                    style={{ padding: "3px 9px", background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                    Re-pull from band
                  </button>
                </div>
              )}
              {form.bandId && !linkedBand && (
                <div style={{ ...emptyNote, marginTop: 8 }}>The original band has been deleted — this piece is unaffected.</div>
              )}
            </div>
          </div>
          {formError && (
            <div style={{ marginTop: 12, fontSize: 12, color: colors.danger, fontWeight: 600 }}>{formError}</div>
          )}
        </Card>

        {/* ── Performers ── */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <label style={labelStyle}>Performers ({form.performers.length})</label>
            <button onClick={() => setForm(p => ({ ...p, performers: [...p.performers, blankPerformer()] }))}
              style={addBtnStyle}>+ Add</button>
          </div>
          {form.performers.length === 0 && (
            <div style={emptyNote}>No performers — valid for a staff item, and the program will print the title alone.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {form.performers.map((p, idx) => {
              // A copied student who has since left the school (or gone
              // inactive) is not in the option list — keep them selectable
              // so the copy isn't silently lost.
              const picked = p.studentId ? studentsById.get(p.studentId) : null;
              const showPicked = picked && !schoolStudents.some(s => s.id === picked.id);
              return (
                <div key={idx} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select value={p.mode}
                    onChange={e => setPerformer(idx, e.target.value === "student"
                      ? { mode: "student", name: "" }      // switching clears the other field
                      : { mode: "other", studentId: "" })}
                    style={{ ...inputStyle, width: 96, flexShrink: 0 }}>
                    <option value="student">Student</option>
                    <option value="other">Other</option>
                  </select>

                  {p.mode === "student" ? (
                    <select style={{ ...inputStyle, flex: 1 }} value={p.studentId}
                      onChange={e => setPerformer(idx, { studentId: e.target.value })}>
                      <option value="">Select student…</option>
                      {showPicked && <option value={picked.id}>{picked.name} (not at this school)</option>}
                      {schoolStudents.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  ) : (
                    <input style={{ ...inputStyle, flex: 1 }} value={p.name}
                      onChange={e => setPerformer(idx, { name: e.target.value })}
                      placeholder="Name as it should print" />
                  )}

                  <select style={{ ...inputStyle, flex: 1 }} value={p.instrument}
                    onChange={e => setPerformer(idx, { instrument: e.target.value })}>
                    <option value="">No instrument</option>
                    {instrumentOptions(p.instrument).map(i => <option key={i} value={i}>{instrumentOptionLabel(i)}</option>)}
                  </select>

                  <button onClick={() => setForm(prev => ({ ...prev, performers: prev.performers.filter((_, i) => i !== idx) }))}
                    title="Remove performer"
                    style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", padding: 4, lineHeight: 1, flexShrink: 0, display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
                </div>
              );
            })}
          </div>
        </Card>

        {/* ── Accompanying teachers ── */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <label style={labelStyle}>Teachers ({form.personnel.length})</label>
            <button onClick={() => setForm(p => ({ ...p, personnel: [...p.personnel, { teacherId: "", instrument: "" }] }))}
              style={addBtnStyle}>+ Add</button>
          </div>
          {form.personnel.length === 0 && (
            <div style={emptyNote}>No teachers yet — shown in the app only, never on the printed program</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {form.personnel.map((p, idx) => (
              <div key={idx} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select style={{ ...inputStyle, flex: 1 }} value={p.teacherId}
                  onChange={e => setTeacherRow(idx, { teacherId: e.target.value })}>
                  <option value="">Select teacher…</option>
                  {(teachers || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <select style={{ ...inputStyle, flex: 1 }} value={p.instrument}
                  onChange={e => setTeacherRow(idx, { instrument: e.target.value })}>
                  <option value="">Not performing</option>
                  {instrumentOptions(p.instrument).map(i => <option key={i} value={i}>{instrumentOptionLabel(i)}</option>)}
                </select>
                <button onClick={() => setForm(prev => ({ ...prev, personnel: prev.personnel.filter((_, i) => i !== idx) }))}
                  title="Remove teacher"
                  style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", padding: 4, lineHeight: 1, flexShrink: 0, display: "inline-flex", alignItems: "center" }}><X size={14} /></button>
              </div>
            ))}
          </div>
        </Card>

        {/* ── Notes ── */}
        <Card style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Notes</label>
          <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} value={form.notes}
            onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
            placeholder="Stage entrances, stands required, who solos where…" />
          <div style={{ ...emptyNote, marginTop: 6 }}>
            Internal only — notes never appear on the printed program.
          </div>
        </Card>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={savePiece} disabled={saving}
            style={{ padding: "10px 24px", background: colors.sidebarActive, color: colors.cardBg, border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save Piece"}
          </button>
          <button onClick={closeForm}
            style={{ padding: "10px 24px", background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            Cancel
          </button>
          {editing !== "new" && (
            <button onClick={() => setConfirmDeleteForm(true)}
              style={{ marginLeft: "auto", padding: "10px 20px", background: "none", color: colors.danger, border: `1px solid ${colors.danger}50`, borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Trash2 size={13} /> Delete piece
            </button>
          )}
        </div>

        {confirmRepull && linkedBand && confirmDialog({
          heading: "Re-pull from band?",
          body: <>This replaces every performer and teacher on this piece with the current members of <strong>{linkedBand.name || "the band"}</strong>. Any changes you've made by hand here will be lost.</>,
          confirmLabel: "Replace from band",
          onConfirm: () => { applyBandCopy(linkedBand); setConfirmRepull(false); },
          onCancel: () => setConfirmRepull(false),
        })}

        {confirmDeleteForm && confirmDialog({
          heading: "Delete this piece?",
          body: <>This permanently deletes <strong>{form.title || "this piece"}</strong> from the concert. It cannot be recovered.</>,
          confirmLabel: "Delete piece",
          onConfirm: () => removePiece(form.id),
          onCancel: () => setConfirmDeleteForm(false),
        })}
      </div>
    );
  }

  // ══ LIST ═══════════════════════════════════════════════════
  return (
    <div>
      <PageTitle
        navButtons={<NavButtons goBack={goBack} goForward={goForward} historyCursor={historyCursor} pageHistory={pageHistory} />}
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {items.length > 0 && (
              <Btn variant="secondary" onClick={openExport}>
                <FileDown size={13} /> Export program
              </Btn>
            )}
            {items.length > 0 && (
              <Btn variant="danger" onClick={() => setConfirmClear(true)}>
                <Trash2 size={13} /> Clear all items
              </Btn>
            )}
            <button onClick={newPiece} disabled={!concert}
              style={{ padding: "0 18px", height: 36, background: colors.accent, color: colors.cardBg, border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: concert ? "pointer" : "not-allowed", fontFamily: "inherit", opacity: concert ? 1 : 0.5 }}>
              + Add Piece
            </button>
          </div>
        }>
        Concerts
      </PageTitle>

      {/* ── School selector — always one school selected (§5.1) ── */}
      {(schools || []).length > 0 && (
        <div style={{ display: "flex", gap: 0, marginBottom: 20, borderRadius: 10, overflow: "hidden", border: `2px solid ${colors.sidebarHover}` }}>
          {(schools || []).map(s => {
            const isActive = selectedSchool === s.id;
            return (
              <button key={s.id} onClick={() => changeSchool(s.id)}
                style={{ flex: 1, padding: "12px 16px", border: "none", borderRight: `1px solid ${colors.sidebarHover}40`, background: isActive ? (s.color || colors.sidebarHover) : colors.cardBg, color: isActive ? colors.white : colors.text, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", transition: "background 0.15s, color 0.15s", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = colors.bg; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = colors.cardBg; }}>
                <span>{(s.name || "").replace(/Primary School/gi, "PS")}</span>
                {isActive && (
                  <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.75 }}>
                    {items.length} {items.length === 1 ? "piece" : "pieces"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {(schools || []).length === 0 && (
        <EmptyState icon={<Music size={32} />} title="No schools yet"
          subtitle="Add a school before building a concert program." />
      )}

      {/* ── Concert title ── */}
      {concert && (
        <Card style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Concert Title</label>
          <input style={inputStyle} value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
            placeholder="Concert title — appears at the top of the printed program" />
        </Card>
      )}

      {loadError && (
        <Card style={{ marginBottom: 16, borderColor: `${colors.danger}50` }}>
          <div style={{ fontSize: 13, color: colors.danger }}>{loadError}</div>
        </Card>
      )}

      {loading && <div style={{ fontSize: 13, color: colors.textMuted, fontStyle: "italic" }}>Loading…</div>}

      {/* ── The running order ── */}
      {!loading && concert && items.length === 0 && (
        <EmptyState icon={<Music size={32} />} title="No pieces yet"
          subtitle="Add the first piece, or copy one from a band that's been rehearsing."
          action="+ Add Piece" onAction={newPiece} />
      )}

      {!loading && items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((item, idx) => {
            const performerText = (item.performers || []).map(performerLabel).filter(Boolean).join(", ");
            const teachersOnPiece = teacherParts(item.personnel);
            const attachCount = (attachmentsByItem.get(item.id) || []).length;
            return (
              <Card key={item.id}
                draggable
                onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDraggingIdx(idx); }}
                onDragEnd={() => { setDraggingIdx(null); setDragOverIdx(null); }}
                onDragOver={e => { e.preventDefault(); if (draggingIdx !== null && draggingIdx !== idx) setDragOverIdx(idx); }}
                onDragLeave={() => setDragOverIdx(null)}
                onDrop={e => { e.preventDefault(); handleDrop(idx); }}
                onClick={() => editPiece(item)}
                style={{
                  cursor: draggingIdx === idx ? "grabbing" : "grab",
                  padding: "12px 16px",
                  opacity: draggingIdx === idx ? 0.4 : 1,
                  borderTop: dragOverIdx === idx && draggingIdx !== null && draggingIdx > idx ? `2.5px solid ${colors.accent}` : undefined,
                  borderBottom: dragOverIdx === idx && draggingIdx !== null && draggingIdx < idx ? `2.5px solid ${colors.accent}` : undefined,
                  transition: "opacity 0.15s",
                }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <GripVertical size={15} style={{ color: colors.textMuted, opacity: 0.5, flexShrink: 0, marginTop: 2 }} />

                  {/* Derived number — index + 1, never stored, never editable */}
                  <div style={{ minWidth: 26, textAlign: "right", fontSize: 15, fontWeight: 700, color: colors.textMuted, flexShrink: 0 }}>
                    {idx + 1}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                      <span style={{ fontWeight: 700, fontSize: 15, color: colors.text }}>{item.title || "Untitled piece"}</span>
                      {item.notes && (
                        <span title={item.notes} style={{ display: "inline-flex", alignItems: "center", color: colors.textMuted }}>
                          <StickyNote size={13} />
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12.5, color: performerText ? colors.textLight : colors.textMuted, fontStyle: performerText ? "normal" : "italic", lineHeight: 1.5 }}>
                      {performerText || "No performers"}
                    </div>
                    {teachersOnPiece.length > 0 && (
                      <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 3 }}>
                        with {teachersOnPiece.map((t, i) => (
                          <React.Fragment key={`${t.id}-${i}`}>
                            {i > 0 && ", "}
                            {/* Only the name is tinted. No colour set → inherits
                                the row's muted styling, exactly as before. */}
                            <span style={t.color ? { color: t.color } : undefined}>{t.name}</span>
                            {t.instrument ? ` (${t.instrument})` : ""}
                          </React.Fragment>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: 2, flexShrink: 0, alignItems: "center" }}>
                    {/* Attachments live here, on the row — deliberately the
                        single place they are managed. The piece editor has
                        no attachment control at all. */}
                    <button onClick={e => { e.stopPropagation(); setAttachmentsFor(item); }}
                      onMouseEnter={e => openHover(e, item.id)}
                      onMouseLeave={closeHoverSoon}
                      title={attachCount ? `${attachCount} attachment${attachCount === 1 ? "" : "s"}` : "Attachments"}
                      style={{ border: "none", background: "none", color: attachCount ? colors.text : colors.textMuted, cursor: "pointer", padding: 5, display: "inline-flex", alignItems: "center", gap: 3 }}>
                      <Paperclip size={14} />
                      {attachCount > 0 && <span style={{ fontSize: 11, fontWeight: 700 }}>{attachCount}</span>}
                    </button>
                    <button onClick={e => { e.stopPropagation(); editPiece(item); }} title="Edit piece"
                      style={{ border: "none", background: "none", color: colors.textMuted, cursor: "pointer", padding: 5, display: "inline-flex", alignItems: "center" }}><Pencil size={14} /></button>
                    <button onClick={e => { e.stopPropagation(); setConfirmDeleteRow(item); }} title="Delete piece"
                      style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer", padding: 5, display: "inline-flex", alignItems: "center" }}><Trash2 size={14} /></button>
                  </div>
                </div>
              </Card>
            );
          })}

          <button onClick={newPiece}
            style={{ alignSelf: "flex-start", marginTop: 4, padding: "8px 16px", background: "none", color: colors.textLight, border: `1px dashed ${colors.border}`, borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Plus size={14} /> Add piece
          </button>
        </div>
      )}

      {confirmDeleteRow && confirmDialog({
        heading: "Delete this piece?",
        body: <>This permanently deletes <strong>{confirmDeleteRow.title || "this piece"}</strong> from the concert. It cannot be recovered.</>,
        confirmLabel: "Delete piece",
        onConfirm: () => removePiece(confirmDeleteRow.id),
        onCancel: () => setConfirmDeleteRow(null),
      })}

      {confirmClear && confirmDialog({
        heading: "Clear every piece for this school?",
        body: <>This permanently deletes all <strong>{items.length}</strong> {items.length === 1 ? "piece" : "pieces"} for this school's concert. They cannot be recovered. The concert title is kept. Export the program first if you want a copy of this year's running order.</>,
        confirmLabel: "Delete all pieces",
        onConfirm: doClearAll,
        onCancel: () => setConfirmClear(false),
        // §4.5: offer the export before deleting. Deliberately NOT the default
        // — it opens the export dialog and leaves the pieces alone, so coming
        // back to delete is a fresh, deliberate confirmation. Declining it and
        // deleting straight away is still permitted.
        extraAction: {
          label: "Export program first",
          icon: <FileDown size={13} />,
          onClick: () => { setConfirmClear(false); openExport(); },
        },
      })}

      {/* ── Export dialog — reports the page count BEFORE saving (§4.7) ── */}
      {exportOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => { if (!exportBusy) setExportOpen(false); }}>
          <div style={{ background: colors.cardBg, borderRadius: 14, padding: 28, maxWidth: 460, width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, marginBottom: 10, display: "inline-flex", alignItems: "center", gap: 8 }}>
              <FileDown size={15} /> Export the program
            </div>
            <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.65, marginBottom: 18 }}>
              A4 portrait, {items.length} {items.length === 1 ? "piece" : "pieces"}, saved to Documents as
              {" "}<strong>{programFilename}.pdf</strong>.
            </div>

            <div style={{ background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 10, padding: "14px 16px", marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: colors.text }}>
                    {exportPages} page{exportPages === 1 ? "" : "s"}
                  </div>
                  <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
                    Text size {Math.round(exportScale * 100)}%
                    {exportScale <= MIN_PROGRAM_SCALE + 1e-9 && " — smallest readable"}
                    {exportScale >= MAX_PROGRAM_SCALE - 1e-9 && " — largest"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button onClick={() => nudgeScale(-PROGRAM_SCALE_STEP)}
                    disabled={exportScale <= MIN_PROGRAM_SCALE + 1e-9}
                    title="Smaller"
                    style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.cardBg, color: colors.text, cursor: exportScale <= MIN_PROGRAM_SCALE + 1e-9 ? "not-allowed" : "pointer", opacity: exportScale <= MIN_PROGRAM_SCALE + 1e-9 ? 0.4 : 1, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <Minus size={14} />
                  </button>
                  <button onClick={() => nudgeScale(PROGRAM_SCALE_STEP)}
                    disabled={exportScale >= MAX_PROGRAM_SCALE - 1e-9}
                    title="Larger"
                    style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.cardBg, color: colors.text, cursor: exportScale >= MAX_PROGRAM_SCALE - 1e-9 ? "not-allowed" : "pointer", opacity: exportScale >= MAX_PROGRAM_SCALE - 1e-9 ? 0.4 : 1, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <Plus size={14} />
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 10, lineHeight: 1.5 }}>
                The page count is an estimate from the text, so a program right on a
                boundary can land a line either way. It won't shrink below the smallest
                readable size — past that it runs onto another page instead.
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setExportOpen(false)} disabled={exportBusy}>Cancel</Btn>
              <button onClick={runExport} disabled={exportBusy}
                style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: colors.accent, color: colors.cardBg, fontSize: 13, fontWeight: 700, cursor: exportBusy ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: exportBusy ? 0.6 : 1 }}>
                {exportBusy ? "Exporting…" : "Save to Documents"}
              </button>
            </div>
          </div>
        </div>
      )}

      {attachmentsFor && (
        <ConcertAttachmentsPanel
          item={attachmentsFor}
          attachments={attachmentsByItem.get(attachmentsFor.id) || []}
          teachersById={teachersById}
          notify={notify}
          onOpenLink={setBrowserLink}
          onChange={(itemId, next) => setAttachmentsByItem(prev => {
            const updated = new Map(prev);
            updated.set(itemId, next);
            return updated;
          })}
          onClose={() => setAttachmentsFor(null)}
        />
      )}

      {/* ── Paperclip hover list ──
          Portalled to document.body so a Card's overflow can never clip it,
          right-aligned under the paperclip and clamped inside the viewport —
          the same placement rule the Resource Library's PortalPopover uses.
          Additive: clicking the paperclip still opens the full panel. */}
      {hoverAtts && (() => {
        const list = attachmentsByItem.get(hoverAtts.itemId) || [];
        if (list.length === 0) return null;
        const W = 268, margin = 8;
        const left = Math.max(margin, Math.min(hoverAtts.rect.right - W, window.innerWidth - W - margin));
        const top  = Math.min(hoverAtts.rect.bottom + 6, window.innerHeight - margin);
        // A long list would otherwise run off the bottom edge; cap it and scroll.
        const maxHeight = Math.max(96, window.innerHeight - top - margin);
        return createPortal(
          <div
            onMouseEnter={cancelHoverClose}
            onMouseLeave={closeHoverSoon}
            style={{ position: "fixed", zIndex: 9995, top, left, width: W, maxHeight, overflowY: "auto",
              background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 10,
              boxShadow: "0 8px 24px rgba(0,0,0,0.16)", padding: 5 }}>
            {list.map(att => {
              const AttIcon = att.isReference ? Library : iconForFileName({ fileName: att.fileName, url: att.url });
              return (
                <button key={att.id}
                  onClick={e => { e.stopPropagation(); openAttachmentFromHover(att); }}
                  title={attachmentLabel(att)}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                    background: "none", border: "none", borderRadius: 6, cursor: "pointer",
                    fontFamily: "inherit", fontSize: 12.5, color: colors.text, textAlign: "left" }}
                  onMouseEnter={e => { e.currentTarget.style.background = colors.bg; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "none"; }}>
                  <span style={{ flexShrink: 0, display: "flex", color: colors.textMuted }}>
                    <AttIcon size={14} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {attachmentLabel(att)}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body
        );
      })()}

      {browserLink && (
        <LinkBrowser initialUrl={browserLink.url} title={browserLink.title}
          onClose={() => setBrowserLink(null)} />
      )}
    </div>
  );
}
