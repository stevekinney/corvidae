/**
 * COR-1302 — a durable run's `AgentRun.id` survives recovery unchanged.
 *
 * Process A starts a durable run and parks it; A's engine is disposed (the
 * simulated crash); process B builds a fresh engine over the same storage,
 * which recovers the parked workflow on boot and hands it to the host's
 * recovery hook; B re-attaches to it from what that hook received
 * (`reattachDurableActiveRun` → `createAgentRun`). The recovered handle must
 * carry the id the original one did, and both durable `ActiveRun` producers must report that id as both
 * `runId` and `snapshot().id`.
 */
import {
  MemoryStorage,
  type RecoverAllOptions,
  textValueStore,
  workflow,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentRun } from '../agent-run';
import { stopWhen } from '../conditions/index';
import { createActiveRun } from '../create-run';
import type { RunOptions } from '../types';
import { reattachDurableActiveRun } from './active-run-reattach';
import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine } from './create-run-engine';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from './run-workflow-result';

const RUN_ID = 'cor-1302-recovered-run';

type RecoveredWorkflowInfo = Parameters<NonNullable<RecoverAllOptions['onRecoveredWorkflow']>>[0];

// Bounded, event-loop-turn poll — never a real timer delay.
const EVENT_LOOP_POLL_MAX_ATTEMPTS = 500;
async function waitForEventLoop(predicate: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < EVENT_LOOP_POLL_MAX_ATTEMPTS; attempt++) {
    if (await predicate()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('waitForEventLoop exceeded its attempt bound before the condition held');
}

/**
 * Stands in for the agent-run workflow: it parks on a durable signal so the
 * first engine can be disposed mid-run, then returns a well-formed agent-run
 * result once the recovered run is signaled.
 */
function makeParkingRunWorkflow() {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx, input: { runId: string }) {
    yield* ctx.waitForSignal('proceed');
    return {
      schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
      runId: input.runId,
      steps: 1,
      content: 'resumed',
      finishReason: 'stop-condition' as const,
    };
  });
}

function runOptions(): RunOptions {
  return {
    generate: async () => ({ content: 'unused', toolCalls: [] }),
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  };
}

describe('AgentRun.id across durable recovery (COR-1302)', () => {
  it('gives the recovered handle the id the pre-restart handle had', async () => {
    const storage = new MemoryStorage();

    // Process A.
    const firstCheckpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const { engine: firstEngine } = await createRunEngine({
      storage,
      runWorkflow: makeParkingRunWorkflow(),
      recover: false,
      startScheduler: false,
    });
    const originalActiveRun = createActiveRun(runOptions(), {
      engine: firstEngine,
      checkpointStore: firstCheckpointStore,
      runId: RUN_ID,
      prompt: 'hello',
    });
    const original = createAgentRun(originalActiveRun);
    const originalId = original.id;
    expect(originalId).toBe(RUN_ID);
    expect(originalActiveRun.runId).toBe(RUN_ID);
    expect(original.snapshot().id).toBe(RUN_ID);

    await originalActiveRun.durablyStarted;
    await waitForEventLoop(async () => {
      const state = await firstEngine.get(RUN_ID);
      return state?.status === 'running';
    });

    // The simulated crash: A's engine goes away with the run still parked.
    firstEngine[Symbol.dispose]();
    void original.result().catch(() => {});

    // Process B: a fresh engine over the same storage recovers the run on boot.
    const secondCheckpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    // B learns the run only from what its engine recovered: the workflow id
    // and handle Weft hands the host's recovery hook, as Bureau's own
    // `onRecoveredWorkflow` receives them. Nothing below reads `RUN_ID`
    // except the final comparisons.
    const recoveredWorkflows: RecoveredWorkflowInfo[] = [];
    const { engine: secondEngine } = await createRunEngine({
      storage,
      runWorkflow: makeParkingRunWorkflow(),
      startScheduler: false,
      resolveWorkflowServices: () => ({ status: 'available', services: {} }),
      onRecoveredWorkflow: (info) => {
        recoveredWorkflows.push(info);
      },
    });

    try {
      await waitForEventLoop(() => recoveredWorkflows.length > 0);
      expect(recoveredWorkflows).toHaveLength(1);
      const [recoveredWorkflow] = recoveredWorkflows;
      if (!recoveredWorkflow) throw new Error('engine B recovered no workflow');
      const recoveredActiveRun = reattachDurableActiveRun(
        { engine: secondEngine, checkpointStore: secondCheckpointStore },
        { runId: recoveredWorkflow.workflowId, handle: recoveredWorkflow.handle },
      );
      const recovered = createAgentRun(recoveredActiveRun);

      expect(recovered.id).toBe(originalId);
      expect(recoveredActiveRun.runId).toBe(originalId);
      expect(recovered.snapshot().id).toBe(originalId);

      await secondEngine.signal(recovered.id, 'proceed');
      const result = await recovered.result();
      expect(result.finishReason).toBe('stop-condition');
      expect(recovered.id).toBe(originalId);
      expect(recovered.snapshot().id).toBe(originalId);
    } finally {
      secondEngine[Symbol.dispose]();
    }
  });
});
