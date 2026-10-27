import { sha256HexSync } from '@lostgradient/cryptography';
import {
  type BackendDescriptor,
  type Decision,
  type DecisionModel,
  type DecisionRequest,
  assertValidDecisionRequest,
  llmDecisionModel,
} from '@lostgradient/operative';
import { isStandardSchema, isZodSchema } from 'armorer';
import { z } from 'zod';

import { canonicalJson } from '../command-ledger.ts';
import type { Models, ModelsOptions } from '../models/create-models.ts';
import type { SettingsValues } from '../settings/settings-schema.ts';
import type {
  BureauDecideOptions,
  BureauDecisions,
  DecisionsOptions,
  DecisionValue,
} from './types.ts';

/** {@link DecisionsOptions.fallbackModel}'s default. */
export const DEFAULT_DECISION_FALLBACK_MODEL = 'anthropic/claude-haiku-5-5';

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
    'decisions.fallbackModel' | 'decisions.maximumPerTask'
  >;
  /** The catalog the fallback row is chosen from and the `generate` it runs with. */
  readonly models: Pick<Models, 'catalog' | 'generate'>;
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
   * Whether anything can answer a decision at all: a {@link DecisionsOptions.model} or a
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

/** Refuses a malformed `decisions` option, as `BAD_REQUEST`, before `createBureau` opens anything. */
export function validateDecisionsOptions(
  options: unknown,
  badRequest: (message: string) => never,
): asserts options is DecisionsOptions | undefined {
  if (options === undefined) return;
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    badRequest('"options.decisions" must be an object');
  }
  const { model, fallbackModel, maximumPerTask } = options as {
    model?: unknown;
    fallbackModel?: unknown;
    maximumPerTask?: unknown;
  };
  if (model !== undefined && !isDecisionModel(model)) {
    badRequest('"options.decisions.model" must be a decision model with `kinds` and `decide`');
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

function eligible(row: BackendDescriptor): boolean {
  return row.availability !== 'unavailable' && row.structuredOutput;
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

/** Builds Bureau's decision namespace. */
export function createDecisions(dependencies: DecisionsDependencies): DecisionsComposition {
  const { options } = dependencies;
  const hostModel = options?.model;
  const fallbackModelNow = (): string =>
    dependencies.settings()['decisions.fallbackModel'] ?? DEFAULT_DECISION_FALLBACK_MODEL;
  const maximumPerTask = (): number =>
    dependencies.settings()['decisions.maximumPerTask'] ?? DEFAULT_DECISIONS_PER_TASK;

  function fallback(): DecisionModel {
    const row = chooseFallbackRow(dependencies.models.catalog().descriptors, fallbackModelNow());
    if (row === undefined) {
      throw dependencies.notConfigured(
        'No model can answer this decision: the model catalog has no available row with structured output and a price',
      );
    }
    try {
      return llmDecisionModel({ generate: dependencies.models.generate(row), descriptor: row });
    } catch (cause) {
      throw dependencies.notConfigured(
        `No model can answer this decision: "${row.provider}/${row.model}" could not be set up`,
        cause,
      );
    }
  }

  const decisions: BureauDecisions = {
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
      const model = hostModel !== undefined && hostModel.kinds.has(kind) ? hostModel : fallback();
      const decision = await model.decide(request, {
        ...(principal === undefined ? {} : { principal }),
        ...(signal === undefined ? {} : { signal }),
      });
      await dependencies.audit({
        runId: taskId ?? `decision:${crypto.randomUUID()}`,
        type: DECISION_MADE_AUDIT_TYPE,
        detail: {
          kind,
          provider: decision.provider,
          model: decision.model,
          ...(digest === undefined ? {} : { schemaSha256: digest }),
        },
        ...(principal === undefined ? {} : { principal }),
      });
      return decision as Decision<DecisionValue<Request>>;
    },
  };

  return {
    decisions,
    maximumPerTask,
    configured: hostModel !== undefined || dependencies.modelsOptions?.generate !== undefined,
  };
}
