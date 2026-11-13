/**
 * COR-2244 — a plugin's code workflow `kit:sync` against a real Bureau: it lists beside the workflow
 * files, starts on the envelope a file's run starts on, pins the version the engine registered, and
 * is checked against its `inputSchema`; it clashes with a file of one identifier; and a run of it
 * reports `missing` while its plugin is not loaded and resumes when the plugin returns.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin, type PluginWorkflow } from '@lostgradient/interborough-plugin';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { workflow } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { BureauDiagnostic } from './bureau-types/options';
import { startWorkflowBureau } from './testing/workflow-bureau.test-support';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { createVersionedCatalog } from './versioned-catalog';
import { createWorkflowContributions } from './workflow-contributions';
import { WorkflowInputInvalidError } from './workflow-schema';
import { PluginNeedsSetupError, gatedContributions } from './plugins/plugin-secret-gate';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** The engine a Bureau composes, as `durableEngine()` hands it out. */
type DurableEngine = NonNullable<
  ReturnType<Awaited<ReturnType<typeof startWorkflowBureau>>['bureau']['durableEngine']>
>;

/** The status of run `id`, or `undefined` when the engine holds none. */
async function statusOf(engine: DurableEngine, id: string): Promise<string | undefined> {
  const state = await engine.get(id);
  return state?.status;
}

const inputSchema = z.object({ team: z.string() });

/** `kit:sync`, which completes with the input envelope it was started with. */
const sync = (extra: { readonly version?: string } = {}): PluginWorkflow => ({
  ...workflow({ name: 'sync' }).execute(async function* (_context, input: unknown) {
    yield* [];
    return input;
  }),
  title: 'Sync issues',
  inputSchema,
  ...extra,
});

/** `kit:wait`, which parks on the signal `go` and then completes. */
const wait = (): PluginWorkflow => ({
  ...workflow({ name: 'wait' }).execute(async function* (context) {
    yield* context.waitForSignal('go');
    return 'went';
  }),
  title: 'Wait',
  inputSchema: z.unknown(),
});

function kit(workflows: readonly PluginWorkflow[], version = '1.0.0') {
  return {
    descriptor: definePlugin({
      name: 'kit',
      version,
      description: 'Contributes code workflows.',
      setup: () => ({ workflows }),
    }),
    source: 'package' as const,
    location: '@example/kit',
  };
}

