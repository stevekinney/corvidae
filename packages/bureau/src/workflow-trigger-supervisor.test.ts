/**
 * COR-1874 — the supervisor that keeps the contributed triggers equal to the workflow files'. It
 * never starts a trigger once it is closed, however far into a reconcile the close lands.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { createDefaultRuntimeServices, createManualRuntimeServices } from '@lostgradient/lifecycle';
import type {
  PluginTrigger,
  PluginTriggerContext,
  PluginTriggerOutcome,
} from '@lostgradient/interborough-plugin';
import {
  MemoryStorage,
  textValueStore,
  type Storage,
  type TextValueStore,
} from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { quietFor, waitUntil, yieldEventLoopTurn } from '@lostgradient/testing/wait-until';
import { Engine } from '@lostgradient/weft';
import { z } from 'zod';

import { weftNameOf } from './namespaced-identifier';
import { createPluginSecretGate, gatedContributions } from './plugins/plugin-secret-gate';
import type { BureauPluginSecrets } from './plugins/plugin-types';
import { workflowFileDirectory } from './sources/workflow-file-directory';
import {
  contributionCatalog,
  createTickerController,
  type TickerController,
} from './testing/workflow-contributions.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import type { VersionedCatalogEntry } from './versioned-catalog';
import { createWorkflowContributions } from './workflow-contributions';
import { createWorkflowDocumentHost } from './workflow-host';
import { WorkflowInputInvalidError } from './workflow-schema';
import {
  createWorkflowRuntime,
  WorkflowApplyError,
  type WorkflowRuntime,
} from './workflow-runtime';
import { createWorkflowSnapshotStore } from './workflow-snapshot-store';
import {
  createWorkflowTriggerSupervisor,
  type DesiredTrigger,
  type ListenerCode,
  type ListenerState,
  type ListenerStatus,
  type TriggerFireRequest,
  type WorkflowTriggerSupervisor,
} from './workflow-trigger-supervisor';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A `fire` that starts nothing, for the tests that never fire. */
const nothingStarted = async (): Promise<PluginTriggerOutcome> => ({
  outcome: 'skipped',
  reason: 'stopped',
});

/**
 * What a supervisor that no test reads the listener of is given: a fixed clock and nobody to tell
 * about a failed start.
 */
const unobserved = {
  nowISO: () => '2020-01-01T00:00:00.000Z',
  // Manual timers: nothing real is armed, and none of them fires unless a test advances them.
  timers: createManualRuntimeServices().timers,
  exclusive: <T>(work: () => Promise<T>): Promise<T> => work(),
  reportFailure: () => undefined,
  clearFailure: () => undefined,
};

/** A promise a test settles by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A kind that records each start and stop by the `id` in its configuration; `hold` delays a start. */
function recordingKind(
  log: string[],
  hold: (id: string) => Promise<void> | undefined,
): VersionedCatalogEntry<PluginTrigger> {
  return {
    kind: 'trigger',
    name: 'x:recorder',
    version: '1',
    id: 'x:recorder@1',
    source: { name: 'x', version: '1' },
    value: {
      name: 'recorder',
      description: 'Records its starts and stops.',
      configuration: z.object({ id: z.string() }),
      start: async (context) => {
        const { id } = context.configuration as { id: string };
        log.push(`start:${id}`);
        await hold(id);
        return () => {
          log.push(`stop:${id}`);
        };
      },
    },
  };
}

function desire(
  kind: VersionedCatalogEntry<PluginTrigger>,
  ids: readonly string[],
): Map<string, DesiredTrigger> {
  return new Map(
    ids.map((id) => [id, { kind, trigger: { kind: kind.name, id } } satisfies DesiredTrigger]),
  );
}

describe('the workflow trigger supervisor', () => {
  it('starts nothing more once it is closed while a trigger is still starting', async () => {
    const log: string[] = [];
    const first = gate();
    const kind = recordingKind(log, (id) => (id === 'a' ? first.promise : undefined));
    const supervisor = createWorkflowTriggerSupervisor({
      fire: nothingStarted,
      diagnose: () => undefined,
      storage: new MemoryStorage(),
      ...unobserved,
    });

    const reconciling = supervisor.reconcile(desire(kind, ['a', 'b']), new Set());
    await waitUntil(() => log.includes('start:a'), { message: 'the first trigger to start' });
    const closing = supervisor.close();
    first.open();
    await reconciling;
    await closing;

    expect(log).toEqual(['start:a', 'stop:a']);
  });

  it('starts nothing when it is closed before a reconcile', async () => {
    const log: string[] = [];
    const supervisor = createWorkflowTriggerSupervisor({
      fire: nothingStarted,
      diagnose: () => undefined,
      storage: new MemoryStorage(),
      ...unobserved,
    });
    await supervisor.close();
    await supervisor.reconcile(
      desire(
        recordingKind(log, () => undefined),
        ['a'],
      ),
      new Set(),
    );
    expect(log).toEqual([]);
  });

  it('starts nothing after a close that lands while a changed trigger is being replaced', async () => {
    const log: string[] = [];
    const release = gate();
    let held = false;
    const kind = recordingKind(log, (id) => {
      if (id !== 'a-changed' || held) return undefined;
      held = true;
      return release.promise;
    });
    const supervisor = createWorkflowTriggerSupervisor({
      fire: nothingStarted,
      diagnose: () => undefined,
      storage: new MemoryStorage(),
      ...unobserved,
    });
    await supervisor.reconcile(desire(kind, ['a']), new Set());
    const changed = new Map<string, DesiredTrigger>([
      ['a', { kind, trigger: { kind: kind.name, id: 'a-changed' } }],
      ['b', { kind, trigger: { kind: kind.name, id: 'b' } }],
    ]);

    const reconciling = supervisor.reconcile(changed, new Set());
    await waitUntil(() => log.includes('start:a-changed'), { message: 'the replacement to start' });
    const closing = supervisor.close();
    release.open();
    await reconciling;
    await closing;

    expect(log).not.toContain('start:b');
  });
});

/** A kind that hands the context of each start to `contexts`. */
function stateKind(
  contexts: PluginTriggerContext[],
  options: { name?: string; plugin?: string; version?: string } = {},
): VersionedCatalogEntry<PluginTrigger> {
  const { name = 'cursor', plugin = 'x', version = '1' } = options;
  return {
    kind: 'trigger',
    name: `${plugin}:${name}`,
    version,
    id: `${plugin}:${name}@${version}`,
    source: { name: plugin, version },
    value: {
      name,
      description: 'Keeps a cursor.',
      configuration: z.object({ account: z.string().optional() }),
      start: async (context) => {
        contexts.push(context);
        return () => undefined;
      },
    },
  };
}

function wantedKind(
  kind: VersionedCatalogEntry<PluginTrigger>,
  files: Readonly<Record<string, Record<string, unknown>>>,
): Map<string, DesiredTrigger> {
  return new Map(
    Object.entries(files).map(([id, rest]) => [
      id,
      { kind, trigger: { kind: kind.name, ...rest } } satisfies DesiredTrigger,
    ]),
  );
}

const encoded = (value: string) => new TextEncoder().encode(value);

/** Every key of `storage`, sorted. */
async function keysOf(storage: Storage): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan('')) keys.push(key);
  return keys.toSorted();
}

function supervisorOver(storage: Storage, diagnosed: string[] = []) {
  return createWorkflowTriggerSupervisor({
    fire: nothingStarted,
    diagnose: (message) => void diagnosed.push(message),
    storage,
    ...unobserved,
  });
}

describe('the state a workflow trigger keeps for its file (COR-2164)', () => {
  it('hands start the workflow id and a storage that writes only under the narrowed prefix', async () => {
    const backing = new MemoryStorage();
    await backing.put('plugin:x:setup-state', encoded('theirs'));
    await backing.put('plugin:x:trigger:cursor:b:cursor', encoded('b'));
    await backing.put('plugin:y:trigger:cursor:a:cursor', encoded('other plugin'));
    const contexts: PluginTriggerContext[] = [];
    const supervisor = supervisorOver(backing);

    await supervisor.reconcile(wantedKind(stateKind(contexts), { a: {} }), new Set());
    const [context] = contexts;
    expect(context?.workflowId).toBe('a');
    await context!.storage.put('cursor', encoded('42'));
    await context!.storage.put('deep:key', encoded('7'));

    expect(await keysOf(backing)).toEqual([
      'plugin:x:setup-state',
      'plugin:x:trigger:cursor:a:cursor',
      'plugin:x:trigger:cursor:a:deep:key',
      'plugin:x:trigger:cursor:b:cursor',
      'plugin:y:trigger:cursor:a:cursor',
    ]);
    // It reads nothing outside its prefix: its own two keys, not `b`'s, the plugin's or `y`'s.
    expect(await keysOf(context!.storage)).toEqual(['cursor', 'deep:key']);
    expect(await context!.storage.get('setup-state')).toBeNull();
    await supervisor.close();
  });

  it('gives two files of one kind disjoint keys, and a plugin file its own, whose id has a colon', async () => {
    const backing = new MemoryStorage();
    const contexts: PluginTriggerContext[] = [];
    const supervisor = supervisorOver(backing);

    await supervisor.reconcile(
      wantedKind(stateKind(contexts), { first: {}, second: {}, foo: {}, 'foo:bar': {} }),
      new Set(),
    );
    for (const context of contexts) {
      await context.storage.put('cursor', encoded(context.workflowId));
    }

    expect(await keysOf(backing)).toEqual([
      'plugin:x:trigger:cursor:first:cursor',
      'plugin:x:trigger:cursor:foo:cursor',
      'plugin:x:trigger:cursor:foo__bar:cursor',
      'plugin:x:trigger:cursor:second:cursor',
    ]);
    for (const context of contexts) {
      expect(await keysOf(context.storage)).toEqual(['cursor']);
      expect(new TextDecoder().decode((await context.storage.get('cursor'))!)).toBe(
        context.workflowId,
      );
    }
    await supervisor.close();
  });

  it('keeps the keys across a restart', async () => {
    const backing = new MemoryStorage();
    const first: PluginTriggerContext[] = [];
    const before = supervisorOver(backing);
    await before.reconcile(wantedKind(stateKind(first), { a: {} }), new Set());
    await first[0]!.storage.put('cursor', encoded('42'));
    await before.close();

    const second: PluginTriggerContext[] = [];
    const after = supervisorOver(backing);
    await after.reconcile(wantedKind(stateKind(second), { a: {} }), new Set());

    expect(new TextDecoder().decode((await second[0]!.storage.get('cursor'))!)).toBe('42');
    await after.close();
  });

  it('keeps the keys across a pause', async () => {
    const backing = new MemoryStorage();
    const contexts: PluginTriggerContext[] = [];
    const kind = stateKind(contexts);
    const supervisor = supervisorOver(backing);
    await supervisor.reconcile(wantedKind(kind, { a: {} }), new Set());
    await contexts[0]!.storage.put('cursor', encoded('42'));

    // A paused file is not desired: its trigger stops, and nothing deletes its state.
    await supervisor.reconcile(new Map(), new Set());
    expect(contexts[0]!.signal.aborted).toBe(true);
    await supervisor.reconcile(wantedKind(kind, { a: {} }), new Set());

    expect(contexts).toHaveLength(2);
    expect(new TextDecoder().decode((await contexts[1]!.storage.get('cursor'))!)).toBe('42');
    await supervisor.close();
  });

  it('keeps the keys across a configuration edit', async () => {
    const backing = new MemoryStorage();
    const contexts: PluginTriggerContext[] = [];
    const kind = stateKind(contexts);
    const supervisor = supervisorOver(backing);
    await supervisor.reconcile(wantedKind(kind, { a: { account: 'one' } }), new Set());
    await contexts[0]!.storage.put('cursor', encoded('42'));

    await supervisor.reconcile(wantedKind(kind, { a: { account: 'two' } }), new Set());

    expect(contexts.map((context) => context.configuration)).toEqual([
      { account: 'one' },
      { account: 'two' },
    ]);
    expect(new TextDecoder().decode((await contexts[1]!.storage.get('cursor'))!)).toBe('42');
    await supervisor.close();
  });

  it('keeps the keys across a plugin version bump', async () => {
    const backing = new MemoryStorage();
    const contexts: PluginTriggerContext[] = [];
    const supervisor = supervisorOver(backing);
    await supervisor.reconcile(wantedKind(stateKind(contexts), { a: {} }), new Set());
    await contexts[0]!.storage.put('cursor', encoded('42'));

    await supervisor.reconcile(
      wantedKind(stateKind(contexts, { version: '2' }), { a: {} }),
      new Set(),
    );

    // The version is part of what restarts the listener, and not of where its state lives.
    expect(contexts).toHaveLength(2);
    expect(new TextDecoder().decode((await contexts[1]!.storage.get('cursor'))!)).toBe('42');
    await supervisor.close();
  });

  it('leaves a trigger stopped, and says so, when its kind is not named for a valid plugin', async () => {
    const contexts: PluginTriggerContext[] = [];
    const diagnosed: string[] = [];
    const supervisor = supervisorOver(new MemoryStorage(), diagnosed);

    await supervisor.reconcile(
      wantedKind(stateKind(contexts, { plugin: 'Bad_Plugin' }), { a: {} }),
      new Set(),
    );

    expect(contexts).toEqual([]);
    expect(diagnosed).toHaveLength(1);
    expect(diagnosed[0]).toContain('its storage');
    await supervisor.close();
  });
});

