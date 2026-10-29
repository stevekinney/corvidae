import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgentSession,
  createManualRuntimeServices,
  createSessionStore,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
  createAgent,
} from '@lostgradient/operative';
import { MemoryStorage, type Storage, textValueStore } from '@lostgradient/storage';
import { resolveStorage, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory, CURRENT_SCHEMA_VERSION } from 'conversationalist';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import {
  admitSessionInput,
  createSessionInputMailbox,
  SESSION_INPUT_TERMINAL_RETENTION_MS,
} from './session-input-durability';
import { appendSteeringLogEvent } from './steering-log';
import {
  acknowledgesSessionInput,
  deferred,
  logsRunEnded,
  logsRunPromoted,
  pollUntil,
  readsMailbox,
  seamStorage,
  userTexts,
} from './test/session-input-fixtures';
import type { Bureau, BureauDiagnostic, BureauOptions } from './types';
import type { AgentDefinitions } from './agent-catalog';
import { startTaskFrom } from './test/task-start-request.ts';
import { listHeldTasks } from './test';

/**
 * COR-1476 — a run that ends cancels the input it never delivered, whatever
 * way it ended, and never starts a run to answer it. Input whose turn its
 * checkpoint transcript holds stays promoted.
 */

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

async function openBureau(
  storage: NonNullable<BureauOptions['storage']>,
  generate: GenerateFunction,
  { maximumSteps, ...extra }: Partial<BureauOptions> & { readonly maximumSteps?: number } = {},
): Promise<Bureau> {
  return createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate,
        toolbox: createToolbox([nextTool]),
        stopWhen: stopWhen.noToolCalls(),
        // The agent's own step cap: a task carries none of its own.
        ...(maximumSteps === undefined ? {} : { maximumSteps }),
      }),
    },
    storage,
    durable: true,
    ...extra,
  });
}

const input = (id: string, payload: string) => ({
  id,
  principal: 'alice',
  deliveryMode: 'steer' as const,
  payload,
});

/** The state a retry of the input reads, straight from the mailbox and the promotion records. */
async function receiptState(
  storage: Storage,
  sessionId: string,
  incarnation: string,
  id: string,
  payload: string,
): Promise<string> {
  const replay = await admitSessionInput({
    storage,
    kv: textValueStore(storage, { disposeUnderlyingStorage: false }),
    sessionMailbox: createSessionInputMailbox(storage, sessionId, incarnation, 100),
    sessionId,
    id,
    principal: 'alice',
    deliveryMode: 'steer',
    incarnation,
    payload: { schemaVersion: CURRENT_SCHEMA_VERSION, incarnation, payload },
    principalBacklogLimit: 100,
    sessionBacklogLimitForCrossSessionRead: 100,
    nowMs: Date.now(),
  });
  if (replay.outcome !== 'replayed') throw new Error(`expected a replay, got ${replay.outcome}`);
  return replay.receipt.state;
}

async function incarnationOf(bureau: Bureau, sessionId: string): Promise<string> {
  const session = await bureau.contexts.get(sessionId);
  if (session === undefined) throw new Error(`session ${sessionId} is gone`);
  return session.incarnation;
}

async function markers(storage: Storage): Promise<string[]> {
  return textValueStore(storage, { disposeUnderlyingStorage: false }).list(
    'session-input-open:v2:',
  );
}

