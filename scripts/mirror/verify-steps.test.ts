import { describe, expect, test } from 'bun:test';

import { committedPlans } from './committed-plans.ts';

import { tarballFilename } from './packaging.ts';
import type { PrivateWorkspace, PublishedPackage } from './surface.ts';
import {
  buildVerifySteps,
  VerifyStepOrderError,
  type VerifyEnvironment,
  type VerifyStepKind,
} from './verify-steps.ts';

const published: PublishedPackage[] = [
  {
    workspace: '@lostgradient/cryptography',
    directory: 'packages/cryptography',
    publicName: '@lostgradient/cryptography',
    entry: {} as PublishedPackage['entry'],
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    files: ['dist'],
    version: '1.2.3',
    dependsOn: [],
  },
];

const privateWorkspaces: PrivateWorkspace[] = [
  {
    workspace: '@lostgradient/testing',
    directory: 'packages/testing',
    publicName: '@lostgradient/testing',
    typechecks: true,
    emitsTypeScript: true,
  },
  {
    workspace: '@lostgradient/typescript',
    directory: 'internal/typescript',
    publicName: '@lostgradient/typescript',
    typechecks: false,
    emitsTypeScript: false,
  },
];

function localEnvironment(): VerifyEnvironment {
  return {
    resolveDirectory: (relative) => `/clone/${relative}`.replace(/\/\.$/, ''),
    scratchDirectory: '/scratch',
    toolCommand: (tool) => [`/tools/node_modules/.bin/${tool}`],
  };
}

function workflowEnvironment(): VerifyEnvironment {
  return {
    resolveDirectory: (relative) => relative,
    scratchDirectory: '${{ runner.temp }}/mirror-verify',
    toolCommand: (tool) => [
      'bunx',
      '--bun',
      `${tool === 'attw' ? '@arethetypeswrong/cli' : tool}@1.0.0`,
    ],
  };
}

