// ============================================================
// useOpenGraph(url) — fetch + cache Open Graph metadata for a link
// preview. Results (including nulls — failures are cached too, so a
// dead/unparseable link isn't re-fetched on every click) are stored
// in localStorage under og:<url> with a 30-day expiry.
//
// Returns { data, loading } where data is
//   { title, image, description, hostname, favicon } | null.
// ============================================================

import { useState, useEffect } from "react";

const CACHE_PREFIX = "og:";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function readCache(url) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + url);
    if (!raw) return undefined;
    const { data, fetchedAt } = JSON.parse(raw);
    if (!fetchedAt || Date.now() - fetchedAt > MAX_AGE_MS) return undefined;
    return { data }; // present (data may be null — a cached failure)
  } catch {
    return undefined;
  }
}

function writeCache(url, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + url, JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch {
    // localStorage full / unavailable — preview still works, just uncached.
  }
}

export default function useOpenGraph(url, enabled = true) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !url) { setData(null); setLoading(false); return; }

    const cached = readCache(url);
    if (cached !== undefined) { setData(cached.data); setLoading(false); return; }

    let cancelled = false;
    setLoading(true);
    setData(null);

    Promise.resolve(window.electronAPI?.fetchOpenGraph?.(url) ?? null)
      .then((result) => {
        const value = result || null;
        writeCache(url, value);
        if (!cancelled) { setData(value); setLoading(false); }
      })
      .catch(() => {
        writeCache(url, null);
        if (!cancelled) { setData(null); setLoading(false); }
      });

    return () => { cancelled = true; };
  }, [url, enabled]);

  return { data, loading };
}
