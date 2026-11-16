/**
 * COR-2167 — the listener lease and fenced fires, one row per row of the issue's outcome matrix
 * (`tmp/chef/briefs/COR-2167-matrix.md`, with its accepted "Open" recommendations). Each row names
 * the matrix row it proves. Two or three supervisors share one key-value store, each with a real
 * process lease of its own on its own manual clock and timers; a tick is a renewal of that lease.
 * The last rows go through a Bureau, for the wiring only.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type {
  PluginTrigger,
  PluginTriggerContext,
  PluginTriggerOutcome,
} from '@lostgradient/interborough-plugin';
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  type Storage,
  textValueStore,
  type TextValueStoreBatchOperation,
  type TextValueStoreCondition,
} from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { z } from 'zod';

import { projectBureauEvent } from './bureau-event-feed';
import { workflowsTriggersRetryOperation } from './http/management/workflows-operations';
import { createPluginSecretGate, gatedContributions } from './plugins/plugin-secret-gate';
import type { BureauPluginSecrets } from './plugins/plugin-types';
import {
  openProcessLease,
  type ProcessLease,
  PROCESS_LEASE_MILLISECONDS,
  processLeaseKey,
} from './process-lease';
import { watchPlugin } from './testing/watch-plugin.test-support';
import { startWorkflowBureau } from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import type { VersionedCatalogEntry } from './versioned-catalog';
import { createWorkflowTriggerLease, triggerLeaseKey } from './workflow-trigger-lease';
import { reportListener } from './workflow-trigger-reports';
import {
  createWorkflowTriggerSupervisor,
  type DesiredTrigger,
  type ListenerStatus,
  type TriggerEventRecord,
  type TriggerFireRequest,
  type WorkflowTriggerSupervisor,
} from './workflow-trigger-supervisor';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const ORIGIN = '2020-01-01T00:00:00.000Z';
const KIND = 'x:watch';
const SECRET_KEY = 'x-token';
const RECORD = triggerLeaseKey('a');

/** The ISO time `seconds` after the origin. */
const at = (seconds: number): string => new Date(Date.parse(ORIGIN) + seconds * 1000).toISOString();

/**
 * A promise a test settles by hand. Every gate is opened in cleanup, before the peers close, so a
 * row that fails before it opens one fails on its assertion instead of hanging the close.
 */
function gate(): { promise: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  const open = () => resolve();
  cleanups.push(open);
  return { promise, open };
}

/** What a peer's store does before it passes a call on: a test may hold it, or throw. */
interface StoreFaults {
  get?: ((key: string) => Promise<void> | void) | undefined;
  set?: ((key: string) => Promise<void> | void) | undefined;
  batch?:
    | ((
        conditions: readonly TextValueStoreCondition[],
        operations: readonly TextValueStoreBatchOperation[],
      ) => Promise<void> | void)
    | undefined;
  /** Runs after a batch committed or not, before its answer reaches the caller. */
  afterBatch?:
    | ((operations: readonly TextValueStoreBatchOperation[], committed: boolean) => Promise<void>)
    | undefined;
}

/** A view of `base` that logs the trigger lease keys it touches and lets a test inject faults. */
function instrumented(
  base: ConditionalTextValueStore,
  log: { readonly reads: string[]; readonly writes: string[] },
  faults: StoreFaults,
): ConditionalTextValueStore {
  const isLease = (key: string) => key.startsWith('bureau-trigger:');
  return {
    ...base,
    get: async (key) => {
      if (isLease(key)) log.reads.push(key);
      await faults.get?.(key);
      return base.get(key);
    },
    set: async (key, value) => {
      if (isLease(key)) log.writes.push(key);
      await faults.set?.(key);
      return base.set(key, value);
    },
    delete: async (key) => {
      if (isLease(key)) log.writes.push(key);
      return base.delete(key);
    },
    conditionalBatch: async (conditions, operations) => {
      for (const operation of operations)
        if (isLease(operation.key)) log.writes.push(operation.key);
      await faults.batch?.(conditions, operations);
      const committed = await base.conditionalBatch(conditions, operations);
      await faults.afterBatch?.(operations, committed);
      return committed;
    },
    list: (prefix) => base.list(prefix),
    has: (key) => base.has(key),
    deletePrefix: (prefix) => base.deletePrefix(prefix),
    close: async () => undefined,
  };
}

type Files = Readonly<Record<string, { account?: unknown; paused?: boolean }>>;

/** One Bureau process over the shared store, reduced to its trigger supervisor and its lease. */
interface Peer {
  readonly name: string;
  readonly services: ManualRuntimeServices;
  readonly processLease: ProcessLease;
  readonly supervisor: WorkflowTriggerSupervisor;
  /** This process's record value. */
  readonly own: string;
  readonly starts: PluginTriggerContext[];
  readonly stops: string[];
  readonly requests: TriggerFireRequest[];
  readonly diagnosed: Array<{ readonly message: string; readonly cause: unknown }>;
  /** What the problem reporter was told, in order. */
  readonly calls: string[];
  /** The trigger events this process published (COR-2250). */
  readonly published: TriggerEventRecord[];
  /** The trigger lease keys this process read, and wrote, in order. */
  readonly reads: string[];
  readonly writes: string[];
  faults: StoreFaults;
  onStart: (context: PluginTriggerContext, count: number) => Promise<void> | void;
  onStop: () => Promise<void> | void;
  answer: (request: TriggerFireRequest) => Promise<PluginTriggerOutcome>;
  status(id?: string): ListenerStatus | undefined;
  reconcile(files: Files, keep?: ReadonlySet<string>): Promise<void>;
  retry(id?: string): Promise<ListenerStatus | undefined>;
  /** One renewal of this process's lease, and the pass it queued. */
  tick(): Promise<void>;
  /** Advance the clock, fire the timers that fall due, and wait for what they queued. */
  advance(milliseconds: number): Promise<void>;
  /** Move only the wall clock: no timer fires. */
  passTime(milliseconds: number): void;
  settled(): Promise<void>;
  close(): Promise<void>;
}

interface PeerOptions {
  readonly name?: string;
  /** Wrap the kind, as a secret gate does. */
  readonly wrap?: (kind: PluginTrigger) => PluginTrigger;
  /** A kind with a `receive` and no `start`. */
  readonly receiveOnly?: boolean;
  /** The plugin that contributes the kind; `Bad_Plugin` cannot be given storage. */
  readonly plugin?: string;
}

/** The shared store every peer of a row works over. */
function sharedStore(): { readonly storage: Storage; readonly kv: ConditionalTextValueStore } {
  const storage = new MemoryStorage();
  return { storage, kv: textValueStore(storage, { disposeUnderlyingStorage: false }) };
}

const peersOfTheRow: Peer[] = [];

async function peer(
  shared: { readonly storage: Storage; readonly kv: ConditionalTextValueStore },
  options: PeerOptions = {},
): Promise<Peer> {
  const name = options.name ?? `p${peersOfTheRow.length + 1}`;
  const services = createManualRuntimeServices({ origin: ORIGIN });
  const reads: string[] = [];
  const writes: string[] = [];
  const faultBox: { faults: StoreFaults } = { faults: {} };
  const kv = instrumented(
    shared.kv,
    { reads, writes },
    {
      get: (key) => faultBox.faults.get?.(key),
      set: (key) => faultBox.faults.set?.(key),
      batch: (conditions, operations) => faultBox.faults.batch?.(conditions, operations),
      afterBatch: async (operations, committed) =>
        faultBox.faults.afterBatch?.(operations, committed),
    },
  );
  const diagnosed: Array<{ message: string; cause: unknown }> = [];
  const diagnose = (message: string, cause: unknown) => void diagnosed.push({ message, cause });
  const processLease = openProcessLease({
    kv,
    persistence: 'local',
    clock: services.clock,
    timers: services.timers,
    identifiers: services.identifiers,
    diagnose,
  });
  await processLease.start('manual');
  const lease = createWorkflowTriggerLease({
    kv,
    processLease,
    now: () => services.clock.now(),
    diagnose,
  });
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  };
  const requests: TriggerFireRequest[] = [];
  const published: TriggerEventRecord[] = [];
  const state: {
    starts: PluginTriggerContext[];
    stops: string[];
    requests: TriggerFireRequest[];
    calls: string[];
    onStart: Peer['onStart'];
    onStop: Peer['onStop'];
    answer: Peer['answer'];
  } = {
    starts: [],
    stops: [],
    requests,
    calls: [],
    onStart: () => undefined,
    onStop: () => undefined,
    answer: async () => ({ outcome: 'started', runId: `${name}-run-${requests.length}` }),
  };
  const trigger: PluginTrigger =
    options.receiveOnly === true
      ? {
          name: 'watch',
          description: 'Receives a delivery.',
          configuration: z.object({ account: z.string().optional() }),
          receive: async () => new Response(null, { status: 202 }),
        }
      : {
          name: 'watch',
          description: 'Watches a source.',
          configuration: z.object({ account: z.string().optional() }),
          start: async (context) => {
            state.starts.push(context);
            await state.onStart(context, state.starts.length);
            return async () => {
              state.stops.push(`stop:${name}`);
              await state.onStop();
            };
          },
        };
  const plugin = options.plugin ?? 'x';
  const entry: VersionedCatalogEntry<PluginTrigger> = {
    kind: 'trigger',
    name: `${plugin}:watch`,
    version: '1',
    id: `${plugin}:watch@1`,
    source: { name: plugin, version: '1' },
    value: options.wrap === undefined ? trigger : options.wrap(trigger),
  };
  const desiredOf = (files: Files): Map<string, DesiredTrigger> =>
    new Map(
      Object.entries(files).map(([id, { paused, ...rest }]) => [
        id,
        {
          kind: entry,
          trigger: { kind: entry.name, ...rest },
          ...(paused === undefined ? {} : { paused }),
        } satisfies DesiredTrigger,
      ]),
    );
  const supervisor = createWorkflowTriggerSupervisor({
    fire: async (request) => {
      state.requests.push(request);
      return state.answer(request);
    },
    diagnose,
    storage: shared.storage,
    nowISO: () => services.clock.nowISO(),
    timers: services.timers,
    exclusive,
    reportFailure: (pluginName, workflow) =>
      void state.calls.push(`report ${pluginName}/${workflow}`),
    clearFailure: (pluginName, workflow) =>
      void state.calls.push(`clear ${pluginName}/${workflow}`),
    lease,
    publish: (event) => void published.push(event),
  });
  const settled = async (): Promise<void> => {
    let seen: Promise<unknown>;
    do {
      seen = tail;
      await seen;
    } while (seen !== tail);
  };
  const self: Peer = {
    name,
    services,
    processLease,
    supervisor,
    own: JSON.stringify({ processId: processLease.processId }),
    starts: state.starts,
    stops: state.stops,
    requests: state.requests,
    diagnosed,
    calls: state.calls,
    published,
    reads,
    writes,
    get faults() {
      return faultBox.faults;
    },
    set faults(value) {
      faultBox.faults = value;
    },
    get onStart() {
      return state.onStart;
    },
    set onStart(value) {
      state.onStart = value;
    },
    get onStop() {
      return state.onStop;
    },
    set onStop(value) {
      state.onStop = value;
    },
    get answer() {
      return state.answer;
    },
    set answer(value) {
      state.answer = value;
    },
    status: (id = 'a') => supervisor.listener(id, entry.name),
    reconcile: (files, keep = new Set()) =>
      exclusive(() => supervisor.reconcile(desiredOf(files), keep)),
    retry: (id = 'a') => supervisor.retry(id),
    tick: async () => {
      await processLease.renew();
      await settled();
    },
    advance: async (milliseconds) => {
      await services.advance(milliseconds);
      await settled();
    },
    passTime: (milliseconds) => services.setTime(services.clock.now() + milliseconds),
    settled,
    close: () => supervisor.close(),
  };
  cleanups.push(async () => {
    faultBox.faults = {};
    await supervisor.close();
    processLease.halt();
  });
  peersOfTheRow.push(self);
  return self;
}

