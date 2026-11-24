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
const pullRequestWorkflow = readFileSync(
  resolve(REPOSITORY_ROOT, '.github/workflows/pull-request.yml'),
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

  test('records the image that actually runs each browser replay', () => {
    const { playwrightVersion } = readRepositoryPins();
    const targeted = readFileSync(
      resolve(REPOSITORY_ROOT, '.github/workflows/targeted-checks.yml'),
      'utf8',
    );
    for (const source of [workflow, targeted]) {
      const images = [...source.matchAll(/^\s*CI_REPLAY_IMAGE: (.+)$/gm)].map((match) => match[1]);
      expect(images.length).toBeGreaterThan(0);
      expect(images.every((image) => image === playwrightBaseImage(playwrightVersion))).toBe(true);
    }
  });

  test('queues every still-valid trusted consumer of the bound Interborough shard-one candidate', () => {
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
    // The caller intentionally cancels a superseded pull-request parent. Its canceled child cannot
    // produce a result; `queue: max` preserves every consumer whose parent remains valid.
    expect(pullRequestWorkflow).toContain('cancel-in-progress: true');
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
    expect(packages).toContain(
      '- run: bun scripts/chef/ci-replay.ts run -- bun run validate:batch\n',
    );
    expect(packages).toContain('CI_REPLAY_CREDENTIAL_BOUNDARY: producer-scrubbed\n');
    expect(packages).toContain('TURBO_ENV_MODE: strict\n');
    expect(packages).toContain('path: components/*/browser/test-results/**/*-actual.png\n');
  });

  test('runs each browser producer through credential isolation and hashes the wrapper', () => {
    const configuration = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'turbo.json'), 'utf8'));
    const prohibited = [
      'TURBO_TOKEN',
      'TURBO_TEAM',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'CI_REPLAY_TOKEN',
      'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    ];
    const names = [
      '//#ci:browser-fixtures',
      '@lostgradient/chat#test:browser',
      '@lostgradient/editor#test:browser',
      '@lostgradient/terminal#test:browser',
    ];
    for (const name of names) {
      const task = configuration.tasks[name];
      expect(task.inputs).toContain('$TURBO_ROOT$/scripts/chef/ci-replay.ts');
      const declared = [
        ...(configuration.globalEnv ?? []),
        ...(configuration.globalPassThroughEnv ?? []),
        ...(task.env ?? []),
        ...(task.passThroughEnv ?? []),
      ];
      for (const key of prohibited) expect(declared).not.toContain(key);
      expect(declared.every((entry: string) => !entry.includes('*'))).toBe(true);
    }
    for (const job of ['fixtures', 'packages']) {
      expect(jobText(job)).toContain('CI_REPLAY_CREDENTIAL_BOUNDARY: producer-scrubbed\n');
      expect(jobText(job)).toContain('TURBO_ENV_MODE: strict\n');
      expect(jobText(job)).not.toContain("CI_REPLAY_NO_CREDENTIALS: 'true'\n");
    }
    for (const path of [
      'package.json',
      'components/chat/package.json',
      'components/editor/package.json',
      'components/terminal/package.json',
    ]) {
      const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8'));
      const command =
        manifest.scripts[path === 'package.json' ? 'ci:browser-fixtures' : 'test:browser'];
      expect(command).toContain('scripts/chef/ci-replay.ts isolated -- bun');
    }
  });

  // Both suites gate (COR-2412). Job level only: a report upload step may fail without failing the job.
  test.each(['fixtures', 'packages', 'interborough'])('gates on the %s job', (job) => {
    expect(jobText(job)).not.toMatch(/\n {4}continue-on-error:/u);
  });

  test('keeps a real Interborough Turborepo invocation and failed-run artifact for every consumer', () => {
    const interborough = jobText('interborough');
    expect(interborough).toContain(
      '- run: bun scripts/chef/ci-replay.ts run -- bunx turbo run //#ci:browser-interborough --log-order=stream\n',
    );
    expect(interborough).toContain('name: playwright-interborough-${{ matrix.shard }}\n');
    expect(interborough).toContain('if: ${{ failure() }}\n');
    expect(interborough).toContain('path: ${{ runner.temp }}/ci-replay-record.json\n');
    expect(interborough).not.toContain('applications/interborough/test-results/\n');
  });
});
