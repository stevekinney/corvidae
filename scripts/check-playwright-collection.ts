/**
 * Guard that every Playwright spec the browser-fixture configurations collect loads.
 *
 * A spec that imports a module which has moved or gone stops the whole suite before a test runs:
 * Playwright cannot load the file, reports "No tests found" and exits non-zero. Nothing else
 * catches it locally, because no type-check or test lane imports the specs; the first sign was a
 * Chromium shard on CI (six specs merged from `main` still imported `./overlay-fixture.ts` after
 * it moved to `@lostgradient/testing/playwright/overlay-fixture`).
 *
 * `playwright test --list` loads every spec a configuration collects and lists its tests without
 * starting a browser or the configuration's web server, so it runs in seconds. The guard lists
 * the root fixture configuration and each component package's `browser/playwright.config.ts`, and
 * fails on a non-zero exit or a load error in the output.
 */

import { Glob } from 'bun';
import { join } from 'node:path';

const repositoryRoot = join(import.meta.dir, '..');

/** The configurations whose specs the guard lists, relative to the repository root. */
export function playwrightConfigurations(root: string = repositoryRoot): string[] {
  const packageConfigurations = [
    ...new Glob('components/*/browser/playwright.config.ts').scanSync({ cwd: root }),
  ].toSorted();
  return ['scripts/browser-fixtures/playwright.config.ts', ...packageConfigurations];
}

/** A load failure in `--list` output: a resolve error, a thrown error, or nothing collected. */
const loadFailure = /^(?:ResolveMessage:|Error:|SyntaxError:|TypeError:)|No tests found/m;

/** The `Total: N tests in M files` line, or why the listing failed. */
export function collectionResult(
  exitCode: number,
  output: string,
): { ok: true; summary: string } | { ok: false; reason: string } {
  const failure = loadFailure.exec(output);
  if (exitCode !== 0 || failure !== null) {
    const lines = output.split('\n');
    const at = failure === null ? lines.length : output.slice(0, failure.index).split('\n').length;
    const context = lines.slice(Math.max(0, at - 6), at + 4).join('\n');
    return { ok: false, reason: `exit ${exitCode}\n${context}` };
  }
  const summary = /^Total: .*$/m.exec(output)?.[0];
  return summary === undefined
    ? { ok: false, reason: 'no "Total:" line in the listing' }
    : { ok: true, summary };
}

if (import.meta.main) {
  let failed = false;
  for (const configuration of playwrightConfigurations()) {
    const listing = Bun.spawnSync(
      ['bun', '--bun', 'playwright', 'test', '--config', configuration, '--list'],
      { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    const output = `${listing.stdout.toString()}\n${listing.stderr.toString()}`;
    const result = collectionResult(listing.exitCode ?? 1, output);
    if (result.ok) {
      console.log(`check-playwright-collection — ${configuration}: ${result.summary}`);
    } else {
      failed = true;
      console.error(
        `check-playwright-collection — ${configuration} does not load every spec:\n${result.reason}`,
      );
    }
  }
  if (failed) process.exit(1);
}