describe('buildVerifySteps', () => {
  test('the ordered kinds match install, then per-published-package build/typecheck/pack/publint/attw, then a private typecheck, then the consumer smoke test', () => {
    const steps = buildVerifySteps(
      { installCommand: ['bun', 'install', '--frozen-lockfile'], published, privateWorkspaces },
      localEnvironment(),
    );
    expect(steps.map((step) => step.kind)).toEqual([
      'install',
      'build',
      'typecheck-published',
      'pack',
      'publint',
      'attw',
      'typecheck-private',
      'write-consumer-project',
      'consumer-install',
      'consumer-run',
      'consumer-run-node',
    ]);
  });

  test('a package is built before the packages that depend on it, whatever order discovery found them in', () => {
    // COR-1289: `armorer` comes first in discovery order and depends on `@lostgradient/cryptography`,
    // which comes second. A typecheck resolves an intra-target dependency through its `exports` →
    // `dist/`, so building in discovery order leaves `cryptography` with no `dist/` when `armorer`
    // is type-checked and the step fails with `Cannot find module '@lostgradient/cryptography'`.
    const dependentFirst: PublishedPackage[] = [
      {
        workspace: '@lostgradient/armorer',
        directory: 'packages/armorer',
        publicName: 'armorer',
        entry: {} as PublishedPackage['entry'],
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        files: ['dist'],
        version: '2.0.0',
        dependsOn: ['@lostgradient/cryptography'],
      },
      {
        workspace: '@lostgradient/cryptography',
        directory: 'packages/cryptography',
        publicName: '@lostgradient/cryptography',
        entry: {} as PublishedPackage['entry'],
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        files: ['dist'],
        version: '1.2.3',
        dependsOn: [],
      },
    ];
    const steps = buildVerifySteps(
      { installCommand: ['bun', 'install'], published: dependentFirst, privateWorkspaces: [] },
      localEnvironment(),
    );
    const indexOf = (kind: VerifyStepKind, publicName: string): number =>
      steps.findIndex((step) => step.kind === kind && step.publicName === publicName);
    const dependencyBuild = indexOf('build', '@lostgradient/cryptography');
    expect(dependencyBuild).toBeGreaterThan(-1);
    expect(dependencyBuild).toBeLessThan(indexOf('build', 'armorer'));
    expect(dependencyBuild).toBeLessThan(indexOf('typecheck-published', 'armorer'));
    // The phase split itself, which is what makes the ordering sufficient rather than merely
    // necessary: every build runs before any typecheck, so no typecheck can resolve a sibling's
    // `exports` against a `dist/` that a later build was going to produce.
    const kinds = steps.map((step) => step.kind);
    expect(kinds.lastIndexOf('build')).toBeLessThan(kinds.indexOf('typecheck-published'));
  });

  test('a dependency cycle between two published packages is refused, naming both', () => {
    const cyclic: PublishedPackage[] = [
      {
        workspace: '@lostgradient/armorer',
        directory: 'packages/armorer',
        publicName: 'armorer',
        entry: {} as PublishedPackage['entry'],
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        files: ['dist'],
        version: '2.0.0',
        dependsOn: ['@lostgradient/cryptography'],
      },
      {
        workspace: '@lostgradient/cryptography',
        directory: 'packages/cryptography',
        publicName: '@lostgradient/cryptography',
        entry: {} as PublishedPackage['entry'],
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        files: ['dist'],
        version: '1.2.3',
        dependsOn: ['armorer'],
      },
    ];
    let thrown: unknown;
    try {
      buildVerifySteps(
        { installCommand: ['bun', 'install'], published: cyclic, privateWorkspaces: [] },
        localEnvironment(),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VerifyStepOrderError);
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).toContain('armorer');
    expect(message).toContain('@lostgradient/cryptography');
    expect(message).toContain('cycle');
  });

  test('a private workspace that emits no TypeScript gets no typecheck step', () => {
    const steps = buildVerifySteps(
      { installCommand: ['bun', 'install'], published: [], privateWorkspaces },
      localEnvironment(),
    );
    const typechecked = steps.filter((step) => step.kind === 'typecheck-private');
    expect(typechecked.map((step) => step.publicName)).toEqual(['@lostgradient/testing']);
  });

  test('the tarball path is computed ahead of time from the public name and version, not left to be parsed later', () => {
    const steps = buildVerifySteps(
      { installCommand: ['bun', 'install'], published, privateWorkspaces: [] },
      localEnvironment(),
    );
    const publint = steps.find((step) => step.kind === 'publint');
    const attw = steps.find((step) => step.kind === 'attw');
    const expected = `/scratch/tarballs/${tarballFilename('@lostgradient/cryptography', '1.2.3')}`;
    expect(publint?.tarball).toBe(expected);
    expect(attw?.tarball).toBe(expected);
    expect(publint?.command).toContain(expected);
    expect(attw?.command).toContain(expected);
  });

  test('publint and attw carry their fixed flags identically regardless of environment', () => {
    for (const environment of [localEnvironment(), workflowEnvironment()]) {
      const steps = buildVerifySteps(
        { installCommand: ['bun', 'install'], published, privateWorkspaces: [] },
        environment,
      );
      const publint = steps.find((step) => step.kind === 'publint');
      const attw = steps.find((step) => step.kind === 'attw');
      const tarball = publint?.tarball ?? '';
      expect(tarball.length).toBeGreaterThan(0);
      expect(tarball).toBe(attw?.tarball ?? '');
      // Sliced past each tool's own invocation prefix, whatever length that prefix is in this
      // environment, since only the fixed flags after it are meant to be environment-independent.
      const publintPrefixLength = environment.toolCommand('publint').length;
      const attwPrefixLength = environment.toolCommand('attw').length;
      expect(publint?.command.slice(publintPrefixLength)).toEqual(['--strict', tarball]);
      expect(attw?.command.slice(attwPrefixLength)).toEqual([
        tarball,
        '--no-definitely-typed',
        '--format',
        'ascii',
        '--ignore-rules',
        'cjs-resolves-to-esm',
        'no-resolution',
      ]);
    }
  });

  test('the local and workflow environments resolve directories and tools differently, everything else identically', () => {
    const local = buildVerifySteps(
      { installCommand: ['bun', 'install', '--frozen-lockfile'], published, privateWorkspaces },
      localEnvironment(),
    );
    const workflow = buildVerifySteps(
      { installCommand: ['bun', 'install', '--frozen-lockfile'], published, privateWorkspaces },
      workflowEnvironment(),
    );
    expect(local.map((step) => step.kind)).toEqual(workflow.map((step) => step.kind));
    expect(local.map((step) => step.description)).toEqual(workflow.map((step) => step.description));
    // cwd differs: local resolves onto an absolute clone path, workflow keeps the bare
    // target-relative directory `working-directory:` already understands.
    const localBuild = local.find((step) => step.kind === 'build');
    const workflowBuild = workflow.find((step) => step.kind === 'build');
    expect(localBuild?.cwd).toBe('/clone/packages/cryptography');
    expect(workflowBuild?.cwd).toBe('packages/cryptography');
    // The install command and the `build`/`typecheck` commands are identical strings in both
    // environments — nothing about them is environment-dependent.
    expect(local[0]?.command).toEqual(workflow[0]?.command);
    expect(localBuild?.command).toEqual(workflowBuild?.command);
  });

  test('the consumer smoke-test script is byte-identical between environments; only the tarball path embedded in its manifest differs', () => {
    const local = buildVerifySteps(
      {
        installCommand: ['bun', 'install'],
        published,
        privateWorkspaces: [],
        installArguments: ['--offline'],
      },
      localEnvironment(),
    );
    const workflow = buildVerifySteps(
      {
        installCommand: ['bun', 'install'],
        published,
        privateWorkspaces: [],
        installArguments: ['--offline'],
      },
      workflowEnvironment(),
    );
    const localWrite = local.find((step) => step.kind === 'write-consumer-project');
    const workflowWrite = workflow.find((step) => step.kind === 'write-consumer-project');
    // `smoke.mjs` only lists import specifiers, never a path, so it really is byte-identical.
    // `package.json` is not — its `file:` dependency embeds the tarball's path, which legitimately
    // differs by scratch directory — so only its *structure*, not its bytes, is compared.
    expect(localWrite?.files?.['smoke.mjs']).toBe(workflowWrite?.files?.['smoke.mjs']);
    expect(localWrite?.files?.['smoke.mjs']).toContain("from '@lostgradient/cryptography'");
    expect(localWrite?.files?.['smoke-node.mjs']).toBe(workflowWrite?.files?.['smoke-node.mjs']);
    const localManifest = JSON.parse(localWrite?.files?.['package.json'] ?? '{}') as {
      dependencies: Record<string, string>;
    };
    const workflowManifest = JSON.parse(workflowWrite?.files?.['package.json'] ?? '{}') as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(localManifest.dependencies)).toEqual(
      Object.keys(workflowManifest.dependencies),
    );
    expect(localManifest.dependencies['@lostgradient/cryptography']).toContain(
      '/scratch/tarballs/',
    );
    expect(workflowManifest.dependencies['@lostgradient/cryptography']).toContain(
      '${{ runner.temp }}/mirror-verify/tarballs/',
    );

    const localInstall = local.find((step) => step.kind === 'consumer-install');
    const workflowInstall = workflow.find((step) => step.kind === 'consumer-install');
    expect(localInstall?.command).toEqual(['bun', 'install', '--offline']);
    expect(localInstall?.command).toEqual(workflowInstall?.command);
  });
});

