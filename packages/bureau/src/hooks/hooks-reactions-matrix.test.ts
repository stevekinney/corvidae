/**
 * COR-2173 to COR-2177 — the outcome matrix of a plugin reaction's delivery, one test per row. A row
 * names the issue that owns it (`main` for a row that pins what the delivery already did), the
 * matrix line it comes from, and the result it requires. The hooks are built over the scripted
 * engine of `hooks-reactions.test-support.ts`, so no row waits on a real timer.
 */
import { generateEncryptionKey } from '@lostgradient/cryptography';
import { PluginReactionError } from '@lostgradient/interborough-plugin';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { type HooksDependencies } from './create-hooks.ts';
import { HOOK_KEY_PREFIX, createHookStore } from './hook-store.ts';
import { HookError } from './hook-types.ts';
import {
  ACTION,
  CONFIGURATION,
  DEFAULT_TIMEOUT,
  SECRET_CONFIGURATION,
  SENTINEL,
  START,
  availabilityGate,
  deferred,
  gateRegistration,
  harness,
  never,
  outcomes,
  rawStoreOf,
  reference,
  runStarted,
  secretReader,
  untilAborted,
  type Harness,
} from './hooks-reactions.test-support.ts';

const NOTICE_PREFIX = '[bureau] Hook hook-1 did not run its plugin action: Skipped:';

/** The shape of one row: the matrix line, the issue that owns it, and what it asserts. */
interface Row {
  readonly line: number;
  readonly owner: 'main' | 'COR-2173' | 'COR-2174' | 'COR-2175' | 'COR-2176' | 'COR-2177';
  readonly name: string;
  readonly check: () => Promise<void>;
}

