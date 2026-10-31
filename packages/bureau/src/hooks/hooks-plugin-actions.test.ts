/**
 * COR-1876 — hook action kinds a plugin contributes: the kind is resolved by plugin and name, its
 * configuration is checked against its schema, a matching event reaches it with `source` only when
 * a plugin's contribution emitted the event, and its delivery is recorded like a built-in
 * action's. The hooks are built over a scripted engine, as `hooks-action-retry.test.ts` does.
 */
import { generateEncryptionKey } from '@lostgradient/cryptography';
import type { PluginHookActionContext } from '@lostgradient/interborough-plugin';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { BureauEventEnvelope } from '../bureau-event-feed.ts';
import type { WebhookDeliveryEngine } from '../webhook-notifier.ts';
import { createHooks } from './create-hooks.ts';
import {
  fireRunEvents,
  newEncryptionKey,
  openHooksBureau,
  waitForSettledDeliveries,
} from './hooks.test-support.ts';
import { HookError, type HookActionKindRegistration, type HookDelivery } from './hook-types.ts';

const CONFIGURATION = z.object({ channel: z.string(), urgent: z.boolean().default(false) });

function fixture(
  options: {
    readonly run?: (context: PluginHookActionContext) => Promise<void>;
    readonly registrations?: (
      run: (context: PluginHookActionContext) => Promise<void>,
    ) => readonly HookActionKindRegistration[];
    readonly keys?: Awaited<ReturnType<typeof generateEncryptionKey>>;
    readonly kv?: ReturnType<typeof textValueStore>;
  } = {},
) {
  const tracked: Promise<void>[] = [];
  const requests: Array<{ url: string; body: string }> = [];
  const engine: WebhookDeliveryEngine = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: url instanceof Request ? url.url : url.toString(),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response('ok');
    }) as typeof fetch,
    now: () => 1_800_000_000_000,
    maxAttempts: 3,
    backoffMilliseconds: () => 0,
    wait: () => Promise.resolve(),
    shuttingDown: () => false,
    signal: new AbortController().signal,
    track: (promise) => {
      tracked.push(promise);
    },
    tracked: (_id, _hookId, work) => work(),
  };
  const received: PluginHookActionContext[] = [];
  const run =
    options.run ??
    ((context: PluginHookActionContext) => {
      received.push(context);
      return Promise.resolve();
    });
  const registrations = options.registrations?.(run) ?? [
    {
      plugin: 'slack',
      kind: {
        name: 'post-message',
        description: 'Posts the event to a channel.',
        configuration: CONFIGURATION,
        run,
      },
    },
  ];
  let next = 0;
  const created = createHooks({
    kv: options.kv ?? textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false }),
    engine,
    keys: options.keys === undefined ? undefined : { current: options.keys },
    bureauId: 'plugin-bureau',
    newId: (kind) => `${kind}-${++next}`,
    audit: () => Promise.resolve(),
    diagnose: () => undefined,
    actionKinds: registrations,
  });
  return {
    hooks: created.hooks,
    received,
    requests,
    async fire(extra: { readonly source?: string } = {}): Promise<void> {
      await created.resume();
      created.dispatch({
        sequence: 0,
        cursor: '0',
        bureauId: 'plugin-bureau',
        kind: 'run.settled',
        emittedAtMs: 1_800_000_000_000,
        payload: { runId: 'r1' },
        ...extra,
      } satisfies BureauEventEnvelope);
      await Promise.all(tracked.splice(0));
    },
  };
}

async function onlyDelivery(
  hooks: ReturnType<typeof fixture>['hooks'],
  hookId: string,
): Promise<HookDelivery> {
  const delivered = await hooks.deliveries(hookId);
  expect(delivered).toHaveLength(1);
  return delivered[0]!;
}

const ACTION = {
  type: 'plugin',
  plugin: 'slack',
  kind: 'post-message',
  configuration: { channel: 'ops' },
} as const;

