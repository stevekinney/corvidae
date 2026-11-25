import { afterAll, expect } from 'bun:test';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';

import { createGitHubCiEvidenceProvider, type GitReader } from './ci-evidence-github.ts';
import { runCiEvidence } from './ci-evidence-run.ts';
import { createCiEvidenceWorkflowReceipt } from './ci-evidence-workflow.ts';
import {
  ciEvidenceRequestKey,
  reconcileCiEvidenceRequest,
  type CiEvidenceRequest,
} from './ci-evidence.ts';
import { createExecutionStateStore } from './execution-state.ts';
import { createScenarios } from './scenario.test-support.ts';

const encode = (value: unknown) => ({
  exitCode: 0,
  stdout: new TextEncoder().encode(JSON.stringify(value)),
  stderr: new Uint8Array(),
});
const directories: string[] = [];
const scratch = join(process.cwd(), 'tmp/chef/p07-evidence');
mkdirSync(scratch, { recursive: true });
const scenarios = createScenarios();

function request(overrides: Partial<CiEvidenceRequest> = {}): CiEvidenceRequest {
  const value = {
    repository: 'acme/widgets',
    resource: 'COR-7',
    base: 'b'.repeat(40),
    candidate: 'c'.repeat(40),
    integrationTree: 'd'.repeat(40),
    verificationPlanDigest: 'e'.repeat(64),
    workflow: 'Main',
    workflowPath: '.github/workflows/main.yml',
    workflowRevision: 'a'.repeat(40),
    event: 'workflow_dispatch' as const,
    ...overrides,
  };
  return { ...value, requestKey: ciEvidenceRequestKey(value) };
}

