import {
  type ApplicationCommandClaim,
  type ConditionalTextValueStore,
  Engine,
  Mailbox,
  MemoryStorage,
  resolveStorage,
  type Storage,
  textValueStore,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import type { GenerateContext, GenerateFunction } from '../types';
import { type CheckpointStore, createCheckpointStore } from './checkpoint-store';
import {
  createMailboxSessionInputGate,
  type DecodedSessionInput,
  type MailboxSessionInputGateTimers,
} from './mailbox-session-input-gate';
import { createRunWorkflow } from './run-workflow';
import {
  createSessionInputDeliveryStore,
  parseSessionInputDeliveries,
  planSessionInputPromotion,
  sessionInputDeliveriesKey,
  type SessionInputDeliveryStore,
} from './session-input-delivery-store';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps, SessionInputGate } from './types';

/**
 * COR-1476 — session input admitted while a durable run is live reaches the run
 * at its next step boundary, in admission order, exactly once, across a restart,
 * across concurrent runs, and across a run's termination.
 *
 * The gate and the delivery store under test are the real ones, over a real
 * mailbox and the same text-value store the run's checkpoint is written to.
 */

const SESSION_ID = 'session-1';
const RUN_ID = 'run-session-input-1';
const DAY_MS = 86_400_000;
const RETENTION_MS = 9 * DAY_MS;

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

afterEach(async () => {
  await yieldToPortableEventLoop();
});

function newMailbox(storage: Storage, now?: () => number): Mailbox {
  return new Mailbox({
    storage,
    namespace: 'test.session-input',
    resourceId: SESSION_ID,
    // Short, as Bureau's session-input mailbox has, so a released command is due again at once.
    retryBackoffMs: 10,
    maxRetryBackoffMs: 100,
    ...(now === undefined ? {} : { now }),
  });
}

function decode(claim: ApplicationCommandClaim): DecodedSessionInput {
  if (claim.payload.form !== 'inline') throw new Error('expected an inline payload');
  const value = claim.payload.value as { payload?: unknown };
  if (typeof value.payload !== 'string') throw new TypeError('malformed payload');
  return {
    payload: value.payload,
    deliveryMode: claim.receipt.kind === 'session-input:queue' ? 'queue' : 'steer',
  };
}

function kvOver(storage: Storage): ConditionalTextValueStore {
  return textValueStore(storage, { disposeUnderlyingStorage: false });
}

function deliveryStoreOver(storage: Storage, now: () => number = Date.now) {
  return createSessionInputDeliveryStore(kvOver(storage), {
    retentionMs: RETENTION_MS,
    nowMs: now,
  });
}

const alwaysLive = () => Promise.resolve(true);

function gateOver(
  mailbox: Mailbox,
  store: SessionInputDeliveryStore,
  owner = RUN_ID,
  extra: {
    timers?: MailboxSessionInputGateTimers;
    now?: () => number;
    isOwnerLive?: (runId: string) => Promise<boolean>;
  } = {},
): SessionInputGate {
  return createMailboxSessionInputGate({
    mailbox,
    decode,
    deliveries: {
      claim: (commandIds) =>
        store.claim(SESSION_ID, owner, commandIds, extra.isOwnerLive ?? alwaysLive),
    },
    ...(extra.timers === undefined ? {} : { timers: extra.timers }),
    ...(extra.now === undefined ? {} : { now: extra.now }),
  });
}

async function admit(mailbox: Mailbox, id: string, text: string): Promise<string> {
  const admission = await mailbox.admit({
    caller: 'alice',
    target: SESSION_ID,
    kind: 'session-input:steer',
    payload: { form: 'inline', value: { payload: text } },
    idempotencyKey: id,
  });
  expect(admission.status).toBe('admitted');
  if (admission.status !== 'admitted') throw new Error('expected admitted');
  return admission.receipt.commandId;
}

async function openCount(mailbox: Mailbox): Promise<number> {
  const capacity = await mailbox.capacity();
  return capacity.open;
}

function userTexts(conversation: Conversation): string[] {
  return conversation
    .getMessages()
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
}

function sessionInputMessages(conversation: Conversation): { id: string; messageId: string }[] {
  return conversation
    .getMessages()
    .filter((message) => typeof message.metadata?.['sessionInputId'] === 'string')
    .map((message) => ({
      id: message.metadata?.['sessionInputId'] as string,
      messageId: message.id,
    }));
}

function makeServices(generate: GenerateFunction, gate?: SessionInputGate): DurableRunDeps {
  const toolbox = createToolbox([nextTool]);
  return {
    toolbox,
    options: {
      generate,
      toolbox,
      conversation: createConversationHistory(),
      stopWhen: noToolCalls(),
      sessionId: SESSION_ID,
      ...(gate === undefined ? {} : { sessionInput: gate }),
    },
  };
}

interface EngineOptions {
  readonly resolveServices?: () => DurableRunDeps;
  /** Wraps the checkpoint store the workflow and its activities write through. */
  readonly wrapCheckpoint?: (inner: CheckpointStore) => CheckpointStore;
}

