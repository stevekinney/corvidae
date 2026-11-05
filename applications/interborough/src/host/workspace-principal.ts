import { ANONYMOUS_LOCAL_OWNER, type WorkspaceMembershipOptions } from '@lostgradient/bureau';

/** The shipped host has one local owner; a separately verified A2A key is only a service actor. */
export function localWorkspaceMembership(workspaceId: string): WorkspaceMembershipOptions {
  return {
    workspaceId,
    resolveMembership: async ({ method, subject }) => {
      if (method === 'unauthenticated-local') {
        return {
          version: 1,
          workspaceId,
          actorId: 'local-owner',
          actorKind: 'local',
          owner: ANONYMOUS_LOCAL_OWNER,
          membershipRevision: 'local-owner-v1',
          capabilities: ['workspace:use', 'workspace:manage', 'deployment:operate'],
        };
      }
      if (method === 'api-key' && subject !== undefined) {
        return {
          version: 1,
          workspaceId,
          actorId: `service:${subject}`,
          actorKind: 'service',
          owner: `api-key:${encodeURIComponent(subject)}`,
          membershipRevision: 'a2a-service-v1',
          capabilities: ['workspace:use'],
        };
      }
      return null;
    },
  };
}
