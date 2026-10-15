import type { OutputSource } from '../session/session-types.ts';

/**
 * Ingest output that something else already produced, such as the stream a Bun Shell pipeline
 * returned, as an owned session source. The stream or iterable must exist already: this creates no
 * process, builds no command and evaluates nothing. The session reads it without decoding or
 * splitting, cancels the reader (or calls `return()` on the iterator) when it is released, and
 * reports source completion when it ends rather than inventing an exit code.
 *
 * Pair it with a session that has no backend. Such a session is output-only: it advertises no
 * input, resize or kill, and its output is tagged `stdout` (the one channel the wire schema allows
 * an output-only session), never `pty`, so a consumer cannot mistake it for a terminal.
 */
export function createByteOutputSource(
  output: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): OutputSource {
  if ('getReader' in output && typeof output.getReader === 'function') {
    return { kind: 'stream', channel: 'stdout', stream: output };
  }
  if (Symbol.asyncIterator in output) {
    return { kind: 'iterable', channel: 'stdout', iterable: output };
  }
  throw new TypeError('output must be a ReadableStream or an async iterable of bytes');
}
