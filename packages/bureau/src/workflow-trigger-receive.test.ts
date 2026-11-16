/**
 * COR-2168 — a contributed trigger kind that defines `receive`, called through
 * `BureauWorkflows.receiveTrigger(id, request)`. Every test is a row of the outcome matrix of
 * COR-2168 (`tmp/chef/briefs/COR-2168-matrix.md`), titled `M<row>` with the row's position in that
 * table, and every Open recommendation O1 to O8 is a requirement of the batch. The rows that need
 * no runtime sit beside their subject: M1 and M2 in `workflow-contributions.test.ts`, M3 and M4 in
 * `plugins/plugin-secret-gate.test.ts`, M5 to M9 and M13 in the listener rows of
 * `workflow-trigger-supervisor.test.ts`, M12 in `http/management/workflows-operations.test.ts`.
 *
 * Not driven: M46 (two Bureaus over one storage may both start a run: a race the tests cannot
 * order; `fireTrigger` documents it), and M52 and M53 (the lease and `standby` of COR-2167, which
 * is not on this branch). M54 and M57 are the host route's (COR-2169): the cap and the status a
 * rejection maps to are in `applications/interborough/src/host/trigger-routes.test.ts`, and
 * through a real host in `host-a2a-authorization.test.ts`.
 *
 * After every row the published invariant of COR-2166 is read again: a listener's `retryAt` is
 * non-null exactly while a retry timer is armed.
 */
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  definePlugin,
  type PluginTrigger,
  type PluginTriggerContext,
} from '@lostgradient/interborough-plugin';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { Engine, workflow } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  createPluginSecretGate,
  gatedContributions,
  PluginNeedsSetupError,
} from './plugins/plugin-secret-gate';
import type { BureauPluginSecrets } from './plugins/plugin-types';
import { workflowFileDirectory } from './sources/workflow-file-directory';
import { listedPlugins } from './testing/plugin-listing.test-support';
import { contributionCatalog } from './testing/workflow-contributions.test-support';
import { startWorkflowBureau } from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import type { VersionedCatalogEntry } from './versioned-catalog';
import { createWorkflowContributions, type WorkflowContributions } from './workflow-contributions';
import { createWorkflowDocumentHost } from './workflow-host';
import { WorkflowInputInvalidError } from './workflow-schema';
import {
  createWorkflowRuntime,
  WorkflowApplyError,
  type WorkflowRuntime,
} from './workflow-runtime';
import { createWorkflowSnapshotStore } from './workflow-snapshot-store';
import { triggerStatePrefix } from './workflow-trigger-state';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const ORIGIN = '2026-11-16T00:00:00.000Z';
const SECRET_KEY = 'x-token';

/** What the three kinds of the rig do, and what they saw. */
interface Control {
  /** Every call of a `receive`, in order. */
  readonly receives: Array<{
    readonly kind: string;
    readonly request: Request;
    readonly context: PluginTriggerContext;
  }>;
  /** Every `start`, in order. */
  readonly starts: Array<{ readonly kind: string; readonly context: PluginTriggerContext }>;
  /** What a `receive` does; the default answers 202. */
  receive: (
    kind: string,
    request: Request,
    context: PluginTriggerContext,
  ) => Promise<Response> | Response;
  /** What a `start` does; the default resolves. */
  start: (kind: string, context: PluginTriggerContext) => Promise<void> | void;
  /** While set, the configuration of `x:hook` is refused. */
  refuse: boolean;
}

function createControl(): Control {
  return {
    receives: [],
    starts: [],
    receive: () => new Response('received', { status: 202 }),
    start: () => undefined,
    refuse: false,
  };
}

interface Rig {
  readonly engine: Engine;
  readonly runtime: WorkflowRuntime;
  readonly services: ReturnType<typeof createManualRuntimeServices>;
  readonly control: Control;
  readonly contributions: WorkflowContributions;
  readonly triggerStorage: MemoryStorage;
  readonly diagnostics: string[];
  /** What the plugin registry would have been told: `plugin/workflow: message`. */
  readonly failures: string[];
  put(id: string, overrides?: Record<string, unknown>): Promise<void>;
  remove(id: string): Promise<void>;
  /** Rescan the files and wait for the apply it queues. */
  apply(): Promise<void>;
  receive(id: string, request?: Request): Promise<Response>;
  listener(id?: string): ReturnType<WorkflowRuntime['workflows']['list']>[number]['listener'];
  runIds(id?: string): Promise<string[]>;
  /** What the engine's run `runId` was started with. */
  triggerOf(runId: string): Promise<{ kind: string; version: string } | undefined>;
  close(): Promise<void>;
}

interface BootOptions {
  /** A gate the three kinds are wrapped with, as a plugin that declares a secret has. */
  readonly gate?: Parameters<typeof gatedContributions>[1];
  readonly payloadMaximumBytes?: number;
}

/** A file whose trigger is the kind `kind`; `overrides` change what is in it. */
const hooking = (kind = 'x:hook', channel = 'a', overrides: Record<string, unknown> = {}) => ({
  trigger: { kind, channel },
  steps: [{ kind: 'activity', handler: 'x:y', input: 'hello' }],
  ...overrides,
});

const post = (body = '{}', url = 'https://hooks.example.test/triggers/hook'): Request =>
  new Request(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } });

/** A response with no body and no free text: what Bureau itself answers. */
function expectEmpty(response: Response, status: number): void {
  expect(response.status).toBe(status);
  expect(response.body).toBeNull();
  expect(response.statusText).toBe('');
}