/** A listener status. */
const status = (
  state: ListenerStatus['state'],
  since: string,
  code: ListenerStatus['code'] = null,
  lastFiredAt: string | null = null,
  retryAt: string | null = null,
): ListenerStatus => ({ state, since, code, lastFiredAt, retryAt });

/** A start that throws. */
const boom = (): never => {
  throw new Error('the source refused the token sk-live-0123456789');
};

/** `p` lost its lease to `taker`, as a takeover would write it. */
async function takenBy(kv: ConditionalTextValueStore, taker: Peer, id = 'a'): Promise<void> {
  await kv.set(triggerLeaseKey(id), taker.own);
}

/** The peer's process crashed: its lease is no longer renewed, and it does nothing more. */
function crash(p: Peer): void {
  p.processLease.halt();
}

/** A store whose record reads, for `count` callers, wait until all of them have read. */
function readTogether(count: number): { readonly arrive: (key: string) => Promise<void> } {
  let arrived = 0;
  const all = gate();
  return {
    arrive: async (key) => {
      if (key !== RECORD) return;
      arrived += 1;
      if (arrived >= count) all.open();
      await all.promise;
    },
  };
}

/** A secret store the test saves to and removes from. */
function secretStore() {
  const values = new Set<string>();
  const watchers = new Set<() => void>();
  const reader: BureauPluginSecrets = {
    get: async (key) => (values.has(key) ? 'a-value' : undefined),
    watch: (_key, listener) => {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
  };
  return {
    reader,
    save: () => {
      values.add(SECRET_KEY);
      for (const listener of watchers) listener();
    },
    remove: () => {
      values.delete(SECRET_KEY);
      for (const listener of watchers) listener();
    },
  };
}

/**
 * A wrapper that gates the kind on secret `x-token`, as a plugin that declares it does, with the
 * process's own secret store to save it to and remove it from.
 */
async function secretGated(): Promise<{
  readonly wrap: (kind: PluginTrigger) => PluginTrigger;
  readonly save: () => void;
  readonly remove: () => void;
}> {
  const secrets = secretStore();
  const secretGate = await createPluginSecretGate('x', [SECRET_KEY], secrets.reader);
  cleanups.push(secretGate.watch());
  return {
    wrap: (trigger) =>
      gatedContributions(
        { triggers: [trigger] },
        secretGate,
        (name) => `x:${name}`,
        () => undefined,
      ).triggers[0]!,
    save: secrets.save,
    remove: secrets.remove,
  };
}

/**
 * I3 (COR-2166) on every peer of the row: the published `retryAt` is non-null exactly while a retry
 * timer is armed. The peers renew by hand, so a peer arms no other timer.
 */
function expectRetryAtToMatchTheTimers(p: Peer): void {
  let published = 0;
  for (const id of ['a', 'b']) {
    for (const kind of [KIND, 'Bad_Plugin:watch']) {
      if (p.supervisor.listener(id, kind)?.retryAt != null) published += 1;
    }
  }
  expect(published, `published retryAt values of ${p.name}`).toBe(
    p.services.pendingTimers().length,
  );
}

interface LeaseRow {
  /** `M<n>:` is the matrix row, by its order in the matrix table; `O<n>:` an "Open" item. */
  readonly row: string;
  readonly run: () => Promise<void>;
}

const rows: readonly LeaseRow[] = [
  {
    row: 'M1: two Bureaus boot with one file and both read the record absent: one listening, the other standby, which writes nothing and calls no start',
    run: async () => {
      const shared = sharedStore();
      const together = readTogether(2);
      const one = await peer(shared);
      const two = await peer(shared);
      one.faults = { get: together.arrive };
      two.faults = { get: together.arrive };
      await Promise.all([one.reconcile({ a: {} }), two.reconcile({ a: {} })]);
      const [holder, standby] = one.starts.length === 1 ? [one, two] : [two, one];
      expect(holder.starts).toHaveLength(1);
      expect(holder.status()).toEqual(status('listening', ORIGIN));
      expect(standby.starts).toHaveLength(0);
      expect(standby.status()).toEqual(status('standby', ORIGIN));
      expect(await shared.kv.get(RECORD)).toBe(holder.own);
    },
  },
  {
    row: 'M2: acquire finds a record naming another process whose lease is live: no write, no start, standby',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const other = await peer(shared);
      await holder.reconcile({ a: {} });
      await other.reconcile({ a: {} });
      expect(other.status()).toEqual(status('standby', ORIGIN));
      expect(other.starts).toHaveLength(0);
      expect(other.writes).toEqual([]);
      expect(await shared.kv.get(RECORD)).toBe(holder.own);
    },
  },
  {
    row: 'M3: acquire finds a record naming a process whose lease is absent or expired: CAS on the record and that lease, then start',
    run: async () => {
      const shared = sharedStore();
      const released = await peer(shared);
      await released.reconcile({ a: {} });
      // Its lease is removed, as at a shutdown that did not reach the trigger record.
      await released.processLease.release();
      const absentTaker = await peer(shared);
      await absentTaker.reconcile({ a: {} });
      expect(absentTaker.status()).toEqual(status('listening', ORIGIN));
      expect(await shared.kv.get(RECORD)).toBe(absentTaker.own);

      crash(absentTaker);
      const expiredTaker = await peer(shared);
      expiredTaker.passTime(PROCESS_LEASE_MILLISECONDS + 1_000);
      await expiredTaker.reconcile({ a: {} });
      expect(expiredTaker.status()?.state).toBe('listening');
      expect(expiredTaker.starts).toHaveLength(1);
      expect(await shared.kv.get(RECORD)).toBe(expiredTaker.own);
    },
  },
  {
    row: 'M4: an unreadable record (not JSON, or no string processId) is never written over or deleted: standby, diagnosed once with the workflow id, until the record changes',
    run: async () => {
      for (const value of ['not json', JSON.stringify({ processId: 7 })]) {
        const shared = sharedStore();
        await shared.kv.set(RECORD, value);
        const p = await peer(shared);
        await p.reconcile({ a: {} });
        await p.tick();
        expect(p.status()).toEqual(status('standby', ORIGIN));
        expect(p.starts).toHaveLength(0);
        expect(await shared.kv.get(RECORD)).toBe(value);
        const unreadable = p.diagnosed.filter((entry) => entry.message.includes('not readable'));
        expect(unreadable).toHaveLength(1);
        expect(unreadable[0]!.message).toContain('"a"');
        await shared.kv.delete(RECORD);
        await p.tick();
        expect(p.status()?.state).toBe('listening');
      }
    },
  },
  {
    row: 'M5: acquire finds the named process’s lease unreadable: no write, standby',
    run: async () => {
      const shared = sharedStore();
      await shared.kv.set(RECORD, JSON.stringify({ processId: 'ghost' }));
      await shared.kv.set(processLeaseKey('ghost'), 'garbage');
      const p = await peer(shared);
      p.passTime(PROCESS_LEASE_MILLISECONDS * 10);
      await p.reconcile({ a: {} });
      expect(p.status()?.state).toBe('standby');
      expect(p.writes).toEqual([]);
      expect(p.starts).toHaveLength(0);
    },
  },
  {
    row: 'M6: acquire finds the record naming this process: held, no write, start runs',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      await shared.kv.set(RECORD, p.own);
      await p.reconcile({ a: {} });
      expect(p.status()?.state).toBe('listening');
      // The acquire read the record, found its own value, and wrote nothing.
      expect(p.reads).toEqual([RECORD]);
      expect(p.writes).toEqual([]);
      expect(p.starts).toHaveLength(1);
    },
  },
  {
    row: 'M7 (O2): the store throws on an acquire’s read or CAS: standby, failed problem and timer cleared, no start, diagnosed with the cause; the next tick tries again',
    run: async () => {
      const failure = new Error('the store is down');
      for (const where of ['get', 'batch'] as const) {
        const shared = sharedStore();
        const p = await peer(shared);
        p.onStart = boom;
        await p.reconcile({ a: {} });
        expect(p.status()?.state).toBe('failed');
        p.onStart = () => undefined;
        p.faults =
          where === 'get'
            ? { get: (key) => (key === RECORD ? Promise.reject(failure) : undefined) }
            : { batch: () => Promise.reject(failure) };
        await p.advance(1_000);
        expect(p.status()).toEqual(status('standby', at(1)));
        expect(p.starts).toHaveLength(1);
        expect(p.calls).toEqual(['report x/a', 'clear x/a']);
        expect(p.services.pendingTimers()).toHaveLength(0);
        expect(p.diagnosed.some((entry) => entry.cause === failure)).toBe(true);
        p.faults = {};
        await p.tick();
        expect(p.status()?.state).toBe('listening');
        expect(p.starts).toHaveLength(2);
      }
    },
  },
  {
    row: 'M8: a paused file is stopped, and reads or writes no record',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      await p.reconcile({ a: { paused: true } });
      expect(p.status()).toEqual(status('stopped', ORIGIN));
      expect(p.reads).toEqual([]);
      expect(p.writes).toEqual([]);
    },
  },
  {
    row: 'M9 (O3): a refused configuration, or storage that cannot be made, is failed as on main and reads or writes no record',
    run: async () => {
      const shared = sharedStore();
      const refused = await peer(shared);
      await refused.reconcile({ a: { account: 5 } });
      expect(refused.status()).toEqual(status('failed', ORIGIN, 'configuration-refused'));
      expect(refused.reads).toEqual([]);
      const noStorage = await peer(shared, { plugin: 'Bad_Plugin' });
      await noStorage.reconcile({ a: {} });
      expect(noStorage.supervisor.listener('a', 'Bad_Plugin:watch')).toEqual(
        status('failed', ORIGIN, 'start-failed', null, at(1)),
      );
      expect(noStorage.reads).toEqual([]);
      expect(noStorage.writes).toEqual([]);
    },
  },
  {
    row: 'M10: a Bureau with memory storage has no trigger lease: every listener runs, no record, and the fence adds no await',
    run: async () => {
      const services = createManualRuntimeServices({ origin: ORIGIN });
      const shared = sharedStore();
      const memoryLease = openProcessLease({
        kv: shared.kv,
        persistence: 'memory',
        clock: services.clock,
        timers: services.timers,
        identifiers: services.identifiers,
        diagnose: () => undefined,
      });
      expect(
        createWorkflowTriggerLease({
          kv: shared.kv,
          processLease: memoryLease,
          now: () => services.clock.now(),
          diagnose: () => undefined,
        }),
      ).toBeUndefined();
      const contexts: PluginTriggerContext[] = [];
      const requests: TriggerFireRequest[] = [];
      const supervisors = [0, 1].map(() =>
        createWorkflowTriggerSupervisor({
          fire: async (request) => {
            requests.push(request);
            return { outcome: 'started', runId: 'r' };
          },
          diagnose: () => undefined,
          storage: shared.storage,
          nowISO: () => ORIGIN,
          timers: services.timers,
          exclusive: (work) => work(),
          reportFailure: () => undefined,
          clearFailure: () => undefined,
        }),
      );
      const entry: VersionedCatalogEntry<PluginTrigger> = {
        kind: 'trigger',
        name: KIND,
        version: '1',
        id: `${KIND}@1`,
        source: { name: 'x', version: '1' },
        value: {
          name: 'watch',
          description: 'Watches.',
          configuration: z.object({}),
          start: async (context) => {
            contexts.push(context);
            return () => undefined;
          },
        },
      };
      for (const supervisor of supervisors) {
        cleanups.push(() => supervisor.close());
        await supervisor.reconcile(
          new Map([['a', { kind: entry, trigger: { kind: KIND } }]]),
          new Set(),
        );
      }
      expect(contexts).toHaveLength(2);
      expect(await shared.kv.list('bureau-trigger:')).toEqual([]);
      // The host is called in the same turn as the fire: nothing is read first.
      void contexts[0]!.fire({});
      expect(requests).toHaveLength(1);
    },
  },
  {
    row: 'M11 (differs: main now has receive-only kinds, COR-2168): a receive-only kind is ready and writes no record',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared, { receiveOnly: true });
      await p.reconcile({ a: {} });
      expect(p.status()).toEqual(status('ready', ORIGIN));
      expect(p.reads).toEqual([]);
      expect(p.writes).toEqual([]);
    },
  },
  {
    row: 'M12: a built-in trigger’s fire and a manual start take no lease and no fence',
    run: async () => {
      // A supervisor given no contributed trigger reads and writes nothing, whatever ticks.
      const shared = sharedStore();
      const p = await peer(shared);
      await p.reconcile({});
      await p.tick();
      expect(p.reads).toEqual([]);
      expect(p.writes).toEqual([]);

      // Through a persistent Bureau: a signal-triggered file fires, and a manual-trigger file is
      // started, and neither touches a listener lease key.
      const touched: string[] = [];
      const storage = persistentMemory();
      const observed = new Proxy(storage, {
        get(target, property) {
          const member = Reflect.get(target, property, target) as unknown;
          if (typeof member !== 'function') return member;
          return (...args: unknown[]) => {
            const text = JSON.stringify(args, (_key, value: unknown) =>
              value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
            );
            if (text.includes('bureau-trigger:')) touched.push(String(property));
            return (member as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const harness = await startWorkflowBureau({
        overrides: { storage: observed, onDiagnostic: () => undefined },
      });
      cleanups.push(() => harness.dispose());
      const parked = { steps: [{ kind: 'await-signal', signal: 'never' }] };
      await harness.put(
        'signalled.json',
        workflowFileText('signalled', { trigger: { kind: 'signal', name: 'go' }, ...parked }),
      );
      await harness.put('manual.json', workflowFileText('manual', parked));
      await harness.bureau.workflows?.refresh();
      const signalled = await harness.bureau.workflows!.signal('go', {});
      expect(signalled.started).toHaveLength(1);
      await harness.bureau.workflows!.start('manual', { input: {}, owner: 'anonymous:local' });
      expect(touched).toEqual([]);
    },
  },
  {
    row: 'M13: a renewal write that succeeds, the timer’s or renew()’s, calls each onRenewed listener after the write',
    run: async () => {
      const services = createManualRuntimeServices({ origin: ORIGIN });
      const { kv } = sharedStore();
      const lease = openProcessLease({
        kv,
        persistence: 'local',
        clock: services.clock,
        timers: services.timers,
        identifiers: services.identifiers,
        diagnose: () => undefined,
      });
      const seen: Array<string | null> = [];
      lease.onRenewed(
        () => void kv.get(processLeaseKey(lease.processId!)).then((raw) => seen.push(raw)),
      );
      await lease.start('timer');
      await services.advance(PROCESS_LEASE_MILLISECONDS / 3);
      await lease.renew();
      await waitUntil(() => seen.length === 2, { message: 'two renewals to be seen' });
      expect(seen.every((raw) => raw !== null)).toBe(true);
      lease.halt();
    },
  },
  {
    row: 'M14: the first lease write in start() does not tick',
    run: async () => {
      const services = createManualRuntimeServices({ origin: ORIGIN });
      const lease = openProcessLease({
        kv: sharedStore().kv,
        persistence: 'local',
        clock: services.clock,
        timers: services.timers,
        identifiers: services.identifiers,
        diagnose: () => undefined,
      });
      let ticks = 0;
      lease.onRenewed(() => void (ticks += 1));
      await lease.start('manual');
      expect(ticks).toBe(0);
    },
  },
  {
    row: 'M15: a renewal write that fails does not tick, and the listener state is unchanged',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      await p.reconcile({ a: {} });
      p.faults = { set: () => Promise.reject(new Error('partitioned')) };
      expect(await rejectionOf(p.tick())).toBeInstanceOf(Error);
      await p.settled();
      expect(p.status()).toEqual(status('listening', ORIGIN));
      expect(p.reads).toEqual([RECORD]);
    },
  },
  {
    row: 'M16: no tick after halt() or after an unsubscribe; a throwing listener is diagnosed and renewal goes on; a closed supervisor’s queued pass does nothing',
    run: async () => {
      const services = createManualRuntimeServices({ origin: ORIGIN });
      const diagnosed: unknown[] = [];
      const lease = openProcessLease({
        kv: sharedStore().kv,
        persistence: 'local',
        clock: services.clock,
        timers: services.timers,
        identifiers: services.identifiers,
        diagnose: (_message, cause) => void diagnosed.push(cause),
      });
      await lease.start('manual');
      let ticks = 0;
      const thrown = new Error('the listener failed');
      lease.onRenewed(() => {
        throw thrown;
      });
      const unsubscribe = lease.onRenewed(() => void (ticks += 1));
      await lease.renew();
      expect(ticks).toBe(1);
      expect(diagnosed).toEqual([thrown]);
      unsubscribe();
      await lease.renew();
      expect(ticks).toBe(1);
      lease.onRenewed(() => void (ticks += 1));
      lease.halt();
      await lease.renew();
      expect(ticks).toBe(1);

      const shared = sharedStore();
      const p = await peer(shared);
      await p.reconcile({ a: {} });
      const reads = p.reads.length;
      await p.close();
      await p.tick();
      expect(p.reads).toHaveLength(reads);

      // A pass already queued, behind a start in flight, when close lands: it does nothing once
      // it runs, though the record names another process.
      const other = sharedStore();
      const queued = await peer(other);
      const taker = await peer(other);
      const starting = gate();
      queued.onStart = () => starting.promise;
      const reconciling = queued.reconcile({ a: {} });
      await waitUntil(() => queued.starts.length === 1, { message: 'the start to begin' });
      await takenBy(other.kv, taker);
      await queued.processLease.renew();
      const before = queued.reads.length;
      const closing = queued.close();
      starting.open();
      await reconciling;
      await closing;
      await queued.settled();
      expect(queued.reads).toHaveLength(before);
      expect(queued.status()?.state).not.toBe('standby');
    },
  },
  {
    row: 'M17: a manual-maintenance host ticks at each renew(), with no Bureau timer: see the Bureau rows',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      expect(standby.status()?.state).toBe('standby');
      crash(holder);
      standby.passTime(PROCESS_LEASE_MILLISECONDS + 1);
      expect(standby.services.pendingTimers()).toHaveLength(0);
      await standby.processLease.renew();
      await standby.settled();
      expect(standby.status()?.state).toBe('listening');
    },
  },
  {
    row: 'M18: tick pass, standby, record absent (the holder closed): CAS on absent, then start, listening within one tick',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      await holder.close();
      standby.passTime(3_000);
      await standby.tick();
      expect(standby.status()).toEqual(status('listening', at(3)));
      expect(await shared.kv.get(RECORD)).toBe(standby.own);
    },
  },
  {
    row: 'M19: tick pass, standby, holder’s lease expired or absent: CAS on the raw record and lease, then start',
    run: async () => {
      for (const how of ['expired', 'absent'] as const) {
        const shared = sharedStore();
        const holder = await peer(shared);
        const standby = await peer(shared);
        await holder.reconcile({ a: {} });
        await standby.reconcile({ a: {} });
        crash(holder);
        if (how === 'expired') standby.passTime(PROCESS_LEASE_MILLISECONDS + 1);
        else await shared.kv.delete(processLeaseKey(holder.processLease.processId!));
        await standby.tick();
        expect(standby.status()?.state).toBe('listening');
        expect(await shared.kv.get(RECORD)).toBe(standby.own);
      }
    },
  },
  {
    row: 'M20: tick pass, standby, holder live or the record or lease unreadable: no write, since kept',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      standby.passTime(5_000);
      await standby.tick();
      expect(standby.status()).toEqual(status('standby', ORIGIN));
      await shared.kv.set(processLeaseKey(holder.processLease.processId!), 'garbage');
      await standby.tick();
      await shared.kv.set(RECORD, 'garbage');
      await standby.tick();
      expect(standby.status()).toEqual(status('standby', ORIGIN));
      expect(standby.writes).toEqual([]);
      expect(standby.starts).toHaveLength(0);
    },
  },
  {
    row: 'M21: tick pass, standby whose record names this process (a CAS that threw had committed): held, no write, start runs',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      expect(standby.status()?.state).toBe('standby');
      await takenBy(shared.kv, standby);
      await standby.tick();
      expect(standby.status()?.state).toBe('listening');
      expect(standby.starts).toHaveLength(1);
      expect(standby.writes).toEqual([]);
    },
  },
  {
    row: 'M22: two standbys tick at once after the holder is gone: one CAS commits, the rest stay standby and start nothing',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const two = await peer(shared);
      const three = await peer(shared);
      await holder.reconcile({ a: {} });
      await two.reconcile({ a: {} });
      await three.reconcile({ a: {} });
      crash(holder);
      await shared.kv.delete(processLeaseKey(holder.processLease.processId!));
      const together = readTogether(2);
      two.faults = { get: together.arrive };
      three.faults = { get: together.arrive };
      await Promise.all([two.tick(), three.tick()]);
      const listening = [two, three].filter((p) => p.status()?.state === 'listening');
      expect(listening).toHaveLength(1);
      expect(two.starts.length + three.starts.length).toBe(1);
      expect(await shared.kv.get(RECORD)).toBe(listening[0]!.own);
    },
  },
  {
    row: 'M23 (O1): a takeover CAS that loses (the holder renewed between the read and the write) starts nothing and is tried again at the next tick',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      standby.passTime(PROCESS_LEASE_MILLISECONDS + 1);
      // The holder renews, with its own clock a little later, after the standby read its lease.
      standby.faults = {
        batch: async (conditions) => {
          if (conditions.length !== 2) return;
          standby.faults = {};
          holder.passTime(1_000);
          await holder.processLease.renew();
        },
      };
      await standby.tick();
      expect(standby.status()?.state).toBe('standby');
      expect(standby.starts).toHaveLength(0);
      expect(await shared.kv.get(RECORD)).toBe(holder.own);
      crash(holder);
      standby.passTime(PROCESS_LEASE_MILLISECONDS);
      await standby.tick();
      expect(standby.status()?.state).toBe('listening');
    },
  },
  {
    row: 'M24: tick pass, a holder whose record names it: nothing written, nothing changed',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      await p.reconcile({ a: {} });
      const writes = p.writes.length;
      const reads = p.reads.length;
      p.passTime(5_000);
      await p.tick();
      expect(p.status()).toEqual(status('listening', ORIGIN));
      // The pass read the record once, found it names this process, and wrote nothing.
      expect(p.reads.length - reads).toBe(1);
      expect(p.writes).toHaveLength(writes);
      expect(p.stops).toEqual([]);
    },
  },
  {
    row: 'M25: tick pass, a holder whose record names another: standby, controller aborted, its stop awaited inside the pass, no record written',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const taker = await peer(shared);
      await holder.reconcile({ a: {} });
      await takenBy(shared.kv, taker);
      const stopping = gate();
      holder.onStop = () => stopping.promise;
      let ticked = false;
      const ticking = holder.tick().then(() => void (ticked = true));
      await waitUntil(() => holder.stops.length === 1, { message: 'the stop to begin' });
      expect(ticked).toBe(false);
      stopping.open();
      await ticking;
      expect(holder.status()).toEqual(status('standby', ORIGIN));
      expect(holder.starts[0]!.signal.aborted).toBe(true);
      expect(await shared.kv.get(RECORD)).toBe(taker.own);
      expect(holder.writes.filter((key) => key === RECORD)).toHaveLength(1);
    },
  },
  {
    row: 'M26: tick pass, a holder whose record is absent or unreadable: standby and stopped; a later tick acquires an absent record again',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      await p.reconcile({ a: {} });
      await shared.kv.delete(RECORD);
      await p.tick();
      expect(p.status()?.state).toBe('standby');
      expect(p.stops).toEqual([`stop:${p.name}`]);
      await p.tick();
      expect(p.status()?.state).toBe('listening');
      expect(p.starts).toHaveLength(2);
      await shared.kv.set(RECORD, 'garbage');
      await p.tick();
      expect(p.status()?.state).toBe('standby');
      expect(await shared.kv.get(RECORD)).toBe('garbage');
    },
  },
  {
    row: 'M27 (O2): the store throws in a tick pass’s read: the state is unchanged and the failure diagnosed',
    run: async () => {
      const failure = new Error('the store is down');
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      for (const p of [holder, standby]) {
        p.faults = { get: (key) => (key === RECORD ? Promise.reject(failure) : undefined) };
        p.passTime(2_000);
        await p.tick();
        expect(p.diagnosed.some((entry) => entry.cause === failure)).toBe(true);
        p.faults = {};
      }
      expect(holder.status()).toEqual(status('listening', ORIGIN));
      expect(holder.stops).toEqual([]);
      expect(standby.status()).toEqual(status('standby', ORIGIN));
    },
  },
  {
    row: 'M28: tick pass, a failed listener with its timer armed (its record deleted): nothing happens, the timer and retryAt stay',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      p.onStart = boom;
      await p.reconcile({ a: {} });
      // The attempt took the record, and its failed start deleted it.
      expect(p.reads).toEqual([RECORD]);
      expect(await shared.kv.get(RECORD)).toBeNull();
      await p.tick();
      expect(p.reads).toEqual([RECORD]);
      expect(p.status()).toEqual(status('failed', ORIGIN, 'start-failed', null, at(1)));
      expect(p.services.pendingTimers()).toHaveLength(1);
      expect(p.starts).toHaveLength(1);
    },
  },
  {
    row: 'M29 (O4): a tick pass queued behind an attempt in flight runs after it settles, so listening is published before standby; three ticks queue one pass',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const taker = await peer(shared);
      const starting = gate();
      holder.onStart = () => starting.promise;
      const reconciling = holder.reconcile({ a: {} });
      await waitUntil(() => holder.starts.length === 1, { message: 'the start to begin' });
      await takenBy(shared.kv, taker);
      const readsBefore = holder.reads.length;
      await holder.processLease.renew();
      await holder.processLease.renew();
      await holder.processLease.renew();
      expect(holder.status()).toBeUndefined();
      starting.open();
      await reconciling;
      // The attempt settled first: it read the record before `start` and holds it in its own view.
      expect(holder.status()?.state).toBe('listening');
      await holder.settled();
      expect(holder.status()?.state).toBe('standby');
      expect(holder.reads.length - readsBefore).toBe(1);
    },
  },
  {
    row: 'M30: a fire while the lease is lost and start is in flight: skipped stopped, standby, start’s listener stopped when it settles, a retry awaiting it answers standby',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const taker = await peer(shared);
      const starting = gate();
      holder.onStart = () => starting.promise;
      const reconciling = holder.reconcile({ a: {} });
      await waitUntil(() => holder.starts.length === 1, { message: 'the start to begin' });
      await takenBy(shared.kv, taker);
      expect(await holder.starts[0]!.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
      expect(holder.status()).toEqual(status('standby', ORIGIN));
      const retrying = holder.retry();
      starting.open();
      await reconciling;
      expect(await retrying).toEqual(status('standby', ORIGIN));
      expect(holder.stops).toEqual([`stop:${holder.name}`]);
      expect(holder.requests).toEqual([]);
      expect(await shared.kv.get(RECORD)).toBe(taker.own);
    },
  },
  {
    row: 'M31: a fire from a holder that lost the lease: skipped stopped, no run, controller aborted, standby; its stop runs in the background and close awaits it',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const taker = await peer(shared);
      await holder.reconcile({ a: {} });
      await takenBy(shared.kv, taker);
      const stopping = gate();
      holder.onStop = () => stopping.promise;
      expect(await holder.starts[0]!.fire({}, { idempotencyKey: 'k' })).toEqual({
        outcome: 'skipped',
        reason: 'stopped',
      });
      expect(holder.requests).toEqual([]);
      expect(holder.starts[0]!.signal.aborted).toBe(true);
      expect(holder.status()).toEqual(status('standby', ORIGIN));
      expect(holder.stops).toEqual([`stop:${holder.name}`]);
      let closed = false;
      const closing = holder.close().then(() => void (closed = true));
      await holder.settled();
      expect(closed).toBe(false);
      stopping.open();
      await closing;
      expect(await shared.kv.get(RECORD)).toBe(taker.own);
    },
  },
  {
    row: 'M32: several fires fenced at once: standby recorded once and the listener stopped once; a later fire answers without a read',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const taker = await peer(shared);
      await holder.reconcile({ a: {} });
      await takenBy(shared.kv, taker);
      const context = holder.starts[0]!;
      const outcomes = await Promise.all([context.fire({}), context.fire({}), context.fire({})]);
      const fenced: PluginTriggerOutcome = { outcome: 'skipped', reason: 'stopped' };
      expect(outcomes).toEqual([fenced, fenced, fenced]);
      expect(holder.stops).toHaveLength(1);
      const reads = holder.reads.length;
      expect(await context.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
      expect(holder.reads).toHaveLength(reads);
    },
  },
  {
    row: 'M33: a fence read that settles after a pause or a close replaced the entry writes nothing, and answers stopped, or closed',
    run: async () => {
      for (const then of ['pause', 'close'] as const) {
        const shared = sharedStore();
        const holder = await peer(shared);
        const taker = await peer(shared);
        await holder.reconcile({ a: {} });
        await takenBy(shared.kv, taker);
        const reading = gate();
        holder.faults = { get: (key) => (key === RECORD ? reading.promise : undefined) };
        const firing = holder.starts[0]!.fire({});
        if (then === 'pause') await holder.reconcile({ a: { paused: true } });
        else await holder.close();
        reading.open();
        expect(await firing).toEqual({
          outcome: 'skipped',
          reason: then === 'pause' ? 'stopped' : 'closed',
        });
        if (then === 'pause') expect(holder.status()).toEqual(status('stopped', ORIGIN));
        expect(holder.stops).toHaveLength(1);
      }
    },
  },
  {
    row: 'M34: a pause or close that lands during the fence read of a holder: checked again after the read, and the host’s fire is not called',
    run: async () => {
      for (const then of ['pause', 'close'] as const) {
        const shared = sharedStore();
        const holder = await peer(shared);
        await holder.reconcile({ a: {} });
        const reading = gate();
        holder.faults = { get: (key) => (key === RECORD ? reading.promise : undefined) };
        const firing = holder.starts[0]!.fire({});
        if (then === 'pause') {
          // The pause's own record delete is not held.
          const pausing = holder.reconcile({ a: { paused: true } });
          await waitUntil(() => holder.status()?.state === 'stopped', { message: 'the pause' });
          reading.open();
          await pausing;
        } else {
          const closing = holder.close();
          reading.open();
          await closing;
        }
        expect(await firing).toEqual({
          outcome: 'skipped',
          reason: then === 'pause' ? 'stopped' : 'closed',
        });
        expect(holder.requests).toEqual([]);
      }
    },
  },
  {
    row: 'M35: the plugin mutates its payload and options after calling fire, during the fence read: the run gets them as passed',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      await holder.reconcile({ a: {} });
      const reading = gate();
      holder.faults = { get: (key) => (key === RECORD ? reading.promise : undefined) };
      const payload = { n: 1, nested: { list: [1] } };
      const options = { idempotencyKey: 'first' };
      const firing = holder.starts[0]!.fire(payload, options);
      payload.n = 2;
      payload.nested.list.push(2);
      options.idempotencyKey = 'second';
      reading.open();
      expect(await firing).toMatchObject({ outcome: 'started' });
      expect(holder.requests[0]!.payload).toEqual({ n: 1, nested: { list: [1] } });
      expect(holder.requests[0]!.idempotencyKey).toBe('first');
    },
  },
  {
    row: 'M35a (added in review): a payload that is not JSON when fire is called stays not JSON, though the plugin makes it JSON during the fence read',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      await holder.reconcile({ a: {} });
      const reading = gate();
      holder.faults = { get: (key) => (key === RECORD ? reading.promise : undefined) };
      const payload: Record<string, unknown> = { n: 1, callback: () => undefined };
      const firing = holder.starts[0]!.fire(payload);
      // The plugin turns its payload into JSON while the fence awaits.
      delete payload['callback'];
      reading.open();
      await firing;
      expect(holder.requests).toHaveLength(1);
      // The host is handed a payload it still refuses as not JSON, as it would have been at the call.
      expect(z.json().safeParse(holder.requests[0]!.payload).success).toBe(false);
    },
  },
  {
    row: 'M36 (O5): a fence read that throws rejects the fire with the read’s error, starts nothing, leaves the key free and the state unchanged',
    run: async () => {
      const failure = new Error('the store is down');
      const shared = sharedStore();
      const holder = await peer(shared);
      await holder.reconcile({ a: {} });
      holder.faults = { get: (key) => (key === RECORD ? Promise.reject(failure) : undefined) };
      expect(await rejectionOf(holder.starts[0]!.fire({}, { idempotencyKey: 'k' }))).toBe(failure);
      expect(holder.requests).toEqual([]);
      expect(holder.status()).toEqual(status('listening', ORIGIN));
      holder.faults = {};
      expect(await holder.starts[0]!.fire({}, { idempotencyKey: 'k' })).toMatchObject({
        outcome: 'started',
      });
    },
  },
  {
    row: 'M37: a fire whose fence passes reads the record once, then runs as on main',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      await holder.reconcile({ a: {} });
      const reads = holder.reads.length;
      expect(await holder.starts[0]!.fire({ n: 1 })).toEqual({
        outcome: 'started',
        runId: `${holder.name}-run-1`,
      });
      expect(holder.reads.length - reads).toBe(1);
      expect(holder.requests).toEqual([
        { workflowId: 'a', kind: KIND, version: '1', payload: { n: 1 } },
      ]);
      expect(holder.status()?.lastFiredAt).toBe(ORIGIN);
    },
  },
  {
    row: 'M38: a failed listener’s timer attempt whose peer took the lease: standby with no retryAt and no timer, the trigger-failed problem cleared',
    run: async () => {
      const shared = sharedStore();
      const failing = await peer(shared);
      const other = await peer(shared);
      failing.onStart = boom;
      await failing.reconcile({ a: {} });
      await other.reconcile({ a: {} });
      expect(other.status()?.state).toBe('listening');
      failing.onStart = () => undefined;
      await failing.advance(1_000);
      expect(failing.status()).toEqual(status('standby', at(1)));
      expect(failing.calls).toEqual(['report x/a', 'clear x/a']);
      expect(failing.services.pendingTimers()).toHaveLength(0);
      expect(failing.starts).toHaveLength(1);
    },
  },
  {
    row: 'M39 (AC4): Retry now on a failed non-holder whose peer holds the lease answers standby and starts nothing',
    run: async () => {
      const shared = sharedStore();
      const failing = await peer(shared);
      const other = await peer(shared);
      failing.onStart = boom;
      await failing.reconcile({ a: {} });
      await other.reconcile({ a: {} });
      failing.onStart = () => undefined;
      expect(await failing.retry()).toEqual(status('standby', ORIGIN));
      expect(failing.starts).toHaveLength(1);
      expect(await shared.kv.get(RECORD)).toBe(other.own);
    },
  },
  {
    row: 'M40: Retry now on a standby listener: no lease write, no start, standby',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      const reads = standby.reads.length;
      expect(await standby.retry()).toEqual(status('standby', ORIGIN));
      expect(standby.reads).toHaveLength(reads);
      expect(standby.writes).toEqual([]);
      expect(standby.starts).toHaveLength(0);
    },
  },
  {
    row: 'M41: Retry now on a holder is left as it is, with no lease write',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      await p.reconcile({ a: {} });
      expect(await shared.kv.get(RECORD)).toBe(p.own);
      const writes = p.writes.length;
      const reads = p.reads.length;
      expect(await p.retry()).toEqual(status('listening', ORIGIN));
      expect(p.writes).toHaveLength(writes);
      expect(p.reads).toHaveLength(reads);
      expect(p.starts).toHaveLength(1);
    },
  },
  {
    row: 'M42: a crashed holder’s lease expires 30 s after its last write by the peer’s clock, and the peer takes over at its next tick',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      crash(holder);
      standby.passTime(PROCESS_LEASE_MILLISECONDS - 1);
      await standby.tick();
      expect(standby.status()?.state).toBe('standby');
      standby.passTime(1);
      await standby.tick();
      expect(standby.status()?.state).toBe('listening');
    },
  },
  {
    row: 'M43: a holder that closes deletes its record before close resolves; the peer acquires at its next tick',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      expect(await shared.kv.get(RECORD)).toBe(holder.own);
      expect(standby.status()?.state).toBe('standby');
      await holder.close();
      expect(await shared.kv.get(RECORD)).toBeNull();
      await standby.tick();
      expect(standby.status()?.state).toBe('listening');
      expect(standby.starts).toHaveLength(1);
    },
  },
  {
    row: 'M44: a partitioned holder: no tick and fires rejected while its store fails; the peer takes over on expiry; the first renewal after the heal stops it',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      const down = new Error('partitioned');
      holder.faults = {
        get: () => Promise.reject(down),
        set: () => Promise.reject(down),
        batch: () => Promise.reject(down),
      };
      expect(await rejectionOf(holder.tick())).toBe(down);
      expect(await rejectionOf(holder.starts[0]!.fire({}))).toBe(down);
      standby.passTime(PROCESS_LEASE_MILLISECONDS + 1);
      await standby.tick();
      expect(standby.status()?.state).toBe('listening');
      expect(holder.status()?.state).toBe('listening');
      holder.faults = {};
      await holder.tick();
      expect(holder.status()?.state).toBe('standby');
      expect(holder.stops).toEqual([`stop:${holder.name}`]);
      expect(await shared.kv.get(RECORD)).toBe(standby.own);
    },
  },
  {
    row: 'M45: a holder that stalls past its lease and resumes goes standby at its next tick, and its fires are fenced meanwhile',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      standby.passTime(PROCESS_LEASE_MILLISECONDS + 1);
      await standby.tick();
      expect(holder.status()?.state).toBe('listening');
      // The stalled holder's renewal restores its lease, and ticks.
      holder.passTime(PROCESS_LEASE_MILLISECONDS + 1);
      await holder.tick();
      expect(holder.status()?.state).toBe('standby');
      expect(holder.stops).toHaveLength(1);
      expect(await holder.starts[0]!.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
      expect(await shared.kv.get(RECORD)).toBe(standby.own);
    },
  },
  {
    row: 'M46: a holder’s listener that stops (pause, removal, failed start, failed gate report) deletes the record by CAS on its own value; another holder’s record stays; a failed delete is diagnosed',
    run: async () => {
      const cases: Array<(p: Peer) => Promise<void>> = [
        (p) => p.reconcile({ a: { paused: true } }),
        (p) => p.reconcile({}),
        async (p) => {
          reportListener(p.starts[0]!, { state: 'failed', error: new Error('gone') });
          await p.settled();
          await waitUntil(() => p.status()?.state === 'failed', { message: 'the report' });
        },
      ];
      for (const stop of cases) {
        const shared = sharedStore();
        const p = await peer(shared);
        await p.reconcile({ a: {} });
        await stop(p);
        await waitUntil(async () => (await shared.kv.get(RECORD)) === null, {
          message: 'the record to be deleted',
        });
      }
      const failedStart = sharedStore();
      const starter = await peer(failedStart);
      starter.onStart = boom;
      await starter.reconcile({ a: {} });
      expect(await failedStart.kv.get(RECORD)).toBeNull();

      const another = sharedStore();
      const holder = await peer(another);
      const taker = await peer(another);
      await holder.reconcile({ a: {} });
      await takenBy(another.kv, taker);
      await holder.reconcile({ a: { paused: true } });
      expect(await another.kv.get(RECORD)).toBe(taker.own);

      const failing = sharedStore();
      const p = await peer(failing);
      await p.reconcile({ a: {} });
      const failure = new Error('the delete failed');
      p.faults = {
        batch: (_conditions, operations) =>
          operations.some((operation) => operation.type === 'delete')
            ? Promise.reject(failure)
            : undefined,
      };
      await p.reconcile({ a: { paused: true } });
      expect(p.diagnosed.some((entry) => entry.cause === failure)).toBe(true);
      expect(await failing.kv.get(RECORD)).toBe(p.own);
      expect(p.status()?.state).toBe('stopped');
    },
  },
  {
    row: 'M47: the delete on close is not gated on the entry being current, and close awaits it',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      await p.reconcile({ a: {} });
      const deleting = gate();
      p.faults = { batch: () => deleting.promise };
      let closed = false;
      const closing = p.close().then(() => void (closed = true));
      await waitUntil(() => p.stops.length === 1, { message: 'the stop' });
      await p.settled();
      expect(closed).toBe(false);
      deleting.open();
      await closing;
      expect(await shared.kv.get(RECORD)).toBeNull();
    },
  },
  {
    row: 'M48: a close between acquire and start: start is not called, the record is deleted by CAS on its own value, and no status is written',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      const acquiring = gate();
      let held = false;
      p.faults = {
        afterBatch: async () => {
          if (held) return;
          held = true;
          await acquiring.promise;
        },
      };
      const reconciling = p.reconcile({ a: {} });
      await waitUntil(() => held, { message: 'the acquire' });
      const closing = p.close();
      acquiring.open();
      await reconciling;
      await closing;
      expect(p.starts).toHaveLength(0);
      expect(p.status()).toBeUndefined();
      expect(await shared.kv.get(RECORD)).toBeNull();
    },
  },
  {
    row: 'M48a (added in review): a close that lands while start is pending keeps the record until that start has settled and its listener has stopped, so no standby acquires before then, and close waits for it',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      const starting = gate();
      holder.onStart = () => starting.promise;
      const reconciling = holder.reconcile({ a: {} });
      await waitUntil(() => holder.starts.length === 1, { message: 'the start to begin' });
      await standby.reconcile({ a: {} });
      expect(standby.status()?.state).toBe('standby');

      let closed = false;
      const closing = holder.close().then(() => void (closed = true));
      await standby.tick();
      // The record still names the holder: its listener may yet come up.
      expect(await shared.kv.get(RECORD)).toBe(holder.own);
      expect(standby.status()?.state).toBe('standby');
      expect(standby.starts).toHaveLength(0);
      expect(closed).toBe(false);

      // The start settles; its listener is stopped, and only then is the record deleted.
      const stopping = gate();
      holder.onStop = () => stopping.promise;
      starting.open();
      // The attempt stops the listener its start resolved with; the reconcile waits for that.
      await waitUntil(() => holder.stops.length === 1, { message: 'the late listener to stop' });
      expect(await shared.kv.get(RECORD)).toBe(holder.own);
      expect(closed).toBe(false);
      stopping.open();
      await reconciling;
      await closing;
      expect(await shared.kv.get(RECORD)).toBeNull();
      await standby.tick();
      expect(standby.status()?.state).toBe('listening');
    },
  },
  {
    row: 'M49:a retired attempt’s delete and the next attempt’s acquire in one process are chained, so the next attempt never runs on a record its predecessor then deletes',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      await p.reconcile({ a: {} });
      const stopping = gate();
      p.onStop = () => stopping.promise;
      reportListener(p.starts[0]!, { state: 'failed', error: new Error('gone') });
      await waitUntil(() => p.status()?.state === 'failed', { message: 'the failure' });
      const retrying = p.retry();
      // The next attempt waits for the delete, which waits for the stop.
      await waitUntil(() => p.services.pendingTimers().length === 0, {
        message: 'the retry to take over from the timer',
      });
      expect(p.starts).toHaveLength(1);
      stopping.open();
      expect(await retrying).toMatchObject({ state: 'listening' });
      await p.settled();
      expect(p.starts).toHaveLength(2);
      expect(await shared.kv.get(RECORD)).toBe(p.own);
    },
  },
  {
    row: 'M50: a holder’s start fails with no peer: record deleted, backoff 1 s as on main, the timer attempt acquires an absent record',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      p.onStart = boom;
      await p.reconcile({ a: {} });
      expect(p.status()).toEqual(status('failed', ORIGIN, 'start-failed', null, at(1)));
      expect(await shared.kv.get(RECORD)).toBeNull();
      p.onStart = () => undefined;
      await p.advance(1_000);
      expect(p.status()).toEqual(status('listening', at(1)));
      expect(await shared.kv.get(RECORD)).toBe(p.own);
    },
  },
  {
    row: 'M51 (AC4): a holder’s start fails and its standby peer ticks first: the peer listens, and the failed process’s timer attempt goes standby',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      // The holder's own start fails after it settled (as a gated plugin's does): it is failed and
      // gives its record back.
      reportListener(holder.starts[0]!, { state: 'failed', error: new Error('gone') });
      await waitUntil(async () => (await shared.kv.get(RECORD)) === null, {
        message: 'the failed holder to give its record back',
      });
      expect(holder.status()?.state).toBe('failed');
      expect(standby.status()?.state).toBe('standby');
      // The peer's next tick takes it.
      await standby.tick();
      expect(standby.status()?.state).toBe('listening');
      expect(standby.starts).toHaveLength(1);
      // The failed process's timer attempt then finds a live holder.
      await holder.advance(1_000);
      expect(holder.status()?.state).toBe('standby');
      expect(holder.starts).toHaveLength(1);
      expect(await shared.kv.get(RECORD)).toBe(standby.own);
    },
  },
  {
    row: 'M52: an edit on the holder stops, deletes, acquires and starts, since kept; a peer that acquires between the delete and the acquire leaves it standby',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      holder.passTime(5_000);
      await holder.reconcile({ a: { account: 'two' } });
      expect(holder.status()).toEqual(status('listening', ORIGIN));
      expect(holder.starts).toHaveLength(2);
      expect(holder.stops).toHaveLength(1);
      expect(await shared.kv.get(RECORD)).toBe(holder.own);

      holder.faults = {
        afterBatch: async (operations) => {
          if (!operations.some((operation) => operation.type === 'delete')) return;
          holder.faults = {};
          await standby.tick();
        },
      };
      await holder.reconcile({ a: { account: 'three' } });
      expect(standby.status()?.state).toBe('listening');
      expect(holder.status()?.state).toBe('standby');
      expect(await shared.kv.get(RECORD)).toBe(standby.own);
    },
  },
  {
    row: 'M53: an edit on the standby: a new attempt finds the holder, standby, since kept',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      standby.passTime(5_000);
      await standby.reconcile({ a: { account: 'two' } });
      expect(standby.status()).toEqual(status('standby', ORIGIN));
      expect(standby.writes).toEqual([]);
    },
  },
  {
    row: 'M54: a pause on the holder stops it and deletes the record; the peer, seeing the same pause, is stopped and acquires nothing',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      expect(await shared.kv.get(RECORD)).toBe(holder.own);
      await holder.reconcile({ a: { paused: true } });
      await standby.reconcile({ a: { paused: true } });
      await standby.tick();
      expect(holder.status()?.state).toBe('stopped');
      expect(standby.status()?.state).toBe('stopped');
      expect(await shared.kv.get(RECORD)).toBeNull();
      expect(standby.writes).toEqual([]);
    },
  },
  {
    row: 'M55: a pause or a removal on the standby writes no record',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      await standby.reconcile({ a: { paused: true } });
      expect(standby.status()?.state).toBe('stopped');
      await standby.reconcile({});
      expect(standby.status()).toBeUndefined();
      expect(standby.writes).toEqual([]);
      expect(await shared.kv.get(RECORD)).toBe(holder.own);
    },
  },
  {
    row: 'M56 (AC5): a removal on the holder deletes the record by CAS, and its status is dropped',
    run: async () => {
      const shared = sharedStore();
      const p = await peer(shared);
      await p.reconcile({ a: {} });
      expect(await shared.kv.get(RECORD)).toBe(p.own);
      await p.reconcile({});
      expect(p.status()).toBeUndefined();
      expect(await shared.kv.get(RECORD)).toBeNull();
    },
  },
  {
    row: 'M57: an unpause acquires, then starts or goes standby',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const other = await peer(shared);
      await holder.reconcile({ a: { paused: true } });
      await other.reconcile({ a: { paused: true } });
      await holder.reconcile({ a: {} });
      await other.reconcile({ a: {} });
      expect(holder.status()?.state).toBe('listening');
      expect(other.status()?.state).toBe('standby');
      expect(await shared.kv.get(RECORD)).toBe(holder.own);
    },
  },
  {
    row: 'M58: close on the standby writes no record, unsubscribes its tick, and awaits a fenced stop it holds',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      await standby.close();
      const reads = standby.reads.length;
      await standby.tick();
      expect(standby.reads).toHaveLength(reads);
      expect(standby.writes).toEqual([]);
      expect(await shared.kv.get(RECORD)).toBe(holder.own);

      // A standby that holds a fenced stop: its close waits for that stop, and writes no record.
      const other = sharedStore();
      const fenced = await peer(other);
      const taker = await peer(other);
      await fenced.reconcile({ a: {} });
      await takenBy(other.kv, taker);
      const stopping = gate();
      fenced.onStop = () => stopping.promise;
      await fenced.starts[0]!.fire({});
      expect(fenced.status()?.state).toBe('standby');
      const writes = fenced.writes.length;
      let closed = false;
      const closing = fenced.close().then(() => void (closed = true));
      await fenced.settled();
      expect(closed).toBe(false);
      stopping.open();
      await closing;
      expect(fenced.writes).toHaveLength(writes);
      expect(await other.kv.get(RECORD)).toBe(taker.own);
    },
  },
  {
    row: 'M59: a gated holder waiting for its secret keeps the record, peers stay standby, and a fenced gated fire reaches nothing',
    run: async () => {
      const shared = sharedStore();
      const holderSecrets = await secretGated();
      const holder = await peer(shared, { wrap: holderSecrets.wrap });
      const standbySecrets = await secretGated();
      const standby = await peer(shared, { wrap: standbySecrets.wrap });
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      expect(holder.status()?.state).toBe('waiting-for-secret');
      expect(standby.status()?.state).toBe('standby');
      await holder.tick();
      expect(holder.status()?.state).toBe('waiting-for-secret');
      expect(await shared.kv.get(RECORD)).toBe(holder.own);

      // The secret is saved: the plugin's own listener starts, and its fires reach the fence
      // through the host's fire.
      holderSecrets.save();
      await waitUntil(() => holder.status()?.state === 'listening', {
        message: 'the gated listener to start',
      });
      await takenBy(shared.kv, standby);
      expect(await holder.starts[0]!.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
      expect(holder.requests).toEqual([]);
      expect(holder.status()?.state).toBe('standby');
      // Once fenced, the gate reports nothing: removing the secret does not move the state.
      holderSecrets.remove();
      await quietFor(50);
      await holder.settled();
      expect(holder.status()?.state).toBe('standby');
    },
  },
  {
    row: 'M60 (O6): a standby that takes over and whose start fails waits 1 second: the takeover starts with no failures',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      await holder.close();
      standby.onStart = boom;
      await standby.tick();
      expect(standby.status()).toEqual(status('failed', ORIGIN, 'start-failed', null, at(1)));
      expect(await shared.kv.get(RECORD)).toBeNull();
    },
  },
  {
    row: 'M61: both Bureaus restart cleanly: one listening, one standby, backoff and lastFiredAt start over',
    run: async () => {
      const shared = sharedStore();
      const one = await peer(shared);
      const two = await peer(shared);
      await one.reconcile({ a: {} });
      await two.reconcile({ a: {} });
      await one.starts[0]!.fire({});
      // The holder's start then fails twice, so its next delay has grown to 4 seconds.
      one.onStart = boom;
      await one.reconcile({ a: { account: 'edited' } });
      await one.advance(1_000);
      expect(one.status()).toEqual(status('failed', at(0), 'start-failed', at(0), at(3)));
      await one.close();
      await two.close();
      expect(await shared.kv.get(RECORD)).toBeNull();
      const three = await peer(shared);
      const four = await peer(shared);
      await three.reconcile({ a: {} });
      await four.reconcile({ a: {} });
      expect(three.status()).toEqual(status('listening', ORIGIN));
      expect(four.status()).toEqual(status('standby', ORIGIN));
      // After the restart a failing start waits 1 second again: the backoff starts over.
      three.onStart = boom;
      await three.reconcile({ a: { account: 'edited' } });
      expect(three.status()).toEqual(status('failed', ORIGIN, 'start-failed', null, at(1)));
    },
  },
  {
    row: 'M62: both crash and restart within 30 s: every new process is standby, then one takes over once the dead holder’s lease lapses',
    run: async () => {
      const shared = sharedStore();
      const one = await peer(shared);
      const two = await peer(shared);
      await one.reconcile({ a: {} });
      await two.reconcile({ a: {} });
      crash(one);
      crash(two);
      const three = await peer(shared);
      const four = await peer(shared);
      await three.reconcile({ a: {} });
      await four.reconcile({ a: {} });
      expect([three.status()?.state, four.status()?.state]).toEqual(['standby', 'standby']);
      three.passTime(PROCESS_LEASE_MILLISECONDS);
      four.passTime(PROCESS_LEASE_MILLISECONDS);
      await three.tick();
      await four.tick();
      expect([three.status()?.state, four.status()?.state]).toEqual(['listening', 'standby']);
    },
  },
  {
    row: 'M63: a redelivery of a key on the new holder after a handover is answered duplicate with the first run (the shared engine tags)',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      // The engine both Bureaus share: one run per key.
      const runs = new Map<unknown, string>();
      const engine = async (request: TriggerFireRequest): Promise<PluginTriggerOutcome> => {
        const earlier = runs.get(request.idempotencyKey);
        if (earlier !== undefined) return { outcome: 'duplicate', runId: earlier };
        const runId = `run-${runs.size + 1}`;
        runs.set(request.idempotencyKey, runId);
        return { outcome: 'started', runId };
      };
      holder.answer = engine;
      standby.answer = engine;
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      expect(standby.status()?.state).toBe('standby');
      expect(standby.starts).toHaveLength(0);
      expect(await holder.starts[0]!.fire({}, { idempotencyKey: 'K' })).toEqual({
        outcome: 'started',
        runId: 'run-1',
      });
      await holder.close();
      await standby.tick();
      expect(await standby.starts[0]!.fire({}, { idempotencyKey: 'K' })).toEqual({
        outcome: 'duplicate',
        runId: 'run-1',
      });
    },
  },
  {
    row: 'M64 (O7): after a handover the old holder’s fire is fenced and the new holder’s fire starts (the sequential case only; the window is documented)',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      const standby = await peer(shared);
      await holder.reconcile({ a: {} });
      await standby.reconcile({ a: {} });
      crash(holder);
      standby.passTime(PROCESS_LEASE_MILLISECONDS + 1);
      await standby.tick();
      expect(await holder.starts[0]!.fire({}, { idempotencyKey: 'K' })).toEqual({
        outcome: 'skipped',
        reason: 'stopped',
      });
      expect(await standby.starts[0]!.fire({}, { idempotencyKey: 'K' })).toMatchObject({
        outcome: 'started',
      });
      expect(holder.requests).toEqual([]);
    },
  },
  {
    row: 'M65: standby is on the wire, with code null and retryAt null',
    run: async () => {
      const parsed = workflowsTriggersRetryOperation.outputSchema.safeParse({
        id: 'a',
        listener: status('standby', ORIGIN),
      });
      expect(parsed.success).toBe(true);
    },
  },
  {
    row: 'M66: a lease failure reaches diagnose with its cause only; the listener state carries no error text',
    run: async () => {
      const failure = new Error('secret-bearing failure sk-live-0123456789');
      const shared = sharedStore();
      const p = await peer(shared);
      p.faults = { get: (key) => (key === RECORD ? Promise.reject(failure) : undefined) };
      await p.reconcile({ a: {} });
      expect(p.status()).toEqual(status('standby', ORIGIN));
      expect(JSON.stringify(p.status())).not.toContain('sk-live');
      const entry = p.diagnosed.find((diagnosed) => diagnosed.cause === failure);
      expect(entry?.message).not.toContain('sk-live');
    },
  },
  {
    row: 'O8: the record of a file deleted while its holder was down stays; a file re-created with that id is started once the named process’s lease is gone',
    run: async () => {
      const shared = sharedStore();
      const holder = await peer(shared);
      await holder.reconcile({ a: {} });
      crash(holder);
      const next = await peer(shared);
      await next.reconcile({});
      expect(await shared.kv.get(RECORD)).toBe(holder.own);
      next.passTime(PROCESS_LEASE_MILLISECONDS + 1);
      await next.reconcile({ a: {} });
      expect(next.status()?.state).toBe('listening');
    },
  },
];

