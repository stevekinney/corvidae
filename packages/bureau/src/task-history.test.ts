// COR-1481 — every task records its originating user message as its own history,
// apart from the session transcript, and its owner outlives the run store.

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createMockGenerate,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { encodeStorageKeyComponent } from '@lostgradient/weft';

import { createBureau } from './create-bureau';
import { TASK_RECORD_KEY_PREFIX } from './task-registry';
import { waitForCondition } from './test';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const finishes: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });
const toolbox = createToolbox([]) as unknown as Toolbox;

describe('a task’s own message history', () => {
  it('records the originating message of a session run, and of a catalog run', async () => {
    const worker = createAgent({ name: 'worker', generate: createMockGenerate([]) });
    const bureau = await createBureau({
      id: 'history-bureau',
      agents: { worker },
      generate: finishes,
      toolbox,
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const session = await bureau.createRun({
        message: 'plan my trip',
        principal: 'api-key:alice',
      });
      const catalog = bureau.run('worker', 'summarize this', { principal: 'api-key:alice' });
      await waitForCondition(async () => {
        return (await bureau.tasks.history(catalog.id)) !== undefined;
      }, 'the catalog run was never recorded as a task');

      const sessionHistory = await bureau.tasks.history(session.id);
      const catalogHistory = await bureau.tasks.history(catalog.id);
      expect(sessionHistory?.map((message) => message.text)).toEqual(['plan my trip']);
      expect(catalogHistory?.map((message) => message.text)).toEqual(['summarize this']);
      const [entry] = sessionHistory ?? [];
      expect(entry).toMatchObject({
        role: 'user',
        messageId: expect.stringContaining('task-message'),
      });
      // A task has no transcript here: the session body is where that lives.
      expect(JSON.stringify(await bureau.tasks.get(session.id))).not.toContain('plan my trip');
    } finally {
      await bureau.dispose();
    }
  });

  it('keeps the history, and the owner of a settled run, across a restart over the same storage', async () => {
    const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
    const open = () =>
      createBureau({
        id: 'history-restart',
        agents: {},
        generate: finishes,
        toolbox,
        storage: fixture.configuration,
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });
    try {
      const first = await open();
      const run = await first.createRun({
        message: 'before the restart',
        principal: 'api-key:alice',
      });
      await waitForCondition(() => first.getRun(run.id)?.status === 'completed', 'finish');
      await waitForCondition(async () => {
        const task = await first.tasks.get(run.id);
        return task?.status === 'completed';
      }, 'settled');
      await first.dispose();

      const second = await open();
      try {
        const restored = await second.tasks.history(run.id);
        expect(restored?.map((message) => message.text)).toEqual(['before the restart']);
        expect(await second.tasks.get(run.id)).toMatchObject({
          id: run.id,
          owner: 'api-key:alice',
          status: 'completed',
        });
      } finally {
        await second.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('forgets a task whose run is deleted', async () => {
    const bureau = await createBureau({
      id: 'history-delete',
      agents: {},
      generate: finishes,
      toolbox,
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'short lived', principal: 'api-key:alice' });
      await waitForCondition(() => bureau.getRun(run.id)?.status === 'completed', 'finish');

      await bureau.deleteRun(run.id);

      expect(await bureau.tasks.get(run.id)).toBeUndefined();
      expect(await bureau.tasks.history(run.id)).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });

  it('deletes a run whose task record cannot be read, and diagnoses it', async () => {
    const diagnostics: string[] = [];
    const bureau = await createBureau({
      id: 'history-unreadable',
      agents: {},
      generate: finishes,
      toolbox,
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    try {
      const run = await bureau.createRun({ message: 'short lived', principal: 'api-key:alice' });
      await waitForCondition(() => bureau.getRun(run.id)?.status === 'completed', 'finish');
      await bureau.kv?.set(
        `${TASK_RECORD_KEY_PREFIX}${encodeStorageKeyComponent(run.id)}`,
        '{not json',
      );

      await bureau.deleteRun(run.id);

      expect(bureau.getRun(run.id)).toBeUndefined();
      expect(diagnostics.some((message) => message.includes('unreadable task record'))).toBe(true);
    } finally {
      await bureau.dispose();
    }
  });

  it('reports the cleanup of a run a shutdown aborted, after a restart', async () => {
    const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
    const parks: GenerateFunction = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const open = () =>
      createBureau({
        id: 'shutdown-abort',
        agents: {},
        generate: parks,
        toolbox,
        storage: fixture.configuration,
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });
    try {
      const first = await open();
      const run = await first.createRun({ message: 'hold', principal: 'api-key:alice' });
      await waitForCondition(() => first.getRun(run.id)?.status === 'running', 'running');
      await first.shutdown({ policy: 'abort' });

      const second = await open();
      try {
        const task = await second.tasks.get(run.id);
        const repeated = await second.tasks.cancel(run.id, 0);

        expect(task).toMatchObject({ status: 'canceled', cleanup: 'cleaned-up' });
        expect(repeated).toEqual({ receipt: 'cleaned-up' });
      } finally {
        await second.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  });
});
