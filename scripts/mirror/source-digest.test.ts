import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { corvidaeRoot } from './committed-plans.ts';
import { mirrorTargets } from './manifests.ts';
import {
  assertEdgeNotStale,
  collectDigestedFiles,
  computeSourceDigest,
  hashDigestedFiles,
  isDigestExcluded,
  StaleCrossTargetEdgeError,
} from './source-digest.ts';
import { planSurface } from './surface.ts';

/** Stand up a throwaway tree, hand it to the body, and remove it however the body ends. */
async function withTree(
  files: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-source-digest-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(root, path), contents);
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('isDigestExcluded', () => {
  test('excludes tests, fixtures and both plural spellings', () => {
    expect(isDigestExcluded('index.test.ts')).toBe(true);
    expect(isDigestExcluded('token.fixture.ts')).toBe(true);
    expect(isDigestExcluded('token-fixture.ts')).toBe(true);
    expect(isDigestExcluded('tokens-fixtures.ts')).toBe(true);
    expect(isDigestExcluded('__fixtures__/baseline.png')).toBe(true);
    expect(isDigestExcluded('lib/test/helper.ts')).toBe(true);
    expect(isDigestExcluded('lib/tests/helper.ts')).toBe(true);
  });

  test('does not exclude ordinary source', () => {
    expect(isDigestExcluded('index.ts')).toBe(false);
    expect(isDigestExcluded('lib/testimony.ts')).toBe(false);
    expect(isDigestExcluded('lib/contest/index.ts')).toBe(false);
  });
});

describe('collectDigestedFiles', () => {
  test('reads src/, minus tests and fixtures, plus README.md and the root LICENSE', async () => {
    await withTree(
      {
        LICENSE: 'MIT License\n',
        'packages/example/README.md': '# Example\n',
        'packages/example/src/index.ts': 'export const example = true;\n',
        'packages/example/src/index.test.ts': 'test();\n',
        'packages/example/src/__fixtures__/data.json': '{}\n',
      },
      async (root) => {
        const files = await collectDigestedFiles({
          corvidaeRoot: root,
          corvidaeDirectory: 'packages/example',
        });
        expect(files.map((file) => file.path).toSorted()).toEqual([
          '../LICENSE',
          'README.md',
          'src/index.ts',
        ]);
      },
    );
  });

  test('a workspace with no README.md carries no README entry', async () => {
    await withTree(
      {
        LICENSE: 'MIT License\n',
        'packages/example/src/index.ts': 'export const example = true;\n',
      },
      async (root) => {
        const files = await collectDigestedFiles({
          corvidaeRoot: root,
          corvidaeDirectory: 'packages/example',
        });
        expect(files.map((file) => file.path)).not.toContain('README.md');
      },
    );
  });
});

describe('hashDigestedFiles', () => {
  test('is independent of input order', () => {
    const a = { path: 'src/a.ts', bytes: new TextEncoder().encode('a') };
    const b = { path: 'src/b.ts', bytes: new TextEncoder().encode('b') };
    expect(hashDigestedFiles([a, b])).toBe(hashDigestedFiles([b, a]));
  });

  test('changes when a file renames with the same content', () => {
    const original = { path: 'src/a.ts', bytes: new TextEncoder().encode('same') };
    const renamed = { path: 'src/b.ts', bytes: new TextEncoder().encode('same') };
    expect(hashDigestedFiles([original])).not.toBe(hashDigestedFiles([renamed]));
  });

  test('changes when content changes with the same path', () => {
    const before = { path: 'src/a.ts', bytes: new TextEncoder().encode('before') };
    const after = { path: 'src/a.ts', bytes: new TextEncoder().encode('after') };
    expect(hashDigestedFiles([before])).not.toBe(hashDigestedFiles([after]));
  });

  test('two files cannot collide at a byte boundary with a different split', () => {
    const oneFile = [{ path: 'a', bytes: new TextEncoder().encode('xy') }];
    const twoFiles = [
      { path: 'a', bytes: new TextEncoder().encode('x') },
      { path: 'b', bytes: new TextEncoder().encode('y') },
    ];
    expect(hashDigestedFiles(oneFile)).not.toBe(hashDigestedFiles(twoFiles));
  });
});

