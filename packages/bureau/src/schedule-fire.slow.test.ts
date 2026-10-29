/**
 * Scheduled fires that wait on Weft's scheduler poller for more than the fast lane's budget:
 * a stateless interval fire runs with a fresh session per fire, and a recurring fire accumulates
 * one fixed session across fires (both moved here from the fast lane by COR-1737); a fire that is
 * in flight when its Bureau stops is recovered by the next Bureau over the same storage, not
 * cancelled with its schedule; a fire that ends on maximum-steps is still persisted; and a fire's
 * terminal lifecycle event is dispatched as completed or failed.
 *
 * Each fire is started by the poller on real elapsed time (a `1s` schedule on a one-second poll),
 * so these are slow by nature and live in the `test:slow` lane (COR-1576). The first occurrence is
 * due one second after the schedule is created and fires on the first poll tick after that, so a
 * fire lands between one and two seconds after creation, depending on where the ticks fall: the
 * first occurrence reliably fires now that a tick's own lateness is no longer a missed fire
 * (COR-1616), but up to two seconds is still over the fast lane's budget. The rest of the
 * scheduled-fire path is in `schedule-fire.test.ts`.
 */

import type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  Toolbox,
} from '@lostgradient/operative';
import {
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  stopWhen,
  createAgent,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { getMessages } from 'conversationalist';
import { z } from 'zod';
import { createBureau } from './create-bureau';
import type { AgentDefinitions } from './agent-catalog';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { MemoryStorage } from '@lostgradient/storage';
import { createSqliteStorageFixture } from './test/storage-fixtures';

/** Real-wall-clock poll — `engine.schedule` ticks fire on actual elapsed time. */
async function waitForReal(condition: () => boolean | Promise<boolean>): Promise<true> {
  await waitUntil(condition, { message: 'waitForReal' });
  return true;
}

interface RecordedCall {
  conversationId: string;
  messageCount: number;
  roles: string[];
  userPrompts: string[];
  systemPrompts: string[];
}

/**
 * A generate that records what each fire's agent body saw (conversation id +
 * messages), then returns a final assistant turn so the run stops at step 0.
 */
function createRecordingGenerate(calls: RecordedCall[]): GenerateFunction {
  return async (context: GenerateContext) => {
    const messages = context.conversation.getMessages();
    calls.push({
      conversationId: context.conversation.current.id,
      messageCount: messages.length,
      roles: messages.map((message) => message.role),
      userPrompts: messages
        .filter((message) => message.role === 'user' && typeof message.content === 'string')
        .map((message) => message.content as string),
      systemPrompts: messages
        .filter((message) => message.role === 'system' && typeof message.content === 'string')
        .map((message) => message.content as string),
    });
    return { content: 'acknowledged', toolCalls: [] };
  };
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([], { context: {} }) as unknown as Toolbox;
}

describe('D6 scheduled-fire path (#109)', () => {
  it('fires a stateless interval schedule and runs the agent with a fresh session per fire', async () => {
    const calls: RecordedCall[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: createRecordingGenerate(calls),
          toolbox: createEmptyToolbox(),
          instructions: 'You are a scheduled agent.',
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });

    try {
      // A bare duration shorthand ('1s') is registered as an interval
      // ({ every: '1s' }), not cron — see toScheduleSpec.
      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'stateless tick prompt',
        spec: '1s',
      });
      expect(summary).toBeDefined();

      const fired = await waitForReal(() => calls.length >= 1);
      // Stop further fires before asserting so the count is stable.
      await bureau.schedules.cancel(summary!.id);

      expect(fired).toBe(true);
      // The agent body actually ran with the scheduled prompt.
      expect(calls[0]!.userPrompts).toContain('stateless tick prompt');
      // A fresh per-fire session still seeds the bureau systemPrompt, exactly as
      // a normal run into a new session does: [system, user].
      expect(calls[0]!.systemPrompts).toContain('You are a scheduled agent.');
      expect(calls[0]!.roles).toEqual(['system', 'user']);
      // Each stateless fire mints its own session id, so no two fires collide.
      const ids = calls.map((call) => call.conversationId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[0]!.startsWith('sched-')).toBe(true);
    } finally {
      bureau.dispose();
    }
  });

  it('fires a recurring schedule into a fixed session and accumulates conversation across fires', async () => {
    const sessionId = 'daily-digest';
    const calls: RecordedCall[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: createRecordingGenerate(calls),
          toolbox: createEmptyToolbox(),
          instructions: 'You are a scheduled agent.',
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });

    try {
      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'digest prompt',
        spec: '1s',
        sessionId,
      });
      expect(summary).toBeDefined();

      const recurringCalls = () => calls.filter((call) => call.conversationId === sessionId);
      const firedTwice = await waitForReal(() => recurringCalls().length >= 2);
      await bureau.schedules.cancel(summary!.id);

      expect(firedTwice).toBe(true);

      // The FIRST fire into a not-yet-existing recurring session seeds the bureau
      // systemPrompt, exactly as a normal run into a new session does.
      const fires = recurringCalls();
      expect(fires[0]!.systemPrompts).toContain('You are a scheduled agent.');
      // Fire 2's agent body saw fire 1's turn — context accumulated, proving the
      // recurring (session-given) semantics, not a fresh session per fire.
      expect(fires[1]!.messageCount).toBeGreaterThan(fires[0]!.messageCount);

      // The durable proof: the session itself accumulated both fires' user turns,
      // and the systemPrompt was seeded ONCE (not re-appended on the second fire).
      const session = await bureau.contexts.get(sessionId);
      expect(session).not.toBeNull();
      const messages = getMessages(session!.conversationHistory);
      const userTurns = messages.filter((message) => message.role === 'user');
      expect(userTurns.length).toBeGreaterThanOrEqual(2);
      expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    } finally {
      bureau.dispose();
    }
  });

  it('recovers an in-flight scheduled fire across a bureau restart without cancelling it', async () => {
    const database = createSqliteStorageFixture();

    try {
      let bureauACall: RecordedCall | undefined;
      const bureauA = await createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({
            generate: async (context: GenerateContext) => {
              const messages = context.conversation.getMessages();
              bureauACall = {
                conversationId: context.conversation.current.id,
                messageCount: messages.length,
                roles: messages.map((message) => message.role),
                userPrompts: messages
                  .filter(
                    (message) => message.role === 'user' && typeof message.content === 'string',
                  )
                  .map((message) => message.content as string),
                systemPrompts: messages
                  .filter(
                    (message) => message.role === 'system' && typeof message.content === 'string',
                  )
                  .map((message) => message.content as string),
              };
              return new Promise<never>(() => {});
            },
            toolbox: createEmptyToolbox(),
            instructions: 'You are a recoverable scheduled agent.',
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: database.storage,
        durable: true,
      });

      const schedule = await bureauA.schedules.create({
        agentName: 'default',
        input: 'recover this scheduled fire',
        spec: '1s',
      });
      expect(schedule).toBeDefined();

      const bureauAStartedFire = await waitForReal(() => bureauACall !== undefined);
      expect(bureauAStartedFire).toBe(true);
      const recoveredSessionId = bureauACall!.conversationId;
      expect(recoveredSessionId.startsWith(`sched-${schedule!.id}-`)).toBe(true);

      await bureauA.dispose();

      let resolveRecoveredGenerate: ((response: GenerateResponse) => void) | undefined;
      const recoveredGenerate = new Promise<GenerateResponse>((resolve) => {
        resolveRecoveredGenerate = resolve;
      });
      let bureauBCall: RecordedCall | undefined;
      const bureauB = await createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({
            generate: async (context: GenerateContext) => {
              const messages = context.conversation.getMessages();
              bureauBCall = {
                conversationId: context.conversation.current.id,
                messageCount: messages.length,
                roles: messages.map((message) => message.role),
                userPrompts: messages
                  .filter(
                    (message) => message.role === 'user' && typeof message.content === 'string',
                  )
                  .map((message) => message.content as string),
                systemPrompts: messages
                  .filter(
                    (message) => message.role === 'system' && typeof message.content === 'string',
                  )
                  .map((message) => message.content as string),
              };
              return recoveredGenerate;
            },
            toolbox: createEmptyToolbox(),
            instructions: 'You are a recoverable scheduled agent.',
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: database.open(),
        durable: true,
      });

      try {
        await bureauB.schedules.cancel(schedule!.id);

        const bureauBRecoveredFire = await waitForReal(() => bureauBCall !== undefined);
        expect(bureauBRecoveredFire).toBe(true);
        expect(bureauBCall!.conversationId).toBe(recoveredSessionId);
        expect(bureauBCall!.userPrompts).toContain('recover this scheduled fire');

        resolveRecoveredGenerate!({
          content: 'recovered scheduled fire completed',
          toolCalls: [],
        });

        const persisted = await waitForReal(async () => {
          const session = await bureauB.contexts.get(recoveredSessionId);
          if (!session) return false;
          return getMessages(session.conversationHistory).some(
            (message) =>
              typeof message.content === 'string' &&
              message.content.includes('recovered scheduled fire completed'),
          );
        });
        expect(persisted).toBe(true);

        const session = await bureauB.contexts.get(recoveredSessionId);
        expect(session).not.toBeNull();
        const messages = getMessages(session!.conversationHistory);
        expect(messages.some((message) => message.content === 'recover this scheduled fire')).toBe(
          true,
        );
        expect(session!.metadata['lastRunStatus']).not.toBe('running');
      } finally {
        await bureauB.dispose();
      }
    } finally {
      await database.dispose();
    }
  });

  it('persists a fire that ends on maximum-steps (no final step) so the digest is not lost', async () => {
    // A generate that ALWAYS emits a tool call never satisfies noToolCalls, so the
    // fire runs until it exhausts maximumSteps — its last StepResult.final is
    // false. The session-persist hook must still save (it persists on every
    // completed step, not only the final one), or the fire vanishes from the
    // recurring digest (review: codex Mn69a).
    const sessionId = 'maxsteps-digest';
    const calls: RecordedCall[] = [];
    const recording = createRecordingGenerate(calls);
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async (context: GenerateContext) => {
            await recording(context);
            // Always call the tool → the run never stops on noToolCalls and instead
            // terminates on maximumSteps.
            return { content: '', toolCalls: [{ name: 'noop', arguments: {} }] };
          },
          toolbox: createToolbox([
            createTool({
              name: 'noop',
              description: 'no-op',
              input: z.object({}),
              execute: async () => 'ok',
            }),
          ]),
          maximumSteps: 1,
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });

    try {
      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'maxsteps prompt',
        spec: '1s',
        sessionId,
      });
      expect(summary).toBeDefined();

      // Wait for at least one fire to have run a step (it will hit maximum-steps).
      const fired = await waitForReal(() =>
        calls.some((call) => call.conversationId === sessionId),
      );
      await bureau.schedules.cancel(summary!.id);
      expect(fired).toBe(true);

      // Despite the fire ending on maximum-steps (no final step), its transcript
      // was persisted to the session — the user turn is durably recorded.
      const session = await bureau.contexts.get(sessionId);
      expect(session).not.toBeNull();
      const userTurns = getMessages(session!.conversationHistory).filter(
        (message) => message.role === 'user',
      );
      expect(userTurns.some((message) => message.content === 'maxsteps prompt')).toBe(true);
    } finally {
      bureau.dispose();
    }
  });
});

