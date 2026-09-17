import { describe, expect, test } from 'bun:test';
import { expectRejected } from './stream-event-codec-test-helpers.ts';
import {
  decodeChatStreamEvent,
  decodeChatStreamEvents,
  encodeChatStreamEvent,
} from './stream-event-codec.ts';

async function* splitChunks(): AsyncGenerator<string> {
  yield '{"type":"text","text":"hel';
  yield 'lo"}\n{"type":"text","text":"!"}\n';
}

describe('chat stream event codec', () => {
  test('round-trips events without provider-specific types', () => {
    const event = {
      type: 'tool_result' as const,
      callId: 'call-1',
      outcome: 'success' as const,
      content: { ok: true },
    };
    expect(decodeChatStreamEvent(encodeChatStreamEvent(event))).toEqual(event);
  });

  test('round-trips a tool_result carrying an error field', () => {
    const event = {
      type: 'tool_result' as const,
      callId: 'call-1',
      outcome: 'error' as const,
      content: null,
      error: {
        code: 'TIMEOUT',
        category: 'timeout' as const,
        retryable: true,
        message: 'timed out',
        details: { elapsedMs: 5000 },
      },
    };
    expect(decodeChatStreamEvent(encodeChatStreamEvent(event))).toEqual(event);
  });

  test('preserves a JSON-safe signed pending approval extension', () => {
    const event = {
      type: 'tool_result' as const,
      callId: 'call-approval',
      outcome: 'action_required' as const,
      content: 'Save this note?',
      action: { type: 'approval' as const, message: 'Save this note?' },
      pendingApproval: {
        callId: 'call-approval',
        toolName: 'remember_note',
        arguments: { text: 'A note' },
        approvalToken: 'a'.repeat(64),
      },
    };

    expect(decodeChatStreamEvent(encodeChatStreamEvent(event))).toEqual(event);
  });

  test('rejects a tool_result whose shape is wrong even though it is plain JSON', () => {
    // Reaches the branch's own rejection rather than the plain-data rebuild's:
    // every value here is JSON, the shape is simply not a `ChatToolResult`.
    expect(() =>
      decodeChatStreamEvent({
        type: 'tool_result',
        callId: 'call-1',
        outcome: 'not-an-outcome',
        content: null,
      }),
    ).toThrow('Invalid chat stream event');
  });

  test('rejects a non-JSON pending approval extension', () => {
    expect(() =>
      decodeChatStreamEvent({
        type: 'tool_result',
        callId: 'call-approval',
        outcome: 'action_required',
        content: null,
        pendingApproval: { approvalToken: Symbol('invalid') },
      }),
    ).toThrow('Invalid chat stream event');
  });

  test('decodes split newline-delimited chunks', async () => {
    expect(await Array.fromAsync(decodeChatStreamEvents(splitChunks()))).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: '!' },
    ]);
  });

  test('decodes newline-delimited events from a string', async () => {
    expect(
      await Array.fromAsync(
        decodeChatStreamEvents(
          '{"type":"text","text":"first"}\n\n{"type":"text","text":"second"}\n',
        ),
      ),
    ).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
  });

  test('rejects malformed events', () => {
    expect(() => decodeChatStreamEvent({ type: 'text' })).toThrow('Invalid chat stream event');
    expect(() => decodeChatStreamEvent('{not json')).toThrow();
  });

  test('decodes a ReadableStream of UTF-8 NDJSON', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"text","text":"streamed"}\n'));
        controller.close();
      },
    });
    expect(await Array.fromAsync(decodeChatStreamEvents(stream))).toEqual([
      { type: 'text', text: 'streamed' },
    ]);
  });

  test('releases the reader lock when cancellation rejects without replacing the primary error', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{invalid}\n'));
      },
      cancel() {
        return Promise.reject(new Error('cancel failed'));
      },
    });
    await expectRejected(Array.fromAsync(decodeChatStreamEvents(stream)));
    expect(stream.locked).toBe(false);
  });

  // crossed the wire.
});
