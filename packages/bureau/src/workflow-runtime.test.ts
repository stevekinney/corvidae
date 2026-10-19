/**
 * COR-1527 — the runtime behind `Bureau.workflows`, against a real engine: what it registers at
 * startup, the revisions it keeps for instances in flight, the two retention steps, the history it
 * records, and the schedules it keeps in line with the files. A "restart" is a new engine over the
 * same storage and the same snapshot store.
 */
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { Engine, MemoryStorage, textValueStore, type TextValueStore } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createWorkflowRuntime, type WorkflowRuntime } from './workflow-runtime';
import { createWorkflowDocumentHost, type AgentStepRequest } from './workflow-host';
import { createWorkflowSnapshotStore } from './workflow-snapshot-store';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A workflow that parks on `go` and then asks the writer a question that names its version. */
function parked(name: string, question: string): Record<string, unknown> {
  return {
    trigger: { kind: 'schedule', spec: '1h' },
    steps: [
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: question } },
    ],
    name,
  };
}

interface World {
  readonly directory: string;
  readonly storage: MemoryStorage;
  readonly store: TextValueStore;
  readonly diagnostics: string[];
  readonly requests: AgentStepRequest[];
  put(id: string, overrides: Record<string, unknown>): Promise<void>;
  remove(id: string): Promise<void>;
  /** A fresh engine over the same storage, with a runtime over the same directory and snapshots. */
  boot(options?: { nowISO?: () => string }): Promise<{
    readonly engine: Engine;
    readonly runtime: WorkflowRuntime;
    readonly start: Awaited<ReturnType<WorkflowRuntime['start']>>;
  }>;
}

async function world(): Promise<World> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-workflow-runtime-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const storage = new MemoryStorage();
  const store = textValueStore(new MemoryStorage());
  const diagnostics: string[] = [];
  const requests: AgentStepRequest[] = [];
  return {
    directory,
    storage,
    store,
    diagnostics,
    requests,
    put: (id, overrides) =>
      writeFile(join(directory, `${id}.json`), workflowFileText(id, overrides)),
    remove: (id) => unlink(join(directory, `${id}.json`)),
    async boot(options = {}) {
      const engine = new Engine({ storage });
      cleanups.push(() => engine[Symbol.asyncDispose]());
      const runtime = createWorkflowRuntime({
        directory,
        engine,
        host: createWorkflowDocumentHost({
          runAgentStep: async (request) => {
            requests.push(request);
            return { content: request.message, output: null, finishReason: 'stop-condition' };
          },
        }),
        snapshotStore: createWorkflowSnapshotStore({
          store,
          nowISO: options.nowISO ?? (() => new Date().toISOString()),
        }),
        runtime: createDefaultRuntimeServices(),
        diagnose: (message) => diagnostics.push(message),
        createError: (message) => new Error(message),
        watch: false,
      });
      cleanups.push(() => runtime.close());
      const start = await runtime.start();
      return { engine, runtime, start };
    },
  };
}

async function versionOf(engine: Engine, workflowId: string): Promise<string | undefined> {
  const state = await engine.get(workflowId);
  return state?.versionTuple.workflowVersion;
}

async function parkedOnSignal(engine: Engine, workflowId: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const timeline = await engine.getTimeline(workflowId);
    if (timeline.some((entry) => entry.operationType === 'wait-signal')) return;
    await Bun.sleep(5);
  }
  throw new Error(`${workflowId} never parked`);
}

describe('starting', () => {
  it('registers every ready file as a workflow type, snapshots it first, and creates its schedule', async () => {
    const w = await world();
    await w.put('digest', parked('digest', 'one'));
    await w.put('broken', { steps: [] });
    const { engine, runtime, start } = await w.boot();

    expect(await engine.workflows.getActive('digest')).not.toBeNull();
    expect(await engine.workflows.getActive('broken')).toBeNull();
    expect(start.retained).toEqual([]);
    const ready = runtime.workflows.list().find((entry) => entry.id === 'digest');
    expect(ready?.state).toBe('ready');
    const snapshot = await createWorkflowSnapshotStore({ store: w.store, nowISO: () => '' }).load(
      'digest',
      ready?.version ?? '',
    );
    expect(snapshot?.document.name).toBe('digest');
    const schedules = await engine.listSchedules({ status: ['active'] });
    expect(schedules.items.map((schedule) => schedule.id)).toEqual([
      'bureau-workflow-schedule:digest:1',
    ]);
  });

  it('is invalid-document for a document the host would not accept, and registers nothing for it', async () => {
    const w = await world();
    await w.put('weird', { trigger: { kind: 'schedule', spec: 'nonsense' } });
    const { engine, runtime } = await w.boot();
    expect(runtime.workflows.list()[0]?.problem?.code).toBe('invalid-document');
    expect(await engine.workflows.getActive('weird')).toBeNull();
  });
});

