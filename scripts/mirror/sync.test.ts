import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPackageSurface } from './package-surface.ts';
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
  gitEnvironment,
  provenanceTrailer,
  runSync,
  SyncError,
  type SyncResult,
} from './sync.ts';

describe('gitEnvironment', () => {
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
    target: 'agent-bureau',
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
        // workspace. Nothing publishes that one, so the name reads wider than what it reports;
        // pinned as observed rather than quietly filtered here. `@lostgradient/typescript` was in
        // this list until COR-1287 and is not a regression by its absence: it ships from the
        // cinder target, so the agent-bureau plan vendors its configuration rather than emitting
        // a manifest for it, exactly as the weft plan always has.
        expect(first.firstPublish.toSorted()).toEqual([
          '@lostgradient/cryptography',
          '@lostgradient/lifecycle',
          privateWorkspaceName,
        ]);
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
        // The mutation has to be something the transform owns, and since COR-1223 that is a much
        // shorter list than corvidae's whole manifest. A new `description` used to serve here and
        // no longer can: package metadata is target-owned now, so adding one to corvidae is
        // correctly a no-op downstream, and this test would have gone on passing for the wrong
        // reason once the first sync had given the target a manifest to own. Source is the thing
        // the mirror exists to carry and is transform-owned outright, so it is what this mutates.
        const changedSource =
          'export const digest = (value: string): string => `sha512:${value}`;\n';
        await Bun.write(
          join(harness.corvidae, 'packages/cryptography/src/index.ts'),
          changedSource,
        );

        const second = await sync(harness, 'second');
        expect(second.decision).toBe('pushed');
        expect(second.changed.join('\n')).toContain('packages/cryptography/src/index.ts');
        expect(
          await readFile(join(second.directory, 'packages/cryptography/src/index.ts'), 'utf8'),
        ).toBe(changedSource);
      });
    },
    endToEndTimeout,
  );
});

describe('the foreign-commit guard', () => {
  /**
   * COR-1192. After the first sync every release bump is a hand commit above a mirror-authored
   * one: the manifest's `version` is target-owned and the transform never writes it, so the
   * target has to. A guard that called that foreign would refuse every release. A commit is the
   * target's own when everything it changes is something the transform preserves — a
   * target-owned path, or a target-owned key inside a manifest the transform composes.
   */
  test(
    "a hand commit confined to target-owned paths and manifest keys is the target's own, not foreign",
    async () => {
      await withHarness(async (harness) => {
        await sync(harness, 'first');

        const bumper = harness.runDirectory('bumper');
        await mkdir(bumper, { recursive: true });
        await git(bumper, 'clone', '--quiet', harness.remote, bumper);
        const manifestPath = join(bumper, 'packages/cryptography/package.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
          string,
          unknown
        >;
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
    },
    endToEndTimeout,
  );

  test(
    "a hand commit to a declared build input is the target's own, since the transform never writes one",
    async () => {
      await withHarness(async (harness) => {
        await sync(harness, 'first');

        const editor = harness.runDirectory('build-input-editor');
        await mkdir(editor, { recursive: true });
        await git(editor, 'clone', '--quiet', harness.remote, editor);
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
    },
    endToEndTimeout,
  );

  test(
    'a hand commit that changes a transform-owned manifest key is still foreign',
    async () => {
      await withHarness(async (harness) => {
        await sync(harness, 'first');

        const intruder = harness.runDirectory('exports-intruder');
        await mkdir(intruder, { recursive: true });
        await git(intruder, 'clone', '--quiet', harness.remote, intruder);
        const manifestPath = join(intruder, 'packages/cryptography/package.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
          string,
          unknown
        >;
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
    },
    endToEndTimeout,
  );

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
        target: 'agent-bureau',
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
          workspace: '@lostgradient/testing',
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
          workspace: '@lostgradient/typescript',
          directory: 'internal/typescript',
          publicName: '@lostgradient/typescript',
          typechecks: false,
          emitsTypeScript: false,
        },
      ]),
    ).not.toThrow();
  });
});
