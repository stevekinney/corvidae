import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPackageMap } from './package-map.ts';
import { runCommand, type CommandResult, type CommandRunner } from './packaging.ts';
import {
  commitExists,
  compareAgainstCommit,
  fetchGitHead,
  recordSourceDigest,
  RegistryVerificationError,
  sourceComparisonIsClean,
} from './record-source-digest.ts';

/** Stand up a throwaway tree, hand it to the body, and remove it however the body ends. */
async function withScratch(body: (scratch: string) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'corvidae-record-digest-'));
  try {
    await body(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * A real local git repository, built with the real `git` binary rather than the network — the
 * charter's "use a fixture git repository" instruction. Returns the directory and the SHA of each
 * named commit, so a test can assert against one without parsing `git log`.
 */
async function buildFixtureRepository(
  directory: string,
  commits: readonly { files: Record<string, string>; message: string }[],
): Promise<string[]> {
  const env = {
    cwd: directory,
  };
  await runCommand(['git', 'init', '--quiet', '--initial-branch=main'], env);
  await runCommand(['git', 'config', 'user.email', 'fixture@example.test'], env);
  await runCommand(['git', 'config', 'user.name', 'Fixture'], env);
  const shas: string[] = [];
  for (const commit of commits) {
    for (const [path, contents] of Object.entries(commit.files)) {
      await Bun.write(join(directory, path), contents);
    }
    await runCommand(['git', 'add', '-A'], env);
    await runCommand(['git', 'commit', '--quiet', '-m', commit.message], env);
    const result = await runCommand(['git', 'rev-parse', 'HEAD'], env);
    shas.push(result.stdout.trim());
  }
  return shas;
}

/** A `CommandRunner` that answers `npm view <name>@<version> gitHead` with a fixed SHA (or nothing). */
function stubNpmView(gitHead: string | undefined): CommandRunner {
  return async (command): Promise<CommandResult> => ({
    command: command.join(' '),
    exitCode: 0,
    stdout: gitHead ?? '',
    stderr: '',
  });
}

describe('fetchGitHead', () => {
  test('reads the trimmed gitHead npm view prints', async () => {
    const runner: CommandRunner = async (command) => ({
      command: command.join(' '),
      exitCode: 0,
      stdout: 'b7903bc295ab332a9e555c4b710aa7140d87da79\n',
      stderr: '',
    });
    expect(await fetchGitHead('conversationalist', '1.2.0', runner)).toBe(
      'b7903bc295ab332a9e555c4b710aa7140d87da79',
    );
  });

  test('returns undefined when npm prints nothing, rather than an empty string', async () => {
    expect(await fetchGitHead('x', '1.0.0', stubNpmView(undefined))).toBeUndefined();
  });

  test('refuses a non-zero npm exit', async () => {
    const runner: CommandRunner = async (command) => ({
      command: command.join(' '),
      exitCode: 1,
      stdout: '',
      stderr: 'npm error 404',
    });
    await expect(fetchGitHead('missing', '1.0.0', runner)).rejects.toThrow(
      RegistryVerificationError,
    );
  });
});

describe('git-history readers, against a real fixture repository', () => {
  test('commitExists is true for a real commit and false for a made-up one', async () => {
    await withScratch(async (scratch) => {
      const [sha] = await buildFixtureRepository(scratch, [
        { files: { 'a.txt': 'one\n' }, message: 'first' },
      ]);
      expect(await commitExists(scratch, sha!)).toBe(true);
      expect(await commitExists(scratch, '0'.repeat(40))).toBe(false);
    });
  });
});

describe('compareAgainstCommit', () => {
  test('reports removed published additional roots without counting target-owned files', async () => {
    await withScratch(async (scratch) => {
      const [sha] = await buildFixtureRepository(scratch, [
        {
          files: {
            'packages/example/src/index.ts': 'export const x = 1;\n',
            'packages/example/components.json': '{}\n',
            'packages/example/README.md': 'Target documentation\n',
            'packages/example/scripts/release.ts': 'export {};\n',
          },
          message: 'published additional source',
        },
      ]);
      const comparison = await compareAgainstCommit(
        [{ path: 'src/index.ts', bytes: new TextEncoder().encode('export const x = 1;\n') }],
        {
          workspace: '@lostgradient/cinder',
          targetRepositoryDirectory: scratch,
          targetDirectory: 'packages/example',
          commit: sha!,
        },
      );
      expect(comparison.extraInCommit).toEqual(['components.json']);
      expect(sourceComparisonIsClean(comparison)).toBe(false);
    });
  });

  test('is clean when corvidae’s files match the commit exactly', async () => {
    await withScratch(async (scratch) => {
      const [sha] = await buildFixtureRepository(scratch, [
        { files: { 'packages/example/src/index.ts': 'export const x = 1;\n' }, message: 'first' },
      ]);
      const comparison = await compareAgainstCommit(
        [{ path: 'src/index.ts', bytes: new TextEncoder().encode('export const x = 1;\n') }],
        {
          workspace: '@example/source',
          targetRepositoryDirectory: scratch,
          targetDirectory: 'packages/example',
          commit: sha!,
        },
      );
      expect(sourceComparisonIsClean(comparison)).toBe(true);
    });
  });

  test('reports a file corvidae carries that the commit does not', async () => {
    await withScratch(async (scratch) => {
      const [sha] = await buildFixtureRepository(scratch, [
        { files: { 'packages/example/src/index.ts': 'export const x = 1;\n' }, message: 'first' },
      ]);
      const comparison = await compareAgainstCommit(
        [
          { path: 'src/index.ts', bytes: new TextEncoder().encode('export const x = 1;\n') },
          { path: 'src/new-file.ts', bytes: new TextEncoder().encode('export const y = 2;\n') },
        ],
        {
          workspace: '@example/source',
          targetRepositoryDirectory: scratch,
          targetDirectory: 'packages/example',
          commit: sha!,
        },
      );
      expect(comparison.missingInCommit).toEqual(['src/new-file.ts']);
      expect(sourceComparisonIsClean(comparison)).toBe(false);
    });
  });

  test('reports a file the commit carries that corvidae does not, under src/', async () => {
    await withScratch(async (scratch) => {
      const [sha] = await buildFixtureRepository(scratch, [
        {
          files: {
            'packages/example/src/index.ts': 'export const x = 1;\n',
            'packages/example/src/removed.ts': 'export const gone = true;\n',
          },
          message: 'first',
        },
      ]);
      const comparison = await compareAgainstCommit(
        [{ path: 'src/index.ts', bytes: new TextEncoder().encode('export const x = 1;\n') }],
        {
          workspace: '@example/source',
          targetRepositoryDirectory: scratch,
          targetDirectory: 'packages/example',
          commit: sha!,
        },
      );
      expect(comparison.extraInCommit).toEqual(['src/removed.ts']);
      expect(sourceComparisonIsClean(comparison)).toBe(false);
    });
  });

  test('a test file the commit carries under src/ is not reported as extra', async () => {
    await withScratch(async (scratch) => {
      const [sha] = await buildFixtureRepository(scratch, [
        {
          files: {
            'packages/example/src/index.ts': 'export const x = 1;\n',
            'packages/example/src/index.test.ts': 'test();\n',
          },
          message: 'first',
        },
      ]);
      const comparison = await compareAgainstCommit(
        [{ path: 'src/index.ts', bytes: new TextEncoder().encode('export const x = 1;\n') }],
        {
          workspace: '@example/source',
          targetRepositoryDirectory: scratch,
          targetDirectory: 'packages/example',
          commit: sha!,
        },
      );
      expect(comparison.extraInCommit).toEqual([]);
    });
  });

  /**
   * `recordSourceDigest` passes `versionConstants[workspace]` here so that a file
   * `applyVersionConstants` rewrites at publish time — present in the commit, deliberately
   * excluded from `collectDigestedFiles`'s scope — is not reported as a removed file. Without
   * `excludedFromExtra`, this is exactly what made `@lostgradient/weft`'s own `src/version.ts`
   * refuse a digest that should have recorded cleanly.
   */
  test('excludedFromExtra keeps a version-rewritten file out of extraInCommit', async () => {
    await withScratch(async (scratch) => {
      const [sha] = await buildFixtureRepository(scratch, [
        {
          files: {
            'packages/example/src/index.ts': 'export const x = 1;\n',
            'packages/example/src/version.ts': "export const VERSION = '1.2.3';\n",
          },
          message: 'first',
        },
      ]);
      const withoutExclusion = await compareAgainstCommit(
        [{ path: 'src/index.ts', bytes: new TextEncoder().encode('export const x = 1;\n') }],
        {
          workspace: '@example/source',
          targetRepositoryDirectory: scratch,
          targetDirectory: 'packages/example',
          commit: sha!,
        },
      );
      expect(withoutExclusion.extraInCommit).toEqual(['src/version.ts']);

      const withExclusion = await compareAgainstCommit(
        [{ path: 'src/index.ts', bytes: new TextEncoder().encode('export const x = 1;\n') }],
        {
          workspace: '@example/source',
          targetRepositoryDirectory: scratch,
          targetDirectory: 'packages/example',
          commit: sha!,
          excludedFromExtra: new Set(['src/version.ts']),
        },
      );
      expect(withExclusion.extraInCommit).toEqual([]);
      expect(sourceComparisonIsClean(withExclusion)).toBe(true);
    });
  });

  test('reports differing content by path', async () => {
    await withScratch(async (scratch) => {
      const [sha] = await buildFixtureRepository(scratch, [
        { files: { 'packages/example/src/index.ts': 'export const x = 1;\n' }, message: 'first' },
      ]);
      const comparison = await compareAgainstCommit(
        [{ path: 'src/index.ts', bytes: new TextEncoder().encode('export const x = 2;\n') }],
        {
          workspace: '@example/source',
          targetRepositoryDirectory: scratch,
          targetDirectory: 'packages/example',
          commit: sha!,
        },
      );
      expect(comparison.differing).toEqual(['src/index.ts']);
    });
  });
});

/**
 * `recordSourceDigest` end to end, against a real fixture git repository and a stubbed `npm view`
 * — never the network. `package-map.json`'s real `@lostgradient/operative` entry is the workspace
 * under test (`publish-as`, a real `lastPublishedVersion`), so only the registry lookup and the
 * target repository are fixtures; `collectDigestedFiles` reads this checkout's actual
 * `packages/operative/src` for real.
 */
describe('recordSourceDigest', () => {
  const corvidaeRoot = join(import.meta.dir, '..', '..');

  test('records nothing but returns the digest when corvidae’s source matches the published commit exactly', async () => {
    await withScratch(async (scratch) => {
      const { readdir } = await import('node:fs/promises');
      const files: Record<string, string> = {};
      for (const entry of await readdir(join(corvidaeRoot, 'packages/operative/src'), {
        withFileTypes: true,
        recursive: true,
      })) {
        if (!entry.isFile()) continue;
        const relative = join(entry.parentPath, entry.name).slice(
          join(corvidaeRoot, 'packages/operative').length + 1,
        );
        files[`packages/operative/${relative}`] = await Bun.file(
          join(entry.parentPath, entry.name),
        ).text();
      }
      const [sha] = await buildFixtureRepository(scratch, [{ files, message: 'mirrors corvidae' }]);

      const result = await recordSourceDigest({
        corvidaeRoot,
        workspace: '@lostgradient/operative',
        targetRepositoryDirectory: scratch,
        npmRunner: stubNpmView(sha),
      });
      expect(result.workspace).toBe('@lostgradient/operative');
      expect(result.gitHead).toBe(sha!);
      expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    });
  }, 30_000);

  test('refuses when corvidae’s source differs from the published commit, naming the file', async () => {
    await withScratch(async (scratch) => {
      const [sha] = await buildFixtureRepository(scratch, [
        {
          files: { 'packages/operative/src/index.ts': 'export const stale = true;\n' },
          message: 'stale',
        },
      ]);
      await expect(
        recordSourceDigest({
          corvidaeRoot,
          workspace: '@lostgradient/operative',
          targetRepositoryDirectory: scratch,
          npmRunner: stubNpmView(sha),
        }),
      ).rejects.toThrow(/does not match/);
    });
  });

  test('refuses when the registry has no gitHead for the version', async () => {
    await withScratch(async (scratch) => {
      await buildFixtureRepository(scratch, [{ files: { 'x.txt': 'x\n' }, message: 'first' }]);
      await expect(
        recordSourceDigest({
          corvidaeRoot,
          workspace: '@lostgradient/operative',
          targetRepositoryDirectory: scratch,
          npmRunner: stubNpmView(undefined),
        }),
      ).rejects.toThrow('no recorded gitHead');
    });
  });

  test('refuses when the gitHead commit is not in the target repository’s history', async () => {
    await withScratch(async (scratch) => {
      await buildFixtureRepository(scratch, [{ files: { 'x.txt': 'x\n' }, message: 'first' }]);
      await expect(
        recordSourceDigest({
          corvidaeRoot,
          workspace: '@lostgradient/operative',
          targetRepositoryDirectory: scratch,
          npmRunner: stubNpmView('0'.repeat(40)),
        }),
      ).rejects.toThrow(/is not in .* history/);
    });
  });

  test('refuses a workspace with no entry in package-map.json', async () => {
    await withScratch(async (scratch) => {
      await buildFixtureRepository(scratch, [{ files: { 'x.txt': 'x\n' }, message: 'first' }]);
      await expect(
        recordSourceDigest({
          corvidaeRoot,
          workspace: '@lostgradient/nonexistent',
          targetRepositoryDirectory: scratch,
          npmRunner: stubNpmView(undefined),
        }),
      ).rejects.toThrow('no entry in package-map.json');
    });
  });

  test('refuses a workspace that is not publish-as', async () => {
    await withScratch(async (scratch) => {
      await buildFixtureRepository(scratch, [{ files: { 'x.txt': 'x\n' }, message: 'first' }]);
      await expect(
        recordSourceDigest({
          corvidaeRoot,
          // Real map: `@lostgradient/weft-ui` is `private-workspace` as of COR-1196.
          workspace: '@lostgradient/weft-ui',
          targetRepositoryDirectory: scratch,
          npmRunner: stubNpmView(undefined),
        }),
      ).rejects.toThrow(/disposition is "private-workspace"/);
    });
  });

  test('refuses a publish-as workspace with no lastPublishedVersion', async () => {
    await withScratch(async (scratch) => {
      await buildFixtureRepository(scratch, [{ files: { 'x.txt': 'x\n' }, message: 'first' }]);
      // Every publish-as entry in the real map now records a lastPublishedVersion (COR-1198), so
      // this forces one back to null on an overridden map rather than pinning the assertion to
      // whichever real workspace happens to be unpublished today.
      const map = await loadPackageMap();
      const entry = map.workspaces['@lostgradient/operative'];
      if (entry?.disposition !== 'publish-as') {
        throw new Error('package-map.json must record @lostgradient/operative as publish-as');
      }
      await expect(
        recordSourceDigest({
          corvidaeRoot,
          workspace: '@lostgradient/operative',
          targetRepositoryDirectory: scratch,
          npmRunner: stubNpmView(undefined),
          packageMap: {
            ...map,
            workspaces: {
              ...map.workspaces,
              '@lostgradient/operative': { ...entry, lastPublishedVersion: null },
            },
          },
        }),
      ).rejects.toThrow('lastPublishedVersion is null');
    });
  });
});
