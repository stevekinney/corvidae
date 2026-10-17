import {
  type ApplicationCommandClaim,
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
import type { Conversation } from 'conversationalist';
import { createConversationHistory } from 'conversationalist';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import type { GenerateContext, GenerateFunction } from '../types';
import { createCheckpointStore } from './checkpoint-store';
import {
  createMailboxSessionInputGate,
  type DecodedSessionInput,
  type MailboxSessionInputGateTimers,
  type SessionInputDeliveryClaim,
  type SessionInputDeliveryStore,
} from './mailbox-session-input-gate';
import { createRunWorkflow } from './run-workflow';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps, SessionInputDelivery, SessionInputGate } from './types';

/**
 * COR-1476 — session input admitted while a durable run is live reaches the run
 * at its next step boundary, in admission order, exactly once, across a restart
 * and across concurrent runs.
 *
 * The gate under test is the real mailbox-backed one. Bureau supplies the
 * delivery store from its session store; here it is a small durable record in
 * the same backend, which is all the gate needs.
 */

const SESSION_ID = 'session-1';
const RUN_ID = 'run-session-input-1';
const DAY_MS = 86_400_000;

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

afterEach(async () => {
  await yieldToPortableEventLoop();
});

function newMailbox(storage: Storage, now?: () => number, commandTimeoutMs?: number): Mailbox {
  return new Mailbox({
    storage,
    namespace: 'test.session-input',
    resourceId: SESSION_ID,
    ...(now === undefined ? {} : { now }),
    ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
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

interface DeliveryRecord {
  owner: string;
  promotion?: { conversationMessageId: string; providerTurn: number };
}

function deliveryStoreOver(storage: Storage): SessionInputDeliveryStore & {
  read(commandId: string): Promise<DeliveryRecord | undefined>;
} {
  const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
  const key = (commandId: string) => `test:delivery:${commandId}`;
  async function read(commandId: string): Promise<DeliveryRecord | undefined> {
    const raw = await kv.get(key(commandId));
    return raw === null ? undefined : (JSON.parse(raw) as DeliveryRecord);
  }
  return {
    read,
    async claim(owner, commandIds) {
      const outcomes = new Map<string, SessionInputDeliveryClaim>();
      for (const commandId of commandIds) {
        const record = await read(commandId);
        if (record === undefined) {
          await kv.conditionalBatch(
            [{ key: key(commandId), expectedValue: null }],
            [{ type: 'set', key: key(commandId), value: JSON.stringify({ owner }) }],
          );
          outcomes.set(commandId, 'claimed');
        } else if (record.promotion !== undefined) {
          outcomes.set(commandId, 'promoted');
        } else {
          outcomes.set(commandId, record.owner === owner ? 'owned' : 'foreign');
        }
      }
      return outcomes;
    },
    async promote(deliveries: readonly SessionInputDelivery[]) {
      for (const delivery of deliveries) {
        const record = await read(delivery.commandId);
        if (record?.promotion !== undefined) continue;
        await kv.set(
          key(delivery.commandId),
          JSON.stringify({
            owner: record?.owner ?? 'unknown',
            promotion: {
              conversationMessageId: delivery.conversationMessageId,
              providerTurn: delivery.providerTurn,
            },
          }),
        );
      }
    },
  };
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
      ...(gate === undefined ? {} : { sessionInput: gate }),
    },
  };
}

async function buildEngine(storage: Storage, resolveServices?: () => DurableRunDeps) {
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const activities = createStorageActivities(checkpointStore);
  return Engine.create({
    storage,
    recover: false,
    ...(resolveServices === undefined
      ? {}
      : {
          resolveWorkflowServices: () => ({
            status: 'available' as const,
            services: resolveServices(),
          }),
        }),
    workflows: { agentRun: createRunWorkflow(checkpointStore) },
    activities: {
      saveCursor: activities.saveCursor,
      saveConversation: activities.saveConversation,
      recordStep: activities.recordStep,
    },
  });
}

type TestEngine = Awaited<ReturnType<typeof buildEngine>>;

function startRun(engine: TestEngine, services: DurableRunDeps) {
  return engine.start(
    'agentRun',
    { runId: RUN_ID, sessionId: SESSION_ID, agentName: '', prompt: 'Start' },
    { id: RUN_ID, services },
  );
}

function gateOver(storage: Storage, mailbox: Mailbox, owner = RUN_ID): SessionInputGate {
  return createMailboxSessionInputGate({
    mailbox,
    owner,
    decode,
    deliveries: deliveryStoreOver(storage),
  });
}

function deferred<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

describe('session input at the durable step boundary (COR-1476)', () => {
  it('shows input admitted during a step to the model on the next step', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const prompts: string[][] = [];

    const engine = await buildEngine(storage);
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
          gateOver(storage, mailbox),
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

  it('delivers two inputs in admission order, once each, and promotes them', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const deliveries = deliveryStoreOver(storage);
    const gate = createMailboxSessionInputGate({
      mailbox,
      owner: RUN_ID,
      decode,
      deliveries,
    });
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const prompts: string[][] = [];
    const seen: Conversation[] = [];

    const engine = await buildEngine(storage);
    try {
      const handle = await startRun(
        engine,
        makeServices(async (context: GenerateContext) => {
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
        }, gate),
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
      const commandIds = [commandA, commandB];
      for (const [index, { messageId }] of delivered.entries()) {
        const record = await deliveries.read(commandIds[index]!);
        expect(record?.owner).toBe(RUN_ID);
        expect(record?.promotion).toEqual({ conversationMessageId: messageId, providerTurn: 1 });
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

    const engine = await buildEngine(storage);
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
          gateOver(storage, mailbox),
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

  it('delivers nothing to a run that has no session input gate', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    await admit(mailbox, 'input-a', 'ignored');
    const engine = await buildEngine(storage);
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

describe('a crash between a delivering step and its settlement (COR-1476)', () => {
  /** Runs step 0 to completion, delivers an input at step 1, and "crashes" as step 1 settles. */
  async function crashWhileSettling(storage: Storage) {
    const mailbox = newMailbox(storage);
    const deliveries = deliveryStoreOver(storage);
    const real = createMailboxSessionInputGate({ mailbox, owner: RUN_ID, decode, deliveries });
    const settleStarted = deferred();
    const gate: SessionInputGate = {
      claimPending: () => real.claimPending(),
      settle: () => {
        settleStarted.resolve();
        return new Promise<void>(() => {});
      },
    };
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const engine = await buildEngine(storage);
    const handle = await startRun(
      engine,
      makeServices(async (context: GenerateContext) => {
        if (context.step === 0) {
          stepZeroStarted.resolve();
          await releaseStepZero.promise;
          return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        return { content: 'step 1', toolCalls: [{ name: 'next', arguments: {} }] };
      }, gate),
    );
    void handle.result().catch(() => {});
    await stepZeroStarted.promise;
    const commandId = await admit(mailbox, 'input-a', 'first');
    releaseStepZero.resolve();
    await settleStarted.promise;
    engine[Symbol.dispose]();
    return { commandId, deliveries };
  }

  it('does not append the input again on replay, and the promotion lands', async () => {
    const storage = new MemoryStorage();
    const { commandId, deliveries } = await crashWhileSettling(storage);
    const before = await deliveries.read(commandId);
    expect(before?.promotion).toBeUndefined();

    const prompts: { step: number; texts: string[]; ids: string[] }[] = [];
    const mailbox = newMailbox(storage);
    const engineB = await buildEngine(storage, () =>
      makeServices(
        async (context: GenerateContext) => {
          prompts.push({
            step: context.step,
            texts: userTexts(context.conversation),
            ids: sessionInputMessages(context.conversation).map(({ id }) => id),
          });
          return { content: 'recovered', toolCalls: [] };
        },
        createMailboxSessionInputGate({ mailbox, owner: RUN_ID, decode, deliveries }),
      ),
    );
    try {
      const handles = await engineB.recoverAll();
      expect(handles).toHaveLength(1);
      await handles[0]!.result();

      // Step 1 is cached, so only step 2 generates, and it holds the input once.
      expect(prompts).toEqual([{ step: 2, texts: ['Start', 'first'], ids: ['input-a'] }]);
      const after = await deliveries.read(commandId);
      expect(after?.promotion?.providerTurn).toBe(1);
    } finally {
      engineB[Symbol.dispose]();
    }
  });

  it('fails the run rather than record a settlement nobody performed when the gate is gone', async () => {
    const storage = new MemoryStorage();
    await crashWhileSettling(storage);

    const engineB = await buildEngine(storage, () =>
      makeServices(async () => ({ content: 'recovered', toolCalls: [] })),
    );
    try {
      const handles = await engineB.recoverAll();
      expect(handles).toHaveLength(1);
      let failure: unknown;
      try {
        await handles[0]!.result();
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain('no session input gate');
    } finally {
      engineB[Symbol.dispose]();
    }
  });
});

describe('session input gate concurrency, ordering, and recovery (COR-1476)', () => {
  function manualTimers() {
    let callback: (() => void) | undefined;
    const timers: MailboxSessionInputGateTimers = {
      setInterval: (tick) => {
        callback = tick;
        return 1;
      },
      clearInterval: () => {
        callback = undefined;
      },
    };
    return { timers, tick: () => callback?.(), isRunning: () => callback !== undefined };
  }

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

  it('gives an input to one of two runs even when its step outlives the lease', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const deliveries = deliveryStoreOver(storage);
    const { timers, tick } = manualTimers();
    const runOne = createMailboxSessionInputGate({
      mailbox,
      owner: 'run-1',
      decode,
      deliveries,
      timers,
    });
    const runTwo = createMailboxSessionInputGate({ mailbox, owner: 'run-2', decode, deliveries });
    await admit(mailbox, 'input-a', 'hello');

    const first = await runOne.claimPending();
    expect(first.map(({ id }) => id)).toEqual(['input-a']);
    const initialExpiry = await leaseExpiry(mailbox);

    // Run one's step generates for two minutes. Its lease is renewed on every
    // tick, so run two never finds the input free.
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
        conversationMessageId: 'message-a',
        providerTurn: 0,
      })),
    );
    expect(await openCount(mailbox)).toBe(0);
  });

  it('never appends in a second run an input the first run claimed, even if its lease lapses', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const deliveries = deliveryStoreOver(storage);
    // Run one's lease is never renewed: its timers never tick.
    const { timers } = manualTimers();
    const runOne = createMailboxSessionInputGate({
      mailbox,
      owner: 'run-1',
      decode,
      deliveries,
      timers,
    });
    const runTwo = createMailboxSessionInputGate({ mailbox, owner: 'run-2', decode, deliveries });
    await admit(mailbox, 'input-a', 'hello');
    await admit(mailbox, 'input-b', 'world');

    const first = await runOne.claimPending();
    expect(first.map(({ id }) => id)).toEqual(['input-a', 'input-b']);

    now += 31_000;
    expect(await runTwo.claimPending()).toEqual([]);
    now += 2_000;
    // Run two now leases the lapsed input and finds run one's claim on it. It
    // appends neither input, and releases both so they are not held against run
    // one, nor does the later one overtake the earlier.
    expect(await runTwo.claimPending()).toEqual([]);
    expect(await openCount(mailbox)).toBe(2);
    expect(await mailbox.list({ states: ['claimed'], limit: 10 })).toEqual([]);
  });

  it('delivers an input again to the run that claimed it when the step that appended it was lost', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const deliveries = deliveryStoreOver(storage);
    const before = createMailboxSessionInputGate({
      mailbox,
      owner: RUN_ID,
      decode,
      deliveries,
      timers: manualTimers().timers,
    });
    await admit(mailbox, 'input-a', 'first');
    const firstClaim = await before.claimPending();
    expect(firstClaim.map(({ id }) => id)).toEqual(['input-a']);

    // The process died before the step was checkpointed. Its replacement is the
    // same run, so the claim is its own.
    const after = createMailboxSessionInputGate({ mailbox, owner: RUN_ID, decode, deliveries });
    expect(await after.claimPending()).toEqual([]);
    now += 31_000;
    expect(await after.claimPending()).toEqual([]);
    now += 2_000;
    const retried = await after.claimPending();
    expect(retried.map(({ id }) => id)).toEqual(['input-a']);
  });

  it('retires a command that was promoted before the crash, whichever gate leased it', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const deliveries = deliveryStoreOver(storage);
    const before = createMailboxSessionInputGate({
      mailbox,
      owner: RUN_ID,
      decode,
      deliveries,
      timers: manualTimers().timers,
    });
    await admit(mailbox, 'input-a', 'first');
    const [claimed] = await before.claimPending();
    // Promoted, then the process died before the lease could be acknowledged.
    await deliveries.promote([
      {
        id: claimed!.id,
        commandId: claimed!.commandId,
        conversationMessageId: 'message-a',
        providerTurn: 3,
      },
    ]);
    expect(await openCount(mailbox)).toBe(1);

    const after = createMailboxSessionInputGate({ mailbox, owner: 'run-2', decode, deliveries });
    now += 31_000;
    expect(await after.claimPending()).toEqual([]);
    now += 2_000;
    expect(await after.claimPending()).toEqual([]);
    expect(await openCount(mailbox)).toBe(0);
  });

  it('returns nothing while an earlier input is still leased, so a later one never overtakes it', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const gate = gateOver(storage, mailbox);
    await admit(mailbox, 'input-a', 'first');

    const claimedFirst = await gate.claimPending();
    expect(claimedFirst.map(({ id }) => id)).toEqual(['input-a']);
    await admit(mailbox, 'input-b', 'second');
    expect(await gate.claimPending()).toEqual([]);
  });

  it("delivers a caller's reused input id after the mailbox retired the first record", async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const mailbox = newMailbox(storage, () => now);
    const deliveries = deliveryStoreOver(storage);
    const gate = createMailboxSessionInputGate({
      mailbox,
      owner: RUN_ID,
      decode,
      deliveries,
      timers: manualTimers().timers,
    });
    const firstCommand = await admit(mailbox, 'input-a', 'first');
    const [first] = await gate.claimPending();
    await gate.settle([
      {
        id: first!.id,
        commandId: first!.commandId,
        conversationMessageId: 'message-a',
        providerTurn: 0,
      },
    ]);

    // A day later the mailbox has retired the record and the id is the caller's again.
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
    const gate = gateOver(storage, mailbox);
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

  it('stops renewing leases once the step ends and when it is disposed', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const { timers, isRunning } = manualTimers();
    const gate = createMailboxSessionInputGate({
      mailbox,
      owner: RUN_ID,
      decode,
      deliveries: deliveryStoreOver(storage),
      timers,
    });
    await admit(mailbox, 'input-a', 'first');
    await gate.claimPending();
    expect(isRunning()).toBe(true);
    gate.stepEnded?.();
    expect(isRunning()).toBe(false);
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
      const engineA = await buildEngine(storageA);
      const handleA = await startRun(
        engineA,
        makeServices(
          async (context: GenerateContext) => {
            if (context.step === 0) {
              return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            stepOneStarted.resolve();
            return new Promise<never>(() => {});
          },
          gateOver(storageA, mailboxA),
        ),
      );
      void handleA.result().catch(() => {});
      await stepOneStarted.promise;
      const commandA = await admit(mailboxA, 'input-a', 'first');
      const commandB = await admit(mailboxA, 'input-b', 'second');
      engineA[Symbol.dispose]();
      mailboxA.dispose();
      storageA[Symbol.dispose]();

      // Engine B: a fresh process on the same backend recovers the run.
      const storageB = await resolveStorage(configuration);
      const mailboxB = newMailbox(storageB);
      const deliveries = deliveryStoreOver(storageB);
      const generatedPrompts: { step: number; conversation: Conversation }[] = [];
      const engineB = await buildEngine(storageB, () =>
        makeServices(
          async (context: GenerateContext) => {
            generatedPrompts.push({ step: context.step, conversation: context.conversation });
            return { content: 'recovered', toolCalls: [] };
          },
          createMailboxSessionInputGate({ mailbox: mailboxB, owner: RUN_ID, decode, deliveries }),
        ),
      );
      try {
        const handles = await engineB.recoverAll();
        expect(handles).toHaveLength(1);
        const result = (await handles[0]!.result()) as { steps: number };

        expect(result.steps).toBe(2);
        expect(generatedPrompts.map(({ step }) => step)).toEqual([1]);
        const conversation = generatedPrompts[0]!.conversation;
        expect(userTexts(conversation)).toEqual(['Start', 'first', 'second']);

        const delivered = sessionInputMessages(conversation);
        expect(delivered.map(({ id }) => id)).toEqual(['input-a', 'input-b']);
        for (const [index, { messageId }] of delivered.entries()) {
          const record = await deliveries.read([commandA, commandB][index]!);
          expect(record?.promotion).toEqual({
            conversationMessageId: messageId,
            providerTurn: 1,
          });
        }
        expect(await openCount(mailboxB)).toBe(0);
      } finally {
        engineB[Symbol.dispose]();
        mailboxB.dispose();
        storageB[Symbol.dispose]();
      }
    });
  },
);
