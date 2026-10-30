import { z } from 'zod';

import type { MinimalAbortSignal } from '../is-tool';
import { findSecretReferences } from '../secrets';
import { racePreExecution } from './cancellation';

type Path = readonly (string | number)[];

/** What a `{ secretRef }` must look like to stand in for a value at admission. */
const secretReferenceSchema = z.strictObject({ secretRef: z.string() });

/** The message of a failure Armorer reports in place of one that could quote a secret. */
const substitutedFailureMessage =
  'The value failed validation after secret references were substituted.';

/** The message of a reference whose position the input schema cannot hold one at. */
const unplaceableReferenceMessage =
  'A secret reference cannot be used here: the input schema transforms, unions, intersects, or ' +
  'catches a value that contains this position, so the policy could not be shown what the call ' +
  'will run with.';

/**
 * Validates the arguments of a call that carries `{ secretRef }` values, for admission, policy and
 * approval. Those stages must see the reference form, so they cannot validate the plaintext.
 *
 * The input schema is rewritten, for this call only, so that each position holding a reference
 * also accepts that reference. Every other field is parsed by its own schema exactly as a literal
 * call's would be (transforms, coercions and defaults applied), so a policy decision never turns on
 * whether a sibling field carried a secret. A reference whose position sits inside a union,
 * intersection, transform, pipe or `catch` cannot be placed without changing how its siblings
 * parse, so it fails admission instead. The plaintext is validated later by
 * {@link parseSubstitutedArguments}.
 */
export async function parseArgumentsWithSecretReferences(
  schema: z.ZodType,
  argumentsValue: unknown,
  signal: MinimalAbortSignal | undefined,
): Promise<unknown> {
  const result = await racePreExecution(
    () => safeParseArgumentsWithSecretReferences(schema, argumentsValue),
    signal,
  );
  if (result.success) return result.data;
  throw result.error;
}

/**
 * The `safeParseAsync` form of {@link parseArgumentsWithSecretReferences}, for a caller that
 * validates a call's arguments before it executes, such as resuming an approval.
 */
export async function safeParseArgumentsWithSecretReferences(
  schema: z.ZodType,
  argumentsValue: unknown,
): Promise<z.ZodSafeParseResult<unknown>> {
  let tolerant = schema;
  for (const { path } of findSecretReferences(argumentsValue)) {
    const placed = placeReference(tolerant, path, 0);
    if (placed === undefined) {
      return {
        success: false,
        error: new z.ZodRealError([
          { code: 'custom', path: [...path], message: unplaceableReferenceMessage },
        ]),
      };
    }
    tolerant = placed;
  }
  return tolerant.safeParseAsync(argumentsValue);
}

/**
 * Validates the substituted arguments, right before the tool runs. Any failure, whether an issue
 * the schema reports or an error a transform or refinement throws, is replaced by a validation
 * error with a fixed message and no `cause`, because a message written by a schema, a refinement
 * or a parser can quote the value it rejected, and the value here is a secret. Issue paths survive;
 * the plaintext does not.
 */
export async function parseSubstitutedArguments(
  schema: z.ZodType,
  substituted: unknown,
): Promise<unknown> {
  let result: z.ZodSafeParseResult<unknown>;
  try {
    result = await schema.safeParseAsync(substituted);
  } catch {
    // The thrown error is dropped whole: its message, stack and cause may all hold the plaintext.
    throw substitutedFailure([[]]);
  }
  if (result.success) return result.data;
  throw substitutedFailure(result.error.issues.map((issue) => issue.path));
}

function substitutedFailure(paths: readonly (readonly PropertyKey[])[]): z.ZodError {
  return new z.ZodRealError(
    paths.map((path) => ({
      code: 'custom' as const,
      path: [...path],
      message: substitutedFailureMessage,
    })),
  );
}

/**
 * The schemas {@link acceptReference} built, each mapped to the schema it wraps, so a second
 * reference at the same position reuses one and a reference below it descends into the original.
 */
const acceptsReference = new WeakMap<z.ZodType, z.ZodType>();

/**
 * Returns a copy of `schema` that accepts a `{ secretRef }` at `path` and parses everything else
 * as `schema` does, or `undefined` when a schema on the way to `path` does not let the reference
 * be placed without changing how its siblings parse.
 */
