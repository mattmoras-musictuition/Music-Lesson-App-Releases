// ============================================================
// COMPOSE MODAL
// Floating, draggable/resizable email compose window with
// Gmail send, attachments, templates, and batch mode.
// ============================================================

import React from "react";
import { Paperclip, File, Library, FileText, Link, X } from "lucide-react";
import { TRIGGER_MAP } from "../constants";
import { useTheme } from "../context/ThemeContext";
// Session 95: helpers for school-tagged templates — used to pre-select the
// right default template based on the `from` sender email.
import { getUserTemplates, applyMergeCtx, schoolAcronym, schoolIdForSenderEmail, pickDefaultTemplate } from "../utils/emailTemplates";
// Session 96: when a template has auto-attach document ids, we fetch the
// file bytes here (downloadAsBase64 for uploaded docs, fetch+encode for
// URL-based docs) and add them to the compose modal's attachments list so
// they get picked up by the normal send path.
import { BUCKET_DOCUMENTS, downloadAsBase64 } from "../utils/storageHelpers";
import { resolveSenderHeaders, getPrimaryAddress, buildLessonReferenceRows } from "../utils/emailHelpers";
import { getCurrentWeekMonday, toLocalDateStr } from "../utils/helpers";

export function ComposeModal({ initial, schools, students, teachers, contacts, resources = [], documents = [], timetable = null, weeklyTimetables = {}, onClose, onCancelAll, notify, queueRemaining = 0, onSoundPlay, onSent }) {
  // Session 89 — v6 (HTML DOM-based stripping of quoted replies from initial.body)
  React.useEffect(() => { console.log("[ComposeModal] session 89 v6 loaded"); }, []);
  const { colors, darkMode } = useTheme();
  // Multi-recipient privacy: if 2+ recipients and not a reply/forward, the
  // modal places them in BCC and the To field starts empty. Send goes out as
  // ONE email with the recipients in BCC. (A per-recipient fan-out lived here
  // v2.9.10–v2.17.x as a Yahoo-bounce workaround; the real cause was fixed in
  // v2.15.0 via DKIM/sender identity, so the fan-out was reverted.)
  const isReply = /^(re|fwd?)\s*:/i.test(initial.subject || "");
  const initBccGroup = !isReply && !initial.forceTo && (initial.to || []).length >= 2;
  // Marker preserved for the lifetime of this modal open so post-mount edits
  // (drag a chip between fields, add/remove a chip, etc.) don't lose the
  // signal that this was a multi-recipient parent-notification flow.
  const wasMultiRecipientGroupRef = React.useRef(initBccGroup);
  const [to, setTo] = React.useState(initBccGroup ? [] : (initial.to || []));
  const [toInput, setToInput] = React.useState("");
  const [toSuggestions, setToSuggestions] = React.useState([]);
  const [suggestionIdx, setSuggestionIdx] = React.useState(-1);
  const [ccSuggestions, setCcSuggestions] = React.useState([]);
  const [ccSuggestionIdx, setCcSuggestionIdx] = React.useState(-1);
  const [bccSuggestions, setBccSuggestions] = React.useState([]);
  const [bccSuggestionIdx, setBccSuggestionIdx] = React.useState(-1);
  const [from, setFrom] = React.useState(initial.from || "");
  // DKIM fix: the signed primary sending address (From host); the `from` state
  // above stays the school *selector* (alias or "") and becomes Reply-To.
  const [primaryAddress, setPrimaryAddress] = React.useState(getPrimaryAddress());
  const [cc, setCc] = React.useState(initial.cc || []);
  const [ccInput, setCcInput] = React.useState("");
  const [bcc, setBcc] = React.useState(initBccGroup ? (initial.to || []) : (initial.bcc || []));
  const [bccInput, setBccInput] = React.useState("");
  const [showCc, setShowCc] = React.useState(!!(initial.cc && initial.cc.length));
  const [showBcc, setShowBcc] = React.useState(initBccGroup || !!(initial.bcc && initial.bcc.length));
  // Chip drag — tracks which email chip is being dragged between To/CC/BCC fields
  const chipDragRef = React.useRef(null); // { email, fromField: 'to'|'cc'|'bcc' }
  const [chipDragOver, setChipDragOver] = React.useState(null); // current drop-target field name
  const [subject, setSubject] = React.useState(initial.subject || "");
  // Lesson reference: when a recipient (To) is a parent of a student, surface
  // that student's lesson this week vs their regular Master-Timetable slot,
  // shown bottom-left below 'Previous messages'. Resolves from the To field
  // only — group BCC blasts (empty To) deliberately show nothing. Display only.
  const lessonRows = React.useMemo(() => {
    const recipients = (to || []).map(a => (a.match(/<(.+)>/)?.[1] || a || "").trim().toLowerCase()).filter(Boolean);
    if (recipients.length === 0) return [];
    // Item 7 (v2.18.1): parent contact lives in TWO shapes — the parents[]
    // array (Students-tab UI) and top-level parentEmail (records written by
    // the in-app assistant tools). Matching only parents[] dropped any
    // sibling whose record carries the email solely in parentEmail, so a
    // multi-child parent could surface just one (and seemingly wrong) child.
    // Consult both, same as _primaryParent does for invoicing.
    const linked = (students || []).filter(s =>
      (s.parents || []).some(p => p.email && recipients.includes(p.email.toLowerCase()))
      || (s.parentEmail && recipients.includes(s.parentEmail.trim().toLowerCase()))
    );
    if (linked.length === 0) return [];
    const currentMonday = toLocalDateStr(getCurrentWeekMonday());
    return buildLessonReferenceRows(linked, { timetable, weeklyTimetables, currentMonday });
  }, [to, students, timetable, weeklyTimetables]);
  const [sending, setSending] = React.useState(false);
  const [attachments, setAttachments] = React.useState(initial.attachments || []);
  // An attachment offered (not auto-added) by the caller — e.g. the WTT
  // day-header export's day timetable PDF. Surfaces as a row in the Attach
  // menu; attaches only when the user picks it.
  const offeredAttachment = initial.offeredAttachment || null;
  const offeredAlreadyAttached = !!offeredAttachment && attachments.some(a => a.filename === offeredAttachment.filename);
  const [minimised, setMinimised] = React.useState(false);
  const bodyRef = React.useRef(null);
  const lastSelectionRef = React.useRef(null);
  const [gmailConnected, setGmailConnected] = React.useState(false);
  const toWrapRef = React.useRef(null);
  const ccWrapRef = React.useRef(null);
  const bccWrapRef = React.useRef(null);

  // Attach picker state
  const [showAttachMenu, setShowAttachMenu] = React.useState(false);
  const [attachPicker, setAttachPicker] = React.useState(null); // null | "resource" | "document"
  const [pickerSearch, setPickerSearch] = React.useState("");
  const attachMenuRef = React.useRef(null);

  // Thread history panel — read-only, not included in the email send
  const threadMessages = initial.threadMessages || [];
  // Reply context — present only when opened via a Reply action. threadId +
  // the replied-to message's RFC Message-ID let Gmail thread the send into
  // the original conversation (batch/queue/new-compose shapes never set it).
  const replyThreadId = initial.replyThreadId || null;
  const [showThread, setShowThread] = React.useState(false);
  const [expandedThreadMsgs, setExpandedThreadMsgs] = React.useState(new Set());

  // Close attach menu on outside click
  React.useEffect(() => {
    if (!showAttachMenu) return;
    const handler = (e) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target)) {
        setShowAttachMenu(false);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => document.removeEventListener("mousedown", handler);
  }, [showAttachMenu]);

  // Drag + resize state
  const [pos, setPos] = React.useState(() => ({ x: Math.max(0, (window.innerWidth - 640) / 2), y: Math.max(0, (window.innerHeight - 600) / 2) }));
  const [size, setSize] = React.useState({ w: 880, h: 600 });
  const interactRef = React.useRef(null);
  const modalRef = React.useRef(null);
  const MIN_W = 380, MIN_H = 320;

  const onHeaderMouseDown = (e) => {
    if (e.target.tagName === "BUTTON") return;
    interactRef.current = { type: "drag", startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    e.preventDefault();
  };

  const onEdgeMouseDown = (edge) => (e) => {
    e.preventDefault(); e.stopPropagation();
    interactRef.current = { type: "resize", edge, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, origW: size.w, origH: size.h };
  };

  React.useEffect(() => {
    const onMove = (e) => {
      const ia = interactRef.current;
      if (!ia) return;
      const dx = e.clientX - ia.startX, dy = e.clientY - ia.startY;
      if (ia.type === "drag") {
        setPos({ x: Math.max(0, ia.origX + dx), y: Math.max(0, ia.origY + dy) });
      } else {
        const { edge, origX, origY, origW, origH } = ia;
        let x = origX, y = origY, w = origW, h = origH;
        if (edge.includes("e")) w = Math.max(MIN_W, origW + dx);
        if (edge.includes("w")) { w = Math.max(MIN_W, origW - dx); x = origX + origW - w; }
        if (edge.includes("s")) h = Math.max(MIN_H, origH + dy);
        if (edge.includes("n")) { h = Math.max(MIN_H, origH - dy); y = origY + origH - h; }
        setSize({ w, h }); setPos({ x, y });
      }
    };
    const onUp = () => { interactRef.current = null; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, []);

  const [fileDragOver, setFileDragOver] = React.useState(false);
  const isInternalDrag = () => !!window._pendingAttachmentDrag;

  const handleFileDrop = async (e) => {
    e.preventDefault(); setFileDragOver(false);
    if (window._pendingAttachmentDrag) {
      const { att, messageId } = window._pendingAttachmentDrag;
      window._pendingAttachmentDrag = null;
      if (window.electronAPI?.gmailFetchAttachment) {
        notify("Fetching attachment…", "success", 2000);
        try {
          const r = await window.electronAPI.gmailFetchAttachment(messageId, att.attachmentId);
          if (r.ok) setAttachments(prev => [...prev, { filename: att.filename, contentBase64: r.base64, mimeType: att.mimeType || "application/octet-stream" }]);
          else notify("Could not load attachment: " + r.error, "danger");
        } catch(err) { notify("Attachment error: " + err.message, "danger"); }
      }
      return;
    }
    const files = Array.from(e.dataTransfer.files || []);
    for (const file of files) {
      try {
        const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("Read failed")); r.readAsDataURL(file); });
        setAttachments(prev => [...prev, { filename: file.name, contentBase64: base64, mimeType: file.type || "application/octet-stream" }]);
      } catch(err) { notify("Could not attach file: " + err.message, "danger"); }
    }
  };

  const emailPool = React.useMemo(() => {
    const pool = [];
    const seen = new Set();
    const add = (email, label, sub) => {
      if (!email || seen.has(email.toLowerCase())) return;
      seen.add(email.toLowerCase()); pool.push({ email, label, sub: sub || "" });
    };
    // Parents — searchable by any of their children's names
    const parentMap = new Map();
    (students || []).forEach(s => (s.parents || []).forEach(p => {
      if (!p.email) return;
      const key = p.email.toLowerCase();
      if (!parentMap.has(key)) parentMap.set(key, { email: p.email, name: p.name || "", studentNames: [] });
      parentMap.get(key).studentNames.push(s.name);
    }));
    parentMap.forEach(({ email, name, studentNames }) => {
      add(email, name || email, studentNames.join(", "));
    });
    // Teachers / staff — searchable by name and instrument. Session 97: also
    // surface `personalEmail` (added session 87) so the chip resolves to the
    // teacher's name when Matt types either address.
    (teachers || []).forEach(t => {
      const instruments = (t.instruments || []).map(i => i.name).filter(Boolean).join(", ");
      const sub = instruments || "Staff";
      if (t.email) add(t.email, t.name || t.email, sub);
      if (t.personalEmail) add(t.personalEmail, t.name || t.personalEmail, sub);
    });
    // School contacts — searchable by name and role
    (contacts || []).forEach(c => {
      if (!c.email) return;
      add(c.email, c.name || c.email, [c.role, c.className].filter(Boolean).join(" · ") || "");
    });
    // School sender addresses
    (schools || []).forEach(s => { if (s.senderEmail) add(s.senderEmail, s.name, "School"); });
    return pool;
  }, [students, teachers, contacts, schools]);

  // Resolve email address to display name (for chips — shows names instead of raw emails)
  const resolveChipLabel = React.useCallback((email) => {
    const entry = emailPool.find(e => e.email.toLowerCase() === email.toLowerCase());
    if (entry?.label) return entry.label;
    // Fall back to thread message from-headers — catches people not in the database
    for (const msg of threadMessages) {
      const m = (msg.from || "").match(/^"?([^"<]+)"?\s*<([^>]+)>/);
      if (m && m[2].trim().toLowerCase() === email.toLowerCase()) return m[1].trim();
    }
    return email;
  }, [emailPool, threadMessages]);

  const [allTemplates] = React.useState(() => getUserTemplates());
  const triggerId = initial.triggerId || null;
  const mergeCtx = initial.mergeCtx || null;
  const triggerTemplates = allTemplates.filter(t => t.triggerId === triggerId);
  // Session 95: resolve the school tag for the initial "from" email, then
  // pick the best default template for (trigger, school). Precedence inside
  // pickDefaultTemplate: school-specific default → generic default → any
  // school-tagged → first for trigger. Matches the user mental model: "what
  // pops up when I open compose should respect both the trigger and the
  // school I'm sending as".
  const initialFromSchoolId = schoolIdForSenderEmail(schools, initial.from || "");
  const [selectedTemplateId, setSelectedTemplateId] = React.useState(() => {
    const picked = pickDefaultTemplate(allTemplates, triggerId, initialFromSchoolId);
    return picked ? picked.id : null;
  });
  const selectedTemplate = allTemplates.find(t => t.id === selectedTemplateId) || null;
  // Session 95 BUG 4 fix: in batch mode, hold on to the raw (unresolved)
  // template so we can apply each recipient's ctx at send time rather than
  // pre-resolving once with recipient[0]'s ctx (which left the subject/body
  // state as an already-resolved string — every recipient then got
  // recipient[0]'s values because applyMergeCtx had no tokens left to match).
  // In single-send this doesn't matter; the stash just goes unused.
  const rawTemplateRef = React.useRef({ subject: null, body: null });

  const applyTemplate = React.useCallback((tmpl) => {
    if (!tmpl) return;
    const resolvedSubject = mergeCtx ? applyMergeCtx(tmpl.subject, mergeCtx) : tmpl.subject;
    const resolvedBody = mergeCtx ? applyMergeCtx(tmpl.body, mergeCtx) : tmpl.body;
    setSubject(resolvedSubject || "");
    if (bodyRef.current) bodyRef.current.innerHTML = (resolvedBody || "").replace(/\n/g, "<br>");
  }, [mergeCtx]);

  // Session 96: fetch template's auto-attach documents and add as
  // attachments. Runs on template selection / change. Dedupes by filename
  // so changing templates doesn't pile up duplicates. Docs without
  // storage_path fall back to URL-fetch; docs with storage_path pull bytes
  // from the private bucket via downloadAsBase64. Gracefully skips any that
  // fail so a broken doc doesn't block the email. Non-blocking — the modal
  // stays interactive while fetches run in the background.
  const fetchAndAttachTemplateDocs = React.useCallback(async (tmpl) => {
    if (!tmpl || !Array.isArray(tmpl.autoAttachDocIds) || tmpl.autoAttachDocIds.length === 0) return;
    // Tag auto-attached items so we can clear them cleanly when the user
    // picks a different template — avoids the "I changed my mind" pile-up.
    setAttachments(prev => prev.filter(a => !a._autoAttached));
    for (const docId of tmpl.autoAttachDocIds) {
      const doc = (documents || []).find(d => d.id === docId);
      if (!doc) continue;
      try {
        let base64 = null;
        let filename = doc.filename || `${doc.label || "document"}.pdf`;
        let mimeType = doc.mime_type || "application/pdf";
        if (doc.storage_path) {
          base64 = await downloadAsBase64(BUCKET_DOCUMENTS, doc.storage_path);
        } else if (doc.url) {
          // URL-based doc: fetch the bytes, encode as base64. Works for
          // any publicly-fetchable URL. For links we don't control (e.g.
          // Google Drive), fetch may fail CORS — we skip and notify.
          const resp = await fetch(doc.url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          mimeType = blob.type || mimeType;
          base64 = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result).split(",")[1]);
            r.onerror = () => rej(new Error("read failed"));
            r.readAsDataURL(blob);
          });
          // Try to derive a filename from the URL path if we don't have one.
          if (!doc.filename) {
            const path = new URL(doc.url).pathname;
            const tail = path.split("/").pop();
            if (tail && tail.includes(".")) filename = tail;
          }
        }
        if (!base64) continue;
        setAttachments(prev => {
          // Dedupe by filename to avoid duplicates on retry.
          if (prev.some(a => a.filename === filename)) return prev;
          return [...prev, { filename, contentBase64: base64, mimeType, _autoAttached: true }];
        });
      } catch (e) {
        console.warn("[ComposeModal] auto-attach failed for doc", docId, e?.message || e);
        notify?.(`Couldn't auto-attach "${doc.label || doc.filename || "document"}" — attach manually if needed`, "warning");
      }
    }
  }, [documents, notify]);

  React.useEffect(() => {
    if (window.electronAPI?.gmailGetStatus) {
      window.electronAPI.gmailGetStatus().then(s => {
        setGmailConnected(s.connected);
        if (s.primaryAddress) {
          setPrimaryAddress(s.primaryAddress);
          try { localStorage.setItem("mt-gmail-primary", s.primaryAddress); } catch {}
        }
      });
    }
  }, []);

  React.useEffect(() => {
    if (bodyRef.current) {
      if (selectedTemplate && mergeCtx) {
        // Session 95 BUG 4: stash raw template for batch-send path.
        // Preview still shows the first recipient's resolved values (good UX)
        // but at send time we'll use these raw strings + each recipient's ctx.
        if (initial.batchTo && initial.batchTo.length > 0) {
          rawTemplateRef.current = { subject: selectedTemplate.subject || "", body: selectedTemplate.body || "" };
        }
        bodyRef.current.innerHTML = (applyMergeCtx(selectedTemplate.body, mergeCtx) || "").replace(/\n/g, "<br>");
        setSubject(applyMergeCtx(selectedTemplate.subject, mergeCtx) || "");
      } else if (selectedTemplate) {
        bodyRef.current.innerHTML = (selectedTemplate.body || "").replace(/\n/g, "<br>");
        setSubject(selectedTemplate.subject || "");
      } else if (initial.body) {
        bodyRef.current.innerHTML = stripBodyQuotes(initial.body).replace(/\n/g, "<br>");
      }
    }
    // Session 96: auto-attach initial template's docs on mount. handleTemplateChange
    // below handles subsequent user template switches.
    if (selectedTemplate) fetchAndAttachTemplateDocs(selectedTemplate);
  }, []); // eslint-disable-line

  // Auto-focus: body if recipients pre-filled (reply), To field if empty (new compose)
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if ((initial.to || []).length > 0 || initial.batchTo) {
        bodyRef.current?.focus();
      } else {
        document.getElementById("compose-to-input")?.focus();
      }
    }, 100);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line

  // Auto-detect From address: given a list of recipient emails, find the shared school
  // (if all recipients are parents/contacts at the same school) and return its senderEmail.
  // Checks: student parentEmail, student parents[] array, and school contacts (which have schoolId).
  const detectFromForEmails = React.useCallback((emails) => {
    if (!emails.length || !schools?.length) return null;
    const lc = emails.map(e => e.toLowerCase().trim());
    const schoolIds = new Set(
      lc.flatMap(email => {
        const ids = [];
        // Student parent emails (flat field)
        (students || []).forEach(s => {
          if (s.parentEmail?.toLowerCase().trim() === email) ids.push(s.schoolId);
          if (s.email?.toLowerCase().trim() === email) ids.push(s.schoolId);
          // parents[] array (PRIMARY / SECONDARY contact structure)
          if (Array.isArray(s.parents)) {
            s.parents.forEach(p => {
              if (p.email?.toLowerCase().trim() === email) ids.push(s.schoolId);
              if (p.parentEmail?.toLowerCase().trim() === email) ids.push(s.schoolId);
            });
          }
        });
        // School contacts — have schoolId directly on the record
        (contacts || []).forEach(c => {
          if (c.email?.toLowerCase().trim() === email && c.schoolId) ids.push(c.schoolId);
        });
        return ids.filter(Boolean);
      })
    );
    if (schoolIds.size !== 1) return null;
    const school = schools.find(s => s.id === [...schoolIds][0]);
    return school?.senderEmail || null;
  }, [students, contacts, schools]);

  // When recipients change: if From is still on default, try to auto-select school address.
  // Runs on mount too so pre-filled replies get the right sender immediately.
  React.useEffect(() => {
    if (initial.from) return; // explicit from — never override
    const allRecipients = [...to, ...bcc];
    if (!allRecipients.length) return;
    const detected = detectFromForEmails(allRecipients);
    if (detected) setFrom(detected);
  }, [to, bcc]); // eslint-disable-line

  const fromOptions = ["", ...schools.map(s => s.senderEmail).filter(Boolean)];

  const addRecipient = (email) => {
    const e = email.trim();
    if (!e || !e.includes("@")) return;
    if (!to.includes(e)) setTo(prev => [...prev, e]);
    setToInput(""); setToSuggestions([]); setSuggestionIdx(-1);
  };
  const removeRecipient = (email) => setTo(prev => prev.filter(e => e !== email));

  const handleToInput = (val) => {
    setToInput(val); setSuggestionIdx(-1);
    if (val.length < 1) { setToSuggestions([]); return; }
    const q = val.toLowerCase();
    const results = emailPool.filter(p => !to.includes(p.email) && (p.email.toLowerCase().includes(q) || (p.label || "").toLowerCase().includes(q) || (p.sub || "").toLowerCase().includes(q))).slice(0, 6);
    setToSuggestions(results);
  };

  const handleCcInput = (val) => {
    setCcInput(val); setCcSuggestionIdx(-1);
    if (val.length < 1) { setCcSuggestions([]); return; }
    const q = val.toLowerCase();
    setCcSuggestions(emailPool.filter(p => !cc.includes(p.email) && (p.email.toLowerCase().includes(q) || (p.label || "").toLowerCase().includes(q) || (p.sub || "").toLowerCase().includes(q))).slice(0, 6));
  };

  const handleBccInput = (val) => {
    setBccInput(val); setBccSuggestionIdx(-1);
    if (val.length < 1) { setBccSuggestions([]); return; }
    const q = val.toLowerCase();
    setBccSuggestions(emailPool.filter(p => !bcc.includes(p.email) && (p.email.toLowerCase().includes(q) || (p.label || "").toLowerCase().includes(q) || (p.sub || "").toLowerCase().includes(q))).slice(0, 6));
  };

  // ── Chip drag helpers ────────────────────────────────────────
  const onChipDragStart = (e, email, fromField) => {
    e.stopPropagation();
    chipDragRef.current = { email, fromField };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-chip", email);
  };
  const onChipDragEnd = () => { chipDragRef.current = null; setChipDragOver(null); };
  const onFieldDragOver = (e, field) => {
    if (!chipDragRef.current || chipDragRef.current.fromField === field) return;
    e.preventDefault(); e.stopPropagation();
    setChipDragOver(field);
  };
  const onFieldDrop = (e, toField) => {
    e.preventDefault(); e.stopPropagation();
    setChipDragOver(null);
    const info = chipDragRef.current;
    if (!info || info.fromField === toField) return;
    const { email, fromField } = info;
    if (fromField === "to") setTo(prev => prev.filter(x => x !== email));
    if (fromField === "cc") setCc(prev => prev.filter(x => x !== email));
    if (fromField === "bcc") setBcc(prev => prev.filter(x => x !== email));
    if (toField === "to") setTo(prev => prev.includes(email) ? prev : [...prev, email]);
    if (toField === "cc") { setCc(prev => prev.includes(email) ? prev : [...prev, email]); setShowCc(true); }
    if (toField === "bcc") { setBcc(prev => prev.includes(email) ? prev : [...prev, email]); setShowBcc(true); }
    chipDragRef.current = null;
  };

  const restoreSelection = () => {
    if (!lastSelectionRef.current) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(lastSelectionRef.current);
  };

  const execFormat = (cmd, value) => { bodyRef.current.focus(); document.execCommand(cmd, false, value); };
  const insertLink = () => { const url = window.prompt("URL:"); if (url) execFormat("createLink", url); };

  // Insert a hyperlink into the body at current cursor position (or append)
  const insertBodyLink = (label, url) => {
    if (!url) { notify("This item has no link saved", "warning"); return; }
    if (bodyRef.current) {
      bodyRef.current.focus();
      restoreSelection();
      document.execCommand("insertHTML", false, ` <a href="${url}">${label}</a> `);
    }
    setAttachPicker(null);
    setPickerSearch("");
    notify(`Link inserted: ${label}`);
  };

  // Attach a stored document file (private bucket) as an email attachment.
  // Sibling to fetchAndAttachTemplateDocs at line ~235, which covers the
  // template-driven auto-attach flow with a slightly different post-condition
  // (_autoAttached flag for cleanup on template re-pick). This handler is for
  // user-initiated single-doc attach via the document picker.
  const attachStoredDocument = async (doc) => {
    if (!doc.storage_path) {
      notify("This document has no file to attach", "warning");
      return;
    }
    try {
      const base64 = await downloadAsBase64(BUCKET_DOCUMENTS, doc.storage_path);
      if (!base64) {
        notify("Could not download document file (it may be missing or inaccessible)", "danger");
        return;
      }
      setAttachments(prev => [...prev, {
        filename: doc.filename || doc.label || "document",
        contentBase64: base64,
        mimeType: doc.mime_type || "application/octet-stream",
      }]);
      setAttachPicker(null);
      setPickerSearch("");
      notify(`Attached: ${doc.filename || doc.label}`);
    } catch (err) {
      notify("Could not attach document: " + err.message, "danger");
    }
  };

  // Strip quoted/replied content from a body before placing it in the editor.
  // Handles HTML (DOM-based: removes blockquote, .gmail_quote, .gmail_attr etc.)
  // and falls back to plain-text line scanning for non-HTML bodies.
  const stripBodyQuotes = (body) => {
    if (!body) return "";
    const isHtml = /<[a-z][\s\S]*>/i.test(body);
    if (isHtml) {
      const div = document.createElement("div");
      div.innerHTML = body;
      // Remove Gmail quote wrapper and Outlook-style quote blocks
      div.querySelectorAll(
        '.gmail_quote, .yahoo_quoted, .moz-cite-prefix, [class*="gmail_quote"]'
      ).forEach(el => el.remove());
      // Remove blockquotes (the actual quoted text)
      div.querySelectorAll("blockquote").forEach(el => el.remove());
      // Remove Gmail's "On [date], X wrote:" attribution line
      div.querySelectorAll(".gmail_attr").forEach(el => el.remove());
      // Strip trailing empty <br> / whitespace-only nodes
      const html = div.innerHTML.replace(/(<br\s*\/?>\s*)+$/i, "").trim();
      return html;
    }
    // Plain-text fallback — same patterns as thread panel
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith(">")) return lines.slice(0, i).join("\n").trimEnd();
      if (/^On .+wrote:/.test(t)) return lines.slice(0, i).join("\n").trimEnd();
      if (/^On .+,$/.test(t) && lines[i + 1]?.trim().endsWith("wrote:")) return lines.slice(0, i).join("\n").trimEnd();
      if (/^From:\s/.test(t) && /^Sent:\s|^To:\s/.test(lines[i + 1]?.trim() || "")) return lines.slice(0, i).join("\n").trimEnd();
      if (/^[_\-]{8,}$/.test(t)) return lines.slice(0, i).join("\n").trimEnd();
    }
    return body;
  };

  const handleTemplateChange = (tmplId) => {
    setSelectedTemplateId(tmplId || null);
    const tmpl = allTemplates.find(t => t.id === tmplId);
    if (tmpl) {
      applyTemplate(tmpl);
      // Session 96: when switching templates, clear the previous auto-
      // attached docs (fetchAndAttachTemplateDocs handles this internally
      // by filtering _autoAttached items) then fetch the new template's.
      // User-added attachments stay put.
      fetchAndAttachTemplateDocs(tmpl);
    } else {
      setSubject(initial.subject || "");
      if (bodyRef.current) bodyRef.current.innerHTML = stripBodyQuotes(initial.body || "").replace(/\n/g, "<br>");
      // No template selected — strip any auto-attached items.
      setAttachments(prev => prev.filter(a => !a._autoAttached));
    }
  };

  const canSend = subject.trim().length > 0;
  const batchTo = initial.batchTo || null;

  const handleSend = async () => {
    // DKIM fix (single source of truth): turn the `from` school-selector into
    // the actual headers — From = signed primary (+ school display name),
    // Reply-To = the school alias. Applied to every send branch below.
    const _hdr = resolveSenderHeaders(from, schools, primaryAddress);
    // Validation: in multi-recipient group mode (auto-BCC entry) the user is
    // no longer required to put a placeholder in To — we accept whichever
    // field(s) hold the recipients. All other entry modes keep the original
    // "at least one address in To" rule.
    if (!batchTo) {
      const multiMode = wasMultiRecipientGroupRef.current;
      if (multiMode ? (to.length === 0 && bcc.length === 0) : to.length === 0) {
        notify("Add at least one recipient", "warning");
        return;
      }
    }
    if (!canSend) return;
    if (!gmailConnected) { notify("Connect Gmail first in Settings → App", "warning"); return; }
    const bodyHtml = bodyRef.current.innerHTML;
    // Item 6 (v2.18.1): some mail clients (Apple Mail confirmed) render
    // attachments flush against the last character of the body. Append a
    // trailing blank line at SEND time when the message carries attachments —
    // the editor/stored body is never altered. Applied per send shape below
    // (batch items can carry their own attachments).
    const _padBodyForAttachments = (html, atts) =>
      (atts && atts.length > 0) ? html + "<br><br>" : html;
    if (batchTo && batchTo.length > 0) {
      // Session 95 BUG 4: prefer the raw template (stashed at template-load
      // time) when resolving each recipient. If the user edited the subject
      // or body after the template loaded, those edits replace the raw
      // source for everyone (so they take precedence, which matches user
      // intent). Single-send doesn't use this at all.
      const raw = rawTemplateRef.current;
      const userEditedSubject = selectedTemplate
        ? subject !== (mergeCtx ? applyMergeCtx(selectedTemplate.subject || "", mergeCtx) : (selectedTemplate.subject || ""))
        : true;
      const userEditedBody = selectedTemplate
        ? bodyHtml.replace(/\s+/g, "") !== ((mergeCtx ? applyMergeCtx(selectedTemplate.body || "", mergeCtx) : (selectedTemplate.body || "")).replace(/\n/g, "<br>")).replace(/\s+/g, "")
        : true;
      const subjectSource = userEditedSubject ? subject : (raw.subject || subject);
      const bodySource    = userEditedBody    ? bodyHtml : ((raw.body || "").replace(/\n/g, "<br>") || bodyHtml);
      const batchItems = batchTo.map(item => {
        const addr = typeof item === "string" ? item : item.addr;
        const ctx = typeof item === "string" ? {} : (item.ctx || {});
        // Session 95: thread per-item attachments through. Invoice bulk-send
        // builds these so each parent gets their own invoice HTML attached;
        // if an item has no attachments field, falls back to the modal-level
        // attachments array (backwards-compatible with callers that set a
        // shared attachment).
        const itemAttachments = (typeof item !== "string" && item.attachments)
          ? item.attachments
          : (attachments.length > 0 ? attachments : undefined);
        return {
          to: [addr],
          from: _hdr.from, replyTo: _hdr.replyTo || undefined,
          subject: applyMergeCtx(subjectSource, ctx),
          bodyHtml: _padBodyForAttachments(applyMergeCtx(bodySource, ctx), itemAttachments),
          label: ctx.parent_name || addr,
          attachments: itemAttachments,
          cc: cc.length > 0 ? cc : undefined,
          bcc: bcc.length > 0 ? bcc : undefined,
          // Session 95: invoiceId lets the queue processor fire setSent only
          // for rows whose email actually succeeded. Optional — undefined for
          // non-invoice batch sends.
          invoiceId: typeof item !== "string" ? item.invoiceId : undefined,
        };
      });
      if (window._autoSendBatch) window._autoSendBatch(batchItems);
      if (onSoundPlay) onSoundPlay();
      console.log("[ComposeModal] batch onSent firing for", batchItems.length, "items");
      if (onSent) onSent();
      notify(`Queued ${batchTo.length} emails to send ✓`);
      onClose();
      return;
    }
    setSending(true);
    try {
      // Reply threading — In-Reply-To targets the latest inbound message in
      // the thread (the one being answered). Older cached threads may lack
      // rfcMessageId; threadId alone still threads via the Gmail API.
      const replyCtx = (() => {
        if (!replyThreadId) return {};
        const withRfc = threadMessages.filter(m => !m.isSent && m.rfcMessageId);
        const target = withRfc[withRfc.length - 1] || [...threadMessages].reverse().find(m => m.rfcMessageId);
        return { threadId: replyThreadId, inReplyTo: target?.rfcMessageId || undefined };
      })();
      const result = await window.electronAPI.gmailSend({ to, from: _hdr.from, replyTo: _hdr.replyTo || undefined, cc: cc.length > 0 ? cc : undefined, bcc: bcc.length > 0 ? bcc : undefined, subject, bodyHtml: _padBodyForAttachments(bodyHtml, attachments), attachments: attachments.length > 0 ? attachments : undefined, ...replyCtx });
      if (result.ok) {
        try { localStorage.removeItem("mt-compose-draft"); } catch {}
        if (onSoundPlay) onSoundPlay();
        // Session 95 BUG 2: diagnostic log so we can confirm onSent fires on
        // successful single-sends. If Matt still sees invoices not marking
        // sent after this push, the console will tell us which branch we hit.
        console.log("[ComposeModal] single send OK — onSent:", typeof onSent);
        if (onSent) onSent();
        // Fire-and-forget sent refresh so reply pills clear without waiting
        // for the Dashboard's 30s poll.
        try { window._refreshSent && window._refreshSent(); } catch {}
        notify("Email sent ✓");
        onClose();
      } else {
        console.warn("[ComposeModal] gmailSend returned !ok:", result);
        notify("Send failed: " + result.error, "danger");
      }
    } catch(e) { console.error("[ComposeModal] send error:", e); notify("Send error: " + e.message, "danger"); }
    finally { setSending(false); }
  };

  const triggerLabel = triggerId ? (TRIGGER_MAP[triggerId]?.label || null) : null;

  // ── Filtered picker lists ──────────────────────────────────
  const pickerItems = React.useMemo(() => {
    const q = pickerSearch.toLowerCase();
    if (attachPicker === "resource") {
      return resources.filter(r => !r._isNew && ((r.label||"").toLowerCase().includes(q) || (r.category||"").toLowerCase().includes(q)));
    }
    if (attachPicker === "document") {
      return documents.filter(d => !d._isNew && ((d.label||"").toLowerCase().includes(q) || (d.type||"").toLowerCase().includes(q)));
    }
    return [];
  }, [attachPicker, pickerSearch, resources, documents]);

  return (
    <div style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 10000, width: size.w, height: minimised ? "auto" : size.h, minWidth: MIN_W, minHeight: minimised ? 0 : MIN_H }}
      ref={modalRef}
      onKeyDown={e => { e.stopPropagation(); }}
      onDragOver={e => { if (!chipDragRef.current && (e.dataTransfer.types.includes("Files") || isInternalDrag())) { e.preventDefault(); setFileDragOver(true); } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFileDragOver(false); }}
      onDrop={handleFileDrop}>

      {!minimised && [
        { edge: "n",  style: { top: 0, left: 8, right: 8, height: 6, cursor: "n-resize" } },
        { edge: "s",  style: { bottom: 0, left: 8, right: 8, height: 6, cursor: "s-resize" } },
        { edge: "w",  style: { left: 0, top: 8, bottom: 8, width: 6, cursor: "w-resize" } },
        { edge: "e",  style: { right: 0, top: 8, bottom: 8, width: 6, cursor: "e-resize" } },
        { edge: "nw", style: { top: 0, left: 0, width: 12, height: 12, cursor: "nw-resize" } },
        { edge: "ne", style: { top: 0, right: 0, width: 12, height: 12, cursor: "ne-resize" } },
        { edge: "sw", style: { bottom: 0, left: 0, width: 12, height: 12, cursor: "sw-resize" } },
        { edge: "se", style: { bottom: 0, right: 0, width: 12, height: 12, cursor: "se-resize" } },
      ].map(({ edge, style }) => (
        <div key={edge} onMouseDown={onEdgeMouseDown(edge)} style={{ position: "absolute", zIndex: 10, ...style }} />
      ))}

      <div style={{ background: fileDragOver ? `${colors.accentLight}` : colors.cardBg, borderRadius: minimised ? 10 : 14, width: "100%", height: minimised ? "auto" : "100%", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.35)", overflow: "hidden", outline: fileDragOver ? `2px dashed ${colors.accent}` : "none", transition: "outline 0.1s, background 0.1s, border-radius 0.15s" }}>

        <div onMouseDown={onHeaderMouseDown}
          onDoubleClick={() => setMinimised(o => !o)}
          style={{ background: colors.sidebarActive, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "grab", userSelect: "none", flexShrink: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#fff" }}>
            Compose{queueRemaining > 0 ? ` (1 of ${queueRemaining + 1})` : ""}
            {minimised && subject && <span style={{ fontWeight: 400, fontSize: 12, color: "rgba(255,255,255,0.6)", marginLeft: 10 }}>{subject}</span>}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {!minimised && !gmailConnected && <span style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", fontStyle: "italic" }}>⚠ Gmail not connected</span>}
            <button onClick={() => setMinimised(o => !o)} title={minimised ? "Restore" : "Minimise"}
              style={{ background: "none", border: "none", color: "rgba(255,255,255,0.7)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 4px" }}>
              {minimised ? "▲" : "−"}
            </button>
            <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.7)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 2px" }}>✕</button>
          </div>
        </div>

        {!minimised && (
        <>
        <div style={{ padding: "16px 20px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>

          {/* Template selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.border}` }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, flexShrink: 0 }}>📋 Template</span>
            <select value={selectedTemplateId || ""} onChange={e => handleTemplateChange(e.target.value)}
              style={{ flex: 1, padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", color: colors.text, background: colors.cardBg }}>
              <option value="">— No template —</option>
              {/* Session 95: option labels annotate school acronym and
                  default star so you can tell tagged templates apart at a
                  glance. "★ Term Invoice · SPS" reads as "default for Solway". */}
              {triggerTemplates.length > 0 && <optgroup label={triggerLabel || "Matching templates"}>
                {triggerTemplates.map(t => {
                  const s = t.schoolId ? (schools || []).find(x => x.id === t.schoolId) : null;
                  const chip = t.schoolId ? (s ? schoolAcronym(s) || "?" : "?") : "";
                  const star = t.isDefault ? "★ " : "";
                  const suffix = chip ? ` · ${chip}` : "";
                  return <option key={t.id} value={t.id}>{star}{t.name}{suffix}</option>;
                })}
              </optgroup>}
              {allTemplates.filter(t => t.triggerId !== triggerId).length > 0 && <optgroup label="Other templates">
                {allTemplates.filter(t => t.triggerId !== triggerId).map(t => {
                  const s = t.schoolId ? (schools || []).find(x => x.id === t.schoolId) : null;
                  const chip = t.schoolId ? (s ? schoolAcronym(s) || "?" : "?") : "";
                  const suffix = chip ? ` · ${chip}` : "";
                  return <option key={t.id} value={t.id}>{t.name} ({TRIGGER_MAP[t.triggerId]?.label || t.triggerId}){suffix}</option>;
                })}
              </optgroup>}
              {allTemplates.length === 0 && <option value="" disabled>No templates yet — create in Settings → Email Templates</option>}
            </select>
          </div>

          {/* From */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, minWidth: 60, textAlign: "right" }}>From</label>
            <select value={from} onChange={e => setFrom(e.target.value)}
              style={{ flex: 1, padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: colors.cardBg, color: colors.text }}>
              <option value="">Default Gmail account</option>
              {fromOptions.filter(Boolean).map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>

          {/* To chips with autocomplete */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, minWidth: 60, textAlign: "right", paddingTop: 8 }}>To</label>
            <div style={{ flex: 1, position: "relative" }} ref={toWrapRef}>
              {batchTo ? (
                <div style={{ border: `1px solid ${colors.sidebarActive}40`, borderRadius: 8, padding: "8px 12px", background: colors.blueLight, fontSize: 12, color: colors.sidebarActive, fontWeight: 600 }}>
                  <div>⚡ Will send individually to {batchTo.length} recipients when you click Send</div>
                  <div style={{ fontWeight: 400, marginTop: 3, color: colors.textLight }}>Use merge fields: <code style={{ background: "rgba(0,0,0,0.06)", borderRadius: 3, padding: "1px 4px" }}>{"{{parent_name}}"}</code> <code style={{ background: "rgba(0,0,0,0.06)", borderRadius: 3, padding: "1px 4px" }}>{"{{student_name}}"}</code> <code style={{ background: "rgba(0,0,0,0.06)", borderRadius: 3, padding: "1px 4px" }}>{"{{school_name}}"}</code></div>
                </div>
              ) : (<>
              <div style={{ border: `1px solid ${chipDragOver === "to" ? colors.accent : colors.inputBorder}`, borderRadius: 8, padding: "6px 8px", display: "flex", flexWrap: "wrap", gap: 5, minHeight: 38, cursor: "text", transition: "border-color 0.15s" }}
                onClick={() => document.getElementById("compose-to-input")?.focus()}
                onDragOver={e => onFieldDragOver(e, "to")}
                onDragLeave={() => { if (chipDragRef.current) setChipDragOver(null); }}
                onDrop={e => onFieldDrop(e, "to")}>
                {to.map(email => (
                  <span key={email} draggable onDragStart={e => onChipDragStart(e, email, "to")} onDragEnd={onChipDragEnd}
                    title={email}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: colors.accentLight, borderRadius: 20, fontSize: 12, color: colors.accentDark, fontWeight: 500, cursor: "grab" }}>
                    {resolveChipLabel(email)}
                    <button onClick={() => removeRecipient(email)} style={{ background: "none", border: "none", cursor: "pointer", color: colors.accentDark, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                  </span>
                ))}
                <input id="compose-to-input" value={toInput} onChange={e => handleToInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "ArrowDown") { e.preventDefault(); setSuggestionIdx(i => Math.min(i + 1, toSuggestions.length - 1)); return; }
                    if (e.key === "ArrowUp") { e.preventDefault(); setSuggestionIdx(i => Math.max(i - 1, -1)); return; }
                    if ((e.key === "Enter" || e.key === "Tab") && suggestionIdx >= 0 && toSuggestions[suggestionIdx]) { e.preventDefault(); addRecipient(toSuggestions[suggestionIdx].email); return; }
                    if (e.key === "Enter" || e.key === "," || e.key === "Tab") { e.preventDefault(); addRecipient(toInput); }
                    if (e.key === "Backspace" && !toInput && to.length > 0) setTo(prev => prev.slice(0, -1));
                    if (e.key === "Escape") { setToSuggestions([]); setSuggestionIdx(-1); }
                  }}
                  onBlur={() => { setTimeout(() => { if (toInput.trim()) addRecipient(toInput); setToSuggestions([]); }, 150); }}
                  placeholder={to.length === 0 ? "Add recipients..." : ""}
                  autoCorrect="off" autoCapitalize="none" autoComplete="off" spellCheck={false}
                  style={{ border: "none", outline: "none", fontSize: 13, fontFamily: "inherit", flex: 1, minWidth: 120, background: "transparent" }} />
              </div>
              {toSuggestions.length > 0 && (() => {
                const r = toWrapRef.current?.getBoundingClientRect();
                return r ? (
                <div style={{ position: "fixed", top: r.bottom + 2, left: r.left, width: r.width, zIndex: 10100, background: colors.cardBg, border: `1px solid ${colors.inputBorder}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", overflow: "hidden" }}>
                  {toSuggestions.map((s, i) => (
                    <div key={s.email} onMouseDown={() => addRecipient(s.email)}
                      style={{ padding: "7px 12px", cursor: "pointer", background: i === suggestionIdx ? colors.accentLight : colors.cardBg, display: "flex", flexDirection: "column", gap: 1 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: colors.text }}>{s.label || s.email.split("@")[0]}</span>
                      <span style={{ fontSize: 11, color: colors.textMuted }}>{[s.label && s.label !== s.email ? s.email : null, s.sub].filter(Boolean).join(" · ")}</span>
                    </div>
                  ))}
                </div>
                ) : null;
              })()}
              </>)}
            </div>
          </div>

          {/* CC / BCC toggle buttons */}
          {!showCc && !showBcc && (
            <div style={{ display: "flex", gap: 6, paddingLeft: 68 }}>
              <button onMouseDown={() => setShowCc(true)} style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>+ CC</button>
              <button onMouseDown={() => setShowBcc(true)} style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>+ BCC</button>
            </div>
          )}
          {showCc && !showBcc && (
            <div style={{ display: "flex", gap: 6, paddingLeft: 68 }}>
              <button onMouseDown={() => setShowBcc(true)} style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>+ BCC</button>
            </div>
          )}

          {/* CC */}
          {showCc && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, minWidth: 60, textAlign: "right", paddingTop: 8, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 3 }}>
                <button onMouseDown={() => { setShowCc(false); setCc([]); setCcInput(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 14, lineHeight: 1, padding: 0, fontFamily: "inherit" }}>−</button>
                CC
              </label>
              <div style={{ flex: 1, position: "relative" }} ref={ccWrapRef}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "6px 8px", border: `1px solid ${chipDragOver === "cc" ? colors.accent : colors.inputBorder}`, borderRadius: 8, minHeight: 36, alignItems: "center", background: "transparent", transition: "border-color 0.15s" }}
                onDragOver={e => onFieldDragOver(e, "cc")}
                onDragLeave={() => { if (chipDragRef.current) setChipDragOver(null); }}
                onDrop={e => onFieldDrop(e, "cc")}>
                {cc.map(email => (
                  <span key={email} draggable onDragStart={e => onChipDragStart(e, email, "cc")} onDragEnd={onChipDragEnd}
                    title={email}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: colors.accentLight, borderRadius: 20, fontSize: 12, color: colors.accentDark, fontWeight: 500, cursor: "grab" }}>
                    {resolveChipLabel(email)}
                    <button onClick={() => setCc(prev => prev.filter(e => e !== email))} style={{ background: "none", border: "none", cursor: "pointer", color: colors.accentDark, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                  </span>
                ))}
                <input value={ccInput} onChange={e => handleCcInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "ArrowDown") { e.preventDefault(); setCcSuggestionIdx(i => Math.min(i + 1, ccSuggestions.length - 1)); return; }
                    if (e.key === "ArrowUp") { e.preventDefault(); setCcSuggestionIdx(i => Math.max(i - 1, -1)); return; }
                    if ((e.key === "Enter" || e.key === "Tab") && ccSuggestionIdx >= 0 && ccSuggestions[ccSuggestionIdx]) { e.preventDefault(); const v = ccSuggestions[ccSuggestionIdx].email; if (!cc.includes(v)) setCc(prev => [...prev, v]); setCcInput(""); setCcSuggestions([]); setCcSuggestionIdx(-1); return; }
                    if ((e.key === "Enter" || e.key === "," || e.key === "Tab") && ccInput.trim()) { e.preventDefault(); const v = ccInput.trim().replace(/,$/, ""); if (v && !cc.includes(v)) setCc(prev => [...prev, v]); setCcInput(""); setCcSuggestions([]); }
                    if (e.key === "Backspace" && !ccInput && cc.length > 0) setCc(prev => prev.slice(0, -1));
                    if (e.key === "Escape") { setCcSuggestions([]); setCcSuggestionIdx(-1); }
                  }}
                  onBlur={() => { setTimeout(() => { if (ccInput.trim()) { setCc(prev => prev.includes(ccInput.trim()) ? prev : [...prev, ccInput.trim()]); setCcInput(""); } setCcSuggestions([]); }, 150); }}
                  placeholder={cc.length === 0 ? "Add CC\u2026" : ""}
                  autoCorrect="off" autoCapitalize="none" autoComplete="off" spellCheck={false}
                  style={{ flex: 1, minWidth: 120, border: "none", outline: "none", fontSize: 13, fontFamily: "inherit", color: colors.text, background: "transparent", padding: "2px 2px" }} />
              </div>
              {ccSuggestions.length > 0 && (() => {
                const r = ccWrapRef.current?.getBoundingClientRect();
                return r ? (
                <div style={{ position: "fixed", top: r.bottom + 2, left: r.left, width: r.width, zIndex: 10100, background: colors.cardBg, border: `1px solid ${colors.inputBorder}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", overflow: "hidden" }}>
                  {ccSuggestions.map((s, i) => (
                    <div key={s.email} onMouseDown={() => { if (!cc.includes(s.email)) setCc(prev => [...prev, s.email]); setCcInput(""); setCcSuggestions([]); setCcSuggestionIdx(-1); }}
                      style={{ padding: "7px 12px", cursor: "pointer", background: i === ccSuggestionIdx ? colors.accentLight : colors.cardBg, display: "flex", flexDirection: "column", gap: 1 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: colors.text }}>{s.label || s.email.split("@")[0]}</span>
                      <span style={{ fontSize: 11, color: colors.textMuted }}>{[s.label && s.label !== s.email ? s.email : null, s.sub].filter(Boolean).join(" · ")}</span>
                    </div>
                  ))}
                </div>
                ) : null;
              })()}
              </div>
            </div>
          )}

          {/* BCC */}
          {showBcc && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, minWidth: 60, textAlign: "right", paddingTop: 8, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 3 }}>
                <button onMouseDown={() => { setShowBcc(false); setBcc([]); setBccInput(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 14, lineHeight: 1, padding: 0, fontFamily: "inherit" }}>−</button>
                BCC
              </label>
              <div style={{ flex: 1, position: "relative" }} ref={bccWrapRef}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "6px 8px", border: `1px solid ${chipDragOver === "bcc" ? colors.accent : colors.inputBorder}`, borderRadius: 8, minHeight: 36, alignItems: "center", background: "transparent", transition: "border-color 0.15s" }}
                onDragOver={e => onFieldDragOver(e, "bcc")}
                onDragLeave={() => { if (chipDragRef.current) setChipDragOver(null); }}
                onDrop={e => onFieldDrop(e, "bcc")}>
                {bcc.map(email => (
                  <span key={email} draggable onDragStart={e => onChipDragStart(e, email, "bcc")} onDragEnd={onChipDragEnd}
                    title={email}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: colors.accentLight, borderRadius: 20, fontSize: 12, color: colors.accentDark, fontWeight: 500, cursor: "grab" }}>
                    {resolveChipLabel(email)}
                    <button onClick={() => setBcc(prev => prev.filter(e => e !== email))} style={{ background: "none", border: "none", cursor: "pointer", color: colors.accentDark, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                  </span>
                ))}
                <input value={bccInput} onChange={e => handleBccInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "ArrowDown") { e.preventDefault(); setBccSuggestionIdx(i => Math.min(i + 1, bccSuggestions.length - 1)); return; }
                    if (e.key === "ArrowUp") { e.preventDefault(); setBccSuggestionIdx(i => Math.max(i - 1, -1)); return; }
                    if ((e.key === "Enter" || e.key === "Tab") && bccSuggestionIdx >= 0 && bccSuggestions[bccSuggestionIdx]) { e.preventDefault(); const v = bccSuggestions[bccSuggestionIdx].email; if (!bcc.includes(v)) setBcc(prev => [...prev, v]); setBccInput(""); setBccSuggestions([]); setBccSuggestionIdx(-1); return; }
                    if ((e.key === "Enter" || e.key === "," || e.key === "Tab") && bccInput.trim()) { e.preventDefault(); const v = bccInput.trim().replace(/,$/, ""); if (v && !bcc.includes(v)) setBcc(prev => [...prev, v]); setBccInput(""); setBccSuggestions([]); }
                    if (e.key === "Backspace" && !bccInput && bcc.length > 0) setBcc(prev => prev.slice(0, -1));
                    if (e.key === "Escape") { setBccSuggestions([]); setBccSuggestionIdx(-1); }
                  }}
                  onBlur={() => { setTimeout(() => { if (bccInput.trim()) { setBcc(prev => prev.includes(bccInput.trim()) ? prev : [...prev, bccInput.trim()]); setBccInput(""); } setBccSuggestions([]); }, 150); }}
                  placeholder={bcc.length === 0 ? "Add BCC\u2026" : ""}
                  autoCorrect="off" autoCapitalize="none" autoComplete="off" spellCheck={false}
                  style={{ flex: 1, minWidth: 120, border: "none", outline: "none", fontSize: 13, fontFamily: "inherit", color: colors.text, background: "transparent", padding: "2px 2px" }} />
              </div>
              {bccSuggestions.length > 0 && (() => {
                const r = bccWrapRef.current?.getBoundingClientRect();
                return r ? (
                <div style={{ position: "fixed", top: r.bottom + 2, left: r.left, width: r.width, zIndex: 10100, background: colors.cardBg, border: `1px solid ${colors.inputBorder}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", overflow: "hidden" }}>
                  {bccSuggestions.map((s, i) => (
                    <div key={s.email} onMouseDown={() => { if (!bcc.includes(s.email)) setBcc(prev => [...prev, s.email]); setBccInput(""); setBccSuggestions([]); setBccSuggestionIdx(-1); }}
                      style={{ padding: "7px 12px", cursor: "pointer", background: i === bccSuggestionIdx ? colors.accentLight : colors.cardBg, display: "flex", flexDirection: "column", gap: 1 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: colors.text }}>{s.label || s.email.split("@")[0]}</span>
                      <span style={{ fontSize: 11, color: colors.textMuted }}>{[s.label && s.label !== s.email ? s.email : null, s.sub].filter(Boolean).join(" · ")}</span>
                    </div>
                  ))}
                </div>
                ) : null;
              })()}
              </div>
            </div>
          )}

          {/* Subject */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, minWidth: 60, textAlign: "right" }}>Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)}
              autoCorrect="off" spellCheck={false}
              style={{ flex: 1, padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", boxSizing: "border-box", background: "transparent" }} />
          </div>

          {/* Attachments */}
          {attachments.filter(a => a.mimeType !== "image/png").length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.border}` }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, alignSelf: "center", marginRight: 4 }}>📎</span>
              {attachments.filter(a => a.mimeType !== "image/png").map((att, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 12, fontSize: 12, color: colors.text }}>
                  {att.filename}
                  <button onClick={() => setAttachments(prev => prev.filter(a => a !== att))} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                </span>
              ))}
            </div>
          )}

          {/* Formatting toolbar */}
          <div style={{ display: "flex", gap: 4, padding: "4px 0", borderBottom: `1px solid ${colors.border}`, marginBottom: 2 }}>
            {[{ label: "B", cmd: "bold", style: { fontWeight: 700 } }, { label: "I", cmd: "italic", style: { fontStyle: "italic" } }, { label: "U", cmd: "underline", style: { textDecoration: "underline" } }].map(({ label, cmd, style: s }) => (
              <button key={cmd} onMouseDown={e => { e.preventDefault(); execFormat(cmd); }}
                style={{ ...s, padding: "3px 8px", border: `1px solid ${colors.border}`, borderRadius: 5, background: colors.cardBg, cursor: "pointer", fontSize: 13, fontFamily: "inherit", color: colors.text }}>{label}</button>
            ))}
            <button onMouseDown={e => { e.preventDefault(); insertLink(); }}
              style={{ padding: "3px 8px", border: `1px solid ${colors.border}`, borderRadius: 5, background: colors.cardBg, cursor: "pointer", fontSize: 12, fontFamily: "inherit", color: colors.sidebarActive }}>🔗 Link</button>
            <button onMouseDown={e => { e.preventDefault(); execFormat("removeFormat"); }}
              style={{ padding: "3px 8px", border: `1px solid ${colors.border}`, borderRadius: 5, background: colors.cardBg, cursor: "pointer", fontSize: 12, fontFamily: "inherit", color: colors.textMuted }}>Clear format</button>
          </div>

          {/* Body */}
          <div ref={bodyRef} contentEditable suppressContentEditableWarning
            autoCorrect="off"
            onBlur={() => {
              const sel = window.getSelection();
              if (sel && sel.rangeCount > 0 && bodyRef.current && bodyRef.current.contains(sel.anchorNode)) {
                lastSelectionRef.current = sel.getRangeAt(0).cloneRange();
              }
            }}
            style={{ flex: 1, minHeight: 200, border: `1px solid ${colors.inputBorder}`, borderRadius: 8, padding: "10px 12px", fontSize: 13, fontFamily: "inherit", color: colors.text, background: colors.inputBg, outline: "none", lineHeight: 1.6, overflowY: "auto" }} />

          {/* PNG inline preview */}
          {attachments.filter(a => a.mimeType === "image/png").map((att, i) => (
            <div key={i} style={{ border: `1px solid ${colors.border}`, borderRadius: 8, overflow: "hidden", marginTop: 4 }}>
              <div style={{ padding: "5px 10px", background: colors.bg, fontSize: 11, color: colors.textMuted, borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>📎 {att.filename}</span>
                <button onClick={() => setAttachments(prev => prev.filter(a => a.mimeType !== "image/png"))} style={{ background: "none", border: "none", cursor: "pointer", color: colors.textMuted, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
              </div>
              <img src={`data:image/png;base64,${att.contentBase64}`} alt="Timetable preview" style={{ width: "100%", display: "block", maxHeight: 260, objectFit: "contain", background: "#fff" }} />
            </div>
          ))}
        </div>

        {/* Previous messages panel — read-only, shown above footer when toggled */}
        {showThread && threadMessages.length > 0 && (
          <div style={{ borderTop: `1px solid ${colors.border}`, maxHeight: 300, overflowY: "auto", background: darkMode ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)" }}>
            <div style={{ padding: "6px 20px 4px", fontSize: 10, fontWeight: 700, color: colors.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", background: colors.cardBg, borderBottom: `1px solid ${colors.border}` }}>
              Previous messages — not included in send
            </div>
            {[...threadMessages].reverse().map((msg, i) => {
              const fromName = msg.from?.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || msg.from?.split("@")[0] || msg.from || "";
              const dateObj = msg.internalDate ? new Date(Number(msg.internalDate)) : msg.date ? new Date(msg.date) : null;
              const dateStr = dateObj && !isNaN(dateObj)
                ? dateObj.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) + " at " + dateObj.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase()
                : "";
              // Build rawBody: prefer bodyHtml with DOM-based quote stripping (reliable),
              // fall back to body plain text only when no HTML is available.
              const rawBody = (() => {
                if (msg.bodyHtml) {
                  // Strip CID inline image refs before parsing — prevents console errors
                  const cleanHtml = msg.bodyHtml.replace(/\s*src\s*=\s*["']cid:[^"']*["']/gi, "");
                  const div = document.createElement("div");
                  div.innerHTML = cleanHtml;
                  // Remove Gmail/standard quote containers
                  div.querySelectorAll(
                    '.gmail_quote, .yahoo_quoted, blockquote, .gmail_attr, [class*="gmail_quote"]'
                  ).forEach(el => el.remove());
                  // Remove scripts, styles, and hidden/tracking elements
                  // Covers: display:none, visibility:hidden, opacity:0, font-size:0, color:transparent,
                  // max-height:0, line-height:0 — all common techniques used to hide tracking content
                  div.querySelectorAll(
                    'script, style, img, head, meta, link, ' +
                    '[style*="display:none"], [style*="display: none"], ' +
                    '[style*="visibility:hidden"], [style*="visibility: hidden"], ' +
                    '[style*="opacity:0"], [style*="opacity: 0"], ' +
                    '[style*="font-size:0"], [style*="font-size: 0"], ' +
                    '[style*="color:transparent"], [style*="color: transparent"], ' +
                    '[style*="max-height:0"], [style*="max-height: 0"], ' +
                    '[style*="line-height:0"], [style*="line-height: 0"], ' +
                    '[style*="overflow:hidden"][style*="height:0"], ' +
                    '[style*="mso-"], [class*="MsoNormal"] noscript'
                  ).forEach(el => el.remove());
                  // Convert to plain text — block-level tags become newlines so line scanner works
                  return div.innerHTML
                    .replace(/<br\s*\/?>/gi, "\n")
                    .replace(/<\/?(div|p|table|tr|li|h[1-6])[^>]*>/gi, "\n")
                    .replace(/<[^>]+>/g, "")
                    .replace(/&nbsp;/g, " ")
                    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                    .replace(/[ \t]+/g, " ")
                    .replace(/\n[ \t]+/g, "\n").replace(/[ \t]+\n/g, "\n")
                    .replace(/\n{3,}/g, "\n\n")
                    // Strip leading lines that are purely a short number — Yahoo/tracking artifacts
                    .replace(/^\s*\d{1,4}\s*\n/, "")
                    .trim();
                }
                return msg.body || "";
              })();
              // Comprehensively strip quoted history from all major email client styles
              const bodyText = (() => {
                if (!rawBody) return "";
                const lines = rawBody.split("\n");
                for (let i = 0; i < lines.length; i++) {
                  const t = lines[i].trim();
                  if (t.startsWith(">")) return lines.slice(0, i).join("\n").trimEnd();
                  if (/^On .+wrote:/.test(t)) return lines.slice(0, i).join("\n").trimEnd();
                  if (/^On .+,$/.test(t) && lines[i+1]?.trim().endsWith("wrote:")) return lines.slice(0, i).join("\n").trimEnd();
                  if (/^From:\s/.test(t) && /^Sent:\s|^To:\s/.test(lines[i+1]?.trim() || "")) return lines.slice(0, i).join("\n").trimEnd();
                  if (/^[_\-]{8,}$/.test(t)) return lines.slice(0, i).join("\n").trimEnd();
                  if (/^Get Outlook for/i.test(t)) return lines.slice(0, i).join("\n").trimEnd();
                  if (/^Sent from my (iPhone|iPad|Galaxy|Pixel)/i.test(t)) return lines.slice(0, i).join("\n").trimEnd();
                }
                const inlinePatterns = [
                  / [>＞] On \d/,
                  / On (Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d{1,2} \w)/,
                  / On (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/,
                  / On \w+,\s+[A-Z][a-z]+ \d/,               // "On Thursday, April 16" (Gmail full format)
                  / On \d+ \w+ \d{4}/,
                  / On [A-Z][a-z]{2,8} \d{1,2},?\s+\d{4}/,   // "On Mar 25, 2026" / "On March 25 2026"
                  / On \d{1,2}\/\d{1,2}\/\d{2,4}/,             // "On 25/03/2026" date format
                  / From: .+ Sent: /,
                  /_{8,}/,
                  /Get Outlook for/,                            // Outlook mobile signature
                  /Sent from my (iPhone|iPad|Galaxy|Pixel)/,    // Mobile signatures
                ];
                for (const pat of inlinePatterns) {
                  const idx = rawBody.search(pat);
                  if (idx > 20) return rawBody.slice(0, idx).trimEnd();
                }
                // Last resort: find "wrote:" and cut back to the preceding " On "
                const wroteIdx = rawBody.search(/,?\s+\w[\w\s.]*wrote:\s/);
                if (wroteIdx > 20) {
                  const beforeWrote = rawBody.slice(0, wroteIdx);
                  const onIdx = beforeWrote.lastIndexOf(" On ");
                  if (onIdx > 10) return rawBody.slice(0, onIdx).trimEnd();
                }
                return rawBody;
              })();
              const msgKey = msg.id || i;
              const isExpanded = expandedThreadMsgs.has(msgKey);
              return (
                <div key={msgKey} style={{ borderBottom: i < threadMessages.length - 1 ? `1px solid ${colors.borderLight || colors.border}` : "none" }}>
                  <div onClick={() => setExpandedThreadMsgs(prev => { const next = new Set(prev); isExpanded ? next.delete(msgKey) : next.add(msgKey); return next; })}
                    style={{ padding: "9px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}
                    onMouseEnter={e => e.currentTarget.style.background = darkMode ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: colors.text }}>{msg.isSent ? "You" : fromName}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: colors.textMuted }}>{dateStr}</span>
                      <span style={{ fontSize: 10, color: colors.textMuted }}>{isExpanded ? "▾" : "▸"}</span>
                    </div>
                  </div>
                  {isExpanded && (
                    <div style={{ padding: "0 20px 12px", fontSize: 12, color: colors.textMuted, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {bodyText || "(no content)"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${colors.border}`, display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "center", flexShrink: 0 }}>
          {(threadMessages.length > 0 || lessonRows.length > 0) && (
            <div style={{ marginRight: "auto", flex: "1 1 auto", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, minWidth: 0, overflow: "hidden" }}>
              {threadMessages.length > 0 && (
                <button onClick={() => setShowThread(o => !o)}
                  style={{ flexShrink: 0, padding: "7px 14px", border: `1px solid ${colors.border}`, borderRadius: 8, background: showThread ? colors.bg : colors.cardBg, color: colors.textMuted, fontSize: 12, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
                  {showThread ? "▾" : "▸"} Previous messages ({threadMessages.length})
                </button>
              )}
              {lessonRows.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 100, overflowY: "auto", overflowX: "hidden", width: "100%" }}>
                  {lessonRows.map((r, i) => (
                    <div key={i} style={{ fontSize: 11, color: colors.textMuted, lineHeight: 1.5, display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                      <strong style={{ color: colors.text }}>{r.studentName}</strong> — {r.instrument}
                      {r.hasWeeklyData
                        ? (r.notThisWeek
                          ? <> · regular {r.regularStr} · <span style={{ color: colors.textMuted }}>not this week</span></>
                          : <> · this week {r.thisWeekStr} · {r.regular ? `regular ${r.regularStr}` : <span style={{ color: colors.textMuted }}>no regular slot</span>}</>)
                        : <> · {r.lesson.day} {r.lesson.start}</>}
                      {r.changed && (
                        <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 10, background: "rgba(217,119,6,0.12)", color: "#D97706", textTransform: "uppercase", letterSpacing: "0.04em" }}>Changed</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {queueRemaining > 0 && onCancelAll && (
            <button onClick={onCancelAll} style={{ padding: "8px 14px", border: `1px solid ${colors.danger}40`, borderRadius: 8, background: darkMode ? "rgba(196,84,84,0.15)" : "#FEF2F2", fontSize: 13, fontFamily: "inherit", cursor: "pointer", color: colors.danger, marginRight: "auto" }}>
              Cancel all ({queueRemaining + 1})
            </button>
          )}
          <button onClick={onClose} style={{ padding: "8px 18px", border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.cardBg, fontSize: 13, fontFamily: "inherit", cursor: "pointer", color: colors.textLight }}>
            {queueRemaining > 0 ? "Skip" : "Cancel"}
          </button>

          {/* Hidden file input — triggered by File option in attach menu */}
          <input id="compose-attach-input" type="file" multiple accept=".pdf,.html,.xlsx,.csv,.png,.jpg,.jpeg,.docx" style={{ display: "none" }}
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              for (const file of files) {
                try {
                  const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("Read failed")); r.readAsDataURL(file); });
                  setAttachments(prev => [...prev, { filename: file.name, contentBase64: base64, mimeType: file.type || "application/octet-stream" }]);
                } catch (err) { notify("Could not read file: " + err.message, "danger"); }
              }
              e.target.value = "";
            }} />

          {/* Attach button with 3-option popover */}
          <div style={{ position: "relative" }} ref={attachMenuRef}>
            <button
              onClick={() => setShowAttachMenu(o => !o)}
              style={{ padding: "8px 18px", border: "none", borderRadius: 8, background: colors.accent, color: "#fff", fontSize: 13, fontFamily: "inherit", fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Paperclip size={14} /> Attach
            </button>
            {showAttachMenu && (
              <div style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 0, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.15)", overflow: "hidden", minWidth: 180, zIndex: 10001 }}>
                {offeredAttachment && (
                  <button onClick={() => { setShowAttachMenu(false); if (!offeredAlreadyAttached) setAttachments(prev => [...prev, offeredAttachment]); }}
                    disabled={offeredAlreadyAttached}
                    title={offeredAlreadyAttached ? "Already attached" : "Attach the day's timetable"}
                    style={{ width: "100%", padding: "10px 16px", border: "none", background: "none", cursor: offeredAlreadyAttached ? "default" : "pointer", fontSize: 13, fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: 10, color: offeredAlreadyAttached ? colors.textMuted : colors.text, borderBottom: `1px solid ${colors.borderLight}` }}
                    onMouseEnter={e => { if (!offeredAlreadyAttached) e.currentTarget.style.background = colors.bg; }}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}>
                    <FileText size={14} style={{ color: colors.accent, flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{offeredAttachment.filename}</span>
                    {offeredAlreadyAttached && <span style={{ marginLeft: "auto", fontSize: 11, color: colors.textMuted }}>added</span>}
                  </button>
                )}
                <button onClick={() => { setShowAttachMenu(false); document.getElementById("compose-attach-input")?.click(); }}
                  style={{ width: "100%", padding: "10px 16px", border: "none", background: "none", cursor: "pointer", fontSize: 13, fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: 10, color: colors.text, borderBottom: `1px solid ${colors.borderLight}` }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <File size={14} style={{ color: colors.textMuted, flexShrink: 0 }} />
                  <span>File from computer</span>
                </button>
                <button onClick={() => { setShowAttachMenu(false); setAttachPicker("resource"); setPickerSearch(""); }}
                  style={{ width: "100%", padding: "10px 16px", border: "none", background: "none", cursor: "pointer", fontSize: 13, fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: 10, color: colors.text, borderBottom: `1px solid ${colors.borderLight}` }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <Library size={14} style={{ color: colors.textMuted, flexShrink: 0 }} />
                  <span>Resource link</span>
                  {resources.length > 0 && <span style={{ marginLeft: "auto", fontSize: 11, color: colors.textMuted }}>{resources.length}</span>}
                </button>
                <button onClick={() => { setShowAttachMenu(false); setAttachPicker("document"); setPickerSearch(""); }}
                  style={{ width: "100%", padding: "10px 16px", border: "none", background: "none", cursor: "pointer", fontSize: 13, fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: 10, color: colors.text }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <FileText size={14} style={{ color: colors.textMuted, flexShrink: 0 }} />
                  <span>Document</span>
                  {documents.length > 0 && <span style={{ marginLeft: "auto", fontSize: 11, color: colors.textMuted }}>{documents.length}</span>}
                </button>
              </div>
            )}
          </div>

          <button onClick={handleSend} disabled={sending || !gmailConnected || !canSend}
            title={!canSend ? "Enter a subject before sending" : ""}
            style={{ padding: "8px 22px", border: "none", borderRadius: 8, fontSize: 13, fontFamily: "inherit", fontWeight: 600, transition: "background 0.15s, color 0.15s",
              background: !canSend ? colors.borderLight : gmailConnected ? colors.sidebarActive : colors.border,
              color: !canSend ? colors.textMuted : gmailConnected ? "#fff" : colors.textMuted,
              cursor: sending || !gmailConnected || !canSend ? "not-allowed" : "pointer" }}>
            {sending ? "Sending…" : !canSend ? "No Subject" : queueRemaining > 0 ? "Send & Next" : "Send"}
          </button>
        </div>
        </>) } {/* end !minimised */}
      </div>

      {/* ── Attach picker modal ── */}
      {attachPicker && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10002, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) { setAttachPicker(null); setPickerSearch(""); } }}>
          <div style={{ background: colors.cardBg, borderRadius: 14, width: 480, maxHeight: "70vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.3)", overflow: "hidden" }}>
            {/* Picker header */}
            <div style={{ background: colors.sidebarHover, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#fff", display: "inline-flex", alignItems: "center", gap: 8 }}>
                {attachPicker === "resource" ? <><Library size={14} /> Insert Resource Link</> : <><FileText size={14} /> Add Document</>}
              </span>
              <button onClick={() => { setAttachPicker(null); setPickerSearch(""); }}
                style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.7)", display: "inline-flex", alignItems: "center" }}>
                <X size={16} />
              </button>
            </div>

            {/* Search */}
            <div style={{ padding: "12px 16px", borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
              <input autoFocus value={pickerSearch} onChange={e => setPickerSearch(e.target.value)} placeholder={`Search ${attachPicker}s…`}
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }} />
            </div>

            {/* List */}
            <div style={{ overflowY: "auto", flex: 1 }}>
              {pickerItems.length === 0 ? (
                <div style={{ padding: "32px 20px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>
                  {attachPicker === "resource" ? "No resources found" : "No documents found"}
                </div>
              ) : (
                pickerItems.map((item, i) => (
                  <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: i < pickerItems.length - 1 ? `1px solid ${colors.borderLight}` : "none", background: colors.cardBg }}
                    onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                    onMouseLeave={e => e.currentTarget.style.background = colors.cardBg}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: colors.text, marginBottom: 2 }}>{item.label || "—"}</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        {attachPicker === "resource" && item.category && (
                          <span style={{ padding: "1px 7px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: colors.accentLight, color: colors.accentDark }}>{item.category}</span>
                        )}
                        {attachPicker === "document" && item.type && (
                          <span style={{ padding: "1px 7px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: colors.blueLight, color: colors.sidebarHover, border: `1px solid ${colors.sidebarHover}30` }}>{item.type}</span>
                        )}
                        {item.url && (
                          <span style={{ fontSize: 11, color: colors.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{item.url.replace(/^https?:\/\//, "")}</span>
                        )}
                      </div>
                    </div>
                    {attachPicker === "document" && item.storage_path ? (
                      <button
                        onClick={() => attachStoredDocument(item)}
                        title="Attach file to email"
                        style={{ flexShrink: 0, padding: "6px 12px", border: "none", borderRadius: 7, background: colors.sidebarHover, color: "#fff", fontSize: 12, fontFamily: "inherit", fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <Paperclip size={12} /> Attach File
                      </button>
                    ) : (
                      <button
                        onClick={() => insertBodyLink(item.label, item.url)}
                        disabled={!item.url}
                        title={item.url ? "Insert link into email body" : "No link or file saved for this item"}
                        style={{ flexShrink: 0, padding: "6px 12px", border: "none", borderRadius: 7, background: item.url ? colors.sidebarHover : colors.borderLight, color: item.url ? "#fff" : colors.textMuted, fontSize: 12, fontFamily: "inherit", fontWeight: 600, cursor: item.url ? "pointer" : "not-allowed", display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <Link size={12} /> Insert link
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
