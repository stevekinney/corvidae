import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256BytesHex, sha256Hex } from '@corvidae/cryptography';

import { findRecord } from '../../src/discovery/catalog';
import { discoverSkills } from '../../src/discovery/discover';
import { materializeRemoteSource, type RemoteSkillSource } from '../../src/discovery/remote';

const now = (): string => '2026-09-19T00:00:00.000Z';

const scratchRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function skillMarkdown(name: string): string {
  return ['---', `name: ${name}`, `description: A remote skill.`, '---', '', 'Body.', ''].join(
    '\n',
  );
}

/** A registry that serves fixed bodies and records every path it was asked for. */
function registry(files: Readonly<Record<string, string>>): {
  fetch: typeof globalThis.fetch;
  requested: string[];
} {
  const requested: string[] = [];
  const fetchImplementation = (async (input: RequestInfo | URL): Promise<Response> => {
    // Narrowed explicitly: a `Request` has no useful default stringification, and these fixtures
    // are only ever called with a string URL.
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const body = files[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImplementation, requested };
}

function remoteSource(overrides?: Partial<RemoteSkillSource>): RemoteSkillSource {
  return {
    id: 'registry',
    kind: 'remote',
    location: 'https://skills.example.com',
    precedence: 30,
    names: ['code-review'],
    ...overrides,
  };
}

describe('materializeRemoteSource', () => {
  it('refuses a source with no integrity policy without making a request', async () => {
    const { fetch, requested } = registry({});

    const result = await materializeRemoteSource(remoteSource(), { fetch });

    // Not a single request: content arriving with nothing to check it against is exactly the case
    // where "fetch it and see" is how untrusted instructions reach a model.
    expect(requested).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(['integrity-policy-missing']);
  });

  it('admits a skill whose pinned digest matches', async () => {
    const body = skillMarkdown('code-review');
    const digest = await sha256Hex(body);
    const { fetch, requested } = registry({
      'https://skills.example.com/code-review/SKILL.md': body,
    });

    const result = await materializeRemoteSource(
      remoteSource({ integrity: { expectedDigests: { 'code-review': digest } } }),
      { fetch },
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    // A matching pin is sufficient on its own, so no signature is fetched and an unrelated
    // signature outage cannot reject content whose bytes are already proven.
    expect(requested).toEqual(['https://skills.example.com/code-review/SKILL.md']);
  });

  it('refuses a skill whose pinned digest does not match', async () => {
    const { fetch } = registry({
      'https://skills.example.com/code-review/SKILL.md': skillMarkdown('code-review'),
    });

    const result = await materializeRemoteSource(
      remoteSource({ integrity: { expectedDigests: { 'code-review': 'a'.repeat(64) } } }),
      { fetch },
    );

    expect(result.artifacts).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(['digest-mismatch']);
  });

  it('admits a skill with a valid detached signature', async () => {
    const { fetch } = registry({
      'https://skills.example.com/code-review/SKILL.md': skillMarkdown('code-review'),
      'https://skills.example.com/code-review/SKILL.md.sig': 'a-valid-signature',
    });

    const result = await materializeRemoteSource(
      remoteSource({ integrity: { publicKey: 'PEM' } }),
      {
        fetch,
        verifySignature: (content, signature, publicKey) => {
          // Asserts the verifier is handed the manifest's own bytes and the configured key, not
          // just a signature to wave through.
          expect(new TextDecoder().decode(content)).toContain('name: code-review');
          expect(publicKey).toBe('PEM');
          return signature === 'a-valid-signature';
        },
      },
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
  });

  it('refuses a skill whose signature does not verify', async () => {
    const { fetch } = registry({
      'https://skills.example.com/code-review/SKILL.md': skillMarkdown('code-review'),
      'https://skills.example.com/code-review/SKILL.md.sig': 'forged',
    });

    const result = await materializeRemoteSource(
      remoteSource({ integrity: { publicKey: 'PEM' } }),
      { fetch, verifySignature: () => false },
    );

    expect(result.diagnostics.map((entry) => entry.code)).toEqual(['signature-invalid']);
  });

  it('fails closed when a configured signature is missing', async () => {
    const { fetch } = registry({
      'https://skills.example.com/code-review/SKILL.md': skillMarkdown('code-review'),
    });

    const result = await materializeRemoteSource(
      remoteSource({ integrity: { publicKey: 'PEM' } }),
      { fetch, verifySignature: () => true },
    );

    // A 404 on the signature is not "unsigned, therefore fine" when a public key is configured.
    expect(result.artifacts).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(['signature-missing']);
  });

  it('reports an unreachable registry without admitting anything', async () => {
    const { fetch } = registry({});

    const result = await materializeRemoteSource(
      remoteSource({ integrity: { expectedDigests: { 'code-review': 'a'.repeat(64) } } }),
      { fetch },
    );

    expect(result.diagnostics.map((entry) => entry.code)).toEqual(['unreachable']);
  });

  it('sends the bearer token but never puts it in a catalog-visible field', async () => {
    const body = skillMarkdown('code-review');
    const digest = await sha256Hex(body);
    let seenAuthorization: string | undefined;
    const fetchImplementation = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenAuthorization = headers['Authorization'];
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;

    const source = remoteSource({
      authToken: 'secret-token',
      integrity: { expectedDigests: { 'code-review': digest } },
    });

    const revision = await discoverSkills({
      sources: [source],
      remote: { fetch: fetchImplementation },
      now,
    });

    expect(seenAuthorization).toBe('Bearer secret-token');
    const record = findRecord(revision, 'code-review');
    expect(record?.sourceLocation).toBe('https://skills.example.com');
    expect(JSON.stringify(record)).not.toContain('secret-token');
  });
});

describe('remote sources in a catalog', () => {
  it('catalogues a verified remote skill as manifest-only', async () => {
    const body = skillMarkdown('code-review');
    const digest = await sha256Hex(body);
    const { fetch } = registry({
      'https://skills.example.com/code-review/SKILL.md': body,
    });

    const revision = await discoverSkills({
      sources: [remoteSource({ integrity: { expectedDigests: { 'code-review': digest } } })],
      remote: { fetch },
      now,
    });

    const record = findRecord(revision, 'code-review');
    expect(record?.available).toBe(true);
    expect(record?.sourceKind).toBe('remote');
    // The transport genuinely cannot carry `references/` or `assets/`, so the entry says so.
    expect(record?.bundleSupport).toBe('manifest-only');
    expect(record?.trust).toBe('trusted');
  });

  it('admits nothing from a remote source with no integrity policy', async () => {
    const { fetch } = registry({
      'https://skills.example.com/code-review/SKILL.md': skillMarkdown('code-review'),
    });

    const revision = await discoverSkills({
      sources: [remoteSource()],
      remote: { fetch },
      now,
    });

    expect(revision.records).toEqual([]);
    expect(revision.sourceDiagnostics.map((entry) => entry.code)).toContain('untrusted');
  });

  it('reports a configured remote source with no transport rather than skipping it', async () => {
    const revision = await discoverSkills({
      sources: [remoteSource({ integrity: { publicKey: 'PEM' } })],
      now,
    });

    // Silently omitting it would be indistinguishable from a source that was simply empty.
    expect(revision.sourceDiagnostics.map((entry) => entry.code)).toContain('unavailable');
  });

  it('lets an explicit trust policy revoke a source whose signatures are valid', async () => {
    const body = skillMarkdown('code-review');
    const digest = await sha256Hex(body);
    const { fetch } = registry({
      'https://skills.example.com/code-review/SKILL.md': body,
    });

    const revision = await discoverSkills({
      sources: [remoteSource({ integrity: { expectedDigests: { 'code-review': digest } } })],
      remote: { fetch },
      trustPolicy: { decide: () => ({ state: 'revoked', reason: 'withdrawn' }) },
      now,
    });

    expect(findRecord(revision, 'code-review')?.available).toBe(false);
    expect(findRecord(revision, 'code-review')?.unavailableReason).toBe('source-revoked');
  });

  it('lets a higher-precedence filesystem source shadow a remote one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corvidae-remote-shadow-'));
    scratchRoots.push(root);
    const directory = join(root, 'code-review');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), skillMarkdown('code-review'));

    const body = skillMarkdown('code-review');
    const digest = await sha256Hex(body);
    const { fetch } = registry({
      'https://skills.example.com/code-review/SKILL.md': body,
    });

    const revision = await discoverSkills({
      sources: [
        remoteSource({ integrity: { expectedDigests: { 'code-review': digest } } }),
        { id: 'local', kind: 'user', location: root, precedence: 20 },
      ],
      remote: { fetch },
      trustPolicy: { decide: () => ({ state: 'trusted', reason: 'test policy' }) },
      now,
    });

    // The previous version of this test configured no filesystem source at all and would have
    // passed with shadowing removed entirely.
    const records = revision.records.filter((record) => record.name === 'code-review');
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.available)?.sourceId).toBe('local');
    expect(records.find((record) => !record.available)?.sourceId).toBe('registry');
  });

  it('reports a cancelled remote fetch as cancelled rather than committing a partial catalog', async () => {
    const bodies: Record<string, string> = {};
    for (const name of ['alpha', 'beta', 'gamma']) {
      bodies[`https://skills.example.com/${name}/SKILL.md`] = skillMarkdown(name);
    }
    const digests: Record<string, string> = {};
    for (const name of ['alpha', 'beta', 'gamma']) {
      digests[name] = await sha256Hex(skillMarkdown(name));
    }

    const controller = new AbortController();
    const fetchImplementation = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // Abort after the first skill has been served.
      controller.abort();
      const body = bodies[url];
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;

    const revision = await discoverSkills({
      sources: [
        remoteSource({
          names: ['alpha', 'beta', 'gamma'],
          integrity: { expectedDigests: digests },
        }),
      ],
      remote: { fetch: fetchImplementation },
      signal: controller.signal,
      now,
    });

    // Returning normally from a cancelled fetch let the loop finish and report `completed`, so an
    // abort mid-poll committed a truncated catalog as though it were the whole thing.
    expect(revision.outcome).toBe('cancelled');
    expect(revision.records.length).toBeLessThan(3);
  });

  it('verifies the bytes the registry served, not a decoded copy of them', async () => {
    // A body whose UTF-8 round trip is lossless but which carries a BOM: `response.text()` strips
    // it, so digesting decoded text would verify something the registry never sent.
    const body = `\uFEFF${skillMarkdown('code-review')}`;
    const bytes = new TextEncoder().encode(body);
    const digest = await sha256BytesHex(bytes);

    const fetchImplementation = (async (_input: RequestInfo | URL): Promise<Response> =>
      new Response(bytes, { status: 200 })) as typeof globalThis.fetch;

    const result = await materializeRemoteSource(
      remoteSource({ integrity: { expectedDigests: { 'code-review': digest } } }),
      { fetch: fetchImplementation },
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
  });
});
