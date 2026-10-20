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
import { resolveStorage, type Storage, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { createMemoryAssetStorage } from './assets/storage';
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
  const openedStorages: Storage[] = [];
  const beforeDispose: Array<() => void> = [];
  let databaseCounter = 0;
  return {
    /** Runs `action` ahead of the next `dispose`, ahead of closing any Bureau. */
    onDispose(action: () => void): void {
      beforeDispose.push(action);
    },
    async dispose(): Promise<void> {
      for (const action of beforeDispose.splice(0)) action();
      for (const bureau of bureaus.splice(0)) await bureau.dispose();
      for (const storage of openedStorages.splice(0)) storage[Symbol.dispose]();
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
    /**
     * A SQLite database opened as a `Storage` instance, which a test can wrap to hold a write
     * (a crash at that write) and which, being persistent, keeps the durable event history. Each
     * call is one process's handle on the file; the harness closes it.
     */
    async sqliteStorage(
      path: string,
      wrap: (storage: Storage) => Storage = (storage) => storage,
    ): Promise<Storage> {
      const raw = await resolveStorage({ type: 'sqlite', path });
      openedStorages.push(raw);
      return wrap(raw);
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
        // `createBureauHandler` serves the asset operations, so it needs a Bureau with assets.
        assets: { storage: createMemoryAssetStorage() },
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

/** Like {@link approvalToolbox}, but a resumed call is gated again, so each approval supersedes. */
export function regatingApprovalToolbox(charges: number[]): Toolbox {
  let evaluations = 0;
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
        beforeExecute: () => {
          evaluations += 1;
          return {
            allow: false,
            status: 'needs_approval',
            reason: `Operator approval required (evaluation ${evaluations})`,
            action: { message: 'Approve charge' },
          };
        },
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

const textDecoder = new TextDecoder();

/** The text a storage call carries, whichever of strings and bytes its keys and values are. */
export function storedText(value: unknown): string {
  if (value instanceof Uint8Array) return textDecoder.decode(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(storedText).join(' ');
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).map(storedText).join(' ');
  }
  return '';
}

/**
 * Wraps a storage so that the first write after `arm()` that carries `marker` never completes:
 * the process is dead at that write. `reached` resolves when it is held.
 */
export function holdingWrites(marker: string) {
  let armed = false;
  let held = false;
  let release: (() => void) | undefined;
  const reached = Promise.withResolvers<void>();
  return {
    /** Lets the held write through, so a Bureau whose write was held can be disposed. */
    release(): void {
      release?.();
    },
    arm(): void {
      armed = true;
    },
    reached: reached.promise,
    get held(): boolean {
      return held;
    },
    wrap(storage: Storage): Storage {
      return new Proxy(storage, {
        get(target, property) {
          const member = Reflect.get(target, property, target) as unknown;
          if (typeof member !== 'function' || typeof property !== 'string') return member;
          return (...args: unknown[]) => {
            const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
            if (!armed || held || !['conditionalBatch', 'put', 'batch'].includes(property)) {
              return call();
            }
            if (!storedText(args).includes(marker)) return call();
            held = true;
            reached.resolve();
            return new Promise((resolve) => {
              release = () => resolve(call());
            });
          };
        },
      });
    },
  };
}

/**
 * A storage whose process dies between a fire step's session write, which records an approval, and
 * the step's commit: the journal write of the step is held for good, so the hook has run and the
 * request has been announced, and the step never commits. `reached` resolves at the hold.
 */
export function crashAfterApprovalWrite() {
  let armed = false;
  let held = false;
  const reached = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    wrap(storage: Storage): Storage {
      return new Proxy(storage, {
        get(target, property) {
          const member = Reflect.get(target, property, target) as unknown;
          if (typeof member !== 'function' || typeof property !== 'string') return member;
          return (...args: unknown[]) => {
            const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
            if (property !== 'conditionalBatch' || held) return call();
            const text = storedText(args);
            if (armed && /wf:[^ ]+:ckpt/.test(text)) {
              held = true;
              reached.resolve();
              // Never completes: that process is dead. Releasing it would make Weft warn that the
              // write lost a checkpoint compare-and-swap.
              return new Promise(() => {});
            }
            if (text.includes('pendingApprovalOverrides')) armed = true;
            return call();
          };
        },
      });
    },
  };
}
