import type { AgentDefinitions, AgentNames } from '../agent-catalog.ts';
import { BureauError } from '../create-bureau.ts';
import type { RoutingStrategy } from '../supervisor-contracts.ts';
import type { DecisionSource } from './types.ts';

/** Options of {@link createDecisionRouting}. */
export interface DecisionRoutingOptions {
  /** Who is asking, for the decision's audit record. */
  readonly principal?: string;
}

/**
 * A `createSupervisor` routing strategy that asks `decisions` which agent should take a task.
 *
 * It puts a `choice` over every agent the catalog lists (an agent's `description` is the option's
 * label, its name when it has none) and returns the one the model names. A catalog with no agent
 * throws `BureauError` `NOT_FOUND`; one agent is returned without asking anything. A decision
 * that cannot be made, `NOT_CONFIGURED` or `DecisionSchemaError`, propagates as the supervisor's
 * error.
 */
export function createDecisionRouting<D extends AgentDefinitions>(
  decisions: DecisionSource,
  options: DecisionRoutingOptions = {},
): RoutingStrategy<D> {
  const { principal } = options;
  return async (task, descriptors) => {
    const [only, ...rest] = descriptors;
    if (only === undefined) {
      throw new BureauError('No agent is available to route the task to', 'NOT_FOUND');
    }
    if (rest.length === 0) return only.name;
    const decision = await decisions.decide(
      {
        kind: 'choice',
        question: `Which agent should take this task?\n\n${task}`,
        options: descriptors.map((descriptor) => ({
          key: descriptor.name,
          label: descriptor.description ?? descriptor.name,
        })),
      },
      principal === undefined ? {} : { principal },
    );
    return decision.value as AgentNames<D>;
  };
}
