/**
 * COR-1481 — what a recovered `bureau.run()` run publishes to the catalog-run settlement hook
 * (`catalog-run-settlement.ts`), measured through the two subscribers that matter: the task
 * settler and the snapshot-reference settler.
 *
 * Two Bureaus share one SQLite file and one agent directory in this process, with durable
 * ownership off, so the second recovers the run the first started and the first never ends it:
 * the first is the process that died, as far as the second can tell. The third Bureau is the next
 * boot.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { decode, encode } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { AGENT_RUN_REFERENCE_KEY_PREFIX } from './agent-snapshot-store';
import { CATALOG_RUN_RECOVERY_KEY_PREFIX } from './runtime-composition';
import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import type { Bureau, BureauInternals } from './types';
import type { AgentDefinitions } from './agent-catalog';
import {
  createSqliteStorageFixture,
  type PersistentBureauStorageFixture,
} from './test/storage-fixtures';

const PRINCIPAL = 'api-key:alice';
const FILE = agentFileText({ model: KNOWN_MODEL }, 'Instructions.\n');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-recovered-run-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** The run's snapshot reference: `undefined` when it has none; `settledAt` is absent while it holds the snapshot. */
async function referenceOf(
  bureau: { readonly internals: Pick<BureauInternals, 'kv'> },
  runId: string,
): Promise<{ readonly settledAt?: string } | undefined> {
  const raw = await bureau.internals.kv?.get(`${AGENT_RUN_REFERENCE_KEY_PREFIX}${runId}`);
  return raw === null || raw === undefined
    ? undefined
    : (JSON.parse(raw) as { settledAt?: string });
}

/** The status of a run's task, or `undefined` when it has none. */
async function taskStatusOf(
  bureau: { readonly internals: Pick<BureauInternals, 'taskRegistry'> },
  runId: string,
) {
  const task = await bureau.internals.taskRegistry.get(runId);
  return task?.status;
}

/** The status of a run in the durable engine. */
async function durableStatusOf(bureau: Pick<Bureau, 'tasks'>, runId: string) {
  const state = await bureau.tasks.workflow(runId);
  return state?.status;
}

describe('a recovered file-agent run', () => {
  /** The model's answer, held until `release` resolves; `undefined` holds it for ever. */
  async function open(
    directory: string,
    database: PersistentBureauStorageFixture,
    release?: Promise<void>,
  ) {
    const harness: FileBureauHarness = await startFileBureau({
      directory,
      scripts: {
        'claude-opus-5-5': async () => {
          await (release ?? new Promise<never>(() => undefined));
          return 'recovered answer';
        },
      },
      overrides: {
        storage: database.open(),
        durable: true,
        durableOwnership: { ownership: 'none' },
        // No maintenance pass runs: only the hook can settle the reference.
        maintenance: 'manual',
        onDiagnostic: () => undefined,
      },
    });
    cleanups.push(() => harness.dispose());
    return harness;
  }

  async function startRun() {
    const directory = await temporaryDirectory();
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const first = await open(directory, database);
    await first.put('researcher.md', FILE);
    await first.bureau.agents.refresh();
    const run = await first.bureau.tasks.start('researcher', 'long question', {
      principal: PRINCIPAL,
    });
    await waitForCondition(
      async () => (await first.bureau.internals.taskRegistry.record(run.id)) !== undefined,
      'the task is recorded',
    );
    await waitForCondition(
      async () => (await referenceOf(first.bureau, run.id)) !== undefined,
      'the run holds a snapshot reference',
    );
    return { directory, database, runId: run.id };
  }

  it('settles its snapshot reference as soon as the run ends, with no maintenance pass', async () => {
    const { directory, database, runId } = await startRun();
    const release = Promise.withResolvers<void>();
    const second = await open(directory, database, release.promise);
    await second.bureau.recovery();
    const held = await referenceOf(second.bureau, runId);
    expect(held).toBeDefined();
    expect(held?.settledAt).toBeUndefined();

    release.resolve();

    await waitForCondition(
      async () => (await taskStatusOf(second.bureau, runId)) === 'completed',
      'the recovered run settled its task',
    );
    await waitForCondition(async () => {
      const reference = await referenceOf(second.bureau, runId);
      return typeof reference?.settledAt === 'string';
    }, 'the recovered run settled its snapshot reference');
  });

  it('keeps its snapshot reference through maintenance while this process runs it, whatever the engine reports', async () => {
    const { directory, database, runId } = await startRun();
    const second = await open(directory, database);
    await second.bureau.recovery();
    const engine = second.bureau.durableEngine();
    if (engine === undefined) throw new Error('Expected a durable engine.');
    // A recovered task is held by this process's run store, so reconciliation leaves its
    // reference to the run's own end (the test above) and never settles it from the engine. The
    // engine is made to report each status in turn; 'completed' is the one reconciliation would
    // settle for a run this process does not hold, so it is the control that the pass reached it.
    const original = engine.get.bind(engine);
    const reporting = (status: string) =>
      spyOn(engine, 'get').mockImplementation(async (id: string) => {
        const record = await original(id);
        return id === runId && record !== null && record !== undefined
          ? ({ ...record, status } as typeof record)
          : record;
      });

    for (const status of ['pending', 'running', 'suspended', 'completed']) {
      const spy = reporting(status);
      await second.bureau.maintain();
      spy.mockRestore();
      const held = await referenceOf(second.bureau, runId);
      expect([status, held !== undefined, held?.settledAt]).toEqual([status, true, undefined]);
    }
  });

  it('is not settled by a graceful shutdown that interrupts it: its task, its snapshot reference, and its cancel survive for the next boot', async () => {
    const { directory, database, runId } = await startRun();
    const second = await open(directory, database);
    await second.bureau.recovery();
    expect(await taskStatusOf(second.bureau, runId)).toBe('working');

    // A graceful shutdown leaves a task this process recovered, not started, for the next boot.
    await second.bureau.dispose();

    const third = await open(directory, database);
    await third.bureau.recovery();
    expect(await durableStatusOf(third.bureau, runId)).toBe('running');
    expect(await taskStatusOf(third.bureau, runId)).toBe('working');
    const held = await referenceOf(third.bureau, runId);
    expect(held).toBeDefined();
    expect(held?.settledAt).toBeUndefined();
    expect(await third.bureau.internals.taskRegistry.cancel(runId, 0)).toMatchObject({
      receipt: expect.stringMatching(/^(cancel-requested|cleanup-pending|cleaned-up|canceled)$/u),
    });
    await waitForCondition(
      async () => (await taskStatusOf(third.bureau, runId)) === 'canceled',
      'the interrupted task can still be canceled',
    );
  });
});

