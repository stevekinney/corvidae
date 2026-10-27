/**
 * COR-1716 readiness probe: capture the current default shutdown behavior before adding detach.
 *
 * These assertions intentionally describe the red baseline for graceful host shutdown: the
 * default policy aborts a durable parked run, while a process-local run is aborted and settles.
 */
import { createAgent, stopWhen } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, test } from 'bun:test';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import type { Bureau } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];
const databasePaths: string[] = [];

async function waitForReview(bureau: Bureau<AgentDefinitions>, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (bureau.reviews.list().some((review) => review.runId === runId)) return;
    await yieldToPortableEventLoop();
  }
  throw new Error(`Run "${runId}" did not park for human input.`);
}

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const path of databasePaths.splice(0)) removeTemporaryPath(path);
});

describe('COR-1716 shutdown readiness baseline', () => {
  test('default shutdown aborts a durable parked run instead of leaving it recoverable', async () => {
    const databasePath = createTemporaryPath('cor-1716-shutdown-baseline', '.sqlite');
    databasePaths.push(databasePath);
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        asker: createAgent({
          generate: async () => ({
            content: '',
            toolCalls: [
              {
                id: 'human-wait',
                name: 'requestHumanInput',
                arguments: { signalName: 'answer', prompt: 'Continue?' },
              },
            ],
          }),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.toolCalled('requestHumanInput'),
        }),
      },
      storage: { type: 'sqlite', path: databasePath },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(bureau);

    const run = await bureau.createRun({ agentName: 'asker', message: 'park me' });
    await waitForReview(bureau, run.id);
    const durableRun = await bureau.getDurableRun(run.id);
    expect(durableRun?.status).toBe('running');

    const report = await bureau.shutdown();
    expect(report.policy).toBe('abort');
    expect(bureau.getRun(run.id)?.status).toBe('aborted');

    const restarted = await createBureau<AgentDefinitions>({
      agents: {},
      storage: { type: 'sqlite', path: databasePath },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(restarted);
    await restarted.waitForRecovery?.();
    const cancelled = await restarted.getDurableRun(run.id);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(restarted.reviews.list()).toEqual([]);
  });

  test('default shutdown aborts a process-local run and closed() settles', async () => {
    const generating = Promise.withResolvers<void>();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: ({ signal }) => {
            generating.resolve();
            return new Promise<never>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    bureaus.push(bureau);

    const run = bureau.run('default', 'hold me');
    await generating.promise;
    await bureau.shutdown();

    const result = await run.result();
    expect(result.finishReason).toBe('aborted');
    await expect(run.closed()).resolves.toBeDefined();
  });

  test('detach leaves a durable parked run recoverable and reports it separately', async () => {
    const databasePath = createTemporaryPath('cor-1716-shutdown-detach', '.sqlite');
    databasePaths.push(databasePath);
    const createAsker = () =>
      createAgent({
        generate: async () => ({
          content: '',
          toolCalls: [
            {
              id: 'human-wait',
              name: 'requestHumanInput',
              arguments: { signalName: 'answer', prompt: 'Continue?' },
            },
          ],
        }),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.toolCalled('requestHumanInput'),
      });
    const bureau = await createBureau<AgentDefinitions>({
      agents: { asker: createAsker() },
      storage: { type: 'sqlite', path: databasePath },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({ agentName: 'asker', message: 'park me' });
    await waitForReview(bureau, run.id);

    const report = await bureau.shutdown({ policy: 'detach' });
    expect(report).toMatchObject({ policy: 'detach', detached: 1 });
    expect(report.owners).toContainEqual({ kind: 'durable-engine', outcome: 'completed' });
    expect(bureau.getRun(run.id)?.status).not.toBe('aborted');

    const restarted = await createBureau<AgentDefinitions>({
      agents: { asker: createAsker() },
      storage: { type: 'sqlite', path: databasePath },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(restarted);
    await restarted.waitForRecovery?.();
    const review = restarted.reviews.list().find((candidate) => candidate.runId === run.id);
    expect(review).toBeDefined();
    if (review === undefined) throw new Error('Expected the detached review to survive.');
    await restarted.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'operator',
      payload: { answer: 'yes' },
    });
  });

  test('detach aborts a process-local run and still settles closed()', async () => {
    const generating = Promise.withResolvers<void>();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: ({ signal }) => {
            generating.resolve();
            return new Promise<never>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    bureaus.push(bureau);
    const run = bureau.run('default', 'hold me');
    await generating.promise;

    const report = await bureau.shutdown({ policy: 'detach' });
    expect(report.detached).toBe(0);
    const result = await run.result();
    expect(result.finishReason).toBe('aborted');
    await expect(run.closed()).resolves.toBeDefined();
  });

  test('detach retains abort behavior for catalog runs', async () => {
    const generating = Promise.withResolvers<void>();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: ({ signal }) => {
            generating.resolve();
            return new Promise<never>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'memory' },
      durable: true,
    });
    bureaus.push(bureau);
    const run = bureau.run('default', 'catalog hold');
    await generating.promise;

    const report = await bureau.shutdown({ policy: 'detach' });
    expect(report.detached).toBe(0);
    const result = await run.result();
    expect(result.finishReason).toBe('aborted');
  });

  test('detach does not count a pending tool approval as a detached run', async () => {
    const tool = createTool({
      name: 'needs-approval',
      description: 'needs approval',
      input: z.object({}),
      execute: async () => 'approved',
    });
    const toolbox = createToolbox([tool], {
      policy: {
        beforeExecute: () => ({ status: 'needs_approval' as const, reason: 'Approve this tool' }),
      },
    });
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({
            content: '',
            toolCalls: [{ id: 'approval-call', name: 'needs-approval', arguments: {} }],
          }),
          toolbox,
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
      storage: { type: 'memory' },
      durable: true,
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({ agentName: 'default', message: 'approve it' });
    await waitForReview(bureau, run.id);
    expect(bureau.reviews.list()[0]?.kind).toBe('tool-approval');

    const report = await bureau.shutdown({ policy: 'detach' });
    expect(report.detached).toBe(0);
  });
});
