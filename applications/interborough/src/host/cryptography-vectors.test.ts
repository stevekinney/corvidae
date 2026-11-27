/**
 * COR-2775: the host's comparisons and digests, pinned to what they produced before they moved to
 * `@lostgradient/cryptography`. Every expected string below was captured from the code that called
 * `node:crypto` and `Bun.CryptoHasher` directly, so a stored digest, a persisted hash and a header
 * the host sends stay byte for byte what they were. The comparisons cover unequal lengths: a
 * presented key that is shorter, longer or empty is refused, never compared against a prefix.
 */
import type { WorkspaceIdentity } from '@lostgradient/backchannel';
import {
  createIncrementalHash,
  sha256BytesHexSync,
  sha256HexSync,
  timingSafeEqualHex,
} from '@lostgradient/cryptography';
import { describe, expect, test } from 'bun:test';

import { createA2aAuthentication } from './a2a-authentication.ts';
import { createLocalAuthentication } from './engine-proxy.ts';
import { createHostMutationContext } from './host-mutation-context.ts';
import { deriveStartOverrideSigningSecret } from './host.ts';
import { digestOf } from './panel-build.ts';
import { secretPublicationDigest } from './secret-publication-digest.ts';
import { supervisorLeaseIdentity } from './supervisor.ts';
import { pluginListingOwner } from './tool-listing-memory.ts';
import { sameSecret } from './tool-source-pending-sign-ins.ts';
import { qualifiedToolName } from './tool-sources-configuration.ts';

/** Whether `resolve` admits `presented`, the way Weft asks an authentication. */
async function admits(
  authentication: {
    resolveApiKeyPrincipal?: (presented: string, ...rest: never[]) => unknown;
  },
  presented: string,
): Promise<boolean> {
  return (await authentication.resolveApiKeyPrincipal?.(presented)) !== null;
}

/** Presented keys against the key `key-é`: only the equal one is admitted. */
const KEY = 'key-é';
const PRESENTED: ReadonlyArray<readonly [string, boolean]> = [
  [KEY, true],
  ['', false],
  ['k', false],
  ['key-', false],
  ['key-e', false],
  ['key-é ', false],
  [`${KEY}${KEY}`, false],
  ['KEY-É', false],
  // The same letters as `key-é`, composed differently: a different number of bytes.
  ['key-é', false],
];

describe('the comparisons of a presented secret', () => {
  test.each(PRESENTED)('the local relay key admits %j: %p', async (presented, admitted) => {
    expect(await admits(createLocalAuthentication(KEY), presented)).toBe(admitted);
  });

  test.each(PRESENTED)('the A2A key admits %j: %p', async (presented, admitted) => {
    expect(
      await admits(
        createA2aAuthentication(KEY, () => undefined),
        presented,
      ),
    ).toBe(admitted);
  });

  test.each(PRESENTED)('a pending sign-in secret matches %j: %p', (presented, matches) => {
    expect(sameSecret(presented, KEY)).toBe(matches);
    expect(sameSecret(KEY, presented)).toBe(matches);
  });

  test('an empty secret equals only an empty one', async () => {
    expect(sameSecret('', '')).toBe(true);
    expect(sameSecret('', 'a')).toBe(false);
    expect(sameSecret('a', '')).toBe(false);
    expect(await admits(createLocalAuthentication(''), '')).toBe(true);
    expect(await admits(createLocalAuthentication(''), 'a')).toBe(false);
  });

  test('a long secret is not matched by its prefix, or by itself with more after it', () => {
    const long = 'x'.repeat(4096);
    expect(sameSecret(long, long)).toBe(true);
    expect(sameSecret(long.slice(0, 4095), long)).toBe(false);
    expect(sameSecret(`${long}x`, long)).toBe(false);
  });

  test('the A2A refusal reaches the warning without the presented key', async () => {
    const warnings: string[] = [];
    const authentication = createA2aAuthentication(KEY, (message) => warnings.push(message));
    authentication.auditSink?.({
      outcome: 'failure',
      httpMethod: 'POST',
      path: '/a2a',
      reason: 'bad key',
    } as never);
    expect(warnings).toEqual(['A2A authentication refused POST /a2a: bad key.']);
  });
});

