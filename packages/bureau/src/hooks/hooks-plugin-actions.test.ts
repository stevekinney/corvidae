/**
 * COR-1876 — hook action kinds a plugin contributes: the kind is resolved by plugin and name, its
 * configuration is checked against its schema, a matching event reaches it with `source` only when
 * a plugin's contribution emitted the event, and its delivery is recorded like a built-in
 * action's. The hooks are built over a scripted engine, as `hooks-action-retry.test.ts` does.
 */
import { generateEncryptionKey } from '@lostgradient/cryptography';
import {
  definePlugin,
  PluginReactionError,
  type PluginReactionContext,
} from '@lostgradient/interborough-plugin';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { BureauEventEnvelope } from '../bureau-event-feed.ts';
import { composePlugins } from '../plugins/compose-plugins.ts';
import { listedPlugins } from '../testing/plugin-listing.test-support.ts';
import type { WebhookDeliveryEngine } from '../webhook-notifier.ts';
import { createHooks } from './create-hooks.ts';
import { createHookStore } from './hook-store.ts';
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
    readonly run?: (context: PluginReactionContext) => Promise<void>;
    readonly registrations?: (
      run: (context: PluginReactionContext) => Promise<void>,
    ) => readonly HookActionKindRegistration[];
    readonly keys?: Awaited<ReturnType<typeof generateEncryptionKey>>;
    readonly kv?: ReturnType<typeof textValueStore>;
    readonly workflows?: Parameters<typeof createHooks>[0]['workflows'];
    /** The reaction's own `timeoutMilliseconds`. */
    readonly timeoutMilliseconds?: number;
  } = {},
) {
  const kv = options.kv ?? textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
  // The timeouts the deliveries asked for, ended by the test, never by a clock.
  const timeouts: Array<{ readonly milliseconds: number; fire(): void }> = [];
  // Set to stop the process under a delivery, as a shutdown does.
  const stopped = new AbortController();
  const state = {
    get shuttingDown(): boolean {
      return stopped.signal.aborted;
    },
    // Stopping the process aborts the engine's signal, as a real shutdown does.
    set shuttingDown(value: boolean) {
      if (value) stopped.abort();
    },
  };
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
    shuttingDown: () => state.shuttingDown,
    signal: stopped.signal,
    track: (promise) => {
      tracked.push(promise);
    },
    tracked: (_id, _hookId, work) => work(),
  };
  const notices: string[] = [];
  const received: PluginReactionContext[] = [];
  const run =
    options.run ??
    ((context: PluginReactionContext) => {
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
        ...(options.timeoutMilliseconds === undefined
          ? {}
          : { timeoutMilliseconds: options.timeoutMilliseconds }),
      },
    },
  ];
  let next = 0;
  const created = createHooks({
    kv,
    engine,
    timeoutSignal: (milliseconds) => {
      const controller = new AbortController();
      timeouts.push({
        milliseconds,
        fire: () => controller.abort(new DOMException('The operation timed out', 'TimeoutError')),
      });
      return controller.signal;
    },
    keys: options.keys === undefined ? undefined : { current: options.keys },
    bureauId: 'plugin-bureau',
    newId: (kind) => `${kind}-${++next}`,
    audit: () => Promise.resolve(),
    diagnose: () => undefined,
    notice: (message) => {
      notices.push(message);
    },
    actionKinds: registrations,
    ...(options.workflows === undefined ? {} : { workflows: options.workflows }),
  });
  return {
    hooks: created.hooks,
    received,
    requests,
    notices,
    kv,
    timeouts,
    state,
    /** Publishes an event to the hooks, as a plugin's contribution or Bureau core would. */
    dispatch: created.dispatch,
    /** Waits for every tracked promise, including those a settling delivery adds. */
    async drain(): Promise<void> {
      while (tracked.length > 0) await Promise.all(tracked.splice(0));
    },
    /** What a restarted process does: resumes the deliveries the last one left pending. */
    async resume(): Promise<void> {
      await created.resume();
      await Promise.all(tracked.splice(0));
    },
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

it('lists a start-workflow hook with a bounded problem when its target stops being startable', async () => {
  let startable = true;
  const setup = fixture({
    workflows: () => ({
      assertStartable: () => {
        if (!startable) throw new Error('workflow unavailable');
      },
      findStart: () => Promise.resolve(undefined),
      start: () =>
        Promise.resolve({ runId: 'run-1', workflow: 'weekly-cleanup', workflowVersion: '1' }),
    }),
  });
  await setup.hooks.create({
    events: ['run.settled'],
    action: { type: 'start-workflow', workflowId: 'weekly-cleanup' },
  });

  startable = false;

  expect((await setup.hooks.list())[0]?.problems).toEqual([{ code: 'workflow-unavailable' }]);
});

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

  it('adds source to a webhook body only when the event has one', async () => {
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

  it('adds source to a start-workflow event input only when the event has one', async () => {
    const inputs: unknown[] = [];
    const setup = fixture({
      workflows: () => ({
        assertStartable: () => undefined,
        findStart: () => Promise.resolve(undefined),
        start: (_id: string, options: { input?: unknown }) => {
          inputs.push(options.input);
          return Promise.resolve({
            runId: `run-${inputs.length}`,
            workflow: 'lookup',
            workflowVersion: 'v1',
          });
        },
      }),
    });
    await setup.hooks.create({
      events: ['run.settled'],
      action: { type: 'start-workflow', workflowId: 'lookup', input: 'event' },
    });

    await setup.fire();
    await setup.fire({ source: 'calendar' });

    expect(inputs).toHaveLength(2);
    expect(Object.hasOwn(inputs[0] as object, 'source')).toBe(false);
    expect(inputs[1]).toEqual({
      kind: 'run.settled',
      bureauId: 'plugin-bureau',
      emittedAtMs: 1_800_000_000_000,
      payload: { runId: 'r1' },
      source: 'calendar',
    });
  });

  it('hands the action its delivery id and the idempotency key of that delivery', async () => {
    const setup = fixture();
    const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

    await setup.fire();
    await setup.fire();

    const deliveries = await setup.hooks.deliveries(hook.id);
    expect(deliveries).toHaveLength(2);
    expect(setup.received).toHaveLength(2);
    const keys = setup.received.map((context) => context.idempotencyKey);
    for (const delivery of deliveries) {
      const context = setup.received.find((candidate) => candidate.deliveryId === delivery.id);
      expect(context?.idempotencyKey).toBe(`hook:${hook.id}:${delivery.id}`);
    }
    expect(new Set(keys).size).toBe(2);
  });

  it('hands a replayed attempt, after an interrupted one succeeded, the same idempotency key', async () => {
    const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
    const effects: string[] = [];
    const signals: AbortSignal[] = [];
    // The first attempt does its external effect, then the process stops before the delivery is
    // marked delivered; the attempt after the restart must be able to tell it already happened.
    const first = fixture({
      kv,
      run: (context) => {
        effects.push(context.idempotencyKey);
        signals.push(context.signal);
        first.state.shuttingDown = true;
        return Promise.reject(new Error('the process is stopping'));
      },
    });
    const hook = await first.hooks.create({ events: ['run.settled'], action: ACTION });
    await first.fire();
    const [stopped] = await first.hooks.deliveries(hook.id);
    expect(stopped!.status).toBe('pending');
    // The shutdown aborted the signal the reaction was given (COR-2175).
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);

    const second = fixture({
      kv,
      run: (context) => {
        effects.push(context.idempotencyKey);
        return Promise.resolve();
      },
    });
    await second.resume();

    const [delivery] = await second.hooks.deliveries(hook.id);
    expect(delivery!.status).toBe('delivered');
    expect(delivery!.attempts.map((attempt) => attempt.outcome)).toEqual([
      'interrupted',
      'completed',
    ]);
    expect(effects).toEqual([`hook:${hook.id}:${delivery!.id}`, `hook:${hook.id}:${delivery!.id}`]);
  });

  it('runs a delivery pending across an upgrade only on the version it was created against', async () => {
    const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
    const ran: string[] = [];
    const at =
      (version: string, onRun: (context: PluginReactionContext) => Promise<void>) =>
      (): readonly HookActionKindRegistration[] => [
        {
          plugin: 'slack',
          version,
          kind: {
            name: 'post-message',
            description: 'Posts the event to a channel.',
            configuration: CONFIGURATION,
            run: (context) => {
              ran.push(version);
              return onRun(context);
            },
          },
        },
      ];
    // The delivery is created at 1.0.0 and left pending by a process that stops under it.
    const first = fixture({
      kv,
      registrations: at('1.0.0', () => {
        first.state.shuttingDown = true;
        return Promise.reject(new Error('the process is stopping'));
      }),
    });
    const hook = await first.hooks.create({ events: ['run.settled'], action: ACTION });
    await first.fire();
    const [pending] = await first.hooks.deliveries(hook.id);
    expect(pending?.status).toBe('pending');

    // The plugin is upgraded: the delivery fails, permanently, and 2.0.0 never runs it.
    const upgraded = fixture({ kv, registrations: at('2.0.0', () => Promise.resolve()) });
    await upgraded.resume();
    const delivery = await onlyDelivery(upgraded.hooks, hook.id);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempts.at(-1)).toMatchObject({ outcome: 'rejected' });
    expect(delivery.attempts.at(-1)?.error).toContain('version 1.0.0');
    expect(delivery.attempts.at(-1)?.error).toContain('version-mismatch');
    expect(ran).toEqual(['1.0.0']);

    // At the same version, a pending delivery resumes as before.
    const kvSame = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
    const stopping = fixture({
      kv: kvSame,
      registrations: at('1.0.0', () => {
        stopping.state.shuttingDown = true;
        return Promise.reject(new Error('the process is stopping'));
      }),
    });
    const sameHook = await stopping.hooks.create({ events: ['run.settled'], action: ACTION });
    await stopping.fire();
    const same = fixture({ kv: kvSame, registrations: at('1.0.0', () => Promise.resolve()) });
    await same.resume();
    const resumed = await onlyDelivery(same.hooks, sameHook.id);
    expect(resumed.status).toBe('delivered');
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

  it('is retried when it rejects with a PluginReactionError that is not permanent (COR-2174)', async () => {
    const setup = fixture({
      run: () => Promise.reject(new PluginReactionError('Slack is down')),
    });
    const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

    await setup.fire();

    const delivery = await onlyDelivery(setup.hooks, hook.id);
    expect(delivery.status).toBe('exhausted');
    expect(delivery.attempts.map((attempt) => attempt.outcome)).toEqual([
      'error',
      'error',
      'error',
    ]);
  });

  it('ends failed after one rejected attempt when it rejects with a permanent PluginReactionError (COR-2174)', async () => {
    const setup = fixture({
      run: () => Promise.reject(new PluginReactionError('No such channel', { permanent: true })),
    });
    const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

    await setup.fire();

    const delivery = await onlyDelivery(setup.hooks, hook.id);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempts).toHaveLength(1);
    expect(delivery.attempts[0]).toMatchObject({ outcome: 'rejected', error: 'No such channel' });
  });

  describe('timeout, disable and delete (COR-2175)', () => {
    /** A run that waits for its signal and rejects with its reason. */
    const untilAborted = (context: PluginReactionContext) =>
      new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason as Error), {
          once: true,
        });
      });

    it('aborts the signal at the request timeout by default, ends the attempt in error and retries it', async () => {
      const calls: PluginReactionContext[] = [];
      const setup = fixture({
        run: (context) => {
          calls.push(context);
          return calls.length === 1 ? untilAborted(context) : Promise.resolve();
        },
      });
      const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

      const firing = setup.fire();
      await waitUntil(() => setup.timeouts.length === 1, { message: 'the first timeout' });
      expect(setup.timeouts[0]?.milliseconds).toBe(10_000);
      setup.timeouts[0]!.fire();
      await firing;

      expect(calls[0]?.signal.aborted).toBe(true);
      const delivery = await onlyDelivery(setup.hooks, hook.id);
      expect(delivery.status).toBe('delivered');
      expect(delivery.attempts.map((attempt) => attempt.outcome)).toEqual(['error', 'completed']);
      expect(delivery.attempts[0]?.error).toBe('The reaction timed out after 10000 ms');
    });

    it('uses the reaction’s own timeoutMilliseconds when it sets one', async () => {
      const setup = fixture({ timeoutMilliseconds: 2_500 });
      await setup.hooks.create({ events: ['run.settled'], action: ACTION });

      await setup.fire();

      expect(setup.timeouts.map((timeout) => timeout.milliseconds)).toEqual([2_500]);
    });

    it('refuses a timeoutMilliseconds that is not a positive safe integer when the hooks are built', () => {
      for (const timeoutMilliseconds of [0, -5, 1.5, Number.NaN]) {
        expect(() => fixture({ timeoutMilliseconds })).toThrow('timeoutMilliseconds');
      }
    });

    it('aborts the signal of a run in flight when its hook is disabled, and ends the delivery aborted', async () => {
      const calls: PluginReactionContext[] = [];
      const setup = fixture({
        run: (context) => {
          calls.push(context);
          return untilAborted(context);
        },
      });
      const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

      const firing = setup.fire();
      await waitUntil(() => calls.length === 1, { message: 'the run to start' });
      await setup.hooks.update(hook.id, { enabled: false });
      await firing;

      expect(calls[0]?.signal.aborted).toBe(true);
      const delivery = await onlyDelivery(setup.hooks, hook.id);
      expect(delivery.status).toBe('aborted');
      expect(delivery.attempts).toHaveLength(1);
      expect(delivery.attempts[0]).toMatchObject({
        outcome: 'error',
        error: 'The hook was disabled',
      });
    });

    it('aborts the signal of a run in flight when its hook is deleted, and leaves no delivery', async () => {
      const calls: PluginReactionContext[] = [];
      const setup = fixture({
        run: (context) => {
          calls.push(context);
          return untilAborted(context);
        },
      });
      const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

      const firing = setup.fire();
      await waitUntil(() => calls.length === 1, { message: 'the run to start' });
      expect(await setup.hooks.delete(hook.id)).toBe(true);
      await firing;

      expect(calls[0]?.signal.aborted).toBe(true);
      expect(await setup.hooks.deliveries(hook.id)).toEqual([]);
      expect(await createHookStore(setup.kv).listStoredDeliveries()).toEqual([]);
    });

    it('holds the delivery’s lease for at least the reaction’s timeout, so a hung run is not taken from under it', async () => {
      const setup = fixture({
        timeoutMilliseconds: 60_000,
        run: () => new Promise<void>(() => undefined),
      });
      const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

      void setup.fire();
      await waitUntil(
        async () => {
          const written = await createHookStore(setup.kv).listStoredDeliveries();
          return written.length === 1;
        },
        { message: 'the delivery to be written' },
      );
      const [stored] = await createHookStore(setup.kv).listStoredDeliveries();
      expect(stored?.record.hookId).toBe(hook.id);
      // The fixture's clock stands still at this instant, and its backoff is zero.
      expect(stored?.record.leaseUntil).toBeGreaterThanOrEqual(1_800_000_000_000 + 60_000);
    });
  });

  describe('on an event its own plugin published (COR-2173)', () => {
    const envelope = (source?: string) =>
      ({
        sequence: 0,
        cursor: '0',
        bureauId: 'plugin-bureau',
        kind: 'run.settled',
        emittedAtMs: 1_800_000_000_000,
        payload: { runId: 'r1' },
        ...(source === undefined ? {} : { source }),
      }) satisfies BureauEventEnvelope;

    it('writes no delivery, and says so through notice', async () => {
      const setup = fixture();
      const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

      await setup.fire({ source: 'slack' });

      expect(setup.received).toHaveLength(0);
      expect(await setup.hooks.deliveries(hook.id)).toEqual([]);
      expect(setup.notices).toEqual([
        `[bureau] Hook ${hook.id} did not run its plugin action: Skipped: run.settled came from plugin slack, and a plugin's reaction does not fire on its own plugin's events`,
      ]);
    });

    it('still delivers an event from Bureau core and one from another plugin', async () => {
      const setup = fixture();
      const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

      await setup.fire();
      await setup.fire({ source: 'calendar' });

      expect(setup.received.map((context) => context.event.source)).toEqual([
        undefined,
        'calendar',
      ]);
      expect(await setup.hooks.deliveries(hook.id)).toHaveLength(2);
      expect(setup.notices).toEqual([]);
    });

    it('settles after one delivery when its run raises the kind its hook lists', async () => {
      let raised = 0;
      const setup = fixture({
        run: () => {
          // Bounded, so a missing guard fails the count below instead of never settling.
          if (raised < 3) {
            raised += 1;
            setup.dispatch(envelope('slack'));
          }
          return Promise.resolve();
        },
      });
      const hook = await setup.hooks.create({ events: ['run.settled'], action: ACTION });

      await setup.fire({ source: 'calendar' });
      await setup.drain();

      expect(raised).toBe(1);
      expect(await setup.hooks.deliveries(hook.id)).toHaveLength(1);
      expect(setup.notices).toHaveLength(1);
    });
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

  it('writes no delivery when its plugin no longer contributes the kind (COR-2182)', async () => {
    const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
    const before = fixture({ kv });
    const hook = await before.hooks.create({ events: ['run.settled'], action: ACTION });

    // The Bureau restarts with the plugin removed.
    const after = fixture({ kv, registrations: () => [] });
    await after.fire();

    expect(await after.hooks.deliveries(hook.id)).toEqual([]);
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
    const received: PluginReactionContext[] = [];
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
      formatters: [
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

  it('starts with the plugins that are valid when one plugin’s reaction sets an invalid timeoutMilliseconds (COR-2175)', async () => {
    const reaction = (name: string, timeoutMilliseconds: number) => ({
      name,
      description: 'Posts.',
      configuration: CONFIGURATION,
      timeoutMilliseconds,
      run: () => Promise.resolve(),
    });
    const plugin = (name: string, timeoutMilliseconds: number) => ({
      descriptor: definePlugin({
        name,
        version: '1.0.0',
        description: name,
        setup: () => ({ reactions: [reaction('post', timeoutMilliseconds)] }),
      }),
      source: 'package' as const,
      location: `@example/${name}`,
    });
    const { bureau, dispose } = await openHooksBureau({
      storage: new MemoryStorage(),
      fetch: (() => Promise.reject(new Error('no request is made'))) as unknown as typeof fetch,
      key: await newEncryptionKey(),
      plugins: [plugin('broken', -1), plugin('fine', 5_000)],
    });
    try {
      const listed = await listedPlugins(bureau);
      expect(listed.map((listing) => [listing.descriptor.name, listing.status])).toEqual([
        ['broken', 'skipped'],
        ['fine', 'running'],
      ]);
      expect(listed[0]?.problems).toEqual([
        expect.objectContaining({ code: 'setup-failed', message: expect.stringContaining('-1') }),
      ]);
      const hook = await bureau.hooks!.create({
        events: ['run.registered'],
        action: { type: 'plugin', plugin: 'fine', kind: 'post', configuration: { channel: 'ops' } },
      });
      expect(hook.action).toMatchObject({ plugin: 'fine' });
    } finally {
      await dispose();
    }
  });

  it('resolves a stored secret reference through the Bureau’s plugin secrets, and keeps no value (COR-2177)', async () => {
    const received: PluginReactionContext[] = [];
    const secret = 'sk-live-wiring-0123456789';
    const { bureau, dispose } = await openHooksBureau({
      storage: new MemoryStorage(),
      fetch: (() => Promise.reject(new Error('no request is made'))) as unknown as typeof fetch,
      key: await newEncryptionKey(),
      pluginSecrets: {
        get: (key) => Promise.resolve(key === 'slack-token' ? secret : undefined),
        watch: () => () => undefined,
      },
      hooks: {
        actionKinds: [
          {
            plugin: 'slack',
            kind: {
              name: 'post-message',
              description: 'Posts the event to a channel.',
              configuration: z.object({
                channel: z.string(),
                token: z.string().meta({ secret: true }),
              }),
              run: (context) => {
                received.push(context);
                return Promise.resolve();
              },
            },
          },
        ],
      },
    });
    try {
      const hook = await bureau.hooks!.create({
        events: ['run.registered'],
        action: {
          ...ACTION,
          configuration: { channel: 'ops', token: { $secret: 'slack-token' } },
        },
      });
      await fireRunEvents(bureau);
      const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);
      expect(delivery).toMatchObject({ actionType: 'plugin', status: 'delivered' });
      expect(received[0]?.configuration).toEqual({ channel: 'ops', token: secret });
      expect(JSON.stringify(await bureau.hooks!.list())).not.toContain(secret);
      expect(JSON.stringify(delivery)).not.toContain(secret);
    } finally {
      await dispose();
    }
  });
});

describe('a hook record written before reactions were renamed', () => {
  it('still delivers through the reactions a plugin contributes, after a restart', async () => {
    const received: PluginReactionContext[] = [];
    const slack = definePlugin({
      name: 'slack',
      version: '1.0.0',
      description: 'Posts to channels.',
      setup: () => ({
        reactions: [
          {
            name: 'post-message',
            description: 'Posts the event to a channel.',
            configuration: CONFIGURATION,
            run: (context) => {
              received.push(context);
              return Promise.resolve();
            },
          },
        ],
      }),
    });
    const storage = new MemoryStorage();
    const key = await newEncryptionKey();
    const reject = (() =>
      Promise.reject(new Error('no request is made'))) as unknown as typeof fetch;
    const open = async () => {
      const composed = await composePlugins({
        plugins: [{ descriptor: slack, source: 'package', location: '@example/slack' }],
        hooks: {},
      });
      return openHooksBureau({ storage, fetch: reject, key, hooks: composed.options.hooks });
    };

    const first = await open();
    // The stored action is `{ type: 'plugin', plugin, kind, configuration }`: the field named
    // `kind` is not the contribution key, so the rename leaves the record as it was written.
    const hook = await first.bureau.hooks!.create({ events: ['run.registered'], action: ACTION });
    expect(Object.keys(hook.action).toSorted()).toEqual([
      'configuration',
      'kind',
      'plugin',
      'type',
    ]);
    await first.dispose();

    const second = await open();
    try {
      const stored = await second.bureau.hooks!.get(hook.id);
      expect(stored?.action).toEqual(ACTION);
      await fireRunEvents(second.bureau);
      const [delivery] = await waitForSettledDeliveries(second.bureau, hook.id, 1);
      expect(delivery).toMatchObject({ actionType: 'plugin', status: 'delivered' });
      expect(received[0]?.configuration).toEqual({ channel: 'ops', urgent: false });
    } finally {
      await second.dispose();
    }
  });
});
