import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { outcomeOf, rethrow } from '../module-scope-scenario.test-support.ts';
import { throwingRejectionOf } from '../promise-outcome.test-support.ts';
import { singleEntryPolicyDocuments } from './policy-documents.test-support.ts';
import {
  preparedSyncManifestFile,
  verifyPreparedSyncArtifact,
  writePreparedSyncArtifact,
} from './prepared-sync.ts';
import { git, provenanceTrailer, stageSurface, type SyncResult } from './sync.ts';
import { verifyTrustedPreparedTree } from './trusted-prepared-tree.ts';

const target = 'cinder' as const;
/** `sync.test.ts`'s header says why markdown carries a fixture surface here. */
const policyDocuments = await singleEntryPolicyDocuments(['@lostgradient/markdown']);
const licence = 'MIT License\n\nCopyright (c) 2026 Steve Kinney\n';
const source = 'export const digest = (value: string): string => `sha256:${value}`;\n';
const staleSource = 'export const digest = (value: string): string => `stale:${value}`;\n';
const maliciousSource = 'export const digest = (value: string): string => `pwned:${value}`;\n';

const verification = {
  reports: [],
  smokeTest: { directory: '', specifiers: [] },
  privateTypechecks: [],
  installParity: { command: 'bun install --frozen-lockfile', checkedAgainst: ['release.yaml'] },
};

const fixtureBunLock = [
  '{',
  '  "lockfileVersion": 1,',
  '  "packages": {',
  '    "publint": ["publint@0.3.24", "", {}, "sha512-fixture-publint"],',
  '    "@arethetypeswrong/cli": ["@arethetypeswrong/cli@0.18.5", "", {}, "sha512-fixture-attw"]',
  '  }',
  '}',
  '',
].join('\n');

const fixtureReleaseWorkflow = [
  'name: release',
  'on:',
  '  push:',
  "    tags: ['v*.*.*']",
  'jobs:',
  '  publish:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - uses: oven-sh/setup-bun@v1',
  '        with:',
  '          bun-version: 1.4.2',
  '      - run: bun install --frozen-lockfile',
  '',
].join('\n');

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

function corvidaeFixture(): Record<string, unknown> {
  return {
    LICENSE: licence,
    'bun.lock': fixtureBunLock,
    'package.json': {
      name: 'corvidae',
      private: true,
      type: 'module',
      license: 'MIT',
      author: 'Steve Kinney <hello@stevekinney.net>',
      workspaces: ['packages/*', 'internal/*'],
      catalog: { '@types/bun': '^1.4.2', typescript: '5.9.3' },
      packageManager: 'bun@1.4.2',
      engines: { bun: '>=1.4.2' },
    },
    'internal/typescript/package.json': {
      name: '@lostgradient/typescript',
      private: true,
      type: 'module',
      exports: { './library.json': './library.json', './browser.json': './browser.json' },
    },
    'internal/typescript/base.json': { compilerOptions: { strict: true } },
    'internal/typescript/library.json': {
      extends: './base.json',
      compilerOptions: { types: ['bun'] },
    },
    'internal/typescript/browser.json': { extends: './base.json' },
    'packages/markdown/package.json': {
      name: '@lostgradient/markdown',
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      scripts: { typecheck: 'tsc --noEmit' },
      devDependencies: {
        '@lostgradient/typescript': 'workspace:*',
        '@types/bun': 'catalog:',
        typescript: 'catalog:',
      },
    },
    'packages/markdown/tsconfig.json': {
      extends: '@lostgradient/typescript/library.json',
      include: ['src'],
    },
    'packages/markdown/src/index.ts': source,
  };
}

function targetFixture(marker?: string): Record<string, unknown> {
  return {
    'README.md': '# cinder\n',
    LICENSE: licence,
    '.gitignore': 'node_modules\n',
    '.github/workflows/release.yaml': fixtureReleaseWorkflow,
    ...(marker === undefined
      ? {}
      : {
          'packages/markdown/package.json': {
            name: '@lostgradient/markdown',
            version: '0.1.0',
            type: 'module',
            scripts: { preinstall: 'bun ./scripts/preinstall.ts' },
          },
          'packages/markdown/scripts/preinstall.ts': `await Bun.write(${JSON.stringify(marker)}, 'ran');\n`,
        }),
    'packages/markdown/tsdown.config.ts': tsdownConfiguration,
    'packages/markdown/README.md': '# @lostgradient/markdown\n',
    'packages/markdown/src/index.ts': staleSource,
  };
}