describe('the digests the host stores and sends', () => {
  test('the digest of a secret publication request', () => {
    expect(
      secretPublicationDigest({
        operation: 'publish',
        target: 'tool-source:notes',
        expectedRevision: null,
        payload: { b: 2, a: [1, 'é', { z: null, y: true }] },
      }),
    ).toBe('e4e699ce66f413a2da8b56a1fe0be86f36dff3e66274ffcdb848f22f4c568e2b');
    expect(
      secretPublicationDigest({
        operation: 'publish',
        target: 'tool-source:notes',
        expectedRevision: 'r-1',
        payload: 'é',
      }),
    ).toBe('cba0678d29e862061ce7d6a222c28e269c7ba15385725bb0a0360d6f073414c4');
  });

  test('the publication operation id of a mutation context', () => {
    const identity = {
      version: 1,
      workspaceId: 'workspace-é',
      actorId: 'actor',
      owner: 'owner',
      actorKind: 'user',
      membershipRevision: '1',
      capabilities: ['workspace:use', 'workspace:manage'],
    } as const satisfies WorkspaceIdentity;
    const context = createHostMutationContext(
      identity,
      { operationId: 'client-id', expectedRevision: null },
      async () => identity,
    );
    expect(context.operationIdFor('provider', 'anthropic')).toBe(
      '8b01a30a67caeab9c2a9b9dc62f961d2e9a14b93aa0eafb4db89f495091c5813',
    );
  });

  test('the owner key of a plugin listing is cut to 32 hex digits', () => {
    expect(pluginListingOwner({ source: 'folder', location: '/plugins/é' })).toBe(
      'plugin:9d76dd41af42475136d4768c80ae0c4d',
    );
  });

  test('the start-override signing secret', () => {
    expect(deriveStartOverrideSigningSecret('k-1')).toBe(
      '8406392ff05b13ef5acfab9cc123b14ebaf3fe3d026ad35d0f1d0dd43efe596d',
    );
  });

  test('the supervisor lease identity of a showcase root', () => {
    expect(
      supervisorLeaseIdentity(
        { INTERBOROUGH_SHOWCASE_HOME: '/fixed/showcase' },
        true,
        '/fixed/repository',
        'nonce-1',
      ),
    ).toBe('92b959a77d32c55648cfaeb457e5120bbc0cac9d0f88c9874364557eba674282');
  });

  test('a tool name cut or rewritten carries the first eight hex digits of its raw name', () => {
    expect(qualifiedToolName('notes', 'search.pages')).toEqual({
      name: 'notes__search_pages-52ac82fb',
    });
    expect(qualifiedToolName('notes', 'x'.repeat(80))).toEqual({
      name: `notes__${'x'.repeat(48)}-d929cdee`,
    });
  });

  test('the contract digest of a panel page', () => {
    expect(digestOf('<html>é</html>')).toBe(
      'sha256:aa7beeb10ec55bed7faf6783eea6430ff5851f58191eae485bb8d0f77e136236',
    );
  });
});

/**
 * The inputs of the digests that are not reachable from outside their module (a configuration
 * hash in an audit record, a source's revision, the claim of an OAuth credential, a vault
 * operation, a panel cache entry, a downloaded asset): the same text through the shared helper.
 */
describe('the shapes of digest input the host hashes', () => {
  const text: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a committed configuration file',
      `${JSON.stringify({ a: 1, é: ['x'] }, null, 2)}\n`,
      'a9ede8c2e9598a512f99881c97b7abd584b9b11e097c791f71feb19266277103',
    ],
    [
      'a tool source description',
      JSON.stringify({ id: 'notes', url: 'https://example.com/é' }),
      '01a34a28414b4f8529705030c2b7b68be72e15a60e9569c296950ce033a63f97',
    ],
    [
      'an OAuth credential',
      'refresh-é',
      'd90a89580b60ce77e121839f113d7ddef411b8e568ace66f9a03eb97a543cb29',
    ],
    [
      'a vault operation',
      JSON.stringify(['tool-source-vault', 'workspace-1', 'notes', 7]),
      'c1e66abf7d6d66c2fdd6faf5c23380c7fc7fb07be721a6a2be703d05dcb07347',
    ],
    ['an empty text', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    [
      'a text with a NUL',
      'a\0b',
      '59b271ae1bbcb1d31d41929817f4b16fb439eb4f31520b5ad1d5ce98920a7138',
    ],
    ['an A2A key', 'key-é', '4bd6dd3209080f2f23e35170947090757a2eaa583eb8c098c4ca2eea6c892f1b'],
  ];

  test.each(text)('hashes %s', (_name, input, digest) => {
    expect(sha256HexSync(input)).toBe(digest);
  });

  test('names a panel cache entry by the first 32 digits of its panel’s digest', () => {
    expect(sha256HexSync('panel/é').slice(0, 32)).toBe('b83634947ced87e7c3661e16a10f695a');
  });

  test('hashes the bytes of a file or a downloaded asset', () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 2, 3, 250]);
    expect(sha256BytesHexSync(bytes)).toBe(
      'a47c668ef0bc92eb71d5ed6ad95c58c9b414d7df97c476226486beb33199f6f8',
    );
  });

  test('hashes parts fed one after another as the one text they make', () => {
    const hash = createIncrementalHash();
    for (const part of ['[1,"é"]\0', '\0/a\0deadbeef', '\0/b\0cafe']) hash.update(part);
    expect(hash.digest()).toBe('d887e6370d49bba48bd302d30653cd7e4c88a635e35f0e6ca799434e3be39885');
  });

  test('compares two digests of one length, and refuses digests of two', () => {
    const digest = sha256HexSync('key-é');
    expect(timingSafeEqualHex(digest, sha256HexSync('key-é'))).toBe(true);
    expect(timingSafeEqualHex(digest, sha256HexSync('key-e'))).toBe(false);
    expect(timingSafeEqualHex(digest, digest.slice(0, 62))).toBe(false);
  });
});
