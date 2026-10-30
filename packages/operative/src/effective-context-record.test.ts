/**
 * COR-1810 — the effective-context record kept with a reply: digests and message ids, never content,
 * within 256 KiB, newest messages kept when it has to be cut.
 */
import { describe, expect, it } from 'bun:test';
import { Conversation, withMessageId } from 'conversationalist';

import { createContextEpochSealer } from './context-epoch.ts';
import {
  composeEffectiveContext,
  composeEffectiveContextRecord,
  EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES,
  effectiveContextTail,
  isStoredEffectiveContext,
  rebuildEffectiveContexts,
  type StoredEffectiveContext,
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

  it('digests a tool row’s call or result, which its content does not hold', () => {
    const resultOf = (output: string): Conversation => {
      const conversation = new Conversation();
      conversation.appendMessages(
        withMessageId(
          {
            role: 'tool-call',
            content: '',
            toolCall: { id: 'call-1', name: 'lookup', arguments: { query: 'weather' } },
          },
          'call-row',
        ),
        withMessageId(
          {
            role: 'tool-result',
            content: '',
            toolResult: { callId: 'call-1', outcome: 'success', content: output },
          },
          'result-row',
        ),
      );
      return conversation;
    };
    const a = composeEffectiveContextRecord(seal(resultOf('sunny')), resultOf('sunny'));
    const b = composeEffectiveContextRecord(seal(resultOf('rain')), resultOf('rain'));

    expect(a.messages[0]!.digest).toBe(b.messages[0]!.digest);
    expect(a.messages[1]!.digest).not.toBe(b.messages[1]!.digest);
    expect(a.messages[1]!.digest).not.toBe(a.messages[0]!.digest);
    expect(JSON.stringify(a)).not.toContain('sunny');
    expect(JSON.stringify(a)).not.toContain('weather');
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

    const { record, stored } = composeEffectiveContext(seal(new Conversation()), conversation);

    expect(EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES).toBe(262_144);
    expect(stored.kind).toBe('full');
    expect(stored.messages).toEqual(record.messages);
    expect(bytesOf(stored)).toBeLessThanOrEqual(EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES);
    expect(bytesOf(record)).toBeLessThanOrEqual(EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES);
    expect(record.truncated).toBe(true);
    expect(record.messageCount).toBe(5000);
    expect(record.messages.length).toBeGreaterThan(0);
    expect(record.messages.length).toBeLessThan(5000);
    // The newest messages are the ones kept, in order.
    expect(record.messages.map((message) => message.id)).toEqual(
      all.slice(all.length - record.messages.length),
    );
    // And the stored record is as full as the cap allows: one more message would not fit.
    expect(bytesOf(stored) + bytesOf(record.messages[0]) + 1).toBeGreaterThan(
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

describe('stored effective contexts', () => {
  /** A run's conversation as step `step` sees it: seed rows, then each earlier step's reply and result. */
  function conversationBefore(step: number, rows: number = 1, seed: string = 'seed'): Conversation {
    const conversation = new Conversation();
    for (let index = 0; index < rows; index += 1) {
      conversation.appendMessages(
        withMessageId({ role: 'user', content: `${seed} ${index}` }, `seed-${index}`),
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

  /** Each conversation composed in turn, each stored relative to the one before, as a durable run stores them. */
  function storeRun(conversations: readonly Conversation[], limit?: number) {
    const records = [];
    const stored: StoredEffectiveContext[] = [];
    for (const conversation of conversations) {
      const previous = stored.at(-1);
      const composed = composeEffectiveContext(
        seal(conversation),
        conversation,
        previous === undefined ? undefined : effectiveContextTail(previous),
        limit,
      );
      records.push(composed.record);
      stored.push(composed.stored);
    }
    return { records, stored };
  }

  it('stores the first step whole and each later one as the rows added, however long the conversation', () => {
    const short = storeRun([0, 1, 2, 3, 4, 5].map((step) => conversationBefore(step)));
    const long = storeRun([199, 200].map((step) => conversationBefore(step)));

    expect(short.stored.map((entry) => entry.kind)).toEqual([
      'full',
      'delta',
      'delta',
      'delta',
      'delta',
      'delta',
    ]);
    const last = short.stored.at(-1)!;
    expect(last.kind === 'delta' && last.messagesFrom).toBe(1 + 4 * 2);
    expect(last.messages.map((message) => message.id)).toEqual([
      'run-1:step:4',
      'run-1:step:4:result:0',
    ]);
    const longDelta = long.stored[1]!;
    expect(longDelta.kind).toBe('delta');
    expect(longDelta.messages).toHaveLength(2);
    expect(longDelta.messageCount).toBe(1 + 200 * 2);
    expect(bytesOf(longDelta)).toBeLessThan(bytesOf(last) * 1.5);
    expect(short.stored.every(isStoredEffectiveContext)).toBe(true);
  });

  it('ties a delta to the conversation it extends by digest', () => {
    const { stored } = storeRun([conversationBefore(0), conversationBefore(1)]);
    const [first, second] = stored;

    expect(second!.kind).toBe('delta');
    expect(second!.kind === 'delta' && second!.prefixDigest).toBe(first!.conversationDigest);
    expect(first!.conversationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second!.version).toBe(1);
  });

  it('stores a step whole when an earlier row changed under the same id', () => {
    // A compaction or a memory withdrawal rewrites an earlier row; the ids alone still line up.
    const { stored } = storeRun([
      conversationBefore(1),
      conversationBefore(2, 1, 'rewritten seed'),
      conversationBefore(3, 1, 'rewritten seed'),
    ]);

    expect(stored.map((entry) => entry.kind)).toEqual(['full', 'full', 'delta']);
  });

  it('stores a step whole when the conversation lost rows', () => {
    const { stored } = storeRun([conversationBefore(4), conversationBefore(1)]);

    expect(stored.map((entry) => entry.kind)).toEqual(['full', 'full']);
  });

  it('stores a step whole when the rows it added would not fit in the cap', () => {
    const first = conversationBefore(0);
    const second = conversationBefore(30);
    const whole = bytesOf(composeEffectiveContextRecord(seal(second), second));
    const { stored } = storeRun([first, second], Math.floor(whole / 2));

    expect(stored[1]!.kind).toBe('full');
    expect(stored[1]!.kind === 'full' && stored[1]!.truncated).toBe(true);
    expect(bytesOf(stored[1])).toBeLessThanOrEqual(Math.floor(whole / 2));
  });

  it('rebuilds each step’s record from the stored records, equal to the record it was stored from', () => {
    const conversations = [
      conversationBefore(0),
      conversationBefore(1),
      conversationBefore(2, 1, 'compacted'),
      conversationBefore(3, 1, 'compacted'),
      conversationBefore(4, 1, 'compacted'),
    ];
    const { records, stored } = storeRun(conversations);

    expect(stored.map((entry) => entry.kind)).toEqual(['full', 'delta', 'full', 'delta', 'delta']);
    expect(rebuildEffectiveContexts(stored)).toEqual(records);
  });

  it('rebuilds a v1 delta whose prefix does not match the conversation before it as truncated', () => {
    const { records, stored } = storeRun([0, 1, 2, 3].map((step) => conversationBefore(step)));
    const mismatched = { ...stored[2]!, prefixDigest: 'sha256:not-the-previous-conversation' };

    const rebuilt = rebuildEffectiveContexts([stored[0], stored[1], mismatched, stored[3]]);

    expect(rebuilt[1]).toEqual(records[1]);
    for (const index of [2, 3]) {
      expect(rebuilt[index]?.truncated).toBe(true);
      expect(rebuilt[index]?.messageCount).toBe(records[index]!.messageCount);
      // Only the rows known to belong to the conversation are kept: the newest ones.
      const kept = rebuilt[index]!.messages;
      expect(kept).toEqual(
        records[index]!.messages.slice(records[index]!.messages.length - kept.length),
      );
      expect(kept.length).toBeLessThan(records[index]!.messages.length);
    }
  });

  it('rebuilds a leftover delta from another conversation as truncated, never onto the wrong rows', () => {
    // A regenerated run reuses the run id: its rows carry the same ids with other content.
    const original = storeRun([0, 1, 2, 3].map((step) => conversationBefore(step, 1, 'original')));
    const regenerated = storeRun([0, 1].map((step) => conversationBefore(step, 1, 'regenerated')));

    const rebuilt = rebuildEffectiveContexts([...regenerated.stored, ...original.stored.slice(2)]);

    expect(rebuilt.slice(0, 2)).toEqual(regenerated.records);
    expect(rebuilt[2]?.truncated).toBe(true);
    expect(rebuilt[3]?.truncated).toBe(true);
    expect(rebuilt[3]?.messages.at(-1)).toEqual(original.records[3]!.messages.at(-1));
    expect(rebuilt[3]?.messages.map((message) => message.id)).not.toContain('seed-0');
  });

  it('keeps reading the newest messages after a truncated full record, and says so', () => {
    const conversations = [0, 1, 2, 3].map((step) => conversationBefore(step, 30));
    const whole = bytesOf(
      composeEffectiveContextRecord(seal(conversations[0]!), conversations[0]!),
    );
    const { records, stored } = storeRun(conversations, Math.floor(whole / 2));

    expect(stored[0]!.kind === 'full' && stored[0]!.truncated).toBe(true);
    expect(stored.slice(1).map((entry) => entry.kind)).toEqual(['delta', 'delta', 'delta']);
    const rebuilt = rebuildEffectiveContexts(stored, () => true, Math.floor(whole / 2));
    expect(rebuilt).toEqual(records);
    expect(rebuilt[3]?.truncated).toBe(true);
  });

  it('caps a rebuilt record, keeping the newest messages and saying so', () => {
    const { records, stored } = storeRun([0, 1, 2, 3].map((step) => conversationBefore(step, 30)));
    const whole = bytesOf(records[3]);

    const [, , , last] = rebuildEffectiveContexts(stored, () => true, Math.floor(whole / 2));

    expect(last?.truncated).toBe(true);
    expect(last?.messageCount).toBe(records[3]!.messageCount);
    expect(last!.messages.length).toBeLessThan(records[3]!.messages.length);
    expect(last?.messages.at(-1)).toEqual(records[3]!.messages.at(-1));
    expect(bytesOf(last)).toBeLessThanOrEqual(Math.floor(whole / 2));
  });

  it('says a rebuilt record is truncated when the step it extends stored none', () => {
    const { records, stored } = storeRun([0, 1, 2].map((step) => conversationBefore(step)));

    const rebuilt = rebuildEffectiveContexts([undefined, stored[1], stored[2]]);

    expect(rebuilt[0]).toBeUndefined();
    expect(rebuilt[2]?.truncated).toBe(true);
    expect(rebuilt[2]?.messages.at(-1)).toEqual(records[2]!.messages.at(-1));
  });

  it('carries the chain across a step that stored none', () => {
    const { records, stored } = storeRun([0, 1].map((step) => conversationBefore(step)));

    const rebuilt = rebuildEffectiveContexts([stored[0], undefined, stored[1]]);

    expect(rebuilt[1]).toBeUndefined();
    expect(rebuilt[2]).toEqual(records[1]);
  });

  it('reads a record it cannot read as none, and does not extend across it', () => {
    const { records, stored } = storeRun([0, 1, 2].map((step) => conversationBefore(step)));
    // A record of another version, or an unversioned one, is not this format.
    const unknown = { ...stored[1]!, version: 2 };
    const unversioned = { messagesFrom: 1, messages: stored[1]!.messages, messageCount: 3 };

    for (const unreadable of [unknown, unversioned]) {
      const rebuilt = rebuildEffectiveContexts([stored[0], unreadable, stored[2]]);
      expect(rebuilt[1]).toBeUndefined();
      expect(rebuilt[2]?.truncated).toBe(true);
      expect(rebuilt[2]?.messages.at(-1)).toEqual(records[2]!.messages.at(-1));
    }
  });

  it('starts from the latest full record at or before the step asked for', () => {
    const conversations = [
      conversationBefore(0),
      conversationBefore(1),
      conversationBefore(2, 1, 'compacted'),
      conversationBefore(3, 1, 'compacted'),
    ];
    const { records, stored } = storeRun(conversations);
    // Whatever came before the reset point does not reach the steps after it.
    const corrupted = [{ ...stored[0]!, version: 99 }, stored[1], stored[2], stored[3]];

    const rebuilt = rebuildEffectiveContexts(corrupted, (index) => index === 3);

    expect(rebuilt).toEqual([undefined, undefined, undefined, records[3]]);
  });

  it('never returns a list as complete unless it has its conversation’s digest', () => {
    const { records, stored } = storeRun([0, 1].map((step) => conversationBefore(step)));
    const forged = {
      ...stored[0]!,
      messages: [{ id: 'seed-0', role: 'user', digest: 'ffffffffffffffff' }],
    };

    const rebuilt = rebuildEffectiveContexts([forged, stored[1]]);

    expect(rebuilt[0]?.truncated).toBe(true);
    expect(rebuilt[0]?.messages).toEqual([]);
    expect(rebuilt[1]?.truncated).toBe(true);
    expect(rebuilt[1]?.messages).toEqual(records[1]!.messages.slice(1));
  });
});
