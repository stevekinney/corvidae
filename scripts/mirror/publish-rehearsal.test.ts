import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandResult, CommandRunner } from './packaging.ts';
import {
  collectEntryPoints,
  defaultRemote,
  proveNpmPublishDryRun,
  PublishRehearsalError,
  readShippedPaths,
  rehearsePublish,
  runPublishRehearsalCommand,
} from './publish-rehearsal.ts';
import type { StageOutcome } from './sync.ts';

/**
 * Packages built by hand, the way `packaging.test.ts` builds them, so these assertions stay about
 * the probe rather than about the transform.
 *
 * Only `bun run build` and `npm publish` are injected. `bun pm pack`, `publint` and `attw` run for
 * real against a real tarball, because they are the half of the probe that judges the tarball's
 * contents: faking them would leave the defect this module exists to close — a green exit code
 * over an empty tarball — provable only by hand. Nothing reaches the network: those three read a
 * `.tgz` off disk, and no command in this file talks to a registry.
 */

/** The shape that clears `attw` on all four resolution modes; the baseline the failures break. */
function soundManifest(name: string, version: string): Record<string, unknown> {
  return {
    name,
    version,
    type: 'module',
    license: 'MIT',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    engines: { node: '>=22' },
    exports: {
      '.': {
        bun: './dist/index.js',
        import: { types: './dist/index.d.ts', default: './dist/index.js' },
        require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
        default: './dist/index.js',
      },
      './package.json': './package.json',
    },
    files: ['dist'],
  };
}

/**
 * The shape every package the mirror publishes actually has: ESM only, no `require` condition.
 *
 * It clears `publint --strict` and fails `attw` with `CJSResolvesToESM`, which is the combination
 * the probe's ruling turns on rather than a contrivance — `@lostgradient/weft`,
 * `@lostgradient/chat`, `@lostgradient/editor` and `@lostgradient/cinder` all behave this way as
 * published.
 */
function esmOnlyManifest(name: string, version: string): Record<string, unknown> {
  return {
    name,
    version,
    type: 'module',
    license: 'MIT',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    engines: { node: '>=22' },
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './package.json': './package.json',
    },
    files: ['dist'],
  };
}

const builtFiles = {
  'dist/index.js': 'export const answer = 42;\n',
  'dist/index.cjs': 'exports.answer = 42;\n',
  'dist/index.d.ts': 'export declare const answer: number;\n',
  'dist/index.d.cts': 'export declare const answer: number;\n',
} as const;

/** What npm reports it would ship for a package that really was built. */
const shippedByNpm = [
  'dist/index.cjs',
  'dist/index.d.cts',
  'dist/index.d.ts',
  'dist/index.js',
  'package.json',
];

function npmReport(id: string, paths: readonly string[]): string {
  return JSON.stringify({
    [id]: {
      id,
      files: paths.map((path) => ({ path, size: 1, mode: 420 })),
      entryCount: paths.length,
    },
  });
}

const publicName = '@lostgradient/cryptography';
const packageDirectory = 'packages/cryptography';

function outcomeFor(name = publicName, directory = packageDirectory): StageOutcome {
  return {
    plan: { published: [{ publicName: name, directory }] },
    written: [],
    deleted: [],
  } as unknown as StageOutcome;
}

interface Harness {
  run: CommandRunner;
  commands: string[][];
}

function fakeRunner(
  options: { buildExitCode?: number; npmExitCode?: number; shipped?: readonly string[] } = {},
): Harness {
  const commands: string[][] = [];
  const run: CommandRunner = async (command): Promise<CommandResult> => {
    commands.push([...command]);
    const base = { command: command.join(' '), stdout: '', stderr: '' };
    if (command[0] === 'npm') {
      return {
        ...base,
        exitCode: options.npmExitCode ?? 0,
        stdout: npmReport(publicName, options.shipped ?? shippedByNpm),
      };
    }
    return { ...base, exitCode: options.buildExitCode ?? 0 };
  };
  return { run, commands };
}

/**
 * A staged tree with one package in it.
 *
 * `built` is what makes this a real fixture rather than a shaped one: a package whose manifest
 * points at `dist/` and whose `dist/` does not exist is exactly the tree the old probe reported a
 * successful publish rehearsal against.
 */
