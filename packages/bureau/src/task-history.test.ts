// COR-1481 — every task records its originating user message as its own history,
// apart from the session transcript, and its owner outlives the run store.

import { createDefaultRuntimeServices, createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createMockGenerate,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { encodeStorageKeyComponent, resolveStorage, type Storage } from '@lostgradient/weft';

import { createBureau } from './create-bureau';
import { createAskingAgent } from './test/task-record-crash-agent';
import { TASK_RECORD_KEY_PREFIX } from './task-registry';
import { waitForCondition } from './test';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { retireSettledTasks, SHORT_TASK_RETENTION } from './testing/run-retirement.test-support';
import type { AgentDefinitions } from './agent-catalog';

const finishes: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });
const toolbox = createToolbox([]) as unknown as Toolbox;

describe('a task’s own message history', () => {
  it('records the originating message of a session run, and of a catalog run', async () => {
    const worker = createAgent({ name: 'worker', generate: createMockGenerate([]) });
    const bureau = await createBureau<AgentDefinitions>({
      id: 'history-bureau',
      agents: {
        worker,
        default: createAgent({ generate: finishes, toolbox, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: { type: 'memory' },
      durable: true,
    });
    try {
      const session = await bureau.createRun({
        agentName: 'default',
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
      createBureau<AgentDefinitions>({
        id: 'history-restart',
        agents: {
          default: createAgent({ generate: finishes, toolbox, stopWhen: stopWhen.noToolCalls() }),
        },
        storage: fixture.configuration,
        durable: true,
      });
    try {
      const first = await open();
      const run = await first.createRun({
        agentName: 'default',
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
    const runtime = createManualRuntimeServices();
    const bureau = await createBureau<AgentDefinitions>({
      id: 'history-delete',
      agents: {
        default: createAgent({ generate: finishes, toolbox, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: { type: 'memory' },
      durable: true,
      runtime,
      ...SHORT_TASK_RETENTION,
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'short lived',
        principal: 'api-key:alice',
      });
      await waitForCondition(() => bureau.getRun(run.id)?.status === 'completed', 'finish');

      await retireSettledTasks(bureau, runtime);

      expect(await bureau.tasks.get(run.id)).toBeUndefined();
      expect(await bureau.tasks.history(run.id)).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });

  it('deletes a run whose task record cannot be read, and diagnoses it', async () => {
    const runtime = createManualRuntimeServices();
    const diagnostics: string[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      id: 'history-unreadable',
      agents: {
        default: createAgent({ generate: finishes, toolbox, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: { type: 'memory' },
      durable: true,
      runtime,
      ...SHORT_TASK_RETENTION,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'short lived',
        principal: 'api-key:alice',
      });
      await waitForCondition(() => bureau.getRun(run.id)?.status === 'completed', 'finish');
      await bureau.kv?.set(
        `${TASK_RECORD_KEY_PREFIX}${encodeStorageKeyComponent(run.id)}`,
        '{not json',
      );

      await retireSettledTasks(bureau, runtime);

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
      createBureau<AgentDefinitions>({
        id: 'shutdown-abort',
        agents: {
          default: createAgent({ generate: parks, toolbox, stopWhen: stopWhen.noToolCalls() }),
        },
        storage: fixture.configuration,
        durable: true,
      });
    try {
      const first = await open();
      const run = await first.createRun({
        agentName: 'default',
        message: 'hold',
        principal: 'api-key:alice',
      });
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

  it('writes a settlement still in flight before dispose closes the storage', async () => {
    const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
    const raw = await resolveStorage(fixture.configuration);
    const landed = { value: false };
    // Every write that records a settlement is slow, so it is still in flight when the run ends.
    const slowSettlements = new Proxy(raw, {
      get(target, property) {
        const member = Reflect.get(target, property, target) as unknown;
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => {
          const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
          const settlement = JSON.stringify(args, (_key, value: unknown) =>
            value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
          ).includes('\\"settled\\"');
          if (!settlement) return call();
          return new Promise((resolve) => setTimeout(resolve, 50)).then(() => {
            const landing = call();
            landed.value = true;
            return landing;
          });
        };
      },
    }) as Storage;
    const open = (storage: Storage | typeof fixture.configuration) =>
      createBureau<AgentDefinitions>({
        id: 'history-flush',
        agents: {
          default: createAgent({ generate: finishes, toolbox, stopWhen: stopWhen.noToolCalls() }),
        },
        storage,
        durable: true,
      });
    try {
      const first = await open(slowSettlements);
      const run = await first.createRun({
        agentName: 'default',
        message: 'finish at once',
        principal: 'api-key:alice',
      });
      await waitForCondition(() => first.getRun(run.id)?.status === 'completed', 'finish');
      await first.dispose();

      // A caller-supplied storage is not closed by dispose, so what shows the write was awaited
      // is that it had landed by the time dispose resolved.
      expect(landed.value).toBe(true);
      const second = await open(fixture.configuration);
      try {
        const task = await second.tasks.get(run.id);
        expect(task?.status).toBe('completed');
      } finally {
        await second.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('records the cleanup of a durable run that ends as the engine is disposed, before storage closes', async () => {
    const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
    const diagnostics: string[] = [];
    const open = (collect: boolean) =>
      createBureau<AgentDefinitions>({
        id: 'history-engine-dispose',
        agents: {
          asker: createAskingAgent(),
          default: createAgent({
            generate: finishes,
            toolbox,
            stopWhen: stopWhen.some(
              stopWhen.toolCalled('requestHumanInput'),
              stopWhen.noToolCalls(),
            ),
          }),
        },
        storage: fixture.configuration,
        durable: true,
        humanInput: true,
        durableOwnership: { ownership: 'none' },
        ...(collect
          ? { onDiagnostic: (diagnostic) => void diagnostics.push(diagnostic.message) }
          : {}),
      });
    try {
      const first = await open(true);
      const run = first.run('asker', 'which environment?', { principal: 'api-key:alice' });
      await waitForCondition(
        () => first.listPendingReviews().some((review) => review.runId === run.id),
        'the run never parked',
      );
      await first.dispose();

      const taskWriteFailures = diagnostics.filter((message) => message.includes('task'));
      expect(taskWriteFailures).toEqual([]);
      const second = await open(false);
      try {
        const record = await second.tasks.record(run.id);
        expect(record?.cleanup).toBeDefined();
      } finally {
        await second.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  });
});
