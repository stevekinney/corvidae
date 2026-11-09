/**
 * COR-2127 — the one place Bureau composes a run's hook plan from its tiers.
 *
 * A run Bureau starts, resumes, reattaches or dispatches holds one plan: Bureau's own tier, the
 * `plugin` tier (every interceptor a plugin applies to every agent), and the agent's own tier, each
 * in its fixed priority band (`HOOK_TIER_PRIORITY_BANDS`). Every Bureau site composes through
 * {@link composeRunHooks}, which builds the plugin tier itself, so a site cannot leave it out;
 * `run-hook-tiers.test.ts` fails when a Bureau source file calls `mergeHookRegistries` anywhere
 * else. A child of a Bureau-owned run receives the same plugin tier from {@link pluginHookTier}
 * through Operative's child seam (`composeBureauInvariantsIntoChild`).
 *
 * The plugin tier is built from the contributions at the moment of composition, never persisted: a
 * durable run that resumes after a restart is composed here again and gets the tier the restarted
 * Bureau's plugins contribute.
 *
 * @module run-hook-tiers
 */

import { type HookRegistry, mergeHookRegistries } from '@lostgradient/lifecycle';
import type { OperativeHookMap } from '@lostgradient/operative';

import {
  type AgentContributions,
  everyAgentInterceptorsOf,
  NO_AGENT_CONTRIBUTIONS,
} from './agent-contributions';

/** The two tiers a composition site holds for one run; the plugin tier is the helper's to add. */
export interface RunHookTiers {
  /** Bureau's own tier for the run, or `undefined` when it has none. */
  readonly bureau: HookRegistry<OperativeHookMap> | undefined;
  /** The run's agent tier, or `undefined` when its agent has none. */
  readonly agent: HookRegistry<OperativeHookMap> | undefined;
}

/**
 * The `plugin` tier for one run: a fresh registry of every interceptor `contributions` holds that
 * applies to every agent, or `undefined` when none does.
 */
export function pluginHookTier(
  contributions: AgentContributions | undefined,
): HookRegistry<OperativeHookMap> | undefined {
  return everyAgentInterceptorsOf(contributions ?? NO_AGENT_CONTRIBUTIONS);
}

/**
 * One run's hook plan: `tiers.bureau`, the plugin tier `contributions` gives, and `tiers.agent`,
 * merged into a fresh registry, so a registration added to a tier afterwards cannot reach the run.
 */
export function composeRunHooks(
  contributions: AgentContributions | undefined,
  tiers: RunHookTiers,
): HookRegistry<OperativeHookMap> {
  return mergeHookRegistries({
    bureau: tiers.bureau,
    plugin: pluginHookTier(contributions),
    agent: tiers.agent,
  });
}
