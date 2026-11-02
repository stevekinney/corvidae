/**
 * The models an agent allows a session to be switched to (COR-1559): what `bureau.agents.models`
 * reports, and what steering admission checks a `model` override against.
 *
 * The answer is read from the agent itself, not from the deployment alone:
 *
 * - A **file agent** is selectable. Its frontmatter `model` is its default. An optional `models`
 *   list narrows the choice to the listed entries that the deployment's catalog still holds; with
 *   no list, the whole catalog is allowed.
 * - A **code-defined agent** reports what its generation profile says. `selectable` (it named
 *   `allowedCandidates`, or none) offers those candidates the catalog holds, or the whole catalog
 *   when it named none. `fixed` offers its one attached model and cannot be switched. `routed` and
 *   `opaque` offer nothing: Bureau cannot know what such a generate would honor.
 *
 * Each choice is also judged against the deployment's model policy (COR-1996): a model the policy
 * forbids stays in the list, marked `denied`, so a client can show it disabled instead of offering
 * a switch that steering admission would refuse. The list is still what the agent allows; the
 * policy stays enforced at steering admission, at a save and at every run step.
 *
 * @module agent-models
 */

import { type BackendDescriptor, readGenerationProfile } from '@lostgradient/operative';

import type { AgentFileProblem } from './agent-file';
import { usdPricingOfRow } from './file-agent-cost-budget';
import { type BureauModelPolicyOptions, modelPolicyDenialOf } from './model-policy';
import {
  allowedDescriptorsOfFileAgent,
  readFileAgentBinding,
  resolveModelDescriptor,
} from './agent-file-catalog';

/** One model a session can be switched to, named the way a `model` override names it. */
export interface AgentModelChoice {
  readonly provider: string;
  readonly model: string;
  /**
   * What a client shows for the model. The deployment's catalog holds no label of its own, so it
   * is the provider-native model name.
   */
  readonly displayName: string;
  /**
   * Present, as `true`, when the agent has a `costBudget` and the catalog has no price in US
   * dollars for this model (COR-1921): a steer to it is refused, because its spend could not be
   * counted against the budget. Absent for every other choice.
   */
  readonly unpriced?: true;
  /**
   * Present, as `true`, when the deployment's or the Bureau's model policy forbids this model
   * (COR-1996): a steer to it is refused as `policy-denied`, and a save or a run step that names it
   * fails. Absent for every other choice, and for every choice when no policy binds.
   */
  readonly denied?: true;
}

/** The models an agent allows, and which of them it uses when nothing overrides it. */
export interface AgentModels {
  /** How the agent's backend is determined (`GenerationMode`): the kind of profile it has. */
  readonly kind: 'selectable' | 'fixed' | 'routed' | 'opaque';
  /** Whether a session can be switched between models: `true` for a selectable agent only. */
  readonly selectable: boolean;
  /** The models the agent allows, in the order it lists them. Empty for a routed or opaque agent. */
  readonly models: readonly AgentModelChoice[];
  /**
   * The model the agent's next step would use with no override, as the catalog row it resolves to,
   * or `null` when that is not known: a routed or opaque agent, or a selectable code-defined
   * agent whose generate attaches no single model.
   */
  readonly default: AgentModelChoice | null;
}

function choiceOf(
  descriptor: BackendDescriptor,
  policy: BureauModelPolicyOptions | undefined,
  budgeted = false,
): AgentModelChoice {
  return {
    provider: descriptor.provider,
    model: descriptor.model,
    displayName: descriptor.model,
    ...(budgeted && usdPricingOfRow(descriptor) === undefined ? { unpriced: true as const } : {}),
    ...(modelPolicyDenialOf(descriptor, policy) === undefined ? {} : { denied: true as const }),
  };
}

function isDescriptor(value: BackendDescriptor | AgentFileProblem): value is BackendDescriptor {
  return 'provider' in value;
}

function distinct(choices: readonly AgentModelChoice[]): AgentModelChoice[] {
  const seen = new Set<string>();
  return choices.filter((choice) => {
    const key = `${choice.provider}\u0000${choice.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What `agent` allows against `descriptors`, the deployment's catalog as it is now, with the
 * choices that `policy`, the model policy as it is now, forbids marked `denied`.
 */
export function describeAgentModels(
  agent: object,
  descriptors: readonly BackendDescriptor[],
  policy?: BureauModelPolicyOptions,
): AgentModels {
  const binding = readFileAgentBinding(agent);
  if (binding !== undefined) {
    const resolved = resolveModelDescriptor(binding.definition.model, descriptors);
    return {
      kind: 'selectable',
      selectable: true,
      models: distinct(
        allowedDescriptorsOfFileAgent(binding.definition.models, descriptors).map((row) =>
          choiceOf(row, policy, binding.definition.costBudget !== undefined),
        ),
      ),
      default: isDescriptor(resolved) ? choiceOf(resolved, policy) : null,
    };
  }
  const profile = readGenerationProfile(agent);
  const [only] = profile.descriptors;
  const attached =
    profile.descriptors.length === 1 && only !== undefined ? choiceOf(only, policy) : null;
  if (profile.mode === 'selectable') {
    const allowed = profile.allowedCandidates;
    const rows =
      allowed === undefined
        ? descriptors.filter((row) => row.lifecycle !== 'retired')
        : descriptors.filter((row) =>
            allowed.some(
              (candidate) => candidate.provider === row.provider && candidate.model === row.model,
            ),
          );
    return {
      kind: 'selectable',
      selectable: true,
      models: distinct(rows.map((row) => choiceOf(row, policy))),
      default: attached,
    };
  }
  if (profile.mode === 'fixed') {
    return {
      kind: 'fixed',
      selectable: false,
      models: attached === null ? [] : [attached],
      default: attached,
    };
  }
  return { kind: profile.mode, selectable: false, models: [], default: null };
}

/**
 * Whether `models` holds the override: the model name, and the provider as well when the override
 * names one. An override that names no provider matches a model under any provider, which is how a
 * record written before the provider field existed has always matched.
 */
export function allowsModelOverride(
  models: readonly AgentModelChoice[],
  override: { readonly model: string; readonly provider?: string | undefined },
): boolean {
  return models.some(
    (choice) =>
      choice.model === override.model &&
      (override.provider === undefined || choice.provider === override.provider),
  );
}