/**
 * COR-1192. The packed 0.26.0 tarball imported cleanly under bun and failed under node
 * (`import.meta.require` from an inlined CommonJS dependency), and the emitted workflow was green
 * because its smoke test ran under bun alone. The consumer script is plain JavaScript and runs
 * under both runtimes, one step each, bun first, so a runtime-specific resolution failure is a
 * red check rather than a release surprise.
 */
describe('the consumer smoke test runs under node as well as bun', () => {
  const steps = buildVerifySteps(
    { installCommand: ['bun', 'install', '--frozen-lockfile'], published, privateWorkspaces: [] },
    localEnvironment(),
  );

  test('writes a plain-JavaScript smoke script both runtimes can execute', () => {
    const write = steps.find((step) => step.kind === 'write-consumer-project');
    expect(Object.keys(write?.files ?? {}).toSorted()).toEqual([
      'package.json',
      'smoke-node.mjs',
      'smoke.mjs',
    ]);
    expect(write?.files?.['smoke.mjs']).not.toMatch(/:\s*\w+\s*[=;)]/);
  });

  test('runs it under bun and then under node, after the consumer install', () => {
    const kinds = steps.map((step) => step.kind);
    const install = kinds.indexOf('consumer-install');
    const bun = kinds.indexOf('consumer-run');
    const node = kinds.indexOf('consumer-run-node');
    expect(install).toBeGreaterThan(-1);
    expect(bun).toBeGreaterThan(install);
    expect(node).toBeGreaterThan(bun);
    expect(steps[bun]?.command).toEqual(['bun', 'run', 'smoke.mjs']);
    expect(steps[node]?.command).toEqual(['node', 'smoke-node.mjs']);
    expect(steps[node]?.cwd).toBe(steps[bun]?.cwd);
  });

  test('a subpath exported for bun alone is imported under bun and left out under node', () => {
    const first = published[0];
    if (first === undefined) throw new Error('the fixture has no published package');
    const bunOnly = {
      ...first,
      exports: {
        ...first.exports,
        './bun-only': { types: './dist/bun-only.d.ts', bun: './dist/bun-only.js' },
      },
    } as (typeof published)[number];
    const write = buildVerifySteps(
      { installCommand: ['bun', 'install'], published: [bunOnly], privateWorkspaces: [] },
      localEnvironment(),
    ).find((step) => step.kind === 'write-consumer-project');
    expect(write?.files?.['smoke.mjs']).toContain(`from '${first.publicName}/bun-only'`);
    expect(write?.files?.['smoke-node.mjs']).not.toContain('/bun-only');
    expect(write?.files?.['smoke-node.mjs']).toContain(`from '${first.publicName}'`);
  });
});

