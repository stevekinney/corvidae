/**
 * Per-tool approval (COR-1913): when each tool of an agent asks a person before it runs.
 *
 * An agent file's `toolApproval` maps a tool name to one of four values, and a code agent's
 * toolbox takes the same helper, so both answer the question the same way. {@link
 * createToolApprovalHooks} turns the map into a registry-level policy hook for the agent's
 * toolbox. The hook answers `allow`, `ask` or `deny` for each call, and Armorer's toolbox composes
 * it with the toolbox's own `approvalPolicy` by taking the most restrictive verdict
 * (`combineApprovalStatuses`: `deny` over `ask` over `allow`). So the hook can only tighten what the
 * toolbox decides: a tool set to `never` is still asked about when the toolbox says to ask, and a
 * tool set to `blocked` is denied whatever the toolbox says. Chat permission modes work the same
 * way, only tightening.
 *
 * @module tool-approval
 */

import {
  type ApprovalMode,
  createApprovalPolicyHooks,
  type ToolPolicyContext,
  type ToolPolicyDecision,
  type ToolPolicyHooks,
} from 'armorer';

/** The values a tool's `toolApproval` entry may take. */
export const TOOL_APPROVAL_MODES = ['never', 'on-changes', 'always', 'blocked'] as const;

/**
 * When a tool asks a person before it runs.
 *
 * - `never`: the tool runs without asking. A tool that declares no capability metadata
 *   (`readOnly`, `mutates` or `dangerous`) is still asked about, because Armorer never lets a call
 *   it cannot classify through unasked.
 * - `on-changes`: a tool that is read-only runs; one that changes something, or is dangerous, or
 *   declares nothing, asks.
 * - `always`: every call asks.
 * - `blocked`: every call is denied, and the model is told so.
 */
export type ToolApprovalMode = (typeof TOOL_APPROVAL_MODES)[number];

/** What a tool with no `toolApproval` entry does: `on-changes`. */
export const TOOL_APPROVAL_DEFAULT_MODE: ToolApprovalMode = 'on-changes';

/** The Armorer approval mode each value stands for. */
const ARMORER_MODE: Readonly<Record<ToolApprovalMode, ApprovalMode>> = {
  never: 'never',
  'on-changes': 'on-mutation',
  always: 'always',
  blocked: 'deny',
};

/** What {@link createToolApprovalHooks} takes. */
export interface ToolApprovalHooksOptions {
  /** The value for a tool with no entry. Defaults to {@link TOOL_APPROVAL_DEFAULT_MODE}. */
  readonly defaultMode?: ToolApprovalMode | undefined;
  /**
   * The tools the hook governs. A call to any other tool is allowed by this hook, and left to
   * whatever else decides it. A run's toolbox holds more than the agent's own tools: Bureau adds
   * `requestHumanInput`, `scheduleWakeup`, the skill tools and the like, which declare no
   * capability metadata and so would ask under `on-changes`. Name the agent's tools here so only
   * they are governed. Omitted, every tool in the toolbox is.
   */
  readonly tools?: readonly string[] | undefined;
}

/**
 * The policy hook for an agent's tools: each call is decided by the value `toolApproval` gives its
 * tool, or by `options.defaultMode` (`on-changes`) when it gives none. Give the result to a
 * toolbox as `policy`. The hook holds no state, but build one for each run all the same, as a
 * toolbox does: nothing then leaks between runs if the hook ever keeps some.
 *
 * `toolApproval` and `options.tools` are read once, here, so a later change to the caller's
 * objects does not reach a run in flight.
 */
export function createToolApprovalHooks(
  toolApproval: Readonly<Record<string, ToolApprovalMode>> | undefined,
  options: ToolApprovalHooksOptions = {},
): ToolPolicyHooks {
  const defaultMode = options.defaultMode ?? TOOL_APPROVAL_DEFAULT_MODE;
  const modes = new Map<string, ToolApprovalMode>(Object.entries(toolApproval ?? {}));
  const governed = options.tools === undefined ? undefined : new Set(options.tools);
  const hooksOfMode = new Map<ToolApprovalMode, ToolPolicyHooks>(
    TOOL_APPROVAL_MODES.map((mode) => [
      mode,
      createApprovalPolicyHooks({ mode: ARMORER_MODE[mode] }),
    ]),
  );
  return {
    beforeExecute(context: ToolPolicyContext): ToolPolicyDecision | Promise<ToolPolicyDecision> {
      if (governed !== undefined && !governed.has(context.toolName)) {
        return { allow: true, status: 'allow' };
      }
      const mode = modes.get(context.toolName) ?? defaultMode;
      // Every mode has a hook, built above.
      return (hooksOfMode.get(mode) as ToolPolicyHooks).beforeExecute?.(context) as
        ToolPolicyDecision | Promise<ToolPolicyDecision>;
    },
  };
}
