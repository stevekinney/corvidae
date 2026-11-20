import type { Component } from "svelte";
import type { Transport } from "./custom-transport.ts";
import type {
  ClientRouteEntry,
  ClientRouteManifest,
  RouteMatchers,
  RouteParameterValue,
} from "../routing/manifest-types.ts";

export const dataMediaType = "application/x-velveteen-data";
export const dataElementId = "velveteen-data";
export type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
export type Data = Record<string, unknown>;
export type LoadRole = "layout" | "page";
export type ComponentRole = LoadRole | "error";
export type PublicError = { message: string; [key: string]: unknown };
export type Uses = {
  params: string[];
  search: string[];
  url: string[];
  dependencies: string[];
  parent: boolean;
  route: boolean;
};
export type LoadNode = {
  key: string;
  node: number;
  role: LoadRole;
  data: Data;
  uses: Uses;
  skip?: boolean;
};
export type Branch = { node: number | null; role: ComponentRole };
export type FetchRecord = {
  key: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
};
/** The same initial payload travels in document HTML and navigation data responses. Only server load results cross the wire. */
export type PagePayload = {
  version: 1;
  url: string;
  basePath: string;
  stylesheets: string[];
  routeId: string | null;
  params: Record<string, RouteParameterValue>;
  status: number;
  error: PublicError | null;
  redirect?: string;
  form?: Data | null;
  prerendered?: true;
  options: { ssr: boolean; csr: boolean };
  nodes: LoadNode[];
  branch: Branch[];
  fetched: FetchRecord[];
};
export type UniversalLoadEvent = {
  url: URL;
  params: Record<string, RouteParameterValue>;
  route: { id: string | null };
  data: Data;
  fetch: Fetch;
  parent: () => Promise<Data>;
  depends: (...dependencies: string[]) => void;
  untrack: <Value>(operation: () => Value) => Value;
  setHeaders: (headers: Record<string, string>) => void;
  signal: AbortSignal;
};
export type UniversalLoad = (
  event: UniversalLoadEvent,
) => Data | void | Promise<Data | void>;
export type LoadModule = { load?: UniversalLoad; ssr?: boolean; csr?: boolean };
export type ComponentModule = { default: Component<Record<string, unknown>> };
export type RuntimeNode = {
  page?: () => Promise<ComponentModule>;
  layout?: () => Promise<ComponentModule>;
  error?: () => Promise<ComponentModule>;
  pageUniversal?: () => Promise<LoadModule>;
  layoutUniversal?: () => Promise<LoadModule>;
  pageServer?: () => Promise<Record<string, unknown>>;
  layoutServer?: () => Promise<Record<string, unknown>>;
  endpoint?: () => Promise<Record<string, unknown>>;
};
export type RuntimeRegistry = {
  transport?: Transport;
  matchers?: RouteMatchers;
  nodes: RuntimeNode[];
  manifest: ClientRouteManifest;
};
export type RenderNode = Branch & {
  component?: Component<Record<string, unknown>>;
  data: Data;
};
export type UniversalResult = { key: string; data: Data; uses: Uses };
export type NavigationEvent = {
  from: URL;
  to: URL;
  type: "enter" | "goto" | "popstate" | "link";
  shallow: boolean;
  params: Record<string, RouteParameterValue> | null;
  routeId: string | null;
};
export type NavigationHooks = {
  before: (event: NavigationEvent & { cancel(): void }) => void;
  on: (
    event: NavigationEvent,
  ) => void | (() => void) | Promise<void | (() => void)>;
  after: (event: NavigationEvent) => void;
};
export type SnapshotRegistration<Value> = {
  id: string;
  capture: () => Value;
  restore: (value: Value) => void;
};
export type NavigationProtocol = {
  enhance(form: HTMLFormElement): { destroy(): void };
  goto(
    url: string | URL,
    options?: {
      replace?: boolean;
      invalidateAll?: boolean;
      noScroll?: boolean;
      keepFocus?: boolean;
      /** Retain the view across replacement; requires pageKey and the same rendered branch. */
      keepView?: boolean;
      /** Update the URL and history state without replacing the rendered branch. */
      shallow?: boolean;
      /** State associated with the history entry. */
      state?: Record<string, unknown>;
    },
  ): Promise<void>;
  preloadCode(routeId: string): Promise<void>;
  preloadData(url: string | URL): Promise<PagePayload | null>;
  invalidate(url: string | string[] | ((url: URL) => boolean)): Promise<void>;
  invalidateAll(): Promise<void>;
  refreshAll(): Promise<void>;
};
export type ResolvedPage = {
  payload: PagePayload;
  branch: RenderNode[];
  loads: UniversalResult[];
};
export type ApplicationState = {
  page: ResolvedPage;
  /** The identity used to recreate only the leaf page component. */
  pageKey?: string;
  /** The URL and route that a shallow navigation targets, when active. */
  shallow?: {
    url: URL;
    params: Record<string, RouteParameterValue>;
    routeId: string | null;
  };
  state: Record<string, unknown>;
  onError?: (error: unknown, index: number) => void;
  navigation?: NavigationProtocol;
  registerNavigationHook?: <Stage extends keyof NavigationHooks>(
    stage: Stage,
    callback: NavigationHooks[Stage],
  ) => () => void;
  registerSnapshot?: <Value>(
    registration: SnapshotRegistration<Value>,
  ) => () => void;
};
export type RootProps = { state: ApplicationState };
export type Invalidation = string[] | ((url: URL) => boolean) | "all";
export type Route = ClientRouteEntry;
