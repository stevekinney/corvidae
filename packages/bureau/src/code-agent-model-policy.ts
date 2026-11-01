/**
 * Holds a plugin code agent's generate to the model policy (COR-1996).
 *
 * A file agent's generate checks the policy itself (`createFileAgentGenerate`, COR-1980). A code
 * agent's generate is whatever its plugin built, so Bureau cannot see inside it. What it can see
 * is the catalog rows the generate reports through `withBackendDescriptors`, and the model a step
 * is steered to, and a step is judged by those:
 *
 * - a step steered to a model is judged by the rows of that name that the generate itself reports,
 *   or, when it reports none, by the model catalog's rows of that name, as steering admission
 *   judges it. It is refused only when the policy forbids every one of them, and not judged when
 *   no row has that name, which the agent's own generate then reports;
 * - any other step is judged by the one row of a fixed agent, a generate that reports exactly one
 *   row (the platform's own definition of fixed).
 *
 * A generate that reports no row (an opaque agent) is judged only by a steered model. A routed
 * agent, one that reports several rows, is not judged unsteered: whichever row its router picks,
 * Bureau cannot tell, and a union a fallback marks incomplete may hide a row that is not reported.
 * Steering admission still refuses a switch to a forbidden model before it applies.
 *
 * @module code-agent-model-policy
 */

import {
  type BackendDescriptor,
  composeGenerate,
  type GenerateContext,
  type GenerateFunction,
  type GenerateMiddleware,
  readBackendDescriptors,
} from '@lostgradient/operative';

import { ModelPolicyDeniedError } from './file-agent-generate';
import { type BureauModelPolicyOptions, modelPolicyDenialOf } from './model-policy';

/** Where a held generate reads the model policy and the model catalog, at every step. */
export interface ModelPolicySource {
  /** The model policy now in force. */
  readonly current: () => BureauModelPolicyOptions | undefined;
  /** The model catalog's rows now, which a steered model is named against. */
  readonly catalog: () => readonly BackendDescriptor[];
}

/** The rows a step can use, or none when it cannot be judged. */
function rowsOfStep(
  attached: readonly BackendDescriptor[],
  catalog: () => readonly BackendDescriptor[],
  steering: GenerateContext['steering'],
): readonly BackendDescriptor[] {
  const model = steering?.model;
  if (model === undefined) return attached.length === 1 ? attached : [];
  const provider = steering?.modelProvider;
  const named = (row: BackendDescriptor): boolean =>
    row.model === model && (provider === undefined || row.provider === provider);
  // The generate's own rows first: it cannot say which row it used, so a name it serves is the
  // row it serves, and another provider's allowed row of the same name must not stand in for it.
  const own = attached.filter(named);
  return own.length > 0 ? own : catalog().filter(named);
}

function modelPolicyMiddleware(source: ModelPolicySource): GenerateMiddleware {
  return (next) => {
    const attached = readBackendDescriptors(next);
    return (context) => {
      const policy = source.current();
      if (policy === undefined) return next(context);
      let refusal: ModelPolicyDeniedError | undefined;
      for (const row of rowsOfStep(attached, source.catalog, context.steering)) {
        const denial = modelPolicyDenialOf(row, policy);
        if (denial === undefined) return next(context);
        refusal ??= new ModelPolicyDeniedError(row, denial);
      }
      return refusal === undefined ? next(context) : Promise.reject(refusal);
    };
  };
}

/**
 * `generate`, refusing a step with a {@link ModelPolicyDeniedError}, before it is called, when the
 * policy forbids every catalog row the step can use. It keeps the descriptors `generate` reports.
 */
export function holdGenerateToModelPolicy(
  generate: GenerateFunction,
  source: ModelPolicySource,
): GenerateFunction {
  return composeGenerate(generate, modelPolicyMiddleware(source));
}
