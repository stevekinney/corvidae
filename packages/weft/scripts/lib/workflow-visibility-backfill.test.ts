import { describe, expect, it } from 'bun:test';

import { decode, encode } from '../../src/core/codec.ts';
import {
  WORKFLOW_VISIBILITY_INDEX_VERSION,
  decodeWorkflowVisibilityManifest,
  getWorkflowVisibilityWatermark,
} from '../../src/core/engine/workflow-indexes.ts';
import { KEYS, type ScanOptions } from '../../src/storage/interface.ts';
import { MemoryStorage } from '../../src/storage/memory.ts';

import {
  runWorkflowVisibilityBackfill,
  runWorkflowVisibilityDrop,
} from './workflow-visibility-backfill.ts';

import { throwingRejectionOf } from '../../src/testing/promise-outcome.test-support.ts';
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

describe('runWorkflowVisibilityBackfill', () => {
  it('writes the manifest, index rows, and watermark for a fresh database', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-b', type: 'payment' }));

    const report = await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    expect(report.processed).toBe(2);
    expect(report.conflicts).toBe(0);
    expect(report.watermarkWritten).toBe(true);

    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
    expect(await storage.get(KEYS.workflowVisibilityMetaCursor())).toBeNull();

    const manifestA = decodeWorkflowVisibilityManifest(
      await storage.get(KEYS.workflowVisibilityManifest('wf-a')),
    );
    expect(manifestA?.version).toBe(WORKFLOW_VISIBILITY_INDEX_VERSION);
    expect(manifestA?.keys.length).toBeGreaterThan(0);

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

    // wf-a was skipped, so it has no manifest.
    expect(await storage.get(KEYS.workflowVisibilityManifest('wf-a'))).toBeNull();
    expect(await storage.get(KEYS.workflowVisibilityManifest('wf-b'))).not.toBeNull();
    expect(await storage.get(KEYS.workflowVisibilityManifest('wf-c'))).not.toBeNull();
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
          const manifest = decodeWorkflowVisibilityManifest(
            await storage.get(KEYS.workflowVisibilityManifest(id)),
          );
          if (manifest === null) throw new Error(`Missing manifest before watermark: ${id}`);
          for (const key of manifest.keys) expect(await storage.get(key)).not.toBeNull();
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

  it('raises the building marker before scanning and lowers it with the watermark', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    const markerSeenAtWatermark: boolean[] = [];
    const observingStorage = new RacingStorage(storage, new Set(), async () => {
      markerSeenAtWatermark.push(await storage.has(KEYS.workflowVisibilityMetaBuilding()));
    });
    expect(await storage.has(KEYS.workflowVisibilityMetaBuilding())).toBe(false);

    const report = await runWorkflowVisibilityBackfill(observingStorage, { settleMilliseconds: 0 });

    expect(report.watermarkWritten).toBe(true);
    // Still up when the watermark batch is about to commit, so an engine never sees neither.
    expect(markerSeenAtWatermark).toEqual([true]);
    expect(await storage.has(KEYS.workflowVisibilityMetaBuilding())).toBe(false);
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
  });

  it('leaves the building marker up when conflicts stop the run short of the watermark', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    const racingStorage = new RacingStorage(storage, new Set(['wf-a']));

    const report = await runWorkflowVisibilityBackfill(racingStorage, { settleMilliseconds: 0 });

    expect(report.watermarkWritten).toBe(false);
    expect(await storage.has(KEYS.workflowVisibilityMetaBuilding())).toBe(true);
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
    await storage.put(KEYS.workflowVisibilityManifest('ghost'), encode({ version: 1, keys: [] }));

    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([
      KEYS.workflowVisibilityStatus('completed', 'wf-a'),
    ]);
    expect(await collectKeys(storage, 'wf-idx-manifest:')).toEqual([
      KEYS.workflowVisibilityManifest('wf-a'),
    ]);
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

  it('waits the settle window after announcing itself and before it touches any row', async () => {
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

  it('leaves workflow state untouched', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    await runWorkflowVisibilityDrop(storage, { settleMilliseconds: 0 });

    expect(await storage.get(KEYS.workflow('wf-a'))).not.toBeNull();
  });
  it('removes the building marker and waits the settle window before sweeping rows', async () => {
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
