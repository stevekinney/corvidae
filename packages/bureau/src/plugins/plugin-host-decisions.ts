/**
 * COR-2204 — `PluginHost.decisions.decide`: a plugin asks a decision as itself.
 *
 * The call checks, in order, that the Bureau is not disposed (a {@link PluginHostDisposedError}: a
 * disposed Bureau records nothing, so a call would answer with no record), that its options are
 * well formed (`BAD_REQUEST`), that its signal is not already aborted (the signal's reason), and
 * that every secret the plugin declared is set (the secret gate's refusal, as for `publish`). Only
 * then does it ask Bureau's decisions, handing over just the plugin's principal `plugin:<name>` and
 * the three options a plugin may set: `taskId`, `requireKinds` and `signal`. A principal or a
 * `routingId` an untyped caller passes is dropped, so a plugin cannot decide as another principal.
 * The signal Bureau gets also aborts when the Bureau shuts down. A rejected check asks no model and
 * records nothing. The host adds no deadline and no concurrency limit.
 *
 * @module plugin-host-decisions
 */

import type { PluginHost } from '@lostgradient/interborough-plugin';
import type { DecisionKind } from '@lostgradient/operative';

import type { DecisionSource } from '../decisions/types';
import { PluginHostDisposedError } from './plugin-event-publish';
import type { PluginSecretGate } from './plugin-secret-gate';

/** What the `decide` of one plugin's host API reads. */
export interface PluginDecideDependencies {
  /** The plugin's name. */
  readonly plugin: string;
  /** Bureau's decisions, which the call is forwarded to. */
  readonly decisions: DecisionSource;
  /** The gate over the secrets the plugin declared, when it declares any. */
  readonly gate: PluginSecretGate | undefined;
  /** Whether the Bureau no longer records or delivers events. */
  readonly isDisposed: () => boolean;
  /** `signal` merged with the Bureau's shutdown signal. */
  readonly withShutdownSignal: (signal: AbortSignal | undefined) => AbortSignal;
  /** Refuses malformed input, as `BAD_REQUEST`. */
  readonly badRequest: (message: string) => never;
}

const DECISION_KINDS: ReadonlySet<string> = new Set<DecisionKind>([
  'boolean',
  'choice',
  'scale',
  'structured',
]);

/** The `decisions.decide` of one plugin's host API. */
export function createPluginDecide(
  dependencies: PluginDecideDependencies,
): PluginHost['decisions']['decide'] {
  const { plugin, decisions, gate, isDisposed, withShutdownSignal, badRequest } = dependencies;
  const principal = `plugin:${plugin}`;
  return async (request, given) => {
    if (isDisposed()) throw new PluginHostDisposedError(plugin, 'decide');
    // The caller owns `given`: each option is read once, here, before the call is awaited.
    if (given !== undefined && (typeof given !== 'object' || given === null)) {
      badRequest('The options of "host.decisions.decide" must be an object');
    }
    const { signal, taskId, requireKinds } = given ?? {};
    if (taskId !== undefined && (typeof taskId !== 'string' || taskId === '')) {
      badRequest('"taskId" must be a non-empty string');
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      badRequest('"signal" must be an AbortSignal');
    }
    if (
      requireKinds !== undefined &&
      (!Array.isArray(requireKinds) ||
        requireKinds.length === 0 ||
        !requireKinds.every((kind) => typeof kind === 'string' && DECISION_KINDS.has(kind)))
    ) {
      badRequest('"requireKinds" must be a non-empty list of decision kinds');
    }
    signal?.throwIfAborted();
    gate?.assertAvailable(`${plugin}:decisions.decide`);
    return decisions.decide(request, {
      principal,
      ...(taskId === undefined ? {} : { taskId }),
      ...(requireKinds === undefined ? {} : { requireKinds: [...requireKinds] }),
      signal: withShutdownSignal(signal),
    });
  };
}
