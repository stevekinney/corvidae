/**
 * COR-424 — retry-safe run creation at each fault point, over both persistent
 * backends.
 *
 * Every scenario has two Bureaus over one storage path, the way two processes
 * would share it. Bureau A is the process that fails: it is a real child process
 * (`test/run-creation-crash-child.ts`) that stops at the fault point, records
 * what it observed in a marker file, and kills itself with SIGKILL (COR-1795).
 * A graceful dispose would cancel its durable run, which a crash does not, and
 * the write that the crash interrupts never lands. Bureau B is the process that
 * boots afterwards, in this one, and receives the client's retry: the same
 * principal, request id, and payload. The parent holds exactly one handle on
 * the path, B's, opened only once the child is gone, because LMDB must not have
 * two handles on one path in one process. Each scenario asserts the outcome the
 * issue fixes for that point.
 *
 * The same body runs over SQLite and LMDB, so a divergence between the two
 * fails the same assertion rather than being documented as a difference.
 * Booting twelve children takes real seconds, so the file is in the slow lane
 * (COR-1499), and each scenario runs once at module scope, off Bun's per-test
 * clock, while its test only reports how it went (see `test/hoisted-scenario.ts`). Polls use a small real
 * delay because a zero-delay poll starves LMDB's own completion callbacks (see
 * `event-history-run-ownership-recovery-lmdb.test.ts`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { textValueStore } from '@lostgradient/storage';
import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import {
  type CommandLedger,
  type CommandLedgerIdentity,
  createCommandLedger,
  RUN_CREATION_OPERATION_VERSION,
  type RunCreationClaim,
  type RunCreationLedgerResult,
} from './command-ledger';
import { createBureau } from './create-bureau';
import { listHeldTasks } from './test';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import { type FaultMarker, type FaultScenario, REQUEST } from './test/run-creation-fault-fixtures';
import {
  createLmdbStorageFixture,
  createSqliteStorageFixture,
  type PersistentBureauStorageFixture,
} from './test/storage-fixtures';
import { startTaskFrom } from './test/task-start-request.ts';
import type { Bureau } from './types';
import { readChildJson } from './test/child-output-file';

const CHILD = join(import.meta.dir, 'test', 'run-creation-crash-child.ts');

const IDENTITY: CommandLedgerIdentity = {
  callerId: 'alice',
  target: 'default',
  requestId: 'request-1',
  operationVersion: RUN_CREATION_OPERATION_VERSION,
};

type Backend = 'sqlite' | 'lmdb';

/** The one fixture the parent opens on the child's path, once the child is gone. */
type FixtureFactory = (runtime: RuntimeServices, path: string) => PersistentBureauStorageFixture;

const BACKENDS: readonly (readonly [Backend, FixtureFactory])[] = [
  ['sqlite', (runtime, path) => createSqliteStorageFixture({ runtime, path })],
  ['lmdb', (runtime, path) => createLmdbStorageFixture({ runtime, path })],
];

/** A bounded poll with a small real delay between checks; never a blind sleep. */
async function pollUntil(check: () => boolean | Promise<boolean>): Promise<true> {
  await waitUntil(check, { message: 'pollUntil' });
  return true;
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
  /** What Bureau A, the child, recorded before it was killed. */
  readonly marker: FaultMarker;
  readonly ledger: CommandLedger<RunCreationClaim, RunCreationLedgerResult>;
  /** Boots the recovering Bureau B over the store Bureau A left behind. */
  boot(generate: GenerateFunction): Promise<Bureau>;
}

/**
 * Plays `scenario` against one backend: Bureau A runs in a child that is killed with SIGKILL at the
 * scenario's fault point, then `body` runs against Bureau B over the store it left. Teardown
 * disposes B, closes the one fixture, and removes the directory the scenario allocated.
 */
