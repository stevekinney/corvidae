/**
 * COR-1946 — a task whose run lives only in its process is settled at the next boot when, and only
 * when, the process that owned it is gone.
 *
 * Each "process" is a Bureau with `durable: false` (so every run is process-local) over one SQLite
 * file, with its own manual runtime. A process that "crashes" is one whose runtime is never
 * advanced again, so it renews nothing and its lease lapses against the booting process's clock; a
 * live peer is one whose runtime is advanced, so its renewal timer keeps its lease ahead of that
 * clock. Nothing sleeps. The real-SIGKILL rows are in `process-local-task-crash.slow.test.ts`.
 *
 * | row                                                  | result                        | source                                  |
 * | ---------------------------------------------------- | ----------------------------- | --------------------------------------- |
 * | owner crashed, no other process                      | failed, `owner-lost`          | lease expired by the booter's clock     |
 * | owner crashed, peer alive                            | crashed: failed; peer: working | per-owner lease                         |
 * | owner alive, peer boots                              | working                       | lease current                           |
 * | owner stalled past its lease, renewed before the boot | working                       | the renewal is the lease                |
 * | restarted inside the lease                           | working, then failed at lapse | the sweep looks again when it lapses    |
 * | stalled owner settles after a peer did               | stays failed, `owner-lost`    | the settlement is final                 |
 * | record with no owner marker (legacy)                 | working                       | nothing says whose it is                |
 * | child of a crashed parent                            | failed, `owner-lost`          | the child's own marker, not the parent's |
 * | lease renewed between the read and the write         | nothing written               | compare-and-swap on the lease value     |
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { processLeaseKey } from './process-lease';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import type { TaskRecord } from './task-registry';
import type { Bureau } from './types';

const ORIGIN_MS = Date.parse('2026-10-30T00:00:00.000Z');
const SECOND = 1_000;
const PRINCIPAL = 'api-key:alice';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

interface Process {
  readonly bureau: Bureau<AgentDefinitions>;
  readonly runtime: ManualRuntimeServices;
  /** Lets every parked run of this process finish. */
  readonly finishRuns: () => void;
  readonly storage: ReturnType<ReturnType<typeof createSqliteStorageFixture>['open']>;
}

