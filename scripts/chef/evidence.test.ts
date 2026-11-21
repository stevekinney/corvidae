import { expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectProviderEvidence,
  collectProviderEvidenceFromRequest,
  compareInstalledReleaseReceipt,
  readVerificationRequest,
  validateEvidence,
  type EvidenceRecord,
} from './evidence.ts';
import type { VerificationPlan } from './verification-plan.ts';

const plan: VerificationPlan = {
  version: 1,
  obligations: [
    {
      criterionId: 'AC1',
      risk: 'root-scripts',
      commandOrProviderJob: 'test',
      expectedInventory: ['x.test.ts'],
      relevantInputs: ['input'],
      environmentToolchain: 'workflow',
      executionBoundary: 'provider',
      producer: 'brief',
      selectionReason: 'test',
      evidenceKind: 'process-exit',
    },
  ],
  risks: {
    'root-scripts': 'covered',
    'shared-configuration': 'not-applicable',
    'transitive-consumers': 'not-applicable',
    'dynamic-entrypoints': 'not-applicable',
    authorization: 'not-applicable',
    'persistence-protocols': 'not-applicable',
    'installed-artifacts': 'not-applicable',
    'shared-ui-design': 'not-applicable',
    'automatic-deployment': 'not-applicable',
  },
  invalidatedBy: { assignment: 'a', context: 'b', policy: 'c' },
};
const request = {
  repository: 'acme/widgets',
  revision: 'a'.repeat(40),
  base: 'c'.repeat(40),
  integrationTree: 'b'.repeat(40),
  environment: 'runner-1',
  plan,
  authority: { runId: 'run', ownerId: 'owner', resource: 'COR-1', generation: 1 },
  operationId: 'operation',
  providerRuns: [
    {
      id: 1,
      obligation: 'AC1:test',
      job: 'test',
      workflow: 'workflow',
      workflowPath: '.github/workflows/main.yml',
      event: 'push',
    },
  ],
};
const transport = (overrides = {}) => ({
  run: () => ({
    repository: request.repository,
    revision: request.revision,
    status: 'completed',
    conclusion: 'success',
    workflow: 'workflow',
    workflowPath: '.github/workflows/main.yml',
    event: 'push',
    attempt: 1,
    ...overrides,
  }),
  job: () => ({
    id: 1,
    name: 'test',
    status: 'completed',
    conclusion: 'success',
    runtime: 'runner-1',
    inventory: ['x.test.ts'],
    assertionPassed: true,
  }),
  artifact: () => ({ present: true, expired: false }),
  content: () => ({
    integrationTree: request.integrationTree,
    relevantInputs: plan.obligations[0]!.relevantInputs,
  }),
});

test('only a collector-issued receipt can validate', () => {
  const collected = collectProviderEvidence(request, transport());
  const expected = {
    revision: request.revision,
    integrationTree: request.integrationTree,
    environment: 'runner-1',
  };
  expect(validateEvidence(plan, collected, expected).ok).toBe(true);
  expect(
    validateEvidence(plan, JSON.parse(JSON.stringify(collected)), expected).problems,
  ).toContain('evidence was not returned by a collector');
  const forged: { source: 'coordinator'; records: EvidenceRecord[] } = {
    source: 'coordinator',
    records: collected.records,
  };
  expect(validateEvidence(plan, forged, expected).ok).toBe(false);
});

test('compares an installed-release receipt with its archive and configuration obligation', () => {
  const expected = {
    sourceRevision: 'a'.repeat(40),
    target: 'darwin-arm64' as const,
    archiveDigest: 'b'.repeat(64),
    configuration: [{ path: 'bun.lock', sha256: 'c'.repeat(64) }],
  };
  const receipt = {
    version: 1,
    outcome: 'pass',
    archive: {
      sha256: expected.archiveDigest,
      target: expected.target,
      manifest: { sourceSha: expected.sourceRevision },
    },
    installedExecutable: 'interborough/bin/interborough',
    assertions: [{ exit: 0 }],
    configuration: expected.configuration,
    producer: { script: 'applications/interborough/scripts/test-installed-release.ts' },
  };
  expect(compareInstalledReleaseReceipt(receipt, expected)).toEqual([]);
  expect(
    compareInstalledReleaseReceipt(
      { ...receipt, archive: { ...receipt.archive, target: 'linux-x64' } },
      expected,
    ),
  ).toEqual(expect.arrayContaining([expect.stringContaining('target does not match')]));
  expect(compareInstalledReleaseReceipt({ ...receipt, configuration: [] }, expected)).toEqual(
    expect.arrayContaining([expect.stringContaining('configuration identity')]),
  );
});

