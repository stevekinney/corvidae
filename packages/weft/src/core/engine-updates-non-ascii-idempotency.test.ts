/**
 * End-to-end regression for non-ASCII update idempotency keys on LMDB.
 *
 * An update's `idempotencyKey` is written into the `upk:` storage key without
 * encoding, and nothing validates it. Under Bun, `ordered-binary@1.6.1` threw
 * `ReferenceError: finishUtf8 is not defined` whenever an LMDB range read
 * decoded a non-ASCII key. After one such key was stored, the engine's
 * update-response sweep (`upk:` scan) failed on every maintenance cycle and the
 * owning workflow's purge (`upk:{workflow}:` key collection) failed too. These
 * tests drive both paths through a real `Engine` over a real `LMDBStorage`.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { createDiskBackedTestFixture } from '@lostgradient/storage/testing';
import { KEYS } from '../storage/keys.ts';
import { LMDBStorage } from '../storage/lmdb.ts';
import { teardown, waitForWorkflowStatus } from '../testing/storage-backends.test-support.ts';
import { decode, encode } from './codec.ts';
import { Engine } from './engine.ts';
import { CleanupWarningEvent } from './events.ts';
import { workflow, type WorkflowContext } from './types.ts';

/** Accented Latin, CJK, and an astral emoji in one idempotency key. */
const nonAsciiIdempotencyKey = 'commande-café-日本語-😀';

async function collectKeys(storage: LMDBStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storage.keys(prefix)) keys.push(key);
  return keys;
}

describe('non-ASCII update idempotency keys over LMDBStorage', () => {
  let engine: Engine | undefined;
  let storage: LMDBStorage | undefined;
  let cleanupFixture: (() => void) | undefined;

  function createEngine(): { engine: Engine; storage: LMDBStorage } {
    const fixture = createDiskBackedTestFixture({
      prefix: 'lmdb-non-ascii-idempotency-test',
      recursive: true,
    });
    cleanupFixture = fixture.cleanup;
    storage = new LMDBStorage(fixture.path);
    engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(
      workflow({ name: 'reviewer' }).execute(async function* (ctx: WorkflowContext) {
        const { payload, respond } = yield* ctx.waitForUpdate<string>('review');
        respond({ accepted: true, payload });
        return 'reviewed';
      }),
    );
    return { engine, storage };
  }

  afterEach(async () => {
    await teardown(engine, async () => {
      await storage?.close();
      cleanupFixture?.();
    });
    engine = undefined;
    storage = undefined;
    cleanupFixture = undefined;
  });

  async function submitReview(
    activeEngine: Engine,
    activeStorage: LMDBStorage,
  ): Promise<{ workflowId: string; updateId: string }> {
    const handle = await activeEngine.start('reviewer', undefined);
    await waitForWorkflowStatus(activeEngine, handle.id, 'running');

    const result = await activeEngine.submitCoordinatedUpdate(handle.id, 'review', 'looks good', {
      idempotencyKey: nonAsciiIdempotencyKey,
    });
    expect(result.result).toEqual({ accepted: true, payload: 'looks good' });
    expect(await handle.result()).toBe('reviewed');

    // The key reaches storage verbatim, which is what put the non-ASCII
    // bytes into the range the sweep and the purge later decode.
    expect(await activeStorage.has(KEYS.updateIdempotency(handle.id, nonAsciiIdempotencyKey))).toBe(
      true,
    );
    return { workflowId: handle.id, updateId: result.updateId };
  }

  it('the maintenance sweep expires the response and its non-ASCII upk: mapping', async () => {
    const { engine: activeEngine, storage: activeStorage } = createEngine();
    const warnings: CleanupWarningEvent[] = [];
    activeEngine.addEventListener(CleanupWarningEvent.type, (event) => warnings.push(event));
    const { workflowId, updateId } = await submitReview(activeEngine, activeStorage);

    // Age the stored response past the 5-minute TTL so the sweep reaches the
    // `upk:` scan, which only runs once at least one response has expired.
    const responseKey = KEYS.updateResponse(updateId);
    const stored = await activeStorage.get(responseKey);
    expect(stored).not.toBeNull();
    const response = decode(stored!) as { createdAt: number };
    await activeStorage.put(
      responseKey,
      encode({ ...response, createdAt: Date.now() - 60 * 60 * 1000 }),
    );

    await activeEngine.runMaintenance();

    expect(warnings.map((warning) => warning.error.message)).toEqual([]);
    expect(await activeStorage.get(responseKey)).toBeNull();
    expect(
      await activeStorage.has(KEYS.updateIdempotency(workflowId, nonAsciiIdempotencyKey)),
    ).toBe(false);
  });

  it('purging the workflow removes its non-ASCII upk: mapping', async () => {
    const { engine: activeEngine, storage: activeStorage } = createEngine();
    const { workflowId } = await submitReview(activeEngine, activeStorage);

    const purged = await activeEngine.purge({ idPrefix: workflowId });

    expect(purged).toMatchObject({ deleted: 1 });
    expect(await collectKeys(activeStorage, 'upk:')).toEqual([]);
  });
});