async function boot(options: BootOptions = {}): Promise<Rig> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-trigger-receive-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const control = createControl();
  const catalog = contributionCatalog({ activityVersion: '1' });
  const wrap = (trigger: PluginTrigger): PluginTrigger =>
    options.gate === undefined
      ? trigger
      : gatedContributions(
          { triggers: [trigger] },
          options.gate,
          (name) => `x:${name}`,
          () => undefined,
        ).triggers[0]!;
  const configuration = z.object({ channel: z.string() }).strict();
  const register = (name: string, value: PluginTrigger): void => {
    catalog.register({
      kind: 'trigger',
      name: `x:${name}`,
      version: '1',
      value: wrap(value),
      source: { name: 'x', version: '1' },
    });
  };
  register('hook', {
    name: 'hook',
    description: 'Receives only.',
    configuration: configuration.refine(() => !control.refuse, 'refused'),
    receive: (request, context) => {
      control.receives.push({ kind: 'x:hook', request, context });
      return Promise.resolve(control.receive('x:hook', request, context));
    },
  });
  register('both', {
    name: 'both',
    description: 'Listens and receives.',
    configuration,
    start: async (context) => {
      control.starts.push({ kind: 'x:both', context });
      await control.start('x:both', context);
      return () => undefined;
    },
    receive: (request, context) => {
      control.receives.push({ kind: 'x:both', request, context });
      return Promise.resolve(control.receive('x:both', request, context));
    },
  });
  register('listen', {
    name: 'listen',
    description: 'Listens only.',
    configuration,
    start: async (context) => {
      control.starts.push({ kind: 'x:listen', context });
      await control.start('x:listen', context);
      return () => undefined;
    },
  });
  catalog.register({
    kind: 'workflow',
    name: 'x:flow',
    version: '1',
    value: {
      ...workflow({ name: 'flow' }).execute(async function* () {
        yield* [];
        return 'done';
      }),
      title: 'Flow',
      inputSchema: z.unknown(),
    },
    source: { name: 'x', version: '1' },
  });
  const contributions = createWorkflowContributions(catalog);
  const services = createManualRuntimeServices({ origin: ORIGIN });
  const storage = new MemoryStorage();
  const triggerStorage = new MemoryStorage();
  const engine = new Engine({ storage });
  const diagnostics: string[] = [];
  const failures: string[] = [];
  const runtime = createWorkflowRuntime({
    source: workflowFileDirectory(directory, { watch: false }),
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
      store: textValueStore(new MemoryStorage()),
      nowISO: () => services.clock.nowISO(),
    }),
    runtime: services,
    storage: triggerStorage,
    payloadMaximumBytes: options.payloadMaximumBytes,
    diagnose: (message) => diagnostics.push(message),
    onTriggerFailed: (plugin, workflowId, message) =>
      failures.push(`${plugin}/${workflowId}: ${message}`),
    createError: (message, code) => Object.assign(new Error(message), { code }),
  });
  let shut = false;
  const close = async (): Promise<void> => {
    if (shut) return;
    shut = true;
    await runtime.close();
    await engine[Symbol.asyncDispose]();
  };
  cleanups.push(close);
  await runtime.start();
  const rig: Rig = {
    engine,
    runtime,
    services,
    control,
    contributions,
    triggerStorage,
    diagnostics,
    failures,
    put: (id, overrides = hooking()) =>
      writeFile(join(directory, `${id}.json`), workflowFileText(id, overrides)),
    remove: (id) => unlink(join(directory, `${id}.json`)),
    apply: () => runtime.workflows.refresh(),
    receive: (id, request = post()) => runtime.workflows.receiveTrigger(id, request),
    listener: (id = 'hook') =>
      runtime.workflows.list().find((entry) => entry.id === id)?.listener ?? null,
    runIds: async (id = 'hook') => {
      const page = await engine.list({ type: id, limit: 100 });
      return page.items.map((item) => item.id);
    },
    triggerOf: async (runId) => {
      const detail = await runtime.workflows.getRun(runId);
      return detail?.trigger as { kind: string; version: string } | undefined;
    },
    close,
  };
  rigsOfTheRow.push(rig);
  return rig;
}

/** A promise a test settles by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  const held = Promise.withResolvers<void>();
  return { promise: held.promise, open: held.resolve };
}

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

/** A rig whose kinds are gated by the secret `x-token`, set or missing to begin with. */
async function gatedBoot(initially: 'missing' | 'set') {
  const secrets = secretStore();
  if (initially === 'set') secrets.save();
  const secretGate = await createPluginSecretGate('x', [SECRET_KEY], secrets.reader);
  cleanups.push(secretGate.watch());
  const rig = await boot({ gate: secretGate });
  return { rig, secrets };
}

/** The runs a rig has started for `id`, once the engine lists them. */
async function runCount(rig: Rig, id = 'hook'): Promise<number> {
  const runs = await rig.runIds(id);
  return runs.length;
}

/** Fire `payload` from inside a `receive`, collecting the outcomes in `outcomes`. */
function firing(
  outcomes: unknown[],
  payload: unknown = { n: 1 },
  options?: { idempotencyKey?: string },
): Control['receive'] {
  return async (_kind, _request, context) => {
    outcomes.push(await context.fire(payload, options));
    return new Response(null, { status: 204 });
  };
}

/** Every rig the row under way built, so the invariant below is read from each. */
const rigsOfTheRow: Rig[] = [];

/**
 * I3 (COR-2166): the published `retryAt` is non-null exactly while a retry timer is armed. Read
 * after every row.
 */
function expectRetryAtToMatchTheTimers(rig: Rig): void {
  const published = rig.runtime.workflows
    .list()
    .filter((entry) => entry.listener?.retryAt != null).length;
  expect(published, 'published retryAt values').toBe(rig.services.pendingTimers().length);
}

interface Row {
  readonly row: number;
  readonly title: string;
  readonly run: () => Promise<void>;
}

