import type { RemoteDefinitions } from "../remote/server.ts";
import type { RemoteForms } from "../remote/forms.ts";
import type { Component } from "svelte";
import type { ProductionGeneration } from "../build/manifest-types.ts";
import type { RouteParameterValue } from "../routing/manifest-types.ts";
import type {
  Data,
  Fetch,
  PublicError,
  RootProps,
  RuntimeRegistry,
  UniversalLoadEvent,
} from "../data/contract.ts";
import type { RequestTraceSpan } from "./tracing.ts";

declare global {
  /** Application declarations can add fields to the request-local record. */
  interface VelveteenLocals {
    [key: string]: unknown;
  }
}

export type CookieOptions = {
  path: string;
  domain?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
  partitioned?: boolean;
};
type Cookies = {
  get(name: string): string | undefined;
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options: CookieOptions): void;
  delete(name: string, options: CookieOptions): void;
};
export type RequestEvent = {
  request: Request;
  url: URL;
  params: Record<string, RouteParameterValue>;
  route: { id: string | null };
  locals: Partial<VelveteenLocals>;
  cookies: Cookies;
  platform: unknown;
  fetch: Fetch;
  setHeaders(this: void, headers: Record<string, string>): void;
  getClientAddress(): string;
  signal: AbortSignal;
};
export type ServerLoadEvent = RequestEvent &
  Pick<UniversalLoadEvent, "parent" | "depends" | "untrack">;
type ServerLoad = (
  event: ServerLoadEvent,
) => Data | void | Promise<Data | void>;
export type ServerModule = { load?: ServerLoad; ssr?: boolean; csr?: boolean };
export type ServerHooks = {
  init?(): void | Promise<void>;
  handle?(input: {
    event: RequestEvent;
    resolve: (event?: RequestEvent) => Promise<Response>;
  }): Response | Promise<Response>;
  handleFetch?(input: {
    event: RequestEvent;
    request: Request;
    fetch: Fetch;
  }): Response | Promise<Response>;
  handleError?(input: {
    event: RequestEvent;
    error: unknown;
    status: number;
    message: string;
  }): PublicError | void | Promise<PublicError | void>;
  reroute?(input: {
    url: URL;
    fetch: Fetch;
  }): string | void | Promise<string | void>;
};
export type ServerRegistry = RuntimeRegistry & {
  Root: Component<RootProps>;
  render(
    component: Component<RootProps>,
    options: { props: RootProps },
  ): { body: string; head: string };
};
export type FetchHandler = (request: Request) => Response | Promise<Response>;
/** A host-owned source for the public assets named in a production manifest. */
export type AssetSource = {
  get(
    url: URL,
    request: Request,
  ): Response | undefined | Promise<Response | undefined>;
};
/** A host binding that can serve a Request, such as a Workers ASSETS binding. */
export type AssetFetcher = {
  fetch(request: Request): Response | Promise<Response>;
};
export type FetchService =
  FetchHandler | { fetch: FetchHandler; close?: () => void | Promise<void> };
/** One service with an application-relative mount and exact public root paths. */
export type FetchServiceGroup = {
  rootPaths: (this: void, basePath: string) => readonly string[];
  /** Exact public paths for cookie-free, originless machine form POSTs. */
  machineFormPaths?: (this: void, basePath: string) => readonly string[];
  start: (this: void, basePath: string) => FetchService | Promise<FetchService>;
};
export type ApplicationOptions = {
  mounts?: Readonly<
    Record<
      string,
      (() => FetchService | Promise<FetchService>) | FetchServiceGroup
    >
  >;
  prerendering?: boolean;
  remotes?: RemoteDefinitions;
  remoteForms?: RemoteForms;
  generation: ProductionGeneration;
  registry?: ServerRegistry;
  assets?: AssetSource;
  hooks?: ServerHooks;
  template?: string;
  platform?: unknown;
  getClientAddress?: (request: Request) => string;
  filterSerializedResponseHeaders?: (name: string, value: string) => boolean;
  onTrace?: (span: RequestTraceSpan) => void;
};
