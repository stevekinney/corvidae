/**
 * Bureau's invariant hook tier for child runs (COR-2106).
 *
 * A child dispatched by a Bureau-owned run must carry Bureau's identity and
 * guardrail hooks, as a catalog dispatch does. Those hooks reach a run only by
 * being merged into its resolved `RunOptions`, so a child whose agent exposes no
 * `OPERATIVE_RESOLVE_RUN_OPTIONS` has nowhere to receive them and is refused.
 *
 * What travels from a Bureau-owned parent run to its children is a factory, not
 * a registry: the guardrail registrations hold per-run taint state, so each child
 * needs a fresh one, and whether Bureau registers its guardrails at all depends
 * on the child's agent (`resolvesOwnGuardrails`).
 *
 * The factory rides on a symbol-keyed field, never a declared one, and the
 * symbol is private to this module (never `Symbol.for`). It is deliberately not
 * the caller-facing hook field COR-567 Decision 4 declines: no options or
 * context type declares it, so plain data a caller supplies (a request body, a
 * stored record, a context literal) has no name to write it under, and a
 * `Symbol.for` key a caller invents is ignored. That is the whole guarantee.
 * It is not "only a host can attach": this module's index exports
 * {@link withBureauInvariants} and {@link bureauInvariantsField}, so any
 * in-process caller can attach a factory, as it can register any hook. It is
 * never persisted: a recovered run is rebuilt by the same host code that built
 * it.
 *
 * The symbol is private to one loaded copy of this module, which a workspace guarantees. If two copies
 * of Operative were ever loaded, the host's `bureauInvariantsField` and a child's `readBureauInvariants`
 * would disagree about the key, the child would look standalone, and it would run without Bureau's tier
 * (the gap this closes), so there is deliberately no `Symbol.for` here.
 *
 * A parent run whose context carries no factory is not under Bureau, so a
 * resolver-less child keeps running through `agent.run()` exactly as before.
 */

import type { HookRegistry } from '@lostgradient/lifecycle';

import type { OperativeHookMap } from './hooks';

/**
 * Private to this module on purpose: it is not `Symbol.for`, so no other package
 * or caller can name it, and the only way onto a context or options bag is
 * {@link withBureauInvariants}.
 */
const BUREAU_INVARIANTS: unique symbol = Symbol('@lostgradient/operative/bureau-invariants');

/**
 * What a child's agent tells Bureau when it asks for its invariant hooks.
 *
 * `agentResolvesGuardrails` is true for an agent that applies its own guardrails
 * (`createAgent`), in which case Bureau registers none of its own for that run.
 */
export interface BureauChildInvariantRequest {
  /** Whether the child's agent applies its own guardrails. */
  readonly agentResolvesGuardrails: boolean;
}

/**
 * The tiers above a child's own that Bureau hands one child run, each a fresh
 * registry (COR-2106, COR-2127).
 */
export interface BureauChildTiers {
  /** Bureau's identity and guardrail registrations. */
  readonly bureau: HookRegistry<OperativeHookMap>;
  /**
   * The interceptor sets plugins apply to every agent, or `undefined` when no
   * plugin applies one (COR-2127).
   */
  readonly plugin: HookRegistry<OperativeHookMap> | undefined;
}

/**
 * Builds the tiers Bureau composes in front of one child run's own: its
 * identity and guardrail registrations, and the interceptor sets plugins apply
 * to every agent, as fresh registries per call so one child's guardrail state
 * never leaks into a sibling's.
 *
 * @internal
 */
export type BureauChildInvariants = (request: BureauChildInvariantRequest) => BureauChildTiers;

/**
 * The field a `RunOptions` literal or a run context spreads in to carry Bureau's child-invariant
 * factory: `{ ...bureauInvariantsField(invariants) }`. Empty when there is none.
 *
 * Meant for the host that owns the run: it is how a run tells the children it dispatches that
 * Bureau owns it. Nothing enforces that, since the function is exported.
 *
 * @internal
 */
export function bureauInvariantsField(invariants: BureauChildInvariants | undefined): object {
  return invariants === undefined ? {} : { [BUREAU_INVARIANTS]: invariants };
}

/**
 * Attaches Bureau's child-invariant factory to a run context or a `RunOptions` bag and returns
 * the extended copy. See {@link bureauInvariantsField}.
 *
 * @internal
 */
export function withBureauInvariants<T extends object>(
  target: T,
  invariants: BureauChildInvariants | undefined,
): T {
  return invariants === undefined ? target : { ...target, ...bureauInvariantsField(invariants) };
}

/**
 * Reads the factory {@link withBureauInvariants} attached, or `undefined` when
 * the run is not under Bureau.
 *
 * @internal
 */
export function readBureauInvariants(
  source: object | undefined,
): BureauChildInvariants | undefined {
  if (source === undefined) return undefined;
  const value: unknown = Reflect.get(source, BUREAU_INVARIANTS);
  return typeof value === 'function' ? (value as BureauChildInvariants) : undefined;
}
