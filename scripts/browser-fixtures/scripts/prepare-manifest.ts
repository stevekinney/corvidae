import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { extractFixtures } from '@lostgradient/testing';

import { appFixtureDeclarations } from '../src/app-fixture-declarations.ts';
import { assertUniqueFixtureNames } from '../src/manifest.ts';

/**
 * Where the manifest's inputs live and where its outputs go. The defaults describe this
 * repository; tests pass a layout over a temporary tree.
 */
export type ManifestLayout = {
  /** Paths in the input hash are relative to this directory. */
  repositoryRoot: string;
  /** Directories scanned for `*-fixtures.ts` declarations and `*.fixture.svelte` hosts. */
  fixtureRoots: string[];
  /** Module-map keys are relative to this directory. */
  sourceRoot: string;
  /** The directory of application fixtures (`*.svelte`), one per declared component. */
  appFixtureRoot: string;
  /** The application fixtures to add, by component name. */
  appFixtureDeclarations: Record<string, readonly string[]>;
  /**
   * Files that decide the manifest's content without being fixtures: patterns relative to
   * `repositoryRoot`, each of which must match at least one file.
   */
  codeInputs: string[];
  /** Receives `manifest.json`, `fixture-modules.ts`, and `manifest-inputs.sha256`. */
  outputDirectory: string;
};

const browserFixturesRoot = resolve(import.meta.dirname, '..');
const componentsRoot = resolve(
  browserFixturesRoot,
  '..',
  '..',
  'components',
  'cinder',
  'src',
  'components',
);
const chatComponentsRoot = resolve(componentsRoot, '../../../chat/src/lib/components');

/**
 * What `prepareManifest` reads besides the fixture files: itself, the application declarations
 * and the modules they import (`app-fixture-declarations.ts` pulls `TERMINAL_FIXTURE_NAMES` from
 * the terminal scenarios, which import the programs beside them), the manifest checks, the fixture
 * extraction behind `extractFixtures` and the schema it validates against, and the lockfile that
 * pins the TypeScript parser (the whole file, not one version: a lockfile change costs one
 * needless regeneration, never a stale manifest). `prepare-manifest.test.ts` follows the relative
 * imports of every one of these and fails when a module they reach is missing from this list.
 */
export const manifestCodeInputs: string[] = [
  'scripts/browser-fixtures/scripts/prepare-manifest.ts',
  'scripts/browser-fixtures/src/app-fixture-declarations.ts',
  'scripts/browser-fixtures/src/manifest.ts',
  'scripts/browser-fixtures/src/fixtures/terminal/*.ts',
  'testing/testing/src/fixture-extraction/*.ts',
  'testing/testing/src/visual-fixtures.ts',
  'bun.lock',
];

/** The layout of this repository. */
export const defaultManifestLayout: ManifestLayout = {
  repositoryRoot: resolve(browserFixturesRoot, '..', '..'),
  fixtureRoots: [componentsRoot, chatComponentsRoot],
  sourceRoot: resolve(browserFixturesRoot, 'src'),
  appFixtureRoot: resolve(browserFixturesRoot, 'src', 'fixtures'),
  appFixtureDeclarations,
  codeInputs: manifestCodeInputs,
  outputDirectory: resolve(browserFixturesRoot, '.playwright'),
};

/** The generated files, and the file that records which inputs they were generated from. */
export function manifestOutputPaths(layout: ManifestLayout): {
  manifest: string;
  moduleMap: string;
  inputHash: string;
} {
  return {
    manifest: resolve(layout.outputDirectory, 'manifest.json'),
    moduleMap: resolve(layout.outputDirectory, 'fixture-modules.ts'),
    inputHash: resolve(layout.outputDirectory, 'manifest-inputs.sha256'),
  };
}

/** Every file whose content, or whose existence, can change the manifest, sorted. */
export function manifestInputFiles(layout: ManifestLayout): string[] {
  const files = new Set<string>();
  const scan = (pattern: string, cwd: string): number => {
    let matches = 0;
    for (const path of new Bun.Glob(pattern).scanSync({ cwd, absolute: true })) {
      files.add(path);
      matches += 1;
    }
    return matches;
  };
  for (const root of layout.fixtureRoots) {
    scan('**/*-fixtures.ts', root);
    scan('**/*.fixture.svelte', root);
  }
  scan('*.svelte', layout.appFixtureRoot);
  for (const pattern of layout.codeInputs) {
    if (scan(pattern, layout.repositoryRoot) === 0) {
      throw new Error(
        `Manifest input '${pattern}' matches no file under ${layout.repositoryRoot}.`,
      );
    }
  }
  return [...files].toSorted();
}

/** A digest of the paths and contents of `manifestInputFiles`. */
export async function hashManifestInputs(layout: ManifestLayout): Promise<string> {
  const lines = await Promise.all(
    manifestInputFiles(layout).map(async (path) => {
      const contents = createHash('sha256')
        .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
        .digest('hex');
      return `${relative(layout.repositoryRoot, path).split(sep).join('/')}\0${contents}\n`;
    }),
  );
  return createHash('sha256').update(lines.join('')).digest('hex');
}

