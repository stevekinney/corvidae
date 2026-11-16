/**
 * What of a failure a pushed event may name (COR-2095, Revision 2026-11-16): a kind from a closed
 * list and a code that is an identifier, never text.
 *
 * An event is pushed to hooks, webhooks and delivery records, where a leak cannot be recalled, and
 * a denylist over provider error text had no complete form. So an event carries no free error text,
 * and the two structured fields that remain are checked on their shape, so that free text cannot
 * ride in them either (a hostile or careless error can set any string as its `code` or `kind`).
 *
 * @module published-error-names
 */

import type { AgentRunErrorKind } from '@lostgradient/operative';

/** The members of `AgentRunErrorKind`, as a runtime list the type is checked against below. */
const ERROR_KINDS = [
  'load',
  'contract',
  'generate',
  'tool',
  'abort',
  'output',
  'policy',
] as const satisfies readonly AgentRunErrorKind[];

/** Fails to compile when `AgentRunErrorKind` gains a member this list lacks. */
export const ERROR_KINDS_ARE_EXHAUSTIVE: Exclude<
  AgentRunErrorKind,
  (typeof ERROR_KINDS)[number]
> extends never
  ? true
  : never = true;

const KNOWN_ERROR_KINDS: ReadonlySet<string> = new Set(ERROR_KINDS);

/**
 * An error code that is an identifier: upper-case letters, digits and underscores, starting with a
 * letter, at most 64 characters. Every `AgentRunErrorCode` and every code Armorer assigns fits
 * (`UNKNOWN`, `MAXIMUM_STEPS`, `VALIDATION_ERROR`, `TOOL_UNAVAILABLE`, `INTERNAL_ERROR`).
 */
const IDENTIFIER = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The error kind to publish: `kind` when it is a member of the error-kind enum, otherwise nothing. */
export function publishableErrorKind(kind: unknown): string | undefined {
  return typeof kind === 'string' && KNOWN_ERROR_KINDS.has(kind) ? kind : undefined;
}

/** The error code to publish: `code` when it is an identifier, otherwise `fallback`. */
export function publishableErrorCode(code: unknown, fallback: string): string {
  return typeof code === 'string' && IDENTIFIER.test(code) ? code : fallback;
}
