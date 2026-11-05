import { describe, expect, test } from 'bun:test';
import { principalFromApiKey, type OperationHandlerAuthenticate } from '@lostgradient/weft';
import { withWorkspaceMembership, type WorkspaceMembership } from './workspace-principal.ts';
import { ownerOfPrincipal } from './owner-predicate.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { openBureau, answering, rpc } from './management/management-fixtures.test-support.ts';
import { startTaskFrom } from '../test/task-start-request.ts';

const request = () =>
  new Request('http://localhost/v1/principal', {
    headers: { 'x-workspace-id': 'other', 'x-actor-id': 'attacker' },
  });

test('two verified credentials retain one durable owner across rotation, without admitting another user', async () => {
  const opened = await openBureau({ generate: answering() });
  try {
    const task = await startTaskFrom(opened.bureau, {
      agentName: 'default',
      input: 'private task',
      principal: 'api-key:existing-owner',
    });
    const keys = new Set(['first-key', 'rotated-key', 'other-key']);
    const handler = createBureauHandler(opened.bureau, {
      mounts: [
        {
          pathPrefix: '/resolved-identity',
          fetch: async (_request, context) =>
            Response.json(
              context.principal.method === 'unauthenticated' ? null : context.principal.workspace,
            ),
        },
      ],
      authentication: {
        auditSink: () => undefined,
        resolveApiKeyPrincipal: async (key) =>
          keys.has(key) ? principalFromApiKey({ subject: key, scopes: [] }) : null,
      },
      workspace: {
        workspaceId: 'workspace-a',
        resolveMembership: async ({ subject }) =>
          subject === 'other-key' ? { ...member(), actorId: 'user-b', owner: 'owner-b' } : member(),
      },
    });
    for (const key of ['first-key', 'rotated-key']) {
      const result = await rpc(handler, 'bureau.tasks.get', { taskId: task.id }, key);
      expect(result.error).toBeUndefined();
      expect(result.result?.['id']).toBe(task.id);
      const principal = await rpc(handler, 'weft.system.principal', {}, key);
      expect(principal.result?.['workspace']).toEqual(member());
      expect(principal.result?.['subject']).toBe(key);
      const context = await handler(
        new Request('http://localhost/resolved-identity', {
          headers: { 'x-api-key': key },
        }),
      );
      expect(await context.json()).toEqual(principal.result?.['workspace']);
    }
    const other = await rpc(handler, 'bureau.tasks.get', { taskId: task.id }, 'other-key');
    expect(other.error?.data?.httpStatus).toBe(404);
    const forged = await rpc(
      handler,
      'bureau.tasks.get',
      {
        taskId: task.id,
        workspaceId: 'workspace-a',
        actorId: 'user-a',
        owner: 'api-key:existing-owner',
      },
      'other-key',
    );
    expect(forged.error?.data?.httpStatus).toBe(400);
    keys.delete('first-key');
    const revoked = await handler(
      new Request('http://localhost/v1/principal', {
        headers: { 'x-api-key': 'first-key' },
      }),
    );
    expect(revoked.status).toBe(401);
    const retained = await rpc(handler, 'bureau.tasks.get', { taskId: task.id }, 'rotated-key');
    expect(retained.result?.['id']).toBe(task.id);
    expect(await opened.bureau.ownerOf({ kind: 'run', id: task.id })).toBe(
      'api-key:existing-owner',
    );
  } finally {
    await opened.dispose();
  }
});
const authenticate: OperationHandlerAuthenticate = async () => ({
  method: 'api-key',
  principal: principalFromApiKey({ subject: 'credential-one', scopes: [] }),
});
const member = (): WorkspaceMembership => ({
  version: 1,
  workspaceId: 'workspace-a',
  actorId: 'user-a',
  actorKind: 'user',
  owner: 'api-key:existing-owner',
  membershipRevision: 'revision-one',
  capabilities: ['workspace:use'],
});