describe('a plugin code workflow in a Bureau', () => {
  it('lists beside the files, starts on the file envelope, and reads its run back', async () => {
    const harness = await startWorkflowBureau({ overrides: { plugins: [kit([sync()])] } });
    cleanups.push(() => harness.dispose());
    const workflows = harness.bureau.workflows!;

    expect(workflows.codeList()).toEqual([
      {
        kind: 'code',
        id: 'kit:sync',
        name: 'sync',
        title: 'Sync issues',
        plugin: 'kit',
        version: '1.0.0',
      },
    ]);
    // The files are unchanged: a code workflow is not one.
    expect(workflows.list()).toEqual([]);

    const started = await workflows.start('kit:sync', {
      owner: 'anonymous:local',
      input: { team: 'core' },
    });
    expect(started).toMatchObject({ workflow: 'kit:sync', workflowVersion: '1.0.0' });
    const engine = harness.bureau.durableEngine()!;
    const state = await engine.get(started.runId);
    expect(state?.type).toBe('kit__sync');
    await waitUntil(async () => (await statusOf(engine, started.runId)) === 'completed');

    const run = await workflows.getRun(started.runId);
    expect(run).toMatchObject({
      workflow: 'kit:sync',
      workflowVersion: '1.0.0',
      status: 'completed',
      // The envelope a file run starts on: the input beside its origin.
      result: { kind: 'manual', input: { team: 'core' }, origin: { kind: 'person' } },
    });
    const { runs } = await workflows.listRuns({ workflow: 'kit:sync', offset: 0, limit: 10 });
    expect(runs.map((each) => each.id)).toEqual([started.runId]);
    const everything = await workflows.listRuns({ offset: 0, limit: 10 });
    expect(everything.runs.map((each) => each.workflow)).toEqual(['kit:sync']);
    expect(await workflows.runCounts('kit:sync')).toMatchObject({ last24Hours: 1 });
    expect(workflows.getCode('kit:sync')).toMatchObject({
      id: 'kit:sync',
      source: { kind: 'code' },
    });
  });

  const PINS = [
    { name: 'its own version', extra: { version: '7' }, pinned: '7' },
    { name: 'the plugin’s version when it declares none', extra: {}, pinned: '2.3.4' },
  ] as const;
  for (const { name, extra, pinned } of PINS) {
    it(`pins ${name}, the version the engine registers`, async () => {
      const harness = await startWorkflowBureau({
        overrides: { plugins: [kit([sync(extra)], '2.3.4')] },
      });
      cleanups.push(() => harness.dispose());
      const started = await harness.bureau.workflows!.start('kit:sync', {
        owner: 'anonymous:local',
        input: { team: 'a' },
      });
      expect(started.workflowVersion).toBe(pinned);
      const state = await harness.bureau.durableEngine()!.get(started.runId);
      expect(state?.versionTuple.workflowVersion).toBe(pinned);
    });
  }

  it('refuses an input its inputSchema refuses, before the engine starts anything', async () => {
    const harness = await startWorkflowBureau({ overrides: { plugins: [kit([sync()])] } });
    cleanups.push(() => harness.dispose());
    const refusal = await rejectionOf(
      harness.bureau.workflows!.start('kit:sync', { owner: 'anonymous:local', input: { team: 3 } }),
    );
    expect(refusal).toBeInstanceOf(WorkflowInputInvalidError);
    const page = await harness.bureau.durableEngine()!.list({ type: 'kit__sync', limit: 10 });
    expect(page.total).toBe(0);
  });

  it('refuses to start while its plugin needs setup, and is still listed', async () => {
    const needsSetup = {
      plugin: 'kit',
      missing: () => ['token'],
      available: () => false,
      assertAvailable: (contribution: string) => {
        throw new PluginNeedsSetupError('kit', contribution, ['token']);
      },
      onChange: () => () => undefined,
      watch: () => () => undefined,
    };
    const gated = gatedContributions({ workflows: [sync()] }, needsSetup, (name) => `kit:${name}`);
    const catalog = createVersionedCatalog();
    catalog.register({
      kind: 'workflow',
      name: 'kit:sync',
      value: gated.workflows[0],
      source: { name: 'kit', version: '1.0.0' },
    });
    const harness = await startWorkflowBureau({
      overrides: { contributionCatalog: catalog },
    });
    cleanups.push(() => harness.dispose());
    const workflows = harness.bureau.workflows!;
    expect(workflows.codeList().map((each) => each.id)).toEqual(['kit:sync']);
    const refusal = await rejectionOf(
      workflows.start('kit:sync', { owner: 'anonymous:local', input: { team: 'a' } }),
    );
    expect(refusal).toBeInstanceOf(PluginNeedsSetupError);
    const page = await harness.bureau.durableEngine()!.list({ type: 'kit__sync', limit: 10 });
    expect(page.total).toBe(0);
  });
});

