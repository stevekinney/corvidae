/**
 * COR-424 — retry-safe run creation at each fault point, over both persistent
 * backends.
 *
 * Every scenario has two bureaus over one storage path, the way two processes
 * would share it. Bureau A is the process that fails: it is left undisposed
 * at the fault point (a graceful dispose would cancel its durable run, which
 * a crash does not), and the write that the crash interrupts is held
 * unsettled so it never lands. Bureau B is the process that boots afterwards
 * and receives the client's retry: the same principal, request id, and
 * payload. Each scenario asserts the outcome the issue fixes for that point.
 *
 * The same body runs over SQLite and LMDB, so a divergence between the two
 * fails the same assertion rather than being documented as a difference.
 * Polls use a small real delay because a zero-delay poll starves LMDB's own
 * completion callbacks (see `event-history-run-ownership-recovery-lmdb.test.ts`).
 */
import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import {
  type BatchOperation,
  resolveStorage,
  type Storage,
  textValueStore,
} from '@lostgradient/weft';
import { createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';

import {
  type CommandLedger,
  type CommandLedgerIdentity,
  createCommandLedger,
  RUN_CREATION_OPERATION_VERSION,
  type RunCreationClaim,
  type RunCreationLedgerResult,
} from './command-ledger';
import { createBureau } from './create-bureau';
import {
  type BureauStorageFixture,
  createLmdbStorageFixture,
  createSqliteStorageFixture,
} from './test/storage-fixtures';
import type { Bureau, BureauDiagnostic, CreateRunRequest } from './types';

const REQUEST: CreateRunRequest = {
  message: 'Reconcile the ledger.',
  principal: 'alice',
  runCreationRequestId: 'request-1',
};

const IDENTITY: CommandLedgerIdentity = {
  callerId: 'alice',
  target: 'bureau',
  requestId: 'request-1',
  operationVersion: RUN_CREATION_OPERATION_VERSION,
};

const LEDGER_ENTRY_PREFIX = 'command-ledger:v1:entry:';

type FixtureFactory = (runtime: RuntimeServices) => BureauStorageFixture;

const BACKENDS: readonly (readonly [string, FixtureFactory])[] = [
  ['sqlite', (runtime) => createSqliteStorageFixture({ runtime })],
  ['lmdb', (runtime) => createLmdbStorageFixture({ runtime })],
];

/** A bounded poll with a small real delay between checks; never a blind sleep. */
async function pollUntil(check: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

/** One key/value a storage call was about to write. */
interface PendingWrite {
  readonly key: string;
  readonly text: string;
}

const decoder = new TextDecoder();

function writesOf(verb: string, args: readonly unknown[]): PendingWrite[] {
  if (verb === 'put') {
    return [{ key: args[0] as string, text: decoder.decode(args[1] as Uint8Array) }];
  }
  const operations = verb === 'batch' ? args[0] : verb === 'conditionalBatch' ? args[1] : undefined;
  if (!Array.isArray(operations)) return [];
  return (operations as BatchOperation[]).flatMap((operation) =>
    operation.type === 'put' ? [{ key: operation.key, text: decoder.decode(operation.value) }] : [],
  );
}

/** Where the crash falls relative to the write that triggers it. */
type CrashPoint = 'before-write' | 'after-write';

/** A storage handle whose process dies at the first write matching a trigger. */
interface CrashingStorage {
  readonly storage: Storage;
  crashed(): boolean;
  /**
   * Teardown only, once the surviving bureau is gone: fails every write the
   * dead process has made since the crash, and any it makes later, with
   * {@link ProcessCrashedError}, so the dead bureau can be disposed. None of
   * them reach the backend, exactly as none would have after a real crash.
   */
  discard(): void;
}

const PROCESS_CRASHED_MESSAGE = 'The process that made this write crashed before it landed.';

/** What every write a crashed process makes after its crash fails with, at teardown. */
class ProcessCrashedError extends Error {
  constructor() {
    super(PROCESS_CRASHED_MESSAGE);
    this.name = 'ProcessCrashedError';
  }
}

const WRITE_VERBS = new Set<PropertyKey>([
  'put',
  'delete',
  'batch',
  'conditionalBatch',
  'deletePrefix',
  'deleteRange',
]);

/**
 * Wraps `storage` so the process dies at the first write matching `trigger`:
 * with `before-write` that write never reaches the backend, and with
 * `after-write` it lands and the process dies as it returns. From then on
 * no write the process makes reaches the backend; each stays unsettled until
 * `discard()` fails it. Reads pass through, since they cannot change what a
 * later process finds.
 */
function crashOnWrite(
  storage: Storage,
  trigger: (write: PendingWrite) => boolean,
  point: CrashPoint,
): CrashingStorage {
  let crashed = false;
  let discarded = false;
  const held: (() => void)[] = [];
  const wrapped = new Proxy(storage, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (!WRITE_VERBS.has(property)) return value.bind(target);
      return async (...args: unknown[]) => {
        if (!crashed && writesOf(String(property), args).some(trigger)) {
          crashed = true;
          if (point === 'after-write') return Reflect.apply(value, target, args);
        }
        if (!crashed) return Reflect.apply(value, target, args);
        if (discarded) throw new ProcessCrashedError();
        return new Promise((_resolve, reject) => {
          held.push(() => reject(new ProcessCrashedError()));
        });
      };
    },
  });
  return {
    storage: wrapped,
    crashed: () => crashed,
    discard() {
      discarded = true;
      for (const settle of held.splice(0)) settle();
    },
  };
}

