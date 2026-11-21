import type { NavigationEvent, NavigationHooks } from "../data/contract.ts";
import type { ClientOptions } from "./types.ts";

export function createNavigationHooks(options: ClientOptions) {
  const callbacks: {
    [Stage in keyof NavigationHooks]: Set<NavigationHooks[Stage]>;
  } = { before: new Set(), on: new Set(), after: new Set() };
  return {
    register<Stage extends keyof NavigationHooks>(
      this: void,
      stage: Stage,
      callback: NavigationHooks[Stage],
    ) {
      callbacks[stage].add(callback);
      return () => {
        callbacks[stage].delete(callback);
      };
    },
    canceled(event: NavigationEvent) {
      let canceled = false;
      const attempt = {
        ...event,
        cancel: () => {
          canceled = true;
        },
      };
      options.beforeNavigate?.(attempt);
      for (const callback of callbacks.before) callback(attempt);
      return canceled;
    },
    prepare(event: NavigationEvent) {
      if (callbacks.on.size)
        return Promise.all(
          Array.from(callbacks.on, async (callback) => callback(event)),
        );
    },
    enter(url: URL) {
      const event: NavigationEvent = {
        from: url,
        to: url,
        type: "enter",
        shallow: false,
        params: null,
        routeId: null,
      };
      for (const callback of callbacks.after) callback(event);
    },
    finish(event: NavigationEvent, complete?: (void | (() => void))[]) {
      if (event.type !== "enter")
        options.afterNavigate?.({ ...event, type: event.type });
      for (const callback of callbacks.after) callback(event);
      for (const callback of complete ?? []) callback?.();
    },
  };
}
