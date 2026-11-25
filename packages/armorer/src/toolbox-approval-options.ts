import { evaluateCapabilityApproval } from './approval-policy';
import type { ToolboxOptions } from './toolbox-contracts';
import { internalToolboxOptionsRegistry } from './toolbox-internal-registry';

/** The approval options a toolbox was constructed with, ready to pass to `createToolbox`. */
export type ToolboxApprovalOptions = Pick<
  ToolboxOptions,
  'approvalBindingTtlMs' | 'approvalNow' | 'approvalPolicy'
>;

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
  if (
    options.policy?.beforeAdmission ||
    options.policy?.beforeExecute ||
    configuration.policy?.beforeAdmission ||
    configuration.policy?.beforeExecute
  )
    return 'policy';
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
