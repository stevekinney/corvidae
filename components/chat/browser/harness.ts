/**
 * Chat's browser suite (COR-2080): `bun harness.ts prepare` writes the fixture manifest, and
 * `bun harness.ts serve --port <port>` builds and serves the fixtures, which `playwright.config.ts`
 * starts. The suite serves the chat components' own fixtures and the application fixtures in
 * `fixtures/`.
 */
import { packageSuite } from '@lostgradient/testing/browser/package-suite';
import { resolve } from 'node:path';

import { chatAppFixtureDeclarations } from './fixture-declarations.ts';

export const suite = packageSuite({
  root: import.meta.dirname,
  fixtureRoots: [resolve(import.meta.dirname, '..', 'src', 'lib', 'components')],
  appFixtureDeclarations: chatAppFixtureDeclarations,
});

if (import.meta.main) await suite.main(Bun.argv.slice(2));