describe('a recovered child run', () => {
  /**
   * A parent that parks and a child that waits on its own gate. The first process starts both and
   * never ends the child; the second recovers it, and only the second's gate can open.
   */
  async function startChild(childRunId = 'agent-run-child') {
    const directory = await temporaryDirectory();
    const pathFixture = createSqliteStorageFixture({
      path: join(directory, 'bureau.sqlite'),
    });
    cleanups.push(() => pathFixture.dispose());
    const release = Promise.withResolvers<void>();
    // Each process's child waits on its own gate: the first never opens, so only the second
    // process advances the child's checkpoint.
    const childGate = (release?: Promise<void>): GenerateFunction => {
      return async () => {
        await (release ?? new Promise<never>(() => undefined));
        return { content: 'child done', toolCalls: [] };
      };
    };
    let parentCalls = 0;
    const parentGenerate: GenerateFunction = async () => {
      parentCalls += 1;
      return parentCalls > 1
        ? { content: 'parent done', toolCalls: [] }
        : {
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'requestHumanInput',
                arguments: { signalName: 'human-response', prompt: 'Wait?' },
              },
            ],
          };
    };
    const open = (gate?: Promise<void>) =>
      createBureau<AgentDefinitions>({
        id: 'recovered-child',
        agents: {
          worker: createAgent({
            generate: childGate(gate),
            toolbox: createToolbox([]),
            stopWhen: stopWhen.noToolCalls(),
          }),
          default: createAgent({
            generate: parentGenerate,
            toolbox: createToolbox([]),
            stopWhen: stopWhen.some(
              stopWhen.toolCalled('requestHumanInput'),
              stopWhen.noToolCalls(),
            ),
          }),
        },
        storage: pathFixture.open(),
        durable: true,
        durableOwnership: { ownership: 'none' },
        onDiagnostic: () => undefined,
      });
    const first = await open();
    cleanups.push(() => first.dispose());
    const parent = await first.tasks.start('default', 'parent', { principal: PRINCIPAL });
    await waitForCondition(
      () => first.reviews.list().some((review) => review.runId === parent.id),
      'the parent parks',
    );
    await first.children.dispatch({
      parentRunId: parent.id,
      agentName: 'worker',
      input: 'help',
      childRunId,
    });
    await waitForCondition(
      async () => (await durableStatusOf(first, childRunId)) === 'running',
      'the child run is running',
    );
    await waitForCondition(
      async () => (await first.internals.taskRegistry.record(childRunId)) !== undefined,
      'the child task is recorded',
    );
    return { first, parent, open, release, childRunId };
  }

  it('settles the task its start admitted, and writes no second record', async () => {
    const { first, parent, open, release, childRunId } = await startChild();
    const admitted = await first.internals.taskRegistry.record(childRunId);
    // The second process recovers the child run the first one is still holding.
    const second = await open(release.promise);
    cleanups.push(() => second.dispose());
    await second.recovery();

    release.resolve();

    await waitForCondition(
      async () => (await durableStatusOf(second, childRunId)) === 'completed',
      'the recovered child run ended',
    );
    await waitForCondition(
      async () => (await taskStatusOf(second, childRunId)) === 'completed',
      'the child task settled',
    );
    const record = await second.internals.taskRegistry.record(childRunId);
    expect(record).toMatchObject({
      origin: { kind: 'agent', parentRunId: parent.id, agentName: 'default' },
      settled: { status: 'completed', answer: { text: 'child done' } },
    });
    // The same record the start wrote, settled; recovery wrote no second one.
    expect(record?.createdAt).toBe(admitted?.createdAt);
    const listed = await second.internals.taskRegistry.enumerate({
      parentRunId: parent.id,
      limit: 50,
      offset: 0,
    });
    expect(listed.tasks.map((task) => task.id)).toEqual([childRunId]);
  });

  it('rebuilds the task from its claim when the admission was lost in a crash', async () => {
    const { first, parent, open, release, childRunId } = await startChild();
    // The crash between the start and the admission: the run is in flight and has no task.
    await first.internals.taskRegistry.remove(childRunId);
    expect(await first.internals.taskRegistry.record(childRunId)).toBeUndefined();

    const second = await open(release.promise);
    cleanups.push(() => second.dispose());
    await second.recovery();

    // Rebuilt by the boot, while the run is still in flight, from what the claim stored.
    const rebuilt = await second.internals.taskRegistry.record(childRunId);
    expect(rebuilt).toMatchObject({
      contextId: childRunId,
      agentName: 'worker',
      origin: { kind: 'agent', parentRunId: parent.id, agentName: 'default' },
    });
    expect(rebuilt?.settled).toBeUndefined();
    release.resolve();
    await waitForCondition(
      async () => (await taskStatusOf(second, childRunId)) === 'completed',
      'the rebuilt task settled',
    );
  });

  it('rebuilds the task of a run that ends before the boot finds it, from the settlement hook', async () => {
    const { first, open, release, childRunId } = await startChild();
    await first.internals.taskRegistry.remove(childRunId);
    const second = await open(release.promise);
    cleanups.push(() => second.dispose());
    release.resolve();

    await second.recovery();

    await waitForCondition(
      async () => (await taskStatusOf(second, childRunId)) === 'completed',
      'the task is written from the claim and settled',
    );
    const written = await second.internals.taskRegistry.record(childRunId);
    expect(written?.origin).toMatchObject({
      kind: 'agent',
    });
  });

  it('stays a non-task when its claim was written before child runs were tasks', async () => {
    const { first, open, release, childRunId } = await startChild();
    // A child claimed before the field existed: the claim carries no `taskOrigin`.
    const storage = first.durableEngine()!.storage;
    const key = `${CATALOG_RUN_RECOVERY_KEY_PREFIX}${childRunId}`;
    const claim = decode((await storage.get(key))!) as Record<string, unknown>;
    expect(claim['taskOrigin']).toMatchObject({ kind: 'agent' });
    delete claim['taskOrigin'];
    await storage.put(key, encode(claim));
    await first.internals.taskRegistry.remove(childRunId);
    const second = await open(release.promise);
    cleanups.push(() => second.dispose());
    await second.recovery();

    release.resolve();

    await waitForCondition(
      async () => (await durableStatusOf(second, childRunId)) === 'completed',
      'the recovered child run ended',
    );
    // Let the settlement the run's end published reach its subscribers.
    await second.internals.taskRegistry.idle();
    expect(await second.internals.taskRegistry.record(childRunId)).toBeUndefined();
    const listed = await second.internals.taskRegistry.enumerate({ limit: 50, offset: 0 });
    expect(listed.tasks.map((task) => task.id)).not.toContain(childRunId);
  });
});
