import { OPERATIVE_RESOLVE_RUN_OPTIONS, type RunOptions } from '@lostgradient/operative';

import type { AgentDefinitions } from '../agent-catalog';

/**
 * `agent`, whose resolution also returns `extra`: the run options `createAgent` has no option for
 * (`schemaRetries`, `schemaRetryMessage`, `maximumTokens`), so a test can give an agent the shape
 * a hand-written definition resolver would.
 */
export function withResolvedOptions<TAgent extends AgentDefinitions[string]>(
  agent: TAgent,
  extra: Partial<RunOptions>,
): TAgent {
  const resolve = Reflect.get(agent, OPERATIVE_RESOLVE_RUN_OPTIONS) as (
    ...args: unknown[]
  ) => Promise<RunOptions>;
  return {
    ...agent,
    [OPERATIVE_RESOLVE_RUN_OPTIONS]: async (...args: unknown[]) => ({
      ...(await resolve.apply(agent, args)),
      ...extra,
    }),
  };
}
