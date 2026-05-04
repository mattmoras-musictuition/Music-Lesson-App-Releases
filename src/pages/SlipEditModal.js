// ============================================================
// SlipEditModal — admin edit form for an unsubmitted day-slip
// ============================================================
//
// Mirrors the teacher mobile app's "Teaching Days" modal layout.
// Validation: Description required, plus either Amount filled
// OR Start+End times both filled. Status preservation is enforced
// by slipsDB.updateSlip's writable-fields whitelist (slip_type
// and invoice_id are NOT writable).
// ============================================================

import React, { useState } from "react";
import { Pencil } from "lucide-react";
import { Btn, Input } from "../components/ui/SharedUI";
import { updateSlip } from "../data/slipsDB";

export function SlipEditModal({ slip, colors, onClose, onSaved }) {
  const [description, setDescription] = useState(slip.description || "");
  const [slipDate, setSlipDate] = useState(slip.slip_date || "");
  const [amount, setAmount] = useState(slip.amount != null ? String(slip.amount) : "");
  const [startTime, setStartTime] = useState(slip.start_time || "");
  const [endTime, setEndTime] = useState(slip.end_time || "");
  const [breakMinutes, setBreakMinutes] = useState(
    slip.break_minutes != null ? String(slip.break_minutes) : "0"
  );
  const [notes, setNotes] = useState(slip.notes || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const hasAmount = amount.trim() !== "";
  const hasTimes = startTime.trim() !== "" && endTime.trim() !== "";
  const isValid = description.trim() !== "" && (hasAmount || hasTimes);

  async function handleSave() {
    if (!isValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        description: description.trim(),
        slip_date: slipDate || null,
        amount: hasAmount ? parseFloat(amount) : null,
        start_time: startTime.trim() || null,
        end_time: endTime.trim() || null,
        break_minutes: parseInt(breakMinutes, 10) || 0,
        notes: notes.trim() || null,
      };
      const { data, error: updateError, payload: writtenPayload } = await updateSlip(slip.id, payload);
      if (updateError) throw updateError;
      // Production returns the updated row; dev's Proxy short-circuits to data: null.
      // Fall back to optimistic local merge so the parent can refresh state either way.
      const updatedSlip = data ?? { ...slip, ...writtenPayload };
      onSaved(updatedSlip);
      onClose();
    } catch (e) {
      console.error("SlipEditModal save error:", e);
      setError(e.message || "Failed to save slip");
    } finally {
      setSaving(false);
    }
  }

  const labelStyle = {
    display: "block",
    fontSize: 11,
    fontWeight: 600,
    color: colors.textMuted,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };
  const hintStyle = {
    fontSize: 10,
    fontWeight: 400,
    color: colors.textMuted,
    textTransform: "none",
    letterSpacing: 0,
    marginLeft: 6,
  };

  return (
    <>
      <div
        onClick={() => !saving && onClose()}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 10000 }}
      />
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%,-50%)",
          zIndex: 10001,
          background: colors.cardBg,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          boxShadow: "0 8px 32px rgba(0,0,0,0.22)",
          width: 420,
          maxWidth: "90vw",
          padding: 24,
          fontFamily: "inherit",
        }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: 15,
            color: colors.text,
            marginBottom: 14,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Pencil size={16} color={colors.accent} />
          Edit slip
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={labelStyle}>
              Description <span style={{ color: colors.danger }}>*</span>
            </label>
            <Input value={description} onChange={setDescription} />
          </div>

          <div>
            <label style={labelStyle}>Date</label>
            <Input type="date" value={slipDate} onChange={setSlipDate} />
          </div>

          <div>
            <label style={labelStyle}>
              Amount ($)<span style={hintStyle}>Overrides hours × rate</span>
            </label>
            <Input
              type="number"
              step="0.01"
              value={amount}
              onChange={setAmount}
            />
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Start time</label>
              <Input type="time" value={startTime} onChange={setStartTime} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>End time</label>
              <Input type="time" value={endTime} onChange={setEndTime} />
            </div>
          </div>

          <div>
            <label style={labelStyle}>Break (mins)</label>
            <Input
              type="number"
              min="0"
              value={breakMinutes}
              onChange={setBreakMinutes}
            />
          </div>

          <div>
            <label style={labelStyle}>Notes</label>
            <Input value={notes} onChange={setNotes} />
          </div>
        </div>

        {error && (
          <div style={{ color: colors.danger, fontSize: 12, marginTop: 12 }}>{error}</div>
        )}

        <div
          style={{
            fontSize: 11,
            color: colors.textMuted,
            marginTop: 14,
            minHeight: 16,
          }}
        >
          {!isValid && "Description required, plus either an Amount or Start & End times."}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }}>
          <Btn variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={handleSave} disabled={!isValid || saving}>
            {saving ? "Saving…" : "Save"}
          </Btn>
        </div>
      </div>
    </>
  );
}