describe('instances in flight across a restart', () => {
  it('resumes an instance on the revision it began on after the file is edited', async () => {
    const w = await world();
    await w.put('digest', parked('digest', 'version one'));
    {
      const first = await w.boot();
      await first.engine.start('digest', null, { id: 'parked-run' });
      await parkedOnSignal(first.engine, 'parked-run');
      await w.put('digest', parked('digest', 'version two'));
      await first.runtime.workflows.refresh();
      // A new instance runs the new revision; the parked one keeps the old.
      await first.engine.start('digest', null, { id: 'new-run' });
      await first.engine.signal('new-run', 'go', null);
      const newHandle = await first.engine.getHandle('new-run');
      await newHandle?.result();
      expect(await versionOf(first.engine, 'new-run')).not.toBe(
        await versionOf(first.engine, 'parked-run'),
      );
      await first.engine[Symbol.asyncDispose]();
    }

    const second = await w.boot();
    expect(second.start.retained).toHaveLength(1);
    const handles = await second.engine.recoverAll();
    expect(handles.map((handle) => handle.id)).toEqual(['parked-run']);
    const handle = handles[0];
    await handle?.signal('go', null);
    const result = (await handle?.result()) as { content: string };
    expect(result.content).toBe('version one');
    expect(w.requests.at(-1)?.message).toBe('version one');
  });

  it('resumes an instance on the revision it began on after the file is deleted, and starts nothing new', async () => {
    const w = await world();
    await w.put('digest', parked('digest', 'version one'));
    {
      const first = await w.boot();
      await first.engine.start('digest', null, { id: 'parked-run' });
      await parkedOnSignal(first.engine, 'parked-run');
      await w.remove('digest');
      await first.runtime.workflows.refresh();
      // The file is gone: its schedule is cancelled.
      const schedule = await first.engine.getSchedule('bureau-workflow-schedule:digest:1');
      expect(schedule?.status).toBe('cancelled');
      await first.engine[Symbol.asyncDispose]();
    }

    const second = await w.boot();
    expect(second.start.retained.map((entry) => entry.id)).toEqual(['digest']);
    expect(second.runtime.workflows.list()).toEqual([]);
    const live = await second.engine.listSchedules({ status: ['active', 'paused'] });
    expect(live.items).toEqual([]);
    const [handle] = await second.engine.recoverAll();
    await handle?.signal('go', null);
    const outcome = (await handle?.result()) as { content: string } | undefined;
    expect(outcome?.content).toBe('version one');
  });

  it('drops a revision from the retained set once no instance is pinned to it (step one)', async () => {
    const w = await world();
    await w.put('digest', parked('digest', 'version one'));
    {
      const first = await w.boot();
      await first.engine.start('digest', null, { id: 'parked-run' });
      await parkedOnSignal(first.engine, 'parked-run');
      await w.put('digest', parked('digest', 'version two'));
      await first.runtime.workflows.refresh();
      await first.engine[Symbol.asyncDispose]();
    }
    const second = await w.boot();
    expect(second.start.retained).toHaveLength(1);
    const [handle] = await second.engine.recoverAll();
    await handle?.signal('go', null);
    await handle?.result();
    await second.engine[Symbol.asyncDispose]();

    const third = await w.boot();
    expect(third.start.retained).toEqual([]);
  });

  it('reports an instance whose revision was never stored, and carries on', async () => {
    const w = await world();
    await w.put('digest', parked('digest', 'version one'));
    {
      const first = await w.boot();
      await first.engine.start('digest', null, { id: 'parked-run' });
      await parkedOnSignal(first.engine, 'parked-run');
      await w.put('digest', parked('digest', 'version two'));
      await first.runtime.workflows.refresh();
      await first.engine[Symbol.asyncDispose]();
    }
    for (const key of await w.store.list('bureau-workflow-snapshot:v1:digest:')) {
      const snapshot = JSON.parse((await w.store.get(key)) ?? '{}');
      if (snapshot.document?.steps?.[1]?.input?.message === 'version one')
        await w.store.delete(key);
    }
    const second = await w.boot();
    expect(second.start.retained).toEqual([]);
    expect(w.diagnostics.some((message) => message.includes('which is not stored'))).toBe(true);
    expect(second.runtime.workflows.list()[0]?.state).toBe('ready');
  });
});

