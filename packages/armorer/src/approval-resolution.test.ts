import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createProcessLocalApprovalStateStore, type ApprovalStateStore } from './approval-binding';
import { createTool, createToolCall } from './create-tool';
import { createToolbox } from './create-toolbox';
import { createToolResultCache, withToolboxIdempotency } from './idempotency';
import type { ToolboxExecuteOptions } from './toolbox-contracts';
import type { SignedPendingToolApproval, ToolApprovalAction } from './types';

const ownerId = 'approval-resolution-owner';
const approvalSecret = 'approval-resolution-secret';

type RequestContext = NonNullable<ToolboxExecuteOptions['requestContext']>;

function createRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    authority: {
      principalId: ownerId,
      tenantId: 'approval-resolution-tenant',
      ownerId,
      capabilities: [],
      authorizationRevision: '1',
    },
    audience: 'tenant',
    agentId: 'approval-resolution-agent',
    runId: 'approval-resolution-run',
    ...overrides,
  };
}

function requireSignedApproval(result: { pendingApproval?: unknown }): SignedPendingToolApproval {
  const approval = result.pendingApproval as SignedPendingToolApproval | undefined;
  if (!approval?.approvalToken) throw new Error('missing signed pending approval');
  return approval;
}

function requireApprovalAction(action: unknown): ToolApprovalAction {
  if (typeof action !== 'object' || action === null || !('type' in action)) {
    throw new Error('missing approval action');
  }
  const candidate = action as ToolApprovalAction;
  if (candidate.type !== 'approval') throw new Error('expected approval action');
  return candidate;
}

