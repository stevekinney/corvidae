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
 *
 * Specs read their suite's fixture manifest at module scope, and the manifest is an ignored file
 * the suite's prepare step writes (the web server writes it too, but `--list` starts none). So the
 * guard runs each configuration's prepare step first: `prepare-manifest.ts` for the root suite and
 * `bun browser/harness.ts prepare` for a package suite. Without it a fresh checkout fails.
 *
 * `--root <directory>` runs the guard over another repository layout (its test does).
 */

import { Glob } from 'bun';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const repositoryRoot = join(import.meta.dir, '..');
const ROOT_CONFIGURATION = 'scripts/browser-fixtures/playwright.config.ts';

/** One configuration to list, and the command that writes the manifest its specs read. */
export type CollectionStep = { configuration: string; prepare: string[] };

/** The configurations whose specs the guard lists, relative to `root`, each with its prepare step. */
export function collectionSteps(root: string = repositoryRoot): CollectionStep[] {
  const steps: CollectionStep[] = [];
  if (existsSync(join(root, ROOT_CONFIGURATION))) {
    steps.push({
      configuration: ROOT_CONFIGURATION,
      prepare: ['bun', 'scripts/browser-fixtures/scripts/prepare-manifest.ts'],
    });
  }
  const packageConfigurations = [
    ...new Glob('components/*/browser/playwright.config.ts').scanSync({ cwd: root }),
  ].toSorted();
  for (const configuration of packageConfigurations) {
    steps.push({
      configuration,
      prepare: ['bun', join(dirname(configuration), 'harness.ts'), 'prepare'],
    });
  }
  return steps;
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

function run(command: string[], cwd: string): { exitCode: number; output: string } {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode ?? 1,
    output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
  };
}

/** Prepare and list every configuration under `root`; true when every one loads all its specs. */
export function checkPlaywrightCollection(root: string = repositoryRoot): boolean {
  let ok = true;
  for (const { configuration, prepare } of collectionSteps(root)) {
    const prepared = run(prepare, root);
    if (prepared.exitCode !== 0) {
      ok = false;
      console.error(
        `check-playwright-collection — ${configuration}: \`${prepare.join(' ')}\` failed (exit ${prepared.exitCode})\n${prepared.output.trim()}`,
      );
      continue;
    }
    const listing = run(
      ['bun', '--bun', 'playwright', 'test', '--config', configuration, '--list'],
      root,
    );
    const result = collectionResult(listing.exitCode, listing.output);
    if (result.ok) {
      console.log(`check-playwright-collection — ${configuration}: ${result.summary}`);
    } else {
      ok = false;
      console.error(
        `check-playwright-collection — ${configuration} does not load every spec:\n${result.reason}`,
      );
    }
  }
  return ok;
}

if (import.meta.main) {
  const rootFlag = Bun.argv.indexOf('--root');
  const root = rootFlag === -1 ? repositoryRoot : Bun.argv[rootFlag + 1];
  if (root === undefined) {
    console.error('check-playwright-collection: --root needs a directory');
    process.exit(2);
  }
  if (!checkPlaywrightCollection(root)) process.exit(1);
}
