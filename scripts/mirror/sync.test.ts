import { describe, expect, spyOn, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  outcomeOf,
  rethrow,
  SCENARIO_HANG_GUARD_MILLISECONDS,
} from '../module-scope-scenario.test-support.ts';
import { throwingRejectionOf } from '../promise-outcome.test-support.ts';
import { loadPackageMap } from './package-map.ts';
import { loadPackageSurface } from './package-surface.ts';
import { runCommand } from './packaging.ts';
import { planSurface } from './surface.ts';
import {
  assertBuildInputsPresent,
  assertNoForeignCommits,
  assertPrivateWorkspacesCheckable,
  BuildInputError,
  cloneTarget,
  collectMissingBuildInputs,
  credentialedGitEnvironment,
  directPushEnvironment,
  findForeignCommits,
  ForeignCommitError,
  foreignCommitOwnership,
  git,
  gitEnvironment,
  newestMirrorProvenance,
  provenanceTrailer,
  runSync,
  stageSurface,
  SyncError,
  type PullRequestOptions,
  type SyncResult,
} from './sync.ts';
import { loadTargetOwnedPolicy } from './target-owned.ts';

// The end-to-end scenarios clone, install, build, pack and import a package, some twice. They
// keep the 300-second budget they had as tests as their hang guard, not the 120-second default.
const END_TO_END_BUDGET_MILLISECONDS = 300_000;

describe('gitEnvironment', () => {
  test('excludes App signing credentials while preserving push authentication', () => {
    const environment = gitEnvironment({
      MIRROR_APP_PRIVATE_KEY: 'test-key',
      MIRROR_APP_PRIVATE_KEY_FILE: '/test/key.pem',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer test-token',
    });
    expect(environment).not.toHaveProperty('MIRROR_APP_PRIVATE_KEY');
    expect(environment).not.toHaveProperty('MIRROR_APP_PRIVATE_KEY_FILE');
    expect(environment['GIT_CONFIG_VALUE_0']).toBe('Authorization: Bearer test-token');
  });
  test('disables hooks the target may have armed in the clone', () => {
    // husky writes `core.hooksPath` into the clone's LOCAL config, which `GIT_CONFIG_GLOBAL` and
    // `GIT_CONFIG_SYSTEM` do not reach. Injecting it through `GIT_CONFIG_*` covers every git
    // command the sync runs — the push as well as the commit.
    const environment = gitEnvironment({});
    expect(environment['GIT_CONFIG_COUNT']).toBe('1');
    expect(environment['GIT_CONFIG_KEY_0']).toBe('core.hooksPath');
    expect(environment['GIT_CONFIG_VALUE_0']).toBe('/dev/null');
  });

  test('appends to an inherited GIT_CONFIG_COUNT rather than overwriting index 0', () => {
    // Nothing sets these today. Hardcoding index 0 would silently drop the caller's entry and
    // clobber its key the first time something did, in an environment nobody tested.
    const environment = gitEnvironment({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'someone',
      GIT_CONFIG_KEY_1: 'core.pager',
      GIT_CONFIG_VALUE_1: 'cat',
    });
    expect(environment['GIT_CONFIG_COUNT']).toBe('3');
    expect(environment['GIT_CONFIG_KEY_0']).toBe('user.name');
    expect(environment['GIT_CONFIG_KEY_1']).toBe('core.pager');
    expect(environment['GIT_CONFIG_KEY_2']).toBe('core.hooksPath');
    expect(environment['GIT_CONFIG_VALUE_2']).toBe('/dev/null');
  });

  test('ignores an unusable inherited count rather than producing a broken one', () => {
    // git reads keys 0..count-1, so a malformed count must not make this emit a gap.
    for (const count of ['', 'not-a-number', '0', '-3']) {
      const environment = gitEnvironment({ GIT_CONFIG_COUNT: count });
      expect(environment['GIT_CONFIG_COUNT']).toBe('1');
      expect(environment['GIT_CONFIG_KEY_0']).toBe('core.hooksPath');
    }
  });
});

