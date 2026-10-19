import { CompletableEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, workflow, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { stopWhen } from '../conditions/index';
import {
  type CombinedOperativeEventMap,
  RunAbortedEvent,
  RunCompletedEvent,
  RunErrorEvent,
} from '../events';
import type { RunOptions } from '../types';
import { createDurableActiveRun } from './active-run-create';
import { reattachDurableActiveRun } from './active-run-reattach';
import { createRunEngine } from './create-run-engine';

/**
 * A run one engine drives is reclaimed by another, whose history circuit breaker
 * times it out. Both engines' `handle.result()` reject with that timeout, and only
 * the engine that committed it may publish the terminal lifecycle. Real engines on
 * one store, so the committer comes from the terminal write itself.
 */

const claimTtlMs = 30;
const claimRenewIntervalMs = 10;

function runOptions(): RunOptions {
  return {
    generate: async () => ({ content: 'unused', toolCalls: [] }),
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  };
}

function observeTerminalLifecycle(emitter: CompletableEventTarget<CombinedOperativeEventMap>) {
  const terminalEvents: string[] = [];
  for (const type of [RunCompletedEvent.type, RunErrorEvent.type, RunAbortedEvent.type]) {
    emitter.addEventListener(type, () => terminalEvents.push(type));
  }
  return terminalEvents;
}

function makeParkingWorkflow() {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx) {
    yield* ctx.run(async () => 'started');
    yield* ctx.waitForSignal('proceed');
    return 'unreachable';
  });
}

async function pollUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await predicate()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('pollUntil exceeded its attempt bound before the condition held');
}

const emptyCheckpointStore = { loadCheckpoint: async () => null };

describe('a run another engine reclaimed and timed out', () => {
  it('is published once, by the engine that committed the timeout', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const commonOptions = {
      storage,
      runWorkflow: makeParkingWorkflow(),
      recover: false,
      ownership: 'workflow-lease' as const,
      workflowClaimTtlMs: claimTtlMs,
      workflowClaimRenewIntervalMs: claimRenewIntervalMs,
      getNow: () => now,
      backgroundTasks: 'manual' as const,
    };
    const a = await createRunEngine(commonOptions);
    const b = await createRunEngine({
      ...commonOptions,
      history: { maxEvents: 1 },
      resolveWorkflowServices: () => ({ status: 'available' as const, services: {} }),
    });
    const runId = 'reclaimed-and-timed-out';

    try {
      const emitterA = new CompletableEventTarget<CombinedOperativeEventMap>();
      const eventsOnA = observeTerminalLifecycle(emitterA);
      const activeRun = createDurableActiveRun(
        { engine: a.engine, checkpointStore: emptyCheckpointStore } as never,
        { runId, sessionId: runId, options: runOptions(), emitter: emitterA },
      );
      await activeRun.durablyStarted;
      await pollUntil(async () => {
        const snapshot = await a.engine.getHandle(runId).snapshot();
        return snapshot?.status === 'running';
      });

      // A stops renewing; B reclaims the run and its history circuit breaker times it out.
      now += claimTtlMs + 2 * claimRenewIntervalMs + 1;
      await b.engine.runMaintenance(now);
      const emitterB = new CompletableEventTarget<CombinedOperativeEventMap>();
      const eventsOnB = observeTerminalLifecycle(emitterB);
      const recoveredRun = reattachDurableActiveRun(
        { engine: b.engine, checkpointStore: emptyCheckpointStore as never },
        { runId, handle: b.engine.getHandle(runId), emitter: emitterB },
      );
      await recoveredRun.result;

      // A's own result settles with the same timeout, read back from the store.
      now += 1;
      await a.engine.runMaintenance(now);
      await activeRun.result;
      await Promise.resolve();

      expect(eventsOnB).toEqual([RunErrorEvent.type, RunCompletedEvent.type]);
      expect(eventsOnA).toEqual([]);
      expect(await activeRun.closed()).toEqual({ status: 'unresolved', reason: 'unreachable' });
    } finally {
      a.engine[Symbol.dispose]();
      b.engine[Symbol.dispose]();
    }
  });
});
