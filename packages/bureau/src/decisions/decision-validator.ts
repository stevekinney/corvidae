import type {
  Decision,
  DecisionRequest,
  Validator,
  ValidatorInput,
  ValidatorOutcome,
} from '@lostgradient/operative';

import type { DecisionSource } from './types.ts';

/** What {@link decisionValidator} is built from. */
export interface DecisionValidatorOptions {
  /** The validator's registered name. A goal names its validator by `name` and `version`. */
  readonly name: string;
  /** The validator's registered version. */
  readonly version: string;
  /** Builds the question from the attempt being judged. */
  readonly request: (input: ValidatorInput) => DecisionRequest;
  /** Turns the model's answer into the verdict: `pass`, or `fail` with feedback for the retry. */
  readonly verdict: (decision: Decision<unknown>) => ValidatorOutcome;
}

const bindings = new WeakMap<Validator, DecisionValidatorOptions>();

/**
 * A goal validator that asks a decision. It reports `determinism: 'stochastic'`: a model's verdict
 * is not evidence a goal that requires deterministic validation may accept.
 *
 * Pass it in `createBureau({ validators })` like any validator. Bureau answers its question with
 * its own `decisions`, so the validator holds no model and runs only in a Bureau that has one; a
 * validator used outside one is `indeterminate`.
 */
export function decisionValidator(options: DecisionValidatorOptions): Validator {
  const { name, version, request, verdict } = options;
  const validator: Validator = {
    identity: { name, version },
    determinism: 'stochastic',
    validate: () => ({
      kind: 'indeterminate',
      reason: `Validator "${name}" must be registered with createBureau({ validators }) to ask a decision.`,
    }),
  };
  bindings.set(validator, { name, version, request, verdict });
  return validator;
}

/**
 * Returns `validator` bound to `decisions` when it came from {@link decisionValidator}; any other
 * validator is returned as is. Bureau applies this to every validator it is given.
 */
export function bindDecisionValidator(validator: Validator, decisions: DecisionSource): Validator {
  const binding = bindings.get(validator);
  if (binding === undefined) return validator;
  return {
    identity: validator.identity,
    determinism: 'stochastic',
    validate: async (input, signal) => {
      const decision = await decisions.decide(binding.request(input), { signal });
      return binding.verdict(decision);
    },
  };
}
