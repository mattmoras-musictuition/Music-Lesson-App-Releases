// ============================================================
// ThemeContext.js — Provides the active colour palette to all
// components so dark mode works without prop-drilling.
//
// Usage in any page/component:
//   import { useTheme } from "../context/ThemeContext";
//   const { colors } = useTheme();
//
// That's it — colors will automatically reflect light or dark
// mode based on the toggle in Settings or Cmd+Shift+D.
// ============================================================

import React, { createContext, useContext } from "react";

const ThemeContext = createContext(null);

export function ThemeProvider({ colors, darkMode, toggleDarkMode, children }) {
  return (
    <ThemeContext.Provider value={{ colors, darkMode, toggleDarkMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
