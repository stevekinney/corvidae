import { z } from 'zod';

import type { MinimalAbortSignal } from '../is-tool';
import { findSecretReferences } from '../secrets';
import { racePreExecution } from './cancellation';

/**
 * Validates the arguments of a call that carries `{ secretRef }` values, for admission, policy and
 * approval. Those stages must see the reference form, so they cannot validate the plaintext, and
 * a schema that expects a string at that position rejects the reference object.
 *
 * The arguments are parsed as they are. A failure whose every issue sits at (or below) a reference
 * is ignored and the unparsed arguments stand in for the parse, because the plaintext is what that
 * position's schema is meant to judge and {@link parseSubstitutedArguments} does that later. Any
 * other issue is a real validation failure and is thrown unchanged.
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
  const result = await schema.safeParseAsync(argumentsValue);
  if (result.success) return result;
  const referencePaths = findSecretReferences(argumentsValue).map((location) => location.path);
  const onlyAtReferences = result.error.issues.every((issue) =>
    referencePaths.some((path) => isWithin(issue.path, path)),
  );
  return onlyAtReferences ? { success: true, data: argumentsValue } : result;
}

/**
 * Validates the substituted arguments, right before the tool runs. A failure is rethrown with
 * each issue's message replaced by a fixed sentence, because a message written by a schema or a
 * refinement can quote the value it rejected, and the value here is a secret. Paths and the
 * `custom` code survive; the plaintext does not.
 */
export async function parseSubstitutedArguments(
  schema: z.ZodType,
  substituted: unknown,
): Promise<unknown> {
  const result = await schema.safeParseAsync(substituted);
  if (result.success) return result.data;
  throw new z.ZodRealError(
    result.error.issues.map((issue) => ({
      code: 'custom' as const,
      path: issue.path,
      message: 'The value failed validation after secret references were substituted.',
    })),
  );
}

function isWithin(issuePath: readonly PropertyKey[], referencePath: readonly (string | number)[]) {
  return (
    issuePath.length >= referencePath.length &&
    referencePath.every((segment, index) => issuePath[index] === segment)
  );
}
