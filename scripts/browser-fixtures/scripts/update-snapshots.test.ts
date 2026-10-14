import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

import { REPOSITORY_ROOT } from './baseline-provenance.ts';
import {
  completedSuite,
  playwrightUpdateArguments,
  provenanceComponentScope,
  snapshotUpdateEnvironment,
} from './update-snapshots.ts';

describe('update-snapshots helpers', () => {
  it('runs Playwright with the update flags before forwarded arguments', () => {
    expect(playwrightUpdateArguments(['--grep', 'Button'])).toEqual([
      'bun',
      '--bun',
      'playwright',
      'test',
      '--config',
      'scripts/browser-fixtures/playwright.config.ts',
      '--update-snapshots=all',
      '--retries=0',
      '--grep',
      'Button',
    ]);
  });

  it('forces block mode with the update flag and keeps other variables', () => {
    const environment = snapshotUpdateEnvironment({
      CINDER_TEST_COMPONENTS: 'button',
      CINDER_VISUAL_DIFF: 'off',
    });
    expect(environment['CINDER_TEST_COMPONENTS']).toBe('button');
    expect(environment['CINDER_VISUAL_DIFF']).toBe('block');
    expect(environment['CINDER_UPDATE_SNAPSHOTS']).toBe('1');
  });

  it('records a full-matrix scope unless a component scope is set', () => {
    expect(provenanceComponentScope(undefined)).toBe('all');
    expect(provenanceComponentScope('  ')).toBe('all');
    expect(provenanceComponentScope('button')).toBe('button');
  });
});

describe('completedSuite', () => {
  it('treats a passing suite and one that completed with failures as complete', () => {
    expect(completedSuite(0)).toBe(true);
    expect(completedSuite(1)).toBe(true);
    expect(completedSuite(130)).toBe(false);
    expect(completedSuite(2)).toBe(false);
  });
});

describe('bun run test:browser:update outside the renderer image', () => {
  it('exits non-zero with instructions to use the Docker path', async () => {
    // Without the variables only the renderer image bakes in, the guard refuses on any
    // host, including inside a plain jammy arm64 container.
    const childEnvironment: Record<string, string | undefined> = { ...process.env };
    delete childEnvironment['BASELINE_DOCKER'];
    delete childEnvironment['BASELINE_PLAYWRIGHT_VERSION'];
    const child = Bun.spawn(
      ['bun', resolve(REPOSITORY_ROOT, 'scripts/browser-fixtures/scripts/update-snapshots.ts')],
      { cwd: REPOSITORY_ROOT, env: childEnvironment, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Refusing to update visual baselines');
    expect(stderr).toContain('bun run test:browser:update:docker');
  });
});
