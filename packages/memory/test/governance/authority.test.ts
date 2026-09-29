import { describe, expect, it } from 'bun:test';

import {
  MEMORY_CAPABILITIES,
  MemoryAuthorityError,
  assertMemoryAuthority,
  attenuateMemoryAuthority,
  createMemoryAuthority,
  delegationChainIncludes,
  hasMemoryCapability,
  holdsGovernanceAuthority,
  holdsServiceAuthority,
  memoryAuthorityFromToolRequestContext,
  requestPrincipal,
  type MemoryAuthority,
  type MemoryPrincipalKind,
} from '../../src/governance/authority';

const root = createMemoryAuthority({
  principal: { kind: 'user', id: 'user-a' },
  tenantId: 'tenant-a',
  ownerId: 'owner-a',
  purpose: 'conversation-memory',
  capabilities: ['memory:search', 'memory:write', 'memory:delete'],
  policyRevision: 'authorization:1',
  projection: 'bureau',
});

describe('createMemoryAuthority', () => {
  it('records every attribution field and a one-link delegation chain', () => {
    expect(root).toEqual({
      principal: { kind: 'user', id: 'user-a' },
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
      purpose: 'conversation-memory',
      capabilities: ['memory:search', 'memory:write', 'memory:delete'],
      delegationChain: [
        {
          principal: { kind: 'user', id: 'user-a' },
          capabilities: ['memory:search', 'memory:write', 'memory:delete'],
        },
      ],
      policyRevision: 'authorization:1',
      projection: 'bureau',
    });
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.delegationChain[0]!.capabilities)).toBe(true);
  });

  it('can extend an existing delegation chain', () => {
    const delegated = createMemoryAuthority({
      principal: { kind: 'run', id: 'run-1' },
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
      purpose: 'conversation-memory',
      capabilities: ['memory:search'],
      policyRevision: 'authorization:1',
      projection: 'bureau',
      delegatedBy: [
        { principal: { kind: 'service', id: 'bureau' }, capabilities: ['memory:search'] },
      ],
    });
    expect(delegated.delegationChain.map((link) => link.principal.kind)).toEqual([
      'service',
      'run',
    ]);
  });
});

describe('assertMemoryAuthority (fails closed)', () => {
  it('accepts a valid authority and returns a frozen copy', () => {
    const copy = assertMemoryAuthority(JSON.parse(JSON.stringify(root)));
    expect(copy).toEqual(root);
    expect(Object.isFrozen(copy)).toBe(true);
  });

  it.each([
    ['a missing tenant', { ...root, tenantId: '' }],
    ['a missing owner', { ...root, ownerId: undefined }],
    ['a missing purpose', { ...root, purpose: '' }],
    ['a missing policy revision', { ...root, policyRevision: '' }],
    ['an unknown projection', { ...root, projection: 'gateway' }],
    ['an unknown capability', { ...root, capabilities: ['memory:everything'] }],
    ['a wildcard capability', { ...root, capabilities: ['*'] }],
    ['an unknown principal kind', { ...root, principal: { kind: 'robot', id: 'x' } }],
    ['an empty delegation chain', { ...root, delegationChain: [] }],
    ['a non-object', 'user-a'],
  ])('rejects %s', (_label, value) => {
    expect(() => assertMemoryAuthority(value)).toThrow(MemoryAuthorityError);
  });

  it('rejects a chain whose last link is not the acting principal', () => {
    expect(() =>
      assertMemoryAuthority({ ...root, principal: { kind: 'user', id: 'user-b' } }),
    ).toThrow(/last delegation link/);
  });

  it('rejects capabilities the last link never held', () => {
    expect(() =>
      assertMemoryAuthority({
        ...root,
        capabilities: ['memory:search', 'memory:promote'],
      }),
    ).toThrow(/exceeds its delegation chain/);
  });

  it('rejects a chain that widens authority at any link', () => {
    expect(() =>
      assertMemoryAuthority({
        ...root,
        principal: { kind: 'run', id: 'run-1' },
        capabilities: ['memory:search'],
        delegationChain: [
          { principal: { kind: 'user', id: 'user-a' }, capabilities: ['memory:search'] },
          {
            principal: { kind: 'run', id: 'run-1' },
            capabilities: ['memory:search', 'memory:delete'],
          },
        ],
      }),
    ).toThrow(/widens/);
  });
});

