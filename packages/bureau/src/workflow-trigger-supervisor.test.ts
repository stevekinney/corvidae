/**
 * COR-1874 — the supervisor that keeps the contributed triggers equal to the workflow files'. It
 * never starts a trigger once it is closed, however far into a reconcile the close lands.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
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
      row: 'a lookup that throws rejects and starts nothing; a start that throws leaves the key free (unchanged)',
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