describe('credentialedGitEnvironment', () => {
  /**
   * `{ ...gitEnvironment(), ...credential }` — what a credentialed push used to compose — lets
   * the credential's own `GIT_CONFIG_COUNT: '1'`/`GIT_CONFIG_KEY_0` overwrite `gitEnvironment`'s
   * `core.hooksPath` entry wholesale, silently un-neutralizing hooks on exactly the git command
   * that pushes into a target. This is the regression test for the fix: both the credential and
   * the hook neutralization have to survive, at different indices.
   */
  test('appends hook neutralization after the credential rather than overwriting it', () => {
    const credential = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer token',
    };
    const environment = credentialedGitEnvironment(credential, {});
    expect(environment['GIT_CONFIG_COUNT']).toBe('2');
    expect(environment['GIT_CONFIG_KEY_0']).toBe('http.https://github.com/.extraHeader');
    expect(environment['GIT_CONFIG_VALUE_0']).toBe('Authorization: Bearer token');
    expect(environment['GIT_CONFIG_KEY_1']).toBe('core.hooksPath');
    expect(environment['GIT_CONFIG_VALUE_1']).toBe('/dev/null');
    expect(environment['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(environment['GIT_CONFIG_SYSTEM']).toBe('/dev/null');
  });

  test('carries the base environment through, not just the credential', () => {
    const environment = credentialedGitEnvironment(
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b' },
      { PATH: '/usr/bin' },
    );
    expect(environment['PATH']).toBe('/usr/bin');
  });
});

describe('direct push credentials', async () => {
  test('keeps local pushes credential-free, lazily authenticates GitHub, and rejects other hosts', async () => {
    let requests = 0;
    const provider = async () => {
      requests += 1;
      return {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
        GIT_CONFIG_VALUE_0: 'Authorization: Basic trusted-token',
      };
    };

    expect(await directPushEnvironment('/tmp/mirror.git', provider)).toEqual({});
    expect(requests).toBe(0);
    expect(
      await directPushEnvironment('https://github.com/stevekinney/mirror.git', provider),
    ).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic trusted-token',
    });
    expect(requests).toBe(1);
    expect(
      await throwingRejectionOf(
        directPushEnvironment('https://gitlab.com/stevekinney/mirror.git', provider),
      ),
    ).toThrow('only supports GitHub HTTPS remotes');
    expect(
      await throwingRejectionOf(
        directPushEnvironment('https://user:password@github.com/stevekinney/mirror.git', provider),
      ),
    ).toThrow('without URL credentials');
    expect(
      await throwingRejectionOf(
        directPushEnvironment('https://github.com:8443/stevekinney/mirror.git', provider),
      ),
    ).toThrow('only supports GitHub HTTPS remotes');
    expect(requests).toBe(1);
  });

  // Real local remotes, clones, installs and packs (or a fresh `bun -e` child) are the behavior; they run at module scope, off the per-test clock.
  const outcome1 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      const report = join(harness.scratch, 'direct-push-environment.json');
      const rewrite = join(harness.scratch, 'git-rewrite.config');
      await Bun.write(
        rewrite,
        `[url "${harness.remote}"]\n\tinsteadOf = https://github.com/stevekinney/agent-bureau.git\n`,
      );
      const authenticatedPush = join(import.meta.dir, 'authenticated-push.ts');
      const syncModule = join(import.meta.dir, 'sync.ts');
      const script = `
        import { mock } from 'bun:test';
        import { writeFile } from 'node:fs/promises';
        const report = ${JSON.stringify(report)};
        mock.module(${JSON.stringify(authenticatedPush)}, () => ({
          pushVerifiedCommit: async (options) => {
            await writeFile(report, JSON.stringify(await options.credentialEnvironment()));
          },
        }));
        const { runSync } = await import(${JSON.stringify(syncModule)});
        await runSync({
          corvidaeRoot: ${JSON.stringify(harness.corvidae)},
          target: 'agent-bureau',
          remote: 'https://github.com/stevekinney/agent-bureau.git',
          directory: ${JSON.stringify(harness.runDirectory('subprocess'))},
          scratchDirectory: ${JSON.stringify(join(harness.scratch, 'subprocess'))},
          corvidaeCommit: 'corvidae-subprocess',
          pushEnvironment: async () => ({
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
            GIT_CONFIG_VALUE_0: 'Authorization: Basic trusted-subprocess-token',
          }),
        });
      `;
      const process_ = Bun.spawn(['bun', '-e', script], {
        timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
        cwd: join(import.meta.dir, '../..'),
        env: {
          ...Bun.env,
          GIT_CONFIG_GLOBAL: rewrite,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `url.${harness.remote}.insteadOf`,
          GIT_CONFIG_VALUE_0: 'https://github.com/stevekinney/agent-bureau.git',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await process_.exited;
      const stderr = await new Response(process_.stderr).text();
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
        GIT_CONFIG_VALUE_0: 'Authorization: Basic trusted-subprocess-token',
      });
    });
  });
  test('runSync resolves the trusted provider through the verified push callback', () =>
    rethrow(outcome1));
});

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
    workspace: '@lostgradient/cryptography',
    publicName: '@lostgradient/cryptography',
    source: 'export const digest = (value: string): string => `sha256:${value}`;\n',
    staleSource: 'export const digest = (value: string): string => `stale:${value}`;\n',
  },
  'packages/lifecycle': {
    workspace: '@lostgradient/lifecycle',
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
    name: '@lostgradient/typescript',
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
 * A private workspace is the one class the packaging checks say nothing about: nothing packs it,
 * so `typecheck` in the target is the only thing that reads the source the mirror now publishes
 * for it. Without one in the fixture that path would never run.
 *
 * `@lostgradient/skills` rather than `@lostgradient/testing` since COR-1287: this harness plans
 * the agent-bureau target, because that is where `targetFor` now routes the two published
 * packages it has always used, and `@lostgradient/testing` ships from cinder. Skills is the same
 * class of workspace in the target this harness now stands up — private in the map, private in
 * the target, TypeScript source and a typecheck script.
 */
const privateWorkspaceDirectory = 'packages/skills';
const privateWorkspaceName = '@lostgradient/skills';

/**
 * COR-1286: `renderMirrorVerifyWorkflow` reads `publint`'s and `@arethetypeswrong/cli`'s locked
 * versions straight out of `bun.lock` rather than a `package.json` range — a minimal, real-shaped
 * stand-in in the same text-lockfile format `readLockedVersion`'s regex reads, not a fixture-only
 * shortcut. Written as a raw string (`writeTree` serializes anything else through `JSON.stringify`,
 * which would re-quote this into something the regex no longer matches the way a real `bun.lock`
 * does).
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

function corvidaeFixture(): Record<string, unknown> {
  const files: Record<string, unknown> = {
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
    ...sharedTypeScriptConfiguration,
  };
  files[`${privateWorkspaceDirectory}/package.json`] = {
    name: privateWorkspaceName,
    private: true,
    type: 'module',
    exports: { '.': './src/index.ts' },
    scripts: { typecheck: 'tsc --noEmit' },
    devDependencies: {
      '@lostgradient/typescript': 'workspace:*',
      '@types/bun': 'catalog:',
      typescript: 'catalog:',
    },
  };
  files[`${privateWorkspaceDirectory}/tsconfig.json`] = {
    extends: '@lostgradient/typescript/library.json',
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
        '@lostgradient/typescript': 'workspace:*',
        '@types/bun': 'catalog:',
        typescript: 'catalog:',
      },
    };
    files[`${directory}/tsconfig.json`] = {
      extends: '@lostgradient/typescript/library.json',
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

const stagedIndexTamperingTsdownConfiguration = `import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsdown';

const repositoryRoot = join(import.meta.dirname, '../..');
const originalReadme = readFileSync(join(repositoryRoot, 'README.md'), 'utf8');
writeFileSync(join(repositoryRoot, 'README.md'), '# staged payload\\n');
const staged = spawnSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
if (staged.status !== 0) throw new Error(staged.stderr?.toString() ?? 'git add failed');
const restored = spawnSync('git', ['restore', '--source=HEAD', '--worktree', 'README.md'], {
  cwd: repositoryRoot,
});
if (restored.status !== 0) throw new Error(restored.stderr?.toString() ?? 'git restore failed');
if (readFileSync(join(repositoryRoot, 'README.md'), 'utf8') !== originalReadme) {
  throw new Error('git restore did not restore the original worktree content');
}

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
/**
 * COR-1286: `verifyTarget` reads the target's release workflow for the Bun version and install
 * line `mirror-verify.yaml` pins to — a minimal, real-shaped stand-in for weft's own
 * `.github/workflows/release.yaml`, not a fixture-only string, so the workflow renderer exercises
 * the exact `readReleaseWorkflowBunVersion`/`readWorkflowInstalls` reads a live sync would make.
 */
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

function targetFixture(): Record<string, unknown> {
  const files: Record<string, unknown> = {
    'README.md': '# agent-bureau\n\nTarget-authored front page.\n',
    LICENSE: licence,
    // Only `node_modules` is ignored, deliberately. The build's `dist/` and any
    // `tsconfig.tsbuildinfo` are left visible to git so that a sync which staged after building
    // would sweep them into the mirror and fail the assertion below, rather than being hidden by
    // a fixture that happens to ignore more than a real target might.
    '.gitignore': 'node_modules\n',
    [targetOwnedInsideSource]: '# Agent instructions the target wrote for itself\n',
    [unknownTargetFile]: '# A working document nobody enumerated\n',
    '.github/workflows/release.yaml': fixtureReleaseWorkflow,
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
async function withHarness(
  body: (harness: Harness) => Promise<void>,
  targetFiles = targetFixture(),
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-sync-'));
  try {
    const remote = join(root, 'remote.git');
    await mkdir(remote, { recursive: true });
    await git(remote, 'init', '--bare', '--quiet', '--initial-branch=main');

    const seed = join(root, 'seed');
    await mkdir(seed, { recursive: true });
    await git(seed, 'clone', '--no-local', '--quiet', remote, seed);
    await writeTree(seed, targetFiles);
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

// Real local remotes, clones, installs and packs (or a fresh `bun -e` child) are the behavior; they run at module scope, off the per-test clock.
const outcome2 = await outcomeOf(async () => {
  await withHarness(async (harness) => {
    await Bun.write(join(harness.remote, 'objects/maintenance.lock'), 'transient\n');
    const clone = await cloneTarget({
      remote: harness.remote,
      directory: harness.runDirectory('maintenance-lock'),
    });
    expect(await Bun.file(join(clone, '.git/objects/maintenance.lock')).exists()).toBe(false);
  });
});
test('cloneTarget does not copy a transient local Git maintenance lock', () => rethrow(outcome2));

async function sync(harness: Harness, label: string): Promise<SyncResult> {
  return runSync({
    corvidaeRoot: harness.corvidae,
    target: 'agent-bureau',
    remote: harness.remote,
    directory: harness.runDirectory(label),
    scratchDirectory: join(harness.scratch, label),
    corvidaeCommit: `corvidae-${label}`,
  });
}

describe('the mirror sync against a fake remote', async () => {
  // Real local remotes, clones, installs and packs (or a fresh `bun -e` child) are the behavior; they run at module scope, off the per-test clock.
  const outcome3 = await outcomeOf(async () => {
    const targetFiles = targetFixture();
    targetFiles[`${privateWorkspaceDirectory}/package.json`] = {
      name: privateWorkspaceName,
      private: true,
      scripts: { build: 'bun -e "process.exit(23)"', typecheck: 'tsc --noEmit' },
    };
    await withHarness(async (harness) => {
      expect(await throwingRejectionOf(sync(harness, 'private-build-failure'))).toThrow(
        `running build for ${privateWorkspaceName}`,
      );
    }, targetFiles);
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('a failing target-owned private build aborts verification', () => rethrow(outcome3));

  const outcome4 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      const first = await sync(harness, 'first');

      expect(first.decision).toBe('pushed');
      expect(first.changed.length).toBeGreaterThan(0);
      // `firstPublish` is every manifest emitted at 0.0.0: the private workspace always
      // qualifies (nothing publishes `@lostgradient/skills`, so its name reads wider than what
      // it reports), and a `publish-as` fixture workspace qualifies only while the real,
      // committed `package-map.json` still records no `lastPublishedVersion` for it. Derived
      // from that map rather than pinned as a literal, so a fixture workspace's own first
      // publish (COR-1198 published both `@lostgradient/cryptography` and
      // `@lostgradient/lifecycle`) does not silently go stale here. `@lostgradient/typescript`
      // was in this list until COR-1287 and is not a regression by its absence: it ships from
      // the cinder target, so the agent-bureau plan vendors its configuration rather than
      // emitting a manifest for it, exactly as the weft plan always has.
      const map = await loadPackageMap();
      const expectedFirstPublish: string[] = Object.values(fixturePackages)
        .filter((entry) => {
          const disposition = map.workspaces[entry.workspace];
          return (
            disposition?.disposition === 'publish-as' && disposition.lastPublishedVersion === null
          );
        })
        .map((entry) => entry.publicName);
      expectedFirstPublish.push(privateWorkspaceName);
      expect(first.firstPublish.toSorted()).toEqual(expectedFirstPublish.toSorted());
      // The private workspace is type-checked in the target even though nothing packs it: its
      // source ships now, and `typecheck` is the only check that reads it.
      expect(first.verification.privateTypechecks).toEqual([privateWorkspaceName]);
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
      // Authored as the mirror App's bot account, in the form GitHub attributes to it. The first
      // real sync was refused a merge as an "unattributed change" under the target's ruleset
      // because its author was a placeholder no account could be linked to.
      const author = await git(harness.remote, 'log', '-1', '--format=%an <%ae>');
      expect(author.trim()).toBe(
        'lost-gradient-mirror-sync[bot] <331123939+lost-gradient-mirror-sync[bot]@users.noreply.github.com>',
      );

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
        afterVerification.split('\n').filter((line) => line.length > 0 && !line.includes('dist/')),
      ).toEqual([]);
      // Nothing new landed on the remote, so the skip really skipped.
      const commitCount = await git(harness.remote, 'rev-list', '--count', 'main');
      expect(commitCount.trim()).toBe('2');
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('transforms, verifies, pushes, and then reports skip on an identical second run', () =>
    rethrow(outcome4));

  const outcome5 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      await sync(harness, 'first');
      // The mutation has to be something the transform owns, and since COR-1223 that is a much
      // shorter list than corvidae's whole manifest. A new `description` used to serve here and
      // no longer can: package metadata is target-owned now, so adding one to corvidae is
      // correctly a no-op downstream, and this test would have gone on passing for the wrong
      // reason once the first sync had given the target a manifest to own. Source is the thing
      // the mirror exists to carry and is transform-owned outright, so it is what this mutates.
      const changedSource = 'export const digest = (value: string): string => `sha512:${value}`;\n';
      await Bun.write(join(harness.corvidae, 'packages/cryptography/src/index.ts'), changedSource);

      const second = await sync(harness, 'second');
      expect(second.decision).toBe('pushed');
      expect(second.changed.join('\n')).toContain('packages/cryptography/src/index.ts');
      expect(
        await readFile(join(second.directory, 'packages/cryptography/src/index.ts'), 'utf8'),
      ).toBe(changedSource);
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('a real change is still detected, so the skip above is not vacuous', () =>
    rethrow(outcome5));

  const outcome6 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      const attacker = join(harness.scratch, 'attacker');
      await mkdir(harness.scratch, { recursive: true });
      await git(harness.scratch, 'clone', '--no-local', '--quiet', harness.remote, attacker);
      await Bun.write(
        join(attacker, 'packages/cryptography/tsdown.config.ts'),
        stagedIndexTamperingTsdownConfiguration,
      );
      await git(attacker, 'add', '--all');
      await git(attacker, 'commit', '--quiet', '--message', 'Target changes its build input');
      await git(attacker, 'push', '--quiet', 'origin', 'HEAD:main');

      expect(await throwingRejectionOf(sync(harness, 'staged-tamper'))).toThrow(
        /staged tree changed during verification/,
      );
      const commitCount = await git(harness.remote, 'rev-list', '--count', 'main');
      expect(commitCount.trim()).toBe('2');
      const committedPaths = await git(harness.remote, 'show', '--format=', '--name-only', 'HEAD');
      expect(committedPaths.trim()).toContain('packages/cryptography/tsdown.config.ts');
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('refuses a staged payload that verification restores from the working tree', () =>
    rethrow(outcome6));
});

/**
 * COR-1195: the workflow-dispatch path never pushes straight to a target's default branch. It
 * commits on a fresh branch and opens a pull request instead, so the target's own emitted
 * `mirror-verify.yaml` gates the exact diff before anything reaches `main`. `pushEnvironment` and
 * `openPullRequest` are faked here rather than driven through a real `GitHubApi`: the credential
 * composition itself is `credentialedGitEnvironment`'s own test above, and opening a pull request
 * over HTTP is `github-api.test.ts`'s. What this harness can prove that neither of those can is
 * the ordering `runSync` itself is responsible for — the branch is created, the target's default
 * branch is never written to, and `openPullRequest` sees the branch that was actually pushed.
 */
function fakePullRequest(branch: string): {
  options: PullRequestOptions;
  opened: { branch: string; base: string; commit: string; changed: readonly string[] }[];
} {
  const opened: { branch: string; base: string; commit: string; changed: readonly string[] }[] = [];
  return {
    opened,
    options: {
      branch,
      pushEnvironment: async () => ({}),
      openPullRequest: async (info) => {
        opened.push(info);
        return { number: 7, htmlUrl: `https://github.com/stevekinney/agent-bureau/pull/7` };
      },
    },
  };
}

describe('runSync in pull-request mode', async () => {
  // Real local remotes, clones, installs and packs (or a fresh `bun -e` child) are the behavior; they run at module scope, off the per-test clock.
  const outcome7 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      const before = await git(harness.remote, 'show-ref');
      const result = await runSync({
        corvidaeRoot: harness.corvidae,
        target: 'agent-bureau',
        remote: harness.remote,
        directory: harness.runDirectory('prepared'),
        scratchDirectory: join(harness.scratch, 'prepared'),
        corvidaeCommit: 'a'.repeat(40),
        prepareBranch: 'mirror-prepared',
        pushEnvironment: async () => {
          throw new Error('Preparation requested credentials');
        },
      });
      expect(result.decision).toBe('prepared');
      expect(result.baseBranch).toBe('main');
      expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(result.verification.reports.length).toBeGreaterThan(0);
      expect(result.pullRequest).toBeUndefined();
      expect(await git(harness.remote, 'show-ref')).toBe(before);
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('prepares a verified commit without credentials or remote writes', () => rethrow(outcome7));

  const outcome8 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      const { options, opened } = fakePullRequest('mirror-sync-abc123');
      const poisoned = await cloneTarget({
        remote: harness.remote,
        directory: harness.runDirectory('poisoned-build'),
      });
      const marker = join(harness.scratch, 'credential-helper-ran');
      const helper = join(harness.scratch, 'untrusted-helper');
      await Bun.write(helper, `#!/bin/sh\nprintf invoked > '${marker}'\nexit 1\n`);
      await chmod(helper, 0o700);
      const maliciousConfiguration = `\n[remote "origin"]\n pushurl = ext::${helper}\n[protocol "ext"]\n allow = always\n`;
      await Bun.write(
        join(poisoned, 'packages/cryptography/tsdown.config.ts'),
        `import { appendFileSync } from 'node:fs';\nappendFileSync('../../.git/config', ${JSON.stringify(maliciousConfiguration)});\n${tsdownConfiguration}`,
      );
      await git(poisoned, 'add', '--all');
      await git(poisoned, 'commit', '-m', 'Target build changes local Git configuration');
      await git(poisoned, 'push', 'origin', 'HEAD');
      options.pushEnvironment = async () => {
        expect(
          await Bun.file(join(harness.runDirectory('pull-request'), '.git/config')).text(),
        ).toContain('pushurl = ext::');
        return {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
          GIT_CONFIG_VALUE_0: 'Authorization: Bearer harmless-test-sentinel',
        };
      };
      const result = await runSync({
        corvidaeRoot: harness.corvidae,
        target: 'agent-bureau',
        remote: harness.remote,
        directory: harness.runDirectory('pull-request'),
        scratchDirectory: join(harness.scratch, 'pull-request'),
        corvidaeCommit: 'corvidae-pull-request',
        pullRequest: options,
      });

      expect(result.decision).toBe('pushed');
      expect(await Bun.file(marker).exists()).toBe(false);
      // `commit` is only ever absent on a skip, and the assertion just above ruled that out;
      // narrowed explicitly so the comparisons below type-check against a plain `string`
      // rather than `string | undefined`.
      if (!result.commit) throw new Error('expected runSync to report a commit');
      const commit = result.commit;
      expect(result.pullRequest).toEqual({
        number: 7,
        htmlUrl: 'https://github.com/stevekinney/agent-bureau/pull/7',
      });
      expect(opened).toHaveLength(1);
      expect(opened[0]?.branch).toBe('mirror-sync-abc123');
      expect(opened[0]?.base).toBe('main');
      expect(opened[0]?.commit).toBe(commit);
      expect(opened[0]?.changed.length).toBeGreaterThan(0);

      // `main` never moved: it still contains only the seed and target build commits.
      const mainCommitCount = await git(harness.remote, 'rev-list', '--count', 'main');
      expect(mainCommitCount.trim()).toBe('2');
      const mainHead = await git(harness.remote, 'rev-parse', 'main');

      // The sync branch exists on the remote, its tip is the commit `openPullRequest` was
      // told about, and it carries the provenance trailer and the mirror's own identity —
      // exactly as the direct-push path's commit does.
      const branchHead = await git(harness.remote, 'rev-parse', 'refs/heads/mirror-sync-abc123');
      expect(branchHead.trim()).toBe(commit);
      expect(branchHead.trim()).not.toBe(mainHead.trim());
      const message = await git(
        harness.remote,
        'log',
        '-1',
        '--format=%B',
        'refs/heads/mirror-sync-abc123',
      );
      expect(message).toContain(`${provenanceTrailer}: corvidae-pull-request`);
      const author = await git(
        harness.remote,
        'log',
        '-1',
        '--format=%an <%ae>',
        'refs/heads/mirror-sync-abc123',
      );
      expect(author.trim()).toBe(
        'lost-gradient-mirror-sync[bot] <331123939+lost-gradient-mirror-sync[bot]@users.noreply.github.com>',
      );
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('commits on a new branch, leaves the default branch untouched, and opens a pull request', () =>
    rethrow(outcome8));

  const outcome9 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      // Sync once directly so the target already carries corvidae's bytes, leaving the second,
      // pull-request-mode run with nothing to change.
      await sync(harness, 'seed-first');

      const { options, opened } = fakePullRequest('mirror-sync-noop');
      const result = await runSync({
        corvidaeRoot: harness.corvidae,
        target: 'agent-bureau',
        remote: harness.remote,
        directory: harness.runDirectory('pull-request-noop'),
        scratchDirectory: join(harness.scratch, 'pull-request-noop'),
        corvidaeCommit: 'corvidae-pull-request-noop',
        pullRequest: options,
      });

      expect(result.decision).toBe('skip');
      expect(result.pullRequest).toBeUndefined();
      expect(opened).toEqual([]);
      // No sync branch was ever pushed.
      const branches = await git(harness.remote, 'branch', '--list', 'mirror-sync-noop');
      expect(branches.trim()).toBe('');
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('opens nothing when the transform produces no change', () => rethrow(outcome9));
});

describe('the foreign-commit guard', async () => {
  // Real local remotes, clones, installs and packs (or a fresh `bun -e` child) are the behavior; they run at module scope, off the per-test clock.
  const outcome10 = await outcomeOf(async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-mixed-manifest-'));
    try {
      await git(root, 'init', '--quiet', '--initial-branch=main');
      const path = 'packages/editor/package.json';
      const original = { name: '@lostgradient/editor', version: '0.15.0', files: ['dist'] };
      const generated = {
        ...original,
        files: ['dist', '!src/**/*.test.ts', '!src/**/__tests__/**'],
      };
      await Bun.write(join(root, path), `${JSON.stringify(original)}\n`);
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Mirror\n\n${provenanceTrailer}: ${'a'.repeat(40)}`,
      );

      await Bun.write(join(root, path), `${JSON.stringify(generated)}\n`);
      await Bun.write(
        join(root, 'packages/editor/scripts/check-weight.ts'),
        'export const limit = 550;\n',
      );
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Correct Editor packaging and budget');
      const ownership = {
        policy: await loadTargetOwnedPolicy(),
        target: 'cinder',
        transform: { files: new Set([path]), prefixes: [] },
        generatedManifestKeys: new Map([[path, generated]]),
      };
      expect(await findForeignCommits(root, ownership)).toEqual([]);

      const unexpected = { ...generated, files: ['dist', '!src/**'] };
      await Bun.write(join(root, path), `${JSON.stringify(unexpected)}\n`);
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Change generated files unexpectedly');
      const foreign = await findForeignCommits(root, ownership);
      expect(foreign.map(({ subject }) => subject)).toEqual([
        'Change generated files unexpectedly',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('accepts a mixed target commit only when its generated manifest keys match the trusted plan', () =>
    rethrow(outcome10));

  const outcome11 = await outcomeOf(async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-emitted-match-'));
    try {
      await git(root, 'init', '--quiet', '--initial-branch=main');
      const path = 'packages/weft/README.md';
      await Bun.write(join(root, path), 'Six binaries.\n');
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Mirror\n\n${provenanceTrailer}: ${'a'.repeat(40)}`,
      );

      await Bun.write(join(root, path), 'Five signed binaries.\n');
      await Bun.write(join(root, 'packages/weft/scripts/build-binary.ts'), 'export {};\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Sign compiled binaries');
      const policy = await loadTargetOwnedPolicy();
      const ownership = (contents: string, executable = false) => ({
        policy,
        target: 'weft',
        transform: { files: new Set([path]), prefixes: [] },
        generatedFiles: new Map([
          [path, { contents: new TextEncoder().encode(contents), executable }],
        ]),
      });
      const foreignSubjects = async (
        options: Parameters<typeof findForeignCommits>[1],
      ): Promise<string[]> => {
        const foreign = await findForeignCommits(root, options);
        return foreign.map(({ subject }) => subject);
      };

      expect(await foreignSubjects(ownership('Five signed binaries.\n'))).toEqual([]);
      expect(await foreignSubjects(ownership('Six binaries.\n'))).toEqual([
        'Sign compiled binaries',
      ]);
      expect(
        await foreignSubjects({
          ...ownership('Five signed binaries.\n'),
          generatedFiles: undefined,
        }),
      ).toEqual(['Sign compiled binaries']);
      expect(await foreignSubjects(ownership('Five signed binaries.\n', true))).toEqual([
        'Sign compiled binaries',
      ]);

      await chmod(join(root, path), 0o755);
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Mark the readme executable');
      expect(await foreignSubjects(ownership('Five signed binaries.\n'))).toEqual([
        'Mark the readme executable',
      ]);

      await git(root, 'rm', '--quiet', path);
      await git(root, 'commit', '--quiet', '-m', 'Delete the emitted readme');
      expect(await foreignSubjects(ownership('Five signed binaries.\n'))).toEqual([
        'Delete the emitted readme',
        'Mark the readme executable',
      ]);

      // COR-1200 net-effect rule: the restore leaves HEAD at exactly this sync's emission, so the
      // sync clobbers nothing and the commits it undid are no longer foreign.
      await Bun.write(join(root, path), 'Five signed binaries.\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Restore the emitted readme');
      expect(await foreignSubjects(ownership('Five signed binaries.\n'))).toEqual([]);
      // A different emission is the same HEAD judged against other bytes: all four are foreign.
      expect(await foreignSubjects(ownership('Six binaries.\n'))).toEqual([
        'Restore the emitted readme',
        'Delete the emitted readme',
        'Mark the readme executable',
        'Sign compiled binaries',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('accepts a hand edit to an emitted file only when its bytes and mode match the trusted plan', () =>
    rethrow(outcome11));

  const outcome12 = await outcomeOf(async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-squash-tree-'));
    const remote = await mkdtemp(join(tmpdir(), 'mirror-squash-tree-remote-'));
    try {
      await git(remote, 'init', '--bare', '--quiet');
      await git(root, 'init', '--quiet', '--initial-branch=main');
      await git(root, 'remote', 'add', 'origin', remote);
      const path = 'packages/weft/src/version.ts';
      const ownership = {
        policy: await loadTargetOwnedPolicy(),
        target: 'weft' as const,
        transform: { files: new Set([path]), prefixes: [] },
      };
      await Bun.write(join(root, path), "export const VERSION = '0.27.0';\n");
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Mirror\n\n${provenanceTrailer}: ${'a'.repeat(40)}`,
      );
      const baseOutput = await git(root, 'rev-parse', 'HEAD');
      const base = baseOutput.trim();

      await Bun.write(join(root, path), "export const VERSION = '0.27.1';\n");
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Sync weft from corvidae\n\n${provenanceTrailer}: ${'b'.repeat(40)}`,
      );
      await git(root, 'push', '--quiet', 'origin', 'HEAD:refs/pull/123/head');
      await git(root, 'reset', '--hard', base);
      await Bun.write(join(root, path), "export const VERSION = '0.27.1';\n");
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Sync weft from corvidae (#123)');
      await Bun.write(join(root, 'README.md'), '# Release notes\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Document release');
      expect(await findForeignCommits(root, ownership)).toEqual([]);

      const releaseOutput = await git(root, 'rev-parse', 'HEAD');
      const release = releaseOutput.trim();
      await Bun.write(join(root, path), "export const VERSION = '0.27.2';\n");
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Sync weft from corvidae\n\n${provenanceTrailer}: ${'c'.repeat(40)}`,
      );
      await git(root, 'push', '--quiet', 'origin', 'HEAD:refs/pull/124/head');
      await git(root, 'reset', '--hard', release);
      await Bun.write(join(root, path), "export const VERSION = '0.27.3';\n");
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Sync weft from corvidae (#124)');
      await Bun.write(join(root, path), "export const VERSION = '0.27.4';\n");
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Sync weft from corvidae (#125)');
      const foreign = await findForeignCommits(root, ownership);
      expect(foreign.map(({ subject }) => subject)).toEqual([
        'Sync weft from corvidae (#125)',
        'Sync weft from corvidae (#124)',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });
  test('recognizes a squash that dropped provenance only when its pull-request head has the same tree', () =>
    rethrow(outcome12));

  const outcome13 = await outcomeOf(async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-squash-provenance-'));
    try {
      await git(root, 'init', '--quiet', '--initial-branch=main');
      const path = 'packages/weft/src/version.ts';
      const ownership = {
        policy: await loadTargetOwnedPolicy(),
        target: 'weft' as const,
        transform: { files: new Set([path]), prefixes: [] },
      };
      await Bun.write(join(root, path), "export const VERSION = '0.27.0';\n");
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Mirror\n\n${provenanceTrailer}: ${'a'.repeat(40)}`,
      );

      await Bun.write(join(root, path), "export const VERSION = '0.27.1';\n");
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Sync weft from corvidae (#123)\n\n${provenanceTrailer}: ${'b'.repeat(40)}\n\nCo-authored-by: mirror[bot] <123+mirror[bot]@users.noreply.github.com>`,
      );
      await Bun.write(join(root, 'README.md'), '# Release notes\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Document release');
      expect(await findForeignCommits(root, ownership)).toEqual([]);

      await Bun.write(
        join(root, path),
        "export const VERSION = '0.27.1';\nexport const changed = true;\n",
      );
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Change mirrored source');
      const foreign = await findForeignCommits(root, ownership);
      expect(foreign.map(({ subject }) => subject)).toEqual(['Change mirrored source']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('recognizes a GitHub squash merge with co-author metadata after mirror provenance', () =>
    rethrow(outcome13));

  const outcome14 = await outcomeOf(async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-version-release-'));
    try {
      await git(root, 'init', '--quiet', '--initial-branch=main');
      const directory = 'packages/weft';
      const manifestPath = `${directory}/package.json`;
      const versionPath = `${directory}/src/version.ts`;
      const ownership = {
        policy: await loadTargetOwnedPolicy(),
        target: 'weft' as const,
        versionConstantPaths: new Map([[versionPath, directory]]),
        transform: { files: new Set([manifestPath, versionPath]), prefixes: [] },
      };
      await Bun.write(
        join(root, manifestPath),
        '{"name":"@lostgradient/weft","version":"0.27.0"}\n',
      );
      await Bun.write(join(root, versionPath), "export const VERSION = '0.27.0';\n");
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Mirror\n\n${provenanceTrailer}: ${'a'.repeat(40)}`,
      );

      await Bun.write(
        join(root, manifestPath),
        '{"name":"@lostgradient/weft","version":"0.27.1"}\n',
      );
      await Bun.write(join(root, versionPath), "export const VERSION = '0.27.1';\n");
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Publish Weft 0.27.1');
      expect(await findForeignCommits(root, ownership)).toEqual([]);

      await Bun.write(
        join(root, versionPath),
        "export const VERSION = '0.27.1';\nexport const changed = true;\n",
      );
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Change source under release metadata');
      const foreign = await findForeignCommits(root, ownership);
      expect(foreign.map(({ subject }) => subject)).toEqual([
        'Change source under release metadata',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('accepts only a declared source version constant that follows the release manifest', () =>
    rethrow(outcome14));

  const outcome15 = await outcomeOf(async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-unsafe-version-release-'));
    try {
      await git(root, 'init', '--quiet', '--initial-branch=main');
      const directory = 'packages/weft';
      const manifestPath = `${directory}/package.json`;
      const versionPath = `${directory}/src/version.ts`;
      const ownership = {
        policy: await loadTargetOwnedPolicy(),
        target: 'weft' as const,
        versionConstantPaths: new Map([[versionPath, directory]]),
        transform: { files: new Set([manifestPath, versionPath]), prefixes: [] },
      };
      await Bun.write(join(root, manifestPath), '{"version":"0.27.0"}\n');
      await Bun.write(join(root, versionPath), "export const VERSION = '0.27.0';\n");
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Mirror\n\n${provenanceTrailer}: ${'a'.repeat(40)}`,
      );

      await git(root, 'switch', '-c', 'mode');
      await Bun.write(join(root, manifestPath), '{"version":"0.27.1"}\n');
      await Bun.write(join(root, versionPath), "export const VERSION = '0.27.1';\n");
      await chmod(join(root, versionPath), 0o755);
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Executable version source');
      const modeForeign = await findForeignCommits(root, ownership);
      expect(modeForeign.map(({ subject }) => subject)).toEqual(['Executable version source']);

      await git(root, 'switch', 'main');
      const injected = "0.27.1';\nsideEffect();//";
      await Bun.write(join(root, manifestPath), `${JSON.stringify({ version: injected })}\n`);
      await Bun.write(join(root, versionPath), `export const VERSION = '${injected}';\n`);
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Executable manifest version');
      const injectedForeign = await findForeignCommits(root, ownership);
      expect(injectedForeign.map(({ subject }) => subject)).toEqual([
        'Executable manifest version',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('rejects a version release that changes file mode or embeds source through its manifest', () =>
    rethrow(outcome15));

  const outcome16 = await outcomeOf(async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-transient-source-'));
    try {
      await git(root, 'init', '--quiet', '--initial-branch=main');
      const path = 'packages/cryptography/src/index.ts';
      await Bun.write(join(root, path), 'export const value = 0;\n');
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Mirror\n\n${provenanceTrailer}: ${'a'.repeat(40)}`,
      );
      await Bun.write(join(root, path), 'export const value = 1;\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Foreign source edit');
      const changedHead = await git(root, 'rev-parse', 'HEAD');
      const ownership = {
        policy: await loadTargetOwnedPolicy(),
        target: 'agent-bureau' as const,
        transform: { files: new Set([path]), prefixes: [] },
      };
      const stillChanged = await findForeignCommits(root, ownership);
      expect(stillChanged.map(({ sha }) => sha)).toEqual([changedHead.trim()]);
      // COR-1200 net-effect rule: the revert leaves HEAD at the mirror bytes, so the sync would
      // clobber nothing, and neither the edit nor its revert is foreign any longer.
      await git(root, 'revert', '--no-edit', 'HEAD');
      expect(await findForeignCommits(root, ownership)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('rejects a source edit while HEAD still differs from the mirror, and accepts it once a revert restores the mirror bytes', () =>
    rethrow(outcome16));

  const outcome17 = await outcomeOf(async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-foreign-merge-'));
    try {
      await git(root, 'init', '--quiet', '--initial-branch=main');
      const path = 'packages/cryptography/src/index.ts';
      await Bun.write(join(root, path), 'export const value = 1;\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Initial target');
      await git(root, 'checkout', '-b', 'older');
      await Bun.write(join(root, path), 'export const value = 2;\n');
      await git(root, 'add', '-A');
      const older = await runCommand(['git', 'commit', '--quiet', '-m', 'Older foreign source'], {
        cwd: root,
        env: {
          ...gitEnvironment(),
          GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
        },
      });
      expect(older.exitCode).toBe(0);
      await git(root, 'checkout', 'main');
      await Bun.write(join(root, 'README.md'), 'Mirror baseline\n');
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Mirror\n\n${provenanceTrailer}: ${'a'.repeat(40)}`,
      );
      await git(root, 'merge', '--no-ff', '--quiet', 'older', '-m', 'Merge older source');
      const mergeHead = await git(root, 'rev-parse', 'HEAD');
      const merge = mergeHead.trim();
      const foreign = await findForeignCommits(root, {
        policy: await loadTargetOwnedPolicy(),
        target: 'agent-bureau',
        transform: { files: new Set([path]), prefixes: [] },
      });
      expect(foreign.map(({ sha }) => sha)).toContain(merge);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('rejects source imported by a merge from an older side branch', () => rethrow(outcome17));

  const outcome18 = await outcomeOf(async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-owned-merge-'));
    try {
      await git(root, 'init', '--quiet', '--initial-branch=main');
      const path = 'packages/cryptography/src/index.ts';
      await Bun.write(join(root, path), 'export const value = 0;\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Initial target');
      await git(root, 'checkout', '-b', 'mirror');
      await Bun.write(join(root, path), 'export const value = 1;\n');
      await git(root, 'add', '-A');
      await git(
        root,
        'commit',
        '--quiet',
        '-m',
        `Mirror\n\n${provenanceTrailer}: ${'a'.repeat(40)}`,
      );
      await git(root, 'checkout', 'main');
      await Bun.write(join(root, 'README.md'), 'Target release metadata\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '--quiet', '-m', 'Update readme');
      await git(root, 'merge', '--no-ff', '--quiet', 'mirror', '-m', 'Merge verified mirror');
      expect(
        await findForeignCommits(root, {
          policy: await loadTargetOwnedPolicy(),
          target: 'agent-bureau',
          transform: { files: new Set([path]), prefixes: [] },
        }),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('accepts target metadata when a verified mirror is the second merge parent', () =>
    rethrow(outcome18));

  /**
   * COR-1192. After the first sync every release bump is a hand commit above a mirror-authored
   * one: the manifest's `version` is target-owned and the transform never writes it, so the
   * target has to. A guard that called that foreign would refuse every release. A commit is the
   * target's own when everything it changes is something the transform preserves — a
   * target-owned path, or a target-owned key inside a manifest the transform composes.
   */
  const outcome19 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      await sync(harness, 'first');

      const bumper = harness.runDirectory('bumper');
      await mkdir(bumper, { recursive: true });
      await git(bumper, 'clone', '--no-local', '--quiet', harness.remote, bumper);
      const manifestPath = join(bumper, 'packages/cryptography/package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest['version'] = '9.9.9';
      await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await Bun.write(join(bumper, 'README.md'), '# agent-bureau\n\nRelease 9.9.9 notes.\n');
      await git(bumper, 'add', '--all');
      await git(bumper, 'commit', '--quiet', '--message', 'Release 9.9.9');
      await git(bumper, 'push', '--quiet', 'origin', 'HEAD:main');

      const result = await sync(harness, 'after-bump');
      expect(['skip', 'pushed']).toContain(result.decision);
      const published = result.verification.reports.find(
        (report) => report.publicName === '@lostgradient/cryptography',
      );
      expect(published).toBeDefined();
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test("a hand commit confined to target-owned paths and manifest keys is the target's own, not foreign", () =>
    rethrow(outcome19));

  const outcome20 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      await sync(harness, 'first');

      const editor = harness.runDirectory('build-input-editor');
      await mkdir(editor, { recursive: true });
      await git(editor, 'clone', '--no-local', '--quiet', harness.remote, editor);
      // The fixture package's first declared build input, read from the surface rather than
      // hardcoded, so the test follows the declaration if it changes.
      const surface = await loadPackageSurface();
      const entry = surface.packages['@lostgradient/cryptography'];
      const input = entry?.build.requiredInputs[0];
      expect(input).toBeDefined();
      const path = join(editor, 'packages/cryptography', input ?? '');
      await Bun.write(path, `${await readFile(path, 'utf8')}\n// tuned by the target\n`);
      await git(editor, 'add', '--all');
      await git(editor, 'commit', '--quiet', '--message', 'Tune the build input');
      await git(editor, 'push', '--quiet', 'origin', 'HEAD:main');

      const result = await sync(harness, 'after-build-input');
      expect(['skip', 'pushed']).toContain(result.decision);
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test("a hand commit to a declared build input is the target's own, since the transform never writes one", () =>
    rethrow(outcome20));

  /**
   * COR-1198. agent-bureau#639 (`d750218`) changed the target's release tooling, its root
   * `bunfig.toml` and three package READMEs: paths no `target-owned.json` glob names, and none of
   * which the transform writes or prunes. Under COR-1223's inversion an unenumerated path the plan
   * never touches is the target's, so a sync cannot clobber the commit and the guard must not
   * refuse it.
   */
  const outcome21 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      await sync(harness, 'first');

      const releaser = harness.runDirectory('release-tooling');
      await mkdir(releaser, { recursive: true });
      await git(releaser, 'clone', '--no-local', '--quiet', harness.remote, releaser);
      await Bun.write(join(releaser, 'scripts/release.ts'), 'export const release = true;\n');
      await Bun.write(join(releaser, 'bunfig.toml'), '[install]\nexact = true\n');
      await Bun.write(
        join(releaser, 'packages/cryptography/README.md'),
        '# @lostgradient/cryptography\n',
      );
      await git(releaser, 'add', '--all');
      await git(releaser, 'commit', '--quiet', '--message', 'Tune the release tooling');
      await git(releaser, 'push', '--quiet', 'origin', 'HEAD:main');

      const result = await sync(harness, 'after-release-tooling');
      expect(['skip', 'pushed']).toContain(result.decision);
      const synced = harness.runDirectory('after-release-tooling');
      expect(await readFile(join(synced, 'scripts/release.ts'), 'utf8')).toBe(
        'export const release = true;\n',
      );
      expect(await readFile(join(synced, 'bunfig.toml'), 'utf8')).toBe('[install]\nexact = true\n');
      expect(await readFile(join(synced, 'packages/cryptography/README.md'), 'utf8')).toBe(
        '# @lostgradient/cryptography\n',
      );
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test("a hand commit to paths the transform neither writes nor prunes is the target's own", () =>
    rethrow(outcome21));

  const outcome22 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      await sync(harness, 'first');

      const mover = harness.runDirectory('rename-out-of-reach');
      await mkdir(mover, { recursive: true });
      await git(mover, 'clone', '--no-local', '--quiet', harness.remote, mover);
      // Git reports this as a rename whose new path the sync never touches; judged by that path
      // alone it would pass, and the sync would then restore the old path beside it.
      await git(mover, 'mv', 'packages/lifecycle/src/index.ts', 'packages/lifecycle/moved.ts');
      await git(mover, 'commit', '--quiet', '--message', 'Move an emitted file out of src');
      await git(mover, 'push', '--quiet', 'origin', 'HEAD:main');
      const moverHead = await git(mover, 'rev-parse', 'HEAD');
      const foreignSha = moverHead.trim();

      let thrown: unknown;
      try {
        await sync(harness, 'after-rename-out-of-reach');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ForeignCommitError);
      expect((thrown as ForeignCommitError).commits.map((commit) => commit.sha)).toEqual([
        foreignSha,
      ]);
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('a hand commit moving an emitted file out of the sync’s reach is still foreign', () =>
    rethrow(outcome22));

  const outcome23 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      await sync(harness, 'first');

      const intruder = harness.runDirectory('prunable-intruder');
      await mkdir(intruder, { recursive: true });
      await git(intruder, 'clone', '--no-local', '--quiet', harness.remote, intruder);
      await Bun.write(
        join(intruder, 'packages/lifecycle/src/hand-added.ts'),
        'export const handAdded = true;\n',
      );
      await git(intruder, 'add', '--all');
      await git(intruder, 'commit', '--quiet', '--message', 'Add a file the sync would prune');
      await git(intruder, 'push', '--quiet', 'origin', 'HEAD:main');
      const intruderHead = await git(intruder, 'rev-parse', 'HEAD');
      const foreignSha = intruderHead.trim();

      let thrown: unknown;
      try {
        await sync(harness, 'after-prunable-intrusion');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ForeignCommitError);
      expect((thrown as ForeignCommitError).commits.map((commit) => commit.sha)).toEqual([
        foreignSha,
      ]);
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('a hand commit adding a file inside a source tree the transform prunes is still foreign', () =>
    rethrow(outcome23));

  const outcome24 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      await sync(harness, 'first');

      const intruder = harness.runDirectory('exports-intruder');
      await mkdir(intruder, { recursive: true });
      await git(intruder, 'clone', '--no-local', '--quiet', harness.remote, intruder);
      const manifestPath = join(intruder, 'packages/cryptography/package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest['sideEffects'] = true;
      await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await git(intruder, 'add', '--all');
      await git(intruder, 'commit', '--quiet', '--message', 'Flip a key the transform owns');
      await git(intruder, 'push', '--quiet', 'origin', 'HEAD:main');
      const intruderHead = await git(intruder, 'rev-parse', 'HEAD');
      const foreignSha = intruderHead.trim();

      let thrown: unknown;
      try {
        await sync(harness, 'after-key-intrusion');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ForeignCommitError);
      expect((thrown as ForeignCommitError).commits.map((commit) => commit.sha)).toEqual([
        foreignSha,
      ]);
    });
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('a hand commit that changes a transform-owned manifest key is still foreign', () =>
    rethrow(outcome24));

  const outcome25 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      await sync(harness, 'first');

      const intruder = harness.runDirectory('intruder');
      await mkdir(intruder, { recursive: true });
      await git(intruder, 'clone', '--no-local', '--quiet', harness.remote, intruder);
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
          'agent-bureau',
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
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('a commit the mirror did not author stops the sync and is named', () => rethrow(outcome25));

  const outcome26 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      const clone = await cloneTarget({
        remote: harness.remote,
        directory: harness.runDirectory('inspect'),
      });
      // The seed commit predates every sync, so it must not read as somebody else's edit.
      expect(await findForeignCommits(clone)).toEqual([]);
    });
  });
  test('a target the mirror has never written is a first sync, not a wall of foreign commits', () =>
    rethrow(outcome26));
});

describe('the build-input check', async () => {
  // Real local remotes, clones, installs and packs (or a fresh `bun -e` child) are the behavior; they run at module scope, off the per-test clock.
  const outcome27 = await outcomeOf(async () => {
    await withHarness(async (harness) => {
      const clone = await cloneTarget({
        remote: harness.remote,
        directory: harness.runDirectory('no-build-input'),
      });
      await rm(join(clone, 'packages/cryptography/tsdown.config.ts'));

      const plan = await planSurface({
        corvidaeRoot: harness.corvidae,
        target: 'agent-bureau',
        targetDirectory: clone,
      });
      expect(collectMissingBuildInputs(clone, plan.published)).toEqual([
        '@lostgradient/cryptography: packages/cryptography/tsdown.config.ts',
      ]);
      expect(() => assertBuildInputsPresent(clone, plan.published)).toThrow(BuildInputError);
    });
  });
  test('a clone missing a required build input fails the sync and names the file', () =>
    rethrow(outcome27));

  const outcome28 = await outcomeOf(async () => {
    // The replacement for COR-1188's pin that the transform emitted no source at all. What the
    // build reads is now two classes rather than one: corvidae's `src/`, which the transform
    // writes, and the target's `requiredInputs`, which it never writes and never prunes.
    await withHarness(async (harness) => {
      const plan = await planSurface({
        corvidaeRoot: harness.corvidae,
        target: 'agent-bureau',
      });
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
  });
  test('the transform emits source, and the build inputs it does not emit stay target-owned', () =>
    rethrow(outcome28));
});

describe('pruning what corvidae no longer carries', async () => {
  // Real local remotes, clones, installs and packs (or a fresh `bun -e` child) are the behavior; they run at module scope, off the per-test clock.
  const outcome29 = await outcomeOf(async () => {
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
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('a dropped source file is deleted, while a target-owned path and an unknown path survive', () =>
    rethrow(outcome29));
});

describe('changeset emission through the sync (COR-1433)', async () => {
  const emittedAfter = (adding: string): string =>
    `.changeset/corvidae-${adding.slice(0, 12)}-note.md`;
  const changesetText =
    '---\n"@lostgradient/cryptography": patch\n---\n\nFix a thing in cryptography.\n';

  // Real local remotes, clones, installs and packs (or a fresh `bun -e` child) are the behavior; they run at module scope, off the per-test clock.
  const outcomeChangesetDelivery = await outcomeOf(async () => {
    const targetFiles = targetFixture();
    targetFiles['.changeset/config.json'] = '{}\n';
    targetFiles['.changeset/mcp-x.md'] = '---\n"@lostgradient/cinder-mcp": patch\n---\n\nTarget.\n';
    await withHarness(async (harness) => {
      const corvidaeGit = (...arguments_: string[]) => git(harness.corvidae, ...arguments_);
      await corvidaeGit('init', '--quiet', '--initial-branch=main');
      await corvidaeGit('add', '--all');
      await corvidaeGit('commit', '--quiet', '--message', 'Corvidae before the changeset');
      const startHead = await corvidaeGit('rev-parse', 'HEAD');
      const start = startHead.trim();
      await Bun.write(join(harness.corvidae, '.changeset/note.md'), changesetText);
      await corvidaeGit('add', '--all');
      await corvidaeGit('commit', '--quiet', '--message', 'Add a changeset');
      const addingHead = await corvidaeGit('rev-parse', 'HEAD');
      const adding = addingHead.trim();

      // A target the mirror has already written to, as of `start`.
      const seed = await cloneTarget({
        remote: harness.remote,
        directory: harness.runDirectory('seed'),
      });
      await git(
        seed,
        'commit',
        '--quiet',
        '--allow-empty',
        '--message',
        `Sync agent-bureau from corvidae\n\n${provenanceTrailer}: ${start}`,
      );
      await git(seed, 'push', '--quiet', 'origin', 'HEAD:main');

      const clone = await cloneTarget({
        remote: harness.remote,
        directory: harness.runDirectory('stage'),
      });
      const provenance = await newestMirrorProvenance(clone, 'agent-bureau', { strict: true });
      expect(provenance?.trailerSha).toBe(start);
      const outcome = await stageSurface({
        corvidaeRoot: harness.corvidae,
        target: 'agent-bureau',
        directory: clone,
        provenance,
      });

      expect(outcome.written).toContain(emittedAfter(adding));
      expect(await Bun.file(join(clone, emittedAfter(adding))).text()).toBe(changesetText);
      // Neither pruned nor retired: nothing under the target's `.changeset/` is ever deleted.
      expect(
        [...outcome.deleted, ...outcome.retired].filter((path) => path.startsWith('.changeset/')),
      ).toEqual([]);
      expect(await Bun.file(join(clone, '.changeset/mcp-x.md')).exists()).toBe(true);
      expect(await Bun.file(join(clone, '.changeset/config.json')).exists()).toBe(true);

      // The sync lands, then the target's release tooling consumes the changeset.
      await git(clone, 'add', '--all');
      await git(
        clone,
        'commit',
        '--quiet',
        '--message',
        `Sync agent-bureau from corvidae\n\n${provenanceTrailer}: ${adding}`,
      );
      await git(clone, 'rm', '--quiet', emittedAfter(adding));
      await git(clone, 'commit', '--quiet', '--message', 'Version Packages');
      await assertNoForeignCommits(
        clone,
        await foreignCommitOwnership({
          corvidaeRoot: harness.corvidae,
          target: 'agent-bureau',
          clone,
        }),
      );
    }, targetFiles);
  }, END_TO_END_BUDGET_MILLISECONDS);
  test('delivers a pending changeset, leaves the target-authored ones, and accepts the target consuming it', () =>
    rethrow(outcomeChangesetDelivery));
});

describe('newestMirrorProvenance (COR-1433)', () => {
  test('strict mode throws when the squash fallback cannot fetch the pull request, and lenient mode does not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-strict-provenance-'));
    try {
      await git(root, 'init', '--quiet', '--initial-branch=main');
      await Bun.write(join(root, 'file.txt'), 'content\n');
      await git(root, 'add', '-A');
      // Subject shaped like a squash merge, no trailer, and no `origin` to fetch the pull from.
      await git(root, 'commit', '--quiet', '-m', 'Sync weft from corvidae (#7)');
      expect(await newestMirrorProvenance(root, 'weft')).toBeNull();
      expect(
        await throwingRejectionOf(newestMirrorProvenance(root, 'weft', { strict: true })),
      ).toThrow(SyncError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the private-workspace check', () => {
  test('a private workspace that emits TypeScript without a typecheck script is refused', () => {
    expect(() =>
      assertPrivateWorkspacesCheckable([
        {
          workspace: '@lostgradient/testing',
          directory: 'packages/testing',
          publicName: '@lostgradient/testing',
          dependsOn: [],
          builds: false,
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
          workspace: '@lostgradient/typescript',
          directory: 'internal/typescript',
          publicName: '@lostgradient/typescript',
          dependsOn: [],
          builds: false,
          typechecks: false,
          emitsTypeScript: false,
        },
      ]),
    ).not.toThrow();
  });
});

/**
 * COR-1200 net-effect rule. A commit the per-commit rules reject is still acceptable when every
 * path it changed ends, at the target's HEAD, exactly where the mirror commit left it or exactly
 * where this sync would write it: the sync then clobbers nothing the target holds.
 */
describe('the foreign-commit guard net-effect rule', async () => {
  const sourcePath = 'packages/weft/src/index.ts';
  const otherPath = 'packages/weft/src/other.ts';
  const manifestPath = 'packages/weft/package.json';

  async function withRepository(
    run: (root: string, ownership: Awaited<ReturnType<typeof createOwnership>>) => Promise<void>,
    options: Parameters<typeof createOwnership>[0] = {},
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'mirror-net-effect-'));
    try {
      await git(root, 'init', '--quiet', '--initial-branch=main');
      await run(root, await createOwnership(options));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async function createOwnership(options: {
    generatedFiles?: Map<string, { contents: string; executable: boolean }>;
    generatedManifest?: Record<string, unknown>;
    prefixes?: string[];
  }) {
    return {
      policy: await loadTargetOwnedPolicy(),
      target: 'weft' as const,
      transform: {
        files: new Set([sourcePath, otherPath, manifestPath]),
        prefixes: options.prefixes ?? [],
      },
      generatedFiles: options.generatedFiles,
      generatedManifestKeys:
        options.generatedManifest === undefined
          ? undefined
          : new Map([[manifestPath, options.generatedManifest]]),
    };
  }

  async function commitAll(root: string, message: string): Promise<void> {
    await git(root, 'add', '-A');
    await git(root, 'commit', '--quiet', '-m', message);
  }

  async function commitMirror(root: string): Promise<void> {
    await commitAll(root, `Mirror\n\n${provenanceTrailer}: ${'a'.repeat(40)}`);
  }

  async function subjects(
    root: string,
    ownership: Awaited<ReturnType<typeof createOwnership>>,
  ): Promise<string[]> {
    const foreign = await findForeignCommits(root, ownership);
    return foreign.map(({ subject }) => subject);
  }

  // Every git call is a process, and under host load each costs tens of milliseconds; the guard
  // once spawned 26 here (an ancestry probe and a parent lookup per commit, a tree lookup and a
  // blob read per emission comparison, a tree lookup per repeat of the same path). Eight is the
  // history read (3), one diff per commit (3), and one tree lookup each for the path at HEAD and
  // at the mirror commit (2). A change that raises this count reintroduces per-commit or per-path
  // fan-out. The repository is real, so the scenario runs at module scope, off the per-test clock.
  const spawnCountOutcome = await outcomeOf(async () => {
    const emission = 'export const value = 3;\n';
    await withRepository(
      async (root, ownership) => {
        await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
        await commitMirror(root);
        for (const value of [1, 2, 3]) {
          await Bun.write(join(root, sourcePath), `export const value = ${value};\n`);
          await commitAll(root, `Edit source to ${value}`);
        }
        const spawn = spyOn(Bun, 'spawn');
        try {
          expect(await subjects(root, ownership)).toEqual([]);
          expect(spawn).toHaveBeenCalledTimes(8);
        } finally {
          spawn.mockRestore();
        }
      },
      { generatedFiles: new Map([[sourcePath, { contents: emission, executable: false }]]) },
    );
  });
  test('judges a run of edits without spawning git per commit or per repeated path', () =>
    rethrow(spawnCountOutcome));

  test('accepts a foreign edit that a later commit restores to the mirror bytes', async () => {
    await withRepository(async (root, ownership) => {
      await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
      await commitMirror(root);
      await Bun.write(join(root, sourcePath), 'export const value = 1;\n');
      await commitAll(root, 'Edit source');
      await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
      await commitAll(root, 'Restore source');
      expect(await subjects(root, ownership)).toEqual([]);
    });
  });

  test('keeps a foreign edit foreign while HEAD still differs from the mirror', async () => {
    await withRepository(async (root, ownership) => {
      await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
      await commitMirror(root);
      await Bun.write(join(root, sourcePath), 'export const value = 1;\n');
      await commitAll(root, 'Edit source');
      await Bun.write(join(root, sourcePath), 'export const value = 2;\n');
      await commitAll(root, 'Edit source again');
      expect(await subjects(root, ownership)).toEqual(['Edit source again', 'Edit source']);
    });
  });

  // Real local remotes, clones, installs and packs (or a fresh `bun -e` child) are the behavior; they run at module scope, off the per-test clock.
  const outcome30 = await outcomeOf(async () => {
    await withRepository(async (root, ownership) => {
      await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
      await commitMirror(root);
      await git(root, 'rm', '--quiet', sourcePath);
      await commitAll(root, 'Delete source');
      expect(await subjects(root, ownership)).toEqual(['Delete source']);
      await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
      await commitAll(root, 'Restore source');
      expect(await subjects(root, ownership)).toEqual([]);
    });
  });
  test('accepts a deleted path that a later commit restores to the mirror bytes', () =>
    rethrow(outcome30));

  const outcome31 = await outcomeOf(async () => {
    await withRepository(async (root, ownership) => {
      await Bun.write(join(root, otherPath), 'export {};\n');
      await commitMirror(root);
      await Bun.write(join(root, sourcePath), 'export const added = true;\n');
      await commitAll(root, 'Add source');
      expect(await subjects(root, ownership)).toEqual(['Add source']);
      await git(root, 'rm', '--quiet', sourcePath);
      await commitAll(root, 'Remove source');
      expect(await subjects(root, ownership)).toEqual([]);
    });
  });
  test('accepts an added path that a later commit removes again', () => rethrow(outcome31));

  /**
   * A deletion the sync would make itself (COR-1201). A path under a prefix the sync retires or
   * prunes, and absent from everything it writes, stays absent after the sync, so a target
   * commit that already deleted it clobbers nothing; cinder#1602 deleting the retired playground
   * copy is the case. An emitted path, or a deleted path restored to anything, still differs from
   * what the sync leaves.
   */
  describe('a deletion the sync would make itself', async () => {
    const retiredPath = 'packages/playground/package.json';
    const prunedPath = 'packages/weft/src/stale.ts';
    const reach = { prefixes: ['packages/weft/src', 'packages/playground'] };

    // Real local remotes, clones, installs and packs (or a fresh `bun -e` child) are the behavior; they run at module scope, off the per-test clock.
    const outcome32 = await outcomeOf(async () => {
      await withRepository(async (root, ownership) => {
        await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
        await Bun.write(join(root, retiredPath), '{"name":"@cinder/playground"}\n');
        await commitMirror(root);
        await git(root, 'rm', '--quiet', retiredPath);
        await commitAll(root, 'Delete retired copy');
        expect(await subjects(root, ownership)).toEqual([]);
      }, reach);
    });
    test('accepts deleting a retired path', () => rethrow(outcome32));

    const outcome33 = await outcomeOf(async () => {
      await withRepository(async (root, ownership) => {
        await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
        await Bun.write(join(root, prunedPath), 'export {};\n');
        await commitMirror(root);
        await git(root, 'rm', '--quiet', prunedPath);
        await commitAll(root, 'Delete stale source');
        expect(await subjects(root, ownership)).toEqual([]);
      }, reach);
    });
    test('accepts deleting a file the sync prunes', () => rethrow(outcome33));

    const outcome34 = await outcomeOf(async () => {
      const retiredManifest = 'packages/playground/package.json';
      await withRepository(async (root, ownership) => {
        await Bun.write(
          join(root, retiredManifest),
          '{"name":"@cinder/playground","files":["build"]}\n',
        );
        await commitMirror(root);
        await Bun.write(
          join(root, retiredManifest),
          '{"name":"@cinder/playground","files":["dist"]}\n',
        );
        await commitAll(root, 'Change retired manifest files');
        expect(await subjects(root, ownership)).toEqual(['Change retired manifest files']);
        await git(root, 'rm', '--quiet', retiredManifest);
        await commitAll(root, 'Delete retired copy');
        expect(await subjects(root, ownership)).toEqual([]);
      }, reach);
    });
    test('accepts a retired manifest edited and then deleted', () => rethrow(outcome34));

    const outcome35 = await outcomeOf(async () => {
      await withRepository(async (root, ownership) => {
        await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
        await commitMirror(root);
        await git(root, 'rm', '--quiet', sourcePath);
        await commitAll(root, 'Delete emitted source');
        expect(await subjects(root, ownership)).toEqual(['Delete emitted source']);
      }, reach);
    });
    test('keeps deleting an emitted file foreign', () => rethrow(outcome35));

    const outcome36 = await outcomeOf(async () => {
      await withRepository(async (root, ownership) => {
        await Bun.write(join(root, manifestPath), '{"name":"@lostgradient/weft"}\n');
        await commitMirror(root);
        await git(root, 'rm', '--quiet', manifestPath);
        await commitAll(root, 'Delete emitted manifest');
        expect(await subjects(root, ownership)).toEqual(['Delete emitted manifest']);
      }, reach);
    });
    test('keeps deleting an emitted manifest foreign', () => rethrow(outcome36));

    const outcome37 = await outcomeOf(async () => {
      await withRepository(async (root, ownership) => {
        await Bun.write(join(root, retiredPath), '{"name":"@cinder/playground"}\n');
        await commitMirror(root);
        await git(root, 'rm', '--quiet', retiredPath);
        await commitAll(root, 'Delete retired copy');
        await Bun.write(join(root, retiredPath), '{"name":"@cinder/playground","private":true}\n');
        await commitAll(root, 'Restore retired copy');
        expect(await subjects(root, ownership)).toEqual([
          'Restore retired copy',
          'Delete retired copy',
        ]);
      }, reach);
    });
    test('keeps a deleted retired path foreign once a later commit restores different bytes', () =>
      rethrow(outcome37));
  });

  test('accepts a mode-only change that a later commit reverts', async () => {
    await withRepository(async (root, ownership) => {
      await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
      await commitMirror(root);
      await chmod(join(root, sourcePath), 0o755);
      await commitAll(root, 'Make source executable');
      expect(await subjects(root, ownership)).toEqual(['Make source executable']);
      await chmod(join(root, sourcePath), 0o644);
      await commitAll(root, 'Make source plain again');
      expect(await subjects(root, ownership)).toEqual([]);
    });
  });

  test('accepts a transform-owned manifest key change that a later commit reverts', async () => {
    const original = { name: '@lostgradient/weft', version: '0.27.0', files: ['dist'] };
    const changed = { ...original, files: ['dist', '!src/**'] };
    await withRepository(
      async (root, ownership) => {
        await Bun.write(join(root, manifestPath), `${JSON.stringify(original)}\n`);
        await commitMirror(root);
        await Bun.write(join(root, manifestPath), `${JSON.stringify(changed)}\n`);
        await commitAll(root, 'Change manifest files');
        expect(await subjects(root, ownership)).toEqual(['Change manifest files']);
        await Bun.write(join(root, manifestPath), `${JSON.stringify(original)}\n`);
        await commitAll(root, 'Revert manifest files');
        expect(await subjects(root, ownership)).toEqual([]);
        await Bun.write(join(root, manifestPath), `${JSON.stringify(changed)}\n`);
        await commitAll(root, 'Change manifest files again');
        // The revert is the target's own on its face: it writes the generated key values.
        expect(await subjects(root, ownership)).toEqual([
          'Change manifest files again',
          'Change manifest files',
        ]);
      },
      { generatedManifest: original },
    );
  });

  test('judges each commit by its own paths when only the second restores a shared path', async () => {
    await withRepository(async (root, ownership) => {
      await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
      await Bun.write(join(root, otherPath), 'export const other = 0;\n');
      await commitMirror(root);
      await Bun.write(join(root, sourcePath), 'export const value = 1;\n');
      await Bun.write(join(root, otherPath), 'export const other = 1;\n');
      await commitAll(root, 'Edit both');
      await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
      await commitAll(root, 'Restore one');
      expect(await subjects(root, ownership)).toEqual(['Edit both']);
    });
  });

  test('accepts a foreign edit whose path ends at this sync emission rather than the mirror bytes', async () => {
    const emission = 'export const value = 2;\n';
    await withRepository(
      async (root, ownership) => {
        await Bun.write(join(root, sourcePath), 'export const value = 0;\n');
        await commitMirror(root);
        await Bun.write(join(root, sourcePath), 'export const value = 1;\n');
        await commitAll(root, 'Edit source');
        await Bun.write(join(root, sourcePath), emission);
        await commitAll(root, 'Match emission');
        expect(await subjects(root, ownership)).toEqual([]);
        await Bun.write(join(root, sourcePath), 'export const value = 3;\n');
        await commitAll(root, 'Drift from emission');
        // 'Match emission' is the target's own on its face: it writes exactly the emission.
        expect(await subjects(root, ownership)).toEqual(['Drift from emission', 'Edit source']);
      },
      { generatedFiles: new Map([[sourcePath, { contents: emission, executable: false }]]) },
    );
  });
});
