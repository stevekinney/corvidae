/**
 * A plugin's workflow file, named `linear:sync`, against a real engine. Weft's name grammar has no
 * `:`, so the engine knows the workflow as `linear__sync`, as it knows a `plugin:name` handler
 * (COR-1871); everything Bureau reports names it `linear:sync`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { Engine, workflow } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { layeredWorkflowSource } from './sources/layered-source';
import { workflowFileDirectory } from './sources/workflow-file-directory';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { createWorkflowDocumentHost } from './workflow-host';
import { createWorkflowRuntime } from './workflow-runtime';
import { createWorkflowSnapshotStore } from './workflow-snapshot-store';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A plugin workflow on an hourly schedule, so no fire lands while a test runs. */
const SYNC = workflowFileText('linear:sync', { trigger: { kind: 'schedule', spec: '1h' } });

/** An owner directory and the `linear` plugin's layer holding `sync.json`, over one storage. */
async function world() {
  const owner = await mkdtemp(join(tmpdir(), 'bureau-plugin-workflow-owner-'));
  const plugin = await mkdtemp(join(tmpdir(), 'bureau-plugin-workflow-linear-'));
  cleanups.push(() => rm(owner, { recursive: true, force: true }));
  cleanups.push(() => rm(plugin, { recursive: true, force: true }));
  await writeFile(join(plugin, 'sync.json'), SYNC);
  const storage = new MemoryStorage();
  const store = textValueStore(new MemoryStorage());
  const diagnostics: string[] = [];

  /** A fresh engine over the same storage and snapshots: a restart. */
  async function boot(prepare?: (engine: Engine) => void) {
    const engine = new Engine({ storage });
    cleanups.push(() => engine[Symbol.asyncDispose]());
    prepare?.(engine);
    const runtime = createWorkflowRuntime({
      source: layeredWorkflowSource([
        workflowFileDirectory(owner, { watch: false }),
        workflowFileDirectory(plugin, { plugin: 'linear', watch: false }),
      ]),
      engine,
      host: createWorkflowDocumentHost({
        runAgentStep: async (request) => ({
          content: request.message,
          output: null,
          finishReason: 'stop-condition',
        }),
      }),
      snapshotStore: createWorkflowSnapshotStore({ store, nowISO: () => new Date().toISOString() }),
      runtime: createDefaultRuntimeServices(),
      diagnose: (message) => diagnostics.push(message),
      createError: (message) => new Error(message),
    });
    cleanups.push(() => runtime.close());
    await runtime.start();
    return { engine, runtime };
  }

  return { boot, diagnostics };
}

describe('a plugin workflow', () => {
  it('registers as ready, runs, and reports its runs and revisions as linear:sync', async () => {
    const { boot } = await world();
    const { engine, runtime } = await boot();

    expect(runtime.workflows.list()).toMatchObject([{ id: 'linear:sync', state: 'ready' }]);

    const started = await runtime.workflows.start('linear:sync', { owner: 'anonymous:local' });
    expect(started.workflow).toBe('linear:sync');
    // The engine holds the instance under the mapped name its grammar accepts.
    const instance = await engine.get(started.runId);
    expect(instance?.type).toBe('linear__sync');
    await waitUntil(async () => {
      const state = await engine.get(started.runId);
      return state?.status === 'completed';
    });

    const run = await runtime.workflows.getRun(started.runId);
    expect(run?.workflow).toBe('linear:sync');
    const { runs } = await runtime.workflows.listRuns({
      workflow: 'linear:sync',
      offset: 0,
      limit: 10,
    });
    expect(runs.map((run) => [run.id, run.workflow])).toEqual([[started.runId, 'linear:sync']]);
    expect(await runtime.workflows.runCounts('linear:sync')).toMatchObject({ last24Hours: 1 });

    const revisions = await runtime.workflows.revisions('linear:sync');
    expect(revisions).toMatchObject([{ id: 'linear:sync', compatibility: { compatible: true } }]);
  });

  it('keeps one schedule under the mapped name across a restart', async () => {
    const { boot } = await world();
    const first = await boot();

    const before = await first.engine.listSchedules({ status: ['active', 'paused'], limit: 100 });
    expect(before.items.map((schedule) => [schedule.id, schedule.workflowType])).toEqual([
      ['bureau-workflow-schedule:linear:sync:1', 'linear__sync'],
    ]);
    const detail = await first.runtime.workflows.get('linear:sync');
    expect(detail?.schedule).toMatchObject({
      id: 'bureau-workflow-schedule:linear:sync:1',
      status: 'active',
    });

    await first.runtime.close();
    const second = await boot();
    const after = await second.engine.listSchedules({ status: ['active', 'paused'], limit: 100 });
    expect(after.items.map((schedule) => schedule.id)).toEqual([
      'bureau-workflow-schedule:linear:sync:1',
    ]);
  });

  it('is shadowed by a code workflow the engine already has under the mapped name', async () => {
    const { boot } = await world();
    const { runtime } = await boot((engine) => {
      engine.register(
        workflow({ name: 'linear__sync' }).execute(async function* () {
          return 'code workflow';
        }),
      );
    });

    expect(runtime.workflows.list()).toMatchObject([
      { id: 'linear:sync', state: 'invalid', problem: { code: 'shadows-code-workflow' } },
    ]);
  });
});
