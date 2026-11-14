import { sha256HexSync } from '@lostgradient/cryptography';
import {
  type BackendDescriptor,
  type Decision,
  type DecisionKind,
  type DecisionModel,
  type DecisionRequest,
  assertValidDecisionRequest,
  llmDecisionModel,
} from '@lostgradient/operative';
import { isStandardSchema, isZodSchema } from 'armorer';
import { z } from 'zod';

import { canonicalJson } from '../command-ledger.ts';
import { ModelPolicyDeniedError } from '../file-agent-generate.ts';
import { type BureauModelPolicyOptions, modelPolicyDenialOf } from '../model-policy.ts';
import { findDecisionRow, type Models, type ModelsOptions } from '../models/create-models.ts';
import type { SettingsValues } from '../settings/settings-schema.ts';
import type {
  BureauDecideOptions,
  BureauDecisions,
  DecisionsOptions,
  DecisionValue,
} from './types.ts';

/** {@link DecisionsOptions.fallbackModel}'s default. */
export const DEFAULT_DECISION_FALLBACK_MODEL = 'anthropic/claude-haiku-5-5';

/**
 * A name no decision model may register: it was the `decisions.model` that sent every kind to the
 * language-model fallback, which an unset `decisions.model` does now (COR-2154). A stored
 * `catalog` is dropped.
 */
export const CATALOG_DECISION_MODEL = 'catalog';

/** How a decision was answered: by a row that declares its kind, through a row's `generate`, or by the fallback. */
export type DecisionPath = 'native' | 'adapter' | 'fallback';

/** {@link DecisionsOptions.maximumPerTask}'s default. */
export const DEFAULT_DECISIONS_PER_TASK = 20;

/** The audit record type for one answered decision. */
export const DECISION_MADE_AUDIT_TYPE = 'decision.made';

/** What {@link createDecisions} composes `bureau.decisions` from. */
export type DecisionsDependencies = {
  readonly options: DecisionsOptions | undefined;
  /**
   * The settings, read for every decision: the stored `decisions.*` values over the code options
   * (COR-1710).
   */
  readonly settings: () => Pick<
    SettingsValues,
    'decisions.model' | 'decisions.fallbackModel' | 'decisions.maximumPerTask'
  >;
  /** The catalog the fallback row is chosen from and the `generate` it runs with. */
  readonly models: Pick<Models, 'catalog' | 'generate' | 'decide'>;
  /**
   * The model policy in force, read for every decision (COR-1996): the language-model fallback
   * never uses a row the deployment or Bureau layer forbids. A model registered in
   * {@link DecisionsOptions.models} is host code with no catalog row, so the policy cannot judge it.
   */
  readonly modelPolicy?: (() => BureauModelPolicyOptions | undefined) | undefined;
  /** The `models` option, whose `generate` the fallback needs. */
  readonly modelsOptions: ModelsOptions | undefined;
  /** Builds the `NOT_CONFIGURED` error a decision that no model can answer is refused with. */
  readonly notConfigured: (message: string, cause?: unknown) => Error;
  /** Refuses malformed input, as `BAD_REQUEST`. */
  readonly badRequest: (message: string) => never;
  /** Appends to the audit trail, when the Bureau keeps one. */
  readonly audit: (entry: {
    readonly runId: string;
    readonly type: string;
    readonly detail: Readonly<Record<string, string | number | boolean>>;
    readonly principal?: string;
  }) => Promise<void>;
};

/** `bureau.decisions` and what the Bureau itself needs from it. */
export type DecisionsComposition = {
  readonly decisions: BureauDecisions;
  /** {@link DecisionsOptions.maximumPerTask}, resolved from the settings as they are now. */
  readonly maximumPerTask: () => number;
  /**
   * Whether anything can answer a decision at all: a model in {@link DecisionsOptions.models} or a
   * `models.generate`. The `decide` tool is offered only to a Bureau where this holds.
   */
  readonly configured: boolean;
};