describe('what the supervisor hands the runtime, and answers itself (COR-2162)', () => {
  /** The requests `fire` received, answered `started`. */
  function recordingFire() {
    const requests: unknown[] = [];
    const fire = async (request: unknown): Promise<PluginTriggerOutcome> => {
      requests.push(request);
      return { outcome: 'started', runId: 'run-1' };
    };
    return { requests, fire };
  }

  it('passes the file, the kind, the version the listener started at, the payload and the key', async () => {
    const contexts: PluginTriggerContext[] = [];
    const { requests, fire } = recordingFire();
    const supervisor = createWorkflowTriggerSupervisor({
      fire,
      diagnose: () => undefined,
      storage: new MemoryStorage(),
      ...unobserved,
    });
    await supervisor.reconcile(
      wantedKind(stateKind(contexts, { version: '7' }), { a: {} }),
      new Set(),
    );

    const answer = await contexts[0]!.fire({ n: 1 }, { idempotencyKey: 'k' });
    await contexts[0]!.fire({ n: 2 });

    expect(answer).toEqual({ outcome: 'started', runId: 'run-1' });
    expect(requests).toEqual([
      { workflowId: 'a', kind: 'x:cursor', version: '7', payload: { n: 1 }, idempotencyKey: 'k' },
      { workflowId: 'a', kind: 'x:cursor', version: '7', payload: { n: 2 } },
    ]);
    await supervisor.close();
  });

  it('answers skipped stopped, and calls nothing, once the listener was stopped', async () => {
    const contexts: PluginTriggerContext[] = [];
    const { requests, fire } = recordingFire();
    const supervisor = createWorkflowTriggerSupervisor({
      fire,
      diagnose: () => undefined,
      storage: new MemoryStorage(),
      ...unobserved,
    });
    await supervisor.reconcile(wantedKind(stateKind(contexts), { a: {} }), new Set());
    await supervisor.reconcile(new Map(), new Set());

    expect(await contexts[0]!.fire({}, { idempotencyKey: 'k' })).toEqual({
      outcome: 'skipped',
      reason: 'stopped',
    });
    expect(requests).toEqual([]);
    await supervisor.close();
  });

  it('answers skipped closed, not stopped, after close aborted every listener', async () => {
    const contexts: PluginTriggerContext[] = [];
    const { requests, fire } = recordingFire();
    const supervisor = createWorkflowTriggerSupervisor({
      fire,
      diagnose: () => undefined,
      storage: new MemoryStorage(),
      ...unobserved,
    });
    await supervisor.reconcile(wantedKind(stateKind(contexts), { a: {} }), new Set());
    await supervisor.close();

    expect(contexts[0]!.signal.aborted).toBe(true);
    expect(await contexts[0]!.fire({})).toEqual({ outcome: 'skipped', reason: 'closed' });
    expect(requests).toEqual([]);
  });
});

