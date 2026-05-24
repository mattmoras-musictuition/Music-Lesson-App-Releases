// ============================================================
// LibraryPicker.js — modal for picking a single Resource Library
// item by reference.
//
// Mirrors the Resources tab's filter bar (instrument / type /
// skill level / school / uploaded-by / source) and name+description
// search, presented for single-item selection. Opens with NO
// filters applied (the full library). Self-contained — loads its
// own resources / taxonomies / schools — so other surfaces (e.g.
// the Bands picker, cluster 5) can reuse it without a rewrite.
// ============================================================

import React, { useState, useEffect, useMemo } from "react";
import { X, Library, FileText, Link2 } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { supabase } from "../supabaseClient";
import { loadResources, fetchResourceTaxonomies } from "../utils/resourcesDB";
import { FilterDropdown } from "./FilterDropdown";

const SOURCE_OPTIONS = [
  { value: "direct",       label: "Direct upload" },
  { value: "student_note", label: "From Student Notes" },
];

export function LibraryPicker({ onSelect, onClose, title = "Attach from library", initialSearch = "" }) {
  const { colors } = useTheme();
  const [resources, setResources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tax, setTax] = useState({ resourceTypes: [], skillLevels: [], instruments: [] });
  const [schools, setSchools] = useState([]);

  const [search, setSearch] = useState(initialSearch);
  const [fInstrument, setFInstrument] = useState([]);
  const [fType, setFType] = useState([]);
  const [fSkill, setFSkill] = useState([]);
  const [fSchool, setFSchool] = useState([]);
  const [fUploadedBy, setFUploadedBy] = useState([]);
  const [fSource, setFSource] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const rows = await loadResources();
        setResources(rows);
      } catch (e) {
        console.error("Library load failed:", e);
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
    fetchResourceTaxonomies().then(setTax);
    supabase.from("schools").select("id, name").order("name").then(({ data }) => setSchools(data || []));
  }, []);

  const instrumentOptions = useMemo(() => tax.instruments.map(v => ({ value: v, label: v })), [tax.instruments]);
  const typeOptions       = useMemo(() => tax.resourceTypes.map(v => ({ value: v, label: v })), [tax.resourceTypes]);
  const skillOptions      = useMemo(() => tax.skillLevels.map(v => ({ value: v, label: v })), [tax.skillLevels]);
  const schoolOptions     = useMemo(() => schools.map(s => ({ value: s.id, label: s.name })), [schools]);
  const uploadedByOptions = useMemo(() => {
    const set = new Set();
    for (const r of resources) if (r.added_by_name) set.add(r.added_by_name);
    return [...set].sort().map(n => ({ value: n, label: n }));
  }, [resources]);
  const schoolName = (id) => (schools.find(s => s.id === id)?.name) || "";

  const anyFilter = !!(fInstrument.length || fType.length || fSkill.length || fSchool.length || fUploadedBy.length || fSource.length);
  const clearFilters = () => { setFInstrument([]); setFType([]); setFSkill([]); setFSchool([]); setFUploadedBy([]); setFSource([]); };

  const filtered = useMemo(() => resources.filter(r => {
    if (fInstrument.length && !fInstrument.includes(r.instrument))     return false;
    if (fType.length       && !fType.includes(r.category))             return false;
    if (fSkill.length      && !fSkill.includes(r.skill_level))         return false;
    if (fSchool.length     && !fSchool.includes(r.school_id))          return false;
    if (fUploadedBy.length && !fUploadedBy.includes(r.added_by_name))  return false;
    if (fSource.length     && !fSource.includes(r.source || "direct")) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      if (!(r.label || "").toLowerCase().includes(q) && !(r.description || "").toLowerCase().includes(q)) return false;
    }
    return true;
  }), [resources, fInstrument, fType, fSkill, fSchool, fUploadedBy, fSource, search]);

  const inputStyle = {
    width: "100%", padding: "8px 32px 8px 12px", border: "1px solid " + colors.inputBorder,
    borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
    background: colors.bg, color: colors.text, outline: "none",
  };

  return (
    <div onMouseDown={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 9990, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onMouseDown={e => e.stopPropagation()}
        style={{ background: colors.cardBg, border: "1px solid " + colors.border, borderRadius: 12, width: 720, maxWidth: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid " + colors.border }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: colors.text, display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Library size={16} /> {title}
          </div>
          <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", color: colors.textMuted, display: "inline-flex" }}><X size={18} /></button>
        </div>

        {/* Search + filters */}
        <div style={{ padding: "12px 18px", borderBottom: "1px solid " + colors.border }}>
          <div style={{ position: "relative", marginBottom: 10 }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name…" style={inputStyle} />
            {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: colors.textMuted, cursor: "pointer", display: "inline-flex" }}><X size={14} /></button>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <FilterDropdown label="Instrument"  options={instrumentOptions} selected={fInstrument} onChange={setFInstrument} colors={colors} />
            <FilterDropdown label="Type"        options={typeOptions}       selected={fType}       onChange={setFType}       colors={colors} />
            <FilterDropdown label="Skill level" options={skillOptions}      selected={fSkill}      onChange={setFSkill}      colors={colors} />
            <FilterDropdown label="School"      options={schoolOptions}     selected={fSchool}     onChange={setFSchool}     colors={colors} />
            <FilterDropdown label="Uploaded by" options={uploadedByOptions} selected={fUploadedBy} onChange={setFUploadedBy} colors={colors} />
            <FilterDropdown label="Source"      options={SOURCE_OPTIONS}    selected={fSource}     onChange={setFSource}     colors={colors} />
            {anyFilter && (
              <button onClick={clearFilters} style={{ padding: "7px 12px", border: "1px solid " + colors.border, borderRadius: 8, background: colors.cardBg, color: colors.textMuted, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
                <X size={12} /> Clear filters
              </button>
            )}
          </div>
        </div>

        {/* List */}
        <div style={{ overflowY: "auto", padding: "8px 10px", flex: 1 }}>
          {loading ? (
            <div style={{ padding: "40px 12px", textAlign: "center", color: colors.textMuted, fontSize: 13 }}>Loading library…</div>
          ) : error ? (
            <div style={{ padding: "40px 12px", textAlign: "center", color: colors.danger || "#EF4444", fontSize: 13 }}>Couldn't load the library.</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "40px 12px", textAlign: "center", color: colors.textMuted, fontSize: 13, fontStyle: "italic" }}>
              {resources.length === 0 ? "The library is empty." : "No resources match the current filters."}
            </div>
          ) : (
            filtered.map(r => {
              const isFile = !!r.file_url;
              const meta = [r.category, r.instrument, r.skill_level, schoolName(r.school_id), r.added_by_name].filter(Boolean).join(" · ");
              return (
                <button key={r.id} onClick={() => { onSelect(r); onClose(); }}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", padding: "9px 10px", border: "none", borderRadius: 8, background: "none", cursor: "pointer", fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.bg}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <span style={{ flexShrink: 0, color: colors.textMuted, display: "flex" }}>{isFile ? <FileText size={16} /> : <Link2 size={16} />}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label || "Untitled"}</span>
                    {meta && <span style={{ display: "block", fontSize: 11, color: colors.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meta}</span>}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