describe('the listener lease and fenced fires (COR-2167 outcome matrix)', () => {
  afterEach(() => {
    for (const p of peersOfTheRow.splice(0)) expectRetryAtToMatchTheTimers(p);
  });
  for (const { row, run } of rows) {
    it(row, async () => {
      await run();
    });
  }
});

describe('the trigger events of a takeover (COR-2250)', () => {
  afterEach(() => void peersOfTheRow.splice(0));

  it('publishes trigger.stopped on the old holder and trigger.started on the new one', async () => {
    const shared = sharedStore();
    const holder = await peer(shared);
    const standby = await peer(shared);
    await holder.reconcile({ a: {} });
    await standby.reconcile({ a: {} });
    const base = { workflowId: 'a', trigger: KIND, version: '1' };
    expect(holder.published).toEqual([{ kind: 'trigger.started', ...base }]);
    // Going standby at boot is not a stop: the standby never ran the listener.
    expect(standby.published).toEqual([]);
    // The holder stalls: by the standby's clock its lease has lapsed.
    standby.passTime(PROCESS_LEASE_MILLISECONDS + 1);
    await standby.tick();
    expect(standby.published).toEqual([{ kind: 'trigger.started', ...base }]);
    // The stalled holder resumes, finds the record names the taker, and stops.
    holder.passTime(PROCESS_LEASE_MILLISECONDS + 1);
    await holder.tick();
    expect(holder.published).toEqual([
      { kind: 'trigger.started', ...base },
      { kind: 'trigger.stopped', ...base },
    ]);
  });

  it('publishes a fenced fire as skipped on the old holder', async () => {
    const shared = sharedStore();
    const holder = await peer(shared);
    const taker = await peer(shared);
    await holder.reconcile({ a: {} });
    await takenBy(shared.kv, taker);
    await holder.starts[0]!.fire({}, { idempotencyKey: 'k' });
    expect(holder.published.slice(1)).toEqual([
      { kind: 'trigger.stopped', workflowId: 'a', trigger: KIND, version: '1' },
      { kind: 'trigger.fired', workflowId: 'a', trigger: KIND, version: '1', outcome: 'skipped' },
    ]);
  });
});

