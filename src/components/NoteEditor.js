// ============================================================
// NoteEditor.js  —  Student Notes (cluster 4)
//
// The current viewer's editable note for one subject+week. Always
// rendered (one instance per week card): empty with a placeholder
// when no note exists yet, pre-populated when it does. Other authors'
// notes are NEVER editor instances — they render statically via
// renderNoteBody (see SubjectNotesPage).
//
// TipTap, built from individual extensions (NOT StarterKit). Mark set
// is deliberately minimal: bold / italic / underline only, paragraphs
// only. Formatting is hotkeys-only (Cmd/Ctrl+B/I/U, wired natively by
// the mark extensions) — there is no toolbar, bubble, or floating menu.
//
// Autosave: ~1s debounce after the last keystroke. A non-empty body
// upserts; emptying a body calls onSave(null) and the parent decides
// whether a row exists to delete. Save failures retry once after 3s.
// ============================================================

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Underline from "@tiptap/extension-underline";
import History from "@tiptap/extension-history";
import Placeholder from "@tiptap/extension-placeholder";
import { useTheme } from "../context/ThemeContext";

const SAVE_DEBOUNCE_MS = 1000;
const RETRY_DELAY_MS = 3000;

function fmtSavedTime(d) {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function NoteEditor({
  initialBody,
  placeholder,
  onSave,
  onDelete,        // present only for the author's own saved note
  onActivity,      // called on each keystroke (parent's realtime guard)
  savedAt,         // Date | ISO string | null — last server save time
  authorColor,     // non-primary author → 4px left accent border
  isEmpty,         // initial emptiness (before the editor reports its own)
}) {
  const { colors, darkMode } = useTheme();

  const [status, setStatus] = useState("idle");     // idle | saving | saved | failed
  const [savedTime, setSavedTime] = useState(savedAt || null);
  const [empty, setEmpty] = useState(isEmpty !== false);

  const debounceRef = useRef(null);
  const retryRef = useRef(null);
  const triedRetryRef = useRef(false);

  // The editor captures onUpdate once at mount, so reach the latest
  // parent callbacks through refs rather than the stale closure.
  const onSaveRef = useRef(onSave);
  const onActivityRef = useRef(onActivity);
  useEffect(() => { onSaveRef.current = onSave; });
  useEffect(() => { onActivityRef.current = onActivity; });

  const editor = useEditor({
    extensions: [
      Document, Paragraph, Text,
      Bold, Italic, Underline,
      History,
      Placeholder.configure({ placeholder: placeholder || "" }),
    ],
    content: initialBody || "",
    onUpdate: ({ editor }) => {
      setEmpty(editor.isEmpty);
      if (onActivityRef.current) onActivityRef.current();
      // Any fresh edit cancels a pending retry; the new debounced save
      // supersedes it and resets the one-retry budget.
      if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; }
      triedRetryRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const text = editor.getText().trim();
        doSave(text.length === 0 ? null : editor.getJSON());
      }, SAVE_DEBOUNCE_MS);
    },
  });

  const doSave = useCallback(async (payload, isRetry = false) => {
    setStatus("saving");
    try {
      await onSaveRef.current(payload);
      setStatus("saved");
      setSavedTime(payload == null ? null : new Date());
      triedRetryRef.current = false;
    } catch (e) {
      console.error("NoteEditor save failed:", e);
      setStatus("failed");
      if (!isRetry && !triedRetryRef.current) {
        triedRetryRef.current = true;
        retryRef.current = setTimeout(() => { doSave(payload, true); }, RETRY_DELAY_MS);
      }
    }
  }, []);

  // Live-sync the editor when the underlying note changes externally
  // (e.g. the same author edits in another tab) — but never while the
  // user is typing here, so the cursor can't jump mid-keystroke.
  useEffect(() => {
    if (!editor) return;
    if (editor.isFocused) return;
    const incoming = initialBody || null;
    const current = editor.isEmpty ? null : editor.getJSON();
    if (JSON.stringify(incoming) !== JSON.stringify(current)) {
      editor.commands.setContent(incoming || "", { emitUpdate: false });
      setEmpty(editor.isEmpty);
    }
  }, [editor, initialBody]);

  // Reflect the parent's server-confirmed save time when it changes.
  useEffect(() => { setSavedTime(savedAt || null); }, [savedAt]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (retryRef.current) clearTimeout(retryRef.current);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!onDelete) return;
    if (!window.confirm("Delete this note?")) return;
    try {
      await onDelete();
      editor?.commands.clearContent();
      setEmpty(true);
      setSavedTime(null);
      setStatus("idle");
    } catch (e) {
      console.error("NoteEditor delete failed:", e);
    }
  }, [onDelete, editor]);

  const muted = colors.textMuted || "#9AA0A6";
  const showIndicator = status === "failed" || savedTime != null || !empty;

  return (
    <div
      className="sn-note-editor"
      style={{
        marginTop: 8,
        borderLeft: authorColor ? `4px solid ${authorColor}` : `1px solid ${colors.border}`,
        borderRadius: 8,
        background: darkMode ? "rgba(255,255,255,0.02)" : "#FFFFFF",
        padding: "8px 12px 6px",
      }}
    >
      <EditorContent editor={editor} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, marginTop: 4, minHeight: 16 }}>
        {showIndicator && (
          <span style={{ fontSize: 11, color: status === "failed" ? (colors.danger || "#EF4444") : muted }}>
            {status === "failed"
              ? "Save failed — retrying"
              : status === "saving"
                ? "Saving…"
                : savedTime != null
                  ? `Saved ${fmtSavedTime(savedTime)}`
                  : ""}
          </span>
        )}
        {onDelete && (
          <button
            onClick={handleDelete}
            title="Delete this note"
            style={{
              background: "none", border: "none", padding: 2, cursor: "pointer",
              color: muted, fontSize: 14, lineHeight: 1, display: "flex",
            }}
          >
            ×
          </button>
        )}
      </div>

      <style>{`
        .sn-note-editor .ProseMirror {
          outline: none;
          font-size: 13px;
          line-height: 1.5;
          color: ${colors.text};
          min-height: 22px;
        }
        .sn-note-editor .ProseMirror p { margin: 0 0 6px; }
        .sn-note-editor .ProseMirror p:last-child { margin-bottom: 0; }
        .sn-note-editor .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          height: 0;
          pointer-events: none;
          color: ${muted};
          font-style: italic;
        }
      `}</style>
    </div>
  );
}
