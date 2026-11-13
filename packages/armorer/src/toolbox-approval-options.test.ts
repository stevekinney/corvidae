import { describe, expect, it } from 'bun:test';

import { combineToolboxes } from './combine-toolboxes';
import { createToolbox } from './create-toolbox';
import { getToolboxApprovalOptions } from './toolbox-approval-options';

describe('getToolboxApprovalOptions', () => {
  it('returns the binding lifetime, clock and approval policy the toolbox was built with', () => {
    const approvalNow = () => 42;
    const approvalPolicy = { readOnly: true } as const;
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
