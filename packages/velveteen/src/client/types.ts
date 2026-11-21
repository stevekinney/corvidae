import type {
  Invalidation,
  ResolvedPage,
  ApplicationState,
  Fetch,
  NavigationEvent,
  NavigationHooks,
  NavigationProtocol,
  PagePayload,
  RuntimeRegistry,
} from "../data/contract.ts";
import type { Component } from "svelte";
import type { HistoryEntry } from "./history.ts";

export type ClientRegistry = RuntimeRegistry & {
  Root: Component<{ state: ApplicationState }>;
};
export type ClientOptions = {
  target?: Element;
  initial?: PagePayload;
  fetch?: Fetch;
  ssr?: boolean;
  csr?: boolean;
  /** Opt-in leaf identity; use a resource key to retain query-only updates. */
  pageKey?: (payload: PagePayload) => string;
  beforeNavigate?: NavigationHooks["before"];
  afterNavigate?: (
    navigation: NavigationEvent & {
      type: "goto" | "popstate" | "link";
    },
  ) => void;
  onError?: (error: unknown, index: number) => void;
};
export type ClientApplication = NavigationProtocol & {
  state: ApplicationState;
  dispose(): Promise<void>;
};

export type NavigationOptions = NonNullable<
  Parameters<NavigationProtocol["goto"]>[1]
> & {
  type?: "goto" | "popstate" | "link";
  pop?: HistoryEntry;
  refresh?: boolean;
  invalidation?: Invalidation;
  submission?: RequestInit;
};
export type Prepared = {
  payload: PagePayload;
  resolved?: ResolvedPage;
  controller: AbortController;
  done: Promise<void>;
};
