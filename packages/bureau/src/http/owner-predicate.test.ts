import {
  type WorkspaceIdentity,
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  mayAccessOwnedResource,
  mayUseCrossOwnerScope,
  ownerOfPrincipal,
} from './owner-predicate.ts';

const alice = principalFromApiKey({ subject: 'alice', scopes: [] });
const reviewer = principalFromApiKey({ subject: 'reviewer', scopes: ['bureau.reviews:read'] });

describe('ownerOfPrincipal', () => {
  it('names an API key by its percent-encoded subject', () => {
    expect(ownerOfPrincipal(alice)).toBe('api-key:alice');
    expect(ownerOfPrincipal(principalFromApiKey({ subject: 'a:b/c', scopes: [] }))).toBe(
      'api-key:a%3Ab%2Fc',
    );
  });

  it('names the unauthenticated-local caller anonymous:local', () => {
    const local = {
      ...principalFromApiKey({ subject: 'ignored', scopes: [] }),
      method: 'unauthenticated-local' as const,
    };
    expect(ownerOfPrincipal(local)).toBe('anonymous:local');
  });

  it('names no owner for a caller it cannot attribute', () => {
    expect(ownerOfPrincipal(anonymousPrincipal())).toBeUndefined();
    expect(ownerOfPrincipal(principalFromJwtClaims({ sub: 'someone' }))).toBeUndefined();
    expect(ownerOfPrincipal({ ...alice, subject: undefined })).toBeUndefined();
  });
});

describe('mayAccessOwnedResource', () => {
  const request = (overrides: Partial<Parameters<typeof mayAccessOwnedResource>[0]> = {}) => ({
    principal: alice,
    resourceOwner: 'api-key:alice',
    operatorScope: 'bureau.reviews:read' as const,
    ...overrides,
  });

  it('admits the owner without any scope', () => {
    expect(mayAccessOwnedResource(request())).toBe(true);
  });

  it('refuses another owner, and a resource with no owner', () => {
    expect(mayAccessOwnedResource(request({ resourceOwner: 'api-key:bob' }))).toBe(false);
    expect(mayAccessOwnedResource(request({ resourceOwner: undefined }))).toBe(false);
  });

  it('admits any owner’s resource to a holder of the operator scope, and only that scope', () => {
    expect(
      mayAccessOwnedResource(request({ principal: reviewer, resourceOwner: 'api-key:bob' })),
    ).toBe(true);
    expect(
      mayAccessOwnedResource(
        request({
          principal: reviewer,
          resourceOwner: 'api-key:bob',
          operatorScope: 'bureau.reviews:resolve',
        }),
      ),
    ).toBe(false);
  });

  it('refuses an unauthenticated principal and a principal that owns nothing', () => {
    expect(mayAccessOwnedResource(request({ principal: anonymousPrincipal() }))).toBe(false);
    expect(
      mayAccessOwnedResource(
        request({
          principal: principalFromJwtClaims({ sub: 'alice' }),
          resourceOwner: 'api-key:alice',
        }),
      ),
    ).toBe(false);
  });
});

describe('workspace private ownership', () => {
  const identity: WorkspaceIdentity = {
    version: 1,
    workspaceId: 'workspace-a',
    actorId: 'alice',
    actorKind: 'user',
    owner: 'workspace-a:alice',
    membershipRevision: 'revision-1',
    capabilities: ['workspace:use', 'workspace:manage'],
  };

  it('never lets administrator or operator scopes bypass private ownership', () => {
    const principal = { ...reviewer, workspace: identity };
    expect(mayUseCrossOwnerScope(principal, 'bureau.reviews:read')).toBe(false);
    expect(mayUseCrossOwnerScope(reviewer, 'bureau.reviews:read')).toBe(true);
    for (const resourceOwner of ['workspace-a:bob', 'workspace-b:alice', undefined]) {
      expect(
        mayAccessOwnedResource({ principal, resourceOwner, operatorScope: 'bureau.reviews:read' }),
      ).toBe(false);
    }
    expect(
      mayAccessOwnedResource({
        principal,
        resourceOwner: identity.owner,
        operatorScope: 'bureau.reviews:read',
      }),
    ).toBe(true);
  });

  it('does not treat a missing use capability or an internal owner override as membership', () => {
    const principal = { ...reviewer, workspace: identity, owner: 'workspace-a:bob' };
    expect(
      mayAccessOwnedResource({
        principal,
        resourceOwner: 'workspace-a:bob',
        operatorScope: 'bureau.reviews:read',
      }),
    ).toBe(false);
    expect(
      mayAccessOwnedResource({
        principal: { ...principal, workspace: { ...identity, capabilities: [] } },
        resourceOwner: identity.owner,
        operatorScope: 'bureau.reviews:read',
      }),
    ).toBe(false);
  });
});