describe('a contributed hook action', () => {
  it('receives a matching event, with the configuration its schema parsed, and records a delivery', async () => {
    const setup = fixture();
    const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });
    expect(hook.action).toEqual(ACTION);
    const stored = await setup.hooks.get(hook.id);
    expect(stored?.action).toEqual(ACTION);

    await setup.fire();

    expect(setup.received).toHaveLength(1);
    const context = setup.received[0]!;
    expect(context.configuration).toEqual({ channel: 'ops', urgent: false });
    expect(context.event).toEqual({
      kind: 'run.settled',
      bureauId: 'plugin-bureau',
      emittedAtMs: 1_800_000_000_000,
      payload: { runId: 'r1' },
    });
    expect(Object.hasOwn(context.event, 'source')).toBe(false);
    const delivery = await onlyDelivery(setup.hooks, hook.id);
    expect(delivery).toMatchObject({
      actionType: 'plugin',
      kind: 'run.settled',
      status: 'delivered',
    });
    expect(delivery.attempts).toHaveLength(1);
    expect(delivery.attempts[0]).toMatchObject({ number: 1, outcome: 'completed' });
    expect(delivery.work).toMatchObject({ type: 'plugin', plugin: 'slack', kind: 'post-message' });
  });

  it('receives the plugin an event came from as its source', async () => {
    const setup = fixture();
    const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

    await setup.fire({ source: 'calendar' });

    expect(setup.received[0]?.event.source).toBe('calendar');
    const delivery = await onlyDelivery(setup.hooks, hook.id);
    expect(delivery.work).toMatchObject({ type: 'plugin', event: { source: 'calendar' } });
  });

  it('adds source to a webhook body and to a start-workflow event input only when the event has one', async () => {
    const setup = fixture({ keys: await generateEncryptionKey() });
    await setup.hooks.create({
      events: ['run.settled'],
      url: 'https://example.com/hook',
      signingSecret: 'a-signing-secret-long-enough',
    });

    await setup.fire();
    await setup.fire({ source: 'calendar' });

    const bodies = setup.requests.map(
      (request) => JSON.parse(request.body) as Record<string, unknown>,
    );
    expect(bodies).toHaveLength(2);
    expect(Object.hasOwn(bodies[0]!, 'source')).toBe(false);
    expect(bodies[1]!['source']).toBe('calendar');
    expect(bodies[1]!['payload']).toEqual({ runId: 'r1' });
  });

  it('is retried when it rejects, and exhausted after the last attempt', async () => {
    const setup = fixture({ run: () => Promise.reject(new Error('Slack is down')) });
    const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

    await setup.fire();

    const delivery = await onlyDelivery(setup.hooks, hook.id);
    expect(delivery.status).toBe('exhausted');
    expect(delivery.attempts.map((attempt) => attempt.outcome)).toEqual([
      'error',
      'error',
      'error',
    ]);
    expect(delivery.attempts[0]?.error).toBe('Slack is down');
  });

  it('is refused when no plugin contributes the kind', async () => {
    const setup = fixture();
    const error = await setup.hooks
      .create({ events: ['run.settled'], action: { ...ACTION, kind: 'post-gif' } })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HookError);
    expect((error as HookError).issues[0]?.path).toEqual(['action', 'kind']);
    expect(await setup.hooks.list()).toEqual([]);
  });

  it('is refused when its configuration fails the kind’s schema', async () => {
    const setup = fixture();
    const error = await setup.hooks
      .create({
        events: ['run.settled'],
        action: {
          type: 'plugin',
          plugin: 'slack',
          kind: 'post-message',
          configuration: { channel: 7 },
        },
      })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HookError);
    expect((error as HookError).issues[0]?.path).toEqual(['action', 'configuration']);
    expect((error as HookError).issues[0]?.message).toContain('channel');
  });

  it('can change its configuration but not its plugin or kind, and cannot be tested', async () => {
    const setup = fixture();
    const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

    const changed = await setup.hooks.update(hook.id, {
      action: { ...ACTION, configuration: { channel: 'alerts', urgent: true } },
    });
    expect(changed?.action).toMatchObject({ configuration: { channel: 'alerts', urgent: true } });

    const moved = await setup.hooks
      .update(hook.id, { action: { ...ACTION, plugin: 'other' } })
      .catch((thrown: unknown) => thrown);
    expect(moved).toBeInstanceOf(HookError);
    const tested = await setup.hooks.test(hook.id).catch((thrown: unknown) => thrown);
    expect(tested).toBeInstanceOf(HookError);
    expect(setup.received).toHaveLength(0);
  });

  it('ends a delivery failed, without a retry, when its plugin no longer contributes the kind', async () => {
    const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
    const before = fixture({ kv });
    const hook = await before.hooks.create({ events: ['run.settled'], action: ACTION });

    // The Bureau restarts with the plugin removed.
    const after = fixture({ kv, registrations: () => [] });
    await after.fire();

    const delivery = await onlyDelivery(after.hooks, hook.id);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempts).toHaveLength(1);
    expect(delivery.attempts[0]).toMatchObject({ outcome: 'rejected' });
    expect(delivery.attempts[0]?.error).toContain('slack/post-message');
  });

  it('refuses a plugin and kind contributed twice when the hooks are built', () => {
    expect(() =>
      fixture({
        registrations: (run) => {
          const kind = {
            name: 'post-message',
            description: 'Posts.',
            configuration: CONFIGURATION,
            run,
          };
          return [
            { plugin: 'slack', kind },
            { plugin: 'slack', kind },
          ];
        },
      }),
    ).toThrow('slack/post-message');
  });
});

describe('a Bureau composed with contributed hook actions and event formatters', () => {
  it('runs the contributed action for a real event and formats events with the contributed formatter', async () => {
    const received: PluginHookActionContext[] = [];
    const { bureau, dispose } = await openHooksBureau({
      storage: new MemoryStorage(),
      fetch: (() => Promise.reject(new Error('no request is made'))) as unknown as typeof fetch,
      key: await newEncryptionKey(),
      hooks: {
        actionKinds: [
          {
            plugin: 'slack',
            kind: {
              name: 'post-message',
              description: 'Posts the event to a channel.',
              configuration: CONFIGURATION,
              run: (context) => {
                received.push(context);
                return Promise.resolve();
              },
            },
          },
        ],
      },
      eventFormatters: [
        {
          plugin: 'reports',
          formatter: {
            name: 'registered',
            eventKinds: ['run.registered'],
            format: () => ({ title: 'A run started' }),
          },
        },
      ],
    });
    try {
      const hook = await bureau.hooks!.create({ events: ['run.registered'], action: ACTION });
      await fireRunEvents(bureau);
      const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);
      expect(delivery).toMatchObject({ actionType: 'plugin', status: 'delivered' });
      expect(received[0]?.event.kind).toBe('run.registered');
      expect(Object.hasOwn(received[0]!.event, 'source')).toBe(false);

      const event = received[0]!.event;
      expect(bureau.formatEvent(event)).toMatchObject({
        title: 'A run started',
        formattedBy: 'reports/registered',
      });
      expect(bureau.formatEvent({ ...event, kind: 'run.settled' })).toMatchObject({
        title: 'run.settled',
      });
    } finally {
      await dispose();
    }
  });
});
