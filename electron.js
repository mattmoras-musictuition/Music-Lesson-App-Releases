const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, session, systemPreferences } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { load: loadHtml } = require("cheerio");
const { autoUpdater } = require("electron-updater");
const isDev = process.env.NODE_ENV === "development" || process.env.ELECTRON_DEV === "1";

// ── Google OAuth credentials (private desktop app) ─────────────────────────
const GMAIL_CLIENT_ID     = "134502425465-2tg0qce4gorbds16n0uc7tk1kidiuvus.apps.googleusercontent.com";
const GMAIL_CLIENT_SECRET = "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";
const GMAIL_REDIRECT_URI  = "http://localhost";
const GMAIL_SCOPE         = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";
// DKIM fix (Option 1): all mail is sent From this signed primary mailbox. The
// real value is fetched from the connected account's profile on connect; this
// is only a backstop if that fetch is ever unavailable.
const GMAIL_DEFAULT_PRIMARY = "matt@mattmorasmusic.com";

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
      webviewTag: true,
    },
  });
  if (isDev) {
    mainWindow.loadURL("http://localhost:3000");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "build", "index.html"));
  }
  mainWindow.on("closed", () => { mainWindow = null; });
  // Inject a drag region at the top of the window so it can be dragged when windowed.
  // left:72px leaves room for the native macOS traffic lights (close/min/max buttons).
  mainWindow.webContents.on("dom-ready", () => {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        if (document.getElementById('electron-drag-bar')) return;
        const bar = document.createElement('div');
        bar.id = 'electron-drag-bar';
        bar.style.cssText = 'position:fixed;top:0;left:72px;right:0;height:28px;-webkit-app-region:drag;z-index:9999;pointer-events:none;';
        document.body.appendChild(bar);
      })();
    `).catch(() => {});
  });
  // Intercept window.open() calls (e.g. invoice preview) — always open as a
  // controlled draggable/resizable window instead of inheriting fullscreen state.
  // Session 97: previously fullscreenable was false, which blocked macOS
  // split-screen mode (green-button tile options). Removing that lets these
  // popups behave like normal macOS app windows — they can be tiled, sent to
  // the back when another window is clicked, and maximised. Standard
  // frame/title bar ensures the traffic-light controls work.
  mainWindow.webContents.setWindowOpenHandler(() => {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 960,
        height: 780,
        minWidth: 600,
        minHeight: 400,
        fullscreen: false,
        fullscreenable: true,
        frame: true,
        resizable: true,
        minimizable: true,
        maximizable: true,
        titleBarStyle: "default",
      },
    };
  });
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

// Fetch the connected account's own address (the signed primary mailbox) and
// cache it in prefs. Best-effort — never throws; callers fall back to the
// stored value or the default.
async function fetchAndStorePrimaryAddress(accessToken) {
  try {
    const res = await httpsGet("gmail.googleapis.com", "/gmail/v1/users/me/profile",
      { "Authorization": `Bearer ${accessToken}` });
    const data = JSON.parse(res.body);
    if (data.emailAddress) {
      const prefs = loadPrefs();
      prefs.gmailPrimaryAddress = data.emailAddress;
      savePrefs(prefs);
      return data.emailAddress;
    }
  } catch {}
  return null;
}

ipcMain.handle("gmail-get-status", () => {
  const prefs = loadPrefs();
  return {
    connected: !!(prefs.gmailTokens && prefs.gmailTokens.refresh_token),
    primaryAddress: prefs.gmailPrimaryAddress || GMAIL_DEFAULT_PRIMARY,
  };
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
        // Capture the signed primary sending address for this account (best-effort).
        await fetchAndStorePrimaryAddress(tokens.access_token);
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

ipcMain.handle("gmail-send", async (_e, { to, from, replyTo, cc, bcc, subject, bodyHtml, attachments }) => {
  try {
    console.log("[RTDEBUG gmail-send] from=", from, "replyTo=", replyTo, "-> Reply-To header written:", replyTo ? "YES" : "NO");
    const accessToken = await getValidAccessToken();
    const toHeader = Array.isArray(to) ? to.join(", ") : to;
    const ccHeader = Array.isArray(cc) ? cc.join(", ") : cc;
    const bccHeader = Array.isArray(bcc) ? bcc.join(", ") : bcc;
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
        ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
        `To: ${toHeader}`,
        ...(cc && cc.length > 0 ? [`Cc: ${ccHeader}`] : []),
        ...(bcc && bcc.length > 0 ? [`Bcc: ${bccHeader}`] : []),
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
        ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
        `To: ${toHeader}`,
        ...(cc && cc.length > 0 ? [`Cc: ${ccHeader}`] : []),
        ...(bcc && bcc.length > 0 ? [`Bcc: ${bccHeader}`] : []),
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

// ── Microphone permissions ─────────────────────────────────────────────────
// The admin voice-notes feature records via getUserMedia + MediaRecorder,
// which on macOS needs microphone access at three layers (mirrors the teacher
// app's proven setup):
//   1. Info.plist NSMicrophoneUsageDescription — via build.mac.extendInfo.
//   2. Hardened-runtime entitlement com.apple.security.device.audio-input —
//      via entitlements.mac.plist (build.mac.entitlements/entitlementsInherit).
//   3. Electron permission gate — session.defaultSession's permission handler.
//      The renderer's getUserMedia goes through this gate before reaching
//      macOS; without granting "media" here the call rejects without ever
//      surfacing a macOS prompt. Missing any one layer yields the same silent
//      failure (no prompt, never appears in System Settings → Microphone).
async function setupMicPermissions() {
  // (3) Grant the Electron-side request gate for media (mic + camera). Scoped
  // to media only; everything else continues to use Electron defaults.
  if (session && session.defaultSession) {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === "media" || permission === "audioCapture") {
        callback(true);
      } else {
        callback(false);
      }
    });
  }

  // (1) + (2) are build-config. On macOS we also proactively call
  // askForMediaAccess so the OS prompt fires on first launch rather than
  // waiting for the user's first click on the record button.
  if (process.platform === "darwin" && systemPreferences?.askForMediaAccess) {
    try {
      await systemPreferences.askForMediaAccess("microphone");
    } catch (e) {
      console.warn("[mic] askForMediaAccess failed:", e?.message || e);
    }
  }
}

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  await setupMicPermissions();
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
ipcMain.handle("select-timetable-folder", async () => {
  const prefs = loadPrefs();
  const result = await dialog.showOpenDialog(mainWindow, { title: "Choose Timetable Export Folder", defaultPath: prefs.timetableFolder || app.getPath("documents"), properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  prefs.timetableFolder = result.filePaths[0]; savePrefs(prefs);
  return result.filePaths[0];
});
ipcMain.handle("get-timetable-folder", async () => { const prefs = loadPrefs(); return prefs.timetableFolder || ""; });

// ── Session 98: Invoice folder + PDF save + preview window ─────────────────
// Invoices get saved to a user-configured local folder, auto-organised into
// <folder>/<School Name>/<Term Label>/. This is deliberately local-disk-only
// (not Supabase) so it's immune to the bucket retention issue that's been
// eating timetable blobs. Permanent, findable, survives reinstalls as long
// as the folder does.

function _sanitizeForPath(s) {
  // Strip characters that are problematic in file/folder names across macOS,
  // Windows, and Linux. Keep letters/digits/space/dash/underscore/ampersand.
  // Collapse runs of whitespace, trim, fall back to "Unknown" if empty.
  const out = String(s || "")
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return out || "Unknown";
}

ipcMain.handle("select-invoice-folder", async () => {
  const prefs = loadPrefs();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose Invoice Save Folder",
    defaultPath: prefs.invoiceFolder || app.getPath("documents"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  prefs.invoiceFolder = result.filePaths[0];
  savePrefs(prefs);
  return result.filePaths[0];
});

ipcMain.handle("get-invoice-folder", async () => {
  // Session 98 (patch): auto-default to ~/Documents/Invoices on first use
  // instead of prompting the user. Creates the directory if missing and
  // persists it as the pref — subsequent calls return it instantly. Users
  // can still change the location via selectInvoiceFolder from Settings.
  const prefs = loadPrefs();
  if (prefs.invoiceFolder) {
    // Sanity: if the saved folder no longer exists on disk (user moved or
    // deleted it), fall through to the default below rather than fail on
    // every subsequent save.
    try {
      fs.accessSync(prefs.invoiceFolder, fs.constants.W_OK);
      return prefs.invoiceFolder;
    } catch {
      console.warn("[invoice folder] saved path unusable, regenerating default:", prefs.invoiceFolder);
    }
  }
  const defaultFolder = path.join(app.getPath("documents"), "Invoices");
  try {
    fs.mkdirSync(defaultFolder, { recursive: true });
    prefs.invoiceFolder = defaultFolder;
    savePrefs(prefs);
    return defaultFolder;
  } catch (e) {
    console.warn("[invoice folder] couldn't create default:", e?.message || e);
    return "";
  }
});

// Save a base64-encoded PDF to <invoiceFolder>/<school>/<term>/<filename>.
// Creates intermediate directories as needed. Overwrites existing files
// (upsert behaviour — same invoice number regenerating is fine).
// Returns { ok, filePath } on success or { ok: false, error, reason } where
// reason is "no_folder" if the user hasn't configured one yet (caller can
// prompt to set one up).
ipcMain.handle("save-invoice-pdf", async (_e, { base64, schoolName, termLabel, filename }) => {
  try {
    const prefs = loadPrefs();
    if (!prefs.invoiceFolder) {
      return { ok: false, error: "No invoice folder configured", reason: "no_folder" };
    }
    const schoolDir = _sanitizeForPath(schoolName || "Multi-school");
    const termDir   = _sanitizeForPath(termLabel  || "Unknown Term");
    const safeName  = _sanitizeForPath(filename.replace(/\.pdf$/i, "")) + ".pdf";
    const targetDir = path.join(prefs.invoiceFolder, schoolDir, termDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, safeName);
    fs.writeFileSync(targetPath, Buffer.from(base64, "base64"));
    return { ok: true, filePath: targetPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Open an HTML payload (invoice preview, or any other rendered HTML) in a
// standalone BrowserWindow. Unlike window.open from the renderer — which
// inherits the parent's macOS fullscreen space and becomes inaccessible
// when the app is fullscreened — this creates a top-level window owned by
// the app but not parented to mainWindow, so macOS places it in the
// regular desktop space. Cmd+W closes it, traffic lights work, it can be
// tiled/minimised/maximised normally.
ipcMain.handle("open-invoice-preview", async (_e, { html, title }) => {
  try {
    const tmpFile = path.join(app.getPath("temp"), "mmm-preview-" + Date.now() + ".html");
    fs.writeFileSync(tmpFile, html, "utf8");
    const win = new BrowserWindow({
      width: 960,
      height: 900,
      minWidth: 600,
      minHeight: 400,
      title: title || "Invoice Preview",
      fullscreen: false,
      fullscreenable: true,
      frame: true,
      resizable: true,
      minimizable: true,
      maximizable: true,
      titleBarStyle: "default",
      // Deliberately no `parent:` option — keeps this window out of the
      // main app's fullscreen space.
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.loadURL("file://" + tmpFile);
    // Clean up the temp file after the window is closed. Small delay to
    // ensure the page has finished loading before we unlink.
    win.on("closed", () => {
      setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch(e) {} }, 500);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
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

ipcMain.handle("print-to-pdf", async (_e, { html, options }) => {
  // Session 98: accept optional `options` to override defaults. Existing
  // callers (timetable exports) pass no options and get the original
  // landscape A4 behaviour. Invoice send passes { landscape: false,
  // margins: {...} } for portrait output with tighter margins.
  try {
    const pdfOptions = {
      landscape: true,
      printBackground: true,
      pageSize: "A4",
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      ...(options || {}),
    };
    const winW = pdfOptions.landscape ? 1200 : 900;
    const winH = pdfOptions.landscape ? 900  : 1200;
    const pdfBuf = await renderHtmlWindow(html, winW, winH, async (win) => {
      return win.webContents.printToPDF(pdfOptions);
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

// In-process cache for inbox thread data.
// Key: threadId, Value: { historyId, data } where data is the processed thread object.
// historyId from the threads.list response changes whenever a thread is modified
// (new message, label change, etc.) — so we only re-fetch threads whose historyId
// has changed since the last poll, reducing ~101 API calls per poll to typically 1.
let gmailInboxCache = {};

ipcMain.handle("gmail-list-inbox", async () => {
  try {
    const accessToken = await getValidAccessToken();

    // Step 1: List 100 inbox threads (1 API call — always needed)
    const listRes = await httpsGet(
      "gmail.googleapis.com",
      "/gmail/v1/users/me/threads?maxResults=100&labelIds=INBOX",
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

    // Step 2: Only fetch full thread data for threads that are new or have changed.
    // threads.list includes historyId per thread — it changes on any modification.
    const threadsToFetch = listData.threads.filter(t =>
      !gmailInboxCache[t.id] || gmailInboxCache[t.id].historyId !== t.historyId
    );

    if (threadsToFetch.length > 0) {
      // Fetch in batches of 5 to avoid per-second rate limits
      async function fetchInBatches(items, batchSize, fn) {
        const results = [];
        for (let i = 0; i < items.length; i += batchSize) {
          const batch = items.slice(i, i + batchSize);
          const batchResults = await Promise.all(batch.map(fn));
          results.push(...batchResults);
        }
        return results;
      }

      const fetched = await fetchInBatches(threadsToFetch, 5, async (t) => {
        const threadRes = await httpsGet(
          "gmail.googleapis.com",
          `/gmail/v1/users/me/threads/${t.id}?format=full`,
          { "Authorization": `Bearer ${accessToken}` }
        );
        const thread = JSON.parse(threadRes.body);
        if (thread.error) return null;
        const messages = (thread.messages || []).filter(m => m.payload);
        if (!messages.length) return null;
        if (messages.some(m => (m.labelIds || []).includes("CHAT"))) return null;

        const nonSent = messages.filter(m => !(m.labelIds || []).includes("SENT"));
        const displayMsg = (nonSent.length > 0 ? nonSent : messages)
          .reduce((a, b) => (Number(a.internalDate) >= Number(b.internalDate) ? a : b));

        const headers = displayMsg.payload?.headers || [];
        const get = (name) => headers.find(h => h.name === name)?.value || "";
        const from = get("From") || get("Reply-To") || get("Sender") || "";
        const subject = get("Subject");
        if (!from && !subject) return null;

        const plainPart = findPart(displayMsg.payload, "text/plain");
        const htmlPart  = findPart(displayMsg.payload, "text/html");
        const plainData = plainPart?.body?.data || displayMsg.payload?.body?.data || "";
        const htmlData  = htmlPart?.body?.data || "";

        const threadMessages = messages.map(m => {
          const mh = m.payload?.headers || [];
          const mGet = n => mh.find(h => h.name === n)?.value || "";
          const mPlain = findPart(m.payload, "text/plain");
          const mHtml  = findPart(m.payload, "text/html");
          const mPlainData = mPlain?.body?.data || m.payload?.body?.data || "";
          const mHtmlData  = mHtml?.body?.data || "";
          return {
            id: m.id, from: mGet("From") || mGet("Reply-To") || mGet("Sender") || "",
            to: mGet("To"), date: mGet("Date"), internalDate: Number(m.internalDate) || 0,
            snippet: m.snippet || "", isSent: (m.labelIds || []).includes("SENT"),
            body: decodeBody(mPlainData || mHtmlData).slice(0, 3000),
            bodyHtml: mHtmlData ? decodeRaw(mHtmlData) : "",
            attachments: findAttachments(m.payload), messageId: m.id,
          };
        });

        const data = {
          id: thread.id, threadId: thread.id, subject, from, to: get("To"),
          cc: get("Cc"), deliveredTo: get("Delivered-To"), date: get("Date"),
          internalDate: Number(displayMsg.internalDate) || 0, snippet: displayMsg.snippet || "",
          body: decodeBody(plainData || htmlData).slice(0, 3000),
          bodyHtml: htmlData ? decodeRaw(htmlData) : "",
          threadCount: messages.length, threadMessages,
          hasAttachment: messages.some(m => findAttachments(m.payload).length > 0),
        };

        // Store in cache keyed by thread ID with the historyId from the list response
        gmailInboxCache[t.id] = { historyId: t.historyId, data };
        return data;
      });

      // Update cache for any successfully fetched threads (nulls = errors, keep old cache entry)
      // (Cache is updated inline above; nothing extra needed here)
    }

    // Step 3: Evict threads that are no longer in the inbox
    const currentIds = new Set(listData.threads.map(t => t.id));
    for (const id of Object.keys(gmailInboxCache)) {
      if (!currentIds.has(id)) delete gmailInboxCache[id];
    }

    // Step 4: Return all threads in inbox order, served from cache
    const emails = listData.threads.map(t => gmailInboxCache[t.id]?.data).filter(Boolean);
    return { ok: true, emails };

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

// ── Newsletter archive check — fetch page to detect new content ────────────
ipcMain.handle("newsletter-check", async (_e, { url }) => {
  try {
    const urlObj = new URL(url);
    if (urlObj.protocol !== "https:") return { ok: false, error: "Only HTTPS URLs supported" };
    const res = await httpsGet(
      urlObj.hostname,
      urlObj.pathname + (urlObj.search || ""),
      { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
    );
    if (res.status < 200 || res.status >= 400) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, content: res.body.slice(0, 50000) };
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
      "/gmail/v1/users/me/messages?maxResults=100&labelIds=SENT",
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
        replyTo:      get("Reply-To"),
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

// ── Gmail Search (full history) ────────────────────────────────────────────
ipcMain.handle("gmail-search", async (_e, { query, folder }) => {
  try {
    const accessToken = await getValidAccessToken();

    // Step 1: Search messages using Gmail's native query syntax (covers full history)
    const searchRes = await httpsGet(
      "gmail.googleapis.com",
      `/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(query)}`,
      { "Authorization": `Bearer ${accessToken}` }
    );
    const searchData = JSON.parse(searchRes.body);
    if (searchData.error) return { ok: false, error: `Gmail API: ${searchData.error.message || JSON.stringify(searchData.error)}` };
    if (!searchData.messages) return { ok: true, emails: [] };

    // Step 2: Deduplicate to unique thread IDs (a thread may have multiple matching messages)
    const seenThreads = new Set();
    const uniqueThreadIds = [];
    for (const m of searchData.messages) {
      if (!seenThreads.has(m.threadId)) { seenThreads.add(m.threadId); uniqueThreadIds.push(m.threadId); }
    }

    // Helpers (same as gmail-list-inbox)
    function findPart(payload, mimeType) {
      if (!payload) return null;
      if (payload.mimeType === mimeType && payload.body?.data) return payload;
      for (const part of payload.parts || []) { const found = findPart(part, mimeType); if (found) return found; }
      return null;
    }
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
    async function fetchInBatches(items, batchSize, fn) {
      const results = [];
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(fn));
        results.push(...batchResults);
      }
      return results;
    }

    // Step 3: Fetch full thread data in batches of 5 (same as inbox)
    const threads = await fetchInBatches(uniqueThreadIds, 5, async (threadId) => {
      const threadRes = await httpsGet(
        "gmail.googleapis.com",
        `/gmail/v1/users/me/threads/${threadId}?format=full`,
        { "Authorization": `Bearer ${accessToken}` }
      );
      const thread = JSON.parse(threadRes.body);
      if (thread.error) return null;
      const messages = (thread.messages || []).filter(m => m.payload);
      if (!messages.length) return null;
      if (messages.some(m => (m.labelIds || []).includes("CHAT"))) return null;

      const nonSent = messages.filter(m => !(m.labelIds || []).includes("SENT"));
      const sentMsgs = messages.filter(m => (m.labelIds || []).includes("SENT"));
      // Skip threads that have no messages of the right type for the requested folder
      if (folder === "sent" && sentMsgs.length === 0) return null;
      if (folder !== "sent" && nonSent.length === 0) return null;
      // Sent view: focus on Matt's most recent sent message. Inbox view: most recent received.
      const candidates = folder === "sent"
        ? (sentMsgs.length > 0 ? sentMsgs : messages)
        : (nonSent.length > 0 ? nonSent : messages);
      const displayMsg = candidates.reduce((a, b) => (Number(a.internalDate) >= Number(b.internalDate) ? a : b));

      const headers = displayMsg.payload?.headers || [];
      const get = (name) => headers.find(h => h.name === name)?.value || "";
      const from = get("From") || get("Reply-To") || get("Sender") || "";
      const subject = get("Subject");
      if (!from && !subject) return null;

      const plainPart = findPart(displayMsg.payload, "text/plain");
      const htmlPart  = findPart(displayMsg.payload, "text/html");
      const plainData = plainPart?.body?.data || displayMsg.payload?.body?.data || "";
      const htmlData  = htmlPart?.body?.data || "";

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
        id:           thread.id,
        threadId:     thread.id,
        subject,
        from,
        replyTo:      get("Reply-To"),
        to:           get("To"),
        cc:           get("Cc"),
        deliveredTo:  get("Delivered-To"),
        date:         get("Date"),
        internalDate: Number(displayMsg.internalDate) || 0,
        snippet:      displayMsg.snippet || "",
        body:         decodeBody(plainData || htmlData).slice(0, 3000),
        bodyHtml:     htmlData ? decodeRaw(htmlData) : "",
        threadCount:  messages.length,
        threadMessages,
        hasAttachment: messages.some(m => findAttachments(m.payload).length > 0),
      };
    });

    return { ok: true, emails: threads.filter(Boolean) };
  } catch(e) {
    return { ok: false, error: e.message + (e.stack ? ' — ' + e.stack.split('\n')[1]?.trim() : '') };
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

// ── Open Graph preview fetch ───────────────────────────────────────────────
// The renderer can't fetch arbitrary URLs (CORS), so the detail-panel link
// preview asks main to fetch + parse the page. GETs the URL (http/https) with
// a 5s timeout, follows redirects, bails on non-HTML, and extracts OG/Twitter
// metadata via cheerio. Returns { title, image, description, hostname,
// favicon } (hostname/favicon always set on success) or null on any failure.
ipcMain.handle("fetch-open-graph", async (_e, { url }) => {
  function get(target, redirectsLeft) {
    return new Promise((resolve) => {
      let urlObj;
      try { urlObj = new URL(target); } catch { resolve(null); return; }
      if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") { resolve(null); return; }
      const lib = urlObj.protocol === "https:" ? https : http;
      const req = lib.request({
        hostname: urlObj.hostname,
        port: urlObj.port || undefined,
        path: (urlObj.pathname || "/") + (urlObj.search || ""),
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
        },
      }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, urlObj).toString(); } catch { resolve(null); return; }
          resolve(get(next, redirectsLeft - 1));
          return;
        }
        if (status < 200 || status >= 400) { res.resume(); resolve(null); return; }
        if (!(res.headers["content-type"] || "").toLowerCase().includes("text/html")) { res.resume(); resolve(null); return; }
        let data = "";
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 1_000_000) { req.destroy(); return; } // cap ~1MB; only <head> matters
          data += chunk;
        });
        res.on("end", () => resolve({ html: data, finalUrl: urlObj.toString() }));
      });
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.end();
    });
  }

  try {
    const result = await get(url, 5);
    if (!result || !result.html) return null;
    const $ = loadHtml(result.html);
    const base = new URL(result.finalUrl);
    const abs = (u) => { if (!u) return null; try { return new URL(u, base).toString(); } catch { return null; } };
    const meta = (...sels) => {
      for (const s of sels) {
        const v = ($(s).attr("content") || "").trim();
        if (v) return v;
      }
      return null;
    };
    const title = meta('meta[property="og:title"]', 'meta[name="og:title"]') || ($("title").first().text().trim() || null);
    const image = abs(meta('meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[property="twitter:image"]'));
    const description = meta('meta[property="og:description"]', 'meta[name="og:description"]', 'meta[name="description"]');
    const favicon = abs($('link[rel="icon"]').attr("href") || $('link[rel="shortcut icon"]').attr("href")) || `${base.protocol}//${base.host}/favicon.ico`;
    return { title, image, description, hostname: base.hostname, favicon };
  } catch {
    return null;
  }
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
