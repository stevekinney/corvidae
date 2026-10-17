import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateContext, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import {
  type BatchOperation,
  MemoryStorage,
  resolveStorage,
  type Storage,
  textValueStore,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import type { Conversation } from 'conversationalist';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import {
  admitSessionInput,
  createSessionInputMailbox,
  SESSION_INPUT_DELIVERY_RETENTION_MS,
} from './session-input-durability';
import type { Bureau, BureauOptions } from './types';

/**
 * COR-1476 — a session with open input always has a live run, so an input
 * `submitSessionInput` called `admitted` is always answered: by the run that is
 * live, by the same run's last step, or by a continuation run the session starts
 * for input left after a run's final drain.
 */

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

function deferred<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

function userTexts(conversation: Conversation): string[] {
  return conversation
    .getMessages()
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
}

async function pollUntil(check: () => boolean | Promise<boolean>, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await yieldToPortableEventLoop();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never became true');
}

/**
 * A memory backend that can hold the next write marking a run `completed`. The
 * run has finished by then, so for the held moment the session still reads as
 * running with no run live: the window an input can be admitted into.
 */
function holdingStorage() {
  const real = new MemoryStorage();
  let holding = false;
  const blocked = deferred();
  const release = deferred();
  const storage = new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'conditionalBatch') {
        const original = target.conditionalBatch.bind(target);
        return async (conditions: unknown, operations: BatchOperation[]) => {
          const marksCompleted = operations.some(
            (operation) =>
              operation.type === 'put' &&
              operation.key.startsWith('agent-session') &&
              new TextDecoder().decode(operation.value).includes('"lastRunStatus":"completed"'),
          );
          if (holding && marksCompleted) {
            holding = false;
            blocked.resolve();
            await release.promise;
          }
          return (original as (c: unknown, o: BatchOperation[]) => Promise<boolean>)(
            conditions,
            operations,
          );
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Storage;
  return {
    storage,
    real,
    holdNextCompletion: () => {
      holding = true;
    },
    blocked: blocked.promise,
    release: release.resolve,
  };
}

async function openBureau(
  storage: NonNullable<BureauOptions['storage']>,
  generate: GenerateFunction,
  extra: Partial<BureauOptions> = {},
): Promise<Bureau> {
  return createBureau({
    agents: {},
    generate,
    toolbox: createToolbox([nextTool]),
    storage,
    durableExecution: true,
    stopWhen: stopWhen.noToolCalls(),
    ...extra,
  });
}

const input = (id: string, payload: string) => ({
  id,
  principal: 'alice',
  deliveryMode: 'steer' as const,
  payload,
});

describe('a continuation run answers input left after a run ends (COR-1476)', () => {
  it('answers input admitted after the final drain with a promptless run on the same session, once, under a race', async () => {
    const held = holdingStorage();
    const secondRunStepOne = deferred();
    const releaseSecondRun = deferred();
    const runs: { step: number; texts: string[] }[][] = [];
    const bureau = await openBureau(held.storage, async (context: GenerateContext) => {
      if (context.step === 0) runs.push([]);
      runs.at(-1)!.push({ step: context.step, texts: userTexts(context.conversation) });
      if (runs.length === 1) return { content: 'answer one', toolCalls: [] };
      if (context.step === 0) {
        return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      secondRunStepOne.resolve();
      await releaseSecondRun.promise;
      return { content: 'answer two', toolCalls: [] };
    });
    try {
      held.holdNextCompletion();
      const first = await bureau.createRun({ message: 'First', principal: 'alice' });
      await held.blocked;

      // The first run has finished and its terminal write is still deferred: the
      // session reads as running, so both inputs are admitted, together, with
      // nothing live to deliver them.
      const [a, b] = await Promise.all([
        bureau.submitSessionInput(first.sessionId, input('input-a', 'sent after the last drain')),
        bureau.submitSessionInput(first.sessionId, input('input-b', 'and a second thing')),
      ]);
      expect([a.outcome, b.outcome]).toEqual(['admitted', 'admitted']);
      await bureau.runDurableMaintenance();
      await secondRunStepOne.promise;

      // One continuation run, with no prompt of its own, whose first boundary
      // delivered both inputs in the order admitted.
      expect(runs).toHaveLength(2);
      const [continuationStepZero] = runs[1]!;
      expect(continuationStepZero?.texts).toHaveLength(3);
      expect(continuationStepZero?.texts[0]).toBe('First');
      expect(new Set(continuationStepZero?.texts.slice(1))).toEqual(
        new Set(['sent after the last drain', 'and a second thing']),
      );

      // The session is live again, so a retry reads the receipt: promoted.
      const replay = await bureau.submitSessionInput(
        first.sessionId,
        input('input-a', 'sent after the last drain'),
      );
      expect(replay.outcome).toBe('replayed');
      if (replay.outcome === 'replayed') expect(replay.receipt.state).toBe('promoted');

      held.release();
      releaseSecondRun.resolve();
      await pollUntil(async () => {
        const session = await bureau.getSession(first.sessionId);
        return session?.metadata['lastRunStatus'] === 'completed' && runs.length === 2;
      });
      expect(runs).toHaveLength(2);
    } finally {
      held.release();
      releaseSecondRun.resolve();
      await bureau.dispose();
    }
  });

  it("answers input a run's budget left over with a continuation that has a fresh budget", async () => {
    const storage = new MemoryStorage();
    const stepOneStarted = deferred();
    const releaseStepOne = deferred();
    const prompts: { run: number; step: number; texts: string[] }[] = [];
    let run = 0;
    const bureau = await openBureau(storage, async (context: GenerateContext) => {
      if (context.step === 0) run += 1;
      prompts.push({ run, step: context.step, texts: userTexts(context.conversation) });
      if (run === 1 && context.step === 0) {
        return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      if (run === 1) {
        stepOneStarted.resolve();
        await releaseStepOne.promise;
      }
      return { content: `answer ${run}`, toolCalls: [] };
    });
    try {
      const first = await bureau.createRun({
        message: 'First',
        principal: 'alice',
        maximumSteps: 2,
      });
      await stepOneStarted.promise;
      const admitted = await bureau.submitSessionInput(
        first.sessionId,
        input('input-a', 'arrived at the last step'),
      );
      expect(admitted.outcome).toBe('admitted');
      releaseStepOne.resolve();

      await pollUntil(() => run === 2 && prompts.some((entry) => entry.run === 2));
      // The first run, out of steps, never saw it; the continuation answers it.
      expect(
        prompts.filter((entry) => entry.run === 1).flatMap((entry) => entry.texts),
      ).not.toContain('arrived at the last step');
      expect(prompts.find((entry) => entry.run === 2)?.texts).toEqual([
        'First',
        'arrived at the last step',
      ]);
    } finally {
      releaseStepOne.resolve();
      await bureau.dispose();
    }
  });

  it('marks input failed, not accepted forever, after two continuations cannot be started', async () => {
    const held = holdingStorage();
    // One run per window: every continuation start is refused by flow control.
    const bureau = await openBureau(
      held.storage,
      async () => ({ content: 'answer', toolCalls: [] }),
      {
        flowControl: { rateLimit: { limit: 1, windowMilliseconds: 3_600_000 } },
      },
    );
    try {
      held.holdNextCompletion();
      const first = await bureau.createRun({ message: 'First', principal: 'alice' });
      await held.blocked;
      const admitted = await bureau.submitSessionInput(first.sessionId, input('input-a', 'late'));
      expect(admitted.outcome).toBe('admitted');
      held.release();

      // The backstop retries the start; the second refusal is the last.
      for (let pass = 0; pass < 4; pass += 1) await bureau.runDurableMaintenance();

      const session = await bureau.getSession(first.sessionId);
      const mailbox = createSessionInputMailbox(held.real, first.sessionId, 100);
      const [receipt] = await mailbox.list({ limit: 10 });
      expect(receipt?.state).toBe('rejected');
      const replay = await admitSessionInput({
        storage: held.real,
        kv: textValueStore(held.real),
        sessionMailbox: mailbox,
        sessionId: first.sessionId,
        id: 'input-a',
        principal: 'alice',
        deliveryMode: 'steer',
        payload: { incarnation: session?.incarnation ?? '', payload: 'late' },
        principalBacklogLimit: 100,
        sessionBacklogLimitForCrossSessionRead: 100,
        nowMs: Date.now(),
      });
      expect(replay.outcome).toBe('replayed');
      if (replay.outcome === 'replayed') expect(replay.receipt.state).toBe('failed');
    } finally {
      held.release();
      await bureau.dispose();
    }
  });
});

describe('a run that is shut down or aborted releases its input (COR-1476)', () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('releases claims on an abort-policy shutdown, and the next boot delivers them', async () => {
    directory = await mkdtemp(join(tmpdir(), 'corvidae-session-input-shutdown-'));
    const configuration = { type: 'sqlite', path: join(directory, 'bureau.sqlite') } as const;
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const stepOneStarted = deferred();

    const first = await openBureau(configuration, async (context: GenerateContext) => {
      if (context.step === 0) {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      stepOneStarted.resolve();
      return new Promise<never>(() => {});
    });
    const run = await first.createRun({ message: 'First', principal: 'alice' });
    await stepZeroStarted.promise;
    await first.submitSessionInput(run.sessionId, input('input-a', 'first'));
    await first.submitSessionInput(run.sessionId, input('input-b', 'second'));
    releaseStepZero.resolve();
    // Step 1's boundary has claimed both inputs; they are in no transcript yet.
    await stepOneStarted.promise;
    await first.shutdown({ policy: 'abort' });

    const prompts: string[][] = [];
    const second = await openBureau(configuration, async (context: GenerateContext) => {
      prompts.push(userTexts(context.conversation));
      return { content: 'answer', toolCalls: [] };
    });
    try {
      await second.waitForRecovery?.();
      await pollUntil(() => prompts.length > 0);
      expect(prompts).toEqual([['First', 'first', 'second']]);
    } finally {
      await second.dispose();
    }
  });

  it('abortRun on a step that ignores its signal cancels the input it held, starts no continuation, and leaves no renewal running', async () => {
    const storage = new MemoryStorage();
    const base = createDefaultRuntimeServices();
    let openIntervals = 0;
    const runtime = {
      ...base,
      timers: {
        ...base.timers,
        setInterval: (callback: () => void, milliseconds?: number) => {
          openIntervals += 1;
          return base.timers.setInterval(callback, milliseconds);
        },
        clearInterval: (handle: unknown) => {
          openIntervals -= 1;
          base.timers.clearInterval(handle);
        },
      },
    };
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const stepOneStarted = deferred();
    let runs = 0;
    const bureau = await openBureau(
      storage,
      async (context: GenerateContext) => {
        if (context.step === 0) runs += 1;
        if (runs === 1 && context.step === 0) {
          stepZeroStarted.resolve();
          await releaseStepZero.promise;
          return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        stepOneStarted.resolve();
        // Ignores its abort signal entirely.
        return new Promise<never>(() => {});
      },
      { runtime },
    );
    try {
      const baseline = openIntervals;
      const first = await bureau.createRun({ message: 'First', principal: 'alice' });
      await stepZeroStarted.promise;
      await bureau.submitSessionInput(first.sessionId, input('input-a', 'first'));
      releaseStepZero.resolve();
      await stepOneStarted.promise;
      // The first run holds the input and keeps its lease alive.
      expect(openIntervals).toBeGreaterThan(baseline);

      await bureau.abortRun(first.id);
      await pollUntil(() => openIntervals === baseline);

      // Stop means stop: the input the run never put in its transcript is
      // cancelled so the client can resend it, and no run starts to answer it.
      const mailbox = createSessionInputMailbox(storage, first.sessionId, 100);
      await pollUntil(async () => {
        const [receipt] = await mailbox.list({ limit: 10 });
        return receipt?.state === 'cancelled';
      });
      await bureau.runDurableMaintenance();
      expect(runs).toBe(1);
      const session = await bureau.getSession(first.sessionId);
      expect(session?.metadata['lastRunId']).toBe(first.id);
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it('settles an input whose user turn was saved as promoted when the run answering it is stopped, and the next run answers both turns', async () => {
    const storage = new MemoryStorage();
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const secondRunStarted = deferred();
    const runs: { run: number; texts: string[] }[] = [];
    let run = 0;
    const bureau = await openBureau(storage, async (context: GenerateContext) => {
      if (context.step === 0) run += 1;
      runs.push({ run, texts: userTexts(context.conversation) });
      if (run === 1 && context.step === 0) {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      // The first run's second step fails after the input's turn was appended.
      if (run === 1) throw new Error('the model is down');
      if (run === 2) {
        secondRunStarted.resolve();
        // The continuation never answers; the user stops it.
        return new Promise<never>(() => {});
      }
      return { content: `answer ${run}`, toolCalls: [] };
    });
    try {
      const first = await bureau.createRun({ message: 'First', principal: 'alice' });
      await stepZeroStarted.promise;
      await bureau.submitSessionInput(first.sessionId, input('input-a', 'please answer this'));
      releaseStepZero.resolve();

      // The failing step saved the turn without an answer, so the input is not
      // promoted, and the continuation answers it without appending it twice.
      await secondRunStarted.promise;
      expect(runs.filter((entry) => entry.run === 2)).toEqual([
        { run: 2, texts: ['First', 'please answer this'] },
      ]);
      const secondSession = await bureau.getSession(first.sessionId);
      const secondRunId = secondSession?.metadata['lastRunId'];
      expect(secondRunId).not.toBe(first.id);

      if (typeof secondRunId !== 'string') throw new Error('expected a run id');
      await bureau.abortRun(secondRunId);
      const mailbox = createSessionInputMailbox(storage, first.sessionId, 100);
      await pollUntil(async () => {
        const session = await bureau.getSession(first.sessionId);
        return session?.metadata['lastRunStatus'] === 'aborted';
      });
      await bureau.runDurableMaintenance();

      // No third run started, and the input reads promoted: it is part of the conversation.
      const stoppedSession = await bureau.getSession(first.sessionId);
      const incarnation = stoppedSession?.incarnation ?? '';
      await pollUntil(async () => {
        const replay = await admitSessionInput({
          storage,
          kv: textValueStore(storage),
          sessionMailbox: mailbox,
          sessionId: first.sessionId,
          id: 'input-a',
          principal: 'alice',
          deliveryMode: 'steer',
          payload: { incarnation, payload: 'please answer this' },
          principalBacklogLimit: 100,
          sessionBacklogLimitForCrossSessionRead: 100,
          nowMs: Date.now(),
        });
        return replay.outcome === 'replayed' && replay.receipt.state === 'promoted';
      });
      expect(run).toBe(2);

      // The next run the user starts answers the dangling turn together with its own.
      await bureau.createRun({ message: 'again', principal: 'alice', sessionId: first.sessionId });
      await pollUntil(() => run === 3);
      expect(runs.find((entry) => entry.run === 3)?.texts).toEqual([
        'First',
        'please answer this',
        'again',
      ]);
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });
});

describe('the delivery retention outlasts what it describes (COR-1476)', () => {
  it("is longer than the command timeout plus the mailbox's terminal retention", async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = createSessionInputMailbox(storage, 'retention-probe', 100, () => now);
    const admission = await mailbox.admit({
      caller: 'alice',
      target: 'retention-probe',
      kind: 'session-input:steer',
      payload: { form: 'inline', value: {} },
      idempotencyKey: 'probe',
    });
    if (admission.status !== 'admitted') throw new Error('expected admitted');
    const claimed = await mailbox.claim();
    if (claimed.status !== 'claimed') throw new Error('expected a claim');
    await mailbox.acknowledge({
      commandId: claimed.claim.receipt.commandId,
      attemptToken: claimed.claim.attemptToken,
    });

    // Measure how long the mailbox keeps a terminal record.
    const settledAt = now;
    let retainedFor = 0;
    for (const step of [3_600_000, 3_600_000 * 12, 3_600_000 * 11, 3_600_000, 1]) {
      now += step;
      await mailbox.runMaintenance();
      if ((await mailbox.receipt(admission.receipt.commandId)) === null) break;
      retainedFor = now - settledAt;
    }
    expect(retainedFor).toBeGreaterThan(0);
    expect(SESSION_INPUT_DELIVERY_RETENTION_MS).toBeGreaterThan(7 * 86_400_000 + retainedFor);
  });
});

void resolveStorage;
