import {
  WORKSPACE_CONFORMANCE_GROUPS,
  WORKSPACE_MOUNT_CONFORMANCE,
  WORKSPACE_EXPECTED_OUTCOMES,
} from './workspace-conformance.test-support.ts';
import {
  workspaceConformanceLedger,
  workspaceMountLedger,
} from './workspace-conformance-ledger.test-support.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyAuthentication,
  workspacePrivacyCall,
  WORKSPACE_PRIVATE_READ_CASES,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';
import { describe, expect, test } from 'bun:test';
import { principalFromApiKey, type WorkspaceIdentity } from '@lostgradient/weft';

import { BUREAU_HANDLER_OPERATIONS, createBureauHandler } from './create-bureau-handler.ts';
import { OPERATION_MAP } from './operation-map.ts';
import { waitForCondition } from '../test';
import {
  workspaceProjectionFields,
  WORKSPACE_PROJECTION_CONFORMANCE,
  WORKSPACE_CROSS_PRODUCERS,
} from './workspace-projection-schema.test-support.ts';

const membership: WorkspaceIdentity = {
  version: 1,
  workspaceId: 'workspace-a',
  actorId: 'alice',
  actorKind: 'user',
  owner: 'workspace-a:alice',
  membershipRevision: 'membership-1',
  capabilities: ['workspace:use'],
};

const credential = principalFromApiKey({ subject: 'alice', scopes: [] });
const witnesses = workspaceConformanceLedger('workspace-privacy.test.ts');
const mountWitnesses = workspaceMountLedger('workspace-privacy.test.ts');

test('task read projections keep private failure details with their owner', async () => {
  const sentinel = 'PRIVATE-TASK-ERROR-a02f';
  const opened = await openWorkspacePrivacyBureau({
    generate: async () => {
      throw new Error(sentinel);
    },
  });
  try {
    const task = await opened.bureau.tasks.start('default', 'private input', {
      principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
    });
    await waitForCondition(async () => {
      const recorded = await opened.bureau.tasks.get(task.id);
      return recorded?.status === 'failed';
    }, 'task fails');
    for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
      for (const operation of ['bureau.tasks.get', 'bureau.tasks.list'] as const) {
        const response = await workspacePrivacyCall(
          opened,
          actor,
          operation,
          operation === 'bureau.tasks.list' ? {} : { taskId: task.id },
        );
        witnesses.observePrivateProjection(operation, actor, response);
        if (actor === 'owner') expect(response.text).toContain(sentinel);
        else if (actor === 'foreign' || actor === 'removed') expect(response.status).toBe(403);
        else if (operation === 'bureau.tasks.list')
          expect(response.body?.result?.['tasks']).toEqual([]);
        else expect(response.body?.error?.data?.httpStatus).toBe(404);
      }
    }
  } finally {
    await opened.dispose();
  }
});

test('every live output and event projection retains its field inventory', async () => {
  const audited: Record<string, string[]> = await Bun.file(
    new URL('./workspace-projection-fields.json', import.meta.url),
  ).json();
  expect(workspaceProjectionFields()).toEqual(audited);
  const producers = Object.keys(WORKSPACE_PROJECTION_CONFORMANCE);
  expect(
    producers.filter((key) => key.startsWith('output:') || key.startsWith('event:')).toSorted(),
  ).toEqual(Object.keys(audited).toSorted());
  expect(producers.filter((key) => key.startsWith('mount:')).toSorted()).toEqual(
    Object.values(WORKSPACE_MOUNT_CONFORMANCE)
      .map(({ key }) => `mount:${key}`)
      .toSorted(),
  );
  for (const row of Object.values(WORKSPACE_PROJECTION_CONFORMANCE)) {
    expect(row.fixture.length).toBeGreaterThan(0);
    if (row.evidence.mode === 'cross-producer' || row.evidence.mode === 'owner-positive')
      expect(row.sentinel.length).toBeGreaterThan(0);
    if (row.evidence.mode === 'denied' || row.evidence.mode === 'schema-safe')
      expect(row.evidence.reason.length).toBeGreaterThan(0);
    expect(await Bun.file(new URL(row.testFile, import.meta.url)).exists()).toBe(true);
  }
  expect(
    Object.entries(WORKSPACE_PROJECTION_CONFORMANCE)
      .filter(([, row]) => row.evidence.mode === 'unclassified')
      .map(([key]) => key),
  ).toEqual([]);
  for (const [key, row] of Object.entries(WORKSPACE_PROJECTION_CONFORMANCE))
    if (key.startsWith('output:') && row.evidence.mode === 'schema-safe')
      expect(audited[key]?.filter((path) => path.endsWith('.*'))).toEqual([]);
  for (const operation of WORKSPACE_CROSS_PRODUCERS) {
    const policy = Object.entries(OPERATION_MAP).find(([name]) => name === operation)?.[1];
    if (policy === undefined) throw new Error(`Missing policy for ${operation}`);
    expect(['member-shared-read', 'administrator-shared']).toContain(policy.workspaceClass);
  }
});