describe('attenuateMemoryAuthority (children can only attenuate)', () => {
  it('narrows capabilities and appends the child link while inheriting tenant and owner', () => {
    const child = attenuateMemoryAuthority(root, {
      principal: { kind: 'agent', id: 'child-agent' },
      capabilities: ['memory:search'],
      purpose: 'child-research',
      projection: 'child',
    });
    expect(child.tenantId).toBe('tenant-a');
    expect(child.ownerId).toBe('owner-a');
    expect(child.policyRevision).toBe('authorization:1');
    expect(child.capabilities).toEqual(['memory:search']);
    expect(child.purpose).toBe('child-research');
    expect(child.projection).toBe('child');
    expect(child.delegationChain).toHaveLength(2);
    expect(child.delegationChain[1]).toEqual({
      principal: { kind: 'agent', id: 'child-agent' },
      capabilities: ['memory:search'],
    });
  });

  it('inherits the parent capabilities, purpose, and projection when none are requested', () => {
    const child = attenuateMemoryAuthority(root, { principal: { kind: 'run', id: 'run-2' } });
    expect(child.capabilities).toEqual(root.capabilities);
    expect(child.purpose).toBe(root.purpose);
    expect(child.projection).toBe(root.projection);
  });

  it('rejects a request for a capability the parent does not hold', () => {
    const narrow = attenuateMemoryAuthority(root, {
      principal: { kind: 'agent', id: 'child' },
      capabilities: ['memory:search'],
    });
    expect(() =>
      attenuateMemoryAuthority(narrow, {
        principal: { kind: 'agent', id: 'grandchild' },
        capabilities: ['memory:search', 'memory:write'],
      }),
    ).toThrow(expect.objectContaining({ code: 'escalation' }));
  });
});

describe('principal kinds only attenuate down a delegation chain', () => {
  const agent = attenuateMemoryAuthority(root, { principal: { kind: 'agent', id: 'agent-1' } });
  const governance = createMemoryAuthority({
    principal: { kind: 'governance', id: 'counsel' },
    tenantId: 'tenant-a',
    ownerId: 'governance-office',
    purpose: 'administration',
    capabilities: ['memory:delete', 'memory:legal-hold', 'memory:retention'],
    policyRevision: 'authorization:1',
    projection: 'administrative',
  });
  const service = attenuateMemoryAuthority(governance, {
    principal: { kind: 'service', id: 'retention' },
  });

  it.each<[string, MemoryAuthority, MemoryPrincipalKind]>([
    ['an agent', agent, 'governance'],
    ['an agent', agent, 'service'],
    ['a user', root, 'governance'],
    ['a user', root, 'service'],
    ['a service', service, 'governance'],
  ])('rejects %s delegating to a %s principal', (_label, parent, kind) => {
    expect(() =>
      attenuateMemoryAuthority(parent, { principal: { kind, id: 'self-appointed' } }),
    ).toThrow(expect.objectContaining({ code: 'escalation' }));
  });

  it('lets governance delegate to a service, and a service to a run', () => {
    const run = attenuateMemoryAuthority(service, { principal: { kind: 'run', id: 'sweep-1' } });
    expect(run.delegationChain.map((link) => link.principal.kind)).toEqual([
      'governance',
      'service',
      'run',
    ]);
  });

  it('rejects a persisted chain that names a more privileged kind after a less privileged link', () => {
    const principal = { kind: 'governance', id: 'self-appointed' } as const;
    expect(() =>
      assertMemoryAuthority({
        ...agent,
        principal,
        delegationChain: [
          ...agent.delegationChain,
          { principal, capabilities: agent.capabilities },
        ],
      }),
    ).toThrow(/more privileged principal kind/);
  });

  it('derives governance and service privilege from every link, never the actor alone', () => {
    const principal = { kind: 'governance', id: 'self-appointed' } as const;
    const forged: MemoryAuthority = {
      ...agent,
      principal,
      delegationChain: [...agent.delegationChain, { principal, capabilities: agent.capabilities }],
    };
    expect(holdsGovernanceAuthority(forged)).toBe(false);
    expect(holdsServiceAuthority(forged)).toBe(false);
    expect(holdsGovernanceAuthority(governance)).toBe(true);
    expect(holdsServiceAuthority(governance)).toBe(true);
    expect(holdsGovernanceAuthority(service)).toBe(false);
    expect(holdsServiceAuthority(service)).toBe(true);
    expect(holdsServiceAuthority(root)).toBe(false);
    // An actor that is not its chain's last link inherits nothing from the chain.
    const detached: MemoryAuthority = { ...root, principal };
    expect(holdsGovernanceAuthority(detached)).toBe(false);
    expect(holdsGovernanceAuthority({ ...governance, delegationChain: [] })).toBe(false);
  });
});

