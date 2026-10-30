import type { DecisionModel } from '@lostgradient/operative';

import type { DecisionsOptions } from './types.ts';

/** The name {@link hosted} registers its model under. */
export const HOSTED_DECISION_MODEL = 'host';

/** `decisions` options that register `model` as the one decision model and make it the default. */
export function hosted(model: DecisionModel): DecisionsOptions {
  return { models: { [HOSTED_DECISION_MODEL]: model }, model: HOSTED_DECISION_MODEL };
}
