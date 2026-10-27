import type { ValidateFunction } from 'ajv/dist/2020.js';

import {
  InteractiveSurfaceSchemaCompiler,
  InteractiveSurfaceValidationError,
} from '../interactive-surface/validation.ts';
import type { InteractiveSurfaceJsonObject } from '../interactive-surface/types.ts';

/** The most UTF-8 bytes of JSON a schema given to a decision from outside the process may take. */
export const DECISION_SCHEMA_MAXIMUM_BYTES = 16 * 1024;

/** A JSON Schema given to a decision from outside the process was not acceptable. */
export class DecisionSchemaRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionSchemaRefusedError';
  }
}

/**
 * A Standard Schema (v1) over a JSON Schema: `validate` runs it, and `jsonSchema.input()` returns
 * the schema as given, so the model is asked for exactly the shape the caller wrote.
 */
export interface JsonSchemaStandard {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: 'bureau';
    readonly validate: (value: unknown) =>
      | { readonly value: unknown }
      | {
          readonly issues: readonly {
            readonly message: string;
            readonly path?: readonly PropertyKey[];
          }[];
        };
    readonly jsonSchema: {
      readonly input: (options?: { readonly target?: string }) => Record<string, unknown>;
      readonly output: (options?: { readonly target?: string }) => Record<string, unknown>;
    };
  };
}

const compiler = new InteractiveSurfaceSchemaCompiler();

function pathOf(instancePath: string): readonly PropertyKey[] {
  return instancePath === ''
    ? []
    : instancePath
        .split('/')
        .slice(1)
        .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/**
 * Turns a JSON Schema (draft 2020-12) into a Standard Schema validator. The schema must be a JSON
 * object of at most {@link DECISION_SCHEMA_MAXIMUM_BYTES} UTF-8 bytes that Bureau's schema rules
 * accept: no `$id`, no `pattern` or `patternProperties` (an answer is untrusted input), and every
 * `$ref` resolvable.
 *
 * @throws {DecisionSchemaRefusedError} Naming what is wrong, never echoing the schema.
 */
export function standardSchemaFromJsonSchema(schema: unknown): JsonSchemaStandard {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new DecisionSchemaRefusedError('The schema must be a JSON Schema object.');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw new DecisionSchemaRefusedError('The schema must be serializable as JSON.');
  }
  if (new TextEncoder().encode(serialized).byteLength > DECISION_SCHEMA_MAXIMUM_BYTES) {
    throw new DecisionSchemaRefusedError(
      `The schema may take at most ${DECISION_SCHEMA_MAXIMUM_BYTES} bytes serialized.`,
    );
  }
  // The copy is the caller-independent schema the model is shown and the answer is checked against.
  const copy = JSON.parse(serialized) as InteractiveSurfaceJsonObject;
  let validate: ValidateFunction;
  try {
    validate = compiler.compile(copy, 'The schema');
  } catch (error) {
    if (error instanceof InteractiveSurfaceValidationError) {
      throw new DecisionSchemaRefusedError(error.message);
    }
    throw new DecisionSchemaRefusedError(
      `The schema is not a valid JSON Schema 2020-12: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const describe = (): Record<string, unknown> => structuredClone(copy);
  return {
    '~standard': {
      version: 1,
      vendor: 'bureau',
      validate: (value) => {
        if (validate(value)) return { value };
        return {
          issues: (validate.errors ?? []).map((error) => ({
            message: error.message ?? 'does not satisfy the schema',
            path: pathOf(error.instancePath),
          })),
        };
      },
      jsonSchema: { input: describe, output: describe },
    },
  };
}
