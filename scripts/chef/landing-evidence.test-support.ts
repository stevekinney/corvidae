// Green defaults for the landing check (`landing-evidence.ts`): a fake `gh` and plan runner, and a
// provider, that let a fixture land. A test varies one input to make a refusal. No process starts.

import {
  ciEvidenceRequestKey,
  type CiEvidenceProvider,
  type CiEvidenceRequest,
} from './ci-evidence.ts';
import type { DeliveryRequest } from './delivery-completion.ts';
import type { Runner, RunnerResult } from './process-runner.ts';

const reply = (stdout = '', code = 0, stderr = ''): RunnerResult => ({ code, stdout, stderr });

export const LANDING_RUN_ID = 4242;
export const LANDING_DIGEST = 'f'.repeat(64);

/** The identity a request pins for its one `main.yml` run (a pull-request event keeps its own digest). */
export function landingIdentity(
  request: Pick<DeliveryRequest, 'repository' | 'base' | 'revision' | 'integrationTree'>,
  pinned: { event?: CiEvidenceRequest['event']; verificationPlanDigest?: string } = {},
): CiEvidenceRequest {
  const input = {
    repository: request.repository,
    resource: 'fixture',
    base: request.base,
    candidate: request.revision,
    integrationTree: request.integrationTree,
    verificationPlanDigest: pinned.verificationPlanDigest ?? LANDING_DIGEST,
    workflow: 'Main',
    workflowPath: '.github/workflows/main.yml',
    workflowRevision: request.revision,
    event: pinned.event ?? 'pull_request',
  } satisfies Omit<CiEvidenceRequest, 'requestKey'>;
  return { ...input, requestKey: ciEvidenceRequestKey(input) };
}

/** The authenticated run the provider finds for `identity`, with `overrides` applied. */
export function landingRun(
  identity: CiEvidenceRequest,
  request: Pick<DeliveryRequest, 'base' | 'revision' | 'integrationTree'>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: LANDING_RUN_ID,
    attempt: 1,
    repository: identity.repository,
    head: request.revision,
    base: request.base,
    integrationTree: request.integrationTree,
    event: identity.event,
    workflow: identity.workflow,
    workflowPath: identity.workflowPath,
    workflowRevision: identity.workflowRevision,
    verificationPlanDigest: identity.verificationPlanDigest,
    requestKey: identity.requestKey,
    receiptRequestKey: identity.requestKey,
    checkedRevision: request.revision,
    checkedTree: request.integrationTree,
    receiptJobs: {},
    jobs: [],
    ...overrides,
  };
}

/** A provider that answers every identity of `request` with its green run. */
export function landingProvider(
  request: Pick<DeliveryRequest, 'repository' | 'base' | 'revision' | 'integrationTree'>,
  overrides: Record<string, unknown> = {},
): Pick<CiEvidenceProvider, 'findRuns'> {
  return {
    async findRuns(identity) {
      return [landingRun(identity, request, overrides)];
    },
  };
}

export interface ListedRunFixture {
  id?: number;
  head_sha: string;
  path?: string;
  display_title?: string;
  status?: string;
  conclusion?: string;
}

/** `gh api repos/<r>/actions/runs?head_sha=<head>`: the key a fake runner answers, and its answer. */
export function runsAnswer(
  repository: string,
  head: string,
  runs: ListedRunFixture[],
): Record<string, RunnerResult> {
  return {
    [`api repos/${repository}/actions/runs?head_sha=${head}&per_page=100`]: reply(
      JSON.stringify({
        workflow_runs: runs.map((run) => ({
          id: LANDING_RUN_ID,
          path: '.github/workflows/main.yml',
          status: 'completed',
          conclusion: 'success',
          event: 'pull_request',
          ...run,
        })),
      }),
    ),
  };
}

/** The answer to `runs/<id>/jobs`: one job with `conclusion`. */
export function jobsAnswer(
  repository: string,
  id = LANDING_RUN_ID,
  conclusion = 'success',
): Record<string, RunnerResult> {
  return {
    [`api repos/${repository}/actions/runs/${id}/jobs?per_page=100`]: reply(
      JSON.stringify({ jobs: [{ name: 'Root checks', conclusion }] }),
    ),
  };
}

/**
 * `git diff --name-only <base>...<head>` with every status: the changed files the landing plan
 * reads. Only this exact form is answered, so a `--diff-filter` form gets no answer and a check
 * that used one would refuse.
 */
export function changedAnswer(
  base: string,
  head: string,
  paths: string[] = ['a.ts'],
): Record<string, RunnerResult> {
  return {
    [`diff --name-only ${base}...${head}`]: reply(paths.map((path) => `${path}\n`).join('')),
  };
}

/**
 * `inner` with the reads of a green landing answered: one finished green `main.yml` run on the head
 * the URL names, its jobs, and a diff that changes `a.ts`. Anything else goes to `inner`.
 */
export function greenLanding(inner: Runner): Runner {
  return (command, options) => {
    const url = command[0] === 'gh' && command[1] === 'api' ? (command[2] ?? '') : '';
    const runs = /^repos\/([^/]+\/[^/]+)\/actions\/runs\?head_sha=([0-9a-f]+)&per_page=100$/.exec(
      url,
    );
    if (runs !== null)
      return Object.values(
        runsAnswer(runs[1] ?? '', runs[2] ?? '', [{ head_sha: runs[2] ?? '' }]),
      )[0]!;
    if (/^repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/jobs\?per_page=100$/.test(url))
      return reply(JSON.stringify({ jobs: [{ name: 'Root checks', conclusion: 'success' }] }));
    if (
      command[0] === 'git' &&
      command[1] === 'diff' &&
      command[2] === '--name-only' &&
      command.length === 4 &&
      command[3]?.includes('...')
    )
      return reply('a.ts\n');
    return inner(command, options);
  };
}

/** Every answer a green landing reads, for a head and base. */
export function greenLandingAnswers(
  repository: string,
  head: string,
  base: string,
): Record<string, RunnerResult> {
  return {
    ...runsAnswer(repository, head, [{ head_sha: head }]),
    ...jobsAnswer(repository),
    ...changedAnswer(base, head),
  };
}