/** A parked run ends when this process lets it, or fails when it is aborted (shutdown). */
function parkedUntil(finish: Promise<void>): GenerateFunction {
  return ({ signal }) =>
    new Promise((resolve, reject) => {
      void finish.then(() => resolve({ content: 'done', toolCalls: [] }));
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}

async function boot(
  database: ReturnType<typeof createSqliteStorageFixture>,
  atMilliseconds: number,
  maintenance: 'automatic' | 'manual' = 'automatic',
): Promise<Process> {
  const runtime = createManualRuntimeServices({ origin: new Date(atMilliseconds).toISOString() });
  let finishRuns = (): void => undefined;
  const finish = new Promise<void>((resolve) => {
    finishRuns = resolve;
  });
  const storage = database.open();
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: parkedUntil(finish),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
      worker: createAgent({
        generate: parkedUntil(finish),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage,
    durable: false,
    runtime,
    maintenance,
    onDiagnostic: () => undefined,
  });
  cleanups.push(async () => {
    finishRuns();
    await bureau.shutdown();
  });
  return { bureau, runtime, finishRuns, storage };
}

async function recordOf(process: Process, taskId: string): Promise<TaskRecord | undefined> {
  return await process.bureau.internals.taskRegistry.record(taskId);
}

async function startTask(process: Process): Promise<string> {
  const task = await process.bureau.tasks.start('default', 'work', { principal: PRINCIPAL });
  return task.id;
}

async function settledOf(booter: Process, taskId: string) {
  const record = await recordOf(booter, taskId);
  return record?.settled;
}

/** One process of a row: it starts a task (and optionally a child of it), then runs for a while. */
interface Owner {
  readonly name: string;
  /** How far its clock is advanced after it started its task: renewals fire every 10 s of it. */
  readonly advanceSeconds: number;
  /** Rewrites its records as a release before the owner marker wrote them. */
  readonly legacy?: boolean;
  /** Also starts a child run of its task. */
  readonly withChild?: boolean;
}

interface Row {
  readonly name: string;
  readonly owners: readonly Owner[];
  /** When the booting process starts, in seconds after the owners did. */
  readonly bootAtSeconds: number;
  /** What the first boot leaves each owner's tasks as. */
  readonly expected: Readonly<Record<string, 'settled-lost' | 'untouched'>>;
}

/** An owner that never advances: it renews nothing, so its lease ends at 30 s. */
const CRASHED: Owner = { name: 'crashed', advanceSeconds: 0 };
/** An owner advanced to 25 s: it renewed at 10 s and 20 s, so its lease runs to 50 s. */
const ALIVE: Owner = { name: 'alive', advanceSeconds: 25 };

const ROWS: readonly Row[] = [
  {
    name: 'owner crashed, no other process',
    owners: [CRASHED],
    bootAtSeconds: 31,
    expected: { crashed: 'settled-lost' },
  },
  {
    name: 'owner crashed, peer alive',
    owners: [CRASHED, ALIVE],
    bootAtSeconds: 31,
    expected: { crashed: 'settled-lost', alive: 'untouched' },
  },
  {
    name: 'owner alive, peer boots',
    owners: [{ ...ALIVE, advanceSeconds: 0 }],
    bootAtSeconds: 5,
    expected: { alive: 'untouched' },
  },
  {
    name: 'owner stalled past its first lease but renewed before the boot looked',
    owners: [ALIVE],
    bootAtSeconds: 31,
    expected: { alive: 'untouched' },
  },
  {
    name: 'record with no owner marker (written before this change)',
    owners: [{ ...CRASHED, name: 'legacy', legacy: true }],
    bootAtSeconds: 31,
    expected: { legacy: 'untouched' },
  },
  {
    name: 'child task of a crashed parent',
    owners: [{ ...CRASHED, withChild: true }],
    bootAtSeconds: 31,
    expected: { crashed: 'settled-lost' },
  },
];

/** Removes the owner marker from a record, as a release before this change wrote it. */
async function stripOwnerMarker(process: Process, taskId: string): Promise<void> {
  const kv = textValueStore(process.storage);
  const keys = await kv.list('bureau-task:v1:');
  const key = keys.find((candidate) => candidate.endsWith(taskId));
  if (key === undefined) throw new Error(`no task record for ${taskId}`);
  const record = JSON.parse((await kv.get(key)) ?? '{}') as Record<string, unknown>;
  delete record['ownerProcess'];
  await kv.set(key, JSON.stringify(record));
}

describe('a crashed process’s local tasks are settled by the next boot', () => {
  it.each(ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const taskIds = new Map<string, string[]>();
    for (const owner of row.owners) {
      const process = await boot(database, ORIGIN_MS);
      const ids: string[] = [];
      const taskId = await startTask(process);
      ids.push(taskId);
      if (owner.withChild === true) {
        const childRunId = `${owner.name}-child-run`;
        await process.bureau.children.dispatch({
          parentRunId: taskId,
          agentName: 'worker',
          input: 'help',
          childRunId,
        });
        await waitUntil(async () => (await recordOf(process, childRunId)) !== undefined, {
          message: 'the child task is recorded',
        });
        ids.push(childRunId);
      }
      if (owner.advanceSeconds > 0) {
        await process.runtime.advance(owner.advanceSeconds * SECOND);
        const admitted = await recordOf(process, taskId);
        const ownerProcess = admitted?.ownerProcess ?? '';
        await waitUntil(
          async () => {
            const raw = await textValueStore(process.storage).get(processLeaseKey(ownerProcess));
            return (
              raw !== null &&
              (JSON.parse(raw) as { expiresAt: number }).expiresAt >
                ORIGIN_MS + owner.advanceSeconds * SECOND
            );
          },
          { message: `${owner.name} renewed its lease` },
        );
      }
      if (owner.legacy === true) for (const id of ids) await stripOwnerMarker(process, id);
      taskIds.set(owner.name, ids);
    }

    const booter = await boot(database, ORIGIN_MS + row.bootAtSeconds * SECOND);
    await booter.bureau.recovery();

    for (const [name, outcome] of Object.entries(row.expected)) {
      for (const id of taskIds.get(name) ?? []) {
        const settled = await settledOf(booter, id);
        if (outcome === 'untouched') expect(settled).toBeUndefined();
        else expect(settled).toMatchObject({ status: 'failed', finishReason: 'owner-lost' });
      }
    }
  });

  it('settles a task left inside its predecessor’s lease once that lease lapses', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const crashed = await boot(database, ORIGIN_MS);
    const taskId = await startTask(crashed);

    // Restarted 5 s after the crash: the dead process's lease has 25 s left.
    const booter = await boot(database, ORIGIN_MS + 5 * SECOND);
    await booter.bureau.recovery();
    expect(await settledOf(booter, taskId)).toBeUndefined();

    await booter.runtime.advance(26 * SECOND);
    await waitUntil(async () => (await settledOf(booter, taskId)) !== undefined, {
      message: 'the sweep settled the task when the lease lapsed',
    });
    expect(await settledOf(booter, taskId)).toMatchObject({
      status: 'failed',
      finishReason: 'owner-lost',
    });
  });

  it('does not let a stalled owner replace the settlement a peer already committed', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const stalled = await boot(database, ORIGIN_MS);
    const taskId = await startTask(stalled);

    const booter = await boot(database, ORIGIN_MS + 31 * SECOND);
    await booter.bureau.recovery();
    const peerSettlement = await settledOf(booter, taskId);
    expect(peerSettlement?.finishReason).toBe('owner-lost');

    // The stalled owner was alive all along; its run now completes and it writes its settlement.
    stalled.finishRuns();
    await waitUntil(
      async () => {
        const detail = await stalled.bureau.tasks.detail(taskId);
        return detail?.status === 'completed';
      },
      { message: 'the stalled owner’s run completed' },
    );
    await stalled.bureau.internals.taskRegistry.flush();

    expect(await settledOf(booter, taskId)).toMatchObject({
      status: 'failed',
      finishReason: 'owner-lost',
    });
  });

  it('writes nothing when the owner’s lease was renewed after it was read', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const owner = await boot(database, ORIGIN_MS);
    const taskId = await startTask(owner);
    const record = await recordOf(owner, taskId);
    const ownerProcess = record?.ownerProcess ?? '';
    const kv = textValueStore(owner.storage);
    const read = await kv.get(processLeaseKey(ownerProcess));
    expect(read).not.toBeNull();
    // The owner renews between the booter's read of the lease and its write of the settlement.
    await kv.set(
      processLeaseKey(ownerProcess),
      JSON.stringify({ expiresAt: ORIGIN_MS + 90 * SECOND }),
    );

    const wrote = await owner.bureau.internals.taskRegistry.settleAbandoned(
      taskId,
      ownerProcess,
      { key: processLeaseKey(ownerProcess), expected: read },
      {
        at: new Date(ORIGIN_MS).toISOString(),
        status: 'failed',
        finishReason: 'owner-lost',
        message: null,
      },
    );

    expect(wrote).toBe(false);
    expect(await settledOf(owner, taskId)).toBeUndefined();
  });

  it('lets a manual host renew its lease and look for abandoned tasks through maintain(), with no timer', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const crashed = await boot(database, ORIGIN_MS);
    const crashedTask = await startTask(crashed);
    const owner = await boot(database, ORIGIN_MS, 'manual');
    const ownerTask = await startTask(owner);
    expect(owner.runtime.pendingTimers()).toEqual([]);
    // The Bureau renews nothing of its own: the host's maintenance pass extends the lease.
    await owner.runtime.advance(25 * SECOND);
    await owner.bureau.maintain();

    const booter = await boot(database, ORIGIN_MS + 5 * SECOND, 'manual');
    await booter.bureau.recovery();
    expect(booter.runtime.pendingTimers()).toEqual([]);
    expect(await settledOf(booter, crashedTask)).toBeUndefined();

    // 31 s: the crashed process's lease has lapsed; the owner's, renewed by maintain(), has not.
    await booter.runtime.advance(26 * SECOND);
    await booter.bureau.maintain();
    expect(await settledOf(booter, crashedTask)).toMatchObject({ finishReason: 'owner-lost' });
    expect(await settledOf(booter, ownerTask)).toBeUndefined();
  });
});
