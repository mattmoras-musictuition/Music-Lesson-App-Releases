// ============================================================
// noteBody.js  —  Student Notes (cluster 4)
//
// Static render + text helpers for the TipTap JSON document stored in
// student_notes.body. Cluster 4 keeps the editor's mark set minimal
// (bold / italic / underline only, paragraphs only — no lists, links,
// or headings), so this walker only needs to understand that subset.
//
// renderNoteBody returns React elements (not an HTML string) so the
// read-only path never touches dangerouslySetInnerHTML — unknown node
// or mark types degrade to plain text rather than injecting markup.
// ============================================================

import React from "react";

// Concatenated text content of the document — used for the
// "(empty note)" fallback and for cheap empty-detection.
export function noteBodyText(body) {
  if (!body || typeof body !== "object") {
    return typeof body === "string" ? body : "";
  }
  let out = "";
  const walk = (node) => {
    if (!node) return;
    if (typeof node.text === "string") out += node.text;
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(body);
  return out;
}

export function noteBodyIsEmpty(body) {
  return noteBodyText(body).trim().length === 0;
}

// Wrap a text string in its marks (bold / italic / underline), inner
// to outer. Anything outside the whitelist is ignored.
function applyMarks(text, marks, keyBase) {
  let node = text;
  for (const mark of (marks || [])) {
    if (mark.type === "bold") node = <strong key={`${keyBase}-b`}>{node}</strong>;
    else if (mark.type === "italic") node = <em key={`${keyBase}-i`}>{node}</em>;
    else if (mark.type === "underline") node = <u key={`${keyBase}-u`}>{node}</u>;
  }
  return node;
}

function renderInline(content, keyBase) {
  if (!Array.isArray(content)) return null;
  return content.map((node, i) => {
    if (node?.type !== "text" || typeof node.text !== "string") return null;
    return (
      <React.Fragment key={`${keyBase}-${i}`}>
        {applyMarks(node.text, node.marks, `${keyBase}-${i}`)}
      </React.Fragment>
    );
  });
}

// Returns an array of <p> elements, or null when the document has no
// text content (lets the caller render its own empty state).
export function renderNoteBody(body) {
  if (noteBodyIsEmpty(body)) return null;
  const paragraphs = Array.isArray(body?.content) ? body.content : [];
  return paragraphs.map((para, i) => {
    if (para?.type !== "paragraph") return null;
    return (
      <p key={`p-${i}`} style={{ margin: "0 0 6px" }}>
        {renderInline(para.content, `p-${i}`)}
      </p>
    );
  });
}
