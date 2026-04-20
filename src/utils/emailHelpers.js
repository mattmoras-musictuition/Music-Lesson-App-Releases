// ============================================================
// EMAIL HELPERS
// HTML/text parsing and processing utilities for email display.
// No imports from the app — these are pure DOM/string helpers.
// ============================================================

export function decodeEntities(str) {
  if (!str || !str.includes("&")) return str;
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

// Known generic display names set by mail clients / providers — not real sender names
const GENERIC_SENDER_NAMES = new Set([
  "yahoo", "gmail", "hotmail", "outlook", "icloud", "aol", "live",
  "googlemail", "google", "apple", "microsoft", "noreply", "no-reply",
  "no reply", "notifications", "mailer-daemon",
]);

// Resolve a raw From/To header string to a display name, checking app contacts first
export function resolveDisplayName(raw, contacts, students) {
  if (!raw) return "Unknown";
  const addrMatch = raw.match(/<(.+?)>/);
  const addr = addrMatch ? addrMatch[1].toLowerCase() : raw.toLowerCase();
  // Check school contacts
  if (contacts && contacts.length) {
    const match = contacts.find(c => c.email && c.email.toLowerCase() === addr);
    if (match && match.name) return match.name;
  }
  // Check student parents
  if (students && students.length) {
    for (const s of students) {
      for (const p of (s.parents || [])) {
        if (p.email && p.email.toLowerCase() === addr && p.name) return p.name;
      }
    }
  }
  // If there's a display name in the header, use it — unless it's a generic provider name
  if (addrMatch) {
    const name = raw.split("<")[0].trim().replace(/^"|"$/g, "");
    if (name && !GENERIC_SENDER_NAMES.has(name.toLowerCase())) return name;
    // Generic name — fall back to the local part of the email address, capitalised
    const localPart = addr.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    return localPart || addr;
  }
  return raw;
}

// ── Email body processing ─────────────────────────────────────────────────────

// DOMParser-based HTML stripping — handles nesting correctly, covers Gmail + Outlook
export function getCleanHtml(html, { showHistory = false, showSig = false, suppressPatterns = [] } = {}) {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Always remove scripts and styles — content renders in parent document
    doc.querySelectorAll("script, style, link, meta").forEach(el => el.remove());
    // Remove tracking pixels / all images
    doc.querySelectorAll("img").forEach(el => el.remove());
    if (!showHistory) {
      doc.querySelectorAll(".gmail_quote, .gmail_attr").forEach(el => el.remove());
      doc.querySelectorAll("#divRplyFwdMsg, #OLK_SRC_BODY_SECTION").forEach(el => el.remove());
      doc.querySelectorAll("blockquote").forEach(el => el.remove());
      _stripWriteLine(doc.body);
      _stripHrLine(doc.body);
      // Strip "Get Outlook for iOS/Android" and everything after
      _stripTextMarker(doc.body, /Get Outlook for/i);
    }
    if (!showSig) {
      doc.querySelectorAll(".gmail_signature").forEach(el => el.remove());
      doc.querySelectorAll("[id='Signature'], [id='signature']").forEach(el => el.remove());
      doc.querySelectorAll("[class]").forEach(el => {
        if (el.className && el.className.toLowerCase && el.className.toLowerCase().includes("signature")) el.remove();
      });
    }
    if (suppressPatterns.length > 0) {
      const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      const toRemove = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (suppressPatterns.some(p => p && node.textContent.includes(p))) {
          let target = node;
          while (target.parentNode && target.parentNode !== doc.body && !["DIV","P","TABLE","BLOCKQUOTE","SECTION"].includes(target.parentNode.nodeName)) {
            target = target.parentNode;
          }
          toRemove.push(target);
        }
      }
      toRemove.forEach(el => el.parentNode?.removeChild(el));
    }
    return doc.body.innerHTML;
  } catch {
    return html;
  }
}

// Returns true if an HTML string is essentially plain text with no block structure
export function isPlainTextHtml(html) {
  if (!html) return false;
  const stripped = html.replace(/<[^>]+>/g, "");
  const hasBlocks = /<(p|div|br|li|td|h[1-6])\b/i.test(html);
  return !hasBlocks && stripped.length > 0;
}

