/**
 * COR-1940 — hook actions: a hook starts a workflow as its owner or notifies its owner, a record
 * stored before actions existed still reads as a webhook, and a delivery replayed after a restart
 * does its work once.
 */
import type { EncryptionKey } from '@lostgradient/cryptography';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { createSqliteStorageFixture } from '../test/storage-fixtures.ts';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from '../testing/workflow-bureau.test-support.ts';
import {
  createClock,
  createReceiver,
  deliveriesOf,
  fireRunEvents,
  newEncryptionKey,
  openHooksBureau,
  type OpenedHooksBureau,
  SIGNING_SECRET,
  waitForSettledDeliveries,
} from './hooks.test-support.ts';
import { createHookStore, HOOK_DELIVERY_KEY_PREFIX, HOOK_KEY_PREFIX } from './hook-store.ts';
import { HookError, type HookDeliveryRecord } from './hook-types.ts';
import type { BureauDiagnostic } from '../types.ts';
import type { BureauWorkflows } from '../workflow-runtime.ts';

let key: EncryptionKey;
beforeAll(async () => {
  key = await newEncryptionKey();
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function refusal(work: Promise<unknown>): Promise<HookError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HookError);
  return error as HookError;
}

/** The path of the first field a refused call names. */
async function pathOf(work: Promise<unknown>): Promise<readonly string[]> {
  const error = await refusal(work);
  return error.issues[0]!.path;
}

/**
 * The event these tests fire: a run settling. A `start-workflow` hook may listen to a kind that
 * names a run, and a run a person started is not one a hook started (`settleARun`).
 */
const ON_RUNS = ['run.settled'];

/** A workflow that raises no run of its own, so the workflows hooks start add no events. */
const QUIET_STEPS = [{ kind: 'sleep', duration: 1 }];

const LOOKUP_INPUT = {
  type: 'object',
  properties: { runId: { type: 'string' } },
  required: ['runId'],
} as const;
const CITY_INPUT = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
} as const;
const ON_GO = { kind: 'signal', name: 'go' };

type WorkflowHooksBureau = {
  readonly harness: WorkflowBureauHarness;
  readonly workflows: BureauWorkflows;
};

