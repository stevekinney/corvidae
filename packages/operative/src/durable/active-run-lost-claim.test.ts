import { CompletableEventTarget } from '@lostgradient/lifecycle';
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
import type { RegistryAgnosticEngine } from './create-run-engine';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from './run-workflow-result';

/**
 * COR-1390: under `ownership: 'workflow-lease'`, a holder whose claim lapses
 * (its renewal starved on a loaded host) is replaced by another engine that
 * finishes the run. The first engine's `handle.result()` still settles with
 * that outcome, read from the store, so without a check both engines fired
 * the terminal lifecycle: two `run.completed` events, two session writes, and
 * audit records from a bureau that no longer owned the run. The engine that
 * lost the claim must stay write-free, as it does for a lost checkpoint race.
 */

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

function completedSummary(runId: string) {
  return {
    schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
    runId,
    steps: 1,
    content: 'finished elsewhere',
    finishReason: 'stop-condition' as const,
  };
}

/** No checkpoint: the kept-claim control reconstructs from an empty run state. */
const emptyCheckpointStore = { loadCheckpoint: async () => null };

function engineThat(lostClaim: boolean, runId: string): RegistryAgnosticEngine {
  return {
    start: async () => ({ id: runId, result: () => Promise.resolve(completedSummary(runId)) }),
    lostWorkflowClaim: (handle: { id: string }) => lostClaim && handle.id === runId,
  } as unknown as RegistryAgnosticEngine;
}

function startFreshRun(lostClaim: boolean, runId: string) {
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  const terminalEvents = observeTerminalLifecycle(emitter);
  const activeRun = createDurableActiveRun(
    { engine: engineThat(lostClaim, runId), checkpointStore: emptyCheckpointStore } as never,
    { runId, sessionId: runId, options: runOptions(), emitter },
  );
  return { activeRun, terminalEvents };
}

function reattachRun(lostClaim: boolean, runId: string) {
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  const terminalEvents = observeTerminalLifecycle(emitter);
  const recoveredRun = reattachDurableActiveRun(
    { engine: engineThat(lostClaim, runId), checkpointStore: emptyCheckpointStore as never },
    {
      runId,
      handle: { id: runId, result: () => Promise.resolve(completedSummary(runId)) },
      emitter,
    },
  );
  return { recoveredRun, terminalEvents };
}

describe('a durable run whose workflow claim another engine took', () => {
  it('leaves a fresh run write-free and unreachable when the result is another engine’s', async () => {
    const { activeRun, terminalEvents } = startFreshRun(true, 'fresh-lost-claim');

    const result = await activeRun.result;
    await Promise.resolve();

    expect(result.finishReason).toBe('aborted');
    expect(terminalEvents).toEqual([]);
    expect(await activeRun.closed()).toEqual({ status: 'unresolved', reason: 'unreachable' });
  });

  it('still completes a fresh run on the engine that kept its claim', async () => {
    const { activeRun, terminalEvents } = startFreshRun(false, 'fresh-kept-claim');

    const result = await activeRun.result;
    await Promise.resolve();

    expect(result.finishReason).toBe('stop-condition');
    expect(terminalEvents).toEqual([RunCompletedEvent.type]);
  });

  it('leaves a reattached run write-free and unreachable when the result is another engine’s', async () => {
    const { recoveredRun, terminalEvents } = reattachRun(true, 'reattach-lost-claim');

    const result = await recoveredRun.result;

    expect(result.finishReason).toBe('aborted');
    expect(terminalEvents).toEqual([]);
    expect(await recoveredRun.closed()).toEqual({ status: 'unresolved', reason: 'unreachable' });
  });

  it('still completes a reattached run on the engine that kept its claim', async () => {
    const { recoveredRun, terminalEvents } = reattachRun(false, 'reattach-kept-claim');

    const result = await recoveredRun.result;

    expect(result.finishReason).toBe('stop-condition');
    expect(terminalEvents).toEqual([RunCompletedEvent.type]);
  });
});
