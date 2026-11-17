/**
 * Scorers and goal validators that ask a decision (COR-2204). Each takes the plugin's
 * `host.decisions`, so every call is made as the plugin and filed under the run or goal it judges.
 * A failed decision is never rethrown: the helper maps it to an outcome (`canceled`, `unavailable`
 * or `error`) whose text is fixed and names an identifier, so a provider's message reaches neither
 * a score's record nor a validator error, both of which are read back.
 *
 * @module decision-helpers
 */

import type {
  Decision,
  DecisionKind,
  DecisionQuestion,
  DecisionRequest,
  RunResult,
  Validator,
  ValidatorInput,
  ValidatorOutcome,
} from '@lostgradient/operative';

import type { PluginHost } from './host-api.ts';
import type { PluginScore, PluginScoreDecision, PluginScorer } from './scorer.ts';

/** A failure code that is an identifier, the only shape a pushed failure may carry. */
const IDENTIFIER = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The code Bureau gives a decision nothing can answer. */
const NOT_CONFIGURED = 'NOT_CONFIGURED';

/** The stable code of Bureau's `ModelPolicyDeniedError`, which this package cannot import. */
const MODEL_POLICY_DENIED = 'model-policy-denied';

/** What a rejected decision came to. */
type Failure =
  { readonly kind: 'canceled' } | { readonly kind: 'unavailable' | 'error'; readonly code: string };

/**
 * How a rejection reads: `canceled` when `signal` is aborted when it is caught, `unavailable` when
 * nothing can answer or the model policy forbids the model, `error` otherwise. The code is the
 * rejection's own when it is an identifier, else `UNKNOWN`.
 */
function failureOf(error: unknown, signal: AbortSignal): Failure {
  if (signal.aborted) return { kind: 'canceled' };
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return {
    kind: code === NOT_CONFIGURED || code === MODEL_POLICY_DENIED ? 'unavailable' : 'error',
    code: typeof code === 'string' && IDENTIFIER.test(code) ? code : 'UNKNOWN',
  };
}

/** What a {@link decisionScorer} asks about: the run's final reply, or the whole transcript. */
export type DecisionScorerContent = 'final' | 'transcript';

/** What {@link decisionScorer} is built from. */
export interface PluginDecisionScorerOptions {
  /** The scorer's name, recorded on every audit record and alert. */
  readonly name: string;
  /** The scorer's version. */
  readonly version: string;
  /**
   * The question asked of every sampled run, without its `context`: the helper sets that from the
   * run, so a question never sees the run.
   */
  readonly question: DecisionQuestion;
  /**
   * Turns the model's answer into the score. The helper lists the decision's provider, model and
   * usage on the score unless the verdict returns its own `decisions`.
   */
  readonly verdict: (decision: Decision<unknown>) => PluginScore | Promise<PluginScore>;
  /**
   * What the decision model reads: the run's final reply (`final`, the default), or the whole
   * conversation as Markdown (`transcript`), an explicit opt-in because it sends more of the run to
   * the model. Any other value throws a `TypeError` when the scorer is built.
   */
  readonly content?: DecisionScorerContent;
  /**
   * The kinds a model that answers must serve natively. A model that does not yields `unavailable`
   * instead of a fallback answer.
   */
  readonly requireKinds?: readonly DecisionKind[];
  /** A score below this raises an alert, as {@link PluginScorer.alertThreshold} does. */
  readonly alertThreshold?: number;
}

/**
 * A scorer that asks a decision about each sampled run. It declares `determinism: 'stochastic'`,
 * asks as the plugin under the run's id (`taskId: context.runId`) with the scorer's own signal, and
 * records `canceled` when that signal aborts, `unavailable` when no model can answer (or the model
 * policy forbids it, or `requireKinds` is not met), and `error` for any other failure.
 *
 * ```ts
 * setup: ({ host }) => ({
 *   scorers: [
 *     decisionScorer(host.decisions, {
 *       name: 'helpful',
 *       version: '1',
 *       question: { kind: 'boolean', question: 'Did the reply answer the request?' },
 *       verdict: (decision) =>
 *         decision.value === true
 *           ? { outcome: 'pass', message: 'Answered', score: 1 }
 *           : { outcome: 'fail', message: 'Did not answer', score: 0 },
 *     }),
 *   ],
 * });
 * ```
 */
