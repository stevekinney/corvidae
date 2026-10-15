import { describe, expect, test } from 'bun:test';

import { ManualClock } from '../session/fixtures/manual-clock.ts';
import type { OutputSource } from '../session/session-types.ts';
import { expectAttached, flush, Recorder, SESSION_ID } from '../session/session.test-support.ts';
import { Session } from '../session/session.ts';
import {
  bytesOnChannel,
  scenarioTest,
  settleScenarios,
  textOf,
} from './bun-process.test-support.ts';
import { createByteOutputSource } from './byte-output-source.ts';
import {
  createShellOutputIterable,
  createShellOutputStream,
  SHELL_OUTPUT_TEXT,
} from './fixtures/bun-shell-output.ts';

/** An output-only session over `source`, attached read-only, with every chunk reported parsed. */
function outputOnly(source: OutputSource) {
  const session = new Session({
    sessionId: SESSION_ID,
    profile: { profileId: 'bun-shell-output' },
    dimensions: { columns: 80, rows: 24 },
    clock: new ManualClock(),
    sources: [source],
  });
  const recorder = new Recorder();
  const attachment = expectAttached(
    session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener: (event) => {
        void recorder.listener(event);
        if (event.type === 'output') attachment.outputParsed(event.chunkId);
      },
    }),
  );
  return { session, recorder, attachment, started: session.start() };
}

describe('createByteOutputSource', () => {
  scenarioTest(
    'ingests a Bun Shell result as an owned stdout stream, without decoding it',
    async () => {
      const { session, recorder, attachment } = outputOnly(
        createByteOutputSource(await createShellOutputStream()),
      );
      const summary = await session.closed;
      expect(textOf(bytesOnChannel(recorder, 'stdout'))).toBe(SHELL_OUTPUT_TEXT);
      expect(summary).toMatchObject({
        cause: 'source-complete',
        cleanup: 'complete',
        quarantined: false,
      });
      expect(session.snapshot.ownership).toMatchObject({ process: 'none', sources: ['owned'] });
      expect(attachment.authority.capabilities).toEqual({
        mode: 'output-only',
        input: false,
        resize: false,
        kill: false,
        readOnly: true,
      });
    },
  );

  scenarioTest(
    'reports source completion, never an exit code, and never presents the feed as a terminal',
    async () => {
      const { session, recorder } = outputOnly(
        createByteOutputSource(await createShellOutputStream()),
      );
      await session.closed;
      expect(recorder.ofType('processExit')).toEqual([]);
      expect(recorder.ofType('sourceComplete')).toEqual([
        { type: 'sourceComplete', channel: 'stdout' },
      ]);
      expect(new Set(recorder.ofType('output').map((event) => event.channel))).toEqual(
        new Set(['stdout']),
      );
      expect(session.snapshot.process).toEqual({ kind: 'running' });
    },
  );

  scenarioTest(
    'ingests an async byte iterable, keeping the chunk boundaries it was given',
    async () => {
      const { session, recorder } = outputOnly(
        createByteOutputSource(createShellOutputIterable(5)),
      );
      await session.closed;
      expect(recorder.ofType('output').map((event) => event.bytes.length)).toEqual([
        5, 5, 5, 5, 5, 1,
      ]);
      expect(textOf(bytesOnChannel(recorder, 'stdout'))).toBe(SHELL_OUTPUT_TEXT);
    },
  );

  test('passes a code point cut by a chunk boundary through as bytes', async () => {
    const encoded = new TextEncoder().encode('日本 \u{1f600}');
    async function* oneByteAtATime(): AsyncGenerator<Uint8Array> {
      for (const byte of encoded) yield Uint8Array.of(byte);
    }
    const { session, recorder } = outputOnly(createByteOutputSource(oneByteAtATime()));
    await session.closed;
    const chunks = recorder.ofType('output').map((event) => event.bytes);
    expect(chunks.every((chunk) => chunk.length === 1)).toBe(true);
    expect(bytesOnChannel(recorder, 'stdout')).toEqual(encoded);
    expect(textOf(bytesOnChannel(recorder, 'stdout'))).not.toContain('�');
  });

  test('cancels an owned stream through its reader when the session is released', async () => {
    let canceled = 0;
    const endless = new ReadableStream<Uint8Array>({
      cancel() {
        canceled += 1;
      },
    });
    const { session, started } = outputOnly(createByteOutputSource(endless));
    await started;
    await flush();
    const summary = await session.dispose();
    expect(summary.cleanup).toBe('complete');
    expect(canceled).toBe(1);
  });

  test('calls return() on an owned iterator when the session is released', async () => {
    let returned = 0;
    const endless: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: async () => {
          returned += 1;
          return { done: true, value: undefined };
        },
      }),
    };
    const { session, started } = outputOnly(createByteOutputSource(endless));
    await started;
    await flush();
    const summary = await session.dispose();
    expect(summary.cleanup).toBe('complete');
    expect(returned).toBe(1);
  });

  test('refuses anything that is not a stream or an async iterable', () => {
    expect(() => createByteOutputSource({} as unknown as ReadableStream<Uint8Array>)).toThrow(
      TypeError,
    );
    expect(() => createByteOutputSource([new Uint8Array(1)] as never)).toThrow(TypeError);
  });
});

await settleScenarios();
