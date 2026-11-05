import { describe, expect, it } from 'bun:test';

import { BUREAU_SCOPES } from './http/bureau-scopes.ts';
import { createRunPrincipal, mayRunAccess, mayRunUseSharedConfiguration } from './run-authority.ts';

describe('run authority (COR-2026)', () => {
  it('gives local runs every Bureau scope', () => {
    const principal = createRunPrincipal('anonymous:local');
    expect(BUREAU_SCOPES.every((scope) => principal.hasScope(scope))).toBe(true);
  });

  it('gives API-key runs no Bureau scopes', () => {
    const principal = createRunPrincipal('api-key:a2a');
    expect(BUREAU_SCOPES.some((scope) => principal.hasScope(scope))).toBe(false);
  });

  it('uses owner equality without scopes for custom owners', () => {
    const principal = createRunPrincipal('library:custom');
    expect(BUREAU_SCOPES.some((scope) => principal.hasScope(scope))).toBe(false);
    expect(mayRunAccess('library:custom', 'bureau.tasks:read', 'library:custom')).toBe(true);
    expect(mayRunAccess('library:custom', 'bureau.tasks:read', 'library:other')).toBe(false);
  });
});

it('checks current workspace roles for shared run tools without promoting service actors', async () => {
  let role: 'member' | 'administrator' | 'service' | 'removed' | 'foreign' = 'member';
  const workspace = {
    workspaceId: 'workspace-a',
    resolveMembership: async ({ subject }: { readonly subject?: string }) => ({
      version: 1 as const,
      workspaceId: 'workspace-a',
      actorId: subject,
      actorKind: 'user' as const,
      owner: `api-key:${subject}`,
      membershipRevision: 'revision-1',
      capabilities: ['workspace:use' as const, 'workspace:manage' as const],
    }),
    resolveOwnerMembership: async (owner: string) =>
      role === 'removed'
        ? null
        : {
            version: 1 as const,
            workspaceId: role === 'foreign' ? 'workspace-b' : 'workspace-a',
            actorId: 'actor-a',
            actorKind: role === 'service' ? ('service' as const) : ('user' as const),
            owner,
            membershipRevision: 'revision-1',
            capabilities:
              role === 'administrator'
                ? ['workspace:use' as const, 'workspace:manage' as const]
                : ['workspace:use' as const],
          },
  };
  const read = () =>
    mayRunUseSharedConfiguration(workspace, 'owner-a', 'bureau.workflows:read', false);
  const write = () =>
    mayRunUseSharedConfiguration(workspace, 'owner-a', 'bureau.workflows:write', true);
  expect(await read()).toBe(true);
  expect(await write()).toBe(false);
  role = 'administrator';
  expect(await write()).toBe(true);
  for (const denied of ['service', 'removed', 'foreign'] as const) {
    role = denied;
    expect(await read()).toBe(false);
    expect(await write()).toBe(false);
  }
  expect(
    await mayRunUseSharedConfiguration(undefined, 'anonymous:local', 'bureau.settings:read', true),
  ).toBe(true);
});
