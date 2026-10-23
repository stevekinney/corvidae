/**
 * COR-323 — a scheduler task and a schedule's fire run as a named catalog agent, resolved through
 * the catalog, with that agent's own `generate`. No Bureau-wide `generate` exists to run them on,
 * and the implicit `bureau` agent that used to stand for it is refused rather than run. COR-1667: creating a schedule under a name the catalog lacks is refused too, so a fire only meets a missing agent after the catalog loses one.
 */
import {
  createAgent,
  createAgentSession,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type GenerateFunction,
} from '@lostgradient/operative';
import { createConversationHistory } from 'conversationalist';
import { afterEach, describe, expect, it } from 'bun:test';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';

import type { AgentDefinitions } from './agent-catalog';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import { BureauError, createBureau } from './create-bureau';
import { createRuntimeComposition } from './runtime-composition';
import {
  createScheduleFireHarness,
  fireOnce,
  pollUntil,
} from './schedule-fire-fixtures.test-support';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau } from './types';

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

/** `agent`, resolving the token cap a `createAgent` agent has no option for. */
function withMaximumTokens<TAgent extends AgentDefinitions[string]>(
  agent: TAgent,
  maximumTokens: number,
): TAgent {
  const resolve = Reflect.get(agent, OPERATIVE_RESOLVE_RUN_OPTIONS) as (
    ...args: unknown[]
  ) => Promise<Record<string, unknown>>;
  return {
    ...agent,
    [OPERATIVE_RESOLVE_RUN_OPTIONS]: async (...args: unknown[]) => ({
      ...(await resolve.apply(agent, args)),
      maximumTokens,
    }),
  };
}

describe('submitSchedulerTask', () => {
  async function openWithTwoAgents() {
    const worker = answering('worker answer');
    const other = answering('other answer');
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        worker: createAgent({ generate: worker.generate }),
        other: createAgent({ generate: other.generate }),
      },
      scheduler: { enabled: true, idleDelay: 1 },
    });
    bureaus.push(bureau);
    return { bureau, worker, other };
  }

  it('runs the named agent’s own generate, and no other agent’s', async () => {
    const { bureau, worker, other } = await openWithTwoAgents();

    const { taskId } = await bureau.submitSchedulerTask({
      agentName: 'worker',
      message: 'do the work',
      priority: 'background',
    });
    const result = await bureau.awaitSchedulerTask(taskId);

    expect(result?.content).toBe('worker answer');
    expect(worker.calls()).toBe(1);
    expect(other.calls()).toBe(0);
  });

  it('refuses an agent the catalog does not hold with NOT_FOUND', async () => {
    const { bureau, worker } = await openWithTwoAgents();

    const refusal = await rejectionOf(
      bureau.submitSchedulerTask({ agentName: 'ghost', message: 'hello' }),
    );

    expect(refusal).toBeInstanceOf(BureauError);
    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    expect(worker.calls()).toBe(0);
  });

  it('refuses the implicit "bureau" agent with NOT_FOUND, never running it', async () => {
    const { bureau } = await openWithTwoAgents();

    const refusal = await rejectionOf(
      bureau.submitSchedulerTask({ agentName: 'bureau', message: 'hello' }),
    );

    expect((refusal as BureauError).code).toBe('NOT_FOUND');
  });

  it('carries the agent’s token cap into the task run', async () => {
    let seen: number | undefined;
    const base = createAgent({
      generate: async ({ maximumTokens }) => {
        seen = maximumTokens;
        return { content: 'ok', toolCalls: [] };
      },
    });
    const bureau = await createBureau<AgentDefinitions>({
      agents: { capped: withMaximumTokens(base, 77) },
      scheduler: { enabled: true, idleDelay: 1 },
    });
    bureaus.push(bureau);

    const { taskId } = await bureau.submitSchedulerTask({ agentName: 'capped', message: 'go' });
    await bureau.awaitSchedulerTask(taskId);

    expect(seen).toBe(77);
  });

  it('requires an agent name', async () => {
    const { bureau } = await openWithTwoAgents();

    const refusal = await rejectionOf(
      bureau.submitSchedulerTask({ message: 'hello' } as Parameters<
        typeof bureau.submitSchedulerTask
      >[0]),
    );

    expect((refusal as BureauError).code).toBe('BAD_REQUEST');
  });
});

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
    const databasePath = createTemporaryPath('bureau-schedule-agent-removed', '.sqlite');
    const worker = answering('never');
    try {
      const first = await createBureau<AgentDefinitions>({
        agents: { worker: createAgent({ generate: worker.generate }) },
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
      });
      const created = await first.createSchedule({
        agentName: 'worker',
        input: 'check in',
        spec: '1m',
        principal: OWNER.alice,
      });
      await first.dispose();

      const second = await createBureau<AgentDefinitions>({
        agents: {},
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
      });
      bureaus.push(second);
      await second.runDurableMaintenance(created!.nextFireAt!);
      const status = await pollUntil(async () => {
        const page = await second.listDurableRuns();
        const fire = page?.items[0];
        return fire?.status === 'failed' || fire?.status === 'completed' ? fire.status : undefined;
      }, 'the fire to settle');

      expect(status).toBe('failed');
      expect(worker.calls()).toBe(0);
    } finally {
      removeTemporaryPath(databasePath);
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
    const begun = await bureau.createRun({
      message: 'hello',
      agentName: 'other',
      sessionId: 'shared',
      principal: OWNER.alice,
    });
    await pollUntil(async () => {
      const run = await bureau.getRun(begun.id);
      return run?.status === 'completed' ? true : undefined;
    }, 'the first run to finish');

    const created = await bureau.createSchedule({
      agentName: 'worker',
      input: 'check in',
      spec: '1m',
      principal: OWNER.alice,
      sessionId: 'shared',
    });
    await bureau.runDurableMaintenance(created!.nextFireAt!);
    await pollUntil(async () => {
      const page = await bureau.listDurableRuns();
      return page?.items.some((run) => run.status === 'failed') ? true : undefined;
    }, 'the fire to fail');

    expect(worker.calls()).toBe(0);
  });
});

describe('a session or recovered run stored under the implicit "bureau" agent', () => {
  it('is refused when a new run continues the session', async () => {
    const worker = answering('never');
    const bureau = await createBureau<AgentDefinitions>({
      agents: { worker: createAgent({ generate: worker.generate }) },
      storage: { type: 'memory' },
    });
    bureaus.push(bureau);
    await bureau.sessionStore!.save(
      createAgentSession({
        id: 'legacy-session',
        agentName: 'bureau',
        conversationHistory: createConversationHistory({ id: 'legacy-session' }),
        metadata: {},
      }),
    );

    const refusal = await rejectionOf(
      bureau.createRun({ agentName: 'bureau', message: 'hello', sessionId: 'legacy-session' }),
    );

    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    expect(worker.calls()).toBe(0);
  });

  it('fails cleanly on recovery: the run is unavailable and its session is reconciled to error', async () => {
    const diagnostics: string[] = [];
    const runtime = await createRuntimeComposition({
      storage: { type: 'memory' },
      durableExecution: true,
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