describe('AB-223: schedule definition and fire-terminal lifecycle events', () => {
  it('dispatches ScheduleCompletedEvent, correlated to the fired runId, for a fire that finishes successfully', async () => {
    const calls: RecordedCall[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: createRecordingGenerate(calls),
          toolbox: createEmptyToolbox(),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });

    try {
      const completed: ScheduleCompletedEvent[] = [];
      const failed: ScheduleFailedEvent[] = [];
      bureau.addEventListener(ScheduleCompletedEvent.type, (event) => completed.push(event));
      bureau.addEventListener(ScheduleFailedEvent.type, (event) => failed.push(event));

      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'completes successfully',
        spec: '1s',
      });
      expect(summary).toBeDefined();

      const fired = await waitForReal(() => completed.length >= 1);
      await bureau.schedules.cancel(summary!.id);

      expect(fired).toBe(true);
      expect(completed[0]!.scheduleId).toBe(summary!.id);
      // A stateless fire's session id embeds its own runId (see
      // `buildScheduledRunServices`), so the correlated runId this event
      // carries is provably the SAME fire whose conversation was recorded.
      expect(calls[0]!.conversationId).toContain(completed[0]!.runId);
      expect(failed).toHaveLength(0);
    } finally {
      bureau.dispose();
    }
  });

  it('dispatches ScheduleFailedEvent, not ScheduleCompletedEvent, for a fire whose finishReason is a failure classification', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => {
            throw new Error('deliberate scheduled-fire failure');
          },
          toolbox: createEmptyToolbox(),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });

    try {
      const completed: ScheduleCompletedEvent[] = [];
      const failed: ScheduleFailedEvent[] = [];
      bureau.addEventListener(ScheduleCompletedEvent.type, (event) => completed.push(event));
      bureau.addEventListener(ScheduleFailedEvent.type, (event) => failed.push(event));

      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'always fails',
        spec: '1s',
      });
      expect(summary).toBeDefined();

      const fired = await waitForReal(() => failed.length >= 1);
      await bureau.schedules.cancel(summary!.id);

      expect(fired).toBe(true);
      expect(failed[0]!.scheduleId).toBe(summary!.id);
      expect(failed[0]!.runId.length).toBeGreaterThan(0);
      expect(completed).toHaveLength(0);
    } finally {
      bureau.dispose();
    }
  });
});
