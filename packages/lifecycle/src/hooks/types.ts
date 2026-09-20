export type HookMap = Record<string, (...args: never[]) => unknown>;

export type HookErrorHandler = (
  error: unknown,
  context: {
    hookName: string;
    /**
     * Position in the sorted run order for THIS invocation. Not stable across
     * invocations — use `id` to name the registration.
     */
    handlerIndex: number;
    /** Stable registration identity — see {@link HookRegistrationOptions.id}. */
    id: string;
  },
) => 'continue' | 'abort';

/**
 * How a hook behaves when its step re-runs on durable recovery (seam #11).
 *
 * - `safe` — read-only / no external side effect; re-running it is harmless.
 * - `effectful` — performs an external side effect (writes to a store, posts to
 *   a service). On a durable recovery the crashed in-flight step re-runs from its
 *   boundary, so an `effectful` hook fires AGAIN (at-least-once). The correct
 *   mitigation is to make the hook IDEMPOTENT (e.g. content/key-addressed writes),
 *   NOT to skip it on replay — skipping would drop the side effect for a step
 *   whose work (generate + tools) did re-execute. This classification is
 *   METADATA ONLY: it documents a hook's replay contract for authors and review.
 *   It does NOT gate execution, and nothing currently reads it at runtime —
 *   `HookRegistry` stores `replay` but does not act on it (a future dev-time
 *   warning could, but none exists yet). When unset, treat a hook as the
 *   conservative `effectful`.
 */
export type HookReplayPolicy = 'safe' | 'effectful';

export interface HookRegistrationOptions {
  priority?: number;
  onError?: HookErrorHandler;
  /**
   * Stable identity for this registration, for correlating observations of it
   * (COR-567).
   *
   * Nothing before this could name one registration. `handlerIndex` in
   * {@link HookErrorHandler}'s context is an index into a freshly sorted copy
   * computed inside each `run()` call, and the unregister closure splices the
   * live array, so it shifts when an earlier handler is removed — usable for
   * "which one threw, just now", never as a name. `hookName` identifies the
   * hook POINT, not a registration on it.
   *
   * Supplied by the registrant when it has a meaningful name to give. When
   * absent, {@link HookRegistry.on} assigns `<hookName>#<n>` from a
   * per-registry counter that never reuses a value, so an id is stable for a
   * registration's lifetime and is not recycled after unregistration.
   *
   * `mergeHookRegistries` spreads registration options through unchanged, so
   * an id survives a merge without extra handling.
   */
  id?: string;
  /**
   * Durable-recovery replay classification — see {@link HookReplayPolicy}.
   * Documentation/diagnostics only; never gates whether the hook runs.
   */
  replay?: HookReplayPolicy;
}

/**
 * One thing that happened to a hook plan, reported to every observer attached
 * with {@link HookRegistry.observe}.
 *
 * `invoked` and `failed` are mutually exclusive outcomes of a single
 * invocation: exactly one fires per handler call, never both and never
 * neither. There is deliberately no `replayed` variant — see
 * {@link HookReplayPolicy}: a registry cannot know that a specific entry ran
 * before without durable per-entry invocation history, and keeping that
 * history in order to suppress a second `invoked` would contradict the
 * idempotency contract that makes replay safe in the first place. A durable
 * re-execution is reported as an ordinary `invoked`; a consumer that needs to
 * distinguish one reads the recovery marker on its own run correlation.
 */
export type HookPlanObservation =
  | {
      kind: 'registered';
      hookName: string;
      id: string;
      priority: number;
      replay: HookReplayPolicy;
    }
  | { kind: 'removed'; hookName: string; id: string }
  | { kind: 'invoked'; hookName: string; id: string; durationMilliseconds: number }
  | {
      kind: 'failed';
      hookName: string;
      id: string;
      durationMilliseconds: number;
      error: unknown;
    };

/**
 * Observes a hook plan. Read-only: an observer cannot change what runs, what a
 * handler receives, or what it returns.
 *
 * Must not throw. One that does is reported to the registry's `onError` when
 * configured, and otherwise re-thrown from a microtask so it surfaces as an
 * unhandled error — never allowed to fail the hook invocation it observed,
 * because a diagnostic that can kill a run is worse than no diagnostic.
 */
export type HookPlanObserver = (observation: HookPlanObservation) => void;

export interface HookRegistryOptions {
  onError?: HookErrorHandler;
  /**
   * Clock backing the `durationMilliseconds` an observer receives. Defaults to
   * `Date.now`; inject for deterministic tests.
   */
  now?: () => number;
}
