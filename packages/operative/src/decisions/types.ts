import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { TokenUsage } from 'conversationalist';
import type { ZodType } from 'zod';

/** One selectable answer to a `choice` request. */
export interface DecisionOption {
  /** The stable identifier a {@link Decision} returns as its value. Unique within the request. */
  readonly key: string;
  /** What the option means, in words the model reads. Non-empty. */
  readonly label: string;
}

/**
 * A question put to a {@link DecisionModel}. `context` is text in this
 * version; media context is a later addition on the `structured` kind.
 *
 * - `boolean`: a yes/no question; the decision's value is a `boolean`.
 * - `choice`: pick one option; the value is the chosen option's `key`.
 * - `scale`: rate on ordered `levels`, lowest first (at least two, each
 *   non-empty and distinct); the value is the chosen level's index.
 * - `structured`: answer with an object that validates against `schema`; the
 *   value is the validated object. A Zod schema, or a Standard JSON Schema
 *   (a schema whose `~standard` also carries `jsonSchema`), gives the model a
 *   JSON Schema to follow. A bare Standard Schema validates the answer but
 *   cannot describe it, so the model is only asked for JSON and the one retry
 *   with the validation error does the rest.
 */
export type DecisionRequest =
  | { readonly kind: 'boolean'; readonly question: string; readonly context?: string }
  | {
      readonly kind: 'choice';
      readonly question: string;
      readonly options: readonly DecisionOption[];
      readonly context?: string;
    }
  | {
      readonly kind: 'scale';
      readonly question: string;
      readonly levels: readonly string[];
      readonly context?: string;
    }
  | {
      readonly kind: 'structured';
      readonly question: string;
      readonly schema: StandardSchemaV1 | ZodType;
      readonly context?: string;
    };

/** The kinds a {@link DecisionRequest} can take. */
export type DecisionKind = DecisionRequest['kind'];

/** A model's answer to a {@link DecisionRequest}. */
export interface Decision<T> {
  /** `boolean`, an option `key`, a level index, or the validated object, by request kind. */
  readonly value: T;
  /**
   * The model's probability for `value`, when it reports one (Jev does, a
   * plain language model does not). Thresholds belong to the caller.
   */
  readonly probability?: number;
  /** Why the model answered as it did, when it says. */
  readonly rationale?: string;
  /** The provider that served the answer, such as `anthropic` or `typesafe`. */
  readonly provider: string;
  /** The provider-native model identifier that served the answer. */
  readonly model: string;
  /** Tokens spent, summed across every attempt. Absent when the provider reports none. */
  readonly usage?: TokenUsage;
}

/** Per-call options for {@link DecisionModel.decide}. */
export interface DecideOptions {
  /** Who is asking; carried for the caller's audit, never sent to the model. */
  readonly principal?: string;
  /** Cancels the in-flight request. */
  readonly signal?: AbortSignal;
}

/** Answers {@link DecisionRequest}s. A caller routes a request to a model whose `kinds` has its kind. */
export interface DecisionModel {
  /** A stable label for logs and routing, such as `anthropic/claude-haiku-5-5`. */
  readonly name: string;
  /** The request kinds this model can answer. */
  readonly kinds: ReadonlySet<DecisionKind>;
  /**
   * Answers one request. Rejects with a {@link DecisionSchemaError} when the
   * answer cannot be made to satisfy the request, and with the provider's own
   * error when the provider fails.
   */
  decide(request: DecisionRequest, options?: DecideOptions): Promise<Decision<unknown>>;
}
