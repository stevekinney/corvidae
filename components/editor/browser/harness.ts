/**
 * The editor's browser suite (COR-2080): `bun harness.ts prepare` writes the fixture manifest, and
 * `bun harness.ts serve --port <port>` builds and serves the fixtures, which `playwright.config.ts`
 * starts. The suite serves the application fixtures in `fixtures/`.
 */
import { packageSuite } from '@lostgradient/testing/browser/package-suite';

import { editorAppFixtureDeclarations } from './fixture-declarations.ts';

export const suite = packageSuite({
  root: import.meta.dirname,
  appFixtureDeclarations: editorAppFixtureDeclarations,
});

if (import.meta.main) await suite.main(Bun.argv.slice(2));
