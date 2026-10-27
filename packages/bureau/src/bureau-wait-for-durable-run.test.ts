/**
 * `Bureau.waitForDurableRun` resolves once a run's durable workflow is terminal in the durable
 * store, built on Weft's result waiter so that a bureau which does not own the run still waits for
 * the engine that does.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import type { WorkflowState } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau, resolveWaitForDurableRun } from './create-bureau';
import { waitForCondition } from './test';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';

const bureaus: Bureau[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.shutdown();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function durableBureau(
  generate: GenerateFunction,
  options: { readonly storagePath?: string } = {},
): Promise<Bureau> {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate,
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage:
      options.storagePath === undefined
        ? { type: 'memory' }
        : { type: 'sqlite', path: options.storagePath },
    durable: true,
    ...(options.storagePath === undefined
      ? {}
      : {
          durableOwnership: {
            ownership: 'workflow-lease' as const,
            workflowClaimTtlMs: 200,
            workflowClaimRenewIntervalMs: 50,
          },
        }),
  });
  bureaus.push(bureau);
  return bureau;
}

describe('Bureau.waitForDurableRun', () => {
  it('resolves with the terminal state once this bureau commits the run', async () => {
    const bureau = await durableBureau(async () => ({ content: 'done', toolCalls: [] }));
    const run = await bureau.createRun({ agentName: 'default', message: 'go' });

    const state = await bureau.tasks.wait(run.id);

    expect(state?.status).toBe('completed');
    const durable = await bureau.tasks.workflow(run.id);
    expect(durable?.status).toBe('completed');
  });

  it('resolves immediately for a run that is already terminal', async () => {
    const bureau = await durableBureau(async () => ({ content: 'done', toolCalls: [] }));
    const run = await bureau.createRun({ agentName: 'default', message: 'go' });
    await bureau.tasks.wait(run.id);

    const again = await bureau.tasks.wait(run.id);

    expect(again?.status).toBe('completed');
  });

  it('resolves null for a run the durable engine does not know', async () => {
    const bureau = await durableBureau(async () => ({ content: 'done', toolCalls: [] }));

    expect(await bureau.tasks.wait('no-such-run')).toBeNull();
  });

  it('resolves undefined when no durable engine is composed', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'done', toolCalls: [] }),
          toolbox: createToolbox([]),
        }),
      },
    });
    bureaus.push(bureau);

    expect(await bureau.tasks.wait('any-run')).toBeUndefined();
  });

  it('resolves in a bureau that does not own the run, once another bureau over the same store commits it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-wait-for-durable-run-'));
    directories.push(directory);
    const storagePath = join(directory, 'bureau');
    const release = Promise.withResolvers<void>();
    const owner = await durableBureau(
      async () => {
        await release.promise;
        return { content: 'done', toolCalls: [] };
      },
      { storagePath },
    );
    const run = await owner.createRun({ agentName: 'default', message: 'go' });
    const observer = await durableBureau(async () => ({ content: 'unused', toolCalls: [] }), {
      storagePath,
    });

    const waiting = observer.tasks.wait(run.id);
    release.resolve();
    const state = await waiting;

    expect(state?.status).toBe('completed');
  });

  describe('resolveWaitForDurableRun', () => {
    const running = { id: 'r', status: 'running' } as unknown as WorkflowState;
    const failed = { id: 'r', status: 'failed' } as unknown as WorkflowState;

    it('propagates a rejection that leaves the run non-terminal instead of resolving with it', async () => {
      const rejection = await resolveWaitForDurableRun('r', {
        getDurableRun: async () => running,
        awaitResult: async () => {
          throw new Error('transient read failure');
        },
        manualBackgroundTasks: false,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect((rejection as Error | undefined)?.message).toBe('transient read failure');
    });

    it('accepts a rejection once the store confirms the run is terminal', async () => {
      let reads = 0;
      const state = await resolveWaitForDurableRun('r', {
        getDurableRun: async () => (reads++ === 0 ? running : failed),
        awaitResult: async () => {
          throw new Error('the run failed');
        },
        manualBackgroundTasks: false,
      });

      expect(state?.status).toBe('failed');
    });

    it('does not report a waiter that resolved while the run is still non-terminal as settled', async () => {
      const rejection = await resolveWaitForDurableRun('r', {
        getDurableRun: async () => running,
        awaitResult: async () => {},
        manualBackgroundTasks: false,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(rejection).toBeInstanceOf(Error);
    });
  });

  it('refuses to wait for a non-terminal run under maintenance: manual, and still reports a terminal one', async () => {
    const release = Promise.withResolvers<void>();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => {
            await release.promise;
            return { content: 'done', toolCalls: [] };
          },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'memory' },
      durable: true,
      maintenance: 'manual',
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({ agentName: 'default', message: 'go' });

    const refusal = await bureau.tasks.wait(run.id).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((refusal as { code?: string } | undefined)?.code).toBe('UNSUPPORTED_CAPABILITY');

    release.resolve();
    await waitForCondition(async () => {
      const durable = await bureau.tasks.workflow(run.id);
      return durable?.status === 'completed';
    }, 'the run never completed');
    const terminal = await bureau.tasks.wait(run.id);
    expect(terminal?.status).toBe('completed');
  });
});
