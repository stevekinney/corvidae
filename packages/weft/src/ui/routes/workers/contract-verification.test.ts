import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { KNOWN_COMPATIBILITY_REASONS } from '../system/compatibility-verdict.ts';
import {
  matchingCheckout,
  registrySnapshot,
  workerManifest,
} from './contract-verification.test-support.ts';
import {
  classifyContractFailure,
  verificationCommands,
  verificationFault,
  verifyRegistryWorkflow,
  verifyWorkerContracts,
  WORKFLOW_IDENTITY_REASONS,
} from './contract-verification.ts';
import { MalformedWorkerDiagnosticsError } from './worker-manifest-diagnostics.ts';

describe('verifyWorkerContracts', () => {
  test('a manifest that matches the active revision verifies every activity', () => {
    const result = verifyWorkerContracts(
      workerManifest({ checkout: matchingCheckout() }),
      registrySnapshot(),
    );

    expect(result.hasDrift).toBe(false);
    expect(result.workflows).toEqual([
      {
        workflow: 'checkout',
        status: 'matched',
        identityDrift: [],
        activities: [
          { name: 'charge', status: 'matched', workerContractHash: 'sha256:charge' },
          { name: 'reserve', status: 'matched', workerContractHash: 'sha256:reserve' },
        ],
      },
    ]);
    // A registry workflow the worker does not serve is kept apart from drift.
    expect(result.notAdvertised).toEqual(['refund']);
  });

  test('compares against the active revision, not an older installed one', () => {
    const stale = {
      ...matchingCheckout(),
      workflowVersion: '1.0.0',
      workflowRevision: 'rev-1',
      contractHash: 'sha256:old-checkout-contract',
    };
    const result = verifyWorkerContracts(workerManifest({ checkout: stale }), registrySnapshot());

    expect(result.workflows[0]!.status).toBe('drift');
    expect(result.workflows[0]!.identityDrift).toEqual([
      { reason: 'artifact-revision-mismatch', worker: 'rev-1', registry: 'rev-2' },
      { reason: 'workflow-version-incompatible', worker: '1.0.0', registry: '2.0.0' },
      {
        reason: 'contract-hash-mismatch',
        worker: 'sha256:old-checkout-contract',
        registry: 'sha256:checkout-contract',
      },
    ]);
  });

  test('reports missing and extra activities, and leaves shared ones unconfirmed when the contract hash differs', () => {
    const workflow = {
      ...matchingCheckout(),
      contractHash: 'sha256:drifted',
      activities: {
        charge: { contractHash: 'sha256:charge-v2', implementationRevision: 'impl-2' },
        refundCard: { contractHash: 'sha256:refund-card', implementationRevision: 'impl-1' },
      },
    };
    const result = verifyWorkerContracts(
      workerManifest({ checkout: workflow }),
      registrySnapshot(),
    );

    expect(result.hasDrift).toBe(true);
    expect(result.workflows[0]!.identityDrift.map((drift) => drift.reason)).toEqual([
      'contract-hash-mismatch',
    ]);
    expect(result.workflows[0]!.activities).toEqual([
      { name: 'charge', status: 'unconfirmed', workerContractHash: 'sha256:charge-v2' },
      { name: 'refundCard', status: 'extra', workerContractHash: 'sha256:refund-card' },
      { name: 'reserve', status: 'missing' },
    ]);
  });

  test('missing or extra activities are drift even when the workflow identity matches', () => {
    const workflow = {
      ...matchingCheckout(),
      activities: { charge: matchingCheckout().activities['charge']! },
    };
    const result = verifyWorkerContracts(
      workerManifest({ checkout: workflow }),
      registrySnapshot(),
    );

    expect(result.workflows[0]!.status).toBe('drift');
    expect(result.workflows[0]!.identityDrift).toEqual([]);
    expect(result.workflows[0]!.activities.map((activity) => activity.status)).toEqual([
      'matched',
      'missing',
    ]);
  });

  test('a workflow with no active registry revision is extra, with every activity extra', () => {
    const result = verifyWorkerContracts(
      workerManifest({
        ghost: {
          workflowVersion: '0.0.0',
          workflowRevision: 'ghost-rev',
          contractHash: 'sha256:ghost',
          activities: { haunt: { contractHash: 'sha256:haunt', implementationRevision: 'i' } },
        },
      }),
      registrySnapshot(),
    );

    expect(result.hasDrift).toBe(true);
    expect(result.workflows).toEqual([
      {
        workflow: 'ghost',
        status: 'extra',
        identityDrift: [],
        activities: [{ name: 'haunt', status: 'extra', workerContractHash: 'sha256:haunt' }],
      },
    ]);
    expect(result.notAdvertised).toEqual(['checkout', 'refund']);
  });

  test('identity reasons are members of the compatibility vocabulary, in the CLI order', () => {
    for (const reason of WORKFLOW_IDENTITY_REASONS) {
      expect(KNOWN_COMPATIBILITY_REASONS).toContain(reason);
    }
    expect(WORKFLOW_IDENTITY_REASONS).toEqual([
      'artifact-revision-mismatch',
      'workflow-version-incompatible',
      'contract-hash-mismatch',
    ]);
  });
});

