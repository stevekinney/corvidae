/**
 * Refuses to write visual baselines unless this process runs inside the
 * authoritative renderer image. Ported from cinder's `docker-authenticity.ts`
 * and adapted for corvidae (COR-1512): the renderer is native linux/arm64, the
 * pinned Playwright version comes from `bun.lock`, and the image bakes
 * `BASELINE_DOCKER=1` and `BASELINE_PLAYWRIGHT_VERSION`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { environmentConfiguration } from '../environment-configuration.ts';
import {
  REPOSITORY_ROOT,
  REQUIRED_BASELINE_ARCHITECTURE,
  REQUIRED_OS_CODENAME,
  readOsCodename,
  readRepositoryPins,
} from './baseline-provenance.ts';

export type AuthenticityFailure = { check: string; expected: string; actual: string };

export type AuthenticityResult =
  { ok: true; playwrightVersion: string } | { ok: false; failures: AuthenticityFailure[] };

/** Everything the guard inspects, gathered once so tests can supply each value. */
export type AuthenticityEvidence = {
  lockedPlaywrightVersion: string;
  installedPlaywrightVersion: string | undefined;
  bakedPlaywrightVersion: string | undefined;
  bakedDockerFlag: string | undefined;
  osCodename: string | undefined;
  architecture: string;
};

/** The installed `@playwright/test` version, read from its own package manifest. */
export function readInstalledPlaywrightVersion(root: string = REPOSITORY_ROOT): string | undefined {
  try {
    const manifestPath = Bun.resolveSync('@playwright/test/package.json', root);
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && 'version' in parsed
      ? String(parsed.version)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Gather the evidence from this process, its environment, and the repository. */
export function collectAuthenticityEvidence(root: string = REPOSITORY_ROOT): AuthenticityEvidence {
  const configuration = environmentConfiguration();
  return {
    lockedPlaywrightVersion: readRepositoryPins(resolve(root)).playwrightVersion,
    installedPlaywrightVersion: readInstalledPlaywrightVersion(root),
    bakedPlaywrightVersion: configuration.baselinePlaywrightVersion,
    bakedDockerFlag: configuration.baselineDocker,
    osCodename: readOsCodename(),
    architecture: process.arch,
  };
}

/**
 * Four checks, each necessary:
 * - the OS codename is jammy, the base of every committed baseline;
 * - the installed Playwright matches the lockfile;
 * - the image baked the same Playwright version and `BASELINE_DOCKER=1`, proving
 *   the container was built from this repository's Dockerfile rather than being
 *   any container with a flag set;
 * - the process architecture is arm64. The Playwright base image is multi-arch,
 *   so an amd64 build passes the first three checks with a different rasterizer.
 */
export function checkDockerAuthenticity(evidence: AuthenticityEvidence): AuthenticityResult {
  const pinned = evidence.lockedPlaywrightVersion;
  const failures: AuthenticityFailure[] = [];
  if (evidence.osCodename !== REQUIRED_OS_CODENAME) {
    failures.push({
      check: 'os-release VERSION_CODENAME',
      expected: REQUIRED_OS_CODENAME,
      actual: evidence.osCodename ?? '<missing /etc/os-release>',
    });
  }
  if (evidence.installedPlaywrightVersion !== pinned) {
    failures.push({
      check: 'installed @playwright/test vs bun.lock',
      expected: pinned,
      actual: evidence.installedPlaywrightVersion ?? '<@playwright/test not installed>',
    });
  }
  if (evidence.bakedPlaywrightVersion !== pinned) {
    failures.push({
      check: 'BASELINE_PLAYWRIGHT_VERSION baked at image build',
      expected: pinned,
      actual: evidence.bakedPlaywrightVersion ?? '<unset: not inside the renderer image>',
    });
  }
  if (evidence.bakedDockerFlag !== '1') {
    failures.push({
      check: 'BASELINE_DOCKER baked at image build',
      expected: '1',
      actual: evidence.bakedDockerFlag ?? '<unset: not inside the renderer image>',
    });
  }
  if (evidence.architecture !== REQUIRED_BASELINE_ARCHITECTURE) {
    failures.push({
      check: 'process architecture',
      expected: REQUIRED_BASELINE_ARCHITECTURE,
      actual: evidence.architecture,
    });
  }
  return failures.length > 0 ? { ok: false, failures } : { ok: true, playwrightVersion: pinned };
}

export function formatFailures(failures: readonly AuthenticityFailure[]): string {
  const lines = [
    'Refusing to update visual baselines: this process is not running inside the',
    'authoritative renderer image (native linux/arm64, Playwright jammy; COR-1512).',
    '',
    'Failed checks:',
  ];
  for (const failure of failures) {
    lines.push(
      `  - ${failure.check}`,
      `      expected: ${failure.expected}`,
      `      actual:   ${failure.actual}`,
    );
  }
  lines.push(
    '',
    'A development host renders different pixels, so it cannot author baselines.',
    'Run "bun run test:browser:update:docker" instead; see',
    'scripts/browser-fixtures/visual-baselines.md.',
  );
  return lines.join('\n');
}