describe('capability and chain helpers', () => {
  it('answers capability membership', () => {
    expect(hasMemoryCapability(root, 'memory:write')).toBe(true);
    expect(hasMemoryCapability(root, 'memory:promote')).toBe(false);
  });

  it('detects principal kinds anywhere in the delegation chain', () => {
    const child = attenuateMemoryAuthority(root, { principal: { kind: 'run', id: 'run-1' } });
    expect(delegationChainIncludes(child, ['agent', 'run'])).toBe(true);
    expect(delegationChainIncludes(root, ['agent', 'run'])).toBe(false);
  });

  it('lists every operation and administrative capability', () => {
    expect(MEMORY_CAPABILITIES).toContain('memory:list');
    expect(MEMORY_CAPABILITIES).toContain('memory:legal-hold');
    expect(MEMORY_CAPABILITIES).toContain('memory:policy');
    expect(MEMORY_CAPABILITIES).toHaveLength(14);
  });
});

describe('memoryAuthorityFromToolRequestContext', () => {
  const requestContext = {
    authority: {
      principalId: 'user-a',
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
      capabilities: ['tools:execute', 'memory:search', 'memory:write', '*'],
      authorizationRevision: 'authorization:7',
    },
  } as const;

  it('maps the persisted tool authority, keeping only explicit memory capabilities', () => {
    const authority = memoryAuthorityFromToolRequestContext(requestContext, {
      principal: { kind: 'tool', id: 'memory_recall' },
      purpose: 'model-tool',
      projection: 'tool',
    });
    expect(authority.tenantId).toBe('tenant-a');
    expect(authority.ownerId).toBe('owner-a');
    expect(authority.policyRevision).toBe('authorization:7');
    // A wildcard never grants memory authority implicitly.
    expect(authority.capabilities).toEqual(['memory:search', 'memory:write']);
    expect(authority.delegationChain.map((link) => link.principal)).toEqual([
      { kind: 'user', id: 'user-a' },
      { kind: 'tool', id: 'memory_recall' },
    ]);
  });

  it('classifies service and run principals from their identifiers', () => {
    const service = memoryAuthorityFromToolRequestContext(
      { authority: { ...requestContext.authority, principalId: 'service:scheduler' } },
      { principal: { kind: 'tool', id: 'memory_store' }, purpose: 'p', projection: 'tool' },
    );
    expect(service.delegationChain[0]!.principal.kind).toBe('service');
    const run = memoryAuthorityFromToolRequestContext(
      { authority: { ...requestContext.authority, principalId: 'run:run-1' } },
      { principal: { kind: 'tool', id: 'memory_store' }, purpose: 'p', projection: 'tool' },
    );
    expect(run.delegationChain[0]!.principal.kind).toBe('run');
  });
});

describe('requestPrincipal', () => {
  it('classifies request principal identifiers', () => {
    expect(requestPrincipal('service:scheduler')).toEqual({
      kind: 'service',
      id: 'service:scheduler',
    });
    expect(requestPrincipal('run:run-1')).toEqual({ kind: 'run', id: 'run:run-1' });
    expect(requestPrincipal('api-key:abc')).toEqual({ kind: 'user', id: 'api-key:abc' });
  });
});
