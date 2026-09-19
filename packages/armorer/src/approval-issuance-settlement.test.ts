import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { type ApprovalStateStore, createProcessLocalApprovalStateStore } from './approval-binding';
import { createTool, createToolCall } from './create-tool';
import { createToolbox } from './create-toolbox';
import type { ToolPolicyDecision } from './is-tool';
import type { ToolboxExecuteOptions } from './toolbox-contracts';
import type { ToolboxSettledEvent } from './toolbox-lifecycle-events';
import type { SignedPendingToolApproval } from './types';

const ownerId = 'issuance-owner';
const approvalSecret = 'issuance-test-secret';

type RequestContext = NonNullable<ToolboxExecuteOptions['requestContext']>;

function createRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    authority: {
      principalId: ownerId,
      tenantId: 'issuance-tenant',
      ownerId,
      capabilities: [],
      authorizationRevision: '1',
    },
    audience: 'tenant',
    agentId: 'issuance-agent',
    runId: 'issuance-run',
    ...overrides,
  };
}

type GatedToolOptions = { readonly version?: string | undefined };

function createGatedTool(name: string, options: GatedToolOptions = { version: '1.0.0' }) {
  const callbacks = { count: 0 };
  const tool = createTool({
    name,
    description: 'Approval issuance settlement test tool',
    input: z.object({}),
    ...(options.version === undefined ? {} : { version: options.version }),
    policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve this call' }) },
    execute: async () => {
      callbacks.count += 1;
      return 'must not execute';
    },
  });
  return { tool, callbacks };
}

type StoreHooks = {
  readonly beforeIssue?: () => Promise<void> | void;
  readonly afterRevoke?: () => void;
};

function createProbeStore(hooks: StoreHooks = {}) {
  const inner = createProcessLocalApprovalStateStore();
  const probe = { issueCalls: 0, revokeCalls: 0 };
  const store: ApprovalStateStore = {
    ...inner,
    async issue(binding) {
      probe.issueCalls += 1;
      await hooks.beforeIssue?.();
      await inner.issue(binding);
    },
    async revoke(binding) {
      probe.revokeCalls += 1;
      await inner.revoke(binding);
      hooks.afterRevoke?.();
    },
  };
  return { store, probe };
}

type SettlementRecord = {
  readonly callId: string;
  readonly status: string;
  readonly executionId: string | undefined;
  readonly ownerId: string | undefined;
  readonly result: unknown;
  readonly error: unknown;
  readonly callbackCompletion: unknown;
};

function toSettlementRecord(event: ToolboxSettledEvent): SettlementRecord {
  return {
    callId: event.call.id,
    status: event.status,
    executionId: event.executionId,
    ownerId: event.ownerId,
    result: event.result,
    error: event.error,
    callbackCompletion: event.callbackCompletion,
  };
}

function createSettlementLog(expected: number) {
  const records: SettlementRecord[] = [];
  const reached = Promise.withResolvers<void>();
  return {
    records,
    reached: reached.promise,
    record(event: ToolboxSettledEvent) {
      records.push(toSettlementRecord(event));
      if (records.length >= expected) reached.resolve();
    },
  };
}

