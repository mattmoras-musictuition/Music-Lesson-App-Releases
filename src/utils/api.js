// ============================================================
// API UTILITIES
// Anthropic fetch wrapper + lazy CDN library loaders.
// ============================================================

// API key for Anthropic — set by user in Settings
let _anthropicApiKey = "";

export function getAnthropicHeaders() {
  const key = _anthropicApiKey || (typeof localStorage !== "undefined" ? localStorage.getItem("mt-api-key") || "" : "");
  return {
    "Content-Type": "application/json",
    ...(key ? {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    } : {}),
  };
}

export function setAnthropicApiKey(key) {
  _anthropicApiKey = key;
}

// Wrapper around fetch that routes through the Electron main process when running
// as a built app (file:// protocol blocks direct outbound fetch calls).
export async function anthropicFetch(url, options) {
  if (window.electronAPI && window.electronAPI.anthropicFetch) {
    const body = options.body || "";
    const result = await window.electronAPI.anthropicFetch(
      url,
      options.method || "POST",
      options.headers || {},
      body
    );
    // Wrap result in a fetch-like response object
    return {
      ok: result.ok,
      status: result.status,
      json: async () => JSON.parse(result.text),
      text: async () => result.text,
    };
  }
  return fetch(url, options);
}

// ── Lazy CDN library loaders ─────────────────────────────────────────────────

let Papa = null;
export async function getPapa() {
  if (Papa) return Papa;
  if (window.Papa) { Papa = window.Papa; return Papa; }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js";
    s.onload = () => { Papa = window.Papa; resolve(Papa); };
    s.onerror = () => reject(new Error("Failed to load PapaParse"));
    document.head.appendChild(s);
  });
}

let _XLSX = null;
export async function getXLSX() {
  if (_XLSX) return _XLSX;
  if (window.XLSX) { _XLSX = window.XLSX; return _XLSX; }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    script.onload = () => { _XLSX = window.XLSX; resolve(_XLSX); };
    script.onerror = () => reject(new Error("Failed to load SheetJS library"));
    document.head.appendChild(script);
  });
}
