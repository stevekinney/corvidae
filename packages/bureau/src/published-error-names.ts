/**
 * What of a failure a pushed event may name (COR-2095, Revision 2026-11-16): a kind from a closed
 * list and a code that is an identifier, never text.
 *
 * An event is pushed to hooks, webhooks and delivery records, where a leak cannot be recalled, and
 * a denylist over provider error text had no complete form. So an event carries no free error text,
 * and the two structured fields that remain are checked on their shape, so that free text cannot
 * ride in them either (a hostile or careless error can set any string as its `code` or `kind`).
 *
 * COR-2097 adds three more checks of the same kind: a child's finish reason (a child's failure can
 * put a rejection's message where its finish reason would be), a steering command's failure reason,
 * and a name a registrant chose (a hook's registration id and the tier or plugin that registered
 * it, a workflow version), each checked on its shape.
 *
 * @module published-error-names
 */

import type {
  AgentRunErrorKind,
  FinishReason,
  SteeringCommandFailure,
} from '@lostgradient/operative';

import type { HookDeliveryFailureOutcome } from './hooks/hook-types';
import { PLUGIN_PROBLEM_CODES, type PluginProblemCode } from './plugins/plugin-problem-codes';
import type { PluginStatus } from './plugins/plugin-types';

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

/** The members of `FinishReason`, as a runtime list the type is checked against below. */
const FINISH_REASONS = [
  'stop-condition',
  'maximum-steps',
  'aborted',
  'error',
  'elicitation-denied',
  'budget-exceeded',
  'tripwire',
] as const satisfies readonly FinishReason[];

/** Fails to compile when `FinishReason` gains a member this list lacks. */
export const FINISH_REASONS_ARE_EXHAUSTIVE: Exclude<
  FinishReason,
  (typeof FINISH_REASONS)[number]
> extends never
  ? true
  : never = true;

const KNOWN_FINISH_REASONS: ReadonlySet<string> = new Set(FINISH_REASONS);

/** The members of `SteeringCommandFailure['reason']`, as a runtime list the type is checked against below. */
const STEERING_FAILURE_REASONS = [
  'session-terminal',
  'run-terminal',
  'run-ambiguous',
  'authorization-revoked',
  'policy-denied',
  'model-not-allowed',
  'stale-revision',
  'shutting-down',
  'deadline-passed',
  'superseded-by',
] as const satisfies readonly SteeringCommandFailure['reason'][];

/** Fails to compile when `SteeringCommandFailure` gains a reason this list lacks. */
export const STEERING_FAILURE_REASONS_ARE_EXHAUSTIVE: Exclude<
  SteeringCommandFailure['reason'],
  (typeof STEERING_FAILURE_REASONS)[number]
> extends never
  ? true
  : never = true;

const KNOWN_STEERING_FAILURE_REASONS: ReadonlySet<string> = new Set(STEERING_FAILURE_REASONS);

/**
 * A name a registrant gave and no run produced (a hook's registration id, the hook point it sits
 * on, the tier or plugin that registered it): one token of letters, digits and `. _ : @ / -`, at
 * most 128 characters, so that a sentence cannot ride in it. It starts with a letter, a digit or
 * the `@` of a scoped package name.
 */
const TOKEN = /^[A-Za-z0-9@][A-Za-z0-9._:@/-]{0,127}$/;

/** The members of `PluginStatus`, as a runtime list the type is checked against below. */
const PLUGIN_STATUSES = [
  'running',
  'needs-setup',
  'disabled',
  'skipped',
] as const satisfies readonly PluginStatus[];

/** Fails to compile when `PluginStatus` gains a member this list lacks. */
export const PLUGIN_STATUSES_ARE_EXHAUSTIVE: Exclude<
  PluginStatus,
  (typeof PLUGIN_STATUSES)[number]
> extends never
  ? true
  : never = true;

const KNOWN_PLUGIN_STATUSES: ReadonlySet<string> = new Set(PLUGIN_STATUSES);

/**
 * A secret key as Bungalow stores one (`^[a-z0-9][a-z0-9-]*$`), at most 128 characters: what a
 * plugin's descriptor declares. No other shape is a key a host may report.
 */
const SECRET_KEY = /^[a-z0-9][a-z0-9-]{0,127}$/;

