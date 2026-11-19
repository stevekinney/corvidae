import { test as bunTest, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { ciEvidenceRequestKey, type CiEvidenceRequest } from './ci-evidence.ts';
import { batchVerificationPlanDigest, type DeliveryRequest } from './delivery-completion.ts';
import { createDeliveryVerificationFixture } from './delivery-verification.test-support.ts';
import {
  loadDeliveryVerification,
  prepareDeliveryVerification,
  validateDeliveryCiEvidence,
  validateDeliveryVerification,
  type DeliveryVerification,
} from './delivery-verification.ts';
import { readExecutionSnapshot } from './execution-state.ts';
import { createScenarios } from './scenario.test-support.ts';
import { digest } from './verification-plan.ts';

const scenarios = createScenarios({}, { test: bunTest, describe: (_name, body) => body() });
function replaceRequest(
  verification: DeliveryVerification,
  request: DeliveryRequest,
): DeliveryVerification {
  const text = JSON.stringify(request);
  writeFileSync(verification.file, text);
  return { ...verification, digest: createHash('sha256').update(text).digest('hex') };
}

scenarios.scenario('uses configured state directory without an injected store', async () => {
  const fixture = await createDeliveryVerificationFixture(undefined, { hostId: hostname() });
  const loaded = loadDeliveryVerification(fixture.verification);
  expect(
    validateDeliveryVerification(
      loaded,
      { ...fixture.request, route: 'fixture', action: 'merge' },
      { transport: fixture.dependencies.transport! },
    ),
  ).toBeUndefined();
});
scenarios.scenario('refuses recomputed empty plan before provider effects', async () => {
  const fixture = await createDeliveryVerificationFixture();
  const forged = replaceRequest(fixture.verification, {
    ...fixture.request,
    members: fixture.request.members.map((member) => ({
      ...member,
      plan: { ...member.plan, obligations: [] },
    })),
  });
  expect(() => loadDeliveryVerification(forged, fixture.dependencies)).toThrow(
    'unverified acceptance criteria',
  );
});
scenarios.scenario('refuses missing, wrong-operation, and wrong-action bindings', async () => {
  const missing = await createDeliveryVerificationFixture(undefined, { approved: false });
  expect(
    validateDeliveryVerification(
      loadDeliveryVerification(missing.verification, missing.dependencies),
      { ...missing.request, route: 'fixture', action: 'merge' },
      missing.dependencies,
    ),
  ).toContain('no coordinator approval');
  const wrongOperation = await createDeliveryVerificationFixture();
  const forged = replaceRequest(wrongOperation.verification, {
    ...wrongOperation.request,
    operationId: 'other-operation',
  });
  expect(
    validateDeliveryVerification(
      loadDeliveryVerification(forged, wrongOperation.dependencies),
      { ...wrongOperation.request, route: 'fixture', action: 'merge' },
      wrongOperation.dependencies,
    ),
  ).toContain('no coordinator approval');
  const wrongAction = await createDeliveryVerificationFixture();
  expect(
    validateDeliveryVerification(
      loadDeliveryVerification(wrongAction.verification, wrongAction.dependencies),
      { ...wrongAction.request, route: 'fixture', action: 'other-action' },
      wrongAction.dependencies,
    ),
  ).toContain('approval binding');
});
scenarios.scenario('refuses approval replacement and accepts approved no-behavior', async () => {
  const fixture = await createDeliveryVerificationFixture();
  expect(
    await throwingRejectionOf(
      prepareDeliveryVerification(
        fixture.verification,
        [fixture.assignment],
        { route: 'fixture', action: 'merge' },
        { state: fixture.state },
      ),
    ),
  ).toThrow('already has delivery approval');
  const noBehavior = await createDeliveryVerificationFixture(undefined, { noBehavior: true });
  expect(
    validateDeliveryVerification(
      loadDeliveryVerification(noBehavior.verification, noBehavior.dependencies),
      { ...noBehavior.request, route: 'fixture', action: 'merge' },
      noBehavior.dependencies,
    ),
  ).toBeUndefined();
});
scenarios.scenario(
  'rejects malformed persisted approval before provider access and preserves its bytes',
  async () => {
    const fixture = await createDeliveryVerificationFixture(undefined, { approved: false });
    const snapshot = readExecutionSnapshot(fixture.state);
    const operation = snapshot.operations[fixture.request.operationId];
    const approval = {
      members: [
        {
          identifier: fixture.assignment.identity.identifier,
          assignmentDigest: fixture.assignment.identity.digest,
          planDigest: digest(JSON.stringify(fixture.request.members[0]!.plan)),
        },
      ],
      requestDigest: fixture.verification.digest,
      repository: fixture.request.repository,
      revision: fixture.request.revision,
      base: fixture.request.base,
      integrationTree: fixture.request.integrationTree,
      route: 'fixture',
      action: 'merge',
    };
    for (const field of Object.keys(approval)) {
      const incomplete = { ...approval };
      Reflect.deleteProperty(incomplete, field);
      const text = JSON.stringify({
        ...snapshot,
        operations: {
          ...snapshot.operations,
          [fixture.request.operationId]: { ...operation, approval: incomplete },
        },
      });
      writeFileSync(fixture.state.statePath, text);
      expect(() => loadDeliveryVerification(fixture.verification, fixture.dependencies)).toThrow(
        'malformed delivery approval',
      );
      expect(readFileSync(fixture.state.statePath, 'utf8')).toBe(text);
    }
  },
);

scenarios.scenario(
  'rejects a persisted approval for another assignment before provider access',
  async () => {
    const fixture = await createDeliveryVerificationFixture();
    const snapshot = readExecutionSnapshot(fixture.state);
    const operation = snapshot.operations[fixture.request.operationId];
    if (operation?.approval === undefined) throw new Error('fixture has no approval');
    operation.approval.members[0]!.assignmentDigest = 'f'.repeat(64);
    writeFileSync(fixture.state.statePath, JSON.stringify(snapshot));
    const transport = fixture.dependencies.transport;
    if (transport === undefined) throw new Error('fixture has no provider transport');
    let effects = 0;
    const dependencies = {
      ...fixture.dependencies,
      transport: {
        ...transport,
        run: (id: number) => {
          effects++;
          return transport.run(id);
        },
      },
    };
    const loaded = loadDeliveryVerification(fixture.verification, dependencies);
    expect(
      validateDeliveryVerification(
        loaded,
        { ...fixture.request, route: 'fixture', action: 'merge' },
        dependencies,
      ),
    ).toContain('approval binding');
    expect(effects).toBe(0);
  },
);

scenarios.scenario(
  'one successful aggregate binds every approved member plan and the jobs they require',
  async () => {
    const fixture = await createDeliveryVerificationFixture(undefined, { approved: false });
    const request = fixture.request;
    const entry = request.members[0]!.providerRuns[0]!;
    entry.workflowPath = '.github/workflows/main.yml';
    entry.workflow = 'Main';
    entry.event = 'workflow_dispatch';
    const second = structuredClone(request.members[0]!);
    second.assignment.identity.identifier = 'COR-2';
    second.assignment.identity.digest = digest(
      JSON.stringify({
        ...second.assignment,
        identity: { ...second.assignment.identity, digest: undefined },
      }),
    );
    second.plan.invalidatedBy.assignment = second.assignment.identity.digest;
    second.plan.obligations[0]!.commandOrProviderJob = 'verify-second';
    Object.assign(second.providerRuns[0]!, {
      obligation: 'AC1:verify-second',
      job: 'verify-second',
    });
    request.members.push(second);
    const planDigest = batchVerificationPlanDigest(request.members);
    expect(batchVerificationPlanDigest(request.members.toReversed())).toBe(planDigest);
    expect(batchVerificationPlanDigest([second])).not.toBe(planDigest);
    const input = {
      repository: request.repository,
      resource: 'fixture',
      base: request.base,
      candidate: request.revision,
      integrationTree: request.integrationTree,
      verificationPlanDigest: planDigest,
      workflow: entry.workflow,
      workflowPath: entry.workflowPath,
      workflowRevision: request.revision,
      event: 'workflow_dispatch',
    } satisfies Omit<CiEvidenceRequest, 'requestKey'>;
    const identity = { ...input, requestKey: ciEvidenceRequestKey(input) };
    const missing = replaceRequest(fixture.verification, request);
    expect(
      await validateDeliveryCiEvidence(loadDeliveryVerification(missing, fixture.dependencies)),
    ).toContain('missing the CI evidence contract');
    const wrongPlan = {
      ...identity,
      verificationPlanDigest: batchVerificationPlanDigest([request.members[0]!]),
    };
    request.ciEvidence = [{ ...wrongPlan, requestKey: ciEvidenceRequestKey(wrongPlan) }];
    const mismatch = replaceRequest(fixture.verification, request);
    expect(
      await validateDeliveryCiEvidence(loadDeliveryVerification(mismatch, fixture.dependencies)),
    ).toContain('missing or ambiguous CI evidence identity');
    request.ciEvidence = [identity];
    const withEvidence = replaceRequest(fixture.verification, request);
    const loaded = loadDeliveryVerification(withEvidence, fixture.dependencies);
    const failed = await validateDeliveryCiEvidence(loaded, {
      ciProvider: {
        async findRuns() {
          return [{ state: 'failed', id: entry.id, attempt: 2 }];
        },
      },
    });
    expect(failed).toContain('successful aggregate');
    const run = {
      id: entry.id,
      attempt: 2,
      repository: request.repository,
      head: request.revision,
      base: request.base,
      integrationTree: request.integrationTree,
      event: entry.event,
      workflow: entry.workflow,
      workflowPath: entry.workflowPath,
      checkedRevision: request.revision,
      checkedTree: request.integrationTree,
      requestKey: identity.requestKey,
      receiptRequestKey: identity.requestKey,
      workflowRevision: identity.workflowRevision,
      verificationPlanDigest: identity.verificationPlanDigest,
      receiptJobs: {},
      jobs: [entry.job, second.providerRuns[0]!.job],
    };
    let authenticatedReads = 0;
    expect(
      await validateDeliveryCiEvidence(loaded, {
        ciProvider: {
          async findRuns() {
            authenticatedReads++;
            return [run];
          },
        },
      }),
    ).toBeUndefined();
    expect(authenticatedReads).toBe(1);
    expect(
      await validateDeliveryCiEvidence(loaded, {
        ciProvider: {
          async findRuns() {
            return [{ ...run, jobs: [entry.job] }];
          },
        },
      }),
    ).toContain('required job');
  },
);

await scenarios.settled();