/** A workflow Bureau with hooks on, over `storage`; a run settling in it is the event. */
async function openWorkflowHooks(
  options: {
    storage?: Parameters<typeof openHooksBureau>[0]['storage'];
    directory?: string;
    now?: () => number;
    onDiagnostic?: (diagnostic: BureauDiagnostic) => void;
  } = {},
): Promise<WorkflowHooksBureau> {
  const receiver = createReceiver();
  const harness = await startWorkflowBureau({
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    overrides: {
      ...(options.storage === undefined ? {} : { storage: options.storage }),
      durableOwnership: { ownership: 'none' },
      answerEncryption: { current: key },
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
      hooks: {},
      webhooks: {
        targets: [],
        fetch: receiver.fetch,
        sleep: () => Promise.resolve(),
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    },
  });
  cleanups.push(() => harness.dispose());
  return { harness, workflows: harness.bureau.workflows! };
}

/** Starts a run no hook started and waits for none of it: its agent step settling is the event. */
async function settleARun(harness: WorkflowBureauHarness): Promise<void> {
  await harness.putWorkflow('source', { trigger: ON_GO });
  await harness.bureau.workflows!.start('source', { input: {}, owner: 'anonymous:local' });
}

async function instancesOf(harness: WorkflowBureauHarness, workflow: string) {
  const page = await harness.bureau.durableEngine()!.list({ type: workflow });
  return page.items;
}

describe('a hook record stored before actions existed', () => {
  const LEGACY_HOOK = {
    version: 1,
    id: 'hook-legacy',
    owner: 'api-key:alice',
    name: 'Legacy',
    url: 'https://receiver.example/legacy',
    events: ['run.settled'],
    enabled: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    revision: 3,
  };
  const LEGACY_DELIVERY = {
    version: 1,
    id: 'delivery-legacy',
    hookId: 'hook-legacy',
    owner: 'api-key:alice',
    kind: 'run.settled',
    test: false,
    status: 'delivered',
    request: {
      url: 'https://receiver.example/legacy',
      headers: { 'Idempotency-Key': 'delivery-legacy' },
      body: '{}',
    },
    attempts: [],
    maxAttempts: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    leaseUntil: 0,
    revision: 2,
  };

  it('reads as a webhook with no migration, and a delivery with no action type as a webhook delivery', async () => {
    const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
    await kv.set(`${HOOK_KEY_PREFIX}hook-legacy`, JSON.stringify(LEGACY_HOOK));
    await kv.set(`${HOOK_DELIVERY_KEY_PREFIX}delivery-legacy`, JSON.stringify(LEGACY_DELIVERY));
    const store = createHookStore(kv);

    const hook = await store.getHook('hook-legacy');
    expect(hook?.record.action).toEqual({
      type: 'webhook',
      url: 'https://receiver.example/legacy',
    });
    expect(Object.keys(hook!.record)).not.toContain('url');
    const delivery = await store.getDelivery('delivery-legacy');
    expect(delivery?.record.actionType).toBe('webhook');
    expect(delivery?.record.request?.url).toBe('https://receiver.example/legacy');

    // Compare-and-swap still works against the text that was read, and the rewrite is the new shape.
    expect(await store.replaceHook(hook!, { ...hook!.record, revision: 4 })).toBe(true);
    const rewritten = await store.getHook('hook-legacy');
    expect(rewritten?.record.action).toEqual(hook!.record.action);
    expect(JSON.parse(rewritten!.raw)).toMatchObject({
      action: { type: 'webhook', url: 'https://receiver.example/legacy' },
      revision: 4,
    });
  });

  it('is served by a Bureau, listed and changed, as a webhook hook', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    await kv.set(`${HOOK_KEY_PREFIX}hook-legacy`, JSON.stringify(LEGACY_HOOK));
    const receiver = createReceiver();
    const { now } = createClock();
    const opened = await openHooksBureau({ storage, fetch: receiver.fetch, key, now });
    cleanups.push(() => opened.dispose());
    const hooks = opened.bureau.hooks!;

    expect(await hooks.get('hook-legacy')).toMatchObject({
      action: { type: 'webhook', url: 'https://receiver.example/legacy' },
      revision: 3,
    });
    const renamed = await hooks.update('hook-legacy', { name: 'Renamed', expectedRevision: 3 });
    expect(renamed).toMatchObject({ name: 'Renamed', revision: 4 });
    const listed = await hooks.list();
    expect(listed.map((hook) => hook.id)).toEqual(['hook-legacy']);
  });

  it('keeps a webhook hook’s url at the top level, where a release without actions reads it, and prefers it when the two differ', async () => {
    const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
    const store = createHookStore(kv);
    const webhook = {
      ...LEGACY_HOOK,
      id: 'hook-web',
      action: { type: 'webhook' as const, url: LEGACY_HOOK.url },
    };
    const { url: _url, ...base } = LEGACY_HOOK;
    expect(await store.createHook({ ...base, ...webhook } as never)).toBe(true);
    expect(
      await store.createHook({
        ...base,
        id: 'hook-notify',
        action: { type: 'notify' },
      } as never),
    ).toBe(true);

    // What the previous release's parser needs of a hook: a string `url` beside the rest.
    const rawOf = async (id: string) =>
      JSON.parse((await kv.get(`${HOOK_KEY_PREFIX}${id}`))!) as Record<string, unknown>;
    expect(await rawOf('hook-web')).toMatchObject({
      url: LEGACY_HOOK.url,
      action: { type: 'webhook' },
    });
    expect(await rawOf('hook-notify')).not.toHaveProperty('url');

    // That release rewrites the `url` and leaves `action` as it was; this one reads the rewrite.
    await kv.set(
      `${HOOK_KEY_PREFIX}hook-web`,
      JSON.stringify({ ...(await rawOf('hook-web')), url: 'https://receiver.example/moved' }),
    );
    const moved = await store.getHook('hook-web');
    expect(moved?.record.action).toEqual({
      type: 'webhook',
      url: 'https://receiver.example/moved',
    });
  });

  it('refuses a record whose action it does not know, as it refuses any unreadable record', async () => {
    const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
    await kv.set(
      `${HOOK_KEY_PREFIX}hook-x`,
      JSON.stringify({ ...LEGACY_HOOK, url: undefined, action: { type: 'teleport' } }),
    );
    expect(await createHookStore(kv).getHook('hook-x')).toBeUndefined();
  });
});

