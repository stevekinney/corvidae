import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CiEvidenceWorkflowError,
  createCiEvidenceWorkflowReceipt,
  MAX_JUNIT_REPORT_BYTES,
  MAX_JUNIT_REPORTS,
  readJUnitArtifactReports,
  validateJUnitArtifacts,
  type CiEvidenceWorkflowEnvironment,
} from './ci-evidence-workflow.ts';

const sha = (character: string) => character.repeat(40);
const digest = (character: string) => character.repeat(64);
const scratch = join(process.cwd(), 'tmp/chef/p07-evidence');
mkdirSync(scratch, { recursive: true });
const fixtures: string[] = [];

function artifactFixture(): string {
  const directory = mkdtempSync(join(scratch, 'workflow-artifact-'));
  fixtures.push(directory);
  return directory;
}

function environment(
  overrides: Partial<CiEvidenceWorkflowEnvironment> = {},
): CiEvidenceWorkflowEnvironment {
  return {
    GITHUB_REPOSITORY: 'stevekinney/corvidae',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_EVENT_PATH: '/event.json',
    GITHUB_WORKFLOW_REF: 'stevekinney/corvidae/.github/workflows/main.yml@refs/heads/candidate',
    GITHUB_WORKFLOW_SHA: sha('a'),
    GITHUB_RUN_ID: '17',
    GITHUB_RUN_ATTEMPT: '2',
    VERIFICATION_REQUEST: digest('d'),
    VERIFICATION_PLAN: digest('e'),
    VERIFICATION_BASE: sha('b'),
    CI_EVIDENCE_NEEDS: '{"root":{"result":"success"}}',
    CI_EVIDENCE_EXPECTED_JOBS: '["root"]',
    ...overrides,
  };
}

const git = (command: readonly string[]) => {
  if (command.join(' ') === 'git rev-parse HEAD') return { code: 0, stdout: `${sha('c')}\n` };
  if (command.join(' ') === 'git rev-parse HEAD^') return { code: 0, stdout: `${sha('b')}\n` };
  if (command.join(' ') === 'git rev-parse HEAD^{tree}')
    return { code: 0, stdout: `${sha('f')}\n` };
  throw new Error(`unexpected command: ${command.join(' ')}`);
};

