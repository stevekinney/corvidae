import type { CatalogTransport, SubscriptionTransport } from '@lostgradient/backchannel/client';
import { QueryObserver, type QueryClient } from '@tanstack/svelte-query';
import { readonly, writable } from 'svelte/store';
export { activateResource, loadMoreWhenVisible } from './attachments.ts';
export { getCatalogHost } from './context.ts';
export { createPagination, type PaginationFields } from './pagination.ts';
export { createReactiveRead } from './read.svelte.ts';

/** A scoped owner for catalog reads and commands. */
export type CatalogHost = ReturnType<typeof createCatalogHost>;

/** A command whose response was lost may have committed on the server. */
export class UnknownCommandOutcome extends Error {
  constructor(cause: unknown) {
    super('The command outcome is unknown; reconcile with a fresh read before retrying.', {
      cause,
    });
    this.name = 'UnknownCommandOutcome';
  }
}

/** Own the cache entries and in-flight requests for one authenticated scope. */
export function createCatalogHost(options: {
  readonly scope: string;
  readonly cache: QueryClient;
  readonly transport: CatalogTransport;
  readonly subscription?: SubscriptionTransport | undefined;
}) {
  if (!options.scope) throw new Error('A nonempty catalog scope is required');
  let disposed = false;
  const controllers = new Set<AbortController>();
  const releases = new Set<() => void>();
  const commands = new Map<string, { active: number; uncertain: boolean; reconciling: boolean }>();
  const commandState = (operation: string) => {
    let state = commands.get(operation);
    if (!state) {
      state = { active: 0, uncertain: false, reconciling: false };
      commands.set(operation, state);
    }
    return state;
  };
  const prefix = ['backchannel', options.scope] as const;
  return {
    scope: options.scope,
    cache: options.cache,
    subscription: options.subscription,
    key(operation: string, input: unknown) {
      return [...prefix, operation, input] as const;
    },
    get disposed() {
      return disposed;
    },
    beginCommand(operation: string) {
      const state = commandState(operation);
      if (state.uncertain || state.reconciling)
        throw new Error('Reconcile the unknown outcome before another command');
      state.active++;
    },
    endCommand(operation: string) {
      commandState(operation).active--;
    },
    markUncertain(operation: string) {
      commandState(operation).uncertain = true;
    },
    beginReconciliation(operation: string) {
      const state = commandState(operation);
      if (state.active > 0) throw new Error('A command is still pending');
      if (!state.uncertain || state.reconciling)
        throw new Error('No unknown outcome is available to reconcile');
      state.reconciling = true;
    },
    endReconciliation(operation: string, succeeded: boolean) {
      const state = commandState(operation);
      state.reconciling = false;
      if (succeeded && !disposed) state.uncertain = false;
    },
    seed<Output>(
      operation: string,
      input: unknown,
      data: unknown,
      validate: (value: unknown) => value is Output,
    ) {
      if (disposed) throw new Error('Catalog scope is disposed');
      if (!validate(data)) throw new Error(`Invalid seed for ${operation}`);
      const capturedInput =
        input === undefined ? undefined : (JSON.parse(JSON.stringify(input)) as unknown);
      const capturedData =
        data === undefined ? undefined : (JSON.parse(JSON.stringify(data)) as unknown);
      options.cache.setQueryData([...prefix, operation, capturedInput], capturedData);
    },
    own(release: () => void) {
      releases.add(release);
      return () => releases.delete(release);
    },
    async call(operation: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
      if (disposed) throw new Error('Catalog scope is disposed');
      const controller = new AbortController();
      controllers.add(controller);
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      try {
        const captured =
          input === undefined ? undefined : (JSON.parse(JSON.stringify(input)) as unknown);
        const result = await options.transport(operation, captured, { signal: controller.signal });
        if (disposed || controller.signal.aborted)
          throw new Error('Catalog request was interrupted');
        return result;
      } finally {
        signal?.removeEventListener('abort', abort);
        controllers.delete(controller);
      }
    },
    invalidate(operations: readonly string[]) {
      for (const operation of operations)
        void options.cache.invalidateQueries({ queryKey: [...prefix, operation] });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of controllers) controller.abort();
      for (const release of releases) release();
      releases.clear();
      options.cache.removeQueries({ queryKey: prefix });
    },
  };
}

