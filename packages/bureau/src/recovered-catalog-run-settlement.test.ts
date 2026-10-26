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
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { AGENT_RUN_REFERENCE_KEY_PREFIX } from './agent-snapshot-store';
import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';

const PRINCIPAL = 'api-key:alice';
const FILE = agentFileText({ model: KNOWN_MODEL }, 'Instructions.\n');
const ATTEMPTS = 400;

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
  bureau: Pick<Bureau, 'kv'>,
  runId: string,
): Promise<{ readonly settledAt?: string } | undefined> {
  const raw = await bureau.kv?.get(`${AGENT_RUN_REFERENCE_KEY_PREFIX}${runId}`);
  return raw === null || raw === undefined
    ? undefined
    : (JSON.parse(raw) as { settledAt?: string });
}

/** The status of a run's task, or `undefined` when it has none. */
async function taskStatusOf(bureau: Pick<Bureau, 'tasks'>, runId: string) {
  const task = await bureau.tasks.get(runId);
  return task?.status;
}

/** The status of a run in the durable engine. */
async function durableStatusOf(bureau: Pick<Bureau, 'getDurableRun'>, runId: string) {
  const state = await bureau.getDurableRun(runId);
  return state?.status;
}

describe('a recovered file-agent run', () => {
  /** The model's answer, held until `release` resolves; `undefined` holds it for ever. */
  async function open(directory: string, storagePath: string, release?: Promise<void>) {
    const harness: FileBureauHarness = await startFileBureau({
      directory,
      scripts: {
        'claude-opus-5-5': async () => {
          await (release ?? new Promise<never>(() => undefined));
          return 'recovered answer';
        },
      },
      overrides: {
        storage: { type: 'sqlite', path: storagePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        // No maintenance pass runs: only the hook can settle the reference.
        durableBackgroundTasks: 'manual',
        onDiagnostic: () => undefined,
      },
    });
    cleanups.push(() => harness.dispose());
    return harness;
  }

  async function startRun() {
    const directory = await temporaryDirectory();
    const storagePath = join(directory, 'bureau.sqlite');
    const first = await open(directory, storagePath);
    await first.put('researcher.md', FILE);
    await first.bureau.agents.refresh();
    const run = first.bureau.run('researcher', 'long question', { principal: PRINCIPAL });
    await waitForCondition(
      async () => (await first.bureau.tasks.record(run.id)) !== undefined,
      'the task is recorded',
      ATTEMPTS,
    );
    await waitForCondition(
      async () => (await referenceOf(first.bureau, run.id)) !== undefined,
      'the run holds a snapshot reference',
      ATTEMPTS,
    );
    return { directory, storagePath, runId: run.id };
  }

  it('settles its snapshot reference as soon as the run ends, with no maintenance pass', async () => {
    const { directory, storagePath, runId } = await startRun();
    const release = Promise.withResolvers<void>();
    const second = await open(directory, storagePath, release.promise);
    await second.bureau.waitForRecovery?.();
    const held = await referenceOf(second.bureau, runId);
    expect(held).toBeDefined();
    expect(held?.settledAt).toBeUndefined();

    release.resolve();

    await waitForCondition(
      async () => (await taskStatusOf(second.bureau, runId)) === 'completed',
      'the recovered run settled its task',
      ATTEMPTS,
    );
    await waitForCondition(
      async () => {
        const reference = await referenceOf(second.bureau, runId);
        return typeof reference?.settledAt === 'string';
      },
      'the recovered run settled its snapshot reference',
      ATTEMPTS,
    );
  });

  it('keeps its snapshot reference through maintenance for as long as the engine reports it unfinished', async () => {
    const { directory, storagePath, runId } = await startRun();
    const second = await open(directory, storagePath);
    await second.bureau.waitForRecovery?.();
    const engine = second.bureau.durableEngine();
    if (engine === undefined) throw new Error('Expected a durable engine.');
    // The recovered run is in no store and holds no handle in this process, so reconciliation
    // decides from the engine alone. The engine is made to report each status in turn.
    const original = engine.get.bind(engine);
    const reporting = (status: string) =>
      spyOn(engine, 'get').mockImplementation(async (id: string) => {
        const record = await original(id);
        return id === runId && record !== null && record !== undefined
          ? ({ ...record, status } as typeof record)
          : record;
      });

    for (const status of ['pending', 'running', 'suspended']) {
      const spy = reporting(status);
      await second.bureau.runDurableMaintenance();
      spy.mockRestore();
      const held = await referenceOf(second.bureau, runId);
      expect([status, held !== undefined, held?.settledAt]).toEqual([status, true, undefined]);
    }

    // The same pass settles it once the engine reports the run over, so the assertions above
    // are not vacuous: reconciliation does reach this run.
    const ended = reporting('completed');
    await second.bureau.runDurableMaintenance();
    ended.mockRestore();
    const settled = await referenceOf(second.bureau, runId);
    expect(typeof settled?.settledAt).toBe('string');
  });

  it('is not settled by a graceful shutdown that interrupts it: its task, its snapshot reference, and its cancel survive for the next boot', async () => {
    const { directory, storagePath, runId } = await startRun();
    const second = await open(directory, storagePath);
    await second.bureau.waitForRecovery?.();
    expect(await taskStatusOf(second.bureau, runId)).toBe('working');

    // Disposing the engine rejects the recovered run's result: the run is cut short, not over.
    await second.bureau.dispose();

    const third = await open(directory, storagePath);
    await third.bureau.waitForRecovery?.();
    expect(await durableStatusOf(third.bureau, runId)).toBe('running');
    expect(await taskStatusOf(third.bureau, runId)).toBe('working');
    const held = await referenceOf(third.bureau, runId);
    expect(held).toBeDefined();
    expect(held?.settledAt).toBeUndefined();
    expect(await third.bureau.tasks.cancel(runId, 0)).toMatchObject({
      receipt: expect.stringMatching(/^(cancel-requested|cleanup-pending|cleaned-up|canceled)$/u),
    });
    await waitForCondition(
      async () => (await taskStatusOf(third.bureau, runId)) === 'canceled',
      'the interrupted task can still be canceled',
      ATTEMPTS,
    );
  });
});

describe('a recovered child run', () => {
  it('is not a task: it gets no record and is absent from the task list', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'bureau.sqlite');
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
        storage: { type: 'sqlite', path },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        onDiagnostic: () => undefined,
      });
    const first = await open();
    cleanups.push(() => first.dispose());
    const parent = await first.createRun({
      agentName: 'default',
      message: 'parent',
      principal: PRINCIPAL,
    });
    await waitForCondition(
      () => first.listPendingReviews().some((review) => review.runId === parent.id),
      'the parent parks',
      ATTEMPTS,
    );
    await first.children.dispatch({
      parentRunId: parent.id,
      agentName: 'worker',
      input: 'help',
      childRunId: 'agent-run-child',
    });
    await waitForCondition(
      async () => (await durableStatusOf(first, 'agent-run-child')) === 'running',
      'the child run is running',
      ATTEMPTS,
    );
    // The second process recovers the child run the first one is still holding.
    const second = await open(release.promise);
    cleanups.push(() => second.dispose());
    await second.waitForRecovery?.();

    release.resolve();

    await waitForCondition(
      async () => (await durableStatusOf(second, 'agent-run-child')) === 'completed',
      'the recovered child run ended',
      ATTEMPTS,
    );
    // Let the settlement the run's end published reach its subscribers.
    await second.tasks.idle();
    expect(await second.tasks.record('agent-run-child')).toBeUndefined();
    const listed = await second.tasks.enumerate({ limit: 50, offset: 0 });
    expect(listed.tasks.map((task) => task.id)).not.toContain('agent-run-child');
  });
});
