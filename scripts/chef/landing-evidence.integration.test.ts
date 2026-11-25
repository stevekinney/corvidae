import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ciEvidenceRequestKey, type CiEvidenceRequest } from './ci-evidence.ts';
import { createDeliveryVerificationFixture } from './delivery-verification.test-support.ts';
import { loadDeliveryVerification } from './delivery-verification.ts';
import { changedAnswer, jobsAnswer, runsAnswer } from './landing-evidence.test-support.ts';
import { validateLandingEvidence } from './landing-evidence.ts';
import type { Runner } from './process-runner.ts';

const directory = mkdtempSync(join(tmpdir(), 'chef-landing-evidence-'));
const fixture = await createDeliveryVerificationFixture(
  {
    directory,
    outputDirectory: directory,
    base: 'a'.repeat(40),
    revision: 'b'.repeat(40),
    integrationTree: 'c'.repeat(40),
  },
  { route: 'pull-request', landing: true },
);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const fullReceiptJobs = {
  root: 'success',
  workspaces: 'success',
  tests: 'success',
  'tests-slow': 'success',
  browser: 'success',
  'test-durations': 'success',
} as const;

async function evidence(
  paths: string[],
  duplicate:
    | { id: number; status: string; conclusion: string; pinned?: boolean; noJobs?: boolean }
    | undefined,
  receiptJobs?: Record<string, 'success' | 'not-applicable'>,
  checkedTree?: string,
  actualIntegrationTree?: string,
): Promise<string | undefined> {
  const loaded = loadDeliveryVerification(fixture.verification, fixture.dependencies);
  const { request } = loaded;
  const listed = [
    { id: 4242, head_sha: request.revision },
    ...(duplicate === undefined
      ? []
      : [
          {
            id: duplicate.id,
            head_sha: request.revision,
            path: '.github/workflows/pull-request.yml',
            status: duplicate.status,
            conclusion: duplicate.conclusion,
          },
        ]),
  ];
  if (duplicate?.pinned === true && request.ciEvidence?.[0] !== undefined) {
    const identity: Omit<CiEvidenceRequest, 'requestKey'> = {
      ...request.ciEvidence[0],
      event: 'pull_request',
      workflow: 'Pull request',
      workflowPath: '.github/workflows/pull-request.yml',
    };
    request.ciEvidence.push({ ...identity, requestKey: ciEvidenceRequestKey(identity) });
    for (const member of request.members) {
      member.providerRuns.push({
        id: duplicate.id,
        attempt: 1,
        obligation: 'AC1:pull-request',
        job: 'Evidence aggregate',
        workflow: identity.workflow,
        workflowPath: identity.workflowPath,
        event: 'pull_request',
      });
    }
  }
  const answers = {
    ...runsAnswer(request.repository, request.revision, listed),
    ...jobsAnswer(request.repository),
    ...changedAnswer(request.base, request.revision, paths),
    ...(duplicate === undefined
      ? {}
      : duplicate.noJobs
        ? {
            [`api repos/${request.repository}/actions/runs/${duplicate.id}/jobs?per_page=100`]: {
              code: 0,
              stderr: '',
              stdout: '{"jobs":[]}',
            },
          }
        : jobsAnswer(
            request.repository,
            duplicate.id,
            duplicate.conclusion === 'failure' ? 'failure' : 'success',
          )),
  };
  const runner: Runner = (command) =>
    answers[command.slice(1).join(' ')] ?? { code: 1, stdout: '', stderr: 'unexpected command' };
  return validateLandingEvidence(
    loaded,
    {
      route: 'pull-request',
      defaultBranch: 'main',
      integrationTree: actualIntegrationTree ?? request.integrationTree,
    },
    {
      runner,
      ciProvider: {
        async findRuns(identity) {
          const id = identity.workflowPath.endsWith('pull-request.yml') ? duplicate?.id : 4242;
          return [
            {
              id: id ?? 4242,
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
              checkedTree: checkedTree ?? request.integrationTree,
              receiptJobs: receiptJobs ?? fullReceiptJobs,
              jobs: ['Evidence aggregate'],
            },
          ];
        },
      },
    },
  );
}

// spawn-free: an in-process Runner and CI provider supply all Git and GitHub observations.

test('reuses a complete manual full receipt only for an unpinned pending pull-request run', async () => {
  const pending = { id: 4243, status: 'in_progress', conclusion: '' };
  expect(await evidence(['scripts/chef/landing-evidence.ts'], pending)).toBeUndefined();
  expect(
    await evidence(['a.ts'], pending, { ...fullReceiptJobs, 'extra-required-lane': 'success' }),
  ).toBeUndefined();
  expect(
    await evidence(['scripts/chef/landing-evidence.ts'], {
      ...pending,
      status: 'queued',
      noJobs: true,
    }),
  ).toBeUndefined();
  expect(
    await evidence(
      ['scripts/chef/landing-evidence.ts'],
      undefined,
      undefined,
      undefined,
      '0'.repeat(40),
    ),
  ).toBeUndefined();
  expect(await evidence(['.github/workflows/pull-request.yml'], pending)).toContain(
    'has not finished',
  );
  expect(await evidence(['package.json'], pending)).toContain('has not finished');
  expect(await evidence(['turbo.json'], pending)).toContain('has not finished');
});

// spawn-free: an in-process Runner and CI provider supply all Git and GitHub observations.

test('keeps pinned, failed, incomplete, and wrong-tree evidence blocking', async () => {
  expect(
    await evidence(['a.ts'], { id: 4243, status: 'in_progress', conclusion: '', pinned: true }),
  ).toContain('has not finished');
  expect(
    await evidence(['a.ts'], { id: 4243, status: 'in_progress', conclusion: 'failure' }),
  ).toContain('concluded failure');
  expect(
    await evidence(['a.ts'], { id: 4243, status: 'in_progress', conclusion: '' }, {}),
  ).toContain('does not have a complete full receipt');
  expect(await evidence(['a.ts'], undefined, {})).toContain(
    'does not have a complete full receipt',
  );
  expect(
    await evidence(
      ['a.ts'],
      { id: 4243, status: 'in_progress', conclusion: '' },
      undefined,
      '0'.repeat(40),
    ),
  ).toContain(`checked tree ${'0'.repeat(40)}`);
  expect(
    await evidence(
      ['a.ts'],
      { id: 4243, status: 'in_progress', conclusion: '' },
      undefined,
      undefined,
      '0'.repeat(40),
    ),
  ).toContain('has not finished');
});
