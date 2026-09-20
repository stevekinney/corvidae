import type {
  HookErrorHandler,
  HookMap,
  HookPlanDescription,
  HookPlanEntryDescription,
  HookPlanObservation,
  HookPlanObserver,
  HookRegistrationOptions,
  HookRegistryOptions,
} from './types';

interface RegisteredHandler {
  handler: (...args: never[]) => unknown;
  priority: number;
  options: HookRegistrationOptions;
  /** Resolved at registration; never recycled. See `HookRegistrationOptions.id`. */
  id: string;
}

export class HookRegistry<M extends HookMap> {
  private readonly handlers = new Map<string, RegisteredHandler[]>();
  private readonly registryOptions: HookRegistryOptions;
  #revision = 0;
  /**
   * Monotonic per-registry counter backing generated ids. Separate from
   * `#revision`: that one counts membership changes including removals, so
   * reusing it would let an id be handed out twice after an unregistration.
   */
  #registrationSequence = 0;
  readonly #observers = new Set<HookPlanObserver>();

  constructor(options?: HookRegistryOptions) {
    this.registryOptions = options ?? {};
  }

  /**
   * Attaches an observer of this plan's registrations, removals, and handler
   * invocations. Returns an unsubscribe function.
   *
   * Observation is attached rather than configured at construction because the
   * party that wants to watch a plan is rarely the party that built it: a run
   * receives an already-populated registry from its caller and needs to watch
   * that one. A subscriber that also wants the entries registered BEFORE it
   * attached censuses them through `getHookNames()` and `getHandlers()` — this
   * deliberately does not replay them, so "observer attached late" stays
   * distinguishable from "entry registered late".
   */
  observe(observer: HookPlanObserver): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  /**
   * Reports one observation to every attached observer.
   *
   * A throwing observer must never fail the hook invocation that produced the
   * observation, and must never be silently swallowed either. It is routed to
   * the configured `onError` when there is one, and otherwise re-thrown from a
   * microtask, which surfaces it as an unhandled rejection instead of losing
   * it. The remaining observers still run: one broken observer does not
   * blind the others.
   */
  #notify(observation: HookPlanObservation): void {
    if (this.#observers.size === 0) return;
    for (const observer of this.#observers) {
      try {
        observer(observation);
      } catch (error: unknown) {
        const errorHandler = this.registryOptions.onError;
        if (errorHandler) {
          errorHandler(error, {
            hookName: observation.hookName,
            handlerIndex: -1,
            id: observation.id,
          });
        } else {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    }
  }

  /**
   * Monotonic count of membership changes to this registry: every
   * registration, every unregistration, and every `clear()` that actually
   * removed something advances it by one. Never decrements, never resets.
   *
   * This exists so a caller can tell whether the hook plan it observed
   * earlier is still the plan in force, without holding the handler list
   * itself. The effective-context epoch (COR-581) needs exactly that: it
   * records the hook plan as one versioned context source, and a registry
   * with no version could only be digested by walking and hashing every
   * registered handler, which is neither stable across identical closures
   * nor cheap at every generate attempt.
   *
   * It counts membership, not behavior. Two registries at the same
   * revision are not necessarily equivalent, and a handler whose captured
   * state changes does not advance it — the revision answers "has the set
   * of registered handlers changed since I last looked", which is the
   * question a reconciliation boundary actually asks.
   */
  get revision(): number {
    return this.#revision;
  }

  on<K extends keyof M & string>(
    hookName: K,
    handler: M[K],
    options?: HookRegistrationOptions,
  ): () => void {
    const priority = options?.priority ?? 0;
    this.#registrationSequence += 1;
    const id = options?.id ?? `${hookName}#${this.#registrationSequence}`;
    // Resolve the tier once, here, and store it ON THE ENTRY (COR-1265).
    // Reading `registryOptions.source` at inspection time instead would lose
    // it the moment `mergeHookRegistries` copies the entry into a merged
    // registry that belongs to no single tier.
    const source = options?.source ?? this.registryOptions.source;
    const entry: RegisteredHandler = {
      handler,
      priority,
      options: source === undefined ? (options ?? {}) : { ...options, source },
      id,
    };

    let list = this.handlers.get(hookName);
    if (!list) {
      list = [];
      this.handlers.set(hookName, list);
    }
    list.push(entry);
    this.#revision += 1;
    this.#notify({
      kind: 'registered',
      hookName,
      id,
      priority,
      // Unset means the conservative `effectful` — see `HookReplayPolicy`. An
      // observer should see the classification in force, not the absence of a
      // declaration.
      replay: options?.replay ?? 'effectful',
      ...(source === undefined ? {} : { source }),
    });

    // COR-1267 — report a registration that never declared a replay policy.
    // Fires only on absence, never on an explicit `effectful`: the point is
    // to separate a considered choice from an unconsidered default, and a
    // diagnostic that fires on both separates nothing.
    if (options?.replay === undefined && this.registryOptions.onUnclassifiedReplay) {
      try {
        this.registryOptions.onUnclassifiedReplay({ hookName, id });
      } catch {
        // Swallowed on purpose. A diagnostic that can fail a registration is
        // worse than no diagnostic — the same reasoning that isolates a
        // throwing plan observer from the invocation it observed.
      }
    }

    return () => {
      const current = this.handlers.get(hookName);
      if (!current) return;
      const index = current.indexOf(entry);
      if (index !== -1) {
        current.splice(index, 1);
        // Only a removal that actually happened counts: calling the same
        // unregister twice is idempotent and must not look like two
        // distinct plan changes to a boundary comparing revisions.
        this.#revision += 1;
        this.#notify({ kind: 'removed', hookName, id });
      }
      if (current.length === 0) {
        this.handlers.delete(hookName);
      }
    };
  }

