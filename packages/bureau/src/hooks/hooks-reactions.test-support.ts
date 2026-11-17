/**
 * COR-2173 to COR-2177 — a harness for the delivery of a plugin reaction. The hooks are built over a
 * scripted engine: its clock moves by hand, its backoff waits are held until the test releases them,
 * and its timeouts fire when the test says so, so nothing waits on a real timer. Two harnesses over
 * one `kv` and one `clock` are a restart.
 */
import type { generateEncryptionKey } from '@lostgradient/cryptography';
import type { PluginReactionContext, PluginReceipt } from '@lostgradient/interborough-plugin';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { expect } from 'bun:test';
import { z } from 'zod';

import type { BureauEventEnvelope } from '../bureau-event-feed.ts';
import type { WebhookDeliveryEngine } from '../webhook-notifier.ts';
import { createHooks, type HooksDependencies } from './create-hooks.ts';
import { createHookStore } from './hook-store.ts';
import {
  HookError,
  type HookActionKindRegistration,
  type HookDelivery,
  type HookDeliveryRecord,
} from './hook-types.ts';

export const CONFIGURATION = z.object({ channel: z.string(), urgent: z.boolean().default(false) });

/** The action of the hooks the harness makes. */
export const ACTION = {
  type: 'plugin',
  plugin: 'slack',
  kind: 'post-message',
  configuration: { channel: 'ops' },
} as const;

export const START = 1_800_000_000_000;

/** The default time a reaction's run is given: the request timeout. */
export const DEFAULT_TIMEOUT = 10_000;

export type Kv = ReturnType<typeof textValueStore>;

/** What a run does; `call` counts from 1 across the harness. */
export type RunBehavior = (
  context: PluginReactionContext,
  call: number,
) => Promise<void | { readonly receipt?: PluginReceipt }>;

export interface HarnessOptions {
  /** Shared by two harnesses, a restart reads what the first left. */
  readonly kv?: Kv;
  /** Shared by two harnesses, so a restart sees the same moment. */
  readonly clock?: { milliseconds: number };
  readonly run?: RunBehavior;
  /** What a reaction's `dryRun` does; with none, the reaction has no `dryRun`. `call` counts its calls. */
  readonly dryRun?: RunBehavior;
  /** The engine's `maxAttempts`. */
  readonly maxAttempts?: number;
  /** The reaction's own `maxAttempts` (COR-2183); with none, it sets none. */
  readonly reactionMaxAttempts?: number;
  /** The wait before the next attempt. */
  readonly backoff?: number;
  /** The wait after attempt `attempt`, as the notifier's schedule gives it; defaults to the constant `backoff`. */
  readonly backoffFor?: (attempt: number) => number;
  /**
   * What a wait of more than zero does: `held` keeps it until the test releases it (or a shutdown
   * ends it, as the notifier's wait ends); `advance` moves the clock by it and ends it at once, so a
   * re-scan for a live lease finds it expired instead of spinning.
   */
  readonly waits?: 'held' | 'advance';
  readonly version?: string;
  /** The reaction's own `timeoutMilliseconds`. */
  readonly timeoutMilliseconds?: number;
  /** How long a request may take; the default timeout of a reaction that sets none. */
  readonly requestTimeoutMilliseconds?: number;
  readonly registrations?: (
    run: (context: PluginReactionContext) => Promise<void | { readonly receipt?: PluginReceipt }>,
  ) => readonly HookActionKindRegistration[];
  readonly fetch?: typeof fetch;
  readonly keys?: Awaited<ReturnType<typeof generateEncryptionKey>>;
  readonly workflows?: HooksDependencies['workflows'];
  readonly notifications?: HooksDependencies['notifications'];
  /** The availability of the reaction's plugin, as its secret gate reports it. */
  readonly gate?: AvailabilityGate;
  /** The schema the reaction's configuration is parsed with; a channel and an urgent flag by default. */
  readonly configuration?: z.ZodType;
  /** Reads the secrets a stored `{ "$secret": key }` names. */
  readonly configurationSecrets?: HooksDependencies['configurationSecrets'];
  /** The workspace the hooks capture their owner's authority from. */
  readonly workspace?: HooksDependencies['workspace'];
  /** Writes an event as a person reads it: a reaction's `format`, and a notification's words (COR-2178). */
  readonly formatEvent?: HooksDependencies['formatEvent'];
  /** What an owner is allowed to see of an event, applied before a delivery is written. */
  readonly eventForHookOwner?: HooksDependencies['eventForHookOwner'];
  /** The records a hook's scope is matched against. */
  readonly subjects?: HooksDependencies['subjects'];
}

