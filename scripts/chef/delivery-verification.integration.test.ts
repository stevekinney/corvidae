import { test as bunTest, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { createDeliveryVerificationFixture } from './delivery-verification.test-support.ts';
import {
  loadDeliveryVerification,
  prepareDeliveryVerification,
  validateDeliveryVerification,
  type DeliveryVerification,
} from './delivery-verification.ts';
import type { VerificationRequest } from './evidence.ts';
import { readExecutionSnapshot } from './execution-state.ts';
import { createScenarios } from './scenario.test-support.ts';
import { digest } from './verification-plan.ts';

const scenarios = createScenarios({}, { test: bunTest, describe: (_name, body) => body() });
function replaceRequest(
  verification: DeliveryVerification,
  request: VerificationRequest,
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
    plan: { ...fixture.request.plan, obligations: [] },
    providerRuns: [],
  });
  const loaded = loadDeliveryVerification(forged, fixture.dependencies);
  let effects = 0;
  expect(
    validateDeliveryVerification(
      loaded,
      { ...fixture.request, route: 'fixture', action: 'merge' },
      {
        ...fixture.dependencies,
        transport: {
          ...fixture.dependencies.transport!,
          run: (id) => {
            effects++;
            return fixture.dependencies.transport!.run(id);
          },
        },
      },
    ),
  ).toContain('approval binding');
  expect(effects).toBe(0);
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
        fixture.assignment,
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
      assignment: {
        identifier: fixture.assignment.identity.identifier,
        digest: fixture.assignment.identity.digest,
      },
      planDigest: digest(JSON.stringify(fixture.request.plan)),
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
    operation.approval.assignment.digest = 'f'.repeat(64);
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

await scenarios.settled();
