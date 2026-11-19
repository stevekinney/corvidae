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

export interface PlanFixture {
  changed?: string[];
  requires_full_run?: boolean;
  full_run_rules?: { rule: string; path: string }[];
}

/** `bun scripts/chef/evidence-plan.ts --base <base> --json`: the key and answer for a plan. */
export function planAnswer(base: string, plan: PlanFixture = {}): Record<string, RunnerResult> {
  return {
    [`scripts/chef/evidence-plan.ts --base ${base} --json`]: reply(
      JSON.stringify({
        changed: ['a.ts'],
        requires_full_run: false,
        full_run_rules: [],
        ...plan,
      }),
    ),
  };
}

/**
 * `inner` with the two reads of a green landing answered: one finished green `main.yml` run on the
 * head the URL names, the worktree at that head, and an evidence plan with nothing special.
 * Anything else goes to `inner`.
 */
export function greenLanding(inner: Runner): Runner {
  let head = '';
  return (command, options) => {
    const url = command[0] === 'gh' && command[1] === 'api' ? (command[2] ?? '') : '';
    const runs = /^repos\/([^/]+\/[^/]+)\/actions\/runs\?head_sha=([0-9a-f]+)&per_page=100$/.exec(
      url,
    );
    if (runs !== null) {
      head = runs[2] ?? '';
      return Object.values(runsAnswer(runs[1] ?? '', head, [{ head_sha: head }]))[0]!;
    }
    if (command.join(' ') === 'git rev-parse HEAD' && head !== '') return reply(`${head}\n`);
    if (command[0] === 'bun' && command[1] === 'scripts/chef/evidence-plan.ts')
      return Object.values(planAnswer(command[3] ?? ''))[0]!;
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
    ...planAnswer(base),
    // The worktree is at the head, so the plan describes it.
    'rev-parse HEAD': reply(`${head}\n`),
  };
}
