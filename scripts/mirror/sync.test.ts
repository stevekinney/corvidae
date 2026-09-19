import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from './packaging.ts';
import { planSurface } from './surface.ts';
import {
  assertBuildInputsPresent,
  assertPrivateWorkspacesCheckable,
  BuildInputError,
  cloneTarget,
  collectMissingBuildInputs,
  findForeignCommits,
  ForeignCommitError,
  git,
  provenanceTrailer,
  runSync,
  SyncError,
  type SyncResult,
} from './sync.ts';

/**
 * A fake remote, a fake corvidae, and a fake target, so the whole pipeline runs without GitHub,
 * without a registry and without publishing anything.
 *
 * The corvidae fixture uses real workspace names, because `package-map.json` and
 * `package-surface.json` are inputs under test rather than things to restate here — the sync runs
 * the same `planSurface`, the same `assertPublishable` and the same target-owned guard the real
 * targets would. The two workspaces it carries are the ones whose published surface is a single
 * root entry, which is what makes a fixture that clears `assertPublishable` honestly rather than
 * by weakening it: every exports target in their surface has real source behind it here.
 *
 * `bun install` is the one thing that reaches a registry, which is the exception the mirror work
 * is allowed. Nothing else does: git talks to a local bare repository, the registry baseline is a
 * committed fixture, and both packaging checks read a tarball off disk.
 */

const licence = 'MIT License\n\nCopyright (c) 2026 Steve Kinney\n';

/**
 * The workspaces the fixture carries, with the source each one's published surface needs.
 *
 * `source` is corvidae's and `staleSource` is what the target carried before any sync. The two
 * differ deliberately. They used to be the same constant, which made "the transform emits source"
 * unfalsifiable: the assertion passed whether the transform wrote anything or not, because the
 * bytes it would have written were already there. Divergence is what gives the assertion teeth.
 */
const fixturePackages = {
  'packages/cryptography': {
    workspace: '@corvidae/cryptography',
    publicName: '@lostgradient/cryptography',
    source: 'export const digest = (value: string): string => `sha256:${value}`;\n',
    staleSource: 'export const digest = (value: string): string => `stale:${value}`;\n',
  },
  'packages/lifecycle': {
    workspace: '@corvidae/lifecycle',
    publicName: '@lostgradient/lifecycle',
    source: 'export const phases = ["start", "stop"] as const;\n',
    staleSource: 'export const phases = ["stale"] as const;\n',
  },
} as const;

/** A target-owned file inside a source tree, which the transform must neither write nor prune. */
const targetOwnedInsideSource = 'packages/lifecycle/src/AGENTS.md';

/** A target file nobody enumerated, inside an emitted package but outside its source tree. */
const unknownTargetFile = 'packages/lifecycle/notes/handover.md';

const sharedTypeScriptConfiguration = {
  'internal/typescript/package.json': {
    name: '@corvidae/typescript',
    private: true,
    type: 'module',
    exports: { './library.json': './library.json', './browser.json': './browser.json' },
  },
  'internal/typescript/base.json': {
    compilerOptions: {
      lib: ['ESNext'],
      target: 'ES2022',
      module: 'Preserve',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      isolatedModules: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
    },
  },
  'internal/typescript/library.json': {
    extends: './base.json',
    compilerOptions: { lib: ['ESNext'], types: ['bun'] },
  },
  'internal/typescript/browser.json': {
    extends: './base.json',
    compilerOptions: { lib: ['ESNext', 'DOM'] },
  },
} as const;

/**
 * A workspace that ships to the mirror and never to the registry.
 *
 * `@corvidae/testing` is the real map's clearest private workspace, and it is here because a
 * private workspace is the one class the packaging checks say nothing about: nothing packs it, so
 * `typecheck` in the target is the only thing that reads the source the mirror now publishes for
 * it. Without one in the fixture that path would never run.
 */
const privateWorkspaceDirectory = 'packages/testing';