describe('history', () => {
  it('lists the revisions that have run, newest first, and a revision that never ran is not listed', async () => {
    const w = await world();
    await w.put('digest', parked('digest', 'a'));
    const { engine, runtime } = await w.boot();
    await engine.start('digest', null, { id: 'run-a' });
    await w.put('digest', parked('digest', 'b'));
    await runtime.workflows.refresh();
    await engine.start('digest', null, { id: 'run-b' });
    await w.put('digest', parked('digest', 'c'));
    await runtime.workflows.refresh();

    const revisions = await runtime.workflows.revisions('digest');
    expect(revisions?.map((revision) => revision.document.steps[1])).toEqual([
      { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'b' } },
      { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'a' } },
    ]);
    const listed = runtime.workflows.list()[0]?.version;
    expect(revisions?.some((revision) => revision.workflowVersion === listed)).toBe(false);
  });

  it('is undefined for a workflow with neither a file nor a stored revision', async () => {
    const w = await world();
    const { runtime } = await w.boot();
    expect(await runtime.workflows.revisions('nobody')).toBeUndefined();
  });

  it('adds no revision when a workflow is paused or resumed', async () => {
    const w = await world();
    await w.put('digest', parked('digest', 'a'));
    const { engine, runtime } = await w.boot();
    await engine.start('digest', null, { id: 'run-a' });
    const before = await runtime.workflows.revisions('digest');
    const hash = runtime.workflows.list()[0]?.hash ?? '';
    const paused = await runtime.workflows.pause('digest', { expectedHash: hash });
    const resumed = await runtime.workflows.resume('digest', { expectedHash: paused.hash });
    expect(resumed.hash).not.toBe(hash);
    await engine.start('digest', null, { id: 'run-b' });
    const after = await runtime.workflows.revisions('digest');
    expect(after).toHaveLength(1);
    expect(after?.[0]?.workflowVersion).toBe(before?.[0]?.workflowVersion);
    // And the instance pins the version computed after agent and paused are stripped.
    const pinned = await runtime.workflows.getRun('run-a');
    expect(pinned?.workflowVersion).toBe(runtime.workflows.list()[0]?.version);
  });

  it('restores the history of an instance that started before a crash and was never stamped', async () => {
    const w = await world();
    await w.put('digest', parked('digest', 'a'));
    {
      const first = await w.boot();
      await first.engine.start('digest', null, { id: 'run-a' });
      await parkedOnSignal(first.engine, 'run-a');
      await first.runtime.workflows.revisions('digest');
      await first.engine[Symbol.asyncDispose]();
    }
    // Forget the stamp, as if the process died between the start and the write.
    const snapshots = createWorkflowSnapshotStore({ store: w.store, nowISO: () => '' });
    for (const key of await w.store.list('bureau-workflow-snapshot:v1:digest:')) {
      const stored = JSON.parse((await w.store.get(key)) ?? '{}');
      delete stored.firstRunAt;
      delete stored.lastRunAt;
      await w.store.set(key, JSON.stringify(stored));
    }
    expect(await snapshots.revisions('digest')).toEqual([]);
    const second = await w.boot();
    expect(await second.runtime.workflows.revisions('digest')).toHaveLength(1);
  });
});

describe('retention (step two)', () => {
  it('deletes a revision nothing holds once its last activity is older than the cutoff, and never the current one or one with an instance in flight', async () => {
    const w = await world();
    await w.put('digest', parked('digest', 'a'));
    const { engine, runtime } = await w.boot({ nowISO: () => '2020-01-01T00:00:00.000Z' });
    await engine.start('digest', null, { id: 'run-a' });
    await w.put('digest', parked('digest', 'b'));
    await runtime.workflows.refresh();
    await w.put('digest', parked('digest', 'c'));
    await runtime.workflows.refresh();
    const snapshots = createWorkflowSnapshotStore({ store: w.store, nowISO: () => '' });
    expect(await snapshots.snapshotsOf('digest')).toHaveLength(3);

    // `a` has an instance in flight, `b` is idle and old, `c` is the file's current revision.
    const removed = await runtime.pruneSnapshots(Date.parse('2099-01-01T00:00:00.000Z'));
    expect(removed).toBe(1);
    const left = await snapshots.snapshotsOf('digest');
    expect(left).toHaveLength(2);
    expect(left.map((snapshot) => snapshot.workflowVersion)).toContain(
      runtime.workflows.list()[0]?.version ?? '',
    );

    // Once the instance ends and the cutoff passes it, the old revision goes too.
    await engine.signal('run-a', 'go', null);
    await Bun.sleep(50);
    expect(await runtime.pruneSnapshots(Date.parse('2099-01-01T00:00:00.000Z'))).toBe(1);
    expect(await snapshots.snapshotsOf('digest')).toHaveLength(1);
  });

  it('keeps a revision whose last activity is inside the window', async () => {
    const w = await world();
    await w.put('digest', parked('digest', 'a'));
    const { runtime } = await w.boot();
    await w.put('digest', parked('digest', 'b'));
    await runtime.workflows.refresh();
    expect(await runtime.pruneSnapshots(Date.parse('2000-01-01T00:00:00.000Z'))).toBe(0);
  });
});

describe('assertStartable', () => {
  it('passes for a ready, unpaused workflow and throws a not-found error for a missing, invalid, or paused one', async () => {
    const w = await world();
    await w.put('digest', parked('digest', 'a'));
    await writeFile(join(w.directory, 'broken.json'), '{');
    const { runtime } = await w.boot();
    runtime.workflows.assertStartable('digest');
    expect(() => runtime.workflows.assertStartable('broken')).toThrow('does not exist');
    expect(() => runtime.workflows.assertStartable('missing')).toThrow('does not exist');
    const hash = runtime.workflows.list().find((entry) => entry.id === 'digest')?.hash ?? '';
    await runtime.workflows.pause('digest', { expectedHash: hash });
    expect(() => runtime.workflows.assertStartable('digest')).toThrow('does not exist');
  });
});