test('the witness ledger refuses an unexecuted actor and an unclassified operation', () => {
  const ledger = workspaceConformanceLedger('workspace-privacy.test.ts');
  ledger.observeWire('bureau.tasks.get', 'owner', {
    status: 200,
    body: {},
    transport: 'jsonRpcHttp',
  });
  expect(() => ledger.verify()).toThrow('bureau.tasks.get:peer');
  expect(() =>
    ledger.observeWire('bureau.tasks.get', 'foreign', {
      status: 403,
      text: 'Forbidden',
      transport: 'jsonRpcHttp',
    }),
  ).toThrow('Wrong outcome');
  ledger.observeWire('bureau.tasks.get', 'foreign', {
    status: 403,
    text: 'Workspace membership required',
    transport: 'jsonRpcHttp',
  });
  expect(() =>
    ledger.observeWire('bureau.not.registered', 'owner', {
      status: 200,
      body: {},
      transport: 'jsonRpcHttp',
    }),
  ).toThrow('No expected outcome');
});

test('metadata evidence requires the owner and an explicitly private source producer', () => {
  const ledger = workspaceConformanceLedger('workspace-discovery-privacy.test.ts');
  const response = {
    status: 200,
    text: 'PRIVATE-DISCOVERY-INPUT-1bdd',
    actor: 'peer',
    operation: 'bureau.contexts.get',
  };
  expect(() => ledger.confirmPrivateSource('bureau.deployment.get', response)).toThrow(
    'Invalid private source',
  );
  expect(() =>
    ledger.confirmPrivateSource('bureau.deployment.get', {
      ...response,
      actor: 'owner',
      operation: 'bureau.deployment.get',
    }),
  ).toThrow('Invalid private source');
  ledger.confirmPrivateSource('bureau.deployment.get', { ...response, actor: 'owner' });
});

test('every live operation has one explicit resource fixture and six-actor expectation row', async () => {
  const rows = WORKSPACE_CONFORMANCE_GROUPS.flatMap((group) =>
    group.operations.map(([name, outcome]) => ({ name, outcome, group })),
  );
  expect(BUREAU_HANDLER_OPERATIONS.map((operation) => operation.name).toSorted()).toEqual(
    rows.map((row) => row.name).toSorted(),
  );
  const opened = await openWorkspacePrivacyBureau({ a2aAgents: ['default'] });
  try {
    let calls = 0;
    const contributed = WORKSPACE_MOUNT_CONFORMANCE.contributed;
    const handler = createBureauHandler(opened.bureau, {
      workspace: opened.bureau.workspaceBinding!,
      authentication: workspacePrivacyAuthentication,
      agUi: {},
      mcp: {},
      publicUrl: 'http://localhost',
      a2aAgents: ['default'],
      mounts: [
        {
          pathPrefix: contributed.key,
          workspaceClass: contributed.workspaceClass,
          fetch: async () => {
            calls += 1;
            return new Response(contributed.sentinel);
          },
        },
      ],
    });
    const mountRows = Object.values(WORKSPACE_MOUNT_CONFORMANCE);
    expect(handler.resourceInventory.map(({ kind, key }) => `${kind}:${key}`).toSorted()).toEqual(
      [
        ...rows.map(({ name }) => `operation:${name}`),
        ...mountRows.map(({ key }) => `mount:${key}`),
      ].toSorted(),
    );
    for (const row of mountRows) {
      const entry = handler.resourceInventory.find(
        ({ kind, key }) => kind === 'mount' && key === row.key,
      );
      expect(entry).toEqual({
        kind: 'mount',
        key: row.key,
        workspaceClass: row.workspaceClass,
        transports: [...row.transports],
      });
      expect(WORKSPACE_EXPECTED_OUTCOMES[row.outcome]).toHaveLength(6);
      const source = await Bun.file(new URL(row.testFile, import.meta.url)).text();
      expect(source).toContain('WORKSPACE_MOUNT_CONFORMANCE');
      expect(row.inputFixture.length).toBeGreaterThan(0);
      expect(row.sentinel.length).toBeGreaterThan(0);
    }
    for (const [index, actor] of Object.values(WORKSPACE_PRIVACY_ACTORS).entries()) {
      const before = calls;
      const response = await handler(
        new Request(`http://localhost${contributed.key}`, {
          headers: { 'X-API-Key': actor.key },
        }),
      );
      await mountWitnesses.observeHttp(
        contributed.key,
        Object.keys(WORKSPACE_PRIVACY_ACTORS)[index] as WorkspacePrivacyActor,
        response,
      );
      const allowed = WORKSPACE_EXPECTED_OUTCOMES[contributed.outcome][index] === 'success';
      expect(response.status).toBe(allowed ? 200 : 403);
      expect(calls - before).toBe(allowed ? 1 : 0);
      const body = await response.text();
      if (allowed) expect(body).toBe(contributed.sentinel);
      else expect(body).not.toContain(contributed.sentinel);
    }
  } finally {
    await opened.dispose();
  }
  for (const group of WORKSPACE_CONFORMANCE_GROUPS) {
    expect(await Bun.file(new URL(group.testFile, import.meta.url)).exists()).toBe(true);
    expect(group.inputFixture.length).toBeGreaterThan(0);
    expect(group.sentinel.length).toBeGreaterThan(0);
  }
  for (const row of rows) {
    expect(WORKSPACE_EXPECTED_OUTCOMES[row.outcome]).toHaveLength(6);
    expect(OPERATION_MAP[row.name].workspaceClass).toBeDefined();
    const operation = BUREAU_HANDLER_OPERATIONS.find((entry) => entry.name === row.name)!;
    expect(Object.entries(operation.transports).some(([, enabled]) => enabled)).toBe(true);
  }
});

