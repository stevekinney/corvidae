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
 * tool set to `blocked` is denied whatever the toolbox says.
 *
 * A chat has a permission mode as well (COR-1936, `bureau.contexts.steer`'s `permissionMode`), which
 * {@link ToolApprovalHooksOptions.permissionMode} carries into the hook. {@link decideToolApproval}
 * is the whole rule, as eight rules, strongest first:
 *
 * 1. A tool set to `blocked` is denied.
 * 2. In `read-only` mode every tool that is not read-only is denied: a tool that declares no
 *    capability, and one with a remembered grant, included.
 * 3. A tool set to `always` asks every time, and a remembered grant cannot loosen it.
 * 4. In `always` mode every call asks.
 * 5. A remembered grant skips an `on-changes` ask for that tool in that chat (COR-1828).
 * 6. A tool set to `on-changes`, or to nothing, asks when it changes something, is dangerous, or
 *    declares nothing.
 * 7. In `allow-all` mode that ask is skipped for a tool that declares what it does. It is never
 *    skipped for a tool set to `always` or `blocked`, and a tool that declares nothing still asks.
 * 8. A tool set to `never` runs without asking, unless a rule above applies or it declares nothing.
 *
 * Modes only tighten, except `allow-all`, which skips the asks `on-changes` raises and nothing
 * else. The default mode, `on-changes`, decides by the tool's own setting alone, which is also how
 * a hook given no mode decides: rule 6 is the tool's default and rule 8 its opt-out from it, so a
 * tool set to `never` is not asked about in a chat on `on-changes`.
 *
 * A remembered grant (`remember` on `reviews.resolve`) is consulted for a tool whose value is
 * `on-changes` and for no other, and only when it would change the answer. Because the toolbox
 * composes the hook with its own policy by the most restrictive verdict, a mode or a grant also
 * never loosens an approval policy the toolbox applies itself.
 *
 * @module tool-approval
 */

import type { PermissionMode } from '@lostgradient/operative';
import {
  type ApprovalMode,
  type ApprovalStatus,
  type CapabilityTier,
  evaluateApprovalStatus,
  resolveCapabilityTier,
  type ToolPolicyContext,
  type ToolPolicyDecision,
  type ToolPolicyHooks,
  createApprovalPolicyHooks,
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

/**
 * What a call to a tool of capability `tier` does when its agent's `toolApproval` says nothing
 * about it: `allow`, or `ask`. The default mode never denies, so those are the only two. A tool
 * with no tier (it declares none) asks, because Armorer never lets a call it cannot classify
 * through unasked. The tool catalog reports it as each tool's default approval.
 */
export function defaultToolApproval(tier: CapabilityTier | undefined): 'allow' | 'ask' {
  return evaluateApprovalStatus(tier, ARMORER_MODE[TOOL_APPROVAL_DEFAULT_MODE]) === 'allow'
    ? 'allow'
    : 'ask';
}

/** What {@link decideToolApproval} reads about one call. */
export interface ToolApprovalInput {
  /** The chat's permission mode. */
  readonly mode: PermissionMode;
  /** The tool's `toolApproval` value, `on-changes` when it has none. */
  readonly setting: ToolApprovalMode;
  /** The tool's capability tier, `undefined` when it declares none, which is not read-only. */
  readonly tier: CapabilityTier | undefined;
  /** Whether a person allowed the tool for the rest of this chat. */
  readonly remembered: boolean;
}

/**
 * What a call does, `allow`, `ask` or `deny`: the eight rules in this module's header, in order.
 * Pure, so a table can pin every combination; {@link createToolApprovalHooks} builds the decision
 * a toolbox acts on from it.
 */
export function decideToolApproval(input: ToolApprovalInput): ApprovalStatus {
  const { mode, setting, tier, remembered } = input;
  if (setting === 'blocked') return 'deny';
  if (mode === 'read-only' && tier !== 'read-only') return 'deny';
  if (setting === 'always' || mode === 'always') return 'ask';
  // What is left is `never` and `on-changes`, which the tool's own setting decides.
  const own = evaluateApprovalStatus(tier, ARMORER_MODE[setting]);
  if (own !== 'ask' || setting !== 'on-changes') return own;
  if (remembered) return 'allow';
  return mode === 'allow-all' && tier !== undefined ? 'allow' : 'ask';
}

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
  /**
   * Whether a person allowed `toolName` for the rest of this chat (COR-1828). It is asked, at the
   * time of the call, only for a tool whose value is `on-changes` and only when a grant would
   * change the answer; `true` lets that call through without asking. It is never asked for
   * `always`, `blocked` or `never`, so a grant cannot change what those answer. A rejection counts
   * as `false`: when the grant cannot be read, the call asks.
   */
  readonly remembered?: ((toolName: string) => boolean | Promise<boolean>) | undefined;
  /**
   * The chat's permission mode (COR-1936), read when each call is decided, so a steer applies to
   * the next call. Omitted, the call has no chat (a run outside a session) and the tool's own
   * setting decides, as it does in the default mode. A rejection counts as `read-only`: when the
   * mode cannot be read, a tool that is not read-only is denied, and no call is let through on a
   * guess.
   */
  readonly permissionMode?: (() => PermissionMode | Promise<PermissionMode>) | undefined;
}

/** The mode a chat is in when nothing was set: the tool's own setting decides. */
const DEFAULT_PERMISSION_MODE: PermissionMode = 'on-changes';

/** The decision a toolbox acts on for a call whose verdict is `status`. */
function decisionOf(
  context: ToolPolicyContext,
  tier: CapabilityTier | undefined,
  setting: ToolApprovalMode,
  mode: PermissionMode,
  status: ApprovalStatus,
  modeUnreadable: boolean,
): ToolPolicyDecision {
  if (status === 'allow') return { allow: true, status: 'allow' };
  const tierLabel = tier ?? 'unrecognized';
  if (status === 'deny' && setting !== 'blocked') {
    return {
      allow: false,
      status: 'deny',
      reason: modeUnreadable
        ? `Tool "${context.toolName}" (${tierLabel} tier) is denied because the chat's permission mode could not be read; denying.`
        : `Tool "${context.toolName}" (${tierLabel} tier) is denied because this chat is in ${mode} mode, which allows only read-only tools.`,
    };
  }
  // The Armorer mode whose verdict for this call is `status`, so the reason and the summary of the
  // person's question are Armorer's own.
  const asked: ApprovalMode =
    setting === 'blocked'
      ? 'deny'
      : setting === 'always' || mode === 'always'
        ? 'always'
        : ARMORER_MODE[setting];
  return (
    createApprovalPolicyHooks({ mode: asked }).beforeExecute as (
      context: ToolPolicyContext,
    ) => ToolPolicyDecision
  )(context);
}

/**
 * The policy hook for an agent's tools: each call is decided by the value `toolApproval` gives its
 * tool, or by `options.defaultMode` (`on-changes`) when it gives none, and by the chat's permission
 * mode when `options.permissionMode` gives one ({@link decideToolApproval}). Give the result to a
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
  const { remembered, permissionMode } = options;
  /** Whether the grant is held; a grant that cannot be read is not held. */
  async function granted(toolName: string): Promise<boolean> {
    try {
      return await (remembered as NonNullable<typeof remembered>)(toolName);
    } catch {
      return false;
    }
  }
  /** The chat's mode; one that cannot be read is `read-only`, and is reported as unreadable. */
  async function modeOfChat(): Promise<{ mode: PermissionMode; unreadable: boolean }> {
    if (permissionMode === undefined) return { mode: DEFAULT_PERMISSION_MODE, unreadable: false };
    try {
      return { mode: await permissionMode(), unreadable: false };
    } catch {
      return { mode: 'read-only', unreadable: true };
    }
  }
  return {
    async beforeExecute(context: ToolPolicyContext): Promise<ToolPolicyDecision> {
      if (governed !== undefined && !governed.has(context.toolName)) {
        return { allow: true, status: 'allow' };
      }
      const setting = modes.get(context.toolName) ?? defaultMode;
      const { mode, unreadable } = await modeOfChat();
      const tier = resolveCapabilityTier(context.metadata, context.tags);
      let status = decideToolApproval({ mode, setting, tier, remembered: false });
      // The grant is read only when it would change the answer.
      if (
        status === 'ask' &&
        remembered !== undefined &&
        decideToolApproval({ mode, setting, tier, remembered: true }) === 'allow' &&
        (await granted(context.toolName))
      ) {
        status = 'allow';
      }
      return decisionOf(context, tier, setting, mode, status, unreadable);
    },
  };
}
