/**
 * COR-851 — a `beforeBackgroundCompaction` handler that returns `false` withdraws a
 * step's background compaction request. A fence over a
 * run (a goal attempt whose goal ended) relies on this: a background candidate
 * calls a model and writes the conversation, and it must not start for a step the
 * run is not allowed to take.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import { createTestToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, createCompactionScheduler, type Summarizer } from 'conversationalist';

import { createActiveRun } from '../src/create-run';
import type { OperativeHookMap } from '../src/hooks';

function conversationWithHistory(): Conversation {
  const conversation = new Conversation();
  for (let index = 0; index < 6; index++) {
    conversation.appendUserMessage(`question ${index}`);
    conversation.appendAssistantMessage(`answer ${index}`);
  }
  return conversation;
}

async function runUnderSoftPressure(register?: (hooks: HookRegistry<OperativeHookMap>) => void) {
  const conversation = conversationWithHistory();
  const summarizer: Summarizer = (messages) => Promise.resolve(`Summary of ${messages.length}`);
  const scheduler = createCompactionScheduler(conversation, {
    summarizer,
    compaction: { preserveRecentCount: 2 },
    // A schedule that never fires: a request that is made stays counted and queued.
    schedule: { schedule: () => () => undefined },
  });
  const hooks = new HookRegistry<OperativeHookMap>();
  register?.(hooks);
  const result = await createActiveRun({
    generate: () => Promise.resolve({ content: 'done', toolCalls: [] }),
    toolbox: createTestToolbox([]),
    conversation,
    maximumSteps: 1,
    hooks,
    contextManagement: {
      maxTokens: 1000,
      compactionThreshold: 500,
      tokenEstimator: () => 100,
      onCompact: () => Promise.resolve(),
      background: { threshold: 50, scheduler },
    },
  }).result;
  const requested = scheduler.state.counts.requested;
  await scheduler.dispose();
  return { result, requested };
}

describe('background compaction and beforeBackgroundCompaction', () => {
  it('requests background compaction when no handler objects', async () => {
    const { requested } = await runUnderSoftPressure();

    expect(requested).toBe(1);
  });

  it('requests background compaction when a handler gives no verdict', async () => {
    let consulted = 0;
    const { requested } = await runUnderSoftPressure((hooks) => {
      hooks.on('beforeBackgroundCompaction', () => {
        consulted += 1;
        return Promise.resolve(undefined);
      });
    });

    expect(consulted).toBe(1);
    expect(requested).toBe(1);
  });

  it('does not request background compaction when a handler withdraws it', async () => {
    let consulted = 0;
    const { result, requested } = await runUnderSoftPressure((hooks) => {
      hooks.on('beforeBackgroundCompaction', () => {
        consulted += 1;
        return Promise.resolve(false);
      });
    });

    expect(consulted).toBe(1);
    expect(requested).toBe(0);
    expect(result.finishReason).toBe('maximum-steps');
  });

  it('hands the handler the step signal and a budget that says the synchronous threshold is not exceeded', async () => {
    let signal: AbortSignal | undefined;
    let exceeds: boolean | undefined;
    await runUnderSoftPressure((hooks) => {
      hooks.on('beforeBackgroundCompaction', (context) => {
        signal = context.signal;
        exceeds = context.budget.exceeds;
        return Promise.resolve(undefined);
      });
    });

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(exceeds).toBe(false);
  });
});

describe('beforeCompaction and background compaction', () => {
  it('does not consult beforeCompaction for a step that only requests background compaction', async () => {
    let consulted = 0;
    const { requested } = await runUnderSoftPressure((hooks) => {
      hooks.on('beforeCompaction', () => {
        consulted += 1;
        return Promise.resolve(false);
      });
    });

    expect(consulted).toBe(0);
    expect(requested).toBe(1);
  });
});