/** Observe a declared stream, retaining its cursor across explicit reconnects. */
export function createSubscription<Event>(
  host: CatalogHost,
  operation: string,
  input: unknown,
  onEvent: (event: Event) => void,
) {
  const transport = host.subscription;
  if (!transport) throw new Error('Subscription transport unsupported');
  let cursor: string | undefined;
  let controller: AbortController | undefined;
  let disposed = false;
  const seen = new Set<string>();
  const captured = input === undefined ? undefined : (JSON.parse(JSON.stringify(input)) as unknown);
  const dispose = () => {
    disposed = true;
    controller?.abort();
  };
  host.own(dispose);
  return {
    async connect() {
      if (disposed || host.disposed) throw new Error('Subscription is disposed');
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const requestInput =
        captured === undefined ? undefined : (JSON.parse(JSON.stringify(captured)) as unknown);
      for await (const message of transport(operation, requestInput, {
        signal: current.signal,
        lastEventId: cursor,
      })) {
        if (current.signal.aborted || disposed || host.disposed) break;
        if (message.type !== 'event' || seen.has(message.id)) continue;
        seen.add(message.id);
        cursor = message.id;
        onEvent(message.data as Event);
      }
    },
    dispose,
  };
}

/** Construct a read observer. Its input is evaluated at each refresh. */
export function createRead<Input, Output>(
  host: CatalogHost,
  operation: string,
  input: () => Input,
) {
  let observer: QueryObserver<Output> | undefined;
  let unsubscribe: (() => void) | undefined;
  const release = () => {
    unsubscribe?.();
    observer?.destroy();
    observer = undefined;
    unsubscribe = undefined;
  };
  host.own(release);
  return {
    get data() {
      return observer?.getCurrentResult().data;
    },
    async refresh(): Promise<Output> {
      const value = input();
      return host.cache.fetchQuery({
        queryKey: host.key(operation, value),
        queryFn: ({ signal }) => host.call(operation, value, signal) as Promise<Output>,
        retry: false,
        staleTime: 0,
      });
    },
    activate() {
      release();
      const value = input();
      const nextObserver = new QueryObserver<Output>(host.cache, {
        queryKey: host.key(operation, value),
        queryFn: ({ signal }) => host.call(operation, value, signal) as Promise<Output>,
        retry: false,
        staleTime: Infinity,
      });
      observer = nextObserver;
      unsubscribe = nextObserver.subscribe(() => {});
      return release;
    },
  };
}

/** Construct a command; results are returned only to its caller and never enter mutation history. */
export function createCommand<Input, Output>(
  host: CatalogHost,
  operation: string,
  invalidates: readonly string[],
) {
  const invalidationTargets = [...invalidates];
  const pending = writable(false);
  const fault = writable<'unknown' | undefined>();
  let active = 0;
  host.own(() => {
    pending.set(false);
    fault.set(undefined);
  });
  return {
    pending: readonly(pending),
    fault: readonly(fault),
    async mutateAsync(input: Input): Promise<Output> {
      if (host.disposed) throw new Error('Catalog scope is disposed');
      host.beginCommand(operation);
      active++;
      pending.set(true);
      fault.set(undefined);
      let result: unknown;
      try {
        result = await host.call(operation, input);
        if (host.disposed) throw new Error('Catalog request was interrupted');
      } catch (cause) {
        if (host.disposed) throw cause;
        host.markUncertain(operation);
        fault.set('unknown');
        throw new UnknownCommandOutcome(cause);
      } finally {
        host.endCommand(operation);
        active--;
        if (!host.disposed) pending.set(active > 0);
      }
      host.invalidate(invalidationTargets);
      return result as Output;
    },
    async reconcile(read: string, input: unknown) {
      if (!invalidationTargets.includes(read))
        throw new Error('Reconciliation requires a declared invalidated read');
      host.beginReconciliation(operation);
      let succeeded = false;
      try {
        const result = await host.call(read, input);
        if (host.disposed) throw new Error('Catalog request was interrupted');
        succeeded = true;
        return result;
      } finally {
        host.endReconciliation(operation, succeeded);
      }
    },
  };
}
