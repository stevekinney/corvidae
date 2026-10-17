import { describe, expect, test } from 'bun:test';
import { expectRejected, hostileEvent } from './stream-event-codec-test-helpers.ts';
import {
  decodeChatStreamEvent,
  decodeChatStreamEvents,
  encodeChatStreamEvent,
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
