/**
 * COR-716 — the resolver Bureau hands a run so a `managed-asset` part reaches a
 * provider as bytes or a provider-fetched URL, with the asset's safety verdict
 * carried for the input guardrail.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';

import {
  alice,
  base64Of,
  bob,
  createAssetHarness,
  pngBytes,
} from '../testing/asset-fixtures.test-support';
import type { BureauAssetOptions } from './asset-service';
import {
  createAssetContentSourceResolver,
  createMcpResourceContentSourceResolver,
  type McpResourceReader,
} from './content-source-resolver';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function open(options: Partial<BureauAssetOptions> = {}) {
  const { createMemoryAssetStorageFixture } = await import('../test/asset-storage-fixtures');
  const fixture = createMemoryAssetStorageFixture({});
  closers.push(() => fixture.dispose());
  const opened = await createAssetHarness({ storage: fixture.storage, ...options });
  closers.push(async () => {
    await opened.harness.close();
  });
  return opened;
}

async function admitPng(assets: Awaited<ReturnType<typeof open>>['assets'], owner = alice) {
  const bytes = pngBytes(4, 3);
  const admission = await assets.admit(
    { source: { kind: 'inline', bytes }, declaredMediaType: 'image/png' },
    owner,
  );
  await admission.work.result();
  return { admission, bytes };
}

const position = { messageId: 'm-1', partIndex: 0 };

describe('createAssetContentSourceResolver', () => {
  it('resolves a managed asset to inline base64 with its media type, size, and an unknown safety state when no gate ran', async () => {
    const { assets } = await open();
    const { admission, bytes } = await admitPng(assets);
    const resolve = createAssetContentSourceResolver(assets, 'alice');
    const part: MediaContent = { type: 'image', source: admission.source };

    expect(await resolve(part, position)).toEqual({
      outcome: 'resolved',
      source: { kind: 'inline', data: base64Of(bytes), encoding: 'base64' },
      mimeType: 'image/png',
      byteLength: bytes.byteLength,
      safety: 'unknown',
    });
  });

  it('reports clean when every safety gate cleared the asset', async () => {
    const clean = await open({
      ports: { safetyGates: [{ name: 'scanner', inspect: async () => ({ verdict: 'clean' }) }] },
    });
    const cleanAsset = await admitPng(clean.assets);
    const cleanResult = await createAssetContentSourceResolver(clean.assets, 'alice')(
      { type: 'image', source: cleanAsset.admission.source },
      position,
    );
    expect(cleanResult).toMatchObject({ outcome: 'resolved', safety: 'clean' });
  });

  it('answers unavailable for an asset a safety gate flagged, which Bureau quarantines', async () => {
    const flagged = await open({
      ports: {
        safetyGates: [
          { name: 'scanner', inspect: async () => ({ verdict: 'flagged', category: 'malware' }) },
        ],
      },
    });
    const bytes = pngBytes(2, 2);
    const admission = await flagged.assets.admit(
      { source: { kind: 'inline', bytes }, declaredMediaType: 'image/png' },
      alice,
    );
    await admission.work.result();
    const result = await createAssetContentSourceResolver(flagged.assets, 'alice')(
      { type: 'image', source: admission.source },
      position,
    );
    // A flagged asset is quarantined, so it is unavailable rather than resolved.
    expect(result).toEqual({ outcome: 'unavailable', reason: 'asset-unavailable' });
  });

  it('answers unavailable, not a throw, for an asset the run principal may not read', async () => {
    const { assets } = await open();
    const { admission } = await admitPng(assets);
    const result = await createAssetContentSourceResolver(assets, bob.id)(
      { type: 'image', source: admission.source },
      position,
    );
    expect(result).toEqual({ outcome: 'unavailable', reason: 'asset-not-found' });
  });

  it('answers unavailable for an asset that does not exist', async () => {
    const { assets } = await open();
    const result = await createAssetContentSourceResolver(assets, 'alice')(
      { type: 'image', source: { kind: 'managed-asset', assetId: 'missing' } },
      position,
    );
    expect(result).toEqual({ outcome: 'unavailable', reason: 'asset-not-found' });
  });

  it('answers unavailable for a revision the asset has not reached', async () => {
    const { assets } = await open();
    const { admission } = await admitPng(assets);
    const result = await createAssetContentSourceResolver(assets, 'alice')(
      {
        type: 'image',
        source: { kind: 'managed-asset', assetId: admission.assetId, revision: 99 },
      },
      position,
    );
    expect(result).toEqual({ outcome: 'unavailable', reason: 'asset-unavailable' });
  });

  it('answers unavailable for a source kind Bureau holds no bytes for', async () => {
    const { assets } = await open();
    const resolve = createAssetContentSourceResolver(assets, 'alice');
    for (const source of [
      { kind: 'upload', uploadId: 'u-1' },
      { kind: 'local-file', path: '/tmp/a.png' },
      { kind: 'mcp-resource', serverId: 's', uri: 'resource://a' },
    ] as const) {
      expect(await resolve({ type: 'image', source }, position)).toEqual({
        outcome: 'unavailable',
        reason: 'source-kind-not-supported',
      });
    }
  });

  it('hands a provider-fetch asset to the provider as its URL', async () => {
    const { assets } = await open({
      policy: { url: { allowProviderFetch: true } },
    });
    const admission = await assets.admit(
      {
        source: { kind: 'url', url: 'https://cdn.example.com/a.png', fetchedBy: 'provider' },
        declaredMediaType: 'image/png',
      },
      alice,
    );
    await admission.work.result();
    const result = await createAssetContentSourceResolver(assets, 'alice')(
      { type: 'image', source: admission.source },
      position,
    );
    expect(result).toMatchObject({
      outcome: 'resolved',
      source: { kind: 'remote-url', url: 'https://cdn.example.com/a.png' },
    });
  });

  describe('cancellation', () => {
    /** An asset service whose reads never settle on their own. */
    function stalledService() {
      let resolveCalls = 0;
      let inspectCalls = 0;
      const never = () => new Promise<never>(() => {});
      const service = {
        resolve: () => {
          resolveCalls += 1;
          return never();
        },
        inspect: () => {
          inspectCalls += 1;
          return never();
        },
      } as unknown as Parameters<typeof createAssetContentSourceResolver>[0];
      return { service, calls: () => ({ resolveCalls, inspectCalls }) };
    }

    const part: MediaContent = {
      type: 'image',
      source: { kind: 'managed-asset', assetId: 'asset-1' },
    };

    it('releases a stalled read the moment the run’s signal aborts', async () => {
      const { service } = stalledService();
      const controller = new AbortController();
      const pending = createAssetContentSourceResolver(service, 'alice')(part, {
        ...position,
        signal: controller.signal,
      });
      const outcome = pending.then(
        () => 'settled',
        (error: unknown) => error,
      );

      controller.abort(new Error('cancelled'));

      expect(await outcome).toMatchObject({ message: 'cancelled' });
    });

    it('reads nothing when the signal was already aborted', async () => {
      const { service, calls } = stalledService();
      const controller = new AbortController();
      controller.abort(new Error('cancelled'));

      const outcome = await createAssetContentSourceResolver(service, 'alice')(part, {
        ...position,
        signal: controller.signal,
      }).then(
        () => 'settled',
        (error: unknown) => error,
      );

      expect(outcome).toMatchObject({ message: 'cancelled' });
      expect(calls()).toEqual({ resolveCalls: 0, inspectCalls: 0 });
    });
  });
});

