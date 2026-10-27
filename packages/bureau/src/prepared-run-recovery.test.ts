/**
 * COR-297 — a durable run starts in two phases: `prepare()` commits a `pending` record, the start
 * lifecycle runs, then `launch()` begins execution. A process that stops in between leaves a
 * `pending` record its session still calls running. Weft recovers such a record without resuming
 * it, so boot recovery cancels it and settles its session instead of reattaching a run whose
 * result would never settle.
 */
import { createDefaultRuntimeServices, HookRegistry } from '@lostgradient/lifecycle';
import { createAgent, createSessionStore, type OperativeHookMap } from '@lostgradient/operative';
import {
  type BatchOperation,
  type ConditionalBatchCondition,
  Engine,
  resolveStorage,
  type Storage,
  type StorageConfiguration,
  textValueStore,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { classifyRecoveredRun, classifyRecoveredRunDetailed, createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { finishes } from './test/task-record-crash-agent';
import type { Bureau, BureauDiagnostic, BureauRecoveryReport } from './types';

describe('classifyRecoveredRunDetailed with the durable record status (COR-297)', () => {
  const base = {
    handleId: 'run-1',
    scheduledFire: false,
    ownedSessionId: 'session-1' as string | undefined,
    metadataReadFailed: false,
    hasSessionStore: true,
    sessionLoad: { ok: true as const, session: { lastRunId: 'run-1', lastRunStatus: 'running' } },
  };
  const pending = { ...base, engineRecordStatus: 'pending' };

  it('cancels a run that would reattach when its record was prepared and never launched', () => {
    const cancelled = { verdict: 'cancel', rejection: 'prepared-not-launched' } as const;
    expect(classifyRecoveredRunDetailed(pending)).toEqual(cancelled);
    expect(classifyRecoveredRunDetailed({ ...pending, versionMismatch: true })).toEqual(cancelled);
  });

  it('leaves every earlier verdict ahead of the record status', () => {
    const cases: Array<[Partial<typeof pending>, { verdict: string; rejection?: string }]> = [
      [{ metadataReadFailed: true }, { verdict: 'cancel', rejection: 'metadata-read-failed' }],
      [{ ownedSessionId: undefined }, { verdict: 'cancel', rejection: 'foreign-input' }],
      [
        { sessionLoad: { ok: true, session: null } } as never,
        { verdict: 'cancel', rejection: 'session-absent' },
      ],
      [
        { sessionLoad: { ok: true, session: { lastRunId: 'run-2', lastRunStatus: 'running' } } },
        { verdict: 'cancel', rejection: 'session-run-mismatch' },
      ],
      [
        { sessionLoad: { ok: true, session: { lastRunId: 'run-1', lastRunStatus: 'completed' } } },
        { verdict: 'cancel', rejection: 'session-not-running' },
      ],
      [{ hasSessionStore: false }, { verdict: 'skip' }],
      [{ sessionLoad: { ok: false } } as never, { verdict: 'skip' }],
      [{ scheduledFire: true, ownedSessionId: undefined }, { verdict: 'monitor' }],
    ];
    for (const [change, expected] of cases) {
      expect(classifyRecoveredRunDetailed({ ...pending, ...change })).toEqual(expected as never);
      expect(classifyRecoveredRunDetailed({ ...base, ...change })).toEqual(expected as never);
    }
  });

  it('changes nothing when the status is absent or not pending', () => {
    expect(classifyRecoveredRunDetailed(base)).toEqual({ verdict: 'reattach' });
    expect(classifyRecoveredRunDetailed({ ...base, engineRecordStatus: 'running' })).toEqual({
      verdict: 'reattach',
    });
    expect(
      classifyRecoveredRunDetailed({
        ...base,
        engineRecordStatus: 'suspended',
        versionMismatch: true,
      }),
    ).toEqual({ verdict: 'reattach-version-mismatch' });
  });

  it('keeps the plain verdict equal to the detailed one', () => {
    for (const args of [base, pending, { ...pending, versionMismatch: true }]) {
      expect(classifyRecoveredRun(args)).toBe(classifyRecoveredRunDetailed(args).verdict);
    }
  });
});

const bureaus: Bureau<AgentDefinitions>[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  // The surviving Bureaus go first, then the held one they took over from, then the store.
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A run-start hook that holds every run until `release` (which fails it, so it never launches). */
function heldStartHook(): { hooks: HookRegistry<OperativeHookMap>; release(): void } {
  const hooks = new HookRegistry<OperativeHookMap>();
  let releaseHook!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseHook = resolve;
  });
  hooks.on('onRunStart', async () => {
    await released;
    throw new Error('the process that prepared this run is gone');
  });
  return { hooks, release: () => releaseHook() };
}

interface OpenOptions {
  hooks?: HookRegistry<OperativeHookMap>;
  diagnostics?: BureauDiagnostic[];
  recovery?: { attempted: Array<[string, string]>; rejected: Array<[string, string]> };
}

async function open(
  storage: StorageConfiguration | Storage,
  options: OpenOptions = {},
): Promise<Bureau<AgentDefinitions>> {
  const { recovery, diagnostics } = options;
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      researcher: createAgent({
        generate: finishes,
        toolbox: createToolbox([]),
        ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      }),
      default: createAgent({ generate: finishes, toolbox: createToolbox([]) }),
    },
    storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
    ...(diagnostics === undefined
      ? {}
      : { onDiagnostic: (diagnostic: BureauDiagnostic) => diagnostics.push(diagnostic) }),
    // Recovery runs inside `createBureau`, so its events are heard here.
    ...(recovery === undefined
      ? {}
      : {
          onEvent: (event: { type: string; runId?: string; verdict?: string; reason?: string }) => {
            if (event.type === 'recovery.attempted') {
              recovery.attempted.push([event.runId ?? '', event.verdict ?? '']);
            } else if (event.type === 'recovery.rejected') {
              recovery.rejected.push([event.runId ?? '', event.reason ?? '']);
            }
          },
        }),
  });
  bureaus.push(bureau);
  return bureau;
}

