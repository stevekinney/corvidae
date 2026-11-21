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

  // COR-2412: Interborough's layout checks measure text in the system font, which only the image
  // holds still; a bare runner's wider default sans cuts off text that fits elsewhere.
  test("runs Interborough's end-to-end suite in the same image", () => {
    const { playwrightVersion } = readRepositoryPins();
    expect(jobText('interborough')).toContain(`image: ${playwrightBaseImage(playwrightVersion)}\n`);
  });

  test('shares only the trusted, bound Interborough shard-one candidate and queues every consumer', () => {
    const interborough = jobText('interborough');
    expect(interborough).toContain('concurrency:\n');
    expect(interborough).toContain('matrix.shard == 1');
    expect(interborough).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(interborough).toContain('github.event.pull_request.head.sha');
    expect(interborough).toContain('github.event.pull_request.base.sha');
    expect(interborough).toContain("github.event_name == 'workflow_dispatch'");
    expect(interborough).toContain('github.event.inputs.verification_request');
    expect(interborough).toContain('github.event.inputs.verification_plan');
    expect(interborough).toContain('github.event.inputs.verification_base');
    expect(interborough).toContain('github.sha');
    expect(interborough).toContain('github.run_id');
    expect(interborough).toContain('queue: max');
    expect(interborough).toContain('cancel-in-progress: false');
  });

  // COR-2461: the design-review capture runs where the end-to-end layout checks run, so its fonts match.
  test('runs the design-review capture in the same image, and uploads whatever it captured', () => {
    const { playwrightVersion } = readRepositoryPins();
    const capture = readFileSync(
      resolve(REPOSITORY_ROOT, '.github/workflows/design-review-capture.yml'),
      'utf8',
    );
    expect(capture).toContain(`image: ${playwrightBaseImage(playwrightVersion)}\n`);
    expect(capture).toMatch(/if: \$\{\{ always\(\) \}\}\n/u);
    expect(capture).not.toMatch(/run:[^\n]*\$\{\{ *inputs\./u);
  });

  test.each(['fixtures', 'packages'])('compares screenshots in block mode in the %s job', (job) => {
    expect(jobText(job)).toContain('CINDER_VISUAL_DIFF: block\n');
  });

  // COR-2080: the specs moved into the chat, editor and terminal packages run only through their
  // own `test:browser` tasks, so a workflow that stopped running `validate:batch` would drop them
  // silently. The terminal's moved baselines need the baseline renderer too.
  test('runs the package browser suites through validate:batch on the baseline renderer', () => {
    const { playwrightVersion } = readRepositoryPins();
    const packages = jobText('packages');
    expect(packages).toContain(`image: ${playwrightBaseImage(playwrightVersion)}\n`);
    expect(packages).toContain('runs-on: ubuntu-24.04-arm\n');
    expect(packages).toContain('if: ${{ inputs.fixtures }}\n');
    expect(packages).toContain('- run: bun run validate:batch\n');
  });

  // Both suites gate (COR-2412). Job level only: a report upload step may fail without failing the job.
  test.each(['fixtures', 'packages', 'interborough'])('gates on the %s job', (job) => {
    expect(jobText(job)).not.toMatch(/\n {4}continue-on-error:/u);
  });

  test('keeps the Interborough Turborepo invocation and failed-run artifact for every consumer', () => {
    const interborough = jobText('interborough');
    expect(interborough).toContain('- run: bunx turbo run //#ci:browser-interborough\n');
    expect(interborough).toContain('name: playwright-interborough-${{ matrix.shard }}\n');
    expect(interborough).toContain('if: ${{ failure() }}\n');
  });
});