const rows: readonly Row[] = [
  {
    row: 10,
    title:
      'a kind with both keeps the states of its start: no receive call or rejection changes them',
    run: async () => {
      const rig = await boot();
      await rig.put('hook', hooking('x:both'));
      await rig.apply();
      const before = rig.listener();
      expect(before).toMatchObject({ state: 'listening', code: null, retryAt: null });
      await rig.receive('hook');
      rig.control.receive = () => {
        throw new Error('a receive that threw');
      };
      expect((await rejectionOf(rig.receive('hook'))) as Error).toBeInstanceOf(Error);
      rig.control.receive = () => Promise.resolve({} as Response);
      expect(await rejectionOf(rig.receive('hook'))).toBeInstanceOf(TypeError);
      expect(rig.listener()).toEqual(before);
      expect(rig.failures).toEqual([]);
    },
  },
  {
    row: 11,
    title:
      'retryTrigger on a ready listener answers retried with that listener, and attempts nothing',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const before = rig.listener();
      expect(before).toMatchObject({ state: 'ready', code: null, retryAt: null });
      expect(await rig.runtime.workflows.retryTrigger('hook')).toEqual({
        outcome: 'retried',
        listener: before!,
      });
      expect(rig.control.starts).toEqual([]);
      expect(rig.services.pendingTimers()).toEqual([]);
    },
  },
  {
    row: 14,
    title: 'an unknown id answers 404 with an empty body and calls nothing',
    run: async () => {
      const rig = await boot();
      expectEmpty(await rig.receive('ghost'), 404);
      expect(rig.control.receives).toEqual([]);
    },
  },
  {
    row: 15,
    title: 'the id of a code workflow answers 404 with an empty body',
    run: async () => {
      const rig = await boot();
      await rig.apply();
      expectEmpty(await rig.receive('x:flow'), 404);
      expect(rig.control.receives).toEqual([]);
    },
  },
  {
    row: 16,
    title: 'an invalid file, and a ready file that became invalid, answer 404',
    run: async () => {
      const rig = await boot();
      await rig.put('broken', { trigger: { kind: 'x:hook' }, steps: 'not steps' });
      await rig.put('hook');
      await rig.apply();
      expect(rig.runtime.workflows.list().find((entry) => entry.id === 'broken')?.state).toBe(
        'invalid',
      );
      expectEmpty(await rig.receive('broken'), 404);
      expect(await rig.receive('hook')).toMatchObject({ status: 202 });
      await rig.put('hook', { trigger: { kind: 'x:hook', channel: 7 }, steps: [] });
      await rig.apply();
      expectEmpty(await rig.receive('hook'), 404);
      expect(rig.control.receives).toHaveLength(1);
    },
  },
  {
    row: 17,
    title: 'a file not yet applied answers 404 at once, queues no apply and waits for none',
    run: async () => {
      const rig = await boot();
      // First apply failed: the file is in the catalog and not in the engine.
      rig.engine.registerSource = () => {
        throw new Error('registration refused');
      };
      await rig.put('hook');
      await rig.apply();
      expect(rig.runtime.workflows.list().map((entry) => entry.id)).toContain('hook');
      const diagnosed = rig.diagnostics.length;
      expectEmpty(await rig.receive('hook'), 404);
      expect(rig.diagnostics).toHaveLength(diagnosed);
      expect(rig.control.receives).toEqual([]);

      // Second: an apply is held in a trigger's start, and the file waits behind it.
      const second = await boot();
      const held = gate();
      second.control.start = () => held.promise;
      await second.put('first', hooking('x:both'));
      const applying = second.apply();
      await waitUntil(() => second.control.starts.length === 1, { message: 'the held start' });
      await second.put('hook');
      const queued = second.apply();
      await waitUntil(() => second.runtime.workflows.list().some((entry) => entry.id === 'hook'), {
        message: 'the catalog to hold the second file',
      });
      expectEmpty(await second.receive('hook'), 404);
      held.open();
      await Promise.all([applying, queued]);
      expect(second.control.receives).toEqual([]);
    },
  },
  {
    row: 17,
    title:
      'a file removed or edited invalid, scanned but not applied (queued, or its apply failed) while appliedFiles holds the old one, answers 404',
    run: async () => {
      for (const change of ['removed', 'invalid'] as const) {
        // The apply fails: the engine keeps the old file registered and `appliedFiles` still holds it.
        const failed = await boot();
        await failed.put('hook');
        await failed.apply();
        expect(await failed.receive('hook')).toMatchObject({ status: 202 });
        failed.engine.registerSource = () => {
          throw new Error('registration refused');
        };
        if (change === 'removed') await failed.remove('hook');
        else await failed.put('hook', { trigger: { kind: 'x:hook', channel: 7 }, steps: [] });
        await failed.apply();
        expectEmpty(await failed.receive('hook'), 404);
        expect(failed.control.receives).toHaveLength(1);

        // The apply is queued behind a held start: the scan has seen the change, the engine has not.
        const queued = await boot();
        await queued.put('hook');
        await queued.apply();
        const held = gate();
        queued.control.start = () => held.promise;
        await queued.put('first', hooking('x:both'));
        const applying = queued.apply();
        await waitUntil(() => queued.control.starts.length === 1, { message: 'the held start' });
        if (change === 'removed') await queued.remove('hook');
        else await queued.put('hook', { trigger: { kind: 'x:hook', channel: 7 }, steps: [] });
        const refreshing = queued.apply();
        await waitUntil(
          () =>
            queued.runtime.workflows.list().find((entry) => entry.id === 'hook')?.state !== 'ready',
          { message: 'the catalog to hold the change' },
        );
        expectEmpty(await queued.receive('hook'), 404);
        held.open();
        await Promise.all([applying, refreshing]);
        expect(queued.control.receives).toEqual([]);
      }
    },
  },
  {
    row: 35,
    title:
      'a kind with both, while its first start is still pending: receive runs, and a started fire notes lastFiredAt on the unsettled entry, which the settled listener keeps',
    run: async () => {
      const rig = await boot();
      const held = gate();
      rig.control.start = () => held.promise;
      await rig.put('hook', hooking('x:both'));
      const applying = rig.apply();
      await waitUntil(() => rig.control.starts.length === 1, { message: 'the held start' });
      expect(rig.listener()).toBeNull();
      await rig.services.advance(5_000);
      const outcomes: unknown[] = [];
      rig.control.receive = firing(outcomes);
      expect(await rig.receive('hook')).toMatchObject({ status: 204 });
      expect(outcomes).toEqual([{ outcome: 'started', runId: expect.any(String) }]);
      held.open();
      await applying;
      expect(rig.listener()).toMatchObject({
        state: 'listening',
        lastFiredAt: '2026-11-16T00:00:05.000Z',
      });
    },
  },
  {
    row: 18,
    title: 'a file removed and scanned answers 404',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      expect(await rig.receive('hook')).toMatchObject({ status: 202 });
      await rig.remove('hook');
      await rig.apply();
      expectEmpty(await rig.receive('hook'), 404);
      expect(rig.control.receives).toHaveLength(1);
    },
  },
  {
    row: 19,
    title: 'a built-in trigger kind answers 405 with an empty body and calls nothing',
    run: async () => {
      const rig = await boot();
      await rig.put('hook', { steps: hooking().steps });
      await rig.apply();
      expect(rig.runtime.workflows.list().find((entry) => entry.id === 'hook')?.state).toBe(
        'ready',
      );
      expectEmpty(await rig.receive('hook'), 405);
      expect(rig.control.receives).toEqual([]);
    },
  },
  {
    row: 20,
    title: 'a contributed kind with start only answers 405 with an empty body',
    run: async () => {
      const rig = await boot();
      await rig.put('hook', hooking('x:listen'));
      await rig.apply();
      expectEmpty(await rig.receive('hook'), 405);
      expect(rig.control.receives).toEqual([]);
      expect(rig.listener()).toMatchObject({ state: 'listening' });
    },
  },
  {
    row: 21,
    title: 'a ready file whose contributed kind is not loaded answers 405 (O2) and calls nothing',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      // The kind is gone from the catalog the runtime reads while the file is still applied.
      (rig.contributions.triggers as Map<string, VersionedCatalogEntry<PluginTrigger>>).delete(
        'x:hook',
      );
      expect(rig.runtime.workflows.list().find((entry) => entry.id === 'hook')?.state).toBe(
        'ready',
      );
      expectEmpty(await rig.receive('hook'), 405);
      expect(rig.control.receives).toEqual([]);
    },
  },
  {
    row: 22,
    title:
      'receive runs under neither lock: a receive that awaits its own fire completes, and an apply finishes while one is parked',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const outcomes: unknown[] = [];
      rig.control.receive = firing(outcomes);
      expect(await rig.receive('hook')).toMatchObject({ status: 204 });
      expect(outcomes).toEqual([{ outcome: 'started', runId: expect.any(String) }]);

      const parked = gate();
      rig.control.receive = async () => {
        await parked.promise;
        return new Response(null, { status: 204 });
      };
      const pending = rig.receive('hook');
      await waitUntil(() => rig.control.receives.length === 2, { message: 'the parked receive' });
      await rig.put('hook', hooking('x:hook', 'b'));
      await rig.apply();
      await rig.put('second', hooking('x:hook', 'c'));
      await rig.apply();
      expect(rig.listener('second')).toMatchObject({ state: 'ready' });
      parked.open();
      expect(await pending).toMatchObject({ status: 204 });
    },
  },
  {
    row: 23,
    title:
      'the context carries the parsed configuration, the workflow id and the storage start gets',
    run: async () => {
      const rig = await boot();
      await rig.put('hook', hooking('x:hook', 'alerts'));
      await rig.apply();
      await rig.receive('hook');
      const { context } = rig.control.receives[0]!;
      expect(context.configuration).toEqual({ channel: 'alerts' });
      expect(context.workflowId).toBe('hook');
      await context.storage.put('cursor', new Uint8Array([7]));
      expect(await rig.triggerStorage.get(`${triggerStatePrefix('x:hook', 'hook')}cursor`)).toEqual(
        new Uint8Array([7]),
      );
    },
  },
  {
    row: 24,
    title:
      'the signal follows the request and the close, and no pause, edit, removal or version bump aborts it',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const parked = gate();
      rig.control.receive = async () => {
        await parked.promise;
        return new Response(null, { status: 204 });
      };
      const controller = new AbortController();
      const request = new Request('https://hooks.example.test/triggers/hook', {
        method: 'POST',
        body: '{}',
        signal: controller.signal,
      });
      const first = rig.receive('hook', request);
      const second = rig.receive('hook', post());
      await waitUntil(() => rig.control.receives.length === 2, { message: 'two receives' });
      const [one, two] = rig.control.receives.map((entry) => entry.context.signal);
      await rig.put('hook', hooking('x:hook', 'b', { paused: true }));
      await rig.apply();
      await rig.put('hook', hooking('x:hook', 'c'));
      await rig.apply();
      (rig.contributions.triggers as Map<string, VersionedCatalogEntry<PluginTrigger>>).set(
        'x:hook',
        { ...rig.contributions.triggers.get('x:hook')!, version: '2' },
      );
      await rig.remove('hook');
      await rig.apply();
      expect([one!.aborted, two!.aborted]).toEqual([false, false]);
      controller.abort();
      expect([one!.aborted, two!.aborted]).toEqual([true, false]);
      await rig.close();
      expect(two!.aborted).toBe(true);
      parked.open();
      await Promise.all([first, second]);
    },
  },
  {
    row: 25,
    title:
      'a paused file still calls receive: its fires answer skipped paused, start nothing and set no lastFiredAt',
    run: async () => {
      const rig = await boot();
      await rig.put('hook', hooking('x:hook', 'a', { paused: true }));
      await rig.apply();
      expect(rig.listener()).toMatchObject({ state: 'stopped', code: null });
      const outcomes: unknown[] = [];
      rig.control.receive = firing(outcomes);
      expect(await rig.receive('hook')).toMatchObject({ status: 204 });
      expect(outcomes).toEqual([{ outcome: 'skipped', reason: 'paused' }]);
      expect(await runCount(rig)).toBe(0);
      expect(rig.listener()).toMatchObject({ state: 'stopped', lastFiredAt: null });
    },
  },
  {
    row: 26,
    title:
      'while a declared secret is missing receive is refused with PluginNeedsSetupError, nothing fires and no state changes',
    run: async () => {
      const { rig } = await gatedBoot('missing');
      await rig.put('hook');
      await rig.put('both', hooking('x:both'));
      await rig.apply();
      const before = [rig.listener('hook'), rig.listener('both')];
      const diagnosed = rig.diagnostics.length;
      for (const id of ['hook', 'both']) {
        const error = await rejectionOf(rig.receive(id));
        expect(error).toBeInstanceOf(PluginNeedsSetupError);
        expect((error as Error).name).toBe('PluginNeedsSetupError');
      }
      expect(rig.control.receives).toEqual([]);
      expect([rig.listener('hook'), rig.listener('both')]).toEqual(before);
      expect(rig.failures).toEqual([]);
      expect(rig.diagnostics).toHaveLength(diagnosed);
      expect(await runCount(rig)).toBe(0);
    },
  },
  {
    row: 27,
    title:
      'a secret removed while a receive is in flight does not stop it: its fires answer as any fire',
    run: async () => {
      const { rig, secrets } = await gatedBoot('set');
      await rig.put('hook');
      await rig.apply();
      const removed = gate();
      const outcomes: unknown[] = [];
      rig.control.receive = async (_kind, _request, context) => {
        await removed.promise;
        outcomes.push(await context.fire({ n: 1 }));
        return new Response(null, { status: 204 });
      };
      const pending = rig.receive('hook');
      await waitUntil(() => rig.control.receives.length === 1, { message: 'the receive' });
      secrets.remove();
      await quietFor(10);
      removed.open();
      expect(await pending).toMatchObject({ status: 204 });
      expect(outcomes).toEqual([{ outcome: 'started', runId: expect.any(String) }]);
      expect(rig.listener()).toMatchObject({ state: 'ready' });
    },
  },
  {
    row: 28,
    title:
      'a Response receive resolves is returned as it is: the same object, status, headers and body',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const answer = new Response('accepted', { status: 201, headers: { 'x-delivery': 'one' } });
      rig.control.receive = () => answer;
      const response = await rig.receive('hook');
      expect(response).toBe(answer);
      expect(response.headers.get('x-delivery')).toBe('one');
      expect(await response.text()).toBe('accepted');
    },
  },
  {
    row: 29,
    title:
      'a receive that resolves something else rejects with a fixed TypeError naming the kind (O3), and changes nothing',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const before = rig.listener();
      const diagnosed = rig.diagnostics.length;
      rig.control.receive = () => ({}) as Response;
      const error = await rejectionOf(rig.receive('hook'));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toBe(
        'The "x:hook" trigger\'s receive did not return a Response.',
      );
      expect(rig.listener()).toEqual(before);
      expect(rig.failures).toEqual([]);
      expect(rig.diagnostics).toHaveLength(diagnosed);
    },
  },
  {
    row: 30,
    title:
      'a receive that throws or rejects, an AbortError among them, rejects with the same error and changes nothing',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const before = rig.listener();
      const diagnosed = rig.diagnostics.length;
      const thrown = new Error('the webhook secret sk-live-0123456789 leaked');
      rig.control.receive = () => {
        throw thrown;
      };
      expect(await rejectionOf(rig.receive('hook'))).toBe(thrown);
      const rejected = new Error('rejected with sk-live-0123456789');
      rig.control.receive = () => Promise.reject(rejected);
      expect(await rejectionOf(rig.receive('hook'))).toBe(rejected);
      const aborted = new DOMException('aborted', 'AbortError');
      rig.control.receive = () => Promise.reject(aborted);
      expect(await rejectionOf(rig.receive('hook'))).toBe(aborted);
      expect(rig.listener()).toEqual(before);
      expect(rig.failures).toEqual([]);
      expect(rig.diagnostics).toHaveLength(diagnosed);
    },
  },
  {
    row: 31,
    title: 'a receive that never settles keeps receiveTrigger pending: Bureau arms no timer',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const forever = gate();
      rig.control.receive = async () => {
        await forever.promise;
        return new Response(null, { status: 204 });
      };
      let settled = false;
      const pending = rig.receive('hook').finally(() => {
        settled = true;
      });
      await waitUntil(() => rig.control.receives.length === 1, { message: 'the receive' });
      expect(rig.services.pendingTimers()).toEqual([]);
      await rig.services.advance(3_600_000);
      await quietFor(10);
      expect(settled).toBe(false);
      forever.open();
      await pending;
    },
  },
  {
    row: 32,
    title:
      'a request aborted by the client aborts the context signal, and what receive settles with is the answer',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const aborting = gate();
      rig.control.receive = async (_kind, _request, context) => {
        await aborting.promise;
        return new Response(context.signal.aborted ? 'aborted' : 'open', { status: 499 });
      };
      const controller = new AbortController();
      const pending = rig.receive(
        'hook',
        new Request('https://hooks.example.test/triggers/hook', {
          method: 'POST',
          body: '{}',
          signal: controller.signal,
        }),
      );
      await waitUntil(() => rig.control.receives.length === 1, { message: 'the receive' });
      controller.abort();
      expect(rig.control.receives[0]!.context.signal.aborted).toBe(true);
      aborting.open();
      const response = await pending;
      expect(response.status).toBe(499);
      expect(await response.text()).toBe('aborted');
    },
  },
  {
    row: 33,
    title:
      'a fire after the signal aborted answers skipped stopped, or closed once Bureau is closed, and never reaches fireTrigger (O4); one after receive returned goes through',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      let listed = 0;
      const list = rig.engine.list.bind(rig.engine);
      (rig.engine as unknown as Record<string, unknown>)['list'] = (...args: unknown[]) => {
        listed += 1;
        return (list as (...a: unknown[]) => unknown)(...args);
      };
      const controller = new AbortController();
      const outcomes: unknown[] = [];
      rig.control.receive = async (_kind, _request, context) => {
        controller.abort();
        outcomes.push(await context.fire({ n: 1 }, { idempotencyKey: 'late' }));
        return new Response(null, { status: 204 });
      };
      await rig.receive(
        'hook',
        new Request('https://hooks.example.test/triggers/hook', {
          method: 'POST',
          body: '{}',
          signal: controller.signal,
        }),
      );
      expect(outcomes).toEqual([{ outcome: 'skipped', reason: 'stopped' }]);
      expect(listed).toBe(0);
      expect(await runCount(rig)).toBe(0);

      // After receive returned, with the signal not aborted, a fire is any fire.
      rig.control.receive = () => new Response(null, { status: 204 });
      await rig.receive('hook');
      const kept = rig.control.receives.at(-1)!.context;
      expect(await kept.fire({ n: 2 })).toMatchObject({ outcome: 'started' });

      // Once Bureau is closed, `closed`, not `stopped`.
      await rig.close();
      expect(await kept.fire({ n: 3 })).toEqual({ outcome: 'skipped', reason: 'closed' });
    },
  },
  {
    row: 34,
    title: 'a receive that never fires returns its Response, starts no run and leaves lastFiredAt',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      expect(await rig.receive('hook')).toMatchObject({ status: 202 });
      expect(await runCount(rig)).toBe(0);
      expect(rig.listener()).toMatchObject({ state: 'ready', lastFiredAt: null });
    },
  },
  {
    row: 35,
    title:
      'a fire that starts a run sets lastFiredAt to now on the file’s listener, and the run carries the trigger',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const since = rig.listener()?.since;
      await rig.services.advance(2_000);
      const outcomes: unknown[] = [];
      rig.control.receive = firing(outcomes);
      await rig.receive('hook');
      expect(rig.listener()).toMatchObject({
        state: 'ready',
        since,
        lastFiredAt: '2026-11-16T00:00:02.000Z',
      });
      const runs = await rig.runIds();
      expect(runs).toHaveLength(1);
      expect(await rig.triggerOf(runs[0]!)).toMatchObject({ kind: 'x:hook', version: '1' });
    },
  },
  {
    row: 36,
    title:
      'an edit of the trigger mid-call does not abort it, and the fire notes lastFiredAt on the entry current when it answers started (O8)',
    run: async () => {
      const rig = await boot();
      await rig.put('hook', hooking('x:hook', 'a'));
      await rig.apply();
      const edited = gate();
      const outcomes: unknown[] = [];
      rig.control.receive = async (_kind, _request, context) => {
        await edited.promise;
        outcomes.push(await context.fire({ n: 1 }));
        return new Response(null, { status: 204 });
      };
      const pending = rig.receive('hook');
      await waitUntil(() => rig.control.receives.length === 1, { message: 'the receive' });
      await rig.put('hook', hooking('x:hook', 'b'));
      await rig.apply();
      expect(rig.listener()).toMatchObject({ state: 'ready', lastFiredAt: null });
      await rig.services.advance(1_000);
      edited.open();
      await pending;
      expect(rig.control.receives[0]!.context.signal.aborted).toBe(false);
      expect(outcomes).toEqual([{ outcome: 'started', runId: expect.any(String) }]);
      expect(rig.listener()).toMatchObject({ lastFiredAt: '2026-11-16T00:00:01.000Z' });
    },
  },
  {
    row: 37,
    title:
      'a kind with both whose start failed still receives: a started fire notes lastFiredAt on the failed entry and leaves its state, timer and problem',
    run: async () => {
      const rig = await boot();
      rig.control.start = () => {
        throw new Error('the source refused the token');
      };
      await rig.put('hook', hooking('x:both'));
      await rig.apply();
      const before = rig.listener();
      expect(before).toMatchObject({ state: 'failed', code: 'start-failed' });
      expect(before?.retryAt).not.toBeNull();
      expect(rig.services.pendingTimers()).toHaveLength(1);
      const outcomes: unknown[] = [];
      rig.control.receive = firing(outcomes);
      await rig.services.advance(0);
      expect(await rig.receive('hook')).toMatchObject({ status: 204 });
      expect(outcomes).toEqual([{ outcome: 'started', runId: expect.any(String) }]);
      const after = rig.listener();
      expect(after).toEqual({ ...before!, lastFiredAt: ORIGIN });
      expect(rig.services.pendingTimers()).toHaveLength(1);
      expect(rig.failures).toHaveLength(1);
    },
  },
  {
    row: 38,
    title:
      'one key from the listener’s fire and from a receive fire starts one run, and the second answers duplicate',
    run: async () => {
      const rig = await boot();
      await rig.put('hook', hooking('x:both'));
      await rig.apply();
      const first = await rig.control.starts[0]!.context.fire({ n: 1 }, { idempotencyKey: 'k' });
      expect(first).toMatchObject({ outcome: 'started' });
      const outcomes: unknown[] = [];
      rig.control.receive = firing(outcomes, { n: 1 }, { idempotencyKey: 'k' });
      await rig.receive('hook');
      expect(outcomes).toEqual([
        { outcome: 'duplicate', runId: (first as { runId: string }).runId },
      ]);
      expect(await runCount(rig)).toBe(1);
    },
  },
  {
    row: 39,
    title: 'a started fire with no supervisor entry yet starts a run and sets no lastFiredAt',
    run: async () => {
      const rig = await boot();
      const held = gate();
      rig.control.start = () => held.promise;
      await rig.put('a-first', hooking('x:both'));
      await rig.put('hook');
      const applying = rig.apply();
      await waitUntil(() => rig.control.starts.length === 1, { message: 'the held start' });
      expect(rig.listener('hook')).toBeNull();
      const outcomes: unknown[] = [];
      rig.control.receive = firing(outcomes);
      await rig.receive('hook');
      expect(outcomes).toEqual([{ outcome: 'started', runId: expect.any(String) }]);
      held.open();
      await applying;
      expect(rig.listener('hook')).toMatchObject({ state: 'ready', lastFiredAt: null });
    },
  },
  {
    row: 40,
    title:
      'several fires with no key, or distinct keys, start one run each and the last started sets lastFiredAt',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const outcomes: unknown[] = [];
      rig.control.receive = async (_kind, _request, context) => {
        outcomes.push(await context.fire({ n: 1 }));
        await rig.services.advance(1_000);
        outcomes.push(await context.fire({ n: 2 }));
        outcomes.push(await context.fire({ n: 3 }, { idempotencyKey: 'a' }));
        await rig.services.advance(1_000);
        outcomes.push(await context.fire({ n: 4 }, { idempotencyKey: 'b' }));
        return new Response(null, { status: 204 });
      };
      await rig.receive('hook');
      expect(outcomes.map((outcome) => (outcome as { outcome: string }).outcome)).toEqual([
        'started',
        'started',
        'started',
        'started',
      ]);
      expect(await runCount(rig)).toBe(4);
      expect(rig.listener()).toMatchObject({ lastFiredAt: '2026-11-16T00:00:02.000Z' });
    },
  },
  {
    row: 41,
    title:
      'several fires with one key, in one call or across calls, start one run and then answer duplicate with its runId, and a duplicate sets no lastFiredAt',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const outcomes: unknown[] = [];
      rig.control.receive = firing(outcomes, { n: 1 }, { idempotencyKey: 'k' });
      await rig.receive('hook');
      const fired = rig.listener()?.lastFiredAt;
      await rig.services.advance(5_000);
      await rig.receive('hook');
      const runId = (outcomes[0] as { runId: string }).runId;
      expect(outcomes).toEqual([
        { outcome: 'started', runId },
        { outcome: 'duplicate', runId },
      ]);
      expect(rig.listener()?.lastFiredAt).toBe(fired ?? null);
      // At once, from two calls.
      rig.control.receive = firing(outcomes, { n: 2 }, { idempotencyKey: 'concurrent' });
      await Promise.all([rig.receive('hook'), rig.receive('hook')]);
      expect(
        outcomes
          .slice(2)
          .map((outcome) => (outcome as { outcome: string }).outcome)
          .toSorted(),
      ).toEqual(['duplicate', 'started']);
      expect(await runCount(rig)).toBe(2);
    },
  },
  {
    row: 42,
    title:
      'a fire with an empty or non-string key rejects BAD_REQUEST to receive, and receiveTrigger rejects with it when receive rethrows',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      for (const key of ['', 7]) {
        rig.control.receive = (_kind, _request, context) =>
          context.fire({ n: 1 }, { idempotencyKey: key as string }).then(() => new Response());
        const error = (await rejectionOf(rig.receive('hook'))) as Error & { code?: string };
        expect(error.code).toBe('BAD_REQUEST');
      }
      expect(await runCount(rig)).toBe(0);
    },
  },
  {
    row: 43,
    title:
      'a payload that is not JSON, one the inputSchema refuses, one too large, and a fire after a failed apply reject to receive, and leave the key free',
    run: async () => {
      const rig = await boot({ payloadMaximumBytes: 512 });
      await rig.put('hook', {
        ...hooking(),
        inputSchema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
      });
      await rig.apply();
      const attempt = async (payload: unknown, key = 'k'): Promise<unknown> => {
        let error: unknown;
        rig.control.receive = async (_kind, _request, context) => {
          error = await rejectionOf(context.fire(payload, { idempotencyKey: key }));
          throw error;
        };
        expect(await rejectionOf(rig.receive('hook'))).toBe(error);
        return error;
      };
      expect((await attempt({ n: 1, f: () => 1 })) as { code?: string }).toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(await attempt({ n: 'x' })).toBeInstanceOf(WorkflowInputInvalidError);
      expect(await attempt({ n: 1, pad: 'x'.repeat(2_000) })).toMatchObject({
        message: expect.stringContaining('over the engine'),
      });
      expect(await runCount(rig)).toBe(0);
      const outcomes: unknown[] = [];
      rig.control.receive = firing(outcomes, { n: 1 }, { idempotencyKey: 'k' });
      await rig.receive('hook');
      expect(outcomes).toEqual([{ outcome: 'started', runId: expect.any(String) }]);

      rig.engine.registerSource = () => {
        throw new Error('registration refused');
      };
      await rig.put('hook', {
        ...hooking(),
        steps: [{ kind: 'activity', handler: 'x:y', input: 'changed' }],
      });
      await rig.apply();
      expect(await attempt({ n: 2 }, 'after-the-failure')).toBeInstanceOf(WorkflowApplyError);
    },
  },
  {
    row: 44,
    title:
      'every fire of a call records the version read when the kind was resolved, even after a bump mid-call (O5)',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const outcomes: Array<{ runId: string }> = [];
      rig.control.receive = async (_kind, _request, context) => {
        (rig.contributions.triggers as Map<string, VersionedCatalogEntry<PluginTrigger>>).set(
          'x:hook',
          { ...rig.contributions.triggers.get('x:hook')!, version: '2' },
        );
        outcomes.push((await context.fire({ n: 1 })) as { runId: string });
        return new Response(null, { status: 204 });
      };
      await rig.receive('hook');
      expect(await rig.triggerOf(outcomes[0]!.runId)).toMatchObject({ version: '1' });
      await rig.receive('hook');
      expect(await rig.triggerOf(outcomes[1]!.runId)).toMatchObject({ version: '2' });
    },
  },
  {
    row: 45,
    title:
      'two concurrent requests both run receive unserialized, their fires serialize, and one key starts one run',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const both = gate();
      const outcomes: unknown[] = [];
      rig.control.receive = async (_kind, _request, context) => {
        await both.promise;
        outcomes.push(await context.fire({ n: 1 }, { idempotencyKey: 'k' }));
        return new Response(null, { status: 204 });
      };
      const first = rig.receive('hook');
      const second = rig.receive('hook');
      await waitUntil(() => rig.control.receives.length === 2, { message: 'both receives' });
      both.open();
      await Promise.all([first, second]);
      expect(
        outcomes.map((outcome) => (outcome as { outcome: string }).outcome).toSorted(),
      ).toEqual(['duplicate', 'started']);
      expect(await runCount(rig)).toBe(1);
    },
  },
  {
    row: 47,
    title:
      'an edit of the file while receive is in flight does not abort it, and each fire starts the revision applied when it runs',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const edited = gate();
      const outcomes: Array<{ runId: string }> = [];
      rig.control.receive = async (_kind, _request, context) => {
        outcomes.push((await context.fire({ n: 1 })) as { runId: string });
        await edited.promise;
        outcomes.push((await context.fire({ n: 2 })) as { runId: string });
        return new Response(null, { status: 204 });
      };
      const pending = rig.receive('hook');
      await waitUntil(() => outcomes.length === 1, { message: 'the first fire' });
      await rig.put(
        'hook',
        hooking('x:hook', 'a', {
          steps: [{ kind: 'activity', handler: 'x:y', input: 'edited' }],
        }),
      );
      await rig.apply();
      edited.open();
      await pending;
      expect(rig.control.receives[0]!.context.signal.aborted).toBe(false);
      const page = await rig.runtime.workflows.listRuns({ workflow: 'hook', limit: 10, offset: 0 });
      const versions = new Map(page.runs.map((run) => [run.id, run.workflowVersion]));
      const current = rig.runtime.workflows.list().find((entry) => entry.id === 'hook')?.version;
      expect(versions.get(outcomes[1]!.runId)).toBe(current);
      expect(versions.get(outcomes[0]!.runId)).not.toBe(current);
    },
  },
  {
    row: 48,
    title:
      'a file removed, or whose kind changed, while receive is in flight answers skipped stopped, and the Response is still returned',
    run: async () => {
      for (const change of ['removed', 'kind changed'] as const) {
        const rig = await boot();
        await rig.put('hook');
        await rig.apply();
        const changed = gate();
        const outcomes: unknown[] = [];
        rig.control.receive = async (_kind, _request, context) => {
          await changed.promise;
          outcomes.push(await context.fire({ n: 1 }));
          return new Response('still here', { status: 200 });
        };
        const pending = rig.receive('hook');
        await waitUntil(() => rig.control.receives.length === 1, { message: 'the receive' });
        if (change === 'removed') await rig.remove('hook');
        else await rig.put('hook', hooking('x:listen'));
        await rig.apply();
        changed.open();
        const answered = await pending;
        expect(await answered.text()).toBe('still here');
        expect(outcomes).toEqual([{ outcome: 'skipped', reason: 'stopped' }]);
        expect(await runCount(rig)).toBe(0);
      }
    },
  },
  {
    row: 49,
    title: 'a pause registered while receive is in flight answers skipped paused to its fire',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const paused = gate();
      const outcomes: unknown[] = [];
      rig.control.receive = async (_kind, _request, context) => {
        await paused.promise;
        outcomes.push(await context.fire({ n: 1 }));
        return new Response(null, { status: 204 });
      };
      const pending = rig.receive('hook');
      await waitUntil(() => rig.control.receives.length === 1, { message: 'the receive' });
      await rig.put('hook', hooking('x:hook', 'a', { paused: true }));
      await rig.apply();
      paused.open();
      await pending;
      expect(outcomes).toEqual([{ outcome: 'skipped', reason: 'paused' }]);
    },
  },
  {
    row: 50,
    title:
      'close while receive is in flight aborts its signal, does not wait for it, and its later fires answer skipped closed (O6)',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const closing = gate();
      const outcomes: unknown[] = [];
      rig.control.receive = async (_kind, _request, context) => {
        await closing.promise;
        outcomes.push(await context.fire({ n: 1 }));
        return new Response('after close', { status: 200 });
      };
      const pending = rig.receive('hook');
      await waitUntil(() => rig.control.receives.length === 1, { message: 'the receive' });
      await rig.close();
      expect(rig.control.receives[0]!.context.signal.aborted).toBe(true);
      closing.open();
      const answered = await pending;
      expect(await answered.text()).toBe('after close');
      expect(outcomes).toEqual([{ outcome: 'skipped', reason: 'closed' }]);
    },
  },
  {
    row: 51,
    title: 'receiveTrigger after close began answers 503 with an empty body and calls nothing (O6)',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      await rig.close();
      expectEmpty(await rig.receive('hook'), 503);
      expectEmpty(await rig.receive('ghost'), 503);
      expect(rig.control.receives).toEqual([]);
    },
  },
  {
    row: 55,
    title:
      'a malformed body or a wrong content type reaches receive as given: Bureau neither reads, parses nor clones it',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const request = new Request('https://hooks.example.test/triggers/hook', {
        method: 'POST',
        body: '{ not json',
        headers: { 'content-type': 'text/plain' },
      });
      await rig.receive('hook', request);
      const seen = rig.control.receives[0]!.request;
      expect(seen).toBe(request);
      expect(seen.bodyUsed).toBe(false);
      expect(await seen.text()).toBe('{ not json');
    },
  },
  {
    row: 56,
    title: 'every answer Bureau authors has a null body and no text',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.put('listen', hooking('x:listen'));
      await rig.apply();
      for (const [id, status] of [
        ['ghost', 404],
        ['listen', 405],
      ] as const) {
        const response = await rig.receive(id);
        expectEmpty(response, status);
        expect(await response.text()).toBe('');
        expect([...response.headers]).toEqual([]);
      }
      await rig.close();
      const response = await rig.receive('hook');
      expectEmpty(response, 503);
      expect([...response.headers]).toEqual([]);
    },
  },
  {
    row: 58,
    title:
      'receiveTrigger publishes no problem, event or diagnostic on any path, and no text of its own error',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.put('listen', hooking('x:listen'));
      await rig.apply();
      const diagnosed = rig.diagnostics.length;
      const secret = 'sk-live-canary-0123456789';
      await rig.receive('ghost');
      await rig.receive('listen');
      rig.control.receive = () => {
        throw new Error(`the signature ${secret} was wrong`);
      };
      await rejectionOf(rig.receive('hook'));
      rig.control.receive = () => ({}) as Response;
      await rejectionOf(rig.receive('hook'));
      rig.control.refuse = true;
      expectEmpty(await rig.receive('hook'), 503);
      expect(rig.failures).toEqual([]);
      expect(rig.diagnostics).toHaveLength(diagnosed);
      expect(JSON.stringify(rig.diagnostics)).not.toContain(secret);
    },
  },
  {
    row: 8,
    title:
      'a receive-only call whose applied configuration the kind now refuses, or whose storage cannot be made, answers 503 without calling receive (O1)',
    run: async () => {
      const rig = await boot();
      await rig.put('hook');
      await rig.apply();
      const before = rig.listener();
      const diagnosed = rig.diagnostics.length;
      rig.control.refuse = true;
      expectEmpty(await rig.receive('hook'), 503);
      expect(rig.control.receives).toEqual([]);
      expect(rig.listener()).toEqual(before);
      expect(rig.diagnostics).toHaveLength(diagnosed);
      expect(rig.failures).toEqual([]);
      rig.control.refuse = false;
      expect(await rig.receive('hook')).toMatchObject({ status: 202 });
      // The storage a kind of another plugin name cannot make.
      const kind = rig.contributions.triggers.get('x:hook')!;
      (rig.contributions.triggers as Map<string, VersionedCatalogEntry<PluginTrigger>>).set(
        'x:hook',
        { ...kind, name: 'not-a-kind' },
      );
      expectEmpty(await rig.receive('hook'), 503);
      expect(rig.control.receives).toHaveLength(1);
    },
  },
  {
    row: 59,
    title: 'the webhook line of workflow-files.md is replaced by the receive description',
    run: async () => {
      const text = await readFile(
        new URL('../documentation/workflow-files.md', import.meta.url),
        'utf8',
      );
      expect(text).not.toMatch(/Webhook and lifecycle triggers are not planned/);
      expect(text).toContain('receiveTrigger');
    },
  },
];

