import {
  appendMessages,
  appendUnsafeMessage,
  createConversationHistory as createConversation,
  createConversationHistoryUnsafe as createConversationUnsafe,
} from '../src/conversation/index';
import type { ConversationHistory as Conversation } from '../src/types';

export const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `test-id-${++counter}`;
  })(),
};

export function createBasicConversation(): Conversation {
  let conv = createConversation({ id: 'test' }, testEnvironment);
  conv = appendMessages(
    conv,
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there! How can I help you?' },
    testEnvironment,
  );
  return conv;
}

export function createToolCallConversation(): Conversation {
  let conv = createConversation({ id: 'test' }, testEnvironment);
  conv = appendMessages(
    conv,
    { role: 'user', content: 'What is the weather?' },
    {
      role: 'tool-call',
      content: '',
      toolCall: {
        id: 'call-123',
        name: 'get_weather',
        arguments: JSON.stringify({ location: 'NYC' }),
      },
    },
    {
      role: 'tool-result',
      content: '',
      toolResult: {
        callId: 'call-123',
        outcome: 'success',
        content: { temperature: 72, conditions: 'sunny' },
      },
    },
    { role: 'assistant', content: 'The weather in NYC is 72°F and sunny.' },
    testEnvironment,
  );
  return conv;
}

export function createMultiModalConversation(): Conversation {
  let conv = createConversation({ id: 'test' }, testEnvironment);
  conv = appendMessages(
    conv,
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/image.jpg' } },
      ],
    },
    { role: 'assistant', content: 'I see a cat.' },
    testEnvironment,
  );
  return conv;
}

export function createBrokenToolConversation(): Conversation {
  let conv = createConversationUnsafe({ id: 'broken' }, testEnvironment);
  conv = appendUnsafeMessage(
    conv,
    {
      role: 'tool-result',
      content: '',
      toolResult: { callId: 'missing', outcome: 'success', content: { ok: true } },
    },
    testEnvironment,
  );
  return conv;
}

export type TestRecord = Record<string, unknown> & {
  readonly args?: unknown;
  readonly cache_control?: unknown;
  readonly content?: unknown;
  readonly data?: unknown;
  readonly fileData?: TestRecord;
  readonly fileUri?: unknown;
  readonly functionCall?: TestRecord;
  readonly functionResponse?: TestRecord;
  readonly id?: unknown;
  readonly is_error?: unknown;
  readonly inlineData?: TestRecord;
  readonly input?: unknown;
  readonly mimeType?: unknown;
  readonly name?: unknown;
  readonly response?: unknown;
  readonly source?: TestRecord;
  readonly signature?: unknown;
  readonly text?: unknown;
  readonly thinking?: unknown;
  readonly type?: unknown;
  readonly tool_use_id?: unknown;
  readonly url?: unknown;
};
export type TestRecordArray = Array<TestRecord> & { readonly [index: number]: TestRecord };

export function requireRecord(value: unknown): TestRecord {
  if (!isRecord(value)) throw new Error('Expected record');
  return value;
}

export function requireRecordArray(value: unknown): TestRecordArray {
  if (!isRecordArray(value)) throw new Error('Expected record array');
  return value;
}

export function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}

function isRecord(value: unknown): value is TestRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is TestRecordArray {
  return Array.isArray(value) && value.every(isRecord);
}