function createMapStore() {
  const map = new Map<string, string>();
  return {
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async set(key: string, value: string) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
    async list(prefix: string) {
      return [...map.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

function createCountingStore() {
  const inner = createProcessLocalApprovalStateStore();
  const counts = { reserve: 0, revoke: 0, release: 0, commit: 0 };
  const store: ApprovalStateStore = {
    ...inner,
    async reserve(binding, context, now) {
      counts.reserve += 1;
      await inner.reserve(binding, context, now);
    },
    async revoke(binding) {
      counts.revoke += 1;
      await inner.revoke(binding);
    },
    async release(binding) {
      counts.release += 1;
      await inner.release(binding);
    },
    async commit(binding) {
      counts.commit += 1;
      await inner.commit(binding);
    },
  };
  return { store, counts };
}

describe('approval resolution foundation', () => {
  it('emits required approval metadata defaults with a stable idempotency key', async () => {
    const tool = createTool({
      name: 'approval-defaults',
      version: '1.0.0',
      description: 'Approval metadata default test tool',
      input: z.object({ target: z.string() }),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve deploy' }) },
      execute: async () => 'must not execute',
    });
    const toolbox = createToolbox([tool], {
      approvalSecret,
      approvalStateStore: createProcessLocalApprovalStateStore(),
      policyRevision: 'policy:test-defaults',
    });
    const requestContext = createRequestContext();
    const call = createToolCall(tool.name, { target: 'production' }, 'approval-defaults-call');

    const first = await toolbox.execute(call, { ownerId, requestContext });
    const second = await toolbox.execute(call, { ownerId, requestContext });
    const firstAction = requireApprovalAction(first.action);
    const secondAction = requireApprovalAction(second.action);

    expect(firstAction).toEqual({
      type: 'approval',
      message: 'Approve deploy',
      risk: 'high',
      operation: { kind: 'other', argsPreview: { target: 'production' } },
      policyVersion: 'policy:test-defaults',
      idempotencyKey: firstAction.idempotencyKey,
    });
    expect(firstAction.idempotencyKey).toStartWith('approval:');
    expect(secondAction).toEqual(firstAction);
  });

  it('uses the policy:1 fallback and separates otherwise identical registry and tool pause keys', async () => {
    const tool = createTool({
      name: 'approval-tier-separation',
      version: '1.0.0',
      description: 'Approval tier key separation test tool',
      input: z.object({}),
      policy: {
        beforeExecute: () => ({
          status: 'needs_approval',
          reason: 'Approve operation',
          action: { message: 'Approve operation' },
        }),
      },
      execute: async () => 'completed',
    });
    const toolbox = createToolbox([tool], {
      approvalSecret,
      policy: {
        beforeExecute: () => ({
          status: 'needs_approval',
          reason: 'Approve operation',
          action: { message: 'Approve operation' },
        }),
      },
    });
    const requestContext = createRequestContext();
    const registryPaused = await toolbox.execute(createToolCall(tool.name, {}, 'same-pause-call'), {
      ownerId,
      requestContext,
    });
    const toolPaused = await toolbox.resumeApproval(requireSignedApproval(registryPaused), {
      requestContext,
    });
    const registryAction = requireApprovalAction(registryPaused.action);
    const toolAction = requireApprovalAction(toolPaused.action);

    expect(registryAction.policyVersion).toBe('policy:1');
    expect(toolAction.policyVersion).toBe('policy:1');
    expect(registryAction.idempotencyKey).not.toBe(toolAction.idempotencyKey);
    expect(toolPaused.pendingApproval?.satisfiedPolicyPauses).toEqual([
      { action: registryAction, reason: 'Approve operation', tier: 'registry' },
    ]);
  });

  it('separates approval keys for otherwise identical tool definition revisions', async () => {
    function createVersionedTool(version: string) {
      return createTool({
        name: 'approval-revision-separation',
        version,
        description: 'Approval revision key separation test tool',
        input: z.object({}),
        policy: {
          beforeExecute: () => ({
            status: 'needs_approval',
            reason: 'Approve operation',
            action: { message: 'Approve operation' },
          }),
        },
        execute: async () => 'completed',
      });
    }
    const firstToolbox = createToolbox([createVersionedTool('1.0.0')], { approvalSecret });
    const secondToolbox = createToolbox([createVersionedTool('2.0.0')], { approvalSecret });
    const requestContext = createRequestContext();
    const call = createToolCall('approval-revision-separation', {}, 'same-revision-call');

    const firstPaused = await firstToolbox.execute(call, { ownerId, requestContext });
    const secondPaused = await secondToolbox.execute(call, { ownerId, requestContext });

    expect(requireApprovalAction(firstPaused.action).idempotencyKey).not.toBe(
      requireApprovalAction(secondPaused.action).idempotencyKey,
    );
  });

  it('preserves explicit approval metadata supplied by policy decisions', async () => {
    const expectedAction = {
      type: 'approval',
      message: 'Run command?',
      risk: 'medium',
      operation: {
        kind: 'command',
        command: 'deploy production',
        filesTouched: ['scripts/deploy.ts'],
        argsPreview: { environment: 'production' },
      },
      sandbox: { provider: 'codex', name: 'approval', workingDir: '/workspace' },
      env: ['NODE_ENV'],
      snapshotId: 'snapshot-1',
      expiresAt: '2026-09-19T12:34:56-06:00',
      editableArgs: true,
      policyVersion: 'policy:explicit',
      idempotencyKey: 'approval:explicit-key',
    } satisfies ToolApprovalAction;
    const { type: _type, ...action } = expectedAction;
    const tool = createTool({
      name: 'approval-explicit',
      version: '1.0.0',
      description: 'Approval explicit metadata test tool',
      input: z.object({}),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve', action }) },
      execute: async () => 'must not execute',
    });
    const toolbox = createToolbox([tool], { approvalSecret });

    const result = await toolbox.execute(createToolCall(tool.name, {}, 'approval-explicit-call'), {
      ownerId,
      requestContext: createRequestContext(),
    });

    expect(requireApprovalAction(result.action)).toEqual(expectedAction);
  });

  it('approves edited arguments through the resume path', async () => {
    let executedValue: string | undefined;
    const tool = createTool({
      name: 'approval-edits',
      version: '1.0.0',
      description: 'Approval edit resolution test tool',
      input: z.object({ value: z.string() }),
      policy: {
        beforeExecute: ({ params }) => {
          const value = (params as { value?: string }).value;
          return value === 'edited'
            ? { status: 'allow' }
            : { status: 'needs_approval', reason: 'Approve edit' };
        },
      },
      execute: async ({ value }) => {
        executedValue = value;
        return value;
      },
    });
    const toolbox = createToolbox([tool], {
      approvalSecret,
      approvalStateStore: createProcessLocalApprovalStateStore(),
    });
    const requestContext = createRequestContext();
    const parked = await toolbox.execute(
      createToolCall(tool.name, { value: 'original' }, 'edit-call'),
      {
        ownerId,
        requestContext,
      },
    );

    const resolved = await toolbox.resolveApproval(
      requireSignedApproval(parked),
      { decision: 'approve_with_edits', editedArgs: { value: 'edited' }, remember: false },
      { requestContext },
    );

    expect(resolved.outcome).toBe('success');
    expect(resolved.result).toBe('edited');
    expect(executedValue).toBe('edited');
  });

  it.each([
    ['deny', 'denied', 'permission', 'The user denied this request.'],
    ['cancel', 'CANCELLED', 'cancelled', 'The user cancelled this request.'],
  ] as const)(
    'reserves then revokes %s resolutions without executing',
    async (decision, code, category, message) => {
      let callbackCount = 0;
      const { store, counts } = createCountingStore();
      const tool = createTool({
        name: `approval-${decision}`,
        version: '1.0.0',
        description: 'Approval rejection test tool',
        input: z.object({}),
        policy: {
          beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve rejection' }),
        },
        execute: async () => {
          callbackCount += 1;
          return 'must not execute';
        },
      });
      const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
      const requestContext = createRequestContext();
      const parked = await toolbox.execute(
        createToolCall(tool.name, {}, `approval-${decision}-call`),
        {
          ownerId,
          requestContext,
        },
      );

      const resolved = await toolbox.resolveApproval(
        requireSignedApproval(parked),
        { decision, remember: true, reason: 'because test' },
        { requestContext },
      );

      expect(resolved).toMatchObject({
        outcome: 'error',
        content: message,
        error: {
          code,
          category,
          retryable: false,
          message,
          details: { decision, remember: true, reason: 'because test' },
        },
      });
      expect(callbackCount).toBe(0);
      expect(counts.reserve).toBe(1);
      expect(counts.revoke).toBe(1);
      expect(counts.commit).toBe(0);
    },
  );

  it('rejects stale approval authority before returning a denied result', async () => {
    const { store, counts } = createCountingStore();
    const tool = createTool({
      name: 'approval-stale-authority',
      version: '1.0.0',
      description: 'Approval stale authority test tool',
      input: z.object({}),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve stale' }) },
      execute: async () => 'must not execute',
    });
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const parked = await toolbox.execute(createToolCall(tool.name, {}, 'stale-call'), {
      ownerId,
      requestContext: createRequestContext(),
    });

    await expect(
      toolbox.resolveApproval(
        requireSignedApproval(parked),
        { decision: 'deny', remember: false },
        {
          requestContext: createRequestContext({
            authority: {
              principalId: ownerId,
              tenantId: 'approval-resolution-tenant',
              ownerId,
              capabilities: [],
              authorizationRevision: 'stale',
            },
          }),
        },
      ),
    ).rejects.toThrow('authorizationRevision');
    expect(counts.revoke).toBe(0);
  });

  it('keeps destructured resolveApproval bound to the idempotency proxy receiver', async () => {
    let callbackCount = 0;
    const tool = createTool({
      name: 'approval-proxy',
      version: '1.0.0',
      description: 'Approval proxy binding test tool',
      input: z.object({ value: z.string() }),
      policy: {
        beforeExecute: ({ params }) => {
          const value = (params as { value?: string }).value;
          return value === 'approved'
            ? { status: 'allow' }
            : { status: 'needs_approval', reason: 'Approve proxy' };
        },
      },
      idempotencyKey: (input: unknown) => `proxy:${(input as { value: string }).value}`,
      execute: async ({ value }) => {
        callbackCount += 1;
        return value;
      },
    });
    const toolbox = createToolbox([tool], { approvalSecret });
    const wrapped = withToolboxIdempotency(toolbox, {
      cache: createToolResultCache({ store: createMapStore() }),
      tenantId: 'approval-resolution-tenant',
    });
    const requestContext = createRequestContext();
    const parked = await wrapped.execute(
      createToolCall(tool.name, { value: 'parked' }, 'proxy-call'),
      {
        ownerId,
        requestContext,
      },
    );
    const { resolveApproval } = wrapped;

    const resolved = await resolveApproval(
      requireSignedApproval(parked),
      { decision: 'approve_with_edits', editedArgs: { value: 'approved' }, remember: false },
      { requestContext },
    );

    expect(resolved.outcome).toBe('success');
    expect(callbackCount).toBe(1);
    expect(resolved.idempotency?.outcome).toBe('fresh');
  });
});
