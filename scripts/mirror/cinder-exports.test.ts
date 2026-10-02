import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentDiscovery } from '../../components/cinder/scripts/lib/discover-components.ts';
import {
  CinderExportsError,
  computeDeprecatedExperimentalAliases,
  computeExports,
  computeFiles,
  computeRootExport,
  generateCinderSurface,
  legacyEntrySourcePath,
  orderedExportEntry,
  rootLevelExportTargets,
  shouldPreserveLegacyEntry,
  STATIC_FILES_GLOBS,
  type ExportsMap,
} from './cinder/generate-exports.ts';

/**
 * The generator is a port, so the assertions that matter are the ones that would catch the port
 * drifting: condition order, which subpaths a component earns, and the reserved-entry stitching
 * order. Fidelity against the real published map is checked in `surface.test.ts`, where the
 * committed registry baseline makes it hermetic.
 */

/** A throwaway cinder package root holding only what the assertion under test needs. */
async function withPackageRoot(
  files: Record<string, string>,
  body: (packageRoot: string) => Promise<void> | void,
): Promise<void> {
  const packageRoot = await mkdtemp(join(tmpdir(), 'cinder-exports-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(packageRoot, path), contents);
    }
    await body(packageRoot);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
}

const button: ComponentDiscovery = { name: 'button', isExperimental: false, hasCss: true };
const plainCard: ComponentDiscovery = { name: 'card', isExperimental: false, hasCss: false };

describe('orderedExportEntry', () => {
  test('emits conditions in the order the resolver matrix requires', () => {
    const entry = orderedExportEntry({
      default: './dist/index.js',
      import: './src/index.ts',
      node: './dist/server/index.js',
      svelte: './src/index.ts',
      browser: './src/index.ts',
      types: './dist/index.d.ts',
    });
    expect(Object.keys(entry)).toEqual(['types', 'browser', 'svelte', 'node', 'import', 'default']);
  });

  test('keeps svelte ahead of node, which SvelteKit SSR depends on', () => {
    const keys = Object.keys(
      orderedExportEntry({ node: './dist/server/index.js', svelte: './src/index.ts' }),
    );
    expect(keys.indexOf('svelte')).toBeLessThan(keys.indexOf('node'));
  });

  test('omits absent conditions rather than emitting undefined', () => {
    expect(orderedExportEntry({ default: './dist/index.js' })).toEqual({
      default: './dist/index.js',
    });
  });
});

describe('computeRootExport', () => {
  test('resolves import and default to the same compiled file', () => {
    // publint --strict treats a root whose `import` and `default` name different files as a dual
    // CJS/ESM publish and demands CommonJS-shaped types under `require`, which an ESM-only package
    // cannot honestly supply. Bun and Node take `node`, bundlers take `browser` or `svelte`, so
    // `import` only reaches generic resolvers, which get the compiled build like `default` does.
    const root = computeRootExport();
    expect(root.import).toBe(root.default);
    expect(root.svelte).toBe('./src/index.ts');
    expect(root.browser).toBe('./src/index.ts');
  });
});

describe('computeExports', () => {
  test('gives every component its barrel, schema and variables subpaths', async () => {
    await withPackageRoot({}, (packageRoot) => {
      const exports = computeExports([plainCard], packageRoot);
      expect(Object.keys(exports)).toEqual([
        './manifest',
        './card',
        './card/schema',
        './card/variables',
      ]);
    });
  });

  test('emits a styles subpath only for a component that ships a CSS sidecar', async () => {
    await withPackageRoot({}, (packageRoot) => {
      expect(computeExports([button], packageRoot)['./button/styles']).toEqual({
        types: './dist/components/button/button.css.d.ts',
        default: './dist/components/button/button.css',
      });
      expect(computeExports([plainCard], packageRoot)['./card/styles']).toBeUndefined();
    });
  });

  test('emits JSON sidecar subpaths only when the file is on disk', async () => {
    await withPackageRoot({ 'src/components/card/card.examples.json': '[]\n' }, (packageRoot) => {
      const exports = computeExports([plainCard], packageRoot);
      expect(exports['./card/examples']).toEqual({
        import: './src/components/card/card.examples.json',
        default: './src/components/card/card.examples.json',
      });
      expect(exports['./card/constraints']).toBeUndefined();
    });
  });

  test('emits an enhancement subpath when the component owns one', async () => {
    await withPackageRoot(
      { 'src/components/card/card-enhancement.ts': 'export {};\n' },
      (packageRoot) => {
        expect(computeExports([plainCard], packageRoot)['./card/enhancement']).toMatchObject({
          browser: './src/components/card/card-enhancement.ts',
          default: './dist/components/card/card-enhancement.js',
        });
      },
    );
  });

  test('discovers token subpaths from what the token pipeline wrote', async () => {
    await withPackageRoot(
      {
        'src/tokens/index.json': '{}\n',
        'src/tokens/cinder.resolver.json': '{}\n',
        'src/tokens/color.tokens.json': '{}\n',
        'src/tokens/resolved/light.json': '{}\n',
        'src/tokens/registry.generated.ts': 'export {};\n',
      },
      (packageRoot) => {
        const keys = Object.keys(computeExports([], packageRoot));
        expect(keys).toEqual([
          './manifest',
          './tokens',
          './tokens/resolver',
          './tokens/color',
          './tokens/resolved/light',
          './tokens/registry',
        ]);
      },
    );
  });

  test('roots experimental components under experimental/', async () => {
    await withPackageRoot({}, (packageRoot) => {
      const exports = computeExports(
        [{ name: 'sparkline', isExperimental: true, hasCss: false }],
        packageRoot,
      );
      expect(exports['./experimental/sparkline']).toMatchObject({
        browser: './src/components/experimental/sparkline/index.ts',
      });
    });
  });
});

describe('computeDeprecatedExperimentalAliases', () => {
  test('points the component entry at the shim and metadata at the promoted location', () => {
    const aliases = computeDeprecatedExperimentalAliases([
      { name: 'message', hasCss: true, hasExamples: false },
    ]);
    expect(aliases['./experimental/message']).toMatchObject({
      browser: './src/components/experimental/message/index.ts',
    });
    expect(aliases['./experimental/message/schema']).toMatchObject({
      browser: './src/components/message/message.schema.ts',
    });
    expect(aliases['./experimental/message/examples']).toBeUndefined();
  });
});

describe('legacy flat subpaths', () => {
  test('reads the source path from svelte, falling back to default', () => {
    expect(legacyEntrySourcePath({ svelte: './src/a.ts', default: './dist/a.js' })).toBe(
      './src/a.ts',
    );
    expect(legacyEntrySourcePath({ default: './dist/a.js' })).toBe('./dist/a.js');
    expect(legacyEntrySourcePath('./dist/a.js')).toBeUndefined();
  });

  test('preserves an entry whose source survives and drops one whose source is gone', async () => {
    await withPackageRoot({ 'src/legacy.ts': 'export {};\n' }, (packageRoot) => {
      expect(shouldPreserveLegacyEntry({ svelte: './src/legacy.ts' }, packageRoot)).toBe(true);
      expect(shouldPreserveLegacyEntry({ svelte: './src/hidden.ts' }, packageRoot)).toBe(false);
      // A bare string names no source, so it is kept rather than guessed away.
      expect(shouldPreserveLegacyEntry('./dist/legacy.js', packageRoot)).toBe(true);
    });
  });

  test('carries a surviving flat subpath through regeneration', async () => {
    await withPackageRoot({ 'src/components/legacy.ts': 'export {};\n' }, (packageRoot) => {
      const surface = generateCinderSurface({
        packageRoot,
        components: [plainCard],
        existingExports: { './legacy': { svelte: './src/components/legacy.ts' } },
      });
      expect(surface.exports['./legacy']).toEqual({ svelte: './src/components/legacy.ts' });
    });
  });
});

describe('generateCinderSurface', () => {
  test('stitches reserved entries ahead of the computed subpaths', async () => {
    await withPackageRoot({}, (packageRoot) => {
      const keys = Object.keys(
        generateCinderSurface({ packageRoot, components: [plainCard] }).exports,
      );
      expect(keys.slice(0, 11)).toEqual([
        '.',
        './package.json',
        './styles',
        './styles/all',
        './styles/tokens',
        './styles/foundation',
        './styles/utilities',
        './styles/json-highlight',
        './styles/guard',
        './icons',
        './knowledge',
      ]);
      expect(keys.at(-1)).toBe('./experimental/message/styles');
    });
  });

  test('rejects a forbidden key already on disk instead of quietly dropping it', async () => {
    await withPackageRoot({}, (packageRoot) => {
      expect(() =>
        generateCinderSurface({
          packageRoot,
          components: [],
          existingExports: { './__debug': './src/debug.ts' },
        }),
      ).toThrow(CinderExportsError);
    });
  });

  test('refuses a computed key that would overwrite a reserved entry', async () => {
    await withPackageRoot({}, (packageRoot) => {
      expect(() =>
        generateCinderSurface({
          packageRoot,
          components: [{ name: 'icons', isExperimental: false, hasCss: false }],
        }),
      ).toThrow(/overlaps a reserved entry/);
    });
  });
});

describe('computeFiles', () => {
  test('excludes Svelte test sources and declarations without excluding components', () => {
    const exclusions = STATIC_FILES_GLOBS.filter((pattern) => pattern.startsWith('!')).map(
      (pattern) => new Bun.Glob(pattern.slice(1)),
    );
    const isExcluded = (path: string) => exclusions.some((pattern) => pattern.match(path));

    for (const path of [
      'src/components/button/button.test.svelte',
      'src/components/button/button.spec.svelte',
      'src/components/button/button-test.svelte',
      'src/components/button/button.fixture.svelte',
      'src/components/button/button-keyboard-harness.svelte',
      'dist/components/button/button.test.svelte.d.ts',
      'dist/components/button/button.spec.svelte.d.ts',
      'dist/components/button/button-test.svelte.d.ts',
      'dist/components/button/button.fixture.svelte.d.ts',
      'dist/components/button/button-keyboard-harness.svelte.d.ts',
    ]) {
      expect(isExcluded(path)).toBe(true);
    }
    expect(isExcluded('src/components/button/button.svelte')).toBe(false);
    expect(isExcluded('dist/components/button/button.svelte.d.ts')).toBe(false);

    const svelteFilesIndex = STATIC_FILES_GLOBS.indexOf('src/components/**/*.svelte');
    for (const exclusion of [
      '!src/components/**/*.type-test.svelte',
      '!src/components/**/*.test.svelte',
      '!src/components/**/*.spec.svelte',
      '!src/components/**/*-test.svelte',
      '!src/components/**/*fixture*.svelte',
      '!src/components/**/_*-test-harness.svelte',
      '!src/components/**/*harness*.svelte',
    ]) {
      expect(STATIC_FILES_GLOBS.indexOf(exclusion)).toBeGreaterThan(svelteFilesIndex);
    }
  });

  test('ships root source imports but excludes test-only component helpers', () => {
    expect(STATIC_FILES_GLOBS).toContain('src/exports/**/*.ts');
    expect(STATIC_FILES_GLOBS).toContain('!src/components/**/*-test-helpers.ts');
    expect(STATIC_FILES_GLOBS).toContain('!src/components/**/*-test-support.ts');
    expect(STATIC_FILES_GLOBS).toContain('!src/components/**/*-test-support.svelte.ts');
    expect(STATIC_FILES_GLOBS).toContain('!src/components/**/*-snippet-helpers.ts');
    expect(STATIC_FILES_GLOBS).toContain('!src/_internal/**/*-test-helpers.ts');
    expect(STATIC_FILES_GLOBS).toContain('!src/_internal/**/*-test-support.ts');
    expect(STATIC_FILES_GLOBS).toContain('!src/utilities/**/*-test-helpers.ts');
    expect(STATIC_FILES_GLOBS).toContain('!src/utilities/**/*-test-support.ts');
  });

  test('keeps the static globs verbatim and in order', async () => {
    await withPackageRoot({}, (packageRoot) => {
      const { files } = generateCinderSurface({ packageRoot, components: [plainCard] });
      expect(files.slice(0, STATIC_FILES_GLOBS.length)).toEqual([...STATIC_FILES_GLOBS]);
    });
  });

  test('appends root-level artifacts the exports map names, bytewise sorted', () => {
    const exports: ExportsMap = {
      './manifest': { import: './components.json', default: './components.json' },
      './inventory': { import: './inventory.json', default: './inventory.json' },
    };
    expect(computeFiles(exports, ['dist'], ['components.json'])).toEqual([
      'dist',
      'components.json',
      'inventory.json',
    ]);
  });

  test('ignores package.json and nested targets when collecting root artifacts', () => {
    expect(
      rootLevelExportTargets({
        './package.json': './package.json',
        '.': { default: './dist/index.js' },
        './manifest': { import: './components.json', default: './components.json' },
      }),
    ).toEqual(['components.json']);
  });
});
