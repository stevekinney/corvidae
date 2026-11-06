import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { approvalConsumeSymbol } from '../src/internal/approval-resume';

import { createTool } from '../src/create-tool';
import {
  type EffectiveToolExecutionContext,
  type ToolRequestContext,
  narrowToolAuthority,
  privilegedExecutionSnapshot,
  projectExecutionSnapshot,
} from '../src/execution-context';
import { createExecutionLifecycle } from '../src/execution-lifecycle';

const effectiveContext: EffectiveToolExecutionContext = {
  authority: {
    principalId: 'principal-a',
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    capabilities: ['read', 'write'],
    authorizationRevision: 'authorization:1',
  },
  audience: 'tenant',
  agentId: 'agent-a',
  runId: 'run-a',
  credentials: { token: 'secret' },
  traceContext: { traceparent: 'secret-trace' },
  revisions: {
    catalog: 'catalog:1',
    toolbox: 'toolbox:1',
    toolDefinition: 'tool:1',
    policy: 'policy:1',
    approval: 'approval:1',
    redaction: 'redaction:1',
  },
};

describe('execution authority and projections', () => {
  it('allows policy to narrow but never expand host capabilities', () => {
    expect(
      narrowToolAuthority(effectiveContext, ['write', 'admin']).authority.capabilities,
    ).toEqual(['write']);
    expect(
      narrowToolAuthority(
        {
          ...effectiveContext,
          authority: { ...effectiveContext.authority, capabilities: ['*'] },
        },
        ['write', 'admin'],
      ).authority.capabilities,
    ).toEqual(['write', 'admin']);
    expect(narrowToolAuthority(effectiveContext, ['*']).authority.capabilities).toEqual(
      effectiveContext.authority.capabilities,
    );
  });

  it('keeps privileged context separate from general lifecycle snapshots', () => {
    const lifecycle = createExecutionLifecycle();
    const handle = lifecycle.begin({
      toolName: 'charge',
      callId: 'call-1',
      privilegedContext: effectiveContext,
    });

    expect(lifecycle.inspect()[0]).not.toHaveProperty('context');
    expect(handle.privilegedSnapshot().context?.credentials).toEqual({ token: 'secret' });
    expect(lifecycle.inspectPrivileged()[0]?.context?.revisions.toolDefinition).toBe('tool:1');
  });

  it('exports a versioned deny-by-default projection and never exports payloads', () => {
    const projection = projectExecutionSnapshot(
      {
        snapshot: {
          executionId: 'execution-1',
          toolName: 'charge',
          ownerId: 'owner-a',
          tenantId: 'tenant-a',
          result: { card: 'secret' },
          credentials: { token: 'secret' },
          newlyAddedUnclassifiedField: 'must-not-leak',
        },
        context: effectiveContext,
      },
      { audience: 'tenant', tenantId: 'tenant-a', sourceTenantId: 'tenant-a' },
    );

    expect(projection).toEqual({
      version: 1,
      audience: 'tenant',
      data: {
        snapshot: {
          executionId: 'execution-1',
          toolName: 'charge',
          ownerId: 'owner-a',
          tenantId: 'tenant-a',
        },
        context: {
          agentId: 'agent-a',
          runId: 'run-a',
        },
      },
    });
    expect(() =>
      projectExecutionSnapshot(
        { snapshot: { executionId: 'execution-1' }, context: effectiveContext },
        { audience: 'tenant', tenantId: 'tenant-b', sourceTenantId: 'tenant-a' },
      ),
    ).toThrow('cross tenant');
    expect(() =>
      projectExecutionSnapshot(
        { executionId: 'execution-1' },
        { audience: 'tenant', tenantId: 'tenant-a' },
      ),
    ).toThrow('requires tenantId and a trusted source tenant');
    expect(() =>
      projectExecutionSnapshot(
        { snapshot: { executionId: 'execution-1' }, context: effectiveContext },
        { audience: 'tenant', tenantId: 'tenant-a', sourceTenantId: 'tenant-b' },
      ),
    ).toThrow('cross tenant');

    expect(
      projectExecutionSnapshot([{ executionId: 'execution-1' }, undefined, { result: 'secret' }], {
        audience: 'public',
      }).data,
    ).toEqual([{ executionId: 'execution-1' }, {}]);

    const tenantSnapshots = [
      { context: effectiveContext, snapshot: { executionId: 'execution-1' } },
      { context: effectiveContext, snapshot: { executionId: 'execution-2' } },
    ];
    expect(
      projectExecutionSnapshot(tenantSnapshots, {
        audience: 'tenant',
        tenantId: 'tenant-a',
        sourceTenantId: 'tenant-a',
      }).data,
    ).toHaveLength(2);
    expect(
      projectExecutionSnapshot([], {
        audience: 'tenant',
        tenantId: 'tenant-a',
        sourceTenantId: 'tenant-a',
      }).data,
    ).toEqual([]);
    expect(() =>
      projectExecutionSnapshot([], {
        audience: 'tenant',
        tenantId: 'tenant-a',
        sourceTenantId: 'tenant-b',
      }),
    ).toThrow('requires tenantId and a trusted source tenant');
    expect(() =>
      projectExecutionSnapshot(
        [
          tenantSnapshots[0],
          {
            context: {
              ...effectiveContext,
              authority: { ...effectiveContext.authority, tenantId: 'tenant-b' },
            },
          },
        ],
        { audience: 'tenant', tenantId: 'tenant-a', sourceTenantId: 'tenant-a' },
      ),
    ).toThrow('requires tenantId and a trusted source tenant');
    expect(() =>
      projectExecutionSnapshot([tenantSnapshots[0], { snapshot: { executionId: 'untrusted' } }], {
        audience: 'tenant',
        tenantId: 'tenant-a',
        sourceTenantId: 'tenant-a',
      }),
    ).toThrow('requires tenantId and a trusted source tenant');
  });

  it('rejects unclassified primitive projection roots', () => {
    expect(() => projectExecutionSnapshot('must-not-leak', { audience: 'public' })).toThrow(
      'External projection root must be an object or array',
    );
  });

  it('redacts unclassified primitive array elements while preserving supported snapshots', () => {
    expect(
      projectExecutionSnapshot(
        ['must-not-leak', 123, false, null, { executionId: 'execution-1' }, { result: 'secret' }],
        { audience: 'public' },
      ).data,
    ).toEqual([{ executionId: 'execution-1' }, {}]);
  });

  it('projects privileged lifecycle snapshot containers through deny-by-default redaction', () => {
    const projection = projectExecutionSnapshot(
      {
        snapshot: {
          executionId: 'execution-1',
          toolName: 'charge',
          callId: 'call-1',
          revision: 2,
          state: 'terminal',
          queuedAt: 100,
          lastActivityAt: 200,
          ownerId: 'owner-a',
          result: { card: 'secret' },
          unclassifiedSnapshotField: 'must-not-leak',
        },
        context: effectiveContext,
        unclassifiedContainer: {
          executionId: 'must-not-traverse',
        },
      },
      { audience: 'operator' },
    );

    expect(projection).toEqual({
      version: 1,
      audience: 'operator',
      data: {
        snapshot: {
          executionId: 'execution-1',
          toolName: 'charge',
          callId: 'call-1',
          revision: 2,
          state: 'terminal',
          queuedAt: 100,
          lastActivityAt: 200,
          ownerId: 'owner-a',
        },
        context: {
          authority: {
            principalId: 'principal-a',
            tenantId: 'tenant-a',
            ownerId: 'owner-a',
            capabilities: ['read', 'write'],
            authorizationRevision: 'authorization:1',
          },
          agentId: 'agent-a',
          runId: 'run-a',
          revisions: {
            catalog: 'catalog:1',
            toolbox: 'toolbox:1',
            toolDefinition: 'tool:1',
            policy: 'policy:1',
            approval: 'approval:1',
            redaction: 'redaction:1',
          },
        },
      },
    });
  });

  it('reasserts host identity after policy context injection and narrows runtime authority', async () => {
    let observedContext: unknown;
    const tool = createTool({
      name: 'inspect-authority',
      description: 'Inspect authority',
      input: z.object({}),
      policyContext: () => ({
        requestContext: {
          authority: { principalId: 'attacker', tenantId: 'tenant-b' },
        },
      }),
      policy: {
        beforeExecute() {
          return { allow: true, capabilities: ['read', 'admin'] };
        },
      },
      async execute(_input, context) {
        observedContext = context.requestContext;
        return 'ok';
      },
    });

    await tool.execute(
      { id: 'call-1', name: 'inspect-authority', arguments: {} },
      { requestContext: effectiveContext, effectiveContext },
    );

    expect(observedContext).toMatchObject({
      authority: {
        principalId: 'principal-a',
        tenantId: 'tenant-a',
        capabilities: ['read'],
      },
    });
    expect(privilegedExecutionSnapshot(effectiveContext).credentials).toEqual({ token: 'secret' });
  });
});

