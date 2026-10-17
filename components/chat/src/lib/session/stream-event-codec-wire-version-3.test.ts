import { describe, expect, test } from 'bun:test';
import { expectRejected, hostileEvent } from './stream-event-codec-test-helpers.ts';
import {
  decodeChatStreamEvent,
  decodeChatStreamEvents,
  encodeChatStreamEvent,
  guardChatStreamEvents,
  isSupportedWireVersion,
  SUPPORTED_WIRE_VERSIONS,
  type ChatStreamEvent,
} from './stream-event-codec.ts';

/**
 * Wire version 3 adds `run.started` and a required `messageId` on
 * `stream:text-delta`, so the stream maps losslessly onto AG-UI `RUN_STARTED`
 * and `TEXT_MESSAGE_*`. Versions 1 and 2 keep decoding exactly as before.
 */
describe('wire version 3', () => {
  test('is a supported version, and 4 is not', () => {
    expect(SUPPORTED_WIRE_VERSIONS).toEqual([1, 2, 3]);
    expect(isSupportedWireVersion(3)).toBe(true);
    expect(isSupportedWireVersion(4)).toBe(false);
    expect(isSupportedWireVersion('3')).toBe(false);
  });

  test('still rejects a version outside the supported set through the codec error path', () => {
    for (const type of ['run.started', 'stream:text-delta', 'text'] as const) {
      const frame = {
        type,
        runId: 'run-1',
        content: 'h',
        accumulated: 'h',
        messageId: 'm',
        text: 'h',
        wireVersion: 4,
        sequence: 0,
      };
      expect(() => decodeChatStreamEvent(frame)).toThrow('Invalid chat stream event');
    }
    expect(() =>
      encodeChatStreamEvent(
        hostileEvent({ type: 'run.started', runId: 'run-1', wireVersion: 4, sequence: 0 }),
      ),
    ).toThrow('cannot encode a malformed wire envelope');
  });

  describe('run.started', () => {
    const started: ChatStreamEvent = {
      type: 'run.started',
      runId: 'run-1',
      wireVersion: 3,
      sequence: 0,
    };

    test('round-trips through the encoder and decoder', () => {
      expect(decodeChatStreamEvent(encodeChatStreamEvent(started))).toEqual(started);
      expect(decodeChatStreamEvent(JSON.parse(encodeChatStreamEvent(started)))).toEqual(started);
    });

    test('is refused below wire version 3, when decoding and encoding', () => {
      for (const wireVersion of [1, 2]) {
        expect(() =>
          decodeChatStreamEvent({ type: 'run.started', runId: 'run-1', wireVersion, sequence: 0 }),
        ).toThrow('Invalid chat stream event');
        expect(() =>
          encodeChatStreamEvent(
            hostileEvent({ type: 'run.started', runId: 'run-1', wireVersion, sequence: 0 }),
          ),
        ).toThrow('run.started requires wire version 3');
      }
    });

    test('requires a string runId and a wire envelope', () => {
      for (const runId of [undefined, 7, null, {}]) {
        expect(() =>
          decodeChatStreamEvent({ type: 'run.started', runId, wireVersion: 3, sequence: 0 }),
        ).toThrow('Invalid chat stream event');
      }
      expect(() => decodeChatStreamEvent({ type: 'run.started', runId: 'run-1' })).toThrow(
        'Invalid chat stream event',
      );
      expect(() =>
        encodeChatStreamEvent(
          hostileEvent({ type: 'run.started', runId: 7, wireVersion: 3, sequence: 0 }),
        ),
      ).toThrow('Invalid chat stream event');
    });

    test('is not terminal: a stream continues past it and still needs its terminal frame', async () => {
      const aborted: ChatStreamEvent = { type: 'run.aborted', wireVersion: 3, sequence: 1 };
      const complete = encodeChatStreamEvent(started) + encodeChatStreamEvent(aborted);
      expect(await Array.fromAsync(decodeChatStreamEvents(complete))).toEqual([started, aborted]);
      await expectRejected(
        Array.fromAsync(decodeChatStreamEvents(encodeChatStreamEvent(started))),
        'ended without a terminal frame',
      );
    });

    test('shares one version with the rest of its stream', async () => {
      const text: ChatStreamEvent = { type: 'text', text: 'hi', wireVersion: 2, sequence: 1 };
      await expectRejected(
        Array.fromAsync(
          decodeChatStreamEvents(encodeChatStreamEvent(started) + encodeChatStreamEvent(text)),
        ),
        'wire version changed mid-stream',
      );
    });
  });

  describe('stream:text-delta messageId', () => {
    const delta: ChatStreamEvent = {
      type: 'stream:text-delta',
      content: 'lo',
      accumulated: 'hello',
      messageId: 'message-1',
      wireVersion: 3,
      sequence: 2,
    };

    test('round-trips at version 3', () => {
      expect(decodeChatStreamEvent(encodeChatStreamEvent(delta))).toEqual(delta);
    });

    test('is required at version 3, when decoding and encoding', () => {
      for (const messageId of [undefined, 7, null]) {
        expect(() =>
          decodeChatStreamEvent({
            type: 'stream:text-delta',
            content: 'lo',
            accumulated: 'hello',
            messageId,
            wireVersion: 3,
            sequence: 2,
          }),
        ).toThrow('Invalid chat stream event');
      }
      expect(() =>
        encodeChatStreamEvent(
          hostileEvent({
            type: 'stream:text-delta',
            content: 'lo',
            accumulated: 'hello',
            wireVersion: 3,
            sequence: 2,
          }),
        ),
      ).toThrow('Invalid chat stream event');
    });

    test('is absent from versions 1 and 2, which decode exactly as before', () => {
      for (const wireVersion of [1, 2] as const) {
        const legacy: ChatStreamEvent = {
          type: 'stream:text-delta',
          content: 'lo',
          accumulated: 'hello',
          wireVersion,
          sequence: 2,
        };
        expect(decodeChatStreamEvent(encodeChatStreamEvent(legacy))).toEqual(legacy);
        // A field the version does not define is neither carried nor written.
        const smuggled = {
          type: 'stream:text-delta',
          content: 'lo',
          accumulated: 'hello',
          messageId: 'message-1',
          wireVersion,
          sequence: 2,
        };
        expect(decodeChatStreamEvent(smuggled)).toEqual(legacy);
        expect(JSON.parse(encodeChatStreamEvent(hostileEvent(smuggled)))).toEqual({
          type: 'stream:text-delta',
          content: 'lo',
          accumulated: 'hello',
          wireVersion,
          sequence: 2,
        });
      }
    });

    test("carries the enclosing step's messageId across a full version 3 stream", async () => {
      const frames: ChatStreamEvent[] = [
        { type: 'run.started', runId: 'run-1', wireVersion: 3, sequence: 0 },
        {
          type: 'assistant.step.started',
          step: 0,
          messageId: 'message-1',
          wireVersion: 3,
          sequence: 1,
        },
        {
          type: 'stream:text-delta',
          content: 'he',
          accumulated: 'he',
          messageId: 'message-1',
          wireVersion: 3,
          sequence: 2,
        },
        {
          type: 'stream:text-delta',
          content: 'llo',
          accumulated: 'hello',
          messageId: 'message-1',
          wireVersion: 3,
          sequence: 3,
        },
        {
          type: 'assistant.step.completed',
          step: 0,
          messageId: 'message-1',
          wireVersion: 3,
          sequence: 4,
        },
        { type: 'run.aborted', wireVersion: 3, sequence: 5 },
      ];
      const decoded = await Array.fromAsync(
        decodeChatStreamEvents(frames.map((frame) => encodeChatStreamEvent(frame)).join('')),
      );
      expect(decoded).toEqual(frames);
      const stepMessageId = decoded.find((frame) => frame.type === 'assistant.step.started');
      for (const frame of decoded) {
        if (frame.type === 'stream:text-delta' && stepMessageId?.type === 'assistant.step.started')
          expect(frame.messageId).toBe(stepMessageId.messageId);
      }
    });
  });

  describe('stream opening and identity', () => {
    const open: ChatStreamEvent = {
      type: 'run.started',
      runId: 'run-1',
      wireVersion: 3,
      sequence: 0,
    };
    const step = (sequence: number): ChatStreamEvent => ({
      type: 'assistant.step.started',
      step: 0,
      messageId: 'message-1',
      wireVersion: 3,
      sequence,
    });
    const delta = (messageId: string, sequence: number): ChatStreamEvent => ({
      type: 'stream:text-delta',
      content: 'hi',
      accumulated: 'hi',
      messageId,
      wireVersion: 3,
      sequence,
    });
    const closed = (sequence: number): ChatStreamEvent => ({
      type: 'run.aborted',
      wireVersion: 3,
      sequence,
    });
    const ndjson = (frames: ChatStreamEvent[]) =>
      frames.map((f) => encodeChatStreamEvent(f)).join('');
    const typed = async function* (frames: ChatStreamEvent[]): AsyncGenerator<ChatStreamEvent> {
      yield* frames;
    };

    test('a version 3 stream must open with run.started, as bytes and as typed events', async () => {
      const frames: ChatStreamEvent[] = [step(0), closed(1)];
      await expectRejected(
        Array.fromAsync(decodeChatStreamEvents(ndjson(frames))),
        'must open with run.started',
      );
      await expectRejected(
        Array.fromAsync(guardChatStreamEvents(typed(frames))),
        'must open with run.started',
      );
    });

    test('a stream that opens with run.started is accepted', async () => {
      const frames: ChatStreamEvent[] = [open, step(1), delta('message-1', 2), closed(3)];
      expect(await Array.fromAsync(decodeChatStreamEvents(ndjson(frames)))).toEqual(frames);
      expect(await Array.fromAsync(guardChatStreamEvents(typed(frames)))).toEqual(frames);
    });

    test('versions 1 and 2 are not required to open with run.started', async () => {
      const text: ChatStreamEvent = { type: 'text', text: 'hi', wireVersion: 2, sequence: 0 };
      const end: ChatStreamEvent = { type: 'run.aborted', wireVersion: 2, sequence: 1 };
      expect(await Array.fromAsync(decodeChatStreamEvents(ndjson([text, end])))).toEqual([
        text,
        end,
      ]);
    });

    test('a delta for a message other than the open step is rejected', async () => {
      const frames: ChatStreamEvent[] = [open, step(1), delta('other', 2), closed(3)];
      await expectRejected(
        Array.fromAsync(decodeChatStreamEvents(ndjson(frames))),
        'does not match the open assistant step',
      );
      await expectRejected(
        Array.fromAsync(guardChatStreamEvents(typed(frames))),
        'does not match the open assistant step',
      );
    });

    test('a delta outside any step is rejected, before one opens and after it completes', async () => {
      const completed: ChatStreamEvent = {
        type: 'assistant.step.completed',
        step: 0,
        messageId: 'message-1',
        wireVersion: 3,
        sequence: 3,
      };
      for (const frames of [
        [open, delta('message-1', 1), closed(2)],
        [open, step(1), delta('message-1', 2), completed, delta('message-1', 4), closed(5)],
      ])
        await expectRejected(
          Array.fromAsync(decodeChatStreamEvents(ndjson(frames))),
          'does not match the open assistant step',
        );
    });

    test('completing a different message leaves the step open', async () => {
      const wrongCompletion: ChatStreamEvent = {
        type: 'assistant.step.completed',
        step: 0,
        messageId: 'other',
        wireVersion: 3,
        sequence: 2,
      };
      const frames: ChatStreamEvent[] = [
        open,
        step(1),
        wrongCompletion,
        delta('message-1', 3),
        closed(4),
      ];
      expect(await Array.fromAsync(decodeChatStreamEvents(ndjson(frames)))).toEqual(frames);
    });
  });

  describe('run.started thread and parent identity', () => {
    test('round-trips with either, both, or neither', () => {
      for (const extra of [
        {},
        { threadId: 'thread-1' },
        { parentRunId: 'run-0' },
        { threadId: 'thread-1', parentRunId: 'run-0' },
      ]) {
        const event: ChatStreamEvent = {
          type: 'run.started',
          runId: 'run-1',
          ...extra,
          wireVersion: 3,
          sequence: 0,
        };
        expect(decodeChatStreamEvent(encodeChatStreamEvent(event))).toEqual(event);
      }
    });

    test('rejects a threadId or parentRunId that is not a string, when decoding and encoding', () => {
      for (const field of ['threadId', 'parentRunId']) {
        const frame = {
          type: 'run.started',
          runId: 'run-1',
          [field]: 7,
          wireVersion: 3,
          sequence: 0,
        };
        expect(() => decodeChatStreamEvent(frame)).toThrow('Invalid chat stream event');
        expect(() => encodeChatStreamEvent(hostileEvent(frame))).toThrow(
          'Invalid chat stream event',
        );
      }
    });
  });

  test('members introduced by version 2 stay legal at version 3', () => {
    const step: ChatStreamEvent = {
      type: 'assistant.step.started',
      step: 0,
      messageId: 'message-1',
      wireVersion: 3,
      sequence: 1,
    };
    const elicitation: ChatStreamEvent = {
      type: 'elicitation.resolved',
      requestId: 'request-1',
      accepted: true,
      wireVersion: 3,
      sequence: 2,
    };
    for (const event of [step, elicitation])
      expect(decodeChatStreamEvent(encodeChatStreamEvent(event))).toEqual(event);
  });
});
