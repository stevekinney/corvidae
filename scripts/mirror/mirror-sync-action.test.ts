import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dispatchSnapshotWorkflow,
  pullRequestBodyFor,
  pullRequestBranchFor,
  reportDrift,
  runMirrorSyncActionCommand,
  snapshotDispatchFor,
  targetRemoteUrl,
  targetRepositoryFullName,
} from './mirror-sync-action.ts';
import { git, runSync } from './sync.ts';

describe('targetRepositoryFullName and targetRemoteUrl', () => {
  test('every mirror target resolves under the account every mirror lives on', () => {
    expect(targetRepositoryFullName('weft')).toBe('stevekinney/weft');
    expect(targetRepositoryFullName('cinder')).toBe('stevekinney/cinder');
    expect(targetRepositoryFullName('agent-bureau')).toBe('stevekinney/agent-bureau');
    expect(targetRemoteUrl('weft')).toBe('https://github.com/stevekinney/weft.git');
  });
});

describe('pullRequestBranchFor', () => {
  test('gives retries of the same source commit distinct remote branches', () => {
    const first = pullRequestBranchFor('0123456789abcdef');
    const second = pullRequestBranchFor('0123456789abcdef');
    expect(first).toStartWith('mirror-sync-0123456789ab-');
    expect(second).toStartWith('mirror-sync-0123456789ab-');
    expect(second).not.toBe(first);
  });
});

describe('pullRequestBodyFor', () => {
  test('names corvidae as the source and says review threads are answered there', () => {
    const body = pullRequestBodyFor({
      target: 'weft',
      corvidaeCommit: 'abc123',
      changed: ['packages/weft/src/index.ts'],
    });
    expect(body).toContain('corvidae');
    expect(body).toContain('Corvidae-Commit: abc123');
    expect(body).toContain('review threads on this diff are answered there');
    expect(body).toContain('1 changed path(s)');
  });
});

describe('snapshotDispatchFor', () => {
  test('uses each target workflow and the verified sync commit when changed', () => {
    expect(
      snapshotDispatchFor('weft', 'stevekinney/weft', 'mirror-sync-deadbeef', {
        decision: 'pushed',
        commit: 'deadbeef',
        baseBranch: 'main',
        baseCommit: 'base-sha',
        pullRequest: { number: 1, htmlUrl: 'https://example.test/pr/1' },
      }),
    ).toEqual({
      fullName: 'stevekinney/weft',
      workflowFile: 'release.yaml',
      ref: 'mirror-sync-deadbeef',
      inputs: { snapshot: 'true', expected_sha: 'deadbeef' },
    });
    expect(
      snapshotDispatchFor('cinder', 'stevekinney/cinder', 'mirror-sync-deadbeef', {
        decision: 'pushed',
        commit: 'deadbeef',
        baseBranch: 'main',
        baseCommit: 'base-sha',
        pullRequest: { number: 1, htmlUrl: 'https://example.test/pr/1' },
      }).workflowFile,
    ).toBe('release.yaml');
    expect(
      snapshotDispatchFor('agent-bureau', 'stevekinney/agent-bureau', 'mirror-sync-deadbeef', {
        decision: 'pushed',
        commit: 'deadbeef',
        baseBranch: 'main',
        baseCommit: 'base-sha',
        pullRequest: { number: 1, htmlUrl: 'https://example.test/pr/1' },
      }).workflowFile,
    ).toBe('release.yml');
  });

  test('uses the actual default branch and commit when sync skips', () => {
    expect(
      snapshotDispatchFor('agent-bureau', 'stevekinney/agent-bureau', 'mirror-sync-deadbeef', {
        decision: 'skip',
        baseBranch: 'trunk',
        baseCommit: 'verified-target-sha',
      }),
    ).toEqual({
      fullName: 'stevekinney/agent-bureau',
      workflowFile: 'release.yml',
      ref: 'trunk',
      inputs: { snapshot: 'true', expected_sha: 'verified-target-sha' },
    });
  });

  test('requires the verified commit and propagates dispatch failures', async () => {
    expect(() =>
      snapshotDispatchFor('weft', 'stevekinney/weft', 'mirror-sync-deadbeef', {
        decision: 'pushed',
        commit: 'deadbeef',
        baseBranch: 'main',
        baseCommit: 'base-sha',
      }),
    ).toThrow(/requires a source pull request/);
    expect(() =>
      snapshotDispatchFor('weft', 'stevekinney/weft', 'mirror-sync-deadbeef', {
        decision: 'pushed',
        baseBranch: 'main',
        baseCommit: 'base-sha',
        pullRequest: { number: 1, htmlUrl: 'https://example.test/pr/1' },
      }),
    ).toThrow(/verified target commit/);

    const api = {
      dispatchWorkflow: async () => {
        throw new Error('dispatch refused');
      },
    };
    await expect(
      dispatchSnapshotWorkflow(api, 'weft', 'stevekinney/weft', 'mirror-sync-deadbeef', {
        decision: 'pushed',
        commit: 'deadbeef',
        baseBranch: 'main',
        baseCommit: 'base-sha',
        pullRequest: { number: 1, htmlUrl: 'https://example.test/pr/1' },
      }),
    ).rejects.toThrow('dispatch refused');
  });
});