describe('the outcome of a contributed trigger’s fire (COR-2162 outcome matrix)', () => {
  /** What a rig keeps between one boot and the next, as a restart over the same storage does. */
  interface Disk {
    readonly directory: string;
    readonly storage: MemoryStorage;
    readonly triggerStorage: MemoryStorage;
    readonly store: TextValueStore;
  }

  async function disk(): Promise<Disk> {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-trigger-fire-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    return {
      directory,
      storage: new MemoryStorage(),
      triggerStorage: new MemoryStorage(),
      store: textValueStore(new MemoryStorage()),
    };
  }

  interface BootOptions {
    /** The `x:ticker` kind's own version, and its plugin's. */
    readonly triggerVersion?: string;
    readonly triggerSourceVersion?: string;
    /** Run completed workflows out of the engine after a second, by this clock. */
    readonly clock?: { now: number };
    readonly payloadMaximumBytes?: number;
    /** The controller the `x:ticker` kind is driven by, to read what it saw. */
    readonly ticker?: TickerController;
  }

  interface Rig {
    readonly engine: Engine;
    readonly runtime: WorkflowRuntime;
    readonly ticker: TickerController;
    /** The listeners of the `x:other` kind. */
    readonly otherContexts: PluginTriggerContext[];
    readonly disk: Disk;
    put(id: string, overrides?: Record<string, unknown>): Promise<void>;
    remove(id: string): Promise<void>;
    /** Rescan the files and wait for the apply it queues. */
    apply(): Promise<void>;
    /** The latest listener of workflow `id`. */
    listener(id?: string): PluginTriggerContext;
    /** Fire the latest listener of `id`, which is the pipeline unless said. */
    fire(
      payload: unknown,
      options?: { idempotencyKey?: string },
      id?: string,
    ): Promise<PluginTriggerOutcome>;
    /** The ids of the runs of workflow `id`. */
    runIds(id?: string): Promise<string[]>;
    /** Close the runtime and the engine, as the end of a process does. */
    shutdown(): Promise<void>;
  }

  /** A file whose trigger is `x:ticker`; `overrides` change what is in it. */
  const ticking = (overrides: Record<string, unknown> = {}) => ({
    trigger: { kind: 'x:ticker', channel: 'alerts' },
    steps: [{ kind: 'activity', handler: 'x:y', input: 'hello' }],
    ...overrides,
  });

  /** A file that parks on `go`, so its run stays running. */
  const parking = () => ticking({ steps: [{ kind: 'await-signal', signal: 'go' }] });

  async function boot(on: Disk, options: BootOptions = {}): Promise<Rig> {
    const ticker = options.ticker ?? createTickerController();
    const otherContexts: PluginTriggerContext[] = [];
    const catalog = contributionCatalog({
      activityVersion: '1',
      ticker,
      triggerVersion: options.triggerVersion,
      triggerSourceVersion: options.triggerSourceVersion,
      activity: {
        name: 'y',
        retry: { maxAttempts: 1, initialBackoff: 1, backoffMultiplier: 1, maxBackoff: 1 },
        execute: (argument: { input: unknown }) => {
          if (argument.input === 'fail') throw new Error('the step failed');
          return `done:${JSON.stringify(argument.input)}`;
        },
      },
    });
    catalog.register({
      kind: 'trigger',
      name: 'x:other',
      version: '1',
      value: {
        name: 'other',
        description: 'A second kind, driven by hand.',
        configuration: z.object({ channel: z.string() }).strict(),
        start: async (context: PluginTriggerContext) => {
          otherContexts.push(context);
          return () => undefined;
        },
      },
      source: { name: 'x', version: '1' },
    });
    const contributions = createWorkflowContributions(catalog);
    const engine = new Engine({
      storage: on.storage,
      ...(options.clock === undefined
        ? {}
        : {
            getNow: () => options.clock!.now,
            retention: { completed: '1s' },
            retentionSweepInterval: '10ms',
          }),
    });
    const diagnostics: string[] = [];
    const runtime = createWorkflowRuntime({
      source: workflowFileDirectory(on.directory, { watch: false }),
      engine,
      contributions,
      host: createWorkflowDocumentHost({
        contributions,
        runAgentStep: async (request) => ({
          content: request.message,
          output: null,
          finishReason: 'stop-condition',
        }),
      }),
      snapshotStore: createWorkflowSnapshotStore({
        store: on.store,
        nowISO: () => new Date().toISOString(),
      }),
      runtime: createDefaultRuntimeServices(),
      storage: on.triggerStorage,
      payloadMaximumBytes: options.payloadMaximumBytes,
      diagnose: (message) => diagnostics.push(message),
      createError: (message, code) => Object.assign(new Error(message), { code }),
    });
    let shut = false;
    const shutdown = async () => {
      if (shut) return;
      shut = true;
      await runtime.close();
      await engine[Symbol.asyncDispose]();
    };
    cleanups.push(shutdown);
    await runtime.start();
    const rig: Rig = {
      engine,
      runtime,
      ticker,
      otherContexts,
      disk: on,
      put: (id, overrides = ticking()) =>
        writeFile(join(on.directory, `${id}.json`), workflowFileText(id, overrides)),
      remove: (id) => unlink(join(on.directory, `${id}.json`)),
      apply: () => runtime.workflows.refresh(),
      listener: (id = 'pipeline') => {
        const context = ticker.contexts.findLast((entry) => entry.workflowId === id);
        if (context === undefined) throw new Error(`no listener for ${id}`);
        return context;
      },
      fire: (payload, fireOptions, id) => rig.listener(id).fire(payload, fireOptions),
      runIds: async (id = 'pipeline') => {
        const page = await engine.list({ type: weftNameOf(id), limit: 100 });
        return page.items.map((item) => item.id);
      },
      shutdown,
    };
    await rig.apply();
    return rig;
  }

  /** A rig over a fresh disk with the pipeline file applied. */
  async function pipeline(
    overrides: Record<string, unknown> = ticking(),
    options: BootOptions = {},
  ): Promise<Rig> {
    const on = await disk();
    await writeFile(join(on.directory, 'pipeline.json'), workflowFileText('pipeline', overrides));
    return boot(on, options);
  }

  /**
   * The run an outcome names, or a failure that shows the outcome it was instead. `expected` is
   * the outcome it must be; without it a `started` or `duplicate` outcome is accepted.
   */
  function runOf(outcome: PluginTriggerOutcome, expected?: 'started' | 'duplicate'): string {
    if (outcome.outcome === 'skipped' || (expected !== undefined && outcome.outcome !== expected)) {
      throw new Error(`expected ${expected ?? 'a run'}, got ${JSON.stringify(outcome)}`);
    }
    return outcome.runId;
  }

  /** What the engine's run `runId` was started with. */
  async function triggerOf(rig: Rig, runId: string): Promise<unknown> {
    const detail = await rig.runtime.workflows.getRun(runId);
    return detail?.trigger;
  }

  /** The status the engine holds for run `runId`. */
  async function statusOf(rig: Rig, runId: string): Promise<string | undefined> {
    const state = await rig.engine.get(runId);
    return state?.status;
  }

  /**
   * Make every call of `method` first run `before`, with the 1-based count of the calls so far,
   * and record the arguments of each.
   */
  function spyOn(
    engine: Engine,
    method: 'start' | 'list' | 'listSchedules',
    before: (call: number) => Promise<void> | void = () => undefined,
  ): unknown[][] {
    const calls: unknown[][] = [];
    const original = engine[method].bind(engine) as (...args: unknown[]) => unknown;
    (engine as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      calls.push(args);
      await before(calls.length);
      return original(...args);
    };
    return calls;
  }

  /** Make the first start of `engine` carry `extra` beside the options the runtime gave it. */
  function startingWith(engine: Engine, extra: Record<string, unknown>): void {
    const original = engine.start.bind(engine) as (...args: unknown[]) => unknown;
    let first = true;
    (engine as unknown as Record<string, unknown>)['start'] = async (
      name: unknown,
      input: unknown,
      startOptions: Record<string, unknown>,
    ) => {
      const extended = first ? { ...startOptions, ...extra } : startOptions;
      first = false;
      return original(name, input, extended);
    };
  }

  /**
   * Hold the apply a change starts after the files are registered and before the triggers are
   * reconciled (the schedule read sits between them), run `act` in that window, then let it finish.
   * In it the engine has the changed file, and the old listener is not yet stopped.
   */
  async function inTheApplyWindow(
    rig: Rig,
    change: () => Promise<void>,
    act: () => Promise<void>,
  ): Promise<void> {
    const entered = gate();
    const release = gate();
    spyOn(rig.engine, 'listSchedules', async (call) => {
      if (call !== 1) return;
      entered.open();
      await release.promise;
    });
    await change();
    const applying = rig.apply();
    await entered.promise;
    try {
      await act();
    } finally {
      release.open();
    }
    await applying;
  }

  /** Change the pipeline's file while the engine refuses to register it, so the apply fails. */
  async function failTheNextRegistration(rig: Rig): Promise<void> {
    rig.engine.registerSource = () => {
      throw new Error('registration refused');
    };
    await rig.put(
      'pipeline',
      ticking({ steps: [{ kind: 'activity', handler: 'x:y', input: 'changed' }] }),
    );
    await rig.apply();
  }

  /** The origin of a run the pipeline's `x:ticker` trigger starts (COR-2163). */
  const pipelineOrigin = { kind: 'trigger', plugin: 'x', workflowId: 'pipeline' };

  /** The namespaced digest Bureau tags a started run with, as the design names it. */
  const keyTag = (workflowId: string, kind: string, key: string): string =>
    `trigger:${createHash('sha256').update(`trigger:${workflowId}:${kind}:${key}`).digest('hex')}`;

  interface Row {
    /** The matrix row it pins, with `(unchanged)` for a row that pins what `main` already does. */
    readonly row: string;
    readonly run: () => Promise<void>;
  }

  const rows: readonly Row[] = [
    {
      row: 'a fire with no key starts a run, and the run records no key',
      run: async () => {
        const rig = await pipeline();
        const runId = runOf(await rig.fire({ issue: 1 }), 'started');
        expect(await triggerOf(rig, runId)).toEqual({
          kind: 'x:ticker',
          version: '1',
          payload: { issue: 1 },
          origin: pipelineOrigin,
        });
        expect(await rig.runIds()).toEqual([runId]);
      },
    },
    {
      row: 'two fires with one key, one after the other: started, then duplicate with the same run',
      run: async () => {
        const rig = await pipeline();
        const first = runOf(await rig.fire({ n: 1 }, { idempotencyKey: 'k' }), 'started');
        const second = runOf(await rig.fire({ n: 1 }, { idempotencyKey: 'k' }), 'duplicate');
        expect(second).toBe(first);
        expect(await rig.runIds()).toEqual([first]);
        expect(await triggerOf(rig, first)).toEqual({
          kind: 'x:ticker',
          version: '1',
          payload: { n: 1 },
          idempotencyKey: 'k',
          origin: pipelineOrigin,
        });
      },
    },
    {
      row: 'two fires with one key at once, the first held in its start: the second looks up only after it, and answers duplicate',
      run: async () => {
        const rig = await pipeline();
        const log: string[] = [];
        spyOn(rig.engine, 'list', () => void log.push('list'));
        const inStart = gate();
        const holdStart = gate();
        spyOn(rig.engine, 'start', async (call) => {
          log.push('start');
          if (call !== 1) return;
          inStart.open();
          await holdStart.promise;
        });
        const first = rig.fire({ n: 1 }, { idempotencyKey: 'k' });
        await inStart.promise;
        const second = rig.fire({ n: 1 }, { idempotencyKey: 'k' });
        // The second fire waits for the first's section: it has not looked up, let alone started.
        await quietFor(25);
        expect(log).toEqual(['list', 'start']);
        holdStart.open();
        const runId = runOf(await first, 'started');
        expect(runOf(await second, 'duplicate')).toBe(runId);
        expect(log).toEqual(['list', 'start', 'list']);
        expect(await rig.runIds()).toEqual([runId]);
      },
    },
    {
      row: 'two fires with one key, the second issued at every await of the first: one run, one runId',
      run: async () => {
        const rig = await pipeline();
        let fires = 0;
        /** Fire twice with a fresh key, the second after `wait` has let the first get that far. */
        const fireTwice = async (wait: () => Promise<void>) => {
          fires += 1;
          const key = `k${fires}`;
          const first = rig.fire({ n: fires }, { idempotencyKey: key });
          await wait();
          const second = rig.fire({ n: fires }, { idempotencyKey: key });
          const outcomes = await Promise.all([first, second]);
          expect(outcomes.map((outcome) => outcome.outcome).toSorted()).toEqual([
            'duplicate',
            'started',
          ]);
          expect(runOf(outcomes[1])).toBe(runOf(outcomes[0]));
        };
        // The sweep is a spread of interleavings, not a deadline: after each number of microtask
        // hops the first fire has made, and after each event-loop turn.
        for (let hops = 0; hops <= 60; hops += 1) {
          await fireTwice(async () => {
            // load-proof: this is not a wait. Each count is a different interleaving of the second fire with the first, every count runs, and the assertions follow once both fires have settled; nothing waits on a host.
            for (let hop = 0; hop < hops; hop += 1) await Promise.resolve();
          });
        }
        for (let turns = 0; turns <= 12; turns += 1) {
          await fireTwice(async () => {
            // load-proof: this is not a wait. Each count is a different interleaving of the second fire with the first, every count runs, and the assertions follow once both fires have settled; nothing waits on a host.
            for (let turn = 0; turn < turns; turn += 1) await yieldEventLoopTurn();
          });
        }
        expect(await rig.runIds()).toHaveLength(fires);
      },
    },
    // Two Bureaus over one storage can both look up before either commits and start two runs. That
    // is a known gap: Weft's own key path would settle it with a compare-and-set, and a tag lookup
    // is not one. The listener lease (COR-2167) skips `receive`-only triggers, so it does not close
    // it either. There is no row for it here, because nothing about it is required.
    ...(
      [
        ['running', 'parked', parking(), undefined],
        ['completed', 'done', ticking(), undefined],
        [
          'failed',
          'broken',
          ticking({ steps: [{ kind: 'activity', handler: 'x:y', input: 'fail' }] }),
          undefined,
        ],
        ['suspended', 'waiting', parking(), 'suspend'],
        ['cancelled', 'stopped', parking(), 'cancel'],
      ] as const
    ).map(([status, id, overrides, then]): Row => ({
      row: `a repeat of a key whose run is ${status} answers duplicate with that run`,
      run: async () => {
        const rig = await pipeline();
        await rig.put(id, overrides);
        await rig.apply();
        const first = runOf(await rig.fire({}, { idempotencyKey: 'k' }, id), 'started');
        if (then === 'cancel') await rig.engine.cancel(first);
        if (then === 'suspend') await rig.engine.suspend(first);
        await waitUntil(async () => (await statusOf(rig, first)) === status, {
          message: `the run to be ${status}`,
        });
        expect(runOf(await rig.fire({}, { idempotencyKey: 'k' }, id), 'duplicate')).toBe(first);
        expect(await rig.runIds(id)).toEqual([first]);
      },
    })),
    {
      row: 'a repeat of a key whose run is pending (a delayed start) answers duplicate with that run',
      run: async () => {
        const clock = { now: 1_000 };
        const rig = await pipeline(parking(), { clock });
        startingWith(rig.engine, { startAt: clock.now + 3_600_000 });
        const first = runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'started');
        expect(await statusOf(rig, first)).toBe('pending');
        expect(runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'duplicate')).toBe(first);
        expect(await rig.runIds()).toEqual([first]);
      },
    },
    {
      row: 'a repeat of a key whose run timed out answers duplicate with that run',
      run: async () => {
        const clock = { now: 1_000 };
        const rig = await pipeline(parking(), { clock });
        startingWith(rig.engine, { executionTimeout: 60_000 });
        const first = runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'started');
        clock.now += 120_000;
        await rig.engine.scheduler.tick(clock.now);
        await waitUntil(async () => (await statusOf(rig, first)) === 'timed-out', {
          message: 'the run to time out',
        });
        expect(runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'duplicate')).toBe(first);
        expect(await rig.runIds()).toEqual([first]);
      },
    },
    {
      row: 'a start that throws after it committed took the key: the redelivery answers duplicate with the committed run',
      run: async () => {
        const rig = await pipeline();
        const original = rig.engine.start.bind(rig.engine);
        let committed: string | undefined;
        (rig.engine as unknown as Record<string, unknown>)['start'] = async (
          ...args: Parameters<Engine['start']>
        ) => {
          const handle = await original(...args);
          if (committed === undefined) {
            committed = handle.id;
            throw new Error('the start failed after its commit');
          }
          return handle;
        };
        expect(await rejectionOf(rig.fire({}, { idempotencyKey: 'k' }))).toMatchObject({
          message: 'the start failed after its commit',
        });
        expect(runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'duplicate')).toBe(committed!);
        expect(await rig.runIds()).toEqual([committed!]);
      },
    },
    {
      row: 'a repeat after the run record was purged starts a new run, and no key reaches Weft',
      run: async () => {
        const rig = await pipeline();
        const starts = spyOn(rig.engine, 'start');
        const first = runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'started');
        await waitUntil(async () => (await statusOf(rig, first)) === 'completed', {
          message: 'the run to complete',
        });
        expect(await rig.engine.purgeById(first)).toBe(true);
        const second = runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'started');
        expect(second).not.toBe(first);
        expect(await rig.runIds()).toEqual([second]);
        // The key is a tag on the run, namespaced and hashed; Weft's own key mapping is not used,
        // because it outlives a purge and would refuse the repeat.
        for (const [, , startOptions] of starts) {
          expect(startOptions).toEqual({
            tags: ['origin:trigger', keyTag('pipeline', 'x:ticker', 'k')],
          });
        }
        expect(starts).toHaveLength(2);
      },
    },
    {
      row: 'a repeat after the retention sweep removed the run starts a new run',
      run: async () => {
        const clock = { now: 1_000 };
        const rig = await pipeline(ticking(), { clock });
        const first = runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'started');
        await waitUntil(async () => (await statusOf(rig, first)) === 'completed', {
          message: 'the run to complete',
        });
        expect(runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'duplicate')).toBe(first);
        clock.now += 60_000;
        await waitUntil(async () => (await rig.engine.get(first)) === null, {
          message: 'the retention sweep to remove the run',
        });
        const second = runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'started');
        expect(second).not.toBe(first);
      },
    },
    {
      row: 'the same key under two workflow files starts one run per file',
      run: async () => {
        const rig = await pipeline();
        await rig.put('second', ticking());
        await rig.apply();
        const first = runOf(await rig.fire({}, { idempotencyKey: 'k' }, 'pipeline'), 'started');
        const second = runOf(await rig.fire({}, { idempotencyKey: 'k' }, 'second'), 'started');
        expect(second).not.toBe(first);
        expect(await rig.runIds('pipeline')).toEqual([first]);
        expect(await rig.runIds('second')).toEqual([second]);
      },
    },
    {
      row: 'a manual start with the same key string never collides with a trigger fire',
      run: async () => {
        const rig = await pipeline();
        const manual = await rig.runtime.workflows.start('pipeline', {
          owner: 'anonymous:local',
          idempotencyKey: 'k',
        });
        const fired = runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'started');
        expect(fired).not.toBe(manual.runId);
        const runIds = await rig.runIds();
        expect(runIds.toSorted()).toEqual([fired, manual.runId].toSorted());
      },
    },
    {
      row: 'the same key from another trigger kind of the same file starts its own run',
      run: async () => {
        const rig = await pipeline();
        const first = runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'started');
        await rig.put('pipeline', ticking({ trigger: { kind: 'x:other', channel: 'alerts' } }));
        await rig.apply();
        const second = runOf(
          await rig.otherContexts.at(-1)!.fire({}, { idempotencyKey: 'k' }),
          'started',
        );
        expect(second).not.toBe(first);
      },
    },
    {
      row: 'a plugin upgrade alone does not split a key: the repeat answers duplicate',
      run: async () => {
        const on = await disk();
        await writeFile(
          join(on.directory, 'pipeline.json'),
          workflowFileText('pipeline', ticking()),
        );
        const before = await boot(on);
        const first = runOf(await before.fire({}, { idempotencyKey: 'k' }), 'started');
        await waitUntil(async () => (await statusOf(before, first)) === 'completed', {
          message: 'the run to complete',
        });
        await before.shutdown();
        const after = await boot(on, { triggerVersion: '2', triggerSourceVersion: '2' });
        expect(runOf(await after.fire({}, { idempotencyKey: 'k' }), 'duplicate')).toBe(first);
        expect(await triggerOf(after, first)).toMatchObject({ version: '1' });
      },
    },
    {
      row: 'a redelivery after a restart answers duplicate with the run the first process started',
      run: async () => {
        const on = await disk();
        await writeFile(
          join(on.directory, 'pipeline.json'),
          workflowFileText('pipeline', parking()),
        );
        const before = await boot(on);
        const first = runOf(await before.fire({ n: 1 }, { idempotencyKey: 'k' }), 'started');
        await before.shutdown();
        const after = await boot(on);
        expect(runOf(await after.fire({ n: 1 }, { idempotencyKey: 'k' }), 'duplicate')).toBe(first);
        expect(await after.runIds()).toEqual([first]);
        // The run resumed with the record it was started with.
        expect(await triggerOf(after, first)).toEqual({
          kind: 'x:ticker',
          version: '1',
          payload: { n: 1 },
          idempotencyKey: 'k',
          origin: pipelineOrigin,
        });
      },
    },
    {
      row: 'a repeat with another payload answers duplicate, and the first payload stays',
      run: async () => {
        const rig = await pipeline();
        const first = runOf(await rig.fire({ n: 1 }, { idempotencyKey: 'k' }), 'started');
        expect(runOf(await rig.fire({ n: 2 }, { idempotencyKey: 'k' }), 'duplicate')).toBe(first);
        expect(await triggerOf(rig, first)).toMatchObject({ payload: { n: 1 } });
      },
    },
    {
      row: 'an empty, non-string or undefined key: the first two reject BAD_REQUEST, the last is no key',
      run: async () => {
        const rig = await pipeline();
        for (const key of ['', 5, null, {}]) {
          const refusal = await rejectionOf(rig.fire({}, { idempotencyKey: key as never }));
          expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
        }
        expect(await rig.runIds()).toEqual([]);
        runOf(await rig.fire({}, { idempotencyKey: undefined } as never), 'started');
        runOf(await rig.fire({}), 'started');
        expect(await rig.runIds()).toHaveLength(2);
      },
    },
    {
      row: 'a key longer than Weft’s own bound starts once, then answers duplicate',
      run: async () => {
        const rig = await pipeline();
        const key = 'k'.repeat(300);
        const first = runOf(await rig.fire({}, { idempotencyKey: key }), 'started');
        expect(runOf(await rig.fire({}, { idempotencyKey: key }), 'duplicate')).toBe(first);
      },
    },
    {
      row: 'a lookup that throws rejects and starts nothing; a start the engine refuses before it commits leaves the key free (unchanged)',
      run: async () => {
        const rig = await pipeline();
        let failList = true;
        let failStart = false;
        spyOn(rig.engine, 'list', () => {
          if (failList) throw new Error('storage unavailable');
        });
        spyOn(rig.engine, 'start', () => {
          if (failStart) throw new Error('start refused');
        });
        expect(await rejectionOf(rig.fire({}, { idempotencyKey: 'k' }))).toMatchObject({
          message: 'storage unavailable',
        });
        failList = false;
        failStart = true;
        expect(await rejectionOf(rig.fire({}, { idempotencyKey: 'k' }))).toMatchObject({
          message: 'start refused',
        });
        expect(await rig.runIds()).toEqual([]);
        failStart = false;
        runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'started');
      },
    },
    {
      row: 'a fire after the file’s trigger kind is no longer loaded answers skipped stopped',
      run: async () => {
        const rig = await pipeline();
        const leftover = rig.listener();
        await rig.put('pipeline', ticking({ trigger: { kind: 'x:missing', channel: 'alerts' } }));
        await rig.apply();
        expect(await leftover.fire({}, { idempotencyKey: 'k' })).toEqual({
          outcome: 'skipped',
          reason: 'stopped',
        });
        expect(await rig.runIds()).toEqual([]);
      },
    },
    {
      row: 'a fire after the listener was stopped by a pause answers skipped stopped',
      run: async () => {
        const rig = await pipeline();
        const leftover = rig.listener();
        await rig.put('pipeline', ticking({ paused: true }));
        await rig.apply();
        expect(await leftover.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
        expect(await rig.runIds()).toEqual([]);
      },
    },
    {
      row: 'a fire on a paused file whose listener is not yet stopped answers skipped paused, and leaves the key free',
      run: async () => {
        const rig = await pipeline();
        const leftover = rig.listener();
        await inTheApplyWindow(
          rig,
          () => rig.put('pipeline', ticking({ paused: true })),
          async () => {
            expect(await leftover.fire({}, { idempotencyKey: 'k' })).toEqual({
              outcome: 'skipped',
              reason: 'paused',
            });
          },
        );
        expect(await rig.runIds()).toEqual([]);
        // Unpaused, a new listener starts, and the same delivery is redelivered to it.
        await rig.put('pipeline', ticking());
        await rig.apply();
        expect(rig.listener()).not.toBe(leftover);
        runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'started');
        expect(await leftover.fire({}, { idempotencyKey: 'k' })).toEqual({
          outcome: 'skipped',
          reason: 'stopped',
        });
      },
    },
    {
      row: 'a fire for a file the engine no longer has answers skipped stopped',
      run: async () => {
        const rig = await pipeline();
        const leftover = rig.listener();
        await inTheApplyWindow(
          rig,
          () => rig.remove('pipeline'),
          async () => {
            expect(await leftover.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
          },
        );
        expect(await rig.runIds()).toEqual([]);
      },
    },
    {
      row: 'a fire for a file the engine has applied as another trigger kind answers skipped stopped',
      run: async () => {
        const rig = await pipeline();
        const leftover = rig.listener();
        await inTheApplyWindow(
          rig,
          () => rig.put('pipeline', ticking({ trigger: { kind: 'x:other', channel: 'alerts' } })),
          async () => {
            expect(await leftover.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
          },
        );
        expect(await rig.runIds()).toEqual([]);
      },
    },
    {
      row: 'a fire after close answers skipped closed',
      run: async () => {
        const rig = await pipeline();
        const leftover = rig.listener();
        await rig.runtime.close();
        expect(await leftover.fire({}, { idempotencyKey: 'k' })).toEqual({
          outcome: 'skipped',
          reason: 'closed',
        });
        expect(await rig.runIds()).toEqual([]);
      },
    },
    {
      row: 'a fire in flight when close begins starts its run, and one queued behind it answers skipped closed',
      run: async () => {
        const rig = await pipeline();
        const inStart = gate();
        const holdStart = gate();
        spyOn(rig.engine, 'start', async (call) => {
          if (call !== 1) return;
          inStart.open();
          await holdStart.promise;
        });
        const running = rig.fire({ n: 1 }, { idempotencyKey: 'a' });
        await inStart.promise;
        const queued = rig.fire({ n: 2 }, { idempotencyKey: 'b' });
        await quietFor(25);
        // The trigger's stop waits for both fires, and the close waits for the stop.
        const closing = rig.runtime.close();
        holdStart.open();
        const first = runOf(await running, 'started');
        expect(await queued).toEqual({ outcome: 'skipped', reason: 'closed' });
        await closing;
        expect(await rig.runIds()).toEqual([first]);
      },
    },
    {
      row: 'a fire from inside the trigger’s own start answers started (unchanged)',
      run: async () => {
        const ticker = createTickerController();
        ticker.fireOnStart = { early: true };
        const rig = await pipeline(ticking(), { ticker });
        expect(ticker.startOutcomes.map((outcome) => outcome.outcome)).toEqual(['started']);
        expect(await rig.runIds()).toHaveLength(1);
      },
    },
    {
      row: 'a payload the inputSchema refuses rejects, starts nothing, and leaves the key free (unchanged)',
      run: async () => {
        const rig = await pipeline(
          ticking({
            inputSchema: {
              type: 'object',
              required: ['issue'],
              properties: { issue: { type: 'string' } },
            },
          }),
        );
        expect(await rejectionOf(rig.fire({ issue: 3 }, { idempotencyKey: 'k' }))).toBeInstanceOf(
          WorkflowInputInvalidError,
        );
        expect(await rig.runIds()).toEqual([]);
        runOf(await rig.fire({ issue: 'COR-1' }, { idempotencyKey: 'k' }), 'started');
      },
    },
    {
      row: 'a payload that is not JSON rejects BAD_REQUEST, and on a paused file answers skipped paused (unchanged order)',
      run: async () => {
        const rig = await pipeline();
        const refusal = await rejectionOf(rig.fire(1n, { idempotencyKey: 'k' }));
        expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
        const leftover = rig.listener();
        await inTheApplyWindow(
          rig,
          () => rig.put('pipeline', ticking({ paused: true })),
          async () => {
            expect(await leftover.fire(1n, { idempotencyKey: 'k' })).toEqual({
              outcome: 'skipped',
              reason: 'paused',
            });
          },
        );
        expect(await rig.runIds()).toEqual([]);
      },
    },
    {
      row: 'a payload too large to send rejects, and leaves the key free (unchanged)',
      run: async () => {
        const rig = await pipeline(ticking(), { payloadMaximumBytes: 400 });
        const refusal = await rejectionOf(rig.fire('x'.repeat(2_000), { idempotencyKey: 'k' }));
        expect(refusal).toBeInstanceOf(Error);
        expect(await rig.runIds()).toEqual([]);
        runOf(await rig.fire('small', { idempotencyKey: 'k' }), 'started');
      },
    },
    {
      row: 'a fire while the last registration failed rejects with WorkflowApplyError (unchanged)',
      run: async () => {
        const rig = await pipeline();
        await failTheNextRegistration(rig);
        const refusal = await rejectionOf(rig.fire({}, { idempotencyKey: 'k' }));
        expect(refusal).toBeInstanceOf(WorkflowApplyError);
        expect(await rig.runIds()).toEqual([]);
      },
    },
    {
      row: 'a repeat of a run that exists answers duplicate while the apply failed, the file is paused, or the payload is refused now',
      run: async () => {
        const rig = await pipeline(
          ticking({ inputSchema: { type: 'object', properties: { issue: { type: 'string' } } } }),
        );
        const first = runOf(await rig.fire({ issue: 'a' }, { idempotencyKey: 'k' }), 'started');
        const leftover = rig.listener();
        // The payload the key started with is refused by the schema the file has now.
        await rig.put(
          'pipeline',
          ticking({
            inputSchema: {
              type: 'object',
              required: ['ticket'],
              properties: { ticket: { type: 'number' } },
            },
          }),
        );
        await rig.apply();
        expect(rig.listener()).toBe(leftover);
        expect(
          runOf(await leftover.fire({ issue: 'a' }, { idempotencyKey: 'k' }), 'duplicate'),
        ).toBe(first);
        expect(
          await rejectionOf(leftover.fire({ issue: 'a' }, { idempotencyKey: 'other' })),
        ).toBeInstanceOf(WorkflowInputInvalidError);
        // Paused, with the listener not yet stopped.
        await inTheApplyWindow(
          rig,
          () => rig.put('pipeline', ticking({ paused: true })),
          async () => {
            expect(runOf(await leftover.fire({}, { idempotencyKey: 'k' }), 'duplicate')).toBe(
              first,
            );
            expect(await leftover.fire({}, { idempotencyKey: 'new' })).toEqual({
              outcome: 'skipped',
              reason: 'paused',
            });
          },
        );
      },
    },
    {
      row: 'a repeat of a run that exists answers duplicate while the last apply failed',
      run: async () => {
        const rig = await pipeline();
        const first = runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'started');
        await failTheNextRegistration(rig);
        expect(runOf(await rig.fire({}, { idempotencyKey: 'k' }), 'duplicate')).toBe(first);
        expect(await rejectionOf(rig.fire({}, { idempotencyKey: 'fresh' }))).toBeInstanceOf(
          WorkflowApplyError,
        );
      },
    },
    {
      row: 'the run records the version of the kind itself, not its plugin’s',
      run: async () => {
        const rig = await pipeline(ticking(), { triggerVersion: '7', triggerSourceVersion: '3' });
        const runId = runOf(await rig.fire({}), 'started');
        expect(await triggerOf(rig, runId)).toMatchObject({ version: '7' });
      },
    },
  ];

  for (const { row, run } of rows) {
    it(row, async () => {
      await run();
    });
  }
});

