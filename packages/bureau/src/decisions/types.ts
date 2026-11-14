import type { Decision, DecisionModel, DecisionRequest } from '@lostgradient/operative';

/** The `decisions` option of `createBureau`. Every field is a code default a host may leave out. */
export interface DecisionsOptions {
  /**
   * The decision models a host registers in code, by name. Which one answers is the
   * `decisions.model` setting, read on every decision. A request whose kind the chosen model does
   * not serve goes to the language-model fallback. `catalog` is reserved: it cannot be
   * registered here. A plugin does not register one: it contributes a provider whose catalog
   * row declares `decisions` (COR-2157).
   */
  readonly models?: Readonly<Record<string, DecisionModel>>;
  /**
   * What answers by default, and the default of the `decisions.model` setting: a catalog row
   * written `<provider>/<model>`, or a name in {@link DecisionsOptions.models}. A request goes to
   * the row natively when the row declares its kind (`decisions.kinds`), through the row's own
   * `generate` when it has structured output, and otherwise to the language-model fallback. A row
   * that is absent or `unavailable` (its provider has no key yet) answers nothing, so the fallback
   * does. Omit it to send every kind to the fallback until the setting names a row.
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
 * One catalog row that can answer decisions, as {@link BureauDecisions.models} reports it: the
 * rows a `decisions.model` or `decisions.fallbackModel` may name, with whether each can answer now.
 */
export interface BureauDecisionModel {
  /** The row's provider. */
  readonly provider: string;
  /** The provider-native model name; the row is written `<provider>/<model>`. */
  readonly model: string;
  /**
   * `available` when the row can be called now, `needs-setup` when it cannot yet: its provider has
   * no key saved, or the model is turned off. A `needs-setup` row is still listed, so a choice of it
   * is visible rather than missing.
   */
  readonly availability: 'available' | 'needs-setup';
  /** Whether the row only decides and is no chat model (TypeSafe's rows). */
  readonly decisionOnly: boolean;
  /**
   * Whether this is the row a decision goes to now, as `decide` chooses it: the row
   * `decisions.model` names (or defaults to) when it is in the catalog, can decide and is not
   * `needs-setup`; else the {@link BureauDecisionModel.fallback} row. A named row the model policy
   * forbids refuses every decision, so no row is marked. At most one row is marked, and none when
   * nothing can answer. A page names the answering row by comparing this with its setting.
   */
  readonly answering: boolean;
  /**
   * Whether this is the row the language-model fallback uses: `decisions.fallbackModel` (its alias
   * included) when that row is available and returns structured output, otherwise the cheapest
   * priced such row (input price, then output price, then catalog order), never one the model
   * policy forbids. At most one row is marked. With no `decisions.model` it is the answering row.
   */
  readonly fallback: boolean;
  /**
   * Whether this row can be the language-model fallback at all: it returns structured output, the
   * rule `chooseFallbackRow` applies before it looks at availability. A row that cannot (a
   * decision-only row such as TypeSafe's) is skipped by the fallback however `decisions.fallbackModel`
   * is saved, so a page offers only rows marked here for that setting. A `needs-setup` row that
   * returns structured output is marked: it becomes the fallback once its provider has a key.
   */
  readonly canBeFallback: boolean;
}

/**
 * Bureau's decision namespace, exposed as `Bureau.decisions`: ask a model a question and get a
 * typed answer back.
 */
export interface BureauDecisions {
  /**
   * The catalog rows that can answer decisions, natively (the row declares decision kinds) or
   * through structured output, in catalog order, with their availability and which one answers as
   * the fallback. A row the model policy forbids is left out: it cannot answer. Read again on every
   * call, so it reflects the catalog and settings as they are now.
   */
  models(): readonly BureauDecisionModel[];
  /**
   * Answers `request`. A request whose kind the model named by the `decisions.model` setting
   * ({@link DecisionsOptions.model} by default) serves goes to it, and is looked up again on every
   * call, so the next decision uses a model changed in the settings. Every other kind goes to the language-model fallback chosen by {@link DecisionsOptions.fallbackModel}.
   *
   * Rejects `BureauError` `BAD_REQUEST` for a malformed request, `NOT_CONFIGURED` when no model
   * can answer (no eligible fallback row, or `models.generate` absent or throwing), and with
   * `DecisionSchemaError` when the model's answer fails validation after its one retry. A provider
   * error is not wrapped. Each decision is recorded as a `decision.made` audit record that names
   * the kind, the `outcome` (`answered`, `refused` or `error`), the `row` that answered or was
   * chosen (`<provider>/<model>`) and the `path` it answered by (`native`, `adapter` or
   * `fallback`), the provider and model that answered, and the principal (and, for `structured`,
   * the SHA-256 of the schema); a refusal or an error names its `reason` instead. It never holds
   * the context or the value. No decision value is stored. A malformed request writes no record.
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