describe('an mcp-resource part (COR-1634)', () => {
  const link: MediaContent = {
    type: 'image',
    mimeType: 'image/png',
    source: { kind: 'mcp-resource', serverId: 'files', uri: 'file:///chart.png' },
  };

  it('is read through the host reader as the run principal and projected to inline bytes', async () => {
    const { assets } = await open();
    const bytes = pngBytes(3, 3);
    const calls: Array<{ serverId: string; uri: string; principalId: string }> = [];
    const mcpResources: McpResourceReader = async (resource, context) => {
      calls.push({ ...resource, principalId: context.principalId });
      return { data: base64Of(bytes), encoding: 'base64', mimeType: 'image/png' };
    };
    const result = await createAssetContentSourceResolver(assets, 'alice', { mcpResources })(
      link,
      position,
    );
    expect(result).toEqual({
      outcome: 'resolved',
      source: { kind: 'inline', data: base64Of(bytes), encoding: 'base64' },
      mimeType: 'image/png',
      byteLength: bytes.byteLength,
      safety: 'unknown',
    });
    expect(calls).toEqual([{ serverId: 'files', uri: 'file:///chart.png', principalId: 'alice' }]);
  });

  it('projects text contents as inline UTF-8 with its byte length', async () => {
    const { assets } = await open();
    const result = await createAssetContentSourceResolver(assets, 'alice', {
      mcpResources: async () => ({ data: 'héllo', encoding: 'utf8', mimeType: 'text/plain' }),
    })({ type: 'document', source: link.source }, position);
    expect(result).toMatchObject({
      outcome: 'resolved',
      source: { kind: 'inline', data: 'héllo', encoding: 'utf8' },
      byteLength: 6,
    });
  });

  it('answers unavailable when the server no longer has the resource', async () => {
    const { assets } = await open();
    const result = await createAssetContentSourceResolver(assets, 'alice', {
      mcpResources: async () => undefined,
    })(link, position);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'mcp-resource-not-found' });
  });

  it('answers unavailable for contents that are not valid base64, rather than costing them', async () => {
    const { assets } = await open();
    for (const data of ['not base64!', 'abc', 'QUJD=']) {
      const result = await createAssetContentSourceResolver(assets, 'alice', {
        mcpResources: async () => ({ data, encoding: 'base64' }),
      })(link, position);
      expect(result).toEqual({ outcome: 'unavailable', reason: 'mcp-resource-invalid-contents' });
    }
  });

  it('answers unavailable, as before, when no reader is configured', async () => {
    const { assets } = await open();
    expect(await createAssetContentSourceResolver(assets, 'alice')(link, position)).toEqual({
      outcome: 'unavailable',
      reason: 'source-kind-not-supported',
    });
  });

  it('reads nothing for a run that already ended, and stops waiting when it ends', async () => {
    const { assets } = await open();
    let reads = 0;
    const mcpResources: McpResourceReader = () => {
      reads += 1;
      return new Promise(() => {});
    };
    const resolve = createAssetContentSourceResolver(assets, 'alice', { mcpResources });
    const ended = new AbortController();
    ended.abort(new Error('ended'));
    const early = await resolve(link, { ...position, signal: ended.signal }).then(
      () => 'settled',
      (error: unknown) => error,
    );
    expect(early).toMatchObject({ message: 'ended' });
    expect(reads).toBe(0);

    const running = new AbortController();
    const pending = resolve(link, { ...position, signal: running.signal }).then(
      () => 'settled',
      (error: unknown) => error,
    );
    running.abort(new Error('cancelled'));
    expect(await pending).toMatchObject({ message: 'cancelled' });
  });

  it('serves a Bureau that has a reader but no asset service, and refuses other kinds', async () => {
    const resolve = createMcpResourceContentSourceResolver(
      async () => ({ data: 'x', encoding: 'utf8' }),
      'alice',
    );
    expect(await resolve(link, position)).toMatchObject({ outcome: 'resolved' });
    expect(
      await resolve({ type: 'image', source: { kind: 'managed-asset', assetId: 'a' } }, position),
    ).toEqual({ outcome: 'unavailable', reason: 'source-kind-not-supported' });
  });
});
