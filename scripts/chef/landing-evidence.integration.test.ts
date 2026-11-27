import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ciEvidenceRequestKey, type CiEvidenceRequest } from './ci-evidence.ts';
import { createDeliveryVerificationFixture } from './delivery-verification.test-support.ts';
import { loadDeliveryVerification } from './delivery-verification.ts';
import { SWEEP_CATEGORIES } from './design-coverage.ts';
import { designDigest, designFingerprint } from './design-exclusions.ts';
import { run as recordVerdict } from './design-verdict.ts';
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
  actualBase?: string,
): Promise<string | undefined> {
  const loaded = loadDeliveryVerification(fixture.verification, fixture.dependencies);
  const { request } = loaded;
  if (actualBase !== undefined) request.base = actualBase;
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

test('recorded exclusions bind individual adverse findings to the landing base and evidence', async () => {
  const loaded = loadDeliveryVerification(fixture.verification, fixture.dependencies);
  const { request } = loaded;
  const capture = join(directory, 'capture');
  mkdirSync(capture, { recursive: true });
  writeFileSync(join(capture, 'screen.png'), '');
  const rows = 'row | drifted | Existing spacing issue\n';
  const screen =
    'screen | screen.png | wrong | The existing screen has an alignment problem in its heading';
  const ledger = [
    screen,
    ...SWEEP_CATEGORIES.map((category) => `sweep | ${category} | clear | checked`),
  ].join('\n');
  const rowsPath = join(directory, 'rows');
  const ledgerPath = join(directory, 'ledger');
  const exclusionsPath = join(directory, 'exclusions');
  writeFileSync(rowsPath, rows);
  writeFileSync(ledgerPath, ledger);
  const entry = (fingerprint: string) => ({
    fingerprint,
    baselineEvidence: 'base capture and comparison',
    ownerApproval: 'https://linear.app/lost-gradient/issue/COR-2736/example#comment-123',
    issue: 'https://linear.app/lost-gradient/issue/COR-2736/example',
  });
  const attestation = {
    head: request.revision,
    base: request.base,
    verdictDigest: designDigest(rows),
    ledgerDigest: designDigest(ledger),
    exclusions: [
      entry(designFingerprint('verdict', rows.trimEnd())),
      entry(designFingerprint('ledger', screen)),
    ],
  };
  const flags = [
    'record',
    '--head',
    request.revision,
    '--base',
    request.base,
    '--file',
    rowsPath,
    '--ledger',
    ledgerPath,
    '--capture',
    capture,
    '--state-directory',
    loaded.state.stateDirectory,
    '--exclusions',
    exclusionsPath,
  ];
  writeFileSync(exclusionsPath, JSON.stringify(attestation));
  expect(recordVerdict(flags).code).toBe(0);
  expect(await evidence(['components/cinder/src/button.ts'], undefined)).toBeUndefined();
  expect(
    await evidence(
      ['components/cinder/src/button.ts'],
      undefined,
      undefined,
      undefined,
      undefined,
      'd'.repeat(40),
    ),
  ).toContain('invalid or mismatched');
  const recordedLedger = join(
    loaded.state.stateDirectory,
    'design-verdicts',
    `${request.revision}.ledger`,
  );
  writeFileSync(recordedLedger, `${ledger}\nstate | omitted | not captured`);
  expect(await evidence(['components/cinder/src/button.ts'], undefined)).toContain(
    'invalid or mismatched',
  );
  for (const bad of [
    { ...attestation, base: 'd'.repeat(40) },
    { ...attestation, verdictDigest: designDigest('altered') },
    { ...attestation, exclusions: [attestation.exclusions[0], attestation.exclusions[0]] },
    { ...attestation, exclusions: [entry('f'.repeat(64))] },
    {
      ...attestation,
      exclusions: [
        entry(designFingerprint('ledger', screen)),
        { ...entry(designFingerprint('verdict', rows.trimEnd())), issue: 'https://example.com' },
      ],
    },
  ]) {
    writeFileSync(exclusionsPath, JSON.stringify(bad));
    expect(recordVerdict(flags).code).toBe(1);
  }
  writeFileSync(
    exclusionsPath,
    JSON.stringify({ ...attestation, exclusions: [attestation.exclusions[0]] }),
  );
  expect(recordVerdict(flags).code).toBe(0);
  expect(await evidence(['components/cinder/src/button.ts'], undefined)).toContain(
    'screen screen.png: wrong',
  );
  const unsure = screen.replace('| wrong |', '| unsure |');
  const missing = 'state | menu open | not captured';
  const mixedLedger = [
    unsure,
    missing,
    ...SWEEP_CATEGORIES.map((category) => `sweep | ${category} | clear | checked`),
  ].join('\n');
  writeFileSync(ledgerPath, mixedLedger);
  const mixed = {
    ...attestation,
    ledgerDigest: designDigest(mixedLedger),
    exclusions: [attestation.exclusions[0]],
  };
  writeFileSync(exclusionsPath, JSON.stringify(mixed));
  expect(recordVerdict(flags).code).toBe(0);
  expect(await evidence(['components/cinder/src/button.ts'], undefined)).toContain('unsure');
  writeFileSync(
    exclusionsPath,
    JSON.stringify({ ...mixed, exclusions: [entry(designFingerprint('ledger', unsure))] }),
  );
  expect(recordVerdict(flags).code).toBe(1);
  writeFileSync(exclusionsPath, JSON.stringify({ ...mixed, head: 'd'.repeat(40) }));
  expect(recordVerdict(flags).code).toBe(1);
  const foundFirst = 'sweep | proximity | found | Existing heading is distant from its content';
  const foundSecond = 'sweep | proximity | found | A separate action is distant from its group';
  const sweepLedger = [
    screen.replace('| wrong |', '| good |'),
    foundFirst,
    foundSecond,
    ...SWEEP_CATEGORIES.map((category) => `sweep | ${category} | clear | checked`),
  ].join('\n');
  writeFileSync(ledgerPath, sweepLedger);
  writeFileSync(
    exclusionsPath,
    JSON.stringify({
      ...attestation,
      ledgerDigest: designDigest(sweepLedger),
      exclusions: [entry(designFingerprint('ledger', foundFirst)), attestation.exclusions[0]],
    }),
  );
  expect(recordVerdict(flags).code).toBe(0);
  expect(await evidence(['components/cinder/src/button.ts'], undefined)).toContain(
    'sweep proximity: found',
  );
});
