import type { Decision, DecisionModel, DecisionRequest } from '@lostgradient/operative';

/** The `decisions` option of `createBureau`. Every field is a code default a host may leave out. */
export interface DecisionsOptions {
  /**
   * The decision models a host offers, by name (Interborough registers `typesafe`, built with
   * `typesafeJev` from `@lostgradient/operative-typesafe`). Which one answers is the
   * `decisions.model` setting, read on every decision. A request whose kind the chosen model does
   * not serve goes to the language-model fallback. `catalog` names the fallback alone and is
   * reserved: it cannot be registered here.
   */
  readonly models?: Readonly<Record<string, DecisionModel>>;
  /**
   * The name in {@link DecisionsOptions.models} that answers by default, and the default of the
   * `decisions.model` setting. Omit it, or name `catalog`, to send every kind to the
   * language-model fallback until the setting names a model.
   */
  readonly model?: string;
  /**
   * The catalog row the language-model fallback uses, as `<provider>/<model>`. Defaults to
   * `anthropic/claude-haiku-5-5`. When that row is not in the catalog, is `unavailable`, or has no
   * `structuredOutput`, the cheapest priced `structuredOutput` row that is not `unavailable` is
   * used instead (ties by `outputPerMillionTokens`, then catalog order).
   */
  readonly fallbackModel?: string;
  /** How many times the `decide` tool may be called in one task. Defaults to 20. */
  readonly maximumPerTask?: number;
}

/**
 * The value a {@link Decision} carries for a request: a `boolean`, the chosen option's `key`, the
 * chosen level's index, or the validated object of a `structured` request's schema.
 */
export type DecisionValue<Request extends DecisionRequest> = Request extends { kind: 'boolean' }
  ? boolean
  : Request extends { kind: 'choice' }
    ? string
    : Request extends { kind: 'scale' }
      ? number
      : Request extends { kind: 'structured'; schema: infer Schema }
        ? Schema extends {
            readonly '~standard': {
              readonly types?: { readonly output: infer Output } | undefined;
            };
          }
          ? Output
          : unknown
        : unknown;

/** Options of one {@link BureauDecisions.decide} call. */
export interface BureauDecideOptions {
  /** Who is asking. Recorded on the `decision.made` audit record; never sent to the model. */
  readonly principal?: string;
  /** The task this decision is made for, when there is one: the audit record is filed under it. */
  readonly taskId?: string;
  /** Cancels the in-flight request. */
  readonly signal?: AbortSignal;
}

/**
 * Bureau's decision namespace, exposed as `Bureau.decisions`: ask a model a question and get a
 * typed answer back.
 */
export interface BureauDecisions {
  /**
   * Answers `request`. A request whose kind the model named by the `decisions.model` setting
   * ({@link DecisionsOptions.model} by default) serves goes to it, and is looked up again on every
   * call, so the next decision uses a model changed in the settings. Every other kind goes to the language-model fallback chosen by {@link DecisionsOptions.fallbackModel}.
   *
   * Rejects `BureauError` `BAD_REQUEST` for a malformed request, `NOT_CONFIGURED` when no model
   * can answer (no eligible fallback row, or `models.generate` absent or throwing), and with
   * `DecisionSchemaError` when the model's answer fails validation after its one retry. A provider
   * error is not wrapped. Each answer is recorded as a `decision.made` audit record that names the
   * kind, provider, model, and principal (and, for `structured`, the SHA-256 of the schema) and
   * never the context or the value. No decision value is stored.
   */
  decide<Request extends DecisionRequest>(
    request: Request,
    options?: BureauDecideOptions,
  ): Promise<Decision<DecisionValue<Request>>>;
}

/**
 * Anything that can answer a decision: {@link BureauDecisions} without its typed result, which
 * is what a router, a goal validator, or a tool needs.
 */
export interface DecisionSource {
  /** Answers `request`. See {@link BureauDecisions.decide}. */
  decide(request: DecisionRequest, options?: BureauDecideOptions): Promise<Decision<unknown>>;
}
