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
import { agentFileDirectory } from './sources/agent-file-directory';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { readChildJson } from './test/child-output-file';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import { CLAIM_RENEW_MS, CLAIM_TTL_MS } from './test/process-crash-work-integrity-fixtures';
import { createVendorCatalog } from './testing/vendor-catalog.test-support';

const CHILD = join(import.meta.dir, 'test', 'process-crash-child.ts');
const CHILD_WAIT_CALL_ID = 'parent-child-wait-call';

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
    const { runId, childRunId, contextId, agentsPath } = readChildJson<{
      runId: string;
      childRunId: string;
      contextId: string;
      agentsPath: string;
    }>(markerPath);
    const barrier = readChildJson<{
      childRecord: { status: string; outcome?: unknown };
      parentWaitingForSignals: readonly string[];
    }>(join(directory, 'afterChildSettlementBeforeParentWake'));
    expect(barrier.childRecord.status).toBe('completed');
    expect(barrier.parentWaitingForSignals).toEqual([`durable-child:${runId}:${childRunId}`]);
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));

    let generations = 0;
    let nextGenerationToolResults: readonly unknown[] = [];
    const bureau = await createBureau({
      agents: {},
      agentSource: agentFileDirectory(agentsPath),
      models: {
        catalog: createVendorCatalog().descriptors,
        generate:
          () =>
          async ({ step, conversation }) => {
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
                      name: 'bureau:child-runs-wait',
                      arguments: { childRunId },
                    },
                  ],
                }
              : { content: 'recovered', toolCalls: [] };
          },
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
          result: { status: 'settled', child: currentChildRecord },
        });
        expect(nextGenerationToolResults).toHaveLength(1);
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
            content: { status: 'settled', child: currentChildRecord },
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

async function unobservableScenario(scope: ScenarioScope): Promise<void> {
  const runtime = createDefaultRuntimeServices();
  const directory = createTemporaryDirectory('corvidae-cor2052-child-unobservable-');
  const storagePath = join(directory, 'bureau.sqlite');
  const markerPath = join(directory, 'marker.json');
  const fixture = createSqliteStorageFixture({ path: storagePath });
  try {
    const crashed = spawnWithHangGuard(
      ['bun', CHILD, 'child-wait-running', 'sqlite', storagePath, markerPath],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    scope.onHang(() => crashed.kill());
    await waitUntil(() => existsSync(join(directory, 'unobservable-ready')));
    await crashed.exited;
    expect(crashed.signalCode).toBe('SIGKILL');
    const { runId, childRunId } = readChildJson<{ runId: string; childRunId: string }>(markerPath);
    const ready = readChildJson<{
      parentWaitingForSignals: readonly string[];
      childRecord: { status: string; childRunId: string };
    }>(join(directory, 'unobservable-ready'));
    expect(ready.parentWaitingForSignals).toEqual([`durable-child:${runId}:${childRunId}`]);
    expect(ready.childRecord).toMatchObject({ status: 'running', childRunId });
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));

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
    const ownerRuns = [
      { generations: 0, steps: [] as number[], toolResults: [] as readonly unknown[] },
      { generations: 0, steps: [] as number[], toolResults: [] as readonly unknown[] },
    ];
    const createRecoveryStorage = () => {
      const rawStorage = fixture.open();
      return new Proxy(rawStorage, {
        get(target, property, receiver) {
          if (property === 'get') {
            return async (key: string) => {
              if (key === 'wf:child-1')
                throw new Error('child workflow unavailable during recovery');
              return target.get(key);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const createRecoveryBureau = async (owner: (typeof ownerRuns)[number]) =>
      createBureau({
        models: { catalog: createVendorCatalog().descriptors },
        agents: {
          planner: createAgent({
            name: 'planner',
            toolbox: createToolbox([waitForChild]),
            generate: async ({ step, conversation }) => {
              owner.generations += 1;
              owner.steps.push(step);
              owner.toolResults = conversation
                .getMessages()
                .filter((message) => message.role === 'tool-result')
                .map((message) => message.toolResult);
              return { content: 'recovered', toolCalls: [] };
            },
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: createRecoveryStorage(),
        durable: true,
        onDiagnostic: () => {},
        runtime,
        durableOwnership: {
          ownership: 'workflow-lease',
          workflowClaimTtlMs: CLAIM_TTL_MS,
          workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
        },
      });
    const bureaus = await Promise.all(ownerRuns.map(createRecoveryBureau));
    scope.onHang(() => Promise.all(bureaus.map((bureau) => bureau.shutdown())));
    try {
      await Promise.all(bureaus.map((bureau) => bureau.recovery()));
      await Promise.all(
        bureaus.map(async (bureau) => {
          const result = await bureau.tasks.wait(runId);
          expect(result?.status).toBe('completed');
        }),
      );
      expect(ownerRuns.reduce((total, owner) => total + owner.generations, 0)).toBe(1);
      expect(ownerRuns.flatMap((owner) => owner.steps)).toEqual([1]);
      expect(ownerRuns.flatMap((owner) => owner.toolResults)).toContainEqual(
        expect.objectContaining({
          callId: CHILD_WAIT_CALL_ID,
          content: { status: 'unobservable', child: expect.objectContaining({ childRunId }) },
        }),
      );
      const childRecord = await bureaus[0]?.children.get({ parentRunId: runId, childRunId });
      expect(childRecord).toMatchObject({ status: 'running' });
      const inspectionStorage = new BunSQLiteStorage(storagePath);
      try {
        const checkpointStore = createCheckpointStore(
          textValueStore(inspectionStorage, { disposeUnderlyingStorage: false }),
        );
        const stepsOnDisk = await checkpointStore.loadSteps(runId, { strict: true });
        expect(stepsOnDisk).toHaveLength(2);
        const originalStep = stepsOnDisk[0];
        if (originalStep === undefined) throw new Error('missing durable parent step');
        expect(originalStep.toolCalls).toContainEqual(
          expect.objectContaining({ id: CHILD_WAIT_CALL_ID, name: 'wait-for-child' }),
        );
        expect(
          originalStep.results.filter((entry) => entry.callId === CHILD_WAIT_CALL_ID),
        ).toHaveLength(1);
        expect(originalStep.results).toContainEqual(
          expect.objectContaining({
            callId: CHILD_WAIT_CALL_ID,
            toolCallId: CHILD_WAIT_CALL_ID,
            outcome: 'success',
            result: { status: 'unobservable', child: childRecord },
          }),
        );
      } finally {
        inspectionStorage[Symbol.dispose]();
      }
      expect(await bureaus[0]?.children.get({ parentRunId: runId, childRunId })).toMatchObject({
        status: 'running',
      });
    } finally {
      await Promise.all(bureaus.map((bureau) => bureau.shutdown()));
    }
  } finally {
    await fixture.dispose();
    removeTemporaryPath(directory);
  }
}

const outcome = await settleScenario(crashScenario, HANG_GUARD_MILLISECONDS);
const unobservableOutcome = await settleScenario(unobservableScenario, HANG_GUARD_MILLISECONDS);

describe('durable child settlement across SIGKILL', () => {
  it('recovers a parked parent and publishes one original-call result from SQLite', () => {
    expectScenarioPassed(outcome);
  });

  it('reports a recovered running child as unobservable after topology recovery', () => {
    expectScenarioPassed(unobservableOutcome);
  });
});
