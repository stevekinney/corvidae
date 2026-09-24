import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertTarballsPublishable,
  checkTarball,
  importableSpecifierEntries,
  importableSpecifiers,
  nodeImportableSpecifierEntries,
  PackagingError,
  packWorkspace,
  runConsumerSmokeTest,
  smokeScript,
  type TarballReport,
} from './packaging.ts';

const corvidaeRoot = join(import.meta.dir, '..', '..');

/**
 * Packages built by hand rather than by the transform, so these assertions stay about the
 * packaging checks themselves and run without a clone, an install or a bundler. Nothing here
 * reaches the network: `publint` and `attw` read a `.tgz` off disk, and the consumer project
 * installs from a `file:` specifier.
 */

type PackageFiles = Record<string, string>;

/**
 * A package shaped the way `package-surface.json` says the mirror publishes one: dual ESM and CJS
 * output, `types` first and `default` last in the conditions, and `main`/`types` at the top level
 * for resolvers that predate `exports`. That combination is what clears `attw` on all four of its
 * resolution modes, so it is the baseline the negative cases below break one property away from.
 */
function soundPackage(name: string): PackageFiles {
  return {
    'package.json': `${JSON.stringify(
      {
        name,
        version: '1.0.0',
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
      },
      undefined,
      2,
    )}\n`,
    'dist/index.js': 'export const answer = 42;\n',
    'dist/index.cjs': 'exports.answer = 42;\n',
    'dist/index.d.ts': 'export declare const answer: number;\n',
    'dist/index.d.cts': 'export declare const answer: number;\n',
  };
}

/**
 * A package with a second subpath, for the smoke test alone.
 *
 * The smoke test exists to import every subpath rather than only the root, which needs a package
 * that has more than one. It deliberately skips the node10 fallbacks a subpath would need to
 * clear `attw`, because no assertion here runs `attw` against it.
 */
function subpathPackage(name: string): PackageFiles {
  return {
    'package.json': `${JSON.stringify(
      {
        name,
        version: '1.0.0',
        type: 'module',
        license: 'MIT',
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './extra': { types: './dist/extra.d.ts', default: './dist/extra.js' },
        },
        files: ['dist'],
      },
      undefined,
      2,
    )}\n`,
    'dist/index.js': 'export const answer = 42;\n',
    'dist/index.d.ts': 'export declare const answer: number;\n',
    'dist/extra.js': 'export const extra = true;\n',
    'dist/extra.d.ts': 'export declare const extra: boolean;\n',
  };
}

/**
 * A package with one JSON subpath alongside its module subpath — the real shape of cinder's
 * `*.examples.json` sidecars (COR-1196). `./data` is a plain-string `.json` target, the same shape
 * `package-surface.json` vendors for chat's/editor's examples sidecars; `withRootExports`-style
 * conditional objects are covered separately in the "JSON import attribute" unit tests above.
 */
function jsonSubpathPackage(name: string): PackageFiles {
  return {
    'package.json': `${JSON.stringify(
      {
        name,
        version: '1.0.0',
        type: 'module',
        license: 'MIT',
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './data': './dist/data.json',
        },
        files: ['dist'],
      },
      undefined,
      2,
    )}\n`,
    'dist/index.js': 'export const answer = 42;\n',
    'dist/index.d.ts': 'export declare const answer: number;\n',
    'dist/data.json': `${JSON.stringify({ answer: 42 })}\n`,
  };
}

