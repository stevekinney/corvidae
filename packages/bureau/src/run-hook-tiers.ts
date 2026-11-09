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
 * An agent that lists an every-agent interceptor has it in its own tier, gated as a chosen
 * interceptor is, so it refuses while its plugin needs setup; that run's plugin tier leaves it out,
 * so it registers once. In every other run the plugin tier turns the plugin's refusal into "no
 * answer" without running the handler, so a missing secret never fails an agent that did not
 * choose the set (ruling on COR-2127 decision 4, 2026-11-09).
 *
 * The plugin tier is built from the contributions at the moment of composition, never persisted: a
 * durable run that resumes after a restart is composed here again and gets the tier the restarted
 * Bureau's plugins contribute.
 *
 * @module run-hook-tiers
 */

import { HookRegistry, mergeHookRegistries } from '@lostgradient/lifecycle';
import type { OperativeHookMap } from '@lostgradient/operative';

import {
  type AgentContributions,
  everyAgentInterceptorsOf,
  NO_AGENT_CONTRIBUTIONS,
} from './agent-contributions';
import { PluginNeedsSetupError } from './plugins/plugin-secret-gate';

/** The two tiers a composition site holds for one run; the plugin tier is the helper's to add. */
export interface RunHookTiers {
  /** Bureau's own tier for the run, or `undefined` when it has none. */
  readonly bureau: HookRegistry<OperativeHookMap> | undefined;
  /** The run's agent tier, or `undefined` when its agent has none. */
  readonly agent: HookRegistry<OperativeHookMap> | undefined;
}

/**
 * `handler`, answering `undefined` instead of the refusal of `plugin` while that plugin needs setup.
 * The gate refuses before the plugin's own handler is called, so the handler does not run.
 */
function skippingRefusal(
  plugin: string | undefined,
  handler: (...args: never[]) => unknown,
): (...args: never[]) => Promise<unknown> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof PluginNeedsSetupError && error.plugin === plugin) return undefined;
      throw error;
    }
  };
}

/**
 * The `plugin` tier for one run: a fresh registry of every interceptor `contributions` holds that
 * applies to every agent, less any entry `agentTier` already holds under the same id (an agent that
 * lists the set), or `undefined` when nothing is left. Each handler skips its plugin's needs-setup
 * refusal rather than fail the run.
 */
export function pluginHookTier(
  contributions: AgentContributions | undefined,
  agentTier?: HookRegistry<OperativeHookMap>,
): HookRegistry<OperativeHookMap> | undefined {
  const everyAgent = everyAgentInterceptorsOf(contributions ?? NO_AGENT_CONTRIBUTIONS);
  if (everyAgent === undefined) return undefined;
  const listed = new Set<string>();
  for (const hookName of agentTier?.getHookNames() ?? []) {
    for (const entry of agentTier?.getHandlers(hookName) ?? []) listed.add(entry.id);
  }
  const tier = new HookRegistry<OperativeHookMap>();
  for (const hookName of everyAgent.getHookNames()) {
    for (const entry of everyAgent.getHandlers(hookName)) {
      if (listed.has(entry.id)) continue;
      tier.on(hookName, skippingRefusal(entry.options.source, entry.handler), {
        ...entry.options,
        id: entry.id,
      });
    }
  }
  return tier.getHookNames().length === 0 ? undefined : tier;
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
    plugin: pluginHookTier(contributions, tiers.agent),
    agent: tiers.agent,
  });
}