describe('a run that ends cancels the input it never delivered (COR-1476)', () => {
  it('completes: input admitted during its only step ends canceled, and no run starts for it', async () => {
    const storage = new MemoryStorage();
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    let generations = 0;
    const bureau = await openBureau(
      storage,
      async () => {
        generations += 1;
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'answer', toolCalls: [] };
      },
      { maximumSteps: 1 },
    );
    try {
      const run = await startTaskFrom(bureau, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
      });
      await stepZeroStarted.promise;
      const admitted = await bureau.contexts.input(run.contextId, input('input-x', 'late'));
      expect(admitted.outcome).toBe('admitted');
      if (admitted.outcome === 'admitted') expect(admitted.receipt.state).toBe('accepted');
      const incarnation = await incarnationOf(bureau, run.contextId);

      // With no step left, the run cannot drain the input, so its end cancels it.
      releaseStepZero.resolve();
      await bureau.tasks.wait(run.id);
      await pollUntil(
        async () =>
          (await receiptState(storage, run.contextId, incarnation, 'input-x', 'late')) ===
          'canceled',
      );
      await bureau.maintain();

      expect(generations).toBe(1);
      expect(listHeldTasks(bureau)).toHaveLength(1);
      expect(await markers(storage)).toEqual([]);
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it('fails: input admitted while the failing step generated ends canceled', async () => {
    const storage = new MemoryStorage();
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const bureau = await openBureau(storage, async () => {
      stepZeroStarted.resolve();
      await releaseStepZero.promise;
      throw new Error('the model is down');
    });
    try {
      const run = await bureau.tasks.start('default', 'First', { principal: 'alice' });
      await stepZeroStarted.promise;
      const admitted = await bureau.contexts.input(run.contextId, input('input-x', 'never seen'));
      expect(admitted.outcome).toBe('admitted');
      const incarnation = await incarnationOf(bureau, run.contextId);
      releaseStepZero.resolve();

      await pollUntil(async () => {
        const session = await bureau.contexts.get(run.contextId);
        return session?.metadata['lastRunStatus'] === 'error';
      });
      await pollUntil(
        async () =>
          (await receiptState(storage, run.contextId, incarnation, 'input-x', 'never seen')) ===
          'canceled',
      );
      expect(listHeldTasks(bureau)).toHaveLength(1);
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it('tasks.cancel on a step that ignores its signal cancels the input it held, starts no run, and leaves no renewal running', async () => {
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
      const first = await bureau.tasks.start('default', 'First', { principal: 'alice' });
      await stepZeroStarted.promise;
      await bureau.contexts.input(first.contextId, input('input-a', 'first'));
      const incarnation = await incarnationOf(bureau, first.contextId);
      releaseStepZero.resolve();
      await stepOneStarted.promise;
      // Step 1's boundary holds the input and keeps its lease alive; its memo
      // never commits, so the turn reaches no checkpoint transcript.
      expect(openIntervals).toBeGreaterThan(baseline);

      await bureau.tasks.cancel(first.id);
      await pollUntil(() => openIntervals === baseline);
      await pollUntil(
        async () =>
          (await receiptState(storage, first.contextId, incarnation, 'input-a', 'first')) ===
          'canceled',
      );
      await bureau.maintain();
      expect(runs).toBe(1);
      expect(listHeldTasks(bureau)).toHaveLength(1);
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it('an engine cancel of a step that ignores its signal cancels the input it held', async () => {
    const storage = new MemoryStorage();
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const stepOneStarted = deferred();
    const bureau = await openBureau(storage, async (context: GenerateContext) => {
      if (context.step === 0) {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      stepOneStarted.resolve();
      return new Promise<never>(() => {});
    });
    try {
      const first = await bureau.tasks.start('default', 'First', { principal: 'alice' });
      await stepZeroStarted.promise;
      await bureau.contexts.input(first.contextId, input('input-a', 'first'));
      const incarnation = await incarnationOf(bureau, first.contextId);
      releaseStepZero.resolve();
      await stepOneStarted.promise;

      await bureau.durableEngine()!.cancel(first.id);
      await pollUntil(
        async () =>
          (await receiptState(storage, first.contextId, incarnation, 'input-a', 'first')) ===
          'canceled',
      );
      await pollUntil(async () => {
        const session = await bureau.contexts.get(first.contextId);
        return session?.metadata['lastRunStatus'] === 'aborted';
      });
      await bureau.maintain();
      expect(listHeldTasks(bureau)).toHaveLength(1);
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it.each(['an engine cancel', 'tasks.cancel'] as const)(
    '%s on a run whose checkpoint holds a late-drained turn leaves that input promoted',
    async (stop) => {
      const storage = new MemoryStorage();
      const stepZeroStarted = deferred();
      const releaseStepZero = deferred();
      const stepOneStarted = deferred();
      const prompts: { step: number; texts: string[] }[] = [];
      let runs = 0;
      const bureau = await openBureau(storage, async (context: GenerateContext) => {
        if (context.step === 0) runs += 1;
        prompts.push({ step: context.step, texts: userTexts(context.conversation) });
        if (context.step === 0) {
          stepZeroStarted.resolve();
          await releaseStepZero.promise;
          // No tool call: the run would end, so the final drain picks the input up late.
          return { content: 'answer 0', toolCalls: [] };
        }
        stepOneStarted.resolve();
        return new Promise<never>(() => {});
      });
      try {
        const first = await bureau.tasks.start('default', 'First', { principal: 'alice' });
        await stepZeroStarted.promise;
        await bureau.contexts.input(first.contextId, input('input-x', 'please answer this'));
        const incarnation = await incarnationOf(bureau, first.contextId);
        releaseStepZero.resolve();
        await stepOneStarted.promise;
        // Step 0 drained the turn late and its write promoted it; step 1 answers it.
        expect(prompts.find((entry) => entry.step === 1)?.texts).toEqual([
          'First',
          'please answer this',
        ]);

        if (stop === 'an engine cancel') {
          await bureau.durableEngine()!.cancel(first.id);
        } else {
          await bureau.tasks.cancel(first.id);
        }
        await pollUntil(async () => {
          const session = await bureau.contexts.get(first.contextId);
          return session?.metadata['lastRunStatus'] === 'aborted';
        });
        await bureau.maintain();

        expect(
          await receiptState(
            storage,
            first.contextId,
            incarnation,
            'input-x',
            'please answer this',
          ),
        ).toBe('promoted');
        const session = await bureau.contexts.get(first.contextId);
        const transcript = new Conversation(session!.conversationHistory).getMessages();
        expect(
          transcript.some(
            (message) =>
              message.metadata?.['sessionInputId'] === 'input-x' && message.id === 'input-x',
          ),
        ).toBe(true);
        expect(runs).toBe(1);
      } finally {
        releaseStepZero.resolve();
        await bureau.dispose();
      }
    },
  );

  it('leaves a turn the transcript holds promoted when the step that appended it fails, and the next run the user starts answers it', async () => {
    const storage = new MemoryStorage();
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
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
      return { content: `answer ${run}`, toolCalls: [] };
    });
    try {
      const first = await bureau.tasks.start('default', 'First', { principal: 'alice' });
      await stepZeroStarted.promise;
      await bureau.contexts.input(first.contextId, input('input-a', 'please answer this'));
      const incarnation = await incarnationOf(bureau, first.contextId);
      releaseStepZero.resolve();

      await pollUntil(async () => {
        const session = await bureau.contexts.get(first.contextId);
        return session?.metadata['lastRunStatus'] === 'error';
      });
      await bureau.maintain();
      // The failing step saved the turn, and that write promoted it: never canceled.
      expect(
        await receiptState(storage, first.contextId, incarnation, 'input-a', 'please answer this'),
      ).toBe('promoted');
      expect(run).toBe(1);

      // The next run the user starts answers the dangling turn together with its own.
      await bureau.tasks.start('default', 'again', {
        contextId: first.contextId,
        principal: 'alice',
      });
      await pollUntil(() => run === 2);
      expect(runs.find((entry) => entry.run === 2)?.texts).toEqual([
        'First',
        'please answer this',
        'again',
      ]);
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it("leaves input for the second of two runs on one session: the first run's end only releases, and the second delivers it", async () => {
    const storage = new MemoryStorage();
    const started = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const prompts: { step: number; texts: string[] }[] = [];
    const bureau = await openBureau(storage, async (context: GenerateContext) => {
      prompts.push({ step: context.step, texts: userTexts(context.conversation) });
      if (context.step === 0) {
        // The first run's step 0 sees one user turn; the second run's sees two.
        const index = userTexts(context.conversation).length - 1;
        started[index]?.resolve();
        await release[index]?.promise;
        return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      return { content: 'done', toolCalls: [] };
    });
    try {
      const first = await startTaskFrom(bureau, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
      });
      await started[0]!.promise;
      const second = await bureau.tasks.start('default', 'Second', {
        contextId: first.contextId,
        principal: 'alice',
      });
      await started[1]!.promise;
      const admitted = await bureau.contexts.input(
        first.contextId,
        input('input-x', 'for whoever'),
      );
      expect(admitted.outcome).toBe('admitted');
      const incarnation = await incarnationOf(bureau, first.contextId);

      // The first run ends, before its step-0 boundary could deliver anything, with the second
      // still live: it releases, cancels nothing.
      first.abort();
      release[0]!.resolve();
      await bureau.tasks.wait(first.id);
      // The second run's next boundary delivers the input, which it could not
      // do had the first run's end cancelled it.
      release[1]!.resolve();
      await bureau.tasks.wait(second.id);

      expect(prompts.find((entry) => entry.step === 1)?.texts).toEqual([
        'First',
        'Second',
        'for whoever',
      ]);
      expect(
        await receiptState(storage, first.contextId, incarnation, 'input-x', 'for whoever'),
      ).toBe('promoted');
      expect(listHeldTasks(bureau)).toHaveLength(2);
    } finally {
      release.forEach((gate) => gate.resolve());
      await bureau.dispose();
    }
  });
});

describe('a run that ends over a lease a gone holder left behind (COR-1476)', () => {
  it('requests the cancellation while the lease stands, and the sweep settles it once it lapses', async () => {
    const origin = '2026-10-17T12:00:00.000Z';
    const runtime = createManualRuntimeServices({ origin });
    const storage = new MemoryStorage();
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const bureau = await openBureau(
      storage,
      async () => {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'answer', toolCalls: [] };
      },
      { maximumSteps: 1, runtime },
    );
    try {
      const run = await startTaskFrom(bureau, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
      });
      await stepZeroStarted.promise;
      await bureau.contexts.input(run.contextId, input('input-x', 'late'));
      const incarnation = await incarnationOf(bureau, run.contextId);
      // A gate in a process that then died claims it, on the same clock.
      const deadHolder = createSessionInputMailbox(storage, run.contextId, incarnation, 100, () =>
        runtime.clock.now(),
      );
      const deadClaim = await deadHolder.claim();
      expect(deadClaim.status).toBe('claimed');
      const mailbox = createSessionInputMailbox(storage, run.contextId, incarnation, 100, () =>
        runtime.clock.now(),
      );
      const state = async () => {
        const [receipt] = await mailbox.list({ limit: 10 });
        return receipt?.state;
      };

      // The run ends with the lease standing: its settlement requests the
      // cancellation, which the holder will never settle, and keeps the marker.
      releaseStepZero.resolve();
      await bureau.tasks.wait(run.id);
      await pollUntil(async () => (await state()) === 'cancellation-requested');
      expect(await markers(storage)).toHaveLength(1);
      expect(await receiptState(storage, run.contextId, incarnation, 'input-x', 'late')).toBe(
        'accepted',
      );

      // Past the visibility timeout, the sweep's maintenance settles it.
      runtime.setTime(Date.parse(origin) + 31_000);
      await bureau.maintain();
      expect(await state()).toBe('cancelled');
      expect(await receiptState(storage, run.contextId, incarnation, 'input-x', 'late')).toBe(
        'canceled',
      );
      expect(await markers(storage)).toHaveLength(0);
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });
});

describe('a run whose start fails after its promotion (COR-1476)', () => {
  it('logs its end and registers no phantom run: a shutdown that begins after the promotion refuses the start', async () => {
    const seam = seamStorage(new MemoryStorage());
    let generations = 0;
    const bureau = await openBureau(seam.storage, async () => {
      generations += 1;
      return { content: 'answer', toolCalls: [] };
    });
    try {
      const first = await bureau.tasks.start('default', 'First', { principal: 'alice' });
      await bureau.tasks.wait(first.id);
      await pollUntil(async () => {
        const session = await bureau.contexts.get(first.contextId);
        return session?.metadata['lastRunStatus'] === 'completed';
      });

      // The second run's promotion is held before it commits; a shutdown
      // begins meanwhile, so the start that follows the promotion is refused.
      // Nothing between the promotion and the start reads storage any more:
      // the run's input gate opens its incarnation's mailbox directly.
      const promotion = seam.holdWrite(logsRunPromoted);
      const ended = seam.awaitWriteCommitted(logsRunEnded);
      let startError: unknown;
      const starting = bureau.tasks
        .start('default', 'Second', { contextId: first.contextId, principal: 'alice' })
        .catch((error: unknown) => {
          startError = error;
        });
      await promotion.reached;
      const shuttingDown = bureau.shutdown({ policy: 'abort' });
      promotion.release();
      await starting;
      expect(startError).toBeInstanceOf(Error);
      // Its end is logged at once: nothing counts the never-started run as live.
      await ended;
      await shuttingDown;
      expect(generations).toBe(1);
      expect(listHeldTasks(bureau)).toHaveLength(1);
    } finally {
      await bureau.dispose();
    }
  });
});

describe('a cancellation that reaches a run after it appended the turn (COR-1476)', () => {
  it('never lets a retry read canceled: accepted until the checkpoint commits, promoted after', async () => {
    const origin = '2026-10-17T12:00:00.000Z';
    const runtime = createManualRuntimeServices({ origin });
    const storage = new MemoryStorage();
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const stepOneStarted = deferred();
    const releaseStepOne = deferred();
    const prompts: string[][] = [];
    const bureau = await openBureau(
      storage,
      async (context: GenerateContext) => {
        prompts.push(userTexts(context.conversation));
        if (context.step === 0) {
          stepZeroStarted.resolve();
          await releaseStepZero.promise;
          return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        stepOneStarted.resolve();
        await releaseStepOne.promise;
        return { content: 'done', toolCalls: [] };
      },
      { maximumSteps: 3, runtime },
    );
    try {
      const run = await startTaskFrom(bureau, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
      });
      await stepZeroStarted.promise;
      await bureau.contexts.input(run.contextId, input('input-x', 'delivered'));
      const incarnation = await incarnationOf(bureau, run.contextId);
      releaseStepZero.resolve();
      await stepOneStarted.promise;
      expect(prompts[1]).toEqual(['First', 'delivered']);
      const mailbox = createSessionInputMailbox(storage, run.contextId, incarnation, 100, () =>
        runtime.clock.now(),
      );
      const [receipt] = await mailbox.list({ limit: 10 });
      expect(receipt?.state).toBe('claimed');

      // Another process cancels the leased command while step 1 generates.
      await mailbox.requestCancellation({ commandId: receipt!.commandId, reason: 'elsewhere' });
      // The gate's renewal reports it and keeps the lease: the turn is in the
      // conversation, so a retry must never read `canceled`.
      await runtime.advance(10_000);
      // load-proof: the work this lets finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turn with one); no timer or I/O is pending
      await yieldToPortableEventLoop();
      const [inWindow] = await mailbox.list({ limit: 10 });
      expect(inWindow?.state).toBe('cancellation-requested');
      expect(await receiptState(storage, run.contextId, incarnation, 'input-x', 'delivered')).toBe(
        'accepted',
      );

      // The checkpoint commits the turn: promoted, and the command closes as
      // cancelled through the acknowledgement.
      releaseStepOne.resolve();
      await bureau.tasks.wait(run.id);
      expect(await receiptState(storage, run.contextId, incarnation, 'input-x', 'delivered')).toBe(
        'promoted',
      );
      const [final] = await mailbox.list({ limit: 10 });
      expect(final?.state).toBe('cancelled');
    } finally {
      releaseStepZero.resolve();
      releaseStepOne.resolve();
      await bureau.dispose();
    }
  });
});

describe('a promoted input whose command was never acknowledged (COR-1476)', () => {
  it('is spared by the run that ends, because its turn is in the transcript, released with the gate, and retired by the sweep, still promoted', async () => {
    const origin = '2026-10-17T12:00:00.000Z';
    const runtime = createManualRuntimeServices({ origin });
    const real = new MemoryStorage();
    const seam = seamStorage(real);
    // The one acknowledgement fails: the command stays leased, promoted.
    let remaining = 1;
    const failing = seam.failWrites((operations) => {
      if (!acknowledgesSessionInput(operations) || remaining === 0) return false;
      remaining -= 1;
      return true;
    }, new Error('the mailbox is unavailable'));
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const prompts: string[][] = [];
    const bureau = await openBureau(
      seam.storage,
      async (context: GenerateContext) => {
        prompts.push(userTexts(context.conversation));
        if (context.step === 0) {
          stepZeroStarted.resolve();
          await releaseStepZero.promise;
          return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        return { content: 'done', toolCalls: [] };
      },
      { maximumSteps: 2, runtime },
    );
    const holds: Array<{ release: () => void }> = [];
    try {
      const run = await startTaskFrom(bureau, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
      });
      await stepZeroStarted.promise;
      await bureau.contexts.input(run.contextId, input('input-x', 'delivered'));
      const incarnation = await incarnationOf(bureau, run.contextId);
      // The run's settlement reads the marker only after it has decided what
      // to cancel: held there, it shows what it left alone.
      const atMarkerRead = seam.holdRead(
        (key) => key.startsWith('session-input-open:v2:'),
        seam.awaitWriteCommitted(logsRunEnded),
      );
      holds.push(atMarkerRead);
      releaseStepZero.resolve();
      await bureau.tasks.wait(run.id);
      expect(prompts[1]).toEqual(['First', 'delivered']);
      expect(failing.attempts()).toBe(1);

      // The run's end spares the command, whose turn its transcript holds. The
      // gate kept the lease its failed acknowledgement left, so disposal has
      // already returned the command to the mailbox: open, promoted, listed.
      const mailbox = createSessionInputMailbox(real, run.contextId, incarnation, 100, () =>
        runtime.clock.now(),
      );
      const state = async () => {
        const [receipt] = await mailbox.list({ limit: 10 });
        return receipt?.state;
      };
      await atMarkerRead.reached;
      expect(await state()).toBe('accepted');
      atMarkerRead.release();
      await pollUntil(async () => {
        const session = await bureau.contexts.get(run.contextId);
        return session?.metadata['lastRunStatus'] === 'completed';
      });
      expect(await markers(real)).toHaveLength(1);
      expect(await receiptState(real, run.contextId, incarnation, 'input-x', 'delivered')).toBe(
        'promoted',
      );

      // The sweep retires what no run will acknowledge, at once, since nothing
      // leases it any more; the promotion stands.
      await bureau.maintain();
      expect(await state()).toBe('cancelled');
      expect(await receiptState(real, run.contextId, incarnation, 'input-x', 'delivered')).toBe(
        'promoted',
      );
      expect(await markers(real)).toHaveLength(0);
    } finally {
      holds.forEach((hold) => hold.release());
      failing.stop();
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });
});

describe('what the retry loop must not hold (COR-1476)', () => {
  it('settles a cancelled run once, and returns its lease before the run-ended write', async () => {
    const real = new MemoryStorage();
    const seam = seamStorage(real);
    const failing = seam.failWrites(logsRunEnded, new Error('the log is unavailable'));
    const diagnostics: BureauDiagnostic[] = [];
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const stepOneStarted = deferred();
    const bureau = await openBureau(
      seam.storage,
      async (context: GenerateContext) => {
        if (context.step === 0) {
          stepZeroStarted.resolve();
          await releaseStepZero.promise;
          return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        stepOneStarted.resolve();
        return new Promise<never>(() => {});
      },
      { onDiagnostic: (diagnostic) => void diagnostics.push(diagnostic) },
    );
    try {
      const run = await bureau.tasks.start('default', 'First', { principal: 'alice' });
      await stepZeroStarted.promise;
      await bureau.contexts.input(run.contextId, input('input-a', 'first'));
      const incarnation = await incarnationOf(bureau, run.contextId);
      releaseStepZero.resolve();
      await stepOneStarted.promise;
      const mailbox = createSessionInputMailbox(real, run.contextId, incarnation, 100);
      const state = async () => {
        const [receipt] = await mailbox.list({ limit: 10 });
        return receipt?.state;
      };
      // Step 1's boundary holds the input.
      expect(await state()).toBe('claimed');

      // Two paths report the end: the cancellation inline, and the terminal
      // listener. One settlement runs: one first-failure diagnostic, and the
      // lease is back with the mailbox while the write is still failing.
      const cancelling = bureau.tasks.cancel(run.id);
      await pollUntil(() => failing.attempts() >= 2);
      await pollUntil(async () => {
        const session = await bureau.contexts.get(run.contextId);
        return session?.metadata['lastRunStatus'] === 'aborted';
      });
      expect(await state()).not.toBe('claimed');
      expect(
        diagnostics.filter(
          (diagnostic) =>
            diagnostic.scope === 'session-input' && diagnostic.message.includes('retrying'),
        ),
      ).toHaveLength(1);
      failing.stop();
      const cancelled = await cancelling;
      expect(cancelled.receipt).toBe('cancel-requested');
    } finally {
      failing.stop();
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it('ends its backoff wait the moment the bureau shuts down', async () => {
    const seam = seamStorage(new MemoryStorage());
    const failing = seam.failWrites(logsRunEnded, new Error('the log is unavailable'));
    // Each wait is a timer on the runtime, held until the test advances the clock.
    const runtime = createManualRuntimeServices();
    const bureau = await openBureau(
      seam.storage,
      async () => ({ content: 'answer', toolCalls: [] }),
      { maximumSteps: 1, runtime, onDiagnostic: () => {} },
    );
    try {
      const run = await startTaskFrom(bureau, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
      });
      await bureau.tasks.wait(run.id);
      // The loop is in its first wait, which nothing has released.
      const firstBackoffDueAt = runtime.monotonic.now() + 10;
      await pollUntil(() =>
        runtime.pendingTimers().some((timer) => timer.dueAt === firstBackoffDueAt),
      );

      // Disposal does not wait for it: it completes while the clock has not moved.
      let disposed = false;
      const disposing = bureau.dispose().then(() => {
        disposed = true;
      });
      await pollUntil(() => disposed);
      expect(runtime.monotonic.now()).toBeLessThan(firstBackoffDueAt);
      await disposing;
    } finally {
      failing.stop();
      await bureau.dispose();
    }
  });
});

describe('the run-ended write comes before the mailbox read (COR-1476)', () => {
  it('retries the run-ended write until it is acknowledged, then cancels what was left open', async () => {
    const seam = seamStorage(new MemoryStorage());
    let remaining = 2;
    const failing = seam.failWrites((operations) => {
      if (!logsRunEnded(operations) || remaining === 0) return false;
      remaining -= 1;
      return true;
    }, new Error('the log is unavailable'));
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const diagnostics: BureauDiagnostic[] = [];
    const bureau = await openBureau(
      seam.storage,
      async () => {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'answer', toolCalls: [] };
      },
      { maximumSteps: 1, onDiagnostic: (diagnostic) => void diagnostics.push(diagnostic) },
    );
    try {
      const run = await startTaskFrom(bureau, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
      });
      await stepZeroStarted.promise;
      await bureau.contexts.input(run.contextId, input('input-x', 'late'));
      const incarnation = await incarnationOf(bureau, run.contextId);
      releaseStepZero.resolve();

      await pollUntil(
        async () =>
          (await receiptState(seam.storage, run.contextId, incarnation, 'input-x', 'late')) ===
          'canceled',
      );
      // The first failure is the terminal listener's own log write, reported by
      // steering; the settlement retried it once more before the third attempt
      // was acknowledged.
      expect(failing.attempts()).toBe(2);
      expect(
        diagnostics.filter(
          (diagnostic) =>
            diagnostic.scope === 'steering' && diagnostic.message.includes('run-ended'),
        ),
      ).toHaveLength(1);
      expect(
        diagnostics.filter(
          (diagnostic) =>
            diagnostic.scope === 'session-input' && diagnostic.message.includes('retrying'),
        ),
      ).toHaveLength(1);
    } finally {
      failing.stop();
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it('backs off between attempts, doubling to a 2 s cap, and reports only the first failure', async () => {
    const seam = seamStorage(new MemoryStorage());
    const failing = seam.failWrites(logsRunEnded, new Error('the log is unavailable'));
    const runtime = createManualRuntimeServices();
    const diagnostics: BureauDiagnostic[] = [];
    const bureau = await openBureau(
      seam.storage,
      async () => ({ content: 'answer', toolCalls: [] }),
      { maximumSteps: 1, runtime, onDiagnostic: (diagnostic) => void diagnostics.push(diagnostic) },
    );
    try {
      const run = await startTaskFrom(bureau, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
      });
      await bureau.tasks.wait(run.id);
      // Each wait is a timer on the runtime: the loop's schedule is read off the clock, one wait
      // at a time, doubling from 10 ms and holding at 2000 ms.
      const expectedDelays = [10, 20, 40, 80, 160, 320, 640, 1280, 2000, 2000, 2000];
      for (const expectedDelay of expectedDelays) {
        const dueAt = runtime.monotonic.now() + expectedDelay;
        await pollUntil(() => runtime.pendingTimers().some((timer) => timer.dueAt === dueAt));
        await runtime.advance(expectedDelay);
      }
      await pollUntil(() => failing.attempts() >= 12);

      expect(
        diagnostics.filter(
          (diagnostic) =>
            diagnostic.scope === 'session-input' && diagnostic.message.includes('retrying'),
        ),
      ).toHaveLength(1);
    } finally {
      failing.stop();
      await bureau.dispose();
    }
  });

  it('stops retrying on a corrupt steering log, reports it once, and leaves the input to the sweep', async () => {
    const real = new MemoryStorage();
    const seam = seamStorage(real);
    const failing = seam.failWrites(logsRunEnded, new Error('the log is unavailable'));
    const diagnostics: BureauDiagnostic[] = [];
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const stepOneStarted = deferred();
    const bureau = await openBureau(
      seam.storage,
      async (context: GenerateContext) => {
        if (context.step === 0) {
          stepZeroStarted.resolve();
          await releaseStepZero.promise;
          return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        stepOneStarted.resolve();
        return new Promise<never>(() => {});
      },
      { onDiagnostic: (diagnostic) => void diagnostics.push(diagnostic) },
    );
    try {
      const run = await bureau.tasks.start('default', 'First', { principal: 'alice' });
      await stepZeroStarted.promise;
      releaseStepZero.resolve();
      await stepOneStarted.promise;
      await bureau.contexts.input(run.contextId, input('input-x', 'open'));
      const incarnation = await incarnationOf(bureau, run.contextId);

      // The cancellation's settlement cannot write `run-ended`; after its first
      // failed attempt the log's head is found corrupt.
      const cancelling = bureau.tasks.cancel(run.id);
      await pollUntil(() => failing.attempts() >= 1);
      const kv = textValueStore(real, { disposeUnderlyingStorage: false });
      const logKeys = await kv.list('steering-log:v1:');
      const head = logKeys.find((key) => key.endsWith(':head'));
      if (head === undefined) throw new Error('the session has no steering log head');
      await kv.set(head, 'not a head');

      // Corruption is not retried: the settlement reports it once and ends.
      const cancelled = await cancelling;
      expect(cancelled.receipt).toBe('cancel-requested');
      const corrupt = () =>
        diagnostics.filter(
          (diagnostic) =>
            diagnostic.scope === 'session-input' && diagnostic.message.includes('corrupt'),
        );
      await pollUntil(() => corrupt().length > 0);
      await bureau.tasks.wait(run.id);
      expect(corrupt()).toHaveLength(1);
      expect(await receiptState(real, run.contextId, incarnation, 'input-x', 'open')).toBe(
        'accepted',
      );
    } finally {
      failing.stop();
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });

  it("never reads the mailbox without an acknowledged write, and leaves the input to the next boot's sweep", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'corvidae-session-input-run-end-'));
    const path = join(directory, 'bureau.sqlite');
    const real = await resolveStorage({ type: 'sqlite', path });
    const seam = seamStorage(real);
    const failing = seam.failWrites(logsRunEnded, new Error('the log is unavailable'));
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const diagnostics: BureauDiagnostic[] = [];
    const first = await openBureau(
      seam.storage,
      async () => {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'answer', toolCalls: [] };
      },
      { maximumSteps: 1, onDiagnostic: (diagnostic) => void diagnostics.push(diagnostic) },
    );
    let sessionId = '';
    let incarnation = '';
    try {
      const run = await startTaskFrom(first, {
        agentName: 'default',
        input: 'First',
        principal: 'alice',
      });
      sessionId = run.contextId;
      await stepZeroStarted.promise;
      await first.contexts.input(run.contextId, input('input-x', 'late'));
      incarnation = await incarnationOf(first, run.contextId);
      const mailboxReads = seam.countReads(readsMailbox);
      releaseStepZero.resolve();

      // The run has ended and its write keeps failing: it retries, and in the
      // meantime it never looks at the mailbox, so the input stays as admitted.
      await first.tasks.wait(run.id);
      await pollUntil(() => failing.attempts() >= 3);
      expect(mailboxReads()).toBe(0);
      expect(await receiptState(real, run.contextId, incarnation, 'input-x', 'late')).toBe(
        'accepted',
      );
      // Closing the bureau ends the retries; shutdown releases, never cancels.
      await first.shutdown();
      expect(mailboxReads()).toBe(0);
      expect(await receiptState(real, run.contextId, incarnation, 'input-x', 'late')).toBe(
        'accepted',
      );
    } finally {
      releaseStepZero.resolve();
      failing.stop();
      await first.dispose();
      real[Symbol.dispose]();
    }

    const second = await openBureau({ type: 'sqlite', path }, async () => {
      throw new Error('no run should generate');
    });
    try {
      await second.recovery();
      // The run's workflow is terminal, so nothing is live: the boot sweep cancels.
      const storage = await resolveStorage({ type: 'sqlite', path });
      try {
        expect(await receiptState(storage, sessionId, incarnation, 'input-x', 'late')).toBe(
          'canceled',
        );
      } finally {
        storage[Symbol.dispose]();
      }
      expect(listHeldTasks(second)).toHaveLength(0);
    } finally {
      await second.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('a run promoted but never started (COR-1476)', () => {
  it('counts as starting within its start window and as ended after it, when the sweep cancels the input', async () => {
    const origin = '2026-10-17T12:00:00.000Z';
    const runtime = createManualRuntimeServices({ origin });
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    // A process saved the session as starting run "run-ghost", promoted the run
    // in the steering log, and died before the engine ever saw the run.
    const sessionStore = createSessionStore(kv, { runtime });
    await sessionStore.save(
      createAgentSession({
        id: 'ghost-session',
        agentName: 'default',
        conversationHistory: createConversationHistory({ id: 'ghost-session' }),
        metadata: {
          lastRunId: 'run-ghost',
          lastRunStatus: 'running',
          steeringStartingRuns: { 'run-ghost': origin },
          sessionOwner: 'alice',
        },
        runtime,
      }),
    );
    const saved = await sessionStore.load('ghost-session');
    if (saved === undefined) throw new Error('the seeded session is missing');
    await appendSteeringLogEvent(
      kv,
      'ghost-session',
      saved.incarnation,
      { raw: null, sequence: 0 },
      { type: 'promoted', runId: 'run-ghost', now: origin },
    );

    const bureau = await openBureau(
      storage,
      async () => {
        throw new Error('no run should generate');
      },
      { runtime, maintenance: 'manual' },
    );
    try {
      const admitted = await bureau.contexts.input('ghost-session', input('input-x', 'hello'));
      expect(admitted.outcome).toBe('admitted');
      // Still within the run's start window: the run counts as starting, so
      // neither the admission nor the sweep cancels the input.
      if (admitted.outcome === 'admitted') expect(admitted.receipt.state).toBe('accepted');
      await bureau.maintain();
      expect(
        await receiptState(storage, 'ghost-session', saved.incarnation, 'input-x', 'hello'),
      ).toBe('accepted');

      // The window lapses with no workflow ever created: the run is over.
      runtime.setTime(Date.parse(origin) + 61_000);
      await bureau.maintain();
      expect(
        await receiptState(storage, 'ghost-session', saved.incarnation, 'input-x', 'hello'),
      ).toBe('canceled');
      expect(listHeldTasks(bureau)).toHaveLength(0);
    } finally {
      await bureau.dispose();
    }
  });
});

describe("a deleted session's input mailbox (COR-1476)", () => {
  it('is retired by the sweep once retention has elapsed, because deletion marks the incarnation', async () => {
    const origin = '2026-10-17T12:00:00.000Z';
    const runtime = createManualRuntimeServices({ origin });
    const storage = new MemoryStorage();
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const bureau = await openBureau(
      storage,
      async () => {
        stepZeroStarted.resolve();
        await releaseStepZero.promise;
        return { content: 'answer', toolCalls: [] };
      },
      { runtime, maintenance: 'manual' },
    );
    try {
      const run = await bureau.tasks.start('default', 'First', { principal: 'alice' });
      await stepZeroStarted.promise;
      await bureau.contexts.input(run.contextId, input('input-x', 'delivered'));
      const incarnation = await incarnationOf(bureau, run.contextId);
      const mailbox = createSessionInputMailbox(storage, run.contextId, incarnation, 100, () =>
        runtime.clock.now(),
      );
      // The run delivers and retires the input; nothing is open, so the sweep
      // drops the live marker.
      releaseStepZero.resolve();
      // Under manual background tasks nothing re-drives a durable-run wait, so
      // the run's end is read from what it leaves behind.
      await pollUntil(async () => {
        const [receipt] = await mailbox.list({ limit: 10 });
        return receipt?.state === 'applied';
      });
      await pollUntil(async () => {
        const session = await bureau.contexts.get(run.contextId);
        return session?.metadata['lastRunStatus'] === 'completed';
      });
      await bureau.maintain();
      expect(await markers(storage)).toHaveLength(0);

      // Deletion marks the incarnation again, for the sweep to retire its
      // mailbox: no run will ever maintain it.
      await bureau.contexts.delete(run.contextId);
      expect(await markers(storage)).toHaveLength(1);
      await runtime.advance(SESSION_INPUT_TERMINAL_RETENTION_MS + 3_600_000);
      await bureau.maintain();
      expect(await mailbox.list({ limit: 1 })).toEqual([]);
      expect(await markers(storage)).toHaveLength(0);
    } finally {
      releaseStepZero.resolve();
      await bureau.dispose();
    }
  });
});

describe('shutdown releases open input (COR-1476)', () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('releases the claims of an abort-policy shutdown without cancelling, and the next boot, which recovers no run, sweeps them', async () => {
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
    const run = await first.tasks.start('default', 'First', { principal: 'alice' });
    await stepZeroStarted.promise;
    await first.contexts.input(run.contextId, input('input-a', 'first'));
    await first.contexts.input(run.contextId, input('input-b', 'second'));
    const incarnation = await incarnationOf(first, run.contextId);
    releaseStepZero.resolve();
    // Step 1's boundary has claimed both inputs; they are in no transcript yet.
    await stepOneStarted.promise;
    await first.shutdown({ policy: 'abort' });

    // Shutdown only released them: both are still open, for the next boot.
    const afterShutdown = await resolveStorage(configuration);
    try {
      const open = await createSessionInputMailbox(
        afterShutdown,
        run.contextId,
        incarnation,
        100,
      ).list({
        limit: 10,
      });
      expect(open.map((receipt) => receipt.idempotencyKey)).toEqual(['input-a', 'input-b']);
      expect(open.every((receipt) => receipt.state !== 'cancelled')).toBe(true);
      expect(
        await receiptState(afterShutdown, run.contextId, incarnation, 'input-a', 'first'),
      ).toBe('accepted');
    } finally {
      afterShutdown[Symbol.dispose]();
    }

    // The abort cancelled the run's workflow, so nothing recovers it: the boot
    // sweep finds the session with no run and cancels what was left.
    let generations = 0;
    const second = await openBureau(configuration, async () => {
      generations += 1;
      return { content: 'answer', toolCalls: [] };
    });
    try {
      await second.recovery();
      expect(listHeldTasks(second)).toHaveLength(0);
      expect(generations).toBe(0);
    } finally {
      await second.dispose();
    }
    const afterBoot = await resolveStorage(configuration);
    try {
      expect(await receiptState(afterBoot, run.contextId, incarnation, 'input-a', 'first')).toBe(
        'canceled',
      );
      expect(await receiptState(afterBoot, run.contextId, incarnation, 'input-b', 'second')).toBe(
        'canceled',
      );
    } finally {
      afterBoot[Symbol.dispose]();
    }
  });
});