describe('createCiEvidenceWorkflowReceipt', () => {
  test('records a manually dispatched run from trusted Actions identity and the checked tree', () => {
    expect(
      createCiEvidenceWorkflowReceipt({
        environment: environment(),
        eventPayload: {},
        git,
      }),
    ).toEqual({
      repository: 'stevekinney/corvidae',
      event: 'workflow_dispatch',
      workflowPath: '.github/workflows/main.yml',
      workflowRevision: sha('a'),
      requestKey: digest('d'),
      planDigest: digest('e'),
      base: sha('b'),
      candidate: sha('c'),
      checkedRevision: sha('c'),
      checkedTree: sha('f'),
      runId: 17,
      attempt: 2,
      jobs: { root: 'success' },
    });
  });

  test('uses the pull request payload for base and candidate while retaining the merge checkout', () => {
    const reports = artifactFixture();
    mkdirSync(join(reports, 'test-output', 'junit'), { recursive: true });
    writeFileSync(
      join(reports, 'test-output', 'junit', 'actual.xml'),
      '<testsuite file="scripts/chef/ci-evidence-workflow.test.ts"><testcase name="passes" file="scripts/chef/ci-evidence-workflow.test.ts" /></testsuite>',
    );
    const receipt = createCiEvidenceWorkflowReceipt({
      environment: environment({
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_WORKFLOW_REF:
          'stevekinney/corvidae/.github/workflows/pull-request.yml@refs/pull/17/merge',
        VERIFICATION_REQUEST: undefined,
        VERIFICATION_PLAN: undefined,
        VERIFICATION_BASE: undefined,
        CI_EVIDENCE_TEST_REPORT_DIRECTORY: reports,
      }),
      eventPayload: { pull_request: { base: { sha: sha('b') }, head: { sha: sha('d') } } },
      git,
    });
    expect(receipt).toMatchObject({
      event: 'pull_request',
      workflowPath: '.github/workflows/pull-request.yml',
      workflowRevision: sha('a'),
      base: sha('b'),
      candidate: sha('d'),
      checkedRevision: sha('c'),
      checkedTree: sha('f'),
    });
    expect(receipt.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.requestKey).toBe('');
    expect(receipt.testFiles).toEqual(['scripts/chef/ci-evidence-workflow.test.ts']);
  });

  test('keeps a passing skipped-only pull-request report non-adoptable', () => {
    const reports = artifactFixture();
    mkdirSync(join(reports, 'packages', 'one', 'test-output', 'junit'), { recursive: true });
    writeFileSync(
      join(reports, 'packages', 'one', 'test-output', 'junit', 'skipped.xml'),
      '<testsuite><testcase name="later" file="src/x.test.ts"><skipped /></testcase></testsuite>',
    );
    const receipt = createCiEvidenceWorkflowReceipt({
      environment: environment({
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_WORKFLOW_REF:
          'stevekinney/corvidae/.github/workflows/pull-request.yml@refs/pull/17/merge',
        VERIFICATION_REQUEST: undefined,
        VERIFICATION_PLAN: undefined,
        VERIFICATION_BASE: undefined,
        CI_EVIDENCE_TEST_REPORT_DIRECTORY: reports,
      }),
      eventPayload: { pull_request: { base: { sha: sha('b') }, head: { sha: sha('d') } } },
      git,
    });
    expect(receipt.testFiles).toBeUndefined();
  });

  test('uses the push payload instead of manual dispatch values', () => {
    const receipt = createCiEvidenceWorkflowReceipt({
      environment: environment({
        GITHUB_EVENT_NAME: 'push',
        VERIFICATION_REQUEST: undefined,
        VERIFICATION_PLAN: undefined,
        VERIFICATION_BASE: undefined,
      }),
      eventPayload: { before: sha('b'), after: sha('c') },
      git,
    });
    expect(receipt).toMatchObject({ event: 'push', base: sha('b'), candidate: sha('c') });
    expect(receipt.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.requestKey).toBe('');
  });

  test('a scheduled run records the checked-out latest commit with checkout-derived identity', () => {
    const receipt = createCiEvidenceWorkflowReceipt({
      environment: environment({
        GITHUB_EVENT_NAME: 'schedule',
        VERIFICATION_REQUEST: undefined,
        VERIFICATION_PLAN: undefined,
        VERIFICATION_BASE: undefined,
      }),
      eventPayload: {},
      git,
    });
    expect(receipt).toMatchObject({
      event: 'schedule',
      base: sha('b'),
      candidate: sha('c'),
      checkedRevision: sha('c'),
    });
    expect(receipt.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.requestKey).toBe('');
  });

  test('records an unbound manual run with checkout-derived identity when no verification fields are supplied', () => {
    const receipt = createCiEvidenceWorkflowReceipt({
      environment: environment({
        VERIFICATION_REQUEST: '',
        VERIFICATION_PLAN: '',
        VERIFICATION_BASE: '',
      }),
      eventPayload: {},
      git,
    });
    expect(receipt).toMatchObject({
      event: 'workflow_dispatch',
      requestKey: '',
      base: sha('b'),
      candidate: sha('c'),
    });
    expect(receipt.planDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects a manual receipt with a missing digest, malformed workflow reference, or skipped dependency', () => {
    for (const overrides of [
      { VERIFICATION_PLAN: '' },
      { GITHUB_WORKFLOW_REF: 'not-a-workflow-reference' },
      { CI_EVIDENCE_NEEDS: '{"root":{"result":"skipped"}}' },
    ]) {
      expect(() =>
        createCiEvidenceWorkflowReceipt({
          environment: environment(overrides),
          eventPayload: {},
          git,
        }),
      ).toThrow(CiEvidenceWorkflowError);
    }
  });

  test('rejects a needs inventory that omits an expected job', () => {
    expect(() =>
      createCiEvidenceWorkflowReceipt({
        environment: environment({ CI_EVIDENCE_EXPECTED_JOBS: '["root","tests"]' }),
        eventPayload: {},
        git,
      }),
    ).toThrow('expected prerequisite tests is missing');
  });

  test('aggregates run-scoped JUnit bundles on a later attempt without new uploads from every job', () => {
    const directory = artifactFixture();
    const names = [
      'cinder',
      'components',
      'packages',
      'applications, plugins, testing',
      'interborough host',
      'interborough ui 1',
      'interborough ui 2',
      'interborough ui 3',
      'interborough ui 4',
      'bureau',
      'weft',
      'everything else',
    ];
    const jobs = ['junit-root', ...names.map((_, index) => `junit-tests-${index}`)];
    for (const job of jobs) {
      const bundle = join(directory, job);
      mkdirSync(bundle);
      writeFileSync(join(bundle, 'fast.xml'), '<testsuite><testcase name="passes"/></testsuite>');
    }
    const receipt = createCiEvidenceWorkflowReceipt({
      environment: environment({ CI_EVIDENCE_ARTIFACT_DIRECTORY: directory }),
      eventPayload: {},
      git,
    });
    expect(receipt.attempt).toBe(2);
    expect(receipt.reports).toEqual(
      Object.fromEntries(jobs.map((job) => [job, { reports: 1, testCases: 1 }])),
    );
    const matrix = readFileSync(join(import.meta.dir, '../../.github/workflows/main.yml'), 'utf8')
      .split('  tests:\n')[1]
      ?.split('    env:\n')[0];
    expect(
      [...(matrix ?? '').matchAll(/^          - name: (.+)$/gm)].map((match) => match[1]),
    ).toEqual(names);
    expect(new Set(jobs).size).toBe(jobs.length);
    const lastReport = join(directory, jobs.at(-1)!, 'fast.xml');
    for (const content of [
      null,
      '<testsuite/>',
      '<testsuite><testcase name="fails"><failure/></testcase></testsuite>',
    ]) {
      if (content === null) rmSync(lastReport);
      else writeFileSync(lastReport, content);
      expect(() =>
        createCiEvidenceWorkflowReceipt({
          environment: environment({ CI_EVIDENCE_ARTIFACT_DIRECTORY: directory }),
          eventPayload: {},
          git,
        }),
      ).toThrow(CiEvidenceWorkflowError);
    }
  });

  test('rejects partially supplied manual verification identity fields', () => {
    expect(() =>
      createCiEvidenceWorkflowReceipt({
        environment: environment({ VERIFICATION_PLAN: '', VERIFICATION_BASE: '' }),
        eventPayload: {},
        git,
      }),
    ).toThrow('manual verification inputs must be all supplied or all empty');
  });

  test('rejects a pull request payload without exact head and base commit identities', () => {
    expect(() =>
      createCiEvidenceWorkflowReceipt({
        environment: environment({
          GITHUB_EVENT_NAME: 'pull_request',
          VERIFICATION_REQUEST: undefined,
          VERIFICATION_PLAN: undefined,
          VERIFICATION_BASE: undefined,
        }),
        eventPayload: { pull_request: { base: { sha: sha('b') }, head: {} } },
        git,
      }),
    ).toThrow('pull_request event payload has no valid head SHA');
  });
});

describe('CI evidence workflow producers', () => {
  const root = join(import.meta.dir, '..', '..');
  const main = readFileSync(join(root, '.github/workflows/main.yml'), 'utf8');
  const pullRequest = readFileSync(join(root, '.github/workflows/pull-request.yml'), 'utf8');

  test('a paused push records both slow jobs as inapplicable while a manual or scheduled run still requires them', () => {
    expect(main).toContain("schedule:\n    - cron: '17 9 * * *'");
    for (const name of ['tests-slow', 'browser']) {
      const job = main.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z-]+:\n/)[0];
      expect(job).toContain(
        "if: ${{ (inputs.chef_candidate == '' || inputs.chef_candidate == github.sha) && (github.event_name == 'workflow_dispatch' || github.event_name == 'schedule' || vars.PAUSE_AUTOMATIC_SLOW_TESTS != 'true') }}",
      );
    }
    // A scheduled run shares the push group and never cancels or is cancelled by one.
    expect(main).toContain(
      "group: ${{ github.event_name == 'workflow_dispatch' && format('main-dispatch-{0}', github.ref) || 'main' }}",
    );
    expect(main).toContain("cancel-in-progress: ${{ github.event_name == 'workflow_dispatch' }}");
    expect(main).toContain(
      `CI_EVIDENCE_NOT_APPLICABLE: \${{ github.event_name == 'push' && vars.PAUSE_AUTOMATIC_SLOW_TESTS == 'true' && '["tests-slow","browser"]' || '[]' }}`,
    );
    expect(pullRequest).toContain(
      "TEST_LANES: ${{ vars.PAUSE_AUTOMATIC_SLOW_TESTS == 'true' && '--fast-only' || '--isolated' }}",
    );
    expect(pullRequest).toContain(
      "id: select\n        if: ${{ vars.PAUSE_AUTOMATIC_SLOW_TESTS != 'true' }}",
    );
  });

  test('installs the producer and preserves required job bundles across partial reruns', () => {
    expect(main).toContain('bun scripts/chef/ci-evidence-workflow.ts ci-evidence-receipt.json');
    expect(main).toContain('name: ci-evidence-receipt-${{ github.run_attempt }}');
    expect(main).not.toContain('printf \'{"requestKey"');
    expect(main).toContain('if-no-files-found: error');
    expect(main).toContain('name: junit-root\n          overwrite: true');
    expect(main).toContain(
      'name: junit-tests-${{ strategy.job-index }}\n          overwrite: true',
    );
    expect(main.split('\n  evidence:')[1]).toContain('bun install --frozen-lockfile');
    expect(main).toContain('pattern: junit-*');
    expect(main).toContain('CI_EVIDENCE_ARTIFACT_DIRECTORY: ci-evidence-artifacts');
    expect(main).toContain(
      'CI_EVIDENCE_EXPECTED_JOBS: \'["root","workspaces","tests","tests-slow","browser","test-durations"]\'',
    );
  });

  test('produces independent pull-request evidence with explicit browser non-applicability', () => {
    expect(pullRequest).toContain('name: Evidence aggregate');
    expect(pullRequest.split('\n  evidence:')[1]).toContain('bun install --frozen-lockfile');
    expect(pullRequest).toContain('name: ci-evidence-tests');
    expect(pullRequest).toContain('CI_EVIDENCE_TEST_REPORT_DIRECTORY: ci-evidence-tests');
    expect(pullRequest).toContain('CI_EVIDENCE_NEEDS: ${{ toJSON(needs) }}');
    expect(pullRequest).toContain('CI_EVIDENCE_NOT_APPLICABLE:');
    expect(pullRequest).toContain(
      'CI_EVIDENCE_EXPECTED_JOBS: \'["static","workspaces","tests","browser-selection","browser"]\'',
    );
    expect(pullRequest).toContain('name: ci-evidence-receipt-${{ github.run_attempt }}');
  });
});