async function buildEngine(storage: Storage, options: EngineOptions = {}) {
  const inner = createCheckpointStore(kvOver(storage));
  const checkpointStore = options.wrapCheckpoint?.(inner) ?? inner;
  const activities = createStorageActivities(checkpointStore);
  const engine = await Engine.create({
    storage,
    recover: false,
    ...(options.resolveServices === undefined
      ? {}
      : {
          resolveWorkflowServices: () => ({
            status: 'available' as const,
            services: options.resolveServices!(),
          }),
        }),
    workflows: { agentRun: createRunWorkflow(checkpointStore) },
    activities: {
      saveCursor: activities.saveCursor,
      saveConversation: activities.saveConversation,
      recordStep: activities.recordStep,
    },
  });
  return { engine, checkpointStore };
}

type TestEngine = Awaited<ReturnType<typeof buildEngine>>['engine'];

function startRun(
  engine: TestEngine,
  services: DurableRunDeps,
  runId = RUN_ID,
  maximumSteps?: number,
) {
  return engine.start(
    'agentRun',
    {
      runId,
      sessionId: SESSION_ID,
      agentName: '',
      prompt: 'Start',
      ...(maximumSteps === undefined ? {} : { maximumSteps }),
    },
    { id: runId, services },
  );
}

/** Holds a checkpoint write that promotes session input, on either side of the commit. */
function holdingPromotion(hooks: { before?: () => Promise<void>; after?: () => Promise<void> }) {
  return (inner: CheckpointStore): CheckpointStore => ({
    ...inner,
    saveConversation: async (runId, snapshot, promotion) => {
      if (promotion !== undefined) await hooks.before?.();
      await inner.saveConversation(runId, snapshot, promotion);
      if (promotion !== undefined) await hooks.after?.();
    },
  });
}

function deferred<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

const never = () => new Promise<void>(() => {});

async function transcriptOf(checkpointStore: CheckpointStore, runId = RUN_ID) {
  const snapshot = await checkpointStore.loadConversation(runId);
  if (snapshot === null) throw new Error('no transcript saved');
  return Conversation.from(snapshot);
}

