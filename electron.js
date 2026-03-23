const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { autoUpdater } = require("electron-updater");
const isDev = process.env.NODE_ENV === "development" || process.env.ELECTRON_DEV === "1";

// ── Google OAuth credentials (private desktop app) ─────────────────────────
const GMAIL_CLIENT_ID     = "134502425465-2tg0qce4gorbds16n0uc7tk1kidiuvus.apps.googleusercontent.com";
const GMAIL_CLIENT_SECRET = "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";
const GMAIL_REDIRECT_URI  = "http://localhost";
const GMAIL_SCOPE         = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

const PREFS_PATH = path.join(app.getPath("userData"), "prefs.json");
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_PATH, "utf8")); }
  catch(e) { return {}; }
}
function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2)); }
  catch(e) { console.error("Could not save prefs:", e.message); }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    titleBarStyle: "hiddenInset",
    title: "Music Timetabling",
    icon: path.join(__dirname, "public", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isDev) {
    mainWindow.loadURL("http://localhost:3000");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "build", "index.html"));
  }
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── HTTPS helper ───────────────────────────────────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, "utf8");
    const req = https.request({ hostname, path, method: "POST", headers: { ...headers, "Content-Length": bodyBuf.length } }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Gmail OAuth ────────────────────────────────────────────────────────────
async function refreshAccessToken(refreshToken) {
  const res = await httpsPost("oauth2.googleapis.com", "/token",
    { "Content-Type": "application/x-www-form-urlencoded" },
    `client_id=${encodeURIComponent(GMAIL_CLIENT_ID)}&client_secret=${encodeURIComponent(GMAIL_CLIENT_SECRET)}&refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token`
  );
  const data = JSON.parse(res.body);
  if (!data.access_token) throw new Error("Token refresh failed: " + res.body);
  return data.access_token;
}

async function getValidAccessToken() {
  const prefs = loadPrefs();
  const tokens = prefs.gmailTokens;
  if (!tokens) throw new Error("Not connected to Gmail");

  // Check expiry (with 60s buffer)
  if (tokens.expiry && Date.now() < tokens.expiry - 60000) {
    return tokens.access_token;
  }
  // Refresh
  const newToken = await refreshAccessToken(tokens.refresh_token);
  prefs.gmailTokens = { ...tokens, access_token: newToken, expiry: Date.now() + 3600000 };
  savePrefs(prefs);
  return newToken;
}

ipcMain.handle("gmail-get-status", () => {
  const prefs = loadPrefs();
  return { connected: !!(prefs.gmailTokens && prefs.gmailTokens.refresh_token) };
});

ipcMain.handle("gmail-oauth-connect", () => {
  return new Promise((resolve) => {
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(GMAIL_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(GMAIL_REDIRECT_URI)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(GMAIL_SCOPE)}` +
      `&access_type=offline&prompt=select_account%20consent`;

    const authWindow = new BrowserWindow({
      width: 520, height: 680, title: "Connect Gmail",
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    authWindow.loadURL(authUrl);

    // Capture auth code from redirect to localhost
    authWindow.webContents.on("will-redirect", async (e, url) => {
      if (!url.startsWith(GMAIL_REDIRECT_URI)) return;
      e.preventDefault();
      const urlObj = new URL(url);
      const code = urlObj.searchParams.get("code");
      const error = urlObj.searchParams.get("error");
      authWindow.close();

      if (error || !code) { resolve({ ok: false, error: error || "No code returned" }); return; }

      try {
        const res = await httpsPost("oauth2.googleapis.com", "/token",
          { "Content-Type": "application/x-www-form-urlencoded" },
          `code=${encodeURIComponent(code)}&client_id=${encodeURIComponent(GMAIL_CLIENT_ID)}&client_secret=${encodeURIComponent(GMAIL_CLIENT_SECRET)}&redirect_uri=${encodeURIComponent(GMAIL_REDIRECT_URI)}&grant_type=authorization_code`
        );
        const tokens = JSON.parse(res.body);
        if (!tokens.access_token) { resolve({ ok: false, error: "No access token: " + res.body }); return; }
        const prefs = loadPrefs();
        prefs.gmailTokens = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || prefs.gmailTokens?.refresh_token,
          expiry: Date.now() + (tokens.expires_in || 3600) * 1000,
        };
        savePrefs(prefs);
        resolve({ ok: true });
      } catch(e) { resolve({ ok: false, error: e.message }); }
    });

    authWindow.on("closed", () => resolve({ ok: false, error: "Window closed" }));
  });
});

ipcMain.handle("gmail-disconnect", () => {
  const prefs = loadPrefs();
  delete prefs.gmailTokens;
  savePrefs(prefs);
  return { ok: true };
});

ipcMain.handle("gmail-send", async (_e, { to, from, subject, bodyHtml, attachments }) => {
  try {
    const accessToken = await getValidAccessToken();
    const toHeader = Array.isArray(to) ? to.join(", ") : to;
    const subjectEncoded = `=?UTF-8?B?${Buffer.from(subject || "").toString("base64")}?=`;

    let mimeMessage;

    if (attachments && attachments.length > 0) {
      // ── Multipart MIME with attachments ────────────────────────────────
      const boundary = `mt_boundary_${Date.now()}`;
      const parts = [];

      // HTML body part
      parts.push([
        `--${boundary}`,
        `Content-Type: text/html; charset=UTF-8`,
        `Content-Transfer-Encoding: base64`,
        ``,
        Buffer.from(bodyHtml || "").toString("base64"),
      ].join("\r\n"));

      // Attachment parts
      for (const att of attachments) {
        const fileContent = att.contentBase64 || Buffer.from(att.content || "").toString("base64");
        parts.push([
          `--${boundary}`,
          `Content-Type: ${att.mimeType || "application/octet-stream"}; name="${att.filename}"`,
          `Content-Disposition: attachment; filename="${att.filename}"`,
          `Content-Transfer-Encoding: base64`,
          ``,
          fileContent,
        ].join("\r\n"));
      }

      parts.push(`--${boundary}--`);

      mimeMessage = [
        `From: ${from || "me"}`,
        `To: ${toHeader}`,
        `Subject: ${subjectEncoded}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        parts.join("\r\n"),
      ].join("\r\n");

    } else {
      // ── Simple HTML email (no attachments) ────────────────────────────
      mimeMessage = [
        `From: ${from || "me"}`,
        `To: ${toHeader}`,
        `Subject: ${subjectEncoded}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/html; charset=UTF-8`,
        `Content-Transfer-Encoding: base64`,
        ``,
        Buffer.from(bodyHtml || "").toString("base64"),
      ].join("\r\n");
    }

    // Base64url encode the full message
    const encoded = Buffer.from(mimeMessage).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const body = JSON.stringify({ raw: encoded });
    const res = await httpsPost("gmail.googleapis.com",
      "/gmail/v1/users/me/messages/send",
      { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body
    );

    if (res.status >= 200 && res.status < 300) {
      return { ok: true };
    } else {
      return { ok: false, error: `Gmail API error ${res.status}: ${res.body}` };
    }
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  buildMenu();
  setupUpdater();

  // Local keyboard shortcuts via webContents — only fire when app is focused
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "f" || input.key === "F") {
      // Only toggle fullscreen if no text input is focused (check via renderer)
      mainWindow.webContents.executeJavaScript(
        "document.activeElement && (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable)"
      ).then(inInput => {
        if (!inInput) mainWindow.setFullScreen(!mainWindow.isFullScreen());
      }).catch(() => {});
    }
    if (input.key === "Escape" && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

function setupUpdater() {
  if (isDev) return;
  autoUpdater.checkForUpdatesAndNotify();
  autoUpdater.on("update-available", (info) => { mainWindow && mainWindow.webContents.send("update-status", { available: true, version: info.version }); });
  autoUpdater.on("update-not-available", () => { mainWindow && mainWindow.webContents.send("update-status", { available: false }); });
  autoUpdater.on("download-progress", (p) => { mainWindow && mainWindow.webContents.send("update-status", { downloading: true, percent: Math.round(p.percent) }); });
  autoUpdater.on("update-downloaded", (info) => { mainWindow && mainWindow.webContents.send("update-status", { available: true, version: info.version, ready: true }); });
  autoUpdater.on("error", (err) => { mainWindow && mainWindow.webContents.send("update-status", { available: false, error: err.message }); });
  ipcMain.on("check-for-updates", () => { autoUpdater.checkForUpdates(); });
  ipcMain.on("install-update", () => { autoUpdater.quitAndInstall(); });
}

function buildMenu() {
  const template = [
    { label: "Music Timetabling", submenu: [
      { label: "About Music Timetabling", role: "about" },
      { type: "separator" },
      { label: "Hide", accelerator: "Cmd+H", role: "hide" },
      { label: "Quit", accelerator: "Cmd+Q", role: "quit" },
    ]},
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ]},
    { label: "View", submenu: [
      { role: "reload" }, { type: "separator" },
      { label: "Toggle Full Screen", accelerator: "Ctrl+Cmd+F", role: "togglefullscreen" },
      { type: "separator" }, { role: "toggledevtools" },
    ]},
    { label: "Backup", submenu: [
      { label: "Save Backup Now", accelerator: "Cmd+Shift+B",
        click: () => { mainWindow && mainWindow.webContents.send("menu-backup"); } },
      { type: "separator" },
      { label: "Choose Backup Folder…", click: async () => {
          const prefs = loadPrefs();
          const result = await dialog.showOpenDialog(mainWindow, { title: "Choose Backup Folder", defaultPath: prefs.backupFolder || app.getPath("documents"), properties: ["openDirectory", "createDirectory"] });
          if (!result.canceled && result.filePaths[0]) { prefs.backupFolder = result.filePaths[0]; savePrefs(prefs); mainWindow && mainWindow.webContents.send("backup-folder-changed", result.filePaths[0]); }
      }},
      { label: "Open Backup Folder in Finder", click: () => { const prefs = loadPrefs(); shell.openPath(prefs.backupFolder || app.getPath("documents")); }},
    ]},
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── File / Backup IPC ──────────────────────────────────────────────────────
ipcMain.handle("write-backup", async (_e, { filename, json, folder }) => {
  try {
    const prefs = loadPrefs();
    const targetFolder = folder || prefs.backupFolder || app.getPath("documents");
    fs.mkdirSync(targetFolder, { recursive: true });
    const filePath = path.join(targetFolder, filename);
    if (json.startsWith("__base64__")) {
      fs.writeFileSync(filePath, Buffer.from(json.slice(10), "base64"));
    } else {
      fs.writeFileSync(filePath, json, "utf8");
    }
    return { ok: true, filePath };
  } catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("select-backup-folder", async () => {
  const prefs = loadPrefs();
  const result = await dialog.showOpenDialog(mainWindow, { title: "Choose Backup Folder", defaultPath: prefs.backupFolder || app.getPath("documents"), properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  prefs.backupFolder = result.filePaths[0]; savePrefs(prefs);
  return result.filePaths[0];
});
ipcMain.handle("get-backup-folder", async () => { const prefs = loadPrefs(); return prefs.backupFolder || app.getPath("documents"); });
ipcMain.handle("save-file-dialog", async (_e, { defaultName, json }) => {
  const prefs = loadPrefs();
  const result = await dialog.showSaveDialog(mainWindow, { title: "Save Backup", defaultPath: path.join(prefs.backupFolder || app.getPath("documents"), defaultName), filters: [{ name: "JSON Backup", extensions: ["json"] }] });
  if (result.canceled || !result.filePath) return { ok: false };
  try { fs.writeFileSync(result.filePath, json, "utf8"); return { ok: true, filePath: result.filePath }; }
  catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("open-file-dialog", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: "Restore from Backup", filters: [{ name: "JSON Backup", extensions: ["json"] }], properties: ["openFile"] });
  if (result.canceled || !result.filePaths[0]) return { ok: false };
  try { const json = fs.readFileSync(result.filePaths[0], "utf8"); return { ok: true, json }; }
  catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("reveal-in-finder", async (_e, filePath) => { shell.showItemInFolder(filePath); });

// ── HTML → PDF / PNG rendering ─────────────────────────────────────────────
async function renderHtmlWindow(html, width, height, fn) {
  // Write to a temp file to avoid Chromium's ~2MB data: URL limit
  const tmpFile = path.join(app.getPath("temp"), "mmm-render-" + Date.now() + ".html");
  fs.writeFileSync(tmpFile, html, "utf8");
  const win = new BrowserWindow({
    width, height, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false },
  });
  await new Promise((resolve, reject) => {
    win.loadURL("file://" + tmpFile);
    win.webContents.on("did-finish-load", resolve);
    win.webContents.on("did-fail-load", (_e, code, desc) => reject(new Error(desc || "Load failed")));
    setTimeout(() => reject(new Error("Render timeout")), 20000);
  });
  // Give fonts/images a moment to settle
  await new Promise(r => setTimeout(r, 800));
  try {
    return await fn(win);
  } finally {
    win.destroy();
    try { fs.unlinkSync(tmpFile); } catch(e) {}
  }
}

ipcMain.handle("print-to-pdf", async (_e, { html }) => {
  try {
    const pdfBuf = await renderHtmlWindow(html, 1200, 900, async (win) => {
      return win.webContents.printToPDF({
        landscape: true,
        printBackground: true,
        pageSize: "A4",
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      });
    });
    return { ok: true, base64: pdfBuf.toString("base64") };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("capture-png", async (_e, { html }) => {
  try {
    const base64 = await renderHtmlWindow(html, 1400, 1000, async (win) => {
      const image = await win.webContents.capturePage();
      return image.toPNG().toString("base64");
    });
    return { ok: true, base64 };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ── Anthropic API proxy ────────────────────────────────────────────────────
ipcMain.handle("gmail-list-inbox", async () => {
  try {
    const accessToken = await getValidAccessToken();

    // Step 1: Get 30 most recent inbox threads
    const listRes = await httpsGet(
      "gmail.googleapis.com",
      "/gmail/v1/users/me/threads?maxResults=50&labelIds=INBOX",
      { "Authorization": `Bearer ${accessToken}` }
    );
    const listData = JSON.parse(listRes.body);
    if (listData.error) return { ok: false, error: `Gmail API: ${listData.error.message || JSON.stringify(listData.error)}` };
    if (!listData.threads) return { ok: true, emails: [] };

    // Helpers
    function findPart(payload, mimeType) {
      if (!payload) return null;
      if (payload.mimeType === mimeType && payload.body?.data) return payload;
      for (const part of payload.parts || []) {
        const found = findPart(part, mimeType);
        if (found) return found;
      }
      return null;
    }
    // Collect all file attachment parts (non-body parts with a filename)
    function findAttachments(payload) {
      if (!payload) return [];
      const results = [];
      for (const part of payload.parts || []) {
        if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
          results.push({ filename: part.filename, mimeType: part.mimeType || "application/octet-stream", size: part.body?.size || 0, attachmentId: part.body.attachmentId });
        }
        results.push(...findAttachments(part));
      }
      return results;
    }
    function decodeRaw(data) {
      if (!data) return "";
      return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    }
    function decodeBody(data) {
      if (!data) return "";
      return decodeRaw(data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    // Fetch threads in batches of 5 to avoid rate limits
    async function fetchInBatches(items, batchSize, fn) {
      const results = [];
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(fn));
        results.push(...batchResults);
      }
      return results;
    }

    // Step 2: Fetch full thread data in batches of 5
    const threads = await fetchInBatches(listData.threads, 5, async (t) => {
      const threadRes = await httpsGet(
        "gmail.googleapis.com",
        `/gmail/v1/users/me/threads/${t.id}?format=full`,
        { "Authorization": `Bearer ${accessToken}` }
      );
      const thread = JSON.parse(threadRes.body);
      if (thread.error) return null; // skip any individual thread errors
      const messages = (thread.messages || []).filter(m => m.payload); // skip malformed messages
      if (!messages.length) return null;

      // Skip chat threads entirely
      if (messages.some(m => (m.labelIds || []).includes("CHAT"))) return null;

      // Display message: most recent non-sent message, or latest overall
      const nonSent = messages.filter(m => !(m.labelIds || []).includes("SENT"));
      const displayMsg = (nonSent.length > 0 ? nonSent : messages)
        .reduce((a, b) => (Number(a.internalDate) >= Number(b.internalDate) ? a : b));

      const headers = displayMsg.payload?.headers || [];
      const get = (name) => headers.find(h => h.name === name)?.value || "";
      const from = get("From") || get("Reply-To") || get("Sender") || "";
      const subject = get("Subject");

      // Skip genuinely empty shells
      if (!from && !subject) return null;

      // Parse body from display message
      const plainPart = findPart(displayMsg.payload, "text/plain");
      const htmlPart  = findPart(displayMsg.payload, "text/html");
      const plainData = plainPart?.body?.data || displayMsg.payload?.body?.data || "";
      const htmlData  = htmlPart?.body?.data || "";

      // Per-message data — bodies already fetched with format=full so include them
      const threadMessages = messages.map(m => {
        const mh = m.payload?.headers || [];
        const mGet = n => mh.find(h => h.name === n)?.value || "";
        const mPlain = findPart(m.payload, "text/plain");
        const mHtml  = findPart(m.payload, "text/html");
        const mPlainData = mPlain?.body?.data || m.payload?.body?.data || "";
        const mHtmlData  = mHtml?.body?.data || "";
        return {
          id:           m.id,
          from:         mGet("From") || mGet("Reply-To") || mGet("Sender") || "",
          to:           mGet("To"),
          date:         mGet("Date"),
          internalDate: Number(m.internalDate) || 0,
          snippet:      m.snippet || "",
          isSent:       (m.labelIds || []).includes("SENT"),
          body:         decodeBody(mPlainData || mHtmlData).slice(0, 3000),
          bodyHtml:     mHtmlData ? decodeRaw(mHtmlData) : "",
          attachments:  findAttachments(m.payload),
          messageId:    m.id,
        };
      });

      return {
        id:             thread.id,   // thread ID is the primary key
        threadId:       thread.id,
        subject,
        from,
        to:             get("To"),
        cc:             get("Cc"),
        deliveredTo:    get("Delivered-To"),
        date:           get("Date"),
        internalDate:   Number(displayMsg.internalDate) || 0,
        snippet:        displayMsg.snippet || "",
        body:           decodeBody(plainData || htmlData).slice(0, 3000),
        bodyHtml:       htmlData ? decodeRaw(htmlData) : "",
        threadCount:    messages.length,
        threadMessages,
        hasAttachment:  messages.some(m => findAttachments(m.payload).length > 0),
      };
    });

    return { ok: true, emails: threads.filter(Boolean) };
  } catch(e) {
    return { ok: false, error: e.message + (e.stack ? ' — ' + e.stack.split('\n')[1]?.trim() : '') };
  }
});

// ── Gmail Attachment Download ──────────────────────────────────────────────
ipcMain.handle("gmail-get-attachment", async (_e, { messageId, attachmentId, filename }) => {
  try {
    const accessToken = await getValidAccessToken();
    const res = await httpsGet(
      "gmail.googleapis.com",
      `/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
      { "Authorization": `Bearer ${accessToken}` }
    );
    const data = JSON.parse(res.body);
    if (data.error) return { ok: false, error: data.error.message };
    // data.data is base64url encoded
    const buf = Buffer.from((data.data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");

    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save Attachment",
      defaultPath: path.join(app.getPath("downloads"), filename),
    });
    if (result.canceled || !result.filePath) return { ok: false, error: "Cancelled" };
    fs.writeFileSync(result.filePath, buf);
    shell.showItemInFolder(result.filePath);
    return { ok: true, filePath: result.filePath };
  } catch(e) { return { ok: false, error: e.message }; }
});

// Fetch attachment as base64 for in-app use (Claude, drag-to-todo) — no save dialog
ipcMain.handle("gmail-fetch-attachment", async (_e, { messageId, attachmentId }) => {
  try {
    const accessToken = await getValidAccessToken();
    const res = await httpsGet(
      "gmail.googleapis.com",
      `/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
      { "Authorization": `Bearer ${accessToken}` }
    );
    const data = JSON.parse(res.body);
    if (data.error) return { ok: false, error: data.error.message };
    const base64 = (data.data || "").replace(/-/g, "+").replace(/_/g, "/");
    return { ok: true, base64 };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ── Gmail Thread Archive ───────────────────────────────────────────────────
ipcMain.handle("gmail-archive", async (_e, threadId) => {
  try {
    const accessToken = await getValidAccessToken();
    const res = await httpsPost(
      "gmail.googleapis.com",
      `/gmail/v1/users/me/threads/${threadId}/modify`,
      { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      JSON.stringify({ removeLabelIds: ["INBOX"] })
    );
    return { ok: res.status >= 200 && res.status < 300 };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ── Gmail Sent ─────────────────────────────────────────────────────────────
ipcMain.handle("gmail-list-sent", async () => {
  try {
    const accessToken = await getValidAccessToken();

    const listRes = await httpsGet(
      "gmail.googleapis.com",
      "/gmail/v1/users/me/messages?maxResults=50&labelIds=SENT",
      { "Authorization": `Bearer ${accessToken}` }
    );
    const listData = JSON.parse(listRes.body);
    if (!listData.messages) return { ok: true, emails: [] };

    function findPart(payload, mimeType) {
      if (!payload) return null;
      if (payload.mimeType === mimeType && payload.body?.data) return payload;
      for (const part of payload.parts || []) { const found = findPart(part, mimeType); if (found) return found; }
      return null;
    }
    function decodeRaw(data) {
      if (!data) return "";
      return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    }
    function decodeBody(data) {
      if (!data) return "";
      return decodeRaw(data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    const emails = await Promise.all(listData.messages.map(async (msg) => {
      const detailRes = await httpsGet(
        "gmail.googleapis.com",
        `/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { "Authorization": `Bearer ${accessToken}` }
      );
      const detail = JSON.parse(detailRes.body);
      const headers = detail.payload?.headers || [];
      const get = (name) => headers.find(h => h.name === name)?.value || "";

      const plainPart = findPart(detail.payload, "text/plain");
      const htmlPart  = findPart(detail.payload, "text/html");
      const plainData = plainPart?.body?.data || detail.payload?.body?.data || "";
      const htmlData  = htmlPart?.body?.data || "";

      return {
        id:           msg.id,
        threadId:     msg.threadId,
        subject:      get("Subject"),
        from:         get("From") || get("Reply-To") || get("Sender") || "",
        to:           get("To"),
        cc:           get("Cc"),
        date:         get("Date"),
        internalDate: detail.internalDate ? Number(detail.internalDate) : 0,
        snippet:  detail.snippet || "",
        body:     decodeBody(plainData || htmlData).slice(0, 3000),
        bodyHtml: htmlData ? decodeRaw(htmlData) : "",
        isSent:   true,
      };
    }));

    return { ok: true, emails };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ── Anthropic API proxy ────────────────────────────────────────────────────
ipcMain.handle("open-external", async (_e, url) => {
  try {
    // Only allow http/https URLs — never file:// or other schemes
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("anthropic-fetch", async (_e, { url, method, headers, body }) => {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(url);
      const bodyBuf = body ? Buffer.from(body, "utf8") : Buffer.alloc(0);
      const req = https.request({ hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: method || "POST", headers: { ...headers, "Content-Length": bodyBuf.length } }, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: data }));
      });
      req.on("error", (e) => resolve({ ok: false, status: 0, text: e.message }));
      if (bodyBuf.length) req.write(bodyBuf);
      req.end();
    } catch(e) { resolve({ ok: false, status: 0, text: e.message }); }
  });
});

// ── Anthropic Streaming API proxy ──────────────────────────────────────────
// Uses ipcMain.on (not handle) so we can push multiple chunks back via event.sender.send
ipcMain.on("anthropic-stream", (event, { streamId, url, method, headers, body }) => {
  try {
    const urlObj = new URL(url);
    const bodyBuf = body ? Buffer.from(body, "utf8") : Buffer.alloc(0);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: method || "POST",
      headers: { ...headers, "Content-Length": bodyBuf.length }
    }, (res) => {
      // Non-2xx responses from Anthropic are plain JSON errors, not SSE
      if (res.statusCode >= 400) {
        let errData = "";
        res.on("data", c => { errData += c; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(errData);
            event.sender.send("anthropic-stream-error", { streamId, error: parsed.error?.message || errData, status: res.statusCode });
          } catch {
            event.sender.send("anthropic-stream-error", { streamId, error: errData, status: res.statusCode });
          }
        });
        return;
      }
      res.on("data", (chunk) => {
        event.sender.send("anthropic-stream-chunk", { streamId, chunk: chunk.toString("utf8") });
      });
      res.on("end", () => {
        event.sender.send("anthropic-stream-end", { streamId });
      });
    });
    req.on("error", (e) => {
      event.sender.send("anthropic-stream-error", { streamId, error: e.message, status: 0 });
    });
    if (bodyBuf.length) req.write(bodyBuf);
    req.end();
  } catch(e) {
    event.sender.send("anthropic-stream-error", { streamId, error: e.message, status: 0 });
  }
});
