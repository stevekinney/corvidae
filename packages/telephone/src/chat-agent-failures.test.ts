import { describe, expect, test } from 'bun:test';

import {
  AgentRunError,
  conversationWith,
  createChatAgent,
  createChatStreamWriter,
  createToolbox,
  decodeLines,
  disposeRun,
  expectWellFormedWire,
  ofType,
  pumpChatRun,
  requestContext,
  runAndCollect,
  startChatRun,
  type AgentRun,
  type StreamingGenerateFunction,
} from './chat-agent-test-helpers.ts';

const SAFE_MESSAGE = 'The assistant could not complete this turn.';

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

      await pumpChatRun(
        run,
        createChatStreamWriter((line) => lines.push(line)),
      );

      const frames = decodeLines(lines);
      expect(frames).toHaveLength(1);
      if (outcome === 'abort') {
        expect(frames[0]).toMatchObject({ type: 'run.aborted', reason: 'Stopped' });
      } else {
        expect(frames[0]).toMatchObject({
          type: 'run.error',
          error: { name: 'Error', kind: 'generate', code: 'UNKNOWN', message: SAFE_MESSAGE },
        });
        // `run.result()` rejecting is the one path where the raw cause is
        // closest to the wire, so the redaction matters most here.
        expect(lines.join('')).not.toContain('credential-canary');
      }
    },
  );

  test('surfaces kind: "generate" when the provider throws', async () => {
    const { frames, envelope } = await runAndCollect(simulatedProviderFailureGenerate);

    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('unreachable');
    expect(envelope.error.kind).toBe('generate');
    expect(envelope.error.message).toContain('simulated provider failure');

    // One terminal frame, even though Operative fires `run.error` AND a
    // `run.completed` (finishReason 'error') for the same failure. The frame
    // is a serialized run error with no `cause`: forwarding it is forbidden,
    // since it can carry a credential-bearing provider response.
    const [terminal] = ofType(frames, 'run.error');
    expect(terminal?.error.kind).toBe('generate');
    expect(terminal?.error.message).toBe(SAFE_MESSAGE);
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
    expect(streamError?.error).toEqual({ name: 'Error', message: SAFE_MESSAGE });
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
        message: SAFE_MESSAGE,
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