describe('runMirrorSyncActionCommand argument handling', () => {
  test('refuses an unknown mode without touching git or GitHub', async () => {
    const code = await runMirrorSyncActionCommand(['--mode', 'nuke']);
    expect(code).toBe(1);
  });

  test('requires --mode', async () => {
    const code = await runMirrorSyncActionCommand([]);
    expect(code).toBe(1);
  });

  test('requires --target for report mode', async () => {
    const code = await runMirrorSyncActionCommand(['--mode', 'report', '--work', '/tmp/x']);
    expect(code).toBe(1);
  });

  test('refuses an unknown --target for report mode', async () => {
    const code = await runMirrorSyncActionCommand([
      '--mode',
      'report',
      '--target',
      'not-a-real-target',
      '--work',
      '/tmp/x',
    ]);
    expect(code).toBe(1);
  });

  test('requires --target for dispatch mode', async () => {
    const code = await runMirrorSyncActionCommand([
      '--mode',
      'dispatch',
      '--work',
      '/tmp/x',
      '--scratch',
      '/tmp/y',
    ]);
    expect(code).toBe(1);
  });

  test('rejects malformed --snapshot input before dispatch setup', async () => {
    const messages: string[] = [];
    const originalWrite = process.stderr.write;
    const captureWrite: typeof process.stderr.write = (chunk) => {
      messages.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    process.stderr.write = captureWrite;

    try {
      const code = await runMirrorSyncActionCommand([
        '--mode',
        'dispatch',
        '--target',
        'weft',
        '--snapshot',
        'maybe',
        '--work',
        '/tmp/mirror-sync-action-invalid-snapshot',
        '--scratch',
        '/tmp/mirror-sync-action-invalid-snapshot-scratch',
      ]);
      expect(code).toBe(1);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(messages.join('')).toContain('--snapshot must be "true" or "false"');
  });
});

/**
 * A minimal real-workspace fixture for `reportDrift`, trimmed from `sync.test.ts`'s harness to
 * what `stageSurface` actually needs: it never builds, packs or verifies, so the fixture carries
 * no `tsdown.config.ts` content that has to run and no release workflow to read a Bun version
 * out of — only the one real published workspace (`@lostgradient/cryptography`, routed to the
 * agent-bureau target by `manifests.ts`) and the build input `package-surface.json` declares for
 * it, whose mere presence `assertBuildInputsPresent` checks.
 */
const licence = 'MIT License\n\nCopyright (c) 2026 Steve Kinney\n';
const source = 'export const digest = (value: string): string => `sha256:${value}`;\n';
const staleSource = 'export const digest = (value: string): string => `stale:${value}`;\n';

/**
 * `renderMirrorVerifyWorkflow` — part of `stageSurface`'s `planSurface`, so every fixture below
 * goes through it even though `reportDrift` never reads the workflow it emits — reads locked
 * `publint`/`@arethetypeswrong/cli` versions out of `bun.lock` in this exact text-lockfile shape,
 * and reads a Bun version pin out of the target's own release workflow. Both are copied from
 * `sync.test.ts`'s fixture rather than invented, so this file exercises the same real reads a
 * live sync would.
 */
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
      workspaces: ['applications/*', 'components/*', 'packages/*', 'internal/*'],
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

/**
 * `tsdown` needs a configuration that emits both halves of a dual-format package under the exact
 * names the published `exports` map promises, copied from `sync.test.ts`'s fixture: only the
 * "up to date after a real sync" test actually runs `runSync`'s `verifyTarget` (build, pack,
 * publint, attw), which needs a build that really produces `dist/`, not a stub.
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

function targetFixture(): Record<string, unknown> {
  return {
    'README.md': '# agent-bureau\n',
    LICENSE: licence,
    '.gitignore': 'node_modules\n',
    '.github/workflows/release.yaml': fixtureReleaseWorkflow,
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

async function withHarness(
  body: (harness: { remote: string; corvidae: string; workRoot: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mirror-sync-action-'));
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

    await body({ remote, corvidae, workRoot: join(root, 'work') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const endToEndTimeout = 120_000;

describe('reportDrift', () => {
  test(
    'reports a target as behind when the transform would change it, and pushes nothing',
    async () => {
      await withHarness(async (harness) => {
        const report = await reportDrift({
          corvidaeRoot: harness.corvidae,
          target: 'agent-bureau',
          remote: harness.remote,
          directory: join(harness.workRoot, 'behind'),
        });
        expect(report.behind).toBe(true);
        expect(report.changed.join('\n')).toContain('packages/cryptography/src/index.ts');

        // Nothing was pushed: the remote's `main` still holds only the seed commit.
        const commitCount = await git(harness.remote, 'rev-list', '--count', 'main');
        expect(commitCount.trim()).toBe('1');
      });
    },
    endToEndTimeout,
  );

  test(
    'reports a target as up to date once a real sync has caught it up',
    async () => {
      await withHarness(async (harness) => {
        await runSync({
          corvidaeRoot: harness.corvidae,
          target: 'agent-bureau',
          remote: harness.remote,
          directory: join(harness.workRoot, 'sync'),
          scratchDirectory: join(harness.workRoot, 'scratch'),
          corvidaeCommit: 'corvidae-seed',
        });

        const report = await reportDrift({
          corvidaeRoot: harness.corvidae,
          target: 'agent-bureau',
          remote: harness.remote,
          directory: join(harness.workRoot, 'after'),
        });
        expect(report.behind).toBe(false);
        expect(report.changed).toEqual([]);
      });
    },
    endToEndTimeout,
  );
});
