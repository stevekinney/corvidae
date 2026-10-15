import { describe, expect, it } from 'bun:test';

import {
  checkDockerAuthenticity,
  formatFailures,
  readInstalledPlaywrightVersion,
  type AuthenticityEvidence,
} from './docker-authenticity.ts';

const AUTHENTIC: AuthenticityEvidence = {
  lockedPlaywrightVersion: '1.63.0',
  installedPlaywrightVersion: '1.63.0',
  bakedPlaywrightVersion: '1.63.0',
  bakedDockerFlag: '1',
  osCodename: 'jammy',
  architecture: 'arm64',
};

function failedChecks(evidence: AuthenticityEvidence): string[] {
  const result = checkDockerAuthenticity(evidence);
  return result.ok ? [] : result.failures.map((failure) => failure.check);
}

describe('docker authenticity', () => {
  it('accepts the authoritative renderer and reports the pinned version', () => {
    expect(checkDockerAuthenticity(AUTHENTIC)).toEqual({ ok: true, playwrightVersion: '1.63.0' });
  });

  it('rejects an amd64 container even when every other check passes', () => {
    expect(failedChecks({ ...AUTHENTIC, architecture: 'x64' })).toEqual(['process architecture']);
  });

  it('rejects another Ubuntu release', () => {
    expect(failedChecks({ ...AUTHENTIC, osCodename: 'noble' })).toEqual([
      'os-release VERSION_CODENAME',
    ]);
  });

  it('rejects an installed Playwright that differs from bun.lock', () => {
    expect(failedChecks({ ...AUTHENTIC, installedPlaywrightVersion: '1.60.0' })).toEqual([
      'installed @playwright/test vs bun.lock',
    ]);
  });

  it('rejects an image that baked another Playwright version', () => {
    expect(failedChecks({ ...AUTHENTIC, bakedPlaywrightVersion: '1.60.0' })).toEqual([
      'BASELINE_PLAYWRIGHT_VERSION baked at image build',
    ]);
  });

  it('rejects a process outside the renderer image', () => {
    expect(
      failedChecks({
        ...AUTHENTIC,
        bakedPlaywrightVersion: undefined,
        bakedDockerFlag: undefined,
        osCodename: undefined,
        architecture: 'arm64',
      }),
    ).toEqual([
      'os-release VERSION_CODENAME',
      'BASELINE_PLAYWRIGHT_VERSION baked at image build',
      'BASELINE_DOCKER baked at image build',
    ]);
  });

  it('formats failures with the Docker instruction', () => {
    const result = checkDockerAuthenticity({ ...AUTHENTIC, architecture: 'x64' });
    if (result.ok) throw new Error('expected a failure');
    const message = formatFailures(result.failures);
    expect(message).toContain('process architecture');
    expect(message).toContain('expected: arm64');
    expect(message).toContain('bun run test:browser:update:docker');
  });

  it('reads the installed @playwright/test version from the workspace', () => {
    expect(readInstalledPlaywrightVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
