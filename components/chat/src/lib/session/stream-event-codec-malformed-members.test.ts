import { describe, expect, test } from 'bun:test';
import { hostileEvent } from './stream-event-codec-test-helpers.ts';
import { toChatStreamBlock } from './stream-event-codec-validation.ts';
import {
  type ChatStreamEvent,
  decodeChatStreamEvent,
  encodeChatStreamEvent,
} from './stream-event-codec.ts';

const INVALID = 'Invalid chat stream event';
const envelope = { wireVersion: 1, sequence: 1 } as const;

describe('decoding a member whose fields are the wrong type', () => {
  const cases: readonly {
    readonly name: string;
    readonly valid: Record<string, unknown>;
    readonly malformed: Record<string, unknown>;
  }[] = [
    {
      name: 'stream:text-delta with a content that is not text',
      valid: { type: 'stream:text-delta', content: 'a', accumulated: 'a', ...envelope },
      malformed: { type: 'stream:text-delta', content: 1, accumulated: 'a', ...envelope },
    },
    {
      name: 'stream:tool-call-start with a tool name that is not text',
      valid: { type: 'stream:tool-call-start', toolName: 'lookup', blockId: 'b', ...envelope },
      malformed: { type: 'stream:tool-call-start', toolName: 7, blockId: 'b', ...envelope },
    },
    {
      name: 'stream:tool-call-delta with partial arguments that are not text',
      valid: {
        type: 'stream:tool-call-delta',
        toolName: 'lookup',
        blockId: 'b',
        partialArguments: '{',
        ...envelope,
      },
      malformed: {
        type: 'stream:tool-call-delta',
        toolName: 'lookup',
        blockId: 'b',
        partialArguments: 7,
        ...envelope,
      },
    },
    {
      name: 'tool_call with arguments that are not JSON',
      valid: { type: 'tool_call', id: 'c', name: 'lookup', arguments: {} },
      malformed: { type: 'tool_call', id: 'c', name: 'lookup', arguments: undefined },
    },
    {
      name: 'tool.started with a tool name that is not text',
      valid: { type: 'tool.started', toolCallId: 'c', toolName: 'lookup', ...envelope },
      malformed: { type: 'tool.started', toolCallId: 'c', toolName: 7, ...envelope },
    },
    {
      name: 'tool.error with an error that is not JSON',
      valid: { type: 'tool.error', toolCallId: 'c', toolName: 'lookup', error: 'x', ...envelope },
      malformed: {
        type: 'tool.error',
        toolCallId: 'c',
        toolName: 'lookup',
        error: undefined,
        ...envelope,
      },
    },
    {
      name: 'tool.policy-denied with a reason that is not text',
      valid: {
        type: 'tool.policy-denied',
        toolCallId: 'c',
        toolName: 'lookup',
        reason: 'no',
        ...envelope,
      },
      malformed: {
        type: 'tool.policy-denied',
        toolCallId: 'c',
        toolName: 'lookup',
        reason: 7,
        ...envelope,
      },
    },
    {
      name: 'tool.progress with a tool call id that is not text',
      valid: { type: 'tool.progress', toolCallId: 'c', toolName: 'lookup', ...envelope },
      malformed: { type: 'tool.progress', toolCallId: 7, toolName: 'lookup', ...envelope },
    },
    {
      name: 'tool.progress with a percent that is not a number',
      valid: {
        type: 'tool.progress',
        toolCallId: 'c',
        toolName: 'lookup',
        percent: 5,
        ...envelope,
      },
      malformed: {
        type: 'tool.progress',
        toolCallId: 'c',
        toolName: 'lookup',
        percent: '5',
        ...envelope,
      },
    },
    {
      name: 'tool.progress with a message that is not text',
      valid: {
        type: 'tool.progress',
        toolCallId: 'c',
        toolName: 'lookup',
        message: 'working',
        ...envelope,
      },
      malformed: {
        type: 'tool.progress',
        toolCallId: 'c',
        toolName: 'lookup',
        message: 7,
        ...envelope,
      },
    },
    {
      name: 'run.aborted with a reason that is not text',
      valid: { type: 'run.aborted', reason: 'user', wireVersion: 3, sequence: 1 },
      malformed: { type: 'run.aborted', reason: 7, wireVersion: 3, sequence: 1 },
    },
  ];

  for (const { name, valid, malformed } of cases) {
    test(`refuses ${name}`, () => {
      expect(decodeChatStreamEvent(valid).type).toBe(valid['type'] as ChatStreamEvent['type']);
      expect(() => decodeChatStreamEvent(malformed)).toThrow(INVALID);
    });
  }

  test('refuses a frame that is not an object with a type', () => {
    for (const frame of ['[1]', '{"type":7}', '{}', '"text"']) {
      expect(() => decodeChatStreamEvent(frame)).toThrow(INVALID);
    }
  });
});

