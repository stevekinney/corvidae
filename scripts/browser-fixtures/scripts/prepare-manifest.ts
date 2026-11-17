import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import {
  prepareManifest,
  type ManifestLayout,
} from '@lostgradient/testing/browser/prepare-manifest';

import { appFixtureDeclarations } from '../src/app-fixture-declarations.ts';

const browserFixturesRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(browserFixturesRoot, '..', '..');
const componentsDirectory = resolve(repositoryRoot, 'components');
const chatComponentsRoot = resolve(componentsDirectory, 'chat', 'src', 'lib', 'components');

/** Core's manifest, which lists every Cinder component and where its source lives (COR-2085). */
export const CORE_MANIFEST = 'components/cinder/.metadata/components.json';

type CoreManifest = {
  components?: { source?: { packageRoot?: unknown; directory?: unknown } }[];
};

/**
 * The directories that hold Cinder's component directories: the parent of every component
 * directory core's manifest lists, so core's own `src/components` and each family package's. Each
 * is scanned whole, as the single Cinder root was, so the fixtures beside the components and in
 * underscore directories stay in.
 */
export function cinderComponentRoots(manifestPath: string): string[] {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CoreManifest;
  // Source paths are relative to core's directory, the manifest's own or (COR-2078) its parent.
  const manifestDirectory = dirname(manifestPath);
  const coreRoot = manifestDirectory.endsWith(`${sep}.metadata`)
    ? dirname(manifestDirectory)
    : manifestDirectory;
  const roots = new Set<string>();
  for (const component of manifest.components ?? []) {
    const { packageRoot, directory } = component.source ?? {};
    if (typeof packageRoot !== 'string' || typeof directory !== 'string') {
      throw new Error(`${manifestPath} lists a component without its source directory.`);
    }
    roots.add(dirname(resolve(coreRoot, packageRoot, directory)));
  }
  return [...roots].toSorted();
}

/**
 * What the root suite's `prepareManifest` reads besides the fixture files: this layout, core's
 * manifest (which names the directories Cinder's fixtures are read from), the application
 * declarations and the modules they import (the chat, editor and terminal packages' declarations,
 * and the terminal scenarios, which import the programs beside them), the harness that writes the
 * manifest and its checks, the fixture extraction behind `extractFixtures` and the schema it
 * validates against, and the lockfile that pins the TypeScript parser (the whole file, not one
 * version: a lockfile change costs one needless regeneration, never a stale manifest).
 * `prepare-manifest.integration.test.ts` follows the relative imports of every one of these and
 * fails when a module they reach is missing from this list.
 */
export const manifestCodeInputs: string[] = [
  'scripts/browser-fixtures/scripts/prepare-manifest.ts',
  'scripts/browser-fixtures/src/app-fixture-declarations.ts',
  'components/{chat,editor,terminal}/browser/fixture-declarations.ts',
  'components/terminal/browser/fixtures/terminal/*.ts',
  'testing/testing/src/browser/prepare-manifest.ts',
  'testing/testing/src/browser/manifest.ts',
  CORE_MANIFEST,
  'testing/testing/src/fixture-extraction/*.ts',
  'testing/testing/src/visual-fixtures.ts',
  'bun.lock',
];

/** The layout of the root suite. */
export const defaultManifestLayout: ManifestLayout = {
  repositoryRoot,
  fixtureRoots: [
    ...cinderComponentRoots(resolve(repositoryRoot, CORE_MANIFEST)),
    chatComponentsRoot,
  ],
  sourceRoot: resolve(browserFixturesRoot, 'src'),
  appFixtureRoots: [
    resolve(browserFixturesRoot, 'src', 'fixtures'),
    ...['chat', 'editor', 'terminal'].map((name) =>
      resolve(componentsDirectory, name, 'browser', 'fixtures'),
    ),
  ],
  appFixtureDeclarations,
  codeInputs: manifestCodeInputs,
  outputDirectory: resolve(browserFixturesRoot, '.playwright'),
};

if (import.meta.main) await prepareManifest(defaultManifestLayout);
