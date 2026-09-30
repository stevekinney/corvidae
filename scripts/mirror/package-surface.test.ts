import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emitWorkerImplementationModule } from '../../packages/weft/src/cli/codegen-emit-worker.ts';
import { discoverWorkspaces } from './manifests.ts';
import { loadPackageMap } from './package-map.ts';
import {
  checkTargetCoverage,
  describeCoverage,
  filesCoverPath,
  flattenExportTarget,
  loadPackageSurface,
  missingBuildInputs,
  PackageSurfaceError,
  resolveSurface,
  sourceCandidatesForTarget,
  type PackageSurfaceEntry,
} from './package-surface.ts';

const corvidaeRoot = join(import.meta.dir, '..', '..');

async function withPackageRoot(
  files: Record<string, string>,
  body: (packageRoot: string) => Promise<void> | void,
): Promise<void> {
  const packageRoot = await mkdtemp(join(tmpdir(), 'package-surface-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(packageRoot, path), contents);
    }
    await body(packageRoot);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
}

function entryFor(overrides: Partial<PackageSurfaceEntry> = {}): PackageSurfaceEntry {
  return {
    publicName: 'example',
    provenance: { repository: null, path: null, commit: null, version: null },
    exports: { '.': './dist/index.js' },
    files: ['dist'],
    build: {
      scripts: { build: 'tsdown' },
      toolchain: {},
      requiredInputs: [],
      sourceRoot: 'src',
      packedBy: 'files',
    },
    manifestFields: {},
    ...overrides,
  };
}

describe('package-surface.json', () => {
  test('keeps generated test artifacts out of packed Chat and Editor packages', async () => {
    const surface = await loadPackageSurface();
    for (const workspace of ['@lostgradient/chat', '@lostgradient/editor']) {
      const files = surface.packages[workspace]?.files;
      expect(Array.isArray(files), workspace).toBe(true);
      if (!Array.isArray(files)) continue;
      expect(filesCoverPath(files, 'dist/components/example-test-helper.js'), workspace).toBe(
        false,
      );
      expect(filesCoverPath(files, 'dist/components/example.js'), workspace).toBe(true);
    }
  });

  test('exports every Weft package subpath emitted by worker codegen', async () => {
    const packageSurface = await loadPackageSurface();
    const entry = packageSurface.packages['@lostgradient/weft'];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const surface = resolveSurface({ entry, packageRoot: join(corvidaeRoot, 'packages/weft') });

    const generated = emitWorkerImplementationModule({}, '@lostgradient/weft');
    const imports = [...generated.matchAll(/from '(@lostgradient\/weft\/[^']+)'/g)];
    expect(imports.length).toBeGreaterThan(0);
    for (const match of imports) {
      const specifier = match[1];
      expect(specifier).toBeDefined();
      if (specifier === undefined) continue;
      const subpath = `.${specifier.slice('@lostgradient/weft'.length)}`;
      const target = surface.exports[subpath];
      expect(target, `${specifier} is missing from the public exports map`).toBeDefined();
      if (target === undefined) continue;
      const targets = flattenExportTarget(target).map(([, path]) => path);
      expect(targets).toContain('./dist/worker/generated-authoring.d.ts');
      expect(targets).toContain('./dist/worker/generated-authoring.js');
      for (const path of targets) {
        expect(filesCoverPath(surface.files, path.slice(2))).toBe(true);
      }
    }
  });

  test('parses and covers every workspace the map publishes', async () => {
    const surface = await loadPackageSurface();
    const map = await loadPackageMap();
    const published = Object.entries(map.workspaces)
      .filter(([, entry]) => entry.disposition === 'publish-as')
      .map(([workspace]) => workspace)
      .toSorted();
    expect(Object.keys(surface.packages).toSorted()).toEqual(published);
  });

  test('agrees with package-map.json about every public name', async () => {
    const surface = await loadPackageSurface();
    const map = await loadPackageMap();
    for (const [workspace, entry] of Object.entries(surface.packages)) {
      const disposition = map.workspaces[workspace];
      expect(disposition?.disposition).toBe('publish-as');
      if (disposition?.disposition !== 'publish-as') continue;
      expect(entry.publicName).toBe(disposition.name);
    }
  });

  test('names a workspace directory on disk for every entry', async () => {
    const surface = await loadPackageSurface();
    const workspaces = await discoverWorkspaces(corvidaeRoot);
    const onDisk = new Set(workspaces.map(({ name }) => name));
    for (const workspace of Object.keys(surface.packages)) {
      expect(onDisk.has(workspace), `${workspace} is not a workspace on disk`).toBe(true);
    }
  });

  test('carries the top-level fields a published package needs beyond its exports map', async () => {
    const surface = await loadPackageSurface();
    // `@lostgradient/weft-ui` used to be the one scoped package whose upstream manifest declared
    // no `publishConfig`, which was a plausible contributing cause of what COR-1194 records as an
    // incomplete trusted-publisher registration. COR-1196 moved it to `private-workspace`, so it
    // has no entry here at all and every remaining scoped published package carries `access:
    // public` — there is no longer an exception to carve out.
    for (const [workspace, entry] of Object.entries(surface.packages)) {
      const access = (entry.manifestFields['publishConfig'] as { access?: string } | undefined)
        ?.access;
      if (entry.publicName.startsWith('@')) {
        expect(access, workspace).toBe('public');
      }
      expect(entry.manifestFields['engines'], `${workspace} engines`).toBeDefined();
    }
  });

  test('carries provenance for everything it vendored and a note for everything it did not', async () => {
    const surface = await loadPackageSurface();
    for (const [workspace, entry] of Object.entries(surface.packages)) {
      if (entry.provenance.commit !== null) {
        expect(entry.provenance.repository, workspace).toBeString();
        expect(entry.provenance.path, workspace).toBeString();
        continue;
      }
      // A surface with no upstream to port from must say so rather than look vendored.
      expect(entry.provenance.note, `${workspace} has no provenance and no note`).toBeString();
    }
  });
});

describe('filesCoverPath', () => {
  test('publishes everything under a bare directory entry', () => {
    expect(filesCoverPath(['dist'], 'dist/index.js')).toBe(true);
    expect(filesCoverPath(['dist'], 'src/index.ts')).toBe(false);
  });

  test('lets a later negation remove what an earlier glob included', () => {
    const files = ['dist', '!dist/**/*.test.js'];
    expect(filesCoverPath(files, 'dist/index.js')).toBe(true);
    expect(filesCoverPath(files, 'dist/index.test.js')).toBe(false);
  });

  test('lets a later glob re-include what an earlier negation removed', () => {
    const files = ['src/**/*.ts', '!src/**/test/**', 'src/components/test/keep.ts'];
    expect(filesCoverPath(files, 'src/components/test/drop.ts')).toBe(false);
    expect(filesCoverPath(files, 'src/components/test/keep.ts')).toBe(true);
  });

  test('matches an exact file entry', () => {
    expect(filesCoverPath(['README.md'], 'README.md')).toBe(true);
    expect(filesCoverPath(['README.md'], 'README.md.bak')).toBe(false);
  });
});

describe('flattenExportTarget', () => {
  test('names the condition that reaches each target', () => {
    expect(flattenExportTarget({ types: './dist/index.d.ts', default: './dist/index.js' })).toEqual(
      [
        ['types', './dist/index.d.ts'],
        ['default', './dist/index.js'],
      ],
    );
  });

  test('descends into a nested condition object', () => {
    expect(flattenExportTarget({ bun: { types: './a.d.ts', default: './a.js' } })).toEqual([
      ['bun.types', './a.d.ts'],
      ['bun.default', './a.js'],
    ]);
  });

  test('yields nothing for a null target, which blocks rather than names a file', () => {
    expect(flattenExportTarget({ browser: null, default: './dist/index.js' })).toEqual([
      ['default', './dist/index.js'],
    ]);
  });

  test('indexes a fallback array', () => {
    expect(flattenExportTarget({ import: ['./a.js', './b.js'] })).toEqual([
      ['import[0]', './a.js'],
      ['import[1]', './b.js'],
    ]);
  });
});

describe('sourceCandidatesForTarget', () => {
  test('maps a build output back to its TypeScript input', () => {
    expect(sourceCandidatesForTarget('./dist/index.js', 'src')).toEqual([
      'src/index.ts',
      'src/index/index.ts',
    ]);
    expect(sourceCandidatesForTarget('./dist/index.d.ts', 'src')).toContain('src/index.ts');
    expect(sourceCandidatesForTarget('./dist/index.cjs', 'src')).toContain('src/index.ts');
  });

  test('maps a dual-format build’s CommonJS declarations back to the same TypeScript source', () => {
    // A `require` condition needs its own `.d.cts`, or publint and are-the-types-wrong both
    // report the CommonJS half as masquerading as ESM. Both extensions come out of one `.ts`.
    expect(sourceCandidatesForTarget('./dist/index.d.cts', 'src')).toContain('src/index.ts');
    expect(sourceCandidatesForTarget('./dist/index.d.mts', 'src')).toContain('src/index.ts');
  });

  test('maps a css declaration stub back to the stylesheet it sits beside', () => {
    expect(sourceCandidatesForTarget('./dist/components/button/button.css.d.ts', 'src')).toContain(
      'src/components/button/button.css',
    );
  });

  test('offers both readings of dist/server, since it is a mirror in one package and real in another', () => {
    expect(sourceCandidatesForTarget('./dist/server/handler.js', 'src')).toEqual([
      'src/server/handler.ts',
      'src/server/handler/index.ts',
      'src/handler.ts',
      'src/handler/index.ts',
    ]);
  });

  test('honours a deeper source root', () => {
    expect(sourceCandidatesForTarget('./dist/index.js', 'src/lib')).toContain('src/lib/index.ts');
  });

  test('returns a source target unchanged and offers nothing for a wildcard', () => {
    expect(sourceCandidatesForTarget('./src/index.ts', 'src')).toEqual(['src/index.ts']);
    expect(sourceCandidatesForTarget('./dist/*', 'src')).toEqual([]);
  });
});

describe('checkTargetCoverage', () => {
  test('passes when every target ships and has a source', async () => {
    await withPackageRoot({ 'src/index.ts': 'export {};\n' }, (packageRoot) => {
      expect(
        checkTargetCoverage({
          publicName: 'example',
          exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
          files: ['dist'],
          sourceRoot: 'src',
          packageRoot,
        }),
      ).toEqual([]);
    });
  });

  test('reports a target the allowlist would not publish', async () => {
    await withPackageRoot({ 'src/index.ts': 'export {};\n' }, (packageRoot) => {
      const findings = checkTargetCoverage({
        publicName: 'example',
        exports: { '.': { default: './src/index.ts' } },
        files: ['dist'],
        sourceRoot: 'src',
        packageRoot,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.problem).toBe('not-shipped');
      expect(describeCoverage(findings)).toContain('no files entry publishes it');
    });
  });

  test('reports a target whose source the checkout does not have', async () => {
    await withPackageRoot({ 'src/index.ts': 'export {};\n' }, (packageRoot) => {
      const findings = checkTargetCoverage({
        publicName: 'example',
        exports: { './gone': { default: './dist/gone.js' } },
        files: ['dist'],
        sourceRoot: 'src',
        packageRoot,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ subpath: './gone', problem: 'no-source' });
    });
  });

  test('walks bin targets alongside the exports map', async () => {
    await withPackageRoot({ 'src/main.ts': 'export {};\n' }, (packageRoot) => {
      const options = {
        publicName: 'example',
        exports: {},
        files: ['dist'],
        sourceRoot: 'src',
        packageRoot,
      };
      // A bin target is conventionally written without the leading `./`.
      expect(checkTargetCoverage({ ...options, bin: { example: 'dist/main.js' } })).toEqual([]);
      const findings = checkTargetCoverage({ ...options, bin: { example: 'dist/gone.js' } });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ subpath: 'bin:example', problem: 'no-source' });
    });
  });

  test('never faults package.json, which npm always publishes', async () => {
    await withPackageRoot({}, (packageRoot) => {
      expect(
        checkTargetCoverage({
          publicName: 'example',
          exports: { './package.json': './package.json' },
          files: ['dist'],
          sourceRoot: 'src',
          packageRoot,
        }),
      ).toEqual([]);
    });
  });
});

