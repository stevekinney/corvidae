import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';

import { runWorkflowVisibilityBackfill } from '../../../scripts/lib/workflow-visibility-backfill.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { workflow } from '../types/workflow-function.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import { WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS } from './workflow-indexes.ts';
import {
  refreshWorkflowVisibilityMaintenance,
  shouldMaintainWorkflowVisibilityIndexes,
} from './workflow-visibility-maintenance.ts';

const noopWorkflow = workflow({ name: 'visibility-maintenance' }).execute(async function* (
  _ctx,
  input: string,
) {
  return input;
});

class ReadCountingStorage extends MemoryStorage {
  readonly hasCounts = new Map<string, number>();
  readonly getCounts = new Map<string, number>();

  override async has(key: string): Promise<boolean> {
    this.hasCounts.set(key, (this.hasCounts.get(key) ?? 0) + 1);
    return super.has(key);
  }

  override async get(key: string): Promise<Uint8Array | null> {
    this.getCounts.set(key, (this.getCounts.get(key) ?? 0) + 1);
    return super.get(key);
  }
}

/** Every `wf-idx-*` row the engine wrote, leaving out the `wf-idx-meta:` control keys. */
async function indexKeys(storage: MemoryStorage): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storage.keys('wf-idx-')) {
    if (!key.startsWith('wf-idx-meta:')) {
      keys.push(key);
    }
  }
  return keys;
}

async function runToCompletion(engine: Engine, id: string): Promise<void> {
  const handle = await engine.start('visibility-maintenance', id, { id });
  await handle.result();
}

/**
 * Pins `Date.now()` so the freshness window is measured from a known instant.
 * Reading the clock instead let a slow first read (host load, coverage
 * instrumentation) land after the instant the test computed its expiry from,
 * so the decision had not expired when the test advanced the clock past it.
 */
function freezeClock(): number {
  const frozenAt = Date.now();
  setSystemTime(frozenAt);
  return frozenAt;
}

afterEach(() => {
  setSystemTime();
});

describe('workflow visibility index maintenance', () => {
  it('writes no index rows while the watermark is stale and no backfill is running', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register(noopWorkflow);

    try {
      await runToCompletion(engine, 'skip-1');

      expect(await storage.has(KEYS.workflow('skip-1'))).toBe(true);
      expect(await indexKeys(storage)).toEqual([]);
      const listed = await engine.list({ status: 'completed' });
      expect(listed.items.map((summary) => summary.id)).toEqual(['skip-1']);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('leaves no index rows behind when a workflow that never had any is purged', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register(noopWorkflow);

    try {
      await runToCompletion(engine, 'purge-1');
      expect(await engine.purge({ idPrefix: 'purge-1' })).toMatchObject({ deleted: 1 });

      expect(await storage.has(KEYS.workflow('purge-1'))).toBe(false);
      expect(await indexKeys(storage)).toEqual([]);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('maintains the indexes once the backfill has made the watermark current', async () => {
    const storage = new MemoryStorage();
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    const engine = new Engine({ storage });
    engine.register(noopWorkflow);

    try {
      await runToCompletion(engine, 'current-1');

      expect(await indexKeys(storage)).toEqual(
        expect.arrayContaining([
          KEYS.workflowVisibilityManifest('current-1'),
          KEYS.workflowVisibilityStatus('completed', 'current-1'),
          KEYS.workflowVisibilityType('visibility-maintenance', 'current-1'),
        ]),
      );
      expect(await storage.has(KEYS.workflowVisibilityStatus('running', 'current-1'))).toBe(false);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('maintains the indexes while a backfill is in flight', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.workflowVisibilityMetaBuilding(), encode(Date.now()));
    const engine = new Engine({ storage });
    engine.register(noopWorkflow);

    try {
      await runToCompletion(engine, 'building-1');

      expect(await storage.has(KEYS.workflowVisibilityStatus('completed', 'building-1'))).toBe(
        true,
      );
      expect(await storage.has(KEYS.workflowVisibilityManifest('building-1'))).toBe(true);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('starts maintaining once the cached decision expires after a backfill begins', async () => {
    const storage = new MemoryStorage();
    const startedAt = freezeClock();
    const engine = new Engine({ storage });
    engine.register(noopWorkflow);

    try {
      await runToCompletion(engine, 'before-1');
      expect(await indexKeys(storage)).toEqual([]);

      await storage.put(KEYS.workflowVisibilityMetaBuilding(), encode(startedAt));
      // Still inside the freshness window: the engine keeps acting on what it last read.
      await runToCompletion(engine, 'inside-window-1');
      expect(await indexKeys(storage)).toEqual([]);

      setSystemTime(startedAt + WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS + 1);
      await runToCompletion(engine, 'after-window-1');
      expect(await storage.has(KEYS.workflowVisibilityStatus('completed', 'after-window-1'))).toBe(
        true,
      );
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('stops maintaining after the watermark and marker are removed', async () => {
    const storage = new MemoryStorage();
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    const startedAt = freezeClock();
    const engine = new Engine({ storage });
    engine.register(noopWorkflow);

    try {
      await runToCompletion(engine, 'live-1');
      expect(await storage.has(KEYS.workflowVisibilityStatus('completed', 'live-1'))).toBe(true);

      await storage.delete(KEYS.workflowVisibilityMetaVersion());
      setSystemTime(startedAt + WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS + 1);
      await runToCompletion(engine, 'dropped-1');

      expect(await storage.has(KEYS.workflowVisibilityStatus('completed', 'dropped-1'))).toBe(
        false,
      );
      expect(await storage.has(KEYS.workflow('dropped-1'))).toBe(true);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('shares one storage read between concurrent refreshes', async () => {
    const storage = new ReadCountingStorage();
    const engine = new Engine({ storage });
    const internals: EngineInternals = getInternals(engine);

    try {
      const refreshes = [
        refreshWorkflowVisibilityMaintenance(internals),
        refreshWorkflowVisibilityMaintenance(internals),
        refreshWorkflowVisibilityMaintenance(internals),
      ];
      expect(refreshes.every((refresh) => refresh !== undefined)).toBe(true);
      await Promise.all(refreshes);

      expect(storage.hasCounts.get(KEYS.workflowVisibilityMetaBuilding())).toBe(1);
      expect(storage.getCounts.get(KEYS.workflowVisibilityMetaVersion())).toBe(1);
      expect(refreshWorkflowVisibilityMaintenance(internals)).toBeUndefined();
      expect(shouldMaintainWorkflowVisibilityIndexes(internals)).toBe(false);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('maintains by default until a decision has been read', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    try {
      expect(shouldMaintainWorkflowVisibilityIndexes(getInternals(engine))).toBe(true);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('always maintains under ownership workflow-lease without reading storage', () => {
    const internals = {
      options: { ownershipMode: 'workflow-lease' },
    } as unknown as EngineInternals;

    expect(shouldMaintainWorkflowVisibilityIndexes(internals)).toBe(true);
    expect(refreshWorkflowVisibilityMaintenance(internals)).toBeUndefined();
  });
});
