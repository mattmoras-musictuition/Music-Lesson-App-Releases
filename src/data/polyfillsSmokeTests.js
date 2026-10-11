// ============================================================
// polyfills.js — ReadableStream async iteration (v2.49.21).
// Electron 29's Chromium 122 lacks it, so pdf.js getTextContent() threw
// and the specialist grid import silently sent no measured times.
// Called from runSmokeTests with its `assert`; async parts report via
// `assertAsync` because runSmokeTests itself is synchronous.
// ============================================================

import { polyfillReadableStreamAsyncIterator } from "../polyfills";

// A stand-in stream with only getReader(), like Chromium 122's.
function makeFakeStream(chunks, log) {
  class FakeStream {
    getReader() {
      let i = 0;
      return {
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel: async () => { log.push("cancel"); },
        releaseLock: () => { log.push("release"); },
      };
    }
  }
  return FakeStream;
}

export function runPolyfillTests(assert, assertAsync) {
  const log = [];
  const Fake = makeFakeStream(["a", "b", "c"], log);
  assert("polyfill: missing before", typeof Fake.prototype[Symbol.asyncIterator], "undefined");
  assert("polyfill: installs when absent", polyfillReadableStreamAsyncIterator(Fake), true);
  assert("polyfill: present after", typeof Fake.prototype[Symbol.asyncIterator], "function");
  const installed = Fake.prototype[Symbol.asyncIterator];
  assert("polyfill: second call is a no-op", polyfillReadableStreamAsyncIterator(Fake), false);
  assert("polyfill: second call keeps the first", Fake.prototype[Symbol.asyncIterator], installed);

  const native = function NativeLike() {};
  const nativeIter = async function* () {};
  native.prototype[Symbol.asyncIterator] = nativeIter;
  assert("polyfill: native left alone", [polyfillReadableStreamAsyncIterator(native), native.prototype[Symbol.asyncIterator] === nativeIter], [false, true]);
  assert("polyfill: no ReadableStream → no-op", polyfillReadableStreamAsyncIterator(undefined), false);

  assertAsync("polyfill: iterates to the end, then releases", (async () => {
    const out = [];
    for await (const c of new Fake()) out.push(c);
    return [out, log.slice()];
  })(), [["a", "b", "c"], ["release"]]);

  const log2 = [];
  const Fake2 = makeFakeStream(["x", "y", "z"], log2);
  polyfillReadableStreamAsyncIterator(Fake2);
  assertAsync("polyfill: early break cancels then releases", (async () => {
    const out = [];
    for await (const c of new Fake2()) { out.push(c); if (c === "y") break; }
    return [out, log2.slice()];
  })(), [["x", "y"], ["cancel", "release"]]);
}
