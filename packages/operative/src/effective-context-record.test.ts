/**
 * COR-1810 — the effective-context record kept with a reply: digests and message ids, never content,
 * within 256 KiB, newest messages kept when it has to be cut.
 */
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createContextEpochSealer } from './context-epoch.ts';
import {
  composeEffectiveContextRecord,
  EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES,
} from './effective-context-record.ts';

const BODY = 'DISTINCTIVE-MESSAGE-BODY-7c1e';

function seal(conversation: Conversation) {
  return createContextEpochSealer({ newEpochId: () => 'epoch-1' }).seal({
    conversation,
    consumer: { runId: 'run-1', step: 0, attempt: 0 },
  });
}

const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

describe('composeEffectiveContextRecord', () => {
  it('keeps every message id, role and content digest, and no content', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage(`${BODY} question`);
    conversation.appendAssistantMessage(`${BODY} answer`);

    const record = composeEffectiveContextRecord(seal(conversation), conversation);

    expect(record.epochId).toBe('epoch-1');
    expect(record.messageCount).toBe(2);
    expect(record.truncated).toBe(false);
    expect(record.messages.map((message) => message.id)).toEqual(
      conversation.getMessages().map((message) => message.id),
    );
    expect(record.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(record.messages.every((message) => /^[0-9a-f]{16}$/.test(message.digest))).toBe(true);
    expect(JSON.stringify(record).includes(BODY)).toBe(false);
  });

  it('records the sources the epoch bound, steering included', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('hello');
    const epoch = createContextEpochSealer({ newEpochId: () => 'epoch-2' }).seal({
      conversation,
      steering: { paused: false, configVersion: 4, model: 'gpt-4o' },
      consumer: { runId: 'run-1', step: 0, attempt: 0 },
    });

    const record = composeEffectiveContextRecord(epoch, conversation);

    const steeringSource = record.sources.find((source) => source.sourceId === 'steering-desired');
    expect(steeringSource).toMatchObject({ disposition: 'included', revision: 4 });
    expect(record.sources.find((source) => source.sourceId === 'selection-plan')?.disposition).toBe(
      'absent-by-composition',
    );
  });

  it('digests a message’s content so a changed message changes its digest', () => {
    const first = new Conversation();
    first.appendUserMessage('one');
    const second = new Conversation();
    second.appendUserMessage('two');

    const a = composeEffectiveContextRecord(seal(first), first);
    const b = composeEffectiveContextRecord(seal(second), second);

    expect(a.messages[0]!.digest).not.toBe(b.messages[0]!.digest);
  });

  it('is cut to the newest messages within 256 KiB, and says so', () => {
    // A conversation this long takes minutes to build through the real controller, and the record
    // reads only its messages, so a stand-in holds them.
    const messages = Array.from({ length: 5000 }, (_, index) => ({
      id: `message-${index}`,
      role: 'user',
      content: `message ${index}`,
    }));
    const conversation = { getMessages: () => messages } as unknown as Conversation;
    const all = messages.map((message) => message.id);

    const record = composeEffectiveContextRecord(seal(new Conversation()), conversation);

    expect(EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES).toBe(262_144);
    expect(bytesOf(record)).toBeLessThanOrEqual(EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES);
    expect(record.truncated).toBe(true);
    expect(record.messageCount).toBe(5000);
    expect(record.messages.length).toBeGreaterThan(0);
    expect(record.messages.length).toBeLessThan(5000);
    // The newest messages are the ones kept, in order.
    expect(record.messages.map((message) => message.id)).toEqual(
      all.slice(all.length - record.messages.length),
    );
    // And it is as full as the cap allows: one more message would not fit.
    expect(bytesOf(record) + bytesOf(record.messages[0]) + 1).toBeGreaterThan(
      EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES,
    );
  });

  it('leaves a record that fits untouched, and keeps none when only the sources fit', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('hello');
    const epoch = seal(conversation);

    expect(composeEffectiveContextRecord(epoch, conversation).truncated).toBe(false);

    const tight = composeEffectiveContextRecord(epoch, conversation, 1);
    expect(tight.messages).toEqual([]);
    expect(tight.truncated).toBe(true);
    expect(tight.messageCount).toBe(1);
  });
});
