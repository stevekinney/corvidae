import type { AgentDefinitions, AgentNames } from '../agent-catalog.ts';
import { BureauError } from '../bureau-errors.ts';
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
 *
 * The decision is asked before any run exists, so it names the supervisor's routing step: the
 * `routingId` of the strategy's `RoutingContext` goes to `decide`, which records it on the
 * `decision.made` record, and the runs the step starts take their ids from it (COR-2420).
 */
export function createDecisionRouting<D extends AgentDefinitions>(
  decisions: DecisionSource,
  options: DecisionRoutingOptions = {},
): RoutingStrategy<D> {
  const { principal } = options;
  return async (task, descriptors, context) => {
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
      {
        ...(principal === undefined ? {} : { principal }),
        ...(context === undefined ? {} : { routingId: context.routingId }),
      },
    );
    return decision.value as AgentNames<D>;
  };
}
