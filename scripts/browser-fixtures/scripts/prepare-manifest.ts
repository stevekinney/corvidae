import { resolve } from 'node:path';

import {
  prepareManifest,
  type ManifestLayout,
} from '@lostgradient/testing/browser/prepare-manifest';

import { appFixtureDeclarations } from '../src/app-fixture-declarations.ts';

const browserFixturesRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(browserFixturesRoot, '..', '..');
const componentsDirectory = resolve(repositoryRoot, 'components');

/**
 * What the root suite's `prepareManifest` reads besides the fixture files: this layout, the
 * application declarations and the modules they import (the chat, editor and terminal packages'
 * declarations, and the terminal scenarios, which import the programs beside them), the harness
 * that writes the manifest and its checks, the fixture extraction behind `extractFixtures` and the
 * schema it validates against, and the lockfile that pins the TypeScript parser (the whole file,
 * not one version: a lockfile change costs one needless regeneration, never a stale manifest).
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
  'testing/testing/src/fixture-extraction/*.ts',
  'testing/testing/src/visual-fixtures.ts',
  'bun.lock',
];

/** The layout of the root suite. */
export const defaultManifestLayout: ManifestLayout = {
  repositoryRoot,
  fixtureRoots: [
    resolve(componentsDirectory, 'cinder', 'src', 'components'),
    resolve(componentsDirectory, 'chat', 'src', 'lib', 'components'),
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