  /**
   * Runs every handler as a WATERFALL: each handler's defined return value
   * replaces the first argument for the next handler, and the last such value
   * is returned.
   *
   * Correct only where a handler's return type IS its first parameter type —
   * `validateResponse` (response in, response out) and `validateToolResult`
   * (result in, result out). For a hook whose return is a DIFFERENT type
   * (`prepareStep` returns a response but takes a context; `selectTools`
   * returns a toolbox but takes a context), this would hand the second
   * handler the first one's return value in place of its context. Use
   * {@link runFirst} or {@link runLast} for those.
   */
  run<K extends keyof M & string>(
    hookName: K,
    ...args: Parameters<M[K]>
  ): Promise<Awaited<ReturnType<M[K]>> | undefined>;
  async run(hookName: string, ...args: unknown[]): Promise<unknown> {
    return this.dispatch(hookName, args, 'waterfall');
  }

  /**
   * Runs handlers in priority order against the SAME, unmodified arguments and
   * returns the FIRST defined result, leaving later handlers uninvoked.
   *
   * This is the short-circuit shape: a handler that answers ends the question.
   * `prepareStep` uses it (a handler returning a response replaces the generate
   * call, so running the rest would be pointless and would feed them a
   * response where they expect a step context), as does `beforeCompaction`
   * (the first veto decides).
   */
  runFirst<K extends keyof M & string>(
    hookName: K,
    ...args: Parameters<M[K]>
  ): Promise<Awaited<ReturnType<M[K]>> | undefined>;
  async runFirst(hookName: string, ...args: unknown[]): Promise<unknown> {
    return this.dispatch(hookName, args, 'first');
  }

  /**
   * Runs EVERY handler against the SAME, unmodified arguments and returns the
   * LAST defined result.
   *
   * This is the override shape, matching the legacy hook arrays for
   * `selectTools` and `selectToolChoice`: every handler is consulted and the
   * lowest-priority one to answer wins, because it ran last.
   */
  runLast<K extends keyof M & string>(
    hookName: K,
    ...args: Parameters<M[K]>
  ): Promise<Awaited<ReturnType<M[K]>> | undefined>;
  async runLast(hookName: string, ...args: unknown[]): Promise<unknown> {
    return this.dispatch(hookName, args, 'last');
  }

  /**
   * Invokes ONE already-resolved entry under this registry's error policy.
   *
   * Exposed for the call sites that iterate {@link getHandlers} themselves
   * because their hook's threading cannot be expressed by any of the three
   * dispatch shapes above — `beforeGenerate`/`afterGenerate` reapply steering
   * between handlers, `onError` interprets each handler's verdict, and
   * `beforeToolExecution` waterfalls a FIELD of its context rather than the
   * context itself. Routing those through here keeps one invocation path, so
   * an observer of this registry sees a hand-iterated hook exactly as it sees
   * a dispatched one.
   */
  async runHandler<K extends keyof M & string>(
    hookName: K,
    entry: { handler: M[K]; id: string },
    args: Parameters<M[K]>,
  ): Promise<unknown> {
    return this.invokeObserved(hookName, entry.id, entry.handler, args);
  }