describe('a code workflow and a workflow file of one identifier', () => {
  it('is a startup TypeError from createBureau naming both', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-plugin-code-clash-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const { workflowFileText } = await import('./testing/workflow-file-fixtures.test-support');
    const { layeredWorkflowSource } = await import('./sources/layered-source');
    const { workflowFileDirectory } = await import('./sources/workflow-file-directory');
    const { writeFile, mkdir } = await import('node:fs/promises');
    const owner = join(root, 'owner');
    const content = join(root, 'content');
    await mkdir(owner, { recursive: true });
    await mkdir(content, { recursive: true });
    await writeFile(
      join(content, 'sync.json'),
      workflowFileText('kit:sync', { trigger: { kind: 'schedule', spec: '1h' } }),
    );
    const clash = startWorkflowBureau({
      directory: owner,
      overrides: {
        plugins: [kit([sync()])],
        workflowSource: layeredWorkflowSource([
          workflowFileDirectory(owner, { watch: false }),
          workflowFileDirectory(content, { plugin: 'kit', watch: false }),
        ]),
      },
    });
    const refusal = await rejectionOf(clash);
    expect(refusal).toBeInstanceOf(TypeError);
    expect((refusal as TypeError).message).toMatch(
      /code workflow "kit:sync".*workflow file "kit:sync"/su,
    );
  });
});

describe('a run of a code workflow whose plugin is not loaded', () => {
  it('reports missing, is left resumable, and resumes when the plugin returns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-plugin-code-missing-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const database = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
    cleanups.push(() => database.dispose());
    const diagnostics: BureauDiagnostic[] = [];
    const overrides = {
      get storage() {
        return database.open();
      },
      durableOwnership: { ownership: 'none' },
      onDiagnostic: (diagnostic: BureauDiagnostic) => diagnostics.push(diagnostic),
    } as const;

    const first = await startWorkflowBureau({
      directory: join(root, 'workflows'),
      overrides: { ...overrides, plugins: [kit([wait()])] },
    });
    const started = await first.bureau.workflows!.start('kit:wait', { owner: 'anonymous:local' });
    await first.dispose();

    // The plugin is disabled: its workflow is gone, so it is not listed and a start is refused.
    const second = await startWorkflowBureau({ directory: join(root, 'workflows'), overrides });
    expect(second.bureau.workflows!.codeList()).toEqual([]);
    const refusal = await rejectionOf(
      second.bureau.workflows!.start('kit:wait', { owner: 'anonymous:local' }),
    );
    expect(refusal).toMatchObject({ code: 'NOT_FOUND' });
    const missing = await second.bureau.workflows!.getRun(started.runId);
    expect(missing).toMatchObject({
      workflow: 'kit:wait',
      status: 'running',
      unresumable: { reason: 'missing', workflow: `kit:wait@1.0.0`, availableVersions: [] },
    });
    expect(missing?.unresumable).not.toHaveProperty('activity');
    expect(diagnostics.some((each) => each.message.includes('kit:wait'))).toBe(true);
    // Left in the store, never cancelled.
    expect(await statusOf(second.bureau.durableEngine()!, started.runId)).toBe('running');
    await second.dispose();

    // The plugin returns at the version the run began on: it resumes where it parked.
    const third = await startWorkflowBureau({
      directory: join(root, 'workflows'),
      overrides: { ...overrides, plugins: [kit([wait()])] },
    });
    cleanups.push(() => third.dispose());
    const engine = third.bureau.durableEngine()!;
    await engine.signal(started.runId, 'go', null);
    await waitUntil(async () => (await statusOf(engine, started.runId)) === 'completed');
    const resumed = await third.bureau.workflows!.getRun(started.runId);
    expect(resumed?.unresumable).toBeUndefined();
  });
});

describe('the versioned catalog beside a Bureau that registers a code workflow itself', () => {
  it('registers a host catalog workflow the same way', async () => {
    const catalog = createVersionedCatalog();
    catalog.register({
      kind: 'workflow',
      name: 'host:sync',
      version: '3',
      value: sync(),
      source: { name: 'host', version: '3' },
    });
    expect(createWorkflowContributions(catalog).workflows.get('host:sync')?.version).toBe('3');
    const harness = await startWorkflowBureau({
      overrides: { contributionCatalog: catalog, storage: new MemoryStorage() },
    });
    cleanups.push(() => harness.dispose());
    expect(harness.bureau.workflows!.codeList().map((each) => each.id)).toEqual(['host:sync']);
  });
});