/** A memory store that says it outlives its process, so a Bureau over it holds a process lease. */
function persistentMemory(): Storage {
  const base = new MemoryStorage();
  return new Proxy(base, {
    get(target, property) {
      if (property === 'capabilities') {
        return () => ({ ...target.capabilities(), persistence: 'local' });
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === 'function'
        ? (member as (...args: unknown[]) => unknown).bind(target)
        : member;
    },
  });
}

describe('the listener lease, through a Bureau (wiring)', () => {
  it('a Bureau over memory storage runs the listener and writes no record (AC5)', async () => {
    const plugin = watchPlugin();
    const storage = new MemoryStorage();
    const harness = await startWorkflowBureau({
      overrides: { plugins: [plugin.entry], storage, onDiagnostic: () => undefined },
    });
    cleanups.push(() => harness.dispose());
    const started: unknown[] = [];
    harness.bureau.addEventListener('trigger.started', (event) =>
      started.push(projectBureauEvent(event)),
    );
    await harness.put('a.json', workflowFileText('a', { trigger: { kind: KIND } }));
    await harness.bureau.workflows?.refresh();
    expect(await harness.bureau.workflows?.get('a')).toMatchObject({
      listener: { state: 'listening' },
    });
    // COR-2250: the Bureau publishes what the listener did.
    expect(started).toEqual([
      {
        kind: 'trigger.started',
        payload: { workflowId: 'a', trigger: KIND, version: '1.0.0' },
      },
    ]);
    expect(
      await textValueStore(storage, { disposeUnderlyingStorage: false }).list('bureau-trigger:'),
    ).toEqual([]);
  });

  it('a persistent Bureau takes the record, ticks at maintain(), takes over a lapsed holder, starts a manual run with no lease, and deletes the record before it releases its process lease', async () => {
    const plugin = watchPlugin();
    const storage = persistentMemory();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    // A peer that holds the record, and whose lease is live for now.
    await kv.set(RECORD, JSON.stringify({ processId: 'ghost' }));
    await kv.set(
      processLeaseKey('ghost'),
      JSON.stringify({ expiresAt: Date.parse(ORIGIN) + PROCESS_LEASE_MILLISECONDS }),
    );
    const order: string[] = [];
    const observed = new Proxy(storage, {
      get(target, property) {
        const member = Reflect.get(target, property, target) as unknown;
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => {
          const text = JSON.stringify(args, (_key, value: unknown) =>
            value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
          );
          if (
            (property === 'delete' || property === 'batch' || property === 'conditionalBatch') &&
            text.includes('bureau-')
          )
            order.push(`${property} ${text.includes('bureau-trigger:') ? 'trigger' : 'process'}`);
          return (member as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const harness = await startWorkflowBureau({
      overrides: {
        plugins: [plugin.entry],
        storage: observed,
        runtime,
        maintenance: 'manual',
        onDiagnostic: () => undefined,
      },
    });
    let disposed = false;
    cleanups.push(async () => {
      if (!disposed) await harness.dispose();
    });
    await harness.put('a.json', workflowFileText('a', { trigger: { kind: KIND } }));
    await harness.put('m.json', workflowFileText('m'));
    await harness.bureau.workflows?.refresh();
    expect(await harness.bureau.workflows?.get('a')).toMatchObject({
      listener: { state: 'standby' },
    });
    expect(plugin.contexts).toHaveLength(0);
    runtime.setTime(Date.parse(ORIGIN) + PROCESS_LEASE_MILLISECONDS + 1);
    await harness.bureau.maintain?.();
    await waitUntil(
      async () => {
        const detail = await harness.bureau.workflows?.get('a');
        return detail?.listener?.state === 'listening';
      },
      { message: 'the takeover at maintain()' },
    );
    expect(plugin.contexts).toHaveLength(1);
    const own = await kv.get(RECORD);
    expect(own).not.toContain('ghost');
    // A manual start takes no lease.
    const keys = await kv.list('bureau-trigger:');
    await harness.bureau.workflows?.start('m', { input: {}, owner: 'anonymous:local' });
    expect(await kv.list('bureau-trigger:')).toEqual(keys);
    order.length = 0;
    disposed = true;
    await harness.dispose();
    expect(await kv.get(RECORD)).toBeNull();
    const trigger = order.findIndex((entry) => entry.endsWith('trigger'));
    const processDelete = order.findIndex((entry) => entry.endsWith('process'));
    expect(trigger).toBeGreaterThanOrEqual(0);
    expect(processDelete).toBeGreaterThan(trigger);
  });
});