async function withScenario(
  backend: Backend,
  factory: FixtureFactory,
  scenario: FaultScenario,
  scope: ScenarioScope,
  body: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const runtime = createDefaultRuntimeServices();
  const directory = mkdtempSync(join(tmpdir(), `corvidae-run-creation-${backend}-`));
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  const bureaus: Bureau[] = [];
  let fixture: PersistentBureauStorageFixture | undefined;
  // A hung scenario never reaches its `finally`, so what it owns is released from here.
  scope.onHang(async () => {
    await Promise.allSettled(bureaus.map((bureau) => bureau.dispose()));
    await fixture?.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  try {
    // Premise: the child reached its fault point, recorded what it saw, and died from SIGKILL.
    const child = spawnWithHangGuard(['bun', CHILD, scenario, backend, storagePath, markerPath], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    scope.onHang(() => child.kill('SIGKILL'));
    const [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    const marker = readChildJson<FaultMarker>(markerPath);
    // A dead process reports nothing, because its writes never settle; anything it did report is
    // a defect.
    expect(marker.diagnostics).toEqual([]);

    fixture = factory(runtime, storagePath);
    const storage = fixture.storage;
    await body({
      marker,
      ledger: createCommandLedger({
        kv: textValueStore(storage, { disposeUnderlyingStorage: false }),
        clock: runtime.clock,
        nextConflictId: () => runtime.identifiers.next('conflict'),
      }),
      async boot(generate) {
        const bureau = await createBureau<AgentDefinitions>({
          agents: {
            default: createAgent({
              generate,
              toolbox: createToolbox<readonly Tool[]>([]),
              stopWhen: stopWhen.noToolCalls(),
            }),
          },
          storage,
          durable: true,
          durableOwnership: { ownership: 'none' },
        });
        bureaus.push(bureau);
        return bureau;
      },
    });
  } finally {
    for (const bureau of bureaus.toReversed()) await bureau.dispose();
    await fixture?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function durableRunIds(bureau: Bureau): Promise<string[] | undefined> {
  const page = await bureau.tasks.workflows();
  return page?.items.map((run) => run.id);
}

async function durableStatus(bureau: Bureau, runId: string): Promise<string | undefined> {
  const state = await bureau.tasks.workflow(runId);
  return state?.status;
}

interface FaultCase {
  readonly scenario: FaultScenario;
  readonly title: string;
  readonly body: (scenario: Scenario) => Promise<void>;
}

const CASES: readonly FaultCase[] = [
  {
    scenario: 'crash-before-claim',
    title:
      'crash-before-claim: the retry claims and runs as a fresh attempt, with no residual entry',
    async body({ marker, ledger, boot }) {
      expect(await ledger.read(IDENTITY)).toBeUndefined();
      expect(marker.runIds).toEqual([]);

      const generateB = heldGenerate();
      const bureauB = await boot(generateB.generate);
      const retry = await startTaskFrom(bureauB, REQUEST);

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
    },
  },
  {
    scenario: 'after-claim',
    title: 'after-claim: the retry observes the pending entry and starts no run of its own',
    async body({ marker, ledger, boot }) {
      // The claim lands and the process dies as it returns: the entry exists,
      // pending, and names a run that never reached the engine.
      const pending = await ledger.read(IDENTITY);
      if (pending?.state !== 'pending') throw new Error('expected the claim to be pending');
      const { claim } = pending;
      expect(marker.runIds).toEqual([]);

      const generateB = heldGenerate();
      const bureauB = await boot(generateB.generate);
      const retry = await startTaskFrom(bureauB, REQUEST);
      const again = await startTaskFrom(bureauB, REQUEST);

      expect(retry).toMatchObject({
        id: claim.runId,
        contextId: claim.sessionId,
        receipt: { runId: claim.runId, requestId: 'request-1', status: 'pending' },
      });
      expect({ id: again.id, contextId: again.contextId, receipt: again.receipt }).toEqual({
        id: retry.id,
        contextId: retry.contextId,
        receipt: retry.receipt,
      });
      expect(await durableRunIds(bureauB)).toEqual([]);
      expect(listHeldTasks(bureauB)).toEqual([]);
      expect(generateB.calls()).toBe(0);
      expect(await ledger.read(IDENTITY)).toEqual(pending);
    },
  },
  {
    scenario: 'after-work-start',
    title:
      'after-work-start: the retry observes the in-flight run instead of restarting it, and records its receipt once',
    async body({ marker, ledger, boot }) {
      // The run is durably started, but the process dies before the ledger
      // records it: the entry stays pending and names a run the engine has.
      const pending = await ledger.read(IDENTITY);
      if (pending?.state !== 'pending') throw new Error('expected the claim to be pending');
      const { runId } = pending.claim;
      expect(marker.runIds).toEqual([runId]);

      const generateB = heldGenerate();
      const bureauB = await boot(generateB.generate);
      const retry = await startTaskFrom(bureauB, REQUEST);

      const receipt = {
        runId,
        requestId: 'request-1',
        createdAt: pending.claimedAt,
        status: 'running',
      };
      expect(retry).toMatchObject({ id: runId, receipt });
      expect(bureauB.tasks.detail(runId)?.status).toBe('running');
      expect(await durableRunIds(bureauB)).toEqual([runId]);
      expect(listHeldTasks(bureauB).map((run) => run.id)).toEqual([runId]);
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
      const later = await startTaskFrom(bureauB, REQUEST);
      expect(later.id).toBe(runId);
      expect(later.receipt).toEqual(receipt);
      expect(await durableRunIds(bureauB)).toEqual([runId]);
    },
  },
  {
    scenario: 'after-prepare-before-launch',
    title:
      'after-prepare-before-launch: recovery cancels the run that never launched, and the retry receives its aborted receipt (COR-297)',
    async body({ ledger, boot }) {
      // `createRun` acknowledges a run once `prepare()` commits it. The process dies as the ledger
      // records that, before the run launches: its record stays `pending`, and its session says
      // it is running.
      const pending = await ledger.read(IDENTITY);
      if (pending?.state !== 'pending') throw new Error('expected the claim to be pending');
      const { runId } = pending.claim;

      const generateB = heldGenerate();
      const bureauB = await boot(generateB.generate);
      const retry = await startTaskFrom(bureauB, REQUEST);

      const receipt = {
        runId,
        requestId: 'request-1',
        createdAt: pending.claimedAt,
        status: 'aborted',
      };
      expect(retry).toMatchObject({ id: runId, receipt });
      expect(await durableStatus(bureauB, runId)).toBe('cancelled');
      expect(generateB.calls()).toBe(0);
      expect(await ledger.read(IDENTITY)).toMatchObject({
        state: 'completed',
        claim: pending.claim,
        result: { receipt },
      });
    },
  },
  {
    scenario: 'after-effect-before-ack',
    title:
      'after-effect-before-ack: the run executed once and the retry receives the original receipt',
    async body({ marker, ledger, boot }) {
      // The process dies as the ledger records the run, before the caller
      // hears back: the acknowledgement `createRun` resolves with is lost.
      const unacknowledged = marker.started;
      if (unacknowledged === undefined) throw new Error('expected the child to record the run');
      const completed = await ledger.read(IDENTITY);
      if (completed?.state !== 'completed') throw new Error('expected a completed entry');

      const bureauB = await boot(heldGenerate().generate);
      const retry = await startTaskFrom(bureauB, REQUEST);

      expect(retry.id).toBe(unacknowledged.id);
      expect(retry.receipt).toEqual(unacknowledged.receipt);
      expect(retry.receipt).toEqual(completed.result.receipt);
      expect(await durableRunIds(bureauB)).toEqual([unacknowledged.id]);
      expect(listHeldTasks(bureauB).map((run) => run.id)).toEqual([unacknowledged.id]);
      expect(await ledger.read(IDENTITY)).toEqual(completed);
    },
  },
  {
    scenario: 'during-cancellation',
    title:
      'during-cancellation/cleanup: the retry observes the cancellation and does not run the work again',
    async body({ marker, ledger, boot }) {
      // The crash interrupts cancellation cleanup: the run's terminal session
      // write, which follows the durable cancellation.
      const created = marker.started;
      if (created === undefined) throw new Error('expected the child to record the run');
      const completed = await ledger.read(IDENTITY);
      if (completed?.state !== 'completed') throw new Error('expected a completed entry');

      const generateB = heldGenerate();
      const bureauB = await boot(generateB.generate);
      const retry = await startTaskFrom(bureauB, REQUEST);

      expect(retry).toMatchObject({ id: created.id });
      expect(retry.receipt).toEqual(created.receipt);
      expect(generateB.calls()).toBe(0);
      expect(await durableRunIds(bureauB)).toEqual([created.id]);
      expect(await durableStatus(bureauB, created.id)).toBe('cancelled');
      // The retry is the first to observe the run settled, so it records that
      // once, starting the binding's retention window; nothing else changes.
      const settled = await ledger.read(IDENTITY);
      if (settled?.state !== 'completed') throw new Error('expected a completed entry');
      const { settledAt, ...unchanged } = settled;
      expect(unchanged).toEqual(completed);
      expect(settledAt).toBeString();
    },
  },
];

// Each scenario boots a child process, which cannot fit a per-test clock on a loaded host, so it
// runs whole, once, at module scope (see `test/hoisted-scenario.ts`) and the test reports how it
// went. Scenarios run one after another: they share a host already loaded by the children.
const outcomes = new Map<string, Awaited<ReturnType<typeof settleScenario>>>();
for (const [backend, factory] of BACKENDS) {
  for (const { scenario, body } of CASES) {
    outcomes.set(
      `${backend}:${scenario}`,
      await settleScenario(
        (scope) => withScenario(backend, factory, scenario, scope, body),
        HANG_GUARD_MILLISECONDS,
      ),
    );
  }
}

describe.each(BACKENDS)('run creation fault points over %s', (backend) => {
  for (const { scenario, title } of CASES) {
    it(title, () => {
      expectScenarioPassed(outcomes.get(`${backend}:${scenario}`));
    });
  }
});
