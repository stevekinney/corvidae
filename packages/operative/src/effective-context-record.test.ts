/**
 * COR-1810 — the effective-context record kept with a reply: digests and message ids, never content,
 * within 256 KiB, newest messages kept when it has to be cut.
 */
import { describe, expect, it } from 'bun:test';
import { Conversation, withMessageId } from 'conversationalist';

import { createContextEpochSealer } from './context-epoch.ts';
import {
  composeEffectiveContextRecord,
  EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES,
  rebuildEffectiveContexts,
  toEffectiveContextDelta,
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

describe('effective-context deltas', () => {
  /** A run's conversation as step `step` sees it: a user row, then each earlier step's reply and result. */
  function conversationBefore(step: number, rows: number = 1): Conversation {
    const conversation = new Conversation();
    for (let index = 0; index < rows; index += 1) {
      conversation.appendMessages(
        withMessageId({ role: 'user', content: `seed ${index}` }, `seed-${index}`),
      );
    }
    for (let earlier = 0; earlier < step; earlier += 1) {
      conversation.appendMessages(
        withMessageId({ role: 'assistant', content: `reply ${earlier}` }, `run-1:step:${earlier}`),
        withMessageId(
          { role: 'user', content: `result ${earlier}` },
          `run-1:step:${earlier}:result:0`,
        ),
      );
    }
    return conversation;
  }

  const recordOf = (step: number, rows?: number) => {
    const conversation = conversationBefore(step, rows);
    return composeEffectiveContextRecord(seal(conversation), conversation);
  };

  it('keeps only the rows the previous step committed, however long the conversation', () => {
    const short = toEffectiveContextDelta(recordOf(5), 'run-1', 5);
    const long = toEffectiveContextDelta(recordOf(200), 'run-1', 200);

    expect(short.messages.map((message) => message.id)).toEqual([
      'run-1:step:4',
      'run-1:step:4:result:0',
    ]);
    expect(long.messages).toHaveLength(2);
    expect(long.messagesFrom).toBe(1 + 199 * 2);
    expect(long.messageCount).toBe(1 + 200 * 2);
    expect(bytesOf(long)).toBeLessThan(bytesOf(short) * 1.5);
  });

  it('keeps every message the record holds for a step with no earlier step’s rows', () => {
    const delta = toEffectiveContextDelta(recordOf(0, 3), 'run-1', 0);

    expect(delta.messagesFrom).toBe(0);
    expect(delta.messages).toHaveLength(3);
  });

  it('rebuilds each step’s record from the deltas, equal to the record it was cut from', () => {
    const records = [0, 1, 2, 3, 4].map((step) => recordOf(step));
    const deltas = records.map((record, step) => toEffectiveContextDelta(record, 'run-1', step));

    const rebuilt = rebuildEffectiveContexts(deltas);

    expect(rebuilt).toEqual(records);
  });

  it('caps a rebuilt record, keeping the newest messages and saying so', () => {
    const records = [0, 1, 2, 3].map((step) => recordOf(step, 30));
    const deltas = records.map((record, step) => toEffectiveContextDelta(record, 'run-1', step));
    const whole = bytesOf(records[3]);

    const [, , , last] = rebuildEffectiveContexts(deltas, () => true, Math.floor(whole / 2));

    expect(last?.truncated).toBe(true);
    expect(last?.messageCount).toBe(records[3]!.messageCount);
    expect(last!.messages.length).toBeLessThan(records[3]!.messages.length);
    expect(last?.messages.at(-1)).toEqual(records[3]!.messages.at(-1));
    expect(bytesOf(last)).toBeLessThanOrEqual(Math.floor(whole / 2));
  });

  it('says a rebuilt record is truncated when an earlier step stored none', () => {
    const records = [0, 1, 2].map((step) => recordOf(step));
    const deltas = records.map((record, step) =>
      step === 0 ? undefined : toEffectiveContextDelta(record, 'run-1', step),
    );

    const rebuilt = rebuildEffectiveContexts(deltas);

    expect(rebuilt[0]).toBeUndefined();
    expect(rebuilt[2]?.truncated).toBe(true);
    expect(rebuilt[2]?.messages.at(-1)).toEqual(records[2]!.messages.at(-1));
  });

  it('leaves out steps the caller did not ask for', () => {
    const deltas = [0, 1].map((step) => toEffectiveContextDelta(recordOf(step), 'run-1', step));

    const rebuilt = rebuildEffectiveContexts(deltas, (index) => index === 1);

    expect(rebuilt[0]).toBeUndefined();
    expect(rebuilt[1]?.messageCount).toBe(deltas[1]!.messageCount);
  });
});
