/**
 * COR-2244 — what a plugin's code workflow `kit:sync` looks like beside the workflow files on the
 * wire (`bureau.workflows.list` and the `workflows-list` tool: entries with `kind: 'code'`, file
 * entries unchanged), what a content file that starts to clash after startup does (matrix row B2),
 * and how its plugin's listing counts a run waiting on a workflow the plugin no longer loads (C7).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin, type PluginWorkflow } from '@lostgradient/interborough-plugin';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { workflow } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { BureauDiagnostic } from './bureau-types/options';
import { createBureauHandler } from './http/create-bureau-handler';
import { authentication, rpc } from './http/management/management-fixtures.test-support';
import { ownerRpc, serveWorkflows } from './http/management/workflows-fixtures.test-support';
import { layeredWorkflowSource } from './sources/layered-source';
import { workflowFileDirectory } from './sources/workflow-file-directory';
import { listedPlugins } from './testing/plugin-listing.test-support';
import { startWorkflowBureau } from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { startWorkflowToolsBureau } from './testing/workflow-tools-bureau.test-support';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const sync = (): PluginWorkflow => ({
  ...workflow({ name: 'sync' }).execute(async function* (_context, input: unknown) {
    yield* [];
    return input;
  }),
  title: 'Sync issues',
  inputSchema: z.object({ team: z.string() }),
});

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

const CODE_ENTRY = {
  kind: 'code',
  id: 'kit:sync',
  name: 'sync',
  title: 'Sync issues',
  plugin: 'kit',
  version: '1.0.0',
};

describe('the wire listing of a plugin code workflow', () => {
  it('bureau.workflows.list appends a code entry after the file entries and leaves them unchanged', async () => {
    const definition = {
      agent: 'writer',
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [{ kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Go' } }],
    };
    // The same file in a Bureau with no plugin: the entry it gets there is the one it keeps.
    const plain = await serveWorkflows(cleanups);
    await plain.bureau.workflows!.create('digest', definition);
    const plainList = await ownerRpc(plain.owner, 'bureau.workflows.list', {});
    const baseline = plainList.result?.['workflows'] as Array<Record<string, unknown>>;
    expect(baseline.map((entry) => entry['id'])).toEqual(['digest']);

    const served = await serveWorkflows(cleanups, { plugins: [kit([sync()])] });
    await served.bureau.workflows!.create('digest', definition);

    const listed = await ownerRpc(served.owner, 'bureau.workflows.list', {});
    expect(listed.error).toBeUndefined();
    const entries = listed.result?.['workflows'] as Array<Record<string, unknown>>;
    expect(entries.map((entry) => entry['id'])).toEqual(['digest', 'kit:sync']);
    // The file entry keeps every member it had; the code entry has none of them.
    expect(entries[0]).toEqual(baseline[0]);
    expect(entries[0]).toMatchObject({ state: 'ready', paused: false, runs: null });
    expect(entries[0]).not.toHaveProperty('kind');
    expect(entries[1]).toEqual(CODE_ENTRY);
    expect(listed.result?.['nextOffset']).toBeNull();

    // Paging runs over the files and then the code workflows.
    const second = await ownerRpc(served.owner, 'bureau.workflows.list', { limit: 1, offset: 1 });
    expect(second.result?.['workflows']).toEqual([CODE_ENTRY]);
    expect(second.result?.['nextOffset']).toBeNull();
    const first = await ownerRpc(served.owner, 'bureau.workflows.list', { limit: 1 });
    const firstPage = first.result?.['workflows'] as Array<{ id: string }>;
    expect(firstPage.map((entry) => entry.id)).toEqual(['digest']);
    expect(first.result?.['nextOffset']).toBe(1);
  });

  it('the workflows-list tool appends the code entry and leaves a file entry as it was', async () => {
    const harness = await startWorkflowToolsBureau({ overrides: { plugins: [kit([sync()])] } });
    cleanups.push(() => harness.dispose());
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [
        { kind: 'activity', handler: 'agent', input: { agent: 'scribe', message: 'Write it' } },
      ],
    });
    const hash = harness.bureau.workflows!.list().find((entry) => entry.id === 'digest')!.hash;

    const { result } = await harness.callTool('bureau__workflows-list', {});

    expect(result).toEqual({
      status: 'ok',
      workflows: [
        {
          id: 'digest',
          hash,
          state: 'ready',
          paused: false,
          triggerKind: 'schedule',
          title: null,
          description: null,
          inputSchema: null,
          outputSchema: null,
          problem: null,
        },
        CODE_ENTRY,
      ],
    });
  });
});

describe('bureau.workflows.catalog', () => {
  const lookup = {
    name: 'lookup',
    version: '1.0.0',
    title: 'Look something up',
    description: 'Finds a record.',
    inputSchema: z.object({ query: z.string() }),
    execute: () => 'found',
  };
  const catalogPlugin = () => ({
    descriptor: definePlugin({
      name: 'kit',
      version: '1.0.0',
      description: 'Contributes an activity and code workflows.',
      setup: () => ({ activities: [lookup], workflows: [sync(), wait()] }),
    }),
    source: 'package' as const,
    location: '@example/kit',
  });

  it('answers the registered activities and code workflows, each with its title and input schema', async () => {
    const served = await serveWorkflows(cleanups, { plugins: [catalogPlugin()] });
    const response = await ownerRpc(served.owner, 'bureau.workflows.catalog', {});
    expect(response.error).toBeUndefined();
    const catalog = response.result as {
      activities: Array<{ id: string; title: string | null; inputSchema: unknown }>;
      workflows: Array<{ id: string; name: string; title: string; inputSchema: unknown }>;
    };
    const activity = catalog.activities.find((entry) => entry.id === 'kit:lookup');
    expect(activity).toMatchObject({
      title: 'Look something up',
      description: 'Finds a record.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    });
    expect(catalog.activities.map((entry) => entry.id)).toContain('agent');
    expect(catalog.workflows).toEqual([
      {
        id: 'kit:sync',
        name: 'sync',
        title: 'Sync issues',
        inputSchema: expect.objectContaining({
          type: 'object',
          properties: { team: { type: 'string' } },
        }),
      },
      { id: 'kit:wait', name: 'wait', title: 'Wait', inputSchema: expect.anything() },
    ]);
  });

  it('answers no code workflow for a Bureau with no plugin', async () => {
    const served = await serveWorkflows(cleanups);
    const response = await ownerRpc(served.owner, 'bureau.workflows.catalog', {});
    expect(response.result?.['workflows']).toEqual([]);
  });

  it('refuses a caller who holds neither the read scope nor the deployment', async () => {
    const served = await serveWorkflows(cleanups, { plugins: [catalogPlugin()] });
    const denied = await rpc(served.keyed, 'bureau.workflows.catalog', {}, 'workflows-writer-key');
    expect(denied.result).toBeUndefined();
    expect(denied.error?.data?.httpStatus).toBe(403);
    const reader = await rpc(served.keyed, 'bureau.workflows.catalog', {}, 'workflows-reader-key');
    expect(reader.error).toBeUndefined();
    expect(reader.result?.['workflows']).toHaveLength(2);
  });

  it('is the catalog the workflows-catalog tool returns for the same Bureau', async () => {
    const harness = await startWorkflowToolsBureau({
      overrides: { plugins: [catalogPlugin()] },
    });
    cleanups.push(() => harness.dispose());
    const { result } = await harness.callTool('bureau__workflows-catalog', {});
    const { status, ...fromTool } = result as { status: string } & Record<string, unknown>;
    expect(status).toBe('ok');
    const wire = await rpc(
      createBureauHandler(harness.bureau, { authentication }),
      'bureau.workflows.catalog',
      {},
      'workflows-reader-key',
    );
    expect(wire.error).toBeUndefined();
    expect(wire.result).toEqual(fromTool);
    expect((wire.result?.['workflows'] as unknown[]).length).toBe(2);
  });
});

describe('a content file that starts to clash with a code workflow after startup (B2)', () => {
  it('keeps the per-file diagnostic, and the code workflow keeps running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-plugin-code-rescan-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const owner = join(root, 'owner');
    const content = join(root, 'content');
    await mkdir(owner, { recursive: true });
    await mkdir(content, { recursive: true });
    const harness = await startWorkflowBureau({
      directory: owner,
      overrides: {
        plugins: [kit([sync()])],
        workflowSource: layeredWorkflowSource([
          workflowFileDirectory(owner, { watch: false }),
          workflowFileDirectory(content, { plugin: 'kit', watch: false }),
        ]),
      },
    });
    cleanups.push(() => harness.dispose());
    const workflows = harness.bureau.workflows!;
    expect(workflows.list()).toEqual([]);

    await writeFile(
      join(content, 'sync.json'),
      workflowFileText('kit:sync', { trigger: { kind: 'schedule', spec: '1h' } }),
    );
    await workflows.refresh();

    // The startup error cannot fire now: the file is the one that is invalid, as for any shadow.
    expect(workflows.list()).toMatchObject([
      { id: 'kit:sync', state: 'invalid', problem: { code: 'shadows-code-workflow' } },
    ]);
    expect(workflows.codeList().map((each) => each.id)).toEqual(['kit:sync']);
    const started = await workflows.start('kit:sync', {
      owner: 'anonymous:local',
      input: { team: 'core' },
    });
    const engine = harness.bureau.durableEngine()!;
    await waitUntil(async () => {
      const state = await engine.get(started.runId);
      return state?.status === 'completed';
    });
    expect(await workflows.getRun(started.runId)).toMatchObject({
      workflow: 'kit:sync',
      status: 'completed',
      result: { input: { team: 'core' } },
    });
  });
});

describe('the plugin listing while a run waits on a code workflow the plugin no longer loads (C7)', () => {
  it('shows pinned-version-unavailable counting the waiting run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-plugin-code-pinned-'));
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

    // The plugin loads again, at the same version, without the workflow: the run waits on it.
    const second = await startWorkflowBureau({
      directory: join(root, 'workflows'),
      overrides: { ...overrides, plugins: [kit([])] },
    });
    cleanups.push(() => second.dispose());
    const [listing] = await listedPlugins(second.bureau);
    expect(listing?.problems).toEqual([
      { code: 'pinned-version-unavailable', id: 'kit:wait', version: '1.0.0', waitingRuns: 1 },
    ]);
    expect(await second.bureau.workflows!.getRun(started.runId)).toMatchObject({
      status: 'running',
      unresumable: { reason: 'missing', workflow: 'kit:wait@1.0.0' },
    });
  });
});
