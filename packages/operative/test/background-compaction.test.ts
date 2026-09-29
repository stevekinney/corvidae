/**
 * COR-808 — optimistic background compaction in the agent loop.
 *
 * `contextManagement.background` lets a step whose context is over a soft
 * threshold ask a conversationalist `CompactionScheduler` to prepare a
 * compaction without waiting for it. The candidate publishes only through
 * `Conversation.compact()`'s revision compare-and-swap, so a generation
 * step reads either the whole pre-compaction history or the whole
 * compacted one, never a mix, and a token that streams in while the
 * summary is being written makes that summary stale instead of lost. A
 * candidate starts only at a durable boundary, so a window that opens
 * mid-stream or mid-tool-execution waits instead of compacting. Overflow
 * recovery retries against a candidate that committed while the failed
 * request was in flight, and one that races recovery's own summary retries
 * against whichever compaction commits first.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import {
  Conversation,
  createCompactionScheduler,
  type CompactionScheduleAdapter,
  type CompactionScheduler,
  type CompactionSchedulerOutcome,
  type CompactionSchedulerState,
  type Message,
  type Summarizer,
} from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createContextCompactor } from '../src/create-context-compactor';
import { createActiveRun } from '../src/create-run';
import { AgentRunError } from '../src/errors';
import type { OperativeHookMap } from '../src/hooks';
import type { BackgroundCompactionOptions } from '../src/index';
import { createOverflowMutator } from '../src/retry/overflow-mutator';
import { withStreaming } from '../src/streaming';
import type { GenerateContext, GenerateResponse, StreamingGenerateFunction } from '../src/types';

type Gate = { readonly opened: Promise<void>; readonly release: () => void };

function createGate(): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

/** A summarizer that waits on the armed gate and ignores cancellation. */
function createGatedSummarizer() {
  let gate = createGate();
  let calls = 0;
  let active = 0;
  const summarizer: Summarizer = async (messages) => {
    calls += 1;
    active += 1;
    try {
      await gate.opened;
      return `Summary of ${messages.length} messages`;
    } finally {
      active -= 1;
    }
  };
  return {
    summarizer,
    get calls() {
      return calls;
    },
    get active() {
      return active;
    },
    release(): void {
      gate.release();
    },
    arm(): void {
      gate = createGate();
    },
  };
}

type QueuedTask = { readonly task: () => void; cancelled: boolean };