// Walk all text nodes; if one contains "On [date]...wrote:", remove it and everything after it
export function _stripWriteLine(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let found = null;
  while (walker.nextNode()) {
    if (/On\s+(\w+,?\s+\d+\s+\w+\s+\d{4}|\w+,\s+\w+\s+\d+,?\s+\d{4}).{0,120}wrote:/i.test(walker.currentNode.textContent)) {
      found = walker.currentNode;
      break;
    }
  }
  if (!found) return;
  let node = found;
  while (node && node !== root) {
    let sib = node.nextSibling;
    while (sib) { const next = sib.nextSibling; sib.remove(); sib = next; }
    const parent = node.parentNode;
    parent?.removeChild(node);
    node = parent;
  }
}

// Remove "---Original Message---" / "---Forwarded Message---" separators and everything after.
// Also catches Outlook's inline "-----Original Message-----" embedded in paragraphs.
export function _stripHrLine(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let found = null;
  while (walker.nextNode()) {
    if (/[-_]{3,}\s*(Original Message|Forwarded Message)\s*[-_]{3,}/i.test(walker.currentNode.textContent)) {
      found = walker.currentNode;
      break;
    }
  }
  if (!found) return;
  let node = found;
  while (node && node !== root) {
    let sib = node.nextSibling;
    while (sib) { const next = sib.nextSibling; sib.remove(); sib = next; }
    const parent = node.parentNode;
    parent?.removeChild(node);
    node = parent;
    if (node && ["P","DIV","TABLE","SECTION","ARTICLE"].includes(node?.nodeName)) break;
  }
  if (node && node !== root) {
    let sib = node.nextSibling;
    while (sib) { const next = sib.nextSibling; sib.remove(); sib = next; }
    node.remove();
  }
}

// Generic text marker stripper — finds a regex match in element textContent and removes it + everything after
export function _stripTextMarker(root, pattern) {
  // Walk block-level and inline elements; check their full textContent
  const els = root.querySelectorAll("*");
  let found = null;
  for (const el of els) {
    if (el.children.length === 0 || el.nodeName === "A" || el.nodeName === "SPAN" || el.nodeName === "P" || el.nodeName === "DIV") {
      if (pattern.test(el.textContent)) {
        // Walk up to the nearest block-level ancestor to cut at the block boundary
        found = el;
        while (found.parentNode && found.parentNode !== root && !["P","DIV","TABLE","SECTION","ARTICLE","TD","TR","LI","BLOCKQUOTE"].includes(found.parentNode.nodeName)) {
          found = found.parentNode;
        }
        break;
      }
    }
  }
  if (!found) {
    // Fallback: check raw textContent for inline matches (single text node or combined)
    if (pattern.test(root.textContent)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentNode;
        if (parent && pattern.test(parent.textContent)) {
          found = parent;
          while (found.parentNode && found.parentNode !== root && !["P","DIV","TABLE","SECTION","ARTICLE"].includes(found.parentNode.nodeName)) {
            found = found.parentNode;
          }
          break;
        }
      }
    }
  }
  if (!found) return;
  // Remove found element and all subsequent siblings up the tree
  let node = found;
  while (node && node !== root) {
    let sib = node.nextSibling;
    while (sib) { const next = sib.nextSibling; sib.remove(); sib = next; }
    const parent = node.parentNode;
    parent?.removeChild(node);
    node = parent;
    if (node && ["P","DIV","TABLE","SECTION","ARTICLE"].includes(node?.nodeName)) break;
  }
  if (node && node !== root) {
    let sib = node.nextSibling;
    while (sib) { const next = sib.nextSibling; sib.remove(); sib = next; }
    node.remove();
  }
}

