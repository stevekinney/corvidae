import { describe, expect, it } from 'bun:test';

import { decode, encode } from '../../src/core/codec.ts';
import {
  WORKFLOW_VISIBILITY_INDEX_VERSION,
  decodeWorkflowVisibilityManifest,
  getWorkflowVisibilityWatermark,
} from '../../src/core/engine/workflow-indexes.ts';
import { KEYS } from '../../src/storage/interface.ts';
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

describe('runWorkflowVisibilityBackfill', () => {
  it('writes the manifest, index rows, and watermark for a fresh database', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-b', type: 'payment' }));

    const report = await runWorkflowVisibilityBackfill(storage);

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

    await runWorkflowVisibilityBackfill(storage);
    const firstRows = await collectKeys(storage, 'wf-idx-status:');
    const firstStatusRows = firstRows.toSorted();

    const second = await runWorkflowVisibilityBackfill(storage);
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
    const report = await runWorkflowVisibilityBackfill(racingStorage);

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

    const report = await runWorkflowVisibilityBackfill(storage);
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
      const first = await runWorkflowVisibilityBackfill(racingStorage);
      expect(first).toEqual({ processed, conflicts: targets.length, watermarkWritten: false });
      expect(watermarkChecks).toBe(0);
      const savedCursor = await storage.get(KEYS.workflowVisibilityMetaCursor());
      expect(savedCursor === null ? null : decode(savedCursor)).toBe(
        resume === undefined ? null : KEYS.workflow(resume),
      );

      const second = await runWorkflowVisibilityBackfill(racingStorage);
      expect(second).toEqual({ processed: retryCount, conflicts: 0, watermarkWritten: true });
      expect(watermarkChecks).toBe(1);
      expect(await storage.get(KEYS.workflowVisibilityMetaBuiltAt())).not.toBeNull();
      expect(await storage.get(KEYS.workflowVisibilityMetaCursor())).toBeNull();
      expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
    },
  );

  it('refuses to run when the storage backend has no conditionalBatch', async () => {
    const storage = new NoConditionalBatchStorage();
    expect(await throwingRejectionOf(runWorkflowVisibilityBackfill(storage))).toThrow(
      /does not expose conditionalBatch/,
    );
  });
});

describe('runWorkflowVisibilityDrop', () => {
  it('removes the watermark before sweeping rows and clears the cursor last', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await runWorkflowVisibilityBackfill(storage);
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');

    await runWorkflowVisibilityDrop(storage);

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
    await runWorkflowVisibilityBackfill(storage);

    await runWorkflowVisibilityDrop(storage);

    expect(await storage.get(KEYS.workflow('wf-a'))).not.toBeNull();
  });
});
