/**
 * A scheduled fire that is in flight when its Bureau stops is recovered by the next Bureau over
 * the same storage, not cancelled with its schedule.
 *
 * The fire is started by Weft's scheduler poller on real elapsed time (a `1s` schedule on a
 * one-second poll), and the recovering Bureau waits for it again, so this is slow by nature and
 * lives in the `test:slow` lane (COR-1576). The rest of the scheduled-fire path is in
 * `schedule-fire.test.ts`.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GenerateContext, GenerateResponse, Toolbox } from '@lostgradient/operative';
import { stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { getMessages } from 'conversationalist';

import { createBureau } from './create-bureau';

const FIRE_TIMEOUT_MS = 20_000;

let recoveryDatabaseCounter = 0;

/** Real-wall-clock poll — `engine.schedule` ticks fire on actual elapsed time. */
async function waitForReal(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

interface RecordedCall {
  conversationId: string;
  messageCount: number;
  roles: string[];
  userPrompts: string[];
  systemPrompts: string[];
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([], { context: {} }) as unknown as Toolbox;
}

describe('D6 scheduled-fire path (#109)', () => {
  it(
    'recovers an in-flight scheduled fire across a bureau restart without cancelling it',
    async () => {
      const databasePath = join(
        tmpdir(),
        `bureau-scheduled-fire-recovery-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
      );

      try {
        let bureauACall: RecordedCall | undefined;
        const bureauA = await createBureau({
          agents: {},
          generate: async (context: GenerateContext) => {
            const messages = context.conversation.getMessages();
            bureauACall = {
              conversationId: context.conversation.current.id,
              messageCount: messages.length,
              roles: messages.map((message) => message.role),
              userPrompts: messages
                .filter((message) => message.role === 'user' && typeof message.content === 'string')
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
          storage: { type: 'sqlite', path: databasePath },
          durableExecution: true,
          systemPrompt: 'You are a recoverable scheduled agent.',
          stopWhen: stopWhen.noToolCalls(),
        });

        const schedule = await bureauA.createSchedule({
          agentName: 'researcher',
          input: 'recover this scheduled fire',
          spec: '1s',
        });
        expect(schedule).toBeDefined();

        const bureauAStartedFire = await waitForReal(
          () => bureauACall !== undefined,
          FIRE_TIMEOUT_MS,
        );
        expect(bureauAStartedFire).toBe(true);
        const recoveredSessionId = bureauACall!.conversationId;
        expect(recoveredSessionId.startsWith(`sched-${schedule!.id}-`)).toBe(true);

        bureauA.dispose();

        let resolveRecoveredGenerate: ((response: GenerateResponse) => void) | undefined;
        const recoveredGenerate = new Promise<GenerateResponse>((resolve) => {
          resolveRecoveredGenerate = resolve;
        });
        let bureauBCall: RecordedCall | undefined;
        const bureauB = await createBureau({
          agents: {},
          generate: async (context: GenerateContext) => {
            const messages = context.conversation.getMessages();
            bureauBCall = {
              conversationId: context.conversation.current.id,
              messageCount: messages.length,
              roles: messages.map((message) => message.role),
              userPrompts: messages
                .filter((message) => message.role === 'user' && typeof message.content === 'string')
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
          storage: { type: 'sqlite', path: databasePath },
          durableExecution: true,
          systemPrompt: 'You are a recoverable scheduled agent.',
          stopWhen: stopWhen.noToolCalls(),
        });

        try {
          await bureauB.cancelSchedule(schedule!.id);

          const bureauBRecoveredFire = await waitForReal(
            () => bureauBCall !== undefined,
            FIRE_TIMEOUT_MS,
          );
          expect(bureauBRecoveredFire).toBe(true);
          expect(bureauBCall!.conversationId).toBe(recoveredSessionId);
          expect(bureauBCall!.userPrompts).toContain('recover this scheduled fire');

          resolveRecoveredGenerate!({
            content: 'recovered scheduled fire completed',
            toolCalls: [],
          });

          const persisted = await waitForReal(async () => {
            const session = await bureauB.getSession(recoveredSessionId);
            if (!session) return false;
            return getMessages(session.conversationHistory).some(
              (message) =>
                typeof message.content === 'string' &&
                message.content.includes('recovered scheduled fire completed'),
            );
          }, FIRE_TIMEOUT_MS);
          expect(persisted).toBe(true);

          const session = await bureauB.getSession(recoveredSessionId);
          expect(session).not.toBeNull();
          const messages = getMessages(session!.conversationHistory);
          expect(
            messages.some((message) => message.content === 'recover this scheduled fire'),
          ).toBe(true);
          expect(session!.metadata['lastRunStatus']).not.toBe('running');
        } finally {
          bureauB.dispose();
        }
      } finally {
        await rm(databasePath, { force: true });
        await rm(`${databasePath}-wal`, { force: true });
        await rm(`${databasePath}-shm`, { force: true });
      }
    },
    FIRE_TIMEOUT_MS,
  );
});