function isDecisionModel(value: unknown): value is DecisionModel {
  return (
    typeof value === 'object' &&
    value !== null &&
    'decide' in value &&
    typeof value.decide === 'function' &&
    'kinds' in value &&
    value.kinds instanceof Set
  );
}

/** Whether `name` is a key `models` registers, or a catalog row written `<provider>/<model>`. */
function isDecisionModelChoice(name: string, models: unknown): boolean {
  return (
    (typeof models === 'object' && models !== null && Object.hasOwn(models, name)) ||
    /^[^/\s]+\/\S+$/.test(name)
  );
}

/**
 * The names in {@link DecisionsOptions.models}: the decision models a host registers, which a
 * `decisions.model` may name besides a catalog row written `<provider>/<model>` (COR-2154).
 */
export function decisionModelNames(options: DecisionsOptions | undefined): ReadonlySet<string> {
  return new Set(Object.keys(options?.models ?? {}));
}

/** Refuses a malformed `decisions` option, as `BAD_REQUEST`, before `createBureau` opens anything. */
export function validateDecisionsOptions(
  options: unknown,
  badRequest: (message: string) => never,
): asserts options is DecisionsOptions | undefined {
  if (options === undefined) return;
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    badRequest('"options.decisions" must be an object');
  }
  const { models, model, fallbackModel, maximumPerTask } = options as {
    models?: unknown;
    model?: unknown;
    fallbackModel?: unknown;
    maximumPerTask?: unknown;
  };
  if (models !== undefined) {
    if (typeof models !== 'object' || models === null || Array.isArray(models)) {
      badRequest('"options.decisions.models" must be an object of decision models by name');
    }
    for (const [name, candidate] of Object.entries(models)) {
      if (name === '' || name === CATALOG_DECISION_MODEL) {
        badRequest(
          `"options.decisions.models" cannot register "${name}": the name is empty or reserved for the language-model fallback`,
        );
      }
      if (!isDecisionModel(candidate)) {
        badRequest(
          `"options.decisions.models.${name}" must be a decision model with \`kinds\` and \`decide\``,
        );
      }
    }
  }
  if (model !== undefined && typeof model !== 'string') {
    badRequest('"options.decisions.model" must be a string');
  }
  if (fallbackModel !== undefined) {
    if (typeof fallbackModel !== 'string' || !/^[^/\s]+\/\S+$/.test(fallbackModel)) {
      badRequest('"options.decisions.fallbackModel" must be "<provider>/<model>"');
    }
  }
  if (maximumPerTask !== undefined) {
    if (!Number.isSafeInteger(maximumPerTask) || (maximumPerTask as number) < 1) {
      badRequest('"options.decisions.maximumPerTask" must be a positive integer');
    }
  }
}

/**
 * Refuses a `decisions.model` that names no registered model, as `BAD_REQUEST`. Separate from
 * {@link validateDecisionsOptions} because plugins contribute decision models (COR-1879): the name
 * is checked once composition has folded them into `decisions.models`, so `model: 'kit:router'`
 * can name a plugin's router.
 */
export function validateDecisionsModelChoice(
  options: DecisionsOptions | undefined,
  badRequest: (message: string) => never,
): void {
  const model = options?.model;
  if (model === undefined || isDecisionModelChoice(model, options?.models)) return;
  badRequest(
    `"options.decisions.model" must be a catalog row written "<provider>/<model>" or a name in "options.decisions.models"`,
  );
}

function eligible(row: BackendDescriptor): boolean {
  return row.availability !== 'unavailable' && row.structuredOutput;
}

/** Whether a row can decide at all: it declares decision kinds of its own, or it returns structured output. */
function canDecide(row: BackendDescriptor): boolean {
  return row.structuredOutput || (row.decisions?.kinds.length ?? 0) > 0;
}