describe('validateJUnitArtifacts', () => {
  const expected = [
    'junit-root-2',
    ...Array.from({ length: 12 }, (_, index) => `junit-tests-${index}-2`),
  ];
  const report = (body = '<testcase name="passes"/>') =>
    new TextEncoder().encode(`<testsuite>${body}</testsuite>`);
  const artifacts = () => Object.fromEntries(expected.map((name) => [name, [report()]]));

  test('accepts every expected nonempty, passing JUnit artifact', () => {
    expect(validateJUnitArtifacts(artifacts(), expected)).toEqual(
      Object.fromEntries(expected.map((name) => [name, { reports: 1, testCases: 1 }])),
    );
  });

  test('rejects missing, empty, malformed, and failing required report bundles', () => {
    const cases = [
      (() => {
        const value = artifacts();
        delete value['junit-root-2'];
        return value;
      })(),
      { ...artifacts(), 'junit-root-2': [] },
      { ...artifacts(), 'junit-root-2': [new TextEncoder().encode('<testsuite>')] },
      {
        ...artifacts(),
        'junit-root-2': [new TextEncoder().encode('<testsuite><failure/></testsuite>')],
      },
    ];
    for (const value of cases)
      expect(() => validateJUnitArtifacts(value, expected)).toThrow(CiEvidenceWorkflowError);
  });
});

describe('readJUnitArtifactReports', () => {
  test('rejects oversized reports before reading their contents', () => {
    const directory = artifactFixture();
    writeFileSync(join(directory, 'oversized.xml'), Buffer.alloc(MAX_JUNIT_REPORT_BYTES + 1));
    expect(() => readJUnitArtifactReports(directory)).toThrow('report exceeds maximum size');
  });

  test('rejects an excessive report count before parsing unbounded input', () => {
    const directory = artifactFixture();
    for (let index = 0; index <= MAX_JUNIT_REPORTS; index += 1)
      writeFileSync(join(directory, `${index}.xml`), '<testsuite/>');
    expect(() => readJUnitArtifactReports(directory)).toThrow('too many reports');
  });
});

afterAll(() => {
  for (const directory of fixtures) rmSync(directory, { recursive: true, force: true });
});