describe('a start-workflow hook', () => {
  it('starts the workflow as the hook’s owner with the event’s payload, and records the run', async () => {
    const { harness, workflows } = await openWorkflowHooks();
    await harness.putWorkflow('lookup', {
      trigger: ON_GO,
      steps: QUIET_STEPS,
      inputSchema: LOOKUP_INPUT,
    });
    const hook = await harness.bureau.hooks!.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ON_RUNS,
    });
    expect(hook.action).toEqual({ type: 'start-workflow', workflowId: 'lookup', input: 'payload' });
    expect(hook.owner).toBe('anonymous:local');

    await settleARun(harness);
    const [delivery] = await waitForSettledDeliveries(harness.bureau, hook.id, 1);

    expect(delivery).toMatchObject({
      actionType: 'start-workflow',
      status: 'delivered',
      kind: 'run.settled',
      work: { type: 'start-workflow', workflowId: 'lookup' },
    });
    expect(delivery!.request).toBeUndefined();
    const receipt = delivery!.attempts[0]!.receipt!;
    expect(delivery!.attempts.map((attempt) => attempt.outcome)).toEqual(['completed']);
    const [instance] = await instancesOf(harness, 'lookup');
    expect(instance!.id).toBe(receipt.runId!);
    const state = await harness.bureau.durableEngine()!.get(receipt.runId!);
    expect(await workflows.getRun(receipt.runId!)).toMatchObject({ workflow: 'lookup' });
    expect(state!.input).toMatchObject({
      kind: 'manual',
      input: { runId: expect.any(String) },
      origin: { kind: 'person', principal: 'anonymous:local', surface: 'api' },
    });
  });

  it('maps the whole event when the action asks for it', async () => {
    const { harness } = await openWorkflowHooks();
    await harness.putWorkflow('lookup', { trigger: ON_GO, steps: QUIET_STEPS });
    const hook = await harness.bureau.hooks!.create({
      action: { type: 'start-workflow', workflowId: 'lookup', input: 'event' },
      events: ON_RUNS,
    });

    await settleARun(harness);
    await waitForSettledDeliveries(harness.bureau, hook.id, 1);

    const [instance] = await instancesOf(harness, 'lookup');
    const state = await harness.bureau.durableEngine()!.get(instance!.id);
    expect(state!.input).toMatchObject({
      kind: 'manual',
      input: {
        kind: 'run.settled',
        bureauId: harness.bureau.id,
        payload: { runId: expect.any(String) },
      },
    });
  });

  it('records input the workflow refuses as a failed delivery, starts nothing, retries nothing, and keeps delivering', async () => {
    const { harness } = await openWorkflowHooks();
    await harness.putWorkflow('lookup', {
      trigger: ON_GO,
      steps: QUIET_STEPS,
      inputSchema: CITY_INPUT,
    });
    const hook = await harness.bureau.hooks!.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ON_RUNS,
    });

    await settleARun(harness);
    await settleARun(harness);
    const deliveries = await waitForSettledDeliveries(harness.bureau, hook.id, 2);

    // Permanent: one attempt each, a terminal status, and the loop went on to the next event.
    expect(deliveries.map((delivery) => delivery.status)).toEqual(['failed', 'failed']);
    for (const delivery of deliveries) {
      expect(delivery.attempts).toHaveLength(1);
      expect(delivery.attempts[0]).toMatchObject({ outcome: 'rejected' });
      expect(delivery.attempts[0]!.error).toContain('input schema');
      expect(delivery.attempts[0]!.receipt).toBeUndefined();
    }
    expect(await instancesOf(harness, 'lookup')).toEqual([]);
  });

  it('starts one run for an event whose delivery is replayed after a restart', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const { now } = createClock();
    const first = await openWorkflowHooks({ storage: database.storage, now });
    await first.harness.putWorkflow('lookup', { trigger: ON_GO, steps: QUIET_STEPS });
    const hook = await first.harness.bureau.hooks!.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ON_RUNS,
    });
    await settleARun(first.harness);
    const [done] = await waitForSettledDeliveries(first.harness.bureau, hook.id, 1);
    const runId = done!.attempts[0]!.receipt!.runId!;
    const directory = first.harness.directory;
    await first.harness.bureau.dispose();

    // What a crash between the start and the write of its outcome leaves: the attempt still
    // `sending`, the delivery pending, its lease gone.
    const storage = await database.reopen();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const [deliveryKey] = await kv.list(HOOK_DELIVERY_KEY_PREFIX);
    const record = JSON.parse((await kv.get(deliveryKey!))!) as HookDeliveryRecord;
    const { finishedAt: _finished, receipt: _receipt, ...sending } = record.attempts[0]!;
    await kv.set(
      deliveryKey!,
      JSON.stringify({
        ...record,
        status: 'pending',
        attempts: [{ ...sending, outcome: 'sending' }],
        leaseUntil: 0,
        revision: record.revision + 1,
      } satisfies HookDeliveryRecord),
    );

    const second = await openWorkflowHooks({ storage, directory, now });
    const [replayed] = await waitForSettledDeliveries(second.harness.bureau, hook.id, 1);

    expect(replayed!.attempts.map((a) => a.error)).toEqual([]);
    expect(replayed!.status).toBe('delivered');
    expect(replayed!.attempts.map((attempt) => attempt.outcome)).toEqual([
      'interrupted',
      'completed',
    ]);
    // The second attempt was answered with the run the first one started.
    expect(replayed!.attempts[1]!.receipt!.runId).toBe(runId);
    expect(await instancesOf(second.harness, 'lookup')).toHaveLength(1);
  });

  it('delivers an event the session outbox replays at boot, which the hooks hold until the workflow files are loaded', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const { now } = createClock();
    const first = await openWorkflowHooks({ storage: database.storage, now });
    await first.harness.putWorkflow('lookup', { trigger: ON_GO, steps: QUIET_STEPS });
    // A start-workflow hook cannot listen to `session.saved`, which a run it started could raise
    // without a trace back to it; a notify hook can. (The hold itself, for a start, is in
    // `hooks-chain.test.ts`, over an allowed kind.)
    expect(
      await pathOf(
        first.harness.bureau.hooks!.create({
          action: { type: 'start-workflow', workflowId: 'lookup' },
          events: ['session.saved'],
        }),
      ),
    ).toEqual(['events']);
    const hook = await first.harness.bureau.hooks!.create({
      action: { type: 'notify' },
      events: ['session.saved'],
    });
    const directory = first.harness.directory;
    await first.harness.bureau.dispose();

    // What a crash between a session's commit and the publish of its event leaves: an outbox entry
    // the next boot drains, which publishes `session.saved` before the workflow files are loaded.
    const storage = await database.reopen();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    await kv.set(
      `agent-session-outbox:v1:entry:${'1'.padStart(20, '0')}`,
      JSON.stringify({
        ordinal: 1,
        kind: 'session.saved',
        sessionId: 's-1',
        agentName: 'writer',
        incarnation: 'i-1',
        committedAtMs: 1,
      }),
    );
    await kv.set('agent-session-outbox:v1:ordinal', '1');

    const second = await openWorkflowHooks({ storage, directory, now });
    const [delivery] = await waitForSettledDeliveries(second.harness.bureau, hook.id, 1);

    expect(delivery!.attempts.map((attempt) => attempt.error)).toEqual([undefined]);
    expect(delivery).toMatchObject({ status: 'delivered', kind: 'session.saved' });
  });

  it('is refused for an owner who may not start workflows, an unknown workflow, and a Bureau with none', async () => {
    const { harness } = await openWorkflowHooks();
    await harness.putWorkflow('lookup', { trigger: ON_GO, steps: QUIET_STEPS });
    const hooks = harness.bureau.hooks!;

    const foreign = await refusal(
      hooks.create({
        action: { type: 'start-workflow', workflowId: 'lookup' },
        events: ON_RUNS,
        principal: 'api-key:alice',
      }),
    );
    expect(foreign.code).toBe('forbidden');

    const unknown = await refusal(
      hooks.create({
        action: { type: 'start-workflow', workflowId: 'nothing-here' },
        events: ON_RUNS,
      }),
    );
    expect(unknown).toMatchObject({
      code: 'invalid',
      issues: [{ path: ['action', 'workflowId'] }],
    });

    const none = await openHooksBureau({
      storage: new MemoryStorage(),
      fetch: createReceiver().fetch,
      key,
    });
    cleanups.push(() => none.dispose());
    const without = await refusal(
      none.bureau.hooks!.create({
        action: { type: 'start-workflow', workflowId: 'lookup' },
        events: ON_RUNS,
      }),
    );
    expect(without).toMatchObject({
      code: 'invalid',
      issues: [{ path: ['action', 'workflowId'] }],
    });
  });

  it('asks again when the event fires, so an owner who has lost the authority starts nothing', async () => {
    const storage = new MemoryStorage();
    const { harness } = await openWorkflowHooks({ storage });
    await harness.putWorkflow('lookup', { trigger: ON_GO, steps: QUIET_STEPS });
    const hook = await harness.bureau.hooks!.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ON_RUNS,
    });
    // The hook's owner changes to one that may not start workflows, as the record is stored.
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const raw = JSON.parse((await kv.get(`${HOOK_KEY_PREFIX}${hook.id}`))!) as Record<
      string,
      unknown
    >;
    await kv.set(
      `${HOOK_KEY_PREFIX}${hook.id}`,
      JSON.stringify({ ...raw, owner: 'api-key:mallory', revision: 2 }),
    );

    await settleARun(harness);
    const [delivery] = await waitForSettledDeliveries(harness.bureau, hook.id, 1);

    expect(delivery).toMatchObject({ status: 'failed', owner: 'api-key:mallory' });
    expect(delivery!.attempts[0]).toMatchObject({ outcome: 'rejected' });
    expect(delivery!.attempts[0]!.error).toContain('may not start workflows');
    expect(await instancesOf(harness, 'lookup')).toEqual([]);
  });

  it('cannot be tested, because a test would start a real run', async () => {
    const { harness } = await openWorkflowHooks();
    await harness.putWorkflow('lookup', { trigger: ON_GO, steps: QUIET_STEPS });
    const hook = await harness.bureau.hooks!.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ON_RUNS,
    });
    const error = await refusal(harness.bureau.hooks!.test(hook.id));
    expect(error.issues[0]!.path).toEqual(['action']);
    expect(await instancesOf(harness, 'lookup')).toEqual([]);
  });

  it('keeps its action type on update, and checks a new workflow as it checks a new hook', async () => {
    const { harness } = await openWorkflowHooks();
    await harness.putWorkflow('lookup', { trigger: ON_GO, steps: QUIET_STEPS });
    await harness.putWorkflow('second-lookup', { trigger: ON_GO, steps: QUIET_STEPS });
    const hooks = harness.bureau.hooks!;
    const hook = await hooks.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ON_RUNS,
    });

    const moved = await hooks.update(hook.id, {
      action: { type: 'start-workflow', workflowId: 'second-lookup', input: 'event' },
    });
    expect(moved?.action).toEqual({
      type: 'start-workflow',
      workflowId: 'second-lookup',
      input: 'event',
    });
    expect(await pathOf(hooks.update(hook.id, { action: { type: 'notify' } }))).toEqual([
      'action',
      'type',
    ]);
    expect(
      await pathOf(
        hooks.update(hook.id, { action: { type: 'start-workflow', workflowId: 'gone' } }),
      ),
    ).toEqual(['action', 'workflowId']);
    expect(await pathOf(hooks.update(hook.id, { url: 'https://receiver.example/x' }))).toEqual([
      'url',
    ]);
    expect(await pathOf(hooks.update(hook.id, { signingSecret: SIGNING_SECRET }))).toEqual([
      'signingSecret',
    ]);
    // A rename needs no authority and no live workflow.
    expect(await hooks.update(hook.id, { name: 'Renamed' })).toMatchObject({ name: 'Renamed' });
  });
});