/** The rows of COR-2173 (R2, the loop guard), and the dispatch rows main keeps. */
const LOOP_GUARD_ROWS: readonly Row[] = [
  {
    line: 124,
    owner: 'COR-2173',
    name: 'loop detected: the hook lists K and K came from its own plugin: nothing is written, one notice',
    check: async () => {
      const h = harness();
      const hook = await h.hook();
      await h.open();
      h.dispatch({ source: 'slack' });
      await h.drain();
      expect(await h.deliveries(hook.id)).toEqual([]);
      expect(h.calls).toHaveLength(0);
      expect(h.notices).toEqual([
        `${NOTICE_PREFIX} run.settled came from plugin slack, and a plugin's reaction does not fire on its own plugin's events`,
      ]);
      expect(await createHookStore(h.kv).listStoredDeliveries()).toEqual([]);
    },
  },
  {
    line: 125,
    owner: 'COR-2173',
    name: 'the same hook still delivers for an event from core and from another plugin',
    check: async () => {
      const h = harness();
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      h.dispatch({ source: 'calendar' });
      await h.drain();
      const delivered = await h.deliveries(hook.id);
      expect(delivered.map((delivery) => delivery.status)).toEqual(['delivered', 'delivered']);
      expect(h.calls.map((call) => call.event.source)).toEqual([undefined, 'calendar']);
      expect(h.notices).toEqual([]);
    },
  },
  {
    line: 126,
    owner: 'COR-2173',
    name: 'a run that dispatches its own kind as its own plugin settles after one delivery and one notice',
    check: async () => {
      let dispatched = 0;
      const h: Harness = harness({
        run: () => {
          // Bounded, so a guard that is missing reads as "expected 1 delivery", not as a hang.
          if (dispatched < 4) {
            dispatched += 1;
            h.dispatch({ source: 'slack' });
          }
          return Promise.resolve();
        },
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch({ source: 'calendar' });
      await h.drain();
      const delivered = await h.deliveries(hook.id);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.status).toBe('delivered');
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toContain('came from plugin slack');
    },
  },
  {
    line: 127,
    owner: 'COR-2173',
    name: 'a run that raises the kind through core or another plugin is delivered: an indirect loop is not guarded',
    check: async () => {
      const h: Harness = harness({
        run: (_context, call) => {
          if (call === 1) h.dispatch({ source: 'calendar' });
          if (call === 2) h.dispatch();
          return Promise.resolve();
        },
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      expect(h.calls).toHaveLength(3);
      expect(await h.statuses(hook.id)).toEqual(['delivered', 'delivered', 'delivered']);
      expect(h.notices).toEqual([]);
    },
  },
  {
    line: 128,
    owner: 'COR-2173',
    name: 'an event held before resume is judged by the guard when it is dispatched',
    check: async () => {
      // The boot scan can meet a delivery this very dispatch wrote, whose lease is live: its re-scan waits.
      const h = harness({ waits: 'advance' });
      const hook = await h.hook();
      h.dispatch({ source: 'slack' });
      h.dispatch({ source: 'calendar' });
      expect(h.notices).toEqual([]);
      await h.open();
      await h.drain();
      expect(await h.statuses(hook.id)).toEqual(['delivered']);
      expect(h.notices).toHaveLength(1);
      expect(h.calls.map((call) => call.event.source)).toEqual(['calendar']);
    },
  },
  {
    line: 129,
    owner: 'main',
    name: 'an event during shutdown writes nothing and says nothing',
    check: async () => {
      const h = harness();
      const hook = await h.hook();
      await h.open();
      h.shutdown();
      h.dispatch({ source: 'slack' });
      h.dispatch();
      await h.drain();
      expect(await h.deliveries(hook.id)).toEqual([]);
      expect(h.notices).toEqual([]);
    },
  },
  {
    line: 130,
    owner: 'main',
    name: 'a delivery for the plugin’s own event that was pending before the guard still runs after a restart',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const first = harness({ kv });
      const hook = await first.hook();
      await createHookStore(kv).createDelivery({
        version: 1,
        id: 'hook-delivery-legacy',
        hookId: hook.id,
        owner: hook.owner,
        actionType: 'plugin',
        kind: 'run.settled',
        test: false,
        status: 'pending',
        work: {
          type: 'plugin',
          plugin: 'slack',
          kind: 'post-message',
          configuration: { channel: 'ops' },
          event: {
            kind: 'run.settled',
            bureauId: 'matrix-bureau',
            emittedAtMs: START,
            payload: { runId: 'r1' },
            source: 'slack',
          },
        },
        attempts: [],
        maxAttempts: 3,
        createdAt: START,
        updatedAt: START,
        leaseUntil: 0,
        revision: 0,
      });
      const second = harness({ kv });
      await second.open();
      await second.drain();
      const delivery = await second.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(second.calls.map((call) => call.event.source)).toEqual(['slack']);
    },
  },
  {
    line: 131,
    owner: 'main',
    name: 'a webhook, notify or start-workflow hook on K with source P is delivered: the guard keys on a plugin action',
    check: async () => {
      const requests: string[] = [];
      const started: string[] = [];
      const notified: string[] = [];
      const h = harness({
        keys: await generateEncryptionKey(),
        fetch: (async (url: string | URL | Request) => {
          requests.push(url instanceof Request ? url.url : url.toString());
          return new Response('ok');
        }) as typeof fetch,
        workflows: () => ({
          assertStartable: () => undefined,
          findStart: () => Promise.resolve(undefined),
          start: (workflowId: string) => {
            started.push(workflowId);
            return Promise.resolve({ runId: 'run-1', workflow: workflowId, workflowVersion: 'v1' });
          },
        }),
        notifications: () =>
          ({
            create: (input: { readonly title: string }) => {
              notified.push(input.title);
              return Promise.resolve({ notification: { id: 'notification-1' } });
            },
          }) as unknown as ReturnType<NonNullable<HooksDependencies['notifications']>>,
      });
      const webhook = await h.created.hooks.create({
        events: ['run.settled'],
        url: 'https://example.com/hook',
        signingSecret: 'a-signing-secret-long-enough',
      });
      const workflow = await h.created.hooks.create({
        events: ['run.settled'],
        action: { type: 'start-workflow', workflowId: 'lookup', input: 'event' },
      });
      const notify = await h.created.hooks.create({
        events: ['run.settled'],
        action: { type: 'notify', title: 'Settled' },
      });
      await h.open();
      h.dispatch({ source: 'slack' });
      await h.drain();
      expect(requests).toEqual(['https://example.com/hook']);
      expect(started).toEqual(['lookup']);
      expect(notified).toEqual(['Settled']);
      for (const hook of [webhook, workflow, notify]) {
        expect(await h.status(hook.id)).toBe('delivered');
      }
      expect(h.notices).toEqual([]);
    },
  },
  {
    line: 132,
    owner: 'main',
    name: 'hook.delivery events are not a published kind a hook can list: no guard exists for them here',
    check: async () => {
      const h = harness();
      const error = await h.created.hooks
        .create({ events: ['hook.delivery.exhausted'], action: ACTION })
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(HookError);
      expect((error as HookError).issues[0]?.path).toEqual(['events']);
    },
  },
];

/** The rows that pin what a reaction's delivery already does: retry, resume, disable and delete. */
const BASELINE_ROWS: readonly Row[] = [
  {
    line: 42,
    owner: 'main',
    name: 'success on the first attempt is one completed attempt',
    check: async () => {
      const h = harness();
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['completed']);
    },
  },
  {
    line: 43,
    owner: 'main',
    name: 'success mid-retry keeps the earlier error attempts',
    check: async () => {
      const h = harness({
        run: (_context, call) =>
          call < 3 ? Promise.reject(new Error('Slack is down')) : Promise.resolve(),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['error', 'error', 'completed']);
    },
  },
  {
    line: 44,
    owner: 'main',
    name: 'success after an interrupted attempt is [interrupted, completed] under the same key',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const first: Harness = harness({
        kv,
        run: () => {
          first.shutdown();
          return Promise.reject(new Error('the process is stopping'));
        },
      });
      const hook = await first.hook();
      await first.open();
      first.dispatch();
      await first.drain();
      expect(await first.status(hook.id)).toBe('pending');

      const second = harness({ kv });
      await second.open();
      await second.drain();
      const delivery = await second.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['interrupted', 'completed']);
      expect(second.calls[0]?.idempotencyKey).toBe(`hook:${hook.id}:${delivery.id}`);
    },
  },
  {
    line: 47,
    owner: 'main',
    name: 'a plain error before the last attempt backs off and is retried under the same key',
    check: async () => {
      const h = harness({
        backoff: 1_000,
        run: (_context, call) =>
          call === 1 ? Promise.reject(new Error('Slack is down')) : Promise.resolve(),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await waitUntil(() => h.held.length === 1, { message: 'the backoff wait' });
      const waiting = await h.record(hook.id);
      expect(waiting.status).toBe('pending');
      expect(waiting.nextAttemptAt).toBe(START + 1_000);
      expect(outcomes(waiting)).toEqual(['error']);
      h.releaseWaits();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['error', 'completed']);
      expect(h.calls[0]?.idempotencyKey).toBe(h.calls[1]?.idempotencyKey);
    },
  },
  {
    line: 48,
    owner: 'main',
    name: 'a plain error on the last attempt is exhausted and audited',
    check: async () => {
      const h = harness({ run: () => Promise.reject(new Error('Slack is down')) });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('exhausted');
      expect(outcomes(delivery)).toEqual(['error', 'error', 'error']);
      expect(h.audits).toContain('hook.delivery.exhausted');
    },
  },
  {
    line: 55,
    owner: 'main',
    name: 'a kind that is gone, a version that changed or a configuration that is refused fails the delivery',
    check: async () => {
      // The kind is gone.
      const goneKv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const before = harness({ kv: goneKv });
      const goneHook = await before.hook();
      const gone = harness({ kv: goneKv, registrations: () => [] });
      await gone.open();
      gone.dispatch();
      await gone.drain();
      const goneDelivery = await gone.only(goneHook.id);
      expect(goneDelivery.status).toBe('failed');
      expect(outcomes(goneDelivery)).toEqual(['rejected']);

      // The version changed while the delivery waited.
      const versionKv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const first: Harness = harness({
        kv: versionKv,
        version: '1.0.0',
        run: () => {
          first.shutdown();
          return Promise.reject(new Error('the process is stopping'));
        },
      });
      const versionHook = await first.hook();
      await first.open();
      first.dispatch();
      await first.drain();
      const upgraded = harness({ kv: versionKv, version: '2.0.0' });
      await upgraded.open();
      await upgraded.drain();
      const versionDelivery = await upgraded.only(versionHook.id);
      expect(versionDelivery.status).toBe('failed');
      expect(versionDelivery.attempts.at(-1)?.error).toContain('version-mismatch');

      // The configuration the kind accepts changed while the delivery waited.
      const schemaKv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const original: Harness = harness({
        kv: schemaKv,
        run: () => {
          original.shutdown();
          return Promise.reject(new Error('the process is stopping'));
        },
      });
      const schemaHook = await original.hook();
      await original.open();
      original.dispatch();
      await original.drain();
      const stricter = harness({
        kv: schemaKv,
        registrations: (run) => [
          {
            plugin: 'slack',
            kind: {
              name: 'post-message',
              description: 'Posts.',
              configuration: z.object({ channel: z.string(), token: z.string() }),
              run,
            },
          },
        ],
      });
      await stricter.open();
      await stricter.drain();
      const schemaDelivery = await stricter.only(schemaHook.id);
      expect(schemaDelivery.status).toBe('failed');
      expect(outcomes(schemaDelivery)).toEqual(['interrupted', 'rejected']);
      expect(stricter.calls).toHaveLength(0);
    },
  },
  {
    line: 63,
    owner: 'main',
    name: 'a webhook request that times out is a network error, retried and then exhausted',
    check: async () => {
      let requests = 0;
      const h = harness({
        keys: await generateEncryptionKey(),
        fetch: (() => {
          requests += 1;
          return Promise.reject(new DOMException('The operation timed out', 'TimeoutError'));
        }) as unknown as typeof fetch,
      });
      const hook = await h.created.hooks.create({
        events: ['run.settled'],
        url: 'https://example.com/hook',
        signingSecret: 'a-signing-secret-long-enough',
      });
      await h.open();
      h.dispatch();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('exhausted');
      expect(outcomes(delivery)).toEqual(['network-error', 'network-error', 'network-error']);
      expect(requests).toBe(3);
    },
  },
  {
    line: 68,
    owner: 'main',
    name: 'a disable while the delivery waits out a backoff aborts it at the next pass',
    check: async () => {
      const h = harness({ backoff: 1_000, run: () => Promise.reject(new Error('Slack is down')) });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await waitUntil(() => h.held.length === 1, { message: 'the backoff wait' });
      await h.hooks.update(hook.id, { enabled: false });
      expect(await h.status(hook.id)).toBe('pending');
      h.releaseWaits();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('aborted');
      expect(outcomes(delivery)).toEqual(['error']);
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 69,
    owner: 'main',
    name: 'a disable while the delivery is pending with a released lease aborts it when it is next driven',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const first: Harness = harness({
        kv,
        run: () => {
          first.shutdown();
          return Promise.reject(new Error('the process is stopping'));
        },
      });
      const hook = await first.hook();
      await first.open();
      first.dispatch();
      await first.drain();
      const released = await first.record(hook.id);
      expect(released.leaseUntil).toBe(0);
      await first.hooks.update(hook.id, { enabled: false });
      const second = harness({ kv });
      await second.open();
      await second.drain();
      expect(await second.status(hook.id)).toBe('aborted');
      expect(second.calls).toHaveLength(0);
    },
  },
  {
    line: 76,
    owner: 'main',
    name: 'a delete while the delivery waits out a backoff leaves no record and runs nothing more',
    check: async () => {
      const h = harness({ backoff: 1_000, run: () => Promise.reject(new Error('Slack is down')) });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await waitUntil(() => h.held.length === 1, { message: 'the backoff wait' });
      expect(await h.hooks.delete(hook.id)).toBe(true);
      h.releaseWaits();
      await h.drain();
      expect(await createHookStore(h.kv).listStoredDeliveries()).toEqual([]);
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 77,
    owner: 'main',
    name: 'a delete removes the deliveries that are pending and not being driven',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const first: Harness = harness({
        kv,
        run: () => {
          first.shutdown();
          return Promise.reject(new Error('the process is stopping'));
        },
      });
      const hook = await first.hook();
      await first.open();
      first.dispatch();
      await first.drain();
      expect(await first.status(hook.id)).toBe('pending');
      expect(await first.hooks.delete(hook.id)).toBe(true);
      expect(await createHookStore(kv).listStoredDeliveries()).toEqual([]);
      expect(await createHookStore(kv).listPendingDeliveryIds()).toEqual([]);
    },
  },
  {
    line: 78,
    owner: 'main',
    name: 'a retry after a delete is a no-op',
    check: async () => {
      const h = harness();
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const delivery = await h.only(hook.id);
      await h.hooks.delete(hook.id);
      expect(await h.hooks.retryDelivery(hook.id, delivery.id)).toBeUndefined();
      expect(await createHookStore(h.kv).listStoredDeliveries()).toEqual([]);
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 82,
    owner: 'main',
    name: 'a shutdown while the delivery waits out a backoff releases its lease and makes no attempt',
    check: async () => {
      const h = harness({ backoff: 1_000, run: () => Promise.reject(new Error('Slack is down')) });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await waitUntil(() => h.held.length === 1, { message: 'the backoff wait' });
      h.shutdown();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.leaseUntil).toBe(0);
      expect(outcomes(record)).toEqual(['error']);
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 83,
    owner: 'main',
    name: 'a new event during shutdown starts no delivery, even for a hook that is waiting out a backoff',
    check: async () => {
      const h = harness({ backoff: 1_000, run: () => Promise.reject(new Error('Slack is down')) });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await waitUntil(() => h.held.length === 1, { message: 'the backoff wait' });
      h.shutdown();
      h.dispatch();
      await h.drain();
      expect(await h.deliveries(hook.id)).toHaveLength(1);
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 84,
    owner: 'main',
    name: 'a shutdown cancels the re-scan scheduled for a delivery whose lease was live',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const clock = { milliseconds: START };
      const first = harness({ kv, clock, run: never });
      const hook = await first.hook();
      await first.open();
      first.dispatch();
      await runStarted(first);
      const second = harness({ kv, clock });
      await second.open();
      expect(second.held).toHaveLength(1);
      second.shutdown();
      await second.drain();
      // The wait ended early, the re-scan stopped, and nothing was taken.
      expect(second.calls).toHaveLength(0);
      const record = await first.record(hook.id);
      expect(record.status).toBe('pending');
      expect(outcomes(record)).toEqual(['sending']);
    },
  },
  {
    line: 85,
    owner: 'main',
    name: 'a pending delivery whose lease expired is claimed after a restart: the sending attempt is interrupted and a new one made',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const clock = { milliseconds: START };
      const hang = new Promise<void>(() => undefined);
      const first = harness({ kv, clock, run: () => hang });
      const hook = await first.hook();
      await first.open();
      first.dispatch();
      await waitUntil(() => first.calls.length === 1, { message: 'the hung run' });
      clock.milliseconds += 1_000_000;
      const second = harness({ kv, clock });
      await second.open();
      await second.drain();
      const delivery = await second.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['interrupted', 'completed']);
      expect(second.calls[0]?.idempotencyKey).toBe(`hook:${hook.id}:${delivery.id}`);
    },
  },
  {
    line: 88,
    owner: 'main',
    name: 'interrupted attempts that fill maxAttempts leave the delivery exhausted without a send',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const hook = await harness({ kv }).hook();
      const store = createHookStore(kv);
      await store.createDelivery({
        version: 1,
        id: 'hook-delivery-full',
        hookId: hook.id,
        owner: hook.owner,
        actionType: 'plugin',
        kind: 'run.settled',
        test: false,
        status: 'pending',
        work: {
          type: 'plugin',
          plugin: 'slack',
          kind: 'post-message',
          configuration: { channel: 'ops' },
          event: {
            kind: 'run.settled',
            bureauId: 'matrix-bureau',
            emittedAtMs: START,
            payload: {},
          },
        },
        attempts: [1, 2, 3].map((number) => ({
          number,
          startedAt: START,
          finishedAt: START,
          outcome: 'interrupted' as const,
        })),
        maxAttempts: 3,
        createdAt: START,
        updatedAt: START,
        leaseUntil: 0,
        revision: 0,
      });
      const second = harness({ kv });
      await second.open();
      await second.drain();
      expect(await second.status(hook.id)).toBe('exhausted');
      expect(second.calls).toHaveLength(0);
    },
  },
];

