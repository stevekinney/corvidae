import type { Validator } from '@lostgradient/operative';

import type { DecideToolWiring } from './decide-tool.ts';
import type { DecisionsComposition } from './create-decisions.ts';
import { bindDecisionValidator } from './decision-validator.ts';
import type { BureauDecisions, DecisionSource } from './types.ts';

/**
 * The decisions of a Bureau that is still being built. A goal validator and a run's toolbox are
 * composed before the model catalog the decisions read exists, so they reach the decisions through
 * this holder, which `compose` fills once they can be built.
 */
export interface LateDecisions {
  /** A {@link DecisionSource} that forwards to the composed decisions. */
  readonly source: DecisionSource;
  /** Binds every {@link decisionValidator} in `validators` to the Bureau's own decisions. */
  bindValidators(validators: readonly Validator[] | undefined): readonly Validator[] | undefined;
  /** Supplies the composed decisions. */
  compose(composition: DecisionsComposition): void;
  /** `Bureau.decisions`. Throws until {@link LateDecisions.compose} has run. */
  readonly decisions: BureauDecisions;
  /**
   * What a run owned by `owner` needs to be offered the `decide` tool, or `undefined` when it is
   * not: `decide: false`, nothing could answer, or `durable` is false.
   */
  toolWiringFor(durable: boolean, owner: string | undefined): DecideToolWiring | undefined;
}

/** Builds a {@link LateDecisions}. `decide` is {@link BureauOptions.decide}. */
export function createLateDecisions(decide: false | undefined): LateDecisions {
  let composition: DecisionsComposition | undefined;
  const composed = (): DecisionsComposition => {
    if (composition === undefined) throw new Error('Decisions are not composed yet.');
    return composition;
  };
  const source: DecisionSource = {
    decide: (request, options) => composed().decisions.decide(request, options),
  };
  return {
    source,
    bindValidators: (validators) =>
      validators?.map((validator) => bindDecisionValidator(validator, source)),
    compose: (next) => {
      composition = next;
    },
    get decisions() {
      return composed().decisions;
    },
    toolWiringFor: (durable, owner) =>
      durable && decide !== false && composition?.configured === true
        ? { decisions: source, maximumPerTask: composition.maximumPerTask, principal: owner }
        : undefined,
  };
}