function corvidaeFixture(): Record<string, unknown> {
  const files: Record<string, unknown> = {
    LICENSE: licence,
    'package.json': {
      name: 'corvidae',
      private: true,
      type: 'module',
      license: 'MIT',
      author: 'Steve Kinney <hello@stevekinney.net>',
      workspaces: ['applications/*', 'components/*', 'packages/*', 'internal/*'],
      catalog: { '@types/bun': '^1.4.2', typescript: '5.9.3' },
      packageManager: 'bun@1.4.2',
      engines: { bun: '>=1.4.2' },
    },
    ...sharedTypeScriptConfiguration,
  };
  files[`${privateWorkspaceDirectory}/package.json`] = {
    name: '@corvidae/testing',
    private: true,
    type: 'module',
    exports: { '.': './src/index.ts' },
    scripts: { typecheck: 'tsc --noEmit' },
    devDependencies: {
      '@corvidae/typescript': 'workspace:*',
      '@types/bun': 'catalog:',
      typescript: 'catalog:',
    },
  };
  files[`${privateWorkspaceDirectory}/tsconfig.json`] = {
    extends: '@corvidae/typescript/library.json',
    include: ['src'],
    exclude: ['node_modules', 'dist'],
  };
  files[`${privateWorkspaceDirectory}/src/index.ts`] =
    'export const harness = (name: string): string => `harness:${name}`;\n';
  for (const [directory, entry] of Object.entries(fixturePackages)) {
    files[`${directory}/package.json`] = {
      name: entry.workspace,
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      scripts: { typecheck: 'tsc --noEmit' },
      devDependencies: {
        '@corvidae/typescript': 'workspace:*',
        '@types/bun': 'catalog:',
        typescript: 'catalog:',
      },
    };
    files[`${directory}/tsconfig.json`] = {
      extends: '@corvidae/typescript/library.json',
      include: ['src'],
      exclude: ['node_modules', 'dist'],
    };
    files[`${directory}/src/index.ts`] = entry.source;
  }
  return files;
}

/**
 * `tsdown` needs a configuration that emits both halves of a dual-format package under the exact
 * names the published `exports` map promises: `.js` and `.d.ts` for the ESM half, `.cjs` and
 * `.d.cts` for the CommonJS one. Its defaults disambiguate with `.mjs` instead, which would
 * publish a map pointing at files the build never wrote.
 */
const tsdownConfiguration = `import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  fixedExtension: false,
  outExtensions: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
    dts: format === 'cjs' ? '.d.cts' : '.d.ts',
  }),
});
`;

/**
 * The target repository as it exists before any sync.
 *
 * It carries the target-owned front matter (`README.md`, `LICENSE`, `.gitignore`) and the build
 * inputs `package-surface.json` records as `requiredInputs`, neither of which the transform
 * writes, plus a stale copy of each package's source, which it does. The stale copy is the point:
 * corvidae is the source of truth, so a sync overwrites it, and the two files below — one
 * target-owned inside a source tree, one unknown outside it — are what say the overwrite stops
 * where it should.
 */
function targetFixture(): Record<string, unknown> {
  const files: Record<string, unknown> = {
    'README.md': '# cinder-workspace\n\nTarget-authored front page.\n',
    LICENSE: licence,
    // Only `node_modules` is ignored, deliberately. The build's `dist/` and any
    // `tsconfig.tsbuildinfo` are left visible to git so that a sync which staged after building
    // would sweep them into the mirror and fail the assertion below, rather than being hidden by
    // a fixture that happens to ignore more than a real target might.
    '.gitignore': 'node_modules\n',
    [targetOwnedInsideSource]: '# Agent instructions the target wrote for itself\n',
    [unknownTargetFile]: '# A working document nobody enumerated\n',
  };
  for (const [directory, entry] of Object.entries(fixturePackages)) {
    files[`${directory}/tsdown.config.ts`] = tsdownConfiguration;
    files[`${directory}/README.md`] = `# ${entry.publicName}\n`;
    files[`${directory}/src/index.ts`] = entry.staleSource;
  }
  return files;
}

async function writeTree(root: string, files: Record<string, unknown>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await Bun.write(
      join(root, path),
      typeof contents === 'string' ? contents : `${JSON.stringify(contents, undefined, 2)}\n`,
    );
  }
}

interface Harness {
  /** The bare repository standing in for the public mirror. */
  remote: string;
  corvidae: string;
  scratch: string;
  /** A fresh clone directory for each run, since a sync never reuses one. */
  runDirectory: (label: string) => string;
}

