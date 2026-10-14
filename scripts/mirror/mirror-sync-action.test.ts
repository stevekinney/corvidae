import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '../promise-outcome.test-support.ts';
import type { GitHubApi, OpenPullRequestRecord } from './github-api.ts';
import {
  dispatchSnapshotWorkflow,
  openSyncPullRequest,
  pullRequestBodyFor,
  pullRequestBranchFor,
  refusePrepareOffMain,
  reportDrift,
  runMirrorSyncActionCommand,
  settleSkippedSync,
  snapshotDispatchFor,
  supersedeOlderPullRequests,
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

describe('refusePrepareOffMain', () => {
  test('refuses a ref other than main and says why', () => {
    expect(() => refusePrepareOffMain({ GITHUB_REF: 'refs/heads/feature' })).toThrow(
      /refs\/heads\/feature.*main/,
    );
    expect(() => refusePrepareOffMain({ GITHUB_REF: 'refs/tags/v1' })).toThrow();
  });

  test('allows main, and an unset ref outside Actions', () => {
    expect(() => refusePrepareOffMain({ GITHUB_REF: 'refs/heads/main' })).not.toThrow();
    expect(() => refusePrepareOffMain({})).not.toThrow();
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
      snapshotDispatchFor('weft', 'release.yaml', 'stevekinney/weft', 'mirror-sync-deadbeef', {
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
      snapshotDispatchFor('cinder', 'release.yaml', 'stevekinney/cinder', 'mirror-sync-deadbeef', {
        decision: 'pushed',
        commit: 'deadbeef',
        baseBranch: 'main',
        baseCommit: 'base-sha',
        pullRequest: { number: 1, htmlUrl: 'https://example.test/pr/1' },
      }).workflowFile,
    ).toBe('release.yaml');
    expect(
      snapshotDispatchFor(
        'agent-bureau',
        'release.yml',
        'stevekinney/agent-bureau',
        'mirror-sync-deadbeef',
        {
          decision: 'pushed',
          commit: 'deadbeef',
          baseBranch: 'main',
          baseCommit: 'base-sha',
          pullRequest: { number: 1, htmlUrl: 'https://example.test/pr/1' },
        },
      ).workflowFile,
    ).toBe('release.yml');
  });

  test('uses the actual default branch and commit when sync skips', () => {
    expect(
      snapshotDispatchFor(
        'agent-bureau',
        'release.yml',
        'stevekinney/agent-bureau',
        'mirror-sync-deadbeef',
        {
          decision: 'skip',
          baseBranch: 'trunk',
          baseCommit: 'verified-target-sha',
        },
      ),
    ).toEqual({
      fullName: 'stevekinney/agent-bureau',
      workflowFile: 'release.yml',
      ref: 'trunk',
      inputs: { snapshot: 'true', expected_sha: 'verified-target-sha' },
    });
  });

  test('requires the verified commit and propagates dispatch failures', async () => {
    expect(() =>
      snapshotDispatchFor('weft', 'release.yaml', 'stevekinney/weft', 'mirror-sync-deadbeef', {
        decision: 'pushed',
        commit: 'deadbeef',
        baseBranch: 'main',
        baseCommit: 'base-sha',
      }),
    ).toThrow(/requires a source pull request/);
    expect(() =>
      snapshotDispatchFor('weft', 'release.yaml', 'stevekinney/weft', 'mirror-sync-deadbeef', {
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
    const directory = await mkdtemp(join(tmpdir(), 'snapshot-error-'));
    try {
      await Bun.write(join(directory, '.github/workflows/release.yaml'), 'name: release\n');
      expect(
        await throwingRejectionOf(
          dispatchSnapshotWorkflow(
            api,
            'weft',
            'stevekinney/weft',
            'mirror-sync-deadbeef',
            {
              decision: 'pushed',
              commit: 'deadbeef',
              baseBranch: 'main',
              baseCommit: 'base-sha',
              pullRequest: { number: 1, htmlUrl: 'https://example.test/pr/1' },
            },
            directory,
          ),
        ),
      ).toThrow('dispatch refused');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  test('requires --target for prepare mode', async () => {
    const code = await runMirrorSyncActionCommand([
      '--mode',
      'prepare',
      '--work',
      '/tmp/x',
      '--scratch',
      '/tmp/y',
      '--artifact',
      '/tmp/z',
    ]);
    expect(code).toBe(1);
  });

  test('rejects malformed --snapshot input before prepare setup', async () => {
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
        'prepare',
        '--target',
        'weft',
        '--snapshot',
        'maybe',
        '--work',
        '/tmp/mirror-sync-action-invalid-snapshot',
        '--scratch',
        '/tmp/mirror-sync-action-invalid-snapshot-scratch',
        '--artifact',
        '/tmp/mirror-sync-action-invalid-snapshot-artifact',
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
    for (const policyFile of ['package-map.json', 'package-surface.json']) {
      await Bun.write(
        join(corvidae, 'scripts/mirror', policyFile),
        await Bun.file(join(import.meta.dir, policyFile)).text(),
      );
    }

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

test('snapshot dispatch discovers the release workflow filename from the staged clone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-workflow-'));
  try {
    await Bun.write(join(directory, '.github/workflows/release.yml'), 'name: release\n');
    const calls: unknown[] = [];
    await dispatchSnapshotWorkflow(
      {
        dispatchWorkflow: async (input) => {
          calls.push(input);
        },
      },
      'weft',
      'stevekinney/weft',
      'mirror-sync-branch',
      { decision: 'skip', baseBranch: 'main', baseCommit: 'verified-target-sha' },
      directory,
    );
    expect(calls).toEqual([
      {
        fullName: 'stevekinney/weft',
        workflowFile: 'release.yml',
        ref: 'main',
        inputs: { snapshot: 'true', expected_sha: 'verified-target-sha' },
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('supersession (COR-1433)', () => {
  const bot = 'lost-gradient-mirror-sync[bot]';
  const newNumber = 20;

  /** A corvidae history `older -> newer` plus a commit on a side branch that is not an ancestor. */
  async function withCorvidae(
    body: (shas: { older: string; newer: string; side: string }, root: string) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'supersession-corvidae-'));
    try {
      await git(root, 'init', '--quiet', '--initial-branch=main');
      await git(root, 'config', 'user.email', 'fixture@example.test');
      await git(root, 'config', 'user.name', 'Fixture');
      const commit = async (message: string): Promise<string> => {
        await git(root, 'commit', '--quiet', '--allow-empty', '--message', message);
        const head = await git(root, 'rev-parse', 'HEAD');
        return head.trim();
      };
      const older = await commit('Older');
      await git(root, 'checkout', '--quiet', '-b', 'side');
      const side = await commit('Side');
      await git(root, 'checkout', '--quiet', 'main');
      const newer = await commit('Newer');
      await body({ older, newer, side }, root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  function record(
    number: number,
    overrides: Partial<OpenPullRequestRecord> = {},
  ): OpenPullRequestRecord {
    return {
      number,
      htmlUrl: `https://github.com/stevekinney/weft/pull/${number}`,
      author: bot,
      headRef: `mirror-sync-${number}`,
      headSha: `head-${number}`,
      baseRef: 'main',
      ...overrides,
    };
  }

  interface Fake {
    api: Pick<
      GitHubApi,
      | 'createPullRequest'
      | 'dispatchWorkflow'
      | 'listOpenPullRequests'
      | 'getCommitMessage'
      | 'createIssueComment'
      | 'closePullRequest'
    >;
    events: string[];
  }

  function fake(
    open: readonly OpenPullRequestRecord[],
    messages: Record<string, string>,
    failClosing: ReadonlySet<number> = new Set(),
  ): Fake {
    const events: string[] = [];
    return {
      events,
      api: {
        async createPullRequest() {
          events.push('create');
          return {
            number: newNumber,
            htmlUrl: `https://github.com/stevekinney/weft/pull/${newNumber}`,
            headSha: 'new-head',
          };
        },
        async dispatchWorkflow() {
          events.push('dispatch');
        },
        async listOpenPullRequests() {
          return open;
        },
        async getCommitMessage(_fullName, sha) {
          return messages[sha] ?? '';
        },
        async createIssueComment({ issueNumber, body }) {
          events.push(`comment ${issueNumber}: ${body}`);
        },
        async closePullRequest(_fullName, number) {
          if (failClosing.has(number)) throw new Error(`HTTP 500 closing ${number}`);
          events.push(`close ${number}`);
        },
      },
    };
  }

  const trailer = (sha: string): string => `Sync weft from corvidae\n\nCorvidae-Commit: ${sha}`;

  test('closes an older sync pull request whose trailer is an ancestor, and nothing else', async () => {
    await withCorvidae(async ({ older, newer, side }, root) => {
      const { api, events } = fake(
        [
          record(11),
          record(newNumber),
          record(12),
          record(13),
          record(14),
          record(15, { author: 'someone-else' }),
          record(16, { baseRef: 'release' }),
          record(17, { headRef: 'feature/something' }),
          record(18, { headRef: 'mirror-sync-snapshot-18' }),
        ],
        {
          'head-11': trailer(older),
          [`head-${newNumber}`]: trailer(newer),
          'head-12': trailer(side),
          'head-13': 'Sync weft from corvidae\n\nno trailer here',
          'head-14': trailer('f'.repeat(40)),
          'head-15': trailer(older),
          'head-16': trailer(older),
          'head-17': trailer(older),
          'head-18': trailer(older),
        },
      );
      const logged: string[] = [];
      const outcome = await supersedeOlderPullRequests({
        api,
        corvidaeRoot: root,
        fullName: 'stevekinney/weft',
        base: 'main',
        newPullRequest: {
          number: newNumber,
          htmlUrl: `https://github.com/stevekinney/weft/pull/${newNumber}`,
        },
        newCorvidaeCommit: newer,
        log: (line) => logged.push(line),
      });

      // 11 and the snapshot pull request 18 are provably older; the new pull request is never touched.
      expect(outcome.closed).toEqual([11, 18]);
      expect(events.filter((event) => event.startsWith('close'))).toEqual(['close 11', 'close 18']);
      expect(events.find((event) => event.startsWith('comment 11'))).toContain(`pull/${newNumber}`);
      expect(outcome.left.map(({ number }) => number)).toEqual([12, 13, 14]);
      expect(logged.join('\n')).toContain('#12: left open');
      expect(logged.join('\n')).toContain('not an ancestor');
      expect(logged.join('\n')).toContain('no single parsable');
      expect(logged.join('\n')).toContain('not an object in the corvidae checkout');
    });
  });

  test('a stale dispatch closes the new pull request when an open one is strictly newer', async () => {
    await withCorvidae(async ({ older, newer }, root) => {
      // The new pull request is built from `older`; pull request 11 is built from `newer`.
      const { api, events } = fake([record(11), record(12)], {
        'head-11': trailer(newer),
        'head-12': trailer(older),
      });
      const outcome = await supersedeOlderPullRequests({
        api,
        corvidaeRoot: root,
        fullName: 'stevekinney/weft',
        base: 'main',
        newPullRequest: {
          number: newNumber,
          htmlUrl: `https://github.com/stevekinney/weft/pull/${newNumber}`,
        },
        newCorvidaeCommit: older,
        log: () => {},
      });
      expect(outcome.closed).toEqual([newNumber]);
      expect(events.filter((event) => event.startsWith('close'))).toEqual([`close ${newNumber}`]);
      expect(events.find((event) => event.startsWith(`comment ${newNumber}`))).toContain('pull/11');
    });
  });

  test('a stale snapshot dispatch never dispatches the snapshot workflow', async () => {
    await withCorvidae(async ({ older, newer }, root) => {
      const { api, events } = fake([record(11)], { 'head-11': trailer(newer) });
      const message = await openSyncPullRequest({
        api,
        target: 'weft',
        manifest: {
          baseBranch: 'main',
          baseCommit: 'base',
          changed: [],
          commit: 'c'.repeat(40),
          workflowFile: 'release.yaml',
        },
        snapshot: true,
        branch: 'mirror-sync-new',
        corvidaeCommit: older,
        corvidaeRoot: root,
        log: () => {},
      });
      expect(events).not.toContain('dispatch');
      expect(events).toContain(`close ${newNumber}`);
      expect(message).toContain('superseded');
    });
  });

  test('a current snapshot dispatch dispatches before it closes the older pull requests', async () => {
    await withCorvidae(async ({ older, newer }, root) => {
      const { api, events } = fake([record(11)], { 'head-11': trailer(older) });
      await openSyncPullRequest({
        api,
        target: 'weft',
        manifest: {
          baseBranch: 'main',
          baseCommit: 'base',
          changed: [],
          commit: 'c'.repeat(40),
          workflowFile: 'release.yaml',
        },
        snapshot: true,
        branch: 'mirror-sync-new',
        corvidaeCommit: newer,
        corvidaeRoot: root,
        log: () => {},
      });
      const order = events.filter((event) => /^(create|dispatch|close)/.test(event));
      expect(order).toEqual(['create', 'dispatch', 'close 11']);
    });
  });

  const skipManifest = {
    baseBranch: 'main',
    baseCommit: 'base-sha',
    workflowFile: 'release.yaml',
  } as const;

  test('a skip-path snapshot is not dispatched while a strictly newer sync pull request is open', async () => {
    await withCorvidae(async ({ older, newer }, root) => {
      const { api, events } = fake([record(11)], { 'head-11': trailer(newer) });
      const logged: string[] = [];
      const message = await settleSkippedSync({
        api,
        target: 'weft',
        manifest: skipManifest,
        snapshot: true,
        branch: 'mirror-sync-new',
        corvidaeCommit: older,
        corvidaeRoot: root,
        log: (line) => logged.push(line),
      });
      expect(events).toEqual([]);
      expect(logged.join('\n')).toContain('#11');
      expect(message).toContain('nothing dispatched or closed');
    });
  });

  test('a skip-path snapshot is dispatched when no open sync pull request is newer', async () => {
    await withCorvidae(async ({ older, newer }, root) => {
      const { api, events } = fake([record(11), record(12, { author: 'someone-else' })], {
        'head-11': trailer(older),
        'head-12': trailer(newer),
      });
      const message = await settleSkippedSync({
        api,
        target: 'weft',
        manifest: skipManifest,
        snapshot: true,
        branch: 'mirror-sync-new',
        corvidaeCommit: newer,
        corvidaeRoot: root,
        log: () => {},
      });
      // The older pull request is obsolete too: dispatch first, then close it.
      expect(events.filter((event) => /^(dispatch|close)/.test(event))).toEqual([
        'dispatch',
        'close 11',
      ]);
      expect(message).toContain('snapshot workflow dispatched');
    });
  });

  test('a non-snapshot skip closes an older sync pull request whose trailer is an ancestor', async () => {
    await withCorvidae(async ({ older, newer, side }, root) => {
      const { api, events } = fake(
        [record(11), record(12), record(13, { author: 'someone-else' })],
        {
          'head-11': trailer(older),
          'head-12': trailer(side),
          'head-13': trailer(older),
        },
      );
      const message = await settleSkippedSync({
        api,
        target: 'weft',
        manifest: skipManifest,
        snapshot: false,
        branch: 'mirror-sync-new',
        corvidaeCommit: newer,
        corvidaeRoot: root,
        log: () => {},
      });
      expect(events.filter((event) => event.startsWith('close'))).toEqual(['close 11']);
      expect(events.find((event) => event.startsWith('comment 11'))).toContain(
        'already matches the target',
      );
      expect(events).not.toContain('dispatch');
      expect(message).toContain('closed');
    });
  });

  test('a skip with a strictly newer open sync pull request closes nothing, with or without a snapshot', async () => {
    await withCorvidae(async ({ older, newer }, root) => {
      for (const snapshot of [false, true]) {
        const { api, events } = fake([record(11), record(12)], {
          'head-11': trailer(newer),
          'head-12': trailer(older),
        });
        await settleSkippedSync({
          api,
          target: 'weft',
          manifest: skipManifest,
          snapshot,
          branch: 'mirror-sync-new',
          corvidaeCommit: older,
          corvidaeRoot: root,
          log: () => {},
        });
        expect(events).toEqual([]);
      }
    });
  });

  test('a sync of the same corvidae commit closes the earlier attempt', async () => {
    await withCorvidae(async ({ newer }, root) => {
      const { api, events } = fake([record(11)], { 'head-11': trailer(newer) });
      await supersedeOlderPullRequests({
        api,
        corvidaeRoot: root,
        fullName: 'stevekinney/weft',
        base: 'main',
        newPullRequest: { number: newNumber, htmlUrl: 'https://example.test/pr/20' },
        newCorvidaeCommit: newer,
        log: () => {},
      });
      expect(events.some((event) => event === 'close 11')).toBe(true);
    });
  });

  test('opens the new pull request first, and a failed close fails the job after it exists', async () => {
    await withCorvidae(async ({ older, newer }, root) => {
      const { api, events } = fake(
        [record(11), record(12)],
        { 'head-11': trailer(older), 'head-12': trailer(older) },
        new Set([11]),
      );
      const failure = await throwingRejectionOf(
        openSyncPullRequest({
          api,
          target: 'weft',
          manifest: { baseBranch: 'main', baseCommit: 'base', changed: [], commit: 'c'.repeat(40) },
          snapshot: false,
          branch: 'mirror-sync-new',
          corvidaeCommit: newer,
          corvidaeRoot: root,
          log: () => {},
        }),
      );
      expect(failure).toThrow(/#11: HTTP 500 closing 11/);
      expect(events[0]).toBe('create');
      // The other superseded pull request was still attempted before the job failed.
      expect(events).toContain('close 12');
    });
  });

  test('a clean publish returns the opened message and leaves unrelated pull requests alone', async () => {
    await withCorvidae(async ({ newer }, root) => {
      const { api, events } = fake([record(15, { author: 'someone-else' })], {});
      const message = await openSyncPullRequest({
        api,
        target: 'weft',
        manifest: {
          baseBranch: 'main',
          baseCommit: 'base',
          changed: ['a'],
          commit: 'c'.repeat(40),
        },
        snapshot: false,
        branch: 'mirror-sync-new',
        corvidaeCommit: newer,
        corvidaeRoot: root,
        log: () => {},
      });
      expect(message).toBe(`weft: opened https://github.com/stevekinney/weft/pull/${newNumber}\n`);
      expect(events).toEqual(['create']);
    });
  });
});