describe('receiving through a contributed trigger kind (COR-2168 outcome matrix)', () => {
  it('lists each row once, in the table of this file, with the rows the other files hold', () => {
    // A row may have more than one test here (the matrix cell crosses two states), never two with one title.
    const own = [...new Set(rows.map((entry) => entry.row))];
    const titles = rows.map((entry) => `${entry.row}:${entry.title}`);
    expect(new Set(titles).size).toBe(titles.length);
    const elsewhere = [1, 2, 3, 4, 5, 6, 7, 9, 12, 13, 54, 57];
    const skipped = [46, 52, 53];
    expect([...own, ...elsewhere, ...skipped].toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 59 }, (_value, index) => index + 1),
    );
  });

  for (const { row, title, run } of rows) {
    it(`M${row}: ${title}`, async () => {
      rigsOfTheRow.length = 0;
      await run();
      for (const rig of rigsOfTheRow) expectRetryAtToMatchTheTimers(rig);
    });
  }

  it.each([
    ['a start that is not a function', { start: 'listen' }],
    ['a receive that is not a function', { receive: 'answer' }],
    [
      'a start beside a receive that is not a function',
      { start: async () => () => {}, receive: 7 },
    ],
    ['neither', {}],
  ])(
    'M1: a plugin whose trigger kind has %s is setup-failed, not a listener that retries or a 503',
    async (_label, members) => {
      const plugin = definePlugin({
        name: 'broken',
        version: '1.0.0',
        description: 'Contributes a malformed trigger kind.',
        setup: () => ({
          triggers: [
            {
              name: 'hook',
              description: 'Malformed.',
              configuration: z.object({}),
              ...members,
            } as PluginTrigger,
          ],
        }),
      });
      const harness = await startWorkflowBureau({
        overrides: {
          plugins: [{ descriptor: plugin, source: 'package', location: '@example/broken' }],
          onDiagnostic: () => undefined,
        },
      });
      cleanups.push(() => harness.dispose());
      const [listing] = await listedPlugins(harness.bureau);
      expect(listing?.problems.map((problem) => problem.code)).toContain('setup-failed');
      expect(listing?.status).not.toBe('running');
      // No file can name the kind: it was never registered.
      await harness.put(
        'hook.json',
        workflowFileText('hook', { trigger: { kind: 'broken:hook' } }),
      );
      await harness.bureau.workflows?.refresh();
      expect(harness.bureau.workflows?.list().find((entry) => entry.id === 'hook')?.state).toBe(
        'invalid',
      );
    },
  );
});
