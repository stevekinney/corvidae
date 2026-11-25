import { QueryObserver, type QueryObserverResult } from '@tanstack/svelte-query';
import { untrack } from 'svelte';
import type { CatalogHost } from './index.ts';

/** A getter-driven read whose observer follows its owning attachment. */
export function createReactiveRead<Input, Output>(
  host: CatalogHost,
  operation: string,
  input: () => Input,
) {
  const initial = new QueryObserver<Output>(host.cache, {
    queryKey: host.key(operation, untrack(input)),
    enabled: false,
  });
  let result = $state.raw<QueryObserverResult<Output> | undefined>(initial.getCurrentResult());
  initial.destroy();
  let stop: (() => void) | undefined;
  const dispose = () => {
    stop?.();
    stop = undefined;
    result = undefined;
  };
  host.own(dispose);
  return {
    get data() {
      return result?.data;
    },
    get isInitialLoading() {
      return result?.isPending ?? true;
    },
    get isRefreshing() {
      return result?.isRefetching ?? false;
    },
    get initialError() {
      return result?.data === undefined ? result?.error : undefined;
    },
    get refreshError() {
      return result?.data !== undefined ? result?.error : undefined;
    },
    activate() {
      dispose();
      stop = $effect.root(() => {
        $effect(() => {
          const value = $state.snapshot(input());
          const observer = new QueryObserver<Output>(host.cache, {
            queryKey: host.key(operation, value),
            queryFn: ({ signal }) => host.call(operation, value, signal) as Promise<Output>,
            staleTime: Infinity,
            retry: false,
          });
          result = observer.getCurrentResult();
          const unsubscribe = observer.subscribe((next) => {
            result = next;
          });
          return () => {
            unsubscribe();
            observer.destroy();
          };
        });
      });
      return dispose;
    },
    refresh() {
      const value = untrack(input);
      return host.cache.fetchQuery({
        queryKey: host.key(operation, value),
        queryFn: ({ signal }) => host.call(operation, value, signal) as Promise<Output>,
        staleTime: 0,
        retry: false,
      });
    },
    dispose,
  };
}
