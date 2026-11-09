/**
 * Composes Bureau's invariant hook tier into a child run (COR-2106). See
 * `bureau-invariants.ts` for what travels and why.
 */

import { mergeHookRegistries } from '@lostgradient/lifecycle';

import { resolvesOwnGuardrails } from './agent-policy';
import { createAgentRun } from './agent-run';
import { type BureauChildInvariants, withBureauInvariants } from './bureau-invariants';
import { createDeferredAgentRun } from './create-lazy-agent';
import { createActiveRun } from './create-run';
import { AgentContractError } from './errors';
import {
  type AgentInput,
  type AgentRunContext,
  type DefinitionResolvingAgentWithResolver,
  hasDefinitionResolver,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type RunnableAgent,
} from './runnable-agent';
import type { RunOptions } from './types';

/**
 * Wraps a child's agent so a run of it carries Bureau's invariants. The single
 * seam where a Bureau-owned parent's tiers reach a child: Bureau's own, and the
 * interceptor sets plugins apply to every agent (COR-2127).
 *
 * Refuses an agent with no `OPERATIVE_RESOLVE_RUN_OPTIONS` synchronously with an
 * `AgentContractError` that names it. Otherwise the returned agent resolves the
 * child's own options, merges Bureau's and the plugin tier's registries in front
 * of the child's tier, and starts the run itself, so it never goes through the
 * agent's `run()`.
 *
 * @internal
 */
export function composeBureauInvariantsIntoChild<O, H extends boolean>(
  agent: RunnableAgent<O, H>,
  agentName: string,
  invariants: BureauChildInvariants,
): RunnableAgent<O, H> {
  if (!hasDefinitionResolver(agent)) {
    throw refusal(agentName);
  }
  const agentResolvesGuardrails = resolvesOwnGuardrails(agent);
  return {
    name: agent.name,
    get hasOutput(): boolean {
      return agent.hasOutput;
    },
    run(input: AgentInput, context?: AgentRunContext) {
      // The child's guardrail policy, as a catalog dispatch hands it: an agent that
      // resolves its own applies it itself, any other is told it inherits none.
      const childContext: AgentRunContext = {
        ...context,
        ...(agentResolvesGuardrails ? {} : { inheritedGuardrails: false as const }),
      };
      return createDeferredAgentRun<O, H>(
        async () => {
          // Through the agent, so a method-shaped resolver keeps its receiver.
          const resolved = await resolveOrRefuse(agent, agentName, input, childContext);
          return startComposedRun<O, H>(agentName, resolved, invariants, agentResolvesGuardrails);
        },
        input,
        childContext,
        agentName,
      );
    },
  };
}

/**
 * Resolves the child's options, turning a `createLazyAgent` wrapper's "does not support definition
 * resolution" into the same refusal an agent with no resolver gets, naming the child. The wrapper
 * exposes the resolver unconditionally and only learns on invocation that its module has none.
 */
async function resolveOrRefuse(
  agent: DefinitionResolvingAgentWithResolver,
  agentName: string,
  input: AgentInput,
  context: AgentRunContext,
): Promise<RunOptions> {
  try {
    return await agent[OPERATIVE_RESOLVE_RUN_OPTIONS](input, context);
  } catch (error) {
    if (error instanceof AgentContractError) throw refusal(agentName, error);
    throw error;
  }
}

function refusal(agentName: string, cause?: AgentContractError): AgentContractError {
  return new AgentContractError(
    `Child agent "${agentName}" exposes no run-options resolver, so Bureau's invariant hooks cannot reach it and it cannot be dispatched` +
      (cause === undefined ? '' : `: ${cause.message}`),
    cause ?? undefined,
  );
}

function startComposedRun<O, H extends boolean>(
  agentName: string,
  resolved: RunOptions,
  invariants: BureauChildInvariants,
  agentResolvesGuardrails: boolean,
): RunnableAgent<O, H> {
  // Bureau first, so it wins `runFirst` and, being pinned last, still wins the waterfall; the
  // plugin tier between it and the child's own. The factory is attached again so this child's own
  // children inherit it, whatever its resolver did.
  const tiers = invariants({ agentResolvesGuardrails });
  const merged: RunOptions = withBureauInvariants(
    {
      ...resolved,
      hooks: mergeHookRegistries({
        bureau: tiers.bureau,
        plugin: tiers.plugin,
        agent: resolved.hooks,
      }),
    },
    invariants,
  );
  const hasOutput = merged.output !== undefined;
  return {
    name: agentName,
    hasOutput,
    run: () => {
      const activeRun = createActiveRun(
        merged,
        undefined,
        merged.principal === undefined ? undefined : { owner: merged.principal },
      );
      return createAgentRun<O, H>(activeRun, { hasOutput });
    },
  };
}