/** What a plugin's secret gate tells the hooks: whether its secrets are set, and when that changes. */
export function availabilityGate(initiallyAvailable = true) {
  const listeners = new Set<() => void>();
  const gate = {
    available: initiallyAvailable,
    listeners,
    /** Saves or removes the plugin's secret: the gate re-reads and tells every listener. */
    set(available: boolean): void {
      gate.available = available;
      for (const listener of listeners) listener();
    },
  };
  return gate;
}

export type AvailabilityGate = ReturnType<typeof availabilityGate>;

/** The two members a registration carries for `gate`, as `ContributionSet.add` fills them. */
export function gateRegistration(gate: AvailabilityGate) {
  return {
    availability: () => (gate.available ? ('available' as const) : ('needs-setup' as const)),
    onAvailabilityChange: (listener: () => void) => {
      gate.listeners.add(listener);
      return () => {
        gate.listeners.delete(listener);
      };
    },
  };
}

export function harness(options: HarnessOptions = {}) {
  const kv = options.kv ?? textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
  const clock = options.clock ?? { milliseconds: START };
  const shutdownController = new AbortController();
  const tracked: Promise<void>[] = [];
  const held: Array<{ readonly milliseconds: number; release(): void }> = [];
  const notices: string[] = [];
  const diagnostics: string[] = [];
  const audits: string[] = [];
  const auditEntries: Array<{
    readonly runId: string;
    readonly type: string;
    readonly principal?: string;
    readonly detail: unknown;
  }> = [];
  const calls: PluginReactionContext[] = [];
  const backoff = options.backoff ?? 0;
  const engine: WebhookDeliveryEngine = {
    fetch:
      options.fetch ??
      ((() => Promise.reject(new Error('no request is made'))) as unknown as typeof fetch),
    now: () => clock.milliseconds,
    maxAttempts: options.maxAttempts ?? 3,
    backoffMilliseconds: (attempt) => options.backoffFor?.(attempt) ?? backoff,
    wait: (milliseconds) => {
      if (milliseconds <= 0) return Promise.resolve();
      if (options.waits === 'advance') {
        clock.milliseconds += milliseconds;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        held.push({ milliseconds, release: resolve });
        // The notifier's wait ends early when it shuts down.
        shutdownController.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    shuttingDown: () => shutdownController.signal.aborted,
    signal: shutdownController.signal,
    track: (promise) => {
      tracked.push(promise);
    },
    tracked: (_id, _hookId, work) => work(),
  };
  const run: RunBehavior = options.run ?? (() => Promise.resolve());
  const execute = (
    context: PluginReactionContext,
  ): Promise<void | { readonly receipt?: PluginReceipt }> => {
    calls.push(context);
    return run(context, calls.length);
  };
  const dryRunCalls: PluginReactionContext[] = [];
  const dryRunBehavior = options.dryRun;
  const executeDryRun = (
    context: PluginReactionContext,
  ): Promise<void | { readonly receipt?: PluginReceipt }> => {
    dryRunCalls.push(context);
    return dryRunBehavior === undefined
      ? Promise.resolve()
      : dryRunBehavior(context, dryRunCalls.length);
  };
  // The timeouts the deliveries asked for, each ended by the test (`fire`), never by a clock.
  const timeouts: Array<{ readonly milliseconds: number; fire(): void }> = [];
  const registrations = options.registrations?.(execute) ?? [
    {
      plugin: 'slack',
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.gate === undefined ? {} : gateRegistration(options.gate)),
      kind: {
        name: 'post-message',
        description: 'Posts the event to a channel.',
        configuration: options.configuration ?? CONFIGURATION,
        run: execute,
        ...(options.dryRun === undefined ? {} : { dryRun: executeDryRun }),
        ...(options.reactionMaxAttempts === undefined
          ? {}
          : { maxAttempts: options.reactionMaxAttempts }),
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
    keys: options.keys === undefined ? undefined : { current: options.keys },
    bureauId: 'matrix-bureau',
    newId: (kind) => `${kind}-${++next}`,
    audit: (entry) => {
      audits.push(entry.type);
      auditEntries.push(entry);
      return Promise.resolve();
    },
    diagnose: (message) => {
      diagnostics.push(message);
    },
    notice: (message) => {
      notices.push(message);
    },
    actionKinds: registrations,
    timeoutSignal: (milliseconds) => {
      const controller = new AbortController();
      timeouts.push({
        milliseconds,
        fire: () => controller.abort(new DOMException('The operation timed out', 'TimeoutError')),
      });
      return controller.signal;
    },
    ...(options.requestTimeoutMilliseconds === undefined
      ? {}
      : { requestTimeoutMilliseconds: options.requestTimeoutMilliseconds }),
    ...(options.workflows === undefined ? {} : { workflows: options.workflows }),
    ...(options.notifications === undefined ? {} : { notifications: options.notifications }),
    ...(options.configurationSecrets === undefined
      ? {}
      : { configurationSecrets: options.configurationSecrets }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.subjects === undefined ? {} : { subjects: options.subjects }),
    ...(options.formatEvent === undefined ? {} : { formatEvent: options.formatEvent }),
    ...(options.eventForHookOwner === undefined
      ? {}
      : { eventForHookOwner: options.eventForHookOwner }),
  });
  const view = {
    kv,
    clock,
    hooks: created.hooks,
    created,
    calls,
    /** The contexts `dryRun` was called with. */
    dryRunCalls,
    held,
    timeouts,
    notices,
    diagnostics,
    audits,
    auditEntries,
    tracked,
    /** Stops the process under its deliveries, as a shutdown does. */
    shutdown(): void {
      shutdownController.abort();
    },
    /** Opens the hooks to events and resumes what a last process left. */
    async open(): Promise<void> {
      await created.resume();
    },
    /** Publishes an event and returns without waiting for its deliveries. */
    dispatch(extra: { readonly kind?: string; readonly source?: string } = {}): void {
      created.dispatch({
        sequence: 0,
        cursor: '0',
        bureauId: 'matrix-bureau',
        kind: extra.kind ?? 'run.settled',
        emittedAtMs: START,
        payload: { runId: 'r1' },
        ...(extra.source === undefined ? {} : { source: extra.source }),
      } satisfies BureauEventEnvelope);
    },
    /** Waits for every tracked promise, including those a settling delivery adds. */
    async drain(): Promise<void> {
      while (tracked.length > 0) await Promise.all(tracked.splice(0));
    },
    /** Lets every held wait finish, as the clock reaching them would. */
    releaseWaits(): void {
      for (const wait of held.splice(0)) wait.release();
    },
    async hook(events: readonly string[] = ['run.settled']) {
      return created.hooks.create({ events: [...events], action: ACTION });
    },
    /** A hook whose action carries `configuration`, as written. */
    async hookWith(configuration: unknown) {
      return created.hooks.create({
        events: ['run.settled'],
        action: { ...ACTION, configuration },
      });
    },
    /** What writing a hook with `configuration` is refused with, or `undefined` when it is stored. */
    async refusalOf(configuration: unknown): Promise<HookError | undefined> {
      const error = await created.hooks
        .create({ events: ['run.settled'], action: { ...ACTION, configuration } })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      if (error === undefined) return undefined;
      expect(error).toBeInstanceOf(HookError);
      return error as HookError;
    },
    /** The deliveries of `hookId`, oldest first. */
    async deliveries(hookId: string): Promise<HookDelivery[]> {
      const newestFirst = await created.hooks.deliveries(hookId);
      return newestFirst.toReversed();
    },
    async only(hookId: string): Promise<HookDelivery> {
      const found = await view.deliveries(hookId);
      expect(found).toHaveLength(1);
      return found[0]!;
    },
    /** The status of the delivery `hookId` has, of which there must be one. */
    async status(hookId: string): Promise<HookDelivery['status']> {
      const delivery = await view.only(hookId);
      return delivery.status;
    },
    /** The status of each delivery `hookId` has, oldest first. */
    async statuses(hookId: string): Promise<HookDelivery['status'][]> {
      const found = await view.deliveries(hookId);
      return found.map((delivery) => delivery.status);
    },
    /** The stored record of a delivery, with its lease. */
    async record(hookId: string): Promise<HookDeliveryRecord> {
      const stored = await createHookStore(kv).listStoredDeliveries();
      const listed = stored.filter((candidate) => candidate.record.hookId === hookId);
      expect(listed).toHaveLength(1);
      return listed[0]!.record;
    },
  };
  return view;
}

export type Harness = ReturnType<typeof harness>;

export const outcomes = (delivery: HookDelivery) =>
  delivery.attempts.map((attempt) => attempt.outcome);

/** A run that waits for its signal and then rejects with the signal's reason, as a cooperative one does. */
export const untilAborted = (context: PluginReactionContext): Promise<void> =>
  new Promise<void>((_resolve, reject) => {
    const abort = () => reject(context.signal.reason as Error);
    if (context.signal.aborted) abort();
    else context.signal.addEventListener('abort', abort, { once: true });
  });

/** A run that never settles, whatever its signal says. */
export const never = (): Promise<void> => new Promise<void>(() => undefined);

/** A promise the test settles by hand. */
export function deferred<T = void>() {
  const settle: { resolve: (value: T) => void; reject: (error: Error) => void } = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const promise = new Promise<T>((resolve, reject) => {
    settle.resolve = resolve;
    settle.reject = reject;
  });
  return { promise, resolve: settle.resolve, reject: settle.reject };
}

/** Waits until the harness's `count`-th run has started. */
export const runStarted = (h: Harness, count = 1) =>
  waitUntil(() => h.calls.length >= count, { message: `run number ${count} to start` });

/** A reaction configuration with one secret field, which holds a reference and never a value. */
export const SECRET_CONFIGURATION = z.object({
  channel: z.string(),
  token: z.string().meta({ secret: true }),
});

/** A value no test text contains by chance, so a scan for it finds only a leak. */
export const SENTINEL = 'sk-live-sentinel-7f3a9c41e0b2d865';

/** The reference a hook stores for the secret `key`. */
export const reference = (key: string) => ({ $secret: key });

/** A reader of published secrets that a test sets, and that records what was asked of it. */
export function secretReader(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  const reads: string[] = [];
  return {
    values,
    reads,
    get: (key: string): Promise<string | undefined> => {
      reads.push(key);
      return Promise.resolve(values.get(key));
    },
  };
}

/** Every text the store holds, whole: the hook records, the deliveries, and everything beside them. */
export async function rawStoreOf(kv: Kv): Promise<string> {
  const texts: string[] = [];
  for (const key of await kv.list('')) {
    const text = await kv.get(key);
    if (text !== null) texts.push(text);
  }
  return texts.join('\n');
}
