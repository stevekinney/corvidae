import type { ApplicationState, ResolvedPage } from "../data/contract.ts";
/** Component constructors, promises and rich values retain their identity; only page replacement is reactive. */
export function createState(
  page: ResolvedPage,
  onError?: ApplicationState["onError"],
  pageKey?: string,
): ApplicationState {
  let current = $state.raw(page);
  let currentPageKey = $state(pageKey);
  let currentShallow = $state.raw<ApplicationState["shallow"]>();
  let currentState = $state.raw<Record<string, unknown>>({});
  return {
    get page() {
      return current;
    },
    set page(value) {
      current = value;
    },
    get pageKey() {
      return currentPageKey;
    },
    set pageKey(value) {
      currentPageKey = value;
    },
    get shallow() {
      return currentShallow;
    },
    set shallow(value) {
      currentShallow = value;
    },
    get state() {
      return currentState;
    },
    set state(value) {
      currentState = value;
    },
    onError,
  };
}
