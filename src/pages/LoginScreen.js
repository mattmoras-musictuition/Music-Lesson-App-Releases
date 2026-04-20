// ============================================================
// LoginScreen.js — Supabase Auth login page
// Shown before the main app if there is no active session.
// Uses email + password via supabase.auth.signInWithPassword().
// Reads dark mode from localStorage so it matches the user's
// last preference without needing ThemeContext.
// ============================================================

import React, { useState, useEffect } from "react";
import { supabase } from "../supabaseClient";

export function LoginScreen() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [showPw, setShowPw]     = useState(false);

  // Read dark mode preference from localStorage (same key the main app uses)
  const darkMode = (() => {
    try { return localStorage.getItem("mt-dark-mode") === "true"; } catch { return false; }
  })();

  // Colours — mirrors the relevant tokens from constants.js light/dark palettes
  const c = darkMode
    ? {
        bg:          "#16141C",
        card:        "#1E1C24",
        border:      "#3D3942",
        text:        "#E8E3DF",
        textLight:   "#9B95A3",
        accent:      "#7C6FAD",
        input:       "#16141C",
        inputBorder: "#3D3942",
        danger:      "#C45454",
        btnText:     "#FFFFFF",
      }
    : {
        bg:          "#F4F0EB",
        card:        "#FFFFFF",
        border:      "#E5E0D8",
        text:        "#1A1A1A",
        textLight:   "#6B6680",
        accent:      "#7C6FAD",
        input:       "#FFFFFF",
        inputBorder: "#D8D3CC",
        danger:      "#C45454",
        btnText:     "#FFFFFF",
      };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) { setError("Please enter your email and password."); return; }
    setError("");
    setLoading(true);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError) {
        // Supabase returns "Invalid login credentials" for wrong email or password
        setError(authError.message === "Invalid login credentials"
          ? "Incorrect email or password. Please try again."
          : authError.message);
      }
      // On success, onAuthStateChange in App.js fires and sets the session —
      // no navigation needed here.
    } catch (err) {
      setError("Something went wrong. Please check your internet connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    fontSize: 14,
    fontFamily: "'DM Sans', sans-serif",
    border: `1.5px solid ${c.inputBorder}`,
    borderRadius: 8,
    background: c.input,
    color: c.text,
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.15s",
  };

  return (
    <>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap"
        rel="stylesheet"
      />
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: c.bg,
        fontFamily: "'DM Sans', sans-serif",
        color: c.text,
        WebkitAppRegion: "drag",
      }}>
        <div style={{
          width: 360,
          background: c.card,
          border: `1px solid ${c.border}`,
          borderRadius: 16,
          padding: "36px 32px 32px",
          boxShadow: darkMode
            ? "0 8px 32px rgba(0,0,0,0.45)"
            : "0 8px 32px rgba(0,0,0,0.08)",
          WebkitAppRegion: "no-drag",
        }}>

          {/* Logo / header */}
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{
              background: c.accent,
              borderRadius: 10, padding: "12px 20px",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              marginBottom: 16,
              boxShadow: `0 4px 16px ${c.accent}55`,
            }}>
              <img
                src={process.env.PUBLIC_URL + "/logo.png"}
                alt="Matt Moras Music Tuition"
                style={{ width: 180, height: "auto", display: "block", filter: "brightness(0) invert(1)" }}
                onError={e => { e.target.style.display = "none"; }}
              />
            </div>
            <div style={{
              display: "block", fontSize: 11, fontWeight: 700,
              letterSpacing: "0.08em", textTransform: "uppercase",
              color: c.accent, background: c.accent + "18",
              borderRadius: 20, padding: "3px 10px",
              marginTop: 4,
            }}>
              Admin Portal
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 14 }}>

            {/* Email */}
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: c.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                autoFocus
                style={inputStyle}
                onFocus={e => e.target.style.borderColor = c.accent}
                onBlur={e => e.target.style.borderColor = c.inputBorder}
              />
            </div>

            {/* Password */}
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: c.textLight, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Password
              </label>
              <div style={{ position: "relative" }}>
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  style={{ ...inputStyle, paddingRight: 40 }}
                  onFocus={e => e.target.style.borderColor = c.accent}
                  onBlur={e => e.target.style.borderColor = c.inputBorder}
                />
                {/* Show/hide toggle */}
                <button
                  type="button"
                  onClick={() => setShowPw(p => !p)}
                  style={{
                    position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                    background: "none", border: "none", cursor: "pointer",
                    color: c.textLight, padding: 4, display: "flex", alignItems: "center",
                  }}
                  tabIndex={-1}
                >
                  {showPw ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Error message */}
            {error && (
              <div style={{
                background: darkMode ? "#3A1C1C" : "#FEF2F2",
                border: `1px solid ${c.danger}44`,
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 13,
                color: c.danger,
                lineHeight: 1.4,
              }}>
                {error}
              </div>
            )}

            {/* Submit button */}
            <button
              type="submit"
              disabled={loading}
              style={{
                width: "100%",
                padding: "11px 0",
                fontSize: 14,
                fontWeight: 600,
                fontFamily: "'DM Sans', sans-serif",
                background: loading ? c.accent + "88" : c.accent,
                color: c.btnText,
                border: "none",
                borderRadius: 8,
                cursor: loading ? "not-allowed" : "pointer",
                transition: "all 0.15s",
                marginTop: 2,
                letterSpacing: "0.01em",
              }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.opacity = "0.88"; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>

          </form>

        </div>
      </div>
    </>
  );
}