/** The rows of COR-2174 (R3, permanent reaction failures). */
const PERMANENT_ROWS: readonly Row[] = [
  {
    line: 49,
    owner: 'COR-2174',
    name: 'a PluginReactionError that is not permanent: true is a plain rejection, retried and then exhausted',
    check: async () => {
      const failures: Array<() => Error> = [
        () => new PluginReactionError('Slack is down'),
        () => new PluginReactionError('Slack is down', { permanent: false }),
        () => Object.assign(new PluginReactionError('Slack is down'), { permanent: 'yes' }),
      ];
      for (const failure of failures) {
        const h = harness({ run: () => Promise.reject(failure()) });
        const hook = await h.hook();
        await h.open();
        h.dispatch();
        await h.drain();
        const delivery = await h.only(hook.id);
        expect(delivery.status).toBe('exhausted');
        expect(outcomes(delivery)).toEqual(['error', 'error', 'error']);
        expect(delivery.attempts[0]?.error).toBe('Slack is down');
      }
    },
  },
  {
    line: 50,
    owner: 'COR-2174',
    name: 'a permanent failure on the first attempt ends the delivery failed after one rejected attempt',
    check: async () => {
      const h = harness({
        run: () => Promise.reject(new PluginReactionError('No such channel', { permanent: true })),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('failed');
      expect(outcomes(delivery)).toEqual(['rejected']);
      expect(delivery.attempts[0]?.error).toBe('No such channel');
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 51,
    owner: 'COR-2174',
    name: 'a permanent failure mid-retry ends the delivery failed: the earlier error attempts and one rejected',
    check: async () => {
      const h = harness({
        run: (_context, call) =>
          Promise.reject(
            call === 1
              ? new Error('Slack is down')
              : new PluginReactionError('No such channel', { permanent: true }),
          ),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('failed');
      expect(outcomes(delivery)).toEqual(['error', 'rejected']);
    },
  },
  {
    line: 52,
    owner: 'COR-2174',
    name: 'a permanent failure on the last attempt is failed, and is not audited as exhausted',
    check: async () => {
      const h = harness({
        run: (_context, call) =>
          Promise.reject(
            call < 3
              ? new Error('Slack is down')
              : new PluginReactionError('No such channel', { permanent: true }),
          ),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('failed');
      expect(outcomes(delivery)).toEqual(['error', 'error', 'rejected']);
      expect(h.audits).not.toContain('hook.delivery.exhausted');
    },
  },
  {
    line: 53,
    owner: 'COR-2174',
    name: 'a permanent failure from a folder plugin’s own copy of the class is mapped by its name and shape',
    check: async () => {
      // A plugin loaded from a folder bundles its own copy of the package, so `instanceof` fails.
      class PluginReactionError extends Error {
        readonly permanent = true;
        constructor(message: string) {
          super(message);
          this.name = 'PluginReactionError';
        }
      }
      const h = harness({ run: () => Promise.reject(new PluginReactionError('No such channel')) });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('failed');
      expect(outcomes(delivery)).toEqual(['rejected']);
    },
  },
  {
    line: 54,
    owner: 'main',
    name: 'a permanent failure thrown while the process shuts down is interrupted, and the lease is released',
    check: async () => {
      const h: Harness = harness({
        run: () => {
          h.shutdown();
          return Promise.reject(new PluginReactionError('No such channel', { permanent: true }));
        },
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.leaseUntil).toBe(0);
      expect(outcomes(record)).toEqual(['interrupted']);
    },
  },
];

/** The rows of COR-2175 (R4, the timeout, and the abort on a disable or a delete). */
const ABORT_ROWS: readonly Row[] = [
  {
    line: 45,
    owner: 'COR-2175',
    name: 'a run that settles first is delivered; when the shutdown signal wins the race the attempt is interrupted and re-run under the same key',
    check: async () => {
      const settled = harness();
      const settledHook = await settled.hook();
      await settled.open();
      settled.dispatch();
      await settled.drain();
      expect(await settled.status(settledHook.id)).toBe('delivered');

      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const first: Harness = harness({
        kv,
        run: () => {
          // The signal aborts before the run answers: the shutdown wins.
          first.shutdown();
          return Promise.resolve();
        },
      });
      const hook = await first.hook();
      await first.open();
      first.dispatch();
      await first.drain();
      const interrupted = await first.record(hook.id);
      expect(interrupted.status).toBe('pending');
      expect(interrupted.leaseUntil).toBe(0);
      expect(outcomes(interrupted)).toEqual(['interrupted']);

      const second = harness({ kv });
      await second.open();
      await second.drain();
      const delivery = await second.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['interrupted', 'completed']);
      expect(second.calls[0]?.idempotencyKey).toBe(first.calls[0]?.idempotencyKey);
    },
  },
  {
    line: 46,
    owner: 'COR-2175',
    name: 'a run that settles before a disable is delivered: only an attempt still in flight is aborted',
    check: async () => {
      const h = harness();
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      await h.hooks.update(hook.id, { enabled: false });
      expect(await h.status(hook.id)).toBe('delivered');
      expect(h.calls[0]?.signal.aborted).toBe(false);
    },
  },
  {
    line: 56,
    owner: 'COR-2175',
    name: 'a run that exceeds its timeout has its signal aborted, the attempt closes error, and it is retried',
    check: async () => {
      const h = harness({
        backoff: 1_000,
        run: (context, call) => (call === 1 ? untilAborted(context) : Promise.resolve()),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await waitUntil(() => h.timeouts.length === 1 && h.calls.length === 1, {
        message: 'the first attempt and its timeout',
      });
      expect(h.calls[0]?.signal.aborted).toBe(false);
      h.timeouts[0]!.fire();
      await waitUntil(() => h.held.length === 1, { message: 'the backoff wait' });
      expect(h.calls[0]?.signal.aborted).toBe(true);
      const waiting = await h.record(hook.id);
      expect(waiting.status).toBe('pending');
      expect(waiting.nextAttemptAt).toBe(START + 1_000);
      expect(waiting.attempts[0]).toMatchObject({
        outcome: 'error',
        error: `The reaction timed out after ${DEFAULT_TIMEOUT} ms`,
      });
      h.releaseWaits();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['error', 'completed']);
    },
  },
  {
    line: 57,
    owner: 'COR-2175',
    name: 'a timeout on the last attempt is exhausted',
    check: async () => {
      const h = harness({ run: untilAborted });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      for (const attempt of [1, 2, 3]) {
        await waitUntil(() => h.timeouts.length === attempt && h.calls.length === attempt, {
          message: `attempt ${attempt} and its timeout`,
        });
        h.timeouts[attempt - 1]!.fire();
      }
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('exhausted');
      expect(outcomes(delivery)).toEqual(['error', 'error', 'error']);
      expect(h.audits).toContain('hook.delivery.exhausted');
    },
  },
  {
    line: 58,
    owner: 'COR-2175',
    name: 'without a timeoutMilliseconds the run is given the request timeout, the configured one or the default',
    check: async () => {
      const byDefault = harness();
      await byDefault.hook();
      await byDefault.open();
      byDefault.dispatch();
      await byDefault.drain();
      expect(byDefault.timeouts.map((timeout) => timeout.milliseconds)).toEqual([DEFAULT_TIMEOUT]);

      const configured = harness({ requestTimeoutMilliseconds: 7_000 });
      await configured.hook();
      await configured.open();
      configured.dispatch();
      await configured.drain();
      expect(configured.timeouts.map((timeout) => timeout.milliseconds)).toEqual([7_000]);

      const own = harness({ requestTimeoutMilliseconds: 7_000, timeoutMilliseconds: 2_500 });
      await own.hook();
      await own.open();
      own.dispatch();
      await own.drain();
      expect(own.timeouts.map((timeout) => timeout.milliseconds)).toEqual([2_500]);
    },
  },
  {
    line: 59,
    owner: 'COR-2175',
    // Composition skips the plugin first (`compose-plugins.test.ts`, and the Bureau test in
    // `hooks-plugin-actions.test.ts`); this is the defence for a registration that arrives by another path.
    name: 'a timeoutMilliseconds that is not a positive safe integer still makes createHooks throw, for a registration that did not come through composition',
    check: () => {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
        expect(() => harness({ timeoutMilliseconds: value })).toThrow(
          'Hook action kind "slack/post-message" has a timeoutMilliseconds that is not a positive safe integer',
        );
      }
      expect(() => harness({ timeoutMilliseconds: 1 })).not.toThrow();
      return Promise.resolve();
    },
  },
  {
    line: 60,
    owner: 'COR-2175',
    name: 'a run that ignores its signal is still ended by a timeout and by a disable',
    check: async () => {
      const timedOut = harness({
        run: (_context, call) => (call === 1 ? never() : Promise.resolve()),
      });
      const timedOutHook = await timedOut.hook();
      await timedOut.open();
      timedOut.dispatch();
      await waitUntil(() => timedOut.timeouts.length === 1, { message: 'the timeout' });
      timedOut.timeouts[0]!.fire();
      await timedOut.drain();
      const retried = await timedOut.only(timedOutHook.id);
      expect(retried.status).toBe('delivered');
      expect(outcomes(retried)).toEqual(['error', 'completed']);

      const disabled = harness({ run: never });
      const disabledHook = await disabled.hook();
      await disabled.open();
      disabled.dispatch();
      await runStarted(disabled);
      await disabled.hooks.update(disabledHook.id, { enabled: false });
      await disabled.drain();
      const aborted = await disabled.only(disabledHook.id);
      expect(aborted.status).toBe('aborted');
      expect(outcomes(aborted)).toEqual(['error']);
    },
  },
  {
    line: 61,
    owner: 'COR-2175',
    name: 'a run that rejects permanently after its timeout aborted is classified as the timeout: error, retried',
    check: async () => {
      const h = harness({
        run: (context, call) =>
          call === 1
            ? new Promise<void>((_resolve, reject) => {
                context.signal.addEventListener(
                  'abort',
                  () => reject(new PluginReactionError('Too late', { permanent: true })),
                  { once: true },
                );
              })
            : Promise.resolve(),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await waitUntil(() => h.timeouts.length === 1 && h.calls.length === 1, {
        message: 'the run',
      });
      h.timeouts[0]!.fire();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['error', 'completed']);
      expect(delivery.attempts[0]?.error).toBe(
        `The reaction timed out after ${DEFAULT_TIMEOUT} ms`,
      );
    },
  },
  {
    line: 62,
    owner: 'COR-2175',
    name: 'a timeout that fires during a shutdown is an interrupted attempt: the shutdown is checked first',
    check: async () => {
      const h = harness({ run: untilAborted });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await waitUntil(() => h.timeouts.length === 1 && h.calls.length === 1, {
        message: 'the run',
      });
      h.timeouts[0]!.fire();
      h.shutdown();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.leaseUntil).toBe(0);
      expect(outcomes(record)).toEqual(['interrupted']);
    },
  },
  {
    // Not a matrix line: the "Open" list of the matrix, accepted by the coordinator's decision.
    line: 0,
    owner: 'COR-2175',
    name: 'a timeout that coincides with a disable is read as the disable: the delivery ends aborted with no backoff',
    check: async () => {
      const h: Harness = harness({
        backoff: 1_000,
        run: (context) => {
          // The timeout fires as the signal aborts for the disable, so both are set when the
          // attempt ends and the order the causes are read in decides the answer.
          context.signal.addEventListener('abort', () => h.timeouts[0]!.fire(), { once: true });
          return never();
        },
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await runStarted(h);
      await h.hooks.update(hook.id, { enabled: false });
      await h.drain();
      expect(h.calls[0]?.signal.aborted).toBe(true);
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('aborted');
      expect(delivery.attempts[0]).toMatchObject({
        outcome: 'error',
        error: 'The hook was disabled',
      });
      expect(h.held).toEqual([]);
    },
  },
  {
    line: 64,
    owner: 'COR-2175',
    name: 'a disable aborts a plugin attempt in flight: the attempt closes error and the delivery finishes aborted',
    check: async () => {
      const h = harness({ backoff: 1_000, run: untilAborted });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await runStarted(h);
      await h.hooks.update(hook.id, { enabled: false });
      await h.drain();
      expect(h.calls[0]?.signal.aborted).toBe(true);
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('aborted');
      expect(delivery.attempts).toHaveLength(1);
      expect(delivery.attempts[0]).toMatchObject({
        outcome: 'error',
        error: 'The hook was disabled',
      });
      expect(h.held).toEqual([]);
    },
  },
  {
    line: 65,
    owner: 'COR-2175',
    name: 'a disable on the last attempt finishes aborted before the exhaustion check, with no audit',
    check: async () => {
      const h = harness({ maxAttempts: 1, run: untilAborted });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await runStarted(h);
      await h.hooks.update(hook.id, { enabled: false });
      await h.drain();
      expect(await h.status(hook.id)).toBe('aborted');
      expect(h.audits).not.toContain('hook.delivery.exhausted');
    },
  },
  {
    line: 66,
    owner: 'COR-2175',
    name: 'a disable mid-retry finishes aborted with no backoff',
    check: async () => {
      const h = harness({
        backoff: 1_000,
        run: (context, call) =>
          call === 1 ? Promise.reject(new Error('Slack is down')) : untilAborted(context),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await waitUntil(() => h.held.length === 1, { message: 'the first backoff wait' });
      h.releaseWaits();
      await runStarted(h, 2);
      await h.hooks.update(hook.id, { enabled: false });
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('aborted');
      expect(outcomes(delivery)).toEqual(['error', 'error']);
      expect(h.held).toEqual([]);
    },
  },
  {
    line: 67,
    owner: 'COR-2175',
    name: 'a disable that commits after the delivery read the hook but before its attempt registered still aborts it',
    check: async () => {
      const inner = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      let hookReads = 0;
      let disable: (() => Promise<unknown>) | undefined;
      // The second read of the hook after the test arms this is the delivery's own: the disable
      // commits right after it, so the delivery holds a hook that is no longer current.
      const kv = new Proxy(inner, {
        get(target, property) {
          const member: unknown = Reflect.get(target, property);
          if (property !== 'get') {
            return typeof member === 'function'
              ? (member as (...args: unknown[]) => unknown).bind(target)
              : member;
          }
          return async (key: string) => {
            const value = await target.get(key);
            if (disable !== undefined && key.startsWith(HOOK_KEY_PREFIX)) {
              hookReads += 1;
              if (hookReads === 2) {
                const commit = disable;
                disable = undefined;
                await commit();
              }
            }
            return value;
          };
        },
      });
      const h = harness({ kv, run: untilAborted });
      const hook = await h.hook();
      await h.open();
      disable = () => h.hooks.update(hook.id, { enabled: false });
      h.dispatch();
      await h.drain();
      expect(hookReads).toBeGreaterThanOrEqual(2);
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('aborted');
      expect(h.calls).toHaveLength(0);
    },
  },
  {
    line: 70,
    owner: 'COR-2175',
    name: 'a disable in another process aborts nothing here: this process sees it at its next pass',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const clock = { milliseconds: START };
      const answer = deferred();
      const a = harness({
        kv,
        clock,
        backoff: 1_000,
        run: (_context, call) => (call === 1 ? answer.promise : Promise.resolve()),
      });
      const hook = await a.hook();
      await a.open();
      a.dispatch();
      await runStarted(a);
      const b = harness({ kv, clock });
      await b.hooks.update(hook.id, { enabled: false });
      expect(a.calls[0]?.signal.aborted).toBe(false);
      answer.reject(new Error('Slack is down'));
      await waitUntil(() => a.held.length === 1, { message: 'the backoff wait' });
      a.releaseWaits();
      await a.drain();
      const delivery = await a.only(hook.id);
      expect(delivery.status).toBe('aborted');
      expect(outcomes(delivery)).toEqual(['error']);
      expect(a.calls).toHaveLength(1);
    },
  },
  {
    line: 71,
    owner: 'COR-2175',
    name: 'a disable while a webhook request is in flight leaves the request alone: it completes',
    check: async () => {
      const response = deferred<Response>();
      let requests = 0;
      const h = harness({
        keys: await generateEncryptionKey(),
        fetch: (() => {
          requests += 1;
          return response.promise;
        }) as unknown as typeof fetch,
      });
      const hook = await h.created.hooks.create({
        events: ['run.settled'],
        url: 'https://example.com/hook',
        signingSecret: 'a-signing-secret-long-enough',
      });
      await h.open();
      h.dispatch();
      await waitUntil(() => requests === 1, { message: 'the request' });
      await h.hooks.update(hook.id, { enabled: false });
      response.resolve(new Response('ok'));
      await h.drain();
      expect(await h.status(hook.id)).toBe('delivered');
    },
  },
  {
    line: 72,
    owner: 'COR-2175',
    name: 'an update that leaves the hook enabled aborts nothing',
    check: async () => {
      const answer = deferred();
      const h = harness({
        run: (_context, call) => (call === 1 ? answer.promise : Promise.resolve()),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await runStarted(h);
      await h.hooks.update(hook.id, { name: 'Renamed', enabled: true });
      expect(h.calls[0]?.signal.aborted).toBe(false);
      answer.resolve();
      await h.drain();
      expect(await h.status(hook.id)).toBe('delivered');
    },
  },
  {
    line: 73,
    owner: 'COR-2175',
    name: 'a disable that loses its compare-and-swap aborts nothing',
    check: async () => {
      const answer = deferred();
      const h = harness({
        run: (_context, call) => (call === 1 ? answer.promise : Promise.resolve()),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await runStarted(h);
      await h.hooks.update(hook.id, { name: 'Renamed' });
      const refused = await h.hooks
        .update(hook.id, { enabled: false, expectedRevision: hook.revision })
        .catch((thrown: unknown) => thrown);
      expect(refused).toBeInstanceOf(HookError);
      expect((refused as HookError).code).toBe('stale-revision');
      expect(h.calls[0]?.signal.aborted).toBe(false);
      answer.resolve();
      await h.drain();
      expect(await h.status(hook.id)).toBe('delivered');
    },
  },
  {
    line: 74,
    owner: 'COR-2175',
    name: 'a disable followed by a re-enable aborts the delivery for good',
    check: async () => {
      const h = harness({ run: untilAborted });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await runStarted(h);
      await h.hooks.update(hook.id, { enabled: false });
      await h.hooks.update(hook.id, { enabled: true });
      await h.drain();
      expect(await h.status(hook.id)).toBe('aborted');
      await h.open();
      await h.drain();
      expect(await h.status(hook.id)).toBe('aborted');
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 75,
    owner: 'COR-2175',
    name: 'a delete aborts a plugin attempt in flight and leaves no delivery',
    check: async () => {
      const h = harness({ backoff: 1_000, run: untilAborted });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await runStarted(h);
      expect(await h.hooks.delete(hook.id)).toBe(true);
      await h.drain();
      expect(h.calls[0]?.signal.aborted).toBe(true);
      expect(await createHookStore(h.kv).listStoredDeliveries()).toEqual([]);
      expect(await createHookStore(h.kv).listPendingDeliveryIds()).toEqual([]);
      expect(h.held).toEqual([]);
    },
  },
  {
    line: 79,
    owner: 'COR-2175',
    name: 'a delete in another process aborts nothing here: this process loses the fence and writes nothing',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const clock = { milliseconds: START };
      const answer = deferred();
      const a = harness({ kv, clock, run: () => answer.promise });
      const hook = await a.hook();
      await a.open();
      a.dispatch();
      await runStarted(a);
      const b = harness({ kv, clock });
      expect(await b.hooks.delete(hook.id)).toBe(true);
      expect(a.calls[0]?.signal.aborted).toBe(false);
      answer.resolve();
      await a.drain();
      expect(await createHookStore(kv).listStoredDeliveries()).toEqual([]);
      expect(await createHookStore(kv).listPendingDeliveryIds()).toEqual([]);
    },
  },
  {
    line: 80,
    owner: 'COR-2175',
    name: 'a shutdown aborts the signal of a run in flight, which rejects: the attempt is interrupted and the lease released',
    check: async () => {
      const h: Harness = harness({
        run: (context) => {
          h.shutdown();
          return Promise.reject(new Error(`stopping, aborted: ${String(context.signal.aborted)}`));
        },
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      expect(h.calls[0]?.signal.aborted).toBe(true);
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.leaseUntil).toBe(0);
      expect(outcomes(record)).toEqual(['interrupted']);
    },
  },
  {
    line: 81,
    owner: 'COR-2175',
    name: 'a shutdown ends an attempt whose run ignores the signal: interrupted, the lease released',
    check: async () => {
      const h = harness({ run: never });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await runStarted(h);
      h.shutdown();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.leaseUntil).toBe(0);
      expect(outcomes(record)).toEqual(['interrupted']);
    },
  },
  {
    line: 86,
    owner: 'COR-2175',
    name: 'a restart that finds the lease live schedules one re-scan at the expiry the record’s own lease gives',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const clock = { milliseconds: START };
      const a = harness({ kv, clock, requestTimeoutMilliseconds: 20_000, run: never });
      await a.hook();
      await a.open();
      a.dispatch();
      await runStarted(a);
      clock.milliseconds += 5_000;
      const b = harness({ kv, clock, requestTimeoutMilliseconds: 20_000 });
      await b.open();
      expect(b.calls).toHaveLength(0);
      // The lease: the request timeout, the longest backoff (none here) and the 5-second margin.
      expect(b.held.map((wait) => wait.milliseconds)).toEqual([20_000 + 5_000 - 5_000]);
    },
  },
  {
    line: 87,
    owner: 'COR-2175',
    name: 'a re-scan never takes a delivery whose run is still inside its own timeout',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const clock = { milliseconds: START };
      const longTimeout = 60_000;
      const a = harness({ kv, clock, timeoutMilliseconds: longTimeout, run: never });
      const hook = await a.hook();
      await a.open();
      a.dispatch();
      await runStarted(a);
      const held = await a.record(hook.id);
      expect(held.leaseUntil).toBe(START + longTimeout + 5_000);
      // Past the lease a run with the default timeout would hold, still inside this one's timeout.
      clock.milliseconds += 20_000;
      const b = harness({ kv, clock, timeoutMilliseconds: longTimeout });
      await b.open();
      expect(b.calls).toHaveLength(0);
      expect(b.held.map((wait) => wait.milliseconds)).toEqual([longTimeout + 5_000 - 20_000]);
      clock.milliseconds += longTimeout + 5_000 - 20_000;
      b.releaseWaits();
      await b.drain();
      const delivery = await b.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['interrupted', 'completed']);
    },
  },
];

/** What the secret gate's wrapper throws when a reaction is called while its plugin needs setup. */
const needsSetup = () =>
  Object.assign(new Error('"post-message" is not available: plugin "slack" needs setup'), {
    name: 'PluginNeedsSetupError',
  });

/** Waits until every delivery of the harness is released: pending, with no lease. */
const released = (h: Harness, count = 1) =>
  waitUntil(
    async () => {
      const stored = await createHookStore(h.kv).listStoredDeliveries();
      return (
        stored.length === count &&
        stored.every(({ record }) => record.status === 'pending' && record.leaseUntil === 0)
      );
    },
    { message: `${count} deliveries to be released` },
  );

/** The rows of COR-2176 (R5, a missing secret makes deliveries wait). */
const NEEDS_SETUP_ROWS: readonly Row[] = [
  {
    line: 89,
    owner: 'COR-2176',
    name: 'a delivery of a plugin that needs setup makes no attempt, sets no nextAttemptAt and releases its lease',
    check: async () => {
      const gate = availabilityGate(false);
      const h = harness({ gate, backoff: 1_000 });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.attempts).toEqual([]);
      expect(record.nextAttemptAt).toBeUndefined();
      expect(record.leaseUntil).toBe(0);
      expect(h.calls).toHaveLength(0);
      expect(h.held).toEqual([]);
    },
  },
  {
    line: 90,
    owner: 'COR-2176',
    name: 'a secret removed during a backoff releases the delivery at the next pass: earlier attempts kept, none added',
    check: async () => {
      const gate = availabilityGate(true);
      const h = harness({
        gate,
        backoff: 1_000,
        run: (_context, call) =>
          call === 1 ? Promise.reject(new Error('Slack is down')) : Promise.resolve(),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await waitUntil(() => h.held.length === 1, { message: 'the backoff wait' });
      gate.set(false);
      h.releaseWaits();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.leaseUntil).toBe(0);
      expect(outcomes(record)).toEqual(['error']);
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 91,
    owner: 'COR-2176',
    name: 'a delivery whose last attempt is still owed waits for the secret instead of exhausting',
    check: async () => {
      const gate = availabilityGate(true);
      const h = harness({
        gate,
        run: (_context, call) => {
          // Two attempts fail, and the secret goes before the third.
          if (call === 2) gate.set(false);
          return Promise.reject(new Error('Slack is down'));
        },
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.leaseUntil).toBe(0);
      expect(outcomes(record)).toEqual(['error', 'error']);
      expect(h.audits).not.toContain('hook.delivery.exhausted');
    },
  },
  {
    line: 92,
    owner: 'COR-2176',
    name: 'a gate that turns needs-setup between the check and run does not count the attempt: it is dropped and the lease released',
    check: async () => {
      const gate = availabilityGate(true);
      const h = harness({ gate, run: () => Promise.reject(needsSetup()) });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.leaseUntil).toBe(0);
      expect(record.attempts).toEqual([]);
      expect(record.nextAttemptAt).toBeUndefined();
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 93,
    owner: 'main',
    name: 'a missing secret while the process shuts down is an interrupted attempt',
    check: async () => {
      const gate = availabilityGate(true);
      const h: Harness = harness({
        gate,
        run: () => {
          h.shutdown();
          return Promise.reject(needsSetup());
        },
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.leaseUntil).toBe(0);
      expect(outcomes(record)).toEqual(['interrupted']);
    },
  },
  {
    line: 94,
    owner: 'COR-2176',
    name: 'a delivery waiting for a secret is claimed by the boot scan after a restart and released again with no attempt',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const clock = { milliseconds: START };
      const first = harness({ kv, clock, gate: availabilityGate(false) });
      const hook = await first.hook();
      await first.open();
      first.dispatch();
      await first.drain();
      const before = await first.record(hook.id);

      const second = harness({ kv, clock, gate: availabilityGate(false) });
      await second.open();
      await second.drain();
      const after = await second.record(hook.id);
      expect(after.status).toBe('pending');
      expect(after.attempts).toEqual([]);
      expect(after.leaseUntil).toBe(0);
      // Claimed, then released: two writes, and no attempt.
      expect(after.revision).toBe(before.revision + 2);
      expect(second.calls).toHaveLength(0);
    },
  },
  {
    line: 95,
    owner: 'COR-2176',
    name: 'a secret that is never saved leaves the delivery pending for as long as it is missing: it is never pruned',
    check: async () => {
      const h = harness({ gate: availabilityGate(false) });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      h.clock.milliseconds += 365 * 24 * 60 * 60 * 1_000;
      expect(await h.created.prune(0)).toBe(0);
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.attempts).toEqual([]);
    },
  },
  {
    line: 96,
    owner: 'COR-2176',
    name: 'a delivery waiting for a secret whose hook is disabled is aborted: the hook checks come first',
    check: async () => {
      const h = harness({ gate: availabilityGate(false) });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      await h.hooks.update(hook.id, { enabled: false });
      await h.open();
      await h.drain();
      expect(await h.status(hook.id)).toBe('aborted');
      expect(h.calls).toHaveLength(0);
    },
  },
  {
    line: 97,
    owner: 'COR-2176',
    name: 'a delivery waiting for a secret whose version pin changed waits, then fails on the version once it is available',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const clock = { milliseconds: START };
      const first = harness({ kv, clock, version: '1.0.0', gate: availabilityGate(false) });
      const hook = await first.hook();
      await first.open();
      first.dispatch();
      await first.drain();

      const gate = availabilityGate(false);
      const second = harness({ kv, clock, version: '2.0.0', gate });
      await second.open();
      await second.drain();
      expect(await second.status(hook.id)).toBe('pending');
      gate.set(true);
      await waitUntil(async () => (await second.status(hook.id)) === 'failed', {
        message: 'the delivery to fail on its version',
      });
      await second.drain();
      const delivery = await second.only(hook.id);
      expect(delivery.attempts.at(-1)?.error).toContain('version-mismatch');
      expect(second.calls).toHaveLength(0);
    },
  },
  {
    line: 98,
    owner: 'COR-2176',
    name: 'a registration with no availability counts as available',
    check: async () => {
      const h = harness();
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      expect(await h.status(hook.id)).toBe('delivered');
    },
  },
  {
    line: 99,
    owner: 'COR-2176',
    name: 'a secret saved later drives the waiting delivery without a restart: delivered after one attempt',
    check: async () => {
      const gate = availabilityGate(false);
      const h = harness({ gate });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      expect(await h.status(hook.id)).toBe('pending');
      gate.set(true);
      await waitUntil(async () => (await h.status(hook.id)) === 'delivered', {
        message: 'the delivery to be made',
      });
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(outcomes(delivery)).toEqual(['completed']);
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 100,
    owner: 'COR-2176',
    name: 'a secret saved before the hooks are open does nothing: the boot resume takes the delivery',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const clock = { milliseconds: START };
      const first = harness({ kv, clock, gate: availabilityGate(false) });
      const hook = await first.hook();
      await first.open();
      first.dispatch();
      await first.drain();
      // The first process made no attempt: the delivery waits for the secret.
      expect(first.calls).toHaveLength(0);
      expect(await first.status(hook.id)).toBe('pending');

      const gate = availabilityGate(false);
      const second = harness({ kv, clock, gate });
      gate.set(true);
      // Nothing was started: the hooks are still held until `resume()`.
      expect(second.tracked).toEqual([]);
      expect(second.calls).toHaveLength(0);
      await second.open();
      await second.drain();
      // The boot resume made the one attempt, and it is the only one.
      expect(second.calls).toHaveLength(1);
      const delivery = await second.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['completed']);
    },
  },
  {
    line: 101,
    owner: 'COR-2176',
    name: 'a secret saved while the delivery’s release write is in flight is still delivered, at the lease’s expiry, with no restart',
    check: async () => {
      const gate = availabilityGate(false);
      const inner = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      let beforeRelease: (() => Promise<void>) | undefined;
      // The write that releases the lease is held until the secret is saved and the scan it starts
      // has met the record as it still stands, with a live lease.
      const kv = new Proxy(inner, {
        get(target, property) {
          const member: unknown = Reflect.get(target, property);
          if (property !== 'conditionalBatch') {
            return typeof member === 'function'
              ? (member as (...args: unknown[]) => unknown).bind(target)
              : member;
          }
          return async (
            conditions: Parameters<typeof target.conditionalBatch>[0],
            operations: Parameters<typeof target.conditionalBatch>[1],
          ) => {
            const releases = operations.some(
              (operation) => operation.type === 'set' && operation.value.includes('"leaseUntil":0'),
            );
            if (releases && beforeRelease !== undefined) {
              const hold = beforeRelease;
              beforeRelease = undefined;
              await hold();
            }
            return target.conditionalBatch(conditions, operations);
          };
        },
      });
      const h = harness({ kv, gate });
      const hook = await h.hook();
      await h.open();
      beforeRelease = async () => {
        gate.set(true);
        await waitUntil(() => h.held.length === 1, { message: 'the re-scan for the live lease' });
      };
      h.dispatch();
      await waitUntil(() => h.held.length === 1, { message: 'the re-scan to wait' });
      await released(h);
      expect(h.calls).toHaveLength(0);
      // The lease of the record the scan met was live; the re-scan waits for its expiry.
      h.clock.milliseconds += h.held[0]!.milliseconds;
      h.releaseWaits();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['completed']);
    },
  },
  {
    line: 102,
    owner: 'COR-2176',
    name: 'a secret saved while another delivery of this process is mid-attempt takes the waiting one and leaves the live lease alone',
    check: async () => {
      const gate = availabilityGate(true);
      const answer = deferred();
      const h = harness({
        gate,
        run: (_context, call) => (call === 1 ? answer.promise : Promise.resolve()),
      });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await runStarted(h);
      gate.set(false);
      h.dispatch();
      await waitUntil(
        async () => {
          const stored = await createHookStore(h.kv).listStoredDeliveries();
          return stored.some(
            ({ record }) => record.attempts.length === 0 && record.leaseUntil === 0,
          );
        },
        { message: 'the second delivery to wait' },
      );
      gate.set(true);
      await waitUntil(
        async () => {
          const found = await h.deliveries(hook.id);
          return found.some((delivery) => delivery.status === 'delivered');
        },
        { message: 'the waiting delivery to be made' },
      );
      // The first is still mid-attempt: its lease was live, so it was skipped, not taken.
      const [first] = await h.deliveries(hook.id);
      expect(first?.status).toBe('pending');
      expect(outcomes(first!)).toEqual(['sending']);
      answer.resolve();
      h.clock.milliseconds += 1_000_000;
      h.releaseWaits();
      await h.drain();
      const finished = await h.deliveries(hook.id);
      expect(finished.map((delivery) => delivery.status)).toEqual(['delivered', 'delivered']);
      expect(outcomes(finished[0]!)).toEqual(['completed']);
      expect(h.calls).toHaveLength(2);
    },
  },
  {
    line: 103,
    owner: 'main',
    name: 'an availability that flips several times has one driver: the delivery is made once',
    check: async () => {
      const gate = availabilityGate(false);
      const h = harness({ gate });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      gate.set(true);
      gate.set(true);
      gate.set(true);
      await waitUntil(async () => (await h.status(hook.id)) === 'delivered', {
        message: 'the delivery to be made',
      });
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(outcomes(delivery)).toEqual(['completed']);
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 104,
    owner: 'COR-2176',
    name: 'a secret removed again makes a new delivery wait, not fail',
    check: async () => {
      const gate = availabilityGate(true);
      const h = harness({ gate });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      gate.set(false);
      h.dispatch();
      await h.drain();
      const found = await h.deliveries(hook.id);
      expect(found.map((delivery) => delivery.status)).toEqual(['delivered', 'pending']);
      expect(found[1]?.attempts).toEqual([]);
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 105,
    owner: 'COR-2176',
    name: 'resume while another plugin still needs setup claims its deliveries and releases them again, with no attempt',
    check: async () => {
      const gate = availabilityGate(false);
      const h = harness({
        registrations: (run) => [
          {
            plugin: 'slack',
            kind: {
              name: 'post-message',
              description: 'Posts.',
              configuration: CONFIGURATION,
              run,
            },
          },
          {
            plugin: 'discord',
            ...gateRegistration(gate),
            kind: {
              name: 'post-message',
              description: 'Posts.',
              configuration: CONFIGURATION,
              run,
            },
          },
        ],
      });
      const slack = await h.created.hooks.create({ events: ['run.settled'], action: ACTION });
      const discord = await h.created.hooks.create({
        events: ['run.settled'],
        action: { ...ACTION, plugin: 'discord' },
      });
      await h.open();
      h.dispatch();
      await h.drain();
      expect(await h.status(slack.id)).toBe('delivered');
      const before = await h.record(discord.id);
      expect(before.status).toBe('pending');
      expect(before.attempts).toEqual([]);
      await h.open();
      await h.drain();
      const after = await h.record(discord.id);
      expect(after.status).toBe('pending');
      expect(after.attempts).toEqual([]);
      expect(after.leaseUntil).toBe(0);
      expect(after.revision).toBe(before.revision + 2);
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 106,
    owner: 'main',
    name: 'a retry of a waiting delivery is claimed and released again, with no attempt',
    check: async () => {
      const h = harness({ gate: availabilityGate(false) });
      const hook = await h.hook();
      await h.open();
      h.dispatch();
      await h.drain();
      const waiting = await h.only(hook.id);
      const retried = await h.hooks.retryDelivery(hook.id, waiting.id);
      expect(retried?.status).toBe('pending');
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.attempts).toEqual([]);
      expect(record.leaseUntil).toBe(0);
      expect(h.calls).toHaveLength(0);
    },
  },
];

/** The readers that cannot give `slack-token` a value: none, `undefined`, an empty string, a throw. */
const UNRESOLVABLE_READERS: ReadonlyArray<HooksDependencies['configurationSecrets']> = [
  undefined,
  { get: () => Promise.resolve(undefined) },
  { get: () => Promise.resolve('') },
  { get: () => Promise.reject(new Error(`vault says ${SENTINEL}`)) },
];

/** A configuration whose secret field holds the reference to `key`. */
const withToken = (token: unknown) => ({ channel: 'ops', token });

/** The rows of COR-2177 (R6, secret references in a reaction's configuration). */
const SECRET_REFERENCE_ROWS: readonly Row[] = [
  {
    line: 107,
    owner: 'COR-2177',
    name: 'a hook written with { "$secret": key } in a secret field stores exactly that reference on the hook and on every delivery, never a value',
    check: async () => {
      const reader = secretReader({ 'slack-token': SENTINEL, 'other-key': SENTINEL });
      const h = harness({
        configuration: SECRET_CONFIGURATION,
        configurationSecrets: reader,
        run: (_context, call) =>
          call === 1 ? Promise.reject(new Error('Slack is down')) : Promise.resolve(),
      });
      const hook = await h.hookWith(withToken(reference('slack-token')));
      expect(hook.action).toEqual({
        ...ACTION,
        configuration: withToken(reference('slack-token')),
      });
      const changed = await h.hooks.update(hook.id, {
        action: { ...ACTION, configuration: withToken(reference('other-key')) },
      });
      expect(changed?.action).toEqual({
        ...ACTION,
        configuration: withToken(reference('other-key')),
      });

      await h.open();
      h.dispatch();
      await h.drain();

      const stored = await createHookStore(h.kv).getHook(hook.id);
      const storedAction = stored?.record.action as { configuration?: { token?: unknown } };
      expect(storedAction.configuration?.token).toEqual({ $secret: 'other-key' });
      expect(Object.keys(storedAction.configuration?.token as object)).toEqual(['$secret']);
      const delivery = await h.record(hook.id);
      const work = delivery.work as { configuration?: { token?: unknown } };
      expect(work.configuration?.token).toEqual({ $secret: 'other-key' });
      expect(await rawStoreOf(h.kv)).not.toContain(SENTINEL);
      expect(delivery.status).toBe('delivered');
    },
  },
  {
    line: 108,
    owner: 'COR-2177',
    name: 'a plain value in a secret field is invalid at that field’s path, on create and on update, and the value is not echoed',
    check: async () => {
      const h = harness({ configuration: SECRET_CONFIGURATION });
      const refused = await h.refusalOf(withToken(SENTINEL));
      expect(refused?.code).toBe('invalid');
      expect(refused?.issues[0]?.path).toEqual(['action', 'configuration', 'token']);
      expect(JSON.stringify(refused?.issues)).not.toContain(SENTINEL);
      expect(await h.hooks.list()).toEqual([]);

      const hook = await h.hookWith(withToken(reference('slack-token')));
      const updated = await h.hooks
        .update(hook.id, { action: { ...ACTION, configuration: withToken(SENTINEL) } })
        .catch((thrown: unknown) => thrown);
      expect(updated).toBeInstanceOf(HookError);
      expect((updated as HookError).issues[0]?.path).toEqual(['action', 'configuration', 'token']);
      expect(await rawStoreOf(h.kv)).not.toContain(SENTINEL);
    },
  },
  {
    line: 109,
    owner: 'COR-2177',
    name: 'a reference with another property, or a key outside Bungalow’s pattern, is invalid at that path',
    check: async () => {
      const h = harness({ configuration: SECRET_CONFIGURATION });
      for (const value of [
        { $secret: 'slack-token', extra: 1 },
        { $secret: 'Slack-Token' },
        { $secret: '-slack' },
        { $secret: 'slack token' },
        { $secret: '' },
        { $secret: 5 },
        {},
        [],
        null,
      ]) {
        const refused = await h.refusalOf(withToken(value));
        expect(refused?.code).toBe('invalid');
        expect(refused?.issues[0]?.path).toEqual(['action', 'configuration', 'token']);
      }
      expect(await h.hooks.list()).toEqual([]);
    },
  },
  {
    line: 110,
    owner: 'COR-2177',
    name: 'a secret marker under items, anyOf or additionalProperties makes the write invalid at action.configuration',
    check: async () => {
      const marked = z.string().meta({ secret: true });
      // Each configuration is one the schema accepts, so only the marker's place refuses it.
      for (const [configuration, accepted] of [
        [z.object({ tokens: z.array(marked) }), { tokens: ['a-value'] }],
        [z.object({ token: marked.nullable() }), { token: 'a-value' }],
        [z.object({ tokens: z.record(z.string(), marked) }), { tokens: { first: 'a-value' } }],
      ] as const) {
        const h = harness({ configuration });
        const refused = await h.refusalOf(accepted);
        expect(refused?.code).toBe('invalid');
        expect(refused?.issues[0]?.path).toEqual(['action', 'configuration']);
      }
    },
  },
  {
    line: 111,
    owner: 'COR-2177',
    name: 'a secret field that is absent is allowed: only a field that is present is checked',
    check: async () => {
      const h = harness({ configuration: SECRET_CONFIGURATION });
      const hook = await h.hookWith({ channel: 'ops' });
      expect(hook.action).toEqual({ ...ACTION, configuration: { channel: 'ops' } });
    },
  },
  {
    line: 112,
    owner: 'COR-2177',
    name: 'a hook stored with a plain value in a field now marked secret fails its delivery permanently, naming the path, and the value never reaches run',
    check: async () => {
      const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
      const clock = { milliseconds: START };
      // Written when the field was not marked secret.
      const before = harness({
        kv,
        clock,
        configuration: z.object({ channel: z.string(), token: z.string() }),
      });
      const hook = await before.hookWith(withToken(SENTINEL));

      const reader = secretReader({ 'slack-token': SENTINEL });
      const h = harness({
        kv,
        clock,
        configuration: SECRET_CONFIGURATION,
        configurationSecrets: reader,
      });
      await h.open();
      h.dispatch();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('failed');
      expect(outcomes(delivery)).toEqual(['rejected']);
      expect(delivery.attempts[0]?.error).toContain('token');
      expect(delivery.attempts[0]?.error).not.toContain(SENTINEL);
      expect(h.calls).toHaveLength(0);
      expect(reader.reads).toEqual([]);
    },
  },
  {
    line: 113,
    owner: 'COR-2177',
    name: 'a resolvable reference is resolved for every attempt and substituted before the schema parses; run gets the value and the record keeps the reference',
    check: async () => {
      const reader = secretReader({ 'slack-token': SENTINEL });
      const h = harness({
        configuration: SECRET_CONFIGURATION,
        configurationSecrets: reader,
        run: (_context, call) =>
          call === 1 ? Promise.reject(new Error('Slack is down')) : Promise.resolve(),
      });
      const hook = await h.hookWith(withToken(reference('slack-token')));
      await h.open();
      h.dispatch();
      await h.drain();
      expect(h.calls.map((call) => call.configuration)).toEqual([
        { channel: 'ops', token: SENTINEL },
        { channel: 'ops', token: SENTINEL },
      ]);
      expect(reader.reads).toEqual(['slack-token', 'slack-token']);
      const record = await h.record(hook.id);
      expect(record.status).toBe('delivered');
      expect((record.work as { configuration?: unknown }).configuration).toEqual(
        withToken(reference('slack-token')),
      );
      expect(await rawStoreOf(h.kv)).not.toContain(SENTINEL);
    },
  },
  {
    line: 114,
    owner: 'COR-2177',
    name: 'a reference that cannot be resolved fails the attempt as retryable, with no fallback: no reader, undefined, an empty string, or a throw',
    check: async () => {
      for (const configurationSecrets of UNRESOLVABLE_READERS) {
        const h = harness({
          backoff: 1_000,
          configuration: SECRET_CONFIGURATION,
          ...(configurationSecrets === undefined ? {} : { configurationSecrets }),
        });
        const hook = await h.hookWith(withToken(reference('slack-token')));
        await h.open();
        h.dispatch();
        await waitUntil(() => h.held.length === 1, { message: 'the backoff wait' });
        const waiting = await h.record(hook.id);
        // Retryable: the attempt is an error, the delivery waits out a backoff, and nothing ran.
        expect(waiting.status).toBe('pending');
        expect(waiting.nextAttemptAt).toBe(START + 1_000);
        expect(outcomes(waiting)).toEqual(['error']);
        expect(waiting.attempts[0]?.error).toContain('slack-token');
        expect(JSON.stringify(waiting)).not.toContain(SENTINEL);
        expect(h.calls).toHaveLength(0);
        h.shutdown();
        await h.drain();
      }
    },
  },
  {
    line: 115,
    owner: 'COR-2177',
    name: 'a reference that cannot be resolved on the last attempt leaves the delivery exhausted, and audited',
    check: async () => {
      for (const configurationSecrets of UNRESOLVABLE_READERS) {
        const h = harness({
          configuration: SECRET_CONFIGURATION,
          ...(configurationSecrets === undefined ? {} : { configurationSecrets }),
        });
        const hook = await h.hookWith(withToken(reference('slack-token')));
        await h.open();
        h.dispatch();
        await h.drain();
        const delivery = await h.only(hook.id);
        expect(delivery.status).toBe('exhausted');
        expect(outcomes(delivery)).toEqual(['error', 'error', 'error']);
        expect(JSON.stringify(delivery)).not.toContain(SENTINEL);
        expect(h.calls).toHaveLength(0);
        expect(h.audits).toContain('hook.delivery.exhausted');
        expect(h.diagnostics.join('\n')).not.toContain(SENTINEL);
      }
    },
  },
  {
    line: 116,
    owner: 'COR-2177',
    name: 'a key published after an error attempt is resolved by the next attempt',
    check: async () => {
      const reader = secretReader();
      const h = harness({
        backoff: 1_000,
        configuration: SECRET_CONFIGURATION,
        configurationSecrets: reader,
      });
      const hook = await h.hookWith(withToken(reference('slack-token')));
      await h.open();
      h.dispatch();
      await waitUntil(() => h.held.length === 1, { message: 'the backoff wait' });
      reader.values.set('slack-token', SENTINEL);
      h.releaseWaits();
      await h.drain();
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['error', 'completed']);
      expect(h.calls[0]?.configuration).toEqual({ channel: 'ops', token: SENTINEL });
    },
  },
  {
    line: 117,
    owner: 'main',
    name: 'a key published after exhaustion leaves the delivery exhausted; a retry reopens one attempt',
    check: async () => {
      const reader = secretReader();
      const h = harness({ configuration: SECRET_CONFIGURATION, configurationSecrets: reader });
      const hook = await h.hookWith(withToken(reference('slack-token')));
      await h.open();
      h.dispatch();
      await h.drain();
      reader.values.set('slack-token', SENTINEL);
      expect(await h.status(hook.id)).toBe('exhausted');
      const exhausted = await h.only(hook.id);
      await h.hooks.retryDelivery(hook.id, exhausted.id);
      const delivery = await h.only(hook.id);
      expect(delivery.status).toBe('delivered');
      expect(outcomes(delivery)).toEqual(['error', 'error', 'error', 'completed']);
    },
  },
  {
    line: 118,
    owner: 'COR-2177',
    name: 'a value rotated between attempts: the later attempt gets the version published at that time',
    check: async () => {
      const reader = secretReader({ 'slack-token': 'first-version-0123456789' });
      const h = harness({
        configuration: SECRET_CONFIGURATION,
        configurationSecrets: reader,
        run: (_context, call) => {
          if (call !== 1) return Promise.resolve();
          reader.values.set('slack-token', 'second-version-0123456789');
          return Promise.reject(new Error('Slack is down'));
        },
      });
      await h.hookWith(withToken(reference('slack-token')));
      await h.open();
      h.dispatch();
      await h.drain();
      expect(h.calls.map((call) => (call.configuration as { token: string }).token)).toEqual([
        'first-version-0123456789',
        'second-version-0123456789',
      ]);
    },
  },
  {
    line: 119,
    owner: 'COR-2177',
    name: 'a resolved value inside a thrown message or a parse reason is removed from the attempt’s error',
    check: async () => {
      const thrower = harness({
        configuration: SECRET_CONFIGURATION,
        configurationSecrets: secretReader({ 'slack-token': SENTINEL }),
        run: () => Promise.reject(new Error(`Slack refused ${SENTINEL}, and again ${SENTINEL}`)),
      });
      const thrown = await thrower.hookWith(withToken(reference('slack-token')));
      await thrower.open();
      thrower.dispatch();
      await thrower.drain();
      const failed = await thrower.only(thrown.id);
      expect(failed.attempts.map((attempt) => attempt.error)).toEqual([
        'Slack refused [redacted], and again [redacted]',
        'Slack refused [redacted], and again [redacted]',
        'Slack refused [redacted], and again [redacted]',
      ]);
      expect(await rawStoreOf(thrower.kv)).not.toContain(SENTINEL);

      const parsing = harness({
        configuration: z.object({
          channel: z.string(),
          token: z
            .string()
            .meta({ secret: true })
            .superRefine((value, context) => {
              context.addIssue({ code: 'custom', message: `refused ${value}` });
            }),
        }),
        configurationSecrets: secretReader({ 'slack-token': SENTINEL }),
      });
      const parsed = await parsing.hookWith(withToken(reference('slack-token')));
      await parsing.open();
      parsing.dispatch();
      await parsing.drain();
      const refused = await parsing.only(parsed.id);
      expect(refused.status).toBe('failed');
      expect(refused.attempts[0]?.error).toContain('refused [redacted]');
      expect(await rawStoreOf(parsing.kv)).not.toContain(SENTINEL);
      expect(parsing.calls).toHaveLength(0);
    },
  },
  {
    line: 120,
    owner: 'COR-2177',
    name: 'hooks.list, hooks.get and the delivery reads carry the reference, never a value',
    check: async () => {
      const h = harness({
        configuration: SECRET_CONFIGURATION,
        configurationSecrets: secretReader({ 'slack-token': SENTINEL }),
      });
      const hook = await h.hookWith(withToken(reference('slack-token')));
      await h.open();
      h.dispatch();
      await h.drain();
      const listed = await h.hooks.list();
      const got = await h.hooks.get(hook.id);
      const deliveries = await h.hooks.deliveries(hook.id);
      for (const view of [listed, got, deliveries]) {
        const text = JSON.stringify(view);
        expect(text).not.toContain(SENTINEL);
        expect(text).toContain('"$secret":"slack-token"');
      }
      expect(await h.status(hook.id)).toBe('delivered');
    },
  },
  {
    line: 121,
    owner: 'COR-2177',
    name: 'a key the plugin did not declare may be referenced',
    check: async () => {
      const reader = secretReader({ 'a-key-nobody-declared': SENTINEL });
      const h = harness({ configuration: SECRET_CONFIGURATION, configurationSecrets: reader });
      const hook = await h.hookWith(withToken(reference('a-key-nobody-declared')));
      await h.open();
      h.dispatch();
      await h.drain();
      expect(await h.status(hook.id)).toBe('delivered');
      expect(reader.reads).toEqual(['a-key-nobody-declared']);
    },
  },
  {
    line: 122,
    owner: 'COR-2177',
    name: 'a plugin that needs setup holding a reference waits first: the reference is not resolved before the attempt',
    check: async () => {
      const reader = secretReader({ 'slack-token': SENTINEL });
      const h = harness({
        gate: availabilityGate(false),
        configuration: SECRET_CONFIGURATION,
        configurationSecrets: reader,
      });
      const hook = await h.hookWith(withToken(reference('slack-token')));
      await h.open();
      h.dispatch();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.attempts).toEqual([]);
      expect(record.leaseUntil).toBe(0);
      expect(reader.reads).toEqual([]);
    },
  },
  {
    line: 123,
    owner: 'main',
    name: 'a shutdown while a reference resolves interrupts the attempt and releases the lease',
    check: async () => {
      const resolving = deferred<string | undefined>();
      let asked = 0;
      const h = harness({
        configuration: SECRET_CONFIGURATION,
        configurationSecrets: {
          get: () => {
            asked += 1;
            return resolving.promise;
          },
        },
      });
      const hook = await h.hookWith(withToken(reference('slack-token')));
      await h.open();
      h.dispatch();
      await waitUntil(() => asked === 1, { message: 'the reference to be read' });
      h.shutdown();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.leaseUntil).toBe(0);
      expect(outcomes(record)).toEqual(['interrupted']);
      expect(h.calls).toHaveLength(0);
    },
  },
  {
    // Not a matrix row: a default that holds { secret: true } is a value, not a marker.
    line: 0,
    owner: 'COR-2177',
    name: 'a schema whose default value holds { secret: true } has no secret field: its hook is written and delivered',
    check: async () => {
      const h = harness({
        configuration: z.object({ secret: z.boolean() }).default({ secret: true }),
        configurationSecrets: secretReader(),
      });
      const hook = await h.hookWith({ secret: true });
      await h.open();
      h.dispatch();
      await h.drain();
      expect(await h.status(hook.id)).toBe('delivered');
      expect(h.calls.map((call) => call.configuration)).toEqual([{ secret: true }]);
    },
  },
  {
    // Not a matrix row: the matrix is silent on a schema Zod cannot write, so this pins the choice.
    line: 0,
    owner: 'COR-2177',
    name: 'a schema Zod cannot write as JSON Schema has no secret fields to find: the configuration is stored as given',
    check: async () => {
      const foreign = { safeParse: (value: unknown) => ({ success: true, data: value }) };
      const h = harness({ configuration: foreign as unknown as z.ZodType });
      const hook = await h.hookWith({ channel: 'ops', token: SENTINEL });
      expect(hook.action).toEqual({
        ...ACTION,
        configuration: { channel: 'ops', token: SENTINEL },
      });
    },
  },
];

const ROWS: readonly Row[] = [
  ...LOOP_GUARD_ROWS,
  ...PERMANENT_ROWS,
  ...ABORT_ROWS,
  ...NEEDS_SETUP_ROWS,
  ...SECRET_REFERENCE_ROWS,
  ...BASELINE_ROWS,
];

describe('the outcome matrix of a plugin reaction’s delivery', () => {
  for (const row of ROWS) {
    it(`[${row.owner}, matrix line ${row.line}] ${row.name}`, row.check);
  }
});