function ledgerWriteIn(state: 'pending' | 'completed'): (write: PendingWrite) => boolean {
  return (write) => {
    if (!write.key.startsWith(LEDGER_ENTRY_PREFIX)) return false;
    try {
      return (JSON.parse(write.text) as { state?: unknown }).state === state;
    } catch {
      return false;
    }
  };
}

/**
 * A generate held at every call until `release()`, so a run stays in flight
 * until the test lets it finish (or its bureau aborts it).
 */
function heldGenerate(): { generate: GenerateFunction; calls: () => number; release(): void } {
  let calls = 0;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    generate: async () => {
      calls += 1;
      await released;
      return { content: 'done', toolCalls: [] };
    },
    calls: () => calls,
    release: () => release(),
  };
}

interface Scenario {
  /** The handle the recovering process boots over. */
  readonly storageB: Storage;
  readonly ledger: CommandLedger<RunCreationClaim, RunCreationLedgerResult>;
  /** The failing process's handle, which dies at the first write matching `trigger`. */
  crashOn(trigger: (write: PendingWrite) => boolean, point: CrashPoint): CrashingStorage;
  boot(storage: Storage, generate: GenerateFunction): Promise<Bureau>;
}

/**
 * Runs `body` against one backend with two storage handles over the same
 * path. Teardown disposes the surviving bureau first, then discards the dead
 * process's held writes so the failed bureau can be disposed too, then
 * closes the handles and the fixture.
 */
async function withScenario(
  factory: FixtureFactory,
  body: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const runtime = createDefaultRuntimeServices();
  const fixture = factory(runtime);
  const storageA = await resolveStorage(
    fixture.configuration as Parameters<typeof resolveStorage>[0],
  );
  const storageB = await resolveStorage(
    fixture.configuration as Parameters<typeof resolveStorage>[0],
  );
  const bureaus: Bureau[] = [];
  const crashes: CrashingStorage[] = [];
  // A dead process reports the writes its crash failed; anything else it
  // reports is a defect, checked once it has been disposed.
  const deadProcessDiagnostics: BureauDiagnostic[] = [];
  try {
    await body({
      storageB,
      ledger: createCommandLedger({
        kv: textValueStore(storageB, { disposeUnderlyingStorage: false }),
        now: () => runtime.clock.nowISO(),
        nextConflictId: () => runtime.identifiers.next('conflict'),
      }),
      crashOn(trigger, point) {
        const crash = crashOnWrite(storageA, trigger, point);
        crashes.push(crash);
        return crash;
      },
      async boot(storage, generate) {
        const crashing = crashes.some((crash) => crash.storage === storage);
        const bureau = await createBureau({
          ...(crashing
            ? { onDiagnostic: (diagnostic) => deadProcessDiagnostics.push(diagnostic) }
            : {}),
          agents: {},
          generate,
          toolbox: createToolbox<readonly Tool[]>([]),
          storage,
          durableExecution: true,
          durableOwnership: { ownership: 'none' },
          stopWhen: stopWhen.noToolCalls(),
        });
        bureaus.push(bureau);
        return bureau;
      },
    });
  } finally {
    const [failed, ...survivors] = bureaus;
    for (const bureau of survivors.toReversed()) await bureau.dispose();
    for (const crash of crashes) crash.discard();
    await failed?.dispose();
    storageB[Symbol.dispose]();
    storageA[Symbol.dispose]();
    await fixture.dispose();
  }
  const unexpected = deadProcessDiagnostics.filter(
    (diagnostic) =>
      !(diagnostic.cause instanceof ProcessCrashedError) &&
      !diagnostic.message.includes(PROCESS_CRASHED_MESSAGE),
  );
  expect(unexpected).toEqual([]);
}

