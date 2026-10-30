import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  createProcessLocalApprovalStateStore,
  createProcessLocalGrantStateStore,
  createTool,
  createToolbox,
  GRANT_VERSION,
  type ReusableApprovalGrant,
  type SignedPendingToolApproval,
  signGrant,
} from '../src';

const secret = 'namespaced-approval-secret';
const now = 1_000_000;

const requestContext = {
  authority: {
    principalId: 'principal-ns',
    tenantId: 'tenant-ns',
    ownerId: 'owner-ns',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
  audience: 'tenant' as const,
  agentId: 'agent-ns',
  runId: 'run-ns',
  sessionId: 'session-ns',
};

function searchTool(
  namespace: string | undefined,
  version: string | undefined,
  executed: string[],
) {
  return createTool({
    name: 'search',
    ...(namespace !== undefined ? { namespace } : {}),
    ...(version !== undefined ? { version } : {}),
    description: 'Search',
    input: z.object({}),
    async execute() {
      executed.push(`${namespace ?? 'default'}:search`);
      return 'ok';
    },
  });
}

function grantFor(toolName: string): ReusableApprovalGrant {
  const unsigned: ReusableApprovalGrant = {
    version: GRANT_VERSION,
    id: `grant:${toolName}`,
    principalId: requestContext.authority.principalId,
    tenantId: requestContext.authority.tenantId,
    ownerId: requestContext.authority.ownerId,
    agentId: requestContext.agentId,
    toolName,
    scope: 'session',
    sessionId: requestContext.sessionId,
    issuedAt: now,
    expiresAt: now + 60_000,
    maxUses: 5,
    usesRemaining: 5,
    policyRevision: 'policy:1',
    revoked: false,
    delegationBehavior: 'does-not-propagate',
    signature: '',
  };
  return { ...unsigned, signature: signGrant(unsigned, secret) };
}

async function toolboxWithGrant(toolName: string, tools: ReturnType<typeof searchTool>[]) {
  const grantStateStore = createProcessLocalGrantStateStore();
  const grant = grantFor(toolName);
  await grantStateStore.issue(grant);
  const toolbox = createToolbox(tools, {
    approvalSecret: secret,
    approvalPolicy: { mode: 'always' },
    approvalNow: () => now,
    grantStateStore,
  });
  return { toolbox, grantStateStore, grant };
}

describe('approval grants key on tool identity', () => {
  it('does not let a grant for a:search authorize b:search', async () => {
    const executed: string[] = [];
    const { toolbox, grantStateStore, grant } = await toolboxWithGrant('a:search', [
      searchTool('a', '1', executed),
      searchTool('b', '1', executed),
    ]);

    const other = await toolbox.execute(
      { id: 'call-b', name: 'b:search', arguments: {} },
      { requestContext },
    );
    expect(other.outcome).toBe('action_required');
    expect(executed).toEqual([]);
    const untouched = await grantStateStore.get(grant.id);
    expect(untouched?.usesRemaining).toBe(5);

    const granted = await toolbox.execute(
      { id: 'call-a', name: 'a:search', arguments: {} },
      { requestContext },
    );
    expect(granted.outcome).toBe('success');
    expect(executed).toEqual(['a:search']);
    const used = await grantStateStore.get(grant.id);
    expect(used?.usesRemaining).toBe(4);
  });

  it('pins a grant that names a version, and floats one that does not', async () => {
    const executed: string[] = [];
    const pinned = await toolboxWithGrant('a:search@2', [searchTool('a', '1', executed)]);
    const mismatch = await pinned.toolbox.execute(
      { id: 'call-1', name: 'a:search', arguments: {} },
      { requestContext },
    );
    expect(mismatch.outcome).toBe('action_required');

    const floating = await toolboxWithGrant('a:search', [searchTool('a', '1', executed)]);
    const matched = await floating.toolbox.execute(
      { id: 'call-2', name: 'a:search@1', arguments: {} },
      { requestContext },
    );
    expect(matched.outcome).toBe('success');
  });

  it('reads a bare grant name as the default namespace', async () => {
    const executed: string[] = [];
    const { toolbox } = await toolboxWithGrant('search', [
      searchTool(undefined, '1', executed),
      searchTool('b', '1', executed),
    ]);

    const other = await toolbox.execute(
      { id: 'call-b', name: 'b:search', arguments: {} },
      { requestContext },
    );
    expect(other.outcome).toBe('action_required');

    const granted = await toolbox.execute(
      { id: 'call-default', name: 'default:search', arguments: {} },
      { requestContext },
    );
    expect(granted.outcome).toBe('success');
    expect(executed).toEqual(['default:search']);
  });

  it('covers nothing when the grant name cannot be read as an identity', async () => {
    const executed: string[] = [];
    const { toolbox } = await toolboxWithGrant('%E0%A4%A', [searchTool('a', '1', executed)]);

    const result = await toolbox.execute(
      { id: 'call-a', name: 'a:search', arguments: {} },
      { requestContext },
    );
    expect(result.outcome).toBe('action_required');
  });
});

describe('pending approvals for a name two namespaces share', () => {
  it('resumes the approved tool even though the bare name is ambiguous', async () => {
    const executed: string[] = [];
    const approvalStateStore = createProcessLocalApprovalStateStore();
    const toolbox = createToolbox(
      [searchTool('a', '1', executed), searchTool('b', '1', executed)],
      {
        approvalSecret: secret,
        approvalStateStore,
        policy: {
          beforeExecute: () => ({
            allow: false as const,
            status: 'needs_approval' as const,
            reason: 'approval required',
          }),
        },
      },
    );

    const paused = await toolbox.execute(
      { id: 'call-b', name: 'b:search@1', arguments: {} },
      { requestContext },
    );
    expect(paused.outcome).toBe('action_required');
    expect(paused.pendingApproval?.approvalBinding?.toolDefinitionRevision).toBe('b:search@1');

    const resumed = await toolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        requestContext,
      },
    );
    expect(resumed.outcome).toBe('success');
    expect(executed).toEqual(['b:search']);
  });
});