describe('session input at the durable step boundary (COR-1476)', () => {
  it('shows input admitted during a step to the model on the next step', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const prompts: string[][] = [];

    const { engine } = await buildEngine(storage);
    try {
      const handle = await startRun(
        engine,
        makeServices(
          async (context: GenerateContext) => {
            prompts.push(userTexts(context.conversation));
            if (context.step === 0) {
              stepZeroStarted.resolve();
              await releaseStepZero.promise;
              return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            return { content: 'done', toolCalls: [] };
          },
          gateOver(mailbox, deliveryStoreOver(storage)),
        ),
      );
      await stepZeroStarted.promise;
      await admit(mailbox, 'input-a', 'also check the tests');
      releaseStepZero.resolve();
      const result = (await handle.result()) as { steps: number };

      expect(result.steps).toBe(2);
      expect(prompts[0]).toEqual(['Start']);
      expect(prompts[1]).toEqual(['Start', 'also check the tests']);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('delivers two inputs in admission order, once each, promoted with the transcript', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const prompts: string[][] = [];
    const seen: Conversation[] = [];

    const { engine } = await buildEngine(storage);
    try {
      const handle = await startRun(
        engine,
        makeServices(
          async (context: GenerateContext) => {
            prompts.push(userTexts(context.conversation));
            seen.push(context.conversation);
            if (context.step === 0) {
              stepZeroStarted.resolve();
              await releaseStepZero.promise;
              return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            if (context.step === 1) {
              return { content: 'still going', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            return { content: 'done', toolCalls: [] };
          },
          gateOver(mailbox, store),
        ),
      );
      await stepZeroStarted.promise;
      const commandA = await admit(mailbox, 'input-a', 'first');
      const commandB = await admit(mailbox, 'input-b', 'second');
      releaseStepZero.resolve();
      await handle.result();

      expect(prompts[0]).toEqual(['Start']);
      expect(prompts[1]).toEqual(['Start', 'first', 'second']);
      // Delivered at step 1's boundary only; step 2 does not see them again.
      expect(prompts[2]).toEqual(['Start', 'first', 'second']);

      const delivered = sessionInputMessages(seen[2]!);
      expect(delivered.map(({ id }) => id)).toEqual(['input-a', 'input-b']);
      const records = await store.read(SESSION_ID);
      for (const [index, { messageId }] of delivered.entries()) {
        const record = records[[commandA, commandB][index]!];
        expect(record?.runId).toBe(RUN_ID);
        expect(record?.promotion?.conversationMessageId).toBe(messageId);
        expect(record?.promotion?.providerTurn).toBe(1);
      }
      expect(await openCount(mailbox)).toBe(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('answers input sent during the final step in the same run, after the reply it arrived during', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const prompts: string[][] = [];

    const { engine } = await buildEngine(storage);
    try {
      const handle = await startRun(
        engine,
        makeServices(
          async (context: GenerateContext) => {
            prompts.push(userTexts(context.conversation));
            if (context.step === 0) {
              stepZeroStarted.resolve();
              await releaseStepZero.promise;
            }
            // No tool calls, so step 0 would end the run.
            return { content: `answer ${context.step}`, toolCalls: [] };
          },
          gateOver(mailbox, deliveryStoreOver(storage)),
        ),
      );
      await stepZeroStarted.promise;
      await admit(mailbox, 'input-a', 'one more thing');
      await admit(mailbox, 'input-b', 'and another');
      releaseStepZero.resolve();
      const result = (await handle.result()) as { steps: number; content: string };

      expect(prompts).toEqual([['Start'], ['Start', 'one more thing', 'and another']]);
      expect(result.steps).toBe(2);
      expect(result.content).toBe('answer 1');
      expect(await openCount(mailbox)).toBe(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('does not re-ask when a stop is the last step the run may take, and promotes nothing', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const stepOneStarted = deferred();
    const releaseStepOne = deferred();

    const { engine } = await buildEngine(storage);
    try {
      const handle = await startRun(
        engine,
        makeServices(
          async (context: GenerateContext) => {
            if (context.step === 0) {
              return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            stepOneStarted.resolve();
            await releaseStepOne.promise;
            return { content: 'final', toolCalls: [] };
          },
          gateOver(mailbox, store),
        ),
        RUN_ID,
        2,
      );
      await stepOneStarted.promise;
      await admit(mailbox, 'input-x', 'too late for this run');
      releaseStepOne.resolve();
      const result = (await handle.result()) as { steps: number };

      expect(result.steps).toBe(2);
      expect(await openCount(mailbox)).toBe(1);
      expect(await store.read(SESSION_ID)).toEqual({});
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('delivers nothing to a run that has no session input gate', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    await admit(mailbox, 'input-a', 'ignored');
    const { engine } = await buildEngine(storage);
    try {
      const prompts: string[][] = [];
      const handle = await startRun(
        engine,
        makeServices(async (context: GenerateContext) => {
          prompts.push(userTexts(context.conversation));
          return { content: 'done', toolCalls: [] };
        }),
      );
      await handle.result();
      expect(prompts).toEqual([['Start']]);
      expect(await openCount(mailbox)).toBe(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('two live runs on one session (COR-1476)', () => {
  it('gives an input to exactly one of them, even when the step outlives the lease', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const firstStepStarted = deferred();
    const releaseFirst = deferred();
    const secondPrompts: string[][] = [];
    const firstPrompts: string[][] = [];

    const { engine } = await buildEngine(storage);
    try {
      const first = await startRun(
        engine,
        makeServices(
          async (context: GenerateContext) => {
            firstPrompts.push(userTexts(context.conversation));
            if (context.step === 0) {
              firstStepStarted.resolve();
              await releaseFirst.promise;
              return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            return { content: 'done', toolCalls: [] };
          },
          gateOver(mailbox, store, 'run-1'),
        ),
        'run-1',
      );
      await firstStepStarted.promise;
      const command = await admit(mailbox, 'input-a', 'only one of you');

      // The second run's boundary claims it, and is mid-step with it.
      const secondStepStarted = deferred();
      const releaseSecond = deferred();
      const second = await startRun(
        engine,
        makeServices(
          async (context: GenerateContext) => {
            secondPrompts.push(userTexts(context.conversation));
            if (context.step === 0) {
              secondStepStarted.resolve();
              await releaseSecond.promise;
              return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            return { content: 'done', toolCalls: [] };
          },
          gateOver(mailbox, store, 'run-2'),
        ),
        'run-2',
      );
      await secondStepStarted.promise;
      expect(secondPrompts[0]).toEqual(['Start', 'only one of you']);

      // The first run reaches its next boundary while the second still holds it.
      releaseFirst.resolve();
      await first.result();
      releaseSecond.resolve();
      await second.result();

      expect(firstPrompts.flat()).not.toContain('only one of you');
      expect(secondPrompts.at(-1)).toEqual(['Start', 'only one of you']);
      const records = await store.read(SESSION_ID);
      expect(records[command]?.runId).toBe('run-2');
      expect(records[command]?.promotion).toBeDefined();
      expect(await openCount(mailbox)).toBe(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('a run that ends or crashes mid-delivery (COR-1476)', () => {
  it('releases an input to the next run when the run is aborted mid-step, which delivers it first', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage);
    await admit(mailbox, 'input-a', 'A');
    await admit(mailbox, 'input-b', 'B');
    const stepStarted = deferred();
    const gate = gateOver(mailbox, store, 'run-1', { now: () => now });

    const { engine } = await buildEngine(storage);
    try {
      const first = await startRun(
        engine,
        makeServices(async () => {
          stepStarted.resolve();
          return new Promise<never>(() => {});
        }, gate),
        'run-1',
      );
      void first.result().catch(() => {});
      await stepStarted.promise;
      expect(Object.keys(await store.read(SESSION_ID))).toHaveLength(2);

      // The run ends without consuming either input: its reconcile releases them.
      await engine.cancel('run-1');
      await gate.dispose?.();
      expect(await store.release(SESSION_ID, 'run-1')).toBe(2);
      expect(await store.read(SESSION_ID)).toEqual({});
      // Released leases are due again after their short retry backoff.
      now += 1_000;

      const prompts: string[][] = [];
      const second = await startRun(
        engine,
        makeServices(
          async (context: GenerateContext) => {
            prompts.push(userTexts(context.conversation));
            return { content: 'done', toolCalls: [] };
          },
          gateOver(mailbox, store, 'run-3', { now: () => now }),
        ),
        'run-3',
      );
      await second.result();

      expect(prompts).toEqual([['Start', 'A', 'B']]);
      const records = Object.values(await store.read(SESSION_ID));
      expect(records.map((record) => record.runId)).toEqual(['run-3', 'run-3']);
      expect(records.every((record) => record.promotion !== undefined)).toBe(true);
      expect(await openCount(mailbox)).toBe(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('releases the input when the run ends between the step memo and the checkpoint write', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    await admit(mailbox, 'input-a', 'A');
    const writing = deferred();
    const gate = gateOver(mailbox, store);

    const { engine, checkpointStore } = await buildEngine(storage, {
      wrapCheckpoint: holdingPromotion({
        before: () => {
          writing.resolve();
          return never();
        },
      }),
    });
    try {
      const handle = await startRun(
        engine,
        makeServices(async () => ({ content: 'done', toolCalls: [] }), gate),
      );
      void handle.result().catch(() => {});
      await writing.promise;
      await engine.cancel(RUN_ID);

      // Nothing durable holds the input but the claim, so releasing it is safe.
      expect(await store.release(SESSION_ID, RUN_ID)).toBe(1);
      const transcript = await transcriptOf(checkpointStore);
      expect(sessionInputMessages(transcript)).toEqual([]);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('keeps the input when the run ends after the checkpoint write: transcript and promotion agree', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const command = await admit(mailbox, 'input-a', 'A');
    const written = deferred();
    const gate = gateOver(mailbox, store);

    const { engine, checkpointStore } = await buildEngine(storage, {
      wrapCheckpoint: holdingPromotion({
        after: () => {
          written.resolve();
          return never();
        },
      }),
    });
    try {
      const handle = await startRun(
        engine,
        makeServices(async () => ({ content: 'done', toolCalls: [] }), gate),
      );
      void handle.result().catch(() => {});
      await written.promise;
      await engine.cancel(RUN_ID);

      expect(await store.release(SESSION_ID, RUN_ID)).toBe(0);
      const records = await store.read(SESSION_ID);
      const transcript = await transcriptOf(checkpointStore);
      const [message] = sessionInputMessages(transcript);
      expect(message?.id).toBe('input-a');
      expect(records[command]?.promotion?.conversationMessageId).toBe(message?.messageId);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('a recovered owner whose step never committed appends the input once, not twice', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailboxA = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage);
    await admit(mailboxA, 'input-a', 'A');
    const stepStarted = deferred();

    const a = await buildEngine(storage);
    const handleA = await startRun(
      a.engine,
      makeServices(
        async () => {
          stepStarted.resolve();
          return new Promise<never>(() => {});
        },
        gateOver(mailboxA, store),
      ),
    );
    void handleA.result().catch(() => {});
    await stepStarted.promise;
    a.engine[Symbol.dispose]();

    // The lease the dead process held lapses and is released; the recovered
    // run is the owner.
    now += 33_000;
    await newMailbox(storage, () => now).runMaintenance();
    now += 1_000;
    const prompts: { texts: string[]; ids: string[] }[] = [];
    const mailboxB = newMailbox(storage, () => now);
    const b = await buildEngine(storage, {
      resolveServices: () =>
        makeServices(
          async (context: GenerateContext) => {
            prompts.push({
              texts: userTexts(context.conversation),
              ids: sessionInputMessages(context.conversation).map(({ id }) => id),
            });
            return { content: 'recovered', toolCalls: [] };
          },
          gateOver(mailboxB, store),
        ),
    });
    try {
      const handles = await b.engine.recoverAll();
      expect(handles).toHaveLength(1);
      await handles[0]!.result();
      expect(prompts).toEqual([{ texts: ['Start', 'A'], ids: ['input-a'] }]);
      const records = Object.values(await store.read(SESSION_ID));
      expect(records.map((record) => record.promotion !== undefined)).toEqual([true]);
    } finally {
      b.engine[Symbol.dispose]();
    }
  });

  it('a crash after the step memo committed but before the checkpoint write is replayed: the write promotes, nothing is appended again', async () => {
    const storage = new MemoryStorage();
    const mailboxA = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const command = await admit(mailboxA, 'input-a', 'A');
    const writing = deferred();
    const askedAgain: string[] = [];

    const a = await buildEngine(storage, {
      wrapCheckpoint: holdingPromotion({
        before: () => {
          writing.resolve();
          return never();
        },
      }),
    });
    const handleA = await startRun(
      a.engine,
      makeServices(
        async () => ({ content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] }),
        gateOver(mailboxA, store),
      ),
    );
    void handleA.result().catch(() => {});
    await writing.promise;
    a.engine[Symbol.dispose]();
    const heldRecords = await store.read(SESSION_ID);
    expect(heldRecords[command]?.promotion).toBeUndefined();

    const mailboxB = newMailbox(storage);
    const realGate = gateOver(mailboxB, store);
    const prompts: { step: number; ids: string[] }[] = [];
    const b = await buildEngine(storage, {
      resolveServices: () =>
        makeServices(
          async (context: GenerateContext) => {
            prompts.push({
              step: context.step,
              ids: sessionInputMessages(context.conversation).map(({ id }) => id),
            });
            return { content: 'recovered', toolCalls: [] };
          },
          {
            ...realGate,
            claimPending: async () => {
              const claimed = await realGate.claimPending();
              askedAgain.push(...claimed.map(({ id }) => id));
              return claimed;
            },
          },
        ),
    });
    try {
      const handles = await b.engine.recoverAll();
      await handles[0]!.result();

      // Step 0 is cached, so only step 1 generates, and it holds the input once.
      expect(prompts).toEqual([{ step: 1, ids: ['input-a'] }]);
      const finalRecords = await store.read(SESSION_ID);
      const record = finalRecords[command];
      expect(record?.promotion?.providerTurn).toBe(0);
      expect(askedAgain).toEqual([]);
    } finally {
      b.engine[Symbol.dispose]();
    }
  });
});

function manualTimers() {
  let callback: (() => void) | undefined;
  let intervals = 0;
  const timers: MailboxSessionInputGateTimers = {
    setInterval: (tick) => {
      callback = tick;
      intervals += 1;
      return intervals;
    },
    clearInterval: () => {
      callback = undefined;
    },
  };
  return { timers, tick: () => callback?.(), isRunning: () => callback !== undefined };
}

describe('promotion waits for the step that answers (COR-1476)', () => {
  /** A run that has no prompt of its own, started on a transcript an earlier run left. */
  function startContinuation(engine: TestEngine, services: DurableRunDeps, runId: string) {
    return engine.start(
      'agentRun',
      { runId, sessionId: SESSION_ID, agentName: '' },
      { id: runId, services },
    );
  }

  function continuationServices(
    generate: GenerateFunction,
    gate: SessionInputGate,
    transcript: Conversation,
  ): DurableRunDeps {
    const services = makeServices(generate, gate);
    return {
      ...services,
      options: { ...services.options, conversation: transcript, continuation: true },
    };
  }

  it('does not promote an input whose answering step failed, and the continuation answers it without appending it twice', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const command = await admit(mailbox, 'input-a', 'please answer this');
    const failingGate = gateOver(mailbox, store, 'run-1');

    const { engine, checkpointStore } = await buildEngine(storage);
    try {
      const failing = await startRun(
        engine,
        makeServices(async () => {
          throw new Error('the model is down');
        }, failingGate),
        'run-1',
      );
      await failing.result().catch(() => {});

      // The input was appended and saved, but nothing answered it: not promoted.
      const afterFailure = await store.read(SESSION_ID);
      expect(afterFailure[command]?.runId).toBe('run-1');
      expect(afterFailure[command]?.promotion).toBeUndefined();
      const transcript = await transcriptOf(checkpointStore, 'run-1');
      expect(sessionInputMessages(transcript).map(({ id }) => id)).toEqual(['input-a']);

      // The failed run ends: its terminal reconcile releases what it held.
      await failingGate.dispose?.();
      await store.release(SESSION_ID, 'run-1');

      const prompts: string[][] = [];
      const continuation = await startContinuation(
        engine,
        continuationServices(
          async (context: GenerateContext) => {
            prompts.push(userTexts(context.conversation));
            return { content: 'here is the answer', toolCalls: [] };
          },
          gateOver(mailbox, store, 'run-2'),
          transcript,
        ),
        'run-2',
      );
      await continuation.result();

      // The turn is in the conversation once, and now it is answered and promoted.
      expect(prompts).toEqual([['Start', 'please answer this']]);
      const afterContinuation = await store.read(SESSION_ID);
      expect(afterContinuation[command]?.runId).toBe('run-2');
      expect(afterContinuation[command]?.promotion).toBeDefined();
      expect(await openCount(mailbox)).toBe(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('makes no model call for a continuation whose only input was already promoted', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const kv = kvOver(storage);
    await admit(mailbox, 'input-a', 'answered already');
    const earlier = gateOver(mailbox, store, 'run-1', { timers: manualTimers().timers });
    const [claimed] = await earlier.claimPending();
    // Promoted with its answer, then the process died before acknowledging.
    const key = sessionInputDeliveriesKey(SESSION_ID);
    await kv.set(
      key,
      JSON.stringify(
        planSessionInputPromotion(parseSessionInputDeliveries(await kv.get(key)), 'run-1', [
          {
            id: claimed!.id,
            commandId: claimed!.commandId,
            sessionId: SESSION_ID,
            deliveredAt: new Date(now).toISOString(),
            conversationMessageId: 'message-a',
            providerTurn: 0,
          },
        ]),
      ),
    );
    now += 33_000;
    await newMailbox(storage, () => now).runMaintenance();
    now += 1_000;

    const transcript = new Conversation();
    transcript.appendUserMessage('Start');
    transcript.appendUserMessage('answered already');
    transcript.appendAssistantMessage('and here was the answer');
    let modelCalls = 0;
    const { engine } = await buildEngine(storage);
    try {
      const run = await startContinuation(
        engine,
        continuationServices(
          async () => {
            modelCalls += 1;
            return { content: 'should not happen', toolCalls: [] };
          },
          gateOver(mailbox, store, 'run-2', { now: () => now }),
          transcript,
        ),
        'run-2',
      );
      const result = (await run.result()) as { finishReason: string };

      expect(modelCalls).toBe(0);
      expect(result.finishReason).toBe('stop-condition');
      expect(await openCount(mailbox)).toBe(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it("answers input drained after a step, and promotes it with the step that answers, at that step's turn", async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const command = await (async () => {
      const { engine } = await buildEngine(storage);
      try {
        const handle = await startRun(
          engine,
          makeServices(
            async (context: GenerateContext) => {
              if (context.step === 0) {
                stepZeroStarted.resolve();
                await releaseStepZero.promise;
              }
              return { content: `answer ${context.step}`, toolCalls: [] };
            },
            gateOver(mailbox, store),
          ),
        );
        await stepZeroStarted.promise;
        const id = await admit(mailbox, 'input-a', 'late');
        releaseStepZero.resolve();
        await handle.result();
        return id;
      } finally {
        engine[Symbol.dispose]();
      }
    })();

    // Drained at step 0, answered by step 1: its turn is 1.
    const records = await store.read(SESSION_ID);
    expect(records[command]?.promotion?.providerTurn).toBe(1);
  });
});

describe('session input delivery store and gate (COR-1476)', () => {
  async function leaseExpiry(mailbox: Mailbox): Promise<number | undefined> {
    const [claimed] = await mailbox.list({ states: ['claimed'], limit: 1 });
    return claimed?.visibilityExpiresAt;
  }

  async function until(check: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await check()) return;
      await yieldToPortableEventLoop();
    }
    throw new Error('the condition never became true');
  }

  it('keeps an input with the first run while it renews its lease, and with it after the lease lapses while the owner is live', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const { timers, tick } = manualTimers();
    const runOne = gateOver(mailbox, store, 'run-1', { timers });
    const runTwo = gateOver(mailbox, store, 'run-2');
    await admit(mailbox, 'input-a', 'hello');

    const first = await runOne.claimPending();
    expect(first.map(({ id }) => id)).toEqual(['input-a']);
    const initialExpiry = await leaseExpiry(mailbox);

    // The step, its checkpoint writes and its cursor save take two minutes.
    for (let elapsed = 0; elapsed < 120_000; elapsed += 10_000) {
      now += 10_000;
      tick();
      await until(async () => ((await leaseExpiry(mailbox)) ?? 0) >= now + 20_000);
      expect(await runTwo.claimPending()).toEqual([]);
    }
    expect((await leaseExpiry(mailbox)) ?? 0).toBeGreaterThan(initialExpiry ?? 0);
    await runOne.settle(
      first.map(({ id, commandId }) => ({
        id,
        commandId,
        sessionId: SESSION_ID,
        deliveredAt: new Date(now).toISOString(),
        conversationMessageId: 'message-a',
        providerTurn: 0,
      })),
    );
  });

  it('keeps an input with a live owner after its lease lapses, and releases what it leased', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const { timers } = manualTimers();
    const runOne = gateOver(mailbox, store, 'run-1', { timers });
    const runTwo = gateOver(mailbox, store, 'run-2');
    await admit(mailbox, 'input-a', 'hello');
    await admit(mailbox, 'input-b', 'world');

    const firstClaimed = await runOne.claimPending();
    expect(firstClaimed.map(({ id }) => id)).toEqual(['input-a', 'input-b']);

    // Run one's lease is never renewed here. It lapses; its owner is still live.
    now += 31_000;
    expect(await runTwo.claimPending()).toEqual([]);
    now += 2_000;
    expect(await runTwo.claimPending()).toEqual([]);
    expect(await openCount(mailbox)).toBe(2);
    expect(await mailbox.list({ states: ['claimed'], limit: 10 })).toEqual([]);
    expect(Object.values(await store.read(SESSION_ID)).map((record) => record.runId)).toEqual([
      'run-1',
      'run-1',
    ]);
  });

  it('waits for a crashed owner and takes the input over once the owner is no longer live', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    await admit(mailbox, 'input-a', 'hello');
    const ownerGate = gateOver(mailbox, store, 'run-1', { timers: manualTimers().timers });
    const [claimed] = await ownerGate.claimPending();

    let ownerLive = true;
    const peer = gateOver(mailbox, store, 'run-2', { isOwnerLive: async () => ownerLive });
    now += 33_000;
    expect(await peer.claimPending()).toEqual([]);
    now += 2_000;
    expect(await peer.claimPending()).toEqual([]);

    // The owner is cancelled by recovery: its record can be taken over.
    ownerLive = false;
    now += 2_000;
    const taken = await peer.claimPending();
    expect(taken.map(({ id }) => id)).toEqual(['input-a']);
    const takenRecords = await store.read(SESSION_ID);
    expect(takenRecords[claimed!.commandId]?.runId).toBe('run-2');
  });

  it('does not hand back an input whose lease lapsed while the step holding it is still running', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    // Renewal stalls: this gate's timer never fires.
    const gate = gateOver(mailbox, store, RUN_ID, {
      timers: manualTimers().timers,
      now: () => now,
    });
    await admit(mailbox, 'input-a', 'first');
    const first = await gate.claimPending();
    expect(first.map(({ id }) => id)).toEqual(['input-a']);

    now += 33_000;
    await mailbox.runMaintenance();
    now += 1_000;
    // The step's final-drain ask claims the lapsed command again: it is the same
    // input the step already holds, so it is not returned a second time.
    expect(await gate.claimPending()).toEqual([]);
    // And the gate keeps the new lease for it, so the step can still retire it.
    const [leased] = await mailbox.list({ states: ['claimed'], limit: 1 });
    expect(leased?.commandId).toBe(first[0]!.commandId);
  });

  it('writes records only for the deliverable prefix', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const commandOne = await admit(mailbox, 'input-1', 'one');
    const commandTwo = await admit(mailbox, 'input-2', 'two');
    const commandThree = await admit(mailbox, 'input-3', 'three');
    // Another live run is already delivering the second command.
    await store.claim(SESSION_ID, 'run-1', [commandTwo], alwaysLive);

    const delivered = await gateOver(mailbox, store, 'run-2').claimPending();

    expect(delivered.map(({ id }) => id)).toEqual(['input-1']);
    const records = await store.read(SESSION_ID);
    expect(records[commandOne]?.runId).toBe('run-2');
    expect(records[commandTwo]?.runId).toBe('run-1');
    expect(records[commandThree]).toBeUndefined();
  });

  it('prunes a record only past retention, and by then the mailbox has dead-lettered its command', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const command = await admit(mailbox, 'input-a', 'hello');
    await store.claim(SESSION_ID, 'run-1', [command], alwaysLive);
    const kv = kvOver(storage);
    const key = sessionInputDeliveriesKey(SESSION_ID);
    const claimedRaw = await kv.get(key);
    await kv.set(
      key,
      JSON.stringify(
        planSessionInputPromotion(parseSessionInputDeliveries(claimedRaw), 'run-1', [
          {
            id: 'input-a',
            commandId: command,
            sessionId: SESSION_ID,
            deliveredAt: new Date(now).toISOString(),
            conversationMessageId: 'message-a',
            providerTurn: 0,
          },
        ]),
      ),
    );

    // The same moment every record is written, a claim elsewhere prunes.
    now += RETENTION_MS - 1;
    await store.claim(SESSION_ID, 'run-1', [], alwaysLive);
    expect(Object.keys(await store.read(SESSION_ID))).toEqual([command]);

    now += 2;
    await store.claim(SESSION_ID, 'run-1', ['unrelated'], alwaysLive);
    expect(Object.keys(await store.read(SESSION_ID))).not.toContain(command);

    // The command it described can no longer be claimed by any run.
    await mailbox.runMaintenance();
    expect(await mailbox.claim()).toEqual({ status: 'empty' });
  });

  it('settles by acknowledging only, and a later boundary retires a promoted but unacknowledged command', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const kv = kvOver(storage);
    const before = createMailboxSessionInputGate({
      mailbox,
      decode,
      deliveries: { claim: (ids) => store.claim(SESSION_ID, RUN_ID, ids, alwaysLive) },
      timers: manualTimers().timers,
    });
    await admit(mailbox, 'input-a', 'first');
    const [claimed] = await before.claimPending();

    // Promoted with the transcript, then the process died before acknowledging.
    const key = sessionInputDeliveriesKey(SESSION_ID);
    await kv.set(
      key,
      JSON.stringify(
        planSessionInputPromotion(parseSessionInputDeliveries(await kv.get(key)), RUN_ID, [
          {
            id: claimed!.id,
            commandId: claimed!.commandId,
            sessionId: SESSION_ID,
            deliveredAt: new Date(now).toISOString(),
            conversationMessageId: 'message-a',
            providerTurn: 3,
          },
        ]),
      ),
    );
    expect(await openCount(mailbox)).toBe(1);

    const after = gateOver(mailbox, store, 'run-2');
    now += 33_000;
    expect(await after.claimPending()).toEqual([]);
    now += 2_000;
    expect(await after.claimPending()).toEqual([]);
    expect(await openCount(mailbox)).toBe(0);

    // Settling writes nothing durable.
    const valueBefore = await kv.get(key);
    await after.settle([]);
    expect(await kv.get(key)).toBe(valueBefore);
  });

  it('never delivers an input out of order while an earlier one is leased', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const owner = gateOver(mailbox, store, 'run-1', { timers: manualTimers().timers });
    await admit(mailbox, 'input-a', 'first');
    const claimedFirst = await owner.claimPending();
    expect(claimedFirst.map(({ id }) => id)).toEqual(['input-a']);

    await admit(mailbox, 'input-b', 'second');
    expect(await gateOver(mailbox, store, 'run-2').claimPending()).toEqual([]);
    // The holder itself may ask again, as the final-step ask does.
    const again = await owner.claimPending();
    expect(again.map(({ id }) => id)).toEqual(['input-b']);
  });

  it("delivers a caller's reused input id as a new input once the mailbox retired the first record", async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const gate = gateOver(mailbox, store, RUN_ID, { timers: manualTimers().timers });
    const firstCommand = await admit(mailbox, 'input-a', 'first');
    const [first] = await gate.claimPending();
    const kv = kvOver(storage);
    const key = sessionInputDeliveriesKey(SESSION_ID);
    await kv.set(
      key,
      JSON.stringify(
        planSessionInputPromotion(parseSessionInputDeliveries(await kv.get(key)), RUN_ID, [
          {
            id: first!.id,
            commandId: first!.commandId,
            sessionId: SESSION_ID,
            deliveredAt: new Date(now).toISOString(),
            conversationMessageId: 'message-a',
            providerTurn: 0,
          },
        ]),
      ),
    );
    await gate.settle([
      {
        id: first!.id,
        commandId: first!.commandId,
        sessionId: SESSION_ID,
        deliveredAt: new Date(now).toISOString(),
        conversationMessageId: 'message-a',
        providerTurn: 0,
      },
    ]);

    now += 2 * DAY_MS;
    await mailbox.runMaintenance();
    const secondCommand = await admit(mailbox, 'input-a', 'something new');
    expect(secondCommand).not.toBe(firstCommand);

    const reused = await gate.claimPending();
    expect(reused.map(({ id, commandId, payload }) => [id, commandId, payload])).toEqual([
      ['input-a', secondCommand, 'something new'],
    ]);
  });

  it('rejects a malformed input without retry and still delivers the one behind it', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const gate = gateOver(mailbox, deliveryStoreOver(storage));
    await mailbox.admit({
      caller: 'alice',
      target: SESSION_ID,
      kind: 'session-input:steer',
      payload: { form: 'inline', value: { payload: 42 } },
      idempotencyKey: 'poison',
    });
    await admit(mailbox, 'input-b', 'fine');

    const delivered = await gate.claimPending();
    expect(delivered.map(({ id }) => id)).toEqual(['input-b']);
    const [poison] = await mailbox.list({ states: ['rejected'], limit: 10 });
    expect(poison?.idempotencyKey).toBe('poison');
  });

  it('keeps renewing until the lease is acknowledged or the gate is disposed, then leaves nothing running', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const { timers, isRunning } = manualTimers();
    const gate = gateOver(mailbox, store, RUN_ID, { timers });
    await admit(mailbox, 'input-a', 'first');
    const claimed = await gate.claimPending();
    expect(isRunning()).toBe(true);

    await gate.dispose?.();
    expect(isRunning()).toBe(false);
    // The lease went back to the mailbox for whoever reaches a boundary next.
    const [receipt] = await mailbox.list({ limit: 10 });
    expect(receipt?.state).not.toBe('claimed');
    expect(claimed).toHaveLength(1);
  });

  it('acknowledges from cancellation-requested, and never claims a command past its deadline', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const commandId = await admit(mailbox, 'input-a', 'first');
    const claimResult = await mailbox.claim();
    if (claimResult.status !== 'claimed') throw new Error('expected a claim');
    await mailbox.requestCancellation({ commandId, reason: 'test' });
    const settled = await mailbox.acknowledge({
      commandId,
      attemptToken: claimResult.claim.attemptToken,
    });
    expect(settled.status).toBe('settled');

    await admit(mailbox, 'input-b', 'second');
    now += 8 * DAY_MS;
    await mailbox.runMaintenance();
    expect(await mailbox.claim()).toEqual({ status: 'empty' });
  });
});

type StorageKind = 'sqlite' | 'lmdb';

describe.each<StorageKind>(['sqlite', 'lmdb'])(
  'session input across a restart on %s (COR-1476)',
  (kind) => {
    let directory: string | undefined;
    afterEach(async () => {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    });

    it('delivers inputs admitted before a crash in order, exactly once, after recovery', async () => {
      directory = await mkdtemp(join(tmpdir(), `corvidae-session-input-${kind}-`));
      const configuration =
        kind === 'sqlite'
          ? ({ type: 'sqlite', path: join(directory, 'weft.sqlite') } as const)
          : ({ type: 'lmdb', path: join(directory, 'weft-lmdb') } as const);

      // Engine A: step 0 commits, step 1 starts and hangs. While it hangs, two
      // inputs are admitted, then the process "crashes".
      const storageA = await resolveStorage(configuration);
      const mailboxA = newMailbox(storageA);
      const stepOneStarted = deferred();
      const a = await buildEngine(storageA);
      const handleA = await startRun(
        a.engine,
        makeServices(
          async (context: GenerateContext) => {
            if (context.step === 0) {
              return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            stepOneStarted.resolve();
            return new Promise<never>(() => {});
          },
          gateOver(mailboxA, deliveryStoreOver(storageA)),
        ),
      );
      void handleA.result().catch(() => {});
      await stepOneStarted.promise;
      const commandA = await admit(mailboxA, 'input-a', 'first');
      const commandB = await admit(mailboxA, 'input-b', 'second');
      a.engine[Symbol.dispose]();
      mailboxA.dispose();
      storageA[Symbol.dispose]();

      // Engine B: a fresh process on the same backend recovers the run.
      const storageB = await resolveStorage(configuration);
      const mailboxB = newMailbox(storageB);
      const store = deliveryStoreOver(storageB);
      const generatedPrompts: { step: number; conversation: Conversation }[] = [];
      const b = await buildEngine(storageB, {
        resolveServices: () =>
          makeServices(
            async (context: GenerateContext) => {
              generatedPrompts.push({ step: context.step, conversation: context.conversation });
              return { content: 'recovered', toolCalls: [] };
            },
            gateOver(mailboxB, store),
          ),
      });
      try {
        const handles = await b.engine.recoverAll();
        expect(handles).toHaveLength(1);
        const result = (await handles[0]!.result()) as { steps: number };

        expect(result.steps).toBe(2);
        expect(generatedPrompts.map(({ step }) => step)).toEqual([1]);
        const conversation = generatedPrompts[0]!.conversation;
        expect(userTexts(conversation)).toEqual(['Start', 'first', 'second']);

        const delivered = sessionInputMessages(conversation);
        expect(delivered.map(({ id }) => id)).toEqual(['input-a', 'input-b']);
        const records = await store.read(SESSION_ID);
        for (const [index, { messageId }] of delivered.entries()) {
          const record = records[[commandA, commandB][index]!];
          expect(record?.promotion?.conversationMessageId).toBe(messageId);
          expect(record?.promotion?.providerTurn).toBe(1);
        }
        expect(await openCount(mailboxB)).toBe(0);
      } finally {
        b.engine[Symbol.dispose]();
        mailboxB.dispose();
        storageB[Symbol.dispose]();
      }
    });
  },
);
