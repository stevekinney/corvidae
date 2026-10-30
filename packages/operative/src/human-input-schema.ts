import Ajv2020 from 'ajv/dist/2020.js';

import { humanInputSchemaExtensionIssues } from './human-input-schema-extensions';

/**
 * A JSON Schema (draft 2020-12) describing the answer a `requestHumanInput` wait expects. The
 * agent's author configures it per signal name, and the model may supply one per call as
 * `answerSchema`, which replaces the signal's configured one for that call.
 */
export type HumanInputSchema = Readonly<Record<string, unknown>>;

/** The most serialized bytes (UTF-8) a {@link HumanInputSchema} may take. */
export const HUMAN_INPUT_SCHEMA_MAXIMUM_BYTES = 32 * 1024;

/** The deepest object/array nesting a {@link HumanInputSchema} may hold, the schema itself being level 1. */
export const HUMAN_INPUT_SCHEMA_MAXIMUM_DEPTH = 8;

/**
 * One reason a human-input schema is not acceptable: where in the schema it is, and what is wrong.
 * It is the shape the model reads in an `invalid-answer-schema` tool result.
 */
export interface HumanInputSchemaIssue {
  /** The location inside the rejected schema, as property names and array indexes; `[]` is the schema itself. */
  readonly path: ReadonlyArray<string | number>;
  /** What is wrong, in a sentence the model can act on. */
  readonly message: string;
}

/** Raised when a human-input schema, configured by an author or supplied by the model, is not acceptable. */
export class HumanInputSchemaError extends Error {
  override readonly name = 'HumanInputSchemaError';

  /** Every reason the schema was refused; a refusal with one cause holds one issue at path `[]`. */
  readonly issues: ReadonlyArray<HumanInputSchemaIssue>;

  constructor(
    /** The signal name the rejected schema was configured for, or that the call asked for. */
    readonly signalName: string,
    message: string,
    issues?: ReadonlyArray<HumanInputSchemaIssue>,
  ) {
    super(`inputSchemas["${signalName}"]: ${message}`);
    this.issues = issues ?? [{ path: [], message }];
  }
}

class RegularExpressionRefused extends Error {}

function depthOf(value: unknown, level: number): number {
  if (typeof value !== 'object' || value === null) return level - 1;
  let deepest = level;
  for (const child of Object.values(value)) {
    deepest = Math.max(deepest, depthOf(child, level + 1));
  }
  return deepest;
}

/**
 * Checks one schema and returns an independent JSON copy of it: a plain object, within the size
 * and nesting limits, that is a valid 2020-12 schema whose references all resolve. A later change
 * to the caller's object never reaches the copy.
 */
export function checkHumanInputSchema(signalName: string, schema: unknown): HumanInputSchema {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new HumanInputSchemaError(signalName, 'a schema must be a JSON object.');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw new HumanInputSchemaError(signalName, 'a schema must be serializable as JSON.');
  }
  if (new TextEncoder().encode(serialized).byteLength > HUMAN_INPUT_SCHEMA_MAXIMUM_BYTES) {
    throw new HumanInputSchemaError(
      signalName,
      `a schema may take at most ${HUMAN_INPUT_SCHEMA_MAXIMUM_BYTES} bytes serialized.`,
    );
  }
  // `toJSON()` may return anything: re-check the serialized copy, not just the input. A `true`
  // schema would otherwise compile as accept-all and a `null` would leak a raw TypeError.
  const parsed: unknown = serialized === undefined ? undefined : JSON.parse(serialized);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HumanInputSchemaError(signalName, 'a schema must serialize as a JSON object.');
  }
  const copy = parsed as HumanInputSchema;
  if (depthOf(copy, 1) > HUMAN_INPUT_SCHEMA_MAXIMUM_DEPTH) {
    throw new HumanInputSchemaError(
      signalName,
      `a schema may nest at most ${HUMAN_INPUT_SCHEMA_MAXIMUM_DEPTH} levels deep.`,
    );
  }
  if (Object.hasOwn(copy, '$id')) {
    throw new HumanInputSchemaError(signalName, 'a schema must not declare $id.');
  }
  // Bureau checks every answer with the interactive-surface rules, which refuse a regular
  // expression (an answer is untrusted input and could make one backtrack), a nested `$id`, and an
  // asynchronous schema. A schema it would refuse at answer time is refused here, at creation.
  let refusing = false;
  const ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
    logger: false,
    code: {
      regExp: Object.assign(
        (pattern: string, flags: string): RegExp => {
          if (refusing) throw new RegularExpressionRefused();
          return new RegExp(pattern, flags);
        },
        { code: 'new RegExp' },
      ),
    },
  });
  try {
    ajv.compile({});
    refusing = true;
    const known = new Set(Object.keys(ajv.refs));
    const validate = ajv.compile(copy);
    if (Object.keys(ajv.refs).some((reference) => !known.has(reference))) {
      throw new HumanInputSchemaError(signalName, 'a schema must not declare $id.');
    }
    if (Reflect.get(validate, '$async') === true) {
      throw new HumanInputSchemaError(signalName, 'a schema must not be asynchronous ($async).');
    }
  } catch (error) {
    if (error instanceof HumanInputSchemaError) throw error;
    if (error instanceof RegularExpressionRefused) {
      throw new HumanInputSchemaError(
        signalName,
        'a schema must not use "pattern" or "patternProperties".',
      );
    }
    throw new HumanInputSchemaError(
      signalName,
      `not a valid JSON Schema 2020-12: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const extensionIssues = humanInputSchemaExtensionIssues(copy);
  if (extensionIssues.length > 0) {
    throw new HumanInputSchemaError(
      signalName,
      extensionIssues
        .map((issue) =>
          issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
        )
        .join(' '),
      extensionIssues,
    );
  }
  return copy;
}

/** Checks every schema of an `inputSchemas` option; see {@link checkHumanInputSchema}. */
export function checkHumanInputSchemas(
  schemas: Readonly<Record<string, HumanInputSchema>>,
): Map<string, HumanInputSchema> {
  const checked = new Map<string, HumanInputSchema>();
  for (const [signalName, schema] of Object.entries(schemas)) {
    if (signalName === '') {
      throw new HumanInputSchemaError(signalName, 'a signal name is required.');
    }
    checked.set(signalName, checkHumanInputSchema(signalName, schema));
  }
  return checked;
}

/**
 * The schema a persisted or evented value holds, or `undefined` when it is not a plain object: how
 * a consumer reads a schema back from a checkpoint step result or an action detail.
 */
export function humanInputSchemaOf(value: unknown): HumanInputSchema | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as HumanInputSchema)
    : undefined;
}
