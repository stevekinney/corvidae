/**
 * COR-1369 — compaction accounts for every message it receives.
 *
 * Hidden messages are kept, never silently dropped; kept messages come
 * through a commit untouched (same id, `createdAt`, `goalCompleted`, and
 * content, with no second plugin pass); and the stored summary is exactly
 * `result.summaryContent`. Each rule is checked on the synchronous
 * `compactConversation` path and on the revisioned compare-and-swap path
 * behind `Conversation.compact()`.
 */
import { describe, expect, it } from 'bun:test';

import { compactConversation } from '../src/compaction/compact';
import type { CompactionOptions, CompactionResult, Summarizer } from '../src/compaction/types';
import { appendMessages, createConversationHistory } from '../src/conversation/index';
import { Conversation } from '../src/history';
import { defineMessagePlugin } from '../src/index';
import type { ConversationHistory, Message, MessageInput, MessagePlugin } from '../src/types';

const summarizer: Summarizer = async (messages) => `Summary of ${messages.length} messages`;

type Plugin = MessagePlugin;

/** Prefixes string content, standing in for any non-idempotent message plugin. */
const prefixPlugin: Plugin = defineMessagePlugin({ id: 'prefix', revision: 1 }, (input) =>
  typeof input.content === 'string' ? { ...input, content: `[t]${input.content}` } : input,
);

function build(inputs: MessageInput[]): ConversationHistory {
  let history = createConversationHistory({ id: 'hidden' });
  for (const input of inputs) history = appendMessages(history, input);
  return history;
}

/** Hidden system, four user/assistant pairs, a hidden pinned user, a final assistant. */
function reviewRepro(): ConversationHistory {
  const inputs: MessageInput[] = [{ role: 'system', content: 'hidden system', hidden: true }];
  for (let index = 0; index < 4; index++) {
    inputs.push({ role: 'user', content: `q${index}` });
    inputs.push({ role: 'assistant', content: `a${index}` });
  }
  inputs.push({ role: 'user', content: 'hidden pinned', hidden: true, metadata: { pinned: true } });
  inputs.push({ role: 'assistant', content: 'last', goalCompleted: true });
  return build(inputs);
}

/** A hidden tool call, its visible result, then a recent window that holds the result. */
function hiddenCallHistory(): ConversationHistory {
  const inputs: MessageInput[] = [];
  for (let index = 0; index < 3; index++) {
    inputs.push({ role: 'user', content: `q${index}` });
    inputs.push({ role: 'assistant', content: `a${index}` });
  }
  inputs.push({
    role: 'tool-call',
    content: '',
    hidden: true,
    toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
  });
  inputs.push({
    role: 'tool-result',
    content: 'found',
    toolResult: { callId: 'call-1', outcome: 'success', content: 'found' },
  });
  inputs.push({ role: 'assistant', content: 'done' });
  return build(inputs);
}

const withoutPosition = (message: Message) => ({ ...message, position: 0 });

function messagesOf(history: ConversationHistory): Message[] {
  return history.ids.map((id) => history.messages[id]!);
}

/** Every input message either survives unchanged (bar position) or is counted as removed. */
function expectAccounted(
  before: ConversationHistory,
  after: ConversationHistory,
  result: CompactionResult,
): void {
  const survivors = after.ids.filter((id) => before.messages[id]);
  for (const id of survivors) {
    expect(withoutPosition(after.messages[id]!)).toEqual(withoutPosition(before.messages[id]!));
  }
  expect(result.messagesRemoved).toBe(before.ids.length - survivors.length);
  for (const message of messagesOf(before)) {
    if (message.hidden) expect(after.messages[message.id]).toBeDefined();
  }
  after.ids.forEach((id, position) => expect(after.messages[id]!.position).toBe(position));
}

function storedSummary(history: ConversationHistory): Message {
  const summary = messagesOf(history).find((message) => message.metadata['compactionSummary']);
  expect(summary).toBeDefined();
  return summary!;
}

type Outcome = { after: ConversationHistory; result: CompactionResult };
type Path = {
  readonly name: string;
  readonly run: (
    history: ConversationHistory,
    options: CompactionOptions,
    plugins?: Plugin[],
  ) => Promise<Outcome>;
};

const paths: Path[] = [
  {
    name: 'synchronous compactConversation',
    run: async (history, options, plugins = []) => {
      const { conversation, result } = await compactConversation(history, summarizer, options, {
        plugins,
      });
      return { after: conversation, result };
    },
  },
  {
    name: 'revisioned Conversation.compact',
    run: async (history, options, plugins = []) => {
      const conversation = new Conversation(history, { plugins });
      const result = await conversation.compact(summarizer, options);
      expect(result.outcome).toBe('committed');
      return { after: conversation.current, result };
    },
  },
];

for (const path of paths) {
  describe(`hidden and kept messages: ${path.name}`, () => {
    it('keeps every hidden message and counts only the messages that left history', async () => {
      const before = reviewRepro();
      const { after, result } = await path.run(before, { preserveRecentCount: 2 });

      expect(result.compacted).toBe(true);
      const hidden = messagesOf(before).filter((message) => message.hidden);
      expect(hidden).toHaveLength(2);
      for (const message of hidden) expect(after.messages[message.id]).toBeDefined();
      // q0..q2 and a0..a2 left history; a3 and the final assistant stayed.
      expect(result.messagesRemoved).toBe(6);
      expectAccounted(before, after, result);
    });

    it('keeps a visible tool result whose call is hidden, whatever preserveToolPairs is', async () => {
      for (const preserveToolPairs of [true, false]) {
        const before = hiddenCallHistory();
        const { after, result } = await path.run(before, {
          preserveRecentCount: 2,
          preserveToolPairs,
        });

        expect(result.compacted).toBe(true);
        const call = messagesOf(after).find((message) => message.toolCall);
        const answer = messagesOf(after).find((message) => message.toolResult);
        expect(call?.hidden).toBe(true);
        expect(answer?.toolResult?.callId).toBe(call?.toolCall?.id);
        expectAccounted(before, after, result);
      }
    });

    it('keeps goalCompleted, createdAt, and content of kept messages byte for byte', async () => {
      const before = reviewRepro();
      const { after } = await path.run(before, { preserveRecentCount: 2 });

      const last = messagesOf(before).find((message) => message.content === 'last')!;
      const kept = after.messages[last.id] as Message & { goalCompleted?: boolean };
      expect(kept).toBeDefined();
      expect(kept.goalCompleted).toBe(true);
      expect(kept.createdAt).toBe(last.createdAt);
      expect(JSON.stringify(kept.content)).toBe(JSON.stringify(last.content));
    });

    it('does not run message plugins again over kept messages or the summary', async () => {
      const before = build([
        { role: 'user', content: 'q0' },
        { role: 'assistant', content: 'a0' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
      ]);
      const { after, result } = await path.run(before, { preserveRecentCount: 2 }, [prefixPlugin]);

      expect(result.summaryContent).toBe('Summary of 4 messages');
      expect(storedSummary(after).content).toBe(result.summaryContent);
      expect(messagesOf(after).map((message) => message.content)).toEqual([
        result.summaryContent,
        'q2',
        'a2',
      ]);
    });
  });
}
