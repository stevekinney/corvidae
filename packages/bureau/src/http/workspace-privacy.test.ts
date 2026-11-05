import {
  WORKSPACE_CONFORMANCE_GROUPS,
  WORKSPACE_MOUNT_CONFORMANCE,
  WORKSPACE_EXPECTED_OUTCOMES,
} from './workspace-conformance.test-support.ts';
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
