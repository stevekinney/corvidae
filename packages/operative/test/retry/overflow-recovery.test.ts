/**
 * COR-808 — provider-overflow recovery in the agent loop.
 *
 * Recovery runs inside a step's provider-retry loop, before that step
 * appends assistant output or runs a tool. It compacts the run's own
 * conversation once, retries once, and on a second overflow before any
 * durable output it surfaces the provider error rather than looping. A
 * tool that already ran is never run again, and a stream that failed
 * leaves no partial output behind.
 */
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, type Message } from 'conversationalist';
import { z } from 'zod';

import { createActiveRun } from '../../src/create-run';
import type { GenerateRetryEvent } from '../../src/events';
import { createOverflowMutator } from '../../src/retry/overflow-mutator';
import { withStreaming } from '../../src/streaming';
import { createRunRecorder } from '../../src/test/index';
import type { GenerateResponse, StreamingGenerateFunction } from '../../src/types';

function conversationWithHistory(): Conversation {
  const conversation = new Conversation();
  for (let index = 0; index < 6; index++) {
    conversation.appendUserMessage(`question ${index}`);
    conversation.appendAssistantMessage(`answer ${index}`);
  }
  return conversation;
}

function isSummary(message: Message | undefined): boolean {
  return message?.metadata['compactionSummary'] === true;
}

function overflowRecovery() {
  let compactions = 0;
  const mutate = createOverflowMutator({
    retainRecentMessages: 2,
    summarize: async (messages) => {
      compactions += 1;
      return `${messages.length} earlier messages`;
    },
  });
  return {
    mutate,
    get summaries() {
      return compactions;
    },
  };
}

function countCommits(conversation: Conversation): { readonly count: number } {
  let count = 0;
  conversation.addEventListener('compaction.completed', () => {
    count += 1;
  });
  return {
    get count() {
      return count;
    },
  };
}

describe('provider-overflow recovery', () => {
  it('compacts once and retries once, appending the reply to the compacted history', async () => {
    const conversation = conversationWithHistory();
    const commits = countCommits(conversation);
    const recovery = overflowRecovery();
    const seen: number[] = [];
    const activeRun = createActiveRun({
      generate: async (context) => {
        seen.push(context.conversation.getMessages().length);
        if (seen.length === 1) throw new Error('context_length_exceeded');
        return { content: 'recovered', toolCalls: [] };
      },
      toolbox: createTestToolbox([]),
      conversation,
      maximumSteps: 1,
      retry: { attempts: 5, mutate: recovery.mutate },
    });
    const recorder = createRunRecorder(activeRun);

    const result = await activeRun.result;

    expect(result.finishReason).toBe('maximum-steps');
    expect(commits.count).toBe(1);
    // The retry read the compacted history: a summary plus two retained messages.
    expect(seen).toEqual([12, 3]);
    const messages = conversation.getMessages();
    expect(isSummary(messages[0])).toBe(true);
    expect(messages.map((message) => message.content).slice(1)).toEqual([
      'question 5',
      'answer 5',
      'recovered',
    ]);
    const retries = recorder.events
      .filter((event) => event.type === 'generate.retry')
      .map((event) => event.detail as GenerateRetryEvent);
    expect(retries.map((retry) => retry.mutated)).toEqual([true]);
  });

  it('surfaces a repeated overflow instead of compacting or retrying again', async () => {
    const conversation = conversationWithHistory();
    const commits = countCommits(conversation);
    const recovery = overflowRecovery();
    let calls = 0;
    const overflow = new Error('context_length_exceeded');

    const result = await createActiveRun({
      generate: async () => {
        calls += 1;
        throw overflow;
      },
      toolbox: createTestToolbox([]),
      conversation,
      retry: { attempts: 5, mutate: recovery.mutate },
    }).result;

    expect(result.finishReason).toBe('error');
    expect((result.error as { cause?: unknown }).cause).toBe(overflow);
    // The original attempt plus exactly one retry, of five allowed.
    expect(calls).toBe(2);
    expect(commits.count).toBe(1);
  });

  it('never replays a streamed partial reply or a tool effect that already happened', async () => {
    const conversation = conversationWithHistory();
    const commits = countCommits(conversation);
    const recovery = overflowRecovery();
    let toolRuns = 0;
    const record = createTool({
      name: 'record',
      description: 'Records a side effect',
      input: z.object({}),
      execute: async () => {
        toolRuns += 1;
        return 'recorded';
      },
    });
    let attempts = 0;
    const stream: StreamingGenerateFunction = async ({ step, streaming }) => {
      attempts += 1;
      if (step === 0) {
        return { content: '', toolCalls: [{ name: 'record', arguments: {} }] };
      }
      if (attempts === 2) {
        streaming.update('partial reply that must not survive');
        throw new Error('context_length_exceeded');
      }
      streaming.update('final reply');
      return { content: 'final reply', toolCalls: [] } satisfies GenerateResponse;
    };

    const result = await createActiveRun({
      generate: withStreaming(stream),
      toolbox: createTestToolbox([record]),
      conversation,
      maximumSteps: 2,
      retry: { attempts: 3, mutate: recovery.mutate },
    }).result;

    expect(result.finishReason).toBe('maximum-steps');
    expect(toolRuns).toBe(1);
    expect(commits.count).toBe(1);
    const contents = conversation
      .getMessages({ includeHidden: true })
      .map((message) => JSON.stringify(message.content));
    expect(contents.some((content) => content.includes('partial reply'))).toBe(false);
    expect(conversation.getMessages().at(-1)?.content).toBe('final reply');
  });
});
