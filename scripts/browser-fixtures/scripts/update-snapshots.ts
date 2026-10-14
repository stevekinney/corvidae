/**
 * `bun run test:browser:update`: rewrite the committed Linux visual baselines.
 *
 * Ported from cinder's `update-snapshots.ts` (COR-1512). It runs only inside
 * the authoritative renderer image, which `bun run test:browser:update:docker`
 * builds and starts. Anywhere else the authenticity guard refuses with
 * instructions, because a development host renders different pixels.
 *
 * Inside the image it runs the suite with `--update-snapshots=all --retries=0`
 * (a retry-passing run is never authoritative), then records provenance,
 * including the suite's exit code. Provenance is written when Playwright
 * completed, whether every case passed (0) or some failed (1); a crash or an
 * interrupt writes none. The host wrapper decides whether a run with failures
 * may be applied (`--accept-behavioural-failures`; never for a screenshot
 * failure). The
 * source has no `.git` (it arrives as a `git archive`), so the rendered commit
 * comes from `BASELINE_SOURCE_SHA`.
 */
import { resolve } from 'node:path';

import { environmentConfiguration } from '../environment-configuration.ts';
import {
  LINUX_BASELINE_DIRECTORY,
  PROVENANCE_FILE_NAME,
  REPOSITORY_ROOT,
  REQUIRED_OS_CODENAME,
  createBaselineProvenance,
  dockerImageTagForPlaywrightVersion,
  readOsCodename,
  writeBaselineProvenance,
} from './baseline-provenance.ts';
import {
  checkDockerAuthenticity,
  collectAuthenticityEvidence,
  formatFailures,
} from './docker-authenticity.ts';

export const PLAYWRIGHT_CONFIG = 'scripts/browser-fixtures/playwright.config.ts';

export function playwrightUpdateArguments(extraArguments: readonly string[]): string[] {
  return [
    'bun',
    '--bun',
    'playwright',
    'test',
    '--config',
    PLAYWRIGHT_CONFIG,
    '--update-snapshots=all',
    '--retries=0',
    ...extraArguments,
  ];
}

/** Block mode keeps `toHaveScreenshot` active; the update flag authorizes writing baselines. */
export function snapshotUpdateEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...environment, CINDER_VISUAL_DIFF: 'block', CINDER_UPDATE_SNAPSHOTS: '1' };
}

/** Playwright exits 0 when every case passed and 1 when the run completed with failures. */
export function completedSuite(exitCode: number): boolean {
  return exitCode === 0 || exitCode === 1;
}

export function provenanceComponentScope(rawScope: string | undefined): string {
  return rawScope !== undefined && rawScope.trim().length > 0 ? rawScope : 'all';
}

async function main(): Promise<number> {
  const result = checkDockerAuthenticity(collectAuthenticityEvidence());
  if (!result.ok) {
    process.stderr.write(`${formatFailures(result.failures)}\n`);
    return 1;
  }
  const configuration = environmentConfiguration();
  const renderedSourceSha = configuration.baselineSourceSha?.trim();
  if (!renderedSourceSha) {
    process.stderr.write(
      'BASELINE_SOURCE_SHA is required: the archived source has no .git to name the rendered commit.\n',
    );
    return 1;
  }
  process.stdout.write(
    `Renderer verified (Playwright ${result.playwrightVersion}, ${REQUIRED_OS_CODENAME}, ${process.arch}). Writing baselines for ${renderedSourceSha}.\n`,
  );
  const child = Bun.spawn(playwrightUpdateArguments(process.argv.slice(2)), {
    cwd: REPOSITORY_ROOT,
    env: snapshotUpdateEnvironment({ ...process.env }),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (!completedSuite(exitCode)) return exitCode;
  await writeBaselineProvenance(
    resolve(REPOSITORY_ROOT, LINUX_BASELINE_DIRECTORY, PROVENANCE_FILE_NAME),
    createBaselineProvenance({
      componentScope: provenanceComponentScope(configuration.cinderTestComponents),
      renderedSourceSha,
      playwrightVersion: result.playwrightVersion,
      osCodename: readOsCodename() ?? '<missing /etc/os-release>',
      architecture: process.arch,
      dockerImageTag: dockerImageTagForPlaywrightVersion(result.playwrightVersion),
      suiteExitCode: exitCode,
    }),
  );
  return exitCode;
}

if (import.meta.main) {
  process.exitCode = await main();
}
