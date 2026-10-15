/**
 * The worker half of the off-thread evaluator (COR-254), free of any worker global so a test
 * drives it directly: it keeps the bases it was sent and answers each request with the
 * in-thread evaluator's result.
 */

import type { ThemeBase } from './theme-draft-types.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import type { EvaluationRequest, EvaluationResponse } from './theme-worker-evaluator.ts';

export function createEvaluationHandler(
  reply: (response: EvaluationResponse) => void,
): (request: EvaluationRequest) => void {
  const evaluator = createRuntimeEvaluator();
  const bases = new Map<number, ThemeBase>();
  return ({ id, baseId, base, source, revision, context }) => {
    if (base !== undefined) bases.set(baseId, base);
    const known = bases.get(baseId);
    if (known === undefined) {
      reply({ id, failure: `the theme base ${baseId} was never sent` });
      return;
    }
    evaluator.evaluate({ ...source, base: known }, revision, context).then(
      (evaluation) => reply({ id, evaluation }),
      (error: unknown) =>
        reply({ id, failure: error instanceof Error ? error.message : String(error) }),
    );
  };
}
