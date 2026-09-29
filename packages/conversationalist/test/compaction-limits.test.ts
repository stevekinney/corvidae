/**
 * COR-1250 — the documented limits of `compact()` and `compactConversation()`.
 *
 * These pin the behavior the README's "Compaction limits" section and the API
 * reference's "Not provided" list describe, so the documentation cannot drift
 * from what the library does: a pending
 * tool call can be summarized away, and the library forwards an abort signal to
 * the summarizer without checking it between chunks.
 *
 * The COR-1369 block pins the fixed behavior for hidden messages and kept
 * messages: a commit keeps every hidden message, a kept visible tool result whose
 * call is hidden no longer fails the attempt, and kept messages are carried over
 * rather than rebuilt.
 */
import { describe, expect, it } from 'bun:test';

import { compactConversation } from '../src/compaction/compact';
import { Conversation } from '../src/history';
import {
  createConversationHistory,
  defineMessagePlugin,
  type ConversationEnvironment,
  type ConversationEvent,
  type Message,
  type Summarizer,
} from '../src/index';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';

function conversationWithPairs(
  pairs: number,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const conversation = new Conversation(createConversationHistory({ id: 'limits' }), environment);
  for (let index = 0; index < pairs; index++) {
    conversation.appendUserMessage(`question ${index}`);
    conversation.appendAssistantMessage(`answer ${index}`);
  }
  return conversation;
}

function recordEvents(
  conversation: Conversation,
  types: ReadonlyArray<
    | 'change'
    | 'stream.finalized'
    | 'stream.cancelled'
    | 'compaction.started'
    | 'compaction.failed'
    | 'compaction.cancelled'
  >,
): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  for (const type of types) {
    conversation.addEventListener(type, (event) => events.push(event));
  }
  return events;
}

/** Counts calls and ignores the signal it is handed. */
function countingSummarizer(): { readonly summarize: Summarizer; readonly calls: () => number } {
  let calls = 0;
  return {
    summarize: async () => {
      calls += 1;
      return `summary ${calls}`;
    },
    calls: () => calls,
  };
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error('caller gave up'));
  return controller.signal;
}

describe('compact() does not wait for a durable boundary', () => {
  it('keeps an open stream under its own identifier, so its updates and finalize still land', async () => {
    const conversation = conversationWithPairs(8);
    const id = conversation.appendStreamingMessage('assistant');
    conversation.updateStreamingMessage(id, 'partial reply');

    const result = await conversation.compact(async () => 'summary', { preserveRecentCount: 2 });
    expect(result.outcome).toBe('committed');

    expect(conversation.getStreamingMessage()?.id).toBe(id);
    const revision = conversation.revision;
    conversation.updateStreamingMessage(id, 'partial reply and more');
    expect(conversation.revision).toBe(revision + 1);
    expect(conversation.getStreamingMessage()!.content).toBe('partial reply and more');

    conversation.finalizeStreamingMessage(id);
    expect(conversation.getStreamingMessage()).toBeUndefined();
    expect(JSON.stringify(await conversation.toProvider('anthropic'))).toContain(
      'partial reply and more',
    );
  });

  it('rejects the result of a pending tool call that was summarized away', async () => {
    const conversation = conversationWithPairs(4);
    conversation.appendToolCall({ id: 'pending-call', name: 'lookup', arguments: {} });
    for (let index = 0; index < 3; index++) conversation.appendUserMessage(`later ${index}`);

    const result = await conversation.compact(async () => 'summary', { preserveRecentCount: 2 });
    expect(result.outcome).toBe('committed');
    expect(conversation.getPendingToolCalls()).toEqual([]);

    const lateResult = { callId: 'pending-call', outcome: 'success' as const, content: 'found' };
    expect(() => conversation.appendToolResult(lateResult)).toThrow(
      expect.objectContaining({ code: 'error:invalid-tool-reference' }),
    );
    expect(await rejectionOf(conversation.appendToolResultAsync(lateResult))).toMatchObject({
      code: 'error:invalid-tool-reference',
    });
  });
});

