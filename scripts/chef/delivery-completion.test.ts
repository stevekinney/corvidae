import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectCompletionRecords,
  readDeliveryRequest,
  renderMemberCompletion,
  type DeliveryMember,
  type DeliveryRequest,
} from './delivery-completion.ts';
import type { ProviderEvidenceTransport } from './evidence.ts';
import { createVerificationPlan, digest, type Assignment } from './verification-plan.ts';

function fixture(): { request: DeliveryRequest; transport: ProviderEvidenceTransport } {
  const assignment: Assignment = {
    version: 1,
    identity: {
      identifier: 'COR-1',
      revision: 'issue-revision',
      repository: 'acme/widgets',
      base: 'a'.repeat(40),
      digest: 'b'.repeat(64),
    },
    criteria: [{ id: 'AC1', text: 'Required behavior works.' }],
    ownedPaths: ['documentation/example.md'],
    exclusions: [],
    dependencies: [],
    sourceReferences: [],
    designRows: [],
    deliveryBoundary: 'repository',
    allowedConsequentialActions: ['merge'],
    classification: 'behavior',
  };
  const plan = createVerificationPlan({ assignment, commands: ['verify'], policy: 'fixture' });
  const member: DeliveryMember = {
    assignment,
    plan: {
      ...plan,
      obligations: plan.obligations.map((item) => ({
        ...item,
        phase: 'pre-integration',
        executionBoundary: 'provider',
        relevantInputs: [],
        environmentToolchain: 'linux',
      })),
    },
    providerRuns: [
      {
        id: 7,
        obligation: 'AC1:verify',
        job: 'verify',
        workflow: 'Verify',
        workflowPath: '.github/workflows/main.yml',
        event: 'push',
      },
    ],
    track: true,
    requestedClose: true,
    changes: ['Implemented required behavior.'],
    blockers: [],
  };
  const request: DeliveryRequest = {
    repository: 'acme/widgets',
    revision: 'c'.repeat(40),
    base: 'a'.repeat(40),
    integrationTree: 'd'.repeat(40),
    environment: 'linux',
    authority: { runId: 'run', ownerId: 'owner', resource: 'batch', generation: 1 },
    operationId: 'delivery-1',
    worktree: '/tmp/owned-delivery-fixture',
    members: [member],
  };
  return {
    request,
    transport: {
      run: () => ({
        repository: request.repository,
        revision: request.revision,
        status: 'completed',
        conclusion: 'success',
        workflow: 'Verify',
        workflowPath: '.github/workflows/main.yml',
        event: 'push',
        attempt: 1,
      }),
      job: () => ({
        id: 3,
        name: 'verify',
        status: 'completed',
        conclusion: 'success',
        runtime: 'linux',
        inventory: ['behavior'],
        assertionPassed: true,
      }),
      content: () => ({ integrationTree: request.integrationTree, relevantInputs: [] }),
      artifact: () => ({ present: false, expired: false }),
    },
  };
}

function parse(request: DeliveryRequest): DeliveryRequest {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-contract-'));
  try {
    const text = JSON.stringify(request);
    const file = join(directory, 'request.json');
    writeFileSync(file, text);
    return readDeliveryRequest(file, digest(text));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('missing completion proof leaves only its member open without blocking integration', () => {
  const { request, transport } = fixture();
  const second = structuredClone(request.members[0]!);
  second.assignment.identity.identifier = 'COR-2';
  second.assignment.identity.digest = 'e'.repeat(64);
  second.plan.invalidatedBy.assignment = second.assignment.identity.digest;
  second.plan.obligations[0]!.phase = 'completion';
  second.providerRuns = [];
  request.members.push(second);
  const parsed = parse(request);
  expect(
    collectCompletionRecords(parsed, 'pre-integration', transport).every(
      (record) => record.remainingGates.length === 0,
    ),
  ).toBe(true);
  const [first, pending] = collectCompletionRecords(parsed, 'completion', transport);
  expect(first?.eligible).toBe(true);
  expect(pending?.eligible).toBe(false);
  expect(pending?.remainingGates).toEqual(['AC1:verify has no evidence records']);
  expect(renderMemberCompletion(pending!, 'f'.repeat(40))).toContain('Eligible to close: false');
});

test('an installed archive receipt cannot close a release-bound issue without publication evidence', () => {
  const { request, transport } = fixture();
  const member = request.members[0]!;
  member.plan.obligations[0] = {
    ...member.plan.obligations[0]!,
    commandOrProviderJob: 'verify-publication',
    risk: 'installed-artifacts',
    phase: 'completion',
  };
  member.providerRuns = [];
  const [record] = collectCompletionRecords(parse(request), 'completion', transport);
  expect(record?.eligible).toBe(false);
  expect(record?.remainingGates).toEqual(['AC1:verify-publication has no evidence records']);
});

test('same criterion name cannot reuse another member provider run', () => {
  const { request, transport } = fixture();
  const second = structuredClone(request.members[0]!);
  second.assignment.identity.identifier = 'COR-2';
  second.providerRuns[0]!.id = 8;
  request.members.push(second);
  const result = collectCompletionRecords(parse(request), 'completion', {
    ...transport,
    job: (id, name) => ({
      ...transport.job(id, name),
      conclusion: id === 7 ? 'success' : 'failure',
    }),
  });
  expect(result[0]?.remainingGates).toEqual([]);
  expect(result.map((record) => record.eligible)).toEqual([true, false]);
});

test('a claimed status cannot override authenticated failure or an explicit blocker', () => {
  const { request, transport } = fixture();
  Object.assign(request.members[0]!, { status: 'success', eligible: true, producer: 'ci' });
  const records = collectCompletionRecords(parse(request), 'completion', {
    ...transport,
    job: (id, name) => ({ ...transport.job(id, name), assertionPassed: false }),
  });
  expect(records[0]?.eligible).toBe(false);
  request.members[0]!.blockers = ['Required release is unavailable.'];
  expect(collectCompletionRecords(parse(request), 'completion', transport)[0]?.eligible).toBe(
    false,
  );
});

test('duplicate members, unbound criteria, missing phases and tracking mismatch refuse before collection', () => {
  for (const mutate of [
    (request: DeliveryRequest) => request.members.push(structuredClone(request.members[0]!)),
    (request: DeliveryRequest) => {
      request.members[0]!.plan.obligations[0]!.criterionId = 'OTHER';
    },
    (request: DeliveryRequest) => {
      Reflect.deleteProperty(request.members[0]!.plan.obligations[0]!, 'phase');
    },
    (request: DeliveryRequest) => {
      request.members[0]!.track = false;
    },
  ]) {
    const { request } = fixture();
    mutate(request);
    expect(() => parse(request)).toThrow();
  }
});

test('malformed unmapped completion input refuses before any provider work', () => {
  const { request } = fixture();
  const member = request.members[0]!;
  member.plan.obligations[0]!.phase = 'completion';
  member.plan.obligations[0]!.relevantInputs = ['../outside'];
  member.providerRuns = [];
  expect(() => parse(request)).toThrow('malformed plan obligation');
});
