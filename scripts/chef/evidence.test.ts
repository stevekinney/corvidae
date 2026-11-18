import { describe, expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectLocalEvidence,
  collectLocalEvidenceFromRequest,
  collectProviderEvidence,
  collectProviderEvidenceFromRequest,
  readVerificationRequest,
  validateEvidence,
  type CollectedEvidence,
  type EvidenceRecord,
} from './evidence.ts';
import type { VerificationPlan } from './verification-plan.ts';

const plan: VerificationPlan = {
  version: 1,
  obligations: [
    {
      criterionId: 'AC1',
      risk: 'root-scripts',
      commandOrProviderJob: 'bun test x',
      expectedInventory: ['x.test.ts'],
      relevantInputs: ['input'],
      environmentToolchain: 'Bun',
      executionBoundary: 'coordinator',
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

const record = (overrides: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  obligation: 'AC1:bun test x',
  status: 'pass',
  revision: 'a'.repeat(40),
  integrationTree: 'b'.repeat(40),
  environment: 'Bun',
  command: 'bun test x',
  relevantInputs: ['input'],
  inventory: ['x.test.ts'],
  exitCode: 0,
  assertionPassed: true,
  ...overrides,
});
const collected = (entry = record()): CollectedEvidence => ({
  source: 'coordinator',
  records: [entry],
});
const expected = { revision: 'a'.repeat(40), integrationTree: 'b'.repeat(40), environment: 'Bun' };

describe('validateEvidence', () => {
  test('accepts a matching coordinator-collected pass and a valid reuse', () => {
    expect(validateEvidence(plan, collected(), expected).ok).toBe(true);
    expect(validateEvidence(plan, collected(record({ status: 'reused-pass' })), expected).ok).toBe(
      true,
    );
  });

  test.each(['fail', 'pending', 'canceled', 'skipped'] as const)('refuses %s results', (status) => {
    expect(validateEvidence(plan, collected(record({ status })), expected).ok).toBe(false);
  });

  test('refuses a tampered result even when its process exit says success', () => {
    const result = validateEvidence(plan, collected(record({ assertionPassed: false })), expected);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('AC1:bun test x has a failed structured assertion');
  });

  test('refuses wrong identity, empty inventory, and dirty evidence labelled as a clean head', () => {
    const result = validateEvidence(
      plan,
      collected(
        record({
          revision: 'c'.repeat(40),
          integrationTree: 'd'.repeat(40),
          inventory: [],
          dirtyContentIdentity: 'dirty',
        }),
      ),
      expected,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('different integration tree');
    expect(result.problems.join('\n')).toContain('unexpectedly discovered no tests or jobs');
  });
});

test('collectors derive outcomes from provider and process boundaries, not input result claims', () => {
  const providerPlan = {
    ...plan,
    obligations: [{ ...plan.obligations[0]!, executionBoundary: 'provider' as const }],
  };
  const request = {
    repository: 'acme/widgets',
    revision: 'a'.repeat(40),
    base: 'c'.repeat(40),
    integrationTree: 'b'.repeat(40),
    environment: 'Bun',
    plan: providerPlan,
    authority: { runId: 'run', ownerId: 'owner', resource: 'COR-1', generation: 1 },
    operationId: 'operation',
    providerRuns: [{ id: 1, obligation: 'AC1:bun test x', job: 'test' }],
  };
  const directory = mkdtempSync(join(tmpdir(), 'evidence-'));
  const path = join(directory, 'request.json');
  const text = JSON.stringify({
    ...request,
    producer: 'ci',
    status: 'pass',
    url: 'https://forged.test',
  });
  writeFileSync(path, text);
  const parsed = readVerificationRequest(path, createHash('sha256').update(text).digest('hex'));
  const provider = collectProviderEvidence(parsed, {
    run: () => ({
      revision: request.revision,
      status: 'completed',
      conclusion: 'failure',
      environment: 'Bun',
    }),
    job: () => ({ conclusion: 'success', inventory: ['x.test.ts'], assertionPassed: true }),
    artifact: () => ({ present: true }),
  });
  expect(provider.records[0]?.status).toBe('fail');
  const local = collectLocalEvidence(
    { ...parsed, plan, providerRuns: [] },
    { run: () => ({ exitCode: 0, inventory: ['x.test.ts'], assertionPassed: false }) },
    directory,
  );
  expect(local.records[0]?.status).toBe('fail');
});

test('rejects unknown, duplicate, traversal, and malformed commands before collector access', () => {
  const directory = mkdtempSync(join(tmpdir(), 'evidence-invalid-'));
  const path = join(directory, 'request.json');
  const base = {
    repository: 'acme/widgets',
    revision: 'a'.repeat(40),
    base: 'c'.repeat(40),
    integrationTree: 'b'.repeat(40),
    environment: 'Bun',
    plan: {
      ...plan,
      obligations: [{ ...plan.obligations[0]!, executionBoundary: 'provider' as const }],
    },
    authority: { runId: 'run', ownerId: 'owner', resource: 'COR-1', generation: 1 },
    operationId: 'operation',
  };
  const attempts = [
    [{ id: 1, obligation: 'unknown', job: 'test' }],
    [{ id: 1, obligation: 'AC1:bun test x', job: 'test', artifact: '../../x' }],
    [
      { id: 1, obligation: 'AC1:bun test x', job: 'test' },
      { id: 2, obligation: 'AC1:bun test x', job: 'test' },
    ],
  ];
  let calls = 0;
  const transport = {
    run: () => {
      calls += 1;
      return { revision: '', status: '', conclusion: '', environment: '' };
    },
    job: () => {
      calls += 1;
      return { conclusion: '', inventory: [], assertionPassed: null };
    },
    artifact: () => {
      calls += 1;
      return { present: false };
    },
  };
  const process = {
    run: () => {
      calls += 1;
      return { exitCode: 1, inventory: [], assertionPassed: null };
    },
  };
  for (const providerRuns of attempts) {
    const text = JSON.stringify({ ...base, providerRuns });
    writeFileSync(path, text);
    const digest = createHash('sha256').update(text).digest('hex');
    expect(() => collectProviderEvidenceFromRequest(path, digest, transport)).toThrow();
    expect(() => collectLocalEvidenceFromRequest(path, digest, process, directory)).toThrow();
  }
  expect(calls).toBe(0);
});

test('local collection rejects a NUL argv before starting its process and executes a valid request', () => {
  const directory = mkdtempSync(join(tmpdir(), 'evidence-local-'));
  const path = join(directory, 'request.json');
  const base = {
    repository: 'acme/widgets',
    revision: 'a'.repeat(40),
    base: 'c'.repeat(40),
    integrationTree: 'b'.repeat(40),
    environment: 'Bun',
    authority: { runId: 'run', ownerId: 'owner', resource: 'COR-1', generation: 1 },
    operationId: 'operation',
    providerRuns: [],
  };
  let calls = 0;
  const process = {
    run: () => {
      calls += 1;
      return { exitCode: 0, inventory: ['x.test.ts'], assertionPassed: true };
    },
  };
  const malformed = JSON.stringify({
    ...base,
    plan: {
      ...plan,
      obligations: [{ ...plan.obligations[0]!, commandOrProviderJob: 'bun\u0000 test' }],
    },
  });
  writeFileSync(path, malformed);
  expect(() =>
    collectLocalEvidenceFromRequest(
      path,
      createHash('sha256').update(malformed).digest('hex'),
      process,
      directory,
    ),
  ).toThrow();
  expect(calls).toBe(0);
  const valid = JSON.stringify({ ...base, plan });
  writeFileSync(path, valid);
  expect(
    collectLocalEvidenceFromRequest(
      path,
      createHash('sha256').update(valid).digest('hex'),
      process,
      directory,
    ).records[0]?.status,
  ).toBe('pass');
  expect(calls).toBe(1);
});

test('provider collector treats corrupt JUnit artifacts as pending and failed JUnit assertions as failures', () => {
  const providerPlan = {
    ...plan,
    obligations: [{ ...plan.obligations[0]!, executionBoundary: 'provider' as const }],
  };
  const request = {
    repository: 'acme/widgets',
    revision: 'a'.repeat(40),
    base: 'c'.repeat(40),
    integrationTree: 'b'.repeat(40),
    environment: 'workflow',
    plan: providerPlan,
    authority: { runId: 'run', ownerId: 'owner', resource: 'COR-1', generation: 1 },
    operationId: 'operation',
    providerRuns: [{ id: 1, obligation: 'AC1:bun test x', job: 'test', artifact: 'junit' }],
  };
  const archive = (xml: string) => zipSync({ 'report.xml': new TextEncoder().encode(xml) });
  const transport = (xml: string) => ({
    run: () => ({
      revision: request.revision,
      status: 'completed',
      conclusion: 'success',
      environment: 'workflow',
    }),
    job: () => ({ conclusion: 'success', inventory: ['test'], assertionPassed: null }),
    artifact: () => ({ present: true, id: 2 }),
    downloadArtifact: () => archive(xml),
  });
  expect(
    collectProviderEvidence(
      request,
      transport('<testsuite><testcase name="x">\uffff</testcase></testsuite>'),
    ).records[0]?.status,
  ).toBe('pending');
  expect(
    collectProviderEvidence(
      request,
      transport('<testsuite><testcase name="x"><failure /></testcase></testsuite>'),
    ).records[0]?.status,
  ).toBe('fail');
});
