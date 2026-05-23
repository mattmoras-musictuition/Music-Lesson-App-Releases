// ============================================================
// resourceTypeIcons.js — Resource Library cluster 9 (admin app)
//
// Single source of truth for the resource-type → icon mapping on
// the admin Resources tab, plus the file-format fallback used when
// a resource has no type or an unmapped one. Parallel copy of the
// teacher app's helper (separate repos can't share a module).
//
// "Video" uses the embedded YoutubeGlyph component because this
// repo's lucide-react (1.0.1) no longer ships the brand icons; the
// other eight types come from lucide-react. Both helpers return a
// component (or null) — the caller renders it with its own size.
// ============================================================

import {
  BookOpen, FileMusic, AudioLines, ClipboardList, GraduationCap,
  ListMusic, BookMarked, Shapes,
  Image as ImageIcon, FileText, Music, Film, Link2, File as FileIcon,
} from "lucide-react";
import { YoutubeGlyph } from "../components/YoutubeGlyph";

// Confirmed type-string → icon map (cluster 9).
export const RESOURCE_TYPE_ICONS = {
  "Method Book":   BookOpen,
  "Sheet Music":   FileMusic,
  "Backing Track": AudioLines,
  "Worksheet":     ClipboardList,
  "Theory":        GraduationCap,
  "Repertoire":    ListMusic,
  "Reference":     BookMarked,
  "Other":         Shapes,
  "Video":         YoutubeGlyph,
};

// Normalised lookup (trimmed + lower-cased keys) so minor
// capitalisation/whitespace differences still match.
const NORMALISED = new Map(
  Object.entries(RESOURCE_TYPE_ICONS).map(([k, v]) => [k.trim().toLowerCase(), v])
);

// File-format fallback sets, keyed by lower-case extension.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "heif"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm", "m4v"]);

/**
 * Map a resource type string to its icon component. Returns null
 * for empty or unrecognised types (caller falls through to
 * iconForFileName).
 *
 * @param {string} category
 * @returns {React.ComponentType|null}
 */
export function iconForResourceType(category) {
  if (!category || typeof category !== "string") return null;
  return NORMALISED.get(category.trim().toLowerCase()) || null;
}

function extensionOf(fileName) {
  const name = (fileName || "").trim();
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * File-format fallback icon. Parses the extension from fileName;
 * Link2 when there's no file but a url; File otherwise.
 *
 * @param {{ fileName?: string, url?: string }} arg
 * @returns {React.ComponentType}
 */
export function iconForFileName({ fileName, url } = {}) {
  const ext = extensionOf(fileName);
  if (ext === "pdf") return FileText;
  if (IMAGE_EXTS.has(ext)) return ImageIcon;
  if (AUDIO_EXTS.has(ext)) return Music;
  if (VIDEO_EXTS.has(ext)) return Film;
  if (!fileName && url) return Link2;
  return FileIcon;
}
