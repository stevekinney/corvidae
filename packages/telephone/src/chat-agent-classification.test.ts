import { describe, expect, test } from 'bun:test';
import type { StreamingGenerateFunction } from './chat-agent-test-helpers.ts';
import {
  AbortAgentRunError,
  AgentRunError,
  OutputValidationError,
  classifyChatRunFailure,
  conversationWith,
  createAgent,
  createToolbox,
  freshEventTarget,
  requestContext,
  stopWhen,
  withEnhancedStreaming,
} from './chat-agent-test-helpers.ts';

function providerFailure(status: number): AgentRunError {
  return new AgentRunError('The provider rejected the request.', {
    kind: 'generate',
    code: 'UNKNOWN',
    cause: Object.assign(new Error('upstream'), { status }),
  });
}

const doneGenerate: StreamingGenerateFunction = async ({ streaming }) => {
  streaming.update('done');
  return { content: 'done', toolCalls: [] };
};

describe('classifyChatRunFailure', () => {
  test('maps an AgentRunError to its kind/code/message', () => {
    const error = new AgentRunError('boom', { kind: 'policy', code: 'TRIPWIRE' });
    const envelope = classifyChatRunFailure(error, 'error');
    expect(envelope).toEqual({
      ok: false,
      status: 'error',
      error: { kind: 'policy', code: 'TRIPWIRE', message: 'boom', retryable: false },
    });
  });

  test('routes kind: "abort" to status "aborted" regardless of fallbackStatus', () => {
    const error = new AbortAgentRunError('stopped');
    const envelope = classifyChatRunFailure(error, 'error');
    expect(envelope).toEqual({
      ok: false,
      status: 'aborted',
      error: { kind: 'abort', code: 'ABORTED', message: 'stopped' },
    });
  });

  // Pins CIN-434's confirmed fact: output-validation failures are an
  // `AgentRunError` with `kind: 'output'`, `code: 'INVALID_OUTPUT'`.
  // `OutputValidationError` is the concrete class Operative throws for this
  // (from `AgentRun.output()` / `.unwrap()`, not from `run.result()` — see
  // the doc comment on `classifyChatRunFailure`), so constructing one
  // directly here exercises the real shape rather than a hand-rolled
  // stand-in. It replaced `StandardSchemaValidationError`, which 0.10.0
  // removed with no alias.
  test('maps an OutputValidationError to kind: "output", code: "INVALID_OUTPUT"', () => {
    const error = new OutputValidationError(new Error('expected an object'));
    const envelope = classifyChatRunFailure(error, 'error');
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('unreachable');
    expect(envelope.error.kind).toBe('output');
    expect(envelope.error.code).toBe('INVALID_OUTPUT');
  });

  // Operative's code union grows on its own schedule; the chat wire's does
  // not. `decodeChatStreamEvent` rejects a frame whose code it does not know,
  // so a code that reached the wire verbatim would take the entire terminal
  // frame down with it and the client would see no failure at all. Reverting
  // `toChatWireErrorCode` to pass `error.code` through fails this test.
  test('reports an Operative code the chat wire does not admit as UNKNOWN', () => {
    const error = new AgentRunError('no such agent handle', {
      kind: 'generate',
      code: 'INVALID_AGENT_HANDLE',
    });
    const envelope = classifyChatRunFailure(error, 'error');
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('unreachable');
    expect(envelope.error.code).toBe('UNKNOWN');
    expect(envelope.error.message).toBe('no such agent handle');
  });

  // The route branches on `error.kind === 'abort'` to choose between closing
  // the stream cleanly and calling `controller.error(...)`. `0.7.0` resolves
  // `result()` on abort, so this rejection path is not exercised today — but
  // Operative documents `result()` as REJECTING on abort, so a version that
  // follows its own documentation, or that surfaces the signal's own
  // `DOMException` instead of an `AgentRunError`, must not turn a user
  // pressing "stop generating" into an error banner they never caused.
  test('classifies a non-AgentRunError rejection on the abort path as an abort', () => {
    const envelope = classifyChatRunFailure(new Error('The operation was aborted'), 'aborted');
    // No `retryable` on an abort: it is a user decision, not a failure, and
    // a "you can try that again" disposition on a deliberate stop would be
    // nonsense.
    expect(envelope).toEqual({
      ok: false,
      status: 'aborted',
      error: { kind: 'abort', code: 'ABORTED', message: 'The operation was aborted' },
    });
  });

  test('classifies a non-Error rejection on the abort path as an abort', () => {
    expect(classifyChatRunFailure('stopped', 'aborted')).toMatchObject({
      status: 'aborted',
      error: { kind: 'abort' },
    });
  });

  describe('retryability', () => {
    /**
     * `classifyError` reads `statusCode`/`status` off the value it is
     * handed. An `AgentRunError` carries neither — the provider's status is
     * on the SDK error it wrapped — so these pin that the CAUSE is what
     * gets classified. Classifying the wrapper reports every provider
     * failure as terminal, including the ones a retry would fix.
     */
    test('reports a rate-limited provider as retryable', () => {
      expect(classifyChatRunFailure(providerFailure(429), 'error').error.retryable).toBe(true);
    });

    test('reports a server error as retryable', () => {
      expect(classifyChatRunFailure(providerFailure(503), 'error').error.retryable).toBe(true);
    });

    test('reports a rejected credential as terminal', () => {
      // The distinction the whole field exists for: same `kind`, same
      // `code`, same sentence — and retrying one is free while retrying
      // the other can only fail again.
      expect(classifyChatRunFailure(providerFailure(401), 'error').error.retryable).toBe(false);
    });

    test('reports a malformed request as terminal', () => {
      expect(classifyChatRunFailure(providerFailure(400), 'error').error.retryable).toBe(false);
    });

    test('states nothing when the classifier throws', () => {
      // A classifier that blows up must not take the error frame with it:
      // the client still needs to hear that the turn failed.
      const hostile = new AgentRunError('boom', {
        kind: 'generate',
        code: 'UNKNOWN',
        cause: new Proxy(
          {},
          {
            get() {
              throw new Error('nope');
            },
          },
        ),
      });
      const envelope = classifyChatRunFailure(hostile, 'error');
      expect(envelope.error.message).toBe('boom');
      expect('retryable' in envelope.error).toBe(false);
    });
  });

  test('falls back to kind: "generate" for a plain, unclassified error', () => {
    const envelope = classifyChatRunFailure(new Error('network blip'), 'error');
    expect(envelope).toEqual({
      ok: false,
      status: 'error',
      error: { kind: 'generate', code: 'UNKNOWN', message: 'network blip', retryable: false },
    });
  });
});

// Sanity check that `createAgent`/`withEnhancedStreaming` (the primitives
// `createChatAgent` composes) are wired the way this file assumes — a
// regression in `createChatAgent`'s own composition would still pass the
// tests above if it happened to swap in equivalent-looking pieces, so this
// exercises `createAgent` directly with the same `stopWhen` combination.
describe('createChatAgent composition', () => {
  test('the production stopWhen combination still stops a plain text-only run at step 1', async () => {
    const agent = createAgent({
      generate: withEnhancedStreaming(doneGenerate, { eventTarget: freshEventTarget() }),
      toolbox: createToolbox([]),
      executeOptions: { requestContext },
      stopWhen: [
        stopWhen.noToolCalls(),
        stopWhen.pendingApproval(),
        (step) => step.toolCalls.length > 0,
      ],
    });
    const result = await agent.run({ conversation: conversationWith('hi') }).result();
    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('done');
  });
});
