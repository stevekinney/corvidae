import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { throwingRejectionOf } from '../promise-outcome.test-support.ts';
import { requireGit, verifyHistoricalCheckout } from './publication-history.ts';

const versionPath = 'packages/weft/src/version.ts';
const manifestPath = 'packages/weft/package.json';

async function commit(directory: string, message: string, mirror = false): Promise<string> {
  await requireGit(directory, ['add', '-A']);
  await requireGit(directory, [
    'commit',
    '--quiet',
    ...(mirror
      ? [
          '--author=lost-gradient-mirror-sync[bot] <331123939+lost-gradient-mirror-sync[bot]@users.noreply.github.com>',
        ]
      : []),
    '-m',
    message,
  ]);
  return requireGit(directory, ['rev-parse', 'HEAD']);
}

async function initialize(directory: string): Promise<void> {
  await requireGit(directory, ['init', '--quiet', '--initial-branch=main']);
  await requireGit(directory, ['config', 'user.email', 'fixture@example.test']);
  await requireGit(directory, ['config', 'user.name', 'Fixture']);
}

async function withVersionRelease(
  body: (fixture: {
    source: string;
    target: string;
    sourceCommit: string;
    mirrorCommit: string;
    releaseCommit: string;
  }) => Promise<void>,
  mirrorSubject = 'Sync weft from corvidae',
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'publication-version-'));
  try {
    const source = join(root, 'source');
    const target = join(root, 'target');
    await mkdir(source);
    await mkdir(target);
    await initialize(source);
    await Bun.write(
      join(source, 'scripts/mirror/source.ts'),
      "export const versionConstants = {'@lostgradient/weft': 'src/version.ts'};\n",
    );
    await Bun.write(
      join(source, 'scripts/mirror/target-owned.json'),
      await Bun.file(new URL('./target-owned.json', import.meta.url)).text(),
    );
    const sourceCommit = await commit(source, 'Historical source');

    await initialize(target);
    await Bun.write(
      join(target, manifestPath),
      '{"name":"@lostgradient/weft","version":"0.27.0"}\n',
    );
    await Bun.write(
      join(target, versionPath),
      "/** Version. */\nexport const VERSION = '0.27.0';\n",
    );
    const mirrorCommit = await commit(
      target,
      `${mirrorSubject}\n\nCorvidae-Commit: ${sourceCommit}`,
      true,
    );
    await Bun.write(
      join(target, manifestPath),
      '{"name":"@lostgradient/weft","version":"0.27.1"}\n',
    );
    await Bun.write(
      join(target, versionPath),
      "/** Version. */\nexport const VERSION = '0.27.1';\n",
    );
    const releaseCommit = await commit(target, 'Release Weft 0.27.1');
    await body({ source, target, sourceCommit, mirrorCommit, releaseCommit });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('accepts only the declared version constant matching a release manifest bump', async () => {
  await withVersionRelease(
    async ({ source, target, sourceCommit, mirrorCommit, releaseCommit }) => {
      const options = {
        sourceRoot: source,
        targetRoot: target,
        target: 'weft',
        workspace: '@lostgradient/weft',
        targetDirectory: 'packages/weft',
        mirrorCommit,
        gitHead: releaseCommit,
      };
      expect(await verifyHistoricalCheckout(options)).toBe(sourceCommit);

      await Bun.write(
        join(target, versionPath),
        "/** Version. */\nexport const VERSION = '0.27.1';\nexport const unsafe = true;\n",
      );
      const altered = await commit(target, 'Alter source beside version');
      expect(
        await throwingRejectionOf(verifyHistoricalCheckout({ ...options, gitHead: altered })),
      ).toThrow('non-target-owned path');
    },
  );
});

test('accepts the GitHub squash suffix on a verified mirror commit', async () => {
  await withVersionRelease(
    async ({ source, target, sourceCommit, mirrorCommit, releaseCommit }) => {
      expect(
        await verifyHistoricalCheckout({
          sourceRoot: source,
          targetRoot: target,
          target: 'weft',
          workspace: '@lostgradient/weft',
          targetDirectory: 'packages/weft',
          mirrorCommit,
          gitHead: releaseCommit,
        }),
      ).toBe(sourceCommit);
    },
    'Sync weft from corvidae (#649)',
  );
});

test('rejects extra text after a GitHub squash suffix', async () => {
  await withVersionRelease(async ({ source, target, mirrorCommit, releaseCommit }) => {
    expect(
      await throwingRejectionOf(
        verifyHistoricalCheckout({
          sourceRoot: source,
          targetRoot: target,
          target: 'weft',
          workspace: '@lostgradient/weft',
          targetDirectory: 'packages/weft',
          mirrorCommit,
          gitHead: releaseCommit,
        }),
      ),
    ).toThrow('unexpected sync subject or author');
  }, 'Sync weft from corvidae (#649) extra');
});

test('accepts a squash merge whose parent and tree match the App sync commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publication-squash-'));
  try {
    const source = join(root, 'source');
    const target = join(root, 'target');
    await mkdir(source);
    await mkdir(target);
    await initialize(source);
    await Bun.write(
      join(source, 'scripts/mirror/source.ts'),
      "export const versionConstants = {'@lostgradient/weft': 'src/version.ts'};\n",
    );
    await Bun.write(
      join(source, 'scripts/mirror/target-owned.json'),
      await Bun.file(new URL('./target-owned.json', import.meta.url)).text(),
    );
    const sourceCommit = await commit(source, 'Historical source');

    await initialize(target);
    await Bun.write(join(target, 'README.md'), 'Target base\n');
    const baseCommit = await commit(target, 'Target base');
    await requireGit(target, ['switch', '-c', 'mirror']);
    await Bun.write(
      join(target, manifestPath),
      '{"name":"@lostgradient/weft","version":"0.27.0"}\n',
    );
    await Bun.write(
      join(target, versionPath),
      "/** Version. */\nexport const VERSION = '0.27.0';\n",
    );
    const mirrorCommit = await commit(
      target,
      `Sync weft from corvidae\n\nCorvidae-Commit: ${sourceCommit}`,
      true,
    );
    await requireGit(target, ['switch', 'main']);
    await requireGit(target, ['checkout', mirrorCommit, '--', 'packages/weft']);
    const mergedMirrorCommit = await commit(target, 'Sync weft from corvidae (#123)');
    await Bun.write(
      join(target, manifestPath),
      '{"name":"@lostgradient/weft","version":"0.27.1"}\n',
    );
    await Bun.write(
      join(target, versionPath),
      "/** Version. */\nexport const VERSION = '0.27.1';\n",
    );
    const gitHead = await commit(target, 'Release Weft 0.27.1');
    const options = {
      sourceRoot: source,
      targetRoot: target,
      target: 'weft',
      workspace: '@lostgradient/weft',
      targetDirectory: 'packages/weft',
      mirrorCommit,
      mergedMirrorCommit,
      gitHead,
    };
    expect(await requireGit(target, ['rev-parse', `${mirrorCommit}^`])).toBe(baseCommit);
    expect(await verifyHistoricalCheckout(options)).toBe(sourceCommit);

    await requireGit(target, ['switch', '-c', 'different-tree', baseCommit]);
    await requireGit(target, ['checkout', mirrorCommit, '--', 'packages/weft']);
    await Bun.write(join(target, 'unexpected.txt'), 'Extra content\n');
    const differentTree = await commit(target, 'Sync weft from corvidae (#124)');
    expect(
      await throwingRejectionOf(
        verifyHistoricalCheckout({
          ...options,
          mergedMirrorCommit: differentTree,
          gitHead: differentTree,
        }),
      ),
    ).toThrow('Squash tree');

    await requireGit(target, ['switch', '-c', 'different-parent', baseCommit]);
    await Bun.write(join(target, 'README.md'), 'Different target base\n');
    await commit(target, 'Advance target base');
    await requireGit(target, ['checkout', mirrorCommit, '--', 'packages/weft']);
    const differentParent = await commit(target, 'Sync weft from corvidae (#125)');
    expect(
      await throwingRejectionOf(
        verifyHistoricalCheckout({
          ...options,
          mergedMirrorCommit: differentParent,
          gitHead: differentParent,
        }),
      ),
    ).toThrow('must share the App sync commit parent');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
