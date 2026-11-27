/**
 * Minimal Server-Sent Events reader over `fetch()` streaming responses
 * (plan §5.2, T1.4). This is the actual transport implementation for
 * `FleetEventSource`, not a test-only fallback.
 *
 * Why not the platform `EventSource`: neither Bun's native test runtime nor
 * happy-dom (`tests/setup.ts`) implements `EventSource` at all (verified
 * empirically, not assumed) — but even in a real browser, `EventSource`
 * would not work for weft's fleet feed. The server
 * (`weft/src/server/operations/sse-stream.ts` `createEventEnvelopeSSEStream`)
 * emits every real envelope with an explicit `event: <envelope.kind>` field
 * (one of ~32 kinds, e.g. `event: workflow:completed`) and heartbeats as
 * `event: ping` — it never emits the unnamed `event: message` default.
 * `EventSource.onmessage` only fires for that unnamed default, so it would
 * never see a single real frame; the only alternative,
 * `addEventListener(kind, …)`, would require the console to hardcode and
 * maintain its own duplicate copy of every kind string weft might ever
 * emit (`EVENTS_READ_EVENT_TYPES` is not a public export), which drifts by
 * construction. A raw fetch-stream reader sidesteps both problems: it reads
 * the `event:`/`data:`/`id:` fields generically, so it forwards whatever
 * `event` name the server sends, known or not, and runs identically in a
 * browser and in `bun test`.
 */

import {
  parseServerSentEventChunk,
  type ServerSentEventFrame,
} from '@lostgradient/backchannel/client';

/**
 * Reads a `text/event-stream` `Response` body as a sequence of parsed
 * frames. Stops when the body ends, `signal` aborts, or the response has no
 * body. Releases the reader lock in every case (including an abort or a
 * consumer `break`).
 */
export async function* readServerSentEventStream(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ServerSentEventFrame, void, void> {
  if (response.body === null) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remainder = '';

  try {
    while (!isAborted(signal)) {
      const chunk = await reader.read();
      if (chunk.done) return;

      const parsed = parseServerSentEventChunk(
        decoder.decode(chunk.value, { stream: true }),
        remainder,
      );
      remainder = parsed.remainder;
      for (const frame of parsed.frames) {
        yield frame;
        if (isAborted(signal)) return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Wrapped in a function (rather than inlining `signal?.aborted`) so
// TypeScript's control-flow narrowing doesn't treat the *outer* `while`
// condition as pinning `signal.aborted`'s value for the rest of the loop
// body — `AbortSignal.aborted` is a live, externally-mutated property, and
// re-reading it through a call keeps each check independent.
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
