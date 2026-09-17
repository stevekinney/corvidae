import { expect, test } from 'bun:test';
import { decodeChatStreamEvent, encodeChatStreamEvent } from './stream-event-codec';

test.each(['stream:unknown', 'tool.unknown'])(
  'rejects unsupported %s encoder discriminators even with valid family fields',
  (type) => {
    const event = Object.create(
      null,
      Object.getOwnPropertyDescriptors({
        type,
        error: 'failure',
        toolCallId: 'call-1',
        toolName: 'tool-1',
        wireVersion: 1,
        sequence: 0,
      }),
    );
    expect(() => encodeChatStreamEvent(event)).toThrow('unsupported type');
  },
);

function inheritedDecoder() {
  return { type: 'stream:error', error: 'inherited decoder', wireVersion: 1, sequence: 0 };
}

test('ignores inherited decoder names when rejecting an unsupported stream event', () => {
  const type = 'stream:unknown';
  const objectPrototype = Object.getPrototypeOf({});
  const previous = Object.getOwnPropertyDescriptor(objectPrototype, type);
  Object.defineProperty(objectPrototype, type, { value: inheritedDecoder, configurable: true });
  try {
    expect(() => decodeChatStreamEvent({ type, wireVersion: 1, sequence: 0 })).toThrow(
      'Invalid chat stream event',
    );
  } finally {
    if (previous === undefined) Reflect.deleteProperty(objectPrototype, type);
    else Object.defineProperty(objectPrototype, type, previous);
  }
});