export function getPlainParts(raw) {
  const text = (raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // RFC standard: `-- \n` (note the space — most mail clients write this)
  const rfcIdx = text.search(/\n-- ?\n/);
  if (rfcIdx > 0) return { main: text.slice(0, rfcIdx).trimEnd(), sig: text.slice(rfcIdx + 1), hist: "" };
  // History split — line-start patterns first
  let histIdx = text.search(/(-{3,}\s*Original Message\s*-{3,}|(?:\n|>\s*)On\s+(\d+\s+\w+\s+\d{4}|\w+,\s+\w+\s+\d+,?\s+\d{4}).+wrote:|(?:\n)From:[\s\S]{0,80}Sent:|_{5,}|Get Outlook for)/m);
  // Inline fallback — catches mid-line "On Thursday, April 16, 2026...wrote:" patterns
  if (histIdx < 0) {
    const inlinePatterns = [
      / On (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+\w+\s+\d/,
      / On [A-Z][a-z]{2,8} \d{1,2},?\s+\d{4}/,
      / On \d{1,2}\/\d{1,2}\/\d{2,4}/,
    ];
    for (const pat of inlinePatterns) {
      const idx = text.search(pat);
      if (idx > 20 && /wrote:/i.test(text.slice(idx, idx + 200))) { histIdx = idx; break; }
    }
  }
  const mainAndSig = histIdx > 0 ? text.slice(0, histIdx).trimEnd() : text;
  const hist = histIdx > 0 ? text.slice(histIdx) : "";
  // Signature heuristic — scan backward up to 12 lines from end
  const lines = mainAndSig.split("\n");
  let sigStart = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    const l = lines[i].trim();
    if (l.length > 100) break;
    if (l === "" && i < lines.length - 6) break;
    if (/tel:|ph[:\s]\s*\d|www\.|\.edu\.au|\.gov\.au|important|confidential|disclaimer|business manager|principal|coordinator|deputy|\d{8,}|@[\w.]+\.\w{2,}/i.test(l)) {
      sigStart = i;
    }
  }
  if (sigStart > 0) return { main: lines.slice(0, sigStart).join("\n").trimEnd(), sig: lines.slice(sigStart).join("\n"), hist };
  return { main: mainAndSig, sig: "", hist };
}

// Runs once per email on fetch — stores detection flags directly on the object
export function preprocessEmail(email) {
  // Always re-run detection (don't cache — detection logic improves over time)
  let hasHistory = false;
  let hasSig = false;
  let plainParts = null;

  if (email.bodyHtml) {
    try {
      const doc = new DOMParser().parseFromString(email.bodyHtml, "text/html");
      // History: Gmail classes, Outlook, Apple Mail blockquote, plain blockquote, "wrote:" line
      hasHistory = !!(
        doc.querySelector('.gmail_quote, .gmail_attr, #divRplyFwdMsg, #OLK_SRC_BODY_SECTION') ||
        doc.querySelector('blockquote') ||
        /On\s+(\w+,?\s+\d+\s+\w+\s+\d{4}|\w+,\s+\w+\s+\d+,?\s+\d{4}).{0,120}wrote:/i.test(doc.body.textContent) ||
        /[-]{3,}\s*(Original Message|Forwarded Message)\s*[-]{3,}/i.test(doc.body.textContent) ||
        /Get Outlook for/i.test(doc.body.textContent)
      );
      // Signature: case-insensitive class/id matching
      hasSig = !!(
        doc.querySelector('.gmail_signature') ||
        doc.querySelector('[id="Signature"], [id="signature"]') ||
        doc.querySelector('[class*="signature" i]') ||
        doc.querySelector('[class*="Signature"]')
      );
    } catch {}
  } else {
    const raw = email.body || email.snippet || "";
    hasHistory = /(-{3,}\s*Original Message\s*-{3,}|^On .+ wrote:|^From:.*\r?\nSent:|^_{3,}$|Get Outlook for| On (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday).{0,120}wrote:| On [A-Z][a-z]{2,8} \d{1,2},?\s+\d{4}.{0,120}wrote:)/m.test(raw);
    plainParts = getPlainParts(raw);
    hasSig = !!(plainParts?.sig);
  }

  return { ...email, _preprocessed: true, _hasHistory: hasHistory, _hasSig: hasSig, _plainParts: plainParts };
}

// Reformats flat unstructured text (wall-of-text emails) into readable paragraphs.
// Adds paragraph breaks at sentence boundaries and respects existing newlines.
export function formatWallOfText(text) {
  if (!text) return "";
  // Normalise line endings
  let t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // If there are already decent line breaks (multiple \n sequences), trust them
  if ((t.match(/\n\n/g) || []).length >= 2) return t;
  // Insert double-newline at sentence endings followed by a capital letter or number
  // Avoids breaking on common abbreviations: Mr. Mrs. Dr. St. etc.
  t = t.replace(/([.!?])(\s{1,3})([A-Z"'])/g, (_, punc, sp, next) => `${punc}\n\n${next}`);
  // Also break at "Thanks," / "Regards," style sign-offs
  t = t.replace(/(Thanks[^,\n]{0,10},|Regards[^,\n]{0,10},|Cheers[^,\n]{0,10},|Kind regards[^,\n]{0,15},)/g, '\n\n$1');
  return t.trim();
}