/**
 * Leaves a run prepared and never launched: its start hook holds it, and the Bureau that started
 * it is never disposed (a graceful shutdown would cancel it), as a process that stopped there.
 */
async function prepareWithoutLaunching(configuration: StorageConfiguration | Storage) {
  const hook = heldStartHook();
  const crashed = await open(configuration, { hooks: hook.hooks });
  // The held Bureau is let go after its successors, which have taken the run over.
  bureaus.splice(bureaus.indexOf(crashed), 1);
  cleanups.push(async () => {
    hook.release();
    await crashed.dispose();
  });
  const run = await crashed.tasks.start('researcher', 'prepared, never launched');
  expect(await durableStatus(crashed, run.id)).toBe('pending');
  const session = await crashed.contexts.get(run.contextId);
  expect(session?.metadata['lastRunStatus']).toBe('running');
  return { ...run, crashed, release: hook.release };
}

async function durableStatus(
  bureau: Bureau<AgentDefinitions>,
  runId: string,
): Promise<string | undefined> {
  const record = await bureau.tasks.workflow(runId);
  return record?.status;
}

function newFixture() {
  const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
  cleanups.push(() => fixture.dispose());
  return fixture;
}

describe('a run prepared and never launched, recovered at the next boot (COR-297)', () => {
  it('is cancelled, not reattached, and its session is settled so it accepts a new run', async () => {
    const fixture = newFixture();
    const run = await prepareWithoutLaunching(fixture.configuration);

    const restarted = await open(fixture.configuration);
    const report: BureauRecoveryReport = await restarted.waitForRecovery!();

    expect(report.perRunFailures).toContainEqual({
      runId: run.id,
      reason: 'prepared-not-launched',
    });
    expect(restarted.internals.store.getRun(run.id)).toBeUndefined();
    await waitForCondition(
      async () => (await durableStatus(restarted, run.id)) === 'cancelled',
      'the prepared record was never cancelled',
    );
    const session = await restarted.contexts.get(run.contextId);
    expect(session?.metadata['lastRunStatus']).toBe('aborted');
    expect(session?.metadata['lastFinishReason']).toBe('aborted');
    const lastError: unknown = session?.metadata['lastError'];
    expect(typeof lastError === 'string' && lastError.length > 0).toBe(true);

    const next = await restarted.tasks.start('researcher', 'after recovery', {
      contextId: run.contextId,
    });
    expect(next.contextId).toBe(run.contextId);
  });

  it('settles the run’s task at the same boot, even when its cancel lands late', async () => {
    const fixture = newFixture();
    const run = await prepareWithoutLaunching(fixture.configuration);
    const realCancel = Engine.prototype.cancel;
    const cancel = spyOn(Engine.prototype, 'cancel').mockImplementation(async function (
      this: Engine,
      workflowId: string,
    ) {
      if (workflowId === run.id) {
        for (let turn = 0; turn < 5; turn += 1) await yieldToPortableEventLoop();
      }
      return realCancel.call(this, workflowId);
    });
    cleanups.push(() => cancel.mockRestore());

    const restarted = await open(fixture.configuration);
    await restarted.waitForRecovery!();
    cancel.mockRestore();

    const task = await restarted.internals.taskRegistry.get(run.id);
    expect(task?.status).toBe('canceled');
  });

  it('leaves the session alone when another run has taken it over since recovery classified it', async () => {
    const fixture = newFixture();
    const run = await prepareWithoutLaunching(fixture.configuration);
    const storage = await resolveStorage(fixture.configuration);
    cleanups.push(() => storage[Symbol.dispose]());
    const sessions = createSessionStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const realGet = Engine.prototype.get;
    let reads = 0;
    const get = spyOn(Engine.prototype, 'get').mockImplementation(async function (
      this: Engine,
      workflowId: string,
    ) {
      // The second read of the run is the status read, after the session was classified: another
      // process starts a run on the session in between.
      if (workflowId === run.id && ++reads === 2) {
        await sessions.updateMetadata(run.contextId, { lastRunId: 'another-run' });
      }
      return realGet.call(this, workflowId);
    });
    cleanups.push(() => get.mockRestore());

    const restarted = await open(fixture.configuration);
    await restarted.waitForRecovery!();
    get.mockRestore();

    const session = await restarted.contexts.get(run.contextId);
    expect(session?.metadata['lastRunId']).toBe('another-run');
    expect(session?.metadata['lastRunStatus']).toBe('running');
  });

  it('leaves a pending run to the live process still preparing it', async () => {
    const fixture = newFixture();
    const run = await prepareWithoutLaunching(fixture.configuration);
    const realClaimHolder = Engine.prototype.claimHolder;
    const claimHolder = spyOn(Engine.prototype, 'claimHolder').mockImplementation(function (
      this: Engine,
      workflowId: string,
    ) {
      // Under `workflow-lease` ownership, the process that prepared the run still holds its claim.
      if (workflowId === run.id) {
        return Promise.resolve({ heldByThisProcess: false, heldByAnyProcess: true });
      }
      return realClaimHolder.call(this, workflowId);
    });
    cleanups.push(() => claimHolder.mockRestore());
    const recovery = {
      attempted: [] as Array<[string, string]>,
      rejected: [] as Array<[string, string]>,
    };

    const restarted = await open(fixture.configuration, { recovery });
    await restarted.waitForRecovery!();
    claimHolder.mockRestore();

    expect(recovery.attempted).toContainEqual([run.id, 'skip']);
    expect(recovery.rejected.filter(([runId]) => runId === run.id)).toEqual([]);
    expect(await durableStatus(restarted, run.id)).toBe('pending');
    const session = await restarted.contexts.get(run.contextId);
    expect(session?.metadata['lastRunStatus']).toBe('running');

    // The run is still the held process's: once its hook settles, it ends there.
    run.release();
    await waitForCondition(async () => {
      const settled = await run.crashed.contexts.get(run.contextId);
      return settled?.metadata['lastRunStatus'] !== 'running';
    }, 'the held process never settled its run');
  });

  it('cancels a catalog run prepared and never launched, and settles its task', async () => {
    const fixture = newFixture();
    const hook = heldStartHook();
    const crashed = await open(fixture.configuration, { hooks: hook.hooks });
    bureaus.splice(bureaus.indexOf(crashed), 1);
    cleanups.push(async () => {
      hook.release();
      await crashed.dispose();
    });
    const run = await crashed.tasks.start('researcher', 'prepared, never launched');
    const runId = run.snapshot().id;
    await waitForCondition(
      async () => (await durableStatus(crashed, runId)) === 'pending',
      'the catalog run was never prepared',
    );

    const restarted = await open(fixture.configuration);
    const report = await restarted.waitForRecovery!();

    expect(report.perRunFailures).toContainEqual({ runId, reason: 'prepared-not-launched' });
    expect(await durableStatus(restarted, runId)).toBe('cancelled');
    const task = await restarted.internals.taskRegistry.get(runId);
    expect(task?.status).toBe('canceled');
  });

  it('dispatches a cancel verdict with the prepared-not-launched rejection, never a reattach', async () => {
    const fixture = newFixture();
    const run = await prepareWithoutLaunching(fixture.configuration);
    const recovery = {
      attempted: [] as Array<[string, string]>,
      rejected: [] as Array<[string, string]>,
    };

    const restarted = await open(fixture.configuration, { recovery });
    await restarted.waitForRecovery!();

    const verdicts = recovery.attempted.filter(([runId]) => runId === run.id).map(([, v]) => v);
    expect(verdicts).toContain('cancel');
    expect(verdicts).not.toContain('reattach');
    expect(recovery.rejected).toContainEqual([run.id, 'prepared-not-launched']);
  });

  it('still cancels the record when settling its session fails, and reports the failure', async () => {
    const fixture = newFixture();
    const run = await prepareWithoutLaunching(fixture.configuration);
    const storage = await resolveStorage(fixture.configuration);
    cleanups.push(() => storage[Symbol.dispose]());
    // Every session body write, which is what settling the session's metadata makes.
    const refusing = refuseWritesUnder(storage, 'agent-session-v2:body:');
    const diagnostics: BureauDiagnostic[] = [];

    const restarted = await open(refusing, { diagnostics });
    await restarted.waitForRecovery!();

    await waitForCondition(
      async () => (await durableStatus(restarted, run.id)) === 'cancelled',
      'the prepared record was never cancelled',
    );
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.level === 'error' &&
          diagnostic.scope === 'session-persistence' &&
          diagnostic.message.includes(run.id),
      ),
    ).toBe(true);
  });

  it('reattaches as before, and cancels nothing, when the record status cannot be read', async () => {
    const fixture = newFixture();
    const run = await prepareWithoutLaunching(fixture.configuration);
    const realGet = Engine.prototype.get;
    let reads = 0;
    const get = spyOn(Engine.prototype, 'get').mockImplementation(function (
      this: Engine,
      workflowId: string,
    ) {
      // The first read of the run is its launch metadata's; the second is the status read.
      if (workflowId === run.id && ++reads === 2) {
        return Promise.reject(new Error('the record could not be read'));
      }
      return realGet.call(this, workflowId);
    });
    cleanups.push(() => get.mockRestore());
    const diagnostics: BureauDiagnostic[] = [];
    const recovery = {
      attempted: [] as Array<[string, string]>,
      rejected: [] as Array<[string, string]>,
    };

    const restarted = await open(fixture.configuration, { diagnostics, recovery });
    await restarted.waitForRecovery!();
    get.mockRestore();

    expect(recovery.attempted).toContainEqual([run.id, 'reattach']);
    expect(recovery.rejected.filter(([runId]) => runId === run.id)).toEqual([]);
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.level === 'error' &&
          diagnostic.scope === 'recovery' &&
          diagnostic.message.includes(run.id),
      ),
    ).toBe(true);
    expect(await durableStatus(restarted, run.id)).toBe('pending');
  });
});

/** Wraps `storage` so every write to a key under `prefix` fails. */
function refuseWritesUnder(storage: Storage, prefix: string): Storage {
  const refused = (key: string): boolean => key.startsWith(prefix);
  const fail = (): never => {
    throw new Error('the session store is unavailable');
  };
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'put') {
        return async (key: string, value: Uint8Array) =>
          refused(key) ? fail() : target.put(key, value);
      }
      if (property === 'batch') {
        return async (operations: BatchOperation[]) =>
          operations.some((operation) => refused(operation.key))
            ? fail()
            : target.batch(operations);
      }
      if (property === 'conditionalBatch') {
        return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) =>
          operations.some((operation) => refused(operation.key))
            ? fail()
            : target.conditionalBatch!(conditions, operations);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