function fixture(
  input: CiEvidenceRequest,
  options: {
    pullRequest?: boolean;
    invalidParents?: boolean;
    missingLocalMerge?: boolean;
    inheritedJob?: 'success' | 'failure';
    failedJob?: boolean;
    skippedRequired?: boolean;
    browserMismatch?: boolean;
    oversized?: boolean;
    expands?: boolean;
    runConclusion?: string;
  } = {},
) {
  const checkedRevision = options.pullRequest ? 'f'.repeat(40) : input.candidate;
  const runName = input.event === 'workflow_dispatch' ? `P07 ${input.requestKey}` : input.workflow;
  const reportDirectory = options.pullRequest
    ? mkdtempSync(join(scratch, 'github-junit-'))
    : undefined;
  if (reportDirectory !== undefined) {
    directories.push(reportDirectory);
    const junitDirectory = join(reportDirectory, 'test-output', 'junit');
    mkdirSync(junitDirectory, { recursive: true });
    writeFileSync(
      join(junitDirectory, 'tests.xml'),
      '<testsuite><testcase name="passes" file="scripts/chef/ci-evidence-github.integration.test.ts" /></testsuite>',
    );
  }
  const produced = createCiEvidenceWorkflowReceipt({
    environment: {
      GITHUB_REPOSITORY: input.repository,
      GITHUB_EVENT_NAME: input.event,
      GITHUB_WORKFLOW_REF: `${input.repository}/${input.workflowPath}@${input.workflowRevision}`,
      GITHUB_WORKFLOW_SHA: input.workflowRevision,
      GITHUB_RUN_ID: '17',
      GITHUB_RUN_ATTEMPT: '2',
      VERIFICATION_REQUEST: input.requestKey,
      VERIFICATION_PLAN: input.verificationPlanDigest,
      VERIFICATION_BASE: input.base,
      CI_EVIDENCE_NEEDS: options.pullRequest
        ? JSON.stringify({
            aggregate: { result: 'success' },
            browser: { result: options.browserMismatch ? 'success' : 'skipped' },
          })
        : '{"aggregate":{"result":"success"}}',
      CI_EVIDENCE_EXPECTED_JOBS: options.pullRequest ? '["aggregate","browser"]' : '["aggregate"]',
      ...(options.pullRequest && !options.browserMismatch
        ? { CI_EVIDENCE_NOT_APPLICABLE: '["browser"]' }
        : {}),
      ...(reportDirectory === undefined
        ? {}
        : { CI_EVIDENCE_TEST_REPORT_DIRECTORY: reportDirectory }),
    },
    eventPayload: options.pullRequest
      ? { pull_request: { base: { sha: input.base }, head: { sha: input.candidate } } }
      : {},
    git(command) {
      if (command.join(' ') === 'git rev-parse HEAD')
        return { code: 0, stdout: `${checkedRevision}\n` };
      if (command.join(' ') === 'git rev-parse HEAD^{tree}')
        return { code: 0, stdout: `${input.integrationTree}\n` };
      throw new Error(`unexpected producer Git command: ${command.join(' ')}`);
    },
  });
  const archive = zipSync({
    'ci-evidence-receipt.json': options.expands
      ? new Uint8Array(65 * 1024).fill(32)
      : new TextEncoder().encode(JSON.stringify(produced)),
  });
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  const commands: string[][] = [];
  const git: GitReader = {
    tree(revision) {
      return revision === checkedRevision && !options.missingLocalMerge
        ? input.integrationTree
        : undefined;
    },
    parents(revision) {
      if (revision !== checkedRevision) return undefined;
      return options.invalidParents ? [input.candidate, input.base] : [input.base, input.candidate];
    },
  };
  const provider = createGitHubCiEvidenceProvider({
    repository: input.repository,
    dispatchRef: 'candidate-branch',
    git,
    raw: {
      run(argv) {
        commands.push(argv);
        const path = argv.at(-1) ?? '';
        if (argv.slice(0, 3).join(' ') === 'gh workflow run')
          return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
        if (path.includes('/workflows/main.yml/runs?'))
          return encode({
            total_count: 1,
            workflow_runs: [
              {
                id: 17,
                event: input.event,
                head_sha: input.candidate,
                name: runName,
                path: input.workflowPath,
                display_title: `P07 ${input.requestKey}`,
                run_attempt: 2,
                ...(options.pullRequest
                  ? {
                      pull_requests: [
                        { head: { sha: input.candidate }, base: { sha: input.base } },
                      ],
                    }
                  : {}),
              },
            ],
          });
        if (path.endsWith('/runs/17'))
          return encode({
            repository: { full_name: input.repository },
            head_sha: input.candidate,
            status: 'completed',
            conclusion: options.runConclusion ?? 'success',
            name: runName,
            workflow_id: 72,
            path: input.workflowPath,
            event: input.event,
            run_attempt: 2,
          });
        if (path.endsWith('/actions/workflows/72')) {
          return encode({ id: 72, name: input.workflow, path: input.workflowPath });
        }
        if (path.endsWith('/git/ref/heads/candidate-branch'))
          return encode({ object: { sha: input.candidate } });
        if (path.endsWith(`/git/commits/${checkedRevision}`)) {
          const parents = options.invalidParents
            ? [input.candidate, input.base]
            : [input.base, input.candidate];
          return encode({
            sha: checkedRevision,
            tree: { sha: input.integrationTree },
            parents: parents.map((sha) => ({ sha })),
          });
        }
        if (path.endsWith('/runs/17/jobs?filter=all&per_page=100&page=1')) {
          const jobs =
            options.inheritedJob === undefined
              ? []
              : [
                  {
                    id: 8,
                    run_id: 17,
                    run_attempt: 1,
                    head_sha: input.candidate,
                    name: 'Retained test shard',
                    status: 'completed',
                    conclusion: options.inheritedJob,
                  },
                ];
          return encode({ total_count: jobs.length, jobs });
        }
        if (path.endsWith('/runs/17/artifacts?per_page=100&page=1'))
          return encode({
            total_count: 1,
            artifacts: [
              {
                id: 51,
                name: 'ci-evidence-receipt-2',
                digest,
                expired: false,
                size_in_bytes: options.oversized ? 65 * 1024 : archive.length,
              },
            ],
          });
        if (path.endsWith('/artifacts/51/zip'))
          return { exitCode: 0, stdout: archive, stderr: new Uint8Array() };
        if (path.endsWith('/runs/17/attempts/2/jobs?per_page=100&page=1'))
          return encode({
            total_count: options.skippedRequired || options.pullRequest ? 2 : 1,
            jobs: [
              {
                id: 9,
                name: 'Evidence aggregate',
                status: 'completed',
                conclusion: options.failedJob ? 'failure' : 'success',
              },
              ...(options.pullRequest
                ? [
                    {
                      id: 11,
                      name: 'Browser suites / Chromium fixtures (1/4)',
                      status: 'completed',
                      conclusion: 'skipped',
                    },
                  ]
                : []),
              ...(options.skippedRequired
                ? [
                    {
                      id: 10,
                      name: 'Root checks, scripts tests, audit',
                      status: 'completed',
                      conclusion: 'skipped',
                    },
                  ]
                : []),
            ],
          });
        throw new Error(`unexpected GitHub command: ${argv.join(' ')}`);
      },
    },
  });
  return { commands, provider };
}

