import { describe, expect, test } from 'bun:test';

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
    // `smoke.ts` only lists import specifiers, never a path, so it really is byte-identical.
    // `package.json` is not — its `file:` dependency embeds the tarball's path, which legitimately
    // differs by scratch directory — so only its *structure*, not its bytes, is compared.
    expect(localWrite?.files?.['smoke.ts']).toBe(workflowWrite?.files?.['smoke.ts']);
    expect(localWrite?.files?.['smoke.ts']).toContain("from '@lostgradient/cryptography'");
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