/**
 * COR-2165 — what a listener is doing, and why, as the supervisor keeps it. Every row is a cell of
 * the outcome matrix of COR-2165 and COR-2166 (`tmp/chef/briefs/COR-2165-2166-matrix.md`): the
 * event, the state it starts from, and the state, problem, `since`, controller and stop it ends in.
 */
describe('the listener state of a contributed trigger (COR-2165 outcome matrix)', () => {
  const ORIGIN = '2020-01-01T00:00:00.000Z';
  const KIND = 'x:watch';
  const SECRET_KEY = 'x-token';

  /** What the rig's kind does when started, by the `account` of its configuration. */
  type OnStart = (context: PluginTriggerContext, count: number) => Promise<void> | void;

  interface ListenerRig {
    readonly supervisor: WorkflowTriggerSupervisor;
    readonly services: ReturnType<typeof createManualRuntimeServices>;
    /** The context of every start, in order. */
    readonly starts: PluginTriggerContext[];
    /** The stops that ran, as `stop:<account>`, in order. */
    readonly stops: string[];
    /** What the problem reporter was told, in order. */
    readonly calls: string[];
    readonly diagnosed: string[];
    /** The requests the host's `fire` received. */
    readonly requests: TriggerFireRequest[];
    /** The `trigger-failed` problems the plugin lists now: `workflow` to its message. */
    problems(): Record<string, string>;
    /** Replace what each start does. */
    onStart: OnStart;
    /** Replace what the kind's stop does. */
    onStop: (account: string) => Promise<void> | void;
    /** Replace what the host answers a fire with. */
    answer: (request: TriggerFireRequest) => Promise<PluginTriggerOutcome>;
    /** The listener of workflow `id`. */
    status(id?: string): unknown;
    /** Reconcile, as the runtime does: under its serialization lock. */
    reconcile(
      files: Readonly<Record<string, { account?: unknown; paused?: boolean }>>,
      keep?: ReadonlySet<string>,
    ): Promise<void>;
    /** Reconcile without the lock, so two of them overlap, to reach what a close can do alone. */
    reconcileDirect(
      files: Readonly<Record<string, { account?: unknown; paused?: boolean }>>,
      keep?: ReadonlySet<string>,
    ): Promise<void>;
    /** Retry workflow `id` now, as the runtime's `retryTrigger` does. */
    retry(id?: string): Promise<ListenerStatus | undefined>;
    /** Every callback the supervisor gave the timers, in order, even one it later cleared. */
    readonly timerCallbacks: Array<() => void>;
    /** The timers armed now. */
    pendingTimers(): ReturnType<ReturnType<typeof createManualRuntimeServices>['pendingTimers']>;
    /** Advance the clock by `milliseconds`, fire the timers that fall due, and wait for the attempts they queued. */
    advance(milliseconds: number): Promise<void>;
    /** Move only the wall clock, which `since` and `lastFiredAt` read: no timer fires. */
    passTime(milliseconds: number): Promise<void>;
    /** Wait for everything queued under the serialization lock. */
    settled(): Promise<void>;
  }

  const ready = (): Promise<void> => Promise.resolve();

  function baseKind(rig: Pick<ListenerRig, 'starts' | 'stops' | 'onStart' | 'onStop'>) {
    const trigger: PluginTrigger = {
      name: 'watch',
      description: 'Watches a source.',
      configuration: z.object({ account: z.string().optional() }),
      start: async (context) => {
        rig.starts.push(context);
        const account = (context.configuration as { account?: string }).account ?? '';
        await rig.onStart(context, rig.starts.length);
        return async () => {
          rig.stops.push(`stop:${account}`);
          await rig.onStop(account);
        };
      },
    };
    return trigger;
  }

  /** A rig over a kind `wrap` may gate. */
  function listenerRig(wrap?: (kind: PluginTrigger) => PluginTrigger): ListenerRig {
    const services = createManualRuntimeServices();
    const timerCallbacks: Array<() => void> = [];
    const timers = {
      ...services.timers,
      setTimeout: (callback: () => void, milliseconds?: number) => {
        timerCallbacks.push(callback);
        return services.timers.setTimeout(callback, milliseconds);
      },
    };
    // The runtime's `exclusive`: one step at a time, a reconcile's among them.
    let tail: Promise<unknown> = Promise.resolve();
    const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
      const result = tail.then(work, work);
      tail = result.catch(() => undefined);
      return result;
    };
    const failing = new Map<string, string>();
    const calls: string[] = [];
    const requests: TriggerFireRequest[] = [];
    const state = {
      starts: [] as PluginTriggerContext[],
      stops: [] as string[],
      onStart: ready as OnStart,
      onStop: ready as (account: string) => Promise<void> | void,
      answer: (async (): Promise<PluginTriggerOutcome> => ({
        outcome: 'started',
        runId: `run-${requests.length}`,
      })) as (request: TriggerFireRequest) => Promise<PluginTriggerOutcome>,
    };
    const trigger = baseKind(state);
    const entry: VersionedCatalogEntry<PluginTrigger> = {
      kind: 'trigger',
      name: KIND,
      version: '1',
      id: `${KIND}@1`,
      source: { name: 'x', version: '1' },
      value: wrap === undefined ? trigger : wrap(trigger),
    };
    const desiredOf = (
      files: Readonly<Record<string, { account?: unknown; paused?: boolean }>>,
    ): Map<string, DesiredTrigger> =>
      new Map(
        Object.entries(files).map(([id, { paused, ...rest }]) => [
          id,
          {
            kind: entry,
            trigger: { kind: KIND, ...rest },
            ...(paused === undefined ? {} : { paused }),
          } satisfies DesiredTrigger,
        ]),
      );
    const diagnosed: string[] = [];
    const supervisor = createWorkflowTriggerSupervisor({
      fire: async (request) => {
        requests.push(request);
        return state.answer(request);
      },
      diagnose: (message) => void diagnosed.push(message),
      storage: new MemoryStorage(),
      nowISO: () => services.clock.nowISO(),
      timers,
      exclusive,
      reportFailure: (plugin, workflow, message) => {
        calls.push(`report ${plugin}/${workflow}`);
        // The registry keeps the first message of a workflow that is still failing.
        if (!failing.has(workflow)) failing.set(workflow, message);
      },
      clearFailure: (plugin, workflow) => {
        calls.push(`clear ${plugin}/${workflow}`);
        failing.delete(workflow);
      },
    });
    cleanups.push(() => supervisor.close());
    const rig: ListenerRig = {
      supervisor,
      services,
      starts: state.starts,
      stops: state.stops,
      calls,
      diagnosed,
      requests,
      problems: () => Object.fromEntries(failing),
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
      status: (id = 'a') => supervisor.listener(id, KIND),
      reconcile: (files, keep = new Set()) =>
        exclusive(() => supervisor.reconcile(desiredOf(files), keep)),
      reconcileDirect: (files, keep = new Set()) => supervisor.reconcile(desiredOf(files), keep),
      retry: (id = 'a') => supervisor.retry(id),
      timerCallbacks,
      pendingTimers: () => services.pendingTimers(),
      advance: async (milliseconds) => {
        await services.advance(milliseconds);
        await rig.settled();
      },
      passTime: async (milliseconds) => {
        services.setTime(services.clock.now() + milliseconds);
      },
      settled: async () => {
        let seen: Promise<unknown>;
        do {
          seen = tail;
          await seen;
        } while (seen !== tail);
      },
    };
    rigsOfTheRow.push(rig);
    return rig;
  }

  /** Every rig the row under way built, so the invariant below is read from each. */
  const rigsOfTheRow: ListenerRig[] = [];

  /**
   * I3 (COR-2166): the published `retryAt` is non-null exactly while a retry timer is armed. Read
   * after every row, so a path that cancels a timer, or starts an attempt, without clearing it
   * fails here whichever row reaches it.
   */
  function expectRetryAtToMatchTheTimers(rig: ListenerRig): void {
    let published = 0;
    for (const id of ['a', 'b', 'c', 'd']) {
      for (const kind of [KIND, 'Bad_Plugin:watch']) {
        if (rig.supervisor.listener(id, kind)?.retryAt != null) published += 1;
      }
    }
    expect(published, 'published retryAt values').toBe(rig.pendingTimers().length);
  }

  /** The error a start throws. */
  const boom = (): never => {
    throw new Error('the source refused the token sk-live-0123456789');
  };

  /** `onStart` that throws for the account `bad`, holds for `hold` until `release`, else resolves. */
  function scripted(rig: ListenerRig, release?: Promise<void>): void {
    rig.onStart = async (context) => {
      const account = (context.configuration as { account?: string }).account;
      if (account === 'bad') boom();
      if (account === 'hold') await release;
    };
  }

  const status = (
    state: ListenerState,
    since: string,
    code: ListenerCode | null = null,
    lastFiredAt: string | null = null,
    retryAt: string | null = null,
  ): ListenerStatus => ({
    state,
    since,
    code,
    lastFiredAt,
    retryAt,
  });

  /** The ISO time `seconds` after the rig's origin. */
  const at = (seconds: number): string =>
    new Date(Date.parse(ORIGIN) + seconds * 1000).toISOString();

  /** A secret store the test saves to and removes from, as a host's `watch` notifies. */
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

  /** A rig whose kind waits for the secret `x-token`, as a plugin that declares it does. */
  async function gatedRig(initially: 'missing' | 'set') {
    const secrets = secretStore();
    if (initially === 'set') secrets.save();
    const secretGate = await createPluginSecretGate('x', [SECRET_KEY], secrets.reader);
    cleanups.push(secretGate.watch());
    const rig = listenerRig(
      (trigger) =>
        gatedContributions(
          { triggers: [trigger] },
          secretGate,
          (name) => `x:${name}`,
          () => undefined,
        ).triggers[0]!,
    );
    return { rig, secrets };
  }

  /** Wait for workflow `id` to be in `state`. */
  async function inState(rig: ListenerRig, state: string, id = 'a'): Promise<void> {
    await waitUntil(() => (rig.status(id) as { state: string } | undefined)?.state === state, {
      message: `the listener of ${id} to be ${state}`,
    });
  }

  interface ListenerRow {
    readonly row: string;
    readonly run: () => Promise<void>;
  }

  const rows: readonly ListenerRow[] = [
    {
      row: 'start resolves, from none: listening since now, kept with no problem',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: {} });
        expect(rig.status()).toEqual(status('listening', ORIGIN));
        expect(rig.problems()).toEqual({});
        expect(rig.calls).toEqual([]);
      },
    },
    {
      row: 'a first start still in flight records nothing, and the state is written when it settles',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        scripted(rig, release.promise);
        const reconciling = rig.reconcile({ a: { account: 'hold' } });
        await waitUntil(() => rig.starts.length === 1, { message: 'the start to begin' });
        expect(rig.status()).toBeUndefined();
        await rig.passTime(5_000);
        release.open();
        await reconciling;
        expect(rig.status()).toEqual(status('listening', '2020-01-01T00:00:05.000Z'));
      },
    },
    {
      row: 'start throws, from none: failed start-failed with one problem naming the workflow, redacted by the registry (the message is passed whole), and the attempt’s controller aborted',
      run: async () => {
        const rig = listenerRig();
        scripted(rig);
        await rig.reconcile({ a: { account: 'bad' } });
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'start-failed', null, at(1)));
        expect(rig.calls).toEqual(['report x/a']);
        expect(rig.problems()['a']).toContain('the source refused the token');
        expect(rig.starts[0]!.signal.aborted).toBe(true);
      },
    },
    {
      row: 'a fire of an attempt whose start threw answers skipped stopped, and starts nothing',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: {} });
        // The plugin captured `fire` before it threw.
        expect(await rig.starts[0]!.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
        expect(rig.requests).toEqual([]);
        expect(rig.status()).toMatchObject({ state: 'failed', code: 'start-failed' });
      },
    },
    {
      row: 'start throws, from failed (an edit that fails again): still failed, since kept, one problem, not reported twice',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: { account: 'one' } });
        await rig.passTime(7_000);
        await rig.reconcile({ a: { account: 'two' } });
        expect(rig.starts).toHaveLength(2);
        // `since` is kept across the edit, and the new attempt's first retry is a second away.
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'start-failed', null, at(8)));
        expect(rig.calls).toEqual(['report x/a']);
      },
    },
    {
      row: 'start resolves, from failed (an edit that works): listening, since now, the problem cleared',
      run: async () => {
        const rig = listenerRig();
        scripted(rig);
        await rig.reconcile({ a: { account: 'bad' } });
        await rig.passTime(7_000);
        await rig.reconcile({ a: { account: 'good' } });
        expect(rig.status()).toEqual(status('listening', '2020-01-01T00:00:07.000Z'));
        expect(rig.problems()).toEqual({});
        expect(rig.calls).toEqual(['report x/a', 'clear x/a']);
      },
    },
    {
      row: 'the configuration is refused, from none: failed configuration-refused with a problem, and nothing started',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: { account: 5 } });
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'configuration-refused'));
        expect(rig.starts).toEqual([]);
        expect(Object.keys(rig.problems())).toEqual(['a']);
        expect(rig.calls).toEqual(['report x/a']);
      },
    },
    {
      row: 'the configuration is refused, from failed start-failed: the code changes, since is kept, one problem',
      run: async () => {
        const rig = listenerRig();
        scripted(rig);
        await rig.reconcile({ a: { account: 'bad' } });
        await rig.passTime(3_000);
        await rig.reconcile({ a: { account: 5 } });
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'configuration-refused'));
        expect(rig.calls).toEqual(['report x/a']);
      },
    },
    {
      row: 'paused, from none: stopped, nothing started, no problem',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: { paused: true } });
        expect(rig.status()).toEqual(status('stopped', ORIGIN));
        expect(rig.starts).toEqual([]);
        expect(rig.calls).toEqual([]);
      },
    },
    {
      row: 'paused, from listening: stopped, the listener aborted and stopped, and its fire answers skipped stopped',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: {} });
        await rig.passTime(2_000);
        await rig.reconcile({ a: { paused: true } });
        expect(rig.status()).toEqual(status('stopped', '2020-01-01T00:00:02.000Z'));
        expect(rig.starts[0]!.signal.aborted).toBe(true);
        expect(rig.stops).toEqual(['stop:']);
        expect(await rig.starts[0]!.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
        expect(rig.requests).toEqual([]);
        expect(rig.starts).toHaveLength(1);
      },
    },
    {
      row: 'paused, from failed: stopped, and the problem is cleared',
      run: async () => {
        const rig = listenerRig();
        scripted(rig);
        await rig.reconcile({ a: { account: 'bad' } });
        await rig.reconcile({ a: { account: 'bad', paused: true } });
        expect(rig.status()).toMatchObject({ state: 'stopped', code: null });
        expect(rig.problems()).toEqual({});
        expect(rig.calls).toEqual(['report x/a', 'clear x/a']);
      },
    },
    {
      row: 'unpaused, from stopped: starts, listening since now',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: { paused: true } });
        await rig.passTime(4_000);
        await rig.reconcile({ a: {} });
        expect(rig.status()).toEqual(status('listening', '2020-01-01T00:00:04.000Z'));
        expect(rig.starts).toHaveLength(1);
      },
    },
    {
      row: 'edited, from stopped: stays stopped with its since, and starts nothing',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: { paused: true } });
        await rig.passTime(4_000);
        await rig.reconcile({ a: { paused: true, account: 'other' } });
        expect(rig.status()).toEqual(status('stopped', ORIGIN));
        expect(rig.starts).toEqual([]);
      },
    },
    {
      row: 'edited, from listening: the old listener is aborted and stopped, a new one starts, and listening keeps its since',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: { account: 'one' } });
        await rig.passTime(4_000);
        await rig.reconcile({ a: { account: 'two' } });
        expect(rig.starts).toHaveLength(2);
        expect(rig.starts[0]!.signal.aborted).toBe(true);
        expect(rig.starts[1]!.signal.aborted).toBe(false);
        expect(rig.stops).toEqual(['stop:one']);
        expect(rig.status()).toEqual(status('listening', ORIGIN));
      },
    },
    {
      row: 'edited, from failed, with the new start still in flight: failed and its problem stay until the attempt settles',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        scripted(rig, release.promise);
        await rig.reconcile({ a: { account: 'bad' } });
        const reconciling = rig.reconcile({ a: { account: 'hold' } });
        await waitUntil(() => rig.starts.length === 2, { message: 'the second start to begin' });
        expect(rig.status()).toMatchObject({ state: 'failed', code: 'start-failed' });
        expect(Object.keys(rig.problems())).toEqual(['a']);
        release.open();
        await reconciling;
        expect(rig.status()).toMatchObject({ state: 'listening' });
        expect(rig.problems()).toEqual({});
      },
    },
    {
      row: 'the file is deleted: the listener is aborted and stopped, and its status is dropped',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: {} });
        await rig.reconcile({});
        expect(rig.status()).toBeUndefined();
        expect(rig.stops).toEqual(['stop:']);
        expect(rig.starts[0]!.signal.aborted).toBe(true);
      },
    },
    {
      row: 'the file is deleted while failed, or paused: the status is dropped and the problem cleared',
      run: async () => {
        const rig = listenerRig();
        scripted(rig);
        await rig.reconcile({ a: { account: 'bad' }, b: { paused: true } });
        await rig.reconcile({});
        expect(rig.status('a')).toBeUndefined();
        expect(rig.status('b')).toBeUndefined();
        expect(rig.problems()).toEqual({});
        expect(rig.calls).toEqual(['report x/a', 'clear x/a']);
      },
    },
    {
      row: 'a workflow in keep (an unreadable file) is left as it is: its listener and status stay',
      run: async () => {
        const rig = listenerRig();
        scripted(rig);
        await rig.reconcile({ a: {}, b: { account: 'bad' }, c: { paused: true } });
        await rig.reconcile({}, new Set(['a', 'b', 'c']));
        expect(rig.status('a')).toMatchObject({ state: 'listening' });
        expect(rig.status('b')).toMatchObject({ state: 'failed' });
        expect(rig.status('c')).toMatchObject({ state: 'stopped' });
        expect(rig.stops).toEqual([]);
        expect(rig.starts[0]!.signal.aborted).toBe(false);
        expect(Object.keys(rig.problems())).toEqual(['b']);
      },
    },
    {
      row: 'a status is kept in memory only: a new supervisor over the same files starts with none',
      run: async () => {
        const first = listenerRig();
        await first.reconcile({ a: {} });
        const second = listenerRig();
        expect(second.status()).toBeUndefined();
        await second.reconcile({ a: {} });
        expect(second.status()).toEqual(status('listening', ORIGIN));
      },
    },
    {
      row: 'a fire that answers started sets lastFiredAt and keeps the state; a duplicate, a skip and a rejection change nothing',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: {} });
        await rig.passTime(9_000);
        const context = rig.starts[0]!;
        for (const answer of [
          { outcome: 'duplicate', runId: 'r0' },
          { outcome: 'skipped', reason: 'paused' },
        ] satisfies PluginTriggerOutcome[]) {
          rig.answer = async () => answer;
          expect(await context.fire({})).toEqual(answer);
          expect(rig.status()).toEqual(status('listening', ORIGIN));
        }
        rig.answer = async () => {
          throw new Error('the payload was refused');
        };
        expect(await rejectionOf(context.fire({}))).toMatchObject({
          message: 'the payload was refused',
        });
        expect(rig.status()).toEqual(status('listening', ORIGIN));
        rig.answer = async () => ({ outcome: 'started', runId: 'run-1' });
        expect(await context.fire({ n: 1 })).toEqual({ outcome: 'started', runId: 'run-1' });
        expect(rig.status()).toEqual(status('listening', ORIGIN, null, '2020-01-01T00:00:09.000Z'));
      },
    },
    {
      row: 'lastFiredAt survives a change of state, and a fire during the first start is written with the first status',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        const answered = gate();
        rig.onStart = async (context) => {
          await context.fire({ early: true });
          answered.open();
          await release.promise;
        };
        const reconciling = rig.reconcile({ a: {} });
        await answered.promise;
        expect(rig.status()).toBeUndefined();
        await rig.passTime(1_000);
        release.open();
        await reconciling;
        expect(rig.status()).toEqual(status('listening', '2020-01-01T00:00:01.000Z', null, ORIGIN));
        await rig.passTime(1_000);
        await rig.reconcile({ a: { paused: true } });
        expect(rig.status()).toEqual(status('stopped', '2020-01-01T00:00:02.000Z', null, ORIGIN));
      },
    },
    {
      row: 'a start that resolves after its listener was replaced is stopped, and writes no status and no problem',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        scripted(rig, release.promise);
        const first = rig.reconcileDirect({ a: { account: 'hold' } });
        await waitUntil(() => rig.starts.length === 1, { message: 'the start to begin' });
        // The runtime never overlaps two reconciles; the fence holds even if they did.
        const second = rig.reconcileDirect({ a: { paused: true } });
        release.open();
        await first;
        await second;
        expect(rig.status()).toEqual(status('stopped', ORIGIN));
        expect(rig.stops).toEqual(['stop:hold']);
        expect(rig.calls).toEqual([]);
      },
    },
    {
      row: 'a start that throws after its listener was stopped is diagnosed only: no status, no problem',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        rig.onStart = async () => {
          await release.promise;
          boom();
        };
        const first = rig.reconcileDirect({ a: { account: 'late' } });
        await waitUntil(() => rig.starts.length === 1, { message: 'the start to begin' });
        const second = rig.reconcileDirect({}, new Set());
        release.open();
        await first;
        await second;
        expect(rig.status()).toBeUndefined();
        expect(rig.calls).toEqual([]);
        expect(rig.diagnosed).toHaveLength(1);
      },
    },
    {
      row: 'a start that throws after close writes no status and no problem',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        rig.onStart = async () => {
          await release.promise;
          boom();
        };
        const reconciling = rig.reconcile({ a: {} });
        await waitUntil(() => rig.starts.length === 1, { message: 'the start to begin' });
        const closing = rig.supervisor.close();
        release.open();
        await reconciling;
        await closing;
        expect(rig.calls).toEqual([]);
      },
    },
    {
      row: 'a start that hangs records nothing while it is pending, and a changed file aborts it',
      run: async () => {
        const rig = listenerRig();
        const never = gate();
        scripted(rig, never.promise);
        const first = rig.reconcileDirect({ a: { account: 'hold' } });
        await waitUntil(() => rig.starts.length === 1, { message: 'the start to begin' });
        await quietFor(10);
        expect(rig.status()).toBeUndefined();
        const second = rig.reconcileDirect({ a: { paused: true } });
        expect(rig.starts[0]!.signal.aborted).toBe(true);
        never.open();
        await first;
        await second;
        expect(rig.status()).toMatchObject({ state: 'stopped' });
      },
    },
    {
      row: 'a trigger whose storage cannot be made is failed start-failed with a problem',
      run: async () => {
        const rig = listenerRig();
        const kind: VersionedCatalogEntry<PluginTrigger> = {
          kind: 'trigger',
          name: 'Bad_Plugin:watch',
          version: '1',
          id: 'Bad_Plugin:watch@1',
          source: { name: 'Bad_Plugin', version: '1' },
          value: baseKind(rig),
        };
        await rig.supervisor.reconcile(
          new Map([['a', { kind, trigger: { kind: kind.name } }]]),
          new Set(),
        );
        expect(rig.supervisor.listener('a', 'Bad_Plugin:watch')).toEqual(
          status('failed', ORIGIN, 'start-failed', null, at(1)),
        );
        expect(rig.calls).toEqual(['report Bad_Plugin/a']);
        expect(rig.starts).toEqual([]);
      },
    },
    {
      row: 'secret missing when the gated start runs, from none: waiting-for-secret, the inner start not called, no problem',
      run: async () => {
        const { rig } = await gatedRig('missing');
        await rig.reconcile({ a: {} });
        expect(rig.status()).toEqual(status('waiting-for-secret', ORIGIN));
        expect(rig.starts).toEqual([]);
        expect(rig.calls).toEqual([]);
      },
    },
    {
      row: 'secret missing, from failed (an edit onto a gated kind): waiting-for-secret, the problem cleared',
      run: async () => {
        const { rig } = await gatedRig('missing');
        await rig.reconcile({ a: { account: 5 } });
        expect(rig.status()).toMatchObject({ state: 'failed', code: 'configuration-refused' });
        await rig.reconcile({ a: {} });
        expect(rig.status()).toMatchObject({ state: 'waiting-for-secret', code: null });
        expect(rig.problems()).toEqual({});
      },
    },
    {
      row: 'secret present at the first start: listening, from the gate’s report, with the inner listener started once',
      run: async () => {
        const { rig } = await gatedRig('set');
        await rig.reconcile({ a: {} });
        expect(rig.status()).toEqual(status('listening', ORIGIN));
        expect(rig.starts).toHaveLength(1);
      },
    },
    {
      row: 'the secret is set, from waiting-for-secret: listening since now, and the inner listener has its own signal, never the outer one',
      run: async () => {
        const { rig, secrets } = await gatedRig('missing');
        await rig.reconcile({ a: {} });
        await rig.passTime(3_000);
        secrets.save();
        await inState(rig, 'listening');
        expect(rig.status()).toEqual(status('listening', '2020-01-01T00:00:03.000Z'));
        expect(rig.starts).toHaveLength(1);
        expect(rig.starts[0]!.signal.aborted).toBe(false);
      },
    },
    {
      row: 'the secret is removed while listening: waiting-for-secret, the inner signal aborted, the inner listener stopped, and its fire answers skipped stopped and starts nothing',
      run: async () => {
        const { rig, secrets } = await gatedRig('set');
        await rig.reconcile({ a: {} });
        await rig.passTime(3_000);
        secrets.remove();
        await inState(rig, 'waiting-for-secret');
        expect(rig.status()).toEqual(status('waiting-for-secret', '2020-01-01T00:00:03.000Z'));
        const inner = rig.starts[0]!;
        expect(inner.signal.aborted).toBe(true);
        expect(rig.stops).toEqual(['stop:']);
        expect(await inner.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
        expect(rig.requests).toEqual([]);
      },
    },
    {
      row: 'the secret is saved again after a removal: the inner listener starts again with a signal that is not aborted',
      run: async () => {
        const { rig, secrets } = await gatedRig('set');
        await rig.reconcile({ a: {} });
        secrets.remove();
        await inState(rig, 'waiting-for-secret');
        secrets.save();
        await inState(rig, 'listening');
        await waitUntil(() => rig.starts.length === 2, { message: 'the second inner start' });
        expect(rig.starts[1]!.signal.aborted).toBe(false);
        expect(await rig.starts[1]!.fire({})).toEqual({ outcome: 'started', runId: 'run-1' });
      },
    },
    {
      row: 'after a removal the outer context is the supervisor’s, whose signal the gate never aborts: a restart still runs',
      run: async () => {
        const { rig, secrets } = await gatedRig('set');
        await rig.reconcile({ a: {} });
        secrets.remove();
        await inState(rig, 'waiting-for-secret');
        secrets.save();
        await waitUntil(() => rig.starts.length === 2, { message: 'the restart' });
        // A fire from the new inner listener reaches the host: nothing fenced the outer listener.
        expect(await rig.starts[1]!.fire({})).toMatchObject({ outcome: 'started' });
      },
    },
    {
      row: 'an inner start that throws after the secret is saved again is reported: failed start-failed with a problem, the outer stopped, and the gate follows the secret no more',
      run: async () => {
        const { rig, secrets } = await gatedRig('missing');
        await rig.reconcile({ a: {} });
        rig.onStart = () => boom();
        secrets.save();
        await inState(rig, 'failed');
        expect(rig.status()).toMatchObject({ state: 'failed', code: 'start-failed' });
        expect(rig.calls).toEqual(['report x/a']);
        expect(rig.problems()['a']).toContain('the source refused the token');
        // The supervisor aborted the failed attempt, and the gate stopped following the secret.
        expect(rig.starts).toHaveLength(1);
        expect(rig.starts[0]!.signal.aborted).toBe(true);
        rig.onStart = ready;
        secrets.remove();
        secrets.save();
        await quietFor(25);
        expect(rig.starts).toHaveLength(1);
        expect(rig.status()).toMatchObject({ state: 'failed' });
      },
    },
    {
      row: 'the gate’s first transition throws: handled once as a throwing start, with one problem and no second report',
      run: async () => {
        const { rig } = await gatedRig('set');
        rig.onStart = () => boom();
        await rig.reconcile({ a: {} });
        expect(rig.status()).toMatchObject({ state: 'failed', code: 'start-failed' });
        expect(rig.calls).toEqual(['report x/a']);
      },
    },
    {
      row: 'the inner stop throws on removal: swallowed, and the state is waiting-for-secret',
      run: async () => {
        const { rig, secrets } = await gatedRig('set');
        await rig.reconcile({ a: {} });
        rig.onStop = () => {
          throw new Error('the inner stop failed');
        };
        secrets.remove();
        await inState(rig, 'waiting-for-secret');
        expect(rig.calls).toEqual([]);
      },
    },
    {
      row: 'the secret is removed while the inner start is in flight: the next transition stops and aborts the started listener, then reports waiting',
      run: async () => {
        const { rig, secrets } = await gatedRig('missing');
        await rig.reconcile({ a: {} });
        const release = gate();
        rig.onStart = async () => {
          await release.promise;
        };
        secrets.save();
        await waitUntil(() => rig.starts.length === 1, { message: 'the inner start' });
        secrets.remove();
        release.open();
        await waitUntil(() => rig.stops.length === 1, { message: 'the inner stop' });
        await inState(rig, 'waiting-for-secret');
        expect(rig.starts[0]!.signal.aborted).toBe(true);
      },
    },
    {
      row: 'the outer stop of a listening gated trigger stops the inner listener and writes no waiting-for-secret over stopped',
      run: async () => {
        const { rig } = await gatedRig('set');
        await rig.reconcile({ a: {} });
        await rig.reconcile({ a: { paused: true } });
        expect(rig.status()).toMatchObject({ state: 'stopped' });
        expect(rig.stops).toEqual(['stop:']);
        expect(rig.starts[0]!.signal.aborted).toBe(true);
        await quietFor(25);
        expect(rig.status()).toMatchObject({ state: 'stopped' });
      },
    },
    {
      row: 'a gated trigger that is deleted while listening has its status dropped, and a later secret change writes none',
      run: async () => {
        const { rig, secrets } = await gatedRig('set');
        await rig.reconcile({ a: {} });
        await rig.reconcile({});
        secrets.remove();
        secrets.save();
        await quietFor(25);
        expect(rig.status()).toBeUndefined();
      },
    },
    {
      row: 'a gated trigger fires through the gate while listening: the host answers started and lastFiredAt is set',
      run: async () => {
        const { rig } = await gatedRig('set');
        await rig.reconcile({ a: {} });
        await rig.passTime(2_000);
        expect(await rig.starts[0]!.fire({})).toMatchObject({ outcome: 'started' });
        expect(rig.status()).toEqual(status('listening', ORIGIN, null, '2020-01-01T00:00:02.000Z'));
      },
    },
    {
      row: 'a gated listener answers skipped closed, not stopped, after close',
      run: async () => {
        const { rig } = await gatedRig('set');
        await rig.reconcile({ a: {} });
        await rig.supervisor.close();
        expect(await rig.starts[0]!.fire({})).toEqual({ outcome: 'skipped', reason: 'closed' });
      },
    },
  ];

  /** How many starts of the account `account` the rig's kind has begun. */
  const startsOf = (rig: ListenerRig, account: string): number =>
    rig.starts.filter(
      (context) => (context.configuration as { account?: string }).account === account,
    ).length;

  /** `onStart` for the rows that hold one account, and fail another. */
  function holdingAndFailing(rig: ListenerRig, release: Promise<void>): void {
    rig.onStart = async (context) => {
      const account = (context.configuration as { account?: string }).account;
      if (account === 'bad') boom();
      if (account === 'hold') await release;
    };
  }

  /** The delay, in milliseconds, between now and the `retryAt` of workflow `a`'s listener. */
  const delayOf = (rig: ListenerRig): number =>
    Date.parse((rig.status() as ListenerStatus).retryAt!) - Date.parse(rig.services.clock.nowISO());

  const retryRows: readonly ListenerRow[] = [
    {
      row: 'start throws, from none: failed with retryAt one second on, one timer, and no attempt before it is due',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: {} });
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'start-failed', null, at(1)));
        expect(rig.pendingTimers()).toHaveLength(1);
        await rig.advance(999);
        expect(rig.starts).toHaveLength(1);
        await rig.advance(1);
        expect(rig.starts).toHaveLength(2);
      },
    },
    {
      row: 'failures in a row wait 1, 2, 4 seconds and on to a 300 second cap that never grows, with since kept and one problem',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: {} });
        const delays: number[] = [];
        for (let failure = 0; failure < 11; failure += 1) {
          const wait = delayOf(rig);
          delays.push(wait);
          await rig.advance(wait);
        }
        expect(delays).toEqual([
          1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
        ]);
        expect(rig.starts).toHaveLength(12);
        expect(rig.status()).toMatchObject({ state: 'failed', since: ORIGIN });
        expect(rig.calls).toEqual(['report x/a']);
        expect(rig.pendingTimers()).toHaveLength(1);
      },
    },
    {
      row: 'a retry that works: listening since now, the problem cleared, and no timer left',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = (_context, count) => {
          if (count < 3) boom();
        };
        await rig.reconcile({ a: {} });
        await rig.advance(1_000);
        await rig.advance(2_000);
        expect(rig.status()).toEqual(status('listening', at(3)));
        expect(rig.pendingTimers()).toHaveLength(0);
        expect(rig.problems()).toEqual({});
        expect(rig.calls).toEqual(['report x/a', 'clear x/a']);
      },
    },
    {
      row: 'the delay after a success is one second again: a listener that fails after listening starts its backoff over',
      run: async () => {
        const { rig, secrets } = await gatedRig('set');
        rig.onStart = (_context, count) => {
          if (count < 4) boom();
        };
        await rig.reconcile({ a: {} });
        await rig.advance(1_000);
        await rig.advance(2_000);
        await rig.advance(4_000);
        expect(rig.status()).toEqual(status('listening', at(7)));
        // The plugin's own start fails after the secret is saved again: reported at the first rung.
        rig.onStart = boom;
        secrets.remove();
        await inState(rig, 'waiting-for-secret');
        secrets.save();
        await inState(rig, 'failed');
        expect(rig.status()).toEqual(status('failed', at(7), 'start-failed', null, at(8)));
      },
    },
    {
      row: 'a start that reached waiting-for-secret resets the backoff, and a timer’s attempt that finds the secret missing arms nothing',
      run: async () => {
        const { rig, secrets } = await gatedRig('set');
        rig.onStart = boom;
        await rig.reconcile({ a: {} });
        await rig.advance(1_000);
        secrets.remove();
        await rig.advance(2_000);
        expect(rig.status()).toEqual(status('waiting-for-secret', at(3)));
        expect(rig.pendingTimers()).toHaveLength(0);
        expect(rig.problems()).toEqual({});
        secrets.save();
        await inState(rig, 'failed');
        expect(rig.status()).toMatchObject({ state: 'failed', retryAt: at(4) });
      },
    },
    {
      row: 'the configuration is refused: failed with no retryAt and no timer, and never retried',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: { account: 5 } });
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'configuration-refused'));
        expect(rig.pendingTimers()).toEqual([]);
        await rig.advance(3_600_000);
        expect(rig.starts).toEqual([]);
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'configuration-refused'));
      },
    },
    {
      row: 'an edit during the backoff cancels the timer, attempts at once, and starts the backoff over',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: { account: 'one' } });
        await rig.advance(1_000);
        await rig.advance(2_000);
        expect(delayOf(rig)).toBe(4_000);
        await rig.reconcile({ a: { account: 'two' } });
        expect(startsOf(rig, 'two')).toBe(1);
        expect(rig.pendingTimers()).toHaveLength(1);
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'start-failed', null, at(4)));
        await rig.advance(1_000);
        expect(startsOf(rig, 'two')).toBe(2);
        expect(delayOf(rig)).toBe(2_000);
      },
    },
    {
      row: 'a pause during the backoff cancels the timer, clears the problem, and nothing starts when the time passes',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: {} });
        await rig.reconcile({ a: { paused: true } });
        expect(rig.status()).toEqual(status('stopped', ORIGIN));
        expect(rig.pendingTimers()).toEqual([]);
        expect(rig.problems()).toEqual({});
        await rig.advance(3_600_000);
        expect(rig.starts).toHaveLength(1);
      },
    },
    {
      row: 'a deleted file during the backoff cancels the timer, drops the status, and clears the problem',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: {}, b: {} });
        await rig.reconcile({ b: {} });
        expect(rig.status('a')).toBeUndefined();
        expect(rig.pendingTimers()).toHaveLength(1);
        expect(Object.keys(rig.problems())).toEqual(['b']);
        await rig.advance(1_000);
        // `a`'s listener, `b`'s, and `b`'s retry: nothing retried `a`.
        expect(rig.starts).toHaveLength(3);
      },
    },
    {
      row: 'a reconcile of the same file during the backoff leaves the timer and the status, and makes no attempt',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: {} });
        const timers = rig.pendingTimers();
        expect(timers).toHaveLength(1);
        await rig.reconcile({ a: {} });
        expect(rig.pendingTimers()).toEqual(timers);
        expect(rig.starts).toHaveLength(1);
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'start-failed', null, at(1)));
      },
    },
    {
      row: 'a workflow in keep keeps its timer: an unreadable file is left as it is',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: {} });
        await rig.reconcile({}, new Set(['a']));
        expect(rig.pendingTimers()).toHaveLength(1);
        await rig.advance(1_000);
        expect(rig.starts).toHaveLength(2);
      },
    },
    {
      row: 'closing cancels every pending retry, and the timers that fire after it start nothing',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: {}, b: {} });
        expect(rig.pendingTimers()).toHaveLength(2);
        await rig.supervisor.close();
        expect(rig.pendingTimers()).toEqual([]);
        for (const callback of rig.timerCallbacks) callback();
        await rig.advance(3_600_000);
        expect(rig.starts).toHaveLength(2);
      },
    },
    {
      row: 'a timer that fires after its entry was replaced, paused or removed starts nothing',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({
          a: { account: 'one' },
          b: { account: 'one' },
          c: { account: 'one' },
        });
        const callbacks = [...rig.timerCallbacks];
        expect(callbacks).toHaveLength(3);
        rig.onStart = ready;
        await rig.reconcile({ a: { account: 'two' }, b: { paused: true }, c: {} });
        await rig.reconcile({ a: { account: 'two' }, b: { paused: true } });
        const before = rig.starts.length;
        for (const callback of callbacks) callback();
        await rig.settled();
        expect(rig.starts).toHaveLength(before);
        expect(rig.status('a')).toMatchObject({ state: 'listening' });
        expect(rig.status('b')).toMatchObject({ state: 'stopped' });
      },
    },
    {
      row: 'the timer’s attempt queues behind a reconcile in progress, and runs when it is over',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        holdingAndFailing(rig, release.promise);
        const reconciling = rig.reconcile({ a: { account: 'bad' }, b: { account: 'hold' } });
        await waitUntil(() => startsOf(rig, 'hold') === 1, { message: 'the held start' });
        await rig.services.advance(1_000);
        await quietFor(25);
        expect(startsOf(rig, 'bad')).toBe(1);
        release.open();
        await reconciling;
        await rig.settled();
        expect(startsOf(rig, 'bad')).toBe(2);
      },
    },
    {
      row: 'a retry attempt in flight keeps failed with retryAt null, and arms no timer while it is pending',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        rig.onStart = async (_context, count) => {
          if (count === 1) boom();
          if (count === 2) await release.promise;
        };
        await rig.reconcile({ a: {} });
        await rig.services.advance(1_000);
        await waitUntil(() => rig.starts.length === 2, { message: 'the retry attempt' });
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'start-failed'));
        expect(rig.pendingTimers()).toEqual([]);
        release.open();
        await rig.settled();
        expect(rig.status()).toEqual(status('listening', at(1)));
        expect(rig.problems()).toEqual({});
      },
    },
    {
      row: 'closing while a retry attempt is in flight stops it when it settles, and writes no status, problem or timer',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        rig.onStart = async (_context, count) => {
          if (count === 1) boom();
          if (count === 2) await release.promise;
        };
        await rig.reconcile({ a: {} });
        await rig.services.advance(1_000);
        await waitUntil(() => rig.starts.length === 2, { message: 'the retry attempt' });
        const closing = rig.supervisor.close();
        release.open();
        await closing;
        await rig.settled();
        expect(rig.stops).toEqual(['stop:']);
        expect(rig.pendingTimers()).toEqual([]);
        expect(rig.status()).toMatchObject({ state: 'failed', retryAt: null });
        expect(rig.calls).toEqual(['report x/a']);
      },
    },
    {
      row: 'a retry attempt that throws after close arms no timer',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        rig.onStart = async (_context, count) => {
          if (count >= 2) await release.promise;
          boom();
        };
        await rig.reconcile({ a: {} });
        await rig.services.advance(1_000);
        await waitUntil(() => rig.starts.length === 2, { message: 'the retry attempt' });
        const closing = rig.supervisor.close();
        release.open();
        await closing;
        await rig.settled();
        expect(rig.pendingTimers()).toEqual([]);
      },
    },
    {
      row: 'a storage failure is a throwing start: failed, one problem, and retried with the backoff',
      run: async () => {
        const rig = listenerRig();
        const kind: VersionedCatalogEntry<PluginTrigger> = {
          kind: 'trigger',
          name: 'Bad_Plugin:watch',
          version: '1',
          id: 'Bad_Plugin:watch@1',
          source: { name: 'Bad_Plugin', version: '1' },
          value: baseKind(rig),
        };
        await rig.supervisor.reconcile(
          new Map([['a', { kind, trigger: { kind: kind.name } }]]),
          new Set(),
        );
        expect(rig.supervisor.listener('a', 'Bad_Plugin:watch')).toEqual(
          status('failed', ORIGIN, 'start-failed', null, at(1)),
        );
        await rig.advance(1_000);
        expect(rig.supervisor.listener('a', 'Bad_Plugin:watch')).toEqual(
          status('failed', ORIGIN, 'start-failed', null, at(3)),
        );
        expect(rig.diagnosed.filter((message) => message.includes('its storage'))).toHaveLength(2);
        expect(rig.calls).toEqual(['report Bad_Plugin/a']);
        expect(rig.starts).toEqual([]);
      },
    },
    {
      row: 'a gate-reported failure arms one timer, the secret saved during the backoff makes no attempt, and the timer’s attempt finds it set',
      run: async () => {
        const { rig, secrets } = await gatedRig('missing');
        await rig.reconcile({ a: {} });
        rig.onStart = boom;
        secrets.save();
        await inState(rig, 'failed');
        expect(rig.pendingTimers()).toHaveLength(1);
        expect(rig.status()).toMatchObject({ retryAt: at(1) });
        rig.onStart = ready;
        secrets.remove();
        secrets.save();
        await quietFor(25);
        expect(rig.starts).toHaveLength(1);
        expect(rig.pendingTimers()).toHaveLength(1);
        await rig.advance(1_000);
        expect(rig.status()).toMatchObject({ state: 'listening', retryAt: null });
        expect(rig.starts).toHaveLength(2);
        expect(rig.problems()).toEqual({});
      },
    },
    {
      row: 'triggers.retry, during the backoff: starts at once, cancels the timer, and clears the backoff',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = (_context, count) => {
          if (count < 4) boom();
        };
        await rig.reconcile({ a: {} });
        await rig.advance(1_000);
        expect(delayOf(rig)).toBe(2_000);
        const answered = await rig.retry();
        expect(rig.starts).toHaveLength(3);
        expect(answered).toEqual(status('failed', ORIGIN, 'start-failed', null, at(2)));
        expect(rig.pendingTimers()).toHaveLength(1);
        await rig.advance(1_000);
        expect(rig.status()).toEqual(status('listening', at(2)));
        expect(rig.pendingTimers()).toEqual([]);
      },
    },
    {
      row: 'triggers.retry that works: listening since now, the problem cleared, no timer',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = (_context, count) => {
          if (count === 1) boom();
        };
        await rig.reconcile({ a: {} });
        await rig.passTime(500);
        expect(await rig.retry()).toEqual(status('listening', at(0.5)));
        expect(rig.pendingTimers()).toEqual([]);
        expect(rig.problems()).toEqual({});
        expect(rig.calls).toEqual(['report x/a', 'clear x/a']);
      },
    },
    {
      row: 'triggers.retry while the first attempt is in flight answers its result, with no second start',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        rig.onStart = async () => {
          await release.promise;
        };
        const reconciling = rig.reconcile({ a: {} });
        await waitUntil(() => rig.starts.length === 1, { message: 'the first start' });
        expect(rig.pendingTimers()).toEqual([]);
        const answered = rig.retry();
        release.open();
        expect(await answered).toEqual(status('listening', ORIGIN));
        await reconciling;
        expect(rig.starts).toHaveLength(1);
      },
    },
    {
      row: 'triggers.retry while a timer’s attempt is queued behind a reconcile shares that attempt: no second start',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        holdingAndFailing(rig, release.promise);
        const reconciling = rig.reconcile({ a: { account: 'bad' }, b: { account: 'hold' } });
        await waitUntil(() => startsOf(rig, 'hold') === 1, { message: 'the held start' });
        await rig.services.advance(1_000);
        const answered = rig.retry();
        release.open();
        await reconciling;
        expect(await answered).toMatchObject({ state: 'failed', code: 'start-failed' });
        expect(startsOf(rig, 'bad')).toBe(2);
      },
    },
    {
      row: 'triggers.retry runs under the serialization lock: it waits for a reconcile in progress',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        holdingAndFailing(rig, release.promise);
        const reconciling = rig.reconcile({ a: { account: 'bad' }, b: { account: 'hold' } });
        await waitUntil(() => startsOf(rig, 'hold') === 1, { message: 'the held start' });
        const answered = rig.retry();
        await quietFor(25);
        expect(startsOf(rig, 'bad')).toBe(1);
        release.open();
        await reconciling;
        expect(await answered).toMatchObject({ state: 'failed' });
        expect(startsOf(rig, 'bad')).toBe(2);
        expect(rig.pendingTimers()).toHaveLength(1);
      },
    },
    {
      row: 'triggers.retry while listening, waiting-for-secret or stopped is a no-op that answers the current state',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: {}, b: { paused: true } });
        await rig.passTime(5_000);
        expect(await rig.retry('a')).toEqual(status('listening', ORIGIN));
        expect(await rig.retry('b')).toEqual(status('stopped', ORIGIN));
        expect(rig.starts).toHaveLength(1);
        const { rig: gated } = await gatedRig('missing');
        await gated.reconcile({ a: {} });
        await gated.passTime(5_000);
        expect(await gated.retry()).toEqual(status('waiting-for-secret', ORIGIN));
        expect(gated.starts).toEqual([]);
      },
    },
    {
      row: 'triggers.retry of a refused configuration parses it again, stays failed with its since, and arms no timer',
      run: async () => {
        const rig = listenerRig();
        await rig.reconcile({ a: { account: 5 } });
        await rig.passTime(2_000);
        expect(await rig.retry()).toEqual(status('failed', ORIGIN, 'configuration-refused'));
        expect(rig.pendingTimers()).toEqual([]);
        expect(rig.starts).toEqual([]);
        expect(rig.calls).toEqual(['report x/a']);
      },
    },
    {
      row: 'triggers.retry of a workflow with no listener answers undefined',
      run: async () => {
        const rig = listenerRig();
        expect(await rig.retry('missing')).toBeUndefined();
        await rig.reconcile({ a: {} });
        await rig.reconcile({});
        expect(await rig.retry('a')).toBeUndefined();
      },
    },
    {
      row: 'triggers.retry attempt that settles after close is stopped, and writes no status, problem or timer',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        rig.onStart = async (_context, count) => {
          if (count === 1) boom();
          if (count === 2) {
            await release.promise;
            boom();
          }
        };
        await rig.reconcile({ a: {} });
        const retrying = rig.retry();
        await waitUntil(() => rig.starts.length === 2, { message: 'the manual attempt' });
        const closing = rig.supervisor.close();
        release.open();
        await closing;
        await retrying;
        expect(rig.pendingTimers()).toEqual([]);
        expect(rig.calls).toEqual(['report x/a']);
      },
    },
    {
      row: 'a process restart starts the backoff over: a new supervisor attempts at once and waits one second',
      run: async () => {
        const first = listenerRig();
        first.onStart = boom;
        await first.reconcile({ a: {} });
        await first.advance(1_000);
        expect(delayOf(first)).toBe(2_000);
        const second = listenerRig();
        second.onStart = boom;
        await second.reconcile({ a: {} });
        expect(second.starts).toHaveLength(1);
        expect(second.status()).toEqual(status('failed', ORIGIN, 'start-failed', null, at(1)));
      },
    },
  ];

  /** Rows for an attempt in flight while a retry timer was armed (COR-2166, review round 1). */
  const inFlightRows: readonly ListenerRow[] = [
    {
      row: 'triggers.retry, while failed with a timer armed and the new start pending: retryAt is null and no timer is armed, and a start that never settles keeps it null',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        rig.onStart = async (_context, count) => {
          if (count === 1) boom();
          if (count === 2) await release.promise;
        };
        await rig.reconcile({ a: {} });
        expect(rig.status()).toMatchObject({ state: 'failed', retryAt: at(1) });
        expect(rig.pendingTimers()).toHaveLength(1);
        const retrying = rig.retry();
        await waitUntil(() => rig.starts.length === 2, { message: 'the manual attempt' });
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'start-failed'));
        expect(rig.pendingTimers()).toEqual([]);
        // The start never settles: nothing re-arms a timer, however long it takes.
        await rig.services.advance(3_600_000);
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'start-failed'));
        expect(rig.pendingTimers()).toEqual([]);
        release.open();
        await retrying;
        expect(rig.status()).toMatchObject({ state: 'listening', retryAt: null });
      },
    },
    {
      row: 'an edit, while failed with a timer armed and the new start pending: retryAt is null and no timer is armed',
      run: async () => {
        const rig = listenerRig();
        const release = gate();
        rig.onStart = async (context) => {
          const account = (context.configuration as { account?: string }).account;
          if (account === 'one') boom();
          await release.promise;
        };
        await rig.reconcile({ a: { account: 'one' } });
        expect(rig.status()).toMatchObject({ state: 'failed', retryAt: at(1) });
        const editing = rig.reconcile({ a: { account: 'two' } });
        await waitUntil(() => startsOf(rig, 'two') === 1, { message: 'the edited start' });
        expect(rig.status()).toEqual(status('failed', ORIGIN, 'start-failed'));
        expect(rig.pendingTimers()).toEqual([]);
        release.open();
        await editing;
        expect(rig.status()).toMatchObject({ state: 'listening', retryAt: null });
      },
    },
    {
      row: 'a pause, while failed with a timer armed: stopped with no retryAt and no timer',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: {} });
        expect(rig.status()).toMatchObject({ retryAt: at(1) });
        await rig.reconcile({ a: { paused: true } });
        expect(rig.status()).toEqual(status('stopped', ORIGIN));
        expect(rig.pendingTimers()).toEqual([]);
      },
    },
    {
      row: 'a removal and a close, while failed with a timer armed, leave no retryAt behind',
      run: async () => {
        const rig = listenerRig();
        rig.onStart = boom;
        await rig.reconcile({ a: {}, b: {} });
        await rig.reconcile({ b: {} });
        expect(rig.status('a')).toBeUndefined();
        await rig.supervisor.close();
        expect(rig.status('b')).toMatchObject({ state: 'failed', retryAt: null });
        expect(rig.pendingTimers()).toEqual([]);
      },
    },
  ];

  for (const { row, run } of [...rows, ...retryRows, ...inFlightRows]) {
    it(row, async () => {
      rigsOfTheRow.length = 0;
      await run();
      for (const rig of rigsOfTheRow) expectRetryAtToMatchTheTimers(rig);
    });
  }
});
