import { expect, test } from 'bun:test';
import { localWorkspaceMembership } from './workspace-principal.ts';

test('only the explicit local composition grants the local owner deployment authority', async () => {
  const local = localWorkspaceMembership('workspace-a');
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
