/**
 * The generate a file agent runs with (COR-1559).
 *
 * A file agent is selectable: its frontmatter `model` is its default, and a session can be
 * switched to another model its file allows. A switch reaches a step through that step's
 * `context.steering`, the snapshot the step boundary read, so this wrapper picks its model for
 * each call from that call's own steering. It reads no session, no gate, and no earlier step.
 *
 * A step told to use a model that can no longer be used fails with a
 * {@link ModelOverrideUnusableError} naming it. That covers a model a hand edit has dropped from
 * the file's `models`, one the catalog has since retired or removed, and one the host's resolver
 * now throws for. It never calls the default instead: the session's override is the owner's
 * choice, and silently answering with another model would hide that it no longer holds.
 *
 * A step whose model the model policy forbids (COR-1980) fails with a {@link ModelPolicyDeniedError}
 * before the provider is called, whether the model is the file's default, as a file saved before the
 * policy tightened still has, or the one the session was switched to. The policy is read at every
 * step, so a change applies from the next one; a call already in flight finishes. It never falls
 * back to another model either.
 *
 * @module file-agent-generate
 */

import {
  type BackendDescriptor,
  BudgetExceededError,
  type GenerateContext,
  type GenerateFunction,
  NonRecoverablePolicyError,
  readBackendDescriptors,
  withBackendDescriptors,
} from '@lostgradient/operative';

import { usdPricingOfRow } from './file-agent-cost-budget';
import type { ModelPolicyDenial } from './model-policy';

/** Why a step's model override could not be used. */
export type ModelOverrideUnusableReason = 'not-allowed' | 'cannot-be-set-up';

/**
 * A step was told to use a model its agent can no longer use. It names the model, and the
 * provider when the override named one.
 */
export class ModelOverrideUnusableError extends Error {
  readonly code = 'model-override-unusable';
  readonly model: string;
  readonly provider: string | undefined;
  readonly reason: ModelOverrideUnusableReason;

  constructor(
    model: string,
    provider: string | undefined,
    reason: ModelOverrideUnusableReason,
    cause?: unknown,
  ) {
    const name = provider === undefined ? model : `${provider}/${model}`;
    super(
      reason === 'not-allowed'
        ? `The session was switched to the model "${name}", which this agent no longer allows.`
        : `The session was switched to the model "${name}", which could not be set up.${
            cause instanceof Error ? ` ${cause.message}` : ''
          }`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ModelOverrideUnusableError';
    this.model = model;
    this.provider = provider;
    this.reason = reason;
  }
}

/**
 * A step was told to use a model the model policy forbids (COR-1980). It names the model and the
 * layer that denied it, and no provider was called. It is a {@link NonRecoverablePolicyError}
 * (COR-1996), so a run hook's `onError` cannot `skip` or `retry` it and the run ends with this
 * error rather than with `MAXIMUM_STEPS`.
 */
export class ModelPolicyDeniedError extends NonRecoverablePolicyError {
  /** The stable code for this failure, the same as the `AgentFileError` a write is refused with. */
  readonly code = 'model-policy-denied';
  /** The provider of the forbidden catalog row. */
  readonly provider: string;
  /** The forbidden model, as the catalog names it. */
  readonly model: string;
  /** The first layer to deny the model: the deployment's, or the Bureau's. */
  readonly layer: ModelPolicyDenial['layer'];
  /** The revision of the policy that decided. */
  readonly policyRevision: number;

