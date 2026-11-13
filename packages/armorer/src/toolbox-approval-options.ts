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
