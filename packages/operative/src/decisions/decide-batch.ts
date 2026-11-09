import type { TokenUsage } from 'conversationalist';

import { DecisionSchemaError } from './errors';
import { assertValidDecisionRequest } from './request-validation';
import type {
  DecideOptions,
  Decision,
  DecisionBatch,
  DecisionBatchResult,
  DecisionModel,
  DecisionQuestion,
  DecisionRequest,
} from './types';
import { addTokenUsage } from './usage';

/** Puts the batch's context on one question, making the request {@link DecisionModel.decide} takes. */
function withContext(question: DecisionQuestion, context: string | undefined): DecisionRequest {
  return context === undefined ? { ...question } : { ...question, context };
}

/**
 * Rejects a malformed {@link DecisionBatch} before any provider is called: it
 * needs a text context or none, at least one question in a `Map`, a non-empty
 * name for every question, and every question valid as a
 * {@link DecisionRequest}. A question may not carry its own `context`, because
 * the batch's context is the one every question reads.
 *
 * @throws {TypeError} Naming the first violation.
 */
export function assertValidDecisionBatch(batch: DecisionBatch): void {
  if (typeof batch !== 'object' || batch === null) {
    throw new TypeError('A decision batch must be an object.');
  }
  if (batch.context !== undefined && typeof batch.context !== 'string') {
    throw new TypeError('A decision batch context must be text.');
  }
  if (!(batch.questions instanceof Map) || batch.questions.size === 0) {
    throw new TypeError('A decision batch needs a Map with at least one question.');
  }
  for (const [name, question] of batch.questions) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('Every question in a decision batch needs a non-empty name.');
    }
    if (typeof question === 'object' && question !== null && 'context' in question) {
      throw new TypeError(
        `Question "${name}" carries its own context; a batch's questions share the batch's context.`,
      );
    }
    try {
      assertValidDecisionRequest(withContext(question, batch.context));
    } catch (error) {
      throw new TypeError(`Question "${name}": ${(error as Error).message}`, { cause: error });
    }
  }
}

function withoutUsage(decision: Decision<unknown>): Decision<unknown> {
  const { usage: _usage, ...rest } = decision;
  return rest;
}

/**
 * Answers every question in `batch` with `model`. A model with a
 * {@link DecisionModel.decideBatch} method answers them in one provider
 * request; any other model is asked one question at a time, in the batch's
 * order, through {@link DecisionModel.decide}, and the usage of every request
 * is summed onto the result. Either way each decision carries no usage of its
 * own.
 *
 * The batch is validated and copied before the first `await`, so a caller may
 * reuse its `Map` once this returns a promise. Every question's kind must be
 * one of `model.kinds`. The first failing question rejects the whole batch:
 * answers already given are not returned.
 *
 * @throws {TypeError} When the batch is malformed or the model cannot answer a question's kind.
 * @throws {DecisionSchemaError} When a model's batch answer leaves a question out.
 */
export async function decideBatch(
  model: DecisionModel,
  batch: DecisionBatch,
  options?: DecideOptions,
): Promise<DecisionBatchResult> {
  assertValidDecisionBatch(batch);
  const context = batch.context;
  const entries = [...batch.questions];
  for (const [name, question] of entries) {
    if (!model.kinds.has(question.kind)) {
      throw new TypeError(`${model.name} cannot answer the ${question.kind} question "${name}".`);
    }
  }

  if (typeof model.decideBatch === 'function') {
    const snapshot: DecisionBatch = {
      ...(context === undefined ? {} : { context }),
      questions: new Map(entries),
    };
    const result = await model.decideBatch(snapshot, options);
    const decisions = new Map<string, Decision<unknown>>();
    for (const [name] of entries) {
      const decision = result.decisions.get(name);
      if (decision === undefined) {
        throw new DecisionSchemaError({
          attempts: 1,
          usage: result.usage,
          validation: `${model.name} returned no answer to question "${name}".`,
        });
      }
      decisions.set(name, withoutUsage(decision));
    }
    return { decisions, ...(result.usage === undefined ? {} : { usage: result.usage }) };
  }

  const decisions = new Map<string, Decision<unknown>>();
  let usage: TokenUsage | undefined;
  for (const [name, question] of entries) {
    options?.signal?.throwIfAborted();
    const decision = await model.decide(withContext(question, context), options);
    usage = addTokenUsage(usage, decision.usage);
    decisions.set(name, withoutUsage(decision));
  }
  return { decisions, ...(usage === undefined ? {} : { usage }) };
}
