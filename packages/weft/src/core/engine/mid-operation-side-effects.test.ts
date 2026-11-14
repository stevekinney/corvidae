/**
 * COR-2416: a `ctx.all` slot committed while a sibling still waits carries what its branch's
 * operation staged for the checkpoint, so a crash right after that commit loses no effect the
 * branch asked for. Each test takes the store as the crash leaves it (a copy made the moment the
 * slot commit has landed, before anything else is written) and recovers a new engine from it.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';

import { KEYS } from '../../storage/keys.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import { decode } from '../codec.ts';
import { isParallelOperationCacheEntry } from '../context/parallel-cache-entry.ts';
import { activity, workflow, type ActivityContext, type WorkflowContext } from '../types.ts';
import { asyncActivityWorkflowPrefix } from './async-activity-records.ts';
import { Engine } from './index.ts';

/** Whether slot `index` of the run's committed `ctx.all` entry is fulfilled. */
async function hasCommittedSlot(storage: MemoryStorage, id: string, index: number) {
  const bytes = await storage.get(KEYS.checkpoint(id));
  if (bytes === null) return false;
  const entry = deserializeCheckpoint(bytes)
    .accumulatedResults.map(([, value]) => value)
    .find(isParallelOperationCacheEntry);
  return entry?.branches[index]?.status === 'fulfilled';
}

/** The store as a crash at this moment would leave it. */
async function crashedCopy(storage: MemoryStorage): Promise<MemoryStorage> {
  const copy = new MemoryStorage();
  for (const [key, value] of storage.snapshot()) await copy.put(key, value);
  return copy;
}

async function statusOf(engine: Engine, id: string): Promise<string | undefined> {
  const state = await engine.get(id);
  return state?.status;
}

describe('a ctx.all slot committed while a sibling waits carries its branch`s staged effects', () => {
  it('writes a request-cancel child`s cancellation link with the slot, so a cancel after a crash reaches the child', async () => {
    const parentId = 'staged-cancel-parent';
    const childId = 'staged-cancel-child';
    const child = workflow({ name: 'staged-cancel-child' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal('finish');
    });
    const parent = workflow({ name: 'staged-cancel-parent' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.all([
        ctx.startChild('staged-cancel-child', null, {
          id: childId,
          parentClosePolicy: 'request-cancel',
        }),
        ctx.waitForSignal('go'),
      ]);
    });
    const storage = new MemoryStorage();
    let crashed: MemoryStorage;
    {
      await using original = new Engine({ storage });
      original.register(child);
      original.register(parent);
      await original.start('staged-cancel-parent', null, { id: parentId });
      await waitUntil(async () => hasCommittedSlot(storage, parentId, 0), {
        message: 'the child`s slot to be committed',
      });
      crashed = await crashedCopy(storage);
    }
    // The link was requested by the branch whose slot is durable: it is durable too.
    expect(await crashed.has(KEYS.childCancellation(parentId, childId))).toBe(true);
    await using recovered = new Engine({ storage: crashed });
    recovered.register(child);
    recovered.register(parent);
    await recovered.recoverAll();
    await recovered.cancel(parentId);
    await waitUntil(async () => (await statusOf(recovered, childId)) === 'cancelled', {
      message: 'the child to be cancelled with its parent',
    });
  });

  it('writes an idempotent activity`s completed receipt with the slot, so a crash leaves no started receipt behind', async () => {
    const id = 'staged-receipt-run';
    let charges = 0;
    const charge = activity({
      name: 'charge',
      idempotencyKey: () => 'charge-1',
      execute: () => {
        charges += 1;
        return 'charged';
      },
    });
    const define = () =>
      workflow({ name: 'staged-receipt' })
        .activities({ charge })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.all([ctx.run(charge, null), ctx.waitForSignal('go')]);
        });
    const storage = new MemoryStorage();
    let crashed: MemoryStorage;
    {
      await using original = new Engine({ storage });
      original.register(define());
      await original.start('staged-receipt', null, { id });
      await waitUntil(async () => hasCommittedSlot(storage, id, 0), {
        message: 'the activity`s slot to be committed',
      });
      crashed = await crashedCopy(storage);
    }
    const receipts = [...crashed.snapshot()]
      .filter(([key]) => key.startsWith(KEYS.activityReconciliationPrefix(id)))
      .map(([, value]) => (decode(value) as { status: string }).status);
    expect(receipts).toEqual(['completed']);
    await using recovered = new Engine({ storage: crashed });
    recovered.register(define());
    const [handle] = await recovered.recoverAll();
    await recovered.signal(id, 'go', 'went');
    expect(await handle!.result()).toEqual(['charged', 'went']);
    expect(charges).toBe(1);
  });

  it('never parks an async activity in a branch, so no resolution record is retired by a mid-operation commit', async () => {
    // An async activity parks only as a top-level operation (`processActivityOperation`): in a
    // branch its deferral fails the branch. Its resolution record's retire is therefore always
    // staged for the commit of the top-level operation it resumes, never beside a sibling.
    const id = 'staged-async-run';
    const awaitCallback = activity({
      name: 'awaitCallback',
      execute: (_input: void, context?: ActivityContext): unknown => context!.completeAsync(),
    });
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'staged-async' })
        .activities({ awaitCallback })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.all([ctx.run(awaitCallback), ctx.waitForSignal('go')]);
        }),
    );
    const run = await engine.start('staged-async', null, { id });
    await waitUntil(async () => (await statusOf(engine, id)) === 'running', {
      message: 'the run to start',
    });
    await engine.signal(id, 'go', 'went');
    expect(await rejectionOf(run.result())).toBeInstanceOf(Error);
    expect(await storage.count(asyncActivityWorkflowPrefix(id))).toBe(0);
  });
});
