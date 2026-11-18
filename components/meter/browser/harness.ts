/**
 * This package's browser suite (COR-2080, COR-2092): `bun browser/harness.ts prepare` writes the
 * fixture manifest and the slugs the package owns, `build` bundles the fixture page every package
 * serves, and `serve --port <port>`, which `playwright.config.ts` starts, builds and serves it.
 */
import { repositoryPackageSuite } from '@lostgradient/testing/browser/package-suite';

export const suite = await repositoryPackageSuite(import.meta.dirname);

if (import.meta.main) await suite.main(Bun.argv.slice(2));
