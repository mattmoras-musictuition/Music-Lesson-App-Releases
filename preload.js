// ─── Preload: secure bridge between Electron main and React renderer ──────────
// Exposes only specific IPC calls to the renderer — Node/fs never touches React.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Write a backup file silently to the configured backup folder
  writeBackup: (filename, json) =>
    ipcRenderer.invoke("write-backup", { filename, json }),

  // Get the current backup folder path (for display in Dashboard)
  getBackupFolder: () =>
    ipcRenderer.invoke("get-backup-folder"),

  // Show native Save dialog (manual backup button)
  saveFileDialog: (defaultName, json) =>
    ipcRenderer.invoke("save-file-dialog", { defaultName, json }),

  // Show native Open dialog (restore button)
  openFileDialog: () =>
    ipcRenderer.invoke("open-file-dialog"),

  // Reveal a file in macOS Finder
  revealInFinder: (filePath) =>
    ipcRenderer.invoke("reveal-in-finder", filePath),

  // Render HTML to PDF
  printToPdf: (html) =>
    ipcRenderer.invoke("print-to-pdf", { html }),

  // Render HTML to PNG
  capturePng: (html) =>
    ipcRenderer.invoke("capture-png", { html }),

  // Open a URL in the system default browser
  openExternal: (url) =>
    ipcRenderer.invoke("open-external", url),

  // Listen for menu-triggered backup (Cmd+Shift+B or Backup menu)
  onMenuBackup: (callback) => {
    ipcRenderer.on("menu-backup", callback);
    return () => ipcRenderer.removeListener("menu-backup", callback);
  },

  // Show folder picker and save as backup folder
  selectBackupFolder: () =>
    ipcRenderer.invoke("select-backup-folder"),

  // Show folder picker and save as timetable export folder
  selectTimetableFolder: () =>
    ipcRenderer.invoke("select-timetable-folder"),

  // Get the current timetable export folder path
  getTimetableFolder: () =>
    ipcRenderer.invoke("get-timetable-folder"),

  // Listen for backup folder changes via the menu
  onBackupFolderChanged: (callback) => {
    ipcRenderer.on("backup-folder-changed", (_event, folder) => callback(folder));
    return () => ipcRenderer.removeListener("backup-folder-changed", callback);
  },

  // ── Gmail ──────────────────────────────────────────────────────────────────
  gmailGetStatus: () =>
    ipcRenderer.invoke("gmail-get-status"),

  gmailOAuthConnect: () =>
    ipcRenderer.invoke("gmail-oauth-connect"),

  gmailDisconnect: () =>
    ipcRenderer.invoke("gmail-disconnect"),

  gmailListInbox: () =>
    ipcRenderer.invoke("gmail-list-inbox"),

  gmailListSent: () =>
    ipcRenderer.invoke("gmail-list-sent"),

  gmailSend: (payload) =>
    ipcRenderer.invoke("gmail-send", payload),

  gmailSearch: (query, folder) =>
    ipcRenderer.invoke("gmail-search", { query, folder }),

  gmailArchive: (messageId) =>
    ipcRenderer.invoke("gmail-archive", messageId),

  gmailGetAttachment: (messageId, attachmentId, filename) =>
    ipcRenderer.invoke("gmail-get-attachment", { messageId, attachmentId, filename }),

  gmailFetchAttachment: (messageId, attachmentId) =>
    ipcRenderer.invoke("gmail-fetch-attachment", { messageId, attachmentId }),

  newsletterCheck: (url) =>
    ipcRenderer.invoke("newsletter-check", { url }),

  // ── Anthropic API proxy (routes through main to avoid CORS in file:// builds)
  anthropicFetch: (url, method, headers, body) =>
    ipcRenderer.invoke("anthropic-fetch", { url, method, headers, body }),

  // ── Anthropic Streaming (pushes SSE chunks back as they arrive) ────────────
  // Start a streaming request — chunks arrive via anthropicStreamListen callbacks
  anthropicStream: (streamId, url, method, headers, body) =>
    ipcRenderer.send("anthropic-stream", { streamId, url, method, headers, body }),

  // Register chunk/end/error handlers for a specific streamId — returns a cleanup fn
  anthropicStreamListen: (streamId, onChunk, onEnd, onError) => {
    const chunkHandler = (_e, data) => {
      if (data.streamId === streamId) onChunk(data.chunk);
    };
    const endHandler = (_e, data) => {
      if (data.streamId === streamId) { cleanup(); onEnd(); }
    };
    const errorHandler = (_e, data) => {
      if (data.streamId === streamId) { cleanup(); onError(data.error, data.status); }
    };
    function cleanup() {
      ipcRenderer.removeListener("anthropic-stream-chunk", chunkHandler);
      ipcRenderer.removeListener("anthropic-stream-end", endHandler);
      ipcRenderer.removeListener("anthropic-stream-error", errorHandler);
    }
    ipcRenderer.on("anthropic-stream-chunk", chunkHandler);
    ipcRenderer.on("anthropic-stream-end", endHandler);
    ipcRenderer.on("anthropic-stream-error", errorHandler);
    return cleanup;
  },

  // ── Auto-updater ───────────────────────────────────────────────────────────
  checkForUpdates: () =>
    ipcRenderer.send("check-for-updates"),

  installUpdate: () =>
    ipcRenderer.send("install-update"),

  onUpdateStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("update-status", handler);
    return () => ipcRenderer.removeListener("update-status", handler);
  },

  // True when running inside Electron (false in browser)
  isElectron: true,
});