function createManualSchedule() {
  const queue: QueuedTask[] = [];
  const adapter: CompactionScheduleAdapter = {
    schedule(task) {
      const entry: QueuedTask = { task, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  return {
    adapter,
    get queued() {
      return queue.filter((entry) => !entry.cancelled).length;
    },
    get cancelled() {
      return queue.filter((entry) => entry.cancelled).length;
    },
    fire(): void {
      const entry = queue.shift();
      if (!entry || entry.cancelled) throw new Error('no live task is queued');
      entry.task();
    },
  };
}

function conversationWithHistory(): Conversation {
  const conversation = new Conversation();
  for (let index = 0; index < 6; index++) {
    conversation.appendUserMessage(`question ${index}`);
    conversation.appendAssistantMessage(`answer ${index}`);
  }
  return conversation;
}

function untilState(
  scheduler: CompactionScheduler,
  predicate: (state: CompactionSchedulerState) => boolean,
): Promise<CompactionSchedulerState> {
  if (predicate(scheduler.state)) return Promise.resolve(scheduler.state);
  return new Promise((resolve) => {
    const stop = scheduler.subscribe((state) => {
      if (!predicate(state)) return;
      stop();
      resolve(state);
    });
  });
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function contents(messages: readonly Message[]): unknown[] {
  return messages.map((message) => message.content);
}

function isSummary(message: Message | undefined): boolean {
  return message?.metadata['compactionSummary'] === true;
}

/** Context management that always sits between the background and synchronous thresholds. */
function softPressure(scheduler: CompactionScheduler, onCompact = async () => undefined) {
  return {
    maxTokens: 1000,
    compactionThreshold: 500,
    tokenEstimator: () => 100,
    onCompact,
    background: { threshold: 50, scheduler } satisfies BackgroundCompactionOptions,
  };
}

describe('background compaction in the agent loop', () => {
  it('lets a generation step read the whole history immediately before and after a commit', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      compaction: { preserveRecentCount: 2 },
      schedule: schedule.adapter,
    });
    const reads: { before: readonly Message[]; after: readonly Message[] }[] = [];
    let committed: CompactionSchedulerOutcome | undefined;

    const generate = async (context: GenerateContext): Promise<GenerateResponse> => {
      const before = context.conversation.getMessages();
      if (context.step === 0) {
        // The step asked for background work before generating; it is only
        // queued, so this generation runs against the uncompacted history.
        expect(scheduler.state.phase).toBe('pending');
        schedule.fire();
        gated.release();
        committed = await scheduler.request();
      }
      reads.push({ before, after: context.conversation.getMessages() });
      return textResponse(`reply ${context.step}`);
    };

    const result = await createActiveRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      maximumSteps: 2,
      contextManagement: softPressure(scheduler),
    }).result;

    expect(result.finishReason).toBe('maximum-steps');
    expect(committed).toMatchObject({ outcome: 'committed', candidates: 1 });

    const [first, second] = reads;
    // Immediately before the commit: every original message, no summary.
    expect(first!.before).toHaveLength(12);
    expect(first!.before.some(isSummary)).toBe(false);
    // Immediately after: the summary plus the retained recent messages.
    expect(isSummary(first!.after[0])).toBe(true);
    expect(contents(first!.after.slice(1))).toEqual(['question 5', 'answer 5']);
    // The next step reads the compacted history with the first reply on top.
    expect(contents(second!.before.slice(1))).toEqual(['question 5', 'answer 5', 'reply 0']);
    expect(contents(conversation.getMessages().slice(1))).toEqual([
      'question 5',
      'answer 5',
      'reply 0',
      'reply 1',
    ]);
    // The second step asked again; that work is queued, not blocking.
    expect(scheduler.state.phase).toBe('pending');
    await scheduler.dispose();
  });

  it('keeps every token a step streams while a background summary is running', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      compaction: { preserveRecentCount: 2 },
      schedule: schedule.adapter,
    });
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('beforeGenerate', async () => {
      // The window opens before the step's stream does, so a candidate starts.
      schedule.fire();
      expect(scheduler.state.phase).toBe('running');
    });

    const stream: StreamingGenerateFunction = async ({ streaming }) => {
      for (const partial of ['The', 'The answer', 'The answer is 42']) {
        streaming.update(partial);
      }
      gated.release();
      await untilState(scheduler, (state) => state.counts.rescheduled === 1);
      return textResponse('The answer is 42');
    };

    const result = await createActiveRun({
      generate: withStreaming(stream),
      toolbox: createTestToolbox([]),
      conversation,
      maximumSteps: 1,
      hooks,
      contextManagement: softPressure(scheduler),
    }).result;

    expect(result.finishReason).toBe('maximum-steps');
    expect(scheduler.state).toMatchObject({
      phase: 'pending',
      counts: { candidates: 1, discarded: 1, rescheduled: 1, committed: 0 },
    });
    expect(conversation.getMessages().some(isSummary)).toBe(false);
    expect(conversation.getMessages().at(-1)?.content).toBe('The answer is 42');

    // Once the conversation is quiet, the rescheduled candidate commits.
    gated.arm();
    schedule.fire();
    gated.release();
    await untilState(scheduler, (state) => state.phase === 'committed');
    const messages = conversation.getMessages();
    expect(isSummary(messages[0])).toBe(true);
    expect(messages.at(-1)?.content).toBe('The answer is 42');
  });

  it('keeps the whole streamed reply when the window opens between two tokens', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      compaction: { preserveRecentCount: 2 },
      schedule: schedule.adapter,
    });

    const stream: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('The');
      // The window opens, and the summary would return, in a quiet stretch of the stream.
      schedule.fire();
      gated.release();
      await untilState(scheduler, (state) => state.phase !== 'running');
      streaming.update('The answer is 42');
      return textResponse('The answer is 42');
    };

    const result = await createActiveRun({
      generate: withStreaming(stream),
      toolbox: createTestToolbox([]),
      conversation,
      maximumSteps: 1,
      contextManagement: softPressure(scheduler),
    }).result;

    expect(result.finishReason).toBe('maximum-steps');
    // The reply finalized whole, and no streaming placeholder was left open.
    expect(conversation.getStreamingMessage()).toBeUndefined();
    expect(conversation.getMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: 'The answer is 42',
    });
    expect(conversation.getMessages().some(isSummary)).toBe(false);
    expect(gated.calls).toBe(0);
    expect(scheduler.state).toMatchObject({
      phase: 'pending',
      counts: { candidates: 0, deferred: 1 },
    });

    // Closing the stream queued a new window, and its candidate commits.
    gated.arm();
    schedule.fire();
    gated.release();
    await untilState(scheduler, (state) => state.phase === 'committed');
    const messages = conversation.getMessages();
    expect(isSummary(messages[0])).toBe(true);
    expect(messages.at(-1)?.content).toBe('The answer is 42');
    expect(conversation.getStreamingMessage()).toBeUndefined();
  });

  it('appends every tool result and settles the run when the window opens during tool execution', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    // The default recency window keeps four messages: fewer than the step's tool calls.
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });
    let windowOpened = false;
    const lookup = createTool({
      name: 'lookup',
      description: 'Looks up one value',
      input: z.object({ index: z.number() }),
      execute: async ({ index }) => {
        if (!windowOpened) {
          windowOpened = true;
          // The window opens, and the summary would return, while every call is pending.
          schedule.fire();
          gated.release();
          await untilState(scheduler, (state) => state.phase !== 'running');
        }
        return `result ${index}`;
      },
    });
    const calls = Array.from({ length: 6 }, (_, index) => ({
      id: `call-${index}`,
      name: 'lookup',
      arguments: { index },
    }));

    const result = await createActiveRun({
      generate: async (context) =>
        context.step === 0 ? { content: '', toolCalls: calls } : textResponse('done'),
      toolbox: createTestToolbox([lookup]),
      conversation,
      stopWhen: noToolCalls(),
      maximumSteps: 3,
      contextManagement: softPressure(scheduler),
    }).result;

    expect(result.finishReason).toBe('stop-condition');
    expect(result.error).toBeUndefined();
    expect(result.steps).toHaveLength(2);
    expect(conversation.getPendingToolCalls()).toEqual([]);
    const toolResults = conversation
      .getMessages()
      .filter((message) => message.role === 'tool-result')
      .map((message) => message.toolResult?.callId);
    expect(toolResults).toEqual(calls.map((call) => call.id));
    expect(conversation.getMessages().at(-1)?.content).toBe('done');
    expect(gated.calls).toBe(0);
    expect(scheduler.state).toMatchObject({
      phase: 'pending',
      counts: { candidates: 0, deferred: 1 },
    });

    // The last result reached a durable boundary; the window it queued commits.
    gated.arm();
    schedule.fire();
    gated.release();
    await untilState(scheduler, (state) => state.phase === 'committed');
    expect(isSummary(conversation.getMessages()[0])).toBe(true);
    expect(conversation.getPendingToolCalls()).toEqual([]);
    expect(conversation.getMessages().at(-1)?.content).toBe('done');
  });

  it('run cancellation withdraws queued background work', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });
    const caller = new AbortController();
    let requested: Promise<CompactionSchedulerOutcome> | undefined;

    const result = await createActiveRun({
      generate: async () => {
        requested = scheduler.request();
        caller.abort();
        return textResponse('unused');
      },
      toolbox: createTestToolbox([]),
      conversation,
      signal: caller.signal,
      contextManagement: softPressure(scheduler),
    }).result;

    expect(result.finishReason).toBe('aborted');
    expect(await requested).toEqual({ outcome: 'cancelled', reason: 'signal', candidates: 0 });
    expect(schedule.cancelled).toBe(1);
    expect(gated.calls).toBe(0);
  });

  it('run cancellation aborts a running background summary so it cannot publish late', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });
    let requested: Promise<CompactionSchedulerOutcome> | undefined;
    const activeRun = createActiveRun({
      generate: async () => {
        schedule.fire();
        requested = scheduler.request();
        activeRun.abort('user stopped the run');
        return textResponse('unused');
      },
      toolbox: createTestToolbox([]),
      conversation,
      contextManagement: softPressure(scheduler),
    });

    const result = await activeRun.result;
    const revision = conversation.revision;
    gated.release();

    expect(result.finishReason).toBe('aborted');
    expect(await requested).toEqual({ outcome: 'cancelled', reason: 'signal', candidates: 1 });
    expect(conversation.revision).toBe(revision);
    expect(conversation.getMessages().some(isSummary)).toBe(false);
  });

  it('never blocks on a starved window, and the synchronous threshold supersedes it', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });
    const estimates = [100, 700, 100];
    let foregroundSummaries = 0;
    const onCompact = createContextCompactor({
      retainRecentMessages: 2,
      summarize: async () => {
        foregroundSummaries += 1;
        // The starved background job was withdrawn before this summary began.
        expect(scheduler.state.phase).toBe('cancelled');
        return 'foreground summary';
      },
    });
    let requested: Promise<CompactionSchedulerOutcome> | undefined;

    const result = await createActiveRun({
      generate: async (context) => {
        requested ??= scheduler.request();
        return textResponse(`reply ${context.step}`);
      },
      toolbox: createTestToolbox([]),
      conversation,
      maximumSteps: 2,
      contextManagement: {
        maxTokens: 1000,
        compactionThreshold: 500,
        tokenEstimator: () => estimates.shift() ?? 100,
        onCompact,
        background: { threshold: 50, scheduler },
      },
    }).result;

    // Both steps generated even though the background window never opened.
    expect(result.finishReason).toBe('maximum-steps');
    expect(result.steps).toHaveLength(2);
    expect(await requested).toEqual({ outcome: 'cancelled', reason: 'cancelled', candidates: 0 });
    expect(schedule.cancelled).toBe(1);
    expect(gated.calls).toBe(0);
    expect(foregroundSummaries).toBeGreaterThan(0);
    expect(isSummary(conversation.getMessages()[0])).toBe(true);
    await scheduler.dispose();
  });

  it('waits for an aborted background summary before the synchronous summary starts', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const gated = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: gated.summarizer,
      schedule: schedule.adapter,
    });
    const estimates = [100, 700, 100];
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('beforeCompaction', async () => {
      // The background summary is still running when the step decides to
      // compact synchronously; it returns only after being aborted.
      expect(scheduler.state.phase).toBe('running');
      gated.release();
    });
    const onCompact = createContextCompactor({
      retainRecentMessages: 2,
      summarize: async () => {
        expect(gated.active).toBe(0);
        expect(scheduler.state.phase).toBe('cancelled');
        return 'foreground summary';
      },
    });
    let background: Promise<CompactionSchedulerOutcome> | undefined;

    const result = await createActiveRun({
      generate: async (context) => {
        if (context.step === 0) {
          schedule.fire();
          background = scheduler.request();
        }
        return textResponse(`reply ${context.step}`);
      },
      toolbox: createTestToolbox([]),
      conversation,
      maximumSteps: 2,
      hooks,
      contextManagement: {
        maxTokens: 1000,
        compactionThreshold: 500,
        tokenEstimator: () => estimates.shift() ?? 100,
        onCompact,
        background: { threshold: 50, scheduler },
      },
    }).result;

    expect(result.finishReason).toBe('maximum-steps');
    expect(await background).toEqual({ outcome: 'cancelled', reason: 'cancelled', candidates: 1 });
    const messages = conversation.getMessages();
    expect(messages[0]?.content).toContain('foreground summary');
    expect(messages.filter(isSummary)).toHaveLength(1);
  });

  it('recovers from an overflow against a background compaction that commits during recovery', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const background = createGatedSummarizer();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: background.summarizer,
      compaction: { preserveRecentCount: 2 },
      schedule: schedule.adapter,
    });
    let overflowSummaries = 0;
    let maxActiveSummaries = 0;
    const mutate = createOverflowMutator({
      retainRecentMessages: 2,
      summarize: async () => {
        overflowSummaries += 1;
        maxActiveSummaries = Math.max(maxActiveSummaries, background.active + 1);
        // The background summary returns first, while this one is still being written.
        background.release();
        await untilState(scheduler, (state) => state.phase === 'committed');
        return 'overflow summary';
      },
    });
    let commits = 0;
    conversation.addEventListener('change', (event) => {
      if (event.action === 'compaction.completed') commits += 1;
    });
    const seen: (readonly Message[])[] = [];

    const result = await createActiveRun({
      generate: async (context) => {
        seen.push(context.conversation.getMessages());
        if (seen.length === 1) {
          // The window opens during the provider's network wait, at a durable boundary.
          schedule.fire();
          expect(scheduler.state.phase).toBe('running');
          throw new Error('context_length_exceeded');
        }
        return textResponse('recovered');
      },
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      maximumSteps: 2,
      retry: { attempts: 3, mutate },
      contextManagement: softPressure(scheduler),
    }).result;

    expect(result.error).toBeUndefined();
    expect(result.finishReason).toBe('stop-condition');
    // Recovery overlapped the running background summary instead of waiting for it.
    expect(overflowSummaries).toBeGreaterThan(0);
    expect(maxActiveSummaries).toBe(2);
    // The original attempt plus one retry, which read the compacted history.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveLength(12);
    expect(isSummary(seen[1]![0])).toBe(true);
    expect(contents(seen[1]!.slice(1))).toEqual(['question 5', 'answer 5']);
    // Exactly one summary was published: the background one.
    expect(commits).toBe(1);
    expect(scheduler.state).toMatchObject({ phase: 'committed', counts: { committed: 1 } });
    const messages = conversation.getMessages();
    expect(messages.filter(isSummary)).toHaveLength(1);
    expect(messages[0]?.content).toContain('Summary of');
    expect(contents(messages.slice(1))).toEqual(['question 5', 'answer 5', 'recovered']);
    await scheduler.dispose();
  });

  it('recovers from an overflow against a background compaction that committed while the request was in flight', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: async (messages) => `Summary of ${messages.length} messages`,
      compaction: { preserveRecentCount: 2 },
      schedule: schedule.adapter,
    });
    let overflowSummaries = 0;
    const mutate = createOverflowMutator({
      retainRecentMessages: 2,
      summarize: async () => {
        overflowSummaries += 1;
        return 'overflow summary';
      },
    });
    let commits = 0;
    conversation.addEventListener('change', (event) => {
      if (event.action === 'compaction.completed') commits += 1;
    });
    const seen: (readonly Message[])[] = [];
    let committed: CompactionSchedulerOutcome | undefined;

    const result = await createActiveRun({
      generate: async (context) => {
        seen.push(context.conversation.getMessages());
        if (seen.length === 1) {
          // The window opens during the provider's network wait, and the
          // candidate commits before the provider reports the overflow.
          schedule.fire();
          committed = await scheduler.request();
          throw new Error('context_length_exceeded');
        }
        return textResponse('recovered');
      },
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      maximumSteps: 2,
      retry: { attempts: 3, mutate },
      contextManagement: softPressure(scheduler),
    }).result;

    expect(result.error).toBeUndefined();
    expect(result.finishReason).toBe('stop-condition');
    expect(committed).toMatchObject({ outcome: 'committed', candidates: 1 });
    // The original attempt plus one retry, which read the compacted history.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveLength(12);
    expect(isSummary(seen[1]![0])).toBe(true);
    expect(contents(seen[1]!.slice(1))).toEqual(['question 5', 'answer 5']);
    // Recovery retried against the background compaction instead of compacting again.
    expect(overflowSummaries).toBe(0);
    expect(commits).toBe(1);
    const messages = conversation.getMessages();
    expect(messages.filter(isSummary)).toHaveLength(1);
    expect(contents(messages.slice(1))).toEqual(['question 5', 'answer 5', 'recovered']);
    await scheduler.dispose();
  });

  it('does not request background work at or below its threshold', async () => {
    const conversation = conversationWithHistory();
    const schedule = createManualSchedule();
    const scheduler = createCompactionScheduler(conversation, {
      summarizer: async () => 'unused',
      schedule: schedule.adapter,
    });

    await createActiveRun({
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      conversation,
      maximumSteps: 1,
      contextManagement: {
        ...softPressure(scheduler),
        tokenEstimator: () => 50,
      },
    }).result;

    expect(scheduler.state.phase).toBe('idle');
    expect(schedule.queued).toBe(0);
  });

  it('fails the step when the scheduler compacts a different conversation', async () => {
    const scheduler = createCompactionScheduler(conversationWithHistory(), {
      summarizer: async () => 'unused',
      schedule: createManualSchedule().adapter,
    });
    let generated = false;

    const result = await createActiveRun({
      generate: async () => {
        generated = true;
        return textResponse('unused');
      },
      toolbox: createTestToolbox([]),
      conversation: conversationWithHistory(),
      contextManagement: softPressure(scheduler),
    }).result;

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(AgentRunError);
    const error = result.error as AgentRunError;
    expect(error.kind).toBe('policy');
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.message).toContain('different conversation');
    expect(generated).toBe(false);
    expect(scheduler.state.phase).toBe('idle');
  });
});
