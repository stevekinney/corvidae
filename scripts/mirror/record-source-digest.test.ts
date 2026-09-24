import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from './packaging.ts';
import {
  compareAgainstExtractedTarball,
  downloadTarball,
  extractTarball,
  fetchTarballUrl,
  recordSourceDigest,
  RegistryVerificationError,
} from './record-source-digest.ts';

/** Stand up a throwaway tree, hand it to the body, and remove it however the body ends. */
async function withTree(
  files: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-record-digest-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(root, path), contents);
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Build a real `.tgz` from a `package/`-rooted directory of files, the same shape `npm pack`
 * produces and this module's own `extractTarball` reads back with the real `tar` binary — a
 * fixture, not the network, per the charter's instruction.
 */
async function buildFixtureTarball(
  destination: string,
  files: Record<string, string>,
): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), 'corvidae-tarball-fixture-'));
  try {
    await mkdir(join(staging, 'package'), { recursive: true });
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(staging, 'package', path), contents);
    }
    const tarballPath = join(destination, 'fixture.tgz');
    const result = await runCommand(['tar', '-czf', tarballPath, 'package'], { cwd: staging });
    if (result.exitCode !== 0) {
      throw new Error(`failed to build fixture tarball: ${result.stdout}${result.stderr}`);
    }
    return tarballPath;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** A `fetchImplementation` that answers the registry's version-manifest shape, then a tarball. */
