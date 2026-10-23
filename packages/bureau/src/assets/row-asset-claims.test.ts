import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { AssetAccessDeniedError, AssetNotFoundError, AssetUnavailableError } from './errors';
import {
  claimRowAssets,
  hasCompactedRows,
  managedAssetIdsOf,
  releaseHeldRowAssetClaims,
  releaseRowAssetClaims,
  runRowHolderId,
} from './row-asset-claims';
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

/**
 * COR-1630 — a run releases only the claims it actually holds. The asset service's `release` emits
 * `asset.released` even when the holder held nothing, so the walker reads each candidate's
 * privileged references first and releases only where the run's row holder is among them.
 */
describe('releasing only the claims a run holds (COR-1630)', () => {
  const holderOf = (rowId: string) => runRowHolderId('run-1', rowId);

  /** An asset service whose records are `references` by asset id; every call is recorded. */
  function referencingAssets(
    references: Record<string, string[]>,
    failures: { inspect?: Record<string, unknown>; release?: Record<string, unknown> } = {},
  ) {
    const inspected: Array<{ assetId: string; principal: unknown; options: unknown }> = [];
    const released: Array<{ assetId: string; principal: unknown; holderId: string }> = [];
    const assets = {
      async inspect(assetId: string, principal: unknown, options: unknown) {
        inspected.push({ assetId, principal, options });
        const failure = failures.inspect?.[assetId];
        if (failure !== undefined) throw failure;
        return {
          projection: 'privileged',
          retention: {
            references: (references[assetId] ?? []).map((holderId) => ({
              holderId,
              until: '9999-12-31T23:59:59.999Z',
            })),
          },
        };
      },
      async release(assetId: string, principal: unknown, holderId: string) {
        released.push({ assetId, principal, holderId });
        const failure = failures.release?.[assetId];
        if (failure !== undefined) throw failure;
        references[assetId] = (references[assetId] ?? []).filter((held) => held !== holderId);
      },
    } as unknown as AssetService;
    return { assets, inspected, released, references };
  }

  const imageRow = (id: string, assetId: string) => ({
    id,
    content: [{ type: 'image', source: { kind: 'managed-asset', assetId } }],
  });

  it('inspects privileged as the principal and releases as the plain principal, only where the run holds a claim', async () => {
    const { assets, inspected, released } = referencingAssets({
      claimed: [holderOf('row-b')],
      earlier: [],
      shared: [holderOf('row-b'), 'session-row:s:i:row-b'],
    });
    const rows = [
      imageRow('row-a', 'earlier'),
      imageRow('row-b', 'claimed'),
      imageRow('row-b', 'shared'),
    ];
    // The same asset in two rows is two candidate pairs.
    rows.push(imageRow('row-c', 'claimed'));

    await releaseHeldRowAssetClaims(assets, 'alice', holderOf, rows, () => {
      throw new Error('unexpected failure');
    });

    expect(inspected.map((call) => call.assetId)).toEqual([
      'earlier',
      'claimed',
      'shared',
      'claimed',
    ]);
    for (const call of inspected) {
      expect(call.principal).toEqual({ id: 'alice', privileged: true });
      expect(call.options).toEqual({ projection: 'privileged' });
    }
    expect(released).toEqual([
      { assetId: 'claimed', principal: { id: 'alice' }, holderId: holderOf('row-b') },
      { assetId: 'shared', principal: { id: 'alice' }, holderId: holderOf('row-b') },
    ]);
  });

  it('leaves another holder’s claim on a shared asset in place', async () => {
    const { assets, references } = referencingAssets({
      shared: [holderOf('row-1'), 'session-row:s:i:row-1'],
    });

    await releaseHeldRowAssetClaims(
      assets,
      'alice',
      holderOf,
      [imageRow('row-1', 'shared')],
      () => {
        throw new Error('unexpected failure');
      },
    );

    expect(references['shared']).toEqual(['session-row:s:i:row-1']);
  });

  it('is idempotent: a second pass finds nothing held and releases nothing', async () => {
    const { assets, released } = referencingAssets({ photo: [holderOf('row-1')] });
    const rows = [imageRow('row-1', 'photo')];
    const failures: unknown[] = [];

    await releaseHeldRowAssetClaims(assets, 'alice', holderOf, rows, (_a, error) =>
      failures.push(error),
    );
    await releaseHeldRowAssetClaims(assets, 'alice', holderOf, rows, (_a, error) =>
      failures.push(error),
    );

    expect(released).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it.each([
    ['not found', new AssetNotFoundError('bad')],
    ['access denied', new AssetAccessDeniedError('bad', 'inspect')],
    ['unavailable', new AssetUnavailableError('bad', 'expired')],
  ])(
    'skips a candidate whose inspect fails as %s, quietly, and still releases the others',
    async (_name, error) => {
      const { assets, released } = referencingAssets(
        { bad: [holderOf('row-1')], good: [holderOf('row-2')] },
        { inspect: { bad: error } },
      );
      const reported: unknown[] = [];

      await releaseHeldRowAssetClaims(
        assets,
        'alice',
        holderOf,
        [imageRow('row-1', 'bad'), imageRow('row-2', 'good')],
        (assetId, failure) => reported.push([assetId, failure]),
      );

      expect(released.map((call) => call.assetId)).toEqual(['good']);
      expect(reported).toEqual([]);
    },
  );

  it('reports an inspect or release that fails any other way, with the asset and the row, and carries on', async () => {
    const broken = new Error('the store is down');
    const { assets, released } = referencingAssets(
      { first: [holderOf('row-1')], second: [holderOf('row-2')], third: [holderOf('row-3')] },
      { inspect: { first: broken }, release: { second: broken } },
    );
    const reported: Array<[string, string]> = [];

    await releaseHeldRowAssetClaims(
      assets,
      'alice',
      holderOf,
      [imageRow('row-1', 'first'), imageRow('row-2', 'second'), imageRow('row-3', 'third')],
      (assetId, _error, rowId) => reported.push([assetId, rowId]),
    );

    expect(reported).toEqual([
      ['first', 'row-1'],
      ['second', 'row-2'],
    ]);
    expect(released.map((call) => call.assetId)).toEqual(['second', 'third']);
  });

  it('reads tool-result parts as well as content, as claiming does', async () => {
    const { assets, released } = referencingAssets({ 'tool-asset': [holderOf('row-1')] });

    await releaseHeldRowAssetClaims(
      assets,
      'alice',
      holderOf,
      [
        {
          id: 'row-1',
          content: '',
          toolResult: {
            parts: [{ type: 'image', source: { kind: 'managed-asset', assetId: 'tool-asset' } }],
          },
        },
      ],
      () => {
        throw new Error('unexpected failure');
      },
    );

    expect(released.map((call) => call.assetId)).toEqual(['tool-asset']);
  });
});

describe('rows that history compaction replaced (COR-1664)', () => {
  async function compacted(): Promise<Conversation> {
    const conversation = new Conversation(createConversationHistory({ id: 'conversation-1' }));
    for (let turn = 0; turn < 6; turn += 1) {
      conversation.appendUserMessage(`question ${turn}`);
      conversation.appendAssistantMessage(`answer ${turn}`);
    }
    await conversation.compact(async () => 'a summary', { preserveRecentCount: 2 });
    return conversation;
  }

  it('is recognized in the conversation a checkpoint restores, hidden rows included', async () => {
    const conversation = await compacted();
    // The checkpoint stores a snapshot and a run reads it back with `Conversation.from`.
    const restored = Conversation.from(conversation.snapshot());

    expect(hasCompactedRows(restored.getMessages({ includeHidden: true }))).toBe(true);
  });

  it('is not claimed of a conversation compaction has not touched', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'conversation-2' }));
    conversation.appendUserMessage('hello');

    expect(hasCompactedRows(conversation.getMessages({ includeHidden: true }))).toBe(false);
  });
});
