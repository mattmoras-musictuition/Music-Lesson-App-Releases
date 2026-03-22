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

  gmailArchive: (messageId) =>
    ipcRenderer.invoke("gmail-archive", messageId),

  gmailGetAttachment: (messageId, attachmentId, filename) =>
    ipcRenderer.invoke("gmail-get-attachment", { messageId, attachmentId, filename }),

  gmailFetchAttachment: (messageId, attachmentId) =>
    ipcRenderer.invoke("gmail-fetch-attachment", { messageId, attachmentId }),

  // ── Anthropic API proxy (routes through main to avoid CORS in file:// builds)
  anthropicFetch: (url, method, headers, body) =>
    ipcRenderer.invoke("anthropic-fetch", { url, method, headers, body }),

  // True when running inside Electron (false in browser)
  isElectron: true,
});
