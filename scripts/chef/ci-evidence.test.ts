import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { zipSync } from 'fflate';
import { join } from 'node:path';
import {
  aggregateCiEvidence,
  ciEvidenceRequestKey,
  createCiEvidenceStore,
  reconcileCiEvidenceRequest,
  type CiEvidenceProvider,
  type CiEvidenceRequest,
} from './ci-evidence.ts';
import { createExecutionStateStore } from './execution-state.ts';
import { collectProviderEvidence, type VerificationRequest } from './evidence.ts';

const scratch = join(process.cwd(), 'tmp/chef/p07-evidence');
mkdirSync(scratch, { recursive: true });
const directories: string[] = [];

function store() {
  const directory = mkdtempSync(join(scratch, 'ci-evidence-'));
  directories.push(directory);
  return createCiEvidenceStore(createExecutionStateStore({ stateDirectory: directory, hostId: 'p07-fixture' }));
}

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
    event: 'workflow_dispatch',
    ...overrides,
  };
  return { ...value, requestKey: ciEvidenceRequestKey(value) };
}

function provider(
  runs: ReturnType<CiEvidenceProvider['findRuns']> extends Promise<infer Value> ? Value : never,
): CiEvidenceProvider & { dispatches: number } {
  return {
    dispatches: 0,
    async findRuns() {
      return runs;
    },
    async dispatch() {
      this.dispatches += 1;
    },
  };
}

test('pins provider request identity, persists intent before dispatch, and reuses its authenticated run', async () => {
  const evidence = store();
  const input = request();
  const run = {
    id: 17,
    repository: input.repository,
    head: input.candidate,
    base: input.base,
    integrationTree: input.integrationTree,
    event: input.event,
    workflow: input.workflow,
    workflowPath: input.workflowPath,
    workflowRevision: input.workflowRevision,
    verificationPlanDigest: input.verificationPlanDigest,
    requestKey: input.requestKey,
    attempt: 2,
    jobs: ['Root checks'],
  };
  const firstProvider = provider([]);
  const first = await reconcileCiEvidenceRequest(evidence, input, firstProvider);
  expect(first).toMatchObject({ state: 'unresolved', requestKey: input.requestKey });
  expect(firstProvider.dispatches).toBe(1);
  const reuseProvider = provider([run]);
  const reused = await reconcileCiEvidenceRequest(evidence, input, reuseProvider);
  expect(reused).toMatchObject({ state: 'bound', run });
  expect(reuseProvider.dispatches).toBe(0);
  expect((await reconcileCiEvidenceRequest(evidence, input, reuseProvider)).state).toBe('bound');
  expect(reuseProvider.dispatches).toBe(0);
});

test('does not dispatch again when an ambiguous response, a forged run, or multiple authenticated runs exist', async () => {
  const input = request();
  const forged = {
    id: 1,
    repository: input.repository,
    head: input.candidate,
    base: input.base,
    integrationTree: input.integrationTree,
    event: input.event,
    workflow: input.workflow,
    workflowPath: input.workflowPath,
    workflowRevision: input.workflowRevision,
    verificationPlanDigest: input.verificationPlanDigest,
    requestKey: 'forged',
    attempt: 1,
    jobs: ['Root checks'],
  };
  const first = provider([forged]);
  const forgedResult = await reconcileCiEvidenceRequest(store(), input, first);
  expect(forgedResult.state).toBe('unresolved');
  expect(first.dispatches).toBe(0);
  const valid = { ...forged, requestKey: input.requestKey };
  const duplicateProvider = provider([valid, { ...valid, id: 2 }]);
  const duplicate = await reconcileCiEvidenceRequest(store(), input, duplicateProvider);
  expect(duplicate.state).toBe('ambiguous');
  expect(duplicateProvider.dispatches).toBe(0);
});