test('provider results remain derived from authenticated transport, not request claims', () => {
  const directory = mkdtempSync(join(tmpdir(), 'evidence-request-'));
  const path = join(directory, 'request.json');
  const text = JSON.stringify({
    ...request,
    producer: 'ci',
    status: 'pass',
    url: 'https://forged.test',
  });
  writeFileSync(path, text);
  const parsed = readVerificationRequest(path, createHash('sha256').update(text).digest('hex'));
  expect(
    collectProviderEvidence(parsed, transport({ conclusion: 'failure' })).records[0]?.status,
  ).toBe('fail');
});

test('test obligations require structured proof and terminal job states are classified first', () => {
  const testRequest = {
    ...request,
    plan: {
      ...plan,
      obligations: [{ ...plan.obligations[0]!, evidenceKind: 'test-report' as const }],
    },
  };
  const unknownAssertion = {
    ...transport(),
    job: () => ({ ...transport().job(), assertionPassed: null }),
  };
  expect(collectProviderEvidence(testRequest, unknownAssertion).records[0]?.status).toBe('pending');
  const skippedJob = {
    ...transport(),
    job: () => ({ ...transport().job(), conclusion: 'skipped' }),
  };
  expect(collectProviderEvidence(testRequest, skippedJob).records[0]?.status).toBe('skipped');
});

test('programmatic provider collectors reject unsafe inputs before any read', () => {
  const unsafeRequest = {
    ...request,
    plan: { ...plan, obligations: [{ ...plan.obligations[0]!, relevantInputs: ['../outside'] }] },
  };
  let reads = 0;
  const guarded = {
    ...transport(),
    run: () => {
      reads += 1;
      return transport().run();
    },
  };
  expect(() => collectProviderEvidence(unsafeRequest, guarded)).toThrow();
  expect(reads).toBe(0);
});

test('provider archive identity remains part of ordinary validation', () => {
  const archive = zipSync({
    'results/report.xml': new TextEncoder().encode(
      '<testsuite><testcase name="x.test.ts"/></testsuite>',
    ),
  });
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  const artifactRequest = {
    ...request,
    providerRuns: [{ ...request.providerRuns[0]!, artifact: 'junit' }],
  };
  const collected = collectProviderEvidence(artifactRequest, {
    ...transport(),
    artifact: () => ({ present: true, expired: false, id: 4, digest }),
    downloadArtifact: () => archive,
  });
  const expected = {
    revision: request.revision,
    integrationTree: request.integrationTree,
    environment: 'runner-1',
  };
  expect(validateEvidence(plan, collected, expected).ok).toBe(true);
  collected.records[0]!.provider!.artifact!.expired = true;
  expect(validateEvidence(plan, collected, expected).ok).toBe(false);
});

// spawn-free: the injected transport proves malformed input prevents provider access.
test('malformed provider requests fail before authenticated access', () => {
  const directory = mkdtempSync(join(tmpdir(), 'evidence-invalid-'));
  const path = join(directory, 'request.json');
  const text = JSON.stringify({
    ...request,
    providerRuns: [{ id: 1, obligation: 'unknown', job: 'test' }],
  });
  writeFileSync(path, text);
  let reads = 0;
  expect(() =>
    collectProviderEvidenceFromRequest(path, createHash('sha256').update(text).digest('hex'), {
      run: () => {
        reads += 1;
        return {
          repository: '',
          revision: '',
          status: '',
          conclusion: '',
          workflow: '',
          workflowPath: '',
          event: '',
          attempt: 0,
        };
      },
      job: () => ({
        id: 0,
        name: '',
        status: '',
        conclusion: '',
        runtime: '',
        inventory: [],
        assertionPassed: null,
      }),
      artifact: () => ({ present: false, expired: false }),
      content: () => ({ integrationTree: '', relevantInputs: [] }),
    }),
  ).toThrow();
  expect(reads).toBe(0);
});

test('a NUL command is rejected while parsing the pinned request', () => {
  const directory = mkdtempSync(join(tmpdir(), 'evidence-nul-'));
  const path = join(directory, 'request.json');
  const text = JSON.stringify({
    ...request,
    plan: {
      ...plan,
      obligations: [
        {
          ...plan.obligations[0]!,
          executionBoundary: 'coordinator',
          commandOrProviderJob: 'bun\u0000 test',
        },
      ],
    },
    providerRuns: [],
  });
  writeFileSync(path, text);
  expect(() =>
    readVerificationRequest(path, createHash('sha256').update(text).digest('hex')),
  ).toThrow();
});