function errorCode(settlement: SettlementRecord | undefined): string | undefined {
  const error = settlement?.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

describe('approval issuance settlement ordering', () => {
  it('withholds the paused toolbox settlement until issuance is authoritative', async () => {
    const issueEntered = Promise.withResolvers<void>();
    const releaseIssue = Promise.withResolvers<void>();
    const { store, probe } = createProbeStore({
      beforeIssue: async () => {
        issueEntered.resolve();
        await releaseIssue.promise;
      },
    });
    const { tool, callbacks } = createGatedTool('issuance-paused');
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const log = createSettlementLog(1);
    const starts: (string | undefined)[] = [];
    toolbox.addEventListener('execute-start', (event) => {
      starts.push(event.executionId);
    });
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-paused-call');

    const execution = toolbox.execute(call, { ownerId, requestContext: createRequestContext() });
    await issueEntered.promise;

    expect(probe.issueCalls).toBe(1);
    expect(log.records).toHaveLength(0);

    releaseIssue.resolve();
    const result = await execution;

    expect(result.outcome).toBe('action_required');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('paused');
    expect(log.records[0]?.callId).toBe(call.id);
    expect(log.records[0]?.executionId).toBe(starts[0]);
    expect(log.records[0]?.executionId).toBeTruthy();
    expect(log.records[0]?.ownerId).toBe(ownerId);
    expect(log.records[0]?.result).toBeUndefined();
    expect(log.records[0]?.error).toBeUndefined();
    expect(log.records[0]?.callbackCompletion).toBeInstanceOf(Promise);
    expect(probe.revokeCalls).toBe(0);
  });

  it('settles error when the approval state store rejects issuance', async () => {
    const { store } = createProbeStore({
      beforeIssue: () => {
        throw new Error('store rejected issuance');
      },
    });
    const { tool, callbacks } = createGatedTool('issuance-store-rejection');
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-store-rejection-call');

    const result = await toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext(),
    });

    expect(result.outcome).toBe('error');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.callId).toBe(call.id);
    expect(log.records[0]?.ownerId).toBe(ownerId);
    expect(log.records[0]?.result).toBeUndefined();
    expect(log.records[0]?.error).toEqual(result.error);
    expect(log.records[0]?.callbackCompletion).toBeInstanceOf(Promise);
  });

  it('settles error when the approval request context is missing', async () => {
    const { tool, callbacks } = createGatedTool('issuance-missing-context');
    const toolbox = createToolbox([tool], { approvalSecret });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-missing-context-call');

    const result = await toolbox.execute(call, { ownerId });

    expect(result.outcome).toBe('error');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.callId).toBe(call.id);
    expect(log.records[0]?.result).toBeUndefined();
    expect(log.records[0]?.error).toEqual(result.error);
  });

  it('settles error when the tool definition carries no version', async () => {
    const { tool, callbacks } = createGatedTool('issuance-missing-version', { version: undefined });
    const toolbox = createToolbox([tool], { approvalSecret });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-missing-version-call');

    const result = await toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext(),
    });

    expect(result.outcome).toBe('error');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.error).toEqual(result.error);
  });

  it('settles error when the pending approval cannot be signed', async () => {
    const callbacks = { count: 0 };
    const tool = createTool({
      name: 'issuance-unsignable',
      version: '1.0.0',
      description: 'Approval issuance settlement test tool',
      input: z.object({}),
      policy: {
        // `ToolAction.message` is declared `string`, and unlike `action.schema`
        // it never passes through `normalizeToolContent`, so a policy that
        // violates that declaration reaches `signPendingApproval` intact and
        // makes its `JSON.stringify` throw.
        beforeExecute: () =>
          ({
            status: 'needs_approval',
            reason: 'Approve this call',
            action: { message: 1n },
          }) as unknown as ToolPolicyDecision,
      },
      execute: async () => {
        callbacks.count += 1;
        return 'must not execute';
      },
    });
    const { store, probe } = createProbeStore();
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-unsignable-call');

    const result = await toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext(),
    });

    expect(result.outcome).toBe('error');
    expect(callbacks.count).toBe(0);
    expect(probe.issueCalls).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.callId).toBe(call.id);
    expect(log.records[0]?.result).toBeUndefined();
    expect(log.records[0]?.error).toEqual(result.error);
  });

  it('settles error when the approval binding expiry is invalid', async () => {
    const { tool, callbacks } = createGatedTool('issuance-invalid-expiry');
    const toolbox = createToolbox([tool], {
      approvalSecret,
      approvalNow: () => Number.MAX_VALUE,
    });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-invalid-expiry-call');

    const result = await toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext(),
    });

    expect(result.outcome).toBe('error');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.error).toEqual(result.error);
  });

  it('settles error once and revokes late issuance when cancelled mid-issuance', async () => {
    const issueEntered = Promise.withResolvers<void>();
    const releaseIssue = Promise.withResolvers<void>();
    const revoked = Promise.withResolvers<void>();
    const { store, probe } = createProbeStore({
      beforeIssue: async () => {
        issueEntered.resolve();
        await releaseIssue.promise;
      },
      afterRevoke: () => revoked.resolve(),
    });
    const { tool, callbacks } = createGatedTool('issuance-cancelled');
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const controller = new AbortController();
    const call = createToolCall(tool.name, {}, 'issuance-cancelled-call');

    const execution = toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext(),
      signal: controller.signal,
    });
    await issueEntered.promise;
    expect(log.records).toHaveLength(0);

    controller.abort('cancelled by test');
    releaseIssue.resolve();
    const result = await execution;
    await revoked.promise;

    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('CANCELLED');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.callId).toBe(call.id);
    expect(errorCode(log.records[0])).toBe('CANCELLED');
    expect(probe.revokeCalls).toBe(1);
  });

  it('settles error when the request deadline expires before issuance', async () => {
    const clock = { value: 0 };
    const { store, probe } = createProbeStore();
    const callbacks = { count: 0 };
    const tool = createTool({
      name: 'issuance-deadline',
      version: '1.0.0',
      description: 'Approval issuance settlement test tool',
      input: z.object({}),
      policy: {
        beforeExecute: () => {
          clock.value = 2000;
          return { status: 'needs_approval', reason: 'Approve this call' };
        },
      },
      execute: async () => {
        callbacks.count += 1;
        return 'must not execute';
      },
    });
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-deadline-call');

    const result = await toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext({ deadline: 1000 }),
      now: () => clock.value,
      setTimeoutFunction: () => 0,
      clearTimeoutFunction: () => undefined,
    });

    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('TIMEOUT');
    expect(callbacks.count).toBe(0);
    expect(probe.issueCalls).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(errorCode(log.records[0])).toBe('TIMEOUT');
  });

  it('settles paused after issuance and success after an approved resume', async () => {
    const callbacks = { count: 0 };
    const tool = createTool({
      name: 'issuance-resume',
      version: '1.0.0',
      description: 'Approval issuance settlement test tool',
      input: z.object({ value: z.string() }),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve this call' }) },
      execute: async ({ value }) => {
        callbacks.count += 1;
        return value;
      },
    });
    const { store } = createProbeStore();
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const log = createSettlementLog(2);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const requestContext = createRequestContext();
    const call = createToolCall(tool.name, { value: 'approved' }, 'issuance-resume-call');

    const parked = await toolbox.execute(call, { ownerId, requestContext });
    expect(parked.outcome).toBe('action_required');
    const pendingApproval = parked.pendingApproval;
    if (!pendingApproval?.approvalToken) throw new Error('missing signed pending approval');
    const resumed = await toolbox.resumeApproval(pendingApproval as SignedPendingToolApproval, {
      requestContext,
    });

    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toBe('approved');
    expect(callbacks.count).toBe(1);
    expect(log.records).toHaveLength(2);
    expect(log.records.map((record) => record.status)).toEqual(['paused', 'success']);
    expect(log.records.every((record) => record.callId === call.id)).toBe(true);
  });

  it('settles every call exactly once in a collect-mode batch', async () => {
    const issueEntered = Promise.withResolvers<void>();
    const releaseIssue = Promise.withResolvers<void>();
    const { store } = createProbeStore({
      beforeIssue: async () => {
        issueEntered.resolve();
        await releaseIssue.promise;
      },
    });
    const issued = createGatedTool('issuance-batch-ok');
    const unversioned = createGatedTool('issuance-batch-broken', { version: undefined });
    const toolbox = createToolbox([issued.tool, unversioned.tool], {
      approvalSecret,
      approvalStateStore: store,
    });
    const log = createSettlementLog(2);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const okCall = createToolCall(issued.tool.name, {}, 'issuance-batch-ok-call');
    const brokenCall = createToolCall(unversioned.tool.name, {}, 'issuance-batch-broken-call');

    const execution = toolbox.execute([okCall, brokenCall], {
      ownerId,
      requestContext: createRequestContext(),
      errorMode: 'collect',
    });
    await issueEntered.promise;
    expect(log.records.some((record) => record.callId === okCall.id)).toBe(false);
    releaseIssue.resolve();
    const results = await execution;
    await log.reached;

    expect(results).toHaveLength(2);
    expect(results[0]?.outcome).toBe('action_required');
    expect(results[1]?.outcome).toBe('error');
    expect(issued.callbacks.count).toBe(0);
    expect(unversioned.callbacks.count).toBe(0);
    expect(log.records).toHaveLength(2);
    const okSettlement = log.records.find((record) => record.callId === okCall.id);
    const brokenSettlement = log.records.find((record) => record.callId === brokenCall.id);
    expect(okSettlement?.status).toBe('paused');
    expect(brokenSettlement?.status).toBe('error');
    expect(brokenSettlement?.result).toBeUndefined();
    expect(brokenSettlement?.error).toEqual(results[1]?.error);
  });

  it('settles every call exactly once in a failFast batch and rejects with the original error', async () => {
    const issueEntered = Promise.withResolvers<void>();
    const releaseIssue = Promise.withResolvers<void>();
    const { store } = createProbeStore({
      beforeIssue: async () => {
        issueEntered.resolve();
        await releaseIssue.promise;
      },
    });
    const issued = createGatedTool('fail-fast-batch-ok');
    const unversioned = createGatedTool('fail-fast-batch-broken', { version: undefined });
    const toolbox = createToolbox([issued.tool, unversioned.tool], {
      approvalSecret,
      approvalStateStore: store,
    });
    const log = createSettlementLog(2);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const okCall = createToolCall(issued.tool.name, {}, 'fail-fast-batch-ok-call');
    const brokenCall = createToolCall(unversioned.tool.name, {}, 'fail-fast-batch-broken-call');

    const execution = toolbox.execute([okCall, brokenCall], {
      ownerId,
      requestContext: createRequestContext(),
      errorMode: 'failFast',
    });
    const rejection = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    await issueEntered.promise;
    releaseIssue.resolve();
    const thrown = await rejection;
    await log.reached;

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('versioned tool definition');
    expect(issued.callbacks.count).toBe(0);
    expect(unversioned.callbacks.count).toBe(0);
    expect(log.records).toHaveLength(2);
    const okSettlement = log.records.find((record) => record.callId === okCall.id);
    const brokenSettlement = log.records.find((record) => record.callId === brokenCall.id);
    expect(okSettlement?.status).toBe('paused');
    expect(brokenSettlement?.status).toBe('error');
    expect(brokenSettlement?.result).toBeUndefined();
    expect(errorCode(brokenSettlement)).toBe('EXECUTION_ERROR');
  });
});
