import { describe, expect, test } from 'bun:test';
import type { AgentRun, StreamingGenerateFunction } from './chat-agent-test-helpers';
import {
  AgentRunError,
  conversationWith,
  createChatAgent,
  createChatStreamWriter,
  createConversationHistory,
  createToolbox,
  decodeLines,
  disposeRun,
  expectWellFormedWire,
  ofType,
  parseServerOwnedPersistenceFailureHint,
  pumpChatRun,
  requestContext,
  runAndCollect,
  serverOwnedPersistenceFailureHint,
  startChatRun,
} from './chat-agent-test-helpers';

const providerFailedGenerate: StreamingGenerateFunction = async () => {
  throw new Error('provider failed');
};

const providerExplodedGenerate: StreamingGenerateFunction = async () => {
  throw new Error('provider exploded');
};

const simulatedProviderFailureGenerate: StreamingGenerateFunction = async () => {
  throw new Error('simulated provider failure');
};

const providerCredentialFailureGenerate: StreamingGenerateFunction = async () => {
  throw new Error('provider exploded', {
    cause: { headers: { authorization: 'Bearer sk-secret' } },
  });
};

function runWithRejectedResult(cause: unknown): AgentRun {
  const lines: string[] = [];
  const writer = createChatStreamWriter((line) => lines.push(line));
  const agent = createChatAgent({
    generate: async () => ({ content: '', toolCalls: [] }),
    toolbox: createToolbox([]),
    requestContext,
    writer,
  });
  const run = startChatRun(agent, conversationWith('hello'));
  Object.defineProperty(run, 'result', {
    value: async () => {
      throw cause;
    },
  });
  return run;
}

