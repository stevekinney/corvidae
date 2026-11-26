import { evaluateCapabilityApproval, withToolSummary } from './approval-policy';
import type { ToolPolicyContext, ToolPolicyHooks } from './is-tool';
import { verifyAndSnapshotPendingApproval } from './toolbox-approval';
import type { ToolboxOptions } from './toolbox-contracts';
import { internalToolboxOptionsRegistry } from './toolbox-internal-registry';
import type { PendingToolApproval, SignedPendingToolApproval } from './types';

const approvalOnlyHooks = new WeakSet<NonNullable<ToolPolicyHooks['beforeAdmission']>>();

/** Construct an admission policy that can only deny or request a fresh approval. */
export function approvalOnlyPolicy(
  decide: (
    context: ToolPolicyContext,
  ) =>
    | { decision: 'deny' | 'approval'; reason?: string }
    | Promise<{ decision: 'deny' | 'approval'; reason?: string }>,
): ToolPolicyHooks {
  const beforeAdmission: NonNullable<ToolPolicyHooks['beforeAdmission']> = async (context) => {
    const result = await decide(context);
    if (result.decision !== 'deny' && result.decision !== 'approval')
      throw new Error('Unsupported approval-only policy decision');
    return withToolSummary(
      {
        allow: false,
        status: result.decision === 'deny' ? 'deny' : 'needs_approval',
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      },
      context,
    );
  };
  approvalOnlyHooks.add(beforeAdmission);
  return Object.freeze({ beforeAdmission });
}

/** The approval options a toolbox was constructed with, ready to pass to `createToolbox`. */
export type ToolboxApprovalOptions = Pick<
  ToolboxOptions,
  'approvalBindingTtlMs' | 'approvalNow' | 'approvalPolicy'
>;

/** Whether this toolbox can issue signed, state-backed approval bindings. */
export function hasSignedApprovalState(
  toolbox: {
    toJSON: () => import('./toolbox-contracts').SerializedToolbox;
  },
  store: NonNullable<ToolboxOptions['approvalStateStore']>,
): boolean {
  const options = internalToolboxOptionsRegistry.get(toolbox.toJSON);
  return Boolean(
    options?.approvalSecret && options.approvalStateStore === store && !options.opaqueToolFactory,
  );
}

/** Verify a pending call with its originating toolbox without consuming the approval. */
export function verifyToolboxPendingApproval(
  toolbox: { toJSON: () => import('./toolbox-contracts').SerializedToolbox },
  approval: PendingToolApproval,
): SignedPendingToolApproval {
  const options = internalToolboxOptionsRegistry.get(toolbox.toJSON);
  if (!options || options.opaqueToolFactory) throw new Error('Unknown approval toolbox');
  return verifyAndSnapshotPendingApproval(approval as SignedPendingToolApproval, {
    approvalSecret: options.approvalSecret,
  });
}

/**
 * Reads the approval binding lifetime, approval clock, and approval policy a toolbox was
 * constructed with, so a host that rebuilds the toolbox (to narrow its tools or change how they
 * ask) can carry them into the new one instead of falling back to the 5-minute default lifetime.
 *
 * `approvalBindingTtlMs` and `approvalNow` are always present for a toolbox `createToolbox`
 * built, holding the resolved values (the defaults when the caller set none); `approvalPolicy`
 * is present only when one was configured. The approval secret and secret resolver are not
 * returned: they stay private to the toolbox. A value that is not a toolbox built by armorer
 * yields an empty object, so spreading the result changes nothing.
 *
 * @param toolbox - A toolbox built by `createToolbox` or `combineToolboxes`.
 * @returns The options to spread into a replacement toolbox's `createToolbox` options.
 */
export function getToolboxApprovalOptions(toolbox: {
  toJSON: () => unknown;
}): ToolboxApprovalOptions {
  const options = internalToolboxOptionsRegistry.get(
    toolbox.toJSON as Parameters<typeof internalToolboxOptionsRegistry.get>[0],
  );
  if (options === undefined) return {};
  return {
    ...(options.approvalBindingTtlMs === undefined
      ? {}
      : { approvalBindingTtlMs: options.approvalBindingTtlMs }),
    ...(options.approvalNow === undefined ? {} : { approvalNow: options.approvalNow }),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
  };
}

/** Classifies whether a selected tool can pause without executing its policies. */
export function toolboxProjectionInterruption(
  toolbox: { toJSON: () => import('./toolbox-contracts').SerializedToolbox },
  toolId: string,
): 'unknown' | 'policy' | 'approval' | undefined {
  const options = internalToolboxOptionsRegistry.get(toolbox.toJSON);
  if (!options || options.opaqueToolFactory) return 'unknown';
  const configuration = toolbox.toJSON().find((entry) => entry.id === toolId);
  if (!configuration) return 'unknown';
  const hooks = [options.policy, configuration.policy];
  if (
    hooks.some(
      (policy) =>
        policy?.beforeExecute ||
        (policy?.beforeAdmission && !approvalOnlyHooks.has(policy.beforeAdmission)),
    )
  )
    return 'unknown';
  if (hooks.some((policy) => policy?.beforeAdmission)) return 'policy';
  if (
    options.approvalPolicy &&
    evaluateCapabilityApproval(
      {
        metadata: configuration.metadata,
        ...(configuration.tags ? { tags: configuration.tags } : {}),
      },
      options.approvalPolicy,
    ).status === 'ask'
  )
    return 'approval';
  return undefined;
}
