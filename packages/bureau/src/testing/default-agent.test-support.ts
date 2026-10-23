/**
 * Test scaffolding for the Bureau-wide run fields that `BureauOptions` no longer declares
 * (COR-323): every run belongs to a catalog agent, which owns its own `generate`, tools, stop
 * condition, guardrails, skills, step cap, and instructions. A test that only needs "an agent that
 * answers with this model" passes those fields here and gets the `default` catalog agent back.
 */

import type { AgentDefinitions } from '../agent-catalog';
import type { CreateAgentOptions } from '@lostgradient/operative';
import { createAgent, createModelCatalog } from '@lostgradient/operative';

/** The catalog name {@link withDefaultAgent} registers the agent under. */
export const DEFAULT_AGENT_NAME = 'default';

/** The agent-owned fields a test hands to {@link withDefaultAgent}. */
export type DefaultAgentFields = Partial<
  Pick<
    CreateAgentOptions,
    'generate' | 'toolbox' | 'stopWhen' | 'guardrails' | 'skills' | 'maximumSteps'
  >
> & { readonly systemPrompt?: string | undefined };

const FIELD_NAMES = [
  'generate',
  'toolbox',
  'stopWhen',
  'guardrails',
  'skills',
  'maximumSteps',
  'systemPrompt',
] as const;

/**
 * Moves the agent-owned fields out of `options` and into a `default` catalog agent. Options that
 * carry none of them are returned untouched, so a Bureau a test builds with its own `agents` keeps
 * exactly those. An existing `agents.default` wins over the fields.
 */
export function withDefaultAgent<
  T extends { agents?: AgentDefinitions | undefined } & DefaultAgentFields,
>(options: T): Omit<T, (typeof FIELD_NAMES)[number]> & { agents: AgentDefinitions } {
  const { generate, toolbox, stopWhen, guardrails, skills, maximumSteps, systemPrompt, ...rest } =
    options;
  const agents: AgentDefinitions = { ...(rest.agents ?? {}) };
  if (generate !== undefined && agents[DEFAULT_AGENT_NAME] === undefined) {
    agents[DEFAULT_AGENT_NAME] = createAgent({
      generate,
      ...(toolbox === undefined ? {} : { toolbox }),
      ...(stopWhen === undefined ? {} : { stopWhen }),
      ...(guardrails === undefined ? {} : { guardrails }),
      ...(skills === undefined ? {} : { skills }),
      ...(maximumSteps === undefined ? {} : { maximumSteps }),
      ...(systemPrompt === undefined ? {} : { instructions: systemPrompt }),
    } as CreateAgentOptions);
  }
  return { ...rest, agents } as Omit<T, (typeof FIELD_NAMES)[number]> & {
    agents: AgentDefinitions;
  };
}

/**
 * Every model the static catalog describes, as an agent's `allowedCandidates`. A steering `model`
 * override is held to what the session's agent allows (COR-1559), so a test that steers a model
 * by name gives its agent this.
 */
export const STEERABLE_MODELS = createModelCatalog().descriptors.map(({ provider, model }) => ({
  provider,
  model,
}));
