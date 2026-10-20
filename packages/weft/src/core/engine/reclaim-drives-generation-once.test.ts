/**
 * A claim takeover and `recoverAll()` both drive a workflow this engine has just come to hold.
 * The reclaim pass takes the dead owner's claim and then pauses (reloading pending async
 * activities) before it replays the workflow from storage; a `recoverAll()` that runs in that
 * pause resumes the same generation under the claim the reclaim already installed. The reclaim's
 * forced replay skips the local-ownership check `recoverAll()` makes, so unless it notices the
 * drive it would start a second one, and the activity would run twice (COR-1618).
 *
 * The reclaim is held at `reclaimReplayGateForTesting`, the one seam added for this, and the
 * store-backed counter counts how many times the activity ran. Each case must end with it at one.
 */
import { describe, expect, it } from 'bun:test';

import type { Storage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  createDeferred,
  waitForCondition,
  yieldToEventLoop,
} from '../../testing/fake-timers.test-support.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER } from './workflow-claim-transitions.ts';

const CLAIM_RENEW_INTERVAL_MS = 1_000;
const CLAIM_TTL_MS = 3_000;
const EXPIRED_AFTER_MS =
  CLAIM_TTL_MS + WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * CLAIM_RENEW_INTERVAL_MS + 1;

/** What the activity records in the store it ran against, and what holds it. */
type ActivityProbe = {
  runs: number;
  /** While set, an activity that has started waits here, so the drive stays "running". */
  hold: ReturnType<typeof createDeferred<void>> | null;
};

const probes = new WeakMap<Storage, ActivityProbe>();

function probeFor(storage: Storage): ActivityProbe {
  let probe = probes.get(storage);
  if (probe === undefined) {
    probe = { runs: 0, hold: null };
    probes.set(storage, probe);
  }
  return probe;
}

function countingWorkflow(storage: Storage) {
  return workflow({ name: 'counted' }).execute(async function* (ctx: WorkflowContext) {
    return yield* ctx.run(async () => {
      const probe = probeFor(storage);
      probe.runs++;
      await probe.hold?.promise;
      return 'ran';
    });
  });
}

/** An owner that started the workflow, took its claim, and died before driving it. */
async function strandWorkflow(
  storage: Storage,
  getNow: () => number,
  workflowId: string,
  dispose: boolean,
): Promise<void> {
  const definition = countingWorkflow(storage);
  const previousOwner = await Engine.create({
    storage,
    workflows: { counted: definition },
    ownership: 'workflow-lease',
    getNow,
    workflowClaimTtl: `${CLAIM_TTL_MS}ms`,
    workflowClaimRenewInterval: `${CLAIM_RENEW_INTERVAL_MS}ms`,
    backgroundTasks: 'manual',
    startScheduler: false,
    recover: false,
    // The first turn never runs, so the activity has not run anywhere yet.
    inlineLaunchScheduling: 'manual',
  });
  await previousOwner.start('counted', null, { id: workflowId, services: { owner: 'previous' } });
  // A graceful exit releases the claim; a crash leaves it to expire. Either way nothing drives it.
  if (dispose) await previousOwner[Symbol.asyncDispose]();
}

type Recovering = {
  engine: Engine<{ counted: ReturnType<typeof countingWorkflow> }, object>;
  setNow: (value: number) => void;
  /** Calls to `resolveWorkflowServices`, and the deferred that holds the first one. */
  resolver: { calls: number; hold: ReturnType<typeof createDeferred<void>> | null };
};

async function createRecoveringEngine(
  storage: Storage,
  startNow: number,
  holdFirstResolve: boolean,
): Promise<Recovering> {
  let now = startNow;
  const resolver: Recovering['resolver'] = {
    calls: 0,
    hold: holdFirstResolve ? createDeferred<void>() : null,
  };
  const engine = await Engine.create({
    storage,
    workflows: { counted: countingWorkflow(storage) },
    ownership: 'workflow-lease',
    getNow: () => now,
    workflowClaimTtl: `${CLAIM_TTL_MS}ms`,
    workflowClaimRenewInterval: `${CLAIM_RENEW_INTERVAL_MS}ms`,
    backgroundTasks: 'manual',
    startScheduler: false,
    recover: false,
    resolveWorkflowServices: async () => {
      resolver.calls++;
      if (resolver.calls === 1) await resolver.hold?.promise;
      return { status: 'available', services: { owner: 'recovered' } };
    },
  });
  return { engine, setNow: (value) => void (now = value), resolver };
}

/** Let every other task queued on the event loop run, so a drive that is going to start has. */
async function letOtherDrivesStart(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await yieldToEventLoop();
}

type Interleaving = {
  name: string;
  /** Hold the first `resolveWorkflowServices` call, so a resume stays before it adopts. */
  holdResolver: boolean;
  /** Hold the first activity, so a drive that adopted stays running. */
  holdActivity: boolean;
  /** Whether the reclaim's replay is released before `recoverAll()` starts. */
  releaseReclaimFirst: boolean;
};

const INTERLEAVINGS: Interleaving[] = [
  {
    name: 'drive A is held in resolveWorkflowServices, before it adopts',
    holdResolver: true,
    holdActivity: false,
    releaseReclaimFirst: false,
  },
  {
    name: 'drive A has adopted and is running',
    holdResolver: false,
    holdActivity: true,
    releaseReclaimFirst: false,
  },
  {
    name: "the reclaim's resume registered first",
    holdResolver: true,
    holdActivity: false,
    releaseReclaimFirst: true,
  },
];

