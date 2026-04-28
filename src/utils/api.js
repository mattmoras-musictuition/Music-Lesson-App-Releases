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

// Stream a chat request — words appear as they're generated rather than all at once.
// Works in both Electron (IPC channel) and browser dev mode (native ReadableStream).
// callbacks: { onChunk(text), onEnd(usage|null), onError(message, isAuthError) }
export function anthropicStreamChat(url, options, { onChunk, onEnd, onError }) {
  // ── Tool call accumulator — collects tool_use blocks during streaming ────
  // toolState.pending: blocks in progress, keyed by SSE content block index
  // toolState.calls: completed tool calls [ { id, name, input } ]
  // toolState.text: accumulated text content (for building history after tool use)
  const toolState = { pending: {}, calls: [], text: "" };

  // Guard: onEnd must only fire once — parseLine fires it with real usage data
  // (message_delta event), and the stream-end handler fires it with null.
  // Without this flag, the caller gets two onEnd calls on every successful response,
  // causing a spurious second React render to strip the streaming flag.
  // onEnd signature: (usage, toolCalls, textContent)
  let endFired = false;
  const safeOnEnd = (usage) => { if (!endFired) { endFired = true; onEnd(usage, toolState.calls, toolState.text); } };

  // ── Helper: parse raw SSE lines into events ──────────────────────────────
  function parseLine(line, inputTokensRef) {
    if (!line.startsWith("data: ")) return;
    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") return;
    try {
      const evt = JSON.parse(raw);
      if (evt.type === "message_start") {
        inputTokensRef.value = evt.message?.usage?.input_tokens || 0;
      } else if (evt.type === "content_block_start") {
        // Track tool_use blocks so we can accumulate their JSON input
        const cb = evt.content_block;
        if (cb?.type === "tool_use") {
          toolState.pending[evt.index] = { id: cb.id, name: cb.name, jsonAccum: "" };
        }
      } else if (evt.type === "content_block_delta") {
        if (evt.delta?.type === "text_delta") {
          toolState.text += evt.delta.text;
          onChunk(evt.delta.text);
        } else if (evt.delta?.type === "input_json_delta") {
          // Accumulate streamed JSON for the tool's input object
          if (toolState.pending[evt.index]) {
            toolState.pending[evt.index].jsonAccum += evt.delta.partial_json;
          }
        }
      } else if (evt.type === "content_block_stop") {
        // Finalise any completed tool_use block
        const block = toolState.pending[evt.index];
        if (block) {
          try { block.input = JSON.parse(block.jsonAccum || "{}"); } catch { block.input = {}; }
          toolState.calls.push({ id: block.id, name: block.name, input: block.input });
          delete toolState.pending[evt.index];
        }
      } else if (evt.type === "message_delta" && evt.usage) {
        safeOnEnd({ input_tokens: inputTokensRef.value, output_tokens: evt.usage.output_tokens || 0 });
      }
    } catch {}
  }

  if (window.electronAPI?.anthropicStream) {
    // ── Electron path: IPC streaming channel ────────────────────────────────
    const streamId = Math.random().toString(36).slice(2) + Date.now();
    const inputTokensRef = { value: 0 };
    let buffer = "";

    window.electronAPI.anthropicStreamListen(
      streamId,
      (rawChunk) => {
        buffer += rawChunk;
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep any incomplete line
        for (const line of lines) parseLine(line, inputTokensRef);
      },
      () => { safeOnEnd(null); },
      (message, status) => {
        const isAuth = status === 401 || status === 403;
        onError(message, isAuth);
      }
    );

    window.electronAPI.anthropicStream(
      streamId, url, options.method || "POST", options.headers || {}, options.body || ""
    );
  } else {
    // ── Browser/dev path: native fetch with ReadableStream ───────────────────
    (async () => {
      try {
        const response = await fetch(url, options);
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          const isAuth = response.status === 401 || response.status === 403;
          onError(data.error?.message || `HTTP ${response.status}`, isAuth);
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const inputTokensRef = { value: 0 };
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) { safeOnEnd(null); break; }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) parseLine(line, inputTokensRef);
        }
      } catch(e) {
        onError(e.message, false);
      }
    })();
  }
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