export function decisionScorer(
  decisions: PluginHost['decisions'],
  options: PluginDecisionScorerOptions,
): PluginScorer {
  const { name, version, verdict, alertThreshold } = options;
  const content: unknown = options.content ?? 'final';
  if (content !== 'final' && content !== 'transcript') {
    throw new TypeError(
      `The scorer "${name}" reads content "${String(content)}": it must be "final" or "transcript".`,
    );
  }
  // The caller owns `options`: what the scorer asks is read once, when it is built.
  const question: DecisionQuestion = { ...options.question };
  const requireKinds = options.requireKinds === undefined ? undefined : [...options.requireKinds];
  return {
    name,
    version,
    determinism: 'stochastic',
    ...(alertThreshold === undefined ? {} : { alertThreshold }),
    score: async (run, signal, context) => {
      let decision: Decision<unknown>;
      try {
        decision = await decisions.decide(
          {
            ...question,
            context: content === 'final' ? run.content : await transcriptOf(run),
          },
          {
            taskId: context.runId,
            signal,
            ...(requireKinds === undefined ? {} : { requireKinds }),
          },
        );
      } catch (error) {
        return failedScore(failureOf(error, signal));
      }
      const scored = await verdict(decision);
      return { ...scored, decisions: scored.decisions ?? [decisionRecordOf(decision)] };
    },
  };
}

/**
 * The run's whole conversation as Markdown. `conversationalist` is loaded here, when a scorer asks
 * for a transcript, and not at the top of the module: every plugin loads this package, and its
 * index would otherwise pull the whole of `conversationalist` into a plugin that never reads a
 * transcript (the folder-plugin probe, which runs a child with no installs, caught it).
 */
async function transcriptOf(run: RunResult): Promise<string> {
  const { conversationToMarkdown } = await import('conversationalist');
  return conversationToMarkdown(run.conversation);
}

/** The score of a decision that did not answer: fixed text naming a code, never the provider's. */
function failedScore(failure: Failure): PluginScore {
  if (failure.kind === 'canceled') return { outcome: 'canceled', message: 'Decision canceled' };
  const verb = failure.kind === 'unavailable' ? 'unavailable' : 'failed';
  return { outcome: failure.kind, message: `Decision ${verb}: ${failure.code}` };
}

/** The part of an answered decision a score's record keeps. */
function decisionRecordOf(decision: Decision<unknown>): PluginScoreDecision {
  return {
    provider: decision.provider,
    model: decision.model,
    ...(decision.usage === undefined ? {} : { usage: decision.usage }),
  };
}

/** What {@link decisionValidator} is built from. */
export interface PluginDecisionValidatorOptions {
  /** The validator's registered name. A goal names its validator by `name` and `version`. */
  readonly name: string;
  /** The validator's registered version. */
  readonly version: string;
  /** Builds the question from the attempt being judged. */
  readonly request: (input: ValidatorInput) => DecisionRequest;
  /** Turns the model's answer into the verdict: `pass`, or `fail` with feedback for the retry. */
  readonly verdict: (decision: Decision<unknown>) => ValidatorOutcome;
  /**
   * The kinds a model that answers must serve natively. A model that does not yields `unavailable`
   * instead of a fallback answer.
   */
  readonly requireKinds?: readonly DecisionKind[];
}

/**
 * A goal validator that asks a decision. It reports `determinism: 'stochastic'`: a model's verdict
 * is not evidence a goal that requires deterministic validation may accept. It asks as the
 * plugin, under the goal run's id (`taskId: input.goalRunId`) and with the validator's signal. A
 * decision nothing can answer is `unavailable` (so a goal that retries on `validator-unavailable`
 * retries), an abort is `canceled`, and any other failure is an `error`; a failure's error code is
 * `DECISION_UNAVAILABLE` or `DECISION_FAILED` and its message names an identifier, never the
 * provider's text.
 */
export function decisionValidator(
  decisions: PluginHost['decisions'],
  options: PluginDecisionValidatorOptions,
): Validator {
  const { name, version, request, verdict } = options;
  const requireKinds = options.requireKinds === undefined ? undefined : [...options.requireKinds];
  return {
    identity: { name, version },
    determinism: 'stochastic',
    validate: async (input, signal) => {
      let decision: Decision<unknown>;
      try {
        decision = await decisions.decide(request(input), {
          taskId: input.goalRunId,
          signal,
          ...(requireKinds === undefined ? {} : { requireKinds }),
        });
      } catch (error) {
        return failedOutcome(failureOf(error, signal));
      }
      return verdict(decision);
    },
  };
}

/** The outcome of a decision that did not answer. */
function failedOutcome(failure: Failure): ValidatorOutcome {
  if (failure.kind === 'canceled') return { kind: 'canceled' };
  if (failure.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: failure.code,
      error: {
        kind: 'execute',
        code: 'DECISION_UNAVAILABLE',
        message: `Decision unavailable: ${failure.code}`,
      },
    };
  }
  return {
    kind: 'error',
    error: {
      kind: 'execute',
      code: 'DECISION_FAILED',
      message: `Decision failed: ${failure.code}`,
    },
  };
}