async function withStagedTree(
  options: { built: boolean; version?: string; esmOnly?: boolean },
  body: (work: string, scratch: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mirror-publish-rehearsal-'));
  try {
    const work = join(root, 'clone');
    const manifest = options.esmOnly ? esmOnlyManifest : soundManifest;
    await Bun.write(
      join(work, packageDirectory, 'package.json'),
      `${JSON.stringify(manifest(publicName, options.version ?? '1.4.0'), undefined, 2)}\n`,
    );
    if (options.built) {
      for (const [path, contents] of Object.entries(builtFiles)) {
        await Bun.write(join(work, packageDirectory, path), contents);
      }
    }
    await body(work, join(root, 'scratch'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('collectEntryPoints', () => {
  test('walks a nested exports map as well as the top-level fields', () => {
    expect(
      collectEntryPoints({
        main: './dist/index.js',
        types: './dist/index.d.ts',
        bin: { tool: './dist/cli.js' },
        exports: {
          '.': { import: { types: './dist/index.d.ts', default: './dist/index.js' } },
          './storage': './dist/storage/index.js',
        },
      }),
    ).toEqual(['dist/cli.js', 'dist/index.d.ts', 'dist/index.js', 'dist/storage/index.js']);
  });

  test('skips a subpath pattern, which resolves to whatever matches rather than to a file', () => {
    expect(
      collectEntryPoints({ exports: { './dist/*': './dist/*', '.': './dist/index.js' } }),
    ).toEqual(['dist/index.js']);
  });

  test('ignores a manifest with nothing to point at', () => {
    expect(collectEntryPoints({ name: 'x' })).toEqual([]);
    expect(collectEntryPoints(undefined)).toEqual([]);
  });
});

describe('readShippedPaths', () => {
  test('reads the file list npm says it would upload', () => {
    expect(readShippedPaths(npmReport('a@1.0.0', ['dist/index.js', 'package.json']))).toEqual([
      'dist/index.js',
      'package.json',
    ]);
  });

  test('refuses output that is not JSON rather than treating it as an empty tarball', () => {
    expect(() => readShippedPaths('+ a@1.0.0\n')).toThrow(PublishRehearsalError);
  });

  test('refuses a report with no file list', () => {
    expect(() => readShippedPaths(JSON.stringify({ 'a@1.0.0': { id: 'a@1.0.0' } }))).toThrow(
      PublishRehearsalError,
    );
  });
});

describe('proveNpmPublishDryRun', () => {
  test('builds, packs, lints and only then rehearses the publish', async () => {
    await withStagedTree({ built: true }, async (work, scratch) => {
      const harness = fakeRunner();
      const probe = await proveNpmPublishDryRun({
        run: harness.run,
        workDirectory: work,
        outcome: outcomeFor(),
        scratchDirectory: scratch,
      });

      expect(probe).toMatchObject({
        publicName,
        version: '1.4.0',
        exitCode: 0,
        buildExitCode: 0,
        publintExitCode: 0,
        typeResolutionExitCode: 0,
      });
      expect(probe.entries).toEqual(shippedByNpm);
      expect(probe.entryPoints).toEqual([
        'dist/index.cjs',
        'dist/index.d.cts',
        'dist/index.d.ts',
        'dist/index.js',
        'package.json',
      ]);
      expect(probe.tarball.endsWith('.tgz')).toBe(true);
      expect(probe.tarball.startsWith(work)).toBe(false);

      // The order is the whole point: a pack before the build inspects a tarball missing
      // everything the package exists to ship, and npm would report that as a success.
      expect(harness.commands.map((command) => command.join(' '))).toEqual([
        'bun run build',
        'npm publish --dry-run --ignore-scripts --tag latest --json',
      ]);
    });
  });

  test('names a tag for a prerelease version, which npm refuses to publish without one', async () => {
    await withStagedTree({ built: true, version: '2.0.0-rc.1' }, async (work, scratch) => {
      const harness = fakeRunner();
      await proveNpmPublishDryRun({
        run: harness.run,
        workDirectory: work,
        outcome: outcomeFor(),
        scratchDirectory: scratch,
      });
      expect(harness.commands.at(-1)).toEqual([
        'npm',
        'publish',
        '--dry-run',
        '--ignore-scripts',
        '--tag',
        'next',
        '--json',
      ]);
    });
  });

  /**
   * The regression this module was written for.
   *
   * `npm publish --dry-run` exits 0 against this tree — the allowlist matches nothing under a
   * `dist/` that does not exist, so npm packs the manifest alone and reports a successful
   * rehearsal. The probe has to fail anyway, and it has to fail before npm is reached at all.
   */
  test('refuses a package that was never built, which npm alone would call a success', async () => {
    await withStagedTree({ built: false }, async (work, scratch) => {
      const harness = fakeRunner();
      const error = await proveNpmPublishDryRun({
        run: harness.run,
        workDirectory: work,
        outcome: outcomeFor(),
        scratchDirectory: scratch,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PublishRehearsalError);
      expect((error as Error).message).toContain('publint --strict');
      expect((error as Error).message).toContain('./dist/index.js');
      expect(harness.commands.map((command) => command[0])).toEqual(['bun']);
    });
  });

  test('stops at a failing build rather than packing whatever is on disk', async () => {
    await withStagedTree({ built: true }, async (work, scratch) => {
      const harness = fakeRunner({ buildExitCode: 1 });
      const error = await proveNpmPublishDryRun({
        run: harness.run,
        workDirectory: work,
        outcome: outcomeFor(),
        scratchDirectory: scratch,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PublishRehearsalError);
      expect((error as Error).message).toContain('bun run build');
      expect(harness.commands.map((command) => command[0])).toEqual(['bun']);
    });
  });

  test('fails when npm exits non-zero', async () => {
    await withStagedTree({ built: true }, async (work, scratch) => {
      const error = await proveNpmPublishDryRun({
        run: fakeRunner({ npmExitCode: 1 }).run,
        workDirectory: work,
        outcome: outcomeFor(),
        scratchDirectory: scratch,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PublishRehearsalError);
    });
  });

  /**
   * `publint` reads a `bun pm pack` artifact; npm publishes one it packs itself. Both read the
   * same `files` allowlist, but they are different tools, so the only statement about npm's own
   * tarball is the one npm makes. This is that statement being checked.
   */
  test('refuses a green npm run whose reported tarball is missing an entry point', async () => {
    await withStagedTree({ built: true }, async (work, scratch) => {
      const error = await proveNpmPublishDryRun({
        run: fakeRunner({ shipped: ['package.json', 'dist/index.d.ts'] }).run,
        workDirectory: work,
        outcome: outcomeFor(),
        scratchDirectory: scratch,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PublishRehearsalError);
      expect((error as Error).message).toContain('dist/index.js');
      expect((error as Error).message).toContain('every consumer of it would fail');
    });
  });

  /**
   * The ruling this module makes, pinned so it cannot drift back by accident.
   *
   * `attw` is reported, not asserted. Every package the mirror publishes fails it today in the
   * form it is published in, so gating the rehearsal on it would make the publish unprovable for
   * all of them and say nothing about the transform. `verifyTarget` in `sync.ts` still gates on
   * it; this probe rules on whether the tarball is complete, which is publint's answer.
   */
  test('reports a failing type resolution without refusing an otherwise complete tarball', async () => {
    await withStagedTree({ built: true, esmOnly: true }, async (work, scratch) => {
      const probe = await proveNpmPublishDryRun({
        run: fakeRunner().run,
        workDirectory: work,
        outcome: outcomeFor(),
        scratchDirectory: scratch,
      });
      expect(probe.publintExitCode).toBe(0);
      expect(probe.typeResolutionExitCode).toBe(1);
      expect(probe.exitCode).toBe(0);
    });
  });

  /**
   * Without this there is no rehearsal of a released package at all: npm refuses to publish over
   * a version it already has, and the transform carries the target's version through untouched.
   */
  test('rehearses a named version, and says which one the tree carries', async () => {
    await withStagedTree({ built: true }, async (work, scratch) => {
      const harness = fakeRunner();
      const probe = await proveNpmPublishDryRun({
        run: harness.run,
        workDirectory: work,
        outcome: outcomeFor(),
        scratchDirectory: scratch,
        version: '1.5.0-rehearsal.0',
      });

      expect(probe.version).toBe('1.5.0-rehearsal.0');
      expect(probe.treeVersion).toBe('1.4.0');
      // The tag follows the rehearsed version, not the tree's: npm refuses a prerelease without one.
      expect(harness.commands.at(-1)?.join(' ')).toContain('--tag next');
      // Written before the build, so what packs is what npm was asked to publish.
      const manifest = (await Bun.file(
        join(work, packageDirectory, 'package.json'),
      ).json()) as Record<string, unknown>;
      expect(manifest['version']).toBe('1.5.0-rehearsal.0');
    });
  });

  test('refuses a package name this target does not publish', async () => {
    await withStagedTree({ built: true }, async (work, scratch) => {
      const error = await proveNpmPublishDryRun({
        run: fakeRunner().run,
        workDirectory: work,
        outcome: outcomeFor(),
        scratchDirectory: scratch,
        packageName: '@lostgradient/nothing',
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PublishRehearsalError);
      expect((error as Error).message).toContain('@lostgradient/cryptography');
    });
  });
});

describe('rehearsePublish', () => {
  test('clones the public mirror, transforms into it, and proves the publish there', async () => {
    const clones: { remote: string; directory: string }[] = [];
    const stages: { target: string; directory: string }[] = [];
    await withStagedTree({ built: true }, async (work, scratch) => {
      const report = await rehearsePublish({
        corvidaeRoot: '/corvidae',
        target: 'weft',
        directory: work,
        scratchDirectory: scratch,
        run: fakeRunner().run,
        clone: async ({ remote, directory }) => {
          clones.push({ remote, directory });
          return directory;
        },
        stage: async ({ target, directory }) => {
          stages.push({ target, directory });
          return outcomeFor();
        },
      });

      expect(clones).toEqual([{ remote: defaultRemote('weft'), directory: work }]);
      expect(stages).toEqual([{ target: 'weft', directory: work }]);
      expect(report.published).toEqual([publicName]);
      expect(report.probe.exitCode).toBe(0);
      expect(report.remote).toBe('https://github.com/stevekinney/weft.git');
    });
  });
});

describe('runPublishRehearsalCommand', () => {
  test('refuses an unknown target', async () => {
    expect(
      await runPublishRehearsalCommand([
        '--target',
        'nowhere',
        '--directory',
        '/tmp/x',
        '--scratch',
        '/tmp/y',
      ]),
    ).toBe(1);
  });

  test('refuses a run with nowhere to clone to', async () => {
    expect(await runPublishRehearsalCommand(['--target', 'weft'])).toBe(1);
  });
});