function matchesFallback(row: BackendDescriptor, provider: string, model: string): boolean {
  return (
    row.provider === provider &&
    (row.model === model || row.aliases.some((alias) => alias.alias === model))
  );
}

/**
 * The catalog row the language-model fallback uses: `fallbackModel` when it is in the catalog and
 * eligible, otherwise the cheapest priced eligible row (input price, then output price, then
 * catalog order), otherwise `undefined`.
 */
export function chooseFallbackRow(
  rows: readonly BackendDescriptor[],
  fallbackModel: string,
): BackendDescriptor | undefined {
  const slash = fallbackModel.indexOf('/');
  const provider = fallbackModel.slice(0, slash);
  const model = fallbackModel.slice(slash + 1);
  const preferred = rows.find((row) => matchesFallback(row, provider, model));
  if (preferred !== undefined && eligible(preferred)) return preferred;
  const priced = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => eligible(row) && row.pricing !== undefined);
  priced.sort(
    (left, right) =>
      left.row.pricing!.inputPerMillionTokens - right.row.pricing!.inputPerMillionTokens ||
      left.row.pricing!.outputPerMillionTokens - right.row.pricing!.outputPerMillionTokens ||
      left.index - right.index,
  );
  return priced[0]?.row;
}

/**
 * The SHA-256 (hex) of a `structured` request's schema as canonical JSON (keys sorted), or
 * `undefined` for a schema that cannot describe itself as JSON Schema (a bare Standard Schema).
 */
export function schemaDigest(request: DecisionRequest): string | undefined {
  if (request.kind !== 'structured') return undefined;
  const schema: unknown = request.schema;
  let jsonSchema: unknown;
  if (isZodSchema(schema)) {
    jsonSchema = z.toJSONSchema(schema, { io: 'input' });
  } else if (isStandardSchema(schema)) {
    const converter = (
      schema['~standard'] as {
        jsonSchema?: { input?: (options: { target: string }) => unknown };
      }
    ).jsonSchema;
    jsonSchema = converter?.input?.({ target: 'draft-2020-12' });
  }
  return jsonSchema === undefined ? undefined : sha256HexSync(canonicalJson(jsonSchema));
}

/** The model chosen for one request, how it answers, and the catalog row behind it (none for a host-registered model). */
type Answerer = {
  readonly model: DecisionModel;
  readonly path: DecisionPath;
  readonly row?: BackendDescriptor;
};

/** What every `decision.made` record of one request holds, before its outcome is known. */
type AuditBase = {
  readonly entry: {
    readonly runId: string;
    readonly type: string;
    readonly principal?: string;
  };
  readonly detail: Readonly<Record<string, string | number | boolean>>;
};

/** The `row` that answered (`<provider>/<model>`) and the `path` it answered by, for a record's detail. */
function answererDetail(
  answerer: Answerer,
  decision?: Decision<unknown>,
): { readonly row: string; readonly path: DecisionPath } {
  const row =
    answerer.row !== undefined
      ? `${answerer.row.provider}/${answerer.row.model}`
      : decision !== undefined
        ? `${decision.provider}/${decision.model}`
        : answerer.model.name;
  return { row, path: answerer.path };
}

