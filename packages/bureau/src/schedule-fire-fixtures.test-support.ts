/**
 * Fixtures for the tests of a schedule fire's reviews (COR-1596): a durable Bureau whose engine
 * timers are driven by hand, a fire that is one `runDurableMaintenance` tick away, and the tools
 * and models a fire asks a human with. Each test file calls `harness.dispose` after each test.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
  type Toolbox,
} from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { createBureauHandler } from './http/create-bureau-handler.ts';
import { authentication, OWNER } from './http/management/management-fixtures.test-support.ts';
import type { Bureau, BureauOptions, PendingReview } from './types';

export async function pollUntil<T>(
  check: () => T | undefined | Promise<T | undefined>,
  what: string,
  attempts = 600,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await check();
    if (value !== undefined) return value;
    await yieldToPortableEventLoop();
  }
  throw new Error(`Condition was not met: ${what}`);
}

/** The Bureaus and database files one test file opens, ended by `dispose`. */
export function createScheduleFireHarness() {
  const bureaus: Bureau[] = [];
  const databasePaths: string[] = [];
  let databaseCounter = 0;
  return {
    async dispose(): Promise<void> {
      for (const bureau of bureaus.splice(0)) await bureau.dispose();
      for (const path of databasePaths.splice(0)) {
        await rm(path, { force: true });
        await rm(`${path}-wal`, { force: true });
        await rm(`${path}-shm`, { force: true });
      }
    },
    nextDatabasePath(): string {
      const path = join(
        tmpdir(),
        `bureau-schedule-fire-reviews-${process.pid}-${databaseCounter++}.sqlite`,
      );
      databasePaths.push(path);
      return path;
    },
    async open(options: Partial<BureauOptions> = {}): Promise<Bureau> {
      const bureau = await createBureau({
        id: 'schedule-fire-reviews-bureau',
        agents: {},
        storage: { type: 'memory' },
        durableExecution: true,
        durableBackgroundTasks: 'manual',
        durableOwnership: { ownership: 'none' },
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
        ...options,
      });
      bureaus.push(bureau);
      return bureau;
    },
  };
}

/** A model that asks for a human answer on step 0 and thanks the operator once resumed. */
export function askingGenerate(signalName = 'answer', seen: string[] = []): GenerateFunction {
  return async (context: GenerateContext) => {
    if (context.step === 0) {
      return {
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'requestHumanInput',
            arguments: { signalName, prompt: 'Which environment?' },
          },
        ],
      };
    }
    seen.push(JSON.stringify(context.conversation.current));
    return { content: 'thanks', toolCalls: [] };
  };
}

/** A tool whose every call parks on operator approval, and which records each execution. */
export function approvalToolbox(charges: number[]): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret: 'schedule-fire-reviews-secret',
      policy: {
        beforeExecute: () => ({
          allow: false,
          status: 'needs_approval',
          reason: 'Operator approval required',
          action: { message: 'Approve charge' },
        }),
      },
    },
  ) as unknown as Toolbox;
}

export const chargesOnce: GenerateFunction = async (context) =>
  context.step === 0
    ? {
        content: '',
        toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 4242 } }],
      }
    : { content: 'charged', toolCalls: [] };

/**
 * Like {@link chargesOnce}, with a call id of its own for each fire, because the fires of one
 * recurring session share a conversation and a tool call id may appear in it only once.
 */
export function chargesWithFreshCallIds(): GenerateFunction {
  let fires = 0;
  return async (context) => {
    if (context.step > 0) return { content: 'charged', toolCalls: [] };
    fires += 1;
    return {
      content: '',
      toolCalls: [{ id: `charge-${fires}`, name: 'charge-card', arguments: { cents: 4242 } }],
    };
  };
}

/** Registers a schedule owned by `principal` and ticks it once; the fire is its current run. */
export async function fireOnce(
  bureau: Bureau,
  principal: string = OWNER.alice,
  sessionId?: string,
): Promise<{ readonly scheduleId: string; readonly fireId: string }> {
  const created = await bureau.createSchedule({
    agentName: 'researcher',
    input: 'check in',
    spec: '1m',
    principal,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  const occurrence = created?.nextFireAt;
  if (created === undefined || occurrence === null || occurrence === undefined) {
    throw new Error('The schedule has no first occurrence.');
  }
  await bureau.runDurableMaintenance(occurrence);
  const fireId = await pollUntil(async () => {
    const schedule = await bureau.getSchedule(created.id);
    return schedule?.currentWorkflowId;
  }, 'the tick to launch a fire');
  return { scheduleId: created.id, fireId };
}

export const reviewsOf = (bureau: Bureau, runId: string): PendingReview[] =>
  bureau.listPendingReviews().filter((review) => review.runId === runId);

export async function reviewOf(bureau: Bureau, runId: string): Promise<PendingReview> {
  return pollUntil(() => reviewsOf(bureau, runId)[0], `a pending review of run ${runId}`);
}

export async function durableStatus(bureau: Bureau, runId: string): Promise<string | undefined> {
  const run = await bureau.getDurableRun(runId);
  return run?.status;
}

export function handlerOf(bureau: Bureau) {
  return createBureauHandler(bureau, { authentication });
}
