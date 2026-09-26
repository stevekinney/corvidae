import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { committedPlans, corvidaeRoot, packageMapForFixtures } from './committed-plans.ts';
import { mirrorTargets, type MirrorTarget } from './manifests.ts';
import { loadPackageMap, type PackageMap } from './package-map.ts';
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
  test('reads src/, minus tests and fixtures — no README, no LICENSE', async () => {
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
          workspace: '@lostgradient/example',
        });
        expect(files.map((file) => file.path)).toEqual(['src/index.ts']);
      },
    );
  });

  /**
   * COR-1196 round 11: a package's README and the repository's LICENSE are documentation, not
   * code a consumer imports, and were dropped from the digest's scope after including them made
   * an unrelated docs edit refuse every cross-target edge to a package that had not actually
   * changed. `@lostgradient/weft` declares `README.md` in `additionalSourceRoots` (round 11
   * restored that declaration alongside dropping README from this scope), so this proves the
   * exclusion is unconditional — by path, not by whether something declares it.
   */
  test('a workspace’s declared README.md never counts, even though additionalSourceRoots names it', async () => {
    await withTree(
      {
        'packages/weft/src/index.ts': 'export const weft = true;\n',
        'packages/weft/README.md': '# Weft\n',
      },
      async (root) => {
        const files = await collectDigestedFiles({
          corvidaeRoot: root,
          corvidaeDirectory: 'packages/weft',
          workspace: '@lostgradient/weft',
        });
        // Every other `additionalSourceRoots['@lostgradient/weft']` entry — including the
        // `documentation/*.md` cluster, which `isPublishedByPackageSurface` would also filter out
        // since weft's `files` array is `["dist", "README.md", "LICENSE"]` — is missing from this
        // fixture and skipped rather than refused, so only `src/index.ts` remains.
        expect(files.map((file) => file.path)).toEqual(['src/index.ts']);
      },
    );
  });

  test('a declared file the workspace does not carry is skipped, not refused', async () => {
    await withTree(
      { 'packages/weft/src/index.ts': 'export const weft = true;\n' },
      async (root) => {
        const files = await collectDigestedFiles({
          corvidaeRoot: root,
          corvidaeDirectory: 'packages/weft',
          workspace: '@lostgradient/weft',
        });
        expect(files.map((file) => file.path)).toEqual(['src/index.ts']);
      },
    );
  });

  test('a workspace with no additionalSourceRoots entry only carries src/', async () => {
    await withTree(
      { 'packages/example/src/index.ts': 'export const example = true;\n' },
      async (root) => {
        const files = await collectDigestedFiles({
          corvidaeRoot: root,
          corvidaeDirectory: 'packages/example',
          workspace: '@lostgradient/example',
        });
        expect(files.map((file) => file.path)).toEqual(['src/index.ts']);
      },
    );
  });

  /**
   * `@lostgradient/weft` declares `documentation/guides/remote-task-recovery.md` and three sibling
   * documents in `additionalSourceRoots` because `src/worker/protocol.test.ts` reads them by
   * literal path, but weft's real `package-surface.json` entry publishes only
   * `["dist", "README.md", "LICENSE"]` — `documentation/` is not in it. A declared file real,
   * present, but not actually shipped should not make the digest sensitive to it.
   */
  test('a declared file real package-surface.json excludes from `files` does not count', async () => {
    await withTree(
      {
        'packages/weft/src/index.ts': 'export const weft = true;\n',
        'packages/weft/documentation/guides/remote-task-recovery.md': '# Recovery\n',
      },
      async (root) => {
        const files = await collectDigestedFiles({
          corvidaeRoot: root,
          corvidaeDirectory: 'packages/weft',
          workspace: '@lostgradient/weft',
        });
        expect(files.map((file) => file.path)).toEqual(['src/index.ts']);
      },
    );
  });

  /**
   * `versionConstants['@lostgradient/weft']` is `src/version.ts` — the file
   * `applyVersionConstants` rewrites to the target's composed manifest version before anything
   * publishes. Corvidae's own unrewritten copy is not what shipped, so it never counts.
   */
  test('the workspace’s versionConstants file is excluded, wherever the src/ walk finds it', async () => {
    await withTree(
      {
        'packages/weft/src/index.ts': 'export const weft = true;\n',
        'packages/weft/src/version.ts': "export const VERSION = '0.0.0';\n",
      },
      async (root) => {
        const files = await collectDigestedFiles({
          corvidaeRoot: root,
          corvidaeDirectory: 'packages/weft',
          workspace: '@lostgradient/weft',
        });
        expect(files.map((file) => file.path)).toEqual(['src/index.ts']);
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
  const scope = (root: string) => ({
    corvidaeRoot: root,
    corvidaeDirectory: 'packages/example',
    workspace: '@lostgradient/example',
  });

  test('is deterministic for the same tree', async () => {
    await withTree({ 'packages/example/src/index.ts': 'export const x = 1;\n' }, async (root) => {
      expect(await computeSourceDigest(scope(root))).toBe(await computeSourceDigest(scope(root)));
    });
  });

  test('changes when a non-excluded source file changes', async () => {
    await withTree({ 'packages/example/src/index.ts': 'export const x = 1;\n' }, async (root) => {
      const before = await computeSourceDigest(scope(root));
      await Bun.write(join(root, 'packages/example/src/index.ts'), 'export const x = 2;\n');
      expect(await computeSourceDigest(scope(root))).not.toBe(before);
    });
  });

  test('is unaffected by a test file changing', async () => {
    await withTree(
      {
        'packages/example/src/index.ts': 'export const x = 1;\n',
        'packages/example/src/index.test.ts': 'test("a", () => {});\n',
      },
      async (root) => {
        const before = await computeSourceDigest(scope(root));
        await Bun.write(
          join(root, 'packages/example/src/index.test.ts'),
          'test("a changed", () => {});\n',
        );
        expect(await computeSourceDigest(scope(root))).toBe(before);
      },
    );
  });

  test('is unaffected by README.md or LICENSE changing', async () => {
    await withTree(
      {
        LICENSE: 'MIT\n',
        'packages/example/README.md': '# Example\n',
        'packages/example/src/index.ts': 'export const x = 1;\n',
      },
      async (root) => {
        const before = await computeSourceDigest(scope(root));
        await Bun.write(join(root, 'LICENSE'), 'MIT License\n\nCopyright (c) 2027\n');
        await Bun.write(join(root, 'packages/example/README.md'), '# Example, rewritten\n');
        expect(await computeSourceDigest(scope(root))).toBe(before);
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
 * The guard against corvidae's real workspaces and real cross-target edges. These assertions hold
 * whatever is recorded in `package-map.json` today, so recording a digest never turns them red:
 * the committed file is what an override-free sync reads, and a real edge refuses exactly when its
 * dependency's recorded digest is missing or no longer matches the source.
 */
const outcome = (plan: Promise<unknown>): Promise<string> =>
  plan.then(
    () => 'planned',
    (error: unknown) => `refused: ${(error as Error).message}`,
  );

/**
 * COR-1316: each target planned twice over the real workspaces, once with no override and once
 * with the committed map, at module scope for the reason `committed-plans.ts` gives. A full weft
 * or agent-bureau plan is one to two seconds on a loaded machine, so doing both inside a test
 * body left little of bun's five-second per-test budget. The tests below compare the outcomes.
 */
const committedPackageMap = await loadPackageMap();
const readsCommittedMap = new Map<MirrorTarget, { withoutOverride: string; committed: string }>();
for (const target of mirrorTargets) {
  readsCommittedMap.set(target, {
    withoutOverride: await outcome(planSurface({ corvidaeRoot, target })),
    committed: await outcome(
      planSurface({ corvidaeRoot, target, packageMap: committedPackageMap }),
    ),
  });
}

// COR-1316: the current-digest overlay and both targets' plans are built once, at module scope,
// by `committed-plans.ts`. Rebuilding them in a test put roughly three seconds of hashing and
// planning on each test's own five-second clock, which a loaded machine pushed over the limit.
const withDigest = (workspace: string, sourceDigest: string | undefined): PackageMap => {
  const map = packageMapForFixtures;
  const entry = map.workspaces[workspace];
  if (entry?.disposition !== 'publish-as') throw new Error(`${workspace} is not published`);
  const { sourceDigest: _current, ...rest } = entry;
  const updated = sourceDigest === undefined ? rest : { ...rest, sourceDigest };
  return { ...map, workspaces: { ...map.workspaces, [workspace]: updated } };
};

/**
 * COR-1331: each real stale edge's refusals, planned here with a missing and then a zeroed
 * `sourceDigest` for its dependency. Each is a full `planSurface` for the target, and two of them
 * in a test body crossed bun's five-second per-test clock inside a loaded `test:self` run. A plan
 * that resolves instead of refusing is captured as `undefined`, which the test then rejects.
 */
const staleEdges = [
  ['agent-bureau', '@lostgradient/weft'],
  ['cinder', 'conversationalist'],
] as const;
const staleEdgeRefusals = new Map<MirrorTarget, unknown[]>();
for (const [target, dependency] of staleEdges) {
  const refusals: unknown[] = [];
  for (const packageMap of [
    withDigest(dependency, undefined),
    withDigest(dependency, '0'.repeat(64)),
  ]) {
    refusals.push(
      await planSurface({ corvidaeRoot, target, packageMap }).then(
        () => undefined,
        (error: unknown) => error,
      ),
    );
  }
  staleEdgeRefusals.set(target, refusals);
}

describe('the guard against the real workspaces', () => {
  test.each([...mirrorTargets])(
    'planSurface for %s reads the committed package-map.json when given no override',
    (target) => {
      const outcomes = readsCommittedMap.get(target);
      expect(outcomes).toBeDefined();
      expect(outcomes?.withoutOverride).toBe(outcomes?.committed);
    },
  );

  test.each(staleEdges)(
    '%s plans when %s is current and refuses when it is not',
    (target, dependency) => {
      // `committed-plans.ts` planned this target from the current-digest map at import, and a
      // refusal there would have failed the whole file, so a present plan is the planned outcome.
      expect(Object.keys(committedPlans[target].plan.files).length).toBeGreaterThan(0);
      const refusals = staleEdgeRefusals.get(target);
      expect(refusals).toHaveLength(2);
      for (const refusal of refusals ?? []) {
        expect(refusal).toBeInstanceOf(StaleCrossTargetEdgeError);
        expect((refusal as Error).message).toContain(dependency);
      }
    },
  );
});