  private async invokeObserved(
    hookName: string,
    id: string,
    handler: (...handlerArgs: never[]) => unknown,
    args: readonly unknown[],
  ): Promise<unknown> {
    const startedAt = this.registryOptions.now?.() ?? Date.now();
    try {
      const result = await Reflect.apply(handler, undefined, args);
      this.#notify({
        kind: 'invoked',
        hookName,
        id,
        durationMilliseconds: (this.registryOptions.now?.() ?? Date.now()) - startedAt,
      });
      return result;
    } catch (error: unknown) {
      this.#notify({
        kind: 'failed',
        hookName,
        id,
        durationMilliseconds: (this.registryOptions.now?.() ?? Date.now()) - startedAt,
        error,
      });
      throw error;
    }
  }

  private async dispatch(
    hookName: string,
    args: unknown[],
    mode: 'waterfall' | 'first' | 'last',
  ): Promise<unknown> {
    const list = this.handlers.get(hookName);
    if (!list || list.length === 0) {
      return undefined;
    }

    const sorted = list.toSorted((a, b) => b.priority - a.priority);

    // Only the waterfall mode rewrites this between handlers. `first` and
    // `last` hand every handler the arguments the caller passed.
    const currentArgs = [...args];
    let returned: unknown;
    let hasReturnedValue = false;

    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i]!;
      try {
        const result = await this.invokeObserved(hookName, entry.id, entry.handler, currentArgs);
        if (result !== undefined) {
          returned = result;
          hasReturnedValue = true;
          if (mode === 'waterfall') currentArgs[0] = result;
          if (mode === 'first') break;
        }
      } catch (error: unknown) {
        const errorHandler = entry.options.onError ?? this.registryOptions.onError;
        if (!errorHandler) {
          throw error;
        }
        const decision = errorHandler(error, { hookName, handlerIndex: i, id: entry.id });
        if (decision === 'abort') {
          throw error;
        }
        // 'continue' — skip to next handler
      }
    }

    return hasReturnedValue ? returned : undefined;
  }

  has(hookName: keyof M & string): boolean {
    const list = this.handlers.get(hookName);
    return list !== undefined && list.length > 0;
  }

  clear(hookName?: keyof M & string): void {
    // Captured before the delete so each departing entry can be reported
    // individually: an observer tracking plan membership by id cannot act on
    // a bare "something was cleared".
    const departing: Array<{ hookName: string; id: string }> = [];
    if (hookName !== undefined) {
      for (const entry of this.handlers.get(hookName) ?? []) {
        departing.push({ hookName, id: entry.id });
      }
      // `delete` reports whether anything was there — clearing an absent
      // hook name changes no membership and must not advance the revision.
      if (this.handlers.delete(hookName)) this.#revision += 1;
    } else {
      if (this.handlers.size > 0) {
        for (const [name, entries] of this.handlers) {
          for (const entry of entries) departing.push({ hookName: name, id: entry.id });
        }
        this.handlers.clear();
        this.#revision += 1;
      }
    }
    for (const departed of departing) {
      this.#notify({ kind: 'removed', hookName: departed.hookName, id: departed.id });
    }
  }

  /**
   * Returns all registered handler entries for a given hook, sorted by priority (descending).
   * Used internally by mergeHookRegistries.
   */
  getHandlers<K extends keyof M & string>(
    hookName: K,
  ): ReadonlyArray<{
    handler: M[K];
    priority: number;
    options: HookRegistrationOptions;
    /** Stable registration identity — see {@link HookRegistrationOptions.id}. */
    id: string;
  }>;
  getHandlers(hookName: string): ReadonlyArray<RegisteredHandler> {
    const list = this.handlers.get(hookName);
    if (!list) return [];
    return list.toSorted((a, b) => b.priority - a.priority);
  }

  /**
   * A redacted description of this plan, for inspection (COR-1270).
   *
   * The public counterpart to {@link getHandlers}, which stays the internal
   * accessor `mergeHookRegistries` needs and keeps returning live handlers.
   * The two are deliberately separate: composition needs the function,
   * inspection must never see it.
   *
   * Every entry is built field by field rather than spread from the
   * registration, so a field added to `HookRegistrationOptions` later does
   * not silently become readable here. No handler, no `onError` closure, and
   * nothing either of them closes over is reachable from the result.
   */
  describePlan(): HookPlanDescription {
    const entries: HookPlanEntryDescription[] = [];
    for (const hookName of this.handlers.keys()) {
      for (const entry of this.getHandlers(hookName)) {
        const source = entry.options.source;
        entries.push({
          hookName,
          id: entry.id,
          priority: entry.priority,
          // The classification in force, not the absence of a declaration —
          // the same resolution the `registered` observation reports.
          replay: entry.options.replay ?? 'effectful',
          ...(source === undefined ? {} : { source }),
        });
      }
    }
    return { revision: this.#revision, entries };
  }

  /**
   * Returns all hook names that have at least one registered handler.
   */
  getHookNames(): ReadonlyArray<keyof M & string>;
  getHookNames(): ReadonlyArray<string> {
    return [...this.handlers.keys()];
  }

  /**
   * The registry-wide error fallback, if configured — the same handler
   * `run()` falls back to when a handler has no per-registration `onError`.
   * Exposed so a caller that iterates `getHandlers()` results manually
   * (rather than calling `run()`) can apply the identical fallback instead
   * of bypassing it, without `run()` itself gaining a second code path.
   */
  get onError(): HookErrorHandler | undefined {
    return this.registryOptions.onError;
  }
}
