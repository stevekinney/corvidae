/**
 * COR-323 — a schedule's fire runs as a named catalog agent, resolved through
 * the catalog, with that agent's own `generate`. No Bureau-wide `generate` exists to run them on,
 * and the implicit `bureau` agent that used to stand for it is refused rather than run. COR-1667: creating a schedule under a name the catalog lacks is refused too, so a fire only meets a missing agent after the catalog loses one.
 */
import { createAgent, createAgentSession, type GenerateFunction } from '@lostgradient/operative';
import { decode, encode } from '@lostgradient/weft';
import { encodeStorageKeyComponent, MemoryStorage } from '@lostgradient/storage';
import { Database } from 'bun:sqlite';
import { createConversationHistory } from 'conversationalist';
import { afterEach, describe, expect, it } from 'bun:test';
import type { AgentDefinitions } from './agent-catalog';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import { BureauError, createBureau } from './create-bureau';
import { createRuntimeComposition } from './runtime-composition';
import {
  createScheduleFireHarness,
  fireOnce,
  pollUntil,
} from './schedule-fire-fixtures.test-support';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { Bureau, BureauOptions } from './types';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const harness = createScheduleFireHarness();
const bureaus: Bureau[] = [];

afterEach(async () => {
  await harness.dispose();
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

/** A model that answers `reply` and counts its calls. */
function answering(reply: string): { generate: GenerateFunction; calls: () => number } {
  let calls = 0;
  return {
    generate: async () => {
      calls += 1;
      return { content: reply, toolCalls: [] };
    },
    calls: () => calls,
  };
}

describe('a schedule’s fire', () => {
  it('runs the named agent’s own generate on a Bureau with only catalog agents', async () => {
    const worker = answering('fired');
    const other = answering('not me');
    const bureau = await harness.open({
      agents: {
        worker: createAgent({ generate: worker.generate }),
        other: createAgent({ generate: other.generate }),
      },
    });

    await fireOnce(bureau, undefined, undefined, 'worker');
    await pollUntil(() => (worker.calls() > 0 ? true : undefined), 'the fire to call its agent');

    expect(worker.calls()).toBeGreaterThan(0);
    expect(other.calls()).toBe(0);
  });

  it('stored under an agent the catalog later lost fails with a diagnostic and runs nothing (COR-1667)', async () => {
    // Creation refuses a name the catalog lacks, so the schedule is made under a catalog agent and
    // the agent leaves the catalog between restarts: the fire still fails, exactly as before.
    const database = createSqliteStorageFixture();
    const worker = answering('never');
    try {
      const first = await createBureau<AgentDefinitions>({
        agents: { worker: createAgent({ generate: worker.generate }) },
        storage: database.storage,
        durable: true,
        durableOwnership: { ownership: 'none' },
      });
      const created = await first.schedules.create({
        agentName: 'worker',
        input: 'check in',
        spec: '1m',
        principal: OWNER.alice,
      });
      await first.dispose();

      const second = await createBureau<AgentDefinitions>({
        agents: {},
        storage: database.open(),
        durable: true,
        durableOwnership: { ownership: 'none' },
      });
      bureaus.push(second);
      await second.maintain(created!.nextFireAt!);
      const status = await pollUntil(async () => {
        const page = await second.tasks.workflows();
        const fire = page?.items[0];
        return fire?.status === 'failed' || fire?.status === 'completed' ? fire.status : undefined;
      }, 'the fire to settle');

      expect(status).toBe('failed');
      expect(worker.calls()).toBe(0);
    } finally {
      await database.dispose();
    }
  });

  it('stored under the legacy "bureau" agent name fails its fire and runs nothing', async () => {
    // Persisted before creation refused unknown names, and a catalog cannot hold the reserved
    // name, so the stored schedule is rewritten in place. The fire-time check still refuses it.
    const databaseFixture = createSqliteStorageFixture();
    const databasePath = databaseFixture.path;
    const worker = answering('never');
    const options = {
      agents: { worker: createAgent({ generate: worker.generate }) },
      storage: databaseFixture.storage,
      durable: true,
      durableOwnership: { ownership: 'none' },
    } satisfies BureauOptions<AgentDefinitions>;
    try {
      const first = await createBureau<AgentDefinitions>(options);
      const created = await first.schedules.create({
        agentName: 'worker',
        input: 'check in',
        spec: '1m',
        principal: OWNER.alice,
      });
      await first.dispose();

      const database = new Database(databasePath);
      const key = `schedule:${encodeStorageKeyComponent(created!.id)}`;
      const row = database.query('select value from kv where key = ?').get(key) as {
        value: Uint8Array;
      };
      const stored = decode(row.value) as { input: { agentName: string } };
      expect(stored.input.agentName).toBe('worker');
      stored.input.agentName = 'bureau';
      database.query('update kv set value = ? where key = ?').run(encode(stored), key);
      database.close();

      const second = await createBureau<AgentDefinitions>(options);
      bureaus.push(second);
      await second.maintain(created!.nextFireAt!);
      const status = await pollUntil(async () => {
        const page = await second.tasks.workflows();
        const fire = page?.items[0];
        return fire?.status === 'failed' || fire?.status === 'completed' ? fire.status : undefined;
      }, 'the fire to settle');

      expect(status).toBe('failed');
      expect(worker.calls()).toBe(0);
    } finally {
      await databaseFixture.dispose();
    }
  });
});

describe('a fire into a session another agent began', () => {
  it('fails with a diagnostic rather than running under the other agent’s instructions', async () => {
    const worker = answering('never');
    const other = answering('other answer');
    const bureau = await harness.open({
      agents: {
        worker: createAgent({ generate: worker.generate }),
        other: createAgent({ generate: other.generate }),
      },
    });
    const begun = await bureau.tasks.start('other', 'hello', {
      contextId: 'shared',
      principal: OWNER.alice,
    });
    await pollUntil(async () => {
      const run = await bureau.tasks.detail(begun.id);
      return run?.status === 'completed' ? true : undefined;
    }, 'the first run to finish');

    const created = await bureau.schedules.create({
      agentName: 'worker',
      input: 'check in',
      spec: '1m',
      principal: OWNER.alice,
      sessionId: 'shared',
    });
    await bureau.maintain(created!.nextFireAt!);
    await pollUntil(async () => {
      const page = await bureau.tasks.workflows();
      return page?.items.some((run) => run.status === 'failed') ? true : undefined;
    }, 'the fire to fail');

    expect(worker.calls()).toBe(0);
  });
});

describe('the origin of a session a fire creates (COR-1645)', () => {
  async function settledFire(bureau: Awaited<ReturnType<typeof harness.open>>, scheduleId: string) {
    const schedule = await bureau.schedules.get(scheduleId);
    await bureau.maintain(schedule!.nextFireAt!);
    await pollUntil(async () => {
      const page = await bureau.tasks.workflows();
      return page?.items.some((run) => run.status === 'completed') ? true : undefined;
    }, 'the fire to complete');
  }

  it('records `schedule` on the session a fire starts, so a chat list leaves it out', async () => {
    const worker = answering('fired');
    const bureau = await harness.open({
      agents: { worker: createAgent({ generate: worker.generate }) },
    });
    const created = await bureau.schedules.create({
      agentName: 'worker',
      input: 'check in',
      spec: '1m',
      principal: OWNER.alice,
    });

    await settledFire(bureau, created!.id);

    const fires = await bureau.contexts.list({ origin: 'schedule' });
    expect(fires).toHaveLength(1);
    expect(fires[0]?.metadata['sessionOrigin']).toBe('schedule');
    expect(await bureau.contexts.list({ origin: 'chat' })).toEqual([]);
  });

  it('leaves a chat’s origin alone when a fire continues it', async () => {
    const worker = answering('fired');
    const bureau = await harness.open({
      agents: { worker: createAgent({ generate: worker.generate }) },
    });
    const begun = await bureau.tasks.start('worker', 'hello', {
      contextId: 'shared-chat',
      principal: OWNER.alice,
    });
    await pollUntil(async () => {
      const run = await bureau.tasks.detail(begun.id);
      return run?.status === 'completed' ? true : undefined;
    }, 'the first run to finish');
    const created = await bureau.schedules.create({
      agentName: 'worker',
      input: 'check in',
      spec: '1m',
      principal: OWNER.alice,
      sessionId: 'shared-chat',
    });

    const schedule = await bureau.schedules.get(created!.id);
    await bureau.maintain(schedule!.nextFireAt!);
    // The fire did run in the chat, and the chat is still a chat.
    await pollUntil(async () => {
      const chat = await bureau.internals.sessionStore!.load('shared-chat');
      return chat?.metadata['lastScheduledFireRunId'] === undefined ? undefined : true;
    }, 'the fire to run in the chat');

    const chats = await bureau.contexts.list({ origin: 'chat' });
    expect(chats.map((session) => session.id)).toEqual(['shared-chat']);
    expect(await bureau.contexts.list({ origin: 'schedule' })).toEqual([]);
  });
});

describe('a session or recovered run stored under the implicit "bureau" agent', () => {
  it('is refused when a new run continues the session', async () => {
    const worker = answering('never');
    const bureau = await createBureau<AgentDefinitions>({
      agents: { worker: createAgent({ generate: worker.generate }) },
      storage: new MemoryStorage(),
    });
    bureaus.push(bureau);
    await bureau.internals.sessionStore!.save(
      createAgentSession({
        id: 'legacy-session',
        agentName: 'bureau',
        conversationHistory: createConversationHistory({ id: 'legacy-session' }),
        metadata: {},
      }),
    );

    const refusal = await rejectionOf(
      bureau.tasks.start('bureau', 'hello', { contextId: 'legacy-session' }),
    );

    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    expect(worker.calls()).toBe(0);
  });

  it('fails cleanly on recovery: the run is unavailable and its session is reconciled to error', async () => {
    const diagnostics: string[] = [];
    const runtime = await createRuntimeComposition({
      storage: new MemoryStorage(),
      durable: true,
      onDiagnostic: (event) => diagnostics.push(event.message),
    });
    try {
      // A Bureau always wires its catalog; this one holds no agent called "bureau".
      runtime.setCatalogAgentRunOptionsResolver(async () => ({ status: 'missing-agent' }));
      await runtime.sessionStore!.save(
        createAgentSession({
          id: 'legacy-session',
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: 'legacy-session' }),
          metadata: {
            lastRunId: 'legacy-run',
            lastRunStatus: 'running',
            lastUserMessage: 'resume',
            lastRequestAuthority: {
              principalId: 'run:legacy-run',
              tenantId: 'bureau',
              ownerId: 'bureau',
              capabilities: ['tools:execute'],
              authorizationRevision: 'bureau:1',
              audience: 'operator',
            },
          },
        }),
      );

      const resolution = await runtime.resolveRunServices({
        workflowId: 'legacy-run',
        workflowType: 'agentRun',
        input: { runId: 'legacy-run', sessionId: 'legacy-session', agentName: 'bureau' },
      });

      expect(resolution).toMatchObject({ status: 'unavailable' });
      const session = await runtime.sessionStore!.load('legacy-session');
      expect(session?.metadata['lastRunStatus']).toBe('error');
    } finally {
      runtime.durable?.engine[Symbol.dispose]?.();
    }
  });
});
