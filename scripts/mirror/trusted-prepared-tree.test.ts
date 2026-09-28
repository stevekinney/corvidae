import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  preparedSyncManifestFile,
  verifyPreparedSyncArtifact,
  writePreparedSyncArtifact,
} from './prepared-sync.ts';
import { git, provenanceTrailer, stageSurface, type SyncResult } from './sync.ts';
import { verifyTrustedPreparedTree } from './trusted-prepared-tree.ts';

const target = 'agent-bureau' as const;
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
    'packages/cryptography/package.json': {
      name: '@lostgradient/cryptography',
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
    'packages/cryptography/tsconfig.json': {
      extends: '@lostgradient/typescript/library.json',
      include: ['src'],
    },
    'packages/cryptography/src/index.ts': source,
  };
}

function targetFixture(marker?: string): Record<string, unknown> {
  return {
    'README.md': '# agent-bureau\n',
    LICENSE: licence,
    '.gitignore': 'node_modules\n',
    '.github/workflows/release.yaml': fixtureReleaseWorkflow,
    ...(marker === undefined
      ? {}
      : {
          'packages/cryptography/package.json': {
            name: '@lostgradient/cryptography',
            version: '0.1.0',
            type: 'module',
            scripts: { preinstall: 'bun ./scripts/preinstall.ts' },
          },
          'packages/cryptography/scripts/preinstall.ts': `await Bun.write(${JSON.stringify(marker)}, 'ran');\n`,
        }),
    'packages/cryptography/tsdown.config.ts': tsdownConfiguration,
    'packages/cryptography/README.md': '# @lostgradient/cryptography\n',
    'packages/cryptography/src/index.ts': staleSource,
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
    baseBranch: 'main',
    baseCommit: options.baseCommit,
  };
}

async function prepareArtifact(harness: Harness, sourceText = source): Promise<string> {
  const clone = join(harness.root, `prepared-${crypto.randomUUID()}`);
  await git(harness.root, 'clone', '--quiet', harness.remote, clone);
  await stageSurface({ corvidaeRoot: harness.corvidae, target, directory: clone });
  if (sourceText !== source) {
    await Bun.write(join(clone, 'packages/cryptography/src/index.ts'), sourceText);
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
  await stageSurface({ corvidaeRoot: harness.corvidae, target, directory: current });
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

async function verifyArtifact(harness: Harness, artifactDirectory: string): Promise<void> {
  await verifyPreparedSyncArtifact({
    artifactDirectory,
    corvidaeRoot: harness.corvidae,
    remote: harness.remote,
    expectedTarget: target,
    expectedCorvidaeCommit: harness.corvidaeCommit,
    expectedSnapshot: false,
  });
}

describe('trusted prepared tree reconstruction', () => {
  test('accepts a real prepared artifact and does not run target lifecycle scripts', async () => {
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

  test('accepts a real skip artifact after the target already matches the trusted transform', async () => {
    const harness = await trustedHarness();
    try {
      await verifyArtifact(harness, await skipArtifact(harness));
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  test('rejects a self-consistent forged artifact whose tree does not match reconstruction', async () => {
    const harness = await trustedHarness();
    try {
      await expect(
        verifyArtifact(harness, await prepareArtifact(harness, maliciousSource)),
      ).rejects.toThrow(/Trusted reconstruction tree/);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  test('rejects artifacts prepared from a stale default-branch head', async () => {
    const harness = await trustedHarness();
    try {
      const artifactDirectory = await prepareArtifact(harness);
      const updater = join(harness.root, 'updater');
      await git(harness.root, 'clone', '--quiet', harness.remote, updater);
      await Bun.write(join(updater, 'README.md'), '# moved default branch\n');
      await commitAll(updater, 'Move target default branch');
      await git(updater, 'push', '--quiet', 'origin', 'HEAD:main');
      await expect(verifyArtifact(harness, artifactDirectory)).rejects.toThrow(/default HEAD/);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  test('rejects artifact base branches that are not the target remote default branch', async () => {
    const harness = await trustedHarness();
    try {
      const artifactDirectory = await prepareArtifact(harness);
      const manifestPath = join(artifactDirectory, preparedSyncManifestFile);
      const manifest = (await Bun.file(manifestPath).json()) as Record<string, unknown>;
      manifest['baseBranch'] = 'attacker-branch';
      await Bun.write(manifestPath, `${JSON.stringify(manifest)}\n`);
      await expect(verifyArtifact(harness, artifactDirectory)).rejects.toThrow(/default branch/);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  test('rejects a trusted source checkout at the wrong commit', async () => {
    const harness = await trustedHarness();
    try {
      const artifactDirectory = await prepareArtifact(harness);
      await Bun.write(join(harness.corvidae, 'packages/cryptography/src/extra.ts'), 'export {};\n');
      await commitAll(harness.corvidae, 'Move trusted source');
      await expect(verifyArtifact(harness, artifactDirectory)).rejects.toThrow(
        /corvidae checkout does not match/,
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  test('rejects a dirty trusted source checkout', async () => {
    const harness = await trustedHarness();
    try {
      const artifactDirectory = await prepareArtifact(harness);
      await Bun.write(join(harness.corvidae, 'DIRTY.md'), 'dirty\n');
      await expect(verifyArtifact(harness, artifactDirectory)).rejects.toThrow(/must be clean/);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  test('rejects tracked symlinks before trusted reconstruction', async () => {
    const harness = await trustedHarness();
    try {
      const symlinkClone = join(harness.root, 'symlink-seed');
      await git(harness.root, 'clone', '--quiet', harness.remote, symlinkClone);
      await symlink('../outside', join(symlinkClone, 'packages/cryptography/symlink'));
      await commitAll(symlinkClone, 'Add target symlink');
      await git(symlinkClone, 'push', '--quiet', 'origin', 'HEAD:main');
      const baseCommit = await git(symlinkClone, 'rev-parse', 'HEAD');
      await expect(
        verifyTrustedPreparedTree({
          corvidaeRoot: harness.corvidae,
          remote: harness.remote,
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
      ).rejects.toThrow(/symlink or gitlink/);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  test('rejects tracked gitlinks before trusted reconstruction', async () => {
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
      await expect(
        verifyTrustedPreparedTree({
          corvidaeRoot: harness.corvidae,
          remote: harness.remote,
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
      ).rejects.toThrow(/symlink or gitlink/);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
});
