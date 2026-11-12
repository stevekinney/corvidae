import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  playwrightBaseImage,
  readRepositoryPins,
  REPOSITORY_ROOT,
  REQUIRED_BASELINE_ARCHITECTURE,
} from './baseline-provenance.ts';

const workflow = readFileSync(
  resolve(REPOSITORY_ROOT, '.github/workflows/browser-suites.yml'),
  'utf8',
);

/** The text of one top-level job of the workflow, from its key to the next job's. */
function jobText(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

// COR-2411: the committed Linux baselines reproduce only on the renderer that wrote them, so the
// CI job that compares against them must run that renderer, at the Playwright the lockfile resolves.
describe('the browser suites workflow', () => {
  test("runs the fixture suite in the baseline renderer's image", () => {
    const { playwrightVersion } = readRepositoryPins();
    expect(jobText('fixtures')).toContain(`image: ${playwrightBaseImage(playwrightVersion)}\n`);
  });

  test("runs the fixture suite on the baseline renderer's architecture", () => {
    expect(REQUIRED_BASELINE_ARCHITECTURE).toBe('arm64');
    expect(jobText('fixtures')).toContain('runs-on: ubuntu-24.04-arm\n');
  });

  test('compares screenshots in block mode', () => {
    expect(jobText('fixtures')).toContain('CINDER_VISUAL_DIFF: block\n');
  });

  // The fixture suite gates; only Interborough's end-to-end suite is advisory (COR-2412).
  test('gates on the fixture suite', () => {
    // Job level only: the report upload step is allowed to fail without failing the job.
    expect(jobText('fixtures')).not.toMatch(/\n {4}continue-on-error:/u);
  });

  test("keeps Interborough's end-to-end job advisory until COR-2412", () => {
    expect(jobText('interborough')).toMatch(/\n {4}continue-on-error: true\n/u);
  });
});
