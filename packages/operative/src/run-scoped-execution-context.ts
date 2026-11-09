/**
 * The run-scoped half of a tool call's `executionContext` (COR-2106).
 *
 * A run hands every tool call it makes a context naming the run itself: its child registry, its own
 * id, its delegated-authority grant and tool capabilities, its end of the parent's signal channel,
 * and (under Bureau) the child-invariant factory. A call that parks for approval is resumed later by
 * its host, outside the run's step, and must see the same context, or the resumed call runs as a
 * standalone one: a child it dispatches would lose Bureau's tier and its guardrails.
 *
 * Both the step that makes the call (`executeTools`) and a host that resumes it build the context
 * here, from the run's options, so a field added to the run-scoped set reaches both. The per-step
 * part (`durableChildWait`, which closes over the step's calls) stays with the step.
 */

import type { BureauChildInvariants } from './bureau-invariants';
import { readBureauInvariants, withBureauInvariants } from './bureau-invariants';
import type { RunOptions } from './types';

/**
 * What a run's options contribute to its tool calls' `executionContext`. `StepDeps` carries the same
 * fields, so the step reads them from its deps and a host reads them from the options it built.
 */
export interface RunScopedExecutionSource {
  /** The caller's own `executeOptions`; only its `executionContext` is read, as the base. */
  readonly executeOptions: RunOptions['executeOptions'];
  /** The run's id, the `parentRunId` its tool calls stamp on a child. */
  readonly runId: string | undefined;
  /** The run's own child registry. */
  readonly childRegistry: RunOptions['childRegistry'];
  /** The run's own already-attenuated delegated-authority grant. */
  readonly delegatedAuthority: RunOptions['delegatedAuthority'];
  /** Tool identities the delegation grant allows. */
  readonly delegatedToolCapabilities: RunOptions['delegatedToolCapabilities'];
  /** The run's own end of its parent's typed signal channel. */
  readonly parentSignals: RunOptions['parentSignals'];
  /** Set when Bureau owns the run. */
  readonly bureauInvariants: BureauChildInvariants | undefined;
}

/**
 * Reads the run-scoped fields out of a run's options, so `StepDeps` and a host that resumes a call
 * are fed from one list of fields.
 *
 * @internal
 */
export function runScopedExecutionSourceOf(options: RunOptions): RunScopedExecutionSource {
  return {
    executeOptions: options.executeOptions,
    runId: options.runId,
    childRegistry: options.childRegistry,
    delegatedAuthority: options.delegatedAuthority,
    delegatedToolCapabilities: options.delegatedToolCapabilities,
    parentSignals: options.parentSignals,
    bureauInvariants: readBureauInvariants(options),
  };
}

/**
 * The `executionContext` a run gives its tool calls apart from the per-step part: the caller's own
 * `executeOptions.executionContext` as the base, under the run-derived fields, so a caller-supplied
 * key survives unless it collides with one of them. `undefined` when the run has no run-scoped field
 * to give, so a call keeps the context the toolbox itself resolves.
 *
 * @internal
 */
export function runScopedExecutionContext(
  source: RunScopedExecutionSource,
): Record<string, unknown> | undefined {
  if (
    source.childRegistry === undefined &&
    source.runId === undefined &&
    source.delegatedAuthority === undefined &&
    source.delegatedToolCapabilities === undefined &&
    source.parentSignals === undefined &&
    source.bureauInvariants === undefined
  ) {
    return undefined;
  }
  return {
    ...withBureauInvariants(source.executeOptions?.executionContext ?? {}, source.bureauInvariants),
    ...(source.childRegistry !== undefined ? { childRegistry: source.childRegistry } : {}),
    ...(source.runId !== undefined ? { parentRunId: source.runId } : {}),
    ...(source.delegatedAuthority !== undefined
      ? { delegatedAuthority: source.delegatedAuthority }
      : {}),
    ...(source.delegatedToolCapabilities !== undefined
      ? { delegatedToolCapabilities: source.delegatedToolCapabilities }
      : {}),
    // COR-814 — this run's own port to its parent, replacing any `parentSignals` key a caller put
    // in `executeOptions`.
    ...(source.parentSignals !== undefined ? { parentSignals: source.parentSignals } : {}),
  };
}

/**
 * The run-scoped `executionContext` of a run built from `options`: what a host passes when it
 * resumes one of the run's parked tool calls, so the resumed call sees what an uninterrupted one
 * would have.
 *
 * @internal
 */
export function runScopedExecutionContextOf(
  options: RunOptions,
): Record<string, unknown> | undefined {
  return runScopedExecutionContext(runScopedExecutionSourceOf(options));
}