describe('workspace operation classification', () => {
  test('every live registered operation has one exact classification', () => {
    expect(BUREAU_HANDLER_OPERATIONS.map((operation) => operation.name).toSorted()).toEqual(
      Object.keys(OPERATION_MAP).toSorted(),
    );
  });

  for (const operation of BUREAU_HANDLER_OPERATIONS) {
    test(`${operation.name} applies its declared class before invocation`, async () => {
      // This existing Weft operation projects only the authenticated caller's identity.
      if (operation.name === 'weft.system.principal') {
        expect(operation.outputSchema).toBeDefined();
        return;
      }
      const row = Object.entries(OPERATION_MAP).find(([name]) => name === operation.name)?.[1];
      expect(row).toBeDefined();
      if (row === undefined) throw new Error(`Unclassified operation ${operation.name}`);
      const authorize: unknown = Reflect.get(operation, 'authorize');
      expect(typeof authorize).toBe('function');
      if (typeof authorize !== 'function') throw new Error(`Unguarded operation ${operation.name}`);
      for (const administrator of [false, true]) {
        const workspace: WorkspaceIdentity = {
          ...membership,
          capabilities: administrator ? ['workspace:use', 'workspace:manage'] : ['workspace:use'],
        };
        const decision = await Reflect.apply(authorize, undefined, [
          { principal: { ...credential, workspace } },
        ]);
        const allowed =
          row.workspaceClass !== 'deployment-operator' &&
          (row.workspaceClass !== 'administrator-shared' || administrator);
        expect(decision.allowed).toBe(allowed);
      }
      const service = await Reflect.apply(authorize, undefined, [
        { principal: { ...credential, workspace: { ...membership, actorKind: 'service' } } },
      ]);
      expect(service.allowed).toBe(
        ['public-discovery', 'private-owned', 'explicit-share'].includes(row.workspaceClass),
      );
      const removed = await Reflect.apply(authorize, undefined, [
        {
          principal: { ...credential, workspace: { ...membership, capabilities: [] } },
        },
      ]);
      expect(removed.allowed).toBe(false);
    });
  }
});

// Resource cases exercise authenticated routing, in addition to the catalog hook checks above.

for (const row of WORKSPACE_PRIVATE_READ_CASES) {
  test(`${row.operation} applies all six actor outcomes through JSON-RPC HTTP`, async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      const sentinel = row.sentinel;
      const task = await opened.bureau.tasks.start('default', sentinel, {
        principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
      });
      const identifier = row.field === 'taskId' ? task.id : task.contextId;
      for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
        const input = row.collection ? {} : { [row.field]: identifier };
        const result = await workspacePrivacyCall(opened, actor, row.operation, input);
        if (row.collection) witnesses.observeCollection(row.operation, actor, result, identifier);
        else witnesses.observeWire(row.operation, actor, result);
        if (row.expected[actor] === 'membership-denied') {
          expect(result.status).toBe(403);
        } else if (row.expected[actor] === 'success') {
          expect(result.status).toBe(200);
          expect(result.body?.error).toBeUndefined();
          expect(result.text).toContain(identifier);
        } else if (row.expected[actor] === 'empty') {
          expect(result.body?.error).toBeUndefined();
          expect(result.body?.result?.[row.field === 'taskId' ? 'tasks' : 'contexts']).toEqual([]);
          expect(result.text).not.toContain(identifier);
          expect(result.text).not.toContain(sentinel);
        } else {
          const missing = await workspacePrivacyCall(opened, actor, row.operation, {
            [row.field]: 'unknown-private-resource',
          });
          expect(result.body?.error?.data?.httpStatus).toBe(404);
          expect(result.text.replaceAll(identifier, '<id>')).toBe(
            missing.text.replaceAll('unknown-private-resource', '<id>'),
          );
          expect(result.text).not.toContain(sentinel);
        }
      }
    } finally {
      await opened.dispose();
    }
  });
}

test('the workspace operation inventory has six executed actor witnesses', () => {
  witnesses.verify();
  mountWitnesses.verify();
});