describe('resolveSurface', () => {
  test('returns a vendored surface verbatim', async () => {
    await withPackageRoot({}, (packageRoot) => {
      const resolved = resolveSurface({ entry: entryFor(), packageRoot });
      expect(resolved.exports).toEqual({ '.': './dist/index.js' });
      expect(resolved.files).toEqual(['dist']);
    });
  });

  test('refuses a generated surface with no discovered components', async () => {
    await withPackageRoot({}, (packageRoot) => {
      expect(() =>
        resolveSurface({
          entry: entryFor({ exports: { generator: 'cinder' }, files: { generator: 'cinder' } }),
          packageRoot,
        }),
      ).toThrow(PackageSurfaceError);
    });
  });

  test('generates cinder’s surface when components are supplied', async () => {
    await withPackageRoot({}, (packageRoot) => {
      const resolved = resolveSurface({
        entry: entryFor({ exports: { generator: 'cinder' }, files: { generator: 'cinder' } }),
        packageRoot,
        components: [{ name: 'card', isExperimental: false, hasCss: false }],
      });
      expect(resolved.exports['./card']).toBeDefined();
      expect(resolved.files).toContain('dist');
    });
  });
});

describe('missingBuildInputs', () => {
  test('names each declared build input the target clone does not carry', async () => {
    await withPackageRoot({ 'tsdown.config.ts': 'export default {};\n' }, (packageRoot) => {
      const entry = entryFor({
        build: {
          scripts: {},
          toolchain: {},
          requiredInputs: ['tsdown.config.ts', 'scripts/build.ts'],
          sourceRoot: 'src',
          packedBy: 'files',
        },
      });
      expect(missingBuildInputs(entry, packageRoot)).toEqual(['scripts/build.ts']);
    });
  });
});