test('keeps a PR event distinct from manual dispatch and requires head, base, and checkout-tree identity', async () => {
  const pullRequest = request({ event: 'pull_request' });
  const run = {
    id: 19,
    repository: pullRequest.repository,
    head: pullRequest.candidate,
    base: pullRequest.base,
    integrationTree: 'x'.repeat(40),
    event: 'workflow_dispatch',
    workflow: pullRequest.workflow,
    workflowPath: pullRequest.workflowPath,
    workflowRevision: pullRequest.workflowRevision,
    verificationPlanDigest: pullRequest.verificationPlanDigest,
    requestKey: pullRequest.requestKey,
    attempt: 1,
    jobs: ['Aggregate evidence'],
  };
  const source = provider([run]);
  const result = await reconcileCiEvidenceRequest(store(), pullRequest, source);
  expect(result.state).toBe('unresolved');
  expect(source.dispatches).toBe(0);
});

test('aggregates collector-issued evidence and rejects missing inventory, artifact proof, and failed jobs', () => {
  const archive = zipSync({
    'reports/root.xml': new TextEncoder().encode(
      '<testsuite><testcase name="ci-evidence.test.ts"/></testsuite>',
    ),
  });
  const missingInventoryArchive = zipSync({
    'reports/root.xml': new TextEncoder().encode('<testsuite><testcase name="other.test.ts"/></testsuite>'),
  });
  const verification: VerificationRequest = {
    repository: 'acme/widgets',
    revision: 'c'.repeat(40),
    base: 'b'.repeat(40),
    integrationTree: 'd'.repeat(40),
    environment: 'linux',
    authority: { runId: 'run', ownerId: 'owner', resource: 'COR-7', generation: 1 },
    operationId: 'p07',
    providerRuns: [
      {
        id: 1,
        obligation: 'AC1:Root checks',
        job: 'Root checks',
        workflow: 'Main',
        workflowPath: '.github/workflows/main.yml',
        event: 'pull_request',
        artifact: 'junit',
      },
    ],
    plan: {
      version: 1,
      obligations: [
        {
          criterionId: 'AC1', risk: 'root-scripts', commandOrProviderJob: 'Root checks',
          expectedInventory: ['ci-evidence.test.ts'], relevantInputs: ['scripts/chef/ci-evidence.ts'],
          environmentToolchain: 'linux', executionBoundary: 'provider', producer: 'P07',
          selectionReason: 'required evidence', evidenceKind: 'test-report',
        },
      ],
      risks: { 'root-scripts': 'covered', 'shared-configuration': 'not-applicable', 'transitive-consumers': 'not-applicable', 'dynamic-entrypoints': 'not-applicable', authorization: 'not-applicable', 'persistence-protocols': 'not-applicable', 'installed-artifacts': 'not-applicable', 'shared-ui-design': 'not-applicable', 'automatic-deployment': 'not-applicable' },
      invalidatedBy: { assignment: 'a', context: 'b', policy: 'c' },
    },
  };
  const transport = (overrides: Record<string, unknown> = {}, report = archive) => ({
    run: () => ({ repository: verification.repository, revision: verification.revision, status: 'completed', conclusion: 'success', workflow: 'Main', workflowPath: '.github/workflows/main.yml', event: 'pull_request', attempt: 1, ...overrides }),
    job: () => ({ id: 1, name: 'Root checks', status: 'completed', conclusion: 'success', runtime: 'linux', inventory: ['ci-evidence.test.ts'], assertionPassed: true }),
    artifact: () => ({ present: true, expired: false, id: 7, digest: `sha256:${createHash('sha256').update(report).digest('hex')}` }),
    downloadArtifact: () => report,
    content: () => ({ integrationTree: verification.integrationTree, relevantInputs: ['scripts/chef/ci-evidence.ts'] }),
  });
  const passed = collectProviderEvidence(verification, transport());
  expect(aggregateCiEvidence(verification.plan, passed, verification).ok).toBe(true);
  const missingInventory = collectProviderEvidence(verification, transport({}, missingInventoryArchive));
  expect(aggregateCiEvidence(verification.plan, missingInventory, verification).ok).toBe(false);
  const uploadFailure = collectProviderEvidence(verification, { ...transport(), artifact: () => ({ present: false, expired: false }) });
  expect(aggregateCiEvidence(verification.plan, uploadFailure, verification).problems.join('\n')).toContain('artifact');
  const failed = collectProviderEvidence(verification, transport({ conclusion: 'failure' }));
  expect(aggregateCiEvidence(verification.plan, failed, verification).ok).toBe(false);
});

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
