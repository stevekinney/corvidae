import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopWhen, createAgent } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import type { AgentDefinitions } from './agent-catalog';

function nextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

async function crashAndRecover(principal: string | undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-recovery-'));
  const path = join(directory, 'bureau.sqlite');
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
    storage: { type: 'sqlite', path },
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
  const run = await crashed.createRun({
    agentName: 'default',
    message: 'Be recovered',
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
    storage: { type: 'sqlite', path },
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
  await waitForCondition(
    () => recovered.getRun(run.id)?.status !== 'running',
    'the recovered run never finished',
  );
  return {
    run,
    recovered,
    cleanup: async () => {
      await recovered.dispose();
      await crashed.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('a run recovered after a restart (COR-718)', () => {
  it('keeps its owner, and records recovery as the actor, once', async () => {
    const { run, recovered, cleanup } = await crashAndRecover('api-key:alice');
    try {
      expect(await recovered.getOwner({ kind: 'run', id: run.id })).toBe('api-key:alice');
      expect(recovered.getRun(run.id)?.principal).toBe('api-key:alice');
      await waitForCondition(async () => {
        const entries = await recovered.auditTrail?.query({ runId: run.id, type: 'run.recovered' });
        return entries?.length === 1;
      }, 'run.recovered was never recorded');
      const entries = await recovered.auditTrail?.query({ runId: run.id, type: 'run.recovered' });
      expect(entries?.map((entry) => entry.principal)).toEqual(['system:recovery']);
      expect(await recovered.getOwner({ kind: 'audit', runId: run.id })).toBe('api-key:alice');
    } finally {
      await cleanup();
    }
  });

  it('keeps anonymous:local as the owner of a run that was created with no principal', async () => {
    const { run, recovered, cleanup } = await crashAndRecover(undefined);
    try {
      expect(await recovered.getOwner({ kind: 'run', id: run.id })).toBe('anonymous:local');
      await waitForCondition(async () => {
        const entries = await recovered.auditTrail?.query({ runId: run.id, type: 'run.recovered' });
        return entries?.length === 1;
      }, 'run.recovered was never recorded');
    } finally {
      await cleanup();
    }
  });
});