/** Stand up the remote, seed it with the target, and build the corvidae tree beside it. */
async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-sync-'));
  try {
    const remote = join(root, 'remote.git');
    await mkdir(remote, { recursive: true });
    await git(remote, 'init', '--bare', '--quiet', '--initial-branch=main');

    const seed = join(root, 'seed');
    await mkdir(seed, { recursive: true });
    await git(seed, 'clone', '--quiet', remote, seed);
    await writeTree(seed, targetFixture());
    await git(seed, 'add', '--all');
    await git(seed, 'commit', '--quiet', '--message', 'Target repository before any sync');
    await git(seed, 'push', '--quiet', 'origin', 'HEAD:main');

    const corvidae = join(root, 'corvidae');
    await writeTree(corvidae, corvidaeFixture());

    await body({
      remote,
      corvidae,
      scratch: join(root, 'scratch'),
      runDirectory: (label: string) => join(root, `run-${label}`),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function sync(harness: Harness, label: string): Promise<SyncResult> {
  return runSync({
    corvidaeRoot: harness.corvidae,
    target: 'cinder',
    remote: harness.remote,
    directory: harness.runDirectory(label),
    scratchDirectory: join(harness.scratch, label),
    corvidaeCommit: `corvidae-${label}`,
  });
}

/**
 * One budget for the whole end-to-end pass, declared rather than discovered: a run clones,
 * installs twice, builds and type-checks two packages, packs them, runs `publint` and `attw` over
 * each tarball, and then installs and imports both from a scratch consumer — and this test does
 * that twice, to prove the second run is a skip.
 */
const endToEndTimeout = 300_000;

describe('the mirror sync against a fake remote', () => {
  test(
    'transforms, verifies, pushes, and then reports skip on an identical second run',
    async () => {
      await withHarness(async (harness) => {
        const first = await sync(harness, 'first');

        expect(first.decision).toBe('pushed');
        expect(first.changed.length).toBeGreaterThan(0);
        // `firstPublish` is every manifest emitted at 0.0.0, which includes the private
        // configuration workspace. Nothing publishes that one, so the name reads wider than what
        // it reports; pinned as observed rather than quietly filtered here.
        expect(first.firstPublish.toSorted()).toEqual([
          '@lostgradient/cryptography',
          '@lostgradient/lifecycle',
          '@lostgradient/testing',
          '@lostgradient/typescript',
        ]);
        // The private workspace is type-checked in the target even though nothing packs it: its
        // source ships now, and `typecheck` is the only check that reads it.
        expect(first.verification.privateTypechecks).toEqual(['@lostgradient/testing']);
        expect(
          await readFile(join(first.directory, privateWorkspaceDirectory, 'src/index.ts'), 'utf8'),
        ).toContain('harness:');
        expect(first.verification.reports.map((report) => report.publicName).toSorted()).toEqual([
          '@lostgradient/cryptography',
          '@lostgradient/lifecycle',
        ]);
        for (const report of first.verification.reports) {
          expect(report.publint.exitCode, `publint for ${report.publicName}`).toBe(0);
          expect(report.typeResolution.exitCode, `attw for ${report.publicName}`).toBe(0);
        }
        expect(first.verification.smokeTest.specifiers).toEqual([
          '@lostgradient/cryptography',
          '@lostgradient/lifecycle',
        ]);

        // Corvidae's source reached the target, read off the clone rather than out of the plan:
        // a plan key proves what the transform intended, and a file on disk proves what landed.
        // The fixture's target seeded different bytes at each of these paths, so an assertion
        // that passes here cannot be passing because the two happened to agree.
        for (const [directory, entry] of Object.entries(fixturePackages)) {
          const emitted = await readFile(join(first.directory, directory, 'src/index.ts'), 'utf8');
          expect(emitted, `${entry.publicName} source`).toBe(entry.source);
          expect(emitted).not.toBe(entry.staleSource);
        }

        // The commit holds transform output only. Build output exists in the clone by now and is
        // not ignored, so anything swept in would show up here.
        const committed = await git(harness.remote, 'show', '--format=', '--name-only', 'HEAD');
        expect(committed).toContain('packages/cryptography/package.json');
        expect(committed.split('\n').filter((path) => path.includes('dist/'))).toEqual([]);
        expect(committed.split('\n').filter((path) => path.includes('tsbuildinfo'))).toEqual([]);

        // The push carried the provenance trailer, and it names the corvidae commit rather than
        // being used as the change-detection record.
        const pushed = await git(harness.remote, 'log', '-1', '--format=%B');
        expect(pushed).toContain(`${provenanceTrailer}: corvidae-first`);

        // The divergence the first run consumed is why this one is a skip: the target now holds
        // corvidae's bytes, so the second run re-emits what is already there. The skip is a
        // statement about the run after the source landed, not about a target that never moved.
        const second = await sync(harness, 'second');
        expect(second.decision).toBe('skip');
        // `changed` is `git status --porcelain` read at the moment the decision is made, which is
        // after the transform and the lockfile install and before anything is built. Empty here
        // is the skip.
        expect(second.changed).toEqual([]);

        // Reading status again at the end shows build output, because this fixture deliberately
        // does not ignore `dist/`. That the two readings differ is the point: nothing the build
        // produces can reach the decision, and nothing but build output appeared.
        const afterVerification = await git(second.directory, 'status', '--porcelain');
        expect(
          afterVerification
            .split('\n')
            .filter((line) => line.length > 0 && !line.includes('dist/')),
        ).toEqual([]);
        // Nothing new landed on the remote, so the skip really skipped.
        const commitCount = await git(harness.remote, 'rev-list', '--count', 'main');
        expect(commitCount.trim()).toBe('2');
      });
    },
    endToEndTimeout,
  );

  test(
    'a real change is still detected, so the skip above is not vacuous',
    async () => {
      await withHarness(async (harness) => {
        await sync(harness, 'first');
        await Bun.write(
          join(harness.corvidae, 'packages/cryptography/package.json'),
          `${JSON.stringify(
            {
              name: '@corvidae/cryptography',
              private: true,
              type: 'module',
              description: 'A description the first sync did not carry',
              exports: { '.': './src/index.ts' },
              scripts: { typecheck: 'tsc --noEmit' },
              devDependencies: {
                '@corvidae/typescript': 'workspace:*',
                '@types/bun': 'catalog:',
                typescript: 'catalog:',
              },
            },
            undefined,
            2,
          )}\n`,
        );

        const second = await sync(harness, 'second');
        expect(second.decision).toBe('pushed');
        expect(second.changed.join('\n')).toContain('packages/cryptography/package.json');
      });
    },
    endToEndTimeout,
  );
});

describe('the foreign-commit guard', () => {
  test(
    'a commit the mirror did not author stops the sync and is named',
    async () => {
      await withHarness(async (harness) => {
        await sync(harness, 'first');

        const intruder = harness.runDirectory('intruder');
        await mkdir(intruder, { recursive: true });
        await git(intruder, 'clone', '--quiet', harness.remote, intruder);
        await Bun.write(
          join(intruder, 'packages/lifecycle/src/index.ts'),
          'export const phases = [];\n',
        );
        await git(intruder, 'add', '--all');
        await git(
          intruder,
          'commit',
          '--quiet',
          '--message',
          'Hand edit made straight on the mirror',
        );
        await git(intruder, 'push', '--quiet', 'origin', 'HEAD:main');
        const intruderHead = await git(intruder, 'rev-parse', 'HEAD');
        const foreignSha = intruderHead.trim();

        let thrown: unknown;
        try {
          await sync(harness, 'after-intrusion');
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ForeignCommitError);
        expect((thrown as ForeignCommitError).commits.map((commit) => commit.sha)).toEqual([
          foreignSha,
        ]);
        expect((thrown as Error).message).toContain(foreignSha);
        expect((thrown as Error).message).toContain('Hand edit made straight on the mirror');

        // The same refusal through the command line, judged by exit code rather than by reading
        // the output for an error string: the output carries ANSI escapes, so a grep would
        // report a false green against text that plainly says it failed.
        const command = await runCommand(
          [
            'bun',
            new URL('./sync.ts', import.meta.url).pathname,
            '--target',
            'cinder',
            '--corvidae-root',
            harness.corvidae,
            '--remote',
            harness.remote,
            '--directory',
            harness.runDirectory('cli'),
            '--scratch',
            join(harness.scratch, 'cli'),
            '--corvidae-commit',
            'corvidae-cli',
          ],
          { cwd: harness.corvidae },
        );
        expect(command.exitCode).not.toBe(0);
        expect(command.stderr).toContain(foreignSha);
      });
    },
    endToEndTimeout,
  );

  test('a target the mirror has never written is a first sync, not a wall of foreign commits', async () => {
    await withHarness(async (harness) => {
      const clone = await cloneTarget({
        remote: harness.remote,
        directory: harness.runDirectory('inspect'),
      });
      // The seed commit predates every sync, so it must not read as somebody else's edit.
      expect(await findForeignCommits(clone)).toEqual([]);
    });
  }, 60_000);
});

describe('the build-input check', () => {
  test('a clone missing a required build input fails the sync and names the file', async () => {
    await withHarness(async (harness) => {
      const clone = await cloneTarget({
        remote: harness.remote,
        directory: harness.runDirectory('no-build-input'),
      });
      await rm(join(clone, 'packages/cryptography/tsdown.config.ts'));

      const plan = await planSurface({
        corvidaeRoot: harness.corvidae,
        target: 'cinder',
        targetDirectory: clone,
      });
      expect(collectMissingBuildInputs(clone, plan.published)).toEqual([
        '@lostgradient/cryptography: packages/cryptography/tsdown.config.ts',
      ]);
      expect(() => assertBuildInputsPresent(clone, plan.published)).toThrow(BuildInputError);
    });
  }, 60_000);

  test('the transform emits source, and the build inputs it does not emit stay target-owned', async () => {
    // The replacement for COR-1188's pin that the transform emitted no source at all. What the
    // build reads is now two classes rather than one: corvidae's `src/`, which the transform
    // writes, and the target's `requiredInputs`, which it never writes and never prunes.
    await withHarness(async (harness) => {
      const plan = await planSurface({ corvidaeRoot: harness.corvidae, target: 'cinder' });
      const sourcePaths = Object.keys(plan.files).filter((path) => path.includes('/src/'));
      expect(sourcePaths.toSorted()).toEqual([
        'packages/cryptography/src/index.ts',
        'packages/lifecycle/src/index.ts',
        `${privateWorkspaceDirectory}/src/index.ts`,
      ]);
      expect(Object.keys(plan.files).filter((path) => path.endsWith('tsdown.config.ts'))).toEqual(
        [],
      );
    });
  }, 60_000);
});

describe('pruning what corvidae no longer carries', () => {
  test(
    'a dropped source file is deleted, while a target-owned path and an unknown path survive',
    async () => {
      await withHarness(async (harness) => {
        const dropped = 'packages/lifecycle/src/deprecated.ts';
        await Bun.write(
          join(harness.corvidae, dropped),
          'export const retired = ["drain"] as const;\n',
        );
        const first = await sync(harness, 'first');
        expect(first.decision).toBe('pushed');
        expect(await Bun.file(join(first.directory, dropped)).exists()).toBe(true);

        await rm(join(harness.corvidae, dropped));
        const second = await sync(harness, 'second');

        expect(second.decision).toBe('pushed');
        // Read off the clone: the file corvidae dropped is gone from the target's working tree.
        expect(await Bun.file(join(second.directory, dropped)).exists()).toBe(false);
        // A target-owned path inside a source tree the transform owns, and a path nobody
        // enumerated outside it. Neither is the transform's to remove, whatever corvidae holds.
        expect(await Bun.file(join(second.directory, targetOwnedInsideSource)).exists()).toBe(true);
        expect(await Bun.file(join(second.directory, unknownTargetFile)).exists()).toBe(true);

        // The deletion is staged and committed rather than left in the working tree: `runSync`
        // stages with `git add --all` after reading the porcelain, which is the only form that
        // carries a removal. The pushed commit is what proves it did.
        const removed = await git(
          harness.remote,
          'show',
          '--format=',
          '--name-only',
          '--diff-filter=D',
          'HEAD',
        );
        expect(removed.split('\n').filter((path) => path.length > 0)).toEqual([dropped]);
        const tracked = await git(harness.remote, 'ls-tree', '-r', '--name-only', 'HEAD');
        expect(tracked).toContain(targetOwnedInsideSource);
        expect(tracked).toContain(unknownTargetFile);
        expect(tracked).not.toContain(dropped);
      });
    },
    endToEndTimeout,
  );
});

describe('the private-workspace check', () => {
  test('a private workspace that emits TypeScript without a typecheck script is refused', () => {
    expect(() =>
      assertPrivateWorkspacesCheckable([
        {
          workspace: '@corvidae/testing',
          directory: 'packages/testing',
          publicName: '@lostgradient/testing',
          typechecks: false,
          emitsTypeScript: true,
        },
      ]),
    ).toThrow(SyncError);
  });

  test('a workspace with no TypeScript to check is not the same failure', () => {
    expect(() =>
      assertPrivateWorkspacesCheckable([
        {
          workspace: '@corvidae/typescript',
          directory: 'internal/typescript',
          publicName: '@lostgradient/typescript',
          typechecks: false,
          emitsTypeScript: false,
        },
      ]),
    ).not.toThrow();
  });
});
