import { isStandardSchema, isZodSchema } from 'armorer';

import type { DecisionRequest } from './types';

function requireText(value: unknown, what: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`A decision request needs ${what}.`);
  }
}

/**
 * Rejects a malformed {@link DecisionRequest} before any provider is called.
 * A `choice` needs at least two options with distinct keys and non-empty
 * labels; a `scale` needs at least two distinct, non-empty levels, because a
 * one-sided or ambiguous scale has no answer worth asking for.
 *
 * @throws {TypeError} Naming the first violation.
 */
export function assertValidDecisionRequest(request: DecisionRequest): void {
  if (typeof request !== 'object' || request === null) {
    throw new TypeError('A decision request must be an object.');
  }
  requireText(request.question, 'a non-empty question');
  if (request.context !== undefined && typeof request.context !== 'string') {
    throw new TypeError('A decision request context must be text.');
  }
  switch (request.kind) {
    case 'boolean':
      return;
    case 'choice': {
      if (!Array.isArray(request.options) || request.options.length < 2) {
        throw new TypeError('A choice request needs at least two options.');
      }
      const keys = new Set<string>();
      for (const option of request.options) {
        requireText(option?.key, 'a non-empty key on every option');
        requireText(option.label, `a non-empty label on option "${option.key}"`);
        if (keys.has(option.key)) {
          throw new TypeError(`A choice request repeats the option key "${option.key}".`);
        }
        keys.add(option.key);
      }
      return;
    }
    case 'scale': {
      if (!Array.isArray(request.levels) || request.levels.length < 2) {
        throw new TypeError('A scale request needs at least two levels.');
      }
      const seen = new Set<string>();
      for (const level of request.levels) {
        requireText(level, 'a non-empty description on every level');
        if (seen.has(level)) {
          throw new TypeError(`A scale request repeats the level "${level}".`);
        }
        seen.add(level);
      }
      return;
    }
    case 'structured':
      if (!isZodSchema(request.schema) && !isStandardSchema(request.schema)) {
        throw new TypeError('A structured request needs a Zod schema or a Standard Schema.');
      }
      return;
    default:
      throw new TypeError(
        `Unknown decision kind "${String((request as { kind?: unknown }).kind)}".`,
      );
  }
}