async function withPackage(
  files: PackageFiles,
  body: (directory: string, scratch: string) => Promise<void>,
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'corvidae-packaging-'));
  try {
    const directory = join(scratch, 'package');
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(directory, path), contents);
    }
    await body(directory, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

describe('importable specifiers', () => {
  test('every concrete subpath becomes a specifier a consumer can write', () => {
    expect(
      importableSpecifiers('@lostgradient/weft', {
        '.': './dist/index.js',
        './storage': './dist/storage/index.js',
        './dist/*': './dist/*',
        './package.json': './package.json',
      }),
    ).toEqual(['@lostgradient/weft', '@lostgradient/weft/storage']);
  });
});

/**
 * COR-1196. Node refuses a `.json` export target without `with { type: 'json' }` on the importing
 * statement (`ERR_IMPORT_ATTRIBUTE_MISSING`) — cinder's `*.examples.json` sidecars are exactly this
 * shape. `importableSpecifierEntries`/`nodeImportableSpecifierEntries` decide the attribute from the
 * export target's own leaves (`flattenExportTarget`, which `package-surface.ts` already exports for
 * `checkTargetCoverage`), not from the subpath's spelling, and have to handle both real shapes: a
 * plain-string `.json` target (chat's/editor's vendored `package-surface.json` entries) and a
 * conditional `{ import, default }` object naming the same `.json` file twice (cinder's own
 * `jsonSidecarExport`).
 */
describe('the JSON import attribute (COR-1196)', () => {
  const exports = {
    '.': './dist/index.js',
    './manifest': './dist/manifest.json',
    './examples': { import: './dist/widget.examples.json', default: './dist/widget.examples.json' },
    './package.json': './package.json',
  };

  test('a plain-string .json target and a conditional-object .json target are both flagged; the module subpath is not', () => {
    const entries = importableSpecifierEntries('@fixture/widgets', exports);
    expect(entries).toEqual([
      { specifier: '@fixture/widgets', json: false },
      { specifier: '@fixture/widgets/examples', json: true },
      { specifier: '@fixture/widgets/manifest', json: true },
    ]);
  });

  test('node-importable entries carry the same json flags, since both json targets resolve under import/default', () => {
    expect(nodeImportableSpecifierEntries('@fixture/widgets', exports)).toEqual(
      importableSpecifierEntries('@fixture/widgets', exports),
    );
  });

  test('a `types` leaf never votes: a subpath typed as .d.ts but resolving to .json is still json-only', () => {
    const entries = importableSpecifierEntries('@fixture/typed', {
      './data': { types: './dist/data.d.ts', default: './dist/data.json' },
    });
    expect(entries).toEqual([{ specifier: '@fixture/typed/data', json: true }]);
  });

  test('a subpath whose conditions disagree about .json has no single correct attribute and is a hard failure', () => {
    expect(() =>
      importableSpecifierEntries('@fixture/mixed', {
        './ambiguous': { import: './dist/ambiguous.json', require: './dist/ambiguous.js' },
      }),
    ).toThrow(PackagingError);
  });

  test('the smoke script imports exactly the json entries with the attribute, everything else unchanged', () => {
    const entries = importableSpecifierEntries('@fixture/widgets', exports);
    const script = smokeScript(entries);
    expect(script).toContain(
      "import * as module0 from '@fixture/widgets';\n" +
        "import * as module1 from '@fixture/widgets/examples' with { type: 'json' };\n" +
        "import * as module2 from '@fixture/widgets/manifest' with { type: 'json' };\n",
    );
  });
});

describe('packaging checks against a packed tarball', () => {
  test('a sound package packs, lints and resolves cleanly', async () => {
    await withPackage(soundPackage('@fixture/sound'), async (directory, scratch) => {
      const tarball = await packWorkspace({
        packageDirectory: directory,
        destination: join(scratch, 'tarballs'),
      });
      expect(tarball.endsWith('.tgz')).toBe(true);

      const report = await checkTarball('@fixture/sound', tarball, corvidaeRoot);
      expect(report.publint.exitCode).toBe(0);
      expect(report.typeResolution.exitCode).toBe(0);
      expect(() => assertTarballsPublishable([report])).not.toThrow();
    });
  }, 60_000);

  /** Replace the root exports entry, leaving everything else about the package alone. */
  function withRootExports(files: PackageFiles, entry: unknown): PackageFiles {
    const manifest = JSON.parse(files['package.json'] ?? '{}') as {
      exports: Record<string, unknown>;
    };
    manifest.exports['.'] = entry;
    return { ...files, 'package.json': `${JSON.stringify(manifest, undefined, 2)}\n` };
  }

  test('publint rejects conditions ordered so that types and default resolve wrongly', async () => {
    // Conditions are order-sensitive: `types` after `default` is never consulted, and `default`
    // before another condition shadows it. Both were true of four entries in
    // package-surface.json until this gate was pointed at them.
    const files = withRootExports(soundPackage('@fixture/misordered'), {
      import: './dist/index.js',
      default: './dist/index.js',
      types: './dist/index.d.ts',
    });
    await withPackage(files, async (directory, scratch) => {
      const tarball = await packWorkspace({
        packageDirectory: directory,
        destination: join(scratch, 'tarballs'),
      });
      const report = await checkTarball('@fixture/misordered', tarball, corvidaeRoot);
      expect(report.publint.exitCode).not.toBe(0);
      expect(() => assertTarballsPublishable([report])).toThrow(PackagingError);
    });
  }, 60_000);

  test('both gates reject one shared types entry covering a require condition', async () => {
    // The second defect the same four entries carried: a dual-format package needs `.d.cts`
    // declarations under `require`, because one `.d.ts` read through `require` describes the
    // CommonJS output as ESM. Ordering alone does not fix it, which is why this is pinned apart.
    const files = withRootExports(soundPackage('@fixture/shared-types'), {
      types: './dist/index.d.ts',
      bun: './dist/index.js',
      import: './dist/index.js',
      require: './dist/index.cjs',
      default: './dist/index.js',
    });
    await withPackage(files, async (directory, scratch) => {
      const tarball = await packWorkspace({
        packageDirectory: directory,
        destination: join(scratch, 'tarballs'),
      });
      const report = await checkTarball('@fixture/shared-types', tarball, corvidaeRoot);
      expect(report.publint.exitCode).not.toBe(0);
      expect(report.typeResolution.exitCode).not.toBe(0);
    });
  }, 60_000);

  test('publint rejects declarations the manifest promises but the build never emitted', async () => {
    // The two gates divide this case. `attw` reports a package with no declarations at all as
    // untyped and exits zero, because an untyped JavaScript package is legal; only `publint`
    // knows the manifest promised a `types` file that is not in the tarball. Asserting it here
    // rather than on `attw` is what stops this test passing for the wrong reason.
    const files = soundPackage('@fixture/untyped');
    delete files['dist/index.d.ts'];
    delete files['dist/index.d.cts'];
    await withPackage(files, async (directory, scratch) => {
      const tarball = await packWorkspace({
        packageDirectory: directory,
        destination: join(scratch, 'tarballs'),
      });
      const report = await checkTarball('@fixture/untyped', tarball, corvidaeRoot);
      expect(report.publint.exitCode).not.toBe(0);
      expect(() => assertTarballsPublishable([report])).toThrow(PackagingError);
    });
  }, 60_000);

  test('the failure message names every offending package rather than only the first', () => {
    const failing = (publicName: string): TarballReport => ({
      publicName,
      tarball: `/tmp/${publicName}.tgz`,
      publint: { command: 'publint', exitCode: 1, stdout: 'broken', stderr: '' },
      typeResolution: { command: 'attw', exitCode: 0, stdout: '', stderr: '' },
    });
    expect(() => assertTarballsPublishable([failing('one'), failing('two')])).toThrow(/one/);
    expect(() => assertTarballsPublishable([failing('one'), failing('two')])).toThrow(/two/);
  });
});

describe('COR-1230: the attw gate is scoped to internal-resolution-error', () => {
  /**
   * ESM-only, no `require` condition and no top-level `main`/`types` fallback. Against `attw`'s
   * default profile this fails exactly the two rules COR-1230 rules ignorable: `CJSResolvesToESM`
   * (no CJS entry point, so a `require()` resolves to ESM) and `NoResolution` under node10 (no
   * `main`/`types` for the resolver that predates `exports`). Neither is a declaration defect.
   */
  function esmOnlyPackage(name: string): PackageFiles {
    return {
      'package.json': `${JSON.stringify(
        {
          name,
          version: '1.0.0',
          type: 'module',
          license: 'MIT',
          exports: {
            '.': { types: './dist/index.d.ts', default: './dist/index.js' },
            './package.json': './package.json',
          },
          files: ['dist'],
        },
        undefined,
        2,
      )}\n`,
      'dist/index.js': 'export const answer = 42;\n',
      'dist/index.d.ts': 'export declare const answer: number;\n',
    };
  }

  /**
   * A declaration file importing an extensionless sibling. Under node16 module resolution a
   * relative import from a `.d.ts` has to name its extension, so `attw` reports
   * `InternalResolutionError` here regardless of `--ignore-rules`, since that rule is not one of
   * the two COR-1230 names.
   */
  function internalResolutionErrorPackage(name: string): PackageFiles {
    return {
      'package.json': `${JSON.stringify(
        {
          name,
          version: '1.0.0',
          type: 'module',
          license: 'MIT',
          main: './dist/index.js',
          types: './dist/index.d.ts',
          exports: {
            '.': { types: './dist/index.d.ts', default: './dist/index.js' },
            './package.json': './package.json',
          },
          files: ['dist'],
        },
        undefined,
        2,
      )}\n`,
      'dist/index.js': "export * from './types.js';\n",
      'dist/index.d.ts': "export * from './types';\n",
      'dist/types.js': 'export const value = 1;\n',
      'dist/types.d.ts': 'export declare const value: number;\n',
    };
  }

  test('a tarball with only CJSResolvesToESM and node10 NoResolution passes', async () => {
    await withPackage(esmOnlyPackage('@fixture/esm-only'), async (directory, scratch) => {
      const tarball = await packWorkspace({
        packageDirectory: directory,
        destination: join(scratch, 'tarballs'),
      });
      const report = await checkTarball('@fixture/esm-only', tarball, corvidaeRoot);
      expect(report.typeResolution.exitCode).toBe(0);
      expect(() => assertTarballsPublishable([report])).not.toThrow();
    });
  }, 60_000);

  test('a tarball carrying InternalResolutionError still fails the gate', async () => {
    await withPackage(
      internalResolutionErrorPackage('@fixture/internal-resolution-error'),
      async (directory, scratch) => {
        const tarball = await packWorkspace({
          packageDirectory: directory,
          destination: join(scratch, 'tarballs'),
        });
        const report = await checkTarball(
          '@fixture/internal-resolution-error',
          tarball,
          corvidaeRoot,
        );
        expect(report.typeResolution.exitCode).not.toBe(0);
        expect(() => assertTarballsPublishable([report])).toThrow(PackagingError);
      },
    );
  }, 60_000);
});

describe('the consumer smoke test', () => {
  test('installs the tarball and imports every subpath it publishes', async () => {
    await withPackage(subpathPackage('@fixture/consumable'), async (directory, scratch) => {
      const tarball = await packWorkspace({
        packageDirectory: directory,
        destination: join(scratch, 'tarballs'),
      });
      const result = await runConsumerSmokeTest({
        directory: scratch,
        packages: [
          {
            publicName: '@fixture/consumable',
            tarball,
            exports: {
              '.': './dist/index.js',
              './extra': './dist/extra.js',
              './package.json': './package.json',
            },
          },
        ],
      });
      expect(result.specifiers).toEqual(['@fixture/consumable', '@fixture/consumable/extra']);
    });
  }, 60_000);

  test('a subpath the tarball does not actually ship fails the import, not just the lint', async () => {
    const files = subpathPackage('@fixture/hollow');
    delete files['dist/extra.js'];
    delete files['dist/extra.d.ts'];
    await withPackage(files, async (directory, scratch) => {
      const tarball = await packWorkspace({
        packageDirectory: directory,
        destination: join(scratch, 'tarballs'),
      });
      await expect(
        runConsumerSmokeTest({
          directory: scratch,
          packages: [
            {
              publicName: '@fixture/hollow',
              tarball,
              exports: { '.': './dist/index.js', './extra': './dist/extra.js' },
            },
          ],
        }),
      ).rejects.toThrow(PackagingError);
    });
  }, 60_000);

  test('a smoke test with nothing importable is a failure rather than a vacuous pass', async () => {
    await expect(
      runConsumerSmokeTest({
        directory: tmpdir(),
        packages: [{ publicName: '@fixture/empty', tarball: '/dev/null', exports: {} }],
      }),
    ).rejects.toThrow(/no importable specifier/);
  });

  // COR-1196. Before the fix, `smoke-node.mjs` wrote `import * as module1 from
  // '@fixture/json-widget/data';` with no attribute; node refuses that for a `.json` target with
  // `ERR_IMPORT_ATTRIBUTE_MISSING`, which `consumer-run-node` surfaced against the real
  // `chat-composer-popover.examples.json` sidecar. This runs both the bun and the node import for
  // real against a packed tarball, so it is the reproduction, not just an assertion on generated text.
  test('a .json subpath installs and imports cleanly under both bun and node', async () => {
    await withPackage(jsonSubpathPackage('@fixture/json-widget'), async (directory, scratch) => {
      const tarball = await packWorkspace({
        packageDirectory: directory,
        destination: join(scratch, 'tarballs'),
      });
      const result = await runConsumerSmokeTest({
        directory: scratch,
        packages: [
          {
            publicName: '@fixture/json-widget',
            tarball,
            exports: {
              '.': { types: './dist/index.d.ts', default: './dist/index.js' },
              './data': './dist/data.json',
            },
          },
        ],
      });
      expect(result.specifiers).toEqual(['@fixture/json-widget', '@fixture/json-widget/data']);
    });
  }, 60_000);
});
