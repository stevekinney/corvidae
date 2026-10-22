import { describe, expect, it } from 'bun:test';

import { claimRowAssets, managedAssetIdsOf, releaseRowAssetClaims } from './row-asset-claims';
import type { AssetService } from './types';

/** The two calls the walker makes, recorded. */
function recordingAssets() {
  const retained: Array<[string, string]> = [];
  const released: Array<[string, string]> = [];
  const assets = {
    async retain(assetId: string, _principal: unknown, claim: { holderId: string }) {
      retained.push([assetId, claim.holderId]);
    },
    async release(assetId: string, _principal: unknown, holderId: string) {
      released.push([assetId, holderId]);
    },
  } as unknown as AssetService;
  return { assets, retained, released };
}

const toolResultRow = {
  id: 'row-1',
  content: '',
  toolResult: {
    parts: [
      { type: 'text', text: 'snapshot' },
      { type: 'image', source: { kind: 'managed-asset', assetId: 'asset-tool', revision: 1 } },
    ],
  },
};
const assistantRow = {
  id: 'row-2',
  content: [{ type: 'image', source: { kind: 'managed-asset', assetId: 'asset-model' } }],
};

describe('row asset claims (COR-792)', () => {
  it('reads managed assets from a tool result’s parts as well as content', () => {
    expect(managedAssetIdsOf(toolResultRow)).toEqual(['asset-tool']);
    expect(managedAssetIdsOf(assistantRow)).toEqual(['asset-model']);
  });

  it('claims and releases the same tool-result assets, so a session’s claims never leak', async () => {
    const { assets, retained, released } = recordingAssets();
    const holderOf = (rowId: string) => `holder:${rowId}`;
    await claimRowAssets(assets, 'alice', holderOf, [toolResultRow, assistantRow], {
      onFailure: () => {
        throw new Error('unexpected failure');
      },
    });
    await releaseRowAssetClaims(assets, 'alice', holderOf, [toolResultRow, assistantRow], () => {
      throw new Error('unexpected failure');
    });
    expect(retained).toEqual([
      ['asset-tool', 'holder:row-1'],
      ['asset-model', 'holder:row-2'],
    ]);
    expect(released).toEqual(retained);
  });
});
