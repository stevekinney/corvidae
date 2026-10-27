/**
 * COR-1664 — three cases that left a run's or a session's claim on a managed asset held for ever,
 * through a real Bureau. The matrix this file pins (compaction is pinned in
 * `catalog-run-asset-release.test.ts` and `asset-claim-reconciliation.test.ts`):
 *
 * | Case                                                  | Outcome                                       |
 * | ----------------------------------------------------- | --------------------------------------------- |
 * | terminal run, process died before the release         | the next boot releases it; a second is a no-op |
 * | resumable run, maintenance runs                       | every claim kept                              |
 * | session deleted while a claim for it is being taken   | no claim is left                              |
 * | session deleted by a path that releases nothing       | maintenance releases its claims               |
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  createAgentSession,
  createModelCatalog,
  SESSION_OWNER_METADATA_KEY,
  stopWhen,
  waitForCondition,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { appendMessages, createConversationHistory } from 'conversationalist';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentDefinitions } from './agent-catalog';
import { AssetReservedHolderError } from './assets/errors';
import { bureauClaim } from './assets/internal-access';
import { KEYS } from './assets/records';
import { runRowHolderId, sessionRowHolderPrefix } from './assets/row-asset-claims';
import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { alice, aliceAdministrator, pngBytes } from './testing/asset-fixtures.test-support';
import type { Bureau } from './types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  await yieldToPortableEventLoop();
});

const anthropicDescriptors = createModelCatalog().descriptors.filter(
  (descriptor) => descriptor.provider === 'anthropic',
);
const png = pngBytes(4, 3);
const UNTIL = '9999-12-31T23:59:59.999Z';

async function holdersOf(bureau: Bureau, assetId: string): Promise<string[]> {
  const descriptor = await bureau.assets!.inspect(assetId, aliceAdministrator, {
    projection: 'privileged',
  });
  if (descriptor.projection !== 'privileged') throw new Error('expected the privileged projection');
  return descriptor.retention.references.map((reference) => reference.holderId);
}

async function admitImage(bureau: Bureau) {
  const admission = await bureau.assets!.admit(
    { source: { kind: 'inline', bytes: png }, declaredMediaType: 'image/png' },
    alice,
  );
  await admission.work.result();
  return { assetId: admission.assetId, source: admission.source };
}

describe('a run that ended in a process that died before it released', () => {
  async function createStore() {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-claim-reconciliation-'));
    cleanups.push(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    return {
      storage: { type: 'sqlite' as const, path: join(directory, 'bureau') },
      fixture,
      runtime: createManualRuntimeServices({ origin: '2026-10-23T00:00:00.000Z' }),
    };
  }
  type Store = Awaited<ReturnType<typeof createStore>>;

  const finishing = createAgent({
    generate: withBackendDescriptors(
      async () => ({ content: 'done', toolCalls: [] }),
      anthropicDescriptors,
    ),
    stopWhen: stopWhen.noToolCalls(),
  });

  async function openBureau(
    store: Store,
    agent = finishing,
    assetStorage = store.fixture.storage,
  ): Promise<Bureau> {
    const bureau = await createBureau<AgentDefinitions>({
      agents: { viewer: agent },
      runtime: store.runtime,
      assets: { storage: assetStorage, policy: { defaultRetentionMilliseconds: 1_000 } },
      storage: store.storage,
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    let disposed = false;
    cleanups.push(async () => {
      if (!disposed) await bureau.dispose();
    });
    const dispose = bureau.dispose.bind(bureau);
    bureau.dispose = async () => {
      disposed = true;
      await dispose();
    };
    return bureau;
  }

  it('is released by the next boot, and the boot after that releases nothing', async () => {
    const store = await createStore();
    const first = await openBureau(store);
    const { assetId, source } = await admitImage(first);
    const run = first.run('viewer', [{ type: 'image', source }], { principal: alice.id });
    await run.result();
    await waitForCondition(async () => {
      const holders = await holdersOf(first, assetId);
      return holders.length === 0;
    }, 'the dispatcher never released the run’s claim');
    // The process dies after the terminal commit and before the release: the claim is still there.
    const lost = runRowHolderId(run.id, 'row-lost');
    await first.assets!.retain(assetId, alice, {
      holderId: lost,
      until: UNTIL,
      [bureauClaim]: true,
    });
    expect(await holdersOf(first, assetId)).toEqual([lost]);
    await first.dispose();

    // The boot's reconciliation runs beside the caller, after recovery, so it is waited for.
    const second = await openBureau(store);
    await waitForCondition(async () => {
      const holders = await holdersOf(second, assetId);
      return holders.length === 0;
    }, 'the boot never released the lost claim');
    await second.dispose();

    // The third boot's reconciliation is observed from the asset store: each pass lists every
    // asset record once, and the subscription (made before any release could land, since the
    // listing is asynchronous) sees every release it makes.
    let recordListings = 0;
    const observed = {
      ...store.fixture.storage,
      list: async (prefix: string) => {
        if (prefix === KEYS.recordPrefix) recordListings += 1;
        return store.fixture.storage.list(prefix);
      },
    };
    const third = await openBureau(store, finishing, observed);
    const releases: string[] = [];
    third.assets!.subscribe((event) => {
      if (event.type === 'asset.released') releases.push(event.assetId ?? '');
    });
    await waitForCondition(
      () => recordListings >= 2,
      'the third boot never reconciled its run and session claims',
    );
    // Disposing waits for the tracked reconciliation, so it has finished when this returns.
    expect(await holdersOf(third, assetId)).toEqual([]);
    await third.dispose();
    expect(releases).toEqual([]);
  });

  it('keeps every claim of a run that is still going, through maintenance', async () => {
    const store = await createStore();
    const parked = createAgent({
      generate: withBackendDescriptors(() => new Promise<never>(() => {}), anthropicDescriptors),
      stopWhen: stopWhen.noToolCalls(),
    });
    const bureau = await openBureau(store, parked);
    const { assetId, source } = await admitImage(bureau);
    const run = bureau.run('viewer', [{ type: 'image', source }], { principal: alice.id });
    const holders = async () => holdersOf(bureau, assetId);
    await waitForCondition(async () => {
      const held = await holders();
      return held.length > 0;
    }, 'the run never claimed its input');
    const before = await holders();

    await bureau.runDurableMaintenance();

    expect(before).toEqual([runRowHolderId(run.id, `${run.id}:input`)]);
    expect(await holders()).toEqual(before);
  });
});

describe('a session deleted while its claims are being taken', () => {
  async function open(
    extra: { maintenance?: 'manual' } = {},
  ): Promise<{ bureau: Bureau; runtime: ManualRuntimeServices }> {
    const fixture = createMemoryAssetStorageFixture({});
    cleanups.push(() => fixture.dispose());
    const runtime = createManualRuntimeServices({ origin: '2026-10-23T00:00:00.000Z' });
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        echo: createAgent({
          generate: withBackendDescriptors(
            async () => ({ content: 'ok', toolCalls: [] }),
            anthropicDescriptors,
          ),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'memory' },
      durable: false,
      runtime,
      assets: { storage: fixture.storage, policy: { defaultRetentionMilliseconds: 1_000 } },
      ...extra,
    });
    cleanups.push(async () => {
      await bureau.dispose();
    });
    return { bureau, runtime };
  }

  async function saveSession(bureau: Bureau, sessionId: string, ...assetIds: string[]) {
    const history = appendMessages(createConversationHistory({ id: sessionId }), {
      id: 'row-1',
      role: 'user',
      content: assetIds.map((assetId) => ({
        type: 'image' as const,
        mimeType: 'image/png',
        source: { kind: 'managed-asset' as const, assetId },
      })),
    });
    await bureau.internals.sessionStore!.save(
      createAgentSession({
        id: sessionId,
        agentName: 'echo',
        conversationHistory: history,
        metadata: { [SESSION_OWNER_METADATA_KEY]: alice.id },
        runs: [],
      }),
    );
    for (let turn = 0; turn < 20; turn += 1) await yieldToPortableEventLoop();
  }

  it('leaves no claim when the delete lands between the load and the claim', async () => {
    const { bureau } = await open();
    const { assetId } = await admitImage(bureau);
    const retain = bureau.assets!.retain.bind(bureau.assets!);
    let deleted = false;
    spyOn(bureau.assets!, 'retain').mockImplementation(async (...args) => {
      if (!deleted && args[2].holderId.startsWith('session-row:')) {
        deleted = true;
        await bureau.internals.sessionStore!.delete('session-1');
      }
      return retain(...args);
    });

    await saveSession(bureau, 'session-1', assetId);

    expect(deleted).toBe(true);
    expect(await bureau.internals.sessionStore!.load('session-1')).toBeUndefined();
    expect(await holdersOf(bureau, assetId)).toEqual([]);
  });

  it('leaves no claim on the asset it did claim when a later claim in the same pass fails', async () => {
    const { bureau } = await open();
    const { assetId: first } = await admitImage(bureau);
    const { assetId: second } = await admitImage(bureau);
    const retain = bureau.assets!.retain.bind(bureau.assets!);
    let deleted = false;
    spyOn(bureau.assets!, 'retain').mockImplementation(async (...args) => {
      if (args[0] === second) throw new Error('retention unavailable');
      if (!deleted && args[2].holderId.startsWith('session-row:')) {
        deleted = true;
        await bureau.internals.sessionStore!.delete('session-1');
      }
      return retain(...args);
    });

    await saveSession(bureau, 'session-1', first, second);

    expect(deleted).toBe(true);
    expect(await holdersOf(bureau, first)).toEqual([]);
  });

  it('refuses a public retain under a Bureau holder id on bureau.assets', async () => {
    const { bureau } = await open();
    const { assetId } = await admitImage(bureau);

    const refusal = await bureau
      .assets!.retain(assetId, alice, { holderId: 'session-row:s:i:row', until: UNTIL })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(AssetReservedHolderError);
  });

  it('releases the claim of a row the session no longer holds when the session is deleted, with manual background tasks', async () => {
    const { bureau } = await open({ maintenance: 'manual' });
    const { assetId: compactedOut } = await admitImage(bureau);
    const { assetId: kept } = await admitImage(bureau);
    await saveSession(bureau, 'session-1', kept);
    const session = await bureau.internals.sessionStore!.load('session-1');
    // Compaction removed a row the session once held; its claim outlived the row, so no walk of the
    // session's current rows reaches it.
    const gone = `${sessionRowHolderPrefix('session-1', session!.incarnation)}row-gone`;
    await bureau.assets!.retain(compactedOut, alice, {
      holderId: gone,
      until: UNTIL,
      [bureauClaim]: true,
    });
    expect(await holdersOf(bureau, compactedOut)).toEqual([gone]);

    await bureau.contexts.delete('session-1');

    expect(await holdersOf(bureau, compactedOut)).toEqual([]);
    expect(await holdersOf(bureau, kept)).toEqual([]);
  });

  it('keeps the claims of a session that is not deleted', async () => {
    const { bureau } = await open();
    const { assetId } = await admitImage(bureau);

    await saveSession(bureau, 'session-1', assetId);

    const session = await bureau.internals.sessionStore!.load('session-1');
    expect(await holdersOf(bureau, assetId)).toEqual([
      expect.stringContaining(sessionRowHolderPrefix('session-1', session!.incarnation)),
    ]);
  });

  it('has its claims released by maintenance when the delete path released nothing', async () => {
    const { bureau } = await open();
    const { assetId } = await admitImage(bureau);
    await saveSession(bureau, 'session-1', assetId);
    expect(await holdersOf(bureau, assetId)).toHaveLength(1);

    // A store-level delete releases nothing, as a deletion by another process does not.
    await bureau.internals.sessionStore!.delete('session-1');
    expect(await holdersOf(bureau, assetId)).toHaveLength(1);

    await bureau.runDurableMaintenance();

    expect(await holdersOf(bureau, assetId)).toEqual([]);
  });
});
