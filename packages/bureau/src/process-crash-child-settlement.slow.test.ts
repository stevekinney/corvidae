import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createAgent, createCheckpointStore, stopWhen } from '@lostgradient/operative';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { textValueStore } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { readChildJson } from './test/child-output-file';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import { CLAIM_RENEW_MS, CLAIM_TTL_MS } from './test/process-crash-work-integrity-fixtures';

const CHILD = join(import.meta.dir, 'test', 'process-crash-child.ts');
const CHILD_WAIT_CALL_ID = 'parent-child-wait-call';
const SIBLING_CALL_ID = 'parent-sibling-call';

async function crashScenario(scope: ScenarioScope): Promise<void> {
  const runtime = createDefaultRuntimeServices();
  const directory = createTemporaryDirectory('corvidae-cor2052-child-wait-');
  const storagePath = join(directory, 'bureau.sqlite');
  const markerPath = join(directory, 'marker.json');
  const fixture = createSqliteStorageFixture({ path: storagePath });
  try {
    const crashed = spawnWithHangGuard(
      ['bun', CHILD, 'child-wait-parked', 'sqlite', storagePath, markerPath],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    scope.onHang(() => crashed.kill());
    await waitUntil(() => existsSync(join(directory, 'afterChildSettlementBeforeParentWake')));
    await crashed.exited;
    expect(crashed.signalCode).toBe('SIGKILL');
    expect(existsSync(markerPath)).toBe(true);
    const { runId, childRunId, contextId } = readChildJson<{
      runId: string;
      childRunId: string;
      contextId: string;
    }>(markerPath);
    const barrier = readChildJson<{
      childRecord: { status: string; outcome?: unknown };
      parentWaitingForSignals: readonly string[];
    }>(join(directory, 'afterChildSettlementBeforeParentWake'));
    expect(barrier.childRecord.status).toBe('completed');
    expect(barrier.parentWaitingForSignals).toEqual([`durable-child:${runId}:${childRunId}`]);
    expect(readChildJson<string>(join(directory, 'siblingAction'))).toBe('ran');
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));

    let generations = 0;
    let nextGenerationToolResults: readonly unknown[] = [];
    const waitForChild = createTool({
      name: 'wait-for-child',
      description: 'Wait for the named child.',
      input: z.object({ childRunId: z.string() }),
      metadata: { durableChildWait: true },
      execute: async ({ childRunId }, context) => {
        const wait = context.executionContext?.['durableChildWait'];
        if (typeof wait !== 'function') throw new Error('missing durable child wait');
        return wait({ childRunId, toolCallId: context.meta?.callId ?? context.toolCall.id });
      },
    });
    const bureau = await createBureau({
      agents: {
        planner: createAgent({
          name: 'planner',
          toolbox: createToolbox([waitForChild]),
          generate: async ({ step, conversation }) => {
            generations += 1;
            nextGenerationToolResults = conversation
              .getMessages()
              .filter((message) => message.role === 'tool-result')
              .map((message) => message.toolResult);
            return step === 0
              ? {
                  content: 'unexpected replay',
                  toolCalls: [
                    {
                      id: CHILD_WAIT_CALL_ID,
                      name: 'wait-for-child',
                      arguments: { childRunId },
                    },
                  ],
                }
              : { content: 'recovered', toolCalls: [] };
          },
          stopWhen: stopWhen.noToolCalls(),
        }),
        worker: createAgent({
          name: 'worker',
          generate: async () => ({ content: 'child done', toolCalls: [] }),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: fixture.open(),
      durable: true,
      runtime,
      durableOwnership: {
        ownership: 'workflow-lease',
        workflowClaimTtlMs: CLAIM_TTL_MS,
        workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
      },
    });
    scope.onHang(() => bureau.shutdown());
    try {
      await bureau.recovery();
      const result = await bureau.tasks.wait(runId);
      if (result?.status === 'failed') throw new Error(JSON.stringify(result.error));
      expect(result?.status).toBe('completed');
      expect(generations).toBe(1);
      const childRecord = await bureau.children.get({ parentRunId: runId, childRunId });
      expect(childRecord?.status).toBe('completed');
      const currentChildRecord = childRecord;
      if (currentChildRecord === undefined) throw new Error('child terminal record disappeared');
      const inspectionStorage = new BunSQLiteStorage(storagePath);
      try {
        const checkpointStore = createCheckpointStore(
          textValueStore(inspectionStorage, { disposeUnderlyingStorage: false }),
        );
        const steps = await checkpointStore.loadSteps(runId, { strict: true });
        expect(steps).toHaveLength(2);
        const step = steps[0];
        if (step === undefined) throw new Error('missing durable parent step');
        const settledResults = step.results.filter(
          (result) => result.callId === CHILD_WAIT_CALL_ID,
        );
        expect(settledResults).toHaveLength(1);
        expect(settledResults[0]).toMatchObject({
          callId: CHILD_WAIT_CALL_ID,
          toolCallId: CHILD_WAIT_CALL_ID,
          outcome: 'success',
          result: { outcome: 'settled', child: currentChildRecord },
        });
        expect(step.results.filter((result) => result.callId === SIBLING_CALL_ID)).toHaveLength(1);
        expect(nextGenerationToolResults).toHaveLength(2);
        expect(
          nextGenerationToolResults.filter(
            (result) =>
              typeof result === 'object' &&
              result !== null &&
              (result as { callId?: unknown }).callId === CHILD_WAIT_CALL_ID,
          ),
        ).toHaveLength(1);
        expect(nextGenerationToolResults).toContainEqual(
          expect.objectContaining({
            callId: CHILD_WAIT_CALL_ID,
            content: { outcome: 'settled', child: currentChildRecord },
          }),
        );
      } finally {
        inspectionStorage[Symbol.dispose]();
      }
      const inspection = await bureau.tasks.inspect(runId, { step: 0 });
      expect(inspection?.steps).toHaveLength(1);
      expect(inspection?.steps[0]).toMatchObject({ step: 0, messageId: expect.any(String) });
      const session = await bureau.contexts.get(contextId);
      expect(
        Object.values(session?.conversationHistory.messages ?? {}).some((message) =>
          JSON.stringify(message).includes('recovered'),
        ),
      ).toBe(true);
      expect(generations).toBe(1);
    } finally {
      await bureau.shutdown();
    }
  } finally {
    await fixture.dispose();
    removeTemporaryPath(directory);
  }
}

const outcome = await settleScenario(crashScenario, HANG_GUARD_MILLISECONDS);

describe('durable child settlement across SIGKILL', () => {
  it('recovers a parked parent and publishes one original-call result from SQLite', () => {
    expectScenarioPassed(outcome);
  });
});
