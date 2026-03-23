// ============================================================
// COMPOSE MODAL
// Floating, draggable/resizable email compose window with
// Gmail send, attachments, templates, and batch mode.
// ============================================================

import React from "react";
import { colors, STORAGE_KEYS, TRIGGER_MAP } from "../constants";
import { getUserTemplates, applyMergeCtx } from "../utils/emailTemplates";

export function ComposeModal({ initial, schools, students, teachers, contacts, onClose, onCancelAll, notify, queueRemaining = 0 }) {
  const [to, setTo] = React.useState(initial.to || []);
  const [toInput, setToInput] = React.useState("");
  const [toSuggestions, setToSuggestions] = React.useState([]);
  const [suggestionIdx, setSuggestionIdx] = React.useState(-1);
  const [from, setFrom] = React.useState(initial.from || "");
  const [cc, setCc] = React.useState(initial.cc || []);
  const [ccInput, setCcInput] = React.useState("");
  const [bcc, setBcc] = React.useState(initial.bcc || []);
  const [bccInput, setBccInput] = React.useState("");
  const [showCc, setShowCc] = React.useState(!!(initial.cc && initial.cc.length));
  const [showBcc, setShowBcc] = React.useState(!!(initial.bcc && initial.bcc.length));
  const [subject, setSubject] = React.useState(initial.subject || "");
  const [sending, setSending] = React.useState(false);
  const [attachments, setAttachments] = React.useState(initial.attachments || []);
  const bodyRef = React.useRef(null);
  const [gmailConnected, setGmailConnected] = React.useState(false);

  // Drag + resize state
  const [pos, setPos] = React.useState(() => ({ x: Math.max(0, (window.innerWidth - 640) / 2), y: Math.max(0, (window.innerHeight - 600) / 2) }));
  const [size, setSize] = React.useState({ w: 640, h: 600 });
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
    const add = (email, label) => {
      if (!email || seen.has(email.toLowerCase())) return;
      seen.add(email.toLowerCase()); pool.push({ email, label });
    };
    (students || []).forEach(s => (s.parents || []).forEach(p => { if (p.email) add(p.email, `${p.name || ""} (${s.name})`); }));
    (teachers || []).forEach(t => { if (t.email) add(t.email, t.name || t.email); });
    (contacts || []).forEach(c => { if (c.email) add(c.email, c.name || c.email); });
    schools.forEach(s => { if (s.senderEmail) add(s.senderEmail, s.name); });
    return pool;
  }, [students, teachers, contacts, schools]);

  const [allTemplates] = React.useState(() => getUserTemplates());
  const triggerId = initial.triggerId || null;
  const mergeCtx = initial.mergeCtx || null;
  const triggerTemplates = allTemplates.filter(t => t.triggerId === triggerId);
  const [selectedTemplateId, setSelectedTemplateId] = React.useState(() =>
    triggerTemplates.length > 0 ? triggerTemplates[0].id : null
  );
  const selectedTemplate = allTemplates.find(t => t.id === selectedTemplateId) || null;

  const applyTemplate = React.useCallback((tmpl) => {
    if (!tmpl) return;
    const resolvedSubject = mergeCtx ? applyMergeCtx(tmpl.subject, mergeCtx) : tmpl.subject;
    const resolvedBody = mergeCtx ? applyMergeCtx(tmpl.body, mergeCtx) : tmpl.body;
    setSubject(resolvedSubject || "");
    if (bodyRef.current) bodyRef.current.innerHTML = (resolvedBody || "").replace(/\n/g, "<br>");
  }, [mergeCtx]);

  React.useEffect(() => {
    if (window.electronAPI?.gmailGetStatus) {
      window.electronAPI.gmailGetStatus().then(s => setGmailConnected(s.connected));
    }
  }, []);

  React.useEffect(() => {
    if (bodyRef.current) {
      if (selectedTemplate && mergeCtx) {
        bodyRef.current.innerHTML = (applyMergeCtx(selectedTemplate.body, mergeCtx) || "").replace(/\n/g, "<br>");
        setSubject(applyMergeCtx(selectedTemplate.subject, mergeCtx) || "");
      } else if (selectedTemplate) {
        bodyRef.current.innerHTML = (selectedTemplate.body || "").replace(/\n/g, "<br>");
        setSubject(selectedTemplate.subject || "");
      } else if (initial.body) {
        bodyRef.current.innerHTML = initial.body.replace(/\n/g, "<br>");
      }
    }
  }, []); // eslint-disable-line

  const saveDraft = React.useCallback(() => {}, [subject, to]);

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
    setToSuggestions(emailPool.filter(p => !to.includes(p.email) && (p.email.toLowerCase().includes(q) || (p.label || "").toLowerCase().includes(q))).slice(0, 6));
  };

  const execFormat = (cmd, value) => { bodyRef.current.focus(); document.execCommand(cmd, false, value); };
  const insertLink = () => { const url = window.prompt("URL:"); if (url) execFormat("createLink", url); };

  const handleTemplateChange = (tmplId) => {
    setSelectedTemplateId(tmplId || null);
    const tmpl = allTemplates.find(t => t.id === tmplId);
    if (tmpl) applyTemplate(tmpl);
    else { setSubject(initial.subject || ""); if (bodyRef.current) bodyRef.current.innerHTML = (initial.body || "").replace(/\n/g, "<br>"); }
  };

  const canSend = subject.trim().length > 0;
  const batchTo = initial.batchTo || null;

  const handleSend = async () => {
    if (!batchTo && to.length === 0) { notify("Add at least one recipient", "warning"); return; }
    if (!canSend) return;
    if (!gmailConnected) { notify("Connect Gmail first in Settings → App", "warning"); return; }
    const bodyHtml = bodyRef.current.innerHTML;
    if (batchTo && batchTo.length > 0) {
      const batchItems = batchTo.map(item => {
        const addr = typeof item === "string" ? item : item.addr;
        const ctx = typeof item === "string" ? {} : (item.ctx || {});
        return { to: [addr], from: from || undefined, subject: applyMergeCtx(subject, ctx), bodyHtml: applyMergeCtx(bodyHtml, ctx), label: ctx.parent_name || addr };
      });
      if (window._autoSendBatch) window._autoSendBatch(batchItems);
      notify(`Queued ${batchTo.length} emails to send ✓`);
      onClose();
      return;
    }
    setSending(true);
    try {
      const result = await window.electronAPI.gmailSend({ to, from: from || undefined, cc: cc.length > 0 ? cc : undefined, bcc: bcc.length > 0 ? bcc : undefined, subject, bodyHtml, attachments: attachments.length > 0 ? attachments : undefined });
      if (result.ok) { try { localStorage.removeItem("mt-compose-draft"); } catch {} notify("Email sent ✓"); onClose(); }
      else notify("Send failed: " + result.error, "danger");
    } catch(e) { notify("Send error: " + e.message, "danger"); }
    finally { setSending(false); }
  };

  const triggerLabel = triggerId ? (TRIGGER_MAP[triggerId]?.label || null) : null;

  return (
    <div style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 10000, width: size.w, height: size.h, minWidth: MIN_W, minHeight: MIN_H }}
      ref={modalRef}
      onDragOver={e => { if (e.dataTransfer.types.includes("Files") || isInternalDrag()) { e.preventDefault(); setFileDragOver(true); } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFileDragOver(false); }}
      onDrop={handleFileDrop}>

      {[
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

      <div style={{ background: fileDragOver ? `${colors.accentLight}` : colors.white, borderRadius: 14, width: "100%", height: "100%", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.35)", overflow: "hidden", outline: fileDragOver ? `2px dashed ${colors.accent}` : "none", transition: "outline 0.1s, background 0.1s" }}>

        <div onMouseDown={onHeaderMouseDown}
          style={{ background: colors.sidebarActive, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "grab", userSelect: "none", flexShrink: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#fff" }}>
            ✉ New Email{queueRemaining > 0 ? ` (1 of ${queueRemaining + 1})` : ""}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {!gmailConnected && <span style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", fontStyle: "italic" }}>⚠ Gmail not connected</span>}
            <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.7)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 2px" }}>✕</button>
          </div>
        </div>

        <div style={{ padding: "16px 20px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>

          {/* Template selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.border}` }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: colors.textLight, textTransform: "uppercase", letterSpacing: 0.5, flexShrink: 0 }}>📋 Template</span>
            <select value={selectedTemplateId || ""} onChange={e => handleTemplateChange(e.target.value)}
              style={{ flex: 1, padding: "5px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", color: colors.text, background: colors.white }}>
              <option value="">— No template —</option>
              {triggerTemplates.length > 0 && <optgroup label={triggerLabel || "Matching templates"}>{triggerTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>}
              {allTemplates.filter(t => t.triggerId !== triggerId).length > 0 && <optgroup label="Other templates">{allTemplates.filter(t => t.triggerId !== triggerId).map(t => <option key={t.id} value={t.id}>{t.name} ({TRIGGER_MAP[t.triggerId]?.label || t.triggerId})</option>)}</optgroup>}
              {allTemplates.length === 0 && <option value="" disabled>No templates yet — create in Contacts → Templates</option>}
            </select>
          </div>

          {/* From */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, minWidth: 60, textAlign: "right" }}>From</label>
            <select value={from} onChange={e => setFrom(e.target.value)}
              style={{ flex: 1, padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: colors.white, color: colors.text }}>
              <option value="">Default Gmail account</option>
              {fromOptions.filter(Boolean).map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>

          {/* To chips with autocomplete */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, minWidth: 60, textAlign: "right", paddingTop: 8 }}>To</label>
            <div style={{ flex: 1, position: "relative" }}>
              {batchTo ? (
                <div style={{ border: `1px solid ${colors.sidebarActive}40`, borderRadius: 8, padding: "8px 12px", background: colors.blueLight, fontSize: 12, color: colors.sidebarActive, fontWeight: 600 }}>
                  <div>⚡ Will send individually to {batchTo.length} recipients when you click Send</div>
                  <div style={{ fontWeight: 400, marginTop: 3, color: colors.textLight }}>Use merge fields: <code style={{ background: "rgba(0,0,0,0.06)", borderRadius: 3, padding: "1px 4px" }}>{"{{parent_name}}"}</code> <code style={{ background: "rgba(0,0,0,0.06)", borderRadius: 3, padding: "1px 4px" }}>{"{{student_name}}"}</code> <code style={{ background: "rgba(0,0,0,0.06)", borderRadius: 3, padding: "1px 4px" }}>{"{{school_name}}"}</code></div>
                </div>
              ) : (<>
              <div style={{ border: `1px solid ${colors.inputBorder}`, borderRadius: 8, padding: "6px 8px", display: "flex", flexWrap: "wrap", gap: 5, minHeight: 38, cursor: "text" }}
                onClick={() => document.getElementById("compose-to-input")?.focus()}>
                {to.map(email => (
                  <span key={email} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: colors.accentLight, borderRadius: 20, fontSize: 12, color: colors.accentDark, fontWeight: 500 }}>
                    {email}
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
                  style={{ border: "none", outline: "none", fontSize: 13, fontFamily: "inherit", flex: 1, minWidth: 120, background: "transparent" }} />
              </div>
              {toSuggestions.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100, background: colors.white, border: `1px solid ${colors.inputBorder}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", marginTop: 2, overflow: "hidden" }}>
                  {toSuggestions.map((s, i) => (
                    <div key={s.email} onMouseDown={() => addRecipient(s.email)}
                      style={{ padding: "7px 12px", cursor: "pointer", background: i === suggestionIdx ? colors.accentLight : colors.white, display: "flex", flexDirection: "column", gap: 1 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: colors.text }}>{s.email}</span>
                      {s.label && s.label !== s.email && <span style={{ fontSize: 11, color: colors.textMuted }}>{s.label}</span>}
                    </div>
                  ))}
                </div>
              )}
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
              <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 4, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, minHeight: 36, alignItems: "center", background: "transparent" }}>
                {cc.map(email => (
                  <span key={email} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: colors.accentLight, borderRadius: 20, fontSize: 12, color: colors.accentDark, fontWeight: 500 }}>
                    {email}
                    <button onClick={() => setCc(prev => prev.filter(e => e !== email))} style={{ background: "none", border: "none", cursor: "pointer", color: colors.accentDark, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                  </span>
                ))}
                <input value={ccInput} onChange={e => setCcInput(e.target.value)}
                  onKeyDown={e => {
                    if ((e.key === "Enter" || e.key === "," || e.key === "Tab") && ccInput.trim()) { e.preventDefault(); const v = ccInput.trim().replace(/,$/, ""); if (v && !cc.includes(v)) setCc(prev => [...prev, v]); setCcInput(""); }
                    if (e.key === "Backspace" && !ccInput && cc.length > 0) setCc(prev => prev.slice(0, -1));
                  }}
                  onBlur={() => { if (ccInput.trim()) { setCc(prev => prev.includes(ccInput.trim()) ? prev : [...prev, ccInput.trim()]); setCcInput(""); }}}
                  placeholder={cc.length === 0 ? "Add CC\u2026" : ""}
                  style={{ flex: 1, minWidth: 120, border: "none", outline: "none", fontSize: 13, fontFamily: "inherit", color: colors.text, background: "transparent", padding: "2px 2px" }} />
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
              <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 4, padding: "6px 8px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, minHeight: 36, alignItems: "center", background: "transparent" }}>
                {bcc.map(email => (
                  <span key={email} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: colors.accentLight, borderRadius: 20, fontSize: 12, color: colors.accentDark, fontWeight: 500 }}>
                    {email}
                    <button onClick={() => setBcc(prev => prev.filter(e => e !== email))} style={{ background: "none", border: "none", cursor: "pointer", color: colors.accentDark, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                  </span>
                ))}
                <input value={bccInput} onChange={e => setBccInput(e.target.value)}
                  onKeyDown={e => {
                    if ((e.key === "Enter" || e.key === "," || e.key === "Tab") && bccInput.trim()) { e.preventDefault(); const v = bccInput.trim().replace(/,$/, ""); if (v && !bcc.includes(v)) setBcc(prev => [...prev, v]); setBccInput(""); }
                    if (e.key === "Backspace" && !bccInput && bcc.length > 0) setBcc(prev => prev.slice(0, -1));
                  }}
                  onBlur={() => { if (bccInput.trim()) { setBcc(prev => prev.includes(bccInput.trim()) ? prev : [...prev, bccInput.trim()]); setBccInput(""); }}}
                  placeholder={bcc.length === 0 ? "Add BCC\u2026" : ""}
                  style={{ flex: 1, minWidth: 120, border: "none", outline: "none", fontSize: 13, fontFamily: "inherit", color: colors.text, background: "transparent", padding: "2px 2px" }} />
              </div>
            </div>
          )}

          {/* Subject */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: colors.textLight, minWidth: 60, textAlign: "right" }}>Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)}
              style={{ flex: 1, padding: "7px 10px", border: `1px solid ${colors.inputBorder}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", boxSizing: "border-box", background: "transparent" }} />
          </div>

          {/* Attachments */}
          {attachments.filter(a => a.mimeType !== "image/png").length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 12px", background: colors.bg, borderRadius: 8, border: `1px solid ${colors.border}` }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, alignSelf: "center", marginRight: 4 }}>📎</span>
              {attachments.filter(a => a.mimeType !== "image/png").map((att, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, fontSize: 12, color: colors.text }}>
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
                style={{ ...s, padding: "3px 8px", border: `1px solid ${colors.border}`, borderRadius: 5, background: colors.white, cursor: "pointer", fontSize: 13, fontFamily: "inherit", color: colors.text }}>{label}</button>
            ))}
            <button onMouseDown={e => { e.preventDefault(); insertLink(); }}
              style={{ padding: "3px 8px", border: `1px solid ${colors.border}`, borderRadius: 5, background: colors.white, cursor: "pointer", fontSize: 12, fontFamily: "inherit", color: colors.sidebarActive }}>🔗 Link</button>
            <button onMouseDown={e => { e.preventDefault(); execFormat("removeFormat"); }}
              style={{ padding: "3px 8px", border: `1px solid ${colors.border}`, borderRadius: 5, background: colors.white, cursor: "pointer", fontSize: 12, fontFamily: "inherit", color: colors.textMuted }}>Clear format</button>
          </div>

          {/* Body */}
          <div ref={bodyRef} contentEditable suppressContentEditableWarning onInput={saveDraft}
            style={{ flex: 1, minHeight: 200, border: `1px solid ${colors.inputBorder}`, borderRadius: 8, padding: "10px 12px", fontSize: 13, fontFamily: "inherit", color: colors.text, outline: "none", lineHeight: 1.6, overflowY: "auto" }} />

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

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${colors.border}`, display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "center", flexShrink: 0 }}>
          {queueRemaining > 0 && onCancelAll && (
            <button onClick={onCancelAll} style={{ padding: "8px 14px", border: `1px solid ${colors.danger}40`, borderRadius: 8, background: "#FEF2F2", fontSize: 13, fontFamily: "inherit", cursor: "pointer", color: colors.danger, marginRight: "auto" }}>
              Cancel all ({queueRemaining + 1})
            </button>
          )}
          <button onClick={onClose} style={{ padding: "8px 18px", border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.white, fontSize: 13, fontFamily: "inherit", cursor: "pointer", color: colors.textLight }}>
            {queueRemaining > 0 ? "Skip" : "Cancel"}
          </button>
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
          <button onClick={async () => {
            if (window.electronAPI?.showOpenDialog) {
              const defaultPath = localStorage.getItem(STORAGE_KEYS.timetableFolder) || localStorage.getItem(STORAGE_KEYS.backupFolder) || undefined;
              try {
                const result = await window.electronAPI.showOpenDialog({ title: "Attach file", defaultPath, properties: ["openFile", "multiSelections"], filters: [{ name: "Documents", extensions: ["pdf","html","xlsx","csv","png","jpg","jpeg","docx"] }, { name: "All Files", extensions: ["*"] }] });
                if (!result?.canceled && result?.filePaths?.length > 0) {
                  for (const fp of result.filePaths) {
                    const filename = fp.split("/").pop() || fp.split("\\").pop() || fp;
                    const ext = filename.split(".").pop().toLowerCase();
                    const mimeMap = { pdf:"application/pdf",html:"text/html",xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",csv:"text/csv",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
                    try { const data = await window.electronAPI.readFileBase64(fp); setAttachments(prev => [...prev, { filename, contentBase64: data, mimeType: mimeMap[ext] || "application/octet-stream" }]); }
                    catch (err) { notify("Could not read file: " + err.message, "danger"); }
                  }
                }
              } catch { document.getElementById("compose-attach-input")?.click(); }
            } else { document.getElementById("compose-attach-input")?.click(); }
          }} style={{ padding: "8px 18px", border: "none", borderRadius: 8, background: colors.accent, color: "#fff", fontSize: 13, fontFamily: "inherit", fontWeight: 600, cursor: "pointer" }}>
            Attach
          </button>
          <button onClick={handleSend} disabled={sending || !gmailConnected || !canSend}
            title={!canSend ? "Enter a subject before sending" : ""}
            style={{ padding: "8px 22px", border: "none", borderRadius: 8, fontSize: 13, fontFamily: "inherit", fontWeight: 600, transition: "background 0.15s, color 0.15s",
              background: !canSend ? colors.borderLight : gmailConnected ? colors.sidebarActive : colors.border,
              color: !canSend ? colors.textMuted : gmailConnected ? "#fff" : colors.textMuted,
              cursor: sending || !gmailConnected || !canSend ? "not-allowed" : "pointer" }}>
            {sending ? "Sending…" : !canSend ? "No Subject" : queueRemaining > 0 ? "Send & Next" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