scenarios.scenario(
  'authenticates exact manual-request runs, receipt checkout, attempt jobs, and dispatch inputs',
  async () => {
    const input = request();
    const { commands, provider } = fixture(input);
    const runs = await provider.findRuns(input);
    expect(runs).toEqual([
      expect.objectContaining({
        id: 17,
        checkedRevision: input.candidate,
        checkedTree: input.integrationTree,
        jobs: ['Evidence aggregate'],
      }),
    ]);
    await provider.dispatch(input);
    expect(commands.at(-1)).toEqual([
      'gh',
      'workflow',
      'run',
      'main.yml',
      '--repo',
      input.repository,
      '--ref',
      'candidate-branch',
      '-f',
      `verification_request=${input.requestKey}`,
      '-f',
      `verification_plan=${input.verificationPlanDigest}`,
      '-f',
      `verification_base=${input.base}`,
    ]);
  },
);

scenarios.scenario(
  'refuses a passing receipt when the authenticated aggregate job failed',
  async () => {
    const input = request();
    const { provider } = fixture(input, { failedJob: true });
    let error: unknown;
    try {
      await provider.findRuns(input);
    } catch (reason) {
      error = reason;
    }
    expect((error as Error).message).toContain('aggregate');
  },
);

scenarios.scenario(
  'only accepts a pull-request merge checkout whose two parents bind the base and candidate',
  async () => {
    const input = request({
      event: 'pull_request',
      verificationPlanDigest: createHash('sha256')
        .update(
          JSON.stringify({
            version: 1,
            event: 'pull_request',
            workflowPath: '.github/workflows/main.yml',
            workflowRevision: 'a'.repeat(40),
            jobs: ['aggregate', 'browser'],
          }),
        )
        .digest('hex'),
    });
    const accepted = fixture(input, { pullRequest: true });
    const acceptedRuns = await accepted.provider.findRuns(input);
    expect(acceptedRuns[0]).toHaveProperty('checkedRevision', 'f'.repeat(40));
    const remote = fixture(input, { pullRequest: true, missingLocalMerge: true });
    const remoteRuns = await remote.provider.findRuns(input);
    expect(remoteRuns[0]).toHaveProperty('checkedRevision', 'f'.repeat(40));
    const wrongRemote = fixture(input, {
      pullRequest: true,
      missingLocalMerge: true,
      invalidParents: true,
    });
    expect(await throwingRejectionOf(wrongRemote.provider.findRuns(input))).toThrow(
      'does not bind',
    );
    const wrongBrowser = fixture(input, { pullRequest: true, browserMismatch: true });
    let browserError: unknown;
    try {
      await wrongBrowser.provider.findRuns(input);
    } catch (reason) {
      browserError = reason;
    }
    expect((browserError as Error).message).toContain('browser receipt disagrees');

    const rejected = fixture(input, { pullRequest: true, invalidParents: true });
    let error: unknown;
    try {
      await rejected.provider.findRuns(input);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('does not bind');
  },
);

scenarios.scenario(
  'discovers one automatic pull-request receipt only after it binds its exact merge identity',
  async () => {
    const input = request({
      event: 'pull_request',
      verificationPlanDigest: createHash('sha256')
        .update(
          JSON.stringify({
            version: 1,
            event: 'pull_request',
            workflowPath: '.github/workflows/main.yml',
            workflowRevision: 'a'.repeat(40),
            jobs: ['aggregate', 'browser'],
          }),
        )
        .digest('hex'),
    });
    const accepted = fixture(input, { pullRequest: true });
    const runs = await accepted.provider.findAutomaticPullRequestRuns?.({
      repository: input.repository,
      resource: input.resource,
      base: input.base,
      candidate: input.candidate,
      integrationTree: input.integrationTree,
      workflow: input.workflow,
      workflowPath: input.workflowPath,
    });
    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({
      checkedRevision: 'f'.repeat(40),
      base: input.base,
      head: input.candidate,
    });

    const wrong = fixture(input, { pullRequest: true, invalidParents: true });
    expect(
      await wrong.provider.findAutomaticPullRequestRuns?.({
        repository: input.repository,
        resource: input.resource,
        base: input.base,
        candidate: input.candidate,
        integrationTree: input.integrationTree,
        workflow: input.workflow,
        workflowPath: input.workflowPath,
      }),
    ).toEqual([]);
  },
);

scenarios.scenario('binds retained successful jobs after a partial workflow rerun', async () => {
  const input = request();
  const retained = fixture(input, { inheritedJob: 'success' });
  const retainedRuns = await retained.provider.findRuns(input);
  expect(retainedRuns[0]).toHaveProperty('jobs', ['Evidence aggregate', 'Retained test shard']);
  const failed = fixture(input, { inheritedJob: 'failure' });
  expect(await throwingRejectionOf(failed.provider.findRuns(input))).toThrow('required job');
});

scenarios.scenario(
  'public reconciliation entrypoint binds authenticated provider evidence',
  async () => {
    const input = request();
    const { provider } = fixture(input);
    const stateDirectory = mkdtempSync(join(scratch, 'github-provider-'));
    directories.push(stateDirectory);
    const state = createExecutionStateStore({
      stateDirectory,
      hostId: 'p07-github-fixture',
    });
    const reconciliation = await reconcileCiEvidenceRequest(
      { ...state, requestPath: `${state.stateDirectory}/ci-evidence-requests.json` },
      input,
      provider,
    );
    expect(reconciliation.state).toBe('bound');
  },
);

scenarios.scenario('refuses oversized receipts before download or inflation', async () => {
  const input = request();
  for (const options of [{ oversized: true }, { expands: true }]) {
    const { provider, commands } = fixture(input, options);
    let error: unknown;
    try {
      await provider.findRuns(input);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('bound');
    expect(commands.some((command) => command.at(-1)?.endsWith('/artifacts/51/zip'))).toBe(
      options.expands === true,
    );
  }
});

scenarios.scenario('keeps a canceled run distinct from an unavailable receipt', async () => {
  const input = request();
  const { provider, commands } = fixture(input, { runConclusion: 'cancelled' });
  const stateDirectory = mkdtempSync(join(scratch, 'github-canceled-'));
  directories.push(stateDirectory);
  const state = createExecutionStateStore({ stateDirectory, hostId: 'p07-github-fixture' });
  const store = { ...state, requestPath: join(state.stateDirectory, 'ci-evidence-requests.json') };
  const result = await reconcileCiEvidenceRequest(store, input, provider);
  expect(result).toEqual({
    state: 'canceled',
    requestKey: input.requestKey,
    runs: [{ state: 'canceled', id: 17, attempt: 2 }],
  });
  expect(commands.some((command) => command.at(-1)?.includes('/artifacts'))).toBe(false);
  const missing = await reconcileCiEvidenceRequest(store, input, {
    async findRuns() {
      return [];
    },
    async dispatch() {
      throw new Error('must never redispatch');
    },
  });
  expect(missing).toEqual(result);
});

scenarios.scenario('request CLI reports the exact authenticated run', async () => {
  const input = request();
  const { provider } = fixture(input);
  const directory = mkdtempSync(join(scratch, 'github-cli-'));
  directories.push(directory);
  const requestFile = join(directory, 'request.json');
  writeFileSync(requestFile, JSON.stringify(input));
  const result = await runCiEvidence(
    ['--request', requestFile, '--state-directory', directory, '--ref', 'candidate-branch'],
    provider,
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.output)).toMatchObject({
    state: 'bound',
    requestKey: input.requestKey,
    run: { id: 17, attempt: 2 },
  });
});

scenarios.scenario(
  'refuses a green aggregate when a required provider job was skipped',
  async () => {
    const input = request();
    const { provider } = fixture(input, { skippedRequired: true });
    let error: unknown;
    try {
      await provider.findRuns(input);
    } catch (reason) {
      error = reason;
    }
    expect((error as Error).message).toContain('required job');
  },
);

await scenarios.settled();

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