describe('computeSourceDigest', () => {
  test('is deterministic for the same tree', async () => {
    await withTree(
      { LICENSE: 'MIT\n', 'packages/example/src/index.ts': 'export const x = 1;\n' },
      async (root) => {
        const scope = { corvidaeRoot: root, corvidaeDirectory: 'packages/example' };
        expect(await computeSourceDigest(scope)).toBe(await computeSourceDigest(scope));
      },
    );
  });

  test('changes when a non-excluded source file changes', async () => {
    await withTree(
      { LICENSE: 'MIT\n', 'packages/example/src/index.ts': 'export const x = 1;\n' },
      async (root) => {
        const scope = { corvidaeRoot: root, corvidaeDirectory: 'packages/example' };
        const before = await computeSourceDigest(scope);
        await Bun.write(join(root, 'packages/example/src/index.ts'), 'export const x = 2;\n');
        expect(await computeSourceDigest(scope)).not.toBe(before);
      },
    );
  });

  test('is unaffected by a test file changing', async () => {
    await withTree(
      {
        LICENSE: 'MIT\n',
        'packages/example/src/index.ts': 'export const x = 1;\n',
        'packages/example/src/index.test.ts': 'test("a", () => {});\n',
      },
      async (root) => {
        const scope = { corvidaeRoot: root, corvidaeDirectory: 'packages/example' };
        const before = await computeSourceDigest(scope);
        await Bun.write(
          join(root, 'packages/example/src/index.test.ts'),
          'test("a changed", () => {});\n',
        );
        expect(await computeSourceDigest(scope)).toBe(before);
      },
    );
  });
});

describe('assertEdgeNotStale', () => {
  const base = {
    workspace: '@lostgradient/example',
    publicName: '@lostgradient/example',
    version: '1.0.0',
  };

  test('passes when the recorded digest matches the current one', () => {
    expect(() =>
      assertEdgeNotStale({ ...base, recordedDigest: 'abc', currentDigest: 'abc' }),
    ).not.toThrow();
  });

  test('refuses when the recorded digest no longer matches, naming both digests and the version', () => {
    expect(() =>
      assertEdgeNotStale({ ...base, recordedDigest: 'abc', currentDigest: 'def' }),
    ).toThrow(StaleCrossTargetEdgeError);
    try {
      assertEdgeNotStale({ ...base, recordedDigest: 'abc', currentDigest: 'def' });
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('@lostgradient/example');
      expect(message).toContain('abc');
      expect(message).toContain('def');
      expect(message).toContain('1.0.0');
      expect(message).toContain('Publish @lostgradient/example from its own target first');
    }
  });

  test('refuses when no digest has ever been recorded, with a message distinct from a mismatch', () => {
    expect(() =>
      assertEdgeNotStale({ ...base, recordedDigest: undefined, currentDigest: 'def' }),
    ).toThrow(StaleCrossTargetEdgeError);
    try {
      assertEdgeNotStale({ ...base, recordedDigest: undefined, currentDigest: 'def' });
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('no recorded sourceDigest');
      expect(message).toContain('record-source-digest.ts --workspace @lostgradient/example');
    }
  });
});

/**
 * The guard fires against corvidae's real, committed `package-map.json` — not just against
 * synthetic fixtures. `committed-plans.ts` deliberately overlays a fresh digest onto every
 * `publish-as` entry so the rest of the mirror suite can build a plan without also exercising this
 * refusal; this proves the refusal is real by building the same two plans *without* that overlay,
 * against the actual unrecorded map, the way a real sync (`sync.ts`, with no override) would.
 *
 * `weft` is absent from this table on purpose: it has no cross-target dependency of its own (its
 * one internal edge, to `@lostgradient/typescript`, is a dropped private-workspace edge, never a
 * `publishedRangeFor` call), so `planSurface({ corvidaeRoot, target: 'weft' })` succeeds today
 * with no digest recorded for anything.
 */
describe('the guard against the real, unrecorded package-map.json', () => {
  test.each([...mirrorTargets].filter((target) => target !== 'weft'))(
    'planSurface for %s refuses with no packageMap override',
    async (target) => {
      await expect(planSurface({ corvidaeRoot, target })).rejects.toThrow(
        StaleCrossTargetEdgeError,
      );
    },
  );

  test('planSurface for weft succeeds with no packageMap override', async () => {
    await expect(planSurface({ corvidaeRoot, target: 'weft' })).resolves.toBeDefined();
  });
});