describe('a claim takeover that races recoverAll() drives the generation once', () => {
  describe.each(INTERLEAVINGS)('$name', (interleaving) => {
    it('runs the activity exactly once', async () => {
      const storage = new MemoryStorage();
      const startNow = 5_000_000;
      await strandWorkflow(storage, () => startNow, 'raced-run', false);
      const probe = probeFor(storage);
      if (interleaving.holdActivity) probe.hold = createDeferred<void>();

      const recovering = await createRecoveringEngine(
        storage,
        startNow + EXPIRED_AFTER_MS,
        interleaving.holdResolver,
      );
      await using engine = recovering.engine;
      const internals = getInternals(engine);

      const reclaimGate = createDeferred<void>();
      const reclaimReachedGate = createDeferred<void>();
      internals.reclaimReplayGateForTesting = () => {
        reclaimReachedGate.resolve();
        return reclaimGate.promise;
      };

      // The reclaim takes the dead owner's claim and stops at the gate.
      const reclaimPass = internals.workflowClaimRenewalTask!.runOnce();
      await reclaimReachedGate.promise;
      expect(internals.workflowClaimRegistry!.currentEpoch('raced-run')).not.toBeNull();

      let recovery: Promise<unknown>;
      if (interleaving.releaseReclaimFirst) {
        // The reclaim's resume registers before `recoverAll()` looks.
        reclaimGate.resolve();
        await waitForCondition(() => recovering.resolver.calls === 1, {
          label: "the reclaim's resume is held in resolveWorkflowServices",
        });
        recovery = engine.recoverAll();
      } else {
        recovery = engine.recoverAll();
        await waitForCondition(
          () => (interleaving.holdResolver ? recovering.resolver.calls === 1 : probe.runs === 1),
          { label: 'drive A is held where the case needs it' },
        );
        reclaimGate.resolve();
      }
      await letOtherDrivesStart();
      recovering.resolver.hold?.resolve();
      await letOtherDrivesStart();
      probe.hold?.resolve();

      const [pass] = await Promise.all([reclaimPass, recovery]);
      expect(pass.reclaim).toMatchObject({ status: 'completed' });
      expect(await engine.getHandle('raced-run').result()).toBe('ran');
      expect(probe.runs).toBe(1);
    });
  });
});

/**
 * Holds the reclaim pass's last candidate scan (the bounded read of authoritative workflow
 * records, the only `wf:` scan that passes a limit) after the candidates of its earlier scans are
 * collected, so a test can run `recoverAll()` between the listing and the attempts.
 */
class ListingGatedStorage extends MemoryStorage {
  gate: ReturnType<typeof createDeferred<void>> | null = null;
  readonly reachedGate = createDeferred<void>();

  override async *scan(
    prefix: string,
    options?: Parameters<MemoryStorage['scan']>[1],
  ): AsyncIterable<[string, Uint8Array]> {
    if (this.gate !== null && prefix === 'wf:' && options?.limit !== undefined) {
      this.reachedGate.resolve();
      await this.gate.promise;
    }
    yield* super.scan(prefix, options);
  }
}

type SiblingCase = {
  name: string;
  /** What lands on the engine between the listing and the attempt. */
  claimLandsAs: 'held-resume' | 'running-drive' | 'bare-claim';
};

const SIBLING_CASES: SiblingCase[] = [
  {
    name: "recoverAll()'s fresh claim is held in resolveWorkflowServices, before its drive adopts",
    claimLandsAs: 'held-resume',
  },
  { name: "recoverAll()'s fresh claim has a running drive", claimLandsAs: 'running-drive' },
  { name: 'a claim landed and nothing drives it yet', claimLandsAs: 'bare-claim' },
];

describe('a held claim reaches attemptWorkflowClaimTakeover between listing and attempt', () => {
  describe.each(SIBLING_CASES)('$name', ({ claimLandsAs }) => {
    it('redrives a claim nothing drives, and runs the activity exactly once', async () => {
      const storage = new ListingGatedStorage();
      const startNow = 6_000_000;
      await strandWorkflow(storage, () => startNow, 'sibling-run', true);
      const probe = probeFor(storage);
      if (claimLandsAs === 'running-drive') probe.hold = createDeferred<void>();

      const recovering = await createRecoveringEngine(
        storage,
        startNow + EXPIRED_AFTER_MS,
        claimLandsAs === 'held-resume',
      );
      await using engine = recovering.engine;
      const internals = getInternals(engine);
      const registry = internals.workflowClaimRegistry!;
      expect(registry.currentEpoch('sibling-run')).toBeNull();

      // The candidate is listed while this engine does not hold it.
      storage.gate = createDeferred<void>();
      const reclaimPass = internals.workflowClaimRenewalTask!.runOnce();
      await storage.reachedGate.promise;
      expect(registry.currentEpoch('sibling-run')).toBeNull();

      let recovery: Promise<unknown> = Promise.resolve();
      if (claimLandsAs === 'bare-claim') {
        expect(await registry.acquire('sibling-run')).toMatchObject({ status: 'acquired' });
      } else {
        // `recoverAll()` acquires the claim, and then the attempt runs.
        recovery = engine.recoverAll();
        await waitForCondition(
          () =>
            claimLandsAs === 'held-resume' ? recovering.resolver.calls === 1 : probe.runs === 1,
          { label: "recoverAll()'s drive is where the case needs it" },
        );
      }
      storage.gate.resolve();
      await letOtherDrivesStart();
      recovering.resolver.hold?.resolve();
      await letOtherDrivesStart();
      probe.hold?.resolve();

      const [pass] = await Promise.all([reclaimPass, recovery]);
      expect(pass.reclaim).toMatchObject({
        status: 'completed',
        outcomes: [{ workflowId: 'sibling-run', status: 'reclaimed' }],
      });
      expect(await engine.getHandle('sibling-run').result()).toBe('ran');
      expect(probe.runs).toBe(1);
    });
  });
});
