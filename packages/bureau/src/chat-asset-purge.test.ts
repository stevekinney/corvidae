/**
 * COR-1934 — the purge of a deleted chat's managed assets: an asset nothing else holds is deleted
 * with its bytes, and one a second holder, a hold, or another owner keeps is left alone. The fence
 * is the asset service's own `delete(…, { unlessReferenced })`, which is decided in the delete's
 * compare-and-swap, so a claim taken between a look and the delete cannot lose its asset.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import {
  alice,
  aliceAdministrator,
  type AssetHarness,
  bob,
  createAssetHarness,
  pngBytes,
} from './testing/asset-fixtures.test-support';
import type { AssetPrincipal } from './assets/types';
import type { AssetStorage } from './index';
import { purgeChatAssets } from './chat-asset-purge';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function open(): Promise<AssetHarness & { readonly storage: AssetStorage }> {
  const fixture = createMemoryAssetStorageFixture();
  const opened = await createAssetHarness({ storage: fixture.storage });
  cleanups.push(async () => {
    await opened.harness.close();
  });
  return { ...opened, storage: fixture.storage };
}

async function admit(opened: AssetHarness, width: number, principal: AssetPrincipal = alice) {
  const admission = await opened.assets.admit(
    { source: { kind: 'inline', bytes: pngBytes(width, width) } },
    principal,
  );
  const result = await admission.work.result();
  if (result.outcome !== 'completed')
    throw new Error(`admission failed: ${JSON.stringify(result)}`);
  return admission.assetId;
}

async function stateOf(opened: AssetHarness, assetId: string, principal: AssetPrincipal = alice) {
  const descriptor = await opened.assets.inspect(assetId, principal);
  return descriptor.state;
}

const FUTURE = '2999-01-01T00:00:00.000Z';

describe('delete with unlessReferenced', () => {
  it('is refused as held while a reference exists, and deletes once it is released', async () => {
    const opened = await open();
    const assetId = await admit(opened, 2);
    await opened.assets.retain(assetId, alice, { holderId: 'other-chat', until: FUTURE });

    expect(
      await opened.assets.delete(assetId, alice, { unlessReferenced: true }).result(),
    ).toMatchObject({ outcome: 'failed', rejection: { code: 'held' } });
    expect(await stateOf(opened, assetId, alice)).toBe('available');

    await opened.assets.release(assetId, alice, 'other-chat');
    expect(
      await opened.assets.delete(assetId, alice, { unlessReferenced: true }).result(),
    ).toMatchObject({ outcome: 'completed' });
    expect(await stateOf(opened, assetId, alice)).toBe('deleted');
  });
});

describe('purgeChatAssets', () => {
  it('deletes an asset nothing holds and collects its bytes, and keeps one another holder, a hold or another owner keeps', async () => {
    const opened = await open();
    const alone = await admit(opened, 2);
    const shared = await admit(opened, 3);
    const held = await admit(opened, 4);
    const strangers = await admit(opened, 5, bob);
    await opened.assets.retain(shared, alice, { holderId: 'another-chat', until: FUTURE });
    await opened.assets.placeHold(held, aliceAdministrator, { holdId: 'legal-1', kind: 'legal' });

    await purgeChatAssets(opened.assets, [
      { assetId: alone, ownerId: 'alice' },
      { assetId: shared, ownerId: 'alice' },
      { assetId: held, ownerId: 'alice' },
      // Not alice's to delete, and one that was never stored: both are left, quietly.
      { assetId: strangers, ownerId: 'alice' },
      { assetId: 'asset-that-never-was', ownerId: 'alice' },
    ]);

    expect(await stateOf(opened, alone, alice)).toBe('deleted');
    expect(await stateOf(opened, shared, alice)).toBe('available');
    expect(await stateOf(opened, held, alice)).toBe('available');
    expect(await stateOf(opened, strangers, bob)).toBe('available');
    // The bytes of the deleted asset are gone with the collection the purge ran.
    const stored = await opened.storage.list('asset:v1:blob:');
    expect(stored).toHaveLength(3);
  });

  it('is safe to repeat, since a deleted asset deletes again as a no-op', async () => {
    const opened = await open();
    const assetId = await admit(opened, 2);
    const assets = [{ assetId, ownerId: 'alice' }];

    await purgeChatAssets(opened.assets, assets);
    await purgeChatAssets(opened.assets, assets);

    expect(await stateOf(opened, assetId, alice)).toBe('deleted');
  });

  it('does nothing for a chat that held no assets', async () => {
    const opened = await open();
    expect(await purgeChatAssets(opened.assets, [])).toBeUndefined();
  });
});