describe('a block that is read twice', () => {
  test('is refused when a field answers differently the second time', () => {
    const answers: unknown[] = ['b', 3];
    const block = {
      type: 'text',
      index: 0,
      content: 'x',
      complete: true,
      get id() {
        return answers.shift();
      },
    };
    expect(toChatStreamBlock(block)).toBeUndefined();
  });
});

describe('encoding and decoding the optional fields of a block and of usage', () => {
  test('round-trips a tool-call block with its tool name and partial arguments', () => {
    const event = {
      type: 'stream:block-delta',
      block: {
        id: 'block-1',
        type: 'tool-call',
        index: 0,
        content: '',
        complete: false,
        toolName: 'lookup',
        partialArguments: '{"query":',
      },
      delta: '"x"}',
      ...envelope,
    } as const;
    expect(decodeChatStreamEvent(JSON.parse(encodeChatStreamEvent(event)))).toEqual(event);
  });

  test('round-trips usage that reports cache tokens', () => {
    const event = {
      type: 'stream:usage',
      usage: {
        prompt: 10,
        completion: 5,
        total: 15,
        cacheCreationTokens: 2,
        cacheReadTokens: 3,
      },
      ...envelope,
    } as const;
    expect(decodeChatStreamEvent(JSON.parse(encodeChatStreamEvent(event)))).toEqual(event);
  });
});

describe('encoding a member that could not be decoded again', () => {
  test('refuses an assistant step whose number is negative', () => {
    expect(() =>
      encodeChatStreamEvent(
        hostileEvent({
          type: 'assistant.step.started',
          step: -1,
          messageId: 'm',
          wireVersion: 2,
          sequence: 1,
        }),
      ),
    ).toThrow('step must be a non-negative safe integer');
  });

  test('refuses an action descriptor the decoder would refuse', () => {
    expect(() =>
      encodeChatStreamEvent(
        hostileEvent({
          type: 'elicitation.requested',
          requestId: 'e',
          message: 'Approve?',
          action: {
            type: 'approval',
            message: 'Approve this call',
            risk: 'catastrophic',
            operation: { kind: 'command', command: 'echo approval' },
            policyVersion: 'test-policy',
            idempotencyKey: 'test-approval',
          },
          wireVersion: 2,
          sequence: 1,
        }),
      ),
    ).toThrow('action is not a valid tool action');
  });

  test('refuses an action whose list of files has a hole', () => {
    const filesTouched: string[] = [];
    filesTouched.length = 1;
    expect(() =>
      encodeChatStreamEvent(
        hostileEvent({
          type: 'elicitation.requested',
          requestId: 'e',
          message: 'Approve?',
          action: {
            type: 'approval',
            message: 'Approve this call',
            risk: 'high',
            operation: { kind: 'file-write', filesTouched, argsPreview: {} },
            policyVersion: 'test-policy',
            idempotencyKey: 'test-approval',
          },
          wireVersion: 2,
          sequence: 1,
        }),
      ),
    ).toThrow('action.operation.filesTouched[0] is missing');
  });
});