function stubFetch(tarballPath: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('.tgz')) {
      const bytes = await Bun.file(tarballPath).arrayBuffer();
      return new Response(bytes, { status: 200 });
    }
    return new Response(JSON.stringify({ dist: { tarball: `${url}.tgz` } }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('fetchTarballUrl', () => {
  test('reads dist.tarball off the version manifest', async () => {
    const fetchImplementation = (async () =>
      new Response(JSON.stringify({ dist: { tarball: 'https://example.test/x-1.0.0.tgz' } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const url = await fetchTarballUrl('x', '1.0.0', fetchImplementation);
    expect(url).toBe('https://example.test/x-1.0.0.tgz');
  });

  test('refuses a non-200 response', async () => {
    const fetchImplementation = (async () =>
      new Response('not found', { status: 404 })) as unknown as typeof fetch;
    await expect(fetchTarballUrl('x', '1.0.0', fetchImplementation)).rejects.toThrow(
      RegistryVerificationError,
    );
  });

  test('refuses a manifest with no dist.tarball', async () => {
    const fetchImplementation = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchTarballUrl('x', '1.0.0', fetchImplementation)).rejects.toThrow(
      'no dist.tarball',
    );
  });
});

describe('downloadTarball', () => {
  test('returns the response bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImplementation = (async () =>
      new Response(bytes, { status: 200 })) as unknown as typeof fetch;
    expect(await downloadTarball('https://example.test/x.tgz', fetchImplementation)).toEqual(bytes);
  });

  test('refuses a non-200 response', async () => {
    const fetchImplementation = (async () =>
      new Response('gone', { status: 410 })) as unknown as typeof fetch;
    await expect(
      downloadTarball('https://example.test/x.tgz', fetchImplementation),
    ).rejects.toThrow(RegistryVerificationError);
  });
});

describe('extractTarball and compareAgainstExtractedTarball', () => {
  test('extracts a real tarball and finds an exact match at the overlapping paths', async () => {
    await withTree({}, async (scratch) => {
      const tarball = await buildFixtureTarball(scratch, {
        'README.md': '# Example\n',
        LICENSE: 'MIT\n',
      });
      const extractDir = join(scratch, 'extracted');
      await Bun.write(join(extractDir, '.keep'), '');
      await extractTarball(tarball, extractDir);
      const comparison = await compareAgainstExtractedTarball(
        [
          { path: 'README.md', bytes: new TextEncoder().encode('# Example\n') },
          { path: '../LICENSE', bytes: new TextEncoder().encode('MIT\n') },
          { path: 'src/index.ts', bytes: new TextEncoder().encode('export {};\n') },
        ],
        extractDir,
      );
      expect(comparison.comparedPaths).toEqual(['../LICENSE', 'README.md']);
      expect(comparison.mismatchedPaths).toEqual([]);
    });
  });

  test('reports a mismatch when the overlapping content differs', async () => {
    await withTree({}, async (scratch) => {
      const tarball = await buildFixtureTarball(scratch, { 'README.md': '# Published\n' });
      const extractDir = join(scratch, 'extracted');
      await Bun.write(join(extractDir, '.keep'), '');
      await extractTarball(tarball, extractDir);
      const comparison = await compareAgainstExtractedTarball(
        [{ path: 'README.md', bytes: new TextEncoder().encode('# Current\n') }],
        extractDir,
      );
      expect(comparison.comparedPaths).toEqual(['README.md']);
      expect(comparison.mismatchedPaths).toEqual(['README.md']);
    });
  });

  test('a corvidae file the tarball does not carry is neither compared nor a mismatch', async () => {
    await withTree({}, async (scratch) => {
      const tarball = await buildFixtureTarball(scratch, {});
      const extractDir = join(scratch, 'extracted');
      await Bun.write(join(extractDir, '.keep'), '');
      await extractTarball(tarball, extractDir);
      const comparison = await compareAgainstExtractedTarball(
        [{ path: 'README.md', bytes: new TextEncoder().encode('# Current\n') }],
        extractDir,
      );
      expect(comparison.comparedPaths).toEqual([]);
      expect(comparison.mismatchedPaths).toEqual([]);
    });
  });

  test('refuses an unreadable tarball rather than silently extracting nothing', async () => {
    await withTree({}, async (scratch) => {
      const notATarball = join(scratch, 'not-a-tarball.tgz');
      await Bun.write(notATarball, 'this is not gzip\n');
      const extractDir = join(scratch, 'extracted');
      await Bun.write(join(extractDir, '.keep'), '');
      await expect(extractTarball(notATarball, extractDir)).rejects.toThrow(
        RegistryVerificationError,
      );
    });
  });
});

/**
 * `recordSourceDigest` end to end, against a real tarball built as a fixture (never the network,
 * per the charter). `package-map.json`'s real `@lostgradient/operative` entry is used as the
 * workspace under test — `publish-as`, a real `lastPublishedVersion` — so the only thing the test
 * stubs is the registry call; everything else (loading the map, computing the current digest from
 * this checkout's `packages/operative`) runs for real.
 */
describe('recordSourceDigest', () => {
  const corvidaeRoot = join(import.meta.dir, '..', '..');

  test('records nothing but returns the digest when the registry comparison passes', async () => {
    await withTree({}, async (scratch) => {
      const readme = await Bun.file(join(corvidaeRoot, 'packages/operative/README.md')).text();
      const licence = await Bun.file(join(corvidaeRoot, 'LICENSE')).text();
      const tarball = await buildFixtureTarball(scratch, {
        'README.md': readme,
        LICENSE: licence,
      });
      const result = await recordSourceDigest({
        corvidaeRoot,
        workspace: '@lostgradient/operative',
        fetchImplementation: stubFetch(tarball),
      });
      expect(result.workspace).toBe('@lostgradient/operative');
      expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(result.comparison.mismatchedPaths).toEqual([]);
      expect(result.comparison.comparedPaths).toEqual(['../LICENSE', 'README.md']);
    });
  });

  test('refuses on a registry mismatch, naming the mismatched file', async () => {
    await withTree({}, async (scratch) => {
      const licence = await Bun.file(join(corvidaeRoot, 'LICENSE')).text();
      const tarball = await buildFixtureTarball(scratch, {
        'README.md': '# A stale, differently-authored README\n',
        LICENSE: licence,
      });
      await expect(
        recordSourceDigest({
          corvidaeRoot,
          workspace: '@lostgradient/operative',
          fetchImplementation: stubFetch(tarball),
        }),
      ).rejects.toThrow(/README\.md does not match/);
    });
  });

  test('refuses a workspace with no entry in package-map.json', async () => {
    await expect(
      recordSourceDigest({
        corvidaeRoot,
        workspace: '@lostgradient/nonexistent',
        fetchImplementation: stubFetch('/dev/null'),
      }),
    ).rejects.toThrow('no entry in package-map.json');
  });

  test('refuses a workspace that is not publish-as', async () => {
    await expect(
      recordSourceDigest({
        corvidaeRoot,
        // Real map: `@lostgradient/weft-ui` is `private-workspace` as of COR-1196.
        workspace: '@lostgradient/weft-ui',
        fetchImplementation: stubFetch('/dev/null'),
      }),
    ).rejects.toThrow(/disposition is "private-workspace"/);
  });

  test('refuses a publish-as workspace with no lastPublishedVersion', async () => {
    await expect(
      recordSourceDigest({
        corvidaeRoot,
        // Real map: `@lostgradient/cryptography` carries `lastPublishedVersion: null`.
        workspace: '@lostgradient/cryptography',
        fetchImplementation: stubFetch('/dev/null'),
      }),
    ).rejects.toThrow('lastPublishedVersion is null');
  });
});
