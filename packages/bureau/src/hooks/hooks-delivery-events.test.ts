/**
 * COR-2099 (E4b) — `hook.delivery.failed` and `hook.delivery.gave-up`, the two events a hook
 * delivery's failures publish, over real Bureaus with a webhook receiver that fails. A row names the
 * matrix line it comes from (`EVT-3-matrix.md`, the number of the row in that file) and its source.
 * The rows over a plugin reaction are in `hooks-reactions-matrix.test.ts`.
 */
import type { EncryptionKey } from '@lostgradient/cryptography';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { BUREAU_EVENT_CATALOG } from '../bureau-event-catalog.ts';
import type { Bureau } from '../bureau-types/facade.ts';
import { waitForCondition } from '../test';
import { createSqliteStorageFixture } from '../test/storage-fixtures.ts';
import {
  createClock,
  createReceiver,
  deliveriesOf,
  fireRunEvents,
  newEncryptionKey,
  openHooksBureau,
  SIGNING_SECRET,
  waitForSettledDeliveries,
  waitForStatus,
} from './hooks.test-support.ts';

let key: EncryptionKey;
beforeAll(async () => {
  key = await newEncryptionKey();
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const URL_AT_DELIVERY = 'https://receiver.example/hook?token=abc123';

const HOOK = {
  url: URL_AT_DELIVERY,
  events: ['run.registered'],
  signingSecret: SIGNING_SECRET,
  principal: 'api-key:alice',
} as const;

const FAILS = () => new Response('nope', { status: 500 });

async function open(
  script?: Parameters<typeof createReceiver>[0],
  options: Partial<Parameters<typeof openHooksBureau>[0]> = {},
) {
  const receiver = createReceiver(script);
  const { clock, now } = createClock();
  const opened = await openHooksBureau({
    storage: new MemoryStorage(),
    fetch: receiver.fetch,
    key,
    now,
    ...options,
  });
  cleanups.push(() => opened.dispose());
  return { ...opened, receiver, clock, now };
}

interface Envelope {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly source?: string | undefined;
}

/** The `hook.delivery.*` envelopes the feed holds, once the hooks have settled. */
async function deliveryEvents(bureau: Bureau): Promise<Envelope[]> {
  await bureau.internals.webhookNotifier!.flush();
  const found: Envelope[] = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
    if (envelope.kind.startsWith('hook.delivery.')) found.push(envelope);
  }
  return found;
}

/** The payloads of `events`, each with its kind, as the rows state them. */
const shapes = (events: readonly Envelope[]) =>
  events.map((event) => ({ kind: event.kind, ...event.payload }));

const failedPayload = (
  hookId: string,
  deliveryId: string,
  attempt: number,
  outcome: string,
  status?: number,
) => ({
  kind: 'hook.delivery.failed',
  hookId,
  deliveryId,
  attempt,
  outcome,
  ...(status === undefined ? {} : { status }),
});

const gaveUpPayload = (hookId: string, deliveryId: string, attempts: number) => ({
  kind: 'hook.delivery.gave-up',
  hookId,
  deliveryId,
  attempts,
});

/** One row of the matrix: the line of `EVT-3-matrix.md`, where it comes from, and what it asserts. */
interface Row {
  readonly line: number;
  readonly source: string;
  readonly name: string;
  readonly check: () => Promise<void>;
}

const ROWS: readonly Row[] = [
  {
    line: 42,
    source: 'brief, Rev',
    name: 'a webhook answered 500 on an attempt before the last publishes failed after the backoff write, and a later success publishes nothing more',
    check: async () => {
      const { bureau } = await open((_call, index) => (index === 0 ? FAILS() : new Response('ok')));
      const hook = await bureau.hooks!.create(HOOK);
      await fireRunEvents(bureau);
      const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);
      expect(delivery!.status).toBe('delivered');
      expect(shapes(await deliveryEvents(bureau))).toEqual([
        failedPayload(hook.id, delivery!.id, 1, 'response', 500),
      ]);
    },
  },
  {
    line: 43,
    source: 'AC1, Rev',
    name: 'a webhook answered 500 on every attempt publishes one failed per try, then one gave-up after the last, failed first',
    check: async () => {
      const { bureau } = await open(FAILS, { maxAttempts: 3 });
      const hook = await bureau.hooks!.create(HOOK);
      await fireRunEvents(bureau);
      const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);
      expect(delivery!.status).toBe('exhausted');
      const events = await deliveryEvents(bureau);
      expect(shapes(events)).toEqual([
        failedPayload(hook.id, delivery!.id, 1, 'response', 500),
        failedPayload(hook.id, delivery!.id, 2, 'response', 500),
        failedPayload(hook.id, delivery!.id, 3, 'response', 500),
        gaveUpPayload(hook.id, delivery!.id, 3),
      ]);
      // No owner, URL or response text goes with either kind.
      expect(Object.keys(events[0]!.payload).toSorted()).toEqual([
        'attempt',
        'deliveryId',
        'hookId',
        'outcome',
        'status',
      ]);
      expect(Object.keys(events[3]!.payload).toSorted()).toEqual([
        'attempts',
        'deliveryId',
        'hookId',
      ]);
      expect(events.every((event) => event.source === undefined)).toBe(true);
    },
  },
  {
    line: 44,
    source: 'Rev 2026-11-15 ("a non-2xx `response`")',
    name: 'a redirect is not followed and each attempt publishes failed with outcome response and status 302',
    check: async () => {
      const { bureau } = await open(
        () =>
          new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }),
        { maxAttempts: 2 },
      );
      const hook = await bureau.hooks!.create(HOOK);
      await fireRunEvents(bureau);
      const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);
      expect(shapes(await deliveryEvents(bureau))).toEqual([
        failedPayload(hook.id, delivery!.id, 1, 'response', 302),
        failedPayload(hook.id, delivery!.id, 2, 'response', 302),
        gaveUpPayload(hook.id, delivery!.id, 2),
      ]);
    },
  },
  {
    line: 45,
    source: 'Rev',
    name: 'a transport error publishes failed with outcome network-error, no status and no text, though the attempt keeps the text',
    check: async () => {
      const { bureau } = await open(
        () => Promise.reject(new Error(`Unable to connect to ${URL_AT_DELIVERY}`)),
        { maxAttempts: 2 },
      );
      const hook = await bureau.hooks!.create(HOOK);
      await fireRunEvents(bureau);
      const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);
      expect(delivery!.attempts[0]?.error).toContain('abc123');
      const events = await deliveryEvents(bureau);
      expect(shapes(events)).toEqual([
        failedPayload(hook.id, delivery!.id, 1, 'network-error'),
        failedPayload(hook.id, delivery!.id, 2, 'network-error'),
        gaveUpPayload(hook.id, delivery!.id, 2),
      ]);
      expect(JSON.stringify(events)).not.toContain('abc123');
      expect(JSON.stringify(events)).not.toContain('Unable to connect');
    },
  },
  {
    line: 46,
    source: 'Rev',
    name: 'a request past requestTimeoutMilliseconds publishes failed with outcome network-error',
    check: async () => {
      const { bureau } = await open(
        () => Promise.reject(new DOMException('The operation was aborted', 'AbortError')),
        { maxAttempts: 2 },
      );
      const hook = await bureau.hooks!.create(HOOK);
      await fireRunEvents(bureau);
      const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);
      expect(shapes(await deliveryEvents(bureau))).toEqual([
        failedPayload(hook.id, delivery!.id, 1, 'network-error'),
        failedPayload(hook.id, delivery!.id, 2, 'network-error'),
        gaveUpPayload(hook.id, delivery!.id, 2),
      ]);
    },
  },
  {
    line: 51,
    source: 'Rev',
    name: 'a workspace authority that is gone at the attempt publishes failed with outcome rejected, and no gave-up',
    check: async () => {
      let present = true;
      const { bureau } = await open(
        () => {
          present = false;
          return new Response('busy', { status: 503 });
        },
        {
          workspace: {
            workspaceId: 'workspace-a',
            resolveMembership: async () => null,
            resolveOwnerMembership: async (owner) =>
              present
                ? {
                    version: 1,
                    workspaceId: 'workspace-a',
                    actorId: 'actor-alice',
                    actorKind: 'user',
                    owner,
                    membershipRevision: 'r1',
                    capabilities: ['workspace:use', 'workspace:manage'],
                  }
                : null,
          },
        },
      );
      const hook = await bureau.hooks!.create(HOOK);
      await fireRunEvents(bureau, HOOK.principal);
      const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);
      expect(shapes(await deliveryEvents(bureau))).toEqual([
        failedPayload(hook.id, delivery!.id, 1, 'response', 503),
        failedPayload(hook.id, delivery!.id, 2, 'rejected'),
      ]);
    },
  },
  {
    line: 52,
    source: 'Rev',
    name: 'a URL the policy now refuses publishes failed with outcome refused, then gave-up, and makes no request',
    check: async () => {
      const database = createSqliteStorageFixture();
      cleanups.push(() => database.dispose());
      const { now } = createClock();
      const first = await openHooksBureau({
        storage: database.storage,
        fetch: createReceiver(
          (call) =>
            new Promise<Response>((_resolve, reject) => {
              call.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('The operation was aborted', 'AbortError')),
                { once: true },
              );
            }),
        ).fetch,
        key,
        now,
      });
      let firstOpen = true;
      cleanups.push(async () => {
        if (firstOpen) await first.dispose();
      });
      const hook = await first.bureau.hooks!.create({ ...HOOK, url: 'http://localhost:9/hook' });
      await fireRunEvents(first.bureau);
      await waitForCondition(async () => {
        const [started] = await deliveriesOf(first.bureau, hook.id);
        return started?.attempts.length === 1;
      }, 'the request never started');
      firstOpen = false;
      await first.dispose();

      const receiver = createReceiver();
      const strict = await openHooksBureau({
        storage: await database.reopen(),
        fetch: receiver.fetch,
        key,
        now,
        hooks: { urlPolicy: { allowPrivateNetworks: false } },
      });
      cleanups.push(() => strict.dispose());
      const [delivery] = await waitForSettledDeliveries(strict.bureau, hook.id, 1);
      expect(delivery!.status).toBe('exhausted');
      expect(receiver.calls).toHaveLength(0);
      expect(shapes(await deliveryEvents(strict.bureau))).toEqual([
        failedPayload(hook.id, delivery!.id, 2, 'refused'),
        gaveUpPayload(hook.id, delivery!.id, 2),
      ]);
    },
  },
  {
    line: 57,
    source: 'Rev',
    name: 'a hook disabled while its request is in flight: the failed answer publishes failed, and the abort at the next pass publishes nothing',
    check: async () => {
      const holder: { disable?: () => Promise<unknown> } = {};
      const { bureau } = await open(
        async () => {
          await holder.disable?.();
          return FAILS();
        },
        { maxAttempts: 5 },
      );
      const hook = await bureau.hooks!.create(HOOK);
      holder.disable = () => bureau.hooks!.update(hook.id, { enabled: false });
      await fireRunEvents(bureau);
      const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);
      expect(delivery!.status).toBe('aborted');
      expect(shapes(await deliveryEvents(bureau))).toEqual([
        failedPayload(hook.id, delivery!.id, 1, 'response', 500),
      ]);
    },
  },
  {
    line: 58,
    source: 'Rev 2026-11-15 ("after the write that commits")',
    name: 'a hook deleted while its request is in flight publishes nothing: the closing write loses its fence',
    check: async () => {
      const holder: { remove?: () => Promise<unknown> } = {};
      const { bureau, receiver } = await open(async () => {
        await holder.remove?.();
        return FAILS();
      });
      const hook = await bureau.hooks!.create(HOOK);
      holder.remove = () => bureau.hooks!.delete(hook.id);
      await fireRunEvents(bureau);
      await bureau.internals.webhookNotifier!.flush();
      expect(receiver.calls).toHaveLength(1);
      expect(await deliveriesOf(bureau, hook.id)).toEqual([]);
      expect(await deliveryEvents(bureau)).toEqual([]);
    },
  },
  {
    line: 60,
    source: 'Rev',
    name: 'a signing secret that cannot be opened ends failed-secret and publishes nothing',
    check: async () => {
      const storage = new MemoryStorage();
      const before = await open(undefined, { storage });
      const hook = await before.bureau.hooks!.create(HOOK);
      await before.dispose();
      const receiver = createReceiver();
      const reopened = await openHooksBureau({
        storage,
        fetch: receiver.fetch,
        key: await newEncryptionKey(),
      });
      cleanups.push(() => reopened.dispose());
      await fireRunEvents(reopened.bureau);
      await waitForStatus(reopened.bureau, hook.id, 'failed-secret');
      expect(receiver.calls).toHaveLength(0);
      expect(await deliveryEvents(reopened.bureau)).toEqual([]);
    },
  },
  {
    line: 63,
    source: 'Rev 2026-11-15',
    name: 'a hooks.test delivery that fails publishes nothing',
    check: async () => {
      const { bureau } = await open(FAILS);
      const hook = await bureau.hooks!.create(HOOK);
      const delivery = await bureau.hooks!.test(hook.id);
      expect(delivery!.status).toBe('exhausted');
      expect(await deliveryEvents(bureau)).toEqual([]);
    },
  },
  {
    line: 64,
    source: 'Rev (publish follows a write)',
    name: 'hooks.testDraft writes nothing and publishes nothing',
    check: async () => {
      const { bureau } = await open(FAILS);
      const sent = await bureau.hooks!.testDraft({
        url: URL_AT_DELIVERY,
        signingSecret: SIGNING_SECRET,
        principal: 'api-key:alice',
      });
      expect(sent.status).toBe('exhausted');
      expect(await deliveryEvents(bureau)).toEqual([]);
    },
  },
  {
    line: 70,
    source: 'main, Rev',
    name: 'a second Bureau over the same store publishes the events once on its own feed, and matches every hook in the store',
    check: async () => {
      const database = createSqliteStorageFixture();
      cleanups.push(() => database.dispose());
      const { now } = createClock();
      const first = await openHooksBureau({
        storage: database.storage,
        fetch: createReceiver().fetch,
        key,
        now,
      });
      const trigger = await first.bureau.hooks!.create({
        ...HOOK,
        url: 'https://trigger.example/hook',
      });
      const listener = await first.bureau.hooks!.create({
        ...HOOK,
        url: 'https://listener.example/hook',
        events: ['hook.delivery.failed'],
      });
      await first.dispose();

      const receiver = createReceiver((call) =>
        call.url.startsWith('https://trigger.example') ? FAILS() : new Response('ok'),
      );
      const second = await openHooksBureau({
        storage: await database.reopen(),
        fetch: receiver.fetch,
        key,
        now,
        maxAttempts: 3,
      });
      cleanups.push(() => second.dispose());
      await fireRunEvents(second.bureau);
      const [triggered] = await waitForSettledDeliveries(second.bureau, trigger.id, 1);
      const heard = await waitForSettledDeliveries(second.bureau, listener.id, 3);
      expect(heard.map((delivery) => [delivery.kind, delivery.status])).toEqual([
        ['hook.delivery.failed', 'delivered'],
        ['hook.delivery.failed', 'delivered'],
        ['hook.delivery.failed', 'delivered'],
      ]);
      expect(shapes(await deliveryEvents(second.bureau))).toEqual([
        failedPayload(trigger.id, triggered!.id, 1, 'response', 500),
        failedPayload(trigger.id, triggered!.id, 2, 'response', 500),
        failedPayload(trigger.id, triggered!.id, 3, 'response', 500),
        gaveUpPayload(trigger.id, triggered!.id, 3),
      ]);
    },
  },
  {
    line: 71,
    source: 'brief, Rev',
    name: 'a hook that lists run.registered and hook.delivery.failed at a failing URL records the kind of its own deliveries and publishes only the trigger’s',
    check: async () => {
      const { bureau } = await open(FAILS, { maxAttempts: 2 });
      const hook = await bureau.hooks!.create({
        ...HOOK,
        events: ['run.registered', 'hook.delivery.failed'],
      });
      await fireRunEvents(bureau);
      await waitForCondition(async () => {
        const deliveries = await deliveriesOf(bureau, hook.id);
        return (
          deliveries.length === 3 && deliveries.every((delivery) => delivery.status !== 'pending')
        );
      }, 'the hook never settled its three deliveries');
      const deliveries = await deliveriesOf(bureau, hook.id);
      expect(deliveries.map((delivery) => delivery.kind)).toEqual([
        'run.registered',
        'hook.delivery.failed',
        'hook.delivery.failed',
      ]);
      expect(shapes(await deliveryEvents(bureau))).toEqual([
        failedPayload(hook.id, deliveries[0]!.id, 1, 'response', 500),
        failedPayload(hook.id, deliveries[0]!.id, 2, 'response', 500),
        gaveUpPayload(hook.id, deliveries[0]!.id, 2),
      ]);
    },
  },
  {
    line: 72,
    source: 'AC2',
    name: 'two hooks on hook.delivery.failed at failing URLs settle without cascading: only the trigger’s failures are published',
    check: async () => {
      const { bureau } = await open(FAILS, { maxAttempts: 3 });
      const trigger = await bureau.hooks!.create({ ...HOOK, url: 'https://trigger.example/hook' });
      const listeners = [
        await bureau.hooks!.create({
          ...HOOK,
          url: 'https://first.example/hook',
          events: ['hook.delivery.failed'],
        }),
        await bureau.hooks!.create({
          ...HOOK,
          url: 'https://second.example/hook',
          events: ['hook.delivery.failed'],
        }),
      ];
      await fireRunEvents(bureau);
      const [triggered] = await waitForSettledDeliveries(bureau, trigger.id, 1);
      for (const listener of listeners) {
        const heard = await waitForSettledDeliveries(bureau, listener.id, 3);
        expect(heard.map((delivery) => delivery.status)).toEqual([
          'exhausted',
          'exhausted',
          'exhausted',
        ]);
        expect(new Set(heard.map((delivery) => delivery.kind))).toEqual(
          new Set(['hook.delivery.failed']),
        );
        expect(heard.every((delivery) => delivery.attempts.length === 3)).toBe(true);
      }
      expect(shapes(await deliveryEvents(bureau))).toEqual([
        failedPayload(trigger.id, triggered!.id, 1, 'response', 500),
        failedPayload(trigger.id, triggered!.id, 2, 'response', 500),
        failedPayload(trigger.id, triggered!.id, 3, 'response', 500),
        gaveUpPayload(trigger.id, triggered!.id, 3),
      ]);
    },
  },
  {
    line: 73,
    source: 'Rev 2026-11-15',
    name: 'a hook on hook.delivery.gave-up whose delivery fails publishes nothing',
    check: async () => {
      const { bureau } = await open(FAILS, { maxAttempts: 2 });
      const trigger = await bureau.hooks!.create({ ...HOOK, url: 'https://trigger.example/hook' });
      const listener = await bureau.hooks!.create({
        ...HOOK,
        url: 'https://listener.example/hook',
        events: ['hook.delivery.gave-up'],
      });
      await fireRunEvents(bureau);
      const [triggered] = await waitForSettledDeliveries(bureau, trigger.id, 1);
      const [heard] = await waitForSettledDeliveries(bureau, listener.id, 1);
      expect(heard!.kind).toBe('hook.delivery.gave-up');
      expect(heard!.status).toBe('exhausted');
      expect(shapes(await deliveryEvents(bureau))).toEqual([
        failedPayload(trigger.id, triggered!.id, 1, 'response', 500),
        failedPayload(trigger.id, triggered!.id, 2, 'response', 500),
        gaveUpPayload(trigger.id, triggered!.id, 2),
      ]);
    },
  },
  {
    line: 81,
    source: 'Rev, the run rule',
    name: 'no pushed event, body or delivery carries free error text: a canary in a transport error, a response body and a reaction’s failure is in none of them',
    check: async () => {
      const CANARY = 'CANARY-7f3a91bc';
      const received: string[] = [];
      const { bureau } = await open(
        (call, index) => {
          if (call.url.startsWith('https://listener.example')) {
            received.push(call.body);
            return new Response('ok');
          }
          // Attempt one: a transport error whose text names the URL's token. Then an answer whose
          // body carries a canary.
          return index === 0
            ? Promise.reject(new Error(`Unable to connect to ${URL_AT_DELIVERY} ${CANARY}-text`))
            : new Response(`${CANARY}-body`, { status: 500 });
        },
        { maxAttempts: 3 },
      );
      const trigger = await bureau.hooks!.create({ ...HOOK, url: 'https://trigger.example/hook' });
      const listener = await bureau.hooks!.create({
        ...HOOK,
        url: 'https://listener.example/hook',
        events: ['hook.delivery.failed', 'hook.delivery.gave-up'],
      });
      await fireRunEvents(bureau);
      await waitForSettledDeliveries(bureau, trigger.id, 1);
      await waitForSettledDeliveries(bureau, listener.id, 4);
      const events = await deliveryEvents(bureau);
      expect(events).toHaveLength(4);
      const everything = JSON.stringify(events) + received.join('\n');
      expect(everything).not.toContain(CANARY);
      expect(everything).not.toContain('abc123');
      expect(received).toHaveLength(4);
      for (const body of received) {
        const parsed = JSON.parse(body) as { payload: Record<string, unknown> };
        expect(Object.keys(parsed.payload).toSorted()).not.toContain('error');
        expect(Object.keys(parsed.payload).toSorted()).not.toContain('responseExcerpt');
      }
    },
  },
  {
    line: 82,
    source: 'main, Rev',
    name: 'without a workspace, another owner’s hook that lists a kind receives the failing hook’s identifiers',
    check: async () => {
      const { bureau } = await open(FAILS, { maxAttempts: 2 });
      const trigger = await bureau.hooks!.create({ ...HOOK, url: 'https://trigger.example/hook' });
      const bob = await bureau.hooks!.create({
        ...HOOK,
        principal: 'api-key:bob',
        url: 'https://bob.example/hook',
        events: ['hook.delivery.gave-up'],
      });
      await fireRunEvents(bureau, 'api-key:alice');
      const [triggered] = await waitForSettledDeliveries(bureau, trigger.id, 1);
      const [heard] = await waitForSettledDeliveries(bureau, bob.id, 1);
      expect(heard!.owner).toBe('api-key:bob');
      expect(heard!.kind).toBe('hook.delivery.gave-up');
      expect(heard!.request?.body).toContain(triggered!.id);
    },
  },
  {
    line: 83,
    source: 'Rev',
    name: 'under a workspace authority both kinds are dropped for every hook, the failing hook’s owner included',
    check: async () => {
      const { bureau } = await open(FAILS, {
        maxAttempts: 2,
        workspace: {
          workspaceId: 'workspace-a',
          resolveMembership: async ({ subject }) => ({
            version: 1,
            workspaceId: 'workspace-a',
            actorId: subject ?? 'unknown',
            actorKind: 'user',
            owner: `api-key:${subject ?? 'unknown'}`,
            membershipRevision: 'revision-1',
            capabilities: ['workspace:use', 'workspace:manage'],
          }),
          resolveOwnerMembership: async (owner) => ({
            version: 1,
            workspaceId: 'workspace-a',
            actorId: owner,
            actorKind: 'user',
            owner,
            membershipRevision: 'revision-1',
            capabilities: ['workspace:use', 'workspace:manage'],
          }),
        },
      });
      const trigger = await bureau.hooks!.create({ ...HOOK, url: 'https://trigger.example/hook' });
      const own = await bureau.hooks!.create({
        ...HOOK,
        url: 'https://own.example/hook',
        events: ['hook.delivery.failed', 'hook.delivery.gave-up'],
      });
      await fireRunEvents(bureau, 'api-key:alice');
      const [triggered] = await waitForSettledDeliveries(bureau, trigger.id, 1);
      await bureau.internals.webhookNotifier!.flush();
      // The feed carries both kinds, and no hook is given either.
      expect(shapes(await deliveryEvents(bureau))).toEqual([
        failedPayload(trigger.id, triggered!.id, 1, 'response', 500),
        failedPayload(trigger.id, triggered!.id, 2, 'response', 500),
        gaveUpPayload(trigger.id, triggered!.id, 2),
      ]);
      expect(await deliveriesOf(bureau, own.id)).toEqual([]);
    },
  },
  {
    line: 84,
    source: 'Rev 2026-11-15',
    name: 'both kinds are on the feed and in the catalog with origin unattributed and no scope',
    check: async () => {
      for (const kind of ['hook.delivery.failed', 'hook.delivery.gave-up'] as const) {
        expect(BUREAU_EVENT_CATALOG[kind].origin).toBe('unattributed');
        expect(BUREAU_EVENT_CATALOG[kind].scopes).toEqual([]);
      }
      expect(BUREAU_EVENT_CATALOG['hook.delivery.failed'].payload).toEqual([
        { name: 'hookId', type: 'string', optional: false },
        { name: 'deliveryId', type: 'string', optional: false },
        { name: 'attempt', type: 'number', optional: false },
        { name: 'outcome', type: 'string', optional: false },
        { name: 'status', type: 'number', optional: true },
      ]);
      expect(BUREAU_EVENT_CATALOG['hook.delivery.gave-up'].payload).toEqual([
        { name: 'hookId', type: 'string', optional: false },
        { name: 'deliveryId', type: 'string', optional: false },
        { name: 'attempts', type: 'number', optional: false },
      ]);
    },
  },
];

describe('the outcome matrix of the hook delivery events over webhooks (event feed batch 3, COR-2099)', () => {
  for (const row of ROWS) {
    it(`[COR-2099, matrix line ${row.line}, ${row.source}] ${row.name}`, row.check);
  }
});
