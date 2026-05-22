// Polyfills for modern static methods missing from the bundled
// Electron's Chromium (currently 122, via Electron 29). pdfjs-dist 5.x
// targets newer engines and calls several of these internally:
//   - URL.parse        (Chromium 126)
//   - Promise.try      (Chromium 128)
// (URL.canParse — Chromium 120 — is already present at 122 but is
// polyfilled too, harmlessly, for older baselines.)
// Promise.withResolvers, Array.fromAsync, Object/Map.groupBy, Iterator
// helpers and Set methods are all <=122, so no polyfill is needed.
//
// Each is guarded so it's a no-op where the method already exists.
// Imported first in the entry file, before any module that uses them.

if (typeof URL.parse !== "function") {
  URL.parse = function (url, base) {
    try {
      return base === undefined ? new URL(url) : new URL(url, base);
    } catch {
      return null;
    }
  };
}

if (typeof URL.canParse !== "function") {
  URL.canParse = function (url, base) {
    try {
      const u = base === undefined ? new URL(url) : new URL(url, base);
      return !!u;
    } catch {
      return false;
    }
  };
}

// Promise.try(fn, ...args): invoke fn synchronously, returning a
// promise — adopting a returned thenable, and routing a synchronous
// throw to rejection (the Promise executor handles both).
if (typeof Promise.try !== "function") {
  Promise.try = function (fn, ...args) {
    return new Promise((resolve) => {
      resolve(fn(...args));
    });
  };
}
