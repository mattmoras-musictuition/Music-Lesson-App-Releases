// Polyfill URL.parse / URL.canParse for older Chromium.
//
// These static methods are recent (Chromium 126 / 120). The Electron
// renderer this app ships in predates them, and pdfjs-dist 5.x calls
// URL.parse internally — without this, every PDF render throws
// "URL.parse is not a function". Guarded, so it's a no-op on engines
// that already have the methods. Imported first in the entry file, so
// it runs before any module that might use the URL API.

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