/** Builds Bureau's decision namespace. */
export function createDecisions(dependencies: DecisionsDependencies): DecisionsComposition {
  const { options } = dependencies;
  // The caller owns `options.models`: the registered names are read once, here.
  const registered: Readonly<Record<string, DecisionModel>> = { ...options?.models };
  /** The model `decisions.model` names, or `undefined` for the fallback alone. Read on every decision. */
  const hostModelNow = (): DecisionModel | undefined => {
    const name = dependencies.settings()['decisions.model'];
    return name !== undefined && Object.hasOwn(registered, name) ? registered[name] : undefined;
  };
  const fallbackModelNow = (): string =>
    dependencies.settings()['decisions.fallbackModel'] ?? DEFAULT_DECISION_FALLBACK_MODEL;
  const maximumPerTask = (): number =>
    dependencies.settings()['decisions.maximumPerTask'] ?? DEFAULT_DECISIONS_PER_TASK;

  /**
   * The catalog rows the policy leaves, and the one of them the language-model fallback uses. A
   * forbidden row is skipped when choosing, so the policy narrows the fallback and does not end it
   * while another row can answer.
   */
  function fallbackNow(): {
    readonly descriptors: readonly BackendDescriptor[];
    readonly permitted: readonly BackendDescriptor[];
    readonly policy: BureauModelPolicyOptions | undefined;
    readonly row: BackendDescriptor | undefined;
  } {
    const descriptors = dependencies.models.catalog().descriptors;
    const policy = dependencies.modelPolicy?.();
    const permitted = descriptors.filter(
      (candidate) => modelPolicyDenialOf(candidate, policy) === undefined,
    );
    return {
      descriptors,
      permitted,
      policy,
      row: chooseFallbackRow(permitted, fallbackModelNow()),
    };
  }

  function fallback(): Answerer {
    const { descriptors, policy, row } = fallbackNow();
    // Only when the policy leaves no row is the decision refused.
    if (row === undefined) {
      const forbidden = chooseFallbackRow(descriptors, fallbackModelNow());
      const denial = forbidden === undefined ? undefined : modelPolicyDenialOf(forbidden, policy);
      if (forbidden !== undefined && denial !== undefined) {
        throw new ModelPolicyDeniedError(forbidden, denial);
      }
      throw dependencies.notConfigured(
        'No model can answer this decision: the model catalog has no available row with structured output and a price',
      );
    }
    try {
      return {
        model: llmDecisionModel({ generate: dependencies.models.generate(row), descriptor: row }),
        path: 'fallback',
        row,
      };
    } catch (cause) {
      throw dependencies.notConfigured(
        `No model can answer this decision: "${row.provider}/${row.model}" could not be set up`,
        cause,
      );
    }
  }

  /**
   * The catalog row `decisions.model` names, when it names one and the row can answer: a name no
   * host model registers, a row that is in the catalog as it is now, and not `unavailable` (a
   * provider whose key is not saved keeps its rows `unavailable`, and counts as absent here so the
   * fallback answers). Read on every decision.
   */
  const chosenRowNow = (): BackendDescriptor | undefined => {
    const name = dependencies.settings()['decisions.model'];
    if (name === undefined || Object.hasOwn(registered, name)) return undefined;
    const row = findDecisionRow(dependencies.models.catalog().descriptors, name);
    return row === undefined || row.availability === 'unavailable' ? undefined : row;
  };

  /** The row's own models: native when it declares the kind, else through its `generate`. */
  function modelOfRow(row: BackendDescriptor, kind: DecisionKind): Answerer | undefined {
    const policy = dependencies.modelPolicy?.();
    const denial = modelPolicyDenialOf(row, policy);
    // A forbidden chosen row refuses the decision: the owner chose it, so the fallback must not
    // quietly answer in its place.
    if (denial !== undefined) throw new ModelPolicyDeniedError(row, denial);
    try {
      // A host that supplied no `models.decide` has nothing to answer natively with.
      if (
        row.decisions?.kinds.includes(kind) === true &&
        dependencies.modelsOptions?.decide !== undefined
      ) {
        return { model: dependencies.models.decide(row), path: 'native', row };
      }
      if (row.structuredOutput) {
        return {
          model: llmDecisionModel({ generate: dependencies.models.generate(row), descriptor: row }),
          path: 'adapter',
          row,
        };
      }
    } catch (cause) {
      throw dependencies.notConfigured(
        `No model can answer this decision: "${row.provider}/${row.model}" could not be set up`,
        cause,
      );
    }
    return undefined;
  }

  /** The model that answers a `kind` request: the registered one, the chosen row's, else the fallback. */
  function modelFor(kind: DecisionKind): Answerer {
    const hostModel = hostModelNow();
    if (hostModel?.kinds.has(kind) === true) return { model: hostModel, path: 'native' };
    const row = chosenRowNow();
    return (row === undefined ? undefined : modelOfRow(row, kind)) ?? fallback();
  }

  /** Writes the record of a decision that was refused or failed; the failure itself is what is thrown. */
  async function auditFailure(
    error: unknown,
    base: AuditBase,
    answerer: Answerer | undefined,
  ): Promise<void> {
    const { code, name } = error as { code?: unknown; name?: unknown };
    const refused =
      error instanceof ModelPolicyDeniedError ||
      (typeof code === 'string' && code === 'NOT_CONFIGURED');
    const denied = error instanceof ModelPolicyDeniedError ? error : undefined;
    try {
      await dependencies.audit({
        ...base.entry,
        detail: {
          ...base.detail,
          outcome: refused ? 'refused' : 'error',
          reason: typeof code === 'string' ? code : typeof name === 'string' ? name : 'Error',
          ...(answerer === undefined
            ? denied === undefined
              ? {}
              : { row: `${denied.provider}/${denied.model}` }
            : answererDetail(answerer)),
        },
      });
    } catch {
      // The decision's own failure is what the caller must see; a trail that cannot take its record
      // does not replace it.
    }
  }

  const decisions: BureauDecisions = {
    models() {
      const { permitted, policy, row: fallbackRow } = fallbackNow();
      // The row `modelFor` goes to: the one `decisions.model` names when it is in the catalog, can
      // decide and is not `unavailable` (a policy that forbids it refuses the decision, so no row
      // answers), else the fallback's. Read from the same lookups `decide` uses.
      const chosen = chosenRowNow();
      const answering =
        chosen !== undefined && canDecide(chosen)
          ? modelPolicyDenialOf(chosen, policy) === undefined
            ? chosen
            : undefined
          : fallbackRow;
      return permitted.filter(canDecide).map((row) => ({
        provider: row.provider,
        model: row.model,
        availability: row.availability === 'unavailable' ? 'needs-setup' : 'available',
        decisionOnly: row.decisions?.only === true,
        answering: row === answering,
        fallback: row === fallbackRow,
      }));
    },
    async decide<Request extends DecisionRequest>(
      request: Request,
      decideOptions: BureauDecideOptions = {},
    ): Promise<Decision<DecisionValue<Request>>> {
      // The caller owns `request` and `decideOptions`: read them once, before the first await.
      const { principal, taskId, signal } = decideOptions;
      try {
        assertValidDecisionRequest(request);
      } catch (error) {
        return dependencies.badRequest(error instanceof Error ? error.message : String(error));
      }
      const { kind } = request;
      const digest = schemaDigest(request);
      const base: AuditBase = {
        entry: {
          runId: taskId ?? `decision:${crypto.randomUUID()}`,
          type: DECISION_MADE_AUDIT_TYPE,
          ...(principal === undefined ? {} : { principal }),
        },
        detail: { kind, ...(digest === undefined ? {} : { schemaSha256: digest }) },
      };
      let answerer: Answerer;
      try {
        answerer = modelFor(kind);
      } catch (error) {
        await auditFailure(error, base, undefined);
        throw error;
      }
      let decision: Decision<unknown>;
      try {
        decision = await answerer.model.decide(request, {
          ...(principal === undefined ? {} : { principal }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        await auditFailure(error, base, answerer);
        throw error;
      }
      await dependencies.audit({
        ...base.entry,
        detail: {
          kind,
          provider: decision.provider,
          model: decision.model,
          outcome: 'answered',
          ...answererDetail(answerer, decision),
          ...(digest === undefined ? {} : { schemaSha256: digest }),
        },
      });
      return decision as Decision<DecisionValue<Request>>;
    },
  };

  return {
    decisions,
    maximumPerTask,
    configured:
      Object.keys(registered).length > 0 || dependencies.modelsOptions?.generate !== undefined,
  };
}
