import {
  ANONYMOUS_LOCAL_OWNER,
  type WorkspaceMembership,
  type WorkspaceMembershipOptions,
} from '@lostgradient/bureau';
import { A2A_SUBJECT } from './a2a-authentication.ts';

/** The shipped host has one local owner and, when enabled, one verified A2A service. */
export function localWorkspaceMembership(
  workspaceId: string,
  a2aEnabled = false,
): WorkspaceMembershipOptions {
  const local: WorkspaceMembership = {
    version: 1,
    workspaceId,
    actorId: 'local-owner',
    actorKind: 'local',
    owner: ANONYMOUS_LOCAL_OWNER,
    membershipRevision: 'local-owner-v1',
    capabilities: ['workspace:use', 'workspace:manage', 'deployment:operate'],
  };
  const service: WorkspaceMembership = {
    version: 1,
    workspaceId,
    actorId: `service:${A2A_SUBJECT}`,
    actorKind: 'service',
    owner: `api-key:${encodeURIComponent(A2A_SUBJECT)}`,
    membershipRevision: 'a2a-service-v1',
    capabilities: ['workspace:use'],
  };
  return {
    workspaceId,
    resolveMembership: async ({ method, subject }) => {
      if (method === 'unauthenticated-local') return local;
      if (a2aEnabled && method === 'api-key' && subject === A2A_SUBJECT) return service;
      return null;
    },
    resolveOwnerMembership: async (owner) => {
      if (owner === local.owner) return local;
      return a2aEnabled && owner === service.owner ? service : null;
    },
  };
}
