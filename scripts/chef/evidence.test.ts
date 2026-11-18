import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectProviderEvidence,
  collectProviderEvidenceFromRequest,
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
  environment: 'workflow',
  plan,
  authority: { runId: 'run', ownerId: 'owner', resource: 'COR-1', generation: 1 },
  operationId: 'operation',
  providerRuns: [{ id: 1, obligation: 'AC1:test', job: 'test' }],
};
const transport = (overrides = {}) => ({
  run: () => ({
    revision: request.revision,
    status: 'completed',
    conclusion: 'success',
    environment: 'workflow',
    ...overrides,
  }),
  job: () => ({ conclusion: 'success', inventory: ['x.test.ts'], assertionPassed: true }),
  artifact: () => ({ present: true }),
});

test('only a collector-issued receipt can validate', () => {
  const collected = collectProviderEvidence(request, transport());
  const expected = {
    revision: request.revision,
    integrationTree: request.integrationTree,
    environment: 'workflow',
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
        return { revision: '', status: '', conclusion: '', environment: '' };
      },
      job: () => ({ conclusion: '', inventory: [], assertionPassed: null }),
      artifact: () => ({ present: false }),
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
