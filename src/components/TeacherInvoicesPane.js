// ============================================================
// TeacherInvoicesPane — the Documents > Invoices folder's content: sent
// teacher invoices, newest first, unseen ones marked New. Clicking one fetches
// its PDF into PdfPreviewModal and marks it seen; a failed fetch shows a plain
// message and marks nothing. Reads/writes teacher_invoices only (never the
// documents table, mt-documents or document_folder_overrides).
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { FileText, Loader } from "lucide-react";
import PdfPreviewModal from "./PdfPreviewModal";
import { shapeInvoiceRows } from "../data/teacherInvoices";
import { subscribeSentInvoices, refreshSentInvoices, fetchInvoicePdf, markInvoiceSeen } from "../utils/teacherInvoicesDB";

export function TeacherInvoicesPane({ teachers, colors }) {
  const [rows, setRows] = useState(null);         // raw sent rows, null until loaded
  const [loadError, setLoadError] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const [openError, setOpenError] = useState(null);
  const [pdf, setPdf] = useState(null);           // bare base64 | null
  const [hovered, setHovered] = useState(null);

  // The Documents page refreshes the shared copy on mount; this just listens.
  useEffect(() => subscribeSentInvoices(setRows), []);

  const retry = () => {
    setLoadError(null);
    refreshSentInvoices().catch(e => setLoadError(e.message || "Unknown error"));
  };
  // A load that failed before we subscribed leaves rows null — try once here.
  useEffect(() => { if (rows === null) retry(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const shaped = useMemo(() => shapeInvoiceRows(rows, teachers), [rows, teachers]);
  const newCount = shaped.filter(r => r.isNew).length;

  const open = async (r) => {
    if (openingId) return;
    setOpeningId(r.id); setOpenError(null);
    let b64;
    try {
      b64 = await fetchInvoicePdf(r.id);
    } catch (e) {
      setOpenError(`Couldn't open ${r.teacherName}'s invoice: ${e.message || "unknown error"}`);
      setOpeningId(null);
      return;
    }
    setPdf(b64);
    setOpeningId(null);
    if (r.isNew) {
      markInvoiceSeen(r.id).catch(e => setOpenError(`Opened, but couldn't mark it as seen: ${e.message || "unknown error"}`));
    }
  };

  const muted = { fontSize: 13, color: colors.textMuted, padding: "32px 20px", textAlign: "center" };

  return (
    <div style={{ gridColumn: "2 / 4", minWidth: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: `1px solid ${colors.borderLight}` }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: colors.text }}>Teacher invoices</span>
        {newCount > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: colors.accent }}>{newCount} new</span>}
      </div>
      {openError && (
        <div style={{ margin: "10px 14px 0", padding: "8px 12px", borderRadius: 8, fontSize: 12, background: colors.redLight, color: colors.danger }}>{openError}</div>
      )}
      {loadError ? (
        <div style={muted}>
          Couldn't load invoices: {loadError}
          <div><button onClick={retry} style={{ marginTop: 10, border: "1px solid " + colors.border, background: colors.cardBg, color: colors.text, borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>Try again</button></div>
        </div>
      ) : rows === null ? (
        <div style={muted}>Loading invoices…</div>
      ) : shaped.length === 0 ? (
        <div style={{ ...muted, fontStyle: "italic" }}>No invoices yet</div>
      ) : shaped.map(r => (
        <div key={r.id} onClick={() => open(r)}
          onMouseEnter={() => setHovered(r.id)} onMouseLeave={() => setHovered(null)}
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", cursor: openingId ? "progress" : "pointer", borderBottom: "1px solid " + colors.borderLight, background: hovered === r.id ? colors.blueLight : colors.cardBg }}>
          {openingId === r.id
            ? <Loader size={17} style={{ flexShrink: 0, color: colors.textMuted }} />
            : <FileText size={17} style={{ flexShrink: 0, color: r.isNew ? colors.accent : colors.textMuted }} />}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: r.isNew ? 700 : 600, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.teacherName}{r.number ? <span style={{ fontWeight: 500, color: colors.textMuted }}> · {r.number}</span> : null}
            </div>
            <div style={{ fontSize: 11, color: colors.textMuted }}>{[r.periodLabel, r.sentLabel && `sent ${r.sentLabel}`].filter(Boolean).join(" · ")}</div>
          </div>
          {r.isNew && <span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700, background: colors.accent, color: "#fff" }}>New</span>}
          <span style={{ fontSize: 13, fontWeight: 600, color: colors.text, minWidth: 80, textAlign: "right" }}>{r.totalLabel}</span>
        </div>
      ))}
      {pdf && <PdfPreviewModal base64={pdf} onClose={() => setPdf(null)} />}
    </div>
  );
}
