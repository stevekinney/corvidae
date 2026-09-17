import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * Type guard for any Standard Schema-conforming validator (Zod, Valibot,
 * ArkType, etc.) — anything exposing a `~standard` props object. Note that
 * Zod schemas satisfy this guard too, since Zod v4 implements the spec; check
 * for a library-specific shape first (e.g. `instanceof z.ZodType`) when the
 * distinction matters.
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== 'object' || value === null || !('~standard' in value)) return false;
  return isStandardProperties(value['~standard']);
}

function isStandardProperties(props: unknown): props is StandardSchemaV1.Props {
  return (
    typeof props === 'object' &&
    props !== null &&
    'version' in props &&
    props.version === 1 &&
    'vendor' in props &&
    typeof props.vendor === 'string' &&
    'validate' in props &&
    typeof props.validate === 'function'
  );
}

/**
 * Runs a Standard Schema validator against a value and normalizes the
 * (possibly async) result into a promise. Standard Schema's `validate` may
 * return its result synchronously or as a promise; `await`-ing a non-promise
 * value resolves it immediately, so this is safe for both.
 */
export async function validateStandardSchema<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): Promise<StandardSchemaV1.Result<Output>> {
  return await schema['~standard'].validate(value);
}
