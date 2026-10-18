import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction, ScheduleCompletedEvent, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { SESSION_OWNER_METADATA_KEY } from './session-authority';

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
  return createBureau({
    agents: {},
    generate,
    toolbox: createToolbox([], { context: {} }),
    storage: { type: 'memory' },
    durableExecution: true,
    stopWhen: stopWhen.noToolCalls(),
  });
}

describe('the owner of a schedule and of its fires (COR-718)', () => {
  it('reads a schedule created with a principal as owned by it, and one without as anonymous:local', async () => {
    const bureau = await openBureau();
    try {
      const owned = await bureau.createSchedule({
        agentName: 'researcher',
        input: 'owned',
        spec: '1h',
        principal: 'api-key:alice',
      });
      const unowned = await bureau.createSchedule({
        agentName: 'researcher',
        input: 'unowned',
        spec: '1h',
      });

      expect(await bureau.getOwner({ kind: 'schedule', id: owned!.id })).toBe('api-key:alice');
      expect(await bureau.getOwner({ kind: 'schedule', id: unowned!.id })).toBe('anonymous:local');
      expect(await bureau.getOwner({ kind: 'audit', runId: `schedule:${owned!.id}` })).toBe(
        'api-key:alice',
      );
      await bureau.cancelSchedule(owned!.id);
      await bureau.cancelSchedule(unowned!.id);
    } finally {
      await bureau.dispose();
    }
  });

  it("owns a fire's run and session by the schedule's owner, and audits the scheduler as the actor", async () => {
    const bureau = await openBureau();
    try {
      const completed: ScheduleCompletedEvent[] = [];
      bureau.addEventListener(ScheduleCompletedEvent.type, (event) => completed.push(event));
      const summary = await bureau.createSchedule({
        agentName: 'researcher',
        input: 'tick',
        spec: '1s',
        principal: 'api-key:alice',
      });

      expect(await waitForReal(() => completed.length >= 1)).toBe(true);
      await bureau.cancelSchedule(summary!.id);
      const fire = completed[0]!;

      expect(await bureau.getOwner({ kind: 'run', id: fire.runId })).toBe('api-key:alice');
      const sessionId = `sched-${summary!.id}-${fire.runId}`;
      expect(await bureau.getOwner({ kind: 'session', id: sessionId })).toBe('api-key:alice');
      const session = await bureau.getSession(sessionId);
      expect(session?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('api-key:alice');
      expect(session?.metadata['lastRunOwningPrincipals']).toEqual({
        [fire.runId]: 'api-key:alice',
      });

      const fired = await bureau.auditTrail?.query({ runId: fire.runId, type: 'schedule.fired' });
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
      const summary = await bureau.createSchedule({
        agentName: 'researcher',
        input: 'tick',
        spec: '1s',
      });

      expect(await waitForReal(() => completed.length >= 1)).toBe(true);
      await bureau.cancelSchedule(summary!.id);

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
      const run = await bureau.createRun({ message: 'mine', principal: 'api-key:bob' });
      await waitForReal(() => bureau.getRun(run.id)?.status !== 'running');
      const failed: string[] = [];
      bureau.addEventListener('schedule.failed', (event) => failed.push(event.runId));
      const summary = await bureau.createSchedule({
        agentName: 'researcher',
        input: 'tick',
        spec: '1s',
        sessionId: run.sessionId,
        principal: 'api-key:alice',
      });

      expect(await waitForReal(() => failed.length >= 1)).toBe(true);
      await bureau.cancelSchedule(summary!.id);
      const session = await bureau.getSession(run.sessionId);
      expect(session?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('api-key:bob');
      expect(JSON.stringify(session?.conversationHistory)).not.toContain('tick');
    } finally {
      await bureau.dispose();
    }
  });

  it('keeps the owner of a fire’s run and session across a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-fire-restart-'));
    const path = join(directory, 'bureau.sqlite');
    const open = () =>
      createBureau({
        id: 'owner-fire-restart',
        agents: {},
        generate,
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });
    const first = await open();
    let second: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const completed: ScheduleCompletedEvent[] = [];
      first.addEventListener(ScheduleCompletedEvent.type, (event) => completed.push(event));
      const summary = await first.createSchedule({
        agentName: 'researcher',
        input: 'tick',
        spec: '1s',
        principal: 'api-key:alice',
      });
      expect(await waitForReal(() => completed.length >= 1)).toBe(true);
      await first.cancelSchedule(summary!.id);
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
});
