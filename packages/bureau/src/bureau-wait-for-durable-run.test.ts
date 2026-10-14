/**
 * `Bureau.waitForDurableRun` resolves once a run's durable workflow is terminal in the durable
 * store, built on Weft's result waiter so that a bureau which does not own the run still waits for
 * the engine that does.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { Bureau } from './types';

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
  const bureau = await createBureau({
    agents: {},
    generate,
    toolbox: createToolbox([]),
    storage:
      options.storagePath === undefined
        ? { type: 'memory' }
        : { type: 'sqlite', path: options.storagePath },
    durableExecution: true,
    stopWhen: stopWhen.noToolCalls(),
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
    const run = await bureau.createRun({ message: 'go' });

    const state = await bureau.waitForDurableRun(run.id);

    expect(state?.status).toBe('completed');
    const durable = await bureau.getDurableRun(run.id);
    expect(durable?.status).toBe('completed');
  });

  it('resolves immediately for a run that is already terminal', async () => {
    const bureau = await durableBureau(async () => ({ content: 'done', toolCalls: [] }));
    const run = await bureau.createRun({ message: 'go' });
    await bureau.waitForDurableRun(run.id);

    const again = await bureau.waitForDurableRun(run.id);

    expect(again?.status).toBe('completed');
  });

  it('resolves null for a run the durable engine does not know', async () => {
    const bureau = await durableBureau(async () => ({ content: 'done', toolCalls: [] }));

    expect(await bureau.waitForDurableRun('no-such-run')).toBeNull();
  });

  it('resolves undefined when no durable engine is composed', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: async () => ({ content: 'done', toolCalls: [] }),
      toolbox: createToolbox([]),
    });
    bureaus.push(bureau);

    expect(await bureau.waitForDurableRun('any-run')).toBeUndefined();
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
    const run = await owner.createRun({ message: 'go' });
    const observer = await durableBureau(async () => ({ content: 'unused', toolCalls: [] }), {
      storagePath,
    });

    const waiting = observer.waitForDurableRun(run.id);
    release.resolve();
    const state = await waiting;

    expect(state?.status).toBe('completed');
  });
});
