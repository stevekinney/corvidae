/**
 * COR-1415: the engine-driven finalizer drive under `ownership: 'workflow-lease'`.
 *
 * A cancelled or timed-out workflow owes its definition-level finalizer after a terminal
 * that has already dropped (or rotated away) the workflow's per-workflow claim. The drive's
 * marker writes are fenced on `wf-owner-epoch:<id>`, so a drive with no claim of its own
 * failed closed forever and `getFinalizerStatus` stayed `pending`. These tests pin that the
 * drive takes its own claim for the duration of the drive (so the marker writes stay
 * fenced), that crash-adoption and two-engine races still finalize exactly once, and that a
 * stale holder still cannot write the marker.
 *
 * Time is a controllable `now`; synchronization is polling durable keys or awaiting the
 * drive itself, never a sleep.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { waitForCondition } from '../../../testing/fake-timers.test-support.ts';
import { throwingRejectionOf } from '../../../testing/promise-outcome.test-support.ts';
import { collectTeardownEvents } from '../../__tests__/finalizer-teardown.test-support.ts';
import { Engine } from '../../engine.ts';
import type { AnyActivityDefinition, WorkflowContext } from '../../types.ts';
import { activity, workflow } from '../../types.ts';
import { getInternals } from '../internals.ts';
import { EngineDeposedError } from '../lease-errors.ts';
import { claimTeardownMarker, encodeOwedClaim } from './finalizer-claim.ts';

const CLAIM_TTL_MS = 60_000;

type Clock = { now: number };

async function createLeaseEngine(storage: MemoryStorage, clock: Clock): Promise<Engine> {
  return Engine.create({
    storage,
    ownership: 'workflow-lease',
    workflowClaimTtl: '1m',
    workflowClaimRenewInterval: '5s',
    recover: false,
    backgroundTasks: 'manual',
    getNow: () => clock.now,
  });
}

function registerTeardownType(
  engine: Engine,
  type: string,
  finalizer: AnyActivityDefinition,
): void {
  engine.register(
    workflow({ name: type, finalizer }).execute(async function* (ctx: WorkflowContext) {
      ctx.setFinalizerState({ sandboxId: `sandbox-${ctx.workflowId}` });
      yield* ctx.waitForSignal('never');
    }),
  );
}

function countingFinalizer(name: string): { destroy: AnyActivityDefinition; destroyed: unknown[] } {
  const destroyed: unknown[] = [];
  const destroy = activity({
    name,
    execute: async (input: unknown) => {
      destroyed.push(input);
    },
  });
  return { destroy, destroyed };
}

async function startAndCancel(engine: Engine, storage: MemoryStorage, type: string, id: string) {
  const handle = await engine.start(type, null, { id });
  await waitForCondition(async () => (await storage.get(KEYS.finalizerState(id))) !== null, {
    label: `workflow ${id} recorded finalizer state and parked`,
    timeoutMs: 2000,
    intervalMs: 5,
  });
  await engine.cancel(id);
  expect(await throwingRejectionOf(handle.result())).toThrow('Workflow cancelled');
}

describe('finalizer teardown under ownership: workflow-lease (COR-1415)', () => {
  it('runs the definition-level finalizer exactly once after cancel and reports succeeded', async () => {
    const storage = new MemoryStorage();
    const clock: Clock = { now: 1_000_000 };
    const { destroy, destroyed } = countingFinalizer('destroy-lease-cancel');
    await using engine = await createLeaseEngine(storage, clock);
    registerTeardownType(engine, 'lease-cancel', destroy);
    const events = collectTeardownEvents(engine);

    await startAndCancel(engine, storage, 'lease-cancel', 'lease-cancel-1');
    await engine.scheduler.tick(clock.now);

    expect(destroyed).toEqual([{ sandboxId: 'sandbox-lease-cancel-1' }]);
    expect(events).toEqual([{ workflowId: 'lease-cancel-1', status: 'completed', attempts: 1 }]);
    expect(await engine.getFinalizerStatus('lease-cancel-1')).toMatchObject({
      status: 'succeeded',
    });
    expect(await storage.get(KEYS.teardownOwed('lease-cancel-1'))).toBeNull();
    expect(await storage.get(KEYS.finalizerState('lease-cancel-1'))).toBeNull();

    // The drive's own claim is released afterwards — it must not linger for the TTL.
    expect(getInternals(engine).workflowClaimRegistry?.currentEpoch('lease-cancel-1')).toBeNull();
    expect(await storage.get(KEYS.workflowOwnerHolder('lease-cancel-1'))).toBeNull();

    // A second tick finds nothing to drive: still exactly one run.
    await engine.scheduler.tick(clock.now + 1);
    expect(destroyed).toHaveLength(1);
  });

  it('a second engine adopts and finalizes exactly once a teardown the first engine owed when it died', async () => {
    const storage = new MemoryStorage();
    const clock: Clock = { now: 2_000_000 };
    const first = countingFinalizer('destroy-lease-crash');
    const engine1 = await createLeaseEngine(storage, clock);
    registerTeardownType(engine1, 'lease-crash', first.destroy);
    await startAndCancel(engine1, storage, 'lease-crash', 'lease-crash-1');
    // engine1 "dies" before its teardown timer is ever driven.
    await engine1[Symbol.asyncDispose]();
    expect(first.destroyed).toEqual([]);
    expect(await storage.get(KEYS.teardownOwed('lease-crash-1'))).not.toBeNull();

    const second = countingFinalizer('destroy-lease-crash');
    await using engine2 = await createLeaseEngine(storage, clock);
    registerTeardownType(engine2, 'lease-crash', second.destroy);
    await engine2.recoverAll();
    await engine2.scheduler.tick(clock.now);

    expect(second.destroyed).toEqual([{ sandboxId: 'sandbox-lease-crash-1' }]);
    expect(await engine2.getFinalizerStatus('lease-crash-1')).toMatchObject({
      status: 'succeeded',
    });
    await engine2.scheduler.tick(clock.now + 1);
    expect(second.destroyed).toHaveLength(1);
  });

  it('waits out a dead engine whose claim has not expired, then finalizes exactly once', async () => {
    const storage = new MemoryStorage();
    const clock: Clock = { now: 3_000_000 };
    const { destroy, destroyed } = countingFinalizer('destroy-lease-dead-holder');
    await using engine1 = await createLeaseEngine(storage, clock);
    registerTeardownType(engine1, 'lease-dead-holder', destroy);
    await startAndCancel(engine1, storage, 'lease-dead-holder', 'lease-dead-holder-1');

    // A teardown drive on another engine took a claim and then died without releasing it.
    await using deadEngine = await createLeaseEngine(storage, clock);
    const deadRegistry = getInternals(deadEngine).workflowClaimRegistry!;
    const deadClaim = await deadRegistry.acquire('lease-dead-holder-1');
    expect(deadClaim.status).toBe('acquired');

    // The claim is live: engine1 backs off and re-arms rather than running.
    await engine1.scheduler.tick(clock.now);
    expect(destroyed).toEqual([]);
    expect(await storage.get(KEYS.teardownOwed('lease-dead-holder-1'))).not.toBeNull();

    // Once the dead holder's claim expires, the re-armed timer takes it over and runs once.
    clock.now += CLAIM_TTL_MS * 4;
    await engine1.scheduler.tick(clock.now);
    expect(destroyed).toEqual([{ sandboxId: 'sandbox-lease-dead-holder-1' }]);
    await engine1.scheduler.tick(clock.now + 1);
    expect(destroyed).toHaveLength(1);
  });

  it('two engines racing for the same teardown never both run the finalizer', async () => {
    const storage = new MemoryStorage();
    const clock: Clock = { now: 4_000_000 };
    let finalizerStarts = 0;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const destroy = activity({
      name: 'destroy-lease-race',
      execute: async () => {
        finalizerStarts += 1;
        signalStarted();
        await gate;
      },
    });

    await using engineA = await createLeaseEngine(storage, clock);
    await using engineB = await createLeaseEngine(storage, clock);
    registerTeardownType(engineA, 'lease-race', destroy);
    registerTeardownType(engineB, 'lease-race', destroy);
    await startAndCancel(engineA, storage, 'lease-race', 'lease-race-1');

    const tickA = engineA.scheduler.tick(clock.now);
    const tickB = engineB.scheduler.tick(clock.now);
    await started;
    // Whichever engine won is parked inside the finalizer; the loser must have backed off.
    release();
    await Promise.all([tickA, tickB]);

    expect(finalizerStarts).toBe(1);
    expect(await engineA.getFinalizerStatus('lease-race-1')).toMatchObject({ status: 'succeeded' });
  });

  it('a stale epoch holder still cannot write the teardown marker while a live owner can', async () => {
    const storage = new MemoryStorage();
    const clock: Clock = { now: 5_000_000 };
    await using stale = await createLeaseEngine(storage, clock);
    await using live = await createLeaseEngine(storage, clock);
    const workflowId = 'lease-stale-holder-1';
    const token = 'stale-holder-token';

    const owedBytes = encodeOwedClaim(0, token);
    await storage.batch([{ type: 'put', key: KEYS.teardownOwed(workflowId), value: owedBytes }]);

    const staleRegistry = getInternals(stale).workflowClaimRegistry!;
    const liveRegistry = getInternals(live).workflowClaimRegistry!;
    const staleClaim = await staleRegistry.acquire(workflowId);
    expect(staleClaim.status).toBe('acquired');

    // The first holder stalls past its TTL; the live engine takes the claim at a newer epoch.
    clock.now += CLAIM_TTL_MS * 4;
    const takeover = await liveRegistry.takeover(workflowId);
    expect(takeover.status).toBe('acquired');

    expect(
      await throwingRejectionOf(
        claimTeardownMarker(getInternals(stale), workflowId, owedBytes, 0, token),
      ),
    ).toThrow(EngineDeposedError);
    expect(await storage.get(KEYS.teardownOwed(workflowId))).toEqual(owedBytes);

    const runningBytes = await claimTeardownMarker(
      getInternals(live),
      workflowId,
      owedBytes,
      0,
      token,
    );
    expect(runningBytes).not.toBeNull();
    expect(await storage.get(KEYS.teardownOwed(workflowId))).toEqual(runningBytes);
  });
});