it('revalidates after delayed policy and prevents the callback after revocation', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let current = true;
  let effects = 0;
  const tool = createTool({
    name: 'read_private_data',
    description: 'Read private data',
    input: z.object({}),
    policy: {
      beforeExecute: async () => {
        entered.resolve();
        await release.promise;
        return { allow: true };
      },
    },
    execute: async () => {
      effects++;
      return 'private';
    },
  });
  const result = tool.execute(
    { id: 'revoked-call', name: tool.name, arguments: {} },
    {
      requestContext: effectiveContext,
      revalidateAuthority: async (context) => (current ? context : undefined),
    },
  );
  await entered.promise;
  current = false;
  release.resolve();
  const settled = await result;
  expect(settled.outcome).toBe('error');
  expect(effects).toBe(0);
});

it('a late approval cannot dispatch after authority removal and its admission is rolled back', async () => {
  let current = true;
  let effects = 0;
  let rollbacks = 0;
  const tool = createTool({
    name: 'approved_read',
    description: 'Protected approved read',
    input: z.object({}),
    execute: async () => {
      effects++;
      return 'private';
    },
  });
  const options = {
    requestContext: effectiveContext,
    revalidateAuthority: async (context: ToolRequestContext) => (current ? context : undefined),
    [approvalConsumeSymbol]: async () => {
      current = false;
      return async () => {
        rollbacks++;
      };
    },
  };
  const result = await tool.execute({ id: 'approved', name: tool.name, arguments: {} }, options);
  expect(result.outcome).toBe('error');
  expect(effects).toBe(0);
  expect(rollbacks).toBe(1);
});
