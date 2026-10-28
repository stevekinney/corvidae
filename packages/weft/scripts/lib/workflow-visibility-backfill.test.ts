import { describe, expect, it } from 'bun:test';

import { decode, encode } from '../../src/core/codec.ts';
import { decodeWorkflowState } from '../../src/core/engine/validation.ts';
import {
  deriveWorkflowVisibilityIndexKeys,
  getWorkflowVisibilityWatermark,
} from '../../src/core/engine/workflow-indexes.ts';
import { KEYS, type ScanOptions } from '../../src/storage/interface.ts';
import { MemoryStorage } from '../../src/storage/memory.ts';
import {
  advanceTimersByTime,
  flushMicrotasks,
  restoreRealTimers,
  useFakeTimers,
} from '../../src/testing/fake-timers.test-support.ts';

import {
  WORKFLOW_VISIBILITY_BACKFILL_SETTLE_MILLISECONDS,
  WorkflowVisibilityBackfillInProgressError,
  runWorkflowVisibilityBackfill,
  runWorkflowVisibilityDrop,
} from './workflow-visibility-backfill.ts';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  NoConditionalBatchStorage,
  RacingStorage,
  collectKeys,
  makeWorkflowState,
  seedWorkflow,
} from './workflow-visibility-backfill.test-support.ts';

/** Records what a reader would conclude from the watermark each time the workflow keyspace is scanned. */
class WatermarkProbingStorage extends MemoryStorage {
  readonly watermarksAtScan: string[] = [];

  override async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    if (prefix === 'wf:') {
      this.watermarksAtScan.push(await getWorkflowVisibilityWatermark(this));
    }
    yield* super.scan(prefix, options);
  }
}

/** One pause, taken the first time the visibility index is swept, that a test releases when it is ready. */
function createSweepGate() {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let armed = false;
  let used = false;
  return {
    /** Start pausing: sweeps before this (the seeding backfill's own) pass through. */
    arm: () => {
      armed = true;
    },
    /** Resolves when a sweep has started and is waiting on the gate. */
    reached: reached.promise,
    release: () => released.resolve(),
    async pause(): Promise<void> {
      if (!armed || used) return;
      used = true;
      reached.resolve();
      await released.promise;
    },
  };
}

/** Index rows proper, without the `wf-idx-meta:` control keys the drop leaves alone. */
function isIndexRow(key: string): boolean {
  return !key.startsWith('wf-idx-meta:');
}

