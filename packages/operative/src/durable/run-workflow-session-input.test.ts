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
import { Conversation, createConversationHistory, type MessageInput } from 'conversationalist';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { awakeTurns } from '@lostgradient/testing/wait-until';
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

describe('promotion commits with the step that appends (COR-1476)', () => {
  it('leaves an input promoted, under its own id, when the step that appended it fails', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const command = await admit(mailbox, 'input-a', 'please answer this');

    const { engine, checkpointStore } = await buildEngine(storage);
    try {
      const failing = await startRun(
        engine,
        makeServices(
          async () => {
            throw new Error('the model is down');
          },
          gateOver(mailbox, store, 'run-1'),
        ),
        'run-1',
      );
      await failing.result().catch(() => {});

      // The boundary appended the turn before the step generated, and the
      // step's own checkpoint write promoted it: the turn is part of the
      // conversation however the step ended.
      const records = await store.read(SESSION_ID);
      expect(records[command]?.runId).toBe('run-1');
      expect(records[command]?.promotion?.providerTurn).toBe(0);
      const transcript = await transcriptOf(checkpointStore, 'run-1');
      expect(sessionInputMessages(transcript)).toEqual([{ id: 'input-a', messageId: 'input-a' }]);
      expect(records[command]?.promotion?.conversationMessageId).toBe('input-a');
      expect(await openCount(mailbox)).toBe(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('gives a reused input id a fresh message id once the earlier turn is in the transcript', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const first = await admit(mailbox, 'input-a', 'the first time');
    const prompts: string[][] = [];
    const generate = async (context: GenerateContext) => {
      prompts.push(userTexts(context.conversation));
      return { content: 'answered', toolCalls: [] };
    };

    const { engine, checkpointStore } = await buildEngine(storage);
    try {
      const run1 = await startRun(
        engine,
        makeServices(generate, gateOver(mailbox, store, 'run-1', { now: () => now })),
        'run-1',
      );
      await run1.result();
      const afterFirst = await transcriptOf(checkpointStore, 'run-1');
      expect(sessionInputMessages(afterFirst)).toEqual([{ id: 'input-a', messageId: 'input-a' }]);

      // The mailbox retires its record, and the caller submits a new input under
      // the same id. Its turn joins a transcript that already holds a message
      // with that id, so it takes a fresh one rather than failing the step.
      now += 2 * DAY_MS;
      await mailbox.runMaintenance();
      const second = await admit(mailbox, 'input-a', 'the second time');
      expect(second).not.toBe(first);
      const services = makeServices(
        generate,
        gateOver(mailbox, store, 'run-2', { now: () => now }),
      );
      services.options = { ...services.options, conversation: afterFirst };
      const run2 = await engine.start(
        'agentRun',
        { runId: 'run-2', sessionId: SESSION_ID, agentName: '' },
        { id: 'run-2', services },
      );
      await run2.result();

      expect(prompts).toEqual([
        ['Start', 'the first time'],
        ['Start', 'the first time', 'the second time'],
      ]);
      const delivered = sessionInputMessages(await transcriptOf(checkpointStore, 'run-2'));
      expect(delivered.map(({ id }) => id)).toEqual(['input-a', 'input-a']);
      expect(delivered[0]?.messageId).toBe('input-a');
      expect(delivered[1]?.messageId).not.toBe('input-a');
      const records = await store.read(SESSION_ID);
      expect(records[second]?.promotion?.conversationMessageId).toBe(delivered[1]?.messageId);
      expect(await openCount(mailbox)).toBe(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('counts a hidden message under the input id, and takes a fresh id for the turn', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const store = deliveryStoreOver(storage);
    const command = await admit(mailbox, 'input-a', 'visible now');
    const transcript = new Conversation();
    transcript.appendUserMessage('Start');
    const hidden: MessageInput & { readonly id: string } = {
      role: 'user',
      content: 'hidden',
      hidden: true,
      id: 'input-a',
    };
    transcript.appendMessages(hidden);

    const { engine, checkpointStore } = await buildEngine(storage);
    try {
      const services = makeServices(
        async () => ({ content: 'answered', toolCalls: [] }),
        gateOver(mailbox, store),
      );
      services.options = { ...services.options, conversation: transcript };
      const handle = await engine.start(
        'agentRun',
        { runId: RUN_ID, sessionId: SESSION_ID, agentName: '' },
        { id: RUN_ID, services },
      );
      await handle.result();

      const saved = await transcriptOf(checkpointStore);
      const [delivered] = sessionInputMessages(saved);
      expect(delivered?.id).toBe('input-a');
      expect(delivered?.messageId).not.toBe('input-a');
      const records = await store.read(SESSION_ID);
      expect(records[command]?.promotion?.conversationMessageId).toBe(delivered?.messageId);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it("promotes input drained after a step with that step's write, at the answering step's turn", async () => {
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
    for await (const attempt of awakeTurns()) {
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

  it('tolerates a failure to retire a promoted command, and leaves it for the next boundary', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const real = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const kv = kvOver(storage);
    await admit(real, 'input-a', 'first');
    const [claimed] = await gateOver(real, store, 'run-1', {
      timers: manualTimers().timers,
    }).claimPending();
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
    await real.runMaintenance();
    now += 1_000;

    // Retiring the promoted command fails once.
    const errors: unknown[] = [];
    let failures = 1;
    const flaky = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'acknowledge') {
          return async (...args: Parameters<Mailbox['acknowledge']>) => {
            if (failures > 0) {
              failures -= 1;
              throw new Error('storage unavailable');
            }
            return target.acknowledge(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const gate = createMailboxSessionInputGate({
      mailbox: flaky,
      decode,
      deliveries: { claim: (ids) => store.claim(SESSION_ID, 'run-2', ids, alwaysLive) },
      now: () => now,
      onError: (error) => errors.push(error),
    });
    expect(await gate.claimPending()).toEqual([]);
    expect(errors).toHaveLength(1);

    // The command is still open and leased; once the lease lapses the next boundary retires it.
    now += 33_000;
    await real.runMaintenance();
    now += 1_000;
    expect(await gate.claimPending()).toEqual([]);
    expect(await openCount(real)).toBe(0);
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

describe("the gate's lease lifecycle (COR-1476)", () => {
  async function stateOf(mailbox: Mailbox, commandId?: string): Promise<string | undefined> {
    const receipts = await mailbox.list({ limit: 20 });
    const receipt =
      commandId === undefined
        ? receipts[0]
        : receipts.find((entry) => entry.commandId === commandId);
    return receipt?.state;
  }

  async function until(check: () => Promise<boolean>): Promise<void> {
    for await (const attempt of awakeTurns()) {
      if (await check()) return;
      await yieldToPortableEventLoop();
    }
    throw new Error('the condition never became true');
  }

  async function settled(mailbox: Mailbox): Promise<void> {
    await until(async () => (await stateOf(mailbox)) !== 'claimed');
  }

  const delivery = (id: string, commandId: string, now: number) => ({
    id,
    commandId,
    sessionId: SESSION_ID,
    deliveredAt: new Date(now).toISOString(),
    conversationMessageId: `message-${id}`,
    providerTurn: 0,
  });

  /** The checkpoint write that promotes a delivered input, outside a workflow. */
  async function promote(
    storage: Storage,
    runId: string,
    id: string,
    commandId: string,
    now: number,
  ) {
    const kv = kvOver(storage);
    const key = sessionInputDeliveriesKey(SESSION_ID);
    await kv.set(
      key,
      JSON.stringify(
        planSessionInputPromotion(parseSessionInputDeliveries(await kv.get(key)), runId, [
          delivery(id, commandId, now),
        ]),
      ),
    );
  }

  /** A mailbox whose next `failures.count` acknowledgements throw. */
  function flakyAcknowledge(real: Mailbox, failures: { count: number }): Mailbox {
    return new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'acknowledge') {
          return async (...args: Parameters<Mailbox['acknowledge']>) => {
            if (failures.count > 0) {
              failures.count -= 1;
              throw new Error('storage unavailable');
            }
            return target.acknowledge(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('keeps a lease whose cancellation renewal reports, and lets the acknowledgement after promotion close it as cancelled', async () => {
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const { timers, tick } = manualTimers();
    const gate = gateOver(mailbox, store, RUN_ID, { timers, now: () => now });
    const commandId = await admit(mailbox, 'input-a', 'cancel me');
    const [claimed] = await gate.claimPending();
    expect(claimed?.commandId).toBe(commandId);

    // The turn is appended in the same turn as the claim. Another process then
    // cancels the command; the gate learns of it through its renewal, which
    // changes nothing: the lease stands until the step's checkpoint commits.
    const other = newMailbox(storage, () => now);
    const requested = await other.requestCancellation({ commandId, reason: 'elsewhere' });
    expect(requested.status).toBe('requested');
    tick();
    await yieldToPortableEventLoop();
    await yieldToPortableEventLoop();
    expect(await stateOf(mailbox)).toBe('cancellation-requested');

    // The checkpoint promotes the turn; the acknowledgement closes the command
    // as cancelled, and the promotion record is what the receipt reads.
    await promote(storage, RUN_ID, 'input-a', commandId, now);
    await gate.settle([delivery('input-a', commandId, now)]);
    expect(await stateOf(mailbox)).toBe('cancelled');
    const records = await store.read(SESSION_ID);
    expect(records[commandId]?.promotion).toBeDefined();
    expect(await gate.claimPending()).toEqual([]);
    await gate.dispose?.();
    expect(await stateOf(mailbox)).toBe('cancelled');
  });

  it('does not hand back an input whose cancellation landed between the claim and the return', async () => {
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const commandId = await admit(mailbox, 'input-a', 'cancel me');
    // The cancellation lands while the delivery record is being written.
    const gate = createMailboxSessionInputGate({
      mailbox,
      decode,
      deliveries: {
        claim: async (commandIds) => {
          await newMailbox(storage, () => now).requestCancellation({
            commandId,
            reason: 'elsewhere',
          });
          return store.claim(SESSION_ID, RUN_ID, commandIds, alwaysLive);
        },
      },
      timers: manualTimers().timers,
      now: () => now,
    });

    expect(await gate.claimPending()).toEqual([]);
    expect(await stateOf(mailbox)).toBe('cancelled');
    await gate.dispose?.();
  });

  it('keeps a lease whose cancellation it could not settle, and closes it at the next boundary before delivering what follows', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const real = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const commandA = await admit(real, 'input-a', 'cancel me');
    // The cancellation lands between the claim and the return, and the
    // rejection that would settle it fails once.
    let rejectFailures = 1;
    const errors: unknown[] = [];
    const flaky = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'reject') {
          return async (...args: Parameters<Mailbox['reject']>) => {
            if (rejectFailures > 0) {
              rejectFailures -= 1;
              throw new Error('storage unavailable');
            }
            return target.reject(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const gate = createMailboxSessionInputGate({
      mailbox: flaky,
      decode,
      deliveries: {
        claim: async (ids) => {
          await newMailbox(storage, () => now).requestCancellation({
            commandId: commandA,
            reason: 'elsewhere',
          });
          return store.claim(SESSION_ID, RUN_ID, ids, alwaysLive);
        },
      },
      timers: manualTimers().timers,
      now: () => now,
      onError: (error) => errors.push(error),
    });
    expect(await gate.claimPending()).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(await stateOf(real, commandA)).toBe('cancellation-requested');

    // The lease is still the gate's, so the next boundary closes it and then
    // delivers the input behind it.
    const commandB = await admit(real, 'input-b', 'second');
    now += 1_000;
    const next = await gate.claimPending();
    expect(await stateOf(real, commandA)).toBe('cancelled');
    expect(next.map(({ commandId }) => commandId)).toEqual([commandB]);
    await gate.dispose?.();
    const receipts = await real.list({ limit: 10 });
    expect(receipts.map((receipt) => receipt.state)).not.toContain('claimed');
  });

  it('releases what it leased when disposal lands during its end-of-claim re-read, and returns nothing', async () => {
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const real = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const commandA = await admit(real, 'input-a', 'first');
    const reached = deferred();
    const held = deferred();
    const holding = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'receipt') {
          return async (commandId: string) => {
            reached.resolve();
            await held.promise;
            return target.receipt(commandId);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const gate = createMailboxSessionInputGate({
      mailbox: holding,
      decode,
      deliveries: { claim: (ids) => store.claim(SESSION_ID, RUN_ID, ids, alwaysLive) },
      timers: manualTimers().timers,
      now: () => now,
    });
    const claiming = gate.claimPending();
    await reached.promise;
    await gate.dispose?.();
    held.resolve();

    expect(await claiming).toEqual([]);
    expect(await stateOf(real, commandA)).toBe('accepted');
  });

  it('still sees a foreign lease on the oldest command when newer commands land between its open count and its first page', async () => {
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const real = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const commandA = await admit(real, 'input-a', 'first');
    const leased = await real.claim(); // another gate's lease on the oldest command
    if (leased.status !== 'claimed') throw new Error('expected a claim');
    expect(leased.claim.receipt.commandId).toBe(commandA);
    await admit(real, 'input-b', 'second');
    // After the gate reads its open count (2), three more commands are admitted
    // before its first listing page. Walking newest first, it must not count
    // them toward that open count, or it would stop before reaching A.
    let bursts = 1;
    const bursting = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'capacity') {
          return async () => {
            const snapshot = await target.capacity();
            if (bursts > 0) {
              bursts -= 1;
              for (const id of ['input-c', 'input-d', 'input-e']) await admit(real, id, id);
            }
            return snapshot;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const gate = createMailboxSessionInputGate({
      mailbox: bursting,
      decode,
      deliveries: { claim: (ids) => store.claim(SESSION_ID, 'run-ours', ids, alwaysLive) },
      timers: manualTimers().timers,
      now: () => now,
    });
    const claimed = await gate.claimPending();
    await gate.dispose?.();
    // A is leased elsewhere, so nothing behind it may be delivered yet.
    expect(claimed.map(({ id }) => id)).toEqual([]);
  });

  it('releases a claim it acquired while it was being disposed, and returns nothing', async () => {
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    await admit(mailbox, 'input-a', 'first');
    // The delivery record write is held: disposal lands while the claim is in flight.
    const reached = deferred();
    const proceed = deferred();
    const gate = createMailboxSessionInputGate({
      mailbox,
      decode,
      deliveries: {
        claim: async (commandIds) => {
          reached.resolve();
          await proceed.promise;
          return store.claim(SESSION_ID, RUN_ID, commandIds, alwaysLive);
        },
      },
      timers: manualTimers().timers,
      now: () => now,
    });
    const claiming = gate.claimPending();
    await reached.promise;
    expect(await stateOf(mailbox)).toBe('claimed');
    await gate.dispose?.();
    proceed.resolve();

    expect(await claiming).toEqual([]);
    await settled(mailbox);
    expect(await stateOf(mailbox)).toBe('accepted');
  });

  it('releases what it leased when disposal lands while it retires a promoted command ahead of a fresh one', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const real = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const commandA = await admit(real, 'input-a', 'first');
    // A was delivered and promoted by an earlier run that died before acknowledging.
    const earlier = gateOver(real, store, 'run-earlier', {
      timers: manualTimers().timers,
      now: () => now,
    });
    await earlier.claimPending();
    await promote(storage, 'run-earlier', 'input-a', commandA, now);
    await earlier.dispose?.();
    now += 1_000;
    const commandB = await admit(real, 'input-b', 'second');
    const ackReached = deferred();
    const ackHeld = deferred();
    const holding = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'acknowledge') {
          return async (...args: Parameters<Mailbox['acknowledge']>) => {
            ackReached.resolve();
            await ackHeld.promise;
            return target.acknowledge(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const gate = createMailboxSessionInputGate({
      mailbox: holding,
      decode,
      deliveries: { claim: (ids) => store.claim(SESSION_ID, RUN_ID, ids, alwaysLive) },
      timers: manualTimers().timers,
      now: () => now,
    });
    const claiming = gate.claimPending();
    await ackReached.promise;
    await gate.dispose?.();
    ackHeld.resolve();

    expect(await claiming).toEqual([]);
    // The lease on A was in the table while its acknowledgement was in flight,
    // so disposal released it like any other: A is still promoted, and the
    // next boundary on the session retires it before delivering B.
    expect(await stateOf(real, commandA)).toBe('accepted');
    expect(await stateOf(real, commandB)).toBe('accepted');
    now += 1_000;
    // The ended run is not live, so its delivery claim on B lapses to the next run.
    const next = gateOver(real, store, 'run-next', {
      timers: manualTimers().timers,
      now: () => now,
      isOwnerLive: () => Promise.resolve(false),
    });
    const delivered = await next.claimPending();
    expect(delivered.map(({ commandId }) => commandId)).toEqual([commandB]);
    expect(await stateOf(real, commandA)).toBe('applied');
    await next.dispose?.();
  });

  it('retries a failed acknowledgement at its next boundary, so a peer can claim what follows', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const real = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const commandA = await admit(real, 'input-a', 'first');
    const failures = { count: 1 };
    const errors: unknown[] = [];
    const gate = createMailboxSessionInputGate({
      mailbox: flakyAcknowledge(real, failures),
      decode,
      deliveries: { claim: (ids) => store.claim(SESSION_ID, 'run-a', ids, alwaysLive) },
      timers: manualTimers().timers,
      now: () => now,
      onError: (error) => errors.push(error),
    });
    const [claimed] = await gate.claimPending();
    await promote(storage, 'run-a', 'input-a', commandA, now);
    await gate.settle([delivery('input-a', claimed!.commandId, now)]);
    expect(errors).toHaveLength(1);
    expect(await stateOf(real, commandA)).toBe('claimed');

    // The next boundary retires it before it looks for new input.
    now += 1_000;
    expect(await gate.claimPending()).toEqual([]);
    expect(await stateOf(real, commandA)).toBe('applied');

    // Nothing of this run's stands in a peer's way.
    const commandB = await admit(real, 'input-b', 'second');
    const peer = gateOver(real, store, 'run-b', { timers: manualTimers().timers, now: () => now });
    const peerClaimed = await peer.claimPending();
    expect(peerClaimed.map(({ commandId }) => commandId)).toEqual([commandB]);
    await peer.dispose?.();
    await gate.dispose?.();
  });

  it('retries the retirement of a promoted command it reclaimed, when that acknowledgement failed', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const real = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const commandA = await admit(real, 'input-a', 'first');
    // Promoted by an earlier run that died before acknowledging.
    const earlier = gateOver(real, store, 'run-earlier', {
      timers: manualTimers().timers,
      now: () => now,
    });
    await earlier.claimPending();
    await promote(storage, 'run-earlier', 'input-a', commandA, now);
    await earlier.dispose?.();
    now += 1_000;
    const failures = { count: 1 };
    const errors: unknown[] = [];
    const gate = createMailboxSessionInputGate({
      mailbox: flakyAcknowledge(real, failures),
      decode,
      deliveries: { claim: (ids) => store.claim(SESSION_ID, RUN_ID, ids, alwaysLive) },
      timers: manualTimers().timers,
      now: () => now,
      onError: (error) => errors.push(error),
    });
    expect(await gate.claimPending()).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(await stateOf(real, commandA)).toBe('claimed');

    now += 1_000;
    expect(await gate.claimPending()).toEqual([]);
    expect(await stateOf(real, commandA)).toBe('applied');
    await gate.dispose?.();
  });

  it('keeps a lease whose acknowledgement failed, so disposal releases it', async () => {
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const real = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const commandId = await admit(real, 'input-a', 'first');
    const errors: unknown[] = [];
    const gate = createMailboxSessionInputGate({
      mailbox: flakyAcknowledge(real, { count: 1 }),
      decode,
      deliveries: { claim: (ids) => store.claim(SESSION_ID, RUN_ID, ids, alwaysLive) },
      timers: manualTimers().timers,
      now: () => now,
      onError: (error) => errors.push(error),
    });
    const [claimed] = await gate.claimPending();
    await gate.settle([delivery('input-a', claimed!.commandId, now)]);
    expect(errors).toHaveLength(1);
    expect(await stateOf(real)).toBe('claimed');

    // The gate still holds the lease, so disposing it returns the command.
    await gate.dispose?.();
    expect(await stateOf(real)).toBe('accepted');
    expect(commandId).toBe(claimed!.commandId);
  });

  it('still disposes on its abort signal after a settle emptied its table', async () => {
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const controller = new AbortController();
    const gate = createMailboxSessionInputGate({
      mailbox,
      decode,
      deliveries: { claim: (ids) => store.claim(SESSION_ID, RUN_ID, ids, alwaysLive) },
      timers: manualTimers().timers,
      now: () => now,
      signal: controller.signal,
    });
    const commandA = await admit(mailbox, 'input-a', 'first');
    const [a] = await gate.claimPending();
    await gate.settle([delivery('input-a', a!.commandId, now)]);
    const commandB = await admit(mailbox, 'input-b', 'second');
    const [b] = await gate.claimPending();
    expect(b?.commandId).toBe(commandB);

    // The run is aborted: the gate releases B, as it would have before A settled.
    controller.abort();
    await until(async () => (await stateOf(mailbox, commandB)) !== 'claimed');
    expect(await stateOf(mailbox, commandA)).toBe('applied');
    expect(await stateOf(mailbox, commandB)).toBe('accepted');
    await gate.dispose?.();
  });

  it('leaves no lease claimed once dispose() resolves: acknowledged, released, or cancelled', async () => {
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const store = deliveryStoreOver(storage, () => now);
    const { timers, tick } = manualTimers();
    const gate = gateOver(mailbox, store, RUN_ID, { timers, now: () => now });
    const commandA = await admit(mailbox, 'input-a', 'acknowledged');
    const commandB = await admit(mailbox, 'input-b', 'cancelled elsewhere');
    const commandC = await admit(mailbox, 'input-c', 'released');
    const claimed = await gate.claimPending();
    expect(claimed.map(({ commandId }) => commandId)).toEqual([commandA, commandB, commandC]);

    // A is acknowledged by the step; B is cancelled by another holder, which
    // renewal reports and the gate keeps; C is left for disposal.
    await gate.settle([delivery('input-a', commandA, now)]);
    await newMailbox(storage, () => now).requestCancellation({
      commandId: commandB,
      reason: 'elsewhere',
    });
    tick();
    await yieldToPortableEventLoop();
    await yieldToPortableEventLoop();
    expect(await stateOf(mailbox, commandB)).toBe('cancellation-requested');
    await gate.dispose?.();

    const receipts = await mailbox.list({ limit: 10 });
    const states = new Map(receipts.map((receipt) => [receipt.commandId, receipt.state]));
    expect(states.get(commandA)).toBe('applied');
    expect(states.get(commandB)).toBe('cancelled');
    expect(states.get(commandC)).toBe('accepted');
    expect([...states.values()]).not.toContain('claimed');
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
