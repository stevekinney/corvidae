/**
 * COR-794 — hostile inputs to managed-asset admission: SSRF through literal
 * and resolved private addresses, DNS rebinding between validation and
 * connection, redirect chains, expired signed URLs, credential-bearing URLs,
 * a provider-fetch declaration kept distinct from host fetch, the
 * malware/content-safety gate, content digests, and the duplicate policy —
 * plus the guarantee that no event or audit record carries bytes, secrets,
 * reusable signed URLs, or extracted content.
 *
 * Every Bureau here is closed through `harness.close()`, which runs
 * `assertBureauQuiescent` and rejects with `BureauQuiescenceError` on a leak.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { afterEach, describe, expect, it } from 'bun:test';

import { createMemoryAssetStorageFixture } from '../test/asset-storage-fixtures';
import {
  alice,
  type AssetHarness,
  base64Of,
  createAssetHarness,
  pngBytes,
  scriptedFetcher,
  scriptedResolver,
  textBytes,
} from '../testing/asset-fixtures.test-support';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  AssetIntegrityError,
  AssetUnavailableError,
  type AssetEvent,
  type AssetFetchResponse,
  type BureauAssetOptions,
} from '../index';
import { isPrivateAddress } from './url-policy';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface Opened extends AssetHarness {
  readonly events: AssetEvent[];
  close(): Promise<void>;
}

async function open(
  options: Omit<BureauAssetOptions, 'storage'> & { storage?: BureauAssetOptions['storage'] },
): Promise<Opened> {
  const fixture = createMemoryAssetStorageFixture();
  const opened = await createAssetHarness(
    { storage: fixture.storage, ...options },
    createManualRuntimeServices(),
  );
  const events: AssetEvent[] = [];
  const unsubscribe = opened.assets.subscribe((event) => events.push(event));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    await opened.harness.close();
  };
  cleanups.push(close);
  return { ...opened, events, close };
}

const PNG = pngBytes(2, 2);
const ok = (body: Uint8Array = PNG): AssetFetchResponse => ({
  status: 200,
  contentType: 'image/png',
  body,
});

async function admitUrl(opened: Opened, url: string, fetchedBy: 'host' | 'provider' = 'host') {
  const admission = await opened.assets.admit({ source: { kind: 'url', url, fetchedBy } }, alice);
  return { admission, result: await admission.work.result() };
}

describe('URL admission', () => {
  const literalPrivateTargets = [
    'https://127.0.0.1/a.png',
    'https://10.1.2.3/a.png',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.0.10/a.png',
    'https://172.20.0.1/a.png',
    'https://100.64.0.1/a.png',
    'https://[::1]/a.png',
    'https://[fd00::1]/a.png',
    'https://[fe80::1]/a.png',
    'https://[::ffff:127.0.0.1]/a.png',
    'https://[::ffff:0:7f00:1]/a.png',
    'https://[2002:7f00:1::]/a.png',
    'https://[2002:a9fe:a9fe::]/a.png',
    'https://[64:ff9b:1::a9fe:a9fe]/a.png',
    'https://2130706433/a.png',
    'https://0x7f000001/a.png',
    'https://localhost/a.png',
    'https://metadata.localhost/a.png',
  ];

  for (const url of literalPrivateTargets) {
    it(`refuses SSRF to ${url} without resolving or fetching`, async () => {
      const resolver = scriptedResolver({});
      const fetcher = scriptedFetcher({});
      const opened = await open({
        ports: { resolveHost: resolver.resolveHost, fetch: fetcher.fetch },
      });
      const { result } = await admitUrl(opened, url);
      expect(result).toMatchObject({ outcome: 'failed', rejection: { code: 'private-address' } });
      expect(fetcher.requests).toEqual([]);
      await opened.close();
    });
  }

  it('classifies IPv6 transition addresses by the IPv4 address they carry', () => {
    // 6to4 and NAT64 wrapping a public relay stay public; local-use NAT64 is never public.
    expect(isPrivateAddress('2002:808:808::')).toBe(false);
    expect(isPrivateAddress('64:ff9b::808:808')).toBe(false);
    expect(isPrivateAddress('2002:c0a8:1::')).toBe(true);
    expect(isPrivateAddress('64:ff9b:1::808:808')).toBe(true);
    expect(isPrivateAddress('::ffff:0:a00:1')).toBe(true);
  });

  it('treats deprecated IPv6 site-local fec0::/10 as private', () => {
    expect(isPrivateAddress('fec0::1')).toBe(true);
    expect(isPrivateAddress('[feff:ffff::1]')).toBe(true);
  });

  it('refuses a body over the asset ceiling, telling the fetch port where to stop', async () => {
    const fetcher = scriptedFetcher({ 'https://cdn.example.com/big.png': ok(pngBytes(2, 2, 64)) });
    const opened = await open({
      policy: { maxAssetBytes: 64 },
      ports: { resolveHost: async () => ['93.184.216.34'], fetch: fetcher.fetch },
    });
    const { result } = await admitUrl(opened, 'https://cdn.example.com/big.png');
    expect(result).toMatchObject({ rejection: { code: 'per-part-limit-exceeded' } });
    expect(fetcher.requests.map((request) => request.maxBytes)).toEqual([64]);
    await opened.close();
  });

  it('refuses a host name that resolves to a private address', async () => {
    const resolver = scriptedResolver({ 'internal.example.com': [['93.184.216.34', '10.0.0.7']] });
    const fetcher = scriptedFetcher({});
    const opened = await open({
      ports: { resolveHost: resolver.resolveHost, fetch: fetcher.fetch },
    });
    const { result } = await admitUrl(opened, 'https://internal.example.com/a.png');
    expect(result).toMatchObject({ rejection: { code: 'private-address' } });
    expect(fetcher.requests).toEqual([]);
    await opened.close();
  });

  it('refuses DNS rebinding: an answer that changes between validation and connection', async () => {
    const resolver = scriptedResolver({
      'rebind.example.com': [['93.184.216.34'], ['127.0.0.1']],
    });
    const fetcher = scriptedFetcher({ 'https://rebind.example.com/a.png': ok() });
    const opened = await open({
      ports: { resolveHost: resolver.resolveHost, fetch: fetcher.fetch },
    });
    const { result } = await admitUrl(opened, 'https://rebind.example.com/a.png');
    expect(result).toMatchObject({ rejection: { code: 'dns-rebinding' } });
    expect(resolver.lookups).toEqual(['rebind.example.com', 'rebind.example.com']);
    expect(fetcher.requests).toEqual([]);
    await opened.close();
  });

  it('pins the connection to the validated address', async () => {
    const resolver = scriptedResolver({ 'cdn.example.com': [['93.184.216.34']] });
    const fetcher = scriptedFetcher({ 'https://cdn.example.com/a.png': ok() });
    const opened = await open({
      ports: { resolveHost: resolver.resolveHost, fetch: fetcher.fetch },
    });
    const { result } = await admitUrl(opened, 'https://cdn.example.com/a.png');
    expect(result.outcome).toBe('completed');
    expect(fetcher.requests.map((request) => request.address)).toEqual(['93.184.216.34']);
    await opened.close();
  });

  it('follows a redirect chain, revalidating every hop', async () => {
    const resolver = scriptedResolver({
      'a.example.com': [['93.184.216.34']],
      'b.example.com': [['93.184.216.35']],
    });
    const fetcher = scriptedFetcher({
      'https://a.example.com/start': { status: 302, location: '/next', body: new Uint8Array() },
      'https://a.example.com/next': {
        status: 301,
        location: 'https://b.example.com/final.png',
        body: new Uint8Array(),
      },
      'https://b.example.com/final.png': ok(),
    });
    const opened = await open({
      ports: { resolveHost: resolver.resolveHost, fetch: fetcher.fetch },
    });
    const { admission, result } = await admitUrl(opened, 'https://a.example.com/start');
    expect(result.outcome).toBe('completed');
    const descriptor = await opened.assets.inspect(
      admission.assetId,
      { id: 'alice', privileged: true },
      {
        projection: 'privileged',
      },
    );
    expect(descriptor.projection === 'privileged' && descriptor.provenance).toEqual({
      kind: 'url',
      origin: 'https://b.example.com',
      fetchedBy: 'host',
      redirects: 2,
    });
    await opened.close();
  });

  it('refuses a redirect to a private address', async () => {
    const resolver = scriptedResolver({ 'a.example.com': [['93.184.216.34']] });
    const fetcher = scriptedFetcher({
      'https://a.example.com/start': {
        status: 302,
        location: 'https://169.254.169.254/latest/meta-data',
        body: new Uint8Array(),
      },
    });
    const opened = await open({
      ports: { resolveHost: resolver.resolveHost, fetch: fetcher.fetch },
    });
    const { result } = await admitUrl(opened, 'https://a.example.com/start');
    expect(result).toMatchObject({ rejection: { code: 'private-address' } });
    expect(fetcher.requests).toHaveLength(1);
    await opened.close();
  });

  it('refuses a redirect that downgrades the scheme', async () => {
    const resolver = scriptedResolver({ 'a.example.com': [['93.184.216.34']] });
    const fetcher = scriptedFetcher({
      'https://a.example.com/start': {
        status: 302,
        location: 'http://a.example.com/plain.png',
        body: new Uint8Array(),
      },
    });
    const opened = await open({
      ports: { resolveHost: resolver.resolveHost, fetch: fetcher.fetch },
    });
    const { result } = await admitUrl(opened, 'https://a.example.com/start');
    expect(result).toMatchObject({ rejection: { code: 'scheme-not-allowed' } });
    await opened.close();
  });

  it('refuses a redirect chain longer than maxRedirects', async () => {
    const resolver = scriptedResolver({ 'loop.example.com': [['93.184.216.34']] });
    const routes: Record<string, AssetFetchResponse> = {};
    for (let hop = 0; hop < 5; hop++) {
      routes[`https://loop.example.com/${hop}`] = {
        status: 307,
        location: `/${hop + 1}`,
        body: new Uint8Array(),
      };
    }
    const fetcher = scriptedFetcher(routes);
    const opened = await open({
      policy: { url: { maxRedirects: 2 } },
      ports: { resolveHost: resolver.resolveHost, fetch: fetcher.fetch },
    });
    const { result } = await admitUrl(opened, 'https://loop.example.com/0');
    expect(result).toMatchObject({ rejection: { code: 'too-many-redirects' } });
    expect(fetcher.requests).toHaveLength(3);
    await opened.close();
  });

  const expiredSignatures = [
    'https://bucket.example.com/a.png?X-Amz-Date=20191231T000000Z&X-Amz-Expires=60&X-Amz-Signature=deadbeef',
    'https://cdn.example.com/a.png?Expires=1577750400&Signature=abc&Key-Pair-Id=K',
    'https://account.example.com/a.png?se=2019-12-31T00%3A00%3A00Z&sig=abc',
  ];
  for (const url of expiredSignatures) {
    it(`refuses an expired signed URL (${new URL(url).searchParams.keys().next().value})`, async () => {
      const fetcher = scriptedFetcher({});
      const opened = await open({
        ports: { resolveHost: async () => ['93.184.216.34'], fetch: fetcher.fetch },
      });
      const { result } = await admitUrl(opened, url);
      expect(result).toMatchObject({ rejection: { code: 'signed-url-expired' } });
      expect(fetcher.requests).toEqual([]);
      expect(JSON.stringify(opened.events)).not.toContain('Signature');
      expect(JSON.stringify(opened.events)).not.toContain('sig=');
      await opened.close();
    });
  }

  it('admits a signed URL that has not expired', async () => {
    const url =
      'https://bucket.example.com/a.png?X-Amz-Date=20200101T000000Z&X-Amz-Expires=3600&X-Amz-Signature=cafe';
    const opened = await open({
      ports: {
        resolveHost: async () => ['93.184.216.34'],
        fetch: scriptedFetcher({ [url]: ok() }).fetch,
      },
    });
    const { result } = await admitUrl(opened, url);
    expect(result.outcome).toBe('completed');
    await opened.close();
  });

  it('refuses credential-bearing URLs and never echoes the credential', async () => {
    const fetcher = scriptedFetcher({});
    const opened = await open({
      ports: { resolveHost: async () => ['93.184.216.34'], fetch: fetcher.fetch },
    });
    const { admission, result } = await admitUrl(
      opened,
      'https://user:hunter2@cdn.example.com/a.png',
    );
    expect(result).toMatchObject({ rejection: { code: 'credential-bearing-url' } });
    expect(fetcher.requests).toEqual([]);
    const descriptor = await opened.assets.inspect(admission.assetId, alice);
    expect(JSON.stringify(descriptor)).not.toContain('hunter2');
    expect(JSON.stringify(opened.events)).not.toContain('hunter2');
    expect(JSON.stringify(await opened.assets.auditRecords())).not.toContain('hunter2');
    await opened.close();
  });

  it('refuses a bearer token carried in the query, and never echoes it', async () => {
    const fetcher = scriptedFetcher({});
    const opened = await open({
      ports: { resolveHost: async () => ['93.184.216.34'], fetch: fetcher.fetch },
    });
    for (const query of ['access_token=hunter2', 'API_KEY=hunter2', 'token=hunter2']) {
      const { result } = await admitUrl(opened, `https://cdn.example.com/a.png?${query}`);
      expect(result).toMatchObject({ rejection: { code: 'credential-bearing-url' } });
    }
    expect(fetcher.requests).toEqual([]);
    expect(JSON.stringify(await opened.assets.auditRecords())).not.toContain('hunter2');
    await opened.close();
  });

  it('refuses a scheme outside the allowlist', async () => {
    const opened = await open({ ports: { resolveHost: async () => ['93.184.216.34'] } });
    for (const url of [
      'http://cdn.example.com/a.png',
      'file:///etc/passwd',
      'ftp://cdn.example.com/a',
    ]) {
      const { result } = await admitUrl(opened, url);
      expect(result).toMatchObject({ rejection: { code: 'scheme-not-allowed' } });
    }
    await opened.close();
  });
});

describe('provider-fetch declaration', () => {
  const url =
    'https://cdn.example.com/doc.pdf?X-Amz-Date=20200101T000000Z&X-Amz-Expires=3600&X-Amz-Signature=f00d';

  it('is refused unless the policy allows provider fetch', async () => {
    const opened = await open({});
    const { result } = await admitUrl(opened, url, 'provider');
    expect(result).toMatchObject({ rejection: { code: 'provider-fetch-not-allowed' } });
    await opened.close();
  });

  it('is never fetched or resolved by the host, and holds no Bureau bytes', async () => {
    const resolver = scriptedResolver({});
    const fetcher = scriptedFetcher({});
    const opened = await open({
      policy: { url: { allowProviderFetch: true } },
      ports: { resolveHost: resolver.resolveHost, fetch: fetcher.fetch },
    });
    const admission = await opened.assets.admit(
      { source: { kind: 'url', url, fetchedBy: 'provider' }, declaredMediaType: 'application/pdf' },
      alice,
    );
    expect(await admission.work.result()).toMatchObject({ outcome: 'completed' });
    expect(resolver.lookups).toEqual([]);
    expect(fetcher.requests).toEqual([]);

    const descriptor = await opened.assets.inspect(admission.assetId, alice);
    expect(descriptor).toMatchObject({
      state: 'available',
      custody: 'provider-fetch',
      digest: undefined,
      byteLength: undefined,
      mediaType: 'application/pdf',
    });
    const resolved = await opened.assets.resolve(admission.source, alice);
    expect(resolved.content).toEqual({ kind: 'provider-fetch', url });
    expect(JSON.stringify(descriptor)).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(opened.events)).not.toContain('X-Amz-Signature');
    await opened.close();
  });

  it('is refused without a declared media type, or when a gate or limit would need its bytes', async () => {
    const declared = { declaredMediaType: 'application/pdf' };
    const cases: Array<[Omit<BureauAssetOptions, 'storage'>, { declaredMediaType?: string }]> = [
      [{}, {}],
      [
        {
          ports: {
            safetyGates: [{ name: 'scanner', inspect: async () => ({ verdict: 'clean' }) }],
          },
        },
        declared,
      ],
      [
        { policy: { limits: [{ scope: 'per-part', modality: 'document', maxPageCount: 5 }] } },
        declared,
      ],
    ];
    for (const [options, request] of cases) {
      const opened = await open({
        ...options,
        policy: { ...options.policy, url: { allowProviderFetch: true } },
      });
      const admission = await opened.assets.admit(
        { source: { kind: 'url', url, fetchedBy: 'provider' }, ...request },
        alice,
      );
      expect(await admission.work.result()).toMatchObject({
        rejection: { code: 'provider-fetch-not-allowed' },
      });
      await opened.close();
    }
  });

  it('still refuses a literal private address and an expired signature', async () => {
    const opened = await open({ policy: { url: { allowProviderFetch: true } } });
    const literal = await admitUrl(opened, 'https://10.0.0.1/doc.pdf', 'provider');
    expect(literal.result).toMatchObject({ rejection: { code: 'private-address' } });
    const expired = await admitUrl(
      opened,
      'https://cdn.example.com/a?X-Amz-Date=20191231T000000Z&X-Amz-Expires=60',
      'provider',
    );
    expect(expired.result).toMatchObject({ rejection: { code: 'signed-url-expired' } });
    await opened.close();
  });
});

describe('malware and content-safety gates', () => {
  it('quarantines a flagged asset, which never resolves', async () => {
    const opened = await open({
      ports: {
        safetyGates: [
          {
            name: 'clamav',
            inspect: async () => ({ verdict: 'flagged', category: 'malware' }),
          },
        ],
      },
    });
    const bytes = textBytes(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const admission = await opened.assets.admit({ source: { kind: 'inline', bytes } }, alice);
    expect(await admission.work.result()).toMatchObject({
      outcome: 'failed',
      rejection: { code: 'safety-gate-flagged' },
    });
    expect(await opened.assets.inspect(admission.assetId, alice)).toMatchObject({
      state: 'quarantined',
    });
    expect(await rejectionOf(opened.assets.resolve(admission.source, alice))).toBeInstanceOf(
      AssetUnavailableError,
    );
    expect(opened.events).toContainEqual(
      expect.objectContaining({ type: 'asset.quarantined', gate: 'clamav', category: 'malware' }),
    );
    expect(JSON.stringify(opened.events)).not.toContain('EICAR');
    await opened.close();
  });

  it('fails closed when a gate errors', async () => {
    const opened = await open({
      ports: {
        safetyGates: [
          {
            name: 'broken',
            inspect: async () => {
              throw new Error('scanner unavailable');
            },
          },
        ],
      },
    });
    const admission = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    expect(await admission.work.result()).toMatchObject({
      rejection: { code: 'safety-gate-error' },
    });
    expect(await opened.assets.inspect(admission.assetId, alice)).toMatchObject({
      state: 'rejected',
    });
    await opened.close();
  });
});

describe('content digest', () => {
  it('detects tampered stored bytes on resolution', async () => {
    const fixture = createMemoryAssetStorageFixture();
    const opened = await open({ storage: fixture.storage });
    const admission = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    await admission.work.result();

    const [blobKey] = await fixture.storage.list('asset:v1:blob:');
    await fixture.storage.set(blobKey!, base64Of(textBytes('tampered')));
    expect(await rejectionOf(opened.assets.resolve(admission.source, alice))).toBeInstanceOf(
      AssetIntegrityError,
    );
    await opened.close();
  });

  it('reports a stored blob that is not base64 as an integrity failure', async () => {
    const fixture = createMemoryAssetStorageFixture();
    const opened = await open({ storage: fixture.storage });
    const admission = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    await admission.work.result();

    const [blobKey] = await fixture.storage.list('asset:v1:blob:');
    await fixture.storage.set(blobKey!, '%%% not base64 %%%');
    expect(await rejectionOf(opened.assets.resolve(admission.source, alice))).toBeInstanceOf(
      AssetIntegrityError,
    );
    await opened.close();
  });
});

describe('duplicate policy', () => {
  it('reject: refuses a second admission of the same bytes by the same owner', async () => {
    const opened = await open({ policy: { duplicatePolicy: 'reject' } });
    const first = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    await first.work.result();
    const second = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    expect(await second.work.result()).toMatchObject({ rejection: { code: 'duplicate' } });
    await opened.close();
  });

  it('reuse: resolves to the existing asset and retires the new identity', async () => {
    const opened = await open({ policy: { duplicatePolicy: 'reuse' } });
    const first = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    await first.work.result();
    const second = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    const result = await second.work.result();
    expect(result.outcome === 'completed' && result.value.assetId).toBe(first.assetId);
    const retired = await opened.assets.inspect(second.assetId, alice);
    expect(retired.rejection?.code).toBe('duplicate');
    await opened.close();
  });

  it('store-separately: two identities share one stored blob', async () => {
    const fixture = createMemoryAssetStorageFixture();
    const opened = await open({
      storage: fixture.storage,
      policy: { duplicatePolicy: 'store-separately' },
    });
    const first = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    const second = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    expect(await first.work.result()).toMatchObject({ outcome: 'completed' });
    expect(await second.work.result()).toMatchObject({ outcome: 'completed' });
    expect(first.assetId).not.toBe(second.assetId);
    expect(await fixture.storage.list('asset:v1:blob:')).toHaveLength(1);
    await opened.close();
  });

  it('never deduplicates across owners', async () => {
    const opened = await open({ policy: { duplicatePolicy: 'reject' } });
    const first = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    const second = await opened.assets.admit(
      { source: { kind: 'inline', bytes: PNG } },
      { id: 'bob' },
    );
    expect(await first.work.result()).toMatchObject({ outcome: 'completed' });
    expect(await second.work.result()).toMatchObject({ outcome: 'completed' });
    await opened.close();
  });
});

describe('events and audit records', () => {
  it('never expose raw bytes, secrets, reusable signed URLs, or protected extracted content', async () => {
    const secretText = 'CONFIDENTIAL: quarterly numbers';
    const signedUrl =
      'https://cdn.example.com/a.png?X-Amz-Date=20200101T000000Z&X-Amz-Expires=3600&X-Amz-Signature=5ecret';
    const bytes = pngBytes(3, 3, 128);
    const opened = await open({
      policy: { url: { allowProviderFetch: true } },
      ports: {
        resolveHost: async () => ['93.184.216.34'],
        fetch: scriptedFetcher({ [signedUrl]: ok(bytes) }).fetch,
        extractMetadata: async () => ({ extractedText: secretText }),
        providers: {
          anthropic: {
            download: async () => ({ bytes }),
            upload: async () => ({ providerFileId: 'file_secret_handle' }),
          },
        },
      },
    });

    const inline = await opened.assets.admit({ source: { kind: 'inline', bytes } }, alice);
    await inline.work.result();
    await admitUrl(opened, signedUrl);
    await admitUrl(opened, signedUrl, 'provider');
    await admitUrl(opened, 'https://user:pa55word@cdn.example.com/a.png');
    await opened.assets
      .transferToProvider(inline.assetId, alice, { provider: 'anthropic' })
      .result();
    await opened.assets.delete(inline.assetId, alice).result();
    await opened.assets.collectGarbage().result();

    const audit = await opened.assets.auditRecords();
    expect(audit.length).toBeGreaterThan(0);
    const serialized = JSON.stringify([opened.events, audit]);
    for (const forbidden of [
      base64Of(bytes),
      base64Of(bytes).slice(0, 24),
      'X-Amz-Signature',
      '5ecret',
      'pa55word',
      secretText,
      '/a.png',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain('https://cdn.example.com');
    await opened.close();
  });
});