describe('CompactionOptions.signal is forwarded, not checked between chunks', () => {
  it('lets compact() summarize every chunk before rejecting a pre-aborted attempt', async () => {
    const conversation = conversationWithPairs(8);
    const revision = conversation.revision;
    const events = recordEvents(conversation, ['change', 'compaction.cancelled']);
    const { summarize, calls } = countingSummarizer();

    const cancelled = conversation.compact(summarize, {
      preserveRecentCount: 2,
      signal: abortedSignal(),
    });

    expect(await rejectionOf(cancelled)).toMatchObject({ code: 'error:operation-cancelled' });
    expect(calls()).toBeGreaterThan(1);
    expect(conversation.revision).toBe(revision);
    expect(events.map((event) => event.type)).toEqual(['compaction.cancelled']);
  });

  it('lets compactConversation() resolve normally when the summarizer ignores the signal', async () => {
    const conversation = conversationWithPairs(8);
    const { summarize, calls } = countingSummarizer();

    const { result } = await compactConversation(conversation.current, summarize, {
      preserveRecentCount: 2,
      signal: abortedSignal(),
    });

    expect(result.compacted).toBe(true);
    expect(result.chunksProcessed).toBe(calls());
    expect(calls()).toBeGreaterThan(1);
  });

  it("rejects compactConversation() with the summarizer's own abort error when it honours the signal", async () => {
    const conversation = conversationWithPairs(8);
    const summarizerAbort = new Error('summarizer stopped');
    const honouring: Summarizer = async (_messages, options) => {
      if (options?.signal?.aborted) throw summarizerAbort;
      return 'summary';
    };

    const rejected = compactConversation(conversation.current, honouring, {
      preserveRecentCount: 2,
      signal: abortedSignal(),
    });

    expect(await rejectionOf(rejected)).toBe(summarizerAbort);
  });
});

/** Every stored message in order, hidden ones included, as `role:content`. */
function transcript(conversation: Conversation): string[] {
  return conversation
    .getMessages({ includeHidden: true })
    .map((message) => `${message.role}${message.hidden ? '(hidden)' : ''}:${text(message)}`);
}

function text(message: Message): string {
  return typeof message.content === 'string' ? message.content : '[parts]';
}

function lastMessage(conversation: Conversation): Message {
  return conversation.current.messages[conversation.current.ids.at(-1)!]!;
}