describe('runWorkflowVisibilityBackfill', () => {
  it('writes the index rows and watermark for a fresh database', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-b', type: 'payment' }));

    const report = await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    expect(report.processed).toBe(2);
    expect(report.conflicts).toBe(0);
    expect(report.watermarkWritten).toBe(true);

    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
    expect(await storage.get(KEYS.workflowVisibilityMetaCursor())).toBeNull();

    const storedA = await storage.get(KEYS.workflow('wf-a'));
    for (const key of deriveWorkflowVisibilityIndexKeys(decodeWorkflowState(storedA!))) {
      expect(await storage.has(key)).toBe(true);
    }
    expect(await collectKeys(storage, 'wf-idx-manifest:')).toEqual([]);

    const statusRows = await collectKeys(storage, 'wf-idx-status:');
    expect(statusRows).toContain(KEYS.workflowVisibilityStatus('running', 'wf-a'));
    expect(statusRows).toContain(KEYS.workflowVisibilityStatus('running', 'wf-b'));
  });

  it('is idempotent on a second pass', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));

    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    const firstRows = await collectKeys(storage, 'wf-idx-status:');
    const firstStatusRows = firstRows.toSorted();

    const second = await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    expect(second.processed).toBe(1);
    expect(second.watermarkWritten).toBe(true);

    const secondRows = await collectKeys(storage, 'wf-idx-status:');
    const secondStatusRows = secondRows.toSorted();
    expect(secondStatusRows).toEqual(firstStatusRows);
  });

  it('skips workflows that the engine updates mid-backfill (conditional-batch conflict)', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-b' }));

    const racingStorage = new RacingStorage(storage, new Set(['wf-a']));
    const report = await runWorkflowVisibilityBackfill(racingStorage, { settleMilliseconds: 0 });

    // wf-a was updated mid-backfill; wf-b processed cleanly.
    expect(report.processed).toBe(1);
    expect(report.conflicts).toBe(1);
    // Watermark must NOT advance when conflicts occurred.
    expect(report.watermarkWritten).toBe(false);
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
  });

  it('resumes from the persisted cursor', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-b' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-c' }));

    // Plant a cursor pointing past wf-a so the next run only processes b and c.
    await storage.put(KEYS.workflowVisibilityMetaCursor(), encode(KEYS.workflow('wf-a')));

    const report = await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    expect(report.processed).toBe(2);
    expect(report.watermarkWritten).toBe(true);

    // wf-a was skipped, so it has no index rows.
    expect(await storage.has(KEYS.workflowVisibilityStatus('running', 'wf-a'))).toBe(false);
    expect(await storage.has(KEYS.workflowVisibilityStatus('running', 'wf-b'))).toBe(true);
    expect(await storage.has(KEYS.workflowVisibilityStatus('running', 'wf-c'))).toBe(true);
  });

  it.each([
    {
      name: 'middle conflict',
      cursor: undefined,
      targets: ['wf-b'],
      processed: 3,
      resume: 'wf-a',
      retryCount: 3,
    },
    {
      name: 'first conflict',
      cursor: undefined,
      targets: ['wf-a'],
      processed: 3,
      resume: undefined,
      retryCount: 4,
    },
    {
      name: 'existing cursor and multiple conflicts',
      cursor: 'wf-a',
      targets: ['wf-b', 'wf-c'],
      processed: 1,
      resume: 'wf-a',
      retryCount: 3,
    },
  ])(
    'keeps the cursor before unresolved work: $name',
    async ({ cursor, targets, processed, resume, retryCount }) => {
      using storage = new MemoryStorage();
      for (const id of ['wf-a', 'wf-b', 'wf-c', 'wf-d']) {
        await seedWorkflow(storage, makeWorkflowState({ id }));
      }
      if (cursor !== undefined) {
        await storage.put(KEYS.workflowVisibilityMetaCursor(), encode(KEYS.workflow(cursor)));
      }
      let watermarkChecks = 0;
      const racingStorage = new RacingStorage(storage, new Set(targets), async () => {
        expect(await storage.get(KEYS.workflowVisibilityMetaVersion())).toBeNull();
        expect(await storage.get(KEYS.workflowVisibilityMetaBuiltAt())).toBeNull();
        for (const id of targets) {
          const stateBytes = await storage.get(KEYS.workflow(id));
          if (stateBytes === null) throw new Error(`Missing workflow before watermark: ${id}`);
          for (const key of deriveWorkflowVisibilityIndexKeys(decodeWorkflowState(stateBytes))) {
            expect(await storage.has(key)).toBe(true);
          }
        }
        watermarkChecks += 1;
      });
      const first = await runWorkflowVisibilityBackfill(racingStorage, { settleMilliseconds: 0 });
      expect(first).toEqual({ processed, conflicts: targets.length, watermarkWritten: false });
      expect(watermarkChecks).toBe(0);
      const savedCursor = await storage.get(KEYS.workflowVisibilityMetaCursor());
      expect(savedCursor === null ? null : decode(savedCursor)).toBe(
        resume === undefined ? null : KEYS.workflow(resume),
      );

      const second = await runWorkflowVisibilityBackfill(racingStorage, { settleMilliseconds: 0 });
      expect(second).toEqual({ processed: retryCount, conflicts: 0, watermarkWritten: true });
      expect(watermarkChecks).toBe(1);
      expect(await storage.get(KEYS.workflowVisibilityMetaBuiltAt())).not.toBeNull();
      expect(await storage.get(KEYS.workflowVisibilityMetaCursor())).toBeNull();
      expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
    },
  );

  it('holds the backfill lock through the watermark batch and releases it afterwards', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    const lockHeldAtWatermark: boolean[] = [];
    const observingStorage = new RacingStorage(storage, new Set(), async () => {
      lockHeldAtWatermark.push(await storage.has(KEYS.workflowVisibilityMetaBuilding()));
    });
    expect(await storage.has(KEYS.workflowVisibilityMetaBuilding())).toBe(false);

    const report = await runWorkflowVisibilityBackfill(observingStorage, { settleMilliseconds: 0 });

    expect(report.watermarkWritten).toBe(true);
    expect(lockHeldAtWatermark).toEqual([true]);
    expect(await storage.has(KEYS.workflowVisibilityMetaBuilding())).toBe(false);
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
  });

  it('releases the backfill lock when conflicts stop the run short of the watermark', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    const racingStorage = new RacingStorage(storage, new Set(['wf-a']));

    const report = await runWorkflowVisibilityBackfill(racingStorage, { settleMilliseconds: 0 });

    expect(report.watermarkWritten).toBe(false);
    expect(await storage.has(KEYS.workflowVisibilityMetaBuilding())).toBe(false);
  });

  it('lets only one of two concurrent runs proceed', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));

    const outcomes = await Promise.allSettled([
      runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 20 }),
      runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 20 }),
    ]);

    expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual(['fulfilled', 'rejected']);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(WorkflowVisibilityBackfillInProgressError);
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
    expect(await storage.has(KEYS.workflowVisibilityMetaBuilding())).toBe(false);
  });

  it('stops writing index rows and its cursor once a drop takes its lock over mid-scan', async () => {
    class TakeoverStorage extends MemoryStorage {
      takenOver = false;
      override async conditionalBatch(
        conditions: Parameters<NonNullable<MemoryStorage['conditionalBatch']>>[0],
        operations: Parameters<NonNullable<MemoryStorage['conditionalBatch']>>[1],
      ): Promise<boolean> {
        const indexesWorkflow = conditions.some((condition) => condition.key.startsWith('wf:'));
        if (indexesWorkflow && !this.takenOver) {
          this.takenOver = true;
          await runWorkflowVisibilityDrop(this, { settleMilliseconds: 0 });
        }
        return super.conditionalBatch(conditions, operations);
      }
    }
    using storage = new TakeoverStorage();
    for (const id of ['wf-a', 'wf-b', 'wf-c']) {
      await seedWorkflow(storage, makeWorkflowState({ id }));
    }

    expect(
      await throwingRejectionOf(runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 })),
    ).toThrow(WorkflowVisibilityBackfillInProgressError);

    // The taken-over run wrote nothing after the drop swept.
    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([]);
    expect(await storage.get(KEYS.workflowVisibilityMetaCursor())).toBeNull();
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');

    // So the follow-up backfill starts from the beginning and indexes every workflow.
    const report = await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    expect(report.watermarkWritten).toBe(true);
    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([
      KEYS.workflowVisibilityStatus('running', 'wf-a'),
      KEYS.workflowVisibilityStatus('running', 'wf-b'),
      KEYS.workflowVisibilityStatus('running', 'wf-c'),
    ]);
  });

  it('restores every derived row when a runtime write between the sweep and the scan put back only one', async () => {
    const state = makeWorkflowState({ id: 'wf-a' });
    // Derived the way the backfill derives them: from the record as it is stored.
    const derivedKeys = deriveWorkflowVisibilityIndexKeys(decodeWorkflowState(encode(state)));
    expect(derivedKeys.length).toBeGreaterThan(1);
    class WriteAfterSweepStorage extends MemoryStorage {
      wroteAfterSweep = false;
      override async *scan(
        prefix: string,
        options?: ScanOptions,
      ): AsyncIterable<[string, Uint8Array]> {
        if (prefix === 'wf:' && !this.wroteAfterSweep) {
          this.wroteAfterSweep = true;
          // A runtime transition between the sweep and the scan puts back only the row it changed.
          await this.put(derivedKeys[0]!, new Uint8Array(0));
        }
        yield* super.scan(prefix, options);
      }
    }
    using storage = new WriteAfterSweepStorage();
    await seedWorkflow(storage, state);

    const report = await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    expect(report.watermarkWritten).toBe(true);
    for (const key of derivedKeys) {
      expect(await storage.has(key)).toBe(true);
    }
  });

  it('refuses to start while another run holds the lock, touching nothing', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    const heldLock = encode('another-run');
    await storage.put(KEYS.workflowVisibilityMetaBuilding(), heldLock);

    expect(
      await throwingRejectionOf(runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 })),
    ).toThrow(WorkflowVisibilityBackfillInProgressError);
    expect(await storage.get(KEYS.workflowVisibilityMetaBuilding())).toEqual(heldLock);
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
  });

  it('does not publish the watermark after a drop cleared its lock mid-run', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    const droppingStorage = new RacingStorage(storage, new Set(), async () => {
      await runWorkflowVisibilityDrop(storage, { settleMilliseconds: 0 });
    });

    expect(
      await throwingRejectionOf(
        runWorkflowVisibilityBackfill(droppingStorage, { settleMilliseconds: 0 }),
      ),
    ).toThrow(WorkflowVisibilityBackfillInProgressError);
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([]);
  });

  it('takes the watermark down before it clears rows for a full rebuild', async () => {
    using storage = new WatermarkProbingStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
    storage.watermarksAtScan.length = 0;

    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    // By the time the rebuild scans workflows, readers already fell back to the slow path.
    expect(storage.watermarksAtScan).toEqual(['stale']);
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
  });

  it('rebuilds from empty, dropping stale and orphaned rows an idle-watermark engine left', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a', status: 'completed' }));
    // Rows from before the watermark went stale: one for a workflow that no longer exists, one
    // that still names the workflow's old status.
    await storage.put(KEYS.workflowVisibilityStatus('running', 'ghost'), new Uint8Array(0));
    await storage.put(KEYS.workflowVisibilityStatus('running', 'wf-a'), new Uint8Array(0));
    // A per-workflow manifest row, which only index layout version 1 wrote.
    await storage.put('wf-idx-manifest:ghost', encode({ version: 1, keys: [] }));

    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([
      KEYS.workflowVisibilityStatus('completed', 'wf-a'),
    ]);
    expect(await collectKeys(storage, 'wf-idx-manifest:')).toEqual([]);
  });

  it('keeps the rows it already wrote when it resumes from a saved cursor', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-b' }));
    await storage.put(KEYS.workflowVisibilityMetaCursor(), encode(KEYS.workflow('wf-a')));
    await storage.put(KEYS.workflowVisibilityStatus('running', 'wf-a'), new Uint8Array(0));

    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([
      KEYS.workflowVisibilityStatus('running', 'wf-a'),
      KEYS.workflowVisibilityStatus('running', 'wf-b'),
    ]);
  });

  it('rebuilds from empty instead of resuming over rows a layout-version-1 run left (COR-1387)', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-b' }));
    // An interrupted version-1 run: its cursor, a manifest row, and an exact-timestamp updated row.
    await storage.put(KEYS.workflowVisibilityMetaCursor(), encode(KEYS.workflow('wf-a')));
    await storage.put('wf-idx-manifest:wf-a', encode({ version: 1, keys: [] }));
    const versionOneUpdatedRow = `wf-idx-updated:0001700000000500:wf-a`;
    await storage.put(versionOneUpdatedRow, new Uint8Array(0));

    const report = await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    expect(report).toEqual({ processed: 2, conflicts: 0, watermarkWritten: true });
    expect(await collectKeys(storage, 'wf-idx-manifest:')).toEqual([]);
    expect(await storage.has(versionOneUpdatedRow)).toBe(false);
    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([
      KEYS.workflowVisibilityStatus('running', 'wf-a'),
      KEYS.workflowVisibilityStatus('running', 'wf-b'),
    ]);
  });

  it('waits the settle window after removing the watermark and before it touches any row', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    const messages: string[] = [];
    const startedAt = performance.now();

    await runWorkflowVisibilityBackfill(storage, {
      settleMilliseconds: 60,
      logger: (message) => messages.push(message),
    });

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(55);
    expect(messages[0]).toContain('Waiting 60ms');
  });

  it('treats an undecodable saved cursor as no cursor and rebuilds from empty', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await storage.put(KEYS.workflowVisibilityStatus('running', 'ghost'), new Uint8Array(0));
    // 0xc1 is the one byte MessagePack never assigns, so decoding it throws.
    await storage.put(KEYS.workflowVisibilityMetaCursor(), new Uint8Array([0xc1]));

    const report = await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    expect(report).toEqual({ processed: 1, conflicts: 0, watermarkWritten: true });
    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([
      KEYS.workflowVisibilityStatus('running', 'wf-a'),
    ]);
  });

  it('reports progress every checkpointEvery processed workflows', async () => {
    using storage = new MemoryStorage();
    for (const id of ['wf-a', 'wf-b', 'wf-c']) {
      await seedWorkflow(storage, makeWorkflowState({ id }));
    }
    const messages: string[] = [];

    await runWorkflowVisibilityBackfill(storage, {
      settleMilliseconds: 0,
      checkpointEvery: 2,
      logger: (message) => messages.push(message),
    });

    expect(messages.filter((message) => message.startsWith('Processed '))).toEqual([
      'Processed 2 workflows (last: wf-b)',
    ]);
  });

  it('refuses to run when the storage backend has no conditionalBatch', async () => {
    const storage = new NoConditionalBatchStorage();
    expect(
      await throwingRejectionOf(runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 })),
    ).toThrow(/does not expose conditionalBatch/);
  });
});