/** The members of `HookDeliveryFailureOutcome`, as a runtime list the type is checked against below. */
const HOOK_DELIVERY_FAILURE_OUTCOMES = [
  'response',
  'network-error',
  'refused',
  'error',
  'rejected',
] as const satisfies readonly HookDeliveryFailureOutcome[];

/** Fails to compile when `HookDeliveryFailureOutcome` gains a member this list lacks. */
export const HOOK_DELIVERY_FAILURE_OUTCOMES_ARE_EXHAUSTIVE: Exclude<
  HookDeliveryFailureOutcome,
  (typeof HOOK_DELIVERY_FAILURE_OUTCOMES)[number]
> extends never
  ? true
  : never = true;

const KNOWN_HOOK_DELIVERY_FAILURE_OUTCOMES: ReadonlySet<string> = new Set(
  HOOK_DELIVERY_FAILURE_OUTCOMES,
);

/**
 * The outcome of a failed delivery attempt to publish (COR-2099): `outcome` when it is a member of
 * the failure enum, otherwise `fallback`. An attempt's own error text never reaches an event.
 */
export function publishableDeliveryOutcome(
  outcome: unknown,
  fallback: HookDeliveryFailureOutcome,
): HookDeliveryFailureOutcome {
  return typeof outcome === 'string' && KNOWN_HOOK_DELIVERY_FAILURE_OUTCOMES.has(outcome)
    ? (outcome as HookDeliveryFailureOutcome)
    : fallback;
}

/** The error kind to publish: `kind` when it is a member of the error-kind enum, otherwise nothing. */
export function publishableErrorKind(kind: unknown): string | undefined {
  return typeof kind === 'string' && KNOWN_ERROR_KINDS.has(kind) ? kind : undefined;
}

/** The error code to publish: `code` when it is an identifier, otherwise `fallback`. */
export function publishableErrorCode(code: unknown, fallback: string): string {
  return typeof code === 'string' && IDENTIFIER.test(code) ? code : fallback;
}

/** The error code to publish: `code` when it is an identifier, otherwise nothing. */
export function publishableOptionalErrorCode(code: unknown): string | undefined {
  return typeof code === 'string' && IDENTIFIER.test(code) ? code : undefined;
}

/**
 * The finish reason to publish: `reason` when it is a member of the finish-reason enum, otherwise
 * `fallback`. A child's failure can carry a rejection's message where its finish reason would be.
 */
export function publishableFinishReason(reason: unknown, fallback: string): string {
  return typeof reason === 'string' && KNOWN_FINISH_REASONS.has(reason) ? reason : fallback;
}

/**
 * The reason a steering command did not run, to publish: `reason` when it is a member of the
 * steering failure enum, otherwise nothing.
 */
export function publishableSteeringFailureReason(reason: unknown): string | undefined {
  return typeof reason === 'string' && KNOWN_STEERING_FAILURE_REASONS.has(reason)
    ? reason
    : undefined;
}

/** `status` when it is a member of the plugin status enum, otherwise `undefined`. */
export function publishablePluginStatus(status: unknown): PluginStatus | undefined {
  return typeof status === 'string' && KNOWN_PLUGIN_STATUSES.has(status)
    ? (status as PluginStatus)
    : undefined;
}

/**
 * The problem codes to publish: every member of `codes` that is a plugin problem code, in order and
 * once each, or `undefined` when `codes` is not a list or holds anything else (a message or a path
 * among them would be free text, and one such entry refuses the list rather than being dropped).
 */
export function publishableProblemCodes(codes: unknown): PluginProblemCode[] | undefined {
  if (!Array.isArray(codes)) return undefined;
  const published: PluginProblemCode[] = [];
  for (const code of codes) {
    if (typeof code !== 'string' || !Object.hasOwn(PLUGIN_PROBLEM_CODES, code)) return undefined;
    if (!published.includes(code as PluginProblemCode)) published.push(code as PluginProblemCode);
  }
  return published;
}

/** `key` when it is a secret key as Bungalow stores one, otherwise `undefined`. */
export function publishableSecretKey(key: unknown): string | undefined {
  return typeof key === 'string' && SECRET_KEY.test(key) ? key : undefined;
}

/** `name` when it is one token a registrant could have chosen (see {@link TOKEN}), otherwise `undefined`. */
export function publishableToken(name: unknown): string | undefined {
  return typeof name === 'string' && TOKEN.test(name) ? name : undefined;
}
