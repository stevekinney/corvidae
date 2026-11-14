/**
 * COR-2285 — a schedule whose fires continue one context starts no fire in it while it is archived:
 * the fire is refused before it writes anything, naming `context-archived`, and the next fire after
 * an unarchive continues the context as before.
 */
import { createAgent, type Toolbox } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { createStorageInterleaver } from './http/management/management-fixtures.test-support';
import { createMemoryStorageFixture } from './test/storage-fixtures';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { ContextBusyError } from './bureau-errors';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';

const SESSION = 'archived-schedule-session';

/** The storage key of the session's body: Operative's prefix, then each character in hex. */
const SESSION_BODY_KEY = `agent-session-v2:body:${Array.from(
  { length: SESSION.length },
  (_, index) => SESSION.charCodeAt(index).toString(16).padStart(4, '0'),
).join('')}`;

/** Fires the schedule now, and resolves the fire's workflow id. */
async function startFire(bureau: Bureau, scheduleId: string): Promise<string> {
  const fired = await bureau.schedules.runNow(scheduleId);
  const workflowId = fired !== undefined && 'workflowId' in fired ? fired.workflowId : '';
  expect(workflowId).not.toBe('');
  return workflowId;
}

/** Fires the schedule now and resolves the fire's workflow once it is terminal. */
async function fireNow(bureau: Bureau, scheduleId: string) {
  return terminalOf(bureau, await startFire(bureau, scheduleId));
}

/** The fire's workflow once it is terminal. */
async function terminalOf(bureau: Bureau, workflowId: string) {
  let terminal: { status: string; error?: string | undefined } | null | undefined;
  await waitUntil(async () => {
    const state = await bureau.durableEngine()!.get(workflowId);
    if (state === null || state === undefined) return false;
    if (state.status === 'pending' || state.status === 'running') return false;
    terminal = state;
    return true;
  });
  return terminal!;
}

describe('a schedule’s fire into an archived context', () => {
  it('is refused and writes nothing, and the next fire after an unarchive continues the context', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'acknowledged', toolCalls: [] }),
          toolbox: createToolbox([]) as unknown as Toolbox,
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
      maintenance: 'manual',
    });
    try {
      const schedule = await bureau.schedules.create({
        agentName: 'default',
        input: 'check in',
        spec: '1h',
        sessionId: SESSION,
      });
      const first = await fireNow(bureau, schedule!.id);
      expect(first.status).toBe('completed');
      // The fire's task settles a little after its workflow does; until then it is a live task.
      await waitUntil(async () => {
        try {
          return (await bureau.contexts.archive(SESSION)) !== undefined;
        } catch (error) {
          if (error instanceof ContextBusyError) return false;
          throw error;
        }
      });
      const before = await bureau.contexts.get(SESSION);

      const refused = await fireNow(bureau, schedule!.id);

      expect(refused.status).not.toBe('completed');
      expect(JSON.stringify(refused)).toContain('context-archived');
      const after = await bureau.contexts.get(SESSION);
      expect(after?.conversationHistory.ids).toEqual(before?.conversationHistory.ids);

      await bureau.contexts.unarchive(SESSION);
      const resumed = await fireNow(bureau, schedule!.id);
      expect(resumed.status).toBe('completed');
      const continued = await bureau.contexts.get(SESSION);
      expect(continued!.conversationHistory.ids.length).toBeGreaterThan(
        before!.conversationHistory.ids.length,
      );
    } finally {
      await bureau.dispose();
    }
  });

  it('is refused inside the fire’s own save when the context was archived after the fire checked it', async () => {
    let bureau: Bureau | undefined;
    let scheduleId = '';
    let racingFire: Promise<string> | undefined;
    let bodyReads = 0;
    let generations = 0;
    // The second fire's step waits here, after the fire checked the session and before it saves.
    const stepEntered = Promise.withResolvers<void>();
    const stepReleased = Promise.withResolvers<void>();
    // The archive reads the session once to decide it is idle, then again inside its update. The
    // fire starts between the two and passes its own check of the session, and the archive then
    // commits on a revision the fire has not moved: only the fire's save, which writes the
    // transcript, can still refuse it.
    const interleaver = createStorageInterleaver(
      (verb, args) => verb === 'get' && args[0] === SESSION_BODY_KEY && (bodyReads += 1) === 2,
      async () => {
        racingFire = startFire(bureau!, scheduleId);
        await stepEntered.promise;
      },
    );
    const fixture = createMemoryStorageFixture({ wrapStorage: (raw) => interleaver.wrap(raw) });
    try {
      bureau = await createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({
            generate: async () => {
              generations += 1;
              if (generations === 2) {
                stepEntered.resolve();
                await stepReleased.promise;
              }
              return { content: 'acknowledged', toolCalls: [] };
            },
            toolbox: createToolbox([]) as unknown as Toolbox,
          }),
        },
        storage: fixture.storage,
        durable: true,
        maintenance: 'manual',
      });
      const schedule = await bureau.schedules.create({
        agentName: 'default',
        input: 'check in',
        spec: '1h',
        sessionId: SESSION,
      });
      scheduleId = schedule!.id;
      const first = await fireNow(bureau, scheduleId);
      expect(first.status).toBe('completed');
      await waitUntil(async () => {
        const activity = await bureau!.internals.taskRegistry.activityOf([SESSION]);
        return activity.get(SESSION) === 'idle';
      });
      const before = await bureau.contexts.get(SESSION);
      interleaver.arm();

      const archived = await bureau.contexts.archive(SESSION);
      stepReleased.resolve();
      expect(racingFire).toBeDefined();
      // The fire's workflow ends either way: its run ends in the error its save raised.
      await terminalOf(bureau, await racingFire!);

      expect(archived).toMatchObject({ changed: true });
      expect(generations).toBe(2);
      const after = await bureau.contexts.get(SESSION);
      expect(after?.metadata['sessionArchivedAt']).toBe(archived?.archivedAt);
      expect(after?.conversationHistory.ids).toEqual(before?.conversationHistory.ids);
      expect(after?.metadata['lastScheduledFireRunId']).toBe(
        before?.metadata['lastScheduledFireRunId'],
      );
    } finally {
      await bureau?.dispose();
      await fixture.dispose();
    }
  });
});