describe('a start-workflow hook on the events of its own runs', () => {
  it('starts one run and no more, however the run settles: a run a hook started raises events no hook acts on', async () => {
    const diagnostics: BureauDiagnostic[] = [];
    const { harness } = await openWorkflowHooks({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    // An `agent` step: its run settles, which is the event the hook below lists.
    await harness.putWorkflow('chain', { trigger: ON_GO });
    const hooks = harness.bureau.hooks!;
    const starter = await hooks.create({
      action: { type: 'start-workflow', workflowId: 'chain' },
      events: ['run.settled'],
    });
    const notifier = await hooks.create({ action: { type: 'notify' }, events: ['run.settled'] });

    // Started by a person, not by the hook: its agent step settles and the hook starts one more.
    const manual = await harness.bureau.workflows!.start('chain', {
      input: {},
      owner: 'anonymous:local',
    });
    // The second instance's own agent step settles too; the hook sees that event and declines it.
    await waitUntil(async () => {
      const listed = await deliveriesOf(harness.bureau, starter.id);
      return listed.length === 2;
    });
    const deliveries = await waitForSettledDeliveries(harness.bureau, starter.id, 2);
    await quietFor(250);

    const [started, skipped] = deliveries;
    expect(started).toMatchObject({ status: 'delivered' });
    expect(skipped).toMatchObject({ status: 'failed', actionType: 'start-workflow' });
    expect(skipped!.attempts).toHaveLength(1);
    expect(skipped!.attempts[0]).toMatchObject({ outcome: 'rejected' });
    expect(skipped!.attempts[0]!.receipt).toBeUndefined();
    expect(skipped!.attempts[0]!.error).toContain(`hook ${starter.id} started`);
    expect(skipped!.attempts[0]!.error).toContain('Skipped');

    // Exactly one run the hook started, beside the one the person started; nothing further.
    expect(await deliveriesOf(harness.bureau, starter.id)).toHaveLength(2);
    const instances = await instancesOf(harness, 'chain');
    expect(instances.map((instance) => instance.id).toSorted()).toEqual(
      [manual.runId, started!.attempts[0]!.receipt!.runId!].toSorted(),
    );
    expect(harness.calls).toHaveLength(2);
    const hookStarted = await harness.bureau
      .durableEngine()!
      .get(started!.attempts[0]!.receipt!.runId!);
    expect(hookStarted!.tags).toContain(`hook-origin:${starter.id}`);

    // A skipped start is reported, not silent.
    expect(
      diagnostics.filter((d) => d.scope === 'hooks' && d.message.includes('did not start')),
    ).toMatchObject([{ level: 'warn', message: expect.stringContaining(starter.id) }]);

    // Webhook and notify actions are not chained actions: the notify hook saw both runs settle.
    const notified = await waitForSettledDeliveries(harness.bureau, notifier.id, 2);
    expect(notified.map((delivery) => delivery.status)).toEqual(['delivered', 'delivered']);
  });
});

describe('a start-workflow hook on the events a notify hook raises', () => {
  it('starts one run and one model call, not a chain, when a stored record listens to notification.created (COR-1940)', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const diagnostics: BureauDiagnostic[] = [];
    const { harness } = await openWorkflowHooks({
      storage: database.storage,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await harness.putWorkflow('chain', { trigger: ON_GO });
    const hooks = harness.bureau.hooks!;
    const start = { type: 'start-workflow', workflowId: 'chain' } as const;

    // Refused when written, at create and at update.
    expect(await pathOf(hooks.create({ action: start, events: ['notification.created'] }))).toEqual(
      ['events'],
    );
    const starter = await hooks.create({ action: start, events: ['run.settled'] });
    expect(await pathOf(hooks.update(starter.id, { events: ['notification.created'] }))).toEqual([
      'events',
    ]);

    // A record that lists it anyway (written by something that skipped the check): the notify hook
    // below turns each settled run into a notification, and the notification is the event the
    // starter would start a run from, with no run for the guard to follow.
    const kv = textValueStore(database.storage, { disposeUnderlyingStorage: false });
    const raw = JSON.parse((await kv.get(`${HOOK_KEY_PREFIX}${starter.id}`))!) as Record<
      string,
      unknown
    >;
    await kv.set(
      `${HOOK_KEY_PREFIX}${starter.id}`,
      JSON.stringify({ ...raw, events: ['notification.created'], revision: 3 }),
    );
    const notifier = await hooks.create({ action: { type: 'notify' }, events: ['run.settled'] });

    const manual = await harness.bureau.workflows!.start('chain', {
      input: {},
      owner: 'anonymous:local',
    });
    const [skipped] = await waitForSettledDeliveries(harness.bureau, starter.id, 1);
    await waitForSettledDeliveries(harness.bureau, notifier.id, 1);
    await quietFor(250);

    expect(skipped).toMatchObject({ status: 'failed', kind: 'notification.created' });
    expect(skipped!.attempts[0]!.error).toContain('Skipped');
    expect(skipped!.attempts[0]!.receipt).toBeUndefined();
    expect(await deliveriesOf(harness.bureau, starter.id)).toHaveLength(1);
    const instances = await instancesOf(harness, 'chain');
    expect(instances.map((instance) => instance.id)).toEqual([manual.runId]);
    expect(harness.calls).toHaveLength(1);
    // The skip is reported, not silent.
    expect(
      diagnostics.filter((d) => d.scope === 'hooks' && d.message.includes('did not start')),
    ).toMatchObject([{ level: 'warn', message: expect.stringContaining(starter.id) }]);
  });
});

describe('a notify hook', () => {
  async function openNotifying() {
    const receiver = createReceiver();
    const { now } = createClock();
    const opened = await openHooksBureau({
      storage: new MemoryStorage(),
      fetch: receiver.fetch,
      key,
      now,
    });
    cleanups.push(() => opened.dispose());
    return opened;
  }

  async function notificationsOf(opened: OpenedHooksBureau, owner: string) {
    const page = await opened.bureau.notifications.list({ owner });
    return page.notifications;
  }

  async function kindsOf(opened: OpenedHooksBureau, owner: string) {
    const notifications = await notificationsOf(opened, owner);
    return notifications.map((notification) => notification.kind);
  }

  it('writes its owner a notification, and nobody else', async () => {
    const opened = await openNotifying();
    const hook = await opened.bureau.hooks!.create({
      action: { type: 'notify', title: 'A run started' },
      events: ['run.registered'],
      principal: 'api-key:alice',
    });
    expect(hook.action).toEqual({ type: 'notify', title: 'A run started' });

    await fireRunEvents(opened.bureau, 'api-key:bob');
    const [delivery] = await waitForSettledDeliveries(opened.bureau, hook.id, 1);

    expect(delivery).toMatchObject({
      actionType: 'notify',
      status: 'delivered',
      owner: 'api-key:alice',
    });
    expect(delivery!.work).toMatchObject({ type: 'notify', title: 'A run started' });
    const alice = await notificationsOf(opened, 'api-key:alice');
    const mine = alice.find((notification) => notification.kind === 'hook');
    expect(mine).toMatchObject({ title: 'A run started', link: null });
    expect(mine!.body).toContain('run.registered');
    expect(delivery!.attempts[0]!.receipt).toEqual({ notificationId: mine!.id });
    expect(await kindsOf(opened, 'api-key:bob')).not.toContain('hook');
  });

  it('writes one notification when the same delivery is run again', async () => {
    const opened = await openNotifying();
    const hook = await opened.bureau.hooks!.create({
      action: { type: 'notify' },
      events: ['run.registered'],
      principal: 'api-key:alice',
    });
    await fireRunEvents(opened.bureau);
    const [delivery] = await waitForSettledDeliveries(opened.bureau, hook.id, 1);

    // The same key a replayed delivery would use: the store answers the notification it has.
    const again = await opened.bureau.notifications.create({
      owner: 'api-key:alice',
      kind: 'hook',
      title: 'Again',
      dedupeKey: `hook:${hook.id}:${delivery!.id}`,
    });
    expect(again.created).toBe(false);
    expect(again.notification.id).toBe(delivery!.attempts[0]!.receipt!.notificationId!);
    const kinds = await kindsOf(opened, 'api-key:alice');
    expect(kinds.filter((kind) => kind === 'hook')).toHaveLength(1);
  });

  it('cannot list notification.created, at create or update, because it would fire on its own notifications', async () => {
    const opened = await openNotifying();
    const hooks = opened.bureau.hooks!;
    const created = await refusal(
      hooks.create({ action: { type: 'notify' }, events: ['run.settled', 'notification.created'] }),
    );
    expect(created.issues[0]!.path).toEqual(['events']);

    const hook = await hooks.create({ action: { type: 'notify' }, events: ['run.settled'] });
    const updated = await refusal(hooks.update(hook.id, { events: ['notification.created'] }));
    expect(updated.issues[0]!.path).toEqual(['events']);
    const unchanged = await hooks.get(hook.id);
    expect(unchanged?.events).toEqual(['run.settled']);

    // Other actions may match it: a webhook or a workflow does not write a notification.
    const webhook = await hooks.create({
      url: 'https://receiver.example/hook',
      signingSecret: SIGNING_SECRET,
      events: ['notification.created'],
    });
    expect(webhook.events).toEqual(['notification.created']);
  });

  it('does not fire on notification.created even when its record lists it, so it cannot loop', async () => {
    const storage = new MemoryStorage();
    const { clock, now } = createClock();
    const opened = await openHooksBureau({ storage, fetch: createReceiver().fetch, key, now });
    cleanups.push(() => opened.dispose());
    const hook = await opened.bureau.hooks!.create({
      action: { type: 'notify' },
      events: ['run.settled'],
      principal: 'api-key:alice',
    });
    // A record that lists the looping kind anyway, as one written by something that skipped the check.
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const raw = JSON.parse((await kv.get(`${HOOK_KEY_PREFIX}${hook.id}`))!) as Record<
      string,
      unknown
    >;
    await kv.set(
      `${HOOK_KEY_PREFIX}${hook.id}`,
      JSON.stringify({ ...raw, events: ['notification.created'], revision: 2 }),
    );
    // Dispatch keeps the hooks it read for a few seconds: let that copy expire.
    clock.milliseconds += 60_000;

    await opened.bureau.notifications.create({
      owner: 'api-key:alice',
      kind: 'manual',
      title: 'A notification',
    });
    await opened.bureau.internals.webhookNotifier!.flush();

    expect(await deliveriesOf(opened.bureau, hook.id)).toEqual([]);
    expect(await kindsOf(opened, 'api-key:alice')).toEqual(['manual']);
  });

  it('cannot be tested, because a test would write a real notification', async () => {
    const opened = await openNotifying();
    const hook = await opened.bureau.hooks!.create({
      action: { type: 'notify' },
      events: ['run.settled'],
    });
    const error = await refusal(opened.bureau.hooks!.test(hook.id));
    expect(error.issues[0]!.path).toEqual(['action']);
  });
});

describe('a hook’s input', () => {
  async function openPlain() {
    const opened = await openHooksBureau({
      storage: new MemoryStorage(),
      fetch: createReceiver().fetch,
      key,
    });
    cleanups.push(() => opened.dispose());
    return opened.bureau.hooks!;
  }

  it.each([
    [
      'both a url and an action',
      { url: 'https://receiver.example/h', action: { type: 'notify' as const } },
      ['action'],
    ],
    ['neither a url nor an action', {}, ['action']],
    ['an unknown action type', { action: { type: 'teleport' } }, ['action', 'type']],
    ['a webhook with no secret', { url: 'https://receiver.example/h' }, ['signingSecret']],
    [
      'a signing secret on a notify hook',
      { action: { type: 'notify' as const }, signingSecret: SIGNING_SECRET },
      ['signingSecret'],
    ],
    [
      'an empty workflow identifier',
      { action: { type: 'start-workflow' as const, workflowId: '' } },
      ['action', 'workflowId'],
    ],
    [
      'an unknown input mapping',
      { action: { type: 'start-workflow' as const, workflowId: 'x', input: 'all' } },
      ['action', 'input'],
    ],
    [
      'a title over 200 characters',
      { action: { type: 'notify' as const, title: 'x'.repeat(201) } },
      ['action', 'title'],
    ],
    [
      'an unacceptable url inside a webhook action',
      {
        action: { type: 'webhook' as const, url: 'ftp://example.com/' },
        signingSecret: SIGNING_SECRET,
      },
      ['action', 'url'],
    ],
  ])('refuses %s, naming the field', async (_label, patch, path) => {
    const hooks = await openPlain();
    const error = await refusal(
      hooks.create({ events: ['run.settled'], ...patch } as Parameters<typeof hooks.create>[0]),
    );
    expect(error.code).toBe('invalid');
    expect(error.issues[0]!.path).toEqual(path);
  });

  it('accepts a webhook named by an action as it does by a url', async () => {
    const hooks = await openPlain();
    const hook = await hooks.create({
      action: { type: 'webhook', url: 'https://receiver.example/h' },
      signingSecret: SIGNING_SECRET,
      events: ['run.settled'],
    });
    expect(hook.action).toEqual({ type: 'webhook', url: 'https://receiver.example/h' });
  });
});
