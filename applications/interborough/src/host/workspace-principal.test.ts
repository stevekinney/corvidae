import { expect, test } from 'bun:test';
import { localWorkspaceMembership } from './workspace-principal.ts';

test('only the explicit local composition grants the local owner deployment authority', async () => {
  const local = localWorkspaceMembership('workspace-a', true);
  expect(
    await local.resolveMembership({ method: 'unauthenticated-local', subject: undefined }),
  ).toEqual({
    version: 1,
    workspaceId: 'workspace-a',
    actorId: 'local-owner',
    actorKind: 'local',
    owner: 'anonymous:local',
    membershipRevision: 'local-owner-v1',
    capabilities: ['workspace:use', 'workspace:manage', 'deployment:operate'],
  });
  expect(await local.resolveMembership({ method: 'api-key', subject: 'a2a' })).toEqual({
    version: 1,
    workspaceId: 'workspace-a',
    actorId: 'service:a2a',
    actorKind: 'service',
    owner: 'api-key:a2a',
    membershipRevision: 'a2a-service-v1',
    capabilities: ['workspace:use'],
  });
  expect(await local.resolveMembership({ method: 'jwt', subject: 'first-user' })).toBeNull();
});

test('runtime directory recognizes only configured local and A2A owners', async () => {
  const disabled = localWorkspaceMembership('workspace-a');
  expect(await disabled.resolveOwnerMembership?.('anonymous:local')).toMatchObject({
    actorKind: 'local',
  });
  expect(await disabled.resolveOwnerMembership?.('api-key:a2a')).toBeNull();
  expect(await disabled.resolveMembership({ method: 'api-key', subject: 'a2a' })).toBeNull();
  const enabled = localWorkspaceMembership('workspace-a', true);
  expect(await enabled.resolveOwnerMembership?.('api-key:a2a')).toMatchObject({
    actorKind: 'service',
  });
  expect(await enabled.resolveOwnerMembership?.('api-key:invented')).toBeNull();
  expect(await enabled.resolveMembership({ method: 'api-key', subject: 'invented' })).toBeNull();
});
