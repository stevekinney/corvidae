import { stopWhen, waitForCondition } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import type { Bureau, BureauOptions } from './types';

/**
 * COR-1627: a run that stops at its step limit is a failure on every Bureau surface. Its run
 * record, its session, its task, its audit trail, and its report all read the failure, and the
 * `run.error` it now fires is counted once by each of them.
 */

const bureaus: Bureau[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const nextTool = createTool({
  name: 'next',
  description: 'Asks for one more step',
  input: z.object({}),
  execute: async () => 'ok',
});

/** A Bureau whose model never stops, so every run ends at its second step. */
async function openStepLimitBureau(options: Partial<BureauOptions>): Promise<Bureau> {
  const bureau = await createBureau({
    agents: {},
    generate: async () => ({
      content: 'still going',
      toolCalls: [{ name: 'next', arguments: {} }],
    }),
    toolbox: createToolbox([nextTool]),
    maximumSteps: 2,
    stopWhen: stopWhen.noToolCalls(),
    ...options,
  });
  bureaus.push(bureau);
  return bureau;
}

/** Starts a run and waits for the session to record how it ended. */
async function runToLimit(bureau: Bureau) {
  const run = await bureau.createRun({ message: 'Never settles', principal: 'alice' });
  await waitForCondition(async () => {
    const session = await bureau.getSession(run.sessionId);
    return session?.metadata['lastRunStatus'] === 'error';
  }, 'the session never recorded how the run ended');
  return run;
}

/** The in-process loop and the durable workflow both end a run at its step limit. */
const EXECUTIONS: readonly (readonly [string, Partial<BureauOptions>])[] = [
  ['in process', { persistence: textValueStore(new MemoryStorage()) }],
  ['durably', { storage: { type: 'memory' }, durableExecution: true }],
];

describe.each(EXECUTIONS)('a run that stops at its step limit, %s (COR-1627)', (_name, options) => {
  it('reads error in the run record, listRuns, and getRun', async () => {
    const bureau = await openStepLimitBureau(options);

    const run = await runToLimit(bureau);

    const detail = bureau.getRun(run.id);
    expect(detail?.status).toBe('error');
    expect(detail?.finishReason).toBe('maximum-steps');
    expect(bureau.listRuns()[0]?.status).toBe('error');
    expect(bureau.listRuns()[0]?.id).toBe(run.id);
  });

  it('reads error in the session’s last run, with the step-limit error', async () => {
    const bureau = await openStepLimitBureau(options);

    const run = await runToLimit(bureau);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastRunStatus']).toBe('error');
    expect(session?.metadata['lastFinishReason']).toBe('maximum-steps');
    expect(session?.metadata['lastError']).toContain('Agent run exceeded maximumSteps (2).');
  });

  it('settles its task as failed with the step-limit error, and records one run.error in the audit trail', async () => {
    const bureau = await openStepLimitBureau(options);
    const run = await bureau.createRun({ message: 'Never settles', principal: 'alice' });
    await waitForCondition(async () => {
      const task = await bureau.tasks.get(run.id);
      return task?.status === 'failed';
    }, 'the task never settled as failed');
    await waitForCondition(async () => {
      const records = (await bureau.auditTrail?.query({ runId: run.id })) ?? [];
      return records.some((record) => record.type === 'run.completed');
    }, 'the audit trail never recorded the run’s completion');

    const records = (await bureau.auditTrail?.query({ runId: run.id })) ?? [];
    expect(records.filter((record) => record.type === 'run.error')).toHaveLength(1);
    expect(records.filter((record) => record.type === 'run.completed')).toHaveLength(1);
    // The task has one settlement: the `run.error` and the `run.completed` that follows it write
    // the same record, which reads the step-limit error.
    const task = await bureau.tasks.get(run.id);
    expect(task?.status).toBe('failed');
    expect(task?.statusMessage).toContain('Agent run exceeded maximumSteps (2).');
    const listed = await bureau.tasks.list({
      principal: 'alice',
      contextId: run.sessionId,
      limit: 10,
    });
    expect(listed.tasks.map((entry) => [entry.id, entry.status])).toEqual([[run.id, 'failed']]);
  });

  it('reports the run as failed in its run report', async () => {
    const bureau = await openStepLimitBureau(options);

    const run = await runToLimit(bureau);

    expect(bureau.getRunReport(run.id)?.status).toBe('failed');
  });
});

describe('a durable run that crashes before its step limit and is recovered (COR-1627)', () => {
  it('announces the step-limit failure once, from the process that recovers it', async () => {
    const databasePath = createTemporaryPath('bureau-step-limit-recovery', '.sqlite');
    try {
      // Bureau A commits step 0, then its second generate hangs: the process "dies" there, before
      // the run ever reaches its step-limit exit, so it never announces anything.
      let reachedSecondStep = false;
      const crashed = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 0)
            return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          reachedSecondStep = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([nextTool]),
        maximumSteps: 2,
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        stopWhen: stopWhen.noToolCalls(),
      });
      bureaus.push(crashed);
      const run = await crashed.createRun({ message: 'Never settles', principal: 'alice' });
      await waitForCondition(() => reachedSecondStep, 'the first process never reached step 1');

      // Bureau B recovers the workflow, which replays step 0 and runs step 1 to the limit.
      const recovering = await createBureau({
        agents: {},
        generate: async () => ({ content: 'again', toolCalls: [{ name: 'next', arguments: {} }] }),
        toolbox: createToolbox([nextTool]),
        maximumSteps: 2,
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        stopWhen: stopWhen.noToolCalls(),
      });
      bureaus.push(recovering);

      await waitForCondition(async () => {
        const session = await recovering.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'error';
      }, 'the recovered run never settled as an error');
      await waitForCondition(async () => {
        const records = (await recovering.auditTrail?.query({ runId: run.id })) ?? [];
        return records.some((record) => record.type === 'run.completed');
      }, 'the audit trail never recorded the recovered run’s completion');

      const records = (await recovering.auditTrail?.query({ runId: run.id })) ?? [];
      expect(records.filter((record) => record.type === 'run.error')).toHaveLength(1);
      expect(records.filter((record) => record.type === 'run.completed')).toHaveLength(1);
      const settled = await recovering.getSession(run.sessionId);
      expect(settled?.metadata['lastFinishReason']).toBe('maximum-steps');
    } finally {
      // The crashed Bureau stays open until the recovering one is done with the file.
      for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
      removeTemporaryPath(databasePath);
    }
  });
});
