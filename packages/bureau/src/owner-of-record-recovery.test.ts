import { stopWhen, createAgent } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import type { AgentDefinitions } from './agent-catalog';
import { startTaskFrom } from './test/task-start-request.ts';
import { createSqliteStorageFixture } from './test/storage-fixtures';

function nextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

async function crashAndRecover(principal: string | undefined) {
  const database = createSqliteStorageFixture();
  let reachedStepOne = false;
  const crashed = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async ({ step }) => {
          if (step === 0)
            return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          reachedStepOne = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([nextTool()]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: database.storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
  const run = await startTaskFrom(crashed, {
    agentName: 'default',
    input: 'Be recovered',
    ...(principal === undefined ? {} : { principal }),
  });
  await waitForCondition(() => reachedStepOne, 'the first process never reached step one');
  // The first process is deliberately not disposed: it stands in for a crash.
  const recovered = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async ({ step }) => ({ content: `recovered ${step}`, toolCalls: [] }),
        toolbox: createToolbox([nextTool()]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: database.open(),
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
  await waitForCondition(
    () => recovered.tasks.detail(run.id)?.status !== 'running',
    'the recovered run never finished',
  );
  return {
    run,
    recovered,
    cleanup: async () => {
      await recovered.dispose();
      await crashed.dispose();
      await database.dispose();
    },
  };
}

describe('a run recovered after a restart (COR-718)', () => {
  it('keeps its owner, and records recovery as the actor, once', async () => {
    const { run, recovered, cleanup } = await crashAndRecover('api-key:alice');
    try {
      expect(await recovered.ownerOf({ kind: 'run', id: run.id })).toBe('api-key:alice');
      expect(recovered.tasks.detail(run.id)?.principal).toBe('api-key:alice');
      await waitForCondition(async () => {
        const entries = await recovered.internals.auditTrail?.query({
          runId: run.id,
          type: 'run.recovered',
        });
        return entries?.length === 1;
      }, 'run.recovered was never recorded');
      const entries = await recovered.internals.auditTrail?.query({
        runId: run.id,
        type: 'run.recovered',
      });
      expect(entries?.map((entry) => entry.principal)).toEqual(['system:recovery']);
      expect(await recovered.ownerOf({ kind: 'audit', runId: run.id })).toBe('api-key:alice');
    } finally {
      await cleanup();
    }
  });

  it('keeps anonymous:local as the owner of a run that was created with no principal', async () => {
    const { run, recovered, cleanup } = await crashAndRecover(undefined);
    try {
      expect(await recovered.ownerOf({ kind: 'run', id: run.id })).toBe('anonymous:local');
      await waitForCondition(async () => {
        const entries = await recovered.internals.auditTrail?.query({
          runId: run.id,
          type: 'run.recovered',
        });
        return entries?.length === 1;
      }, 'run.recovered was never recorded');
    } finally {
      await cleanup();
    }
  });
});
