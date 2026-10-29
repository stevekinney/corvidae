/**
 * COR-1509 — a run that a durable engine reclaims while its bureau is still being composed must
 * wait for the composition, not be durably failed with "composition not ready".
 *
 * The window is real: with `ownership: 'workflow-lease'` the engine starts reclaiming workflows
 * whose claim has lapsed on its own interval as soon as it exists, which is before
 * `createRuntimeComposition` has assembled the closure `resolveRunServices` reads. These tests hold
 * the composition open (through the governed memory's `init`, the one awaited step after the
 * engine is built) while a second bureau reclaims a run whose owner stopped renewing, so the
 * window is open for as long as the test needs, with no timing involved.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { openGovernedMemory } from './test/process-crash-work-integrity-fixtures';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const bureaus: Bureau[] = [];
const closers: Array<() => unknown> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.shutdown();
  for (const close of closers.splice(0)) close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

describe('a run reclaimed while the bureau is still being composed (COR-1509)', () => {
  it('is held for the composition and then resumed, not durably failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'recovery-before-composition-'));
    directories.push(directory);
    await using storageFixture = createSqliteStorageFixture({ path: join(directory, 'bureau') });

    // The owner reaches step 1, then stops: its claim is never renewed, so it lapses.
    const reachedStepOne = Promise.withResolvers<void>();
    const owner = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async ({ step }) => {
            if (step === 0)
              return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
            reachedStepOne.resolve();
            return new Promise<never>(() => {});
          },
          toolbox: createToolbox([nextTool]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: storageFixture.storage,
      durable: true,
      maintenance: 'manual',
      durableOwnership: {
        ownership: 'workflow-lease',
        workflowClaimTtlMs: 200,
        workflowClaimRenewIntervalMs: 50,
      },
    });
    bureaus.push(owner);
    const run = await owner.tasks.start('default', 'go');
    await reachedStepOne.promise;

    // The second bureau reclaims it while its composition is held open.
    const governed = await openGovernedMemory(directory);
    closers.push(governed.close);
    const compositionHeld = Promise.withResolvers<void>();
    const initEntered = Promise.withResolvers<void>();
    const memory = new Proxy(governed.memory, {
      get(target, property) {
        if (property === 'init') {
          return async () => {
            initEntered.resolve();
            await compositionHeld.promise;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const held = Promise.withResolvers<void>();
    const generate: GenerateFunction = async () => ({ content: 'recovered', toolCalls: [] });
    const successor = createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate,
          toolbox: createToolbox([nextTool]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: storageFixture.open(),
      id: 'recovery-before-composition',
      memory,
      durable: true,
      durableOwnership: {
        ownership: 'workflow-lease',
        workflowClaimTtlMs: 200,
        workflowClaimRenewIntervalMs: 50,
      },
      onDiagnostic: (diagnostic) => {
        if (diagnostic.scope === 'recovery' && diagnostic.message.includes(run.id)) {
          held.resolve();
        }
      },
    });
    await initEntered.promise;
    // The composition is held open. The successor's reclaim reaches the resolver, which says so.
    await held.promise;
    compositionHeld.resolve();
    const bureau = await successor;
    bureaus.push(bureau);
    const report = await bureau.recovery();
    expect(report?.outcome).toBe('clean');

    const state = await bureau.tasks.workflow(run.id);
    expect(state?.status).not.toBe('failed');
    expect(state?.error ?? '').not.toContain('composition not ready');

    await waitForCondition(
      () => bureau.tasks.detail(run.id)?.status === 'completed',
      'the reclaimed run never completed',
    );
    const auditTrail = bureau.internals.auditTrail;
    if (auditTrail === undefined) throw new Error('the bureau has no audit trail');
    const steps = await auditTrail.query({ runId: run.id, type: 'step.completed' });
    // The reclaimed run was reattached, so its session reached a terminal status rather than being
    // left `running`, and its terminal event was delivered and recorded.
    const session = await bureau.contexts.get(run.contextId);
    expect(session?.metadata['lastRunStatus']).toBe('completed');
    const terminal = await auditTrail.query({ runId: run.id, type: 'run.completed' });
    expect(terminal).toHaveLength(1);
    // Step 0 was recorded by the owner; the successor's step 1 must be recorded too, which needs
    // the bureau to have been watching the run before that step ran.
    expect(steps).toHaveLength(2);
  });
});