describe('hidden and kept messages after a commit (COR-1369)', () => {
  it('keeps hidden messages, summarizes only visible ones, and counts what left history', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'hidden' }));
    conversation.appendMessages({ role: 'system', content: 'hidden rules', hidden: true });
    for (let index = 0; index < 4; index++) {
      conversation.appendUserMessage(`q${index}`);
      conversation.appendAssistantMessage(`a${index}`);
    }
    conversation.appendMessages({
      role: 'user',
      content: 'hidden pin',
      hidden: true,
      metadata: { pinned: true },
    });
    conversation.appendAssistantMessage('last');
    const hiddenIds = conversation.current.ids.filter(
      (id) => conversation.current.messages[id]!.hidden,
    );
    const changes = recordEvents(conversation, ['change']);
    const summarized: string[] = [];

    const result = await conversation.compact(
      async (messages) => {
        summarized.push(...messages.map(text));
        return 'summary';
      },
      { preserveRecentCount: 2 },
    );

    expect(result.outcome).toBe('committed');
    // The recent window counts visible non-system messages only, so it is a3 and last.
    expect(summarized).toEqual(['q0', 'a0', 'q1', 'a1', 'q2', 'a2', 'q3']);
    expect(result.messagesRemoved).toBe(7);
    expect(transcript(conversation)).toEqual([
      `system:${result.summaryContent}`,
      'system(hidden):hidden rules',
      'assistant:a3',
      'user(hidden):hidden pin',
      'assistant:last',
    ]);
    expect(hiddenIds).toHaveLength(2);
    for (const id of hiddenIds) expect(changes[0]!.messageIds).not.toContain(id);
  });

  it('keeps a hidden tool result together with its visible call', async () => {
    const conversation = conversationWithPairs(4);
    conversation.appendToolCall({ id: 'kept-call', name: 'lookup', arguments: {} });
    conversation.appendMessages({
      role: 'tool-result',
      content: '',
      hidden: true,
      toolResult: { callId: 'kept-call', outcome: 'success', content: 'found' },
    });
    conversation.appendUserMessage('after');

    const result = await conversation.compact(async () => 'summary', { preserveRecentCount: 2 });

    expect(result.outcome).toBe('committed');
    expect(transcript(conversation)).toEqual([
      `system:${result.summaryContent}`,
      'tool-call:',
      'tool-result(hidden):',
      'user:after',
    ]);
    expect(conversation.getPendingToolCalls()).toEqual([]);
  });

  for (const preserveToolPairs of [true, false]) {
    it(`keeps a visible tool result whose call is hidden (preserveToolPairs: ${preserveToolPairs})`, async () => {
      const conversation = conversationWithPairs(4);
      conversation.appendMessages({
        role: 'tool-call',
        content: '',
        hidden: true,
        toolCall: { id: 'hidden-call', name: 'lookup', arguments: {} },
      });
      conversation.appendToolResult({ callId: 'hidden-call', outcome: 'success', content: 'x' });
      const events = recordEvents(conversation, ['compaction.started', 'compaction.failed']);

      const result = await conversation.compact(async () => 'summary', {
        preserveRecentCount: 2,
        preserveToolPairs,
      });

      expect(result.outcome).toBe('committed');
      expect(events.map((event) => event.type)).toEqual(['compaction.started']);
      expect(transcript(conversation)).toEqual([
        `system:${result.summaryContent}`,
        'assistant:answer 3',
        'tool-call(hidden):',
        'tool-result:',
      ]);
    });
  }

  it('keeps an error tool result kept by policy together with its hidden call', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'hidden-error' }));
    conversation.appendMessages({
      role: 'tool-call',
      content: '',
      hidden: true,
      toolCall: { id: 'hidden-call', name: 'lookup', arguments: {} },
    });
    conversation.appendToolResult({ callId: 'hidden-call', outcome: 'error', content: 'boom' });
    for (let index = 0; index < 4; index++) {
      conversation.appendUserMessage(`q${index}`);
      conversation.appendAssistantMessage(`a${index}`);
    }

    const result = await conversation.compact(async () => 'summary', { preserveRecentCount: 2 });

    expect(result.outcome).toBe('committed');
    expect(transcript(conversation).slice(0, 3)).toEqual([
      `system:${result.summaryContent}`,
      'tool-call(hidden):',
      'tool-result:',
    ]);
  });

  it('carries kept messages over with their identity, creation time, and goalCompleted', async () => {
    let tick = Date.parse('2026-01-01T00:00:00.000Z');
    const now = () => new Date((tick += 1000)).toISOString();
    const conversation = conversationWithPairs(4, { now });
    conversation.appendMessages({ role: 'assistant', content: 'done', goalCompleted: true });
    const before = lastMessage(conversation);
    expect(before).toMatchObject({ content: 'done', goalCompleted: true, position: 8 });

    const result = await conversation.compact(async () => 'summary', { preserveRecentCount: 2 });

    expect(result.outcome).toBe('committed');
    const after = lastMessage(conversation);
    expect(after).toEqual({ ...before, position: 2 });
    expect(after).toHaveProperty('goalCompleted', true);
  });

  it('does not run message plugins again over kept messages or the summary', async () => {
    const tagger = defineMessagePlugin({ id: 'tagger', revision: 1 }, (input) =>
      typeof input.content === 'string' ? { ...input, content: `[t]${input.content}` } : input,
    );
    const conversation = conversationWithPairs(4, { plugins: [tagger] });
    expect(lastMessage(conversation).content).toBe('[t]answer 3');

    const result = await conversation.compact(async () => 'summary', { preserveRecentCount: 2 });

    expect(result.summaryContent).not.toContain('[t]');
    expect(transcript(conversation)).toEqual([
      `system:${result.summaryContent}`,
      'user:[t]question 3',
      'assistant:[t]answer 3',
    ]);
  });
});