  constructor(row: Pick<BackendDescriptor, 'provider' | 'model'>, denial: ModelPolicyDenial) {
    super(
      `The model "${row.provider}/${row.model}" is forbidden by the ${denial.layer} model policy (${denial.reason}), so the step was not run.`,
    );
    this.name = 'ModelPolicyDeniedError';
    this.provider = row.provider;
    this.model = row.model;
    this.layer = denial.layer;
    this.policyRevision = denial.policyRevision;
  }
}

/** What {@link createFileAgentGenerate} is built from. */
export interface FileAgentGenerateOptions {
  /** The generate for the agent's default model, used for every step that is not switched. */
  readonly defaultGenerate: GenerateFunction;
  /** The catalog row the default model resolved to. */
  readonly defaultDescriptor: BackendDescriptor;
  /**
   * The catalog rows the agent allows now: its `models` list, or the catalog when it lists none,
   * read against the catalog as it is at the step. It is asked for on every switched step.
   */
  readonly allowed: () => readonly BackendDescriptor[];
  /** Turns a catalog row into the generate a run calls. May throw for a model it cannot set up. */
  readonly resolveGenerate: (descriptor: BackendDescriptor) => GenerateFunction;
  /**
   * The agent has a `costBudget` (COR-1921). A step whose chosen row has no price in US dollars
   * then ends the run with `budget-exceeded` before the model is asked: the run's pricing is
   * keyed by name, and a name can reach a row other than the one it was priced from.
   */
  readonly costBudgeted?: boolean;
  /**
   * Why the model policy forbids a catalog row, or `undefined` when it does not (COR-1980). It is
   * read for the row each step uses, so a policy that changed since the agent was built applies
   * from the next step. Omitted, nothing is forbidden.
   */
  readonly policyDenial?: ((row: BackendDescriptor) => ModelPolicyDenial | undefined) | undefined;
}

function sameRow(left: BackendDescriptor, right: BackendDescriptor): boolean {
  return left.provider === right.provider && left.model === right.model;
}

/**
 * The generate a file agent runs with: the default model's, or the model a step's steering names.
 * It carries the default's attached descriptors, so the agent reads as the one it always was.
 */
export function createFileAgentGenerate(options: FileAgentGenerateOptions): GenerateFunction {
  const { defaultGenerate, defaultDescriptor, allowed, resolveGenerate, costBudgeted } = options;
  const refusedByPolicy = (row: BackendDescriptor): Promise<never> | undefined => {
    const denial = options.policyDenial?.(row);
    return denial === undefined
      ? undefined
      : Promise.reject(new ModelPolicyDeniedError(row, denial));
  };
  // A model's generate is resolved once, the first step that needs it: resolving may build a
  // client, and the key is the pair, so two providers serving one model name stay apart.
  const resolved = new Map<string, GenerateFunction>();

  const generate: GenerateFunction = (context: GenerateContext) => {
    const model = context.steering?.model;
    if (model === undefined) {
      return refusedByPolicy(defaultDescriptor) ?? defaultGenerate(context);
    }
    const provider = context.steering?.modelProvider;
    const row = allowed().find(
      (candidate) =>
        candidate.model === model && (provider === undefined || candidate.provider === provider),
    );
    if (row === undefined) {
      return Promise.reject(new ModelOverrideUnusableError(model, provider, 'not-allowed'));
    }
    const forbidden = refusedByPolicy(row);
    if (forbidden !== undefined) return forbidden;
    if (sameRow(row, defaultDescriptor)) return defaultGenerate(context);
    if (costBudgeted === true && usdPricingOfRow(row) === undefined) {
      return Promise.reject(
        new BudgetExceededError(
          `The session runs on the model "${row.model}" from "${row.provider}", which has no price in US dollars in the model catalog, so its spend cannot be counted against the agent's costBudget.`,
        ),
      );
    }
    const key = JSON.stringify([row.provider, row.model]);
    let chosen = resolved.get(key);
    if (chosen === undefined) {
      try {
        chosen = resolveGenerate(row);
      } catch (error) {
        return Promise.reject(
          new ModelOverrideUnusableError(model, provider, 'cannot-be-set-up', error),
        );
      }
      resolved.set(key, chosen);
    }
    return chosen(context);
  };

  const attached = readBackendDescriptors(defaultGenerate);
  return attached.length === 0 ? generate : withBackendDescriptors(generate, attached);
}