describe('workspace membership after credential verification', () => {
  test('uses only the server resolver and snapshots immutable identity', async () => {
    const capabilities: ('workspace:use' | 'workspace:manage')[] = ['workspace:use'];
    const membership = { ...member(), capabilities };
    const seen: unknown[] = [];
    const resolve = withWorkspaceMembership(authenticate, {
      workspaceId: 'workspace-a',
      resolveMembership: async (credential) => {
        seen.push(credential);
        return membership;
      },
    });
    const outcome = await resolve(request());
    if (outcome instanceof Response) throw new Error('expected membership');
    expect(seen).toEqual([{ method: 'api-key', subject: 'credential-one' }]);
    expect(outcome.principal?.method).toBe('api-key');
    expect(outcome.principal?.workspace).toEqual(member());
    expect(Object.isFrozen(outcome.principal?.workspace)).toBe(true);
    expect(Object.isFrozen(outcome.principal?.workspace?.capabilities)).toBe(true);
    expect(ownerOfPrincipal(outcome.principal!)).toBe('api-key:existing-owner');
    membership.capabilities.push('workspace:manage');
    expect(outcome.principal?.workspace?.capabilities).toEqual(['workspace:use']);
  });

  test('reevaluates membership for the next request and refuses removal', async () => {
    let current: WorkspaceMembership | null = member();
    const resolve = withWorkspaceMembership(authenticate, {
      workspaceId: 'workspace-a',
      resolveMembership: async () => current,
    });
    const first = await resolve(request());
    expect(first instanceof Response).toBe(false);
    current = {
      ...member(),
      membershipRevision: 'revision-two',
      capabilities: ['workspace:use', 'workspace:manage'],
    };
    const changed = await resolve(request());
    if (changed instanceof Response) throw new Error('expected updated membership');
    expect(changed.principal?.workspace?.membershipRevision).toBe('revision-two');
    expect(changed.principal?.workspace?.capabilities).toEqual([
      'workspace:use',
      'workspace:manage',
    ]);
    current = null;
    const removed = await resolve(request());
    expect(removed instanceof Response && removed.status).toBe(403);
  });

  test('the same actor cannot import administration from another workspace', async () => {
    const memberships = new Map([
      ['workspace-a', member()],
      [
        'workspace-b',
        {
          ...member(),
          workspaceId: 'workspace-b',
          capabilities: ['workspace:use', 'workspace:manage'],
        } as WorkspaceMembership,
      ],
    ]);
    for (const workspaceId of ['workspace-a', 'workspace-b']) {
      const resolve = withWorkspaceMembership(authenticate, {
        workspaceId,
        resolveMembership: async () => memberships.get(workspaceId) ?? null,
      });
      const outcome = await resolve(request());
      if (outcome instanceof Response) throw new Error('expected membership');
      expect(outcome.principal?.workspace?.actorId).toBe('user-a');
      expect(outcome.principal?.workspace?.capabilities.includes('workspace:manage')).toBe(
        workspaceId === 'workspace-b',
      );
    }
  });

  test('only an explicit local resolver may bind anonymous:local', async () => {
    const localAuthenticate: OperationHandlerAuthenticate = async () => ({
      method: 'unauthenticated-local',
      principal: {
        ...principalFromApiKey({ subject: 'unused', scopes: [] }),
        method: 'unauthenticated-local',
        subject: undefined,
      },
    });
    const resolve = withWorkspaceMembership(localAuthenticate, {
      workspaceId: 'workspace-a',
      resolveMembership: async () => ({
        ...member(),
        actorKind: 'local',
        owner: 'anonymous:local',
        capabilities: ['workspace:use', 'workspace:manage', 'deployment:operate'],
      }),
    });
    const outcome = await resolve(request());
    if (outcome instanceof Response) throw new Error('expected local membership');
    expect(ownerOfPrincipal(outcome.principal!)).toBe('anonymous:local');
  });

  test('does not consult membership for a refused credential', async () => {
    let calls = 0;
    const resolve = withWorkspaceMembership(async () => new Response(null, { status: 401 }), {
      workspaceId: 'workspace-a',
      resolveMembership: async () => {
        calls++;
        return member();
      },
    });
    const outcome = await resolve(request());
    expect(outcome instanceof Response && outcome.status).toBe(401);
    expect(calls).toBe(0);
  });

  test('refuses a missing verified principal and an incomplete runtime configuration', async () => {
    const resolve = withWorkspaceMembership(async () => ({ method: 'api-key' }), {
      workspaceId: 'workspace-a',
      resolveMembership: async () => member(),
    });
    const outcome = await resolve(request());
    expect(outcome instanceof Response && outcome.status).toBe(403);
    expect(() =>
      withWorkspaceMembership(authenticate, {
        workspaceId: '',
        resolveMembership: async () => member(),
      }),
    ).toThrow('Workspace membership requires');
  });

  test('snapshots verified identity before the directory awaits', async () => {
    const principal = { ...principalFromApiKey({ subject: 'credential-one', scopes: [] }) };
    const resolve = withWorkspaceMembership(async () => ({ method: 'api-key', principal }), {
      workspaceId: 'workspace-a',
      resolveMembership: async () => {
        principal.subject = 'changed';
        return member();
      },
    });
    const outcome = await resolve(request());
    if (outcome instanceof Response) throw new Error('expected membership');
    expect(outcome.principal?.subject).toBe('credential-one');
  });

  test.each([
    { workspaceId: 'workspace-b' },
    { actorId: 'system:scheduler' },
    { owner: 'system:scheduler' },
    { owner: 'anonymous:local' },
    { membershipRevision: '' },
    { capabilities: [] },
    { capabilities: ['workspace:unknown'] },
    { capabilities: ['workspace:use', 'deployment:operate'] },
    { actorKind: 'local' },
    { actorKind: 'service', capabilities: ['workspace:use', 'workspace:manage'] },
    { version: 2 },
  ])('refuses invalid membership %j', async (patch) => {
    const resolve = withWorkspaceMembership(authenticate, {
      workspaceId: 'workspace-a',
      resolveMembership: async () => ({ ...member(), ...patch }) as WorkspaceMembership,
    });
    const outcome = await resolve(request());
    expect(outcome instanceof Response && outcome.status).toBe(403);
  });

  test('resolver failures expose no secret and authorize no request', async () => {
    const resolve = withWorkspaceMembership(authenticate, {
      workspaceId: 'workspace-a',
      resolveMembership: async () => {
        throw new Error('secret-sentinel');
      },
    });
    const outcome = await resolve(request());
    if (!(outcome instanceof Response)) throw new Error('expected refusal');
    expect(outcome.status).toBe(503);
    expect(await outcome.text()).not.toContain('secret-sentinel');
  });
});
