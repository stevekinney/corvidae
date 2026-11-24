import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';

import {
  findRunningJob,
  firstAssertion,
  replayEnvironment,
  replayParameters,
  replayRecord,
  resolveSelectionBase,
  sanitizeJUnit,
} from './ci-replay.ts';

describe('failure replay evidence', () => {
  test('records the resolved selection base independently of the pull request event base', () => {
    const eventBase = 'a'.repeat(40);
    const selectedBase = 'b'.repeat(40);
    const resolved = resolveSelectionBase({ TURBO_SCM_BASE: 'origin/main' }, (ref) => {
      expect(ref).toBe('origin/main');
      return selectedBase;
    });
    expect(resolved).toEqual({ selectionBase: selectedBase, selectionBaseUnavailable: null });
    expect(resolved.selectionBase).not.toBe(eventBase);
    expect(resolveSelectionBase({}, () => eventBase).selectionBase).toBeNull();
    expect(
      resolveSelectionBase({ TURBO_SCM_BASE: 'origin/main' }, () => '').selectionBaseUnavailable,
    ).toBe('selection base ref could not be resolved to a commit');
  });
  test('retains the first matcher and source location without test output or values', () => {
    const marker = 'harmless-seeded-marker-12345';
    const output = `error: expect(received).toEqual(expected)\nExpected: ${marker}\n    at /workspace/scripts/example.test.ts:12:4\nerror: expect(received).toBe(2)\n    at /workspace/scripts/other.test.ts:20:2\n`;
    const result = firstAssertion(output, '/workspace');
    expect(result).toEqual({
      matcher: 'toEqual',
      negated: false,
      modifier: null,
      file: 'scripts/example.test.ts',
      line: 12,
      column: 4,
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  test('reports an unavailable location instead of copying an untrusted path', () => {
    expect(
      firstAssertion('error: expect(x).toBe(y)\n    at /private/secret.test.ts:4:2', '/workspace'),
    ).toEqual({
      matcher: 'toBe',
      negated: false,
      modifier: null,
      file: null,
      line: null,
      column: null,
    });
    expect(firstAssertion('command failed with marker', '/workspace')).toBeNull();
  });

  test('retains identity and first failure with explicit missing-artifact reasons', () => {
    const marker = 'harmless-seeded-marker-12345';
    const record = replayRecord({
      runId: 10,
      attempt: 2,
      job: 'unit',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      lock: 'd'.repeat(40),
      bun: '1.4.4',
      command: 'bun test src/example.test.ts',
      selection: ['src/example.test.ts'],
      output: `error: expect(x).toEqual(y)\nExpected: ${marker}\n at /workspace/src/example.test.ts:10:2`,
      workspace: '/workspace',
    });
    expect(record.assertion).toEqual({
      matcher: 'toEqual',
      negated: false,
      modifier: null,
      file: 'src/example.test.ts',
      line: 10,
      column: 2,
    });
    expect(record.artifacts.trace.reason).toBe('raw browser traces are not retained');
    expect(record.artifacts.junit.reason).toBe('no sanitized JUnit was emitted');
    expect(JSON.stringify(record)).not.toContain(marker);
  });

  test('keeps the assertion when unrelated metadata is unavailable', () => {
    const record = replayRecord({
      runId: 10,
      attempt: 1,
      job: 'unit',
      head: 'a'.repeat(40),
      base: '',
      tree: '',
      lock: '',
      bun: '1.4.4',
      command: 'bun test src/example.test.ts',
      selection: [],
      output: 'error: expect(x).toBe(y)\n at /workspace/src/example.test.ts:2:1',
      workspace: '/workspace',
    });
    expect(record.assertion?.matcher).toBe('toBe');
    expect(record.base).toBeNull();
    expect(record.identityUnavailable).toEqual(['base', 'tree', 'lock']);
  });

  test('does not retain absolute home paths from command or selection', () => {
    const record = replayRecord({
      runId: 10,
      attempt: 1,
      job: 'unit',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      lock: 'd'.repeat(40),
      bun: '1.4.4',
      command: 'bun test /Users/private/sentinel.test.ts',
      selection: ['/Users/private/sentinel.test.ts'],
      output: 'error: expect(x).toBe(y)',
      workspace: '/workspace',
    });
    expect(JSON.stringify(record)).not.toContain('/Users/private');
    expect(record.assertion?.matcher).toBe('toBe');
    expect(record.command).toBeNull();
  });

  test('does not retain traversal paths that can refer outside the checkout', () => {
    const record = replayRecord({
      runId: 10,
      attempt: 1,
      job: 'unit',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      lock: 'd'.repeat(40),
      bun: '1.4.4',
      command: 'bun test ../../private/sentinel.test.ts',
      selection: ['../../private/sentinel.test.ts'],
      output: 'error: expect(x).toBe(y)',
      workspace: '/workspace',
    });
    expect(JSON.stringify(record)).not.toContain('../../private');
    expect(record.assertion?.matcher).toBe('toBe');
  });

  test('describes portable scratch and browser JUnit setup without runner paths', () => {
    const input = {
      runId: 10,
      attempt: 1,
      job: 'unit',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      lock: 'd'.repeat(40),
      bun: '1.4.4',
      command: 'bash scripts/chef/targeted-unit.sh',
      selection: [],
      output: '',
      workspace: '/workspace',
    };
    const unit = replayRecord(input);
    expect(unit.replaySetup.RUNNER_TEMP).toBe('fresh writable scratch directory');
    expect(unit.replaySetup.GITHUB_WORKSPACE).toBe('checkout root');
    expect(unit.replaySetup.rawJUnit).toBe('$RUNNER_TEMP/ci-replay-junit-raw.xml');
    expect(unit.replaySetup.PLAYWRIGHT_JUNIT_OUTPUT_FILE).toBeNull();
    expect(replayRecord({ ...input, command: '' }).commandUnavailable).toBe(
      'failure occurred outside the replay producer; command was not captured',
    );
    const browser = replayRecord({
      ...input,
      command: 'bun playwright test --reporter=line,junit',
    });
    expect(browser.replaySetup.PLAYWRIGHT_JUNIT_OUTPUT_FILE).toBe(
      '$RUNNER_TEMP/ci-replay-junit-raw.xml',
    );
    expect(browser.replaySetup.PLAYWRIGHT_HTML_OUTPUT_DIR).toBe(
      '$GITHUB_WORKSPACE/playwright-output/report',
    );
    expect(browser.replaySetup.PLAYWRIGHT_JSON_OUTPUT_FILE).toBe(
      '$GITHUB_WORKSPACE/playwright-output/results.json',
    );
    const selector = replayRecord({
      ...input,
      command: 'bash scripts/chef/select-browser-suites.sh',
    });
    expect(selector.replaySetup.GITHUB_OUTPUT).toBe('$RUNNER_TEMP/github-output');
    expect(selector.replaySetup.TURBO_SCM_BASE).toContain('unavailable if either is missing');
    const postgres = replayRecord({
      ...input,
      command: 'bash scripts/chef/prepare-postgres-path.sh',
    });
    expect(postgres.replaySetup.GITHUB_PATH).toBe('$RUNNER_TEMP/github-path');
  });

  test('wraps replayable setup and browser-selection commands after Bun is installed', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/pull-request.yml', import.meta.url),
      'utf8',
    );
    for (const command of [
      'bunx playwright install --with-deps chromium',
      'bash scripts/chef/prepare-postgres-path.sh',
      'bash scripts/chef/select-browser-suites.sh',
    ])
      expect(workflow).toContain(`bun scripts/chef/ci-replay.ts run -- ${command}`);
    const browser = readFileSync(
      new URL('../../.github/workflows/browser-suites.yml', import.meta.url),
      'utf8',
    );
    for (const command of [
      'bash scripts/chef/check-terminal-browser-cache.sh',
      'bunx turbo run test:browser --filter=@lostgradient/terminal',
    ])
      expect(browser).toContain(`bun scripts/chef/ci-replay.ts run -- ${command}`);
  });

  test('records the named unit parameters needed to replay without copying other environment', () => {
    const parameters = replayParameters({
      UNIT_WORKSPACE: 'applications/interborough',
      UNIT_PATHS: 'src/example.test.ts',
      UNIT_CONFIG: './bunfig.ui.toml',
      TZ: 'UTC',
      LANG: 'en_US.UTF-8',
      CI: 'true',
      CINDER_VISUAL_DIFF: 'block',
      CI_REPLAY_NO_CREDENTIALS: 'true',
      CI_REPLAY_CREDENTIAL_BOUNDARY: 'producer-scrubbed',
      TURBO_ENV_MODE: 'strict',
      SECRET_TOKEN: 'marker-secret',
      FIXTURE_SPECS: '/Users/private/secret',
    });
    expect(parameters['UNIT_WORKSPACE']).toBe('applications/interborough');
    expect(parameters['UNIT_PATHS']).toBe('src/example.test.ts');
    expect(parameters['UNIT_CONFIG']).toBe('./bunfig.ui.toml');
    expect(parameters['TZ']).toBe('UTC');
    expect(parameters['LANG']).toBe('en_US.UTF-8');
    expect(parameters['CI']).toBe('true');
    expect(parameters['CINDER_VISUAL_DIFF']).toBe('block');
    expect(parameters['CI_REPLAY_NO_CREDENTIALS']).toBe('true');
    expect(parameters['CI_REPLAY_CREDENTIAL_BOUNDARY']).toBe('producer-scrubbed');
    expect(parameters['TURBO_ENV_MODE']).toBe('strict');
    expect(parameters['FIXTURE_SPECS']).toBeNull();
    expect(JSON.stringify(parameters)).not.toContain('marker-secret');
  });

  test('preserves a bounded multi-file selection without the former 128-file cutoff', () => {
    const selection = Array.from({ length: 200 }, (_, index) => `src/case-${index}.test.ts`);
    const record = replayRecord({
      runId: 10,
      attempt: 1,
      job: 'unit',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      lock: 'd'.repeat(40),
      bun: '1.4.4',
      command: 'bash scripts/chef/targeted-unit.sh',
      selection,
      output: '',
      workspace: '/workspace',
    });
    expect(record.selection).toEqual(selection);
    expect(record.selectionUnavailable).toBeNull();
  });

  test('does not pass provider or cache credentials into a synthetic screenshot producer', () => {
    const environment = replayEnvironment(
      {
        CI_REPLAY_TOKEN: 'secret',
        TURBO_TOKEN: 'secret',
        TURBO_TEAM: 'team',
        GITHUB_TOKEN: 'secret',
        GH_TOKEN: 'secret',
        ACTIONS_RUNTIME_TOKEN: 'secret',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret',
        AWS_ACCESS_KEY_ID: 'secret',
        TYPESAFE_API_KEY: 'secret',
        CINDER_TEST_COMPONENTS: 'button',
        CORVIDAE_TEST_SLOTS_TOKEN: 'holder',
      },
      true,
    );
    expect(environment['CINDER_TEST_COMPONENTS']).toBe('button');
    expect(environment['CORVIDAE_TEST_SLOTS_TOKEN']).toBe('holder');
    expect(JSON.stringify(environment)).not.toContain('secret');
    expect(environment['TURBO_TEAM']).toBeUndefined();
  });

  test('retains cache credentials for the Turbo scheduler without forwarding the replay token', () => {
    const environment = replayEnvironment(
      { TURBO_TOKEN: 'cache-token', TURBO_TEAM: 'team', CI_REPLAY_TOKEN: 'replay-token' },
      false,
    );
    expect(environment['TURBO_TOKEN']).toBe('cache-token');
    expect(environment['TURBO_TEAM']).toBe('team');
    expect(environment['CI_REPLAY_TOKEN']).toBeUndefined();
  });

  test('accepts a provider job ID only for a unique matching runner and attempt', async () => {
    const match = {
      id: 11,
      run_id: 7,
      run_attempt: 2,
      status: 'in_progress',
      runner_name: 'runner',
    };
    expect(
      await findRunningJob(async () => ({ total_count: 1, jobs: [match] }), 'runner', 7, 2),
    ).toBe(11);
    expect(
      await findRunningJob(
        async () => ({ total_count: 2, jobs: [match, { ...match, id: 12 }] }),
        'runner',
        7,
        2,
      ),
    ).toBeNull();
    expect(
      await findRunningJob(
        async () => ({ total_count: 1, jobs: [{ ...match, run_attempt: 1 }] }),
        'runner',
        7,
        2,
      ),
    ).toBeNull();
    expect(
      await findRunningJob(async () => ({ total_count: 2, jobs: [match] }), 'runner', 7, 2),
    ).toBeNull();
  });

  test('retains JUnit outcome inventory without arbitrary source text', async () => {
    const marker = 'harmless-seeded-marker-12345';
    const xml = `<testsuites><testsuite><testcase name="${marker}"><failure message="${marker}">${marker}</failure></testcase><testcase name="passing"/></testsuite></testsuites>`;
    const sanitized = await sanitizeJUnit(xml);
    expect(sanitized).toContain('<failure message="redacted"/>');
    expect(sanitized.match(/<testcase /g)).toHaveLength(2);
    expect(sanitized).not.toContain(marker);
    expect(await throwingRejectionOf(sanitizeJUnit('<testsuite><testcase>'))).toThrow();
  });

  test('preserves negation and promise modifiers in the first assertion', () => {
    expect(
      firstAssertion('error: expect(value).rejects.not.toThrow(expected)', '/workspace'),
    ).toEqual({
      matcher: 'toThrow',
      negated: true,
      modifier: 'rejects',
      file: null,
      line: null,
      column: null,
    });
  });

  test('declares a fallback and replay artifact for each covered job', () => {
    const root = resolve(import.meta.dir, '../..');
    const expectedNames: Record<string, string> = {
      'targeted-checks.yml:checks': 'replay-checks-${{ github.run_attempt }}',
      'targeted-checks.yml:fixtures': 'replay-fixtures-${{ github.run_attempt }}',
      'targeted-checks.yml:interborough': 'playwright-interborough-targeted',
      'targeted-checks.yml:unit': 'replay-unit-${{ strategy.job-index }}-${{ github.run_attempt }}',
      'pull-request.yml:static': 'replay-static-${{ github.run_attempt }}',
      'pull-request.yml:workspaces': 'replay-workspaces-${{ github.run_attempt }}',
      'pull-request.yml:tests': 'replay-tests-${{ github.run_attempt }}',
      'browser-suites.yml:fixtures':
        'replay-browser-fixtures-${{ matrix.shard }}-${{ github.run_attempt }}',
      'browser-suites.yml:packages': 'replay-browser-packages-${{ github.run_attempt }}',
      'browser-suites.yml:interborough': 'playwright-interborough-${{ matrix.shard }}',
    };
    for (const [workflow, jobs] of [
      ['targeted-checks.yml', ['checks', 'fixtures', 'interborough', 'unit']],
      ['pull-request.yml', ['static', 'workspaces', 'tests', 'browser-selection', 'evidence']],
      ['browser-suites.yml', ['fixtures', 'packages', 'interborough']],
    ] as const) {
      const yaml = Bun.YAML.parse(
        readFileSync(resolve(root, '.github/workflows', workflow), 'utf8'),
      ) as {
        env: Record<string, unknown>;
        jobs: Record<
          string,
          {
            steps: {
              name?: string;
              uses?: string;
              run?: string;
              if?: string;
              with?: Record<string, string>;
              env?: Record<string, string>;
            }[];
          }
        >;
      };
      expect(typeof yaml.env['CI_REPLAY_FALLBACK']).toBe('string');
      expect(typeof yaml.env['CI_REPLAY_STAGE']).toBe('string');
      for (const name of jobs) {
        const steps = yaml.jobs[name]!.steps;
        const save = steps.find((step) => step.uses === './.github/actions/turbo-cache/save');
        if (save) {
          expect(save.with?.['replay_name']).toBe(expectedNames[`${workflow}:${name}`]);
          expect(save.with?.['prior_status']).toBe('${{ job.status }}');
          expect(save.with?.['replay_token']).toBe('${{ github.token }}');
          expect(save.env?.['CI_REPLAY_TOKEN']).toBeUndefined();
          if (workflow === 'targeted-checks.yml' && name === 'unit')
            expect(save.env?.['CI_REPLAY_SELECTION']).toContain('matrix.lane.paths');
          const finalizer = steps.find(
            (step) => step.name === 'Retain first-failure replay record',
          );
          expect(finalizer?.run).toContain('bash -c "$CI_REPLAY_FALLBACK"');
          expect(finalizer?.run).toContain('bash -c "$CI_REPLAY_STAGE"');
          const upload = steps.find(
            (step) => step.with?.['name'] === expectedNames[`${workflow}:${name}`],
          );
          expect(upload?.with?.['path']).toBe('${{ runner.temp }}/ci-replay-artifact');
          expect(upload?.if).toContain("steps.replay.outcome == 'success'");
          expect(steps.indexOf(finalizer!)).toBeLessThan(steps.indexOf(save));
          expect(steps.indexOf(upload!)).toBeLessThan(steps.indexOf(save));
          continue;
        }
        const finalizer = steps.find((step) => step.name === 'Retain first-failure replay record');
        expect(finalizer?.run).toContain('bash -c "$CI_REPLAY_FALLBACK"');
        expect(finalizer?.run).toContain('bash -c "$CI_REPLAY_STAGE"');
        const upload = steps.find(
          (step) => step.with?.['path'] === '${{ runner.temp }}/ci-replay-artifact',
        );
        expect(upload?.if).toContain("steps.replay.outcome == 'success'");
      }
    }
  });
});
