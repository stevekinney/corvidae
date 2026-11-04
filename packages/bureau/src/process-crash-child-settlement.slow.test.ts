import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createAgent, stopWhen } from '@lostgradient/operative';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
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
    const { runId, childRunId } = readChildJson<{ runId: string; childRunId: string }>(markerPath);
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));

    let generations = 0;
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
          generate: async ({ step }) => {
            generations += 1;
            return step === 0
              ? {
                  content: 'unexpected replay',
                  toolCalls: [{ name: 'wait-for-child', arguments: { childRunId } }],
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