/**
 * COR-1192. `release.yaml` runs `bun run prepack` right before `npm publish`; the first tagged
 * release failed there twice on gates nothing before the tag had run. A published package whose
 * surface records a `prepack` script gets a step for it, after its typecheck and before its pack.
 */
describe('prepack runs in verification when the surface records it', () => {
  test('a package with a recorded prepack gets the step between typecheck and pack; one without does not', () => {
    const first = published[0];
    if (first === undefined) throw new Error('the fixture has no published package');
    const withPrepack = {
      ...first,
      entry: {
        ...first.entry,
        build: {
          ...first.entry.build,
          scripts: { ...first.entry.build?.scripts, prepack: 'bun run build' },
        },
      },
    };
    const without = {
      ...first,
      entry: { ...first.entry, build: { ...first.entry.build, scripts: {} } },
    };
    const steps = buildVerifySteps(
      { installCommand: ['bun', 'install'], published: [withPrepack], privateWorkspaces: [] },
      localEnvironment(),
    );
    const kinds = steps.map((step) => step.kind);
    expect(kinds.indexOf('prepack')).toBeGreaterThan(kinds.indexOf('typecheck-published'));
    expect(kinds.indexOf('prepack')).toBeLessThan(kinds.indexOf('pack'));
    expect(steps[kinds.indexOf('prepack')]?.command).toEqual(['bun', 'run', 'prepack']);
    const bare = buildVerifySteps(
      { installCommand: ['bun', 'install'], published: [without], privateWorkspaces: [] },
      localEnvironment(),
    );
    expect(bare.map((step) => step.kind)).not.toContain('prepack');
  });

  test('weft’s committed surface records a prepack, so its rendered workflow runs it', async () => {
    const { plan } = committedPlans.weft;
    const weft = plan.published.find((entry) => entry.publicName === '@lostgradient/weft');
    expect(weft?.entry.build.scripts['prepack']).toContain('verify:exports');
  });
});

describe('the consumer manifest resolves intra-target siblings from this run (COR-1292)', () => {
  function consumerManifestFor(packages: PublishedPackage[]): Record<string, unknown> {
    const steps = buildVerifySteps(
      { installCommand: ['bun', 'install'], published: packages, privateWorkspaces: [] },
      localEnvironment(),
    );
    const write = steps.find((step) => step.kind === 'write-consumer-project');
    return JSON.parse(write?.files?.['package.json'] ?? '{}') as Record<string, unknown>;
  }

  // A packed tarball rewrites its `workspace:*` edge to a registry range. For a first publish that
  // range names a version the registry does not have yet, so without an override the consumer's
  // install fetches the sibling from npm and gets a 404 (agent-bureau's cryptography, embeddings,
  // lifecycle and tool-protocol; COR-1196 moved cinder's other example, weft-ui, to
  // `private-workspace`, so it no longer packs a tarball at all). Bun honors an `overrides` entry
  // pointing at a `file:` tarball for such a sibling; measured under Bun 1.4.0 and 1.4.2 on
  // 2026-09-23.
  test('a sibling another published package depends on is overridden to its own tarball', () => {
    const armorer: PublishedPackage = {
      ...published[0]!,
      workspace: 'armorer',
      directory: 'packages/armorer',
      publicName: 'armorer',
      version: '2.4.0',
      dependsOn: ['@lostgradient/cryptography'],
    };
    const manifest = consumerManifestFor([armorer, published[0]!]);
    const dependencies = manifest['dependencies'] as Record<string, string>;
    expect(manifest['overrides']).toEqual({
      '@lostgradient/cryptography': dependencies['@lostgradient/cryptography'],
    });
    expect(dependencies['@lostgradient/cryptography']).toBe(
      `file:/scratch/tarballs/${tarballFilename('@lostgradient/cryptography', '1.2.3')}`,
    );
  });

  test('a target with no intra-target edge renders no overrides key at all', () => {
    expect('overrides' in consumerManifestFor(published)).toBe(false);
  });

  test("weft's committed plan renders no overrides key, so its rendered workflow is unchanged", () => {
    expect('overrides' in consumerManifestFor(committedPlans.weft.plan.published)).toBe(false);
  });
});
