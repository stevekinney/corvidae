import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentSession,
  type GenerateFunction,
  ScheduleCompletedEvent,
  stopWhen,
  SESSION_OWNER_METADATA_KEY,
  createAgent,
} from '@lostgradient/operative';
import { createConversationHistory } from 'conversationalist';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { AgentDefinitions } from './agent-catalog';

// A schedule fire is driven by Weft's poller on real elapsed time, which is why
// this file is a slow lane: nothing here can run faster than the schedule's
// own one-second interval.

const generate: GenerateFunction = async () => ({ content: 'acknowledged', toolCalls: [] });

async function waitForReal(condition: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

async function openBureau() {
  return createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate,
        toolbox: createToolbox([], { context: {} }),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: { type: 'memory' },
    durable: true,
  });
}

describe('the owner of a schedule and of its fires (COR-718)', () => {
  it('reads a schedule created with a principal as owned by it, and one without as anonymous:local', async () => {
    const bureau = await openBureau();
    try {
      const owned = await bureau.schedules.create({
        agentName: 'default',
        input: 'owned',
        spec: '1h',
        principal: 'api-key:alice',
      });
      const unowned = await bureau.schedules.create({
        agentName: 'default',
        input: 'unowned',
        spec: '1h',
      });

      expect(await bureau.getOwner({ kind: 'schedule', id: owned!.id })).toBe('api-key:alice');
      expect(await bureau.getOwner({ kind: 'schedule', id: unowned!.id })).toBe('anonymous:local');
      expect(await bureau.getOwner({ kind: 'audit', runId: `schedule:${owned!.id}` })).toBe(
        'api-key:alice',
      );
      await bureau.schedules.cancel(owned!.id);
      await bureau.schedules.cancel(unowned!.id);
    } finally {
      await bureau.dispose();
    }
  });

  it("owns a fire's run and session by the schedule's owner, and audits the scheduler as the actor", async () => {
    const bureau = await openBureau();
    try {
      const completed: ScheduleCompletedEvent[] = [];
      bureau.addEventListener(ScheduleCompletedEvent.type, (event) => completed.push(event));
      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'tick',
        spec: '1s',
        principal: 'api-key:alice',
      });

      expect(await waitForReal(() => completed.length >= 1)).toBe(true);
      await bureau.schedules.cancel(summary!.id);
      const fire = completed[0]!;

      expect(await bureau.getOwner({ kind: 'run', id: fire.runId })).toBe('api-key:alice');
      const sessionId = `sched-${summary!.id}-${fire.runId}`;
      expect(await bureau.getOwner({ kind: 'session', id: sessionId })).toBe('api-key:alice');
      const session = await bureau.contexts.get(sessionId);
      expect(session?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('api-key:alice');
      expect(session?.metadata['lastRunOwningPrincipals']).toEqual({
        [fire.runId]: 'api-key:alice',
      });

      const fired = await bureau.internals.auditTrail?.query({
        runId: fire.runId,
        type: 'schedule.fired',
      });
      expect(fired).toHaveLength(1);
      expect(fired?.[0]?.principal).toBe('system:scheduler');
      expect(await bureau.getOwner({ kind: 'audit', runId: fire.runId })).toBe('api-key:alice');
    } finally {
      await bureau.dispose();
    }
  });

  it('owns the fire of a schedule with no principal as anonymous:local', async () => {
    const bureau = await openBureau();
    try {
      const completed: ScheduleCompletedEvent[] = [];
      bureau.addEventListener(ScheduleCompletedEvent.type, (event) => completed.push(event));
      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'tick',
        spec: '1s',
      });

      expect(await waitForReal(() => completed.length >= 1)).toBe(true);
      await bureau.schedules.cancel(summary!.id);

      expect(await bureau.getOwner({ kind: 'run', id: completed[0]!.runId })).toBe(
        'anonymous:local',
      );
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses a fire into a recurring session another principal owns', async () => {
    const bureau = await openBureau();
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'mine',
        principal: 'api-key:bob',
      });
      await waitForReal(() => bureau.tasks.detail(run.id)?.status !== 'running');
      const failed: string[] = [];
      bureau.addEventListener('schedule.failed', (event) => failed.push(event.runId));
      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'tick',
        spec: '1s',
        sessionId: run.sessionId,
        principal: 'api-key:alice',
      });

      expect(await waitForReal(() => failed.length >= 1)).toBe(true);
      await bureau.schedules.cancel(summary!.id);
      const session = await bureau.contexts.get(run.sessionId);
      expect(session?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('api-key:bob');
      expect(JSON.stringify(session?.conversationHistory)).not.toContain('tick');

      // The refused fire is still a fire: it is audited once, and its run is Alice's.
      const refusedRunId = failed[0]!;
      const fired = await bureau.internals.auditTrail?.query({
        runId: refusedRunId,
        type: 'schedule.fired',
      });
      expect(fired?.map((entry) => entry.principal)).toEqual(['system:scheduler']);
      expect(await bureau.getOwner({ kind: 'run', id: refusedRunId })).toBe('api-key:alice');
      expect(await bureau.getOwner({ kind: 'audit', runId: refusedRunId })).toBe('api-key:alice');
      // And it tells Alice only that the session was not found, never that Bob owns it.
      const refused = await bureau.tasks.workflow(refusedRunId);
      expect(refused?.error).toContain('was not found');
      expect(refused?.error).not.toMatch(/owner|another principal/i);
    } finally {
      await bureau.dispose();
    }
  });

  it('keeps the owner of a fire’s run and session across a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-fire-restart-'));
    const path = join(directory, 'bureau.sqlite');
    const open = () =>
      createBureau<AgentDefinitions>({
        id: 'owner-fire-restart',
        agents: {
          default: createAgent({
            generate,
            toolbox: createToolbox([], { context: {} }),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path },
        durable: true,
      });
    const first = await open();
    let second: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const completed: ScheduleCompletedEvent[] = [];
      first.addEventListener(ScheduleCompletedEvent.type, (event) => completed.push(event));
      const summary = await first.schedules.create({
        agentName: 'default',
        input: 'tick',
        spec: '1s',
        principal: 'api-key:alice',
      });
      expect(await waitForReal(() => completed.length >= 1)).toBe(true);
      await first.schedules.cancel(summary!.id);
      const fireRunId = completed[0]!.runId;
      await first.dispose();

      second = await open();
      expect(await second.getOwner({ kind: 'run', id: fireRunId })).toBe('api-key:alice');
      expect(await second.getOwner({ kind: 'schedule', id: summary!.id })).toBe('api-key:alice');
      expect(
        await second.getOwner({ kind: 'session', id: `sched-${summary!.id}-${fireRunId}` }),
      ).toBe('api-key:alice');
      expect(await second.getOwner({ kind: 'audit', runId: fireRunId })).toBe('api-key:alice');
    } finally {
      await second?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a fire that built its services before another owner created its recurring session', async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async ({ conversation }) => {
            if (JSON.stringify(conversation.getMessages()).includes('racing tick')) {
              entered.resolve();
              await release.promise;
            }
            return { content: 'acknowledged', toolCalls: [] };
          },
          toolbox: createToolbox([], { context: {} }),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'memory' },
      durable: true,
    });
    try {
      const failed: string[] = [];
      bureau.addEventListener('schedule.failed', (event) => failed.push(event.runId));
      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'racing tick',
        spec: '1s',
        sessionId: 'raced-recurring',
        principal: 'api-key:alice',
      });
      // The fire has built its services and is waiting in generate, and the session does not exist.
      await entered.promise;
      await bureau.schedules.cancel(summary!.id);
      const created = await bureau.createRun({
        agentName: 'default',
        message: 'bob got there first',
        sessionId: 'raced-recurring',
        principal: 'api-key:bob',
      });
      expect(created.sessionId).toBe('raced-recurring');
      release.resolve();

      expect(await waitForReal(() => failed.length >= 1)).toBe(true);
      const session = await bureau.contexts.get('raced-recurring');
      expect(session?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('api-key:bob');
      expect(JSON.stringify(session?.conversationHistory)).not.toContain('racing tick');
      // The failed run says only that the session was not found, never whose it is.
      const failedRun = await bureau.tasks.workflow(failed[0]!);
      const outcome = failedRun?.result as { errorMessage?: string } | undefined;
      expect(outcome?.errorMessage).toContain('not found');
      expect(outcome?.errorMessage).not.toMatch(/owner|another principal/i);
    } finally {
      release.resolve();
      await bureau.dispose();
    }
  });

  it('records a fire refused because its session belongs to a goal, with its owner and audit entry', async () => {
    const bureau = await openBureau();
    try {
      await bureau.internals.sessionStore?.save(
        createAgentSession({
          id: 'plain-session-with-goal',
          agentName: 'default',
          conversationHistory: createConversationHistory({ id: 'plain-session-with-goal' }),
          metadata: { goalRunId: 'some-goal' },
        }),
      );
      const failed: string[] = [];
      bureau.addEventListener('schedule.failed', (event) => failed.push(event.runId));
      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'tick',
        spec: '1s',
        sessionId: 'plain-session-with-goal',
        principal: 'api-key:alice',
      });

      expect(await waitForReal(() => failed.length >= 1)).toBe(true);
      await bureau.schedules.cancel(summary!.id);

      const refusedRunId = failed[0]!;
      const fired = await bureau.internals.auditTrail?.query({
        runId: refusedRunId,
        type: 'schedule.fired',
      });
      expect(fired?.map((entry) => entry.principal)).toEqual(['system:scheduler']);
      expect(await bureau.getOwner({ kind: 'run', id: refusedRunId })).toBe('api-key:alice');
    } finally {
      await bureau.dispose();
    }
  });
});
