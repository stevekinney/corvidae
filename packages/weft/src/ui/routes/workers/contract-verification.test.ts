import { activityContractHash, HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { KNOWN_COMPATIBILITY_REASONS } from '../system/compatibility-verdict.ts';
import {
  CHARGE_HASH,
  CHECKOUT_CONTRACT_HASH,
  matchingCheckout,
  REGISTRY_HASHES,
  registrySnapshot,
  RESERVE_HASH,
  workerManifest,
} from './contract-verification.test-support.ts';
import {
  classifyContractFailure,
  registryActivityContractHashes,
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
      REGISTRY_HASHES,
    );

    expect(result.hasDrift).toBe(false);
    expect(result.workflows).toEqual([
      {
        workflow: 'checkout',
        status: 'matched',
        identityDrift: [],
        activities: [
          {
            name: 'charge',
            status: 'matched',
            workerContractHash: CHARGE_HASH,
            registryContractHash: CHARGE_HASH,
          },
          {
            name: 'reserve',
            status: 'matched',
            workerContractHash: RESERVE_HASH,
            registryContractHash: RESERVE_HASH,
          },
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
    const result = verifyWorkerContracts(
      workerManifest({ checkout: stale }),
      registrySnapshot(),
      REGISTRY_HASHES,
    );

    expect(result.workflows[0]!.status).toBe('drift');
    expect(result.workflows[0]!.identityDrift).toEqual([
      { reason: 'artifact-revision-mismatch', worker: 'rev-1', registry: 'rev-2' },
      { reason: 'workflow-version-incompatible', worker: '1.0.0', registry: '2.0.0' },
      {
        reason: 'contract-hash-mismatch',
        worker: 'sha256:old-checkout-contract',
        registry: CHECKOUT_CONTRACT_HASH,
      },
    ]);
  });

  test('reports missing, extra, and per-activity contract-hash drift', () => {
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
      REGISTRY_HASHES,
    );

    expect(result.hasDrift).toBe(true);
    expect(result.workflows[0]!.identityDrift.map((drift) => drift.reason)).toEqual([
      'contract-hash-mismatch',
    ]);
    expect(result.workflows[0]!.activities).toEqual([
      {
        name: 'charge',
        status: 'mismatched',
        workerContractHash: 'sha256:charge-v2',
        registryContractHash: CHARGE_HASH,
      },
      { name: 'refundCard', status: 'extra', workerContractHash: 'sha256:refund-card' },
      { name: 'reserve', status: 'missing', registryContractHash: RESERVE_HASH },
    ]);
  });

  test('attributes a contract-hash difference to the one activity that changed', () => {
    const workflow = {
      ...matchingCheckout(),
      contractHash: 'sha256:drifted',
      activities: {
        ...matchingCheckout().activities,
        reserve: { contractHash: 'sha256:reserve-v2', implementationRevision: 'impl-2' },
      },
    };
    const result = verifyWorkerContracts(
      workerManifest({ checkout: workflow }),
      registrySnapshot(),
      REGISTRY_HASHES,
    );

    expect(result.workflows[0]!.status).toBe('drift');
    expect(
      result.workflows[0]!.activities.map((activity) => [activity.name, activity.status]),
    ).toEqual([
      ['charge', 'matched'],
      ['reserve', 'mismatched'],
    ]);
  });

  test('an activity hash mismatch is drift even when the workflow identity matches', () => {
    const workflow = {
      ...matchingCheckout(),
      activities: {
        ...matchingCheckout().activities,
        charge: { contractHash: 'sha256:charge-v2', implementationRevision: 'impl-2' },
      },
    };
    const result = verifyWorkerContracts(
      workerManifest({ checkout: workflow }),
      registrySnapshot(),
      REGISTRY_HASHES,
    );

    expect(result.hasDrift).toBe(true);
    expect(result.workflows[0]!.identityDrift).toEqual([]);
    expect(result.workflows[0]!.activities[0]!.status).toBe('mismatched');
  });

  test('missing or extra activities are drift even when the workflow identity matches', () => {
    const workflow = {
      ...matchingCheckout(),
      activities: { charge: matchingCheckout().activities['charge']! },
    };
    const result = verifyWorkerContracts(
      workerManifest({ checkout: workflow }),
      registrySnapshot(),
      REGISTRY_HASHES,
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
      REGISTRY_HASHES,
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

describe('registryActivityContractHashes', () => {
  test('hashes each active revision’s activities with Weft’s canonical activity hasher', async () => {
    const hashes = await registryActivityContractHashes(registrySnapshot());

    expect([...hashes.keys()].toSorted()).toEqual(['checkout', 'refund']);
    expect(Object.fromEntries(hashes.get('checkout')!)).toEqual({
      charge: CHARGE_HASH,
      reserve: RESERVE_HASH,
    });
    expect(hashes.get('refund')!.size).toBe(0);
    // Schema key order does not change the canonical hash.
    const reordered = await activityContractHash({
      outputSchema: { properties: { chargeId: { type: 'string' } }, type: 'object' },
      inputSchema: { properties: { amount: { type: 'number' } }, type: 'object' },
    });
    expect(reordered).toBe(CHARGE_HASH);
    expect(CHARGE_HASH).not.toBe(RESERVE_HASH);
  });

  test('hashes without crypto.subtle, which plain-HTTP dashboards lack, to the same values', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: crypto.getRandomValues.bind(crypto) },
    });
    let hashes: Awaited<ReturnType<typeof registryActivityContractHashes>>;
    try {
      expect(globalThis.crypto.subtle).toBeUndefined();
      hashes = await registryActivityContractHashes(registrySnapshot());
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'crypto');
      else Object.defineProperty(globalThis, 'crypto', original);
    }

    // CHARGE_HASH and RESERVE_HASH came from activityContractHash with SubtleCrypto.
    expect(Object.fromEntries(hashes.get('checkout')!)).toEqual({
      charge: CHARGE_HASH,
      reserve: RESERVE_HASH,
    });
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
      REGISTRY_HASHES,
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
      confirmed: false,
    });
    expect(
      classifyContractFailure('activity result.items[2]: undefined is not valid worker JSON'),
    ).toEqual({
      kind: 'strict-payload',
      path: 'activity result.items[2]',
      message: 'undefined is not valid worker JSON',
      confirmed: false,
    });
    expect(classifyContractFailure('activity result: Map is not a plain JSON object')).toEqual({
      kind: 'strict-payload',
      path: 'activity result',
      message: 'Map is not a plain JSON object',
      confirmed: false,
    });
  });

  test('keeps a quoted key that contains a colon in the rejected path', () => {
    expect(
      classifyContractFailure('activity result["a: b"]: undefined is not valid worker JSON'),
    ).toEqual({
      kind: 'strict-payload',
      path: 'activity result["a: b"]',
      message: 'undefined is not valid worker JSON',
      confirmed: false,
    });
    expect(
      classifyContractFailure('value["x: y"][0]: sparse array slot is not valid worker JSON'),
    ).toEqual({
      kind: 'strict-payload',
      path: 'value["x: y"][0]',
      message: 'sparse array slot is not valid worker JSON',
      confirmed: false,
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
      confirmed: true,
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
      confirmed: true,
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
      confirmed: true,
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
