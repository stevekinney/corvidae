import type {
  HookErrorHandler,
  HookMap,
  HookRegistrationOptions,
  HookRegistryOptions,
} from './types';

interface RegisteredHandler {
  handler: (...args: never[]) => unknown;
  priority: number;
  options: HookRegistrationOptions;
}

export class HookRegistry<M extends HookMap> {
  private readonly handlers = new Map<string, RegisteredHandler[]>();
  private readonly registryOptions: HookRegistryOptions;

  constructor(options?: HookRegistryOptions) {
    this.registryOptions = options ?? {};
  }

  on<K extends keyof M & string>(
    hookName: K,
    handler: M[K],
    options?: HookRegistrationOptions,
  ): () => void {
    const priority = options?.priority ?? 0;
    const entry: RegisteredHandler = { handler, priority, options: options ?? {} };

    let list = this.handlers.get(hookName);
    if (!list) {
      list = [];
      this.handlers.set(hookName, list);
    }
    list.push(entry);

    return () => {
      const current = this.handlers.get(hookName);
      if (!current) return;
      const index = current.indexOf(entry);
      if (index !== -1) {
        current.splice(index, 1);
      }
      if (current.length === 0) {
        this.handlers.delete(hookName);
      }
    };
  }

  run<K extends keyof M & string>(
    hookName: K,
    ...args: Parameters<M[K]>
  ): Promise<Awaited<ReturnType<M[K]>> | undefined>;
  async run(hookName: string, ...args: unknown[]): Promise<unknown> {
    return this.runUnchecked(hookName, args);
  }

  private async runUnchecked(hookName: string, args: unknown[]): Promise<unknown> {
    const list = this.handlers.get(hookName);
    if (!list || list.length === 0) {
      return undefined;
    }

    const sorted = list.toSorted((a, b) => b.priority - a.priority);

    const currentArgs = [...args];
    let hasReturnedValue = false;

    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i]!;
      try {
        const result = await Reflect.apply(entry.handler, undefined, currentArgs);
        if (result !== undefined) {
          currentArgs[0] = result;
          hasReturnedValue = true;
        }
      } catch (error: unknown) {
        const errorHandler = entry.options.onError ?? this.registryOptions.onError;
        if (!errorHandler) {
          throw error;
        }
        const decision = errorHandler(error, { hookName, handlerIndex: i });
        if (decision === 'abort') {
          throw error;
        }
        // 'continue' — skip to next handler
      }
    }

    return hasReturnedValue ? currentArgs[0] : undefined;
  }

  has(hookName: keyof M & string): boolean {
    const list = this.handlers.get(hookName);
    return list !== undefined && list.length > 0;
  }

  clear(hookName?: keyof M & string): void {
    if (hookName !== undefined) {
      this.handlers.delete(hookName);
    } else {
      this.handlers.clear();
    }
  }

  /**
   * Returns all registered handler entries for a given hook, sorted by priority (descending).
   * Used internally by mergeHookRegistries.
   */
  getHandlers<K extends keyof M & string>(
    hookName: K,
  ): ReadonlyArray<{ handler: M[K]; priority: number; options: HookRegistrationOptions }>;
  getHandlers(hookName: string): ReadonlyArray<RegisteredHandler> {
    const list = this.handlers.get(hookName);
    if (!list) return [];
    return list.toSorted((a, b) => b.priority - a.priority);
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
