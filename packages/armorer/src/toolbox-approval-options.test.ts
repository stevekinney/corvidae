import { describe, expect, it } from 'bun:test';

import { z } from 'zod';
import { createProcessLocalApprovalStateStore } from './approval-binding';
import {
  createApprovalResolutionRequestContext,
  requireSignedApproval,
} from './approval-resolution-test-helpers';
import { combineToolboxes } from './combine-toolboxes';
import { createTool, createToolCall } from './create-tool';
import { createToolbox } from './create-toolbox';
import {
  approvalOnlyPolicy,
  getToolboxApprovalOptions,
  hasSignedApprovalState,
  verifyToolboxPendingApproval,
} from './toolbox-approval-options';

describe('getToolboxApprovalOptions', () => {
  it('constructs a native admission policy limited to denial and approval', async () => {
    const policy = approvalOnlyPolicy(({ params }) => ({
      decision: params === 'deny' ? 'deny' : 'approval',
      reason: 'checked',
    }));
    const context = { params: 'deny' } as Parameters<NonNullable<typeof policy.beforeAdmission>>[0];
    expect(await policy.beforeAdmission!(context)).toEqual({
      allow: false,
      status: 'deny',
      reason: 'checked',
    });
    expect(await policy.beforeAdmission!({ ...context, params: 'approve' })).toEqual({
      allow: false,
      status: 'needs_approval',
      reason: 'checked',
    });
    const invalid = approvalOnlyPolicy(() => ({ decision: 'input' }) as never);
    await expect(invalid.beforeAdmission!(context)).rejects.toThrow(
      'Unsupported approval-only policy decision',
    );
  });
  it('verifies the original signed call without consuming it and rejects edits', async () => {
    const tool = createTool({
      name: 'check',
      version: '1.0.0',
      description: 'Check',
      input: z.object({ value: z.string() }),
      policy: { beforeExecute: () => ({ status: 'needs_approval' }) },
      execute: async () => 'ok',
    });
    const store = createProcessLocalApprovalStateStore();
    const toolbox = createToolbox([tool], {
      approvalSecret: 'fixture-secret',
      approvalStateStore: store,
    });
    const result = await toolbox.execute(createToolCall(tool.name, { value: 'one' }, 'call'), {
      requestContext: createApprovalResolutionRequestContext(),
    });
    const signed = requireSignedApproval(result);
    expect(verifyToolboxPendingApproval(toolbox, signed)).toEqual(signed);
    expect(() =>
      verifyToolboxPendingApproval(toolbox, { ...signed, arguments: { value: 'two' } }),
    ).toThrow();
  });
  it('reports signing and state without exposing either', () => {
    const store = createProcessLocalApprovalStateStore();
    expect(hasSignedApprovalState(createToolbox([]), store)).toBe(false);
    expect(
      hasSignedApprovalState(createToolbox([], { approvalSecret: 'test-secret' }), store),
    ).toBe(false);
    expect(
      hasSignedApprovalState(
        createToolbox([], {
          approvalSecret: 'test-secret',
          approvalStateStore: store,
        }),
        store,
      ),
    ).toBe(true);
  });
  it('returns the binding lifetime, clock and approval policy the toolbox was built with', () => {
    const approvalNow = () => 42;
    const approvalPolicy = { mode: 'on-mutation' } as const;
    const toolbox = createToolbox([], {
      approvalBindingTtlMs: 86_400_000,
      approvalNow,
      approvalPolicy,
    });

    const options = getToolboxApprovalOptions(toolbox);

    expect(options.approvalBindingTtlMs).toBe(86_400_000);
    expect(options.approvalNow).toBe(approvalNow);
    expect(options.approvalPolicy).toBe(approvalPolicy);
  });

  it('returns the resolved default lifetime and no policy when none was configured', () => {
    const options = getToolboxApprovalOptions(createToolbox([]));

    expect(options.approvalBindingTtlMs).toBe(5 * 60_000);
    expect(typeof options.approvalNow).toBe('function');
    expect(options).not.toHaveProperty('approvalPolicy');
  });

  it('never returns the approval secret or the secret resolver', () => {
    const toolbox = createToolbox([], {
      approvalSecret: 'a-secret-of-sufficient-length-for-signing',
      secretResolver: () => 'value',
    });

    const options = getToolboxApprovalOptions(toolbox);

    expect(Object.keys(options).toSorted()).toEqual(['approvalBindingTtlMs', 'approvalNow']);
  });

  it('survives a combination, which keeps the first toolbox options', () => {
    const first = createToolbox([], { approvalBindingTtlMs: 7_000 });
    const combined = combineToolboxes(first, createToolbox([]));

    expect(getToolboxApprovalOptions(combined).approvalBindingTtlMs).toBe(7_000);
  });

  it('returns an empty object for something armorer did not build', () => {
    expect(getToolboxApprovalOptions({ toJSON: () => [] })).toEqual({});
  });

  it('lets a rebuild carry the options into a new toolbox', () => {
    const original = createToolbox([], { approvalBindingTtlMs: 123_000 });
    const rebuilt = createToolbox([], { ...getToolboxApprovalOptions(original) });

    expect(getToolboxApprovalOptions(rebuilt).approvalBindingTtlMs).toBe(123_000);
  });
});
