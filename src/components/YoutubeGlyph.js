// ============================================================
// YoutubeGlyph.js — Resource Library cluster 9
//
// Embedded YouTube logo, a drop-in replacement for a lucide icon
// component. lucide-react 1.0.1 (this repo's version) dropped the
// brand/logo icons, so the Video resource type can't import
// `Youtube` from lucide the way the teacher app (lucide 0.383.0)
// does. This renders the lucide 0.383.0 youtube glyph verbatim so
// the two apps look identical.
//
// Like a lucide icon: takes a `size` prop (default 24) applied to
// width + height, strokes in currentColor (inherits the parent's
// colour), and spreads remaining props onto the <svg> so style,
// className and aria attributes pass through.
// ============================================================

import React from "react";

export function YoutubeGlyph({ size = 24, ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17" />
      <path d="m10 15 5-3-5-3z" />
    </svg>
  );
}

export default YoutubeGlyph;