async function writeTree(root: string, files: Record<string, unknown>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await Bun.write(
      join(root, path),
      typeof contents === 'string' ? contents : `${JSON.stringify(contents, undefined, 2)}\n`,
    );
  }
}

async function commitAll(directory: string, message: string): Promise<string> {
  await git(directory, 'add', '--all');
  await git(directory, 'commit', '--quiet', '--message', message);
  const head = await git(directory, 'rev-parse', 'HEAD');
  return head.trim();
}

interface Harness {
  root: string;
  remote: string;
  corvidae: string;
  corvidaeCommit: string;
  baseCommit: string;
}

async function trustedHarness(marker?: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'mirror-trusted-tree-test-'));
  const remote = join(root, 'remote.git');
  await mkdir(remote, { recursive: true });
  await git(remote, 'init', '--bare', '--quiet', '--initial-branch=main');

  const seed = join(root, 'seed');
  await git(root, 'clone', '--quiet', remote, seed);
  await writeTree(seed, targetFixture(marker));
  const baseCommit = await commitAll(seed, 'Target repository before sync');
  await git(seed, 'push', '--quiet', 'origin', 'HEAD:main');

  const corvidae = join(root, 'corvidae');
  await writeTree(corvidae, corvidaeFixture());
  await writeTree(corvidae, {
    'scripts/mirror/target-definitions.ts': await Bun.file(
      new URL('./target-definitions.ts', import.meta.url),
    ).text(),
    'scripts/mirror/layout-map.json': await Bun.file(
      new URL('./layout-map.json', import.meta.url),
    ).text(),
  });
  for (const policyFile of ['package-map.json', 'package-surface.json']) {
    await Bun.write(
      join(corvidae, 'scripts/mirror', policyFile),
      await Bun.file(join(import.meta.dir, policyFile)).text(),
    );
  }
  await git(corvidae, 'init', '--quiet', '--initial-branch=main');
  const corvidaeCommit = await commitAll(corvidae, 'Trusted corvidae source');
  return { root, remote, corvidae, corvidaeCommit, baseCommit };
}

function syncResult(options: {
  decision: 'skip' | 'prepared';
  directory: string;
  baseCommit: string;
  changed: readonly string[];
  commit?: string;
  baseBranch?: string;
}): SyncResult {
  return {
    decision: options.decision,
    target,
    directory: options.directory,
    changed: [...options.changed],
    ...(options.commit === undefined ? {} : { commit: options.commit }),
    firstPublish: [],
    seededFromPackageMap: [],
    verification,
    baseBranch: options.baseBranch ?? 'main',
    baseCommit: options.baseCommit,
  };
}

async function prepareArtifact(
  harness: Harness,
  sourceText = source,
  baseBranch = 'main',
): Promise<string> {
  const clone = join(harness.root, `prepared-${crypto.randomUUID()}`);
  await git(harness.root, 'clone', '--quiet', '--branch', baseBranch, harness.remote, clone);
  await stageSurface({
    corvidaeRoot: harness.corvidae,
    target,
    directory: clone,
    policyDocuments,
  });
  if (sourceText !== source) {
    await Bun.write(join(clone, 'packages/markdown/src/index.ts'), sourceText);
  }
  const porcelain = await git(clone, 'status', '--porcelain');
  const changed = porcelain.split('\n').filter((line) => line.length > 0);
  await git(clone, 'add', '--all');
  await git(
    clone,
    'commit',
    '--quiet',
    '--message',
    `Sync ${target} from corvidae\n\n${provenanceTrailer}: ${harness.corvidaeCommit}`,
  );
  const commitOutput = await git(clone, 'rev-parse', 'HEAD');
  const commit = commitOutput.trim();
  const artifactDirectory = join(harness.root, `artifact-${crypto.randomUUID()}`);
  await writePreparedSyncArtifact({
    artifactDirectory,
    result: syncResult({
      decision: 'prepared',
      directory: clone,
      baseCommit: harness.baseCommit,
      baseBranch,
      changed,
      commit,
    }),
    corvidaeCommit: harness.corvidaeCommit,
    snapshot: false,
  });
  return artifactDirectory;
}

