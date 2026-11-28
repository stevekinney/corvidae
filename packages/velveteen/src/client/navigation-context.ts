import { getContext, onMount } from "svelte";
import type {
  ApplicationState,
  NavigationHooks,
  NavigationProtocol,
  SnapshotRegistration,
} from "../data/contract.ts";

export const navigationContextKey = Symbol.for("velveteen.navigation");
export const navigationStateContextKey = Symbol.for(
  "velveteen.navigation-state",
);

export function getNavigation(): NavigationProtocol {
  const resolve = getContext<
    (() => NavigationProtocol | undefined) | undefined
  >(navigationContextKey);
  const method =
    <Key extends keyof NavigationProtocol>(key: Key) =>
    (...args: Parameters<NavigationProtocol[Key]>) => {
      const navigation = resolve?.();
      if (!navigation)
        throw new Error("Navigation is unavailable outside a Velveteen client");
      return (
        navigation[key] as (
          ...values: Parameters<NavigationProtocol[Key]>
        ) => ReturnType<NavigationProtocol[Key]>
      )(...args);
    };
  return {
    enhance: method("enhance"),
    goto: method("goto"),
    preloadCode: method("preloadCode"),
    preloadData: method("preloadData"),
    invalidate: method("invalidate"),
    invalidateAll: method("invalidateAll"),
    refreshAll: method("refreshAll"),
  };
}

export function getNavigationState(): ApplicationState {
  const resolve = getContext<(() => ApplicationState | undefined) | undefined>(
    navigationStateContextKey,
  );
  const state = resolve?.();
  if (!state)
    throw new Error(
      "Navigation state is unavailable outside a Velveteen client",
    );
  return state;
}

function registerHook<Stage extends keyof NavigationHooks>(
  stage: Stage,
  callback: NavigationHooks[Stage],
) {
  const state = getNavigationState();
  onMount(() => state.registerNavigationHook?.(stage, callback));
}

/** Observe a navigation attempt and optionally cancel it. */
export const beforeNavigate = (callback: NavigationHooks["before"]) =>
  registerHook("before", callback);

/** Run before rendering and optionally return a callback for after commit. */
export const onNavigate = (callback: NavigationHooks["on"]) =>
  registerHook("on", callback);

/** Observe committed navigation once the view has updated. */
export const afterNavigate = (callback: NavigationHooks["after"]) =>
  registerHook("after", callback);

/** Capture and restore serializable component state across history entries. */
export function snapshot<Value>(registration: SnapshotRegistration<Value>) {
  const state = getNavigationState();
  onMount(() => state.registerSnapshot?.(registration));
}

export type { ApplicationState } from "../data/contract.ts";