describe('runWorkflowVisibilityDrop', () => {
  it('removes the watermark before sweeping rows and clears the cursor last', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');

    await runWorkflowVisibilityDrop(storage, { settleMilliseconds: 0 });

    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
    expect(await storage.get(KEYS.workflowVisibilityMetaCursor())).toBeNull();
    expect(await storage.get(KEYS.workflowVisibilityMetaBuiltAt())).toBeNull();

    for (const prefix of [
      'wf-idx-status:',
      'wf-idx-type:',
      'wf-idx-tenant:',
      'wf-idx-created:',
      'wf-idx-updated:',
      'wf-idx-deadline:',
      'wf-idx-manifest:',
    ]) {
      expect(await collectKeys(storage, prefix)).toEqual([]);
    }
  });

  it('sweeps rows in fallbackBatchSize batches when the backend has no deletePrefix', async () => {
    using storage = new MemoryStorage();
    for (const id of ['wf-a', 'wf-b', 'wf-c', 'wf-d', 'wf-e']) {
      await seedWorkflow(storage, makeWorkflowState({ id }));
    }
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    const keysBefore = await collectKeys(storage, 'wf-idx-');
    const rowsBefore = keysBefore.filter(isIndexRow);
    // RacingStorage does not expose deletePrefix, so the drop takes the scan-and-batch path.
    const fallbackStorage = new RacingStorage(storage, new Set());

    const report = await runWorkflowVisibilityDrop(fallbackStorage, {
      fallbackBatchSize: 2,
      settleMilliseconds: 0,
    });

    const keysAfter = await collectKeys(storage, 'wf-idx-');
    const rowsAfter = keysAfter.filter(isIndexRow);
    // Four index rows per workflow: status, type, created and updated.
    expect(rowsBefore).toHaveLength(20);
    expect(report.rowsDeleted).toBe(rowsBefore.length);
    expect(rowsAfter).toEqual([]);
  });

  it('reads the index one page at a time while it sweeps', async () => {
    class PageRecordingStorage extends MemoryStorage {
      readonly limits: (number | undefined)[] = [];
      override async *scan(
        prefix: string,
        options?: ScanOptions,
      ): AsyncIterable<[string, Uint8Array]> {
        if (prefix.startsWith('wf-idx-status:')) this.limits.push(options?.limit);
        yield* super.scan(prefix, options);
      }
    }
    using storage = new PageRecordingStorage();
    for (let index = 0; index < 5; index += 1) {
      await seedWorkflow(storage, makeWorkflowState({ id: `wf-page-${index}` }));
    }
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    storage.limits.length = 0;

    const report = await runWorkflowVisibilityDrop(storage, {
      fallbackBatchSize: 2,
      settleMilliseconds: 0,
    });

    // Five status rows in pages of two: 2, 2, 1, then an empty page that ends the sweep.
    expect(storage.limits).toEqual([2, 2, 2, 2]);
    expect(report.rowsDeleted).toBeGreaterThanOrEqual(5);
    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([]);
  });

  it('leaves workflow state untouched', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    await runWorkflowVisibilityDrop(storage, { settleMilliseconds: 0 });

    expect(await storage.get(KEYS.workflow('wf-a'))).not.toBeNull();
  });
  it('holds the backfill lock until its sweep finishes, so no backfill can start mid-drop', async () => {
    const sweepGate = createSweepGate();
    class SweepGatedStorage extends MemoryStorage {
      override async *scan(
        prefix: string,
        options?: ScanOptions,
      ): AsyncIterable<[string, Uint8Array]> {
        if (prefix.startsWith('wf-idx-') && !prefix.startsWith('wf-idx-meta:')) {
          await sweepGate.pause();
        }
        yield* super.scan(prefix, options);
      }
    }
    using storage = new SweepGatedStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    sweepGate.arm();
    const drop = runWorkflowVisibilityDrop(storage, { settleMilliseconds: 0 });
    // The drop holds the lock and is mid-sweep, rows not yet removed: the gate keeps it there until
    // the backfill has been refused, however long the host takes to get that far.
    await sweepGate.reached;
    expect(
      await throwingRejectionOf(runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 })),
    ).toThrow(WorkflowVisibilityBackfillInProgressError);
    sweepGate.release();
    await drop;

    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([]);
    expect(await storage.has(KEYS.workflowVisibilityMetaBuilding())).toBe(false);

    const report = await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    expect(report.watermarkWritten).toBe(true);
  });

  it('releases its lock on a backend without conditionalBatch, and only its own', async () => {
    const sweepGate = createSweepGate();
    class CompareFreeStorage extends MemoryStorage {
      override capabilities() {
        return { ...super.capabilities(), conditionalBatch: false };
      }
      override async deletePrefix(prefix: string): Promise<number> {
        await sweepGate.pause();
        return super.deletePrefix(prefix);
      }
    }
    using storage = new CompareFreeStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));

    await runWorkflowVisibilityDrop(storage, { settleMilliseconds: 0 });
    expect(await storage.has(KEYS.workflowVisibilityMetaBuilding())).toBe(false);

    // A run that took the lock over while this drop swept keeps it.
    const takeover = encode('another-run');
    sweepGate.arm();
    const drop = runWorkflowVisibilityDrop(storage, { settleMilliseconds: 0 });
    await sweepGate.reached;
    await storage.put(KEYS.workflowVisibilityMetaBuilding(), takeover);
    sweepGate.release();
    await drop;
    expect(await storage.get(KEYS.workflowVisibilityMetaBuilding())).toEqual(takeover);
  });

  it('clears a lock a killed run left and waits the settle window before sweeping rows', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    await storage.put(KEYS.workflowVisibilityMetaBuilding(), encode(Date.now()));
    const messages: string[] = [];
    const startedAt = performance.now();

    await runWorkflowVisibilityDrop(storage, {
      settleMilliseconds: 60,
      logger: (message) => messages.push(message),
    });

    expect(await storage.has(KEYS.workflowVisibilityMetaBuilding())).toBe(false);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(55);
    expect(messages[0]).toContain('Waiting 60ms');
    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([]);
  });
});

describe('runWorkflowVisibilityDrop with no options', () => {
  it('waits out the default settle window, then sweeps with the default batch size', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-default-options' }));
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    const keysBefore = await collectKeys(storage, 'wf-idx-');
    const rowsBefore = keysBefore.filter(isIndexRow);
    useFakeTimers();
    try {
      const dropping = runWorkflowVisibilityDrop(storage);
      // The settle timer is armed after the lock write and the watermark commit settle.
      await flushMicrotasks(50);
      await advanceTimersByTime(WORKFLOW_VISIBILITY_BACKFILL_SETTLE_MILLISECONDS);
      const report = await dropping;

      expect(rowsBefore.length).toBeGreaterThan(0);
      expect(report.rowsDeleted).toBe(rowsBefore.length);
    } finally {
      restoreRealTimers();
    }
  });
});