async function skipArtifact(harness: Harness): Promise<string> {
  const current = join(harness.root, 'current');
  await git(harness.root, 'clone', '--quiet', harness.remote, current);
  await stageSurface({
    corvidaeRoot: harness.corvidae,
    target,
    directory: current,
    policyDocuments,
  });
  await git(current, 'add', '--all');
  await git(
    current,
    'commit',
    '--quiet',
    '--message',
    `Sync ${target} from corvidae\n\n${provenanceTrailer}: ${harness.corvidaeCommit}`,
  );
  await git(current, 'push', '--quiet', 'origin', 'HEAD:main');
  const baseCommitOutput = await git(current, 'rev-parse', 'HEAD');
  const baseCommit = baseCommitOutput.trim();
  const artifactDirectory = join(harness.root, 'skip-artifact');
  await writePreparedSyncArtifact({
    artifactDirectory,
    result: syncResult({ decision: 'skip', directory: current, baseCommit, changed: [] }),
    corvidaeCommit: harness.corvidaeCommit,
    snapshot: false,
  });
  return artifactDirectory;
}

async function verifyArtifact(
  harness: Harness,
  artifactDirectory: string,
  expectedBaseBranch?: string,
): Promise<void> {
  await verifyPreparedSyncArtifact({
    artifactDirectory,
    corvidaeRoot: harness.corvidae,
    remote: harness.remote,
    expectedTarget: target,
    expectedCorvidaeCommit: harness.corvidaeCommit,
    expectedSnapshot: false,
    policyDocuments,
    ...(expectedBaseBranch === undefined ? {} : { expectedBaseBranch }),
  });
}