describe('pumpChatRun: provider failure', () => {
  test.each(['failure', 'abort'] as const)(
    'handles a rejected result as %s without inventing a conversation',
    async (outcome) => {
      const lines: string[] = [];
      const cause =
        outcome === 'abort'
          ? new DOMException('Stopped', 'AbortError')
          : new Error('credential-canary');
      const run = runWithRejectedResult(cause);
      let persistenceCalls = 0;
      await pumpChatRun(
        run,
        createChatStreamWriter((line) => lines.push(line)),
        {
          beforeFailure: async () => {
            persistenceCalls += 1;
          },
        },
      );
      const frames = decodeLines(lines);
      expect(persistenceCalls).toBe(0);
      expect(frames).toHaveLength(1);
      if (outcome === 'abort') {
        expect(frames[0]).toMatchObject({ type: 'run.aborted', reason: 'Stopped' });
      } else {
        expect(frames[0]).toMatchObject({
          type: 'run.error',
          error: {
            name: 'Error',
            kind: 'generate',
            code: 'UNKNOWN',
            message: 'The turn outcome could not be saved.',
            retryable: false,
          },
        });
        expect(lines.join('')).not.toContain('credential-canary');
      }
    },
  );

  test('awaits failure persistence before writing the terminal frame', async () => {
    const lines: string[] = [];
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => (release = resolve));
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => (startedResolve = resolve));
    const pending = runAndCollect(
      providerFailedGenerate,
      createToolbox([]),
      lines,
      [],
      async () => {
        startedResolve();
        expect(lines.some((line) => line.includes('run.error'))).toBe(false);
        await persisted;
      },
    );
    await started;
    expect(lines.some((line) => line.includes('run.error'))).toBe(false);
    release();
    await pending;
  });

  test('emits one safe terminal when failure persistence rejects', async () => {
    const { frames, envelope } = await runAndCollect(
      providerExplodedGenerate,
      createToolbox([]),
      [],
      [],
      async () => {
        throw new Error('storage unavailable');
      },
    );
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN', message: 'The turn outcome could not be saved.', retryable: false },
    });
    expect(ofType(frames, 'run.error')).toHaveLength(1);
    expect(ofType(frames, 'run.error')[0]?.error).toMatchObject({
      name: 'Error',
      code: 'UNKNOWN',
      message: 'The turn outcome could not be saved.',
    });
    const hint = ofType(frames, 'stream:error')
      .map((frame) => frame.error)
      .find((error) => parseServerOwnedPersistenceFailureHint(error) !== undefined);
    expect(parseServerOwnedPersistenceFailureHint(hint)).toBeDefined();
    expect(frames.findIndex((frame) => frame.type === 'stream:error')).toBeLessThan(
      frames.findIndex((frame) => frame.type === 'run.error'),
    );
    expect(
      parseServerOwnedPersistenceFailureHint({
        ...serverOwnedPersistenceFailureHint('test-user'),
        extra: true,
      }),
    ).toBeUndefined();
    expect(
      parseServerOwnedPersistenceFailureHint({
        ...serverOwnedPersistenceFailureHint('test-user'),
        userMessageId: '',
      }),
    ).toBeUndefined();
  });

  test('does not emit an unsaved hint when the run has no user identity', async () => {
    const { frames } = await runAndCollect(
      providerExplodedGenerate,
      createToolbox([]),
      [],
      [],
      async () => {
        throw new Error('storage unavailable');
      },
      createConversationHistory({ id: 'no-user' }),
    );
    expect(
      ofType(frames, 'stream:error').filter((frame) =>
        parseServerOwnedPersistenceFailureHint(frame.error),
      ),
    ).toHaveLength(0);
    expect(ofType(frames, 'run.error')).toHaveLength(1);
  });

  test('surfaces kind: "generate" when the provider throws', async () => {
    const { frames, envelope } = await runAndCollect(simulatedProviderFailureGenerate);

    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('unreachable');
    expect(envelope.error.kind).toBe('generate');
    expect(envelope.error.message).toContain('simulated provider failure');

    // One terminal frame, even though Operative fires `run.error` AND a
    // `run.completed` (finishReason 'error') for the same failure — originally verified
    // against 0.8.0 directly. The frame is a serialized run error with no
    // `cause`: the reference architecture's error contract forbids forwarding
    // it, since it can carry a credential-bearing provider response.
    const [terminal] = ofType(frames, 'run.error');
    expect(terminal?.error.kind).toBe('generate');
    expect(terminal?.error.message).toBe('The assistant could not complete this turn.');
    expect(JSON.stringify(frames)).not.toContain('simulated provider failure');
    expect(terminal?.error).not.toHaveProperty('cause');
    expect(ofType(frames, 'run.completed')).toHaveLength(0);
  });

  test('a stream:error raised by the wrapper is forwarded with a JSON-safe error, never the cause', async () => {
    // `withEnhancedStreaming` dispatches `stream:error` from its own catch
    // when `generate` throws — with the thrown value itself as `error`.
    // Model a provider failure whose `cause` is a credential-bearing
    // response: neither it nor the stack may reach the wire.
    const { frames } = await runAndCollect(providerCredentialFailureGenerate);

    const [streamError] = ofType(frames, 'stream:error');
    expect(streamError?.error).toEqual({
      name: 'Error',
      message: 'The assistant could not complete this turn.',
    });
    expect(JSON.stringify(frames)).not.toContain('sk-secret');
    expect(JSON.stringify(frames)).not.toContain('provider exploded');
    expect(ofType(frames, 'run.error')).toHaveLength(1);
  });

  test.each(['classified', 'plain'] as const)(
    'redacts credential canaries from every emitted frame for a %s provider error',
    async (shape) => {
      const canary = 'CredentialInProviderMessageCanary';
      const cause = { authorization: canary, stack: canary };
      const error =
        shape === 'classified'
          ? new AgentRunError(canary, { kind: 'generate', code: 'UNKNOWN', cause })
          : { name: canary, message: canary, cause, response: { headers: cause } };
      if (error instanceof Error) error.name = canary;
      const lines: string[] = [];
      const { frames } = await runAndCollect(
        async () => {
          throw error;
        },
        createToolbox([]),
        lines,
      );
      expect(lines.join('')).not.toContain(canary);
      expect(ofType(frames, 'stream:error')).toHaveLength(1);
      expect(ofType(frames, 'run.error')[0]?.error).toMatchObject({
        name: 'Error',
        kind: 'generate',
        message: 'The assistant could not complete this turn.',
      });
      expectWellFormedWire(frames);
    },
  );
});

describe('pumpChatRun: aborted request', () => {
  test('surfaces kind: "abort" when the run is aborted mid-generate', async () => {
    // Deterministic coordination, not a wall-clock delay: the generate
    // function resolves `abortListenerReady` the instant its own abort
    // listener is registered, and the test awaits that signal before calling
    // `run.abort()` — so the abort always lands after the listener exists,
    // with no timing threshold to tune or race.
    let signalAbortListenerReady: () => void;
    const abortListenerReady = new Promise<void>((resolve) => {
      signalAbortListenerReady = resolve;
    });
    const generate: StreamingGenerateFunction = (context) =>
      new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('generate aborted')));
        signalAbortListenerReady();
      });

    const lines: string[] = [];
    const writer = createChatStreamWriter((line) => lines.push(line));
    const agent = createChatAgent({ generate, toolbox: createToolbox([]), requestContext, writer });
    const run = startChatRun(agent, conversationWith('hello'));

    await abortListenerReady;
    run.abort('test abort');

    const envelope = await pumpChatRun(run, writer).finally(() => disposeRun(run));

    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('unreachable');
    expect(envelope.error.kind).toBe('abort');
    expect(envelope.error.code).toBe('ABORTED');

    const frames = decodeLines(lines);
    expectWellFormedWire(frames);
    expect(frames.at(-1)).toMatchObject({ type: 'run.aborted' });
  });
});