async function durableRunIds(bureau: Bureau): Promise<string[] | undefined> {
  const page = await bureau.listDurableRuns();
  return page?.items.map((run) => run.id);
}

async function durableStatus(bureau: Bureau, runId: string): Promise<string | undefined> {
  const state = await bureau.getDurableRun(runId);
  return state?.status;
}

describe.each(BACKENDS)('run creation fault points over %s', (_backend, factory) => {
  it('crash-before-claim: the retry claims and runs as a fresh attempt, with no residual entry', async () => {
    await withScenario(factory, async ({ storageB, ledger, crashOn, boot }) => {
      const crash = crashOn(ledgerWriteIn('pending'), 'before-write');
      const bureauA = await boot(crash.storage, heldGenerate().generate);
      bureauA.createRun(REQUEST).catch(() => {});
      expect(await pollUntil(() => crash.crashed())).toBe(true);

      expect(await ledger.read(IDENTITY)).toBeUndefined();
      expect(await durableRunIds(bureauA)).toEqual([]);

      const generateB = heldGenerate();
      const bureauB = await boot(storageB, generateB.generate);
      const retry = await bureauB.createRun(REQUEST);

      expect(retry.receipt).toMatchObject({
        runId: retry.id,
        requestId: 'request-1',
        status: 'running',
      });
      expect(await durableRunIds(bureauB)).toEqual([retry.id]);
      expect(await ledger.read(IDENTITY)).toMatchObject({
        state: 'completed',
        result: { receipt: retry.receipt },
      });
    });
  });

  it('after-claim: the retry observes the pending entry and starts no run of its own', async () => {
    await withScenario(factory, async ({ storageB, ledger, crashOn, boot }) => {
      // The claim lands and the process dies as it returns: the entry exists,
      // pending, and names a run that never reached the engine.
      const crash = crashOn(ledgerWriteIn('pending'), 'after-write');
      const bureauA = await boot(crash.storage, heldGenerate().generate);
      bureauA.createRun(REQUEST).catch(() => {});
      expect(await pollUntil(() => crash.crashed())).toBe(true);
      const pending = await ledger.read(IDENTITY);
      if (pending?.state !== 'pending') throw new Error('expected the claim to be pending');
      const { claim } = pending;
      expect(await durableRunIds(bureauA)).toEqual([]);

      const generateB = heldGenerate();
      const bureauB = await boot(storageB, generateB.generate);
      const retry = await bureauB.createRun(REQUEST);
      const again = await bureauB.createRun(REQUEST);

      expect(retry).toMatchObject({
        id: claim.runId,
        sessionId: claim.sessionId,
        status: 'pending',
        receipt: { runId: claim.runId, requestId: 'request-1', status: 'pending' },
      });
      expect(again).toEqual(retry);
      expect(await durableRunIds(bureauB)).toEqual([]);
      expect(bureauB.listRuns()).toEqual([]);
      expect(generateB.calls()).toBe(0);
      expect(await ledger.read(IDENTITY)).toEqual(pending);
    });
  });

  it('after-work-start: the retry observes the in-flight run instead of restarting it, and records its receipt once', async () => {
    await withScenario(factory, async ({ storageB, ledger, crashOn, boot }) => {
      // The run is durably started, but the process dies before the ledger
      // records it: the entry stays pending and names a run the engine has.
      const crash = crashOn(ledgerWriteIn('completed'), 'before-write');
      const bureauA = await boot(crash.storage, heldGenerate().generate);
      bureauA.createRun(REQUEST).catch(() => {});
      expect(await pollUntil(() => crash.crashed())).toBe(true);

      const pending = await ledger.read(IDENTITY);
      if (pending?.state !== 'pending') throw new Error('expected the claim to be pending');
      const { runId } = pending.claim;
      expect(await durableRunIds(bureauA)).toEqual([runId]);

      const generateB = heldGenerate();
      const bureauB = await boot(storageB, generateB.generate);
      const retry = await bureauB.createRun(REQUEST);

      const receipt = {
        runId,
        requestId: 'request-1',
        createdAt: pending.claimedAt,
        status: 'running',
      };
      expect(retry).toMatchObject({ id: runId, status: 'running', receipt });
      expect(await durableRunIds(bureauB)).toEqual([runId]);
      expect(bureauB.listRuns().map((run) => run.id)).toEqual([runId]);
      // The retry recorded the receipt, so it no longer depends on when a
      // retry happens to arrive.
      expect(await ledger.read(IDENTITY)).toMatchObject({
        state: 'completed',
        claimedAt: pending.claimedAt,
        claim: pending.claim,
        result: { receipt },
      });

      generateB.release();
      expect(
        await pollUntil(async () => (await durableStatus(bureauB, runId)) === 'completed'),
      ).toBe(true);
      const later = await bureauB.createRun(REQUEST);
      expect(later.id).toBe(runId);
      expect(later.receipt).toEqual(receipt);
      expect(await durableRunIds(bureauB)).toEqual([runId]);
    });
  });

  it('after-effect-before-ack: the run executed once and the retry receives the original receipt', async () => {
    await withScenario(factory, async ({ storageB, ledger, crashOn, boot }) => {
      // The process dies as the ledger records the run, before the caller
      // hears back: the acknowledgement `createRun` resolves with is lost.
      const crash = crashOn(ledgerWriteIn('completed'), 'after-write');
      const bureauA = await boot(crash.storage, heldGenerate().generate);
      const unacknowledged = await bureauA.createRun(REQUEST);
      expect(crash.crashed()).toBe(true);
      const completed = await ledger.read(IDENTITY);
      if (completed?.state !== 'completed') throw new Error('expected a completed entry');

      const bureauB = await boot(storageB, heldGenerate().generate);
      const retry = await bureauB.createRun(REQUEST);

      expect(retry.id).toBe(unacknowledged.id);
      expect(retry.receipt).toEqual(unacknowledged.receipt);
      expect(retry.receipt).toEqual(completed.result.receipt);
      expect(await durableRunIds(bureauB)).toEqual([unacknowledged.id]);
      expect(bureauB.listRuns().map((run) => run.id)).toEqual([unacknowledged.id]);
      expect(await ledger.read(IDENTITY)).toEqual(completed);
    });
  });

  it('during-cancellation/cleanup: the retry observes the cancellation and does not run the work again', async () => {
    await withScenario(factory, async ({ storageB, ledger, crashOn, boot }) => {
      // The crash interrupts cancellation cleanup: the run's terminal session
      // write, which follows the durable cancellation.
      const crash = crashOn(
        (write) => write.text.includes('"lastRunStatus":"aborted"'),
        'before-write',
      );
      const bureauA = await boot(crash.storage, heldGenerate().generate);
      const created = await bureauA.createRun(REQUEST);
      bureauA.abortRun(created.id);
      expect(
        await pollUntil(
          async () => crash.crashed() && (await durableStatus(bureauA, created.id)) === 'cancelled',
        ),
      ).toBe(true);
      const completed = await ledger.read(IDENTITY);

      const generateB = heldGenerate();
      const bureauB = await boot(storageB, generateB.generate);
      const retry = await bureauB.createRun(REQUEST);

      expect(retry).toMatchObject({ id: created.id, status: 'aborted' });
      expect(retry.receipt).toEqual(created.receipt);
      expect(generateB.calls()).toBe(0);
      expect(await durableRunIds(bureauB)).toEqual([created.id]);
      expect(await durableStatus(bureauB, created.id)).toBe('cancelled');
      expect(await ledger.read(IDENTITY)).toEqual(completed);
    });
  });
});
