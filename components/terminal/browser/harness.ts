/**
 * The terminal's browser suite (COR-2080): `bun harness.ts prepare` writes the fixture manifest,
 * and `bun harness.ts serve --port <port>` builds and serves the fixtures, which
 * `playwright.config.ts` starts. The suite serves the application fixtures in `fixtures/`; the
 * terminal's fixture names come from `fixtures/terminal/scenarios.ts`, so those modules are
 * manifest inputs too.
 */
import { packageSuite } from '@lostgradient/testing/browser/package-suite';

import { terminalAppFixtureDeclarations } from './fixture-declarations.ts';

export const suite = packageSuite({
  root: import.meta.dirname,
  appFixtureDeclarations: terminalAppFixtureDeclarations,
  codeInputs: ['components/terminal/browser/fixtures/terminal/*.ts'],
});

if (import.meta.main) await suite.main(Bun.argv.slice(2));