function placeReference(schema: z.ZodType, path: Path, depth: number): z.ZodType | undefined {
  if (depth === path.length) return acceptReference(schema);
  const wrapped = acceptsReference.get(schema);
  if (wrapped !== undefined) {
    // An array element that is a reference beside one that holds a reference deeper down.
    const placed = placeReference(wrapped, path, depth);
    return placed === undefined ? undefined : acceptReference(placed);
  }
  const definition = schema.def as unknown as Record<string, unknown> & { type: string };
  switch (definition.type) {
    case 'any':
    case 'unknown':
      // Passes the value, reference and all, through unchanged.
      return schema;
    case 'object':
      return placeInObject(schema, definition, path, depth);
    case 'array':
      return typeof path[depth] === 'number'
        ? rebuild(schema, definition, 'element', definition['element'], path, depth + 1)
        : undefined;
    case 'tuple':
      return placeInTuple(schema, definition, path, depth);
    case 'record':
      return typeof path[depth] === 'string'
        ? rebuild(schema, definition, 'valueType', definition['valueType'], path, depth + 1)
        : undefined;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
      return rebuild(schema, definition, 'innerType', definition['innerType'], path, depth);
    case 'lazy':
      return placeReference((definition['getter'] as () => z.ZodType)(), path, depth);
    default:
      // union, intersection, pipe, transform, catch, custom, and anything newer: fail closed.
      return undefined;
  }
}

function placeInObject(
  schema: z.ZodType,
  definition: Record<string, unknown>,
  path: Path,
  depth: number,
): z.ZodType | undefined {
  const key = path[depth];
  if (typeof key !== 'string') return undefined;
  const shape = definition['shape'] as Record<string, z.ZodType>;
  if (Object.hasOwn(shape, key)) {
    const placed = placeReference(shape[key] as z.ZodType, path, depth + 1);
    return placed === undefined
      ? undefined
      : schema.clone({ ...definition, shape: { ...shape, [key]: placed } } as never);
  }
  const catchall = definition['catchall'] as z.ZodType | undefined;
  // An unknown key is stripped (no catchall) or rejected (`strict`), with or without a reference.
  if (catchall === undefined || catchall.def.type === 'never') return schema;
  return rebuild(schema, definition, 'catchall', catchall, path, depth + 1);
}

function placeInTuple(
  schema: z.ZodType,
  definition: Record<string, unknown>,
  path: Path,
  depth: number,
): z.ZodType | undefined {
  const index = path[depth];
  if (typeof index !== 'number') return undefined;
  const items = definition['items'] as readonly z.ZodType[];
  if (index < items.length) {
    const placed = placeReference(items[index] as z.ZodType, path, depth + 1);
    if (placed === undefined) return undefined;
    const nextItems = [...items];
    nextItems[index] = placed;
    return schema.clone({ ...definition, items: nextItems } as never);
  }
  // Past the fixed items: the rest schema, or a tuple that rejects the extra element anyway.
  return definition['rest'] === null || definition['rest'] === undefined
    ? schema
    : rebuild(schema, definition, 'rest', definition['rest'], path, depth + 1);
}

/** Clones `schema` with its `field` sub-schema, `inner`, replaced by one that places the reference. */
function rebuild(
  schema: z.ZodType,
  definition: Record<string, unknown>,
  field: 'element' | 'valueType' | 'innerType' | 'catchall' | 'rest',
  inner: unknown,
  path: Path,
  depth: number,
): z.ZodType | undefined {
  const placed = placeReference(inner as z.ZodType, path, depth);
  return placed === undefined
    ? undefined
    : schema.clone({ ...definition, [field]: placed } as never);
}

/**
 * Accepts a `{ secretRef }` at this position, unchanged, and parses any other value with
 * `schema`. A shared sub-schema (an array's element, a record's value) is rewritten for every
 * entry, so a literal sibling must still parse as it did. The reference is tried first: a union
 * returns the first option that succeeds synchronously, so `schema`, whose checks may throw on an
 * object, never sees the reference.
 */
function acceptReference(schema: z.ZodType): z.ZodType {
  if (acceptsReference.has(schema)) return schema;
  const accepting = z.union([secretReferenceSchema, schema]);
  acceptsReference.set(accepting, schema);
  return accepting;
}
