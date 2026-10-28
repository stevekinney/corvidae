import { createTestToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, type ConversationEvent, type Message } from 'conversationalist';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createOverflowMutator } from '../../src/retry/overflow-mutator';
import type { GenerateContext } from '../../src/types';

const overflow = new Error('context_length_exceeded');

function makeContext(messageContents: string[]): GenerateContext {
  const conversation = new Conversation();
  for (const content of messageContents) {
    conversation.appendUserMessage(content);
  }
  return {
    conversation,
    step: 0,
    toolbox: createTestToolbox([]),
  };
}

function isSummary(message: Message | undefined): boolean {
  return message?.metadata['compactionSummary'] === true;
}

function recordCommits(conversation: Conversation): ConversationEvent[] {
  const commits: ConversationEvent[] = [];
  conversation.addEventListener('compaction.completed', (event) => commits.push(event));
  return commits;
}

describe('createOverflowMutator', () => {
  it('returns void for non-overflow errors', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
    });
    const context = makeContext(['hello']);
    const result = await mutator(context, new Error('rate limit exceeded'), 1);
    expect(result).toBeUndefined();
  });

  it('detects context_length_exceeded in error message', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary of conversation',
    });
    const context = makeContext(['msg1', 'msg2', 'msg3', 'msg4', 'msg5', 'msg6']);
    const result = await mutator(context, new Error('context_length_exceeded'), 1);
    expect(result).toBeDefined();
  });

  it('detects maximum context length in error message', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
    });
    const context = makeContext(['msg1', 'msg2', 'msg3', 'msg4', 'msg5']);
    const result = await mutator(
      context,
      new Error('This request exceeds the maximum context length'),
      1,
    );
    expect(result).toBeDefined();
  });

  it('detects too many tokens in error message', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
    });
    const context = makeContext(['msg1', 'msg2', 'msg3', 'msg4', 'msg5']);
    const result = await mutator(context, new Error('too many tokens in request'), 1);
    expect(result).toBeDefined();
  });

  it('uses a custom classifyError function', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
      classifyError: (error) => {
        if (error instanceof Error && error.message === 'custom-overflow') return 'overflow';
        return 'unknown';
      },
    });
    const context = makeContext(['msg1', 'msg2', 'msg3', 'msg4', 'msg5']);
    const result = await mutator(context, new Error('custom-overflow'), 1);
    expect(result).toBeDefined();
  });

  it('calls summarize with the older messages', async () => {
    let summarizedMessages: unknown;
    const mutator = createOverflowMutator({
      summarize: async (messages) => {
        summarizedMessages = messages;
        return 'A concise summary';
      },
      retainRecentMessages: 2,
    });
    const context = makeContext(['msg1', 'msg2', 'msg3', 'msg4']);
    await mutator(context, overflow, 1);

    expect(Array.isArray(summarizedMessages)).toBe(true);
    // Should get the older messages (not the recent 2)
    expect((summarizedMessages as unknown[]).length).toBeGreaterThan(0);
  });

  it('commits the compaction to the run conversation through the revisioned compare-and-swap', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'the user listed seven messages',
    });
    const context = makeContext(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    const { conversation } = context;
    const commits = recordCommits(conversation);
    const baseRevision = conversation.revision;

    const result = await mutator(context, overflow, 1);

    // The retry is issued against the same, now compacted, conversation, so
    // whatever it streams or appends lands in the history the run keeps.
    expect(result?.conversation).toBe(conversation);
    expect(result).not.toBe(context);
    expect(conversation.revision).toBe(baseRevision + 1);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.compaction?.baseRevision).toBe(baseRevision);
    const messages = conversation.getMessages();
    expect(isSummary(messages[0])).toBe(true);
    expect(messages[0]!.content as string).toStartWith(
      'Previous conversation summary: the user listed seven messages',
    );
    expect(messages.slice(1).map((message) => message.content)).toEqual(['m4', 'm5', 'm6', 'm7']);
  });

  it('retains tool calls and results with their structure intact', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
      retainRecentMessages: 2,
    });
    const conversation = new Conversation();
    conversation.appendUserMessage('Older 1');
    conversation.appendAssistantMessage('Older 2');
    conversation.appendToolCalls([{ id: 'tool-1', name: 'search', arguments: '{}' }]);
    conversation.appendToolResults([
      { callId: 'tool-1', outcome: 'success', content: 'tool output' },
    ]);
    const [toolCall, toolResult] = conversation.getMessages().slice(-2);

    await mutator({ conversation, step: 0, toolbox: createTestToolbox([]) }, overflow, 1);

    const retained = conversation.getMessages().slice(1);
    expect(retained.map((message) => message.role)).toEqual(['tool-call', 'tool-result']);
    expect(retained[0]!.toolCall).toEqual(toolCall!.toolCall);
    expect(retained[1]!.toolResult).toEqual(toolResult!.toolResult);
  });

  it('rethrows the provider error when nothing is eligible, rather than retrying the same request', async () => {
    let summarized = false;
    const mutator = createOverflowMutator({
      summarize: async () => {
        summarized = true;
        return 'summary';
      },
      retainRecentMessages: 4,
    });
    const context = makeContext(['msg1', 'msg2', 'msg3']);
    const before = JSON.stringify(context.conversation.current);

    expect(await rejectionOf(mutator(context, overflow, 1))).toBe(overflow);
    expect(summarized).toBe(false);
    expect(JSON.stringify(context.conversation.current)).toBe(before);
  });

  it('compacts at most once before durable output: a repeated overflow is rethrown', async () => {
    let summaries = 0;
    const mutator = createOverflowMutator({
      summarize: async () => {
        summaries += 1;
        return 'summary';
      },
      retainRecentMessages: 2,
    });
    const context = makeContext(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const commits = recordCommits(context.conversation);
    await mutator(context, overflow, 1);
    const summariesAfterFirst = summaries;

    // The retry overflowed again. A failed streaming attempt opens and
    // withdraws a stream, which moves the revision but leaves nothing durable.
    const streamId = context.conversation.appendStreamingMessage('assistant');
    context.conversation.updateStreamingMessage(streamId, 'partial');
    context.conversation.cancelStreamingMessage(streamId);
    const again = new Error('context_length_exceeded again');

    expect(await rejectionOf(mutator(context, again, 2))).toBe(again);
    expect(commits).toHaveLength(1);
    expect(summaries).toBe(summariesAfterFirst);
  });

  it('allows one more compaction once durable output has landed', async () => {
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
      retainRecentMessages: 2,
    });
    const context = makeContext(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const commits = recordCommits(context.conversation);
    await mutator(context, overflow, 1);

    context.conversation.appendAssistantMessage('a durable reply');
    context.conversation.appendUserMessage('a follow-up');
    await mutator(context, overflow, 1);

    expect(commits).toHaveLength(2);
  });

  it('never compacts over an open stream, whose partial output is not durable', async () => {
    let summarized = false;
    const mutator = createOverflowMutator({
      summarize: async () => {
        summarized = true;
        return 'summary';
      },
    });
    const context = makeContext(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const streamId = context.conversation.appendStreamingMessage('assistant');
    context.conversation.updateStreamingMessage(streamId, 'partial output');
    const before = JSON.stringify(context.conversation.current);

    expect(await rejectionOf(mutator(context, overflow, 1))).toBe(overflow);
    expect(summarized).toBe(false);
    expect(JSON.stringify(context.conversation.current)).toBe(before);
  });

  it('rethrows when a concurrent write makes the compaction stale, keeping that write', async () => {
    const context = makeContext(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const mutator = createOverflowMutator({
      summarize: async () => {
        context.conversation.appendUserMessage('arrived during the summary');
        return 'summary';
      },
      retainRecentMessages: 2,
    });

    let thrown: unknown;
    try {
      await mutator(context, overflow, 1);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(overflow);
    const messages = context.conversation.getMessages();
    expect(messages.some(isSummary)).toBe(false);
    expect(messages.at(-1)?.content).toBe('arrived during the summary');
  });

  it('retries once against a compaction another writer commits while its own summary is being written', async () => {
    const context = makeContext(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const { conversation } = context;
    const commits = recordCommits(conversation);
    let background: Promise<unknown> | undefined;
    const mutator = createOverflowMutator({
      summarize: async () => {
        // A background candidate lands first and makes this summary stale.
        background ??= conversation.compact(async () => 'background summary', {
          preserveRecentCount: 2,
        });
        await background;
        return 'overflow summary';
      },
      retainRecentMessages: 2,
    });

    const result = await mutator(context, overflow, 1);

    expect(result?.conversation).toBe(conversation);
    expect(result).not.toBe(context);
    const messages = conversation.getMessages();
    expect(messages.filter(isSummary)).toHaveLength(1);
    expect(messages[0]!.content).toContain('background summary');
    expect(messages[0]!.content).not.toContain('overflow summary');
    expect(messages.slice(1).map((message) => message.content)).toEqual(['m5', 'm6']);

    // That compaction was this boundary's: a repeated overflow is rethrown.
    const again = new Error('context_length_exceeded again');
    expect(await rejectionOf(mutator(context, again, 2))).toBe(again);
    expect(commits).toHaveLength(1);
  });

  it('retries once against a compaction another writer committed while the failed request was in flight', async () => {
    const context = makeContext(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const { conversation } = context;
    const sentHistory = conversation.current;
    // A background candidate commits during the provider's network wait.
    await conversation.compact(async () => 'background summary', { preserveRecentCount: 2 });
    const commits = recordCommits(conversation);
    let summaries = 0;
    const mutator = createOverflowMutator({
      summarize: async () => {
        summaries += 1;
        return 'overflow summary';
      },
      retainRecentMessages: 2,
    });

    const result = await mutator(context, overflow, 1, sentHistory);

    // The compacted history is not the one that overflowed, so the retry is
    // issued against it instead of compacting it again.
    expect(result?.conversation).toBe(conversation);
    expect(result).not.toBe(context);
    expect(summaries).toBe(0);
    expect(commits).toHaveLength(0);
    const messages = conversation.getMessages();
    expect(messages.filter(isSummary)).toHaveLength(1);
    expect(messages[0]!.content).toContain('background summary');
    expect(messages.slice(1).map((message) => message.content)).toEqual(['m5', 'm6']);

    // That compaction was this boundary's: a repeated overflow is rethrown.
    const again = new Error('context_length_exceeded again');
    expect(await rejectionOf(mutator(context, again, 2, conversation.current))).toBe(again);
    expect(summaries).toBe(0);
    expect(commits).toHaveLength(0);
  });

  it('still compacts when the history was only extended while the failed request was in flight', async () => {
    const context = makeContext(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const { conversation } = context;
    const sentHistory = conversation.current;
    conversation.appendUserMessage('arrived in flight');
    const commits = recordCommits(conversation);
    const mutator = createOverflowMutator({
      summarize: async () => 'overflow summary',
      retainRecentMessages: 2,
    });

    const result = await mutator(context, overflow, 1, sentHistory);

    expect(result?.conversation).toBe(conversation);
    expect(commits).toHaveLength(1);
    const messages = conversation.getMessages();
    expect(messages[0]!.content).toContain('overflow summary');
    expect(messages.slice(1).map((message) => message.content)).toEqual([
      'm6',
      'arrived in flight',
    ]);
  });

  it('cancels its compaction with the step signal', async () => {
    const step = new AbortController();
    const context = { ...makeContext(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']), signal: step.signal };
    const mutator = createOverflowMutator({
      summarize: async () => {
        step.abort();
        return 'summary';
      },
    });

    let thrown: unknown;
    try {
      await mutator(context, overflow, 1);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'error:operation-cancelled' });
    expect(context.conversation.getMessages().some(isSummary)).toBe(false);
  });
});

describe('createOverflowMutator: multimodal history (COR-716)', () => {
  const document = {
    type: 'document' as const,
    name: 'spec.pdf',
    mimeType: 'application/pdf',
    source: { kind: 'managed-asset' as const, assetId: 'asset-1', revision: 3 },
  };

  it('compacts around a media-bearing message: the summarizer never sees it and it survives verbatim', async () => {
    const context = makeContext([]);
    context.conversation.appendUserMessage([{ type: 'text', text: 'read' }, document]);
    for (let index = 0; index < 8; index++)
      context.conversation.appendUserMessage(`filler ${index}`);
    const summarized: string[] = [];
    const mutator = createOverflowMutator({
      summarize: async (messages) => {
        for (const message of messages) summarized.push(JSON.stringify(message.content));
        return 'summary';
      },
      retainRecentMessages: 2,
    });

    const result = await mutator(context, overflow, 1);

    expect(result).toBeDefined();
    const survivors = context.conversation.getMessages().map((message) => message.content);
    expect(survivors).toContainEqual([{ type: 'text', text: 'read' }, document]);
    expect(summarized.join('')).not.toContain('asset-1');
    expect(context.conversation.getMessages().some(isSummary)).toBe(true);
  });

  it('rethrows the provider error when the only compactable history is media, rather than dropping it', async () => {
    const context = makeContext([]);
    context.conversation.appendUserMessage([document]);
    context.conversation.appendUserMessage([document]);
    const mutator = createOverflowMutator({
      summarize: async () => 'summary',
      retainRecentMessages: 1,
    });

    expect(await rejectionOf(mutator(context, overflow, 1))).toBe(overflow);
    expect(context.conversation.getMessages().map((message) => message.content)).toEqual([
      [document],
      [document],
    ]);
  });
});