describe('verifyRegistryWorkflow', () => {
  test('verifies every worker that serves the workflow and counts the rest', () => {
    const drifted = { ...matchingCheckout(), workflowRevision: 'rev-9' };
    const result = verifyRegistryWorkflow(
      'checkout',
      [
        workerManifest({ checkout: drifted }, { workerId: 'worker-b' }),
        workerManifest({ checkout: matchingCheckout() }, { workerId: 'worker-a' }),
        workerManifest({}, { workerId: 'worker-c' }),
      ],
      registrySnapshot(),
    );

    expect(result.workers.map((entry) => [entry.workerId, entry.verification.status])).toEqual([
      ['worker-a', 'matched'],
      ['worker-b', 'drift'],
    ]);
    expect(result.workersNotAdvertising).toBe(1);
  });
});

describe('verificationCommands', () => {
  test('substitutes the manifest and registry file names the dashboard knows', () => {
    expect(
      verificationCommands({
        deploymentName: 'payments api',
        buildId: 'build/7',
        registryVersion: 2,
      }),
    ).toEqual({
      registryFile: 'registry-v2.json',
      manifestFile: 'payments-api-build-7.manifest.json',
      codegen: 'weft codegen --from registry-v2.json --out weft-registry.d.ts',
      workerVerify:
        'weft worker verify --manifest payments-api-build-7.manifest.json --from registry-v2.json',
    });
  });

  test('falls back to placeholder file names when nothing is known', () => {
    const commands = verificationCommands({});
    expect(commands.codegen).toBe('weft codegen --from registry.json --out weft-registry.d.ts');
    expect(commands.workerVerify).toBe(
      'weft worker verify --manifest worker-manifest.json --from registry.json',
    );
  });
});

describe('classifyContractFailure', () => {
  test('recognizes a failed task error string from the strict payload boundary', () => {
    expect(classifyContractFailure('activity result.total: number must be finite')).toEqual({
      kind: 'strict-payload',
      path: 'activity result.total',
      message: 'number must be finite',
    });
    expect(
      classifyContractFailure('activity result.items[2]: undefined is not valid worker JSON'),
    ).toEqual({
      kind: 'strict-payload',
      path: 'activity result.items[2]',
      message: 'undefined is not valid worker JSON',
    });
    expect(classifyContractFailure('activity result: Map is not a plain JSON object')).toEqual({
      kind: 'strict-payload',
      path: 'activity result',
      message: 'Map is not a plain JSON object',
    });
  });

  test('recognizes a WorkerJsonValidationError-shaped error by name and path', () => {
    const error = Object.assign(new TypeError('details.at: symbol is not valid worker JSON'), {
      name: 'WorkerJsonValidationError',
      path: 'details.at',
    });
    expect(classifyContractFailure(error)).toEqual({
      kind: 'strict-payload',
      path: 'details.at',
      message: 'symbol is not valid worker JSON',
    });
    expect(
      classifyContractFailure({
        name: 'WorkerJsonValidationError',
        path: 'value',
        message: 'value: BigInt is not valid worker JSON',
      }),
    ).toEqual({
      kind: 'strict-payload',
      path: 'value',
      message: 'BigInt is not valid worker JSON',
    });
  });

  test('recognizes a strict payload rejection carried in a server fault payload', () => {
    const error = new HttpClientError(422, 'Unprocessable', {
      faultCode: 'Unprocessable',
      data: {
        name: 'WorkerJsonValidationError',
        path: 'activity result.when',
        message: 'activity result.when: function is not valid worker JSON',
      },
    });
    expect(classifyContractFailure(error)).toEqual({
      kind: 'strict-payload',
      path: 'activity result.when',
      message: 'function is not valid worker JSON',
    });
  });

  test('a contract mismatch is classified apart from a strict payload rejection', () => {
    const error = new HttpClientError(409, 'Conflict', {
      faultCode: 'Conflict',
      data: { compatibilityReasons: ['contract-hash-mismatch'] },
    });
    expect(classifyContractFailure(error)).toEqual({
      kind: 'contract-mismatch',
      reasons: ['contract-hash-mismatch'],
    });
  });

  test('leaves unrelated failures alone', () => {
    expect(classifyContractFailure('seeded inventory outage')).toBeUndefined();
    expect(classifyContractFailure(new Error('boom'))).toBeUndefined();
    expect(classifyContractFailure(new HttpClientError(500, 'Internal'))).toBeUndefined();
    expect(classifyContractFailure(null)).toBeUndefined();
  });
});

describe('verificationFault', () => {
  test('distinguishes contract, malformed, permission-denied, and server faults', () => {
    expect(verificationFault(new Error('activity result.a: number must be finite')).kind).toBe(
      'contract',
    );
    expect(verificationFault(new MalformedWorkerDiagnosticsError('response.worker')).kind).toBe(
      'malformed',
    );
    expect(
      verificationFault(new HttpClientError(403, 'Forbidden', { faultCode: 'Forbidden' })).kind,
    ).toBe('permission-denied');
    expect(verificationFault(new HttpClientError(500, 'Internal server error'))).toEqual({
      kind: 'server',
      title: 'Something went wrong',
      message: 'Internal server error',
    });
  });
});