describe('trusted prepared tree reconstruction', async () => {
  // Real local repositories and their processes are the behavior; they run at module scope, off the per-test clock.
  const outcome1 = await outcomeOf(async () => {
    const harness = await trustedHarness();
    try {
      const branch = 'steve/cinder-mirror-conversion';
      await git(harness.remote, 'branch', branch, 'main');
      const artifactDirectory = await prepareArtifact(harness, source, branch);
      await verifyArtifact(harness, artifactDirectory, branch);
      expect(await throwingRejectionOf(verifyArtifact(harness, artifactDirectory))).toThrow(
        /default branch/,
      );
      const updater = join(harness.root, 'branch-updater');
      await git(harness.root, 'clone', '--quiet', '--branch', branch, harness.remote, updater);
      await Bun.write(join(updater, 'README.md'), '# moved requested branch\n');
      await commitAll(updater, 'Move requested branch');
      await git(updater, 'push', '--quiet', 'origin', `HEAD:${branch}`);
      expect(await throwingRejectionOf(verifyArtifact(harness, artifactDirectory, branch))).toThrow(
        /requested target branch HEAD/,
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
  test('accepts an explicitly requested target branch and rejects it as an implicit default', () =>
    rethrow(outcome1));
  const outcome2 = await outcomeOf(async () => {
    const marker = join(tmpdir(), `mirror-lifecycle-${crypto.randomUUID()}`);
    const harness = await trustedHarness(marker);
    try {
      await verifyArtifact(harness, await prepareArtifact(harness));
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
  });
  test('accepts a real prepared artifact and does not run target lifecycle scripts', () =>
    rethrow(outcome2));

  const outcome3 = await outcomeOf(async () => {
    const harness = await trustedHarness();
    try {
      await verifyArtifact(harness, await skipArtifact(harness));
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
  test('accepts a real skip artifact after the target already matches the trusted transform', () =>
    rethrow(outcome3));

  const outcome4 = await outcomeOf(async () => {
    const harness = await trustedHarness();
    try {
      expect(
        await throwingRejectionOf(
          verifyArtifact(harness, await prepareArtifact(harness, maliciousSource)),
        ),
      ).toThrow(/Trusted reconstruction tree/);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
  test('rejects a self-consistent forged artifact whose tree does not match reconstruction', () =>
    rethrow(outcome4));

  const outcome5 = await outcomeOf(async () => {
    const harness = await trustedHarness();
    try {
      const artifactDirectory = await prepareArtifact(harness);
      const updater = join(harness.root, 'updater');
      await git(harness.root, 'clone', '--quiet', harness.remote, updater);
      await Bun.write(join(updater, 'README.md'), '# moved default branch\n');
      await commitAll(updater, 'Move target default branch');
      await git(updater, 'push', '--quiet', 'origin', 'HEAD:main');
      expect(await throwingRejectionOf(verifyArtifact(harness, artifactDirectory))).toThrow(
        /default HEAD/,
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
  test('rejects artifacts prepared from a stale default-branch head', () => rethrow(outcome5));

  const outcome6 = await outcomeOf(async () => {
    const harness = await trustedHarness();
    try {
      const artifactDirectory = await prepareArtifact(harness);
      const manifestPath = join(artifactDirectory, preparedSyncManifestFile);
      const manifest = (await Bun.file(manifestPath).json()) as Record<string, unknown>;
      manifest['baseBranch'] = 'attacker-branch';
      await Bun.write(manifestPath, `${JSON.stringify(manifest)}\n`);
      expect(await throwingRejectionOf(verifyArtifact(harness, artifactDirectory))).toThrow(
        /default branch/,
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
  test('rejects artifact base branches that are not the target remote default branch', () =>
    rethrow(outcome6));

  const outcome7 = await outcomeOf(async () => {
    const harness = await trustedHarness();
    try {
      const artifactDirectory = await prepareArtifact(harness);
      await Bun.write(join(harness.corvidae, 'packages/markdown/src/extra.ts'), 'export {};\n');
      await commitAll(harness.corvidae, 'Move trusted source');
      expect(await throwingRejectionOf(verifyArtifact(harness, artifactDirectory))).toThrow(
        /corvidae checkout does not match/,
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
  test('rejects a trusted source checkout at the wrong commit', () => rethrow(outcome7));

  const outcome8 = await outcomeOf(async () => {
    const harness = await trustedHarness();
    try {
      const artifactDirectory = await prepareArtifact(harness);
      await Bun.write(join(harness.corvidae, 'DIRTY.md'), 'dirty\n');
      expect(await throwingRejectionOf(verifyArtifact(harness, artifactDirectory))).toThrow(
        /must be clean/,
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
  test('rejects a dirty trusted source checkout', () => rethrow(outcome8));

  const outcome9 = await outcomeOf(async () => {
    const harness = await trustedHarness();
    try {
      const symlinkClone = join(harness.root, 'symlink-seed');
      await git(harness.root, 'clone', '--quiet', harness.remote, symlinkClone);
      await symlink('../outside', join(symlinkClone, 'packages/markdown/symlink'));
      await commitAll(symlinkClone, 'Add target symlink');
      await git(symlinkClone, 'push', '--quiet', 'origin', 'HEAD:main');
      const baseCommit = await git(symlinkClone, 'rev-parse', 'HEAD');
      expect(
        await throwingRejectionOf(
          verifyTrustedPreparedTree({
            corvidaeRoot: harness.corvidae,
            remote: harness.remote,
            policyDocuments,
            manifest: {
              decision: 'skip',
              target,
              corvidaeCommit: harness.corvidaeCommit,
              baseBranch: 'main',
              baseCommit: baseCommit.trim(),
              changed: [],
              tree: '0'.repeat(40),
            },
          }),
        ),
      ).toThrow(/symlink or gitlink/);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
  test('rejects tracked symlinks before trusted reconstruction', () => rethrow(outcome9));

  const outcome10 = await outcomeOf(async () => {
    const harness = await trustedHarness();
    try {
      const moduleRepository = join(harness.root, 'module');
      await mkdir(moduleRepository, { recursive: true });
      await git(moduleRepository, 'init', '--quiet', '--initial-branch=main');
      await Bun.write(join(moduleRepository, 'README.md'), '# module\n');
      await commitAll(moduleRepository, 'Module seed');

      const gitlinkClone = join(harness.root, 'gitlink-seed');
      await git(harness.root, 'clone', '--quiet', harness.remote, gitlinkClone);
      await git(
        gitlinkClone,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--quiet',
        moduleRepository,
        'vendor/module',
      );
      await commitAll(gitlinkClone, 'Add target gitlink');
      await git(gitlinkClone, 'push', '--quiet', 'origin', 'HEAD:main');
      const baseCommit = await git(gitlinkClone, 'rev-parse', 'HEAD');
      expect(
        await throwingRejectionOf(
          verifyTrustedPreparedTree({
            corvidaeRoot: harness.corvidae,
            remote: harness.remote,
            policyDocuments,
            manifest: {
              decision: 'skip',
              target,
              corvidaeCommit: harness.corvidaeCommit,
              baseBranch: 'main',
              baseCommit: baseCommit.trim(),
              changed: [],
              tree: '0'.repeat(40),
            },
          }),
        ),
      ).toThrow(/symlink or gitlink/);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
  test('rejects tracked gitlinks before trusted reconstruction', () => rethrow(outcome10));
});