async function manifestIsCurrent(layout: ManifestLayout, inputHash: string): Promise<boolean> {
  const paths = manifestOutputPaths(layout);
  const recorded = await Bun.file(paths.inputHash)
    .text()
    .catch(() => undefined);
  // A missing or corrupt record never equals a digest, so it falls through to regeneration.
  if (recorded?.trim() !== inputHash) return false;
  // The record vouches for the outputs, so a deleted one must not read as current.
  const present = await Promise.all(
    [paths.manifest, paths.moduleMap].map((path) => Bun.file(path).exists()),
  );
  return present.every(Boolean);
}

/**
 * Writes the fixture manifest and module map, unless the hash recorded beside them still matches
 * the inputs and both exist. The record is removed before the outputs are touched and written
 * last, so a run that fails partway never leaves one that vouches for half-written files.
 */
export async function prepareManifest(
  layout: ManifestLayout = defaultManifestLayout,
): Promise<'current' | 'prepared'> {
  const paths = manifestOutputPaths(layout);
  const inputHash = await hashManifestInputs(layout);
  if (await manifestIsCurrent(layout, inputHash)) {
    console.log('manifest up to date');
    return 'current';
  }
  await rm(paths.inputHash, { force: true });
  const outputPath = paths.manifest;
  const moduleMapPath = paths.moduleMap;
  const appFixtureRoot = layout.appFixtureRoot;
  const results = await Promise.all(layout.fixtureRoots.map((root) => extractFixtures(root)));
  const result = {
    entries: results.flatMap((entry) => entry.entries),
    violations: results.flatMap((entry) => entry.violations),
  };
  if (result.violations.length > 0) {
    throw new Error(result.violations.join('\n'));
  }

  const entries = result.entries.map(({ componentName, fixtures, contentHash }) => ({
    name: componentName,
    slug: componentName,
    route: `/page/${componentName}`,
    fixtures: fixtures.map((fixture) => ({
      name: fixture.name,
      mode: 'host' in fixture ? ('host' as const) : ('direct' as const),
      fixtureContentHash: contentHash,
      ...(fixture.interact !== undefined ? { interact: fixture.interact } : {}),
      ...(fixture.mask !== undefined ? { mask: fixture.mask } : {}),
      category: fixture.category,
    })),
  }));
  for (const [componentName, fixtureNames] of Object.entries(layout.appFixtureDeclarations)) {
    const fixturePath = resolve(appFixtureRoot, `${componentName}.svelte`);
    const contentHash = createHash('sha256')
      .update(await Bun.file(fixturePath).text())
      .digest('hex');
    const entry = entries.find((candidate) => candidate.slug === componentName);
    const fixtures = fixtureNames.map((name) => ({
      name,
      mode: 'host' as const,
      fixtureContentHash: contentHash,
      category: 'visual-contract' as const,
    }));
    if (entry === undefined) {
      entries.push({
        name: componentName,
        slug: componentName,
        route: `/page/${componentName}`,
        fixtures,
      });
    } else {
      if (entry.fixtures === undefined) entry.fixtures = [];
      for (const fixture of fixtures) {
        if (!entry.fixtures.some((existing) => existing.name === fixture.name)) {
          entry.fixtures.push(fixture);
        }
      }
    }
  }
  assertUniqueFixtureNames(entries);
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');

  await mkdir(resolve(outputPath, '..'), { recursive: true });
  await Bun.write(outputPath, JSON.stringify({ digest, entries }, null, 2) + '\n');
  const sourceRoot = layout.sourceRoot;
  const moduleImport = (path: string): string => {
    const value = relative(resolve(moduleMapPath, '..'), path).split(sep).join('/');
    return value.startsWith('.') ? value : `./${value}`;
  };
  const moduleEntries = (modulePaths: string[]): string =>
    modulePaths
      .toSorted()
      .map((path) => {
        const relativePath = relative(sourceRoot, path).split(sep).join('/');
        const key = relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
        return `  ${JSON.stringify(key)}: () => import(${JSON.stringify(moduleImport(path))}),`;
      })
      .join('\n');
  const scanRoots = (pattern: string): string[] =>
    layout.fixtureRoots.flatMap((root) =>
      Array.from(new Bun.Glob(pattern).scanSync({ cwd: root, absolute: true })),
    );
  const fixturePaths = scanRoots('*/*-fixtures.ts');
  const hostPaths = scanRoots('**/*.fixture.svelte');
  const appPaths = Array.from(
    new Bun.Glob('*.svelte').scanSync({ cwd: appFixtureRoot, absolute: true }),
  );
  await writeFile(
    moduleMapPath,
    `// Generated by prepare-manifest.ts.\nexport const fixtureModules = {\n${moduleEntries(fixturePaths)}\n};\nexport const hostModules = {\n${moduleEntries(hostPaths)}\n};\nexport const appHostModules = {\n${moduleEntries(appPaths)}\n};\n`,
  );
  await Bun.write(paths.inputHash, `${inputHash}\n`);
  console.log(`prepared ${entries.length} fixture groups at ${outputPath}`);
  return 'prepared';
}

if (import.meta.main) await prepareManifest();
